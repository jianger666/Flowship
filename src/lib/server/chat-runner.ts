/**
 * Chat runner（V0.6.0.1 重新引入、对齐 V0.5 自由对话体验）
 *
 * 跟 task-runner 完全独立：
 *   - 用户拍板「自由模式跟以前一样」、所以 chat 不再作为 action 类型
 *   - chat task（task.mode === "chat"）走自己的 prompt（无 _super.md 任务容器协议）
 *   - 自己的 runtime state（runningChats）、不跟 task-runner runningTasks 混
 *   - 复用 V0.6 chat-mcp（submitUserMessage / wait_for_user / shell long-poll）
 *   - 复用 task-runner 的 publish/subscribe（同一个 SSE 通道、watch-task 路由透明）
 *
 * # 核心机制
 *
 * - 用户在 ChatView 输入框发消息 → POST /chat-reply
 *   - awaiting_user + hasPending → submitUserMessage（解 wait_for_user pending）
 *   - 终态（idle / error / 上一轮 completed）+ 无 pending → runChatSession（启 agent）
 *   - agent 起手 prompt 已含用户首条、第一 turn 就回答
 * - agent 每答完一段 → 调 wait_for_user → shell + curl long-poll 等下一条
 * - chat agent 长存活、靠 wait_for_user 阻塞、不主动退 Run
 *
 * # 状态机（V0.6 字段映射）
 *
 *   V0.5 task.status      → V0.6 task.runStatus
 *   draft / completed     → idle
 *   running               → running
 *   awaiting_user         → awaiting_user
 *   failed                → error
 *
 * # 跟 task-runner 的区别（避免误用）
 *
 * - chat-runner 不写 actions[]、不生成 artifact 文件
 * - chat-runner prompt 里没有 [NEXT_ACTION] / [ACTION_ACK] / [TASK_DONE] 概念
 * - chat-runner 终态不靠 [TASK_DONE]、靠 cancel / 用户主动「结束对话」按钮
 */

import { Agent } from "@cursor/sdk";
import type {
  McpServerConfig,
  ModelSelection,
  SDKMessage,
} from "@cursor/sdk";

import {
  appendEvent,
  getEventsLogPath,
  getTask,
  setTaskRunStatus,
} from "./task-fs";
import {
  cancelPending,
  getChatMcpUrl,
  setChatAwaitingNotifier,
} from "./chat-mcp";
import { renderContextDocsSection } from "./context-docs-prompt";
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import {
  loadSkills,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import {
  filterDisabledMcp,
  readGlobalCursorMcpServers,
  readGlobalCursorRulesForPrompt,
} from "./cursor-config";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { filterHealthyMcp } from "./mcp-probe";
import { buildSdkErrorMessage } from "./sdk-error";
import {
  publishTaskStreamEvent,
  type TaskStreamEvent,
} from "./task-runner";
import { MCP_HEALTH_LABEL } from "@/lib/types";
import type { Task, TaskEvent } from "@/lib/types";

// ----------------- 配置 -----------------

// chat 不主动超时（用户随时可能 24h 后才回一句）
const CHAT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-mcp 在 Agent.mcpServers 里的注册名（跟 task-runner 同款、agent prompt 里得点明）
const CHAT_TOOL_MCP_NAME = "feAiFlowChat";

// ----------------- 运行时状态（独立于 task-runner）-----------------

interface RunningChatRecord {
  agentId: string;
  startedAt: number;
  cancel: () => void;
  completion: Promise<void>;
}

interface ChatRunnerGlobalState {
  // taskId → 运行中的 chat 控制对象
  runningChats: Map<string, RunningChatRecord>;
}

// 跟 task-runner 一样、状态挂 globalThis 避免 dev hot reload 拆分
const CHAT_RUNNER_GLOBAL_KEY = "__feAiFlowChatRunnerStateV2__";

const getRunnerState = (): ChatRunnerGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    ChatRunnerGlobalState | undefined
  >;
  if (!g[CHAT_RUNNER_GLOBAL_KEY]) {
    g[CHAT_RUNNER_GLOBAL_KEY] = {
      runningChats: new Map(),
    };
  }
  return g[CHAT_RUNNER_GLOBAL_KEY]!;
};

