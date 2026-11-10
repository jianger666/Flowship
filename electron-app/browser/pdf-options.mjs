/**
 * 增强包 E2 · C5 `browser_save` kind=pdf 的打印选项（纯函数，有单测）。
 *
 * 只有三件事：把模型给的参数**严格校验**成固定形状、**清洗页眉页脚模板**、翻成 `Page.printToPDF` / `webContents.printToPDF` 的参数。
 * 不传任何选项 = 与 E1 完全相同的行为（`printBackground:true, preferCSSPageSize:true`）。
 *
 * 页眉页脚模板是一小段 HTML，会被 Chromium 渲染进 PDF。虽然渲染环境无脚本，但外链资源（`<img src=http://…>`）会发请求、
 * 任意标签会把页面撑坏，所以只放行「纯文字 + 五个官方占位 span（date / title / url / pageNumber / totalPages）」，
 * 其余标签整个剥掉（script / style 等连同内容一起删），文字里的 `& < >` 转成实体。字号 / 对齐由我们固定的外层 div 提供
 * （Chromium 的页眉页脚默认字号是 0，不给样式就看不见）。
 */

/** 纸张尺寸（英寸，宽 × 高，竖向）：与 Chromium / CSS 标准纸张一致 */
export const PDF_PAPER_SIZES = Object.freeze({
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  a0: [33.11, 46.81],
  a1: [23.39, 33.11],
  a2: [16.54, 23.39],
  a3: [11.69, 16.54],
  a4: [8.27, 11.69],
  a5: [5.83, 8.27],
  a6: [4.13, 5.83],
});
export const PDF_PAPER_FORMATS = Object.freeze(Object.keys(PDF_PAPER_SIZES));

export const PDF_SCALE_MIN = 0.1;
export const PDF_SCALE_MAX = 2;
export const PDF_MARGIN_MAX_INCH = 3;
export const PDF_PAGE_RANGES_MAX = 64;
export const PDF_TEMPLATE_MAX = 2000;

/** 页眉页脚里允许的官方占位 class */
export const PDF_TEMPLATE_PLACEHOLDERS = Object.freeze(["date", "title", "url", "pageNumber", "totalPages"]);

