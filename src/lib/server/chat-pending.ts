/**
 * Agent ↔ server 信号桥 + ask 弹窗登记（V0.11 大幅瘦身）
 *
 * V0.11 背景：wait 协议退役（「单 Run 永生 + shell curl 长轮询」→「create + 多轮 send」）。
 * 原来这里是 submit_work / ask_user 的完整等待状态机（pendingMap / token / grace /
 * keepalive / submitXxx 信号 API、~1000 行）；新模型下 agent 说完自然结束 run、用户操作
 * 经 `agent.send()` 以新消息送达、不再有「阻塞等待」可 resolve。本文件只剩三块：
 *
 *   1. **pendingAsks**：ask_user 弹窗登记表（taskId → 当前未答的一组问题 + token）——
 *      ask-reply 路由校验「答案对应的还是当前这组问题」用（防旧弹窗答案串新提问）
 *   2. **notifier / task action handler 注册表**：runner ↔ flowship-tools 的回调桥
 *      （task-runner 注册、flowship-tools 调、本文件不反向 import runner）
 *   3. **buildAgentMessage**：用户操作 → 发给 agent 的消息文本（[NEXT_ACTION] / [USER_MESSAGE]
 *      revise] / [USER_REPLY] 头 + 附件段）——原 formatToolReturnAsText 的瘦身版、信号
 *      字面量与 prompts 的约定由 tests/protocol-signals.test.ts 守护
 *
 * 依赖方向（保证无环）：只依赖 types / protocol-signals、不 import flowship-tools / task-runner。
 */

import type { ActionType, PlanBatch } from "../types";
import { SIGNALS, buildNextActionHead } from "../protocol-signals";
import { cancelAskWait, resetAskWaitForTest } from "./ask-wait";

// ----------------- 类型 -----------------

export type AskUserOption = { id: string; label: string };
export type AskUserQuestion = {
  id: string;
  question: string;
  options?: AskUserOption[];
  allowText: boolean;
};

// ask_user 弹窗登记：一个 task 同时最多一组未答问题（新提问顶旧的、旧弹窗答案按 token 拒）
export interface PendingAsk {
  askId: string;
  // 短 token：ask_user_request 事件 meta 里带给前端、答题时带回校验（防旧弹窗答案串新提问）
  token: string;
  questions: AskUserQuestion[];
  actionId?: string;
  createdAt: number;
}

export type AwaitingSignal =
  | {
      // agent 调 submit_work 交卷（V0.11 起非阻塞）：runner 据此跑后置 check + 切 awaiting_ack；
      // 不带 actionId 的调用（旧「待命态」姿势）只切 runStatus=awaiting_user
      kind: "awaiting_start";
      actionId?: string;
      artifactPath?: string;
    }
  | {
      // agent 调 ask_user：runner 写 ask_user_request 事件；同一轮 curl 还在挂，不切 awaiting_user
      kind: "ask_user_request";
      askId: string;
      token: string;
      questions: AskUserQuestion[];
      actionId?: string;
    };

/** handler / notifier 内部 await 后复查 caller 是否仍是当前 bridge */
export type CallerValidityCtx = { callerStillValid: () => boolean };

/**
 * notifier 结构化结果——区分真受理 / scope 失效 / 副作用忙。
 * - accepted：已启动 post-check / 已切 awaiting / ask 已落盘
 * - stale：非当前 running action / caller 失效等，工具不得报「已交卷」
 * - busy：waitAndClaimPostCheck 超时等，工具返回重试文案
 */
export type AwaitingNotifyOutcome = "accepted" | "stale" | "busy";

export type AwaitingNotifier = (
  signal: AwaitingSignal,
  ctx: CallerValidityCtx,
) =>
  | Promise<AwaitingNotifyOutcome>
  | AwaitingNotifyOutcome;

// task-scoped「同步 RPC」action（submit_mr / set_feishu_testers / set_plan_batches）——
// 系统工具收到调用后查表找 runner 注册的 handler 执行、拿结构化返回值
export type ChatTaskAction =
  | {
      kind: "submit_mr";
      actionId: string;
      /** 本地仓库绝对路径、agent 从 shell `pwd` 取（用于 server 端 sideEffects 落档时区分仓） */
      repoPath: string;
      /** GitLab project path（如 `wkid/crm-web`、从 remote.origin.url 解析） */
      projectPath: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      lastCommitHash: string;
    }
  | {
      kind: "set_feishu_testers";
      /** 当前 ship action 的 id（让「已记忆测试人员」info 事件挂到该 action、跟 submit_mr 对齐） */
      actionId: string;
      /** 飞书项目 user_key 列表（空数组 = 显式记忆「没测试人 / 跳过 @」） */
      userKeys: string[];
    }
  | {
      kind: "set_plan_batches";
      /** 当前 plan action 的 id（批次落到这个 action 的 planBatches 字段） */
      actionId: string;
      /** plan 拆出的批次清单（数组顺序 = 建议 build 顺序） */
      batches: PlanBatch[];
    };

