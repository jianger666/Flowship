/**
 * 思考快照：切走再切回 / SSE 重连之后，进行中的思考不丢、不从第一个字重新吐。
 *
 * 背景（2026-10-13 用户反馈「首轮思考很长，我切窗口再切回来，那个思考好像又是从第一个字开始吐」）。
 * 浏览器实测复现（400 字/秒的思考，已累积 1772 字时切走）：
 *  - 切到另一个对话再切回（ChatView 卸载重挂）：文本区只剩切回之后新到的字，len 从 36 起步重新长，
 *    前面累积的几千字全没了；
 *  - SSE 被动断流重连（页面没卸载）：bootstrap 回放历史事件时「任何落盘事件到达就清实时态」，
 *    文本区先消失、再从重连后的第一批重新长。
 * 根因：实时思考只存在于 ChatView 的本地 state，服务端是纯内存帧、从不回放——
 * 任何「重新订阅」都等于从零开始。
 *
 * 修法：服务端记住「进行中的那一段」，新订阅者 bootstrap 时补一帧快照（thinking_snapshot）；
 * 前端用快照重建实时态，并且「快照里已有的内容直接显示」（base），只有之后新到的字才平滑吐出。
 * 回到前台（rAF 在后台暂停，积压几千字）同理：没在看的时候长出来的字不用演。
 *
 * 本文件测前端的纯逻辑 + 它们拼在一起的整体行为（模拟时钟，不含 React / rAF）：
 *   applyThinkingSnapshot  快照 → 实时态（新挂载 / 同段重连 / 换段 / 脏数据）
 *   liveThinkingFloor      位置的下限（窗口起点与 base 取大）
 *   stepLiveReveal / skipLiveReveal  位置推进与「直接跳到最新」
 */
import { describe, expect, it } from "vitest";

import { createRevealer } from "../src/lib/smooth-reveal";
import {
  advanceLiveThinking,
  applyThinkingSnapshot,
  liveThinkingFloor,
  liveThinkingOffset,
  liveThinkingTotal,
  revealLiveThinking,
  skipLiveReveal,
  stepLiveReveal,
  THINKING_TEXT_MAX,
  type LiveThinking,
  type ThinkingSnapshot,
} from "../src/lib/thinking-live";

const FRAME_MS = 1000 / 60;
const BATCH_MS = 250;
const NOW = 1_700_000_000_000;

/** 可识别的批：第 b 批 = 5 位编号 + 点补足到 40 字，全文里每个位置都能对上号 */
const batch = (b: number): string => String(b).padStart(5, "0").padEnd(40, ".");
const fullOf = (n: number): string =>
  Array.from({ length: n }, (_, b) => batch(b)).join("");

const snapOf = (
  id: string,
  text: string,
  total = text.length,
  since = NOW,
): ThinkingSnapshot => ({ id, text, total, since });

