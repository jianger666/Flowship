/**
 * Task runner（V0.6 重构、仅服务 task.mode === "task" 的 task）
 *
 * # 整体模型（详见 docs/V0.6-REFACTOR.md）
 *
 * - **task 容器 + action 历史**：task = 需求生命周期容器、action = 单次动作
 *   （plan / build / review / ship / dev）、用户自由触发
 * - **单 SDK Run 永生**：整个 task 共用一个 Agent + Run、task 终态前不退
 * - **每次推进** = 后端 `appendAction` + 向 agent 发 `[NEXT_ACTION ...]` 指令
 * - **用户输入条消息** = `agent.send([USER_MESSAGE]…)`（V0.13.x 统一语义）
 * - **终态** = wait-ack write `[TASK_DONE]` / `[TASK_ABANDONED]` / `[CANCELLED]`
 *
 * # V0.6.0.1：chat 模式剥离
 *
 * 自由对话（task.mode === "chat"）走独立 chat-runner.ts、不复用本模块。
 * 本模块仅处理 task.mode === "task" 的 feature task。
 *
 * # V0.9.x 拆分（代码健康度重构、纯搬家零逻辑变更）
 *
 * 本文件只留「编排」：advance / restart / ack / finalize / reopen + internalStartAgent。
 * 其余切面拆到同目录四个模块（依赖方向单向、无环）：
 *   - task-stream.ts：流事件协议 + publish/subscribe + 进程全局状态 + writeEventAndPublish
 *   - task-prompts.ts：super-prompt 拼装 + [NEXT_ACTION] directive 构造（纯函数）
 *   - action-gates.ts：action 准入门槛 + ship 预检 + build 分支规划（纯函数）
 *   - sdk-message-handler.ts：SDKMessage → 事件流翻译器
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { Agent } from "@cursor/sdk";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import { dataRoot } from "./data-root";

import {
  appendAction,
  finalizeStaleAndIdleLocked,
  getTask,
  isCurrentRunningAction,
  patchAction,
  patchActionIfOwner,
  readTaskRepoStatusFresh,
  refreshRepoBranches,
  clearTaskSessionAgentIdIf,
  setFeishuTesterUserKeys,
  upsertGitBranch,
  upsertMRWithActionSideEffect,
  setTaskRepoStatus,
  setTaskRunStatus,
  setTaskAwaitingIfIdle,
  setTaskRunStatusIfRunOwner,
  patchActionAndRunStatusIfOpFresh,
} from "./task-fs";
import {
  releaseSideEffect,
  tryClaimSideEffect,
  waitAndClaimPostCheck,
  type ClaimHandle,
} from "./action-side-effects";
import { getActionsDir, getEventsLogPath, getTaskWorkspaceDir } from "./task-fs-core";
import {
  runActionCheck,
  captureActionStartBaseline,
  captureReadonlyRepoBaselines,
} from "./action-checks";
import { isRetryableRunError, summarizeRunFailure } from "./sdk-error";
import { createRunPerfTracker } from "./run-perf";
import {
  composeOnDelta,
  createShellOutputDeltaPublisher,
} from "./shell-output-bridge";
import { getChatMcpUrl } from "./chat-mcp";
import {
  buildAgentMessage,
  CALLER_MISMATCH_ERROR,
  cancelPending,
  cancelPendingIf,
  getPendingAsk,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
  unsetChatAwaitingNotifierIf,
  unsetChatTaskActionHandlerIf,
  type AwaitingNotifier,
  type ChatTaskActionHandler,
} from "./chat-pending";
import { createMR, getMRMergeStatus, closeOpenMR } from "./gitlab-client";
import { validateSubmitMr } from "./submit-mr-guard";
import { cleanupFeHooksJson } from "./cleanup-fe-hooks";
import { assertNoUpdatePendingRestart } from "./update-pending";
import { reapTaskOrphans } from "./kill-orphans";
import {
  stopPreviewsForTask,
} from "./preview-manager";
import {
  ensureTaskWorktrees,
  getTaskCwd,
  getTaskWorkRepoPaths,
  isWorktreeTask,
  removeTaskWorktrees,
  resolveOriginalRepoPath,
  WorktreeLeaseLostError,
} from "./task-worktrees";
import { loadSkills, type SkillEntry } from "./skills-loader";
import {
  resolveTaskMcpServers,
} from "./cursor-config";
import { resolveEffectiveGitHost } from "./gitlab-host";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { filterHealthyMcp, invalidateMcpProbeCache } from "./mcp-probe";
import { getCustomAction } from "./custom-action-fs";
import { setTaskSessionAgentId } from "./task-fs";
import {
  agentSessions,
  allocTaskRunInstanceId,
  beginTaskStarting,
  claimTaskOp,
  endTaskStarting,
  forceClearStaleRunnerState,
  forkPendingTasks,
  getTaskOpGeneration,
  getResourceJoinTimeoutMs,
  acquireTerminalCleanup,
  getTerminalCleanupPhase,
  hasResourceJobs,
  hasTerminalCleanup,
  invalidateTerminalCleanupForReopen,
  isTaskOpCurrent,
  isTaskStarting,
  isTerminalCleanupHandleValid,
  isWorkspaceQuarantined,
  markTerminalCleanupExecuting,
  markWorkspaceQuarantined,
  pendingStopRequests,
  publish,
  publishIfCurrent,
  releaseTaskOpIf,
  releaseTerminalCleanup,
  revokeResourceJobs,
  revokeTaskOps,
  waitUntilResourceJobsCleared,
  runningChecks,
  runningTasks,
  snapshotTaskOp,
  waitForTaskToStop,
  writeEventAndPublish,
  writeOwnedEventAndPublish,
  truncate,
  stringifyMeta,
  type AgentSessionRecord,
  type RunningCheck,
  type TaskOpHandle,
} from "./task-stream";
import {
  beginChatLifecycle,
  endChatLifecycle,
  getChatLifecycle,
} from "./chat-gate";
import { failpoint } from "./failpoints";
import {
  buildBatchDirective,
  buildGitlabAccessDirective,
  buildNextActionDirective,
  buildPlanReplanDirective,
  buildResumeActionInstruction,
  buildReviewScopeDirective,
  buildSuperPrompt,
  buildTaskUpdateHint,
  captureTaskFieldsSnapshot,
  loadActionPrompt,
} from "./task-prompts";
import { resolveUserIdentityForPrompt } from "./meegle-cli";
import {
  checkActionPrerequisites,
  planBranchesForBuild,
} from "./action-gates";
import {
  handleSdkMessage,
  type AssistantBufferCtx,
} from "./sdk-message-handler";
import type {
  ActionRecord,
  ActionType,
  DevPushMode,
  RepoStatus,
  ReplanMode,
  Task,
} from "@/lib/types";
import {
  ACTION_FRESH_AGENT_DEFAULT,
  MCP_HEALTH_LABEL,
} from "@/lib/types";
import {
  actionDisplayLabel,
  mrTargetBranchOf,
} from "@/lib/task-display";
import { supersedePendingAsks } from "./ask-supersede";

/**
 * V1：在途请求是否已因 stop/DELETE/finalize 作废。
 * gen 不匹配 = 取消方已 revoke（即使 lifecycle 已释放）；lifecycle 非空 = 取消进行中。
 * export 供单测钉扎 ABA / deferred 时序。路由准入仍用 gen 快照比对。
 */
export const isTaskOpStale = (taskId: string, opGen: number): boolean =>
  getTaskOpGeneration(taskId) !== opGen || getChatLifecycle(taskId) !== null;

/**
 * V12 唯一 owner 判定入口：op 仍是当前 + lifecycle 无 stop/DELETE 在飞。
 * 全文件所有共享状态写门控只允许经由它（可加盘上结构条件、不可再加别的维度子集）。
 */
const isOpOwner = (h: TaskOpHandle): boolean =>
  isTaskOpCurrent(h) && getChatLifecycle(h.taskId) === null;

/**
 * 对齐 chat-runner 的 SendChatMessageResult——调用方必须区分
 * 「本请求已被 stop 作废」与「无会话 / send 失败」，不得把 stale 当 false 去 fallback。
 */
export type SendTaskSessionResult =
  | "sent"
  | "stale"
  | "no_session"
  | "send_failed";

/** 路由文案单一来源（question / ask-reply 409） */
export const TASK_OP_STALE_HTTP_MESSAGE = "正在停止/任务已变更、请重发";

/**
 * advance / resume 在关键 await 后复查——stale 方**只抛错让位**，不再补偿写
 * cancelled/idle（旧补偿会误伤 stop 后同 actionId 的后继 B）。
 * 终态收尾由 stop/revoke owner 在锁内重读负责。
 */
const abortIfTaskOpStale = async (
  taskId: string,
  opGen: number,
): Promise<void> => {
  if (!isTaskOpStale(taskId, opGen)) return;
  const life = getChatLifecycle(taskId);
  if (life === "deleting") throw new Error("任务正在删除");
  if (life === "stopping") throw new Error("正在停止、请稍后再试");
  if (life === "finalizing") throw new Error("任务正在终结、请稍后再试");
  throw new Error("任务已被停止/删除、本次推进中止");
};

/**
 * 终态 repoStatus 拒推进——用盘上 fresh 值，
 * 不吃 hydrate 前陈旧 developing 快照（action-gates 无此闸、core 入口硬拦）。
 */
const assertTaskNotTerminalForAdvance = async (taskId: string): Promise<void> => {
  const repoStatus = await readTaskRepoStatusFresh(taskId);
  if (repoStatus === "merged") {
    throw new Error("任务已合入、不能再推进");
  }
  if (repoStatus === "abandoned") {
    throw new Error("任务已放弃、不能再推进");
  }
};

/**
 * 启动意图上下文——inner 在 claim / append 后回填，导出入口的 catch 据此收尾。
 * claim 之后、internalStartAgent handoff 之前的任何 await 抛错（appendAction / baseline /
 * worktree / 分支 / supersede / workspace / MCP …）都会走 finalizeFailedStartIntent；
 * handoff 之后（fire-and-forget IIFE）的失败由 handleRunFailure / consume finally 负责。
 */
interface StartIntentCtx {
  /** V12：claim 拿到的 owner handle；贯穿失败收尾 */
  opHandle?: TaskOpHandle;
  actionId?: string;
}

/**
 * 未完成 handoff 的启动意图失败收尾——
 * - 仍是完整 owner（isOpOwner）且已有绑定 action → 条件事务把
 *   action+task 收成 error（结构条件：currentActionId 仍指向自己、action 仍 running），
 *   不留「盘上 running、实际无 owner」的僵尸；
 * - 已被更晚 owner 覆盖 / stop 已接管 → 不写任何共享状态；
 * - releaseTaskOpIf 匹配才清（防误删后继的号）。
 * 错误事件不在这里写——路由层 catch 已负责给用户报错，避免双报。
 */
const finalizeFailedStartIntent = async (
  taskId: string,
  ctx: StartIntentCtx,
): Promise<void> => {
  const handle = ctx.opHandle;
  // 还没 claim 就抛（准入 / auto-approve 段）——没有接管副作用要收
  if (!handle) return;
  try {
    // 唯一组合判定——op 仍 current + 无 lifecycle
    const isOwner = (): boolean => isOpOwner(handle);
    if (isOwner() && ctx.actionId) {
      const updated = await patchActionAndRunStatusIfOpFresh(
        taskId,
        ctx.actionId,
        "error",
        "error",
        isOwner,
        { currentActionId: ctx.actionId, actionStatus: "running" },
      );
      if (updated) publish(taskId, { kind: "task", task: updated });
    }
  } catch {
    /* 任务目录可能已被 DELETE——尽力收尾 */
  }
  releaseTaskOpIf(handle);
};

/**
 * V2：per-task send 串行化（check-and-chain 同步入队）。
 * 第二个并发 send 排在第一个之后，再自己 waitForRunToDrain——绝不能「第二个直接返 false」，
 * 否则 advance 的 reuse 路径会误判会话失效走 force-new，误杀第一个正在用的会话。
 * export 供单测钉扎队列契约。
 */
interface TaskSendQueueState {
  tails: Map<string, Promise<unknown>>;
}
const TASK_SEND_QUEUE_KEY = "__flowshipTaskSendQueueV1__";
const getTaskSendQueue = (): TaskSendQueueState => {
  const g = globalThis as unknown as Record<
    string,
    TaskSendQueueState | undefined
  >;
  if (!g[TASK_SEND_QUEUE_KEY]) {
    g[TASK_SEND_QUEUE_KEY] = { tails: new Map() };
  }
  return g[TASK_SEND_QUEUE_KEY]!;
};

export const runWithTaskSendSerial = <T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const map = getTaskSendQueue().tails;
  const prev = map.get(taskId) ?? Promise.resolve();
  // 前一个失败也要继续跑自己（语义：串行，不是「前任失败则全体取消」）
  const mine = prev.catch(() => {}).then(() => fn());
  const stored = mine.catch(() => {});
  map.set(taskId, stored);
  return mine.finally(() => {
    if (map.get(taskId) === stored) map.delete(taskId);
  });
};

// ----------------- 配置 -----------------

// task 不主动超时（用户随时可能 24h 后才 ack）
const TASK_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-mcp 在 Agent.mcpServers 里的注册名（agent prompt 里得点明、跟 V0.5 沿用）
const TASK_TOOL_MCP_NAME = "flowshipChat";

/** 对外保持 task-runner 原路径可 import（实现在 ask-supersede.ts） */
export { supersedePendingAsks };

// ----------------- 公开 query API -----------------

// SDK Agent 实例类型（AgentSessionRecord 里存的是结构化最小面、runner 内部用这个收窄）
type AgentInstance = Awaited<ReturnType<typeof Agent.create>>;
type SessionRun = Awaited<ReturnType<AgentInstance["send"]>>;

// V0.11.1：续会话 / resume 需要的凭据（ack / ask-reply 路由随 bootArgs 带来、advance 本来就有）
export interface SessionCreds {
  apiKey?: string;
  // resume 后的 send 必须有显式 model（恢复的本地 agent 不保留 model、实测踩过）；
  // 服务端优先用 task 自己记的模型（最近 action 的 agentModel）、这里是兜底
  model?: ModelSelection;
  // PAT 仍来自 settings；host 不进凭据——buildSessionBridges 按 task.repoPaths 现推
  gitToken?: string;
}

/**
 * V0.11：关掉某 task 的跨 run agent 会话（agent close + 注销 notifier/handler + 清孤儿进程）。
 * agentId 传了就只在「当前会话确实是它」时才关（异步收尾路径防误关新会话）、不传 = 关当前的。
 *
 * `expectedSessionInstanceId` 传了则必须与 session.instanceId 精确匹配才关——
 * Agent.resume 恢复同一持久化 agentId 时，旧 A 仅靠 agentId 会误关后继 B 的新内存实例。
 *
 * 契约（fail-closed）：
 * - `expectedSessionInstanceId` 是精确实例门禁；异步旧 owner 拿不到精确实例号时必须
 *   no-op / 只关本地 agent 对象，绝不能传 `undefined` 退化成「按 agentId 关当前」。
 * - `undefined` 仅限用户主动关「当前会话」的同步调用方（cancelTaskRun / force-new 等）。
 * - 内存 session 已不存在、但调用方传了 `expectedSessionInstanceId` → 期望实例已被
 *   接管/清理，锚点归当前 owner，不得清持久化 `sessionAgentId`。
 *
 * @param opts.keepPersisted true = 保留落盘的 sessionAgentId（空闲回收用——下次操作 Agent.resume
 *   接回来）；缺省 false = 连持久化锚点一起清（停止 / 终结 / 报错 / 换新 agent 是真结束）
 * @returns 是否真的关了一个会话
 */
export const closeTaskSession = (
  taskId: string,
  agentId?: string,
  opts: {
    reap?: boolean;
    keepPersisted?: boolean;
    /** 会话内存实例号；传了则精确匹配才关（fail-closed） */
    expectedSessionInstanceId?: number;
  } = {},
): boolean => {
  const session = agentSessions.get(taskId);
  if (!session) {
    // 带了精确实例号却找不到内存会话 → 已被接管/清理，锚点归当前 owner
    if (opts.expectedSessionInstanceId !== undefined) {
      return false;
    }
    // 不带 expected = 调用方语义是「关当前 / 真结束」→ 持久化锚点也要清
    if (!opts.keepPersisted) void setTaskSessionAgentId(taskId, undefined);
    return false;
  }
  if (agentId && session.agentId !== agentId) return false;
  // resume 同 agentId 时只能靠 instanceId 区分新旧内存实例
  if (
    opts.expectedSessionInstanceId !== undefined &&
    session.instanceId !== opts.expectedSessionInstanceId
  ) {
    return false;
  }
  agentSessions.delete(taskId);
  // 会话是当前的 → 注册表里的 notifier / handler 必属于它、无条件注销安全
  setChatAwaitingNotifier(taskId, null);
  setChatTaskActionHandler(taskId, null);
  try {
    session.agent.close();
  } catch {
    /* noop */
  }
  if (!opts.keepPersisted) void setTaskSessionAgentId(taskId, undefined);
  // 清孤儿进程（要 task.repoPaths、异步读、fire-and-forget）。
  // 换新 agent（fork）场景传 reap:false——新 agent 马上在同一 worktree 拉 shell、
  // reap 的 2.5s 二次扫会误杀（V0.6.8 老坑、语义沿用）
  if (opts.reap !== false) {
    void getTask(taskId)
      .then((t) => {
        if (t) reapTaskOrphans(getTaskWorkRepoPaths(t));
      })
      .catch(() => {});
  }
  return true;
};

// ----------------- V0.11.1：会话空闲回收（省内存 / 进程数、resume 兜恢复） -----------------
//
// 每个未终结任务的 agent 子进程会随会话常驻；空闲超 TTL 自动 close（keepPersisted——
// sessionAgentId 还在、用户下次操作 Agent.resume 无缝接回、体感无差）。
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SESSION_SWEEPER_KEY = "__flowshipSessionSweeperV1__";
{
  const g = globalThis as unknown as Record<string, NodeJS.Timeout | undefined>;
  if (!g[SESSION_SWEEPER_KEY]) {
    g[SESSION_SWEEPER_KEY] = setInterval(() => {
      const now = Date.now();
      for (const [taskId, s] of agentSessions) {
        if (runningTasks.has(taskId)) continue; // run 在跑不算空闲
        if (now - s.lastActiveAt > SESSION_IDLE_TTL_MS) {
          console.log(
            `[task-runner] 会话空闲回收 task=${taskId} agentId=${s.agentId}（闲置 ${Math.round((now - s.lastActiveAt) / 60000)} 分钟、可 resume 接回）`,
          );
          closeTaskSession(taskId, s.agentId, {
            reap: false,
            keepPersisted: true,
            expectedSessionInstanceId: s.instanceId,
          });
        }
      }
    }, SESSION_SWEEP_INTERVAL_MS);
    // 不阻止进程退出
    g[SESSION_SWEEPER_KEY]?.unref?.();
  }
}

/**
 * 停止 task：取消活 run（如有）+ 关会话。
 * 启动窗口（runningTasks 尚未 set）点停止时记入 pendingStopRequests，
 * 由 internalStartAgent / consumeSessionRun 在 create/send 后自裁——否则
 * closeTaskSession 杀不掉飞行中的 send，agent 仍会注册并继续跑。
 * @returns 是否有活的 run / 会话被停掉（pending 标记不计入、语义不变）
 */
export const cancelTaskRun = (taskId: string): boolean => {
  const rec = runningTasks.get(taskId);
  if (rec) {
    rec.cancel();
  } else {
    // 无活 run = 可能在 Agent.create→runningTasks.set 窗口；记标记让启动链消费
    pendingStopRequests.add(taskId);
  }
  const closed = closeTaskSession(taskId);
  return !!rec || closed;
};

/**
 * V0.8.18：后台跑某 action 的后置 deterministic check（异步、不阻塞调用方）。
 *
 * # 为什么后台跑（线上踩过）
 * check 若在 awaitingNotifier 里被 `submit_work` MCP 工具**同步 await**、工具就要阻塞到
 * check 跑完才返回、慢了会撞 Cursor SDK ~60s 工具超时 → agent 收到「超时」后困惑乱来。
 * 改成：notifier 立即返回、check 在这里后台跑、跑完再落结果 + 切 awaiting_ack + 发「产出完成」事件。
 * （交付诚实性检查多为 artifact 读文件 + git status hash、通常秒级；
 *   review 多仓 git 指纹仍可能上秒、后台架构保留。）
 *
 * # 去重 + 取消（消灭重复跑 + 状态交错）
 * 一个 task 同时只允许一个在跑的 check（runningChecks）。新一轮交卷（如按反馈改完再 submit_work）会
 * abort 旧的、用最新代码重跑。停止 / 推进新 action 调 abortRunningCheck。check 跑完前判「自己是否仍是
 * 当前 check + action 是否仍在 running」——被顶替 / abort / action 已 cancelled → 丢弃结果、不写状态不发事件
 * （否则会出现「旧 action 的 check 跑完后在新 action 运行期间冒出『产出完成』事件」的交错、线上踩过）。
 */
/**
 * 后置 check 独立租约——不再借用会在 consume finally 释放的 run opHandle。
 * 存活凭据三件：① runningChecks 仍是 self；② 启动时快照的 opGen 未变（stop/DELETE revoke）；
 * ③ lifecycle === null。落状态仍走条件事务（awaiting_ack + awaiting_user + 结构条件）。
 */
