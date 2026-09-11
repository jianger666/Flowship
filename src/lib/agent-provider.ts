/**
 * Agent provider 解析（client / server 共用、无 Node-only 依赖）
 *
 * - Cursor SDK 是固定第一项（id = `cursor`）
 * - 自定义条目在 settings.customProviders[]，窗口记住的是条目 id
 * - 旧档 `{ provider: "custom", customProvider: {…} }` 读盘时迁成一条 `cp_legacy`
 */

import type {
  AgentProviderId,
  CustomProviderConfig,
  CustomProviderFormat,
  FeAiFlowSettings,
  ModelSelection,
} from "@/lib/types";
import {
  CURSOR_PROVIDER_ID,
  CURSOR_PROVIDER_LABEL,
  LEGACY_CUSTOM_PROVIDER_ID,
  defaultModelForProvider,
  isCursorProvider,
} from "@/lib/types";
import { getSettings } from "@/lib/local-store";
import { resolveSessionModel } from "@/lib/task-model";

export interface ActiveModelCreds {
  apiKey: string;
  baseUrl?: string;
  format?: CustomProviderFormat;
}

export const newCustomProviderId = (): string =>
  `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const emptyCustomProvider = (): CustomProviderConfig => ({
  id: newCustomProviderId(),
  name: "",
  baseUrl: "",
  apiKey: "",
  format: "auto",
  defaultModel: { id: "" },
});

// 存量盘上显式写的 openai / anthropic 原样保留（当 override）；缺字段 / auto → auto
const parseFormat = (v: unknown): CustomProviderFormat => {
  if (v === "anthropic" || v === "openai") return v;
  return "auto";
};

const parseModelSelection = (raw: unknown): ModelSelection | undefined => {
  if (
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
  ) {
    return raw as ModelSelection;
  }
  return undefined;
};

export const hostNameFromUrl = (url: string): string => {
  try {
    return new URL(url).host || "";
  } catch {
    return "";
  }
};

export const customProviderDisplayName = (p: CustomProviderConfig): string =>
  p.name.trim() || hostNameFromUrl(p.baseUrl) || "未命名";

/** 有合法 http(s) 地址才算配好，才能出现在默认提供方 / 窗口下拉里 */
export const isCustomProviderReady = (p: CustomProviderConfig): boolean => {
  const url = p.baseUrl.trim();
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

export const providerDisplayName = (
  settings: Pick<FeAiFlowSettings, "customProviders"> | null | undefined,
  id: string,
): string => {
  if (isCursorProvider(id)) return CURSOR_PROVIDER_LABEL;
  const row = settings?.customProviders?.find((p) => p.id === id);
  return row ? customProviderDisplayName(row) : "自定义提供方";
};

const parseOneCustom = (
  raw: unknown,
  fallbackId?: string,
): CustomProviderConfig | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  let id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id || id === CURSOR_PROVIDER_ID || id === "custom") {
    id = fallbackId ?? newCustomProviderId();
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const defaultModel = parseModelSelection(o.defaultModel);
  return {
    id,
    name,
    baseUrl: typeof o.baseUrl === "string" ? o.baseUrl.trim() : "",
    apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
    format: parseFormat(o.format),
    ...(defaultModel ? { defaultModel } : {}),
  };
};

/**
 * 读盘迁移：旧单槽 customProvider → customProviders[]；
 * `provider: "custom"` → 迁后那条的 id。
 */
export const migrateProviderSettings = (parsed: {
  provider?: unknown;
  customProvider?: unknown;
  customProviders?: unknown;
}): { provider: AgentProviderId; customProviders: CustomProviderConfig[] } => {
  let list: CustomProviderConfig[] = [];
  if (Array.isArray(parsed.customProviders) && parsed.customProviders.length > 0) {
    const seen = new Set<string>();
    for (const item of parsed.customProviders) {
      const row = parseOneCustom(item);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      list.push(row);
    }
  } else {
    const legacy = parseOneCustom(
      parsed.customProvider,
      LEGACY_CUSTOM_PROVIDER_ID,
    );
    if (legacy?.baseUrl) {
      if (!legacy.name) legacy.name = hostNameFromUrl(legacy.baseUrl);
      list = [legacy];
    }
  }

  let provider =
    typeof parsed.provider === "string" && parsed.provider.trim()
      ? parsed.provider.trim()
      : CURSOR_PROVIDER_ID;
  if (provider === "custom") {
    provider =
      list.find((p) => p.id === LEGACY_CUSTOM_PROVIDER_ID && isCustomProviderReady(p))
        ?.id ??
      list.find(isCustomProviderReady)?.id ??
      CURSOR_PROVIDER_ID;
  }
  if (
    provider !== CURSOR_PROVIDER_ID &&
    !list.some((p) => p.id === provider && isCustomProviderReady(p))
  ) {
    provider = CURSOR_PROVIDER_ID;
  }
  return { provider, customProviders: list };
};

export const findCustomProvider = (
  settings: Pick<FeAiFlowSettings, "customProviders"> | null | undefined,
  id: string,
): CustomProviderConfig | undefined =>
  settings?.customProviders?.find((p) => p.id === id);

/**
 * 切提供方准入的最小任务面（前后端同款、直接传整个 task/meta，现场推 currentAction）。
 * 传散状态容易前后端漂移，别拆开传 runStatus/currentActionStatus/repoStatus。
 */
export interface ProviderSwitchTaskLike {
  mode?: string;
  runStatus?: string;
  repoStatus?: string;
  sessionAgentId?: string;
  currentActionId?: string | null;
  actions?: Array<{ id: string; status: string }>;
}

/** 当前步骤是否真在跑（只有 running 算活）。
 *
 * 注意 awaiting_ack 不算活：去掉手动「通过」按钮后、action 会在 awaiting_ack
 * 停留到下次推进（推进时隐式认可），run 早已结束、没有活会话——此时锁死会导致
 * task 模式几乎永远切不了提供方（v1.9.14 用户实测）。切的安全由三处兜底：
 * setTaskProvider 清 sessionAgentId 锚点、复用时提供方对不上强制 fresh、
 * 交卷后流式尾巴由 runStatus=running + 详情页 runActive latch + 后端复判覆盖。
 */
const hasRunningAction = (task: ProviderSwitchTaskLike): boolean => {
  const cur = (task.actions ?? []).find((a) => a.id === task.currentActionId);
  return cur?.status === "running";
};

/**
 * 提供方能不能再切（V2a：chat 空闲可切；task 空闲可切、running/终态锁）。
 * - chat：runStatus running → 锁；其余放行（有锚点也行，切时清锚点、下轮 create）。
 * - task：runStatus running → 锁；repoStatus merged/abandoned → 锁；
 *   当前 action 为 running → 锁（注意这是 action 状态、不是 runStatus）；
 *   awaiting_ack 不锁（run 已结束、等的是人审阅不是 agent 干活，见 hasRunningAction）；
 *   runStatus idle/awaiting_user/error + 无运行中步骤 → 放行（error 正是换家重试的场景）。
 * 不做原生 resume、不做自动故障转移，切即丢精细上下文。
 */
export const isProviderSwitchLocked = (task: ProviderSwitchTaskLike): boolean => {
  if (task.mode !== "chat" && task.mode !== "task") return true;
  if (task.runStatus === "running") return true;
  if (task.mode === "chat") return false;
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned")
    return true;
  if (hasRunningAction(task)) return true;
  return false;
};

/**
 * 内存会话的提供方跟当前提供方是不是同一家。
 * cursor 家不分 id；自定义按条目 id 精确比（两条自定义锚点同形、这里必须按 id 比）。
 */
export const isSameProvider = (a: string, b: string): boolean => {
  if (isCursorProvider(a) && isCursorProvider(b)) return true;
  return a === b;
};

/** pi 会话落在 dataRoot/pi-sessions，Cursor 的 agentId 是 UUID */
export const sessionAgentIdLooksCustom = (id: string): boolean =>
  id.includes("pi-sessions");

/** 落盘锚点能不能用这个 provider resume（跨 Cursor / 自定义必开新会话）。
 * 两条自定义之间锚点形态一样（都是 pi-sessions），分不开——切提供方时由
 * setTaskProvider 清掉 sessionAgentId，禁止拿 B 的凭据 resume A 的会话。
 */
export const sessionMatchesProvider = (
  sessionAgentId: string | undefined,
  providerId: string,
): boolean => {
  if (!sessionAgentId) return true;
  return (
    sessionAgentIdLooksCustom(sessionAgentId) === !isCursorProvider(providerId)
  );
};

/**
 * 切提供方时落到 task.model 的值。
 * 有合法 id 就换成新提供方的默认模型；没有就清空——两套模型 id 空间不同，
 * 绝不能把 Cursor 的 composer-2.5 留到 DeepSeek 上（对话里切过去会看起来像「沿用上一家」）。
 */
export const modelForProviderSwitch = (
  incoming?: ModelSelection | null,
): ModelSelection | undefined => {
  const id = incoming?.id?.trim();
  if (!id) return undefined;
  return incoming?.params?.length
    ? { id, params: incoming.params }
    : { id };
};

/**
 * 本窗口该用哪个 provider：
 * - 有合法 task.provider → 用它（设置页默认改了也不劫持）
 * - 老任务没字段：pi 锚点 → 迁后的自定义，否则 cursor
 */
export const resolveTaskProvider = (
  task: { provider?: string; sessionAgentId?: string },
  settings: Pick<FeAiFlowSettings, "customProviders"> | null | undefined,
): AgentProviderId => {
  const list = settings?.customProviders ?? [];
  const known = (id: string | undefined): AgentProviderId | null => {
    if (!id) return null;
    if (id === CURSOR_PROVIDER_ID) return CURSOR_PROVIDER_ID;
    if (id === "custom") {
      const legacy = list.find((p) => p.id === LEGACY_CUSTOM_PROVIDER_ID);
      if (legacy) return legacy.id;
      return list.find(isCustomProviderReady)?.id ?? null;
    }
    // 条目还在就认（哪怕地址被清空）——交给凭据校验失败，不要悄悄改跑 Cursor
    return list.some((p) => p.id === id) ? id : null;
  };
  const fromTask = known(task.provider);
  if (fromTask) return fromTask;
  // 窗口绑过、但条目已删 / 地址被清空 → 不偷列表里别的自定义
  if (task.provider) return CURSOR_PROVIDER_ID;
  if (task.sessionAgentId && sessionAgentIdLooksCustom(task.sessionAgentId)) {
    return (
      known(LEGACY_CUSTOM_PROVIDER_ID) ??
      list.find(isCustomProviderReady)?.id ??
      CURSOR_PROVIDER_ID
    );
  }
  return CURSOR_PROVIDER_ID;
};

export const getModelCredsForProvider = (
  settings: Pick<FeAiFlowSettings, "apiKey" | "customProviders">,
  providerId: string,
): ActiveModelCreds => {
  if (isCursorProvider(providerId)) {
    return { apiKey: settings.apiKey ?? "" };
  }
  const cp = findCustomProvider(settings, providerId);
  if (!cp?.baseUrl.trim()) return { apiKey: "" };
  return {
    apiKey: cp.apiKey ?? "",
    baseUrl: cp.baseUrl,
    format: cp.format ?? "openai",
  };
};

export const hasModelCredsForProvider = (
  settings: Pick<FeAiFlowSettings, "apiKey" | "customProviders">,
  providerId: string,
): boolean => {
  if (isCursorProvider(providerId)) return !!settings.apiKey?.trim();
  const cp = findCustomProvider(settings, providerId);
  return !!cp && isCustomProviderReady(cp);
};

/**
 * bootArgs / resume 有没有带 apiKey 字段。
 * 自定义本地端点允许空串；只有缺字段（undefined）才算没传。
 */
export const isApiKeyFieldPresent = (apiKey: unknown): apiKey is string =>
  typeof apiKey === "string";

/** 设置页「默认提供方」的凭据（新建对话 / 就绪清单） */
export const getActiveModelCreds = (): ActiveModelCreds => {
  const s = getSettings();
  return getModelCredsForProvider(s, s.provider ?? CURSOR_PROVIDER_ID);
};

export const hasActiveModelCreds = (): boolean => {
  const s = getSettings();
  return hasModelCredsForProvider(s, s.provider ?? CURSOR_PROVIDER_ID);
};

export const bootArgsForTask = (
  task: {
    provider?: string;
    sessionAgentId?: string;
    model?: ModelSelection;
    actions?: Parameters<typeof resolveSessionModel>[0]["actions"];
  },
  settings: FeAiFlowSettings = getSettings(),
): { apiKey: string; model: ModelSelection; providerId: AgentProviderId } => {
  const providerId = resolveTaskProvider(task, settings);
  const creds = getModelCredsForProvider(settings, providerId);
  const fallback = defaultModelForProvider(settings, providerId);
  // 跟说话条 / runner 同口径：最近 action.agentModel → task.model → 设置页默认。
  // 只读 task.model 会拿建任务时的旧模型（如 grok），跟输入条显示的 Composer 对不上。
  const sessionModel = resolveSessionModel({
    model: task.model,
    actions: task.actions ?? [],
  });
  const model = sessionModel?.id?.trim()
    ? sessionModel
    : task.model?.id?.trim()
      ? task.model
      : fallback.id.trim()
        ? fallback
        : { id: "" };
  return { apiKey: creds.apiKey, model, providerId };
};

export type ProviderOption = { value: string; label: string };

/** 设置页 / composer 共用：Cursor SDK + 已配好的自定义（没填地址的草稿不进下拉） */
export const listProviderOptions = (
  settings: Pick<FeAiFlowSettings, "customProviders">,
): ProviderOption[] => [
  { value: CURSOR_PROVIDER_ID, label: CURSOR_PROVIDER_LABEL },
  ...(settings.customProviders ?? [])
    .filter(isCustomProviderReady)
    .map((p) => ({
      value: p.id,
      label: customProviderDisplayName(p),
    })),
];
