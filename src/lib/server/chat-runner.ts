/**
 * Chat runner（V0.6.0.1 重新引入、V0.11 改「create + 多轮 send」正常对话流）
 *
 * 跟 task-runner 完全独立：
 *   - chat task（task.mode === "chat"）走自己的 prompt（无 _super.md 任务容器协议）
 *   - 自己的 runtime state（runningChats = 会话表）、不跟 task-runner runningTasks 混
 *   - 复用 task-runner 的 publish/subscribe（同一个 SSE 通道、watch-task 路由透明）
 *
 * # 核心机制（V0.11、wait 协议退役）
 *
 * - 用户在 ChatView 输入框发消息 → POST /chat-reply
 *   - 有存活会话（agent 在、无 run 在跑）→ sendChatMessage（agent.send 续同一会话）
 *   - 无会话（首条 / agent 已关 / 服务重启过）→ runChatSession（Agent.create + 首条进起手 prompt）
 * - agent 答完自然结束 turn → run finished → runStatus=awaiting_user 等下一条、**会话保留**
 * - 不再有 submit_work / shell curl 长轮询——agent 就是正常的多轮对话
 *
 * # 状态机
 *
 *   running        → run 在跑（agent 正在答）
 *   awaiting_user  → 会话在、等用户下一条
 *   idle / error   → 停止 / 出错（会话已关、下一条消息起新会话、靠 events.jsonl 恢复上下文）
 *
 * # 跟 task-runner 的区别（避免误用）
 *
 * - chat-runner 不写 actions[]、不生成 artifact 文件
 * - chat prompt 里没有 [NEXT_ACTION] / [USER_MESSAGE] 任务容器概念
 */

import { Agent } from "@cursor/sdk";
import type {
  McpServerConfig,
  ModelSelection,
  SDKMessage,
} from "@cursor/sdk";

import {
  appendEvent,
  getTask,
  setTaskRunStatus,
  setTaskSessionAgentId,
} from "./task-fs";
import { getEventsLogPath } from "./task-fs-core";
import { getChatMcpUrl } from "./chat-mcp";
import { setChatAwaitingNotifier } from "./chat-pending";
import { chatTurnProtocolSection } from "./turn-discipline";
import { supersedePendingAsks } from "./ask-supersede";
import { renderContextDocsSection } from "./context-docs-prompt";
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataRoot } from "./data-root";
import { createRunPerfTracker } from "./run-perf";
import {
  loadSkills,
  renderSkillsForPrompt,
  type SkillEntry,
} from "./skills-loader";
import {
  readAppRulesForPrompt,
  resolveTaskMcpServers,
} from "./cursor-config";
import { resolveUserIdentityForPrompt } from "./meegle-cli";
import {
  buildGitlabAccessDirective,
  renderReadonlyRepoDirective,
  renderScriptRepoDirective,
} from "./task-prompts";
import { resolveEffectiveGitHost } from "./gitlab-host";
import { readSettingsFile } from "./settings-fs";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { filterHealthyMcp, invalidateMcpProbeCache } from "./mcp-probe";
import { isRetryableRunError, summarizeRunFailure } from "./sdk-error";
import {
  publishTaskStreamEvent,
  type TaskStreamEvent,
} from "./task-stream";
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
  // V0.11：会话持有的 Agent 实例（run 结束不关、下一条消息 send 续接）；冷启动占位期为 null
  agent: ChatAgent | null;
  // V0.11：当前是否有 run 在消费（true 时新消息拒收、防并发 send）
  runActive: boolean;
  // V0.11.1：最近活跃时间（run 结束 / send 时刷）——空闲回收 sweeper 按它判 TTL
  lastActiveAt: number;
  // 本会话启动时绑定的模型（Agent.create 时定死、会话期间不可变）。
  // 切模型懒重启用：用户切模型后发下条消息、chat-reply 比对「选中模型 vs 这个」决定续接还是重开会话。
  model: ModelSelection;
  // 本会话启动时绑定的 MCP 黑名单快照（启动时按它过滤 mcpServers、会话期间不可变）。
  // 切 MCP 懒重启用：比对「现在 task 的黑名单 vs 这个」决定续接还是重开会话。
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

/**
 * 会话对象是否在表（含 run 自然结束后 idle 等用户的健康态）——与 task 侧
 * `agentSessions.has` 语义对齐。⚠️ 不是「run 正在跑」（那是 rec.runActive）；
 * 旧名 hasChatSession 连 AI review 都会误读、2026-07-14 改名。
 */
export const hasChatSession = (taskId: string): boolean =>
  runningChats.has(taskId);

/**
 * V0.11：关掉一个 chat 会话（agent close + 删记录）、best-effort。
 * expectedAgentId 传了就只在「当前会话确实是它」时才关（异步收尾路径防误关新会话）；
 * 不传 = 关当前的（用户主动 stop / forceClear）。对齐 task-runner.closeTaskSession。
 * keepPersisted = 空闲回收用（sessionAgentId 留着、下次消息 Agent.resume 接回）
 * @returns 是否真的关了一个会话
 */
