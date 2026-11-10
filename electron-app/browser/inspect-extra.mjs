/**
 * E2·P7b（B4）：`browser_inspect` 的三个新 include —— `matched_rules` / `event_listeners` / `a11y_audit`。
 *
 * 分层：
 *  - 纯函数（有单测）：{@link shapeMatchedStyles}、{@link shapeEventListeners}、{@link shapeAxeResult}、{@link buildAxeRunSource}；
 *  - CDP 驱动（假 tab 可测）：{@link collectMatchedRules}、{@link collectEventListeners}、{@link runA11yAudit}。
 *
 * 红线（契约 §15.3）：
 *  - 都是只读感知；页面内容（选择器 / 声明值 / 事件类型 / axe 选择器）一律过脱敏 + 限长，server 侧再整体不可信包装；
 *  - axe 只注入**隔离 world**（`Page.createIsolatedWorld`），页面主世界里查不到 `axe`；绝不 `Runtime.evaluate` 到主世界；
 *  - 不给事件处理函数源码（只有 scriptId → url:line:col）；不给 axe 的 HTML 片段（节点 outerHTML 里可能有密码框的 value）；
 *  - 不 `CSS.disable` / `DOM.disable`（`sources`（P7a）也用 CSS 域，关了会互相踩）；Debugger 域走引用计数的 debugger-hub。
 */
import nodeFs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDebuggerHub } from "./debugger-hub.mjs";
import { redactUrlSecrets } from "./net-detail.mjs";
import { SECRET_FIELD_FNS_SOURCE } from "./secret-field.mjs";
import { BrowserError } from "./server-channel.mjs";
import { redactSensitiveText } from "./text-redact.mjs";

/** 新增的三个 include（与 page-read.mjs 的基础 include 并列；页内脚本只认基础的那四个） */
export const INSPECT_EXTRA_INCLUDES = Object.freeze(["matched_rules", "event_listeners", "a11y_audit"]);

export const MATCHED_RULES_MAX = 30;
export const DECLS_PER_RULE_MAX = 40;
export const EVENT_LISTENERS_MAX = 50;
export const AXE_VIOLATIONS_MAX = 10;
export const AXE_SELECTORS_PER_RULE = 3;
/** axe 整次审计的超时（页内 Promise.race 与 CDP 超时各设一道） */
export const AXE_TIMEOUT_MS = 20_000;
/** 审计 / 解析用的隔离世界名：与 read（flowship-read）、录制器（flowship）分开，axe 的全局不污染它们 */
export const AXE_WORLD_NAME = "flowship-axe";
const SHEET_MAP_MAX = 3000;
const TEXT_MAX = 300;

/** 控制 / 格式字符（含 bidi 覆盖、零宽）：页面可控文字展示前剥掉，免得伪造换行 / 反转显示 */
const FORMAT_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

