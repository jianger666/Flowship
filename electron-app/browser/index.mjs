/**
 * createBrowserManager(deps)：内置浏览器主进程总入口（契约 §8 / §8.2）。
 *
 * 管：会话表（taskId → BrowserSession）、op 分发（server ipc 通道的 dispatch）、停车场窗口、partition 级权限 / 下载、
 * `browser:*` IPC（渲染进程面板）、config 消息、去抖后的状态推送。
 * 不管：CDP 细节（tab.mjs）、控制权状态机（session.mjs）、动作实现（actions.mjs）、拾取（picker.mjs）。
 *
 * 对外只有契约里那几个方法；`dispatch` / `getSession` / `getConfig` 额外暴露，仅供单测与 e2e 脚本直接驱动。
 */
import fs from "node:fs";
import path from "node:path";

import { createActivityLog } from "./activity-log.mjs";
import * as actions from "./actions.mjs";
import { assertEvaluateNotUserControlled, ensureEvaluateApproval, revokeEvaluateApproval, runApprovedEvaluate } from "./evaluate-approval.mjs";
import { debugPauseGate } from "./ops/debug.mjs";
import { createIncognitoManager, INCOGNITO_PARTITION_RE, isIncognitoPartition, wipeIncognitoSession } from "./incognito.mjs";
import {
  BLOCK_REPORT_INTERVAL_MS,
  MAX_ACTIVE_DOWNLOADS,
  MAX_PAUSED_DOWNLOADS,
  createBlockThrottle,
  createDownloadWindow,
  decideDownload,
  exceedsSizeCap,
} from "./download-policy.mjs";
import { createLocalHtmlServer } from "./local-html-server.mjs";
import { redactUrlSecrets } from "./net-detail.mjs";
import { normalizeNetworkArgs, NetFilterError, selectNetworkEntries } from "./net-filter.mjs";
import { createNetGuard, peekNetGuardState } from "./net-guard.mjs";
import { closeConnectionsSafe, releaseSessionNetwork } from "./conn-hygiene.mjs";
import * as pageScripts from "./page-scripts.mjs";
import { createPermissionGate } from "./permission-gate.mjs";
import { startPicker as defaultStartPicker } from "./picker.mjs";
import { BrowserError, createServerChannel } from "./server-channel.mjs";
import { BrowserSession, normalizeBounds } from "./session.mjs";
import { createExtraHandlers, EXTRA_OPS, normalizeExtraOpArgs } from "./ops/index.mjs";
import { normalizeModifiers } from "./ops/input.mjs";
import { normalizeScreenshotArgs } from "./screenshot-kit.mjs";
import { normalizeScrollArgs } from "./scroll-kit.mjs";
import { BROWSER_PARTITION, BrowserTab, PARKING_BOUNDS } from "./tab.mjs";
import { checkUrl, normalizeAiUrl, resolveUserInput } from "./url-policy.mjs";
import { registerUserFeatures } from "./user-features.mjs";

// ───────────────────────── 常量 ─────────────────────────

/** §4.3 表里原有的 20 个 op（单测按它对账 normalizeOpArgs / dispatch 覆盖面） */
export const BASE_OPS = Object.freeze([
  "navigate",
  "nav_history",
  "snapshot",
  "screenshot",
  "click",
  "hover",
  "type",
  "press_key",
  "select",
  "scroll",
  "drag",
  "wait_for",
  "tabs",
  "console",
  "network",
  "evaluate",
  "user_activity",
  "ask_user_to_act",
  "status",
  "close_session",
]);

/** 全部 op = 原有 20 个 + 增强包 E1 新增（契约 §14，来自 ops/*.mjs） */
export const ALL_OPS = Object.freeze([...BASE_OPS, ...EXTRA_OPS]);

/** 没有会话时不会懒创建、直接 NO_SESSION 的 op（除了 status / close_session 有自己的无会话语义） */
export const NEEDS_SESSION_OPS = Object.freeze([
  "nav_history",
  "snapshot",
  "screenshot",
  "click",
  "hover",
  "type",
  "press_key",
  "select",
  "scroll",
  "drag",
  "wait_for",
  "console",
  "network",
  "evaluate",
  "user_activity",
]);

export const NO_SESSION_MESSAGE = "还没有打开任何页面，请先调用 browser_navigate";

const MAX_TASK_ID = 200;
const WAIT_POLL_MS = 300;
const MAX_TIME_WAIT_MS = 30_000;
const STATE_DEBOUNCE_MS = 50;

// ───────────────────────── 纯函数：参数校验 ─────────────────────────

const bad = (msg) => new BrowserError("BAD_ARGS", msg);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const reqStr = (args, key, { max = 20_000, allowEmpty = false } = {}) => {
  const v = args[key];
  if (typeof v !== "string") throw bad(`缺少必填参数 ${key}（字符串）`);
  if (!allowEmpty && v.trim() === "") throw bad(`参数 ${key} 不能为空`);
  if (v.length > max) throw bad(`参数 ${key} 过长（上限 ${max} 字符）`);
  return v;
};

const optStr = (args, key, max = 2000) => {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad(`参数 ${key} 必须是字符串`);
  if (v.length > max) throw bad(`参数 ${key} 过长（上限 ${max} 字符）`);
  return v;
};

const optBool = (args, key, dflt) => {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw bad(`参数 ${key} 必须是布尔值`);
  return v;
};

const optNum = (args, key, { min, max, dflt, integer = true } = {}) => {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`参数 ${key} 必须是有限数字`);
  let n = integer ? Math.round(v) : v;
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
};

const optEnum = (args, key, allowed, dflt) => {
  const v = args[key];
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v !== "string" || !allowed.includes(v)) throw bad(`参数 ${key} 只能是 ${allowed.join(" / ")}，收到「${String(v).slice(0, 20)}」`);
  return v;
};

const reqEnum = (args, key, allowed) => {
  const v = optEnum(args, key, allowed, undefined);
  if (v === undefined) throw bad(`缺少必填参数 ${key}（${allowed.join(" / ")}）`);
  return v;
};

/** 交给 ops/*.mjs 的校验工具箱（契约 §14.0）；withTab(args, o) 把 args.tabId 带进 o */
export const OP_HELPERS = Object.freeze({
  bad,
  isObj,
  reqStr,
  optStr,
  optBool,
  optNum,
  optEnum,
  reqEnum,
  withTab: (args, o) => {
    const tabId = optStr(args, "tabId", 20);
    return tabId ? { ...o, tabId } : o;
  },
});

/**
 * 按 op 规整 / 校验参数（纯函数）：返回只含契约字段的新对象，非法抛 BAD_ARGS。
 * dispatch 在做任何有副作用的事（建会话 / 导航）之前先过这里。
 */
export const normalizeOpArgs = (op, rawArgs) => {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (!isObj(args)) throw bad("args 必须是对象");
  const tabId = optStr(args, "tabId", 20);
  const withTab = (o) => (tabId ? { ...o, tabId } : o);
  switch (op) {
    case "navigate":
      return withTab({ url: reqStr(args, "url", { max: 8192 }), timeoutMs: optNum(args, "timeoutMs", { min: 1000, max: 120_000, dflt: 30_000 }) });
    case "nav_history":
      return withTab({ direction: reqEnum(args, "direction", ["back", "forward", "reload"]), timeoutMs: optNum(args, "timeoutMs", { min: 1000, max: 120_000, dflt: 30_000 }) });
    case "snapshot": {
      // V1：query = 大小写不敏感子串，只留命中行 + 祖先链 + 上下文（过滤在 ax-snapshot.filterSnapshotText）；空串 / 纯空白视为没给
      const queryRaw = optStr(args, "query", 200);
      const query = queryRaw !== undefined && queryRaw.trim() !== "" ? queryRaw.trim() : undefined;
      return withTab({
        maxChars: optNum(args, "maxChars", { min: 1000, max: 200_000, dflt: 30_000 }),
        maxElements: optNum(args, "maxElements", { min: 10, max: 5000, dflt: 1500 }),
        viewportOnly: optBool(args, "viewportOnly", false),
        ...(query !== undefined ? { query } : {}),
      });
    }
    case "screenshot":
      // E2·P5a B6：format 加 webp、quality / maxWidth 改严格校验、新增 clip / scale / omitBackground / annotate 与互斥规则（screenshot-kit.mjs）
      return withTab(normalizeScreenshotArgs(args, OP_HELPERS));
    case "click": {
      // V1：modifiers（Ctrl/Cmd+点击链接 = 新标签页等）；没给就不带该字段，老调用方的参数形状不变
      const modifiers = normalizeModifiers(args.modifiers, bad);
      return withTab({
        ref: reqStr(args, "ref", { max: 20 }),
        button: optEnum(args, "button", ["left", "right", "middle"], "left"),
        doubleClick: optBool(args, "doubleClick", false),
        ...(modifiers ? { modifiers } : {}),
      });
    }
    case "hover":
      return withTab({ ref: reqStr(args, "ref", { max: 20 }) });
    case "type":
      return withTab({
        ref: reqStr(args, "ref", { max: 20 }),
        text: reqStr(args, "text", { max: 50_000, allowEmpty: true }),
        submit: optBool(args, "submit", false),
        clear: optBool(args, "clear", true),
      });
    case "press_key": {
      const ref = optStr(args, "ref", 20);
      return withTab({ key: reqStr(args, "key", { max: 60 }), ...(ref ? { ref } : {}) });
    }
    case "select": {
      const values = args.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > 50 || !values.every((v) => typeof v === "string" && v.length <= 500)) {
        throw bad("values 必须是 1–50 个字符串组成的数组");
      }
      return withTab({ ref: reqStr(args, "ref", { max: 20 }), values: [...values] });
    }
    case "scroll":
      // E2·P5a C3：scrollIntoView / untilStable 与 direction / amount 的互斥校验在 scroll-kit.mjs
      return withTab(normalizeScrollArgs(args, OP_HELPERS));
    case "drag":
      return withTab({ fromRef: reqStr(args, "fromRef", { max: 20 }), toRef: reqStr(args, "toRef", { max: 20 }) });
    case "wait_for": {
      const text = optStr(args, "text", 500);
      const textGone = optStr(args, "textGone", 500);
      const timeMs = optNum(args, "timeMs", { min: 0, max: MAX_TIME_WAIT_MS, dflt: undefined });
      // V1 新条件：urlContains（URL 含子串）/ networkIdle（≥500ms 无在途请求）/ refVisible（ref 还在且可见）
      const urlContains = optStr(args, "urlContains", 500);
      const networkIdle = optBool(args, "networkIdle", undefined) === true ? true : undefined; // false 等于没给
      const refVisible = optStr(args, "refVisible", 20);
      const chosen = [text, textGone, timeMs, urlContains, networkIdle, refVisible].filter((v) => v !== undefined).length;
      if (chosen !== 1) throw bad("wait_for 需要且只能指定 text / textGone / timeMs / urlContains / networkIdle / refVisible 其中之一");
      return withTab({
        ...(text !== undefined ? { text } : {}),
        ...(textGone !== undefined ? { textGone } : {}),
        ...(timeMs !== undefined ? { timeMs } : {}),
        ...(urlContains !== undefined ? { urlContains } : {}),
        ...(networkIdle !== undefined ? { networkIdle } : {}),
        ...(refVisible !== undefined ? { refVisible } : {}),
        timeoutMs: optNum(args, "timeoutMs", { min: 500, max: 120_000, dflt: 15_000 }),
      });
    }
    case "tabs": {
      const action = reqEnum(args, "action", ["list", "new", "select", "close"]);
      const url = optStr(args, "url", 8192);
      if ((action === "select" || action === "close") && !tabId) throw bad(`tabs ${action} 需要 tabId`);
      // E2·A6：incognito 只对 new 有意义；其它 action 带了不静默吞掉（AI 会以为切到 / 关的是无痕标签）。false 等于没给
      const incognito = optBool(args, "incognito", undefined);
      if (incognito === true && action !== "new") throw bad("incognito 只能和 action=new 一起用（无痕是新建标签页时的选项）");
      return { action, ...(tabId ? { tabId } : {}), ...(url ? { url } : {}), ...(incognito === true ? { incognito: true } : {}) };
    }
    case "console":
      return withTab({
        level: optEnum(args, "level", ["all", "error", "warning"], "all"),
        limit: optNum(args, "limit", { min: 1, max: 500, dflt: 50 }),
        clear: optBool(args, "clear", false),
        // E2·P7a B3：错误栈经 sourcemap 还原成原始 file:line:col（失败降级为原栈）；没给就不带该字段，老调用方的参数形状不变
        ...(optBool(args, "sourcemap", false) ? { sourcemap: true } : {}),
      });
    case "network":
      // E2·S3 B1：除旧的 filter / limit / clear 外还有 type / status / method / urlRegex / failedOnly / sinceId（net-filter.mjs 规整）
      return withTab(normalizeNetworkArgs(args, OP_HELPERS));
    case "evaluate":
      return withTab({ expression: reqStr(args, "expression", { max: 100_000 }) });
    case "user_activity":
      return {
        markSeen: optBool(args, "markSeen", true),
        limit: optNum(args, "limit", { min: 1, max: 500, dflt: 100 }),
      };
    case "ask_user_to_act":
      return {
        message: reqStr(args, "message", { max: 500 }),
        timeoutMs: optNum(args, "timeoutMs", { min: 1000, max: 6 * 60 * 60 * 1000, dflt: 1_800_000 }),
      };
    case "status":
    case "close_session":
      return {};
    default: {
      // 增强包 E1 的新 op（契约 §14.0）：由 ops/*.mjs 各自校验
      const extra = normalizeExtraOpArgs(op, args, OP_HELPERS);
      if (extra !== undefined) return extra;
      throw bad(`未知的浏览器操作：${String(op).slice(0, 40)}`);
    }
  }
};

