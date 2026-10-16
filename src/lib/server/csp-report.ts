/**
 * CSP 违规报告收集（POST /api/csp-report）：纯逻辑 + 依赖注入，路由只是薄壳。
 *
 * 背景：next.config.mjs 下发的是 `Content-Security-Policy-Report-Only`（还没 enforce），
 * 浏览器 / Electron 渲染进程遇到「若 enforce 会被拦」的资源时，会把违规 POST 到这里。
 * 目的只有一个：观察几个版本后，凭真实数据决定 enforce 前先收紧哪些指令。
 *
 * 报文一律不可信（旧版本 / 畸形 / 本机其它进程伪造）：
 * - 请求体读文本并限 16KB（边读边数字节，超了立刻 cancel，不先整包读进内存）
 * - 只取白名单字段；URL 一律去掉 query / hash 再记录——query 里可能有 token
 *   （如 ask-wait 的 `?token=`、OAuth 的 `?code=`），写进日志就是泄露
 * - 字符串剔除控制字符 / 换行：日志是单行 `console.warn`，否则能伪造日志行
 * - 内存去重表有上限，满了「停止新增」而不是淘汰最旧：淘汰会让攻击者用不同 key
 *   把合法条目挤出去、并且每个新 key 都会重新打一行日志（日志被灌爆）；停止新增则
 *   日志行数有硬上限（上限条首次 + 每 N 次一行汇总）
 * - 固定窗口限频，超了静默丢弃（204）——观测不能反过来拖垮应用
 * - 任何解析 / 记录异常都吞掉返回 204：违规上报失败不该让浏览器重试，也不该抛
 */

/** 请求体上限（字节）。真实的违规报告一般 < 2KB，16KB 已很宽裕 */
export const MAX_CSP_REPORT_BODY_BYTES = 16 * 1024;
/** 去重表上限（(directive, blocked 来源) 组合数） */
export const MAX_CSP_REPORT_ENTRIES = 200;
/** 同一 key 每累计 N 次再提示一次（首次必打） */
export const CSP_REPORT_WARN_EVERY = 50;
/** 单个请求体里最多处理的报告条数（reports+json 是数组，防一个包塞满） */
export const MAX_CSP_REPORTS_PER_BODY = 20;
/** 记录的 URL 最大长度（截断后加省略号） */
export const MAX_CSP_URL_LENGTH = 200;
/** 限频：每窗口最多处理的请求数（超出静默 204，不解析） */
export const CSP_REPORT_RATE_MAX = 300;
export const CSP_REPORT_RATE_WINDOW_MS = 60_000;

/** 清洗后的一条违规（只含白名单字段，URL 已去 query/hash 并截断） */
export interface CspViolation {
  /** 被违反的指令名（`script-src-elem` 这类，不含指令值） */
  directive: string;
  /** 脱敏后的 blocked-uri（URL 保留 scheme+host+path；data:/blob: 只留 scheme） */
  blockedUri: string;
  /** 去重维度：blocked 的 origin，或 inline / eval / data: 这类「类型」 */
  blockedKey: string;
  documentUri: string;
  sourceFile?: string;
  lineNumber?: number;
}

export interface CspReportEntry {
  directive: string;
  blockedKey: string;
  count: number;
  /** 首次出现时的现场（之后同 key 不再更新，只累加 count） */
  documentUri: string;
  blockedUri: string;
  sourceFile?: string;
  lineNumber?: number;
}

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** 先截到这个长度再做清洗：body 已限 16KB，但单字段仍可能很长，别对长串做正则 */
const RAW_FIELD_CAP = 2048;

/**
 * 去控制字符 / 换行 / Unicode 行分隔符。
 * 用码点过滤而不是 `/[\u0000-\u001f]/`：后者会触发 eslint no-control-regex。
 */
const stripControl = (s: string): string =>
  Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
      return c !== 0x2028 && c !== 0x2029;
    })
    .join("");

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** inline / eval / data / blob / self / wasm-eval 等 CSP 关键字式的 blocked 值 */
const KEYWORD_RE = /^[a-z][a-z0-9-]{0,30}$/i;

interface SanitizedUrl {
  /** 记录用（去 query/hash、截断） */
  display: string;
  /** 去重用：origin 或类型 */
  key: string;
}

/**
 * 把 report 里的 URL 类字段脱敏。
 * - 关键字（inline / eval / data …）原样小写，key 同值
 * - http(s) / ws(s) 等带 host 的 URL：display = scheme://host/path（URL 的 host 本就不含
 *   userinfo，pathname 不含 query/hash），key = scheme://host
 * - data: / blob: / about: / javascript: / file: 等无 host 的：只留 scheme——这些的
 *   「正文」可能很大、含内联内容或本机路径，没有观测价值
 * - 解析不了的：手工从第一个 ? 或 # 处截断，key 归为 "other"（防止垃圾串撑大 key 空间）
 */
