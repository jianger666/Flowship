/**
 * run-prep-notes（src/lib/server/run-prep-notes.ts）单测
 *
 * 钉死的语义：
 * - 笔记「取走即清」、按 task 隔离：一份笔记只属于紧随其后的那一个 run
 * - 陈旧（>2min）的笔记不会串到下一个 run（resume 成功但 send 失败的场景）
 * - 条目封顶：长期运行不泄漏
 * - idle / 预热间隔：没见过 = null（不是 0），否则分析时会把「未知」当成「刚刚」
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRunPrepStateForTests,
  idleSinceLastRun,
  noteRunEnded,
  notePrep,
  noteWarmed,
  takePrep,
  warmedAgo,
} from "@/lib/server/run-prep-notes";

beforeEach(() => __resetRunPrepStateForTests());

const T0 = 1_000_000;

describe("notePrep / takePrep", () => {
  it("取走即清：第二次取到 null", () => {
    notePrep("t1", { stages: { resume: 120 } }, T0);
    expect(takePrep("t1", T0 + 10)?.stages).toEqual({ resume: 120 });
    expect(takePrep("t1", T0 + 20)).toBeNull();
  });

  it("没记过 → null", () => {
    expect(takePrep("nope", T0)).toBeNull();
  });

  it("task 之间互不串", () => {
    notePrep("t1", { stages: { a: 1 } }, T0);
    notePrep("t2", { stages: { b: 2 } }, T0);
    expect(takePrep("t2", T0)?.stages).toEqual({ b: 2 });
    expect(takePrep("t1", T0)?.stages).toEqual({ a: 1 });
  });

  it("同 task 多次记：stages / tags 浅合并（后写覆盖同键），mcp 以新的为准", () => {
    const mcp1 = { total: 1, cacheHits: 1, fresh: 1, stale: 0, probedSync: 0, staleRefreshedInGrace: 0, waitMs: 0 };
    const mcp2 = { ...mcp1, fresh: 0, probedSync: 1, cacheHits: 0, waitMs: 800 };
    notePrep("t1", { stages: { resume: 100, mcp: 5 }, tags: { path: "resume" }, mcp: mcp1 }, T0);
    notePrep("t1", { stages: { mcp: 800, checkpoint: 30 }, tags: { via: "inject" }, mcp: mcp2 }, T0 + 50);
    const got = takePrep("t1", T0 + 60)!;
    expect(got.stages).toEqual({ resume: 100, mcp: 800, checkpoint: 30 });
    expect(got.tags).toEqual({ path: "resume", via: "inject" });
    expect(got.mcp).toEqual(mcp2);
  });

  it("后写没带 mcp → 沿用先写的 mcp（不被 undefined 覆盖）", () => {
    const mcp = { total: 2, cacheHits: 2, fresh: 2, stale: 0, probedSync: 0, staleRefreshedInGrace: 0, waitMs: 1 };
    notePrep("t1", { mcp }, T0);
    notePrep("t1", { stages: { x: 1 } }, T0 + 1);
    expect(takePrep("t1", T0 + 2)?.mcp).toEqual(mcp);
  });
});

describe("陈旧笔记不串 run", () => {
  it("超过 2 分钟没人取 → takePrep 返回 null", () => {
    notePrep("t1", { stages: { resume: 1 } }, T0);
    expect(takePrep("t1", T0 + 2 * 60_000 + 1)).toBeNull();
  });

  it("临界内（<2 分钟）仍可取", () => {
    notePrep("t1", { stages: { resume: 1 } }, T0);
    expect(takePrep("t1", T0 + 2 * 60_000 - 1)?.stages).toEqual({ resume: 1 });
  });

  it("新笔记不继承陈旧的旧笔记（resume 的残留不会混进下一轮）", () => {
    notePrep("t1", { stages: { resume: 999 }, tags: { path: "resume" } }, T0);
    notePrep("t1", { stages: { create: 5 } }, T0 + 10 * 60_000);
    const got = takePrep("t1", T0 + 10 * 60_000 + 1)!;
    expect(got.stages).toEqual({ create: 5 });
    expect(got.tags ?? {}).toEqual({});
  });
});

describe("idle / 预热间隔", () => {
  it("没见过 → null（不是 0）", () => {
    expect(idleSinceLastRun("t1", T0)).toBeNull();
    expect(warmedAgo("t1", T0)).toBeNull();
  });

  it("返回差值；now 早于记录时夹到 0", () => {
    noteRunEnded("t1", T0);
    noteWarmed("t1", T0 + 100);
    expect(idleSinceLastRun("t1", T0 + 5000)).toBe(5000);
    expect(warmedAgo("t1", T0 + 600)).toBe(500);
    expect(idleSinceLastRun("t1", T0 - 1)).toBe(0);
  });

  it("后一次覆盖前一次", () => {
    noteRunEnded("t1", T0);
    noteRunEnded("t1", T0 + 1000);
    expect(idleSinceLastRun("t1", T0 + 1500)).toBe(500);
  });

  it("takePrep 不影响 idle / 预热状态（它们是跨 run 的）", () => {
    noteRunEnded("t1", T0);
    notePrep("t1", { stages: { a: 1 } }, T0);
    takePrep("t1", T0);
    expect(idleSinceLastRun("t1", T0 + 10)).toBe(10);
  });
});

describe("容量封顶（长期运行不泄漏）", () => {
  it("写入 250 个 task：最旧的被淘汰、最新的都在", () => {
    for (let i = 0; i < 250; i++) notePrep(`t${i}`, { stages: { i } }, T0);
    expect(takePrep("t0", T0)).toBeNull();
    expect(takePrep("t49", T0)).toBeNull();
    expect(takePrep("t50", T0)?.stages).toEqual({ i: 50 });
    expect(takePrep("t249", T0)?.stages).toEqual({ i: 249 });
  });

  it("idle 表同样封顶", () => {
    for (let i = 0; i < 250; i++) noteRunEnded(`t${i}`, T0);
    expect(idleSinceLastRun("t0", T0)).toBeNull();
    expect(idleSinceLastRun("t249", T0 + 1)).toBe(1);
  });

  it("反复写同一个 task 会刷新它的新旧顺序（最近用过的不被淘汰）", () => {
    for (let i = 0; i < 200; i++) notePrep(`t${i}`, { stages: { i } }, T0);
    notePrep("t0", { stages: { again: 1 } }, T0 + 1); // t0 变成最新
    for (let i = 200; i < 230; i++) notePrep(`t${i}`, { stages: { i } }, T0 + 2);
    expect(takePrep("t0", T0 + 3)).not.toBeNull();
    expect(takePrep("t1", T0 + 3)).toBeNull(); // 次旧的被淘汰
  });
});
