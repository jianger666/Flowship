# DESIGN：关键设计决策与权衡

> 这份文档解释**为什么这么做**——不写就忘的细节、给后续维护和扩展用。
>
> ⚠️ **2026-05-15 V0.4 同步**：plan 模式 phase 模型已大幅收敛、保活机制改造、引入多角色 schema。新写代码前对齐到当前实际、不要被本文档下面 V0.2 时期的描述误导。
>
> **当前 phase 模型（V0.3.4 起）**：`plan → build`（2 phase、不是早期 4 phase）
>
> - V0.1：plan 模式产 plan.md、用户读完后手工 build；chat 模式自由对话
> - V0.2：升级到 4 phase（context → plan → build → ship）、单 SDK Run 跑完全程
> - V0.3.3：砍 ship phase（提 PR + 同步飞书状态效果不稳、改为用户手工）
> - **V0.3.4（当前 phase 拓扑）**：context 合并进 plan（实操中分离价值未兑现、用户审 context 跟审 plan 判断点重合）→ 现在是 `plan → build`
> - **V0.3.5（保活机制重写）**：MCP `wait_for_user` 立刻返回 shell 引导、agent 调 `shell` 工具 curl 一条长 HTTP 连接到 `/api/tasks/:id/wait-ack`、用户 ack 时 resolve → 写一行结果 → 关流 → agent 推进。**不**走 `keep_alive_a/b/c` 那套（已删）。**ask_user race fix**：60s grace 期、修了「ack 信号比工具返回还快」的丢消息问题。
> - **V0.4（多角色 schema）**：`Task.role: TaskRole`（当前只有 `"fe"`、未来扩 `be / data / mobile / qa`）、agent prompt 按 `{{role}}` 调整视角、同一 story 跨角色多 task 并行（详见 [MULTI-ROLE.md](./MULTI-ROLE.md)）。
>
> **本文档下游各节的有效性**：
>
> - 第 1 节「为什么用 Cursor SDK」——依然有效
> - 第 2 节「单 agent vs 每 phase 独立 agent」——依然有效、当前 plan/chat 都走单 agent 长 Run
> - 第 6 节「Prompt 文件化」——**节内描述还是 4 phase**、当前是 2 phase（plan + build）、文件名见 `prompts/phase-{1,2}-*.md`
> - 第 14 / 15 节是 V1 三步流程（spec → plan → build）的设计推导、**保留作历史参考**
> - 第 16 节「Chat 模式架构」——基本有效、但 keep-alive 机制已改成 V0.3.5 shell + curl long-poll
> - 第 17 节「V0.2 Workflow 架构」——**节标题写 4 phase、实际当前 2 phase**、其余原则有效
> - 详见 `HANDOFF.md` 「V0.3.4 / V0.3.5 演进」段（最新）

---

## 1. 为什么用 Cursor SDK、不直接调 OpenAI / Anthropic？

| 选项 | 优势 | 劣势 |
|---|---|---|
| Cursor SDK ✅ | 复用 `.cursor/rules`、`.cursor/skills`、`.cursor/hooks.json` 整套生态；和用户日常 IDE 体验一致；composer-2 快且便宜 | 闭源、API 还在 Beta、未来可能破坏性升级 |
| Anthropic SDK | 模型最强（claude-sonnet-4.x 系列） | 每个仓库的规则要重写 prompt 注入；token 贵 |
| OpenAI SDK | 通用 | 同上 |
| LiteLLM 路由 | 多厂商灵活 | 不必要的复杂度 |

**结论**：用户日常已经在 Cursor、把 IDE 里的规则套用到自动化、零迁移成本。Beta API 升级风险接受。

---

## 2. agent 数量怎么选：可单可多、phase 之间走文件 hand-off

### 项目本质是 workflow、不是 multi-agent

spec → plan → build 是 phase chain、每段产物落盘、下一段读上一段产物作为输入。这就是 Anthropic *Building Effective Agents* 描述的「Prompt Chaining」+「Orchestrator-Workers」混合模式。

### 两种合法的 agent 实现路径（按场景选）

| 实现 | 优势 | 代价 | 适合场景 |
|---|---|---|---|
| **单 agent 全程**（一个 SDKAgent 跑到底） | 会话天然带连贯上下文、agent 知道前面做过什么；少一次 prompt 注入；token 略省 | 长任务 context window 会爆；不能给不同 phase 用不同模型 | 小到中等需求、走通流程优先 |
| **每 phase 独立 agent**（每段起新 SDKAgent、读文件作输入） | 隔离 context、避免长会话失控；每 phase 可独立换模型 / 改 prompt；失败重跑成本低 | 多次 prompt 注入；hand-off 要严格按 schema | 大需求、长时间任务、想给 build 用更强模型 |

二者本项目都要支持、UI 上让用户在新建任务时切换。具体怎么暴露这个 toggle、留给 W2 主流程设计时定。

### Cognition *Don't Build Multi-Agents* 警告什么、不警告什么

| Cognition 反对 | 本项目 |
|---|---|
| 多 agent 同时跑、互相谈判（如 PM 和 Dev 互相砍需求） | 否、phase 串行 |
| 隐式 hand-off（agent A 把状态留在记忆里、agent B 自动读） | 否、走 markdown 文件 + 明确 schema |
| 共享记忆 / 共享会话池在多 agent 间分裂 | 否、每个 phase 的 agent 自带独立会话 |
| 「workflow 里多个 agent 节点」 | **没反对**——这是 Anthropic 推荐范式 |

> 业界容易把所有「多 agent」混为一谈、其实 Cognition 警告的是**「真·multi-agent 协作」**那种、不是 phase chain。本项目走的是后者、引用 Cognition 时要分清。

### Cognition 列的 4 大失败模式我们怎么规避

1. **上下文断裂**：phase 间 hand-off 走 markdown 文件 + 严格 schema、不靠隐式记忆
2. **错误放大**：每 phase 之间强制 HITL ack、用户能修 spec.md 后再进 plan
3. **debug 灾难**：每 phase 产物落盘 + jsonl 日志、定位到具体 phase 不需要看 agent 内部
4. **共识盲点**：不做 AI 自审 review bot、关键决策走 HITL