const PLACEHOLDER_OPEN_RE = /^<span\s+class\s*=\s*(?:"([A-Za-z]+)"|'([A-Za-z]+)'|([A-Za-z]+))\s*>$/i;
const DANGEROUS_BLOCK_RE = /<\s*(script|style|iframe|object|embed|template|svg|math|textarea|noscript)\b[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const TAG_RE = /<[^<>]*>/g;

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 清洗页眉 / 页脚模板：返回可以直接交给 Chromium 的 HTML（空串 = 没有内容）。
 * @param {unknown} input
 */
export const sanitizePdfTemplate = (input) => {
  if (typeof input !== "string") return "";
  let s = input.slice(0, PDF_TEMPLATE_MAX * 4); // 先限长再跑正则：病态输入不拖慢主进程
  s = s.replace(COMMENT_RE, "").replace(DANGEROUS_BLOCK_RE, "");
  const canonical = new Map(PDF_TEMPLATE_PLACEHOLDERS.map((p) => [p.toLowerCase(), p]));
  let out = "";
  let last = 0;
  for (const m of s.matchAll(TAG_RE)) {
    out += escapeText(s.slice(last, m.index));
    last = m.index + m[0].length;
    const open = PLACEHOLDER_OPEN_RE.exec(m[0]);
    const cls = open ? canonical.get((open[1] ?? open[2] ?? open[3]).toLowerCase()) : undefined;
    // 放行的占位 span：重新输出成固定形态（丢掉原有属性）；闭合标签 / 其它任何标签一律丢弃
    if (cls) out += `<span class="${cls}"></span>`;
  }
  out += escapeText(s.slice(last));
  out = out.replace(/\s+/g, " ").trim();
  return out.length > PDF_TEMPLATE_MAX ? out.slice(0, PDF_TEMPLATE_MAX) : out;
};

/** 包一层固定样式（页眉页脚默认字号为 0）；没有内容返回 `<span></span>`（显式空模板，避免 Chromium 回落到默认的日期 / 网址） */
const wrapTemplate = (inner) =>
  inner === "" ? "<span></span>" : `<div style="font-size:9px;width:100%;text-align:center;padding:0 12px;">${inner}</div>`;

const PAGE_RANGE_TOKEN_RE = /^(?:(\d{1,5})(?:-(\d{1,5})?)?|-(\d{1,5}))$/;

/** "1-3, 5, 8-" → 规整字符串；非法返回 null（不让页码范围里混进别的字符） */
export const normalizePageRanges = (raw) => {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s.length > PDF_PAGE_RANGES_MAX) return null;
  // 只允许「-」两侧与「,」两侧有空白；数字之间的空白（"1 2"）不能被悄悄拼成 12
  const tokens = s.split(",").map((t) => t.trim().replace(/\s*-\s*/g, "-"));
  for (const t of tokens) {
    const m = PAGE_RANGE_TOKEN_RE.exec(t);
    if (!m) return null;
    const from = m[1] !== undefined ? Number(m[1]) : undefined;
    const to = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : undefined;
    if (from === 0 || to === 0) return null; // 页码从 1 开始
    if (from !== undefined && m[2] !== undefined && to !== undefined && to < from) return null;
  }
  return tokens.join(",");
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * 严格校验 / 规整（`ops/read.mjs` 的 save normalize 调用）。入参是 camelCase 的原始 args，非法返回 `{ error }`，合法返回 `{ options }`
 * （只含用户显式给的字段；全空 = `options` 为 undefined，沿用 E1 行为）。
 * @param {Record<string, unknown>} args
 */
export const parsePdfOptions = (args) => {
  const o = {};
  const bad = (msg) => ({ error: msg });

  if (args.landscape !== undefined && args.landscape !== null) {
    if (typeof args.landscape !== "boolean") return bad("参数 landscape 必须是布尔值");
    o.landscape = args.landscape;
  }
  if (args.scale !== undefined && args.scale !== null) {
    if (!isNum(args.scale) || args.scale < PDF_SCALE_MIN || args.scale > PDF_SCALE_MAX) {
      return bad(`参数 scale 必须是 ${PDF_SCALE_MIN}–${PDF_SCALE_MAX} 之间的数字`);
    }
    o.scale = args.scale;
  }
  if (args.pageRanges !== undefined && args.pageRanges !== null && args.pageRanges !== "") {
    const r = normalizePageRanges(args.pageRanges);
    if (r === null) return bad(`参数 pageRanges 格式不对（如 "1-3,5"，页码从 1 开始，≤ ${PDF_PAGE_RANGES_MAX} 字符）`);
    o.pageRanges = r;
  }
  if (args.paperFormat !== undefined && args.paperFormat !== null && args.paperFormat !== "") {
    const f = typeof args.paperFormat === "string" ? args.paperFormat.toLowerCase() : "";
    if (!PDF_PAPER_FORMATS.includes(f)) return bad(`参数 paperFormat 只能是：${PDF_PAPER_FORMATS.join(" / ")}`);
    o.paperFormat = f;
  }
  if (args.margins !== undefined && args.margins !== null) {
    const m = args.margins;
    if (typeof m !== "object" || Array.isArray(m)) return bad("参数 margins 必须是对象 {top,right,bottom,left}（单位英寸）");
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      if (!["top", "right", "bottom", "left"].includes(k)) return bad(`margins 里没有 ${String(k).slice(0, 20)}（只有 top / right / bottom / left）`);
      if (!isNum(v) || v < 0 || v > PDF_MARGIN_MAX_INCH) return bad(`margins.${k} 必须是 0–${PDF_MARGIN_MAX_INCH} 英寸之间的数字`);
      out[k] = v;
    }
    if (Object.keys(out).length > 0) o.margins = out;
  }
  if (args.printBackground !== undefined && args.printBackground !== null) {
    if (typeof args.printBackground !== "boolean") return bad("参数 printBackground 必须是布尔值");
    o.printBackground = args.printBackground;
  }
  for (const key of ["header", "footer"]) {
    const v = args[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return bad(`参数 ${key} 必须是字符串模板`);
    if (v.length > PDF_TEMPLATE_MAX) return bad(`参数 ${key} 过长（上限 ${PDF_TEMPLATE_MAX} 字符）`);
    // 清洗后什么都不剩（比如只写了 <script>）也算「给了模板」：显式空模板，不回落到 Chromium 默认的日期 / 网址
    o[key] = sanitizePdfTemplate(v);
  }
  return Object.keys(o).length > 0 ? { options: o } : { options: undefined };
};

const marginsInches = (m) => ({
  // Chromium 默认约 0.4 英寸
  top: m?.top ?? 0.4,
  bottom: m?.bottom ?? 0.4,
  left: m?.left ?? 0.4,
  right: m?.right ?? 0.4,
});

/**
 * `Page.printToPDF` 的参数。没有选项 = E1 的老参数
 * @param {Record<string, any> | undefined} options
 * @returns {Record<string, any>}
 */
export const buildPrintToPdfParams = (options) => {
  if (!options) return { printBackground: true, preferCSSPageSize: true };
  const p = {
    printBackground: options.printBackground ?? true,
    // 显式给了纸张规格才压过页面 CSS 的 @page size；只调方向 / 边距 / 缩放时仍尊重页面自己声明的纸张
    preferCSSPageSize: options.paperFormat === undefined,
  };
  if (options.landscape !== undefined) p.landscape = options.landscape;
  if (options.scale !== undefined) p.scale = options.scale;
  if (options.pageRanges !== undefined) p.pageRanges = options.pageRanges;
  if (options.paperFormat !== undefined) {
    const [w, h] = PDF_PAPER_SIZES[options.paperFormat];
    p.paperWidth = w;
    p.paperHeight = h;
  }
  if (options.margins !== undefined) {
    const m = marginsInches(options.margins);
    p.marginTop = m.top;
    p.marginBottom = m.bottom;
    p.marginLeft = m.left;
    p.marginRight = m.right;
  }
  if (options.header !== undefined || options.footer !== undefined) {
    p.displayHeaderFooter = true;
    p.headerTemplate = wrapTemplate(options.header ?? "");
    p.footerTemplate = wrapTemplate(options.footer ?? "");
  }
  return p;
};

/**
 * `webContents.printToPDF` 的参数（Chromium 经 debugger 的 printToPDF 不可用时的退路）：同一份语义翻成 Electron 的字段名
 * @param {Record<string, any> | undefined} options
 * @returns {Record<string, any>}
 */
export const buildElectronPdfOptions = (options) => {
  if (!options) return { printBackground: true, preferCSSPageSize: true };
  const p = buildPrintToPdfParams(options);
  const out = { printBackground: p.printBackground, preferCSSPageSize: p.preferCSSPageSize };
  if (p.landscape !== undefined) out.landscape = p.landscape;
  if (p.scale !== undefined) out.scale = p.scale;
  if (p.pageRanges !== undefined) out.pageRanges = p.pageRanges;
  if (p.paperWidth !== undefined) out.pageSize = { width: p.paperWidth, height: p.paperHeight };
  if (p.marginTop !== undefined) out.margins = { top: p.marginTop, bottom: p.marginBottom, left: p.marginLeft, right: p.marginRight };
  if (p.displayHeaderFooter) {
    out.displayHeaderFooter = true;
    out.headerTemplate = p.headerTemplate;
    out.footerTemplate = p.footerTemplate;
  }
  return out;
};