const runActionPostCheck = (
  taskId: string,
  actionId: string,
  artifactPath: string | undefined,
  /** 本轮 waitAndClaimPostCheck 拿到的唯一 handle；各出口只 release 本 handle */
  claimHandle: ClaimHandle,
): void => {
  // 顶替：同 task 已有在跑的 check（agent 反复 wait、或换了 action）→ abort 旧的、本轮用最新代码重跑
  const prev = runningChecks.get(taskId);
  prev?.controller.abort();
  // 顶替不同 action 时按旧 entry.claimHandle 精确 release；同 action 重交卷时
  // waitAndClaimPostCheck 已换 token 并摘掉旧 runningChecks，此处 prev 通常已空
  if (prev && prev.actionId !== actionId && prev.claimHandle) {
    releaseSideEffect(prev.claimHandle);
  }
  if (prev) {
    runningChecks.delete(taskId);
  }

  const controller = new AbortController();
  // ClaimHandle 挂 RunningCheck 同 global entry（不再 module-local companion Map）
  const self: RunningCheck = { actionId, controller, claimHandle };
  runningChecks.set(taskId, self);
  // 启动时快照 gen——resume/advance 会 abortRunningCheck；stop/DELETE 会 revoke bump gen
  const checkGen = getTaskOpGeneration(taskId);

  /**
   * 僵尸修复：每个失败/收尾出口都要摘掉自己（带身份校验）。
   * 真正摘掉自己时按本轮 claimHandle release（旧 claimId 删不掉新 token）。
   */
  const dropSelf = (): void => {
    if (runningChecks.get(taskId) !== self) return;
    runningChecks.delete(taskId);
    releaseSideEffect(claimHandle);
  };

  void (async () => {
    // check 句柄身份：被新一轮 check 顶替 / 被 abort（停止 / 推进）→ 不该写状态
    const stillCheckOwner = () =>
      !controller.signal.aborted && runningChecks.get(taskId) === self;
    // 三件凭据（不借 run opHandle）
    const stillOwner = () =>
      stillCheckOwner() &&
      getTaskOpGeneration(taskId) === checkGen &&
      getChatLifecycle(taskId) === null;

    let postCheck: ActionRecord["postCheck"] | undefined;
    try {
      const fresh = await getTask(taskId);
      const targetAction = fresh?.actions.find((a) => a.id === actionId);
      if (fresh && targetAction) {
        const result = await runActionCheck(fresh, targetAction);
        postCheck = { passed: result.passed, details: result.details };
        console.log(
          `[task-runner] runActionPostCheck task=${taskId} action=${actionId} passed=${result.passed} details=${result.details.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(
        `[task-runner] runActionPostCheck 异常 task=${taskId} action=${actionId}：`,
        err,
      );
    }

    // 被取消 / 顶替 / gen 变 / lifecycle → 丢弃结果；必须 dropSelf（旧实现此处漏摘 → 永久僵尸）
    // ⚠️ 成功路径仍挂到落完状态才摘——让落状态前的 await 能被 abortRunningCheck 接住。
    if (!stillOwner()) {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 结果作废（已 abort / 被顶替 / gen 变）`,
      );
      dropSelf();
      return;
    }

    // 再确认 action 仍在等 check（没被 stop 标 cancelled / 没被推进改状态）
    const after = await getTask(taskId);
    // getTask 这个 await 期间可能被停止 / 推进 abort（杀子进程 + 标 cancelled）→ 落状态前再查一次 owner
    if (!stillOwner()) {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 结果作废（落状态前被 abort / 顶替）`,
      );
      dropSelf();
      return;
    }
    const a0 = after?.actions.find((a) => a.id === actionId);
    if (!a0 || a0.status !== "running") {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 已非 running（${a0?.status ?? "缺失"}）、跳过落 awaiting_ack`,
      );
      dropSelf();
      return;
    }

    // 两段裸写合一前插 failpoint——矩阵在此注入 stop；
    // 随后条件事务锁内复查 owner，拒绝 cancelled→awaiting_ack / idle→awaiting_user。
    await failpoint("postcheck.betweenWrites");
    if (!stillOwner()) {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 结果作废（failpoint 后失主）`,
      );
      dropSelf();
      return;
    }
    const patched = await patchActionAndRunStatusIfOpFresh(
      taskId,
      actionId,
      "awaiting_ack",
      "awaiting_user",
      () => stillOwner(),
      { currentActionId: actionId, actionStatus: "running" },
      postCheck ? { postCheck } : undefined,
    );
    if (patched) {
      publish(taskId, { kind: "task", task: patched });
      const a = patched.actions.find((x) => x.id === actionId);
      if (a) publish(taskId, { kind: "action", action: a });
      // post-check 事件写带 check 租约
      await writeOwnedEventAndPublish(
        taskId,
        () => stillOwner(),
        {
          kind: "info",
          actionId,
          text: `Action 产出完成、等待用户 ack${
            artifactPath ? `（artifact=${artifactPath}）` : ""
          }`,
          meta: {
            artifactPath,
            // 留个标志位给将来 UI 调试面板用、文本里不展示
            postCheckPassed: postCheck?.passed,
            // 里程碑标记：UI 事件流默认展开（action 产出完成等 ack、用户要看 artifact 决定 approve / revise）
            awaitingAck: true,
          },
        },
    );
    }
    // 全部落完、摘除自己；带身份校验：万一落状态期间被新一轮 wait 顶替、别误删后来者
    dropSelf();
  })().catch((err) => {
    // 兜底：落状态那段万一抛、别变成 unhandledRejection
    console.error(
      `[task-runner] runActionPostCheck 未捕获异常 task=${taskId} action=${actionId}：`,
      err,
    );
    dropSelf();
  });
};

/**
 * V0.8.18：取消某 task 正在后台跑的后置 check（停止 / 推进新 action 时调）。
 * abort 让 check 结果作废（不写 awaiting_ack、不发「产出完成」事件）。
 */
export const abortRunningCheck = (taskId: string): void => {
  const cur = runningChecks.get(taskId);
  if (!cur) return;
  cur.controller.abort();
  runningChecks.delete(taskId);
  // handle 与 check 同条目——跨 route/HMR 模块实例 abort 也能精确 release，防 claim 泄漏
  if (cur.claimHandle) releaseSideEffect(cur.claimHandle);
  console.log(
    `[task-runner] abortRunningCheck task=${taskId} action=${cur.actionId}`,
  );
};

// ----------------- 公开 mutation API -----------------

/**
 * V0.6 主推进入口
 *
 * 行为分支：
 *  1. 已有 running entry 在 chat-mcp pendingMap（agent 在待命态 / 等 ack）→ submitNextAction 续接
 *  2. 没 entry（首次启动 / agent 已退出 / 用户选 forceNewAgent）→ Agent.create + 启 Run
 *
 * 调用方应保证：
 *  - task 已 hydrate（getTask 拿到非 null）
 *  - settings.apiKey / model 已校验
 *（MCP 不再由调用方传：runner 自己读全局 ~/.cursor/mcp.json + 按 task.disabledMcpServers 过滤）
 */
export interface AdvanceTaskInput {
  task: Task;
  actionType: ActionType;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  apiKey: string;
  model: ModelSelection;
  // V0.6.27 语义反转：默认每 action 起新 Agent（context 截断治跑偏）、勾「续用当前 agent」才续接。
  // true = 续用内存里活着的 agent entry（续接 [NEXT_ACTION]、省 send 配额）；
  // 注：ACTION_FRESH_AGENT_DEFAULT 里 true 的 action（review）勾了续用也强起 fresh。
  reuseAgent?: boolean;
  // V0.6.1 ship action 用：GitLab PAT（来自 settings.gitToken、agent 启动时快照）
  // Host 不由调用方传——一律 resolveEffectiveGitHost(task.repoPaths) 现推
  gitToken?: string;
  // V0.6.23：build 分批——本次做哪些批次（推进 dialog 勾选、仅 build、空=自由改动不计进度）
  requestedBatchIds?: string[];
  // V0.x：联调推送方式（仅 dev、推进 dialog 选）——direct 直推 / mr 提 PR
  devPushMode?: DevPushMode;
  // V0.8.x：plan 重跑时如何合并批次（append=补充需求、rebuild=重建后续）
  replanMode?: ReplanMode;
  // V0.x A 方案：client 随推进带来的设置页最新分支配置（per-repo、只含设置页找得到 + 非空的仓）。
  //   advanceTask 起 agent 注入前调 refreshRepoBranches 刷新 task 快照——设置页改了、老 task 下次推进就生效。
  //   只覆盖传来的仓、没传的保留原快照（防误清）。不含 feature 分支（git 已建、必须固化）。
  repoBaseBranches?: Record<string, string>;
  repoTestBranches?: Record<string, string>;
  repoDevBranches?: Record<string, string>;
  // V0.9：自定义 action 指向的定义 id（仅 actionType="custom" 传）
  customActionId?: string;
  /**
   * 路由入场时同步捕获的 admission token。
   * 缺省则 advanceTask 导出入口在进串行队列前同步取。
   */
  opGen?: number;
}


/**
 * 收尾 task 里所有「卡在非终态」（running / awaiting_ack）的 action（V0.6.12）
 *
 * 全表扫语义**只保留给 stop/DELETE/finalize owner**（finalizeTask、advance
 * force-new 显式排除后继 actionId）。consumeSessionRun / 启动链收尾不得再调本函数——
 * 前驱 cancelled 时全表扫会把后继 B 刚 append 的 running action 一并 cancelled。
 *
 * 曾靠全表扫兜漏的合法场景：force-new 时旧 agent 可能留下多个残留非终态 action
 * （单 Run 多 action 时代）。advance force-new 仍用本函数 + exceptActionId 排除新 action；
 * 普通 cancel/error 改为 {@link finalizeOwnAction} 只 patch 本 run 绑定的那一个。
 *
 * @param status 收尾成的终态：agent 异常退出 → error；用户主动停 / 换 agent / abandon → cancelled
 * @param exceptActionId 排除某个 action（force-new-agent 时刚 appendAction 的新 action 还要继续跑、别误伤）
 */
const finalizeStaleActions = async (
  taskId: string,
  status: "error" | "cancelled",
  exceptActionId?: string,
): Promise<void> => {
  const fresh = await getTask(taskId);
  if (!fresh) return;
  const stale = fresh.actions.filter(
    (a) =>
      a.id !== exceptActionId &&
      (a.status === "running" || a.status === "awaiting_ack"),
  );
  for (const a of stale) {
    await patchAction(taskId, a.id, { status });
  }
};

/**
 * 前驱收尾只碰自己绑定的 action（errorActionId / action.id）。
 * 无绑定 action（one-shot questionRun）→ 不碰任何 action。
 */
const finalizeOwnAction = async (
  taskId: string,
  actionId: string | undefined,
  status: "error" | "cancelled",
): Promise<void> => {
  if (!actionId) return;
  await patchAction(taskId, actionId, { status });
};

// ----------------- 同一 task 的 advanceTask 串行化 -----------------
//
// advanceTask 全程 async（appendAction → 路由决策 → internalStartAgent 里 Agent.create/send）、
// 中间多个 await。并发触发（双击「推进」/ 多标签页同时推进同一 task）会踩两个坑：
//   ① appendAction 各追加一条 action（凭空多出一条）；
//   ② 决策时都读到「runningTasks 无 entry」→ 各起一个 agent、后 set 的把前一个覆盖 → 旧 agent 泄漏。
// 解法：按 taskId 把 advanceTask 串起来——同 task 排队执行、不同 task 互不阻塞。
//
// V0.6.27 改挂 globalThis：advance route 和 restart-action route 是不同 chunk、
// module-level Map 各持一份会让这道串行化跨 route 失效（同 runningTasks 的老坑）。
const ADVANCE_CHAINS_KEY = "__flowshipAdvanceChainsV1__";
const getAdvanceChains = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, Promise<void>> | undefined
  >;
  if (!g[ADVANCE_CHAINS_KEY]) g[ADVANCE_CHAINS_KEY] = new Map();
  return g[ADVANCE_CHAINS_KEY]!;
};
const advanceChains = getAdvanceChains();

const runAdvanceExclusive = async <T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = advanceChains.get(taskId) ?? Promise.resolve();
  // 本次的「门」：跑完后 release() 放行下一个排队者
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // 新链尾 = 等前驱跑完 + 等本次 gate 打开（吞前驱错、不让前一个失败把后续永久卡死）
  const tail = prev.then(() => gate);
  advanceChains.set(taskId, tail);
  await prev.catch(() => {}); // 排队：阻塞到上一个 advance 结束
  try {
    return await fn();
  } finally {
    release();
    // 我是当前链尾 → 删 key、避免 Map 随 task 数无限增长（identity 比对、有人排在后面则保留）
    if (advanceChains.get(taskId) === tail) {
      advanceChains.delete(taskId);
    }
  }
};

/**
 * v1.1.x 提速：建任务后立刻后台预热隔离工作区（fire-and-forget、/api/tasks POST 调）。
 * worktree 首建（fetch / worktree add / 依赖克隆）动辄十几秒到分钟级、原先全部串行
 * 算在第一次推进的「agent 启动时间」里——提前到建任务后台做、推进时 ensure 幂等秒过。
 *
 * - 走 runAdvanceExclusive 与「建完秒推进」串行：ensureTaskWorktrees 幂等但不可与自己并发
 *  （两边同时 `git worktree add` 会撞）；预热先拿到锁时推进排队等它、后拿到时 ensure 秒过。
 * - 失败只 log 不写 error 事件：推进入口的 ensure 是权威兜底、届时给出带处置建议的报错。
 */
export const prewarmTaskWorkspace = (taskId: string): void => {
  void runAdvanceExclusive(taskId, async () => {
    // 入场拍 observer + fresh 终态——finalize 后不得重建 worktree / 写 gitBranches
    const opHandle = snapshotTaskOp(taskId);
    // prewarm 全程登记 starting——finalize 的 5s join 轮询只等 startingTasks、
    // 不登记就 join 不到本预热；登记后 join 覆盖预热主窗口（lease 仍是权威闸）
    beginTaskStarting(taskId);
    try {
    const stillPrewarm = async (): Promise<boolean> => {
      if (!isTaskOpCurrent(opHandle) || getChatLifecycle(taskId) !== null) {
        return false;
      }
      const st = await readTaskRepoStatusFresh(taskId);
      return st !== null && st !== "merged" && st !== "abandoned";
    };
    // 同步 resource lease——传进 ensureTaskWorktrees 内部（fetch 后 / rm 前 / add 前后）
    const lease = (): boolean =>
      isTaskOpCurrent(opHandle) && getChatLifecycle(taskId) === null;
    if (!(await stillPrewarm())) return;
    const task = await getTask(taskId);
    if (!task || !isWorktreeTask(task)) return;
    if (!(await stillPrewarm())) return;
    try {
      // worktree add 前插桩 + 复查（finalize 期间/之后放弃预热）
      await failpoint("prewarm.beforeWorktreeAdd");
      if (!(await stillPrewarm())) return;

      // lease 进资源函数内部——失效抛 WorktreeLeaseLostError 让位（不吞）
      const ensured = await ensureTaskWorktrees(task, lease);

      // worktree add 返回后再复查——终态后不 upsert、不写 info
      if (!(await stillPrewarm())) return;

      // 同 advanceTaskInner：仅新仓 upsert gitBranches（老条目保留 baseBranch 历史值）
      // prewarm 的 upsert 也带 lease finalGuard——stillPrewarm 检查后
      // 的 await 期间 revoke/接管时提交点拒写
      const existingRepos = new Set(
        (task.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of ensured.infos) {
        if (!existingRepos.has(info.repoPath)) {
          await upsertGitBranch(task.id, info, lease);
        }
      }
      if (ensured.createdRepos.length > 0) {
        const cloneNote =
          ensured.clonedDeps.length > 0
            ? `；依赖目录已从原仓库秒级克隆（${ensured.clonedDeps
                .map(
                  (c) =>
                    `${c.repoPath.split("/").filter(Boolean).pop() ?? c.repoPath}: ${c.dirs.join(" + ")}`,
                )
                .join("、")}）`
            : "";
        // 事件写带 lease——失主不落盘
        await writeOwnedEventAndPublish(
          task.id,
          lease,
          {
            kind: "info",
            text: `已后台预热任务隔离工作区（git worktree）并检出任务分支：${ensured.createdRepos
              .map((p) => p.split("/").filter(Boolean).pop() ?? p)
              .join("、")}${cloneNote}——推进时无需再等待创建`,
          },
    );
      }
    } catch (err) {
      // lease 失效让位是预期路径（finalize/stop 接管）、静默即可
      if (err instanceof WorktreeLeaseLostError) {
        console.log(`[task-runner] task=${taskId} 预热让位（lease 失效）`);
        return;
      }
      console.warn(
        `[task-runner] task=${taskId} 后台预热 worktree 失败（推进时会重试并报具体原因）：`,
        err,
      );
    }
    } finally {
      // 与 beginTaskStarting 配对（任何出口都归零）
      endTaskStarting(taskId);
    }
  });
};

export const advanceTask = async (
  input: AdvanceTaskInput,
): Promise<{ action: ActionRecord }> => {
  // admission token 在进任何 promise chain（含 runAdvanceExclusive 排队）之前同步捕获——
  // 否则 A2 排队期间 stop bump，出队后才取会拍到新值、冒充 stop 后的新意图
  const opGen = input.opGen ?? getTaskOpGeneration(input.task.id);
  return runAdvanceExclusive(input.task.id, () =>
    advanceTaskInner({ ...input, opGen }),
  );
};

const advanceTaskInner = async (
  input: AdvanceTaskInput,
): Promise<{ action: ActionRecord }> => {
  // claim 之后、handoff 之前的任何 await 抛错都要收尾自己的启动意图
  // （已 append 的 action 不留僵尸 running、token 匹配才 release），否则
  // 「盘上 running、实际无 owner、token 无人释放」。
  const ctx: StartIntentCtx = {};
  try {
    return await advanceTaskCore(input, ctx);
  } catch (err) {
    await finalizeFailedStartIntent(input.task.id, ctx);
    throw err;
  }
};

const advanceTaskCore = async (
  input: AdvanceTaskInput,
  ctx: StartIntentCtx,
): Promise<{ action: ActionRecord }> => {
  const {
    actionType,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    apiKey,
    model,
    reuseAgent,
    gitToken,
    requestedBatchIds,
    devPushMode,
    replanMode,
    repoBaseBranches,
    repoTestBranches,
    repoDevBranches,
    customActionId,
  } = input;
  // task 用 let：去掉「通过」后、推进开头会隐式认可当前 awaiting_ack action、之后重读最新 task 供准入 / appendAction 用
  let task = input.task;
  // 由 advanceTask 导出入口传入（禁止在此自取——出队后取会踩）
  const opGen = input.opGen!;

  // V0.10.1：壳自更新就位但用户没重启 → 老进程起新 run 必挂死（shell 永久卡住）、入口硬拦
  await assertNoUpdatePendingRestart();

  // 自定义 action：提前读定义（拿 label 快照）。读不到不致命——
  //   loadActionPrompt 会兜底提示、appendAction 的 customLabel 留空。
  const customDef =
    actionType === "custom" && customActionId
      ? await getCustomAction(customActionId)
      : null;

  // V0.8.18：推进新 action 前、取消上一 action 可能还在后台跑的 check（结果对新 action 无意义、且防状态交错）
  abortRunningCheck(task.id);

  // V0.x A 方案：用 client 随推进带来的设置页最新分支配置刷新 task 分支快照。
  //   必须放在准入（checkActionPrerequisites 读 repoDevBranches）/ appendAction /
  //   agent 注入（renderRepoBranchSection 读 repoXxxBranches）之前——否则用的还是建 task 旧快照。
  //   只覆盖传来的仓、没传的保留（refreshRepoBranches 内 allowed + 非空过滤、防误清）。
  if (repoBaseBranches || repoTestBranches || repoDevBranches) {
    const refreshed = await refreshRepoBranches(task.id, {
      base: repoBaseBranches,
      test: repoTestBranches,
      dev: repoDevBranches,
    });
    if (refreshed) task = refreshed;
  }

  // V0.10：隔离工作区 task → 推进前确定性建 / 复用 worktree（幂等、已存在秒过）。
  //   分支检出由 runner 硬保证（替代 build checkout hint 的 prompt 软约束）；
  //   创建失败直接抛（带处置建议）、不带病起 agent。
  // 本段在 beginTaskStarting / claim 之前——靠 ensure 内 beginResourceJob
  // 登记；stop/DELETE join 已扩 hasResourceJobs，无需前移 starting 登记。
  if (isWorktreeTask(task)) {
    // advance 链的 resource lease（此处尚未 claim、用 admission gen + lifecycle；
    // lease 失效抛 WorktreeLeaseLostError → 转 stale、不得 upsert / 写事件）
    let ensured;
    try {
      ensured = await ensureTaskWorktrees(task, () => !isTaskOpStale(task.id, opGen));
    } catch (err) {
      // 让位不吞——显式终态，不继续 upsertGitBranch / info
      if (err instanceof WorktreeLeaseLostError) {
        throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
      }
      throw err;
    }
    // 仅新仓 upsert gitBranches（老条目保留 baseBranch 历史值、跟 build hint 老规则一致）
    // finalGuard = admission lease（失主拒写）
    const existingRepos = new Set((task.gitBranches ?? []).map((b) => b.repoPath));
    for (const info of ensured.infos) {
      if (!existingRepos.has(info.repoPath)) {
        await upsertGitBranch(
          task.id,
          info,
          () => !isTaskOpStale(task.id, opGen),
        );
      }
    }
    const cloneNote =
      ensured.clonedDeps.length > 0
        ? `依赖目录已从原仓库秒级克隆（${ensured.clonedDeps
            .map(
              (c) =>
                `${c.repoPath.split("/").filter(Boolean).pop() ?? c.repoPath}: ${c.dirs.join(" + ")}`,
            )
            .join("、")}）、不需要重新下载`
        : "";
    if (ensured.createdRepos.length > 0) {
      // owner 语境（advance 启动链、claim 前）——admission lease
      await writeOwnedEventAndPublish(
        task.id,
        () => !isTaskOpStale(task.id, opGen),
        {
          kind: "info",
          text: `已创建任务隔离工作区（git worktree）并检出任务分支：${ensured.createdRepos
            .map((p) => p.split("/").filter(Boolean).pop() ?? p)
            .join("、")}${cloneNote ? `；${cloneNote}` : ""}`,
        },
      );
    } else if (cloneNote) {
      // 复用已有 worktree 时补克隆（老 worktree 建于克隆功能上线前）也要让用户知道
      await writeOwnedEventAndPublish(
        task.id,
        () => !isTaskOpStale(task.id, opGen),
        { kind: "info", text: cloneNote },
      );
    }
    task = (await getTask(task.id)) ?? task;
  }

  // V0.6.27 默认反转：每 action 默认起新 agent（context 截断是治跑偏的根、artifact 是唯一接力棒）。
  // 用户勾「续用当前 agent」（reuseAgent）才续接——除了 ACTION_FRESH_AGENT_DEFAULT 里 true 的
  // action（review = 换人复审铁律）、勾了也压不掉。
  // 自定义 action 恒走内置默认（ACTION_FRESH_AGENT_DEFAULT.custom、定义里不再有 freshAgent 开关）
  const effectiveForceNewAgent =
    !reuseAgent || ACTION_FRESH_AGENT_DEFAULT[actionType];

  // V0.x：去掉手动「通过」按钮后、推进吸收认可——若当前 action 还在等 ack、推进时先隐式认可它。
  //   放在准入之前 + 认可后重读 task：下面 checkActionPrerequisites 看到的就是
  //   「认可后」状态（当前 action 已 completed）、原准入逻辑一行不用动。
  // V0.11：approve 纯服务端落状态（agent 不需要收信号）、续接 / force-new 同一条路径。
  // 锁内条件写——admission gen + lifecycle + 结构条件；stop 已 cancelled 则拒写、不落「已通过」。
  const pendingAck = task.actions.find(
    (a) => a.id === task.currentActionId && a.status === "awaiting_ack",
  );
  if (pendingAck) {
    const patched = await patchActionIfOwner(
      task.id,
      pendingAck.id,
      { status: "completed" },
      // 此时尚未 claim：用 admission gen + lifecycle 当 owner 门（与 isOpOwner 同形）
      () =>
        getTaskOpGeneration(task.id) === opGen &&
        getChatLifecycle(task.id) === null,
      { currentActionId: pendingAck.id, actionStatus: "awaiting_ack" },
    );
    if (patched) {
      publish(task.id, { kind: "task", task: patched });
      const a = patched.actions.find((x) => x.id === pendingAck.id);
      if (a) publish(task.id, { kind: "action", action: a });
      // owner 语境（advance 启动链、claim 前）——admission lease
      await writeOwnedEventAndPublish(
        task.id,
        () => !isTaskOpStale(task.id, opGen),
        {
          kind: "action_ack",
          actionId: pendingAck.id,
          text: `Action ${pendingAck.type} n=${pendingAck.n} 已通过（推进时自动认可）`,
          meta: { decision: "approve" },
        },
      );
    }
    // 条件失败（stop 已 cancelled / 并发处理）或成功：都重读最新 task 继续
    task = (await getTask(task.id)) ?? task;
  }

  // 终态 repoStatus 拒推进（须在准入前；盘上 fresh）
  await assertTaskNotTerminalForAdvance(task.id);

  // 1) 准入条件（V0.6 门槛 1）：host 按任务仓库 remote 现推（多实例不一致会 throw）
  const effectiveGitHost =
    (await resolveEffectiveGitHost(task.repoPaths)) ?? undefined;
  const pre = checkActionPrerequisites(task, actionType, {
    gitHost: effectiveGitHost,
    gitToken,
  });
  if (!pre.ok) {
    throw new Error(`准入条件不满足：${pre.reason}`);
  }

  // 2) appendAction：写一条新 ActionRecord、task.runStatus 自动转 running
  // 新推进 = 新意图：作废上一轮残留的停止请求，避免误杀本次启动。
  // V1：lifecycle 进行中或 gen 已 bump（stop 已完成）都不得继续 append。
  await abortIfTaskOpStale(task.id, opGen);
  // owner 在第一个接管副作用（appendAction 写 running）之前
  // 同步 claim——覆盖前任 = 换主，在飞旧启动链的中间检查点会发现失主让位。
  // claim 失败（admissionGen 已被 revoke）= stop 已 bump、语义同 abortIfTaskOpStale。
  // 的线性化前提「claimant 在 claim 之后必有过锁状态写」由紧随的 appendAction
  // （withTaskLock 内写 running）保证：即使前任的 commit rename 落在 claim 之后，
  // 本次 appendAction 的写也排在同一把锁之后覆盖它。
  const opHandle = claimTaskOp(task.id, opGen);
  if (!opHandle) throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
  ctx.opHandle = opHandle;
  await failpoint("advance.afterClaim");
  pendingStopRequests.delete(task.id);
  // P2：锁内 guard=isOpOwner——claim 后、拿锁前若 stop 已 revoke，
  // 拒写、不产生幽灵 action（与 stop 重读收尾互斥闭环，见 stop-task）。
  const created = await appendAction(
    task.id,
    {
      type: actionType,
      userInstruction,
      agentModel: model,
      // V0.6.23：仅 build 带批次选择（其它 action 不传、appendAction 内部空数组也归 undefined）
      requestedBatchIds: actionType === "build" ? requestedBatchIds : undefined,
      replanMode: actionType === "plan" ? replanMode : undefined,
      // V0.x：仅 dev 带推送方式（appendAction 内部也按 type 过滤）
      devPushMode: actionType === "dev" ? devPushMode : undefined,
      // V0.9：仅 custom 带定义 id + label 快照（appendAction 内部也按 type 过滤）
      customActionId: actionType === "custom" ? customActionId : undefined,
      customLabel: actionType === "custom" ? customDef?.label : undefined,
    },
    { guard: () => isOpOwner(opHandle) },
  );
  if (!created) {
    // guard 拒写 / task 不存在 → 统一按 stale 让位
    throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
  }
  const { task: taskAfterAppend, action } = created;
  // action 已落盘——此后任何抛错由 finalizeFailedStartIntent 收尾
  ctx.actionId = action.id;
  await failpoint("advance.afterAppend");
  publish(task.id, { kind: "task", task: taskAfterAppend });
  publish(task.id, { kind: "action", action });
  // V0.6.27：review / build 启动基线；只读仓基线所有 action 都采（后置检测兜底）
  // 采集失败 fail-open 不挡启动
  // V1：baseline / 分支 await 正是「已 append、尚未 startingTasks」的竞态窗——每段后复查
  if (actionType === "review" || actionType === "build") {
    const baseline = await captureActionStartBaseline(task, actionType);
    await abortIfTaskOpStale(task.id, opGen);
    if (baseline) {
      await patchAction(task.id, action.id, { startBaseline: baseline });
      action.startBaseline = baseline;
    }
  }
  {
    const readonlyBaseline = await captureReadonlyRepoBaselines(task);
    await abortIfTaskOpStale(task.id, opGen);
    if (readonlyBaseline) {
      await patchAction(task.id, action.id, { readonlyBaseline });
      action.readonlyBaseline = readonlyBaseline;
    }
  }
  // owner 语境（已 claim）——opHandle lease
  await writeOwnedEventAndPublish(
    task.id,
    () => isOpOwner(opHandle),
    {
    kind: "action_start",
    actionId: action.id,
    text: `开始 ${actionDisplayLabel(action)}（${action.type}）n=${action.n}${
      userInstruction.trim().length > 0 ? `\n用户指令：${truncate(userInstruction, 200)}` : ""
    }`,
    meta: { type: actionType, n: action.n, artifactPath: action.artifactPath },
    },
  );
  await abortIfTaskOpStale(task.id, opGen);

  // 3) branch checkout 挂接（仅 build action、V0.6.1 每次都 inject 多仓 idempotent hint）
  //    V0.10：隔离工作区 task 不注入——分支已由 runner 在 worktree 里确定性检出、
  //    agent 不需要（也不该）自己 checkout
  let branchCheckoutHint: string | undefined;
  if (actionType === "build" && !isWorktreeTask(taskAfterAppend)) {
    const planned = planBranchesForBuild(taskAfterAppend);
    if (planned) {
      // 仅新仓 upsert（已存在的保留 baseBranch 历史值、不覆盖）
      // 非 worktree build 的 upsert 同样带 admission lease finalGuard
      const existingRepos = new Set(
        (taskAfterAppend.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of planned.infos) {
        if (!existingRepos.has(info.repoPath)) {
          await upsertGitBranch(task.id, info, () => isOpOwner(opHandle));
        }
      }
      branchCheckoutHint = planned.promptHint;
    }
    await abortIfTaskOpStale(task.id, opGen);
  }

  // V0.6.23：分批指令——plan 拆了批次时注入 NEXT_ACTION（taskAfterAppend 含最新 plan 的 planBatches）
  // - build：拼「本次做哪批」（含本 build 的 requestedBatchIds）
  // - review：拼「当前进度 + 增量 / 集成建议」（纯派生、不需选批）
  const batchDirective =
    actionType === "build"
      ? buildBatchDirective(taskAfterAppend, requestedBatchIds)
      : actionType === "review"
        ? buildReviewScopeDirective(taskAfterAppend)
        : undefined;
  // V0.8.12 A：plan append 硬指令——已分批 task 追加需求时强制出新批次（基于真实批次状态）。
  // buildPlanReplanDirective 内部自己判 plan + replanMode、非 plan / 无 replanMode 返 undefined
  const replanDirective = buildPlanReplanDirective(action, taskAfterAppend);

  // 4) 决定路由（V0.11：续接 = 对存活会话 agent.send [NEXT_ACTION]、没会话 / force-new = 起新 agent；
  //    V0.11.1：内存会话丢了但有落盘锚点 → sendToTaskSession 内部 Agent.resume 接回）
  const existingSession = agentSessions.get(task.id);
  const activeRun = runningTasks.get(task.id);
  if (
    (existingSession || task.sessionAgentId) &&
    !activeRun &&
    !effectiveForceNewAgent
  ) {
    // V0.6.6 热更：agent 会话期间用户可能在详情页改了 role / title / feishuStoryUrl
    // diff 启动快照、有变才拼一段 [TASK_UPDATED] 注入；注入后把快照推进到当前值、避免下次重复告知同一变更
    //（resume 场景没有旧快照可 diff、跳过 hint——resume 后的快照即当前值）
    const taskUpdateHint = existingSession
      ? buildTaskUpdateHint(taskAfterAppend, existingSession.startSnapshot)
      : undefined;
    if (existingSession) {
      existingSession.startSnapshot = captureTaskFieldsSnapshot(taskAfterAppend);
    }
    // V0.6.27：续接载荷附本 action 的完整 playbook——super prompt 只注入了启动时那个
    // action 的指令、续接的新 action（哪怕同类型）以载荷这份为准
    const actionPlaybook = await loadActionPrompt(action, taskAfterAppend);
    await abortIfTaskOpStale(task.id, opGen);
    const sendResult = await sendToTaskSession(
      taskAfterAppend,
      buildAgentMessage({
        kind: "next_action",
        text: buildNextActionDirective({
          action,
          userInstruction,
          attachedImagePaths,
          attachedFilePaths,
          branchCheckoutHint,
          taskUpdateHint,
          batchDirective,
          replanDirective,
          actionPlaybook,
        }),
        nextActionId: action.id,
        nextActionType: action.type,
        nextN: action.n,
        nextArtifactPath: action.artifactPath ?? "",
        imagePaths: attachedImagePaths,
        attachmentPaths: attachedFilePaths,
      }),
      { errorActionId: action.id, creds: { apiKey, gitToken }, opGen },
    );
    // stale ≠ 无会话——绝不能降级 force-new（会再起一个 agent 覆盖后继）
    if (sendResult === "sent") {
      // 续接 run 的共享写由 consume 的 observer handle 门控；
      // owner 号立即释放——不许挂着违反 I4（owner 要么属活 op、要么 null）。
      releaseTaskOpIf(opHandle);
      return { action };
    }
    if (sendResult === "stale") {
      await abortIfTaskOpStale(task.id, opGen);
    }

    // no_session / send_failed → 降级 force-new
    console.warn(
      `[task-runner] advanceTask: task=${task.id} 会话续接失败（${sendResult}）、降级 force-new-agent`,
    );
  }

  // 5) 没会话 / forceNewAgent / 续接失败：起新 agent
  await abortIfTaskOpStale(task.id, opGen);
  if (activeRun) {
    forkPendingTasks.add(task.id);
    activeRun.cancel();
    const stopped = await waitForTaskToStop(task.id, 5000);
    if (!stopped) {
      console.warn(
        `[task-runner] advanceTask: task=${task.id} 旧 agent 没在 5s 内停、强清 runner state 继续`,
      );
      forceClearStaleRunnerState(task.id);
    }
    // 收尾被新 agent 取代的旧非终态 action（排除本次刚 appendAction 的新 action、否则误伤）
    await finalizeStaleActions(task.id, "cancelled", action.id);
  }
  // 旧会话（如有）关掉：新 agent 马上在同一 worktree 起 shell、不 reap（V0.6.8 误杀坑）
  closeTaskSession(task.id, undefined, { reap: false });
  // 起新 agent 跑新 action 前、作废上一个 agent 没答完的孤儿 ask（不清掉
  // 前端会弹失效的旧问题弹窗、用户答了必报错；严重时还把 runStatus 打回 error 死循环）。
  // 推进是「开新 action」语义、不续传旧问题（用户主动换方向 = 放弃旧断点）、只清孤儿、忽略返回值。
  cancelPending(task.id);
  await supersedePendingAsks(task.id, "推进新 action");
  await abortIfTaskOpStale(task.id, opGen);
  await failpoint("advance.beforeHandoff");
  await internalStartAgent({
    task: taskAfterAppend,
    action,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    branchCheckoutHint,
    apiKey,
    model,
    gitToken,
    batchDirective,
    replanDirective,
    opGen,
    opHandle,
  });

  return { action };
};

/**
 * V0.11.9「输入条唤醒当前 action」（原「重启当前阶段」按钮退役后的替身、用户拍板
 * 「底部输入条就能覆盖重启、别多一条 action 链」）：
 *
 * 场景：当前 action 停在 error / cancelled（会话接不回）、用户在输入条说话 →
 * 起新 agent **原地续同一个 action**（不 append 新 action）、用户消息进指令
 * （纯提问先答疑、指令按它执行、最后交卷）。question 路由的恢复分支调用。
 */
export interface ResumeCurrentActionInput {
  task: Task;
  userMessage: string;
  imagePaths?: string[];
  /** 用户随消息附的文件 / 目录绝对路径（v1.1.x 任务输入条也能附路径） */
  attachmentPaths?: string[];
  apiKey: string;
  /** 模型优先级：forceModel → action.agentModel → task.model → 这里的兜底（bootArgs.model） */
  fallbackModel: ModelSelection;
  /** 用户在输入条显式选的模型（V0.13.x：换模型唤醒、最高优先——用户意图就是换个模型继续干） */
  forceModel?: ModelSelection;
  gitToken?: string;
  /**
   * 路由入场时同步捕获的 admission token。
   * 缺省则导出入口在进串行队列前同步取。
   */
  opGen?: number;
}

export const resumeCurrentActionWithMessage = async (
  input: ResumeCurrentActionInput,
): Promise<void> => {
  // 同 advance——进 runAdvanceExclusive 排队前同步捕获 admission token
  const opGen = input.opGen ?? getTaskOpGeneration(input.task.id);
  return runAdvanceExclusive(input.task.id, () =>
    resumeCurrentActionInner({ ...input, opGen }),
  );
};

const resumeCurrentActionInner = async (
  input: ResumeCurrentActionInput,
): Promise<void> => {
  // 同 advance——claim 后、handoff 前抛错要收尾启动意图
  const ctx: StartIntentCtx = {};
  try {
    return await resumeCurrentActionCore(input, ctx);
  } catch (err) {
    await finalizeFailedStartIntent(input.task.id, ctx);
    throw err;
  }
};

const resumeCurrentActionCore = async (
  input: ResumeCurrentActionInput,
  ctx: StartIntentCtx,
): Promise<void> => {
  // 由导出入口传入（禁止出队后自取）
  const opGen = input.opGen!;
  await assertNoUpdatePendingRestart();
  abortRunningCheck(input.task.id);
  const fresh = await getTask(input.task.id);
  if (!fresh) throw new Error("task 不存在、无法唤醒当前 action");
  // 终态拒唤醒（盘上 fresh）
  await assertTaskNotTerminalForAdvance(fresh.id);

  const actionId = fresh.currentActionId;
  const action = fresh.actions.find((a) => a.id === actionId);
  if (!action) throw new Error("当前没有可唤醒的 action");

  // owner 必须在**第一个接管副作用之前**取得（同步、无 await）——
  // 下面马上要关旧会话 / 写 running；claim 太晚（旧实现在 create/send 串行段才领）
  // 会留下「本唤醒已接管改状态、owner 仍是前任」的长窗口：前任 create/send
  // 失败的 catch 仍认为自己是 owner、把共用 action/task 写成 error。
  // claim 覆盖前任 = 换主；handle 贯穿传给 internalStartAgent。
  const opHandle = claimTaskOp(fresh.id, opGen);
  if (!opHandle) throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
  ctx.opHandle = opHandle;
  await failpoint("resume.afterClaim");
  // resume 复用当前 action——claim 起它就归本意图收尾
  ctx.actionId = action.id;

  // 旧 run 残留（理论上没有、调用方已判）→ 停干净再起
  const existingRecord = runningTasks.get(fresh.id);
  if (existingRecord) {
    forkPendingTasks.add(fresh.id);
    existingRecord.cancel();
    const stopped = await waitForTaskToStop(fresh.id, 5000);
    if (!stopped) forceClearStaleRunnerState(fresh.id);
  }
  // 换新 agent、旧会话关掉（reap 下一行显式扫）
  closeTaskSession(fresh.id, undefined, { reap: false });
  cancelPending(fresh.id);
  // 只即时扫、跳过 2.5s 二次扫——新 agent 马上会在同仓拉 shell，延迟扫会误杀
  reapTaskOrphans(getTaskWorkRepoPaths(fresh), { delayedRescan: false });

  // 作废旧 agent 没答完的 ask（返回未答问题、新 agent 断点续传重问）
  const pendingQuestions = await supersedePendingAsks(fresh.id, "输入条唤醒当前 action");

  // 唤醒 = 新启动意图：作废残留停止标记（同 advanceTask appendAction）。
  // V1：lifecycle / gen bump 任一命中都不得继续。
  await abortIfTaskOpStale(fresh.id, opGen);
  pendingStopRequests.delete(fresh.id);

  await failpoint("resume.beforeStatusWrite");
  // 两段裸写合一——锁内条件事务复查 isOpOwner；返 null = 让位（不留 running 复活窗）
  const patchedTask = await patchActionAndRunStatusIfOpFresh(
    fresh.id,
    action.id,
    "running",
    "running",
    () => isOpOwner(opHandle),
    { currentActionId: action.id },
  );
  if (!patchedTask) {
    releaseTaskOpIf(opHandle);
    throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
  }
  const patchedAction =
    patchedTask.actions.find((a) => a.id === action.id) ?? action;
  publish(fresh.id, { kind: "task", task: patchedTask });
  publish(fresh.id, { kind: "action", action: patchedAction });
  let startTask = patchedTask;

  // owner 语境（resume 链已 claim）——opHandle lease
  await writeOwnedEventAndPublish(
    fresh.id,
    () => isOpOwner(opHandle),
    {
      kind: "info",
      actionId: action.id,
      text: `已唤醒当前 ${actionDisplayLabel(action)} 阶段（n=${action.n}）、新 agent 接手继续`,
      meta: { resumedActionId: action.id, actionType: action.type, n: action.n },
    },
  );
  await abortIfTaskOpStale(fresh.id, opGen);

  // 隔离工作区 task → 确保 worktree 在（可能被手删过）
  if (isWorktreeTask(startTask)) {
    // resume 链已 claim——resource lease 用 opHandle；让位不吞
    let ensured;
    try {
      ensured = await ensureTaskWorktrees(startTask, () => isOpOwner(opHandle));
    } catch (err) {
      if (err instanceof WorktreeLeaseLostError) {
        releaseTaskOpIf(opHandle);
        throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
      }
      throw err;
    }
    // resume 链 upsert 带 opHandle finalGuard
    const existingRepos = new Set(
      (startTask.gitBranches ?? []).map((b) => b.repoPath),
    );
    for (const info of ensured.infos) {
      if (!existingRepos.has(info.repoPath)) {
        await upsertGitBranch(fresh.id, info, () => isOpOwner(opHandle));
      }
    }
    startTask = (await getTask(fresh.id)) ?? startTask;
    await abortIfTaskOpStale(fresh.id, opGen);
  }

  let branchCheckoutHint: string | undefined;
  if (action.type === "build" && !isWorktreeTask(startTask)) {
    const planned = planBranchesForBuild(startTask);
    if (planned) {
      const existingRepos = new Set(
        (startTask.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of planned.infos) {
        if (!existingRepos.has(info.repoPath)) {
          // resume 的非 worktree build upsert 同样带 opHandle finalGuard
          await upsertGitBranch(fresh.id, info, () => isOpOwner(opHandle));
        }
      }
      branchCheckoutHint = planned.promptHint;
      startTask = (await getTask(fresh.id)) ?? startTask;
    }
    await abortIfTaskOpStale(fresh.id, opGen);
  }
  const startAction =
    startTask.actions.find((a) => a.id === action.id) ?? patchedAction;
  const batchDirective =
    startAction.type === "build"
      ? buildBatchDirective(startTask, startAction.requestedBatchIds)
      : startAction.type === "review"
        ? buildReviewScopeDirective(startTask)
        : undefined;

  // 模型：用户显式选的（forceModel）最优先——V0.13.x 修「换模型说话被锁进只读答疑」：
  // 换模型唤醒 = 用户想换个模型继续干活；没显式选才沿用该 action 当初的 agentModel
  //（唤醒是「接着干」、不该悄悄换模型）、再退 task.model、最后兜 bootArgs 默认
  const model =
    input.forceModel?.id?.trim()
      ? input.forceModel
      : startAction.agentModel?.id?.trim()
        ? startAction.agentModel
        : startTask.model?.id?.trim()
          ? startTask.model
          : input.fallbackModel;

  const replanDirective = buildPlanReplanDirective(startAction, startTask);

  await abortIfTaskOpStale(fresh.id, opGen);
  await internalStartAgent({
    task: startTask,
    action: startAction,
    userInstruction: buildResumeActionInstruction(
      startTask,
      startAction,
      pendingQuestions,
      input.userMessage,
      input.imagePaths,
      input.attachmentPaths,
    ),
    branchCheckoutHint,
    apiKey: input.apiKey,
    model,
    gitToken: input.gitToken,
    batchDirective,
    replanDirective,
    opGen,
    opHandle,
  });
};

/**
 * V0.6 ack：approve / revise 当前 action（V0.11 改 send 送达）
 *
 * - approve：纯服务端落状态（action → completed）、agent 不需要收信号
 * -（历史）revise 通道已并入 question route 统一消息、见 V0.13.x
 *   续同一会话让 agent 处理；没有可续接的会话（已退出 / 服务重启）→ 抛错让用户重启 / 推进
 */
// V0.13.x：acknowledgeAction 已退役——「再聊聊」（revise）并入 question route 统一消息
//（AI 自主二分类）；approve 语义由推进时自动认可（advanceTask 开头的隐式 approve）承担。

/**
 * V0.6 终态：task 合入 / abandon
 *
 * - merged：write [TASK_DONE]、agent 收尾退出、setTaskRepoStatus=merged + runStatus=idle
 * - abandoned：write [TASK_ABANDONED]、agent 立刻退、setTaskRepoStatus=abandoned + runStatus=idle
 */
export const finalizeTask = async (
  taskId: string,
  finalStatus: Extract<RepoStatus, "merged" | "abandoned">,
  reason?: string,
): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error("task 不存在、无法 finalize");
  }

  // 占 finalizing lifecycle——期间 isOpOwner 全 false，新 advance 不得合法 claim；
  // 占不到 = stop/DELETE 在飞，让用户稍后重试。
  const beganFinalizing = beginChatLifecycle(taskId, "finalizing");
  if (!beganFinalizing) {
    throw new Error("任务正在停止/删除/终结、请稍后再试");
  }
  try {
    // V12：取消一切在途启动意图（与 stop/DELETE 同协议）
    revokeTaskOps(taskId);
    // V0.11：不再向 agent 发终态信号——finalize 语义就是「关掉这个 task」：
    // 有活 run 直接 cancel、跨 run 会话一并关掉（cancelTaskRun 内部处理）
    const hadLive = cancelTaskRun(taskId);
    // 同 stopTaskAgent：无活 run 时 cancelTaskRun 会写入 pendingStopRequests，终结后必须清掉
    pendingStopRequests.delete(taskId);
    console.log(
      `[task-runner] finalizeTask: task=${taskId} ${
        hadLive ? "已停掉运行中的 agent / 会话" : "没有活 agent"
      }、patch repoStatus=${finalStatus}`,
    );
    // 先 revoke，再 join starting + resourceJobs。
    // resourceJobs 超时 → quarantine（fail-closed），不得在旧事务仍可写盘时清 worktree。
    // 超时与 joinResourceJobs / DELETE 共用 getResourceJoinTimeoutMs（单测可缩短）。
    {
      revokeResourceJobs(taskId);
      const deadline = Date.now() + getResourceJoinTimeoutMs();
      while (
        (isTaskStarting(taskId) || hasResourceJobs(taskId)) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      // starting 单独 warn（非 workspace 路径占用）；resource 超时 → quarantine
      if (isTaskStarting(taskId)) {
        console.warn(
          `[task-runner] finalizeTask: task=${taskId} starting 等待超时、继续终结（resource 另判）`,
        );
      }
      if (hasResourceJobs(taskId)) {
        // 已等满仍未归零 → fail-closed 隔离（与 joinResourceJobs 超时同契约）
        markWorkspaceQuarantined(taskId);
        console.error(
          `[task-runner] finalizeTask: task=${taskId} resourceJobs join 超时、已 quarantine；跳过同步清 worktree`,
        );
      }
    }
    // cancel 只是发信号、run 的 finally 可能还在往 worktree 写文件——对齐 DELETE 路由 /
    // deleteTask 口径、等真停再删、防边写边删撞车。没活 run 时秒过。
    await waitForTaskToStop(taskId, 8000);

    // V0.x：merged（已合入）时、当前还在等 ack 的 action 标 completed——用户认可了产物才去合 MR、
    //   不该记成 cancelled（abandoned 维持下面的 cancelled：没认可就放弃）。
    if (finalStatus === "merged") {
      const fresh = await getTask(taskId);
      const cur = fresh?.actions.find(
        (a) => a.id === fresh.currentActionId && a.status === "awaiting_ack",
      );
      if (cur) {
        const patched = await patchAction(taskId, cur.id, { status: "completed" });
        if (patched) publish(taskId, { kind: "task", task: patched });
      }
    }
    // 兜底收尾遗留非终态 action + idle——与 append 共享锁内事务（原无锁扫+裸写可漏）
    await finalizeStaleAndIdleLocked(taskId, { toStatus: "cancelled" });

    // 业务状态 patch（repoStatus；runStatus 已在上一步置 idle）
    const patched = await setTaskRepoStatus(taskId, finalStatus);
    if (patched) publish(taskId, { kind: "task", task: patched });

    // 清 worktree 前先停本任务预览：dev server 还挂着目录就被删 → 进程悬空占端口。
    // best-effort：失败不挡终结主流程。
    try {
      await stopPreviewsForTask(taskId);
    } catch (err) {
      console.warn(
        `[task-runner] finalizeTask: 停预览失败（忽略）task=${taskId}`,
        err,
      );
    }

    // V0.10：终结即清隔离工作区（feature 分支保留在原仓库、随时可 reopen 重建 worktree 续推；
    // 未提交改动删前自动 commit WIP 快照到任务分支、不销毁未 ship 的 build 产物）。
    // best-effort：失败只 log、boot 孤儿扫描兜底。
    // quarantine / 仍有 resourceJobs → 不得同步删；
    // 挂后台等 jobs 归零后再 remove——持有独立 terminal cleanup reservation，
    // quarantine 在 cleanup 完成（或 reopen 作废）前不解除；endResourceJob 只通知 waiter。
    // 同步与 deferred 都走 TerminalCleanupCoordinator——
    // 重复 finalize 只 join、绝不重写 phase / 再起第二个 remove；reservation 在终态提交后、
    // remove 前立刻建立（含无 ResourceJob 的同步快速路径）。
    if (isWorktreeTask(task)) {
      const deferWorktreeCleanup =
        isWorkspaceQuarantined(taskId) || hasResourceJobs(taskId);
      // try-acquire——已有在飞则 join，不拿 handle、不能提前 release
      const acq = acquireTerminalCleanup(taskId);
      if (acq.busy) {
        console.log(
          `[task-runner] finalizeTask: 已有 terminal cleanup 在飞、join 不重入 remove task=${taskId}`,
        );
        await acq.promise;
      } else if (deferWorktreeCleanup) {
        const taskSnap = task;
        const handle = acq.handle;
        void (async () => {
          try {
            await waitUntilResourceJobsCleared(taskId);
            // 提交删除前验证 handle——reopen 作废 waiting 后让位
            if (!isTerminalCleanupHandleValid(handle)) {
              console.log(
                `[task-runner] finalizeTask: 旧 cleanup 已失效、让位 task=${taskId} token=${handle.token}`,
              );
              return;
            }
            // 测试挂点：delayed remove 转 executing 前（waiting 阶段 reopen 仍可作废）
            await failpoint("finalize.beforeDeferredRemove");
            // 原子 waiting→executing；转失败 = 已被 reopen 作废、让位
            if (!markTerminalCleanupExecuting(handle)) {
              console.log(
                `[task-runner] finalizeTask: 转 executing 失败（已被 reopen 作废）、让位 task=${taskId} token=${handle.token}`,
              );
              return;
            }
            // executing 期间 reopen 只能 409——remove 内部多 await 全程受 reservation 保护
            await removeTaskWorktrees(taskSnap).catch((err) => {
              console.warn(
                `[task-runner] finalizeTask: 延迟清理 worktree 失败 task=${taskId}`,
                err,
              );
            });
            try {
              await stopPreviewsForTask(taskId);
            } catch {
              /* best-effort */
            }
          } catch (err) {
            console.error(
              `[task-runner] finalizeTask: 延迟清 worktree 异常 task=${taskId}`,
              err,
            );
          } finally {
            // 仅本 handle.token 能 release；不匹配 no-op
            releaseTerminalCleanup(handle);
          }
        })();
      } else {
        // 同步 remove 同样进 coordinator（裸 remove × reopen 穿越）
        const handle = acq.handle;
        try {
          if (!markTerminalCleanupExecuting(handle)) {
            console.log(
              `[task-runner] finalizeTask: 同步路径转 executing 失败、跳过 remove task=${taskId} token=${handle.token}`,
            );
          } else {
            const removed = await removeTaskWorktrees(task).catch((err) => {
              console.warn(
                `[task-runner] finalizeTask: 清理 worktree 失败 task=${taskId}`,
                err,
              );
              return null;
            });
            if (
              removed?.removedAny ||
              (removed?.snapshotFailedRepos.length ?? 0) > 0
            ) {
              const repoTail = (p: string) =>
                p.split("/").filter(Boolean).pop() ?? p;
              const snapshotNote =
                removed && removed.snapshotRepos.length > 0
                  ? `；未提交改动已自动 commit 到任务分支（${removed.snapshotRepos.map(repoTail).join("、")}）`
                  : "";
              // 快照落不了仍强制删：提醒用户未提交改动可能已丢（已 commit 的仍在分支上）
              const failedNote =
                removed && removed.snapshotFailedRepos.length > 0
                  ? `；⚠️ ${removed.snapshotFailedRepos.map(repoTail).join("、")} 有无法自动保存的未提交改动、工作区已强制删除（未提交改动可能已丢）`
                  : "";
              // eslint-disable-next-line no-restricted-syntax -- 豁免：finalize 终态 owner 无条件语义
              await writeEventAndPublish(taskId, {
                kind: "info",
                text: `已清理任务隔离工作区（feature 分支保留在原仓库、恢复任务后下次推进会自动重建${snapshotNote}${failedNote}）`,
              });
            }
            // remove 后再 best-effort 停一次预览——首次 stop 与 remove 之间的窗口里
            // 用户可能又点了「预览」（route 层已加 lifecycle/终态闸、这里是纵深兜底：
            // 闸检查过后 lifecycle 才 begin 的极窄交错仍可能漏进一个新 dev server）
            try {
              await stopPreviewsForTask(taskId);
            } catch {
              /* best-effort */
            }
          }
        } finally {
          releaseTerminalCleanup(handle);
        }
      }
    }

    // eslint-disable-next-line no-restricted-syntax -- 豁免：finalize 终态 owner 无条件语义
    await writeEventAndPublish(taskId, {
      kind: "info",
      text:
        finalStatus === "merged"
          ? `Task 已标合入 main、收尾结束${reason ? `（${reason}）` : ""}`
          : `Task 已被 abandon${reason ? `（${reason}）` : ""}`,
      meta: { finalStatus, reason },
    });
  } finally {
    endChatLifecycle(taskId, "finalizing");
  }
};

/**
 * terminal cleanup / lifecycle 与 reopen 冲突时拒绝。
 * - finalizing/deleting/stopping 在飞（begin reopening 失败）→ 409
 * - waiting + jobs 未退完 → 409
 * - executing（已入 remove）→ 409「任务清理中、稍后再试」
 * route 映射 409。
 */
export class TaskCleanupInProgressError extends Error {
  constructor(message = "任务清理中、稍后再试") {
    super(message);
    this.name = "TaskCleanupInProgressError";
  }
}

/**
 * 恢复终态 task（merged / abandoned → developing）、让它能重新推进（V0.6.12）
 *
 * 误 abandon、或想把已终结的 task 重新捡起来继续时用。只翻 repoStatus、
 * runStatus 保持 idle（没有活 agent、用户后续点「推进」才起新 Run）。
 *
 * TerminalCleanupCoordinator：finalize / reopen 互斥，防止裸 remove 与 reopen 交叉。
 * - 原子占 `reopening` lifecycle——与 finalizing/deleting/stopping 互斥（begin 失败 → 409）
 * - executing cleanup：抛 TaskCleanupInProgressError（409）；remove 全程受 reservation 保护
 * - waiting + jobs 仍非零：抛 409（旧事务未退完）
 * - waiting + jobs 归零：invalidate 作废旧 cleanup + 立即解除 quarantine（让位语义保留）
 */
export const reopenTask = async (taskId: string): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) throw new Error("task 不存在、无法恢复");
  if (task.repoStatus !== "merged" && task.repoStatus !== "abandoned") {
    throw new Error("只有已合入 / 已放弃的任务才能恢复");
  }
  // 原子占 reopening——DELETE 已占 deleting / finalize 在飞 → begin 失败 → 409
  const beganReopening = beginChatLifecycle(taskId, "reopening");
  if (!beganReopening) {
    const life = getChatLifecycle(taskId);
    throw new TaskCleanupInProgressError(
      life === "deleting"
        ? "任务正在删除、请稍后再试"
        : "任务清理中、稍后再试",
    );
  }
  try {
    // 终态 cleanup 与 reopen 互斥窗口
    if (hasTerminalCleanup(taskId)) {
      // executing 期间恒 409（含同步 remove 挂在 afterPathExists）
      if (getTerminalCleanupPhase(taskId) === "executing") {
        throw new TaskCleanupInProgressError();
      }
      if (hasResourceJobs(taskId)) {
        // ① 兜底：旧事务未退完，拒绝 reopen（避免与慢清理并发写同路径）
        throw new TaskCleanupInProgressError();
      }
      // invalidate 只取消 waiting；executing → busy → 409
      const inv = invalidateTerminalCleanupForReopen(taskId);
      if (inv === "busy") {
        throw new TaskCleanupInProgressError();
      }
      if (inv === "invalidated") {
        console.log(
          `[task-runner] reopenTask: 作废 waiting terminal cleanup、解除 quarantine task=${taskId}`,
        );
      }
    }
    const patched = await setTaskRepoStatus(taskId, "developing");
    if (patched) publish(taskId, { kind: "task", task: patched });
    // eslint-disable-next-line no-restricted-syntax -- 豁免：reopenTask 用户直接操作
    await writeEventAndPublish(taskId, {
      kind: "info",
      text: "任务已恢复（→ 开发中）、可继续推进",
    });
  } finally {
    endChatLifecycle(taskId, "reopening");
  }
};

// ----------------- 内部：起新 Agent + 消息循环 -----------------

interface StartAgentInput {
  task: Task;
  action: ActionRecord;
  userInstruction: string;
  attachedImagePaths?: string[];
  attachedFilePaths?: string[];
  branchCheckoutHint?: string;
  apiKey: string;
  model: ModelSelection;
  // V0.6.1 ship action 用：注册 task-scoped action handler 时闭包 PAT
  // Host 在 buildSessionBridges / prompt 注入时按 task.repoPaths 现推
  gitToken?: string;
  // V0.6.23：build 分批指令（仅 build 有值、拼进首个 NEXT_ACTION）
  batchDirective?: string;
  // V0.8.12 A：plan append 硬指令（仅 plan append 有值、透传给 buildSuperPrompt 的首个 NEXT_ACTION）
  replanDirective?: string;
  /** V1：调用方入场时的 opGen 快照；缺省则在本函数入口取一次 */
  opGen?: number;
  /**
   * / V12：调用方（advance / resume 唤醒）在第一个接管副作用之前 claim 的
   * owner handle——贯穿整条启动链；缺省则受理段自 claim（其它入口路径）。
   */
  opHandle?: TaskOpHandle;
}

// ----------------- V0.11.1：会话桥工厂（handler + notifier、create / resume 共用） -----------------
//
// taskActionHandler（submit_mr / set_feishu_testers / set_plan_batches 同步 RPC）+
// awaitingNotifier（交卷跑后置 check / ask 弹窗事件 / 切 awaiting）原来是 internalStartAgent
// 的内联闭包；V0.11.1 抽出来：Agent.resume 恢复会话时也必须重注册这两座桥、否则恢复后的
// agent 调 submit_mr / submit_work 全部落空。闭包持 gitToken 快照（会话期不可变）；
// host 在 submit_mr 时按 task.repoPaths 现推（不吃历史 settings.gitHost）。
/** session bridge 闭包对（构造与注册分离；安装走 installSessionIfCurrent） */
export type SessionBridges = {
  taskActionHandler: ChatTaskActionHandler;
  awaitingNotifier: AwaitingNotifier;
};

/**
 * 只构造 bridge 闭包、不注册——注册延到 {@link installSessionIfCurrent}
 * （与 agentSessions.set 同点原子安装，堵死「bridge 已装、session 未装」半状态）。
 * create 期间 agent 尚未跑起来不会调 MCP，确认可挪注册到 create 后。
 */
export const buildSessionBridges = (
  task: Task,
  opts: {
    gitToken?: string;
    /**
     * agent 实例身份（create/resume 前分配）。写入 chat-pending 注册表的
     * expectedCallerToken；MCP 工具执行前核对。必传（缺省仅防御路径）。
     */
    callerToken: string;
  },
): SessionBridges => {
  // callerToken 只在 install/register 时写入 expectedCaller；闭包内靠 ctx.callerStillValid
  const { gitToken } = opts;
  const taskActionHandler: ChatTaskActionHandler = async (taskAction, ctx) => {
    const { callerStillValid } = ctx;
    if (taskAction.kind === "submit_mr") {
      let gitHost: string | null = null;
      try {
        gitHost = await resolveEffectiveGitHost(task.repoPaths);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // 每个外部 await 后复查——host 解析期间 B 可换主
      if (!callerStillValid()) {
        return { ok: false, error: CALLER_MISMATCH_ERROR };
      }
      if (!gitHost || !gitToken) {
        return {
          ok: false,
          error: "task 启动时没拿到 GitLab Host / Token、ship 准入应该已被拦、不应该走到这里",
        };
      }
      // 起 createMR 前、server 端按 task 权威数据 + 该仓真实 git remote 校验 agent 上报。
      // agent 幻觉 / prompt 被污染 / remote 解析出错时、防它用 server PAT 给越权 project 提 MR。
      // 读 fresh task（闭包 task 是启动时快照、不含本轮 ship 刚 upsert 的 MR、且校验要最新 gitBranches）。
      const fresh = await getTask(task.id);
      if (!fresh) {
        return { ok: false, error: "task 不存在、无法校验 submit_mr" };
      }
      // V0.10：隔离 task 的 agent 在 worktree 里 `pwd`、上报的是 worktree 路径——
      // 归一回原仓库路径再校验 / 落库（task.repoPaths / gitBranches / MR 记录全按原路径记）。
      // 用新 const（不是重赋值参数）：参数一旦被赋值、TS 在下面的闭包里会丢 narrowing。
      const mr = {
        ...taskAction,
        repoPath: resolveOriginalRepoPath(fresh, taskAction.repoPath),
      };
      const valid = await validateSubmitMr(fresh, mr);
      if (!valid.ok) {
        if (!callerStillValid()) {
          return { ok: false, error: CALLER_MISMATCH_ERROR };
        }
        await writeOwnedEventAndPublish(
          task.id,
          callerStillValid,
          {
            kind: "error",
            actionId: mr.actionId,
            text: `提测被拦截（${mr.repoPath}）：${valid.error}`,
            meta: {
              repoPath: mr.repoPath,
              projectPath: mr.projectPath,
            },
          },
    );
        return { ok: false, error: valid.error };
      }

      // action lease——session caller 只认证 agent、action 权限单独验。
      // 每个外部副作用前复查 = callerStillValid && 锁内 fresh 读 currentActionId/status 仍匹配
      const actionLeaseValid = async (): Promise<boolean> =>
        callerStillValid() &&
        (await isCurrentRunningAction(task.id, mr.actionId));

      // V0.x：submit_mr 共用 ship / dev / custom（dev = 联调提 PR→dev 分支、custom = 自定义 action、target 由 playbook 决定）、下面按 action 类型分流。
      const submitAction = fresh.actions.find((x) => x.id === mr.actionId);
      const isDevSubmit = submitAction?.type === "dev";
      // custom（任意自定义 action）提的 MR 跟 dev 一样源 feature 绝不删（MR 还没合、feature 还要继续用）
      const isCustomSubmit = submitAction?.type === "custom";

      // V0.6.8：AI 智能解冲突会换 source 分支（feature → feature__conflict）、
      // 先读出该仓「上一次同目标分支 MR 的 source 分支」、待新 MR 建好后把旧 MR 关掉（防双 MR 垃圾）。
      // V0.x：按 (repoPath, 目标分支) 找——提测 MR（→test）和联调 MR（→dev）各找各的、互不误关。
      const prevMrBranch = fresh.mrs?.find(
        (m) =>
          m.repoPath === mr.repoPath &&
          mrTargetBranchOf(m, fresh.repoTestBranches) === mr.targetBranch,
      )?.branch;

      // V0.6.14：合并后是否删源分支——读 task 配置（缺省保留、用户拍板）。
      // - `<feature>__conflict` 一次性解冲突分支：必删（不留垃圾、不受开关影响）。
      // - dev（联调）/ custom（任意自定义 action 提的 MR）：feature 源分支绝不删（合入后还要继续开发 / 提测、删了就没分支了）。
      // - ship（提测）：按 task 配置 removeSourceBranchOnMerge（缺省保留）。
      const isConflictBranch = mr.sourceBranch.endsWith("__conflict");
      const removeSourceBranch = isConflictBranch
        ? true
        : isDevSubmit || isCustomSubmit
          ? false
          : (fresh.removeSourceBranchOnMerge ?? false);

      // createMR（不可逆外部副作用）前验 action lease——历史 action 的迟到/重试拒
      if (!(await actionLeaseValid())) {
        return {
          ok: false,
          error: `该 action 已结束（不是当前 running action）、不能再提 MR：${mr.actionId}`,
        };
      }

      // 单一 claim 状态机——已有 mr/postcheck claim 一律拒入；拿到唯一 handle
      const mrClaim = tryClaimSideEffect(task.id, mr.actionId, "mr");
      if (!mrClaim) {
        return {
          ok: false,
          error:
            "该 action 正有其它副作用进行（MR 提交或收尾检查）、稍后重试",
        };
      }
      try {
        // host/getTask/校验 await 之后、caller 复查之前插桩——
        // 测试可在此前一个 await 注入换主，断言复查拦住 createMR
        await failpoint("mcp.submitMr.beforeCreateMR");
        if (!callerStillValid()) {
          return { ok: false, error: CALLER_MISMATCH_ERROR };
        }
        if (!(await actionLeaseValid())) {
          return {
            ok: false,
            error: `该 action 已结束（不是当前 running action）、不能再提 MR：${mr.actionId}`,
          };
        }

        const result = await createMR({
          config: { host: gitHost, token: gitToken },
          projectPath: mr.projectPath,
          sourceBranch: mr.sourceBranch,
          targetBranch: mr.targetBranch,
          title: mr.title,
          description: mr.description,
          removeSourceBranch,
        });
        if (!result.ok) {
          if (!callerStillValid()) {
            return { ok: false, error: CALLER_MISMATCH_ERROR };
          }
          await writeOwnedEventAndPublish(
            task.id,
            callerStillValid,
            {
              kind: "error",
              actionId: mr.actionId,
              text: `提 MR 失败（${mr.repoPath}）：${result.error}`,
              meta: { repoPath: mr.repoPath, projectPath: mr.projectPath },
            },
          );
          return { ok: false, error: result.error };
        }

        // createMR 成功后、closeOpenMR / 本地写之前复查——
        // MR 已建不可撤销，但关旧 MR + 本地落盘仍是可阻止的副作用
        await failpoint("mcp.submitMr.beforeCloseOpenMR");
        // 升级为 caller + action lease——action 已切换也跳过 closeOpenMR 及后续本地写
        if (!(await actionLeaseValid())) {
          return {
            ok: true,
            data: {
              mr_url: result.url,
              mr_iid: result.iid,
              mr_version: 1,
              has_conflicts: false,
              merge_status: "unknown",
              merge_undetermined: true,
              skipped_local: true,
            },
          };
        }

        // 新 MR 建好后、若 source 分支跟上一次不同（= 走了 __conflict 智能解冲突流程）、
        // 把被取代的旧 `<旧分支>→test` MR 关掉。失败只记日志、不阻塞 ship（新 MR 已建好、旧的留着也只是脏）。
        if (prevMrBranch && prevMrBranch !== mr.sourceBranch) {
          const closed = await closeOpenMR({
            config: { host: gitHost, token: gitToken },
            projectPath: mr.projectPath,
            sourceBranch: prevMrBranch,
            targetBranch: mr.targetBranch,
          });
          if (!closed.ok) {
            console.warn(
              `[task-runner] 关旧 MR 失败（${mr.projectPath} ${prevMrBranch}→${mr.targetBranch}）：${closed.error}`,
            );
          } else if (closed.closed && callerStillValid()) {
            await writeOwnedEventAndPublish(
              task.id,
              callerStillValid,
              {
                kind: "info",
                actionId: mr.actionId,
                text: `已关闭被取代的旧 MR（${prevMrBranch} → ${mr.targetBranch}、冲突废弃）`,
                meta: { repoPath: mr.repoPath, projectPath: mr.projectPath },
              },
            );
          }
        }

        // merge-status 轮询前再复查（caller + action lease、各段重新授权）
        if (!(await actionLeaseValid())) {
          return {
            ok: true,
            data: {
              mr_url: result.url,
              mr_iid: result.iid,
              mr_version: 1,
              has_conflicts: false,
              merge_status: "unknown",
              merge_undetermined: true,
              skipped_local: true,
            },
          };
        }

        // V0.6.1.1：MR 建好后 poll GitLab 可合性、检测 feature↔test 冲突
        // GitLab 建 MR 不管有没有冲突都返回成功、冲突要单独查 detailed_merge_status；
        // 且 GitLab 异步算 mergeability、刚建完可能还在 checking、getMRMergeStatus 内部 poll 到稳定
        const mergeStatus = await getMRMergeStatus({
          config: { host: gitHost, token: gitToken },
          projectPath: mr.projectPath,
          iid: result.iid,
        });
        // poll 失败 / 超时未定时、保守按「无冲突」处理（不误拦 ship、detailed 记 unknown 供审计）
        const hasConflicts = mergeStatus.ok ? mergeStatus.hasConflicts : false;
        const detailedStatus = mergeStatus.ok
          ? mergeStatus.detailedStatus
          : "unknown";
        const mergeUndetermined = mergeStatus.ok
          ? mergeStatus.undetermined
          : true;

        // poll 返回后、本地写前再复查（caller + action lease）
        if (!(await actionLeaseValid())) {
          return {
            ok: true,
            data: {
              mr_url: result.url,
              mr_iid: result.iid,
              mr_version: 1,
              has_conflicts: hasConflicts,
              merge_status: detailedStatus,
              merge_undetermined: mergeUndetermined,
              skipped_local: true,
            },
          };
        }

        // 单事务提交前插桩——测试可在此注入 stop/action 切换，断言双投影都不落
        await failpoint("mcp.submitMr.beforeLocalCommit");
        if (!(await actionLeaseValid())) {
          return {
            ok: true,
            data: {
              mr_url: result.url,
              mr_iid: result.iid,
              mr_version: 1,
              has_conflicts: hasConflicts,
              merge_status: detailedStatus,
              merge_undetermined: mergeUndetermined,
              skipped_local: true,
            },
          };
        }

        // task.mrs + action.sideEffects.mrs 同一条件事务（关半状态窗口）
        const upserted = await upsertMRWithActionSideEffect(
          task.id,
          mr.actionId,
          {
            repoPath: mr.repoPath,
            targetBranch: mr.targetBranch,
            url: result.url,
            title: mr.title,
            branch: mr.sourceBranch,
            status: "open",
            lastCommitHash: mr.lastCommitHash,
            hasConflicts,
            mergeStatus: detailedStatus,
          },
          callerStillValid,
          { requireCurrentRunning: true },
        );
        const mrVersion = upserted?.mr.version ?? 1;
        if (upserted) {
          publish(task.id, { kind: "task", task: upserted.task });
          const a = upserted.task.actions.find((x) => x.id === mr.actionId);
          if (a) publish(task.id, { kind: "action", action: a });
        }

        // 有冲突走 error 事件（红、醒目）、无冲突走 info——用户在事件流一眼看到「这条 MR 合不了」
        // 失主则跳过事件（MR 已在 GitLab、本地审计留给新主）
        if (!callerStillValid()) {
          return {
            ok: true,
            data: {
              mr_url: result.url,
              mr_iid: result.iid,
              mr_version: mrVersion,
              has_conflicts: hasConflicts,
              merge_status: detailedStatus,
              merge_undetermined: mergeUndetermined,
            },
          };
        }
        const mrVerb = mrVersion > 1 ? `推送（v${mrVersion}）` : "创建";
        if (hasConflicts) {
          await writeOwnedEventAndPublish(
            task.id,
            callerStillValid,
            {
              kind: "error",
              actionId: mr.actionId,
              text: `MR 已${mrVerb}、但跟 ${mr.targetBranch} 有冲突、需用户手动解决后才能合：${result.url}`,
              meta: {
                repoPath: mr.repoPath,
                projectPath: mr.projectPath,
                mrUrl: result.url,
                mrIid: result.iid,
                mrVersion,
                mergeStatus: detailedStatus,
              },
            },
          );
        } else {
          await writeOwnedEventAndPublish(
            task.id,
            callerStillValid,
            {
              kind: "info",
              actionId: mr.actionId,
              text: `MR 已${mrVerb}：${result.url}`,
              meta: {
                repoPath: mr.repoPath,
                projectPath: mr.projectPath,
                mrUrl: result.url,
                mrIid: result.iid,
                mrVersion,
                mergeStatus: detailedStatus,
              },
            },
          );
        }
        return {
          ok: true,
          data: {
            mr_url: result.url,
            mr_iid: result.iid,
            mr_version: mrVersion,
            // agent 据此决策：true → ask_user 让用户解冲突、且本仓「不」发飞书评论
            has_conflicts: hasConflicts,
            merge_status: detailedStatus,
            merge_undetermined: mergeUndetermined,
          },
        };
      } finally {
        // 只 release 本轮 mrClaim——stop clear 后同 action resume 的新 claim 不受影响
        releaseSideEffect(mrClaim);
      }
    }

    if (taskAction.kind === "set_feishu_testers") {
      // 结构条件——须是当前 running action（ship 进行中）；验收点名原先无此闸
      const freshFeishu = await getTask(task.id);
      if (!callerStillValid()) {
        return { ok: false, error: CALLER_MISMATCH_ERROR };
      }
      const feishuAction = freshFeishu?.actions.find(
        (a) => a.id === taskAction.actionId,
      );
      if (
        !freshFeishu ||
        freshFeishu.currentActionId !== taskAction.actionId ||
        !feishuAction ||
        feishuAction.status !== "running"
      ) {
        return {
          ok: false,
          error: "当前 action 状态不允许设置飞书测试人员（须为 current + running）",
        };
      }
      // 外层 fresh 检查补 type === "ship"（非 ship 明确拒，文案含类型语义）
      if (feishuAction.type !== "ship") {
        return {
          ok: false,
          error: `set_feishu_testers 只允许 ship 类型（当前 ${feishuAction.type} 不允许）`,
        };
      }
      // 结构条件真正进锁内 expected/finalGuard（外层检查与拿锁之间可切 action）
      const patched = await setFeishuTesterUserKeys(
        task.id,
        taskAction.userKeys,
        callerStillValid,
        { actionId: taskAction.actionId, types: ["ship"] },
      );
      // patched===null 返失败、不写「已记忆」成功事件
      if (!patched) {
        return {
          ok: false,
          error: callerStillValid()
            ? "设置飞书测试人员失败（状态已变或已被接管）"
            : CALLER_MISMATCH_ERROR,
        };
      }
      publish(task.id, { kind: "task", task: patched });
      await writeOwnedEventAndPublish(
        task.id,
        callerStillValid,
        {
          kind: "info",
          actionId: taskAction.actionId,
          text: `已记忆飞书测试人员（${taskAction.userKeys.length} 人、同 task 后续 ship 直接复用）`,
          meta: { userKeys: taskAction.userKeys },
        },
    );
      return { ok: true };
    }

    if (taskAction.kind === "set_plan_batches") {
      // V0.6.23：plan agent 上报拆出的批次 → 落到该 plan action 的 planBatches 字段
      // build 选批 + 进度推导都读「最新 completed plan 的 planBatches」（见 task-display.computeBatchProgress）
      // 锁内结构条件 = current + running + type plan；null → 返失败不写成功事件
      const patched = await patchActionIfOwner(
        task.id,
        taskAction.actionId,
        { planBatches: taskAction.batches },
        () => callerStillValid() && getChatLifecycle(task.id) === null,
        {
          currentActionId: taskAction.actionId,
          actionStatus: "running",
          actionType: "plan",
        },
      );
      if (!patched) {
        return {
          ok: false,
          error: callerStillValid()
            ? "当前 action 状态不允许设置批次（须为 current + running + plan）"
            : CALLER_MISMATCH_ERROR,
        };
      }
      publish(task.id, { kind: "task", task: patched });
      const a = patched.actions.find((x) => x.id === taskAction.actionId);
      const replanMode: ReplanMode | undefined = a?.replanMode;
      if (a) publish(task.id, { kind: "action", action: a });
      await writeOwnedEventAndPublish(
        task.id,
        callerStillValid,
        {
          kind: "info",
          actionId: taskAction.actionId,
          text:
            replanMode === "append"
              ? `本次新增 ${taskAction.batches.length} 个批次，已并入方案（可在「改代码」里选择）`
              : `已记录 ${taskAction.batches.length} 个批次（build 可分批推进、其余批次先不动）`,
          meta: { batchCount: taskAction.batches.length },
        },
    );
      return { ok: true };
    }

    return { ok: false, error: "未知 task action kind" };
  };

  // 具名化：create 失败 / 旧会话迟到清理走 conditional unset，防 force-new-agent race 误清新 handler
  // 结构化返回 accepted | stale | busy——scope no-op 不再被工具层当「已交卷」
  const awaitingNotifier: AwaitingNotifier = async (signal, ctx) => {
    const { callerStillValid } = ctx;
    // bridge 有效期 = callerToken 仍匹配；lifecycle 进行中拒写
    if (!callerStillValid() || getChatLifecycle(task.id) !== null) {
      return "stale";
    }

    if (signal.kind === "ask_user_request") {
      // ask lease 含 askId——同 caller 并发/重试的旧 ask（pending map 已被
      // 新 ask 顶掉）在 supersede/event/status/publish 每个 sink 都被拦，
      // 关闭「UI 最新卡片是 A、pending map 指向 B、答 A 必失败」的分裂路径
      const askLease = (): boolean =>
        callerStillValid() &&
        getChatLifecycle(task.id) === null &&
        getPendingAsk(task.id)?.askId === signal.askId;
      // 新提问落盘前、先作废旧的未了结提问（同事踩坑根因）：
      //   agent 重问 / 断线重挂时 pendingMap 单例被新 ask 顶掉、旧 ask 的 token 已死——
      //   不补作废标记、前端答完新弹窗后旧弹窗会复活、答了必失败（严重时误标任务 error）。
      // supersede 带 lease——接管发生在其 IO 内时旧 A 不再对新世界写作废标记
      await supersedePendingAsks(task.id, "被新提问顶替", askLease);
      // supersede await 后、落 ask event 前复查；失主反登记防孤儿弹窗
      await failpoint("mcp.askUser.afterSupersede");
      if (!askLease()) {
        // 按本次 askId 反登记并返 stale——wrapper 透传后工具不得报 ASK_SUBMITTED
        cancelPendingIf(task.id, signal.askId);
        return "stale";
      }
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      await writeOwnedEventAndPublish(
        task.id,
        askLease,
        {
          kind: "ask_user_request",
          actionId: signal.actionId,
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
      // ask 成功路径显式 accepted
      return "accepted";
    }

    // awaiting_start：agent 完成一个 action 调 submit_work(action_id) → 后台跑 check + 切 awaiting_ack
    //                 或 agent 待命 submit_work(待命态、不带 action_id) → 只切 runStatus=awaiting_user
    if (signal.actionId) {
      // V0.8.18：后置 deterministic check（build 的 lint/typecheck 可达 120s）改后台异步跑——
      // 这样 notifier 立即返回、agent 的 submit_work 工具秒回引导、第一时间挂上 curl long-poll 等 ack
      // （以前同步 await check 会把工具调用阻塞到超时、agent 收到「submit_work 失败」乱来、线上踩过）。
      // check 跑完再由 runActionPostCheck 落 postCheck + 切 awaiting_ack + 发「产出完成」事件。
      // postCheck 独立租约、不传 run opHandle
      // waitAndClaimPostCheck 等 mr 清空后同 tick claim / 换 token——关交接空窗与 ABA
      await failpoint("mcp.submitWork.beforeCheckStart");
      if (!callerStillValid()) return "stale";
      const claim = await waitAndClaimPostCheck(task.id, signal.actionId, {
        stillValid: async () =>
          callerStillValid() &&
          getChatLifecycle(task.id) === null &&
          (await isCurrentRunningAction(task.id, signal.actionId!)),
        // 重交卷换 token 前同步 abort 旧 check（摘表、不 release——随即换新 claimId；
        // claimHandle 随 entry 摘掉，旧 dropSelf 因 runningChecks 已无 self 而 no-op）
        onReplacePostCheck: () => {
          const prev = runningChecks.get(task.id);
          if (!prev) return;
          prev.controller.abort();
          runningChecks.delete(task.id);
        },
      });
      if (claim.result === "timeout") {
        // busy（非 throw）——工具层返回重试文案，不再假「已交卷」
        return "busy";
      }
      if (claim.result === "invalid") return "stale";
      const postCheckHandle = claim.handle;
      // claimed： failpoint 窗口内 submit_mr 必被 postcheck claim 拒
      await failpoint("mcp.submitWork.beforeAbortCheck");
      if (!callerStillValid()) {
        releaseSideEffect(postCheckHandle);
        return "stale";
      }
      const scopeOk = await isCurrentRunningAction(task.id, signal.actionId);
      if (!scopeOk || !callerStillValid()) {
        releaseSideEffect(postCheckHandle);
        return "stale";
      }
      runActionPostCheck(
        task.id,
        signal.actionId,
        signal.artifactPath,
        postCheckHandle,
      );
      return "accepted";
    }

    // 待命态：agent ack 完、调 submit_work(空 action_id) 等下一 action 指令 → 切 awaiting_user。
    // 用 setTaskAwaitingIfIdle（锁内 compare-set）防 force-new 秒推 race：approve 后用户秒推下一 action、
    //   advanceTask 已把 runStatus 设 running 且新 action 在跑时、此处被取消的旧 agent 迟到的待命通知
    //   不能把 running 覆盖回 awaiting_user（否则新 action 在跑却显示「等待回复」、推进按钮误亮、僵尸组合）。
    if (!callerStillValid() || getChatLifecycle(task.id) !== null) {
      return "stale";
    }
    const updated = await setTaskAwaitingIfIdle(task.id);
    if (updated) publish(task.id, { kind: "task", task: updated });
    return "accepted";
  };
  return { taskActionHandler, awaitingNotifier };
};

/**
 * session record + bridge + caller token 的唯一原子安装点（同步、无 await）。
 * lease 失效则什么都不装、返 false（调用方自己关 agent）。
 * 线性化：同步验 lease → set session + 两座 bridge 一次完成，无「bridge 已装、session 未装」半状态。
 */
export const installSessionIfCurrent = (
  lease: () => boolean,
  taskId: string,
  record: AgentSessionRecord,
  bridges: SessionBridges,
  callerToken: string,
): boolean => {
  if (!lease()) return false;
  agentSessions.set(taskId, record);
  setChatTaskActionHandler(taskId, bridges.taskActionHandler, callerToken);
  setChatAwaitingNotifier(taskId, bridges.awaitingNotifier, callerToken);
  return true;
};

/**
 * 起 / 接 agent 前保证工作区在盘上：
 * 1. 任务 workspace 目录（tasks/<id>/workspace/、非 artifact 产出兜底落点）——建任务时已创建、
 *    这里兜底重建（老任务没有 / 用户手删）、mkdir recursive 幂等秒过、失败只 log 不挡启动
 * 2. 隔离 task 的 worktree——reopen 不重建、finalize 清过再问一问、用户手删 worktree
 *    都会让 cwd 指到不存在的路径；ensureTaskWorktrees 幂等、热路径秒过；非隔离 task 直接 noop。
 *    失败直接抛（分支被占等）——调用方已有错误处理、不在这里吞。
 *
 * @param lease **必填**——mkdir 前验、透传给 ensureTaskWorktrees；失主抛 WorktreeLeaseLostError
 */
const ensureWorkspaceReady = async (
  task: Task,
  lease: () => boolean,
): Promise<void> => {
  // workspace mkdir 前验 lease（与 worktree ensure 共用同一租约）
  if (!lease()) throw new WorktreeLeaseLostError();
  // chat 不建 workspace 目录（跟 createTask 口径一致）；当前 chat 不走本 runner、纯防御
  if (task.mode !== "chat") {
    await fs
      .mkdir(getTaskWorkspaceDir(task.id), { recursive: true })
      .catch((err) =>
        console.warn(`[task-runner] 建 workspace 目录失败（忽略）task=${task.id}`, err),
      );
  }
  if (!isWorktreeTask(task)) return;
  await ensureTaskWorktrees(task, lease);
};

const internalStartAgent = async (input: StartAgentInput): Promise<void> => {
  const {
    task,
    action,
    userInstruction,
    attachedImagePaths,
    attachedFilePaths,
    branchCheckoutHint,
    apiKey,
    model,
    gitToken,
    batchDirective,
    replanDirective,
  } = input;
  // V1：调用方传入场快照；没传则入口自取（其它入口路径）
  const opGen = input.opGen ?? getTaskOpGeneration(task.id);
  // 真实启动链 lease——有 opHandle 用 isOpOwner；否则退 admission gen
  const workspaceLease = (): boolean =>
    input.opHandle
      ? isOpOwner(input.opHandle)
      : !isTaskOpStale(task.id, opGen);

  // 打点（v1.1.x「SDK 比 IDE 慢」排查）：启动链路各段耗时、[perf] 前缀统一可 grep 统计
  const perfStart = Date.now();

  // V2：refcount 标记启动飞行窗（须在第一个 await 前）。fire-and-forget IIFE 才是真正消费者，
  // outer finally 只在未移交时清；移交后由 IIFE finally 清。
  beginTaskStarting(task.id);
  let handedOffToRunner = false;
  try {
    // 兜底：调用方约定已 ensure，但 resume / 问一问 / 手删 worktree 等路径可能漏——入口再保证一次
    try {
      await ensureWorkspaceReady(task, workspaceLease);
    } catch (err) {
      // 让位 → 抛 stale（advance / resume 调用方不得当作启动成功）
      if (err instanceof WorktreeLeaseLostError) {
        console.log(
          `[task-runner] internalStartAgent: task=${task.id} 工作区 ensure 让位（lease 失效）`,
        );
        throw new Error(TASK_OP_STALE_HTTP_MESSAGE);
      }
      throw err;
    }
    // V1：ensure 可能用 stale task 重建了已删目录——立刻发现作废则不再 create
    await abortIfTaskOpStale(task.id, opGen);
    const perfWorkspaceMs = Date.now() - perfStart;

    // host 按任务仓库 remote 现推（多实例不一致会 throw、起 agent 失败可见）
    const effectiveGitHost =
      (await resolveEffectiveGitHost(task.repoPaths)) ?? undefined;

    // advance 在步骤 4 只 snapshot 一次 activeRun——one-shot 可能在
    // 那之后、走到这里之前才完成 send 预登记。持 opHandle 的正式启动意图
    // **不得**在此按「幂等」吞掉（会让新 action 永不启动、one-shot 结束后还把
    // task 恢复成 idle）：迟到的 record 交给串行受理段的 predecessor handoff
    // （forkPendingTasks + cancel + 等清表）处理。无 handle 的调用（防御路径）
    // 保持原幂等语义。
    if (runningTasks.has(task.id)) {
      if (input.opHandle === undefined) {
        console.warn(
          `[task-runner] internalStartAgent: task=${task.id} 已有 running entry、跳过（幂等）`,
        );
        return;
      }
      console.warn(
        `[task-runner] internalStartAgent: task=${task.id} 已有 running entry（迟到的 one-shot 预登记）、交给受理段接管`,
      );
    }

    // create 前发 caller token（寿命 = agent 实例、跨多轮 send 复用）
    const callerToken = String(allocTaskRunInstanceId());

    // 1) merge MCP（V0.11.1 抽成共用 helper、resume 会话时也要重传 inline MCP）
    const perfMcpStart = Date.now();
    const { mergedMcp, cursorMcpNames, droppedMcp } =
      await buildMergedMcpForTask(task, callerToken);
    const perfMcpMs = Date.now() - perfMcpStart;
    const mcpDesc = `Task MCP: ${TASK_TOOL_MCP_NAME}${
      cursorMcpNames.length > 0 ? ` + cursor MCP: ${cursorMcpNames.join(", ")}` : ""
    }`;

    // owner 语境（启动链、claim 前）——admission lease
    await writeOwnedEventAndPublish(
      task.id,
      () => !isTaskOpStale(task.id, opGen),
      {
        kind: "info",
        actionId: action.id,
        text: `启动新 agent（model: ${model.id}、${mcpDesc}）`,
      },
    );

    // V0.6.11：有被剔除的 MCP → 写一条提示、让用户知道为什么少了能力（不再「莫名其妙报错」）
    if (droppedMcp.length > 0) {
      // owner 语境（启动链、claim 前）——admission lease
      await writeOwnedEventAndPublish(
        task.id,
        () => !isTaskOpStale(task.id, opGen),
        {
          kind: "info",
          actionId: action.id,
          text: `⚠️ 已跳过 ${droppedMcp.length} 个不可用的 MCP：${droppedMcp
            .map((d) => `${d.name}（${d.detail?.split("\n")[0] ?? MCP_HEALTH_LABEL[d.status]}）`)
            .join("、")}——相关能力本次不可用、去设置页检查 / 授权`,
        },
      );
    }

    // 2) 只构造 bridge 闭包——注册延到 create 后 installSessionIfCurrent
    //    （create 期间 agent 未跑、不会调 MCP；半状态根源是「create 前注册 + create 后 set session」分步）
    const bridges = buildSessionBridges(task, {
      gitToken,
      callerToken,
    });

    // 4) 启动 Agent + 首个 run（在独立 Promise 里跑、advanceTask 立即返回）
    // fire-and-forget：外部 waitForTaskToStop 靠 poll runningTasks.has 收敛、不依赖此 promise
    handedOffToRunner = true;
    void (async () => {
      // 用 box 承载——串行回调里给外层 let 赋值会被 TS CFA 当成「从未赋值」收窄成 never
      const agentBox: { current: AgentInstance | null } = { current: null };
      // V12：本条启动链的 owner handle（受理段 claim / 沿用调用方；失败/收尾靠它门控）
      let opHandle: TaskOpHandle | undefined;
      try {
        // V0.10：隔离 task 的 cwd = worktree（入口 ensureWorkspaceReady 已保证目录在盘上）
        // 存量清理：以前 inject 的 fe hooks.json 删掉（hooks 链路已退役、交卷改 send 追问）
        const effectiveCwd = getTaskCwd(task);
        await cleanupFeHooksJson(effectiveCwd);

        // prompt 素材与 Agent.create 并行（v1.1.x 提速）：skills 读盘、identity 走
        // meegle CLI 都可达秒级——create 冷启动本身要数秒、重叠后首 token 提前。
        // 侧挂 catch 防「create 期间先 reject」的 unhandledRejection 噪音（await 时仍抛）。
        const skillsPromise = loadSkills().catch((err) => {
          console.error("[task-runner] loadSkills failed", err);
          return [] as SkillEntry[];
        });
        const identityPromise = resolveUserIdentityForPrompt();
        identityPromise.catch(() => {});

        // create→send 受理段进 per-task 串行链（与 one-shot / follow-up send 互斥）。
        // stream 消费（consumeSessionRun）留链外——否则 follow-up send 全排到整轮 run 结束。
        // ⚠️ 死锁自查：本回调绝不嵌套 runWithTaskSendSerial / sendToTaskSession
        // （internalStartAgent 本身也不调 sendToTaskSession）。
        type AdmitOk = { run: SessionRun; instanceId: number; perfCreateMs: number; perfPromptMs: number; perfSendMs: number; promptBytes: number };
        const admitted = await runWithTaskSendSerial(
          task.id,
          async (): Promise<AdmitOk | null> => {
            // / V12：优先沿用调用方在接管副作用前 claim 的 handle（advance /
            // resume 唤醒都已前移）；无调用方 handle 的入口才在此自 claim。
            // claim 返 null / handle 已失主 → 本启动链在开工前就让位。
            if (input.opHandle) {
              opHandle = input.opHandle;
            } else {
              const claimed = claimTaskOp(task.id, opGen);
              if (!claimed) {
                console.warn(
                  `[task-runner] internalStartAgent: task=${task.id} claim 失败（admission 已作废）、让位`,
                );
                return null;
              }
              opHandle = claimed;
            }
            // 传入 handle 已被更晚的接管者覆盖 → 开工前让位
            if (!isOpOwner(opHandle)) {
              console.warn(
                `[task-runner] internalStartAgent: task=${task.id} op owner 已被后继接管（受理段入口）、让位`,
              );
              return null;
            }
            // 不再 create 前重注册桥——installSessionIfCurrent 在 create 后与 session 同点安装
            await abortIfTaskOpStale(task.id, opGen);

            // 出队后若前驱（常是 one-shot question run）仍占 runningTasks——
            // 推进意图优先：取消前驱、等其清表，再起正式 agent（不可「幂等跳过」把新 action 晾着）。
            const predecessor = runningTasks.get(task.id);
            if (predecessor) {
              console.warn(
                `[task-runner] internalStartAgent: task=${task.id} 链上已有 run（agentId=${predecessor.agentId}）、取消前驱再起正式 agent`,
              );
              // cancel 前先建 fork handoff——对齐 advanceTaskInner force-new。
              // 否则前驱 cancelled 分支看不见 forkPendingTasks，会走「普通停止收尾」
              // 把后继刚 append 的 action 一并 cancelled + 写 idle。
              forkPendingTasks.add(task.id);
              predecessor.cancel();
              const deadline = Date.now() + 5000;
              while (runningTasks.has(task.id) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 50));
              }
              if (runningTasks.has(task.id)) {
                console.warn(
                  `[task-runner] internalStartAgent: task=${task.id} 前驱 5s 未清、强清 runner 后继续`,
                );
                forceClearStaleRunnerState(task.id);
              }
            }

            // Agent.create 前再验盘上终态——route/core 陈旧快照不能冒充 developing
            {
              const repoStatus = await readTaskRepoStatusFresh(task.id);
              if (repoStatus === "merged" || repoStatus === "abandoned") {
                console.warn(
                  `[task-runner] internalStartAgent: task=${task.id} 盘上已终态 ${repoStatus}、让位不启动`,
                );
                return null;
              }
            }
            const perfCreateStart = Date.now();
            const created = await Agent.create({
              apiKey,
              model,
              // settingSources:[] = 不加载任何 .cursor/（彻底脱离 Cursor 安装 / 项目配置）。
              // rules / skills / mcp 全部由 fe 自管注入（readAppRulesForPrompt / loadSkills /
              // inline mcpServers）；曾用 ["project"] 时 chat 未绑目录 cwd=homedir 会把
              // ~/.cursor MCP 整包漏进 agent（实锤 bug）。
              local: { cwd: effectiveCwd, settingSources: [] },
              mcpServers: mergedMcp,
            });
            await failpoint("start.afterCreate");
            agentBox.current = created;
            const perfCreateMs = Date.now() - perfCreateStart;
            console.log(
              `[task-runner] task=${task.id} Agent.create OK agentId=${created.agentId}`,
            );

            // 让位 helper——失去 op owner（后继在接管副作用前已 claim 覆盖）时
            // 只关本地资源：自己注册的会话按 instanceId 精确关、未注册则裸 close agent；
            // 绝不碰 pendingStopRequests（那可能是用户发给后继的停止信号）、不写任何共享状态。
            // 锚点：super prompt 已送达 → keepPersisted（会话可被后继 resume 续用）；
            // 未送达 → 连锚点一起清——留着会让后继续接 resume 到一个没收过 prompt 的裸 agent。
            let promptDelivered = false;
            const yieldStartIfLostOwner = (): boolean => {
              // / V12：唯一组合判定——失主即让位
              if (!opHandle || isOpOwner(opHandle)) {
                return false;
              }
              console.warn(
                `[task-runner] internalStartAgent: task=${task.id} op owner 已被后继接管、启动链让位`,
              );
              const sess = agentSessions.get(task.id);
              if (sess?.agent === created) {
                closeTaskSession(task.id, created.agentId, {
                  expectedSessionInstanceId: sess.instanceId,
                  keepPersisted: promptDelivered,
                  reap: false,
                });
              } else {
                try {
                  created.close();
                } catch {
                  /* noop */
                }
              }
              unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
              unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
              return true;
            };

            // create await 期间后继可能已接管（claim 已前移到接管副作用之前）
            if (yieldStartIfLostOwner()) return null;

            // 启动窗口停止：create 返回后、尚未 register / send——无 run、直接关 agent + 收尾
            // V1：opGen 不匹配（stop 已完成并释放）同样只关资源
            if (
              await applyPendingStopIfRequested(
                task,
                created,
                undefined,
                opGen,
                action.id,
                undefined,
                opHandle,
              )
            ) {
              unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
              unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
              return null;
            }

            // session + bridge 原子安装（同步 CAS）；插桩在调用方 install 之前
            await failpoint("session.beforeInstall");
            const sessionRecord: AgentSessionRecord = {
              instanceId: allocTaskRunInstanceId(),
              agent: created,
              agentId: created.agentId,
              callerToken,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              startSnapshot: captureTaskFieldsSnapshot(task),
            };
            if (
              !installSessionIfCurrent(
                () => !!opHandle && isOpOwner(opHandle),
                task.id,
                sessionRecord,
                bridges,
                callerToken,
              )
            ) {
              console.warn(
                `[task-runner] internalStartAgent: task=${task.id} installSession 失主、关本地 agent`,
              );
              try {
                created.close();
              } catch {
                /* noop */
              }
              return null;
            }
            // agentId 同步落盘（V0.11.1 会话持久化）：服务重启后 Agent.resume 无缝接回
            // finalGuard = 本 session 仍是当前注册（防迟到 set 盖后继锚点）
            void setTaskSessionAgentId(task.id, created.agentId, () => {
              const s = agentSessions.get(task.id);
              return (
                !!s &&
                s.agentId === created.agentId &&
                s.agent === created
              );
            });

            // 收割 create 前发起的并行加载（见上）——skills 注入 prompt、identity 拼发起人行
            const perfPromptStart = Date.now();
            const skills = await skillsPromise;
            const userIdentityLine = await identityPromise;
            // settings 配了 gitToken 才注入「GitLab 访问」段（给 agent 铺正路读 config.json）
            const gitlabAccessSection =
              gitToken && gitToken.trim().length > 0
                ? buildGitlabAccessDirective(effectiveGitHost, dataRoot())
                : "";
            const superPrompt = await buildSuperPrompt(
              task,
              skills,
              {
                action,
                userInstruction,
                attachedImagePaths,
                attachedFilePaths,
                branchCheckoutHint,
                batchDirective,
                replanDirective,
              },
              userIdentityLine,
              gitlabAccessSection,
            );
            await failpoint("start.afterPrompt");
            const perfPromptMs = Date.now() - perfPromptStart;

            // prompt 素材 await 期间后继可能已接管
            if (yieldStartIfLostOwner()) return null;

            // V1：prompt await 后再查一次——此间 stop 完成则不得 send
            if (
              await applyPendingStopIfRequested(
                task,
                created,
                undefined,
                opGen,
                action.id,
                agentSessions.get(task.id)?.instanceId,
                opHandle,
              )
            ) {
              unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
              unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
              return null;
            }

            const perfSendStart = Date.now();
            const promptBytes = Buffer.byteLength(superPrompt, "utf-8");
            // SDK onDelta/onStep 细粒度耗时（thinking / tool / step / turn）——与下方 start-chain 汇总互补
            const perfTracker = createRunPerfTracker({
              taskId: task.id,
              agentId: created.agentId,
              runKind: "task-first",
              promptBytes,
            });
            const run = await created.send(superPrompt, {
              onDelta: composeOnDelta(
                perfTracker.onDelta,
                // shell delta 绑本启动链 op lease——失主迟到 flush 丢弃
                createShellOutputDeltaPublisher(
                  task.id,
                  () => !!opHandle && isTaskOpCurrent(opHandle),
                ),
              ),
              onStep: perfTracker.onStep,
            });
            await failpoint("start.afterSend");
            perfTracker.attachRun(run);
            const perfSendMs = Date.now() - perfSendStart;
            promptDelivered = true;

            // send await 期间后继接管 → cancel 刚受理的 run 再让位，
            // 绝不预登记 runningTasks（会把后继的 record 覆盖 / 干扰其可见性）
            if (opHandle && !isOpOwner(opHandle)) {
              void run.cancel().catch(() => {
                /* noop */
              });
              yieldStartIfLostOwner();
              return null;
            }

            // send 受理成功后、出链前预登记 runningTasks（带 instanceId）——
            // 否则出链→consume.set 窗口内另一入口仍看不到本 run。
            // consumeSessionRun 入口会复用同 agentId 的 instanceId 并换上带 cancelled 闭包的 cancel。
            const instanceId = allocTaskRunInstanceId();
            runningTasks.set(task.id, {
              instanceId,
              agentId: created.agentId,
              startedAt: Date.now(),
              startSnapshot: captureTaskFieldsSnapshot(task),
              cancel: () => {
                void run.cancel().catch(() => {
                  /* noop */
                });
              },
            });

            return {
              run,
              instanceId,
              perfCreateMs,
              perfPromptMs,
              perfSendMs,
              promptBytes,
            };
          },
        );

        const liveAgent = agentBox.current;
        if (!admitted || !liveAgent) {
          // 受理未成（pending stop / stale）——匹配才释放，防误删后继 B 的 op
          if (opHandle) releaseTaskOpIf(opHandle);
          return;
        }

        // 单行汇总（不写 events、纯日志）：workspace=worktree 确保、mcp=健康探测+merge、
        // create=SDK 冷启动、prompt=素材收割+拼装（含首包字节数）、send=Run 受理、total=自点推进起
        console.log(
          `[perf] task=${task.id} action=${action.type} start-chain ` +
            `workspace=${perfWorkspaceMs}ms mcp=${perfMcpMs}ms create=${admitted.perfCreateMs}ms ` +
            `prompt=${admitted.perfPromptMs}ms/${Math.round(admitted.promptBytes / 1024)}KB ` +
            `send=${admitted.perfSendMs}ms total=${Date.now() - perfStart}ms`,
        );
        // stream 消费在串行链外（链只护启动受理互斥）；opHandle 传到 consume 收尾释放
        await consumeSessionRun(task, liveAgent, admitted.run, {
          errorActionId: action.id,
          opHandle: opHandle!,
        });
      } catch (err) {
        const failedAgent = agentBox.current;
        // 启动窗口点停止可能先 close 了会话 → send 抛错；按 cancelled 收尾、别标 error 覆盖
        if (failedAgent) {
          if (
            await applyPendingStopIfRequested(
              task,
              failedAgent,
              undefined,
              opGen,
              action.id,
              agentSessions.get(task.id)?.agent === failedAgent
                ? agentSessions.get(task.id)?.instanceId
                : undefined,
              opHandle,
            )
          ) {
            unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
            unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
            if (opHandle) releaseTaskOpIf(opHandle);
            return;
          }
          // Agent.create / 首次 send 阶段失败（consumeSessionRun 内部错误它自己处理、不会抛）
          // / V12：传 opHandle——失主或 stop revoke 则不得伤共用状态
          await handleRunFailure(task.id, action.id, err, { opHandle });
          if (opHandle) releaseTaskOpIf(opHandle);
          // 当前 session 不是 failedAgent → 只关本地对象，绝不调 closeTaskSession
          // （旧代码传 undefined =「不校验实例」，同 agentId 的 B 会被误关）
          const failedSess = agentSessions.get(task.id);
          if (failedSess?.agent === failedAgent) {
            closeTaskSession(task.id, failedAgent.agentId, {
              expectedSessionInstanceId: failedSess.instanceId,
            });
          } else {
            try {
              failedAgent.close();
            } catch {
              /* noop */
            }
          }
        } else {
          await handleRunFailure(task.id, action.id, err, { opHandle });
          if (opHandle) releaseTaskOpIf(opHandle);
          // create 都没成：会话没注册——条件注销，防 force-new 后新 agent 已注册时误清
          unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
          unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
        }
      } finally {
        endTaskStarting(task.id);
      }
    })();
  } finally {
    if (!handedOffToRunner) endTaskStarting(task.id);
  }
};

// ----------------- V0.11：run 消费管道（首个 run + 后续 send 共用） -----------------

// ----------------- V0.13.x：run 网络断自动重连（用户拍板「重试 5 次、显示重连中」） -----------------

const RECONNECT_MAX = 5;
// 指数退避（毫秒）：网络波动多在几秒内恢复、前两次快试、后面拉长
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * 服务端凭据兜底（自动重连时没有 client bootArgs 可用）：直接读 config.json。
 * 跟 client settings 同一份文件、apiKey / 默认模型 / git 凭据都在。
 */
const readServerCreds = async (): Promise<SessionCreds> => {
  try {
    const raw = await fs.readFile(
      path.join(dataRoot(), "config.json"),
      "utf-8",
    );
    const cfg = JSON.parse(raw) as {
      apiKey?: string;
      defaultModel?: ModelSelection;
      gitToken?: string;
    };
    return {
      apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : undefined,
      model: cfg.defaultModel?.id ? cfg.defaultModel : undefined,
      gitToken: typeof cfg.gitToken === "string" ? cfg.gitToken : undefined,
    };
  } catch {
    return {};
  }
};

// 可中断 sleep（1s 分片）：重连退避期间用户点「停止」要立即生效、返回 true = 被取消
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
 * run 网络类失败的自动重连：写「重连中 n/5」事件 → 退避 → Agent.resume 接回同一会话 →
 * send 系统提示「从断点继续」→ 递归消费新 run（attempt 计数随 opts 传递、防无限）。
 *
 * @returns handled = 已接管（重连成功、新 run 消费完毕）；cancelled = 用户停止；
 *          give-up = 不可重试 / 次数烧完（调用方走原报错路径）
 */
const tryAutoReconnect = async (
  task: Task,
  err: unknown,
  opts: {
    errorActionId?: string;
    questionRun?: boolean;
    reconnectAttempt?: number;
    /** V12：透传给递归 consume——状态写门控仍认同一把 handle */
    opHandle: TaskOpHandle;
    /**
     * 首轮入场捕获的会话 instanceId——递归退避不得重抓（否则可能抓到 B）。
     */
    reconnectSessionInstanceId?: number;
  },
  isCancelled: () => boolean,
): Promise<"handled" | "cancelled" | "give-up"> => {
  const attempt = (opts.reconnectAttempt ?? 0) + 1;
  if (attempt > RECONNECT_MAX) return "give-up";
  const msg = err instanceof Error ? err.message : String(err);
  if (!isRetryableRunError(msg, err)) return "give-up";
  if (isCancelled()) return "cancelled";
  // 只认首轮入场的自己会话号——close 必须带号，绝不 undefined 关「当前」
  const myReconnectSessionId =
    opts.reconnectSessionInstanceId ?? agentSessions.get(task.id)?.instanceId;
  const nextOpts = {
    ...opts,
    reconnectAttempt: attempt,
    reconnectSessionInstanceId: myReconnectSessionId,
  };
  /** 失主让位：不 give-up 标 error、不碰共享状态 */
  const yieldIfOpLost = (): "cancelled" | null =>
    isTaskOpCurrent(opts.opHandle) ? null : "cancelled";

  // 任务已终结（用户重连期间 finalize / 删除）不再折腾
  const fresh = await getTask(task.id);
  {
    const y = yieldIfOpLost();
    if (y) return y;
  }
  if (!fresh || fresh.repoStatus === "merged" || fresh.repoStatus === "abandoned") {
    return "give-up";
  }
  await writeOwnedEventAndPublish(
    task.id,
    () => isTaskOpCurrent(opts.opHandle),
    {
      kind: "info",
      actionId: opts.errorActionId,
      text: `连接中断、正在自动重连（第 ${attempt}/${RECONNECT_MAX} 次）…`,
      // 事件流按 reconnecting 渲染成过程行（spinner、同 thinking / 工具调用一档）
      meta: { kind: "reconnecting", attempt, max: RECONNECT_MAX },
    },
    );
  {
    const y = yieldIfOpLost();
    if (y) return y;
  }
  if (await sleepWithCancel(RECONNECT_BACKOFF_MS[attempt - 1], isCancelled)) {
    return "cancelled";
  }
  {
    const y = yieldIfOpLost();
    if (y) return y;
  }
  // 退避结束、close/resume 之前插桩——矩阵在此注入 advance claim
  await failpoint("reconnect.beforeResume");
  {
    const y = yieldIfOpLost();
    if (y) return y;
  }
  // 旧 agent 连接已死：只关自己入场时的会话实例、保留持久化锚点
  if (myReconnectSessionId !== undefined) {
    closeTaskSession(task.id, undefined, {
      reap: false,
      keepPersisted: true,
      expectedSessionInstanceId: myReconnectSessionId,
    });
  }
  const creds = await readServerCreds();
  // 透传入场 opHandle——resume 禁止自行重拍 identity
  const record = await resumeTaskSession(fresh, creds, {
    closedSessionInstanceId: myReconnectSessionId,
    opHandle: opts.opHandle,
  }).catch(() => null);
  {
    const y = yieldIfOpLost();
    if (y) {
      // 失主必须关掉刚 resume 出的 agent/record——旧实现只 return 会泄漏 A
      if (record) {
        const closed = closeTaskSession(task.id, undefined, {
          reap: false,
          keepPersisted: true,
          expectedSessionInstanceId: record.instanceId,
        });
        if (!closed) {
          try {
            record.agent.close();
          } catch {
            /* noop */
          }
        }
      }
      return y;
    }
  }
  if (!record) {
    // resume 没成（多半仍断网 / 被 CAS 让位）：算一次、继续下一轮退避
    return tryAutoReconnect(fresh, err, nextOpts, isCancelled);
  }
  try {
    // AgentSessionRecord.agent 是结构化最小面、这里收窄回完整实例（同 sendToTaskSession 口径）
    const resumedAgent = record.agent as AgentInstance;
    const reconnectPrompt =
      "（系统消息：刚才网络连接中断、你上一轮回复被打断。请从中断的地方继续当前工作——已完成的部分不用重做；处理完按正常流程交卷 / 提问 / 结束回复。）";
    const perfTracker = createRunPerfTracker({
      taskId: fresh.id,
      agentId: resumedAgent.agentId,
      runKind: "task-reconnect",
      promptBytes: Buffer.byteLength(reconnectPrompt, "utf-8"),
    });
    const run = await resumedAgent.send(reconnectPrompt, {
      onDelta: composeOnDelta(
        perfTracker.onDelta,
        // 重连 send 绑入场 opHandle
        createShellOutputDeltaPublisher(task.id, () =>
          isTaskOpCurrent(opts.opHandle),
        ),
      ),
      onStep: perfTracker.onStep,
    });
    {
      const y = yieldIfOpLost();
      if (y) {
        void run.cancel().catch(() => {
          /* noop */
        });
        return y;
      }
    }
    perfTracker.attachRun(run);
    await writeOwnedEventAndPublish(
      task.id,
      () => isTaskOpCurrent(opts.opHandle),
      {
        kind: "info",
        actionId: opts.errorActionId,
        text: `重连成功（第 ${attempt} 次）、AI 继续工作`,
        meta: { kind: "reconnected", attempt },
      },
    );
    {
      const y = yieldIfOpLost();
      if (y) return y;
    }
    await consumeSessionRun(fresh, resumedAgent, run, {
      ...opts,
      reconnectAttempt: attempt,
    });
    return "handled";
  } catch (sendErr) {
    // send 又失败（网络还没恢复）：继续下一轮
    {
      const y = yieldIfOpLost();
      if (y) return y;
    }
    return tryAutoReconnect(fresh, sendErr, nextOpts, isCancelled);
  }
};

/**
 * run 失败（SDK 抛错 / status=error）的统一收尾：标 error + 事件 + publish。
 *
 * 不同 action 时 currentActionId 已是 B → 不写 task 级 error，只精确标自己 action。
 * / V12：同 action 双唤醒时 actionId 不是 operation 身份——必须校验 opHandle；
 *   已失去 op owner → 只落绑定 actionId 的 error 事件，不 patch action、不碰 task 状态。
 * 失去 owner（opHandle 或条件写返 null）时不发 task 级 done(false)/error envelope，
 *   否则前端会清后继 B 的 streamingText 并弹整任务失败 toast。
 * V12：runningTasks.instanceId 不再参与状态写门控（接管者必 claim、opHandle 已覆盖）。
 */
export const handleRunFailure = async (
  taskId: string,
  errorActionId: string | undefined,
  err: unknown,
  opts?: {
    /** V12：启动链 / consume 的 op handle（owner 或 observer） */
    opHandle?: TaskOpHandle;
  },
): Promise<void> => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[task-runner] task=${taskId} run failed:`, err);
  // run 失败可能是「缓存 ok 期间 MCP 挂了」——清探测缓存、用户重试时必真探（不再连撞过期 ok）
  invalidateMcpProbeCache();
  // 归一成给用户看的文案：长连接被断（最常见）→ 友好一句话、不加吓人前缀；
  // 其它有诊断的错（认证 / 限流 / MCP / 协议）→ 带详情、加「失败」前缀。原始 err 已 console.error。
  const failure = summarizeRunFailure(message, err);
  const eventText = failure.isConnectionDrop
    ? failure.text
    : `Task agent 失败：${failure.text}`;

  // / V12：**唯一**的复合 owner 闭包——只认 isOpOwner(opHandle)；
  // 无 handle 时退化为「无 lifecycle」（兼容旧测试直接调无 opts 的路径）。
  // 条件事务锁内复查、null 分类、每个全局 envelope 的最后一步都只用它。
  const isOwner = (): boolean =>
    opts?.opHandle
      ? isOpOwner(opts.opHandle)
      : getChatLifecycle(taskId) === null;

  // 入口快查——已失去 owner → 旧启动只写事件，绝不碰 action / task 状态
  if (!isOwner()) {
    // 只落绑定 actionId 的 error 事件（writeEventAndPublish = event envelope）
    // eslint-disable-next-line no-restricted-syntax -- 豁免：/ 语义——失主 A 仍落绑定自己 actionId 的失败审计事件、不碰共享状态
    await writeEventAndPublish(taskId, {
      kind: "error",
      actionId: errorActionId,
      text: eventText,
      meta: { detail: failure.detail },
    });
    return;
  }

  await failpoint("failure.beforePrepare");

  // 是否仍持有 task 级写权限（条件写成功才发 done/error envelope）
  let wroteTaskLevel = false;

  if (errorActionId) {
    // 一把条件写 action+runStatus；currentActionId 已是 B → 返 null，再精确 patch 自己
    // expected 除 currentActionId 外再验 actionStatus=running——stop 已把 action
    // 标 cancelled 时结构条件直接拒绝，A 不会把用户停止改写成 error。
    const updated = await patchActionAndRunStatusIfOpFresh(
      taskId,
      errorActionId,
      "error",
      "error",
      isOwner,
      { currentActionId: errorActionId, actionStatus: "running" },
    );
    if (!updated) {
      // null 分类必须用同一复合 isOwner——
      // ① 仍是完整 owner（结构条件不符：currentActionId 已指向不同 action 的后继、
      //    或 action 已非 running）：只在「action 仍挂 running 且不是共享指针」时
      //    精确标自己 error（A 独占旧 action、安全）；
      // ② owner 维度失败：绝不 finalize——同 action 后继共享 actionId、
      //    stop 已写 cancelled，都不能被改写。
      if (isOwner()) {
        const freshAfterNull = await getTask(taskId);
        const ownAction = freshAfterNull?.actions.find(
          (a) => a.id === errorActionId,
        );
        const isSharedPointer =
          freshAfterNull?.currentActionId === errorActionId;
        if (
          isOwner() &&
          ownAction?.status === "running" &&
          !isSharedPointer
        ) {
          await finalizeOwnAction(taskId, errorActionId, "error");
        }
      }
    } else {
      wroteTaskLevel = true;
    }
  } else if (opts?.opHandle) {
    // 有 handle、无绑定 action——条件写 idle/error，失主返 null
    const updated = await setTaskRunStatusIfRunOwner(
      taskId,
      "error",
      isOwner,
      null,
    );
    wroteTaskLevel = !!updated;
  } else {
    // 无绑定 action 且无 handle（极少）——保持原语义
    await setTaskRunStatus(taskId, "error", null);
    wroteTaskLevel = true;
  }

  // eslint-disable-next-line no-restricted-syntax -- 豁免：/ 语义——失败审计事件绑定自己 actionId、途中失主也要落（共享状态与 envelope 另有 owner 门控）
  await writeEventAndPublish(taskId, {
    kind: "error",
    actionId: errorActionId,
    text: eventText,
    // 原始诊断落 meta（UI 不展示、事后从 events.jsonl 定位额度 vs 连接断）
    meta: { detail: failure.detail },
  });

  // 失去 task owner → 不发 done(false) / error envelope（事件已挂自己的 actionId）
  // 写盘成功 ≠ 现在还是 owner——event/getTask 每个 await 后都用
  // 同一复合 isOwner 重验。
  if (!wroteTaskLevel || !isOwner()) return;

  await failpoint("failure.beforePublish");

  const errored = await getTask(taskId);
  if (!isOwner()) return;
  if (errored) publish(taskId, { kind: "done", task: errored, ok: false });
  publish(taskId, { kind: "error", message: eventText });
};

/**
 * 问一问 run 收尾：按当前 action 状态把 runStatus 归回「提问前」的等待位
 * （awaiting_ack → awaiting_user、error → error、其余 → idle）。
 * 只在 runStatus 还挂 running 时动手（compare-set、不覆盖 notifier 已落的状态）。
 *
 * 调用方须先过 `shouldRestoreAfterQuestion`——gen stale / lifecycle 进行中时
 * 禁止调用（stop/DELETE 已归位；裸 restore 会把后继 B 的 running 打回 idle）。
 *
 * 再加 isOwner（runningTasks.instanceId）锁内条件写——前驱 one-shot 被接管后
 * 不得按最新 action B 把 task 写成 idle。
 */
const restoreRunStatusAfterQuestion = async (
  taskId: string,
  isOwner: () => boolean,
): Promise<void> => {
  const fresh = await getTask(taskId);
  if (!fresh || fresh.runStatus !== "running") return;
  const cur = fresh.actions.find((a) => a.id === fresh.currentActionId);
  const target =
    cur?.status === "awaiting_ack"
      ? ("awaiting_user" as const)
      : cur?.status === "error"
        ? ("error" as const)
        : ("idle" as const);
  const updated = await setTaskRunStatusIfRunOwner(
    taskId,
    target,
    isOwner,
    cur?.id ?? null,
  );
  if (updated) publish(taskId, { kind: "task", task: updated });
};

/**
 * V12：question stale 场景是否允许 restore。
 * 唯一入口 isOpOwner——失主（后继 claim / stop revoke / lifecycle）一律 false。
 */
const shouldRestoreAfterQuestion = (handle: TaskOpHandle): boolean =>
  isOpOwner(handle);

/**
 * 消费一个 SDK run 的完整生命周期（流式事件 → 终态处理）。
 *
 * V0.11 语义：run 自然 finished 是**正常出口**（agent 交卷 / 提问 / 说完了就该结束 turn）。
 * 「最后一个 action 还在 running、且没有 check 在跑、也没有 ask 在等答案」时：
 * 先 `agent.send` 追问补交卷（每 action 最多 2 次、替代已退役的 stop hook）；
 * 追问仍不交卷 → 标 error + 关会话。
 * 会话（agent 实例）在 finished 后保留、用户下一步操作用 send 续接；cancel / error 才关会话。
 *
 * opts.questionRun（V0.11.9）：这个 run 是「问一问」纯答疑——**任何出口都不动 action**
 * （停止 / 失败也不把 awaiting_ack 审阅位打成 cancelled/error）、不关会话、只把 runStatus 归位。
 */
// 每 action 追问交卷次数（防 agent 反复空跑死循环；key = `${taskId}:${actionId}`）
// 挂 globalThis：跟 advanceChains 同构——dev 下不同 route chunk 各持一份 module Map
// 会让计数失效 / 追问上限形同虚设（V0.6.27 踩过）
const SUBMIT_WORK_FOLLOWUP_COUNTS_KEY = "__flowshipSubmitWorkFollowupCountsV1__";
const getSubmitWorkFollowupCounts = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[SUBMIT_WORK_FOLLOWUP_COUNTS_KEY]) {
    g[SUBMIT_WORK_FOLLOWUP_COUNTS_KEY] = new Map();
  }
  return g[SUBMIT_WORK_FOLLOWUP_COUNTS_KEY]!;
};
const submitWorkFollowupCounts = getSubmitWorkFollowupCounts();
const SUBMIT_WORK_FOLLOWUP_MAX = 2;

