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
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  appendEvent,
  clearTaskSessionAgentIdIf,
  getTask,
  setTaskRunStatus,
  setTaskSessionAgentId,
} from "./task-fs";
import { getEventsLogPath } from "./task-fs-core";
import { getChatMcpUrl } from "./chat-mcp";
import {
  cancelPendingIf,
  getPendingAsk,
  setChatAwaitingNotifier,
} from "./chat-pending";
import { failpoint } from "./failpoints";
import { chatTurnProtocolSection } from "./turn-discipline";
import { buildWindowsToolDisciplineDirective } from "./windows-tool-discipline";
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
  composeOnDelta,
  createShellOutputDeltaPublisher,
} from "./shell-output-bridge";
import {
  handleSdkMessage,
  type AssistantBufferCtx,
} from "./sdk-message-handler";
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
  allocTaskRunInstanceId,
  publishTaskStreamEvent,
  stringifyMeta,
  writeEventAndPublish,
  writeOwnedEventAndPublish,
  type TaskStreamEvent,
} from "./task-stream";
import { MCP_HEALTH_LABEL } from "@/lib/types";
import type { Task } from "@/lib/types";
import {
  beginChatQueueInFlight,
  clearChatQueue,
  dequeueChatMessage,
  endChatQueueInFlight,
  enqueueChatMessage,
  enqueueChatMessageFront,
  getChatQueueCount,
  getChatQueueGeneration,
  type QueuedChatMsg,
} from "./chat-queue";
import {
  getChatContextUsage,
  markChatAutoCompactAttempted,
  recordChatFirstPromptBytes,
  recordChatTurnUsage,
  shouldAutoCompactAfterTurn,
} from "./chat-context-usage";
import {
  buildCompactContinuationSection,
  buildCompactSummarizePrompt,
  extractCompactSummaryText,
  MIN_COMPACT_SUMMARY_CHARS,
} from "./chat-compact-prompt";
import {
  captureChatCheckpoint,
  persistCheckpointForReply,
} from "./chat-checkpoint";
import {
  isChatRewindInProgress,
  isChatStartLeaseValid,
  releaseChatStart,
  tryReserveChatStart,
} from "./chat-gate";

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
  /**
   * 内存实例代际（每次 runningChats.set 分配、进程内单调递增、永不复用）。
   * 复审 J1：Agent.resume 恢复同一持久化 agent 时 agentId 相同，agentId 无法区分
   * 「退避前的坏实例」和「退避期间用户 resume 出的新实例」——所有异步收尾 / 重连
   * 让位判断必须按 instanceId 门控，不能按 agentId。
   */
  instanceId: number;
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
  // 本会话启动时绑定的工作目录快照（Agent.create local.cwd 定死、会话期间不可变）。
  // 切 workdir 懒重启用：chat-workdir-picker 改了 repoPaths 后发下条消息，比对决定续接还是重开
  //（此前只比 model/MCP → 同会话 send 仍用旧 cwd，P1.5 真 bug）。
  repoPaths: string[];
}

interface ChatRunnerGlobalState {
  // taskId → 运行中的 chat 控制对象
  runningChats: Map<string, RunningChatRecord>;
  /**
   * flushChatQueue 正在 drain 的 taskId（dequeue → send 整段）。
   * 解决 P2 #8：run 结束后 async drain 真正 send 前，新 chat-reply 看到 idle
   * 会话直接 send，新消息 C 越过已排队的 B。chat-reply 见此标记则入队保 FIFO。
   */
  drainingQueues: Set<string>;
  /** RunningChatRecord.instanceId 发号器（进程内单调、hot reload 也不回退） */
  nextChatInstanceId: number;
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
      drainingQueues: new Set(),
      nextChatInstanceId: 1,
    };
  }
  // hot-reload：旧 state 可能缺 drainingQueues（V2 后加的字段）
  if (!g[CHAT_RUNNER_GLOBAL_KEY]!.drainingQueues) {
    g[CHAT_RUNNER_GLOBAL_KEY]!.drainingQueues = new Set();
  }
  // hot-reload：旧 state 可能缺 nextChatInstanceId（J1 后加的字段）
  if (typeof g[CHAT_RUNNER_GLOBAL_KEY]!.nextChatInstanceId !== "number") {
    g[CHAT_RUNNER_GLOBAL_KEY]!.nextChatInstanceId = 1;
  }
  return g[CHAT_RUNNER_GLOBAL_KEY]!;
};

const runningChats = getRunnerState().runningChats;
const drainingQueues = getRunnerState().drainingQueues;

/** 每次 runningChats.set 前取号：同一持久化 agentId 的两个内存实例也绝不同号 */
const allocChatInstanceId = (): number => getRunnerState().nextChatInstanceId++;

/** 队列 drain 进行中（flushChatQueue 已占位、尚未 finally 清位）——chat-reply 应入队保 FIFO */
export const isChatQueueDraining = (taskId: string): boolean =>
  drainingQueues.has(taskId);

/**
 * 会话对象是否在表（含 run 自然结束后 idle 等用户的健康态）——与 task 侧
 * `agentSessions.has` 语义对齐。⚠️ 不是「run 正在跑」（那是 rec.runActive）；
 * 旧名 hasChatSession 连 AI review 都会误读、2026-07-14 改名。
 */
export const hasChatSession = (taskId: string): boolean =>
  runningChats.has(taskId);

/**
 * V0.11：关掉一个 chat 会话（agent close + 删记录）、best-effort。
 * expectedInstanceId 传了就只在「当前会话确实是那个内存实例」时才关（异步收尾路径防误关新会话）；
 * 不传 = 关当前的（用户主动 stop / forceClear）。对齐 task-runner.closeTaskSession。
 * 复审 J1：门控键从 agentId 改为 instanceId——Agent.resume 恢复同一持久化 agent 时
 * agentId 相同，旧 retry / 迟到收尾按 agentId 会误关退避期间用户恢复的新实例。
 * keepPersisted = 空闲回收用（sessionAgentId 留着、下次消息 Agent.resume 接回）
 * @returns 是否真的关了一个会话
 */
const closeChatSession = (
  taskId: string,
  expectedInstanceId?: number,
  opts: { keepPersisted?: boolean } = {},
): boolean => {
  const rec = runningChats.get(taskId);
  if (!rec) {
    if (!opts.keepPersisted) void setTaskSessionAgentId(taskId, undefined);
    return false;
  }
  // 审查发现：旧 run 收尾缺门控时，切模型 forceClear 后迟到的 cancelled 分支会误关新会话
  if (expectedInstanceId !== undefined && rec.instanceId !== expectedInstanceId) {
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
          closeChatSession(taskId, rec.instanceId, { keepPersisted: true });
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
 *
 * M1 延伸：自动重连的「backoff → resume → send」窗口内表里可能没有 record，
 * 此时用户 stop 也必须让重连停下——先给 reconnect 停止闭包发信号（有 record 时
 * 同样发：reconnect 的 claim record cancel 只摘实例、不通知在退避里的重试者）。
 */
export const cancelChatRun = (taskId: string): boolean => {
  const reconnectStop = getReconnectStops().get(taskId);
  if (reconnectStop) reconnectStop();
  // S3（十二轮）：compact 进行中 → 置事务级 abort，阻止摘要重试与重建「复活」AI
  let compactAborted = false;
  if (isChatCompactInProgress(taskId)) {
    markChatCompactAborted(taskId);
    compactAborted = true;
  }
  const rec = runningChats.get(taskId);
  if (!rec) return !!reconnectStop || compactAborted;
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
 * 读当前活 chat 会话启动时绑定的 repoPaths（无活会话返 null）。
 * 切 workdir 懒重启用：chat-reply 比对「会话绑定 vs 现在 task.repoPaths」决定续接 or 重启。
 */
export const getChatRunRepoPaths = (taskId: string): string[] | null =>
  runningChats.get(taskId)?.repoPaths ?? null;

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
 * 无条件关（用户侧切模型重启意图）；旧 Run 迟到的收尾须带 instanceId 门控、不会再误关新会话。
 */
export const forceClearChatRun = (taskId: string): void => {
  closeChatSession(taskId);
  // 复审（11 轮）：cancelled 槽只在被 owner 消费时删——forceClear（懒重启换新）后
  // 旧 claim 的标记已无消费者，顺手清防泄漏；旧 owner 迟到 send 会按实例不匹配
  // 收敛为 owner_invalid（同为终态 409、语义仍正确）
  getCancelledClaims().delete(taskId);
};

/**
 * 无条件关 chat 会话（清内存 + 落盘 sessionAgentId）。
 * rewind 用：截断对话后必须丢旧 SDK 会话，下条消息自然起新会话靠 events 回读。
 * 同时清排队（P5.1：rewind 后积压消息不应再发）。
 */
export const closeChatSessionUnconditional = (taskId: string): void => {
  clearChatQueue(taskId);
  closeChatSession(taskId);
};

/** 当前 chat 是否有 run 在消费（rewind 前 409 闸门） */
export const isChatRunActive = (taskId: string): boolean =>
  runningChats.get(taskId)?.runActive === true;

/**
 * 仅用于「claimRun 后、owner send 前」的失败释放。
 * 认领态下没有真 run，直接把 runActive 复位 false；无会话时幂等 no-op。
 * why：认领不释放 = 会话永远假 busy、所有消息只进队无人消费。
 *
 * 复审 K1：claim 绑定实例——必须带 expectedInstanceId。当前 record 已不是原 claim
 * 实例（stop 摘除 / forceClear 换新）时整段 no-op，绝不把新实例的 runActive 误清成
 * false（旧 owner 的迟到 release 会给并发 send 开口子）。
 *
 * 复审 H1：释放认领 = 接管排队消息的调度义务。不能留下
 * `session idle && queue>0 && !draining` 的死局（owner 撞 rewind 门闩释放后，
 * B 已 202 入队却无人 flush）。门闩仍在时 flush 入口会直接 return，故走
 * scheduleQueueDrainAfterGate 等门闩解除后再补 drain。
 *
 * 复审 L3：H1 的 handoff 义务仅在「当前 record 就是本 claim 实例」时成立。
 * record 不存在（claim 已被 stop/forceClear 摘除）或实例不匹配都整段 no-op——
 * 此刻队列可能属于正在 startup reservation 的新 owner，迟到 release 若仍调度
 * drain，会在无会话时清掉已 202 的队列、或抢在新 owner 前发送队首破坏顺序。
 * 原 claim 消亡后队列归新 owner / 启动状态机自己负责。
 */
export const releaseChatRunClaim = (
  taskId: string,
  expectedInstanceId: number,
): void => {
  const rec = runningChats.get(taskId);
  if (!rec || rec.instanceId !== expectedInstanceId) return;
  rec.runActive = false;
  if (getChatQueueCount(taskId) > 0 && !drainingQueues.has(taskId)) {
    scheduleQueueDrainAfterGate(taskId);
  }
};

// ----------------- 复审 K1：claim 实例被 stop 摘除的标记 -----------------

/**
 * taskId → 被 cancelChatRun（用户停止）摘除的 claim instanceId。
 * why：owner 在 checkpoint 窗口被 stop 后，owner send 因实例失效返 false；
 * chat-reply 路由必须能区分「用户已停止」（绝不能落到起新会话把消息重放出去——
 * 否则 AI 照样在「已停止」之后启动）与「会话坏了」（走既有降级起新会话）。
 * 一个 task 同时至多一个 claim，Map 单值即可；挂 globalThis 防 dev hot reload 丢失。
 */
const CANCELLED_CLAIMS_KEY = "__feAiFlowChatCancelledClaimsV1__";
const getCancelledClaims = (): Map<string, number> => {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[CANCELLED_CLAIMS_KEY]) g[CANCELLED_CLAIMS_KEY] = new Map();
  return g[CANCELLED_CLAIMS_KEY]!;
};

/** 查询并消费「该 claim 实例被 stop 摘除」标记（一次性、精确匹配 instanceId） */
export const consumeChatClaimCancelled = (
  taskId: string,
  instanceId: number,
): boolean => {
  const m = getCancelledClaims();
  if (m.get(taskId) === instanceId) {
    m.delete(taskId);
    return true;
  }
  return false;
};

// ----------------- M1 延伸：自动重连期间的 stop 信号 -----------------

/**
 * taskId → 正在退避/恢复中的 reconnect 的停止闭包。
 * why：重连的「backoff → Agent.resume → send」大部分时间**表内没有 record**
 *（坏实例已摘、新实例未注册），cancelChatRun 摸不到任何 cancel 入口；用户此时
 * 点停止，stop 路由归位 idle 后重连仍会醒来把会话复活。此表给 stop 一个
 * 跨「无 record 窗口」的信号入口。挂 globalThis 防 dev hot reload 丢失。
 */
const RECONNECT_STOPS_KEY = "__feAiFlowChatReconnectStopsV1__";
const getReconnectStops = (): Map<string, () => void> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, () => void> | undefined
  >;
  if (!g[RECONNECT_STOPS_KEY]) g[RECONNECT_STOPS_KEY] = new Map();
  return g[RECONNECT_STOPS_KEY]!;
};

// ----------------- compact 进行中标记（关旧→起新窗口也要挡并发 send） -----------------

interface ChatCompactGlobalState {
  inProgress: Set<string>;
  /**
   * S3（十二轮）：compact 事务级 abort。cancelChatRun / stop 在 compact 窗口置位，
   * compactChatSession 在摘要重试与重建序列检查点命中后停止后续副作用。
   */
  aborted: Set<string>;
}

// V2：相对 V1 增 aborted；换 key 避免 hot-reload 后读到缺字段的旧 state
const CHAT_COMPACT_GLOBAL_KEY = "__feAiFlowChatCompactV2__";

const getCompactState = (): ChatCompactGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    ChatCompactGlobalState | undefined
  >;
  if (!g[CHAT_COMPACT_GLOBAL_KEY]) {
    g[CHAT_COMPACT_GLOBAL_KEY] = {
      inProgress: new Set(),
      aborted: new Set(),
    };
  }
  if (!g[CHAT_COMPACT_GLOBAL_KEY]!.aborted) {
    g[CHAT_COMPACT_GLOBAL_KEY]!.aborted = new Set();
  }
  return g[CHAT_COMPACT_GLOBAL_KEY]!;
};

