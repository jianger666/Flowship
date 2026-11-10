/**
 * 无痕标签（契约 §15.2 A6）的纯逻辑：内存 partition 的命名 / 校验 / 引用计数 / 关闭即清空。
 * 不 import electron：`wipe` 由 index.mjs 注入（`ses.clearStorageData()` 等），所以单测可以用假 session 驱动全部分支。
 *
 * 无痕 = 一个**内存 partition**（名字不带 `persist:` 前缀）：不共享持久档案里的登录态，进程退出即消失。
 * Electron 没有「销毁 session」的 API，所以「关标签即销毁」落地为：最后一个用这个 partition 的 tab 销毁后，
 * 清空它的全部存储 / HTTP 缓存 / 认证缓存，然后（清空成功才）把名字放回复用池——Session 对象本身常驻，
 * 复用池把常驻数量限制在「同时开着的无痕标签峰值」，而不是「进程生命周期里开过多少个」。
 */

import { closeConnectionsSafe } from "./conn-hygiene.mjs";

/** 内存 partition 的统一前缀（没有 `persist:`） */
export const INCOGNITO_PARTITION_PREFIX = "flowship-incognito-";

/** 整个名字的形状：前缀 + `[A-Za-z0-9_-]{1,100}`（index.mjs 的 ensurePartitionConfigured 用它拒绝任何别的 partition 名） */
export const INCOGNITO_PARTITION_RE = /^flowship-incognito-[A-Za-z0-9_-]{1,100}$/;

/** taskId 净化后最多留这么多字符（名字上限 100，要给 tabId 与序号留位置） */
const TASK_PART_MAX = 40;
const TAB_PART_MAX = 20;
/** 复用池上限：超过的名字直接丢弃（Session 常驻内存，不能无限攒） */
export const INCOGNITO_POOL_MAX = 8;

export const isIncognitoPartition = (name) => typeof name === "string" && INCOGNITO_PARTITION_RE.test(name);

const sanitizePart = (value, max, fallback) => {
  // 只留 [A-Za-z0-9_-]：taskId 来自 server（理论上可信，但 partition 名会进文件系统 / IPC，不能带路径分隔符、点、空白、非 ASCII）
  const s = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, max);
  return s === "" ? fallback : s;
};

/** taskId → 名字里的那一段（净化 + 截断，空则 `task`） */
export const sanitizeTaskId = (taskId) => sanitizePart(taskId, TASK_PART_MAX, "task");

let globalSeq = 0;
/** 进程内单调递增的序号：保证同一进程里新生成的名字互不相同（即使 taskId 净化后撞车 / 会话销毁重建后 tabId 从 t1 重来） */
export const nextIncognitoSeq = () => ++globalSeq;

/**
 * 生成一个无痕 partition 名：`flowship-incognito-<净化后的 taskId>-<tabId>-<序号>`。
 * 序号是为了「唯一」：taskId 净化是有损的（`a:b` 与 `a_b` 撞车），会话销毁重建后 tabId 也会重来，
 * 同名内存 partition 在 Electron 里是同一个 Session——撞名就等于两个无痕标签共享 cookie，或旧标签的清空任务误清新标签的数据。
 * 整体长度恒 ≤ 前缀 + 74（task ≤ 40、tab ≤ 20、序号 ≤ 12 位），必然匹配 {@link INCOGNITO_PARTITION_RE}。
 *
 * @param {{ taskId: string, tabId: string, seq: number }} p
 */
export const makeIncognitoPartition = ({ taskId, tabId, seq }) => {
  const n = Number.isSafeInteger(seq) && seq >= 0 ? String(seq).slice(0, 12) : "0";
  return `${INCOGNITO_PARTITION_PREFIX}${sanitizeTaskId(taskId)}-${sanitizePart(tabId, TAB_PART_MAX, "t")}-${n}`;
};

