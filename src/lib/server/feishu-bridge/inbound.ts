/**
 * 飞书入向常驻 consumer（4.3 + 4.4c）
 *
 * - 按 eventKey 声明式列表 spawn `lark-cli event consume … --as bot`
 * - stderr 见 `[event] ready event_key=` 才算就绪
 * - stdin pipe 保持打开；停时 stdin.end() → 5s → SIGTERM（绝不 kill -9）
 * - 崩溃指数退避；单实例守卫（event status 查同 key 异进程）
 * - keep-awake + 断线补拉
 *
 * consumer 按 CONSUMER_SPECS 声明式管理，新增事件只需加一项。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";

import {
  registerManagedChild,
  unregisterManagedChild,
  stopAllManagedChildren,
} from "@/lib/server/kill-orphans";

import {
  isFeishuBridgeKeepAwakeEnabled,
  isFeishuChatBridgeEnabled,
} from "./bridge-config";
import {
  getLastP2pChatId,
  getPersistedLastInboundAt,
  hasProcessedMessageId,
  markProcessedMessageId,
  rememberInboundReceivedAt,
  rememberP2pChatId,
} from "./bridge-state";
import {
  getLastProcessedTs,
  setLastProcessedTs,
} from "./card-map";
import { KeepAwake } from "./keep-awake";
import {
  getBotAppInfo,
  larkApi,
  resolveLarkCliBin,
  runLark,
  sendTextMessage,
} from "./lark-api";
import {
  bridgeHostname,
  dispatchCardActionEvent,
  routeInboundMessage,
  SKIP_NOT_OWNER,
  SKIP_NOT_P2P,
} from "./router";
import type { FeishuInboundMessage } from "./types";

// ----------------- 声明式 consumer 列表 -----------------

export type ConsumerEventKey = "im.message.receive_v1" | "card.action.trigger";

type ConsumerSpec = {
  eventKey: ConsumerEventKey;
  /** 收到一条 NDJSON 后的处理 */
  onEvent: (raw: unknown) => Promise<void>;
  /**
   * 可选能力：CLI 不支持 / 未订阅时整体状态不受它拖累（overall 计算时忽略），
   * 功能优雅降级。
   */
  optional?: boolean;
};

/** 归一化 im.message.receive_v1 NDJSON → FeishuInboundMessage */
export const normalizeInboundEvent = (
  raw: unknown,
): FeishuInboundMessage | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // 兼容：顶层扁平（样本） / 嵌套 event.message
  const nested =
    o.event && typeof o.event === "object"
      ? (o.event as Record<string, unknown>)
      : null;
  const msgObj =
    nested && nested.message && typeof nested.message === "object"
      ? (nested.message as Record<string, unknown>)
      : o;

  const messageId =
    (typeof msgObj.message_id === "string" && msgObj.message_id) ||
    (typeof o.message_id === "string" && o.message_id) ||
    (typeof o.id === "string" && o.id) ||
    "";
  if (!messageId) return null;

  const sender =
    msgObj.sender && typeof msgObj.sender === "object"
      ? (msgObj.sender as Record<string, unknown>)
      : null;
  let senderId = "";
  if (typeof o.sender_id === "string") senderId = o.sender_id;
  else if (sender && typeof sender.id === "string") senderId = sender.id;
  else if (sender && sender.sender_id && typeof sender.sender_id === "object") {
    const sid = sender.sender_id as { open_id?: unknown };
    if (typeof sid.open_id === "string") senderId = sid.open_id;
  }

  let content = "";
  if (typeof o.content === "string") content = o.content;
  else if (typeof msgObj.content === "string") content = msgObj.content;
  else if (
    msgObj.body &&
    typeof msgObj.body === "object" &&
    typeof (msgObj.body as { content?: string }).content === "string"
  ) {
    content = (msgObj.body as { content: string }).content;
  }

  return {
    type:
      (typeof o.type === "string" && o.type) ||
      (typeof o.event_type === "string" && o.event_type) ||
      "im.message.receive_v1",
    event_id: typeof o.event_id === "string" ? o.event_id : undefined,
    id: typeof o.id === "string" ? o.id : messageId,
    message_id: messageId,
    create_time:
      (typeof msgObj.create_time === "string" && msgObj.create_time) ||
      (typeof o.create_time === "string" && o.create_time) ||
      "",
    chat_id:
      (typeof msgObj.chat_id === "string" && msgObj.chat_id) ||
      (typeof o.chat_id === "string" && o.chat_id) ||
      "",
    chat_type:
      (typeof msgObj.chat_type === "string" && msgObj.chat_type) ||
      (typeof o.chat_type === "string" && o.chat_type) ||
      "",
    message_type:
      (typeof msgObj.message_type === "string" && msgObj.message_type) ||
      (typeof msgObj.msg_type === "string" && msgObj.msg_type) ||
      (typeof o.message_type === "string" && o.message_type) ||
      "",
    sender_id: senderId,
    content,
    root_id:
      (typeof msgObj.root_id === "string" && msgObj.root_id) ||
      (typeof o.root_id === "string" && o.root_id) ||
      undefined,
    parent_id:
      (typeof msgObj.parent_id === "string" && msgObj.parent_id) ||
      (typeof o.parent_id === "string" && o.parent_id) ||
      undefined,
    timestamp: typeof o.timestamp === "string" ? o.timestamp : undefined,
  };
};