const sanitizeUrlField = (raw: unknown): SanitizedUrl => {
  if (typeof raw !== "string") return { display: "", key: "(none)" };
  const s = stripControl(raw.slice(0, RAW_FIELD_CAP)).trim();
  if (s === "") return { display: "", key: "(none)" };
  if (KEYWORD_RE.test(s)) {
    const k = s.toLowerCase();
    return { display: k, key: k };
  }
  try {
    const url = new URL(s);
    if (url.host !== "" && url.protocol !== "file:") {
      return {
        display: truncate(`${url.protocol}//${url.host}${url.pathname}`, MAX_CSP_URL_LENGTH),
        key: truncate(`${url.protocol}//${url.host}`, MAX_CSP_URL_LENGTH),
      };
    }
    return { display: url.protocol, key: url.protocol };
  } catch {
    const cut = s.split(/[?#]/)[0] ?? "";
    return { display: truncate(cut, MAX_CSP_URL_LENGTH), key: "other" };
  }
};

/** 指令名白名单形态：防 violated-directive 里夹带整条策略 / 垃圾撑大 key 空间 */
const DIRECTIVE_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * 取指令名：旧式 `violated-directive` 在老 Chromium 里是整条指令（`img-src 'self' data:`），
 * 只要第一个 token；非法形态返回 undefined。
 */
const normalizeDirective = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const first = raw.slice(0, RAW_FIELD_CAP).trim().split(/\s+/)[0]?.toLowerCase();
  return first && DIRECTIVE_RE.test(first) ? first : undefined;
};

/** 同一字段在两种报文里的 key 不同（legacy 连字符 / reports+json 驼峰）：按顺序取第一个存在的 */
const pick = (obj: Obj, keys: readonly string[]): unknown => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
};

const MAX_LINE_NUMBER = 10_000_000;

const toLineNumber = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) && x >= 0
    ? Math.min(MAX_LINE_NUMBER, Math.trunc(x))
    : undefined;

/** 一条 report body → CspViolation；没有可识别的指令名就不是 CSP 报告，返回 null */
const toViolation = (body: Obj): CspViolation | null => {
  const directive =
    normalizeDirective(pick(body, ["effective-directive", "effectiveDirective"])) ??
    normalizeDirective(pick(body, ["violated-directive", "violatedDirective"]));
  if (!directive) return null;

  const blocked = sanitizeUrlField(pick(body, ["blocked-uri", "blockedURL", "blockedUrl"]));
  const doc = sanitizeUrlField(pick(body, ["document-uri", "documentURL", "documentUri"]));
  const src = sanitizeUrlField(pick(body, ["source-file", "sourceFile"]));
  const line = toLineNumber(pick(body, ["line-number", "lineNumber"]));

  const out: CspViolation = {
    directive,
    blockedUri: blocked.display,
    blockedKey: blocked.key,
    documentUri: doc.display,
  };
  if (src.display !== "") out.sourceFile = src.display;
  if (line !== undefined) out.lineNumber = line;
  return out;
};

/**
 * 从解析后的 JSON 里抽出 report body 列表，兼容两种报文：
 * - 旧式 `application/csp-report`：`{"csp-report": {...}}`（report-uri 指令发的就是这种）
 * - `application/reports+json`：`[{type:"csp-violation", body:{...}}, ...]`（report-to / Reporting API）
 *   少数实现会发单个对象而非数组，也一并接住；type 非 csp-violation 的（deprecation 等）忽略
 * 按报文形状而不是 Content-Type 判断：不同浏览器 / 版本的 Content-Type 带不带 charset、
 * 大小写都不统一，形状更可靠。
 */
const extractBodies = (parsed: unknown): Obj[] => {
  if (Array.isArray(parsed)) {
    return parsed
      .filter((it): it is Obj => isObj(it) && it.type === "csp-violation" && isObj(it.body))
      .map((it) => it.body as Obj);
  }
  if (!isObj(parsed)) return [];
  if (isObj(parsed["csp-report"])) return [parsed["csp-report"]];
  if (parsed.type === "csp-violation" && isObj(parsed.body)) return [parsed.body];
  return [];
};

/** 解析一段报文文本；畸形 JSON / 非 CSP 报文 → 空数组，永不抛 */
export const parseCspReports = (text: string): CspViolation[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: CspViolation[] = [];
  for (const body of extractBodies(parsed).slice(0, MAX_CSP_REPORTS_PER_BODY)) {
    const v = toViolation(body);
    if (v) out.push(v);
  }
  return out;
};

export type CspReportRecordResult = "new" | "counted" | "dropped";

export interface CspReportStoreOptions {
  maxEntries?: number;
  warnEvery?: number;
  /** 日志出口（测试注入；默认 console.warn，一行一条） */
  warn?: (line: string) => void;
}

export interface CspReportStore {
  record: (v: CspViolation) => CspReportRecordResult;
  snapshot: () => { entries: CspReportEntry[]; dropped: number };
  reset: () => void;
}

/**
 * 内存去重计数：按 (directive, blockedKey) 聚合。
 * 日志节奏：首次出现打一行带现场；之后每累计 N 次打一行汇总；表满后新 key 只计 dropped，
 * 第 1 次与之后每 N 次丢弃各提示一行。
 */
