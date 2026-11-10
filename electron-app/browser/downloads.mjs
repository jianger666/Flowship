/**
 * 下载登记表（契约 §14.1 `downloads` op / §14.3 下载 UI 的数据源）：每个浏览器会话一份。
 *
 * 纯逻辑、零 electron 依赖：index.mjs 的 `will-download` 处理里把 DownloadItem 的 updated / done 事件翻译成
 * `addStarted` / `update` / `finish`，`downloads` op 只读它。这样状态机与 waitSettled 可以脱离 Electron 单测。
 *
 * 状态机：progressing → completed | cancelled | interrupted（终态不可再变，晚到的事件一律忽略）。
 * 为什么 updated 事件里的 `interrupted` 不算终态：Electron 的 item 在网络抖动时先发 updated(interrupted)，
 * 之后可能 resume 成 progressing；只有 `done` 事件才是真正的终态。
 *
 * 安全：页面可控的只有 url / 建议文件名。这里的 url 一律去掉 query / hash / userinfo（可能带 token）；
 * 路径由调用方（index.mjs，固定下载目录 + uniqueDownloadPath）给出，登记表不接受页面传来的路径。
 */
import { BrowserError } from "./server-channel.mjs";

/** 登记表容量：超了丢最旧（优先丢已结束的） */
export const MAX_DOWNLOADS = 50;
/** 状态推送里带多少条（最新在前） */
export const STATE_DOWNLOADS = 10;
/** 点击 → 下载真正开始之间的宽限：`wait` 带 sinceId 且暂时没有新下载时，最多再等这么久看有没有下载冒出来 */
export const WAIT_START_GRACE_MS = 1500;

const TERMINAL = new Set(["completed", "cancelled", "interrupted"]);

