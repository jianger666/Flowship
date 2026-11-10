/**
 * 增强包 E2 · B3 源码与问题 op `sources`（契约 §15.2 S5）：list / get / sourcemap / issues，另导出 console 栈 sourcemap 还原。
 *
 * # 与 debug（S6）共用 Debugger 域
 * 脚本表来自 `debugger-hub.mjs`（引用计数）：本模块每次调用按需 `acquire("sources")`、用完 `release`——**绝不直接 `Debugger.disable`**，
 * 即使 `debug` 正在用断点，这里释放也只是少一个使用者。同一 tab 上并发的多次调用在模块内再做一层计数，只对 hub 登记一次。
 *
 * # CSS / Audits 域
 *  - CSS：样式表靠 `CSS.enable` 重放 `styleSheetAdded`；B4（matched_rules）也会用 CSS 域，所以这里**从不 `CSS.disable`**（只在每次调用时幂等地 enable，
 *    事件按 styleSheetId 去重）；DOM 域 tab 初始化时已开。
 *  - Audits：一次性——enable → 等重放静默 → 模块内引用计数归零时 disable；问题进模块私有的去重环形缓冲（100 条），主 frame 导航时清空。
 *
 * # sourcemap（页面可控的不可信输入）
 * map 的获取：只 http(s) / data:，过 `checkAiUrl`（Flowship origin 被拦）、每一跳重定向都重新校验（≤ 3 跳）、体积 ≤ 5MB、超时 10s；
 * map 必须与脚本 / 页面**同 host 且有效端口全等**（R6-35；防「公网页面让主进程去探内网 / 本机其它端口的服务」）；不带 cookie。
 * 生产路径（没注入 `env.fetch`）用 `node:http(s).request` + 自定义 `lookup` 在**连接时**校验并钉住 IP（`createPinnedFetch`），DNS 复核与实际连接之间没有 rebinding 窗口。
 * 解析在 `sourcemap.mjs`（纯函数）。
 * 失败一律降级（返回原因，不抛），AI 仍能拿到生成代码的结果。
 *
 * # 只读感知类
 * 不走 runAction（不切「AI 操作中」、不锁标签输入）；与 `read` / `network` 同属读操作。源码与问题文字是页面内容：
 * 主进程先脱敏再截断（sources-core），server 再过一遍 `redactSensitiveText` + 不可信包装（红线 §15.3-2 / 6）。
 */
import { redactUrlSecrets } from "../net-detail.mjs";
import { BrowserError } from "../server-channel.mjs";
import { getDebuggerHub } from "../debugger-hub.mjs";
import { decodeDataUrlMap, MAX_MAP_BYTES, parseSourceMap, resolveMapUrl, resolveStackFrames, SourceMapError } from "../sourcemap.mjs";
import {
  createIssueRing,
  DEFAULT_GET_CHARS,
  ISSUE_CATEGORIES,
  MAX_GET_CHARS,
  sliceSourceWithLineNumbers,
  summarizeIssues,
} from "../sources-core.mjs";
import { isNonPublicHostname } from "../url-policy.mjs";
import { isLoopbackHostname } from "../app-origin.mjs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export const OPS = Object.freeze(["sources"]);

export const SOURCES_ACTIONS = Object.freeze(["list", "get", "sourcemap", "issues"]);
export const SOURCES_KINDS = Object.freeze(["all", "script", "style"]);

const HUB_OWNER = "sources";
const MAP_FETCH_TIMEOUT_MS = 10_000;
const MAP_MAX_REDIRECTS = 3;
const MAP_CACHE_MAX = 16;
const MAP_FAIL_TTL_MS = 30_000;
const SHEETS_MAX = 500;
const LIST_DEFAULT = 100;
const LIST_MAX = 500;
const ISSUE_QUIET_MS = 150;
const ISSUE_WAIT_MAX_MS = 1000;
/** get 取回的单个源码文本上限：超大 bundle 只切行区间，不整份往外传 */
const SOURCE_HARD_CAP = 30_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 让出事件循环一轮（setImmediate）：同步解析 map 前后各让一次，别让一串大 map 连着霸占主进程 */
const yieldLoop = () => new Promise((r) => setImmediate(r));

/** R6-16：console sourcemap 阶段的总时限 / 并发 / 同步解析体积上限 */
export const CONSOLE_SOURCEMAP_BUDGET_MS = 8000;
export const CONSOLE_SOURCEMAP_CONCURRENCY = 4;
export const CONSOLE_SOURCEMAP_PARSE_CAP = 2 * 1024 * 1024;
const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : String(s ?? ""));

