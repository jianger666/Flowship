# Chat 消息流大重构：从「run log 平铺」到「回复优先、过程按需」

> 2026-07-21 用户拍板（「我期望可以大重构，时间不是问题，我要的是质量」）。
> 背景：与 Cursor Agent window / Codex 对比，本产品 chat 的核心差距不在控件，
> 在信息架构——thinking / 工具行 / 旁白 / 系统 info 与正文平铺抢权重，一屏正文占比 ~30%，
> 更像 run log 而不是对话。

## 目标形态

一轮（turn）= `user_reply` 到下一个 `user_reply` 之间：

```
[用户消息（右侧浅气泡）]
[▸ 工作过程 · 5 步 · 40s]           ← 连续过程项收组；历史默认折叠、运行中展开直播
[AI 插话（全宽平铺）]                ← AI 说的每段话都独立、天然隔断前后组
[▸ 工作过程 · 7 步 · 1m34s]
[AI 正文（全宽平铺 markdown）]
──────── 时间胶囊分割线 ────────
[下一轮用户消息]
```

- **assistant_message 一律独立平铺**（2026-07-21 用户验收拍板）：AI 中间插的话
  不进组、且插话前后两批工具**不得**整合进同一组——插话是组的天然分隔符
- **过程组（work group）** = **连续的** thinking / tool 块 / verb-group / error
- **组外保留独立渲染**：`user_reply`、`assistant_message`、`ask_user_request`
  （交互卡）、`ask_user_reply`、`info`（细线化降权）、reconnecting 特殊行、
  虚拟项（streaming / loading / pending / boot）
- **运行中粘性状态行**：running 时 Composer 上方一行 shimmer（当前步骤 + 耗时），
  过程不再依赖用户滚动事件流跟踪；turn 结束消失

## 判定规则（纯函数、可单测）

- 组成员：`thinking`、`__tool_block__`、`__tool_verb_group__`、`error`——
  **连续**出现收进同一组；被任何独立项（含 assistant 插话）隔断后开新组
- 组折叠默认值：组内含 running 工具块、或（它是全流最后一个组且 isRunning）→ 展开；
  否则折叠。用户手动 toggle 后以手动为准（state 按组 id 记在组件内）
- 组 id：组内第一个成员的 id（分页 prepend 下稳定）
- 组头摘要：`N 步 · 耗时`（首末成员 ts 差；<1s 不显示）；含 error 成员时加错误标记；
  running 时显示当前步骤尾行代替耗时

## 工程分批（串行、每批全量门禁）

- **Batch A｜数据层**：`src/lib/chat-turns.ts`
  - `groupChatRenderItems(items, opts)`：吃 `mergeToolDisplayEvents` 的输出、
    产出含 `__work_group__` 虚拟项的新序列；纯函数
  - `deriveActiveStatus(events, liveToolOutputs)`：粘性状态行文案派生
  - 完整单测（turn 边界 / 正文判定 / 跨页全量重算 / running 组）
- **Batch B｜组件**：`src/components/tasks/event-stream/work-group.tsx`
  - 组头折叠行 + 展开渲染成员（成员复用 ToolBlockRow / ProcessEventRow / MarkdownText 降权段）
  - `active-status-line.tsx`：粘性 shimmer 状态行
- **Batch C｜接线 + 视觉**：`event-stream.tsx` items 管线接入分组、
  loadEarlier 的 prepend 差值换同一管线、间距 / sticky 轮次头 / turn 分割线兼容
  （`shouldShowTurnDivider` 的「此前有轮」判定加 `__work_group__`）、
  info 细线化（rows.tsx chat 分支）、状态行挂 Composer 上方、正文排版微调
- task(log) 形态零改动：所有新行为挂 `variant === "chat"` 分支

## 不做的事

- 不动 events.jsonl 数据结构（分组是渲染前纯函数变换）
- 不动 task 模式事件流
- 不做「消息 fork / 编辑历史」（架构 append-only）
