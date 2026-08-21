/**
 * models.dev 目录（OpenCode 同源）
 *
 * 自定义 /v1/models 没有 effort 元数据。按模型 id 查这份目录的 reasoning_options，
 * 命中才画档。缓存挂 globalThis，防 Next dev 多 chunk / HMR 各拉一份 4MB JSON。
 */

import {
  parseCatalogThinkingValues,
  type CatalogReasoning,
} from "@/lib/custom-effort";

const CATALOG_URLS = [
  "https://models.dev/api.json",
  "https://models.opencode.ai/api.json",
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_COOLDOWN_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

// 同 id 多条时的优先级。不按 URL / opencode-go 特殊处理——所有自定义提供方同一套查找。
const PROVIDER_RANK: Record<string, number> = {
  opencode: 0,
  openai: 1,
  anthropic: 2,
  google: 3,
  deepseek: 4,
  xai: 5,
  zhipuai: 6,
  moonshotai: 7,
  alibaba: 8,
};

const rankOf = (providerId: string): number =>
  PROVIDER_RANK[providerId] ?? 50;

type CatalogCache = {
  index: Map<string, CatalogReasoning>;
  ts: number;
  errorUntil: number;
  inflight: Promise<Map<string, CatalogReasoning>> | null;
};

const cacheSlot = (): CatalogCache => {
  const g = globalThis as unknown as {
    __flowshipModelsDev?: CatalogCache;
  };
  if (!g.__flowshipModelsDev) {
    g.__flowshipModelsDev = {
      index: new Map(),
      ts: 0,
      errorUntil: 0,
      inflight: null,
    };
  }
  return g.__flowshipModelsDev;
};

const consider = (
  index: Map<string, CatalogReasoning>,
  key: string,
  rec: CatalogReasoning,
) => {
  const k = key.trim().toLowerCase();
  if (!k) return;
  const prev = index.get(k);
  if (!prev || rankOf(rec.providerId) < rankOf(prev.providerId)) {
    index.set(k, rec);
  }
};

/** 从 api.json 建 id → reasoning 索引；同 id 优先 opencode，再官方实验室 */
export const buildModelsDevIndex = (
  catalog: unknown,
): Map<string, CatalogReasoning> => {
  const index = new Map<string, CatalogReasoning>();
  if (!catalog || typeof catalog !== "object") return index;
  for (const [providerId, provider] of Object.entries(
    catalog as Record<string, unknown>,
  )) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(
      models as Record<string, unknown>,
    )) {
      if (!model || typeof model !== "object") continue;
      const rec: CatalogReasoning = {
        providerId,
        reasoning: Boolean((model as { reasoning?: unknown }).reasoning),
        effortValues: parseCatalogThinkingValues(
          (model as { reasoning_options?: unknown }).reasoning_options,
        ),
      };
      consider(index, modelId, rec);
      const slash = modelId.lastIndexOf("/");
      if (slash >= 0) consider(index, modelId.slice(slash + 1), rec);
    }
  }
  return index;
};

export const lookupCatalogReasoning = (
  index: Map<string, CatalogReasoning>,
  modelId: string,
): CatalogReasoning | null => {
  const raw = modelId.trim();
  if (!raw) return null;
  const keys = [raw];
  const slash = raw.lastIndexOf("/");
  if (slash >= 0) keys.push(raw.slice(slash + 1));
  for (const key of keys) {
    const hit = index.get(key.toLowerCase());
    if (hit) return hit;
  }
  return null;
};

const fetchCatalogJson = async (): Promise<unknown> => {
  let lastErr: Error | null = null;
  for (const url of CATALOG_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Flowship",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastErr = new Error(`models.dev HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error("models.dev 拉取失败");
};

const loadIndex = async (): Promise<Map<string, CatalogReasoning>> => {
  const json = await fetchCatalogJson();
  return buildModelsDevIndex(json);
};

/** 24h 缓存；失败用旧索引，没有旧的就空表（列表照出、不猜档） */
export const getModelsDevIndex = async (): Promise<
  Map<string, CatalogReasoning>
> => {
  const slot = cacheSlot();
  if (slot.ts > 0 && Date.now() - slot.ts < CACHE_TTL_MS) return slot.index;
  // 失败冷却期内别连打目录；空表也算「这次不画档」
  if (slot.errorUntil > Date.now()) return slot.index;
  if (slot.inflight) return slot.inflight;
  const pending = loadIndex()
    .then((index) => {
      slot.index = index;
      slot.ts = Date.now();
      slot.errorUntil = 0;
      slot.inflight = null;
      return index;
    })
    .catch((err: unknown) => {
      slot.inflight = null;
      slot.errorUntil = Date.now() + ERROR_COOLDOWN_MS;
      if (slot.index.size > 0) return slot.index;
      console.warn(
        "[models-dev] 目录拉取失败，effort 不画：",
        err instanceof Error ? err.message : err,
      );
      return slot.index;
    });
  slot.inflight = pending;
  return pending;
};

export const resetModelsDevCatalogForTest = () => {
  const slot = cacheSlot();
  slot.index = new Map();
  slot.ts = 0;
  slot.errorUntil = 0;
  slot.inflight = null;
};

export const seedModelsDevCatalogForTest = (
  catalog: unknown,
  opts?: { ts?: number },
) => {
  const slot = cacheSlot();
  slot.index = buildModelsDevIndex(catalog);
  slot.ts = opts?.ts ?? Date.now();
  slot.errorUntil = 0;
  slot.inflight = null;
};
