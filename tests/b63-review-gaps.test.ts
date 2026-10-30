/**
 * R14 B6-3 审查 AI 补洞用例（独立变异里存活的接线 / 边界项）。
 *
 * 背景：B6-3 的接线测试只钉了「SearchInput 把 hook 的四个绑定挂上去」，没钉 onKeyDown / ref / placeholder / aria-label / className
 * 的透传；也没钉「pauseForHit 排在『没命中就 return』的守卫之后」「灰字里的数字是被跳过的数」「未来时间戳不算 30 天未活跃」
 * 「组合中把拼音删成空串，显示值仍是空串」。这些东西改坏后，原有用例全绿（审查 AI 变异 K1 K2 K4–K9 K11 K12 K18 K24–K26 存活）。
 *
 * 本文件：
 *   ① 搜索栏——用 tests/helpers/react-hook-stub.ts 把 EventStreamSearchBar → SearchInput 两层函数真跑一遍，
 *      从最终的 <Input> 元素上取 onKeyDown / ref / placeholder / aria-label / className / onChange，
 *      直接按键、直接断言回调（Enter / Shift+Enter / Esc / 输入法里的 Enter、Esc / 输入与上屏）；
 *   ② 事件流 reveal effect：pauseForHit 排在「没命中就 return」的守卫之后（源码契约——事件流整页没有 DOM 环境可跑）；
 *   ③ 会话页灰字：数字取 getStaleProtectedCount()（被跳过的数），不是 getStaleChats().length（将选中的数）；
 *   ④ sessions-filter：未来时间戳（时钟回拨 / 跨机器同步）的会话不算「30 天未活跃」；
 *   ⑤ useImeInput：组合中把拼音删成空串，显示值仍是 ""，不弹回外部旧查询词；
 *   ⑥ 归档灰条：恢复按钮不是告警红；布局类名（shrink-0 / min-w-0 flex-1）。
 *
 * 判为等价、不补用例的存活项：K10（handleSearchClose 里两句同步调用对调，同一个事件处理函数内、状态批处理，顺序不可观察）、
 * K17（对齐「上次上报值」的 effect 去掉依赖数组：每次渲染多对齐一次，而 value 没变时对齐结果不变）、
 * K23（<Button> 的 type="button"：Base UI 的 useButton 对原生 button 本来就默认 type="button"）。
 *
 * ⚠ 仍然没有真机：键盘事件用最小对象；真实 IME 事件序、焦点、布局观感都没验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  Children,
  isValidElement,
  type ChangeEvent,
  type CompositionEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";

import { ArchivedBar } from "@/components/tasks/archived-bar";
import { EventStreamSearchBar } from "@/components/tasks/event-stream-search-bar";
import { Button } from "@/components/ui/button";
import { useImeInput } from "@/hooks/use-ime-input";
import {
  CHAT_STALE_MS,
  countProtectedStaleChats,
  pickStaleChatSessions,
} from "@/lib/sessions-filter";

import { createHookHarness } from "./helpers/react-hook-stub";

const readSrc = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");
/** 剥掉注释再查代码本身（与 use-ime-input.test.ts 同口径） */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

type El = ReactElement<Record<string, unknown>>;

/** 递归找出元素树里所有满足条件的元素（不渲染，只看 React 元素） */
const findAll = (node: ReactNode, pred: (el: El) => boolean): El[] => {
  const out: El[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as El;
    if (pred(el)) out.push(el);
    Children.forEach(el.props.children as ReactNode, walk);
  };
  walk(node);
  return out;
};

// ───────────────────────── ① 搜索栏：从最终的 <Input> 元素上按键 / 输入 ─────────────────────────

type BarProps = Parameters<typeof EventStreamSearchBar>[0];

const keyEvent = (init: Record<string, unknown> = {}) => ({
  key: "",
  shiftKey: false,
  keyCode: 0,
  nativeEvent: { isComposing: false },
  preventDefault: vi.fn(),
  ...init,
});
type KeyEv = ReturnType<typeof keyEvent>;

