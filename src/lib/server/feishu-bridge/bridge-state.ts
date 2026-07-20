/**
 * 桥接运行时落盘状态：p2p chatId、已处理 message_id 去重集合
 *
 * 与 card-map 分文件——S1 card-map 只负责卡片锚定 + lastProcessedTs 游标，
 * 入向补拉需要的 chatId / 去重集合放这里，避免改 S1 契约。
 *
 * R1-2c：所有「读改写」经进程级串行队列，避免并发 RMW 互相覆盖。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { writePrivateFileAtomic } from "@/lib/server/data-root";

import { getBridgeDataDir } from "./bridge-config";

/** 去重集合上限——防膨胀；超出淘汰最旧 */
const PROCESSED_IDS_MAX = 2000;

/** 「已结束」对话集合上限（FIFO 淘汰最旧——被淘汰的对话大概率早过了活跃窗、不会复现） */
const ENDED_CHAT_IDS_MAX = 200;

interface BridgeStateStore {
  /** 最近处理过的 p2p chat_id（补拉用） */
  lastP2pChatId: string;
  /** 近期已注入的 message_id（FIFO） */
  processedMessageIds: string[];
  /** 最近收到入向消息的时刻（收消息自检；0 = 从未）——跨重启保留 */
  lastInboundAt: number;
  /**
   * 当前对话指针：直发消息默认进这个 chat（不看活跃时间窗）。
   * 空串 = 无指针；失效时由路由侧清掉再走活跃数兜底。
   */
  currentChatTaskId: string;
  /**
   * 飞书侧「已结束」的对话（清理卡「结束」按钮点过的；app 数据不动）。
   * listActiveChatTasks 会过滤掉这些；回复其旧卡片（锚定命中）= 复活（移出集合）。
   */
  endedChatTaskIds: string[];
}

const emptyStore = (): BridgeStateStore => ({
  lastP2pChatId: "",
  processedMessageIds: [],
  lastInboundAt: 0,
  currentChatTaskId: "",
  endedChatTaskIds: [],
});

// ----------------- 写队列（挂 globalThis，对齐 enqueueLark） -----------------

const BRIDGE_STATE_CHAIN_KEY = "__flowshipFeishuBridgeStateWriteChainV1__";

type WriteChainState = { current: Promise<void> };

const getBridgeStateWriteChain = (): WriteChainState => {
  const g = globalThis as unknown as Record<string, WriteChainState | undefined>;
  if (!g[BRIDGE_STATE_CHAIN_KEY]) {
    g[BRIDGE_STATE_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[BRIDGE_STATE_CHAIN_KEY]!;
};

/** 整段 RMW 入队；读操作不排队 */
const enqueueBridgeStateWrite = <T>(run: () => Promise<T>): Promise<T> => {
  const state = getBridgeStateWriteChain();
  const result = state.current.then(run, run);
  state.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

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
      lastInboundAt:
        typeof parsed.lastInboundAt === "number" ? parsed.lastInboundAt : 0,
      currentChatTaskId:
        typeof parsed.currentChatTaskId === "string"
          ? parsed.currentChatTaskId
          : "",
      endedChatTaskIds: Array.isArray(parsed.endedChatTaskIds)
        ? parsed.endedChatTaskIds.filter(
            (x): x is string => typeof x === "string",
          )
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

/** 收消息打点节流：60s 内不重复写盘（时间精度对自检展示够用） */
const INBOUND_AT_WRITE_THROTTLE_MS = 60_000;

/** 记「最近收到入向消息」时刻（节流写盘、跨重启保留） */
export const rememberInboundReceivedAt = async (ts: number): Promise<void> => {
  return enqueueBridgeStateWrite(async () => {
    const store = await readStore();
    if (ts - store.lastInboundAt < INBOUND_AT_WRITE_THROTTLE_MS) return;
    store.lastInboundAt = ts;
    await writeStore(store);
  });
};

/** 读盘上的「最近收到入向消息」时刻（0 = 从未）——重启后自检回填用 */
export const getPersistedLastInboundAt = async (): Promise<number> => {
  return (await readStore()).lastInboundAt;
};

/** 记下 p2p chat_id（补拉需要） */
export const rememberP2pChatId = async (chatId: string): Promise<void> => {
  if (!chatId) return;
  return enqueueBridgeStateWrite(async () => {
    const store = await readStore();
    if (store.lastP2pChatId === chatId) return;
    await writeStore({ ...store, lastP2pChatId: chatId });
  });
};

export const getLastP2pChatId = async (): Promise<string> => {
  const store = await readStore();
  return store.lastP2pChatId;
};

/**
 * 记下「当前对话」指针（空串 = 清除）。
 * 走写队列 RMW；同值幂等跳过写盘。
 */
export const setCurrentChatTaskId = async (taskId: string): Promise<void> => {
  const next = typeof taskId === "string" ? taskId : "";
  return enqueueBridgeStateWrite(async () => {
    const store = await readStore();
    if (store.currentChatTaskId === next) return;
    await writeStore({ ...store, currentChatTaskId: next });
  });
};

/** 读当前对话指针（空串 = 无） */
export const getCurrentChatTaskId = async (): Promise<string> => {
  return (await readStore()).currentChatTaskId;
};

/** 标记对话为飞书侧「已结束」；去重 + FIFO 淘汰 */
export const addEndedChatTaskId = async (taskId: string): Promise<void> => {
  if (!taskId) return;
  return enqueueBridgeStateWrite(async () => {
    const store = await readStore();
    const next = store.endedChatTaskIds.filter((id) => id !== taskId);
    next.push(taskId);
    while (next.length > ENDED_CHAT_IDS_MAX) next.shift();
    await writeStore({ ...store, endedChatTaskIds: next });
  });
};

/**
 * 复活：把对话移出「已结束」集合（回复旧卡片锚定命中时调）。
 * 不在集合内则幂等跳过写盘。
 */
export const removeEndedChatTaskId = async (taskId: string): Promise<void> => {
  if (!taskId) return;
  return enqueueBridgeStateWrite(async () => {
    const store = await readStore();
    if (!store.endedChatTaskIds.includes(taskId)) return;
    await writeStore({
      ...store,
      endedChatTaskIds: store.endedChatTaskIds.filter((id) => id !== taskId),
    });
  });
};

/** 读「已结束」对话集合 */
export const getEndedChatTaskIds = async (): Promise<string[]> => {
  return (await readStore()).endedChatTaskIds;
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
  return enqueueBridgeStateWrite(async () => {
    const store = await readStore();
    const next = store.processedMessageIds.filter((id) => id !== messageId);
    next.push(messageId);
    while (next.length > PROCESSED_IDS_MAX) next.shift();
    await writeStore({ ...store, processedMessageIds: next });
  });
};

/** 单测清状态文件 */
export const __resetBridgeStateForTest = async (): Promise<void> => {
  try {
    await fs.unlink(await stateFilePath());
  } catch {
    // ignore
  }
};