/** console 条目过滤：warning 含 error（「至少 warning 级」）。 */
export const filterConsoleEntries = (entries, level) => {
  if (level === "error") return entries.filter((e) => e.level === "error");
  if (level === "warning") return entries.filter((e) => e.level === "error" || e.level === "warning");
  return entries;
};

/** network 条目过滤。 */
export const filterNetworkEntries = (entries, filter) => {
  if (filter === "failed") return entries.filter((e) => e.failed === true);
  if (filter === "xhr") return entries.filter((e) => e.type === "XHR" || e.type === "Fetch");
  return entries;
};

/** 归一空白，文字匹配（wait_for）不被换行 / 多空格干扰。 */
export const normalizeText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** V1 wait_for networkIdle：在途请求数为 0 且持续 ≥500ms 才算空闲；轮询间隔 100ms */
export const NETWORK_IDLE_QUIET_MS = 500;
const NETWORK_IDLE_POLL_MS = 100;

/**
 * 网络空闲判定器（纯函数闭包，可单测）：每次轮询喂入「当前在途请求数」与「当前时间」，返回是否已满足空闲。
 * 在途数一旦 > 0 就重新计时——所以「刚空闲一瞬间又发请求」不会被误判为空闲。
 */
export const createIdleTracker = (quietMs = NETWORK_IDLE_QUIET_MS) => {
  let idleSince = null;
  return (inflight, now) => {
    if (inflight > 0) {
      idleSince = null;
      return false;
    }
    if (idleSince === null) idleSince = now;
    return now - idleSince >= quietMs;
  };
};

// wait_for refVisible 的页内判定（this = 目标元素）：已挂载、有非零布局框、没有 visibility:hidden / display:none。
// 不要求在视口内——「出现」与「滚进视野」是两回事（Playwright 的 visible 同口径）。
const REF_VISIBLE_FN = `function () {
  try {
    if (!this.isConnected) return false;
    if (typeof this.checkVisibility === 'function' && !this.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    var r = this.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    var s = getComputedStyle(this);
    return s.visibility !== 'hidden' && s.display !== 'none';
  } catch (e) { return false; }
}`;

/** 可被 signal 打断的 sleep。 */
const abortableSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** 让一个 promise 能被 signal 打断（底层命令自己会超时，不会泄漏太久）。 */
const abortable = (promise, signal) => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
};

const hostLabel = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80);
  } catch {
    return String(url ?? "").slice(0, 80);
  }
};

/** bounds（CSS 像素）× 主窗口缩放系数（≠1 才乘），再交给 normalizeBounds 取整 / 校验。 */
export const scaleBounds = (bounds, zoomFactor) => {
  const z = typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  if (z === 1 || !bounds || typeof bounds !== "object") return normalizeBounds(bounds);
  return normalizeBounds({ x: bounds.x * z, y: bounds.y * z, width: bounds.width * z, height: bounds.height * z });
};

