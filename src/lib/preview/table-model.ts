/**
 * 表格预览的视图模型（纯函数）：列标、过滤、排序、列宽估算
 *
 * 数据永远不改，只算「显示哪些行、什么顺序」——返回的是 body 行下标数组，
 * 渲染层按下标取行，虚拟列表直接用这个数组的长度。
 */

/** 0 → A, 25 → Z, 26 → AA（Excel 列标） */
export const columnLabel = (index: number): string => {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
};

export interface SortState {
  col: number;
  dir: "asc" | "desc";
}

export interface TableViewOptions {
  /** 第一行是不是表头（表头不参与排序 / 过滤） */
  hasHeader: boolean;
  filter: string;
  sort: SortState | null;
}

export interface TableView {
  header: string[] | null;
  /** 过滤 + 排序后的 body 行下标（指向 rows[headerOffset + i]） */
  order: number[];
  /** body 行相对 rows 的偏移（有表头 = 1） */
  bodyOffset: number;
  /** 过滤前的 body 行数 */
  bodyCount: number;
}

/** 看起来像数字（容忍千分位 / 百分号 / 货币符 / 前后空白）→ 数值，否则 null */
export const parseNumericCell = (raw: string): number | null => {
  const s = raw.trim();
  if (!s) return null;
  const cleaned = s.replace(/[,\s]/g, "").replace(/^[$¥€£]/, "").replace(/%$/, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 两个单元格比较：数字 < 文本；空单元格由调用方单独排到最后 */
export const compareCells = (a: string, b: string): number => {
  const na = parseNumericCell(a);
  const nb = parseNumericCell(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return collator.compare(a, b);
};

export const buildTableView = (
  rows: readonly string[][],
  opts: TableViewOptions,
): TableView => {
  const hasHeader = opts.hasHeader && rows.length > 0;
  const bodyOffset = hasHeader ? 1 : 0;
  const bodyCount = Math.max(0, rows.length - bodyOffset);
  let order = Array.from({ length: bodyCount }, (_, i) => i);

  const q = opts.filter.trim().toLowerCase();
  if (q) {
    order = order.filter((i) => rows[bodyOffset + i]!.some((cell) => cell.toLowerCase().includes(q)));
  }

  if (opts.sort) {
    const { col, dir } = opts.sort;
    const sign = dir === "asc" ? 1 : -1;
    // 稳定排序：Array.prototype.sort 在 Node ≥ 11 / 现代浏览器里是稳定的，相等项保持原顺序
    order = [...order].sort((x, y) => {
      const a = rows[bodyOffset + x]![col] ?? "";
      const b = rows[bodyOffset + y]![col] ?? "";
      // 空单元格永远排最后（不随升降序翻转），否则降序时一屏全是空行
      if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
      return sign * compareCells(a, b);
    });
  }

  return {
    header: hasHeader ? [...rows[0]!] : null,
    order,
    bodyOffset,
    bodyCount,
  };
};

/** 点表头的排序循环：无 → 升序 → 降序 → 无；点别的列从升序开始 */
export const nextSort = (current: SortState | null, col: number): SortState | null => {
  if (!current || current.col !== col) return { col, dir: "asc" };
  if (current.dir === "asc") return { col, dir: "desc" };
  return null;
};

/** 估算列宽（ch，限制在 [6, 48]）：取前 200 行里最长单元格，CJK 字符按 2 宽 */
export const estimateColumnWidths = (
  rows: readonly string[][],
  colCount: number,
  sampleRows = 200,
): number[] => {
  const widths = new Array<number>(colCount).fill(6);
  const n = Math.min(rows.length, sampleRows);
  for (let r = 0; r < n; r++) {
    const row = rows[r]!;
    for (let c = 0; c < colCount; c++) {
      const cell = row[c];
      if (!cell) continue;
      let w = 0;
      for (const ch of cell.slice(0, 80)) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
      if (w + 2 > widths[c]!) widths[c] = w + 2;
    }
  }
  return widths.map((w) => Math.min(48, Math.max(6, w)));
};