export const normalize = (op, args, h) => {
  switch (op) {
    case "sources": {
      const action = h.reqEnum(args, "action", SOURCES_ACTIONS);
      const url = h.optStr(args, "url", 2000);
      const scriptId = h.optStr(args, "scriptId", 60);
      const o = { action };
      if (action === "list") {
        o.kind = h.optEnum(args, "kind", SOURCES_KINDS, "all");
        if (url !== undefined) o.url = url;
        o.limit = h.optNum(args, "limit", { min: 1, max: LIST_MAX, dflt: LIST_DEFAULT });
      } else if (action === "get" || action === "sourcemap") {
        if (scriptId === undefined && url === undefined) throw h.bad(`${action} 需要 script_id 或 url 之一（先用 list 查看已加载的脚本 / 样式表）`);
        if (scriptId !== undefined) o.scriptId = scriptId;
        if (url !== undefined) o.url = url;
        if (action === "get") {
          const startLine = h.optNum(args, "startLine", { min: 1, max: 100_000_000, dflt: undefined });
          const endLine = h.optNum(args, "endLine", { min: 1, max: 100_000_000, dflt: undefined });
          if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw h.bad("end_line 不能小于 start_line");
          if (startLine !== undefined) o.startLine = startLine;
          if (endLine !== undefined) o.endLine = endLine;
          const column = h.optNum(args, "column", { min: 1, max: 100_000_000, dflt: undefined });
          if (column !== undefined) o.column = column;
          o.maxChars = h.optNum(args, "maxChars", { min: 200, max: MAX_GET_CHARS, dflt: DEFAULT_GET_CHARS });
          o.original = h.optBool(args, "original", false);
        } else {
          // sourcemap：生成位置 → 原始位置（line / column），或原始位置 → 生成位置（source + originalLine）
          for (const k of ["line", "column", "originalLine", "originalColumn"]) {
            const v = h.optNum(args, k, { min: 1, max: 100_000_000, dflt: undefined });
            if (v !== undefined) o[k] = v;
          }
          const source = h.optStr(args, "source", 2000);
          if (source !== undefined) o.source = source;
          if (o.originalLine !== undefined && o.source === undefined) throw h.bad("给了 original_line 还需要 source（原始源文件名，先 sourcemap 不带位置参数查看 sources 列表）");
        }
      } else {
        const types = args?.types;
        if (types !== undefined && types !== null) {
          if (!Array.isArray(types) || types.some((t) => typeof t !== "string")) throw h.bad(`types 必须是字符串数组（可选：${ISSUE_CATEGORIES.join(" / ")}）`);
          const bad = types.filter((t) => !ISSUE_CATEGORIES.includes(t));
          if (bad.length > 0) throw h.bad(`types 含未知类型 ${bad.slice(0, 3).map((t) => JSON.stringify(clip(t, 20))).join(" ")}（可选：${ISSUE_CATEGORIES.join(" / ")}）`);
          if (types.length > 0) o.types = [...new Set(types)];
        }
        o.limit = h.optNum(args, "limit", { min: 1, max: 100, dflt: 30 });
      }
      return h.withTab(args, o);
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

const STATE_KEY = "sources-state";

/** tab 级私有状态（`tab.getExt`；销毁时 `dispose` 摘监听） */
const createTabState = (tab) => {
  const st = {
    users: 0,
    held: null,
    sheets: new Map(),
    nonDefault: new Set(),
    maps: new Map(),
    issues: createIssueRing(),
    auditUsers: 0,
    auditsOn: null,
    issueSeq: 0,
    offs: [],
    dispose() {
      for (const off of st.offs.splice(0)) {
        try {
          off();
        } catch {
          /* 已销毁 */
        }
      }
      st.sheets.clear();
      st.maps.clear();
      st.issues.clear();
    },
  };
  // Audits 事件与「主 frame 导航清空」的监听常驻（很便宜）；Audits 没 enable 时根本不会有事件
  st.offs.push(
    tab.onCdpEvent((method, params, sessionId) => {
      if ((sessionId ?? null) !== null) return;
      if (method === "Debugger.scriptParsed") {
        // hub 不记执行上下文：这里在 acquire 之前就订阅，enable 重放的 scriptParsed 也能看到 isDefault，据此隐藏隔离世界脚本
        if (params?.executionContextAuxData?.isDefault === false && typeof params.scriptId === "string") {
          st.nonDefault.add(`main:${params.scriptId}`);
          while (st.nonDefault.size > 5000) st.nonDefault.delete(st.nonDefault.values().next().value);
        }
      } else if (method === "Audits.issueAdded") {
        if (params?.issue && st.issues.add(params.issue)) st.issueSeq++;
      } else if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
        st.issues.clear();
        st.sheets.clear(); // 旧页面的样式表 id 在新文档里全部失效
      } else if (method === "CSS.styleSheetAdded") {
        const h = params?.header;
        if (!h || typeof h.styleSheetId !== "string" || h.origin === "user-agent" || h.origin === "inspector") return;
        st.sheets.delete(h.styleSheetId);
        st.sheets.set(h.styleSheetId, h);
        while (st.sheets.size > SHEETS_MAX) st.sheets.delete(st.sheets.keys().next().value);
      } else if (method === "CSS.styleSheetRemoved") {
        if (typeof params?.styleSheetId === "string") st.sheets.delete(params.styleSheetId);
      }
    }),
  );
  return st;
};

/**
 * 内网 / 本机地址的 map 只放行与脚本 / 页面同 host（且带端口的受信条目端口全等）的（纯函数，单测直接测）。
 * @param {string} mapHost
 * @param {string[]} trustedHosts 脚本、页面的 `host` 或 `host:port`
 * @param {number | string} [mapPort] map URL 的有效端口（R6-35）；受信条目写了端口而这里没给 → 不匹配
 */
export const mapHostAllowed = (mapHost, trustedHosts, mapPort) => {
  if (!isNonPublicHostname(mapHost)) return true;
  return trustedMatch(mapHost, mapPort, trustedHosts);
};

// ───────────────────────── R6-05 / R6-35：map 必须与脚本 / 页面同 host + 同端口 + 解析后 IP 复核（连接时钉 IP） ─────────────────────────
// 只按「主机名字面」判内网会被 DNS 别名绕过：`169.254.169.254.nip.io` / `localtest.me` / `127.0.0.1.sslip.io` 字面是公网，主进程 fetch 却连到内网 / 本机。
// 所以：①map 的 hostname **与有效端口**必须与「脚本所在 host:port 或页面 host:port」完全一致（跨 host / 同 host 不同端口——含公网 CDN——一律不拉；
// 否则 `localhost:3000` 的页面能让主进程去探 `localhost:6379` 之类本机其它服务）；②同 host 也要解析 DNS，任一结果落在
// 回环 / 私网 / 链路本地 / 元数据地址就拒绝；唯一例外是页面本身就在 localhost 开发站（用户预览自己的 localhost:3000，host 与端口都全等的 map 放行）。
// 重定向每一跳都重走这套。
// R6-35：「Node 全局 fetch 无法钉 IP」只对 `globalThis.fetch` 成立；`http(s).request({ lookup })` 能在**真正建连时**解析并校验——生产路径（没注入
// `env.fetch`）走 `createPinnedFetch`：lookup 回调里对全部解析结果做同一套内网判定、通过才把校验过的地址交给 socket，所以预检的 DNS 复核与
// 连接之间没有 rebinding 窗口（预检保留，仅为尽早给出好错误）。注入 `env.fetch` 的路径（单测）无法钉 IP，仍是「预检」口径。

/** 跨 host 的 map：不拉、不算失败（调用方据此计数「跳过」） */
export class CrossHostMapError extends SourceMapError {
  constructor() {
    super("跨域 sourcemap 已跳过（map 主机 / 端口与脚本 / 页面不一致）");
    this.name = "CrossHostMapError";
  }
}

const normHost = (h) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

const DEFAULT_PORTS = { "http:": 80, "https:": 443 };

/** URL 的有效端口：显式端口，否则按协议默认（http=80 / https=443）；非 http(s) 返回 null（`new URL` 已把 `:443` 之类的默认端口归一成空串） */
const effectivePortOf = (u) => (u.port !== "" ? Number(u.port) : (DEFAULT_PORTS[u.protocol] ?? null));

/**
 * 受信条目 → { host（已 normHost）, port（数字或 null）}。条目可写 `host` 或 `host:port`（IPv6：`[::1]:3000`；裸 `::1` 当纯 host）。
 * 只有写了端口才比端口（兼容只给 hostname 的调用方）。
 */
const parseTrusted = (entry) => {
  const s = String(entry ?? "")
    .trim()
    .toLowerCase();
  let m = /^\[([^\]]*)\](?::(\d{1,5}))?$/.exec(s);
  if (m) return { host: normHost(m[1]), port: m[2] === undefined ? null : Number(m[2]) };
  m = /^([^:]*):(\d{1,5})$/.exec(s);
  if (m) return { host: normHost(m[1]), port: Number(m[2]) };
  return { host: normHost(s), port: null };
};

/** map（host + 有效端口）是否命中某个受信条目：host 全等；条目带端口时端口也要全等（调用方没给端口 → 不匹配，fail-closed） */
const trustedMatch = (mapHost, mapPort, trustedHosts) => {
  const h = normHost(mapHost);
  if (h === "") return false;
  const p = mapPort === undefined || mapPort === null || mapPort === "" ? null : Number(mapPort);
  return (trustedHosts ?? []).some((e) => {
    const t = parseTrusted(e);
    if (t.host === "" || t.host !== h) return false;
    return t.port === null || (p !== null && p === t.port);
  });
};

/** 「页面 host」（只取 hostname 部分）：优先 pageHost，缺省取受信列表最后一项（loadMap 里是页面） */
const pageHostOf = (o) => {
  const list = (o.trustedHosts ?? []).filter((e) => parseTrusted(e).host !== "");
  return parseTrusted(o.pageHost ?? list[list.length - 1] ?? "").host;
};

/** 单个 IP（dns.lookup 的结果，IPv6 不带方括号）是否落在非公网段：回环 / 私网 / 链路本地 / 169.254.x（含元数据）/ CGNAT / 唯一本地 / 映射地址 */
export const isPrivateIp = (ip) => {
  const s = String(ip ?? "").toLowerCase();
  return isNonPublicHostname(s.includes(":") ? `[${s}]` : s);
};

const defaultLookup = (host, opts) => dns.promises.lookup(host, opts);

/**
 * 同 host（+ 端口）校验 + 解析复核（失败抛 SourceMapError；跨 host / 跨端口抛 CrossHostMapError）。
 * @param {string} hostname  map URL 的 hostname
 * @param {{ trustedHosts?: string[], pageHost?: string, port?: number | string, lookup?: (host: string, opts: object) => Promise<any>, isPrivateIp?: (ip: string) => boolean }} o
 *   trustedHosts / pageHost 的条目写 `host` 或 `host:port`——写了端口才比端口（此时 `port`＝map URL 的有效端口必须给，缺省按不匹配）；
 *   lookup / isPrivateIp 可注入（单测）
 */
export const assertMapHostSafe = async (hostname, o = {}) => {
  const h = normHost(hostname);
  if (h === "" || !trustedMatch(h, o.port, o.trustedHosts)) throw new CrossHostMapError();
  if (!mapHostAllowed(hostname, o.trustedHosts ?? [], o.port)) throw new SourceMapError("source map 指向内网 / 本机地址，且与脚本不同主机，已拒绝");
  const priv = o.isPrivateIp ?? isPrivateIp;
  // 页面自己就在 localhost 开发站：同 host（且端口已在上面比过）的 map 放行（app-origin.mjs 头注释：用户预览自己的 localhost:3000 必须可用；Flowship 自己的端口已被 checkAiUrl 拦）
  if (h === pageHostOf(o) && isLoopbackHostname(h)) return;
  if (net.isIP(h)) {
    if (priv(h)) throw new SourceMapError("source map 主机是内网 / 本机地址（页面不在本机开发站），已拒绝");
    return;
  }
  let recs;
  try {
    recs = await (o.lookup ?? defaultLookup)(h, { all: true, verbatim: true });
  } catch (err) {
    throw new SourceMapError(`无法解析 source map 主机：${clip(String(err?.code ?? err?.message ?? err), 60)}`);
  }
  const list = Array.isArray(recs) ? recs : recs ? [recs] : [];
  if (list.length === 0) throw new SourceMapError("无法解析 source map 主机（没有 DNS 结果）");
  if (list.some((r) => priv(typeof r === "string" ? r : r?.address))) throw new SourceMapError("source map 主机解析到内网 / 本机地址，已拒绝");
};

// ───────────────────────── R6-35：连接时钉 IP 的 fetch（node:http / node:https + 自定义 lookup） ─────────────────────────

const REBIND_MSG = "source map 主机在连接时解析到内网 / 本机地址，已拒绝（DNS rebinding 防护）";

/** 解析并校验：任一结果落内网（loopback 例外：只允许全是回环）→ 抛 SourceMapError；返回 [{ address, family }] */
const resolvePinned = async (hostname, o) => {
  const priv = o.isPrivateIp ?? isPrivateIp;
  const loop = o.loopbackHost?.(hostname) === true;
  let recs;
  try {
    recs = await (o.lookup ?? defaultLookup)(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SourceMapError(`无法解析 source map 主机：${clip(String(err?.code ?? err?.message ?? err), 60)}`);
  }
  const list = (Array.isArray(recs) ? recs : recs ? [recs] : []).map((r) => {
    const address = typeof r === "string" ? r : r?.address;
    return { address, family: typeof r === "object" && r?.family ? r.family : String(address).includes(":") ? 6 : 4 };
  });
  if (list.length === 0 || list.some((r) => typeof r.address !== "string" || r.address === "")) throw new SourceMapError("无法解析 source map 主机（没有 DNS 结果）");
  if (list.some((r) => (loop ? !isLoopbackHostname(r.address) : priv(r.address)))) throw new SourceMapError(REBIND_MSG);
  return list;
};

/** net.connect 的 lookup 回调形态（`all: true` 时回调数组，Node ≥ 20 的 autoSelectFamily 会这样调）：只把校验过的地址交给 socket */
const pinnedLookup = (o) => (hostname, options, cb) => {
  const callback = typeof options === "function" ? options : cb;
  const wantAll = typeof options === "object" && options !== null && options.all === true;
  resolvePinned(hostname, o).then(
    (list) => (wantAll ? callback(null, list) : callback(null, list[0].address, list[0].family)),
    (err) => callback(err),
  );
};

/** IncomingMessage → fetch 风格的最小 Response（status / ok / headers.get / body.getReader / body.cancel）；gzip / deflate / br 解压后再交给限量读取 */
const toFetchResponse = (res) => {
  const enc = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  let stream = res;
  let destroy = (err) => res.destroy(err);
  const z = enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip() : enc === "deflate" ? zlib.createInflate() : enc === "br" ? zlib.createBrotliDecompress() : null;
  if (z) {
    res.on("error", (err) => z.destroy(err));
    res.pipe(z);
    stream = z;
    destroy = (err) => {
      res.destroy(err);
      z.destroy(err);
    };
  }
  // 没人读的流出错（被取消 / 超时销毁）不能变成 unhandledRejection / uncaughtException
  stream.on("error", () => {});
  const status = res.statusCode ?? 0;
  const iterator = () => stream[Symbol.asyncIterator]();
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => {
        const v = res.headers[String(k).toLowerCase()];
        return Array.isArray(v) ? v.join(", ") : (v ?? null);
      },
    },
    body: {
      getReader() {
        const it = iterator();
        return {
          read: async () => {
            const r = await it.next();
            return r.done ? { done: true, value: undefined } : { done: false, value: r.value };
          },
          cancel: async () => destroy(),
        };
      },
      cancel: async () => destroy(),
    },
  };
};

