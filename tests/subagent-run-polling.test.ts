/**
 * 子代理详情的取数轮询状态机（`startSubagentRunPolling`）：真跑起来测，不读源码断言字符串。
 *
 * 状态机原先写在 `useSubagentRun` 的 effect 里、只有源码字符串契约；抽成不依赖 React 的函数后，
 * 注入假的 fetch + 假定时器就能把每条分支（终态停 / unchanged / 404 多等几轮 / 错误 / 抖动 / 关闭掐掉在飞请求）跑一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MISSING_RETRY_ROUNDS_RUNNING,
  startSubagentRunPolling,
  type SubagentRunPollState,
} from "../src/lib/subagent-run-client";
import {
  SUBAGENT_RUN_POLL_MS,
  type SubagentRunRef,
  type SubagentRunResponse,
  type SubagentRunSnapshot,
  type SubagentRunStatus,
} from "../src/lib/subagent-run";

const REF: SubagentRunRef = { by: "key", key: "sa_1" };

const snap = (rev: number, status: SubagentRunStatus = "running"): SubagentRunSnapshot => ({
  meta: {
    key: "sa_1",
    provider: "cursor",
    description: "查资料",
    prompt: "任务书",
    explore: false,
    resumed: false,
    background: false,
    detached: false,
    status,
    startedAt: 1,
    callIds: [],
  },
  events: [],
  rev,
  droppedEvents: 0,
});

type Fetcher = NonNullable<Parameters<typeof startSubagentRunPolling>[0]["fetchRun"]>;

/** 按顺序吐预设响应的假 fetch（吐完后重复最后一个）；Error 实例 = 抛 */
const scripted = (steps: Array<SubagentRunResponse | Error>) => {
  let i = 0;
  const fn = vi.fn<Fetcher>(async () => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    if (step instanceof Error) throw step;
    return step;
  });
  return fn;
};

const start = (
  fetchRun: Fetcher,
  fallback?: { running?: boolean },
): { states: SubagentRunPollState[]; stop: () => void } => {
  const states: SubagentRunPollState[] = [];
  const stop = startSubagentRunPolling({
    taskId: "t1",
    ref: REF,
    fallback,
    fetchRun,
    onState: (s) => states.push(s),
  });
  return { states, stop };
};

/** 推进假时间 + 冲掉微任务 */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startSubagentRunPolling：运行中轮询到终态", () => {
  it("打开立刻取一次（不等第一个 1s）；之后带上最新 rev 每秒再取；unchanged 不发状态；有变化才发", async () => {
    const fetchRun = scripted([
      { kind: "snapshot", snapshot: snap(1) },
      { kind: "unchanged", rev: 1 },
      { kind: "snapshot", snapshot: snap(2) },
      { kind: "snapshot", snapshot: snap(3, "done") },
    ]);
    const { states, stop } = start(fetchRun);

    await advance(0);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(fetchRun.mock.calls[0]![2]!.rev).toBeUndefined(); // 第一次没有 rev
    expect(states.map((s) => [s.phase, s.snapshot?.rev])).toEqual([["ready", 1]]);

    await advance(SUBAGENT_RUN_POLL_MS);
    expect(fetchRun).toHaveBeenCalledTimes(2);
    expect(fetchRun.mock.calls[1]![2]!.rev).toBe(1); // 带上手上的 rev
    expect(states).toHaveLength(1); // unchanged：界面不动

    await advance(SUBAGENT_RUN_POLL_MS);
    expect(fetchRun.mock.calls[2]![2]!.rev).toBe(1); // unchanged 不改 rev
    expect(states.map((s) => s.snapshot?.rev)).toEqual([1, 2]);

    await advance(SUBAGENT_RUN_POLL_MS);
    expect(fetchRun.mock.calls[3]![2]!.rev).toBe(2);
    expect(states.at(-1)!.snapshot?.meta.status).toBe("done");

    // 终态：轮询到此为止，再久也不再取
    await advance(SUBAGENT_RUN_POLL_MS * 10);
    expect(fetchRun).toHaveBeenCalledTimes(4);
    stop();
  });

  it("第一包就是终态（翻历史点开已结束的）：只取一次、不起轮询", async () => {
    const fetchRun = scripted([{ kind: "snapshot", snapshot: snap(5, "failed") }]);
    const { states } = start(fetchRun);
    await advance(SUBAGENT_RUN_POLL_MS * 5);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ phase: "ready", waiting: false });
  });

  it("interrupted / cancelled 同样算终态、停轮询", async () => {
    for (const status of ["interrupted", "cancelled"] as const) {
      const fetchRun = scripted([{ kind: "snapshot", snapshot: snap(2, status) }]);
      start(fetchRun);
      await advance(SUBAGENT_RUN_POLL_MS * 3);
      expect(fetchRun, status).toHaveBeenCalledTimes(1);
    }
  });
});