export const createCspReportStore = (opts: CspReportStoreOptions = {}): CspReportStore => {
  const maxEntries = opts.maxEntries ?? MAX_CSP_REPORT_ENTRIES;
  const warnEvery = opts.warnEvery ?? CSP_REPORT_WARN_EVERY;
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const entries = new Map<string, CspReportEntry>();
  let dropped = 0;

  const record = (v: CspViolation): CspReportRecordResult => {
    // directive 已被白名单正则限定为无空白字符，用空格分隔不会产生歧义
    const key = `${v.directive} ${v.blockedKey}`;
    const existing = entries.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.count % warnEvery === 0) {
        warn(
          `[csp-report] 累计 ${existing.count} 次 directive=${v.directive} blocked=${v.blockedKey}`,
        );
      }
      return "counted";
    }
    if (entries.size >= maxEntries) {
      dropped += 1;
      if (dropped === 1 || dropped % warnEvery === 0) {
        warn(
          `[csp-report] 去重表已满（${maxEntries} 条），新的违规组合不再收录；已丢弃 ${dropped} 次`,
        );
      }
      return "dropped";
    }
    const entry: CspReportEntry = {
      directive: v.directive,
      blockedKey: v.blockedKey,
      count: 1,
      documentUri: v.documentUri,
      blockedUri: v.blockedUri,
    };
    if (v.sourceFile !== undefined) entry.sourceFile = v.sourceFile;
    if (v.lineNumber !== undefined) entry.lineNumber = v.lineNumber;
    entries.set(key, entry);
    const src = v.sourceFile
      ? ` src=${v.sourceFile}${v.lineNumber !== undefined ? `:${v.lineNumber}` : ""}`
      : "";
    warn(
      `[csp-report] 首次违规 directive=${v.directive} blocked=${v.blockedUri || "(none)"} doc=${v.documentUri || "(none)"}${src}`,
    );
    return "new";
  };

  return {
    record,
    snapshot: () => ({ entries: Array.from(entries.values(), (e) => ({ ...e })), dropped }),
    reset: () => {
      entries.clear();
      dropped = 0;
    },
  };
};

/** 解析 + 入库；返回本次识别出的违规条数。永不抛（异常按「没识别出」处理） */
export const ingestCspReportText = (text: string, store: CspReportStore): number => {
  try {
    const violations = parseCspReports(text);
    for (const v of violations) store.record(v);
    return violations.length;
  } catch {
    return 0;
  }
};

export type CappedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too-large" | "unreadable" };

/**
 * 读请求体文本并限制字节数：边读边累加，超限立刻 cancel 返回 too-large。
 * 不用 `req.text()`：那会先把整包读进内存，限制就形同虚设。
 */
export const readBodyTextCapped = async (
  req: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number = MAX_CSP_REPORT_BODY_BYTES,
): Promise<CappedBody> => {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large" };
      }
      // stream:true：多字节字符被切在两个 chunk 之间时不会被截坏
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, text };
};

/**
 * 固定窗口限频；被拒绝的请求不占名额。
 * 与 ui-perf-ingest 的同名逻辑等价，这里不 import 它：那个模块会拖进 perf-journal（落盘），
 * 本模块要保持无 fs 依赖、可纯测。
 */
export const createWindowLimiter = (opts: { max: number; windowMs: number }) => {
  let start = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    allow: (now: number): boolean => {
      if (now - start >= opts.windowMs) {
        start = now;
        count = 0;
      }
      if (count >= opts.max) return false;
      count += 1;
      return true;
    },
  };
};

export interface CspReportDeps {
  store: CspReportStore;
  limiter: { allow: (now: number) => boolean };
  now: () => number;
  maxBodyBytes?: number;
}

/**
 * 处理一次 POST：返回应答状态码。
 * - 413：声明的 Content-Length 或实际读到的字节数超限
 * - 204：其余一切（含被限频、读失败、畸形 JSON、非 CSP 报文）——不让浏览器重试
 */
export const handleCspReportPost = async (
  req: Request,
  deps: CspReportDeps,
): Promise<204 | 413> => {
  const max = deps.maxBodyBytes ?? MAX_CSP_REPORT_BODY_BYTES;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) return 413;
  if (!deps.limiter.allow(deps.now())) return 204;
  const body = await readBodyTextCapped(req, max);
  if (!body.ok) return body.reason === "too-large" ? 413 : 204;
  ingestCspReportText(body.text, deps.store);
  return 204;
};

const G = globalThis as unknown as {
  __feCspReportStore?: CspReportStore;
  __feCspReportLimiter?: ReturnType<typeof createWindowLimiter>;
};

/**
 * 路由用的默认依赖：store / 限频器挂 globalThis——dev HMR 重载模块、或被打进多个 chunk 时
 * 仍共享同一份计数，否则每次热更新都会把「首次违规」重复打一遍。
 */
export const defaultCspReportDeps = (): CspReportDeps => ({
  store: (G.__feCspReportStore ??= createCspReportStore()),
  limiter: (G.__feCspReportLimiter ??= createWindowLimiter({
    max: CSP_REPORT_RATE_MAX,
    windowMs: CSP_REPORT_RATE_WINDOW_MS,
  })),
  now: () => Date.now(),
});