/** 下载 URL 脱敏：去 query / hash / userinfo；data: 只留协议；解析失败时手工截掉 ? # 之后的部分 */
export const sanitizeDownloadUrl = (url) => {
  const raw = String(url ?? "");
  if (/^data:/i.test(raw)) return "data:";
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.toString().slice(0, 500);
  } catch {
    return raw.split(/[?#]/)[0].slice(0, 500);
  }
};

const finiteNum = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

/**
 * @typedef {{
 *   id: number, fileName: string, path: string, url: string,
 *   state: "progressing" | "completed" | "cancelled" | "interrupted",
 *   receivedBytes: number, totalBytes: number, startedAt: number, endedAt?: number, tabId?: string,
 * }} DownloadRecord 与 src/lib/browser-bridge-types.ts 的 DownloadInfo 同形
 */

/**
 * 对外只给副本，避免调用方改动登记表里的对象
 * @param {DownloadRecord} rec
 * @returns {DownloadRecord}
 */
const snapshot = (rec) => ({ ...rec });

/**
 * @param {{ now?: () => number, max?: number, startGraceMs?: number }} [opts]
 */
export const createDownloadRegistry = (opts = {}) => {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? MAX_DOWNLOADS;
  const startGraceMs = opts.startGraceMs ?? WAIT_START_GRACE_MS;

  /** @type {DownloadRecord[]} 按 id 升序 */
  const items = [];
  let nextId = 1;
  let disposed = false;
  /** 等待 settled 的人：状态变化 / 新下载时被叫醒重新判断 */
  const waiters = new Set();

  const wake = () => {
    for (const w of [...waiters]) w();
  };

  const evict = () => {
    while (items.length > max) {
      // 优先丢最旧的已结束项；全在途时才丢最旧的在途项（它之后的 update 会因找不到 id 被忽略）
      const idx = items.findIndex((it) => TERMINAL.has(it.state));
      items.splice(idx >= 0 ? idx : 0, 1);
    }
  };

  /**
   * 登记一个新下载（will-download 当下）。
   * @param {{ fileName: string, path: string, url?: string, totalBytes?: number, tabId?: string }} info
   */
  const addStarted = (info) => {
    if (disposed) return null;
    const rec = {
      id: nextId++,
      fileName: String(info.fileName ?? "download").slice(0, 200),
      path: String(info.path ?? ""),
      url: sanitizeDownloadUrl(info.url),
      state: "progressing",
      receivedBytes: 0,
      totalBytes: finiteNum(info.totalBytes),
      startedAt: now(),
      ...(info.tabId ? { tabId: String(info.tabId) } : {}),
    };
    items.push(rec);
    evict();
    wake();
    return snapshot(rec);
  };

  const find = (id) => items.find((it) => it.id === id) ?? null;

  /** 进度更新（只对在途项有效）。返回更新后的副本；未知 id / 已终态返回 null */
  const update = (id, patch = {}) => {
    const rec = find(id);
    if (!rec || TERMINAL.has(rec.state)) return null;
    if (patch.receivedBytes !== undefined) rec.receivedBytes = finiteNum(patch.receivedBytes, rec.receivedBytes);
    if (patch.totalBytes !== undefined) rec.totalBytes = finiteNum(patch.totalBytes, rec.totalBytes);
    if (patch.path !== undefined && typeof patch.path === "string" && patch.path !== "") rec.path = patch.path;
    return snapshot(rec);
  };

  /** 终态落定（done 事件）。非法 state 当 interrupted；已终态的忽略。 */
  const finish = (id, state, patch = {}) => {
    const rec = find(id);
    if (!rec || TERMINAL.has(rec.state)) return null;
    rec.state = TERMINAL.has(state) ? state : "interrupted";
    if (patch.receivedBytes !== undefined) rec.receivedBytes = finiteNum(patch.receivedBytes, rec.receivedBytes);
    if (patch.totalBytes !== undefined) rec.totalBytes = finiteNum(patch.totalBytes, rec.totalBytes);
    // 成功完成：已收字节就是总字节（chunked 下载 totalBytes 开始时是 0）
    if (rec.state === "completed" && rec.totalBytes < rec.receivedBytes) rec.totalBytes = rec.receivedBytes;
    rec.endedAt = now();
    wake();
    return snapshot(rec);
  };

  /** 最近 n 条，最新在前 */
  const recent = (n = STATE_DOWNLOADS) =>
    items
      .slice(-Math.max(0, n))
      .reverse()
      .map(snapshot);

  /** 全部（最近 max 条），最新在前 */
  const list = () => recent(max);

  const lastId = () => (items.length ? items[items.length - 1].id : 0);

  /** 在途的下载数 */
  const inflightCount = () => items.filter((it) => !TERMINAL.has(it.state)).length;

  /** 本次 wait 关心的集合：给了 sinceId → id 大于它的全部；否则 → 当前在途的 */
  const targetsOf = (sinceId, snapshotIds) => {
    if (snapshotIds) return items.filter((it) => snapshotIds.has(it.id));
    return sinceId !== undefined ? items.filter((it) => it.id > sinceId) : items.filter((it) => !TERMINAL.has(it.state));
  };

  /**
   * 等「sinceId 之后出现的下载全部结束」或「当前在途的下载结束」。
   * - 没有任何目标下载（也没在途）：立即返回 `{ downloads: [], timedOut: false }`；
   *   例外：给了 sinceId 时会先给 `startGraceMs` 的宽限等下载冒出来（click 之后 will-download 往往晚几百毫秒）。
   * - 不给 sinceId 时目标集合在调用当下固定（不追加后来新开的下载），避免被不停新增的下载拖到超时。
   * - 到 timeoutMs 仍有在途 → `timedOut: true`，返回目标集合的当前快照。
   * - signal 打断 → reject(signal.reason)；登记表被 dispose → reject CANCELLED。
   *
   * @param {{ sinceId?: number, timeoutMs?: number, signal?: AbortSignal }} [o]
   * @returns {Promise<{ downloads: DownloadRecord[], timedOut: boolean }>}
   */
  const waitSettled = ({ sinceId, timeoutMs = 30_000, signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (disposed) return reject(new BrowserError("CANCELLED", "浏览器会话已关闭"));
      const startedAt = now();
      // 不给 sinceId：目标 = 调用当下在途的那批，固定下来
      const fixedIds = sinceId === undefined ? new Set(items.filter((it) => !TERMINAL.has(it.state)).map((it) => it.id)) : null;
      let timer = null;
      let graceTimer = null;
      let graceOver = sinceId === undefined || startGraceMs <= 0;

      const cleanup = () => {
        waiters.delete(check);
        clearTimeout(timer);
        clearTimeout(graceTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const done = (timedOut) => {
        cleanup();
        resolve({ downloads: targetsOf(sinceId, fixedIds).reverse().map(snapshot), timedOut });
      };
      function onAbort() {
        cleanup();
        reject(signal.reason);
      }
      function check() {
        if (disposed) {
          cleanup();
          reject(new BrowserError("CANCELLED", "浏览器会话已关闭"));
          return;
        }
        const targets = targetsOf(sinceId, fixedIds);
        if (targets.length === 0) {
          // 没有目标：给 sinceId 时等宽限；宽限用完（或没给 sinceId）立即返回空
          if (graceOver) done(false);
          return;
        }
        if (targets.every((it) => TERMINAL.has(it.state))) done(false);
      }

      waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        // 超时：还有在途目标才算 timedOut；全结束 / 没有目标按正常返回
        const targets = targetsOf(sinceId, fixedIds);
        done(targets.some((it) => !TERMINAL.has(it.state)));
      }, Math.max(0, timeoutMs - (now() - startedAt)));
      if (!graceOver) {
        graceTimer = setTimeout(() => {
          graceOver = true;
          check();
        }, startGraceMs);
      }
      check();
    });

  /** 会话销毁：叫醒所有等待者（它们以 CANCELLED 结束），之后拒绝新登记 */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    wake();
    waiters.clear();
  };

  return {
    addStarted,
    update,
    finish,
    list,
    recent,
    lastId,
    inflightCount,
    waitSettled,
    dispose,
    /** 登记表里是否已有这个落盘路径（并发同名下载时，磁盘上还没文件，要靠它避开在途的同名路径） */
    hasPath: (p) => items.some((it) => it.path === p),
    get: (id) => {
      const r = find(id);
      return r ? snapshot(r) : null;
    },
    get size() {
      return items.length;
    },
  };
};
