/**
 * 桥接运行时落盘状态：p2p chatId、已处理 message_id 去重集合
 *
 * 与 card-map 分文件——S1 card-map 只负责卡片锚定 + lastProcessedTs 游标，
 * 入向补拉需要的 chatId / 去重集合放这里，避免改 S1 契约。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { writePrivateFileAtomic } from "@/lib/server/data-root";

import { getBridgeDataDir } from "./bridge-config";

/** 去重集合上限——防膨胀；超出淘汰最旧 */
const PROCESSED_IDS_MAX = 2000;

interface BridgeStateStore {
  /** 最近处理过的 p2p chat_id（补拉用） */
  lastP2pChatId: string;
  /** 近期已注入的 message_id（FIFO） */
  processedMessageIds: string[];
}

const emptyStore = (): BridgeStateStore => ({
  lastP2pChatId: "",
  processedMessageIds: [],
});

const stateFilePath = async (): Promise<string> =>
  path.join(await getBridgeDataDir(), "bridge-state.json");

const readStore = async (): Promise<BridgeStateStore> => {
  try {
    const raw = await fs.readFile(await stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BridgeStateStore>;
    return {
      lastP2pChatId:
        typeof parsed.lastP2pChatId === "string" ? parsed.lastP2pChatId : "",
      processedMessageIds: Array.isArray(parsed.processedMessageIds)
        ? parsed.processedMessageIds.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        "[feishu-bridge/bridge-state] 读盘失败、回空:",
        err instanceof Error ? err.message : err,
      );
    }
    return emptyStore();
  }
};

const writeStore = async (store: BridgeStateStore): Promise<void> => {
  await writePrivateFileAtomic(
    await stateFilePath(),
    JSON.stringify(store, null, 2),
  );
};

/** 记下 p2p chat_id（补拉需要） */
export const rememberP2pChatId = async (chatId: string): Promise<void> => {
  if (!chatId) return;
  const store = await readStore();
  if (store.lastP2pChatId === chatId) return;
  await writeStore({ ...store, lastP2pChatId: chatId });
};

export const getLastP2pChatId = async (): Promise<string> => {
  const store = await readStore();
  return store.lastP2pChatId;
};

/** 是否已处理过该 message_id */
export const hasProcessedMessageId = async (
  messageId: string,
): Promise<boolean> => {
  if (!messageId) return false;
  const store = await readStore();
  return store.processedMessageIds.includes(messageId);
};

/** 标记已处理；FIFO 淘汰 */
export const markProcessedMessageId = async (
  messageId: string,
): Promise<void> => {
  if (!messageId) return;
  const store = await readStore();
  const next = store.processedMessageIds.filter((id) => id !== messageId);
  next.push(messageId);
  while (next.length > PROCESSED_IDS_MAX) next.shift();
  await writeStore({ ...store, processedMessageIds: next });
};

/** 单测清状态文件 */
export const __resetBridgeStateForTest = async (): Promise<void> => {
  try {
    await fs.unlink(await stateFilePath());
  } catch {
    // ignore
  }
};
