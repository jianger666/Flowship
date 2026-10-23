/**
 * 事件流左侧「提问时间线」的纯逻辑（src/lib/stream-outline.ts）。
 *
 * 钉死：
 *   1. 哪些事件进时间线（与 isTailAnchorEvent 同口径：属主可见的 user_reply / action_start；群里陌生人的提问、
 *      旁路 run 的事件、被平台消音的不进）；预览怎么折叠 / 截断 / 兜底；定时触发怎么标；
 *   2. 大纲合并：服务端大纲 + 窗口实时事件（去重、乱序按时刻插、回退点及之后的砍掉）；
 *   3. 折叠态刻度并格：不丢项、不重叠、每格至少一项；
 *   4. 当前轮判定（视口顶项往上找最近的提问；工作过程组的成员也认）、隐藏项落到前一个可见项；
 *   5. 外部 store 值没变不通知（滚动热路径靠它不触发重渲）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  OUTLINE_EDGE_INSET_PX,
  OUTLINE_MAX_TICKS,
  OUTLINE_PANEL_GAP_PX,
  OUTLINE_PANEL_WIDTH_PX,
  OUTLINE_PREVIEW_MAX,
  bucketOutlineTicks,
  createActiveOutlineStore,
  fetchWithBackoff,
  formatOutlineDay,
  formatOutlineTime,
  groupOutlineRows,
  mergeOutline,
  outlinePanelRightShift,
  pickOutlinePanelSide,
  previewText,
  resolveActiveOutlineId,
  resolveVisibleActiveId,
  stabilizeOutline,
  toOutlineItem,
  visibleOutline,
  type OutlineItem,
} from "@/lib/stream-outline";
import type { TaskEvent } from "@/lib/types";

let n = 0;
const ev = (
  kind: TaskEvent["kind"],
  text: string,
  meta?: Record<string, unknown>,
  ts?: number,
): TaskEvent => {
  n += 1;
  return {
    id: `ev_${String(n).padStart(5, "0")}`,
    ts: ts ?? 1_700_000_000_000 + n * 1000,
    kind,
    text,
    ...(meta ? { meta } : {}),
  };
};
const item = (id: string, ts: number, extra: Partial<OutlineItem> = {}): OutlineItem => ({
  id,
  ts,
  kind: "user_reply",
  text: id,
  ...extra,
});

describe("toOutlineItem：哪些事件进时间线", () => {
  it("属主的 user_reply / action_start 进；其余 kind 不进", () => {
    expect(toOutlineItem(ev("user_reply", "你好"))?.kind).toBe("user_reply");
    expect(toOutlineItem(ev("action_start", "开始 Plan（plan）n=1"))?.kind).toBe("action_start");
    for (const kind of ["assistant_message", "thinking", "tool_call", "tool_result", "info", "error"] as const) {
      expect(toOutlineItem(ev(kind, "x")), kind).toBeNull();
    }
  });

  it("群里陌生人的提问（restrictedRunTag）/ 旁路 run 的事件 / 被消音的：不进（走 isHiddenFromEventStream 同一个闸）", () => {
    expect(
      toOutlineItem(ev("user_reply", "陌生人问", { source: "feishu_group", restrictedRunTag: "r1" })),
    ).toBeNull();
    expect(toOutlineItem(ev("user_reply", "旁路", { groupRun: "g1" }))).toBeNull();
    expect(toOutlineItem(ev("user_reply", "消音", { muted: true }))).toBeNull();
  });

  it("属主自己的群消息：预览剥掉喂给 agent 的内部前缀（与气泡同一份展示文本）", () => {
    const it1 = toOutlineItem(
      ev("user_reply", "[群消息·来自 张三] 帮我看下这个", { source: "feishu_group" }),
    );
    expect(it1?.text).toBe("帮我看下这个");
  });

  it("预览：折叠空白 / 换行、不超过上限、超长加省略号", () => {
    const multi = toOutlineItem(ev("user_reply", "第一行\n\n   第二行\t第三行"));
    expect(multi?.text).toBe("第一行 第二行 第三行");
    const long = toOutlineItem(ev("user_reply", "字".repeat(500)))!;
    expect(Array.from(long.text)).toHaveLength(OUTLINE_PREVIEW_MAX + 1);
    expect(long.text.endsWith("…")).toBe(true);
    const exact = toOutlineItem(ev("user_reply", "字".repeat(OUTLINE_PREVIEW_MAX)))!;
    expect(exact.text).toBe("字".repeat(OUTLINE_PREVIEW_MAX));
  });

  it("预览按码点截：不把 emoji 的代理对劈成两半", () => {
    const text = "😀".repeat(200);
    const got = previewText(text, 5);
    expect(got).toBe("😀😀😀😀😀…");
    expect(got).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("几十万字的粘贴也不整段跑正则（只取够用的前缀）", () => {
    const huge = `开头${"x ".repeat(500_000)}`;
    const t0 = performance.now();
    const got = previewText(huge);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(got.startsWith("开头")).toBe(true);
    expect(Array.from(got).length).toBeLessThanOrEqual(OUTLINE_PREVIEW_MAX + 1);
  });

  it("空消息：有图 → [图片]、有附件 → [附件]、都没有 → （空消息）", () => {
    expect(toOutlineItem(ev("user_reply", "  ", { images: [{ path: "/a.png" }] }))?.text).toBe("[图片]");
    expect(toOutlineItem(ev("user_reply", "", { attachments: [{ name: "a" }] }))?.text).toBe("[附件]");
    expect(toOutlineItem(ev("user_reply", ""))?.text).toBe("（空消息）");
  });

  it("action_start：「开始 Plan（plan）n=2」→「开始 Plan #2」，第一次不带序号；带用户指令接在后面", () => {
    expect(toOutlineItem(ev("action_start", "开始 Plan（plan）n=1"))?.text).toBe("开始 Plan");
    expect(toOutlineItem(ev("action_start", "开始 Plan（plan）n=2"))?.text).toBe("开始 Plan #2");
    expect(
      toOutlineItem(ev("action_start", "开始 Build（build）n=1\n用户指令：只改 A 模块\n其它"))?.text,
    ).toBe("开始 Build · 只改 A 模块");
    // 认不出格式：退回首行
    expect(toOutlineItem(ev("action_start", "奇怪的开头\n第二行"))?.text).toBe("奇怪的开头");
  });

  it("定时触发（meta.source=schedule）：标 schedule、预览用标题 / 备忘，不用整段系统样板", () => {
    const withTitle = toOutlineItem(
      ev("user_reply", "[SCHEDULE_FIRED id=sch_1]\n到点了……", {
        source: "schedule",
        scheduleTitle: "看 CI",
        scheduleMessage: "查一下流水线",
      }),
    )!;
    expect(withTitle.schedule).toBe(true);
    expect(withTitle.text).toBe("定时 · 看 CI");
    const memoOnly = toOutlineItem(
      ev("user_reply", "[SCHEDULE_FIRED id=sch_1]\n样板", {
        source: "schedule",
        scheduleMessage: "查一下流水线",
      }),
    )!;
    expect(memoOnly.text).toBe("定时 · 查一下流水线");
    const bare = toOutlineItem(ev("user_reply", "[SCHEDULE_FIRED id=sch_1]\n样板", { source: "schedule" }))!;
    expect(bare.text).toBe("定时触发");
  });

  it("老事件没有 meta：靠文本前缀 [SCHEDULE_FIRED 认出来，样板文本不当预览", () => {
    const old = toOutlineItem(ev("user_reply", "[SCHEDULE_FIRED id=sch_9]\n一大段样板"))!;
    expect(old.schedule).toBe(true);
    expect(old.text).toBe("定时触发");
  });

  it("普通用户消息不带 schedule 字段（不是 schedule:false，序列化 / 对比都更干净）", () => {
    expect("schedule" in toOutlineItem(ev("user_reply", "hi"))!).toBe(false);
  });
});

describe("mergeOutline：服务端大纲 + 窗口里的实时事件", () => {
  const base = 1_700_000_000_000;
  const server = [item("a", base), item("b", base + 10), item("c", base + 20)];

  it("窗口里没有新提问：原样返回（同一个引用，省一次重渲）", () => {
    const w = [ev("assistant_message", "x")];
    expect(mergeOutline(server, w)).toBe(server);
  });

  it("窗口里已经在大纲里的提问不重复", () => {
    const dup: TaskEvent = { id: "b", ts: base + 10, kind: "user_reply", text: "b" };
    expect(mergeOutline(server, [dup]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("窗口里的新提问并到末尾（时刻递增）", () => {
    const fresh = ev("user_reply", "新问", undefined, base + 1000);
    const merged = mergeOutline(server, [fresh]);
    expect(merged.map((i) => i.id)).toEqual(["a", "b", "c", fresh.id]);
  });

  it("乱序（窗口里的提问比大纲末项还早，多标签页 / 补发）：按时刻稳定插入", () => {
    const early = ev("user_reply", "早到的", undefined, base + 5);
    const merged = mergeOutline(server, [early]);
    expect(merged.map((i) => i.id)).toEqual(["a", early.id, "b", "c"]);
  });

  it("回退：回退点及之后的大纲项全砍（服务端大纲可能是回退之前拉的）", () => {
    expect(mergeOutline(server, [], "b").map((i) => i.id)).toEqual(["a"]);
    // 回退点是第一项 → 全空
    expect(mergeOutline(server, [], "a")).toEqual([]);
    // 回退点不在大纲里（早就被回退过 / 在窗口外）→ 不动
    expect(mergeOutline(server, [], "zzz").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("回退后窗口里重新产生的新提问照常并进来；被砍的项不会因为窗口还有它而复活（窗口已被 truncateForRewind 截过）", () => {
    const fresh = ev("user_reply", "回退后的新问", undefined, base + 500);
    const merged = mergeOutline(server, [fresh], "b");
    expect(merged.map((i) => i.id)).toEqual(["a", fresh.id]);
  });

  it("窗口里的 hidden 提问（群陌生人）不并进来", () => {
    const stranger = ev("user_reply", "陌生人", { source: "feishu_group", restrictedRunTag: "r" });
    expect(mergeOutline(server, [stranger])).toBe(server);
  });

  it("服务端大纲为空（窗口就是全部历史）：完全由窗口派生", () => {
    const a = ev("user_reply", "一");
    const b = ev("action_start", "开始 Plan（plan）n=1");
    expect(mergeOutline([], [a, ev("assistant_message", "x"), b]).map((i) => i.id)).toEqual([a.id, b.id]);
  });
});

describe("stabilizeOutline：内容没变就给旧引用", () => {
  const a = [item("a", 1), item("b", 2)];
  it("逐项相同 → prev", () => {
    expect(stabilizeOutline(a, [item("a", 1), item("b", 2)])).toBe(a);
  });
  it("长度 / id / ts / text / kind / schedule 任一变 → next", () => {
    expect(stabilizeOutline(a, [item("a", 1)])).not.toBe(a);
    expect(stabilizeOutline(a, [item("a", 1), item("c", 2)])[1]!.id).toBe("c");
    expect(stabilizeOutline(a, [item("a", 1), item("b", 3)])[1]!.ts).toBe(3);
    expect(stabilizeOutline(a, [item("a", 1), item("b", 2, { text: "改" })])[1]!.text).toBe("改");
    expect(stabilizeOutline(a, [item("a", 1), item("b", 2, { kind: "action_start" })])[1]!.kind).toBe("action_start");
    expect(stabilizeOutline(a, [item("a", 1), item("b", 2, { schedule: true })])[1]!.schedule).toBe(true);
  });
});

describe("visibleOutline", () => {
  const all = [item("a", 1), item("s", 2, { schedule: true }), item("b", 3)];
  it("默认不含定时触发；打开开关全含", () => {
    expect(visibleOutline(all, false).map((i) => i.id)).toEqual(["a", "b"]);
    expect(visibleOutline(all, true).map((i) => i.id)).toEqual(["a", "s", "b"]);
  });
});

describe("bucketOutlineTicks：折叠态刻度并格", () => {
  it("项数 ≤ 上限：一项一格", () => {
    expect(bucketOutlineTicks(0)).toEqual([]);
    expect(bucketOutlineTicks(3)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 1 },
      { first: 2, last: 2 },
    ]);
    expect(bucketOutlineTicks(OUTLINE_MAX_TICKS)).toHaveLength(OUTLINE_MAX_TICKS);
  });

  it("项数 > 上限：恰好 maxTicks 格、连续不重叠、覆盖全部、每格至少一项（多个规模逐一验）", () => {
    for (const count of [37, 40, 71, 100, 359, 1000, 4999, 5000]) {
      const ticks = bucketOutlineTicks(count);
      expect(ticks, `count=${count}`).toHaveLength(OUTLINE_MAX_TICKS);
      expect(ticks[0]!.first).toBe(0);
      expect(ticks[ticks.length - 1]!.last).toBe(count - 1);
      ticks.forEach((t, i) => {
        expect(t.last, `count=${count} tick=${i}`).toBeGreaterThanOrEqual(t.first);
        if (i > 0) expect(t.first).toBe(ticks[i - 1]!.last + 1);
      });
    }
  });
});

describe("pickOutlinePanelSide：展开面板往哪边开", () => {
  const need = OUTLINE_PANEL_WIDTH_PX + OUTLINE_PANEL_GAP_PX;

  it("把手左侧放得下整块面板（含缝）→ 向左开：面板落在左侧空白区、不盖正文", () => {
    expect(pickOutlinePanelSide(need)).toBe("left");
    expect(pickOutlinePanelSide(need + 1)).toBe("left");
    // 1830px 宽的事件区里 chat 把手离左缘的距离：(1830 - 8 - 768) / 2 - 6
    expect(pickOutlinePanelSide(521)).toBe("left");
  });

  it("差一个像素放不下 → 向右开（窄窗口 / task 形态把手贴最左缘：与老行为一致）", () => {
    expect(pickOutlinePanelSide(need - 1)).toBe("right");
    expect(pickOutlinePanelSide(2)).toBe("right"); // task 形态的 left-0.5
    expect(pickOutlinePanelSide(0)).toBe("right");
  });

  it("量不出来（NaN）/ 负数按放不下算：宁可盖住一点正文，也不让面板跑到事件区外面被裁掉", () => {
    expect(pickOutlinePanelSide(Number.NaN)).toBe("right");
    expect(pickOutlinePanelSide(-10)).toBe("right");
  });

  it("面板宽 / 缝是 w-72（18rem）/ mr-1（0.25rem）的像素值", () => {
    expect(OUTLINE_PANEL_WIDTH_PX).toBe(18 * 16);
    expect(OUTLINE_PANEL_GAP_PX).toBe(0.25 * 16);
  });
});

describe("outlinePanelRightShift：向右开时把面板拉回事件区最左缘", () => {
  const need = OUTLINE_PANEL_WIDTH_PX + OUTLINE_PANEL_GAP_PX;

  it("task 形态把手本来就在 2px（left-0.5）→ 0：面板与把手左缘对齐，与老行为一致", () => {
    expect(outlinePanelRightShift(2)).toBe(0);
  });

  it("chat 窄窗口：把手离最左缘越远拉回得越多，面板左缘恒落在 2px（覆盖量与旧版逐档相等）", () => {
    // 事件区 1000px：把手左缘 (1000 - 8 - 768) / 2 - 6 = 106
    expect(outlinePanelRightShift(106)).toBe(-104);
    // 事件区 1300px：(1300 - 8 - 768) / 2 - 6 = 256
    expect(outlinePanelRightShift(256)).toBe(-254);
    for (let left = OUTLINE_EDGE_INSET_PX; left < need; left++) {
      expect(left + outlinePanelRightShift(left), `把手左缘 ${left}px`).toBe(OUTLINE_EDGE_INSET_PX);
    }
  });

  it("刚好放不下左开（差 1px）也照样拉回：面板右缘 = 2 + 288 = 290px", () => {
    const left = need - 1;
    expect(pickOutlinePanelSide(left)).toBe("right");
    expect(left + outlinePanelRightShift(left) + OUTLINE_PANEL_WIDTH_PX).toBe(
      OUTLINE_EDGE_INSET_PX + OUTLINE_PANEL_WIDTH_PX,
    );
  });

  it("比 2px 更靠左 / 负数 / 量不出来（NaN、±Infinity）→ 0：只往左拉，不往右推、不乱飞", () => {
    expect(outlinePanelRightShift(1)).toBe(0);
    expect(outlinePanelRightShift(0)).toBe(0);
    expect(outlinePanelRightShift(-10)).toBe(0);
    expect(outlinePanelRightShift(Number.NaN)).toBe(0);
    expect(outlinePanelRightShift(Number.POSITIVE_INFINITY)).toBe(0);
    expect(outlinePanelRightShift(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("落点常量是 left-0.5（0.125rem）的像素值", () => {
    expect(OUTLINE_EDGE_INSET_PX).toBe(0.125 * 16);
  });
});

describe("resolveActiveOutlineId：视口顶项所在的那一轮", () => {
  const items = [
    { id: "u1", kind: "user_reply" },
    { id: "a1", kind: "assistant_message" },
    { id: "g1", kind: "__work_group__", members: [{ id: "t1", kind: "tool_call" }, { id: "u2", kind: "user_reply" }, { id: "t2", kind: "tool_call" }] },
    { id: "a2", kind: "assistant_message" },
    { id: "s1", kind: "action_start" },
    { id: "a3", kind: "assistant_message" },
  ];

  it("顶项自己就是提问 → 它自己", () => {
    expect(resolveActiveOutlineId(items, 0)).toBe("u1");
    expect(resolveActiveOutlineId(items, 4)).toBe("s1");
  });

  it("顶项在一轮中间 → 往上找最近的提问", () => {
    expect(resolveActiveOutlineId(items, 1)).toBe("u1");
    expect(resolveActiveOutlineId(items, 5)).toBe("s1");
  });

  it("工作过程组里夹着提问（成员）：从成员里取最靠后的那个", () => {
    expect(resolveActiveOutlineId(items, 2)).toBe("u2");
    expect(resolveActiveOutlineId(items, 3)).toBe("u2");
  });

  it("窗口顶上没有提问（长一轮的中段）→ null；空列表 / 负下标 → null", () => {
    expect(resolveActiveOutlineId([{ id: "a", kind: "assistant_message" }], 0)).toBeNull();
    expect(resolveActiveOutlineId([], 0)).toBeNull();
    expect(resolveActiveOutlineId(items, -1)).toBeNull();
  });

  it("下标越界（列表刚缩短）→ 钳到末项、不抛", () => {
    expect(resolveActiveOutlineId(items, 999)).toBe("s1");
  });
});

describe("resolveVisibleActiveId：当前轮是被隐藏的定时触发项", () => {
  const full = [item("a", 1), item("s", 2, { schedule: true }), item("b", 3)];
  const visible = visibleOutline(full, false);

  it("当前轮就是可见项 → 原样", () => {
    expect(resolveVisibleActiveId(visible, full, "b")).toBe("b");
  });
  it("当前轮是隐藏的定时项 → 落到它之前最近的可见项", () => {
    expect(resolveVisibleActiveId(visible, full, "s")).toBe("a");
  });
  it("隐藏的定时项前面没有可见项 → null", () => {
    const f = [item("s", 1, { schedule: true }), item("a", 2)];
    expect(resolveVisibleActiveId(visibleOutline(f, false), f, "s")).toBeNull();
  });
  it("没有 / 认不出的 id → null（没隐藏任何项时，不在表里就是认不出）", () => {
    expect(resolveVisibleActiveId(visible, full, null)).toBeNull();
    const plain = [item("a", 1), item("b", 2)];
    expect(resolveVisibleActiveId(plain, plain, "zzz")).toBeNull();
    expect(resolveVisibleActiveId(visible, full, "zzz")).toBeNull();
  });
});

describe("时间 / 日期展示", () => {
  it("formatOutlineTime：HH:mm（本地时区）", () => {
    const d = new Date(2026, 9, 5, 9, 7);
    expect(formatOutlineTime(d.getTime())).toBe("09:07");
  });

  it("formatOutlineDay：今天 / 昨天 / MM-DD / 跨年带年份", () => {
    const now = new Date(2026, 9, 23, 12, 0).getTime();
    expect(formatOutlineDay(new Date(2026, 9, 23, 0, 1).getTime(), now)).toBe("今天");
    expect(formatOutlineDay(new Date(2026, 9, 22, 23, 59).getTime(), now)).toBe("昨天");
    expect(formatOutlineDay(new Date(2026, 9, 1, 8, 0).getTime(), now)).toBe("10-01");
    expect(formatOutlineDay(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe("2025-12-31");
  });

  it("groupOutlineRows：每换一天插一行日期小标题，项目顺序不变", () => {
    const now = new Date(2026, 9, 23, 12, 0).getTime();
    const day1 = new Date(2026, 9, 22, 10, 0).getTime();
    const day2 = new Date(2026, 9, 23, 9, 0).getTime();
    const rows = groupOutlineRows(
      [item("a", day1), item("b", day1 + 1000), item("c", day2)],
      now,
    );
    expect(rows.map((r) => (r.type === "day" ? `# ${r.label}` : r.item.id))).toEqual([
      "# 昨天",
      "a",
      "b",
      "# 今天",
      "c",
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("createActiveOutlineStore：滚动热路径上的外部 store", () => {
  it("值没变不通知；变了通知；退订后不再通知", () => {
    const store = createActiveOutlineStore();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    expect(store.get()).toBeNull();
    store.set(null);
    expect(fn).not.toHaveBeenCalled();
    store.set("a");
    store.set("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe("a");
    store.set(null);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    store.set("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("通知期间退订 / 新订阅不影响本轮遍历", () => {
    const store = createActiveOutlineStore();
    const calls: string[] = [];
    const offA = store.subscribe(() => {
      calls.push("a");
      offA();
      store.subscribe(() => calls.push("late"));
    });
    store.subscribe(() => calls.push("b"));
    store.set("x");
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("fetchWithBackoff：取大纲失败的退避重试", () => {
  const fakeSleep = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it("第一次就成功：不等待、只调一次", async () => {
    const { waits, sleep } = fakeSleep();
    const run = vi.fn(async () => "ok");
    expect(await fetchWithBackoff(run, [10, 20], { sleep })).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("失败两次后成功：按给定间隔依次等待、共调 3 次", async () => {
    const { waits, sleep } = fakeSleep();
    let n = 0;
    const run = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error(`boom${n}`);
      return "ok";
    });
    expect(await fetchWithBackoff(run, [1500, 6000], { sleep })).toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1500, 6000]);
  });

  it("全部失败：抛最后一次的错、次数 = 1 + 间隔数", async () => {
    const { waits, sleep } = fakeSleep();
    let n = 0;
    const run = vi.fn(async () => {
      n += 1;
      throw new Error(`boom${n}`);
    });
    await expect(fetchWithBackoff(run, [1, 2], { sleep })).rejects.toThrow("boom3");
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1, 2]);
    // 间隔为空 = 不重试
    run.mockClear();
    await expect(fetchWithBackoff(run, [], { sleep })).rejects.toThrow("boom4");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("T-5：shouldRetry 返回 false（比如任务已删的 404）→ 立刻抛、不等待、不再试", async () => {
    const { waits, sleep } = fakeSleep();
    const gone = Object.assign(new Error("not found"), { status: 404 });
    const run = vi.fn(async () => {
      throw gone;
    });
    await expect(
      fetchWithBackoff(run, [1500, 6000], {
        sleep,
        shouldRetry: (e) => (e as { status?: number }).status !== 404,
      }),
    ).rejects.toBe(gone);
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);

    // 对照：同样的间隔、换一个该重试的错（503）→ 走完全部重试
    const down = Object.assign(new Error("down"), { status: 503 });
    const run2 = vi.fn(async () => {
      throw down;
    });
    await expect(
      fetchWithBackoff(run2, [1, 2], {
        sleep,
        shouldRetry: (e) => (e as { status?: number }).status !== 404,
      }),
    ).rejects.toBe(down);
    expect(run2).toHaveBeenCalledTimes(3);
  });

  it("已经 abort：一次都不发", async () => {
    const ac = new AbortController();
    ac.abort();
    const run = vi.fn(async () => "ok");
    await expect(fetchWithBackoff(run, [1], { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("等待期间 abort：不再发下一次请求（切任务 / 回退时作废上一轮）", async () => {
    const ac = new AbortController();
    const run = vi.fn(async () => {
      throw new Error("down");
    });
    // 第一次失败后进入等待、等待中 abort
    const p = fetchWithBackoff(run, [60_000], { signal: ac.signal });
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("默认的等待是真的 setTimeout（间隔 5ms 的真实重试能走通）", async () => {
    let n = 0;
    const out = await fetchWithBackoff(
      async () => {
        n += 1;
        if (n < 2) throw new Error("once");
        return n;
      },
      [5],
    );
    expect(out).toBe(2);
  });
});
