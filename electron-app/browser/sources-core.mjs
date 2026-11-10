/**
 * 增强包 E2 · B3 `browser_sources` 的纯逻辑（无 CDP / 无 IO，单测直接喂数据）：
 *  - 源码带行号输出（行范围 / 字符上限 / minified 长行按列窗口截断；**先脱敏后截断**）；
 *  - Audits 问题的分类、固定翻译、去重环形缓冲、按类型汇总；
 *  - 脚本 / 样式表条目的展示名。
 *
 * 页面可控的文字（源码、blockedURL、指令名、cookie 名……）一律只作为「数据」字段返回，翻译句子是我们自己的固定文案；
 * server 侧再把数据字段放进不可信块（红线 §15.3-2），这里额外把指令名 / 枚举类字段限制成 `[A-Za-z0-9_.-]`，URL 过脱敏。
 */
import { redactUrlSecrets } from "./net-detail.mjs";
import { redactSensitiveText } from "./text-redact.mjs";

export const DEFAULT_GET_LINES = 200;
export const DEFAULT_GET_CHARS = 20_000;
export const MAX_GET_CHARS = 100_000;
/** 单行超过它就按列窗口截取（minified bundle 一行几百 KB 是常态） */
export const LINE_WINDOW = 400;
/** 脱敏前最多处理的单行长度：正则管线是线性的，但没必要为一个 5MB 的单行全扫；窗口以目标列为中心 */
const REDACT_LINE_CAP = 1_000_000;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 枚举 / 指令名类字段：只留安全字符，防止页面把换行 / 伪标记塞进「可信句子」 */
export const safeToken = (v, n = 60) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, n) : "");

/** 脚本 / 样式表的展示 URL：脱敏；没有 url 的动态脚本给固定占位 */
export const displayScriptUrl = (s) => {
  if (typeof s?.url === "string" && s.url !== "") return clip(redactUrlSecrets(s.url), 300);
  return s?.hasSourceURL ? "<eval>" : "<inline>";
};

/**
 * 取源码的一个行区间并带行号输出。
 * @param {string} source 全文
 * @param {{ startLine?: number, endLine?: number, column?: number, maxChars?: number, maxLines?: number }} o  行 / 列都是 1 起
 * @returns {{ text: string, startLine: number, endLine: number, totalLines: number, totalChars: number, truncated: boolean, notes: string[] }}
 */
export const sliceSourceWithLineNumbers = (source, o = {}) => {
  const src = typeof source === "string" ? source : "";
  const lines = src.split("\n");
  const totalLines = lines.length;
  const maxLines = Number.isInteger(o.maxLines) && o.maxLines > 0 ? o.maxLines : DEFAULT_GET_LINES;
  const maxChars = Math.min(Number.isFinite(o.maxChars) && o.maxChars > 0 ? Math.floor(o.maxChars) : DEFAULT_GET_CHARS, MAX_GET_CHARS);
  const start = Math.min(Math.max(Number.isInteger(o.startLine) ? o.startLine : 1, 1), totalLines);
  let end = Number.isInteger(o.endLine) ? Math.min(Math.max(o.endLine, start), totalLines) : Math.min(start + maxLines - 1, totalLines);
  const notes = [];
  let rangeCut = false;
  if (end - start + 1 > maxLines) {
    end = start + maxLines - 1;
    rangeCut = true;
    notes.push(`行范围超过 ${maxLines} 行上限，已截到第 ${end} 行`);
  }
  const col = Number.isInteger(o.column) && o.column > 0 ? o.column - 1 : 0;
  const width = String(end).length;
  const out = [];
  let used = 0;
  let truncated = false;
  let last = start - 1;
  for (let i = start; i <= end; i++) {
    let line = lines[i - 1].replace(/\r$/, "");
    const fullLen = line.length;
    // 先脱敏（对整行 / 目标列附近的至多 REDACT_LINE_CAP 字符），再按列窗口截断：窗口边界不会把凭据劈成两半漏过匹配
    let base = 0;
    if (line.length > REDACT_LINE_CAP) {
      base = Math.min(Math.max(col - REDACT_LINE_CAP / 2, 0), line.length - REDACT_LINE_CAP);
      line = line.slice(base, base + REDACT_LINE_CAP);
    }
    line = redactSensitiveText(line);
    let prefix = "";
    let suffix = "";
    if (line.length > LINE_WINDOW) {
      const center = Math.min(Math.max(col - base, 0), line.length);
      const from = Math.min(Math.max(center - LINE_WINDOW / 2, 0), line.length - LINE_WINDOW);
      const to = from + LINE_WINDOW;
      prefix = from > 0 ? "…" : "";
      suffix = to < line.length || fullLen > line.length ? "…" : "";
      line = line.slice(from, to);
      notes.push(`第 ${i} 行很长（${fullLen} 字符，疑似 minified），只显示第 ${from + base + 1}–${to + base} 列；要看别处请用 column 参数指定列`);
    }
    const rendered = `${String(i).padStart(width, " ")} | ${prefix}${line}${suffix}`;
    if (used + rendered.length + 1 > maxChars) {
      truncated = true;
      if (out.length === 0) out.push(rendered.slice(0, maxChars));
      break;
    }
    out.push(rendered);
    used += rendered.length + 1;
    last = i;
  }
  if (out.length > 0 && last < start) last = start;
  if (truncated) notes.push(`输出超过 ${maxChars} 字符上限，已截断在第 ${last} 行；可用 start_line 继续往后取`);
  return { text: out.join("\n"), startLine: start, endLine: last, totalLines, totalChars: src.length, truncated: truncated || rangeCut || last < end, notes };
};