/** 清掉某 task 名下所有交卷追问计数（停止 / 推进 cancelled 出口用） */
const clearSubmitWorkFollowupCounts = (taskId: string): void => {
  for (const k of [...submitWorkFollowupCounts.keys()]) {
    if (k.startsWith(`${taskId}:`)) submitWorkFollowupCounts.delete(k);
  }
};

/**
 * 关启动链资源（杀 run / 关会话 / 摘 agent）——pending 与 lifecycle 两支共用。
 * 不写 action 状态 / runStatus / 停止事件（那部分看谁是收尾 owner）。
 *
 * @param expectedSessionInstanceId 关会话时精确匹配；缺省则仅当
 *   agentSessions 里的 agent 对象仍是本实例时才取号关（防 resume 同 agentId 误关 B）
 */
const closeStartChainResourcesForStop = (
  task: Task,
  agent: AgentInstance,
  run?: SessionRun,
  expectedSessionInstanceId?: number,
): void => {
  pendingStopRequests.delete(task.id);
  if (run) {
    void run.cancel().catch(() => {
      /* noop */
    });
  }
  const sess = agentSessions.get(task.id);
  // 会话已被后继替换（同 agentId 不同对象 / 不同 instanceId）→ 只关本地 agent
  const sid =
    expectedSessionInstanceId ??
    (sess && sess.agent === agent ? sess.instanceId : undefined);
  if (sess && sess.agent !== agent) {
    try {
      agent.close();
    } catch {
      /* noop */
    }
    clearSubmitWorkFollowupCounts(task.id);
    return;
  }
  // 有会话走身份+instanceId 门控关；create 后尚未 register 则直接 close agent
  if (!closeTaskSession(task.id, agent.agentId, { expectedSessionInstanceId: sid })) {
    try {
      agent.close();
    } catch {
      /* noop */
    }
    // 关失败且带了精确实例号（或会话已被替换）→ 锚点归当前 owner，不得清
    // 仅「无会话且未要求精确 instance」才清（create 后尚未 register 的真结束路径）
    if (sid === undefined && !agentSessions.get(task.id)) {
      void setTaskSessionAgentId(task.id, undefined);
    }
  }
  clearSubmitWorkFollowupCounts(task.id);
};

