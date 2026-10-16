/**
 * 设置保存失败后的自动重试（S13-03）：退避、作废、用尽放弃、卸载补跑
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaveRetrier, saveWithRetry } from "@/lib/save-retry";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSaveRetrier", () => {
  it("失败后按退避间隔重试、成功即停并通知 onRecovered", async () => {
    const onRecovered = vi.fn();
    const r = createSaveRetrier({ delaysMs: [100, 200, 300], onRecovered });
    const attempt = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    r.schedule("repos", attempt);

    await vi.advanceTimersByTimeAsync(99);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1); // 第一次重试：仍失败
    await vi.advanceTimersByTimeAsync(200);
    expect(attempt).toHaveBeenCalledTimes(2); // 第二次：成功
    expect(onRecovered).toHaveBeenCalledWith("repos");
    expect(r.pendingCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(2); // 成功后不再跑
  });

  it("次数用尽仍失败 → onGiveUp、不再重试", async () => {
    const onGiveUp = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10, 10], onGiveUp });
    const attempt = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    r.schedule("apiKey", attempt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledWith("apiKey");
    expect(r.pendingCount()).toBe(0);
  });

  it("同字段有新保存（cancel / 重新 schedule）→ 旧重试作废、不会用旧值覆盖新值", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const stale = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    r.schedule("repos", stale);
    r.cancel("repos");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();

    const old = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const fresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    r.schedule("repos", old);
    r.schedule("repos", fresh); // 替换
    await vi.advanceTimersByTimeAsync(1_000);
    expect(old).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("不同字段互不影响", async () => {
    const r = createSaveRetrier({ delaysMs: [50] });
    const a = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const b = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    r.schedule("apiKey", a);
    r.schedule("repos", b);
    r.cancel("apiKey");
    await vi.advanceTimersByTimeAsync(100);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("flush（卸载）→ 待重试立刻各补跑一次并清空", async () => {
    const r = createSaveRetrier({ delaysMs: [60_000] });
    const a = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    r.schedule("repos", a);
    r.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("attempt 抛错按失败处理、不会炸出未捕获异常", async () => {
    const onGiveUp = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10], onGiveUp });
    r.schedule("repos", () => Promise.reject(new Error("boom")));
    await vi.advanceTimersByTimeAsync(100);
    expect(onGiveUp).toHaveBeenCalledWith("repos");
  });
});

/** 手动控制完成时机的保存（模拟「PUT 还在路上」） */
const deferredSave = () => {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("createSaveRetrier：世代 / dropPending", () => {
  it("cancel 使该字段世代 +1；dropPending / schedule 不动世代；不同字段互相独立", () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    expect(r.generation("repos")).toBe(0);
    r.schedule("repos", async () => true);
    expect(r.generation("repos")).toBe(0);
    r.dropPending("repos");
    expect(r.generation("repos")).toBe(0);
    r.cancel("repos");
    expect(r.generation("repos")).toBe(1);
    r.cancel("repos");
    expect(r.generation("repos")).toBe(2);
    expect(r.generation("apiKey")).toBe(0);
  });

  it("dropPending 丢掉待重试（定时器也清掉）、不影响其它字段", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const a = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const b = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    r.schedule("apiKey", a);
    r.schedule("repos", b);
    r.dropPending("apiKey");
    expect(r.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("saveWithRetry：旧保存晚失败不会排出过期重试", () => {
  it("正常失败：onFailed 一次 → 退避后跑 retry、成功即停", async () => {
    const r = createSaveRetrier({ delaysMs: [100, 200] });
    const first = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const retry = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const onFailed = vi.fn();
    const ok = await saveWithRetry({ retrier: r, key: "repos", first, retry, onFailed });
    expect(ok).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(r.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(r.pendingCount()).toBe(0);
  });

  it("成功：不 onFailed、不登记重试", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const onFailed = vi.fn();
    const ok = await saveWithRetry({
      retrier: r,
      key: "repos",
      first: async () => true,
      retry: async () => true,
      onFailed,
    });
    expect(ok).toBe(true);
    expect(onFailed).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
  });

  it("V1 还在路上时同字段又发起 V2：V1 晚失败 → 不 toast、不排 V1 的重试（否则 2s 后 V1 覆盖 V2）", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const v1 = deferredSave();
    const retryV1 = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const onFailedV1 = vi.fn();
    const p1 = saveWithRetry({
      retrier: r,
      key: "repos",
      first: () => v1.promise,
      retry: retryV1,
      onFailed: onFailedV1,
    });

    // 用户在 V1 返回前又改了同字段、发起 V2（V2 自己成功）
    const p2 = saveWithRetry({
      retrier: r,
      key: "repos",
      first: async () => true,
      retry: async () => true,
    });
    await p2;

    v1.resolve(false); // V1 的 PUT 这时才失败
    expect(await p1).toBe(false);
    expect(onFailedV1).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryV1).not.toHaveBeenCalled();
  });

  it("V1 失败后（已排重试）同字段发起 V2：V1 的重试作废", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retryV1 = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    await saveWithRetry({
      retrier: r,
      key: "repos",
      first: async () => false,
      retry: retryV1,
    });
    expect(r.pendingCount()).toBe(1);
    await saveWithRetry({
      retrier: r,
      key: "repos",
      first: async () => true,
      retry: async () => true,
    });
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryV1).not.toHaveBeenCalled();
  });

  it("只改草稿（dropPending）不算「被新保存取代」：repo-card 先落盘安全版、再把含坏模板的草稿放回输入框，安全版失败仍要重试", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const safe = deferredSave();
    const retrySafe = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const onFailed = vi.fn();
    const p = saveWithRetry({
      retrier: r,
      key: "repos",
      first: () => safe.promise,
      retry: retrySafe,
      onFailed,
    });
    r.dropPending("repos"); // 紧接着的 onChange(next) → update()
    safe.resolve(false);
    await p;
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(r.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(retrySafe).toHaveBeenCalledTimes(1);
  });

  it("失败后用户把字段改回旧值（update → dropPending）：待重试作废、不会 2s 后把失败的新值写盘", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retryV1 = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    await saveWithRetry({
      retrier: r,
      key: "apiKey",
      first: async () => false,
      retry: retryV1,
    });
    expect(r.pendingCount()).toBe(1);
    r.dropPending("apiKey"); // 用户在框里改回旧值（草稿变更）
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryV1).not.toHaveBeenCalled();
  });

  it("first 同步发起（保证乐观写 cache 的顺序）：调用 saveWithRetry 的当下 first 已被调用", () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const first = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    void saveWithRetry({ retrier: r, key: "repos", first, retry: async () => true });
    expect(first).toHaveBeenCalledTimes(1);
  });
});

