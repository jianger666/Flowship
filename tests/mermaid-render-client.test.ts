/**
 * Mermaid 渲染 IPC 客户端（src/lib/server/mermaid-render.ts）：协议、超时、不支持判定、取消、断线。
 * 假传输（不碰真 process.send）；与主进程服务端的联调见 tests/mermaid-render-main.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeTransport } from "@/lib/server/browser/bridge";
import {
  ACK_TIMEOUT_MS,
  DEFAULT_RENDER_TIMEOUT_MS,
  MAX_PNG_BYTES,
  MermaidRenderError,
  UNSUPPORTED_TTL_MS,
  __setMermaidRenderClientForTest,
  createMermaidRenderClient,
  getMermaidRenderClient,
  isMermaidRenderAvailable,
  renderMermaidPng,
} from "@/lib/server/mermaid-render";

interface Sent {
  v?: number;
  kind?: string;
  id?: number;
  source?: string;
}

const makeTransport = () => {
  const msgHandlers = new Set<(m: unknown) => void>();
  const discHandlers = new Set<() => void>();
  const sent: Sent[] = [];
  const state = { open: true, sendOk: true };
  const transport: BridgeTransport = {
    send: (msg) => {
      if (!state.open || !state.sendOk) return false;
      sent.push(msg as Sent);
      return true;
    },
    onMessage: (cb) => {
      msgHandlers.add(cb);
      return () => msgHandlers.delete(cb);
    },
    onDisconnect: (cb) => {
      discHandlers.add(cb);
      return () => discHandlers.delete(cb);
    },
    isOpen: () => state.open,
  };
  return {
    transport,
    sent,
    state,
    emit: (m: unknown) => [...msgHandlers].forEach((h) => h(m)),
    disconnect: () => {
      state.open = false;
      [...discHandlers].forEach((h) => h());
    },
    handlerCount: () => msgHandlers.size,
  };
};

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const reqs = (sent: Sent[]) => sent.filter((m) => m.kind === "mermaid-render-req");
const cancels = (sent: Sent[]) => sent.filter((m) => m.kind === "mermaid-render-cancel");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  __setMermaidRenderClientForTest(null);
});

describe("createMermaidRenderClient：请求 / 响应", () => {
  it("发出 v:1 的 req 报文，ack + res(ok) → 拿到 PNG 与尺寸", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p = client.render("graph TD; A-->B");
    expect(reqs(t.sent)).toEqual([{ v: 1, kind: "mermaid-render-req", id: 1, source: "graph TD; A-->B" }]);
    t.emit({ v: 1, kind: "mermaid-render-ack", id: 1 });
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: PNG_B64, width: 223, height: 502 });
    const out = await p;
    expect(out.png.toString()).toBe("fake-png-bytes");
    expect(out.width).toBe(223);
    expect(out.height).toBe(502);
  });

  it("id 递增；并发请求各自对应各自的结果（乱序返回也不串）", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    const p2 = client.render("b");
    expect(reqs(t.sent).map((m) => m.id)).toEqual([1, 2]);
    t.emit({ v: 1, kind: "mermaid-render-res", id: 2, ok: true, png: Buffer.from("two").toString("base64"), width: 1, height: 1 });
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: Buffer.from("one").toString("base64"), width: 1, height: 1 });
    expect((await p1).png.toString()).toBe("one");
    expect((await p2).png.toString()).toBe("two");
  });

  it("主进程回错误：已知 code 原样保留，未知 code 归为 RENDER_FAILED，缺 message 给默认文案", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: false, error: { code: "TOO_LARGE", message: "图太大" } });
    await expect(p1).rejects.toMatchObject({ name: "MermaidRenderError", code: "TOO_LARGE", message: "图太大" });

    const p2 = client.render("b");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 2, ok: false, error: { code: "WHATEVER", message: "x" } });
    await expect(p2).rejects.toMatchObject({ code: "RENDER_FAILED" });

    const p3 = client.render("c");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 3, ok: false });
    await expect(p3).rejects.toMatchObject({ code: "RENDER_FAILED", message: "Mermaid 渲染失败" });
  });

  it("PNG 为空 / 超过体积上限 → 拒绝", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: "", width: 1, height: 1 });
    await expect(p1).rejects.toMatchObject({ code: "RENDER_FAILED" });

    const p2 = client.render("b");
    const huge = "A".repeat(Math.ceil((MAX_PNG_BYTES * 4) / 3) + 100);
    t.emit({ v: 1, kind: "mermaid-render-res", id: 2, ok: true, png: huge, width: 1, height: 1 });
    await expect(p2).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("忽略不属于本协议 / 版本不对 / id 对不上的消息", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p = client.render("a");
    t.emit(null);
    t.emit("str");
    t.emit({ v: 2, kind: "mermaid-render-res", id: 1, ok: true, png: PNG_B64 });
    t.emit({ v: 1, kind: "res", id: 1, ok: true, result: {} }); // 浏览器协议的 res
    t.emit({ v: 1, kind: "mermaid-render-res", id: 99, ok: true, png: PNG_B64 });
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: PNG_B64, width: 1, height: 1 });
    await expect(p).resolves.toBeTruthy();
  });
});

describe("超时 / 不支持 / 取消 / 断线", () => {
  it("结果超时 → TIMEOUT，并通知主进程取消", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p = client.render("a", { timeoutMs: 5000 });
    p.catch(() => {});
    t.emit({ v: 1, kind: "mermaid-render-ack", id: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(cancels(t.sent)).toEqual([{ v: 1, kind: "mermaid-render-cancel", id: 1 }]);
  });

  it("缺省总超时 = DEFAULT_RENDER_TIMEOUT_MS", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p = client.render("a");
    p.catch(() => {});
    t.emit({ v: 1, kind: "mermaid-render-ack", id: 1 });
    await vi.advanceTimersByTimeAsync(DEFAULT_RENDER_TIMEOUT_MS - 1);
    expect(cancels(t.sent)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("一次 ack 都没见过且超时未回 → UNSUPPORTED，并在 TTL 内标记不可用（不再白等）", async () => {
    let now = 1_000_000;
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport, { now: () => now });
    expect(client.isAvailable()).toBe(true);
    const p = client.render("a");
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(cancels(t.sent)).toHaveLength(1);
    expect(client.isAvailable()).toBe(false);
    // TTL 内：立刻拒绝，不发请求
    const before = reqs(t.sent).length;
    await expect(client.render("b")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(reqs(t.sent)).toHaveLength(before);
    // TTL 过后恢复尝试
    now += UNSUPPORTED_TTL_MS;
    expect(client.isAvailable()).toBe(true);
  });

  it("收到过 ack 之后：再没 ack 只算普通超时，不会误判成「不支持」", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    t.emit({ v: 1, kind: "mermaid-render-ack", id: 1 });
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: PNG_B64, width: 1, height: 1 });
    await p1;
    const p2 = client.render("b", { timeoutMs: 10_000 });
    p2.catch(() => {});
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1000); // 超过 ack 窗口，但不该判不支持
    expect(client.isAvailable()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p2).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(client.isAvailable()).toBe(true);
  });

  it("只收到 res（没收到 ack）也算见过主进程：之后不判不支持", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: PNG_B64, width: 1, height: 1 });
    await p1;
    const p2 = client.render("b", { timeoutMs: 20_000 });
    p2.catch(() => {});
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
    expect(client.isAvailable()).toBe(true);
    t.emit({ v: 1, kind: "mermaid-render-res", id: 2, ok: true, png: PNG_B64, width: 1, height: 1 });
    await expect(p2).resolves.toBeTruthy();
  });

  it("AbortSignal：中止 → CANCELLED + 通知主进程；一开始就已中止 → 不发请求", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const ac = new AbortController();
    const p = client.render("a", { signal: ac.signal });
    p.catch(() => {});
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    expect(cancels(t.sent)).toHaveLength(1);

    const ac2 = new AbortController();
    ac2.abort();
    const before = t.sent.length;
    await expect(client.render("b", { signal: ac2.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(t.sent).toHaveLength(before);
  });

  it("结束后不残留定时器（成功 / 失败 / 取消）", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, png: PNG_B64, width: 1, height: 1 });
    await p1;
    const p2 = client.render("b");
    t.emit({ v: 1, kind: "mermaid-render-res", id: 2, ok: false, error: { code: "RENDER_FAILED", message: "x" } });
    await p2.catch(() => {});
    const ac = new AbortController();
    const p3 = client.render("c", { signal: ac.signal });
    p3.catch(() => {});
    ac.abort();
    await p3.catch(() => {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("通道断开：挂起请求全部以 UNAVAILABLE 拒绝，之后不可用", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p1 = client.render("a");
    const p2 = client.render("b");
    t.disconnect();
    await expect(p1).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(p2).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(client.isAvailable()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("通道不可用 / 发送失败 → UNAVAILABLE，不留挂起请求", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    t.state.sendOk = false;
    await expect(client.render("a")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(vi.getTimerCount()).toBe(0);
    t.state.open = false;
    await expect(client.render("b")).rejects.toBeInstanceOf(MermaidRenderError);
  });

  it("dispose：拆监听、挂起请求以 CANCELLED 拒绝、之后不可用", async () => {
    const t = makeTransport();
    const client = createMermaidRenderClient(t.transport);
    const p = client.render("a");
    expect(t.handlerCount()).toBe(1);
    client.dispose();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    expect(t.handlerCount()).toBe(0);
    expect(client.isAvailable()).toBe(false);
  });
});

describe("全局单例（vitest 下没有真通道）", () => {
  it("没有 IPC 通道（单测 / web 模式）→ 客户端为 null、不可用、render 以 UNAVAILABLE 拒绝", async () => {
    expect(getMermaidRenderClient()).toBeNull();
    expect(isMermaidRenderAvailable()).toBe(false);
    await expect(renderMermaidPng("graph TD; A-->B")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("可注入假客户端（测试钩子）", async () => {
    const fake = {
      isAvailable: () => true,
      render: vi.fn(async () => ({ png: Buffer.from("x"), width: 1, height: 1 })),
      dispose: () => {},
    };
    __setMermaidRenderClientForTest(fake);
    expect(isMermaidRenderAvailable()).toBe(true);
    const out = await renderMermaidPng("graph TD; A-->B", { timeoutMs: 1234 });
    expect(out.png.toString()).toBe("x");
    expect(fake.render).toHaveBeenCalledWith("graph TD; A-->B", { timeoutMs: 1234 });
    __setMermaidRenderClientForTest(null);
    expect(isMermaidRenderAvailable()).toBe(false);
  });
});