### 工程注意

- 单 agent 长会话有 context window 上限——`composer-2` 当前 200k 够支撑 spec → plan → build 三段、但大 swagger / 大 PRD 时要切「每 phase 独立 agent」
- 不论单/多 agent、phase 之间的产物落盘是**绝对底线**——没有这个、debug 和重跑都没法做

---

## 3. 为什么 HITL 是底线、不追求全自动？

### 业界生产案例

| 产品 | 自动化程度 | HITL 设计 |
|---|---|---|
| **Devin**（Cognition） | 号称全自动 | 上线后口碑崩、SWE-Bench 实测 13% 完成率、多次翻车 |
| **GitHub Copilot Workspace** | 半自动 | 4 个 checkpoint、每步让人确认 |
| **Cursor Cloud Agent** | 半自动 | draft PR、必须人 approve |
| **Aider architect mode** | 单次任务 | architect plan + editor execute、plan 阶段强制让你看 |
| **Replit Agent** | 半自动 | 每 milestone 让你点 continue |

**结论**：所有真投生产的产品、**没一个全自动**——全自动是 demo 视觉、不是产品形态。

### HITL 在本项目的体现

- 每个 phase 跑完、UI 显示产物、用户决定是否进下一阶段
- 不自动串联 spec → plan → build
- 失败时不自动重试、用户决定怎么办

---

## 4. 为什么文件系统存储、不上数据库？

### 决策矩阵

| 选项 | 优 | 劣 | 决策 |
|---|---|---|---|
| 文件系统 ✅ | 零依赖、易调试、git diff 看产物、人能 cat / 编辑器开 | 多用户 / 大量任务时性能差 | V1 用 |
| SQLite | 单文件、零运维、SQL 查询 | 多了一层抽象 | V2+ 看情况切换 |
| Postgres | 团队级 | 重 | 上线给团队用时再说 |

### 实际落地（V0.2）

```
data/tasks/<taskId>/
  meta.json                   ← 任务元信息（覆盖写、读多写少）
  events.jsonl                ← 事件流（追加写、高频、含 thinking/tool_call/assistant_message/phase_ack/...）
  artifacts/
    01-context.md             ← Phase 1 产出（上下文收集）
    02-plan.md                ← Phase 2 产出（方案规划）
    03-build.md               ← Phase 3 产出（编码实现日志）
    04-ship.md                ← Phase 4 产出（PR + 飞书同步报告）
```

**V0.1 兼容**：`task-fs.readArtifact` 先找 V0.2 路径（`artifacts/<NN>-<phase>.md`）、找不到 fallback V0.1 路径（`<phase>.md`）、老任务仍可读。

**接口收敛在 `src/lib/server/task-fs.ts`**——切 SQLite 时改这一个文件就行、其他地方都靠 `Task` 类型。

---

## 5. 为什么 localStorage 存 API key、不存 server-side .env？

### 安全考量

- API key 是**用户级**敏感信息、不该让 server 拿到
- localStorage 仅在浏览器、不上传
- 每个用户自配自的、不会互相用

### 工程实现（当前）

- 客户端组件读 localStorage、通过 POST body 把 `apiKey` 传给 API route（如 `/api/models`）
- API route 立即用、用完不存
- 不打日志带 API key（未来重建 `appendLog` 时也要注意）

> 老版本说"用 fetch header `x-cursor-api-key` 传"——clean slate 后改成 POST body 字段、避免和 SDK 自带 header 名冲突。

### 代价

- 用户换设备 / 清浏览器数据要重配
- 没有团队共享 key 的能力——但这是有意为之、防滥用

---

## 6. Prompt 文件化的设计（V0.2 4 phase）

```
prompts/
  phase-1-context.md    ← 用户能直接编辑、本 phase 收集飞书 story + 仓库现状
  phase-2-plan.md       ← 方案规划、产出 task 清单
  phase-3-build.md      ← 真正写代码、跑 lint / typecheck / build
  phase-4-ship.md       ← 提 PR + 飞书评论回写
     │
     │ runPlanWorkflow 启动时
     │ buildSuperPrompt() 把 4 个 phase prompt 一次性串成 super-prompt
     │ {{taskId}} / {{repoPath}} / {{feishuStoryUrl}} / {{artifactPath}} / {{prevArtifactPath}} / ... 占位符替换
     ▼
  agent.send(superPrompt)  ← 一次 SDK Run 跑完全程
```

**为什么一次性塞所有 phase prompt**：

- 整段任务是一次 SDK Run、agent 上下文全程共享、phase 切换不重启 agent
- 提前让 agent 看到所有 phase 蓝图、自己心里有数（提高规划一致性、Phase 1 写 context 时就知道 Phase 2 要拆 task）
- 单 prompt 体积 ~12KB（4 phase × ~2KB + skills index + 通用约定）、远低于 200K context 上限

**占位符约定**：

| 占位符 | 含义 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|---|
| `{{taskId}}` | 任务 id（固定） | ✓ | ✓ | ✓ | ✓ |
| `{{repoPath}}` | 用户业务仓库绝对路径（agent cwd） | ✓ | ✓ | ✓ | ✓ |
| `{{feishuStoryUrl}}` | 飞书 story 链接 | ✓ | ✓ | | ✓ |
| `{{artifactPath}}` | 本 phase artifact 的绝对路径（写入用） | ✓ | ✓ | ✓ | ✓ |
| `{{prevArtifactPath}}` | 上一 phase artifact 的绝对路径（读取用） | （未提供） | ✓ | ✓ | ✓ |
| `{{contextArtifactPath}}` | Phase 1 artifact 的绝对路径（读取用） | （未提供） | （未提供） | ✓ | ✓ |

**为什么强调「绝对路径」**：

- agent 的 `cwd` 是用户业务仓库（`{{repoPath}}`）、不是 fe-ai-flow 项目根
- artifact 文件在 fe-ai-flow 项目下的 `data/tasks/<id>/artifacts/`
- 如果模板里写「写 `artifacts/01-context.md`」、agent 会写到用户仓库下、走丢
- 现在改成「写 `/Users/.../fe-ai-flow/data/tasks/.../artifacts/01-context.md`」、agent 必然写对

