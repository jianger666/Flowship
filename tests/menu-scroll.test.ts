/**
 * slash / `@` 菜单键盘高亮滚入可视区 + listbox 语义（第二轮 review V5-03）
 *
 * 病灶：菜单是 `max-h-64 overflow-y-auto`，焦点留在 contentEditable，↑↓ 只改 activeIndex、
 * 高亮项不会自己滚进来——slash 约第 6 项起、`@` 约第 9 项起超出；`↑` 从首项回绕到末项直接落在
 * 看不见处，Enter 选中的是看不见的项。全仓也没有 role="listbox" / aria-activedescendant。
 *
 * 做法：
 * - 滚动位置由纯函数 `scrollTopToReveal` 算（nearest 语义）、hook 只写**列表容器**自己的 scrollTop。
 *   不用 `scrollIntoView`：它会连带滚动所有祖先滚动容器（事件流 / 页面）——菜单 `absolute bottom-full`
 *   浮在输入岛上方，窗口矮时会把整页拽动；手动写 scrollTop 只动列表，也不依赖 jsdom / SSR 有没有这个方法。
 * - 高亮只由键盘（与结果重置到 0）改变，hover 走 CSS（`hover:bg-accent/60`）不改 activeIndex，
 *   所以「只在键盘导航时滚」天然成立、不会 hover 抖动；契约里钉住「菜单项不绑 onMouseEnter / onMouseMove」。
 * - 语义：列表 role="listbox"、选项 role="option" + aria-selected；输入框（textbox）挂
 *   aria-controls + aria-activedescendant（textbox 允许这两个属性；aria-expanded 不允许，不加）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { menuAria, optionDomId, scrollTopToReveal } from "@/lib/menu-scroll";

const readSrc = (...seg: string[]): string =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "src", ...seg),
    "utf-8",
  );

/** max-h-64 = 256px、p-1 = 4px、每项 36px 的列表几何 */
const geom = (count: number) => ({
  viewportHeight: 256,
  count,
  contentHeight: count * 36 + 8,
  itemHeight: 36,
  itemTopOf: (i: number) => 4 + i * 36,
});

const reveal = (
  g: ReturnType<typeof geom>,
  index: number,
  scrollTop: number,
): number =>
  scrollTopToReveal({
    scrollTop,
    viewportHeight: g.viewportHeight,
    itemTop: g.itemTopOf(index),
    itemHeight: g.itemHeight,
    index,
    count: g.count,
    contentHeight: g.contentHeight,
  });

describe("scrollTopToReveal：nearest 语义", () => {
  it("已完全可见 → 不动（高亮在视口内移动不抖）", () => {
    const g = geom(12);
    for (let i = 0; i <= 6; i += 1) {
      expect(reveal(g, i === 0 ? 1 : i, 0), `index ${i}`).toBe(0);
    }
  });

  it("↓ 逐项：第 7 项（下标 7）刚好溢出底部 → 对齐底边（只滚一项高）", () => {
    const g = geom(12);
    // 下标 6：top 220 bottom 256 刚好在 256 视口内
    expect(reveal(g, 6, 0)).toBe(0);
    // 下标 7：top 256 bottom 292 > 256 → scrollTop = 292 - 256
    expect(reveal(g, 7, 0)).toBe(36);
  });

  it("↑ 逐项：高亮项在视口上方 → 对齐顶边", () => {
    const g = geom(12);
    // scrollTop=100，下标 2 的 top=76 < 100
    expect(reveal(g, 2, 100)).toBe(76);
  });

  it("↑ 从首项回绕到末项：末项在看不见处 → 滚到底（含底部 padding）", () => {
    const g = geom(12);
    // 末项 top=400 bottom=436 > 256；contentHeight=440 → 440-256
    expect(reveal(g, 11, 0)).toBe(184);
  });

  it("↓ 从末项回绕到首项：滚回 0（顶部 padding 也露出来）", () => {
    const g = geom(12);
    expect(reveal(g, 0, 184)).toBe(0);
  });

  it("首项恒回 0、末项已完全可见时不动", () => {
    const g = geom(12);
    expect(reveal(g, 0, 0)).toBe(0);
    // 已经滚到底：末项完全可见 → 不动
    expect(reveal(g, 11, 184)).toBe(184);
  });

  it("未布局（视口 / 项高为 0，jsdom / SSR / display:none）→ 原样返回、不产生 NaN / 负数", () => {
    expect(
      scrollTopToReveal({
        scrollTop: 40,
        viewportHeight: 0,
        itemTop: 0,
        itemHeight: 0,
        index: 3,
        count: 5,
        contentHeight: 0,
      }),
    ).toBe(40);
    expect(
      scrollTopToReveal({
        scrollTop: 0,
        viewportHeight: 256,
        itemTop: Number.NaN,
        itemHeight: 36,
        index: 3,
        count: 5,
        contentHeight: 200,
      }),
    ).toBe(0);
  });

  it("单项 / 内容比视口矮 → 永远 0", () => {
    const g = { ...geom(1), contentHeight: 44 };
    expect(reveal(g, 0, 0)).toBe(0);
    const g3 = { ...geom(3), contentHeight: 116 };
    expect(reveal(g3, 2, 0)).toBe(0);
  });
});

