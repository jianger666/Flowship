/**
 * 代码改动面板的文件树：纯逻辑层（无 React、无 DOM，方便单测）。
 *
 * 为什么要单独做成纯函数：
 *   树的形状（分组、排序、目录压缩、汇总）决定了面板的信息密度和导航顺序，
 *   而这些都是「同样输入必须得到同样输出」的确定性逻辑，放进组件里既难测又容易随渲染漂移。
 *
 * 几条关键取舍：
 *   - **结果不依赖输入顺序**：目录 / 文件各自按「自然排序 → 原始字符串 → key」三级比较，
 *     后端返回顺序变了（例如 git 输出顺序抖动）树也不会跳。
 *   - **目录压缩（VS Code 的 compact folders）**：只有「单个子目录、没有文件」的目录与其子目录合并成一行，
 *     避免 `src/main/java/com/xxx` 这种深链占满好几层缩进。
 *     id 取链上最深目录的完整路径——折叠状态按 id 存，链条的任一层变化（分叉出新文件）时 id 自然换新，
 *     不会把旧折叠状态错套到新形状上。
 *   - **排序用链首目录名**：压缩只是显示层合并，不应该改变目录之间的相对顺序。
 *   - **汇总在压缩前后一致**：压缩链上的中间目录没有别的内容，子树合计就是最深目录的合计。
 */

/** 树的输入项：由面板把「改动文件」映射而来 */
export interface TreeItem<T> {
  /** 外部唯一 key（面板里的 entryKey，跨仓不撞） */
  key: string;
  /** 仓内相对路径，正斜杠 */
  path: string;
  /** 新增行数；null = 二进制 / 未统计，汇总时按 0 */
  added: number | null;
  /** 删除行数；null 同上 */
  removed: number | null;
  /** 调用方携带的任意附加数据，原样透传 */
  data: T;
}

/** 目录节点（可能是压缩链） */
export interface DirNode<T> {
  type: "dir";
  /** 折叠状态用的稳定 id：压缩链取「最深那层目录」的完整路径，如 "src/lib/diff" */
  id: string;
  /** 展示名：压缩链用 "/" 连接，如 "src/lib/diff"；未压缩的就是本层目录名 */
  name: string;
  children: Array<DirNode<T> | FileNode<T>>;
  /** 整个子树里的文件数 */
  fileCount: number;
  /** 子树新增行合计（null 当 0） */
  added: number;
  /** 子树删除行合计（null 当 0） */
  removed: number;
}

/** 文件节点 */
export interface FileNode<T> {
  type: "file";
  /** = item.key */
  id: string;
  /** basename */
  name: string;
  item: TreeItem<T>;
}

/** 树节点：目录或文件 */
export type FileTreeNode<T> = DirNode<T> | FileNode<T>;

/** 拍平后的一行：节点 + 缩进深度（从 0 起，压缩链算一层） */
export interface FlatTreeRow<T> {
  node: FileTreeNode<T>;
  depth: number;
}

/** 构建过程中的可变 trie 节点（不对外暴露） */
interface TrieDir<T> {
  /** 本层目录名（单段） */
  name: string;
  /** 从根到本层的完整路径 */
  path: string;
  dirs: Map<string, TrieDir<T>>;
  files: Array<TreeItem<T>>;
}

/** 自然排序：`a2` 在 `a10` 前，大小写 / 重音不敏感；平局回落到原始字符串，保证全序 */
const compareNames = (a: string, b: string): number => {
  const natural = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  if (natural !== 0) return natural;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/** 把 path 切成非空段（容忍 `a//b`、前后多余斜杠） */
const splitPath = (path: string): string[] => path.split("/").filter((s) => s.length > 0);

const newTrieDir = <T>(name: string, path: string): TrieDir<T> => ({
  name,
  path,
  dirs: new Map(),
  files: [],
});

/** 文件 basename；path 切不出任何段（空串 / 全是斜杠）时退回原串，保证节点永远有名字 */
const baseName = (path: string): string => {
  const segs = splitPath(path);
  return segs.length > 0 ? segs[segs.length - 1] : path;
};

/** 把 trie 目录转换成 DirNode，同时做压缩链合并与汇总 */
const toDirNode = <T>(top: TrieDir<T>): DirNode<T> => {
  // 沿「无文件且恰有一个子目录」的链一路下钻；链首名字用于排序、整条链名字用于展示
  let cur = top;
  let name = top.name;
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const only = cur.dirs.values().next().value as TrieDir<T>;
    name = `${name}/${only.name}`;
    cur = only;
  }
  const children = sortChildren(cur);
  let fileCount = 0;
  let added = 0;
  let removed = 0;
  for (const child of children) {
    if (child.type === "dir") {
      fileCount += child.fileCount;
      added += child.added;
      removed += child.removed;
    } else {
      fileCount += 1;
      added += child.item.added ?? 0;
      removed += child.item.removed ?? 0;
    }
  }
  return { type: "dir", id: cur.path, name, children, fileCount, added, removed };
};

