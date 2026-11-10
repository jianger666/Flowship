/**
 * 增强包 E2 · B1 网络增强的采集逻辑（契约 §15.2 S3）：WebSocket 帧 / SSE 事件 / 发起者栈 / 缓存命中。纯逻辑，无 electron 依赖。
 *
 * # 采集模型
 *  · **WebSocket**：`Network.webSocketCreated` 时就在网络环里放一条 `type:"WebSocket"` 的条目（长连接不会「完成」，不能等收尾才记），
 *    握手响应到来时补 `status`（101）、关闭时补 `durationMs`；帧进 per-socket 缓冲；
 *  · **SSE**：普通 `EventSource` 请求在 `responseReceived` 时就入环（响应头到了就是「已建立」），并**立刻出在途表**——
 *    否则这个永不结束的请求会让 `wait_for networkIdle` 永远等不到空闲（见 tab.mjs `#onNetwork`）；事件进 per-stream 缓冲；
 *  · 上限：每 socket / stream ≤200 帧（挤掉最旧、记 dropped）、每 tab ≤50 个连接（挤掉最旧整条）、另有每 tab 总字符预算兜底；
 *    `clear()` 与 `network clear` 同语义：连接记录与帧一起清空，清空后到达的帧（找不到连接）一律忽略，不会「复活」。
 *
 * # 脱敏（红线：出站内容过 redact-*）
 *  帧负载**入缓冲前**就先脱敏后截断（`text-redact.mjs`：`redact-text.ts` 的逐字移植，含 `Bearer xxx` / `token=…` / JWT / Cookie 头 / 键值对），
 *  再截到 4KB——缓冲区里**从来没有**明文负载；二进制帧只记长度与 opcode。server 渲染时还会再过一遍 `redactSensitiveText`（双保险）。
 *  `networkBodyRead` 开关在**读取处**判（ops/read.mjs 的 network_detail 与 HAR 导出）：关着就不输出任何负载文本。
 */
import { redactUrlSecrets, stashHeaders } from "./net-detail.mjs";
import { redactAndClip } from "./text-redact.mjs";

export const WS_FRAMES_PER_SOCKET = 200;
export const STREAMS_PER_TAB = 50;
export const STREAM_PAYLOAD_MAX = 4096;
/** 每 tab 所有连接的负载总字符预算（50 × 200 × 4KB = 40MB 的理论上限太大，超预算就从最旧连接的最旧帧开始丢） */
export const STREAM_TOTAL_PAYLOAD_BUDGET = 8 * 1024 * 1024;
/** 发起者栈最多记几帧 */
export const INITIATOR_MAX_FRAMES = 3;

const URL_LOG_MAX = 400;
const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : String(s ?? ""));

// ───────────────────────── 发起者 ─────────────────────────

const frameText = (fn, url, line, col) => {
  // 先脱敏后截断：URL 里的 ?token= / userinfo 不能因为截断点落在中间而漏掉
  const u = clip(redactUrlSecrets(String(url ?? "")) || "<inline>", 200);
  const where = Number.isInteger(line) ? `${u}:${line + 1}${Number.isInteger(col) ? `:${col + 1}` : ""}` : u;
  return `${clip(String(fn || "") || "(anonymous)", 80)} ${where}`;
};

/**
 * CDP `Network.Initiator` → `{ type, stack }`（stack ≤3 帧，每帧 `函数 url:行:列`，行列 1 起算，URL 已脱敏）。
 * 没有可显示信息（other 且无栈）返回 undefined，条目里就不带这个字段。
 * @param {any} initiator
 * @returns {{ type: string, stack: string[] } | undefined}
 */