// ── Audits 问题 ──────────────────────────────────────────────────────────────

export const ISSUE_RING_MAX = 100;

/** 我们自己的类型标签（工具参数 types 的取值） */
export const ISSUE_CATEGORIES = Object.freeze(["csp", "mixed_content", "cookie", "deprecation", "heavy_ad", "quirks", "cors", "blocked", "other"]);

const CODE_CATEGORY = Object.freeze({
  ContentSecurityPolicyIssue: "csp",
  MixedContentIssue: "mixed_content",
  CookieIssue: "cookie",
  DeprecationIssue: "deprecation",
  HeavyAdIssue: "heavy_ad",
  QuirksModeIssue: "quirks",
  CorsIssue: "cors",
  BlockedByResponseIssue: "blocked",
});

const CSP_TYPES = Object.freeze({
  kInlineViolation: "内联脚本 / 样式被 CSP 拦截",
  kEvalViolation: "eval / new Function 被 CSP 拦截",
  kURLViolation: "资源地址不在 CSP 白名单内",
  kTrustedTypesSinkViolation: "Trusted Types 拦截了危险赋值",
  kTrustedTypesPolicyViolation: "Trusted Types 策略被拒绝",
  kWasmEvalViolation: "WebAssembly 编译被 CSP 拦截",
});

const COOKIE_REASONS = Object.freeze({
  WarnSameSiteUnspecifiedCrossSiteContext: "Cookie 未设 SameSite，却在跨站上下文使用（将被当作 Lax，跨站请求不再携带）",
  WarnSameSiteNoneInsecure: "SameSite=None 的 Cookie 没有 Secure 属性（会被拒绝）",
  WarnSameSiteStrictLaxDowngradeStrict: "SameSite=Strict 的 Cookie 在跨站降级场景被降为 Lax",
  WarnSameSiteStrictCrossDowngradeStrict: "SameSite=Strict 的 Cookie 在跨站降级场景被拦截",
  WarnSameSiteLaxCrossDowngradeStrict: "SameSite=Lax 的 Cookie 在跨站降级场景被拦截",
  WarnAttributeValueExceedsMaxSize: "Cookie 属性值超过大小上限",
  WarnDomainNonASCII: "Cookie 的 Domain 含非 ASCII 字符",
  ExcludeSameSiteUnspecifiedTreatedAsLax: "Cookie 未设 SameSite，按 Lax 处理而被排除",
  ExcludeSameSiteNoneInsecure: "SameSite=None 的 Cookie 没有 Secure 属性，被排除",
  ExcludeSameSiteLax: "SameSite=Lax 的 Cookie 在跨站请求中被排除",
  ExcludeSameSiteStrict: "SameSite=Strict 的 Cookie 在跨站请求中被排除",
  ExcludeDomainNonASCII: "Cookie 的 Domain 含非 ASCII 字符，被排除",
  ExcludeThirdPartyCookieBlockedInFirstPartySet: "第三方 Cookie 被屏蔽",
  ExcludeThirdPartyPhaseout: "第三方 Cookie 被屏蔽（逐步淘汰）",
  ExcludePortMismatch: "Cookie 因端口不匹配被排除",
  ExcludeSchemeMismatch: "Cookie 因协议不匹配被排除",
});