/**
 * 启动窗口停止请求生效。
 *
 * 命中条件：pendingStopRequests 或 getChatLifecycle !== null
 *   或 opGen 与当前 generation 不匹配（V1：stop 已完成并释放 lifecycle 的场景）。
 * - lifecycle 进行中 / gen 不匹配：只关资源，勿重复收尾（状态/事件归 stop/DELETE owner；
 *   gen 不匹配时 lifecycle 已空，补发 done 让 UI 解挂）
 * - 仅 pending：历史上由启动链写收尾；若 stop 已把 runStatus 置 idle（飞行窗口
 *   留下的 pending），则跳过重复事件，只关资源
 *
 * @returns true = 命中、已处理，调用方应直接 return、勿进消费循环
 */
const applyPendingStopIfRequested = async (
  task: Task,
  agent: AgentInstance,
  run?: SessionRun,
  opGen?: number,
  /** 本 run 绑定的 action；只 patch 它，不扫全表 */
  ownActionId?: string,
  expectedSessionInstanceId?: number,
  /** 有则 done 走 publishIfCurrent；失主（B takeover）不发 done */
  opHandle?: TaskOpHandle,
): Promise<boolean> => {
  const pending = pendingStopRequests.has(task.id);
  const lifecycle = getChatLifecycle(task.id);
  const genStale =
    opGen !== undefined && getTaskOpGeneration(task.id) !== opGen;
  if (!pending && lifecycle === null && !genStale) return false;

  closeStartChainResourcesForStop(
    task,
    agent,
    run,
    expectedSessionInstanceId,
  );

  /** done 门控——有 opHandle 用 isTaskOpCurrent；否则用 gen 未 stale */
  const stillCurrentForDone = (): boolean =>
    opHandle
      ? isTaskOpCurrent(opHandle)
      : opGen === undefined || getTaskOpGeneration(task.id) === opGen;

  // lifecycle 进行中或 gen 已 bump：状态和停止事件由 stop/DELETE owner 写
  if (lifecycle !== null || genStale) {
    // gen 不匹配且 lifecycle 已释放：owner 收尾已写完，只补 done 解挂 UI
    // 后继已 claim 则不发（失主不得清 B 的 streamingText）
    if (genStale && lifecycle === null) {
      const fresh = await getTask(task.id);
      publishIfCurrent(task.id, stillCurrentForDone, {
        kind: "done",
        task: fresh ?? task,
        ok: true,
      });
    }
    return true;
  }

  // 仅 pending：stop 可能已在飞行窗口写完收尾并留下标记——已 idle 则勿再写事件
  const fresh = await getTask(task.id);
  const own = ownActionId
    ? fresh?.actions.find((a) => a.id === ownActionId)
    : undefined;
  const ownStillOpen =
    !!own && (own.status === "running" || own.status === "awaiting_ack");
  if (fresh?.runStatus === "idle" && !ownStillOpen) {
    publishIfCurrent(task.id, stillCurrentForDone, {
      kind: "done",
      task: fresh,
      ok: true,
    });
    return true;
  }

  // 只收尾本 run 的 action（启动窗口停止 = 本 agent 自己的启动意图）
  await finalizeOwnAction(task.id, ownActionId, "cancelled");
  const sess = agentSessions.get(task.id);
  const stillMine =
    !sess || sess.agent === agent || sess.agentId !== agent.agentId;
  const updated = stillMine
    ? await setTaskRunStatusIfRunOwner(
        task.id,
        "idle",
        () => {
          const s = agentSessions.get(task.id);
          return !s || s.agent === agent;
        },
      )
    : null;
  // 用户 stop 生效通知——温和门控失主不写（不影响过渡语义）
  if (stillCurrentForDone()) {
    // eslint-disable-next-line no-restricted-syntax -- 用户 stop 操作生效通知
    await writeEventAndPublish(task.id, {
      kind: "info",
      text: "停止请求已生效（启动期间点击的停止）",
    });
  }
  // setTaskRunStatusIfRunOwner 返 null 不再兜底 publish(updated ?? task)
  if (updated) publish(task.id, { kind: "task", task: updated });
  publishIfCurrent(task.id, stillCurrentForDone, {
    kind: "done",
    task: updated ?? fresh ?? task,
    ok: true,
  });
  return true;
};

