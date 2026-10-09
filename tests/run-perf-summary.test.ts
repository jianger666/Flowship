/**
 * run 汇总记录（run-perf.ts 的收口 / 看门狗 / 笔记带入）集成单测
 *
 * 钉死的语义（每条都对应一个「不钉就会悄悄出错」的坑）：
 * - outcome 以 SDK 终态回调为准：turn-ended 之后若 run 实际是 error / cancelled，不能被记成 ok
 * - 收口幂等：一个 run 只写一条记录，迟到的任何事件都被忽略
 * - 看门狗：send 没受理 → never-attached；受理后永无终态 → timeout（6h，不误伤长任务）
 * - 受理前笔记「取走即清」、idle 间隔跨 run 保留
 * - 隐私：命令 / 输出 / 参数内容绝不进记录
 * - 观测故障（sink 抛 / env 抛）绝不影响主流程；单测环境不带 sink 时零开销（不去取环境快照）
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InteractionUpdate } from "@cursor/sdk";

import type { RunPerfRecord } from "@/lib/server/run-perf-record";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-run-perf-summary-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { createRunPerfTracker, __setRunPerfEnvProviderForTests } = await import(
  "@/lib/server/run-perf"
);
const prepNotes = await import("@/lib/server/run-prep-notes");

type RunStatus = "running" | "finished" | "error" | "cancelled";
type Tracker = ReturnType<typeof createRunPerfTracker>;

const fakeEnv = async () => ({
  proc: { rssMB: 321, heapMB: 100, load1: 1.5, uptimeS: 10, activeRuns: 0 },
  store: { mode: "fast", blobs: 12, mb: 3.4, agentBlobs: 4, agentMB: 1.2 },
});

let records: RunPerfRecord[] = [];
const sink = (r: RunPerfRecord): void => {
  records.push(r);
};

beforeEach(() => {
  records = [];
  prepNotes.__resetRunPrepStateForTests();
  __setRunPerfEnvProviderForTests(fakeEnv);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setRunPerfEnvProviderForTests();
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 假 run：可手动触发状态变更；callbacks=false 模拟没有终态回调能力 */
const mkRun = (opts: { callbacks?: boolean; status?: RunStatus } = {}) => {
  const listeners = new Set<(s: RunStatus) => void>();
  const run: {
    id: string;
    requestId: string;
    status: RunStatus;
    onDidChangeStatus?: (l: (s: RunStatus) => void) => () => void;
    fire: (s: RunStatus) => void;
    subscribers: () => number;
  } = {
    id: "run-1",
    requestId: "req-1",
    status: opts.status ?? "running",
    fire(s) {
      run.status = s;
      for (const l of [...listeners]) l(s);
    },
    subscribers: () => listeners.size,
  };
  if (opts.callbacks !== false) {
    run.onDidChangeStatus = (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    };
  }
  return run;
};

const feed = (t: Tracker, update: unknown): void =>
  t.onDelta({ update: update as InteractionUpdate });

const turnEnded = (t: Tracker): void =>
  feed(t, {
    type: "turn-ended",
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 },
  });

const mk = (over: Partial<Parameters<typeof createRunPerfTracker>[0]> = {}): Tracker =>
  createRunPerfTracker({ taskId: "t1", agentId: "a1", runKind: "chat-followup", sink, ...over });

const activeRuns = (): number =>
  (globalThis as unknown as { __fePerfActiveRuns?: number }).__fePerfActiveRuns ?? 0;

describe("完整一轮", () => {
  it("事件序列 → 恰好一条记录，字段对得上；env 快照并入", async () => {
    const t = mk({ promptBytes: 4096, model: { id: "m1", params: [{ id: "thinking", value: "true" }] } });
    const run = mkRun();
    t.attachRun(run);
    feed(t, { type: "thinking-delta", text: "x" });
    feed(t, { type: "thinking-completed", thinkingDurationMs: 800 });
    feed(t, { type: "tool-call-started", callId: "c1", toolCall: { type: "shell", args: {} } });
    feed(t, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: { type: "shell", args: {}, result: { status: "success", value: { executionTime: 50 } } },
    });
    feed(t, { type: "step-completed", stepId: "s1", stepDurationMs: 1200 });
    turnEnded(t);
    expect(records).toHaveLength(0); // turn-ended 之后还要等终态回调定 outcome

    run.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    const r = records[0];
    expect(r).toMatchObject({
      v: 1,
      taskId: "t1",
      kind: "chat-followup",
      agentId: "a1",
      runId: "run-1",
      requestId: "req-1",
      model: "m1",
      modelParams: "thinking=true",
      outcome: "finished",
      promptBytes: 4096,
      steps: 1,
      stepMsMax: 1200,
      toolCount: 1,
      toolErrors: 0,
      thinkingMs: 800,
      firstDeltaType: "thinking-delta",
      tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 0 },
      proc: { rssMB: 321 },
      store: { mode: "fast", agentBlobs: 4 },
      platform: process.platform,
    });
    expect(r.tools.shell).toMatchObject({ n: 1, errors: 0, sdkExecSum: 50 });
    expect(r.tools.shell.wallSum).toBeGreaterThanOrEqual(0);
    expect(typeof r.ts).toBe("string");
  });

  it("时序字段：相对 send 发起（用假时钟精确断言）", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const t = mk();
    await vi.advanceTimersByTimeAsync(40);
    const run = mkRun();
    t.attachRun(run); // 受理 @ +40
    await vi.advanceTimersByTimeAsync(2_500);
    feed(t, { type: "thinking-delta", text: "x" }); // 首 token @ +2540
    await vi.advanceTimersByTimeAsync(460);
    feed(t, { type: "tool-call-started", callId: "c1", toolCall: { type: "read", args: {} } }); // 首工具 @ +3000
    await vi.advanceTimersByTimeAsync(6_000);
    run.fire("finished"); // 结束 @ +9000
    await vi.advanceTimersByTimeAsync(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ acceptMs: 40, firstDeltaMs: 2_540, ttftMs: 2_500, firstToolMs: 3_000, totalMs: 9_000 });
  });
});

