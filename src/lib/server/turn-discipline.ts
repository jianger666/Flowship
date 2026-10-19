/**
 * 回合协议 prompt 片段（V0.11：wait 协议退役、chat + task 单一源）
 *
 * # 背景
 *
 * V0.3.5~V0.10 的「写完东西 → 调 submit_work → shell curl 挂着等下一条」保活协议已退役
 * （Cursor 去掉按次计费 + worktree 隔离后现场可断可续、用户拍板改回「create + 多轮 send」）。
 * 本文件从「等待纪律」改为「回合纪律」：agent 说完 / 交卷完 / 提问完就**正常结束回复**、
 * 用户的下一步操作会以新消息（agent.send）送达、同一会话继续。
 *
 * # 设计原则（依据 Anthropic prompting best practices、沿用 2026-06-14 立的规矩）
 *
 * - dial back aggressive language：不堆「🚨 绝对禁止」、点明陷阱 + 解释 why
 * - 单一源：chat 起手用 chatTurnProtocolSection；task 的交卷/结束回合写在 _super.md「核心机制」、
 *   不再往 super 里灌 turnDisciplineSection（避免和核心机制复读）
 */

/**
 * ask_user 回合纪律（chat / task 单一源）。
 * 调完工具后立刻前台挂返回里的 curl 等答案；提问后再说的话用户看不见。
 * 答案出现在 curl 的 stdout（`[ASK_USER_REPLY]`）。没挂上 curl 时服务端会改走 send。
 */
export const ASK_USER_TURN_LINE =
  "- 有不确定项 / 要用户选择 → 调 `ask_user` 推答题卡 → 立刻前台执行工具返回的 curl，直到 stdout 出现 `[ASK_USER_REPLY]`（提问后再说的话用户看不见）";

/**
 * `wait` 工具的使用纪律（chat / task 单一源）。
 *
 * 和上面「不要为交卷 / 闲聊执行等待」不矛盾：那条禁的是「等用户」的旧协议套路；
 * 这条是「真有外部的事要等」时的正路——用我们自己的 `wait`（界面显示已等时长和原因、用户能跳过、停止 / 插话会叫醒它），
 * 不用 shell sleep（占一个终端、界面上是个没头没尾的命令），也不用 SDK 自带的 await（对界面完全不可见）。
 */
export const WAIT_TOOL_TURN_LINE =
  "- 真有外部的事要等（命令跑完 / CI / 限流冷却 / 服务起来）→ 调 `wait` 工具睡一会儿，不要自己跑 sleep / watch / 轮询脚本，也不要用 SDK 自带的 await。它只是睡觉、**不替你检查**：醒来自己确认，没好再决定要不要继续等，间隔拉长一点。手头能做的先做完再等，别拿它空等（等用户回答用 `ask_user`、等用户下一步直接正常结束本轮，都不用 `wait`）";

/**
 * `schedule` 工具的使用纪律（chat / task 单一源）。
 *
 * 和 `wait` 分工：`wait` = 这一轮里睡几分钟（最长 30 分钟、占着本轮）；`schedule` = 结束本轮、
 * 到点系统把消息发回来（可以隔几小时 / 几天、不占会话）。两者都不是「等用户」。
 * 刻意把「写清做什么 / 怎么汇报 / 何时取消」放进措辞：成本护栏只靠 prompt（用户拍板不做硬限制）。
 */
export const SCHEDULE_TOOL_TURN_LINE =
  "- 要在**之后**某个时间再做 / 再看一件事（N 分钟后查 CI、每 10 分钟看一次部署、明早提醒用户）→ 调 `schedule` 工具设定时，然后正常结束本轮：到点系统会把你当时留的话作为新消息发回本会话，不用干等。几十分钟的等待别用 `wait` 硬睡，也别自己写 sleep / cron / 后台脚本。建定时时 `message` 要写清三件事：到点做什么、没变化时一两句带过（别打扰用户）、什么时候该自己 `cancel` 它（周期任务别让它一直跑）。应用没开 / 电脑睡眠时错过的不会补发";

/**
 * task 模式的「回合纪律」段（曾注入 _super.md；现交卷协议只留 super「核心机制」一处）。
 * 仍导出给测试对账 chat / task 对 ask_user 的同一句措辞。
 *
 * 讲清三件事：产物写好先交卷、拿到 [SUBMITTED] 后再说结论；提问走 ask_user；
 * 别执行任何等待命令（旧协议肌肉记忆 / 网上教程的轮询套路都不要）。
 */
export const turnDisciplineSection = (): string =>
  [
    "### 回合纪律（怎么把控制权交回用户）",
    "",
    "你和用户之间是**多轮消息**：每一轮你干完该干的、调完该调的工具、就**正常结束本轮回复**（结束 turn）。用户的下一步（推进下一步 / 输入条说话 / 回答提问）会作为**新消息**发给你、你在同一会话里继续、上下文不丢。",
    "",
    "- 完成一个 action（写完 artifact）→ 调 `submit_work` 交卷 → 拿到 `[SUBMITTED]` 后再说 1-3 句业务结论并结束本轮",
    ASK_USER_TURN_LINE,
    "- **不要为交卷执行等待 / 轮询**——sleep / watch / 自己编的 curl 都不要。提问只用 `ask_user` 返回里的那条 curl",
    WAIT_TOOL_TURN_LINE,
    SCHEDULE_TOOL_TURN_LINE,
    "- 交卷 / 提问是内部机制、别在正文里提工具名",
  ].join("\n");

/**
 * chat 起手 prompt 里的「怎么和用户对话」段（chat-runner buildInitialPrompt 用）。
 *
 * V0.11：chat 就是正常多轮对话——把回复正文直接输出（实时流式显示）、说完自然结束回复、
 * 用户下一条消息会续接同一会话。ask_user 与 task 同款（答题卡 → 结束回复 → 答案新消息续达）。
 */
export const chatTurnProtocolSection = (): string =>
  [
    "## 怎么和用户对话",
    "",
    "这是**正常的多轮对话**：用户发消息 → 你回答（正文直接输出、会一字一字实时显示给用户）→ **说完自然结束本轮回复** → 用户的下一条消息会续接同一会话、上下文不丢。",
    "",
    "几个关键：",
    "- **回复正文直接输出**——要查的先查清楚、要写的真写出来（让你写一整篇作文、就把整篇直接输出）。别只说「我先查…我先写…」就结束回复 = 没交付、用户看到的是一句空话。",
    "- **说完就正常结束回复**——不要为闲聊执行等待 / 轮询（sleep / watch / 自己编的 curl 都不要）；提问只用 `ask_user` 返回里的那条 curl。不要调 `submit_work`（本模式用不到它）。",
    ASK_USER_TURN_LINE,
    WAIT_TOOL_TURN_LINE,
    SCHEDULE_TOOL_TURN_LINE,
    "- 飞书权限缺失时（`app_scope_not_applied` / `token_missing`）：把缺的 scope 原样列出来问用户去开通，只推免审的常规权限（发消息、收消息、群信息、卡片这类）；群成员列表（`im:chat:members:read`）要审核、只告知不催（仅“我在不在群”可查）；看不懂的、要审核的只告知、不催。不要反复重试同一条，更不许静默降级凑合（比如拿不到 open_id 就发纯文本代替真 `@`，必须先停下来问用户要）。",
    "- 内部机制（工具名 / 协议）别在正文里提、直接给用户该看的内容。",
  ].join("\n");
