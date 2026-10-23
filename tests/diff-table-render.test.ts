/**
 * DiffTable 的 SSR 冒烟（renderToStaticMarkup）：node 环境没有 DOM、点不了，
 * 但「给定 rows → 吐出什么结构」是确定的——统一 / 分栏的骨架、行号 data 属性（事件委托靠它）、
 * gap 行与按钮、选区高亮、变更块锚点、词级高亮、无结尾换行标记。
 *
 * 这里不验证视觉（颜色对不对、对不对齐要真机看），只守「结构契约」：改坏了这些属性，
 * 点行号选区 / n·p 滚动定位 / 展开上下文就会静默失效。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffMinimap } from "@/components/tasks/changes/diff-minimap";
import { DiffTable, type DiffTableProps } from "@/components/tasks/changes/diff-table";
import { buildBaseRows } from "@/lib/diff/model";

// 两个 hunk（中间隔 35 行未改动）+ 末尾满 3 行后置上下文（git 只有在「文件还没到头」时才会给满 3 行，
// 所以末尾还有没有行是未知的）：覆盖 middle gap 与 bottom gap（hidden 未知）。
// 变化行是「一行多个词、只变一个」：词级高亮对整行都变的情况按设计不画，测它要用这种数据
const TWO_HUNKS = [
  "@@ -1,4 +1,4 @@",
  " line1",
  "-const total = price * 2;",
  "+const total = price * 3;",
  " line3",
  " line4",
  "@@ -40,5 +40,5 @@ function foo() {",
  " line40",
  "-line41",
  "+LINE41",
  " line42",
  " line43",
  " line44",
].join("\n");

const NO_NEWLINE = [
  "@@ -1,2 +1,2 @@",
  " a",
  "-b",
  "\\ No newline at end of file",
  "+c",
  "\\ No newline at end of file",
].join("\n");

const render = (diff: string, over: Partial<DiffTableProps> = {}): string =>
  renderToStaticMarkup(
    createElement(DiffTable, {
      rows: buildBaseRows(diff).rows,
      view: "unified",
      language: null,
      selection: null,
      activeBlock: null,
      canExpand: true,
      loadingGapKey: null,
      onSelectLine: () => {},
      onExpand: () => {},
      ...over,
    }),
  );

describe("DiffTable：unified", () => {
  const html = render(TWO_HUNKS);

  it("容器标明视图类型、是可读屏识别的区域", () => {
    expect(html).toContain('data-diff-view="unified"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="代码差异"');
  });

  it("每个有行号的格子都带 data-gutter / data-n（点行号选区的事件委托靠它）", () => {
    expect(html).toContain('data-gutter="old"');
    expect(html).toContain('data-gutter="new"');
    // 删除行 line2 在旧文件第 2 行、新增行 LINE2 在新文件第 2 行
    expect(html).toMatch(/data-gutter="old"[^>]*data-n="2"|data-n="2"[^>]*data-gutter="old"/);
    expect(html).toMatch(/data-gutter="new"[^>]*data-n="2"|data-n="2"[^>]*data-gutter="new"/);
  });

  it("增 / 删行用语义色底，没有语法色时整行红绿字", () => {
    expect(html).toContain("bg-success/10");
    expect(html).toContain("text-success");
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain("text-destructive");
  });

  it("加减号列不可选（复制出来只有代码）", () => {
    expect(html).toMatch(/<span aria-hidden="true"[^>]*select-none[^>]*>\+<\/span>/);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*select-none[^>]*>−<\/span>/);
  });

  it("词级高亮：删 / 增配对行里变了的词加深一档底色", () => {
    expect(html).toContain("bg-destructive/30");
    expect(html).toContain("bg-success/30");
  });

  it("每个变更块的第一行带 data-block 序号，n / p 滚动定位靠它", () => {
    expect(html).toContain('data-block="0"');
    expect(html).toContain('data-block="1"');
    expect(html).not.toContain('data-block="2"');
  });

  it("变更块之间的折叠行：显示行范围和函数上下文，三个展开按钮齐全", () => {
    expect(html).toContain("data-gap=");
    expect(html).toContain("35 行未改动");
    expect(html).toContain("function foo()");
    expect(html).toContain('aria-label="向下展开 20 行"');
    expect(html).toContain('aria-label="向上展开 20 行"');
    expect(html).toContain('aria-label="展开全部 35 行"');
  });

  it("末尾还有多少行不知道：只给一个「展开更多」", () => {
    expect(html).toContain("后面还有未改动的行");
    expect(html).toContain('aria-label="展开更多"');
  });

  it("canExpand=false（截断 / 过大）：折叠行只留说明、没有任何展开按钮", () => {
    const off = render(TWO_HUNKS, { canExpand: false });
    expect(off).toContain("35 行未改动");
    expect(off).not.toContain("展开");
  });

  it("正在拉整文件：展开按钮禁用并转圈", () => {
    const key = buildBaseRows(TWO_HUNKS).rows.flatMap((r) => (r.type === "gap" ? [r.gap] : []))[0]
      .key;
    const busy = render(TWO_HUNKS, { loadingGapKey: key });
    expect(busy).toContain("animate-spin");
    expect(busy).toMatch(/aria-label="向下展开 20 行"[^>]*disabled=""|disabled=""[^>]*aria-label="向下展开 20 行"/);
  });

  it("选区：被选中的行换成选中底色，行号加亮", () => {
    const sel = render(TWO_HUNKS, { selection: { side: "new", from: 2, to: 2 } });
    expect(sel).toContain("bg-info/20");
    expect(render(TWO_HUNKS)).not.toContain("bg-info/20");
  });

  it("旧侧选区只点亮旧侧有行号的行（新增行没有旧行号，不会被选中）", () => {
    const sel = render(TWO_HUNKS, { selection: { side: "old", from: 2, to: 2 } });
    // 只有删除行 line2（旧第 2 行）+ 上下文行 line2 之前没有——即恰好一行
    expect(sel.match(/bg-info\/20/g)?.length).toBe(1);
  });

  it("当前变更块带强调边", () => {
    expect(render(TWO_HUNKS, { activeBlock: 0 })).toContain("border-info");
    expect(render(TWO_HUNKS, { activeBlock: null })).not.toContain("border-info");
  });

  it("「无结尾换行」标记行：显示中文说明，且不当成代码行（没有行号 / 加减号）", () => {
    const marker = render(NO_NEWLINE);
    expect(marker).toContain("文件末尾无换行符");
    expect(marker).not.toContain("No newline");
  });

  it("空 rows：不崩、只有空容器", () => {
    const empty = renderToStaticMarkup(
      createElement(DiffTable, {
        rows: [],
        view: "unified",
        language: null,
        selection: null,
        activeBlock: null,
        canExpand: true,
        loadingGapKey: null,
        onSelectLine: () => {},
        onExpand: () => {},
      }),
    );
    expect(empty).toContain('data-diff-view="unified"');
    expect(empty).not.toContain("data-gutter");
  });
});

describe("DiffTable：split", () => {
  const html = render(TWO_HUNKS, { view: "split" });

  it("单个 4 列 grid（左行号 / 左代码 / 右行号 / 右代码）", () => {
    expect(html).toContain('data-diff-view="split"');
    expect(html).toContain("grid-template-columns:2.75rem minmax(0,1fr) 2.75rem minmax(0,1fr)");
    expect(html).toContain('aria-label="代码差异（分栏）"');
  });

  it("左右两栏的代码格各自带 data-side（拖选文本时只选一侧靠它）", () => {
    expect(html).toContain('data-side="left"');
    expect(html).toContain('data-side="right"');
  });

  it("删除行在左栏、新增行在右栏，且配成同一行", () => {
    // 同一个 pair：左栏 line41、右栏 LINE41——顺序上先左后右，中间隔着右栏代码格的标记
    const leftIdx = html.indexOf("line41");
    const rightIdx = html.indexOf("LINE41");
    expect(leftIdx).toBeGreaterThan(-1);
    expect(rightIdx).toBeGreaterThan(leftIdx);
    expect(html.slice(leftIdx, rightIdx)).toContain('data-side="right"');
    // 且左栏那一格之前的最近一个 data-side 是 left
    expect(html.slice(0, leftIdx).lastIndexOf('data-side="left"')).toBeGreaterThan(
      html.slice(0, leftIdx).lastIndexOf('data-side="right"'),
    );
  });

  it("行号格只在该侧有行号时才带 data-gutter（新增行的左栏是空格子，选不了）", () => {
    // 左栏行号格的 data-gutter 必为 old，右栏必为 new
    for (const m of html.matchAll(/data-gutter="(old|new)"/g)) {
      expect(["old", "new"]).toContain(m[1]);
    }
    expect(html).toContain('data-gutter="old"');
    expect(html).toContain('data-gutter="new"');
  });

  it("折叠行占满 4 列", () => {
    expect(html).toContain("col-span-4");
    expect(html).toContain("35 行未改动");
  });

  it("变更块锚点与 unified 一致", () => {
    expect(html).toContain('data-block="0"');
    expect(html).toContain('data-block="1"');
  });

  it("旧侧选区只点亮左栏、新侧选区只点亮右栏", () => {
    const oldSel = render(TWO_HUNKS, { view: "split", selection: { side: "old", from: 2, to: 2 } });
    const newSel = render(TWO_HUNKS, { view: "split", selection: { side: "new", from: 2, to: 2 } });
    expect(oldSel.match(/bg-info\/20/g)?.length).toBe(2); // 左栏行号格 + 左栏代码格
    expect(newSel.match(/bg-info\/20/g)?.length).toBe(2); // 右栏行号格 + 右栏代码格
  });

  it("「无结尾换行」标记行跟着所属一侧", () => {
    const marker = render(NO_NEWLINE, { view: "split" });
    expect(marker.match(/文件末尾无换行符/g)?.length).toBe(2);
  });
});

describe("DiffTable：「最后一行被改 + 无结尾换行」是一处改动", () => {
  // 删 b / 标记 / 增 c / 标记：git 在两侧都没有结尾换行时就是这个形状
  it("unified / split 都只有一个变更块（data-block=0），不会出现第二块", () => {
    for (const view of ["unified", "split"] as const) {
      const html = render(NO_NEWLINE, { view });
      expect(html, view).toContain('data-block="0"');
      expect(html, view).not.toContain('data-block="1"');
    }
  });

  it("当前块高亮时，块里的标记行也一起亮（unified：删 / 标记 / 增 / 标记 共 4 行；split：并排的 2 个格行）", () => {
    const lit = (html: string): number => html.match(/border-info/g)?.length ?? 0;
    expect(lit(render(NO_NEWLINE, { view: "unified", activeBlock: 0 }))).toBe(4);
    expect(lit(render(NO_NEWLINE, { view: "split", activeBlock: 0 }))).toBe(2);
    expect(lit(render(NO_NEWLINE, { view: "unified", activeBlock: null }))).toBe(0);
  });

  it("分栏里删 / 增并排在同一格行里（旧：上下错开成两行）", () => {
    const html = render(NO_NEWLINE, { view: "split" });
    // 一个 pair = 4 个格子；上下文 a、b|c、两个标记 = 3 个 pair 行 → 左栏只有 3 个带 data-line 的行号格
    // 不依赖具体 DOM 结构，只数 pair 边框：每个 pair 行有且仅有一个左边框容器
    const edges = html.match(/border-l-2/g)?.length ?? 0;
    expect(edges).toBe(3);
  });
});

describe("DiffMinimap：变更块小地图", () => {
  const renderMinimap = (diff: string, activeBlock: number | null = null): string =>
    renderToStaticMarkup(
      createElement(DiffMinimap, { rows: buildBaseRows(diff).rows, activeBlock, onJump: () => {} }),
    );

  it("两个变更块 → 两个色块按钮，带读屏用的序号标签", () => {
    const html = renderMinimap(TWO_HUNKS);
    expect(html).toContain('role="navigation"');
    expect(html).toContain('aria-label="变更块导航"');
    expect(html).toContain('aria-label="第 1 处改动，共 2 处"');
    expect(html).toContain('aria-label="第 2 处改动，共 2 处"');
    expect(html.match(/<button/g)?.length).toBe(2);
  });

  it("色块按钮不占 Tab 序（几百个块 = 几百个 Tab 停靠点；键盘用户有 n / p）", () => {
    const html = renderMinimap(TWO_HUNKS);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(2);
    for (const tag of buttons) expect(tag).toContain('tabindex="-1"');
  });

  it("只有一个变更块不渲染（没什么可导航的）", () => {
    const oneBlock = ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n");
    expect(renderMinimap(oneBlock)).toBe("");
  });

  it("当前块有高亮环，其余没有", () => {
    expect(renderMinimap(TWO_HUNKS, 1).match(/ring-foreground/g)?.length).toBe(1);
    expect(renderMinimap(TWO_HUNKS, null)).not.toContain("ring-foreground");
  });
});