const closeChatSession = (
  taskId: string,
  expectedAgentId?: string,
  opts: { keepPersisted?: boolean } = {},
): boolean => {
  const rec = runningChats.get(taskId);
  if (!rec) {
    if (!opts.keepPersisted) void setTaskSessionAgentId(taskId, undefined);
    return false;
  }
  // 审查发现：旧 run 收尾缺 agentId 门控时，切模型 forceClear 后迟到的 cancelled 分支会误关新会话
  if (expectedAgentId !== undefined && rec.agentId !== expectedAgentId) {
    return false;
  }
  runningChats.delete(taskId);
  setChatAwaitingNotifier(taskId, null);
  if (rec.agent) {
    try {
      rec.agent.close();
    } catch {
      /* noop */
    }
  }
  if (!opts.keepPersisted) void setTaskSessionAgentId(taskId, undefined);
  return true;
};

// V0.11.1：chat 会话空闲回收（同 task-runner sweeper、TTL 2h、resume 兜恢复）
const CHAT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const CHAT_SWEEPER_KEY = "__feAiFlowChatSweeperV1__";
{
  const g = globalThis as unknown as Record<string, NodeJS.Timeout | undefined>;
  if (!g[CHAT_SWEEPER_KEY]) {
    g[CHAT_SWEEPER_KEY] = setInterval(() => {
      const now = Date.now();
      for (const [taskId, rec] of runningChats) {
        if (rec.runActive) continue;
        if (now - rec.lastActiveAt > CHAT_IDLE_TTL_MS) {
          console.log(`[chat-runner] 会话空闲回收 task=${taskId}（可 resume 接回）`);
          closeChatSession(taskId, rec.agentId, { keepPersisted: true });
        }
      }
    }, 10 * 60 * 1000);
    g[CHAT_SWEEPER_KEY]?.unref?.();
  }
}

/**
 * 中断 chat（按 taskId）、返回是否真有会话被停。
 *
 * 为什么单独需要：chat 会话注册在本模块的 runningChats、不在 task-runner 的
 * runningTasks（见文件顶部说明）、所以 /stop route 的 cancelTaskRun 停不到它、
 * 必须额外调本函数。一个 task 只会落两个 map 之一、调用方两个都试即可。
 *
 * V0.11：run 在跑 → cancel（run 收尾分支会关会话）；idle 会话 → 直接关。
 */
