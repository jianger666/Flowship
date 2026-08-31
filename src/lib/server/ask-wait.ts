/**
 * ask_user 同一轮阻塞等答案（只给提问用，不是旧 wait-ack / wait_for_user）
 *
 * ask_user 工具仍立刻返回（躲开 MCP ~60s 超时），返回里带一条前台 curl。
 * 模型把 curl 挂上之后，本槽的 waiter 才算「这一轮停在等答案」。
 *
 * 答题卡一推出来就能点，curl 往往还要再想 1～2 秒才挂上。秒答时：
 *   - 已挂上 → 把 [ASK_USER_REPLY] 写进 curl stdout，同一轮继续（不 send）
 *   - 还没挂上 → 答案先压在槽里，等 curl 连上立刻吐出（也不 send）
 *   - 等了 ASK_WAIT_ATTACH_MS 仍没挂上 → 关掉槽，调用方走原来的 send
 *
 * 不 run.cancel()：等答案靠这条前台 curl 挂着，模型再 grep 也让它跑。
 */

import {
  isAskWaitCommand,
  toolArgsLookLikeAskWait,
} from "@/lib/ask-wait-detect";

export { isAskWaitCommand, toolArgsLookLikeAskWait };

const GLOBAL_KEY = "__flowshipAskWaitV1__";

/** curl 长时间无输出会被 SDK idle-timeout 杀掉；带时间戳的注释行，避开当年一模一样的 KEEPALIVE */
export const ASK_WAIT_IDLE_MS = 45_000;

/**
 * 秒答后等多久让 curl 挂上。实测模型想完再 curl 大约 1～2s；
 * 超时再 send，避免和还在路上的同一轮 curl 撞车（410 +「上一轮尚未结束」）。
 */
export const ASK_WAIT_ATTACH_MS = 15_000;

export type AskWaitSlot = {
  taskId: string;
  askId: string;
  token: string;
  createdAt: number;
  waiter: AskWaitWaiter | null;
  settled: boolean;
  /** 用户已答、curl 还没挂上：答案压在这里，挂上立刻吐 */
  pendingReply?: string;
};

export type AskWaitWaiter = {
  write: (chunk: string) => void;
  close: () => void;
};

type AskWaitState = {
  slots: Map<string, AskWaitSlot>;
};

/** 压槽等 curl 时的 Promise 回调 + 超时器，不挂到对外类型上 */
type AttachWait = {
  resolvers: Array<(viaCurl: boolean) => void>;
  timer?: ReturnType<typeof setTimeout>;
};

const attachWaits = new WeakMap<AskWaitSlot, AttachWait>();

const state = (): AskWaitState => {
  const g = globalThis as unknown as Record<string, AskWaitState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { slots: new Map() };
  }
  return g[GLOBAL_KEY]!;
};

const resolveAttachWait = (slot: AskWaitSlot, viaCurl: boolean): void => {
  const wait = attachWaits.get(slot);
  if (!wait) return;
  if (wait.timer) clearTimeout(wait.timer);
  attachWaits.delete(slot);
  slot.pendingReply = undefined;
  for (const resolve of wait.resolvers) resolve(viaCurl);
};

const addAttachResolver = (
  slot: AskWaitSlot,
  resolve: (viaCurl: boolean) => void,
): void => {
  const wait = attachWaits.get(slot) ?? { resolvers: [] };
  wait.resolvers.push(resolve);
  attachWaits.set(slot, wait);
};

const setAttachTimer = (
  slot: AskWaitSlot,
  timer: ReturnType<typeof setTimeout>,
): void => {
  const wait = attachWaits.get(slot) ?? { resolvers: [] };
  if (wait.timer) clearTimeout(wait.timer);
  wait.timer = timer;
  attachWaits.set(slot, wait);
};

const writeReplyAndClose = (slot: AskWaitSlot, body: string): void => {
  slot.settled = true;
  const waiter = slot.waiter;
  slot.waiter = null;
  waiter?.write(body);
  waiter?.close();
  const taskId = slot.taskId;
  resolveAttachWait(slot, true);
  if (state().slots.get(taskId) === slot) {
    state().slots.delete(taskId);
  }
};

export const resetAskWaitForTest = (): void => {
  for (const taskId of [...state().slots.keys()]) {
    cancelAskWait(taskId, "test-reset");
  }
  state().slots.clear();
};

export const getAskWait = (taskId: string): AskWaitSlot | null =>
  state().slots.get(taskId) ?? null;

export const hasLiveAskWaiter = (taskId: string): boolean =>
  Boolean(getAskWait(taskId)?.waiter && !getAskWait(taskId)?.settled);

/** 用户已答、还在等 curl 挂上——这轮不要因为 grep/read 就温和收掉 */
export const hasParkedAskWaitReply = (taskId: string): boolean => {
  const slot = getAskWait(taskId);
  return Boolean(slot && !slot.settled && slot.pendingReply);
};

