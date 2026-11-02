/**
 * 退出路径（评审 R1-9）：不听 SIGTERM 的预览 dev server，退出清理跑完后其进程组必须已经没了。
 *
 * 上一版只用 `sleep 60`（会响应 TERM、合作退出），测不出问题：真实的 dev server 可能忽略 SIGTERM，
 * 而退出钩子只等 1.5s、预览优雅停是「TERM → 等 2s → KILL」，到点 process.exit 把 KILL 一起带走，
 * dev server 作为独立进程组（detached）会残留、一直占着端口。
 *
 * 本测试用 `trap '' TERM`（SIG_IGN 会被 fork/exec 继承，整组都忽略 TERM，只有 KILL 能杀）。
 * `runExitCleanupLikeHook` 复刻 inbound.ts `runExitCleanup` 的序列（race(优雅停, 1.5s) → 同步强杀）；
 * 钩子本身「真的调了强杀」由 tests/feishu-bridge-inbound.test.ts 的接线用例覆盖
 * （这里不 import inbound：它的依赖图会让 task-fs 的准入 mock 失效）。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-preview-exit-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    readTaskRepoStatusFresh: async () => "developing" as const,
  };
});

import {
  forceKillAllManagedChildrenSync,
  stopAllManagedChildren,
} from "@/lib/server/kill-orphans";
import { startPreview, stopAllPreviews } from "@/lib/server/preview-manager";

const isProcessGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
};

/** 与 inbound.ts runExitCleanup 同序：优雅停最多等 1.5s，然后同步强杀 */
const runExitCleanupLikeHook = async (): Promise<void> => {
  await Promise.race([stopAllManagedChildren(), sleep(1500)]);
  forceKillAllManagedChildrenSync();
};

/** 先装好「忽略 TERM」再落个就绪标记——测试要等标记出现才发 TERM，否则 sh 还没执行 trap 就被 TERM 默认杀掉了 */
const ignoreTermCommand = (marker: string): string =>
  `trap '' TERM; touch '${marker}'; while :; do sleep 1; done`;
const spawnedPids: number[] = [];

const startUncooperative = async (id: string): Promise<number> => {
  const marker = path.join(TMP_ROOT, `ready-${id}`);
  const { status } = await startPreview({
    taskId: `task-${id}`,
    taskTitle: `任务 ${id}`,
    repoPath: `/repo/${id}`,
    workDir: TMP_ROOT,
    command: ignoreTermCommand(marker),
  });
  expect(status.exited).toBe(false);
  expect(
    await waitUntil(() => existsSync(marker), 5000),
  ).toBe(true);
  // pid 取自 pidfile（preview-manager 写的就是进程组长 pid）
  const raw = JSON.parse(await fs.readFile(path.join(TMP_ROOT, "preview.json"), "utf8")) as Array<{
    pid: number;
    repoPath?: string;
  }>;
  const rec = raw.find((r) => r.repoPath === `/repo/${id}`);
  expect(rec?.pid).toBeTruthy();
  spawnedPids.push(rec!.pid);
  return rec!.pid;
};

beforeEach(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterEach(async () => {
  // 兜底收尾：测试失败时也不留 `trap '' TERM` 的死循环进程
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 已死
    }
  }
  await stopAllPreviews();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("退出清理：不听 SIGTERM 的预览 dev server", () => {
  it("退出清理（race(优雅停, 1.5s) → 强杀）返回时，忽略 SIGTERM 的预览进程组已被强杀（旧实现：只发了 TERM、随后 process.exit 带走 KILL → 残留）", async () => {
    const pid = await startUncooperative("stubborn");
    expect(isProcessGroupAlive(pid)).toBe(true);

    const t0 = Date.now();
    await runExitCleanupLikeHook();
    const elapsed = Date.now() - t0;

    // 强杀是同步的：清理函数一返回（process.exit 之前）组就该没了；只给内核回收 / Node reap 一点点时间。
    // 窗口必须远小于「优雅停自己的 KILL 到点时间」（上限后还差 ~0.5s）：测试进程不会真 exit、
    // 优雅停的后台轮询会在 2s 时补上 KILL——窗口放宽就测不出「少了同步强杀」
    expect(await waitUntil(() => !isProcessGroupAlive(pid), 250)).toBe(true);
    // 且没有把退出拖过壳侧 2s 的 SIGKILL 兜底（1.5s 上限 + 余量）
    expect(elapsed).toBeLessThan(1900);
  }, 15_000);

  it("多个不合作的预览并行强杀：每个进程组都没了", async () => {
    const pids = [await startUncooperative("a"), await startUncooperative("b"), await startUncooperative("c")];
    await runExitCleanupLikeHook();
    for (const pid of pids) {
      expect(await waitUntil(() => !isProcessGroupAlive(pid), 250)).toBe(true);
    }
  }, 15_000);

  it("优雅停还在途（slot 已摘、TERM 已发、等 KILL 中）时进程退出：在途的进程组也被强杀", async () => {
    const pid = await startUncooperative("inflight");
    // 不 await：stopAllPreviews 摘掉 slot、发 TERM 后进入「等 2s 再 KILL」的轮询——模拟退出钩子撞上它
    const stopping = stopAllPreviews();
    await sleep(300);
    expect(isProcessGroupAlive(pid)).toBe(true); // 忽略 TERM、还活着
    forceKillAllManagedChildrenSync();
    expect(await waitUntil(() => !isProcessGroupAlive(pid), 500)).toBe(true);
    await stopping;
  }, 15_000);

  it("stopAllPreviews 并行优雅停：3 个都不听 TERM，总耗时 ≈ 一轮 TERM→KILL（~2s），不是串行的 3 轮（~6s）", async () => {
    const pids = [await startUncooperative("p1"), await startUncooperative("p2"), await startUncooperative("p3")];
    const t0 = Date.now();
    await stopAllPreviews();
    const elapsed = Date.now() - t0;
    for (const pid of pids) {
      expect(await waitUntil(() => !isProcessGroupAlive(pid), 500)).toBe(true);
    }
    expect(elapsed).toBeLessThan(4000);
  }, 20_000);

  it("没有预览在跑时强杀是空操作、不抛", () => {
    expect(() => forceKillAllManagedChildrenSync()).not.toThrow();
  });
});
