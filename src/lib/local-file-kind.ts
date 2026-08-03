/**
 * 本地文件预览：按扩展名推断 kind（客户端 / server 共用）
 *
 * 为什么单独抽：artifact / 事件流 / Sheet 预览 / read-local-file API 都要同一套
 * 分类规则，散着写「md 能不能在 IDE 开」必漂移。
 */

/** 预览 Sheet 里怎么渲染 */
export type LocalFileKind =
  | "markdown"
  | "code"
  | "text"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "binary"
  | "unknown";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

const CODE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "json",
  "yaml",
  "yml",
  "toml",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "csv",
  "sh",
  "bash",
  "zsh",
  "mdx",
  "vue",
  "svelte",
  "java",
  "kt",
  "kts",
  "go",
  "rs",
  "rb",
  "php",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "sql",
  "graphql",
  "dockerfile",
]);

const TEXT_EXT = new Set(["txt", "log", "env", "ini", "cfg", "conf"]);

/** 从路径或裸扩展名（可带 `.`）推断 kind */
export const detectLocalFileKind = (pathOrExt: string): LocalFileKind => {
  const raw = pathOrExt.trim();
  const ext = (raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw)
    .toLowerCase()
    .replace(/^\./, "");
  if (!ext) return "unknown";
  if (ext === "md") return "markdown";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (ext === "pptx" || ext === "ppt") return "pptx";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  // 常见二进制：不给假预览
  if (
    ["exe", "dll", "so", "dylib", "zip", "tar", "gz", "7z", "rar", "dmg", "iso", "bin", "wasm"].includes(
      ext,
    )
  ) {
    return "binary";
  }
  return "unknown";
};

/** Sheet 顶栏「在 IDE 打开」：只对 md / 代码 / 纯文本有意义 */
export const canOpenInIde = (kind: LocalFileKind): boolean =>
  kind === "markdown" || kind === "code" || kind === "text";

/** Sheet 内能展示内容（非空态） */
export const canPreviewInSheet = (kind: LocalFileKind): boolean =>
  kind === "markdown" ||
  kind === "code" ||
  kind === "text" ||
  kind === "image" ||
  kind === "pdf" ||
  kind === "docx" ||
  kind === "xlsx";

/** HTML 的主意图是查看页面：无源码位置时交给系统默认浏览器。 */
export const shouldOpenLocalFileInBrowser = (absolutePath: string): boolean => {
  const p = absolutePath.trim().toLowerCase();
  return p.endsWith(".html") || p.endsWith(".htm");
};

export type LocalFileOpenTarget = "browser" | "ide" | "preview";

/**
 * 本地文件链接的主动作：
 * - HTML 无行号是可运行产物，去浏览器看渲染结果；
 * - HTML 有行号及其他代码文件是源码导航，去用户配置的 IDE；
 * - 文档、图片等留在 Flowship 预览。
 */
export const resolveLocalFileOpenTarget = (
  absolutePath: string,
  line?: number,
): LocalFileOpenTarget => {
  if (shouldOpenLocalFileInBrowser(absolutePath) && line == null) {
    return "browser";
  }
  if (detectLocalFileKind(absolutePath) === "code") {
    return "ide";
  }
  return "preview";
};

/** Shiki / fenced 块语言 id（扩展名 → streamdown 语言） */
export const extToShikiLang = (ext: string): string => {
  const e = ext.toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    yml: "yaml",
    sh: "bash",
    md: "markdown",
    htm: "html",
  };
  return map[e] ?? e;
};
