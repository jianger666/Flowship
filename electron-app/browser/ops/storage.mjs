/**
 * 增强包 E2 · A1 登录态（契约 §15.2 S2）：`browser_storage` 的主进程实现——
 * cookie / localStorage / sessionStorage / IndexedDB 库名 / export_state / import_state / clear_site。
 *
 * 数据来源：
 *  - cookie：目标 tab 所在 partition 的 `tab.wc.session.cookies`（主进程 API，HttpOnly 也读得到）。**不写死持久 partition**——
 *    无痕 tab（P2 的 A6）有自己的 partition，`tab.wc.session` 天然指向它；
 *  - localStorage / sessionStorage / IndexedDB：CDP `DOMStorage` / `IndexedDB` 域（经 `tab.send`，作用于该 tab 当前 origin）。
 *    域按需 enable、用完 disable，不留常驻状态，不碰 tab 既有的 CDP 初始化。
 *
 * 安全模型（红线 §15.3）：
 *  - 默认只给名字与属性，值脱敏成「长度 + 前 4 位」；看明文 / 写 / 删 / 清 / 导入 / 导出一律要 `storageAccess === true`（本文件在主进程独立判，
 *    不信 server 侧工具注册那一道）；
 *  - Flowship origin 永远排除：URL 过 `checkAiUrl`，cookie 的域名过 `isAppUrl`（cookie 不带端口，这里按「域名形态」判，取舍见 storage-policy.mjs）；
 *  - 动作类（写 / 删 / 清 / 导入导出）走 `session.runAction`：串行排队、用户接管期间 `USER_CONTROL`、写活动日志；
 *    活动日志只写条数与站点，**不写任何值**；读明文的列表不进队列，但用户接管期间同样拒绝；
 *  - 导入导出文件只在 `<userData>/data/tasks/<taskId>/browser-state/`，文件名由主进程净化，0600 / 目录 0700（纯逻辑与 fs 操作在 ../storage-policy.mjs）。
 */
import nodeFs from "node:fs";
import { BrowserError } from "../server-channel.mjs";
import {
  STORAGE_ACTIONS,
  STORAGE_AREAS,
  STORAGE_REVEAL_ACTIONS,
  COOKIE_SAME_SITE,
  MAX_LIST_ENTRIES,
  MAX_COOKIE_NAME_CHARS,
  MAX_COOKIE_VALUE_CHARS,
  MAX_STORAGE_KEY_CHARS,
  MAX_STORAGE_VALUE_CHARS,
  actionNeedsAccess,
  isWriteAction,
  validateCookieInput,
  normalizeCookie,
  normalizeCookieHost,
  describeCookie,
  describeStorageItem,
  isAppCookieDomain,
  cookieUrlOf,
  toElectronCookie,
  domainMatchesHost,
  buildStateFile,
  parseStateFile,
  sanitizeStateName,
  strictStateName,
  defaultStateName,
  stateDirFor,
  writeStateFile,
  readStateFile,
  cleanName,
  STATE_DIR_NAME,
} from "../storage-policy.mjs";

export const OPS = Object.freeze(["storage"]);

const AREA_ZH = { local: "localStorage", session: "sessionStorage" };
const SCOPE_ACTIONS = ["cookies_list", "cookies_get", "cookies_delete", "cookies_clear", "export_state"];
const AREA_ACTIONS = ["storage_list", "storage_get", "storage_set", "storage_remove", "storage_clear"];
const KEY_ACTIONS = ["storage_get", "storage_set", "storage_remove"];
/** idb_list 最多展开多少个库 / 每库多少个 object store（只列名字，防止巨型站点撑爆输出） */
const MAX_IDB_DATABASES = 20;
const MAX_IDB_STORES = 50;

// ───────────────────────── 参数规整 ─────────────────────────

/**
 * storage 的参数 → 规整后的对象（纯函数，可单测）。只含契约字段；非法抛 BAD_ARGS。
 * @param {object} args
 * @param {object} h  index.mjs 的 OP_HELPERS
 */
