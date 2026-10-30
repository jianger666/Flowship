/**
 * R14 Q11b-01：models.dev 目录刷新——「合法 JSON 但形状不对」不能覆盖旧索引；过期后是 stale-while-revalidate。
 *
 * 改前：`loadIndexes` 不校验，`res.json()` 成功就当成功——校园网 / 公司网关 / 代理对 `models.dev/api.json`
 * 回 200 + `{"error":"captive portal"}`（或 `[]` / `{}`）时，build 出两张空表覆盖旧的好索引、`ts = now`，
 * 之后 24 小时所有自定义模型的 effort 档 / 上下文窗口 / 图像输入都查不到；过期后刷新失败时，每个调用方
 * （含每次建 pi 会话的 buildRuntime）都陪着等满 2 × 20 秒，之后冷却 60 秒再来一轮。
 *
 * 只造假 `fetch`（vi.stubGlobal）和假的「当前时间」（只 fake Date，微任务 / 真定时器不受影响）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getModelsDevIndex,
  getModelsDevRouteIndex,
  resetModelsDevCatalogForTest,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";

const HOUR = 60 * 60 * 1000;

/** 与 models.dev 真实结构同形的最小目录（含 reasoning 档 + 带 api / npm 的提供方 → 两张表都非空） */
const catalogOf = (modelId: string) => ({
  opencode: {
    api: "https://opencode.ai/zen/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      [modelId]: {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        limit: { context: 128000 },
      },
    },
  },
});
const GOOD = catalogOf("model-good");
const NEWER = catalogOf("model-newer");

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const T0 = new Date("2026-10-25T08:00:00Z").getTime();

/** 把「刚成功过一次的好目录」放进缓存，并让它在 `ageMs` 之前就成功过 */
const seedGood = (ageMs: number, catalog: unknown = GOOD) => {
  seedModelsDevCatalogForTest(catalog, { ts: Date.now() - ageMs });
};

const has = async (id: string) => (await getModelsDevIndex()).has(id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetModelsDevCatalogForTest();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetModelsDevCatalogForTest();
});