/**
 * 造一个 fetch 风格函数（只实现 `fetchMapText` 用到的子集）：`http(s).request` + 自定义 `lookup`，在真正建连时解析并校验 IP、用校验过的地址连接，
 * 所以「DNS 复核 → 连接」之间没有 rebinding 窗口。语义与 `fetch(url, { redirect: "manual", credentials: "omit", signal })` 对齐：不跟随重定向、
 * 不带 cookie / 认证头、`signal` 取消即销毁请求；每次新建连接（`agent: false`，不复用 keep-alive 连接，保证每一跳都过 lookup）。
 * @param {{ lookup?: (host: string, opts: object) => Promise<any>, isPrivateIp?: (ip: string) => boolean, loopbackHost?: (hostname: string) => boolean }} [o]
 *   lookup / isPrivateIp 可注入（单测）；loopbackHost(hostname)：页面本身在 localhost 开发站且 host 全等时返回 true——此时解析结果必须**全是回环**才放行
 * @returns {(href: string, init?: { signal?: AbortSignal, headers?: Record<string, string> }) => Promise<any>}
 */
export const createPinnedFetch =
  (o = {}) =>
  (href, init = {}) =>
    new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(href);
      } catch {
        reject(new SourceMapError("source map 地址无法解析"));
        return;
      }
      const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
      if (!mod) {
        reject(new SourceMapError("source map 只支持 http(s) 地址"));
        return;
      }
      const hostname = normHost(u.hostname);
      // IP 字面量：net 不会为它调 lookup，这里直接按同一口径校验
      if (net.isIP(hostname)) {
        const loop = o.loopbackHost?.(hostname) === true;
        if (loop ? !isLoopbackHostname(hostname) : (o.isPrivateIp ?? isPrivateIp)(hostname)) {
          reject(new SourceMapError(REBIND_MSG));
          return;
        }
      }
      let req;
      try {
        req = mod.request(
          {
            hostname,
            port: effectivePortOf(u),
            path: `${u.pathname}${u.search}`,
            method: "GET",
            agent: false,
            lookup: pinnedLookup(o),
            signal: init.signal,
            headers: { ...init.headers, "accept-encoding": "gzip, deflate, br" },
          },
          (res) => resolve(toFetchResponse(res)),
        );
      } catch (err) {
        reject(err);
        return;
      }
      req.on("error", reject);
      req.end();
    });