const runningChats = getRunnerState().runningChats;

export const isChatRunning = (taskId: string): boolean =>
  runningChats.has(taskId);

/**
 * 中断正在跑的 chat agent（按 taskId）、返回是否真有活 agent 被停。
 *
 * 为什么单独需要：chat agent 注册在本模块的 runningChats、不在 task-runner 的
 * runningTasks（见文件顶部说明）、所以 /stop route 的 cancelTaskRun 停不到它、
 * 必须额外调本函数。一个 task 只会落两个 map 之一、调用方两个都试即可。
 */
export const cancelChatRun = (taskId: string): boolean => {
  const rec = runningChats.get(taskId);
  if (!rec) return false;
  rec.cancel();
  return true;
};

// ----------------- publish 帮手（复用 task-runner SSE 通道） -----------------

const publish = (taskId: string, ev: TaskStreamEvent): void => {
  publishTaskStreamEvent(taskId, ev);
};

// 持久化 event + publish 给 SSE 订阅者（防御性吞错、IO 抖动不能挡 SDK 主流）
const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<Task | null> => {
  try {
    const updated = await appendEvent(taskId, ev);
    if (updated) {
      const last = updated.events[updated.events.length - 1];
      if (last) publish(taskId, { kind: "event", event: last });
    }
    return updated;
  } catch (err) {
    console.error("[chat-runner] writeEventAndPublish failed:", err);
    return null;
  }
};

// ----------------- prompt -----------------

interface InitialUserMessage {
  text: string;
  imagePaths?: string[];
  attachmentPaths?: string[];
}

/**
 * 拼 chat agent 起手 prompt
 *
 * 跟 V0.6 task-runner 的 _super.md 完全无关、不夹任务容器协议（[NEXT_ACTION] / [ACTION_ACK] / [TASK_DONE]）。
 * 只装 chat 必备：wait_for_user + shell long-poll + 禁止泄露协议。
 *
 * 有 firstMessage：直接拼进 prompt、agent 第一 turn 就回答（V0.5 自由化策略）
 * 无 firstMessage：起手姿势就是 wait_for_user 等用户发第一句（边界情况、resume run）
 */