export const formatInitiator = (initiator) => {
  if (!initiator || typeof initiator !== "object") return undefined;
  const type = typeof initiator.type === "string" ? initiator.type.replace(/[^A-Za-z]/g, "").slice(0, 20) || "other" : "other";
  const stack = [];
  const callFrames = initiator.stack?.callFrames;
  if (Array.isArray(callFrames)) {
    for (const f of callFrames) {
      if (stack.length >= INITIATOR_MAX_FRAMES) break;
      if (!f || typeof f !== "object") continue;
      stack.push(frameText(f.functionName, f.url, f.lineNumber, f.columnNumber));
    }
  }
  if (stack.length === 0 && typeof initiator.url === "string" && initiator.url !== "") {
    // parser / preload：没有调用栈，只有发起它的文档位置
    stack.push(frameText(`<${type}>`, initiator.url, initiator.lineNumber, initiator.columnNumber));
  }
  if (stack.length === 0) return undefined;
  return { type, stack };
};

// ───────────────────────── 帧 ─────────────────────────

/** base64 串解码后的字节数（不真解码，大载荷也不占内存） */
export const base64ByteLength = (b64) => {
  const s = String(b64 ?? "");
  if (s === "") return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
};

const opcodeName = (op) => ({ 0: "continuation", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong" })[op] ?? `op${op}`;
export { opcodeName };

/**
 * WebSocket 帧 → 缓冲记录：文本帧（opcode 0 / 1）先脱敏后截 4KB；二进制 / 控制帧只记长度与 opcode。
 * @param {"sent" | "received"} dir
 * @param {any} response CDP 的 `WebSocketFrame`：`{ opcode, mask, payloadData }`
 */
export const makeWsFrame = (dir, response, ts) => {
  const op = Number.isInteger(response?.opcode) ? response.opcode : 1;
  const payload = typeof response?.payloadData === "string" ? response.payloadData : "";
  if (op === 0 || op === 1) {
    const c = redactAndClip(payload, STREAM_PAYLOAD_MAX);
    return { dir, ts, opcode: op, length: payload.length, text: c.text, ...(c.truncated ? { truncated: true } : {}) };
  }
  // 二进制帧的 payloadData 是 base64；控制帧（close / ping / pong）也只给长度
  return { dir, ts, opcode: op, length: op === 2 ? base64ByteLength(payload) : payload.length, binary: true };
};

/** SSE 事件 → 缓冲记录（data 先脱敏后截断；event 名 / id 也过一遍脱敏，页面可以往里塞任何东西） */
export const makeSseEvent = (p, ts) => {
  const data = typeof p?.data === "string" ? p.data : "";
  const c = redactAndClip(data, STREAM_PAYLOAD_MAX);
  const name = typeof p?.eventName === "string" && p.eventName !== "" ? redactAndClip(p.eventName, 60).text : undefined;
  const id = typeof p?.eventId === "string" && p.eventId !== "" ? redactAndClip(p.eventId, 60).text : undefined;
  return { dir: "event", ts, length: data.length, text: c.text, ...(c.truncated ? { truncated: true } : {}), ...(name ? { event: name } : {}), ...(id ? { eventId: id } : {}) };
};

/**
 * `network_detail` 对 WebSocket / SSE 条目的结果：在通用详情（头 / 状态 / initiator …）上加一个 `frames` 块。
 * `includeText=false`（没传 include_body）只给每帧的方向 / opcode / 长度 / 相对时间，不含负载文本——正文与 include_body 同闸。
 * @param {{ base: object, entry: any, streamFrames: ReturnType<ReturnType<typeof createStreamCollector>["framesOf"]>, includeText: boolean }} p
 */
export const assembleStreamDetail = ({ base, entry, streamFrames, includeText }) => {
  const out = { ...base, ...(entry.closed ? { closed: true } : {}), ...(typeof entry.frameCount === "number" ? { frameCount: entry.frameCount } : {}) };
  if (!streamFrames) {
    out.frames = {
      items: [],
      unavailableReason: "这个连接的帧已不在缓冲里（每个标签页只保留最近 50 个连接、每个连接最近 200 帧；或已被 browser_network clear 清空）",
    };
    return out;
  }
  const t0 = typeof entry.ts === "number" ? entry.ts : 0;
  out.frames = {
    kind: streamFrames.kind,
    total: streamFrames.total,
    dropped: streamFrames.dropped,
    closed: streamFrames.closed,
    textIncluded: includeText,
    items: streamFrames.frames.map((f) => ({
      dir: f.dir,
      tMs: Math.max(0, Math.round((f.ts ?? t0) - t0)),
      length: f.length,
      ...(f.opcode !== undefined ? { opcode: f.opcode, opName: opcodeName(f.opcode) } : {}),
      ...(f.binary ? { binary: true } : {}),
      ...(f.event ? { event: f.event } : {}),
      ...(f.eventId ? { eventId: f.eventId } : {}),
      ...(includeText && typeof f.text === "string" ? { text: f.text, ...(f.truncated ? { truncated: true } : {}) } : {}),
    })),
  };
  if (!includeText) out.frames.note = "未带 include_body：只列出帧的方向 / 大小 / 时间；要看内容请加 include_body=true";
  return out;
};

// ───────────────────────── 采集器 ─────────────────────────

/**
 * 每 tab 一个。`addEntry(partial)` 由 tab 提供：把条目放进网络环并分配 id，返回 `{ entry, detail }`（环里 / 详情表里同一个对象引用，后续可改）。
 * @param {{ now?: () => number, addEntry: (partial: object) => { entry: any, detail: any },
 *           maxFrames?: number, maxStreams?: number, budget?: number }} deps
 */
export const createStreamCollector = ({ now = Date.now, addEntry, maxFrames = WS_FRAMES_PER_SOCKET, maxStreams = STREAMS_PER_TAB, budget = STREAM_TOTAL_PAYLOAD_BUDGET }) => {
  /** @type {Map<string, any>} */
  const streams = new Map();
  let totalChars = 0;
  let evicted = 0;

  const keyOf = (sessionId, requestId) => `${sessionId ?? "main"}:${requestId}`;

  const dropFrame = (s) => {
    const f = s.frames.shift();
    if (!f) return false;
    totalChars -= f.text?.length ?? 0;
    s.dropped += 1;
    return true;
  };
  const enforceBudget = () => {
    if (totalChars <= budget) return;
    for (const s of streams.values()) {
      while (totalChars > budget && dropFrame(s)) {
        /* 一直丢到预算内或这条连接没帧了 */
      }
      if (totalChars <= budget) return;
    }
  };

  const register = (key, kind, entry, detail, t0) => {
    const s = { key, kind, entry, detail, frames: [], dropped: 0, total: 0, closed: false, t0 };
    streams.set(key, s);
    while (streams.size > maxStreams) {
      const oldestKey = streams.keys().next().value;
      const old = streams.get(oldestKey);
      totalChars -= old.frames.reduce((n, f) => n + (f.text?.length ?? 0), 0);
      streams.delete(oldestKey);
      evicted += 1;
      if (old.entry) old.entry.framesEvicted = true;
    }
    return s;
  };

  const addFrame = (s, frame) => {
    s.frames.push(frame);
    s.total += 1;
    totalChars += frame.text?.length ?? 0;
    if (s.frames.length > maxFrames) dropFrame(s);
    s.entry.frameCount = s.total;
    enforceBudget();
  };

  /** 秒级单调时钟差 → 毫秒；缺 t0 时退回 wall clock */
  const elapsedMs = (s, ts) => (typeof ts === "number" && typeof s.t0 === "number" ? Math.max(0, Math.round((ts - s.t0) * 1000)) : Math.max(0, now() - (s.entry.ts ?? now())));

  return {
    /**
     * 处理一条 CDP 事件；返回 true 表示这是 WebSocket / EventSource 族事件（调用方不用再往下分发）。
     * @param {string} method
     * @param {any} p
     * @param {string | null} sessionId
     */
    handle(method, p, sessionId) {
      const requestId = p?.requestId;
      if (typeof requestId !== "string") return method.startsWith("Network.webSocket") || method === "Network.eventSourceMessageReceived";
      const key = keyOf(sessionId, requestId);
      switch (method) {
        case "Network.webSocketCreated": {
          if (streams.has(key)) return true;
          const url = String(p.url ?? "");
          const { entry, detail } = addEntry({
            ts: now(),
            method: "GET",
            url: clip(url, URL_LOG_MAX),
            status: null,
            type: "WebSocket",
            ...(formatInitiator(p.initiator) ? { initiator: formatInitiator(p.initiator) } : {}),
            __rid: requestId,
            __sid: sessionId ?? null,
            __stream: "websocket",
          });
          register(key, "websocket", entry, detail, undefined);
          return true;
        }
        case "Network.webSocketWillSendHandshakeRequest": {
          const s = streams.get(key);
          if (!s) return true;
          s.t0 = typeof p.timestamp === "number" ? p.timestamp : s.t0;
          s.detail.requestHeaders = stashHeaders(p.request?.headers);
          return true;
        }
        case "Network.webSocketHandshakeResponseReceived": {
          const s = streams.get(key);
          if (!s) return true;
          s.entry.status = Number.isInteger(p.response?.status) ? p.response.status : 101;
          s.detail.responseHeaders = stashHeaders(p.response?.headers);
          return true;
        }
        case "Network.webSocketFrameSent":
        case "Network.webSocketFrameReceived": {
          const s = streams.get(key);
          if (!s) return true;
          addFrame(s, makeWsFrame(method === "Network.webSocketFrameSent" ? "sent" : "received", p.response, now()));
          return true;
        }
        case "Network.webSocketFrameError": {
          const s = streams.get(key);
          if (!s) return true;
          s.entry.failed = true;
          s.entry.errorText = redactAndClip(String(p.errorMessage ?? "WebSocket 错误"), 200).text || "WebSocket 错误";
          return true;
        }
        case "Network.webSocketClosed": {
          const s = streams.get(key);
          if (!s) return true;
          s.closed = true;
          s.entry.closed = true;
          s.entry.durationMs = elapsedMs(s, p.timestamp);
          return true;
        }
        case "Network.eventSourceMessageReceived": {
          const s = streams.get(key);
          if (!s) return true; // clear 之后 / 已被挤出：不复活
          addFrame(s, makeSseEvent(p, now()));
          return true;
        }
        default:
          return false;
      }
    },
    /** SSE：tab 在 responseReceived 把条目入环之后调用，从此这个 requestId 的 eventSourceMessageReceived 进缓冲 */
    openSse(sessionId, requestId, entry, detail, t0) {
      const key = keyOf(sessionId, requestId);
      if (streams.has(key)) return;
      detail.stream = "sse";
      register(key, "sse", entry, detail, t0);
    },
    /** SSE 请求收尾（loadingFinished / loadingFailed）：返回 true = 这是已入环的流，调用方不用再按普通请求处理 */
    endSse(sessionId, requestId, { failed = false, errorText, timestamp } = {}) {
      const s = streams.get(keyOf(sessionId, requestId));
      if (!s || s.kind !== "sse") return false;
      s.closed = true;
      s.entry.closed = true;
      s.entry.durationMs = elapsedMs(s, timestamp);
      if (failed) {
        s.entry.failed = true;
        s.entry.errorText = errorText || "failed";
      }
      return true;
    },
    has: (sessionId, requestId) => streams.has(keyOf(sessionId, requestId)),
    /**
     * 按网络条目 id 取帧。limit 取**最近**的 N 帧（时间升序返回）。
     * @returns {{ kind: string, frames: any[], total: number, dropped: number, closed: boolean } | null} 找不到（已被挤出 / clear）返回 null
     */
    framesOf(entryId, limit = 50) {
      for (const s of streams.values()) {
        if (s.entry?.id !== entryId) continue;
        const n = Math.max(1, Math.min(maxFrames, limit));
        return { kind: s.kind, frames: s.frames.slice(-n), total: s.total, dropped: s.dropped, closed: s.closed };
      }
      return null;
    },
    /** 所有连接（HAR 导出用）：只读视图 */
    all: () => [...streams.values()].map((s) => ({ kind: s.kind, entry: s.entry, frames: s.frames.slice(), dropped: s.dropped, total: s.total })),
    clear() {
      streams.clear();
      totalChars = 0;
    },
    size: () => streams.size,
    stats: () => ({ streams: streams.size, evicted, totalChars }),
  };
};
