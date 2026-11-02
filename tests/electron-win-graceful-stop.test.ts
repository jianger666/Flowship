/**
 * Windows 退出时优雅停 server（评审 R1-2）——**未在 Windows 实机验证**：全部靠注入的假 exec / 假时钟 / 假 proc 驱动，
 * 不会（也不能）在 mac / Linux 上真调 taskkill。
 *
 * 钉死的语义（核心函数 stopWinServer 来自 electron-app/win-server-stop.mjs，真跑；壳里的接线用 tests/helpers/main-slice.ts 切 main.js 真跑）：
 * - 请求关闭 = 关 server 的 stdin（真通道）+ 不带 /F 的 `taskkill /PID <pid> /T`；预算（4s）内 server 自己退了 → 不强杀
 * - 立即失效检测：taskkill 被拒（退出码非 0）且 stdin 也不可用 → 没有任何优雅通道、不等预算、立刻 `/T /F`
 *   （taskkill 被拒但 stdin 可用 → 继续等：stdin 通道独立于 taskkill 是否生效）
 * - 超时 → `/T /F`；强杀后短等回收（有上限，不会无限等）
 * - 重入 / 重复退出幂等；pid 不存在（taskkill 128）不强杀；pid 复用防线（句柄已退出 / server-pid 记录被覆盖 → 绝不发 /F）
 * - macOS / Linux 的 stopServer 不碰 taskkill
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WIN_FORCE_REAP_MS,
  WIN_FORCE_TASKKILL_TIMEOUT_MS,
  WIN_QUIT_WATCHDOG_MS,
  WIN_STOP_GRACE_MS,
  WIN_STOP_POLL_MS,
  WIN_TASKKILL_TIMEOUT_MS,
  classifyTaskkill,
  isRecordCompatibleWithPid,
  stopWinServer,
  taskkillTimeoutFor,
  withStdinEofExitEnv,
} from "../electron-app/win-server-stop.mjs";
import { WIN_SELF_TREEKILL_TIMEOUT_MS } from "../src/lib/server/win-self-tree-kill";
import { instantiateMany, mainDecls, mainSrc, sliceMainFn } from "./helpers/main-slice";

type TaskkillRes = { code: number | null };
type FakeStdin = { destroyed: boolean; writableEnded: boolean; writable: boolean; end: ReturnType<typeof vi.fn> };
type FakeProc = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdin: FakeStdin | null;
};

const makeStdin = (onEnd?: () => void): FakeStdin => {
  const s: FakeStdin = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    end: vi.fn(() => {
      s.writableEnded = true;
      onEnd?.();
    }),
  };
  return s;
};
const makeProc = (pid = 4242, stdin: FakeStdin | null = makeStdin()): FakeProc => {
  const p = new EventEmitter() as FakeProc;
  p.pid = pid;
  p.exitCode = null;
  p.signalCode = null;
  p.stdin = stdin;
  return p;
};
const die = (p: FakeProc, code = 0): void => {
  p.exitCode = code;
  p.emit("exit", code, null);
};

/** 假时钟：sleep 推进 t 并触发到期的预约事件（server 在第 N ms 退出等），之后让出微任务 */
const makeClock = () => {
  let t = 0;
  const events: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    at: (ms: number, fn: () => void) => events.push({ at: t + ms, fn }),
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      for (const e of events.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        events.splice(events.indexOf(e), 1);
        e.fn();
      }
      // 多让几轮微任务：真实的 100ms 间隔里 taskkill 的 promise 链早就落定了，假时钟不能让「时间跳了、promise 还没动」
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
};

/** exec 替身：记录每次 args；按 args 决定退出码（`/F` 与否分别指定） */
const makeExec = (soft: TaskkillRes | "reject", force: TaskkillRes | "reject" = { code: 0 }, onForce?: () => void) => {
  const calls: string[][] = [];
  const exec = vi.fn(async (args: string[]) => {
    calls.push(args);
    const isForce = args.includes("/F");
    if (isForce) onForce?.();
    const r = isForce ? force : soft;
    if (r === "reject") throw new Error("spawn taskkill ENOENT");
    return r;
  });
  return { exec, calls };
};
const SOFT = ["/PID", "4242", "/T"];
const FORCE = ["/PID", "4242", "/T", "/F"];