/** compact 进行中（含 summarize / 关旧 / 重建）；chat-reply 应入队而非起新会话 */
export const isChatCompactInProgress = (taskId: string): boolean =>
  getCompactState().inProgress.has(taskId);

const markChatCompactAborted = (taskId: string): void => {
  getCompactState().aborted.add(taskId);
};

const isChatCompactAborted = (taskId: string): boolean =>
  getCompactState().aborted.has(taskId);

const setChatCompactInProgress = (taskId: string, on: boolean): void => {
  const state = getCompactState();
  if (on) {
    state.inProgress.add(taskId);
  } else {
    state.inProgress.delete(taskId);
    // compact 结束后不得残留 abort，影响下一次压缩
    state.aborted.delete(taskId);
  }
};

// ----------------- publish 帮手（复用 task-runner SSE 通道） -----------------

const publish = (taskId: string, ev: TaskStreamEvent): void => {
  publishTaskStreamEvent(taskId, ev);
};

/**
 * 启动链 ephemeral 进度（不落盘）。id 前缀 ephemeral_boot_，meta.stage 供前端 loading 行。
 * 发送完成后前端自然清 loading；这里只推阶段、不 appendEvent。
 */
const publishBootProgress = (
  taskId: string,
  stage: "mcp" | "create" | "send",
  text: string,
): void => {
  publish(taskId, {
    kind: "event",
    event: {
      id: `ephemeral_boot_${stage}_${Date.now()}`,
      ts: Date.now(),
      kind: "info",
      text,
      meta: { stage },
    },
  });
};

// R27-6：本地第二套 writeEventAndPublish 实现已删——统一走 task-stream 的
// writeEventAndPublish（用户操作/系统通知语义）与 writeOwnedEventAndPublish（owner 语境、lease 必填）。

/**
 * chat turn-ended usage → 只写内存透视。
 * 超阈值自动 compact 改在 consumeChatRun 收尾触发（见 maybeAutoCompactThenFlush）。
 */