describe("applyThinkingSnapshot：快照 → 实时态", () => {
  it("快照为 null = 服务端说「此刻没有进行中的思考」→ 清（无论本地有没有）", () => {
    expect(applyThinkingSnapshot(null, null, NOW)).toBeNull();
    const prev = advanceLiveThinking(null, "e1", "abc", NOW);
    expect(applyThinkingSnapshot(prev, null, NOW)).toBeNull();
  });

  it("本地没有实时态（刚挂载 / 切回来）：整段按快照重建，起点用服务端的首帧时刻，base = 快照末尾（里面的字不再演一遍）", () => {
    const text = fullOf(10);
    const live = applyThinkingSnapshot(null, snapOf("e1", text, text.length, NOW - 42_000), NOW)!;
    expect(live).toEqual({
      id: "e1",
      text,
      total: text.length,
      since: NOW - 42_000,
      base: text.length,
    });
  });

  it("本地是另一段思考（id 不同）：旧段的文本 / 起点都不能带过来", () => {
    const prev = advanceLiveThinking(null, "old", "旧的一段", NOW - 99_000);
    const live = applyThinkingSnapshot(prev, snapOf("e2", "新的一段", 4, NOW - 5_000), NOW)!;
    expect(live.id).toBe("e2");
    expect(live.text).toBe("新的一段");
    expect(live.since).toBe(NOW - 5_000);
    expect(live.base).toBe(4);
  });

  it("同一段、服务端比本地多（断线期间又长了字）：文本与累计数更新，起点沿用本地（计时不跳），base 沿用本地（位置不被快照拽走）", () => {
    let prev = advanceLiveThinking(null, "e1", batch(0), NOW);
    prev = advanceLiveThinking(prev, "e1", batch(1), NOW + 250);
    const text = fullOf(6);
    const live = applyThinkingSnapshot(prev, snapOf("e1", text, text.length, NOW - 3), NOW + 9_000)!;
    expect(live.text).toBe(text);
    expect(liveThinkingTotal(live)).toBe(text.length);
    expect(live.since).toBe(NOW); // 本地的起点，不是快照里的
    expect(live.base).toBeUndefined(); // 本地没有 base（一路在线）→ 不凭空多出一个

    const withBase: LiveThinking = { ...prev, base: 17 };
    expect(applyThinkingSnapshot(withBase, snapOf("e1", text), NOW)!.base).toBe(17);
  });

  it("同一段、本地不比服务端旧（total ≥ 快照）：原对象原样返回（引用稳定，下游 memo 不重算；位置也不会被回拨）", () => {
    let prev = advanceLiveThinking(null, "e1", batch(0), NOW);
    prev = advanceLiveThinking(prev, "e1", batch(1), NOW);
    expect(applyThinkingSnapshot(prev, snapOf("e1", batch(0)), NOW)).toBe(prev);
    expect(applyThinkingSnapshot(prev, snapOf("e1", batch(0) + batch(1)), NOW)).toBe(prev);
  });

  it("快照文本超过前端保留上限：只留尾部，累计数不变，窗口起点（offset）= 累计数 − 留下的长度", () => {
    const big = "x".repeat(THINKING_TEXT_MAX + 500);
    const live = applyThinkingSnapshot(null, snapOf("e1", big, 50_000), NOW)!;
    expect(live.text.length).toBeLessThanOrEqual(THINKING_TEXT_MAX);
    expect(live.text.length).toBeGreaterThan(THINKING_TEXT_MAX - 2);
    expect(liveThinkingTotal(live)).toBe(50_000);
    expect(liveThinkingOffset(live)).toBe(50_000 - live.text.length);
  });

  it("服务端自己已经截过尾（text 是窗口、total 是累计）：坐标原样保留", () => {
    const window = "y".repeat(THINKING_TEXT_MAX);
    const live = applyThinkingSnapshot(null, snapOf("e1", window, 123_456), NOW)!;
    expect(liveThinkingTotal(live)).toBe(123_456);
    expect(liveThinkingOffset(live)).toBe(123_456 - THINKING_TEXT_MAX);
    expect(live.base).toBe(123_456);
  });

  it("脏数据不扩散：累计数 < 文本长度 / NaN / 负数 → 按文本长度；起点非有限 → 用 now", () => {
    for (const total of [3, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const live = applyThinkingSnapshot(null, snapOf("e1", "abcdefgh", total, Number.NaN), NOW)!;
      expect(liveThinkingTotal(live)).toBe(8);
      expect(liveThinkingOffset(live)).toBe(0);
      expect(live.since).toBe(NOW);
      expect(live.base).toBe(8);
    }
  });

  it("截尾切点落在 emoji 中间不会剩一个孤立的低代理项（继承累积时的口径），多丢的那一个算在 offset 里", () => {
    // 末尾多一个单码元字符：总长 2×MAX+1，切点 = MAX+1（奇数）正好落在某个 emoji 的两个码元之间
    const text = "😀".repeat(THINKING_TEXT_MAX) + "x";
    expect(text.charCodeAt(text.length - THINKING_TEXT_MAX) >= 0xdc00).toBe(true); // 前提：切点确实落在低代理项上
    const live = applyThinkingSnapshot(null, snapOf("e1", text, text.length), NOW)!;
    const first = live.text.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(live.text.length).toBe(THINKING_TEXT_MAX - 1);
    expect(liveThinkingOffset(live)).toBe(text.length - live.text.length);
  });
});

describe("advanceLiveThinking 要保留 base（否则重挂后的位置下限在第一批新字到达时就丢了）", () => {
  it("同段追加：base 原样带着；换段：不带上一段的 base", () => {
    const snap = applyThinkingSnapshot(null, snapOf("e1", fullOf(5)), NOW)!;
    const next = advanceLiveThinking(snap, "e1", batch(5), NOW + 250);
    expect(next.base).toBe(snap.base);
    expect(liveThinkingTotal(next)).toBe(liveThinkingTotal(snap) + 40);

    const other = advanceLiveThinking(snap, "e2", "新段", NOW + 500);
    expect(other.base).toBeUndefined();
  });

  it("没有 base 的实时态追加后仍然没有（不凭空多出这个字段）", () => {
    const a = advanceLiveThinking(null, "e1", "x", NOW);
    const b = advanceLiveThinking(a, "e1", "y", NOW);
    expect("base" in b).toBe(false);
  });
});

describe("liveThinkingFloor：位置的下限 = 窗口起点与 base 取大，夹在 [0, 累计数]", () => {
  const mk = (over: Partial<LiveThinking>): LiveThinking => ({
    id: "e1",
    text: "0123456789",
    since: NOW,
    ...over,
  });

  it("没有 base、没截过尾 → 0", () => {
    expect(liveThinkingFloor(mk({}))).toBe(0);
  });

  it("base 落在窗口里 → base", () => {
    expect(liveThinkingFloor(mk({ base: 6 }))).toBe(6);
  });

  it("窗口起点在 base 前面 / 后面：取大的那个（头部已被截掉的字没法「显示」）", () => {
    // total 100、text 10 字 → 窗口起点 90
    expect(liveThinkingFloor(mk({ total: 100, base: 30 }))).toBe(90);
    expect(liveThinkingFloor(mk({ total: 100, base: 95 }))).toBe(95);
  });

  it("base 超过累计数（脏）夹到累计数；负数 / NaN 当没有", () => {
    expect(liveThinkingFloor(mk({ base: 99 }))).toBe(10);
    expect(liveThinkingFloor(mk({ base: -3 }))).toBe(0);
    expect(liveThinkingFloor(mk({ base: Number.NaN }))).toBe(0);
    expect(liveThinkingFloor(mk({ base: Number.POSITIVE_INFINITY }))).toBe(10);
  });
});

describe("stepLiveReveal：base 之前的字不演", () => {
  it("base = 累计数：第一帧位置就是全部，已追平；显示的是整段原文（原对象，引用稳定）", () => {
    const live = applyThinkingSnapshot(null, snapOf("e1", fullOf(20)), NOW)!;
    const r = createRevealer();
    const { len, done } = stepLiveReveal(r, live, 0);
    expect(len).toBe(live.text.length);
    expect(done).toBe(true);
    expect(revealLiveThinking(live, len)).toBe(live);
  });

  it("base < 累计数：从 base 起步，而不是从 0（第一帧就不低于 base）", () => {
    const live: LiveThinking = { id: "e1", text: fullOf(10), since: NOW, base: 200 };
    const r = createRevealer();
    const { len, done } = stepLiveReveal(r, live, 0);
    expect(len).toBeGreaterThanOrEqual(200);
    expect(len).toBeLessThan(live.text.length);
    expect(done).toBe(false);
  });

  it("没有 base 时与原行为一致：从 0 起步（回归）", () => {
    const live: LiveThinking = { id: "e1", text: fullOf(10), since: NOW };
    const r = createRevealer();
    const { len } = stepLiveReveal(r, live, 0);
    expect(len).toBeLessThan(20);
  });
});

describe("skipLiveReveal：回到前台，后台长出来的字直接显示", () => {
  it("位置直接到最新、已追平；积压多大都一样", () => {
    const r = createRevealer();
    const live: LiveThinking = { id: "e1", text: fullOf(100), since: NOW }; // 4000 字积压，位置还在 0
    const { len, done } = skipLiveReveal(r, live);
    expect(len).toBe(4000);
    expect(done).toBe(true);
    expect(r.position).toBe(4000);
    expect(revealLiveThinking(live, len)).toBe(live);
  });

  it("窗口已被截尾：位置 = 累计数（落在窗口里），不是文本长度", () => {
    const r = createRevealer();
    const live: LiveThinking = {
      id: "e1",
      text: "z".repeat(THINKING_TEXT_MAX),
      total: 70_000,
      since: NOW,
    };
    const { len } = skipLiveReveal(r, live);
    expect(len).toBe(70_000);
    expect(len - liveThinkingOffset(live)).toBe(THINKING_TEXT_MAX);
  });

  it("位置已经在最新时是幂等的", () => {
    const r = createRevealer();
    const live: LiveThinking = { id: "e1", text: fullOf(3), since: NOW };
    skipLiveReveal(r, live);
    expect(skipLiveReveal(r, live)).toEqual({ len: 120, done: true });
  });

  it("脏目标（NaN）不扩散：位置给 0、不抛", () => {
    const r = createRevealer();
    const live = { id: "e1", text: "ab", total: Number.NaN, since: NOW } as LiveThinking;
    const out = skipLiveReveal(r, live);
    expect(Number.isFinite(out.len)).toBe(true);
    expect(Number.isFinite(r.position)).toBe(true);
  });
});

// ---------------------------------------------------------------- 整体（模拟界面）

interface Frame {
  shown: LiveThinking;
  live: LiveThinking;
  len: number;
  done: boolean;
}

/**
 * 模拟一个「界面」：一批批到达、一帧帧推进。
 * restore = 组件卸载后重新挂载（hook 状态全部归零）+ 用服务端快照重建实时态——
 * 与 chat-view 的 applyThinkingSnapshot 接线、use-smooth-thinking 的渲染期初值（floor）一致。
 */
const makeSim = () => {
  let revealer = createRevealer();
  let live: LiveThinking | null = null;
  let now = 0;
  const frames: Frame[] = [];

  const frame = (): Frame => {
    now += FRAME_MS;
    if (!live) throw new Error("还没有实时态");
    const { len, done } = stepLiveReveal(revealer, live, now);
    const f: Frame = { shown: revealLiveThinking(live, len), live, len, done };
    frames.push(f);
    return f;
  };

  return {
    arrive: (chunk: string, id = "e1") => {
      live = advanceLiveThinking(live, id, chunk, now);
    },
    /** 同页重连：不卸载，只是用快照对齐 */
    reconnect: (snap: ThinkingSnapshot | null) => {
      live = applyThinkingSnapshot(live, snap, now);
    },
    /** 卸载 → 重新挂载：hook 状态归零，实时态从零开始，再被快照重建 */
    remount: (snap: ThinkingSnapshot | null) => {
      revealer = createRevealer();
      live = applyThinkingSnapshot(null, snap, now);
    },
    /** 回到前台 */
    foreground: () => {
      if (!live) return;
      const { len } = skipLiveReveal(revealer, live);
      frames.push({ shown: revealLiveThinking(live, len), live, len, done: true });
    },
    frame,
    run: (ms: number) => {
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) frame();
    },
    /** 标签页在后台：时间在走，但没有帧 */
    skip: (ms: number) => {
      now += ms;
    },
    revealer: () => revealer,
    frames,
    get live(): LiveThinking {
      return live!;
    },
  };
};

