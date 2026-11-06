/**
 * CSV / TSV 解析（纯函数，server 读文件与测试共用）
 *
 * 规则对齐 RFC 4180 的常见子集：双引号包字段、`""` 转义引号、字段里可以有分隔符和换行；
 * 行结束符 CRLF / LF / CR 都认；末尾的空行不算一条记录。
 * 为预览做的取舍：行 / 列超过上限的部分不存（但行数照数，用来提示「共 N 行」）；
 * 引号不闭合时按「到文件末尾都是这个字段」处理，不抛错——预览宁可显示得难看也不要打不开。
 */

export type Delimiter = "," | "\t" | ";" | "|";

const CANDIDATES: readonly Delimiter[] = [",", "\t", ";", "|"];

export interface ParsedDelimited {
  rows: string[][];
  /** 记录总数（含没存下来的） */
  totalRows: number;
  /** 存下来的行里最大的列数（受 maxCols 限制） */
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

/** 统计一行里（引号外的）各候选分隔符个数 */
const countOutsideQuotes = (line: string): Record<Delimiter, number> => {
  const counts: Record<Delimiter, number> = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "," || c === "\t" || c === ";" || c === "|")) counts[c]++;
  }
  return counts;
};

/**
 * 猜分隔符：tsv 扩展名直接定为制表符；否则看前 20 个非空行，
 * 取「每行个数一致（以出现最多的个数为准）的行最多」的那个候选；全军覆没回逗号。
 */
export const detectDelimiter = (text: string, ext?: string): Delimiter => {
  if (ext?.toLowerCase() === "tsv") return "\t";
  const lines = text
    .slice(0, 64 * 1024)
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 20);
  if (lines.length === 0) return ",";
  const perLine = lines.map(countOutsideQuotes);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = perLine.map((c) => c[d]);
    const freq = new Map<number, number>();
    for (const n of counts) if (n > 0) freq.set(n, (freq.get(n) ?? 0) + 1);
    let score = 0;
    for (const v of freq.values()) score = Math.max(score, v);
    // 列数更多的优先（同分时 "a;b;c" 比偶然出现一个逗号更像分隔符）
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
};

export const parseDelimited = (
  text: string,
  delimiter: Delimiter,
  limits: { maxRows: number; maxCols: number },
): ParsedDelimited => {
  const rows: string[][] = [];
  let totalRows = 0;
  let totalCols = 0;
  let truncatedCols = false;

  let field = "";
  let row: string[] = [];
  let colCount = 0;
  let inQuotes = false;
  /** 当前字段是不是以引号开头：只有这种字段里的 `"` 才是转义，中间冒出来的引号按普通字符处理 */
  let quotedField = false;
  let sawAnything = false;

  const pushField = () => {
    colCount++;
    if (colCount <= limits.maxCols) row.push(field);
    else truncatedCols = true;
    field = "";
    quotedField = false;
  };
  const pushRow = () => {
    // 空行（没有任何字符，也不是 "" 这种显式空字段）不算记录：导出工具常在块之间留空行
    if (colCount === 0 && field.length === 0 && !quotedField) return;
    pushField();
    totalRows++;
    if (rows.length < limits.maxRows) {
      rows.push(row);
      if (row.length > totalCols) totalCols = row.length;
    }
    row = [];
    colCount = 0;
  };

  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    sawAnything = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.length === 0 && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += c;
    }
  }
  // 末尾没有换行的最后一条记录；文件以换行结尾时不再多出一条空记录
  if (sawAnything && (field.length > 0 || row.length > 0 || colCount > 0 || quotedField)) pushRow();

  return {
    rows,
    totalRows,
    totalCols,
    truncatedRows: totalRows > rows.length,
    truncatedCols,
  };
};
