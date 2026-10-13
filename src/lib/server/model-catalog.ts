/**
 * 当前 provider 的可选模型清单（含各模型的 effort 档）
 *
 * `/api/models` 路由与子代理工具（task）共用同一份：
 *   - cursor：凭 apiKey 调 Cursor SDK `models.list`（实测 5-15s，故缓存）
 *   - custom：baseUrl + apiKey + format 走自定义 provider 的 /v1/models，并按 models.dev 补 effort 档
 *
 * server 内存缓存 10 分钟（V0.7.13 起）：SDK models.list 慢，各入口（设置 / 新建任务 /
 * 切模型 / 子代理选模型）反复拉很折磨。cache key 与改造前路由完全一致。
 */

import { Cursor } from "@cursor/sdk";

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
const modelsCache = new Map<string, { models: ModelOption[]; ts: number }>();

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
  const hit = modelsCache.get(cacheKeyOf(source));
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.models;
  return null;
};

/**
 * 拉可用模型列表（命中缓存毫秒级返回）。失败抛错，由调用方决定怎么降级
 *（路由转 502；子代理降级成「不校验 model id」）。
 */
export const listModelOptions = async (
  source: ModelCatalogSource,
): Promise<ModelOption[]> => {
  const cached = getCachedModelOptions(source);
  if (cached) return cached;

  let options: ModelOption[];
  if (source.kind === "custom") {
    options = await listCustomModels({
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      format: source.format,
    });
  } else {
    const models = await withTimeout(
      Cursor.models.list({ apiKey: source.apiKey }),
      SDK_TIMEOUT_MS,
      "拉取模型",
    );
    // 按 displayName 字母排序、避免 SDK 返回顺序看着乱
    options = models
      .map(pickModelFields)
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "en", {
          sensitivity: "base",
        }),
      );
  }
  modelsCache.set(cacheKeyOf(source), { models: options, ts: Date.now() });
  return options;
};