/** 带 HTTP 状态码的失败结果（local-store.saveSettingsDetailed 的形状；没有 status = 网络错误 / 超时之类） */
const fail = (status?: number) => ({ ok: false as const, ...(status === undefined ? {} : { status }) });

describe("saveWithRetry：4xx（服务端拒绝）不排重试，5xx / 网络错误照旧重试（第七轮 K3-10）", () => {
  it("400：只调用 first 一次、不提示「将自动重试」（onFailed）、改走 onRejected(status)、不登记重试、过再久也不会重试", async () => {
    const r = createSaveRetrier({ delaysMs: [100, 200, 300] });
    const first = vi.fn(async () => fail(400));
    const retry = vi.fn(async () => true);
    const onFailed = vi.fn();
    const onRejected = vi.fn();
    const ok = await saveWithRetry({ retrier: r, key: "repos", first, retry, onFailed, onRejected });
    expect(ok).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith(400);
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
  });

  // 第八轮 L1-01：只有 408 / 425 / 429 这三个「暂时性」4xx 例外（见下方专项）；它们的邻居（407 / 424 / 426 / 428 / 430）仍是拒绝，
  // 防止有人把例外放宽成一个范围
  it.each([400, 401, 403, 404, 407, 409, 413, 422, 424, 426, 428, 430, 499])("HTTP %i → 视为被拒绝、不重试", async (status) => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retry = vi.fn(async () => true);
    const onFailed = vi.fn();
    const onRejected = vi.fn();
    await saveWithRetry({ retrier: r, key: "k", first: async () => fail(status), retry, onFailed, onRejected });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retry).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(status);
  });

  it.each([500, 502, 503, 599])("HTTP %i → 照旧：提示将自动重试并按退避重试", async (status) => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retry = vi.fn(async () => true);
    const onFailed = vi.fn();
    const onRejected = vi.fn();
    await saveWithRetry({ retrier: r, key: "k", first: async () => fail(status), retry, onFailed, onRejected });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("没有状态码（网络断 / 超时 / init 未成功）→ 照旧重试，不能被误当成 4xx", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retry = vi.fn(async () => true);
    const onFailed = vi.fn();
    const onRejected = vi.fn();
    await saveWithRetry({ retrier: r, key: "k", first: async () => fail(), retry, onFailed, onRejected });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("纯布尔结果（旧调用方）行为不变：false 仍重试、true 仍成功", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retry = vi.fn(async () => true);
    const onFailed = vi.fn();
    expect(await saveWithRetry({ retrier: r, key: "a", first: async () => false, retry, onFailed })).toBe(false);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(await saveWithRetry({ retrier: r, key: "b", first: async () => true, retry, onFailed })).toBe(true);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it("成功（{ ok: true }）→ 成功路径，不 onFailed / onRejected", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const onFailed = vi.fn();
    const onRejected = vi.fn();
    const ok = await saveWithRetry({
      retrier: r,
      key: "k",
      first: async () => ({ ok: true }),
      retry: async () => true,
      onFailed,
      onRejected,
    });
    expect(ok).toBe(true);
    expect(onFailed).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
  });

  it("世代取消不被弄坏：V1 在路上时 V2 已发起，V1 晚被 400 拒绝 → 静默（不 onRejected、不 onFailed、不重试）", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    let resolveV1!: (v: { ok: false; status: number }) => void;
    const v1 = new Promise<{ ok: false; status: number }>((res) => {
      resolveV1 = res;
    });
    const retryV1 = vi.fn(async () => true);
    const onFailedV1 = vi.fn();
    const onRejectedV1 = vi.fn();
    const p1 = saveWithRetry({
      retrier: r,
      key: "repos",
      first: () => v1,
      retry: retryV1,
      onFailed: onFailedV1,
      onRejected: onRejectedV1,
    });
    await saveWithRetry({ retrier: r, key: "repos", first: async () => true, retry: async () => true });

    resolveV1({ ok: false, status: 400 });
    expect(await p1).toBe(false);
    expect(onRejectedV1).not.toHaveBeenCalled();
    expect(onFailedV1).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryV1).not.toHaveBeenCalled();
  });

  it("世代取消不被弄坏：5xx 失败后（已排重试）同字段的新保存被 400 拒绝 → 旧值的待重试照样作废，新保存自己也不排重试", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    const retryOld = vi.fn(async () => true);
    await saveWithRetry({ retrier: r, key: "repos", first: async () => fail(500), retry: retryOld });
    expect(r.pendingCount()).toBe(1);
    await saveWithRetry({ retrier: r, key: "repos", first: async () => fail(400), retry: async () => true });
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryOld).not.toHaveBeenCalled();
  });
});