/**
 * 取 map 文本：逐跳校验 URL / 主机策略，限时限量，不带凭据。失败抛 SourceMapError（调用方降级，不当作 op 失败）。
 * @param {string} startUrl 绝对 http(s) 地址
 * @param {{ checkAiUrl: (u: string) => string, fetch?: typeof fetch, trustedHosts?: string[], pageHost?: string, lookup?: Function, isPrivateIp?: (ip: string) => boolean, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number }} env
 *   signal：外部取消（console 阶段的总时限 / 任务取消）；lookup / isPrivateIp：DNS 解析与内网判定（单测注入，预检与连接时钉 IP 共用）；
 *   trustedHosts / pageHost 条目写 `host` 或 `host:port`（写了端口才比端口，见 assertMapHostSafe）；
 *   fetch：没注入（生产）→ 用 `createPinnedFetch` 在连接时钉 IP；注入了（单测）→ 用注入的，仅有预检
 */
export const fetchMapText = async (startUrl, env) => {
  if (env.fetch !== undefined && typeof env.fetch !== "function") throw new SourceMapError("当前环境不支持取 source map（没有 fetch）");
  const pageHost = pageHostOf(env);
  const fetchFn =
    env.fetch ??
    createPinnedFetch({
      lookup: env.lookup,
      isPrivateIp: env.isPrivateIp,
      loopbackHost: (hostname) => normHost(hostname) === pageHost && isLoopbackHostname(hostname),
    });
  const maxBytes = env.maxBytes ?? MAX_MAP_BYTES;
  const ctrl = new AbortController();
  const ext = env.signal;
  const onExtAbort = () => ctrl.abort();
  if (ext) {
    if (ext.aborted) throw new SourceMapError("取 source map 已取消");
    ext.addEventListener("abort", onExtAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), env.timeoutMs ?? MAP_FETCH_TIMEOUT_MS);
  try {
    let cur = startUrl;
    for (let hop = 0; hop <= MAP_MAX_REDIRECTS; hop++) {
      let href;
      try {
        href = env.checkAiUrl(cur);
      } catch (err) {
        throw new SourceMapError(`source map 地址被策略拒绝：${clip(String(err?.message ?? err), 120)}`);
      }
      const u = new URL(href);
      // R6-05 / R6-35：同 host + 同有效端口 + 解析复核（初始地址与每一跳重定向都过；跨 host / 跨端口的 map 直接跳过）
      await assertMapHostSafe(u.hostname, { trustedHosts: env.trustedHosts, pageHost: env.pageHost, port: effectivePortOf(u), lookup: env.lookup, isPrivateIp: env.isPrivateIp });
      if (ctrl.signal.aborted) throw new SourceMapError(ext?.aborted ? "取 source map 已取消" : "取 source map 超时");
      let res;
      try {
        res = await fetchFn(href, { redirect: "manual", signal: ctrl.signal, credentials: "omit", headers: { accept: "application/json, */*;q=0.5" } });
      } catch (err) {
        if (!ctrl.signal.aborted && err instanceof SourceMapError) throw err; // 连接时钉 IP 的拒绝原因（rebinding / 解析失败）原样带出
        throw new SourceMapError(ctrl.signal.aborted ? (ext?.aborted ? "取 source map 已取消" : "取 source map 超时") : `取 source map 失败：${clip(String(err?.message ?? err), 100)}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.("location");
        if (!loc) throw new SourceMapError(`source map 返回了 ${res.status} 但没有 Location`);
        try {
          cur = new URL(loc, href).href;
        } catch {
          throw new SourceMapError("source map 重定向地址无法解析");
        }
        try {
          await res.body?.cancel?.();
        } catch {
          /* 忽略 */
        }
        continue;
      }
      if (!res.ok) throw new SourceMapError(`source map 返回 HTTP ${res.status}`);
      const len = Number(res.headers?.get?.("content-length"));
      if (Number.isFinite(len) && len > maxBytes) throw new SourceMapError(`source map 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (err) {
            throw new SourceMapError(ctrl.signal.aborted ? (ext?.aborted ? "取 source map 已取消" : "取 source map 超时") : `读取 source map 失败：${clip(String(err?.message ?? err), 100)}`);
          }
          const { done, value } = chunk;
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              /* 忽略 */
            }
            throw new SourceMapError(`source map 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
          }
          chunks.push(value);
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      }
      const text = await res.text();
      if (text.length > maxBytes) throw new SourceMapError(`source map 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
      return text;
    }
    throw new SourceMapError(`source map 重定向超过 ${MAP_MAX_REDIRECTS} 跳`);
  } finally {
    clearTimeout(timer);
    ext?.removeEventListener("abort", onExtAbort);
    ctrl.abort(); // 收尾：没读完 / 没消费的响应（非 2xx、超限、报错）连同 socket 一并销毁，别留悬挂连接
  }
};

/** URL → `host:有效端口`（IPv6 保留方括号；非 http(s) / 解析失败 → ""）：loadMap 传给 fetchMapText 的受信条目，map 必须 host 与端口都全等 */
const hostPortOfUrl = (u) => {
  try {
    const url = new URL(u);
    const port = effectivePortOf(url);
    return url.hostname && port !== null ? `${url.hostname}:${port}` : "";
  } catch {
    return "";
  }
};

const stripHash = (u) => String(u ?? "").split("#")[0];

/**
 * 不给 AI 看的脚本：隔离世界里的脚本（Flowship 自己注入的页内脚本 / 扩展内容脚本，`executionContextAuxData.isDefault === false`）
 * 与 Electron 自己的内部脚本（`electron/js2c/…`、`node:` …）。它们不是「页面的源码」，列出来只会误导。
 */
const isHiddenScript = (s, st) =>
  st.nonDefault.has(`${s.sessionId ?? "main"}:${s.scriptId}`) ||
  /^(electron\/|node:|chrome-extension:|devtools:)/.test(s.url ?? "") ||
  // 无 url 且 ≤ 8 字符的动态脚本（`void 0` 之类的探测 / 心跳）：不是页面代码，只会让 <eval> 列表充满噪声
  (!s.url && Number.isFinite(s.length) && s.length <= 8);

/** 脚本条目的展示形态（脱敏 URL、是否有 map、动态脚本占位；内联脚本的 url 是文档 URL，加 inline 标记） */
const scriptItem = (s, pageUrl = "") => ({
  id: s.scriptId,
  kind: "script",
  url: s.url ? clip(redactUrlSecrets(s.url), 300) : (s.startLine > 0 || s.startColumn > 0 ? "<inline>" : "<eval>"),
  length: Number.isFinite(s.length) ? s.length : undefined,
  sourceMap: s.sourceMapURL !== undefined,
  ...(s.isModule ? { module: true } : {}),
  ...(s.url && pageUrl && stripHash(s.url) === stripHash(pageUrl) && (s.startLine > 0 || s.startColumn > 0) ? { inline: true } : {}),
});

const sheetItem = (h) => ({
  id: `css:${h.styleSheetId}`,
  kind: "style",
  url: h.sourceURL ? clip(redactUrlSecrets(h.sourceURL), 300) : h.isInline ? "<inline style>" : "<constructed style>",
  length: Number.isFinite(h.length) ? h.length : undefined,
  sourceMap: typeof h.sourceMapURL === "string" && h.sourceMapURL !== "",
  ...(h.isInline ? { inline: true } : {}),
});

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖：requireSession / checkAiUrl / log / fetch(测试注入)
 */
export const createHandlers = (deps) => {
  const log = (m) => deps.log?.(m);
  const stateOf = (tab) => tab.getExt(STATE_KEY, () => createTabState(tab));

  /** 在持有 hub 的期间执行 fn；同 tab 并发调用共用一次 acquire，最后一个走时才 release */
  const withHub = async (tab, fn) => {
    const st = stateOf(tab);
    const hub = getDebuggerHub(tab, { log });
    st.users++;
    try {
      if (!st.held) st.held = hub.acquire(HUB_OWNER);
      try {
        await st.held;
      } catch (err) {
        st.held = null;
        throw new BrowserError("INTERNAL", `无法启用调试器域读取脚本：${clip(String(err?.message ?? err), 120)}（页面可能正在导航，稍后重试）`);
      }
      return await fn(hub);
    } finally {
      st.users--;
      if (st.users === 0) {
        st.held = null;
        await hub.release(HUB_OWNER).catch(() => {});
      }
    }
  };

  const ensureCss = async (tab) => {
    const st = stateOf(tab);
    try {
      await tab.send("CSS.enable", {});
    } catch (err) {
      log(`[browser:sources] CSS.enable 失败（样式表列不出来）：${err?.message || err}`);
    }
    return st;
  };

  const trustedHostsOf = (tab, entryUrl) => [hostPortOfUrl(entryUrl), hostPortOfUrl(tab.url)];

  /**
   * 取并解析某条目的 sourcemap；失败返回 { map:null, reason } 而不抛。
   * opts.signal：外部取消（console 阶段总时限）；opts.maxParseBytes：超过就拒绝同步解析（console 路径 2MB）；
   * 取完与解析后各让出一次事件循环（R6-16：parseSourceMap 是同步的，别连着卡主进程）。
   * @returns {Promise<{ map: any, reason: string, mapUrl?: string, crossHost?: boolean }>}
   */
  const loadMap = async (tab, entry, opts = {}) => {
    const st = stateOf(tab);
    const mapUrl = resolveMapUrl(entry.sourceMapURL, entry.url);
    if (!mapUrl) return { map: null, reason: "该脚本没有可解析的 sourceMappingURL" };
    const cap = opts.maxParseBytes;
    const key = `${mapUrl.slice(0, 300)}#${mapUrl.length}${cap ? "#c" : ""}`;
    const hit = st.maps.get(key);
    if (hit && (hit.map || Date.now() - hit.at < MAP_FAIL_TTL_MS)) return { map: hit.map, reason: hit.reason, mapUrl, ...(hit.crossHost ? { crossHost: true } : {}) };
    let map = null;
    let reason = "";
    let crossHost = false;
    let transient = false; // 被取消 / 总时限打断的失败不进缓存（下次有预算时应当能重试）
    try {
      const inline = decodeDataUrlMap(mapUrl);
      if (inline && cap && inline.length > cap) throw new SourceMapError(`source map 超过 ${Math.round(cap / 1024 / 1024)}MB，已拒绝同步解析`);
      const text =
        inline ??
        (await fetchMapText(mapUrl, {
          checkAiUrl: deps.checkAiUrl,
          fetch: deps.fetch,
          lookup: deps.lookup,
          signal: opts.signal,
          trustedHosts: trustedHostsOf(tab, entry.url),
          pageHost: hostPortOfUrl(tab.url),
          ...(cap ? { maxBytes: Math.min(cap, MAX_MAP_BYTES) } : {}),
        }));
      await yieldLoop();
      if (opts.signal?.aborted) throw new SourceMapError("取 source map 已取消");
      map = parseSourceMap(text);
      await yieldLoop();
    } catch (err) {
      crossHost = err instanceof CrossHostMapError;
      transient = opts.signal?.aborted === true;
      reason = err instanceof SourceMapError ? err.message : `source map 处理失败：${clip(String(err?.message ?? err), 100)}`;
    }
    if (!transient) {
      st.maps.delete(key);
      st.maps.set(key, { map, reason, at: Date.now(), crossHost });
      while (st.maps.size > MAP_CACHE_MAX) st.maps.delete(st.maps.keys().next().value);
    }
    return { map, reason, mapUrl, ...(crossHost ? { crossHost: true } : {}) };
  };

  const originalAt = (map, line, column) => {
    const pos = map.originalPositionFor(line - 1, column - 1);
    if (!pos) return null;
    const content = map.sourceContentFor(pos.source);
    const around = content
      ? sliceSourceWithLineNumbers(content, { startLine: Math.max(1, pos.line + 1 - 2), endLine: pos.line + 1 + 2, column: pos.column + 1, maxChars: 3000 })
      : null;
    return {
      source: clip(redactUrlSecrets(pos.source), 300),
      line: pos.line + 1,
      column: pos.column + 1,
      ...(pos.name ? { name: clip(pos.name, 80) } : {}),
      snippet: around ? around.text : null,
    };
  };

  /** 按 script_id / url 找条目（脚本在 hub 表里、样式表在 tab 状态里）；找不到 / 多义抛带候选的 BAD_ARGS */
  const findEntry = (tab, hub, a) => {
    const st = stateOf(tab);
    const scripts = hub
      .scripts()
      .filter((s) => !isHiddenScript(s, st))
      .map((s) => ({ raw: s, item: scriptItem(s, tab.url), type: "script" }));
    const sheets = [...st.sheets.values()].map((h) => ({ raw: h, item: sheetItem(h), type: "style" }));
    const all = [...scripts, ...sheets];
    if (a.scriptId !== undefined) {
      const found = all.find((e) => e.item.id === a.scriptId);
      if (!found) throw new BrowserError("BAD_ARGS", `没有 id 为 ${JSON.stringify(clip(a.scriptId, 30))} 的脚本 / 样式表（页面可能已导航；先 list 看现状）`);
      return found;
    }
    const want = String(a.url);
    const exact = all.filter((e) => e.item.url === want);
    const pool = exact.length > 0 ? exact : all.filter((e) => e.item.url.includes(want));
    if (pool.length === 0) throw new BrowserError("BAD_ARGS", `没有 url 匹配 ${JSON.stringify(clip(want, 80))} 的脚本 / 样式表（先 list 看已加载的资源）`);
    if (exact.length === 0 && pool.length > 1) {
      const cands = pool.slice(-8).map((e) => `${e.item.id} ${clip(e.item.url, 100)}`);
      throw new BrowserError("BAD_ARGS", `url 匹配到 ${pool.length} 个资源，请改用 script_id 指定：\n${cands.join("\n")}`);
    }
    return pool[pool.length - 1]; // 同一 url 加载过多次（刷新 / 重复注入）：取最新的
  };

  const readSource = async (tab, hub, e) => {
    let text = "";
    if (e.type === "script") text = await hub.getScriptSource(e.raw.scriptId, e.raw.sessionId ?? null);
    else {
      const r = await tab.send("CSS.getStyleSheetText", { styleSheetId: e.raw.styleSheetId });
      text = typeof r?.text === "string" ? r.text : "";
    }
    return text.length > SOURCE_HARD_CAP ? text.slice(0, SOURCE_HARD_CAP) : text;
  };

  const doList = async (tab, a) => {
    const wantScripts = a.kind !== "style";
    const wantStyles = a.kind !== "script";
    let items = [];
    let hubOk = true;
    if (wantScripts) {
      try {
        await withHub(tab, async (hub) => {
          const st = stateOf(tab);
          items.push(...hub.scripts().filter((s) => !isHiddenScript(s, st)).map((s) => scriptItem(s, tab.url)));
        });
      } catch (err) {
        if (a.kind === "script") throw err;
        hubOk = false;
      }
    }
    if (wantStyles) {
      const st = await ensureCss(tab);
      items.push(...[...st.sheets.values()].map(sheetItem));
    }
    if (a.url) {
      const w = a.url.toLowerCase();
      items = items.filter((i) => i.url.toLowerCase().includes(w));
    }
    const total = items.length;
    const shown = items.slice(-a.limit);
    return {
      action: "list",
      items: shown,
      total,
      omitted: total - shown.length,
      scriptCount: items.filter((i) => i.kind === "script").length,
      styleCount: items.filter((i) => i.kind === "style").length,
      ...(hubOk ? {} : { scriptsUnavailable: true }),
    };
  };

  const doGetOrMap = async (tab, a) => {
    await ensureCss(tab);
    return withHub(tab, async (hub) => {
      const e = findEntry(tab, hub, a);
      const mapUrl = e.type === "script" ? e.raw.sourceMapURL : e.raw.sourceMapURL;
      if (a.action === "sourcemap") {
        if (!mapUrl) return { action: "sourcemap", id: e.item.id, url: e.item.url, hasSourceMap: false };
        const { map, reason, mapUrl: abs } = await loadMap(tab, { url: e.type === "script" ? e.raw.url : e.raw.sourceURL, sourceMapURL: mapUrl });
        const base = { action: "sourcemap", id: e.item.id, url: e.item.url, hasSourceMap: true, mapUrl: abs && !/^data:/i.test(abs) ? clip(redactUrlSecrets(abs), 300) : "(内联 data: map)" };
        if (!map) return { ...base, loaded: false, reason };
        const out = {
          ...base,
          loaded: true,
          sourcesCount: map.sources.length,
          sources: map.sources.slice(0, 50).map((s) => clip(redactUrlSecrets(s), 200)),
          segmentCount: map.segmentCount,
          withContent: map.sourcesContent.filter((c) => c !== null).length,
        };
        if (a.line !== undefined) {
          out.mapped = originalAt(map, a.line, a.column ?? 1);
          out.query = { line: a.line, column: a.column ?? 1 };
        }
        if (a.source !== undefined && a.originalLine !== undefined) {
          const g = map.generatedPositionFor({ source: map.sources.find((s) => s === a.source || s.endsWith(a.source)) ?? a.source, line: a.originalLine - 1, column: (a.originalColumn ?? 1) - 1 });
          out.generated = g ? { line: g.line + 1, column: g.column + 1 } : null;
        }
        return out;
      }
      const src = await readSource(tab, hub, e);
      const slice = sliceSourceWithLineNumbers(src, { startLine: a.startLine, endLine: a.endLine, column: a.column, maxChars: a.maxChars });
      const out = { action: "get", id: e.item.id, kind: e.item.kind, url: e.item.url, hasSourceMap: Boolean(mapUrl), ...slice };
      if (a.original) {
        if (!mapUrl) out.original = { available: false, reason: "该资源没有 sourceMappingURL" };
        else {
          const { map, reason } = await loadMap(tab, { url: e.type === "script" ? e.raw.url : e.raw.sourceURL, sourceMapURL: mapUrl });
          if (!map) out.original = { available: false, reason };
          else {
            const pos = originalAt(map, slice.startLine, a.column ?? 1);
            out.original = pos ? { available: true, ...pos } : { available: false, reason: "该位置在 source map 里没有映射（可用 column 指向代码所在列）" };
          }
        }
      }
      return out;
    });
  };

  const doIssues = async (tab, a) => {
    const st = stateOf(tab);
    st.auditUsers++;
    try {
      if (st.auditUsers === 1 || !st.auditsOn) {
        st.auditsOn = tab.send("Audits.enable", {}).catch((err) => {
          st.auditsOn = null;
          throw new BrowserError("INTERNAL", `无法启用 Audits 域：${clip(String(err?.message ?? err), 120)}`);
        });
      }
      await st.auditsOn;
      // enable 会把已收集的问题重放成 issueAdded 事件；等一小段「静默」再汇总
      const t0 = Date.now();
      let seen = st.issueSeq;
      for (;;) {
        await sleep(ISSUE_QUIET_MS);
        if (st.issueSeq === seen || Date.now() - t0 > ISSUE_WAIT_MAX_MS) break;
        seen = st.issueSeq;
      }
    } finally {
      st.auditUsers--;
      if (st.auditUsers === 0) {
        st.auditsOn = null;
        await tab.send("Audits.disable", {}).catch(() => {});
      }
    }
    const sum = summarizeIssues(st.issues.list(), { types: a.types, limit: a.limit });
    return { action: "issues", ...sum, dropped: st.issues.dropped };
  };

  /**
   * console 栈 sourcemap 还原（index.mjs 的 opConsole 调用，**不是 op**：名字不在 OPS 里，dispatch 够不到）。
   * 失败 / 没有 map 的帧原样保留；整体失败返回原 entries + note，永不抛。
   *
   * R6-16：整个 sourcemap 阶段有总时限（默认 8s，超时直接返回已解析的部分并在 note 注明）、并发 ≤ 4、单 map ≤ 2MB 才同步解析、
   * 每张解析前后让出事件循环、`opts.signal`（任务取消）能中断；收尾写一条脱敏活动日志（经 `opts.activity`）。
   * @param {any} tab
   * @param {any[]} entries
   * @param {{ signal?: AbortSignal, activity?: (summary: string) => void }} [opts]
   * @returns {Promise<{ entries: any[], note?: string, resolvedFrames: number }>}
   */
  const resolveConsoleStacks = async (tab, entries, opts = {}) => {
    const urls = new Set();
    for (const e of entries) for (const f of e.stack ?? []) if (f.url) urls.add(f.url);
    if (urls.size === 0) return { entries, note: "这些控制台条目没有结构化栈（只有 console.error / 未捕获异常带栈）", resolvedFrames: 0 };
    const maps = new Map();
    let note;
    const notes = [];
    let loaded = 0;
    let skipped = 0;
    let crossHost = 0;
    let total = 0;
    let timedOut = false;
    const budgetMs = deps.sourcemapBudgetMs ?? CONSOLE_SOURCEMAP_BUDGET_MS;
    const ctrl = new AbortController();
    const outer = opts.signal;
    const onOuter = () => ctrl.abort();
    if (outer) {
      if (outer.aborted) ctrl.abort();
      else outer.addEventListener("abort", onOuter, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, budgetMs);
    try {
      await withHub(tab, async (hub) => {
        const scripts = hub.scripts();
        const targets = [];
        for (const url of [...urls].slice(0, 20)) {
          // 条目里存的是脱敏后的 URL：按脱敏后的脚本 URL 匹配，取最新的
          const s = [...scripts].reverse().find((x) => x.url && redactUrlSecrets(x.url) === url);
          if (!s || !s.sourceMapURL) continue;
          targets.push({ url, s });
        }
        total = targets.length;
        let cursor = 0;
        let settled = false; // 总时限 / 取消后 worker 可能还在收尾：之后的结果一律丢弃，不再改 maps / 计数
        const worker = async () => {
          while (!ctrl.signal.aborted) {
            const t = targets[cursor++];
            if (!t) return;
            const r = await loadMap(tab, t.s, { signal: ctrl.signal, maxParseBytes: CONSOLE_SOURCEMAP_PARSE_CAP });
            if (settled) return;
            if (r.map) {
              maps.set(t.url, r.map);
              loaded++;
            } else {
              skipped++;
              if (r.crossHost) crossHost++;
              else if (r.reason && !ctrl.signal.aborted) notes.push(r.reason);
            }
          }
        };
        if (!ctrl.signal.aborted && total > 0) {
          const aborted = new Promise((res) => ctrl.signal.addEventListener("abort", res, { once: true }));
          const pool = Promise.all(Array.from({ length: Math.min(CONSOLE_SOURCEMAP_CONCURRENCY, total) }, () => worker().catch(() => {})));
          await Promise.race([pool, aborted]);
        }
        settled = true;
        skipped += Math.max(0, total - loaded - skipped); // 没来得及处理的（超时 / 取消）也算跳过
      });
    } catch (err) {
      return { entries, note: `还原失败，已显示原始栈：${clip(String(err?.message ?? err), 100)}`, resolvedFrames: 0 };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
    if (total > 0) {
      try {
        opts.activity?.(`已取 ${loaded} 张 sourcemap（跳过 ${skipped}）`);
      } catch {
        /* 日志是旁路 */
      }
    }
    if (crossHost > 0) notes.unshift(`跨域 sourcemap 已跳过（${crossHost} 张：map 主机与脚本 / 页面主机不一致）`);
    if (timedOut) notes.push(`sourcemap 阶段超过 ${Math.round(budgetMs / 1000)}s 总时限，已返回已解析的 ${loaded}/${total} 张`);
    else if (outer?.aborted) notes.push("sourcemap 阶段已取消，已返回已解析的部分");
    if (notes.length > 0) note = clip([...new Set(notes)].slice(0, 3).join("；"), 400);
    let resolvedFrames = 0;
    const out = entries.map((e) => {
      if (!Array.isArray(e.stack)) return e;
      // sourcemap 的位置是 0 起；对外统一成 1 起（与 original / sourcemap action 同口径），源文件名过脱敏
      const frames = resolveStackFrames(e.stack, (u) => maps.get(u)).map((f) =>
        f.original
          ? { ...f, original: { source: clip(redactUrlSecrets(f.original.source), 200), line: f.original.line + 1, column: f.original.column + 1, ...(f.original.name ? { name: clip(f.original.name, 80) } : {}) } }
          : f,
      );
      resolvedFrames += frames.filter((f) => f.original).length;
      return { ...e, stack: frames };
    });
    if (resolvedFrames === 0 && maps.size === 0) note ??= "没有找到带 sourceMappingURL 的脚本（页面可能已导航，或打包产物没有 source map）";
    return { entries: out, ...(note ? { note } : {}), resolvedFrames };
  };

  return {
    sources: async (taskId, a) => {
      const session = deps.requireSession(taskId);
      const tab = session.getTab(a.tabId);
      switch (a.action) {
        case "list":
          return doList(tab, a);
        case "get":
        case "sourcemap":
          return doGetOrMap(tab, a);
        case "issues":
          return doIssues(tab, a);
        default:
          throw new BrowserError("BAD_ARGS", `未知的 sources 动作：${String(a.action).slice(0, 20)}`);
      }
    },
    // 非 op 的内部入口（index.mjs 的 opConsole 用）：`_` 前缀 + 不在 OPS，ALL_OPS 校验挡住了外部调用
    _resolveConsoleStacks: resolveConsoleStacks,
  };
};
