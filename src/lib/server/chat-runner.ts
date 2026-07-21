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
 *   running → run 在跑（agent 正在答）
 *   awaiting_user → 会话在、等用户下一条
 *   idle / error → 停止 / 出错（会话已关、下一条消息起新会话、靠 events.jsonl 恢复上下文）
 *
 * # 跟 task-runner 的区别（避免误用）
 *
 * - chat-runner 不写 actions[]、不生成 artifact 文件
 * - chat prompt 里没有 [NEXT_ACTION] / [USER_MESSAGE] 任务容器概念
 */

import { Agent } from "@cursor/sdk";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  clearTaskSessionAgentIdIf,
  getTask,
  setTaskRunStatus,
  setTaskRunStatusIfRunOwner,
  setTaskSessionAgentId,
} from "./task-fs";
import { getEventsLogPath } from "./task-fs-core";
import { getChatMcpUrl } from "./chat-mcp";
import { maybeGenerateChatTitle } from "./chat-title";
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
  createSdkSummaryDeltaPublisher,
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
  writeUserEventAndPublishStrict,
  type TaskStreamEvent,
} from "./task-stream";
import { MCP_HEALTH_LABEL } from "@/lib/types";
import type { Task } from "@/lib/types";
import {
  beginChatQueueInFlight,
  dequeueChatMessage,
  emitQueuedMessageFlushed,
  endChatQueueInFlight,
  enqueueChatMessage,
  enqueueChatMessageFront,
  failQueuedItems,
  getChatQueueCount,
  getChatQueueGeneration,
  isMessageOperationTerminal,
  markMessagePersisted,
  settleMessageFailed,
  settleMessageHandedOff,
  type QueuedChatMsg,
} from "./chat-queue";
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
const CHAT_TOOL_MCP_NAME = "flowshipChat";

// chat agent / run 句柄类型（从 SDK Agent.create / agent.send 推导、给 runningChats 占位注册 + cancel 用）
type ChatAgent = Awaited<ReturnType<typeof Agent.create>>;
type ChatRun = Awaited<ReturnType<ChatAgent["send"]>>;

// ----------------- 运行时状态（独立于 task-runner）-----------------

interface RunningChatRecord {
  agentId: string;
  /**
   * 内存实例代际（每次 runningChats.set 分配、进程内单调递增、永不复用）。
   * Agent.resume 恢复同一持久化 agent 时 agentId 相同，agentId 无法区分
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
   * 解决 run 结束后 async drain 真正 send 前，新 chat-reply 看到 idle
   * 会话直接 send，新消息 C 越过已排队的 B。chat-reply 见此标记则入队保 FIFO。
   */
  drainingQueues: Set<string>;
  /** RunningChatRecord.instanceId 发号器（进程内单调、hot reload 也不回退） */
  nextChatInstanceId: number;
}

// 跟 task-runner 一样、状态挂 globalThis 避免 dev hot reload 拆分
const CHAT_RUNNER_GLOBAL_KEY = "__flowshipChatRunnerStateV2__";

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
 * 门控键从 agentId 改为 instanceId——Agent.resume 恢复同一持久化 agent 时
 * agentId 相同，旧 retry / 迟到收尾按 agentId 会误关退避期间用户恢复的新实例。
 * keepPersisted = 空闲回收用（sessionAgentId 留着、下次消息 Agent.resume 接回）
 *
 * 落盘锚点改条件清（clearTaskSessionAgentIdIf）——expected=本次关的 agentId，
 * extraGuard=内存无后继 chat 会话；`!rec` 禁止裸清（迟到 fire-and-forget 不得抹 B 锚点）。
 * @returns 是否真的关了一个会话
 */
const closeChatSession = (
  taskId: string,
  expectedInstanceId?: number,
  opts: { keepPersisted?: boolean } = {},
): boolean => {
  const rec = runningChats.get(taskId);
  if (!rec) {
    // 表内已无会话 → 禁止裸清盘上锚点（forceClear 空窗后 A 迟到清会抹 B）
    return false;
  }
  // 审查发现：旧 run 收尾缺门控时，切模型 forceClear 后迟到的 cancelled 分支会误关新会话
  if (expectedInstanceId !== undefined && rec.instanceId !== expectedInstanceId) {
    return false;
  }
  // 摘表前记下本次要关的 agentId（占位期为空串 → 条件清 naturally no-op）
  const agentIdToClear = rec.agentId;
  runningChats.delete(taskId);
  setChatAwaitingNotifier(taskId, null);
  if (rec.agent) {
    try {
      rec.agent.close();
    } catch {
      /* noop */
    }
  }
  if (!opts.keepPersisted && agentIdToClear) {
    // 条件清——finalGuard 现查「盘上仍是本 agentId + 内存无后继」
    void clearTaskSessionAgentIdIf(
      taskId,
      agentIdToClear,
      () => !runningChats.has(taskId),
    );
  }
  return true;
};

// V0.11.1：chat 会话空闲回收（同 task-runner sweeper、TTL 2h、resume 兜恢复）
const CHAT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const CHAT_SWEEPER_KEY = "__flowshipChatSweeperV1__";
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
 * 自动重连的「backoff → resume → send」窗口内表里可能没有 record，
 * 此时用户 stop 也必须让重连停下——先给 reconnect 停止闭包发信号（有 record 时
 * 同样发：reconnect 的 claim record cancel 只摘实例、不通知在退避里的重试者）。
 */