const buildInitialPrompt = (
  task: Task,
  skills: SkillEntry[],
  rulesSection: string,
  firstMessage?: InitialUserMessage,
): string => {
  const eventsLogPath = getEventsLogPath(task.id);

  const lines: string[] = [
    "你正在 fe-ai-flow 的 **Chat 任务**里跑。这是「自由对话」模式、agent 长存活、",
    "靠 `wait_for_user` MCP 工具阻塞等用户下一条消息、收到后接着说、再 wait、循环往复直到用户主动结束。",
    "",
    `任务 ID：\`${task.id}\``,
    `任务标题：${task.title}`,
    "",
    "## 核心机制：wait_for_user + shell long-poll",
    "",
    "fe-ai-flow 暴露 1 个核心 MCP 工具实现「等用户消息」：",
    "",
    "**`wait_for_user`**（每轮对话说完话后调 1 次、绝不重复调）",
    `  - 唯一入参：\`task_id\` 字符串、固定值 \`${task.id}\`、不传别的参数`,
    "  - 立即返回 `[SHELL_WAIT_GUIDE token=xxx]` 文本、教你接下来调 `shell` 工具用 curl 跟 /wait-ack 路由建长连接等用户消息",
    "  - 不阻塞、不轮询、调一次就够",
    "",
    "## 标准等用户姿势：shell + curl long-poll（必背、anti-loop 的根治方案）",
    "",
    "拿到 `[SHELL_WAIT_GUIDE token=xxx]` 后下一步**只许**做：调 `shell` 工具执行 curl 命令（引导文本里有完整命令、复制粘贴跑）",
    "",
    "服务端 chunked stream 输出可能行：",
    "  - `[KEEPALIVE ts=<时间戳>]`：**60 秒一次的服务端心跳行、绝对忽略**。看到再多 KEEPALIVE 都正常、shell **没卡**、绝对不要 summarize / 查 terminal / 重启 shell / 重新调 wait_for_user",
    "  - `[USER_REPLY]` + 文本：用户发了下一条消息（可能含附件路径）、shell 命令 exit 0、接着处理",
    "  - `[CANCELLED]`：任务被取消、收尾结束 Run",
    "  - `[STALE]` / `[INVALID_TOKEN]`：忽略本次返回、自然结束 Run",
    "",
    "## 钢铁纪律：等用户可能需要 0 秒到几小时、任何长度都正常",
    "",
    "shell + curl 是 long-poll、等用户在 UI 上发下一条消息。**等待期间你只看到 KEEPALIVE 行不断追加**、这是设计预期。",
    "",
    "**绝对禁止**（5/10/15/20 分钟没新终态行时尤其要克制）：",
    "  - ❌ 调 read 读 cursor 内部 terminal 文件查 shell 进程状态",
    "  - ❌ thinking 里冒出「The 5-minute block has ended」「process is still running」「I will summarize for the user」",
    "  - ❌ 调任何其他工具自救、重新启 shell、重新 wait_for_user",
    "  - ❌ emit 任何 assistant_message 跟用户讲「我在等」「shell 在监听」",
    "",
    "**唯一合法动作**：什么也不做、继续等 shell 的下一段 stdout。下一段 stdout 不是 KEEPALIVE 就是终态行（USER_REPLY / CANCELLED）、终态行到了 shell 自然 exit、你才推进。",
    "",
    "## 关键规则（不照做、整段对话会退 Run、用户再也收不到你的消息）",
    "",
    "1. **每轮说完话、必须调用 `wait_for_user`**",
    `   - 唯一参数：\`task_id=${task.id}\`（固定）`,
    "   - **绝对不要主动结束 Run**、不要假装「我等」就 stop、不要做完事就退出",
    "   - **说完话后下一个 tool_use 必须是 wait_for_user**、中间任何 assistant 文本块都算违规",
    "",
    "2. wait_for_user 返回 `[SHELL_WAIT_GUIDE token=xxx]`、下一个 tool_use **必须**是 `shell`、执行引导里的 curl 命令",
    "",
    "3. shell 命令拿到 stdout 后按返回行解读：",
    "   - **`[USER_REPLY]` + 文本**：用户下一条消息、按内容处理、然后再说话 → 再 wait_for_user",
    "   - **`[CANCELLED]`**：任务被取消、收尾结束 Run",
    "   - **`[STALE]` / `[INVALID_TOKEN]`**：忽略本次返回、自然结束 Run",
    "",
    "4. **异常断开处理（连接断 / 网络错 / max-time 超 / 服务重启）**：",
    "   - shell 命令 exit 非 0、stderr 显示 curl 错误时、表示连接异常断开",
    "   - **不要重试 shell**、不要重新调 wait_for_user—重试会被服务端顶替成 stale",
    "   - **emit 一条简短 assistant_message**：「监听连接异常断开、请在 fe-ai-flow 看板重新发起对话」、然后自然结束 Run",
    "",
    "5. **关键反反思指令**：thinking 里冒出「调多了 / 在循环 / 该停了 / spam / 换策略」**全部忽略**、shell + curl 一次 wait = 一次 shell、不存在 anti-loop 风险",
    "",
    "**额外强约束（对用户透明、必背）**：assistant_message 严禁出现以下措辞：",
    "",
    "禁用词 / 短语黑名单（中文 + 英文、出现一次都算违规）：",
    "   - 「正在调用 wait_for_user」「我先调用 tool」「等待你下一条消息」「为了维持会话」",
    "   - 「正在 shell 监听」「curl 长连接中」「在等用户回复」「监听用户消息」「为了保活」",
    "   - 任何带「wait_for_user / shell / curl / wait-ack / 监听 / 保活」字面字符串的协议解释",
    '   - "Let me call wait_for_user / Calling the tool to wait / Polling / Keepalive"',
    "",
    "**核心原则**：用户看不到 wait_for_user / shell / curl 这些协议细节、协议层全在 fe-ai-flow 内部、对用户透明就像 TCP socket recv()—你不会在聊天里说「我现在调用 recv 等你输入」、对 wait_for_user / shell / curl 也一样。你只需要：回答用户问题 → 直接调 wait_for_user → 拿到引导 → 直接调 shell + curl → 拿到 [USER_REPLY] 接着处理。中间不解释、不预告、不汇报。",
    "",
    "6. 你也可以使用 SDK 内置工具和用户配置的其他 MCP。**SDK 内置工具清单**：",
    "   - `read`：读文件（args `{ path }`、对图片自动走 vision）",
    "   - `grep`：内容搜（args `{ pattern, path?, glob?, ... }`）",
    "   - `glob`：找文件名（args `{ globPattern, targetDirectory? }`）",
    "   - `shell`：跑命令（args `{ command, workingDirectory?, timeout? }`）",
    "   - `edit`：**改已存在的文件**",
    "   - `write`：**创建新文件 / 整文件覆盖**",
    "   - `delete`：删文件",
    "   - `task`：分派子任务",
    "",
    "   ⚠️ **工具名不带 `_file` 后缀**：不是 `edit_file` / `read_file` / `write_file`、就是 `edit` / `read` / `write`。",
    "",
    "## 每轮对话完成时的标准动作（背下来、必须按这个顺序）",
    "",
    "1. 回答用户的问题 / 完成用户要的操作（用 SDK 内置工具 / MCP）",
    "2. emit 一段 assistant_message 回应用户（**不含**任何协议元叙述）",
    "3. **沉默地** 调用一次 `wait_for_user(task_id)`（不要 assistant_message 解释）",
    "4. 立即拿到 `[SHELL_WAIT_GUIDE token=xxx]` 返回、**沉默地**调 `shell` 跑引导里的 curl 命令",
    "5. shell stdout 返回时按内容走分支（见上「关键规则 3」)",
    "6. **不要 assistant_message 自言自语「等你回复中」/「我在监听」/「shell 在跑」之类**",
    "",
    "## ask_user：chat 模式禁用",
    "",
    "**chat（自由聊天）任务里不要调 `ask_user` 工具**—chat 本质就是 talk、",
    "有不确定项 / 想跟用户确认时**直接发一段 assistant_message 问就行**、用户在输入框答你。",
    "",
    "**chat 模式里 agent 想确认时的标准动作**：",
    "  1. 直接 emit 一段 assistant_message、把多个不确定点用 markdown 自然语言列清楚",
    "  2. 调 wait_for_user 等用户在输入框回",
    "  3. shell stdout 拿到 `[USER_REPLY]` 后按用户答案推进",
    "",
    "## 全局规则（用户在 Cursor 配的偏好、必遵守）",
    "",
    "下面是用户在 Cursor 全局配的规则（`~/.cursor/rules/`）。alwaysApply 的已全文展开、必遵守；其余按场景用 `read` 读全文：",
    "",
    rulesSection,
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
    "",
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
  ];

  // 起手姿势：有首条 → 直接答；无首条 → wait_for_user 起手等
  lines.push(...buildOpeningStanceSection(task.id, firstMessage));

  return lines.join("\n");
};

