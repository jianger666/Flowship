/**
 * 本地绝对路径 → `/api/local-image` 可加载 URL（markdown 图 / 链接共用）
 *
 * AI 在工作目录生成的图（二维码 / 图表）常写成 `![](/abs/path.png)` 或
 * `file:///…`——浏览器直载会 404；rehype-sanitize 还会把 `file://` 的 src 整段剥掉。
 * 组件层（MarkdownImage）+ AST 层（rehypeRewriteLocalImages）双保险都走这里。
 */

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

export const toLoadableImageSrc = (url: string): string => {
  const stripped = url.startsWith("file://") ? url.slice("file://".length) : url;
  const isLocalAbs = isLocalAbsolutePath(stripped);
  // http(s) / data: / blob: / 相对路径（uploads 通道等）原样；本地绝对路径转通道。
  // `/api/...` `/uploads/...` 也以 / 开头——用已知站内前缀放行
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  if (!isLocalAbs) return url;
  if (/^\/(api|uploads|_next)\//.test(stripped)) return url;
  return `/api/local-image?path=${encodeURIComponent(stripped)}`;
};
