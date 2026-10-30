/**
 * useModels：缓存命中的静默请求抢占在飞的非静默请求后，loading 不能永久为 true（R14 B6-1 / Q16-03）
 *
 * 旧写法：每次 fetchModels 一进来先 abort 在飞的请求。被 abort 的非静默请求，其 finally 因 `aborted` 不复位 loading
 * （注释假设「新请求接管」）；但新请求若是静默的（缓存命中且非 manual），入口里既不 setLoading(true)、也没人 setLoading(false)
 * ——loading 就卡在被抢占那条请求置的 true 上，刷新按钮永远转圈。
 *
 * 真实触发（同一条缝）：
 *  - 设置页用户点「验证」（manual，非静默）在飞时，改 Key 失焦 / 切 provider 又触发一次命中缓存的拉取；
 *  - 凭据 A（没有缓存、非静默）在飞时，用户切回有缓存的凭据 B（静默）。
 * 自定义 provider 卡里 `showManualModel = !loading && …`，loading 卡死会把「手填模型 ID」的逃生口一并藏起来。
 *
 * 观测手法：useModels 的 loading 是 React state，SSR 探针观察不到——用 tests/helpers/react-hook-stub.ts 的 dispatcher 桩真跑 hook，
 * 每次 `read()`（= 再 render 一次）拿到最新快照。fetch 桩尊重 init.signal（abort 时 reject AbortError），放行时机由测试控制。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useModels, type ModelsFetchInput } from "@/hooks/use-models";
import type { ModelOption } from "@/lib/types";

import { createHookHarness } from "./helpers/react-hook-stub";

const MODELS: ModelOption[] = [{ id: "m1", displayName: "Model One" }];
const OTHER_MODELS: ModelOption[] = [{ id: "m2", displayName: "Model Two" }];

const INPUT_A: ModelsFetchInput = { apiKey: "sk-aaaa", provider: "cursor" };
const INPUT_B: ModelsFetchInput = { apiKey: "sk-bbbb", provider: "cursor" };

interface Pending {
  signal: AbortSignal;
  resolve: (res: Response) => void;
}
const pendings: Pending[] = [];

const ok = (models: ModelOption[]) =>
  new Response(JSON.stringify({ models }), { status: 200 });

const storage = new Map<string, string>();

beforeEach(() => {
  pendings.length = 0;
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          pendings.push({ signal, resolve });
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 挂载 hook，返回「读最新快照」的函数；并先用 input 预热一份缓存（未命中缓存 → 非静默 → 成功后写缓存） */
const mountWithWarmCache = async (...warm: Array<[ModelsFetchInput, ModelOption[]]>) => {
  const harness = createHookHarness();
  const read = () => harness.render(() => useModels());
  read();
  harness.flushEffects();
  for (const [input, models] of warm) {
    const p = read().fetchModels(input);
    pendings[pendings.length - 1]?.resolve(ok(models));
    await p;
  }
  return { harness, read };
};

describe("静默请求抢占在飞的非静默请求（Q16-03）", () => {
  it("用户点「验证」（manual）在飞时，又来一次命中缓存的拉取：loading 立刻复位，不会永久转圈", async () => {
    const { read } = await mountWithWarmCache([INPUT_A, MODELS]);
    expect(read().loading).toBe(false);

    // manual：即使命中缓存也要转圈 + toast
    const manual = read().fetchModels(INPUT_A, { manual: true });
    expect(read().loading).toBe(true);

    // 改 Key 失焦 / 切 provider 等触发的非 manual 拉取：命中缓存 → 静默，并 abort 掉上面那条
    const background = read().fetchModels(INPUT_A);
    // 修前：true（被抢占的那条不复位，静默的这条也不碰 loading）
    expect(read().loading).toBe(false);

    pendings[pendings.length - 1]?.resolve(ok(MODELS));
    await Promise.all([manual, background]);
    expect(read().loading).toBe(false);
    expect(read().models).toEqual(MODELS);
  });

  it("凭据 A（无缓存、非静默）在飞时切回有缓存的凭据 B：loading 立刻复位，列表是 B 的缓存", async () => {
    const { read } = await mountWithWarmCache([INPUT_B, OTHER_MODELS]);

    const first = read().fetchModels(INPUT_A); // A 没有缓存：转圈
    expect(read().loading).toBe(true);
    expect(read().models).toEqual([]);

    const second = read().fetchModels(INPUT_B); // B 命中缓存：静默，抢占 A
    expect(read().loading).toBe(false); // 修前：true
    expect(read().models).toEqual(OTHER_MODELS);

    pendings[pendings.length - 1]?.resolve(ok(OTHER_MODELS));
    await Promise.all([first, second]);
    expect(read().loading).toBe(false);
  });
});

describe("对照：其它路径的 loading 行为不变", () => {
  it("manual 接 manual：后一条接管 loading，结束时复位", async () => {
    const { read } = await mountWithWarmCache([INPUT_A, MODELS]);

    const first = read().fetchModels(INPUT_A, { manual: true });
    const second = read().fetchModels(INPUT_A, { manual: true });
    expect(read().loading).toBe(true);

    // 让被抢占的 first 走完它的 AbortError → finally：它不能把 second 已接管的 loading 复位掉
    await first;
    expect(read().loading).toBe(true);

    pendings[pendings.length - 1]?.resolve(ok(MODELS));
    await second;
    expect(read().loading).toBe(false);
  });

  it("命中缓存的静默刷新：全程不转圈，回来后刷新列表", async () => {
    const { read } = await mountWithWarmCache([INPUT_A, MODELS]);

    const bg = read().fetchModels(INPUT_A);
    expect(read().loading).toBe(false);
    expect(read().models).toEqual(MODELS);

    pendings[pendings.length - 1]?.resolve(ok(OTHER_MODELS));
    await bg;
    expect(read().loading).toBe(false);
    expect(read().models).toEqual(OTHER_MODELS);
  });

  it("命中缓存的静默刷新失败：保留缓存列表、不报错", async () => {
    const { read } = await mountWithWarmCache([INPUT_A, MODELS]);

    const bg = read().fetchModels(INPUT_A);
    pendings[pendings.length - 1]?.resolve(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    await bg;
    expect(read().models).toEqual(MODELS);
    expect(read().error).toBe("");
    expect(read().loading).toBe(false);
  });

  it("无缓存的非静默请求：转圈，成功后复位", async () => {
    const { read } = await mountWithWarmCache();

    const p = read().fetchModels(INPUT_A);
    expect(read().loading).toBe(true);
    pendings[pendings.length - 1]?.resolve(ok(MODELS));
    await p;
    expect(read().loading).toBe(false);
    expect(read().models).toEqual(MODELS);
  });
});
