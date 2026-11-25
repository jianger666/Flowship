/**
 * 「清除登录数据」的页面侧配合：清除前先让已打开的页面停下，清完再回到原地址。
 *
 * 为什么需要（真机探针实测）：只调 `clearStorageData` 时，清除返回的瞬间 cookie / localStorage / sessionStorage 确实是空的，
 * 但**还开着的页面里 JS 没停**——内存里的 access token + 续期心跳、状态库的 persist 回写，会在 1～2 秒内把 HttpOnly 登录 cookie
 * 重新种回、把 localStorage 写回，30 秒后落盘；这时刷新页面仍是登录状态。用户看到的就是「点了清除，但没清掉」。
 *
 * 做法（对持久档案里所有可能持有登录态的标签：非无痕、http(s)）：
 *  1. 终止：`loadURL("about:blank")`——旧文档卸载，在途请求被取消，定时器 / 心跳 / 回写全停。
 *     页面带 beforeunload（编辑中的表单）时 Electron 默认**静默取消**这次导航（实测 ERR_ABORTED，页面原地不动），
 *     所以终止期间临时挂 `will-prevent-unload` 强制放行——用户已在确认框里同意「已打开的网页会重新加载」。
 *     页面刚被 beforeunload 拦过一次导航（用户在地址栏试过换页）时，那个离开确认框还挂在 Tab 上、Chromium 要一两秒才结算，期间新导航会 ERR_FAILED：
 *     先把挂着的 beforeunload 确认掉（只碰 beforeunload，绝不替用户点页面的 confirm / alert / prompt），再在时限内对 ERR_FAILED 重试。
 *  2. 清除：调用方（`browser:clearBrowsingData`）照旧清 session。
 *  3. 恢复：回到原地址（页面以登出态重新加载），再把终止 / 恢复多出来的两条历史（about:blank 与旧的同址条目）修剪掉，
 *     后退栈保持原样。用户当时停在历史中间（后退过）时前进栈会丢——about:blank 是一次真实导航，Chromium 会截掉当前下标之后的条目。
 *
 * 不碰：无痕标签（各自的内存 partition，关闭即清）、空白页 / 错误页 / 非 http(s) 页（没有登录态可言）、Flowship 自身地址。
 * 全部防御式：任何一步出错只记日志，绝不能让「清除」本身失败；fake wc 缺方法就跳过那一步。
 * 不 import electron：单测用假 tab / 假 wc 驱动。
 */
import { BROWSER_PARTITION } from "./tab.mjs";
import { checkUrl } from "./url-policy.mjs";

/** 终止一个页面最多等多久（含重试）：卡死的页面不能拖住清除（超时的标签仍会在恢复阶段补救，见 {@link resumeTabsAfterClear}） */
export const HALT_TIMEOUT_MS = 3000;
/**
 * 终止被「还没结算的 beforeunload」挡住（`ERR_FAILED`）时的重试间隔。探针 D 实测：页面先被 beforeunload 拦过一次导航（用户在地址栏试过换页、
 * 或点了链接），Chromium 里那个离开确认框要一两秒才结算，这段时间内新的导航会立刻 ERR_FAILED（1ms）；回答掉它或等它结算后再终止就成功。
 */
export const HALT_RETRY_DELAYS_MS = [100, 250, 500, 1000];
/** 恢复后等页面提交多久才放弃修剪历史（慢站点：宁可多留两条历史，也不在页面没提交时乱删） */
export const RESUME_TIMEOUT_MS = 20_000;

const BLANK = "about:blank";
/** 只有这一种失败值得重试（其它失败——比如被用户的另一次导航顶掉的 ERR_ABORTED——重试只会和用户抢导航） */
const RETRYABLE_OUTCOME = "error:ERR_FAILED";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const safeLog = (log, msg) => {
  try {
    log?.(msg);
  } catch {
    /* 日志函数自己出错也不能冒泡 */
  }
};

/** Promise 的结局收成字符串：ok / timeout / error:<码>（永不 reject，超时后原 Promise 的结局被忽略） */
const settle = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timer);
        resolve("ok");
      },
      (err) => {
        clearTimeout(timer);
        resolve(`error:${err?.code || err?.message || "unknown"}`);
      },
    );
  });