export const cancelChatRun = (taskId: string): boolean => {
  const reconnectStop = getReconnectStops().get(taskId);
  if (reconnectStop) reconnectStop();
  const rec = runningChats.get(taskId);
  if (!rec) return !!reconnectStop;
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
  // cancelled 槽只在被 owner 消费时删——forceClear（懒重启换新）后
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
  // rewind 关会话清队走唯一 sink（有门闩路径也统一）
  failQueuedItems(taskId, { reason: "rewound" });
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
 * claim 绑定实例——必须带 expectedInstanceId。当前 record 已不是原 claim
 * 实例（stop 摘除 / forceClear 换新）时整段 no-op，绝不把新实例的 runActive 误清成
 * false（旧 owner 的迟到 release 会给并发 send 开口子）。
 *
 * 释放认领 = 接管排队消息的调度义务。不能留下
 * `session idle && queue>0 && !draining` 的死局（owner 撞 rewind 门闩释放后，
 * B 已 202 入队却无人 flush）。门闩仍在时 flush 入口会直接 return，故走
 * scheduleQueueDrainAfterGate 等门闩解除后再补 drain。
 *
 * H1 的 handoff 义务仅在「当前 record 就是本 claim 实例」时成立。
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

// ----------------- claim 实例被 stop 摘除的标记 -----------------

/**
 * taskId → 被 cancelChatRun（用户停止）摘除的 claim instanceId。
 * why：owner 在 checkpoint 窗口被 stop 后，owner send 因实例失效返 false；
 * chat-reply 路由必须能区分「用户已停止」（绝不能落到起新会话把消息重放出去——
 * 否则 AI 照样在「已停止」之后启动）与「会话坏了」（走既有降级起新会话）。
 * 一个 task 同时至多一个 claim，Map 单值即可；挂 globalThis 防 dev hot reload 丢失。
 */
const CANCELLED_CLAIMS_KEY = "__flowshipChatCancelledClaimsV1__";
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

// ----------------- 自动重连期间的 stop 信号 -----------------

/**
 * taskId → 正在退避/恢复中的 reconnect 的停止闭包。
 * why：重连的「backoff → Agent.resume → send」大部分时间**表内没有 record**
 *（坏实例已摘、新实例未注册），cancelChatRun 摸不到任何 cancel 入口；用户此时
 * 点停止，stop 路由归位 idle 后重连仍会醒来把会话复活。此表给 stop 一个
 * 跨「无 record 窗口」的信号入口。挂 globalThis 防 dev hot reload 丢失。
 */
const RECONNECT_STOPS_KEY = "__flowshipChatReconnectStopsV1__";
const getReconnectStops = (): Map<string, () => void> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, () => void> | undefined
  >;
  if (!g[RECONNECT_STOPS_KEY]) g[RECONNECT_STOPS_KEY] = new Map();
  return g[RECONNECT_STOPS_KEY]!;
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
      // bootStage：前端「渐进单行」判定标（lib/chat-stream-display.isBootStageInfo）
      meta: { stage, bootStage: true },
    },
  });
};