export const normalizeStorage = (args, h) => {
  const action = h.reqEnum(args, "action", STORAGE_ACTIONS);
  const out = { action };
  if (STORAGE_REVEAL_ACTIONS.includes(action) && h.optBool(args, "reveal", false) === true) out.reveal = true;

  if (SCOPE_ACTIONS.includes(action)) {
    const url = h.optStr(args, "url", 8192);
    const domain = h.optStr(args, "domain", 253);
    const all = h.optBool(args, "all", false) === true;
    if ([url, domain, all ? true : undefined].filter((x) => x !== undefined).length > 1) {
      throw h.bad("url / domain / all 只能给一个（都不给 = 当前页面所在站点）");
    }
    if (url !== undefined) out.url = url;
    if (domain !== undefined) out.domain = domain;
    if (all) out.all = true;
  }
  if (action === "cookies_get" || action === "cookies_delete") out.name = h.reqStr(args, "name", { max: MAX_COOKIE_NAME_CHARS });

  if (action === "cookies_set") {
    const url = h.optStr(args, "url", 8192);
    if (url !== undefined) out.url = url;
    const expires = h.optNum(args, "expires", { dflt: undefined });
    const v = validateCookieInput({
      name: h.reqStr(args, "name", { max: MAX_COOKIE_NAME_CHARS }),
      value: h.reqStr(args, "value", { max: MAX_COOKIE_VALUE_CHARS, allowEmpty: true }),
      domain: h.optStr(args, "domain", 253),
      path: h.optStr(args, "path", 1024),
      secure: h.optBool(args, "secure", false),
      httpOnly: h.optBool(args, "httpOnly", false),
      sameSite: h.optEnum(args, "sameSite", COOKIE_SAME_SITE, undefined),
      expires,
    });
    if (!v.ok) throw h.bad(v.reason);
    out.cookie = v.cookie;
  }

  if (AREA_ACTIONS.includes(action)) out.area = h.reqEnum(args, "area", STORAGE_AREAS);
  if (KEY_ACTIONS.includes(action)) out.key = h.reqStr(args, "key", { max: MAX_STORAGE_KEY_CHARS });
  if (action === "storage_set") out.value = h.reqStr(args, "value", { max: MAX_STORAGE_VALUE_CHARS, allowEmpty: true });

  if (action === "export_state") {
    const file = h.optStr(args, "file", 100);
    if (file !== undefined) out.file = file;
    if (h.optBool(args, "includeStorage", true) === false) out.includeStorage = false;
  }
  if (action === "import_state") out.file = h.reqStr(args, "file", { max: 100 });
  return h.withTab(args, out);
};