const handleChatTurnUsage = (
  taskId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  },
): void => {
  recordChatTurnUsage(taskId, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });
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
 * 有 continuationSummary：压缩续接（GB full-replace），摘要进首包
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
  /** P4.2 压缩续接摘要（与 firstMessage 互斥优先：有摘要走续接段） */
  continuationSummary?: string,
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
  );
  // 仅 win32 注入（PowerShell 语法条再按当前壳判定）——mac 用户不吃无关内容
  const windowsToolDiscipline = buildWindowsToolDisciplineDirective();
  if (windowsToolDiscipline) {
    lines.push(windowsToolDiscipline, "");
  }
  lines.push(
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
  // 未绑仓：cwd=home，写文件/副作用命令误伤面大——注入一句确认闸（UI 常驻提示由批 B）
  if (task.repoPaths.length === 0) {
    lines.push(
      "⚠️ 当前未绑定工作目录、cwd 是用户主目录——写文件/执行有副作用的命令前必须先向用户确认。",
      "",
    );
  }
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

  // 压缩续接优先于首条消息（compact 重建会话）
  if (continuationSummary && continuationSummary.trim().length > 0) {
    lines.push(
      buildCompactContinuationSection(continuationSummary),
      "请基于以上摘要继续协助用户。用户的下一条消息会单独送达——本回合直接结束回复即可。",
      "",
    );
  } else {
    lines.push(...buildOpeningStanceSection(task.id, firstMessage));
  }

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

// 流式消费 SDK 消息：复用 sdk-message-handler（含 tool_result / callId 配对），
// 不再维护本文件私有的 handleSdkMessage / stringifyMeta / truncate 副本。

// ----------------- 入口：runChatSession -----------------

export interface RunChatInput {
  task: Task;
  apiKey: string;
  model: ModelSelection;
  // 用户首条消息（绝大多数 chat 启动场景都有）、直接拼进 prompt
  firstMessage?: InitialUserMessage;
  // 首条消息对应的 user_reply 事件 id（chat-reply 启 run 前已写、传进来）。
  // 历史曾写进「Chat 任务启动」info meta；该 info 已去掉（用户嫌吵），参数保留供兜底定位扩展。
  firstMessageEventId?: string;
  /** P4.2 压缩续接：关旧会话后新会话首包注入的摘要 */
  continuationSummary?: string;
  /**
   * S1：chat-reply / deliverChatAskReply 启动预约 token。
   * 有则入口同步校验 lease，失效不注册 runningChats。
   */
  startToken?: number;
}

/**
 * 启动 chat agent run（fire-and-forget）
 *
 * 已在跑：若带 firstMessage 则入队（skipPersistEvent——调用方已落 user_reply）、返
 * `"already_running"`；否则幂等吞掉。
 * 返回 Promise 在 agent 终止时（成功 / 失败 / 取消）才 resolve、调用方一般不要 await、
 * 让 agent 后台跑、HTTP 立即返回。`void runChatSession(...)` 调用方不受返回值影响。
 */
export const runChatSession = async (
  input: RunChatInput,
): Promise<"started" | "already_running" | "lease_cancelled"> => {
  const {
    task,
    apiKey,
    model,
    firstMessage,
    firstMessageEventId: _firstMessageEventId,
    continuationSummary,
    startToken,
  } = input;
  void _firstMessageEventId;

  // S1：带 token 时入口同步校验 lease——失效绝不注册 runningChats / 不创建 agent
  if (
    startToken !== undefined &&
    !isChatStartLeaseValid(task.id, startToken)
  ) {
    console.warn(
      `[chat-runner] runChatSession task=${task.id} 启动 lease 已失效（token=${startToken}）、拒绝启动`,
    );
    return "lease_cancelled";
  }

  if (runningChats.has(task.id)) {
    // P1 #6：并发首条都被过 hasChatSession===false 后各自 fire runChatSession，
    // 后者若静默 return → 气泡已落盘但 agent 永远收不到。有 firstMessage 就入队、
    // flush 时 skipPersistEvent 避免重复气泡。
    if (firstMessage) {
      enqueueChatMessage(task.id, {
        agentText: firstMessage.text,
        displayText: firstMessage.text,
        imageAbsPaths: firstMessage.imagePaths,
        attachmentAbsPaths: firstMessage.attachmentPaths,
        enqueuedAt: Date.now(),
        skipPersistEvent: true,
      });
      console.warn(
        `[chat-runner] runChatSession task=${task.id} 已在跑、首条消息改入队（skipPersistEvent）`,
      );
    }
    return "already_running";
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

  // 本次启动的内存实例号：占位注册即定死，agentId 回填不换号。
  // 收尾门控一律用它——forceClear 后新会话（新号）已就位则门控拒绝、整段跳过。
  const myInstanceId = allocChatInstanceId();

  // cancel 收尾：关会话 + 归位 idle + publish done（不落 info——主动停时 /stop route 已落「用户停止了对话」、避免重复）
  const finishCancelled = async (): Promise<void> => {
    const closed = closeChatSession(task.id, myInstanceId);
    if (!closed && runningChats.has(task.id)) return;
    const t = await setTaskRunStatus(task.id, "idle");
    if (t) publish(task.id, { kind: "task", task: t });
    publish(task.id, { kind: "done", task: t ?? task, ok: true });
  };

  // 进入即占位注册：任何时刻（含 create/send/MCP 探测冷启动期）点停止、cancelChatRun 都能命中、
  // 置 cancelled（有 run 时一并真取消 SDK run）；agentId 先空、send 出来再回填。
  runningChats.set(task.id, {
    agentId: "",
    instanceId: myInstanceId,
    startedAt: Date.now(),
    agent: null,
    runActive: true,
    lastActiveAt: Date.now(),
    // 记下本会话绑定模型、供「切模型懒重启」比对（见 chat-reply route）
    model,
    // 记下本会话绑定的 MCP 黑名单快照（下面 filterDisabledMcp 按它过滤）、供「切 MCP 懒重启」比对
    disabledMcpServers: task.disabledMcpServers ?? [],
    // 记下本会话绑定的 workdir（create 时 cwd）、供「切 workdir 懒重启」比对
    repoPaths: [...(task.repoPaths ?? [])],
    cancel: () => {
      cancelled = true;
      if (run) void run.cancel().catch(() => {});
    },
  });
  // 占位已转正 → 启动预约完成使命（带 token 精确释放；finally 再 release 也幂等）
  releaseChatStart(task.id, startToken);

  try {
    // S1 兜底：注册占位后、Agent.create 前复查任务是否仍存在（DELETE 可能已 tombstone）。
    // 放在 await 点而非入口同步段——保持「进入即占位」语义，cancelChatRun 仍能命中。
    const aliveTask = await getTask(task.id);
    if (!aliveTask) {
      console.warn(
        `[chat-runner] runChatSession task=${task.id} 任务已删除/tombstone、放弃启动`,
      );
      closeChatSession(task.id, myInstanceId);
      return "lease_cancelled";
    }

    // 1) 切到 running、写一条 info event
    const startedTask = await setTaskRunStatus(task.id, "running");
    if (startedTask) publish(task.id, { kind: "task", task: startedTask });

    // 2) 拼 mcpServers：fe 自管 MCP（按 task 黑名单过滤）+ 我们自己的 chat-tool
    // （settingSources:[] 不加载任何 .cursor mcp；全局 / 项目 MCP 一律走 fe 自管配置）
    // 配置里万一也叫 aiFlowChat、按我们的为准（直接覆盖）
    // 注入 OAuth token：走 OAuth 授权的远程 MCP（如飞书项目）token 不在 mcp.json、
    // 由 fe 自己跑过 OAuth 落盘、起 agent 前补到 headers.Authorization、详见 mcp-oauth.ts
    publishBootProgress(task.id, "mcp", "正在检查 MCP…");
    const perfMcpStart = Date.now();
    const enrichedMcp = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(task.disabledMcpServers),
    );
    // V0.6.11 容错：起 agent 前剔除连不上 / 未授权的远程 MCP、单个 MCP 挂不拖垮整个 run
    // filterHealthyMcp 走 TTL 缓存（ok/fail 各 5min）——跨会话复用、热路径可秒过
    const { servers: cursorMcp, dropped: droppedMcp } =
      await filterHealthyMcp(enrichedMcp);
    const perfMcpMs = Date.now() - perfMcpStart;
    // R24-6：chat agent 同样带 caller 身份（ask_user 分派层要核）
    const callerToken = String(allocTaskRunInstanceId());
    const mergedMcp: Record<string, McpServerConfig> = {
      ...cursorMcp,
      [CHAT_TOOL_MCP_NAME]: {
        type: "http",
        url: getChatMcpUrl(callerToken),
      },
    };

    // MCP 健康探测也要数秒、探测期间被停 → 别再往下跑、直接收尾
    // （原「Chat 任务启动」info 已去掉：用户嫌吵，模型信息输入框下方已有）
    if (cancelled) {
      await finishCancelled();
      return "started";
    }

    // V0.6.11：有被剔除的 MCP → 写一条提示、让用户知道为什么少了能力（不再「莫名其妙报错」）
    if (droppedMcp.length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：chat 启动段（会话尚未注册、无实例可绑）、用户发消息的直接结果
      await writeEventAndPublish(task.id, {
        kind: "info",
        text: `⚠️ 已跳过 ${droppedMcp.length} 个不可用的 MCP：${droppedMcp
          .map((d) => `${d.name}（${d.detail?.split("\n")[0] ?? MCP_HEALTH_LABEL[d.status]}）`)
          .join("、")}——相关能力本次不可用、去设置页检查 / 授权`,
      });
    }

    // 3) 注入 awaiting notifier（V0.11.1 抽成共用、resume 时也要重注册）
    registerChatNotifier(task, callerToken);

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
    publishBootProgress(task.id, "create", "正在创建会话…");
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

    // S2 / T3：Agent.create 冷启动也要数秒——期间可能被 stop（cancelled）或
    // forceClear+新实例 B 替换（instanceGone）。本地 agent 尚未挂到 record，须显式
    // close 防泄漏；绝不能继续拼 prompt / send（旧 run 一旦受理可能改仓）。
    // SDK close 类型为 void，用 Promise.resolve 吞同步/异步异常（对齐 resume 放弃挂载）。
    {
      const curAfterCreate = runningChats.get(task.id);
      const instanceGoneAfterCreate =
        !curAfterCreate || curAfterCreate.instanceId !== myInstanceId;
      if (cancelled || instanceGoneAfterCreate) {
        void Promise.resolve(agent.close()).catch(() => {});
        // cancelled：走既有 finishCancelled；instanceGone 而非 cancelled 时不要动 B
        //（finishCancelled 按 myInstanceId 门控对 B 是 no-op，但仍避免多余写盘）
        if (cancelled) await finishCancelled();
        return "started";
      }
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
      continuationSummary,
    );
    const perfPromptMs = Date.now() - perfPromptStart;

    // T3：素材收割四个 await 期间同样可能被 forceClear 换实例 / stop——send 前再复查一次。
    // 命中则 close 本地 agent、绝不能 agent.send（对齐上面 create 后与 send 后复查口径）。
    {
      const curBeforeSend = runningChats.get(task.id);
      const instanceGoneBeforeSend =
        !curBeforeSend || curBeforeSend.instanceId !== myInstanceId;
      if (cancelled || instanceGoneBeforeSend) {
        void Promise.resolve(agent.close()).catch(() => {});
        if (cancelled) await finishCancelled();
        return "started";
      }
    }

    const perfSendStart = Date.now();
    const promptBytes = Buffer.byteLength(initialPrompt, "utf-8");
    // 首包字节进 token 透视（会话关闭仍保留，供 /context breakdown）
    recordChatFirstPromptBytes(task.id, promptBytes);
    publishBootProgress(task.id, "send", "正在发送首包…");
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: agent.agentId,
      runKind: "chat-first",
      promptBytes,
      onTurnUsage: (usage) => {
        handleChatTurnUsage(task.id, usage);
      },
    });
    run = await agent.send(initialPrompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // R26-6：chat shell delta 绑本实例 instanceId——失主丢弃迟到输出
        createShellOutputDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === myInstanceId,
        ),
      ),
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

    // S2（十二轮）/ 对齐 M1（第十轮复审）：send resolve 后、任何写 record / 落盘之前，
    // 复查 cancelled + instanceId——stop / forceClear+新实例 B 可发生在上面 await 期间。
    // 命中则丢弃迟到 run，绝不能把 B 的 record 覆盖成 A 的 agent / 落盘 A 的 sessionAgentId。
    const cur = runningChats.get(task.id);
    if (cancelled || !cur || cur.instanceId !== myInstanceId) {
      void run.cancel().catch(() => {});
      // 本地 agent 未挂到当前实例：显式 close，避免泄漏（finishCancelled 只关 record.agent）
      void Promise.resolve(agent.close()).catch(() => {});
      if (cancelled) await finishCancelled();
      // instanceGone：finishCancelled 按 myInstanceId 门控对 B 是 no-op，此处不调用以免多余写盘
      return "started";
    }

    // 回填真实 agentId / agent 实例（占位注册时是空串 / null）——从此会话可被 send 续接。
    // agentId 同步落盘（V0.11.1 会话持久化）：服务重启后 Agent.resume 接回
    cur.agentId = agent.agentId;
    cur.agent = agent;
    void setTaskSessionAgentId(task.id, agent.agentId);

    await consumeChatRun(task, run, () => cancelled);
  } catch (err) {
    // Agent.create / send 阶段失败（consumeChatRun 内部错误它自己处理、不会抛）
    // S2：stop 导致 create/send reject 时走 finishCancelled 口径（idle、不落 error），
    // 对齐 consumeChatRun 的 cancelled 分流；cancelled=false 才走 handleChatRunFailure。
    if (cancelled) {
      const cur = runningChats.get(task.id);
      const mounted =
        !!agent && cur?.instanceId === myInstanceId && cur.agent === agent;
      if (agent && !mounted) {
        void Promise.resolve(agent.close()).catch(() => {});
      }
      await finishCancelled();
      return "started";
    }
    await handleChatRunFailure(task, err, myInstanceId);
  }
  return "started";
};

// ----------------- V0.11.1：notifier 注册 + 会话恢复 -----------------

// chat 的 awaiting notifier：ask_user 写真实 ask_user_request 事件（与 task-runner 对齐）；
// submit_work 误调仍只切 awaiting_user（chat 不用交卷）
const registerChatNotifier = (task: Task, callerToken: string): void => {
  setChatAwaitingNotifier(
    task.id,
    async (signal, ctx) => {
      // R25-3：chat 模式同样贯穿 caller 复查（签名对齐 task-runner）
      if (!ctx.callerStillValid()) return;
      if (signal.kind === "ask_user_request") {
        // R27-5：ask lease 含 askId——同 caller 并发/重试的旧 ask（pending map 已被
        // 新 ask 顶掉）在 supersede/event/status 每个 sink 都被拦、UI 与 pending map 不分裂
        const askLease = (): boolean =>
          ctx.callerStillValid() &&
          getPendingAsk(task.id)?.askId === signal.askId;
        // 新提问落盘前作废旧的未了结提问（同 task-runner：防旧答题卡复活）
        // R26-5/6：supersede 带 caller lease
        await supersedePendingAsks(task.id, "被新提问顶替", askLease);
        await failpoint("mcp.askUser.afterSupersede");
        if (!askLease()) {
          // R26-3：按本次 askId 反登记——不得裸 cancel 误删 B 的新提问
          cancelPendingIf(task.id, signal.askId);
          return;
        }
        const previewText = signal.questions
          .map((q, idx) => `Q${idx + 1}: ${q.question}`)
          .join("\n");
        // R27-6：owned sink——lease 必填
        await writeOwnedEventAndPublish(
          task.id,
          askLease,
          {
            kind: "ask_user_request",
            // chat 无 action——有 actionId 才带（误传也无害）
            ...(signal.actionId ? { actionId: signal.actionId } : {}),
            text: previewText,
            meta: {
              askId: signal.askId,
              token: signal.token,
              questions: signal.questions,
            },
          },
        );
        if (!askLease()) {
          cancelPendingIf(task.id, signal.askId);
          return;
        }
        const updated = await setTaskRunStatus(task.id, "awaiting_user");
        if (updated) publish(task.id, { kind: "task", task: updated });
        return;
      }
      // submit_work 等非 ask 信号：chat 不用交卷、只切 awaiting_user
      if (!ctx.callerStillValid()) return;
      const updated = await setTaskRunStatus(task.id, "awaiting_user");
      if (updated) publish(task.id, { kind: "task", task: updated });
    },
    callerToken,
  );
};

/**
 * V0.11.1：从落盘的 sessionAgentId 恢复 chat 会话（服务重启 / 空闲回收后）。
 * 成功 = 会话表就位、返回本次注册的 instanceId（可立即 sendChatMessage）；失败返 null。
 *
 * 与 rewind 门闩交叉闭合（why：Agent.resume 要 await 数秒，期间 rewind 可能已截断历史并关会话；
 * 若晚到的 resume 仍写入 runningChats，下一条消息会打到含已截断历史的旧会话）：
 *   - resume 先占启动预约 → rewind 复查 hasChatStartReservation 拒绝回退；
 *   - rewind 先占门闩 → resume 入口 / 注册前复查看到门闩则放弃挂载。
 * 并发两个 resume：第二个 tryReserveChatStart 失败，避免后到覆盖先到。
 *
 * @param opts.claimRun owner 在注册瞬间同步认领首个 run（runActive=true）。
 *   复审 G1：三个调用方（chat-reply / deliverChatAskReply / tryChatAutoReconnect）
 *   resume 后都要自己先发第一条；认领消掉「注册→owner send」窗口里的并发 send 与顺序反转。
 *   通用 resume 不再无条件 drain——后续队列等 owner run 结束后由统一 flush 排出。
 *   调用方若在 send 前失败必须 releaseChatRunClaim(taskId, instanceId)。
 * @returns 复审 K1：claim 是实例化 token——成功返回注册的 instanceId，owner 后续
 *   send/release 必须带它做精确匹配；失败返 null。不再返布尔，防止旧 owner 越权
 *   操作 stop/forceClear 之后换上来的新实例。
 */
