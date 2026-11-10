/**
 * V2 读取与检查：页内脚本源码 + 纯函数（契约 §14.1 `read` / `inspect`）。
 *
 * # 为什么脚本是「源码字符串」而不是真函数
 * 脚本要通过 CDP（Runtime.callFunctionOn / Runtime.evaluate）送进页面执行，必须是字符串；
 * 沿用仓库既有写法（actions.mjs 的 OCCLUSION_FN、page-scripts.mjs）。字符串里不许出现反引号与模板插值，
 * 需要反引号的地方用 `String.fromCharCode(96)`；参数一律经 JSON 烧进去（不拼接用户字符串）。
 * 测试里把脚本 `new Function` 起来、喂一棵手写的假 DOM（见 tests/browser-v2-page-read.test.ts），
 * 所以脚本对 DOM 的依赖只限于：nodeType / localName / childNodes / getAttribute / hasAttribute /
 * attributes / textContent / shadowRoot / cloneNode / outerHTML / getBoundingClientRect +
 * 全局 document / getComputedStyle / window / URL。
 *
 * # 执行世界
 * 调用方（ops/read.mjs）优先在**隔离世界**里跑：读 DOM 不需要页面世界的任何东西，隔离世界里的内建原型 / DOM 原型
 * 是独立一份，页面把 Array.prototype / Element.prototype 改坏也影响不到本脚本。
 * 只有 OOPIF 子会话里的 ref 退回主世界（那边拿不到我们的隔离世界）。
 *
 * # 安全（§14.5）
 * - 页面来的文字一律不可信，由 server 侧 `b.untrusted` 包装；脚本本身只负责「读得干净」：
 *   链接只留 http(s) / mailto，丢弃 javascript: 等；图片只留 alt、不带 src；
 *   表单控件（input / textarea / select）的值一概不读——password 值天然不会出现在 read 里；
 * - inspect 里 password / 一次性验证码 / 银行卡类（cc-*）/ text-security 遮罩输入框，以及 `<input type=hidden>`（CSRF token 等）的
 *   value 不给（attrs 与 html 两处都清；敏感 textarea 的正文也清），所有 on* 属性不给，单值 ≤300 字符。敏感判定规则来自 secret-field.mjs（R1-25）。
 *   html 的克隆体与原树按顺序配对判定；配对失败（数量对不上）时 html 整段置空并给 htmlNote——不用克隆体降级判定（R1-29 复审）。
 */
import { SECRET_FIELD_FNS_SOURCE } from "./secret-field.mjs";

/** read 的参数范围（契约：maxChars 1000–200000，缺省 30000） */
export const READ_MAX_CHARS = Object.freeze({ min: 1000, max: 200_000, dflt: 30_000 });

/** 规整 read 参数（纯函数）：非法值回落默认，越界夹紧 */
export const normalizeReadOptions = (o = {}) => {
  const n = typeof o.maxChars === "number" && Number.isFinite(o.maxChars) ? Math.round(o.maxChars) : READ_MAX_CHARS.dflt;
  return {
    format: o.format === "text" ? "text" : "markdown",
    maxChars: Math.min(READ_MAX_CHARS.max, Math.max(READ_MAX_CHARS.min, n)),
    mainContent: o.mainContent !== false,
  };
};

/** inspect 的 include 取值 / 默认 */
export const INSPECT_INCLUDES = Object.freeze(["box", "styles", "attrs", "html"]);
export const DEFAULT_INSPECT_INCLUDE = Object.freeze(["box", "styles", "attrs"]);

/** inspect 缺省样式属性（契约 §14.1） */
export const DEFAULT_STYLE_PROPS = Object.freeze([
  "display",
  "position",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "opacity",
  "visibility",
  "z-index",
  "overflow",
]);

export const MAX_STYLE_PROPS = 30;
export const INSPECT_VALUE_MAX = 300;
export const INSPECT_HTML_MAX = 4000;

/**
 * 规整 styleProps：只认 CSS 属性名 / 自定义属性（--x）的字符集，去重、≤30 个。
 * 非法项直接丢弃（不是报错：模型常把 `font-size:` 之类写歪，丢掉比整个失败友好）；返回空数组 → 调用方用默认集。
 */