describe("optionDomId / menuAria", () => {
  it("选项 id = listId + 下标，稳定可复算", () => {
    expect(optionDomId("L1", 0)).toBe("L1-opt-0");
    expect(optionDomId("L1", 7)).toBe("L1-opt-7");
  });

  it("菜单没开 → 什么属性都不挂", () => {
    expect(
      menuAria({ open: false, itemCount: 3, activeIndex: 0, listId: "L" }),
    ).toEqual({});
  });

  it("开了但没有候选（加载中 / 无匹配）→ 只挂 aria-controls，不挂指向空气的 activedescendant", () => {
    expect(
      menuAria({ open: true, itemCount: 0, activeIndex: 0, listId: "L" }),
    ).toEqual({ controls: "L" });
  });

  it("开了且有候选 → controls + activedescendant 指向当前高亮项", () => {
    expect(
      menuAria({ open: true, itemCount: 5, activeIndex: 3, listId: "L" }),
    ).toEqual({ controls: "L", activeDescendant: "L-opt-3" });
  });

  it("下标越界（候选刚缩短、activeIndex 还没重置）→ 不挂 activedescendant", () => {
    expect(
      menuAria({ open: true, itemCount: 2, activeIndex: 5, listId: "L" }),
    ).toEqual({ controls: "L" });
    expect(
      menuAria({ open: true, itemCount: 2, activeIndex: -1, listId: "L" }),
    ).toEqual({ controls: "L" });
  });
});

describe("接线源码契约", () => {
  const slash = readSrc("components", "slash-skills.tsx");
  const at = readSrc("components", "at-mention.tsx");
  const editor = readSrc("components", "composer-editor.tsx");
  const hook = readSrc("hooks", "use-active-option-scroll.ts");

  // 去掉注释再断言「代码里没有」，避免注释里的说明文字误伤
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("两个菜单都是 listbox + option + aria-selected，选项 id 走 optionDomId", () => {
    for (const [name, src] of [
      ["slash-skills", slash],
      ["at-mention", at],
    ] as const) {
      // slash 恒为 listbox；@ 菜单有「加载中 / 无匹配」两个非列表态，只在有选项时才挂 role
      expect(src, name).toMatch(/role=(\{[^}]*)?"listbox"/);
      expect(src, name).toContain('role="option"');
      expect(src, name).toMatch(/aria-selected=\{i === \w+\.activeIndex\}/);
      expect(src, name).toContain("optionDomId(");
      expect(src, name).toContain("useActiveOptionScroll(");
    }
  });

  it("滚动 hook 只写列表容器的 scrollTop、走纯函数；代码里没有 scrollIntoView", () => {
    expect(hook).toContain("scrollTopToReveal(");
    expect(hook).toContain(".scrollTop =");
    expect(stripComments(hook)).not.toContain("scrollIntoView");
    for (const src of [slash, at]) {
      expect(stripComments(src)).not.toContain("scrollIntoView");
    }
  });

  it("高亮只由键盘改：菜单项不绑 onMouseEnter / onMouseMove（hover 走 CSS，不触发滚动）", () => {
    for (const src of [slash, at]) {
      expect(src).not.toMatch(/onMouseEnter|onMouseMove|onPointerMove/);
    }
  });

  it("hook 在组件顶层调用（早于 `if (!menuOpen) return null`）——不违反 hooks 顺序", () => {
    for (const [src, marker] of [
      [slash, "export const SlashSkillMenu"],
      [at, "export const AtMentionMenu"],
    ] as const) {
      const body = src.slice(src.indexOf(marker));
      expect(body.indexOf("useActiveOptionScroll(")).toBeGreaterThan(0);
      expect(body.indexOf("useActiveOptionScroll(")).toBeLessThan(
        body.indexOf("return null"),
      );
    }
  });

  it("两个 hook 都暴露稳定 listId（useId），编辑器据此挂 aria-controls / aria-activedescendant", () => {
    expect(slash).toContain("useId()");
    expect(at).toContain("useId()");
    expect(slash).toContain("listId");
    expect(at).toContain("listId");
    expect(editor).toContain("menuAria(");
    expect(editor).toMatch(/ariaControls=\{/);
    expect(editor).toMatch(/ariaActiveDescendant=\{/);
    // textbox 不允许 aria-expanded：不加
    expect(editor).not.toContain("ariaExpanded");
  });
});