const cum = (f: Frame): number => liveThinkingOffset(f.shown) + f.shown.text.length;

describe("切走再切回（组件重挂）：重现用户场景", () => {
  it("切回来的第一帧就是切走前已累积的全部内容（修之前：只剩切回之后新到的字、从 0 起步重新长）", () => {
    // 切走前：思考 12 秒，累积 48 批，界面上吐到差不多
    const before = makeSim();
    for (let b = 0; b < 48; b++) {
      before.arrive(batch(b));
      before.run(BATCH_MS);
    }
    const shownBefore = cum(before.frames.at(-1)!);
    expect(shownBefore).toBeGreaterThan(1500);

    // 切走期间服务端又发了 17 批（组件卸载了，前端一批都没收到）；切回来：服务端的快照 = 全部 65 批
    const serverText = fullOf(65);
    const after = makeSim();
    after.remount(snapOf("e1", serverText, serverText.length, NOW - 16_250));
    const first = after.frame();

    expect(cum(first)).toBe(serverText.length); // 第一帧就是全部
    expect(first.shown.text).toBe(serverText);
    expect(first.shown.text.startsWith(batch(0))).toBe(true); // 开头还是第一个字，不是切回之后的第一批
    expect(first.done).toBe(true);
    expect(cum(first)).toBeGreaterThan(shownBefore); // 比切走前看到的还多（补上了切走期间的）
  });

  it("切回之后新到的字接着往后吐：位置从快照末尾起步、单调不减、每帧吐字量和稳态一样（没有狂刷，也没有从头再来）", () => {
    const serverText = fullOf(65);
    const sim = makeSim();
    sim.remount(snapOf("e1", serverText));
    sim.frame();
    const base = serverText.length;

    let prev = base;
    for (let b = 65; b < 105; b++) {
      sim.arrive(batch(b));
      for (let i = 0; i < Math.round(BATCH_MS / FRAME_MS); i++) {
        const f = sim.frame();
        expect(cum(f)).toBeGreaterThanOrEqual(prev);
        expect(cum(f)).toBeGreaterThanOrEqual(base); // 永远不会回到快照之前
        expect(f.shown.text.startsWith(batch(0))).toBe(true); // 开头始终是整段的第一个字
        prev = cum(f);
      }
    }
    sim.run(3000);
    expect(sim.frames.at(-1)!.shown).toBe(sim.live);
    expect(sim.live.text).toBe(fullOf(105));
  });

  it("切回之后的起步速度没有被「快照这一大块」带偏：稳态每帧吐字量和从头跑的一样", () => {
    const sim = makeSim();
    sim.remount(snapOf("e1", fullOf(65)));
    sim.frame();
    for (let b = 65; b < 125; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    // 160 字/秒 = 每帧 2.67 字；排除起步 3 秒
    const steady = sim.frames.slice(Math.round(3000 / FRAME_MS));
    const deltas: number[] = [];
    for (let i = 1; i < steady.length; i++) deltas.push(cum(steady[i]!) - cum(steady[i - 1]!));
    expect(Math.min(...deltas)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...deltas)).toBeLessThanOrEqual(4);
  });

  it("思考已经超过前端保留上限（窗口被截过尾）：切回来第一帧位置 = 累计数，显示的是窗口里的全部，恰好是全文的尾部", () => {
    const n = 800; // 800 × 40 = 32000 字 > THINKING_TEXT_MAX
    const full = fullOf(n);
    const window = full.slice(full.length - THINKING_TEXT_MAX);
    const sim = makeSim();
    sim.remount(snapOf("e1", window, full.length));
    const f = sim.frame();
    expect(cum(f)).toBe(full.length);
    expect(f.shown.text).toBe(window);
    expect(f.done).toBe(true);
    // 之后新到的一批：接在全文后面
    sim.arrive(batch(n));
    sim.run(3000);
    const last = sim.frames.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.shown.text.endsWith(batch(n))).toBe(true);
    expect(liveThinkingTotal(last.shown)).toBe(full.length + 40);
  });

  it("服务端说没有进行中的思考（重挂时这段已经落盘了）：不会凭空冒出实时文本", () => {
    const sim = makeSim();
    sim.remount(null);
    expect(() => sim.frame()).toThrow(); // 没有实时态可画
  });

  it("计时：起点沿用服务端的首帧时刻，「思考中 · 42s」不会因为切一下窗口归零", () => {
    const sim = makeSim();
    sim.remount(snapOf("e1", fullOf(10), 400, NOW - 42_000));
    expect(sim.live.since).toBe(NOW - 42_000);
    sim.arrive(batch(10));
    expect(sim.live.since).toBe(NOW - 42_000);
  });
});