describe("classifyTaskkill：退出码归类", () => {
  it("0 = ok；128 = 找不到进程；其它（含 1「只能强制终止」/ null 超时 / 非对象）= 被拒", () => {
    expect(classifyTaskkill({ code: 0 })).toBe("ok");
    expect(classifyTaskkill({ code: 128 })).toBe("not-found");
    expect(classifyTaskkill({ code: 1 })).toBe("rejected");
    expect(classifyTaskkill({ code: null })).toBe("rejected");
    expect(classifyTaskkill(undefined)).toBe("rejected");
  });
});

describe("stopWinServer：优雅成功（预算内退出 → 不强杀）", () => {
  it("stdin EOF 后 server 300ms 自己退出：关了 stdin、只发过不带 /F 的 taskkill，没有任何 /F（即使 taskkill 被拒——stdin 通道独立）", async () => {
    const clock = makeClock();
    const proc = makeProc();
    clock.at(300, () => die(proc));
    const { exec, calls } = makeExec({ code: 1 }); // 无窗口 server：「只能强制终止」
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res.outcome).toBe("graceful");
    expect(proc.stdin!.end).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([SOFT]);
    expect(clock.now()).toBeLessThan(WIN_STOP_GRACE_MS);
  });

  it("taskkill 请求被接受（退出码 0）且 server 在预算内退出 → 同样不强杀", async () => {
    const clock = makeClock();
    const proc = makeProc();
    clock.at(1200, () => die(proc));
    const { exec, calls } = makeExec({ code: 0 });
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res.outcome).toBe("graceful");
    expect(calls).toEqual([SOFT]);
  });

  it("预算边界：第 3.9s 才退出也算优雅（还没到 4s 不强杀）", async () => {
    const clock = makeClock();
    const proc = makeProc();
    clock.at(3900, () => die(proc));
    const { exec, calls } = makeExec({ code: 1 });
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res.outcome).toBe("graceful");
    expect(calls.some((c) => c.includes("/F"))).toBe(false);
  });
});

describe("stopWinServer：优雅无效 → 立即退化强杀（不白等满预算）", () => {
  it("stdin 不可用（没有管道）+ taskkill 被拒 → 没有任何优雅通道：立刻 /T /F，耗时远小于预算", async () => {
    const clock = makeClock();
    const proc = makeProc(4242, null);
    const { exec, calls } = makeExec({ code: 1 }, { code: 0 }, () => die(proc));
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res).toMatchObject({ outcome: "forced", reason: "no-channel", exited: true });
    expect(calls).toEqual([SOFT, FORCE]); // 先请求、后强杀
    expect(clock.now()).toBeLessThanOrEqual(WIN_STOP_POLL_MS * 3);
  });

  it("stdin 已被销毁 / 已 end / stdin.end 抛错 同样算不可用", async () => {
    for (const mk of [
      () => Object.assign(makeStdin(), { destroyed: true }),
      () => Object.assign(makeStdin(), { writableEnded: true }),
      () => Object.assign(makeStdin(), { writable: false }),
      () => {
        const s = makeStdin();
        s.end = vi.fn(() => {
          throw new Error("EPIPE");
        });
        return s;
      },
    ]) {
      const clock = makeClock();
      const proc = makeProc(4242, mk());
      const { exec, calls } = makeExec({ code: 1 }, { code: 0 }, () => die(proc));
      const res = await stopWinServer({ proc, exec, ...clock });
      expect(res).toMatchObject({ outcome: "forced", reason: "no-channel" });
      expect(calls).toEqual([SOFT, FORCE]);
    }
  });

  it("taskkill 本身起不来（reject）+ 没有 stdin → 同样立即强杀，且 /F 的 reject 被吞掉不抛", async () => {
    const clock = makeClock();
    const proc = makeProc(4242, null);
    const { exec } = makeExec("reject", "reject");
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res).toMatchObject({ outcome: "forced", reason: "no-channel", exited: false });
    expect(clock.now()).toBeLessThan(WIN_FORCE_REAP_MS + WIN_STOP_POLL_MS * 3); // 回收等待有上限
  });
});

