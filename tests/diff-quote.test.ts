/**
 * 「引用到对话」：行选区 → markdown 片段（纯函数）
 */
import { describe, expect, it } from "vitest";

import type { DiffRow } from "@/lib/diff/model";
import {
  describeSelection,
  formatSelectionQuote,
  lineInSelection,
  makeSelection,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  selectionLines,
} from "@/lib/diff/quote";
import type { DiffViewLine } from "@/lib/tool-display";

const line = (
  kind: DiffViewLine["kind"],
  text: string,
  oldLine?: number,
  newLine?: number,
): DiffViewLine => ({
  kind,
  text,
  ...(oldLine !== undefined ? { oldLine } : {}),
  ...(newLine !== undefined ? { newLine } : {}),
});
const asRows = (...lines: DiffViewLine[]): DiffRow[] => lines.map((l) => ({ type: "line", line: l }));

describe("makeSelection / lineInSelection", () => {
  it("端点顺序不限；旧侧看 oldLine、新侧看 newLine，该侧没有行号的行不算", () => {
    expect(makeSelection("new", 9, 4)).toEqual({ side: "new", from: 4, to: 9 });
    const sel = makeSelection("old", 2, 3);
    expect(lineInSelection(line("del", "a", 2), sel)).toBe(true);
    expect(lineInSelection(line("context", "a", 3, 5), sel)).toBe(true);
    expect(lineInSelection(line("add", "a", undefined, 2), sel)).toBe(false);
    expect(lineInSelection(line("context", "a", 4, 4), sel)).toBe(false);
    expect(lineInSelection(line("del", "a", 2), null)).toBe(false);
  });
});

describe("selectionLines", () => {
  const rows: DiffRow[] = [
    ...asRows(line("context", "c1", 1, 1), line("del", "old", 2), line("add", "new1", undefined, 2)),
    { type: "gap", gap: { key: 9, hidden: 3, position: "middle" } },
    ...asRows(line("add", "new2", undefined, 3), line("context", "c2", 3, 4)),
  ];

  it("新侧 = 新增 + 上下文；旧侧 = 删除 + 上下文；gap 不算", () => {
    expect(selectionLines(rows, makeSelection("new", 1, 4)).map((l) => l.text)).toEqual([
      "c1", "new1", "new2", "c2",
    ]);
    expect(selectionLines(rows, makeSelection("old", 1, 3)).map((l) => l.text)).toEqual([
      "c1", "old", "c2",
    ]);
    expect(selectionLines(rows, makeSelection("new", 50, 60))).toEqual([]);
  });
});

describe("describeSelection / formatSelectionQuote", () => {
  it("单行 / 范围", () => {
    expect(describeSelection(makeSelection("new", 7, 7))).toBe("L7");
    expect(describeSelection(makeSelection("new", 7, 12))).toBe("L7–L12");
  });

  it("位置说明 + 代码块；新侧 / 旧侧分别标注；语言写进围栏", () => {
    const text = formatSelectionQuote({
      path: "src/a.ts",
      sel: makeSelection("new", 3, 4),
      lines: [line("add", "const a = 1;", undefined, 3), line("context", "export {};", 3, 4)],
      language: "typescript",
    });
    expect(text).toBe("`src/a.ts` L3–L4（改动后）：\n\n```typescript\nconst a = 1;\nexport {};\n```\n");
    expect(
      formatSelectionQuote({ path: "a.ts", sel: makeSelection("old", 5, 5), lines: [line("del", "x", 5)] }),
    ).toBe("`a.ts` L5（改动前）：\n\n```\nx\n```\n");
  });

  it("内容里有 ``` 时围栏自动加长，路径里有反引号时行内代码也加长", () => {
    const text = formatSelectionQuote({
      path: "we`ird.ts",
      sel: makeSelection("new", 1, 2),
      lines: [line("add", "```js", undefined, 1), line("add", "x", undefined, 2)],
    });
    expect(text).toContain("``we`ird.ts`` L1–L2");
    expect(text).toContain("````\n```js\nx\n````");
  });

  it("CRLF 去掉行尾回车", () => {
    const text = formatSelectionQuote({
      path: "a.ts",
      sel: makeSelection("new", 1, 1),
      lines: [line("add", "abc\r", undefined, 1)],
    });
    expect(text).not.toContain("\r");
  });

  it("太长就截断并注明（行数 / 字符数两道上限）", () => {
    const many = Array.from({ length: MAX_QUOTE_LINES + 30 }, (_, i) => line("add", `l${i}`, undefined, i + 1));
    const byLines = formatSelectionQuote({ path: "a.ts", sel: makeSelection("new", 1, 300), lines: many });
    expect(byLines).toContain("内容较长已截断");
    expect(byLines).toContain(`l${MAX_QUOTE_LINES - 1}`);
    expect(byLines).not.toContain(`l${MAX_QUOTE_LINES}\n`);

    const huge = [line("add", "x".repeat(MAX_QUOTE_CHARS + 500), undefined, 1)];
    const byChars = formatSelectionQuote({ path: "a.ts", sel: makeSelection("new", 1, 1), lines: huge });
    expect(byChars).toContain("内容较长已截断");
    expect(byChars.length).toBeLessThan(MAX_QUOTE_CHARS + 200);

    expect(
      formatSelectionQuote({ path: "a.ts", sel: makeSelection("new", 1, 1), lines: [line("add", "ok", undefined, 1)] }),
    ).not.toContain("截断");
  });
});