const MIXED_RESOLUTION = Object.freeze({
  MixedContentBlocked: "https 页面里的 http 子资源被浏览器拦截",
  MixedContentAutomaticallyUpgraded: "https 页面里的 http 子资源被自动升级为 https",
  MixedContentWarning: "https 页面加载了 http 子资源（警告）",
});

const HEAVY_REASONS = Object.freeze({
  NetworkTotalLimit: "网络流量超限",
  CpuTotalLimit: "CPU 总耗时超限",
  CpuPeakLimit: "CPU 峰值超限",
});

const BLOCKED_REASONS = Object.freeze({
  CoepFrameResourceNeedsCoepHeader: "跨源隔离（COEP）要求子框架带 COEP 头",
  CoopSandboxedIFrameCannotNavigateToCoopPage: "沙箱 iframe 不能导航到带 COOP 的页面",
  CorpNotSameOrigin: "资源的 CORP 头不是 same-origin（被拦截）",
  CorpNotSameOriginAfterDefaultedToSameOriginByCoep: "资源在 COEP 下被默认为 same-origin 而被拦截",
  CorpNotSameSite: "资源的 CORP 头不是 same-site（被拦截）",
});

const urlOf = (v) => (typeof v === "string" && v !== "" ? clip(redactUrlSecrets(v), 300) : undefined);

/**
 * 一条 `Audits.issueAdded` 的 issue → 我们的结构；认不出的类型落到 `other`（只给 code，不给页面字段）。
 * 返回：`{ category, code, key, summary, severity, url?, directive?, resource?, tags? }`；
 * `summary` 是我们自己的固定翻译（可信），`url / directive / resource` 来自页面（server 侧不可信包装）。
 * @param {any} issue CDP 的 InspectorIssue（{ code, details }）
 */