describe("stopWinServer：超时后强杀", () => {
  it("stdin 可用但 server 不理（4s 内不退）→ 超时后 /T /F；强杀后退出 = 回收成功", async () => {
    const clock = makeClock();
    const proc = makeProc();
    const { exec, calls } = makeExec({ code: 1 }, { code: 0 }, () => clock.at(50, () => die(proc)));
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res).toMatchObject({ outcome: "forced", reason: "timeout", exited: true });
    expect(res.waitedMs).toBeGreaterThanOrEqual(WIN_STOP_GRACE_MS);
    expect(calls).toEqual([SOFT, FORCE]);
  });

  it("强杀后 server 仍不退（taskkill 无权限等）：回收等待有上限、总耗时 ≤ 预算 + 回收上限 + 余量，不会卡死", async () => {
    const clock = makeClock();
    const proc = makeProc();
    const { exec } = makeExec({ code: 1 }, { code: 1 });
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res).toMatchObject({ outcome: "forced", reason: "timeout", exited: false });
    expect(clock.now()).toBeLessThanOrEqual(WIN_STOP_GRACE_MS + WIN_FORCE_REAP_MS + WIN_STOP_POLL_MS * 3);
  });
});

describe("stopWinServer：重入 / pid 不存在 / pid 复用防线", () => {
  it("重入 / 重复退出幂等：并发 + 事后再调，同一个 server 只关一次 stdin、只发一轮 taskkill", async () => {
    const clock = makeClock();
    const proc = makeProc();
    const { exec, calls } = makeExec({ code: 1 }, { code: 0 }, () => clock.at(10, () => die(proc)));
    const p1 = stopWinServer({ proc, exec, ...clock });
    const p2 = stopWinServer({ proc, exec, ...clock });
    expect(p2).toBe(p1);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2).toBe(r1);
    const r3 = await stopWinServer({ proc, exec, ...clock });
    expect(r3).toBe(r1);
    expect(proc.stdin!.end).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([SOFT, FORCE]);
  });

  it("没有 pid（spawn 失败）/ 非法 pid（0、1、NaN）/ 没有 proc → 什么都不做", async () => {
    const clock = makeClock();
    for (const pid of [0, 1, Number.NaN, -5]) {
      const { exec } = makeExec({ code: 0 });
      const proc = makeProc(pid);
      expect((await stopWinServer({ proc, exec, ...clock })).outcome).toBe("no-pid");
      expect(exec).not.toHaveBeenCalled();
      expect(proc.stdin!.end).not.toHaveBeenCalled();
    }
    const { exec } = makeExec({ code: 0 });
    expect((await stopWinServer({ proc: null as never, exec, ...clock })).outcome).toBe("no-pid");
    expect(exec).not.toHaveBeenCalled();
  });

  it("pid 不存在（taskkill 退出码 128）：不强杀（pid 可能已被别的进程复用）；等 exit 事件落地即返回", async () => {
    const clock = makeClock();
    const proc = makeProc();
    clock.at(150, () => die(proc));
    const { exec, calls } = makeExec({ code: 128 });
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res).toMatchObject({ outcome: "pid-gone", exited: true });
    expect(calls).toEqual([SOFT]);
  });

  it("pid 不存在且 exit 事件一直不来：等待有上限、仍不发 /F", async () => {
    const clock = makeClock();
    const proc = makeProc();
    const { exec, calls } = makeExec({ code: 128 });
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res).toMatchObject({ outcome: "pid-gone", exited: false });
    expect(calls.some((c) => c.includes("/F"))).toBe(false);
    expect(clock.now()).toBeLessThanOrEqual(WIN_FORCE_REAP_MS + WIN_STOP_POLL_MS * 3);
  });

  it("pid 复用防线 A：调用时句柄已显示退出（exitCode / signalCode 非 null）→ 不发任何 taskkill、不碰 stdin", async () => {
    const patches: Array<(p: FakeProc) => void> = [
      (p) => (p.exitCode = 0),
      (p) => (p.exitCode = 1),
      (p) => (p.signalCode = "SIGKILL"),
    ];
    for (const patch of patches) {
      const clock = makeClock();
      const proc = makeProc();
      patch(proc);
      const { exec } = makeExec({ code: 0 });
      expect((await stopWinServer({ proc, exec, ...clock })).outcome).toBe("already-exited");
      expect(exec).not.toHaveBeenCalled();
      expect(proc.stdin!.end).not.toHaveBeenCalled();
    }
  });

  it("pid 复用防线 B：等待中句柄显示已退出（exit 事件丢了、只有 exitCode）→ 当作优雅退出，绝不发 /F", async () => {
    const clock = makeClock();
    const proc = makeProc();
    clock.at(3950, () => {
      proc.exitCode = 0; // 不 emit exit：只靠句柄状态判定
    });
    const { exec, calls } = makeExec({ code: 1 });
    const res = await stopWinServer({ proc, exec, ...clock });
    expect(res.outcome).toBe("graceful");
    expect(calls).toEqual([SOFT]);
  });

  it("pid 复用防线 C：server-pid 记录已被新实例覆盖（confirmIdentity=false）→ 超时也不强杀这个 pid", async () => {
    const clock = makeClock();
    const proc = makeProc();
    const confirmIdentity = vi.fn(() => false);
    const { exec, calls } = makeExec({ code: 1 });
    const res = await stopWinServer({ proc, exec, confirmIdentity, ...clock });
    expect(res.outcome).toBe("identity-mismatch");
    expect(confirmIdentity).toHaveBeenCalledWith(4242);
    expect(calls).toEqual([SOFT]);
  });

  it("confirmIdentity 抛错不能挡住强杀（最坏退回旧的强杀行为）", async () => {
    const clock = makeClock();
    const proc = makeProc();
    const { exec, calls } = makeExec({ code: 1 }, { code: 0 }, () => clock.at(10, () => die(proc)));
    const res = await stopWinServer({
      proc,
      exec,
      confirmIdentity: () => {
        throw new Error("读记录失败");
      },
      ...clock,
    });
    expect(res.outcome).toBe("forced");
    expect(calls).toEqual([SOFT, FORCE]);
  });
});

