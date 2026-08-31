/**
 * models.dev 目录（OpenCode 同源）
 *
 * 自定义 /v1/models 没有 effort / 模态元数据。按模型 id 查这份目录的
 * reasoning_options 和 modalities.input。缓存挂 globalThis，防 Next dev
 * 多 chunk / HMR 各拉一份 4MB JSON。
 */

import {
  parseCatalogThinkingValues,
  type CatalogReasoning,
} from "@/lib/custom-effort";
import { normalizeCustomBaseUrl } from "@/lib/custom-provider-url";

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

/** 路由索引：归一化小写 baseURL → (模型 key → npm SDK 包名)。npm 决定该模型走哪个协议面。
 *  key 统一小写：lookup 侧对用户输入做 toLowerCase()，build 侧必须同口径、否则目录里
 *  带大写的 api URL 永远查不中。 */
export type ModelsDevRouteIndex = Map<string, Map<string, string>>;

type CatalogCache = {
  index: Map<string, CatalogReasoning>;
  routeIndex: ModelsDevRouteIndex;
  ts: number;
  errorUntil: number;
  inflight: Promise<void> | null;
};

const cacheSlot = (): CatalogCache => {
  const g = globalThis as unknown as {
    __flowshipModelsDevV2?: CatalogCache;
  };
  if (!g.__flowshipModelsDevV2) {
    g.__flowshipModelsDevV2 = {
      index: new Map(),
      routeIndex: new Map(),
      ts: 0,
      errorUntil: 0,
      inflight: null,
    };
  }
  return g.__flowshipModelsDevV2;
};

/** models.dev：`attachment: true` 或 `modalities.input` 含 image */
export const catalogModelHasImageInput = (model: unknown): boolean => {
  if (!model || typeof model !== "object") return false;
  const m = model as { attachment?: unknown; modalities?: unknown };
  if (m.attachment === true) return true;
  if (!m.modalities || typeof m.modalities !== "object") return false;
  const input = (m.modalities as { input?: unknown }).input;
  return Array.isArray(input) && input.some((x) => x === "image");
};

/** 给 pi Model.input：目录没命中当纯文本，避免往不认图的端点塞 image_url */
export const catalogPiInputModalities = (
  imageInput: boolean | null | undefined,
): Array<"text" | "image"> => (imageInput ? ["text", "image"] : ["text"]);

const consider = (
  index: Map<string, CatalogReasoning>,
  key: string,
  rec: CatalogReasoning,
) => {
  const k = key.trim().toLowerCase();
  if (!k) return;
  const prev = index.get(k);
  if (!prev || rankOf(rec.providerId) < rankOf(prev.providerId)) {
    index.set(k, {
      ...rec,
      imageInput: Boolean(rec.imageInput || prev?.imageInput),
    });
    return;
  }
  // 档位仍跟高优先级来源；图像能力任一来源标了就算
  if (rec.imageInput && !prev.imageInput) {
    index.set(k, { ...prev, imageInput: true });
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
        imageInput: catalogModelHasImageInput(model),
      };
      consider(index, modelId, rec);
      const slash = modelId.lastIndexOf("/");
      if (slash >= 0) consider(index, modelId.slice(slash + 1), rec);
    }
  }
  return index;
};

const routeConsider = (
  table: Map<string, string>,
  key: string,
  npm: string,
) => {
  const k = key.trim().toLowerCase();
  if (!k || !npm || table.has(k)) return;
  table.set(k, npm);
};

/**
 * 从 api.json 建协议路由索引：归一化 provider.api → (模型 key → npm)。
 * 只收带 `api` 字段的提供方（第一级闸门：baseURL 对不上就不启用自动路由）；
 * npm 取模型级 provider.npm、缺省回落提供方级 npm（opencode 客户端同款取法）。
 */