export const cancelChatRun = (taskId: string): boolean => {
  const rec = runningChats.get(taskId);
  if (!rec) return false;
  if (rec.runActive) {
    rec.cancel();
  } else {
    closeChatSession(taskId);
  }
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
 * 强清 chat 会话运行时状态。
 * 仅 waitForChatToStop 超时兜底用：旧 Run cancel 卡住没按期退、强清好让新会话起得来。
 * 无条件关（用户侧切模型重启意图）；旧 Run 迟到的收尾须带 agentId 门控、不会再误关新会话。
 */
export const forceClearChatRun = (taskId: string): void => {
  closeChatSession(taskId);
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
 * 跟 V0.6 task-runner 的 _super.md 完全无关、不夹任务容器协议（[NEXT_ACTION] / [USER_MESSAGE]）。
 * 回合纪律见 chatTurnProtocolSection（含 ask_user 答题卡）；submit_work 在 chat 不用。
 *
 * 有 firstMessage：直接拼进 prompt、agent 第一 turn 就回答
 * 无 firstMessage：起手等用户发第一句（边界情况）
 */
const buildInitialPrompt = (
  task: Task,
  skills: SkillEntry[],
  rulesSection: string,
  firstMessage?: InitialUserMessage,
  /** 飞书项目推导的发起人姓名行；空串 = 不注入 */
  userIdentityLine = "",
  /** GitLab 访问段（绑仓 + 配了 gitToken 时注入；空串 = 不注入） */
  gitlabAccessSection = "",
): string => {
  const eventsLogPath = getEventsLogPath(task.id);

  const lines: string[] = [
    "你正在 ai-flow 的 **Chat 任务**里跑——一个自由对话助手。和用户来回聊、答疑、查资料、读写代码都行。",
    "",
    `任务 ID：\`${task.id}\``,
    `任务标题：${task.title}`,
  ];
  // 身份行 = 姓名（meegle）+ 设置页角色（v1.1.3 起角色只从设置取）；两者都拿不到整行跳过
  if (userIdentityLine.trim()) {
    lines.push(userIdentityLine.trim());
  }
  lines.push(
    "",
    // 回合协议（正常多轮对话、说完自然结束回复）单一源、见 wait-protocol-prompt.ts
    chatTurnProtocolSection(),
    "",
    "## 你能用的工具",
    "",
    "SDK 内置工具（**名字不带 `_file` 后缀**、就是 `read` / `edit` / `write`、不是 `read_file` 之类）：",
    "  - `read` 读文件（图片自动走 vision）　`grep` 搜内容　`glob` 找文件名",
    "  - `shell` 跑命令　`edit` 改已有文件　`write` 建新文件 / 整文件覆盖　`delete` 删文件　`task` 分派子任务",
    "",
    "另外还有用户配的其他 MCP（飞书 / context7 等）、按场景用。",
    "",
    "## 用户规则（必遵守）",
    "",
    "下面是用户在能力页配置的规则、每条都必须遵守：",
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
    `## 任务 cwd（agent shell / read 默认基准目录）：${formatRepoSectionForPrompt(task.repoPaths, {
      nonGitRepoPaths: task.nonGitRepoPaths,
      originalRepoPaths: task.repoPaths,
    })}`,
    "",
  );
  // 绑了只读仓：紧挨 cwd 注入只读约定（chat 没有单独「仓库分支配置」段）
  const readonlyDirective = renderReadonlyRepoDirective(task);
  if (readonlyDirective) {
    lines.push(readonlyDirective, "");
  }
  // 绑了脚本仓：同位置注入脚本仓性质说明（与只读约定独立、两层解耦）
  const scriptDirective = renderScriptRepoDirective(task);
  if (scriptDirective) {
    lines.push(scriptDirective, "");
  }
  // 绑仓 + settings 有 gitToken → 注入 GitLab 访问说明（纯聊天不注）
  if (gitlabAccessSection.trim()) {
    lines.push(gitlabAccessSection.trim(), "");
  }
  lines.push(
    "## 任务事件日志（按需读、`chat-history-recovery` skill 详述）",
    "",
    `  \`${eventsLogPath}\``,
    "",
    renderContextDocsSection(
      task,
      "→ 用户没传上下文文档、按对话内容判断要不要主动调 MCP / read / grep 摸资料。",
    ),
    "",
  );

  // 起手姿势：有首条 → 直接答；无首条 → submit_work 起手等
  lines.push(...buildOpeningStanceSection(task.id, firstMessage));

  return lines.join("\n");
};

/**
 * 起手姿势段：根据有没有首条用户消息分两种
 *
 * - 有首条（99% 场景）：直接答用户首条、答完结束回复
 * - 没首条（极少数边界）：直接结束回复、等用户第一条消息（会以新消息送达）
 */
const buildOpeningStanceSection = (
  taskId: string,
  firstMessage?: InitialUserMessage,
): string[] => {
  void taskId;
  if (!firstMessage) {
    return [
      "## 起手姿势（无首条消息）",
      "",
      "本任务尚无用户首条消息：直接结束本轮回复即可、用户的第一句会作为新消息发给你。",
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
  // recency 钉子：钉在用户首条之后、治「只说『我这就写』就结束回复、没真把正文输出」
  lines.push(
    "把给用户的**完整答案直接写出来**（正常输出、会实时显示）、说完自然结束回复。别只说「我这就写 / 我先查」就结束——要的是成品本身。",
    "",
  );
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
      // 区分 submit_work / 其他工具：submit_work 的成功调用不刷事件（notifier 已处理 awaiting）。
      // 必须连 MCP wrapper 一起认——漏认会把 submit_work 写成普通 tool_call、
      // 被兜底 A 误当「答后又干活」拦下（2026-06-16 线上事故根因）。
      const isWaitForUser =
        msg.name === "submit_work" ||
        msg.name === "Wait For User" ||
        innerToolName === "submit_work" ||
        innerToolName === "Wait For User";
      if (isWaitForUser) {
        if (msg.status === "error") {
          await writeEventAndPublish(taskId, {
            kind: "error",
            text: `submit_work 工具调用失败：${truncate(stringifyMeta(msg.result), 200)}`,
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

  // 打点（v1.1.x「SDK 比 IDE 慢」排查）：启动链路各段耗时、[perf] 前缀统一可 grep 统计
  const perfStart = Date.now();

  // 句柄 + 取消标志提到最前：配合下面「进入即占位注册」消除冷启动竞态——
  // Agent.create / agent.send / MCP 健康探测都要数秒、旧版到 send 之后才注册进 runningChats、
  // 这几秒窗口里点停止 cancelChatRun 会 get 不到、扑空（连 cancelled 都来不及设）、
  // run 照常启动复述 + 回复（用户实测「已停止但 AI 还回了」就是这窗口、V0.7.23 修）。
  let agent: ChatAgent | null = null;
  let run: ChatRun | null = null;
  let cancelled = false;

  // cancel 收尾：关会话 + 归位 idle + publish done（不落 info——主动停时 /stop route 已落「用户停止了对话」、避免重复）
  // 带本 run 的 agentId（占位期为空串）：forceClear 后新会话已就位则门控拒绝且表非空 → 整段跳过
  const finishCancelled = async (): Promise<void> => {
    const myAgentId = agent?.agentId ?? "";
    const closed = closeChatSession(task.id, myAgentId);
    if (!closed && runningChats.has(task.id)) return;
    const t = await setTaskRunStatus(task.id, "idle");
    if (t) publish(task.id, { kind: "task", task: t });
    publish(task.id, { kind: "done", task: t ?? task, ok: true });
  };

  // 进入即占位注册：任何时刻（含 create/send/MCP 探测冷启动期）点停止、cancelChatRun 都能命中、
  // 置 cancelled（有 run 时一并真取消 SDK run）；agentId 先空、send 出来再回填。
  runningChats.set(task.id, {
    agentId: "",
    startedAt: Date.now(),
    agent: null,
    runActive: true,
    lastActiveAt: Date.now(),
    // 记下本会话绑定模型、供「切模型懒重启」比对（见 chat-reply route）
    model,
    // 记下本会话绑定的 MCP 黑名单快照（下面 filterDisabledMcp 按它过滤）、供「切 MCP 懒重启」比对
    disabledMcpServers: task.disabledMcpServers ?? [],
    cancel: () => {
      cancelled = true;
      if (run) void run.cancel().catch(() => {});
    },
  });

  try {
    // 1) 切到 running、写一条 info event
    const startedTask = await setTaskRunStatus(task.id, "running");
    if (startedTask) publish(task.id, { kind: "task", task: startedTask });

    // 2) 拼 mcpServers：fe 自管 MCP（按 task 黑名单过滤）+ 我们自己的 chat-tool
    // （settingSources:[] 不加载任何 .cursor mcp；全局 / 项目 MCP 一律走 fe 自管配置）
    // 配置里万一也叫 aiFlowChat、按我们的为准（直接覆盖）
    // 注入 OAuth token：走 OAuth 授权的远程 MCP（如飞书项目）token 不在 mcp.json、
    // 由 fe 自己跑过 OAuth 落盘、起 agent 前补到 headers.Authorization、详见 mcp-oauth.ts
    const perfMcpStart = Date.now();
    const enrichedMcp = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(task.disabledMcpServers),
    );
    // V0.6.11 容错：起 agent 前剔除连不上 / 未授权的远程 MCP、单个 MCP 挂不拖垮整个 run
    const { servers: cursorMcp, dropped: droppedMcp } =
      await filterHealthyMcp(enrichedMcp);
    const perfMcpMs = Date.now() - perfMcpStart;
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

    // 3) 注入 awaiting notifier（V0.11.1 抽成共用、resume 时也要重注册）
    registerChatNotifier(task);

    // prompt 素材与 Agent.create 并行（v1.1.x 提速）：skills / rules 读盘、identity 走
    // meegle CLI、gitlab 段读 settings + 推 remote host——都不依赖 agent、重叠后首 token 提前。
    // 侧挂 catch 防「create 期间先 reject」的 unhandledRejection 噪音（await 时仍抛给外层 catch）。
    const skillsPromise = loadSkills().catch((err) => {
      console.error("[chat-runner] loadSkills failed", err);
      return [];
    });
    const rulesPromise = readAppRulesForPrompt();
    rulesPromise.catch(() => {});
    const identityPromise = resolveUserIdentityForPrompt();
    identityPromise.catch(() => {});
    const gitlabAccessPromise = (async (): Promise<string> => {
      // 绑仓 + settings 有 gitToken 才注入「GitLab 访问」（纯聊天不需要）
      if (task.repoPaths.length === 0) return "";
      const settingsResult = await readSettingsFile();
      const settings =
        settingsResult.status === "ok" ? settingsResult.settings : null;
      const gitToken =
        typeof settings?.gitToken === "string" ? settings.gitToken.trim() : "";
      if (!gitToken) return "";
      // host 一律按任务仓库 remote 现推（不再读 settings.gitHost）
      const effectiveHost =
        (await resolveEffectiveGitHost(task.repoPaths)) ?? undefined;
      return buildGitlabAccessDirective(effectiveHost, dataRoot());
    })();
    gitlabAccessPromise.catch(() => {});

    // 4) 启动 agent + 流式消费
    const perfCreateStart = Date.now();
    agent = await Agent.create({
      apiKey,
      model,
      // settingSources:[] = 不加载任何 .cursor/（彻底脱离 Cursor 安装 / 项目配置）。
      // 曾用 ["project"] 时未绑工作目录 cwd=homedir → 把 ~/.cursor MCP 整包漏进 agent（实锤）。
      // rules / skills / mcp 全部由 fe 自管注入（readAppRulesForPrompt / loadSkills / inline mcpServers）。
      local: {
        // 未绑工作目录（自由对话没选目录）→ cwd 用用户主目录、不用 process.cwd()
        //（打包后 = app 内部目录、对终端用户无意义）。对齐 codex（默认终端 pwd）/
        // Cursor（默认 workspace）：总给个用户地盘的合法 cwd、要 agent 干活就让用户选目录。
        cwd:
          task.repoPaths.length > 0
            ? getEffectiveCwd(task.repoPaths)
            : os.homedir(),
        settingSources: [],
      },
      mcpServers: mergedMcp,
    });
    const perfCreateMs = Date.now() - perfCreateStart;

    // Agent.create 冷启动也要数秒、create 期间被停 → 别 send、直接收尾
    if (cancelled) {
      await finishCancelled();
      return;
    }

    // 收割 create 前发起的并行加载（见上）
    const perfPromptStart = Date.now();
    const skills = await skillsPromise;
    const rulesSection = await rulesPromise;
    const userIdentityLine = await identityPromise;
    const gitlabAccessSection = await gitlabAccessPromise;
    const initialPrompt = buildInitialPrompt(
      task,
      skills,
      rulesSection,
      firstMessage,
      userIdentityLine,
      gitlabAccessSection,
    );
    const perfPromptMs = Date.now() - perfPromptStart;

    const perfSendStart = Date.now();
    const promptBytes = Buffer.byteLength(initialPrompt, "utf-8");
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: agent.agentId,
      runKind: "chat-first",
      promptBytes,
    });
    run = await agent.send(initialPrompt, {
      onDelta: perfTracker.onDelta,
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
    // 单行汇总（不写 events、纯日志）：mcp=探测+merge、create=SDK 冷启动、
    // prompt=素材收割+拼装（含首包字节数）、send=Run 受理、total=自进入本函数起
    console.log(
      `[perf] task=${task.id} chat start-chain ` +
        `mcp=${perfMcpMs}ms create=${perfCreateMs}ms ` +
        `prompt=${perfPromptMs}ms/${Math.round(promptBytes / 1024)}KB ` +
        `send=${Date.now() - perfSendStart}ms total=${Date.now() - perfStart}ms`,
    );

    // 回填真实 agentId / agent 实例（占位注册时是空串 / null）——从此会话可被 send 续接。
    // agentId 同步落盘（V0.11.1 会话持久化）：服务重启后 Agent.resume 接回
    const rec = runningChats.get(task.id);
    if (rec) {
      rec.agentId = agent.agentId;
      rec.agent = agent;
    }
    void setTaskSessionAgentId(task.id, agent.agentId);

    // send 期间被停 → run 已就位、真取消它再收尾
    if (cancelled) {
      void run.cancel().catch(() => {});
      await finishCancelled();
      return;
    }

    await consumeChatRun(task, run, () => cancelled);
  } catch (err) {
    // Agent.create / send 阶段失败（consumeChatRun 内部错误它自己处理、不会抛）
    // 占位期 agentId 可能仍为空串——与 finishCancelled 同口径门控
    await handleChatRunFailure(task, err, agent?.agentId ?? "");
  }
};

// ----------------- V0.11.1：notifier 注册 + 会话恢复 -----------------

// chat 的 awaiting notifier：ask_user 写真实 ask_user_request 事件（与 task-runner 对齐）；
// submit_work 误调仍只切 awaiting_user（chat 不用交卷）
const registerChatNotifier = (task: Task): void => {
  setChatAwaitingNotifier(task.id, async (signal) => {
    if (signal.kind === "ask_user_request") {
      // 新提问落盘前作废旧的未了结提问（同 task-runner：防旧答题卡复活）
      await supersedePendingAsks(task.id, "被新提问顶替");
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      await writeEventAndPublish(task.id, {
        kind: "ask_user_request",
        // chat 无 action——有 actionId 才带（误传也无害）
        ...(signal.actionId ? { actionId: signal.actionId } : {}),
        text: previewText,
        meta: {
          askId: signal.askId,
          token: signal.token,
          questions: signal.questions,
        },
      });
      const updated = await setTaskRunStatus(task.id, "awaiting_user");
      if (updated) publish(task.id, { kind: "task", task: updated });
      return;
    }
    // submit_work 等非 ask 信号：chat 不用交卷、只切 awaiting_user
    const updated = await setTaskRunStatus(task.id, "awaiting_user");
    if (updated) publish(task.id, { kind: "task", task: updated });
  });
};

/**
 * V0.11.1：从落盘的 sessionAgentId 恢复 chat 会话（服务重启 / 空闲回收后）。
 * 成功 = 会话表就位（runActive=false、可立即 sendChatMessage）；失败 = 清锚点返 false。
 */
export const resumeChatSession = async (
  task: Task,
  bootArgs: { apiKey: string; model: ModelSelection },
): Promise<boolean> => {
  if (!task.sessionAgentId || runningChats.has(task.id)) return false;
  try {
    // inline MCP 不随 resume 持久化、重传（同 runChatSession 的 merge 逻辑）
    const enrichedMcp = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(task.disabledMcpServers),
    );
    const { servers: cursorMcp } = await filterHealthyMcp(enrichedMcp);
    const mergedMcp: Record<string, McpServerConfig> = {
      ...cursorMcp,
      [CHAT_TOOL_MCP_NAME]: { type: "http", url: getChatMcpUrl() },
    };
    const agent = await Agent.resume(task.sessionAgentId, {
      apiKey: bootArgs.apiKey,
      // 恢复的本地 agent 不保留 model、后续 send 会报 ConfigurationError（实测踩过）——显式传
      model: bootArgs.model,
      // 本地 agent 按 cwd 定位持久化存储、必须跟 create 时一致（不传会 AgentNotFoundError、实测踩过）
      // settingSources:[] 同 create——不加载 .cursor/、全部 fe 自管注入
      local: {
        cwd:
          task.repoPaths.length > 0
            ? getEffectiveCwd(task.repoPaths)
            : os.homedir(),
        settingSources: [],
      },
      mcpServers: mergedMcp,
    });
    runningChats.set(task.id, {
      agentId: agent.agentId,
      startedAt: Date.now(),
      agent,
      runActive: false,
      lastActiveAt: Date.now(),
      model: bootArgs.model,
      disabledMcpServers: task.disabledMcpServers ?? [],
      cancel: () => {},
    });
    registerChatNotifier(task);
    console.log(
      `[chat-runner] task=${task.id} 会话已恢复（Agent.resume agentId=${agent.agentId}）`,
    );
    return true;
  } catch (err) {
    // V0.13.x：网络类失败不清锚点（自动重连还要靠它再试）；确定性失败才清
    const m = err instanceof Error ? err.message : String(err);
    if (isRetryableRunError(m, err)) {
      console.warn(
        `[chat-runner] task=${task.id} Agent.resume 网络类失败（保留锚点、可重试）`,
        err,
      );
      return false;
    }
    console.warn(
      `[chat-runner] task=${task.id} Agent.resume 失败（清锚点、降级新会话）`,
      err,
    );
    void setTaskSessionAgentId(task.id, undefined);
    return false;
  }
};

// ----------------- V0.13.x：chat run 网络断自动重连（同 task-runner 口径、重试 5 次） -----------------

const RECONNECT_MAX = 5;
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

// 服务端凭据兜底（重连时没有 client bootArgs）：读 config.json
const readServerChatCreds = async (): Promise<{
  apiKey: string;
  model: ModelSelection;
} | null> => {
  try {
    const raw = await fs.readFile(path.join(dataRoot(), "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as {
      apiKey?: string;
      defaultModel?: ModelSelection;
    };
    if (!cfg.apiKey || !cfg.defaultModel?.id) return null;
    return { apiKey: cfg.apiKey, model: cfg.defaultModel };
  } catch {
    return null;
  }
};

// 可中断 sleep（1s 分片）：退避期间用户停止要立即生效
const sleepWithCancel = async (
  ms: number,
  isCancelled: () => boolean,
): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (isCancelled()) return true;
    await new Promise((r) => setTimeout(r, Math.min(1_000, deadline - Date.now())));
  }
  return isCancelled();
};

/**
 * chat run 网络类失败的自动重连：写「重连中 n/5」事件 → 退避 → resumeChatSession 接回 →
 * send 系统提示继续 → 递归消费新 run。返回 true = 已接管（无论最终成败、后续都在递归里处理）。
 */
const tryChatAutoReconnect = async (
  task: Task,
  err: unknown,
  attempt: number,
  isCancelled: () => boolean,
): Promise<boolean> => {
  if (attempt > RECONNECT_MAX) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (!isRetryableRunError(msg, err)) return false;
  if (isCancelled()) return false;
  const fresh = await getTask(task.id);
  if (!fresh || fresh.repoStatus === "merged" || fresh.repoStatus === "abandoned") {
    return false;
  }
  await writeEventAndPublish(task.id, {
    kind: "info",
    text: `连接中断、正在自动重连（第 ${attempt}/${RECONNECT_MAX} 次）…`,
    meta: { kind: "reconnecting", attempt, max: RECONNECT_MAX },
  });
  if (await sleepWithCancel(RECONNECT_BACKOFF_MS[attempt - 1], isCancelled)) {
    return false;
  }
  // 内存会话关掉、**锚点必须保留**（resumeChatSession 靠 sessionAgentId 接回）
  const curRec = runningChats.get(task.id);
  closeChatSession(task.id, curRec?.agentId, { keepPersisted: true });
  const creds = await readServerChatCreds();
  if (!creds) return false;
  const resumed = await resumeChatSession(fresh, creds).catch(() => false);
  if (!resumed) {
    return tryChatAutoReconnect(fresh, err, attempt + 1, isCancelled);
  }
  const rec = runningChats.get(task.id);
  if (!rec?.agent) return false;
  try {
    const reconnectPrompt =
      "（系统消息：刚才网络连接中断、你上一轮回复被打断。请从中断的地方继续——已说完的不用重复、接着回答即可。）";
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: rec.agent.agentId,
      runKind: "chat-reconnect",
      promptBytes: Buffer.byteLength(reconnectPrompt, "utf-8"),
    });
    const run = await rec.agent.send(reconnectPrompt, {
      onDelta: perfTracker.onDelta,
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
    await writeEventAndPublish(task.id, {
      kind: "info",
      text: `重连成功（第 ${attempt} 次）、AI 继续回复`,
      meta: { kind: "reconnected", attempt },
    });
    rec.runActive = true;
    await consumeChatRun(fresh, run, undefined, attempt);
    return true;
  } catch (sendErr) {
    return tryChatAutoReconnect(fresh, sendErr, attempt + 1, isCancelled);
  }
};

// ----------------- V0.11：chat run 消费管道（首个 run + 后续 send 共用） -----------------

// run 失败的统一收尾：关会话 + 标 error + 事件 + publish
// expectedAgentId：旧 run 收尾带上门控；已被新会话顶替则整段 no-op（防误标 error / 误关）
const handleChatRunFailure = async (
  task: Task,
  err: unknown,
  expectedAgentId?: string,
): Promise<void> => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[chat-runner] task", task.id, "failed:", err);
  // run 失败可能是「缓存 ok 期间 MCP 挂了」——清探测缓存、用户重试时必真探（同 task-runner）
  invalidateMcpProbeCache();
  const closed = closeChatSession(task.id, expectedAgentId);
  // 门控拒绝且新会话已就位 → 跳过；表已空（forceClear 后）→ 仍落 error（旧行为）
  if (!closed && runningChats.has(task.id)) return;
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
  publish(task.id, { kind: "done", task: finalTask ?? task, ok: false });
  publish(task.id, { kind: "error", message: eventText });
};

/**
 * 消费一个 chat run 的完整生命周期。
 * 自然 finished = 正常出口：runStatus → awaiting_user（等下一条消息）、**会话保留**；
 * cancel / error → 关会话（下一条消息起新会话、靠 events.jsonl 恢复上下文）。
 */
const consumeChatRun = async (
  task: Task,
  run: ChatRun,
  externallyCancelled?: () => boolean,
  // V0.13.x 自动重连计数（tryChatAutoReconnect 递归时递增、防无限重连）
  reconnectAttempt = 0,
): Promise<void> => {
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;
  const rec = runningChats.get(task.id);
  if (rec) {
    rec.runActive = true;
    rec.cancel = () => {
      cancelled = true;
      void run.cancel().catch(() => {});
    };
  }
  try {
    // 兜底硬超时：24h
    hardTimer = setTimeout(() => {
      cancelled = true;
      void run.cancel().catch(() => {});
    }, CHAT_HARD_TIMEOUT_MS);

    // 流式消费 + buffer flush：一轮完整回复 → 一条 assistant_message 事件
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

    // 打点：send 受理到首个流事件（≈首 token）的等待——量化「首包预填」开销
    const perfStreamStart = Date.now();
    let perfFirstEventSeen = false;
    for await (const msg of run.stream()) {
      if (!perfFirstEventSeen) {
        perfFirstEventSeen = true;
        console.log(
          `[perf] task=${task.id} first-event ms=${Date.now() - perfStreamStart}`,
        );
      }
      // handleSdkMessage 内部已在 thinking / tool_call case 自己 flush buffer
      await handleSdkMessage(task.id, msg, ctx);
    }
    await ctx.flush();

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    const result = await run.wait();

    if (cancelled || externallyCancelled?.() || result.status === "cancelled") {
      // cancel 收尾：关会话 + 归位 idle + publish done、不落 info——
      // 用户主动停时 /stop route 已落「用户停止了对话」、这里再落会重复。
      // 带本 run agentId：切模型 forceClear 后新会话已注册则门控拒绝且表非空 → 跳过
      const closed = closeChatSession(task.id, rec?.agentId ?? "");
      if (!closed && runningChats.has(task.id)) return;
      const cancelledTask = await setTaskRunStatus(task.id, "idle");
      if (cancelledTask) publish(task.id, { kind: "task", task: cancelledTask });
      publish(task.id, { kind: "done", task: cancelledTask ?? task, ok: true });
      return;
    }

    if (result.status !== "finished") {
      const sdkErr = ctx.sdkErrorMessage
        ? `\n--- SDK stream error message ---\n${ctx.sdkErrorMessage}`
        : "";
      // dump 完整 result（对齐 task-runner）：运行时可能藏未声明字段、落 dump 供事后定位
      const resultDump = stringifyMeta(result).slice(0, 1500);
      throw new Error(
        `agent run status=${result.status}${
          result.result ? `: ${result.result.slice(0, 200)}` : ""
        }${sdkErr}\n--- SDK result dump ---\n${resultDump}`,
      );
    }

    // 自然 finished：agent 答完这轮、等用户下一条（会话保留、send 续接）
    if (rec) {
      rec.runActive = false;
      rec.lastActiveAt = Date.now();
    }
    const doneTask = await setTaskRunStatus(task.id, "awaiting_user");
    if (doneTask) publish(task.id, { kind: "task", task: doneTask });
    publish(task.id, { kind: "done", task: doneTask ?? task, ok: true });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    // V0.13.x：网络类失败先自动重连（重试 5 次、事件流显示「重连中」）
    const handled =
      !cancelled &&
      !externallyCancelled?.() &&
      (await tryChatAutoReconnect(
        task,
        err,
        reconnectAttempt + 1,
        () => cancelled || !!externallyCancelled?.(),
      ));
    if (!handled) {
      await handleChatRunFailure(task, err, rec?.agentId ?? "");
    }
  }
};

// ----------------- V0.11：sendChatMessage（续接存活会话） -----------------

/**
 * 把用户新消息发给存活的 chat 会话（`agent.send`）、消费产生的新 run。
 *
 * @returns false = 没有可续接的会话（没记录 / agent 没就位 / run 在跑 / send 抛错）、
 *          调用方（chat-reply 路由）走 runChatSession 起新会话
 */
export const sendChatMessage = async (
  task: Task,
  text: string,
  imagePaths?: string[],
  attachmentPaths?: string[],
): Promise<boolean> => {
  const rec = runningChats.get(task.id);
  if (!rec || !rec.agent || rec.runActive) return false;

  // 审查发现：校验通过到 await send 完成之间有 TOCTOU，并发双发（连点/双标签）都能通过检查 →
  // 立刻占位；send 抛错时清回 false（consumeChatRun 入口置 true 保持幂等）
  rec.runActive = true;

  // 组消息：正文 + 附件段（图走 read 转 vision、路径自己 read/grep）
  const lines: string[] = [text];
  if (imagePaths && imagePaths.length > 0) {
    lines.push(
      "",
      "[ATTACHED_IMAGES] 用户附了以下图片、请用 `read` 工具逐一读取（会转成 vision、你能直接看到图像内容）：",
      ...imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
    );
  }
  if (attachmentPaths && attachmentPaths.length > 0) {
    lines.push(
      "",
      "[ATTACHED_PATHS] 用户附了以下文件 / 目录路径、按需用 `read` / `grep` / `glob` 读取：",
      ...attachmentPaths.map((p, i) => `  ${i + 1}. ${p}`),
    );
  }

  let run: ChatRun;
  try {
    const prompt = lines.join("\n");
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: rec.agent.agentId,
      runKind: "chat-followup",
      promptBytes: Buffer.byteLength(prompt, "utf-8"),
    });
    run = await rec.agent.send(prompt, {
      onDelta: perfTracker.onDelta,
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
  } catch (err) {
    rec.runActive = false;
    console.error(`[chat-runner] sendChatMessage: task=${task.id} send 失败`, err);
    closeChatSession(task.id, rec.agentId);
    return false;
  }
  rec.lastActiveAt = Date.now();

  // 切 running + fire-and-forget 消费
  const runningTask = await setTaskRunStatus(task.id, "running");
  if (runningTask) publish(task.id, { kind: "task", task: runningTask });
  void consumeChatRun(task, run);
  return true;
};

/**
 * 把 ask_user 答案送达 chat 会话（ask-reply 路由 chat 分支用）。
 *
 * 路径（对齐 chat-reply、绝不能走 task 的 resumeCurrentActionWithMessage）：
 *   1. 存活会话 → sendChatMessage
 *   2. 内存无会话但有 sessionAgentId + bootArgs → resume 后再 send
 *   3. 仍接不回 → 凭 bootArgs 起新会话、答案作首条 firstMessage
 *
 * @returns false = 没凭据起不了新会话、调用方报错让用户用输入条唤醒
 */
export const deliverChatAskReply = async (
  task: Task,
  replyText: string,
  imagePaths?: string[],
  bootArgs?: { apiKey?: string; model?: ModelSelection },
): Promise<boolean> => {
  // 1) 存活会话直接 send
  if (hasChatSession(task.id)) {
    const sent = await sendChatMessage(task, replyText, imagePaths);
    if (sent) return true;
    // send 失败已 close 会话 → 落到下面 resume / 新会话
  }

  const apiKey = bootArgs?.apiKey?.trim() || undefined;
  const model =
    bootArgs?.model && typeof bootArgs.model.id === "string"
      ? bootArgs.model
      : undefined;

  // 2) 服务重启 / 空闲回收后：Agent.resume 接回再 send
  if (task.sessionAgentId && apiKey && model && !hasChatSession(task.id)) {
    const resumed = await resumeChatSession(task, { apiKey, model });
    if (resumed) {
      const sent = await sendChatMessage(task, replyText, imagePaths);
      if (sent) return true;
    }
  }

  // 3) 起新会话（答案作首条）——同 chat-reply 模式 2
  if (!apiKey || !model) return false;
  if (hasChatSession(task.id)) {
    // race：resume 后别处又起了 run → 再试一次 send
    return sendChatMessage(task, replyText, imagePaths);
  }

  const runningTask = await setTaskRunStatus(task.id, "running");
  if (runningTask) publish(task.id, { kind: "task", task: runningTask });
  // ⚠️ 上面 await 是让出点：期间别处（chat-reply / resume）可能已注册会话——
  // runChatSession 开头的幂等 return 会**静默吞掉 firstMessage**（答案丢失且无
  // 错误事件、调用方却报成功）。复查一次、已有会话就改走 send 续接。
  if (hasChatSession(task.id)) {
    return sendChatMessage(task, replyText, imagePaths);
  }
  void runChatSession({
    task: runningTask ?? task,
    apiKey,
    model,
    firstMessage: {
      text: replyText,
      imagePaths: imagePaths && imagePaths.length > 0 ? imagePaths : undefined,
    },
  }).catch((err) => {
    console.error(
      `[chat-runner] deliverChatAskReply runChatSession task=${task.id} failed:`,
      err,
    );
  });
  return true;
};