/** 页面可控短文本：剥格式字符、脱敏、限长（先脱敏后截断，窗口先截到 4×max 防超长输入） */
export const cleanText = (v, max = TEXT_MAX) => {
  const s = String(v ?? "")
    .slice(0, max * 4)
    .replace(FORMAT_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const red = redactSensitiveText(s);
  return red.length > max ? `${red.slice(0, max - 1)}…` : red;
};

const safeUrl = (u, max = 200) => {
  const red = redactUrlSecrets(String(u ?? "").slice(0, max * 4).replace(FORMAT_CHARS_RE, ""));
  return red.length > max ? `${red.slice(0, max - 1)}…` : red;
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ───────────────────────── matched_rules ─────────────────────────

/** CSS 规则来源：regular = 页面作者样式；inspector 当 injected 处理（不是页面写的） */
const ORIGIN_LABEL = Object.freeze({ regular: "author", "user-agent": "user-agent", injected: "injected", inspector: "injected" });

/** 样式表表头 → 展示用来源 `url:行:列`（行列 1 起）；表头未知（P7a 先开了 CSS 域导致没有重放）退化成样式表 id */
const sourceOf = (styleSheetId, range, header) => {
  const line = num(range?.startLine);
  const col = num(range?.startColumn);
  let where = "";
  if (header) {
    const base = safeUrl(header.url || "");
    where = header.isInline ? `<style>内联样式表${base ? `（${base}）` : ""}` : header.isConstructed ? "<构造的样式表>" : base || "<无 URL 的样式表>";
  } else {
    where = `样式表#${cleanText(styleSheetId, 40)}`;
  }
  // 内联 <style> 的 range 相对样式表自身起点：叠上表头的偏移才是文档里的行（显示用，1 起）
  const offLine = header?.isInline ? (num(header.startLine) ?? 0) : 0;
  return line === undefined ? where : `${where}:${line + offLine + 1}${col === undefined ? "" : `:${col + 1}`}`;
};

const shapeDecls = (style, secret) => {
  const out = [];
  let omitted = 0;
  const props = (Array.isArray(style?.cssProperties) ? style.cssProperties : []).filter((p) => p && typeof p === "object");
  // 真机实测：CDP 会把简写展开的长属性（padding → padding-top…）也塞进 cssProperties，且不一定带 implicit 标记；
  // 样式表 / 内联 style 里「作者真正写下的」声明都带 range，所以只要有任何一项带 range，就只留带 range 的
  const authored = props.some((p) => p.range && typeof p.range === "object");
  const seen = new Set();
  for (const p of props) {
    // implicit = 简写展开出来的长属性；disabled = 被注释掉的声明；parsedOk=false = 页面写错的无效声明。都不是「生效的写法」
    if (p.implicit === true || p.disabled === true || p.parsedOk === false || typeof p.name !== "string" || p.name === "") continue;
    if (authored && !(p.range && typeof p.range === "object")) continue;
    // 同名同值同重要性只列一次（实测同一条声明可能出现两遍）
    const dedupeKey = `${p.name}\u0000${p.value}\u0000${p.important === true}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (out.length >= DECLS_PER_RULE_MAX) {
      omitted += 1;
      continue;
    }
    // CDP 的 value 对 !important 声明会带上「 !important」后缀：important 已单独标注，去掉免得渲染成两遍
    let value = String(p.value ?? "").replace(/\s*!important\s*$/i, "");
    // 值里的 url(...) 常带 token 查询串：先走 URL 脱敏，再走通用文本脱敏
    if (/url\(/i.test(value)) value = redactUrlSecrets(value);
    out.push({ name: cleanText(p.name, 80), value: cleanText(secret ? redactSensitiveText(value) : value, TEXT_MAX), ...(p.important === true ? { important: true } : {}) });
  }
  return { decls: out, omitted };
};

/**
 * 选择器展示：selectorList.text（带逗号分隔的整串）。敏感输入框（password / hidden / 验证码）上，
 * 含 `[value…]` 的属性选择器可能就是攻击页用来逐字探测输入值的（CSS keylogger），整条选择器遮掉。
 */
const selectorText = (rule, secret) => {
  const raw = typeof rule?.selectorList?.text === "string" ? rule.selectorList.text : (rule?.selectorList?.selectors ?? []).map((s) => s?.text ?? "").join(", ");
  if (secret && /\[\s*value\b/i.test(raw)) return "[已隐藏：敏感输入框上的 value 属性选择器]";
  return cleanText(raw, 200);
};

/**
 * `CSS.getMatchedStylesForNode` 的结果 → 展示结构（纯函数）。
 * - 内联 style（`inlineStyle`）单独列在 `inline`；
 * - UA 规则默认折叠，只给数量 `uaCount`；作者 / injected 规则最多 {@link MATCHED_RULES_MAX} 条——超出时保留**最后**的（层叠里后写的优先级更高），`omitted` 给被省略条数；
 * - 声明去掉简写展开项 / 被注释项，每条规则 ≤ {@link DECLS_PER_RULE_MAX} 个；所有文字脱敏 + 限长。
 * @param {any} raw
 * @param {{ sheetHeader?: (styleSheetId: string) => any, secret?: boolean }} [opts]
 */
export const shapeMatchedStyles = (raw, opts = {}) => {
  const header = opts.sheetHeader ?? (() => undefined);
  const secret = opts.secret === true;
  const matched = Array.isArray(raw?.matchedCSSRules) ? raw.matchedCSSRules : [];
  const rules = [];
  let uaCount = 0;
  for (const m of matched) {
    const rule = m?.rule;
    if (!rule || typeof rule !== "object") continue;
    const origin = ORIGIN_LABEL[rule.origin] ?? "author";
    if (origin === "user-agent") {
      uaCount += 1;
      continue;
    }
    const { decls, omitted } = shapeDecls(rule.style, secret);
    const selRange = rule.selectorList?.selectors?.[0]?.range ?? rule.style?.range;
    rules.push({
      selector: selectorText(rule, secret),
      origin,
      source: sourceOf(rule.style?.styleSheetId ?? rule.styleSheetId, selRange, header(rule.style?.styleSheetId ?? rule.styleSheetId)),
      decls,
      ...(omitted > 0 ? { omittedDecls: omitted } : {}),
    });
  }
  const omitted = Math.max(0, rules.length - MATCHED_RULES_MAX);
  const kept = omitted > 0 ? rules.slice(rules.length - MATCHED_RULES_MAX) : rules;
  let inline;
  if (raw?.inlineStyle && Array.isArray(raw.inlineStyle.cssProperties)) {
    const { decls } = shapeDecls(raw.inlineStyle, secret);
    if (decls.length > 0) inline = decls;
  }
  return { ...(inline ? { inline } : {}), rules: kept, uaCount, ...(omitted > 0 ? { omitted } : {}) };
};

// ───────────────────────── event_listeners ─────────────────────────

/**
 * `DOMDebugger.getEventListeners` 的结果 → 展示结构（纯函数）。
 * - 只给类型 / capture / once / passive / 位置，**不给函数源码**（也不碰 handler 的 RemoteObject）；
 * - 位置经 `scriptLookup(scriptId, sessionId)` 映射为 url（脚本表来自 debugger-hub），查不到退化成 `脚本#id`；
 * - `backendNodeId` 给了就只留属于目标元素的（API 的 depth 语义可能带出后代节点的监听器）；最多 {@link EVENT_LISTENERS_MAX} 条。
 * @param {any} raw
 * @param {{ scriptLookup?: (scriptId: string, sessionId: string | null) => { url?: string } | null | undefined, backendNodeId?: number, sessionId?: string | null }} [opts]
 */
export const shapeEventListeners = (raw, opts = {}) => {
  const lookup = opts.scriptLookup ?? (() => null);
  const list = (Array.isArray(raw?.listeners) ? raw.listeners : []).filter(
    (l) => l && typeof l === "object" && (opts.backendNodeId === undefined || l.backendNodeId === undefined || l.backendNodeId === opts.backendNodeId),
  );
  const items = [];
  for (const l of list.slice(0, EVENT_LISTENERS_MAX)) {
    const script = typeof l.scriptId === "string" ? lookup(l.scriptId, opts.sessionId ?? null) : null;
    const line = num(l.lineNumber);
    const col = num(l.columnNumber);
    let location;
    if (script) {
      const where = script.url ? safeUrl(script.url) : "<内联 / eval 脚本>";
      location = line === undefined ? where : `${where}:${line + 1}${col === undefined ? "" : `:${col + 1}`}`;
    } else if (typeof l.scriptId === "string") {
      location = `脚本#${cleanText(l.scriptId, 20)}${line === undefined ? "" : `:${line + 1}${col === undefined ? "" : `:${col + 1}`}`}`;
    }
    items.push({
      type: cleanText(l.type, 60),
      capture: l.useCapture === true,
      once: l.once === true,
      passive: l.passive === true,
      ...(location ? { location } : {}),
    });
  }
  return { listeners: items, total: list.length, ...(list.length > items.length ? { omitted: list.length - items.length } : {}) };
};

// ───────────────────────── a11y_audit（axe-core，隔离 world） ─────────────────────────

/**
 * 页内函数源码（`this` = 审计范围元素，`callFunctionOn` 调用）：在**隔离世界**里跑 `axe.run`，只带回摘要，不带 HTML 片段。
 * 页内再设一道 Promise.race 超时（axe 偶发卡在巨型 DOM 上）。
 * @param {{ timeoutMs?: number, maxViolations?: number }} [o]
 */
export const buildAxeRunSource = (o = {}) => {
  const cfg = JSON.stringify({
    timeoutMs: o.timeoutMs ?? AXE_TIMEOUT_MS - 1000,
    maxViolations: o.maxViolations ?? AXE_VIOLATIONS_MAX,
    perRule: AXE_SELECTORS_PER_RULE,
  });
  return `function () {
  var CFG = ${cfg};
  var scope = this;
  var timer = null;
  var timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve({ timedOut: true }); }, CFG.timeoutMs); });
  var run = axe.run(scope, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    resultTypes: ["violations"],
    iframes: false,
    elementRef: false,
    ancestry: false,
    xpath: false
  }).then(function (r) {
    var vs = (r.violations || []).slice().sort(function (a, b) {
      var rank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      var ra = rank[a.impact] === undefined ? 4 : rank[a.impact];
      var rb = rank[b.impact] === undefined ? 4 : rank[b.impact];
      return ra - rb || (b.nodes || []).length - (a.nodes || []).length;
    });
    return {
      version: String(axe.version || ""),
      total: vs.length,
      passes: (r.passes || []).length,
      incomplete: (r.incomplete || []).length,
      violations: vs.slice(0, CFG.maxViolations).map(function (v) {
        var nodes = v.nodes || [];
        return {
          id: String(v.id || ""),
          impact: String(v.impact || ""),
          help: String(v.help || ""),
          nodes: nodes.length,
          selectors: nodes.slice(0, CFG.perRule).map(function (n) { return (n.target || []).map(function (t) { return Array.isArray(t) ? t.join(" ") : String(t); }).join(" >>> "); })
        };
      })
    };
  });
  return Promise.race([run, timeout]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); return { error: String((e && e.message) || e).slice(0, 200) }; });
}`;
};

const IMPACTS = new Set(["critical", "serious", "moderate", "minor"]);

/** axe 摘要（页内返回）→ 展示结构（纯函数；对畸形输入不崩）。axe 的 help 是它自己的规则说明，选择器来自页面 → cleanText */
export const shapeAxeResult = (r) => {
  if (!r || typeof r !== "object") return { error: "a11y 审计没有返回结果" };
  if (r.timedOut) return { error: `a11y 审计超时（>${Math.round(AXE_TIMEOUT_MS / 1000)}s）：元素范围太大，请对更小的容器（用 browser_snapshot 找 ref）再试` };
  if (typeof r.error === "string") return { error: cleanText(r.error, 200) };
  const violations = (Array.isArray(r.violations) ? r.violations : []).slice(0, AXE_VIOLATIONS_MAX).map((v) => ({
    id: cleanText(v?.id, 60),
    impact: IMPACTS.has(v?.impact) ? v.impact : "unknown",
    help: cleanText(v?.help, 200),
    nodes: Math.max(0, Math.floor(num(v?.nodes) ?? 0)),
    selectors: (Array.isArray(v?.selectors) ? v.selectors : []).slice(0, AXE_SELECTORS_PER_RULE).map((s) => cleanText(s, 200)),
  }));
  const total = Math.max(violations.length, Math.floor(num(r.total) ?? violations.length));
  return {
    version: cleanText(r.version, 20),
    total,
    passes: Math.max(0, Math.floor(num(r.passes) ?? 0)),
    incomplete: Math.max(0, Math.floor(num(r.incomplete) ?? 0)),
    violations,
    ...(total > violations.length ? { omitted: total - violations.length } : {}),
  };
};

// axe 脚本体：只读一次、模块级缓存（564KB，别每次 inspect 都读盘）
let axeSourceCache = null;
const AXE_PATH = fileURLToPath(new URL("./vendor/axe.min.js", import.meta.url));

/** 读 vendor 里的 axe（缓存）。缺文件 → UNSUPPORTED（模型能自修复的说明）。`readFile` 可注入便于单测 */
export const loadAxeSource = (readFile = (p) => nodeFs.readFileSync(p, "utf8")) => {
  if (axeSourceCache !== null) return axeSourceCache;
  let src;
  try {
    src = readFile(AXE_PATH);
  } catch {
    throw new BrowserError("UNSUPPORTED", "a11y_audit 需要的 axe-core 脚本缺失（electron-app/browser/vendor/axe.min.js），当前安装包不支持这个检查；其余 include 不受影响");
  }
  if (typeof src !== "string" || src.length < 1000) throw new BrowserError("UNSUPPORTED", "a11y_audit 需要的 axe-core 脚本不完整，当前安装包不支持这个检查");
  axeSourceCache = src;
  return src;
};

/** 单测用：清模块缓存 */
export const __resetAxeCacheForTest = () => {
  axeSourceCache = null;
};

// ───────────────────────── CDP 驱动 ─────────────────────────

/**
 * 软回退：`sources`（P7a）若先开了 CSS 域，我的收集器晚订阅就错过了 `styleSheetAdded` 重放（二次 `CSS.enable` 不会再重放），
 * 这时 URL 去读它的 tab 级状态里的样式表表（只读、不创建、不依赖其存在；表结构 = styleSheetId → 原始 CDP header）。
 * 读不到就返回 undefined，来源退化成「样式表#id」。
 */
const sourcesStateHeader = (tab, id) => {
  try {
    const raw = tab.ext instanceof Map ? tab.ext.get("sources-state")?.sheets?.get?.(id) : undefined;
    if (!raw || typeof raw !== "object") return undefined;
    return { url: typeof raw.sourceURL === "string" ? raw.sourceURL : "", isInline: raw.isInline === true, isConstructed: raw.isConstructed === true, startLine: raw.startLine, startColumn: raw.startColumn };
  } catch {
    return undefined;
  }
};

/** 样式表表头收集器（tab 级）：`CSS.styleSheetAdded` 带 sourceURL，规则里只有 styleSheetId，要靠它映射 URL */
export const getSheetCollector = (tab) =>
  tab.getExt("inspect-css-sheets", () => {
    /** @type {Map<string, any>} */
    const sheets = new Map();
    const off = tab.onCdpEvent((method, params, sessionId) => {
      if (method === "CSS.styleSheetAdded" && typeof params?.header?.styleSheetId === "string") {
        const h = params.header;
        const key = `${sessionId ?? "main"}:${h.styleSheetId}`;
        sheets.delete(key);
        sheets.set(key, { url: typeof h.sourceURL === "string" ? h.sourceURL : "", isInline: h.isInline === true, isConstructed: h.isConstructed === true, startLine: h.startLine, startColumn: h.startColumn });
        while (sheets.size > SHEET_MAP_MAX) sheets.delete(sheets.keys().next().value);
      } else if (method === "CSS.styleSheetRemoved" && typeof params?.styleSheetId === "string") {
        sheets.delete(`${sessionId ?? "main"}:${params.styleSheetId}`);
      }
    });
    return {
      header: (id, sessionId) => sheets.get(`${sessionId ?? "main"}:${id}`) ?? (sessionId ? undefined : sourcesStateHeader(tab, id)),
      size: () => sheets.size,
      dispose: () => {
        off();
        sheets.clear();
      },
    };
  });

/** 在隔离世界里创建 / 复用指定名字的 world，返回 contextId */
export const isolatedContextFor = async (tab, worldName) => {
  let frameId = tab.mainFrameId;
  if (!frameId) frameId = (await tab.send("Page.getFrameTree", {}))?.frameTree?.frame?.id;
  if (!frameId) throw new BrowserError("INTERNAL", "找不到页面的主 frame");
  const r = await tab.send("Page.createIsolatedWorld", { frameId, worldName });
  if (typeof r?.executionContextId !== "number") throw new BrowserError("INTERNAL", "创建隔离世界失败");
  return r.executionContextId;
};

/** 目标是不是敏感输入框（password / 验证码 / 银行卡类 / hidden）：规则同 secret-field.mjs + inspect 的 hidden；出错按敏感处理 */
export const SECRET_OR_HIDDEN_PROBE_SOURCE = `function () {
  ${SECRET_FIELD_FNS_SOURCE}
  try {
    var t = String(this.localName || "").toLowerCase();
    if (t !== "input" && t !== "textarea") return false;
    if (t === "input" && String(this.getAttribute("type") || "").toLowerCase() === "hidden") return true;
    return isSecretInfo(readSecretInfo(this)) === true;
  } catch (e) { return true; }
}`;

const releaseQuiet = (tab, objectId, sessionId) => {
  if (objectId) tab.send("Runtime.releaseObject", { objectId }, sessionId ?? null, 3000).catch(() => {});
};

/** 在隔离世界里对元素执行探针函数，返回布尔（失败 → 按敏感处理） */
const probeSecret = async (tab, entry) => {
  let objectId;
  try {
    const contextId = await isolatedContextFor(tab, AXE_WORLD_NAME);
    const resolved = await tab.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId, executionContextId: contextId }, entry.sessionId ?? null);
    objectId = resolved?.object?.objectId;
    if (!objectId) return true;
    const r = await tab.send("Runtime.callFunctionOn", { objectId, functionDeclaration: SECRET_OR_HIDDEN_PROBE_SOURCE, returnByValue: true, silent: true }, entry.sessionId ?? null);
    return r?.result?.value !== false;
  } catch {
    return true;
  } finally {
    releaseQuiet(tab, objectId, entry.sessionId);
  }
};

/**
 * matched_rules：`DOM.pushNodesByBackendIdsToFrontend` 把 backendNodeId 换成 nodeId（DOM 域在会话初始化时已 enable；
 * 没请求过 document 时先 `DOM.getDocument`——它只会重置 nodeId 映射，本仓库其它地方都用 backendNodeId，不受影响），再 `CSS.getMatchedStylesForNode`。
 * 只 enable、**不 disable** CSS 域（P7a 的 sources 也在用）。
 */
export const collectMatchedRules = async (tab, entry) => {
  const sid = entry.sessionId ?? null;
  const collector = getSheetCollector(tab); // 先订阅再 enable：CSS.enable 会同步重放 styleSheetAdded
  await tab.send("CSS.enable", {}, sid);
  const push = () => tab.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [entry.backendNodeId] }, sid);
  let pushed;
  try {
    pushed = await push();
  } catch (err) {
    if (!/document|requested/i.test(String(err?.message))) throw err;
    await tab.send("DOM.getDocument", { depth: 0 }, sid);
    pushed = await push();
  }
  const nodeId = pushed?.nodeIds?.[0];
  if (!nodeId) throw new BrowserError("REF_STALE", "元素已不在文档中，请重新 browser_snapshot 获取 ref");
  const secret = await probeSecret(tab, entry);
  const raw = await tab.send("CSS.getMatchedStylesForNode", { nodeId }, sid, 15_000);
  return shapeMatchedStyles(raw, { sheetHeader: (id) => collector.header(id, sid), secret });
};

