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
  appendActionSideEffectMR,
  getTask,
  patchAction,
  refreshRepoBranches,
  setFeishuTesterUserKeys,
  upsertGitBranch,
  upsertMR,
  setTaskRepoStatus,
  setTaskRunStatus,
  setTaskAwaitingIfIdle,
} from "./task-fs";
import { getActionsDir, getEventsLogPath, getTaskWorkspaceDir } from "./task-fs-core";
import {
  runActionCheck,
  captureActionStartBaseline,
  captureReadonlyRepoBaselines,
} from "./action-checks";
import { isRetryableRunError, summarizeRunFailure } from "./sdk-error";
import { createRunPerfTracker } from "./run-perf";
import { getChatMcpUrl } from "./chat-mcp";
import {
  buildAgentMessage,
  cancelPending,
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
  forceClearStaleRunnerState,
  forkPendingTasks,
  pendingStopRequests,
  publish,
  runningChecks,
  runningTasks,
  waitForTaskToStop,
  writeEventAndPublish,
  truncate,
  stringifyMeta,
  type AgentSessionRecord,
  type RunningCheck,
} from "./task-stream";
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

// ----------------- 配置 -----------------

// task 不主动超时（用户随时可能 24h 后才 ack）
const TASK_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-mcp 在 Agent.mcpServers 里的注册名（agent prompt 里得点明、跟 V0.5 沿用）
const TASK_TOOL_MCP_NAME = "aiFlowChat";

/** 对外保持 task-runner 原路径可 import（实现在 ask-supersede.ts） */
export { supersedePendingAsks };

// ----------------- 公开 query API -----------------

// SDK Agent 实例类型（AgentSessionRecord 里存的是结构化最小面、runner 内部用这个收窄）
type AgentInstance = Awaited<ReturnType<typeof Agent.create>>;

// V0.11.1：续会话 / resume 需要的凭据（ack / ask-reply 路由随 bootArgs 带来、advance 本来就有）
export interface SessionCreds {
  apiKey?: string;
  // resume 后的 send 必须有显式 model（恢复的本地 agent 不保留 model、实测踩过）；
  // 服务端优先用 task 自己记的模型（最近 action 的 agentModel）、这里是兜底
  model?: ModelSelection;
  // PAT 仍来自 settings；host 不进凭据——registerSessionBridges 按 task.repoPaths 现推
  gitToken?: string;
}

/**
 * V0.11：关掉某 task 的跨 run agent 会话（agent close + 注销 notifier/handler + 清孤儿进程）。
 * agentId 传了就只在「当前会话确实是它」时才关（异步收尾路径防误关新会话）、不传 = 关当前的。
 *
 * @param opts.keepPersisted true = 保留落盘的 sessionAgentId（空闲回收用——下次操作 Agent.resume
 *   接回来）；缺省 false = 连持久化锚点一起清（停止 / 终结 / 报错 / 换新 agent 是真结束）
 * @returns 是否真的关了一个会话
 */
