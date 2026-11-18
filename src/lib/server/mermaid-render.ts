/**
 * Mermaid → PNG 渲染客户端（server 侧）。真正的渲染在桌面壳主进程里（隐藏窗口 + 渲染页，见 electron-app/mermaid-render.mjs）：
 * Mermaid 要真实 DOM（getBBox / foreignObject），server 里没有无头浏览器，所以走与内置浏览器同一条父子进程 IPC。
 *
 * # 协议（`v: 1`，与 docs/BROWSER-AUTOMATION.md 的浏览器协议**互不相干**，只是共用同一条 Node IPC 通道）
 *   server → 主进程  `{ v:1, kind:"mermaid-render-req", id, source }` / `{ v:1, kind:"mermaid-render-cancel", id }`
 *   主进程 → server  `{ v:1, kind:"mermaid-render-ack", id }`（收到请求立刻回，用来区分「主进程不认识这个协议」与「在渲染」）
 *                    `{ v:1, kind:"mermaid-render-res", id, ok:true, png:<base64>, width, height }`
 *                    `{ v:1, kind:"mermaid-render-res", id, ok:false, error:{ code, message } }`
 * 浏览器通道（bridge.ts / server-channel.mjs）对未知 kind 本来就是忽略，所以新旧两端互不影响。
 *
 * # 可用性
 * 没有 IPC 通道（`pnpm dev:web` / `pnpm start` / 纯 headless / 单测）= 不可用，调用方当作「没有渲染能力」、保持原样。
 * 有通道但主进程是旧版（不回 ack）：首个请求 {@link ACK_TIMEOUT_MS} 内没 ack → 标记不支持 {@link UNSUPPORTED_TTL_MS}，期间不再尝试
 * （免得每条回复都白等）；只要收到过一次 ack，之后的超时都只算普通超时、不会误判成不支持。
 *
 * 本文件只依赖 bridge.ts 的进程传输（与浏览器 bridge 共用同一个 `process.on('message')` 监听，不叠监听），不拖重模块。
 */

import { canUseProcessChannel, getProcessTransport, type BridgeTransport } from "./browser/bridge";

/** 收到请求后主进程必须在这个时间内回 ack（只是「收到」，不含渲染）；没回 = 旧版壳 / 通道没挂上 */
export const ACK_TIMEOUT_MS = 3000;
/** 判定「不支持」后多久内不再尝试 */
export const UNSUPPORTED_TTL_MS = 2 * 60_000;
/** 单次渲染（含排队、窗口冷启动、页面加载）的默认总上限 */
export const DEFAULT_RENDER_TIMEOUT_MS = 25_000;
/** 返回的 PNG 体积上限（飞书图片上限 10MB，留余量；主进程也限了一道，这里是对端异常时的兜底） */
export const MAX_PNG_BYTES = 8 * 1024 * 1024;

export type MermaidRenderErrorCode =
  | "UNAVAILABLE" // 没有 IPC 通道 / 通道已断
  | "UNSUPPORTED" // 主进程没回 ack（旧版壳）
  | "TIMEOUT"
  | "CANCELLED"
  | "TOO_LARGE" // 图太大（主进程判的，或 PNG 超上限）
  | "RENDER_FAILED"; // Mermaid 语法错误 / 渲染页报错 / 窗口加载失败等

export class MermaidRenderError extends Error {
  readonly code: MermaidRenderErrorCode;
  constructor(code: MermaidRenderErrorCode, message: string) {
    super(message);
    this.name = "MermaidRenderError";
    this.code = code;
  }
}

export interface MermaidPng {
  png: Buffer;
  /** 图的 CSS 像素宽高（PNG 实际像素 = 乘以设备缩放，一般 2 倍） */
  width: number;
  height: number;
}