export const resumeChatSession = async (
  task: Task,
  bootArgs: { apiKey: string; model: ModelSelection },
  opts: { claimRun?: boolean } = {},
): Promise<number | null> => {
  // 同步段：任何 await 之前完成门闩/预约检查（Node 单线程 check-and-set 原子）
  if (!task.sessionAgentId || runningChats.has(task.id)) return null;
  if (isChatRewindInProgress(task.id)) return null;
  // 复用与新会话启动同一预约：rewind 占门闩后会复查预约并拒绝回退
  const startToken = tryReserveChatStart(task.id);
  if (startToken === null) return null;
  try {
    // inline MCP 不随 resume 持久化、重传（同 runChatSession 的 merge 逻辑）
    const enrichedMcp = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(task.disabledMcpServers),
    );
    const { servers: cursorMcp } = await filterHealthyMcp(enrichedMcp);
    // R24-6：resume 发新 caller + 重注册 notifier
    const callerToken = String(allocTaskRunInstanceId());
    const mergedMcp: Record<string, McpServerConfig> = {
      ...cursorMcp,
      [CHAT_TOOL_MCP_NAME]: { type: "http", url: getChatMcpUrl(callerToken) },
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
    // Agent.resume 成功后、runningChats.set 之前的同步复查：
    // await 期间 rewind / 并发 resume / stop(cancelChatStart) 可能已抢占——放弃挂载
    if (
      isChatRewindInProgress(task.id) ||
      runningChats.has(task.id) ||
      !isChatStartLeaseValid(task.id, startToken)
    ) {
      console.warn(
        `[chat-runner] task=${task.id} resume 被 rewind/并发会话/停止抢占，放弃挂载（agentId=${agent.agentId}）`,
      );
      // SDKAgent.close() 存在；放弃挂载时显式关掉，避免孤儿 agent 占资源
      try {
        agent.close();
      } catch {
        /* noop */
      }
      return null;
    }
    // claimRun：从注册那一刻起没有任何第三方能抢发（send / flush 见 runActive 即停）
    // 复审 J1：resume 同一持久化 agent 得到相同 agentId，但内存实例必须换新号
    const instanceId = allocChatInstanceId();
    runningChats.set(task.id, {
      agentId: agent.agentId,
      instanceId,
      startedAt: Date.now(),
      agent,
      runActive: opts.claimRun === true,
      lastActiveAt: Date.now(),
      model: bootArgs.model,
      disabledMcpServers: task.disabledMcpServers ?? [],
      repoPaths: [...(task.repoPaths ?? [])],
      // 复审 K1：claim 态没有真 run，stop（cancelChatRun 见 runActive 走 cancel）
      // 必须真正摘除本实例并记录 cancelled——owner 稍后 send 因 instanceId 不匹配
      // 整段 no-op，路由凭 cancelled 标记识别「用户已停止」、不再降级起新会话重放消息，
      // 不会出现「已中断」之后 AI 又开始跑。consumeChatRun 起真 run 后会覆盖此 cancel。
      cancel: () => {
        if (closeChatSession(task.id, instanceId)) {
          getCancelledClaims().set(task.id, instanceId);
        }
      },
    });
    registerChatNotifier(task, callerToken);
    console.log(
      `[chat-runner] task=${task.id} 会话已恢复（Agent.resume agentId=${agent.agentId}、instance=#${instanceId}${opts.claimRun ? "、已认领首发" : ""}）`,
    );
    return instanceId;
  } catch (err) {
    // V0.13.x：网络类失败不清锚点（自动重连还要靠它再试）；确定性失败才清
    const m = err instanceof Error ? err.message : String(err);
    if (isRetryableRunError(m, err)) {
      console.warn(
        `[chat-runner] task=${task.id} Agent.resume 网络类失败（保留锚点、可重试）`,
        err,
      );
      return null;
    }
    console.warn(
      `[chat-runner] task=${task.id} Agent.resume 失败（条件清锚点、降级新会话）`,
      err,
    );
    // R27-3：条件清（chat 侧等价 guard）——B 已装内存 session（runningChats 非空）
    // 或本次 start lease 已被 stop/rewind 抢占则不清；盘上锚点必须仍是本次尝试的 agentId
    if (task.sessionAgentId) {
      void clearTaskSessionAgentIdIf(
        task.id,
        task.sessionAgentId,
        () =>
          !runningChats.has(task.id) &&
          isChatStartLeaseValid(task.id, startToken),
      );
    }
    return null;
  } finally {
    releaseChatStart(task.id, startToken);
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
 *
 * @param staleInstanceId 要重连替换的坏会话内存实例号（consumeChatRun 失败分支传入；
 *   send 失败递归时传本轮 rec.instanceId）。复审 H2：退避窗口内不得留下可被第三方
 *   当 idle 用的旧会话；醒来后只按 staleInstanceId 门控关闭，绝不误关用户新起的 run。
 *   复审 J1：门控键必须是 instanceId 而非 agentId——退避期间用户 chat-reply 会
 *   `Agent.resume(task.sessionAgentId)` 恢复同一持久化 agent，新实例 agentId 与
 *   stale 相同；instanceId 每次注册都换新号，才能区分「坏实例」和「用户新恢复的实例」。
 */
const tryChatAutoReconnect = async (
  task: Task,
  err: unknown,
  attempt: number,
  isCancelled: () => boolean,
  staleInstanceId: number | undefined,
): Promise<boolean> => {
  if (attempt > RECONNECT_MAX) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (!isRetryableRunError(msg, err)) return false;
  if (isCancelled()) return false;
  const fresh = await getTask(task.id);
  if (!fresh || fresh.repoStatus === "merged" || fresh.repoStatus === "abandoned") {
    return false;
  }
  // M1 延伸：重连的 backoff/resume/send 大部分时间表内没有 record，cancelChatRun
  // 摸不到 cancel 入口——注册停止闭包，让用户 stop 能立刻打进本轮（及递归后续轮）。
  // isCancelled 只能感知「旧 run 的 cancel」，感知不到 stop 对已摘除实例的操作。
  let stoppedByUser = false;
  const reconnectStop = (): void => {
    stoppedByUser = true;
  };
  getReconnectStops().set(task.id, reconnectStop);
  const isStopped = (): boolean => stoppedByUser || isCancelled();
  try {
    const handled = await runReconnectAttempt(
      fresh,
      err,
      attempt,
      isStopped,
      staleInstanceId,
    );
    if (!handled && stoppedByUser) {
      // 用户 stop 中断了重连（退避/resume 期间）：stop 路由已清队、归位 idle、
      // 落「用户停止了对话」——这里按已接管收尾，绝不落 error 事件覆盖 stop 状态。
      // 表内若还挂着 stale 实例（stop 时 record cancel 是旧闭包没摘表）→ 补摘防僵尸假 busy。
      if (staleInstanceId !== undefined) {
        closeChatSession(task.id, staleInstanceId);
      }
      console.warn(
        `[chat-runner] task=${task.id} 重连期间被用户停止、按已接管收尾（attempt=${attempt}）`,
      );
      return true;
    }
    return handled;
  } finally {
    // 只清自己注册的闭包（递归下层已换成它自己的、identity 不匹配则不动）
    if (getReconnectStops().get(task.id) === reconnectStop) {
      getReconnectStops().delete(task.id);
    }
  }
};

/** tryChatAutoReconnect 的主体（拆出以便注册/清理停止闭包）；isCancelled 已含 stop 信号 */
const runReconnectAttempt = async (
  fresh: Task,
  err: unknown,
  attempt: number,
  isCancelled: () => boolean,
  staleInstanceId: number | undefined,
): Promise<boolean> => {
  const task = fresh;
  // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：重连系统通知（旧实例已摘、新实例未生）
  await writeEventAndPublish(task.id, {
    kind: "info",
    text: `连接中断、正在自动重连（第 ${attempt}/${RECONNECT_MAX} 次）…`,
    meta: { kind: "reconnecting", attempt, max: RECONNECT_MAX },
  });
  if (await sleepWithCancel(RECONNECT_BACKOFF_MS[attempt - 1], isCancelled)) {
    return false;
  }
  // 复审 H2/J1：退避醒来后用户可能已另起新会话（resume 同持久化 agent 时 agentId
  // 相同、instanceId 必不同）——让位，绝不 close 别人的会话
  // （return true = 已接管善后，consumeChatRun 不再走 handleChatRunFailure）
  const cur = runningChats.get(task.id);
  if (
    cur &&
    staleInstanceId !== undefined &&
    cur.instanceId !== staleInstanceId
  ) {
    console.warn(
      `[chat-runner] task=${task.id} 自动重连让位：表内已是新会话实例` +
        `（stale=#${staleInstanceId}、current=#${cur.instanceId} agentId=${cur.agentId}）`,
    );
    return true;
  }
  // 只关坏实例（instanceId 门控）、永不误关新会话；锚点 keepPersisted 供下一轮 resume
  if (staleInstanceId !== undefined) {
    closeChatSession(task.id, staleInstanceId, { keepPersisted: true });
  }
  const creds = await readServerChatCreds();
  if (!creds) return false;
  // 复审 G1：重连方是 reconnect prompt 的 owner——认领首发，排队消息等本 run 结束后统一 flush
  const claimedInstanceId = await resumeChatSession(fresh, creds, {
    claimRun: true,
  }).catch(() => null);
  if (claimedInstanceId === null) {
    return tryChatAutoReconnect(
      fresh,
      err,
      attempt + 1,
      isCancelled,
      staleInstanceId,
    );
  }
  const rec = runningChats.get(task.id);
  // 复审 K1：owner 只操作自己 claim 的实例——注册后若已被替换（同 tick 内理论不可能、
  // 防御性校验），绝不向别人的实例发 reconnect prompt。无 rec 则无认领泄漏。
  if (!rec?.agent || rec.instanceId !== claimedInstanceId) return false;
  // M1 延伸：stop 到达于 Agent.resume await 期间（当时表内无 record、只有停止闭包
  // 能收到信号）→ 刚注册出的 claim 是僵尸（runActive=true 永久假 busy）——
  // 立即关闭让 stop 生效，绝不发 reconnect prompt。
  if (isCancelled()) {
    closeChatSession(task.id, claimedInstanceId);
    consumeChatClaimCancelled(task.id, claimedInstanceId);
    console.warn(
      `[chat-runner] task=${task.id} 重连 resume 期间已被停止、关闭僵尸实例 #${claimedInstanceId}`,
    );
    return true;
  }
  try {
    const reconnectPrompt =
      "（系统消息：刚才网络连接中断、你上一轮回复被打断。请从中断的地方继续——已说完的不用重复、接着回答即可。）";
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: rec.agent.agentId,
      runKind: "chat-reconnect",
      promptBytes: Buffer.byteLength(reconnectPrompt, "utf-8"),
    });
    // 认领已在 resume 注册时完成（runActive=true），勿等 send 后再置——
    // 否则 flush / 并发 send 可插在 reconnect prompt 之前（复审 G1 点名的晚置位窗口）
    const run = await rec.agent.send(reconnectPrompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // R26-6：重连 shell delta 绑 claimedInstanceId
        createShellOutputDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === claimedInstanceId,
        ),
      ),
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
    // M1（第十轮复审）：send pending 期间用户 stop（claim cancel 已摘表）或实例被
    // forceClear 替换 → 丢弃迟到 run，绝不写「重连成功」再把 AI 拉起来。
    // stop 方 / 新实例已各自负责收尾，返 true 跳过失败路径。
    const curAfterSend = runningChats.get(task.id);
    if (
      isCancelled() ||
      !curAfterSend ||
      curAfterSend.instanceId !== claimedInstanceId
    ) {
      void run.cancel().catch(() => {});
      // 本实例若仍在表内（stop 走的是停止闭包而非 record cancel）→ 摘掉防僵尸假 busy；
      // 已被摘除/替换则门控 no-op
      closeChatSession(task.id, claimedInstanceId);
      consumeChatClaimCancelled(task.id, claimedInstanceId);
      console.warn(
        `[chat-runner] task=${task.id} 重连 send 受理期间实例 #${claimedInstanceId} 已被停止/替换、丢弃迟到 run`,
      );
      return true;
    }
    // R27-6：owner 语境（重连链、send 后已验实例）——claimedInstanceId lease
    await writeOwnedEventAndPublish(
      task.id,
      () => runningChats.get(task.id)?.instanceId === claimedInstanceId,
      {
        kind: "info",
        text: `重连成功（第 ${attempt} 次）、AI 继续回复`,
        meta: { kind: "reconnected", attempt },
      },
    );
    await consumeChatRun(fresh, run, undefined, attempt);
    return true;
  } catch (sendErr) {
    // M1：send pending 期间被用户 stop（claim cancel 已摘表 + 落标记）、随后 send
    // 抛错 → 不得再退避重试把会话复活；stop 方已收尾，直接接管返 true。
    if (consumeChatClaimCancelled(task.id, claimedInstanceId)) {
      return true;
    }
    // 复审 H2：勿只清 runActive 留下 idle 会话进退避——第三方 chat-reply 会当可用会话
    // 起 run，重试醒来再无条件 close「当前会话」会把用户刚起的 run 关掉。
    // 立即按 instanceId 摘出表（keepPersisted 留锚点），退避窗口内无可被占用的 idle 会话。
    closeChatSession(task.id, rec.instanceId, { keepPersisted: true });
    return tryChatAutoReconnect(
      fresh,
      sendErr,
      attempt + 1,
      isCancelled,
      rec.instanceId,
    );
  }
};