**好处**：

- 用户改完 prompt 保存、下次跑就生效（不用重启 dev、Next.js 不缓存）
- diff 友好（git 看 prompt 演化）
- 模板 / 正文分离（变量在代码 `plan-runner.ts:loadPhasePrompt`、措辞在 markdown）

**约束**：

- 模板里**不要硬编码业务变量**——所有可变值走占位符、由 `fillTemplate` 替换
- 改 prompt 时不要破坏 artifact 输出 schema（frontmatter `phase` / `status` / `upstream` / `downstream` 字段、被前端 artifact-panel 解析）

### 例外：chat 模式 prompt 暂时写在代码里

`chat-runner.ts:buildInitialPrompt` 没外提到 `prompts/`、原因：

1. chat prompt 含「反 anti-loop 反思指令」「KEEPALIVE 协议说明」「task_id 字符串注入」这些**和代码逻辑强耦合**的部分、外提到 markdown 不够稳
2. chat prompt 还在频繁迭代（每次踩到 anti-loop 坑就改）、外提反而拖慢迭代

**V0.2 现实**：plan 模式的 super-prompt 反 anti-loop 段落已经搬了 chat-runner 那套（实测 composer-2 在多次 wait_for_user keepalive 后会自己 stop run、不加这段必踩坑）。chat 仍在代码里、plan 在 super-prompt 拼接逻辑里。

**升级路径**：等两边都稳定（连续 2 周不踩 anti-loop 坑）→ 抽出 `prompts/_shared/anti-loop.md` 当 partial、被 chat-init 和 plan super-prompt 同时引用。

---

## 7. SSE 而非 WebSocket

### 为什么 SSE？

- 单向推送（server → client）、本项目场景刚好够
- 浏览器原生 EventSource（虽然这里手写读 ReadableStream）
- 和 Next.js API route 配合简单、无需额外服务
- 重连机制内置

### 为什么不 WebSocket？

- WebSocket 双向能力本项目用不上
- 需要额外维护连接状态
- 和 Next.js serverless 部署不兼容（如果将来要部署）

### 实现细节

```ts
// API route 返回 ReadableStream
new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  },
});

// Client 用 ReadableStream reader（不用 EventSource、因为要传 header）
const reader = res.body.getReader();
```

不用 EventSource 是因为它不支持自定义 header、API key 没法传。

---

## 8. 为什么不上 LangGraph / LangChain？

考虑过、否决：

- **LangGraph**：状态机抽象、本项目当前 phase 间是直线、没必要
- **LangChain**：抽象层叠太多、调试痛苦、不可控
- **Mastra / CrewAI**：定位「真·multi-agent 协作」（角色谈判、共享记忆）、和本项目「workflow + 多 agent 节点、文件 hand-off」哲学不同；本项目目前用 `@cursor/sdk` 直接管 agent 即可、没必要套这层框架

**结论**：保持简单——`@cursor/sdk` + `fs` + Next.js、足够。等真有复杂状态机需求再说。

---

## 9. UI 框架的选型（已修正）

> ⚠️ **原决策已推翻**：早期写"shadcn/ui 砍了、依赖一堆 Radix 组件"——clean slate 后采用 shadcn/ui 的 `base-nova` 风格、底层是 `@base-ui/react`（**不是 Radix**）、依赖更轻、和 Tailwind 4 配合好。

### 当前选择

| 选项 | 决策 |
|---|---|
| Tailwind 4 ✅ | CSS-first config、`globals.css` 走 oklch 变量；`tailwind.config.ts` 已删 |
| shadcn/ui (base-nova) ✅ | 原子件放 `src/components/ui/`、业务组件放 `src/components/` |
| Ant Design | 砍了、风格和本项目"工具"调性不符 |
| 纯 CSS | 砍了、不利于快速迭代 |

### 几个使用上的坑

- shadcn/ui 的 base-nova 用 `@base-ui/react`、polymorphic 组件用 `render={<Link/>}`、**不是 `asChild`**
- `Select` 的 `onValueChange` 类型是 `string | null`、回调里要 `v &&` 守卫、否则 typecheck 不过
- 主题：`next-themes` + `forcedTheme="dark"` + `enableSystem={false}`、`<html className="dark" suppressHydrationWarning>`、不让用户切

### 交互细节

- `globals.css` 加了 base 层规则：`button` / `[role=button]` / `a` 都有 `cursor: pointer`、disabled 状态 `cursor: not-allowed`

---

## 10. TypeScript 严格模式

`tsconfig.json` 开了 `"strict": true`——本项目零容忍 `any` 和 implicit return。

**为什么**：用户对低级错误零容忍、tsc 是第一道防线。

---

## 11. 函数声明风格：一律箭头函数

clean slate 后强制规约（已落 `.cursor/rules/learned-conventions.mdc`）：

- 模块顶层函数 / React 组件 / 工具函数 / API route handler——**全部用箭头函数**
- `const Foo = () => {...}` 而不是 `function Foo() {...}`
- 第三方 / 框架要求 `function` 的（如 Next.js 某些约定）保留

**为什么**：风格统一、避免 hoisting 带来的隐式依赖、和 React 函数组件常见写法一致。

---

## 12. 路径选择走原生文件夹选择器

`/api/fs/pick-folder` 用 macOS 的 `osascript` 弹原生 dialog、把绝对路径返给前端、用 `path.basename` 自动填仓库名。

**为什么不让用户手填**：浏览器 `<input type="file" webkitdirectory>` 拿不到绝对路径、agent `cwd` 必须绝对路径。

**限制 / 升级路径**：

- 仅 macOS（依赖 `osascript`）、其他系统返 501
- 未来要远程部署 → 要换成 server 端目录浏览器（让用户在 web UI 里浏览 server 文件系统）

---

## 13. Harness 真正在解决的 4 件事（不只是"代码质量"）