export interface MermaidRenderOptions {
  /** 总超时；缺省 {@link DEFAULT_RENDER_TIMEOUT_MS} */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MermaidRenderClient {
  isAvailable: () => boolean;
  render: (source: string, opts?: MermaidRenderOptions) => Promise<MermaidPng>;
  /** 拆监听 / 定时器，挂起请求全部拒绝（测试用；生产不调） */
  dispose: () => void;
}

export interface CreateMermaidRenderClientOptions {
  ackTimeoutMs?: number;
  unsupportedTtlMs?: number;
  now?: () => number;
}

interface Pending {
  resolve: (v: MermaidPng) => void;
  reject: (e: MermaidRenderError) => void;
  ackTimer: ReturnType<typeof setTimeout> | null;
  resTimer: ReturnType<typeof setTimeout>;
  offAbort: (() => void) | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const KNOWN_CODES: ReadonlySet<string> = new Set<MermaidRenderErrorCode>([
  "UNAVAILABLE",
  "UNSUPPORTED",
  "TIMEOUT",
  "CANCELLED",
  "TOO_LARGE",
  "RENDER_FAILED",
]);

export const createMermaidRenderClient = (
  transport: BridgeTransport,
  options: CreateMermaidRenderClientOptions = {},
): MermaidRenderClient => {
  const ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const unsupportedTtlMs = options.unsupportedTtlMs ?? UNSUPPORTED_TTL_MS;
  const now = options.now ?? Date.now;

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let everAcked = false;
  let unsupportedUntil = 0;
  let disposed = false;

  const settle = (id: number, fn: (p: Pending) => void): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.ackTimer) clearTimeout(p.ackTimer);
    clearTimeout(p.resTimer);
    p.offAbort?.();
    fn(p);
  };

  const sendCancel = (id: number): void => {
    try {
      transport.send({ v: 1, kind: "mermaid-render-cancel", id });
    } catch {
      /* best-effort */
    }
  };

  const handleMessage = (raw: unknown): void => {
    if (disposed || !isRecord(raw) || raw.v !== 1) return;
    const id = typeof raw.id === "number" ? raw.id : -1;
    if (!pending.has(id)) return;
    if (raw.kind === "mermaid-render-ack") {
      everAcked = true;
      const p = pending.get(id)!;
      if (p.ackTimer) {
        clearTimeout(p.ackTimer);
        p.ackTimer = null;
      }
      return;
    }
    if (raw.kind !== "mermaid-render-res") return;
    everAcked = true;
    if (raw.ok === true) {
      const b64 = typeof raw.png === "string" ? raw.png : "";
      const width = typeof raw.width === "number" ? raw.width : 0;
      const height = typeof raw.height === "number" ? raw.height : 0;
      // base64 长度 × 3/4 ≈ 字节数；先按长度判，免得为一个超限的巨串去分配 Buffer
      if (b64.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 8) {
        settle(id, (p) => p.reject(new MermaidRenderError("TOO_LARGE", "渲染出的图片超过体积上限")));
        return;
      }
      const png = Buffer.from(b64, "base64");
      if (png.length === 0) {
        settle(id, (p) => p.reject(new MermaidRenderError("RENDER_FAILED", "渲染结果为空")));
        return;
      }
      settle(id, (p) => p.resolve({ png, width, height }));
      return;
    }
    const e = isRecord(raw.error) ? raw.error : {};
    const code = typeof e.code === "string" && KNOWN_CODES.has(e.code) ? (e.code as MermaidRenderErrorCode) : "RENDER_FAILED";
    const message = typeof e.message === "string" && e.message ? e.message : "Mermaid 渲染失败";
    settle(id, (p) => p.reject(new MermaidRenderError(code, message)));
  };

  const offMessage = transport.onMessage(handleMessage);
  const offDisconnect = transport.onDisconnect(() => {
    for (const id of [...pending.keys()]) {
      settle(id, (p) => p.reject(new MermaidRenderError("UNAVAILABLE", "与桌面壳的连接已断开")));
    }
  });

  const isAvailable = (): boolean => !disposed && transport.isOpen() && now() >= unsupportedUntil;

