# HANDOFF：给下一次对话的接力文档

> **如果你是接手这个项目的 AI 对话——这份文档是你必读的"上下文胶囊"。读完之后再开口。**

---

## 一句话定位

把"前端业务需求"自动化成 spec → plan → code → MR 的流水线工具、定位**公司前端项目通用工具**、B 端为主、未来可扩 C 端。

**输出物的边界**：最远到 draft MR、**不到 merge & deploy**——因为后端联调、QA、灰度、上线都在前端控制范围之外。

---

## 用户画像

| 维度 | 信息 |
|---|---|
| 角色 | 公司前端 IC、Cursor heavy user |
| 工作 | 几乎全是 B 端前端（管理后台、表单/列表/弹窗为主） |
| 仓库 | tch-service-center / crm-web / class-advisor-center 等多个 vue/react 仓 |
| 痛点 | 重复模式多、手做累；想自动化但不要"颠覆性"幻想 |
| 偏好 | 要客观、要业界共识、不要照搬某本书；中文沟通 |

---

## 项目根本方法论：基于 Harness（必读）

**本项目就是 Harness 工程化方法论的实操落地——所有开发决策、架构建议、迭代方向都必须在 harness 框架内进行。**

### Harness 是什么

Harness 是让 AI 模型在生产里**可靠运行**的工程化方法论。核心命题：

> Agent = Model + Harness  
> 模型只是"大脑"、harness 是给大脑装上**手脚 / 眼睛 / 安全带 / 后视镜**的工程框架。

通用 harness 包含的工程组件：

- **角色（Role）**：明确 AI 的身份和职责边界
- **工具（Tools）**：read / write / grep / shell / MCP / hooks 等让 AI 操作外部系统
- **记忆（Memory）**：会话内 + 长期持久化、防止上下文丢失
- **流程（Workflow）**：把任务拆成可观测、可回退的多阶段
- **守门（Guardrail）**：硬规则、HITL gate、自动校验
- **观测（Observability）**：日志、token、cost、latency 全量记录
- **评估（Eval）**：金标用例集、回归测试

### 资料来源（按权重）

