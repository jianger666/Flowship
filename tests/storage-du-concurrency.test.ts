/**
 * GET /api/system/storage：任务数据目录的 `du` 要有界并发（第三轮 review D2b-02）。
 *
 * 旧实现里任务数据目录的 dirSize 在 readdir 循环里串行 `await`（只有 worktree 那段走了并发池）：
 * 几百个会话 + 慢盘时存储页扫描要等分钟级。现在每个任务一路（数据 + 工作区），整体最多 4 路同时跑 du，
 * 结果按任务顺序对应，不受完成先后影响。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ inFlight: 0, max: 0, calls: 0, dataInFlight: 0, dataMax: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, value?: { stdout: string; stderr: string }) => void,
    ) => {
      if (cmd !== "du") {
        return (actual.execFile as unknown as (...a: unknown[]) => unknown)(cmd, args, opts, cb);
      }
      const dir = args[args.length - 1];
      const idx = Number(/_(\d+)$/.exec(dir)?.[1] ?? "0");
      const isWorktree = dir.includes(`${path.sep}worktrees${path.sep}`);
      // 数据目录 (idx+1) KB；工作区 (1000+idx) KB——一眼分得出配错了谁
      const kb = isWorktree ? 1000 + idx : idx + 1;
      probe.inFlight += 1;
      probe.calls += 1;
      probe.max = Math.max(probe.max, probe.inFlight);
      if (!isWorktree) {
        probe.dataInFlight += 1;
        probe.dataMax = Math.max(probe.dataMax, probe.dataInFlight);
      }
      // 编号越小完成得越慢：完成顺序与入参顺序相反，能抓出「按完成顺序回填」的错位
      setTimeout(() => {
        probe.inFlight -= 1;
        if (!isWorktree) probe.dataInFlight -= 1;
        cb(null, { stdout: `${kb}\t${dir}\n`, stderr: "" });
      }, (12 - idx) * 4);
      return undefined;
    },
  };
});

const TMP_ROOT = path.join(os.tmpdir(), `fe-storage-du-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import { GET } from "@/app/api/system/storage/route";
import { DATA_DIR as TASKS_DIR } from "@/lib/server/task-fs-core";
import { getTaskWorktreesDir } from "@/lib/server/task-worktrees";

const N = 10;
// 末尾 `_NN` 就是序号：du mock 靠它回填大小、并决定谁完成得慢
const idOf = (i: number) => `t_1700000009${String(i).padStart(3, "0")}_${String(i).padStart(2, "0")}`;

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("storage GET：du 有界并发 + 顺序对应", () => {
  it("同时在跑的 du 不超过 4 路、且确实并发了；每个任务拿到自己的大小", async () => {
    for (let i = 0; i < N; i++) {
      await fs.mkdir(path.join(TASKS_DIR, idOf(i)), { recursive: true });
      await fs.mkdir(getTaskWorktreesDir(idOf(i)), { recursive: true });
    }
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ id: string; bytes: number; worktreeBytes: number }>;
    };

    expect(probe.calls).toBe(N * 2);
    // 任务数据目录那一段本身要并发（旧实现这段是串行 await → dataMax === 1）
    expect(probe.dataMax).toBeGreaterThan(1);
    // 总体有界：无界会是 N 甚至 2N
    expect(probe.max).toBeLessThanOrEqual(4);

    for (let i = 0; i < N; i++) {
      const e = body.entries.find((x) => x.id === idOf(i));
      expect(e, `entry ${idOf(i)}`).toBeDefined();
      expect(e!.bytes).toBe((i + 1) * 1024);
      expect(e!.worktreeBytes).toBe((1000 + i) * 1024);
    }
  });
});