/**
 * 起手姿势段：根据有没有首条用户消息分两种
 *
 * - 有首条（V0.4 自由化主路径、99% 场景）：直接答用户首条、答完调 wait_for_user
 * - 没首条（极少数边界、resume run 或外部触发）：先 wait_for_user 等用户说话
 */
const buildOpeningStanceSection = (
  taskId: string,
  firstMessage?: InitialUserMessage,
): string[] => {
  if (!firstMessage) {
    return [
      "## 起手姿势（无首条消息）",
      "",
      `本任务尚无用户首条、立刻调 \`wait_for_user(task_id=${taskId})\` 等用户在输入框发第一句、再开始对话。`,
      "",
    ];
  }

  const lines: string[] = [
    "## 起手姿势：先回答用户首条消息",
    "",
    "下面是用户在 fe-ai-flow UI 上发的第一条消息。你**第一次说话就回答它**、然后再调 wait_for_user 等下一句。",
    "",
    "用户消息：",
    "",
    firstMessage.text.length > 0
      ? firstMessage.text
      : "(空文本、看下方附件)",
    "",
  ];

  if (firstMessage.imagePaths && firstMessage.imagePaths.length > 0) {
    lines.push(
      "[ATTACHED_IMAGES] 用户附了下面这些图（请先用 `read` 工具逐一看）：",
      ...firstMessage.imagePaths.map((p) => `  - \`${p}\``),
      "",
    );
  }
  if (firstMessage.attachmentPaths && firstMessage.attachmentPaths.length > 0) {
    lines.push(
      "[ATTACHED_PATHS] 用户附了下面这些文件 / 目录路径（用 `read` / `grep` / `glob` 自己读）：",
      ...firstMessage.attachmentPaths.map((p) => `  - \`${p}\``),
      "",
    );
  }
  return lines;
};