describe("isRecordCompatibleWithPid：server-pid 记录的身份判定", () => {
  it("记录是别的 pid = 被新实例接管（不兼容）；记录就是它 / 没有记录（null / undefined）= 兼容", () => {
    expect(isRecordCompatibleWithPid(9999, 4242)).toBe(false);
    expect(isRecordCompatibleWithPid(4242, 4242)).toBe(true);
    expect(isRecordCompatibleWithPid(null, 4242)).toBe(true);
    expect(isRecordCompatibleWithPid(undefined, 4242)).toBe(true);
  });
});

describe("预算常量（R8-4：/F 的 taskkill 超时单独放宽到 4.5s、win32 看门狗相应放宽；整体账自洽）", () => {
  it("/F 的 taskkill 超时落在审查方建议的 4–5s（且不超过旧 before-quit 的 5s）；请求那次（不带 /F）仍是 1.5s", () => {
    expect(WIN_FORCE_TASKKILL_TIMEOUT_MS).toBeGreaterThanOrEqual(4000);
    expect(WIN_FORCE_TASKKILL_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(WIN_TASKKILL_TIMEOUT_MS).toBe(1500);
    // 按参数选超时：带 /F → 强杀档；不带 → 请求档（main.js 的 taskkillWin 用它）
    expect(taskkillTimeoutFor(["/PID", "1", "/T", "/F"])).toBe(WIN_FORCE_TASKKILL_TIMEOUT_MS);
    expect(taskkillTimeoutFor(["/PID", "1", "/T"])).toBe(WIN_TASKKILL_TIMEOUT_MS);
    expect(taskkillTimeoutFor(undefined)).toBe(WIN_TASKKILL_TIMEOUT_MS);
  });

  it("win32 最坏总耗时 = 优雅预算 + /F 的 taskkill 上限 + 回收 < win32 看门狗；看门狗之后同步强杀再叠 4.5s 也有明确上界", () => {
    expect(WIN_STOP_GRACE_MS).toBe(4000);
    const worst = WIN_STOP_GRACE_MS + WIN_FORCE_TASKKILL_TIMEOUT_MS + WIN_FORCE_REAP_MS;
    expect(worst).toBe(9500);
    // 看门狗必须大于最坏总耗时（否则会抢在正常收尾前放行），且留出足够余量（≥1s）
    expect(WIN_QUIT_WATCHDOG_MS).toBeGreaterThanOrEqual(worst + 1000);
    // 绝对最坏（异步强杀与 server 同时卡死）：看门狗 + 同步强杀超时——钉住账，改动任何一项都要回来看这条
    expect(WIN_QUIT_WATCHDOG_MS + WIN_FORCE_TASKKILL_TIMEOUT_MS).toBe(15500);
  });

  it("server 侧最坏（退出清理上限 + 自杀整树的同步 taskkill 超时）< 壳侧优雅预算：壳不会在 server 还在清树时抢先发 /T /F", () => {
    const inboundSrc = readFileSync(path.join(__dirname, "../src/lib/server/feishu-bridge/inbound.ts"), "utf8");
    const cap = /const EXIT_HOOK_CLEANUP_CAP_MS = (\d+);/.exec(inboundSrc);
    expect(cap).not.toBeNull();
    const serverWorst = Number(cap![1]) + WIN_SELF_TREEKILL_TIMEOUT_MS;
    expect(serverWorst).toBeLessThan(WIN_STOP_GRACE_MS);
    // 留 ≥ 250ms 余量给 process.exit / 进程回收 / 轮询间隔
    expect(WIN_STOP_GRACE_MS - serverWorst).toBeGreaterThanOrEqual(250 + WIN_STOP_POLL_MS);
  });

  it("main.js 的看门狗：win32 用 WIN_QUIT_WATCHDOG_MS、unix 仍 7s；到点的同步强杀（killServerTreeSync）用 /F 档超时而不是 1.5s", () => {
    const u = /const SERVER_QUIT_WATCHDOG_UNIX_MS = ([\d_]+);/.exec(mainSrc);
    expect(u).not.toBeNull();
    expect(Number(u![1].replace(/_/g, ""))).toBe(7000);
    expect(mainSrc).toContain(
      'const SERVER_QUIT_WATCHDOG_MS = process.platform === "win32" ? WIN_QUIT_WATCHDOG_MS : SERVER_QUIT_WATCHDOG_UNIX_MS;',
    );
    expect(sliceMainFn("killServerTreeSync")).toContain("timeout: WIN_FORCE_TASKKILL_TIMEOUT_MS,");
    expect(mainSrc).toContain("{ windowsHide: true, timeout: taskkillTimeoutFor(args) },");
  });
});

// ---------- main.js 接线（切源码真跑） ----------
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const fakeTimerSleep = (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  return Promise.resolve();
};

describe("main.js 的 stopServer（win32 分支，切源码真跑）", () => {
  const build = (opts: { platform: string; soft?: TaskkillRes; recorded?: number | null }) => {
    const calls: string[][] = [];
    const taskkillWin = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args.includes("/F") ? { code: 0 } : (opts.soft ?? { code: 1 });
    });
    const logs: string[] = [];
    const proc = { platform: opts.platform, kill: vi.fn(() => true) };
    const api = instantiateMany<{
      stopServer: () => Promise<void>;
      setServerProc: (p: FakeProc | null) => void;
      getServerProc: () => FakeProc | null;
    }>(
      ["stopServer"],
      {
        process: proc,
        sleep: fakeTimerSleep,
        log: (m: string) => logs.push(m),
        execFileP: vi.fn(async () => ""),
        stopWinServer,
        isRecordCompatibleWithPid,
        taskkillWin,
        readRecordedServerPid: () => (opts.recorded === undefined ? null : opts.recorded),
        signalServerTree: vi.fn(),
        sweepServerGroup: vi.fn(async () => {}),
      },
      "let serverProc = null;",
      "return { stopServer, setServerProc: (p) => { serverProc = p; }, getServerProc: () => serverProc };",
    );
    return { ...api, calls, taskkillWin, logs, proc };
  };

  it("server 在 stdin EOF 后自己退出：只发不带 /F 的 taskkill、没有 /F；serverProc 已置 null", async () => {
    const h = build({ platform: "win32" });
    const server = makeProc(4242, makeStdin(() => setTimeout(() => die(server), 200)));
    h.setServerProc(server);
    await h.stopServer();
    expect(h.calls).toEqual([SOFT]);
    expect(server.stdin!.end).toHaveBeenCalledTimes(1);
    expect(h.getServerProc()).toBeNull();
    expect(h.logs.some((l) => l.includes('"outcome":"graceful"'))).toBe(true);
  });

  it("server 不理会 EOF：超时后 /T /F 强杀（先 taskkill 请求、再 /F）", async () => {
    const h = build({ platform: "win32" });
    const server = makeProc();
    h.taskkillWin.mockImplementation(async (args: string[]) => {
      h.calls.push(args);
      if (args.includes("/F")) setTimeout(() => die(server), 30);
      return { code: 1 };
    });
    h.setServerProc(server);
    await h.stopServer();
    expect(h.calls).toEqual([SOFT, FORCE]);
    expect(h.logs.some((l) => l.includes('"outcome":"forced"'))).toBe(true);
  });

  it("server-pid 记录已被新实例覆盖：stopServer 把 confirmIdentity 接上了、超时也不强杀（pid 复用防线接线）", async () => {
    const h = build({ platform: "win32", recorded: 9999 });
    h.setServerProc(makeProc(4242));
    await h.stopServer();
    expect(h.calls).toEqual([SOFT]);
    expect(h.logs.some((l) => l.includes("identity-mismatch"))).toBe(true);
  });

  it("记录就是它（或没有记录）→ 允许强杀", async () => {
    for (const recorded of [4242, null]) {
      const h = build({ platform: "win32", recorded });
      const server = makeProc(4242);
      h.taskkillWin.mockImplementation(async (args: string[]) => {
        h.calls.push(args);
        if (args.includes("/F")) setTimeout(() => die(server), 30);
        return { code: 1 };
      });
      h.setServerProc(server);
      await h.stopServer();
      expect(h.calls).toEqual([SOFT, FORCE]);
    }
  });

  it("重入：stopServer 连调两次（window-all-closed 与 before-quit 叠加）——第二次发现 serverProc 已空、什么都不再发", async () => {
    const h = build({ platform: "win32" });
    const server = makeProc(4242, makeStdin(() => setTimeout(() => die(server), 100)));
    h.setServerProc(server);
    await Promise.all([h.stopServer(), h.stopServer()]);
    expect(h.calls).toEqual([SOFT]);
    expect(server.stdin!.end).toHaveBeenCalledTimes(1);
  });

  it("macOS / Linux 不受影响：stopServer 走 SIGTERM、不碰 taskkill / stopWinServer / stdin", async () => {
    for (const platform of ["darwin", "linux"]) {
      const h = build({ platform });
      const server = makeProc(4242);
      const kill = vi.fn((sig: string) => {
        if (sig === "SIGTERM") setTimeout(() => die(server), 50);
        return true;
      });
      (server as unknown as { kill: typeof kill }).kill = kill;
      h.setServerProc(server);
      await h.stopServer();
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(h.taskkillWin).not.toHaveBeenCalled();
      expect(server.stdin!.end).not.toHaveBeenCalled();
    }
  });
});