// 408 Request Timeout / 425 Too Early / 429 Too Many Requests 是 4xx，但语义是「稍后再来」而不是「这份内容不行」：
// 同一个请求体过一会儿再发是会成功的。第七轮把整个 400–499 都当永久拒绝（toast 还说「不会自动重试」），对这三个不真。
// 目前本地服务只会返回 400 / 403 / 500（审查方实证），所以是潜伏的；但 /api/settings 前面若有反向代理 / 网关就会遇到。
describe("saveWithRetry / createSaveRetrier：408 / 425 / 429 是可重试的 4xx（第八轮 L1-01）", () => {
  const RETRYABLE_4XX = [408, 425, 429] as const;

  it.each(RETRYABLE_4XX)(
    "首次保存 HTTP %i → 提示「将自动重试」（onFailed）、不走 onRejected、登记退避重试并真的重试",
    async (status) => {
      const r = createSaveRetrier({ delaysMs: [100] });
      const retry = vi.fn(async () => true);
      const onFailed = vi.fn();
      const onRejected = vi.fn();
      const ok = await saveWithRetry({ retrier: r, key: "k", first: async () => fail(status), retry, onFailed, onRejected });
      expect(ok).toBe(false);
      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(onRejected).not.toHaveBeenCalled();
      expect(r.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(r.pendingCount()).toBe(0);
    },
  );

  it.each(RETRYABLE_4XX)(
    "重试那一次遇到 HTTP %i → 继续按退避重试、用尽才 onGiveUp（不走 onRejected、不提前终止）",
    async (status) => {
      const onGiveUp = vi.fn();
      const onRejected = vi.fn();
      const r = createSaveRetrier({ delaysMs: [10, 10, 10], onGiveUp, onRejected });
      const attempt = vi.fn(async () => fail(status));
      r.schedule("apiKey", attempt);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempt).toHaveBeenCalledTimes(3);
      expect(onRejected).not.toHaveBeenCalled();
      expect(onGiveUp).toHaveBeenCalledWith("apiKey");
      expect(r.pendingCount()).toBe(0);
    },
  );

  it("429 → 429 → 成功：第三次重试成功 → onRecovered，全程没有 onRejected / onGiveUp", async () => {
    const onRecovered = vi.fn();
    const onGiveUp = vi.fn();
    const onRejected = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10, 10, 10], onRecovered, onGiveUp, onRejected });
    const results = [fail(429), fail(408), { ok: true as const }];
    const attempt = vi.fn(async () => results[attempt.mock.calls.length - 1]);
    r.schedule("repos", attempt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRecovered).toHaveBeenCalledWith("repos");
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("可重试的 4xx 与永久 4xx 混合：429 之后再被 400 拒绝 → 在 400 那一次终止（onRejected(key, 400)）", async () => {
    const onGiveUp = vi.fn();
    const onRejected = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10, 10, 10], onGiveUp, onRejected });
    const results = [fail(429), fail(400), fail(500)];
    const attempt = vi.fn(async () => results[attempt.mock.calls.length - 1]);
    r.schedule("repos", attempt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRejected).toHaveBeenCalledWith("repos", 400);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("世代取消对可重试的 4xx 同样成立：V1 在路上时 V2 已发起，V1 晚被 429 → 静默（不 onFailed、不排 V1 的重试）", async () => {
    const r = createSaveRetrier({ delaysMs: [100] });
    let resolveV1!: (v: { ok: false; status: number }) => void;
    const v1 = new Promise<{ ok: false; status: number }>((res) => {
      resolveV1 = res;
    });
    const retryV1 = vi.fn(async () => true);
    const onFailedV1 = vi.fn();
    const p1 = saveWithRetry({ retrier: r, key: "repos", first: () => v1, retry: retryV1, onFailed: onFailedV1 });
    await saveWithRetry({ retrier: r, key: "repos", first: async () => true, retry: async () => true });
    resolveV1({ ok: false, status: 429 });
    expect(await p1).toBe(false);
    expect(onFailedV1).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retryV1).not.toHaveBeenCalled();
  });
});

