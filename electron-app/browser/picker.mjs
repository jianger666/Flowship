// 元素拾取（契约 §5 / §8.2，P3）：用户在内置浏览器里点「拾取元素」→ 悬停高亮 → 点选 → 得到 PickedElement。
//
// 实现：CDP `Overlay.setInspectMode{searchForNode}`（浏览器原生的 DevTools 检查高亮，页面里零注入）
//   → 监听 `Overlay.inspectNodeRequested{backendNodeId}` → `DOM.resolveNode` 拿对象
//   → 主世界 `Runtime.callFunctionOn(PICK_PROBE_SOURCE)` 在页内算「稳定选择器 / 角色 / 名称 / 文本 / rect / React 源」
//   → `Page.captureScreenshot{clip}` 截元素图 → shapePickedElement 整形（截断 / 体积上限）。
//
// 结束（选中 / 取消 / 失败 / tab 销毁）一律：移除 Esc 监听 + 退订 CDP 事件 + `Overlay.setInspectMode{none}` + onEnd。
// 为什么 Esc 要挂 webContents：原生 view 持有焦点时渲染进程（Flowship 自己的 UI）收不到 keydown，
// 只能在被拾取页的 `before-input-event`（主进程侧、早于页面）里截。
//
// 纯逻辑（可单测，不依赖 Electron）：truncate / clipFromRect / dataUrlBytes / shapePickedElement /
// PICK_PROBE_SOURCE（页内函数源码）/ INSPECT_HIGHLIGHT_CONFIG。

import { SECRET_FIELD_FNS_SOURCE, isSecretInfo } from "./secret-field.mjs";

export const OUTER_HTML_MAX = 4000;
export const TEXT_MAX = 500;
/** 元素截图 dataURL 体积上限（字节）；超了不带 */
export const SCREENSHOT_MAX_BYTES = 200 * 1024;

/** 悬停高亮：清楚的蓝色（内容区半透明蓝、边框深蓝、padding 浅蓝、margin 更淡）；显示尺寸 / 选择器提示 */
export const INSPECT_HIGHLIGHT_CONFIG = Object.freeze({
  showInfo: true,
  showStyles: false,
  showRulers: false,
  showAccessibilityInfo: false,
  showExtensionLines: false,
  contentColor: Object.freeze({ r: 59, g: 130, b: 246, a: 0.35 }),
  paddingColor: Object.freeze({ r: 96, g: 165, b: 250, a: 0.25 }),
  borderColor: Object.freeze({ r: 37, g: 99, b: 235, a: 0.9 }),
  marginColor: Object.freeze({ r: 191, g: 219, b: 254, a: 0.25 }),
});

/**
 * 截断到不超过 max 个字符（含省略号）；非字符串当空串。
 * 用「…」收尾让读的人（和 AI）知道被截过。
 */
export const truncate = (value, max) => {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(0, max));
  // 别把代理对（emoji）劈成两半：落在高位代理上就多退一位
  let end = max - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
};

