/**
 * 当前 provider 的可选模型清单（含各模型的 effort 档）
 *
 * `/api/models` 路由与子代理工具（task）共用同一份：
 *   - cursor：凭 apiKey 调 Cursor SDK `models.list`（实测 5-15s，故缓存）
 *   - custom：baseUrl + apiKey + format 走自定义 provider 的 /v1/models，并按 models.dev 补 effort 档
 *
 * server 内存缓存 10 分钟（V0.7.13 起）：SDK models.list 慢，各入口（设置 / 新建任务 /
 * 切模型 / 子代理选模型）反复拉很折磨。cache key 与改造前路由完全一致。
 *
 * 并发合并 + 失败兜底（R14 Q11b-04）：冷缓存时设置页 / 新建任务 / 切模型 / 子代理 `model:list`
 * 会同时命中，同一个 key 只发一次底层请求（真实 5-15 秒一次）；过期后刷新失败（断网 / 端点挂了）
 * 有旧清单就返回旧清单（并进入 60 秒冷却，不让每次调用都陪着等满超时），只有冷启动失败才抛；
 * 例外：鉴权类拒绝（401 / 403，key 被撤销或过期）不沿用旧清单——丢缓存、照常抛（见 listModelOptions 的 err 分支）。
 * 缓存与 inflight 一起挂 globalThis（同 models-dev-catalog 口径：Next 多 bundle / HMR 不各存一份）。
 */

import { Cursor } from "@cursor/sdk";

import { redactUrlUserinfo } from "@/lib/custom-provider-url";
import { classifyErrorText } from "@/lib/error-classify";
import { visibleModelParameters } from "@/lib/model-params";
import type { CustomProviderFormat, ModelOption } from "@/lib/types";

import { listCustomModels } from "./custom-provider";

export type ModelCatalogSource =
  | { kind: "cursor"; apiKey: string }
  | {
      kind: "custom";
      apiKey: string;
      baseUrl: string;
      format: CustomProviderFormat;
    };

/** SDK 卡死时不能让调用方一直挂着、超过这个就当失败处理 */
export const SDK_TIMEOUT_MS = 15_000;

const CACHE_TTL_MS = 10 * 60 * 1000;
/** 过期后刷新失败、改用旧清单时的冷却：期间直接给旧清单，不每次调用都重新拉一遍（断网时每次要等满超时） */
export const STALE_RETRY_COOLDOWN_MS = 60_000;

type CacheEntry = {
  models: ModelOption[];
  ts: number;
  /** 上次刷新失败后改用旧清单；这个时间点之前不再重试 */
  retryAfter?: number;
};
type ModelCatalogState = {
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<ModelOption[]>>;
};

const state = (): ModelCatalogState => {
  const g = globalThis as unknown as {
    __flowshipModelCatalogV1?: ModelCatalogState;
  };
  g.__flowshipModelCatalogV1 ??= { cache: new Map(), inflight: new Map() };
  return g.__flowshipModelCatalogV1;
};

/** 测试用：清空缓存与 inflight（状态挂在 globalThis，不会随 vi.resetModules 重置） */
export const resetModelCatalogForTest = (): void => {
  const s = state();
  s.cache.clear();
  s.inflight.clear();
};

export const parseFormatParam = (v: unknown): CustomProviderFormat =>
  v === "anthropic" || v === "auto" ? v : "openai";

/** 缓存 key：自定义 provider 按 baseUrl+apiKey+format 区分、cursor 按 apiKey */
export const cacheKeyOf = (source: ModelCatalogSource): string =>
  source.kind === "cursor"
    ? `cursor-v3:${source.apiKey}`
    : `custom-v5:${source.baseUrl}:${source.format}:${source.apiKey}`;

/**
 * SDK 返回的 ModelListItem schema 比较杂、只挑前端实际要用的字段透传
 * 这样 SDK 升级加新字段不会立刻影响到前端 type / 攻击面也小
 */
const pickModelFields = (
  m: Awaited<ReturnType<typeof Cursor.models.list>>[number],
): ModelOption => ({
  id: m.id,
  displayName: m.displayName ?? m.id,
  description: m.description,
  parameters: visibleModelParameters(m.parameters),
  variants: m.variants,
});

/** 给一个 promise 加超时；超时 reject 一个特定 Error 让上层识别 */
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} 超时（${ms}ms）`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/** 命中且未过期的缓存；没有返回 null */
export const getCachedModelOptions = (
  source: ModelCatalogSource,
): ModelOption[] | null => {
  const hit = state().cache.get(cacheKeyOf(source));
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.models;
  return null;
};

/** 真正去拉（不碰缓存）：custom 走 /v1/models，cursor 走 SDK `models.list` */
const fetchModelOptions = async (
  source: ModelCatalogSource,
): Promise<ModelOption[]> => {
  if (source.kind === "custom") {
    return listCustomModels({
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      format: source.format,
    });
  }
  const models = await withTimeout(
    Cursor.models.list({ apiKey: source.apiKey }),
    SDK_TIMEOUT_MS,
    "拉取模型",
  );
  // 按 displayName 字母排序、避免 SDK 返回顺序看着乱
  return models
    .map(pickModelFields)
    .sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "en", {
        sensitivity: "base",
      }),
    );
};

/**
 * 拉可用模型列表（命中缓存毫秒级返回）。同一个 key 的并发请求合并成一次底层请求；
 * 过期后刷新失败且有旧清单 → 返回旧清单（warn 一条、60 秒内不再重试）；冷启动失败才抛错，
 * 由调用方决定怎么降级（路由转 502；子代理降级成「不校验 model id」）。
 * 刷新被鉴权拒绝（key 失效）时不沿用旧清单，丢缓存后同冷启动失败一样抛。
 */
export const listModelOptions = async (
  source: ModelCatalogSource,
): Promise<ModelOption[]> => {
  const s = state();
  const key = cacheKeyOf(source);
  const hit = s.cache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.models;
  // 上次刷新失败后的冷却内：直接给旧清单
  if (hit?.retryAfter && now < hit.retryAfter) return hit.models;

  const pending = s.inflight.get(key);
  if (pending) return pending;

  const run: Promise<ModelOption[]> = fetchModelOptions(source)
    .then(
      (options) => {
        s.cache.set(key, { models: options, ts: Date.now() });
        return options;
      },
      (err: unknown) => {
        const stale = s.cache.get(key);
        const rawMsg = err instanceof Error ? err.message : String(err);
        // 鉴权类拒绝（key 被撤销 / 过期，401 / 403）不沿用旧清单：旧清单是这把 key 以前有效时拿的，
        // 继续吐出去会把「key 已失效」藏到真的跑任务才暴露（还会每 60 秒重试一次、直到进程重启都不报错）。
        // 丢掉缓存、照常抛，让用户马上看到；断网 / 限流 / 5xx / 超时这类暂时性失败才沿用旧清单。
        if (!stale || classifyErrorText(rawMsg).kind === "auth") {
          if (stale) s.cache.delete(key);
          throw err;
        }
        const msg = redactUrlUserinfo(rawMsg);
        console.warn(
          `[model-catalog] 模型清单刷新失败，沿用 ${Math.round((Date.now() - stale.ts) / 60_000)} 分钟前的旧清单：${msg}`,
        );
        s.cache.set(key, {
          ...stale,
          retryAfter: Date.now() + STALE_RETRY_COOLDOWN_MS,
        });
        return stale.models;
      },
    )
    .finally(() => {
      if (s.inflight.get(key) === run) s.inflight.delete(key);
    });
  s.inflight.set(key, run);
  return run;
};
