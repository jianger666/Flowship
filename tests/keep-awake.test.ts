/**
 * 飞书桥接防睡眠：macOS 的 caffeinate 必须带 `-w <server pid>`。
 * 壳退出时对 server 直接 SIGKILL，stop() 来不及跑；没有 -w 会留下孤儿 caffeinate -s，
 * 插电时整机不再睡眠（review #9）。
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeepAwake } from "@/lib/server/feishu-bridge/keep-awake";

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