const finite = (n, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

/**
 * 整形 rect：数字化 + 保留 2 位小数；宽高不为负
 * @param {any} rect
 */
export const normalizeRect = (rect) => {
  const r = rect && typeof rect === "object" ? rect : {};
  const round2 = (n) => Math.round(finite(n) * 100) / 100;
  return {
    x: round2(r.x),
    y: round2(r.y),
    width: Math.max(0, round2(r.width)),
    height: Math.max(0, round2(r.height)),
  };
};

/**
 * 由元素的「视口 rect」+ 页面滚动偏移算 `Page.captureScreenshot` 的 clip（文档坐标、CSS 像素）。
 * 太小（< 1px）返回 null（截不出东西）；太大按 maxWidth 缩放（scale<1），避免几 MB 的 PNG。
 * @param {any} rect  getBoundingClientRect（视口坐标）{x,y,width,height}；缺失 / 非法当 0×0
 * @param {{scrollX?:number, scrollY?:number}} [scroll]
 * @param {{maxWidth?:number, maxHeight?:number}} [opts]
 */
export const clipFromRect = (rect, scroll = {}, opts = {}) => {
  const r = normalizeRect(rect);
  if (r.width < 1 || r.height < 1) return null;
  const maxWidth = opts.maxWidth ?? 1280;
  const maxHeight = opts.maxHeight ?? 4000;
  const scale = Math.min(1, maxWidth / r.width, maxHeight / r.height);
  return {
    x: Math.max(0, r.x + finite(scroll.scrollX)),
    y: Math.max(0, r.y + finite(scroll.scrollY)),
    width: r.width,
    height: r.height,
    scale: scale > 0 ? Math.round(scale * 1000) / 1000 : 1,
  };
};

/** `data:image/jpeg;base64,xxxx` 的 dataURL 近似字节数（整串长度，即「带不带」的判据，不去解 base64） */
export const dataUrlBytes = (dataUrl) => (typeof dataUrl === "string" ? dataUrl.length : 0);

const normalizeReactSource = (src) => {
  if (!src || typeof src !== "object") return null;
  const file = typeof src.file === "string" ? src.file.trim() : "";
  if (!file) return null;
  const out = { file: truncate(file, 500) };
  const line = Number(src.line);
  if (Number.isFinite(line) && line > 0) out.line = Math.floor(line);
  if (typeof src.component === "string" && src.component.trim()) out.component = truncate(src.component.trim(), 120);
  return out;
};

// 标签与属性分词（按 HTML 规范的分词状态机，R4-01）。
// 标签边界不用正则找（R3-05）：旧版 `<input\b(?:"[^"]*"|'[^']*'|[^>"'])*>` 遇到「很多 `<input ` + 一个落单的引号」，
// 每个起点都向后扫到串尾再回溯，140K 字符要 3.5s（页面的 <script> / 注释里就能塞这种文本，picker 与 inspect 的降级路径会把主进程卡死）。
// 改成下面的 {@link scanTagEnd} + 位置记忆化的单遍扫描。
//
// R4-01：只有跟在 `=` 后面的引号才是值定界符。旧版「见引号就配对」把属性**名**里的引号也当定界符：手写标记里常见的多打一个引号
// （`value="x""`）在规范里是一个名为 `"` 的属性，序列化后是 `value="x" "="">`，引号总数是奇数 → 配不上 → 整个标签被当成「不是标签」→ value 不脱敏。
// 现在按规范的状态走：before attribute name（BAN）→ attribute name → after attribute name → before value →
// 双引号 / 单引号 / 无引号值 → after quoted value（回到 BAN）。只有「`=` 之后紧跟引号」才去找配对引号；配不上 = EOF in tag = 不是标签。
// 标签名必须恰好是 input / textarea（后面是空白 / `/` / `>`）：`<input-x` / `<input<input…` 在规范里是别的元素，也避免了对「标签名」的重复长扫描。
const TAG_START_RE_SRC = "<(input|textarea)(?=[\\t\\n\\f\\r />])";
const TEXTAREA_CLOSE_RE_SRC = "<\\/textarea\\b";
/** 字符串级脱敏最多处理这么多字符（超出部分丢弃：出口本来就会截到 4000 / 16000，不会因此少给；记忆表也因此有上界） */
const HTML_REDACT_MAX = 400_000;
/** 单个 `<input>` 最多解析这么多个属性：超过就整个标签丢弃（fail-closed）；让「每个起点各解析一遍」的总量有上界（≤ 48 × 串长） */
const TAG_ATTR_MAX = 48;

/** HTML 的空白：空格 / Tab / LF / FF / CR（不含 NBSP 等 Unicode 空白——规范里它们是名字的一部分） */
const isHtmlWs = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** BAN 态的分隔：空白，以及「后面不是 `>`」的 `/`（自闭合斜杠，规范里重新当作 BAN 处理，等价于跳过） */
const skipSep = (src, p) => {
  const n = src.length;
  while (p < n) {
    const c = src.charCodeAt(p);
    if (isHtmlWs(c) || c === 47) p += 1;
    else break;
  }
  return p;
};

/**
 * 在 BAN 位置 p（已 skipSep）读一个属性，或遇到标签结束符。
 * - 返回 `null`：到串尾标签还没结束（EOF in tag，不是标签）；
 * - 返回 `{ end }`：遇到 `>`，`end` 是它之后的位置；
 * - 否则 `{ nameS, nameE, valS, valE, attrEnd, next }`：名字 [nameS, nameE)；`valS < 0` = 没有值，否则值内容 [valS, valE)（不含引号）；
 *   attrEnd = 整个属性之后的位置（引号值含收尾引号）；next = 下一个 BAN 候选位置（还没 skipSep）。
 * 名字的第一个字符无条件算名字（含 `=` / 引号 / `<`），之后到空白 / `/` / `>` / `=` 为止（规范 attribute name state）。
 */
const readAttr = (src, p) => {
  const n = src.length;
  if (p >= n) return null;
  if (src.charCodeAt(p) === 62) return { end: p + 1 };
  const nameS = p;
  p += 1;
  while (p < n) {
    const c = src.charCodeAt(p);
    if (isHtmlWs(c) || c === 47 || c === 62 || c === 61) break;
    p += 1;
  }
  const nameE = p;
  // after attribute name：跳空白，只有 `=` 才引出值；其它字符（含 `/`、`>`、下一个属性名）回到 BAN
  let q = nameE;
  while (q < n && isHtmlWs(src.charCodeAt(q))) q += 1;
  if (q >= n || src.charCodeAt(q) !== 61) return { nameS, nameE, valS: -1, valE: -1, attrEnd: nameE, next: q };
  q += 1;
  while (q < n && isHtmlWs(src.charCodeAt(q))) q += 1;
  if (q >= n) return null;
  const c0 = src.charCodeAt(q);
  if (c0 === 34 || c0 === 39) {
    const r = src.indexOf(c0 === 34 ? '"' : "'", q + 1);
    if (r < 0) return null; // EOF in quoted value
    return { nameS, nameE, valS: q + 1, valE: r, attrEnd: r + 1, next: r + 1 };
  }
  if (c0 === 62) return { nameS, nameE, valS: -1, valE: -1, attrEnd: q, next: q }; // `name=>`：缺值，`>` 留给下一轮收尾
  const valS = q;
  while (q < n) {
    const c = src.charCodeAt(q);
    if (isHtmlWs(c) || c === 62) break;
    q += 1;
  }
  return { nameS, nameE, valS, valE: q, attrEnd: q, next: q };
};

/** style 属性里的 `-webkit-text-security` / `text-security` 声明值（多处声明合并成一串；任一为 disc / circle / square 即命中，宁可多清） */
const textSecurityOfStyle = (style) => {
  if (typeof style !== "string" || style === "") return "";
  const vals = [];
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    const name = decl.slice(0, i).trim().toLowerCase();
    if (name === "-webkit-text-security" || name === "text-security") vals.push(decl.slice(i + 1).trim());
  }
  return vals.join(" ");
};

