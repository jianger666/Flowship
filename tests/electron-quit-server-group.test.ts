/**
 * 正常退出时优雅停 server、按进程组收尾（2026-11-01 评审 P1）
 *
 * 旧行为：Cmd+Q / 托盘退出 / 自更新重启都在 `before-quit` 里直接 `serverProc.kill("SIGKILL")`——
 * server 的 SIGTERM 优雅钩子（停飞书 consumer / 托管子进程 / keep-awake）永远不执行；unix 下 spawn 没有 detached，
 * 只杀 server 一个 pid，agent shell 的孙进程（pnpm test / dev server / git）被 launchd 收养后继续占端口、继续改工作树，
 * 下次启动的 boot-recovery 把任务标成中断、旧进程还在写，形成双写者。
 *
 * 钉死的语义（壳是 Electron 入口、不能直接 import，所以和 tests/helpers/main-slice.ts 的其它用例一样切源码真实执行）：
 * - signalServerTree 按进程组发信号（process.kill(-pid, sig)）、组不存在时退回单进程；win32 不走这里
 * - stopServer（unix）：SIGTERM → 2s 内 server 自己退了就只做扫尾；没退才整组 SIGKILL
 * - 扫尾：server 退出后同组还有残留成员，最多等 1.5s 自然退出、仍在才整组 SIGKILL；组里没人（常态）立即返回
 * - before-quit：先 preventDefault 优雅停完再 app.quit()（R1-2 起 win32 同样走这条，win32 的优雅停见 tests/electron-win-graceful-stop.test.ts）；
 *   系统关机 / 注销时（powerMonitor shutdown）不拖住退出、退回同步强杀（unix 整组 SIGKILL / win32 同步 taskkill /T /F）
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instantiateMany, mainSrc, sliceMainFn } from "./helpers/main-slice";

type FakeProc = EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };

const makeProc = (pid = 4242): FakeProc => {
  const p = new EventEmitter() as FakeProc;
  p.pid = pid;
  p.kill = vi.fn();
  return p;
};

interface Harness {
  stopServer: () => Promise<void>;
  signalServerTree: (proc: FakeProc | null, signal: string) => void;
  serverGroupAlive: (pid: number) => boolean;
  setServerProc: (p: FakeProc | null) => void;
  kills: Array<{ pid: number; signal: string | number }>;
  logs: string[];
}

/** groupAlive：返回「第 n 次探测时组里是否还有成员」；kill(-pid, 0) 抛 ESRCH = 组已空 */
const build = (opts: {
  platform?: string;
  alive: (probeIndex: number) => boolean;
  /** true = 2s 的优雅等待期「没到点」（sleep(2000) 悬着、由 exit 事件决定 dead），模拟 server 在期限内自己退出 */
  holdGrace?: boolean;
}): Harness => {
  const kills: Harness["kills"] = [];
  const logs: string[] = [];
  let probes = 0;
  const proc = {
    platform: opts.platform ?? "darwin",
    kill: (pid: number, signal: string | number) => {
      kills.push({ pid, signal });
      if (signal === 0) {
        const alive = opts.alive(probes++);
        if (!alive) {
          const err = new Error("ESRCH") as Error & { code: string };
          err.code = "ESRCH";
          throw err;
        }
      }
      return true;
    },
  };
  // 假 sleep：推进假时钟、微任务让出（真的 sleep 会让用例变慢）
  const sleep = (ms: number): Promise<void> => {
    if (opts.holdGrace && ms === 2000) return new Promise<void>(() => {});
    vi.advanceTimersByTime(ms);
    return Promise.resolve();
  };
  const log = (m: string) => logs.push(m);
  const execFileP = vi.fn(async () => "");
  const api = instantiateMany<{
    stopServer: Harness["stopServer"];
    signalServerTree: Harness["signalServerTree"];
    serverGroupAlive: Harness["serverGroupAlive"];
    setServerProc: Harness["setServerProc"];
  }>(
    ["signalServerTree", "serverGroupAlive", "sweepServerGroup", "stopServer"],
    { process: proc, sleep, log, execFileP },
    "let serverProc = null;",
    "return { stopServer, signalServerTree, serverGroupAlive, setServerProc: (p) => { serverProc = p; } };",
  );
  return { ...api, kills, logs };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("signalServerTree / serverGroupAlive：按进程组发信号", () => {
  it("unix：对负 pid（整组）发信号，不碰单进程 kill", () => {
    const h = build({ alive: () => true });
    const proc = makeProc();
    h.signalServerTree(proc, "SIGTERM");
    expect(h.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("整组发信号失败（组已不在 / 不是组长）→ 退回单进程 kill", () => {
    const kills: unknown[] = [];
    const proc = makeProc();
    const api = instantiateMany<{
      signalServerTree: (p: FakeProc, s: string) => void;
    }>(
      ["signalServerTree"],
      {
        process: {
          platform: "darwin",
          kill: (pid: number, sig: string) => {
            kills.push([pid, sig]);
            throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          },
        },
      },
      "",
      "return { signalServerTree };",
    );
    api.signalServerTree(proc, "SIGKILL");
    expect(kills).toEqual([[-4242, "SIGKILL"]]);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("没有 pid（spawn 失败）→ 什么都不发", () => {
    const h = build({ alive: () => true });
    const proc = makeProc();
    proc.pid = 0;
    h.signalServerTree(proc, "SIGTERM");
    h.signalServerTree(null, "SIGTERM");
    expect(h.kills).toEqual([]);
  });

  it("serverGroupAlive：kill(-pid, 0) 成功 = 活着；ESRCH = 没人了；EPERM = 存在但无权，也算活着", () => {
    const h = build({ alive: () => true });
    expect(h.serverGroupAlive(4242)).toBe(true);
    expect(h.kills.at(-1)).toEqual({ pid: -4242, signal: 0 });
    const gone = build({ alive: () => false });
    expect(gone.serverGroupAlive(4242)).toBe(false);

    const eperm = instantiateMany<{ serverGroupAlive: (pid: number) => boolean }>(
      ["serverGroupAlive"],
      {
        process: {
          platform: "darwin",
          kill: () => {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          },
        },
      },
      "",
      "return { serverGroupAlive };",
    );
    expect(eperm.serverGroupAlive(4242)).toBe(true);
  });

  it("win32 一律当没有进程组（那边走 taskkill /T /F）", () => {
    const h = build({ platform: "win32", alive: () => true });
    expect(h.serverGroupAlive(4242)).toBe(false);
    expect(h.kills).toEqual([]);
  });
});

describe("stopServer（unix）：只 TERM server → 2s → 扫尾（孙进程 TERM → 1.5s → KILL）；没退整组 SIGKILL", () => {
  const groupSignals = (h: Harness) => h.kills.filter((k) => k.signal !== 0).map((k) => k.signal);

  it("server 收到 SIGTERM 后自己退出、组里没有残留 → 只对 server 自己发 SIGTERM，整组一个信号都不发（优雅钩子有机会执行）", async () => {
    const h = build({ alive: () => false, holdGrace: true });
    const proc = makeProc();
    h.setServerProc(proc);
    const done = h.stopServer();
    // 模拟 server 的 SIGTERM 处理：收到信号后很快自己退出
    await Promise.resolve();
    proc.emit("exit", 0, null);
    await done;
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(groupSignals(h)).toEqual([]);
  });

  it("优雅阶段只 TERM server 自己（R1-8）：server 还没退出前，整组一个信号都没发——不惊动 agent 孙进程、不污染 server 的收尾写盘", async () => {
    const h = build({ alive: () => true, holdGrace: true });
    const proc = makeProc();
    h.setServerProc(proc);
    const done = h.stopServer();
    await Promise.resolve();
    // server 还在收尾（没 emit exit）：此刻只应该有一次对 server 单进程的 SIGTERM
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(groupSignals(h)).toEqual([]);
    proc.emit("exit", 0, null);
    await done;
    // server 走完、组里还有人：现在才整组 SIGTERM（再宽限 1.5s 后仍活着才 SIGKILL）
    expect(groupSignals(h)[0]).toBe("SIGTERM");
    expect(h.kills.find((k) => k.signal === "SIGTERM")).toEqual({ pid: -4242, signal: "SIGTERM" });
  });

  it("server 2s 内不退出 → 整组 SIGKILL", async () => {
    const h = build({ alive: () => true });
    const proc = makeProc();
    h.setServerProc(proc);
    await h.stopServer(); // 假 sleep 直接推进假时钟、exit 永远不来
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(groupSignals(h)).toEqual(["SIGKILL"]);
    expect(h.kills.filter((k) => k.signal !== 0).every((k) => k.pid === -4242)).toBe(true);
  });

  it("server 退出后同组有残留成员：先整组 SIGTERM、等它们自然退出，过了 1.5s 仍活着才整组 SIGKILL", async () => {
    const h = build({ alive: () => true, holdGrace: true }); // 残留成员一直不走
    const proc = makeProc();
    h.setServerProc(proc);
    const done = h.stopServer();
    await Promise.resolve();
    proc.emit("exit", 0, null);
    await done;
    expect(groupSignals(h)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.logs.some((l) => l.includes("仍有残留成员"))).toBe(true);
  });

  it("残留成员在宽限期内自己走了 → 只有那一次整组 SIGTERM、不发 SIGKILL（git 收到 SIGTERM 自清理，硬杀才留残留）", async () => {
    // 前 3 次探测还有人，之后没人了
    const h = build({ alive: (i) => i < 3, holdGrace: true });
    const proc = makeProc();
    h.setServerProc(proc);
    const done = h.stopServer();
    await Promise.resolve();
    proc.emit("exit", 0, null);
    await done;
    expect(groupSignals(h)).toEqual(["SIGTERM"]);
  });

  it("没有在跑的 server → 什么都不做", async () => {
    const h = build({ alive: () => true });
    h.setServerProc(null);
    await h.stopServer();
    expect(h.kills).toEqual([]);
  });
});

describe("main.js 接线契约（源码）", () => {
  it("server 以 detached 起（unix 自成进程组）；win32 不 detached", () => {
    expect(mainSrc).toMatch(/detached: process\.platform !== "win32",/);
  });

  it("stopServer 的 unix 路径：优雅阶段只对 server 自己发 SIGTERM；整组信号只有 2s 没退时的 SIGKILL（扫尾的 TERM / KILL 在 sweepServerGroup）", () => {
    const body = sliceMainFn("stopServer");
    expect(body).toContain('proc.kill("SIGTERM")');
    expect(body).not.toContain('signalServerTree(proc, "SIGTERM")');
    expect(body).toContain('signalServerTree(proc, "SIGKILL")');
    expect(body).toContain("sweepServerGroup(proc.pid)");
    // win32（R1-2）：走 stopWinServer（stdin EOF + 不带 /F 的 taskkill → 限时 → /T /F），不再在 stopServer 里裸 taskkill /F
    expect(body).toContain("await stopWinServer({");
    expect(body).not.toContain('"/T", "/F"');
    // 行为见 tests/electron-win-graceful-stop.test.ts
  });

  it("server 意外退出（onServerExit 的非 stale 分支）先扫尾它的进程组，再重启 / 弹窗（R1-10：否则孙进程成孤儿、与重启后的 boot-recovery 双写）", () => {
    const body = sliceMainFn("onServerExit");
    const sweepAt = body.indexOf("await sweepServerGroup(proc.pid)");
    expect(sweepAt).toBeGreaterThan(0);
    // 在「ignore 直接返回」之后、自动重启之前
    expect(body.indexOf('if (action === "ignore") return;')).toBeLessThan(sweepAt);
    expect(sweepAt).toBeLessThan(body.indexOf("startServer()"));
    expect(body).toMatch(/!stale && proc\.pid && process\.platform !== "win32"/);
  });

  it("before-quit：优雅停（preventDefault → stopServer → app.quit）unix / win32 共用（R1-2）；系统关机的同步 taskkill /T /F 兜底保留；不再有裸的 serverProc.kill(\"SIGKILL\")", () => {
    const start = mainSrc.indexOf('app.on("before-quit"');
    expect(start).toBeGreaterThan(0);
    const body = mainSrc.slice(start, mainSrc.indexOf("\n  });\n}", start));
    // 防后台节流的 stop 仍排在最前（tests/app-nap-switch.test.ts 的契约）
    expect(body.indexOf("powerSaveBlocker.stop(appNapBlockerId)")).toBeGreaterThan(0);
    // 优雅停的门槛不再排除 win32（旧：`process.platform !== "win32" &&`），只在系统关机时跳过
    expect(body).toMatch(/if \(\s*!systemShuttingDown &&\s*!serverQuitDone &&\s*\(serverProc \|\| serverQuitStopping\)\s*\) \{/);
    expect(body).not.toMatch(/process\.platform !== "win32" &&\s*!systemShuttingDown/);
    expect(body).toContain("event.preventDefault();");
    expect(body).toMatch(/void stopServer\(\)[\s\S]*?serverQuitDone = true;\s*app\.quit\(\);/);
    expect(body).toContain('execFileSync("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"]');
    expect(body).not.toContain('serverProc.kill("SIGKILL")');
    // 系统关机兜底：同步整组 SIGKILL
    expect(body).toContain('signalServerTree(serverProc, "SIGKILL")');
  });

  it("系统关机 / 注销（powerMonitor shutdown）只置标记 + 起一个复位定时器，不在监听里做耗时操作", () => {
    expect(mainSrc).toMatch(/powerMonitor\.on\("shutdown", \(\) => \{\s*systemShuttingDown = true;/);
  });

  it("关机标记会复位（R1-11）：用户取消注销 / 关机后 app 还活着，标记不能永远挂着让之后的正常退出都跳过优雅停", () => {
    const m = /systemShutdownResetTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, SYSTEM_SHUTDOWN_RESET_MS\);/.exec(mainSrc);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("systemShuttingDown = false;");
    const ms = /const SYSTEM_SHUTDOWN_RESET_MS = ([\d_]+);/.exec(mainSrc);
    expect(Number(ms![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(10_000);
    // 重复收到 shutdown 先清旧定时器、不叠加
    expect(mainSrc).toContain("if (systemShutdownResetTimer) clearTimeout(systemShutdownResetTimer);");
  });

  it("before-quit 优雅停有总看门狗（R1-11）：超时整组 SIGKILL 后强制 app.quit，stopServer 先清掉 serverProc 所以句柄要提前留一份", () => {
    const start = mainSrc.indexOf('app.on("before-quit"');
    const body = mainSrc.slice(start, mainSrc.indexOf("\n  });\n}", start));
    expect(body).toContain("const quitProc = serverProc;");
    // 看门狗的强杀走 killServerTreeSync（unix 整组 SIGKILL / win32 taskkill /T /F），行为见 tests/electron-win-graceful-stop.test.ts
    expect(body).toMatch(/setTimeout\(\(\) => \{[\s\S]*?killServerTreeSync\(quitProc\);[\s\S]*?serverQuitDone = true;\s*app\.quit\(\);[\s\S]*?\}, SERVER_QUIT_WATCHDOG_MS\)/);
    expect(body).toContain("clearTimeout(watchdog);");
    // 看门狗已放行过的话 finally 不再重复 quit
    expect(body).toContain("if (serverQuitDone) return; // 看门狗已经放行过一次");
    // unix 看门狗必须大于 stopServer 各步上限之和的主体（2s + 1.5s + 1s），否则会抢在正常收尾前放行
    // （R8-4 起 win32 单独一档 WIN_QUIT_WATCHDOG_MS，预算见 tests/electron-win-graceful-stop.test.ts）
    const w = /const SERVER_QUIT_WATCHDOG_UNIX_MS = ([\d_]+);/.exec(mainSrc);
    expect(Number(w![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(4500 + 1000);
    expect(mainSrc).toContain(
      'const SERVER_QUIT_WATCHDOG_MS = process.platform === "win32" ? WIN_QUIT_WATCHDOG_MS : SERVER_QUIT_WATCHDOG_UNIX_MS;',
    );
  });
});

describe("server 侧信号退出钩子（评审 R1-1：重发信号会被 Next 的持久监听器接走）", () => {
  const inboundSrc = readFileSync(
    path.join(__dirname, "../src/lib/server/feishu-bridge/inbound.ts"),
    "utf8",
  );
  const start = inboundSrc.indexOf("const ensureExitHook = (): void => {");
  const body = inboundSrc.slice(start, inboundSrc.indexOf("\n};\n", start));

  // 信号 / stdin EOF 共用的退出序列（R8-4 起抽成 runExitSequence，依赖可注入；顺序行为见 tests/win-self-tree-kill.test.ts）
  const seqStart = inboundSrc.indexOf("export const runExitSequence = async (");
  const seqBody = inboundSrc.slice(seqStart, inboundSrc.indexOf("\n};\n", seqStart));

  it("清理后显式 process.exit，不再重发原信号（Next start-server 的 SIGTERM 监听器会吞掉它、server.close 又被 SSE 长连挂住）", () => {
    expect(start).toBeGreaterThan(0);
    expect(seqStart).toBeGreaterThan(0);
    expect(seqBody).toContain("process.exit(code)");
    expect(body).toContain("runExitSequence(signal, killTreeOnWin)");
    expect(body).not.toContain("process.kill(process.pid");
    expect(seqBody).not.toContain("process.kill(process.pid");
  });

  it("清理上限小于壳侧 stopServer 的 2s SIGKILL 兜底，且清理抛错也照样退出", () => {
    const cap = /const EXIT_HOOK_CLEANUP_CAP_MS = (\d+);/.exec(inboundSrc);
    expect(cap).not.toBeNull();
    expect(Number(cap![1])).toBeLessThan(2000);
    // 清理本体（R1-9 后抽成 runExitCleanup）：带上限的优雅停包在 try/catch 里（抛错也往下走），随后同步强杀残留进程组；
    // 信号处理里必须 await 它、之后才 process.exit（清理再怎么失败也要退）
    const cleanupStart = inboundSrc.indexOf("const runExitCleanup = async (): Promise<void> => {");
    expect(cleanupStart).toBeGreaterThan(0);
    const cleanupBody = inboundSrc.slice(cleanupStart, inboundSrc.indexOf("\n};\n", cleanupStart));
    expect(cleanupBody).toMatch(/try \{[\s\S]*?EXIT_HOOK_CLEANUP_CAP_MS[\s\S]*?\} catch \{[\s\S]*?\}\s*try \{\s*forceKillAllManagedChildrenSync\(\);[\s\S]*?\} catch \{/);
    expect(seqBody).toMatch(/await \(deps\.cleanup \?\? runExitCleanup\)\(\);[\s\S]*?process\.exit\(code\)/);
  });

  it("另外挂 process.once(\"exit\") 同步强杀：Next 的 SIGTERM cleanup 会抢先 process.exit(0)，onSignal 里的强杀轮不到（行为见 feishu-bridge-exit-force-kill-realproc.test.ts）", () => {
    expect(body).toMatch(/process\.once\("exit", forceKillOnExit\);/);
    const fnStart = inboundSrc.indexOf("const forceKillOnExit = (): void => {");
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = inboundSrc.slice(fnStart, inboundSrc.indexOf("\n};\n", fnStart));
    // 只做强杀这一件事、同步、try/catch 容错；不在 exit 钩子里重复触发别的副作用
    expect(fnBody).toMatch(/try \{\s*forceKillAllManagedChildrenSync\(\);\s*\} catch \{/);
    expect(fnBody).not.toContain("stopBridgeRuntime");
    expect(fnBody).not.toContain("stopAllManagedChildren");
    expect(fnBody).not.toContain("await");
  });
});
