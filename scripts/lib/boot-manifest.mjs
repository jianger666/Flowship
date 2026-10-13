/**
 * 启动文件清单的纯函数（无进程 / 网络副作用，可被 vitest 直接单测）。
 * 产物由 scripts/gen-boot-manifest.mjs 写成 app-server/boot-manifest.json，
 * 壳（electron-app/boot-prefetch.mjs）在 Windows 首次启动时按它并行预读。
 */
import path from "node:path";

/** 清单格式版本；壳只认 `files` 数组，version 仅供人看 / 日后升级。 */
export const MANIFEST_VERSION = 1;

/** 即使被读过也不进清单：构建缓存、构建期才用的 trace 文件、sourcemap、清单自己。 */
const EXCLUDE_PATTERNS = [
  /(^|\/)\.next\/cache\//,
  /\.nft\.json$/,
  /\.map$/,
  /(^|\/)boot-manifest\.json$/,
];

export const isExcluded = (relPosix) => EXCLUDE_PATTERNS.some((re) => re.test(relPosix));

/**
 * 把录到的绝对路径换成相对 server 目录的 POSIX 路径。
 * - `roots` 可以给多个（原始路径 + realpath）：server.js 会 chdir 到 realpath，
 *   录到的是真实路径，而调用方手里的可能是符号链接路径（macOS 的 /tmp → /private/tmp）。
 * - 不在任何 root 下的（Node 自带模块、系统库、数据目录）直接丢弃；
 * - 保序、去重（保序很重要：先读的先预读）。
 */
export const toRelativePosix = (roots, absPaths) => {
  const normalizedRoots = roots.map((r) => path.resolve(r));
  const out = [];
  const seen = new Set();
  for (const abs of absPaths) {
    if (typeof abs !== "string" || abs === "") continue;
    const resolved = path.resolve(abs);
    let rel = null;
    for (const root of normalizedRoots) {
      if (resolved.startsWith(root + path.sep)) {
        rel = path.relative(root, resolved).split(path.sep).join("/");
        break;
      }
    }
    if (!rel || rel.startsWith("..") || isExcluded(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
};

/** 合并多份清单，保序去重（前面的优先 = 启动期实际读到的排在前面）。 */
export const mergeUnique = (...lists) => {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
};

/**
 * 递归列出 root 下 subdir 里的文件（POSIX 相对路径、已排除噪声、排序稳定）。
 * @param {string} root
 * @param {string} subdir 相对 root（POSIX）
 * @param {{readdirSync: Function}} fsLike 可注入，便于单测
 */
export const listTree = (root, subdir, fsLike) => {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = fsLike.readdirSync(path.join(root, ...relDir.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && !isExcluded(rel)) out.push(rel);
    }
  };
  walk(subdir);
  return out;
};

/** 从 HTML 里抠出 `/_next/static/...` 资源（浏览器打开首页会立刻请求这些，server 会冷读它们）。 */
export const extractStaticAssetUrls = (html, limit = 300) => {
  const found = [];
  const seen = new Set();
  for (const match of html.matchAll(/\/_next\/static\/[^"'\\\s)<>]+/g)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length >= limit) break;
  }
  return found;
};

/** 组装清单对象。bytes 由调用方统计（需要 stat，纯函数里不碰磁盘）。 */
export const buildManifest = ({ files, totalBytes, meta = {} }) => ({
  version: MANIFEST_VERSION,
  generatedAt: new Date(meta.now ?? Date.now()).toISOString(),
  count: files.length,
  totalBytes,
  ...(meta.source ? { source: meta.source } : {}),
  files,
});
