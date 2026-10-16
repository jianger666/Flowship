/**
 * K3-10：PUT /api/settings 失败时要把 HTTP 状态码带出来，让 400 这类「重试永远不会成功」的失败不再被退避重试 3 次。
 *
 * 之前的缺陷：local-store.putSettings 只 `throw new Error(message)`、saveSettings 只返回布尔，状态码在这一层就丢了，
 * 设置页对 400（校验被拒）也提示「将自动重试」并排 2s / 8s / 30s 三次重试。
 *
 * 真实 local-store + 桩 fetch + 真实 save-retry（假定时器）。fetch 桩只按状态码返回，不涉及任何凭据。
 * 注意：use-settings 是 React hook、没有 DOM 环境没法渲染——这里的 `hookLikeSave` 照它 saveFieldValue 的接线手写了一份
 * （first / retry 走 saveSettingsDetailed、失败分流给 onFailed / onRejected），验证的是这条链的行为，不是 hook 本体。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
};

import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  saveSettingsDetailed,
} from "@/lib/local-store";
import { createSaveRetrier, saveWithRetry } from "@/lib/save-retry";

const json = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type PutOutcome = Response | "network-error";
let putQueue: PutOutcome[] = [];
let putCount = 0;

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (String(url).includes("/api/settings/full") && method === "GET") {
      return json(200, { exists: true, settings: DEFAULT_SETTINGS });
    }
    putCount += 1;
    const next = putQueue.shift() ?? json(200, { ok: true, settings: {} });
    if (next === "network-error") throw new TypeError("fetch failed");
    return next;
  });
});

beforeEach(() => {
  putQueue = [];
  putCount = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NEXT = { ...DEFAULT_SETTINGS, apiKey: "k-fake" };

describe("saveSettingsDetailed：失败带 HTTP 状态码，成功 / 网络错误没有", () => {
  it.each([
    [400, { error: "配置不完整：repos 缺失或类型不对" }],
    [403, { error: "forbidden" }],
    [500, { error: "保存配置失败" }],
    [503, { error: "busy" }],
  ])("服务端 %i（JSON 错误体）→ { ok: false, status }", async (status, body) => {
    putQueue = [json(status, body)];
    expect(await saveSettingsDetailed(NEXT)).toEqual({ ok: false, status });
  });

  it("错误体不是 JSON（HTML 之类）也带状态码", async () => {
    putQueue = [json(400, "<html>bad request</html>")];
    expect(await saveSettingsDetailed(NEXT)).toEqual({ ok: false, status: 400 });
  });

  it("成功 → { ok: true }；网络错误（fetch 抛）→ { ok: false } 且没有 status", async () => {
    putQueue = [json(200, { ok: true, settings: {} })];
    expect(await saveSettingsDetailed(NEXT)).toEqual({ ok: true });
    putQueue = ["network-error"];
    const res = await saveSettingsDetailed(NEXT);
    expect(res.ok).toBe(false);
    expect(res.status).toBeUndefined();
  });

  it("失败仍回滚乐观 cache（与 saveSettings 同口径）", async () => {
    putQueue = [json(200, { ok: true, settings: {} })];
    await saveSettingsDetailed({ ...DEFAULT_SETTINGS, apiKey: "已落盘" });
    expect(getSettings().apiKey).toBe("已落盘");
    putQueue = [json(400, { error: "bad" })];
    await saveSettingsDetailed({ ...DEFAULT_SETTINGS, apiKey: "被拒绝" });
    expect(getSettings().apiKey).toBe("已落盘");
  });

  it("saveSettings 仍返回布尔（其余 6 个调用方不用改）：成功 true、400 / 500 / 网络错误都是 false", async () => {
    putQueue = [json(200, { ok: true, settings: {} })];
    expect(await saveSettings(NEXT)).toBe(true);
    putQueue = [json(400, { error: "bad" })];
    expect(await saveSettings(NEXT)).toBe(false);
    putQueue = [json(500, { error: "bad" })];
    expect(await saveSettings(NEXT)).toBe(false);
    putQueue = ["network-error"];
    expect(await saveSettings(NEXT)).toBe(false);
  });
});

describe("端到端（真实 local-store → saveWithRetry → 真实退避，假定时器）：PUT 实际发了几次", () => {
  // 照 use-settings.saveFieldValue 的接线
  const hookLikeSave = (retrier: ReturnType<typeof createSaveRetrier>, handlers: {
    onFailed: () => void;
    onRejected: (status: number) => void;
  }) => {
    const key = "repos";
    return saveWithRetry({
      retrier,
      key,
      first: () => saveSettingsDetailed(NEXT),
      retry: () => saveSettingsDetailed(NEXT),
      onFailed: handlers.onFailed,
      onRejected: handlers.onRejected,
    });
  };

  const setup = () => {
    vi.useFakeTimers();
    const onGiveUp = vi.fn();
    const onRejectedByRetrier = vi.fn();
    const onRecovered = vi.fn();
    const retrier = createSaveRetrier({ onGiveUp, onRejected: onRejectedByRetrier, onRecovered });
    const onFailed = vi.fn();
    const onRejected = vi.fn();
    return { retrier, onGiveUp, onRejectedByRetrier, onRecovered, onFailed, onRejected };
  };

  it("服务端一直回 400：只发 1 次 PUT，过完默认退避（2s / 8s / 30s）也不再发；不提示「将自动重试」", async () => {
    const s = setup();
    putQueue = [json(400, { error: "配置不完整" }), json(400, { error: "配置不完整" }), json(400, { error: "配置不完整" }), json(400, { error: "配置不完整" })];
    const ok = await hookLikeSave(s.retrier, s);
    expect(ok).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCount).toBe(1);
    expect(s.onFailed).not.toHaveBeenCalled();
    expect(s.onRejected).toHaveBeenCalledWith(400);
    expect(s.onGiveUp).not.toHaveBeenCalled();
    expect(s.retrier.pendingCount()).toBe(0);
  });

  it("服务端一直回 500：首发 + 3 次退避重试共 4 次 PUT，提示「将自动重试」一次，用尽后 onGiveUp", async () => {
    const s = setup();
    putQueue = [500, 500, 500, 500].map(() => json(500, { error: "磁盘只读" }));
    await hookLikeSave(s.retrier, s);
    expect(putCount).toBe(1);
    expect(s.onFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(putCount).toBe(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(putCount).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(putCount).toBe(4);
    expect(s.onGiveUp).toHaveBeenCalledTimes(1);
    expect(s.onRejected).not.toHaveBeenCalled();
    expect(s.retrier.pendingCount()).toBe(0);
  });

  it("网络错误同样照旧重试：首发失败后 2s 重发，成功即恢复", async () => {
    const s = setup();
    putQueue = ["network-error", json(200, { ok: true, settings: {} })];
    await hookLikeSave(s.retrier, s);
    expect(s.onFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(putCount).toBe(2);
    expect(s.onRecovered).toHaveBeenCalledTimes(1);
  });

  it("首发 500、重试时被 400 拒绝：第二次 PUT 之后不再发，走 onRejected（而不是「多次重试仍未能保存」）", async () => {
    const s = setup();
    putQueue = [json(500, { error: "busy" }), json(400, { error: "配置不完整" }), json(200, { ok: true, settings: {} })];
    await hookLikeSave(s.retrier, s);
    expect(s.onFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putCount).toBe(2);
    expect(s.onRejectedByRetrier).toHaveBeenCalledWith("repos", 400);
    expect(s.onGiveUp).not.toHaveBeenCalled();
  });
});
