/**
 * docx / xlsx 预览 HTML 净化器（纯函数、无 DOM 依赖、服务端 / 客户端通用）
 *
 * 背景（S10-01）：mammoth（docx→HTML）与 SheetJS（xlsx→HTML）的输出被预览组件
 * `dangerouslySetInnerHTML` 直接渲染。两者都**不保证**输出安全：
 * - mammoth 官方文档明确「不做净化」，docx 里的超链接 `javascript:` 会原样进 `<a href>`；
 * - 恶意 xlsx / docx 可借解析器边角行为产出带事件属性 / 脚本的片段。
 * 本应用是 Electron 壳 + 本机 server，页面里的 XSS 能直接打到本机 API，必须净化。
 *
 * 设计：**重新序列化白名单**，而不是「黑名单剔除」——
 * 1. 自己扫描 HTML，只对白名单标签、白名单属性**重新生成**输出字符串；
 *    输出里的每个字节都来自白名单模板或被转义过的文本 / 属性值，
 *    所以即使本扫描器与浏览器解析器有差异（mXSS 常见根源），也不会有脚本漏进去。
 * 2. script / style / iframe / object / embed / svg / math / template 等整体连内容一起丢弃。
 * 3. 属性值先解码实体、剔控制字符，再校验协议，输出时重新转义（防 `&#106;avascript:` 之类实体绕过）。
 * 4. 幂等：净化输出再净化结果不变（组件层会再过一遍做纵深防御）。
 *
 * 不引入新依赖：dompurify / rehype-sanitize 只是传递依赖、不在 package.json 里。
 */

/** 允许输出的标签（常见排版 + 表格 + 列表 + 图片 / 链接） */
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "code", "pre", "blockquote",
  "a", "img",
]);

/** 没有闭合标签的元素：只输出开始标签、忽略其闭合标签 */
const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

/**
 * 连内容整体丢弃的标签：内容要么是脚本 / 样式，要么是会改变解析模式（RAWTEXT / RCDATA /
 * 外来命名空间）的元素，只丢标签会让其内容被当成正常 HTML 输出。
 */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "noscript", "template",
  "textarea", "title", "xmp", "noembed", "noframes", "plaintext", "frame", "frameset",
  "svg", "math",
]);

/** 每个标签允许的属性（其余一律丢弃：on*、style、class、id、data-*、srcset 全部不要） */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
};

/** 命名实体：只解码校验 URL 需要的几个（其余保持原样，URL 里出现未知实体就不会匹配协议白名单） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
  sol: "/",
};

/**
 * 解码属性值里的 HTML 实体（含数字实体 `&#106;` / `&#x6A;`，分号可缺省——浏览器也容错）。
 * 单趟替换：解码结果不再二次解码，避免 `&amp;#106;` 被多解一层。
 */
const decodeEntities = (s: string): string =>
  s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));?/g, (whole, dec, hex, name) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    const named = NAMED_ENTITIES[String(name).toLowerCase()];
    return named ?? whole;
  });