/** 下载同名自动加序号：`a.pdf` → `a (1).pdf`。exists 注入，便于单测。 */
export const uniqueDownloadPath = (dir, fileName, exists = (p) => fs.existsSync(p)) => {
  const safe = path.basename(String(fileName || "download")).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "download";
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  for (let i = 1; exists(candidate) && i < 1000; i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
};

const emptyState = (taskId) => ({
  taskId,
  exists: false,
  controller: "idle",
  askRequest: null,
  aiLabel: null,
  aiLabelAt: null,
  activeTabId: null,
  tabs: [],
  attached: false,
  covered: false,
  picking: false,
  pendingUserActivity: 0,
  recent: [],
  // 契约 §14.4：主进程总是给默认值（dialog 的真值由 V5 填，downloads 由 V3 填）
  dialog: null,
  downloads: [],
  // 契约 §15.1：增强包 E2 的状态字段，主进程总是给默认值
  prompts: [],
  netRules: null,
  debug: null,
  recording: null,
});

// 无痕标签的内存 partition 名（无 `persist:` 前缀 = 内存；契约 §15 A6）：命名 / 校验 / 引用计数 / 关闭即清空都在 incognito.mjs

const validTaskId = (taskId) => typeof taskId === "string" && taskId !== "" && taskId.length <= MAX_TASK_ID;

// ───────────────────────── 工厂 ─────────────────────────

/**
 * @param {{
 *   app: any, BrowserWindow: any, WebContentsView: any, session: any, ipcMain: any, nativeImage?: any,
 *   getMainWindow: () => any, isAppUrl: (url: string) => boolean, isTrustedIpcSender: (event: any) => boolean,
 *   log?: (msg: string) => void,
 *   startPicker?: Function,
 *   // V4 用户侧（契约 §14.3）：右键菜单要 Menu / clipboard，下载「显示 / 打开」要 shell；缺了对应功能静默不可用
 *   Menu?: any, clipboard?: any, shell?: any,
 * }} deps
 */
export const createBrowserManager = (deps) => {
  const log = deps.log ?? (() => {});
  const startPicker = deps.startPicker ?? defaultStartPicker;

  /** @type {Map<string, BrowserSession>} */
  const sessions = new Map();
  /**
   * 主进程侧配置镜像（server 经 config 消息推送）。契约 §15 的默认值：放开型默认关、收紧型默认开。
   * 主进程**独立**校验这些开关（不只靠 server 工具注册）：server 被攻破 / 老版本也推不出越权能力。
   */
  const config = {
    recordInputValues: false,
    evaluateEnabled: false,
    storageAccess: false,
    pagePermissions: false,
    trustLoopbackCerts: true,
    networkBodyRead: true,
    maxTabs: 20,
  };
  /** 状态贡献者（契约 §15.1）：模块 `host.addStateContributor((session) => ({ netRules: ... }))`，getState 时浅合并 */
  const stateContributors = [];
  /** `browser:ext` 通道的处理器表（契约 §15.1）：name → async (session, ...args) => result。名字白名单，没登记的一律拒绝 */
  const extHandlers = new Map();
  let channel = null;
  let parkingWindow = null;
  /** 已配置完成的 partition 名（契约 §15.1：持久档案 + 每个无痕标签各自的内存 partition）/ 已挂 will-download 的 partition 名 */
  const configuredPartitions = new Set();
  const downloadHookedPartitions = new Set();
  /** partition 配置扩展点：`fn(ses, partitionName)`，每个 partition 配置时（权限 / 下载之后）调用一次；抛错 = 本次配置失败、下次 createTab 重试 */
  const partitionConfigurers = [];
  let ipcRegistered = false;
  /**
   * 本地 HTML 只读静态服务（R7）：点聊天里的 .html 时在内置浏览器里以 `http://<token>.localhost:<端口>/<文件>` 打开（每个 token 一个 origin），不走 file:。
   * 创建本身不监听端口；第一次 open 才起，token 全过期 / 撤销后自己关；destroy 时 revokeAll。
   * 端口不能是 Flowship 自己的端口 / 8676 / 8776 / 8876（`isAppUrl` 判定，随机到了就换）。
   */
  const localHtml = createLocalHtmlServer({
    log,
    isReservedPort: (p) => {
      try {
        return deps.isAppUrl(`http://127.0.0.1:${p}/`) === true;
      } catch {
        return false;
      }
    },
  });
  /** V4 用户侧能力（registerIpc 末尾创建；tab 建好后经 bindTab 挂右键菜单 / 快捷键 / 查找事件） */
  let userFeatures = null;
  let destroyed = false;
  /**
   * 应用正在退出（R1-32 复审）：main.js 在 before-quit 的最终通过里置位、退出被推迟 / 取消时复位。
   * 退出途中会话仍然活着（destroy 在 will-quit），app.quit() 关窗会触发主窗口 closed → detach → moveToParking → getParkingWindow：
   * 此时停车场窗口可能已先被关掉（Windows 逆序关窗），再 new 一个原生窗口就是在退出过程中创建原生对象（与 R1-09 的 SIGTRAP 同类），
   * 还可能让 will-quit 永远来不了。置位后：getParkingWindow 不新建（没有就返回 null）、tab 的 moveToParking(null) 只把视图摘下、不再新建 tab。
   */
  let quitting = false;
  const ipcUnregister = [];
  const stateTimers = new Map();
  const watchedWindows = new WeakSet();

  // ── 窗口 ──

  const liveMainWindow = () => {
    const w = deps.getMainWindow?.() ?? null;
    return w && !w.isDestroyed() ? w : null;
  };

  /** 停车场：隐藏、不进任务栏 / Dock 的窗口，空闲的 view 都挂在它下面（探针 T3：视图必须始终挂在某个窗口上）。 */
  const getParkingWindow = () => {
    if (parkingWindow && !parkingWindow.isDestroyed()) return parkingWindow;
    if (quitting) return null; // 退出途中不新建原生窗口（见 quitting 的注释）
    parkingWindow = new deps.BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: PARKING_BOUNDS.width,
      height: PARKING_BOUNDS.height,
      frame: false,
      focusable: false,
      webPreferences: { backgroundThrottling: false, sandbox: true },
    });
    parkingWindow.on("closed", () => {
      parkingWindow = null;
    });
    return parkingWindow;
  };

  const isParkingWindow = (win) => !!win && !!parkingWindow && win === parkingWindow;

  // ── 状态推送（50ms 节流：窗口内的多次变化合并成一次最新状态） ──

  const sendToRenderer = (channelName, ...payload) => {
    const win = liveMainWindow();
    if (!win || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(channelName, ...payload);
    } catch (err) {
      log(`[browser] 推送 ${channelName} 失败：${err?.message || err}`);
    }
  };

  /**
   * 给状态带上「主窗口是否有焦点」（R1-35）。渲染端 document.hasFocus() 在焦点落进原生视图时为 false，
   * 与「用户在别的 app」无法区分；BrowserWindow.isFocused() 在焦点位于子视图时仍为 true。
   * 只在推送 / 读状态的出口附加，不进 session.getState()（它是纯会话状态，与窗口无关）。
   */
  const withWindowFocus = (state) => {
    let windowFocused = false;
    try {
      const win = liveMainWindow();
      windowFocused = !!win && typeof win.isFocused === "function" && win.isFocused() === true;
    } catch {
      windowFocused = false;
    }
    return { ...state, windowFocused };
  };

  const emitState = (taskId) => {
    const s = sessions.get(taskId);
    sendToRenderer("browser:state", taskId, withWindowFocus(s ? s.getState() : emptyState(taskId)));
  };

  const scheduleState = (taskId) => {
    if (destroyed || stateTimers.has(taskId)) return;
    stateTimers.set(
      taskId,
      setTimeout(() => {
        stateTimers.delete(taskId);
        // 跑在定时器里：这里抛出去就是主进程 uncaughtException（Electron 默认弹错误框，评审 R1-09 真机复现过）。
        // 任何一个 tab 的 wc 在读状态的瞬间被销毁都不能影响主进程：只记日志，下一次变化会再推
        try {
          emitState(taskId);
        } catch (err) {
          log(`[browser] 推送状态失败（已忽略）：${err?.message || err}`);
        }
      }, STATE_DEBOUNCE_MS),
    );
  };

  // ── partition：权限默认拒绝、下载落系统下载目录（只设一次） ──

  const findTabByWebContents = (wc) => {
    for (const s of sessions.values()) {
      for (const t of s.tabs) if (t.wc === wc) return { session: s, tab: t };
    }
    return null;
  };

  /**
   * E2·P1：页面权限闸（A8，permission-gate.mjs）与网络守卫（A4 证书 / A3 认证，net-guard.mjs）。
   * 权限处理器由 ensurePartitionConfigured 在每个 partition 上装一次（持久档案 + 每个无痕 partition）；
   * 守卫的 wc 事件由 host.createTab 在每个 tab 上 bindTab。config 读实时的镜像（用户关掉设置开关立即生效）。
   */
  const permissionGate = createPermissionGate({ findOwner: findTabByWebContents, getConfig: () => config, isAppUrl: deps.isAppUrl, log });
  const netGuard = createNetGuard({ findOwner: findTabByWebContents, getConfig: () => config, isAppUrl: deps.isAppUrl, log });

  /** 下载放行策略的运行态（download-policy.mjs 的纯函数 + 这里的计数）：key = 会话 taskId（找不到 owner 的归 ""） */
  /**
   * key → 在途（progressing）下载的令牌集合。R1-10 复审③：用集合 + 幂等的 track / untrack，而不是单纯的 +1 / -1 计数——
   * 暂停 / interrupted 的下载不触发 done，计数式会泄漏（5 个之后该任务的下载被永久拦）；这里 updated 报告 interrupted / paused 就摘掉，
   * 恢复后再记回；done、会话销毁都会摘（晚到的事件对已摘的令牌无操作，也不会误伤同 taskId 的新会话）。
   */
  const activeDownloads = new Map();
  const activeCountOf = (key) => activeDownloads.get(key)?.size ?? 0;
  const trackActive = (key, token) => {
    let set = activeDownloads.get(key);
    if (!set) activeDownloads.set(key, (set = new Set()));
    set.add(token);
  };
  const untrackActive = (key, token) => {
    const set = activeDownloads.get(key);
    if (!set) return;
    set.delete(token);
    if (set.size === 0) activeDownloads.delete(key);
  };
  /** key → 暂停 / interrupted（可恢复）下载的令牌集合（R3-07 ③：这类下载不占并发名额，但要有独立上限，不能无限累积） */
  const pausedDownloads = new Map();
  const pausedCountOf = (key) => pausedDownloads.get(key)?.size ?? 0;
  const trackPaused = (key, token) => {
    let set = pausedDownloads.get(key);
    if (!set) pausedDownloads.set(key, (set = new Set()));
    set.add(token);
  };
  const untrackPaused = (key, token) => {
    const set = pausedDownloads.get(key);
    if (!set) return;
    set.delete(token);
    if (set.size === 0) pausedDownloads.delete(key);
  };
  const downloadWindow = createDownloadWindow();
  // 节流 key = 「会话|原因」（R3-07 ②）；被吞掉的计数到点 / 会话销毁时补记一条，不会石沉大海
  const blockThrottle = createBlockThrottle({
    onFlush: (throttleKey, suppressed) => {
      const taskId = throttleKey.slice(0, throttleKey.indexOf("|") >= 0 ? throttleKey.indexOf("|") : undefined);
      const text = `此前 ${BLOCK_REPORT_INTERVAL_MS / 1000} 秒内另有 ${suppressed} 次同类拦截未逐条记录`;
      log(`[browser] 下载被拦截：${text}`);
      try {
        sessions.get(taskId)?.activeTab?.hooks?.onDownload?.({ fileName: "download", state: "blocked", reason: text });
        if (taskId) scheduleState(taskId);
      } catch (err) {
        log(`[browser] 下载记录失败：${err?.message || err}`);
      }
    },
  });
  /** 会话销毁（close_session / 管理器销毁）：该会话的下载计数与拦截节流状态一并清掉 */
  const dropDownloadState = (key) => {
    activeDownloads.delete(key);
    pausedDownloads.delete(key);
    blockThrottle.drop(key);
  };

  const onWillDownload = (_event, item, wc) => {
    // owner：下载来自哪个 tab → 它所在的会话持有登记表；找不到（如 session.downloadURL）就只落盘、不登记
    const owner = findTabByWebContents(wc);
    const registry = owner && !owner.session.destroyed ? owner.session.downloads : null;
    const safe = (fn, dflt) => {
      try {
        return fn();
      } catch {
        return dflt;
      }
    };
    const key = owner?.session.taskId ?? "";
    const report = (fileName, state, reason) => {
      try {
        owner?.tab.hooks.onDownload?.({ fileName, state, reason });
      } catch (err) {
        log(`[browser] 下载记录失败：${err?.message || err}`);
      }
    };
    /** 拒绝一个下载：必须显式 cancel——不 setSavePath 也不 cancel 的话 Electron 会弹原生「另存为」对话框，把页面的下载变成用户要处理的弹窗 */
    const refuse = (fileName, reason, code = "other") => {
      safe(() => item.cancel(), undefined);
      // cancel 每次都要做；「记录」按「会话 + 原因」节流（R1-10 复审② / R3-07 ②）：无手势页面循环 a.click() 不能每次都刷日志 / 活动条目 / 推状态，
      // 同时它也不能吞掉用户真点的那次「文件过大」（原因不同，各记各的）
      const th = blockThrottle.hit(`${key}|${code}`);
      if (!th.report) return;
      const text = th.suppressed > 0 ? `${reason}（此前 ${BLOCK_REPORT_INTERVAL_MS / 1000} 秒内另有 ${th.suppressed} 次同类拦截未逐条记录）` : reason;
      log(`[browser] 下载被拦截：${text}`);
      report(fileName, "blocked", text);
      if (owner) scheduleState(owner.session.taskId);
    };

    let fileName = "download";
    let target = "";
    try {
      fileName = path.basename(item.getFilename() || "download");
    } catch {
      /* 取不到文件名：用默认的 */
    }
    // 评审 R1-10：放行策略（用户手势 / 大小 / 并发 / 频率），见 download-policy.mjs
    const hasUserGesture = safe(() => item.hasUserGesture(), undefined);
    // R1-10 复审①：browser_navigate 直达附件 / target=_blank / window.open(下载URL) 引出的下载 hasUserGesture 恒为 false（真机实测），
    // 但它们是我们自己发起的导航；只在 Chromium 报「无手势」时才去问 tab，且命中即消费（一次性）
    const navVerdict =
      hasUserGesture === false && !!owner
        ? safe(() => owner.tab.consumeBrowserInitiatedDownloadVerdict?.(safe(() => item.getURLChain(), []) ?? []), "none")
        : "none";
    const verdict = decideDownload({
      hasUserGesture,
      browserInitiated: navVerdict === "hit",
      navExpired: navVerdict === "expired",
      totalBytes: safe(() => item.getTotalBytes(), 0),
      activeCount: activeCountOf(key),
      recentCount: downloadWindow.count(key),
    });
    if (!verdict.allow) {
      refuse(fileName, verdict.reason, verdict.code);
      return;
    }
    try {
      // 落点永远是固定的系统下载目录：文件名只取 basename 并清洗，路径不由页面决定
      const dir = deps.app.getPath("downloads");
      // 并发同名下载：前一个还没在磁盘上落文件，要靠登记表避开它在途的路径
      target = uniqueDownloadPath(dir, fileName, (p) => fs.existsSync(p) || (registry?.hasPath(p) ?? false));
      item.setSavePath(target);
      fileName = path.basename(target);
    } catch (err) {
      log(`[browser] 下载路径设置失败：${err?.message || err}`);
      refuse(fileName, "无法确定保存位置", "no-path");
      return;
    }
    downloadWindow.record(key);
    const token = {};
    let finished = false;
    trackActive(key, token);
    const taskId = owner?.session.taskId;
    const touch = () => {
      if (taskId) scheduleState(taskId);
    };
    const rec =
      registry?.addStarted({
        fileName,
        path: target,
        url: safe(() => item.getURL(), ""),
        totalBytes: safe(() => item.getTotalBytes(), 0),
        tabId: owner?.tab.id,
      }) ?? null;
    report(fileName, "started");
    touch();
    // updated：进度（Electron 的 interrupted 可能随后恢复，不当终态；终态只认 done）
    item.on("updated", () => {
      // 暂停 / interrupted 的下载不算「在途」（不占并发名额）；恢复后记回。已 done / 会话已销毁的不再记（晚到事件）
      if (!finished && !(owner && owner.session.destroyed)) {
        const paused = safe(() => item.isPaused(), false) === true || safe(() => item.getState(), "progressing") === "interrupted";
        if (paused) {
          untrackActive(key, token);
          // 暂停 / interrupted 的下载不占并发名额，但有独立上限（R3-07 ③）：恶意服务端让下载立刻 interrupted 也不能无限累积
          if (!pausedDownloads.get(key)?.has(token) && pausedCountOf(key) >= MAX_PAUSED_DOWNLOADS) {
            safe(() => item.cancel(), undefined);
            return;
          }
          trackPaused(key, token);
        } else {
          untrackPaused(key, token);
          // 恢复：重新记回在途，但要复核并发上限（R3-07 ③：此前无条件记回，interrupted 项恢复后可以越过上限）
          if (!activeDownloads.get(key)?.has(token) && activeCountOf(key) >= MAX_ACTIVE_DOWNLOADS) {
            safe(() => item.cancel(), undefined);
            return;
          }
          trackActive(key, token);
        }
      }
      const received = safe(() => item.getReceivedBytes(), 0);
      // 声明大小为 0（未知）的流式下载：按已收字节兜底，超上限就掐掉（cancel 之后 done 会以 cancelled 收尾）
      if (exceedsSizeCap(received)) {
        safe(() => item.cancel(), undefined);
        return;
      }
      if (!rec) return;
      registry.update(rec.id, {
        receivedBytes: received,
        totalBytes: safe(() => item.getTotalBytes(), 0),
      });
      touch();
    });
    item.once("done", (_e, state) => {
      finished = true;
      untrackActive(key, token);
      untrackPaused(key, token);
      if (rec) {
        registry.finish(rec.id, state, {
          receivedBytes: safe(() => item.getReceivedBytes(), 0),
          totalBytes: safe(() => item.getTotalBytes(), 0),
        });
      }
      report(fileName, state);
      touch();
    });
  };

  /**
   * partition 级一次性配置：权限默认拒绝、设备权限拒绝、下载落系统下载目录。
   * 评审 R1-32：configuredPartitions 必须在**全部配置成功之后**才登记——此前先置位再配置，中途抛错会让后面的权限 / 下载处理永远没装上，
   * 而且再也不会重试（页面从此能拿到默认放行的权限）。will-download 监听单独记一个标志，重试时不重复挂。
   */
  const ensurePartitionConfigured = (name = BROWSER_PARTITION) => {
    if (configuredPartitions.has(name)) return;
    // partition 名只能是持久档案或无痕标签的内存 partition（契约 §15 A6）；不能由页面 / AI 的字符串决定
    if (name !== BROWSER_PARTITION && !INCOGNITO_PARTITION_RE.test(String(name))) {
      throw new BrowserError("INTERNAL", "非法的 partition 名");
    }
    const ses = deps.session.fromPartition(name);
    // 下载守卫（R1-10，安全相关）最先装：后面任何一步抛错都不该让它缺席；重试时靠 downloadHookedPartitions 避免重复挂
    if (!downloadHookedPartitions.has(name)) {
      downloadHookedPartitions.add(name);
      ses.on("will-download", onWillDownload);
    }
    // E2·P1（A8）：权限决策交给 permission-gate（permission-policy 的纯决策 + 用户提示 + 定位模拟自动授权 + 通知代理）。
    // 安全底线不变：屏幕共享 / USB / HID / 串口 / openExternal … 永远拒绝；找不到所属 tab / 会话、未知权限名、不透明来源一律拒绝；
    // 摄像头 / 麦克风与定位等一样归「询问」（麦克风与摄像头是两个独立授予）：用户在提示条里点允许，或设置开关打开后由 AI 授予，
    // 其余（无人处理 / 跨源子框架）拒绝；只直接放行「页面写剪贴板」「选择扬声器」这类无隐私面的（口径见 permission-policy.mjs 头注释）。
    // 请求 / 检查两个处理器只装这一次（R1-32 的「失败重试」语义不变：任何一步抛错都不登记 configuredPartitions）
    ses.setPermissionRequestHandler(permissionGate.handleRequest);
    if (typeof ses.setPermissionCheckHandler === "function") ses.setPermissionCheckHandler(permissionGate.handleCheck);
    // WebUSB / WebHID / WebSerial 等设备类权限走另一条通道（setPermission*Handler 不管它们）：一律不授予
    if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
    for (const fn of partitionConfigurers) fn(ses, name);
    configuredPartitions.add(name);
  };

  // ── 会话 ──

  const emitEvent = (name, taskId, data) => (channel ? channel.sendEvent(name, taskId, data) : false);

  /**
   * E2·A6 无痕标签：每个无痕 partition 是一个独立的内存 session（不共享持久档案的 cookie / localStorage …）。
   * Electron 没有销毁 session 的 API，「关标签即销毁」= 最后一个用它的 tab 销毁后清空全部存储 + HTTP 缓存 + 认证缓存，再回收名字复用（见 incognito.mjs）。
   * 弹窗继承 opener 的 partition，所以引用计数——先关弹窗不会把还开着的无痕标签的登录态清掉。
   * 刻意只清 `deps.session.fromPartition(name)` 这一个 partition：持久档案（BROWSER_PARTITION）不受影响，反过来 browser:clearBrowsingData 也只清持久档案。
   */
  /** R6-10 / R6-22：无痕 partition 被 wipe 后，通知所有存活会话里的决策表（各模块 ext 实现 `onPartitionWiped(partition)`） */
  const broadcastPartitionWiped = (name) => {
    for (const s of sessions.values()) {
      for (const v of s.ext?.values?.() ?? []) {
        try {
          v?.onPartitionWiped?.(name);
        } catch (err) {
          log(`[browser] 无痕 wipe 的扩展回调出错（已忽略）：${err?.message || err}`);
        }
      }
    }
  };

  /**
   * R6-10 / R6-11：任务（browser session）结束时的持久 partition 网络清理——认证缓存必清、有证书例外则断开已建立的连接。
   * 必须在 `session.destroy()` 之前调（要先读到证书例外表，destroy 会 dispose 它）；异步部分不阻塞销毁、永不抛。
   */
  const releaseSessionNetState = (s) => {
    try {
      const ses = deps.session?.fromPartition?.(BROWSER_PARTITION);
      void releaseSessionNetwork({ netState: peekNetGuardState(s), ses, partition: BROWSER_PARTITION, log });
    } catch (err) {
      log(`[browser] 会话结束的网络清理出错（已忽略）：${err?.message || err}`);
    }
  };

  const incognito = createIncognitoManager({
    wipe: async (name) => {
      await wipeIncognitoSession(deps.session.fromPartition(name), log);
      // R6-10 / R6-22：该 partition 的决策表记录（证书例外 / 无痕授予）随 wipe 作废——名字回收复用时下一个无痕标签不能继承
      broadcastPartitionWiped(name);
    },
    log,
  });

  const host = {
    createTab: ({ id, hooks, partition = BROWSER_PARTITION, adopt }) => {
      if (quitting) throw new BrowserError("NO_SESSION", "应用正在退出，无法新建标签页");
      ensurePartitionConfigured(partition);
      const isIncognito = isIncognitoPartition(partition);
      let tab;
      try {
        tab = new BrowserTab({
          id,
          WebContentsView: deps.WebContentsView,
          parkingWindow: getParkingWindow(),
          pageScripts,
          isAppUrl: deps.isAppUrl,
          hooks,
          nativeImage: deps.nativeImage,
          log,
          recordValues: config.recordInputValues,
          partition,
          // E2·A2：收养 Chromium 已建好的弹窗 webContents（见 session.openPopupTab）
          ...(adopt ? { adopt } : {}),
        });
      } catch (err) {
        // 分配了无痕名字却没建成 tab：名字放回池里（弹窗继承的名字有 opener 在引用，abandon 对它是空操作）
        if (isIncognito) incognito.abandon(partition);
        throw err;
      }
      if (isIncognito) {
        incognito.retain(partition);
        // destroyHooks 在 #teardown 里跑，覆盖所有销毁路径（closeTab / 页面 window.close() / 渲染进程被回收 / 会话销毁）。
        // 但 wc.close() 是异步的：钩子跑的时候渲染进程可能还活着（pagehide / unload 里还能写 localStorage / cookie），此刻就清空会被它的最后一笔写入「污染」，
        // 复用池再把这个名字发给下一个无痕标签就等于泄漏了上一个标签的数据——所以等 wc 真正 destroyed 再释放引用（一次性：只释放这个 tab 的那一份计数）。
        const wc = tab.wc;
        let released = false;
        const releaseOnce = () => {
          if (released) return;
          released = true;
          void incognito.release(partition);
        };
        tab.addDestroyHook(() => {
          let gone = true;
          try {
            gone = typeof wc?.isDestroyed === "function" ? wc.isDestroyed() === true : true;
          } catch {
            gone = true;
          }
          if (gone || typeof wc?.once !== "function") releaseOnce();
          else wc.once("destroyed", releaseOnce);
        });
      }
      // V4：右键菜单 / Cmd+±0F / found-in-page 都挂在 wc 上（registerIpc 之前建的 tab 没有，属于单测 / 脚本场景）
      userFeatures?.bindTab(tab);
      // E2·P1：证书 / 认证 / 客户端证书事件（net-guard）与页面权限的 tab 级绑定（permission-gate：定位模拟 origin、导航时作废提示）
      netGuard.bindTab(tab);
      permissionGate.bindTab(tab);
      return tab;
    },
    // E2·A6：无痕 partition 的分配（复用池 / 唯一命名）；session.openTab({ incognito }) 调
    allocateIncognitoPartition: ({ taskId, tabId }) => incognito.allocate({ taskId, tabId }),
    getMainWindow: liveMainWindow,
    getParkingWindow,
    onChange: scheduleState,
    emitEvent,
    // A7：evaluate 总闸是否开着（ensureEvaluateApproval 据此直接放行；debug 工具复用同一函数）
    isEvaluateEnabled: () => config.evaluateEnabled === true,
    emitPicked: (taskId, picked) => sendToRenderer("browser:picked", taskId, picked),
    startPicker: (tab, cb) => startPicker(tab, cb),
    stateContributors,
    getMaxTabs: () => config.maxTabs,
  };

  /**
   * 取会话，没有就懒创建。initialTab：顺带开一个空白 tab（tabs(new) 自己会开 tab，所以传 false，避免多一个空白页）。
   * 创建过程全同步（session.openTab 的 createTab 在第一个 await 之前就完成），并发请求不会重复建。
   */
  const ensureSession = (taskId, { initialTab = true } = {}) => {
    if (destroyed) throw new BrowserError("NO_SESSION", "浏览器已关闭");
    let s = sessions.get(taskId);
    if (s && !s.destroyed) return s;
    s = new BrowserSession({
      taskId,
      host,
      activityLog: createActivityLog({ recordInputValues: config.recordInputValues }),
      log,
    });
    sessions.set(taskId, s);
    if (initialTab) {
      void s.openTab({ activate: true }).catch((err) => log(`[browser] 初始标签页创建失败：${err?.message || err}`));
    }
    scheduleState(taskId);
    return s;
  };

  const requireSession = (taskId) => {
    const s = sessions.get(taskId);
    if (!s || s.destroyed) throw new BrowserError("NO_SESSION", NO_SESSION_MESSAGE);
    return s;
  };

  const destroySession = (taskId) => {
    const s = sessions.get(taskId);
    if (!s) return false;
    sessions.delete(taskId);
    dropDownloadState(taskId);
    releaseSessionNetState(s);
    try {
      s.destroy();
    } catch (err) {
      log(`[browser] 会话销毁异常：${err?.message || err}`);
    }
    scheduleState(taskId);
    return true;
  };

  // ── op 实现 ──

  const checkAiUrl = (url) => {
    const verdict = checkUrl(normalizeAiUrl(url), { isAppUrl: deps.isAppUrl });
    if (!verdict.ok) throw new BrowserError("URL_BLOCKED", `该地址不允许访问：${verdict.reason}`);
    return verdict.url;
  };

  /**
   * E2·P1（A4）：本 tab 当前页面是在「证书错误被放行」的情况下加载的（本机 / 自签名信任，或用户在提示条里放行）：
   * 结果带 `certOverride { host, error, source }`，server 渲染成固定一行「证书错误已被放行（自签名 / 本机）」，AI 不会把这当成一个正常的 https 站点。
   * 没有就不带字段（既有结果形状不变）。
   */
  const certOverrideField = (tab) => {
    const o = tab?.certOverride;
    if (!o) return {};
    return { certOverride: { host: o.host, error: o.error, source: o.source } };
  };

  const opNavigate = async (taskId, a, signal) => {
    const url = checkAiUrl(a.url); // 先校验再建会话：被拦的地址不该白开一个 view
    const session = ensureSession(taskId);
    return session.runAction({ op: "navigate", tabId: a.tabId, signal }, async (ctx) => {
      ctx.describe({ kind: "navigate", summary: `打开了页面：${hostLabel(url)}`, label: `打开 ${hostLabel(url)}` });
      const r = await ctx.tab.navigate(url, { timeoutMs: a.timeoutMs, signal: ctx.signal });
      return { tabId: ctx.tab.id, url: r.url, title: r.title, status: r.status, ...certOverrideField(ctx.tab) };
    });
  };

  const opNavHistory = (taskId, a, signal) => {
    const session = requireSession(taskId);
    const zh = { back: "后退", forward: "前进", reload: "刷新" }[a.direction];
    return session.runAction({ op: "nav_history", tabId: a.tabId, signal }, async (ctx) => {
      ctx.describe({ kind: "navigate", summary: `${zh}了页面`, label: zh });
      const r = await ctx.tab.history(a.direction, { timeoutMs: a.timeoutMs, signal: ctx.signal });
      return { tabId: ctx.tab.id, url: r.url, title: r.title, ...certOverrideField(ctx.tab) };
    });
  };

  const opSnapshot = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    const tab = session.getTab(a.tabId);
    const r = await abortable(tab.snapshot({ maxChars: a.maxChars, maxElements: a.maxElements, viewportOnly: a.viewportOnly, query: a.query }), signal);
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      text: r.text,
      refCount: r.refCount,
      truncated: r.truncated,
      tabs: session.listTabs(),
      scroll: r.scroll,
    };
  };

  const opScreenshot = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    const tab = session.getTab(a.tabId);
    const r = await abortable(
      tab.screenshot({
        fullPage: a.fullPage,
        ref: a.ref,
        format: a.format,
        quality: a.quality,
        maxWidth: a.maxWidth,
        // E2·P5a：新参数只在给了才带，老调用方（含 save 的 png 截图）的调用形状不变
        ...(a.clip ? { clip: a.clip } : {}),
        ...(a.scale !== undefined ? { scale: a.scale } : {}),
        ...(a.omitBackground ? { omitBackground: true } : {}),
        ...(a.annotate ? { annotate: true } : {}),
      }),
      signal,
    );
    return { tabId: tab.id, ...r };
  };

  /**
   * V1 的三个新等待条件（urlContains / networkIdle / refVisible）：轮询实现，与 text 条件同样可被 signal 打断。
   * 超时返回 matched:false（不抛），与原有条件一致。
   */
  const waitForCondition = async (session, tab, a, signal, started) => {
    const elapsed = () => Date.now() - started;
    const deadline = started + a.timeoutMs;
    const idle = a.networkIdle === true ? createIdleTracker() : null;
    if (a.refVisible !== undefined) await abortable(tab.ensureCdp(), signal);
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (session.destroyed) throw new BrowserError("CANCELLED", "浏览器会话已关闭");
      let ok = false;
      if (a.urlContains !== undefined) {
        ok = String(tab.url).includes(a.urlContains);
      } else if (idle) {
        ok = idle(tab.inflightRequestCount, Date.now());
      } else {
        // ref 本身失效（导航 / 重新 snapshot）会在 resolveRef 抛 REF_STALE / REF_NOT_FOUND——等下去也不会好，直接让 AI 重新 snapshot
        const entry = tab.resolveRef(a.refVisible);
        try {
          ok = (await abortable(actions.callOnNode(tab, entry, a.refVisible, REF_VISIBLE_FN), signal)) === true;
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          // 元素暂时不在 DOM / 没有布局：算「还不可见」继续等；其它错误（含 CANCELLED）照常抛
          if (!(err instanceof BrowserError) || (err.code !== "REF_STALE" && err.code !== "NOT_INTERACTABLE")) throw err;
        }
      }
      if (ok) return { matched: true, elapsedMs: elapsed() };
      if (Date.now() >= deadline) return { matched: false, elapsedMs: elapsed() };
      await abortableSleep(Math.min(idle ? NETWORK_IDLE_POLL_MS : WAIT_POLL_MS, Math.max(30, deadline - Date.now())), signal);
    }
  };

  const opWaitFor = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    if (a.timeMs !== undefined) {
      await abortableSleep(a.timeMs, signal);
      return { matched: true, elapsedMs: elapsed() };
    }
    const tab = session.getTab(a.tabId);
    if (a.urlContains !== undefined || a.networkIdle === true || a.refVisible !== undefined) {
      return waitForCondition(session, tab, a, signal, started);
    }
    const needle = normalizeText(a.text ?? a.textGone);
    const wantPresent = a.text !== undefined;
    const deadline = started + a.timeoutMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (session.destroyed) throw new BrowserError("CANCELLED", "浏览器会话已关闭");
      let present = false;
      try {
        present = normalizeText(await abortable(tab.pageText(), signal)).includes(needle);
      } catch (err) {
        if (err instanceof BrowserError && (err.code === "CANCELLED" || err.code === "TAB_NOT_FOUND")) throw err;
        if (signal?.aborted) throw signal.reason;
        // 页面正在导航 / 换进程时取文字会瞬时失败：当作「这一轮没取到」继续轮询
      }
      if (present === wantPresent) return { matched: true, elapsedMs: elapsed() };
      if (Date.now() >= deadline) return { matched: false, elapsedMs: elapsed() };
      await abortableSleep(Math.min(WAIT_POLL_MS, Math.max(50, deadline - Date.now())), signal);
    }
  };

  const tabsResult = (session) => ({ tabs: session.listTabs(), activeTabId: session.activeTabId });

  const opTabs = async (taskId, a, signal) => {
    if (a.action === "list") return tabsResult(requireSession(taskId));
    if (a.action === "new") {
      const url = a.url ? checkAiUrl(a.url) : null;
      const session = ensureSession(taskId, { initialTab: false });
      // E2·A6：incognito → 独立内存 partition 的无痕标签（同样占 tab 上限的名额）
      const wantIncognito = a.incognito === true;
      const what = wantIncognito ? "无痕标签页" : "标签页";
      return session.runAction({ op: "tabs", needsTab: false, signal }, async (ctx) => {
        ctx.describe({ kind: "tab_open", summary: url ? `新建了${what}：${hostLabel(url)}` : `新建了${what}`, label: wantIncognito ? "新建无痕标签页" : "新建标签页" });
        const tab = await session.openTab({ activate: true, ...(wantIncognito ? { incognito: true } : {}) });
        // url 不交给 openTab（它是 fire-and-forget）：这里自己等导航，失败要让 AI 知道
        if (url) await tab.navigate(url, { signal: ctx.signal });
        return tabsResult(session);
      });
    }
    const session = requireSession(taskId);
    if (a.action === "select") {
      return session.runAction({ op: "tabs", needsTab: false, signal }, async (ctx) => {
        ctx.describe({ label: "切换标签页" });
        session.selectTab(a.tabId);
        return tabsResult(session);
      });
    }
    return session.runAction({ op: "tabs", needsTab: false, signal }, async (ctx) => {
      ctx.describe({ kind: "tab_close", summary: `关闭了标签页 ${a.tabId}`, label: "关闭标签页" });
      await session.closeTab(a.tabId);
      return tabsResult(session);
    });
  };

  const opConsole = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    const tab = session.getTab(a.tabId);
    const ring = tab.consoleRing;
    let entries = filterConsoleEntries(ring.list(), a.level).slice(-a.limit);
    const dropped = ring.dropped;
    if (a.clear) ring.clear();
    // E2·P7a B3：条目里的结构化栈（stack）只在 sourcemap:true 时才出站，默认结果形状不变
    if (a.sourcemap === true && typeof extraHandlers._resolveConsoleStacks === "function") {
      // R6-16：signal 接任务取消；activity 写一条脱敏活动日志（「已取 N 张 sourcemap（跳过 M）」，入口统一脱敏）
      const r = await extraHandlers._resolveConsoleStacks(tab, entries, {
        signal,
        activity: (summary) => session.activityLog.addAI({ kind: "select", tabId: tab.id, url: tab.url, summary }),
      });
      return { entries: r.entries, dropped, sourcemap: { resolvedFrames: r.resolvedFrames, ...(r.note ? { note: r.note } : {}) } };
    }
    if (entries.some((e) => e.stack !== undefined)) {
      entries = entries.map((e) => {
        if (e.stack === undefined) return e;
        const copy = { ...e };
        delete copy.stack;
        return copy;
      });
    }
    return { entries, dropped };
  };

  const opNetwork = async (taskId, a) => {
    const tab = requireSession(taskId).getTab(a.tabId);
    const ring = tab.networkRing;
    // 先补录 CDP 没推送的早期子资源（失败静默、假 tab 没有该方法就跳过），再读环
    if (typeof tab.backfillResourceTiming === "function") await tab.backfillResourceTiming().catch(() => 0);
    // E2·S3 B1：新过滤参数（type / status / method / urlRegex / failedOnly / sinceId）；url_regex 对**脱敏后**的 URL 匹配、带 vm 超时
    let picked;
    try {
      picked = selectNetworkEntries(ring.list(), a, { redactUrl: redactUrlSecrets });
    } catch (err) {
      if (err instanceof NetFilterError) throw bad(err.message);
      throw err;
    }
    const entries = picked.entries;
    const dropped = ring.dropped;
    // V2：条目自带 id（tab 在 flush 时分配）；clear 要同时清详情暂存表（假 tab 没有 clearNetwork 时退回只清环）
    if (a.clear) {
      if (typeof tab.clearNetwork === "function") tab.clearNetwork();
      else ring.clear();
    }
    // R1-26：列表里的 url 也要脱敏（?code= / ?token= / userinfo / fragment 令牌）——network_detail 已经过 redactUrlSecrets，这里是另一条出口
    // E2·S3：initiator 里的 URL 采集时已脱敏，这里再过一遍（幂等）
    return {
      entries: entries.map((e) => ({
        ...e,
        url: redactUrlSecrets(e.url),
        ...(e.initiator ? { initiator: { ...e.initiator, stack: e.initiator.stack.map((s) => redactUrlSecrets(s)) } } : {}),
      })),
      dropped,
      matched: picked.matched,
      hasMore: picked.hasMore,
      lastId: picked.lastId,
    };
  };

  const opEvaluate = async (taskId, a, signal) => {
    // A7：总闸开着 → 直接执行；没开 → 弹审批卡（仅本任务 / 永久开启 / 拒绝），批准才执行（会话级标记，见 evaluate-approval.mjs）。
    // 不再因开关关着就直接 DISABLED：用户可以当场授权，拒绝 / 超时 / 取消才是 DENIED。会话必须已存在（不为 evaluate 新建会话）
    const session = requireSession(taskId);
    const tab = session.getTab(a.tabId);
    // R6-04：用户接管期间不弹审批卡（弹了他也不该替 AI 批）；批准之后在 runApprovedEvaluate 里再查一次、写活动日志、可被接管打断
    assertEvaluateNotUserControlled(session);
    // timeoutMs 只给 e2e 缩短（deps.evaluatePromptTimeoutMs）；生产不传 → 用 evaluate-approval 的默认 120s
    const { via } = await ensureEvaluateApproval(session, {
      summary: a.expression,
      signal,
      tabId: tab.id,
      host: hostLabel(tab.url),
      ...(Number.isFinite(deps.evaluatePromptTimeoutMs) && deps.evaluatePromptTimeoutMs > 0 ? { timeoutMs: deps.evaluatePromptTimeoutMs } : {}),
    });
    return runApprovedEvaluate(session, tab, { expression: a.expression, via, signal, abortable });
  };

  const opUserActivity = (taskId, a) => {
    const session = requireSession(taskId);
    const log2 = session.activityLog;
    const all = log2.unseenUserEntries();
    const entries = all.slice(-a.limit).map((e) => ({ ...e }));
    if (a.markSeen) log2.markSeen();
    return { entries, pendingCount: log2.pendingCount(), controller: session.controller };
  };

  const opAsk = (taskId, a, signal) => {
    const session = ensureSession(taskId);
    return session.askUserToAct({ message: a.message, timeoutMs: a.timeoutMs, signal });
  };

  const opStatus = (taskId) => {
    const s = sessions.get(taskId);
    if (!s || s.destroyed) return { exists: false, controller: "idle", activeTabId: null, url: null, title: null, pendingCount: 0 };
    const tab = s.activeTab;
    return {
      exists: true,
      controller: s.controller,
      activeTabId: s.activeTabId,
      url: tab ? tab.url : null,
      title: tab ? tab.title : null,
      pendingCount: s.activityLog.pendingCount(),
    };
  };

  const opCloseSession = (taskId) => {
    const existed = destroySession(taskId);
    if (existed) emitEvent("session_closed", taskId, {});
    return { closed: existed };
  };

  /** 增强包 E1 的新 op 处理器（契约 §14.0）：{ [op]: async (taskId, args, signal) => result } */
  const extraHandlers = createExtraHandlers({
    app: deps.app,
    shell: deps.shell,
    log,
    getConfig: () => config,
    requireSession,
    getSession: (taskId) => sessions.get(taskId),
    ensureSession,
    actions,
    helpers: OP_HELPERS,
    abortable,
    abortableSleep,
    normalizeText,
    hostLabel,
    checkAiUrl,
    scheduleState,
    emitEvent,
    // 契约 §15.1：E2 各模块的公共依赖
    electron: deps,
    partitionSession: (name = BROWSER_PARTITION) => deps.session.fromPartition(name),
    ensurePartitionConfigured,
    addPartitionConfigurer: (fn) => {
      partitionConfigurers.push(fn);
      // 已经配置过的 partition 也要补一次（模块在 createBrowserManager 之后才注册的情况）
      for (const name of configuredPartitions) {
        try {
          fn(deps.session.fromPartition(name), name);
        } catch (err) {
          log(`[browser] partition 配置扩展出错（已忽略）：${err?.message || err}`);
        }
      }
    },
    findTabByWebContents,
    // E2·P1：ops/permissions.mjs 用它预装通知代理、读「定位模拟生效的 origin」
    permissionGate,
    addStateContributor: (fn) => {
      stateContributors.push(fn);
      return () => {
        const i = stateContributors.indexOf(fn);
        if (i >= 0) stateContributors.splice(i, 1);
      };
    },
    registerExt: (name, fn) => {
      extHandlers.set(String(name), fn);
      return () => extHandlers.delete(String(name));
    },
    sessions: () => [...sessions.values()],
  });

  /**
   * 分发一个 op。通道层（server-channel）负责把异常转 `res ok:false`；这里只管校验、路由、懒创建规则。
   * @param {string} op
   * @param {object} rawArgs
   * @param {{ taskId: string, signal?: AbortSignal }} ctx
   */
  const dispatch = async (op, rawArgs, ctx = {}) => {
    const result = await dispatchOp(op, rawArgs, ctx);
    // 契约 §15.1：会话里有等待用户处理的提示（HTTP 认证 / 证书 / 权限 / evaluate 授权）时，每个 op 的结果都带上 `pendingPrompts`
    // （只有 id / kind / host / tabId，不含 detail 与任何回答内容）——server 的 run() 据此给 AI 写一句「已请用户处理」，AI 不会傻等 / 重试
    const sess = validTaskId(ctx?.taskId) ? sessions.get(ctx.taskId) : undefined;
    if (sess && !sess.destroyed && sess.prompts.size() > 0 && result && typeof result === "object" && !Array.isArray(result)) {
      return { ...result, pendingPrompts: sess.prompts.hints() };
    }
    return result;
  };

  const dispatchOp = async (op, rawArgs, { taskId, signal } = {}) => {
    if (!validTaskId(taskId)) throw bad("缺少合法的 taskId");
    if (!ALL_OPS.includes(op)) throw bad(`未知的浏览器操作：${String(op).slice(0, 40)}`);
    const a = normalizeOpArgs(op, rawArgs);
    // E2·B5：页面被调试器暂停（主线程冻结）时，需要渲染进程响应的 op 在入口快速失败，不进队列、不发 CDP（放行表见 debug-policy.mjs）
    {
      const pausedSession = sessions.get(taskId);
      if (pausedSession && !pausedSession.destroyed) debugPauseGate(pausedSession, op, a);
    }
    switch (op) {
      case "navigate":
        return opNavigate(taskId, a, signal);
      case "nav_history":
        return opNavHistory(taskId, a, signal);
      case "snapshot":
        return opSnapshot(taskId, a, signal);
      case "screenshot":
        return opScreenshot(taskId, a, signal);
      case "click":
        return actions.click(requireSession(taskId), a, { signal });
      case "hover":
        return actions.hover(requireSession(taskId), a, { signal });
      case "type":
        return actions.type(requireSession(taskId), a, { signal });
      case "press_key":
        // R6-07：粘贴键要核对系统剪贴板（主进程 clipboard.readText，只在比较哈希时读一次）
        return actions.pressKey(requireSession(taskId), a, { signal, clipboard: deps.clipboard });
      case "select":
        return actions.select(requireSession(taskId), a, { signal });
      case "scroll":
        return actions.scroll(requireSession(taskId), a, { signal });
      case "drag":
        return actions.drag(requireSession(taskId), a, { signal });
      case "wait_for":
        return opWaitFor(taskId, a, signal);
      case "tabs":
        return opTabs(taskId, a, signal);
      case "console":
        return opConsole(taskId, a, signal);
      case "network":
        return opNetwork(taskId, a);
      case "evaluate":
        return opEvaluate(taskId, a, signal);
      case "user_activity":
        return opUserActivity(taskId, a);
      case "ask_user_to_act":
        return opAsk(taskId, a, signal);
      case "status":
        return opStatus(taskId);
      case "close_session":
        return opCloseSession(taskId);
      default: {
        const handler = extraHandlers[op];
        if (typeof handler === "function") return handler(taskId, a, signal);
        throw bad(`未知的浏览器操作：${String(op).slice(0, 40)}`);
      }
    }
  };

  // ── config / cancel ──

  /**
   * R6-42：`trustLoopbackCerts` 开→关时，断开「放行过证书错误」的 partition 上已建立的连接。
   * 开关只影响**之后**的 certificate-error 决策；此前放行（loopback 自动放行 / 用户放行）建立的连接会被 Chromium 复用，不再触发 certificate-error，
   * 用户关掉「信任本机证书」后这些连接却还活着。只处理 net-guard 里确有放行记录的 partition（没放行过就没有「被放行的坏证书连接」，别无故打断加载 / 下载）；
   * 持久与无痕 partition 都覆盖（`certExceptionPartitions` 返回的是 partition 名）。同步收集、异步断连（`closeConnectionsSafe` 永不 reject）；任何一步出错只记日志。
   */
  const dropCertAllowedConnections = (why) => {
    try {
      const partitions = new Set();
      for (const s of sessions.values()) {
        try {
          for (const p of peekNetGuardState(s)?.certExceptionPartitions?.() ?? []) partitions.add(p);
        } catch (err) {
          log(`[browser] ${why}：读取证书例外记录失败（已忽略）：${err?.message || err}`);
        }
      }
      for (const p of partitions) {
        try {
          void closeConnectionsSafe(deps.session?.fromPartition?.(p), log, why);
        } catch (err) {
          log(`[browser] ${why}：断开 ${p} 的连接失败（已忽略）：${err?.message || err}`);
        }
      }
    } catch (err) {
      log(`[browser] ${why}：处理异常（已忽略）：${err?.message || err}`);
    }
  };

  const onConfig = (cfg) => {
    if (typeof cfg?.evaluateEnabled === "boolean") {
      // R6-04：总闸从开变关 = 用户收回授权意图，各会话「仅本任务」的批准一并作废（之后的脚本重新弹审批卡）。
      // R6-31：同一入口还会联动清掉各会话里「需审批类型」的 mock 规则（总闸开着时创建的也算；reason 让活动日志写明是总闸被关）
      const gateOff = config.evaluateEnabled === true && cfg.evaluateEnabled === false;
      // R6-42：**先赋值、后撤销**（fail-closed）——撤销链上将来一旦抛错，总闸也不会停在 true。
      // 撤销回调同步段只摘规则 / 写日志、不读 config.evaluateEnabled；依赖总闸的 isEvaluateAuthorized 只在请求暂停时才用，此时早已是新值——先赋值不改变它们的行为
      config.evaluateEnabled = cfg.evaluateEnabled;
      if (gateOff) {
        // 逐会话隔离：一个会话撤销抛错不影响其它会话
        for (const s of sessions.values()) {
          try {
            revokeEvaluateApproval(s, { reason: "gate-off" });
          } catch (err) {
            log(`[browser] 总闸关闭：撤销会话 ${s?.taskId ?? "?"} 的 evaluate 批准失败（已忽略）：${err?.message || err}`);
          }
        }
      }
    }
    const trustLoopbackWas = config.trustLoopbackCerts === true;
    for (const k of ["storageAccess", "pagePermissions", "trustLoopbackCerts", "networkBodyRead"]) {
      if (typeof cfg?.[k] === "boolean") config[k] = cfg[k];
    }
    // R6-42：只在 true→false 时断连（false→true / 值不变 / 没带这个键都不动）；放在赋值之后——断连后的重连一定按新开关走「询问」
    if (trustLoopbackWas && config.trustLoopbackCerts === false) dropCertAllowedConnections("关闭「信任本机证书」");
    if (Number.isInteger(cfg?.maxTabs) && cfg.maxTabs >= 5 && cfg.maxTabs <= 60) config.maxTabs = cfg.maxTabs;
    if (typeof cfg?.recordInputValues === "boolean" && cfg.recordInputValues !== config.recordInputValues) {
      config.recordInputValues = cfg.recordInputValues;
      for (const s of sessions.values()) {
        s.activityLog.setRecordInputValues(config.recordInputValues);
        for (const t of s.tabs) void t.setRecordValues(config.recordInputValues).catch(() => {});
      }
    }
  };

  const onCancel = (taskId) => {
    try {
      sessions.get(taskId)?.cancelWaits();
    } catch (err) {
      log(`[browser] cancel 处理异常：${err?.message || err}`);
    }
  };

  // ── IPC（渲染进程面板） ──

  /** 主窗口关闭时把所有视图收回停车场：窗口销毁后 view 不能留在已销毁的父窗口上 */
  const detachAllViews = (why) => {
    for (const s of sessions.values()) {
      try {
        s.detach();
      } catch (err) {
        log(`[browser] ${why}时收回视图失败：${err?.message || err}`);
      }
    }
  };

  const watchMainWindow = (win) => {
    if (!win || watchedWindows.has(win)) return;
    watchedWindows.add(win);
    win.once("closed", () => detachAllViews("主窗口关闭"));
    // 评审 R1-14：主窗口自己 reload / 整页跳转（Cmd+R、崩溃恢复、dev 热刷新）时，原生视图不属于 DOM，会一直盖在新页面上、
    // 而新页面里的面板还没挂载（没人 setBounds / 没人 detach）。导航一开始就收回停车场，面板重新挂载时再 attach。
    // 站内路由是 pushState（isSameDocument），不会触发；子 frame 导航也不管。
    try {
      win.webContents.on("did-start-navigation", (details) => {
        if (details?.isMainFrame && !details.isSameDocument) detachAllViews("主窗口整页导航");
      });
      win.webContents.on("render-process-gone", () => detachAllViews("主窗口渲染进程退出"));
    } catch (err) {
      log(`[browser] 监听主窗口导航失败：${err?.message || err}`);
    }
  };

  const currentZoom = () => {
    try {
      return liveMainWindow()?.webContents.getZoomFactor() ?? 1;
    } catch {
      return 1;
    }
  };

  const userNavigate = async (session, tab, input) => {
    const r = resolveUserInput(input, { isAppUrl: deps.isAppUrl });
    if (!r.ok) return { ok: false, error: r.reason };
    // 等 tab 初始化完（首导航 about:blank 之后）再 loadURL，避免和初始化里的 about:blank 竞争
    await tab.ready.catch(() => {});
    // 经 tab.loadUrlByUser：同样登记「浏览器发起」令牌（R1-10 复审：用户在地址栏粘贴附件直链也不能被当成页面偷偷下载拦掉）
    tab.loadUrlByUser(r.url).catch(() => {});
    void session;
    return { ok: true };
  };

  const registerIpc = () => {
    if (ipcRegistered) return;
    ipcRegistered = true;
    const { ipcMain } = deps;

    /** 有返回值的通道：invoke。非可信发送者直接 throw（不是静默 undefined，渲染侧能看到被拒） */
    const handle = (name, fn) => {
      ipcMain.handle(name, async (event, ...args) => {
        if (!deps.isTrustedIpcSender(event)) throw new Error("untrusted sender");
        return fn(...args);
      });
      ipcUnregister.push(() => ipcMain.removeHandler(name));
    };
    /**
     * 无返回值的通道：同时挂 handle 与 on——渲染侧用 invoke 或 send 调都能通（preload 是 B 组写的，两种调法都兜住）。
     * 两个入口第一件事都是 isTrustedIpcSender。
     */
    const handleOrSend = (name, fn) => {
      ipcMain.handle(name, async (event, ...args) => {
        if (!deps.isTrustedIpcSender(event)) throw new Error("untrusted sender");
        await fn(...args);
      });
      const listener = (event, ...args) => {
        if (!deps.isTrustedIpcSender(event)) return;
        try {
          const r = fn(...args);
          if (r && typeof r.catch === "function") r.catch((err) => log(`[browser] ${name} 失败：${err?.message || err}`));
        } catch (err) {
          log(`[browser] ${name} 失败：${err?.message || err}`);
        }
      };
      ipcMain.on(name, listener);
      ipcUnregister.push(() => {
        ipcMain.removeHandler(name);
        ipcMain.removeListener(name, listener);
      });
    };
    const existing = (taskId) => (validTaskId(taskId) ? sessions.get(taskId) : undefined);

    handle("browser:attach", (taskId, bounds) => {
      if (!validTaskId(taskId)) throw new Error("bad taskId");
      const win = liveMainWindow();
      watchMainWindow(win);
      const session = ensureSession(taskId);
      session.attach(scaleBounds(bounds, currentZoom()));
      return withWindowFocus(session.getState());
    });

    // 高频：只用 ipcMain.on，没有返回值，出错吞掉（拖分栏时不能因为一次坏数据刷屏）
    const onSetBounds = (event, taskId, bounds) => {
      if (!deps.isTrustedIpcSender(event)) return;
      try {
        existing(taskId)?.setBounds(scaleBounds(bounds, currentZoom()));
      } catch {
        /* 非法 bounds：忽略这一帧 */
      }
    };
    ipcMain.on("browser:setBounds", onSetBounds);
    ipcUnregister.push(() => ipcMain.removeListener("browser:setBounds", onSetBounds));

    handleOrSend("browser:detach", (taskId) => existing(taskId)?.detach());

    handle("browser:setCovered", async (taskId, covered) => {
      const s = existing(taskId);
      // 未 attach 时没有可遮盖的东西（契约：返回 null，且不改 covered 状态）
      if (!s || !s.attached) return null;
      try {
        return (await s.setCovered(covered === true)) ?? null;
      } catch {
        return null;
      }
    });

    handle("browser:navigate", async (taskId, input) => {
      if (!validTaskId(taskId)) return { ok: false, error: "无效的任务" };
      // 先过策略再懒创建：地址被拦时不白开 view
      const verdict = resolveUserInput(input, { isAppUrl: deps.isAppUrl });
      if (!verdict.ok) return { ok: false, error: verdict.reason };
      const session = ensureSession(taskId);
      const tab = session.activeTab ?? (await session.openTab({ activate: true }));
      return userNavigate(session, tab, input);
    });

    handleOrSend("browser:back", (taskId) => {
      const nav = existing(taskId)?.activeTab?.wc.navigationHistory;
      if (nav?.canGoBack()) nav.goBack();
    });
    handleOrSend("browser:forward", (taskId) => {
      const nav = existing(taskId)?.activeTab?.wc.navigationHistory;
      if (nav?.canGoForward()) nav.goForward();
    });
    handleOrSend("browser:reload", (taskId) => {
      existing(taskId)?.activeTab?.wc.reload();
    });
    handleOrSend("browser:stop", (taskId) => {
      existing(taskId)?.activeTab?.stop();
    });

    handle("browser:newTab", async (taskId, url) => {
      if (!validTaskId(taskId)) return null;
      let target = null;
      if (typeof url === "string" && url.trim() !== "") {
        const r = resolveUserInput(url, { isAppUrl: deps.isAppUrl });
        if (!r.ok) return null;
        target = r.url;
      }
      const session = ensureSession(taskId, { initialTab: false });
      const tab = await session.openTab({ activate: true });
      if (target) {
        void tab.ready.then(() => tab.loadUrlByUser(target)).catch(() => {});
      }
      return tab.id;
    });

    // R7：本地 HTML → 一次性 token 的 loopback URL。只接绝对路径字符串；真正的范围 / 敏感文件 / 大小校验都在 local-html-server（open + 每个请求）。
    // 返回 { ok, url, scope } | { ok:false, error }；永不抛（渲染侧据 ok 回退到系统打开）
    handle("browser:serveLocalHtml", async (absPath) => {
      if (destroyed) return { ok: false, error: "内置浏览器已关闭" };
      if (typeof absPath !== "string" || absPath.length === 0 || absPath.length > 4096) return { ok: false, error: "无效的文件路径" };
      try {
        return await localHtml.open(absPath);
      } catch (err) {
        log(`[browser] serveLocalHtml 失败：${err?.message || err}`);
        return { ok: false, error: "本地 HTML 服务出错" };
      }
    });

    handleOrSend("browser:selectTab", (taskId, tabId) => {
      const s = existing(taskId);
      if (!s || typeof tabId !== "string") return;
      s.selectTab(tabId);
    });
    handleOrSend("browser:closeTab", async (taskId, tabId) => {
      const s = existing(taskId);
      if (!s || typeof tabId !== "string") return;
      await s.closeTab(tabId);
    });

    handleOrSend("browser:takeover", (taskId) => existing(taskId)?.takeover());
    handleOrSend("browser:handback", (taskId, note) => existing(taskId)?.handback(typeof note === "string" ? note : undefined));
    handleOrSend("browser:answerAsk", (taskId, outcome, note) => existing(taskId)?.answerAsk(outcome, typeof note === "string" ? note : undefined));
    handleOrSend("browser:startPick", (taskId) => {
      existing(taskId)?.startPick();
    });
    handleOrSend("browser:cancelPick", (taskId) => existing(taskId)?.cancelPick());

    handle("browser:getState", (taskId) => {
      const s = existing(taskId);
      return s ? withWindowFocus(s.getState()) : null;
    });

    // 契约 §15.1：增强包 E2 的通用通道。`ext(name, taskId, ...args)`：name 必须是模块登记过的（白名单），handler 收 (session, ...args)；
    // 会话不存在 → null。内置 `prompt.answer`（taskId, promptId, decision）：用户回答等待中的提示（认证 / 证书 / 权限 / evaluate 授权）。
    extHandlers.set("prompt.answer", async (session, promptId, decision) => {
      if (typeof promptId !== "string" || !decision || typeof decision !== "object") return false;
      return session.prompts.answer(promptId, decision);
    });
    // R6-04：用户撤销本任务的 evaluate「仅本任务」批准（之后的脚本重新弹审批卡）。用户发起，接管期间也可用；会记一条系统活动日志
    extHandlers.set("evaluate.revoke", async (session) => {
      const revoked = revokeEvaluateApproval(session);
      if (revoked) {
        try {
          session.activityLog.addSystem({ kind: "select", tabId: session.activeTabId ?? "", url: "", summary: "用户撤销了本任务的页面脚本批准：之后 AI 执行脚本会重新询问" });
          session.host?.onChange?.(session.taskId);
        } catch (err) {
          log(`[browser] evaluate 撤销的活动日志写入失败：${err?.message || err}`);
        }
      }
      return { revoked };
    });
    handle("browser:ext", async (name, taskId, ...args) => {
      if (typeof name !== "string" || !validTaskId(taskId)) return null;
      const fn = extHandlers.get(name);
      if (!fn) throw new Error(`unknown ext: ${name.slice(0, 40)}`);
      const s = existing(taskId);
      if (!s) return null;
      return fn(s, ...args);
    });

    handle("browser:clearBrowsingData", async () => {
      // 只清持久档案（E2·A6）：无痕标签的内存 partition 各自在 tab 关闭时清空，这里不碰（也不该：它们的登录态是 AI 刚建立的、用户没要求清）
      const ses = deps.session.fromPartition(BROWSER_PARTITION);
      // R6-42：三个 Electron 清除调用**逐步隔离**——任何一个抛错都不能跳过后面的「例外表清除 + 断连」（以前 `clearAuthCache` 抛错会直接冒出去，
      // 用户点了「清除」，已放行的坏证书连接却还在、下个任务同主机既不询问也没有标注）。第一个错误记下来，全部做完后再抛（渲染进程仍能看到「清除失败」）。
      const failures = [];
      const attempt = async (what, fn) => {
        try {
          await fn();
        } catch (err) {
          failures.push(err);
          log(`[browser] 清除浏览数据：${what} 失败（其余步骤照常进行）：${err?.message || err}`);
        }
      };
      await attempt("clearStorageData", () =>
        ses.clearStorageData({
          storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage", "filesystem", "websql"],
        }),
      );
      await attempt("clearCache", () => ses.clearCache?.());
      await attempt("clearAuthCache", () => ses.clearAuthCache?.());
      // E2·P1：页面权限的授予 / 冷却、证书例外是「会话内存里的浏览数据」，跟着一起清（各模块在自己的 ext 里实现 onBrowsingDataCleared）。
      // R6-22：传入 partition——清除只作用于持久档案，无痕标签的例外 / 授予不受影响
      for (const s of sessions.values()) {
        for (const v of s.ext?.values?.() ?? []) {
          try {
            v?.onBrowsingDataCleared?.(BROWSER_PARTITION);
          } catch (err) {
            log(`[browser] 清除浏览数据的扩展回调出错（已忽略）：${err?.message || err}`);
          }
        }
      }
      // R6-10：用户放行过坏证书的连接会被 Chromium 复用（不再触发 certificate-error）——清了例外表却不断连接，下个任务同主机既不询问也没有标注。
      // 放在例外表清空**之后**：先清表再断连，断连后的重连一定走「询问」。防御式（fake session 没有此方法就跳过）、吞错记日志：断连失败不应让「清除」整体报错
      await closeConnectionsSafe(ses, log, "清除浏览数据");
      if (failures.length > 0) throw failures[0];
    });

    // V4 用户侧（契约 §14.3）：缩放 / 查找 / DevTools / 下载 reveal-open / 对话框与模拟转调，都在 user-features.mjs 里自己注册并过闸
    userFeatures = registerUserFeatures({
      ipcMain,
      isTrustedIpcSender: deps.isTrustedIpcSender,
      getSession: existing,
      findOwner: findTabByWebContents,
      isAppUrl: deps.isAppUrl,
      sendToRenderer,
      scheduleState,
      Menu: deps.Menu,
      clipboard: deps.clipboard,
      shell: deps.shell,
      log,
    });
    ipcUnregister.push(() => {
      userFeatures?.dispose();
      userFeatures = null;
    });
  };

  // ── 对外 ──

  const attachServerChannel = (proc) => {
    if (destroyed) return;
    // 旧通道 close：其上挂起的请求全部以 CANCELLED 结束，会话本身不丢
    channel?.close();
    channel = createServerChannel({ proc, dispatch, onConfig, onCancel, log });
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const t of stateTimers.values()) clearTimeout(t);
    stateTimers.clear();
    for (const id of [...sessions.keys()]) {
      const s = sessions.get(id);
      sessions.delete(id);
      dropDownloadState(id);
      if (s) releaseSessionNetState(s);
      try {
        s?.destroy();
      } catch (err) {
        log(`[browser] 销毁会话失败：${err?.message || err}`);
      }
    }
    channel?.close();
    channel = null;
    try {
      localHtml.revokeAll();
    } catch (err) {
      log(`[browser] 关闭本地 HTML 服务失败：${err?.message || err}`);
    }
    for (const off of ipcUnregister.splice(0)) {
      try {
        off();
      } catch {
        /* 已移除 */
      }
    }
    ipcRegistered = false;
    if (parkingWindow && !parkingWindow.isDestroyed()) {
      try {
        parkingWindow.destroy();
      } catch {
        /* 已销毁 */
      }
    }
    parkingWindow = null;
  };

  return {
    attachServerChannel,
    registerIpc,
    isParkingWindow,
    /** main.js 的 before-quit：true = 退出已进入最终通过（不再新建停车场 / tab）；退出被推迟 / 取消时传 false */
    setQuitting: (on) => {
      quitting = on === true;
    },
    destroy,
    // 以下仅供单测 / e2e 直接驱动，不属于契约接口
    dispatch,
    getSession: (taskId) => sessions.get(taskId),
    getConfig: () => ({ ...config }),
    onConfig,
    onCancel,
  };
};
