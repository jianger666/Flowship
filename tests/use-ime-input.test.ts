/**
 * 搜索框的输入法组合态（R14 B6-3 / Q2-03）：src/hooks/use-ime-input.ts + event-stream-search-bar.tsx 接线。
 *
 * 旧行为：受控 <input onChange> 直通——拼音每敲一个字母就触发一次全量搜索并跳到第一个命中；
 * 在输入法里按 Esc（取消候选词）还会把整个搜索框关掉、查询词清空。
 * 新行为：组合期间输入框显示草稿、一次都不向外上报，上屏后报一次最终值；组合中的 Esc 交给输入法。
 *
 * 仓里没有 jsdom：hook 用 tests/helpers/react-hook-stub.ts 的槽位桩真跑（它能看到 useRef / useState 的真实读写），
 * 事件对象用最小形状（hook 只读 target.value / currentTarget.value / nativeEvent.isComposing）。
 * 显示值（组合中是草稿）可以直接从 render 的返回值读；输入框真的显示什么、IME 候选框会不会被打断，
 * 只有真机能看——这里没有。
 *
 * ⚠ 真实事件序（Chromium：input 先于 compositionend；Safari：compositionend 先于最后一个 input）按规范推断，没有真机验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChangeEvent, CompositionEvent } from "react";
import { describe, expect, it } from "vitest";

import { useImeInput } from "@/hooks/use-ime-input";

import { createHookHarness } from "./helpers/react-hook-stub";

const change = (value: string, isComposing = false) =>
  ({ target: { value }, nativeEvent: { isComposing } }) as unknown as ChangeEvent<HTMLInputElement>;
const compositionEnd = (value: string) =>
  ({ currentTarget: { value } }) as unknown as CompositionEvent<HTMLInputElement>;

/** 一个「父组件持有 query」的最小场景：onCommit 记下上报并把值写回（= 受控父组件 setState） */
const mount = (initial = "") => {
  const h = createHookHarness();
  const box = { value: initial, commits: [] as string[] };
  const onCommit = (v: string) => {
    box.commits.push(v);
    box.value = v;
  };
  /** 一次 render + 跑 effect（和真 React 一样：commit 之后才同步「上次上报值」） */
  const render = () => {
    const api = h.render(() => useImeInput({ value: box.value, onCommit }));
    h.flushEffects();
    return api;
  };
  return { h, box, render };
};

