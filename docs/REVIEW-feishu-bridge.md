# 飞书 Chat 桥接 — 双 AI Review 协作文件

> 用途：reviewer AI 与开发 AI（Fable5，本功能作者）通过本文件回合制协作，
> 收敛「飞书 chat 桥接」功能质量，用户回来做二次验收。
>
> **协议**：
> 1. reviewer 只读代码 + 写本文件，**不直接改代码**（代码修改权归开发 AI，避免并发冲突）
> 2. 回合制：reviewer 写一轮 review（每条编号 R<轮>-<序>，带 文件:行号 + 问题 + 严重度 P0/P1/P2），把文末状态改为「待处理」→ 开发 AI 处理每条（「已修 + 修法」或「反驳 + 理由」），状态改「待复审」→ reviewer 复审，直到写「收敛」
> 3. 结论要有行级证据；构造的假想场景必须明标「构造」；被反驳后先回头核实再坚持
> 4. 全程不 push；开发 AI 每轮修完保证 `pnpm typecheck` / `pnpm lint` / `pnpm vitest run` 全绿

---

## 一、功能介绍（开发 AI 写，reviewer 先读这个）

### 是什么

**飞书 chat 桥接**：app 的 chat 模式与飞书私聊双向同步。AI 回复实时推到飞书（CardKit 流式卡片、打字机效果），用户在飞书里回消息直接续接同一会话；app 和飞书两边谁先回都行、状态一致。设计文档（权威规格、24 条已拍板决策 + 16 个坑 + S5 冒烟实录）：`docs/proposal-feishu-chat-bridge-2026-07-18.md`。

### 架构一句话

出向 = server 旁路订阅 chat 事件流（对 chat-runner 零侵入）→ 翻译成飞书流式卡片；入向 = 常驻 `lark-cli event consume` 子进程收飞书事件 → 路由注入现有 chat 消息链路（与 HTTP 入口同一实现）。agent 本身完全无感知（不调工具、不等待）。

### 模块地图（全部在 `src/lib/server/feishu-bridge/`，除注明外）

| 模块 | 职责 |
|------|------|
| `lark-api.ts` | lark-cli execFile 封装（`--as bot`）：CardKit 裸调、发消息、上传/下载资源、reaction；进程级串行队列；错误归一化（LarkApiError 带 permission_violations/console_url） |
| `card-stream.ts` | 单轮流式卡片状态机：建卡→发消息→节流 PUT 全量文本（250ms/600 字符）→finalize；打字机前缀守卫、10 万字符截断、ask_user 按钮渲染（element_id 短哈希，CardKit ≤20 字符硬限） |
| `card-seq.ts` | 按卡共享 sequence 分配器（max(上次+1, 秒级时间戳)）——card-stream 与 card-action 交错更新同卡不撞 300317 |
| `card-map.ts` | 飞书消息 id ↔ taskId/cardId 映射落盘（回复锚定用）+ 补拉游标 |
| `outbound.ts` | 全局 tap（task-stream.subscribeAllTaskStreams）订阅 chat 事件：user_reply 累积回显（app 侧发的嵌卡片引用块、飞书侧来的不嵌）、thinking/tool 进折叠 timeline、assistant_delta 流式进正文、ask_user 追加按钮、done/error finalize（含正文本地图片上传替换、连续失败≥3 落 info 事件） |
| `inbound.ts` | 常驻 consumer 守护：`im.message.receive_v1` + `card.action.trigger` 两个 lark-cli 子进程（stderr ready 标记、stdin pipe 优雅退出、指数退避重启、event status 单实例守卫、unsupported 态优雅降级）；断线补拉（30 分钟窗、分页、去重）；keep-awake（mac caffeinate -s / win SetThreadExecutionState，仅接电生效） |
| `router.ts` | 入向消息路由：p2p+本人过滤 → content 解析（text/image/file/post，图片 6 张 10MB、文件 50MB 上限）→ 命令词/skill 分发 → taskId 定位（回复锚定 → 活跃唯一 → 0 个自动新建 → 多个提示）→ pendingAsk 走答题注入、否则 chat 注入；注入结果钩子（多订阅） |
| `ask-inject.ts` | 飞书自由文本答 pending ask（对齐 ask-reply chat 分支语义） |
| `card-action.ts` | 卡片按钮回调：operator 身份校验 → ask 答题（整组提交、卡片置「✅ 已选」）/ 错误重试按钮；与 card-stream 的按钮 element_id/value 严格对偶 |
| `commands.ts` | 七命令：/stop /compact /new /list /history /status /help（回复锚定同款 task 定位） |
| `reactions.ts` | 注入结果 emoji 回执：成功 Get、排队 Typing、失败 CrossMark（键名实测）；队列 flush 后 Typing→Get 升级 |
| `probe.ts` + `/api/feishu-bridge/status` | 设置页引导检查：CLI 登录/scope 等价核对（含权限预填深链）/cardkit 试建卡/runtime 状态；欢迎消息 |
| `bootstrap.ts` | 统一注册入口，挂在 /api/tasks 与 status route 模块加载（不能挂 instrumentation——webpack 不吃 serverExternalPackages 会炸路由，S5 实录 #4） |
| `bridge-config.ts` / `bridge-state.ts` / `keep-awake.ts` | 开关读取/深链拼接；p2p chatId + 已处理 message_id 去重落盘；防睡眠 |
| `src/lib/server/chat-inject.ts` | chat-reply route 的完整业务逻辑（单一实现）：HTTP route 与飞书 router 共用，`userReplyMetaExtra` 线程化（meta.source: "feishu"）——**与 main 的消息投递协议（clientItemId/指纹/op ledger）零漂移是本模块的生命线** |
| `src/lib/server/chat-queue.ts` | 新增：`removeQueuedChatMessages`（撤回出队遗留 API，撤回功能已下线但 API 保留）、`onQueuedMessageFlushed` 中性钩子（flush 成功回调，reactions 订阅） |
| Electron 壳（`electron-app/main.js` 等） | `flowship://`（test: `flowship-test://`）深链协议（mac open-url / win second-instance）、Tray 常驻（关窗 hide）、开机自启 IPC |
| 设置页（`feishu-bridge-block.tsx`） | 全局开关、引导检查（只展示问题行）、欢迎消息按钮、插电防休眠/开机自启开关 |

