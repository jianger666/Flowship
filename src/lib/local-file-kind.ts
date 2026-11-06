/**
 * 本地文件预览：按扩展名推断 kind（客户端 / server 共用）
 *
 * 为什么单独抽：artifact / 事件流 / Sheet 预览 / read-local-file API 都要同一套
 * 分类规则，散着写「md 能不能在 IDE 开」必漂移。
 */

import { detectMediaKind } from "@/lib/media/media-kind";

/** 预览 Sheet 里怎么渲染（音视频不进 Sheet：走全局播放器悬浮窗，见 media-player-dock） */
export type LocalFileKind =
  | "markdown"
  | "code"
  | "text"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "svg"
  | "csv"
  | "archive"
  | "video"
  | "audio"
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
  "makefile",
]);

/** 表格文本：进表格预览（排序 / 过滤 / 固定表头），不是源码导航 */
const CSV_EXT = new Set(["csv", "tsv"]);

/** zip 家族：只列目录，不解压 */
const ARCHIVE_EXT = new Set([
  "zip",
  "jar",
  "war",
  "ear",
  "apk",
  "aar",
  "whl",
  "vsix",
  "nupkg",
  "xpi",
  "crx",
]);

/** 没有（可用）扩展名、但一看文件名就知道是什么的文件 → 按哪个扩展名处理 */
const SPECIAL_BASENAME_EXT: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".gitignore": "txt",
  ".gitattributes": "txt",
  ".dockerignore": "txt",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".nvmrc": "txt",
  ".prettierrc": "json",
  ".eslintrc": "json",
  ".babelrc": "json",
  license: "txt",
  licence: "txt",
  notice: "txt",
  authors: "txt",
  codeowners: "txt",
};

/**
 * 从路径 / 文件名 / 裸扩展名取「预览用扩展名」（小写，不带点）。
 * 比 `path.extname` 多认几类：`.env` / `.env.local`、`Dockerfile`、`Makefile`、`.gitignore` 这类
 * extname 为空或不是真扩展名的文件；同时只看文件名部分——目录名里带点（`/a.b/Dockerfile`）不再被当成扩展名。
 */
export const extOfPath = (pathOrName: string): string => {
  const raw = pathOrName.trim();
  const base = (raw.split(/[\\/]/).pop() ?? raw).toLowerCase();
  const special = SPECIAL_BASENAME_EXT[base];
  if (special) return special;
  if (base === ".env" || base.startsWith(".env.")) return "env";
  const dot = base.lastIndexOf(".");
  // 无点：裸扩展名（"mp3"）或无扩展名文件，原样返回；有点：取最后一段
  return dot < 0 ? base : base.slice(dot + 1);
};

const TEXT_EXT = new Set(["txt", "log", "env", "ini", "cfg", "conf"]);

/** 从路径或裸扩展名（可带 `.`）推断 kind */
export const detectLocalFileKind = (pathOrExt: string): LocalFileKind => {
  const ext = extOfPath(pathOrExt);
  if (!ext) return "unknown";
  if (ext === "md") return "markdown";
  const media = detectMediaKind(ext);
  if (media) return media;
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (ext === "pptx" || ext === "ppt") return "pptx";
  if (ext === "svg") return "svg";
  if (CSV_EXT.has(ext)) return "csv";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  // 常见二进制：不给假预览
  if (
    ["exe", "dll", "so", "dylib", "tar", "gz", "tgz", "7z", "rar", "dmg", "iso", "bin", "wasm"].includes(
      ext,
    )
  ) {
    return "binary";
  }
  return "unknown";
};

/** Sheet 顶栏「在 IDE 打开」：只对 md / 代码 / 纯文本（含 csv / svg 这类文本格式）有意义 */
export const canOpenInIde = (kind: LocalFileKind): boolean =>
  kind === "markdown" ||
  kind === "code" ||
  kind === "text" ||
  kind === "csv" ||
  kind === "svg";

/** 内容是文本、能进文本查看 / 编辑器的 kind */
export const isTextKind = (kind: LocalFileKind): boolean =>
  kind === "markdown" ||
  kind === "code" ||
  kind === "text" ||
  kind === "csv" ||
  kind === "svg";

/** Sheet 内能展示内容（非空态） */
export const canPreviewInSheet = (kind: LocalFileKind): boolean =>
  kind === "markdown" ||
  kind === "code" ||
  kind === "text" ||
  kind === "image" ||
  kind === "pdf" ||
  kind === "docx" ||
  kind === "xlsx" ||
  kind === "pptx" ||
  kind === "svg" ||
  kind === "csv" ||
  kind === "archive";

/** HTML 的主意图是查看页面：无源码位置时交给系统默认浏览器。 */
export const shouldOpenLocalFileInBrowser = (absolutePath: string): boolean => {
  const p = absolutePath.trim().toLowerCase();
  return p.endsWith(".html") || p.endsWith(".htm");
};

export type LocalFileOpenTarget = "browser" | "ide" | "preview" | "media";

/**
 * 本地文件链接的主动作：
 * - HTML 无行号是可运行产物，去浏览器看渲染结果；
 * - HTML 有行号及其他代码文件是源码导航，去用户配置的 IDE；
 * - 音视频进全局播放器悬浮窗；
 * - 文档、图片等留在 Flowship 预览。
 */
export const resolveLocalFileOpenTarget = (
  absolutePath: string,
  line?: number,
): LocalFileOpenTarget => {
  if (shouldOpenLocalFileInBrowser(absolutePath) && line == null) {
    return "browser";
  }
  const kind = detectLocalFileKind(absolutePath);
  if (kind === "video" || kind === "audio") return "media";
  if (kind === "code") return "ide";
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
