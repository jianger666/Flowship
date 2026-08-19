/**
 * Cursor SDK 本地 agent 的落盘位置。
 *
 * 默认 SQLite 写在用户级 `~/.cursor/...`（WAL：`store.db-wal` / `store.db-shm`）。
 * Windows 上杀毒实时扫描 / OneDrive 重定向家目录时，长 run 收尾重开 WAL 会报
 * `[internal] unable to open database file`（官方 2026-07-28 已确认）。
 *
 * Flowship 会话跨进程恢复走 events.jsonl，不依赖这份 SDK store；所以改挂
 * dataRoot 下的 JSONL（官方规避、避开 SQLite WAL）。
 *
 * 单例挂 globalThis：dev HMR / 多 route chunk 不能各 new 一份，resume 要对上同一目录。
 */
import path from "node:path";

import { dataRoot, ensurePrivateDir } from "./data-root";

export const SDK_AGENT_STORE_DIRNAME = "sdk-agent-store";

/** `<dataRoot>/sdk-agent-store`——正式包在 userData，dev 在 cwd/data */
export const cursorSdkStoreDir = (): string =>
  path.join(dataRoot(), SDK_AGENT_STORE_DIRNAME);

type JsonlStoreCtor = new (rootDir: string) => { readonly agents: unknown };

type G = typeof globalThis & {
  __flowshipCursorJsonlStore?: object;
  __flowshipCursorJsonlStoreDir?: string;
};

type LocalStoreHolder = {
  local?: {
    store?: unknown;
  };
};

const loadJsonlCtor = async (): Promise<JsonlStoreCtor | null> => {
  try {
    const mod = (await import("@cursor/sdk")) as {
      JsonlLocalAgentStore?: JsonlStoreCtor;
    };
    return typeof mod.JsonlLocalAgentStore === "function"
      ? mod.JsonlLocalAgentStore
      : null;
  } catch {
    // 单测 mock 了 @cursor/sdk 且没导出 JsonlLocalAgentStore → 保持默认、不挡测试
    return null;
  }
};

const getOrCreateStore = async (): Promise<object | null> => {
  const Ctor = await loadJsonlCtor();
  if (!Ctor) return null;
  const dir = cursorSdkStoreDir();
  const g = globalThis as G;
  if (g.__flowshipCursorJsonlStore && g.__flowshipCursorJsonlStoreDir === dir) {
    return g.__flowshipCursorJsonlStore;
  }
  await ensurePrivateDir(dir);
  const store = new Ctor(dir);
  g.__flowshipCursorJsonlStore = store;
  g.__flowshipCursorJsonlStoreDir = dir;
  return store;
};

/**
 * 给 Agent.create / resume / prompt 补上 JSONL store。
 * 调用方已经传了 `local.store` 则不动（测试 / 显式覆盖）。
 */
export const withCursorJsonlStore = async <T extends LocalStoreHolder>(
  input: T,
): Promise<T> => {
  if (input.local?.store) return input;
  const store = await getOrCreateStore();
  if (!store) return input;
  return {
    ...input,
    local: { ...input.local, store },
  } as T;
};
