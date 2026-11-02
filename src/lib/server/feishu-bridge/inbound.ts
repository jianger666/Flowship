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
  forceKillAllManagedChildrenSync,
  registerBinaryUser,
  LARK_CLI_BINARY_USER,
} from "@/lib/server/kill-orphans";
import { stripHostInjectedEnvAndGitToken } from "@/lib/server/host-env";
import { killOwnProcessTreeSync } from "@/lib/server/win-self-tree-kill";

import { maybeSweepStaleAttachments } from "./attachment-store";
import {
  getBridgeDataDir,
  isFeishuBridgeKeepAwakeEnabled,
  isFeishuChatBridgeEnabled,
} from "./bridge-config";
import {
  getLastP2pChatId,
  getPersistedLastInboundAt,
  peekLastP2pChatIdState,
  hasProcessedMessageId,
  markProcessedMessageId,
  rememberInboundReceivedAt,
  rememberP2pChatId,
} from "./bridge-state";
import {
  getLastProcessedTs,
  setLastProcessedTs,
} from "./card-map";
import { isGroupBotIdentityUnusable } from "./group-shared";
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
import type { FeishuInboundMessage, FeishuMention } from "./types";

// ----------------- 声明式 consumer 列表 -----------------

export type ConsumerEventKey = "im.message.receive_v1" | "card.action.trigger";

type ConsumerSpec = {
  eventKey: ConsumerEventKey;
  /** 收到一条 NDJSON 后的处理 */
  onEvent: (raw: unknown) => Promise<unknown>;
  /**
   * 可选能力：CLI 不支持 / 未订阅时整体状态不受它拖累（overall 计算时忽略），
   * 功能优雅降级。
   */
  optional?: boolean;
};

/**
 * 归一化 mentions 数组（群消息「@ 了谁」）。
 *
 * 三种形态都兼容（CLI 扁平化程度不定）：
 * - 官方：`{ key, id: { open_id }, name }`
 * - 扁平：`{ key, open_id, name }`
 * - 退化：字符串（只有名字）
 */