很多人把"加 harness"理解为"让 AI 写出更好的代码"——只对一半。把不可控的 LLM 黑盒变成**可预期、可调试的工程系统**才是 harness 的核心命题。具体落到 4 件事：

| 目的 | 含义 | 不上的下场 |
|---|---|---|
| **正确性** | 输出能用、不出 bug | 交出去的活不能看 |
| **可控性** | 不该改的别改、不该花的别花、不该删的别删 | 仓库被乱改 + agent 跑 8h 烧 \$50 |
| **可观测性** | 出问题能定位到哪一步、哪个 prompt、哪个工具调用 | bug 复现靠吊祥子 |
| **可恢复性** | 错了能回滚、能从断点续跑、不用从头跑 | 用户中途取消后只能重头跑 |

业界（Anthropic / Cognition）反复说的"reliability gap"指的就是这 4 件事——LLM 裸跑能跑出 demo、但跑不出 production 级可靠的工作流、缺的就是这 4 件。

### 7 个缰绳维度 → 4 件事的映射

| 缰绳 | 正确性 | 可控性 | 可观测性 | 可恢复性 |
|---|---|---|---|---|
| 输入产物（schema / 上游文件） | ✓ | ✓ | | |
| 工具白名单 | | ✓✓ | | |
| 输出产物 schema（含 frontmatter） | ✓ | | ✓ | |
| HITL 闸门（feedback 风格） | | ✓✓ | | ✓ |
| 自验证（eslint / typecheck / prompt review） | ✓✓ | | | |
| 失败回滚（git reset / 上一步重跑） | | | | ✓✓ |
| 事件日志（jsonl） | | | ✓✓ | ✓ |

**核心原则**：能用确定性工具兜的、就不让 LLM 自己判断。LLM 是"会编不会算"的小孩、要靠工具型确定性约束才能拿出生产可靠性。

---

## 14. V1 三步流程的工具白名单（按 phase 拉清单）

> ⚠️ **V0.2 后这节是历史参考**——V0.2 实际跑的是「context → plan → build → ship」4 phase（见第 17 节）、本节保留作设计思路的推导记录。三类工具（输入 / 约束 / 校验）的分类仍然适用、只是落到 V0.2 时按新 phase 重映射。

V1 = `spec → [feedback] → plan → [feedback] → build → [feedback] → 完`。每步可用的工具按"作用机制"分 3 类：

| 类 | 作用 | 例子 |
|---|---|---|
| **输入类** | 给 AI 喂正确信息 | 飞书 MCP / Figma / Swagger / Context7 / 仓库只读 |
| **约束类** | 给 AI 划红线 | 工具白名单 / file allowlist / token 上限 / write-disabled |
| **校验类** | 给 AI 输出打分 | eslint / typecheck / JSON Schema / prompt self-review |

### Step 1: Spec（澄清需求）

| 工具 | 类 | V1 |
|---|---|---|
| 飞书 wiki / 需求文档 MCP | 输入 | 接 |
| Swagger / OpenAPI 解析 | 输入 | 接 |
| 仓库只读 grep / ls | 输入 | 接（避免重复造轮子） |
| Context7 MCP（第三方库文档） | 输入 | 选接 |
| 禁止写文件（write-disabled） | 约束 | **必接** |
| spec.md JSON Schema 校验必填字段 | 校验 | **必接** |
| LLM self-review prompt（5 项清单打勾） | 校验 | 接 |
| 项目 Cursor rule（spec 要包含...） | 约束 | 接 |
| Figma MCP | 输入 | **B 端不接**、C 端再说 |

**B 端阶段一定位**：从公司文档「PRD + Figma + 埋点 Schema + Edge Case」改成「PRD + 接口契约（Swagger） + 数据模型 + Edge Case」。

### Step 2: Plan（拆任务）

| 工具 | 类 | V1 |
|---|---|---|
| 仓库只读（grep / ls / read） | 输入 | 接 |
| 类型定义读取（tsconfig path / d.ts） | 输入 | 接（read 即可、不动 ts ast） |
| Git log / blame（看相似改动史） | 输入 | 选接 |
| 禁止写文件 | 约束 | **必接** |
| plan.md JSON Schema（task list / file path / risk） | 校验 | **必接** |
| File path 存在性校验（task ref 的文件存不存在） | 校验 | **必接** |
| Task 依赖 cycle 检测 | 校验 | V1 跳（task 少不需要） |
| LLM self-review（task 全部能映射文件吗） | 校验 | 接 |

**B 端阶段二定位**：从公司文档「Figma + Token + Swagger + 埋点」改成「接口契约 + 数据模型」（权限矩阵 V1.x 待定、不强制塞）。

### Step 3: Build（写代码、重头戏）

| 工具 | 类 | V1 |
|---|---|---|
| Cursor SDK Background Agent | 输入 + 写 | 唯一选 |
| Git（每个 task 一个 commit） | 约束 + 回滚 | **必接** |
| File allowlist（只能改 plan ref 的文件） | 约束 | **必接** |
| eslint CLI（每次编辑后跑） | 校验 | **必接** |
| prettier（格式自动化） | 校验 | 接 |
| `pnpm typecheck` | 校验 | **必接** |
| Cursor rule 强制（编码规范） | 约束 | 接 |
| Skill（如「创建 shadcn 组件」可复用动作） | 输入 + 约束 | V1 选接 |
| Hook（post-edit 自动跑 typecheck） | 校验 | V2 接、V1 手走 |
| 浏览器截图（chrome-devtools / ide-browser） | 校验 | V2、UI 变动才需 |
| Typecheck 失败重试上限（超 N 次 feedback） | HITL | **必接** |
| 单 task token 上限 | 约束 | V2 补 |

### HITL 实现 = feedback 风格 blocking call

复用 cursor-feedback MCP 同型机制——AI 跑到关键点调 feedback 工具、阻塞等用户回复、回复后继续。本项目计费走老版（请求计费）、这种"一次会话跑到底"的形态正好不会被多次扣。

**触发点（粒度）**：
- 主要 = phase 边界（spec/plan/build 跑完各 1 次、共 3 次）
- 补充 = build 内部异常（typecheck 修不好 / 越出 plan / 高风险项）

