/**
 * 等待协议 prompt 片段（chat + task 单一源、V0.7.20 方案 B）
 *
 * # 为什么有这个文件
 *
 * 「写完东西 → 调 wait_for_user → shell curl 挂着等下一条」这套等待协议、原来在三处各写
 * 一长段、互相漂移、且每个 AI 来改都往上堆「🚨 绝对禁止 / 钢铁纪律」、越改越长越乱（典型
 * over-prompting）：
 *   1. chat-runner.ts buildInitialPrompt（chat 起手讲一遍）
 *   2. prompts/_super.md（task 起手又讲一遍）
 *   3. chat-mcp.ts buildShellWaitGuidance（每轮 wait 返回再讲一遍操作、chat / task 共一个函数）
 * 收口到这里：把**真正和「信号是什么 / 怎么传参 / 起手做什么」无关的纯机制纪律**抽成共用
 * 片段、chat 与 task 四处统一引用、改一处全生效。
 *
 * # 哪些抽得动、哪些抽不动（边界、改前必读）
 *
 * - **抽得动（waitDisciplineSection / shellCurlRunSection）**：等待期间的行为纪律 + 两个易翻点
 *   （答完必 wait / anti-loop 误报）+ 内部机制别泄露 + curl 怎么跑。chat / task 一字一样。
 * - **抽不动（各自保留）**：
 *   - 信号解读表——chat 只有 USER_REPLY / CANCELLED；task 有 ACTION_ACK / NEXT_ACTION /
 *     TASK_DONE 等一大套。且 `tests/protocol-signals.test.ts` 强制 `_super.md` **源文件**里
 *     出现全部信号字面量、所以 task 信号表只能留在 _super.md、不能抽走。
 *   - 起手姿势 / wait_for_user 传参 / artifact / revise 二分类等 task 业务。
 *
 * # 设计原则（依据 Anthropic prompting best practices、2026-06-14 立）
 *
 * - **dial back aggressive language**：不堆「🚨 第一铁律 / 绝对禁止 / 致命错误」——官方实测
 *   这类 over-prompting 会让模型 overtrigger / 抓不住重点。改成「点明陷阱 + 解释 why」。
 * - **正面回应真实系统警告**：Cursor 的 anti-loop「flagged as looping」是会真实注入给模型的
 *   系统消息、不是模型自己的念头。必须说清「这是误报、为什么、怎么办」、而不是只让它
 *   「忽略你自己的循环念头」（旧 prompt 的盲区——这次 composer-2.5 就是没被这套话术接住）。
 * - **消解 turn 矛盾**：composer-2.5 实测反复纠结「不调工具 turn 就结束」——讲清
 *   「后台 curl 还在跑 = turn 没结束 = 合法等待」、这个误解才是它最终卡死的根。
 */

/**
 * 等待期间的「纯行为纪律」段——chat + task 字符级共用单一源。
 *
 * 只讲 agent 在「shell curl 挂着等」期间该守的纪律 + 两个易翻点（答完必 wait / anti-loop 误报）
 * + 内部机制别泄露。chat 起手（chatWaitProtocolSection）、_super.md（{{waitDiscipline}}）、
 * chat-mcp 两个等待引导分支都引用同一份。
 */
export const waitDisciplineSection = (): string =>
  [
    "### 等待期间的纪律",
    "",
    "shell curl 挂着等用户、可能 0 秒也可能几小时——**任何长度都正常**。期间 stdout 每 60 秒刷一行 `[KEEPALIVE ts=...]`（心跳、忽略）。没看到「结果行」（chat 的 `[USER_REPLY]`、task 的 `[ACTION_ACK]` / `[NEXT_ACTION]`、或 `[CANCELLED]` 等）之前、唯一该做的就是**安静等**——别 read terminal、别重调 shell / wait_for_user、别 emit「我在等」、别 summarize 退出（每一个都会真把等待打断）。",
    "",
    "两个易翻的点：",
    "- **回复完的下一步永远是 `wait_for_user` 挂等**、不管这轮答得多完整 / 有没有反问用户——只有用户触发的收尾信号才结束 run（最常翻：用户问「为啥挂等」、你解释一段却忘了挂）。",
    "- Cursor 若提示「重复调用 / flagged as looping / 检测到循环」是**误报**（long-poll 的 curl 被转后台、留了两条相同记录所致）、忽略、继续等、别因此 read terminal / 重调 shell / 总结退出。",
    "",
    "`wait_for_user` / `shell` / `curl` 是内部机制、用户看不到——**别在正文里提（不说「我在等你」「正在监听」之类）、也别把「我接下来去挂等 / 我先接个话」这类流程念出来**、直接给用户该看的内容就行。",
  ].join("\n");

