/**
 * Task runner（V0.6 重构、仅服务 task.mode === "task" 的 task）
 *
 * # 整体模型（详见 docs/V0.6-REFACTOR.md）
 *
 * - **task 容器 + action 历史**：task = 需求生命周期容器、action = 单次动作
 *   （plan / build / review / ship / learn / dev）、用户自由触发
 * - **单 SDK Run 永生**：整个 task 共用一个 Agent + Run、task 终态前不退
 * - **每次推进** = 后端 `appendAction` + 向 agent 发 `[NEXT_ACTION ...]` 指令
 * - **每次 ack** = wait-ack write `[ACTION_ACK approve|revise]`
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
 *   - task-prompts.ts：super-prompt 拼装 + [NEXT_ACTION]/[RESTART_ACTION] directive 构造（纯函数）
 *   - action-gates.ts：action 准入门槛 + ship 预检 + build 分支规划（纯函数）
 *   - sdk-message-handler.ts：SDKMessage → 事件流翻译器
 */

import { Agent } from "@cursor/sdk";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

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
import { snapshotActionArtifact } from "./task-artifacts";
import {
  runActionCheck,
  captureActionStartBaseline,
} from "./action-checks";
import { summarizeRunFailure } from "./sdk-error";
import { getChatMcpUrl } from "./chat-mcp";
import {
  cancelPending,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
  submitActionAck,
  submitNextAction,
  submitTaskTerminate,
  unsetChatAwaitingNotifierIf,
  unsetChatTaskActionHandlerIf,
  type AwaitingNotifier,
  type ChatTaskActionHandler,
} from "./chat-pending";
import { createMR, getMRMergeStatus, closeOpenMR } from "./gitlab-client";
import { validateSubmitMr } from "./submit-mr-guard";
import { ensureStopHookInstalled } from "./stop-hook-inject";
import { reapTaskOrphans } from "./kill-orphans";
import { getEffectiveCwd } from "@/lib/path-utils";
import { loadSkills, type SkillEntry } from "./skills-loader";
import {
  filterDisabledMcp,
  readGlobalCursorMcpServers,
} from "./cursor-config";
import { enrichMcpServersWithOAuth } from "./mcp-oauth";
import { filterHealthyMcp } from "./mcp-probe";
import { getCustomAction } from "./custom-action-fs";
import {
  forceClearStaleRunnerState,
  forkPendingTasks,
  publish,
  runningChecks,
  runningTasks,
  waitForTaskToStop,
  writeEventAndPublish,
  truncate,
  stringifyMeta,
  type RunningCheck,
} from "./task-stream";
import {
  buildBatchDirective,
  buildNextActionDirective,
  buildPlanReplanDirective,
  buildRestartActionInstruction,
  buildReviewScopeDirective,
  buildSuperPrompt,
  buildTaskUpdateHint,
  captureTaskFieldsSnapshot,
  loadActionPrompt,
} from "./task-prompts";
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
  AskUserQuestion,
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
import { isAskSettled } from "@/lib/ask-pending";

// ----------------- 配置 -----------------

// task 不主动超时（用户随时可能 24h 后才 ack）
const TASK_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// chat-mcp 在 Agent.mcpServers 里的注册名（agent prompt 里得点明、跟 V0.5 沿用）
const TASK_TOOL_MCP_NAME = "aiFlowChat";

/**
 * 作废 task 下「当前还没被回答的 ask_user_request」。
 *
 * 为什么需要（用户实测踩坑、断线重启「多弹窗并发」根因）：
 *   旧 agent 被 cancel / 断线后、它发起的那组 ask 的 token 已失效、永远不会再被 resolve。
 *   但前端 AskUserDialog 只看「ask_user_request 有没有配对的 ask_user_reply」来决定弹不弹——
 *   不作废这条孤儿 ask、它会永久 pending：重启后反复复活弹窗、用户答了必 410（agent 没了）
 *   再把 runStatus 打回 error、和失效态/restart_intent 弹窗在单例上反复横跳、关不完。
 *
 * 作废方式：写一条 info 事件标记 `meta.supersededAskId=askId`（不补 ask_user_reply——那会让
 *   事件流显示成「你的回答」、语义不对；也不走 deferred——断线是被动打断、不是用户主动放弃）。
 *   前端 pendingEvent / AskUserRequestRow 据此把这条旧 ask 当「已失效」、不再弹。
 *
 * 调用方：
 *   - restartCurrentAction：清孤儿 + 用返回的 questions 让新 agent 断点续传重问
 *   - advanceTask（起新 agent）/ stop 路由：只清孤儿（开新 action / 主动停、不续传）、忽略返回值
 *
 * @returns 最近一条被作废的 ask 的 questions（供重启时让新 agent 断点续传重新问）、没有则空数组。
 */
export const supersedePendingAsks = async (
  taskId: string,
  reason: string,
): Promise<AskUserQuestion[]> => {
  const task = await getTask(taskId);
  if (!task) return [];
  // 最近一条未答 ask 的问题（events 正序遍历、后命中的覆盖前面的 = 时间上最近的那组）
  let latestQuestions: AskUserQuestion[] = [];
  for (const ev of task.events) {
    if (ev.kind !== "ask_user_request") continue;
    const askId = typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
    if (!askId) continue;
    // 已被回答 / 已被作废过的跳过（幂等：重复重启不重复写标记、判定见 lib/ask-pending）
    if (isAskSettled(task.events, askId)) continue;
    await writeEventAndPublish(taskId, {
      kind: "info",
      actionId: ev.actionId,
      text: `上一组提问因${reason}失效、无需再回答。`,
      meta: { supersededAskId: askId },
    });
    if (Array.isArray(ev.meta?.questions)) {
      latestQuestions = ev.meta.questions as AskUserQuestion[];
    }
  }
  return latestQuestions;
};