正常一路绿、人最多被叫醒 4-5 次、不烦。

---

## 15. 与公司《前端 x Harness Engineering》文档的对齐

> ⚠️ **V0.2 现实**：plan 模式现在是 4 phase（context / plan / build / ship、详见第 17 节）、跟公司 5 阶段的映射略调整：
> - 公司「一、需求结构化」→ V0.2「context phase」（吸收事实、不出方案）
> - 公司「二、设计与定义」→ V0.2「plan phase」
> - 公司「三、AI Coding」→ V0.2「build phase」
> - 公司「四、质量保障与自测」→ V0.2「build phase 内自校」（lint / typecheck / build、Phase 3 必跑）
> - 公司「五、验收与交付」→ V0.2「ship phase」（提 PR + 飞书评论）
> - V0.2 实现了完整 5 阶段映射、不再像 V1 那样「砍 spec、build 待启动」
>
> 下文是 V1 决策的历史推导、保留作参考。

公司内部文档把流程拆成 5 阶段、本项目 V1 plan 模式落到 2 阶段（spec 砍掉）：

| 公司 5 阶段 | B 端去 Figma 后 | 本项目 V1（plan 模式） | 处理 |
|---|---|---|---|
| 一、需求结构化 | 同 | ❌ 已砍 | 实测 spec 价值低、并入 plan 处理 |
| 二、设计与定义 | 接口契约 + 数据模型（去 Figma + Token） | plan ✅ | B 端重定位为「数据/接口设计 + Task List」 |
| 三、AI Coding | 同 | build 🚧 | 待启动 |
| 四、质量保障与自测 | 去埋点强校验 | build 内部自验证 | ⚠ V1 塞进 build、V2 拆独立 phase |
| 五、验收与交付 | 去移动端性能 | 不做 | ⚠ V1 不做、V3+ 考虑 |

**为什么 V1 砍 spec**：实测下来 spec 写出来对开发参考价值有限（plan agent 自己进仓库 grep 一遍后产出的 Task List 已经够准）、反而拉长链路 + 多一次扣费。砍掉换成 plan→build 两段。

**chat 模式不在公司 5 阶段映射里**——chat 是「探索式咨询」形态、不是阶段化交付流程、跟 5 阶段是平行而非映射关系。

**为什么不接 wk-ai-rules**：wk-ai-rules 偏 C 端（落地页 / H5 / App 集成 / SEO 这些规范都是 C 端语境），本项目专注 B 端管理后台。**未来路径**：自己写一套 B 端 rules 库（仿 wk-ai-rules 形态、覆盖表单/表格/权限/接口类型这些 B 端高频模式）、build phase 把这套 rules 注入目标仓库的 `.cursor/rules/` 当 cursor rule 用。这套 B 端 rules 库归属 V2+。

---

## 16. Chat 模式架构（重要、写 chat 相关代码前必读）

> 2026-05-09 ~ 2026-05-11 拍板。Chat 模式是 plan→build 阶段化流程之外的**第二条主线**、形态上是单 SDK Run 长循环、跟 plan 模式共享基础设施但 runner / API 路由 / UI 完全独立。

### 16.1 为什么要 chat 模式（而不是只有 plan→build）

| 场景 | plan→build 适合？ | chat 适合？ |
|---|---|---|
| 明确需求 + 可拆 task list + 等开发执行 | ✅ | ❌ 太散 |
| 探索性问题（"这个 bug 是什么原因"） | ❌ phase 切分多余 | ✅ 一次跑到底 |
| 多轮咨询（用户边想边问） | ❌ HITL 在 phase 边界、不够细 | ✅ 每轮 wait_for_user |
| 一次扣费要榨干 | ❌ 每 phase 一次扣费 | ✅ 整段对话一次扣费 |

**结论**：两条路径互补、用户在新建任务时按场景选 mode。

### 16.2 核心机制：单 SDK Run + wait_for_user MCP 阻塞

```
chat 启动：
  POST /api/tasks/[id]/start-chat
    ├─ patchPhase taskStatus=running
    ├─ Agent.run(task.repoPath、{ mcpServers: { feAiFlowChat, ...userMcp }, model })
    └─ 立即返回 { task, already } —— fire-and-forget

chat agent 一轮（重复直到用户取消）：
  agent: assistant_message ("xxx 怎么样？")
  agent: tool_call wait_for_user(task_id="t_...")  ← 阻塞、不返回
       ├─ 50s 没用户消息 → resolve { kind: "keepalive", text: "[KEEPALIVE #N @hh:mm:ss] ..." }
       │   agent: 立刻再调 wait_for_user（被 prompt 教着）
       └─ 用户在前端 ChatView 输入 "xxx" → POST /api/tasks/[id]/chat-reply
           → resolve { kind: "user_reply", text: "xxx" }
           agent: 接着说一段、再调 wait_for_user

chat 订阅（多份并存、刷新页面续传）：
  GET /api/tasks/[id]/watch-chat
    ├─ 先 SSE replay events.jsonl 历史
    ├─ subscribeChatStream(taskId, listener) → 增量收 publish 出来的 event/task/done/error
    └─ 客户端 disconnect → unsubscribe + closeStream
```

### 16.3 为什么是本地 HTTP MCP（不是 stdio MCP）

| 选项 | 能不能跑 | 为什么 |
|---|---|---|
| **stdio MCP** ❌ | 跑不通 | Cursor SDK 的 local agent 是另开 process、跟 web server 不在一个进程；stdio MCP 需要 spawn 子进程拿 stdin/stdout、共享内存的 pendingMap **拿不到** |
| **本地 HTTP MCP** ✅ | 跑得通 | agent 子进程通过 localhost:8876/api/mcp/chat-tool 连回来、跨进程也能访问 web server 进程里的 pendingMap |
| 远程 HTTP MCP | 不必要 | 单机工具、所有东西都在本地 |

### 16.4 为什么 stateful transport（不是 stateless）

老版本曾用 stateless 的 `WebStandardStreamableHTTPServerTransport`、踩过坑：

