/**
 * 飞书入向常驻 consumer（4.3 + 4.4c）
 *
 * - 按 eventKey 声明式列表 spawn `lark-cli event consume … --as bot`
 * - stderr 见 `[event] ready event_key=` 才算就绪
 * - stdin pipe 保持打开；停时 stdin.end() → 5s → SIGTERM（绝不 kill -9）
 * - 崩溃指数退避；单实例守卫（event status 查同 key 异进程）
 * - keep-awake + 断线补拉
 *
 * S3c 会往 CONSUMER_SPECS 加 `im.message.recalled_v1`。
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
  hasProcessedMessageId,
  markProcessedMessageId,
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

export type ConsumerEventKey =
  | "im.message.receive_v1"
  | "card.action.trigger"
  | "im.message.recalled_v1";

type ConsumerSpec = {
  eventKey: ConsumerEventKey;
  /** 收到一条 NDJSON 后的处理 */
  onEvent: (raw: unknown) => Promise<void>;
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

const defaultMessageHandler = async (raw: unknown): Promise<void> => {
  const msg = normalizeInboundEvent(raw);
  if (!msg) return;
  if (await hasProcessedMessageId(msg.message_id)) return;
  const result = await routeInboundMessage(msg);
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
};

const defaultCardActionHandler = async (raw: unknown): Promise<void> => {
  await dispatchCardActionEvent(raw);
};

/** 声明式列表——S3c 追加 recalled */
export const CONSUMER_SPECS: ConsumerSpec[] = [
  {
    eventKey: "im.message.receive_v1",
    onEvent: defaultMessageHandler,
  },
  {
    eventKey: "card.action.trigger",
    onEvent: defaultCardActionHandler,
  },
];

// ----------------- 状态类型 -----------------

export type ConsumerRuntimeState = {
  eventKey: ConsumerEventKey;
  status: "stopped" | "starting" | "ready" | "backoff" | "conflict" | "error";
  pid?: number;
  lastError?: string;
  restartCount: number;
  conflictDetail?: string;
};

export type BridgeRuntimeStatus = {
  overall: "running" | "conflict" | "stopped" | "error" | "partial";
  enabled: boolean;
  keepAwake: boolean;
  hostname: string;
  consumers: ConsumerRuntimeState[];
  lastError?: string;
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

/**
 * 补拉：GET /open-apis/im/v1/messages
 * 参数实测（2026-07-18）：
 *   container_id_type=chat
 *   container_id=<chat_id>
 *   start_time / end_time = **Unix 秒**（字符串）
 *   page_size、sort_type=ByCreateTimeAsc
 * create_time 在返回里是毫秒字符串。
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

  const startSec = String(Math.floor(lastMs / 1000));
  const endSec = String(Math.floor(now / 1000));
  try {
    const rec = await larkApi("GET", "/open-apis/im/v1/messages", {
      params: {
        container_id_type: "chat",
        container_id: chatId,
        start_time: startSec,
        end_time: endSec,
        page_size: 50,
        sort_type: "ByCreateTimeAsc",
      },
    });
    const data = (rec.data as Record<string, unknown> | undefined) ?? rec;
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const messageId =
        typeof it.message_id === "string" ? it.message_id : "";
      if (!messageId || (await hasProcessedMessageId(messageId))) continue;

      const sender = it.sender as Record<string, unknown> | undefined;
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
        sender_id: typeof sender?.id === "string" ? sender.id : "",
        content: typeof body?.content === "string" ? body.content : "",
        root_id: typeof it.root_id === "string" ? it.root_id : undefined,
        parent_id:
          typeof it.parent_id === "string" ? it.parent_id : undefined,
      };
      await onMessage(msg);
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
};

const RUNTIME_KEY = "__feAiFlowFeishuBridgeRuntimeV1__";

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

  // stderr：ready 标记
  if (child.stderr) {
    const rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
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

  // stdout：NDJSON
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
      // conflict 态：每次 sync 再探一次（对端可能已关）
      if (
        h.state.status === "conflict" ||
        h.state.status === "stopped" ||
        h.state.status === "error"
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
  const enabled = consumers.some((c) => c.status !== "stopped");
  const anyConflict = consumers.some((c) => c.status === "conflict");
  const anyError = consumers.some((c) => c.status === "error");
  const anyReady = consumers.some((c) => c.status === "ready");
  const anyStarting = consumers.some(
    (c) => c.status === "starting" || c.status === "backoff",
  );

  let overall: BridgeRuntimeStatus["overall"] = "stopped";
  if (anyConflict) overall = "conflict";
  else if (anyError && !anyReady) overall = "error";
  else if (anyReady && (anyError || anyStarting || consumers.some((c) => c.status === "stopped")))
    overall = "partial";
  else if (anyReady) overall = "running";
  else if (anyStarting) overall = "partial";
  else if (enabled) overall = "partial";

  return {
    overall,
    enabled,
    keepAwake: rt.keepAwake.isActive(),
    hostname: os.hostname(),
    consumers,
    lastError: rt.lastOverallError,
  };
};

const ensureExitHook = (): void => {
  const rt = getRuntime();
  if (rt.exitHooked) return;
  rt.exitHooked = true;
  const stop = () => {
    void stopBridgeRuntime();
    void stopAllManagedChildren();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("beforeExit", stop);
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
