/**
 * Cursor SDK 本地 agent 的落盘位置与 store 组装。
 *
 * 默认 SQLite 写在用户级 `~/.cursor/...`（WAL：`store.db-wal` / `store.db-shm`）。
 * Windows 上杀毒实时扫描 / OneDrive 重定向家目录时，长 run 收尾重开 WAL 会报
 * `[internal] unable to open database file`（官方 2026-07-28 已确认）。
 *
 * Flowship 会话跨进程恢复走 events.jsonl，不依赖这份 SDK store；所以改挂
 * dataRoot 下的 JSONL（官方规避、避开 SQLite WAL）。
 *
 * ── checkpoints 加速（2026-10-08）──
 * SDK 自带 JSONL store 的 checkpoints 每次 get/create/update/list 都整份读入内存并
 * JSON.parse 每一行、写则整文件重写，且全局串行——文件越大越慢、内存放大约 28 倍
 * （官方已复现未修复，1.0.37 同 1.0.31）。这里只替换 checkpoints 这一层
 * （占体积 99%），其余三份小文件仍用 SDK 自带实现，经公开 API
 * `composeLocalAgentStore` 组合。文件格式与 SDK 逐字节兼容、不用迁移。详见
 * `fast-checkpoint-store.ts` 头注释（含不变式清单）。
 *
 * **单写者是硬约束**：同一目录同一进程只能有一个 FastCheckpoints 实例，所以实例只经
 * `getSdkStoreHandle()` 的 globalThis 单例获取；GC 等任何要碰 checkpoints 的代码也必须
 * 经这个句柄（见 sdk-store-gc.ts），不得绕过它直接读写 `checkpoints.ndjson`。
 *
 * 一键回退（任一即可，重启生效）：
 *   - 环境变量 `FLOWSHIP_SDK_STORE=sdk`；
 *   - 在 `<dataRoot>/sdk-agent-store/` 下新建空文件 `USE_SDK_STORE`（桌面包用户最方便）。
 * 预热（建索引）失败时自动回退到 SDK 自带实现——此时尚无任何写入，回退是安全的。
 *
 * 单例挂 globalThis：dev HMR / 多 route chunk 不能各 new 一份，resume 要对上同一目录。
 */
import fsp from "node:fs/promises";
import path from "node:path";

import type * as CursorSdk from "@cursor/sdk";
import type { LocalAgentStore } from "@cursor/sdk";

import { dataRoot, ensurePrivateDir } from "./data-root";
import { FastCheckpoints } from "./fast-checkpoint-store";

export const SDK_AGENT_STORE_DIRNAME = "sdk-agent-store";

/** `<dataRoot>/sdk-agent-store`——正式包在 userData，dev 在 cwd/data */
export const cursorSdkStoreDir = (): string =>
  path.join(dataRoot(), SDK_AGENT_STORE_DIRNAME);

/** 回退开关：环境变量。`sdk` = 用 SDK 自带实现；`fast` = 强制用快实现（压过标记文件）。 */
export const SDK_STORE_ENV = "FLOWSHIP_SDK_STORE" as const;
/** 回退开关：store 目录下存在此文件名的文件 = 用 SDK 自带实现。 */
export const SDK_STORE_MARKER = "USE_SDK_STORE" as const;

export type SdkStoreMode = "fast" | "sdk";

/**
 * 纯函数：决定用哪套实现。环境变量显式值优先；其余（含拼写错误）看标记文件；都没有 = fast。
 */
export const resolveSdkStoreMode = (
  env: Record<string, string | undefined>,
  markerExists: boolean,
): SdkStoreMode => {
  const v = (env[SDK_STORE_ENV] ?? "").trim().toLowerCase();
  if (v === "sdk") return "sdk";
  if (v === "fast") return "fast";
  return markerExists ? "sdk" : "fast";
};

export interface SdkStoreHandle {
  /** 传给 SDK 的 `local.store` */
  readonly store: LocalAgentStore;
  /** fast = checkpoints 走 FastCheckpoints；sdk = SDK 自带实现（开关回退 / 预热失败回退） */
  readonly mode: SdkStoreMode;
  readonly dir: string;
  /** 仅 mode === "fast" 有值：GC 经它读「本进程写过的 agent」，checkpoints 的删除也走 `store.checkpoints` */
  readonly fast: FastCheckpoints | null;
}

type JsonlCtor = typeof CursorSdk.JsonlLocalAgentStore;
type ComposeFn = typeof CursorSdk.composeLocalAgentStore;
type PaginateFn = typeof CursorSdk.paginateCheckpointBlobIds;

interface SdkParts {
  Jsonl: JsonlCtor;
  compose: ComposeFn | undefined;
  paginate: PaginateFn | undefined;
}

/** vitest 的 vi.mock 工厂没导出某个 key 时，读取会直接抛错——这里一律当作「没有」。 */
const readExport = <T>(mod: object, key: string): T | undefined => {
  try {
    return (mod as Record<string, unknown>)[key] as T | undefined;
  } catch {
    return undefined;
  }
};