describe("main.js 的 killServerTreeSync（退出看门狗的强杀，切源码真跑）", () => {
  const build = (platform: string) => {
    const execFileSync = vi.fn();
    const kills: Array<[number, string]> = [];
    const proc = {
      platform,
      kill: (pid: number, sig: string) => {
        kills.push([pid, sig]);
        return true;
      },
    };
    const api = instantiateMany<{ killServerTreeSync: (p: unknown) => void }>(
      ["signalServerTree", "killServerTreeSync"],
      { process: proc, execFileSync, WIN_FORCE_TASKKILL_TIMEOUT_MS },
      "",
      "return { killServerTreeSync };",
    );
    return { ...api, execFileSync, kills };
  };

  it("win32：taskkill /PID <pid> /T /F 连进程树（windowsHide + /F 档超时 4.5s，不是请求档 1.5s）", () => {
    const h = build("win32");
    h.killServerTreeSync(makeProc(4242));
    expect(h.execFileSync).toHaveBeenCalledWith("taskkill", FORCE, {
      windowsHide: true,
      timeout: WIN_FORCE_TASKKILL_TIMEOUT_MS,
    });
    expect(h.kills).toEqual([]);
  });

  it("win32：句柄已显示退出 → 不发 taskkill（pid 复用防线）；taskkill 抛错被吞掉", () => {
    const h = build("win32");
    h.killServerTreeSync(Object.assign(makeProc(4242), { exitCode: 0 }));
    h.killServerTreeSync(Object.assign(makeProc(4242), { signalCode: "SIGKILL" }));
    expect(h.execFileSync).not.toHaveBeenCalled();
    h.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(() => h.killServerTreeSync(makeProc(4242))).not.toThrow();
  });

  it("unix 不变：整组 SIGKILL（kill(-pid)），不碰 taskkill；没有 proc / pid 什么都不发", () => {
    for (const platform of ["darwin", "linux"]) {
      const h = build(platform);
      h.killServerTreeSync(makeProc(4242));
      expect(h.kills).toEqual([[-4242, "SIGKILL"]]);
      expect(h.execFileSync).not.toHaveBeenCalled();
      h.killServerTreeSync(null);
      h.killServerTreeSync(makeProc(0));
      expect(h.kills).toHaveLength(1);
    }
  });
});