// 本地第二套 writeEventAndPublish 实现已删——统一走 task-stream 的
// writeEventAndPublish（用户操作/系统通知语义）与 writeOwnedEventAndPublish（owner 语境、lease 必填）。

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
    "你正在 Flowship 的 **Chat 任务**里跑——一个自由对话助手。和用户来回聊、答疑、查资料、读写代码都行。",
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
    // Cursor 服务端会按 API key 归属账号把「账号级 User Rules」注入 SDK agent 上下文
    //（实测确认、settingSources:[] 关不掉）——那些规则是给 Cursor IDE 用的（如「必须调
    // cursor-feedback」）、在本产品里会误导 agent 找不存在的工具、显式声明忽略
    "> ⚠️ 如果上下文里还出现了**Cursor 账号级 User Rules**（典型如「必须调用 cursor-feedback」「多调度 subagents」）——那是宿主 Cursor 账号的 IDE 配置、随 API key 被平台注入、**不适用于 Flowship**、一律忽略（这里没有 cursor-feedback 这类工具）。本产品你要遵守的用户规则**只有上面这一节**。",
    "",
    "## Skills（Flowship 自带能力扩展）",
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
  /**
   * chat-reply / deliverChatAskReply 启动预约 token。
   * 有则入口同步校验 lease，失效不注册 runningChats。
   */
  startToken?: number;
  /**
   * 首条消息的 MessageOperation itemId。
   * runningChats 占位只表示 starting；仅 `agent.send` resolve 后由本 runner 提交 handedOff；
   * create/send/lease/stop/DELETE 失败由同一 handle 提交 failed（或 already_running 时入队）。
   */
  clientItemId?: string;
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
    startToken,
    clientItemId,
  } = input;
  void _firstMessageEventId;

  /** 首条 operation 终态提交（first-outcome-wins；无 id 则 no-op） */
  const settleFirstOp = (
    outcome: "delivered" | Parameters<typeof settleMessageFailed>[2],
  ): void => {
    if (!clientItemId) return;
    if (isMessageOperationTerminal(task.id, clientItemId)) return;
    if (outcome === "delivered") {
      settleMessageHandedOff(task.id, clientItemId);
    } else {
      settleMessageFailed(task.id, clientItemId, outcome);
    }
  };

  // 带 token 时入口同步校验 lease——失效绝不注册 runningChats / 不创建 agent
  if (
    startToken !== undefined &&
    !isChatStartLeaseValid(task.id, startToken)
  ) {
    console.warn(
      `[chat-runner] runChatSession task=${task.id} 启动 lease 已失效（token=${startToken}）、拒绝启动`,
    );
    // lease 失效 → 同 handle 明确 failed（禁止占位即 handedOff）
    settleFirstOp("stopped");
    return "lease_cancelled";
  }

  if (runningChats.has(task.id)) {
    // 并发首条都被过 hasChatSession===false 后各自 fire runChatSession，
    // 后者若静默 return → 气泡已落盘但 agent 永远收不到。有 firstMessage 就入队、
    // flush 时 skipPersistEvent 避免重复气泡。
    if (firstMessage) {
      enqueueChatMessage(task.id, {
        // 带上 operation id，queue/flush 继续同一 aggregate
        itemId: clientItemId,
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

  // cancel 收尾：统一走 finalize（失主 / forceClear 空窗一律 no-op）
  const finishCancelled = async (): Promise<void> => {
    await finalizeChatRunIfCurrent(task.id, myInstanceId, "cancelled", {
      task,
    });
  };

  // 进入即占位注册：任何时刻（含 create/send/MCP 探测冷启动期）点停止、cancelChatRun 都能命中、
  // 置 cancelled（有 run 时一并真取消 SDK run）；agentId 先空、send 出来再回填。
  // 此处 runActive 只表示 starting，绝不等于消息已 handedOff。
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
    // 兜底：注册占位后、Agent.create 前复查任务是否仍存在（DELETE 可能已 tombstone）。
    // 放在 await 点而非入口同步段——保持「进入即占位」语义，cancelChatRun 仍能命中。
    const aliveTask = await getTask(task.id);
    if (!aliveTask) {
      console.warn(
        `[chat-runner] runChatSession task=${task.id} 任务已删除/tombstone、放弃启动`,
      );
      // 任务已删 → 首条 op 明确 failed
      settleFirstOp("deleted");
      closeChatSession(task.id, myInstanceId);
      return "lease_cancelled";
    }

    // 启动段 isCurrent——forceClear + B 接管后迟到的 running / dropped-MCP 写被拒
    const isStartCurrent = (): boolean =>
      runningChats.get(task.id)?.instanceId === myInstanceId;

    // 1) 切到 running（条件写：失主 / 空窗不盖 B）
    const startedTask = await setTaskRunStatusIfRunOwner(
      task.id,
      "running",
      isStartCurrent,
    );
    if (!isStartCurrent()) {
      // 写盘 await 期间已被摘 / 替换——不继续 MCP / create（finishCancelled 对失主 no-op）
      if (cancelled) {
        await finishCancelled();
        settleFirstOp("stopped");
      } else {
        settleFirstOp("startup_failed");
      }
      return "started";
    }
    if (startedTask) publish(task.id, { kind: "task", task: startedTask });

    // 2) 拼 mcpServers：fe 自管 MCP（按 task 黑名单过滤）+ 我们自己的 chat-tool
    // （settingSources:[] 不加载任何 .cursor mcp；全局 / 项目 MCP 一律走 fe 自管配置）
    // 配置里万一也叫 flowshipChat、按我们的为准（直接覆盖）
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
    // chat agent 同样带 caller 身份（ask_user 分派层要核）
    const callerToken = String(allocTaskRunInstanceId());
    const mergedMcp: Record<string, McpServerConfig> = {
      ...cursorMcp,
      [CHAT_TOOL_MCP_NAME]: {
        type: "http",
        url: getChatMcpUrl(callerToken),
      },
    };

    // MCP 健康探测也要数秒、探测期间被停 / 换主 → 别再往下跑
    // （原「Chat 任务启动」info 已去掉：用户嫌吵，模型信息输入框下方已有）
    if (cancelled || !isStartCurrent()) {
      if (cancelled) {
        await finishCancelled();
        settleFirstOp("stopped");
      } else {
        // 实例被替换、首条未 send → failed
        settleFirstOp("startup_failed");
      }
      return "started";
    }

    // V0.6.11：有被剔除的 MCP → 写一条提示（owned sink，失主不落盘）
    if (droppedMcp.length > 0) {
      await writeOwnedEventAndPublish(task.id, isStartCurrent, {
        kind: "info",
        text: `⚠️ 已跳过 ${droppedMcp.length} 个不可用的 MCP：${droppedMcp
          .map((d) => `${d.name}（${d.detail?.split("\n")[0] ?? MCP_HEALTH_LABEL[d.status]}）`)
          .join("、")}——相关能力本次不可用、去设置页检查 / 授权`,
      });
    }

    // 3) 注入 awaiting notifier（V0.11.1 抽成共用、resume 时也要重注册）
    // 绑本实例 instanceId，ask/submit_work 状态写带 isCurrent
    registerChatNotifier(task, callerToken, myInstanceId);

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

    // Agent.create 冷启动也要数秒——期间可能被 stop（cancelled）或
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
        if (cancelled) {
          await finishCancelled();
          settleFirstOp("stopped");
        } else {
          // create 后窗口 stop/DELETE/换实例 → 首条未送达
          settleFirstOp("startup_failed");
        }
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
    );
    const perfPromptMs = Date.now() - perfPromptStart;

    // 素材收割四个 await 期间同样可能被 forceClear 换实例 / stop——send 前再复查一次。
    // 命中则 close 本地 agent、绝不能 agent.send（对齐上面 create 后与 send 后复查口径）。
    {
      const curBeforeSend = runningChats.get(task.id);
      const instanceGoneBeforeSend =
        !curBeforeSend || curBeforeSend.instanceId !== myInstanceId;
      if (cancelled || instanceGoneBeforeSend) {
        void Promise.resolve(agent.close()).catch(() => {});
        if (cancelled) {
          await finishCancelled();
          settleFirstOp("stopped");
        } else {
          settleFirstOp("startup_failed");
        }
        return "started";
      }
    }

    const perfSendStart = Date.now();
    const promptBytes = Buffer.byteLength(initialPrompt, "utf-8");
    publishBootProgress(task.id, "send", "正在发送首包…");
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: agent.agentId,
      runKind: "chat-first",
      promptBytes,
    });
    run = await agent.send(initialPrompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // chat shell delta 绑本实例 instanceId——失主丢弃迟到输出
        createShellOutputDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === myInstanceId,
        ),
        // SDK in-place summarization → 事件流一条 info
        createSdkSummaryDeltaPublisher(
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

    // send resolve 后、任何写 record / 落盘之前，
    // 复查 cancelled + instanceId——stop / forceClear+新实例 B 可发生在上面 await 期间。
    // 命中则丢弃迟到 run，绝不能把 B 的 record 覆盖成 A 的 agent / 落盘 A 的 sessionAgentId。
    const cur = runningChats.get(task.id);
    if (cancelled || !cur || cur.instanceId !== myInstanceId) {
      void run.cancel().catch(() => {});
      // 本地 agent 未挂到当前实例：显式 close，避免泄漏（finishCancelled 只关 record.agent）
      void Promise.resolve(agent.close()).catch(() => {});
      if (cancelled) {
        await finishCancelled();
        settleFirstOp("stopped");
      } else {
        settleFirstOp("startup_failed");
      }
      // instanceGone：finishCancelled 按 myInstanceId 门控对 B 是 no-op，此处不调用以免多余写盘
      return "started";
    }

    // 仅在 agent.send 成功返回 run 且实例仍 current 后提交 handedOff
    settleFirstOp("delivered");

    // 回填真实 agentId / agent 实例（占位注册时是空串 / null）——从此会话可被 send 续接。
    // agentId 同步落盘（V0.11.1 会话持久化）：服务重启后 Agent.resume 接回
    cur.agentId = agent.agentId;
    cur.agent = agent;
    void setTaskSessionAgentId(task.id, agent.agentId);

    // 首轮成功后 fire-and-forget 用 SDK auto 生成短标题（搭车本轮 apiKey；
    // 内部查 titleAutoPending 幂等、不阻塞主对话 consume）
    if (firstMessage?.text.trim()) {
      maybeGenerateChatTitle(task.id, apiKey, firstMessage.text);
    }

    await consumeChatRun(task, run, () => cancelled);
  } catch (err) {
    // Agent.create / send 阶段失败（consumeChatRun 内部错误它自己处理、不会抛）
    // stop 导致 create/send reject 时走 finishCancelled 口径（idle、不落 error），
    // 对齐 consumeChatRun 的 cancelled 分流；cancelled=false 才走 handleChatRunFailure。
    if (cancelled) {
      const cur = runningChats.get(task.id);
      const mounted =
        !!agent && cur?.instanceId === myInstanceId && cur.agent === agent;
      if (agent && !mounted) {
        void Promise.resolve(agent.close()).catch(() => {});
      }
      await finishCancelled();
      settleFirstOp("stopped");
      return "started";
    }
    // Agent.create reject / send reject → startup_failed（禁止留下 handedOff）
    settleFirstOp("startup_failed");
    await handleChatRunFailure(task, err, myInstanceId);
  }
  return "started";
};

