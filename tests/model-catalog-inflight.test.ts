/**
 * R14 Q11b-04：模型清单缓存——并发合并（inflight）+ 过期后刷新失败时沿用旧清单（stale-on-error）。
 *
 * 改前：`listModelOptions` 没有 inflight——冷缓存时设置页 / 新建任务 / 切模型 / 子代理 `model:list`
 * 同时命中，N 个调用就发 N 次底层请求（真实 5–15 秒一次）；TTL（10 分钟）一过且断网 → 刷新抛错 →
 * `/api/models` 502、子代理降级成「拿不到清单」，旧清单明明还在内存里。
 *
 * 只造假 `@cursor/sdk` 的 `Cursor.models.list` 和 `listCustomModels`，以及假的「当前时间」（只 fake Date）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  cursorList: vi.fn(),
  listCustomModels: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Cursor: { models: { list: hoisted.cursorList } },
}));
vi.mock("@/lib/server/custom-provider", () => ({
  listCustomModels: hoisted.listCustomModels,
}));

import {
  STALE_RETRY_COOLDOWN_MS,
  getCachedModelOptions,
  listModelOptions,
  resetModelCatalogForTest,
  type ModelCatalogSource,
} from "@/lib/server/model-catalog";
import type { ModelOption } from "@/lib/types";

const MIN = 60 * 1000;
const T0 = new Date("2026-10-25T08:00:00Z").getTime();

const cursorSrc = (apiKey = "key-A"): ModelCatalogSource => ({ kind: "cursor", apiKey });
const customSrc = (apiKey = "sk-1", baseUrl = "https://llm.example/v1"): ModelCatalogSource => ({
  kind: "custom",
  apiKey,
  baseUrl,
  format: "openai",
});

const sdkModel = (id: string, displayName = id) => ({ id, displayName, description: undefined, parameters: undefined, variants: undefined });
const opt = (id: string): ModelOption => ({ id, displayName: id } as ModelOption);

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetModelCatalogForTest();
  hoisted.cursorList.mockReset();
  hoisted.listCustomModels.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetModelCatalogForTest();
});

describe("并发合并（inflight）", () => {
  it("cursor：冷缓存并发 5 次 → 底层只调 1 次，5 个调用拿到同一份结果（改前：5 次）", async () => {
    const gate = deferred<ReturnType<typeof sdkModel>[]>();
    hoisted.cursorList.mockReturnValue(gate.promise);
    const calls = Array.from({ length: 5 }, () => listModelOptions(cursorSrc()));
    expect(hoisted.cursorList).toHaveBeenCalledTimes(1);
    gate.resolve([sdkModel("m-b", "Beta"), sdkModel("m-a", "alpha")]);
    const results = await Promise.all(calls);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toBe(results[0]);
    // 原有口径：按 displayName 字母序（不区分大小写）
    expect(results[0]!.map((m) => m.id)).toEqual(["m-a", "m-b"]);
  });

  it("custom：冷缓存并发 5 次 → `listCustomModels` 只调 1 次", async () => {
    const gate = deferred<ModelOption[]>();
    hoisted.listCustomModels.mockReturnValue(gate.promise);
    const calls = Array.from({ length: 5 }, () => listModelOptions(customSrc()));
    expect(hoisted.listCustomModels).toHaveBeenCalledTimes(1);
    gate.resolve([opt("deepseek-v4")]);
    const results = await Promise.all(calls);
    expect(results.map((r) => r.map((m) => m.id))).toEqual(Array(5).fill(["deepseek-v4"]));
    expect(hoisted.listCustomModels).toHaveBeenCalledTimes(1);
  });

  it("合并之后进缓存：再调不再请求；`getCachedModelOptions` 命中", async () => {
    hoisted.cursorList.mockResolvedValue([sdkModel("m-a")]);
    await Promise.all([listModelOptions(cursorSrc()), listModelOptions(cursorSrc())]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(1);
    await listModelOptions(cursorSrc());
    expect(hoisted.cursorList).toHaveBeenCalledTimes(1);
    expect(getCachedModelOptions(cursorSrc())?.map((m) => m.id)).toEqual(["m-a"]);
  });

  it("不同 key（不同 apiKey / baseUrl）不合并", async () => {
    hoisted.cursorList.mockResolvedValue([sdkModel("m-a")]);
    hoisted.listCustomModels.mockResolvedValue([opt("c-1")]);
    await Promise.all([
      listModelOptions(cursorSrc("key-A")),
      listModelOptions(cursorSrc("key-B")),
      listModelOptions(customSrc("sk-1", "https://one.example/v1")),
      listModelOptions(customSrc("sk-1", "https://two.example/v1")),
    ]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);
    expect(hoisted.listCustomModels).toHaveBeenCalledTimes(2);
  });

  it("失败不缓存：并发的几个调用共享同一个失败；inflight 已清，下一次重新拉并成功", async () => {
    const gate = deferred<ReturnType<typeof sdkModel>[]>();
    hoisted.cursorList.mockReturnValueOnce(gate.promise);
    const calls = [1, 2, 3].map(() => listModelOptions(cursorSrc()).then(() => "ok", (e: Error) => e.message));
    gate.reject(new Error("拉取模型 超时（15000ms）"));
    expect(await Promise.all(calls)).toEqual(Array(3).fill("拉取模型 超时（15000ms）"));
    expect(hoisted.cursorList).toHaveBeenCalledTimes(1);
    expect(getCachedModelOptions(cursorSrc())).toBeNull();

    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-a")]);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-a"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);
  });

  it("成功后 inflight 也清了：缓存过期后会重新拉，而不是永远复用旧 promise", async () => {
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-old")]);
    await listModelOptions(cursorSrc());
    vi.setSystemTime(T0 + 11 * MIN);
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-new")]);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-new"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);
  });
});

describe("过期后刷新失败：沿用旧清单（stale-on-error）", () => {
  const seedOld = async () => {
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-old")]);
    await listModelOptions(cursorSrc());
    expect(hoisted.cursorList).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 11 * MIN); // 过了 10 分钟 TTL
  };

  it("过期 + 刷新失败 + 有旧清单 → 返回旧清单（不抛）、warn 一条写明多少分钟前（改前：抛错 → 路由 502）", async () => {
    await seedOld();
    hoisted.cursorList.mockRejectedValueOnce(new Error("fetch failed"));
    const got = await listModelOptions(cursorSrc());
    expect(got.map((m) => m.id)).toEqual(["m-old"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]?.[0]);
    expect(line).toContain("沿用 11 分钟前的旧清单");
    expect(line).toContain("fetch failed");
  });

  it("失败后 60 秒冷却：期间再调直接给旧清单、不再请求（断网时不会每次调用都等满超时）；冷却过后再试", async () => {
    await seedOld();
    hoisted.cursorList.mockRejectedValueOnce(new Error("fetch failed"));
    await listModelOptions(cursorSrc());
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + 11 * MIN + STALE_RETRY_COOLDOWN_MS - 1000);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-old"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + 11 * MIN + STALE_RETRY_COOLDOWN_MS + 1000);
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-new")]);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-new"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(3);
    // 成功后冷却标记清掉、进入新的 TTL
    await listModelOptions(cursorSrc());
    expect(hoisted.cursorList).toHaveBeenCalledTimes(3);
  });

  it("冷却过后重试仍失败 → 继续旧清单，并进入下一轮冷却", async () => {
    await seedOld();
    hoisted.cursorList.mockRejectedValue(new Error("down"));
    await listModelOptions(cursorSrc());
    vi.setSystemTime(T0 + 11 * MIN + STALE_RETRY_COOLDOWN_MS + 1000);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-old"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    await listModelOptions(cursorSrc());
    expect(hoisted.cursorList).toHaveBeenCalledTimes(3); // 新一轮冷却内
  });

  it("过期 + 失败 + 并发 5 次 → 都拿到旧清单，底层只调 1 次", async () => {
    await seedOld();
    const gate = deferred<ReturnType<typeof sdkModel>[]>();
    hoisted.cursorList.mockReturnValueOnce(gate.promise);
    const calls = Array.from({ length: 5 }, () => listModelOptions(cursorSrc()));
    gate.reject(new Error("fetch failed"));
    const results = await Promise.all(calls);
    for (const r of results) expect(r.map((m) => m.id)).toEqual(["m-old"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("custom 同样兜底；warn 里的 URL userinfo 被擦掉（不把密钥写进日志）", async () => {
    hoisted.listCustomModels.mockResolvedValueOnce([opt("c-old")]);
    await listModelOptions(customSrc());
    vi.setSystemTime(T0 + 11 * MIN);
    hoisted.listCustomModels.mockRejectedValueOnce(
      new Error("fetch failed: https://admin:SUPERSECRET@llm.example/v1/models"),
    );
    expect((await listModelOptions(customSrc())).map((m) => m.id)).toEqual(["c-old"]);
    const line = String(warnSpy.mock.calls[0]?.[0]);
    expect(line).not.toContain("SUPERSECRET");
    expect(line).toContain("https://***@llm.example");
  });

  it("冷启动失败（没有旧清单）→ 仍然抛原始错误，由调用方降级（路由 502 / 子代理不校验）", async () => {
    hoisted.cursorList.mockRejectedValueOnce(new Error("拉取模型 超时（15000ms）"));
    await expect(listModelOptions(cursorSrc())).rejects.toThrow("拉取模型 超时（15000ms）");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("过期 + 刷新成功 → 新清单替换旧的（对照）", async () => {
    await seedOld();
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-new")]);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-new"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // 审查 AI 预审 P3：key 被撤销 / 过期（401 / 403）后，旧清单是这把 key 以前有效时拿的——继续吐出去会把
  // 「key 已失效」藏到真的跑任务才暴露，还会每 60 秒重试一次、直到进程重启都不报错。鉴权类拒绝不沿用旧清单。
  it.each([
    ["HTTP 401", "拉取模型列表失败：HTTP 401"],
    ["HTTP 403", "拉取模型列表失败：HTTP 403"],
    ["Unauthenticated", "Unauthenticated"],
    ["SDK 的 unauthenticated 文案", "[unauthenticated] Invalid API key"],
    ["status 401", "Request failed with status 401"],
  ])(
    "过期 + 刷新被鉴权拒绝（%s）→ 不沿用旧清单：照常抛原始错误、不 warn、旧缓存被丢掉",
    async (_label, message) => {
      await seedOld();
      hoisted.cursorList.mockRejectedValueOnce(new Error(message));
      await expect(listModelOptions(cursorSrc())).rejects.toThrow(message);
      expect(warnSpy).not.toHaveBeenCalled();
      // 旧缓存确实被丢了：之后哪怕换成暂时性失败（断网），也没有旧清单可兜、照常抛
      //（而不是又吐出一份 key 失效前的旧清单、再进 60 秒冷却）
      hoisted.cursorList.mockRejectedValueOnce(new Error("fetch failed"));
      await expect(listModelOptions(cursorSrc())).rejects.toThrow("fetch failed");
      expect(hoisted.cursorList).toHaveBeenCalledTimes(3);
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it("鉴权拒绝不进 60 秒冷却：用户改好 key 重试，下一次调用立刻重新拉并成功", async () => {
    await seedOld();
    hoisted.cursorList.mockRejectedValueOnce(new Error("拉取模型列表失败：HTTP 401"));
    await expect(listModelOptions(cursorSrc())).rejects.toThrow("HTTP 401");
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-fixed")]);
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-fixed"]);
    expect(hoisted.cursorList).toHaveBeenCalledTimes(3);
  });

  it("鉴权拒绝时并发 5 次共享同一个失败（不因为丢了缓存就各自再拉一次）", async () => {
    await seedOld();
    const gate = deferred<ReturnType<typeof sdkModel>[]>();
    hoisted.cursorList.mockReturnValueOnce(gate.promise);
    const calls = Array.from({ length: 5 }, () => listModelOptions(cursorSrc()));
    const settled = Promise.allSettled(calls);
    gate.reject(new Error("拉取模型列表失败：HTTP 401"));
    const results = await settled;
    for (const r of results) expect(r.status).toBe("rejected");
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);
  });

  it("custom 同样：过期 + 刷新 401 → 抛错、丢缓存（之后断网也不再吐旧清单）", async () => {
    hoisted.listCustomModels.mockResolvedValueOnce([opt("c-old")]);
    await listModelOptions(customSrc());
    vi.setSystemTime(T0 + 11 * MIN);
    hoisted.listCustomModels.mockRejectedValueOnce(new Error("拉取模型列表失败：HTTP 401"));
    await expect(listModelOptions(customSrc())).rejects.toThrow("HTTP 401");
    hoisted.listCustomModels.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(listModelOptions(customSrc())).rejects.toThrow("fetch failed");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("只丢出事的那把 key 的缓存：别的 key 的旧清单不受影响", async () => {
    await seedOld();
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("b-old")]);
    await listModelOptions(cursorSrc("key-B")); // 此时 T0+11min，key-B 刚拉的是新缓存
    hoisted.cursorList.mockRejectedValueOnce(new Error("拉取模型列表失败：HTTP 401"));
    await expect(listModelOptions(cursorSrc("key-A"))).rejects.toThrow("HTTP 401");
    expect(getCachedModelOptions(cursorSrc("key-B"))?.map((m) => m.id)).toEqual(["b-old"]);
  });

  // 对照：这些不是「key 失效」，仍沿用旧清单（与改前一致；用真实的报错文案，不是随手编的 "boom"）
  it.each([
    ["HTTP 429（限流）", "拉取模型列表失败：HTTP 429"],
    ["HTTP 502", "拉取模型列表失败：HTTP 502"],
    ["HTTP 503", "拉取模型列表失败：HTTP 503"],
    ["HTTP 404", "拉取模型列表失败：HTTP 404"],
    ["断网", "fetch failed"],
    ["SDK 超时", "拉取模型 超时（15000ms）"],
    ["列表为空", "拉取模型列表失败：列表为空"],
  ])("过期 + 刷新失败（%s，不是鉴权问题）→ 仍沿用旧清单、warn 一条", async (_label, message) => {
    await seedOld();
    hoisted.cursorList.mockRejectedValueOnce(new Error(message));
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-old"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(message);
  });

  it("非 Error 的拒绝值（字符串）也能分类：字符串 401 → 原样抛；字符串 fetch failed → 沿用旧清单", async () => {
    await seedOld();
    hoisted.cursorList.mockRejectedValueOnce("拉取模型列表失败：HTTP 401");
    await expect(listModelOptions(cursorSrc())).rejects.toBe("拉取模型列表失败：HTTP 401");
    // 对照：换成字符串形态的暂时性失败 → 沿用旧清单（缓存刚被丢了，先重新攒一份旧清单）
    hoisted.cursorList.mockResolvedValueOnce([sdkModel("m-old")]);
    await listModelOptions(cursorSrc());
    vi.setSystemTime(T0 + 30 * MIN);
    hoisted.cursorList.mockRejectedValueOnce("fetch failed");
    expect((await listModelOptions(cursorSrc())).map((m) => m.id)).toEqual(["m-old"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("`getCachedModelOptions` 只认没过期的：过期后（哪怕旧清单还在内存里、冷却中）返回 null，子代理 peek 不会拿到陈旧清单当新的", async () => {
    await seedOld();
    expect(getCachedModelOptions(cursorSrc())).toBeNull();
    hoisted.cursorList.mockRejectedValueOnce(new Error("fetch failed"));
    await listModelOptions(cursorSrc()); // 进入冷却，返回旧清单
    expect(getCachedModelOptions(cursorSrc())).toBeNull();
  });
});

describe("常量", () => {
  it("失败后的冷却是 60 秒（其余用例都按这个常量算时间，这里钉住字面值）", () => {
    expect(STALE_RETRY_COOLDOWN_MS).toBe(60_000);
  });
});

describe("状态挂 globalThis", () => {
  it("`resetModelCatalogForTest` 清掉缓存与 inflight：之后的调用重新拉", async () => {
    hoisted.cursorList.mockResolvedValue([sdkModel("m-a")]);
    await listModelOptions(cursorSrc());
    resetModelCatalogForTest();
    await listModelOptions(cursorSrc());
    expect(hoisted.cursorList).toHaveBeenCalledTimes(2);
  });

  it("状态存在 globalThis 上（多 bundle 实例共用一份，不各冷一次）", async () => {
    hoisted.cursorList.mockResolvedValue([sdkModel("m-a")]);
    await listModelOptions(cursorSrc());
    const slot = (globalThis as unknown as { __flowshipModelCatalogV1?: { cache: Map<string, unknown> } })
      .__flowshipModelCatalogV1;
    expect(slot?.cache.size).toBe(1);
  });
});
