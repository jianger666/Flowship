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
 *   idle / error → 停止 / 出错（会话已关、下一条优先 resume；失败则起新会话并注入最近几轮对话正文）
 *
 * # 跟 task-runner 的区别（避免误用）
 *
 * - chat-runner 不写 actions[]、不生成 artifact 文件
 * - chat prompt 里没有 [NEXT_ACTION] / [USER_MESSAGE] 任务容器概念
 */

import { Agent } from "./agent-backend";
import {
  getSubagentDisplayLookup,
  getSubagentParentModel,
} from "./subagent-parent-model";
import {
  formatBackgroundSubagentMessage,
  formatBackgroundSubagentNotice,
  getSubagentSessionControl,
  onBackgroundSubagentJobsChanged,
  onBackgroundSubagentSettled,
  setBackgroundSubagentSnapshotProvider,
  type BackgroundSubagentEvent,
} from "./subagent-background";
import type { BackgroundSubagentJobView } from "@/lib/background-subagents";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  clearTaskSessionAgentIdIf,
  getTask,
  setTaskRunStatus,
  setTaskRunStatusIfRunOwner,
  setTaskSessionAgentId,
} from "./task-fs";
import { getEventsLogPath, readEventsTail } from "./task-fs-core";
import { redactSecretsInText } from "./event-secret-redact";
import { describeDroppedAttachments } from "@/lib/dropped-queue-notice";
import {
  formatChatHistorySection,
  HISTORY_INJECT_SCAN_EVENTS,
  selectChatHistoryTurns,
  type ChatHistoryInject,
} from "@/lib/chat-history-inject";
import { isScheduleBoilerplateText } from "@/lib/chat-stream-display";
import { parseScheduleClientItemId } from "@/lib/schedule";
import { maybeGenerateChatTitle } from "./chat-title";
import {
  cancelPending,
  cancelPendingIf,
  clearAskTakenMark,
  getPendingAsk,
  setChatAwaitingNotifier,
} from "./chat-pending";
import { failpoint } from "./failpoints";
import { interruptWaits } from "./session-wait";
import { chatTurnProtocolSection } from "./turn-discipline";
import { buildWindowsToolDisciplineDirective } from "./windows-tool-discipline";
import { supersedePendingAsks } from "./ask-supersede";
import { renderContextDocsSection } from "./context-docs-prompt";
import {
  formatRepoSectionForPrompt,
  getEffectiveCwd,
} from "@/lib/path-utils";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataRoot } from "./data-root";
import { publishBootProgress } from "./boot-progress";
import { appendPerfRecord } from "./perf-journal";
import { createRunPerfTracker } from "./run-perf";
import { notePrep } from "./run-prep-notes";
import {
  composeOnDelta,
  createSdkSummaryDeltaPublisher,
  createShellOutputDeltaPublisher,
} from "./shell-output-bridge";
import {
  flushPendingAssistantDeltas,
  flushThinkingBuffer,
  handleSdkMessage,
  maybeEmitSubmitFixedText,
  type AssistantBufferCtx,
} from "./sdk-message-handler";
import {
  loadSkillsForTask,
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
  buildLarkCliAuthMissingRule,
  renderReadonlyRepoDirective,
  renderScriptRepoDirective,
} from "./task-prompts";
import { resolveEffectiveGitHost } from "./gitlab-host";
import { syncGitTokenEnvFromSettingsResult } from "./git-token-env";
import {
  pinTrustedGitHostIfAbsent,
  resolveGitHostForPrompt,
} from "./trusted-git-host";
import { readSettingsFile } from "./settings-fs";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { filterHealthyMcp, invalidateMcpProbeCache } from "./mcp-probe";
import {
  buildRunNotFinishedError,
  isRetryableRunError,
  summarizeRunFailure,
} from "./sdk-error";
import {
  SDK_CREATE_RESUME_TIMEOUT_MS,
  SDK_SEND_TIMEOUT_MS,
  withSdkDeadline,
} from "./sdk-deadline";
import { CANCEL_WAIT_GRACE_MS, createCancelEscape } from "./run-wait";
import { finalizeOpenToolCalls } from "./finalize-open-tools";
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
import type { FeAiFlowSettings, Task } from "@/lib/types";
import {
  DANGLING_TASK_PROVIDER_MESSAGE,
  bootArgsForTask,
  findCustomProvider,
  isTaskProviderDangling,
  migrateProviderSettings,
  resolveTaskProvider,
  sessionMatchesProvider,
} from "@/lib/agent-provider";
import { isCursorProvider } from "@/lib/types";
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
  listQueuedChatAttachmentCounts,
  listQueuedChatMessages,
  markChatSystemClose,
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

// 整轮 run 硬顶 24h（ask-wait 挂着等答案也算在内）。超时未答会 expire 提问。
const CHAT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;


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
  // 本会话启动时绑定的提供方（cursor / 某条自定义 id）。切提供方必开新会话，禁止跨后端 resume。
  providerId: string;
  /**
   * 本轮在消费的 run 句柄（consumeChatRun 接管时置、流结束 / 下一轮 send 起手清）。
   * 「立即发送」用它 steer 插话——只有 Cursor 本地 run 带 steer；claim / 冷启动占位期为 undefined。
   */
  currentRun?: ChatRun;
  /** 冲刷本轮已缓冲的半截 assistant 文本（插话落 user_reply 前调、保事件顺序）；consumeChatRun 置 */
  flushAssistant?: () => Promise<void>;
  /**
   * 本实例是被「非用户意图」摘出表的（自动重连 / error 收尾 / 懒重启强清，不是用户停止）。
   * 为什么挂在 rec 上：在飞的 steerChatRun 手里握着 rec 引用，实例摘表后仍读得到它，
   * 据此把「系统换掉了实例」和「用户停止」两种都表现为 `!stillCurrent` 的情形分开——
   * 前者消息没送达也没被用户撤销、必须重排，后者才记 stopped。
   * 统一由 closeChatSession 在 reason 为 reconnect / error / restart 时置
   *（见 markChatInstanceReplacedByReconnect）；名字沿用「ByReconnect」只是历史原因。
   */
  replacedByReconnect?: boolean;
  /**
   * 本实例被系统摘出表时的原因（reconnect / error / restart），与 replacedByReconnect 同时置。
   * 为什么要记：在飞的后台结果 steer 落定为 replaced 后，要按原因决定这批结果的去处——
   * 只有 reconnect（同一持久化 agent 的续接）才暂存给新实例，error / restart 一律作废并写「未送达」。
   * 先到先得（同一实例只会被摘一次，重连链先显式标一次、closeChatSession 再标一次，原因相同）。
   */
  replacedReason?: ChatCloseReason;
  /**
   * 「立即发送」steer 在飞的消息（itemId → 用户看到的原文）：send-now 在 take 之后就经 registerInflightSteer 登记
   * （覆盖 take → steerChatRun 起手之间的 await 空窗），有了定论由它注销；调用方没提前登记时 steerChatRun 自己登记、落定即注销。
   * 为什么要有：这条消息已被 take 出队列、又刻意不占 in-flight 槽（steer 可能挂很久，不能卡住链式 flush），
   * error 收尾清队时就看不见它——它在界面上是「已落盘未送达」的悬空条，既不会重排、也不会进「未送达」提示。
   * 有了这张登记，error 收尾能把它和队里其它消息一并判失败、并入同一条提示。
   */
  inflightSteers?: Map<string, string>;
  /**
   * 对本实例「在跑的这一轮」发起取消时登记的关闭原因（cancelChatRun 的 opts.reason）。
   * 为什么要有：run 的取消是异步收尾的——cancel 只给 run 一个信号，真正摘会话发生在稍后的
   * finalizeChatRunIfCurrent(cancelled) 里，关闭原因得在两者之间带过去；缺省 = 用户停止。
   * 之后若用户又点了停止（cancelChatRun 不带 reason）会把它清掉，用户意图优先。
   */
  pendingCloseReason?: ChatCloseReason;
  /**
   * cancelChatRun 发 run.cancel() **之前**数下来的「在跑的后台子代理」数（只在 pendingCloseReason 非用户时记）。
   * 为什么要有：父 run 的 cancel 经 wrapRunWithCancelLink 会同步联动取消子代理，等异步收尾走到
   * closeChatSession 时 backgroundRunning() 早已归零——只在关会话时现数，「懒重启取消」永远数到 0、仍然静默。
   */
  pendingCloseBackground?: number;
  /** 在飞 steer 对「被重连替换」的订阅（steerChatRun 登记、落定即注销）；置标记时同步触发 */
  replacedWaiters?: Set<() => void>;
}

/**
 * 摘实例（非用户意图）时调：打「被系统换掉」标记，并立刻唤醒在飞的 steer。
 * 现由 closeChatSession 在 reason=reconnect / error / restart 时统一调用（重连链摘 stale 实例前也会显式调一次）。
 * 为什么要唤醒而不只打标：断流后 steer / run.wait 在真实 SDK 里是拒绝还是挂起没验证过，
 * 全挂起时 steerChatRun 永远不落定，消息会卡在「已落盘未送达」的悬空态。
 */
const markChatInstanceReplacedByReconnect = (
  rec: RunningChatRecord,
  reason: ChatCloseReason,
): void => {
  rec.replacedByReconnect = true;
  rec.replacedReason ??= reason;
  const waiters = rec.replacedWaiters;
  if (!waiters) return;
  rec.replacedWaiters = undefined;
  for (const wake of waiters) wake();
};

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
  /**
   * taskId → 攒着还没送进主 AI 的后台子代理结果（已套好框的消息正文）。
   * 主 AI 忙、又插不进当前这一轮时（pi 外的冷启动 / 收尾空窗 / steer 被退回）先攒在这，
   * 这一轮收尾时由 drainBackgroundResults 送出；会话关闭即作废（自动重连摘实例是例外：见下一项）。
   */
  pendingBackgroundResults: Map<string, string[]>;
  /**
   * taskId → 自动重连摘实例时暂存的后台子代理结果（已到达、还没送进主 AI 的那部分）。
   * 为什么单独一张表：摘实例走 closeChatSession，它会清 pendingBackgroundResults；而重连的新实例
   * 是同一个持久化 agent 的续接，这些结果对它仍然有效，不能跟着坏实例一起丢。
   * 新实例接回（send 受理）后由 restoreStashedBackgroundResults 放回待送队列；
   * 重连放弃 / 被停止 / 回退则清掉并给用户一句「未送达」，不留给以后的任何会话。
   */
  stashedBackgroundResults: Map<string, StashedBackgroundResults>;
}