- stateless 模式下、长 tool call 阻塞期间如果连接断了、再连进来会拿到新 transport、之前 pending 的 tool call 永远收不到 resolve
- 后来改成 stateful：`mcp-session-id` header + `sessionTransports: Map<sessionId, transport>`、`isInitializeRequest` 时新建 transport 并发 session-id 给 client、后续请求按 session-id 取回

**坑**：`sessionTransports` 必须挂 globalThis（见 16.6）、否则 `start-chat` 路由建的 transport 跟 `chat-tool` 路由收请求时拿不到的同一个 transport、调用直接挂。

### 16.5 50s keepalive + 反 anti-loop 双重压制（2026-05-10 ~ 2026-05-11 踩坑）

**坑 1：SDK 那侧 MCP client 60s tool 超时（-32001）**

`wait_for_user` 工具如果超过 60s 不返回、SDK 直接抛 -32001 "Request timeout"、整个 run 挂。

**解法**：工具内部跑 50s timer、到点 resolve 一个 `keepalive` 文本、prompt 里教 agent「看到 KEEPALIVE 就再调一次 `wait_for_user`」。形成「轮询」表象、但实际 agent 计费还是一个 Run。

**坑 2：composer-2 anti-loop 反思**

实测过 composer-2 在连续若干次 KEEPALIVE 后、自己的内置 reasoning 会判定「同一 tool 反复调用是 spam」、决定停止调 wait_for_user、主动结束 run。

**解法**（A + C 双重压制）：

- **A：keepalive 文本变体化**——`buildKeepaliveText` 给每条 keepalive 带：
  - 唯一 `#序号`（每个 task 单独计数器、挂 globalThis 避免 dev 重启重置）
  - `@hh:mm:ss` 时间戳
  - 4 种轮询的措辞变体（不让模型看到完全重复的字符串）
- **C：prompt 反反思指令**——`buildInitialPrompt` 明确教模型：
  1. `wait_for_user` 是同步原语（类似条件变量）、**不是普通工具**、正常运行下反复调用几百几千次是设计如此
  2. 内部 reasoning 提醒「调用太多、可能是 spam」时**完全忽略**、按本协议继续
  3. KEEPALIVE 期间**严禁**向用户广播保活事件、严禁解释 / 道歉 / 询问 / 主动 stop
  4. `task_id` 必须传字符串（不是 number、SDK MCP 协议要 string）

**为什么不只用 A 或只用 C**：单独 A 不够（变体次数多了模型还是会反思）；单独 C 不够（模型被很多重复输入冲淡 prompt 权重）。组合上才稳。

**为什么不直接关掉 keepalive**（用更长 timeout）：SDK 那侧 60s 超时是 client 端硬编码、绕不过。

### 16.6 globalThis 全局状态：next.js dev chunk 分裂解药

**问题**：next.js dev mode 下不同 route handler 会被打成不同 webpack chunk、`import` 同一个模块拿到的实际是**不同的 module 实例**。后果：

- `start-chat` 路由 import `chat-mcp.ts` → 拿到 instance A 的 `pendingMap`
- `chat-tool` 路由（agent 子进程访问的入口）import `chat-mcp.ts` → 拿到 instance B 的 `pendingMap`
- agent 调 wait_for_user 时往 instance B 写 pending 项、`chat-reply` 路由想从 instance A 读 → 永远找不到

**解药**：所有跨路由共享的状态都挂 `globalThis`：

```ts
// chat-mcp.ts
interface ChatMcpGlobalState {
  pendingMap: Map<string, PendingEntry>;
  sessionTransports: Map<string, Transport>;
  eventLoggers: Map<string, EventLogger>;
  waitingTasks: Set<string>;
  keepaliveCounters: Map<string, number>;
}
const getGlobalState = (): ChatMcpGlobalState => {
  const g = globalThis as unknown as Record<string, ChatMcpGlobalState>;
  if (!g.__feAiFlowChatState__) {
    g.__feAiFlowChatState__ = { pendingMap: new Map(), ... };
  }
  return g.__feAiFlowChatState__;
};

// chat-runner.ts
interface ChatRunnerGlobalState {
  runningChats: Map<string, RunningRecord>;
  subscribers: Map<string, Set<ChatStreamListener>>;
}
// 同款挂 globalThis.__feAiFlowChatRunnerState__
```

**注意**：dev hot reload 时 globalThis 不被 webpack 重置、能保住状态；但 `pnpm dev` 完全重启时 globalThis 被清——这种时候 agent 子进程也已经被杀、不会有泄漏问题、所以可接受。

### 16.7 启动 / 推送拆开（不要合并回去）

老版本曾把 `start-chat` 写成同时 spawn agent + SSE 流推回来——踩过坑：

- 用户**刷新页面**就断 SSE、断 SSE 就 cancel agent、agent run 整个挂掉
- 不能多 tab 同时看（第二个 tab 拿不到流）

**改成现在这样**：

- `POST /api/tasks/[id]/start-chat` —— **只**负责 spawn agent、立刻返回 { task, already }、agent 在后台跑
- `GET /api/tasks/[id]/watch-chat` —— **只**负责 SSE 订阅、可以多份并存、刷新页面建新订阅、agent 不知不觉

**好处**：

- 刷新页面不影响 agent
- 多 tab 看同一任务（同步显示）
- 任务列表页可以「轻量订阅」拿状态、详情页拿全量事件流（当前都拿全量、未来可能优化）

### 16.8 任务删除的 cleanup 顺序（容易漏）

`DELETE /api/tasks/[id]` 必须按这个顺序调、不然 globalThis 上的状态会泄漏：

```ts
await cancelChat(id);              // 1. 让 agent run 收 cancel 信号、退出 SDK Run
await cleanupChatTaskState(id);    // 2. 清 chat-mcp 全局状态：waitingTasks / keepaliveCounters / eventLoggers
await deleteTask(id);              // 3. 删文件系统的 data/tasks/<id>/
```

**漏了第 2 步的后果**：用户新建一个 id 撞上的任务（极小概率、但 dev 模式重启容易碰）会被旧 keepaliveCounters / waitingTasks 污染、行为诡异。

