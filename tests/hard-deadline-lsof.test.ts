/**
 * 硬期限（评审 R16-01）：探测子进程（lsof / ps / pgrep …）一旦陷进不可中断睡眠，execFile 的 `timeout` 杀不掉它、
 * 回调永远不来——而启动恢复 `await killStalePreview()` 挂在好几个读任务的接口前面，卡一个就是整个任务列表 / 详情拿不到返回。
 *
 * 钉三件事：
 * 1. `withHardDeadline`：到点 reject（ETIMEDOUT）、正常返回不受影响、底层之后无论成败都不产生 unhandled rejection、不留定时器；
 * 2. `getProcessCwds`（lsof）：带 exec `timeout` + `killSignal: SIGKILL`，并且在 exec 的回调**永远不来**时也按期返回（拿不到 = 空、宁可漏杀）；
 * 3. exec 超时抛错时，错误对象上已输出的完整行照旧捡回来（半截行不采信）。
 *
 * 全程 mock child_process / fake timers：不起任何真实进程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void;
type ExecOpts = { timeout?: number; killSignal?: string; maxBuffer?: number };

let execImpl: (cmd: string, opts: ExecOpts, cb: ExecCb) => void = () => {};
const execCalls: Array<{ cmd: string; opts: ExecOpts }> = [];

vi.mock("node:child_process", () => {
  const exec = (cmd: string, opts: ExecOpts, cb: ExecCb) => {
    execCalls.push({ cmd, opts });
    execImpl(cmd, opts, cb);
  };
  const execFile = (_f: string, _a: unknown, _o: unknown, cb: (err: Error | null) => void) =>
    cb(new Error("execFile 在本测试里不应被调用"));
  return { exec, execFile, default: { exec, execFile } };
});

import { HardDeadlineError, withHardDeadline } from "@/lib/server/hard-deadline";
import { getProcessCwds, LSOF_TIMEOUT_MS } from "@/lib/server/kill-orphans";

// fake timers 会把 setImmediate 一起换掉：在换之前先留一份真的，用来「让出一个真正的宏任务」好让 unhandledRejection 有机会触发
const realSetImmediate = setImmediate;

beforeEach(() => {
  execCalls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withHardDeadline", () => {
  it("到点还没返回 → reject（code=ETIMEDOUT），不再等", async () => {
    const never = new Promise<string>(() => {});
    const p = withHardDeadline(never, 1000, "probe");
    const assertion = expect(p).rejects.toMatchObject({ code: "ETIMEDOUT", name: "HardDeadlineError" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("期限内返回：原样 resolve，并清掉定时器（不留悬挂的 timer）", async () => {
    const p = withHardDeadline(Promise.resolve("ok"), 1000, "probe");
    await expect(p).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("期限内失败：原样 reject 底层的错误（不被换成超时）", async () => {
    const boom = new Error("boom");
    await expect(withHardDeadline(Promise.reject(boom), 1000, "probe")).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时之后底层才失败 / 才成功：不产生 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let failLater!: (e: Error) => void;
      const late = new Promise<string>((_resolve, reject) => {
        failLater = reject;
      });
      const p = withHardDeadline(late, 500, "probe");
      const assertion = expect(p).rejects.toBeInstanceOf(HardDeadlineError);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      failLater(new Error("late failure")); // 超时之后底层才失败
      await vi.advanceTimersByTimeAsync(10);
      await new Promise<void>((r) => realSetImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("getProcessCwds（lsof）的超时（R16-01）", () => {
  it("exec 带 timeout + killSignal=SIGKILL（自带的超时先行）", async () => {
    execImpl = (_cmd, _opts, cb) => cb(null, { stdout: "p10\nn/a/b\n", stderr: "" });
    const m = await getProcessCwds([10]);
    expect(m.get(10)).toBe("/a/b");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].opts.timeout).toBe(LSOF_TIMEOUT_MS);
    expect(execCalls[0].opts.killSignal).toBe("SIGKILL");
  });

  it("exec 的回调永远不来（lsof 陷进不可中断睡眠、SIGKILL 也杀不掉）：硬期限一到就返回空，不无限期等", async () => {
    execImpl = () => {
      /* 永不回调 */
    };
    let settled = false;
    const p = getProcessCwds([10, 11]).then((m) => {
      settled = true;
      return m;
    });
    await vi.advanceTimersByTimeAsync(LSOF_TIMEOUT_MS); // exec 自带的 timeout 到点——回调仍没来
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1500); // 再过硬期限的余量
    const m = await p;
    expect(settled).toBe(true);
    expect(m.size).toBe(0); // 拿不到 = 空（调用方据此「宁可漏杀、不误杀」）
  });

  it("exec 超时抛错、但错误对象上有已输出的内容：完整行捡回来，半截的最后一行不采信", async () => {
    execImpl = (_cmd, _opts, cb) =>
      cb(Object.assign(new Error("Command timed out"), { killed: true, stdout: "p10\nn/a/b\np11\nn/a/c" }));
    const m = await getProcessCwds([10, 11]);
    expect(m.get(10)).toBe("/a/b");
    expect(m.has(11)).toBe(false); // 「/a/c」没有换行收尾，可能是被截断的半条路径
  });

  it("没有 pid：不起 lsof", async () => {
    execImpl = () => {
      throw new Error("不该被调用");
    };
    expect((await getProcessCwds([])).size).toBe(0);
    expect(execCalls).toHaveLength(0);
  });
});
