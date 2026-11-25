/**
 * 设置页左侧锚点导航的契约（src/app/settings/page.tsx）。
 *
 * 设置页是「一页长滚动 + 左侧锚点导航」，不是切页签：每张组卡包一层 `wrapCard("<id>", …)`（DOM id = card-<id>），
 * 导航 `NAV_ITEMS` 点击滚到对应的卡、滚动时按 IntersectionObserver 高亮当前卡。
 *
 * 以前「内置浏览器」「电脑操作」两张卡有 wrapCard 的 id、却不在 NAV_ITEMS 里：滚到它们时导航高亮停在「偏好」，也没法点过去
 * （2026-11-24 用户问「浏览器是不是可以单独一个 tab」）。这里钉住「卡与导航项一一对应、顺序一致」，下次再加一张卡忘了加导航会红。
 * 纯源码契约（页面本身要 Electron / 浏览器里才能点——滚动高亮的真实效果没法在这里验）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(path.resolve(import.meta.dirname, "../src/app/settings/page.tsx"), "utf8");

const navBlock = /const NAV_ITEMS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(page)?.[1] ?? "";
const nav = [...navBlock.matchAll(/\{\s*focus:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"\s*\}/g)].map((m) => ({
  focus: m[1]!,
  label: m[2]!,
}));
const cardIds = [...page.matchAll(/\bwrapCard\(\s*"([^"]+)"/g)].map((m) => m[1]!);

const legacyBlock = /const LEGACY_FOCUS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(page)?.[1] ?? "";
const legacy = [...legacyBlock.matchAll(/^\s*(?:"([^"]+)"|([\w-]+)):\s*"([^"]+)",?\s*$/gm)].map((m) => ({
  from: (m[1] ?? m[2])!,
  to: m[3]!,
}));

describe("设置页导航：卡与导航项一一对应", () => {
  it("提取到了导航表和组卡（别让下面的断言空转）", () => {
    expect(nav.length).toBeGreaterThanOrEqual(5);
    expect(cardIds.length).toBeGreaterThanOrEqual(5);
  });

  it("导航项 = 页面上的组卡，数量、取值、自上而下的顺序都一致", () => {
    expect(nav.map((n) => n.focus)).toEqual(cardIds);
  });

  it("「内置浏览器」「电脑操作」各有独立入口，且在「偏好」之后、「仓库」之前", () => {
    const ids = nav.map((n) => n.focus);
    for (const id of ["browser", "computer-use"]) expect(ids, id).toContain(id);
    expect(ids.indexOf("browser")).toBeGreaterThan(ids.indexOf("prefs"));
    expect(ids.indexOf("computer-use")).toBeGreaterThan(ids.indexOf("browser"));
    expect(ids.indexOf("repos")).toBeGreaterThan(ids.indexOf("computer-use"));
    expect(nav.find((n) => n.focus === "browser")?.label).toBe("内置浏览器");
    expect(nav.find((n) => n.focus === "computer-use")?.label).toBe("电脑操作");
  });

  it("导航项没有重复的取值 / 标签", () => {
    expect(new Set(nav.map((n) => n.focus)).size).toBe(nav.length);
    expect(new Set(nav.map((n) => n.label)).size).toBe(nav.length);
  });

  it("旧深链（?focus=api-key / feishu / git / env / profile / preference）都落在真实存在的卡上", () => {
    expect(legacy.length).toBeGreaterThan(0);
    const ids = new Set(nav.map((n) => n.focus));
    for (const { from, to } of legacy) expect(ids.has(to), `?focus=${from} → ${to}`).toBe(true);
  });
});
