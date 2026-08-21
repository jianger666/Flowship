/**
 * 自定义 provider 的思考档（Cursor SDK / 自定义 HTTP 同一套生成）
 *
 * 对齐 OpenCode `reasoningVariants`：有 type=effort 用目录原档；否则有
 * budget_tokens 合成 high / max。toggle 单独不画。一律前置 Default（不传思考覆盖）。
 * chip 文案用英文 value，不译中文。发送走 pi 的 thinkingLevelMap（none ↔ off）；
 * Default 不传 thinkingLevel。
 */

import type { ModelOption, ModelParameter } from "@/lib/types";

export type CustomThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const CUSTOM_EFFORT_PARAM_ID = "thinking";
/** 不覆盖上游默认；不是 off（off 会显式关思考） */
export const DEFAULT_THINKING_VALUE = "default";

const PI_LEVELS: CustomThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const LEVEL_SET = new Set<string>(PI_LEVELS);

export type CatalogReasoning = {
  reasoning: boolean;
  /** 可发给后端的档（effort 原档，或 budget 合成的 high/max）；不含 default */
  effortValues: string[];
  providerId: string;
};

export type ThinkingLevelMap = Partial<
  Record<CustomThinkingLevel, string | null>
>;

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

export const isThinkingParamId = (id: string): boolean => {
  const k = id.trim().toLowerCase();
  return k === "thinking" || k === "effort";
};

export const isDefaultThinkingValue = (value: string): boolean =>
  value.trim().toLowerCase() === DEFAULT_THINKING_VALUE;

/** chip 文案：Default 标题化，其余用协议原值 */
export const thinkingChipLabel = (value: string): string =>
  isDefaultThinkingValue(value) ? "Default" : value.trim();

export const hasBudgetTokens = (options: unknown): boolean =>
  Array.isArray(options) &&
  options.some(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "budget_tokens",
  );

/** 从 models.dev reasoning_options 抽出 effort 档（null / none → off） */
export const parseEffortValues = (options: unknown): string[] => {
  if (!Array.isArray(options)) return [];
  const effort = options.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "effort",
  );
  if (!effort || typeof effort !== "object") return [];
  const raw = (effort as { values?: unknown }).values;
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const v of raw) {
    if (v === null) {
      values.push("off");
      continue;
    }
    if (typeof v !== "string") continue;
    const id = v.trim().toLowerCase();
    if (!id || id === DEFAULT_THINKING_VALUE) continue;
    // models.dev 用 none，Cursor SDK / pi 用 off，UI 收成一套
    values.push(id === "none" ? "off" : id);
  }
  return unique(values);
};

/**
 * OpenCode 同款：effort 优先；没有 effort 但有 budget_tokens → high / max。
 * 所有自定义提供方同一套，不按 URL 分流。
 */
export const parseCatalogThinkingValues = (options: unknown): string[] => {
  const effort = parseEffortValues(options);
  if (effort.length > 0) return effort;
  if (hasBudgetTokens(options)) return ["high", "max"];
  return [];
};

const hasEffortParam = (m: ModelOption): boolean =>
  (m.parameters ?? []).some((p) => isThinkingParamId(p.id));

/** 有思考档时切模型落 Default，不再自动点第一档 */
export const defaultEffortValue = (
  values: readonly string[],
): string | undefined => {
  if (values.length === 0) return undefined;
  return DEFAULT_THINKING_VALUE;
};

export const effortParamFromValues = (
  values: string[],
): ModelParameter | null => {
  const levels = values.filter((v) => !isDefaultThinkingValue(v));
  if (levels.length === 0) return null;
  const chips = unique([DEFAULT_THINKING_VALUE, ...levels]);
  return {
    id: CUSTOM_EFFORT_PARAM_ID,
    displayName: "thinking",
    values: chips.map((value) => ({
      value,
      displayName: thinkingChipLabel(value),
    })),
  };
};

/** 自定义 provider：已有 thinking/effort 时补 Default + 英文标签。Cursor SDK 不走这里。 */
export const withDefaultThinkingParam = (
  param: ModelParameter,
): ModelParameter => {
  if (!isThinkingParamId(param.id)) return param;
  const rest = param.values.filter((v) => !isDefaultThinkingValue(v.value));
  const chips = [
    { value: DEFAULT_THINKING_VALUE, displayName: thinkingChipLabel(DEFAULT_THINKING_VALUE) },
    ...rest.map((v) => ({
      value: v.value,
      displayName: thinkingChipLabel(v.value),
    })),
  ];
  return {
    ...param,
    displayName: "thinking",
    values: chips,
  };
};

/** 目录命中且有可画档才补 chips；已有 thinking/effort 的只规范化 Default */
export const withCatalogEffort = (
  models: ModelOption[],
  lookup: (id: string) => CatalogReasoning | null,
): ModelOption[] =>
  models.map((m) => {
    if (hasEffortParam(m)) {
      return {
        ...m,
        parameters: (m.parameters ?? []).map(withDefaultThinkingParam),
      };
    }
    const hit = lookup(m.id);
    const param = effortParamFromValues(hit?.effortValues ?? []);
    if (!param) return m;
    return {
      ...m,
      parameters: [...(m.parameters ?? []), param],
      variants: m.variants?.length
        ? m.variants
        : [
            {
              params: [{ id: CUSTOM_EFFORT_PARAM_ID, value: DEFAULT_THINKING_VALUE }],
              displayName: m.displayName,
              isDefault: true,
            },
          ],
    };
  });

/** 未出现的档写 null，pi 会从 UI/循环里藏掉（xhigh/max 必须显式非 null 才出现） */
export const thinkingLevelMapFromValues = (
  values: readonly string[],
): ThinkingLevelMap => {
  const set = new Set(values);
  const map: ThinkingLevelMap = {};
  for (const level of PI_LEVELS) {
    if (level === "off") {
      map.off = set.has("none") || set.has("off") ? "none" : null;
      continue;
    }
    map[level] = set.has(level) ? level : null;
  }
  return map;
};

const asThinkingLevel = (raw: string): CustomThinkingLevel | null => {
  if (raw === "none") return "off";
  if (LEVEL_SET.has(raw)) return raw as CustomThinkingLevel;
  return null;
};

/**
 * 从 task.model.params 读 thinking。Default / 没带这档 → 不传（上游默认）。
 * 不在允许集里也当 Default，不再回落到第一档。
 */
export const thinkingLevelFromParams = (
  params?: Array<{ id: string; value: string }>,
  allowed?: readonly string[],
): CustomThinkingLevel | undefined => {
  const raw = params
    ?.find((p) => isThinkingParamId(p.id))
    ?.value?.trim()
    .toLowerCase();
  if (!raw || isDefaultThinkingValue(raw)) return undefined;
  const picked = asThinkingLevel(raw);
  if (!picked) return undefined;
  if (!allowed) return picked;
  const ok =
    allowed.includes(raw) ||
    (picked === "off" &&
      (allowed.includes("none") || allowed.includes("off")));
  return ok ? picked : undefined;
};

/** 构 pi 的 reasoning + thinkingLevelMap；目录没有就当不会思考 */
export const reasoningFieldsFromCatalog = (
  hit: CatalogReasoning | null,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } => {
  if (!hit?.reasoning) return { reasoning: false };
  if (hit.effortValues.length === 0) return { reasoning: true };
  return {
    reasoning: true,
    thinkingLevelMap: thinkingLevelMapFromValues(hit.effortValues),
  };
};
