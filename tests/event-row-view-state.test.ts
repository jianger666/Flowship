/**
 * V2-05：事件流行的「手动展开 / 折叠」等视图状态不能随 Virtuoso 卸载丢失。
 *
 * 背景：`VIEWPORT_OVERSCAN = { top: 0, bottom: 1500 }`，行一离开视口上沿就卸载；
 * 工具块 manualCollapsed / outputOpen / diffCollapsed / fullText、待办卡、动词组、思考 / info 行、
 * 工作过程组的「钉住展开」全是组件内 useState，滚走再滚回来全部回到默认（点过「加载完整输出」的
 * fullText 丢了要再请求一次）。
 *
 * 做法（小步版）：模块级、有上限的 LRU store（纯函数部分在 src/lib/event-row-view-state.ts）+
 * `useRowViewState(key, initial)` hook（src/hooks/use-row-view-state.ts），重挂时从 store 恢复。
 * 这里：store 的行为 / 上限 / 淘汰 + hook 的「重挂首帧还原」（SSR 渲染验证，同 ask 草稿那条的做法）
 * + 各行组件已换用 hook 的源码契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createRowViewStateStore,
  DEFAULT_ROW_VIEW_STATE_LIMITS,
  rowViewStateKey,
  rowViewStateStore,
} from "../src/lib/event-row-view-state";
import {
  RowViewStateScope,
  useRowViewState,
} from "../src/hooks/use-row-view-state";

const small = (over: Partial<typeof DEFAULT_ROW_VIEW_STATE_LIMITS> = {}) =>
  createRowViewStateStore({
    maxEntries: 100,
    maxBytes: 1_000_000,
    maxEntryBytes: 500_000,
    ...over,
  });

describe("store：读写 / 区分「没存」与 false / null", () => {
  it("set / get 往返；false、null、空串都是有效值，不会被当成没存过", () => {
    const s = small();
    s.set("a", false);
    s.set("b", null);
    s.set("c", "");
    s.set("d", true);
    expect(s.get("a")).toBe(false);
    expect(s.get("b")).toBe(null);
    expect(s.get("c")).toBe("");
    expect(s.get("d")).toBe(true);
    expect(s.has("a")).toBe(true);
    expect(s.has("nope")).toBe(false);
    expect(s.get("nope")).toBeUndefined();
  });

  it("set(key, undefined) = 删除", () => {
    const s = small();
    s.set("a", true);
    s.set("a", undefined);
    expect(s.has("a")).toBe(false);
    expect(s.size).toBe(0);
    expect(s.bytes).toBe(0);
  });
});

describe("store：LRU 与上限（内存有限、不泄漏）", () => {
  it("超过条数上限淘汰最久没用的；读过的会被续命", () => {
    const s = small({ maxEntries: 3 });
    s.set("a", true);
    s.set("b", true);
    s.set("c", true);
    expect(s.get("a")).toBe(true); // a 续命
    s.set("d", true); // 挤掉最老的 b
    expect(s.has("b")).toBe(false);
    expect(s.has("a")).toBe(true);
    expect(s.has("c")).toBe(true);
    expect(s.has("d")).toBe(true);
    expect(s.size).toBe(3);
  });

  it("重新 set 同一个 key 也算续命", () => {
    const s = small({ maxEntries: 2 });
    s.set("a", 1);
    s.set("b", 1);
    s.set("a", 2);
    s.set("c", 1);
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });

  it("总字节上限：大 fullText 进来会淘汰最老的条目，总量永远 ≤ 上限，刚写入的那条留着", () => {
    const s = small({ maxBytes: 10_000, maxEntryBytes: 8_000 });
    s.set("old1", "x".repeat(1000)); // ≈ 2000+ 字节
    s.set("old2", "x".repeat(1000));
    s.set("big", "y".repeat(3500)); // ≈ 7000+
    expect(s.bytes).toBeLessThanOrEqual(10_000);
    expect(s.has("big")).toBe(true);
    // 最老的先被淘汰
    expect(s.has("old1")).toBe(false);
  });

  it("单条超过单条上限：不存，而且清掉同 key 的旧值（不能让陈旧的小值在重挂时复活）", () => {
    const s = small({ maxEntryBytes: 2_000, maxBytes: 100_000 });
    expect(s.set("k", "small")).toBe(true);
    expect(s.set("k", "z".repeat(5_000))).toBe(false);
    expect(s.has("k")).toBe(false);
    expect(s.bytes).toBe(0);
  });

  it("覆盖写同一个 key 不重复计字节", () => {
    const s = small();
    s.set("k", "a".repeat(1000));
    const big = s.bytes;
    s.set("k", "a");
    expect(s.bytes).toBeLessThan(big);
    s.delete("k");
    expect(s.bytes).toBe(0);
    expect(s.size).toBe(0);
  });

  it("反复写入 50 个任务 × 大量 fullText：条数与字节始终不越界（切任务不泄漏）", () => {
    const limits = {
      maxEntries: 400,
      maxBytes: 4_000_000,
      maxEntryBytes: 1_000_000,
    };
    const s = createRowViewStateStore(limits);
    for (let t = 0; t < 50; t++) {
      for (let r = 0; r < 100; r++) {
        s.set(rowViewStateKey(`task${t}`, `ev${r}`, "tool:fullText"), "q".repeat(50_000));
        s.set(rowViewStateKey(`task${t}`, `ev${r}`, "tool:manualCollapsed"), false);
        expect(s.size).toBeLessThanOrEqual(limits.maxEntries);
        expect(s.bytes).toBeLessThanOrEqual(limits.maxBytes);
      }
    }
  });

  it("默认上限在合理范围（几百条、几 MB）", () => {
    const d = DEFAULT_ROW_VIEW_STATE_LIMITS;
    expect(d.maxEntries).toBeGreaterThanOrEqual(200);
    expect(d.maxEntries).toBeLessThanOrEqual(2000);
    expect(d.maxBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(d.maxEntryBytes).toBeLessThanOrEqual(d.maxBytes);
  });
});

describe("store：按任务清理 / key 构造", () => {
  it("clearTask 只清该任务的条目；t1 不会误伤 t10（分隔符不是前缀匹配）", () => {
    const s = small();
    s.set(rowViewStateKey("t1", "e1", "f"), true);
    s.set(rowViewStateKey("t1", "e2", "f"), true);
    s.set(rowViewStateKey("t10", "e1", "f"), true);
    s.set(rowViewStateKey("t1", "e1", "f", "sa:x"), true); // 抽屉作用域的也属于 t1
    expect(s.clearTask("t1")).toBe(3);
    expect(s.has(rowViewStateKey("t10", "e1", "f"))).toBe(true);
    expect(s.size).toBe(1);
  });

  it("不同 task / 行 / 字段 / 作用域 → 不同 key；同参数 → 同 key", () => {
    const k = rowViewStateKey("t", "e", "f");
    expect(rowViewStateKey("t", "e", "f")).toBe(k);
    expect(rowViewStateKey("t2", "e", "f")).not.toBe(k);
    expect(rowViewStateKey("t", "e2", "f")).not.toBe(k);
    expect(rowViewStateKey("t", "e", "f2")).not.toBe(k);
    expect(rowViewStateKey("t", "e", "f", "sa:1")).not.toBe(k);
    // 字段里带分隔符 / 边界字符也不会串位：(t, "a:b", "c") ≠ (t, "a", "b:c")
    expect(rowViewStateKey("t", "a:b", "c")).not.toBe(
      rowViewStateKey("t", "a", "b:c"),
    );
  });
});

/**
 * hook：用 renderToStaticMarkup 当「挂载」。每次调用 = 一次全新挂载（等价于 Virtuoso 把行卸载后又滚回来）。
 * 渲染期的 useState 初始化函数读 store，所以首帧就是还原后的值。
 */