describe("outcome 以终态回调为准", () => {
  it("turn-ended 之后 run 实际是 error → 记 error，不是 ok", async () => {
    const t = mk();
    const run = mkRun();
    t.attachRun(run);
    turnEnded(t);
    run.fire("error");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].outcome).toBe("error");
  });

  it("用户取消（先收到 cancelled）→ 记 cancelled；之后迟到的 turn-ended 被忽略、仍只有一条", async () => {
    const t = mk();
    const run = mkRun();
    t.attachRun(run);
    run.fire("cancelled");
    turnEnded(t);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("cancelled");
  });

  it("run 没有终态回调能力：turn-ended 就是唯一信号，立即记 ok", async () => {
    const t = mk();
    const run = mkRun({ callbacks: false });
    t.attachRun(run);
    turnEnded(t);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].outcome).toBe("ok");
  });

  it("attachRun 时 run 已经是终态（极快的 run）→ 当场按它收口", async () => {
    const t = mk();
    t.attachRun(mkRun({ status: "finished" }));
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].outcome).toBe("finished");
  });

  it("turn-ended 先于 attachRun（delta 抢在 send resolve 之前）：attach 后正常收口", async () => {
    const t = mk();
    turnEnded(t);
    expect(records).toHaveLength(0);
    const run = mkRun({ callbacks: false });
    t.attachRun(run);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].outcome).toBe("ok");
  });

  it("收口幂等：finished 之后再来 error / turn-ended 都不再写", async () => {
    const t = mk();
    const run = mkRun();
    t.attachRun(run);
    run.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    run.fire("error");
    turnEnded(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("finished");
  });

  it("收口后退订终态回调（不留监听器）", async () => {
    const t = mk();
    const run = mkRun();
    t.attachRun(run);
    expect(run.subscribers()).toBe(1);
    run.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(run.subscribers()).toBe(0);
  });
});

describe("看门狗与宽限（假时钟）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 5_000_000 });
  });

  it("send 之后始终没 attachRun（受理前就失败）→ 5 分钟记 never-attached，且没有 runId", async () => {
    mk();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(records).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("never-attached");
    expect("runId" in records[0]).toBe(false);
  });

  it("attachRun 之后不再触发 never-attached；受理后永无终态 → 6 小时记 timeout（不误伤长任务）", async () => {
    const t = mk();
    t.attachRun(mkRun());
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(records).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000); // 已跑 3 小时的长任务：不能被判 timeout
    expect(records).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("timeout");
  });

  it("turn-ended 后终态回调迟迟不来：宽限 2s 到点按 ok 兜底", async () => {
    const t = mk();
    t.attachRun(mkRun());
    turnEnded(t);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(records).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("ok");
  });

  it("宽限期内终态到达：以终态为准，宽限定时器被取消（不会再多写一条 ok）", async () => {
    const t = mk();
    const run = mkRun();
    t.attachRun(run);
    turnEnded(t);
    await vi.advanceTimersByTimeAsync(500);
    run.fire("error");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("error");
  });
});