const typed = (value: string, isComposing = false) =>
  ({ target: { value }, nativeEvent: { isComposing } }) as unknown as ChangeEvent<HTMLInputElement>;
const compositionEnd = (value: string) =>
  ({ currentTarget: { value } }) as unknown as CompositionEvent<HTMLInputElement>;

/**
 * 把 EventStreamSearchBar（外层）和它渲染出来的 SearchInput（内层）各真跑一遍，返回最终 <Input> 的 props 读取器。
 * 内层用同一个 harness 反复 render，hook 槽位（草稿 / 组合标记）跨 render 保留。
 */
const mountBar = (over: Partial<BarProps> = {}) => {
  const input = { blur: vi.fn(), focus: vi.fn() };
  const ref = { current: input as unknown as HTMLInputElement };
  const cb = {
    onActivate: vi.fn(),
    onQueryChange: vi.fn(),
    onClose: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
  };
  const props: BarProps = {
    active: true,
    query: "",
    hitIndex: 0,
    hitCount: 3,
    inputRef: ref,
    ...cb,
    ...over,
  };
  const outer = createHookHarness().render(() => EventStreamSearchBar(props));
  const searchInputs = findAll(
    outer,
    (el) =>
      typeof el.type === "function" &&
      (el.type as { name?: string }).name === "SearchInput",
  );
  expect(searchInputs, "外层没渲染出恰好一个 SearchInput").toHaveLength(1);
  const searchInput = searchInputs[0];
  const innerHarness = createHookHarness();
  /** 每次 render 返回 SearchInput 渲染出的 <Input> 元素 */
  const renderInput = (): El =>
    innerHarness.render(() =>
      (searchInput.type as (p: unknown) => ReactElement)(searchInput.props),
    ) as El;
  return { props, ref, input, cb, renderInput };
};

const press = (inputEl: El, init: Record<string, unknown>): KeyEv => {
  const e = keyEvent(init);
  (inputEl.props.onKeyDown as (ev: KeyEv) => void)(e);
  return e;
};