describe("createSaveRetrier：重试那一次被 4xx 拒绝 → 立刻终止、不再排后续重试（第七轮 K3-10）", () => {
  it("首次 5xx → 第一次重试遇到 400：attempt 只跑一次，onRejected(key, 400)，onGiveUp 不触发（它的文案说「多次重试」不真）", async () => {
    const onGiveUp = vi.fn();
    const onRejected = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10, 10, 10], onGiveUp, onRejected });
    const attempt = vi.fn(async () => fail(400));
    r.schedule("apiKey", attempt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith("apiKey", 400);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
  });

  it("重试遇到 5xx / 无状态码 → 照旧继续退避，用尽才 onGiveUp", async () => {
    const onGiveUp = vi.fn();
    const onRejected = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10, 10, 10], onGiveUp, onRejected });
    const results = [fail(503), fail(), fail(500)];
    const attempt = vi.fn(async () => results[attempt.mock.calls.length - 1]);
    r.schedule("apiKey", attempt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRejected).not.toHaveBeenCalled();
    expect(onGiveUp).toHaveBeenCalledWith("apiKey");
  });

  it("重试返回 { ok: true } → onRecovered", async () => {
    const onRecovered = vi.fn();
    const r = createSaveRetrier({ delaysMs: [10], onRecovered });
    r.schedule("apiKey", async () => ({ ok: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(onRecovered).toHaveBeenCalledWith("apiKey");
    expect(r.pendingCount()).toBe(0);
  });
});

describe("use-settings 接线契约（无 DOM 环境，用源码断言钉住）", () => {
  const src = readFileSync(join(process.cwd(), "src/hooks/use-settings.ts"), "utf8");

  it("saveFieldValue 经 saveWithRetry（带世代判断）排重试，而不是失败回调里直接 schedule", () => {
    expect(src).toContain("saveWithRetry(");
    expect(src).not.toMatch(/getRetrier\(\)\.schedule\(/);
  });

  it("update（只改草稿）会 dropPending：改回旧值后失败的新值不再被自动重试写盘", () => {
    const m = /const update = [\s\S]*?\n {2}\};/.exec(src);
    expect(m).not.toBeNull();
    expect(m?.[0]).toContain("dropPending(key)");
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 第八轮 L1-04：use-settings.ts 把 saveSettingsDetailed 换回只返回布尔的 saveSettings，上面所有测试都不会红——
// 它们测的是 saveWithRetry / createSaveRetrier 本身，没有任何东西钉住「use-settings 真的把状态码接进来了」。
//
// ⚠ 下面是**源码形态契约（AST 形态断言），不是行为证明**：use-settings 是 React hook、没有 DOM 测试环境没法渲染，
// 只能钉形态——首次保存与重试体都调 saveSettingsDetailed（带 HTTP 状态码）、saveWithRetry 与 createSaveRetrier 都接了 onRejected、
// 全文件不再引用只返回布尔的 saveSettings。改了写法（比如包一层再调）会误红、需要同步改这里；换回 saveSettings 会如实变红。
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe("use-settings 保存接线：源码形态契约（AST；不是行为证明）——必须用带状态码的 saveSettingsDetailed、并接 onRejected", () => {
  interface Wiring {
    /** 出现过标识符 `saveSettings`（只返回布尔、丢掉状态码的旧入口；含 import 与调用） */
    referencesPlainSaveSettings: boolean;
    /** saveWithRetry({...}) 调用点的个数 */
    saveWithRetryCalls: number;
    /** 每个 saveWithRetry 调用里：first / retry 函数体内被调用的函数名 */
    firstCallees: string[][];
    retryCallees: string[][];
    /** 每个 saveWithRetry 调用的参数对象是否带 onRejected */
    saveWithRetryHasOnRejected: boolean[];
    /** 每个 createSaveRetrier({...}) 调用的参数对象是否带 onRejected */
    createSaveRetrierHasOnRejected: boolean[];
  }

  const analyze = (text: string): Wiring => {
    const sf = ts.createSourceFile("use-settings.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const w: Wiring = {
      referencesPlainSaveSettings: false,
      saveWithRetryCalls: 0,
      firstCallees: [],
      retryCallees: [],
      saveWithRetryHasOnRejected: [],
      createSaveRetrierHasOnRejected: [],
    };
    const propName = (p: ts.ObjectLiteralElementLike): string | undefined =>
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
    const calleesIn = (n: ts.Node): string[] => {
      const out: string[] = [];
      const visit = (x: ts.Node) => {
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) out.push(x.expression.text);
        ts.forEachChild(x, visit);
      };
      visit(n);
      return out;
    };
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n.text === "saveSettings") w.referencesPlainSaveSettings = true;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const arg = n.arguments[0];
        const props = arg && ts.isObjectLiteralExpression(arg) ? arg.properties : [];
        if (n.expression.text === "saveWithRetry") {
          w.saveWithRetryCalls += 1;
          const bodyOf = (name: string): ts.Node | undefined => {
            const p = props.find((x) => propName(x) === name);
            return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
          };
          const first = bodyOf("first");
          const retry = bodyOf("retry");
          w.firstCallees.push(first ? calleesIn(first) : []);
          w.retryCallees.push(retry ? calleesIn(retry) : []);
          w.saveWithRetryHasOnRejected.push(props.some((x) => propName(x) === "onRejected"));
        }
        if (n.expression.text === "createSaveRetrier") {
          w.createSaveRetrierHasOnRejected.push(props.some((x) => propName(x) === "onRejected"));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return w;
  };

  const GOOD = `
    import { saveSettingsDetailed } from "@/lib/local-store";
    const getRetrier = () => createSaveRetrier({ onRejected: (_k, s) => toast(s) });
    const save = () => saveWithRetry({
      retrier: getRetrier(), key,
      first: () => saveSettingsDetailed(next),
      retry: async () => { const res = await saveSettingsDetailed(other); return res; },
      onRejected: (s) => toast(s),
    });
  `;

  it("真实 src/hooks/use-settings.ts：first / retry 都调 saveSettingsDetailed，两处都接 onRejected，不再引用 saveSettings", () => {
    const w = analyze(readFileSync(join(process.cwd(), "src/hooks/use-settings.ts"), "utf8"));
    expect(w.saveWithRetryCalls).toBe(1);
    expect(w.firstCallees[0]).toContain("saveSettingsDetailed");
    expect(w.retryCallees[0]).toContain("saveSettingsDetailed");
    expect(w.saveWithRetryHasOnRejected).toEqual([true]);
    expect(w.createSaveRetrierHasOnRejected).toEqual([true]);
    expect(w.referencesPlainSaveSettings).toBe(false);
  });

  it("检测器自检：规范写法放行；换回 saveSettings / 漏接 onRejected / 只换了一半，都会被识别出来", () => {
    const good = analyze(GOOD);
    expect(good.firstCallees[0]).toContain("saveSettingsDetailed");
    expect(good.retryCallees[0]).toContain("saveSettingsDetailed");
    expect(good.saveWithRetryHasOnRejected).toEqual([true]);
    expect(good.createSaveRetrierHasOnRejected).toEqual([true]);
    expect(good.referencesPlainSaveSettings).toBe(false);

    // 把 first / retry / import 都换回只返回布尔的 saveSettings（注释里提到它不算引用）
    const swapped = analyze(
      GOOD.replace(/saveSettingsDetailed/g, "saveSettings") + "\n// saveSettings 只在注释里出现不该影响其它判断",
    );
    expect(swapped.referencesPlainSaveSettings).toBe(true);
    expect(swapped.firstCallees[0]).not.toContain("saveSettingsDetailed");
    expect(swapped.retryCallees[0]).not.toContain("saveSettingsDetailed");

    // 只换了 retry 一半
    const half = analyze(GOOD.replace("const res = await saveSettingsDetailed(other)", "const res = await saveSettings(other)"));
    expect(half.firstCallees[0]).toContain("saveSettingsDetailed");
    expect(half.retryCallees[0]).not.toContain("saveSettingsDetailed");
    expect(half.referencesPlainSaveSettings).toBe(true);

    // 漏接 onRejected
    const noRejected = analyze(GOOD.replace("onRejected: (s) => toast(s),", "").replace("{ onRejected: (_k, s) => toast(s) }", "{}"));
    expect(noRejected.saveWithRetryHasOnRejected).toEqual([false]);
    expect(noRejected.createSaveRetrierHasOnRejected).toEqual([false]);
  });
});