const normalizeMentions = (raw: unknown): FeishuMention[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: FeishuMention[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ name: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const idObj =
      m.id && typeof m.id === "object" ? (m.id as Record<string, unknown>) : null;
    const openId =
      (idObj && typeof idObj.open_id === "string" && idObj.open_id) ||
      (typeof m.open_id === "string" && m.open_id) ||
      (typeof m.id === "string" && m.id) ||
      "";
    const name = typeof m.name === "string" ? m.name : "";
    const key = typeof m.key === "string" ? m.key : "";
    if (!openId && !name && !key) continue;
    out.push({
      ...(key ? { key } : {}),
      ...(openId ? { openId } : {}),
      ...(name ? { name } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
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

  // sender 归一化（官方形态 event.sender + event.message，enrichment 扁平形态只有顶层 sender）：
  // 优先级 msgObj.sender > nested.sender > 顶层扁平。bot 消息的 sender 形态不定
  //（open_id / app_id / open_bot_id），防御性全取，判定侧多格比对。
  const parseSenderShape = (
    s: Record<string, unknown> | null,
  ): { id: string; type: string; appId: string; botOpenId: string } => {
    const out = { id: "", type: "user", appId: "", botOpenId: "" };
    if (!s) return out;
    if (typeof s.id === "string") out.id = s.id;
    if (s.sender_id && typeof s.sender_id === "object") {
      const sid = s.sender_id as {
        open_id?: unknown;
        app_id?: unknown;
        user_id?: unknown;
      };
      if (typeof sid.open_id === "string") out.id = sid.open_id;
      else if (typeof sid.user_id === "string") out.id = sid.user_id;
      else if (typeof sid.app_id === "string") out.id = sid.app_id;
      if (typeof sid.app_id === "string") out.appId = sid.app_id;
    }
    if (typeof s.sender_type === "string" && s.sender_type) {
      out.type = s.sender_type;
    }
    if (typeof s.open_bot_id === "string" && s.open_bot_id) {
      out.botOpenId = s.open_bot_id;
    }
    if (typeof s.app_id === "string" && s.app_id) out.appId = s.app_id;
    const idType = typeof s.id_type === "string" ? s.id_type : "";
    if (idType === "app_id" && typeof s.id === "string" && s.id) {
      out.appId = s.id;
      // app 身份的 open_id 另给：sender_id 这一格优先 open 命名空间（见下）
    }
    return out;
  };
  const msgSender =
    msgObj.sender && typeof msgObj.sender === "object"
      ? (msgObj.sender as Record<string, unknown>)
      : null;
  const nestedSender =
    nested && nested.sender && typeof nested.sender === "object"
      ? (nested.sender as Record<string, unknown>)
      : null;
  const sender = msgSender ?? nestedSender;
  const shape = parseSenderShape(sender);
  // 发件人租户（best-effort，只收「确属发件人」的字段）：event.sender.tenant_key（官方原始事件形态）、
  // 顶层 sender_tenant_key；扁平形态顶层的 tenant_key 沿用旧行为（语义未经 schema 确认，将来确认是应用租户就该删）。
  // **不采用 header.tenant_key**：那是应用（机器人）所在租户、不是发件人的，拿它当发件人租户，
  // 外部租户成员的消息会被当成「与本租户一致」。
  // 注意：当前 lark-cli compact 事件（`lark-cli event schema im.message.receive_v1`）里没有 tenant_key，
  // 生产里这里恒为空，群答疑的租户闸暂不生效（拿不到就不拦，见 restricted-qa-gate 头注释）；
  // 这里只是给将来 lark-cli 补上字段预留。
  const tenantKeyOf = (v: unknown): string =>
    typeof v === "string" ? v.trim() : "";
  const senderTenantKey =
    tenantKeyOf(sender?.tenant_key) ||
    tenantKeyOf(o.sender_tenant_key) ||
    tenantKeyOf(o.tenant_key);
  let senderId = shape.id;
  // 顶层扁平兜底（enrichment CLI 形态）
  if (!senderId && typeof o.sender_id === "string") senderId = o.sender_id;
  let senderType = shape.type;
  if (typeof o.sender_type === "string" && o.sender_type) {
    senderType = o.sender_type;
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
    ...(senderType !== "user" ? { sender_type: senderType } : {}),
    ...(shape.appId ? { sender_app_id: shape.appId } : {}),
    ...(shape.botOpenId ? { sender_bot_open_id: shape.botOpenId } : {}),
    ...(senderTenantKey ? { sender_tenant_key: senderTenantKey } : {}),
    sender_name:
      (typeof o.sender_name === "string" && o.sender_name) ||
      (typeof (msgSender ?? nestedSender)?.name === "string"
        ? ((msgSender ?? nestedSender)?.name as string)
        : undefined) ||
      (nested &&
        typeof (nested as { sender_name?: unknown }).sender_name === "string" &&
        (nested as { sender_name: string }).sender_name) ||
      undefined,
    // 群消息 @ 列表：官方在 event.message.mentions、CLI 扁平化后可能提到顶层
    mentions:
      normalizeMentions(msgObj.mentions) ?? normalizeMentions(o.mentions),
    content,
    root_id:
      (typeof msgObj.root_id === "string" && msgObj.root_id) ||
      (typeof o.root_id === "string" && o.root_id) ||
      undefined,
    parent_id:
      (typeof msgObj.parent_id === "string" && msgObj.parent_id) ||
      (typeof o.parent_id === "string" && o.parent_id) ||
      undefined,
    reply_to:
      (typeof msgObj.reply_to === "string" && msgObj.reply_to) ||
      (typeof o.reply_to === "string" && o.reply_to) ||
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

/** 入向消息处理的附加选项 */
export type InboundHandlerOpts = {
  /**
   * 不推进补拉游标（其它记账——标记已处理 / 记 chatId——照常）。
   * 补拉批内出现过失败之后，后面的消息用它：游标不能越过最早失败的那条，否则那条下次补拉时就永久丢了。
   */
  skipCursorAdvance?: boolean;
};

/**
 * 入向消息处理结果——补拉据此判断「游标能不能越过这条」：
 * - `handled`：这条已经没有重放价值——路由处理完（注入 / 终态拒绝）、已处理过（去重命中）、
 *   或根本不是可处理的消息事件（normalize 不认）。重放它要么重复执行、要么什么也不会发生。
 * - `retryable_failed`：基础设施类可重试失败（R1-6：getBotAppInfo 抖动 / inject 5xx 等）。
 *   没标记已处理，指望补拉重投——所以游标绝不能越过它。
 */
export type InboundHandleOutcome = "handled" | "retryable_failed";

/**
 * 入向消息默认处理：去重 → 路由 →（非 retryable）标记已处理 + 推进游标。
 * live stdout 与 catchUpMissedMessages 都走这里（同链）。
 */
export const defaultMessageHandler = async (
  raw: unknown,
  opts: InboundHandlerOpts = {},
): Promise<InboundHandleOutcome> =>
  enqueueInboundMessage(async (): Promise<InboundHandleOutcome> => {
    const msg = normalizeInboundEvent(raw);
    if (!msg) return "handled"; // 不是可处理的消息事件：没有东西可重放
    // 收消息自检打点：只要链路收到过任何入向消息就记（早于去重/过滤，
    // 语义是「订阅通了」而不是「消息被处理了」）
    markBridgeInboundReceived();
    if (await hasProcessedMessageId(msg.message_id)) return "handled"; // 已处理过（去重命中）
    const result = await routeInboundMessage(msg);
    // R1-6：基础设施类 retryable 失败不 mark、不推进游标——等补拉重投。
    // 返回 retryable_failed 让补拉把它算作「批内失败」（游标不越过它）；live 路径忽略返回值。
    if (result.kind === "failed" && result.retryable) {
      return "retryable_failed";
    }
    // 路由已经处理完这条消息（注入 / 终态拒绝都算）。下面三步只是「记账」：各自 best-effort、互不连累——
    // bridge-state 持续不可读时（见 json-store：读改写会拒绝覆盖）标记会一直抛；
    // 若它一抛就跳过后面的游标推进，补拉窗口停在原地、每次重连都会把同一批消息再注入一遍（重复执行用户指令）。
    // 游标在 card-map（另一份文件），照样推进就能越过这条；标记失败只留 warn。
    await bookkeepQuiet("标记已处理", msg.message_id, () =>
      markProcessedMessageId(msg.message_id),
    );
    // 仅「本人 p2p」消息推进补拉状态——群聊 / 他人私聊不得污染 chatId 与游标
    //（否则补拉窗口会指向错误会话、漏掉 owner 的离线消息）
    const identityOk =
      result.error !== SKIP_NOT_P2P && result.error !== SKIP_NOT_OWNER;
    if (msg.chat_type === "p2p" && identityOk) {
      await bookkeepQuiet("记 p2p chatId", msg.message_id, () =>
        rememberP2pChatId(msg.chat_id),
      );
      if (msg.create_time && !opts.skipCursorAdvance) {
        const createTime = msg.create_time;
        await bookkeepQuiet("推进补拉游标", msg.message_id, () =>
          setLastProcessedTs(createTime),
        );
      }
    }
    return "handled";
  });

/** 入向消息处理后的记账步骤：失败只 warn，不向外抛、不影响后面的记账 */
const bookkeepQuiet = async (
  what: string,
  messageId: string,
  fn: () => Promise<void>,
): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    console.warn(
      `[feishu-bridge/inbound] ${what}失败（已忽略） message=${messageId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};

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
  /**
   * 群消息认不出 @（bot open_id 与应用名都取不到）——群回流此刻是哑的。
   * 只在真探测到时出现，设置页据此出一行提示（否则用户只会看到「机器人在群里不理人」）。
   */
  groupMentionUnavailable?: boolean;
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
/** 停 consumer 每一档（stdin EOF / SIGTERM）的等待上限；单测可压小 */
let stopGraceMs = STOP_GRACE_MS;

/** 单测调小停子进程的等待；传 null 复原（卡死的 child 用例本来要真等 2×5s） */
export const __setStopGraceForTest = (ms: number | null): void => {
  stopGraceMs = ms ?? STOP_GRACE_MS;
};
const CATCHUP_MAX_MS = 30 * 60_000;

/** 首轮重启退避基数（之后翻倍到 BACKOFF_CAP_MS 封顶） */
const DEFAULT_BACKOFF_BASE_MS = 1_000;
let backoffBaseMs = DEFAULT_BACKOFF_BASE_MS;

/**
 * 单测调小首轮退避；传 null 复原。
 * 崩溃重启用例本来真等 1s，撑掉大半个用例预算——全量并发下随机超时。
 */
export const __setConsumerBackoffBaseForTest = (ms: number | null): void => {
  backoffBaseMs = ms ?? DEFAULT_BACKOFF_BASE_MS;
};

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
    setTimeout(() => finish(false), stopGraceMs).unref?.();
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
      setTimeout(() => resolve(), stopGraceMs).unref?.();
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
  onMessage: (
    msg: FeishuInboundMessage,
    opts?: InboundHandlerOpts,
  ) => Promise<InboundHandleOutcome | void> = defaultMessageHandler,
): Promise<void> => {
  const lastTs = await getLastProcessedTs();
  if (!lastTs) return;

  const lastMs = Number(lastTs);
  if (!Number.isFinite(lastMs) || lastMs <= 0) return;

  const now = Date.now();
  const gap = now - lastMs;
  const chatId = await getLastP2pChatId();
  if (!chatId) {
    // 空串有两种来源，日志要分清：确实没存过（新装 / 还没收过私聊）vs 状态文件读不出来（权限 / 损坏）。
    // 后者不是「尚无」——离线期间的消息会漏补，必须如实说。
    // 没有别的来源可补：card-map 的条目不带 chatId；进程内也没缓存（重启后丢），所以保持跳过。
    const st = await peekLastP2pChatIdState();
    console.warn(
      st.unreadable
        ? "[feishu-bridge/inbound] 补拉跳过：bridge-state 读不出来（权限 / 内容损坏），无法确定 p2p chatId——此期间的离线消息不会自动补上，需要的话请重新发送"
        : "[feishu-bridge/inbound] 补拉跳过：尚无 p2p chatId",
    );
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
    // （card-map 读改写读不出来时会抛——调用点是 `void catchUpMissedMessages()`，这里不兜住就是未处理的 rejection）
    await bookkeepQuiet("推进补拉游标（超窗）", "-", () => setLastProcessedTs(String(now)));
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
  /** 本批是否出现过处理失败（抛错 / 可重试失败；出现后其余消息不再推进游标，见下方循环内注释） */
  let batchFailed = false;
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
        // 每条消息独立 try/catch：一条处理抛错（路由异常 / 记账失败…）只丢这一条，
        // 不能让整轮补拉中断、把后面本该补上的离线消息一起丢掉。
        // 失败也计入总量 cap（injected 在这里按「尝试数」算）：持续失败时不能无休止翻页。
        //
        // 「失败」有两种，都要让游标停在它前面（否则后面成功的消息把游标推过去，它就永久丢了——补拉只取游标之后的）：
        //  ① onMessage 抛错；
        //  ② onMessage 正常返回 "retryable_failed"（handler 遇到可重试失败是 return、不抛，也不标记已处理）。
        // 选「让 handler 返回结果」而不是「返回后用 hasProcessedMessageId 复查」：bridge-state 读得出但写不进时
        // （磁盘满 / Windows 上杀软锁文件导致 rename 失败），标记已处理会一直失败、复查会把已成功处理的消息误判成失败，
        // 游标就永远不动、每次重连重复注入。（bridge-state 完全读不出来时补拉根本走不进这个循环，见上面的 peek 分支。）
        // 没有走「消费掉不重放」：这类失败的语义本来就是「没处理成、等重投」（R1-6），重放它正是目的，
        // 且重放安全——已处理的靠去重表跳过，只有它自己会再走一遍路由。
        //
        // 批内第一条失败之后，这条之后的消息都带 skipCursorAdvance 处理——照常注入 + 标记已处理，只是不推进游标。
        // 不会无休止重放：① 补拉只在 consumer ready（重连）时跑一次、不是循环；② 每轮仍有 200 条上限；
        // ③ 游标停住后一旦离线超过 CATCHUP_MAX_MS（30 分钟），上面的超窗分支会提示并把游标直接推到现在——
        // 一条永远失败的毒消息最多拖住游标 30 分钟。
        // 顺序提示：被重放的失败消息会晚于它后面「已经注入过」的消息再进会话（失败点之后的靠去重表跳过、不重复注入），
        // 所以同一批里先后两条有先后依赖的指令，可能以 B、A 的顺序被 agent 看到。
        // （局限：去重表本身读不出来时 hasProcessedMessageId 回 false，重放会把失败点之后的消息再注入一遍——
        //  bridge-state 持续损坏本来就保不住去重，这里不为它放弃「不丢消息」。
        //  另：本段只管「同一批补拉」。live 路径里一条可重试失败之后若又来了成功的 live 消息，游标仍会被它推过去——
        //  live 与补拉共用一个游标，要堵住得持久化「失败点」并设计何时重试 / 何时放弃，不是在这个循环里能解决的，目前不处理。
        //  同理没有给毒消息做「失败次数上限」：重试靠的是「游标不越过它」，而游标最多被拖住 CATCHUP_MAX_MS；
        //  按次数放弃会在基础设施长时间抖动（getBotAppInfo / inject 5xx）时把正常消息永久吞掉。）
        try {
          const outcome = await onMessage(
            msg,
            batchFailed ? { skipCursorAdvance: true } : undefined,
          );
          if (outcome === "retryable_failed") {
            batchFailed = true;
            console.warn(
              `[feishu-bridge/inbound] 补拉单条可重试失败、未标记已处理 message=${messageId}（本批其后的消息不再推进游标，下次补拉重投）`,
            );
          }
        } catch (err) {
          batchFailed = true;
          console.warn(
            `[feishu-bridge/inbound] 补拉单条处理失败、跳过 message=${messageId}（本批其后的消息不再推进游标）:`,
            err instanceof Error ? err.message : err,
          );
        }
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
      backoffMs: backoffBaseMs,
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
          void catchUpMissedMessages().catch((err) => {
            console.warn(
              "[feishu-bridge/inbound] 断线补拉异常:",
              err instanceof Error ? err.message : err,
            );
          });
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

  // 退出后的善后：判 unsupported（不快速重试）/ 否则按退避重启。exit / close 兜底共用
  const onChildExited = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
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
      h.backoffMs = backoffBaseMs;
    }
    h.state.restartCount += 1;
    h.state.lastError = `exit code=${code} signal=${signal}`;
    console.warn(
      `[feishu-bridge/inbound] consumer 退出 event_key=${h.spec.eventKey}，${h.backoffMs}ms 后重启`,
    );
    scheduleRestart(h);
  };

  // 本 child 是否已「收尸」（清 h.child + 排重启）。
  // spawn 失败（ENOENT / EACCES：lark-cli 升级替换、被杀软隔离的瞬间）时 Node **只触发
  // error + close、不触发 exit**——旧实现重启只挂在 exit 上，h.child 又仍指着死进程，
  // 30s 轮询因 `!h.child` 不成立永不重试 → 入向永久静默到重启 App。
  // exit / error（spawn 失败）/ close（兜底）三条路径可能先后都触发，
  // 只认第一次：否则 scheduleRestart 会被重复调用、退避翻倍两次、restartCount 重复计数
  let reaped = false;

  const reap = (
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnErr?: Error,
  ): void => {
    if (reaped) return;
    reaped = true;
    // 已不是现任（stopConsumer 等不到它退出、放弃后把 h.child 摘掉；之后可能已有新 child 接班）：
    // 这是被摘掉的旧进程迟到的退出，与现任无关——不能清现任的引用 / 改状态 / unregister
    // 同一个 managedId（会让现任在 server 退出时漏被优雅停），更不能排重启
    // （桥接已关时会把刚关掉的 consumer 又拉起来，已开时会 backoff 覆盖现任的 ready）。
    // 注意：正常退出路径里 h.child 一定还是自己（wireChild 一进来就赋值），这里只拦「已被摘掉」的。
    if (h.child !== child) return;
    unregisterManagedChild(managedId);
    h.child = null;
    h.ourPid = null;
    h.state.pid = undefined;
    if (h.stopping) {
      h.state.status = "stopped";
      return;
    }
    if (spawnErr) {
      // spawn 失败：没有 exit code / stderr 可判 unsupported，直接走退避重启
      h.state.restartCount += 1;
      h.state.lastError = spawnErr.message;
      console.warn(
        `[feishu-bridge/inbound] consumer spawn 失败 event_key=${h.spec.eventKey}（${spawnErr.message}），${h.backoffMs}ms 后重启`,
      );
      scheduleRestart(h);
      return;
    }
    onChildExited(code, signal);
  };

  child.on("error", (err: NodeJS.ErrnoException) => {
    // 旧 child（已被摘掉 / 已被新 child 接班）的 error 不许改现任的状态
    if (h.child !== child) return;
    h.state.lastError = err.message;
    h.state.status = "error";
    getRuntime().lastOverallError = err.message;
    // 仅 spawn 失败才收尸：pid 为空（真实 spawn 失败必然如此），或 ENOENT/EACCES。
    // error 也可能来自 kill() 失败等「进程仍活着」的场景——那种不能清 h.child（会漏掉活进程）
    if (
      child.pid === undefined ||
      err.code === "ENOENT" ||
      err.code === "EACCES"
    ) {
      reap(null, null, err);
    }
  });

  // close 兜底：正常路径 exit 先到、这里是 no-op；exit 缺席时仍能清引用 + 排重启
  child.on("close", (code, signal) => {
    reap(code, signal);
  });

  child.on("exit", (code, signal) => {
    reap(code, signal);
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
        // 只减不增：摘掉宿主注入变量（ELECTRON_RUN_AS_NODE / FLOWSHIP_* / __NEXT_PRIVATE_* ...）和 GitLab PAT；
        // lark-cli 是长寿命 CLI，用不到这些，PATH / HOME / 代理照常保留
        env: stripHostInjectedEnvAndGitToken(),
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
  h.backoffMs = backoffBaseMs;
  unregisterManagedChild(`feishu-bridge:${h.spec.eventKey}`);
};

const syncKeepAwake = async (bridgeOn: boolean): Promise<void> => {
  const rt = getRuntime();
  const want =
    bridgeOn && (await isFeishuBridgeKeepAwakeEnabled());
  if (want) rt.keepAwake.start();
  else rt.keepAwake.stop();
};

/** 安装 hold：suspend 后 resume 前为 true，30s 轮询见此直接返回（防中途重拉锁住 exe） */
let upgradeHoldForInstall = false;

/**
 * 读开关：开 → 确保 consumers + keep-awake；关 → 全停。
 * 幂等；dev 热重载靠 globalThis 单例不双跑。
 * 升级 hold 期间（安装链 suspend 后、resume 前）直接返回——防 30s 轮询中途重拉
 * 把正要覆盖的 exe 重新锁住（Windows 在跑的 exe 盖不掉，见 feishu-cli 安装链）。
 */
export const syncBridgeRuntime = async (): Promise<void> => {
  const rt = getRuntime();
  if (rt.syncing) return;
  rt.syncing = true;
  try {
    if (upgradeHoldForInstall) return;
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
    ...(isGroupBotIdentityUnusable() ? { groupMentionUnavailable: true } : {}),
  };
};

/**
 * 进程退出时停 consumer / keep-awake / 托管子进程（R1-12）。
 *
 * 信号礼仪：once 注册 → handler 内 await 清理（上限 1.5s、必须小于壳侧 2s 的 SIGKILL 兜底）→ **显式 process.exit**。
 * 仅注册 once 且不 process.exit 会吞掉 SIGTERM 默认行为——Electron 壳停 server
 * 的优雅路径就是 SIGTERM（2s 后 SIGKILL 兜底，见 electron-app/main.js stopServer）。
 *
 * 为什么不是「重发原信号走默认退出」（旧写法，2026-11-01 评审 R1-1）：Next 的 `start-server` 自己也
 * `process.on("SIGTERM"/"SIGINT", cleanup)`（持久监听、没设 NEXT_MANUAL_SIG_HANDLE 就一定注册），
 * 重发的信号会被它的监听器接走、默认退出行为不会发生；而它的 cleanup 要 `server.close()` 等所有连接断开，
 * SSE 长连一直开着 → 永远不返回 → 进程活到壳侧 2s SIGKILL（每次退出多等 2s 且是强杀）。
 * beforeExit 无「默认退出可重发」语义，保持 fire-and-forget 清理即可。
 */
/** 退出清理的等待上限：必须小于 Electron 壳 stopServer 的 2s SIGKILL 兜底，留出 process.exit 的余量 */
const EXIT_HOOK_CLEANUP_CAP_MS = 1500;

/**
 * 退出清理本体（不含 process.exit）：优雅停 consumer / 托管子进程（含预览 dev server）最多等 1.5s，
 * 然后**同步**强杀登记过的残留进程组（评审 R1-9）。
 *
 * 为什么必须有强杀这一步：预览 dev server 的优雅停是「TERM → 轮询最多 2s → KILL」，比 1.5s 上限还长，
 * 而且 stopAllPreviews 排在预览全局串行队列里（前面有慢 start 就根本轮不到）。
 * 不听 SIGTERM 的 dev server 到点只收到了 TERM、随后 process.exit 把等待它的 KILL 一起带走——
 * 它是独立进程组（detached），Electron 壳按 server 进程组的整组清理也扫不到，会一直占着端口。
 * 强杀是同步 `kill(-pgid, SIGKILL)`、不进任何队列、不 await，所以不受上限和队列拖累。
 */
const runExitCleanup = async (): Promise<void> => {
  try {
    await Promise.race([
      Promise.all([stopBridgeRuntime(), stopAllManagedChildren()]),
      new Promise<void>((r) => setTimeout(r, EXIT_HOOK_CLEANUP_CAP_MS)),
    ]);
  } catch {
    // 清理失败也要退出：吞掉后进程会一直活到壳侧 SIGKILL
  }
  try {
    forceKillAllManagedChildrenSync();
  } catch {
    // 强杀 best-effort（含测试里 kill-orphans 被局部 mock 掉、没有该导出的情况）
  }
};

/**
 * `exit` 事件监听：进程**无论被谁** process.exit 都会同步触发它（评审第 3 轮 P2）。
 *
 * 为什么 runExitCleanup 里的强杀还不够：Next 的 start-server 自己在 SIGTERM 上注册了 cleanup——
 * `server.close()` → `nextServer.close()` → 无条件 `process.exit(0)`；生产模式不 closeAllConnections，
 * 没有存活 SSE 连接时几毫秒就退出。那时我们的 onSignal 还卡在 `await race(优雅停, 1.5s)`，
 * 其后的强杀根本轮不到，不听 TERM 的预览 dev server（独立进程组、壳的整组清理扫不到）就残留了。
 * `exit` 监听器是同步的、只做强杀这一件事（幂等；已被优雅停掉的 slot 不在册、不会重复发信号），
 * 不重复触发 stopBridgeRuntime / stopAllManagedChildren 等其它副作用。
 */
const forceKillOnExit = (): void => {
  try {
    forceKillAllManagedChildrenSync();
  } catch {
    // best-effort（含测试里 kill-orphans 被局部 mock 掉、没有该导出的情况）
  }
};

/**
 * 退出序列（信号 / stdin EOF 共用；依赖可注入，供单测钉顺序）：**先清理（同步做完）→ 再按需自杀整树 → 最后 exit**。
 *
 * R8-4：仅 stdin-EOF 分支（killTreeOnWin = true）+ win32（killOwnProcessTreeSync 自己再校验）才会在清理做完之后
 * 自杀整棵进程树（含未登记的孙进程）。顺序不能反：自杀会把本进程也终结，之后的任何代码都跑不了——
 * 所以必须在 `await cleanup()` 返回之后（runExitCleanup 永不抛、其内的强杀是同步的、所有登记过的托管子进程已处理完）才杀。
 * 自杀不会比原先的 process.exit 多截断什么：process.exit 同样丢弃未完成的异步 I/O；唯一的 exit 监听器 forceKillOnExit
 * 做的事 runExitCleanup 里已同步做过一遍（幂等）。杀不掉 / 失败 / 超时 killTree 都返回（不抛），接着照常 exit——最坏退回只有 server 自己退出。
 * SIGTERM / SIGINT（含终端 Ctrl+C）传 false，不走自杀。
 *
 * 直接退出：不重发信号（会被 Next 的持久监听器接走、等 SSE 连接断开而挂住），
 * 退出码沿用 shell 惯例（SIGINT=130、SIGTERM=0：壳侧主动停 server 属正常退出）。
 */
export const runExitSequence = async (
  signal: NodeJS.Signals,
  killTreeOnWin: boolean,
  deps: { cleanup?: () => Promise<void>; killTree?: () => unknown; exit?: (code: number) => void } = {},
): Promise<void> => {
  await (deps.cleanup ?? runExitCleanup)();
  if (killTreeOnWin) {
    try {
      (deps.killTree ?? killOwnProcessTreeSync)();
    } catch {
      // 自杀失败也要退出（killOwnProcessTreeSync 本身不抛，这里兜注入的实现）
    }
  }
  (deps.exit ?? ((code: number) => process.exit(code)))(signal === "SIGINT" ? 130 : 0);
};

/** 仅供测试：跑一遍退出清理（不退进程） */
export const __runExitCleanupForTest = (): Promise<void> => runExitCleanup();

/** Electron 壳（win32）设置：stdin 管道 EOF = 请 server 优雅退出（见 ensureExitHook / electron-app/win-server-stop.mjs） */
export const STDIN_EOF_EXIT_ENV = "FLOWSHIP_EXIT_ON_STDIN_EOF";

/**
 * 监听 stdin 的 EOF / 关闭：触发一次 `onEof`（幂等）。数据一律丢弃（壳从不写它，只会 end()）；
 * unref：不让这根管道独自撑住事件循环；监听本身出任何错都吞掉（优雅退出通道坏了不能影响 server 运行，壳侧有 /F 兜底）。
 * stdin 作为参数注入，方便单测用 PassThrough 驱动。
 */
export const watchStdinEofExit = (
  stdin: NodeJS.ReadableStream & { unref?: () => unknown },
  onEof: () => void,
): void => {
  try {
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      onEof();
    };
    stdin.on("end", fire);
    stdin.on("close", fire);
    stdin.on("error", () => {}); // 管道异常断开（壳被强杀）：随后的 close 会触发 fire，这里只防未捕获的 error 事件
    stdin.resume(); // 进入流动模式才会读到 EOF；数据直接丢弃
    stdin.unref?.();
  } catch {
    // 监听挂不上：退化为只有信号 / 壳侧 /F 兜底
  }
};

const ensureExitHook = (): void => {
  const rt = getRuntime();
  if (rt.exitHooked) return;
  rt.exitHooked = true;
  const stopQuiet = (): void => {
    void stopBridgeRuntime();
    void stopAllManagedChildren();
  };
  // 信号 / stdin EOF 可能先后到达（壳先关 stdin、又补发信号）：清理只跑一次
  let exiting = false;
  const onSignal = (signal: NodeJS.Signals, killTreeOnWin = false): void => {
    if (exiting) return;
    exiting = true;
    void runExitSequence(signal, killTreeOnWin);
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  // Windows 优雅停的真通道（R1-2）：Windows 没有 POSIX 信号，壳只能「关 server 的 stdin 管道」来请它优雅退出
  // （不带 /F 的 taskkill 只会给窗口发 WM_CLOSE、无窗口的 server 收不到）。EOF → 走与 SIGTERM 同一个清理（同一个 onSignal）。
  // 只有壳会设这个环境变量（win32 才设；其它平台壳显式删掉它，见 electron-app/win-server-stop.mjs 的 withStdinEofExitEnv，
  // 否则用户环境里 export 了它会让 stdio:"ignore" 的 /dev/null 立即 EOF、server 启动即退）；
  // 独立运行 / 测试 / 容器里 stdin 被关闭时不设，不会让 server 一启动就误退。
  // 只认字面量 "1"、读到就从 process.env 摘掉：不是「壳设的」值（空串 / "0" / "true"…）一律不监听。
  // 残留边界（诚实）：用户若在自己环境里手工 export 成 "1"、再用终端直接 `node server.js` 且 stdin 被重定向 / 关闭，仍会被它带走——
  // 变量名是 Flowship 内部的、终端里 stdin 是 TTY 不会 EOF，所以只在「手工 export + stdin 被关」的组合下才触发。
  if (process.env[STDIN_EOF_EXIT_ENV] === "1") {
    // 摘掉：server 的子孙进程（agent shell 里的 pnpm / vitest 等）继承到它会在自己的 stdin 关闭时误退
    delete process.env[STDIN_EOF_EXIT_ENV];
    // true = 清理完成后在 win32 上自杀整树（R8-4）；只有这一支（壳的 stdin EOF）会，且 killOwnProcessTreeSync 自己再校验 win32
    watchStdinEofExit(process.stdin, () => onSignal("SIGTERM", true));
  }
  process.once("beforeExit", stopQuiet);
  // 任何 process.exit（含 Next 的 SIGTERM cleanup 抢先退出）都同步强杀残留进程组——见 forceKillOnExit
  process.once("exit", forceKillOnExit);
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
 * 入向附件 TTL 清扫（`attachments/` 与 `dl-*` 残留，只清超过 30 天的）。
 * 节流在 maybeSweepStaleAttachments 里（≥ 6 小时一次），所以挂在 30s 轮询上、启动后第一次轮询就会跑。
 * 永不抛、不阻塞轮询。
 */
const sweepInboundAttachmentsQuiet = async (): Promise<void> => {
  try {
    await maybeSweepStaleAttachments(await getBridgeDataDir());
  } catch {
    // 清扫只是卫生，失败不影响桥接
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
  void sweepInboundAttachmentsQuiet();
  rt.pollTimer = setInterval(() => {
    void syncBridgeRuntime();
    void sweepInboundAttachmentsQuiet();
  }, 30_000);
  rt.pollTimer.unref?.();
};

/** 单测重置 runtime（不停 keep-awake 外部） */
export const __resetBridgeRuntimeForTest = async (): Promise<void> => {
  upgradeHoldForInstall = false;
  await stopBridgeRuntime();
  const rt = getRuntime();
  rt.consumers.clear();
  rt.lastOverallError = undefined;
  rt.syncing = false;
};

// ----------------- 二进制占用登记（Windows 覆盖安装用） -----------------

/** 安装前：优雅停掉全部 consumer（stopConsumer 不触发重启），并 hold 住轮询；
 * 返回已停 eventKey（供安装日志）。失败时先复位 hold 再抛——否则 30s 轮询
 * 永久直接返回、桥接直到重启都是死的（P0 教训）。 */
const suspendConsumersForInstall = async (): Promise<string[]> => {
  upgradeHoldForInstall = true;
  try {
    const stopped: string[] = [];
    for (const spec of CONSUMER_SPECS) {
      await stopConsumer(ensureHandle(spec));
      stopped.push(spec.eventKey);
    }
    return stopped;
  } catch (err) {
    upgradeHoldForInstall = false;
    throw err;
  }
};

/** 安装后：放开 hold 并重拉（新二进制生效；失败抛给 resumeBinaryUsers 兜） */
const resumeConsumersAfterInstall = async (): Promise<void> => {
  upgradeHoldForInstall = false;
  await syncBridgeRuntime();
};

// 注意：顶层注册——r35/r36/r37 的 kill-orphans mock 是稀疏的，加新顶层调用需同步更新那三处 mock
registerBinaryUser(LARK_CLI_BINARY_USER, {
  suspend: suspendConsumersForInstall,
  resume: resumeConsumersAfterInstall,
});