// ----------------- V0.11.1：notifier 注册 + 会话恢复 -----------------

// chat 的 awaiting notifier：ask_user 写真实 ask_user_request 事件（与 task-runner 对齐）；
// submit_work 误调仍只切 awaiting_user（chat 不用交卷）
// instanceId 绑入 isOwner——stop 已 idle / forceClear 后 B running 时迟到裸写不得盖 awaiting_user
const registerChatNotifier = (
  task: Task,
  callerToken: string,
  instanceId: number,
): void => {
  setChatAwaitingNotifier(
    task.id,
    async (signal, ctx) => {
      // chat 模式同样贯穿 caller 复查（签名对齐 task-runner）
      // 显式返回 accepted | stale（不再 void 被工具层当 delivered）
      if (!ctx.callerStillValid()) return "stale";
      // 本 run 实例仍 current（对齐 task 侧 setTaskRunStatusIfRunOwner(askLease)）
      const instanceStillCurrent = (): boolean =>
        runningChats.get(task.id)?.instanceId === instanceId;
      if (signal.kind === "ask_user_request") {
        // ask lease 含 askId——同 caller 并发/重试的旧 ask（pending map 已被
        // 新 ask 顶掉）在 supersede/event/status 每个 sink 都被拦、UI 与 pending map 不分裂
        // + 本 instance 仍 current（stop 摘表 / B 换号后拒写 awaiting_user）
        const askLease = (): boolean =>
          ctx.callerStillValid() &&
          getPendingAsk(task.id)?.askId === signal.askId &&
          instanceStillCurrent();
        // 新提问落盘前作废旧的未了结提问（同 task-runner：防旧答题卡复活）
        // supersede 带 caller lease
        await supersedePendingAsks(task.id, "被新提问顶替", askLease);
        await failpoint("mcp.askUser.afterSupersede");
        if (!askLease()) {
          // 按本次 askId 反登记并返 stale——wrapper 透传后工具不得报 ASK_SUBMITTED
          cancelPendingIf(task.id, signal.askId);
          return "stale";
        }
        const previewText = signal.questions
          .map((q, idx) => `Q${idx + 1}: ${q.question}`)
          .join("\n");
        // owned sink——lease 必填
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
          return "stale";
        }
        const updated = await setTaskRunStatusIfRunOwner(
          task.id,
          "awaiting_user",
          askLease,
        );
        if (updated) publish(task.id, { kind: "task", task: updated });
        return "accepted";
      }
      // submit_work 等非 ask 信号：chat 不用交卷、只切 awaiting_user（条件写）
      const submitOwner = (): boolean =>
        ctx.callerStillValid() && instanceStillCurrent();
      if (!submitOwner()) return "stale";
      const updated = await setTaskRunStatusIfRunOwner(
        task.id,
        "awaiting_user",
        submitOwner,
      );
      if (updated) publish(task.id, { kind: "task", task: updated });
      return "accepted";
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
 *   三个调用方（chat-reply / deliverChatAskReply / tryChatAutoReconnect）
 *   resume 后都要自己先发第一条；认领消掉「注册→owner send」窗口里的并发 send 与顺序反转。
 *   通用 resume 不再无条件 drain——后续队列等 owner run 结束后由统一 flush 排出。
 *   调用方若在 send 前失败必须 releaseChatRunClaim(taskId, instanceId)。
 * @returns claim 是实例化 token——成功返回注册的 instanceId，owner 后续
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
    // resume 发新 caller + 重注册 notifier
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
    // resume 同一持久化 agent 得到相同 agentId，但内存实例必须换新号
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
      // claim 态没有真 run，stop（cancelChatRun 见 runActive 走 cancel）
      // 必须真正摘除本实例并记录 cancelled——owner 稍后 send 因 instanceId 不匹配
      // 整段 no-op，路由凭 cancelled 标记识别「用户已停止」、不再降级起新会话重放消息，
      // 不会出现「已中断」之后 AI 又开始跑。consumeChatRun 起真 run 后会覆盖此 cancel。
      cancel: () => {
        if (closeChatSession(task.id, instanceId)) {
          getCancelledClaims().set(task.id, instanceId);
        }
      },
    });
    registerChatNotifier(task, callerToken, instanceId);
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
    // 条件清（chat 侧）——finalGuard 每次 rename 前复查本闭包。
    // 必须现查（非入场快照）：内存无后继 session + 本链 start lease 仍 valid。
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
 *   send 失败递归时传本轮 rec.instanceId）。退避窗口内不得留下可被第三方
 *   当 idle 用的旧会话；醒来后只按 staleInstanceId 门控关闭，绝不误关用户新起的 run。
 *   门控键必须是 instanceId 而非 agentId——退避期间用户 chat-reply 会
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
  // 重连的 backoff/resume/send 大部分时间表内没有 record，cancelChatRun
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
  // preamble 授权收紧——仅「map 里仍是本 stale instance」才落盘；
  // map 空（forceClear / B checkpoint 半程 / 本轮已自摘）无干净判据区分「重连空窗」与
  // 「B 启动空窗」，降级 console.log 不污染 B 时间线（持槽才落盘；map 空/失主则降级日志）。
  const curBeforePreamble = runningChats.get(task.id);
  const stillOwnsSlot =
    staleInstanceId !== undefined &&
    !!curBeforePreamble &&
    curBeforePreamble.instanceId === staleInstanceId;
  if (
    curBeforePreamble &&
    staleInstanceId !== undefined &&
    curBeforePreamble.instanceId !== staleInstanceId
  ) {
    console.warn(
      `[chat-runner] task=${task.id} 自动重连 preamble 让位：表内已是新会话实例` +
        `（stale=#${staleInstanceId}、current=#${curBeforePreamble.instanceId}）`,
    );
    return true;
  }
  if (stillOwnsSlot) {
    // eslint-disable-next-line no-restricted-syntax -- 持槽才落盘的重连系统通知
    await writeEventAndPublish(task.id, {
      kind: "info",
      text: `连接中断、正在自动重连（第 ${attempt}/${RECONNECT_MAX} 次）…`,
      meta: { kind: "reconnecting", attempt, max: RECONNECT_MAX },
    });
  } else {
    console.log(
      `[chat-runner] task=${task.id} 自动重连（第 ${attempt}/${RECONNECT_MAX} 次）` +
        `——map 空/失主，preamble 不落盘`,
    );
  }
  if (await sleepWithCancel(RECONNECT_BACKOFF_MS[attempt - 1], isCancelled)) {
    return false;
  }
  // /J1：退避醒来后用户可能已另起新会话（resume 同持久化 agent 时 agentId
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
  // 重连方是 reconnect prompt 的 owner——认领首发，排队消息等本 run 结束后统一 flush
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
  // owner 只操作自己 claim 的实例——注册后若已被替换（同 tick 内理论不可能、
  // 防御性校验），绝不向别人的实例发 reconnect prompt。无 rec 则无认领泄漏。
  if (!rec?.agent || rec.instanceId !== claimedInstanceId) return false;
  // stop 到达于 Agent.resume await 期间（当时表内无 record、只有停止闭包
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
    // 否则 flush / 并发 send 可插在 reconnect prompt 之前（ 点名的晚置位窗口）
    const run = await rec.agent.send(reconnectPrompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // 重连 shell delta 绑 claimedInstanceId
        createShellOutputDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === claimedInstanceId,
        ),
        createSdkSummaryDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === claimedInstanceId,
        ),
      ),
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
    // send pending 期间用户 stop（claim cancel 已摘表）或实例被
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
    // owner 语境（重连链、send 后已验实例）——claimedInstanceId lease
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
    // send pending 期间被用户 stop（claim cancel 已摘表 + 落标记）、随后 send
    // 抛错 → 不得再退避重试把会话复活；stop 方已收尾，直接接管返 true。
    if (consumeChatClaimCancelled(task.id, claimedInstanceId)) {
      return true;
    }
    // 勿只清 runActive 留下 idle 会话进退避——第三方 chat-reply 会当可用会话
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