describe("withStdinEofExitEnv（R8-7）：非 win32 显式删掉 FLOWSHIP_EXIT_ON_STDIN_EOF，win32 覆盖成壳的值", () => {
  const KEY = "FLOWSHIP_EXIT_ON_STDIN_EOF";
  it("darwin / linux：用户环境里继承来的该变量被删掉（含 \"1\" / \"0\" / 空串），其余变量原样保留", () => {
    for (const platform of ["darwin", "linux", "freebsd"]) {
      for (const inherited of ["1", "0", "", "true"]) {
        const out = withStdinEofExitEnv({ [KEY]: inherited, PATH: "/usr/bin", FOO: "bar" }, platform);
        expect(Object.prototype.hasOwnProperty.call(out, KEY), `${platform}/${JSON.stringify(inherited)}`).toBe(false);
        expect(out).toEqual({ PATH: "/usr/bin", FOO: "bar" });
      }
    }
  });

  it("darwin：本来就没有该变量也不会凭空多出来", () => {
    expect(withStdinEofExitEnv({ PATH: "/usr/bin" }, "darwin")).toEqual({ PATH: "/usr/bin" });
  });

  it("win32：无论继承到什么（没有 / \"0\" / \"1\"）都是 \"1\"（壳给的是真管道）", () => {
    for (const inherited of [undefined, "0", "1", "yes"]) {
      const env: Record<string, string | undefined> = { PATH: "C:\\Windows" };
      if (inherited !== undefined) env[KEY] = inherited;
      expect(withStdinEofExitEnv(env, "win32")).toEqual({ PATH: "C:\\Windows", [KEY]: "1" });
    }
  });

  it("不改入参", () => {
    const env = { [KEY]: "1", A: "b" };
    withStdinEofExitEnv(env, "darwin");
    expect(env).toEqual({ [KEY]: "1", A: "b" });
  });
});

