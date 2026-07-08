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
 * - 单一源：chat 起手（chatTurnProtocolSection）、task super prompt（{{waitDiscipline}} 占位、
 *   注入 turnDisciplineSection）各引一份、不再三处漂移
 */

/**
 * task 模式的「回合纪律」段（_super.md {{waitDiscipline}} 占位注入）。
 *
 * 讲清三件事：交卷 / 提问都是「调完工具就结束回复」；用户操作以新消息续达；
 * 别执行任何等待命令（旧协议肌肉记忆 / 网上教程的轮询套路都不要）。
 */
export const turnDisciplineSection = (): string =>
  [
    "### 回合纪律（怎么把控制权交回用户）",
    "",
    "你和用户之间是**多轮消息**：每一轮你干完该干的、调完该调的工具、就**正常结束本轮回复**（结束 turn）。用户的决定（通过 / 再聊聊 / 推进下一步 / 回答提问）会作为**新消息**发给你、你在同一会话里继续、上下文不丢。",
    "",
    "- 完成一个 action（写完 artifact）→ 调 `submit_work` 交卷 → **结束回复**",
    "- 有不确定项 → 调 `ask_user` 推弹窗 → **结束回复**（答案以 `[ASK_USER_REPLY]` 开头的新消息送达）",
    "- **不要执行任何等待 / 轮询命令**——curl 长轮询、sleep 循环、watch 都不要；调完工具直接结束回复就是正确姿势",
    "- 结束回复前不用输出总结（用户在看板看 timeline 就够）；交卷 / 提问是内部机制、别在正文里提",
  ].join("\n");

/**
 * chat 起手 prompt 里的「怎么和用户对话」段（chat-runner buildInitialPrompt 用）。
 *
 * V0.11：chat 就是正常多轮对话——把回复正文直接输出（实时流式显示）、说完自然结束回复、
 * 用户下一条消息会续接同一会话。没有任何等待工具 / 协议要遵守。
 */
export const chatTurnProtocolSection = (): string =>
  [
    "## 怎么和用户对话",
    "",
    "这是**正常的多轮对话**：用户发消息 → 你回答（正文直接输出、会一字一字实时显示给用户）→ **说完自然结束本轮回复** → 用户的下一条消息会续接同一会话、上下文不丢。",
    "",
    "几个关键：",
    "- **回复正文直接输出**——要查的先查清楚、要写的真写出来（让你写一整篇作文、就把整篇直接输出）。别只说「我先查…我先写…」就结束回复 = 没交付、用户看到的是一句空话。",
    "- **说完就正常结束回复**——不要执行任何等待 / 轮询命令（curl / sleep / watch 都不要）、不要调 `submit_work`（本模式用不到它）。",
    "- 想跟用户确认什么、**直接在正文里问**（markdown 列 A/B/C 选项也行、别调 `ask_user`、那是 task 模式的弹窗工具）。",
    "- 内部机制（工具名 / 协议）别在正文里提、直接给用户该看的内容。",
  ].join("\n");