/** finalize 收尾 outcome */
type FinalizeChatOutcome = "finished" | "cancelled" | "error";

/** finalize 上下文（error 携带原始异常） */
type FinalizeChatRunCtx = {
  task: Task;
  err?: unknown;
};

/**
 * chat run 收尾唯一入口——所有 status/queue/session/done/error/flush
 * 共享写只有在「runningChats 当前记录仍是本 instanceId」的 CAS 下执行；
 * 失主（含 map 为空——forceClear 空窗不是授权）一律 no-op 只清本地。
 *
 * @returns true = 本实例仍是当前主并完成收尾；false = 失主 no-op
 */
const finalizeChatRunIfCurrent = async (
  taskId: string,
  instanceId: number,
  outcome: FinalizeChatOutcome,
  ctx: FinalizeChatRunCtx,
): Promise<boolean> => {
  // 插桩在 CAS 之前：测试按此名注入 forceClear + B 启动
  await failpoint("chat.beforeFinalize");

  const rec = runningChats.get(taskId);
  // map 为空返回 false——旧代码把「close 失败且 map 空」当有权收尾，正是 fail-open
  if (!rec || rec.instanceId !== instanceId) {
    return false;
  }

  const isCurrent = (): boolean =>
    runningChats.get(taskId)?.instanceId === instanceId;

  if (outcome === "finished") {
    // 自然结束：会话保留，只归位 awaiting_user + done + flush
    rec.runActive = false;
    rec.lastActiveAt = Date.now();
    const doneTask = await setTaskRunStatusIfRunOwner(
      taskId,
      "awaiting_user",
      isCurrent,
    );
    // 写盘 await 后失主 → 不 publish / 不 flush（避免清 B 前端 streaming）
    if (!isCurrent()) return false;
    if (doneTask) publish(taskId, { kind: "task", task: doneTask });
    publish(taskId, {
      kind: "done",
      task: doneTask ?? ctx.task,
      ok: true,
    });
    void flushChatQueue(taskId);
    return true;
  }

  if (outcome === "cancelled") {
    // 先条件写 idle（仍持 map 条目供 isOwner），再清队 / 关会话 / publish
    const cancelledTask = await setTaskRunStatusIfRunOwner(
      taskId,
      "idle",
      isCurrent,
    );
    if (!isCurrent()) return false;
    // cancelled 清队走唯一 sink（queue_failed + recentSettled）
    failQueuedItems(taskId, { reason: "cancelled" });
    const closed = closeChatSession(taskId, instanceId);
    if (!closed) return false;
    if (cancelledTask) publish(taskId, { kind: "task", task: cancelledTask });
    publish(taskId, {
      kind: "done",
      task: cancelledTask ?? ctx.task,
      ok: true,
    });
    return true;
  }

  // outcome === "error"
  // run 失败可能是「缓存 ok 期间 MCP 挂了」——清探测缓存、用户重试时必真探
  invalidateMcpProbeCache();
  const message =
    ctx.err instanceof Error ? ctx.err.message : String(ctx.err ?? "");
  const failure = summarizeRunFailure(message, ctx.err);
  const eventText = failure.isConnectionDrop
    ? failure.text
    : `Chat agent 异常：${failure.text}`;
  // 失败事件走 owned sink——失主不落盘不 publish
  await writeOwnedEventAndPublish(taskId, isCurrent, {
    kind: "error",
    text: eventText,
    meta: { detail: failure.detail },
  });
  if (!isCurrent()) return false;
  const errorTask = await setTaskRunStatusIfRunOwner(
    taskId,
    "error",
    isCurrent,
  );
  if (!isCurrent()) return false;
  // error 清队走唯一 sink（queue_failed + recentSettled）
  failQueuedItems(taskId, { reason: "error" });
  const closed = closeChatSession(taskId, instanceId);
  if (!closed) return false;
  // 关会话后不再 await getTask——避免空窗里 B 已启动却仍 publish done 清其 streaming
  if (errorTask) publish(taskId, { kind: "task", task: errorTask });
  publish(taskId, {
    kind: "done",
    task: errorTask ?? ctx.task,
    ok: false,
  });
  publish(taskId, { kind: "error", message: eventText });
  return true;
};

