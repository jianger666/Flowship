/**
 * 卡片消息 ↔ task 映射落盘
 *
 * 路径：`<dataRoot>/feishu-bridge/card-map.json`
 * 原子写（tmp + rename）；条目上限 500 FIFO，供飞书「回复」锚定。
 *
 * R1-2c：所有「读改写」经进程级串行队列，避免与游标写并发互相覆盖。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { writePrivateFileAtomic } from "@/lib/server/data-root";

import { getBridgeDataDir } from "./bridge-config";
import type { CardMapEntry, CardMapStore } from "./types";

/** 映射条数上限——防膨胀；超出淘汰最旧 */
export const CARD_MAP_MAX = 500;

/** 运行时上限（单测可压小，避免写 500 次） */
let cardMapMaxRuntime = CARD_MAP_MAX;

/** 单测改上限；传 null 恢复 */
export const __setCardMapMaxForTest = (n: number | null): void => {
  cardMapMaxRuntime = n == null ? CARD_MAP_MAX : n;
};

// ----------------- 写队列（挂 globalThis，对齐 enqueueLark） -----------------

const CARD_MAP_CHAIN_KEY = "__flowshipFeishuCardMapWriteChainV1__";

type WriteChainState = { current: Promise<void> };

const getCardMapWriteChain = (): WriteChainState => {
  const g = globalThis as unknown as Record<string, WriteChainState | undefined>;
  if (!g[CARD_MAP_CHAIN_KEY]) {
    g[CARD_MAP_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[CARD_MAP_CHAIN_KEY]!;
};

/** 整段 RMW 入队；读操作不排队 */
const enqueueCardMapWrite = <T>(run: () => Promise<T>): Promise<T> => {
  const state = getCardMapWriteChain();
  const result = state.current.then(run, run);
  state.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const mapFilePath = async (): Promise<string> =>
  path.join(await getBridgeDataDir(), "card-map.json");

const emptyStore = (): CardMapStore => ({
  entries: [],
  lastProcessedTs: "",
});

/** 读盘；缺文件 / 坏 JSON → 空 store（不抛） */
export const readCardMapStore = async (): Promise<CardMapStore> => {
  const file = await mapFilePath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CardMapStore>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      entries: entries.filter(
        (e): e is CardMapEntry =>
          !!e &&
          typeof e.messageId === "string" &&
          typeof e.cardId === "string" &&
          typeof e.taskId === "string" &&
          typeof e.createdAt === "number",
      ),
      lastProcessedTs:
        typeof parsed.lastProcessedTs === "string" ? parsed.lastProcessedTs : "",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        "[feishu-bridge/card-map] 读盘失败、回空:",
        err instanceof Error ? err.message : err,
      );
    }
    return emptyStore();
  }
};

/** 原子写整份 store（经写队列，与 RMW 互斥） */
export const writeCardMapStore = async (store: CardMapStore): Promise<void> =>
  enqueueCardMapWrite(async () => {
    const file = await mapFilePath();
    await writePrivateFileAtomic(file, JSON.stringify(store, null, 2));
  });

/**
 * 记录发出的卡片消息。同 messageId 覆盖；超出 CARD_MAP_MAX 从头部淘汰。
 */
export const rememberCardMessage = async (entry: CardMapEntry): Promise<void> =>
  enqueueCardMapWrite(async () => {
    const store = await readCardMapStore();
    const next = store.entries.filter((e) => e.messageId !== entry.messageId);
    next.push(entry);
    while (next.length > cardMapMaxRuntime) next.shift();
    const file = await mapFilePath();
    await writePrivateFileAtomic(
      file,
      JSON.stringify({ ...store, entries: next }, null, 2),
    );
  });

/** 按飞书 root_id / message_id 反查 taskId */
export const findTaskByMessageId = async (
  rootId: string,
): Promise<CardMapEntry | null> => {
  if (!rootId) return null;
  const store = await readCardMapStore();
  // 从新到旧找（同 id 理论上唯一、新的优先）
  for (let i = store.entries.length - 1; i >= 0; i--) {
    const e = store.entries[i]!;
    if (e.messageId === rootId) return e;
  }
  return null;
};

/** 断线补拉游标 */
export const getLastProcessedTs = async (): Promise<string> => {
  const store = await readCardMapStore();
  return store.lastProcessedTs;
};

export const setLastProcessedTs = async (ts: string): Promise<void> =>
  enqueueCardMapWrite(async () => {
    const store = await readCardMapStore();
    const file = await mapFilePath();
    await writePrivateFileAtomic(
      file,
      JSON.stringify({ ...store, lastProcessedTs: ts }, null, 2),
    );
  });