export type ChatTaskActionResult =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; error: string };

export type ChatTaskActionHandler = (
  action: ChatTaskAction,
  ctx: CallerValidityCtx,
) => Promise<ChatTaskActionResult>;

// ----------------- 进程全局状态（挂 globalThis） -----------------
//
// Next.js dev 下不同 Route Handler 是不同 webpack chunk、module-level Map 各持一份
// 完全分裂（V0.3.3 实测踩过）——所有进程级状态挂 globalThis、所有 chunk 共享同一份。

interface ChatMcpGlobalState {
  // taskId → 当前未答的一组 ask_user 问题（新提问顶旧的）
  pendingAsks: Map<string, PendingAsk>;
  /**
   * taskId → 最近被**本进程**摘走 / 清掉的那组 ask。
   *
   * 单独记一笔的原因：登记没了有两种截然不同的含义——「答题链刚摘走、正在投递」
   * vs「进程重启后登记丢了、事件还挂着（孤儿）」。前者绝不能再被标成「用户跳过」
   * （否则 agent 同时收到答案和「上一组问题跳过了」两条矛盾指令），后者必须能跳过
   * （否则答题卡永远挂在事件流里）。这张表是内存态，重启后自然为空 = 天然区分。
   */
  takenAsks: Map<string, { askId: string; at: number }>;
  awaitingNotifiers: Map<string, AwaitingNotifier>;
  taskActionHandlers: Map<string, ChatTaskActionHandler>;
  /**
   * taskId → 当前注册 bridge 期望的 caller token（agent 实例身份）。
   * 系统工具执行前核对请求携带的 caller；不匹配则拒副作用。
   */
  expectedCallerTokens: Map<string, string>;
}

// V16：2026-08-28——HTTP chat-mcp 退役，去掉 sessionTransports。
// V15：2026-07-28——加 takenAsks（区分「答题链摘走」与「重启后孤儿」）。
// V14：2026-07-18——加 expectedCallerTokens（MCP caller 身份）。
// V13：2026-07-07 V0.11 wait 协议退役——删 pendingMap / tokenToTask / waitingTasks /
//      pendingNextActions / unansweredRevises / chatModeTasks / prematureWaitRejects、
//      新增 pendingAsks（ask 弹窗登记）。bump 强制 dev hot reload 拿全新 state。
// V12 及更早见 git 历史（wait 协议时代的状态机字段）。
const GLOBAL_KEY = "__flowshipChatStateV16__";

const getGlobalState = (): ChatMcpGlobalState => {
  const g = globalThis as unknown as Record<string, ChatMcpGlobalState>;
  if (!g[GLOBAL_KEY]) {
    console.log("[chat-pending] 初始化 globalThis 状态（首次）");
    g[GLOBAL_KEY] = {
      pendingAsks: new Map(),
      takenAsks: new Map(),
      awaitingNotifiers: new Map(),
      taskActionHandlers: new Map(),
      expectedCallerTokens: new Map(),
    };
  }
  return g[GLOBAL_KEY];
};

const pendingAsks = getGlobalState().pendingAsks;
const takenAsks = getGlobalState().takenAsks;
const awaitingNotifiers = getGlobalState().awaitingNotifiers;
const taskActionHandlers = getGlobalState().taskActionHandlers;
const expectedCallerTokens = getGlobalState().expectedCallerTokens;

// ----------------- pendingAsks（ask 弹窗登记） -----------------

// 短 token：8 字符 base36、够防撞、不浪费 context（模型只透传、不需要 crypto 强度）
const newAskToken = (): string => Math.random().toString(36).slice(2, 10);

/**
 * 内存 Map 变更后异步收敛到 meta.pendingAskId。
 * 动态 import task-fs：避免本文件与 runner/route 图在静态边形成环。
 * 按 taskId 串最新 Promise——测试可 await whenPendingAskMetaSynced。
 */
