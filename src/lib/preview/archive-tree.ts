/**
 * 压缩包条目 → 目录树（纯函数）
 *
 * zip 的条目是扁平路径列表，且目录条目（以 / 结尾）不一定都有——很多打包工具只写文件条目。
 * 这里按路径补全中间目录，目录聚合子孙的文件数与大小；目录在前、文件在后，各自按名字自然排序。
 */

import type { ArchiveEntryInfo } from "@/lib/preview/types";

export interface ArchiveNode {
  /** 完整路径（目录以 / 结尾）：展开状态的 key */
  path: string;
  name: string;
  isDir: boolean;
  /** 文件：解压后大小；目录：子孙文件大小之和 */
  size: number;
  compressedSize: number;
  /** 目录：子孙文件数；文件为 1 */
  fileCount: number;
  children: ArchiveNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const buildArchiveTree = (entries: readonly ArchiveEntryInfo[]): ArchiveNode => {
  const root: ArchiveNode = {
    path: "",
    name: "",
    isDir: true,
    size: 0,
    compressedSize: 0,
    fileCount: 0,
    children: [],
  };
  const dirs = new Map<string, ArchiveNode>([["", root]]);

  const ensureDir = (dirPath: string): ArchiveNode => {
    const hit = dirs.get(dirPath);
    if (hit) return hit;
    const trimmed = dirPath.slice(0, -1);
    const slash = trimmed.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : trimmed.slice(0, slash + 1));
    const node: ArchiveNode = {
      path: dirPath,
      name: trimmed.slice(slash + 1),
      isDir: true,
      size: 0,
      compressedSize: 0,
      fileCount: 0,
      children: [],
    };
    parent.children.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  for (const e of entries) {
    // 去掉 ./ 前缀与前导斜杠；Windows 打的包可能带反斜杠
    const clean = e.name.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "");
    if (!clean) continue;
    if (e.isDir || clean.endsWith("/")) {
      ensureDir(clean.endsWith("/") ? clean : `${clean}/`);
      continue;
    }
    const slash = clean.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : clean.slice(0, slash + 1));
    parent.children.push({
      path: clean,
      name: clean.slice(slash + 1),
      isDir: false,
      size: e.size,
      compressedSize: e.compressedSize,
      fileCount: 1,
      children: [],
    });
  }

  const finish = (node: ArchiveNode): void => {
    node.children.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name),
    );
    for (const c of node.children) {
      if (c.isDir) finish(c);
      node.size += c.size;
      node.compressedSize += c.compressedSize;
      node.fileCount += c.fileCount;
    }
  };
  finish(root);
  return root;
};

export interface ArchiveRow {
  node: ArchiveNode;
  depth: number;
}

/**
 * 按展开状态摊平成可见行。filter 非空时忽略展开状态：只保留文件名命中的文件及其祖先目录，并全部展开。
 */
export const flattenArchive = (
  root: ArchiveNode,
  expanded: ReadonlySet<string>,
  filter: string,
): ArchiveRow[] => {
  const q = filter.trim().toLowerCase();
  const rows: ArchiveRow[] = [];

  const hasMatch = (n: ArchiveNode): boolean =>
    n.isDir ? n.children.some(hasMatch) : n.path.toLowerCase().includes(q);

  const walk = (n: ArchiveNode, depth: number): void => {
    for (const c of n.children) {
      if (q) {
        if (!hasMatch(c)) continue;
        rows.push({ node: c, depth });
        if (c.isDir) walk(c, depth + 1);
      } else {
        rows.push({ node: c, depth });
        if (c.isDir && expanded.has(c.path)) walk(c, depth + 1);
      }
    }
  };
  walk(root, 0);
  return rows;
};
