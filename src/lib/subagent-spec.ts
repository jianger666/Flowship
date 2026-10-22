/**
 * 子代理的入参解析 + 模型 / effort 解析（纯逻辑，pi 的 `task` 与 Cursor 的 `subagent` 共用）
 *
 * 之前的 pi `task` 工具声明了 model / subagentType，执行时却只用 prompt：子会话固定沿用
 * 父会话的模型和思考档，界面徽标却显示模型随手填的 model——显示与实际不符。
 * 这里把「模型怎么选 / effort 怎么填」收成一处，且**不静默回退**：填错就报错并列出可选项，
 * 让模型下一轮自己改对；实际生效什么，调用方拿到的就是什么。
 *
 * 范围（用户拍板）：只能选**当前 provider** 的模型；缺省 / inherit = 沿用当前模型
 *（含当前的思考档）。fast 变体不在代码里拦，也不再有规则约束
 * （原 `.cursor/rules/subagent-no-fast.mdc` 已按用户要求删除）；选不选 fast 由模型 / 用户自行决定。
 */

import {
  CUSTOM_EFFORT_PARAM_ID,
  isDefaultThinkingValue,
} from "@/lib/custom-effort";
import type { ModelOption, ModelParameter } from "@/lib/types";

export type SubagentType = "general" | "explore";

/**
 * 调用方能自己改对的错（prompt 空 / model 或 effort 无效）。
 * 工具层原样把 message 当工具错误回给模型；其它异常（子会话崩了等）才加「子任务失败」前缀。
 */
export class SubagentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentUsageError";
  }
}

export interface SubagentRequest {
  prompt: string;
  description?: string;
  subagentType: SubagentType;
  /** 原始 model 入参：空 / inherit = 沿用；list = 列出可选模型 */
  model?: string;
  /** 原始 effort 入参：空 / default = 不覆盖 */
  effort?: string;
  /**
   * 接着之前某个子代理继续（它上次返回的 agentId）。**只有 Cursor 的 `subagent` 工具支持**；
   * pi 的 `task` 入参里没有这个字段，收到也会明确拒绝（见 pi-coding-tools），不静默忽略。
   */
  resume?: string;
  /**
   * 后台运行：立刻返回、子代理在后台干活，做完把结果作为一条消息送回给调用方。
   * **只有 Cursor 的 `subagent` 工具在 chat 会话里支持**；pi 的 `task` 与非 chat 会话收到会明确拒绝，不静默忽略。
   */
  runInBackground?: boolean;
}

export interface ModelParamValue {
  id: string;
  value: string;
}

/** 与 SDK ModelSelection 同形（{ id, params? }） */
export interface SubagentModelSelection {
  id: string;
  params?: ModelParamValue[];
}

/** 一个模型能不能调 effort、能调哪几档（由 ModelOption 抽出，不含 default） */
export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  /** 思考档参数的 id（Cursor 可能是 thinking / effort）；没有 = 该模型不支持 effort */
  effortParamId?: string;
  efforts: string[];
  /**
   * 不指定 effort 时这个模型自己的默认档（取自清单里 `isDefault` 预设的思考档取值）。
   * 只给展示用（卡片徽标 / 过程记录）——真实请求不传 effort 就是走它，这里不参与任何校验。
   * 清单里没标默认预设 / 默认值不在可选档里（自定义 provider 的 Default 就是「不覆盖」）→ 缺省，不硬造。
   */
  defaultEffort?: string;
}

/** 只给「目录里查不到这个模型」时兜底校验用的通用档（与 pi 的 thinkingLevel 同集合） */
const GENERIC_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 模型清单在错误 / list 里最多列这么多条，防一个长清单把上下文灌满 */
export const MODEL_LIST_MAX = 60;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

/** 模型偶尔把布尔写成字符串；只认明确的 true / false，其余当没填 */
const bool = (v: unknown): boolean | undefined => {
  if (v === true || v === false) return v;
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return undefined;
};