const pendingAskMetaSyncByTask = new Map<string, Promise<void>>();

const schedulePendingAskMetaSync = (taskId: string): void => {
  const run = async (): Promise<void> => {
    const { syncTaskPendingAskId } = await import("./task-fs");
    await syncTaskPendingAskId(
      taskId,
      () => pendingAsks.get(taskId)?.askId ?? null,
    );
  };
  const next = (pendingAskMetaSyncByTask.get(taskId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(run);
  pendingAskMetaSyncByTask.set(taskId, next);
  void next.finally(() => {
    if (pendingAskMetaSyncByTask.get(taskId) === next) {
      pendingAskMetaSyncByTask.delete(taskId);
    }
  });
};

/** 等指定 task 的 pendingAskId meta 同步落盘（测试 / 需要强一致读盘时用） */
export const whenPendingAskMetaSynced = (taskId: string): Promise<void> =>
  pendingAskMetaSyncByTask.get(taskId) ?? Promise.resolve();

// ----------------- takenAsks（「这组 ask 已经有人在了结」） -----------------

/**
 * 记录时长——只需覆盖「摘走 → 投递完成」这段在飞窗口。
 * 投递完了事件流里就有 reply / 作废标记，判定不再依赖本表。
 */
const TAKEN_ASK_TTL_MS = 10 * 60 * 1000;

/** 摘走 / 清掉一组登记时打点（谁摘的不重要，重要的是「本进程已经有人在了结它」） */
const markAskTaken = (taskId: string, askId: string | undefined): void => {
  if (!askId) return;
  takenAsks.set(taskId, { askId, at: Date.now() });
};

/**
 * 没有登记可摘时的占位打点（**孤儿 ask 专用**：进程重启后登记丢了、事件还挂着）。
 * 让并发的第二条消息看到「已经有人在了结它了」，不会各写一条跳过标记。
 */
export const markAskSettlingWithoutPending = (
  taskId: string,
  askId: string,
): void => markAskTaken(taskId, askId);

/**
 * 撤掉「这组 ask 已经有人在了结」的打点（**只撤自己那组**）。
 *
 * 跳过链的孤儿分支没有登记可放回（{@link markAskSettlingWithoutPending} 只是个占位），
 * 投递失败回滚 / 作废事件写不下去时若把占位挂着，接下来一整个 TTL 里用户每发一条消息
 * 都会被 {@link wasAskTakenRecently} 判成「已有人在了结」→ 谁都认领不上、答题卡一直挂着。
 * 语义对齐 {@link restorePendingAskIf}「又在等人答了就撤打点」。
 *
 * askId 必须匹配：期间可能已经有新一组提问登记过、迟到的撤销不许抹掉新那组的打点。
 */
export const clearAskTakenMark = (taskId: string, askId: string): void => {
  if (takenAsks.get(taskId)?.askId === askId) takenAsks.delete(taskId);
};

/**
 * 这组 ask 是不是刚被本进程摘走（答题链在飞 / 已了结）。
 *
 * 两条链在「登记为空」时都要靠它判断该不该按事件收口——true = 有人正在了结、放手；
 * false = 真孤儿（重启后表本来就空）、才可以自己收口：
 * - 跳过链的孤儿分支（`ask-skip`）：false 才写作废标记
 * - 答题链的僵尸唤醒分支（`ask-reply` 路由）：false 才唤醒新 agent 把答案带过去
 */
export const wasAskTakenRecently = (taskId: string, askId: string): boolean => {
  const rec = takenAsks.get(taskId);
  if (!rec || rec.askId !== askId) return false;
  if (Date.now() - rec.at > TAKEN_ASK_TTL_MS) {
    takenAsks.delete(taskId);
    return false;
  }
  return true;
};

/** 单测重置：两张表都是进程级、跨用例会串（尤其 takenAsks 会让孤儿判定失真） */
export const __resetPendingAskStateForTest = (): void => {
  pendingAsks.clear();
  takenAsks.clear();
  resetAskWaitForTest();
};

/** ask_user 工具 handler 调：登记一组新提问（顶掉旧的、旧弹窗答案会因 token 不符被拒） */
export const registerPendingAsk = (
  taskId: string,
  opts: { askId: string; questions: AskUserQuestion[]; actionId?: string },
): PendingAsk => {
  const prev = pendingAsks.get(taskId);
  if (prev) cancelAskWait(taskId, "superseded", prev.askId);
  const ask: PendingAsk = {
    askId: opts.askId,
    token: newAskToken(),
    questions: opts.questions,
    actionId: opts.actionId,
    createdAt: Date.now(),
  };
  pendingAsks.set(taskId, ask);
  // 新一组提问 = 干净起点：上一组的「已被摘走」打点作废
  takenAsks.delete(taskId);
  // 落盘 meta.pendingAskId——侧栏 / 重启后列表靠这个判「真有题」
  schedulePendingAskMetaSync(taskId);
  return ask;
};

/** 当前未答的一组 ask（没有返 null）——ask-reply 路由校验 / UI 状态判断用 */
export const getPendingAsk = (taskId: string): PendingAsk | null =>
  pendingAsks.get(taskId) ?? null;

/** 答完 / 作废时清登记 */
export const clearPendingAsk = (taskId: string): void => {
  markAskTaken(taskId, pendingAsks.get(taskId)?.askId);
  cancelAskWait(taskId, "cleared", pendingAsks.get(taskId)?.askId);
  pendingAsks.delete(taskId);
  schedulePendingAskMetaSync(taskId);
};

/**
 * 同步取走当前 pending（「先摘再投」）——投递链路的入口专用。
 *
 * 投递有长 await（存图 / deliver），`get → deliver → clear` 中间的窗口会让两条
 * **互相独立**的串行链（卡片回调链 enqueueCardAction / 入向消息链 enqueueInboundMessage）
 * 把同一组问题各投一份 `[ASK_USER_REPLY]` 给 agent（V0.13 群协作 review P2-2）。
 * 入口同步摘走 = 后到的那条直接看到「无 pending」、走既有的失效分支。
 * 投递失败要放回的话用 {@link restorePendingAskIf}。
 */
export const takePendingAsk = (taskId: string): PendingAsk | null => {
  const cur = pendingAsks.get(taskId);
  if (!cur) return null;
  pendingAsks.delete(taskId);
  markAskTaken(taskId, cur.askId);
  schedulePendingAskMetaSync(taskId);
  return cur;
};

/**
 * 按身份原子摘走（**了结这组 ask 的唯一认领口**）。
 *
 * 「答」和「跳过」是同一件事的两个出口——谁先摘到这组登记谁说了算，摘不到的那条
 * 必须彻底放手（不投递、不写事件、不置卡片）。三条链都走它：
 * app 答题（ask-reply 路由）、飞书答题（{@link takePendingAsk} 的无条件版，入口只有一组）、
 * 用户跳过（`ask-skip`）。
 *
 * 判据用 askId + 事件里带回的 token：askId 相同但 token 不同 = 这组已经被新提问顶替过
 *（force-new-agent / 顶替 race），旧界面上的动作不许作用到新提问上。
 *
 * @returns 摘到的那组；null = 不是当前这组 / 没有登记（调用方按「已被别人了结」处理）
 */
export const takePendingAskIf = (
  taskId: string,
  expectedAskId: string,
  expectedToken?: string,
): PendingAsk | null => {
  const cur = pendingAsks.get(taskId);
  if (!cur || cur.askId !== expectedAskId) return null;
  if (expectedToken && cur.token !== expectedToken) return null;
  pendingAsks.delete(taskId);
  markAskTaken(taskId, cur.askId);
  schedulePendingAskMetaSync(taskId);
  return cur;
};

/**
 * 条件放回（投递失败时用）：只有槽位还空着才放回自己摘走的那组。
 * 摘走之后 agent 可能已经登记了新提问——绝不能拿旧的盖掉新的
 *（同 cancelPendingIf 的「按身份条件操作、不裸写」口径）。
 * @returns true=放回了；false=槽位已被新提问占住（自己那组就此作废）
 */
export const restorePendingAskIf = (
  taskId: string,
  ask: PendingAsk,
): boolean => {
  if (pendingAsks.has(taskId)) return false;
  pendingAsks.set(taskId, ask);
  // 又在等人答了 → 撤掉「已被摘走」的打点，跳过 / 答题都该能重新认领。
  // 只撤**放回那组自己**的打点：迟到的 rollback 撞上「新一组 ask 已注册、又已被答题链
  // 摘走（槽位恰好空）」时会把旧那组放回，此时打点标的是新那组、还在飞——顺手删掉的话
  // 跳过链会把它当孤儿再收一次口（同 clearAskTakenMark 的按 askId 匹配口径）
  clearAskTakenMark(taskId, ask.askId);
  schedulePendingAskMetaSync(taskId);
  return true;
};

/**
 * 停止 / 重启 / 删除 task 时调：清掉未答的 ask 登记（无条件）。
 * 失主让位反登记请用 {@link cancelPendingIf}——裸删会误清 B 刚登记的新提问。
 * @returns 是否真的清了（调用方据此决定要不要写「已作废」事件）
 */
export const cancelPending = (taskId: string): boolean => {
  markAskTaken(taskId, pendingAsks.get(taskId)?.askId);
  cancelAskWait(taskId, "cancelled");
  const deleted = pendingAsks.delete(taskId);
  // 无论内存是否刚删：sync 收敛盘面（覆盖重启后「内存空、meta 仍有孤儿 askId」）
  schedulePendingAskMetaSync(taskId);
  return deleted;
};

/**
 * 按 askId 条件反登记——当前 pendingAsk 的 askId 匹配才删。
 * 线性化：同步比对 + delete、无 await；旧 A 失主后不得删掉 B 刚登记的新提问。
 * @returns true=删了自己的；false=不匹配 / 无 pending（不动）
 */
export const cancelPendingIf = (
  taskId: string,
  expectedAskId: string,
): boolean => {
  const cur = pendingAsks.get(taskId);
  if (!cur || cur.askId !== expectedAskId) return false;
  pendingAsks.delete(taskId);
  markAskTaken(taskId, cur.askId);
  cancelAskWait(taskId, "cancelled", expectedAskId);
  schedulePendingAskMetaSync(taskId);
  return true;
};

/**
 * 同步失效 MCP bridge lease（只删 expectedCallerTokens）。
 * stop 在首个 await 前调用——旧 agent 的 MCP 立即被 fail-closed 分派拒绝；
 * handler/notifier 表稍后由 cleanupChatTaskState 一并清。
 */
export const invalidateCallerToken = (taskId: string): void => {
  expectedCallerTokens.delete(taskId);
};

/**
 * 任务 stop / 清理进程级桥接态时调。
 * 不再清 seq counter——events.jsonl 仍在，counter 保持才单调；
 * 仅 deleteTask（文件真删）才 clearEventSeqCounter。
 */
export const cleanupChatTaskState = (taskId: string): void => {
  markAskTaken(taskId, pendingAsks.get(taskId)?.askId);
  pendingAsks.delete(taskId);
  awaitingNotifiers.delete(taskId);
  taskActionHandlers.delete(taskId);
  expectedCallerTokens.delete(taskId);
  // 始终 sync：stop 后不应再亮「待回答」；重启孤儿 askId 也一并清掉
  schedulePendingAskMetaSync(taskId);
};

/** MCP 拒文案（工具 handler / 分派层共用、测试断言也认这个字面量） */
export const CALLER_MISMATCH_ERROR = "任务已被新 agent 接管、本次调用忽略";

/**
 * 请求携带的 caller 是否匹配当前注册 bridge。
 * 无注册 / token 缺失 / 不匹配 → false（fail-closed）。
 */
export const matchExpectedCallerToken = (
  taskId: string,
  callerToken: string | undefined,
): boolean =>
  !!callerToken && expectedCallerTokens.get(taskId) === callerToken;

/** 读当前期望 token（测试 / 调试） */
export const getExpectedCallerToken = (taskId: string): string | null =>
  expectedCallerTokens.get(taskId) ?? null;

// ----------------- notifier / handler 注册表（runner ↔ flowship-tools 桥） -----------------

/**
 * 注册 awaiting notifier。
 * @param callerToken 与 handler 共用的 agent 实例身份；同一次 installSessionIfCurrent 必传
 */
export const setChatAwaitingNotifier = (
  taskId: string,
  notifier: AwaitingNotifier | null,
  callerToken?: string,
): void => {
  if (notifier) {
    awaitingNotifiers.set(taskId, notifier);
    if (callerToken !== undefined) {
      expectedCallerTokens.set(taskId, callerToken);
    }
  } else {
    awaitingNotifiers.delete(taskId);
    // handler 也已清 → 一并摘掉期望 token
    if (!taskActionHandlers.has(taskId)) expectedCallerTokens.delete(taskId);
  }
};

/**
 * 注册 task action handler。
 * @param callerToken 与 notifier 共用的 agent 实例身份
 */
export const setChatTaskActionHandler = (
  taskId: string,
  handler: ChatTaskActionHandler | null,
  callerToken?: string,
): void => {
  if (handler) {
    taskActionHandlers.set(taskId, handler);
    if (callerToken !== undefined) {
      expectedCallerTokens.set(taskId, callerToken);
    }
  } else {
    taskActionHandlers.delete(taskId);
    if (!awaitingNotifiers.has(taskId)) expectedCallerTokens.delete(taskId);
  }
};

/**
 * conditional unset：只在「当前注册的就是 expected 这个实例」时才注销（V0.6.1 race fix 沿用）。
 * 换新 agent 时旧会话迟到的清理不能误清新会话刚注册的 handler / notifier。
 */
export const unsetChatTaskActionHandlerIf = (
  taskId: string,
  expected: ChatTaskActionHandler,
): void => {
  if (taskActionHandlers.get(taskId) === expected) {
    taskActionHandlers.delete(taskId);
    if (!awaitingNotifiers.has(taskId)) expectedCallerTokens.delete(taskId);
  }
};

/** 同 unsetChatTaskActionHandlerIf、对 awaitingNotifier 做 conditional unset */
export const unsetChatAwaitingNotifierIf = (
  taskId: string,
  expected: AwaitingNotifier,
): void => {
  if (awaitingNotifiers.get(taskId) === expected) {
    awaitingNotifiers.delete(taskId);
    if (!taskActionHandlers.has(taskId)) expectedCallerTokens.delete(taskId);
  }
};

/**
 * 跑 task-scoped action handler、序列化结果给 MCP 工具返。
 * @param callerToken MCP session 的 caller；不匹配则拒、不进 handler（防 createMR 等副作用）
 */
export const runTaskAction = async (
  taskId: string,
  action: ChatTaskAction,
  callerToken?: string,
): Promise<ChatTaskActionResult> => {
  // 分派层先核对身份——旧 agent 迟到请求不得借用新 bridge 闭包
  if (!matchExpectedCallerToken(taskId, callerToken)) {
    return { ok: false, error: CALLER_MISMATCH_ERROR };
  }
  const handler = taskActionHandlers.get(taskId);
  if (!handler) {
    return {
      ok: false,
      error: `task=${taskId} 没注册 handler（task 没在跑 / 已结束、不应该调本工具）`,
    };
  }
  try {
    // 闭包贯穿 handler——每个外部 await 后、不可逆副作用前可复查
    const callerStillValid = (): boolean =>
      matchExpectedCallerToken(taskId, callerToken);
    return await handler(action, { callerStillValid });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `handler 抛错：${msg}` };
  }
};

/** submit_work 通知结果——工具层据此决定返回「已交卷」还是重试/失效文案 */
export type NotifyAwaitingResult =
  | { status: "delivered" }
  | { status: "accepted" }
  | { status: "stale" }
  | { status: "busy"; message: string }
  | { status: "mismatch" }
  | { status: "no_notifier" }
  | { status: "error"; message: string };

/** busy 默认重试文案（与 waitAndClaimPostCheck timeout / claim 互斥对齐） */
const BUSY_RETRY_MESSAGE =
  "MR 提交仍在进行、稍后重试 submit_work";

export const safeNotifyAwaiting = async (
  taskId: string,
  opts: { actionId?: string; artifactPath?: string; callerToken?: string } = {},
): Promise<NotifyAwaitingResult> => {
  // submit_work 路径同样先核对——不匹配静默跳过（不启 postCheck）
  if (!matchExpectedCallerToken(taskId, opts.callerToken)) {
    console.warn(
      `[chat-pending] safeNotifyAwaiting: caller 不匹配 task=${taskId}、忽略`,
    );
    return { status: "mismatch" };
  }
  const notifier = awaitingNotifiers.get(taskId);
  if (!notifier) {
    console.warn(
      `[chat-pending] safeNotifyAwaiting: 没找到 task=${taskId} 的 notifier（已注册 ${awaitingNotifiers.size} 个）`,
    );
    return { status: "no_notifier" };
  }
  try {
    // notifier 内部 await 后仍须能复查 caller
    const callerStillValid = (): boolean =>
      matchExpectedCallerToken(taskId, opts.callerToken);
    const outcome = await notifier(
      {
        kind: "awaiting_start",
        actionId: opts.actionId,
        artifactPath: opts.artifactPath,
      },
      { callerStillValid },
    );
    // 返回前复查 token——失效不能当 delivered
    if (!matchExpectedCallerToken(taskId, opts.callerToken)) {
      return { status: "mismatch" };
    }
    // 透传 notifier 结构化结果
    if (outcome === "stale") return { status: "stale" };
    if (outcome === "busy") {
      return { status: "busy", message: BUSY_RETRY_MESSAGE };
    }
    // accepted（及历史 void 不应再出现——两侧 notifier 已显式返回）
    return { status: "accepted" };
  } catch (err) {
    // 兜底：未预期抛错仍传回工具层，避免假「已交卷」
    console.error("[chat-pending] awaiting notifier failed:", err);
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * 通知 runner 落 ask_user_request。
 * 透传 notifier 的 accepted | stale | busy（不再 await 后无条件 true）。
 * mismatch / no_notifier / error 与 safeNotifyAwaiting 同形——工具层只有 accepted 才报 ASK_SUBMITTED。
 */
export const safeNotifyAskUserRequest = async (
  taskId: string,
  args: {
    askId: string;
    token: string;
    questions: AskUserQuestion[];
    actionId?: string;
    callerToken?: string;
  },
): Promise<NotifyAwaitingResult> => {
  // ask 通知同样核对（登记 pendingAsk 已在工具层先挡）
  if (!matchExpectedCallerToken(taskId, args.callerToken)) {
    console.warn(
      `[chat-pending] safeNotifyAskUserRequest: caller 不匹配 task=${taskId}、忽略`,
    );
    return { status: "mismatch" };
  }
  const notifier = awaitingNotifiers.get(taskId);
  if (!notifier) {
    console.warn(
      `[chat-pending] safeNotifyAskUserRequest: 没找到 task=${taskId} 的 notifier（已注册 ${awaitingNotifiers.size} 个）`,
    );
    return { status: "no_notifier" };
  }
  try {
    const callerStillValid = (): boolean =>
      matchExpectedCallerToken(taskId, args.callerToken);
    const outcome = await notifier(
      {
        kind: "ask_user_request",
        askId: args.askId,
        token: args.token,
        questions: args.questions,
        actionId: args.actionId,
      },
      { callerStillValid },
    );
    // 先透传 notifier 的 stale/busy（失主路径 notifier 已 cancelPendingIf）——
    // 不能用事后 token 复查盖成 mismatch，否则工具层分不清「受理后失主」与入口拒
    if (outcome === "stale") return { status: "stale" };
    if (outcome === "busy") {
      return { status: "busy", message: BUSY_RETRY_MESSAGE };
    }
    // accepted 路径：返回前复查 token——失效不能当 accepted
    if (!matchExpectedCallerToken(taskId, args.callerToken)) {
      return { status: "mismatch" };
    }
    return { status: "accepted" };
  } catch (err) {
    console.error("[chat-pending] ask_user_request notifier failed:", err);
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

// ----------------- buildAgentMessage：用户操作 → agent.send 的消息文本 -----------------

/**
 * 用户操作载荷（V0.11：原 wait 协议 ToolReturn 的瘦身版；
 * V0.13.x：action_revise 并入 user_message——「再聊聊 / 问一问」统一成一条消息语义、
 * AI 自主二分类；approve / 终态不需要通知 agent）
 */
export type AgentMessage = {
  // user_reply：chat 消息 / ask_user 答案（[ASK_USER_REPLY] Q&A 块由 route 拼好传入）
  // next_action：用户在 UI 推进新 action（续用会话时）
  // user_message：任务页输入条的任何消息（V0.13.x 统一语义）——AI 自主判断问 / 改
  kind: "user_reply" | "next_action" | "user_message";
  text: string;
  // 图片附件绝对路径（拼 [ATTACHED_IMAGES] 段、agent 用 read 工具看图）
  imagePaths?: string[];
  // 文件 / 目录附件绝对路径（拼 [ATTACHED_PATHS] 段）
  attachmentPaths?: string[];
  // user_message：当前有产出在等审阅时的上下文（服务端附加、要求处理完重新交卷）
  ackContext?: { actionId: string; artifactPath?: string };
  // next_action 的元数据（拼 [NEXT_ACTION ...] 头）
  nextActionId?: string;
  nextActionType?: ActionType;
  nextN?: number;
  nextArtifactPath?: string;
};

/** 附件段（图片 / 文件路径）——两个消息封装共用同一份，别各写一遍 */
const attachmentSections = (m: {
  imagePaths?: string[];
  attachmentPaths?: string[];
}): string[] => {
  const lines: string[] = [];
  if (m.imagePaths && m.imagePaths.length > 0) {
    lines.push(
      "",
      `${SIGNALS.ATTACHED_IMAGES} 用户附了以下图片、请用 \`read\` 工具逐一读取（SDK 内置 \`read\` 会把图片转成 vision、你能直接看到图像内容）：`,
      ...m.imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
    );
  }
  if (m.attachmentPaths && m.attachmentPaths.length > 0) {
    lines.push(
      "",
      `${SIGNALS.ATTACHED_PATHS} 用户附了以下文件 / 目录路径、按需用 \`read\` / \`grep\` / \`glob\` 读取（路径已是绝对路径、直接用）：`,
      ...m.attachmentPaths.map((p, i) => `  ${i + 1}. ${p}`),
    );
  }
  return lines;
};

/**
 * **只读**消息封装：`[USER_MESSAGE]` 抬头 + 正文 + 附件段，到此为止。
 *
 * 为什么不复用 {@link buildAgentMessage}：它的 `user_message` 分支会追加一段固定行为
 * 约束（「…**修改要求**才动手改（改完说明改了什么）…不要调 submit_work…」）。那段是给
 * **属主**写的——把它塞进受限（只读）答疑的 prompt，就等于在同一段指令里既写「禁止改」
 * 又写「修改要求才动手改」，还把群里的非属主称作「用户」，只读招牌当场作废。
 *
 * 调用方：需求群非属主的受限答疑通道（`restricted-question.ts`）。
 */
export const buildReadonlyUserMessage = (msg: {
  text: string;
  imagePaths?: string[];
  attachmentPaths?: string[];
}): string =>
  [SIGNALS.USER_MESSAGE, "", msg.text, ...attachmentSections(msg)].join("\n");

/**
 * 把用户操作序列化成发给 agent 的消息文本（`agent.send(text)`）。
 * 头部信号字面量（[NEXT_ACTION] / [USER_MESSAGE] / [USER_REPLY]…）与 prompts 的
 * 解读约定一致、由 tests/protocol-signals.test.ts 守护。
 */
export const buildAgentMessage = (msg: AgentMessage): string => {
  if (msg.kind === "next_action") {
    const head = buildNextActionHead({
      actionId: msg.nextActionId,
      actionType: msg.nextActionType,
      n: msg.nextN,
      artifactPath: msg.nextArtifactPath,
    });
    const lines: string[] = [head];
    if (msg.text && msg.text.trim()) lines.push("", msg.text);
    lines.push(...attachmentSections(msg));
    return lines.join("\n");
  }
  if (msg.kind === "user_message") {
    // V0.13.x 统一消息（用户拍板「别这么多分支、AI 自主判断」）：行为约束内联在消息里
    //（比只靠 prompt 教稳）。有产出在等审阅时附上下文、要求处理完重新交卷（原 revise 语义）。
    const lines: string[] = [
      SIGNALS.USER_MESSAGE,
      "",
      msg.text,
      ...attachmentSections(msg),
      "",
    ];
    if (msg.ackContext) {
      // 「〈产出审阅中〉」字面量必须保留——_super.md 教 agent 的判卷闸门就是这个词
      //（审计揪过：文案与 prompt 字面对不上、agent 可能漏交卷）
      lines.push(
        `〈产出审阅中〉你有一份产出正在等用户审阅（action_id=${msg.ackContext.actionId}${msg.ackContext.artifactPath ? `、artifact=${msg.ackContext.artifactPath}` : ""}）。先判断这条消息的性质：**纯疑问**就直接回答、别把问题当成改动指令；**修改意见**才动 artifact / 代码（模糊的先 ask_user 复述确认）。无论问还是改：**先把答案 / 改动说明直接回复给用户、再调 submit_work（同 action_id）重新交卷**、然后结束回复。不要输出「这是纯疑问 / 我将…」之类的分类旁白、直接给内容。`,
      );
    } else {
      lines.push(
        "（这是任务过程中用户的插话、不是推进指令。先判断性质：**纯疑问**就直接回答、别把问题当成改动指令；**修改要求**才动手改（改完说明改了什么）。不要调 submit_work / submit_mr 推进任务链——进度停在原地、等用户自己推进。处理完自然结束本轮回复。）",
      );
    }
    return lines.join("\n");
  }
  // user_reply
  const lines: string[] = [SIGNALS.USER_REPLY, "", msg.text];
  lines.push(...attachmentSections(msg));
  return lines.join("\n");
};