export const normalize = (op, args, h) => {
  switch (op) {
    case "storage":
      return normalizeStorage(args, h);
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

// ───────────────────────── handlers ─────────────────────────

const accessDisabled = (action, reveal) =>
  new BrowserError(
    "ACCESS_DISABLED",
    `${reveal ? "查看明文值" : `storage 的 ${action}`}需要用户在 设置 → 内置浏览器 里打开「允许 AI 读写登录态」。没开时只能查看名称与属性（值已脱敏）。请不要重试，把这个限制告诉用户`,
  );

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖（契约 §15.1）；测试可额外注入 `fs` / `now`
 */
export const createHandlers = (deps) => {
  const { requireSession, getConfig, abortable, scheduleState } = deps;
  const fs = deps.fs ?? nodeFs;
  const nowMs = () => (typeof deps.now === "function" ? Number(deps.now()) : Date.now());
  const hostLabel = deps.hostLabel ?? ((u) => String(u ?? "").slice(0, 80));
  const isAppUrl = (u) => {
    try {
      return deps.electron?.isAppUrl?.(u) === true;
    } catch {
      return false;
    }
  };

  /** 非抛错版 URL 校验（给 storage-policy 的导入校验用） */
  const checkUrlSoft = (url) => {
    try {
      deps.checkAiUrl(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) };
    }
  };

  const userDataDir = () => {
    try {
      return deps.app?.getPath?.("userData") ?? "";
    } catch {
      return "";
    }
  };

  /** 当前页面所在站点；about:blank / 内部页 / Flowship origin 都不行 */
  const siteOf = (tab) => {
    const raw = String(tab.url ?? "");
    const href = deps.checkAiUrl(raw); // Flowship origin / 非 http(s) 在这里抛 URL_BLOCKED
    let u = null;
    try {
      u = new URL(href);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
      throw new BrowserError("BAD_ARGS", "当前页面不是网站页面（空白页没有站点可操作）。请先 browser_navigate 打开目标站点，或用 url / domain 指定范围");
    }
    return { origin: u.origin, host: u.hostname, href: u.href };
  };

  /** 操作范围：all / url / domain / 当前站点；Flowship 相关的一律 URL_BLOCKED */
  const resolveScope = (tab, a) => {
    if (a.all === true) return { kind: "all", label: "全部站点", filter: {} };
    if (a.url !== undefined) {
      const href = deps.checkAiUrl(a.url);
      let host = "";
      try {
        host = new URL(href).hostname;
      } catch {
        /* checkAiUrl 已校验过 */
      }
      if (!host) throw new BrowserError("BAD_ARGS", "url 必须是带主机名的 http(s) 地址");
      return { kind: "url", label: host, filter: { url: href } };
    }
    if (a.domain !== undefined) {
      const host = normalizeCookieHost(a.domain);
      if (host === null) throw new BrowserError("BAD_ARGS", "domain 不合法（只能是主机名，如 example.com）");
      if (isAppCookieDomain(host, isAppUrl)) throw new BrowserError("URL_BLOCKED", "该域名指向 Flowship 应用自身，不允许操作");
      return { kind: "domain", label: host, filter: { domain: host } };
    }
    const site = siteOf(tab);
    return { kind: "site", label: site.host, filter: { url: site.href } };
  };

  const jarOf = (tab) => {
    const jar = tab?.wc?.session?.cookies;
    if (!jar || typeof jar.get !== "function") throw new BrowserError("UNSUPPORTED", "当前标签页没有可用的 cookie 存储");
    return jar;
  };

  /** 取范围内的 cookie（已排除 Flowship 域名），按 域名 / 名字 排序 */
  const fetchCookies = async (tab, scope, name, signal) => {
    const filter = { ...scope.filter, ...(name !== undefined ? { name } : {}) };
    const raw = await abortable(jarOf(tab).get(filter), signal);
    return (Array.isArray(raw) ? raw : [])
      .map(normalizeCookie)
      .filter((c) => !isAppCookieDomain(c.domain, isAppUrl))
      .sort((x, y) => (x.domain === y.domain ? x.name.localeCompare(y.name) : x.domain.localeCompare(y.domain)));
  };

  /** 记一条 AI 活动日志：动作类走 ctx.describe（runAction 收尾时写），读明文的列表直接写。**不含任何值** */
  const note = (session, tab, ctx, d) => {
    if (ctx?.describe) {
      ctx.describe({ kind: "select", ...d });
      return;
    }
    try {
      session.activityLog.addAI({ kind: "select", tabId: tab.id, url: tab.url, summary: d.summary });
      scheduleState?.(session.taskId);
    } catch (err) {
      deps.log?.(`[browser] storage 活动日志写入失败：${err?.message || err}`);
    }
  };

  // ── DOMStorage / IndexedDB（CDP） ──

  /** 新版 Chromium 的 DOMStorage / IndexedDB 优先认 storageKey；取不到就回退 securityOrigin（两种写法 CDP 都接受） */
  const storageIdentity = async (tab, origin) => {
    try {
      const tree = await tab.send("Page.getFrameTree");
      const frameId = tree?.frameTree?.frame?.id;
      if (frameId) {
        const r = await tab.send("Storage.getStorageKeyForFrame", { frameId });
        if (typeof r?.storageKey === "string" && r.storageKey !== "") return { storageKey: r.storageKey };
      }
    } catch {
      /* 回退 */
    }
    return { securityOrigin: origin };
  };

  /** 在「DOMStorage 已 enable」的窗口里跑 fn(storageId, site)；用完 disable（best-effort），不留常驻状态 */
  const withDomStorage = async (tab, area, signal, fn) => {
    await abortable(tab.ensureCdp(), signal);
    const site = siteOf(tab);
    await abortable(tab.send("DOMStorage.enable"), signal);
    try {
      const ident = await storageIdentity(tab, site.origin);
      const storageId = { ...ident, isLocalStorage: area === "local" };
      return await fn(storageId, site);
    } finally {
      tab.send("DOMStorage.disable").catch(() => {});
    }
  };

  const readEntries = async (tab, storageId, signal) => {
    const r = await abortable(tab.send("DOMStorage.getDOMStorageItems", { storageId }), signal);
    return (Array.isArray(r?.entries) ? r.entries : [])
      .filter((e) => Array.isArray(e) && typeof e[0] === "string")
      .map((e) => [e[0], String(e[1] ?? "")]);
  };

  // ── 各 action ──

  const cookiesList = async (session, tab, a, ctx, signal, only) => {
    const reveal = a.reveal === true;
    const scope = resolveScope(tab, a);
    const cookies = await fetchCookies(tab, scope, only ? a.name : undefined, signal);
    const shown = cookies.slice(0, MAX_LIST_ENTRIES);
    if (reveal && shown.length > 0) note(session, tab, ctx, { summary: `读取了 ${shown.length} 个 cookie 的明文值（${scope.label}）` });
    return {
      action: a.action,
      scope: scope.label,
      total: cookies.length,
      truncated: cookies.length > shown.length,
      revealed: reveal,
      cookies: shown.map((c) => describeCookie(c, { reveal })),
    };
  };

  const cookiesSet = async (session, tab, a, ctx, signal) => {
    const cookie = a.cookie;
    const baseUrl = a.url !== undefined ? deps.checkAiUrl(a.url) : siteOf(tab).href;
    let baseHost = "";
    try {
      baseHost = new URL(baseUrl).hostname;
    } catch {
      /* 上面已校验 */
    }
    if (cookie.domain !== undefined) {
      if (isAppCookieDomain(cookie.domain, isAppUrl)) throw new BrowserError("URL_BLOCKED", "该域名指向 Flowship 应用自身，不允许写入 cookie");
      if (!domainMatchesHost(cookie.domain, baseHost)) {
        throw new BrowserError("BAD_ARGS", `cookie 的 domain（${cleanName(cookie.domain, 60)}）必须匹配目标地址的主机（${cleanName(baseHost, 60)}）`);
      }
    }
    // secure cookie 不能从 http URL 写入（浏览器拒绝）：改用同主机的 https URL（checkAiUrl 再过一遍）
    const writeUrl = cookie.secure && baseUrl.startsWith("http:") ? deps.checkAiUrl(baseUrl.replace(/^http:/, "https:")) : baseUrl;
    ctx.check?.();
    await abortable(jarOf(tab).set(toElectronCookie(cookie, writeUrl)), signal);
    const bare = (d) => String(d).replace(/^\./, "").toLowerCase();
    const back = (await fetchCookies(tab, { filter: { url: writeUrl } }, cookie.name, signal)).filter(
      (c) => cookie.domain === undefined || bare(c.domain) === bare(cookie.domain),
    );
    if (back.length === 0) {
      throw new BrowserError(
        "BAD_ARGS",
        "浏览器拒绝了这个 cookie（常见原因：secure 与地址协议不符、domain 与地址不匹配、__Host- / __Secure- 前缀要求未满足）。没有写入任何内容",
      );
    }
    note(session, tab, ctx, { summary: `写入了 cookie「${cleanName(cookie.name, 40)}」（${hostLabel(writeUrl)}）`, label: "写入 cookie" });
    return { action: "cookies_set", set: describeCookie(back[0], { reveal: false }) };
  };

  const cookiesRemove = async (session, tab, a, ctx, signal, byName) => {
    const scope = resolveScope(tab, a);
    const before = await fetchCookies(tab, scope, byName ? a.name : undefined, signal);
    const jar = jarOf(tab);
    for (const c of before) {
      ctx.check?.();
      await abortable(jar.remove(cookieUrlOf(c), c.name), signal);
    }
    const after = await fetchCookies(tab, scope, byName ? a.name : undefined, signal);
    const removed = Math.max(0, before.length - after.length);
    note(session, tab, ctx, {
      summary: byName ? `删除了 ${removed} 个名为「${cleanName(a.name, 40)}」的 cookie（${scope.label}）` : `清空了 ${scope.label} 的 ${removed} 个 cookie`,
      label: byName ? "删除 cookie" : "清空 cookie",
    });
    return { action: a.action, scope: scope.label, removed, remaining: after.length };
  };

  const storageList = async (session, tab, a, ctx, signal) => {
    const reveal = a.reveal === true;
    return withDomStorage(tab, a.area, signal, async (storageId, site) => {
      const entries = (await readEntries(tab, storageId, signal)).sort((x, y) => x[0].localeCompare(y[0]));
      const shown = entries.slice(0, MAX_LIST_ENTRIES);
      if (reveal && shown.length > 0) note(session, tab, ctx, { summary: `读取了 ${shown.length} 项 ${AREA_ZH[a.area]} 的明文值（${site.host}）` });
      return {
        action: "storage_list",
        area: a.area,
        origin: site.origin,
        total: entries.length,
        truncated: entries.length > shown.length,
        revealed: reveal,
        items: shown.map(([k, v]) => describeStorageItem(k, v, { reveal })),
      };
    });
  };

  const storageGet = async (session, tab, a, ctx, signal) => {
    const reveal = a.reveal === true;
    return withDomStorage(tab, a.area, signal, async (storageId, site) => {
      const hit = (await readEntries(tab, storageId, signal)).find(([k]) => k === a.key);
      if (hit && reveal) note(session, tab, ctx, { summary: `读取了 1 项 ${AREA_ZH[a.area]} 的明文值（${site.host}）` });
      return {
        action: "storage_get",
        area: a.area,
        origin: site.origin,
        exists: Boolean(hit),
        ...(hit ? { item: describeStorageItem(hit[0], hit[1], { reveal }) } : {}),
        revealed: reveal && Boolean(hit),
      };
    });
  };

  const storageSet = async (session, tab, a, ctx, signal) =>
    withDomStorage(tab, a.area, signal, async (storageId, site) => {
      ctx.check?.();
      await abortable(tab.send("DOMStorage.setDOMStorageItem", { storageId, key: a.key, value: a.value }), signal);
      note(session, tab, ctx, { summary: `写入了 ${AREA_ZH[a.area]} 的项「${cleanName(a.key, 40)}」（${site.host}）`, label: `写入 ${AREA_ZH[a.area]}` });
      return { action: "storage_set", area: a.area, origin: site.origin, key: cleanName(a.key, 300), size: a.value.length };
    });

  const storageRemove = async (session, tab, a, ctx, signal) =>
    withDomStorage(tab, a.area, signal, async (storageId, site) => {
      const existed = (await readEntries(tab, storageId, signal)).some(([k]) => k === a.key);
      ctx.check?.();
      await abortable(tab.send("DOMStorage.removeDOMStorageItem", { storageId, key: a.key }), signal);
      note(session, tab, ctx, { summary: `删除了 ${AREA_ZH[a.area]} 的项「${cleanName(a.key, 40)}」（${site.host}）`, label: `删除 ${AREA_ZH[a.area]}` });
      return { action: "storage_remove", area: a.area, origin: site.origin, key: cleanName(a.key, 300), existed };
    });

  const storageClear = async (session, tab, a, ctx, signal) =>
    withDomStorage(tab, a.area, signal, async (storageId, site) => {
      const before = (await readEntries(tab, storageId, signal)).length;
      ctx.check?.();
      await abortable(tab.send("DOMStorage.clear", { storageId }), signal);
      note(session, tab, ctx, { summary: `清空了 ${site.host} 的 ${AREA_ZH[a.area]}（${before} 项）`, label: `清空 ${AREA_ZH[a.area]}` });
      return { action: "storage_clear", area: a.area, origin: site.origin, cleared: before };
    });

  const idbList = async (session, tab, a, ctx, signal) => {
    await abortable(tab.ensureCdp(), signal);
    const site = siteOf(tab);
    await abortable(tab.send("IndexedDB.enable"), signal);
    try {
      const ident = await storageIdentity(tab, site.origin);
      const names = (await abortable(tab.send("IndexedDB.requestDatabaseNames", ident), signal))?.databaseNames;
      const all = Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
      const databases = [];
      for (const name of all.slice(0, MAX_IDB_DATABASES)) {
        let info = null;
        try {
          info = (await abortable(tab.send("IndexedDB.requestDatabase", { ...ident, databaseName: name }), signal))?.databaseWithObjectStores;
        } catch {
          info = null; // 单个库读不出来不影响其它库
        }
        const stores = Array.isArray(info?.objectStores) ? info.objectStores : [];
        databases.push({
          name: cleanName(name, 200),
          version: typeof info?.version === "number" ? info.version : undefined,
          objectStores: stores.slice(0, MAX_IDB_STORES).map((s) => ({
            name: cleanName(s?.name, 200),
            autoIncrement: s?.autoIncrement === true,
            indexes: Array.isArray(s?.indexes) ? s.indexes.length : 0,
          })),
          objectStoresTotal: stores.length,
        });
      }
      void session;
      void ctx;
      return { action: "idb_list", origin: site.origin, total: all.length, truncated: all.length > databases.length, databases };
    } finally {
      tab.send("IndexedDB.disable").catch(() => {});
    }
  };

  /** 当前站点 origin 的 localStorage（导出 / 导入用）；读不到（空白页 / CDP 出错）返回 null */
  const readLocalStorageOf = async (tab, signal) => {
    try {
      return await withDomStorage(tab, "local", signal, async (storageId, site) => {
        const entries = await readEntries(tab, storageId, signal);
        return { origin: site.origin, items: entries.map(([name, value]) => ({ name, value })) };
      });
    } catch (err) {
      if (err?.code === "CANCELLED" || signal?.aborted) throw err;
      return null;
    }
  };

  const stateDir = (taskId) => {
    const dir = stateDirFor(userDataDir(), taskId);
    if (!dir) throw new BrowserError("INTERNAL", "无法确定任务目录（userData 或 taskId 不可用），不能导入导出登录状态");
    return dir;
  };

  const exportState = async (session, tab, a, ctx, signal, taskId) => {
    // R6-22：无痕「不落盘」只是 partition 本身；导出会把 cookie / 令牌明文写进任务目录，等于把无痕数据落盘——在读 cookie 之前就拒绝
    if (tab.incognito === true) {
      throw new BrowserError("DENIED", "无痕标签的数据不允许导出到磁盘；请在普通标签里操作，或用 storage get/list 读取（已脱敏）");
    }
    const scope = resolveScope(tab, a);
    const cookies = await fetchCookies(tab, scope, undefined, signal);
    // localStorage 只带「当前页面 origin」：全部站点 / 当前站点 / 与当前页同源的 url 范围；domain 范围不带（无法保证同站）
    let origins = [];
    let storageNote = "";
    if (a.includeStorage !== false) {
      let wanted = scope.kind === "site" || scope.kind === "all";
      if (scope.kind === "url") {
        try {
          wanted = new URL(scope.filter.url).origin === new URL(tab.url).origin;
        } catch {
          wanted = false;
        }
      }
      if (wanted) {
        const ls = await readLocalStorageOf(tab, signal);
        if (ls && ls.items.length > 0) origins = [{ origin: ls.origin, localStorage: ls.items }];
        else if (!ls) storageNote = "当前页面读不到 localStorage，只导出了 cookie";
      }
    }
    if (cookies.length === 0 && origins.length === 0) {
      throw new BrowserError("BAD_ARGS", `${scope.label} 当前没有 cookie 也没有 localStorage 可导出（可能还没登录）`);
    }
    ctx.check?.();
    const base = sanitizeStateName(a.file) || defaultStateName(new Date(nowMs()));
    const text = JSON.stringify(buildStateFile({ cookies, origins, now: new Date(nowMs()) }));
    let written;
    try {
      written = writeStateFile({ fs, dir: stateDir(taskId), base, text, now: nowMs() });
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError("BAD_ARGS", `导出失败：${String(err?.message ?? err).slice(0, 200)}`);
    }
    note(session, tab, ctx, {
      summary: `导出了登录状态到 ${STATE_DIR_NAME}/${written.file}（${cookies.length} 个 cookie${origins.length ? "、localStorage" : ""}，含明文值）`,
      label: "导出登录状态",
    });
    return {
      action: "export_state",
      scope: scope.label,
      file: written.file,
      dir: STATE_DIR_NAME,
      bytes: written.bytes,
      cookies: cookies.length,
      origins: origins.map((o) => ({ origin: o.origin, items: o.localStorage.length })),
      ...(storageNote ? { note: storageNote } : {}),
    };
  };

  const importState = async (session, tab, a, ctx, signal, taskId) => {
    const name = strictStateName(a.file);
    if (!name.ok) throw new BrowserError("BAD_ARGS", name.reason);
    let text;
    try {
      text = readStateFile({ fs, dir: stateDir(taskId), base: name.base });
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError("BAD_ARGS", String(err?.message ?? err).slice(0, 200));
    }
    const parsed = parseStateFile(text, { checkUrl: checkUrlSoft, isAppUrl, now: nowMs });
    if (!parsed.ok) throw new BrowserError("BAD_ARGS", `导入文件不合格：${parsed.reason}`);

    const jar = jarOf(tab);
    let set = 0;
    let expired = 0;
    let failed = 0;
    for (const { cookie, url, expired: isExpired } of parsed.cookies) {
      ctx.check?.();
      if (isExpired) {
        expired += 1;
        continue;
      }
      try {
        await abortable(jar.set(toElectronCookie(cookie, url)), signal);
        set += 1;
      } catch {
        failed += 1;
      }
    }

    // localStorage：CDP 只能写「当前页面 origin」，其它 origin 跳过并告诉 AI（先导航过去再导入一次即可补写）
    let site = null;
    try {
      site = siteOf(tab);
    } catch {
      site = null;
    }
    let storageSet = 0;
    const skippedOrigins = [];
    for (const o of parsed.origins) {
      if (!site || o.origin !== site.origin) {
        skippedOrigins.push(o.origin);
        continue;
      }
      if (o.items.length === 0) continue;
      await withDomStorage(tab, "local", signal, async (storageId) => {
        for (const it of o.items) {
          ctx.check?.();
          try {
            await abortable(tab.send("DOMStorage.setDOMStorageItem", { storageId, key: it.name, value: it.value }), signal);
            storageSet += 1;
          } catch (err) {
            if (err?.code === "CANCELLED" || signal?.aborted) throw err;
            failed += 1;
          }
        }
      });
    }
    note(session, tab, ctx, {
      summary: `导入了登录状态 ${STATE_DIR_NAME}/${name.base}.json（${set} 个 cookie${storageSet ? `、${storageSet} 项 localStorage` : ""}）`,
      label: "导入登录状态",
    });
    return {
      action: "import_state",
      file: `${name.base}.json`,
      cookiesSet: set,
      cookiesExpired: expired,
      failed,
      localStorageSet: storageSet,
      skippedOrigins: skippedOrigins.slice(0, 20).map((o) => cleanName(o, 200)),
    };
  };

  const clearSite = async (session, tab, a, ctx, signal) => {
    await abortable(tab.ensureCdp(), signal);
    const site = siteOf(tab);
    const scope = { kind: "site", label: site.host, filter: { url: site.href } };
    const before = await fetchCookies(tab, scope, undefined, signal);
    // 当前页面的 web storage 先用 CDP 清（页面内存里的 DOMStorage 缓存要同步）；失败不影响后面的整站清理
    let webStorageCleared = true;
    for (const area of STORAGE_AREAS) {
      try {
        await withDomStorage(tab, area, signal, (storageId) => abortable(tab.send("DOMStorage.clear", { storageId }), signal));
      } catch (err) {
        if (err?.code === "CANCELLED" || signal?.aborted) throw err;
        webStorageCleared = false;
      }
    }
    ctx.check?.();
    const ses = tab.wc?.session;
    if (!ses || typeof ses.clearStorageData !== "function") throw new BrowserError("UNSUPPORTED", "当前标签页没有可用的站点数据存储");
    // 只清这个 origin：不带 storages = 全部类型（cookie / localStorage / IndexedDB / Cache / ServiceWorker …）
    await abortable(ses.clearStorageData({ origin: site.origin }), signal);
    // 域 cookie（.example.com）不一定被 origin 维度清到：再按 cookie 逐个确认删除
    const jar = jarOf(tab);
    for (const c of await fetchCookies(tab, scope, undefined, signal)) {
      ctx.check?.();
      await abortable(jar.remove(cookieUrlOf(c), c.name), signal);
    }
    const after = await fetchCookies(tab, scope, undefined, signal);
    const removed = Math.max(0, before.length - after.length);
    note(session, tab, ctx, { summary: `清空了 ${site.host} 的站点数据（${removed} 个 cookie 及本地存储 / IndexedDB 等）`, label: "清空站点数据" });
    return { action: "clear_site", origin: site.origin, cookiesRemoved: removed, cookiesRemaining: after.length, webStorageCleared };
  };

  /** 动作分发（读类与动作类共用） */
  const exec = (session, tab, a, ctx, signal, taskId) => {
    switch (a.action) {
      case "cookies_list":
        return cookiesList(session, tab, a, ctx, signal, false);
      case "cookies_get":
        return cookiesList(session, tab, a, ctx, signal, true);
      case "cookies_set":
        return cookiesSet(session, tab, a, ctx, signal);
      case "cookies_delete":
        return cookiesRemove(session, tab, a, ctx, signal, true);
      case "cookies_clear":
        return cookiesRemove(session, tab, a, ctx, signal, false);
      case "storage_list":
        return storageList(session, tab, a, ctx, signal);
      case "storage_get":
        return storageGet(session, tab, a, ctx, signal);
      case "storage_set":
        return storageSet(session, tab, a, ctx, signal);
      case "storage_remove":
        return storageRemove(session, tab, a, ctx, signal);
      case "storage_clear":
        return storageClear(session, tab, a, ctx, signal);
      case "idb_list":
        return idbList(session, tab, a, ctx, signal);
      case "export_state":
        return exportState(session, tab, a, ctx, signal, taskId);
      case "import_state":
        return importState(session, tab, a, ctx, signal, taskId);
      case "clear_site":
        return clearSite(session, tab, a, ctx, signal);
      default:
        throw new BrowserError("BAD_ARGS", `未知的 storage action：${String(a.action).slice(0, 40)}`);
    }
  };

  return {
    storage: async (taskId, a, signal) => {
      const reveal = a.reveal === true;
      // 开关先于会话判断（主进程独立判：不信 server 侧的工具注册）：没开就不该建会话、也不泄漏任何东西
      if (actionNeedsAccess(a.action, reveal) && getConfig()?.storageAccess !== true) throw accessDisabled(a.action, reveal);
      const session = requireSession(taskId);
      if (isWriteAction(a.action)) {
        return session.runAction({ op: "storage", tabId: a.tabId, signal }, (ctx) => {
          // R6-27：在队列里排队等的写操作，用户中途把开关关了——真正执行前再判一次（并行工具调用 + 中途关开关的窗口）
          if (actionNeedsAccess(a.action, reveal) && getConfig()?.storageAccess !== true) throw accessDisabled(a.action, reveal);
          // 先点亮覆盖层（只有 label、没有 summary：失败时不会写活动日志）
          ctx.describe({ label: "处理登录态" });
          return exec(session, ctx.tab, a, ctx, ctx.signal, taskId);
        });
      }
      // 读类：不进队列（与 snapshot / read 一致，用户接管期间 AI 仍能「看」名称与属性）；但明文值在用户接管期间不给
      if (reveal && session.controller === "user") {
        throw new BrowserError("USER_CONTROL", "用户正在接管浏览器，现在不能读取明文值。请等用户交还控制权，或只看名称与属性（不带 reveal）");
      }
      const tab = session.getTab(a.tabId);
      const r = await exec(session, tab, a, null, signal, taskId);
      return { tabId: tab.id, ...r };
    },
  };
};