describe("跨 run 状态与受理前笔记", () => {
  it("受理前笔记并入记录并「取走即清」；idle 间隔跨 run 保留；预热标记带入", async () => {
    const mcp = { total: 2, cacheHits: 1, fresh: 0, stale: 1, probedSync: 1, staleRefreshedInGrace: 0, waitMs: 420 };
    prepNotes.notePrep("t2", { stages: { resume: 1500, mcp: 12 }, tags: { path: "resume" }, mcp });
    prepNotes.noteWarmed("t2");

    const t1 = mk({ taskId: "t2" });
    const run1 = mkRun();
    t1.attachRun(run1);
    run1.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].prep).toEqual({ resume: 1500, mcp: 12 });
    expect(records[0].tags).toEqual({ path: "resume" });
    expect(records[0].mcp).toEqual(mcp);
    expect(typeof records[0].warmedAgoMs).toBe("number");
    expect("idleBeforeMs" in records[0]).toBe(false); // 本进程没见过这个 task 的上一个 run

    await new Promise((r) => setTimeout(r, 30));
    const t2 = mk({ taskId: "t2" });
    const run2 = mkRun();
    t2.attachRun(run2);
    run2.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect("prep" in records[1]).toBe(false); // 取走即清：不会串到下一个 run
    expect("mcp" in records[1]).toBe(false);
    expect(records[1].idleBeforeMs).toBeGreaterThanOrEqual(20);
  });

  it("陈旧笔记（resume 之后 send 失败、没创建 tracker）不会串进下一个 run", async () => {
    prepNotes.notePrep("t3", { stages: { resume: 999 } }, Date.now() - 3 * 60_000);
    const t = mk({ taskId: "t3" });
    const run = mkRun();
    t.attachRun(run);
    run.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect("prep" in records[0]).toBe(false);
  });

  it("在飞计数：创建 +1、收口 −1", async () => {
    const before = activeRuns();
    const t = mk();
    expect(activeRuns()).toBe(before + 1);
    const run = mkRun();
    t.attachRun(run);
    run.fire("finished");
    expect(activeRuns()).toBe(before);
    run.fire("error"); // 迟到事件不得重复扣减
    expect(activeRuns()).toBe(before);
  });
});

describe("隐私：内容绝不进记录", () => {
  it("命令 / 参数 / 输出 / 路径里的敏感串不出现在序列化记录里", async () => {
    const t = mk({ promptBytes: 100 });
    const run = mkRun();
    t.attachRun(run);
    feed(t, { type: "tool-call-started", callId: "c1", toolCall: { type: "shell", args: { command: "curl -H 'Authorization: TOPSECRET-CMD'" } } });
    feed(t, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: {
        type: "shell",
        args: { command: "curl TOPSECRET-CMD", cwd: "/Users/someone/TOPSECRET-PATH" },
        result: { status: "success", value: { stdout: "TOPSECRET-OUT", stderr: "TOPSECRET-ERR", executionTime: 5 } },
      },
    });
    feed(t, { type: "text-delta", text: "TOPSECRET-TEXT" });
    feed(t, { type: "thinking-completed", thinkingDurationMs: 10, text: "TOPSECRET-THINK" });
    turnEnded(t);
    run.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(JSON.stringify(records[0])).not.toContain("TOPSECRET");
  });
});

describe("观测故障绝不影响主流程", () => {
  it("sink 抛错：attachRun / 终态回调都不向外抛，只 debug 出声", async () => {
    const t = createRunPerfTracker({
      taskId: "t1",
      agentId: "a1",
      runKind: "k",
      sink: () => {
        throw new Error("sink boom");
      },
    });
    const run = mkRun();
    expect(() => t.attachRun(run)).not.toThrow();
    expect(() => run.fire("finished")).not.toThrow();
    await vi.waitFor(() => expect(console.debug).toHaveBeenCalled());
  });

  it("env 快照抛错：不写记录、不抛、不影响后续 run", async () => {
    __setRunPerfEnvProviderForTests(async () => {
      throw new Error("env boom");
    });
    const t = mk();
    const run = mkRun();
    t.attachRun(run);
    expect(() => run.fire("finished")).not.toThrow();
    await vi.waitFor(() => expect(console.debug).toHaveBeenCalled());
    expect(records).toHaveLength(0);

    __setRunPerfEnvProviderForTests(fakeEnv);
    const t2 = mk({ taskId: "t9" });
    const run2 = mkRun();
    t2.attachRun(run2);
    run2.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
  });

  it("run.onDidChangeStatus 订阅时抛错：退回 turn-ended 兜底，不抛", async () => {
    const t = mk();
    const run = {
      id: "r",
      requestId: "q",
      status: "running" as const,
      onDidChangeStatus: () => {
        throw new Error("subscribe boom");
      },
    };
    expect(() => t.attachRun(run)).not.toThrow();
    turnEnded(t);
    await vi.waitFor(() => expect(records).toHaveLength(1), { timeout: 3_000 });
    expect(records[0].outcome).toBe("ok");
  });

  it("单测环境不带 sink：整条汇总链路跳过（不去取环境快照）——其余 mock 链路的测试零开销", async () => {
    const spy = vi.fn(fakeEnv);
    __setRunPerfEnvProviderForTests(spy);
    const t = createRunPerfTracker({ taskId: "t1", agentId: "a1", runKind: "k" });
    const run = mkRun();
    t.attachRun(run);
    turnEnded(t);
    run.fire("finished");
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });
});
