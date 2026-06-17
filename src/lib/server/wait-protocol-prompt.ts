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
 * - **抽得动（waitDisciplineSection / shellCurlRunSection）**：等待期间的行为纪律 + 三个认知
 *   陷阱（turn 矛盾 / 回复完误判可收尾 / anti-loop 误报）+ 对用户透明 + curl 怎么跑。chat / task 一字一样。
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
 * 不含任何信号字面量（ACTION_ACK / USER_REPLY 等）、不涉及「怎么传参 / 起手做什么」、
 * 只讲 agent 在「shell curl 挂着等」期间该守的纪律 + 三个真实踩过的认知陷阱 + 对用户透明。
 * chat 起手（chatWaitProtocolSection）、_super.md（{{waitDiscipline}}）、chat-mcp 两个
 * 等待引导分支都引用同一份——这次卡死的根因（anti-loop / turn）就靠这一份治。
 */
export const waitDisciplineSection = (): string =>
  [
    "### 等待期间的纪律（这次卡死的根因都在这、务必读懂）",
    "",
    "shell curl 挂着等用户、可能 0 秒、也可能几小时——**任何长度都正常**。期间你只会看到 `[KEEPALIVE ts=...]` 每 60 秒刷一行（连接还活着的心跳、忽略它）。",
    "",
    "**还没看到「结果行」之前（结果行 = stdout 里那条非 `[KEEPALIVE]` 的标记行：chat 是 `[USER_REPLY]`、task 是 `[ACTION_ACK ...]` / `[NEXT_ACTION ...]`、外加各模式的终态行 `[CANCELLED]` 等）、唯一合法动作：什么都不做、安静等。** 别 read terminal 查进程、别 summarize 退出、别重新调 shell / wait_for_user、别 emit「我在等」之类的话——这些动作每一个都会真把等待打断。（拿到结果后怎么取正文、见上面 shell 引导的 stdout 规则。）",
    "",
    "#### 三个真实踩过的认知陷阱（必须记死）",
    "",
    "**陷阱一：「不调工具、我这一轮（turn）就结束了、得再做点什么」** —— 错。那条 curl 还挂着 = 你这一轮**还没结束**、你正处在「等 shell 返回」的合法状态。curl 本身就是维持这一轮的东西、它在跑、这轮就在继续。所以你**既不用**再调别的工具「续命」、turn 也**不会**因为你安静等着就结束。",
    "",
    "**陷阱二：「这一轮我答得很完整 / 解释了一大段 / 末尾还问了用户、感觉可以收尾、结束 run 了」** —— 错。不管这轮回复多完整、多长、有没有在问用户、回复完的下一个动作**永远是** `wait_for_user` 挂等。「答得够完整」「问了用户」都 ≠「能结束 run」——只有用户在 UI 触发的收尾信号（见下面信号解读）才结束 run。（最常翻的车：用户问「为啥要挂等」、你解释一大段、自己却忘了挂。）",
    "",
    "**陷阱三：Cursor 提示你「重复调用 / flagged as looping / 检测到循环」** —— 这是**误报**、忽略它。原因：万一那条长 curl 被转入后台、运行记录里会留下两条一模一样的 curl、Cursor 的通用循环检测看到两条相同调用就误判——但你**实际只调了一次**、这是 long-poll 等待的正常形态。看到它**别**去 read terminal、**别**重新调 shell、**别**总结一下就退出——继续安静等就对了。",
    "",
    "#### 对用户透明",
    "",
    "`wait_for_user` / `shell` / `curl` 是内部机制、用户看不到、你也**别在回复里提**（不说「我在等你」「正在监听」「为了保活」之类）——就像你不会跟用户解释 TCP 怎么收包一样。",
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
    "## 怎么和用户对话（核心机制、读懂就不会把对话弄断）",
    "",
    "> **铁律：每轮调 `wait_for_user` 之前、用户必须已经在对话框看到本轮的交付物（或一个可用分段）。计划、预告、「我先写…」、「我马上查…」、等待说明——都不是交付物。**",
    "",
    "你是**长期在线**的对话 agent。每一轮：**（要查就先查清楚）→ 把答案写成一条正文发出 → 调 `wait_for_user` → 安静等下一条 → 再下一轮**、无限循环。让这个循环转下去、是你唯一要守住的事。",
    "",
    "### 每一轮怎么做",
    "",
    "1. **先把这一轮要交付的东西真正做出来。** 要查代码 / 资料才能答的、先用 `grep` / `read` / `shell` 查清楚；要写文章 / 代码 / 方案的、就把它（或本轮该交付的一个可用分段）**真的写出来**。**只『宣告要做什么』而没把成品摆出来的话都是预告、不是回答**——不管是查询型的『正在检索 / 让我看看』、还是生成型的『我先写一篇 X、写完后再发 / 再等』。",
    "2. 把**这一轮的成品本身**（结果 / 代码 / 文章 / 方案 / 链接 / 结论）写成一条正文消息发出去——这条用户在对话框看得到的正文、才算「回答」。生成 / 回答型任务里、**做事 = 写这条正文、是同一条消息**、没有『先宣告、回头再产出』两步；`调完工具 / 跑完脚本 / 想完了 / 宣告了计划` 都 **≠** 回答（用户看不到工具调用、也看不到你的思考、只看得到你发的正文）。",
    `3. 正文发出去之后、才调 \`wait_for_user(task_id="${taskId}")\`（不解释、不预告、用户看不到这步）。`,
    "4. 它返回一段 `[SHELL_WAIT_GUIDE]` 引导、里面有条 curl 命令；调 `shell` 跑那条 curl——它会一直挂着等用户。",
    "5. curl 输出 `[USER_REPLY] <文本>` = 用户回了 → **回到第 1 步**（同样：要查先查、把答案写成正文、再 `wait_for_user` 挂等）；输出 `[CANCELLED]` = 收尾退出。",
    "",
    waitDisciplineSection(),
    "",
    "### 想跟用户确认时直接问",
    "",
    "有不确定 / 想确认的**直接发一段话问**（markdown 列清楚选项也行）、用户在输入框答你——**不要**调 `ask_user` 工具（那是 task 模式用的、chat 里禁用）。",
  ].join("\n");