// ----------------- 流式消费 SDK 消息 -----------------

interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  sdkErrorMessage?: string;
}

// 工具调用 args / result 序列化（对齐 task-runner 的 stringifyMeta / truncate）
const stringifyMeta = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const truncate = (s: string, len = 500): string =>
  s.length > len ? `${s.slice(0, len)}...(truncated ${s.length - len} chars)` : s;

/**
 * 处理单条 SDK message（对齐 task-runner.handleSdkMessage 的字段约定）
 *
 * SDK 1.0.13 关键字段（注意都是 args/message/status 这种名字、不是 input/text）：
 *   - thinking: msg.text + msg.thinking_duration_ms
 *   - tool_call: msg.name + msg.args + msg.status + msg.result
 *   - assistant: msg.message.content[].text
 *   - status: msg.status ("ERROR" / "EXPIRED" 大写) + msg.message
 */
const handleSdkMessage = async (
  taskId: string,
  msg: SDKMessage,
  ctx: AssistantBufferCtx,
): Promise<void> => {
  switch (msg.type) {
    case "thinking": {
      await ctx.flush();
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
      await ctx.flush();
      const argsStr = stringifyMeta(msg.args);
      // 区分 wait_for_user / 其他工具：wait_for_user 的成功调用不需要刷事件（notifier 已经处理 awaiting）
      const isWaitForUser =
        msg.name === "wait_for_user" || msg.name === "Wait For User";
      if (isWaitForUser) {
        if (msg.status === "error") {
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `wait_for_user 工具调用失败：${truncate(stringifyMeta(msg.result), 200)}`,
          });
        }
        break;
      }
      if (msg.status === "running") {
        await writeEventAndPublish(taskId, {
          kind: "tool_call",
          text: `调用 ${msg.name}${argsStr ? `: ${truncate(argsStr, 120)}` : ""}`,
          meta: { name: msg.name, args: argsStr ? truncate(argsStr) : undefined },
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
      let text = "";
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
      if (text.length > 0) {
        ctx.buffer += text;
        publish(taskId, { kind: "assistant_delta", text });
      }
      break;
    }

    case "status": {
      console.log(
        `[chat-runner] task=${taskId} SDK status=${msg.status} message=${
          (msg as { message?: string }).message ?? "(none)"
        }`,
      );
      if (
        (msg.status === "ERROR" || msg.status === "EXPIRED") &&
        msg.message
      ) {
        ctx.sdkErrorMessage = msg.message;
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

// ----------------- 入口：runChatSession -----------------

export interface RunChatInput {
  task: Task;
  apiKey: string;
  model: ModelSelection;
  // 用户首条消息（绝大多数 chat 启动场景都有）、直接拼进 prompt
  firstMessage?: InitialUserMessage;
}

/**
 * 启动 chat agent run（fire-and-forget）
 *
 * 已在跑就直接 return（幂等）。
 * 返回 Promise 在 agent 终止时（成功 / 失败 / 取消）才 resolve、调用方一般不要 await、
 * 让 agent 后台跑、HTTP 立即返回。
 */
export const runChatSession = async (input: RunChatInput): Promise<void> => {
  const { task, apiKey, model, firstMessage } = input;

  if (runningChats.has(task.id)) {
    return;
  }

  // 1) 切到 running、写一条 info event
  const startedTask = await setTaskRunStatus(task.id, "running");
  if (startedTask) publish(task.id, { kind: "task", task: startedTask });

  // 2) 拼 mcpServers：全局 cursor mcp（按 task 黑名单过滤）+ 我们自己的 chat-tool
  // 全局 ~/.cursor/mcp.json 由 fe 读（settingSources["project"] 够不着 user 层）、详见 cursor-config.ts
  // 配置里万一也叫 feAiFlowChat、按我们的为准（直接覆盖）
  // 注入 OAuth token：走 OAuth 授权的远程 MCP（如飞书项目）token 不在 mcp.json、
  // 由 fe 自己跑过 OAuth 落盘、起 agent 前补到 headers.Authorization、详见 mcp-oauth.ts
  const enrichedMcp = await enrichMcpServersWithOAuth(
    filterDisabledMcp(
      await readGlobalCursorMcpServers(),
      task.disabledMcpServers,
    ),
  );
  // V0.6.11 容错：起 agent 前剔除连不上 / 未授权的远程 MCP、单个 MCP 挂不拖垮整个 run
  const { servers: cursorMcp, dropped: droppedMcp } =
    await filterHealthyMcp(enrichedMcp);
  const mergedMcp: Record<string, McpServerConfig> = {
    ...cursorMcp,
    [CHAT_TOOL_MCP_NAME]: {
      type: "http",
      url: getChatMcpUrl(),
    },
  };

  const cursorMcpNames = Object.keys(cursorMcp).filter(
    (n) => n !== CHAT_TOOL_MCP_NAME,
  );
  const mcpDesc = `Chat MCP: ${CHAT_TOOL_MCP_NAME}${
    cursorMcpNames.length > 0 ? ` + cursor MCP: ${cursorMcpNames.join(", ")}` : ""
  }`;

  await writeEventAndPublish(task.id, {
    kind: "info",
    text: `Chat 任务启动（model: ${model.id}、${mcpDesc}）`,
  });

  // V0.6.11：有被剔除的 MCP → 写一条提示、让用户知道为什么少了能力（不再「莫名其妙报错」）
  if (droppedMcp.length > 0) {
    await writeEventAndPublish(task.id, {
      kind: "info",
      text: `⚠️ 已跳过 ${droppedMcp.length} 个不可用的 MCP：${droppedMcp
        .map((d) => `${d.name}（${d.detail?.split("\n")[0] ?? MCP_HEALTH_LABEL[d.status]}）`)
        .join("、")}——相关能力本次不可用、去设置页检查 / 授权`,
    });
  }

  // 3) 注入 awaiting notifier：agent 调 wait_for_user → 切 task.runStatus=awaiting_user
  // chat 模式不会调 ask_user（prompt 已禁）、所以只处理 awaiting_start
  setChatAwaitingNotifier(task.id, async (signal) => {
    if (signal.kind === "ask_user_request") {
      // 防御性：agent 即使无视 prompt 调了 ask_user、也别让它挂死、转 assistant_message 提示用户
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      await writeEventAndPublish(task.id, {
        kind: "assistant_message",
        text: `[agent 误调 ask_user、chat 模式不支持]\n${previewText}`,
      });
      const updated = await setTaskRunStatus(task.id, "awaiting_user");
      if (updated) publish(task.id, { kind: "task", task: updated });
      return;
    }
    const updated = await setTaskRunStatus(task.id, "awaiting_user");
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
      // settingSources:["project"] = 加载目标仓库 .cursor/ 的 rules/skills/mcp/hooks（project 层）
      //（跟 Cursor IDE 一致、配置双向绑定）；全局 ~/.cursor/（user 层）SDK 够不着、
      // 由 fe 读了注入（rules/skills 进 prompt、mcp 进 inline mergedMcp）、详见 cursor-config.ts
      local: { cwd: getEffectiveCwd(task.repoPaths), settingSources: ["project"] },
      mcpServers: mergedMcp,
    });

    // 加载 skills：平台自带 + 全局 ~/.cursor/skills/（repo 层 skills 由 settingSources 交给 SDK）
    const skills = await loadSkills().catch((err) => {
      console.error("[chat-runner] loadSkills failed", err);
      return [];
    });

    // 全局 rules（~/.cursor/rules/、settingSources["project"] 够不着、fe 读了注入）
    const rulesSection = await readGlobalCursorRulesForPrompt();
    const initialPrompt = buildInitialPrompt(task, skills, rulesSection, firstMessage);
    const run = await agent.send(initialPrompt);

    // 注册 cancel 控制
    runningChats.set(task.id, {
      agentId: agent.agentId,
      startedAt: Date.now(),
      cancel: () => {
        cancelled = true;
        cancelPending(task.id);
        void run.cancel().catch(() => {});
      },
      // 占位、真正的 completion promise 在 try/catch 外面赋值
      completion: Promise.resolve(),
    });

    // 兜底硬超时：24h
    hardTimer = setTimeout(() => {
      cancelled = true;
      cancelPending(task.id);
      void run.cancel().catch(() => {});
    }, CHAT_HARD_TIMEOUT_MS);

    // 流式消费 + buffer flush
    // 用一个 buffer 累积 assistant text、遇到非 assistant 消息或 run 结束时再 flush 成一条 assistant_message
    // 这样一轮 agent 完整回复 → 一条事件、UI 不会出现「我」「在」「想」这种碎片
    const ctx: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {
        const trimmed = ctx.buffer.trim();
        ctx.buffer = "";
        if (trimmed.length === 0) return;
        await writeEventAndPublish(task.id, {
          kind: "assistant_message",
          text: trimmed,
        });
      },
    };

    for await (const msg of run.stream()) {
      // handleSdkMessage 内部已在 thinking / tool_call case 自己 flush buffer
      // 这里不重复 flush、否则 IO 抖动
      await handleSdkMessage(task.id, msg, ctx);
    }

    // 流结束、最后一段 assistant text 也要 flush
    await ctx.flush();

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    const result = await run.wait();

    if (cancelled || result.status === "cancelled") {
      // cancel 收尾只归位 runStatus + publish done、不落 info——
      // 用户主动停时 /stop route 已落「用户停止了对话」、这里再落会重复（跟 task-runner cancel 分支对齐）
      const cancelledTask = await setTaskRunStatus(task.id, "idle");
      if (cancelledTask) publish(task.id, { kind: "task", task: cancelledTask });
      publish(task.id, { kind: "done", task: cancelledTask ?? task, ok: true });
      return;
    }

    if (result.status !== "finished") {
      const sdkErr = ctx.sdkErrorMessage
        ? `\n--- SDK stream error message ---\n${ctx.sdkErrorMessage}`
        : "";
      throw new Error(
        `agent run status=${result.status}${
          result.result ? `: ${result.result.slice(0, 200)}` : ""
        }${sdkErr}`,
      );
    }

    const completedTask = await setTaskRunStatus(task.id, "idle");
    if (completedTask) publish(task.id, { kind: "task", task: completedTask });
    const done = await writeEventAndPublish(task.id, {
      kind: "info",
      text: "Chat 任务结束、agent 正常退出（再发一句可重启对话）",
    });
    publish(task.id, { kind: "done", task: done ?? task, ok: true });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chat-runner] task", task.id, "failed:", err);
    // SDK 错误详情（code/cause/...）一并落到 event、跟 task-runner 对齐、下次能从 events 看根因
    const fullMessage = buildSdkErrorMessage(message, err);
    await writeEventAndPublish(task.id, {
      kind: "error",
      text: `Chat agent 异常：${fullMessage}`,
    });
    const errorTask = await setTaskRunStatus(task.id, "error");
    if (errorTask) publish(task.id, { kind: "task", task: errorTask });
    const finalTask = await getTask(task.id);
    publish(task.id, {
      kind: "done",
      task: finalTask ?? task,
      ok: false,
    });
    publish(task.id, { kind: "error", message });
  } finally {
    runningChats.delete(task.id);
  }
};
