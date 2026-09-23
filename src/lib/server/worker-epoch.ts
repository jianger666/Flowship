/**
 * Worker epoch 派发（v3.1 §7，封版纪要修订一）。
 *
 * - epoch 按 stateRoot（= workspace 粒度）独立单调，持久化在
 *   `<stateRoot>/worker-epoch.json`，跨 workspace 互不影响；
 * - 并发 spawn 防回退：锁文件 `O_EXCL` 自旋 + tmp 写完 rename 原子提交；
 * - fencing 比较只在同 stateRoot 内生效，纯判定见 mem-governance.isWriteFenced。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./data-root";
import {
  nextWorkerEpoch,
  parseWorkerEpoch,
  WORKER_EPOCH_FILENAME,
} from "./mem-governance";

export const workerEpochFile = (stateRoot: string): string =>
  path.join(stateRoot, WORKER_EPOCH_FILENAME);

const lockFileOf = (stateRoot: string): string =>
  path.join(stateRoot, `${WORKER_EPOCH_FILENAME}.lock`);

export const readWorkerEpoch = async (stateRoot: string): Promise<number> => {
  try {
    const raw = await fs.readFile(workerEpochFile(stateRoot), "utf-8");
    return parseWorkerEpoch(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
};

const acquireLock = async (
  lockPath: string,
  timeoutMs = 5000,
): Promise<() => Promise<void>> => {
  const start = Date.now();
  for (;;) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `[worker-epoch] 拿锁超时（${lockPath}），疑似有进程持有锁未释放`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
};

/**
 * 分配下一个 epoch：读 → +1 → 原子落盘。并发调用靠锁文件串行化，
 * 杜绝两进程同读 n 同写 n+1 的回退。
 */
export const allocateWorkerEpoch = async (
  stateRoot: string,
): Promise<number> => {
  await ensurePrivateDir(stateRoot);
  const release = await acquireLock(lockFileOf(stateRoot));
  try {
    const current = await readWorkerEpoch(stateRoot);
    const next = nextWorkerEpoch(current);
    const finalPath = workerEpochFile(stateRoot);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({ epoch: next }),
      "utf-8",
    );
    await fs.rename(tmpPath, finalPath);
    return next;
  } finally {
    await release();
  }
};