describe("200 + 合法 JSON 但不是目录：当失败、不覆盖旧索引", () => {
  const JUNK: Array<[string, unknown]> = [
    ["{error: captive portal}", { error: "captive portal" }],
    ["[]", []],
    ["{}", {}],
    ["null", null],
    ["字符串", "<html>login</html>"],
    ["数字", 42],
    ["提供方没有 models", { a: { api: "https://x.example/v1" } }],
    ["模型全是非对象", { a: { api: "https://x.example/v1", models: { m: null } } }],
  ];

  it.each(JUNK)("过期 + 刷新拿到 %s → 旧索引保留、warn 一条、冷却内不再连打", async (_label, body) => {
    seedGood(25 * HOUR);
    fetchMock.mockResolvedValue(okResponse(body));

    // 过期后调用方立刻拿旧索引（不等刷新）
    expect(await has("model-good")).toBe(true);
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("沿用旧索引");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 刷新失败后旧索引还在（改前：被换成空表）、路由索引同理
    expect(await has("model-good")).toBe(true);
    expect((await getModelsDevRouteIndex()).size).toBe(1);
    // 失败冷却 60 秒：期间再调不再 fetch
    vi.setSystemTime(T0 + 30_000);
    await getModelsDevIndex();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("只有一张表为空（有模型但没有任何带 api / npm 的提供方）也算失败：路由索引不能被换成空表", async () => {
    seedGood(25 * HOUR);
    fetchMock.mockResolvedValue(
      okResponse({ p: { models: { "m-only-index": { reasoning: false } } } }),
    );

    await getModelsDevIndex();
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(await has("model-good")).toBe(true);
    expect(await has("m-only-index")).toBe(false);
    expect((await getModelsDevRouteIndex()).has("https://opencode.ai/zen")).toBe(true);
  });

  it("冷启动（从没成功过）拿到垃圾 → 仍是空表（列表照出、不猜档），但不记成成功：60 秒后会重试并拿到好目录", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: "captive portal" }));
    fetchMock.mockResolvedValue(okResponse(GOOD));

    // 冷启动没有旧索引可给 → 这一次要等刷新结束（拿到空表）
    expect((await getModelsDevIndex()).size).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("effort 不画");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 冷却内不连打
    vi.setSystemTime(T0 + 59_000);
    expect((await getModelsDevIndex()).size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 冷却结束 → 重试 → 好目录（改前：垃圾被缓存 24 小时，这里永远等不到好目录）
    vi.setSystemTime(T0 + 61_000);
    expect(await has("model-good")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("过期后 stale-while-revalidate（已有旧索引时不陪着等）", () => {
  it("刷新还在路上时调用方立刻拿到旧索引；刷新完成后下一次调用拿到新索引", async () => {
    seedGood(25 * HOUR);
    const gate = deferred<ReturnType<typeof okResponse>>();
    fetchMock.mockReturnValue(gate.promise);

    // 刷新 fetch 悬着（改前：这里会一直等到它返回 / 超时）
    const first = await Promise.race([
      getModelsDevIndex().then((m) => ({ kind: "returned" as const, m })),
      new Promise<{ kind: "blocked" }>((r) => setTimeout(() => r({ kind: "blocked" }), 300)),
    ]);
    expect(first.kind).toBe("returned");
    if (first.kind === "returned") expect(first.m.has("model-good")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    gate.resolve(okResponse(NEWER));
    await vi.waitFor(async () => expect(await has("model-newer")).toBe(true));
    expect(await has("model-good")).toBe(false);
    // 成功后 ts 刷新：不再 fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("多个调用方并发：全部立刻拿旧索引，只发一次刷新", async () => {
    seedGood(25 * HOUR);
    const gate = deferred<ReturnType<typeof okResponse>>();
    fetchMock.mockReturnValue(gate.promise);

    const results = await Promise.race([
      Promise.all([getModelsDevIndex(), getModelsDevIndex(), getModelsDevRouteIndex(), getModelsDevIndex()]),
      new Promise<null>((r) => setTimeout(() => r(null), 300)),
    ]);
    expect(results).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gate.resolve(okResponse(NEWER));
    await vi.waitFor(async () => expect(await has("model-newer")).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("过期 + 网络失败：立刻拿旧索引、warn 一条沿用旧索引、冷却内不再连打；冷却后重试成功就换成新的", async () => {
    seedGood(25 * HOUR);
    fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND models.dev"));
    fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND models.opencode.ai"));

    expect(await has("model-good")).toBe(true);
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("沿用旧索引");
    expect(fetchMock).toHaveBeenCalledTimes(2); // 两个镜像各试一次

    vi.setSystemTime(T0 + 30_000);
    expect(await has("model-good")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 冷却过后再试：成功 → 新索引
    fetchMock.mockResolvedValue(okResponse(NEWER));
    vi.setSystemTime(T0 + 61_000);
    expect(await has("model-good")).toBe(true); // 这一次仍给旧的（后台刷新）
    await vi.waitFor(async () => expect(await has("model-newer")).toBe(true));
  });

  it("刷新成功后好索引整体替换（两张表都换），失败冷却清零", async () => {
    seedGood(25 * HOUR);
    fetchMock.mockResolvedValue(okResponse(NEWER));
    await getModelsDevIndex();
    await vi.waitFor(async () => expect(await has("model-newer")).toBe(true));
    const route = await getModelsDevRouteIndex();
    expect(route.get("https://opencode.ai/zen")?.has("model-newer")).toBe(true);
    expect(route.get("https://opencode.ai/zen")?.has("model-good")).toBe(false);
  });

  it("成功后 inflight 句柄已清：再过期一次会再刷新一次（不会永远复用上次那个已完成的 promise）", async () => {
    // 冷启动成功一次 → 25 小时后过期 → 必须再发起第二次刷新。
    // 若成功时不把 slot.inflight 清成 null，之后每次过期都会命中「在途」分支、直接返回旧索引，永远不再刷新
    fetchMock.mockResolvedValue(okResponse(GOOD));
    expect(await has("model-good")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 25 * HOUR);
    fetchMock.mockResolvedValue(okResponse(NEWER));
    await getModelsDevIndex(); // 过期：立刻拿旧的，后台发起第二次刷新
    await vi.waitFor(async () => expect(await has("model-newer")).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("对照：没改的行为", () => {
  it("TTL 内（24 小时以内）不 fetch", async () => {
    seedGood(23 * HOUR);
    expect(await has("model-good")).toBe(true);
    await getModelsDevRouteIndex();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("冷启动 + 好目录：这一次调用就等到并拿到新索引（没有旧的可给，只能等）", async () => {
    fetchMock.mockResolvedValue(okResponse(GOOD));
    expect(await has("model-good")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 成功后进缓存：再调不 fetch
    await getModelsDevIndex();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("冷启动并发：几个调用方共用同一次 fetch、都等它完成后拿到新索引", async () => {
    const gate = deferred<ReturnType<typeof okResponse>>();
    fetchMock.mockReturnValue(gate.promise);
    const all = Promise.all([getModelsDevIndex(), getModelsDevIndex(), getModelsDevRouteIndex()]);
    // 还没放行时它们都在等（没有旧索引可给）
    const early = await Promise.race([all.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 100))]);
    expect(early).toBe("waiting");
    gate.resolve(okResponse(GOOD));
    const [idx, , route] = await all;
    expect(idx.has("model-good")).toBe(true);
    expect(route.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("第一个镜像 HTTP 失败 → 用第二个镜像（原有行为）", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce(okResponse(GOOD));
    expect(await has("model-good")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