/** 属性值输出转义 */
const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 文本节点输出转义：`&` 原样保留（保留已有实体）、裸 `<` `>` 一律转义、去 NUL */
const escapeText = (s: string): string =>
  s.replace(/\u0000/g, "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 清掉控制字符（含 tab / 换行——浏览器解析 URL 时会无视它们，`java\tscript:` 绕过的常见手法） */
const stripControl = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();

/** `<a href>`：只放行 http / https / mailto（相对路径、`#锚点`、其它协议一律丢掉 href） */
const safeHref = (raw: string): string | null => {
  const v = stripControl(decodeEntities(raw));
  return /^(?:https?:|mailto:)/i.test(v) ? v : null;
};

/** `<img src>`：只放行 http(s) 与 base64 的 data:image（mammoth 把 docx 内嵌图转成这种） */
const safeImgSrc = (raw: string): string | null => {
  const v = stripControl(decodeEntities(raw));
  if (/^https?:\/\//i.test(v)) return v;
  if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(v)) return v;
  return null;
};

/** 纯数字（可带 %）尺寸 / 跨度 */
const safeSize = (raw: string): string | null => {
  const v = stripControl(decodeEntities(raw));
  return /^\d{1,4}%?$/.test(v) ? v : null;
};
const safeInt = (raw: string): string | null => {
  const v = stripControl(decodeEntities(raw));
  return /^\d{1,4}$/.test(v) ? v : null;
};

/** 按属性名校验并规范化属性值（属性名是否允许已由 ALLOWED_ATTRS 按标签筛过）；返回 null = 丢弃该属性 */
const sanitizeAttrValue = (attr: string, raw: string): string | null => {
  if (attr === "href") return safeHref(raw);
  if (attr === "src") return safeImgSrc(raw);
  if (attr === "width" || attr === "height") return safeSize(raw);
  if (attr === "colspan" || attr === "rowspan" || attr === "span") return safeInt(raw);
  if (attr === "alt" || attr === "title") return stripControl(decodeEntities(raw));
  return null;
};

interface ParsedTag {
  name: string;
  closing: boolean;
  attrs: Array<[string, string]>;
  /** 标签结束位置（`>` 之后一位） */
  end: number;
}

const isSpace = (ch: string): boolean => /\s/.test(ch);
const isLetter = (ch: string | undefined): boolean => !!ch && /[a-zA-Z]/.test(ch);

/**
 * 从 `html[start] === "<"` 解析一个标签（容忍引号内的 `>`、无引号属性、`/>`）。
 * 标签到结尾都没闭合 → 返回 null（浏览器在 EOF 也会丢弃未完成标签）。
 */
const parseTag = (html: string, start: number): ParsedTag | null => {
  const n = html.length;
  let i = start + 1;
  let closing = false;
  if (html[i] === "/") {
    closing = true;
    i++;
  }
  const nameStart = i;
  while (i < n && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs: Array<[string, string]> = [];
  while (i < n) {
    while (i < n && isSpace(html[i])) i++;
    if (i >= n) return null;
    const ch = html[i];
    if (ch === ">") return { name, closing, attrs, end: i + 1 };
    if (ch === "/") {
      i++;
      continue;
    }
    // 属性名：首字符若是 "=" 按浏览器规则当作名字的一部分
    const s = i;
    i++;
    while (i < n && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const attrName = html.slice(s, i).toLowerCase();
    while (i < n && isSpace(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && isSpace(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close === -1) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const vs = i;
        while (i < n && !isSpace(html[i]) && html[i] !== ">") i++;
        value = html.slice(vs, i);
      }
    }
    attrs.push([attrName, value]);
  }
  return null;
};

/** 从 `from` 起找 `</name` 的闭合标签、返回其 `>` 之后的位置；找不到返回 html.length（丢到末尾） */
const skipToClosing = (html: string, from: number, name: string): number => {
  const re = new RegExp(`</${name}(?=[\\s/>]|$)`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return html.length;
  const gt = html.indexOf(">", m.index);
  return gt === -1 ? html.length : gt + 1;
};

/** 生成白名单开始标签（属性重新校验 + 转义；重复属性取第一个，与浏览器一致） */
const buildOpenTag = (name: string, attrs: Array<[string, string]>): string => {
  const allowed = ALLOWED_ATTRS[name];
  const seen = new Set<string>();
  let out = `<${name}`;
  for (const [attrName, raw] of attrs) {
    if (seen.has(attrName)) continue;
    seen.add(attrName);
    if (!allowed || !allowed.has(attrName)) continue;
    const value = sanitizeAttrValue(attrName, raw);
    if (value === null) continue;
    out += ` ${attrName}="${escapeAttr(value)}"`;
  }
  // 外链统一断开 opener / referrer（点击在壳里会被转系统浏览器、这里是保险）
  if (name === "a") out += ' rel="noopener noreferrer"';
  return `${out}>`;
};

/**
 * 净化 docx / xlsx 转出来的 HTML 片段，返回可安全 `dangerouslySetInnerHTML` 的字符串。
 * 非字符串 / 空串返回空串。
 */
export const sanitizePreviewHtml = (html: string): string => {
  if (typeof html !== "string" || html === "") return "";
  const n = html.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(html.slice(i));
      break;
    }
    if (lt > i) out += escapeText(html.slice(i, lt));

    // 注释：整体丢弃（找不到 --> 丢到末尾）
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[lt + 1];
    // <!DOCTYPE> / <![CDATA[ / <?xml ?> 之类：丢到下一个 >
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const looksLikeTag = isLetter(next) || (next === "/" && isLetter(html[lt + 2]));
    if (!looksLikeTag) {
      // 孤立的 `<`（如 "a < b"）：当文本转义输出
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const tag = parseTag(html, lt);
    if (!tag) {
      // 未终止的标签：丢弃剩余（不把半截标签交给浏览器去猜）
      i = n;
      continue;
    }
    i = tag.end;

    if (tag.closing) {
      if (ALLOWED_TAGS.has(tag.name) && !VOID_TAGS.has(tag.name)) out += `</${tag.name}>`;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag.name)) {
      i = skipToClosing(html, i, tag.name);
      continue;
    }
    if (ALLOWED_TAGS.has(tag.name)) {
      out += buildOpenTag(tag.name, tag.attrs);
    }
    // 其它未知标签（html / head / body / meta / font / form …）：只丢标签、保留内部文本
  }
  return out;
};