| 资料 | 权重 | 备注 |
|---|---|---|
| Anthropic *Building Effective Agents* | ⭐⭐⭐⭐⭐ | 业界圣经、五种基本模式、必读 |
| Cognition Labs *Don't Build Multi-Agents* | ⭐⭐⭐⭐⭐ | 警告「多 agent 同时协作 / 隐式 hand-off / 共享记忆」型 multi-agent；不针对「workflow 里多 agent 节点 + 文件 hand-off」 |
| 真生产案例（GitHub Copilot Workspace / Cursor Cloud Agent / Aider / Replit） | ⭐⭐⭐⭐ | 看产品形态学（不是 demo） |
| Langfuse / LangSmith 文档 | ⭐⭐⭐ | observability 标准 |
| 《AI Coding 工程化》[austincao/ai-coding-mini-library](https://github.com/austincao/ai-coding-mini-library) | ⭐⭐ | 中文 harness 参考资料、可看不可照搬：作者私人框架（"五元素"、"A/B/C/D 任务分类"、"6 段式上下文模板"）不是业界共识；其"L2 全自动"愿景在真生产 0 成功案例 |

### 本项目的 Harness 实现映射

> ⚠️ 下面有 (旧) 标注的是上一版本实现、clean slate 时已删；保留映射是为了让接力 AI 知道"曾经怎么做的、未来要不要走回老路"。

| Harness 通用组件 | 本项目实现 |
|---|---|
| 角色 | (旧) `prompts/build-spec.md` 顶部"你是 B 端前端开发"——已删、待重新设计 |
| 工具 | `@cursor/sdk` 自带 read / edit / grep / shell / MCP / hooks（保留） |
| 记忆 | (旧) 文件系统 `data/tasks/<id>/` + agent 会话——已删、未来重建 |
| 流程（Workflow） | (旧) 多 phase chain（spec → plan → build）；当前**未实现**、形态待和用户讨论是否还分段；agent 数量可单可多 |
| 守门 | (旧) `prompts/build-spec.md` 硬规则 + 每 phase 后 HITL ack + grep 校验脚本——HITL 仍是底线 |
| 观测 | (旧) `llm-log.jsonl` 全量打日志、未来对接 Langfuse——日志机制待重建 |
| 评估 | 老路线 W6+：金标 spec/plan 用例集、回归比较——未启动 |

### 后续对话的强约束（必须遵守）

1. **所有架构决策必须能在 harness 框架内解释**——不能说"加这个功能很酷"、必须说"它对应 harness 哪个组件、解决什么 reliability 问题"
2. **建议优先在 harness 业界共识里查**——Anthropic / Cognition / 真生产案例 > 那本书的私人框架 > 凭直觉
3. **碰到分歧时**：业界共识 > 那本书 > 用户直觉。如果业界没共识、走那本书；如果都没有、和用户讨论
4. **不要重新发明 harness**——多 phase chain、HITL、observability 这些都是已经决策过的、不要建议替代方案
5. **新增能力都要从 harness 视角合理化**：
   - 加个新 phase？解决哪个 reliability gap？
   - 接新工具？补 harness 哪个组件？
   - 改 UI？观测 / 守门更顺还是只是好看？

### 用户问 harness 时的标准回答模板

- 不要照搬那本书的"五元素"
- 优先引用 Anthropic 五种模式（Prompt Chaining / Routing / Parallelization / Orchestrator-Workers / Evaluator-Optimizer）
- 引用 Cognition 论据时**注意范围**：Cognition 反对的是「多 agent 同时协作 / 隐式 hand-off / 共享记忆」（如 BMAD 的 PM/Dev/QA 谈判），不反对「workflow 里多个 agent 节点串联、文件 hand-off」——本项目 spec/plan/build 多 agent 节点是合法的
- 引用真生产案例的 HITL 范式
- 必要时再带过那本书作为补充资料

---

## 项目背景

用户原本想做"一键全自动化流水线"——AI1 写技术方案、AI2 开发、AI3 review + 测试、最终交付。

经过 harness 视角讨论、降维到**当前形态**：

- **Workflow-shaped**：spec → plan → build 走多 phase chain、状态走文件 + 明确 schema 的 hand-off
- **agent 数量灵活**：可以单 agent 跑全程、也可以每 phase 独立 agent；按场景需要切、不强制二选一
- 每个 phase 之间强制 HITL ack
- 输出 markdown 产物 + 落盘日志
- 有 Web UI、不是 CLI

降维原因（业界共识、参见 DESIGN.md）：

1. **Anthropic** *Building Effective Agents*：90% 你叫"agent"的、其实是 workflow + routing + evaluator——本项目就是这个范式
2. **Cognition Labs** *Don't Build Multi-Agents*：警告的是「多 agent 同时协作 / 隐式 hand-off / 共享记忆分裂」这种**真正意义上的 multi-agent**（如 BMAD 的 PM/Dev/QA 互相谈判）。不针对「workflow 里多个 agent 节点串联、文件 hand-off」这种用法
3. 业界**所有真投生产**的产品（GitHub Copilot Workspace / Cursor Cloud Agent / Aider / Replit）**都是半自动 + HITL**

> ⚠️ 老版本本节写过「单 agent / 不上 multi-agent」、是接力 AI 自己抱起来的强约束、用户**没拍过**这板。现已改正。具体术语见下面「关键设计决策 1」。

---

## 当前状态（最新）

> ⚠️ **V0.1 spec phase 的代码已被用户主动 clean slate 清空**——只保留了基础设施和重建后的设置页、主流程交互正在重新设计中。
> 不要再按下面"V0.1 完成清单"那种话术汇报、参考"已删除的旧能力"和"还在的能力"两节。

### 已删除的旧能力（不要再提"已完成"）

```
🗑 src/lib/fs-store.ts（任务文件持久化、未来重建）
🗑 src/lib/cursor.ts（runSpecPhase / SSE wrapper）
🗑 prompts/build-spec.md（spec phase 的 prompt）
🗑 data/tasks/*（旧任务产物）
🗑 src/app/page.tsx 的 spec 表单 UI
🗑 src/app/tasks/[id]/page.tsx
🗑 /api/tasks/* 全套 API route
🗑 设置页旧实现
```

### 还在的能力 ✅

```
✅ Next.js 15 + React 19 + Tailwind 4（从 3 升上来、配合 shadcn/ui base-nova 风格）
✅ shadcn/ui（base-nova 风格、组件放 src/components/ui/、底层用 @base-ui/react）
✅ next-themes 强制 dark 主题（src/components/providers.tsx、不允许切换）
✅ sonner toast
✅ src/lib/types.ts：RepoConfig / ModelSelection / ModelParameter / ModelVariant / ModelOption / FeAiFlowSettings
✅ src/lib/local-store.ts：localStorage 读写 + 老 schema 兼容（defaultModel string → ModelSelection）
✅ src/app/layout.tsx：dark + Providers + Toaster + 顶部 Settings 链接
✅ src/app/page.tsx：占位卡片（"所有旧页面已清空、设置页正在重建中"）
✅ src/app/settings/page.tsx：四张卡片（API Key / 默认模型 / 仓库 / MCP servers）、每卡独立保存
✅ /api/models（POST、代理 Cursor.models.list、按 displayName 排序、带 parameters / variants）
✅ /api/fs/pick-folder（POST、osascript 弹原生文件夹选择、仅 macOS、未来远程部署要换实现）
✅ next.config.ts 加了 serverExternalPackages: ["@cursor/sdk"]、避免 webpack 解析 SDK 的 .d.ts.map
✅ TypeScript strict + pnpm typecheck 通过
```

### 已验证的事实（不要再争）

- ✅ `@cursor/sdk` 用的是用户当前账号的**请求计费（老计费）**、不是 token 计费——可以放心用
- ✅ Cursor SDK 是**纯模型调度器**、不带 IDE 内置的工具 / 系统 prompt——所有规则要自己注入
- ✅ Max Mode 是 Cursor 后端按**实际 token 用量**动态判定的、不是 `context=1m` 参数自动触发
- ✅ `composer-2-fast` 一次请求扣 2 次（高速模型常态）、不算异常

### 待决策项（用户尚未拍板）

- 🔲 主页的交互形态——传统表单？聊天式？两者结合？
- 🔲 spec / plan / build 三段式还要不要、还是直接做单一长会话 + HITL ack
- 🔲 单 agent 全程 vs 每 phase 独立 agent——具体怎么切（用户已拍板「都要支持、可单可多」、待主流程设计时定 UI 入口）
- 🔲 按 phase 配模型——**用户明确说「先把主流程跑通再考虑」、本轮不动**
- 🔲 MCP servers 配置怎么真正用起来（注入到 agent）
- 🔲 仓库列表的"远程仓库"模式（路线图原计划 W4）
- 🔲 是否给设置页加 Max Mode 风险 badge（用户倾向先不加）
- ✅ ~~推不推 GitHub？~~ → 已 push 到 https://github.com/jianger666/fe-ai-flow（private、commit 邮箱走 GitHub noreply）
- 🔲 是否接飞书 MCP 自动拉文档？

---

## 关键设计决策（不要轻易改）

### 1. Workflow + 多 phase chain（agent 数量可单可多）

**形态**：项目本质是 workflow——spec → plan → build 三段、每段产物落盘（spec.md / plan.md / build diff）、下一段读上一段产物作为输入、hand-off 走文件而非内存。

**agent 数量两种合法路径**：

- **单 agent 全程**：一个 SDKAgent 实例跑完所有 phase、共享会话保留连贯上下文。适合小任务、token 也省。
- **每 phase 独立 agent**：每段起新 agent、读文件作为输入、产物落盘、释放。适合长任务避免 context 爆 / 不同 phase 想用不同模型。

二者**都不是 Cognition 警告的 multi-agent**——警告对象是「多 agent 同时协作、隐式 hand-off、共享记忆分裂」（如 BMAD 的 PM/Dev/QA 互相谈判）；本项目不论选哪种、phase 之间都是**显式 file-based hand-off + HITL ack**、不会出现失控的 agent-to-agent 协商。

**当前进度**：主流程未落地、具体怎么做选项在 W2 主流程设计时拍板。设置页目前只能配一个默认模型；如果未来走「每 phase 独立 agent」、需要扩成「按 phase 配模型」——但用户已说「先把流程跑通再做这个」、本轮不动。

> ⚠️ 老版本本条写「单 agent / 不串联多 agent」是接力 AI 自己抱起来的强约束、用户从未拍板。已修正。

### 2. HITL（Human in the Loop）是底线

**原因**：所有真生产产品都没敢全自动。  
**实现**：每 phase 跑完、产物落盘、UI 上等用户点"启动下一阶段"。**不要**自动串联三个 phase。

### 3. 文件系统存储、不上数据库（原则保留、当前未落地）

**原因**：早期阶段、不浪费时间在持久层抽象。  
**当前状态**：clean slate 已删 `src/lib/fs-store.ts`、`data/tasks/*`——主流程重做时再建。  
**升级路径**：未来量大或多用户时换 SQLite、接口收敛在新版 `fs-store` 即可。

### 4. localStorage 存配置、API key 不上服务器

**原因**：每个用户自己配自己的 API key、不暴露给 server。  
**实现**：`src/lib/local-store.ts` 全是 `if (typeof window === "undefined") return ...`、SSR 安全。

### 5. Prompt 文件化、不写在代码里（原则保留、当前未落地）

**原因**：用户能直接编辑 prompt、迭代成本最低。  
**当前状态**：`prompts/` 目录已删、主流程重做时按这条原则重建（`fs.readFile` + 不缓存）。

### 6. 默认模型走"用户在设置页选 + SDK 参数"

之前曾决策"设置页删默认模型、主页直接选"——本轮 clean slate 已**推翻**：

- 设置页保留默认模型 Card、选 base model 后动态渲染 SDK 给的 `parameters`（thinking / context / effort / reasoning / fast）
- `FeAiFlowSettings.defaultModel` 是 `ModelSelection` 对象（`{ id, params? }`、跟 SDK schema 一致）
- 选 base 时默认把 `variants[isDefault]` 的 params 拿来当初始值
- 模型列表通过 `/api/models` 后端代理 `Cursor.models.list({ apiKey })` 拿、按 displayName 排序

### 7. UI 框架：shadcn/ui base-nova + Tailwind 4

之前 DESIGN.md 第 9 节说"shadcn/ui 砍了"也已**推翻**：

- 用 shadcn/ui 的 `base-nova` 风格（底层 @base-ui/react、不是 Radix）
- 因此组件 polymorphic 用 `render={<Link/>}` 而非 `asChild`
- `Select` 的 `onValueChange` 是 `string | null`、所有回调要 `v &&` 守卫
- Tailwind 4（CSS-first config、`@import "tailwindcss"` 在 globals.css、`tailwind.config.ts` 已删）
- 业务组件放 `src/components/`、shadcn 原子件放 `src/components/ui/`、`globals.css` 走 oklch 变量

### 8. 路径选择走原生文件夹选择器、不让用户手填

浏览器拿不到本地绝对路径、agent `cwd` 又必须是绝对路径——`/api/fs/pick-folder` 用 `osascript` 弹 macOS native dialog、把绝对路径返给前端。仓库名用 `path.basename` 自动填入、可手动改。

> 限制：仅 macOS、未来要远程部署得换"server 端目录浏览器"实现。

---

## 业界参考（必读）

新对话开始前、强烈建议看这两篇（20 分钟）：

1. **Anthropic *Building Effective Agents***  
   https://www.anthropic.com/research/building-effective-agents  
   核心：Workflow vs Agent、五种基本模式（Prompt Chaining / Routing / Parallelization / Orchestrator-Workers / Evaluator-Optimizer）

2. **Cognition Labs *Don't Build Multi-Agents***  
   https://cognition.ai/blog/dont-build-multi-agents  
   核心：multi-agent 在生产中的 4 大失败模式（指**多 agent 同时协作 + 隐式 hand-off + 共享记忆**那种）；本项目「workflow + 多 agent 节点 + 文件 hand-off」不在其反对范围

---

## 路线图（重新规划中）

> ⚠️ ROADMAP.md 里 W1-W6 那张表是上一版本计划、目前 spec phase 已删、整个产品形态在重新讨论。
> 不要再当成"路标"复述给用户。下面是当前实际的状态：

| 阶段 | 状态 | 备注 |
|---|---|---|
| 基础设施（设置页 / shadcn / Tailwind 4 / SDK 验证） | ✅ 完成 | 本轮 clean slate 重做 |
| 主流程交互（首页要长啥样、单段还是多段） | 🚧 待和用户讨论 | 不要先动手写、先拍板形态 |
| spec / plan / build 三段式 | 🤔 暂保留为参考、不一定再走 | 用户在重新思考是否还要分段 |
| 飞书 / swagger 自动拉 | 🔲 未启动 | 老路线 W4 |
| cost / token dashboard | 🔲 未启动 | 老路线 W5 |

不打算做的事（明确止损）：

- ❌ 全自动跑测试（公司没单测 / e2e、强行做没意义）
- ❌ AI 自审 review bot（共识盲点问题、性价比低）
- ❌ 跨 AI 厂商切换路由（你公司就 cursor、不需要 LiteLLM）

---

## 跟用户协作的注意事项

1. **不要照搬那本《AI Coding 工程化》**——用户态度明确、那本书是参考、不是圣经
2. **HITL 是用户偏好**——别提"全自动"
3. **客观数字、客观依据**——不要堆"颠覆性"这种词
4. **每次操作前唤起 cursor-feedback**（用户硬规则、且 timeout 600 秒）
5. **feedback 的 project_directory 要指当前工作的项目**——别切错
6. **代码改完跑 typecheck**——用户对低级错误零容忍
7. **typo / 错别字**——用户曾投诉过、注意
8. **思考和回复永远用中文**
9. **代码风格——已落到 `.cursor/rules/learned-conventions.mdc`、必读**：
   - 统一用 shadcn/ui 组件、页面尽量由组件组合
   - shadcn 原子件放 `src/components/ui/`、业务组件放 `src/components/`
   - **统一用箭头函数、避免 `function` 关键字**（第三方代码除外）
   - 注释多写、解释意图 / 约束 / 关键 state / 复杂逻辑、避免废话注释、全中文
10. **不要主动建议改动文档脱离实际**——这次就是因为 HANDOFF 没及时同步、害得每次新对话都要重新对齐

---

## 历史决策记录（用户拍板过的）

| 决策 | 拍板时间 | 决议 |
|---|---|---|
| 仓库放哪 | W1 第 1 天 | `~/Documents/my/fe-ai-flow`、未来推 GitHub |
| Node 版本 | 同上 | Node 22+ |
| API key 存哪 | 同上 | localStorage、每个用户自配 |
| UI 形态 | 同上 | Web UI（不是 CLI）、Next.js |
| 默认仓库列表 | W1 第 1 天 | 改成空数组、用户自加 |
| ~~设置页"默认模型"选项~~ | ~~W1 第 1 天~~ | ⚠️ 已**推翻**：clean slate 后重新加回设置页、且支持 SDK 模型参数（thinking / context / effort 等） |
| MCP servers | clean slate | 设置页用 JSON 编辑器、不读 `~/.cursor/mcp.json`（未来要做远程部署） |
| 仓库选择方式 | clean slate | 走 `/api/fs/pick-folder` 弹 macOS 原生 dialog、不让手填路径 |
| 每卡独立保存 | clean slate | 设置页 4 张 Card、每张自己一个保存按钮、不 auto-save |
| UI 风格 | clean slate | 强制 dark + shadcn/ui base-nova + Tailwind 4 |
| 函数风格 | clean slate | 一律箭头函数、不写 `function` 关键字 |

---

## 启动流程（开新对话后第 1 步）

```bash
cd ~/Documents/my/fe-ai-flow
pnpm dev
# 浏览器打开 http://localhost:3000
```

打开后看到的：
- **主页 `/`**：占位卡片「页面待设计」、引导去设置页
- **设置页 `/settings`**：四张 Card（API Key / 默认模型 / 仓库 / MCP servers）、每张独立保存

如果用户问"现在能做什么"——直说"基础设施 ok、主流程在重新设计"、不要照旧 README 复述 spec phase。

如果用户问"下一步做什么"——参考本文「路线图（重新规划中）」、不要直接抄 ROADMAP.md（那份过期）。

如果用户问"为什么这么设计"——参考 DESIGN.md（**注意第 9 节关于 shadcn 已被推翻**）。

如果用户提的问题在以上文档里**都找不到**——再问用户。
