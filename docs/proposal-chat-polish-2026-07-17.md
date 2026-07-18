# Chat 模式打磨路线图（对标 Grok Build / Cursor IDE 聊天）

> 2026-07-17 立项调研。目标（用户原话）：**底层还是 Cursor SDK，把周边打磨好，让 chat 模式媲美 Cursor IDE 聊天 / Grok Build——好用、快。**
> 依据：① Flowship chat 现状盘点（7 面能力清单 + 体验硬伤 top 10）；② Grok Build 开源后功能拆解（6 面对标清单 + 最佳 5 体验点）。两份调研结论已交叉核对。
> 原则：底座不换（Cursor SDK）、复用现有基建（Lexical composer / task-worktrees / run-perf / events.jsonl / 懒重启）、每阶段独立交付可感知提升、不搞大爆炸重构。
> **能抄直接抄（用户拍板）**：Grok Build 已开源——prompt 模板、默认参数、数据结构、交互规则等可直接搬运的资产优先搬运而非自造（Rust 代码本身不能 copy 进 TS 仓、但设计与文本资产可以）。可搬清单见 `docs/grok-build-portable-assets-2026-07-17.md`（P3/P4 开工前必读；License 结论也在该文档）。

## 0. 一页结论

现状定位：chat 已是「可用的多轮 Agent 对话壳」（流式 Markdown、斜杠 skill、贴图、模型/MCP/目录切换、SSE 重连、系统通知都齐）。与标杆的差距集中在四件事：

| 差距 | 现状硬伤 | Grok Build 的答案 |
|---|---|---|
| **过程怎么看** | 工具成功结果不落盘、shell 输出黑盒、edit 无 diff | 流式 shell 输出块 + inline diff + 可折叠工具块 |
| **改动怎么审/怎么反悔** | 无 checkpoint、无 diff 审阅、出错只能 git 手救 | `/rewind`（Esc Esc）= 文件快照 + 对话一起回退；plan 审阅闭环 |
| **上下文怎么喂** | 只能 picker 附路径，无 @ 引用 | `@file:10-50` 模糊搜索、`@dir/`、prompt 历史 |
| **会话怎么持续** | 上下文无限膨胀、无压缩、长聊变慢变贵 | 85% 自动 compact（full-replace summarize）+ `/context` token 透视 |

关键技术情报（避免误判）：Grok Build 的 shell **也是每条命令冷启动进程**（源码实锤 `shell -c`），它快的体感来自 **流式输出 + 超时自动转后台 + 排队/插队**——是 harness 层补偿，不是持久 shell。我们不必也没法在 SDK 下面换 shell 架构，对标它的补偿手段即可。

## 1. 分阶段路线图

每阶段可独立发版、独立回滚；顺序按「体感收益 ÷ 实现风险」排。

### Phase 1「看得见」——过程透明 + 消息基础（最快见效）

| # | 事项 | 现状根因 | 做法 |
|---|---|---|---|
| 1.1 | **工具结果可见**：shell 输出、read/grep 结果完成后可展开查看 | `chat-runner`/`sdk-message-handler` 对 completed 工具不落事件 | 落 `tool_result` 事件（带体积上限 + 截断标记），事件流工具行可展开；shell 支持流式 delta（SDK `shell-output-delta` 已有、现被忽略） |
| 1.2 | **edit 内嵌 diff**：agent 改文件时消息流里直接看 hunk | edit 工具结果被忽略 | edit completed 事件带 before/after 摘要，前端渲染 inline diff（复用 artifact-revision 的 diff 渲染基建） |
| 1.3 | 消息级复制 / 重发带附件 | rows 只有末条重发且丢图 | assistant 消息 hover 复制；重发携带原 meta.images |
| 1.4 | **首条启动进度可视**：MCP 探测 → Agent 创建 → 发送中 | 全堆在「启动中」黑盒 | run-perf 打点已有，把阶段透传成 loading 行文案 |
| 1.5 | **workdir 脱节 bug**：改工作目录后同会话仍用旧 cwd | 懒重启只比 model/MCP、不比 repoPaths | repoPaths 变更纳入懒重启比对（盘点确认的真实坑，当 bug 修） |
| 1.6 | 未绑仓警示：默认 cwd=home 仍可写文件 | 误伤面大 | 未绑 workdir 时输入框上方常驻小提示 + prompt 注入「未绑仓、写操作先确认」 |

### 贯穿项「好看」——UI 视觉打磨（用户拍板追加：对标 Cursor IDE / Grok Build 的观感）

每个 Phase 的前端改动都按此执行，不单独成阶段：