/**
 * 从 `bodyStart`（`<input` / `<textarea` 之后）起找标签结束符 `>` 的下一个位置；找不到（引号值没收尾 / 串尾）返回 -1。
 * 扫描是「BAN 位置 → 结果」的确定函数，所以把走过的 BAN 位置记进 `memo`（0 = 未知，-1 = 找不到，>0 = 结束位置）：
 * 后面的起点走到记过的位置就直接复用，整串总扫描量 O(n)（每个 BAN 位置至多展开一次）。
 * @param {string} src
 * @param {number} bodyStart
 * @param {Int32Array} memo  长度 ≥ src.length + 1
 */
export const scanTagEnd = (src, bodyStart, memo) => {
  const n = src.length;
  /** @type {number[]} */
  const visited = [];
  let p = bodyStart;
  let res = -1;
  for (;;) {
    p = skipSep(src, p);
    if (p >= n) break;
    const known = memo[p];
    if (known !== 0) {
      res = known;
      break;
    }
    visited.push(p);
    const a = readAttr(src, p);
    if (a === null) break;
    if (a.end !== undefined) {
      res = a.end;
      break;
    }
    p = a.next;
  }
  for (let i = 0; i < visited.length; i += 1) memo[visited[i]] = res;
  return res;
};

/**
 * 按真正的属性边界拆 `<input …>` 标签（而不是在整串里搜 `type=`）：`<input data-x=" type=text " type="password">` 里，
 * 引号内的 `type=text` 不是属性，HTML 只认第一个真属性（同名重复时第一个生效）。
 * 只记 type / autocomplete / style 三个判敏感用的属性（首个生效）与全部 value 属性的位置。
 * @returns {{ overflow: boolean, attrs: { type?: string, autocomplete?: string, style?: string }, valueSpans: Array<[number, number]> }}
 *   valueSpans：每个 value 属性在**整串**里的 [起, 止)（连同前导空白）；overflow = 属性数超过 {@link TAG_ATTR_MAX}
 */
const parseInputAttrs = (src, bodyStart) => {
  /** @type {{ type?: string, autocomplete?: string, style?: string }} */
  const attrs = {};
  /** @type {Array<[number, number]>} */
  const valueSpans = [];
  let p = bodyStart;
  for (let tokens = 0; ; tokens += 1) {
    if (tokens > TAG_ATTR_MAX) return { overflow: true, attrs, valueSpans };
    p = skipSep(src, p);
    const a = readAttr(src, p);
    if (a === null || a.end !== undefined) break;
    // 只有长度恰好是目标名（type 4 / value 5 / style 5 / autocomplete 12）的名字才取出来比较，其余不分配字符串
    const nameLen = a.nameE - a.nameS;
    const name = nameLen === 4 || nameLen === 5 || nameLen === 12 ? src.slice(a.nameS, a.nameE).toLowerCase() : "";
    if (name === "value") {
      let from = a.nameS;
      while (from > bodyStart && isHtmlWs(src.charCodeAt(from - 1))) from -= 1;
      valueSpans.push([from, a.attrEnd]);
    } else if ((name === "type" || name === "autocomplete" || name === "style") && attrs[name] === undefined) {
      attrs[name] = a.valS < 0 ? "" : src.slice(a.valS, a.valE);
    }
    p = a.next;
  }
  return { overflow: false, attrs, valueSpans };
};

/**
 * 一个 `<input …>` 标签要剪掉的区间（整串坐标，[起, 止)）：敏感输入框的全部 value 属性；属性数溢出 → 整个标签（fail-closed）；其余 → 空。
 * @returns {Array<[number, number]>}
 */