// ----------------- V0.11：chat run 消费管道（首个 run + 后续 send 共用） -----------------

// run 失败的统一收尾：关会话 + 标 error + 事件 + publish
// expectedInstanceId：旧 run 收尾带上实例门控；已被新会话顶替则整段 no-op（防误标 error / 误关）
const handleChatRunFailure = async (
  task: Task,
  err: unknown,
  expectedInstanceId?: number,
): Promise<void> => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[chat-runner] task", task.id, "failed:", err);
  // run 失败可能是「缓存 ok 期间 MCP 挂了」——清探测缓存、用户重试时必真探（同 task-runner）
  invalidateMcpProbeCache();
  const closed = closeChatSession(task.id, expectedInstanceId);
  // 门控拒绝且新会话已就位 → 跳过；表已空（forceClear 后）→ 仍落 error（旧行为）
  if (!closed && runningChats.has(task.id)) return;
  // 归一成给用户看的文案：长连接被断（最常见）→ 友好一句话、不加吓人前缀；
  // 其它有诊断的错 → 带详情、加「异常」前缀（跟 task-runner 对齐）。原始 err 已 console.error。
  const failure = summarizeRunFailure(message, err);
  const eventText = failure.isConnectionDrop
    ? failure.text
    : `Chat agent 异常：${failure.text}`;
  // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：失败收尾（上方 closeChatSession instanceId 门控已保证不误伤新会话、会话已摘无实例可绑）
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
  // R27-6：捕获本 run 的 instanceId lease——forceClear/懒重启换新会话后，
  // 旧 run 迟到 yield 的主消息流（thinking/assistant/tool/flush）全部被拦、
  // 不再 append/publish 污染 B 的 events.jsonl（rec 缺失用 -1 哨兵 = 永不匹配）。
  const myInstanceId = rec ? rec.instanceId : -1;
  const chatLease = (): boolean =>
    runningChats.get(task.id)?.instanceId === myInstanceId;
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
        // R27-6：flush 走 owned sink——本实例已被摘除/替换则不落盘
        await writeOwnedEventAndPublish(task.id, chatLease, {
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
      // R27-6：chat 主消息流接 instanceId lease（缺省 opHandle ≠ 永远 current 的语义已删）
      await handleSdkMessage(task.id, msg, ctx, chatLease);
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
      // 带本 run 实例号：切模型 forceClear 后新会话已注册则门控拒绝且表非空 → 跳过
      // （rec 缺失时传 -1 = 永不匹配的哨兵，绝不无门控关别人的会话）
      // 复审（11 轮）：clearChatQueue 必须在实例门控之后——迟到的旧 run 收尾
      // 不得清掉新会话（forceClear 换新后）刚积累的队列。
      const closed = closeChatSession(task.id, rec ? rec.instanceId : -1);
      if (!closed && runningChats.has(task.id)) return;
      clearChatQueue(task.id);
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

    // 超阈值 → 自动 compact（期间消息进队列）；否则直接 dequeue
    void maybeAutoCompactThenFlush(task.id);
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    // 失败路径清排队，避免会话已死后积压消息幽灵发送。
    // 复审（11 轮）：带实例门控——表内已是新实例（forceClear 换新等）时，
    // 迟到的旧 run 失败收尾不得清新会话的队列。
    const curOnFail = runningChats.get(task.id);
    if (!curOnFail || (rec && curOnFail.instanceId === rec.instanceId)) {
      clearChatQueue(task.id);
    }
    // 复审（11 轮）：用户 stop 后 stream 以异常收场（abort 类）→ 走 cancel 收尾，
    // 绝不落 error 事件 / error 状态覆盖 stop 路由已写的 idle +「用户停止了对话」。
    if (cancelled || externallyCancelled?.()) {
      const closed = closeChatSession(task.id, rec ? rec.instanceId : -1);
      if (!closed && runningChats.has(task.id)) return;
      const cancelledTask = await setTaskRunStatus(task.id, "idle");
      if (cancelledTask) publish(task.id, { kind: "task", task: cancelledTask });
      publish(task.id, { kind: "done", task: cancelledTask ?? task, ok: true });
      return;
    }
    // V0.13.x：网络类失败先自动重连（重试 5 次、事件流显示「重连中」）
    // 复审 H2/J1：传入本 run 的 instanceId 作 staleInstanceId（rec 可能已不在表，用入口捕获的）
    const handled = await tryChatAutoReconnect(
      task,
      err,
      reconnectAttempt + 1,
      () => cancelled || !!externallyCancelled?.(),
      rec?.instanceId,
    );
    if (!handled) {
      await handleChatRunFailure(task, err, rec ? rec.instanceId : -1);
    }
  }
};

// ----------------- V0.11：sendChatMessage（续接存活会话） -----------------

/**
 * sendChatMessage 的结构化结果（复审 L2）。
 * why 不是布尔：owner claim 被 stop 摘除 / 实例被替换时，send 返 false 会被
 * chat-reply 当「普通无会话故障」降级到 mode 2 起新会话——AI 在「用户已停止」
 * 之后又开始跑。取消必须是不可降级重试的终态，调用方要能区分：
 * - `sent`：已送达（run 已异步起消费）
 * - `cancelled`：owner claim 被用户 stop 摘除（内部已消费 cancelled 标记）→ 调用方终止请求、绝不入 mode 2
 * - `owner_invalid`：owner claim 实例已被替换（forceClear 换新等）→ 同样终止、不得把消息重放给新实例
 * - `busy`：run 在跑 / rewind / compact 门闩中 / 会话冷启动占位 → 调用方入队
 * - `no_session`：无会话可续接（非 owner）→ 调用方起新会话
 * - `send_failed`：agent.send 抛错（会话已关）→ 调用方起新会话
 */
export type SendChatMessageResult =
  | "sent"
  | "cancelled"
  | "owner_invalid"
  | "busy"
  | "no_session"
  | "send_failed";

/**
 * 把用户新消息发给存活的 chat 会话（`agent.send`）、消费产生的新 run。
 *
 * @param opts.ownerInstanceId resume(claimRun) 的 owner 所持 claim 绑定的实例号。
 *   复审 K1：claim 是实例化 token，不是布尔——传入后要求当前 record.instanceId
 *   精确匹配才允许跳过 runActive 早退；不匹配（claim 实例已被 stop 摘除 /
 *   forceClear 换新）时整段 no-op：不 send、不碰当前 record、也没有可
 *   释放的 claim。匹配场景下所有非 sent 的早退路径必须先释放认领，
 *   否则会话永远假 busy、消息只进队无人消费。
 * @returns 见 {@link SendChatMessageResult}；只有 `sent` 表示送达
 */
