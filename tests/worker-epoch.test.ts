import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateWorkerEpoch,
  readWorkerEpoch,
  workerEpochFile,
} from "../src/lib/server/worker-epoch";

const mkStateRoot = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-epoch-"));
  return dir;
};

describe("worker-epoch 按 stateRoot 独立", () => {
  it("缺失回 0，分配从 1 开始递增", async () => {
    const root = await mkStateRoot();
    expect(await readWorkerEpoch(root)).toBe(0);
    expect(await allocateWorkerEpoch(root)).toBe(1);
    expect(await allocateWorkerEpoch(root)).toBe(2);
    expect(await readWorkerEpoch(root)).toBe(2);
  });

  it("跨 workspace 互不影响", async () => {
    const a = await mkStateRoot();
    const b = await mkStateRoot();
    expect(workerEpochFile(a)).not.toBe(workerEpochFile(b));
    await allocateWorkerEpoch(a);
    await allocateWorkerEpoch(a);
    await allocateWorkerEpoch(b);
    expect(await readWorkerEpoch(a)).toBe(2);
    expect(await readWorkerEpoch(b)).toBe(1);
  });

  it("并发分配不回退", async () => {
    const root = await mkStateRoot();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => allocateWorkerEpoch(root)),
    );
    expect(new Set(results).size).toBe(8);
    expect(await readWorkerEpoch(root)).toBe(8);
  });
});