/** 重连窗口里暂存的后台结果 */
interface StashedBackgroundResults {
  /** 暂存时所属会话的 agentId：放回时核对，对不上（换了别的会话）就不送 */
  agentId: string;
  results: string[];
  /**
   * 时效计时器（{@link STASHED_BACKGROUND_RESULTS_TTL_MS}）：暂存的正常出口只有「重连接回 → 放回」与
   * 「链尾 / 回退 → 清掉并提示」两条；这是兜底——任何原因让重连链没走到收尾（异常、未覆盖的出口）时，
   * 暂存不会无限期留着、更不会被日后某次同 agentId 的重连当成「自己的结果」送出。
   * unref：不拖住进程退出。
   */
  expiryTimer?: NodeJS.Timeout;
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
      pendingBackgroundResults: new Map(),
      stashedBackgroundResults: new Map(),
    };
  }
  // hot-reload：旧 state 可能缺 pendingBackgroundResults（后台子代理后加的字段）
  if (!g[CHAT_RUNNER_GLOBAL_KEY]!.pendingBackgroundResults) {
    g[CHAT_RUNNER_GLOBAL_KEY]!.pendingBackgroundResults = new Map();
  }
  // hot-reload：旧 state 可能缺 stashedBackgroundResults（重连暂存后加的字段）
  if (!g[CHAT_RUNNER_GLOBAL_KEY]!.stashedBackgroundResults) {
    g[CHAT_RUNNER_GLOBAL_KEY]!.stashedBackgroundResults = new Map();
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
const pendingBackgroundResults = getRunnerState().pendingBackgroundResults;
const stashedBackgroundResults = getRunnerState().stashedBackgroundResults;

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

// ----------------- 关会话时的后台子代理善后（取消提示 / 结果暂存） -----------------

/**
 * 关会话的原因。为什么要有：agent.close() 经 wrapAgentWithCancelLink 会取消在跑的后台子代理，
 * 用户主动停止之外的几种关闭（自动重连摘实例 / error 收尾 / 懒重启 / 编辑回退）此前对用户完全静默。
 * 缺省 `user` = 现行行为（不额外提示）：stop 路径自己已写「用户停止了对话」，不能再重复写一遍。
 */
export type ChatCloseReason =
  | "user"
  | "reconnect"
  | "error"
  | "restart"
  | "rewind";

/** 非用户主动的关闭原因 → 事件流里「因 X」的 X */
const CHAT_CLOSE_REASON_LABEL: Record<Exclude<ChatCloseReason, "user">, string> = {
  reconnect: "自动重连替换会话",
  error: "对话出错收尾",
  restart: "会话重启",
  rewind: "回退对话",
};

/**
 * 给用户一句真实的「后台子代理结果没送到主 AI」。
 * 到达时那行提示只说「将转交」（见 formatBackgroundSubagentNotice），没送成就要在这里补一句实话。
 * 不用 owned sink：调用时会话已关 / 重连链已结束，无实例可绑 lease（同清队通知的豁免口径）。
 * fire-and-forget：writeEventAndPublish 自己吞错，调用方（含同步的 closeChatSession）不必等。
 */
const noticeBackgroundResultsDropped = (
  taskId: string,
  count: number,
  why: string,
): void => {
  if (count <= 0) return;
  // eslint-disable-next-line no-restricted-syntax -- 豁免：系统通知（会话已关、无实例可绑）
  void writeEventAndPublish(taskId, {
    kind: "info",
    text: `${count} 条后台子代理的结果未送达主 AI（${why}）`,
  });
};

/**
 * 暂存后台结果（见 {@link ChatRunnerGlobalState.stashedBackgroundResults}），按 agentId 绑定。
 * where=front 用于 steer 被判 replaced 的那一批：它们比当前暂存里的更早到达，放前面保持先后。
 * 已有的暂存属于别的 agentId（理论上不会）就不混着送：旧的作废并提示。
 */
const stashBackgroundResults = (
  taskId: string,
  agentId: string,
  results: string[],
  where: "front" | "back" = "back",
): void => {
  if (results.length === 0) return;
  const old = stashedBackgroundResults.get(taskId);
  if (old) clearStashExpiry(old);
  if (old && old.agentId !== agentId) {
    noticeBackgroundResultsDropped(
      taskId,
      old.results.length,
      "它们所属的会话已被替换",
    );
  }
  const kept = old && old.agentId === agentId ? old.results : [];
  const entry: StashedBackgroundResults = {
    agentId,
    results: where === "front" ? [...results, ...kept] : [...kept, ...results],
  };
  // 每次（再）暂存都从头计时：时效衡量的是「这批结果在等一个出口」的时间
  armStashExpiry(taskId, entry);
  stashedBackgroundResults.set(taskId, entry);
};

/** （重新）给一份暂存挂时效计时器；已有的先清掉 */
const armStashExpiry = (
  taskId: string,
  entry: StashedBackgroundResults,
): void => {
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  entry.expiryTimer = setTimeout(() => {
    // 只处理「自己」：期间已被放回 / 清掉 / 换成了别的暂存就什么都不做
    if (stashedBackgroundResults.get(taskId) !== entry) return;
    stashedBackgroundResults.delete(taskId);
    noticeBackgroundResultsDropped(
      taskId,
      entry.results.length,
      "暂存超时，没等到可送的会话",
    );
  }, STASHED_BACKGROUND_RESULTS_TTL_MS);
  entry.expiryTimer.unref?.();
};

/**
 * 自动重连每开始一次尝试就给暂存续期（第八轮 L5-02）：重连链最坏要 5 次尝试，退避合计 59 秒，
 * 每次尝试里 Agent.resume 最长 180 秒（SDK_CREATE_RESUME_TIMEOUT_MS）、send 最长 120 秒——
 * 5 次 resume 都挂到超时时整条链约 16 分钟，超过一份固定 10 分钟 TTL。
 * 固定 TTL 只从首次暂存起算，链还在走时就会先到点写「暂存超时」，之后重连成功反而找不到暂存。
 * 续期后 TTL 衡量的是「单次尝试」的时长而不是整条链；链真正走完（放回 / 放弃）仍由各自出口清掉。
 * 没有暂存 / 已被清掉 = 空操作。
 */
const renewStashExpiry = (taskId: string): void => {
  const stash = stashedBackgroundResults.get(taskId);
  if (stash) armStashExpiry(taskId, stash);
};

const clearStashExpiry = (stash: StashedBackgroundResults): void => {
  if (stash.expiryTimer) clearTimeout(stash.expiryTimer);
  stash.expiryTimer = undefined;
};

/**
 * 重连的新实例接回后，把暂存的结果放回它的待送队列（由这一轮收尾的 drainBackgroundResults 送出）。
 * 先从暂存里删再放回：同一条结果只会存在于一处，不会被送两次。
 * agentId 对不上 = 接回的不是发起它们的那个会话，不送。
 */
const restoreStashedBackgroundResults = (
  taskId: string,
  rec: RunningChatRecord,
): void => {
  const stash = stashedBackgroundResults.get(taskId);
  if (!stash) return;
  stashedBackgroundResults.delete(taskId);
  clearStashExpiry(stash);
  if (stash.agentId !== rec.agentId) {
    noticeBackgroundResultsDropped(
      taskId,
      stash.results.length,
      "重连接回的不是发起它们的会话",
    );
    return;
  }
  pendingBackgroundResults.set(taskId, [
    ...stash.results,
    ...(pendingBackgroundResults.get(taskId) ?? []),
  ]);
};

/**
 * 暂存时效（毫秒）。见 {@link StashedBackgroundResults.expiryTimer}；测试用 fake timers 推进它。
 * 从「最近一次暂存 / 最近一次重连尝试开始」起算（{@link renewStashExpiry}），不是从首次暂存起算整条重连链。
 */
export const STASHED_BACKGROUND_RESULTS_TTL_MS = 10 * 60 * 1000;

/** 仅供测试：读当前暂存（拷贝，不含计时器） */
export const __stashedBackgroundResultsSnapshotForTest = (
  taskId: string,
): { agentId: string; results: string[] } | undefined => {
  const s = stashedBackgroundResults.get(taskId);
  return s ? { agentId: s.agentId, results: [...s.results] } : undefined;
};

/** 仅供测试：直接造一份暂存（等价于重连摘实例时的暂存），用来验时效 */
export const __stashBackgroundResultsForTest = (
  taskId: string,
  agentId: string,
  results: string[],
): void => stashBackgroundResults(taskId, agentId, results);

/** 重连链已经没有可送的会话了（放弃 / 被停止 / 让位 / 回退）：清掉暂存，如实告诉用户 */
const discardStashedBackgroundResults = (taskId: string, why: string): void => {
  const stash = stashedBackgroundResults.get(taskId);
  if (!stash) return;
  stashedBackgroundResults.delete(taskId);
  clearStashExpiry(stash);
  noticeBackgroundResultsDropped(taskId, stash.results.length, why);
};

/**
 * 删任务：静默清掉该任务暂存的后台结果（连同时效计时器）。
 * 与 {@link discardStashedBackgroundResults} 的区别是不写「未送达」提示：任务已删、没有人在看事件流，
 * 往被删掉的任务目录里写事件还可能把目录又建出来；不清的话 10 分钟后计时器到点就会这么干。
 */
export const discardStashedBackgroundResultsForDeletedTask = (
  taskId: string,
): void => {
  const stash = stashedBackgroundResults.get(taskId);
  if (!stash) return;
  stashedBackgroundResults.delete(taskId);
  clearStashExpiry(stash);
};

/**
 * V0.11：关掉一个 chat 会话（agent close + 删记录）、best-effort。
 * expectedInstanceId 传了就只在「当前会话确实是那个内存实例」时才关（异步收尾路径防误关新会话）；
 * 不传 = 关当前的（用户主动 stop / forceClear）。对齐 task-runner.closeTaskSession。
 * 门控键从 agentId 改为 instanceId——Agent.resume 恢复同一持久化 agent 时
 * agentId 相同，旧 retry / 迟到收尾按 agentId 会误关退避期间用户恢复的新实例。
 * keepPersisted = 空闲回收 / error 收尾用（sessionAgentId 留着、下次消息 Agent.resume 接回）
 *
 * 落盘锚点改条件清（clearTaskSessionAgentIdIf）——expected=本次关的 agentId，
 * extraGuard=内存无后继 chat 会话；`!rec` 禁止裸清（迟到 fire-and-forget 不得抹 B 锚点）。
 *
 * reason（缺省 user = 现行行为）：非用户主动的关闭（见 {@link ChatCloseReason}）会在 agent.close()
 * 触发 cancelAll 之前同步读「在跑的后台子代理数」，>0 就给事件流写一句「因 X，取消了 N 个后台子代理」。
 * 攒着没送出去的后台结果：reason=reconnect 时暂存给新实例（见 stashBackgroundResults），其余一律作废并写「未送达」。
 * @returns 是否真的关了一个会话
 */
const closeChatSession = (
  taskId: string,
  expectedInstanceId?: number,
  opts: {
    keepPersisted?: boolean;
    reason?: ChatCloseReason;
    /**
     * 调用方在「同一同步段内、紧挨着本次关闭之前」自己清了队时，传清队**之前**读到的队列 generation
     * （见 {@link markChatSystemClose}）。没清队（forceClear / 重连 / 空闲回收）省略。
     * 只在 reason 为 reconnect / error / restart 时有意义。
     */
    queueGenerationBeforeClear?: number;
  } = {},
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
  // 非用户意图的摘表（重连 / error 收尾 / 懒重启强清）：在飞的「立即发送」steer 没送达、用户也没撤销，
  // 必须落成 replaced 走重排，而不是 !stillCurrent → cancelled → failed(stopped)。
  // 放在 agent.close() 之前、与摘表之间无 await：close 会把 steer 拒掉，那一刻 steer 必须已能读到标记；
  // 同时唤醒在飞的 steer——真实 SDK 在摘表后 steer / run.wait 是拒绝还是挂起没验证过，别指望它们自己落定。
  // 用户停止（reason 缺省 / user）与回退（rewind，消息属于被回退掉的上下文）不打标。
  if (
    opts.reason === "reconnect" ||
    opts.reason === "error" ||
    opts.reason === "restart"
  ) {
    // 先记「系统清队前 / 摘表时的队列 generation」再唤醒 steer：取消 / error 收尾总是先清队、再在同一同步段里走到这，
    // 被唤醒的 steer 落定后据此区分「系统自己清的队」与「之前 / 之后用户停止 / 回退清的队」（见 markChatSystemClose）
    markChatSystemClose(taskId, opts.queueGenerationBeforeClear);
    markChatInstanceReplacedByReconnect(rec, opts.reason);
  }
  // 会话没了：后台子代理随 close 一并取消。非用户主动的关闭让用户看得见——
  // 读数必须在 agent.close() 之前（close 经 wrapAgentWithCancelLink 触发 cancelAll）、同步完成
  const closeLabel =
    opts.reason && opts.reason !== "user"
      ? CHAT_CLOSE_REASON_LABEL[opts.reason]
      : undefined;
  // 与 cancelChatRun 取消前记下的数取大：run 的取消已先一步把子代理停了，现数会漏（见 pendingCloseBackground）
  const cancelledBackground = closeLabel
    ? Math.max(
        getSubagentSessionControl(rec.agent)?.backgroundRunning() ?? 0,
        rec.pendingCloseBackground ?? 0,
      )
    : 0;
  if (closeLabel && cancelledBackground > 0) {
    // eslint-disable-next-line no-restricted-syntax -- 豁免：系统通知（会话已关、无实例可绑）
    void writeEventAndPublish(taskId, {
      kind: "info",
      text: `因${closeLabel}，取消了 ${cancelledBackground} 个后台子代理`,
    });
  }
  // 攒着没投出去的结果：自动重连摘实例是同一持久化 agent 的续接，结果暂存给新实例（按 agentId 绑定）；
  // 其余原因会话就此作废，如实告诉用户没送到（到达时的提示只说「将转交」）
  const undelivered = pendingBackgroundResults.get(taskId);
  pendingBackgroundResults.delete(taskId);
  if (undelivered && undelivered.length > 0) {
    if (opts.reason === "reconnect" && agentIdToClear) {
      stashBackgroundResults(taskId, agentIdToClear, undelivered);
    } else {
      noticeBackgroundResultsDropped(
        taskId,
        undelivered.length,
        closeLabel ?? "会话已关闭",
      );
    }
  }
  setChatAwaitingNotifier(taskId, null);
  // 关会话会把后台子代理一并取消；它们的取消是异步收尾的、逐个报「清单变了」——
  // 万一哪个取消迟迟不落定，界面的「后台工作中」条就会一直挂着。会话摘表后清单一定是空，这里补推一帧保证它收掉
  const hadBackgroundJobs =
    (getSubagentSessionControl(rec.agent)?.backgroundJobs().length ?? 0) > 0;
  if (rec.agent) {
    try {
      rec.agent.close();
    } catch {
      /* noop */
    }
  }
  if (hadBackgroundJobs) publishBackgroundSubagents(taskId);
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

// mem-governance① [设计决策]：chat 空闲 TTL 2h → 12min（同 task-runner 口径）。
// 超期走 Agent.resume 接回，体感为 1~2s 冷启动。
const CHAT_IDLE_TTL_MS = 12 * 60 * 1000;
const CHAT_SWEEPER_KEY = "__flowshipChatSweeperV1__";
{
  const g = globalThis as unknown as Record<string, NodeJS.Timeout | undefined>;
  if (!g[CHAT_SWEEPER_KEY]) {
    g[CHAT_SWEEPER_KEY] = setInterval(() => {
      const now = Date.now();
      for (const [taskId, rec] of runningChats) {
        if (rec.runActive) continue;
        // 还有后台子代理在跑：会话不能回收（关会话会把它们一并取消）
        if ((getSubagentSessionControl(rec.agent)?.backgroundRunning() ?? 0) > 0) {
          continue;
        }
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
 *
 * @param opts.reason 关闭原因，缺省 = 用户停止（现行行为、不额外提示）。非用户意图的调用方
 *   （懒重启：切模型 / MCP / workdir / 提供方）必须传，否则被取消的后台子代理对用户完全静默、
 *   在飞的「立即发送」steer 也会被误记成用户停止。
 *   run 在跑时 cancel 只是发信号，真正摘会话在收尾里——原因先登记在 record 上（pendingCloseReason）带过去。
 */
export const cancelChatRun = (
  taskId: string,
  opts: { reason?: ChatCloseReason } = {},
): boolean => {
  const reconnectStop = getReconnectStops().get(taskId);
  if (reconnectStop) reconnectStop();
  const rec = runningChats.get(taskId);
  if (!rec) return !!reconnectStop;
  if (rec.runActive) {
    // 不带 reason 也要赋值（清成 undefined）：之前登记过「懒重启」、随后用户又点了停止，用户意图优先
    rec.pendingCloseReason = opts.reason;
    // 必须在 rec.cancel() 之前数：run.cancel 会同步联动取消后台子代理，之后再数就是 0。
    // 与已登记的数取大——同一轮被重复取消时，第二次数到的是已被第一次取消掉的 0
    rec.pendingCloseBackground =
      opts.reason && opts.reason !== "user"
        ? Math.max(
            rec.pendingCloseBackground ?? 0,
            getSubagentSessionControl(rec.agent)?.backgroundRunning() ?? 0,
          )
        : undefined;
    rec.cancel();
  } else {
    closeChatSession(taskId, undefined, { reason: opts.reason });
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

/** 读当前活 chat 会话绑定的提供方（无活会话返 null） */
export const getChatRunProvider = (taskId: string): string | null =>
  runningChats.get(taskId)?.providerId ?? null;

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
export const forceClearChatRun = (
  taskId: string,
  opts: { keepPersisted?: boolean } = {},
): void => {
  closeChatSession(taskId, undefined, { ...opts, reason: "restart" });
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
  // 回退丢掉了旧对话：重连窗口里暂存的后台结果属于被回退的上下文，不能留给以后的会话
  discardStashedBackgroundResults(taskId, "回退对话");
  closeChatSession(taskId, undefined, { reason: "rewind" });
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
 * 某任务此刻在后台跑的子代理清单——按**当前会话**现读（会话不在 = 空）。
 * watch-task 的 bootstrap 经 subagent-background 的 provider 读它（见文件末尾的登记），
 * 实时帧也走它（见 publishBackgroundSubagents）：两处同源，断线重连后不会与实时状态漂移。
 */
export const getBackgroundSubagentJobs = (
  taskId: string,
): BackgroundSubagentJobView[] =>
  getSubagentSessionControl(runningChats.get(taskId)?.agent)?.backgroundJobs() ??
  [];

/**
 * 把「此刻的后台子代理清单」整份推给界面（`background_subagents` 帧、纯内存不落盘）。
 * 界面据此在输入框上方画「子代理在后台工作」条——主 AI 说完一轮后会话呈现「已结束」，
 * 但后台子代理还在干活，没有这条信号用户完全看不出来（2026-10-17 用户反馈）。
 */
const publishBackgroundSubagents = (taskId: string): void => {
  publish(taskId, {
    kind: "background_subagents",
    jobs: getBackgroundSubagentJobs(taskId),
  });
};

// 启动链 ephemeral 进度（publishBootProgress）已抽到 ./boot-progress：
// chat-inject 的续聊（resume）路径也要发，不必为此再让 chat-runner 多导出一个函数。

/**
 * 「回合结束 → SDK 真正收尾」的慢收尾门槛。正常 turn-ended → FINISHED 约 0.3s（SDK 在存 checkpoint）；
 * 超过它就是异常空窗，记一条 turn-wrapup.jsonl 取证。
 */
const TURN_WRAP_UP_SLOW_MS = 3_000;

/**
 * 「回合结束 → SDK 真正收尾」的异常取证（turn-wrapup.jsonl）：
 * 收尾慢（>3s）/ SDK 在同一条流上又跑了一轮（usage>1）才记；正常 ~0.3s 不写，零噪音。
 * **只观测，不干预**：不丢重放的消息、不给用户打提示——v1.9.29 做过（丢重放 + 静态「回复已完成，
 * 正在保存会话…」），2026-10-12 按用户决定整套撤掉，原因见 docs/HANDOFF.md。
 * perf-report 据此回答「重复回复 / 迟迟不结束」到底发生得多频、卡多久。
 */
const noteTurnWrapUp = (
  taskId: string,
  agentId: string | undefined,
  c: AssistantBufferCtx | undefined,
  streamEndedAt: number | undefined,
): void => {
  if (!c || c.turnEndedAt === undefined) return;
  const settledAfterMs = (streamEndedAt ?? Date.now()) - c.turnEndedAt;
  const turns = c.turnEndedCount ?? 1;
  if (settledAfterMs <= TURN_WRAP_UP_SLOW_MS && turns <= 1) return;
  appendPerfRecord("turn-wrapup.jsonl", {
    taskId,
    ...(agentId ? { agentId } : {}),
    settledAfterMs,
    turnEndedCount: turns,
  });
  console.warn(
    `[chat-runner] task=${taskId} 回合结束后 ${settledAfterMs}ms SDK 才收尾（turn-ended×${turns}）`,
  );
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
 *
 * historyInject.turns 非空 = 本窗口已有过对话、这次是新会话接续（resume 失败 /
 * 懒重启）。把最近几轮正文写进 prompt，避免模型把当前句当成新开的第一句。
 */
const loadChatHistoryInject = async (
  taskId: string,
  opts: { skipEventId?: string; skipUserText?: string },
): Promise<ChatHistoryInject> => {
  try {
    const { events, hasMore } = await readEventsTail(
      taskId,
      HISTORY_INJECT_SCAN_EVENTS,
    );
    const selected = selectChatHistoryTurns(events, opts);
    if (selected.turns.length === 0) return selected;
    // 扫描窗口之外可能还有更早的 user/assistant——标 truncated，prompt 指向 events.jsonl
    return { ...selected, truncated: selected.truncated || hasMore };
  } catch (err) {
    console.warn(`[chat-runner] 读接续历史失败 task=${taskId}`, err);
    return { turns: [], truncated: false };
  }
};

const buildInitialPrompt = (
  task: Task,
  skills: SkillEntry[],
  rulesSection: string,
  firstMessage?: InitialUserMessage,
  /** 飞书项目推导的发起人姓名行；空串 = 不注入 */
  userIdentityLine = "",
  /** GitLab 访问段（绑仓 + 配了 gitToken 时注入；空串 = 不注入） */
  gitlabAccessSection = "",
  /** lark-cli 身份缺失登录兜底（常驻） */
  larkCliAuthSection = "",
  /** 公司环境常驻声明（有 servers/PG 时非空） */
  companyEnvBriefSection = "",
  /** cursor 后端链路：pi 的 resource-loader 会自动注入仓库 AGENTS.md，cursor 不会，需补一条必读指令 */
  isCursorBackend = false,
  historyInject: ChatHistoryInject = { turns: [], truncated: false },
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
    // 工具清单 = 能力导向、不硬编码具体工具名：cursor 链路真实名是 Read/StrReplace 等
    // PascalCase、pi 链路是 read/edit 等小写——写死任何一端都会漂移（双链路审计实测踩过），
    // schema 才是唯一真相源，这里只做能力概述并显式声明权威来源
    "## 你能用的工具",
    "",
    "核心能力（**准确名称与参数一律以你实际收到的工具 schema 为准，不要凭记忆猜名字**）：",
    "  - 读文件（图片会作为附件给你看）　按内容搜索　按文件名找文件",
    "  - 编辑已有文件　新建 / 整文件覆盖　删除文件　跑 shell 命令（timeout 参数语义见 schema 说明）　分派子任务",
    "",
    "另外还有平台工具（提问 `ask_user` 等）和用户配置的 MCP 工具（飞书 / github / context7 等），已在你收到的工具列表里、按场景用。",
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
  } else if (
    isCursorBackend &&
    existsSync(path.join(getEffectiveCwd(task.repoPaths), "AGENTS.md"))
  ) {
    // pi 链路的 resource-loader 会自动发现并注入仓库 AGENTS.md；cursor 链路实测不会
    // （双链路审计确认），这里补一条必读指令、避免 cursor 链路全程看不到项目约定
    lines.push(
      "## 项目规则（必读）",
      "",
      `本任务绑定了工作目录，其中的 \`AGENTS.md\` 是项目级约定、不会自动进入你的上下文。回复涉及该仓库的代码 / 文档前，必须先用 read 工具读一次 \`${path.join(getEffectiveCwd(task.repoPaths), "AGENTS.md")}\` 并遵守其约定。`,
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
  // lark-cli 身份缺失 → 主动问是否代为登录（常驻、不绑 gitToken）
  if (larkCliAuthSection.trim()) {
    lines.push(larkCliAuthSection.trim(), "");
  }
  // 公司环境常驻声明（有 servers/PG 时）
  if (companyEnvBriefSection.trim()) {
    lines.push(companyEnvBriefSection.trim(), "");
  }
  const continuing = historyInject.turns.length > 0;
  lines.push(
    continuing
      ? "## 任务事件日志（更早细节 / 工具过程）"
      : "## 任务事件日志（按需读、`chat-history-recovery` skill 详述）",
    "",
    `  \`${eventsLogPath}\``,
    "",
  );
  if (continuing) {
    lines.push(
      "最近几轮对话正文已在下方「本窗口已有对话」。工具过程、更早的轮次在这个文件里；需要时再 read 末尾，不要整份贴给用户。",
      "",
    );
  }
  lines.push(
    renderContextDocsSection(
      task,
      "→ 用户没传上下文文档、按对话内容判断要不要主动调 MCP / read / grep 摸资料。",
    ),
    "",
  );

  lines.push(
    ...buildOpeningStanceSection(task.id, firstMessage, historyInject),
  );

  return lines.join("\n");
};

/**
 * 起手姿势段
 *
 * - 没 firstMessage：直接结束、等用户第一句
 * - 有历史切片：标明接续 + 最近几轮 + 当前这句（不是新窗口第一句）
 * - 否则：当前这句就是窗口里真正的第一条
 */
const buildOpeningStanceSection = (
  taskId: string,
  firstMessage: InitialUserMessage | undefined,
  historyInject: ChatHistoryInject,
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

  const lines: string[] = [];
  if (historyInject.turns.length > 0) {
    lines.push(...formatChatHistorySection(historyInject));
    lines.push("## 用户的新消息", "");
  } else {
    lines.push("## 用户的第一条消息", "");
  }

  lines.push(
    firstMessage.text.length > 0
      ? firstMessage.text
      : "(空文本、看下方附件)",
    "",
  );

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
  // recency 钉子：钉在用户当前句之后、治「只说『我这就写』就结束回复、没真把正文输出」
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
  // 当前这句对应的 user_reply 事件 id（启 run 前已落盘）。接续注入时用来从切片里去掉这句、避免和「用户的新消息」重复。
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
    firstMessageEventId,
    startToken,
    clientItemId,
  } = input;

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
    await finalizeChatRunSafely(task.id, myInstanceId, "cancelled", {
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
    providerId: task.provider ?? "cursor",
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

    // 2) 拼 mcpServers：fe 自管用户 MCP（按 task 黑名单过滤）。系统工具走 SDK customTools，不走 HTTP MCP。
    // settingSources:[] 不加载任何 .cursor mcp；全局 / 项目 MCP 一律走 fe 自管配置
    // 注入 OAuth token：走 OAuth 授权的远程 MCP（如飞书项目）token 不在 mcp.json、
    // 由 fe 自己跑过 OAuth 落盘、起 agent 前补到 headers.Authorization、详见 mcp-oauth.ts
    publishBootProgress(task.id, "mcp", "正在检查 MCP…");
    const perfMcpStart = Date.now();
    const enrichedMcp = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(task.disabledMcpServers),
    );
    // V0.6.11 容错：起 agent 前剔除连不上 / 未授权的远程 MCP、单个 MCP 挂不拖垮整个 run
    // filterHealthyMcp 走 TTL 缓存（ok/fail 各 5min）——跨会话复用、热路径可秒过
    const {
      servers: cursorMcp,
      dropped: droppedMcp,
      stats: mcpStats,
    } = await filterHealthyMcp(enrichedMcp);
    const perfMcpMs = Date.now() - perfMcpStart;
    // chat agent 同样带 caller 身份（ask_user 分派层要核）
    const callerToken = String(allocTaskRunInstanceId());
    const mergedMcp: Record<string, McpServerConfig> = { ...cursorMcp };

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
        meta: { subkind: "boot" },
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
    const skillsPromise = loadSkillsForTask(task.repoPaths ?? []).catch((err) => {
      console.error("[chat-runner] loadSkillsForTask failed", err);
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
      // host 一律按任务仓库 remote 现推（不再读 settings.gitHost）；
      // 脚本仓不参与推导（不 ship、origin 可能挂在别的实例）
      const effectiveHost =
        (await resolveEffectiveGitHost(
          task.repoPaths,
          task.scriptRepoPaths,
        )) ?? undefined;
      // 可信时机：本会话 agent 还没拿到任何 prompt（首条 send 要 await 本 promise），
      // 此刻读到的 origin 还没被它动过——固定为 PAT 的可信 host（已固定则不改，见 trusted-git-host.ts）。
      if (effectiveHost) pinTrustedGitHostIfAbsent(effectiveHost, "session");
      // host 展示可信 host：origin 被篡改时别让提示词教 agent 把 token 发过去
      const gitTrust = resolveGitHostForPrompt(effectiveHost);
      return buildGitlabAccessDirective(gitTrust.host, dataRoot(), {
        untrustedOriginHost: gitTrust.untrustedOriginHost,
      });
    })();
    gitlabAccessPromise.catch(() => {});
    // 与 create 并行：新会话才需要切片；resume 成功走 send，根本不进这里
    const historyPromise = loadChatHistoryInject(task.id, {
      skipEventId: firstMessageEventId,
      skipUserText: firstMessage?.text,
    });
    historyPromise.catch(() => {});

    // 4) 启动 agent + 流式消费
    publishBootProgress(task.id, "create", "正在创建会话…");
    const perfCreateStart = Date.now();
    // SDK local 无 env 透传 → 启动前把 companyEnv 同步到固定路径供 skill 读
    const { syncCompanyEnvFileFromSettings } = await import("./company-env-fs");
    await syncCompanyEnvFileFromSettings();
    const settingsResult = await readSettingsFile();
    // 同理把 GitLab token 放进 process.env 给 agent shell（SDK 本地 agent 继承 server env）：
    // 「GitLab 访问」提示让 agent 引用 $FLOWSHIP_GITLAB_TOKEN、不再读 config.json。必须先于 Agent.create。
    syncGitTokenEnvFromSettingsResult(settingsResult);
    const providerSettings = migrateProviderSettings(
      settingsResult.status === "ok" ? settingsResult.settings : {},
    );
    // 绑定的自定义提供方已被删除：报错让用户重选，不静默落回 Cursor（旧对话的上下文 / 代码会悄悄出域，D1-03）。
    // 配置读不出来时 customProviders 只是默认空值，不据此判「已删除」
    if (
      settingsResult.status === "ok" &&
      isTaskProviderDangling(task, providerSettings)
    ) {
      throw new Error(DANGLING_TASK_PROVIDER_MESSAGE);
    }
    const providerId = resolveTaskProvider(task, providerSettings);
    const recAtCreate = runningChats.get(task.id);
    if (recAtCreate?.instanceId === myInstanceId) {
      recAtCreate.providerId = providerId;
    }
    agent = await withSdkDeadline(
      Agent.create({
        apiKey,
        model,
        providerId,
        callerToken,
        taskId: task.id,
        // chat 会话：subagent 工具开后台运行（用户插话时自动转后台、后台结果送回本会话）
        backgroundSubagents: true,
        // settingSources:[] = 不加载任何 .cursor/（彻底脱离 Cursor 安装 / 项目配置）。
        // 曾用 ["project"] 时未绑工作目录 cwd=homedir → 把 ~/.cursor MCP 整包漏进 agent（实锤）。
        // rules / skills / mcp 全部由 fe 自管注入（readAppRulesForPrompt / loadSkills / inline mcpServers）。
        // 系统工具（ask_user / submit_work 等）由 facade 按 callerToken 挂 local.customTools。
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
      }),
      SDK_CREATE_RESUME_TIMEOUT_MS,
      "Agent.create",
    );
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
    const { loadCompanyEnvBriefSection } = await import("./company-env-fs");
    const companyEnvBriefSection = await loadCompanyEnvBriefSection();
    const historyInject = await historyPromise;
    const initialPrompt = buildInitialPrompt(
      task,
      skills,
      rulesSection,
      firstMessage,
      userIdentityLine,
      gitlabAccessSection,
      buildLarkCliAuthMissingRule(),
      companyEnvBriefSection,
      isCursorProvider(providerId),
      historyInject,
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
    // 受理前各阶段耗时 + MCP 探活统计 → 并进本 run 的汇总记录（run-perf.jsonl）
    notePrep(task.id, {
      stages: { mcp: perfMcpMs, create: perfCreateMs, prompt: perfPromptMs },
      mcp: mcpStats,
      tags: { path: "create" },
    });
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: agent.agentId,
      runKind: "chat-first",
      promptBytes,
      model,
    });
    run = await withSdkDeadline(
      agent.send(initialPrompt, {
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
      }),
      SDK_SEND_TIMEOUT_MS,
      "agent.send",
    );
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
        // + 本 instance 仍 current（stop 摘表 / B 换号后拒写事件）
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
        // 同一轮 curl 还挂着等答案：runStatus 保持 running（shell 确实没结束）。
        // 输入条能不能打字由 UI 看 pending ask，不靠切 awaiting_user。
        const fresh = await getTask(task.id);
        if (fresh && askLease()) publish(task.id, { kind: "task", task: fresh });
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
 * @param opts.startToken 调用方已持启动 lease 时传入（send-now 链路）：复用该
 *   lease、不自行 tryReserveChatStart、也不在 finally 代释放（owner 的 finally
 *   统一放）。不传则维持旧行为：自预约、finally 自释放。
 * @returns claim 是实例化 token——成功返回注册的 instanceId，owner 后续
 *   send/release 必须带它做精确匹配；失败返 null。不再返布尔，防止旧 owner 越权
 *   操作 stop/forceClear 之后换上来的新实例。
 */
export const resumeChatSession = async (
  task: Task,
  bootArgs: { apiKey: string; model: ModelSelection },
  opts: { claimRun?: boolean; startToken?: number } = {},
): Promise<number | null> => {
  // 同步段：任何 await 之前完成门闩/预约检查（Node 单线程 check-and-set 原子）
  if (!task.sessionAgentId || runningChats.has(task.id)) return null;
  if (isChatRewindInProgress(task.id)) return null;
  // 复用与新会话启动同一预约：rewind 占门闩后会复查预约并拒绝回退。
  // 外部 lease（startToken 显式传入）直接复用——此时本函数绝不自行预约/释放。
  const startToken =
    opts.startToken !== undefined
      ? opts.startToken
      : tryReserveChatStart(task.id);
  if (startToken === null) return null;
  try {
    const settingsResult = await readSettingsFile();
    // 恢复出的 agent 同样靠 $FLOWSHIP_GITLAB_TOKEN 调 GitLab API（见 runChatSession 同名注释）
    syncGitTokenEnvFromSettingsResult(settingsResult);
    const providerSettings = migrateProviderSettings(
      settingsResult.status === "ok" ? settingsResult.settings : {},
    );
    const providerId = resolveTaskProvider(task, providerSettings);
    if (
      task.sessionAgentId &&
      !sessionMatchesProvider(task.sessionAgentId, providerId)
    ) {
      console.warn(
        `[chat-runner] task=${task.id} 落盘会话与当前提供方不一致，跳过 resume`,
      );
      void clearTaskSessionAgentIdIf(
        task.id,
        task.sessionAgentId,
        () => !runningChats.has(task.id),
      );
      return null;
    }
    // inline MCP 不随 resume 持久化、重传（同 runChatSession 的 merge 逻辑）
    const perfMcpStart = Date.now();
    const enrichedMcp = await enrichMcpServersWithOAuth(
      await resolveTaskMcpServers(task.disabledMcpServers),
    );
    const { servers: cursorMcp, stats: mcpStats } =
      await filterHealthyMcp(enrichedMcp);
    const perfMcpMs = Date.now() - perfMcpStart;
    // resume 发新 caller + 重注册 notifier；系统工具走 customTools，用户 MCP 仍 inline
    const callerToken = String(allocTaskRunInstanceId());
    const mergedMcp: Record<string, McpServerConfig> = { ...cursorMcp };
    const perfResumeStart = Date.now();
    const agent = await withSdkDeadline(
      Agent.resume(task.sessionAgentId, {
        apiKey: bootArgs.apiKey,
        providerId,
        callerToken,
        taskId: task.id,
        backgroundSubagents: true,
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
      }),
      SDK_CREATE_RESUME_TIMEOUT_MS,
      "Agent.resume",
    );
    const perfResumeMs = Date.now() - perfResumeStart;
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
      providerId,
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
    // resume 的两段耗时（MCP 探活 / Agent.resume）+ 探活统计 → 并进紧随其后那次 send 的汇总记录
    notePrep(task.id, {
      stages: { mcp: perfMcpMs, resume: perfResumeMs },
      mcp: mcpStats,
      tags: { path: "resume" },
    });
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
    // 外部 lease 归调用方管（send-now 的 finally 统一 release）；仅自有预约在此释放
    if (opts.startToken === undefined) releaseChatStart(task.id, startToken);
  }
};

// ----------------- V0.13.x：chat run 网络断自动重连（同 task-runner 口径、重试 5 次） -----------------

const RECONNECT_MAX = 5;
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

// 服务端凭据兜底（重连时没有 client bootArgs）：读 config.json
const readServerChatCreds = async (
  task: Task,
): Promise<{
  apiKey: string;
  model: ModelSelection;
} | null> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return null;
  const migrated = migrateProviderSettings(result.settings);
  const settings = {
    apiKey:
      typeof result.settings.apiKey === "string" ? result.settings.apiKey : "",
    defaultModel: (result.settings.defaultModel as ModelSelection | undefined) ?? {
      id: "",
    },
    provider: migrated.provider,
    customProviders: migrated.customProviders,
  };
  // 模型必须跟窗口走（bootArgsForTask：最近 action.agentModel → task.model → 设置页默认），
  // 同 app 输入条 / 定时任务的口径。原先直接取设置页默认模型：窗口选的是 B、重连却悄悄用默认 A 把会话
  // 接回来（runModel=A），下次发送 bootArgs.model=B ≠ runModel → 懒重启，上下文被压成 12 轮摘要。
  // 凭据门（apiKey / baseUrl 校验）仍按 providerId 在下面单独判，不依赖 bootArgsForTask 的 apiKey。
  const { model, providerId } = bootArgsForTask(
    task,
    settings as FeAiFlowSettings,
  );
  if (!model?.id?.trim()) return null;
  if (isCursorProvider(providerId)) {
    if (!settings.apiKey.trim()) return null;
    return { apiKey: settings.apiKey, model };
  }
  const cp = findCustomProvider(settings, providerId);
  if (!cp?.baseUrl.trim()) return null;
  return { apiKey: cp.apiKey ?? "", model };
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
  if (!isRetryableRunError(msg, err, attempt)) return false;
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
  // 每次尝试开始就给暂存的后台结果续期（第八轮 L5-02，见 renewStashExpiry）
  renewStashExpiry(task.id);
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
    // 摘表前先打「被重连替换」标记（与 close 之间无 await）：在飞的「立即发送」steer 靠它
    // 区分「实例被重连换掉、消息没送达」与「用户停止」——前者要重排队，后者才作废。
    // 能走到这里说明退避期间没被用户停止（sleepWithCancel 已返回 false），所以这次摘表不是用户意图。
    // cur 与 stale 不是同一实例的情形上面已让位 return，这里 cur 要么是 stale、要么表已空（无可标）。
    if (cur) markChatInstanceReplacedByReconnect(cur, "reconnect");
    // reason=reconnect：关闭内部在清 pending 之前把「已到达、还没送给主 AI」的后台结果暂存给新实例
    // （退避窗口里完成的子代理结果原先在这里随会话一起丢了），并在 agent.close() 取消仍在跑的后台子代理前给用户留一句
    closeChatSession(task.id, staleInstanceId, {
      keepPersisted: true,
      reason: "reconnect",
    });
  }
  const creds = await readServerChatCreds(fresh);
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
      model: rec.model,
    });
    // 认领已在 resume 注册时完成（runActive=true），勿等 send 后再置——
    // 否则 flush / 并发 send 可插在 reconnect prompt 之前（ 点名的晚置位窗口）
    const run = await withSdkDeadline(
      rec.agent.send(reconnectPrompt, {
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
      }),
      SDK_SEND_TIMEOUT_MS,
      "agent.send(reconnect)",
    );
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
    // 新实例已就位、send 已受理且没被停止 / 替换：把摘实例时暂存的后台结果放回它的待送队列，
    // 由本轮收尾的 drainBackgroundResults 送出。放在 send 受理之后而不是 resume 之后：
    // 此前任何失败 / 停止出口都还没碰过暂存——它要么继续留给下一次重连、要么由链尾（consumeChatRun）统一清掉，
    // 不会出现「已放回新实例又随僵尸实例被关而静默丢掉」
    restoreStashedBackgroundResults(task.id, curAfterSend);
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
    // reason=reconnect：这个新实例在 resume→send 的空窗里若又收到了后台结果，同样暂存给下一次重连
    closeChatSession(task.id, rec.instanceId, {
      keepPersisted: true,
      reason: "reconnect",
    });
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

  // 先闭合未配对 tool running——停止 / 完成 / 错误共用；写前复查 lease
  await finalizeOpenToolCalls(taskId, isCurrent);
  if (!isCurrent()) return false;

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
    // 这一轮结束期间到达、没来得及插进去的后台子代理结果：现在送（空闲则唤醒一轮）
    void drainBackgroundResults(taskId);
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
    // 清队前的 generation 要带给 closeChatSession（打「系统关会话」标记用）：同步相邻、中间不得 await
    const queueGenerationBeforeClear = getChatQueueGeneration(taskId);
    failQueuedItems(taskId, { reason: "cancelled" });
    // P0：取消收尾保留落盘 sessionAgentId——停止 / 立即发送打断后，下条消息
    // 优先 Agent.resume 续接原会话（对齐错误分支口径），不再被动靠 events
    // 回放丢上下文。真正清锚点只剩 rewind（closeChatSessionUnconditional）、
    // 提供方不一致（resumeChatSession 内条件清）与 DELETE 收尾。
    // reason 取 cancelChatRun 登记的原因（懒重启等非用户意图的取消）；缺省 = 用户停止
    const closed = closeChatSession(taskId, instanceId, {
      keepPersisted: true,
      reason: rec.pendingCloseReason,
      queueGenerationBeforeClear,
    });
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
  // 必须与下面 closeChatSession 同步相邻（中间不得 await）：否则 await 窗口里新入队的
  // 消息会在摘表后无人 drain。给用户的「未送达」提示等收尾发布完再落（见文末）。
  const queueGenerationBeforeClear = getChatQueueGeneration(taskId);
  const dropped = failQueuedItemsCapturingTexts(taskId, "error");
  // error 收尾：关内存会话，但保留落盘 sessionAgentId——模型/区域等不可重试错
  // 并不代表持久化 agent 坏了；下条消息走既有「模式 2 resume → 失败降级模式 3」。
  // stop / forceClear / rewind 仍走无 keepPersisted 的清锚点路径。
  // reason=error：出错收尾不是用户主动停的，仍在跑的后台子代理会随 close 被取消——让用户看得见
  const closed = closeChatSession(taskId, instanceId, {
    keepPersisted: true,
    reason: "error",
    queueGenerationBeforeClear,
  });
  if (!closed) return false;
  // 关会话后不再 await getTask——避免空窗里 B 已启动却仍 publish done 清其 streaming
  if (errorTask) publish(taskId, { kind: "task", task: errorTask });
  publish(taskId, {
    kind: "done",
    task: errorTask ?? ctx.task,
    ok: false,
  });
  publish(taskId, { kind: "error", message: eventText });
  await noticeQueuedItemsDropped(taskId, dropped);
  return true;
};

/** 被清队丢弃的排队消息：count 含拿不到文本的条（如已出队的 in-flight 条），items 只含有文本的条 */
type DroppedQueueItems = {
  count: number;
  /** attachments = 图片 / 文件的文字占位（「2 张图片」；无附件不带，Q6-04：停止清队的卡据此列出纯附件条） */
  items: Array<{ itemId: string; text: string; attachments?: string }>;
};

/** 提示文本里每条消息的摘要上限（字符） */
const DROPPED_NOTICE_SNIPPET_MAX = 80;
/** 提示文本里最多列几条 */
const DROPPED_NOTICE_LIST_MAX = 5;
/** meta.droppedTexts 里单条完整文本的上限（字符）——只存文本，附件 / 图片绝不放进来 */
const DROPPED_META_TEXT_MAX = 2000;

const truncateChars = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
};

/**
 * 清队前取排队消息文本快照 → 走唯一 sink failQueuedItems（对外语义不变）。
 * failQueuedItems 会 take + clear 队列，之后就拿不到文本了，所以快照必须在它之前、同步取。
 * 仅 displayText（用户看到的原文），不碰 agentText / 图片 / 附件路径。
 */
export const failQueuedItemsCapturingTexts = (
  taskId: string,
  reason: "error" | "cancelled" | "stopped",
): DroppedQueueItems => {
  const textById = new Map(
    listQueuedChatMessages(taskId).map((m) => [m.itemId, m.displayText]),
  );
  // 图片 / 文件条只取数量（「2 张图片」占位）——清队后路径 / 内容都不留；与文本同样必须清队之前同步取
  const attachmentsById = new Map(
    [...listQueuedChatAttachmentCounts(taskId)].map(([itemId, c]) => [
      itemId,
      describeDroppedAttachments(c.images, c.files),
    ]),
  );
  // error 收尾：「立即发送」steer 在飞的消息（已出队、不占 in-flight 槽）和队里其它消息同命运——
  // 一并判失败（原因 error）、并入同一条「未送达」提示。调用方都已确认本实例仍是当前实例（isCurrent），
  // 此刻表里的就是正在收尾的这个 record；快照必须在 closeChatSession 唤醒 steer 之前取（调用方保证同步相邻）。
  // cancelled 不并入：用户停止 / 懒重启由 steer 落定后的 stopped / 重排自己收尾。
  const inflightSteers =
    reason === "error" ? runningChats.get(taskId)?.inflightSteers : undefined;
  const extraItemIds: string[] = [];
  if (inflightSteers) {
    for (const [itemId, displayText] of inflightSteers) {
      if (textById.has(itemId)) continue;
      extraItemIds.push(itemId);
      textById.set(itemId, displayText);
    }
  }
  const failedIds = failQueuedItems(taskId, {
    reason,
    ...(extraItemIds.length > 0 ? { extraItemIds } : {}),
  });
  const items: DroppedQueueItems["items"] = [];
  // 定时到点的系统消息（itemId 形如 sch_xxx.seq.attempt，或正文是 [SCHEDULE_FIRED…] 样板）不是用户发的话：
  // 既不进「未送达」卡（不露样板、不提供「放回输入框」冒充用户重发），也不算进条数——
  // 它被清掉的事实由 schedule-queue-loss 另写一条定时专属提示（R2-02）
  let scheduleDropped = 0;
  for (const itemId of failedIds) {
    const text = textById.get(itemId);
    if (
      parseScheduleClientItemId(itemId) !== null ||
      (typeof text === "string" && isScheduleBoilerplateText(text))
    ) {
      scheduleDropped++;
      continue;
    }
    // 必须在这里（截断之前）脱敏：落盘前全局那道脱敏按「完整的精确值」匹配，
    // noticeQueuedItemsDropped 的摘要 / droppedTexts 先截断再落盘，凭据一旦横跨截断点就只剩半截前缀，
    // 精确匹配命不中、前缀原样写进 events.jsonl 并推给所有订阅者。先脱敏再截断，截断最多切到占位符。
    const attachments = attachmentsById.get(itemId);
    if (typeof text === "string" || attachments) {
      items.push({
        itemId,
        text: typeof text === "string" ? redactSecretsInText(text) : "",
        ...(attachments ? { attachments } : {}),
      });
    }
  }
  return { count: failedIds.length - scheduleDropped, items };
};

/**
 * run 出错清队后的用户可见提示。
 * why：error 清队（failQueuedItems reason=error）前端是「静默清占位」——气泡消失、
 * 不弹 toast（见 chat-view.onQueueFailed 只对 persist_failed / flush_error 弹），
 * 用户看不出排队的话被丢了。落一条 info 事件（持久、断线重连也看得到）。
 * 提示里附每条被丢消息的摘要（用户要重发得知道发的是什么）；完整文本放 meta.droppedTexts
 * 供前端回填。
 * 不用 owned sink：调用时会话已摘表、无实例可绑（同 flushChatQueue 清队通知的豁免口径）。
 */
const noticeQueuedItemsDropped = async (
  taskId: string,
  dropped: DroppedQueueItems,
): Promise<void> => {
  if (dropped.count <= 0) return;
  try {
    const listed = dropped.items.slice(0, DROPPED_NOTICE_LIST_MAX);
    let text = `本轮出错，${dropped.count} 条排队消息未送达、请重新发送`;
    if (listed.length > 0) {
      const lines = listed.map(
        (it) =>
          `- ${truncateChars(it.text.replace(/\s+/g, " ").trim(), DROPPED_NOTICE_SNIPPET_MAX)}`,
      );
      text += `：\n${lines.join("\n")}`;
      if (dropped.count > listed.length) text += `\n…等 ${dropped.count} 条`;
    }
    // eslint-disable-next-line no-restricted-syntax -- 豁免：清队系统通知（会话已关、无实例可绑）
    await writeEventAndPublish(taskId, {
      kind: "info",
      text,
      ...(dropped.items.length > 0
        ? {
            meta: {
              droppedItemIds: dropped.items.map((it) => it.itemId),
              droppedTexts: dropped.items.map((it) =>
                truncateChars(it.text, DROPPED_META_TEXT_MAX),
              ),
            },
          }
        : {}),
    });
  } catch (err) {
    console.warn(`[chat-runner] task=${taskId} 清队通知失败:`, err);
  }
};

/**
 * finalizeChatRunIfCurrent 的兜底包装：收尾自身抛错（落盘 EIO / ENOSPC 等）时，
 * 绝不能让 runActive 闩锁 + 会话留在表里——runActive=true 的会话永远假 busy，
 * 新消息只入队无人 drain，空闲回收 sweeper 也会跳过它。
 * 抛错时仅在「本实例仍是当前主」才兜底：清队 + 摘会话（保留锚点）+ 发 done 让前端收 streaming。
 * runStatus 若因同一个 IO 故障没写成，留给下次启动的 boot-recovery。
 */
const finalizeChatRunSafely = async (
  taskId: string,
  instanceId: number,
  outcome: FinalizeChatOutcome,
  ctx: FinalizeChatRunCtx,
): Promise<boolean> => {
  try {
    return await finalizeChatRunIfCurrent(taskId, instanceId, outcome, ctx);
  } catch (finErr) {
    console.error(
      `[chat-runner] task=${taskId} 收尾(${outcome})抛错、兜底释放会话闩锁:`,
      finErr,
    );
    const curRec = runningChats.get(taskId);
    if (curRec?.instanceId !== instanceId) return false;
    const queueGenerationBeforeClear = getChatQueueGeneration(taskId);
    const dropped = failQueuedItemsCapturingTexts(
      taskId,
      outcome === "cancelled" ? "cancelled" : "error",
    );
    closeChatSession(taskId, instanceId, {
      keepPersisted: true,
      queueGenerationBeforeClear,
      // cancelled 兜底 = 用户停止（或 cancelChatRun 登记了非用户原因，如懒重启，与 cancelled 收尾同口径）；
      // 其余是收尾自己出错（落盘 EIO 等），与 error 收尾同口径
      reason:
        outcome === "cancelled" ? (curRec.pendingCloseReason ?? "user") : "error",
    });
    publish(taskId, { kind: "done", task: ctx.task, ok: outcome !== "error" });
    if (outcome !== "cancelled") {
      await noticeQueuedItemsDropped(taskId, dropped);
    }
    return false;
  }
};

/**
 * 自动重连放弃（次数耗尽 / 不可重试 / 凭据缺失）后的收尾。
 *
 * 为什么不能走 finalizeChatRunIfCurrent：重连在退避前已把坏实例摘表
 * （runReconnectAttempt → closeChatSession(stale)），收尾的实例 CAS 必然落空，
 * 旧实现 handleChatRunFailure 因此整段 no-op——runStatus 永远停在 running、
 * 没有 error 事件、排队消息既没发也没通知。
 *
 * 授权：表内必须没有任何会话（有就是用户退避期间新起的实例 B，绝不碰）；
 * runStatus 只回滚「running」（stop 已写 idle / B 已接管则拒写）。
 * @returns true = 已收尾
 */
const finalizeReconnectGaveUp = async (
  task: Task,
  err: unknown,
): Promise<boolean> => {
  const taskId = task.id;
  const noOwnerInMemory = (): boolean => !runningChats.has(taskId);
  if (!noOwnerInMemory()) return false;
  invalidateMcpProbeCache();
  // 先闭合未配对 tool_call（与 finalizeChatRunIfCurrent 同口径、同 helper）：
  // 流到一半断线的工具调用不会再有完成帧，不补终态就在事件流里永远转圈。
  // 幂等、写前复查 lease；与「盘上是不是 running」无关——这些工具这轮已经死了。
  await finalizeOpenToolCalls(taskId, noOwnerInMemory);
  if (!noOwnerInMemory()) return false;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const failure = summarizeRunFailure(message, err);
  const eventText = `自动重连失败、会话已中断：${failure.text}`;
  // 先做带 expected=running 的条件写：盘上已不是 running（用户 stop 写了 idle /
  // boot recovery 已标 error / 任务已删）→ 返回 null，此时不落 error 事件、不 publish、
  // 不清队（stop 路径已自己清过队、发过 done），避免「已停止的任务凭空多一条自动重连失败」。
  // 写盘 await 期间若 B 起来了，owner 门闩会拒写。
  const errorTask = await setTaskRunStatusIfRunOwner(
    taskId,
    "error",
    noOwnerInMemory,
    undefined,
    "running",
  );
  if (!noOwnerInMemory()) return false;
  if (!errorTask) {
    console.warn(
      `[chat-runner] task=${taskId} 自动重连放弃时任务已不是 running，跳过 error 事件 / 发布`,
    );
    return false;
  }
  // 状态已落 error：事件写失败（EIO 等）不能挡住后面的清队 / done，否则前端 streaming 卡住
  try {
    await writeOwnedEventAndPublish(taskId, noOwnerInMemory, {
      kind: "error",
      text: eventText,
      meta: { detail: failure.detail },
    });
  } catch (writeErr) {
    console.error(`[chat-runner] task=${taskId} 重连放弃 error 事件落盘失败:`, writeErr);
  }
  if (!noOwnerInMemory()) return false;
  const dropped = failQueuedItemsCapturingTexts(taskId, "error");
  publish(taskId, { kind: "task", task: errorTask });
  publish(taskId, { kind: "done", task: errorTask, ok: false });
  publish(taskId, { kind: "error", message: eventText });
  await noticeQueuedItemsDropped(taskId, dropped);
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
  await finalizeChatRunSafely(task.id, instanceId, "error", { task, err });
};

/**
 * 消费一个 chat run 的完整生命周期。
 * 自然 finished = 正常出口：runStatus → awaiting_user（等下一条消息）、**内存会话保留**；
 * cancel → 关内存但保留落盘 sessionAgentId（P0：下一条优先 Agent.resume 续接）；
 * error → 关内存但保留落盘 sessionAgentId（下一条优先 Agent.resume）。
 */
const consumeChatRun = async (
  task: Task,
  run: ChatRun,
  externallyCancelled?: () => boolean,
  // V0.13.x 自动重连计数（tryChatAutoReconnect 递归时递增、防无限重连）
  reconnectAttempt = 0,
): Promise<void> => {
  let cancelled = false;
  // 24h 硬超时：跟用户点停止分开，未答提问打 askExpired（UI「已过期」）
  let hardTimedOut = false;
  let hardTimer: NodeJS.Timeout | null = null;
  // run.cancel() 发出后 wait() 迟迟不返回的逃生口（每个发 cancel 的地方都要 arm），
  // 否则流结束后 wait 挂死会让对话永远「运行中」、停止键也救不回来
  const cancelEscape = createCancelEscape(CANCEL_WAIT_GRACE_MS, () => {
    console.warn(
      `[chat-runner] task=${task.id} run.cancel 后 wait() 超过 ${CANCEL_WAIT_GRACE_MS / 1000}s 未返回、按已取消收尾`,
    );
  });
  let ctx!: AssistantBufferCtx;
  // SDK 流真正结束的时刻（turn-wrapup 取证用）
  let streamEndedAt: number | undefined;
  const rec = runningChats.get(task.id);
  // 捕获本 run 的 instanceId lease——forceClear/懒重启换新会话后，
  // 旧 run 迟到 yield 的主消息流（thinking/assistant/tool/flush）全部被拦、
  // 不再 append/publish 污染 B 的 events.jsonl（rec 缺失用 -1 哨兵 = 永不匹配）。
  const myInstanceId = rec ? rec.instanceId : -1;
  const chatLease = (): boolean =>
    runningChats.get(task.id)?.instanceId === myInstanceId;
  if (rec) {
    rec.runActive = true;
    // 「立即发送」steer 插话要用的本轮句柄（流结束后清，见下）
    rec.currentRun = run;
    rec.cancel = () => {
      cancelled = true;
      void run.cancel().catch(() => {});
      cancelEscape.arm();
    };
  }
  try {
    // 兜底硬超时：24h
    hardTimer = setTimeout(() => {
      hardTimedOut = true;
      cancelled = true;
      const pendingAskId = getPendingAsk(task.id)?.askId;
      cancelPending(task.id);
      if (pendingAskId) clearAskTakenMark(task.id, pendingAskId);
      void supersedePendingAsks(task.id, "等待超过 24 小时", chatLease, {
        expired: true,
      });
      void run.cancel().catch(() => {});
      cancelEscape.arm();
    }, CHAT_HARD_TIMEOUT_MS);

    // 流式消费 + buffer flush：一轮完整回复 → 一条 assistant_message 事件
    ctx = {
      buffer: "",
      // 子代理卡片徽标要显示「沿用」的实际模型（只有 Cursor 路径挂了 subagent 才取得到）
      subagentParentModel: getSubagentParentModel(rec?.agent),
      subagentDisplayLookup: getSubagentDisplayLookup(rec?.agent),
      flush: async () => {
        // assistant_message 落盘前冲掉待发 delta——防尾巴 delta 晚到成幽灵字
        flushPendingAssistantDeltas(task.id);
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
    if (rec) {
      // 插话前冲刷：先 thinking 再 assistant，对齐流内顺序
      rec.flushAssistant = async () => {
        await flushThinkingBuffer(task.id, ctx, chatLease);
        await ctx.flush();
      };
    }

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
    streamEndedAt = Date.now();
    // 流已结束：这一轮不再能插话（steer 只对在跑的 run 有意义）
    if (rec && rec.currentRun === run) {
      rec.currentRun = undefined;
      rec.flushAssistant = undefined;
    }
    await flushThinkingBuffer(task.id, ctx, chatLease);
    await ctx.flush();

    // 硬超时计时器要一直罩到 wait() 返回（流结束后 wait 若挂死才有上限）；
    // wait 返回 / 抛错后必须清，否则 24h 后会对已结束的 run 误写「等待超过 24 小时」
    const result = await cancelEscape.wait(run).finally(() => {
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      cancelEscape.dispose();
    });

    if (cancelled || externallyCancelled?.() || result.status === "cancelled") {
      if (hardTimedOut) {
        await supersedePendingAsks(task.id, "等待超过 24 小时", chatLease, {
          expired: true,
        });
      }
      // cancel 收尾唯一入口——失主（含 forceClear 空窗）no-op
      await finalizeChatRunSafely(task.id, myInstanceId, "cancelled", {
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
      // SDK 的终态错误（result.error）作 cause 保留——不再只剩一段被截断的 dump 文本
      throw buildRunNotFinishedError(
        `agent run status=${result.status}${
          result.result ? `: ${result.result.slice(0, 200)}` : ""
        }${sdkErr}\n--- SDK result dump ---\n${resultDump}`,
        result,
      );
    }

    // chat 模式不交卷（submitSeen 恒 false）→ no-op；
    // task 模式固定收尾已在流内补发（handleSdkMessage），这里仅作兜底、once 守卫防重复
    await maybeEmitSubmitFixedText(ctx, (ev) =>
      writeOwnedEventAndPublish(task.id, chatLease, ev),
    );

    // 自然 finished 也必须查 instance——旧实现完全不查、空窗可覆盖 B
    await finalizeChatRunSafely(task.id, myInstanceId, "finished", {
      task,
    });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    cancelEscape.dispose();
    // 流中途抛错 / 断线：先把已缓冲、用户屏幕上早已看到的正文和思考落成事件，
    // 再走下面任何分支（重连「连接中断」info / 放弃时的 error / cancel 收尾）。
    // 为什么：正文 / 思考是攒在本 run 自己的 ctx 里、遇到工具调用或流正常结束才 flush（见 try 里
    // 流后那两行）；抛错直接跳进 catch，这两行没机会跑，ctx 随本次 consume 作废——
    // 重连会起新 ctx，这段已经展示给用户的尾巴就再也落不了盘（刷新页面 / 回放就丢），
    // 而错误文案还写着「已生成的内容保留在上方」。必须在写 error / 重连事件之前冲，保持时序。
    // 幂等：两个 flush 都是「先取走并清空 buffer 再写」，正常路径已冲过的这里是 no-op；
    // best-effort：落盘失败只告警，绝不能挡住后面的重连 / 错误收尾。写事件走 chatLease，失主不落盘。
    try {
      await flushThinkingBuffer(task.id, ctx, chatLease);
      await ctx.flush();
    } catch (flushErr) {
      console.warn(
        `[chat-runner] task=${task.id} 流异常时冲刷已缓冲回复失败:`,
        flushErr,
      );
    }
    // 流异常中断：这一轮的 run 句柄已经是死的，不能再被 steer。
    // 为什么在这里清：currentRun 只在流「正常走完」时清；抛错走 catch → 自动重连，
    // 坏实例会在首次退避（2s）里仍挂在表内（runActive=true、currentRun 仍指向断流的 run），
    // canSteerChatRun 会误判可插话——「立即发送」把消息塞给死 run，要么挂着、
    // 要么等重连摘掉坏实例后被判「会话被摘除」静默记 stopped。清掉后调用方回退「打断重发」。
    // 只清 currentRun（canSteerChatRun 的唯一判据）；flushAssistant 保留，半截回复仍可冲刷。
    if (rec && rec.currentRun === run) rec.currentRun = undefined;
    // 用户 stop 后 stream 以异常收场（abort 类）→ 走 cancel 收尾，
    // 绝不落 error 事件 / error 状态覆盖 stop 路由已写的 idle +「用户停止了对话」。
    if (cancelled || externallyCancelled?.()) {
      if (hardTimedOut) {
        await supersedePendingAsks(task.id, "等待超过 24 小时", chatLease, {
          expired: true,
        });
      }
      await finalizeChatRunSafely(task.id, myInstanceId, "cancelled", {
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
    // 重连链已走完（接管成功 / 放弃 / 被停止 / 让位）。接管成功时暂存的后台结果早已放回新实例；
    // 还留在暂存里的就是没等到可送会话的（放弃 / 停止 / 让位）——不留给以后的任何会话，
    // 清掉并如实告诉用户。fire-and-forget、不 await：不给下面的收尾路径平添一个时序点
    discardStashedBackgroundResults(
      task.id,
      handled ? "会话已被停止或替换" : "自动重连未能恢复会话",
    );
    if (!handled) {
      // 重连放弃时坏实例已被重连链摘表（表空）：实例 CAS 的常规收尾必然落空、
      // 状态会永远停在 running——走专用收尾（见 finalizeReconnectGaveUp）。
      // 表内仍是本实例（首轮就判不可重试等、未进退避）仍走常规 error 收尾；
      // 表内是别的实例 = 用户新起的 run，两条路径都不碰。
      const slotGone = myInstanceId >= 0 && !runningChats.has(task.id);
      if (slotGone) {
        console.error("[chat-runner] task", task.id, "自动重连放弃:", err);
        await finalizeReconnectGaveUp(task, err);
      } else {
        await handleChatRunFailure(task, err, myInstanceId);
      }
    }
  } finally {
    noteTurnWrapUp(task.id, rec?.agentId, ctx, streamEndedAt);
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
 * 把一条用户消息拼成喂给 agent 的最终文本：正文 + 附件段
 * （图走 read 转 vision、路径自己 read/grep）。
 * 普通 send 与「立即发送」steer 共用——两条路径喂给模型的文本必须一致。
 */
export const composeChatPrompt = (
  text: string,
  imagePaths?: string[],
  attachmentPaths?: string[],
): string => {
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
  return lines.join("\n");
};

/** steer 的结果（见 {@link steerChatRun}） */
export type SteerChatResult =
  /** 这一轮已经收下这条消息——调用方视为 handedOff */
  | "delivered"
  /** 没被这一轮收下（run 刚好结束 / SDK 要求按普通后续消息发）——调用方排队当下一轮 */
  | "followup"
  /** run 被用户停止 / 会话被摘除（非系统换实例）/ 超过 STEER_TOTAL_TIMEOUT_MS 仍未落定——消息作废 */
  | "cancelled"
  /**
   * 实例被系统换掉（自动重连 / error 收尾 / 懒重启强清）、这条 steer 没确认送达，用户并没有停止——
   * 调用方按「至少一次」重排队为 followup（宁可重复一条、也不静默丢用户的话）。
   */
  | "replaced";

/** steerChatRun 的可选参数 */
export type SteerChatOpts = {
  settleGraceMs?: number;
  totalTimeoutMs?: number;
  /**
   * 「立即发送」的那条排队消息（itemId + 用户看到的原文）：在飞期间登记到会话记录上，
   * 供 error 收尾把它和队里其它消息一并判失败 / 计入「未送达」提示。后台结果 steer 等不带。
   */
  item?: { itemId: string; displayText: string };
  /**
   * 超过总期限仍未落定时回调（先于返回 cancelled）。给了就表示**调用方自己负责向用户说明**，
   * 本函数不再写那条面向「用户插话」的通用提示（措辞是「一条插话…」，对后台子代理结果这类不是用户说的话不贴切）。
   * 后台结果批（drainBackgroundResults）用它按自己的口径写「未送达」。
   */
  onTimeout?: () => void;
};

/** run 结束后再等 steer 落定的宽限；超时就按 run 终态收尾，不让「立即发送」永远悬着 */
const STEER_SETTLE_GRACE_MS = 5000;

/**
 * 一次 steer 从发出到落定的总期限。
 * 为什么要有：steer 要等「这一轮真正收下」才 resolve；主 AI 卡在跑得很久的工具里、run 又一直不结束时，
 * 既不 resolve / reject，STEER_SETTLE_GRACE_MS 也不会起算（它从 run 结束才开始计）——
 * 「立即发送」会永远悬在「已落盘未送达」，消息在界面上既没送达也没失败。
 * 取 30 分钟：要长于绝大多数前台长工具（构建 / 测试 / 子代理），避免把还会被收下的插话误判失败，
 * 又远短于整轮 24h 硬顶——到期按失败处理（返回 cancelled）并在事件流里如实说明。
 */
export const STEER_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 把本轮已缓冲的半截回复先落成 assistant_message（best-effort，失败只告警）。
 * assistant 文本是按「一段」缓冲、遇到工具调用 / 收尾才写盘的；插话的 user_reply
 * 直接落盘——不先冲，半截话会排到用户插话「后面」，读起来像 AI 先听见了再说。
 */
export const flushChatAssistantBuffer = async (
  taskId: string,
): Promise<void> => {
  const flush = runningChats.get(taskId)?.flushAssistant;
  if (!flush) return;
  try {
    await flush();
  } catch (err) {
    console.warn(`[chat-runner] 插话前冲刷半截回复失败 task=${taskId}:`, err);
  }
};

/**
 * 当前能不能把一条消息「顶」进正在跑的这一轮。
 * 条件：有会话、run 在消费、拿得到本轮 run 句柄且它支持 steer（只有 Cursor 本地 run
 * 有；pi 自研后端 / 冷启动占位 / 刚收尾的空窗都没有——调用方回退到旧的「打断重发」）。
 */
export const canSteerChatRun = (taskId: string): boolean => {
  if (isChatRewindInProgress(taskId)) return false;
  const rec = runningChats.get(taskId);
  if (!rec || !rec.runActive || !rec.currentRun) return false;
  return typeof rec.currentRun.steer === "function";
};

/**
 * 把消息插进正在跑的这一轮（Codex / Cursor IDE 的「插话」语义）：不停止、不重开会话，
 * AI 在当前步骤（工具调用 / 一段输出）结束后读到它并转向。
 *
 * ⚠️ `run.steer()` 要等「这一轮真正收下这条消息」才 resolve——主 AI 卡在一个跑得很久的
 * 工具里时，要等工具返回（实测）。所以本函数可能挂很久，调用方必须 fire-and-forget、
 * 靠 message_op 推送收尾，绝不能让 HTTP 请求同步等它。
 *
 * 失败 / 异常一律降级 followup（消息不丢、按下一轮发）；run 被用户停止 → cancelled；
 * 实例被自动重连换掉（用户没停）→ replaced，调用方按「至少一次」重排队。
 * 调用方在写 user_reply 之前应先 {@link flushChatAssistantBuffer}，事件顺序才是
 * 「AI 说了半句 → 用户插话」。
 */
export const steerChatRun = async (
  taskId: string,
  prompt: string,
  opts?: SteerChatOpts,
): Promise<SteerChatResult> => {
  // 在飞期间把这条消息登记到会话记录上（error 收尾清队时要能看见它，见 RunningChatRecord.inflightSteers）；
  // 落定（任何出口，含抛错）即注销。登记与注销都绑定「steer 开始时的那个 record」。
  const item = opts?.item;
  const registeredOn = item ? runningChats.get(taskId) : undefined;
  // 调用方已经提前登记过（registerInflightSteer，第八轮 L5-01）：登记与注销都归它管，这里不重复、也不替它注销——
  // 否则 steer 一落定本函数就把条目删了，到调用方处理结果（重排 / 记终态）之间的几个微任务里，error 收尾又看不见这条消息。
  const preRegistered =
    !!item && !!registeredOn?.inflightSteers?.has(item.itemId);
  if (item && registeredOn && !preRegistered) {
    (registeredOn.inflightSteers ??= new Map()).set(item.itemId, item.displayText);
  }
  try {
    return await steerChatRunInner(taskId, prompt, opts);
  } finally {
    if (item && registeredOn && !preRegistered) {
      registeredOn.inflightSteers?.delete(item.itemId);
    }
  }
};

/**
 * 在「take 之后、steerChatRun 起手之前」就把一条「立即发送」steer 的消息登记到当前会话记录上（第八轮 L5-01）。
 *
 * 为什么要有：这条消息已被 take 出队、又不占 in-flight 槽；take 之后还要 await 冲半截回复 / 落 user_reply / 检查点，
 * steerChatRun 的登记要等这些都做完才发生。这段空窗里 error 收尾清队，消息既不在队里、也不在 inflightSteers，
 * 就会被记成 failed(stopped)、也不进「N 条未送达」提示。提前登记后 error 收尾能把它和队里其它消息一并判失败。
 *
 * 绑定「登记时的那个 record」；没有会话（空窗里已被摘）返回空操作。返回的注销函数幂等，调用方在这条消息有了定论
 * （送达 / 重排 / 记终态 / 提前返回）之后调用。steerChatRun 见到已登记的条目不会再重复登记 / 注销。
 */
export const registerInflightSteer = (
  taskId: string,
  item: { itemId: string; displayText: string },
): (() => void) => {
  const rec = runningChats.get(taskId);
  if (!rec) return () => {};
  (rec.inflightSteers ??= new Map()).set(item.itemId, item.displayText);
  return () => {
    rec.inflightSteers?.delete(item.itemId);
  };
};

const steerChatRunInner = async (
  taskId: string,
  prompt: string,
  opts?: SteerChatOpts,
): Promise<SteerChatResult> => {
  const settleGraceMs = opts?.settleGraceMs ?? STEER_SETTLE_GRACE_MS;
  const totalTimeoutMs = opts?.totalTimeoutMs ?? STEER_TOTAL_TIMEOUT_MS;
  const rec = runningChats.get(taskId);
  const run = rec?.currentRun;
  if (!rec || !run || typeof run.steer !== "function") return "followup";
  const instanceId = rec.instanceId;

  let steerPromise: Promise<
    { kind: "outcome"; outcome: string } | { kind: "error"; err: unknown }
  >;
  try {
    steerPromise = run.steer(prompt).then(
      (outcome) => ({ kind: "outcome" as const, outcome }),
      (err: unknown) => ({ kind: "error" as const, err }),
    );
  } catch (err) {
    console.warn(`[chat-runner] steer task=${taskId} 同步抛错、降级排队:`, err);
    return "followup";
  }

  // run 先结束（自然收尾 / 被停止）：steer 本该很快落定，给个宽限、超时按 run 终态收尾
  const grace: { timer: NodeJS.Timeout | null; done: boolean } = {
    timer: null,
    done: false,
  };
  const endedFirst = run
    .wait()
    .then(
      (r) => r.status as string,
      () => "error",
    )
    .then(
      (status) =>
        new Promise<{ kind: "ended"; status: string }>((resolve) => {
          if (grace.done) return;
          grace.timer = setTimeout(
            () => resolve({ kind: "ended", status }),
            settleGraceMs,
          );
        }),
    );

  // 实例被自动重连换掉：断流后 steer / wait 是拒绝还是挂起没验证过，别指望它们一定落定——
  // 重连链摘实例时（markChatInstanceReplacedByReconnect）直接唤醒本次等待
  let wakeReplaced!: () => void;
  const replacedFirst = new Promise<{ kind: "replaced" }>((resolve) => {
    wakeReplaced = () => resolve({ kind: "replaced" });
  });
  (rec.replacedWaiters ??= new Set()).add(wakeReplaced);

  // 总期限：steer / run.wait / 摘表唤醒三条路都没落定时的最后兜底（见 STEER_TOTAL_TIMEOUT_MS）
  const total: { timer: NodeJS.Timeout | null } = { timer: null };
  const timedOutFirst = new Promise<{ kind: "timeout" }>((resolve) => {
    total.timer = setTimeout(() => resolve({ kind: "timeout" }), totalTimeoutMs);
  });

  const settled = await Promise.race([
    steerPromise,
    endedFirst,
    replacedFirst,
    timedOutFirst,
  ]);
  grace.done = true;
  if (grace.timer) clearTimeout(grace.timer);
  if (total.timer) clearTimeout(total.timer);
  rec.replacedWaiters?.delete(wakeReplaced);

  const stillCurrent = runningChats.get(taskId)?.instanceId === instanceId;
  // 摘表的是系统（重连 / error 收尾 / 懒重启，而非用户停止）：先于一切「会话被摘除 → cancelled」判断，
  // 否则消息既没送达、用户也没撤销，却被记成 failed(stopped) 静默丢掉
  const replacedByReconnect = rec.replacedByReconnect === true;
  if (settled.kind === "replaced") return "replaced";
  if (settled.kind === "timeout") {
    if (replacedByReconnect) return "replaced";
    console.warn(
      `[chat-runner] steer task=${taskId} 超过 ${Math.round(totalTimeoutMs / 1000)}s 仍未落定、按失败处理`,
    );
    if (opts?.onTimeout) {
      // 调用方（后台结果批）自己说明——见 SteerChatOpts.onTimeout
      opts.onTimeout();
      return "cancelled";
    }
    // 不带用户原文（user_reply 气泡已在，且原文可能含敏感内容）；owned sink——会话已换人就不写了
    await writeOwnedEventAndPublish(
      taskId,
      () => runningChats.get(taskId)?.instanceId === instanceId,
      {
        kind: "info",
        text:
          `一条插话等了 ${Math.max(1, Math.round(totalTimeoutMs / 60_000))} 分钟仍没被这一轮收下，按失败处理（没有重发）；` +
          "若 AI 稍后仍读到它，会按这条插话继续，不想要可以停止本轮",
      },
    );
    return "cancelled";
  }
  if (settled.kind === "outcome") {
    if (settled.outcome === "complete_delivered") return "delivered";
    // "revert_to_followup"：SDK 明确说这条没被收下、按普通后续消息发
    if (stillCurrent) return "followup";
    return replacedByReconnect ? "replaced" : "cancelled";
  }
  if (settled.kind === "error") {
    console.warn(
      `[chat-runner] steer task=${taskId} 失败、降级排队:`,
      settled.err,
    );
    if (stillCurrent) return "followup";
    return replacedByReconnect ? "replaced" : "cancelled";
  }
  // ended：run 已结束但 steer 迟迟没落定
  if (replacedByReconnect) return "replaced";
  return settled.status === "cancelled" || !stillCurrent
    ? "cancelled"
    : "followup";
};

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
  // 上一轮的句柄已失效；新 run 由 consumeChatRun 接管时再置
  rec.currentRun = undefined;
  rec.flushAssistant = undefined;
  // 上一轮遗留的关闭原因作废：cancel 时那一轮若恰好已自然结束、会话留了下来，
  // 它不能串到这一轮（例如 24h 硬超时的取消会被误标成「会话重启」）
  rec.pendingCloseReason = undefined;
  rec.pendingCloseBackground = undefined;

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

  let run: ChatRun;
  try {
    const prompt = composeChatPrompt(text, imagePaths, attachmentPaths);
    const perfTracker = createRunPerfTracker({
      taskId: task.id,
      agentId: rec.agent.agentId,
      runKind: "chat-followup",
      promptBytes: Buffer.byteLength(prompt, "utf-8"),
      model: rec.model,
    });
    run = await withSdkDeadline(
      rec.agent.send(prompt, {
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
      }),
      SDK_SEND_TIMEOUT_MS,
      "agent.send",
    );
    // 立刻挂到共享取消闭包：此后 stop 到达（如置 running 的 await 期间）能直接 cancel 本 run
    acceptedRun = run;
    perfTracker.attachRun(run);
  } catch (err) {
    rec.runActive = false;
    console.error(`[chat-runner] sendChatMessage: task=${task.id} send 失败`, err);
    // 用户 stop 导致的抛错按用户主动关；其余是 send 自己失败，仍在跑的后台子代理会被取消——让用户看得见
    // ⚠️ 这条 reason=error 的关闭**不是** run 出错收尾：它不清队、不并入 inflightSteers（那是 finalize error / 兜底做的）。
    // 理论上此刻没有活 run（runActive 刚被置 false），在飞的「立即发送」steer 只可能是上一轮刚结束、宽限内未落定的——
    // 它会被唤醒为 replaced、由 requeueAsFollowup 重排回队首（至少一次），**不会**像 run 出错收尾那样记 failed(error)
    closeChatSession(task.id, rec.instanceId, {
      reason: cancelledDuringSend ? "user" : "error",
    });
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

  const rawKey = bootArgs?.apiKey;
  const apiKey = typeof rawKey === "string" ? rawKey : undefined;
  const model =
    bootArgs?.model && typeof bootArgs.model.id === "string"
      ? bootArgs.model
      : undefined;

  // 2) 服务重启 / 空闲回收后：Agent.resume 接回再 send
  // 本路径是 ask 答案的 owner——claimRun + ownerInstanceId，先发答案再 flush 队列
  // 自定义允许空 Key（本地无鉴权），用 `!== undefined` 而不是 truthy
  if (task.sessionAgentId && apiKey !== undefined && model && !hasChatSession(task.id)) {
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
  if (apiKey === undefined || !model) return false;
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
  if (isChatRewindInProgress(taskId)) {
    // 只 return 会把这次触发吞掉：门闩占着时队列非空，rewind 的锁内复查必因「仍有排队」
    // 拒绝回退、释放门闩——之后再没人 flush，就剩「会话空闲 + 队列非空 + 无人 drain」，
    // 已 202 的排队消息永远不发（run 收尾链式 flush / steer 落 followup 的补 flush 都会撞上）。
    // 与 releaseChatRunClaim 同款：等门闩解除后补 drain（回退成功会清队，补 drain 自然 no-op）。
    // 仅「会话在 + run 空闲 + 队列非空」才补：无会话时队列归启动状态机，补 drain 会误清；
    // run 仍活跃时等它自己收尾的链式 flush。
    if (
      getChatQueueCount(taskId) > 0 &&
      hasChatSession(taskId) &&
      !isChatRunActive(taskId)
    ) {
      scheduleQueueDrainAfterGate(taskId);
    }
    return;
  }

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

// ----------------- 后台子代理结果投递 -----------------

/**
 * 后台子代理收尾 → 把结果作为一条消息送回主 AI（见 subagent-background）。
 *  - 事件流先落一行给用户看的提示（正文只交给主 AI、由它转述，避免长输出刷屏）。
 *    这行落在结果真正进 send 之前，所以只说「将转交」、不能说「已交给」；之后若没送成
 *    （会话关了 / 重连放弃 / 被停止）由关会话 / 重连链尾另写一句「未送达」，不留假提示；
 *  - 主 AI 空闲：唤醒一轮（sendChatMessage，不落用户气泡——这不是用户说的话）；
 *  - 主 AI 在忙：能 steer 就插进当前这一轮，否则攒着、这一轮收尾时再送。
 * 被取消的（停止 / 关会话 / 删任务）没人要结果，直接丢。
 */
const deliverBackgroundSubagentResult = async (
  taskId: string,
  evt: BackgroundSubagentEvent,
): Promise<void> => {
  if (evt.status === "cancelled") return;
  const rec = runningChats.get(taskId);
  // 会话已不是发起它的那个（关了 / 换了新实例）：结果送给新会话只会让它莫名其妙
  if (!rec || (evt.parentAgentId && rec.agentId !== evt.parentAgentId)) {
    console.warn(
      `[chat-runner] 后台子代理 ${evt.jobId} 收尾时会话已不在 task=${taskId}、结果丢弃`,
    );
    return;
  }
  const instanceId = rec.instanceId;
  try {
    await writeOwnedEventAndPublish(
      taskId,
      () => runningChats.get(taskId)?.instanceId === instanceId,
      {
        kind: "info",
        text: formatBackgroundSubagentNotice(evt),
        // 机器字段：主 AI 被后台结果唤醒的 run 失败时，错误卡据此知道「这一轮不是用户那句话触发的」、
        // 不给重试（chat-turns.resolveErrorRecovery，第二轮 review V3-04）
        meta: { subkind: "background_result" },
      },
    );
  } catch (err) {
    console.warn(`[chat-runner] 后台子代理提示落盘失败 task=${taskId}:`, err);
  }
  // 落提示是 await：期间会话可能被关 / 被换（用户停止、回退、重启、重连摘实例）。closeChatSession 清的是
  // 「那一刻」的待送队列，这条还没入队、清不到；这里若照常入队就成了孤儿，会被同一持久化 agent
  // （agentId 相同，按 agentId 拦不住）的下一个新会话在收尾时送出。所以入队前按 instanceId 复核发起它的实例还在，
  // 不在就如实写「未送达」（到达提示因 owner 失效多半也没落，用户至少看到这一句）。
  if (runningChats.get(taskId)?.instanceId !== instanceId) {
    noticeBackgroundResultsDropped(taskId, 1, "会话已关闭");
    return;
  }
  const list = pendingBackgroundResults.get(taskId) ?? [];
  list.push(formatBackgroundSubagentMessage(evt));
  pendingBackgroundResults.set(taskId, list);
  await drainBackgroundResults(taskId);
};

/**
 * 攒着、还没送进主 AI 的后台子代理结果条数（只读）。
 * 给测试 / 诊断用：测试要等「结果已入队」时直接观察它，而不是睡固定毫秒、
 * 也不是靠「到达提示落盘与入队之间只有微任务」这种实现不变量（将来中间加一个 await 就会失效）。
 */
export const getPendingBackgroundResultCount = (taskId: string): number =>
  pendingBackgroundResults.get(taskId)?.length ?? 0;

/**
 * 把攒着的后台子代理结果送进主 AI（一次合并成一条消息）。
 * 幂等、可重复调：没东西 / 没会话直接返回；送不出去的放回去等下一次（这一轮收尾会再调）。
 */
export const drainBackgroundResults = async (taskId: string): Promise<void> => {
  const rec = runningChats.get(taskId);
  const queued = pendingBackgroundResults.get(taskId);
  if (!rec || !queued || queued.length === 0) return;
  // rewind 门闩中：回退若成功，会话马上被关、攒着的随之作废（closeChatSession 会如实提示），别往里送。
  // 但回退也可能最终被拒（找不到检查点 / 仍有排队 / 恢复失败…）：门闩释放后会话仍在且空闲，
  // 此后没有任何 run 收尾会再调本函数，结果就卡在「已提示将转交、却永远不送」。
  // 所以会话空闲时等门闩解除后补一次（同 flushChatQueue 撞门闩的口径；run 还在跑则等它自己的收尾 drain）。
  if (isChatRewindInProgress(taskId)) {
    if (!rec.runActive) scheduleQueueDrainAfterGate(taskId);
    return;
  }

  const putBack = (batch: string[]): void => {
    // 会话期间被关了（closeChatSession 已清掉这个 key）就别再复活——但这批已经落过「将转交」的提示，
    // 不能就此悄悄没了：如实补一句「未送达」
    if (runningChats.get(taskId)?.instanceId !== rec.instanceId) {
      noticeBackgroundResultsDropped(taskId, batch.length, "会话已关闭");
      return;
    }
    const cur = pendingBackgroundResults.get(taskId) ?? [];
    pendingBackgroundResults.set(taskId, [...batch, ...cur]);
  };
  const SEP = "\n\n---\n\n";

  if (rec.runActive) {
    // 忙：能 steer 就插进当前这一轮（AI 当前步骤结束后读到），否则等这一轮收尾（finalize 会再调本函数）
    if (!canSteerChatRun(taskId)) return;
    const batch = queued.splice(0);
    // 主 AI 若正睡在 `wait` 里（典型：派了后台子代理、然后「等一会儿」等它们），steer 要等它这一步结束才送得进去，
    // 结果会被睡眠压住（最长 30 分钟，恰好等于下面的总期限）。后台结果正是它在等的新信息：叫醒它，
    // 它读到 [WAIT_INTERRUPTED] 后就能处理这批结果；还要等别的再调一次 wait 即可。
    const wokenWaits = interruptWaits(taskId, "steer");
    if (wokenWaits > 0) {
      console.log(
        `[chat-runner] task=${taskId} 后台结果到达：${wokenWaits} 个 wait 已提前结束`,
      );
    }
    // 总期限（STEER_TOTAL_TIMEOUT_MS）内主 AI 一直没收下：steerChatRun 返回 cancelled，但这和「会话被停止 / 关闭」不是一回事——
    // 会话与这一轮都还在，SDK 之后仍可能读到这批结果。措辞要如实：不写「已被停止或关闭」，
    // 也不沿用面向用户插话的「一条插话…」（这批不是用户说的话），由这里按后台结果的口径写
    const steerState = { timedOut: false };
    const outcome = await steerChatRun(taskId, batch.join(SEP), {
      onTimeout: () => {
        steerState.timedOut = true;
      },
    });
    // replaced（实例被自动重连换掉、用户没停）：steer 没确认送达，这批结果不能丢——
    // 它们是已经完成的子代理的产出，对重连接回的新实例（同一持久化 agent 的续接）仍然有效。
    // 这里先前直接 return 丢掉，与「窗口内完成」同属结果丢失。暂存给重连链，新实例接回后放回待送队列、
    // 由那一轮收尾的 drain 送出；重连放弃 / 被停止则由链尾清掉并提示「未送达」。
    // 按旧实例（本函数起手拿到的 rec）的 agentId 绑定，绝不送进别的会话；排在已暂存的前面（它们更早到达）。
    // 与用户消息的「至少一次」重排（chat-queue-send-now 的 requeueAsFollowup）互不相干：一个走队列、一个走暂存。
    //
    // ⚠️ 只有 reason=reconnect 才暂存：replaced 还包括 error 收尾 / 懒重启——它们没有「新实例接回」这一步，
    // 暂存永远等不到出口（用户只在到达时看到过「将转交」，之后一声不响），日后任何同 agentId 的重连
    //（持久化 agent 的 id 跨会话不变）还会把这些陈旧结果当成自己的投进去。这两种按 closeChatSession 的口径作废并写「未送达」。
    if (outcome === "replaced") {
      const replacedReason = rec.replacedReason;
      if (replacedReason === "reconnect" && rec.agentId) {
        stashBackgroundResults(taskId, rec.agentId, batch, "front");
      } else {
        noticeBackgroundResultsDropped(
          taskId,
          batch.length,
          replacedReason && replacedReason !== "user"
            ? CHAT_CLOSE_REASON_LABEL[replacedReason]
            : "会话已被替换",
        );
      }
      return;
    }
    if (outcome === "delivered") return;
    // cancelled：没人要了，作废。出错收尾（含 sendChatMessage send 抛错的 error 关闭）/ 懒重启 / 自动重连摘实例
    // 不在这里（那几种是 replaced，走上面）；这里是用户停止 / 回退 / 删任务 / 总期限内没被收下。
    // 但这批已经 splice 出队、到达时也落过「将转交」，只有本函数手里还拿着它——
    // closeChatSession 清的 pending 里没有它，不在这里说一句就是悄悄没了。
    // 超时与「会话被关」要分开说（见上面 steerState.timedOut）；其余原因这里分不出（steerChatRun 只回 cancelled）
    if (outcome === "cancelled") {
      noticeBackgroundResultsDropped(
        taskId,
        batch.length,
        steerState.timedOut
          ? `等了 ${Math.max(1, Math.round(STEER_TOTAL_TIMEOUT_MS / 60_000))} 分钟仍没被这一轮收下；会话还在，若 AI 稍后仍读到会照常使用`
          : "会话已被停止或关闭",
      );
      return;
    }
    putBack(batch);
    // 退回的原因多半是这一轮刚好结束：空闲了就直接唤醒，别等不会再来的收尾
    if (!isChatRunActive(taskId)) void drainBackgroundResults(taskId);
    return;
  }

  // 空闲：唤醒一轮
  const batch = queued.splice(0);
  // 这批已 splice 出队、到达时也落过「将转交」，只有本函数手里拿着它：读任务抛错（meta 半写 / EIO）时
  // 不能让异常把它带走——外层只会 console.warn，用户就以为交给了主 AI，实际悄悄没了。如实补一句「未送达」
  let task: Task | null;
  try {
    task = await getTask(taskId);
  } catch (err) {
    console.warn(`[chat-runner] 唤醒送后台结果前读任务失败 task=${taskId}:`, err);
    noticeBackgroundResultsDropped(taskId, batch.length, "读取任务失败");
    return;
  }
  // 任务已删除 / tombstone：没有人在看这条事件流了，不再提示
  if (!task) return;
  const sent = await sendChatMessage(task, batch.join(SEP));
  if (sent === "sent") return;
  if (sent === "cancelled" || sent === "owner_invalid" || sent === "no_session") {
    // 会话没了 / 被停止：结果作废，同样如实告诉用户没送到
    noticeBackgroundResultsDropped(taskId, batch.length, "会话已关闭或被停止");
    return;
  }
  // busy / send_failed：放回去，等下一次（别人的 run 收尾时会再调）
  putBack(batch);
  // 例外：busy 是因为 rewind 门闩恰好在上面 getTask 的 await 里占上了——回退若被拒，没有 run 收尾会再调本函数，
  // 等门闩解除后补一次。仅「放回成功（同一实例仍在）+ 空闲」才补：会话已关就轮不到它，run 在跑则等它的收尾 drain
  if (
    isChatRewindInProgress(taskId) &&
    runningChats.get(taskId)?.instanceId === rec.instanceId &&
    !isChatRunActive(taskId)
  ) {
    scheduleQueueDrainAfterGate(taskId);
  }
};

{
  // 订阅一次（hot reload 先注销旧的，免得重复投递）
  const KEY = "__flowshipChatBackgroundSubagentUnsub__";
  const g = globalThis as unknown as Record<string, (() => void) | undefined>;
  g[KEY]?.();
  g[KEY] = onBackgroundSubagentSettled((taskId, evt) => {
    void deliverBackgroundSubagentResult(taskId, evt).catch((err) => {
      console.warn(
        `[chat-runner] 后台子代理结果投递失败 task=${taskId}:`,
        err,
      );
    });
  });
}

{
  // 后台子代理清单变了（转入后台 / 收尾）→ 推最新整份给界面。订阅一次（hot reload 先注销旧的）
  const KEY = "__flowshipChatBackgroundJobsUnsub__";
  const g = globalThis as unknown as Record<string, (() => void) | undefined>;
  g[KEY]?.();
  g[KEY] = onBackgroundSubagentJobsChanged((taskId) => {
    publishBackgroundSubagents(taskId);
  });
  // watch-task bootstrap 读当前清单走这里（路由不 import 本模块，见 subagent-background 的 provider 说明）
  setBackgroundSubagentSnapshotProvider(getBackgroundSubagentJobs);
}

/**
 * 用户插话（「立即发送」steer）时调：把主 AI 正在前台等的子代理全部转后台，
 * 它那个阻塞的工具调用立刻返回，主 AI 马上能读到用户的话。返回转了几个（无会话 / 不支持 = 0）。
 */
export const detachChatForegroundSubagents = (taskId: string): number =>
  getSubagentSessionControl(runningChats.get(taskId)?.agent)?.detachForeground() ??
  0;

// ----------------- 释放认领后等 rewind 门闩再补 drain -----------------

/**
 * flushChatQueue 入口见 rewind 门闩会直接 return，所以释放认领当下 flush 无用，
 * 必须等门闩解除后补 drain。
 *
 * 若 rewind 最终成功，closeChatSessionUnconditional 已清队，补 drain 自然 no-op；
 * 若 rewind 被拒绝（队列非空正是拒因），补 drain 把已 202 的排队消息发出去——
 * 否则 session idle && queue>0 && !draining 永久悬空。
 *
 * 门闩解除后顺带补一次后台子代理结果的 drain（drainBackgroundResults 撞门闩同样只能 return）：
 * 先 flush 用户排队的话、再送结果——与收尾时 `flushChatQueue` 先于 `drainBackgroundResults` 同序。
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
      await drainBackgroundResults(taskId);
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
