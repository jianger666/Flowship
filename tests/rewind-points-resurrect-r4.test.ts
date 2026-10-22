/**
 * 第四轮 Q3-08：`writeRewindPoints` 同 D4b-02 族——DELETE 之后迟到的写入不得把已删任务的目录复活。
 *
 * 旧实现 `mkdir(checkpoints, { recursive: true })` 会连任务目录一起重建成「只有 checkpoints/rewind_points.jsonl」的空壳，
 * 再次 DELETE → 202 recoveryPending。真实文件系统、真实删除，不 mock。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-rewind-resurrect-r4-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  getCheckpointsDir,
  getRewindPointsPath,
  readRewindPoints,
  writeRewindPoints,
} from "@/lib/server/chat-checkpoint";
import { taskDir } from "@/lib/server/task-fs-core";
import type { RewindPoint } from "@/lib/server/chat-checkpoint";

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);
const point = (n: number): RewindPoint =>
  ({
    eventId: `ev_${n}`,
    createdAt: 1700000000000 + n,
    repoSnapshots: [],
  }) as unknown as RewindPoint;

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Q3-08：writeRewindPoints 不复活被删任务的目录", () => {
  it("任务目录已被真实删除 → 迟到写入降级为不写：不抛、不复活 taskDir / checkpoints / jsonl", async () => {
    const id = "t_1700000039001_late";
    await fs.mkdir(taskDir(id), { recursive: true });
    await writeRewindPoints(id, [point(1)]);
    expect(await exists(getRewindPointsPath(id))).toBe(true);
    await fs.rm(taskDir(id), { recursive: true, force: true }); // DELETE 200

    await writeRewindPoints(id, []); // 迟到的写入（旧实现：mkdir -p 复活）

    expect(await exists(taskDir(id))).toBe(false);
    expect(await exists(getCheckpointsDir(id))).toBe(false);
  });

  it("并发：真实删除之后一批迟到写入同时到达（含非空 points）也不复活", async () => {
    const id = "t_1700000039002_burst";
    await fs.mkdir(taskDir(id), { recursive: true });
    await fs.rm(taskDir(id), { recursive: true, force: true });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeRewindPoints(id, i % 2 ? [] : [point(i)])),
    );

    expect(await exists(taskDir(id))).toBe(false);
  });

  it("删除与写入交错（写入过程中目录被并发删掉）：不抛，且最终没有复活出来的空壳", async () => {
    for (let round = 0; round < 15; round++) {
      const id = `t_1700000039${String(100 + round)}_race`;
      await fs.mkdir(taskDir(id), { recursive: true });
      const writes = Array.from({ length: 6 }, (_, i) => writeRewindPoints(id, [point(i)]));
      await fs.rm(taskDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 5 });
      await expect(Promise.all(writes)).resolves.toBeDefined();
      // 删除之后到达的写入：绝不再把目录建回来
      await writeRewindPoints(id, [point(99)]);
      await fs.rm(taskDir(id), { recursive: true, force: true }); // 清理「删除前一瞬间」可能合法落下的内容
      await writeRewindPoints(id, []);
      expect(await exists(taskDir(id))).toBe(false);
    }
  });

  it("对照（旧树能用的情形）：任务目录在、checkpoints/ 还没建 → 首次写入照常建目录并落盘；覆盖写 / 清空也正常", async () => {
    const id = "t_1700000039003_alive";
    await fs.mkdir(taskDir(id), { recursive: true });
    expect(await exists(getCheckpointsDir(id))).toBe(false);

    await writeRewindPoints(id, [point(1), point(2)]);
    expect((await readRewindPoints(id)).map((p) => p.eventId)).toEqual(["ev_1", "ev_2"]);

    await writeRewindPoints(id, [point(3)]);
    expect((await readRewindPoints(id)).map((p) => p.eventId)).toEqual(["ev_3"]);

    await writeRewindPoints(id, []);
    expect(await readRewindPoints(id)).toEqual([]);
    expect(await exists(getRewindPointsPath(id))).toBe(true);
  });
});