/** 一层的子节点：目录在前、文件在后，各自三级比较排序 */
const sortChildren = <T>(dir: TrieDir<T>): Array<DirNode<T> | FileNode<T>> => {
  const dirs = [...dir.dirs.values()]
    .sort((a, b) => compareNames(a.name, b.name))
    .map((d) => toDirNode(d));
  const files = sortFiles(dir.files);
  return [...dirs, ...files];
};

const sortFiles = <T>(items: readonly TreeItem<T>[]): Array<FileNode<T>> =>
  items
    .map((item): FileNode<T> => ({ type: "file", id: item.key, name: baseName(item.path), item }))
    .sort((a, b) => compareNames(a.name, b.name) || compareNames(a.item.key, b.item.key));

/**
 * 把扁平的文件列表构建成目录树（目录在前、自然排序、单链压缩、子树汇总）。
 * 同一 path 出现多次时都保留（靠 key 区分），不抛错。
 */
export const buildFileTree = <T>(items: readonly TreeItem<T>[]): FileTreeNode<T>[] => {
  const root = newTrieDir<T>("", "");
  for (const item of items) {
    const segs = splitPath(item.path);
    // 最后一段是文件名，前面的才是目录
    const dirSegs = segs.slice(0, -1);
    let cur = root;
    let acc = "";
    for (const seg of dirSegs) {
      acc = acc === "" ? seg : `${acc}/${seg}`;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = newTrieDir<T>(seg, acc);
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(item);
  }
  // 根层不参与压缩（根本身不是一行展示的目录），直接取其排好序的子节点
  return sortChildren(root);
};

/**
 * 先序展开成带缩进深度的行；`collapsed` 里放 dir id。
 * 被折叠的目录本身仍输出一行，只是不输出它的子孙。
 */
export const flattenFileTree = <T>(
  nodes: readonly FileTreeNode<T>[],
  collapsed: ReadonlySet<string>,
): FlatTreeRow<T>[] => {
  const rows: FlatTreeRow<T>[] = [];
  const walk = (list: readonly FileTreeNode<T>[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth });
      if (node.type === "dir" && !collapsed.has(node.id)) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
};

/** 先序遍历的全部文件（忽略折叠态）——「下一个 / 上一个文件」导航的统一顺序 */
export const treeFileOrder = <T>(nodes: readonly FileTreeNode<T>[]): TreeItem<T>[] => {
  const out: TreeItem<T>[] = [];
  const walk = (list: readonly FileTreeNode<T>[]): void => {
    for (const node of list) {
      if (node.type === "file") out.push(node.item);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
};

/**
 * 从根到某个文件的全部祖先目录 id（导航跳到被折叠目录里的文件时，据此自动展开）。
 * 压缩链只算一个 id；文件在根或找不到时返回 []。
 */
export const ancestorDirIds = <T>(nodes: readonly FileTreeNode<T>[], fileKey: string): string[] => {
  const walk = (list: readonly FileTreeNode<T>[], trail: string[]): string[] | null => {
    for (const node of list) {
      if (node.type === "file") {
        if (node.id === fileKey) return trail;
      } else {
        const found = walk(node.children, [...trail, node.id]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(nodes, []) ?? [];
};

/** 全部目录 id（先序；「全部折叠 / 展开」用） */
export const allDirIds = <T>(nodes: readonly FileTreeNode<T>[]): string[] => {
  const out: string[] = [];
  const walk = (list: readonly FileTreeNode<T>[]): void => {
    for (const node of list) {
      if (node.type === "dir") {
        out.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
};