export const sendChatMessage = async (
  task: Task,
  text: string,
  imagePaths?: string[],
  attachmentPaths?: string[],
  opts?: { ownerInstanceId?: number },
): Promise<SendChatMessageResult> => {
  const ownerInstanceId = opts?.ownerInstanceId;
  const rec = runningChats.get(task.id);
  // 复审 K1：owner 的实例校验放在一切副作用之前——当前 record 不是原 claim 实例
  //（stop 已摘除 / 懒重启 forceClear 后换成新实例）时，旧 owner 不得越权发送、
  // 不得动新实例的任何状态；claim 已随原实例消亡，无需也不能 release。
  // 复审 L2：区分「用户 stop」（cancelled 标记命中）与「实例被替换」——两者对
  // 调用方都是终态，但文案 / 语义不同。
  if (
    ownerInstanceId !== undefined &&
    (!rec || rec.instanceId !== ownerInstanceId)
  ) {
    if (consumeChatClaimCancelled(task.id, ownerInstanceId)) {
      console.warn(
        `[chat-runner] sendChatMessage: task=${task.id} owner claim #${ownerInstanceId} 已被用户停止摘除、拒发`,
      );
      return "cancelled";
    }
    console.warn(
      `[chat-runner] sendChatMessage: task=${task.id} owner claim 实例已失效` +
        `（claim=#${ownerInstanceId}、current=${rec ? `#${rec.instanceId}` : "无会话"}）、拒发`,
    );
    return "owner_invalid";
  }
  const isOwner = ownerInstanceId !== undefined; // 至此已通过实例精确匹配

  /** owner 认领释放：仅非 sent 早退路径；send 抛错会 close 会话无需额外处理。
   * 统一走 releaseChatRunClaim（复审 H1 handoff：释放 = 接管排队 drain 义务）。 */
  const releaseOwnerClaimIfNeeded = (): void => {
    if (ownerInstanceId === undefined) return;
    releaseChatRunClaim(task.id, ownerInstanceId);
  };

  // rewind 进行中：busy → chat-reply 入队（enqueueOrReject 内部见门闩会 409）
  if (isChatRewindInProgress(task.id)) {
    releaseOwnerClaimIfNeeded();
    return "busy";
  }
  // compact 进行中：busy → chat-reply 入队（与 runActive 同口径）
  if (isChatCompactInProgress(task.id)) {
    releaseOwnerClaimIfNeeded();
    return "busy";
  }
  // 无会话（owner 场景已在上面按 cancelled/owner_invalid 收敛、至此必是非 owner）
  if (!rec) return "no_session";
  // 冷启动占位（agent 还没就位）/ run 在跑：busy 入队等 flush
  // owner（实例已匹配）时 runActive 应为 true（自己认领的），不因此早退
  if (!rec.agent || (!isOwner && rec.runActive)) {
    releaseOwnerClaimIfNeeded();
    return "busy";
  }

  // 审查发现：校验通过到 await send 完成之间有 TOCTOU，并发双发（连点/双标签）都能通过检查 →
  // 立刻占位；send 抛错时清回 false（consumeChatRun 入口置 true 保持幂等）
  // owner 认领场景：已是 true，再赋一次幂等
  rec.runActive = true;

  // M1（第十轮复审）：`agent.send()` 是 await 点——用户可在 promise pending 期间 stop。
  // claim 型 record 的 cancel 会摘除实例（resolve 后表复查可见）；但普通 record 的
  // cancel 只是上一轮 run 的旧闭包，record 仍在表内、表复查捕捉不到——必须在这里
  // 接力：包装 cancel 记录取消信号，run 一旦可用立即补 cancel，保证 stop 发生在
  // send pending 期间也不丢取消。send 成功后 consumeChatRun 同步 prologue 会立即
  // 覆盖 rec.cancel（真 run 的 cancel），包装闭包自然退役。
  let cancelledDuringSend = false;
  let acceptedRun: ChatRun | undefined;
  const cancelBeforeSend = rec.cancel;
  rec.cancel = () => {
    cancelledDuringSend = true;
    if (acceptedRun) void acceptedRun.cancel().catch(() => {});
    cancelBeforeSend();
  };

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
      onTurnUsage: (usage) => {
        handleChatTurnUsage(task.id, usage);
      },
    });
    run = await rec.agent.send(prompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // R26-6：follow-up shell delta 绑 rec.instanceId
        createShellOutputDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === rec.instanceId,
        ),
      ),
      onStep: perfTracker.onStep,
    });
    // 立刻挂到共享取消闭包：此后 stop 到达（如置 running 的 await 期间）能直接 cancel 本 run
    acceptedRun = run;
    perfTracker.attachRun(run);
  } catch (err) {
    rec.runActive = false;
    console.error(`[chat-runner] sendChatMessage: task=${task.id} send 失败`, err);
    closeChatSession(task.id, rec.instanceId);
    // M1：send pending 期间被用户 stop、随后 send 又抛错 → 终态 cancelled，
    // 绝不能返 send_failed 让 chat-reply 落 mode 2 把消息重放出去
    if (cancelledDuringSend) {
      consumeChatClaimCancelled(task.id, rec.instanceId);
      return "cancelled";
    }
    return "send_failed";
  }

  // M1（第十轮复审）：send resolve 后、任何 task 状态 / consume 副作用之前，
  // 复查取消信号与内存实例——stop / forceClear 可发生在上面 await 期间。
  // 命中则丢弃迟到 run（best-effort cancel），绝不能把 runStatus 重新置 running。
  const curAfterSend = runningChats.get(task.id);
  const instanceGone =
    !curAfterSend || curAfterSend.instanceId !== rec.instanceId;
  if (cancelledDuringSend || instanceGone) {
    void run.cancel().catch(() => {});
    if (!instanceGone) {
      // 普通 record 被 stop：cancel 闭包只打了取消信号未摘表——补关闭对齐 stop 语义
      //（claim record 的 cancel 已自行摘表 + 落 cancelled 标记、此处门控 no-op）
      closeChatSession(task.id, rec.instanceId);
    }
    const wasCancelled =
      consumeChatClaimCancelled(task.id, rec.instanceId) || cancelledDuringSend;
    console.warn(
      `[chat-runner] sendChatMessage: task=${task.id} send 受理期间实例 #${rec.instanceId} 已被${wasCancelled ? "停止" : "替换"}、丢弃迟到 run`,
    );
    return wasCancelled ? "cancelled" : "owner_invalid";
  }
  rec.lastActiveAt = Date.now();

  // 切 running + fire-and-forget 消费
  //（此 await 期间若 stop：共享取消闭包已持 acceptedRun、会直接 cancel run）
  const runningTask = await setTaskRunStatus(task.id, "running");
  // M1 补丁（11 轮复审）：上面 await 期间 stop / forceClear 仍可到达——此时
  // consumeChatRun 尚未接管（rec.cancel 还是共享闭包），若不复查就 return "sent"，
  // 会出现「已停止仍落已发送气泡」且刚写入的 running 覆盖 stop 的 idle。
  const curAfterStatus = runningChats.get(task.id);
  const goneAfterStatus =
    !curAfterStatus || curAfterStatus.instanceId !== rec.instanceId;
  if (cancelledDuringSend || goneAfterStatus) {
    void run.cancel().catch(() => {});
    if (!goneAfterStatus) closeChatSession(task.id, rec.instanceId);
    const wasCancelled =
      consumeChatClaimCancelled(task.id, rec.instanceId) || cancelledDuringSend;
    // 撤销刚写入的 running（可能盖掉了 stop 落的 idle）；有新实例接管则不动它的状态
    if (!runningChats.has(task.id)) {
      const idleTask = await setTaskRunStatus(task.id, "idle");
      if (idleTask) publish(task.id, { kind: "task", task: idleTask });
    }
    console.warn(
      `[chat-runner] sendChatMessage: task=${task.id} 置 running 期间实例 #${rec.instanceId} 已被${wasCancelled ? "停止" : "替换"}、丢弃迟到 run`,
    );
    return wasCancelled ? "cancelled" : "owner_invalid";
  }
  if (runningTask) publish(task.id, { kind: "task", task: runningTask });
  void consumeChatRun(task, run);
  return "sent";
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
  // 复审（11 轮）：compact / rewind 窗口内会话可能刚被关（重建中）——此时绝不能
  // 走下面 resume / 起新会话与 compact 重建打架，直接返 false 让用户稍后用输入条答复
  if (isChatCompactInProgress(task.id) || isChatRewindInProgress(task.id)) {
    return false;
  }
  // 1) 存活会话直接 send
  if (hasChatSession(task.id)) {
    const sent = await sendChatMessage(task, replyText, imagePaths);
    if (sent === "sent") return true;
    // M1/L2：send pending 期间被 stop / 实例被替换 → 终态，
    // 不得落到下面 resume / 新会话把答案在「已停止」之后重放
    if (sent === "cancelled" || sent === "owner_invalid") return false;
    // 复审（11 轮）：busy（run 在跑）→ 终止而非降级，防答案绕过在跑的 run 干扰会话；
    // 用户可等本轮结束后重发（ask 卡片仍在）
    if (sent === "busy") return false;
    // send_failed（已 close 会话）/ no_session → 落到下面 resume / 新会话
  }

  const apiKey = bootArgs?.apiKey?.trim() || undefined;
  const model =
    bootArgs?.model && typeof bootArgs.model.id === "string"
      ? bootArgs.model
      : undefined;

  // 2) 服务重启 / 空闲回收后：Agent.resume 接回再 send
  // 复审 G1：本路径是 ask 答案的 owner——claimRun + ownerInstanceId，先发答案再 flush 队列
  if (task.sessionAgentId && apiKey && model && !hasChatSession(task.id)) {
    const claimedInstanceId = await resumeChatSession(task, { apiKey, model }, {
      claimRun: true,
    });
    if (claimedInstanceId !== null) {
      const sent = await sendChatMessage(
        task,
        replyText,
        imagePaths,
        undefined,
        { ownerInstanceId: claimedInstanceId },
      );
      if (sent === "sent") return true;
      // K1/L2：claim 被用户 stop 摘除 / 实例被替换 → 取消是终态，
      // 不得落到第 3 步起新会话重放答案
      if (sent === "cancelled" || sent === "owner_invalid") return false;
      // send_failed（已 close 会话）/ busy（已释放认领）→ 落到第 3 步
    }
  }

  // 3) 起新会话（答案作首条）——同 chat-reply 模式 2
  if (!apiKey || !model) return false;
  if (hasChatSession(task.id)) {
    // race：resume 后别处又起了 run → 再试一次 send
    return (await sendChatMessage(task, replyText, imagePaths)) === "sent";
  }

  // P1 #6 / S1：与 chat-reply 模式 2 同口径——起新会话前同步占启动 lease，
  // 失败则复查会话再试 send（别处可能刚起完）、仍失败返 false
  const startToken = tryReserveChatStart(task.id);
  if (startToken === null) {
    if (hasChatSession(task.id)) {
      return (await sendChatMessage(task, replyText, imagePaths)) === "sent";
    }
    return false;
  }

  try {
    // S1：await 后复查 lease（stop 可能发生在 setTaskRunStatus 之前）
    if (!isChatStartLeaseValid(task.id, startToken)) return false;
    const runningTask = await setTaskRunStatus(task.id, "running");
    if (!runningTask || !isChatStartLeaseValid(task.id, startToken)) {
      return false;
    }
    publish(task.id, { kind: "task", task: runningTask });
    // ⚠️ 上面 await 是让出点：期间别处（chat-reply / resume）可能已注册会话——
    // runChatSession 开头的幂等 return 会**静默吞掉 firstMessage**（答案丢失且无
    // 错误事件、调用方却报成功）。复查一次、已有会话就改走 send 续接。
    if (hasChatSession(task.id)) {
      return (await sendChatMessage(task, replyText, imagePaths)) === "sent";
    }
    void runChatSession({
      task: runningTask,
      apiKey,
      model,
      firstMessage: {
        text: replyText,
        imagePaths: imagePaths && imagePaths.length > 0 ? imagePaths : undefined,
      },
      startToken,
    }).catch((err) => {
      console.error(
        `[chat-runner] deliverChatAskReply runChatSession task=${task.id} failed:`,
        err,
      );
    });
    return true;
  } finally {
    // 幂等：runChatSession 同步 prologue 已带 token release 过也无妨；兜中途 throw / early return
    releaseChatStart(task.id, startToken);
  }
};

// ----------------- P5.1：队列 flush -----------------

/**
 * run 自然结束后 dequeue 一条并 send；成功后再落 user_reply（时序语义）。
 * 发送后 consumeChatRun 会再次 flush，形成链式排空。
 *
 * 入口先查 rewind 门闩、再置 drainingQueues（在 dequeue 之前）——与 rewind 侧
 *「begin 门闩后复查 draining」交叉闭合：要么 flush 先置 draining（rewind 复查看到、
 * 拒绝回退），要么 rewind 先占门闩（本入口看到、不启动 drain）。chat-reply 见
 * draining 标记则入队，保证已排队消息不被新消息插队（P2 #8）。
 * 「塞回队首 + return」也经 finally 清位；塞回前比对 generation，防 stop/rewind
 * 清队后旧消息复活。
 *
 * export for tests：T4 single-flight / FIFO 定向测试直接调此入口。
 */