/**
 * event_listeners：`DOM.resolveNode`（**主世界**的 objectId，只取句柄、不执行任何页面脚本）→ `DOMDebugger.getEventListeners`；脚本位置经 debugger-hub 的脚本表映射。
 * 为什么不用隔离 world 的 objectId：真机实测，Chromium 按 objectId 所在 world 过滤监听器，隔离 world 的句柄看不到主世界注册的监听器（返回 0 条）。
 * hub 是引用计数的（`sources` / `debug` 同用）：这里 acquire / release 成对，最后一个使用者走时才 `Debugger.disable`。
 * hub 起不来（Debugger.enable 失败）时降级：位置只给 scriptId。
 */
export const collectEventListeners = async (tab, entry, deps = {}) => {
  const sid = entry.sessionId ?? null;
  const hub = getDebuggerHub(tab, { log: deps.log });
  const owner = Symbol("inspect-event-listeners");
  let acquired = false;
  try {
    await hub.acquire(owner);
    acquired = true;
  } catch {
    /* 降级：只给 scriptId */
  }
  let objectId;
  try {
    const resolved = await tab.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId, objectGroup: "flowship-inspect" }, sid);
    objectId = resolved?.object?.objectId;
    if (!objectId) throw new BrowserError("REF_STALE", "元素已不在文档中，请重新 browser_snapshot 获取 ref");
    const raw = await tab.send("DOMDebugger.getEventListeners", { objectId }, sid, 15_000);
    return shapeEventListeners(raw, {
      backendNodeId: entry.backendNodeId,
      sessionId: sid,
      scriptLookup: acquired ? (scriptId, s) => hub.getScript(scriptId, s) : undefined,
    });
  } finally {
    releaseQuiet(tab, objectId, sid);
    if (acquired) await hub.release(owner).catch(() => {});
  }
};