const inputTagCuts = (src, tagStart, bodyStart, end) => {
  const { overflow, attrs, valueSpans } = parseInputAttrs(src, bodyStart);
  if (overflow) return [[tagStart, end]];
  if (valueSpans.length === 0) return [];
  const type = String(attrs.type ?? "").trim().toLowerCase();
  const secret =
    type === "hidden" ||
    isSecretInfo({ type, autocomplete: attrs.autocomplete ?? "", textSecurity: textSecurityOfStyle(attrs.style) });
  return secret ? valueSpans : [];
};

/**
 * 字符串级清洗（探针失败时的兜底，R1-29 复审）：对 `DOM.getOuterHTML` 拿到的**原始**序列化串去掉
 * - `<input>` 的 value 属性——当它是 `type=hidden`（CSRF token 等）、type=password、autocomplete 命中统一规则（one-time-code / cc-* /
 *   current|new-password，无 type 的 input 也认）、或 `style` 里有 `-webkit-text-security` / `text-security` 遮罩时；
 * - `<textarea>` 的正文（子文本）：字符串里看不出它是不是 CSS 遮罩的（class / 样式表里写的遮罩根本不在串里），一律清空。
 *   页内探针已经在原节点上精确判过的结果（`textareaBody: "keep"`）不需要再清，免得误伤普通 textarea 的默认文本。
 * 看不到的盲区：靠 class / 外部样式表实现的 `-webkit-text-security`，只有页内探针（原节点 computed style）能判——
 * 所以本函数只做兜底，不能替代探针；探针「主动置空」时调用方更不能拿原始串绕过它。
 *
 * 每个 `<input` 起点**各自独立**判一遍（R4-01）：页面在 `<script>` / 注释这类不转义的文本里放一个诱饵 `<input type=text x='`，
 * 旧版会把后面真正的密码框整个吞进诱饵的引号里、还跳过它不处理；现在诱饵只会多剪（保守方向），真输入框照剪。
 * 要剪的区间先收集、排序合并，最后一次拼出结果（重复 `value` 属性也不会二次方）。
 *
 * @param {unknown} html
 * @param {{ textareaBody?: "all" | "keep" }} [opts]
 */