const closeTaskSession = (
  taskId: string,
  agentId?: string,
  opts: { reap?: boolean; keepPersisted?: boolean } = {},
): boolean => {
  const session = agentSessions.get(taskId);
  if (!session) {
    // 内存没会话、但调用方语义是「真结束」→ 持久化锚点也要清（防重启后 resume 回已放弃的会话）
    if (!opts.keepPersisted) void setTaskSessionAgentId(taskId, undefined);
    return false;
  }
  if (agentId && session.agentId !== agentId) return false;
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
const SESSION_SWEEPER_KEY = "__feAiFlowSessionSweeperV1__";
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
          closeTaskSession(taskId, s.agentId, { reap: false, keepPersisted: true });
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
const runActionPostCheck = (
  taskId: string,
  actionId: string,
  artifactPath: string | undefined,
): void => {
  // 顶替：同 task 已有在跑的 check（agent 反复 wait、或换了 action）→ abort 旧的、本轮用最新代码重跑
  runningChecks.get(taskId)?.controller.abort();

  const controller = new AbortController();
  const self: RunningCheck = { actionId, controller };
  runningChecks.set(taskId, self);

  void (async () => {
    // 结果是否仍由「自己」当家：被新一轮 check 顶替 / 被 abort（停止 / 推进）→ 不该写状态
    const stillOwner = () =>
      !controller.signal.aborted && runningChecks.get(taskId) === self;

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

    // 被取消 / 顶替 → 丢弃结果、不写任何状态（防状态交错）
    // ⚠️ 此处先「不」从 runningChecks 摘除自己——要一直挂到落完状态那刻、
    //    好让落状态前的每个 await 点（下面的 getTask）都能被 abortRunningCheck（停止 / 推进）接住。
    //    若在这就 delete、停止恰好插在「getTask 期间」会丢失 abort、旧 check 仍把已停止的 task 改回 awaiting_ack。
    if (!stillOwner()) {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 结果作废（已 abort / 被顶替）`,
      );
      return;
    }

    // 再确认 action 仍在等 check（没被 stop 标 cancelled / 没被推进改状态）
    const after = await getTask(taskId);
    // getTask 这个 await 期间可能被停止 / 推进 abort（杀子进程 + 标 cancelled）→ 落状态前再查一次 owner
    if (!stillOwner()) {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 结果作废（落状态前被 abort / 顶替）`,
      );
      return;
    }
    const a0 = after?.actions.find((a) => a.id === actionId);
    if (!a0 || a0.status !== "running") {
      console.log(
        `[task-runner] runActionPostCheck task=${taskId} action=${actionId} 已非 running（${a0?.status ?? "缺失"}）、跳过落 awaiting_ack`,
      );
      // 正常收尾（不是被顶替）→ 摘除自己；带身份校验防误删后来者
      if (runningChecks.get(taskId) === self) runningChecks.delete(taskId);
      return;
    }

    // 落 check 结果 + 切 awaiting_ack（原 awaitingNotifier 同步分支尾段、整段搬到后台）
    const patched = await patchAction(taskId, actionId, {
      status: "awaiting_ack",
      ...(postCheck ? { postCheck } : {}),
    });
    if (patched) {
      publish(taskId, { kind: "task", task: patched });
      const a = patched.actions.find((x) => x.id === actionId);
      if (a) publish(taskId, { kind: "action", action: a });
    }
    const updated = await setTaskRunStatus(taskId, "awaiting_user", actionId);
    if (updated) publish(taskId, { kind: "task", task: updated });
    await writeEventAndPublish(taskId, {
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
    });
    // 全部落完、摘除自己；带身份校验：万一落状态期间被新一轮 wait 顶替、别误删后来者
    if (runningChecks.get(taskId) === self) runningChecks.delete(taskId);
  })().catch((err) => {
    // 兜底：落状态那段（patchAction / setTaskRunStatus）万一抛、别变成 unhandledRejection
    console.error(
      `[task-runner] runActionPostCheck 未捕获异常 task=${taskId} action=${actionId}：`,
      err,
    );
    if (runningChecks.get(taskId) === self) runningChecks.delete(taskId);
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
}


/**
 * 收尾 task 里所有「卡在非终态」（running / awaiting_ack）的 action（V0.6.12）
 *
 * 单 Run 多 action 模型下、Run 结束有多条路径（finished / error / cancel / fork / finalize）、
 * 早期各自只收尾「闭包起的那个 action」或「currentActionId 指的那个」、会漏掉 Run 期间推进出来的新 action
 * （典型踩坑：agent 推进到 act_N awaiting_ack 后 run error、catch 却去收尾「起 agent 时的旧 action」）
 * → 遗留 action 永久卡 awaiting_ack、既划不掉（action-exclude 409）又停不掉（currentActionId 已被清 null）。
 * 这个 helper 统一把所有非终态 action 收掉、各路径调它即可、不再各写一份。
 *
 * @param status         收尾成的终态：agent 异常退出 → error；用户主动停 / 换 agent / abandon → cancelled
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

// ----------------- P1-3：同一 task 的 advanceTask 串行化 -----------------
//
// advanceTask 全程 async（appendAction → 路由决策 → internalStartAgent 里 Agent.create/send）、
// 中间多个 await。并发触发（双击「推进」/ 多标签页同时推进同一 task）会踩两个坑：
//   ① appendAction 各追加一条 action（凭空多出一条）；
//   ② 决策时都读到「runningTasks 无 entry」→ 各起一个 agent、后 set 的把前一个覆盖 → 旧 agent 泄漏。
// 解法：按 taskId 把 advanceTask 串起来——同 task 排队执行、不同 task 互不阻塞。
//
// V0.6.27 改挂 globalThis：advance route 和 restart-action route 是不同 chunk、
// module-level Map 各持一份会让这道串行化跨 route 失效（同 runningTasks 的老坑）。
const ADVANCE_CHAINS_KEY = "__feAiFlowAdvanceChainsV1__";
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
    const task = await getTask(taskId);
    if (!task || !isWorktreeTask(task)) return;
    try {
      const ensured = await ensureTaskWorktrees(task);
      // 同 advanceTaskInner：仅新仓 upsert gitBranches（老条目保留 baseBranch 历史值）
      const existingRepos = new Set(
        (task.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of ensured.infos) {
        if (!existingRepos.has(info.repoPath)) {
          await upsertGitBranch(task.id, info);
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
        await writeEventAndPublish(task.id, {
          kind: "info",
          text: `已后台预热任务隔离工作区（git worktree）并检出任务分支：${ensured.createdRepos
            .map((p) => p.split("/").filter(Boolean).pop() ?? p)
            .join("、")}${cloneNote}——推进时无需再等待创建`,
        });
      }
    } catch (err) {
      console.warn(
        `[task-runner] task=${taskId} 后台预热 worktree 失败（推进时会重试并报具体原因）：`,
        err,
      );
    }
  });
};

export const advanceTask = async (
  input: AdvanceTaskInput,
): Promise<{ action: ActionRecord }> =>
  runAdvanceExclusive(input.task.id, () => advanceTaskInner(input));

const advanceTaskInner = async (
  input: AdvanceTaskInput,
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
  if (isWorktreeTask(task)) {
    const ensured = await ensureTaskWorktrees(task);
    // 仅新仓 upsert gitBranches（老条目保留 baseBranch 历史值、跟 build hint 老规则一致）
    const existingRepos = new Set((task.gitBranches ?? []).map((b) => b.repoPath));
    for (const info of ensured.infos) {
      if (!existingRepos.has(info.repoPath)) {
        await upsertGitBranch(task.id, info);
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
      await writeEventAndPublish(task.id, {
        kind: "info",
        text: `已创建任务隔离工作区（git worktree）并检出任务分支：${ensured.createdRepos
          .map((p) => p.split("/").filter(Boolean).pop() ?? p)
          .join("、")}${cloneNote ? `；${cloneNote}` : ""}`,
      });
    } else if (cloneNote) {
      // 复用已有 worktree 时补克隆（老 worktree 建于克隆功能上线前）也要让用户知道
      await writeEventAndPublish(task.id, { kind: "info", text: cloneNote });
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
  const pendingAck = task.actions.find(
    (a) => a.id === task.currentActionId && a.status === "awaiting_ack",
  );
  if (pendingAck) {
    const patched = await patchAction(task.id, pendingAck.id, {
      status: "completed",
    });
    if (patched) {
      publish(task.id, { kind: "task", task: patched });
      const a = patched.actions.find((x) => x.id === pendingAck.id);
      if (a) publish(task.id, { kind: "action", action: a });
    }
    await writeEventAndPublish(task.id, {
      kind: "action_ack",
      actionId: pendingAck.id,
      text: `Action ${pendingAck.type} n=${pendingAck.n} 已通过（推进时自动认可）`,
      meta: { decision: "approve" },
    });
    // 认可改了当前 action 状态 → 重读最新 task、后续准入 / appendAction / 路由都用它
    task = (await getTask(task.id)) ?? task;
  }

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
  // 新推进 = 新意图：作废上一轮残留的停止请求，避免误杀本次启动
  pendingStopRequests.delete(task.id);
  const created = await appendAction(task.id, {
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
  });
  if (!created) {
    throw new Error(`appendAction 失败 task=${task.id}（task 不存在）`);
  }
  const { task: taskAfterAppend, action } = created;
  publish(task.id, { kind: "task", task: taskAfterAppend });
  publish(task.id, { kind: "action", action });
  // V0.6.27：review / build 启动基线；只读仓基线所有 action 都采（后置检测兜底）
  // 采集失败 fail-open 不挡启动
  if (actionType === "review" || actionType === "build") {
    const baseline = await captureActionStartBaseline(task, actionType);
    if (baseline) {
      await patchAction(task.id, action.id, { startBaseline: baseline });
      action.startBaseline = baseline;
    }
  }
  {
    const readonlyBaseline = await captureReadonlyRepoBaselines(task);
    if (readonlyBaseline) {
      await patchAction(task.id, action.id, { readonlyBaseline });
      action.readonlyBaseline = readonlyBaseline;
    }
  }
  await writeEventAndPublish(task.id, {
    kind: "action_start",
    actionId: action.id,
    text: `开始 ${actionDisplayLabel(action)}（${action.type}）n=${action.n}${
      userInstruction.trim().length > 0 ? `\n用户指令：${truncate(userInstruction, 200)}` : ""
    }`,
    meta: { type: actionType, n: action.n, artifactPath: action.artifactPath },
  });

  // 3) branch checkout 挂接（仅 build action、V0.6.1 每次都 inject 多仓 idempotent hint）
  //    V0.10：隔离工作区 task 不注入——分支已由 runner 在 worktree 里确定性检出、
  //    agent 不需要（也不该）自己 checkout
  let branchCheckoutHint: string | undefined;
  if (actionType === "build" && !isWorktreeTask(taskAfterAppend)) {
    const planned = planBranchesForBuild(taskAfterAppend);
    if (planned) {
      // 仅新仓 upsert（已存在的保留 baseBranch 历史值、不覆盖）
      const existingRepos = new Set(
        (taskAfterAppend.gitBranches ?? []).map((b) => b.repoPath),
      );
      for (const info of planned.infos) {
        if (!existingRepos.has(info.repoPath)) {
          await upsertGitBranch(task.id, info);
        }
      }
      branchCheckoutHint = planned.promptHint;
    }
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
    const ok = await sendToTaskSession(
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
      { errorActionId: action.id, creds: { apiKey, gitToken } },
    );
    if (ok) return { action };
    // 会话失效（send 抛错已被 close）→ 降级 force-new
    console.warn(
      `[task-runner] advanceTask: task=${task.id} 会话续接失败、降级 force-new-agent`,
    );
  }

  // 5) 没会话 / forceNewAgent / 续接失败：起新 agent
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
}

export const resumeCurrentActionWithMessage = async (
  input: ResumeCurrentActionInput,
): Promise<void> =>
  runAdvanceExclusive(input.task.id, () => resumeCurrentActionInner(input));

const resumeCurrentActionInner = async (
  input: ResumeCurrentActionInput,
): Promise<void> => {
  await assertNoUpdatePendingRestart();
  abortRunningCheck(input.task.id);
  const fresh = await getTask(input.task.id);
  if (!fresh) throw new Error("task 不存在、无法唤醒当前 action");

  const actionId = fresh.currentActionId;
  const action = fresh.actions.find((a) => a.id === actionId);
  if (!action) throw new Error("当前没有可唤醒的 action");

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
  reapTaskOrphans(getTaskWorkRepoPaths(fresh));

  // 作废旧 agent 没答完的 ask（返回未答问题、新 agent 断点续传重问）
  const pendingQuestions = await supersedePendingAsks(fresh.id, "输入条唤醒当前 action");

  // 唤醒 = 新启动意图：作废残留停止标记（同 advanceTask appendAction）
  pendingStopRequests.delete(fresh.id);

  const patchedTask = await patchAction(fresh.id, action.id, { status: "running" });
  const patchedAction =
    patchedTask?.actions.find((a) => a.id === action.id) ?? action;
  if (patchedTask) {
    publish(fresh.id, { kind: "task", task: patchedTask });
    publish(fresh.id, { kind: "action", action: patchedAction });
  }
  let startTask =
    (await setTaskRunStatus(fresh.id, "running", action.id)) ?? patchedTask ?? fresh;
  publish(fresh.id, { kind: "task", task: startTask });

  await writeEventAndPublish(fresh.id, {
    kind: "info",
    actionId: action.id,
    text: `已唤醒当前 ${actionDisplayLabel(action)} 阶段（n=${action.n}）、新 agent 接手继续`,
    meta: { resumedActionId: action.id, actionType: action.type, n: action.n },
  });

  // 隔离工作区 task → 确保 worktree 在（可能被手删过）
  if (isWorktreeTask(startTask)) {
    const ensured = await ensureTaskWorktrees(startTask);
    const existingRepos = new Set(
      (startTask.gitBranches ?? []).map((b) => b.repoPath),
    );
    for (const info of ensured.infos) {
      if (!existingRepos.has(info.repoPath)) {
        await upsertGitBranch(fresh.id, info);
      }
    }
    startTask = (await getTask(fresh.id)) ?? startTask;
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
          await upsertGitBranch(fresh.id, info);
        }
      }
      branchCheckoutHint = planned.promptHint;
      startTask = (await getTask(fresh.id)) ?? startTask;
    }
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
  // 兜底收尾遗留的非终态 action（防 abandon / merge 后 action 卡 awaiting_ack、永久划不掉）
  await finalizeStaleActions(taskId, "cancelled");

  // 业务状态 patch
  const patched = await setTaskRepoStatus(taskId, finalStatus);
  if (patched) publish(taskId, { kind: "task", task: patched });
  await setTaskRunStatus(taskId, "idle", null);

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
  if (isWorktreeTask(task)) {
    const removed = await removeTaskWorktrees(task).catch((err) => {
      console.warn(`[task-runner] finalizeTask: 清理 worktree 失败 task=${taskId}`, err);
      return null;
    });
    if (
      removed?.removedAny ||
      (removed?.snapshotFailedRepos.length ?? 0) > 0
    ) {
      const repoTail = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
      const snapshotNote =
        removed && removed.snapshotRepos.length > 0
          ? `；未提交改动已自动 commit 到任务分支（${removed.snapshotRepos.map(repoTail).join("、")}）`
          : "";
      // 快照落不了仍强制删：提醒用户未提交改动可能已丢（已 commit 的仍在分支上）
      const failedNote =
        removed && removed.snapshotFailedRepos.length > 0
          ? `；⚠️ ${removed.snapshotFailedRepos.map(repoTail).join("、")} 有无法自动保存的未提交改动、工作区已强制删除（未提交改动可能已丢）`
          : "";
      await writeEventAndPublish(taskId, {
        kind: "info",
        text: `已清理任务隔离工作区（feature 分支保留在原仓库、恢复任务后下次推进会自动重建${snapshotNote}${failedNote}）`,
      });
    }
  }

  await writeEventAndPublish(taskId, {
    kind: "info",
    text:
      finalStatus === "merged"
        ? `Task 已标合入 main、收尾结束${reason ? `（${reason}）` : ""}`
        : `Task 已被 abandon${reason ? `（${reason}）` : ""}`,
    meta: { finalStatus, reason },
  });
};

/**
 * 恢复终态 task（merged / abandoned → developing）、让它能重新推进（V0.6.12）
 *
 * 误 abandon、或想把已终结的 task 重新捡起来继续时用。只翻 repoStatus、
 * runStatus 保持 idle（没有活 agent、用户后续点「推进」才起新 Run）。
 */
export const reopenTask = async (taskId: string): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) throw new Error("task 不存在、无法恢复");
  if (task.repoStatus !== "merged" && task.repoStatus !== "abandoned") {
    throw new Error("只有已合入 / 已放弃的任务才能恢复");
  }
  const patched = await setTaskRepoStatus(taskId, "developing");
  if (patched) publish(taskId, { kind: "task", task: patched });
  await writeEventAndPublish(taskId, {
    kind: "info",
    text: "任务已恢复（→ 开发中）、可继续推进",
  });
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
  // Host 在 registerSessionBridges / prompt 注入时按 task.repoPaths 现推
  gitToken?: string;
  // V0.6.23：build 分批指令（仅 build 有值、拼进首个 NEXT_ACTION）
  batchDirective?: string;
  // V0.8.12 A：plan append 硬指令（仅 plan append 有值、透传给 buildSuperPrompt 的首个 NEXT_ACTION）
  replanDirective?: string;
}