describe("SSE 断流重连（页面没卸载）：同一段思考不回头", () => {
  it("重连快照比本地多：显示位置保持（不回 0、不闪空），缺的字作为积压追上去；最终与服务端一致", () => {
    const sim = makeSim();
    for (let b = 0; b < 30; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    const before = cum(sim.frames.at(-1)!);
    expect(before).toBeGreaterThan(800);

    // 断线 1.3 秒，期间服务端又发了 5 批；快照 = 35 批
    sim.skip(1300);
    sim.reconnect(snapOf("e1", fullOf(35)));

    let prev = before;
    for (let i = 0; i < 600; i++) {
      const f = sim.frame();
      expect(cum(f)).toBeGreaterThanOrEqual(prev); // 单调不减：不会回到 0 再重新吐
      expect(f.shown.text.startsWith(batch(0))).toBe(true);
      prev = cum(f);
      if (f.done) break;
    }
    const last = sim.frames.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.shown.text).toBe(fullOf(35));
  });

  it("重连后实时帧继续按增量到达：接在快照后面，不重复、不遗漏", () => {
    const sim = makeSim();
    for (let b = 0; b < 10; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    sim.reconnect(snapOf("e1", fullOf(14)));
    for (let b = 14; b < 20; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    sim.run(3000);
    expect(sim.frames.at(-1)!.shown.text).toBe(fullOf(20));
  });

  it("重连时快照说「已经没有进行中的思考」→ 清空；之后新一段是新的起点", () => {
    const sim = makeSim();
    sim.arrive(batch(0));
    sim.run(500);
    sim.reconnect(null);
    expect(() => sim.frame()).toThrow();
    sim.arrive("新一段", "e2");
    expect(sim.live.id).toBe("e2");
    expect(sim.live.text).toBe("新一段");
  });
});

describe("回到前台（rAF 在后台暂停、后台期间到了几千字）", () => {
  it("回前台这一刻位置直接到最新：没有「飞快刷一大段」的追赶；之后新字照常匀速吐", () => {
    const sim = makeSim();
    for (let b = 0; b < 20; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    const before = cum(sim.frames.at(-1)!);

    // 切后台 6 秒：rAF 不跑，但 SSE 照常到（24 批 = 960 字）
    for (let b = 20; b < 44; b++) {
      sim.arrive(batch(b));
      sim.skip(BATCH_MS);
    }
    sim.foreground();
    const fg = sim.frames.at(-1)!;
    expect(cum(fg)).toBe(sim.live.text.length);
    expect(cum(fg)).toBeGreaterThan(before + 900);

    // 回前台之后：每帧吐字量回到稳态（160 字/秒 ≈ 每帧 2.67 字），没有追赶的尾巴
    for (let b = 44; b < 84; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    const after = sim.frames.slice(sim.frames.indexOf(fg) + 1);
    const settled = after.slice(Math.round(2000 / FRAME_MS)); // 排除回前台后的前 2 秒
    const deltas: number[] = [];
    for (let i = 1; i < settled.length; i++) deltas.push(cum(settled[i]!) - cum(settled[i - 1]!));
    expect(Math.max(...deltas)).toBeLessThanOrEqual(4);
    // 回前台后的前 2 秒里，任何一帧吐的字都不应该超过稳态的 3 倍（修之前一帧能吐上千字）
    const early = after.slice(0, Math.round(2000 / FRAME_MS));
    for (let i = 1; i < early.length; i++) {
      expect(cum(early[i]!) - cum(early[i - 1]!)).toBeLessThanOrEqual(12);
    }
  });

  it("后台积压是「突发」，不能污染到达速率的估计（否则回前台之后的速度会飘）", () => {
    const sim = makeSim();
    for (let b = 0; b < 30; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    const rateBefore = sim.revealer().state.rate;
    for (let b = 30; b < 54; b++) {
      sim.arrive(batch(b));
      sim.skip(BATCH_MS);
    }
    sim.foreground();
    for (let b = 54; b < 94; b++) {
      sim.arrive(batch(b));
      sim.run(BATCH_MS);
    }
    const rateAfter = sim.revealer().state.rate;
    expect(rateAfter).toBeGreaterThan(rateBefore * 0.7);
    expect(rateAfter).toBeLessThan(rateBefore * 1.3);
  });
});