export const classifyIssue = (issue) => {
  const code = safeToken(issue?.code, 60) || "Unknown";
  const d = issue?.details ?? {};
  const category = CODE_CATEGORY[code] ?? "other";
  let summary = "";
  let severity = "warning";
  let url;
  let directive;
  let resource;
  let sig = "";
  switch (category) {
    case "csp": {
      const x = d.contentSecurityPolicyIssueDetails ?? {};
      directive = safeToken(x.violatedDirective, 60) || undefined;
      const t = safeToken(x.contentSecurityPolicyViolationType, 60);
      url = urlOf(x.blockedURL);
      summary = `${CSP_TYPES[t] ?? "内容安全策略（CSP）违规"}${x.isReportOnly ? "（仅报告模式，未真正拦截）" : ""}`;
      severity = x.isReportOnly ? "warning" : "error";
      sig = `${t}|${directive ?? ""}|${url ?? ""}|${x.isReportOnly ? 1 : 0}`;
      break;
    }
    case "mixed_content": {
      const x = d.mixedContentIssueDetails ?? {};
      const res = safeToken(x.resolutionStatus, 60);
      url = urlOf(x.insecureURL);
      resource = urlOf(x.mainResourceURL);
      summary = MIXED_RESOLUTION[res] ?? "混合内容（https 页面加载 http 资源）";
      severity = res === "MixedContentBlocked" ? "error" : "warning";
      sig = `${res}|${url ?? ""}`;
      break;
    }
    case "cookie": {
      const x = d.cookieIssueDetails ?? {};
      const reasons = [...(Array.isArray(x.cookieWarningReasons) ? x.cookieWarningReasons : []), ...(Array.isArray(x.cookieExclusionReasons) ? x.cookieExclusionReasons : [])]
        .slice(0, 4)
        .map((r) => safeToken(r, 80))
        .filter(Boolean);
      summary = reasons.length > 0 ? reasons.map((r) => COOKIE_REASONS[r] ?? `Cookie 策略问题（${r}）`).join("；") : "Cookie 策略问题";
      severity = reasons.some((r) => r.startsWith("Exclude")) ? "error" : "warning";
      resource = typeof x.cookie?.name === "string" ? clip(x.cookie.name.replace(/[\r\n]/g, " "), 60) : undefined; // cookie 名（不含值）
      url = urlOf(x.cookieUrl);
      sig = `${reasons.join(",")}|${resource ?? ""}|${url ?? ""}`;
      break;
    }
    case "deprecation": {
      const t = safeToken(d.deprecationIssueDetails?.type, 80);
      summary = `使用了已弃用的浏览器 API${t ? `（${t}）` : ""}`;
      sig = t;
      break;
    }
    case "heavy_ad": {
      const x = d.heavyAdIssueDetails ?? {};
      const r = safeToken(x.reason, 40);
      summary = `重广告干预：${HEAVY_REASONS[r] ?? "资源占用过高"}${x.resolution === "HeavyAdBlocked" ? "，广告框架被移除" : "（警告）"}`;
      sig = `${r}|${safeToken(x.resolution, 30)}`;
      break;
    }
    case "quirks": {
      const x = d.quirksModeIssueDetails ?? {};
      summary = x.isLimitedQuirksMode ? "页面处于「有限怪异模式」（缺少或不规范的 DOCTYPE）" : "页面处于怪异模式（缺少 DOCTYPE，布局按旧规则）";
      url = urlOf(x.url);
      sig = `${x.isLimitedQuirksMode ? 1 : 0}|${url ?? ""}`;
      break;
    }
    case "cors": {
      const x = d.corsIssueDetails ?? {};
      const e = safeToken(x.corsErrorStatus?.corsError, 60);
      url = urlOf(x.request?.url);
      summary = `跨源请求（CORS）问题${e ? `：${e}` : ""}${x.isWarning ? "（警告）" : ""}`;
      severity = x.isWarning ? "warning" : "error";
      sig = `${e}|${url ?? ""}`;
      break;
    }
    case "blocked": {
      const x = d.blockedByResponseIssueDetails ?? {};
      const r = safeToken(x.reason, 80);
      url = urlOf(x.request?.url);
      summary = `资源被响应头策略拦截：${BLOCKED_REASONS[r] ?? (r || "未知原因")}`;
      severity = "error";
      sig = `${r}|${url ?? ""}`;
      break;
    }
    default:
      summary = `浏览器报告了一个问题（${code}）`;
      sig = "";
  }
  return { category, code, key: clip(`${code}|${sig}`, 400), summary, severity, ...(url ? { url } : {}), ...(directive ? { directive } : {}), ...(resource ? { resource } : {}) };
};

/** 去重环形缓冲：同 key 的问题只计数不重复入表；满了丢最旧 */
export const createIssueRing = (max = ISSUE_RING_MAX) => {
  /** @type {Map<string, any>} */
  const map = new Map();
  let dropped = 0;
  return {
    /** 返回 true = 新条目 */
    add(issue) {
      const c = classifyIssue(issue);
      const prev = map.get(c.key);
      if (prev) {
        prev.count++;
        return false;
      }
      map.set(c.key, { ...c, count: 1 });
      while (map.size > max) {
        map.delete(map.keys().next().value);
        dropped++;
      }
      return true;
    },
    list: () => [...map.values()].map((e) => ({ ...e })),
    clear() {
      map.clear();
      dropped = 0;
    },
    get dropped() {
      return dropped;
    },
    get size() {
      return map.size;
    },
  };
};

/**
 * 按类型汇总并挑出展示的条目。`types` 给了就只留这些类型；`limit` 限展示条数（汇总计数不受 limit 影响）。
 * @param {ReturnType<typeof classifyIssue>[] & { count?: number }[]} entries
 * @param {{ types?: string[], limit?: number }} [o]
 */
export const summarizeIssues = (entries, o = {}) => {
  const want = Array.isArray(o.types) && o.types.length > 0 ? new Set(o.types) : null;
  const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, 100) : 30;
  const pool = want ? entries.filter((e) => want.has(e.category)) : entries;
  /** @type {Record<string, number>} */
  const counts = {};
  for (const e of pool) counts[e.category] = (counts[e.category] ?? 0) + (e.count ?? 1);
  return { counts, total: pool.length, shown: pool.slice(-limit), omitted: Math.max(0, pool.length - limit) };
};