describe("startSubagentRunPolling：404（记录可能还没建好）", () => {
  it("还在跑的卡片：多等 MISSING_RETRY_ROUNDS_RUNNING 轮（loading + waiting），之后仍没有 → missing 并停", async () => {
    const fetchRun = scripted([{ kind: "missing" }]);
    const { states } = start(fetchRun, { running: true });
    await advance(SUBAGENT_RUN_POLL_MS * (MISSING_RETRY_ROUNDS_RUNNING + 5));

    // 1 次首取 + 每轮 1 次 = 等够 N 轮后第 N+1 次下结论
    expect(fetchRun).toHaveBeenCalledTimes(MISSING_RETRY_ROUNDS_RUNNING + 1);
    const waiting = states.filter((s) => s.phase === "loading");
    expect(waiting).toHaveLength(MISSING_RETRY_ROUNDS_RUNNING);
    expect(waiting.every((s) => s.waiting)).toBe(true);
    expect(states.at(-1)).toMatchObject({ phase: "missing", snapshot: null });
  });

  it("等的过程中记录建好了：转 ready（waiting 复位）、继续按运行中轮询", async () => {
    const fetchRun = scripted([
      { kind: "missing" },
      { kind: "missing" },
      { kind: "snapshot", snapshot: snap(1) },
      { kind: "snapshot", snapshot: snap(2, "done") },
    ]);
    const { states } = start(fetchRun, { running: true });
    await advance(SUBAGENT_RUN_POLL_MS * 5);
    expect(states.map((s) => [s.phase, s.waiting])).toEqual([
      ["loading", true],
      ["loading", true],
      ["ready", false],
      ["ready", false],
    ]);
    expect(fetchRun).toHaveBeenCalledTimes(4); // 终态后停
  });

  it("已跑完的卡片（含功能上线前的历史卡片）：一次 404 就下「没有记录」、不等", async () => {
    for (const fallback of [{ running: false }, undefined]) {
      const fetchRun = scripted([{ kind: "missing" }]);
      const { states } = start(fetchRun, fallback);
      await advance(SUBAGENT_RUN_POLL_MS * 3);
      expect(fetchRun).toHaveBeenCalledTimes(1);
      expect(states).toEqual([{ phase: "missing", snapshot: null, waiting: false }]);
    }
  });

  it("拿到过快照之后再 404（被保留策略清掉）：保留手上最后一份、不发 missing、停轮询", async () => {
    const fetchRun = scripted([
      { kind: "snapshot", snapshot: snap(1) },
      { kind: "missing" },
    ]);
    const { states } = start(fetchRun);
    await advance(SUBAGENT_RUN_POLL_MS * 5);
    expect(fetchRun).toHaveBeenCalledTimes(2);
    expect(states).toHaveLength(1);
    expect(states[0]!.phase).toBe("ready");
  });
});

describe("startSubagentRunPolling：请求失败", () => {
  it("还没拿到过快照就失败：error 并停（给用户「重试」，不在后台一直撞）", async () => {
    const fetchRun = scripted([new Error("HTTP 500")]);
    const { states } = start(fetchRun);
    await advance(SUBAGENT_RUN_POLL_MS * 5);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ phase: "error", snapshot: null, waiting: false }]);
  });

  it("已有快照时的瞬时失败：界面不动（不发 error）、下一轮继续取；恢复后照常更新", async () => {
    const fetchRun = scripted([
      { kind: "snapshot", snapshot: snap(1) },
      new Error("network down"),
      new Error("network down"),
      { kind: "snapshot", snapshot: snap(2) },
    ]);
    const { states } = start(fetchRun);
    await advance(SUBAGENT_RUN_POLL_MS * 3);
    expect(fetchRun).toHaveBeenCalledTimes(4);
    expect(states.map((s) => s.phase)).toEqual(["ready", "ready"]);
    expect(states.at(-1)!.snapshot?.rev).toBe(2);
    // 失败那几轮手上的 rev 一直是 1
    expect(fetchRun.mock.calls[1]![2]!.rev).toBe(1);
    expect(fetchRun.mock.calls[2]![2]!.rev).toBe(1);
    expect(fetchRun.mock.calls[3]![2]!.rev).toBe(1);
  });
});

describe("startSubagentRunPolling：stop（关闭 / 换目标）", () => {
  it("stop 掐掉在飞请求（signal.aborted）；晚到的响应不会再发任何状态", async () => {
    let resolveFetch!: (r: SubagentRunResponse) => void;
    let signal: AbortSignal | undefined;
    const fetchRun = vi.fn<Fetcher>(
      (_taskId, _ref, opts) =>
        new Promise<SubagentRunResponse>((resolve) => {
          signal = opts?.signal;
          resolveFetch = resolve;
        }),
    );
    const { states, stop } = start(fetchRun);
    await advance(0);
    expect(signal?.aborted).toBe(false);

    stop();
    expect(signal?.aborted).toBe(true);
    resolveFetch({ kind: "snapshot", snapshot: snap(1) }); // 晚到
    await advance(SUBAGENT_RUN_POLL_MS * 3);
    expect(states).toEqual([]);
    expect(fetchRun).toHaveBeenCalledTimes(1); // 也没有再排下一轮
  });

  it("stop 清掉已排好的下一轮定时器：停后不再发请求", async () => {
    const fetchRun = scripted([{ kind: "snapshot", snapshot: snap(1) }]);
    const { stop } = start(fetchRun);
    await advance(0);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    stop();
    await advance(SUBAGENT_RUN_POLL_MS * 5);
    expect(fetchRun).toHaveBeenCalledTimes(1);
  });

  it("在飞请求因被掐掉而抛 AbortError：不当成错误、不发 error 状态", async () => {
    const fetchRun = vi.fn<Fetcher>(
      (_taskId, _ref, opts) =>
        new Promise<SubagentRunResponse>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { states, stop } = start(fetchRun);
    await advance(0);
    stop();
    await advance(SUBAGENT_RUN_POLL_MS * 3);
    expect(states).toEqual([]);
  });

  it("请求的是传进来的 taskId / ref", async () => {
    const fetchRun = scripted([{ kind: "snapshot", snapshot: snap(1, "done") }]);
    start(fetchRun);
    await advance(0);
    expect(fetchRun.mock.calls[0]!.slice(0, 2)).toEqual(["t1", REF]);
  });
});