/**
 * 清空一个无痕 session：存储（cookie / localStorage / IndexedDB / Service Worker / CacheStorage …，不带 options = 全部类型）、
 * HTTP 缓存、认证缓存。任何一步失败都向上抛——调用方据此「不回收这个 partition」（宁可退役也不复用一个没清干净的）。
 * R6-10：最后还要 `closeAllConnections()`——用户在无痕标签里放行过坏证书后，Chromium 对同 host:port 会复用那条连接；
 * partition 回收给下一个无痕标签（或别的任务）时，不断掉它就会既不询问、也没有「证书错误已被放行」的标注。
 * 这一步失败只记日志、不抛（抛了 partition 就退役，宁可不退役：存储已经清干净了）。
 * @param {{ clearStorageData: Function, clearCache?: Function, clearAuthCache?: Function, closeAllConnections?: Function }} ses
 * @param {(msg: string) => void} [log]
 */
export const wipeIncognitoSession = async (ses, log) => {
  await ses.clearStorageData();
  if (typeof ses.clearCache === "function") await ses.clearCache();
  if (typeof ses.clearAuthCache === "function") await ses.clearAuthCache();
  await closeConnectionsSafe(ses, log, "无痕 partition 清空");
};

/**
 * 无痕 partition 的分配 / 引用计数 / 回收（纯逻辑，wipe 注入）。
 *
 * 引用计数：一个 partition 可能被多个 tab 同时使用（无痕标签里 `window.open` 的弹窗继承它的 partition），
 * 只有**最后一个**用它的 tab 关闭才清空——先关弹窗不能把还开着的无痕标签的登录态清掉。
 *
 * @param {{ wipe: (name: string) => Promise<void>, log?: (msg: string) => void, nextSeq?: () => number, poolMax?: number }} deps
 */
export const createIncognitoManager = ({ wipe, log = () => {}, nextSeq = nextIncognitoSeq, poolMax = INCOGNITO_POOL_MAX }) => {
  /** name → 仍在使用的 tab 数 */
  const refs = new Map();
  /** 已清空、可复用的名字 */
  const free = [];
  /** 正在清空中的名字（清空完成前既不在 refs 也不在 free，谁也拿不到它） */
  const wiping = new Set();
  /** 清空失败而退役的名字（永不复用；只用于诊断计数） */
  const retired = new Set();
  /** 进行中的清空任务（单测 / 退出时可 await） */
  const pending = new Set();

  return {
    /** 取一个无痕 partition 名：优先复用已清空的，否则按 taskId / tabId 现生成一个唯一的 */
    allocate({ taskId, tabId }) {
      const reused = free.pop();
      return reused ?? makeIncognitoPartition({ taskId, tabId, seq: nextSeq() });
    },

    /** tab 建成功后登记（弹窗继承 opener 的 partition 也走这里，计数 +1） */
    retain(name) {
      if (!isIncognitoPartition(name)) return;
      refs.set(name, (refs.get(name) ?? 0) + 1);
    },

    /** 分配了名字但 tab 没建成（createTab 抛错）：没人用它，放回池里（有人在用 / 清空中的不动） */
    abandon(name) {
      if (!isIncognitoPartition(name) || refs.has(name) || wiping.has(name) || free.includes(name) || retired.has(name)) return;
      if (free.length < poolMax) free.push(name);
    },

    /**
     * tab 销毁后调用（计数 -1）。归零 → 异步清空；清空成功才回收到复用池，失败退役。
     * 返回清空任务的 Promise（计数没归零 / 不是无痕名时为 undefined）；永不 reject。
     */
    release(name) {
      // 没登记过（或已释放干净）的名字：空操作——多释放一次不能触发对一个没人用的 / 池里的 / 正在清空的 partition 的二次清空
      if (!isIncognitoPartition(name) || !refs.has(name)) return undefined;
      const n = refs.get(name) - 1;
      if (n > 0) {
        refs.set(name, n);
        return undefined;
      }
      refs.delete(name);
      wiping.add(name);
      const job = Promise.resolve()
        .then(() => wipe(name))
        .then(
          () => {
            wiping.delete(name);
            if (free.length < poolMax) free.push(name);
          },
          (err) => {
            wiping.delete(name);
            retired.add(name);
            log(`[browser] 无痕 partition 清空失败，已退役不再复用：${err?.message || err}`);
          },
        )
        .finally(() => pending.delete(job));
      pending.add(job);
      return job;
    },

    /** 等当前所有清空任务结束（退出 / 单测用） */
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },

    stats: () => ({ live: refs.size, wiping: wiping.size, free: free.length, retired: retired.size }),
  };
};
