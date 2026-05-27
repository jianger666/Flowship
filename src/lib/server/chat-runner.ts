/**
 * Chat 模式 runner
 *
 * 架构（重要）：
 *   - 启动 / 推送拆开：本文件管 agent 生命周期 + 内部 publish。
 *     SSE 推送由 watch-chat 路由 subscribe 拿增量。两边解耦：
 *       - 启动：POST /api/tasks/[id]/chat-reply（V0.4 起合并、终态发消息时自动启动）
 *       - 订阅：GET  /api/tasks/[id]/watch-chat → SSE 流（先 replay 历史、再推增量）
 *     这样刷新页面不会断 agent、订阅可以多份（多 tab 看同一任务都行）。
 *     原 /start-chat 路由已删（V0.4）、启动职责合到 /chat-reply 里。
 *
 * 主要职责：
 * 1. 整个对话是同一个 SDK Run、agent 用 wait_for_user MCP 工具阻塞等用户下一句
 * 2. 我们把 HTTP MCP（指向 /api/mcp/chat-tool）塞进 mcpServers 里
 * 3. 没有 artifact、所有产出都进 events.jsonl
 * 4. wait_for_user 工具会触发 task.status 切换：
 *    - 进 awaiting_user：chat-mcp 通过 setChatAwaitingNotifier 回调通知本文件、本文件 patch 状态
 *      （不再写 feedback_request 事件——assistant_message 已表达"agent 说完了"、UI 看 task.status 即可）
 *    - 用户回复后切回 running：由 chat-reply 路由 patch
 * 5. 任意状态变化都通过 publish() 广播给所有订阅者
 *
 * 状态都挂 globalThis（next.js dev chunk 分裂问题之前踩过坑）。
 *
 * V0.3.5：保活机制从 wait_for_user + keep_alive_a/b/c 轮转重构为 shell + curl long-poll
 * （详见 chat-mcp.ts 顶部注释）。本文件 buildInitialPrompt 必须跟 plan-runner 的
 * super-prompt 协议描述保持一致、否则 agent 拿到 wait_for_user 返回的 SHELL_WAIT_GUIDE
 * 时会困惑：「我是该轮转 keep_alive 还是该调 shell」。
 *
 * 不做：
 * - chat→plan 升级（V1 不做）
 * - token 级 delta（事件粒度够）
 * - 断点续跑（agent 挂了就 failed、需要用户手动重启）
 */

import { Agent } from "@cursor/sdk";
import type { McpServerConfig, ModelSelection, SDKMessage } from "@cursor/sdk";