/**
 * subagentType 收成两档：explore（只读：读 / 搜，不写不跑命令）与 general（其余一律）。
 * 模型照 Cursor 习惯会传 generalPurpose / explore / shell 等；这里只区分「要不要给写权限」。
 */
export const normalizeSubagentType = (raw: unknown): SubagentType => {
  const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (t === "explore" || t === "readonly" || t === "read-only") return "explore";
  return "general";
};

/** 工具描述（模型看到的说明）：pi 的 `task` 与 Cursor 的 `subagent` 共用，两边行为一致 */
export const SUBAGENT_TOOL_DESCRIPTION =
  "把一段独立子任务交给一个全新的子 agent 完成、返回其最终结果。用于把大任务拆小、隔离上下文。" +
  "子 agent 看不到当前对话，prompt 要写全背景、范围和期望产出；它不能再派子任务。" +
  "subagentType：explore = 只读（读 / 搜，不写文件不跑命令），其余 = 可读写、可跑命令。" +
  "model：省略或 inherit = 沿用当前模型（默认、推荐）；也可填当前 provider 里的模型 id；填 list 返回可选模型及各自的 effort 档。" +
  "effort：思考档（如 low / medium / high），省略 = 沿用当前模型的档位（换了模型则用该模型默认）；仅目标模型支持时可填，填错会报错并列出可选档。";

/** 入参 JSON Schema（Cursor customTools 用；pi 侧用等价的 TypeBox） */
export const SUBAGENT_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "子任务说明（要写全背景，子 agent 看不到当前对话）" },
    description: { type: "string", description: "3-5 个词的任务摘要（给用户看）" },
    subagentType: { type: "string", description: "explore = 只读；省略 = 可读写" },
    model: { type: "string", description: "省略 / inherit = 沿用当前模型；list = 列出可选模型" },
    effort: { type: "string", description: "思考档，省略 = 沿用" },
  },
  required: ["prompt"],
} as const;

export const parseSubagentRequest = (
  raw: unknown,
): { ok: true; request: SubagentRequest } | { ok: false; error: string } => {
  const p = isRecord(raw) ? raw : {};
  const prompt = str(p.prompt);
  if (!prompt) return { ok: false, error: "prompt 不能为空" };
  return {
    ok: true,
    request: {
      prompt,
      description: str(p.description),
      subagentType: normalizeSubagentType(p.subagentType),
      model: str(p.model),
      effort: str(p.effort),
      resume: str(p.resume),
      runInBackground: bool(p.run_in_background ?? p.runInBackground),
    },
  };
};

/**
 * effort 参数 id 按优先级找。Cursor SDK 的 id 不统一（2026-10-13 实测清单）：
 * `reasoning_effort`（Sonnet 5.5 / Gemini 3.8）、`effort`（Sonnet 5 / Gemini 3.7 / Sonnet 4.6）；
 * `thinking` 在 Cursor 里多是 `false|true` 开关、不是档位，只有自定义 provider
 *（models.dev 补出来的）才是 low/high 这类档位。
 */
const EFFORT_PARAM_PRIORITY = ["reasoning_effort", "effort", "thinking"] as const;
const isBooleanValue = (v: string): boolean => {
  const t = v.trim().toLowerCase();
  return t === "true" || t === "false";
};

/** 从模型参数里找 effort 档位参数；开关（只有 false|true）不算；去掉 default 档 */
export const findEffortParam = (
  parameters: readonly ModelParameter[] | undefined,
): { id: string; values: string[] } | null => {
  for (const wanted of EFFORT_PARAM_PRIORITY) {
    const p = (parameters ?? []).find((x) => x.id.trim().toLowerCase() === wanted);
    if (!p) continue;
    const values = p.values
      .map((v) => v.value)
      .filter((v) => !isDefaultThinkingValue(v));
    if (values.length === 0 || values.every(isBooleanValue)) continue;
    return { id: p.id, values };
  }
  return null;
};

