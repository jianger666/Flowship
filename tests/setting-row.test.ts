/**
 * SettingRow（src/components/ui/setting-row.tsx）的行为契约：补充说明 `detail` 的 ⓘ + 行内 Switch 的无障碍接线。
 *
 * 背景（2026-11-24 用户：「设置页太乱了……一大串一大串的字去掉」）：
 *   - 每项说明只留一句 `hint`，放不下的背景 / 边界 / 风险细节进 `detail`——名称后面一个 ⓘ，悬停 / 聚焦才出气泡；
 *   - 以前行里的开关没有 aria-label，读屏只会念「开关」，名称和说明与它没有 DOM 关联。现在 SettingRow 用 React context
 *     把「名称节点 id / 说明节点 id」递给里面的 Switch，Switch 没显式写名字时自动 labelledby / describedby。
 *
 * 用 SSR 看真实输出。气泡（Tooltip 的 Popup）要悬停才挂载，SSR 里看不到——所以「气泡里有什么」由数据文件的契约测试管
 * （browser-settings-copy.test.ts），这里只管 ⓘ 触发器和接线。看不到真实视觉效果，那一步要在 Electron 里手点。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";

type RowProps = Parameters<typeof SettingRow>[0];
type SwitchProps = Parameters<typeof Switch>[0];

const sw = (props: Partial<SwitchProps> = {}) =>
  createElement(Switch, { checked: false, onCheckedChange: () => undefined, ...props });

const row = (props: Partial<RowProps> = {}, switchProps: Partial<SwitchProps> = {}) =>
  renderToStaticMarkup(createElement(SettingRow, { label: "测试项", control: sw(switchProps), ...props }));

/** role="switch" 根节点的开标签 */
const rootTag = (html: string) => /<[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
/** 标签上某个属性的值（没有该属性 → undefined） */
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 带 id=<id> 的那个元素里的纯文字（元素内没有子标签时） */
const textOfId = (html: string, id: string) => new RegExp(`id="${esc(id)}"[^>]*>([^<]*)<`).exec(html)?.[1];
const countOfId = (html: string, id: string) => html.split(`id="${id}"`).length - 1;

describe("SettingRow detail：名称后的 ⓘ", () => {
  it("不给 detail：不渲染 ⓘ，名称节点还是一个带 id 的 div（没用到 detail 的老行与改版前结构一致）", () => {
    const html = row({ hint: "一句话" });
    expect(html).not.toContain("更多说明");
    expect(html).not.toContain("<button");
    expect(html).toMatch(/<div id="[^"]+" class="text-sm">测试项<\/div>/);
  });

  it("给 detail：名称后面多一个可聚焦的 <button>，读屏名字是「<名称>：更多说明」，图标 aria-hidden", () => {
    const html = row({ hint: "一句话", detail: "补充说明" });
    expect(html).toMatch(/<button[^>]*type="button"/); // 不会误触发表单提交
    expect(html).toMatch(/<button[^>]*aria-label="测试项：更多说明"/);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    // 气泡悬停才挂载，所以气泡里那份 detail 在 SSR 里没有；但 detail 现在另有一份常驻的 sr-only 文本（S-3，见下面的专门用例）
  });

  it("S-3 detail 在 SSR 里只出现一次：在 sr-only 容器里、且被 ⓘ 的 aria-describedby 引用；可见文字（名称 / hint / 按钮）里没有它", () => {
    const html = row({ hint: "一句话", detail: "补充说明" });
    expect(html.split("补充说明").length - 1).toBe(1);
    const srId = /<span id="([^"]+)" class="sr-only">补充说明<\/span>/.exec(html)?.[1];
    expect(srId).toBeTruthy();
    const btn = /<button[^>]*>/.exec(html)![0];
    expect(attr(btn, "aria-describedby")).toBe(srId);
    // 唯一 id：整页里这个 id 只出现一次（被引用的是 id=，不是别的节点）
    expect(countOfId(html, srId!)).toBe(1);
    // 可见文字：把 sr-only 容器整个去掉之后，页面上不再有 detail
    expect(html.replace(/<span id="[^"]+" class="sr-only">[^<]*<\/span>/, "")).not.toContain("补充说明");
  });

  it("S-3 sr-only 的 detail 不进开关的名字 / 说明：开关的 labelledby 只指名称、describedby 只指 hint", () => {
    const html = row({ hint: "一句话", detail: "补充说明" });
    const tag = rootTag(html);
    const srId = /<span id="([^"]+)" class="sr-only">补充说明<\/span>/.exec(html)![1]!;
    expect(attr(tag, "aria-labelledby")).not.toBe(srId);
    expect(attr(tag, "aria-describedby")).not.toBe(srId);
    expect(textOfId(html, attr(tag, "aria-describedby")!)).toBe("一句话");
  });

  it("S-3 同一页多个带 detail 的行：sr-only 的 id 互不相同（useId 派生），各行 ⓘ 指向自己那一份", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(SettingRow, { label: "第一项", hint: "说明一", detail: "细节一", control: sw() }),
        createElement(SettingRow, { label: "第二项", hint: "说明二", detail: "细节二", control: sw() }),
      ),
    );
    const ids = [...html.matchAll(/<span id="([^"]+)" class="sr-only">(细节[一二])<\/span>/g)];
    expect(ids).toHaveLength(2);
    expect(ids[0]![1]).not.toBe(ids[1]![1]);
    const btns = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(btns.map((b) => attr(b, "aria-describedby"))).toEqual([ids[0]![1], ids[1]![1]]);
  });

  it("S-3 ⓘ 的可点区域放大（size-6，用负外边距抵消、行高不变）；图标仍是 size-3.5", () => {
    const html = row({ hint: "一句话", detail: "补充说明" });
    const btn = /<button[^>]*>/.exec(html)![0];
    expect(attr(btn, "class")).toMatch(/\bsize-6\b/);
    expect(attr(btn, "class")).toMatch(/(^|\s)-m-1(\s|$)/);
    expect(html).toMatch(/<svg[^>]*class="[^"]*\bsize-3\.5\b/);
  });

  it("detail 为空串 / 不给 → 都不渲染 ⓘ（没有内容的气泡是个空壳）", () => {
    expect(row({ detail: "" })).not.toContain("更多说明");
    expect(row({ detail: undefined })).not.toContain("更多说明");
  });

  it("名称节点里只有名称：ⓘ 的「更多说明」不会被念进开关的名字", () => {
    const html = row({ hint: "一句话", detail: "补充说明" });
    const labelledBy = attr(rootTag(html), "aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(textOfId(html, labelledBy!)).toBe("测试项");
  });

  it("hint 仍常驻可见（风险 / 默认值这类做决定必须看到的词不进气泡）", () => {
    expect(row({ hint: "默认关闭；风险高", detail: "细节" })).toContain("默认关闭；风险高");
  });
});