// run 失败的统一收尾：收口到 finalizeChatRunIfCurrent
// expectedInstanceId：旧 run 收尾带上实例门控；失主（含 map 空）整段 no-op
const handleChatRunFailure = async (
  task: Task,
  err: unknown,
  expectedInstanceId?: number,
): Promise<void> => {
  console.error("[chat-runner] task", task.id, "failed:", err);
  // 无 instance 哨兵 -1：CAS 永不匹配，避免无门控裸收尾
  const instanceId = expectedInstanceId ?? -1;
  await finalizeChatRunIfCurrent(task.id, instanceId, "error", { task, err });
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
  // 捕获本 run 的 instanceId lease——forceClear/懒重启换新会话后，
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
        // flush 走 owned sink——本实例已被摘除/替换则不落盘
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
      // chat 主消息流接 instanceId lease（缺省 opHandle ≠ 永远 current 的语义已删）
      await handleSdkMessage(task.id, msg, ctx, chatLease);
    }
    await ctx.flush();

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    const result = await run.wait();

    if (cancelled || externallyCancelled?.() || result.status === "cancelled") {
      // cancel 收尾唯一入口——失主（含 forceClear 空窗）no-op
      await finalizeChatRunIfCurrent(task.id, myInstanceId, "cancelled", {
        task,
      });
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

    // 自然 finished 也必须查 instance——旧实现完全不查、空窗可覆盖 B
    await finalizeChatRunIfCurrent(task.id, myInstanceId, "finished", {
      task,
    });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    // 用户 stop 后 stream 以异常收场（abort 类）→ 走 cancel 收尾，
    // 绝不落 error 事件 / error 状态覆盖 stop 路由已写的 idle +「用户停止了对话」。
    if (cancelled || externallyCancelled?.()) {
      await finalizeChatRunIfCurrent(task.id, myInstanceId, "cancelled", {
        task,
      });
      return;
    }
    // V0.13.x：网络类失败先自动重连（重试 5 次、事件流显示「重连中」）
    // /J1：传入本 run 的 instanceId 作 staleInstanceId
    // 清队挪进 finalize error/cancelled——重连路径不再 fail-open 清队
    const handled = await tryChatAutoReconnect(
      task,
      err,
      reconnectAttempt + 1,
      () => cancelled || !!externallyCancelled?.(),
      myInstanceId >= 0 ? myInstanceId : undefined,
    );
    if (!handled) {
      await handleChatRunFailure(task, err, myInstanceId);
    }
  }
};

// ----------------- V0.11：sendChatMessage（续接存活会话） -----------------