/**
 * 每轮 wait_for_user 返回的 shell 引导正文（chat 版、chat-mcp buildShellWaitGuidance 的 chat 分支用）。
 *
 * 起手 prompt 已用 chatWaitProtocolSection 讲全纪律、这里只给「补全答案 + 跑 curl + 信号速查」、
 * 纪律不再整套重复（dial back）、只留一句 anti-loop 误报兜底。
 */
export const chatShellWaitGuideBody = (url: string): string =>
  [
    "先确认：用户要的本轮成品（结果 / 代码 / 文章 / 方案 / 链接 / 结论），**已经写进一条正文消息发出去了吗？** 只调了工具 / 跑了脚本 / 部署了东西、或只『宣告要做』（如「我先写…」）而正文里没成品 = 用户那边看到的就是**空白回复**（最常翻的车）——没发、或只发了半句概述 / 计划，现在就补一条带成品的完整正文、再跑下面的 curl。",
    "",
    shellCurlRunSection(url),
    "",
    "stdout 怎么读：",
    "- `[KEEPALIVE ts=...]` 每 60 秒一行 = 心跳、忽略它。",
    "- `[USER_REPLY] <文本>` = 用户发来新一轮消息：**先读懂并处理这条消息**（要查代码 / 资料就先查、要写 / 做就直接做出来）→ 把本轮成品（结果 / 代码 / 文章 / 方案 / 链接 / 结论）写成**一条正文消息**发出去（只『宣告要做』不算）→ **再调 `wait_for_user` 重新挂等**。别只因为看到 `[USER_REPLY]` 就直接再 wait。回答完绝不结束 run——哪怕用户只说「好的 / 谢谢」、或你回复里反问了用户，也照样回一句再挂等（只有 `[CANCELLED]` 才收尾、详见起手「认知陷阱」陷阱二）。",
    "- `[CANCELLED]` = 收尾结束 run。",
    "- 若 Cursor 提示「重复调用 / 循环」= 误报、忽略、继续等（详见起手「认知陷阱」段）。",
  ].join("\n");