describe("SettingRow 里的 Switch：名称 / 说明自动接线", () => {
  it("没写 aria-label：aria-labelledby 指向名称节点、aria-describedby 指向说明节点，id 各出现一次", () => {
    const html = row({ hint: "一句话" });
    const tag = rootTag(html);
    const labelledBy = attr(tag, "aria-labelledby");
    const describedBy = attr(tag, "aria-describedby");
    expect(labelledBy, tag).toBeTruthy();
    expect(describedBy, tag).toBeTruthy();
    expect(labelledBy).not.toBe(describedBy);
    expect(countOfId(html, labelledBy!)).toBe(1);
    expect(countOfId(html, describedBy!)).toBe(1);
    expect(textOfId(html, labelledBy!)).toBe("测试项");
    expect(textOfId(html, describedBy!)).toBe("一句话");
    expect(attr(tag, "aria-label")).toBeUndefined();
  });

  it("stacked 形态同样接线", () => {
    const html = row({ hint: "一句话", stacked: true });
    const tag = rootTag(html);
    expect(textOfId(html, attr(tag, "aria-labelledby")!)).toBe("测试项");
    expect(textOfId(html, attr(tag, "aria-describedby")!)).toBe("一句话");
  });

  it("没有 hint：只挂 labelledby，不挂一个指向不存在节点的 describedby", () => {
    const tag = rootTag(row({}));
    expect(attr(tag, "aria-labelledby")).toBeTruthy();
    expect(attr(tag, "aria-describedby")).toBeUndefined();
  });

  it("显式写了 aria-label：它优先，不再挂 labelledby（否则会盖掉它）；说明仍然挂上", () => {
    const html = row({ hint: "一句话" }, { "aria-label": "显式名字" });
    const tag = rootTag(html);
    expect(attr(tag, "aria-label")).toBe("显式名字");
    expect(attr(tag, "aria-labelledby")).toBeUndefined();
    expect(textOfId(html, attr(tag, "aria-describedby")!)).toBe("一句话");
  });

  it("显式写的 aria-labelledby / aria-describedby 优先于行的接线", () => {
    const tag = rootTag(
      row({ hint: "一句话" }, { "aria-labelledby": "my-label", "aria-describedby": "my-desc" }),
    );
    expect(attr(tag, "aria-labelledby")).toBe("my-label");
    expect(attr(tag, "aria-describedby")).toBe("my-desc");
  });

  // R20-13：风险披露不在 hint 里、而在行外另起一段话时（「锁屏时也能用」下面那段），开关用 extraDescribedBy 把它**追加**进说明，一起念
  describe("extraDescribedBy：追加说明节点，不顶掉行的 hint / 显式 aria-describedby", () => {
    const ids = (tag: string) => (attr(tag, "aria-describedby") ?? "").split(" ").filter(Boolean);

    it("在行里：describedby = 「行的 hint 节点 + 追加的节点」，hint 在前；两个 id 都指向真实存在的节点", () => {
      const html = renderToStaticMarkup(
        createElement(
          "div",
          null,
          createElement(SettingRow, { label: "测试项", hint: "一句话", control: sw({ extraDescribedBy: "extra-risk" }) }),
          createElement("p", { id: "extra-risk" }, "行外的风险说明"),
        ),
      );
      const [hintId, extraId, ...rest] = ids(rootTag(html));
      expect(rest).toEqual([]);
      expect(extraId).toBe("extra-risk");
      expect(textOfId(html, hintId!)).toBe("一句话");
      expect(textOfId(html, extraId!)).toBe("行外的风险说明");
      expect(countOfId(html, extraId!)).toBe(1);
    });

    it("显式写了 aria-describedby：它仍优先于行的 hint，追加的接在它后面", () => {
      const tag = rootTag(row({ hint: "一句话" }, { "aria-describedby": "my-desc", extraDescribedBy: "extra-risk" }));
      expect(ids(tag)).toEqual(["my-desc", "extra-risk"]);
    });

    it("这一行没有 hint：只有追加的那个（不留一个指向空气的 id、也没有多余空格）", () => {
      const tag = rootTag(row({}, { extraDescribedBy: "extra-risk" }));
      expect(attr(tag, "aria-describedby")).toBe("extra-risk");
    });

    it("不在 SettingRow 里：只有追加的那个", () => {
      const tag = rootTag(renderToStaticMarkup(sw({ "aria-label": "单独用", extraDescribedBy: "extra-risk" })));
      expect(attr(tag, "aria-describedby")).toBe("extra-risk");
    });

    it("不给 extraDescribedBy：与以前逐字一致（上面那些既有用例已钉；这里再确认没有残留的尾随空格）", () => {
      const tag = rootTag(row({ hint: "一句话" }));
      expect(attr(tag, "aria-describedby")).not.toMatch(/\s/);
      expect(rootTag(row({}))).not.toContain("aria-describedby");
    });
  });

  it("同一页多个设置行：id 互不相同（useId），一行的开关不会指到另一行的名称", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(SettingRow, { label: "第一项", hint: "说明一", control: sw() }),
        createElement(SettingRow, { label: "第二项", hint: "说明二", control: sw() }),
      ),
    );
    const tags = [...html.matchAll(/<[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(2);
    const [a, b] = tags.map((t) => ({ l: attr(t, "aria-labelledby")!, d: attr(t, "aria-describedby")! }));
    expect(new Set([a.l, a.d, b.l, b.d]).size).toBe(4);
    expect(textOfId(html, a.l)).toBe("第一项");
    expect(textOfId(html, b.l)).toBe("第二项");
    expect(textOfId(html, a.d)).toBe("说明一");
    expect(textOfId(html, b.d)).toBe("说明二");
  });
});