// ----------------- V0.11.1：会话桥工厂（handler + notifier、create / resume 共用） -----------------
//
// taskActionHandler（submit_mr / set_feishu_testers / set_plan_batches 同步 RPC）+
// awaitingNotifier（交卷跑后置 check / ask 弹窗事件 / 切 awaiting）原来是 internalStartAgent
// 的内联闭包；V0.11.1 抽出来：Agent.resume 恢复会话时也必须重注册这两座桥、否则恢复后的
// agent 调 submit_mr / submit_work 全部落空。闭包持 gitToken 快照（会话期不可变）；
// host 在 submit_mr 时按 task.repoPaths 现推（不吃历史 settings.gitHost）。
const registerSessionBridges = (
  task: Task,
  opts: { gitToken?: string } = {},
): { taskActionHandler: ChatTaskActionHandler; awaitingNotifier: AwaitingNotifier } => {
  const { gitToken } = opts;
  const taskActionHandler: ChatTaskActionHandler = async (taskAction) => {
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
      if (!gitHost || !gitToken) {
        return {
          ok: false,
          error: "task 启动时没拿到 GitLab Host / Token、ship 准入应该已被拦、不应该走到这里",
        };
      }
      // P0-2：起 createMR 前、server 端按 task 权威数据 + 该仓真实 git remote 校验 agent 上报。
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
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: mr.actionId,
          text: `提测被拦截（${mr.repoPath}）：${valid.error}`,
          meta: {
            repoPath: mr.repoPath,
            projectPath: mr.projectPath,
          },
        });
        return { ok: false, error: valid.error };
      }

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
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: mr.actionId,
          text: `提 MR 失败（${mr.repoPath}）：${result.error}`,
          meta: { repoPath: mr.repoPath, projectPath: mr.projectPath },
        });
        return { ok: false, error: result.error };
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
        } else if (closed.closed) {
          await writeEventAndPublish(task.id, {
            kind: "info",
            actionId: mr.actionId,
            text: `已关闭被取代的旧 MR（${prevMrBranch} → ${mr.targetBranch}、冲突废弃）`,
            meta: { repoPath: mr.repoPath, projectPath: mr.projectPath },
          });
        }
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
      const detailedStatus = mergeStatus.ok ? mergeStatus.detailedStatus : "unknown";
      const mergeUndetermined = mergeStatus.ok ? mergeStatus.undetermined : true;

      // upsert task.mrs[]（按 repoPath+目标分支、同仓同目标多次提交累计 version++）
      const upserted = await upsertMR(task.id, mr.repoPath, {
        targetBranch: mr.targetBranch,
        url: result.url,
        title: mr.title,
        branch: mr.sourceBranch,
        status: "open",
        lastCommitHash: mr.lastCommitHash,
        hasConflicts,
        mergeStatus: detailedStatus,
      });
      const mrVersion = upserted?.mr.version ?? 1;
      if (upserted) {
        publish(task.id, { kind: "task", task: upserted.task });
      }

      // 把本次 MR 原子追加到 action.sideEffects.mrs[]（多仓 task 一次 ship 可能落 N 条）
      // 走 task-fs 原子函数（withTaskLock 包 read-modify-write）、不在这里 getTask→patchAction 两段非原子
      const patched = await appendActionSideEffectMR(task.id, mr.actionId, {
        repoPath: mr.repoPath,
        targetBranch: mr.targetBranch,
        mrUrl: result.url,
        mrVersion,
        branch: mr.sourceBranch,
        commitHash: mr.lastCommitHash,
        hasConflicts,
      });
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
        const a = patched.actions.find((x) => x.id === mr.actionId);
        if (a) publish(task.id, { kind: "action", action: a });
      }

      // 有冲突走 error 事件（红、醒目）、无冲突走 info——用户在事件流一眼看到「这条 MR 合不了」
      const mrVerb = mrVersion > 1 ? `推送（v${mrVersion}）` : "创建";
      if (hasConflicts) {
        await writeEventAndPublish(task.id, {
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
        });
      } else {
        await writeEventAndPublish(task.id, {
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
        });
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
    }

    if (taskAction.kind === "set_feishu_testers") {
      const patched = await setFeishuTesterUserKeys(
        task.id,
        taskAction.userKeys,
      );
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
      }
      await writeEventAndPublish(task.id, {
        kind: "info",
        actionId: taskAction.actionId,
        text: `已记忆飞书测试人员（${taskAction.userKeys.length} 人、同 task 后续 ship 直接复用）`,
        meta: { userKeys: taskAction.userKeys },
      });
      return { ok: true };
    }

    if (taskAction.kind === "set_plan_batches") {
      // V0.6.23：plan agent 上报拆好的批次 → 落到该 plan action 的 planBatches 字段
      // build 选批 + 进度推导都读「最新 completed plan 的 planBatches」（见 task-display.computeBatchProgress）
      const patched = await patchAction(task.id, taskAction.actionId, {
        planBatches: taskAction.batches,
      });
      let replanMode: ReplanMode | undefined;
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
        const a = patched.actions.find((x) => x.id === taskAction.actionId);
        if (a) {
          replanMode = a.replanMode;
          publish(task.id, { kind: "action", action: a });
        }
      }
      await writeEventAndPublish(task.id, {
        kind: "info",
        actionId: taskAction.actionId,
        text:
          replanMode === "append"
            ? `本次新增 ${taskAction.batches.length} 个批次，已并入方案（可在「改代码」里选择）`
            : `已记录 ${taskAction.batches.length} 个批次（build 可分批推进、其余批次先不动）`,
        meta: { batchCount: taskAction.batches.length },
      });
      return { ok: true };
    }

    return { ok: false, error: "未知 task action kind" };
  };
  setChatTaskActionHandler(task.id, taskActionHandler);

  // 具名化：create 失败 / 旧会话迟到清理走 conditional unset，防 force-new-agent race 误清新 handler
  const awaitingNotifier: AwaitingNotifier = async (signal) => {
    if (signal.kind === "ask_user_request") {
      // 新提问落盘前、先作废旧的未了结提问（同事踩坑根因）：
      //   agent 重问 / 断线重挂时 pendingMap 单例被新 ask 顶掉、旧 ask 的 token 已死——
      //   不补作废标记、前端答完新弹窗后旧弹窗会复活、答了必失败（严重时误标任务 error）。
      await supersedePendingAsks(task.id, "被新提问顶替");
      const previewText = signal.questions
        .map((q, idx) => `Q${idx + 1}: ${q.question}`)
        .join("\n");
      await writeEventAndPublish(task.id, {
        kind: "ask_user_request",
        actionId: signal.actionId,
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

    // awaiting_start：agent 完成一个 action 调 submit_work(action_id) → 后台跑 check + 切 awaiting_ack
    //                 或 agent 待命 submit_work(待命态、不带 action_id) → 只切 runStatus=awaiting_user
    if (signal.actionId) {
      // V0.8.18：后置 deterministic check（build 的 lint/typecheck 可达 120s）改后台异步跑——
      // 这样 notifier 立即返回、agent 的 submit_work 工具秒回引导、第一时间挂上 curl long-poll 等 ack
      // （以前同步 await check 会把工具调用阻塞到超时、agent 收到「submit_work 失败」乱来、线上踩过）。
      // check 跑完再由 runActionPostCheck 落 postCheck + 切 awaiting_ack + 发「产出完成」事件。
      runActionPostCheck(task.id, signal.actionId, signal.artifactPath);
    } else {
      // 待命态：agent ack 完、调 submit_work(空 action_id) 等下一 action 指令 → 切 awaiting_user。
      // 用 setTaskAwaitingIfIdle（锁内 compare-set）防 force-new 秒推 race：approve 后用户秒推下一 action、
      //   advanceTask 已把 runStatus 设 running 且新 action 在跑时、此处被取消的旧 agent 迟到的待命通知
      //   不能把 running 覆盖回 awaiting_user（否则新 action 在跑却显示「等待回复」、推进按钮误亮、僵尸组合）。
      const updated = await setTaskAwaitingIfIdle(task.id);
      if (updated) publish(task.id, { kind: "task", task: updated });
    }
  };
  setChatAwaitingNotifier(task.id, awaitingNotifier);
  return { taskActionHandler, awaitingNotifier };
};

/**
 * 起 / 接 agent 前保证工作区在盘上：
 * 1. 任务 workspace 目录（tasks/<id>/workspace/、非 artifact 产出兜底落点）——建任务时已创建、
 *    这里兜底重建（老任务没有 / 用户手删）、mkdir recursive 幂等秒过、失败只 log 不挡启动
 * 2. 隔离 task 的 worktree——reopen 不重建、finalize 清过再问一问、用户手删 worktree
 *    都会让 cwd 指到不存在的路径；ensureTaskWorktrees 幂等、热路径秒过；非隔离 task 直接 noop。
 *    失败直接抛（分支被占等）——调用方已有错误处理、不在这里吞。
 */
const ensureWorkspaceReady = async (task: Task): Promise<void> => {
  // chat 不建 workspace 目录（跟 createTask 口径一致）；当前 chat 不走本 runner、纯防御
  if (task.mode !== "chat") {
    await fs
      .mkdir(getTaskWorkspaceDir(task.id), { recursive: true })
      .catch((err) =>
        console.warn(`[task-runner] 建 workspace 目录失败（忽略）task=${task.id}`, err),
      );
  }
  if (!isWorktreeTask(task)) return;
  await ensureTaskWorktrees(task);
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

  // 打点（v1.1.x「SDK 比 IDE 慢」排查）：启动链路各段耗时、[perf] 前缀统一可 grep 统计
  const perfStart = Date.now();

  // 兜底：调用方约定已 ensure，但 resume / 问一问 / 手删 worktree 等路径可能漏——入口再保证一次
  await ensureWorkspaceReady(task);
  const perfWorkspaceMs = Date.now() - perfStart;

  // host 按任务仓库 remote 现推（多实例不一致会 throw、起 agent 失败可见）
  const effectiveGitHost =
    (await resolveEffectiveGitHost(task.repoPaths)) ?? undefined;

  // 已有活 entry 时不重启（advanceTask 入口已处理 forceNewAgent 时的 cancel）
  if (runningTasks.has(task.id)) {
    console.warn(
      `[task-runner] internalStartAgent: task=${task.id} 已有 running entry、跳过（幂等）`,
    );
    return;
  }

  // 1) merge MCP（V0.11.1 抽成共用 helper、resume 会话时也要重传 inline MCP）
  const perfMcpStart = Date.now();
  const { mergedMcp, cursorMcpNames, droppedMcp } =
    await buildMergedMcpForTask(task);
  const perfMcpMs = Date.now() - perfMcpStart;
  const mcpDesc = `Task MCP: ${TASK_TOOL_MCP_NAME}${
    cursorMcpNames.length > 0 ? ` + cursor MCP: ${cursorMcpNames.join(", ")}` : ""
  }`;

  await writeEventAndPublish(task.id, {
    kind: "info",
    actionId: action.id,
    text: `启动新 agent（model: ${model.id}、${mcpDesc}）`,
  });

  // V0.6.11：有被剔除的 MCP → 写一条提示、让用户知道为什么少了能力（不再「莫名其妙报错」）
  if (droppedMcp.length > 0) {
    await writeEventAndPublish(task.id, {
      kind: "info",
      actionId: action.id,
      text: `⚠️ 已跳过 ${droppedMcp.length} 个不可用的 MCP：${droppedMcp
        .map((d) => `${d.name}（${d.detail?.split("\n")[0] ?? MCP_HEALTH_LABEL[d.status]}）`)
        .join("、")}——相关能力本次不可用、去设置页检查 / 授权`,
    });
  }

  // 2) 注册 task-scoped action handler + awaiting notifier（V0.11.1 抽成共用工厂、
  //    resume 会话时也要重注册——见 registerSessionBridges）
  const bridges = registerSessionBridges(task, { gitToken });


  // 4) 启动 Agent + 首个 run（在独立 Promise 里跑、advanceTask 立即返回）
  // fire-and-forget：外部 waitForTaskToStop 靠 poll runningTasks.has 收敛、不依赖此 promise
  void (async () => {
    let agent: AgentInstance | null = null;
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

      const perfCreateStart = Date.now();
      agent = await Agent.create({
        apiKey,
        model,
        // settingSources:[] = 不加载任何 .cursor/（彻底脱离 Cursor 安装 / 项目配置）。
        // rules / skills / mcp 全部由 fe 自管注入（readAppRulesForPrompt / loadSkills /
        // inline mcpServers）；曾用 ["project"] 时 chat 未绑目录 cwd=homedir 会把
        // ~/.cursor MCP 整包漏进 agent（实锤 bug）。
        local: { cwd: effectiveCwd, settingSources: [] },
        mcpServers: mergedMcp,
      });
      const perfCreateMs = Date.now() - perfCreateStart;
      console.log(
        `[task-runner] task=${task.id} Agent.create OK agentId=${agent.agentId}`,
      );

      // 启动窗口停止：create 返回后、尚未 register / send——无 run、直接关 agent + 收尾
      if (await applyPendingStopIfRequested(task, agent)) {
        unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
        unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
        return;
      }

      // V0.11：注册跨 run 会话——run 自然结束后 agent 不关、用户下一步操作 send 续接。
      // agentId 同步落盘（V0.11.1 会话持久化）：服务重启后 Agent.resume 无缝接回
      agentSessions.set(task.id, {
        agent,
        agentId: agent.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: captureTaskFieldsSnapshot(task),
      });
      void setTaskSessionAgentId(task.id, agent.agentId);

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
      const perfPromptMs = Date.now() - perfPromptStart;

      const perfSendStart = Date.now();
      const promptBytes = Buffer.byteLength(superPrompt, "utf-8");
      // SDK onDelta/onStep 细粒度耗时（thinking / tool / step / turn）——与下方 start-chain 汇总互补
      const perfTracker = createRunPerfTracker({
        taskId: task.id,
        agentId: agent.agentId,
        runKind: "task-first",
        promptBytes,
      });
      const run = await agent.send(superPrompt, {
        onDelta: perfTracker.onDelta,
        onStep: perfTracker.onStep,
      });
      perfTracker.attachRun(run);
      // 单行汇总（不写 events、纯日志）：workspace=worktree 确保、mcp=健康探测+merge、
      // create=SDK 冷启动、prompt=素材收割+拼装（含首包字节数）、send=Run 受理、total=自点推进起
      console.log(
        `[perf] task=${task.id} action=${action.type} start-chain ` +
          `workspace=${perfWorkspaceMs}ms mcp=${perfMcpMs}ms create=${perfCreateMs}ms ` +
          `prompt=${perfPromptMs}ms/${Math.round(promptBytes / 1024)}KB ` +
          `send=${Date.now() - perfSendStart}ms total=${Date.now() - perfStart}ms`,
      );
      // send 返回后的 pending 检查在 consumeSessionRun 入口（runningTasks.set 前）统一做
      await consumeSessionRun(task, agent, run, { errorActionId: action.id });
    } catch (err) {
      // 启动窗口点停止可能先 close 了会话 → send 抛错；按 cancelled 收尾、别标 error 覆盖
      if (agent && (await applyPendingStopIfRequested(task, agent))) {
        unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
        unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
        return;
      }
      // Agent.create / 首次 send 阶段失败（consumeSessionRun 内部错误它自己处理、不会抛）
      await handleRunFailure(task.id, action.id, err);
      if (agent) {
        closeTaskSession(task.id, agent.agentId);
      } else {
        // create 都没成：会话没注册——条件注销，防 force-new 后新 agent 已注册时误清
        unsetChatAwaitingNotifierIf(task.id, bridges.awaitingNotifier);
        unsetChatTaskActionHandlerIf(task.id, bridges.taskActionHandler);
      }
    }
  })();
};

// ----------------- V0.11：run 消费管道（首个 run + 后续 send 共用） -----------------

type SessionRun = Awaited<ReturnType<AgentInstance["send"]>>;

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
  opts: { errorActionId?: string; reconnectAttempt?: number },
  isCancelled: () => boolean,
): Promise<"handled" | "cancelled" | "give-up"> => {
  const attempt = (opts.reconnectAttempt ?? 0) + 1;
  if (attempt > RECONNECT_MAX) return "give-up";
  const msg = err instanceof Error ? err.message : String(err);
  if (!isRetryableRunError(msg, err)) return "give-up";
  if (isCancelled()) return "cancelled";
  // 任务已终结（用户重连期间 finalize / 删除）不再折腾
  const fresh = await getTask(task.id);
  if (!fresh || fresh.repoStatus === "merged" || fresh.repoStatus === "abandoned") {
    return "give-up";
  }
  await writeEventAndPublish(task.id, {
    kind: "info",
    actionId: opts.errorActionId,
    text: `连接中断、正在自动重连（第 ${attempt}/${RECONNECT_MAX} 次）…`,
    // 事件流按 reconnecting 渲染成过程行（spinner、同 thinking / 工具调用一档）
    meta: { kind: "reconnecting", attempt, max: RECONNECT_MAX },
  });
  if (await sleepWithCancel(RECONNECT_BACKOFF_MS[attempt - 1], isCancelled)) {
    return "cancelled";
  }
  // 旧 agent 连接已死：关内存会话但保留持久化锚点、Agent.resume 靠它接回同一会话
  closeTaskSession(task.id, undefined, { reap: false, keepPersisted: true });
  const creds = await readServerCreds();
  const record = await resumeTaskSession(fresh, creds).catch(() => null);
  if (!record) {
    // resume 没成（多半仍断网）：算一次、继续下一轮退避
    return tryAutoReconnect(fresh, err, { ...opts, reconnectAttempt: attempt }, isCancelled);
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
      onDelta: perfTracker.onDelta,
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
    await writeEventAndPublish(task.id, {
      kind: "info",
      actionId: opts.errorActionId,
      text: `重连成功（第 ${attempt} 次）、AI 继续工作`,
      meta: { kind: "reconnected", attempt },
    });
    await consumeSessionRun(fresh, resumedAgent, run, {
      ...opts,
      reconnectAttempt: attempt,
    });
    return "handled";
  } catch (sendErr) {
    // send 又失败（网络还没恢复）：继续下一轮
    return tryAutoReconnect(fresh, sendErr, { ...opts, reconnectAttempt: attempt }, isCancelled);
  }
};