// ----------------- 公开 query API -----------------

export const cancelTaskRun = (taskId: string): boolean => {
  const rec = runningTasks.get(taskId);
  if (!rec) return false;
  rec.cancel();
  return true;
};

/**
 * V0.8.18：后台跑某 action 的后置 deterministic check（异步、不阻塞调用方）。
 *
 * # 为什么后台跑（线上踩过）
 * check 若在 awaitingNotifier 里被 `wait_for_user` MCP 工具**同步 await**、工具就要阻塞到
 * check 跑完才返回、慢了会撞 Cursor SDK ~60s 工具超时 → agent 收到「超时」后困惑乱来。
 * 改成：notifier 立即返回（agent 秒回引导、第一时间挂 curl long-poll 等 ack）、check 在这里后台跑、
 * 跑完再落结果 + 切 awaiting_ack + 发「产出完成」事件。
 * （v0.9.13 CheckRun 删除后 check 只剩 artifact 读文件 + git status hash、通常秒级、
 *   但 review 多仓 git 指纹仍可能上秒、后台架构保留。）
 *
 * # 去重 + 取消（消灭重复跑 + 状态交错）
 * 一个 task 同时只允许一个在跑的 check（runningChecks）。新一轮 wait（如 revise 改完代码再 wait）会
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
 * V0.8.18：取消某 task 正在后台跑的后置 check（停止 / 推进新 action / 重启当前 action 时调）。
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

/**
 * V0.6.3：agent_id 反查 task_id（stop hook 认领用）
 *
 * runningTasks 是 task_id → { agentId, ... }、这里遍历找 agentId 匹配的（活着的 task 数量很小、
 * 遍历开销可忽略）。找不到 = 不是当前活着的 fe task（IDE agent / 已死 task）、stop hook 应放行。
 */