describe("useImeInput 行为", () => {
  it("非组合输入：每次变化直通上报，显示值就是外部值", () => {
    const { box, render } = mount();
    let api = render();
    api.onChange(change("a"));
    api = render();
    api.onChange(change("ab"));
    api = render();
    expect(box.commits).toEqual(["a", "ab"]);
    expect(api.value).toBe("ab");
  });

  it("组合中（compositionstart 之后）：每个拼音字母都不上报，输入框显示草稿；上屏后只报一次最终值", () => {
    const { box, render } = mount();
    let api = render();
    api.onCompositionStart();
    api.onChange(change("n", true));
    api = render();
    expect(api.value).toBe("n"); // 显示草稿：受控回写不会把输入法正在编辑的拼音冲掉
    api.onChange(change("ni", true));
    api = render();
    expect(api.value).toBe("ni");
    expect(box.commits).toEqual([]);
    api.onCompositionEnd(compositionEnd("你"));
    expect(box.commits).toEqual(["你"]);
    api = render();
    expect(api.value).toBe("你"); // 草稿清掉，回到外部值
  });

  it("只有 input 事件自带的 isComposing、没有 compositionstart：同样不上报", () => {
    const { box, render } = mount();
    let api = render();
    api.onChange(change("n", true));
    api = render();
    expect(box.commits).toEqual([]);
    expect(api.value).toBe("n");
  });

  it("有 compositionstart 之后，即使 input 事件自带的 isComposing 是 false（有的内核 / 事件序如此）也仍按组合中处理：组合标记以 ref 为准，不只信事件自带的信号", () => {
    const { box, render } = mount();
    let api = render();
    api.onCompositionStart();
    api.onChange(change("n", false));
    api = render();
    expect(box.commits).toEqual([]);
    expect(api.value).toBe("n");
  });

  it("只靠 isComposing 判组合的情形（没有 compositionstart / end）：组合信号一消失，草稿就被清掉、值照常上报，显示的是外部值而不是旧草稿", () => {
    const { box, render } = mount();
    let api = render();
    api.onChange(change("n", true));
    api = render();
    expect(api.value).toBe("n");
    api.onChange(change("你", false)); // 没有 compositionend（部分输入法不发），组合信号直接消失
    api = render();
    expect(box.commits).toEqual(["你"]);
    expect(api.value).toBe("你");
  });

  it("Chromium 事件序（input 先、compositionend 后）：只上报一次", () => {
    const { box, render } = mount();
    const api = render();
    api.onCompositionStart();
    api.onChange(change("你", true));
    api.onCompositionEnd(compositionEnd("你"));
    expect(box.commits).toEqual(["你"]);
  });

  it("Safari 事件序（compositionend 先、最后一个 input 后，且那个 input 已不是组合态）：同值不重复上报", () => {
    const { box, render } = mount();
    let api = render();
    api.onCompositionStart();
    api.onChange(change("ni", true));
    api.onCompositionEnd(compositionEnd("你"));
    api = render();
    api.onChange(change("你", false));
    expect(box.commits).toEqual(["你"]);
  });

  it("组合结束后组合标记复位：之后的普通输入照常上报，不会一直被当成组合中", () => {
    const { box, render } = mount();
    let api = render();
    api.onCompositionStart();
    api.onChange(change("ni", true));
    api.onCompositionEnd(compositionEnd("你"));
    api = render();
    api.onChange(change("你好", false));
    api = render();
    expect(box.commits).toEqual(["你", "你好"]);
    expect(api.value).toBe("你好");
  });

  it("组合结束时的值与上次上报值相同（上屏的就是原文）：不重复上报", () => {
    const { box, render } = mount("x");
    let api = render();
    api.onCompositionStart();
    api.onChange(change("xn", true));
    api.onChange(change("x", true));
    api.onCompositionEnd(compositionEnd("x"));
    api = render();
    expect(box.commits).toEqual([]);
    expect(api.value).toBe("x");
  });

  it("外部值变了（别处清空 / 改写）要跟着对齐：之后再输入同一个字，不能被去重吞掉", () => {
    const { box, render } = mount();
    let api = render();
    api.onChange(change("a"));
    api = render(); // value = "a"，effect 把「上次上报值」对齐成 "a"
    box.value = ""; // 外部清空（例如搜索被重置）
    api = render(); // value = ""，effect 对齐成 ""
    api.onChange(change("a"));
    expect(box.commits).toEqual(["a", "a"]);
  });

  it("去重的记忆在 hook 自己手里、不依赖外部值回写 / effect：初值取外部值，上报后记下上报值（两个事件之间 effect 还没跑也不重复报）", () => {
    const h = createHookHarness();
    const commits: string[] = [];
    // 故意不 flushEffects：模拟「两个事件之间 React 还没来得及对齐外部值」，只剩 hook 自己的记忆在起作用
    const api = h.render(() => useImeInput({ value: "x", onCommit: (v) => commits.push(v) }));
    api.onChange(change("x")); // 与初值相同：不报
    api.onChange(change("y"));
    api.onChange(change("y")); // 与刚报过的相同：不报
    expect(commits).toEqual(["y"]);
  });

  it("组合期间多次变化后取消（compositionend 带回原值）：不上报", () => {
    const { box, render } = mount("abc");
    const api = render();
    api.onCompositionStart();
    api.onChange(change("abcn", true));
    api.onChange(change("abcni", true));
    api.onCompositionEnd(compositionEnd("abc"));
    expect(box.commits).toEqual([]);
  });

  it("组合状态跟着 hook 实例走：一个实例停在「组合中」，不影响另一个新实例（输入框卸载重挂后不会残留成一直在组合）", () => {
    const first = mount();
    first.render().onCompositionStart(); // 没等到 compositionend 就被卸载
    first.h.unmount();
    const second = mount();
    const api = second.render();
    api.onChange(change("a"));
    expect(second.box.commits).toEqual(["a"]);
  });

  it("组合中的草稿只在 hook 内部：父组件的 value 在组合期间一直是上屏前的值", () => {
    const { box, render } = mount("old");
    let api = render();
    api.onCompositionStart();
    api.onChange(change("oldn", true));
    api = render();
    expect(api.value).toBe("oldn");
    expect(box.value).toBe("old");
  });

  it("返回的四个绑定都是可直接挂到 <input> 上的东西", () => {
    const { render } = mount();
    const api = render();
    expect(typeof api.value).toBe("string");
    expect(typeof api.onChange).toBe("function");
    expect(typeof api.onCompositionStart).toBe("function");
    expect(typeof api.onCompositionEnd).toBe("function");
  });
});