/** 本机 Next 监听端口：壳注入 PORT，dev:web 是 8676 */
export const askWaitListenPort = (): string =>
  process.env.PORT?.trim() || "8876";

export const buildAskWaitUrl = (taskId: string, token: string): string =>
  `http://127.0.0.1:${askWaitListenPort()}/api/tasks/${encodeURIComponent(taskId)}/ask-wait?token=${encodeURIComponent(token)}`;

export const buildAskWaitCurl = (taskId: string, token: string): string =>
  `curl -NsS --no-buffer ${JSON.stringify(buildAskWaitUrl(taskId, token))}`;

/**
 * 提问受理后开槽。同一 task 新提问顶旧槽（旧 curl 会被关掉）。
 */
export const openAskWait = (args: {
  taskId: string;
  askId: string;
  token: string;
}): void => {
  const prev = state().slots.get(args.taskId);
  if (prev && !prev.settled) {
    prev.settled = true;
    prev.waiter?.write(`# ask-wait ended: superseded\n`);
    prev.waiter?.close();
    resolveAttachWait(prev, false);
  }
  state().slots.set(args.taskId, {
    taskId: args.taskId,
    askId: args.askId,
    token: args.token,
    createdAt: Date.now(),
    waiter: null,
    settled: false,
  });
};

/**
 * 停止 / 作废提问：关掉长连接。askId 不匹配则不动（防旧 A 清掉 B）。
 */
export const cancelAskWait = (
  taskId: string,
  reason: string,
  expectedAskId?: string,
): boolean => {
  const slot = state().slots.get(taskId);
  if (!slot || slot.settled) return false;
  if (expectedAskId && slot.askId !== expectedAskId) return false;
  slot.settled = true;
  slot.waiter?.write(`# ask-wait ended: ${reason}\n`);
  slot.waiter?.close();
  resolveAttachWait(slot, false);
  state().slots.delete(taskId);
  return true;
};

/**
 * curl 挂上。同一 task 只留一条；后到的替换先到的（重连）。
 * 槽已结 / token 不对 → 返 null，路由 410。
 * 槽上已压着答案 → 立刻写出并关掉（返回的 slot.settled === true，路由不要再写 connected）。
 */
export const attachAskWaiter = (
  taskId: string,
  token: string,
  waiter: AskWaitWaiter,
): AskWaitSlot | null => {
  const slot = state().slots.get(taskId);
  if (!slot || slot.settled || slot.token !== token) return null;
  if (slot.waiter) {
    slot.waiter.write(`# ask-wait ended: replaced\n`);
    slot.waiter.close();
  }
  slot.waiter = waiter;
  const parked = slot.pendingReply;
  if (parked) {
    waiter.write(`# ask-wait connected ${new Date().toISOString()}\n`);
    writeReplyAndClose(slot, parked);
    return slot;
  }
  return slot;
};

export const detachAskWaiter = (
  taskId: string,
  waiter: AskWaitWaiter,
): void => {
  const slot = state().slots.get(taskId);
  if (!slot || slot.waiter !== waiter) return;
  slot.waiter = null;
};

/**
 * 用户答案送到本槽。
 * true = 已写进活着的 curl，或秒答后 curl 在时限内挂上了（调用方不要再 send）
 * false = 槽不对，或等了 attachWaitMs 仍没挂上（调用方走 send；本槽会关掉，避免随后 curl 再吃一份）
 */
export const fulfillAskWait = async (
  taskId: string,
  askId: string,
  replyText: string,
  opts?: { attachWaitMs?: number },
): Promise<boolean> => {
  const slot = state().slots.get(taskId);
  if (!slot || slot.settled || slot.askId !== askId) return false;
  const body = replyText.endsWith("\n") ? replyText : `${replyText}\n`;
  if (slot.waiter) {
    writeReplyAndClose(slot, body);
    return true;
  }
  const waitMs = opts?.attachWaitMs ?? ASK_WAIT_ATTACH_MS;
  slot.pendingReply = body;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (viaCurl: boolean) => {
      if (settled) return;
      settled = true;
      resolve(viaCurl);
    };
    addAttachResolver(slot, finish);
    // 压完立刻再看一眼：理论上本函数同步段里不会冒出 waiter，防重入
    if (slot.waiter && slot.pendingReply) {
      writeReplyAndClose(slot, slot.pendingReply);
      return;
    }
    setAttachTimer(
      slot,
      setTimeout(() => {
        const live = state().slots.get(taskId);
        if (live !== slot || slot.settled || slot.waiter) return;
        slot.settled = true;
        state().slots.delete(taskId);
        resolveAttachWait(slot, false);
      }, waitMs),
    );
  });
};
