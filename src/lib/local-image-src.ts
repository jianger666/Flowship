/**
 * 本地绝对路径 → `/api/local-image` 可加载 URL（markdown 图 / 链接共用）
 *
 * AI 在工作目录生成的图（二维码 / 图表）常写成 `![](/abs/path.png)` 或
 * `file:///…`——浏览器直载会 404；rehype-sanitize 还会把 `file://` 的 src 整段剥掉。
 * 组件层（MarkdownImage）+ AST 层（rehypeRewriteLocalImages）双保险都走这里。
 */
export const toLoadableImageSrc = (url: string): string => {
  const stripped = url.startsWith("file://") ? url.slice("file://".length) : url;
  const isLocalAbs =
    stripped.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(stripped);
  // http(s) / data: / blob: / 相对路径（uploads 通道等）原样；本地绝对路径转通道。
  // `/api/...` `/uploads/...` 也以 / 开头——用已知站内前缀放行
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  if (!isLocalAbs) return url;
  if (/^\/(api|uploads|_next)\//.test(stripped)) return url;
  return `/api/local-image?path=${encodeURIComponent(stripped)}`;
};