/**
 * sendChatMessage 的结构化结果（）。
 * why 不是布尔：owner claim 被 stop 摘除 / 实例被替换时，send 返 false 会被
 * chat-reply 当「普通无会话故障」降级到 mode 2 起新会话——AI 在「用户已停止」
 * 之后又开始跑。取消必须是不可降级重试的终态，调用方要能区分：
 * - `sent`：已送达（run 已异步起消费）
 * - `cancelled`：owner claim 被用户 stop 摘除（内部已消费 cancelled 标记）→ 调用方终止请求、绝不入 mode 2
 * - `owner_invalid`：owner claim 实例已被替换（forceClear 换新等）→ 同样终止、不得把消息重放给新实例
 * - `busy`：run 在跑 / rewind 门闩中 / 会话冷启动占位 → 调用方入队
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
 *   claim 是实例化 token，不是布尔——传入后要求当前 record.instanceId
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
  // owner 的实例校验放在一切副作用之前——当前 record 不是原 claim 实例
  //（stop 已摘除 / 懒重启 forceClear 后换成新实例）时，旧 owner 不得越权发送、
  // 不得动新实例的任何状态；claim 已随原实例消亡，无需也不能 release。
  // 区分「用户 stop」（cancelled 标记命中）与「实例被替换」——两者对
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
   * 统一走 releaseChatRunClaim（ handoff：释放 = 接管排队 drain 义务）。 */
  const releaseOwnerClaimIfNeeded = (): void => {
    if (ownerInstanceId === undefined) return;
    releaseChatRunClaim(task.id, ownerInstanceId);
  };

  // rewind 进行中：busy → chat-reply 入队（enqueueOrReject 内部见门闩会 409）
  if (isChatRewindInProgress(task.id)) {
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

  // `agent.send()` 是 await 点——用户可在 promise pending 期间 stop。
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
    });
    run = await rec.agent.send(prompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // follow-up shell delta 绑 rec.instanceId
        createShellOutputDeltaPublisher(
          task.id,
          () => runningChats.get(task.id)?.instanceId === rec.instanceId,
        ),
        createSdkSummaryDeltaPublisher(
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
    // send pending 期间被用户 stop、随后 send 又抛错 → 终态 cancelled，
    // 绝不能返 send_failed 让 chat-reply 落 mode 2 把消息重放出去
    if (cancelledDuringSend) {
      consumeChatClaimCancelled(task.id, rec.instanceId);
      return "cancelled";
    }
    return "send_failed";
  }

  // send resolve 后、任何 task 状态 / consume 副作用之前，
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
  // agent.send 已成功 = 消息已交给 agent；status 写失败不得让 flush 把本条当未送达
  let runningTask: Task | null = null;
  try {
    runningTask = await setTaskRunStatus(task.id, "running");
  } catch (statusErr) {
    console.error(
      `[chat-runner] sendChatMessage: task=${task.id} 置 running 失败（agent 已受理）:`,
      statusErr,
    );
    void consumeChatRun(task, run);
    return "sent";
  }
  // 上面 await 期间 stop / forceClear 仍可到达——此时
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
    // 回滚 idle 与 finalize 同口径——条件进锁内/finalGuard，提交瞬间复查 map 仍空；
    // 跨 await 空窗里 B 已写 running 则拒写（旧实现快照 !has 后再 await 会盖掉 B）
    const idleTask = await setTaskRunStatusIfRunOwner(
      task.id,
      "idle",
      () => !runningChats.has(task.id),
    );
    if (idleTask) publish(task.id, { kind: "task", task: idleTask });
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
  // rewind 窗口内绝不能走 resume / 起新会话，直接返 false 让用户稍后用输入条答复
  if (isChatRewindInProgress(task.id)) {
    return false;
  }
  // 1) 存活会话直接 send
  if (hasChatSession(task.id)) {
    const sent = await sendChatMessage(task, replyText, imagePaths);
    if (sent === "sent") return true;
    // send pending 期间被 stop / 实例被替换 → 终态，
    // 不得落到下面 resume / 新会话把答案在「已停止」之后重放
    if (sent === "cancelled" || sent === "owner_invalid") return false;
    // busy（run 在跑）→ 终止而非降级，防答案绕过在跑的 run 干扰会话；
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
  // 本路径是 ask 答案的 owner——claimRun + ownerInstanceId，先发答案再 flush 队列
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

  // 与 chat-reply 模式 2 同口径——起新会话前同步占启动 lease，
  // 失败则复查会话再试 send（别处可能刚起完）、仍失败返 false
  const startToken = tryReserveChatStart(task.id);
  if (startToken === null) {
    if (hasChatSession(task.id)) {
      return (await sendChatMessage(task, replyText, imagePaths)) === "sent";
    }
    return false;
  }

  try {
    // await 后复查 lease（stop 可能发生在 setTaskRunStatus 之前）
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
 * draining 标记则入队，保证已排队消息不被新消息插队。
 * 「塞回队首 + return」也经 finally 清位；塞回前比对 generation，防 stop/rewind
 * 清队后旧消息复活。
 *
 * export for tests： single-flight / FIFO 定向测试直接调此入口。
 */
export const flushChatQueue = async (taskId: string): Promise<void> => {
  // 与 rewind begin→复查 draining 配对：门闩已占则绝不 dequeue，避免「队列已空
  // → rewind 复查放行」与随后 checkpoint/send 并发
  if (isChatRewindInProgress(taskId)) return;

  // per-task 单 owner drain——非 owner 直接返回，防双 drain 并发 dequeue
  // 破坏 FIFO / 两个 finally 提前清 draining 标记。Node 单线程：同步
  // check-and-set（第一个 await 之前）即原子。
  // single-flight：谁先到谁当 owner，另一路直接 return；消息不会滞留
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
        // generation 已变且仅 persisted → 补明确 failed（禁止 delivered 假账）
        if (
          msg.itemId &&
          msg.skipPersistEvent &&
          !isMessageOperationTerminal(taskId, msg.itemId)
        ) {
          settleMessageFailed(taskId, msg.itemId, "stopped");
        }
        return;
      }
      // 已 handedOff/failed 不得重排
      if (msg.itemId && isMessageOperationTerminal(taskId, msg.itemId)) {
        console.warn(
          `[chat-runner] flushChatQueue task=${taskId} 跳过重排（已终态）：${reason}`,
        );
        return;
      }
      enqueueChatMessageFront(taskId, msg);
    };

    const msg = dequeueChatMessage(taskId);
    if (!msg) return;
    // dequeue 后立即占 in-flight，直到本条出路（成功/塞回/作废/清队）
    // 挂 itemId，bootstrap queue_state 不把正当 in-flight 误判成幽灵
    beginChatQueueInFlight(taskId, msg.itemId);
    try {
      const task = await getTask(taskId);
      if (!task || task.mode !== "chat") {
        // 任务消失 / 非 chat → 唯一入口 failQueuedItems（queue_failed）
        failQueuedItems(taskId, {
          reason: "task_gone",
          currentItemId: msg.itemId,
        });
        return;
      }
      // 无存活会话 → 清队列（没法按序送达）
      if (!hasChatSession(taskId)) {
        // 会话消失清整队走 failQueuedItems（带 itemIds 终态），info 仍 best-effort
        const failedIds = failQueuedItems(taskId, {
          reason: "no_session",
          currentItemId: msg.itemId,
        });
        if (failedIds.length > 0) {
          try {
            // eslint-disable-next-line no-restricted-syntax -- 豁免：清队系统通知（会话已关、无实例可绑）
            await writeEventAndPublish(taskId, {
              kind: "info",
              text: `会话已关闭，${failedIds.length} 条排队消息未送达、请重新发送`,
            });
          } catch (err) {
            console.warn(
              `[chat-runner] flushChatQueue task=${taskId} 清队通知失败:`,
              err,
            );
          }
        }
        return;
      }
      if (isChatRunActive(taskId)) {
        requeueIfSameGen(msg, "runActive 塞回");
        return;
      }

      // 本条是否已送达（send 成功后后续步骤再抛错时，清队文案不应把它算成未送达）
      let delivered = false;
      // user_reply 是否已落盘——send 失败塞回时必须 skipPersistEvent，防重复气泡
      let replyPersisted = !!msg.skipPersistEvent;
      try {
        // checkpoint 与 chat-reply 同口径：绑仓才打（快照须在 agent 开工前）
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

        // 先落盘再 send——堵死「agent 已收到、磁盘/UI 无记录」出口。
        // checkpoint 绑 user_reply 事件 id：先落盘再 persistCheckpoint 反而更正确。
        // 入队方已落过 user_reply（skipPersistEvent）→ 跳过重复气泡 / checkpoint。
        if (!msg.skipPersistEvent) {
          // extraMeta（飞书 source / feishuMessageId）浅合并进 user_reply.meta
          const meta: Record<string, unknown> = { ...(msg.extraMeta ?? {}) };
          if (msg.savedImages && msg.savedImages.length > 0) {
            meta.images = msg.savedImages;
          }
          if (msg.attachmentMetas && msg.attachmentMetas.length > 0) {
            meta.attachments = msg.attachmentMetas;
          }
          if (capture.ok) meta.checkpointed = true;
          // 落盘 meta 带 queueItemId，前端 pending 按 id 对账（不靠文案猜）
          meta.queueItemId = msg.itemId;
          let replyEvent;
          try {
            replyEvent = await writeUserEventAndPublishStrict(taskId, {
              kind: "user_reply",
              text: msg.displayText,
              meta,
            });
          } catch (persistErr) {
            // strict 抛错（EIO 等）→ 不 send、不自旋；走唯一入口 failQueuedItems
            // durable 警告可能与原 append 同盘失败——控制帧不依赖落盘。
            console.error(
              `[chat-runner] flushChatQueue 落盘失败 task=${taskId}:`,
              persistErr,
            );
            failQueuedItems(taskId, {
              reason: "persist_failed",
              currentItemId: msg.itemId,
            });
            const preview = msg.displayText.slice(0, 50);
            try {
              // eslint-disable-next-line no-restricted-syntax -- 落盘失败警告（best-effort 吞错）
              await writeEventAndPublish(taskId, {
                kind: "info",
                text: `消息保存失败、未发送：${preview}`,
              });
            } catch (warnErr) {
              console.warn(
                `[chat-runner] flushChatQueue task=${taskId} 落盘失败警告写失败:`,
                warnErr,
              );
            }
            return;
          }
          if (!replyEvent) {
            // ENOENT（任务目录已删）→ failQueuedItems，尾队列也有 id 化终态
            failQueuedItems(taskId, {
              reason: "task_gone",
              currentItemId: msg.itemId,
            });
            return;
          }
          replyPersisted = true;
          // 落盘只到 persisted；handoff（send===sent）后才 delivered
          if (msg.itemId) markMessagePersisted(taskId, msg.itemId);
          if (capture.ok) {
            await persistCheckpointForReply(taskId, replyEvent.id, capture);
          }
        } else if (msg.itemId) {
          // skipPersistEvent：入队方已落盘 → 仍是 persisted
          markMessagePersisted(taskId, msg.itemId);
        }

        // 测试可在 persisted 后、send 前挂起（注入 stop / owner 失效）
        await failpoint("flushChatQueue.afterPersist");

        const sent = await sendChatMessage(
          task,
          msg.agentText || msg.displayText,
          msg.imageAbsPaths,
          msg.attachmentAbsPaths,
        );
        if (sent !== "sent") {
          // 未 handoff → skipPersist 重排（禁止先记 delivered）
          requeueIfSameGen(
            replyPersisted ? { ...msg, skipPersistEvent: true } : msg,
            `send 未送达（${sent}）塞回`,
          );
          return;
        }
        delivered = true;
        // send===sent 才 settle handedOff（对外 delivered）
        if (msg.itemId) settleMessageHandedOff(taskId, msg.itemId);

        // 飞书桥接（review P0#1）：flush 成功后中性钩子（带原条目 extraMeta）；
        // 飞书层订阅它升级 Typing→Get 回执 / 清撤回 Map。chat-runner 不 import
        // feishu-bridge，保持分层。
        emitQueuedMessageFlushed(taskId, msg);
      } catch (err) {
        console.error(`[chat-runner] flushChatQueue task=${taskId} failed:`, err);
        // checkpoint/send/后置异常统一走 failQueuedItems。
        // 仅已 handedOff 的当前条不算 failed；仅 persisted → queue_failed。
        const failedIds = failQueuedItems(taskId, {
          reason: "flush_error",
          currentItemId: msg.itemId,
          currentHandedOff: delivered,
        });
        if (failedIds.length > 0) {
          try {
            // eslint-disable-next-line no-restricted-syntax -- 豁免：清队系统通知（会话已关、无实例可绑）
            await writeEventAndPublish(taskId, {
              kind: "info",
              text: `排队消息处理失败，${failedIds.length} 条排队消息未送达、请重新发送`,
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
  // 配套：single-flight 下，consume 收尾的链式 flush 可能撞上「本轮仍 draining」
  // 而空 return，队内后续消息会滞留。本轮 finally 清位后：若队列非空且会话空闲
  //（无 run / rewind），再续一次 drain。run 仍活跃时不续——等 consume
  // 自己的链式 flush，避免「dequeue → 见 busy → 塞回 → 再 flush」忙等。
  if (
    getChatQueueCount(taskId) > 0 &&
    !drainingQueues.has(taskId) &&
    !isChatRunActive(taskId) &&
    !isChatRewindInProgress(taskId)
  ) {
    void flushChatQueue(taskId);
  }
};

// ----------------- 释放认领后等 rewind 门闩再补 drain -----------------

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
const CHAT_DEFERRED_DRAIN_KEY = "__flowshipChatDeferredDrainV1__";
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