describe("main.js 的 startServer：spawn 的 env / stdio（切源码真跑，spawn 是替身）", () => {
  const KEY = "FLOWSHIP_EXIT_ON_STDIN_EOF";
  const run = (platform: string, userEnv: Record<string, string>) => {
    let captured: { cmd: string; args: string[]; opts: { env: Record<string, string>; stdio: unknown[]; detached: boolean } } | null = null;
    const fakeChild = () => {
      const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
      c.pid = 777;
      c.stdin = { on: vi.fn() };
      c.stdout = { on: vi.fn() };
      c.stderr = { on: vi.fn() };
      return c;
    };
    const api = instantiateMany<{ startServer: () => void }>(
      ["startServer"],
      {
        process: { platform, env: userEnv, versions: { node: "22.13.0" } },
        path,
        withStdinEofExitEnv, // 真函数（不替身）：测的就是 startServer → withStdinEofExitEnv → spawn 这条真链路
        serverDir: "/srv/app-server",
        nodeReportsDir: () => "/tmp/reports",
        mkdirSync: vi.fn(),
        readdirSync: vi.fn(() => []),
        fs: { unlink: vi.fn(async () => {}) },
        buildServerNodeArgs: () => ["--max-old-space-size=4096"],
        spawn: (cmd: string, args: string[], opts: never) => {
          captured = { cmd, args, opts };
          return fakeChild();
        },
        serverNodeBin: () => "/bin/node",
        PORT: 8676,
        HOST: "127.0.0.1",
        app: { getPath: () => "/userData", getVersion: () => "9.9.9" },
        getAppNapMode: () => ({ enabled: false }),
        writeServerPidRecord: vi.fn(),
        clearServerPidRecord: vi.fn(),
        bootTimeline: { mark: vi.fn() },
        log: vi.fn(),
        dialog: { showErrorBox: vi.fn() },
        onServerExit: vi.fn(async () => {}),
      },
      mainDecls("serverProc", "quitting"),
      "return { startServer };",
    );
    api.startServer();
    return captured!;
  };

  it("macOS / Linux：用户环境里 export 了 FLOWSHIP_EXIT_ON_STDIN_EOF=1 → server 的 env 里被删掉，stdin 仍是 \"ignore\"（否则 /dev/null 立即 EOF、server 启动即退）", () => {
    for (const platform of ["darwin", "linux"]) {
      const c = run(platform, { PATH: "/usr/bin", HOME: "/Users/u", [KEY]: "1" });
      expect(Object.prototype.hasOwnProperty.call(c.opts.env, KEY), platform).toBe(false);
      expect(c.opts.stdio[0]).toBe("ignore");
      // 其余环境与壳自己设的三件套 / 观测变量不受影响
      expect(c.opts.env).toMatchObject({
        PATH: "/usr/bin",
        HOME: "/Users/u",
        ELECTRON_RUN_AS_NODE: "1",
        PORT: "8676",
        HOSTNAME: "127.0.0.1",
        FLOWSHIP_DATA_DIR: "/userData/data",
        FLOWSHIP_APP_VERSION: "9.9.9",
        FLOWSHIP_PREVENT_APP_NAP: "0",
      });
      expect(c.opts.detached).toBe(true);
    }
  });

  it("macOS / Linux：用户环境里没有该变量 → 同样没有", () => {
    expect(Object.prototype.hasOwnProperty.call(run("darwin", { PATH: "/usr/bin" }).opts.env, KEY)).toBe(false);
  });

  it("win32：env 里是 \"1\"（用户环境里是什么都被覆盖）、stdin 是管道、不 detached", () => {
    const userEnvs: Array<Record<string, string>> = [{ PATH: "C:\\Windows" }, { PATH: "C:\\Windows", [KEY]: "0" }];
    for (const userEnv of userEnvs) {
      const c = run("win32", userEnv);
      expect(c.opts.env[KEY]).toBe("1");
      expect(c.opts.stdio[0]).toBe("pipe");
      expect(c.opts.detached).toBe(false);
    }
  });
});