describe("useRowViewState：重挂首帧还原", () => {
  type Setter = (v: boolean | ((p: boolean) => boolean)) => void;
  let setter: Setter | null = null;

  const Probe = ({ k, init }: { k: string | null; init?: boolean }) => {
    const [v, set] = useRowViewState<boolean>(k, init ?? false);
    setter = set;
    return createElement("span", null, String(v));
  };
  const mount = (node: ReactNode): string => renderToStaticMarkup(node as never);

  beforeEach(() => {
    rowViewStateStore.clear();
    setter = null;
  });

  it("首次挂载是 initial；setter 写入 store；重新挂载首帧就是写入的值", () => {
    const key = rowViewStateKey("t1", "ev1", "tool:diffCollapsed");
    expect(mount(createElement(Probe, { k: key }))).toContain("false");
    setter!(true);
    expect(rowViewStateStore.get(key)).toBe(true);
    // 「卸载后重挂」
    expect(mount(createElement(Probe, { k: key }))).toContain("true");
  });

  it("函数式更新：基于当前值切换（对应 setManual(m => toggle(m))）", () => {
    const key = rowViewStateKey("t1", "ev2", "x");
    mount(createElement(Probe, { k: key }));
    setter!((p) => !p);
    expect(rowViewStateStore.get(key)).toBe(true);
    setter!((p) => !p);
    expect(rowViewStateStore.get(key)).toBe(false);
  });

  it("没写过 → 不往 store 里塞默认值（只有用户真动过才占内存）", () => {
    const key = rowViewStateKey("t1", "ev3", "x");
    mount(createElement(Probe, { k: key, init: true }));
    expect(rowViewStateStore.has(key)).toBe(false);
  });

  it("initial 是函数时只在没有存档才求值（昂贵 / 有副作用的默认值不会白算）", () => {
    const key = rowViewStateKey("t1", "ev4", "x");
    rowViewStateStore.set(key, true);
    let calls = 0;
    const Lazy = () => {
      const [v] = useRowViewState<boolean>(key, () => {
        calls++;
        return false;
      });
      return createElement("span", null, String(v));
    };
    expect(mount(createElement(Lazy))).toContain("true");
    expect(calls).toBe(0);
    rowViewStateStore.delete(key);
    expect(mount(createElement(Lazy))).toContain("false");
    expect(calls).toBe(1);
  });

  it("不同行 / 不同字段互不串", () => {
    const a = rowViewStateKey("t1", "evA", "f");
    const b = rowViewStateKey("t1", "evB", "f");
    mount(createElement(Probe, { k: a }));
    setter!(true);
    expect(mount(createElement(Probe, { k: b }))).toContain("false");
    expect(mount(createElement(Probe, { k: a }))).toContain("true");
  });

  it("key 为 null → 不读不写 store（退化成普通 useState）", () => {
    mount(createElement(Probe, { k: null }));
    setter!(true);
    expect(rowViewStateStore.size).toBe(0);
  });

  it("作用域：子代理抽屉里的行（id 是 sr_1 这种每份记录都从 1 开始的）不会和主流 / 别的子代理串状态", () => {
    const key = rowViewStateKey("t1", "sr_1", "work:manual");
    // 主流（无作用域）里写 true
    mount(createElement(Probe, { k: key }));
    setter!(true);
    // 抽屉 A / 抽屉 B 里同 id 的行：各自独立、都不受主流影响
    const inScope = (scope: string) =>
      mount(
        createElement(
          RowViewStateScope.Provider,
          { value: scope },
          createElement(Probe, { k: key }),
        ),
      );
    expect(inScope("sa:A")).toContain("false");
    setter!(true); // A 里点开
    expect(inScope("sa:A")).toContain("true");
    expect(inScope("sa:B")).toContain("false");
  });

  it("卸载后异步回来的写入（加载完整输出的 fetch 在行被滚走后才返回）照样进 store，重挂能看到", async () => {
    const key = rowViewStateKey("t1", "evF", "tool:fullText");
    const Text = () => {
      const [v, set] = useRowViewState<string | null>(key, null);
      // 模拟：挂载时发起请求，请求回来时组件已卸载
      Promise.resolve().then(() => set("FULL OUTPUT"));
      return createElement("span", null, String(v));
    };
    expect(mount(createElement(Text))).toContain("null");
    await Promise.resolve();
    await Promise.resolve();
    expect(rowViewStateStore.get(key)).toBe("FULL OUTPUT");
    const Reader = () => {
      const [v] = useRowViewState<string | null>(key, null);
      return createElement("span", null, String(v));
    };
    expect(mount(createElement(Reader))).toContain("FULL OUTPUT");
  });
});

