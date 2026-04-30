# DESIGN：关键设计决策与权衡

> 这份文档解释**为什么这么做**——不写就忘的细节、给后续维护和扩展用。
>
> ⚠️ **2026-04-30 同步**：spec phase 已被 clean slate 清空、第 4 / 5 / 6 / 7 节描述的"实现"目前**没有代码对应**、原则保留待重建。第 9 节"UI 框架的选型"中"shadcn/ui 砍了"已**推翻**——本项目现在就用 shadcn/ui base-nova。详见 HANDOFF.md。

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
| 文件系统 ✅ | 零依赖、易调试、git diff 看产物 | 多用户 / 大量任务时性能差 | W1 用 |
| SQLite | 单文件、零运维、SQL 查询 | 多了一层抽象 | W2+ 看情况切换 |
| Postgres | 团队级 | 重 | 上线给团队用时再说 |

**接口收敛在 `src/lib/fs-store.ts`**——切 SQLite 时改这一个文件就行、其他地方不变。

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

## 6. Prompt 文件化的设计

```
prompts/build-spec.md  ← 用户能直接编辑
   │
   │ runSpecPhase 启动时
   │ fs.readFile(prompts/build-spec.md)
   │ 拼到 buildSpecPrompt
   ▼
传给 agent.send()
```

**好处**：

- 用户改完保存、下次跑就生效（不用重启 dev、Next.js 不缓存）
- diff 友好（git 看 prompt 演化）
- 模板/正文分离（变量在代码、措辞在 markdown）

**约束**：

- 模板里**不要硬编码业务变量**——业务变量从 `TaskInput` 传入、由 `buildSpecPrompt` 拼接
- 改 prompt 时不要破坏 schema 输出格式（spec.md 必须严格按 schema、否则后续 phase 没法解析）

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

## 关于"未来扩 C 端"

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
