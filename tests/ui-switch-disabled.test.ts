/**
 * Switch（src/components/ui/switch.tsx）禁用态样式的行为契约（「电脑操作」设置卡第四轮评审 B3）。
 *
 * Base UI 的 Switch.Root 渲染的是 `<span role="switch">`（外加一个隐藏的 checkbox input），不是原生 <button> / <input>：
 * 禁用态只体现在 `aria-disabled` 与 `data-disabled` 上，span 上没有 `disabled` 属性，Tailwind 的 `disabled:`（即 `:disabled` 伪类）
 * 永远匹配不上——禁用了却仍是手型、也没变淡，用户看不出它点不动。所以样式必须挂在 `data-disabled:` 上
 * （dropdown-menu / context-menu / select 等其它 Base UI 封装同款）。
 *
 * 这里用 SSR 看真实输出：先钉「前提」（根是 span、禁用态走 data-disabled，Base UI 升级若改了会在这里提醒），再钉「样式挂对了属性」。
 * 没有 DOM，看不到真实渲染出来的视觉效果——那一步要在 Electron 里手点。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Switch } from "@/components/ui/switch";

const markup = (props: Partial<Parameters<typeof Switch>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(Switch, { checked: false, onCheckedChange: () => undefined, "aria-label": "测试开关", ...props }),
  );

/** role="switch" 那个根节点的开标签（含全部属性） */
const rootTag = (html: string) => /<[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
/**
 * 标签上有没有名叫 name 的**属性**（属性名前是空白、后面是 = / 空白 / > ）。
 * 不能用子串匹配：class 里的 `data-disabled:opacity-50` 变体类名也含 data-disabled 这几个字
 */
const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(=|\\s|/|>)`).test(tag);
/** 根节点 class 拆成单个类名 */
const rootClasses = (html: string) => (/class="([^"]*)"/.exec(rootTag(html))?.[1] ?? "").split(/\s+/).filter(Boolean);

describe("Switch 禁用态：样式挂在 Base UI 真正会设置的属性上", () => {
  it("前提：根节点是 span（不是原生 button / input）——禁用态走 data-disabled / aria-disabled，没有 disabled 属性", () => {
    const off = rootTag(markup({ disabled: true }));
    expect(off.startsWith("<span"), off).toBe(true);
    expect(off).toContain('aria-disabled="true"');
    expect(hasAttr(off, "data-disabled"), off).toBe(true);
    expect(hasAttr(off, "disabled"), "span 上不会有 disabled 属性，所以 :disabled 伪类匹配不上").toBe(false);
  });

  it("启用态：既没有 data-disabled 也没有 aria-disabled 属性（样式不会误伤可用的开关）", () => {
    const on = rootTag(markup({ disabled: false }));
    expect(hasAttr(on, "data-disabled"), on).toBe(false);
    expect(hasAttr(on, "aria-disabled"), on).toBe(false);
  });

  it("样式用 data-disabled: 变体（禁用时不再显示手型、变淡），不用匹配不上的裸 disabled: 变体", () => {
    const classes = rootClasses(markup({ disabled: true }));
    expect(classes).toContain("data-disabled:cursor-not-allowed");
    expect(classes).toContain("data-disabled:opacity-50");
    expect(
      classes.filter((c) => c.startsWith("disabled:")),
      "裸 disabled: 在 span 上永远不生效",
    ).toEqual([]);
  });

  it("外部传入的 className 照常合并，不被禁用态样式吞掉", () => {
    const classes = rootClasses(markup({ disabled: true, className: "ml-2" }));
    expect(classes).toContain("ml-2");
    expect(classes).toContain("data-disabled:opacity-50");
  });
});