  const render: MermaidRenderClient["render"] = (source, opts = {}) => {
    if (!isAvailable()) {
      return Promise.reject(new MermaidRenderError("UNAVAILABLE", "当前运行方式没有 Mermaid 渲染能力"));
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new MermaidRenderError("CANCELLED", "渲染已取消"));
    }
    const id = nextId++;
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_RENDER_TIMEOUT_MS;
    return new Promise<MermaidPng>((resolve, reject) => {
      const resTimer = setTimeout(() => {
        settle(id, (p) => p.reject(new MermaidRenderError("TIMEOUT", `Mermaid 渲染超时（${Math.round(timeoutMs / 1000)}s）`)));
        sendCancel(id);
      }, timeoutMs);
      const ackTimer = everAcked
        ? null
        : setTimeout(() => {
            // 一次 ack 都没见过：主进程不认识这个协议（旧版壳）或通道没挂上。记一笔，近期不再尝试
            unsupportedUntil = now() + unsupportedTtlMs;
            settle(id, (p) => p.reject(new MermaidRenderError("UNSUPPORTED", "桌面壳不支持 Mermaid 渲染")));
            sendCancel(id);
          }, ackTimeoutMs);
      let offAbort: (() => void) | null = null;
      if (opts.signal) {
        const onAbort = (): void => {
          settle(id, (p) => p.reject(new MermaidRenderError("CANCELLED", "渲染已取消")));
          sendCancel(id);
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        offAbort = () => opts.signal?.removeEventListener("abort", onAbort);
      }
      pending.set(id, { resolve, reject, ackTimer, resTimer, offAbort });
      const sent = transport.send({ v: 1, kind: "mermaid-render-req", id, source }, () => {
        settle(id, (p) => p.reject(new MermaidRenderError("UNAVAILABLE", "发送渲染请求失败")));
      });
      if (!sent) settle(id, (p) => p.reject(new MermaidRenderError("UNAVAILABLE", "与桌面壳的连接不可用")));
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    offMessage();
    offDisconnect();
    for (const id of [...pending.keys()]) {
      settle(id, (p) => p.reject(new MermaidRenderError("CANCELLED", "渲染客户端已关闭")));
    }
  };

  return { isAvailable, render, dispose };
};

// ----------------- 全局单例 -----------------

const CLIENT_KEY = "__flowshipMermaidRenderClientV1__";

interface ClientHolder {
  client: MermaidRenderClient | null;
  /** 测试注入的客户端优先于真实通道 */
  override: MermaidRenderClient | null;
}

const holder = (): ClientHolder => {
  const g = globalThis as unknown as Record<string, ClientHolder | undefined>;
  if (!g[CLIENT_KEY]) g[CLIENT_KEY] = { client: null, override: null };
  return g[CLIENT_KEY]!;
};

/** 取全局客户端（懒创建）。没有 IPC 通道（web 模式 / 单测 / 构建阶段）返回 null */
export const getMermaidRenderClient = (): MermaidRenderClient | null => {
  const h = holder();
  if (h.override) return h.override;
  if (h.client) return h.client;
  if (!canUseProcessChannel()) return null;
  h.client = createMermaidRenderClient(getProcessTransport());
  return h.client;
};

/** 此刻能不能渲染（同步、便宜；调用方用它决定要不要走渲染这一步） */
export const isMermaidRenderAvailable = (): boolean => getMermaidRenderClient()?.isAvailable() ?? false;

export const renderMermaidPng = (source: string, opts?: MermaidRenderOptions): Promise<MermaidPng> => {
  const c = getMermaidRenderClient();
  if (!c) return Promise.reject(new MermaidRenderError("UNAVAILABLE", "当前运行方式没有 Mermaid 渲染能力"));
  return c.render(source, opts);
};

/** 仅测试：注入 / 清除假客户端 */
export const __setMermaidRenderClientForTest = (c: MermaidRenderClient | null): void => {
  holder().override = c;
};