describe("不在 SettingRow 里的 Switch：不凭空多出关联属性", () => {
  it("没有 labelledby / describedby（旁边的文字和它没有 DOM 关联，要自己写 aria-label）", () => {
    const tag = rootTag(renderToStaticMarkup(sw({ "aria-label": "单独用" })));
    expect(attr(tag, "aria-label")).toBe("单独用");
    expect(attr(tag, "aria-labelledby")).toBeUndefined();
    expect(attr(tag, "aria-describedby")).toBeUndefined();
  });
});

describe("SettingRow 的 context 值：引用稳定（S-8g）", () => {
  // SSR 一次渲染看不出引用是否稳定，所以钉源码结构：Provider 的 value 必须来自 useMemo，不能是行内新建的对象字面量
  const src = readFileSync(path.resolve(import.meta.dirname, "../src/components/ui/setting-row.tsx"), "utf8");

  it("value 用 useMemo 以 [labelId, hintId] 稳定下来，Provider 不再写 value={{ … }}", () => {
    expect(src).toMatch(/const a11y = useMemo\(\(\) => \(\{ labelId, hintId \}\), \[labelId, hintId\]\)/);
    expect(src).toMatch(/<SettingRowA11yContext\.Provider value=\{a11y\}>/);
    expect(src).not.toMatch(/Provider value=\{\{/);
  });
});
