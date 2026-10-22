/**
 * 本地绝对路径 → `/api/local-image` 可加载 URL（markdown 图 / 链接共用）
 *
 * AI 在工作目录生成的图（二维码 / 图表）常写成 `![](/abs/path.png)` 或
 * `file:///…`——浏览器直载会 404；rehype-sanitize 还会把 `file://` 的 src 整段剥掉。
 * 组件层（MarkdownImage）+ AST 层（rehypeRewriteLocalImages）双保险都走这里。
 */

import { fileUrlToLocalPath, isUncLikePath } from "@/lib/unc-path";

const LOCAL_IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

const isLocalAbsolutePath = (path: string): boolean =>
  path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);

/**
 * CommonMark 裸 destination 不能含空格。mac 数据目录 `Application Support` 会把
 * `![二维码](/Users/…/Application Support/…/qr.png)` 截成看不见的图 + 尾巴原文。
 * 渲染前把这类 destination 包进 `<>`（spec 允许空格），再交给 /api/local-image。
 */
export const wrapLocalMarkdownImageDestinations = (md: string): string =>
  md.replace(
    /!\[((?:\\.|[^\]])*)\]\((<[^>\n]*>|[^)\n]+)\)/g,
    (full, alt: string, dest: string) => {
      const trimmed = dest.trim();
      if (trimmed.startsWith("<") && trimmed.endsWith(">")) return full;
      const stripped = trimmed.startsWith("file://")
        ? trimmed.slice("file://".length)
        : trimmed;
      if (!isLocalAbsolutePath(stripped)) return full;
      if (!/\s/.test(trimmed)) return full;
      const withoutQuery = stripped.split(/[?#]/)[0] ?? stripped;
      if (!LOCAL_IMAGE_EXT.test(withoutQuery)) return full;
      return `![${alt}](<${trimmed}>)`;
    },
  );

/** URL 路径段是不是 `.` / `..`（含 `%2e` 写法）——浏览器解析 URL 时会把它们折叠掉 */
const isDotSegment = (seg: string): boolean => /^(\.|%2e){1,2}$/i.test(seg);

/**
 * 渲染层原样放行的站内路径白名单（R12-01）——只有两类：
 *  - `/api/local-image?…`：本模块自己产出的图片通道（服务端另有 UNC / 扩展名 / 大小守卫）；
 *  - `/api/tasks/<id>/uploads/<文件>`：任务上传目录里的图。
 * 以前是 `^/(api|uploads|_next)/` 整段放行：AI / 答疑卡里一行 `![](/api/repo-branches?path=//attacker/…)`
 * 就会被渲染成同源 GET——渲染即触发、无需点击，而 `<img>` 不带 Origin，中间件的 Origin 校验看不见。
 * 其余 `/api/*`（含 `/uploads/`、`/_next/`，它们本来也没有对应的图片路由）一律不再放行，按本地路径走 local-image 通道。
 *
 * uploads 那一类必须是「恰好一个文件名段」且没有 `.` / `..` 段：`/api/tasks/x/uploads/../../repo-branches`
 * 会被浏览器归一成 `/api/repo-branches`，白名单前缀就成了跳板。
 */
const isTrustedSiteImagePath = (url: string): boolean => {
  if (url.startsWith("/api/local-image?")) return true;
  const m = /^\/api\/tasks\/([^/?#\\]+)\/uploads\/([^/?#\\]+)(?:[?#].*)?$/.exec(url);
  return m !== null && !isDotSegment(m[1]) && !isDotSegment(m[2]);
};

/**
 * 回环主机（loopback）绝对 URL → 站内路径（Q4-04，与 R12-01 同口径收口）。
 *
 * `![](http://127.0.0.1:8876/api/repo-branches?path=…)` 在 Electron 页面里是 same-origin，渲染即发同源 GET
 * （R12-01 只收了相对形态 `/api/…`）。用 `new URL().hostname` 判回环——WHATWG 会把 `127.1` /
 * `2130706433` / `0x7f.1` 规范化成 `127.0.0.1`，字符串匹配会漏。命中回环 **且** 路径以 `/api/` / `/_next/` 起头
 * 才返回「路径 + 查询 + 片段」（交给与相对形态完全相同的后续逻辑：白名单放行或当本地路径走 local-image 通道）；
 * 其余（外网图、别的本机服务的普通图 `http://localhost:3000/a.png`）返回 null、按原样处理。
 */
export const loopbackSiteRelativeUrl = (url: string): string | null => {
  if (!/^https?:/i.test(url.trim())) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const isLoopback =
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "localhost" ||
    host.endsWith(".localhost");
  if (!isLoopback) return null;
  if (!/^\/(?:api|_next)\//.test(u.pathname)) return null;
  return `${u.pathname}${u.search}${u.hash}`;
};

export const toLoadableImageSrc = (url: string): string => {
  // 回环主机的同源 API 绝对 URL：先折回站内路径，再走下面与相对形态一样的口径（Q4-04）
  const siteRelative = loopbackSiteRelativeUrl(url);
  if (siteRelative !== null) return toLoadableImageSrc(siteRelative);
  // `file:///C:/x` 去掉 `file://` 与盘符前多出的 `/`（R12-04）；其余照旧只剥 `file://`
  const stripped = fileUrlToLocalPath(url);
  const isLocalAbs = isLocalAbsolutePath(stripped);
  // http(s) / data: / blob: / 相对路径（uploads 通道等）原样；本地绝对路径转通道。
  // `/api/...` `/uploads/...` 也以 / 开头——用已知站内前缀放行
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  // UNC 形态（`//host/share/a.png`、`\\host\share\a.png`、`file:////host/share/a.png`）：
  // 既不能改写成 /api/local-image（Windows 上服务端 realpath 会发起 SMB 连接、带 NTLM 凭据，渲染即触发），
  // 也不能原样放行（浏览器会把 `//host/…` / `\\host\…` 当 scheme-relative 去打 http://host/…）。
  // 返回空串：MarkdownImage 对空 src 直接不渲染；改写前拒绝、与平台无关（V10-01）
  if (isUncLikePath(url)) return "";
  if (!isLocalAbs) return url;
  // 站内白名单只认原始 url（不是剥过 file:// 的 stripped）：`file:///api/…` 不能借站内前缀的名义放行
  if (isTrustedSiteImagePath(url)) return url;
  return `/api/local-image?path=${encodeURIComponent(stripped)}`;
};