export const flushChatQueue = async (taskId: string): Promise<void> => {
  // 与 rewind begin→复查 draining 配对：门闩已占则绝不 dequeue，避免「队列已空
  // → rewind 复查放行」与随后 checkpoint/send 并发
  if (isChatRewindInProgress(taskId)) return;

  // T4：per-task 单 owner drain——非 owner 直接返回，防双 drain 并发 dequeue
  // 破坏 FIFO / 两个 finally 提前清 draining 标记。Node 单线程：同步
  // check-and-set（第一个 await 之前）即原子。
  // 配套：compact finally 的 void flush 与 maybeAutoCompactThenFlush catch 的
  // await flush 会撞车——谁先到谁当 owner，另一路直接 return；消息不会滞留
  //（owner 发队首，后续靠 run 结束后链式 flush）。
  if (drainingQueues.has(taskId)) return;

  drainingQueues.add(taskId);
  try {
    // 记下 dequeue 时的 generation；中途 clearChatQueue 会 +1，塞回前比对
    const genAtDequeue = getChatQueueGeneration(taskId);
    /** generation 未变才塞回；变了 = stop/rewind/删任务已作废该消息，丢弃防复活 */
    const requeueIfSameGen = (msg: QueuedChatMsg, reason: string): void => {
      if (getChatQueueGeneration(taskId) !== genAtDequeue) {
        console.warn(
          `[chat-runner] flushChatQueue task=${taskId} 丢弃已作废消息（${reason}）：` +
            `generation 已变 ${genAtDequeue}→${getChatQueueGeneration(taskId)}`,
        );
        return;
      }
      enqueueChatMessageFront(taskId, msg);
    };

    const msg = dequeueChatMessage(taskId);
    if (!msg) return;
    // S4（十二轮）：dequeue 后立即占 in-flight，直到本条出路（成功/塞回/作废/清队）
    beginChatQueueInFlight(taskId);
    try {
      const task = await getTask(taskId);
      if (!task || task.mode !== "chat") {
        clearChatQueue(taskId);
        return;
      }
      // 无存活会话 → 清队列（没法按序送达）；compact 窗口例外：塞回队首等 compact 完再 flush
      if (!hasChatSession(taskId)) {
        if (isChatCompactInProgress(taskId)) {
          requeueIfSameGen(msg, "compact 例外塞回");
          return;
        }
        // 复审 F2：compact 中途失败（重建会话失败等）导致会话消失时，清队不再静默——
        // 至少写一条 info，让用户知道排队消息未送达。+1 含本轮已 dequeue 的这条。
        const n = getChatQueueCount(taskId) + 1;
        clearChatQueue(taskId);
        try {
          // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：清队系统通知（会话已关、无实例可绑）
          await writeEventAndPublish(taskId, {
            kind: "info",
            text: `会话已关闭，${n} 条排队消息未送达、请重新发送`,
          });
        } catch (err) {
          console.warn(
            `[chat-runner] flushChatQueue task=${taskId} 清队通知失败:`,
            err,
          );
        }
        return;
      }
      if (isChatRunActive(taskId) || isChatCompactInProgress(taskId)) {
        requeueIfSameGen(msg, "runActive/compact 塞回");
        return;
      }

      // 本条是否已送达（send 成功后 appendEvent 等再抛错时，清队文案不应把它算成未送达）
      let delivered = false;
      try {
        // checkpoint 与 chat-reply 同口径：绑仓才打
        let capture = {
          ok: false as boolean,
          repoSnapshots: [] as Awaited<
            ReturnType<typeof captureChatCheckpoint>
          >["repoSnapshots"],
          elapsedMsByRepo: {} as Record<string, number>,
          warnings: [] as string[],
        };
        if (task.repoPaths.length > 0) {
          capture = await captureChatCheckpoint(task.repoPaths);
        }

        const sent = await sendChatMessage(
          task,
          msg.agentText || msg.displayText,
          msg.imageAbsPaths,
          msg.attachmentAbsPaths,
        );
        if (sent !== "sent") {
          requeueIfSameGen(msg, `send 未送达（${sent}）塞回`);
          return;
        }
        delivered = true;

        // 入队方已落过 user_reply（并发起会话被吞改入队等）→ 跳过重复气泡 / checkpoint
        if (msg.skipPersistEvent) return;

        const meta: Record<string, unknown> = {};
        if (msg.savedImages && msg.savedImages.length > 0) {
          meta.images = msg.savedImages;
        }
        if (msg.attachmentMetas && msg.attachmentMetas.length > 0) {
          meta.attachments = msg.attachmentMetas;
        }
        if (capture.ok) meta.checkpointed = true;
        const replyEvent = await appendEvent(taskId, {
          kind: "user_reply",
          text: msg.displayText,
          meta: Object.keys(meta).length > 0 ? meta : undefined,
        });
        if (replyEvent) {
          publish(taskId, { kind: "event", event: replyEvent });
          if (capture.ok) {
            await persistCheckpointForReply(taskId, replyEvent.id, capture);
          }
        }
      } catch (err) {
        console.error(`[chat-runner] flushChatQueue task=${taskId} failed:`, err);
        // 复审（11 轮）：清队不再静默——对齐 F2/N3 口径，先同步清队再 best-effort 写 info。
        // 本条若已 send 成功（失败发生在落 user_reply 等后置步骤），不计入「未送达」条数。
        const n = getChatQueueCount(taskId) + (delivered ? 0 : 1);
        clearChatQueue(taskId);
        if (n > 0) {
          try {
            // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：清队系统通知（会话已关、无实例可绑）
            await writeEventAndPublish(taskId, {
              kind: "info",
              text: `排队消息处理失败，${n} 条排队消息未送达、请重新发送`,
            });
          } catch (logErr) {
            console.warn(
              `[chat-runner] flushChatQueue task=${taskId} 清队通知失败:`,
              logErr,
            );
          }
        }
      }
    } finally {
      // clearChatQueue 已清过也幂等
      endChatQueueInFlight(taskId);
    }
  } finally {
    drainingQueues.delete(taskId);
  }
  // T4 配套：single-flight 下，consume 收尾的链式 flush 可能撞上「本轮仍 draining」
  // 而空 return，队内后续消息会滞留。本轮 finally 清位后：若队列非空且会话空闲
  //（无 run / compact / rewind），再续一次 drain。run 仍活跃时不续——等 consume
  // 自己的链式 flush，避免「dequeue → 见 busy → 塞回 → 再 flush」忙等。
  if (
    getChatQueueCount(taskId) > 0 &&
    !drainingQueues.has(taskId) &&
    !isChatRunActive(taskId) &&
    !isChatCompactInProgress(taskId) &&
    !isChatRewindInProgress(taskId)
  ) {
    void flushChatQueue(taskId);
  }
};

// ----------------- 复审 H1：释放认领后等 rewind 门闩再补 drain -----------------

/**
 * flushChatQueue 入口见 rewind 门闩会直接 return，所以释放认领当下 flush 无用，
 * 必须等门闩解除后补 drain。
 *
 * 若 rewind 最终成功，closeChatSessionUnconditional 已清队，补 drain 自然 no-op；
 * 若 rewind 被拒绝（队列非空正是拒因），补 drain 把已 202 的排队消息发出去——
 * 否则 session idle && queue>0 && !draining 永久悬空。
 *
 * 同 task 已有 deferred drain 在等则去重 return，防叠加轮询。
 */
const CHAT_DEFERRED_DRAIN_KEY = "__feAiFlowChatDeferredDrainV1__";
const DEFERRED_DRAIN_POLL_MS = 250;
/** 防御性上限：rewind 的 finally 保证门闩必然释放，超时只是兜底仍尝试一次 flush */
const DEFERRED_DRAIN_MAX_WAIT_MS = 10 * 60 * 1000;

const getDeferredDrainSet = (): Set<string> => {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  if (!g[CHAT_DEFERRED_DRAIN_KEY]) {
    g[CHAT_DEFERRED_DRAIN_KEY] = new Set();
  }
  return g[CHAT_DEFERRED_DRAIN_KEY]!;
};

const scheduleQueueDrainAfterGate = (taskId: string): void => {
  const pending = getDeferredDrainSet();
  if (pending.has(taskId)) return;
  pending.add(taskId);
  void (async () => {
    try {
      const deadline = Date.now() + DEFERRED_DRAIN_MAX_WAIT_MS;
      while (isChatRewindInProgress(taskId)) {
        if (Date.now() >= deadline) {
          console.warn(
            `[chat-runner] scheduleQueueDrainAfterGate task=${taskId}` +
              ` 等 rewind 门闩超时（${DEFERRED_DRAIN_MAX_WAIT_MS}ms），仍尝试 flush`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, DEFERRED_DRAIN_POLL_MS));
      }
      // compact 进行中时 flush 会塞回队首、等 compact finally 再 flush——已有链路，不特判
      await flushChatQueue(taskId);
    } catch (err) {
      console.warn(
        `[chat-runner] scheduleQueueDrainAfterGate task=${taskId} 失败:`,
        err,
      );
    } finally {
      pending.delete(taskId);
    }
  })();
};

// ----------------- P4.2：compact -----------------

export type CompactChatErrorCode =
  | "not_found"
  | "not_chat"
  | "run_active"
  | "no_session"
  | "summarize_failed"
  /** S3（十二轮）：用户 stop / compact 事务 abort——不重试、不重建 */
  | "summarize_cancelled"
  | "restart_failed"
  | "compact_busy";

export class CompactChatError extends Error {
  readonly code: CompactChatErrorCode;
  readonly status: number;

  constructor(code: CompactChatErrorCode, message: string, status: number) {
    super(message);
    this.name = "CompactChatError";
    this.code = code;
    this.status = status;
  }
}

/**
 * run 自然结束后：超阈值则自动 compact，再 flush 队列；否则直接 flush。
 * 失败降级为 info 提示手动，标记 attempted 防死循环。
 */
const maybeAutoCompactThenFlush = async (taskId: string): Promise<void> => {
  // 压缩重建的续接 turn 收尾时外层仍持 compactInProgress——跳过，由外层 flush
  if (isChatCompactInProgress(taskId)) return;

  const usage = getChatContextUsage(taskId);
  const inputTokens = usage?.lastUsage.inputTokens ?? 0;
  const attempted = usage?.autoCompactAttempted === true;
  if (!shouldAutoCompactAfterTurn(inputTokens, attempted)) {
    await flushChatQueue(taskId);
    return;
  }
  // 无活会话（极少）→ 跳过自动、仍 flush
  if (!hasChatSession(taskId) || isChatRunActive(taskId)) {
    await flushChatQueue(taskId);
    return;
  }

  markChatAutoCompactAttempted(taskId);
  try {
    // compactChatSession 成功后会自己 flush
    await compactChatSession(taskId, { reason: "auto" });
  } catch (err) {
    // S3（十二轮）：用户主动取消不算失败提示，compact finally 已 flush
    if (err instanceof CompactChatError && err.code === "summarize_cancelled") {
      return;
    }
    const msg =
      err instanceof Error ? err.message : String(err);
    console.warn(`[chat-runner] 自动 compact 失败 task=${taskId}:`, err);
    // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：compact 系统通知
    await writeEventAndPublish(taskId, {
      kind: "info",
      text: "上下文过大，自动压缩失败，可手动压缩会话",
      meta: {
        kind: "compact_suggested",
        inputTokens,
        autoFailed: true,
        detail: msg.slice(0, 200),
      },
    });
    // T4：compact finally 已 void flush；此处再 await 是失败路径兜底。
    // single-flight 下若 finally 已抢成 owner，本调用直接 return——无消息滞留
    //（owner 会把队首发出去，后续消息靠 run 结束后的链式 flush）。
    await flushChatQueue(taskId);
  }
};