/**
 * 每轮 wait 引导里的「shell + curl 怎么跑」段——chat + task 字符级共用（含本次 url）。
 *
 * chat-mcp buildShellWaitGuidance 的 chat / task 两个分支都用。只讲「跑哪条 curl + 别画蛇添足」、
 * 不重复 waitDisciplineSection 的纪律（dial back：每轮注入的文本最该短）。
 */
export const shellCurlRunSection = (url: string): string =>
  [
    "调 `shell` 跑这条 curl、并给它一个**很长的前台阻塞时长**让它前台挂住实时等用户（正常前台调用、**别**自己加 `&` / `nohup` / `disown`、**别**主动标 background）：",
    "",
    "```",
    `curl -sN "${url}"`,
    "```",
    "",
    "- 调 shell 时**除 `command` 外、把「前台阻塞时长」参数设成 `86400000`（24 小时、毫秒）**——这参数你的 shell 工具里可能叫 `timeout`、也可能叫 `block_until_ms`（用你 schema 里实际有的那个、值都填 86400000）。它指「转后台前在前台最多等多久」、**不是**给 curl 的超时。设大它、curl 才会前台挂住等用户、不会几秒就被转后台。",
    "- `-s` 静默、`-N` 不缓冲（KEEPALIVE / 终态行实时可见）；本地回环长链接、不会断、**别**给 curl 加 `--max-time`、**别**套 while 重连。",
    "- 用户回复时、`[USER_REPLY]` + 正文直接出现在**这次 shell 的 stdout 里**、直接读即可。万一它仍被转入后台、stdout 只剩 `[USER_REPLY]` 标记没正文、这时才去 read 那个 terminal 文件取正文。",
  ].join("\n");

/**
 * chat 起手 prompt 里的「怎么和用户对话」段（chat-runner buildInitialPrompt 用）。
 *
 * 把 chat 专属的循环 / 信号 / 收尾 / ask_user 禁用讲清楚**一次**、纪律部分内联共用片段、
 * 后续每轮 chatShellWaitGuideBody 只给精简提醒、不再重复整套。
 */
export const chatWaitProtocolSection = (taskId: string): string =>
  [
    "## 怎么和用户对话（核心机制）",
    "",
    "你是**长期在线**的对话 agent。每一轮：**（要查先查清楚）→ 把答案写成一条正文发出 → 调 `wait_for_user` → 安静等下一条 → 再下一轮**、无限循环。守住这个循环是你唯一要做的事。",
    "",
    "几个关键：",
    "- 用户只看得到你发的**正文**（看不到你的思考 / 工具调用）。所以「答案」就是写出来的那条正文——只调了工具、或只说「我先查…我先写…」而正文没东西 = 用户那边一片空白、不算回答。要查的先查清楚、要写的真的写出来、再发。",
    `- 正文发出后、才调 \`wait_for_user(task_id="${taskId}")\`（用户看不到这步、别预告别解释）；它返回一段带 curl 的引导、调 \`shell\` 跑那条 curl 挂着等。`,
    "- curl 输出 `[USER_REPLY] <文本>` = 用户回了 → 回到第一步（再查 / 再答 / 再挂等）；`[CANCELLED]` = 收尾退出。",
    "",
    waitDisciplineSection(),
    "",
    "想跟用户确认什么、**直接发一段话问**（别调 `ask_user`、那是 task 模式的、chat 里禁用）。",
  ].join("\n");

