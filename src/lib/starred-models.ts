/**
 * 每个提供方最多 2 个常用模型（五角星钉住，不是使用次数）。
 * 默认模型仍是设置页 defaultModel，两套互不影响。
 */

export const STARRED_MODELS_PER_PROVIDER = 2;

export const starredIdsForProvider = (
  map: Record<string, string[]> | undefined,
  providerId: string,
): string[] => {
  const key = providerId.trim();
  if (!key) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of map?.[key] ?? []) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= STARRED_MODELS_PER_PROVIDER) break;
  }
  return out;
};

export const parseStarredModels = (raw: unknown): Record<string, string[]> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [providerId, ids] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const key = providerId.trim();
    if (!key) continue;
    if (!Array.isArray(ids)) continue;
    const cleaned = starredIdsForProvider({ [key]: ids.filter((x): x is string => typeof x === "string") }, key);
    if (cleaned.length > 0) out[key] = cleaned;
  }
  return out;
};

/** 点星：已钉则摘掉；未钉且未满则追加；已满返回 full，map 不动 */
export const toggleStarredModelId = (
  map: Record<string, string[]> | undefined,
  providerId: string,
  modelId: string,
): { next: Record<string, string[]>; starred: boolean; full: boolean } => {
  const key = providerId.trim();
  const id = modelId.trim();
  const current = { ...(map ?? {}) };
  if (!key || !id) return { next: current, starred: false, full: false };
  const list = starredIdsForProvider(current, key);
  if (list.includes(id)) {
    const nextList = list.filter((x) => x !== id);
    if (nextList.length === 0) delete current[key];
    else current[key] = nextList;
    return { next: current, starred: false, full: false };
  }
  if (list.length >= STARRED_MODELS_PER_PROVIDER) {
    return { next: current, starred: false, full: true };
  }
  current[key] = [...list, id];
  return { next: current, starred: true, full: false };
};