const buildSubmitWorkFollowup = (last: {
  id: string;
  type: string;
  n: number;
  artifactPath?: string | null;
}): string =>
  [
    "[Flowship] 你还没对当前 action 交卷——不要结束本次回复。",
    `当前 action：id=${last.id}、type=${last.type}、n=${last.n}。`,
    last.artifactPath ? `artifact 路径：${last.artifactPath}。` : "",
    "请完成收尾并调用 submit_work（传 task_id / action_id / artifact_path）交卷；若卡在某处、如实说明卡在哪。",
  ]
    .filter(Boolean)
    .join("\n");

const consumeSessionRun = async (
  task: Task,
  agent: AgentInstance,
  run: SessionRun,
  opts: {
    errorActionId?: string;
    questionRun?: boolean;
    // V0.13.x 自动重连计数（tryAutoReconnect 递归时递增、防无限重连）
    reconnectAttempt?: number;
    /**
     * V12：op handle 必传——owner（启动链 claim）或 observer（ask/one-shot 快照）。
     * 状态写门控走 isOpOwner；observer 的 release 是 no-op。
     */
    opHandle: TaskOpHandle;
  },
): Promise<void> => {
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;
  // 复用链内预登记的 instanceId（one-shot / internalStart 出链前已 set）；
  // 无预登记则稍后 alloc。比 agentId 精确——resume 同持久化 agent 时 agentId 相同。
  const preRegistered = runningTasks.get(task.id);
  let myInstanceId: number | undefined =
    preRegistered?.agentId === agent.agentId
      ? preRegistered.instanceId
      : undefined;
  // 按 agent 对象引用捕获 session instanceId——仅 agentId 会在 resume 同号时
  // 误抓到 B 的 instanceId，随后 closeMySession 反而精确关掉 B。
  const sessionAtStart = agentSessions.get(task.id);
  const mySessionInstanceId: number | undefined =
    sessionAtStart && sessionAtStart.agent === agent
      ? sessionAtStart.instanceId
      : undefined;

  /** 当前 runningTasks 是否仍是本 consume 登记的那条 record（仅资源归属、不参与状态写门控） */
  const iOwnRunner = (): boolean => {
    if (myInstanceId === undefined) return false;
    const cur = runningTasks.get(task.id);
    return !!cur && cur.instanceId === myInstanceId;
  };

  /**
   * / V12：op 是否已被后继 claim / revoke 覆盖。同 action 的 resume 接管时
   * actionId / currentActionId 全都不变（的全局 lastAction 比对识别不了），
   * 自然结束后的追问 / error 收尾必须靠 isTaskOpCurrent 区分新旧启动意图。
   * 注意：此处不含 lifecycle（入口 stop-signal 用 isOpOwner）；失主 = 换主语义。
   */
  const lostStartOwner = (): boolean => !isTaskOpCurrent(opts.opHandle);

  /**
   * 按 session instanceId 关自己的会话。
   * 入场时拿不到精确实例号（session 已不是本 agent 对象）→ fail-closed 只关本地，
   * 绝不把 undefined 传给 closeTaskSession（那会退化成按 agentId 关当前）。
   */
  const closeMySession = (): void => {
    if (mySessionInstanceId === undefined) {
      try {
        agent.close();
      } catch {
        /* noop */
      }
      return;
    }
    closeTaskSession(task.id, agent.agentId, {
      expectedSessionInstanceId: mySessionInstanceId,
    });
  };

  /**
   * 已被 forceClear + 后继 B 接管时，只 cancel/close 自己的 run/agent，
   * 绝不 finalize 全表 / 裸写 idle / 无 instanceId 门控 closeTaskSession。
   * @returns true = 已让位、调用方应立即 return
   */
  const yieldIfSuperseded = (): boolean => {
    const cur = runningTasks.get(task.id);
    const superseded =
      myInstanceId !== undefined
        ? !cur || cur.instanceId !== myInstanceId
        : !!cur && cur.agentId !== agent.agentId;
    if (!superseded) return false;
    void run.cancel().catch(() => {
      /* noop */
    });
    closeMySession();
    return true;
  };

  try {
    // 同 gen claim（B 尚未登记 runner）时 isTaskOpCurrent=false——
    // 必须纯让位（cancel + 只关自己 session），绝不 restore / applyPendingStop 走共享写。
    if (!isTaskOpCurrent(opts.opHandle)) {
      void run.cancel().catch(() => {
        /* noop */
      });
      closeMySession();
      return;
    }
    // 消费循环开始前：启动窗口点的停止在此生效（含 advance 续接 send 路径）
    // V12：lifecycle / pendingStopRequests；op 失主已在上面纯让位
    const stopSignal =
      pendingStopRequests.has(task.id) || !isOpOwner(opts.opHandle);
    if (stopSignal) {
      // 若预登记已被强清换主，只关自己
      if (yieldIfSuperseded()) return;
      // 问一问 run：不动 action / 不关会话（与下方 cancelled 分支同语义）
      if (opts.questionRun) {
        pendingStopRequests.delete(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
        // 失主纯让位——不 restore、不发 done
        if (lostStartOwner()) return;
        // 共享状态门控走 handle；iOwnRunner 只删自己记录
        if (shouldRestoreAfterQuestion(opts.opHandle)) {
          await restoreRunStatusAfterQuestion(task.id, () =>
            isTaskOpCurrent(opts.opHandle),
          );
        }
        const freshQ = await getTask(task.id);
        // restore/getTask await 后、publish done 前复查
        await failpoint("question.beforeDone");
        if (lostStartOwner()) return;
        publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
        return;
      }
      if (
        await applyPendingStopIfRequested(
          task,
          agent,
          run,
          opts.opHandle.gen,
          opts.errorActionId,
          mySessionInstanceId,
          opts.opHandle,
        )
      ) {
        return;
      }
    }

    myInstanceId = myInstanceId ?? allocTaskRunInstanceId();
    runningTasks.set(task.id, {
      instanceId: myInstanceId,
      agentId: agent.agentId,
      startedAt: Date.now(),
      startSnapshot: captureTaskFieldsSnapshot(task),
      cancel: () => {
        cancelled = true;
        cancelPending(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
      },
    });

    hardTimer = setTimeout(() => {
      cancelled = true;
      cancelPending(task.id);
      void run.cancel().catch(() => {
        /* noop */
      });
    }, TASK_HARD_TIMEOUT_MS);

    // 流式消费
    const assistantCtx: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {
        const trimmed = assistantCtx.buffer.trim();
        assistantCtx.buffer = "";
        if (trimmed.length === 0) return;
        // flush 走 owned sink——opHandle lease 必填、失主不落盘
        await writeOwnedEventAndPublish(
          task.id,
          () => isTaskOpCurrent(opts.opHandle),
          {
            kind: "assistant_message",
            actionId: undefined,
            text: trimmed,
          },
        );
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
      // 流回调绑 operation——lease 必传、失主整条消息丢弃
      await handleSdkMessage(task.id, msg, assistantCtx, () =>
        isTaskOpCurrent(opts.opHandle),
      );
    }
    // stream 结束后 flush 也绑 op——失主跳过，避免迟到 assistant_message
    if (!lostStartOwner()) {
      await assistantCtx.flush();
    }

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    const result = await run.wait();
    await failpoint("consume.afterWait");

    if (cancelled || result.status === "cancelled") {
      // 5s 强清后 B 已接管——不得 finalize / 写 idle / 关 B 的会话
      if (yieldIfSuperseded()) return;
      // 停止 / 推进：追问计数一并清掉，避免下次同 action 续跑还背着旧计数
      clearSubmitWorkFollowupCounts(task.id);
      const isForkPending = forkPendingTasks.has(task.id);
      if (isForkPending) {
        forkPendingTasks.delete(task.id);
        // 换新 agent：会话由 advance 的 force-new 分支显式关（reap:false）、这里不动
        // 温和门控——失主不写；forkPending 时 handle 仍 current、不受影响
        if (isTaskOpCurrent(opts.opHandle)) {
          // eslint-disable-next-line no-restricted-syntax -- force-new 换主过渡通知
          await writeEventAndPublish(task.id, {
            kind: "info",
            text: "旧 agent 已收尾、正在为推进起新 agent...",
          });
        }
        return;
      }
      // 问一问的 run 被停：只是不想听它说了——action / 会话都不动、runStatus 归回等待位
      // gen stale 或已非 owner 时勿 restore
      if (opts.questionRun) {
        // 失主不 restore、不发 done（前端收 done 会清后继 streamingText）
        if (lostStartOwner()) return;
        if (shouldRestoreAfterQuestion(opts.opHandle)) {
          await restoreRunStatusAfterQuestion(task.id, () =>
            isTaskOpCurrent(opts.opHandle),
          );
        }
        const freshQ = await getTask(task.id);
        // await 后复查再发 done
        await failpoint("question.beforeDone");
        if (lostStartOwner()) return;
        publishIfCurrent(
          task.id,
          () => isTaskOpCurrent(opts.opHandle),
          { kind: "done", task: freshQ ?? task, ok: true },
        );
        return;
      }
      // 正常 cancel（停止 / 硬超时触发）→ 只收尾本 run 绑定的 action + 关运行时状态 + 关会话
      // 不得 finalizeStaleActions 全表扫（会把后继 B 的新 action 一并 cancelled）
      // done 走 publishIfCurrent——B takeover 后失主不发 done envelope
      if (yieldIfSuperseded()) return;
      await finalizeOwnAction(task.id, opts.errorActionId, "cancelled");
      // 锁内 instanceId CAS——await 期间被接管则不写 idle
      const updated = await setTaskRunStatusIfRunOwner(
        task.id,
        "idle",
        () => isTaskOpCurrent(opts.opHandle),
      );
      if (updated) publish(task.id, { kind: "task", task: updated });
      publishIfCurrent(
        task.id,
        () => isTaskOpCurrent(opts.opHandle),
        { kind: "done", task: updated ?? task, ok: true },
      );
      closeMySession();
      return;
    }

    if (result.status !== "finished") {
      const resultDump = stringifyMeta(result).slice(0, 1500);
      const sdkErr = assistantCtx.sdkErrorMessage
        ? `\n--- SDK stream error message ---\n${assistantCtx.sdkErrorMessage}`
        : "";
      // result.result 是 SDK 给的最终文本/诊断：非空就 inline 到 status 后、
      // 这样 summarizeRunFailure 的「裸 error」正则自然不命中、诊断不会被当连接断吞掉
      const inlineResult =
        typeof result.result === "string" && result.result.trim()
          ? `: ${result.result.slice(0, 200)}`
          : "";
      throw new Error(
        `agent run status=${result.status}${inlineResult}${sdkErr}\n--- SDK result dump ---\n${resultDump}`,
      );
    }

    // V0.11：run 自然 finished = 正常出口。判定 agent 这轮是否「有交代」：
    //   - 交卷了（notifier 同步注册的后置 check 在跑 / action 已 awaiting_ack）→ 正常
    //   - 提问了（pendingAsk 在等用户答）→ 正常
    //   - 问一问 / 终态 task → 不动 action、不追问
    //   - 都没有、最后一个 action 还挂 running → send 追问补交卷（每 action ≤2 次）；
    //     追问仍不交卷 → 标 error + 关会话（语义对齐原 stop-check）
    await failpoint("consume.beforeFinalize");
    const fresh = await getTask(task.id);
    // 同 action 的后继（resume 双唤醒）接管时 actionId 完全相同、下面的
    // 全局 lastAction 比对识别不了——wait/getTask 的 await 期间 startToken 被
    // 覆盖 → 本 run 的自然结束不做任何业务收尾（不追问、不标 error、不写状态），
    // 直接让位给新启动意图。
    // questionRun 也让位（不 restore、不发 done）——旧实现被 !questionRun 排除
    if (lostStartOwner()) {
      console.warn(
        `[task-runner] task=${task.id} run finished 但 start owner 已被后继接管、让位（不追问 / 不收尾${opts.questionRun ? " / 不发 done" : ""}）`,
      );
      return;
    }
    const globalLastAction = fresh?.actions[fresh.actions.length - 1];
    // 业务收尾只认入场绑定的 opts.errorActionId，不认全局 actions.at(-1)——
    // advance B 先 append 新 action、之后才 cancel 旧 run A；A 在这个窗口自然 finished
    // 时全局最后一条已是 B，旧逻辑会拿 B 当「自己的 lastAction」：用 A 的旧 session
    // 追问「为 B 交卷」、追问失败还把 B patch 成 error + 关会话。
    // 全局最新 action 已不是自己绑定的 → 立即让位：只收自己的 action、不追问、
    // 不写 task 级状态、不发全局 envelope（B 的启动链接管一切）。
    if (
      !opts.questionRun &&
      opts.errorActionId &&
      globalLastAction &&
      globalLastAction.id !== opts.errorActionId
    ) {
      console.warn(
        `[task-runner] task=${task.id} run finished 但全局最新 action=${globalLastAction.id} 已非本 run 绑定的 ${opts.errorActionId}、让位后继`,
      );
      const ownAfterFinish = fresh?.actions.find(
        (a) => a.id === opts.errorActionId,
      );
      // 自己的 action 还挂 running 且没有在飞的交卷 check → 收成 cancelled
      // （后继 append 后没人替它收；patch 的是 A 独占的旧 action、不伤 B）。
      // 交卷 check 在飞则不动——postCheck 会把它落到 awaiting_ack / completed。
      const ownCheckInFlight =
        runningChecks.get(task.id)?.actionId === opts.errorActionId;
      if (
        ownAfterFinish &&
        ownAfterFinish.status === "running" &&
        !ownCheckInFlight
      ) {
        await finalizeOwnAction(task.id, opts.errorActionId, "cancelled");
      }
      submitWorkFollowupCounts.delete(`${task.id}:${opts.errorActionId}`);
      return;
    }
    const lastAction = opts.errorActionId
      ? (fresh?.actions.find((a) => a.id === opts.errorActionId) ??
        globalLastAction)
      : globalLastAction;
    const checkInFlight =
      !!lastAction && runningChecks.get(task.id)?.actionId === lastAction.id;
    const askPending = !!getPendingAsk(task.id);
    const taskTerminal =
      fresh?.repoStatus === "merged" || fresh?.repoStatus === "abandoned";
    if (
      !opts.questionRun &&
      !taskTerminal &&
      lastAction &&
      lastAction.status === "running" &&
      !checkInFlight &&
      !askPending
    ) {
      const followupKey = `${task.id}:${lastAction.id}`;
      const used = submitWorkFollowupCounts.get(followupKey) ?? 0;
      // 会话还活着才追问（被关则走下面的 error 收尾）
      // 按 session instanceId 判活——resume 同 agentId 的后继不算本会话
      const sessionAlive = (() => {
        const s = agentSessions.get(task.id);
        if (!s) return false;
        if (mySessionInstanceId !== undefined) {
          return s.instanceId === mySessionInstanceId;
        }
        return s.agentId === agent.agentId;
      })();
      if (used < SUBMIT_WORK_FOLLOWUP_MAX && sessionAlive) {
        submitWorkFollowupCounts.set(followupKey, used + 1);
        const followup = buildSubmitWorkFollowup(lastAction);
        console.log(
          `[task-runner] task=${task.id} action#${lastAction.n}(${lastAction.type}) 未交卷 → send 追问 ${used + 1}/${SUBMIT_WORK_FOLLOWUP_MAX}`,
        );
        // owner 语境（consume 链）——opHandle lease（验收点名残留）
        await writeOwnedEventAndPublish(
          task.id,
          () => isTaskOpCurrent(opts.opHandle),
          {
            kind: "info",
            actionId: lastAction.id,
            text: `未交卷，正在追问 agent 补调 submit_work（${used + 1}/${SUBMIT_WORK_FOLLOWUP_MAX}）…`,
          },
        );
        // 写事件 ↔ send 之间有 1~3s 窗口：用户此刻点「停止」会 closeTaskSession，
        // 推进 force-new 会换 agentId / session instanceId。
        const stillOwnSession = (() => {
          const s = agentSessions.get(task.id);
          if (!s) return false;
          if (mySessionInstanceId !== undefined) {
            return s.instanceId === mySessionInstanceId;
          }
          return s.agentId === agent.agentId;
        })();
        // 同 action 后继在写事件的 await 期间 claim——session/actionId 都
        // 分不出新旧，追问前一并验 startToken、失主即让位
        if (lostStartOwner()) return;
        if (cancelled || !stillOwnSession) {
          submitWorkFollowupCounts.delete(followupKey);
          // 强清换主后不得走普通停止收尾
          if (yieldIfSuperseded()) return;
          if (forkPendingTasks.has(task.id)) {
            forkPendingTasks.delete(task.id);
            // 温和门控——失主不写
            if (isTaskOpCurrent(opts.opHandle)) {
              // eslint-disable-next-line no-restricted-syntax -- force-new 换主过渡通知
              await writeEventAndPublish(task.id, {
                kind: "info",
                text: "旧 agent 已收尾、正在为推进起新 agent...",
              });
            }
            return;
          }
          // 只 patch 本 action + 锁内 owner 写 idle；done 走 publishIfCurrent
          await finalizeOwnAction(task.id, opts.errorActionId, "cancelled");
          const updated = await setTaskRunStatusIfRunOwner(
            task.id,
            "idle",
            () => isTaskOpCurrent(opts.opHandle),
          );
          if (updated) publish(task.id, { kind: "task", task: updated });
          publishIfCurrent(
            task.id,
            () => isTaskOpCurrent(opts.opHandle),
            { kind: "done", task: updated ?? task, ok: true },
          );
          closeMySession();
          return;
        }
        let nextRun: SessionRun;
        try {
          const perfTracker = createRunPerfTracker({
            taskId: task.id,
            agentId: agent.agentId,
            runKind: "task-submit-followup",
            promptBytes: Buffer.byteLength(followup, "utf-8"),
          });
          nextRun = await agent.send(followup, {
            onDelta: composeOnDelta(
              perfTracker.onDelta,
              // 交卷追问绑 consume 的 opHandle
              createShellOutputDeltaPublisher(task.id, () =>
                isTaskOpCurrent(opts.opHandle),
              ),
            ),
            onStep: perfTracker.onStep,
          });
          perfTracker.attachRun(nextRun);
        } catch (err) {
          console.error(
            `[task-runner] task=${task.id} 交卷追问 send 失败`,
            err,
          );
          // stop / force-new 导致的 send 失败：按 cancelled 收尾，绝不能标 error 覆盖
          if (cancelled || forkPendingTasks.has(task.id)) {
            submitWorkFollowupCounts.delete(followupKey);
            // 强清换主后不得走普通停止收尾
            if (yieldIfSuperseded()) return;
            if (forkPendingTasks.has(task.id)) {
              forkPendingTasks.delete(task.id);
              // 温和门控——失主不写
              if (isTaskOpCurrent(opts.opHandle)) {
                // eslint-disable-next-line no-restricted-syntax -- force-new 换主过渡通知
                await writeEventAndPublish(task.id, {
                  kind: "info",
                  text: "旧 agent 已收尾、正在为推进起新 agent...",
                });
              }
              return;
            }
            await finalizeOwnAction(task.id, opts.errorActionId, "cancelled");
            const updated = await setTaskRunStatusIfRunOwner(
              task.id,
              "idle",
              () => isTaskOpCurrent(opts.opHandle),
            );
            if (updated) publish(task.id, { kind: "task", task: updated });
            publishIfCurrent(
              task.id,
              () => isTaskOpCurrent(opts.opHandle),
              { kind: "done", task: updated ?? task, ok: true },
            );
            closeMySession();
            return;
          }
          // 真·网络 / SDK 失败 → 跟追问耗尽一样收尾
          submitWorkFollowupCounts.delete(followupKey);
          if (yieldIfSuperseded()) return;
          // 同 action 后继已 claim → 不得把共享 action 标 error
          if (lostStartOwner()) return;
          // 入口查过 lostStartOwner 但 patch 是 await——owner 闭包进锁内/
          // finalGuard 复查（B 在 await 期间 claim 时不标共享 action error）
          await patchActionIfOwner(
            task.id,
            lastAction.id,
            { status: "error" },
            () => isTaskOpCurrent(opts.opHandle),
            { actionStatus: "running" },
          );
          await setTaskRunStatusIfRunOwner(
            task.id,
            "error",
            () => isTaskOpCurrent(opts.opHandle),
            lastAction.id,
          );
          // owner 语境（consume 链）——opHandle lease（验收点名残留）
          await writeOwnedEventAndPublish(
            task.id,
            () => isTaskOpCurrent(opts.opHandle),
            {
              kind: "error",
              actionId: lastAction.id,
              text: [
                `agent 在 action ${lastAction.type} n=${lastAction.n} 没交卷就结束了，且追问失败`,
                "",
                "下一步：在底部输入条说句话即可唤醒本阶段继续、或重新「推进」",
              ].join("\n"),
            },
          );
          const updated = await getTask(task.id);
          if (updated) publish(task.id, { kind: "task", task: updated });
          // 迟到 done(ok=false) 不得清后继 B 的 streaming——publishIfCurrent
          publishIfCurrent(task.id, () => isTaskOpCurrent(opts.opHandle), {
            kind: "done",
            task: updated ?? task,
            ok: false,
          });
          closeMySession();
          return;
        }
        // 追问本身也是一轮 run、走同一管道（计数已 +1、再未交卷会再追或标 error）
        await consumeSessionRun(task, agent, nextRun, opts);
        return;
      }
      // 追问次数用尽 / 会话已死 → 标 error + 关会话
      submitWorkFollowupCounts.delete(followupKey);
      if (yieldIfSuperseded()) return;
      // 同 action 后继已 claim → 不得把共享 action 标 error
      if (lostStartOwner()) return;
      // 同上——owner 闭包进锁内复查、不靠入口一次性检查
      await patchActionIfOwner(
        task.id,
        lastAction.id,
        { status: "error" },
        () => isTaskOpCurrent(opts.opHandle),
        { actionStatus: "running" },
      );
      await setTaskRunStatusIfRunOwner(
        task.id,
        "error",
        () => isTaskOpCurrent(opts.opHandle),
        lastAction.id,
      );
      // owner 语境（consume 链）——opHandle lease（验收点名残留）
      await writeOwnedEventAndPublish(
        task.id,
        () => isTaskOpCurrent(opts.opHandle),
        {
          kind: "error",
          actionId: lastAction.id,
          text: [
            `agent 在 action ${lastAction.type} n=${lastAction.n} 没交卷（没调 submit_work）就结束了回复`,
            "",
            "下一步：在底部输入条说句话即可唤醒本阶段继续、或重新「推进」",
          ].join("\n"),
        },
      );
      const updated = await getTask(task.id);
      if (updated) publish(task.id, { kind: "task", task: updated });
      // 同上——迟到 done(ok=false) 门控
      publishIfCurrent(task.id, () => isTaskOpCurrent(opts.opHandle), {
        kind: "done",
        task: updated ?? task,
        ok: false,
      });
      closeMySession();
      return;
    }
    // 交卷 / ask / 终态成功路径：清掉该 action 的追问计数（若有）
    if (lastAction) {
      submitWorkFollowupCounts.delete(`${task.id}:${lastAction.id}`);
    }

    // 问一问 run 答完：按当前 action 状态归回等待位（含 error 位、比下面的通用兜底全）
    // 答完期间若 stop bump 或已被接管 → 跳过 restore
    if (opts.questionRun) {
      // 失主不发 done（正常结束路径；lostStartOwner 早退已覆盖、此处双保险）
      if (lostStartOwner()) return;
      if (shouldRestoreAfterQuestion(opts.opHandle)) {
        await restoreRunStatusAfterQuestion(task.id, () =>
          isTaskOpCurrent(opts.opHandle),
        );
      }
      const freshQ = await getTask(task.id);
      // await 后复查再发 done
      await failpoint("question.beforeDone");
      if (lostStartOwner()) return;
      publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
      return;
    }

    // 正常结束：交卷已入 check 管道（awaiting_ack / awaiting_user 由 check、notifier 落）、
    // 或 ask 在等答案。会话保留、用户下一步操作 send 续接。
    // 兜底：最后 action 已终态（completed / cancelled / error）而 runStatus 还挂 running → 归 idle
    // 共享状态写一律锁内 owner 条件写
    // 同 action 后继已 claim → 兜底写也让位（iOwnRunner 在接管早期分不出）
    if (lostStartOwner()) return;
    if (
      !lastAction ||
      lastAction.status === "completed" ||
      lastAction.status === "cancelled"
    ) {
      const freshest = await getTask(task.id);
      if (freshest?.runStatus === "running") {
        const updated = await setTaskRunStatusIfRunOwner(
          task.id,
          "idle",
          () => isTaskOpCurrent(opts.opHandle),
          null,
        );
        if (updated) publish(task.id, { kind: "task", task: updated });
      }
    } else if (lastAction.status === "awaiting_ack") {
      // 等审阅期间的续接 run（如 revise 处理完自然结束）兜底回等待位。
      // 正常交卷路径 runStatus 早被 notifier 落成 awaiting_user、这里 compare-set 不动它。
      const freshest = await getTask(task.id);
      if (freshest?.runStatus === "running") {
        const updated = await setTaskRunStatusIfRunOwner(
          task.id,
          "awaiting_user",
          () => isTaskOpCurrent(opts.opHandle),
          lastAction.id,
        );
        if (updated) publish(task.id, { kind: "task", task: updated });
      }
    }
    // 普通 consume done——getTask/条件写 await 后复查再发；A 的迟到 done 不得清 B 的 streamingText
    await failpoint("consume.beforeDone");
    const freshDone = await getTask(task.id);
    publishIfCurrent(
      task.id,
      () => isTaskOpCurrent(opts.opHandle),
      { kind: "done", task: freshDone ?? task, ok: true },
    );
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    if (opts.questionRun) {
      // 失主不发「答疑失败」error / done envelope；写前再复查
      if (lostStartOwner()) return;
      // 问一问失败（网络抖动 / SDK 报错）：只报错误事件 + 归位 runStatus——
      // 绝不把 awaiting_ack 审阅位 / 半路 action 打成 error（答疑失败不该伤任务本体）
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[task-runner] task=${task.id} 问一问 run 失败：`, err);
      if (lostStartOwner()) return;
      // owner 语境（questionRun 收尾）——opHandle lease（验收点名残留）
      await writeOwnedEventAndPublish(
        task.id,
        () => isTaskOpCurrent(opts.opHandle),
        {
          kind: "error",
          text: `答疑失败：${summarizeRunFailure(message, err).text}`,
        },
      );
      // 失败收尾同答完——gen stale / 非 owner 跳过
      if (shouldRestoreAfterQuestion(opts.opHandle)) {
        await restoreRunStatusAfterQuestion(task.id, () =>
          isTaskOpCurrent(opts.opHandle),
        );
      }
      const freshQ = await getTask(task.id);
      await failpoint("question.beforeDone");
      if (lostStartOwner()) return;
      publish(task.id, { kind: "done", task: freshQ ?? task, ok: false });
    } else {
      // V0.13.x：网络类失败先自动重连（重试 5 次、事件流显示「重连中」）——
      // 网络波动一下聊天就断、以前每次都要用户手动唤醒（用户拍板加的）。
      // cancelled = 用户点过停止（run 抛错与 cancel 可能同时到达）→ 按停止语义收尾、
      // 绝不标 error（审计 P1：原来 cancelled 走 give-up 会把用户主动停止标成失败）
      const outcome = cancelled
        ? ("cancelled" as const)
        : await tryAutoReconnect(task, err, opts, () => cancelled);
      if (outcome === "handled") {
        // 重连成功、新 run 已在递归调用里消费完毕——这里什么都不用做
      } else if (outcome === "cancelled") {
        clearSubmitWorkFollowupCounts(task.id);
        // 强清后 B 已接管——只关自己，绝不 finalize 全表 / 裸 close
        if (yieldIfSuperseded()) {
          /* 已让位 */
        } else if (forkPendingTasks.has(task.id)) {
          // force-new 在飞（cancel 旧 run 引发的抛错路径）：新 agent 由 advance 分支管、
          // 这里不动状态、更不能关会话（会误关刚起的新会话）
          forkPendingTasks.delete(task.id);
        } else {
          // 用户在重连期间点了停止：按停止语义收尾（不标 error）。
          // 只 patch 本 action + 锁内 owner 写 + session instanceId 关
          if (yieldIfSuperseded()) return;
          await finalizeOwnAction(task.id, opts.errorActionId, "cancelled");
          const updated = await setTaskRunStatusIfRunOwner(
            task.id,
            "idle",
            () => isTaskOpCurrent(opts.opHandle),
          );
          // 返 null 不兜底 publish；done 走 publishIfCurrent
          if (updated) publish(task.id, { kind: "task", task: updated });
          publishIfCurrent(
            task.id,
            () => isTaskOpCurrent(opts.opHandle),
            { kind: "done", task: updated ?? task, ok: true },
          );
          closeMySession();
        }
      } else {
        // / V12：error 收尾按 opHandle 门控（不再传 iOwnRunner 作状态写门控）
        if (yieldIfSuperseded()) return;
        await handleRunFailure(task.id, opts.errorActionId, err, {
          opHandle: opts.opHandle,
        });
        closeMySession();
      }
    }
  } finally {
    // 按 instanceId 删——forceClear 后 B 换了新号，旧 finally 不得抹掉 B
    if (iOwnRunner()) {
      runningTasks.delete(task.id);
    }
    // V12：正常 / 失败收尾都 release——owner 匹配才删；observer 内部 no-op
    releaseTaskOpIf(opts.opHandle);
    // 会话活跃时间戳（空闲回收 TTL 从「最后一个 run 结束」起算）
    // 按 session instanceId 刷——同 agentId 的后继会话不碰
    const session = agentSessions.get(task.id);
    if (
      session &&
      (mySessionInstanceId !== undefined
        ? session.instanceId === mySessionInstanceId
        : session.agentId === agent.agentId)
    ) {
      session.lastActiveAt = Date.now();
    }
  }
};

/**
 * V0.11.1：merge 本 task 的 MCP 集合（全局 cursor mcp 按黑名单过滤 + OAuth 注入 +
 * 健康剔除 + 内置 chat-tool）——Agent.create 和 Agent.resume 共用（inline MCP 不随
 * resume 持久化、恢复会话必须重传）。
 */
const buildMergedMcpForTask = async (
  task: Task,
  /** agent 实例 caller——拼进 chat-tool URL ?caller= */
  callerToken: string,
): Promise<{
  mergedMcp: Record<string, McpServerConfig>;
  cursorMcpNames: string[];
  droppedMcp: Awaited<ReturnType<typeof filterHealthyMcp>>["dropped"];
}> => {
  const enrichedMcp = await enrichMcpServersWithOAuth(
    await resolveTaskMcpServers(task.disabledMcpServers),
  );
  const { servers: cursorMcp, dropped: droppedMcp } =
    await filterHealthyMcp(enrichedMcp);
  const mergedMcp: Record<string, McpServerConfig> = {
    ...cursorMcp,
    [TASK_TOOL_MCP_NAME]: {
      type: "http",
      // 每 agent 独立 URL → SDK 新建独立 MCP session（无老 session 复用）
      url: getChatMcpUrl(callerToken),
    },
  };
  const cursorMcpNames = Object.keys(cursorMcp).filter(
    (n) => n !== TASK_TOOL_MCP_NAME,
  );
  return { mergedMcp, cursorMcpNames, droppedMcp };
};

/**
 * V0.11.1：从落盘的 sessionAgentId 恢复会话（服务重启 / 空闲回收后）。
 * 成功 = agent 接回 + 桥重注册 + 会话表就位；失败 = 清锚点返 null（调用方降级 fresh agent）。
 *
 * 终态/lifecycle 准入下沉到本 sink；session+bridge 走
 * {@link installSessionIfCurrent} 原子安装；失主必须 close 刚 resume 出的 agent。
 */
export const resumeTaskSession = async (
  task: Task,
  creds: SessionCreds,
  /**
   * 调用方刚 close 掉的会话 instanceId——set 前若表里已有**别的**
   * instance（B 已登记）→ CAS 让位返 null，绝不覆盖。
   * opHandle 必须由 caller 入场快照透传——本函数禁止自行 snapshotTaskOp
   * （重拍会在 Agent.resume await 期间拍成后继 B 的 observer、把 A 的 agent 绑到 B）。
   */
  opts?: { closedSessionInstanceId?: number; opHandle?: TaskOpHandle },
): Promise<AgentSessionRecord | null> => {
  if (!task.sessionAgentId || !creds.apiKey) return null;
  // resume 后 send 必须有显式 model：优先「原会话实际在用的模型」（最近带 agentModel 的 action）、
  // 兜底 client 传来的（settings 默认模型）
  const model =
    [...task.actions].reverse().find((a) => a.agentModel)?.agentModel ??
    task.model ??
    creds.model;
  if (!model) return null;

  /** 终态 / lifecycle / opHandle 综合准入（每个 await 后复用） */
  const mayResume = async (): Promise<boolean> => {
    if (opts?.opHandle && !isTaskOpCurrent(opts.opHandle)) return false;
    if (getChatLifecycle(task.id) !== null) return false;
    const st = await readTaskRepoStatusFresh(task.id);
    return st !== null && st !== "merged" && st !== "abandoned";
  };

  // 入口拒——finalize 后不得复活 session / 重建 worktree
  if (!(await mayResume())) return null;

  // 放 try 外：ensure 失败（分支被占等）应冒泡给调用方；try 只兜 Agent.resume 失败降级
  // resume 传 opHandle 闭包（无 handle 时退 lifecycle + 终态）
  const resumeLease = (): boolean => {
    if (opts?.opHandle && !isTaskOpCurrent(opts.opHandle)) return false;
    if (getChatLifecycle(task.id) !== null) return false;
    return true;
  };
  try {
    await ensureWorkspaceReady(task, resumeLease);
  } catch (err) {
    // 让位 → 静默 return null（不起 session）
    if (err instanceof WorktreeLeaseLostError) return null;
    throw err;
  }
  if (!(await mayResume())) return null;

  try {
    // resume 也发新 caller（新内存 agent 实例 = 新 MCP 身份）
    const callerToken = String(allocTaskRunInstanceId());
    const { mergedMcp } = await buildMergedMcpForTask(task, callerToken);
    if (!(await mayResume())) return null;

    const agent = await Agent.resume(task.sessionAgentId, {
      apiKey: creds.apiKey,
      model,
      // 本地 agent 按 cwd 定位持久化存储、必须跟 create 时一致（不传会 AgentNotFoundError、实测踩过）
      // settingSources:[] 同 create——不加载 .cursor/、全部 fe 自管注入
      local: { cwd: getTaskCwd(task), settingSources: [] },
      mcpServers: mergedMcp,
    });
    const closeLocal = (): void => {
      try {
        agent.close();
      } catch {
        /* noop */
      }
    };

    // Agent.resume 返回后复查 opHandle + fresh 终态——失效则关 agent
    if (!(await mayResume())) {
      closeLocal();
      return null;
    }

    // Agent.resume await 期间 B 可能已登记会话——CAS：表里已有且不是自己刚关的 → 让位
    const existing = agentSessions.get(task.id);
    if (
      existing &&
      (opts?.closedSessionInstanceId === undefined ||
        existing.instanceId !== opts.closedSessionInstanceId)
    ) {
      console.warn(
        `[task-runner] task=${task.id} resume CAS 让位（表内已有 session instance=${existing.instanceId}）`,
      );
      closeLocal();
      return null;
    }

    // 只构造 bridge——注册延到 installSessionIfCurrent
    const bridges = buildSessionBridges(task, {
      gitToken: creds.gitToken,
      callerToken,
    });
    // resume 出的新内存实例拿新 instanceId（持久化 agentId 可能与旧 A 相同）
    const record: AgentSessionRecord = {
      instanceId: allocTaskRunInstanceId(),
      agent,
      agentId: agent.agentId,
      callerToken,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: captureTaskFieldsSnapshot(task),
    };

    // install 前插桩；lease = handle current + 非终态（lifecycle）
    await failpoint("resume.beforeInstall");
    if (!(await mayResume())) {
      closeLocal();
      return null;
    }
    const existing2 = agentSessions.get(task.id);
    if (
      existing2 &&
      (opts?.closedSessionInstanceId === undefined ||
        existing2.instanceId !== opts.closedSessionInstanceId)
    ) {
      console.warn(
        `[task-runner] task=${task.id} resume CAS 让位（install 前被后继占据）`,
      );
      closeLocal();
      return null;
    }

    const lease = (): boolean =>
      (!opts?.opHandle || isTaskOpCurrent(opts.opHandle)) &&
      getChatLifecycle(task.id) === null;

    if (
      !installSessionIfCurrent(lease, task.id, record, bridges, callerToken)
    ) {
      console.warn(
        `[task-runner] task=${task.id} resume installSession 失主、关本地 agent`,
      );
      closeLocal();
      return null;
    }
    console.log(
      `[task-runner] task=${task.id} 会话已恢复（Agent.resume agentId=${agent.agentId}）`,
    );
    return record;
  } catch (err) {
    // V0.13.x：网络类失败**不清锚点**——自动重连还要靠它再试；只有确定性失败
    //（会话真没了 / 认证错）才清、防重启后 resume 回已死会话死循环
    const m = err instanceof Error ? err.message : String(err);
    if (isRetryableRunError(m, err)) {
      console.warn(
        `[task-runner] task=${task.id} Agent.resume 网络类失败（保留锚点、可重试）`,
        err,
      );
      return null;
    }
    console.warn(
      `[task-runner] task=${task.id} Agent.resume 失败（条件清锚点、降级 fresh agent）`,
      err,
    );
    // 条件清——finalGuard 每次 rename 前复查本闭包。
    // 必须现查（非入场快照）：本链 lease 仍 current + 内存无后继 session。
    // B 可复用同一 agentId 装新实例——只比盘上 agentId 不够。
    if (task.sessionAgentId) {
      void clearTaskSessionAgentIdIf(
        task.id,
        task.sessionAgentId,
        () =>
          (!opts?.opHandle || isTaskOpCurrent(opts.opHandle)) &&
          agentSessions.get(task.id) === undefined,
      );
    }
    return null;
  }
};

/**
 * V0.11：ask_user 答案送达（ask-reply 路由用）——`agent.send([ASK_USER_REPLY]…)` 续会话。
 * @returns 见 {@link SendTaskSessionResult}；只有 `sent` 表示送达
 */
export const deliverAskReply = async (
  task: Task,
  replyText: string,
  imagePaths?: string[],
  errorActionId?: string,
  creds?: SessionCreds,
  /** 路由入场 admission token；缺省则 send 入口同步取 */
  opGen?: number,
): Promise<SendTaskSessionResult> =>
  sendToTaskSession(
    task,
    buildAgentMessage({ kind: "user_reply", text: replyText, imagePaths }),
    { errorActionId, creds, runKind: "task-ask-reply", opGen },
  );

/**
 * V0.13.x 统一消息：把任务页输入条的消息 send 给存活会话（AI 自主二分类、见
 * buildAgentMessage user_message 分支）。无会话时凭 creds resume、接不回返 no_session。
 *
 * @param ackContext 当前产出在等审阅时传（route 判定 awaiting_ack 后附上）：
 *   消息里附「处理完重新交卷」提示（原 revise 语义）、且这个 run 不按 questionRun
 *   处理（agent 会 submit_work、run 出口要走正常 action 状态机）
 */
export const deliverTaskQuestion = async (
  task: Task,
  text: string,
  imagePaths?: string[],
  creds?: SessionCreds,
  ackContext?: { actionId: string; artifactPath?: string },
  attachmentPaths?: string[],
  /** 路由入场 admission token；缺省则 send 入口同步取 */
  opGen?: number,
): Promise<SendTaskSessionResult> =>
  sendToTaskSession(
    task,
    buildAgentMessage({
      kind: "user_message",
      text,
      imagePaths,
      attachmentPaths,
      ackContext,
    }),
    ackContext
      ? { creds, errorActionId: ackContext.actionId, opGen }
      : { creds, questionRun: true, opGen },
  );

/**
 * V0.11.9 问一问兜底：会话接不回（agent 报错过 / 停过 / 隔了几天早没了）时、
 * 起一个**一次性**轻量 Q&A agent 回答（用户拍板「接不回来另起一个没问题」）。
 *
 * 跟正式会话的区别（有意为之）：
 * - 不注入 action playbook / 不装 chat-tool MCP（没有交卷 / 提问 / MR 语义、也调不了）
 * - 不注册 agentSessions / 不落盘锚点——它只懂答疑、不能被后续「续用推进」误当正式会话
 * - 答完 close、下次再问再起（低频场景、冷启动可接受）
 *
 * fire-and-forget：调用方写完事件 / 切 running 后调、失败在内部标回原状态 + error 事件。
 */
export const startOneShotQuestion = (
  task: Task,
  questionText: string,
  imagePaths: string[] | undefined,
  creds: { apiKey: string; model: ModelSelection },
  attachmentPaths?: string[],
  /** 路由入场 admission token；缺省则本函数入口同步取（须在任何 await 前） */
  opGen?: number,
): void => {
  const prevRunStatus = task.runStatus === "running" ? "idle" : task.runStatus;
  // 同步捕获（路由可提前传入）；V2：纳入 startingTasks
  const admissionOpGen = opGen ?? getTaskOpGeneration(task.id);
  // observer 在公共入口、任何 await（含 ensureWorkspaceReady）之前同步拍——
  // ensure / 串行排队期间同 gen claim 会变 claimSeq，出队后 isTaskOpCurrent 即 false
  const oneshotOpHandle = snapshotTaskOp(task.id);
  beginTaskStarting(task.id);
  void (async () => {
    // box：串行回调内赋值不被 TS CFA 当成「外层 let 从未赋值」
    const agentBox: { current: AgentInstance | null } = { current: null };
    // instanceId 在受理段分配，catch/consume 共用——
    // 绝不再从全局 runningTasks 读（表已被 B 换掉时会误拿 B 的号）
    let oneshotInstanceId: number | undefined;
    /**
     * stale 中止只关自己的 agent / 飞行窗——不写 task 级 runStatus。
     * 状态归 bump 方（stop/DELETE）收尾；旧 one-shot 无条件恢复 prevRunStatus
     * 会覆盖后继 B 刚置的 running（验收 时序）。
     */
    const abortStaleQuietly = (): void => {
      const a = agentBox.current;
      if (!a) return;
      try {
        a.close();
      } catch {
        /* noop */
      }
    };
    try {
      // 测试插桩：入口 snapshot 之后、首个 IO 之前——矩阵可在此注入 claim
      await failpoint("oneshot.beforeEnsure");
      // finalize / 手删后 worktree 可能已不在——起兜底 agent 前先保证目录存在
      // one-shot 传 observer 闭包
      try {
        await ensureWorkspaceReady(task, () => isTaskOpCurrent(oneshotOpHandle));
      } catch (err) {
        // 让位 → 静默 return（不起 agent）
        if (err instanceof WorktreeLeaseLostError) {
          abortStaleQuietly();
          return;
        }
        throw err;
      }
      if (
        isTaskOpStale(task.id, admissionOpGen) ||
        !isTaskOpCurrent(oneshotOpHandle)
      ) {
        abortStaleQuietly();
        return;
      }

      // create→send 受理进串行链（与 advance / follow-up send 互斥）；consume 留链外。
      // ⚠️ 死锁自查：本回调绝不嵌套 runWithTaskSendSerial / sendToTaskSession。
      type AdmitOk = { run: SessionRun };
      const admitted = await runWithTaskSendSerial(
        task.id,
        async (): Promise<AdmitOk | null> => {
          // 沿用入口 oneshotOpHandle——受理段禁止重拍 snapshot
          oneshotInstanceId = allocTaskRunInstanceId();
          if (
            isTaskOpStale(task.id, admissionOpGen) ||
            !isTaskOpCurrent(oneshotOpHandle)
          ) {
            return null;
          }
          // 正式会话/run 已占位 → one-shot 让位（推进优先）
          if (runningTasks.has(task.id) || agentSessions.has(task.id)) {
            console.warn(
              `[task-runner] startOneShotQuestion: task=${task.id} 正式 run/会话已占位、one-shot 让位`,
            );
            return null;
          }

          // 启动副作用边界——盘上终态让位，不 Agent.create
          {
            const repoStatus = await readTaskRepoStatusFresh(task.id);
            if (repoStatus === "merged" || repoStatus === "abandoned") {
              console.warn(
                `[task-runner] startOneShotQuestion: task=${task.id} 盘上已终态 ${repoStatus}、让位`,
              );
              return null;
            }
          }
          const effectiveCwd = getTaskCwd(task);
          const created = await Agent.create({
            apiKey: creds.apiKey,
            model: creds.model,
            // settingSources:[] 同正式会话——不加载 .cursor/、全部 fe 自管注入
            local: { cwd: effectiveCwd, settingSources: [] },
          });
          agentBox.current = created;
          console.log(
            `[task-runner] task=${task.id} 问一问兜底 agent 已起 agentId=${created.agentId}`,
          );
          // V1 / create 返回后复查——stop / 同 gen claim 都不得 send
          if (
            isTaskOpStale(task.id, admissionOpGen) ||
            !isTaskOpCurrent(oneshotOpHandle)
          ) {
            abortStaleQuietly();
            return null;
          }
          // V0.13.x 放开「只读答疑」（用户拍板「纯答疑限制太死」）：疑问就答、要改就改——
          // 只是不推进任务链（本 agent 没有 action 上下文、大改动引导用户走推进）
          const prompt = [
            `你是任务「${task.title}」的临时助手。用户在任务页说了句话、按内容处理：疑问就答、修改要求就直接动手。`,
            "",
            "# 任务背景（按需 read / grep、先查再答）",
            `- 任务事件日志（完整历史）：${getEventsLogPath(task.id)}`,
            `- 产出文档目录（方案 / 实现 / 复核等 artifact）：${getActionsDir(task.id)}`,
            `- 工作目录：${effectiveCwd}`,
            "",
            "# 用户的话",
            buildAgentMessage({
              kind: "user_message",
              text: questionText,
              imagePaths,
              attachmentPaths,
            }),
            "",
            "# 边界",
            "- 是疑问 → 直接回答；是小改动要求 → 直接改（改完说明改了什么）",
            "- 大改动（整段功能 / 跨多文件重构）→ 说明建议、引导用户点「推进」走正式阶段（你没有任务链上下文、别硬扛）",
            "- 不要提交 commit / 提 MR、处理完自然结束回复",
          ].join("\n");
          if (
            isTaskOpStale(task.id, admissionOpGen) ||
            !isTaskOpCurrent(oneshotOpHandle)
          ) {
            abortStaleQuietly();
            return null;
          }
          const perfTracker = createRunPerfTracker({
            taskId: task.id,
            agentId: created.agentId,
            runKind: "question",
            promptBytes: Buffer.byteLength(prompt, "utf-8"),
          });
          const run = await created.send(prompt, {
            onDelta: composeOnDelta(
              perfTracker.onDelta,
              // one-shot 绑 observer handle
              createShellOutputDeltaPublisher(task.id, () =>
                isTaskOpCurrent(oneshotOpHandle),
              ),
            ),
            onStep: perfTracker.onStep,
          });
          perfTracker.attachRun(run);

          // send resolve 后插桩；失主则 cancel + 关本地、不注册 runningTasks
          await failpoint("oneshot.afterSend");
          if (
            isTaskOpStale(task.id, admissionOpGen) ||
            !isTaskOpCurrent(oneshotOpHandle)
          ) {
            void run.cancel().catch(() => {
              /* noop */
            });
            abortStaleQuietly();
            return null;
          }

          // 出链前预登记——堵住「出链→consume.set」窗口，让并发 advance 看见本 run
          runningTasks.set(task.id, {
            instanceId: oneshotInstanceId,
            agentId: created.agentId,
            startedAt: Date.now(),
            startSnapshot: captureTaskFieldsSnapshot(task),
            cancel: () => {
              void run.cancel().catch(() => {
                /* noop */
              });
            },
          });
          return { run };
        },
      );

      const liveAgent = agentBox.current;
      if (!admitted || !liveAgent) {
        abortStaleQuietly();
        return;
      }

      // questionRun：任何出口都不动 action；consume 用入场 observer（绝不重拍）
      await consumeSessionRun(task, liveAgent, admitted.run, {
        questionRun: true,
        opHandle: oneshotOpHandle,
      });
    } catch (err) {
      // stale / 失主中止路径不写 error（abortStaleQuietly 已处理）
      if (
        isTaskOpStale(task.id, admissionOpGen) ||
        !isTaskOpCurrent(oneshotOpHandle)
      ) {
        abortStaleQuietly();
        return;
      }
      console.error(`[task-runner] task=${task.id} 问一问兜底失败：`, err);
      // owner 语境（oneshot 链、上方已验 current）——oneshot observer lease
      await writeOwnedEventAndPublish(
        task.id,
        () => isTaskOpCurrent(oneshotOpHandle),
        {
          kind: "error",
          text: `答疑 agent 启动失败：${err instanceof Error ? err.message : String(err)}`,
        },
      );
      // restore 前复查 handle；instanceId 用本地变量（不从全局表读 B）
      if (
        !isTaskOpCurrent(oneshotOpHandle) ||
        oneshotInstanceId === undefined
      ) {
        return;
      }
      const myId = oneshotInstanceId;
      const restored = await setTaskRunStatusIfRunOwner(
        task.id,
        prevRunStatus,
        () =>
          isTaskOpCurrent(oneshotOpHandle) &&
          runningTasks.get(task.id)?.instanceId === myId,
      );
      if (restored) publish(task.id, { kind: "task", task: restored });
    } finally {
      try {
        agentBox.current?.close();
      } catch {
        /* noop */
      }
      endTaskStarting(task.id);
    }
  })();
};

/**
 * V0.11：把用户操作以新消息发给 task 的存活会话（`agent.send`）、并消费产生的新 run。
 * V0.11.1：内存没会话但有落盘 sessionAgentId 且带了凭据 → 先 Agent.resume 接回再 send。
 * V0.11.7：入口先等在飞 run 排空（几秒级协议间隙、见 waitForRunToDrain）再 send、
 * 不再直接拒——用户秒答 ask 弹窗撞上「run 还没 finished」曾被误报「没有活跃会话」。
 *
 * @returns 结构化结果——`stale` 绝不能被调用方当成「无会话」去 fallback / 写 running。
 */
// 等 task 的在飞 run 自然结束（V0.11.7）。返回 false = 超时还在跑。
// 场景：ask_user 弹窗在 agent 调工具的瞬间就弹给用户、但本回合 run 要再过几秒才 finished
// （收尾旁白；未交卷时还有 send 追问）——用户手快秒答会撞上「run 在跑」。这几秒是协议的正常间隙、
// 等它排空再 send、而不是把用户的答案拒回去（实测踩过：第一次提交报「没有活跃会话」、几秒后重试才过）。
const waitForRunToDrain = async (
  taskId: string,
  timeoutMs = 90_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (runningTasks.has(taskId)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
};

const sendToTaskSession = async (
  task: Task,
  text: string,
  opts: {
    errorActionId?: string;
    creds?: SessionCreds;
    questionRun?: boolean;
    /** 性能埋点 runKind；默认 questionRun→question，否则 task-followup */
    runKind?: string;
    /** 调用方入场 opGen；缺省则本函数在进串行队列前同步取 */
    opGen?: number;
  } = {},
): Promise<SendTaskSessionResult> => {
  // admission 在进 runWithTaskSendSerial 之前同步捕获——
  // 否则 排队期间 stop bump，出队后才取会拍到新值、冒充 stop 后新请求
  const opGen = opts.opGen ?? getTaskOpGeneration(task.id);
  // observer 与 opGen 同位置同步拍——排队期间同 gen claim 变 claimSeq，
  // 出队后 isTaskOpCurrent(entryOpHandle) 即 false，不得伪装成 B 的合法 observer
  const entryOpHandle = snapshotTaskOp(task.id);
  // V2 / 同步 check-and-chain——并发 send 与 one-shot/advance 启动受理串行化
  return runWithTaskSendSerial(task.id, () =>
    sendToTaskSessionBody(task, text, { ...opts, opGen, entryOpHandle }),
  );
};

const sendToTaskSessionBody = async (
  task: Task,
  text: string,
  opts: {
    errorActionId?: string;
    creds?: SessionCreds;
    questionRun?: boolean;
    runKind?: string;
    opGen?: number;
    /** 由导出入口在进串行队列前拍好，禁止出队后自取 */
    entryOpHandle: TaskOpHandle;
  },
): Promise<SendTaskSessionResult> => {
  // 由 sendToTaskSession 入口传入（禁止出队后自取 opGen / observer）
  const opGen = opts.opGen!;
  const entryOpHandle = opts.entryOpHandle;
  beginTaskStarting(task.id);
  try {
    // 每处 stale 显式返 "stale"，不得折叠成 false/no_session
    if (isTaskOpStale(task.id, opGen)) return "stale";
    /** gen stale 或同 gen claim（claimSeq 变）都算失效 */
    const entryLost = (): boolean =>
      !isTaskOpCurrent(entryOpHandle) || isTaskOpStale(task.id, opGen);

    if (!(await waitForRunToDrain(task.id))) {
      console.warn(
        `[task-runner] sendToTaskSession: task=${task.id} run 排空超时、拒绝并发 send`,
      );
      return "no_session";
    }
    // drain 期间同 gen claim 也要让位（纯 gen 比对看不见）
    if (entryLost()) return "stale";
    let session = agentSessions.get(task.id) ?? null;
    // 记下是否本轮 resume 刚登记——失主时必须按 instance 清掉，给 B 干净位子
    let resumedThisCall = false;
    if (!session && opts.creds) {
      session = await resumeTaskSession(task, opts.creds, {
        opHandle: entryOpHandle,
      });
      resumedThisCall = !!session;
    }
    if (!session) {
      // resume 因失主 / 终态返 null 时，resume 内部已 close agent。
      // 失主不得折叠成 no_session（调用方会误当「无会话」再 force-new）——对齐既有口径。
      if (entryLost()) return "stale";
      return "no_session";
    }
    if (entryLost()) {
      // 不能只 return "stale"——resume 刚写入的 session/bridge 会占住位子挡 B
      if (resumedThisCall) {
        closeTaskSession(task.id, session.agentId, {
          expectedSessionInstanceId: session.instanceId,
        });
      }
      return "stale";
    }
    const agent = session.agent as AgentInstance;
    // 受理时记下 session instanceId——后续关会话 / restore 按号门控
    const mySessionInstanceId = session.instanceId;
    const isSendSessionOwner = (): boolean => {
      const s = agentSessions.get(task.id);
      return !!s && s.instanceId === mySessionInstanceId;
    };
    /** 失效让位——cancel 刚受理的 run、只关自己 session、return stale */
    const yieldStale = async (run?: SessionRun): Promise<"stale"> => {
      if (run) {
        void run.cancel().catch(() => {
          /* noop */
        });
      }
      closeTaskSession(task.id, agent.agentId, {
        expectedSessionInstanceId: mySessionInstanceId,
      });
      if (opts.questionRun && shouldRestoreAfterQuestion(entryOpHandle)) {
        await restoreRunStatusAfterQuestion(task.id, isSendSessionOwner);
      }
      return "stale";
    };
    let run: SessionRun;
    try {
      const runKind =
        opts.runKind ?? (opts.questionRun ? "question" : "task-followup");
      const perfTracker = createRunPerfTracker({
        taskId: task.id,
        agentId: agent.agentId,
        runKind,
        promptBytes: Buffer.byteLength(text, "utf-8"),
      });
      run = await agent.send(text, {
        onDelta: composeOnDelta(
          perfTracker.onDelta,
          // 续接 / 问一问 send 绑入场 opHandle
          createShellOutputDeltaPublisher(task.id, () =>
            isTaskOpCurrent(entryOpHandle),
          ),
        ),
        onStep: perfTracker.onStep,
      });
      perfTracker.attachRun(run);
    } catch (err) {
      // 续接 / 问一问 send 期间点停止会先 close 会话 → send 抛错；
      // 返 "stale" 而非 true——避免 route 当成已送达去写事件 / advance 降级 force-new
      const stopSignal =
        pendingStopRequests.has(task.id) ||
        getChatLifecycle(task.id) !== null ||
        entryLost();
      if (stopSignal) {
        // 同 gen claim 失主 → 纯让位（不走 applyPendingStop 共享写）
        if (!isTaskOpCurrent(entryOpHandle)) {
          return yieldStale();
        }
        if (opts.questionRun) {
          pendingStopRequests.delete(task.id);
          if (shouldRestoreAfterQuestion(entryOpHandle)) {
            await restoreRunStatusAfterQuestion(task.id, isSendSessionOwner);
          }
          const freshQ = await getTask(task.id);
          await failpoint("question.beforeDone");
          if (!isTaskOpCurrent(entryOpHandle)) return "stale";
          publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
          return "stale";
        }
        if (
          await applyPendingStopIfRequested(
            task,
            agent,
            undefined,
            opGen,
            opts.errorActionId,
            mySessionInstanceId,
            entryOpHandle,
          )
        ) {
          return "stale";
        }
      }
      // send 失败（会话失效 / SDK 异常）→ 关掉这个坏会话、调用方降级
      console.error(`[task-runner] sendToTaskSession: task=${task.id} send 失败`, err);
      closeTaskSession(task.id, session.agentId, {
        expectedSessionInstanceId: mySessionInstanceId,
      });
      return "send_failed";
    }
    // send resolve 后插桩再复查——同 gen claim 必须让位，永不重拍 snapshot
    await failpoint("send.afterSend");
    if (entryLost()) {
      // 同 gen claim：纯让位；stop（gen/lifecycle）：可走 pending 收尾
      if (!isTaskOpCurrent(entryOpHandle)) {
        return yieldStale(run);
      }
      if (opts.questionRun) {
        pendingStopRequests.delete(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
        if (shouldRestoreAfterQuestion(entryOpHandle)) {
          await restoreRunStatusAfterQuestion(task.id, isSendSessionOwner);
        }
        const freshQ = await getTask(task.id);
        await failpoint("question.beforeDone");
        if (!isTaskOpCurrent(entryOpHandle)) return "stale";
        publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
        return "stale";
      }
      if (
        await applyPendingStopIfRequested(
          task,
          agent,
          run,
          opGen,
          opts.errorActionId,
          mySessionInstanceId,
          entryOpHandle,
        )
      ) {
        return "stale";
      }
      void run.cancel().catch(() => {
        /* noop */
      });
      return "stale";
    }
    session.lastActiveAt = Date.now();
    // consume 直接用入场 entryOpHandle——禁止 send 后再 snapshotTaskOp
    void consumeSessionRun(task, agent, run, {
      errorActionId: opts.errorActionId,
      questionRun: opts.questionRun,
      opHandle: entryOpHandle,
    });
    return "sent";
  } finally {
    endTaskStarting(task.id);
  }
};