### 关键不变量（review 重点核对这些别被破坏）

1. **打字机前缀**：同一 element 的流式 PUT 全量文本必须前缀单调（card-stream 前缀守卫；已推前缀绝不回改）
2. **同卡 sequence 严格递增**：一切更新走 `nextCardSequence(cardId)`（card-stream/card-action 共用）
3. **chat-inject 与 main 协议零漂移**：消息 op ledger（claim/persist/handedOff/settle）语义不能被桥接路径绕过
4. **身份安全**：入向消息 sender ≠ 应用 owner 丢弃；按钮回调 operator ≠ owner 丢弃
5. **分层**：chat 层（chat-runner/chat-queue/chat-inject）不 import feishu-bridge；桥接经中性钩子（onQueuedMessageFlushed / addInjectResultListener）挂载
6. **静默降级**：出向任何 lark 失败不得影响 chat 主流程（warn + failCount，≥3 落 info 事件）
7. **双实例**：同 event key 已有 consumer（test/正式/跨机器）→ 拒绝启动置 conflict

### 已知边界（不是 bug，反驳前先看）

- 撤回同步已按用户拍板下线（lark-cli 未收录 recalled_v1）；`removeQueuedChatMessages` 是保留 API
- 多题 ask_user 不渲染按钮（避免「（未回答）」整组提交误导 agent）、提示文字作答
- 出向正文本地图片流式期间原样保留、finalize 才上传替换（保打字机；方案 4.5 已记）
- pendingAsk 是进程内存态，重启后按无 pending 兜底走 chat-reply（可接受，方案 4.4）
- card.action.trigger 需用户在开放平台扫码订阅回调（一次性，设置页有「去订阅」引导）
- Windows 代码分平台处理但未实机验证

### 测试与验证现状

- 全量 vitest：1124 绿（feishu-bridge 专项 60+）；typecheck/lint 干净
- 真联调已验：出向流式卡片、ask_user 按钮渲染、发消息/收消息/建卡/reaction 键名（Get/Typing/CrossMark）均真机实测过
- **正在进行中的修改（reviewer 别重复报）**：
  1. 回复锚定 miss 修复（root_id 之外补 parent_id + bot 提示消息锚定 + 飞书建 chat 对齐 useNewChat 默认参数）——子代理进行中
  2. 卡片样式照搬 Hermes 开源实现——子代理进行中
  3. 全仓去 ai-flow 品牌标识（→ Flowship）+ Cursor 账号 User Rules 泄漏调查——子代理进行中

---

## 二、Review 轮次区（reviewer 从这里开始写）

（暂无）

---

**状态：等待 reviewer 首轮**