export const findTaskIdByAgentId = (agentId: string): string | null => {
  for (const [taskId, rec] of runningTasks) {
    if (rec.agentId === agentId) return taskId;
  }
  return null;
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
  // 设置页 username（拼 build branch 名用、缺省时不建 branch）
  username?: string;
  // V0.6.1 ship action 用：GitLab host（不带协议）+ Personal Access Token
  // 来自 settings.gitHost / gitToken、agent 启动时快照、改 token 需 forceNewAgent
  gitHost?: string;
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

export interface RestartCurrentActionInput {
  task: Task;
  actionId?: string;
  apiKey: string;
  model: ModelSelection;
  username?: string;
  gitHost?: string;
  gitToken?: string;
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
    username,
    gitHost,
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

  // 自定义 action：提前读定义（拿 freshAgent 默认 + label 快照）。读不到不致命——
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

  // V0.6.27 默认反转：每 action 默认起新 agent（context 截断是治跑偏的根、artifact 是唯一接力棒）。
  // 用户勾「续用当前 agent」（reuseAgent）才续接——除了 ACTION_FRESH_AGENT_DEFAULT 里 true 的
  // action（review = 换人复审铁律）、勾了也压不掉。
  // 自定义 action 的 fresh 默认取定义里的 freshAgent（缺省回退 ACTION_FRESH_AGENT_DEFAULT.custom）
  const actionFreshDefault =
    customDef && typeof customDef.freshAgent === "boolean"
      ? customDef.freshAgent
      : ACTION_FRESH_AGENT_DEFAULT[actionType];
  const effectiveForceNewAgent = !reuseAgent || actionFreshDefault;

  // V0.x：去掉手动「通过」按钮后、推进吸收认可——若当前 action 还在等 ack、推进时先隐式认可它。
  //   放在准入之前 + 认可后重读 task：下面 checkActionPrerequisites 看到的就是
  //   「认可后」状态（当前 action 已 completed）、原准入逻辑一行不用动。
  const existingRecord = runningTasks.get(task.id);
  const pendingAck = task.actions.find(
    (a) => a.id === task.currentActionId && a.status === "awaiting_ack",
  );
  if (pendingAck) {
    if (existingRecord && !effectiveForceNewAgent) {
      // 续接：acknowledgeAction 发 [ACTION_ACK approve] 让旧 agent 转待命 + 标 completed + 写事件。
      //   下方 submitNextAction 若早于 agent 进待命、pendingNextActions 兜时序（V0.6.19）。
      await acknowledgeAction(task.id, pendingAck.id, "approve");
    } else {
      // force-new / 无活 agent：旧 agent 下面反正要 cancel、不发信号（发了会因 agent 将死 throw）、
      //   只标 completed + 写审计事件——否则 force-new 路径的 finalizeStaleActions 会把它误标 cancelled。
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
    }
    // 认可改了当前 action 状态 → 重读最新 task、后续准入 / appendAction / 路由都用它
    task = (await getTask(task.id)) ?? task;
  }

  // 1) 准入条件（V0.6 门槛 1）
  const pre = checkActionPrerequisites(task, actionType, { gitHost, gitToken });
  if (!pre.ok) {
    throw new Error(`准入条件不满足：${pre.reason}`);
  }

  // 2) appendAction：写一条新 ActionRecord、task.runStatus 自动转 running
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
  // V0.6.27：review / build 启动基线（review=各仓内容指纹、build=兄弟仓状态 hash）
  // 后置检查比对用（review 只读硬校验 / 兄弟仓越权检测）、采集失败 fail-open 不挡启动
  if (actionType === "review" || actionType === "build") {
    const baseline = await captureActionStartBaseline(task, actionType);
    if (baseline) {
      await patchAction(task.id, action.id, { startBaseline: baseline });
      action.startBaseline = baseline;
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
  let branchCheckoutHint: string | undefined;
  if (actionType === "build") {
    const planned = planBranchesForBuild(taskAfterAppend, username);
    if (planned) {
      // 仅新仓 upsert（已存在的保留 createdAt / baseBranch 历史值、不覆盖）
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

  // 4) 决定路由（existingRecord 已在开头隐式认可段提前取）
  if (existingRecord && !effectiveForceNewAgent) {
    // V0.6.6 热更：agent 长生期间用户可能在详情页改了 role / title / feishuStoryUrl
    // diff 启动快照、有变才拼一段 [TASK_UPDATED] 注入；注入后把快照推进到当前值、避免下次重复告知同一变更
    const taskUpdateHint = buildTaskUpdateHint(
      taskAfterAppend,
      existingRecord.startSnapshot,
    );
    existingRecord.startSnapshot = captureTaskFieldsSnapshot(taskAfterAppend);
    // V0.6.27：续接载荷附本 action 的完整 playbook——super prompt 只注入了启动时那个
    // action 的指令、续接的新 action（哪怕同类型）以载荷这份为准
    const actionPlaybook = await loadActionPrompt(action, taskAfterAppend);
    // agent 在「待命态」（等下一 action 指令）、submitNextAction 直接续接
    const ok = submitNextAction(
      task.id,
      {
        actionId: action.id,
        type: action.type,
        n: action.n,
        artifactPath: action.artifactPath ?? "",
      },
      buildNextActionDirective({
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
      attachedImagePaths,
      attachedFilePaths,
    );
    if (!ok) {
      // race：runningTasks entry 存在但 chat-mcp pendingMap 没（agent 已死、entry 还没清）
      // 走「force new agent」分支补救
      console.warn(
        `[task-runner] advanceTask: task=${task.id} runningTasks 有 entry 但 submitNextAction 失败、降级 force-new-agent`,
      );
      await internalStartAgent({
        task: taskAfterAppend,
        action,
        userInstruction,
        attachedImagePaths,
        attachedFilePaths,
        branchCheckoutHint,
        apiKey,
        model,
        gitHost,
        gitToken,
        batchDirective,
        replanDirective,
      });
    }
    return { action };
  }

  // 5) 没活 agent / forceNewAgent：起新 Run
  if (existingRecord && effectiveForceNewAgent) {
    forkPendingTasks.add(task.id);
    existingRecord.cancel();
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
  // 起新 agent 跑新 action 前、作废上一个 agent 没答完的孤儿 ask（同 restartCurrentAction：不清掉
  // 前端会弹失效的旧问题弹窗、用户答了必报错；严重时还把 runStatus 打回 error 死循环）。
  // 推进是「开新 action」语义、不续传旧问题（用户主动换方向 = 放弃旧断点）、只清孤儿、忽略返回值。
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
    gitHost,
    gitToken,
    batchDirective,
    replanDirective,
  });

  return { action };
};

export const restartCurrentAction = async (
  input: RestartCurrentActionInput,
): Promise<{ action: ActionRecord }> =>
  runAdvanceExclusive(input.task.id, () => restartCurrentActionInner(input));

const restartCurrentActionInner = async (
  input: RestartCurrentActionInput,
): Promise<{ action: ActionRecord }> => {
  // V0.8.18：重启当前 action 前、取消它可能还在后台跑的旧 check（要重跑、且防旧结果污染新一轮）
  abortRunningCheck(input.task.id);
  const fresh = await getTask(input.task.id);
  if (!fresh) throw new Error("task 不存在、无法重启当前 action");
  if (fresh.mode === "chat") {
    throw new Error("chat 模式不支持 action 重启，请继续发消息");
  }
  if (fresh.repoStatus === "merged" || fresh.repoStatus === "abandoned") {
    throw new Error("任务已终结，不能重启当前 action");
  }

  const actionId = input.actionId ?? fresh.currentActionId;
  if (!actionId) {
    throw new Error("当前没有可重启的 action");
  }
  const action = fresh.actions.find((a) => a.id === actionId);
  if (!action) {
    throw new Error(`action ${actionId} 不存在、无法重启`);
  }
  if (action.status === "awaiting_ack") {
    throw new Error("当前 action 已在等待确认，请用「再聊聊」继续修改");
  }
  if (action.status === "completed") {
    throw new Error("已通过的 action 不能重启，请推进新的 action");
  }

  const existingRecord = runningTasks.get(fresh.id);
  if (existingRecord) {
    forkPendingTasks.add(fresh.id);
    existingRecord.cancel();
    const stopped = await waitForTaskToStop(fresh.id, 5000);
    if (!stopped) {
      console.warn(
        `[task-runner] restartCurrentAction: task=${fresh.id} 旧 agent 没在 5s 内停、强清 runner state 继续`,
      );
      forceClearStaleRunnerState(fresh.id);
    }
  }
  cancelPending(fresh.id);
  reapTaskOrphans(fresh.repoPaths);

  // 作废旧 agent 那条还没答完的 ask（断线后它的 token 已失效、不清掉前端会反复弹失效旧弹窗、
  // 用户答了必 410 把 runStatus 打回 error、形成多弹窗并发 + 死循环）。
  // 返回的 pendingQuestions = 用户没答完的那组问题：非空 → 新 agent 断点续传原样重问；空 → 走 restart_intent。
  const pendingQuestions = await supersedePendingAsks(fresh.id, "agent 断线重启");

  const patchedTask = await patchAction(fresh.id, action.id, { status: "running" });
  const patchedAction =
    patchedTask?.actions.find((a) => a.id === action.id) ?? action;
  if (patchedTask) {
    publish(fresh.id, { kind: "task", task: patchedTask });
    publish(fresh.id, { kind: "action", action: patchedAction });
  }
  let startTask =
    (await setTaskRunStatus(fresh.id, "running", action.id)) ??
    patchedTask ??
    fresh;
  publish(fresh.id, { kind: "task", task: startTask });

  await writeEventAndPublish(fresh.id, {
    kind: "info",
    actionId: action.id,
    text: `用户重启了当前 ${actionDisplayLabel(action)} action（n=${action.n}），沿用原 action 继续执行`,
    meta: { restartedActionId: action.id, actionType: action.type, n: action.n },
  });

  let branchCheckoutHint: string | undefined;
  if (action.type === "build") {
    const planned = planBranchesForBuild(startTask, input.username);
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

  // 重启模型 = 用户在 RestartDialog 里选的（input.model）。前端 dialog 默认就回填该 action 的
  // agentModel：没改 = 沿用原模型重跑、改了 = 换个模型接手。这样「断线重启掉回默认模型」那个老坑
  // （plan 选 opus-4.8、重启变 composer-2.5）由「前端默认填 agentModel」从源头堵住、后端不必再
  // 优先 agentModel。
  const restartModel = input.model;

  // 每次重启都把 agentModel 回写成 restartModel（可能换了模型、也可能补老数据空 agentModel）、
  // 保证「卡片显示模型 = 实际重跑模型」一致。patch 后 task / action 取最新值
  // （effectiveStartTask / effectiveStartAction）、让启动 prompt、SSE publish、最终 return 三处口径一致。
  let effectiveStartTask = startTask;
  let effectiveStartAction = startAction;
  const patchedModel = await patchAction(fresh.id, startAction.id, {
    agentModel: restartModel,
  });
  if (patchedModel) {
    effectiveStartTask = patchedModel;
    effectiveStartAction =
      patchedModel.actions.find((a) => a.id === startAction.id) ?? startAction;
    publish(fresh.id, { kind: "task", task: patchedModel });
    publish(fresh.id, { kind: "action", action: effectiveStartAction });
  }

  // V0.8.12 A：重启 plan append 同样要硬约束出新批次（基于 patch 后最新 task / action 口径）
  const replanDirective = buildPlanReplanDirective(
    effectiveStartAction,
    effectiveStartTask,
  );

  await internalStartAgent({
    task: effectiveStartTask,
    action: effectiveStartAction,
    userInstruction: buildRestartActionInstruction(
      effectiveStartTask,
      effectiveStartAction,
      pendingQuestions,
    ),
    branchCheckoutHint,
    apiKey: input.apiKey,
    model: restartModel,
    gitHost: input.gitHost,
    gitToken: input.gitToken,
    batchDirective,
    replanDirective,
  });

  return { action: effectiveStartAction };
};

/**
 * V0.6 ack：approve / revise 当前 action
 *
 * - approve：write [ACTION_ACK approve] → agent 接着调 wait_for_user(待命态) 等下一 action
 *   后端 patch action.status=awaiting_ack（之前是 running）→ completed（approve 时）
 * - revise：先 snapshotActionArtifact 旧版本、再 write [ACTION_ACK revise] + feedback
 *   action.status 保持 running（agent 接着改）
 */
export const acknowledgeAction = async (
  taskId: string,
  actionId: string,
  decision: "approve" | "revise",
  feedback?: string,
  imagePaths?: string[],
): Promise<void> => {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error("task 不存在、无法 ack action");
  }
  const action = task.actions.find((a) => a.id === actionId);
  if (!action) {
    throw new Error(`action ${actionId} 不存在`);
  }
  // P0-1：只有「agent 正在等 ack」（awaiting_ack）的 action 才能 ack。
  //   running（ask_user 进行中 / revise 后还在改）/ completed / cancelled 一律拒——
  //   配合 chat-mcp submitActionAck 的 pending.actionId 绑定校验、双层堵住「ack 错对象」。
  if (action.status !== "awaiting_ack") {
    throw new Error(
      `action ${actionId} 当前状态 ${action.status}、不是在等 ack（awaiting_ack）、无法 ack`,
    );
  }

  if (decision === "revise" && action.artifactPath) {
    await snapshotActionArtifact(taskId, actionId).catch((err) => {
      console.warn(
        `[task-runner] snapshotActionArtifact 失败 task=${taskId} action=${actionId}（吞错继续）：`,
        err,
      );
    });
  }

  const res = submitActionAck(taskId, actionId, decision, feedback, imagePaths);
  if (!res.ok) {
    throw new Error(
      `${res.reason}（agent 可能已推进 / 已退出、刷新后重试、或点「推进」起新 agent）`,
    );
  }

  // V0.6：approve 时 action 标 completed；revise 时 agent 已重新开跑，同步把 task.runStatus 拉回 running。
  // 之前只把 action 改回 running、task 仍停在 awaiting_user，会出现「当前 action=running 但顶部显示推进」的僵尸组合。
  const patched = await patchAction(taskId, actionId, {
    status: decision === "approve" ? "completed" : "running",
  });
  if (patched) {
    publish(taskId, { kind: "task", task: patched });
    const newAction = patched.actions.find((a) => a.id === actionId);
    if (newAction) publish(taskId, { kind: "action", action: newAction });
  }
  if (decision === "revise") {
    const running = await setTaskRunStatus(taskId, "running", actionId);
    if (running) publish(taskId, { kind: "task", task: running });
  }
  await writeEventAndPublish(taskId, {
    kind: "action_ack",
    actionId,
    text:
      decision === "approve"
        ? `Action ${action.type} n=${action.n} 已通过`
        : `Action ${action.type} n=${action.n} 用户要求改：${truncate(feedback ?? "", 200)}`,
    meta: { decision, feedback: feedback ? truncate(feedback, 500) : undefined },
  });
};

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

  // 让 agent 拿到终态信号、自然退出 Run
  const kind = finalStatus === "merged" ? "done" : "abandoned";
  const ok = submitTaskTerminate(taskId, kind, reason);
  if (!ok) {
    // 信号发不出去 = agent 不在 wait 挂起。两种情况：
    //   a) agent 已退出 → runningTasks 无 entry、什么都不用做
    //   b) agent 正在跑（如 build 中途）→ 不硬停的话它会继续改代码、之后挂在
    //      wait_for_user 上没人再发终态信号、长挂到超时——而 task 在 UI 已显示终态。
    //      finalize 语义就是「关掉这个 task」、直接 cancel 掉 SDK Run。
    const hadLiveRun = cancelTaskRun(taskId);
    console.log(
      `[task-runner] finalizeTask: task=${taskId} 没活 pending、${
        hadLiveRun ? "硬停了运行中的 agent" : "agent 已退出"
      }、patch repoStatus=${finalStatus}`,
    );
  }

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
  // V0.6.1 ship action 用：注册 task-scoped action handler 时闭包
  gitHost?: string;
  gitToken?: string;
  // V0.6.23：build 分批指令（仅 build 有值、拼进首个 NEXT_ACTION）
  batchDirective?: string;
  // V0.8.12 A：plan append 硬指令（仅 plan append 有值、透传给 buildSuperPrompt 的首个 NEXT_ACTION）
  replanDirective?: string;
}

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
    gitHost,
    gitToken,
    batchDirective,
    replanDirective,
  } = input;

  // 已有活 entry 时不重启（advanceTask 入口已处理 forceNewAgent 时的 cancel）
  if (runningTasks.has(task.id)) {
    console.warn(
      `[task-runner] internalStartAgent: task=${task.id} 已有 running entry、跳过（幂等）`,
    );
    return;
  }

  // 1) merge MCP：全局 cursor mcp（按 task 黑名单过滤）+ chat-tool（我们的 wait_for_user / ask_user）
  //    全局 ~/.cursor/mcp.json 由 fe 读（settingSources["project"] 够不着 user 层）、
  //    per-task 用 task.disabledMcpServers 精简、详见 cursor-config.ts
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
    [TASK_TOOL_MCP_NAME]: {
      type: "http",
      url: getChatMcpUrl(),
    },
  };
  const cursorMcpNames = Object.keys(cursorMcp).filter(
    (n) => n !== TASK_TOOL_MCP_NAME,
  );
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

  // 2) 注册 task-scoped action handler（V0.6.1 submit_mr / set_feishu_testers）
  // 闭包里持 gitHost / gitToken 快照——task 运行期间不可变、要换 token 需 force-new-agent
  // 具名化：finally 注销走 conditional unset（只清自己这个实例、防 force-new-agent race 误清新 handler）
  const taskActionHandler: ChatTaskActionHandler = async (taskAction) => {
    if (taskAction.kind === "submit_mr") {
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
      const valid = await validateSubmitMr(fresh, taskAction);
      if (!valid.ok) {
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: taskAction.actionId,
          text: `提测被拦截（${taskAction.repoPath}）：${valid.error}`,
          meta: {
            repoPath: taskAction.repoPath,
            projectPath: taskAction.projectPath,
          },
        });
        return { ok: false, error: valid.error };
      }

      // V0.x：submit_mr 共用 ship / dev / custom（dev = 联调提 PR→dev 分支、custom = 自定义 action、target 由 playbook 决定）、下面按 action 类型分流。
      const submitAction = fresh.actions.find((x) => x.id === taskAction.actionId);
      const isDevSubmit = submitAction?.type === "dev";
      // custom（任意自定义 action）提的 MR 跟 dev 一样源 feature 绝不删（MR 还没合、feature 还要继续用）
      const isCustomSubmit = submitAction?.type === "custom";

      // V0.6.8：AI 智能解冲突会换 source 分支（feature → feature__conflict）、
      // 先读出该仓「上一次同目标分支 MR 的 source 分支」、待新 MR 建好后把旧 MR 关掉（防双 MR 垃圾）。
      // V0.x：按 (repoPath, 目标分支) 找——提测 MR（→test）和联调 MR（→dev）各找各的、互不误关。
      const prevMrBranch = fresh.mrs?.find(
        (m) =>
          m.repoPath === taskAction.repoPath &&
          mrTargetBranchOf(m, fresh.repoTestBranches) === taskAction.targetBranch,
      )?.branch;

      // V0.6.14：合并后是否删源分支——读 task 配置（缺省保留、用户拍板）。
      // - `<feature>__conflict` 一次性解冲突分支：必删（不留垃圾、不受开关影响）。
      // - dev（联调）/ custom（任意自定义 action 提的 MR）：feature 源分支绝不删（合入后还要继续开发 / 提测、删了就没分支了）。
      // - ship（提测）：按 task 配置 removeSourceBranchOnMerge（缺省保留）。
      const isConflictBranch = taskAction.sourceBranch.endsWith("__conflict");
      const removeSourceBranch = isConflictBranch
        ? true
        : isDevSubmit || isCustomSubmit
          ? false
          : (fresh.removeSourceBranchOnMerge ?? false);

      const result = await createMR({
        config: { host: gitHost, token: gitToken },
        projectPath: taskAction.projectPath,
        sourceBranch: taskAction.sourceBranch,
        targetBranch: taskAction.targetBranch,
        title: taskAction.title,
        description: taskAction.description,
        removeSourceBranch,
      });
      if (!result.ok) {
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: taskAction.actionId,
          text: `提 MR 失败（${taskAction.repoPath}）：${result.error}`,
          meta: { repoPath: taskAction.repoPath, projectPath: taskAction.projectPath },
        });
        return { ok: false, error: result.error };
      }

      // 新 MR 建好后、若 source 分支跟上一次不同（= 走了 __conflict 智能解冲突流程）、
      // 把被取代的旧 `<旧分支>→test` MR 关掉。失败只记日志、不阻塞 ship（新 MR 已建好、旧的留着也只是脏）。
      if (prevMrBranch && prevMrBranch !== taskAction.sourceBranch) {
        const closed = await closeOpenMR({
          config: { host: gitHost, token: gitToken },
          projectPath: taskAction.projectPath,
          sourceBranch: prevMrBranch,
          targetBranch: taskAction.targetBranch,
        });
        if (!closed.ok) {
          console.warn(
            `[task-runner] 关旧 MR 失败（${taskAction.projectPath} ${prevMrBranch}→${taskAction.targetBranch}）：${closed.error}`,
          );
        } else if (closed.closed) {
          await writeEventAndPublish(task.id, {
            kind: "info",
            actionId: taskAction.actionId,
            text: `已关闭被取代的旧 MR（${prevMrBranch} → ${taskAction.targetBranch}、冲突废弃）`,
            meta: { repoPath: taskAction.repoPath, projectPath: taskAction.projectPath },
          });
        }
      }

      // V0.6.1.1：MR 建好后 poll GitLab 可合性、检测 feature↔test 冲突
      // GitLab 建 MR 不管有没有冲突都返回成功、冲突要单独查 detailed_merge_status；
      // 且 GitLab 异步算 mergeability、刚建完可能还在 checking、getMRMergeStatus 内部 poll 到稳定
      const mergeStatus = await getMRMergeStatus({
        config: { host: gitHost, token: gitToken },
        projectPath: taskAction.projectPath,
        iid: result.iid,
      });
      // poll 失败 / 超时未定时、保守按「无冲突」处理（不误拦 ship、detailed 记 unknown 供审计）
      const hasConflicts = mergeStatus.ok ? mergeStatus.hasConflicts : false;
      const detailedStatus = mergeStatus.ok ? mergeStatus.detailedStatus : "unknown";
      const mergeUndetermined = mergeStatus.ok ? mergeStatus.undetermined : true;

      // upsert task.mrs[]（按 repoPath+目标分支、同仓同目标多次提交累计 version++）
      const upserted = await upsertMR(task.id, taskAction.repoPath, {
        targetBranch: taskAction.targetBranch,
        url: result.url,
        title: taskAction.title,
        branch: taskAction.sourceBranch,
        status: "open",
        createdByActionId: taskAction.actionId,
        lastCommitHash: taskAction.lastCommitHash,
        hasConflicts,
        mergeStatus: detailedStatus,
      });
      const mrVersion = upserted?.mr.version ?? 1;
      if (upserted) {
        publish(task.id, { kind: "task", task: upserted.task });
      }

      // 把本次 MR 原子追加到 action.sideEffects.mrs[]（多仓 task 一次 ship 可能落 N 条）
      // 走 task-fs 原子函数（withTaskLock 包 read-modify-write）、不在这里 getTask→patchAction 两段非原子
      const patched = await appendActionSideEffectMR(task.id, taskAction.actionId, {
        repoPath: taskAction.repoPath,
        targetBranch: taskAction.targetBranch,
        mrUrl: result.url,
        mrVersion,
        branch: taskAction.sourceBranch,
        commitHash: taskAction.lastCommitHash,
        hasConflicts,
      });
      if (patched) {
        publish(task.id, { kind: "task", task: patched });
        const a = patched.actions.find((x) => x.id === taskAction.actionId);
        if (a) publish(task.id, { kind: "action", action: a });
      }

      // 有冲突走 error 事件（红、醒目）、无冲突走 info——用户在事件流一眼看到「这条 MR 合不了」
      const mrVerb = mrVersion > 1 ? `推送（v${mrVersion}）` : "创建";
      if (hasConflicts) {
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: taskAction.actionId,
          text: `MR 已${mrVerb}、但跟 ${taskAction.targetBranch} 有冲突、需用户手动解决后才能合：${result.url}`,
          meta: {
            repoPath: taskAction.repoPath,
            projectPath: taskAction.projectPath,
            mrUrl: result.url,
            mrIid: result.iid,
            mrVersion,
            mergeStatus: detailedStatus,
          },
        });
      } else {
        await writeEventAndPublish(task.id, {
          kind: "info",
          actionId: taskAction.actionId,
          text: `MR 已${mrVerb}：${result.url}`,
          meta: {
            repoPath: taskAction.repoPath,
            projectPath: taskAction.projectPath,
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

  // 3) 注册 awaiting notifier（chat-mcp → runner 的回调）
  // 具名化：同 taskActionHandler、finally 走 conditional unset 防 force-new-agent race 误清
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

    // awaiting_start：agent 完成一个 action 调 wait_for_user(action_id) → 后台跑 check + 切 awaiting_ack
    //                 或 agent 待命 wait_for_user(待命态、不带 action_id) → 只切 runStatus=awaiting_user
    if (signal.actionId) {
      // V0.8.18：后置 deterministic check（build 的 lint/typecheck 可达 120s）改后台异步跑——
      // 这样 notifier 立即返回、agent 的 wait_for_user 工具秒回引导、第一时间挂上 curl long-poll 等 ack
      // （以前同步 await check 会把工具调用阻塞到超时、agent 收到「wait_for_user 失败」乱来、线上踩过）。
      // check 跑完再由 runActionPostCheck 落 postCheck + 切 awaiting_ack + 发「产出完成」事件。
      runActionPostCheck(task.id, signal.actionId, signal.artifactPath);
    } else {
      // 待命态：agent ack 完、调 wait_for_user(空 action_id) 等下一 action 指令 → 切 awaiting_user。
      // 用 setTaskAwaitingIfIdle（锁内 compare-set）防 force-new 秒推 race：approve 后用户秒推下一 action、
      //   advanceTask 已把 runStatus 设 running 且新 action 在跑时、此处被取消的旧 agent 迟到的待命通知
      //   不能把 running 覆盖回 awaiting_user（否则新 action 在跑却显示「等待回复」、推进按钮误亮、僵尸组合）。
      const updated = await setTaskAwaitingIfIdle(task.id);
      if (updated) publish(task.id, { kind: "task", task: updated });
    }
  };
  setChatAwaitingNotifier(task.id, awaitingNotifier);

  // 4) 启动 Agent + 消息循环（在独立 Promise 里跑、advanceTask 立即返回）
  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  let cancelled = false;
  // V0.6.8：标记本次结束是「换新 agent」（force-new-agent）——是的话 finally 不清孤儿进程、
  // 否则会误杀新 agent 刚在同仓拉起的 shell（带同样签名、cwd 也在 repoPaths）
  let isForkRestart = false;
  let hardTimer: NodeJS.Timeout | null = null;

  // fire-and-forget：advanceTask 立即返回、外部 waitForTaskToStop 靠 poll runningTasks.has 收敛、不依赖此 promise
  void (async () => {
    try {
      // V0.6.3：起 agent 前给业务仓库装 stop hook（保证 agent 交卷后才放行结束 Run、失败不阻断启动）
      const effectiveCwd = getEffectiveCwd(task.repoPaths);
      await ensureStopHookInstalled(effectiveCwd);

      agent = await Agent.create({
        apiKey,
        model,
        // settingSources:["project"] = 加载目标仓库 + 全局 .cursor/ 的 rules/skills/mcp/hooks
        //（跟 Cursor IDE 一致、配置双向绑定）；inline mcpServers 仍叠加生效、
        // chat-tool 安全（同名 inline 优先、不同名共存、已探针实测、见 ROADMAP）
        local: { cwd: effectiveCwd, settingSources: ["project"] },
        mcpServers: mergedMcp,
      });
      console.log(
        `[task-runner] task=${task.id} Agent.create OK agentId=${agent.agentId}`,
      );

      // 加载平台自带 skills（repo + 全局 skills 由 settingSources 交给 SDK 加载、不在此读、避免重复进 prompt）
      const skills = await loadSkills().catch((err) => {
        console.error("[task-runner] loadSkills failed", err);
        return [] as SkillEntry[];
      });
      const superPrompt = await buildSuperPrompt(task, skills, {
        action,
        userInstruction,
        attachedImagePaths,
        attachedFilePaths,
        branchCheckoutHint,
        batchDirective,
        replanDirective,
      });

      const run = await agent.send(superPrompt);

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

      for await (const msg of run.stream()) {
        await handleSdkMessage(task.id, msg, assistantCtx);
      }
      await assistantCtx.flush();

      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }

      const result = await run.wait();

      if (cancelled || result.status === "cancelled") {
        const isForkPending = forkPendingTasks.has(task.id);
        if (isForkPending) {
          forkPendingTasks.delete(task.id);
          isForkRestart = true; // 换新 agent：finally 不清孤儿（新 agent 同仓 shell 会被误杀）
          await writeEventAndPublish(task.id, {
            kind: "info",
            text: "旧 agent 已收尾、正在为推进起新 agent...",
          });
          return;
        }
        // 正常 cancel（stop / 硬超时触发）→ 收尾卡住的 action + 关运行时状态
        // （repoStatus 仍由 finalizeTask 管、这里只补 action 收尾、不动业务态）
        await finalizeStaleActions(task.id, "cancelled");
        // 保留 currentActionId（不传第三参）：被停的 action 此刻已被 finalizeStaleActions 标 cancelled、
        // 让它仍是「当前 action」、前端 canRestartCurrentAction 命中 cancelled → 用户能「重启当前阶段」、
        // 不必只能推新 action（修：手动停止后重启按钮消失——之前这里传 null 把 currentActionId 清了）。
        const updated = await setTaskRunStatus(task.id, "idle");
        if (updated) publish(task.id, { kind: "task", task: updated });
        publish(task.id, { kind: "done", task: updated ?? task, ok: true });
        return;
      }

      if (result.status !== "finished") {
        const resultDump = stringifyMeta(result).slice(0, 1500);
        const sdkErr = assistantCtx.sdkErrorMessage
          ? `\n--- SDK stream error message ---\n${assistantCtx.sdkErrorMessage}`
          : "";
        // result.result 是 SDK 给的最终文本/诊断（mirror chat-runner）：非空就 inline 到 status 后、
        // 这样 summarizeRunFailure 的「裸 error」正则自然不命中、诊断不会被当连接断吞掉
        const inlineResult =
          typeof result.result === "string" && result.result.trim()
            ? `: ${result.result.slice(0, 200)}`
            : "";
        throw new Error(
          `agent run status=${result.status}${inlineResult}${sdkErr}\n--- SDK result dump ---\n${resultDump}`,
        );
      }

      // SDK run 自然 finished：在 V0.6 单 Run 永生模型下、这意味着 agent 主动 exit
      // 检查最后一个 action 是否 ack——没 ack 就标 error
      const fresh = await getTask(task.id);
      const lastAction = fresh?.actions[fresh.actions.length - 1];
      if (
        lastAction &&
        (lastAction.status === "running" || lastAction.status === "awaiting_ack")
      ) {
        await patchAction(task.id, lastAction.id, { status: "error" });
        await setTaskRunStatus(task.id, "error", lastAction.id);
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: lastAction.id,
          text: [
            `agent 在 action ${lastAction.type} n=${lastAction.n} 没 ack 就自然结束 Run、这通常是协议理解错误`,
            "",
            "下一步：点顶部「推进」选「换新 agent」、或换更稳的模型（claude-opus-4 / claude-sonnet-4）",
          ].join("\n"),
        });
        const updated = await getTask(task.id);
        if (updated) publish(task.id, { kind: "task", task: updated });
        publish(task.id, { kind: "done", task: updated ?? task, ok: false });
      } else {
        // 干净结束：last action 已 completed、agent 自愿退出（极少见、正常应等终态信号）
        const updated = await setTaskRunStatus(task.id, "idle", null);
        if (updated) publish(task.id, { kind: "task", task: updated });
        publish(task.id, { kind: "done", task: updated ?? task, ok: true });
      }
    } catch (err) {
      if (hardTimer) clearTimeout(hardTimer);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[task-runner] task=${task.id} failed:`, err);

      // 归一成给用户看的文案：长连接被断（最常见）→ 友好一句话、不加吓人前缀；
      // 其它有诊断的错（认证 / 限流 / MCP / 协议）→ 带详情、加「失败」前缀。原始 err 已 console.error。
      const failure = summarizeRunFailure(message, err);
      const eventText = failure.isConnectionDrop
        ? failure.text
        : `Task agent 失败：${failure.text}`;

      // 收尾所有卡在非终态的 action（单 Run 多 action：卡住的可能 ≠ 闭包起的 action、见 finalizeStaleActions）
      await finalizeStaleActions(task.id, "error");
      await setTaskRunStatus(task.id, "error", action.id);
      await writeEventAndPublish(task.id, {
        kind: "error",
        actionId: action.id,
        text: eventText,
        // 原始诊断落 meta（UI 不展示、事后从 events.jsonl 定位额度 vs 连接断）
        meta: { detail: failure.detail },
      });
      const errored = await getTask(task.id);
      publish(task.id, { kind: "done", task: errored ?? task, ok: false });
      publish(task.id, { kind: "error", message: eventText });
    } finally {
      runningTasks.delete(task.id);
      cancelPending(task.id);
      // conditional unset：只清「自己注册的那个实例」、force-new-agent race 下新 handler/notifier 不被误清
      unsetChatAwaitingNotifierIf(task.id, awaitingNotifier);
      unsetChatTaskActionHandlerIf(task.id, taskActionHandler);
      // V0.6.8：真正结束（停止 / 自然退出 / 报错）才清孤儿进程；换新 agent 不清（见 isForkRestart 注释）
      if (!isForkRestart) reapTaskOrphans(task.repoPaths);
      if (agent) {
        try {
          agent.close();
        } catch {
          /* noop */
        }
      }
    }
  })();
};