/**
 * 一次性问答：对存活会话 send 摘要指令，只收集文本、不落 user_reply / assistant_message。
 * （对齐 task 侧 startOneShotQuestion 的 oneshot 语义，但不另起 agent——复用当前会话上下文。）
 */
const runChatSummarizeOnesHot = async (
  taskId: string,
  prompt: string,
): Promise<string> => {
  const rec = runningChats.get(taskId);
  if (!rec?.agent || rec.runActive) {
    throw new CompactChatError(
      "no_session",
      "无可用会话或 agent 正在回",
      400,
    );
  }
  rec.runActive = true;
  let collected = "";
  // M1 同款：agent.send 是 await 点，stop 可发生在 pending 期间——共享取消闭包
  // 记录信号、run 一旦可用立即补 cancel，摘要绝不能在「已停止」之后继续跑。
  let cancelledDuringSend = false;
  let summarizeRun: ChatRun | undefined;
  const cancelBeforeSend = rec.cancel;
  rec.cancel = () => {
    cancelledDuringSend = true;
    if (summarizeRun) void summarizeRun.cancel().catch(() => {});
    cancelBeforeSend();
  };
  try {
    const runningTask = await setTaskRunStatus(taskId, "running");
    if (runningTask) publish(taskId, { kind: "task", task: runningTask });

    const run = await rec.agent.send(prompt, {
      onDelta: () => {},
      onStep: () => {},
    });
    summarizeRun = run;
    // 与 sendChatMessage 同款：包装并转调旧 cancel、不裸替换（保持 stop 语义链完整）
    rec.cancel = () => {
      cancelledDuringSend = true;
      void run.cancel().catch(() => {});
      cancelBeforeSend();
    };
    // S3（十二轮）：取消走专用码，compact 重试循环不得当普通失败再试一次
    if (cancelledDuringSend) {
      void run.cancel().catch(() => {});
      throw new CompactChatError(
        "summarize_cancelled",
        "压缩已被用户取消",
        409,
      );
    }

    for await (const msg of run.stream()) {
      // 与 sdk-message-handler assistant 分支同口径：拼 text block，不落盘
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            collected += block.text;
          }
        }
      }
    }

    const result = await run.wait();
    if (result.status === "cancelled" || cancelledDuringSend) {
      throw new CompactChatError(
        "summarize_cancelled",
        "压缩已被用户取消",
        409,
      );
    }
    if (result.status !== "finished") {
      throw new CompactChatError(
        "summarize_failed",
        `摘要 run 状态=${result.status}`,
        400,
      );
    }
    // 部分 SDK 把终稿放在 result.result
    if (collected.trim().length < MIN_COMPACT_SUMMARY_CHARS && result.result) {
      collected = result.result;
    }
    return collected;
  } finally {
    // 恢复 stop 链，避免摘要结束后 cancel 仍指向本轮包装
    rec.cancel = cancelBeforeSend;
    rec.runActive = false;
    rec.lastActiveAt = Date.now();
    // 用户 stop 已把 runStatus 归位 idle——不得再覆盖成 awaiting_user
    if (!cancelledDuringSend) {
      const idleTask = await setTaskRunStatus(taskId, "awaiting_user");
      if (idleTask) publish(taskId, { kind: "task", task: idleTask });
    }
  }
};

/**
 * 执行 chat 会话压缩（GB full-replace 思路 + 懒重启）：
 * summarize oneshot → 关旧会话 → 新会话首包注入摘要 → 落 info + compact_summary。
 *
 * reason=auto：文案「已自动压缩」；手动保留原「已压缩」。
 * compactInProgress 期间 send 返 false → 消息进队列；完成后由调用方 flush。
 *
 * 与 rewind 交叉闭合（N2）：先只读校验 task（不占位）→ 同步临界区先占 compact
 * 再复查 rewind / runActive / session（中间无 await）。rewind 侧 tryBeginChatRewind
 * 占位后复查 isCompactInProgress。
 */
export const compactChatSession = async (
  taskId: string,
  opts: { keepHints?: string; reason?: "manual" | "auto" } = {},
): Promise<Task> => {
  const reason = opts.reason ?? "manual";

  // 前置校验（只读、不占位）：注定失败时不要先置 compact，否则 chat-reply 在
  // await getTask 窗口里看到标记会白白入队，compact 再抛 no_session 时 finally
  // flush 无会话会清队——复审 F2 静默丢消息。
  const task = await getTask(taskId);
  if (!task) {
    throw new CompactChatError("not_found", "task 不存在", 404);
  }
  if (task.mode !== "chat") {
    throw new CompactChatError("not_chat", "仅 chat 模式支持压缩", 409);
  }

  // 同步临界区（中间无 await）：先占 compact 再查 rewind——保持 N2 交叉契约。
  // 临界区内复查是防 getTask await 期间状态变化。
  if (isChatCompactInProgress(taskId)) {
    throw new CompactChatError(
      "compact_busy",
      "正在压缩会话、请稍候",
      409,
    );
  }
  setChatCompactInProgress(taskId, true);
  if (isChatRewindInProgress(taskId)) {
    setChatCompactInProgress(taskId, false);
    throw new CompactChatError("run_active", "正在回退到检查点", 409);
  }
  if (isChatRunActive(taskId)) {
    setChatCompactInProgress(taskId, false);
    throw new CompactChatError(
      "run_active",
      "agent 正在回、等它说完再压缩",
      409,
    );
  }
  if (!hasChatSession(taskId)) {
    setChatCompactInProgress(taskId, false);
    throw new CompactChatError(
      "no_session",
      "无活会话、请先发一条消息再压缩",
      400,
    );
  }

  /** S3（十二轮）：abort 命中 → 专用码抛出，调用方不得再产生重建副作用 */
  const throwIfCompactAborted = (): void => {
    if (isChatCompactAborted(taskId)) {
      throw new CompactChatError(
        "summarize_cancelled",
        "压缩已被用户取消",
        409,
      );
    }
  };

  try {
    const summarizePrompt = buildCompactSummarizePrompt(opts.keepHints);
    let summary = "";
    let lastErr: unknown;
    // GB：不足 500 字视为失败，重试 1 次（共 2 次）
    for (let attempt = 0; attempt < 2; attempt++) {
      // 每次 attempt 前查 abort——用户 stop 后绝不再开第二次摘要
      throwIfCompactAborted();
      try {
        const raw = await runChatSummarizeOnesHot(taskId, summarizePrompt);
        const extracted = extractCompactSummaryText(raw);
        if (extracted.length >= MIN_COMPACT_SUMMARY_CHARS) {
          summary = extracted;
          lastErr = null;
          break;
        }
        lastErr = new Error(
          `摘要过短（${extracted.length} 字 < ${MIN_COMPACT_SUMMARY_CHARS}）`,
        );
      } catch (err) {
        lastErr = err;
        // no_session / summarize_cancelled：与终态同款直接抛，不进第二次尝试
        if (
          err instanceof CompactChatError &&
          (err.code === "no_session" || err.code === "summarize_cancelled")
        ) {
          throw err;
        }
      }
    }
    if (!summary || summary.length < MIN_COMPACT_SUMMARY_CHARS) {
      const msg =
        lastErr instanceof Error
          ? lastErr.message
          : lastErr
            ? String(lastErr)
            : "摘要生成失败";
      if (lastErr instanceof CompactChatError) throw lastErr;
      throw new CompactChatError("summarize_failed", `压缩摘要失败：${msg}`, 400);
    }

    // —— 摘要成功后的重建序列：每个 await 前后查 abort，命中则停、不写事件、不置 running、不重建 ——
    throwIfCompactAborted();
    // 记下旧会话模型，关旧 → 起新
    const oldModel = getChatRunModel(taskId);
    const creds = await readServerChatCreds();
    throwIfCompactAborted();
    const apiKey = creds?.apiKey;
    const model = oldModel ?? creds?.model;
    if (!apiKey || !model) {
      throw new CompactChatError(
        "restart_failed",
        "缺少 API Key / 模型，无法重建会话",
        400,
      );
    }

    // 关旧会话前再查：命中则保留旧会话（若尚未关）并退出
    throwIfCompactAborted();
    closeChatSession(taskId);
    await waitForChatToStop(taskId, 3000);
    // 此后旧会话可能已关——abort 只阻止后续副作用（running / 重建 / 写成功事件）
    throwIfCompactAborted();

    // T5：先置 running 再重建。若重建 await 期间用户 stop，abort 已置位且
    // cancelChatRun 会取消重建 run；stop 路由自己会把 runStatus 归 idle——
    // 此处不必额外回写（避免与 stop 收尾竞态双写）。
    const runningTask = await setTaskRunStatus(taskId, "running");
    if (runningTask) publish(taskId, { kind: "task", task: runningTask });

    throwIfCompactAborted();
    try {
      // await：等续接首包 turn 结束再返回（agent 被要求本回合直接结束）
      await runChatSession({
        task: runningTask ?? task,
        apiKey,
        model,
        continuationSummary: summary,
      });
    } catch (err) {
      throw new CompactChatError(
        "restart_failed",
        `重建会话失败：${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    // T5：重建返回后先查 abort——用户 stop 命中重建阶段应抛 summarize_cancelled
    //（上层 maybeAutoCompactThenFlush 对该 code 静默分流），绝不能落成 restart_failed
    // 再追加「自动压缩失败」。
    throwIfCompactAborted();
    // 复审（11 轮）：runChatSession 内部 Agent.create/send 失败走 handleChatRunFailure
    // 不抛错（上面 catch 是死代码兜底）——重建失败必须显式报错，绝不能 200 假成功
    if (!hasChatSession(taskId)) {
      throw new CompactChatError(
        "restart_failed",
        "重建会话失败（新会话未存活）、请重试压缩或直接发消息",
        500,
      );
    }

    // T5：compact_done / compact_summary 挪到重建确认成功之后再写。
    // 取舍：续接 turn 的 prompt 已要求 agent 直接结束不输出正文，通常无 assistant
    // 事件；即使有，「事件顺序小瑕疵」也好过「假成功」（事件流已显示已压缩但无可用会话）。
    const doneText =
      reason === "auto"
        ? `上下文过大，已自动压缩会话（摘要 ${summary.length} 字）`
        : `已压缩会话（摘要 ${summary.length} 字）`;
    // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：compact 完成通知（重建确认成功后写、用户操作链）
    await writeEventAndPublish(taskId, {
      kind: "info",
      text: doneText,
      meta: {
        kind: "compact_done",
        summaryChars: summary.length,
        reason,
      },
    });
    // eslint-disable-next-line no-restricted-syntax -- R27-6 豁免：compact 完成通知（重建确认成功后写、用户操作链）
    await writeEventAndPublish(taskId, {
      kind: "compact_summary",
      text: `会话摘要（${summary.length} 字）`,
      meta: { summary },
    });

    const fresh = await getTask(taskId);
    if (!fresh) {
      throw new CompactChatError("not_found", "压缩后读 task 失败", 404);
    }
    return fresh;
  } finally {
    // setChatCompactInProgress(false) 同步清 aborted，防残留影响下次
    setChatCompactInProgress(taskId, false);
    // 成功或失败都尝试排空：compact 期间入队的消息在此发出
    void flushChatQueue(taskId);
  }
};