describe("main.js 接线契约（源码）", () => {
  it("spawn：win32 才给 server 一根 stdin 管道并设 FLOWSHIP_EXIT_ON_STDIN_EOF；unix 仍是 \"ignore\"（stdio 配置不变）；stdin 的 error 有监听", () => {
    expect(mainSrc).toContain('stdio: [process.platform === "win32" ? "pipe" : "ignore", "pipe", "pipe"],');
    // R8-7：env 经 withStdinEofExitEnv（非 win32 显式删掉、win32 覆盖成 "1"），不再有「只在 win32 展开、其它平台透传用户值」的写法
    expect(mainSrc).toContain("env: withStdinEofExitEnv(");
    expect(mainSrc).not.toContain('...(process.platform === "win32" ? { FLOWSHIP_EXIT_ON_STDIN_EOF: "1" } : {}),');
    expect(mainSrc).toContain('proc.stdin?.on("error", () => {});');
  });

  it("stopServer 的 win32 分支不再有裸 taskkill /F；强杀只经 stopWinServer（带预算）与看门狗 killServerTreeSync", () => {
    const body = sliceMainFn("stopServer");
    const winBranch = body.slice(body.indexOf('process.platform === "win32"'), body.indexOf("// unix：先**只对 server 自己** SIGTERM"));
    expect(winBranch).toContain("stopWinServer({");
    expect(winBranch).toContain("exec: taskkillWin,");
    expect(winBranch).toContain("confirmIdentity:");
    expect(winBranch).not.toContain('"/F"');
    expect(winBranch).not.toContain("execFileP(");
  });

  it("不引入 Get-CimInstance（startup-boot-contract：只允许在 port-owner.mjs / 既有探测里）", () => {
    expect(mainSrc).not.toContain("Get-CimInstance");
  });
});
