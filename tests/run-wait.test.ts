/**
 * run.wait() 取消逃生口：流结束后 wait 挂死时，停止键必须能让任务 / 对话收尾。
 * 行为测试（fake timers）+ 两个 runner 的接线契约（防止有人把裸 `await run.wait()` 加回去）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "@cursor/sdk";
import {
  CANCEL_WAIT_GRACE_MS,
  createCancelEscape,
} from "@/lib/server/run-wait";

const GRACE = 1000;

const finished: RunResult = { id: "r1", status: "finished", result: "ok" };

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const fakeRun = (d: ReturnType<typeof deferred<RunResult>>) => ({
  id: "r1",
  wait: () => d.promise,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createCancelEscape：没人取消就永远不逃生", () => {
  it("没 arm：wait 再慢也只等真实结果（正常慢收尾不受影响）", async () => {
    const d = deferred<RunResult>();
    const esc = createCancelEscape(GRACE);
    const p = esc.wait(fakeRun(d));
    await vi.advanceTimersByTimeAsync(GRACE * 100);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    d.resolve(finished);
    await expect(p).resolves.toBe(finished);
    expect(esc.escaped).toBe(false);
    esc.dispose();
  });
});

describe("createCancelEscape：取消后 wait 挂死", () => {
  it("arm 之后宽限期内 settle → 返回真实结果、不逃生", async () => {
    const d = deferred<RunResult>();
    const onEscape = vi.fn();
    const esc = createCancelEscape(GRACE, onEscape);
    const p = esc.wait(fakeRun(d));
    esc.arm();
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    d.resolve({ id: "r1", status: "cancelled" });
    await expect(p).resolves.toMatchObject({ status: "cancelled" });
    esc.dispose();
    await vi.advanceTimersByTimeAsync(GRACE * 10);
    expect(onEscape).not.toHaveBeenCalled();
    expect(esc.escaped).toBe(false);
  });

  it("arm 之后 wait 一直不返回 → 宽限期到点按 cancelled 收尾（带 run id）、通知 onEscape", async () => {
    const d = deferred<RunResult>();
    const onEscape = vi.fn();
    const esc = createCancelEscape(GRACE, onEscape);
    const p = esc.wait(fakeRun(d));
    esc.arm();
    await vi.advanceTimersByTimeAsync(GRACE);
    await expect(p).resolves.toEqual({ id: "r1", status: "cancelled" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(esc.escaped).toBe(true);
    esc.dispose();
  });

  it("取消发生在 wait 之前（流消费期间）：宽限从进入 wait 起算，不因为流本身花了时间就立刻判超时", async () => {
    const d = deferred<RunResult>();
    const onEscape = vi.fn();
    const esc = createCancelEscape(GRACE, onEscape);
    esc.arm();
    // 流消费又花了很久——这段时间不算 wait 的宽限，也不能提前判「已逃生」
    await vi.advanceTimersByTimeAsync(GRACE * 20);
    expect(esc.escaped).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
    const p = esc.wait(fakeRun(d));
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ status: "cancelled" });
    expect(esc.escaped).toBe(true);
    esc.dispose();
  });

  it("arm 幂等：重复 arm 不重置计时、也不重复触发", async () => {
    const d = deferred<RunResult>();
    const onEscape = vi.fn();
    const esc = createCancelEscape(GRACE, onEscape);
    const p = esc.wait(fakeRun(d));
    esc.arm();
    await vi.advanceTimersByTimeAsync(GRACE / 2);
    esc.arm();
    esc.arm();
    await vi.advanceTimersByTimeAsync(GRACE / 2);
    await expect(p).resolves.toMatchObject({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(GRACE * 5);
    expect(onEscape).toHaveBeenCalledTimes(1);
    esc.dispose();
  });

  it("dispose 后不再触发（wait 返回后残留的计时器不能日后误伤）", async () => {
    const d = deferred<RunResult>();
    const onEscape = vi.fn();
    const esc = createCancelEscape(GRACE, onEscape);
    void esc.wait(fakeRun(d));
    esc.arm();
    esc.dispose();
    await vi.advanceTimersByTimeAsync(GRACE * 10);
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe("createCancelEscape：错误与晚到结果", () => {
  it("wait 抛错 → 原样抛出（与裸 await run.wait() 一致）", async () => {
    const d = deferred<RunResult>();
    const esc = createCancelEscape(GRACE);
    const p = esc.wait(fakeRun(d));
    d.reject(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    esc.dispose();
  });

  it("逃生之后真实 wait 才 reject：不产生 unhandledRejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const d = deferred<RunResult>();
      const esc = createCancelEscape(GRACE);
      const p = esc.wait(fakeRun(d));
      esc.arm();
      await vi.advanceTimersByTimeAsync(GRACE);
      await expect(p).resolves.toMatchObject({ status: "cancelled" });
      esc.dispose();
      d.reject(new Error("late"));
      // 切回真实计时器、让 Node 有机会在下一轮事件循环派发 unhandledRejection
      vi.useRealTimers();
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("默认宽限期是 30s（用户点停止后最多干等这么久）", () => {
    expect(CANCEL_WAIT_GRACE_MS).toBe(30_000);
  });
});

describe("runner 接线契约：wait 必须走逃生口、硬超时要罩到 wait 返回", () => {
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  const cases: Array<{ file: string; armSites: number }> = [
    // task：停止闭包 / 24h 硬超时 / run 内水位自动压缩续接
    { file: "src/lib/server/task-runner.ts", armSites: 3 },
    // chat：停止闭包 / 24h 硬超时
    { file: "src/lib/server/chat-runner.ts", armSites: 2 },
  ];

  for (const { file, armSites } of cases) {
    it(`${file}：不再裸 await run.wait()、每个 run.cancel 发出点都 arm`, () => {
      const src = read(file);
      expect(src).toContain("cancelEscape.wait(run)");
      expect(src).not.toMatch(/await\s+run\.wait\(\)/);
      const arms = src.match(/cancelEscape\.arm\(\)/g) ?? [];
      expect(arms.length).toBe(armSites);
      // wait 返回后（finally）清硬超时计时器 + dispose；catch 里也要 dispose
      expect(src).toMatch(
        /cancelEscape\.wait\(run\)\.finally\(\(\) => \{[\s\S]*?clearTimeout\(hardTimer\)[\s\S]*?cancelEscape\.dispose\(\)/,
      );
      expect(src).toMatch(
        /catch \(err\) \{\s*if \(hardTimer\) clearTimeout\(hardTimer\);\s*cancelEscape\.dispose\(\);/,
      );
    });
  }
});