export const redactHtmlInputValues = (html, opts = {}) => {
  if (typeof html !== "string" || html === "") return typeof html === "string" ? html : "";
  let src = html;
  const truncated = src.length > HTML_REDACT_MAX;
  if (truncated) src = src.slice(0, HTML_REDACT_MAX);
  const keepTextarea = opts.textareaBody === "keep";
  const n = src.length;
  const memo = new Int32Array(n + 1);
  const startRe = new RegExp(TAG_START_RE_SRC, "gi");
  /** 所有 `</textarea` 的位置（升序，第一次用到时一遍扫出来）：每个 textarea 起点二分找「正文结束」，不会各自向后扫到串尾 */
  /** @type {number[] | null} */
  let closes = null;
  const nextClose = (from) => {
    if (closes === null) {
      closes = [];
      const closeRe = new RegExp(TEXTAREA_CLOSE_RE_SRC, "gi");
      let c;
      while ((c = closeRe.exec(src))) closes.push(c.index);
    }
    let lo = 0;
    let hi = closes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (closes[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < closes.length ? closes[lo] : n;
  };
  /** @type {Array<[number, number]>} */
  const cuts = [];
  let dropFrom = n;
  let m;
  while ((m = startRe.exec(src))) {
    const isInput = m[1].toLowerCase() === "input";
    if (!isInput && keepTextarea) continue;
    const bodyStart = m.index + m[0].length;
    const end = scanTagEnd(src, bodyStart, memo);
    if (end < 0) {
      // 没有结束符：正常序列化里不会出现（多半是 <script> / 注释里的文本）→ 原样保留；
      // 但整串被截断时，这可能是被截断的真标签——fail-closed，从这里起整段丢弃
      if (truncated) {
        dropFrom = m.index;
        break;
      }
      continue;
    }
    if (isInput) {
      for (const c of inputTagCuts(src, m.index, bodyStart, end)) cuts.push(c);
    } else {
      // textarea：标签保留，正文（到 `</textarea` 或串尾）清空。正文里的起点照样各自判一遍（诱饵 textarea 的标签里可能吞着真输入框）
      cuts.push([end, nextClose(end)]);
    }
  }
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let last = 0;
  for (const [from0, to0] of cuts) {
    const from = Math.min(from0, dropFrom);
    const to = Math.min(to0, dropFrom);
    if (to <= last) continue;
    if (from > last) out += src.slice(last, from);
    last = to;
  }
  return last < dropFrom ? out + src.slice(last, dropFrom) : out;
};

/**
 * outerHTML 没有给出来时的说明（`PickedElement.outerHTMLNote`）。
 * - WITHHELD：页内探针主动置空——它没法确认 HTML 里的输入框都已脱敏（克隆与原节点配对失败 / 脱敏过程出错），宁可不给；
 *   这是 fail-closed，调用方**不能**再去取未脱敏的原始 HTML（R1-29 复审）。
 * - FALLBACK：探针没拿到结果（没执行 / 抛错）才退回 `DOM.getOuterHTML`，只做字符串级兜底脱敏，看不到 class / 样式表实现的遮罩。
 */
export const PICK_HTML_WITHHELD_NOTE = "outerHTML 已隐藏：无法确认其中的输入框都已脱敏（页面结构与脱敏结果对不上），出于安全不提供 HTML 片段";
export const PICK_HTML_FALLBACK_NOTE = "outerHTML 来自降级路径（页内探针失败）：只按标签属性脱敏了 hidden / 密码 / 验证码 / 银行卡类输入框与 textarea 正文，样式表实现的遮罩字段无法识别";

/**
 * 把页内探针返回的原始结果 + 外部信息整形为契约 `PickedElement`。
 * - outerHTML ≤ 4000、text ≤ 500（超了加「…」）；出口再过一遍字符串级脱敏（探针 `htmlState === "ok"` 时保留 textarea 默认文本，
 *   其余来源——降级路径 / 未知——连 textarea 正文一并清）
 * - screenshot 必须是 `data:image/jpeg;base64,` 开头且 ≤ 200KB，否则不带该字段
 * - reactSource 拿不到一律 null
 * - outerHTMLNote：outerHTML 被隐藏 / 来自降级路径时的说明（见上）
 * @param {any} raw     PICK_PROBE_SOURCE 的返回值（或其子集）；null / undefined 当空对象
 * @param {{url?:string, title?:string, screenshot?:string|null}} [extra]
 * @returns {Record<string, any>}
 */
export const shapePickedElement = (raw, extra = {}) => {
  const r = raw && typeof raw === "object" ? raw : {};
  const picked = {
    url: typeof extra.url === "string" ? extra.url : typeof r.url === "string" ? r.url : "",
    title: truncate(typeof extra.title === "string" ? extra.title : typeof r.title === "string" ? r.title : "", 300),
    selector: truncate(typeof r.selector === "string" ? r.selector : "", 800),
    outerHTML: truncate(redactHtmlInputValues(r.outerHTML, { textareaBody: r.htmlState === "ok" ? "keep" : "all" }), OUTER_HTML_MAX),
    text: truncate(typeof r.text === "string" ? r.text.trim() : "", TEXT_MAX),
    rect: normalizeRect(r.rect),
    reactSource: normalizeReactSource(r.reactSource),
  };
  if (typeof r.outerHTMLNote === "string" && r.outerHTMLNote) picked.outerHTMLNote = truncate(r.outerHTMLNote, 300);
  if (typeof r.role === "string" && r.role) picked.role = truncate(r.role, 60);
  if (typeof r.name === "string" && r.name.trim()) picked.name = truncate(r.name.trim(), 200);
  const shot = extra.screenshot;
  if (typeof shot === "string" && shot.startsWith("data:image/jpeg;base64,") && dataUrlBytes(shot) <= SCREENSHOT_MAX_BYTES) {
    picked.screenshot = shot;
  }
  return picked;
};

/**
 * 页内探针（在被点选元素所在的**主世界**里以 `this = 元素` 执行，`Runtime.callFunctionOn` 的 functionDeclaration）。
 * 自包含、无外部依赖、返回可 JSON 化对象；任何一步出错都吞掉走降级，绝不抛。
 * 选择器策略（稳定优先）：唯一的 `#id` → 唯一的 data-testid / data-test / data-qa / data-cy / aria-label / name
 * → 否则自下而上拼 `tag:nth-of-type(n)` 路径，遇到唯一 id 祖先就收口；每加一层就检查是否已经唯一。
 */
export const PICK_PROBE_SOURCE = `function () {
  var el = this;
  var doc = el.ownerDocument || document;
  var win = doc.defaultView || window;
  var esc = function (s) {
    try { return win.CSS && win.CSS.escape ? win.CSS.escape(String(s)) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"); }
    catch (e) { return String(s); }
  };
  var q = function (sel, root) {
    try { return (root || doc).querySelectorAll(sel); } catch (e) { return []; }
  };
  var isUnique = function (sel, root) { var n = q(sel, root); return n.length === 1 && n[0] === el; };
  var tag = (el.tagName || "").toLowerCase();

  // ——— 选择器 ———
  var selector = "";
  var rootNode = el.getRootNode ? el.getRootNode() : doc;
  var scope = rootNode && rootNode.nodeType === 11 ? rootNode : doc; // 影子树里只能在树内唯一
  if (el.id && isUnique("#" + esc(el.id), scope)) {
    selector = "#" + esc(el.id);
  }
  if (!selector) {
    var attrs = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "aria-label", "name"];
    for (var i = 0; i < attrs.length && !selector; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v && v.length <= 80) {
        var s1 = tag + "[" + attrs[i] + '="' + String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"]';
        if (isUnique(s1, scope)) selector = s1;
      }
    }
  }
  if (!selector) {
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 25) {
      var t = (cur.tagName || "").toLowerCase();
      // 祖先自己有唯一 id（isUnique 是针对 el 的，这里单独数一下祖先 id 出现次数）
      var ancestorIdUnique = cur !== el && cur.id && q("#" + esc(cur.id), scope).length === 1;
      if (ancestorIdUnique) { parts.unshift("#" + esc(cur.id)); break; }
      var seg = t;
      if (t === "html" || t === "body") { parts.unshift(seg); break; }
      var parent = cur.parentElement;
      if (parent) {
        var same = 0, idx = 0;
        for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
          if (c.tagName === cur.tagName) { same++; if (c === cur) idx = same; }
        }
        if (same > 1) seg += ":nth-of-type(" + idx + ")";
      }
      parts.unshift(seg);
      var candidate = parts.join(" > ");
      if (isUnique(candidate, scope)) { selector = candidate; break; }
      cur = parent;
      if (!cur) break;
    }
    if (!selector) selector = parts.join(" > ") || tag;
  }

  // ——— 角色 / 名称 ———
  var implicitRole = function () {
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.split(/\\s+/)[0];
    var type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "table") return "table";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    return "";
  };
  var role = implicitRole();
  var clip = function (s, n) { s = String(s || "").replace(/\\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) : s; };
  var name = "";
  try {
    name = el.getAttribute("aria-label") || "";
    if (!name) {
      var lb = el.getAttribute("aria-labelledby");
      if (lb) {
        name = lb.split(/\\s+/).map(function (id) { var n = doc.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      }
    }
    if (!name && el.labels && el.labels.length) name = el.labels[0].textContent;
    if (!name) name = el.getAttribute("alt") || "";
    if (!name && (tag === "button" || tag === "a" || role === "button" || role === "link" || role === "heading")) name = el.innerText || el.textContent || "";
    if (!name && tag === "input") name = el.getAttribute("placeholder") || ((el.type === "button" || el.type === "submit") ? el.value : "") || "";
    if (!name) name = el.getAttribute("title") || "";
  } catch (e) { name = ""; }
  name = clip(name, 80);

  // ——— 可见文本 / outerHTML / rect ———
  var text = "";
  try { text = (el.innerText != null ? el.innerText : el.textContent) || ""; } catch (e) { text = ""; }
  text = String(text).replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 2000);
  // outerHTML 先克隆再清洗（R1-29 / R1-25）：<input type=hidden>（CSRF token 等）与敏感输入框（password / OTP / cc-* / text-security 遮罩）的 value 不外传。
  // 敏感判定在原节点上做（克隆体取不到 computed style），克隆与原树里的 input / textarea 按顺序一一对应。
  // htmlState：ok = 已逐个脱敏；withheld = 主动置空（配对失败 / 脱敏中途出错——没法确认脱敏干净，fail-closed）。
  // 调用方必须把 withheld 当成「不给」，不能再去取未脱敏的原始 HTML；只有整个探针没返回结果时才允许退回（collectPicked）。
  ${SECRET_FIELD_FNS_SOURCE}
  var outerHTML = "";
  var htmlState = "withheld";
  try {
    var fieldsOf = function (root) {
      var list = [];
      var tg = String(root.tagName || "").toLowerCase();
      if (tg === "input" || tg === "textarea") list.push(root);
      var found = root.querySelectorAll ? root.querySelectorAll("input,textarea") : [];
      for (var fi = 0; fi < found.length; fi++) list.push(found[fi]);
      return list;
    };
    var origFields = fieldsOf(el);
    var cloneRoot = el.cloneNode(true);
    var cloneFields = fieldsOf(cloneRoot);
    if (origFields.length === cloneFields.length) {
      for (var ci = 0; ci < cloneFields.length; ci++) {
        var orig = origFields[ci];
        var hiddenInput = String(orig.tagName || "").toLowerCase() === "input" && String(orig.getAttribute("type") || "").toLowerCase() === "hidden";
        var secretField = true;
        try { secretField = isSecretInfo(readSecretInfo(orig)) === true; } catch (e2) { secretField = true; }
        if (hiddenInput || secretField) {
          cloneFields[ci].removeAttribute("value");
          if (String(cloneFields[ci].tagName || "").toLowerCase() === "textarea") cloneFields[ci].textContent = "";
        }
      }
      outerHTML = String(cloneRoot.outerHTML || "").slice(0, 8000);
      htmlState = "ok";
    } else {
      outerHTML = "";
    }
  } catch (e) { outerHTML = ""; htmlState = "withheld"; }
  var r = el.getBoundingClientRect();
  var rect = { x: r.x, y: r.y, width: r.width, height: r.height };

  // ——— React 源（尽力而为）———
  var reactSource = null;
  try {
    var keys = Object.keys(el);
    var fk = null;
    for (var k = 0; k < keys.length; k++) { if (keys[k].indexOf("__reactFiber$") === 0 || keys[k].indexOf("__reactInternalInstance$") === 0) { fk = keys[k]; break; } }
    if (fk) {
      var fiber = el[fk];
      var depth = 0;
      var comp = "";
      while (fiber && depth++ < 60) {
        if (!comp && typeof fiber.type === "function") comp = fiber.type.displayName || fiber.type.name || "";
        var ds = fiber._debugSource;
        if (ds && ds.fileName) { reactSource = { file: ds.fileName, line: ds.lineNumber, component: comp || undefined }; break; }
        fiber = fiber._debugOwner || fiber.return;
      }
      if (!reactSource && comp) reactSource = null; // 只有组件名没有文件：契约要 file，拿不到当 null
    }
    if (!reactSource) {
      // react-dev-inspector / babel 插件常见的 data-* 注入
      var node = el;
      for (var up = 0; node && up < 10; up++, node = node.parentElement) {
        var f = node.getAttribute && (node.getAttribute("data-inspector-relative-path") || node.getAttribute("data-source-file"));
        if (f) {
          var ln = node.getAttribute("data-inspector-line") || node.getAttribute("data-source-line");
          reactSource = { file: f, line: ln ? Number(ln) : undefined, component: node.getAttribute("data-inspector-component") || undefined };
          break;
        }
      }
    }
  } catch (e) { reactSource = null; }

  return {
    selector: selector, role: role || undefined, name: name || undefined,
    text: text, outerHTML: outerHTML, htmlState: htmlState, rect: rect,
    scrollX: win.scrollX || 0, scrollY: win.scrollY || 0,
    reactSource: reactSource,
    url: String(win.location && win.location.href || ""), title: String(doc.title || "")
  };
}`;

const jpegDataUrl = (b64) => (typeof b64 === "string" && b64 ? `data:image/jpeg;base64,${b64}` : null);

/**
 * 截元素图：先 q70、超 200KB 再降到 q45 + 缩半重截一次，仍超就不带（返回 null）。
 * @returns {Promise<string|null>}
 */
const captureElementScreenshot = async (tab, clip) => {
  if (!clip) return null;
  const attempt = async (quality, scaleFactor) => {
    const r = await tab.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: Math.max(0.1, clip.scale * scaleFactor) },
      captureBeyondViewport: false,
    });
    return jpegDataUrl(r?.data);
  };
  try {
    const first = await attempt(70, 1);
    if (first && dataUrlBytes(first) <= SCREENSHOT_MAX_BYTES) return first;
    const second = await attempt(45, 0.5);
    return second && dataUrlBytes(second) <= SCREENSHOT_MAX_BYTES ? second : null;
  } catch {
    return null; // 截图是锦上添花，失败不影响拾取
  }
};

