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
import { readJsonObjectForWrite } from "./json-store";

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
  /**
   * 对话遥控器「搜对话」待关键词：为 true 时下一条纯文本按搜索处理（命令不受影响）。
   * 读到即清（一次性），空消息也清——免得把后面的正常聊天误吞成搜索。
   */
  awaitingChatSearch: boolean;
}

const emptyStore = (): BridgeStateStore => ({
  lastP2pChatId: "",
  processedMessageIds: [],
  lastInboundAt: 0,
  currentChatTaskId: "",
  endedChatTaskIds: [],
  awaitingChatSearch: false,
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

/** 把盘上解析出的对象规整成 store（缺字段 / 类型不对的字段按空补） */
const normalizeStore = (parsed: Partial<BridgeStateStore>): BridgeStateStore => {
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
    awaitingChatSearch: parsed.awaitingChatSearch === true,
  };
};

/**
 * 纯读取用（getter / 热路径）：读失败宽松回空、不抛——只读路径别因此中断消息处理。
 * 读改写**不要**用它（读失败回空再写回 = 抹掉全部历史），用 {@link readStoreForWrite}。
 */
const readStore = async (): Promise<BridgeStateStore> => {
  try {
    const raw = await fs.readFile(await stateFilePath(), "utf-8");
    return normalizeStore(JSON.parse(raw) as Partial<BridgeStateStore>);
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

/**
 * 读改写用的读：只有「文件不存在」或「内容坏了（已隔离）」才从空开始；
 * 其它读错误抛出（调用方的整段 RMW 随之放弃，不会拿空状态覆盖盘上的历史）。见 json-store。
 */
const readStoreForWrite = async (): Promise<BridgeStateStore> => {
  const parsed = await readJsonObjectForWrite(
    await stateFilePath(),
    "bridge-state",
    // 字段类型不对（如 processedMessageIds 被改成字符串）：不悄悄当空，复制留证（缺字段不算）
    (o) =>
      (o.lastP2pChatId === undefined || typeof o.lastP2pChatId === "string") &&
      (o.processedMessageIds === undefined || Array.isArray(o.processedMessageIds)) &&
      (o.lastInboundAt === undefined || typeof o.lastInboundAt === "number") &&
      (o.currentChatTaskId === undefined || typeof o.currentChatTaskId === "string") &&
      (o.endedChatTaskIds === undefined || Array.isArray(o.endedChatTaskIds)) &&
      (o.awaitingChatSearch === undefined || typeof o.awaitingChatSearch === "boolean"),
  );
  return parsed === null ? emptyStore() : normalizeStore(parsed as Partial<BridgeStateStore>);
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
    const store = await readStoreForWrite();
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
    const store = await readStoreForWrite();
    if (store.lastP2pChatId === chatId) return;
    await writeStore({ ...store, lastP2pChatId: chatId });
  });
};

export const getLastP2pChatId = async (): Promise<string> => {
  const store = await readStore();
  return store.lastP2pChatId;
};

/**
 * 区分「确实没有记录」与「状态文件读不出来」（getLastP2pChatId 两种情况都回空串、日志只能谎报）。
 * unreadable=true：文件存在但读失败 / 内容损坏——此时回空串不代表没有 chatId。
 * 只读、永不抛。
 */
export const peekLastP2pChatIdState = async (): Promise<{
  chatId: string;
  unreadable: boolean;
}> => {
  try {
    const raw = await fs.readFile(await stateFilePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { chatId: "", unreadable: true };
    }
    return {
      chatId: normalizeStore(parsed as Partial<BridgeStateStore>).lastP2pChatId,
      unreadable: false,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { chatId: "", unreadable: code !== "ENOENT" };
  }
};

/**
 * 记下「当前对话」指针（空串 = 清除）。
 * 走写队列 RMW；同值幂等跳过写盘。
 */
export const setCurrentChatTaskId = async (taskId: string): Promise<void> => {
  const next = typeof taskId === "string" ? taskId : "";
  return enqueueBridgeStateWrite(async () => {
    const store = await readStoreForWrite();
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
    const store = await readStoreForWrite();
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
    const store = await readStoreForWrite();
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

/**
 * 对话遥控器「搜对话」：下一条纯文本是否按关键词搜。
 * 取值即清零（读完不管用不用都关），调用方只关心“刚才是不是 true”。
 */
export const takeAwaitingChatSearch = async (): Promise<boolean> => {
  let was = false;
  await enqueueBridgeStateWrite(async () => {
    const store = await readStoreForWrite();
    was = store.awaitingChatSearch === true;
    if (was) await writeStore({ ...store, awaitingChatSearch: false });
  });
  return was;
};

/** 置「搜对话」待关键词（遥控器 search_hint 点后调） */
export const setAwaitingChatSearch = async (): Promise<void> => {
  return enqueueBridgeStateWrite(async () => {
    const store = await readStoreForWrite();
    if (store.awaitingChatSearch) return;
    await writeStore({ ...store, awaitingChatSearch: true });
  });
};

/**
 * 热路径 fast-path：无锁读一眼 flag（不进写队列、不读两次盘）。
 * false 占 99.9%——router 先拿它过滤，只有 true 才走 take（串行确认+清零）。
 * 两次读之间理论上有 TOCTOU（peek 后被别人 take），后果只是多一次无害的 take（返 false），
 * correctness 靠 take 里的队列串行保证，这里只管省 I/O。
 */
export const peekAwaitingChatSearch = async (): Promise<boolean> => {
  try {
    return (await readStore()).awaitingChatSearch === true;
  } catch {
    return false;
  }
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
    const store = await readStoreForWrite();
    const next = store.processedMessageIds.filter((id) => id !== messageId);
    next.push(messageId);
    while (next.length > PROCESSED_IDS_MAX) next.shift();
    await writeStore({ ...store, processedMessageIds: next });
  });
};

/**
 * 单测清状态：先排空写队列再删文件，避免火忘 RMW（如 rememberInboundReceivedAt）
 * 在 unlink 之后落盘、污染下一用例的去重集合。
 */
export const __resetBridgeStateForTest = async (): Promise<void> => {
  const chain = getBridgeStateWriteChain();
  await chain.current.catch(() => undefined);
  chain.current = Promise.resolve();
  try {
    await fs.unlink(await stateFilePath());
  } catch {
    // ignore
  }
};