const alive = (tab) => {
  try {
    return !!tab && tab.destroyed !== true && tab.wc?.isDestroyed?.() !== true;
  } catch {
    return false;
  }
};

const activeIndexOf = (wc) => {
  try {
    const nav = wc.navigationHistory;
    return typeof nav?.getActiveIndex === "function" ? Number(nav.getActiveIndex()) : -1;
  } catch {
    return -1;
  }
};

/**
 * 这个标签要不要处理：持久档案（非无痕）、还活着、当前是 http(s) 页面（空白页 / 错误页 / 其它协议没有登录态；Flowship 自身地址也不碰）。
 * @param {any} tab
 * @param {{ isAppUrl?: (url: string) => boolean }} [opts]
 */
export const isClearTarget = (tab, { isAppUrl } = {}) => {
  try {
    if (!alive(tab) || tab.incognito === true) return false;
    if (tab.partition !== BROWSER_PARTITION) return false;
    const verdict = checkUrl(tab.url, { isAppUrl });
    return verdict.ok && verdict.url !== BLANK;
  } catch {
    return false;
  }
};

/**
 * 收集所有会话里要处理的标签（清除作用于整份持久档案，不分任务）。
 * @param {Iterable<{ tabs?: any[] }>} sessions
 * @param {{ isAppUrl?: (url: string) => boolean }} [opts]
 * @returns {any[]}
 */
export const collectClearTargets = (sessions, opts) => {
  const targets = [];
  for (const s of sessions ?? []) {
    for (const tab of s?.tabs ?? []) {
      if (isClearTarget(tab, opts)) targets.push(tab);
    }
  }
  return targets;
};

/**
 * Tab 上挂着「离开确认框」（beforeunload，上一次被拦下的导航留下的）→ 确认掉：确认 = 离开页面，正是用户点「清除」时要的。
 * **只碰 beforeunload**：页面里的 confirm / alert / prompt 是页面在等用户回答（「确定删除全部？」之类），替用户点「确定」可能触发破坏性操作，
 * 这里一律不碰（终止会因此失败 / 超时，该标签跳过，用户自己能在面板上看到那个对话框）。
 */
const acceptPendingBeforeUnload = async (tab, log) => {
  try {
    if (tab.pendingDialog?.type !== "beforeunload" || typeof tab.answerDialog !== "function") return;
    await tab.answerDialog(true, undefined, { by: "user" });
  } catch (err) {
    safeLog(log, `[browser] 清除浏览数据：标签 ${tab.id ?? "?"} 确认离开提示出错（已忽略）：${err?.message || err}`);
  }
};

