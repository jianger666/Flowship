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
  markTaskAsChat,
  setChatAwaitingNotifier,
  unmarkTaskAsChat,
} from "./chat-mcp";
import {
  chatWaitProtocolSection,
  firstTurnReplyThenWaitReminder,
} from "./wait-protocol-prompt";
import { renderContextDocsSection } from "./context-docs-prompt";
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import os from "node:os";
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
import { summarizeRunFailure } from "./sdk-error";
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
const CHAT_TOOL_MCP_NAME = "aiFlowChat";

// chat agent / run 句柄类型（从 SDK Agent.create / agent.send 推导、给 runningChats 占位注册 + cancel 用）
type ChatAgent = Awaited<ReturnType<typeof Agent.create>>;
type ChatRun = Awaited<ReturnType<ChatAgent["send"]>>;

// ----------------- 运行时状态（独立于 task-runner）-----------------

interface RunningChatRecord {
  agentId: string;
  startedAt: number;
  cancel: () => void;
  // 本 Run 启动时绑定的模型（Agent.create 时定死、Run 期间不可变）。
  // 切模型懒重启用：用户切模型后发下条消息、chat-reply 比对「选中模型 vs 这个」决定续接还是起新 Run。
  model: ModelSelection;
  // 本 Run 启动时绑定的 MCP 黑名单快照（启动时按它过滤 mcpServers、Run 期间不可变）。
  // 切 MCP 懒重启用：用户改 MCP 开关后发下条消息、chat-reply 比对「现在 task 的黑名单 vs 这个」决定续接还是起新 Run。
  disabledMcpServers: string[];
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

/**
 * 读当前活 chat Run 启动时绑定的模型（无活 Run 返 null）。
 * 切模型懒重启用：chat-reply 收到新消息时、比对「用户现在选的模型 vs 这个」决定续接 or 重启。
 */
export const getChatRunModel = (taskId: string): ModelSelection | null =>
  runningChats.get(taskId)?.model ?? null;

/**
 * 读当前活 chat Run 启动时绑定的 MCP 黑名单快照（无活 Run 返 null）。
 * 切 MCP 懒重启用：chat-reply 收到新消息时、比对「现在 task 的黑名单 vs 这个」决定续接 or 重启。
 */
export const getChatRunDisabledMcp = (taskId: string): string[] | null =>
  runningChats.get(taskId)?.disabledMcpServers ?? null;

/**
 * 等当前 chat Run 真退（轮询 runningChats、退了返 true、超时返 false）。
 * 切模型重启时：cancelChatRun 后等旧 Run 的 finally 清掉自己、再起新 Run、防两个 Run 并存
 *（runChatSession 入口 has(taskId) 为真会直接 return、不等就起会被挡）。对齐 task-runner.waitForTaskToStop。
 */
export const waitForChatToStop = async (
  taskId: string,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!runningChats.has(taskId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !runningChats.has(taskId);
};

/**
 * 强清 chat Run 运行时状态（pending + runningChats entry）。
 * 仅 waitForChatToStop 超时兜底用：旧 Run cancel 卡住没按期退、强清好让新 Run 起得来。
 * 旧 Run 迟到的 finally 再 delete 无害（delete 不存在的 key 不报错）。
 */
export const forceClearChatRun = (taskId: string): void => {
  cancelPending(taskId);
  runningChats.delete(taskId);
};

// ----------------- publish 帮手（复用 task-runner SSE 通道） -----------------

const publish = (taskId: string, ev: TaskStreamEvent): void => {
  publishTaskStreamEvent(taskId, ev);
};

// 持久化 event + publish 给 SSE 订阅者（防御性吞错、IO 抖动不能挡 SDK 主流）
// V0.6.27：appendEvent 改返回 event 本身（轻量路径、不再 hydrate 全量 Task）
const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<TaskEvent | null> => {
  try {
    const event = await appendEvent(taskId, ev);
    if (event) publish(taskId, { kind: "event", event });
    return event;
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
    "你正在 ai-flow 的 **Chat 任务**里跑——一个长期在线的自由对话助手。和用户来回聊、答疑、查资料、读写代码都行。",
    "",
    `任务 ID：\`${task.id}\``,
    `任务标题：${task.title}`,
    "",
    // 等待协议（回答 → wait_for_user → shell curl 挂着等下一条）单一源、见 chat-wait-prompt.ts
    chatWaitProtocolSection(task.id),
    "",
    "## 你能用的工具",
    "",
    "SDK 内置工具（**名字不带 `_file` 后缀**、就是 `read` / `edit` / `write`、不是 `read_file` 之类）：",
    "  - `read` 读文件（图片自动走 vision）　`grep` 搜内容　`glob` 找文件名",
    "  - `shell` 跑命令　`edit` 改已有文件　`write` 建新文件 / 整文件覆盖　`delete` 删文件　`task` 分派子任务",
    "",
    "另外还有用户配的其他 MCP（飞书 / context7 等）、按场景用。",
    "",
    "## 全局规则（用户在 Cursor 配的偏好、必遵守）",
    "",
    "下面是用户在 Cursor 全局配的规则（`~/.cursor/rules/`）。alwaysApply 的已全文展开、必遵守；其余按场景用 `read` 读全文：",
    "",
    rulesSection,
    "",
    "## Skills（ai-flow 自带能力扩展）",
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
    "## 用户的第一条消息",
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
  // recency 钉子：首轮专用强版（动作序列、见 wait-protocol-prompt 变体说明）、钉在用户首条之后、
  // 让 agent 最后读到的是「先成品 → 紧接着挂等」（治首轮冷启动 / 切模型懒重启漏挂等）
  lines.push(firstTurnReplyThenWaitReminder(), "");
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
      // SDK 把 MCP 工具包成 msg.name="mcp" + msg.args.toolName=真实工具名（mirror task-runner）
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      // 区分 wait_for_user / 其他工具：wait_for_user 的成功调用不刷事件（notifier 已处理 awaiting）。
      // 必须连 MCP wrapper 一起认——漏认会把 wait_for_user 写成普通 tool_call、
      // 被兜底 A 误当「答后又干活」拦下（2026-06-16 线上事故根因）。
      const isWaitForUser =
        msg.name === "wait_for_user" ||
        msg.name === "Wait For User" ||
        innerToolName === "wait_for_user" ||
        innerToolName === "Wait For User";
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
          // innerToolName 结构化落库：下游（兜底 A）据此精确识别 MCP 工具、
          // 不再解析被 truncate 的展示文本（text.includes 太脆、会误伤 dogfood grep）
          meta: {
            name: msg.name,
            innerToolName: innerToolName || undefined,
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
  // 首条消息对应的 user_reply 事件 id（chat-reply 启 run 前已写、传进来）。
  // 写进「Chat 任务启动」info 的 meta，让兜底 A 显式定位「本轮该回答的问题」、
  // 不靠「user_reply 紧贴 chat_start 前一格」这种位置巧合（见 chat-mcp.classifyPrematureChatWait）。
  firstMessageEventId?: string;
}

/**
 * 启动 chat agent run（fire-and-forget）
 *
 * 已在跑就直接 return（幂等）。
 * 返回 Promise 在 agent 终止时（成功 / 失败 / 取消）才 resolve、调用方一般不要 await、
 * 让 agent 后台跑、HTTP 立即返回。
 */
export const runChatSession = async (input: RunChatInput): Promise<void> => {
  const { task, apiKey, model, firstMessage, firstMessageEventId } = input;

  if (runningChats.has(task.id)) {
    return;
  }

  // 句柄 + 取消标志提到最前：配合下面「进入即占位注册」消除冷启动竞态——
  // Agent.create / agent.send / MCP 健康探测都要数秒、旧版到 send 之后才注册进 runningChats、
  // 这几秒窗口里点停止 cancelChatRun 会 get 不到、扑空（连 cancelled 都来不及设）、
  // run 照常启动复述 + 回复（用户实测「已停止但 AI 还回了」就是这窗口、V0.7.23 修）。
  let agent: ChatAgent | null = null;
  let run: ChatRun | null = null;
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;

  // cancel 收尾：归位 idle + publish done（不落 info——主动停时 /stop route 已落「用户停止了对话」、避免重复）
  const finishCancelled = async (): Promise<void> => {
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
    const t = await setTaskRunStatus(task.id, "idle");
    if (t) publish(task.id, { kind: "task", task: t });
    publish(task.id, { kind: "done", task: t ?? task, ok: true });
  };

  // 进入即占位注册：任何时刻（含 create/send/MCP 探测冷启动期）点停止、cancelChatRun 都能命中、
  // 置 cancelled（有 run 时一并真取消 SDK run）；agentId 先空、send 出来再回填。
  // 注册后所有逻辑全纳入下面 try/finally、保证占位 record 必被清理（否则 has=true 永真、卡死后续启动）。
  runningChats.set(task.id, {
    agentId: "",
    startedAt: Date.now(),
    // 记下本 Run 绑定模型、供「切模型懒重启」比对（见 chat-reply route）
    model,
    // 记下本 Run 绑定的 MCP 黑名单快照（下面 filterDisabledMcp 按它过滤）、供「切 MCP 懒重启」比对
    disabledMcpServers: task.disabledMcpServers ?? [],
    cancel: () => {
      cancelled = true;
      cancelPending(task.id);
      if (run) void run.cancel().catch(() => {});
    },
  });

  try {
    // V0.7.20：标记 chat 模式、让 chat-mcp 的 wait 引导走精简 chat 版（USER_REPLY 语境、不夹 task 信号）
    markTaskAsChat(task.id);

    // 1) 切到 running、写一条 info event
    const startedTask = await setTaskRunStatus(task.id, "running");
    if (startedTask) publish(task.id, { kind: "task", task: startedTask });

    // 2) 拼 mcpServers：全局 cursor mcp（按 task 黑名单过滤）+ 我们自己的 chat-tool
    // 全局 ~/.cursor/mcp.json 由 fe 读（settingSources["project"] 够不着 user 层）、详见 cursor-config.ts
    // 配置里万一也叫 aiFlowChat、按我们的为准（直接覆盖）
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

    // MCP 健康探测也要数秒、探测期间被停 → 别再写「Chat 任务启动」往下跑、直接收尾
    if (cancelled) {
      await finishCancelled();
      return;
    }

    await writeEventAndPublish(task.id, {
      kind: "info",
      text: `Chat 任务启动（model: ${model.id}、${mcpDesc}）`,
      // 显式记下「触发本轮的首条消息事件」、供兜底 A 精确定位本轮回答义务（见 chat-mcp）
      meta: firstMessageEventId ? { firstMessageEventId } : undefined,
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
    agent = await Agent.create({
      apiKey,
      model,
      // settingSources:["project"] = 加载目标仓库 .cursor/ 的 rules/skills/mcp/hooks（project 层）
      //（跟 Cursor IDE 一致、配置双向绑定）；全局 ~/.cursor/（user 层）SDK 够不着、
      // 由 fe 读了注入（rules/skills 进 prompt、mcp 进 inline mergedMcp）、详见 cursor-config.ts
      local: {
        // 未绑工作目录（自由对话没选目录）→ cwd 用用户主目录、不用 process.cwd()
        //（打包后 = app 内部目录、对终端用户无意义）。对齐 codex（默认终端 pwd）/
        // Cursor（默认 workspace）：总给个用户地盘的合法 cwd、要 agent 干活就让用户选目录。
        cwd:
          task.repoPaths.length > 0
            ? getEffectiveCwd(task.repoPaths)
            : os.homedir(),
        settingSources: ["project"],
      },
      mcpServers: mergedMcp,
    });

    // Agent.create 冷启动也要数秒、create 期间被停 → 别 send、直接收尾
    if (cancelled) {
      await finishCancelled();
      return;
    }

    // 加载 skills：平台自带 + 全局 ~/.cursor/skills/（repo 层 skills 由 settingSources 交给 SDK）
    const skills = await loadSkills().catch((err) => {
      console.error("[chat-runner] loadSkills failed", err);
      return [];
    });

    // 全局 rules（~/.cursor/rules/、settingSources["project"] 够不着、fe 读了注入）
    const rulesSection = await readGlobalCursorRulesForPrompt();
    const initialPrompt = buildInitialPrompt(task, skills, rulesSection, firstMessage);
    run = await agent.send(initialPrompt);

    // 回填真实 agentId（占位注册时是空串）
    const rec = runningChats.get(task.id);
    if (rec) rec.agentId = agent.agentId;

    // send 期间被停 → run 已就位、真取消它再收尾
    if (cancelled) {
      void run.cancel().catch(() => {});
      await finishCancelled();
      return;
    }

    // run 此刻必非 null（send 成功 + 未取消）、用局部 const 给后续 stream/wait/hardTimer、
    // 免「let + 闭包捕获」让 TS 把 narrow 丢回 null
    const activeRun = run;

    // 兜底硬超时：24h
    hardTimer = setTimeout(() => {
      cancelled = true;
      cancelPending(task.id);
      void activeRun.cancel().catch(() => {});
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

    for await (const msg of activeRun.stream()) {
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

    const result = await activeRun.wait();

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
      // dump 完整 result（对齐 task-runner）：RunResult 类型没声明 errorCode、但运行时可能藏未声明字段、
      // 落进 dump → 事后从 events.meta.detail 看 SDK 到底给了啥（区分额度 vs 连接断的唯一线索）。
      const resultDump = stringifyMeta(result).slice(0, 1500);
      throw new Error(
        `agent run status=${result.status}${
          result.result ? `: ${result.result.slice(0, 200)}` : ""
        }${sdkErr}\n--- SDK result dump ---\n${resultDump}`,
      );
    }

    const completedTask = await setTaskRunStatus(task.id, "idle");
    if (completedTask) publish(task.id, { kind: "task", task: completedTask });
    await writeEventAndPublish(task.id, {
      kind: "info",
      text: "Chat 任务结束、agent 正常退出（再发一句可重启对话）",
    });
    publish(task.id, { kind: "done", task: completedTask ?? task, ok: true });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chat-runner] task", task.id, "failed:", err);
    // 归一成给用户看的文案：长连接被断（最常见）→ 友好一句话、不加吓人前缀；
    // 其它有诊断的错 → 带详情、加「异常」前缀（跟 task-runner 对齐）。原始 err 已 console.error。
    const failure = summarizeRunFailure(message, err);
    const eventText = failure.isConnectionDrop
      ? failure.text
      : `Chat agent 异常：${failure.text}`;
    await writeEventAndPublish(task.id, {
      kind: "error",
      text: eventText,
      // 原始诊断落 meta（UI 不展示、事后从 events.jsonl 定位额度 vs 连接断）
      meta: { detail: failure.detail },
    });
    const errorTask = await setTaskRunStatus(task.id, "error");
    if (errorTask) publish(task.id, { kind: "task", task: errorTask });
    const finalTask = await getTask(task.id);
    publish(task.id, {
      kind: "done",
      task: finalTask ?? task,
      ok: false,
    });
    publish(task.id, { kind: "error", message: eventText });
  } finally {
    runningChats.delete(task.id);
    unmarkTaskAsChat(task.id);
  }
};