### 16.9 什么不做

- ❌ chat→plan 模式切换：要切就新建任务、节省状态机复杂度
- ❌ chat 多 agent 协作（PM / Dev / QA 谈判）：Cognition 反对的就是这种
- ❌ chat 自动总结落 markdown artifact：所有产出都进 events.jsonl、用户想"导出"再说
- ❌ token 级 delta 推送：events 粒度（thinking / tool_call / assistant_message）已够 UI 用
- ❌ chat 模式断点续跑：agent 挂了就 failed、需要用户手动「再聊一次」（completed 状态也支持、但会重启新 SDK Run、计费再算一次、UI 有提示）

---

## 17. V0.2 Workflow 架构（重要、写 plan 相关代码前必读）

> 2026-05-11 拍板。plan 模式从 V0.1 的「单 phase plan.md」演化成 4 phase workflow、一次 SDK Run 跑完全程。

### 17.1 为什么是 4 phase（不是 3、不是 2、不是 5）

公司内部 5 阶段「需求结构化 → 设计与定义 → AI Coding → 质量保障 → 验收交付」直接映射到本项目会过细。本项目目标是「飞书 story 到 PR 的端到端自动化」、按工程节奏 4 段拆：

| Phase | 角色 | 输入 | 输出 | 为什么独立 |
|---|---|---|---|---|
| **1. context** | 把飞书 story 抽成结构化事实 | story 链接 + 仓库现状 | `01-context.md`（PRD 内容 + 验收标准 + 仓库现状 + 不确定项） | 跟方案分开、事实和决策不混 |
| **2. plan** | 出技术方案 + 拆 task | `01-context.md` | `02-plan.md`（决策表 + 改动范围 + Task 拆分） | 在写代码前、用户必须看一眼方案再放行 |
| **3. build** | 真的写代码 + 跑校验 | `02-plan.md` + 仓库 | 代码改动 + `03-build.md`（实施日志 + lint/typecheck 结果） | 改代码是不可逆动作、必须独立 ack |
| **4. ship** | 提 PR + 同步飞书 | 仓库改动 + `03-build.md` | PR + 飞书评论 + `04-ship.md` | 推到 origin 也是不可逆、再 ack 一次 |

**为什么不留 spec phase**（V1 早期想过的）：跟 V1 决策一致——实测 spec 写出来对开发参考价值有限、context phase 直接吸收事实就够、不再走单独 spec。

**为什么不合并 plan / build 到一个 phase**：plan ack 给用户看方案、build ack 给用户看代码结果——拒绝点不同。合并就丢了「方案 ack 拒收 = 不写代码 = 没浪费 token」的窗口。

**为什么 ship 不并入 build**：build 是「改本地仓库文件」、ship 是「git push + 调 github/feishu MCP」、后者依赖网络 + 凭证、错误模式完全不同、独立 phase 让恢复路径清晰。

### 17.2 核心机制：单 SDK Run + wait_for_user V2

```
start-workflow：
  POST /api/tasks/[id]/start-workflow
    ├─ patchPhase taskStatus=running、currentPhase=context
    ├─ Agent.create(task.repoPath、{ mcpServers: { feAiFlowChat, ...userMcp }, model })
    ├─ buildSuperPrompt() 一次性拼出 4 phase 的完整指令书
    ├─ agent.send(superPrompt) → 拿到 run
    └─ fire-and-forget、立即返回 { task, already }

agent 跑一个 phase（重复 4 次）：
  agent: read_file / grep / 仓库扫描 / 飞书 MCP / ...
  agent: edit_file → 写 artifacts/<NN>-<phase>.md
  agent: tool_call wait_for_user(task_id, phase="context"|"plan"|"build"|"ship", artifact)
       ├─ 50s 没用户 ack → resolve { kind: "keepalive", text: "[KEEPALIVE #N @hh:mm:ss] ..." }
       │   agent: 立刻再调 wait_for_user（同 phase 同 artifact）
       ├─ 用户点「通过」→ POST /api/tasks/[id]/phase-ack { action: "approve" }
       │   → resolve { kind: "phase_ack", text: "[PHASE_ACK approve]" }
       │   agent: 进入下一 phase 的具体执行
       └─ 用户点「补意见再跑」→ POST /api/tasks/[id]/phase-ack { action: "revise", feedback: "..." }
           → resolve { kind: "phase_ack", text: "[PHASE_ACK revise] <feedback>" }
           agent: 按 feedback 改 artifact、再调 wait_for_user（同 phase）

watch（统一通道、plan / chat 共用）：
  GET /api/tasks/[id]/watch-chat
    ├─ 先 SSE replay events.jsonl
    ├─ subscribeChatStream(taskId)
    └─ 客户端 disconnect 不影响 agent
```

### 17.3 `wait_for_user` V2 语义升级（V1 → V2）

V1（chat 模式专用）：

```ts
wait_for_user({ task_id })
  → 阻塞、等用户下一条 chat 消息 → { kind: "user_reply", text: "..." }
```

V2（chat + workflow 兼容）：

```ts
// chat 模式不带 phase
wait_for_user({ task_id })
  → { kind: "user_reply" | "keepalive", text: "..." }

// workflow 模式带 phase + artifact
wait_for_user({ task_id, phase: "context"|"plan"|"build"|"ship", artifact: "artifacts/01-context.md" })
  → { kind: "phase_ack" | "keepalive", text: "[PHASE_ACK approve]" | "[PHASE_ACK revise] xxx" | "[KEEPALIVE ...]" }
```

**关键差异**：

| 维度 | V1 chat | V2 workflow |
|---|---|---|
| 等谁 | 用户下一条 chat 消息 | 用户对当前 phase 的 ack（approve / revise） |
| UI 触发 | EventStream 输入框发消息 | 顶部「通过 / 补意见再跑」按钮 |
| 返回内容 | 裸文本 | 字符串标记 `[PHASE_ACK approve]` / `[PHASE_ACK revise] <feedback>` |
| awaiting notifier | 只标 `taskStatus=awaiting_user` | 多标 `phases.<phase>.status=awaiting_ack` + 留 artifact 路径在 phase state |