/**
 * a11y_audit：把 vendor 的 axe 注入**隔离 world**（`Page.createIsolatedWorld` → `contextId`），对目标元素子树 `axe.run`。
 * 全程不对主世界 evaluate；注入前先 `typeof axe` 探测（同名 world 在同一文档内复用，只注一次）。
 * OOPIF 子会话里的元素：隔离 world 建在主 frame，resolve 不到 → 明确报错而不是退回主世界。
 */
export const runA11yAudit = async (tab, entry, deps = {}) => {
  if (entry.sessionId) throw new BrowserError("UNSUPPORTED", "该元素在跨站 iframe（OOPIF）里，a11y_audit 目前只支持主文档与同站 iframe 的元素");
  const axeSource = loadAxeSource(deps.readFile);
  const contextId = await isolatedContextFor(tab, AXE_WORLD_NAME);
  const probe = await tab.send("Runtime.evaluate", { expression: 'typeof axe === "object" && typeof axe.run === "function"', contextId, returnByValue: true, silent: true });
  if (probe?.result?.value !== true) {
    const injected = await tab.send("Runtime.evaluate", { expression: axeSource, contextId, returnByValue: true, silent: true }, null, AXE_TIMEOUT_MS);
    if (injected?.exceptionDetails) throw new BrowserError("INTERNAL", "注入 axe 失败（页面的 CSP 或环境限制）");
  }
  let objectId;
  try {
    let resolved;
    try {
      resolved = await tab.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId, executionContextId: contextId });
    } catch (err) {
      if (err instanceof BrowserError && err.code === "TAB_NOT_FOUND") throw err;
      // 隔离 world 建在主 frame：iframe 里的元素不属于这个 context，解析会失败（明确说，别退回主世界）
      throw new BrowserError("UNSUPPORTED", "a11y_audit 目前只支持主文档里的元素（该元素可能在 iframe 内，或已不在文档中）；请换主文档里的容器 ref 再试");
    }
    objectId = resolved?.object?.objectId;
    if (!objectId) throw new BrowserError("REF_STALE", "元素已不在文档中，请重新 browser_snapshot 获取 ref");
    const res = await tab.send(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: buildAxeRunSource(), awaitPromise: true, returnByValue: true, silent: true },
      null,
      AXE_TIMEOUT_MS,
    );
    if (res?.exceptionDetails) {
      return shapeAxeResult({ error: String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "页内脚本出错").slice(0, 200) });
    }
    return shapeAxeResult(res?.result?.value);
  } finally {
    releaseQuiet(tab, objectId, null);
  }
};

/**
 * 编排：按 include 里的新项依次采集；**每一项单独 try/catch**，一项失败只在该项给 `{ error }`，不拖垮其它项与基础 inspect 结果。
 * 主动中断（`TAB_NOT_FOUND`）直接抛——标签页都没了，继续没有意义。
 * @param {any} tab @param {any} entry @param {string[]} extras @param {{ log?: (m: string) => void, readFile?: any }} [deps]
 */
export const collectInspectExtras = async (tab, entry, extras, deps = {}) => {
  const out = {};
  const guard = async (key, fn) => {
    try {
      out[key] = await fn();
    } catch (err) {
      if (err instanceof BrowserError && err.code === "TAB_NOT_FOUND") throw err;
      const msg = err instanceof BrowserError ? err.message : `采集失败：${String(err?.message || err).slice(0, 160)}`;
      out[key] = { error: cleanText(msg, 220) };
    }
  };
  if (extras.includes("matched_rules")) await guard("matchedRules", () => collectMatchedRules(tab, entry));
  if (extras.includes("event_listeners")) await guard("eventListeners", () => collectEventListeners(tab, entry, deps));
  if (extras.includes("a11y_audit")) await guard("a11yAudit", () => runA11yAudit(tab, entry, deps));
  return out;
};