describe("搜索栏：<Input> 的键盘（审查 AI 补洞：K1 K7）", () => {
  it("Enter = 下一个、Shift+Enter = 上一个，都拦掉默认行为", () => {
    const m = mountBar();
    const inputEl = m.renderInput();
    const e1 = press(inputEl, { key: "Enter" });
    expect(m.cb.onNext).toHaveBeenCalledTimes(1);
    expect(m.cb.onPrev).not.toHaveBeenCalled();
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    const e2 = press(inputEl, { key: "Enter", shiftKey: true });
    expect(m.cb.onPrev).toHaveBeenCalledTimes(1);
    expect(m.cb.onNext).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("输入法选词中的 Enter（isComposing / keyCode 229 两种信号）不跳命中", () => {
    const m = mountBar();
    const inputEl = m.renderInput();
    press(inputEl, { key: "Enter", nativeEvent: { isComposing: true } });
    press(inputEl, { key: "Enter", keyCode: 229 });
    press(inputEl, { key: "Enter", isComposing: true });
    expect(m.cb.onNext).not.toHaveBeenCalled();
    expect(m.cb.onPrev).not.toHaveBeenCalled();
  });

  it("Esc = 关搜索并让输入框失焦，拦掉默认行为", () => {
    const m = mountBar();
    const e = press(m.renderInput(), { key: "Escape" });
    expect(m.cb.onClose).toHaveBeenCalledTimes(1);
    expect(m.input.blur).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("输入法里的 Esc（取消候选词）不关搜索、不失焦", () => {
    const m = mountBar();
    const inputEl = m.renderInput();
    press(inputEl, { key: "Escape", nativeEvent: { isComposing: true } });
    press(inputEl, { key: "Escape", keyCode: 229 });
    expect(m.cb.onClose).not.toHaveBeenCalled();
    expect(m.input.blur).not.toHaveBeenCalled();
  });

  it("其它键什么都不触发", () => {
    const m = mountBar();
    const e = press(m.renderInput(), { key: "a" });
    expect(m.cb.onNext).not.toHaveBeenCalled();
    expect(m.cb.onPrev).not.toHaveBeenCalled();
    expect(m.cb.onClose).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("搜索栏：<Input> 拿到的透传（审查 AI 补洞：K2 K4 K5 K6 K8）", () => {
  it("ref 就是父组件传下来的那一个（Cmd+F 聚焦 / Esc 后失焦都靠它）；打开即聚焦", () => {
    const m = mountBar();
    const inputEl = m.renderInput();
    expect(inputEl.props.ref).toBe(m.ref);
    expect(inputEl.props.autoFocus).toBe(true);
  });

  it("占位文字 / 读屏名字 / 样式都透传到 <Input>（调用方给的值）", () => {
    const m = mountBar({
      placeholder: "搜索产物…",
      ariaLabel: "搜索产物",
      inputClassName: "extra-x",
    });
    const inputEl = m.renderInput();
    expect(inputEl.props.placeholder).toBe("搜索产物…");
    expect(inputEl.props["aria-label"]).toBe("搜索产物");
    const cls = String(inputEl.props.className);
    expect(cls).toContain("extra-x");
    expect(cls).toContain("h-7 min-w-0 flex-1 text-sm");
  });

  it("调用方没给时用事件流的默认占位 / 读屏名字", () => {
    const m = mountBar();
    const inputEl = m.renderInput();
    expect(inputEl.props.placeholder).toBe("搜索事件流…");
    expect(inputEl.props["aria-label"]).toBe("搜索事件流");
  });

  it("显示值就是外部 query（非组合态）", () => {
    const m = mountBar({ query: "abc" });
    expect(m.renderInput().props.value).toBe("abc");
  });
});

describe("搜索栏：输入经输入法 hook 再上报（接线行为）", () => {
  it("非组合输入直通 onQueryChange；组合中一次都不报，上屏后只报一次最终值", () => {
    const m = mountBar();
    let inputEl = m.renderInput();
    (inputEl.props.onChange as (e: unknown) => void)(typed("a"));
    expect(m.cb.onQueryChange).toHaveBeenCalledTimes(1);
    expect(m.cb.onQueryChange).toHaveBeenLastCalledWith("a");

    (inputEl.props.onCompositionStart as () => void)();
    (inputEl.props.onChange as (e: unknown) => void)(typed("an", true));
    (inputEl.props.onChange as (e: unknown) => void)(typed("ani", true));
    inputEl = m.renderInput();
    expect(inputEl.props.value).toBe("ani"); // 组合中显示草稿
    expect(m.cb.onQueryChange).toHaveBeenCalledTimes(1);

    (inputEl.props.onCompositionEnd as (e: unknown) => void)(compositionEnd("a你"));
    expect(m.cb.onQueryChange).toHaveBeenCalledTimes(2);
    expect(m.cb.onQueryChange).toHaveBeenLastCalledWith("a你");
  });
});

// ───────────────────────── ② 事件流 reveal effect：pauseForHit 的位置 ─────────────────────────

describe("事件流 reveal effect：先判有没有命中，再停跟随（审查 AI 补洞：K9）", () => {
  const es = stripComments(readSrc("src/components/tasks/event-stream.tsx"));
  const guard = "if (!isSearchFiltering || !currentSearchOwnerId) return;";
  const pause = "searchFollowGate.pauseForHit();";

  it("pauseForHit 只调一次，且排在「没在筛选 / 没有命中属主就 return」的守卫之后、同一个 effect 里", () => {
    expect(es.split(guard).length - 1).toBe(1);
    expect(es.split(pause).length - 1).toBe(1);
    const g = es.indexOf(guard);
    const p = es.indexOf(pause);
    expect(g).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(g);
    // 守卫与 pauseForHit 之间不能隔着别的 effect（否则「守卫之后」不是同一个 effect 的守卫）
    const between = es.slice(g, p);
    expect(between).not.toContain("useEffect(");
    expect(between).not.toMatch(/\n {2}\}, \[/);
  });
});

// ───────────────────────── ③ 会话页灰字的数字 ─────────────────────────

describe("会话页灰字：数的是被跳过的会话（审查 AI 补洞：K11）", () => {
  const page = stripComments(readSrc("src/app/sessions/page.tsx"));

  it("灰字只在有被跳过的会话时出现，里面的数字是 getStaleProtectedCount()（不是将选中的 getStaleChats().length）", () => {
    expect(page).toContain("getStaleProtectedCount() > 0 &&");
    expect(page).toMatch(/另有 \{getStaleProtectedCount\(\)\} 个 30 天未活跃/);
    expect(page).toMatch(
      /const getStaleProtectedCount = \(\) =>\s*countProtectedStaleChats\(renderedRows, Date\.now\(\)\);/,
    );
  });
});

// ───────────────────────── ④ sessions-filter：未来时间戳不算 30 天未活跃 ─────────────────────────

describe("sessions-filter：未来时间戳（时钟回拨 / 跨机器）不算 30 天未活跃（审查 AI 补洞：K12）", () => {
  const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
  const row = (over: Partial<Parameters<typeof pickStaleChatSessions>[0][number]>) => ({
    id: "t",
    title: "标题",
    mode: "chat",
    updatedAt: NOW,
    ...over,
  });

  it("updatedAt 在未来很远：不选中、也不计入「被跳过」", () => {
    const future = NOW + CHAT_STALE_MS + 1;
    const rows = [
      row({ id: "plain-future", updatedAt: future }),
      row({ id: "pinned-future", updatedAt: future, pinned: true }),
      row({ id: "old", updatedAt: NOW - CHAT_STALE_MS - 1 }),
      row({ id: "old-pinned", updatedAt: NOW - CHAT_STALE_MS - 1, pinned: true }),
    ];
    expect(pickStaleChatSessions(rows, NOW).map((r) => r.id)).toEqual(["old"]);
    expect(countProtectedStaleChats(rows, NOW)).toBe(1);
  });
});

// ───────────────────────── ⑤ useImeInput：组合中删空 ─────────────────────────

describe("useImeInput：组合中把拼音删成空串（审查 AI 补洞：K18）", () => {
  it("显示值仍是草稿 \"\"，不弹回外部旧查询词（否则输入法正在编辑的内容被冲掉）", () => {
    const h = createHookHarness();
    const onCommit = vi.fn();
    const render = () => {
      const api = h.render(() => useImeInput({ value: "旧查询", onCommit }));
      h.flushEffects();
      return api;
    };
    let api = render();
    api.onCompositionStart();
    api.onChange(typed("n", true));
    api = render();
    expect(api.value).toBe("n");
    api.onChange(typed("", true)); // 退格把拼音删光
    api = render();
    expect(api.value).toBe("");
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// ───────────────────────── ⑥ 归档灰条：按钮不是告警红 / 布局类名 ─────────────────────────

describe("ArchivedBar：按钮与布局（审查 AI 补洞：K24 K25 K26）", () => {
  it("恢复按钮不是告警红（根节点只查了 destructive，按钮的 variant 没人查）", () => {
    const tree = ArchivedBar({ onRestore: () => {} });
    const buttons = findAll(tree, (el) => el.type === Button);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.variant).not.toBe("destructive");
  });

  it("布局类名：根节点 shrink-0（竖排容器里不被压扁）；文案段落 min-w-0 flex-1（长文案不撑破、按钮靠右）", () => {
    const tree = ArchivedBar({ onRestore: () => {} }) as El;
    expect(String(tree.props.className)).toContain("shrink-0");
    const paragraphs = findAll(tree, (el) => el.type === "p");
    expect(paragraphs).toHaveLength(1);
    const cls = String(paragraphs[0].props.className);
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("flex-1");
  });
});