/**
 * 接线契约：报告点名的那些 useState 必须已换成 useRowViewState。
 * 只换列表里的（工具块 / 待办卡 / 动词组 / 思考·info 行 / 工作过程组），别的 useState 不动。
 */
describe("各行组件接线（源码契约）", () => {
  const read = (rel: string): string =>
    readFileSync(path.join(__dirname, "..", rel), "utf8");
  const TOOL = read("src/components/tasks/event-stream/tool-block.tsx");
  const WORK = read("src/components/tasks/event-stream/work-group.tsx");
  const ROWS = read("src/components/tasks/event-stream/rows.tsx");
  const DETAIL = read("src/components/tasks/subagent-detail.tsx");

  it("工具块：manualCollapsed / outputOpen / diffCollapsed / fullText 走 store", () => {
    for (const name of [
      "manualCollapsed",
      "outputOpen",
      "diffCollapsed",
      "fullText",
    ]) {
      expect(TOOL, name).not.toMatch(
        new RegExp(`const \\[${name}, set\\w+\\] = useState`),
      );
      expect(TOOL, name).toMatch(
        new RegExp(`const \\[${name}, set\\w+\\] = useRowViewState`),
      );
    }
    // 加载中是瞬时态，不进 store（重挂后没有在飞的请求可接）
    expect(TOOL).toMatch(/const \[fullLoading, setFullLoading\] = useState/);
  });

  it("待办卡 / 动词组的折叠态走 store", () => {
    expect(TOOL).toMatch(/const \[collapsed, setCollapsed\] = useRowViewState/);
    // 工具块（Regular）没有叫 collapsed 的 useState；待办卡 + 动词组各一处 useRowViewState
    const hits = TOOL.match(/const \[collapsed, setCollapsed\] = useRowViewState/g);
    expect(hits?.length).toBe(2);
    expect(TOOL).not.toMatch(/const \[collapsed, setCollapsed\] = useState/);
  });

  it("工作过程组：手动展开 + 「钉住展开」闩锁都走 store（后者原来是 ref，重挂必丢）", () => {
    expect(WORK).toMatch(/const \[manual, setManual\] = useRowViewState/);
    expect(WORK).toMatch(
      /useRowViewState<boolean>\([\s\S]{0,120}ROW_VIEW_FIELD\.workPinned/,
    );
    expect(WORK).not.toMatch(/stickyOpenRef/);
  });

  it("rows.tsx：思考 / info 行的 manualCollapsed、用户消息的 editing / 草稿走 store（R4-05）", () => {
    expect(ROWS).toMatch(/const \[manualCollapsed, setManualCollapsed\] = useRowViewState/);
    expect(ROWS).not.toMatch(/const \[manualCollapsed, setManualCollapsed\] = useState/);
    // 编辑态 / 草稿原来是「有意不动」，R4-05 起也进存档（key 三要素由 tests/row-view-keys.test.ts 钉）；
    // 超长用户消息展开仍是普通 state
    expect(ROWS).toMatch(/const \[editing, setEditing\] = useRowViewState/);
    expect(ROWS).toMatch(/const \[editDraft, setEditDraft\] = useRowViewState/);
    expect(ROWS).toMatch(/const \[userExpanded, setUserExpanded\] = useState/);
  });

  it("每个 key 都经 row-view-keys 的 helper 构造（taskId / 行 / 字段三要素的断言在 row-view-keys.test.ts），字段名各不相同", () => {
    for (const [name, src] of Object.entries({ TOOL, WORK, ROWS })) {
      expect(src, name).not.toMatch(/\browViewStateKey\(/);
    }
    const fields = [TOOL, WORK, ROWS].flatMap((src) =>
      [...src.matchAll(/ROW_VIEW_FIELD\.(\w+)/g)].map((m) => m[1]),
    );
    // 工具块 4 + 待办 1 + verb 1 + 工作组 2 + 事件行 1 = 9（用户消息编辑的两个字段在 userEditViewKeys 里）
    expect(fields.length).toBeGreaterThanOrEqual(9);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("子代理抽屉给里面的行套了作用域（sr_N 每份记录都从 1 开始，不隔离就串状态）", () => {
    expect(DETAIL).toMatch(/<RowViewStateScope\.Provider value=\{`sa:\$\{snapshot\.meta\.key\}`\}>/);
  });
});