// run 失败（SDK 抛错 / status=error）的统一收尾：标 error + 事件 + publish
const handleRunFailure = async (
  taskId: string,
  errorActionId: string | undefined,
  err: unknown,
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
  await finalizeStaleActions(taskId, "error");
  await setTaskRunStatus(taskId, "error", errorActionId ?? null);
  await writeEventAndPublish(taskId, {
    kind: "error",
    actionId: errorActionId,
    text: eventText,
    // 原始诊断落 meta（UI 不展示、事后从 events.jsonl 定位额度 vs 连接断）
    meta: { detail: failure.detail },
  });
  const errored = await getTask(taskId);
  if (errored) publish(taskId, { kind: "done", task: errored, ok: false });
  publish(taskId, { kind: "error", message: eventText });
};

/**
 * 问一问 run 收尾：按当前 action 状态把 runStatus 归回「提问前」的等待位
 * （awaiting_ack → awaiting_user、error → error、其余 → idle）。
 * 只在 runStatus 还挂 running 时动手（compare-set、不覆盖 notifier 已落的状态）。
 */
const restoreRunStatusAfterQuestion = async (taskId: string): Promise<void> => {
  const fresh = await getTask(taskId);
  if (!fresh || fresh.runStatus !== "running") return;
  const cur = fresh.actions.find((a) => a.id === fresh.currentActionId);
  const target =
    cur?.status === "awaiting_ack"
      ? ("awaiting_user" as const)
      : cur?.status === "error"
        ? ("error" as const)
        : ("idle" as const);
  const updated = await setTaskRunStatus(taskId, target, cur?.id ?? null);
  if (updated) publish(taskId, { kind: "task", task: updated });
};

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
const SUBMIT_WORK_FOLLOWUP_COUNTS_KEY = "__feAiFlowSubmitWorkFollowupCountsV1__";
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
 * 启动窗口停止请求生效：清标记 + 杀 run（如有）+ 关会话 + 与正常 cancel 一致的收尾。
 * @returns true = 命中 pending、已收尾，调用方应直接 return、勿进消费循环
 */
