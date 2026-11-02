/**
 * 飞书桥接防睡眠：macOS 的 caffeinate 必须带 `-w <server pid>`。
 * 壳退出时对 server 直接 SIGKILL，stop() 来不及跑；没有 -w 会留下孤儿 caffeinate -s，
 * 插电时整机不再睡眠（review #9）。
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeepAwake, buildWinKeepAwakePs } from "@/lib/server/feishu-bridge/keep-awake";

const fakeChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: () => boolean;
  };
  child.pid = 4242;
  child.kill = vi.fn(() => true);
  return child;
};

describe("KeepAwake", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.runIf(process.platform === "darwin")(
    "darwin：caffeinate 带 -s 和 -w <本进程 pid>",
    () => {
      const spawnMock = vi.fn(() => fakeChild());
      const ka = new KeepAwake();
      ka.__setSpawnForTest(spawnMock as unknown as typeof spawn);
      vi.spyOn(console, "error").mockImplementation(() => {});

      ka.start();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args] = spawnMock.mock.calls[0] as unknown as [
        string,
        string[],
      ];
      expect(bin).toBe("/usr/bin/caffeinate");
      expect(args).toEqual(["-s", "-w", String(process.pid)]);
      ka.stop();
    },
  );

  it("win32 脚本：带父进程存活检查，父进程没了释放断言并退出（不留孤儿 PowerShell）", () => {
    const ps = buildWinKeepAwakePs(12345);
    expect(ps).toContain("$parentPid = 12345");
    expect(ps).toMatch(/Get-Process -Id \$parentPid/);
    // 退出前如果持有断言必须先释放（0x80000000 = ES_CONTINUOUS 单独设置 = 清除）
    const exitIdx = ps.indexOf("exit 0");
    expect(exitIdx).toBeGreaterThan(-1);
    const releaseIdx = ps.lastIndexOf("SetThreadExecutionState(0x80000000)", exitIdx);
    expect(releaseIdx).toBeGreaterThan(-1);
    // 轮询间隔不能回到 30s：父进程死后孤儿最多多活一个间隔
    const sleepSec = Number(/Start-Sleep -Seconds (\d+)/.exec(ps)?.[1]);
    expect(sleepSec).toBeLessThanOrEqual(10);
  });

  it("win32 脚本：非法 pid 不会被拼进脚本（只允许正整数）", () => {
    for (const bad of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY]) {
      const ps = buildWinKeepAwakePs(bad);
      expect(ps).toContain("$parentPid = 0");
    }
    expect(buildWinKeepAwakePs("1; calc" as unknown as number)).toContain("$parentPid = 0");
  });

  it.runIf(process.platform === "win32")("win32：powershell 脚本带本进程 pid", () => {
    const spawnMock = vi.fn(() => fakeChild());
    const ka = new KeepAwake();
    ka.__setSpawnForTest(spawnMock as unknown as typeof spawn);
    vi.spyOn(console, "error").mockImplementation(() => {});
    ka.start();
    const args = (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args[args.length - 1]).toContain(`$parentPid = ${process.pid}`);
    ka.stop();
  });

  it("start 幂等：已有子进程时不重复 spawn", () => {
    const spawnMock = vi.fn(() => fakeChild());
    const ka = new KeepAwake();
    ka.__setSpawnForTest(spawnMock as unknown as typeof spawn);
    vi.spyOn(console, "error").mockImplementation(() => {});

    ka.start();
    ka.start();

    // linux 平台会直接跳过（不 spawn）：只断言「不会多于 1 次」
    expect(spawnMock.mock.calls.length).toBeLessThanOrEqual(1);
    ka.stop();
  });
});