- 新增/改版视觉块一律先过 `frontend-design` skill 定调 + `ui-ux-pro-max` 检索具体建议（本仓 ui-conventions 既有约定）
- 对标重点：工具调用块的折叠/展开动效与层次（GB 的 clean diff / 可折叠块）、消息气泡密度与呼吸感（Cursor IDE 聊天的紧凑但不挤）、代码块与 diff 的语法高亮一致性、加载态的分阶段反馈（不再单一转圈）
- 统一走既有设计 token（`bg-selected`、LoadingState/EmptyHint/ChoiceButton），不引入第二套视觉语言

### Phase 2「喂得准」——上下文入口

| # | 事项 | 做法 |
|---|---|---|
| 2.1 | **`@` 引用**：输入 @ 触发文件/目录模糊搜索（限已绑 workdir），支持 `@file:10-50` 行区间 | Lexical 新 token 节点（skill token 同款模式）+ server 端 fuzzy 文件索引 API；选中后 prompt 注入路径（+行区间内容） |
| 2.2 | 侧栏会话搜索 | 标题 + 首条消息全文过滤（events.jsonl 首条已在 meta 可推） |
| 2.3 | prompt 历史：空输入 ↑ 翻本会话历史输入 | events 里 user_reply 已全有，composer 加历史游标 |

### Phase 3「改得起」——checkpoint / rewind + diff 审阅（价值最高、体量最大）

| # | 事项 | 做法 |
|---|---|---|
| 3.1 | **消息级 checkpoint**：每条用户消息发出前对 workdir 打文件快照 | 复用 task-worktrees 的 snapshot 基建思路（git stash-like 或 GB 式文件快照存 session 目录）；只对已绑 workdir 生效；快照保留策略（近 N 条） |
| 3.2 | **rewind**：消息 hover「回退到这里」= 恢复快照 + 截断对话 | 对话截断 = 关旧会话 + 新会话注入截断摘要（懒重启基建复用）；UI 二次确认（未 commit 改动会丢） |
| 3.3 | **会话 diff 面板**：本轮会话改了哪些文件、逐文件 diff、单文件回滚 | 基于 checkpoint 与当前状态 diff；渲染复用 artifact diff 组件 |

### Phase 4「聊得久」——长会话可持续

| # | 事项 | 做法 |
|---|---|---|
| 4.1 | token 透视（对标 `/context`）：当前会话 token 构成 + 超阈值提醒 | run-perf 已采 turn usage，UI 化 + 阈值提示（先做非缓存 input 口径，L3 落地处） |
| 4.2 | **手动/自动 compact**：摘要重建会话（GB full-replace 思路） | 阈值触发或按钮触发：让 agent 产会话摘要 → 关旧会话 → 新会话首包注入摘要（懒重启链路复用）；可带「保留要点」输入 |
| 4.3 | 首包瘦身（平台 L4）：skills/rules 索引化按需读、续用只发短 directive | 单独立项、chat/task 都受益，放本阶段一起做 |

### Phase 5「顺手」——编排与升格

| # | 事项 | 做法 |
|---|---|---|
| 5.1 | 运行中输入排队：agent 正忙时 Enter 入队、回完自动发（替代现在的 409） | server 侧 per-task 消息队列 + UI 排队气泡（对标 GB `Enter` 排队；插队后做） |
| 5.2 | chat → task 升格：把聊出来的需求一键转正经 task（带上下文摘要） | 新建 task 时注入 chat 摘要 + 引用原会话链接 |
| 5.3 | 长命令后台化探索：受 SDK 能力约束（无 auto-background 选项），先靠 prompt 引导 agent 用 `&`+落盘轮询，观察效果再定 | 存疑项、不承诺 |

## 2. 明确不做 / 不对标的

- **不换底座**：不自研 agent loop、不接 Grok Build 运行时（它是 Rust TUI 整机，我们只对标体验面）
- **不做 TUI/终端形态**、不做 `/imagine` 等媒体生成、不做 memory/dream 实验特性
- **plan mode 不单独做**：Flowship task 模式的 plan action + HITL ack 已覆盖「先对齐再动手」，chat 保持轻
- shell 持久化：SDK 层黑盒，不硬啃；靠 Phase 1 流式可见 + Phase 5 排队补体感

## 3. 风险与依赖

- Phase 1 的 tool_result 落盘会增大 events.jsonl 体量 → 带体积上限 + 截断（全量落临时文件给「查看完整输出」）
- Phase 3 checkpoint 对大仓的快照成本要实测（先做「只快照 agent 改过的文件」的轻量版）
- Phase 4 compact 的摘要质量决定体验，需要 prompt 打磨 + 保留 plan/关键决策的规则
- SDK 升级可能带来原生能力（如工具输出选项、shell 配置）——每阶段开工前查一次 SDK changelog，避免重复造轮子