/** 从 ModelOption 抽出 effort 能力（见 findEffortParam） */
export const catalogFromModelOptions = (
  options: readonly ModelOption[],
): ModelCatalogEntry[] =>
  options.map((m) => {
    const effort = findEffortParam(m.parameters);
    // 默认档：Cursor 清单里每个带档位的模型都标了一个 isDefault 预设，其 params 里就有它的档位取值
    const defaultRaw = effort
      ? m.variants?.find((v) => v.isDefault)?.params.find((p) => p.id === effort.id)
          ?.value
      : undefined;
    const defaultEffort =
      effort && defaultRaw && effort.values.includes(defaultRaw)
        ? defaultRaw
        : undefined;
    return {
      id: m.id,
      displayName: m.displayName,
      ...(effort ? { effortParamId: effort.id } : {}),
      efforts: effort?.values ?? [],
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  });

export const wantsModelList = (model: string | undefined): boolean =>
  model?.trim().toLowerCase() === "list";

/**
 * 只有显式选模型 / 写 effort / 要清单才需要模型目录；纯沿用不为此多一次网络往返。
 * （`list` 也算「显式选了」——它不是 inherit。）
 */
export const subagentNeedsCatalog = (req: {
  model?: string;
  effort?: string;
}): boolean => {
  const m = req.model?.trim().toLowerCase();
  return Boolean(req.effort?.trim()) || (!!m && m !== "inherit");
};

const describeEntry = (e: ModelCatalogEntry): string => {
  const name =
    e.displayName && e.displayName !== e.id ? `（${e.displayName}）` : "";
  const effort =
    e.efforts.length > 0 ? ` · effort: ${e.efforts.join(" | ")}` : "";
  return `- ${e.id}${name}${effort}`;
};

/** 给 model:"list" 和报错用：当前 provider 的可选模型 + 各自的 effort 档 */
export const formatModelCatalog = (
  catalog: readonly ModelCatalogEntry[],
  max = MODEL_LIST_MAX,
): string => {
  const shown = catalog.slice(0, max).map(describeEntry);
  const rest = catalog.length - shown.length;
  if (rest > 0) shown.push(`…另有 ${rest} 个未列出`);
  return shown.join("\n");
};

/** 精确 id → 忽略大小写 id → 唯一的 displayName；其余视为没有 */
const findEntry = (
  catalog: readonly ModelCatalogEntry[],
  wanted: string,
): ModelCatalogEntry | null => {
  const exact = catalog.find((e) => e.id === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  const ci = catalog.find((e) => e.id.toLowerCase() === lower);
  if (ci) return ci;
  const byName = catalog.filter(
    (e) => e.displayName && e.displayName.toLowerCase() === lower,
  );
  return byName.length === 1 ? byName[0] : null;
};

/**
 * 清单里某个模型的默认思考档（只给展示用）。model 的写法与 resolveSubagentModel 同口径
 *（精确 id → 忽略大小写 → 唯一 displayName）；清单拿不到 / 没这个模型 / 没标默认档 → undefined。
 */
export const catalogDefaultEffort = (
  catalog: readonly ModelCatalogEntry[] | null | undefined,
  modelId: string,
): string | undefined => {
  if (!catalog || !modelId.trim()) return undefined;
  return findEntry(catalog, modelId.trim())?.defaultEffort;
};

export type ResolvedSubagentModel =
  | {
      ok: true;
      model: SubagentModelSelection;
      /** 模型沿用父会话（缺省 / inherit / 与当前同 id） */
      inherited: boolean;
      /** 本次显式覆盖的 effort 档；undefined = 没覆盖 */
      effort?: string;
    }
  | { ok: false; error: string };

const unknownModelError = (
  wanted: string,
  catalog: readonly ModelCatalogEntry[],
): string =>
  `子代理模型无效：当前 provider 没有「${wanted}」。` +
  `省略 model 或填 inherit 表示沿用当前模型；可选模型：\n${formatModelCatalog(catalog)}`;

/**
 * 解析子代理要用的模型 + effort。
 *
 * - model 缺省 / inherit / 与当前同 id → 沿用父会话（模型与当前思考档都沿用）。
 * - 指定其它模型 → 必须在当前 provider 的目录里；该模型的思考档走它自己的默认
 *   （不把父会话的档位硬套过去——档位名对另一个模型可能根本不存在）。
 * - effort 显式给了 → 必须是目标模型支持的档；目标模型没有 effort 参数也报错，不静默丢。
 * - catalog 为 null（拿不到清单）→ 不强校验 model id（自定义端点常有清单外的可用 id），
 *   effort 只按通用档集合校验。
 */
export const resolveSubagentModel = (
  req: { model?: string; effort?: string },
  parent: SubagentModelSelection,
  catalog: readonly ModelCatalogEntry[] | null,
): ResolvedSubagentModel => {
  const wanted = req.model?.trim();
  const lower = wanted?.toLowerCase();
  const inherited =
    !wanted || lower === "inherit" || lower === parent.id.toLowerCase();

  let entry: ModelCatalogEntry | null = null;
  let childId = parent.id;
  if (inherited) {
    entry = catalog ? findEntry(catalog, parent.id) : null;
  } else if (catalog) {
    entry = findEntry(catalog, wanted!);
    if (!entry) return { ok: false, error: unknownModelError(wanted!, catalog) };
    childId = entry.id;
  } else {
    childId = wanted!;
  }

  const baseParams = inherited ? (parent.params ?? []) : [];
  const effortRaw = req.effort?.trim().toLowerCase();
  if (!effortRaw || isDefaultThinkingValue(effortRaw)) {
    return {
      ok: true,
      inherited,
      model: {
        id: childId,
        ...(baseParams.length > 0 ? { params: baseParams } : {}),
      },
    };
  }

  let values: readonly string[];
  let paramId: string;
  if (entry) {
    if (!entry.effortParamId || entry.efforts.length === 0) {
      return {
        ok: false,
        error: `模型「${entry.id}」没有 effort（思考档）参数，不能指定 effort；去掉 effort 或换一个支持的模型。`,
      };
    }
    values = entry.efforts;
    paramId = entry.effortParamId;
  } else {
    values = GENERIC_EFFORTS;
    paramId = CUSTOM_EFFORT_PARAM_ID;
  }
  // 目录里 models.dev 的 none 已被收成 off；模型照习惯可能还填 none
  const needle = effortRaw === "none" ? "off" : effortRaw;
  const matched = values.find((v) => v.toLowerCase() === needle);
  if (!matched) {
    return {
      ok: false,
      error: `模型「${childId}」不支持 effort=「${req.effort!.trim()}」，可选：${values.join(" | ")}（default = 不覆盖）。`,
    };
  }
  return {
    ok: true,
    inherited,
    effort: matched,
    model: {
      id: childId,
      params: [
        // 只替换同 id 的档位参数；Cursor 里 thinking 开关、fast 等其它参数原样保留
        ...baseParams.filter((p) => p.id !== paramId),
        { id: paramId, value: matched },
      ],
    },
  };
};

/**
 * 模型参数里「当前思考档」的取值（只给展示用：子代理卡片的 effort 徽标）。
 * 开关（true / false）、default、没有这个参数 → undefined（不硬造一个档位）。
 */
export const currentEffortValue = (
  params: readonly ModelParamValue[] | undefined,
): string | undefined => {
  for (const wanted of EFFORT_PARAM_PRIORITY) {
    const p = (params ?? []).find((x) => x.id.trim().toLowerCase() === wanted);
    if (!p) continue;
    const v = p.value.trim();
    if (!v || isDefaultThinkingValue(v) || isBooleanValue(v)) continue;
    return v;
  }
  return undefined;
};

/** model 入参是不是「沿用父会话」（缺省 / 空 / inherit）；与 resolveSubagentModel 同口径 */
export const isInheritModelArg = (model: unknown): boolean =>
  model === undefined ||
  model === null ||
  (typeof model === "string" &&
    (model.trim() === "" || model.trim().toLowerCase() === "inherit"));