/**
 * 点选到节点后收集 PickedElement。任一步 CDP 失败的降级：
 * resolveNode 失败 → 整体抛错（调用方走「失败 → onEnd」）；探针没拿到结果（没执行 / 抛错 / 返回值不是对象）→ 退回
 * DOM.getOuterHTML 的最小结果（字符串级兜底脱敏，见 redactHtmlInputValues）；截图失败 → 不带截图。
 *
 * 「探针没拿到结果」与「探针主动置空 outerHTML」必须分开（R1-29 复审）：后者（htmlState === "withheld"，克隆与原节点配对失败等）
 * 是探针发现自己没法保证脱敏干净而选择不给——此时再去取原始 HTML 就把 fail-closed 整个抵消了，所以**不回退**，保持空串并带说明。
 * 探针返回了结果但没带 htmlState（不是我们的探针 / 老版本）同样不回退：回退条件只有「探针根本没有结果」一条。
 */
const collectPicked = async (tab, backendNodeId) => {
  const resolved = await tab.send("DOM.resolveNode", { backendNodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error("无法解析被选中的节点");
  let raw = null;
  try {
    const r = await tab.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PICK_PROBE_SOURCE,
      returnByValue: true,
      awaitPromise: false,
    });
    if (r?.exceptionDetails) throw new Error("探针执行异常");
    raw = r?.result?.value ?? null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") {
    // 探针没拿到结果的最小降级：只有 outerHTML + 盒模型。HTML 是原始序列化串，整形出口会再按标签属性兜底脱敏
    raw = { selector: "", outerHTML: "", text: "", rect: null, htmlState: "fallback", outerHTMLNote: PICK_HTML_FALLBACK_NOTE };
    try {
      const h = await tab.send("DOM.getOuterHTML", { backendNodeId });
      raw.outerHTML = typeof h?.outerHTML === "string" ? h.outerHTML : "";
    } catch {
      /* 保持空 */
    }
    try {
      const m = await tab.send("DOM.getBoxModel", { backendNodeId });
      const q = m?.model?.border;
      if (Array.isArray(q) && q.length >= 8) {
        raw.rect = { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] };
      }
    } catch {
      /* 保持空 */
    }
  } else {
    // 探针在页面执行上下文里跑、返回值页面能伪造：说明文字只认主进程自己写的两条常量，探针带回来的 outerHTMLNote 一律丢掉
    // （这段文字会进用户输入框 / 给 AI 看，不能由页面撰写）
    delete raw.outerHTMLNote;
    if (raw.htmlState === "withheld") {
      // 探针主动置空：不回退、不信探针可能残留的任何 HTML，保持空串
      raw.outerHTML = "";
      raw.outerHTMLNote = PICK_HTML_WITHHELD_NOTE;
    }
  }
  // 释放远程对象，避免在页面里挂着引用
  void tab.send("Runtime.releaseObject", { objectId }).catch(() => {});
  const clip = clipFromRect(raw.rect, { scrollX: raw.scrollX, scrollY: raw.scrollY });
  const screenshot = await captureElementScreenshot(tab, clip);
  let url = raw.url;
  let title = raw.title;
  try {
    url = tab.wc.getURL() || url;
    title = tab.wc.getTitle() || title;
  } catch {
    /* wc 已销毁就用探针里的 */
  }
  return shapePickedElement(raw, { url, title, screenshot });
};

