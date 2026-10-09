/**
 * fast-checkpoint-store 测试共用：临时目录、SDK 加载、确定性随机、故障注入文件系统。
 * 不以 .test.ts 结尾，vitest 不会把它当用例。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalAgentStoreCheckpoints } from "@cursor/sdk";

import {
  CHECKPOINTS_FILENAME,
  FastCheckpoints,
  type FastCheckpointsOptions,
  type FileHandleLike,
  type FsLike,
  realFs,
} from "@/lib/server/fast-checkpoint-store";

// ───────── 临时目录 ─────────

const dirs: string[] = [];

export const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fcp-test-"));
  dirs.push(d);
  return d;
};

/** Windows 上刚关的句柄可能还被杀毒占着，rm 带重试 */
export const cleanupTmps = (): void => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
};

export const fileOf = (dir: string): string => path.join(dir, CHECKPOINTS_FILENAME);
export const tmpFileOf = (dir: string): string => `${fileOf(dir)}.compact-tmp`;

// ───────── SDK（真实实现，作为对拍的标准答案） ─────────

export const loadSdk = async () => {
  const sdk = await import("@cursor/sdk");
  return {
    JsonlLocalAgentStore: sdk.JsonlLocalAgentStore,
    paginate: sdk.paginateCheckpointBlobIds,
  };
};

export type Sdk = Awaited<ReturnType<typeof loadSdk>>;

/** 造一个 FastCheckpoints；默认吞掉告警避免测试输出噪声，需要断言告警时传 onWarn */
export const mkFast = (
  dir: string,
  sdk: Sdk,
  opts: FastCheckpointsOptions = {},
): FastCheckpoints =>
  new FastCheckpoints(dir, sdk.paginate, { onWarn: () => undefined, ...opts });

// ───────── 数据 ─────────

export const A = "agent-1";

export const blobData = (i: number): Buffer =>
  Buffer.from(`blob-${i}-` + "x".repeat(50 + (i % 7) * 13));

export const seed = async (
  cp: LocalAgentStoreCheckpoints,
  n: number,
  agentId = A,
): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await cp.create({ agentId, blobId: `b${i}`, data: blobData(i) });
  }
};

export const sameBytes = (got: Uint8Array | null, want: Uint8Array): boolean =>
  !!got && Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0;

/** b0..b(n-1) 全部读到且等于预期（override 覆盖个别 blob 的预期值） */
export const allBlobsOk = async (
  cp: LocalAgentStoreCheckpoints,
  n: number,
  override: Record<number, Uint8Array> = {},
  agentId = A,
): Promise<boolean> => {
  for (let i = 0; i < n; i++) {
    const got = await cp.get({ agentId, blobId: `b${i}` });
    if (!sameBytes(got, override[i] ?? blobData(i))) return false;
  }
  return true;
};

/** 用 SDK 原实现的 reader 读同一目录——证明文件格式向后兼容 */
export const sdkReaderOk = async (
  dir: string,
  sdk: Sdk,
  n: number,
  override: Record<number, Uint8Array> = {},
  agentId = A,
): Promise<boolean> =>
  allBlobsOk(new sdk.JsonlLocalAgentStore(dir).checkpoints, n, override, agentId);

/** mulberry32：固定种子的确定性随机，失败可复现 */
export const rng = (seedValue: number): (() => number) => {
  let s = seedValue | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ───────── 故障注入文件系统 ─────────

export const mkErr = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code }) as NodeJS.ErrnoException;

export interface FaultHooks {
  /** 返回 { code } 则 open 抛该错误码 */
  open?: (file: string, flags: string) => { code: string } | null | undefined;
  rename?: (from: string, to: string) => { code: string } | null | undefined;
  /** 包装句柄，可改写 read / appendFile 等行为 */
  wrapFd?: (fd: FileHandleLike, meta: { file: string; flags: string }) => FileHandleLike;
  /**
   * 严格模拟 Windows/libuv 的追加句柄权限：O_APPEND 打开时去掉 FILE_WRITE_DATA 且不带读权限，
   * 所以 "a" 句柄上的 read / write / truncate / sync 都会被系统拒绝（EPERM）。
   * 实现只要从不在 "a" 句柄上调用这些，就证明它不依赖追加句柄的额外能力。
   */
  windowsAppendSemantics?: boolean;
}

export interface FaultLog {
  opens: Array<{ file: string; flags: string }>;
  syncs: Array<{ flags: string }>;
  truncates: Array<{ flags: string; len: number }>;
  renames: number;
  /** 同时处于打开状态的句柄数峰值 */
  peakOpen: number;
}

export const faultyFs = (
  hooks: FaultHooks = {},
): { fs: FsLike; log: FaultLog } => {
  const log: FaultLog = { opens: [], syncs: [], truncates: [], renames: 0, peakOpen: 0 };
  let openNow = 0;
  const wrap = (fd: FileHandleLike, meta: { file: string; flags: string }): FileHandleLike => {
    openNow += 1;
    log.peakOpen = Math.max(log.peakOpen, openNow);
    let closed = false;
    const winAppend = !!hooks.windowsAppendSemantics && meta.flags === "a";
    const guard = (name: string): void => {
      if (winAppend) {
        throw Object.assign(mkErr("EPERM"), {
          message: `EPERM: ${name} on append-only handle`,
        });
      }
    };
    const base: FileHandleLike = {
      stat: () => fd.stat(),
      read: (b, o, l, p) => {
        guard("read");
        return fd.read(b, o, l, p);
      },
      write: (b, o, l, p) => {
        guard("write");
        return fd.write(b, o, l, p);
      },
      appendFile: (d) => fd.appendFile(d),
      sync: () => {
        log.syncs.push({ flags: meta.flags });
        guard("sync");
        return fd.sync();
      },
      truncate: (len) => {
        log.truncates.push({ flags: meta.flags, len });
        guard("truncate");
        return fd.truncate(len);
      },
      close: async () => {
        if (!closed) {
          closed = true;
          openNow -= 1;
        }
        await fd.close();
      },
    };
    return hooks.wrapFd ? hooks.wrapFd(base, meta) : base;
  };
  const fsx: FsLike = {
    ...realFs,
    open: async (file, flags) => {
      log.opens.push({ file, flags });
      const h = hooks.open?.(file, flags);
      if (h?.code) throw mkErr(h.code);
      return wrap(await realFs.open(file, flags), { file, flags });
    },
    rename: async (from, to) => {
      log.renames += 1;
      const h = hooks.rename?.(from, to);
      if (h?.code) throw mkErr(h.code);
      return realFs.rename(from, to);
    },
  };
  return { fs: fsx, log };
};