const haltOne = async (tab, { timeoutMs, retryDelaysMs, log }) => {
  /** @type {{ tab: any, url: string, idx: number, outcome: string }} */
  const record = { tab, url: "", idx: -1, outcome: "skipped" };
  const wc = tab.wc;
  const allowUnload = (event) => event.preventDefault();
  let hooked = false;
  try {
    record.url = String(wc.getURL());
    record.idx = activeIndexOf(wc);
    wc.on("will-prevent-unload", allowUnload);
    hooked = true;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      await acceptPendingBeforeUnload(tab, log);
      record.outcome = await settle(wc.loadURL(BLANK), Math.max(deadline - Date.now(), 1));
      const wait = retryDelaysMs[attempt];
      if (record.outcome !== RETRYABLE_OUTCOME || wait === undefined || Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    if (record.outcome !== "ok") safeLog(log, `[browser] 清除浏览数据：标签 ${tab.id ?? "?"} 终止页面未成功（${record.outcome}）`);
  } catch (err) {
    record.outcome = `error:${err?.message || err}`;
    safeLog(log, `[browser] 清除浏览数据：标签 ${tab.id ?? "?"} 终止页面出错（已忽略）：${err?.message || err}`);
  } finally {
    // 只在终止这一刻需要放行 beforeunload；之后离开 about:blank 没有 beforeunload，监听不能留着
    try {
      if (hooked) wc.removeListener("will-prevent-unload", allowUnload);
    } catch {
      /* wc 在这期间被销毁：监听随它一起没了 */
    }
  }
  return record;
};

/**
 * 终止：让这些标签的页面停下来（并发；每个最多等 `timeoutMs`）。永不 reject。
 * 返回的记录交给 {@link resumeTabsAfterClear}——**不管终止是否在时限内成功都要交回去**：超时的页面可能随后才进入 about:blank，恢复阶段会补救。
 * @param {any[]} tabs
 * @param {{ log?: (msg: string) => void, timeoutMs?: number, retryDelaysMs?: number[] }} [opts]
 * @returns {Promise<{ tab: any, url: string, idx: number, outcome: string }[]>}
 */
export const haltTabsForClear = async (tabs, { log, timeoutMs = HALT_TIMEOUT_MS, retryDelaysMs = HALT_RETRY_DELAYS_MS } = {}) => {
  const list = Array.isArray(tabs) ? tabs.filter(alive) : [];
  return Promise.all(list.map((tab) => haltOne(tab, { timeoutMs, retryDelaysMs, log })));
};

/**
 * 期望的历史栈是 `[… 旧页(idx), about:blank(idx+1), 新页(idx+2)]`（当前在新页）：恰好是这个形状才把后两条多余的删掉
 * （先删下标大的）。任何一项对不上（用户在这期间又导航了 / 页面没提交 / API 不可用）一律不动——宁可多留两条历史。
 * @returns {boolean} 是否做了修剪
 */
export const pruneClearHistory = (wc, idx, log) => {
  try {
    if (!(idx >= 0)) return false;
    const nav = wc?.navigationHistory;
    if (typeof nav?.length !== "function" || typeof nav.getEntryAtIndex !== "function" || typeof nav.removeEntryAtIndex !== "function") return false;
    if (nav.length() !== idx + 3) return false;
    if (typeof nav.getActiveIndex === "function" && nav.getActiveIndex() !== idx + 2) return false;
    if (nav.getEntryAtIndex(idx + 1)?.url !== BLANK) return false;
    nav.removeEntryAtIndex(idx + 1);
    nav.removeEntryAtIndex(idx);
    return true;
  } catch (err) {
    safeLog(log, `[browser] 清除浏览数据：修剪历史出错（已忽略）：${err?.message || err}`);
    return false;
  }
};

/**
 * 恢复：把确实停在 about:blank 的标签导航回清除前的地址。同步发起、不等页面加载（IPC 马上返回，页面在后台恢复）；
 * 页面提交后再异步修剪历史。终止没生效的标签（页面还在原地）不动。放进 `finally` 调用——清除失败也要把用户的页面还回去。
 * @param {{ tab: any, url: string, idx: number }[]} halted {@link haltTabsForClear} 的返回
 * @param {{ log?: (msg: string) => void, timeoutMs?: number, isAppUrl?: (url: string) => boolean }} [opts]
 * @returns {number} 发起恢复的标签数
 */
export const resumeTabsAfterClear = (halted, { log, timeoutMs = RESUME_TIMEOUT_MS, isAppUrl } = {}) => {
  let resumed = 0;
  for (const { tab, url, idx } of halted ?? []) {
    try {
      if (!alive(tab) || tab.url !== BLANK) continue;
      const verdict = checkUrl(url, { isAppUrl });
      if (!verdict.ok || verdict.url === BLANK) continue;
      const load = typeof tab.loadUrlByUser === "function" ? tab.loadUrlByUser(verdict.url) : tab.wc.loadURL(verdict.url);
      resumed += 1;
      void settle(load, timeoutMs).then((outcome) => {
        if (outcome === "timeout" || !alive(tab)) return;
        pruneClearHistory(tab.wc, idx, log);
      });
    } catch (err) {
      safeLog(log, `[browser] 清除浏览数据：标签 ${tab?.id ?? "?"} 恢复页面出错（已忽略）：${err?.message || err}`);
    }
  }
  return resumed;
};
