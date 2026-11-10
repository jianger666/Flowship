/**
 * 浏览器 bridge 测试替身：真 createBrowserBridge + 假传输层，主进程那头由 `handlers` 脚本化应答。
 * 这样 tools / activity / handback 的测试走的是**真实的请求配对 / 超时 / 取消逻辑**，只是没有 Electron。
 */
import {
  __setBrowserBridgeForTest,
  createBrowserBridge,
  type BrowserBridge,
  type BridgeTransport,
} from "@/lib/server/browser/bridge";
import type { BrowserErrorCode } from "@/lib/server/browser/types";

export type OpHandler = (args: Record<string, unknown>, taskId: string) => unknown | Promise<unknown>;

/** 让某个 op 返回协议里的错误 */
export class OpError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message = "",
  ) {
    super(message);
  }
}

/** 永不应答（模拟 ask_user_to_act / wait_for 挂起） */
export const NEVER = Symbol("never-respond");

export interface FakeBrowser {
  bridge: BrowserBridge;
  /** 发给主进程的全部 req（按顺序） */
  calls: Array<{ op: string; args: Record<string, unknown>; taskId: string }>;
  /** 发给主进程的非 req 消息（cancel / config / hello） */
  other: Array<Record<string, unknown>>;
  /** 主进程主动发 evt */
  emitEvent: (name: string, taskId: string, data?: Record<string, unknown>) => void;
  handlers: Record<string, OpHandler>;
  cleanup: () => void;
}

export const installFakeBrowser = (handlers: Record<string, OpHandler> = {}): FakeBrowser => {
  const msgSubs = new Set<(m: unknown) => void>();
  const calls: FakeBrowser["calls"] = [];
  const other: FakeBrowser["other"] = [];
  const fake = { handlers } as FakeBrowser;

  const transport: BridgeTransport = {
    send: (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.kind !== "req") {
        other.push(m);
        return true;
      }
      const op = String(m.op);
      const args = (m.args ?? {}) as Record<string, unknown>;
      const taskId = String(m.taskId);
      calls.push({ op, args, taskId });
      void (async () => {
        const h = fake.handlers[op];
        try {
          const result = h ? await h(args, taskId) : undefined;
          if (result === NEVER) return;
          queueMicrotask(() => msgSubs.forEach((cb) => cb({ v: 1, kind: "res", id: m.id, ok: true, result })));
        } catch (err) {
          const code = err instanceof OpError ? err.code : "INTERNAL";
          queueMicrotask(() =>
            msgSubs.forEach((cb) =>
              cb({
                v: 1,
                kind: "res",
                id: m.id,
                ok: false,
                error: { code, message: err instanceof Error ? err.message : String(err) },
              }),
            ),
          );
        }
      })();
      return true;
    },
    onMessage: (cb) => {
      msgSubs.add(cb);
      return () => msgSubs.delete(cb);
    },
    onDisconnect: () => () => {},
    isOpen: () => true,
  };

  const bridge = createBrowserBridge(transport);
  bridge.start();
  msgSubs.forEach((cb) => cb({ v: 1, kind: "hello-ack", capabilities: ["browser.v1"] }));
  __setBrowserBridgeForTest(bridge);

  fake.bridge = bridge;
  fake.calls = calls;
  fake.other = other;
  fake.emitEvent = (name, taskId, data = {}) =>
    msgSubs.forEach((cb) => cb({ v: 1, kind: "evt", name, taskId, data }));
  fake.cleanup = () => {
    bridge.dispose();
    __setBrowserBridgeForTest(null);
  };
  return fake;
};

/** 一条用户活动条目 */
export const userEntry = (id: number, summary: string, extra: Record<string, unknown> = {}) => ({
  id,
  ts: 1_700_000_000_000 + id * 1000,
  actor: "user" as const,
  kind: "click",
  tabId: "t1",
  url: "https://a.test/",
  summary,
  ...extra,
});