const loadSdk = async (): Promise<SdkParts | null> => {
  let mod: object;
  try {
    mod = (await import("@cursor/sdk")) as object;
  } catch {
    return null;
  }
  const Jsonl = readExport<JsonlCtor>(mod, "JsonlLocalAgentStore");
  // 单测 mock 了 @cursor/sdk 且没导出 JsonlLocalAgentStore → 保持默认、不挡测试
  if (typeof Jsonl !== "function") return null;
  const compose = readExport<ComposeFn>(mod, "composeLocalAgentStore");
  const paginate = readExport<PaginateFn>(mod, "paginateCheckpointBlobIds");
  return {
    Jsonl,
    compose: typeof compose === "function" ? compose : undefined,
    paginate: typeof paginate === "function" ? paginate : undefined,
  };
};

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

/**
 * 打开（并预热）store。不带缓存、不碰 globalThis——生产代码请用 `getSdkStoreHandle()`，
 * 这个导出给单测用（每个测试自己的临时目录）。
 *
 * 返回 null = 当前环境没有可用的 SDK JSONL store（单测 mock 场景），调用方保持 SDK 默认。
 */
export const openSdkStore = async (
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SdkStoreHandle | null> => {
  const sdk = await loadSdk();
  if (!sdk) return null;
  await ensurePrivateDir(dir);
  const base = new sdk.Jsonl(dir);

  const mode = resolveSdkStoreMode(
    env,
    await fileExists(path.join(dir, SDK_STORE_MARKER)),
  );
  if (mode === "sdk") {
    console.log(
      `[sdk-store] 使用 SDK 自带 JSONL store（开关回退：${SDK_STORE_ENV}=sdk 或 ${SDK_STORE_MARKER} 标记文件）`,
    );
    return { store: base, mode: "sdk", dir, fast: null };
  }
  if (!sdk.compose || !sdk.paginate) {
    console.warn(
      "[sdk-store] 当前 @cursor/sdk 缺少 composeLocalAgentStore / paginateCheckpointBlobIds，回退 SDK 自带实现",
    );
    return { store: base, mode: "sdk", dir, fast: null };
  }

  const fast = new FastCheckpoints(dir, sdk.paginate);
  const t0 = Date.now();
  try {
    const stats = await fast.warmUp();
    console.log(
      `[sdk-store] checkpoints 使用 fast 实现：${stats.blobs} 个 blob / ${mb(stats.bytes)}MB，预热 ${Date.now() - t0}ms` +
        `（回退：${SDK_STORE_ENV}=sdk 或在 ${dir} 下建空文件 ${SDK_STORE_MARKER}，重启生效）`,
    );
  } catch (err) {
    // 预热只读文件、没有任何写入，丢弃实例回退到 SDK 自带实现是安全的
    console.warn("[sdk-store] fast 预热失败，回退 SDK 自带实现：", err);
    return { store: base, mode: "sdk", dir, fast: null };
  }
  const store = sdk.compose({
    agents: base.agents,
    checkpoints: fast,
    runs: base.runs,
    runEvents: base.runEvents,
  });
  return { store, mode: "fast", dir, fast };
};

type G = typeof globalThis & {
  __flowshipSdkStoreHandle?: Promise<SdkStoreHandle | null>;
  __flowshipSdkStoreHandleDir?: string;
};

/**
 * 进程级单例句柄。缓存的是 **Promise 本身**（在任何 await 之前同步写入）：
 * 并发调用共享同一个实例——否则同一目录会 new 出多个 FastCheckpoints，违反单写者。
 * 打开失败（抛错）不缓存，下次调用重试。
 */
export const getSdkStoreHandle = (): Promise<SdkStoreHandle | null> => {
  const dir = cursorSdkStoreDir();
  const g = globalThis as G;
  if (g.__flowshipSdkStoreHandle && g.__flowshipSdkStoreHandleDir === dir) {
    return g.__flowshipSdkStoreHandle;
  }
  const p = openSdkStore(dir);
  g.__flowshipSdkStoreHandle = p;
  g.__flowshipSdkStoreHandleDir = dir;
  p.catch(() => {
    if (g.__flowshipSdkStoreHandle === p) {
      g.__flowshipSdkStoreHandle = undefined;
      g.__flowshipSdkStoreHandleDir = undefined;
    }
  });
  return p;
};

/** 仅测试：丢弃进程级单例。 */
export const __resetSdkStoreHandleForTests = (): void => {
  const g = globalThis as G;
  g.__flowshipSdkStoreHandle = undefined;
  g.__flowshipSdkStoreHandleDir = undefined;
};

type LocalStoreHolder = {
  local?: {
    store?: unknown;
  };
};

/**
 * 给 Agent.create / resume / prompt 补上 JSONL store。
 * 调用方已经传了 `local.store` 则不动（测试 / 显式覆盖）。
 */
export const withCursorJsonlStore = async <T extends LocalStoreHolder>(
  input: T,
): Promise<T> => {
  if (input.local?.store) return input;
  const handle = await getSdkStoreHandle();
  if (!handle) return input;
  return {
    ...input,
    local: { ...input.local, store: handle.store },
  } as T;
};