/**
 * 每轮 wait_for_user 返回的 shell 引导正文（chat 版、chat-mcp buildShellWaitGuidance 的 chat 分支用）。
 *
 * 起手 prompt 已用 chatWaitProtocolSection 讲全纪律、这里只给「补全答案 + 跑 curl + 信号速查」、
 * 纪律不再整套重复（dial back）、只留一句 anti-loop 误报兜底。
 */
export const chatShellWaitGuideBody = (url: string): string =>
  [
    "先确认：用户本轮要的东西、**已经写成一条正文发出去了吗？** 只调了工具 / 跑了脚本、或只说「我先…」而正文没东西 = 用户看到的是空白——是的话先补一条带内容的正文、再跑下面的 curl。",
    "",
    shellCurlRunSection(url),
    "",
    "stdout：",
    "- `[KEEPALIVE ts=...]` 每 60 秒一行 = 心跳、忽略。",
    "- `[USER_REPLY] <文本>` = 新一轮消息 → 先处理它（要查先查、要写就写出来）→ 把答案写成一条正文发出 → **再调 `wait_for_user` 重新挂等**。哪怕用户只说「好的 / 谢谢」、或你回复里反问了用户、也回一句再挂等、回答完绝不结束 run。",
    "- `[CANCELLED]` = 收尾结束 run。",
    "- 若提示「重复调用 / 循环」= 误报、忽略继续等。",
  ].join("\n");

/**
 * 「回答完用户要的内容后、必调 wait_for_user」单一源提醒（recency 钉子）。
 *
 * 钉子钉两个最易翻的点、且这是 agent「调 wait 之前」唯一能拦住的位置：
 *   ① 先写成品（治「只预告『我这就写』、没写成品就挂等」——实测 composer-2.5 懒重启首轮就这么翻）
 *   ② 再调 wait_for_user（治漏调——漏调 = run 结束 = 破坏单 run）
 * 为什么顺序提醒必须在钉子（recency 最强）、不能只靠每轮 wait 返回的引导（chatShellWaitGuideBody
 * 也讲「先确认正文发了」）：agent 看到那条时已经调了 wait_for_user、在挂等流程里、太晚——实测它
 * 「意识到顺序有误」却还是 curl 挂等了、没回头补写。
 * 钉在「离用户消息最近、agent 下一步就是回复」的位置——模型不缺理解、缺眼前的执行提醒。
 *
 * 分首轮 / 续接两个变体（V0.8.21、对症「首轮冷启动最易漏挂等」——线上 opus 首轮答完没调
 * wait_for_user、run 直接 finished 退出、第二轮起才正常）：
 *   - replyThenWaitReminder（续接版、单句精简）：chat-mcp CHAT_REPLY_REMINDER 钉每轮用户回复尾部。
 *     续接轮 agent 刚从 wait_for_user 返回、挂等惯性还在、单句够。
 *   - firstTurnReplyThenWaitReminder（首轮版、动作序列）：chat-runner buildOpeningStanceSection
 *     末尾用（冷启动 / 切模型懒重启首轮）。首轮 agent 无挂等惯性、且钉子被前面 rules/skills 稀释、
 *     把「答完 → 挂等」讲成不可拆的两步收尾 + 点明漏第二步的后果（run 结束、对话中断）。
 * 注意：dial back、不堆 🚨（见文件顶部设计原则）——首轮版也只是「动作序列 + why」、不是加强威胁。
 */
export const replyThenWaitReminder = (): string =>
  "在回答完用户要的内容后，必须调用 `wait_for_user` 工具等待反馈结果。";

/**
 * 首轮专用强版钉子（见 replyThenWaitReminder 注释里的变体说明）。
 * 把「答完 → 挂等」讲成不可拆的两步收尾动作序列、并点明漏第二步的后果（run 结束、对话中断）。
 */
export const firstTurnReplyThenWaitReminder = (): string =>
  "这是你启动后的第一轮、也最容易漏挂等：先把答案写成正文发出 → 紧接着调 `wait_for_user` 挂等下一条。这两步是一轮的完整收尾、缺第二步 run 会就此结束、对话中断。";