// ----------------- 入向单链（R1-2：消顺序反转 + 去重 TOCTOU） -----------------

const INBOUND_CHAIN_KEY = "__flowshipFeishuInboundChainV1__";

type InboundChainState = { current: Promise<void> };

const getInboundChain = (): InboundChainState => {
  const g = globalThis as unknown as Record<string, InboundChainState | undefined>;
  if (!g[INBOUND_CHAIN_KEY]) {
    g[INBOUND_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[INBOUND_CHAIN_KEY]!;
};

/**
 * 进程级串行：live consumer 与 catchup 共用。
 * check → route → mark 在链内原子，消灭双注入与顺序反转。
 */
export const enqueueInboundMessage = <T>(run: () => Promise<T>): Promise<T> => {
  const state = getInboundChain();
  const result = state.current.then(run, run);
  state.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

/**
 * card.action 串行链（R3-3）：独立于消息链——按钮回调不被入向消息的
 * 大文件下载头阻塞；但自身串行，消灭「双击答题卡两个选项」的并发竞态：
 * 第二次点击排在 clearPendingAsk 之后处理，自然走 card-action 已有的
 * 「askId 不匹配 → 已失效」优雅分支。
 */
const CARD_ACTION_CHAIN_KEY = "__flowshipFeishuCardActionChainV1__";

const getCardActionChain = (): InboundChainState => {
  const g = globalThis as unknown as Record<string, InboundChainState | undefined>;
  if (!g[CARD_ACTION_CHAIN_KEY]) {
    g[CARD_ACTION_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[CARD_ACTION_CHAIN_KEY]!;
};

export const enqueueCardAction = <T>(run: () => Promise<T>): Promise<T> => {
  const state = getCardActionChain();
  const result = state.current.then(run, run);
  state.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

/**
 * 单测排空并重置入向链——用例超时 / 未 await 的 handler 会占住 globalThis 链，
 * 下一用例的 inject mock 会被迟到的旧 handler 误点（R1-2a→R1-2b 串味根因）。
 * 排空带上限：跨文件残留若卡在真实网络，不能让 beforeEach 永久挂死。
 */
export const __resetInboundChainForTest = async (): Promise<void> => {
  const drainWithCap = async (state: InboundChainState): Promise<void> => {
    await Promise.race([
      state.current.catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    state.current = Promise.resolve();
  };
  await drainWithCap(getInboundChain());
  await drainWithCap(getCardActionChain());
};

/**
 * 入向消息默认处理：去重 → 路由 →（非 retryable）标记已处理 + 推进游标。
 * live stdout 与 catchUpMissedMessages 都走这里（同链）。
 */
export const defaultMessageHandler = async (raw: unknown): Promise<void> =>
  enqueueInboundMessage(async () => {
    const msg = normalizeInboundEvent(raw);
    if (!msg) return;
    // 收消息自检打点：只要链路收到过任何入向消息就记（早于去重/过滤，
    // 语义是「订阅通了」而不是「消息被处理了」）
    markBridgeInboundReceived();
    if (await hasProcessedMessageId(msg.message_id)) return;
    const result = await routeInboundMessage(msg);
    // R1-6：基础设施类 retryable 失败不 mark、不推进游标——等补拉重投
    if (result.kind === "failed" && result.retryable) {
      return;
    }
    await markProcessedMessageId(msg.message_id);
    // 仅「本人 p2p」消息推进补拉状态——群聊 / 他人私聊不得污染 chatId 与游标
    //（否则补拉窗口会指向错误会话、漏掉 owner 的离线消息）
    const identityOk =
      result.error !== SKIP_NOT_P2P && result.error !== SKIP_NOT_OWNER;
    if (msg.chat_type === "p2p" && identityOk) {
      await rememberP2pChatId(msg.chat_id);
      if (msg.create_time) {
        await setLastProcessedTs(msg.create_time);
      }
    }
  });

const defaultCardActionHandler = async (raw: unknown): Promise<void> =>
  enqueueCardAction(async () => {
    await dispatchCardActionEvent(raw);
  });

/** 声明式列表：消息 + 卡片按钮 + 撤回出队（决策 #20） */
export const CONSUMER_SPECS: ConsumerSpec[] = [
  {
    eventKey: "im.message.receive_v1",
    onEvent: defaultMessageHandler,
  },
  {
    eventKey: "card.action.trigger",
    onEvent: defaultCardActionHandler,
  },
  // 撤回同步（im.message.recalled_v1）已下线（2026-07-19 用户拍板）：
  // lark-cli 尚未收录该 EventKey、支持情况不确定——等 CLI 官方支持后再恢复
];

// ----------------- 状态类型 -----------------

export type ConsumerRuntimeState = {
  eventKey: ConsumerEventKey;
  /** unsupported：CLI 不认该 EventKey / 后台未订阅回调（exit 2），不做快速重试 */
  status:
    | "stopped"
    | "starting"
    | "ready"
    | "backoff"
    | "conflict"
    | "error"
    | "unsupported";
  pid?: number;
  lastError?: string;
  restartCount: number;
  conflictDetail?: string;
  /** unsupported 时若 CLI 给了「扫码订阅回调」链接，透出给设置页 */
  subscribeUrl?: string;
};

export type BridgeRuntimeStatus = {
  overall: "running" | "conflict" | "stopped" | "error" | "partial";
  enabled: boolean;
  keepAwake: boolean;
  hostname: string;
  consumers: ConsumerRuntimeState[];
  lastError?: string;
  /** 最近收到飞书消息的时刻（undefined = 本次启动后从未收到）——收消息自检 */
  lastInboundAt?: number;
  /** 历史上收到过（时间未知、老版本收的）——自检按通过展示 */
  everInbound?: boolean;
};

/** 入向链路收到任意消息时打点——设置页「收消息自检」数据源（内存 + 节流落盘） */
export const markBridgeInboundReceived = (): void => {
  const ts = Date.now();
  getRuntime().lastInboundAt = ts;
  // 落盘失败不影响消息处理（自检只是展示信号）
  void rememberInboundReceivedAt(ts).catch(() => undefined);
};

/** 重启后从盘上回填「最近收到」时刻（只在内存值为空时补、幂等） */
export const hydrateBridgeInboundAt = async (): Promise<void> => {
  const rt = getRuntime();
  if (rt.lastInboundAt || rt.everInbound) return;
  try {
    const persisted = await getPersistedLastInboundAt();
    if (persisted && !rt.lastInboundAt) {
      rt.lastInboundAt = persisted;
      return;
    }
    // 时间戳没落过盘（老版本收的消息）——lastP2pChatId 只会被入向 p2p 消息写入，
    // 有值即证明「历史上收到过」，自检不该判红（2026-07-20 用户反馈冷启动误红）
    if (!rt.lastInboundAt && (await getLastP2pChatId())) {
      rt.everInbound = true;
    }
  } catch {
    // 读盘失败当从未收到
  }
};

// ----------------- spawn 可注入 -----------------

type SpawnFn = typeof spawn;
let spawnImpl: SpawnFn = spawn;

export const __setInboundSpawnForTest = (fn: SpawnFn | null): void => {
  spawnImpl = fn ?? spawn;
};

// ----------------- 单 consumer -----------------

const READY_RE = /\[event\]\s+ready\s+event_key=(\S+)/;
const BACKOFF_CAP_MS = 60_000;
const HEALTHY_RESET_MS = 5 * 60_000;
const STOP_GRACE_MS = 5_000;
const CATCHUP_MAX_MS = 30 * 60_000;

type ConsumerHandle = {
  spec: ConsumerSpec;
  state: ConsumerRuntimeState;
  child: ChildProcess | null;
  stopping: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  startedAt: number;
  /** 最近 stderr 尾巴（exit 后判 unsupported 用） */
  stderrTail: string[];
  /** 本进程自己的 consumer pid，冲突检查时排除 */
  ourPid: number | null;
};

const makeConsumerState = (eventKey: ConsumerEventKey): ConsumerRuntimeState => ({
  eventKey,
  status: "stopped",
  restartCount: 0,
});

/**
 * 查 event status：同 event_key 是否已被**别的**进程占用。
 * 实测结构：apps[].consumers[].{ pid, event_key, … }
 */
export const checkEventKeyConflict = async (
  eventKey: string,
  ourPid: number | null,
): Promise<{ conflict: boolean; detail?: string }> => {
  try {
    const rec = await runLark(["event", "status", "--current"], { as: "none" });
    // runLark 会 unwrap；status 可能直接是 { apps } 或包在 data
    const root =
      rec.apps !== undefined
        ? rec
        : (rec.data as Record<string, unknown> | undefined) ?? rec;
    const apps = Array.isArray((root as { apps?: unknown }).apps)
      ? ((root as { apps: unknown[] }).apps)
      : [];
    for (const app of apps) {
      if (!app || typeof app !== "object") continue;
      const consumers = (app as { consumers?: unknown }).consumers;
      if (!Array.isArray(consumers)) continue;
      for (const c of consumers) {
        if (!c || typeof c !== "object") continue;
        const ck = (c as { event_key?: string }).event_key;
        const pid = (c as { pid?: number }).pid;
        if (ck !== eventKey) continue;
        if (typeof pid === "number" && ourPid !== null && pid === ourPid) {
          continue; // 自己
        }
        if (typeof pid === "number" && pid > 0) {
          const host = bridgeHostname();
          return {
            conflict: true,
            detail: `event_key=${eventKey} 已被 pid=${pid} 占用（本机 ${host}；跨实例/跨机器请只开一处桥接）`,
          };
        }
      }
    }
    return { conflict: false };
  } catch (err) {
    // status 失败不阻断启动（避免 CLI 抖动把桥接永久卡死），只 warn
    console.warn(
      "[feishu-bridge/inbound] event status 探测失败（继续启动）:",
      err instanceof Error ? err.message : err,
    );
    return { conflict: false };
  }
};

const stopChildGracefully = async (child: ChildProcess): Promise<void> => {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  const exited = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.once("exit", () => finish(true));
    setTimeout(() => finish(false), STOP_GRACE_MS).unref?.();
  });
  if (!exited && child.exitCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // 再等一会；仍不 kill -9（漏退订）
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => resolve(), STOP_GRACE_MS).unref?.();
    });
  }
};

// ----------------- 断线补拉 -----------------

/** review P1#3：补拉每页条数 / 总量上限（防爆） */
const CATCHUP_PAGE_SIZE = 50;
const CATCHUP_TOTAL_CAP = 200;

/**
 * 补拉：GET /open-apis/im/v1/messages
 * 参数实测（2026-07-18）：
 *   container_id_type=chat
 *   container_id=<chat_id>
 *   start_time / end_time = **Unix 秒**（字符串）
 *   page_size、sort_type=ByCreateTimeAsc
 * create_time 在返回里是毫秒字符串。
 *
 * review P1#3：跟随 has_more / page_token 翻页；只注入本人 user 消息。
 */
export const catchUpMissedMessages = async (
  onMessage: (msg: FeishuInboundMessage) => Promise<void> = defaultMessageHandler,
): Promise<void> => {
  const lastTs = await getLastProcessedTs();
  if (!lastTs) return;

  const lastMs = Number(lastTs);
  if (!Number.isFinite(lastMs) || lastMs <= 0) return;

  const now = Date.now();
  const gap = now - lastMs;
  const chatId = await getLastP2pChatId();
  if (!chatId) {
    console.warn("[feishu-bridge/inbound] 补拉跳过：尚无 p2p chatId");
    return;
  }

  if (gap > CATCHUP_MAX_MS) {
    // >30 分钟：只提示、不灌历史
    try {
      const info = await getBotAppInfo();
      await sendTextMessage(
        info.ownerOpenId,
        `桥接刚恢复，离线超过 30 分钟的消息未自动注入。需要的话请重新发送。`,
      );
    } catch (err) {
      console.warn(
        "[feishu-bridge/inbound] 超窗提示发送失败:",
        err instanceof Error ? err.message : err,
      );
    }
    // 推进游标到现在，避免每次 ready 都提示
    await setLastProcessedTs(String(now));
    return;
  }

  let ownerOpenId: string;
  try {
    ownerOpenId = (await getBotAppInfo()).ownerOpenId;
  } catch (err) {
    console.warn(
      "[feishu-bridge/inbound] 补拉跳过：无法获取本人 open_id:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const startSec = String(Math.floor(lastMs / 1000));
  const endSec = String(Math.floor(now / 1000));
  let pageToken: string | undefined;
  let injected = 0;
  try {
    // review P1#3：翻页直到 !has_more 或总量 cap
    for (;;) {
      const params: Record<string, unknown> = {
        container_id_type: "chat",
        container_id: chatId,
        start_time: startSec,
        end_time: endSec,
        page_size: CATCHUP_PAGE_SIZE,
        sort_type: "ByCreateTimeAsc",
      };
      if (pageToken) params.page_token = pageToken;

      const rec = await larkApi("GET", "/open-apis/im/v1/messages", { params });
      const data = (rec.data as Record<string, unknown> | undefined) ?? rec;
      const items = Array.isArray(data.items) ? data.items : [];

      for (const item of items) {
        if (injected >= CATCHUP_TOTAL_CAP) break;
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        const messageId =
          typeof it.message_id === "string" ? it.message_id : "";
        if (!messageId || (await hasProcessedMessageId(messageId))) continue;

        const sender = it.sender as Record<string, unknown> | undefined;
        // 只注入本人用户消息：sender_type=user（缺省当 user）+ id 匹配 owner
        const senderType =
          typeof sender?.sender_type === "string" ? sender.sender_type : "user";
        const senderId = typeof sender?.id === "string" ? sender.id : "";
        if (senderType !== "user" || senderId !== ownerOpenId) continue;

        const body = it.body as { content?: string } | undefined;
        const msg: FeishuInboundMessage = {
          type: "im.message.receive_v1",
          message_id: messageId,
          create_time:
            typeof it.create_time === "string" ? it.create_time : "",
          chat_id: typeof it.chat_id === "string" ? it.chat_id : chatId,
          chat_type: "p2p",
          message_type:
            (typeof it.msg_type === "string" && it.msg_type) ||
            (typeof it.message_type === "string" && it.message_type) ||
            "text",
          sender_id: senderId,
          content: typeof body?.content === "string" ? body.content : "",
          root_id: typeof it.root_id === "string" ? it.root_id : undefined,
          parent_id:
            typeof it.parent_id === "string" ? it.parent_id : undefined,
        };
        await onMessage(msg);
        injected += 1;
      }

      if (injected >= CATCHUP_TOTAL_CAP) {
        console.warn(
          `[feishu-bridge/inbound] 补拉已达总量上限 ${CATCHUP_TOTAL_CAP}，停止翻页`,
        );
        break;
      }
      const hasMore = data.has_more === true;
      const nextToken =
        typeof data.page_token === "string" ? data.page_token : "";
      if (!hasMore || !nextToken) break;
      pageToken = nextToken;
    }
  } catch (err) {
    console.warn(
      "[feishu-bridge/inbound] 断线补拉失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

// ----------------- Runtime 单例 -----------------

type RuntimeSingleton = {
  consumers: Map<ConsumerEventKey, ConsumerHandle>;
  keepAwake: KeepAwake;
  pollTimer: ReturnType<typeof setInterval> | null;
  syncing: boolean;
  lastOverallError?: string;
  exitHooked: boolean;
  /** 最近一次收到飞书入向消息的时刻——设置页「收消息自检」用（0 = 本次启动后从未） */
  lastInboundAt?: number;
  /** 历史上收到过消息但时间未知（老版本收的、时间戳没落盘）——自检不判红 */
  everInbound?: boolean;
};

const RUNTIME_KEY = "__flowshipFeishuBridgeRuntimeV1__";

const getRuntime = (): RuntimeSingleton => {
  const g = globalThis as unknown as Record<
    string,
    RuntimeSingleton | undefined
  >;
  if (!g[RUNTIME_KEY]) {
    g[RUNTIME_KEY] = {
      consumers: new Map(),
      keepAwake: new KeepAwake(),
      pollTimer: null,
      syncing: false,
      exitHooked: false,
    };
  }
  return g[RUNTIME_KEY]!;
};

const ensureHandle = (spec: ConsumerSpec): ConsumerHandle => {
  const rt = getRuntime();
  let h = rt.consumers.get(spec.eventKey);
  if (!h) {
    h = {
      spec,
      state: makeConsumerState(spec.eventKey),
      child: null,
      stopping: false,
      restartTimer: null,
      backoffMs: 1000,
      startedAt: 0,
      ourPid: null,
      stderrTail: [],
    };
    rt.consumers.set(spec.eventKey, h);
  }
  return h;
};

const scheduleRestart = (h: ConsumerHandle): void => {
  if (h.stopping) return;
  if (h.restartTimer) clearTimeout(h.restartTimer);
  h.state.status = "backoff";
  const delay = h.backoffMs;
  h.restartTimer = setTimeout(() => {
    h.restartTimer = null;
    void startConsumer(h);
  }, delay);
  h.restartTimer.unref?.();
  h.backoffMs = Math.min(h.backoffMs * 2, BACKOFF_CAP_MS);
};

const wireChild = (h: ConsumerHandle, child: ChildProcess): void => {
  h.child = child;
  h.ourPid = child.pid ?? null;
  h.state.pid = child.pid;
  h.state.status = "starting";
  h.startedAt = Date.now();

  const managedId = `feishu-bridge:${h.spec.eventKey}`;
  registerManagedChild(managedId, {
    label: `lark-cli event consume ${h.spec.eventKey}`,
    stop: async () => {
      h.stopping = true;
      if (h.child) await stopChildGracefully(h.child);
    },
  });

  // stderr：ready 标记 + 尾巴缓存（exit 后判 unsupported 用）
  h.stderrTail = [];
  if (child.stderr) {
    const rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      h.stderrTail.push(line);
      if (h.stderrTail.length > 20) h.stderrTail.shift();
      const m = line.match(READY_RE);
      if (m && m[1] === h.spec.eventKey) {
        h.state.status = "ready";
        h.state.lastError = undefined;
        // 成功跑满 5 分钟才重置退避——ready 时先记下，exit 时按存活时长判
        console.log(
          `[feishu-bridge/inbound] consumer ready event_key=${h.spec.eventKey} pid=${child.pid}`,
        );
        // 补拉只在消息 consumer ready 后做
        if (h.spec.eventKey === "im.message.receive_v1") {
          void catchUpMissedMessages();
        }
      }
    });
  }

  // stdout：NDJSON（CLI 的 ok:false 错误 envelope 也可能走 stdout——缓存进尾巴判 unsupported）
  if (child.stdout) {
    const rlOut = createInterface({ input: child.stdout });
    rlOut.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        console.warn(
          `[feishu-bridge/inbound] NDJSON 解析失败 event_key=${h.spec.eventKey}:`,
          t.slice(0, 200),
        );
        return;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { ok?: unknown }).ok === false
      ) {
        h.stderrTail.push(t);
        if (h.stderrTail.length > 20) h.stderrTail.shift();
        return;
      }
      // 两个 consumer 的 onEvent 内部各自挂串行链（消息链 / card.action 链，R3-3）；
      // 这里 void 只是不阻塞 readline 行读取，处理顺序由链保证
      void h.spec.onEvent(parsed).catch((err) => {
        console.error(
          `[feishu-bridge/inbound] onEvent 失败 event_key=${h.spec.eventKey}:`,
          err,
        );
      });
    });
  }

  child.on("error", (err) => {
    h.state.lastError = err.message;
    h.state.status = "error";
    getRuntime().lastOverallError = err.message;
  });

  child.on("exit", (code, signal) => {
    unregisterManagedChild(managedId);
    h.child = null;
    h.ourPid = null;
    h.state.pid = undefined;
    if (h.stopping) {
      h.state.status = "stopped";
      return;
    }

    // unsupported 判定（2026-07-19 冒烟实测两种真实形态）：
    // - 「unknown EventKey」——CLI 版本没收录该 key
    // - 「requires callbacks not subscribed」——后台没订阅回调（如 card.action.trigger），
    //   hint 里带扫码订阅链接、透出给设置页引导
    const tail = h.stderrTail.join("\n");
    if (
      code === 2 &&
      (tail.includes("unknown EventKey") ||
        tail.includes("requires callbacks not subscribed"))
    ) {
      h.state.status = "unsupported";
      h.state.lastError = tail.includes("unknown EventKey")
        ? "当前 lark-cli 版本不支持该事件"
        : "应用后台未订阅该回调（点「去订阅」扫码开通）";
      const urlMatch = tail.match(/https:\/\/open\.feishu\.cn\/\S+/);
      if (urlMatch) {
        h.state.subscribeUrl = urlMatch[0].replace(/["',)\]}]+$/, "");
      }
      // 不做快速重试循环——等 30s 的 syncBridgeRuntime 轮询再探（订阅完自动恢复）
      h.backoffMs = BACKOFF_CAP_MS;
      console.warn(
        `[feishu-bridge/inbound] consumer 不可用 event_key=${h.spec.eventKey}：${h.state.lastError}`,
      );
      return;
    }

    // 存活 ≥5 分钟 → 重置退避
    if (Date.now() - h.startedAt >= HEALTHY_RESET_MS) {
      h.backoffMs = 1000;
    }
    h.state.restartCount += 1;
    h.state.lastError = `exit code=${code} signal=${signal}`;
    console.warn(
      `[feishu-bridge/inbound] consumer 退出 event_key=${h.spec.eventKey}，${h.backoffMs}ms 后重启`,
    );
    scheduleRestart(h);
  });
};

const startConsumer = async (h: ConsumerHandle): Promise<void> => {
  if (h.stopping) return;
  if (h.child) return;

  // 单实例守卫（坑 #4）
  const conflict = await checkEventKeyConflict(h.spec.eventKey, h.ourPid);
  if (conflict.conflict) {
    h.state.status = "conflict";
    h.state.conflictDetail = conflict.detail;
    h.state.lastError = conflict.detail;
    getRuntime().lastOverallError = conflict.detail;
    console.warn(`[feishu-bridge/inbound] ${conflict.detail}`);
    return;
  }

  const bin = await resolveLarkCliBin();
  let child: ChildProcess;
  try {
    child = spawnImpl(
      bin,
      ["event", "consume", h.spec.eventKey, "--as", "bot"],
      {
        // stdin 必须 pipe 保持打开——EOF = 优雅退出，绝不能 ignore
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );
  } catch (err) {
    h.state.status = "error";
    h.state.lastError = err instanceof Error ? err.message : String(err);
    scheduleRestart(h);
    return;
  }
  wireChild(h, child);
};

const stopConsumer = async (h: ConsumerHandle): Promise<void> => {
  h.stopping = true;
  if (h.restartTimer) {
    clearTimeout(h.restartTimer);
    h.restartTimer = null;
  }
  if (h.child) {
    await stopChildGracefully(h.child);
    h.child = null;
  }
  h.ourPid = null;
  h.state.pid = undefined;
  h.state.status = "stopped";
  h.state.conflictDetail = undefined;
  h.stopping = false;
  h.backoffMs = 1000;
  unregisterManagedChild(`feishu-bridge:${h.spec.eventKey}`);
};

const syncKeepAwake = async (bridgeOn: boolean): Promise<void> => {
  const rt = getRuntime();
  const want =
    bridgeOn && (await isFeishuBridgeKeepAwakeEnabled());
  if (want) rt.keepAwake.start();
  else rt.keepAwake.stop();
};

/**
 * 读开关：开 → 确保 consumers + keep-awake；关 → 全停。
 * 幂等；dev 热重载靠 globalThis 单例不双跑。
 */
export const syncBridgeRuntime = async (): Promise<void> => {
  const rt = getRuntime();
  if (rt.syncing) return;
  rt.syncing = true;
  try {
    ensureExitHook();
    const enabled = await isFeishuChatBridgeEnabled();
    await syncKeepAwake(enabled);

    if (!enabled) {
      for (const spec of CONSUMER_SPECS) {
        const h = ensureHandle(spec);
        await stopConsumer(h);
      }
      return;
    }

    for (const spec of CONSUMER_SPECS) {
      const h = ensureHandle(spec);
      h.stopping = false;
      // conflict / unsupported 态：每次 sync 再探一次（对端可能已关 / 用户可能已订阅回调）
      if (
        h.state.status === "conflict" ||
        h.state.status === "stopped" ||
        h.state.status === "error" ||
        h.state.status === "unsupported"
      ) {
        if (!h.child) await startConsumer(h);
      } else if (!h.child && h.state.status !== "backoff") {
        await startConsumer(h);
      }
    }
  } finally {
    rt.syncing = false;
  }
};

/** 设置页 /status 用 */
export const getBridgeRuntimeStatus = (): BridgeRuntimeStatus => {
  const rt = getRuntime();
  const consumers = CONSUMER_SPECS.map((spec) => {
    const h = rt.consumers.get(spec.eventKey);
    return h ? { ...h.state } : makeConsumerState(spec.eventKey);
  });
  // overall 计算口径：optional consumer 的 unsupported 不拖累整体（优雅降级，
  // 旧 CLI 上不可用的事件）；非 optional 的 unsupported 算 partial
  const significant = consumers.filter((c, i) => {
    const spec = CONSUMER_SPECS[i]!;
    return !(spec.optional && c.status === "unsupported");
  });
  const enabled = significant.some((c) => c.status !== "stopped");
  const anyConflict = significant.some((c) => c.status === "conflict");
  const anyError = significant.some((c) => c.status === "error");
  const anyReady = significant.some((c) => c.status === "ready");
  const anyDegraded = significant.some(
    (c) =>
      c.status === "starting" ||
      c.status === "backoff" ||
      c.status === "unsupported",
  );

  let overall: BridgeRuntimeStatus["overall"] = "stopped";
  if (anyConflict) overall = "conflict";
  else if (anyError && !anyReady) overall = "error";
  else if (
    anyReady &&
    (anyError || anyDegraded || significant.some((c) => c.status === "stopped"))
  )
    overall = "partial";
  else if (anyReady) overall = "running";
  else if (anyDegraded) overall = "partial";
  else if (enabled) overall = "partial";

  return {
    overall,
    enabled,
    keepAwake: rt.keepAwake.isActive(),
    hostname: os.hostname(),
    consumers,
    lastError: rt.lastOverallError,
    lastInboundAt: rt.lastInboundAt,
    everInbound: rt.everInbound,
  };
};

/**
 * 进程退出时停 consumer / keep-awake / 托管子进程（R1-12）。
 *
 * 信号礼仪：once 注册 → handler 内 await 清理（上限 2s）→ 重发原信号走默认退出。
 * 仅注册 once 且不 process.exit 会吞掉 SIGTERM 默认行为——Electron 壳停 server
 * 的优雅路径就是 SIGTERM（2s 后 SIGKILL 兜底，见 electron-app/main.js stopServer）。
 * beforeExit 无「默认退出可重发」语义，保持 fire-and-forget 清理即可。
 */
const ensureExitHook = (): void => {
  const rt = getRuntime();
  if (rt.exitHooked) return;
  rt.exitHooked = true;
  const stopQuiet = (): void => {
    void stopBridgeRuntime();
    void stopAllManagedChildren();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      await Promise.race([
        Promise.all([stopBridgeRuntime(), stopAllManagedChildren()]),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      // once 已卸；重发原信号 → Node 默认退出（壳侧 2s SIGKILL 兜底仍有效）
      process.kill(process.pid, signal);
    })();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("beforeExit", stopQuiet);
};

/** 全停（测试 / 进程退出） */
export const stopBridgeRuntime = async (): Promise<void> => {
  const rt = getRuntime();
  if (rt.pollTimer) {
    clearInterval(rt.pollTimer);
    rt.pollTimer = null;
  }
  rt.keepAwake.stop();
  for (const h of rt.consumers.values()) {
    await stopConsumer(h);
  }
};

/**
 * server 启动挂点：立刻 sync 一次 + 30s 轮询。
 * globalThis 幂等，dev HMR 不双跑。
 */
export const ensureBridgeRuntimePolling = (): void => {
  const rt = getRuntime();
  if (rt.pollTimer) return;
  ensureExitHook();
  void syncBridgeRuntime();
  rt.pollTimer = setInterval(() => {
    void syncBridgeRuntime();
  }, 30_000);
  rt.pollTimer.unref?.();
};

/** 单测重置 runtime（不停 keep-awake 外部） */
export const __resetBridgeRuntimeForTest = async (): Promise<void> => {
  await stopBridgeRuntime();
  const rt = getRuntime();
  rt.consumers.clear();
  rt.lastOverallError = undefined;
  rt.syncing = false;
};