**为什么用字符串标记而不是 JSON object**：MCP 工具返回值必须是 string、再说 agent 拿到字符串看到 `[PHASE_ACK approve]` 就能很快地按文本协议分支、不用解析嵌套 JSON。

### 17.4 super-prompt 一次性拼装（不是分次 send）

V0.2 起手不是「Phase 1 prompt 发出去、等 ack、再发 Phase 2 prompt」、而是「一次 super-prompt 把 4 phase 全告诉 agent、agent 自己跑完全程靠 wait_for_user 阻塞」。

**为什么不分次 send**：

| 方案 | 优 | 劣 |
|---|---|---|
| 分次 send（每 phase 一次 `agent.send`） | 每 phase prompt 独立、不互相干扰 | 每次 send 起一个新 Run、计费 ×4；上下文不连续（每 phase 重新建立 reasoning） |
| **单次 super-prompt（V0.2 选这个）** ✅ | 一次扣费跑全程；上下文 4 phase 连续、agent 在 Phase 1 就知道 Phase 2 要拆 task | super-prompt 体积大（但 ~12KB 远低于 context 上限）；4 phase 共享 reasoning、需要 prompt 教 agent「现在做哪个 phase」 |

**怎么教 agent「现在做哪个 phase」**：super-prompt 末尾明确写「现在开始执行 Phase 1。Phase 1 结束后调 wait_for_user(phase=context)、approve 后再做 Phase 2、依次类推」。agent 模型对这种 phase chain 的执行能力实测够用。

### 17.5 phase 状态机（task.status × phases.<id>.status）

```
task.status:
  draft → running → awaiting_user → running → ... → awaiting_user → completed
  任意态 → failed（agent run 异常）

phases.<id>.status:
  pending → running → awaiting_ack → ack
  awaiting_ack → awaiting_ack（revise 不重置、保持等待状态、agent 改完 artifact 再调 wait_for_user）
```

**关键规则**：

- agent 调 `wait_for_user(phase=X)` → notifier 设 `phases.X.status=awaiting_ack` + `task.status=awaiting_user`
- 用户 approve → `markPhaseAcked()` 设 `phases.X.status=ack` + `task.currentPhase=next` + `task.status=running`
- 用户 revise → 只写 `user_reply` 事件（meta.kind=revise）、**phase 状态不动**（仍 awaiting_ack）、agent 拿到 [PHASE_ACK revise] 后改 artifact 再调 wait_for_user
- agent run 异常退出（`status=error`）→ `task.status=failed`、错误事件提示「artifact 已产出、点重启 workflow 可继续」

**为什么 revise 不抖屏**：用户拍板的决定——revise 期间 phase 还在等 ack、只是 agent 在改 artifact、UI 持续显示「待确认」状态、不要切回 running。这样用户视觉上稳定、知道改完后还能再 ack 一次。

### 17.6 失败恢复：保留 artifact、重启 workflow

agent run 因为某种原因 errored（最常见：composer-2 看到太多 keepalive 自判 spam 退出）后：

1. plan-runner catch 块标 `task.status=failed`
2. 已写完的 artifact（如 `01-context.md`）保留在 `data/tasks/<id>/artifacts/` 不删
3. UI 显示「重启 workflow」按钮、点击 = 新 agent run 从 Phase 1 开始
4. 新 run 的 agent 写 `01-context.md` 时会先 read 到已有内容、大概率 in-place 更新而不是完全覆盖（取决于 prompt 教得好不好）

**为什么不做「从 Phase N 续跑」**：

- super-prompt 起手写「从 Phase 1 开始」、改成动态起手 phase 要重做 prompt 结构（复杂）
- Phase 1 是上下文收集、重跑成本最低、agent 不会浪费太多 token
- 实测：用户 prompt 强化反 anti-loop 后、Phase 1 完成率 > 90%、失败重启可接受

**升级路径**：等 Phase 1 失败率降到 0、再考虑「从 awaiting_ack 状态续跑」。

### 17.7 跟 chat 模式共享的基础设施

V0.2 plan 模式不重建一套底层、直接复用 chat 模式的：

| 设施 | 共享路径 |
|---|---|
| MCP server（HTTP/stateful、含 `wait_for_user` 工具） | `chat-mcp.ts`、V2 语义升级后 chat / workflow 共用 |
| publish / subscribe（SSE 流） | `chat-runner.ts:publishChatStreamEvent` / `subscribeChatStream`、`watch-chat` 路由放开 mode 校验后 plan 也走它 |
| 事件 JSONL 持久化 | `task-fs.ts:appendEvent`、所有 phase 事件按时序追加 |
| globalThis 全局状态（next.js dev chunk 分裂解药） | 见第 16.6 |

**为什么不拆两套**：拆两套有重复代码 / 状态机不一致 / SSE 链路重复维护。陪着 wait_for_user V2 升级、两套自然合并。

### 17.8 什么不做

- ❌ phase 自动进入下一 phase（无 HITL）：违反 HITL 底线
- ❌ phase 重排 / phase 增删 / 用户自定义 workflow：V0.2 写死 `feishu-story-impl` workflow、未来再说
- ❌ 多 agent 协作（context agent / plan agent / build agent 各跑各的）：Cognition 反对的就是这种、且会破坏单 Run 一次扣费的优势
- ❌ build phase 内部细粒度 HITL（每 task 一次 ack）：太烦、build phase 边界 ack 已足够
- ❌ 自动 PR merge：交付链路终点是 PR opened、merge 让人类决定

用户提过：B 端跑通后可能扩 C 端。

C 端的特点：

- 流程更多（用户路径、多端、设计稿审美）
- 业务规则更杂
- 需求文档表达更模糊

设计层面要为此预留：

- `prompts/` 应该按业务类型分目录、未来加 `prompts/c-end/`
- `RepoConfig` 加 `category: "B" | "C"` 字段、不同仓库走不同 prompt 模板
- HITL ack 在 C 端可能要更多次、UI 上要可配置 phase 数量

不是 V0.1 该做的事、写在这里**为防忘记**。