describe("event-stream-search-bar.tsx 接线契约", () => {
  const readSrc = (rel: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");
  /** 剥掉注释再查代码本身（注释里要解释「为什么」，不该因此误报） */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = stripComments(readSrc("src/components/tasks/event-stream-search-bar.tsx"));
  const innerStart = code.indexOf("const SearchInput = (");
  const outerStart = code.indexOf("export const EventStreamSearchBar");
  const inner = code.slice(innerStart, outerStart);
  const outer = code.slice(outerStart);

  it("查询词不再直通 onChange（改前是 onChange={(e) => onQueryChange(e.target.value)}）", () => {
    expect(code).not.toContain("onChange={(e) => onQueryChange(e.target.value)}");
    expect(code).not.toMatch(/onChange=\{\(e\) => onQueryChange\(/);
  });

  it("输入框抽成 SearchInput 子组件：hook 与 <Input> 都只在它里面（栏收起时输入框卸载、组合标记随之清掉）", () => {
    expect(innerStart).toBeGreaterThan(-1);
    expect(outerStart).toBeGreaterThan(innerStart);
    expect(inner).toContain("useImeInput({ value: query, onCommit: onQueryChange })");
    expect(inner).toContain("<Input");
    expect(outer).not.toContain("useImeInput(");
    expect(outer).not.toContain("<Input");
    expect(outer).toContain("<SearchInput");
  });

  it("子组件把 hook 的四个绑定都挂上去了", () => {
    expect(inner).toContain("value={ime.value}");
    expect(inner).toContain("onChange={ime.onChange}");
    expect(inner).toContain("onCompositionStart={ime.onCompositionStart}");
    expect(inner).toContain("onCompositionEnd={ime.onCompositionEnd}");
  });

  it("Esc 也判输入法（组合中的 Esc 是取消候选词、不是关搜索）；Enter 原有的判断不变", () => {
    expect(code).toMatch(/if \(e\.key !== "Escape" \|\| isImeComposing\(e\)\) return;/);
    expect(code).toMatch(/e\.key === "Enter" && !isImeComposing\(e\)/);
    expect(code.match(/isImeComposing\(e\)/g)?.length).toBe(2);
  });

  it("仍从 @/lib/ime 单导出 isImeComposing（ime-enter-contract 的口径）；hook 没有塞进 lib/ime", () => {
    expect(code).toMatch(/import \{ isImeComposing \} from "@\/lib\/ime"/);
    const imeLib = readSrc("src/lib/ime.ts");
    expect(imeLib).not.toContain("useImeInput");
    expect(imeLib).not.toContain("onCompositionEnd");
  });
});