import {
  appendEvent,
  getEventsLogPath,
  patchPhase,
} from "./task-fs";
import {
  cancelPending,
  getChatMcpUrl,
  setChatAwaitingNotifier,
} from "./chat-mcp";
import { renderContextDocsSection } from "./context-docs-prompt";
// V0.5.9：多仓 cwd helper
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import {
  loadSkills,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import type { Task, TaskEvent } from "@/lib/types";

// ----------------- 配置 -----------------

// chat 不主动超时（只要不是 SDK 自己崩、就一直挂着等用户）
// 这里给一个非常大的兜底（24h）、防止 process 永不退出
const CHAT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-tool MCP server 在 mcpServers 里的注册名（agent prompt 里得点明）
const CHAT_TOOL_MCP_NAME = "feAiFlowChat";

// ----------------- 内部 prompt -----------------

// V0.3.5 起 chat 模式跟 plan 模式走同款保活机制：shell + curl long-poll
//
// 历史：V0.3-A 用 wait_for_user + keep_alive_a/b/c 轮转、5-6 分钟必踩 Cursor anti-loop
// 退 run。V0.3.5 重构成 shell + curl 长连接、agent 拿到 wait_for_user 返回的 shell
// 引导后调 shell 工具跑 curl 命令、跟服务端 /wait-ack 建一条长 HTTP 连接、用户回复
// 时服务端 resolve promise + 关流 → curl exit → agent 推进。
//
// Skills（harness 思路）：附件处理 / 历史上下文恢复等场景化能力放在 skills/<name>/SKILL.md、
// prompt 末尾列 skill index、agent 自行用 `read` 工具拿完整指令。
/**
 * V0.4 自由化：用户发首条消息时同时启动 agent
 *
 * 这个对象表示「用户已经发了的首条消息」、buildInitialPrompt 会把它直接拼进 prompt、
 * agent 第一次说话就是回答这条消息、不需要走「调 wait_for_user → shell + curl」绕一圈。
 *
 * 为什么不走 pendingFirstMessage 队列绕一圈：
 *   1. 体验差：UI 会先短暂切到 awaiting_user（wait_for_user 进来）、输入框变可用、误导
 *   2. agent 起手 emit 一句「正在调用 wait_for_user 等你」之类废话（即使 prompt 严禁也压不住）
 *   3. agent 多走两轮 tool call（wait_for_user + shell）才能拿到用户消息、慢
 * 直接塞 prompt 一步到位、agent 第一次 turn 就是回答。
 */
interface InitialUserMessage {
  text: string;
  imagePaths?: string[];
  attachmentPaths?: string[];
}

const buildInitialPrompt = (
  task: Task,
  skills: SkillEntry[],
  firstMessage?: InitialUserMessage,
): string => {
  const eventsLogPath = getEventsLogPath(task.id);

  return [
    "你正在 fe-ai-flow 的 Chat 任务里跑。整段对话被设计为同一个 SDK Run（计费一次跑到底）、agent 长存活、",
    "通过 `wait_for_user` MCP 工具阻塞等用户下一条消息、收到后接着说、再 wait、循环往复直到用户取消。",
    "",
    "## 核心机制：wait_for_user + shell long-poll（V0.3.5）",
    "",
    "fe-ai-flow 暴露 1 个核心 MCP 工具实现「等用户消息」：",
    "",
    "**`wait_for_user`**（每轮对话说完话后调 1 次、绝不重复调）",
    `  - 入参：\`task_id\` 字符串、固定值 \`${task.id}\`、不传别的参数`,
    "  - 立即返回 `[SHELL_WAIT_GUIDE token=xxx]` 文本、教你接下来调 `shell` 工具用 curl 跟 /wait-ack 路由建长连接等用户消息",
    "  - 不阻塞、不轮询、调一次就够",
    "",
    "## 标准等用户姿势：shell + curl long-poll（必背、anti-loop 的根治方案）",
    "",
    "拿到 `[SHELL_WAIT_GUIDE token=xxx]` 后下一步**只许**做：调 `shell` 工具执行 curl 命令（引导文本里有完整命令、复制粘贴跑）",
    "服务端 chunked stream 输出可能行：",
    "  - `[KEEPALIVE ts=<时间戳>]`：**60 秒一次的服务端心跳行、绝对忽略**。它的唯一意义是「连接还活着、用户还没操作」、看到再多 KEEPALIVE 都是正常的、shell **没卡**、绝对不要 summarize / 调 read 查 terminal / 重启 shell / 重新调 wait_for_user",
    "  - `[USER_REPLY]` + 文本：用户发了下一条消息（可能含附件路径）、shell 命令 exit 0、接着处理",
    "  - `[ASK_USER_REPLY]` + markdown Q&A：ask_user 弹窗的答案（详见下面 ask_user 段）",
    "  - `[CANCELLED]`：任务被取消、收尾结束 run",
    "  - `[STALE]` / `[INVALID_TOKEN]`：忽略本次返回",
    "",
    "## 钢铁纪律：等用户可能需要 0 秒到几小时、任何长度都正常",
    "",
    "shell + curl 是 long-poll、等用户在 UI 上发下一条消息。**等待期间你只看到 KEEPALIVE 行不断追加**、这是设计预期。",
    "",
    "**绝对禁止**（5/10/15/20 分钟没新终态行时尤其要克制）：",
    "  - ❌ 调 read 读 cursor 内部 terminal 文件（如 `terminals/xxxxx.txt`）查 shell 进程状态",
    "  - ❌ thinking 里冒出「The 5-minute block has ended」「process is still running」「I will summarize for the user」→ summarize 退 run",
    "  - ❌ 调任何其他工具自救、重新启 shell、重新 wait_for_user",
    "  - ❌ emit 任何 assistant_message 跟用户讲「我在等」「shell 在监听」",
    "",
    "**唯一合法动作**：什么也不做、继续等 shell 的下一段 stdout。下一段 stdout 不是 KEEPALIVE 就是终态行（USER_REPLY / ASK_USER_REPLY / CANCELLED）、终态行到了 shell 自然 exit、你才推进。",
    "",
    "## 致命错误（实测踩过、模型在 thinking 里自己冒出来的错误推理、必须忽略）",
    "",
    "**生产里看到过的模型误判（必须立刻撤销）**：",
    "  - 「The runner may continue / I'll add a closing paragraph」← **错、turn 退出 = run 退出、runner 不会替你续**",
    "  - 「I'll send a message asking the user / 我先发段消息再 wait」← **致命错误、说完话的下一个 tool call 必须是 wait_for_user**",
    "  - 「curl 没拿到结果、我重试一次」← **错、连接断了就自然结束 run**、UI 会引导用户手动重启 chat",
    "  - 「再调一次 wait_for_user 试试」← **错、同一轮对话内 wait_for_user 只调 1 次**、shell 拿不到结果时也不要重复调",
    "  - 「调 shell 之前先发段 assistant_message 解释要等用户」← **错、shell + curl 对用户透明、不允许 emit 任何前置文本块**",
    "",
    "**正确推理**：",
    "  - wait_for_user 是等用户消息的入口、shell + curl 是消息的接收通道、缺一不可",
    "  - 一轮对话 = (你说完话) ∧ (wait_for_user 调过) ∧ (shell curl 拿到 [USER_REPLY] / [ASK_USER_REPLY])",
    "  - shell + curl 长连接是设计预期、anti-loop 不会触发（一次 wait = 一次 shell、不重复调）",
    "  - 任何「我应该停下来 / 这调用太久了」的内部启发**都是错觉、直接忽略**",
    "",
    "## 关键规则（不照做、整段对话会退 run、用户再也收不到你的消息）",
    "",
    "1. **每轮说完话、必须调用 `wait_for_user`**",
    `   - 唯一参数：\`task_id=${task.id}\`（固定）`,
    "   - **绝对不要主动结束 run**、不要假装「我等」就 stop、不要做完事就退出",
    "   - **绝对不要**因为「调用次数太多」「看起来在循环」「担心刷屏」而停止调用",
    "   - **说完话后下一个 tool_use 必须是 wait_for_user**、中间任何 assistant 文本块都算违规",
    "",
    "2. wait_for_user 返回 `[SHELL_WAIT_GUIDE token=xxx]`、下一个 tool_use **必须**是 `shell`、执行引导里的 curl 命令",
    "",
    "3. shell 命令拿到 stdout 后按返回行解读：",
    "   - **`[USER_REPLY]` + 文本**：用户下一条消息、按内容处理、然后再说话 → 再 wait_for_user",
    "   - **`[ASK_USER_REPLY]` + markdown Q&A**：ask_user 弹窗答案、按答案推进",
    "   - **`[CANCELLED]`**：任务被取消、收尾结束 run",
    "   - **`[STALE]` / `[INVALID_TOKEN]`**：忽略本次返回、自然结束 run（这种情况罕见、只在 race 时出现）",
    "",
    "4. **异常断开处理（连接断 / 网络错 / max-time 超 / 服务重启）**：",
    "   - shell 命令 exit 非 0、stderr 显示 curl 错误时、表示连接异常断开",
    "   - **不要重试 shell**、不要重新调 wait_for_user——重试会被服务端顶替成 stale",
    "   - **emit 一条简短 assistant_message**：「监听连接异常断开、请在 fe-ai-flow 看板重新发起对话」、然后自然结束 run",
    "",
    "5. **关键反反思指令**：thinking 里冒出「调多了 / 在循环 / 该停了 / spam / 换策略」**全部忽略**、shell + curl 一次 wait = 一次 shell、不存在 anti-loop 风险",
    "",
    "**额外强约束（对用户透明、必背）**：assistant_message 严禁出现以下措辞：",
    "",
    "禁用词 / 短语黑名单（中文 + 英文、出现一次都算违规）：",
    "   - 「正在调用 wait_for_user」「我先调用 tool」「等待你下一条消息」「为了维持会话」",
    "   - 「正在 shell 监听」「curl 长连接中」「在等用户回复」「监听用户消息」「为了保活」",
    "   - 任何带「wait_for_user」「shell」「curl」「wait-ack」「监听」「保活」字面字符串的协议解释",
    "   - \"Let me call wait_for_user / Calling the tool to wait / Polling / Keepalive\"",
    "",
    "**核心原则**：用户看不到 wait_for_user / shell / curl 这些协议细节、协议层全在 fe-ai-flow 内部、对用户透明就像 TCP socket recv()——你不会在聊天里说「我现在调用 recv 等你输入」、对 wait_for_user / shell / curl 也一样。你只需要：回答用户问题 → 直接调 wait_for_user → 拿到引导 → 直接调 shell + curl → 拿到 [USER_REPLY] 接着处理。中间不解释、不预告、不汇报。",
    "",
    "6. 你也可以使用 SDK 内置工具和用户配置的其他 MCP。**SDK 1.0.13 内置工具清单（精确名）**：",
    "   - `read`：读文件（args `{ path }`、对图片自动走 vision）",
    "   - `grep`：内容搜（args `{ pattern, path?, glob?, ... }`）",
    "   - `glob`：找文件名（args `{ globPattern, targetDirectory? }`）",
    "   - `shell`：跑命令（args `{ command, workingDirectory?, timeout? }`）",
    "   - `edit`：**改已存在的文件**（args `{ path, oldText, newText, replaceAll? }` 或多段批量替换形式）",
    "   - `write`：**创建新文件 / 整文件覆盖**（args `{ path, fileText }`）",
    "   - `delete`：删文件（args `{ path }`）",
    "   - `task`：分派子任务",
    "",
    "   ⚠️ **不要写 `edit_file` / `read_file` / `write_file` 这些带 `_file` 后缀的名字**——SDK 1.0.13 没有这些工具、调用会失败。**创建不存在的文件用 `write`、不要用 `edit`**（edit 没 oldText 可改、会拒）。",
    "",
    "## 每轮对话完成时的标准动作（背下来、必须按这个顺序）",
    "",
    "1. 回答用户的问题 / 完成用户要的操作（用 SDK 内置工具 / MCP）",
    "2. emit 一段 assistant_message 回应用户（**不含**任何协议元叙述）",
    "3. **沉默地** 调用一次 `wait_for_user(task_id)`（不要 assistant_message 解释）",
    "4. 立即拿到 `[SHELL_WAIT_GUIDE token=xxx]` 返回、**沉默地**调 `shell` 跑引导里的 curl 命令",
    "5. shell stdout 返回时按内容走分支（见上「关键规则 3」）",
    "6. **不要 assistant_message 自言自语「等你回复中」/「我在监听」/「shell 在跑」之类**",
    "",
    "## ask_user：chat 模式禁用（V0.5.6.1 用户拍板）",
    "",
    "**chat（自由聊天）任务里不要调 `ask_user` 工具**——chat 本质就是 talk、",
    "有不确定项 / 想跟用户确认时**直接发一段 assistant_message 问就行**、用户在输入框答你。",
    "",
    "为什么 chat 禁用 ask_user（背景给你、避免想偏）：",
    "  - chat 模式没有 artifact、ask_user 弹窗的「内联留痕到产物里」这个核心价值兑现不了",
    "  - chat 已经是同步逐句对话、再拆出弹窗 + A/B/C/D 选项是过度结构化、对用户是干扰",
    "  - 用户原话拍板：「自由 chat 模式下不用提问、直接回答、自由模式就是 talk 而已」",
    "",
    "**chat 模式里 agent 想确认时的标准动作**：",
    "  1. 直接 emit 一段 assistant_message、把多个不确定点用 markdown 自然语言列清楚（带具体 A/B/C 选项也行、但走文本不走弹窗）",
    "  2. 调 wait_for_user 等用户在输入框回",
    "  3. shell stdout 拿到 `[USER_REPLY]` 后按用户答案推进",
    "",
    "`ask_user` 工具仅用于 plan / build / review 这种有 artifact 的结构化产物——chat 任务里碰到它直接当不存在。",
    "",
    "## Skills（fe-ai-flow 自带能力扩展）",
    "",
    "下面是可用 skill 的 index、命中场景时用 SDK 内置 `read` 工具读取对应 SKILL.md 拿完整指令：",
    "",
    renderSkillsForPrompt(skills),
    "",
    "调用规则：",
    "   - skill 触发是判断性的、不是每轮都读、按描述匹配场景再读",
    "   - 同一段对话内同一个 skill 通常读一次就够、内容已经在你 context 里",
    "   - skill 文件可能引用其他文件（如 events.jsonl 绝对路径）、跟着读即可",
    "",
    // V0.5.9：多仓时 cwd 是公共父目录、不是单 repoPath
    `## 任务 cwd（agent shell / read 默认基准目录）：${formatRepoSectionForPrompt(task.repoPaths)}`,
    "",
    "## 任务事件日志（按需读、`chat-history-recovery` skill 详述）",
    "",
    `  \`${eventsLogPath}\``,
    "",
    renderContextDocsSection(
      task,
      "→ 用户没传上下文文档、按对话内容判断要不要主动调 MCP / read / grep 摸资料。",
    ),
    "",
    ...buildOpeningStanceSection(task, firstMessage),
  ].join("\n");
};

/**
 * 「起手姿势」段：根据有没有首条用户消息分两种姿势
 *
 * - 有首条（V0.4 自由化主路径、99% 场景）：直接回答用户首条、答完调 wait_for_user
 * - 没首条（极少数边界情况、比如 resume run 或外部触发）：先 wait_for_user 等用户说话
 */
const buildOpeningStanceSection = (
  task: Task,
  firstMessage: InitialUserMessage | undefined,
): string[] => {
  if (firstMessage) {
    // 主路径：用户已经在 UI 上发了首条、我们把它直接传给 agent
    const parts: string[] = [
      "## 起手姿势：用户已经发了首条消息、立刻回答",
      "",
      "**用户的首条消息（已 enqueue 给你处理、不要再调 wait_for_user 去等）**：",
      "",
      "```",
      firstMessage.text.length > 0 ? firstMessage.text : "(空文本、看下方附件)",
      "```",
      "",
    ];
    if (firstMessage.imagePaths && firstMessage.imagePaths.length > 0) {
      parts.push(
        "**用户附带的图片**（用 SDK 内置 `read` 工具读、自动走 vision）：",
        "",
        ...firstMessage.imagePaths.map((p) => `  - \`${p}\``),
        "",
      );
    }
    if (firstMessage.attachmentPaths && firstMessage.attachmentPaths.length > 0) {
      parts.push(
        "**用户附带的文件 / 目录**（用 `read` / `grep` / `glob` 按需读）：",
        "",
        ...firstMessage.attachmentPaths.map((p) => `  - \`${p}\``),
        "",
      );
    }
    parts.push(
      "**第一轮标准动作**：",
      "  1. 直接按用户消息内容处理、需要查资料 / 摸仓库就调 SDK 内置工具或 MCP",
      "  2. 处理完、emit assistant_message 回应用户（**不含**任何协议元叙述）",
      "  3. 回应完、**沉默地**调 `wait_for_user(task_id=" + task.id + ")` 等下一条消息",
      "  4. 之后进入「调 wait_for_user → shell + curl → 处理用户下一句」标准循环",
      "",
      "**绝对禁忌**：",
      "  - ❌ 起手就调 `wait_for_user`——用户消息已经在上方、不需要再等",
      "  - ❌ emit 任何「我收到你的消息了、正在处理」「正在调用 wait_for_user」之类协议元叙述",
      "  - ❌ 复述用户问题（「你问我 xxx」）——直接回答就行",
      "",
      "现在开始：第一个动作是按用户消息内容处理 / 回答、不要先调任何「等用户」类工具。",
    );
    return parts;
  }

  // 边界情况：没有 firstMessage（理论上 V0.4 chat 进 runChatSession 都会带、这里是兜底）
  return [
    "## 起手姿势（边界情况：没有预设首条消息）",
    "",
    "**整个 chat 任务从「等用户第一句」开始**——你**没有**初始问题、用户在 UI 里建任务时可能填了标题（如：`" +
      task.title +
      "`）、但这**仅作任务标识、不是消息正文**。**不要**把标题当成「用户的第一句话」来回答。",
    "",
    "**第一个动作必须是**：直接调 `wait_for_user(task_id)` 阻塞等用户发第一条消息、拿到 [SHELL_WAIT_GUIDE] → 调 shell 跑 curl → stdout 拿 `[USER_REPLY] <用户的真正首条消息>` → 然后才回答。",
    "",
    "**禁忌**：",
    "  - ❌ 起手就根据任务标题猜用户想问什么、自顾自说一段「关于 xxx、我可以…」",
    "  - ❌ 起手就发 assistant_message 说「你好、请告诉我…」（这种欢迎语没必要、UI 直接显示输入框就够）",
    "  - ❌ 起手就调 read / grep 之类的工具去摸仓库——用户还没说要做什么、你瞎摸毫无价值",
    "",
    "**正确顺序**：",
    "  1. 起手什么都不做、立刻调 `wait_for_user(task_id=" + task.id + ")`",
    "  2. 拿到 [SHELL_WAIT_GUIDE]、立刻调 shell 跑 curl 命令",
    "  3. shell stdout 拿到 `[USER_REPLY] <消息>` → 这才是用户真正想聊的、按内容判断要不要读 skill / 摸仓库 / 直接答",
    "  4. 处理完、emit assistant_message 回应（**不含**任何协议元叙述）",
    "  5. 回到「调 wait_for_user → shell + curl → 等下一句」循环",
    "",
    "现在开始：第一个动作就是调 `wait_for_user(task_id=" +
      task.id +
      ")`、不要在调用之前 emit 任何 assistant_message。",
  ];
};

// ----------------- 工具：截断 -----------------

const truncate = (s: string, max = 500): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(truncated ${s.length - max} chars)`;

const stringifyMeta = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// ----------------- 流事件类型（publish/subscribe 协议） -----------------

// 任意订阅者（watch-chat SSE handler）能收到的事件
//
// assistant_delta（V1.x 加）：流式打字效果用
//   - SDK 流式推 assistant chunk 时、runner 除了往 buffer 累、还额外 publish 一个 delta
//   - **不写 events.jsonl**（delta 是临时数据、整段 flush 后会有正式 assistant_message 事件）
//   - 前端拼接 streamingText state、收到 event(assistant_message) 时清空（被正式事件取代）
//   - 这样实现「事件流不刷屏（一段回复 = 一条事件）+ UI 实时流式」两个目标
export type ChatStreamEvent =
  | { kind: "event"; event: TaskEvent }
  | { kind: "task"; task: Task }
  | { kind: "done"; task: Task; ok: boolean }
  | { kind: "error"; message: string }
  | { kind: "assistant_delta"; text: string };

export type ChatStreamListener = (ev: ChatStreamEvent) => void;

// ----------------- 进程全局状态（挂 globalThis） -----------------
//
// 跟 chat-mcp.ts 同款：next.js dev 不同 route handler 拿到不同 module 实例、
// 模块级 Map 会分裂、必须挂 globalThis。

interface RunningRecord {
  cancel: () => void;
}

interface ChatRunnerGlobalState {
  // 进程级运行表：taskId → 控制对象（cancel 用）
  runningChats: Map<string, RunningRecord>;
  // taskId → 订阅者集合（watch-chat 路由 subscribe 进来的）
  subscribers: Map<string, Set<ChatStreamListener>>;
}

// V1：2026-05-15 加版本号后缀作防御；后续改 runner 内部 state 字段结构时 bump 版本号
// 避免 dev hot reload 拿到旧版残留字段、跟 chat-mcp.ts GLOBAL_KEY 同款套路
const RUNNER_GLOBAL_KEY = "__feAiFlowChatRunnerStateV1__";

const getRunnerState = (): ChatRunnerGlobalState => {
  const g = globalThis as unknown as Record<string, ChatRunnerGlobalState>;
  if (!g[RUNNER_GLOBAL_KEY]) {
    g[RUNNER_GLOBAL_KEY] = {
      runningChats: new Map(),
      subscribers: new Map(),
    };
  }
  return g[RUNNER_GLOBAL_KEY];
};

const runningChats = getRunnerState().runningChats;
const subscribers = getRunnerState().subscribers;

// ----------------- publish / subscribe -----------------

/**
 * 给某个 task 推一个流事件、所有订阅者都能收到。
 *
 * - 同步触发、listener 报错被吞、不影响其他订阅者
 * - 没订阅者就静默丢、agent 不会因此挂
 */
const publish = (taskId: string, ev: ChatStreamEvent): void => {
  const set = subscribers.get(taskId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(ev);
    } catch (err) {
      console.error("[chat-runner] subscriber listener threw:", err);
    }
  }
};

/**
 * 给外部模块用的 publish（比如 chat-reply 路由检测到僵尸任务时、
 * 当场标 failed + 写 error 事件后、需要主动通知所有 SSE 订阅者）。
 *
 * 调用方负责确保 event 内容真实、本函数不 dedup、不持久化。
 */
export const publishChatStreamEvent = (
  taskId: string,
  ev: ChatStreamEvent,
): void => publish(taskId, ev);

/**
 * 订阅某个 task 的实时流事件。
 *
 * 注意：只接「订阅之后产生的增量事件」。订阅者要看历史得自己读 events.jsonl。
 * 返回 unsubscribe 函数、调用方 finally 里调一下。
 */
export const subscribeChatStream = (
  taskId: string,
  listener: ChatStreamListener,
): (() => void) => {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(listener);
  return () => {
    const cur = subscribers.get(taskId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) subscribers.delete(taskId);
  };
};

// ----------------- 入参 -----------------

export interface RunChatInput {
  task: Task;
  apiKey: string;
  model: ModelSelection;
  // 用户在设置页配的 MCP servers（已解析）
  // chat-tool 是我们自己塞进去的、不需要用户配
  userMcpServers?: Record<string, McpServerConfig>;
  // V0.4 自由化：用户在 UI 上发的首条消息（terminal status 触发自动启动场景）
  // 有则会拼进 initialPrompt、agent 第一次 turn 就回答这条、不需要 wait_for_user 等
  // 无则走旧路径：agent 起手 wait_for_user 等用户消息（极少数边界场景）
  firstMessage?: {
    text: string;
    imagePaths?: string[];
    attachmentPaths?: string[];
  };
}

// ----------------- 持久化 + publish 一体 -----------------

const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<Task | null> => {
  const updated = await appendEvent(taskId, ev);
  if (updated) {
    const last = updated.events[updated.events.length - 1];
    if (last) publish(taskId, { kind: "event", event: last });
  }
  return updated;
};

export const isChatRunning = (taskId: string): boolean =>
  runningChats.has(taskId);

export const cancelChat = (taskId: string): boolean => {
  const rec = runningChats.get(taskId);
  if (!rec) return false;
  rec.cancel();
  return true;
};

/**
 * 启动一个 chat agent run（fire-and-forget 风格）。
 *
 * 返回 Promise 在 agent 终止时（成功 / 失败 / 取消）才 resolve、
 * **调用方一般不要 await 它**——立刻返回 HTTP、让 agent 在后台跑。
 *
 * 已在跑就直接 return（不报错、幂等）。
 *
 * 进度通过 publish() 广播给所有订阅者（watch-chat SSE）。
 */
export const runChatSession = async (input: RunChatInput): Promise<void> => {
  const { task, apiKey, model, userMcpServers, firstMessage } = input;

  // 已经在跑 → 直接 return（幂等、调用方不需要 catch）
  if (runningChats.has(task.id)) {
    return;
  }

  // 1) 切到 running
  const startedTask = await patchPhase(task.id, {
    taskStatus: "running",
  });
  if (startedTask) publish(task.id, { kind: "task", task: startedTask });

  // 2) 拼 mcpServers：用户的 + 我们自己的 chat-tool
  // 用户配置里万一也叫 feAiFlowChat、按我们的为准（直接覆盖）
  const mergedMcp: Record<string, McpServerConfig> = {
    ...(userMcpServers ?? {}),
    [CHAT_TOOL_MCP_NAME]: {
      type: "http",
      url: getChatMcpUrl(),
    },
  };

  const userMcpNames = Object.keys(userMcpServers ?? {}).filter(
    (n) => n !== CHAT_TOOL_MCP_NAME,
  );
  const mcpDesc = `Chat MCP: ${CHAT_TOOL_MCP_NAME}${
    userMcpNames.length > 0 ? ` + 用户 MCP: ${userMcpNames.join(", ")}` : ""
  }`;

  await writeEventAndPublish(task.id, {
    kind: "info",
    text: `Chat 任务启动（model: ${model.id}、${mcpDesc}）`,
  });

  // 3) 注入 chat awaiting notifier
  // 处理两类信号：
  //   - awaiting_start：wait_for_user 进入"全新一段等待"、切 task.status=awaiting_user
  //     不写 events.jsonl（assistant_message 已经表达"agent 说完了"、UI 看 task.status 即可）
  //   - ask_user_request：agent 调 ask_user 提问、写一条 ask_user_request 事件给 UI 渲染卡片
  setChatAwaitingNotifier(task.id, async (signal) => {
    if (signal.kind === "ask_user_request") {
      // V0.3.2 一次打包多问题、modal 弹窗
      // text 是「N 个问题预览」、给 inline 回放卡片用、真问题数组放 meta.questions
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      const reqTask = await appendEvent(task.id, {
        kind: "ask_user_request",
        text: previewText,
        meta: {
          askId: signal.askId,
          token: signal.token,
          questions: signal.questions,
        },
      });
      if (reqTask) {
        const lastEv = reqTask.events[reqTask.events.length - 1];
        if (lastEv) publish(task.id, { kind: "event", event: lastEv });
      }
      const updated = await patchPhase(task.id, {
        taskStatus: "awaiting_user",
      });
      if (updated) publish(task.id, { kind: "task", task: updated });
      return;
    }
    // awaiting_start：仅切 status、不写事件
    const updated = await patchPhase(task.id, {
      taskStatus: "awaiting_user",
    });
    if (updated) publish(task.id, { kind: "task", task: updated });
  });

  // 4) 启动 agent + 流式消费
  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;

  try {
    agent = await Agent.create({
      apiKey,
      model,
      // V0.5.9：cwd = effective（单仓 = 仓自身、多仓 = 公共父目录）
      local: { cwd: getEffectiveCwd(task.repoPaths) },
      mcpServers: mergedMcp,
    });

    // 加载 fe-ai-flow 自带 skills（+ 仓库自定义 skill 如有）、塞进初始 prompt
    //
    // 为什么不在 buildInitialPrompt 里直接加载：那是个同步函数、loadSkills 要读文件系统、
    // 拆开能避免 buildInitialPrompt 整体变 async（保持 prompt 构造的纯粹性、方便测试）。
    // V0.5.9：skills 按 effective cwd 扫（单仓 / 多仓父目录、跨仓 skill 后续真踩到再细化）
    const skills = await loadSkills(getEffectiveCwd(task.repoPaths)).catch((err) => {
      console.error("[chat-runner] loadSkills failed", err);
      return [];
    });
    const initialPrompt = buildInitialPrompt(task, skills, firstMessage);
    const run = await agent.send(initialPrompt);

    // 注册 cancel 控制
    runningChats.set(task.id, {
      cancel: () => {
        cancelled = true;
        cancelPending(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
      },
    });

    // 兜底硬超时：24h、防止 process 永远挂着
    hardTimer = setTimeout(() => {
      cancelled = true;
      cancelPending(task.id);
      void run.cancel().catch(() => {
        /* noop */
      });
    }, CHAT_HARD_TIMEOUT_MS);

    // 流式消费
    // 用一个 buffer 累积 assistant text、遇到非 assistant 消息（thinking / tool_call）
    // 或 run 结束时再 flush 成一条 assistant_message 事件
    // 这样一轮 agent 完整回复 → 一条事件、UI 不会出现「我」「在」「想」这种碎片
    const assistantCtx: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {
        const trimmed = assistantCtx.buffer.trim();
        assistantCtx.buffer = "";
        if (trimmed.length === 0) return;
        await writeEventAndPublish(task.id, {
          kind: "assistant_message",
          text: trimmed,
        });
      },
    };

    for await (const msg of run.stream()) {
      await handleChatSdkMessage(task.id, msg, assistantCtx);
    }

    // 流结束、最后一段 assistant text 也要 flush
    await assistantCtx.flush();

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    // 拿终态
    const result = await run.wait();

    if (cancelled || result.status === "cancelled") {
      // 用户主动取消
      const cancelledTask = await patchPhase(task.id, {
        taskStatus: "completed",
      });
      if (cancelledTask)
        publish(task.id, { kind: "task", task: cancelledTask });
      const done = await writeEventAndPublish(task.id, {
        kind: "info",
        text: "Chat 任务已被取消、对话结束",
      });
      publish(task.id, { kind: "done", task: done ?? task, ok: true });
      return;
    }

    if (result.status !== "finished") {
      // SDK status=ERROR/EXPIRED 的 message 通过 stream 推、被 ctx 接住、这里拼上方便诊断
      const sdkErr = assistantCtx.sdkErrorMessage
        ? `\n--- SDK stream error message ---\n${assistantCtx.sdkErrorMessage}`
        : "";
      throw new Error(
        `agent run status=${result.status}${
          result.result ? `: ${result.result.slice(0, 200)}` : ""
        }${sdkErr}`,
      );
    }

    const completedTask = await patchPhase(task.id, {
      taskStatus: "completed",
    });
    if (completedTask)
      publish(task.id, { kind: "task", task: completedTask });
    const done = await writeEventAndPublish(task.id, {
      kind: "info",
      text: "Chat 任务结束、agent 已正常退出",
    });
    publish(task.id, { kind: "done", task: done ?? task, ok: true });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat-runner] task=${task.id} failed:`, err);
    const failedTask = await patchPhase(task.id, { taskStatus: "failed" });
    if (failedTask) publish(task.id, { kind: "task", task: failedTask });
    const updated = await writeEventAndPublish(task.id, {
      kind: "error",
      text: `Chat 任务失败：${message}`,
    });
    publish(task.id, { kind: "done", task: updated ?? task, ok: false });
    publish(task.id, { kind: "error", message });
  } finally {
    // 清场
    runningChats.delete(task.id);
    cancelPending(task.id);
    setChatAwaitingNotifier(task.id, null);
    if (agent) {
      try {
        agent.close();
      } catch {
        /* noop */
      }
    }
  }
};

