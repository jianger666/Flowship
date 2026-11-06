/**
 * JSON 树视图的数据层（纯函数）
 *
 * 只把「当前可见」的节点摊平成行（折叠的子树不展开），大 JSON 也只有可见部分进渲染；
 * 展开状态是一组路径字符串，搜索命中时把命中节点的祖先全部加进去即可「自动展开到命中处」。
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonRow {
  /** JS 风格路径（`$.a[0]["b c"]`）：既是展开状态的 key，也是「复制路径」的内容 */
  path: string;
  depth: number;
  /** 对象的键名；数组元素 / 根为 null */
  key: string | null;
  arrayIndex: number | null;
  kind: JsonKind;
  /** 原始值（容器节点用来「复制值」） */
  raw: unknown;
  /** 基本类型的展示文本（字符串带引号）；容器是 `{3}` / `[5]` 这样的摘要 */
  display: string;
  childCount: number;
  expandable: boolean;
  expanded: boolean;
}

export const kindOf = (v: unknown): JsonKind => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
};

const IDENT = /^[A-Za-z_$][\w$]*$/;

export const childPath = (parent: string, key: string | number): string =>
  typeof key === "number"
    ? `${parent}[${key}]`
    : IDENT.test(key)
      ? `${parent}.${key}`
      : `${parent}[${JSON.stringify(key)}]`;

const childEntries = (v: unknown): [string | number, unknown][] => {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (v !== null && typeof v === "object") return Object.entries(v as Record<string, unknown>);
  return [];
};

const displayOf = (v: unknown, kind: JsonKind, childCount: number): string => {
  if (kind === "object") return `{${childCount}}`;
  if (kind === "array") return `[${childCount}]`;
  if (kind === "string") return JSON.stringify(v);
  return String(v);
};

const makeRow = (
  path: string,
  depth: number,
  key: string | number | null,
  value: unknown,
  expanded: ReadonlySet<string>,
): JsonRow => {
  const kind = kindOf(value);
  const childCount = kind === "object" || kind === "array" ? childEntries(value).length : 0;
  const expandable = childCount > 0;
  return {
    path,
    depth,
    key: typeof key === "string" ? key : null,
    arrayIndex: typeof key === "number" ? key : null,
    kind,
    raw: value,
    display: displayOf(value, kind, childCount),
    childCount,
    expandable,
    expanded: expandable && expanded.has(path),
  };
};

/** 渲染行数上限：全部展开一个超大数组时不让 DOM / 内存失控（超出部分在末尾给提示行由 UI 处理） */
export const MAX_JSON_ROWS = 50_000;

export const flattenJson = (
  root: unknown,
  expanded: ReadonlySet<string>,
  maxRows = MAX_JSON_ROWS,
): { rows: JsonRow[]; capped: boolean } => {
  const rows: JsonRow[] = [];
  // 显式栈：深层嵌套不吃调用栈。子节点倒序入栈，出栈顺序才是文档顺序
  const stack: { path: string; depth: number; key: string | number | null; value: unknown }[] = [
    { path: "$", depth: 0, key: null, value: root },
  ];
  while (stack.length > 0) {
    if (rows.length >= maxRows) return { rows, capped: true };
    const cur = stack.pop()!;
    const row = makeRow(cur.path, cur.depth, cur.key, cur.value, expanded);
    rows.push(row);
    if (row.expanded) {
      const entries = childEntries(cur.value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i]!;
        stack.push({ path: childPath(cur.path, k), depth: cur.depth + 1, key: k, value: v });
      }
    }
  }
  return { rows, capped: false };
};

/** 默认展开：根 + 向下 levels-1 层容器（levels=2 即根与它的直接容器子节点） */
export const defaultExpandedPaths = (root: unknown, levels = 2): Set<string> => {
  const out = new Set<string>();
  const walk = (path: string, value: unknown, depth: number) => {
    if (depth >= levels) return;
    const entries = childEntries(value);
    if (entries.length === 0) return;
    out.add(path);
    for (const [k, v] of entries) walk(childPath(path, k), v, depth + 1);
  };
  walk("$", root, 0);
  return out;
};

/** 全部容器路径（「全部展开」用；节点太多时只展开到上限为止） */
export const allContainerPaths = (root: unknown, limit = 20_000): Set<string> => {
  const out = new Set<string>();
  const stack: { path: string; value: unknown }[] = [{ path: "$", value: root }];
  while (stack.length > 0 && out.size < limit) {
    const cur = stack.pop()!;
    const entries = childEntries(cur.value);
    if (entries.length === 0) continue;
    out.add(cur.path);
    for (const [k, v] of entries) stack.push({ path: childPath(cur.path, k), value: v });
  }
  return out;
};

export interface JsonSearchResult {
  /** 命中节点的路径（文档顺序） */
  matches: string[];
  /** 命中节点所有祖先的路径：并进展开集合就能让命中处可见 */
  ancestors: Set<string>;
  /** 命中过多 / 节点过多被截断 */
  capped: boolean;
}

/** 在键名与基本类型的值里找子串（不区分大小写） */
export const searchJson = (
  root: unknown,
  query: string,
  opts: { limit?: number; maxNodes?: number } = {},
): JsonSearchResult => {
  const q = query.trim().toLowerCase();
  const result: JsonSearchResult = { matches: [], ancestors: new Set(), capped: false };
  if (!q) return result;
  const limit = opts.limit ?? 500;
  const maxNodes = opts.maxNodes ?? 200_000;
  let visited = 0;

  const walk = (path: string, key: string | number | null, value: unknown, chain: string[]): boolean => {
    if (visited++ >= maxNodes || result.matches.length >= limit) {
      result.capped = true;
      return false;
    }
    const kind = kindOf(value);
    const keyHit = typeof key === "string" && key.toLowerCase().includes(q);
    const valueHit =
      kind !== "object" && kind !== "array" && String(value).toLowerCase().includes(q);
    if (keyHit || valueHit) {
      result.matches.push(path);
      for (const a of chain) result.ancestors.add(a);
    }
    // 递归深度封顶：V8 的 JSON.parse 不吃调用栈，几十万层嵌套的文件能解析成功，这里却会爆栈
    if ((kind === "object" || kind === "array") && chain.length < 1000) {
      chain.push(path);
      for (const [k, v] of childEntries(value)) {
        if (!walk(childPath(path, k), k, v, chain)) {
          chain.pop();
          return false;
        }
      }
      chain.pop();
    }
    return true;
  };
  walk("$", null, root, []);
  return result;
};