const applyPendingStopIfRequested = async (
  task: Task,
  agent: AgentInstance,
  run?: SessionRun,
): Promise<boolean> => {
  if (!pendingStopRequests.has(task.id)) return false;
  pendingStopRequests.delete(task.id);
  if (run) {
    void run.cancel().catch(() => {
      /* noop */
    });
  }
  // 有会话走身份门控关；create 后尚未 register 则直接 close agent
  if (!closeTaskSession(task.id, agent.agentId)) {
    try {
      agent.close();
    } catch {
      /* noop */
    }
    void setTaskSessionAgentId(task.id, undefined);
  }
  clearSubmitWorkFollowupCounts(task.id);
  await finalizeStaleActions(task.id, "cancelled");
  const updated = await setTaskRunStatus(task.id, "idle");
  await writeEventAndPublish(task.id, {
    kind: "info",
    text: "停止请求已生效（启动期间点击的停止）",
  });
  if (updated) publish(task.id, { kind: "task", task: updated });
  publish(task.id, { kind: "done", task: updated ?? task, ok: true });
  return true;
};

const buildSubmitWorkFollowup = (last: {
  id: string;
  type: string;
  n: number;
  artifactPath?: string | null;
}): string =>
  [
    "[ai-flow] 你还没对当前 action 交卷——不要结束本次回复。",
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
  },
): Promise<void> => {
  let cancelled = false;
  let hardTimer: NodeJS.Timeout | null = null;
  try {
    // 消费循环开始前：启动窗口点的停止在此生效（含 advance 续接 send 路径）
    if (pendingStopRequests.has(task.id)) {
      // 问一问 run：不动 action / 不关会话（与下方 cancelled 分支同语义）
      if (opts.questionRun) {
        pendingStopRequests.delete(task.id);
        void run.cancel().catch(() => {
          /* noop */
        });
        await restoreRunStatusAfterQuestion(task.id);
        const freshQ = await getTask(task.id);
        publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
        return;
      }
      if (await applyPendingStopIfRequested(task, agent, run)) return;
    }

    runningTasks.set(task.id, {
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
        await writeEventAndPublish(task.id, {
          kind: "assistant_message",
          actionId: undefined,
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
      await handleSdkMessage(task.id, msg, assistantCtx);
    }
    await assistantCtx.flush();

    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }

    const result = await run.wait();

    if (cancelled || result.status === "cancelled") {
      // 停止 / 推进：追问计数一并清掉，避免下次同 action 续跑还背着旧计数
      clearSubmitWorkFollowupCounts(task.id);
      const isForkPending = forkPendingTasks.has(task.id);
      if (isForkPending) {
        forkPendingTasks.delete(task.id);
        // 换新 agent：会话由 advance 的 force-new 分支显式关（reap:false）、这里不动
        await writeEventAndPublish(task.id, {
          kind: "info",
          text: "旧 agent 已收尾、正在为推进起新 agent...",
        });
        return;
      }
      // 问一问的 run 被停：只是不想听它说了——action / 会话都不动、runStatus 归回等待位
      if (opts.questionRun) {
        await restoreRunStatusAfterQuestion(task.id);
        const freshQ = await getTask(task.id);
        publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
        return;
      }
      // 正常 cancel（停止 / 硬超时触发）→ 收尾卡住的 action + 关运行时状态 + 关会话
      // （repoStatus 仍由 finalizeTask 管、这里只补 action 收尾、不动业务态）
      await finalizeStaleActions(task.id, "cancelled");
      // 保留 currentActionId（不传第三参）：被停的 action 已标 cancelled、仍是「当前 action」、
      const updated = await setTaskRunStatus(task.id, "idle");
      if (updated) publish(task.id, { kind: "task", task: updated });
      publish(task.id, { kind: "done", task: updated ?? task, ok: true });
      closeTaskSession(task.id, agent.agentId);
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
    const fresh = await getTask(task.id);
    const lastAction = fresh?.actions[fresh.actions.length - 1];
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
      const sessionAlive =
        agentSessions.get(task.id)?.agentId === agent.agentId;
      if (used < SUBMIT_WORK_FOLLOWUP_MAX && sessionAlive) {
        submitWorkFollowupCounts.set(followupKey, used + 1);
        const followup = buildSubmitWorkFollowup(lastAction);
        console.log(
          `[task-runner] task=${task.id} action#${lastAction.n}(${lastAction.type}) 未交卷 → send 追问 ${used + 1}/${SUBMIT_WORK_FOLLOWUP_MAX}`,
        );
        await writeEventAndPublish(task.id, {
          kind: "info",
          actionId: lastAction.id,
          text: `未交卷，正在追问 agent 补调 submit_work（${used + 1}/${SUBMIT_WORK_FOLLOWUP_MAX}）…`,
        });
        // 写事件 ↔ send 之间有 1~3s 窗口：用户此刻点「停止」会 closeTaskSession，
        // 推进 force-new 会换 agentId。再不查一次就 send 抛错走 error、覆盖 stop 刚落的 cancelled/idle。
        const stillOwnSession =
          agentSessions.get(task.id)?.agentId === agent.agentId;
        if (cancelled || !stillOwnSession) {
          submitWorkFollowupCounts.delete(followupKey);
          if (forkPendingTasks.has(task.id)) {
            forkPendingTasks.delete(task.id);
            await writeEventAndPublish(task.id, {
              kind: "info",
              text: "旧 agent 已收尾、正在为推进起新 agent...",
            });
            return;
          }
          await finalizeStaleActions(task.id, "cancelled");
          const updated = await setTaskRunStatus(task.id, "idle");
          if (updated) publish(task.id, { kind: "task", task: updated });
          publish(task.id, { kind: "done", task: updated ?? task, ok: true });
          // 会话可能已被 stop 关掉；带 agentId 避免误关后来者
          closeTaskSession(task.id, agent.agentId);
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
            onDelta: perfTracker.onDelta,
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
            if (forkPendingTasks.has(task.id)) {
              forkPendingTasks.delete(task.id);
              await writeEventAndPublish(task.id, {
                kind: "info",
                text: "旧 agent 已收尾、正在为推进起新 agent...",
              });
              return;
            }
            await finalizeStaleActions(task.id, "cancelled");
            const updated = await setTaskRunStatus(task.id, "idle");
            if (updated) publish(task.id, { kind: "task", task: updated });
            publish(task.id, { kind: "done", task: updated ?? task, ok: true });
            closeTaskSession(task.id, agent.agentId);
            return;
          }
          // 真·网络 / SDK 失败 → 跟追问耗尽一样收尾
          submitWorkFollowupCounts.delete(followupKey);
          await patchAction(task.id, lastAction.id, { status: "error" });
          await setTaskRunStatus(task.id, "error", lastAction.id);
          await writeEventAndPublish(task.id, {
            kind: "error",
            actionId: lastAction.id,
            text: [
              `agent 在 action ${lastAction.type} n=${lastAction.n} 没交卷就结束了，且追问失败`,
              "",
              "下一步：在底部输入条说句话即可唤醒本阶段继续、或重新「推进」",
            ].join("\n"),
          });
          const updated = await getTask(task.id);
          if (updated) publish(task.id, { kind: "task", task: updated });
          publish(task.id, { kind: "done", task: updated ?? task, ok: false });
          closeTaskSession(task.id, agent.agentId);
          return;
        }
        // 追问本身也是一轮 run、走同一管道（计数已 +1、再未交卷会再追或标 error）
        await consumeSessionRun(task, agent, nextRun, opts);
        return;
      }
      // 追问次数用尽 / 会话已死 → 标 error + 关会话
      submitWorkFollowupCounts.delete(followupKey);
      await patchAction(task.id, lastAction.id, { status: "error" });
      await setTaskRunStatus(task.id, "error", lastAction.id);
      await writeEventAndPublish(task.id, {
        kind: "error",
        actionId: lastAction.id,
        text: [
          `agent 在 action ${lastAction.type} n=${lastAction.n} 没交卷（没调 submit_work）就结束了回复`,
          "",
          "下一步：在底部输入条说句话即可唤醒本阶段继续、或重新「推进」",
        ].join("\n"),
      });
      const updated = await getTask(task.id);
      if (updated) publish(task.id, { kind: "task", task: updated });
      publish(task.id, { kind: "done", task: updated ?? task, ok: false });
      closeTaskSession(task.id, agent.agentId);
      return;
    }
    // 交卷 / ask / 终态成功路径：清掉该 action 的追问计数（若有）
    if (lastAction) {
      submitWorkFollowupCounts.delete(`${task.id}:${lastAction.id}`);
    }

    // 问一问 run 答完：按当前 action 状态归回等待位（含 error 位、比下面的通用兜底全）
    if (opts.questionRun) {
      await restoreRunStatusAfterQuestion(task.id);
      const freshQ = await getTask(task.id);
      publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
      return;
    }

    // 正常结束：交卷已入 check 管道（awaiting_ack / awaiting_user 由 check、notifier 落）、
    // 或 ask 在等答案。会话保留、用户下一步操作 send 续接。
    // 兜底：最后 action 已终态（completed / cancelled / error）而 runStatus 还挂 running → 归 idle
    if (
      !lastAction ||
      lastAction.status === "completed" ||
      lastAction.status === "cancelled"
    ) {
      const freshest = await getTask(task.id);
      if (freshest?.runStatus === "running") {
        const updated = await setTaskRunStatus(task.id, "idle", null);
        if (updated) publish(task.id, { kind: "task", task: updated });
      }
    } else if (lastAction.status === "awaiting_ack") {
      // 等审阅期间的续接 run（如 revise 处理完自然结束）兜底回等待位。
      // 正常交卷路径 runStatus 早被 notifier 落成 awaiting_user、这里 compare-set 不动它。
      const freshest = await getTask(task.id);
      if (freshest?.runStatus === "running") {
        const updated = await setTaskRunStatus(task.id, "awaiting_user", lastAction.id);
        if (updated) publish(task.id, { kind: "task", task: updated });
      }
    }
    publish(task.id, { kind: "done", task: fresh ?? task, ok: true });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    if (opts.questionRun) {
      // 问一问失败（网络抖动 / SDK 报错）：只报错误事件 + 归位 runStatus——
      // 绝不把 awaiting_ack 审阅位 / 半路 action 打成 error（答疑失败不该伤任务本体）
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[task-runner] task=${task.id} 问一问 run 失败：`, err);
      await writeEventAndPublish(task.id, {
        kind: "error",
        text: `答疑失败：${summarizeRunFailure(message, err).text}`,
      });
      await restoreRunStatusAfterQuestion(task.id);
      const freshQ = await getTask(task.id);
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
        if (forkPendingTasks.has(task.id)) {
          // force-new 在飞（cancel 旧 run 引发的抛错路径）：新 agent 由 advance 分支管、
          // 这里不动状态、更不能关会话（会误关刚起的新会话）
          forkPendingTasks.delete(task.id);
        } else {
          // 用户在重连期间点了停止：按停止语义收尾（不标 error）。
          // 关会话不带 agentId：重连过程可能已注册新会话（resume 成功 send 失败）、
          // 用旧 agentId 关不掉会泄漏（审计 P1）
          await finalizeStaleActions(task.id, "cancelled");
          const updated = await setTaskRunStatus(task.id, "idle");
          if (updated) publish(task.id, { kind: "task", task: updated });
          publish(task.id, { kind: "done", task: updated ?? task, ok: true });
          closeTaskSession(task.id);
        }
      } else {
        await handleRunFailure(task.id, opts.errorActionId, err);
        closeTaskSession(task.id);
      }
    }
  } finally {
    // 身份比对：推进 force-new 超时强清后新 run 已注册时，旧追问链 finally 不能把新登记删掉
    // （同构 runningChecks 的 `=== self`——这里用 agentId，因每次 set 都是新对象）
    const cur = runningTasks.get(task.id);
    if (cur?.agentId === agent.agentId) {
      runningTasks.delete(task.id);
    }
    // 会话活跃时间戳（空闲回收 TTL 从「最后一个 run 结束」起算）
    const session = agentSessions.get(task.id);
    if (session && session.agentId === agent.agentId) {
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
      url: getChatMcpUrl(),
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
 */
const resumeTaskSession = async (
  task: Task,
  creds: SessionCreds,
): Promise<AgentSessionRecord | null> => {
  if (!task.sessionAgentId || !creds.apiKey) return null;
  // resume 后 send 必须有显式 model：优先「原会话实际在用的模型」（最近带 agentModel 的 action）、
  // 兜底 client 传来的（settings 默认模型）
  const model =
    [...task.actions].reverse().find((a) => a.agentModel)?.agentModel ??
    task.model ??
    creds.model;
  if (!model) return null;
  // 放 try 外：ensure 失败（分支被占等）应冒泡给调用方；try 只兜 Agent.resume 失败降级
  await ensureWorkspaceReady(task);
  try {
    const { mergedMcp } = await buildMergedMcpForTask(task);
    const agent = await Agent.resume(task.sessionAgentId, {
      apiKey: creds.apiKey,
      model,
      // 本地 agent 按 cwd 定位持久化存储、必须跟 create 时一致（不传会 AgentNotFoundError、实测踩过）
      // settingSources:[] 同 create——不加载 .cursor/、全部 fe 自管注入
      local: { cwd: getTaskCwd(task), settingSources: [] },
      mcpServers: mergedMcp,
    });
    // 恢复的 agent 调 submit_mr / submit_work 要走桥、必须重注册
    registerSessionBridges(task, {
      gitToken: creds.gitToken,
    });
    const record: AgentSessionRecord = {
      agent,
      agentId: agent.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: captureTaskFieldsSnapshot(task),
    };
    agentSessions.set(task.id, record);
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
      `[task-runner] task=${task.id} Agent.resume 失败（清锚点、降级 fresh agent）`,
      err,
    );
    void setTaskSessionAgentId(task.id, undefined);
    return null;
  }
};

/**
 * V0.11：ask_user 答案送达（ask-reply 路由用）——`agent.send([ASK_USER_REPLY]…)` 续会话。
 * @returns false = 没有可续接的会话、路由报 409 让用户重启断点续传
 */
export const deliverAskReply = async (
  task: Task,
  replyText: string,
  imagePaths?: string[],
  errorActionId?: string,
  creds?: SessionCreds,
): Promise<boolean> =>
  sendToTaskSession(
    task,
    buildAgentMessage({ kind: "user_reply", text: replyText, imagePaths }),
    { errorActionId, creds, runKind: "task-ask-reply" },
  );

/**
 * V0.13.x 统一消息：把任务页输入条的消息 send 给存活会话（AI 自主二分类、见
 * buildAgentMessage user_message 分支）。无会话时凭 creds resume、接不回返 false。
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
): Promise<boolean> =>
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
      ? { creds, errorActionId: ackContext.actionId }
      : { creds, questionRun: true },
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
): void => {
  const prevRunStatus = task.runStatus === "running" ? "idle" : task.runStatus;
  void (async () => {
    let agent: AgentInstance | null = null;
    try {
      // finalize / 手删后 worktree 可能已不在——起兜底 agent 前先保证目录存在
      await ensureWorkspaceReady(task);
      const effectiveCwd = getTaskCwd(task);
      agent = await Agent.create({
        apiKey: creds.apiKey,
        model: creds.model,
        // settingSources:[] 同正式会话——不加载 .cursor/、全部 fe 自管注入
        local: { cwd: effectiveCwd, settingSources: [] },
      });
      console.log(
        `[task-runner] task=${task.id} 问一问兜底 agent 已起 agentId=${agent.agentId}`,
      );
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
      const perfTracker = createRunPerfTracker({
        taskId: task.id,
        agentId: agent.agentId,
        runKind: "question",
        promptBytes: Buffer.byteLength(prompt, "utf-8"),
      });
      const run = await agent.send(prompt, {
        onDelta: perfTracker.onDelta,
        onStep: perfTracker.onStep,
      });
      perfTracker.attachRun(run);
      // questionRun：任何出口（答完 / 被停 / 失败）都不动 action、runStatus 由 consume 统一归位
      await consumeSessionRun(task, agent, run, { questionRun: true });
    } catch (err) {
      console.error(`[task-runner] task=${task.id} 问一问兜底失败：`, err);
      await writeEventAndPublish(task.id, {
        kind: "error",
        text: `答疑 agent 启动失败：${err instanceof Error ? err.message : String(err)}`,
      });
      const restored = await setTaskRunStatus(task.id, prevRunStatus);
      if (restored) publish(task.id, { kind: "task", task: restored });
    } finally {
      try {
        agent?.close();
      } catch {
        /* noop */
      }
    }
  })();
};

/**
 * V0.11：把用户操作以新消息发给 task 的存活会话（`agent.send`）、并消费产生的新 run。
 * V0.11.1：内存没会话但有落盘 sessionAgentId 且带了凭据 → 先 Agent.resume 接回再 send。
 * V0.11.7：入口先等在飞 run 排空（几秒级协议间隙、见 waitForRunToDrain）再 send、
 * 不再直接拒——用户秒答 ask 弹窗撞上「run 还没 finished」曾被误报「没有活跃会话」。
 *
 * @returns false = 没有可续接的会话（没 session 且 resume 不了 / run 排空超时 / send 抛错）、
 * 调用方走降级（推进 → force-new agent；再聊聊 / ask 答案 → 报错让用户推进或重启）
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
  } = {},
): Promise<boolean> => {
  if (!(await waitForRunToDrain(task.id))) {
    console.warn(
      `[task-runner] sendToTaskSession: task=${task.id} run 排空超时、拒绝并发 send`,
    );
    return false;
  }
  let session = agentSessions.get(task.id) ?? null;
  if (!session && opts.creds) {
    session = await resumeTaskSession(task, opts.creds);
  }
  if (!session) return false;
  const agent = session.agent as AgentInstance;
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
      onDelta: perfTracker.onDelta,
      onStep: perfTracker.onStep,
    });
    perfTracker.attachRun(run);
  } catch (err) {
    // 续接 / 问一问 send 期间点停止会先 close 会话 → send 抛错；
    // 按 pending 收尾并返 true，避免 advanceTask 误判会话失效去 force-new
    if (pendingStopRequests.has(task.id)) {
      if (opts.questionRun) {
        pendingStopRequests.delete(task.id);
        await restoreRunStatusAfterQuestion(task.id);
        const freshQ = await getTask(task.id);
        publish(task.id, { kind: "done", task: freshQ ?? task, ok: true });
        return true;
      }
      if (await applyPendingStopIfRequested(task, agent)) return true;
    }
    // send 失败（会话失效 / SDK 异常）→ 关掉这个坏会话、调用方降级
    console.error(`[task-runner] sendToTaskSession: task=${task.id} send 失败`, err);
    closeTaskSession(task.id, session.agentId);
    return false;
  }
  session.lastActiveAt = Date.now();
  // fire-and-forget 消费（跟首个 run 同一管道）；调用方只需要「send 成功已开跑」
  // pending 停止检查在 consumeSessionRun 入口（runningTasks.set 前）
  void consumeSessionRun(task, agent, run, {
    errorActionId: opts.errorActionId,
    questionRun: opts.questionRun,
  });
  return true;
};