/**
 * 启动元素拾取。
 * @param {*} tab  BrowserTab（用 tab.send / tab.onCdpEvent / tab.wc）
 * @param {{ onPicked: (p: object) => void, onEnd: () => void }} cb
 * @returns {{ cancel: () => void }}  cancel 幂等；cancel / 选中 / 失败后都保证 setInspectMode none + onEnd（选中时先 onPicked 再 onEnd）
 */
export const startPicker = (tab, { onPicked, onEnd } = {}) => {
  let ended = false;
  /** 点选之后正在收集结果（此时 inspect 模式已关，但还没收尾） */
  let resolving = false;
  let unsubscribeCdp = null;
  let escListener = null;

  const safe = (fn, ...args) => {
    try {
      fn?.(...args);
    } catch {
      /* 回调出错不能影响收尾 */
    }
  };

  const stopInspectMode = () => {
    if (tab?.destroyed) return;
    void tab.send("Overlay.setInspectMode", { mode: "none", highlightConfig: INSPECT_HIGHLIGHT_CONFIG }).catch(() => {});
    void tab.send("Overlay.disable", {}).catch(() => {});
  };

  const cleanup = () => {
    try {
      unsubscribeCdp?.();
    } catch {
      /* 已退订 */
    }
    unsubscribeCdp = null;
    if (escListener) {
      try {
        tab?.wc?.removeListener?.("before-input-event", escListener);
        tab?.wc?.removeListener?.("destroyed", onWcDestroyed);
      } catch {
        /* wc 已销毁 */
      }
      escListener = null;
    }
  };

  /** 唯一收尾口：幂等。picked 非空时先交结果再 onEnd。 */
  const finish = (picked = null) => {
    if (ended) return;
    ended = true;
    cleanup();
    stopInspectMode();
    if (picked) safe(onPicked, picked);
    safe(onEnd);
  };

  function onWcDestroyed() {
    finish(null);
  }

  const onCdp = (method, params) => {
    if (ended || resolving) return;
    if (method !== "Overlay.inspectNodeRequested") return;
    const backendNodeId = params?.backendNodeId;
    if (typeof backendNodeId !== "number") return;
    resolving = true;
    // 先立刻关掉检查模式（否则收集期间页面还在跟着鼠标高亮、再点一下会重复触发）
    stopInspectMode();
    collectPicked(tab, backendNodeId).then(
      (picked) => {
        if (ended) return; // 收集期间被取消：丢弃结果
        finish(picked);
      },
      () => finish(null),
    );
  };

  // 同步部分：订阅 + Esc。订阅放在发 CDP 命令之前，不会漏掉很快到达的事件
  unsubscribeCdp = tab.onCdpEvent((method, params, sessionId) => {
    if (sessionId) return; // 只处理主会话（OOPIF 子会话没开 Overlay）
    onCdp(method, params);
  });
  escListener = (event, input) => {
    if (input && input.type === "keyDown" && input.key === "Escape") {
      try {
        event.preventDefault();
      } catch {
        /* 非 Event 对象（测试桩）就算了 */
      }
      finish(null);
    }
  };
  try {
    tab.wc.on("before-input-event", escListener);
    tab.wc.on("destroyed", onWcDestroyed);
  } catch {
    /* wc 已销毁：下面的 CDP 命令会失败并收尾 */
  }

  // 异步部分：开启检查模式；任一步失败 → 收尾（onEnd）。onEnd 可能在 startPicker 返回前同步触发的情形
  // 由调用方（session.startPick 的 handle 先占位）兜住
  void (async () => {
    try {
      await tab.ensureCdp?.();
      if (ended) return;
      // Overlay.enable 依赖 DOM 域已启用（否则报 "DOM should be enabled first"）
      await tab.send("DOM.enable", {});
      await tab.send("Overlay.enable", {});
      if (ended) return;
      await tab.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: INSPECT_HIGHLIGHT_CONFIG });
      if (ended) {
        // 开启过程中已被取消：补一刀关掉
        stopInspectMode();
      }
    } catch {
      finish(null);
    }
  })();

  return {
    cancel() {
      finish(null);
    },
  };
};
