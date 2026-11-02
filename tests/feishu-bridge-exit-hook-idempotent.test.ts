/**
 * ensureExitHook 幂等：多次 sync / 多个入口（syncBridgeRuntime / ensureBridgeRuntimePolling）反复触发，
 * SIGTERM / SIGINT / beforeExit / exit 四种退出监听各只注册一次。
 *
 * 重复注册的后果：每个 SIGTERM 监听器各自跑一遍退出清理（并发的 stopBridgeRuntime / stopAllManagedChildren），
 * exit 监听器多次强杀；dev 热重载下还会随每次重载叠加（MaxListenersExceededWarning）。
 *
 * 做法：spy `process.once`，只拦本模块用到的四个退出事件（记录、不真注册，所以不往测试进程里挂监听器、
 * 也就谈不上污染别的用例）；其它事件原样透传。runtime 是 globalThis 单例，先把幂等标记复位、测完还原。
 */
import { promises as fs } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

import { makeBridgeTmpDataDir } from "./helpers/feishu-bridge-harness";

const TMP = makeBridgeTmpDataDir("feishu-bridge-exit-hook");
await fs.mkdir(`${TMP}/data`, { recursive: true });

const { __resetBridgeRuntimeForTest, syncBridgeRuntime } = await import(
  "@/lib/server/feishu-bridge/inbound"
);

const RUNTIME_KEY = "__flowshipFeishuBridgeRuntimeV1__";
const HOOK_EVENTS = ["SIGTERM", "SIGINT", "beforeExit", "exit"];

afterAll(async () => {
  await __resetBridgeRuntimeForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("ensureExitHook 幂等", () => {
  it("反复 sync：四种退出监听（含 exit 强杀 hook）各只注册一次，之后再 sync 也不增加", async () => {
    const g = globalThis as unknown as Record<string, { exitHooked?: boolean } | undefined>;
    const rt = g[RUNTIME_KEY];
    const prevHooked = rt?.exitHooked;
    if (rt) rt.exitHooked = false; // 复位幂等标记：同一 worker 里先前的用例可能已经挂过

    const registered: string[] = [];
    const realOnce = process.once.bind(process) as (ev: string, fn: (...a: unknown[]) => void) => unknown;
    const spy = vi.spyOn(process, "once").mockImplementation(((ev: string, fn: (...a: unknown[]) => void) => {
      if (HOOK_EVENTS.includes(ev)) {
        registered.push(ev);
        return process;
      }
      return realOnce(ev, fn);
    }) as never);
    try {
      // 桥接开关默认关 → sync 只会走「全停」分支，不会 spawn 任何东西；但每次 sync 都会先过 ensureExitHook
      await syncBridgeRuntime();
      await syncBridgeRuntime();
      await syncBridgeRuntime();
      expect([...registered].sort()).toEqual([...HOOK_EVENTS].sort()); // 每种恰好一次
      expect(registered.filter((e) => e === "exit")).toHaveLength(1);

      await syncBridgeRuntime();
      expect(registered).toHaveLength(HOOK_EVENTS.length); // 标记已置位，继续调用不再注册
    } finally {
      spy.mockRestore();
      const after = g[RUNTIME_KEY];
      if (after) after.exitHooked = prevHooked ?? false; // 还原：测试里并没有真的挂上监听器
    }
  });
});