// ----------------- SDKMessage 翻译器 -----------------

// 累积 assistant text 的上下文
// SDK 把一段连贯回复切成多条 SDKAssistantMessage 流式发、
// 每条独立写事件 UI 上就成「逐字碎片」（实测出过这问题）
// 所以 runner 端做聚合：
//   - 遇 assistant 消息 → 累到 buffer
//   - 遇非 assistant 边界（thinking / tool_call） / run 结束 → flush 成一条 assistant_message
// 这样「一轮 agent 回复」= 一条事件、UI 就是连贯气泡
interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  // SDK 推过来的最近一条 status=ERROR/EXPIRED 的 message——
  // RunResult 类型没 error message 字段、只有这条 stream 消息能拿到具体原因、
  // 后续 throw 时把它拼到 Error 文案上方便诊断
  sdkErrorMessage?: string;
}

const handleChatSdkMessage = async (
  taskId: string,
  msg: SDKMessage,
  assistantCtx: AssistantBufferCtx,
): Promise<void> => {
  switch (msg.type) {
    case "thinking": {
      // 思考是 assistant text 的边界、先 flush 前面累的回复
      await assistantCtx.flush();
      await writeEventAndPublish(taskId, {
        kind: "thinking",
        text: msg.text,
        meta: msg.thinking_duration_ms
          ? { durationMs: msg.thinking_duration_ms }
          : undefined,
      });
      break;
    }

    case "tool_call": {
      // tool_call 也是 assistant text 边界、先 flush
      await assistantCtx.flush();
      // 注意：wait_for_user 是 chat 模式自家的「同步原语」、不是普通工具调用
      // task.status 切换由 chat-mcp 通过 setChatAwaitingNotifier 通知本文件、不在这里写
      // 也不写事件（assistant_message 已表达"agent 说完了"、UI 看 task.status 即可）
      //
      // SDK 把 MCP 工具调用聚合成 name="mcp"、args 里有 providerIdentifier + toolName
      // 既要兼容直接 name 的情况（万一未来 SDK 变）、也要拆 args 看 toolName
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      const isWaitForUser =
        msg.name === "wait_for_user" ||
        msg.name === "Wait For User" ||
        innerToolName === "wait_for_user" ||
        innerToolName === "Wait For User";

      if (isWaitForUser) {
        // status 维护：
        //   - 进入 awaiting_user：chat-mcp 通过 awaiting notifier 通知 chat-runner
        //   - 用户回复后切回 running：由 chat-reply 路由切
        //   - 这里 completed 啥也不做（V0.3.5 之前 keep_alive 高频 loop 会抖屏、现在 shell long-poll 没这个问题了、保持简单）
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `wait_for_user 工具调用失败：${truncate(resStr, 200)}`,
          });
        }
        break;
      }

      // 普通工具调用：跟 plan-runner 一致处理
      if (msg.status === "running") {
        const argsStr = stringifyMeta(msg.args);
        await writeEventAndPublish(taskId, {
          kind: "tool_call",
          text: `调用 ${msg.name}${argsStr ? `:${truncate(argsStr, 120)}` : ""}`,
          meta: {
            name: msg.name,
            args: argsStr ? truncate(argsStr) : undefined,
          },
        });
      } else if (msg.status === "error") {
        const resStr = stringifyMeta(msg.result);
        await writeEventAndPublish(taskId, {
          kind: "error",
          text: `工具调用失败 ${msg.name}：${truncate(resStr, 200)}`,
          meta: { name: msg.name, result: truncate(resStr) },
        });
      }
      break;
    }

    case "assistant": {
      // 不立刻写事件、累到 buffer、等到「下一个非 assistant 边界」或 run 结束再 flush
      // tool_use 块独立通过 tool_call 消息出现、这里只取 text 块
      let text = "";
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
      if (text.length > 0) {
        // 同一段累加：相邻 chunk 文本本身已带空白、不再额外加分隔
        assistantCtx.buffer += text;
        // 流式 publish：每个 chunk 来临时立即推 delta 给 SSE 订阅者
        // events.jsonl 不写（避免一段回复刷屏几十条事件）
        // 等 flush 时落聚合后整段 assistant_message 事件、UI 用 delta 拼出来的 streaming text 替换为正式事件
        publish(taskId, { kind: "assistant_delta", text });
      }
      break;
    }

    case "status": {
      // SDK 把服务端致命错误的具体描述放在 status 消息的 message 字段里、
      // 而 RunResult 类型只有 status / model / durationMs、不带 message——
      // 不在这里把 ERROR / EXPIRED 推出来、最后 throw 出去的报错就是空的、只能猜原因
      //
      // V0.5.15 增强（对齐 plan-runner V0.5.5 增强）：
      // 先 console.log 一份 raw status 消息（运维 / 用户排查用）、
      // 实测 SDK 1.0.13 status=error 时偶尔不发 status 流消息、run.wait() 拿到 error 就直接退、
      // 这条 log 能让用户在 dev server 终端看到「SDK 到底有没有给详细错误描述」
      console.log(
        `[chat-runner] SDK status message: status=${msg.status} message=${
          (msg as { message?: string }).message ?? "(none)"
        }`,
      );
      if (
        (msg.status === "ERROR" || msg.status === "EXPIRED") &&
        msg.message
      ) {
        assistantCtx.sdkErrorMessage = msg.message;
        await writeEventAndPublish(taskId, {
          kind: "error",
          text: `SDK ${msg.status}：${msg.message}`,
          meta: { sdkStatus: msg.status, sdkMessage: msg.message },
        });
      }
      break;
    }

    case "system":
    case "user":
    case "request":
    case "task":
    default:
      break;
  }
};