export const normalizeStyleProps = (list) => {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const p = raw.trim().toLowerCase();
    if (!/^(?:--[a-z0-9_-]{1,60}|[a-z][a-z0-9-]{0,60})$/.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_STYLE_PROPS) break;
  }
  return out;
};

/** 规整 include：未知项丢弃，空 → 默认 */
export const normalizeInclude = (list) => {
  if (!Array.isArray(list)) return [...DEFAULT_INSPECT_INCLUDE];
  const out = [];
  for (const v of list) if (typeof v === "string" && INSPECT_INCLUDES.includes(v) && !out.includes(v)) out.push(v);
  return out.length > 0 ? out : [...DEFAULT_INSPECT_INCLUDE];
};

/** 单值截断（server / 主进程再保险；页内脚本里有同样的逻辑） */
export const clipValue = (v, n = INSPECT_VALUE_MAX) => {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// 把 JSON 嵌进脚本：U+2028 / U+2029 在老 JS 引擎里是字符串字面量里的换行，保险起见转义
const toLiteral = (v) => JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// ───────────────────────── read 脚本 ─────────────────────────

const READ_BODY = String.raw`
  "use strict";
  var OPTS = __OPTS__;
  var MD = OPTS.format !== "text";
  var MAX = OPTS.maxChars;
  // 输出累计超过它就停止遍历：超大页面不必整页走完再截断
  var BUDGET = MAX * 2 + 4000;
  var MAX_NODES = 40000;
  var BT = String.fromCharCode(96);
  var state = { nodes: 0, emitted: 0, stop: false, cut: false, rootEl: null };
  var BASE = (document && document.baseURI) || (typeof location !== "undefined" && location.href) || "";

  // 不读的元素：脚本 / 样式 / 嵌入内容 / 表单控件（值不读，password 天然不会出现）
  var SKIP = {
    script: 1, style: 1, noscript: 1, template: 1, head: 1, iframe: 1, frame: 1, object: 1, embed: 1,
    canvas: 1, svg: 1, math: 1, video: 1, audio: 1, textarea: 1, select: 1, input: 1, datalist: 1,
    link: 1, meta: 1, title: 1, map: 1, area: 1, source: 1, track: 1
  };
  var BLOCK = {
    address: 1, article: 1, aside: 1, blockquote: 1, details: 1, dialog: 1, dd: 1, div: 1, dl: 1, dt: 1,
    fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    header: 1, hgroup: 1, hr: 1, li: 1, main: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, table: 1, ul: 1,
    summary: 1, tr: 1, td: 1, th: 1, thead: 1, tbody: 1, tfoot: 1, caption: 1, body: 1, html: 1
  };

  function lname(el) { return String(el.localName || el.tagName || "").toLowerCase(); }
  function attr(el, n) {
    try { var v = el.getAttribute(n); return v === null || v === undefined ? "" : String(v); } catch (e) { return ""; }
  }
  function hasAttr(el, n) {
    try { return !!el.hasAttribute(n); } catch (e) { return false; }
  }
  function isHidden(el) {
    if (hasAttr(el, "hidden")) return true;
    if (attr(el, "aria-hidden") === "true") return true;
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    return cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse";
  }
  function ancestorHidden(el) {
    var p = el.parentNode;
    for (var i = 0; p && p.nodeType === 1 && i < 12; i++) {
      if (isHidden(p)) return true;
      p = p.parentNode;
    }
    return false;
  }
  function collapse(s) { return s.replace(/[ \t\r\n\f]+/g, " "); }
  // markdown 转义：只转会改变结构 / 造成歧义的字符，别把普通文字弄得满屏反斜杠
  function esc(s) {
    if (!MD) return s;
    return s.replace(/([\\\u0060*\[\]])/g, "\\$1").replace(/(^|\s)_|_(?=\s|$)/g, function (m) { return m.replace("_", "\\_"); });
  }
  function escLineStart(t) {
    if (!MD) return t;
    // 行首的 # > - + 在前面加反斜杠；「1.」这种有序列表记号要转义的是那个点，不是数字
    return t.replace(/(^|\n)(#{1,6}(?=\s)|>|[-+](?=\s))/g, "$1\\$2").replace(/(^|\n)(\d+)([.)])(?=\s)/g, "$1$2\\$3");
  }
  function tidyInline(buf) {
    var t = buf.replace(/ *\n */g, "\n").replace(/ {2,}/g, " ").replace(/^[\s]+|[\s]+$/g, "");
    return escLineStart(t);
  }
  function repeat(s, n) { var o = ""; for (var i = 0; i < n; i++) o += s; return o; }
  function childNodesOf(el) {
    // open shadow root：读它的内容，light DOM 子节点只经 <slot> 出现，避免重复
    if (el.shadowRoot && el.shadowRoot.childNodes) return el.shadowRoot.childNodes;
    return el.childNodes || [];
  }
  function elementKids(el) {
    var out = [];
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i]);
    return out;
  }
  function safeUrl(raw) {
    if (!raw || raw.charAt(0) === "#") return "";
    var u;
    try { u = new URL(raw, BASE); } catch (e) { return ""; }
    var p = u.protocol;
    if (p !== "http:" && p !== "https:" && p !== "mailto:") return "";
    var s = String(u.href);
    if (s.length > 2000) return "";
    return s.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  }
  function edge(raw) {
    return { lead: /^\s/.test(raw) ? " " : "", trail: /\s$/.test(raw) ? " " : "", core: raw.replace(/^\s+|\s+$/g, "") };
  }

  // 子节点 → { blocks, hasBlock, rawInline }；行内内容攒在 buf 里，遇到块级元素才收尾成段落
  function renderChildren(parent, ctx) {
    var blocks = [];
    var buf = "";
    var hasBlock = false;
    function flush() {
      var t = tidyInline(buf);
      buf = "";
      if (t) blocks.push(t);
    }
    var kids = childNodesOf(parent);
    for (var i = 0; i < kids.length; i++) {
      if (state.stop) break;
      var n = kids[i];
      if (n.nodeType === 3) {
        var raw = String(n.nodeValue || "");
        var t = collapse(raw);
        if (t) {
          state.emitted += t.length;
          if (state.emitted > BUDGET) { state.stop = true; state.cut = true; }
          buf += ctx.noEsc ? t : esc(t);
        }
      } else if (n.nodeType === 1) {
        var r = renderElement(n, ctx);
        if (!r) continue;
        if (r.kind === "inline") buf += r.text;
        else { flush(); if (r.text) blocks.push(r.text); hasBlock = true; }
      }
    }
    var rawInline = buf;
    flush();
    return { blocks: blocks, hasBlock: hasBlock, rawInline: rawInline };
  }
  // 折成单行文字（链接 / 标题 / 单元格 / 强调里的内容）
  function flatText(el, ctx) {
    var inner = renderChildren(el, ctx);
    var raw = inner.hasBlock ? inner.blocks.join(" ") : inner.rawInline;
    return raw.replace(/\s+/g, " ");
  }
  function inlineWrap(el, ctx, pre, post) {
    var e = edge(flatText(el, ctx));
    if (!e.core) return { kind: "inline", text: e.lead || e.trail ? " " : "" };
    return { kind: "inline", text: e.lead + pre + e.core + post + e.trail };
  }
  function block(text) { return { kind: "block", text: text }; }

  function rawText(node) {
    var out = "";
    var kids = childNodesOf(node);
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) out += String(n.nodeValue || "");
      else if (n.nodeType === 1) {
        var t = lname(n);
        if (t === "br") { out += "\n"; continue; }
        if (SKIP[t] || isHidden(n)) continue;
        out += rawText(n);
        if (BLOCK[t] && out.charAt(out.length - 1) !== "\n") out += "\n";
      }
      if (out.length > BUDGET) { state.stop = true; state.cut = true; break; }
    }
    return out;
  }
  function langOf(el) {
    var re = /(?:^|\s)(?:language|lang)-([\w+#.-]{1,20})/;
    var m = re.exec(attr(el, "class"));
    if (m) return m[1];
    var kids = elementKids(el);
    for (var i = 0; i < kids.length; i++) {
      if (lname(kids[i]) === "code") { m = re.exec(attr(kids[i], "class")); if (m) return m[1]; }
    }
    return "";
  }
  function fenced(el) {
    var code = rawText(el).replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
    if (!code) return "";
    state.emitted += code.length;
    if (!MD) return code;
    var longest = 0;
    var re = /\u0060+/g;
    var m;
    while ((m = re.exec(code))) if (m[0].length > longest) longest = m[0].length;
    var fence = repeat(BT, Math.max(3, longest + 1));
    return fence + langOf(el) + "\n" + code + "\n" + fence;
  }

  function renderList(el, ctx, ordered) {
    var items = [];
    var idx = 1;
    if (ordered) { var s = parseInt(attr(el, "start"), 10); if (isFinite(s)) idx = s; }
    var kids = elementKids(el);
    for (var i = 0; i < kids.length; i++) {
      if (state.stop) break;
      var c = kids[i];
      if (SKIP[lname(c)] || isHidden(c)) continue;
      if (lname(c) === "li") {
        var inner = renderChildren(c, ctx);
        var text = inner.blocks.join("\n");
        if (!text) continue;
        var marker = ordered ? idx + "." : "-";
        idx++;
        items.push(marker + " " + text.split("\n").join("\n" + repeat(" ", marker.length + 1)));
      } else {
        // 非法写法：ul 直接套 ul。当作上一项的子内容缩进
        var r = renderElement(c, ctx);
        if (r && r.text) {
          var ind = r.text.split("\n").join("\n  ");
          if (items.length > 0) items[items.length - 1] += "\n  " + ind;
          else items.push(ind);
        }
      }
    }
    return items.join("\n");
  }

  function renderTable(el, ctx) {
    var trs = [];
    var caption = "";
    function collect(node) {
      var kids = elementKids(node);
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        var t = lname(k);
        if (isHidden(k)) continue;
        if (t === "tr") trs.push(k);
        else if (t === "thead" || t === "tbody" || t === "tfoot") collect(k);
        else if (t === "caption") caption = flatText(k, ctx).replace(/^\s+|\s+$/g, "");
      }
    }
    collect(el);
    var data = [];
    for (var r = 0; r < trs.length && r < 400; r++) {
      if (state.stop) break;
      var cells = [];
      var cs = elementKids(trs[r]);
      for (var c = 0; c < cs.length; c++) {
        var ct = lname(cs[c]);
        if ((ct !== "td" && ct !== "th") || isHidden(cs[c])) continue;
        var cell = flatText(cs[c], ctx).replace(/^\s+|\s+$/g, "");
        if (MD) cell = cell.replace(/\|/g, "\\|");
        cells.push(cell);
        var span = parseInt(attr(cs[c], "colspan"), 10);
        if (isFinite(span) && span > 1) for (var s = 1; s < span && s < 20; s++) cells.push("");
      }
      if (cells.length === 0) continue;
      data.push(cells);
    }
    var cols = 0;
    for (var d = 0; d < data.length; d++) if (data[d].length > cols) cols = data[d].length;
    if (cols === 0) return caption ? caption : "";
    for (var e = 0; e < data.length; e++) while (data[e].length < cols) data[e].push("");
    var out = [];
    if (!MD) {
      for (var f = 0; f < data.length; f++) out.push(data[f].join("\t"));
      return (caption ? caption + "\n" : "") + out.join("\n");
    }
    // markdown 表必须有表头：不管有没有 thead / th，第一行就是表头（保持原行序，不重排）
    var row = function (cells) { return "| " + cells.map(function (x) { return x === "" ? " " : x; }).join(" | ") + " |"; };
    out.push(row(data[0]));
    out.push("|" + repeat(" --- |", cols));
    for (var h = 1; h < data.length; h++) out.push(row(data[h]));
    return (caption ? "**" + caption + "**\n\n" : "") + out.join("\n");
  }

  function renderElement(el, ctx) {
    state.nodes++;
    if (state.nodes > MAX_NODES) { state.stop = true; state.cut = true; return null; }
    var tag = lname(el);
    if (SKIP[tag]) return null;
    if (el !== state.rootEl && isHidden(el)) return null;
    switch (tag) {
      case "br": return { kind: "inline", text: "\n" };
      case "wbr": return { kind: "inline", text: "" };
      case "hr": return block("---");
      case "img": {
        // 只留 alt，不带 src（既省 token，也不把追踪像素 / data URI 摊给模型）
        var alt = collapse(attr(el, "alt")).replace(/^\s+|\s+$/g, "");
        return { kind: "inline", text: alt ? "[图片：" + esc(alt.slice(0, 200)) + "]" : "" };
      }
      case "a": {
        var e = edge(flatText(el, ctx));
        var core = e.core;
        if (!core) {
          var lab = collapse(attr(el, "aria-label") || attr(el, "title")).replace(/^\s+|\s+$/g, "");
          core = lab ? esc(lab.slice(0, 200)) : "";
        }
        if (!core) return { kind: "inline", text: e.lead || e.trail ? " " : "" };
        // 只留 http(s) 与 mailto；javascript: 之类直接丢掉链接、保留文字
        var url = MD ? safeUrl(attr(el, "href")) : "";
        return { kind: "inline", text: e.lead + (url ? "[" + core + "](" + url + ")" : core) + e.trail };
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        var ht = flatText(el, ctx).replace(/^\s+|\s+$/g, "");
        return ht ? block(MD ? repeat("#", +tag.charAt(1)) + " " + ht : ht) : null;
      }
      case "pre": { var code = fenced(el); return code ? block(code) : null; }
      case "code": case "kbd": case "samp": {
        var ce = edge(flatText(el, { noEsc: true }));
        if (!ce.core) return { kind: "inline", text: "" };
        if (!MD) return { kind: "inline", text: ce.lead + ce.core + ce.trail };
        var fence = ce.core.indexOf(BT) >= 0 ? BT + BT : BT;
        var pad = ce.core.charAt(0) === BT || ce.core.charAt(ce.core.length - 1) === BT ? " " : "";
        return { kind: "inline", text: ce.lead + fence + pad + ce.core + pad + fence + ce.trail };
      }
      case "ul": case "ol": { var lt = renderList(el, ctx, tag === "ol"); return lt ? block(lt) : null; }
      case "table": { var tt = renderTable(el, ctx); return tt ? block(tt) : null; }
      case "blockquote": {
        var bq = renderChildren(el, ctx).blocks.join("\n\n");
        if (!bq) return null;
        return block(MD ? bq.split("\n").map(function (l) { return l ? "> " + l : ">"; }).join("\n") : bq);
      }
      case "strong": case "b": return MD ? inlineWrap(el, ctx, "**", "**") : inlineWrap(el, ctx, "", "");
      case "em": case "i": return MD ? inlineWrap(el, ctx, "*", "*") : inlineWrap(el, ctx, "", "");
      case "del": case "s": case "strike": return MD ? inlineWrap(el, ctx, "~~", "~~") : inlineWrap(el, ctx, "", "");
      case "dt": { var dt = flatText(el, ctx).replace(/^\s+|\s+$/g, ""); return dt ? block(MD ? "**" + dt + "**" : dt) : null; }
      case "dd": { var dd = renderChildren(el, ctx).blocks.join("\n"); return dd ? block(": " + dd.split("\n").join("\n  ")) : null; }
      case "slot": {
        var assigned = null;
        try { assigned = el.assignedNodes ? el.assignedNodes() : null; } catch (e2) { assigned = null; }
        if (assigned && assigned.length > 0) {
          var fake = { childNodes: assigned };
          var sr = renderChildren(fake, ctx);
          return sr.hasBlock ? block(sr.blocks.join("\n\n")) : { kind: "inline", text: sr.rawInline };
        }
        break;
      }
      default: break;
    }
    // 通用容器：有块级子孙或自己是块级标签 → 块；否则当行内（保留边缘空白，交给外层整理）
    var inner = renderChildren(el, ctx);
    if (BLOCK[tag] || inner.hasBlock) {
      var txt = inner.blocks.join(MD ? "\n\n" : "\n\n");
      return txt ? block(txt) : null;
    }
    return { kind: "inline", text: inner.rawInline };
  }

  try {
    var self = this;
    var root = null;
    var rootKind = "body";
    if (self && self.nodeType === 1) {
      root = self;
      rootKind = "element";
    } else {
      root = document.body || document.documentElement;
      if (OPTS.mainContent) {
        var cands = document.querySelectorAll('article, main, [role="main"]');
        var best = null;
        var bestLen = 0;
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i];
          if (isHidden(c) || ancestorHidden(c)) continue;
          var len = String(c.textContent || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").length;
          // 太短的 article（侧栏卡片 / 评论条）不算正文：否则会只读到页面的一小角
          if (len >= 80 && len > bestLen) { best = c; bestLen = len; }
        }
        if (best) {
          root = best;
          rootKind = lname(best) === "article" || lname(best) === "main" ? lname(best) : "main";
        }
      }
    }
    if (!root) return { text: "", truncated: false, totalLength: 0, root: rootKind, nodes: 0 };
    state.rootEl = root;
    var res = renderElement(root, { noEsc: false });
    var text = res ? res.text : "";
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
    var total = text.length;
    var truncated = state.cut || state.stop || total > MAX;
    if (total > MAX) {
      var cut = text.slice(0, MAX);
      var nl = cut.lastIndexOf("\n");
      if (nl > MAX * 0.8) cut = cut.slice(0, nl);
      text = cut.replace(/\s+$/, "");
    }
    return { text: text, truncated: truncated, totalLength: total, root: rootKind, nodes: state.nodes };
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 300) };
  }
`;

/**
 * 读取脚本：返回一段**函数表达式**源码（`function () { ... }`）。
 * - 有 ref：交给 Runtime.callFunctionOn（`this` = 目标元素，只读该元素）；
 * - 无 ref：用 {@link asExpression} 包成 `(fn).call(null)` 交给 Runtime.evaluate，`this` 为空 → 按 mainContent 选根。
 * 结果：`{ text, truncated, totalLength, root, nodes }` 或 `{ error }`。
 */
export const buildReadScript = (opts = {}) => {
  const o = normalizeReadOptions(opts);
  return `function () {${READ_BODY.replace("__OPTS__", () => toLiteral(o))}}`;
};

// ───────────────────────── inspect 脚本 ─────────────────────────

const INSPECT_BODY = String.raw`
  "use strict";
  var OPTS = __OPTS__;
  var VMAX = OPTS.valueMax;
  var HMAX = OPTS.htmlMax;
  var el = this;
  function clip(s, n) { s = String(s === null || s === undefined ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function n1(v) { return Math.round((+v || 0) * 10) / 10; }
  function lname(e) { return String(e.localName || e.tagName || "").toLowerCase(); }
  function attrOf(e, n) { try { var v = e.getAttribute(n); return v === null || v === undefined ? "" : String(v); } catch (x) { return ""; } }
  // 敏感输入：password / 一次性验证码 / 银行卡类（cc-*）/ -webkit-text-security 遮罩。规则与主进程、录制器共用 secret-field.mjs（R1-25）；
  // 它们的 value 属性永不外传。出错按敏感处理。
  __SECRET_FNS__
  function isSecret(e) {
    var t = lname(e);
    if (t !== "input" && t !== "textarea") return false;
    try { return isSecretInfo(readSecretInfo(e)) === true; } catch (x) { return true; }
  }
  // <input type=hidden>：CSRF token / 会话令牌常放在 value 里，和密码一样不外传（R1-29）
  function isHiddenInput(e) {
    return lname(e) === "input" && attrOf(e, "type").toLowerCase() === "hidden";
  }
  function dropsValue(e) {
    return isHiddenInput(e) || isSecret(e);
  }
  function skipAttr(e, name) {
    if (/^on/i.test(name)) return true;
    if (name.toLowerCase() === "value" && dropsValue(e)) return true;
    return false;
  }
  try {
    if (!el || el.nodeType !== 1) return { error: "目标不是元素节点" };
    var INC = {};
    for (var i = 0; i < OPTS.include.length; i++) INC[OPTS.include[i]] = true;
    var out = { tag: lname(el) };
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e1) { cs = null; }
    if (INC.box) {
      var r = el.getBoundingClientRect();
      var vw = (typeof window !== "undefined" && window.innerWidth) || (document.documentElement && document.documentElement.clientWidth) || 0;
      var vh = (typeof window !== "undefined" && window.innerHeight) || (document.documentElement && document.documentElement.clientHeight) || 0;
      var has = r.width > 0 && r.height > 0;
      var left = r.left !== undefined ? r.left : r.x;
      var top = r.top !== undefined ? r.top : r.y;
      out.box = {
        x: n1(r.x !== undefined ? r.x : left),
        y: n1(r.y !== undefined ? r.y : top),
        width: n1(r.width),
        height: n1(r.height),
        inViewport: has && left + r.width > 0 && top + r.height > 0 && left < vw && top < vh,
        visible: has && !!cs && cs.display !== "none" && cs.visibility !== "hidden" && cs.visibility !== "collapse"
      };
    }
    if (INC.attrs) {
      var attrs = {};
      var list = el.attributes || [];
      var count = 0;
      for (var a = 0; a < list.length && count < 60; a++) {
        var nm = String(list[a].name);
        if (skipAttr(el, nm)) continue;
        attrs[nm] = clip(list[a].value, VMAX);
        count++;
      }
      out.attrs = attrs;
    }
    if (INC.styles) {
      var styles = {};
      for (var p = 0; p < OPTS.styleProps.length; p++) {
        var prop = OPTS.styleProps[p];
        var val = "";
        try { val = cs ? cs.getPropertyValue(prop) : ""; } catch (e2) { val = ""; }
        styles[prop] = clip(val, VMAX);
      }
      out.styles = styles;
    }
    if (INC.html) {
      // 克隆后再清洗：脚本内容 / on* 属性 / 敏感输入的 value 都不外传（克隆体不进文档，不会执行）
      var clone = el.cloneNode(true);
      var all = [clone];
      var q = clone.querySelectorAll ? clone.querySelectorAll("*") : [];
      for (var k = 0; k < q.length; k++) all.push(q[k]);
      // 敏感判定必须在「原节点」上做（克隆体不在文档里，computed style 取不到 -webkit-text-security）；克隆与原树遍历顺序一致，按下标配对
      var origAll = [el];
      var oq = el.querySelectorAll ? el.querySelectorAll("*") : [];
      for (var ok = 0; ok < oq.length; ok++) origAll.push(oq[ok]);
      if (origAll.length !== all.length) {
        // 配对失败（R1-29 复审）：没法在原节点上逐个判定，退回「按克隆体判」会漏掉靠 CSS 遮罩的字段（克隆体取不到 computed style），
        // 那只是降级、不是 fail-closed——所以整段 html 直接置空并注明，不给半截。
        out.html = "";
        out.htmlNote = "html 已隐藏：克隆节点与原节点对不上，无法确认其中的输入框都已脱敏，出于安全不返回 HTML";
      } else {
        for (var m = 0; m < all.length; m++) {
          var n = all[m];
          if (lname(n) === "script") n.textContent = "";
          var secret = dropsValue(origAll[m]);
          if (secret && lname(n) === "textarea") n.textContent = "";
          var names = [];
          var al = n.attributes || [];
          for (var z = 0; z < al.length; z++) names.push(String(al[z].name));
          for (var y = 0; y < names.length; y++) {
            if (/^on/i.test(names[y]) || (secret && names[y].toLowerCase() === "value")) n.removeAttribute(names[y]);
          }
        }
        out.html = clip(String(clone.outerHTML || ""), HMAX);
      }
    }
    return out;
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 300) };
  }
`;

/**
 * 检查脚本：函数表达式源码，`this` = 目标元素（callFunctionOn）。
 * 结果：`{ tag, box?, attrs?, styles?, html? }` 或 `{ error }`；role / name 由调用方从 ref 表补。
 */
export const buildInspectScript = ({ include, styleProps } = {}) => {
  const props = normalizeStyleProps(styleProps);
  const o = {
    include: normalizeInclude(include),
    styleProps: props.length > 0 ? props : [...DEFAULT_STYLE_PROPS],
    valueMax: INSPECT_VALUE_MAX,
    htmlMax: INSPECT_HTML_MAX,
  };
  return `function () {${INSPECT_BODY.replace("__SECRET_FNS__", () => SECRET_FIELD_FNS_SOURCE).replace("__OPTS__", () => toLiteral(o))}}`;
};

/** 把「函数表达式」包成可交给 Runtime.evaluate 的表达式（this 为 null） */
export const asExpression = (fnSource) => `(${fnSource}).call(null)`;