export const buildModelsDevRouteIndex = (
  catalog: unknown,
): ModelsDevRouteIndex => {
  const index: ModelsDevRouteIndex = new Map();
  if (!catalog || typeof catalog !== "object") return index;
  for (const provider of Object.values(
    catalog as Record<string, unknown>,
  )) {
    if (!provider || typeof provider !== "object") continue;
    const p = provider as { api?: unknown; npm?: unknown; models?: unknown };
    const api =
      typeof p.api === "string" && p.api.trim()
        ? normalizeCustomBaseUrl(p.api).toLowerCase()
        : "";
    if (!api) continue;
    if (!p.models || typeof p.models !== "object") continue;
    const providerNpm = typeof p.npm === "string" ? p.npm : "";
    let table = index.get(api);
    for (const [modelId, model] of Object.entries(
      p.models as Record<string, unknown>,
    )) {
      if (!model || typeof model !== "object") continue;
      const m = model as { provider?: unknown };
      const npm =
        m.provider && typeof m.provider === "object"
          ? (m.provider as { npm?: unknown }).npm
          : undefined;
      const resolved = typeof npm === "string" ? npm : providerNpm;
      if (!resolved) continue;
      if (!table) {
        table = new Map();
        index.set(api, table);
      }
      routeConsider(table, modelId, resolved);
      const slash = modelId.lastIndexOf("/");
      if (slash >= 0) routeConsider(table, modelId.slice(slash + 1), resolved);
    }
  }
  return index;
};

/**
 * 自动路由第二级：拿用户 baseUrl + 实拉到的模型 id 查目录 npm。
 * 第一级没命中（自建网关 / 目录外端点）返 null → 调用方回落 chat/completions。
 */
export const lookupCatalogNpm = (
  index: ModelsDevRouteIndex,
  baseUrl: string,
  modelId: string,
): string | null => {
  const api = normalizeCustomBaseUrl(baseUrl).toLowerCase();
  if (!api) return null;
  const table = index.get(api);
  if (!table || table.size === 0) return null;
  const raw = modelId.trim().toLowerCase();
  if (!raw) return null;
  const hit = table.get(raw);
  if (hit) return hit;
  const slash = raw.lastIndexOf("/");
  if (slash >= 0) {
    const tail = table.get(raw.slice(slash + 1));
    if (tail) return tail;
  }
  return null;
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

const loadIndexes = async (): Promise<{ index: Map<string, CatalogReasoning>; routeIndex: ModelsDevRouteIndex }> => {
  const json = await fetchCatalogJson();
  return {
    index: buildModelsDevIndex(json),
    routeIndex: buildModelsDevRouteIndex(json),
  };
};

/** 24h 缓存；失败用旧索引，没有旧的就空表（列表照出、不猜档） */
const refreshIndexes = async (): Promise<CatalogCache> => {
  const slot = cacheSlot();
  if (slot.ts > 0 && Date.now() - slot.ts < CACHE_TTL_MS) return slot;
  // 失败冷却期内别连打目录；空表也算「这次不画档」
  if (slot.errorUntil > Date.now()) return slot;
  if (slot.inflight) {
    await slot.inflight;
    return slot;
  }
  const pending = loadIndexes()
    .then((built) => {
      slot.index = built.index;
      slot.routeIndex = built.routeIndex;
      slot.ts = Date.now();
      slot.errorUntil = 0;
      slot.inflight = null;
    })
    .catch((err: unknown) => {
      slot.inflight = null;
      slot.errorUntil = Date.now() + ERROR_COOLDOWN_MS;
      if (slot.index.size === 0) {
        console.warn(
          "[models-dev] 目录拉取失败，effort 不画：",
          err instanceof Error ? err.message : err,
        );
      }
    });
  slot.inflight = pending;
  await pending;
  return slot;
};

export const getModelsDevIndex = async (): Promise<
  Map<string, CatalogReasoning>
> => (await refreshIndexes()).index;

export const getModelsDevRouteIndex = async (): Promise<ModelsDevRouteIndex> =>
  (await refreshIndexes()).routeIndex;

export const resetModelsDevCatalogForTest = () => {
  const slot = cacheSlot();
  slot.index = new Map();
  slot.routeIndex = new Map();
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
  slot.routeIndex = buildModelsDevRouteIndex(catalog);
  slot.ts = opts?.ts ?? Date.now();
  slot.errorUntil = 0;
  slot.inflight = null;
};
