/**
 * 飞书对话遥控器（/chats 一家）：手机上看电脑的聊天、切对话、新对话、换模型、搜。
 *
 * 定位：手机是遥控器、电脑是大脑——不另起对话体系。
 * - 直接打字 = 续聊当前对话（p2p 原有路由，不动）；
 * - 这张遥控器只给「当前对话指针」配手机 UI：换对话 / 新对话 / 换模型 / 搜。
 * - 手机点的和电脑看到的是同一批 tasks（同一份 task-fs），不存在两边对不上的问题。
 *
 * 三个拍板（2026-09-03 用户）：
 * 1. 模型候选 = 默认模型 + 星标（设置页现成，每提供方 1+2），再加【全部模型】；
 * 2. 新对话默认跟随当前仓库（仍可改）；
 * 3. 列表默认只看活跃 + 归档开关。
 *
 * 卡片一律“点击时重算”：value 只带参数、不带快照，不做终态 patch（cleanup 卡那套不需要）。
 * 依赖方向：本模块静态只挂 task-fs / bridge-state / settings-fs / agent-provider 等轻依赖；
 * task-runner（prewarm）与 Cursor SDK（拉全量模型）一律运行时动态 import。
 */

import {
  defaultModelForProvider,
  isCursorProvider,
  type ModelOption,
  type ModelSelection,
  type Task,
  type TaskSummary,
} from "@/lib/types";
import { starredIdsForProvider } from "@/lib/starred-models";
import {
  createTask,
  getTask,
  listTasks,
  setTaskModel,
} from "@/lib/server/task-fs";
import {
  getCurrentChatTaskId,
  getEndedChatTaskIds,
  removeEndedChatTaskId,
  setAwaitingChatSearch,
  setCurrentChatTaskId,
  takeAwaitingChatSearch,
} from "./bridge-state";
import { readSettingsFile } from "@/lib/server/settings-fs";
import {
  findCustomProvider,
  migrateProviderSettings,
} from "@/lib/agent-provider";
import { shortHash } from "./card-stream";
import {
  getBotAppInfo,
  sendInteractiveCard,
  sendTextMessage,
} from "./lark-api";
import type { CardButtonValue } from "./types";

// ----------------- 常量 -----------------

/** 对话列表每页（手机屏：一屏 3 个对话刚好） */
export const CHAT_PANEL_PAGE_SIZE = 6;
/** 仓库 / 全量模型每页 */
export const PANEL_LIST_PAGE_SIZE = 8;
/** 搜索最多回几个：6 = 恰一页，不翻页（翻页按钮回填不下关键词，见 R5：多页必串味） */
export const PANEL_SEARCH_MAX = 6;

// ----------------- 可注入依赖（单测 mock 外部调用） -----------------

export interface ChatsPanelDeps {
  listTasks: typeof listTasks;
  getTask: typeof getTask;
  createTask: typeof createTask;
  setTaskModel: typeof setTaskModel;
  getCurrentChatTaskId: typeof getCurrentChatTaskId;
  setCurrentChatTaskId: typeof setCurrentChatTaskId;
  getEndedChatTaskIds: typeof getEndedChatTaskIds;
  removeEndedChatTaskId: typeof removeEndedChatTaskId;
  takeAwaitingChatSearch: typeof takeAwaitingChatSearch;
  setAwaitingChatSearch: typeof setAwaitingChatSearch;
  readSettingsFile: typeof readSettingsFile;
  /** 全量模型（默认走 SDK / 自定义端点；单测桩掉，免得真打外部） */
  fetchAllModels: (provider: string) => Promise<ModelOption[]>;
  sendOwnerText: (text: string) => Promise<unknown>;
  sendOwnerCard: (
    card: unknown,
  ) => Promise<{ message_id: string; card_id: string }>;
  prewarm: (taskId: string) => void;
  warn: (msg: string) => void;
}

const defaultDeps = (): ChatsPanelDeps => ({
  listTasks: () => listTasks(),
  getTask: (id) => getTask(id),
  createTask: (input) => createTask(input),
  setTaskModel: (id, model) => setTaskModel(id, model),
  getCurrentChatTaskId: () => getCurrentChatTaskId(),
  setCurrentChatTaskId: (id) => setCurrentChatTaskId(id),
  getEndedChatTaskIds: () => getEndedChatTaskIds(),
  removeEndedChatTaskId: (id) => removeEndedChatTaskId(id),
  takeAwaitingChatSearch: () => takeAwaitingChatSearch(),
  setAwaitingChatSearch: () => setAwaitingChatSearch(),
  readSettingsFile: () => readSettingsFile(),
  fetchAllModels: (provider) => defaultFetchAllModels(provider),
  sendOwnerText: async (text) => {
    const info = await getBotAppInfo();
    return sendTextMessage(info.ownerOpenId, text);
  },
  sendOwnerCard: async (card) => {
    const info = await getBotAppInfo();
    return sendInteractiveCard(info.ownerOpenId, card);
  },
  prewarm: (taskId) => {
    import("@/lib/server/task-runner")
      .then((m) => m.prewarmTaskWorkspace(taskId))
      .catch((err) =>
        getDeps().warn(
          `prewarm 失败（不影响建对话）: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  },
  warn: (msg) => console.warn(`[feishu-bridge/chats-panel] ${msg}`),
});

let depsOverride: Partial<ChatsPanelDeps> | null = null;

const getDeps = (): ChatsPanelDeps =>
  depsOverride ? { ...defaultDeps(), ...depsOverride } : defaultDeps();

/** 单测替换依赖；传 null 恢复默认 */
export const __setChatsPanelDepsForTest = (
  partial: Partial<ChatsPanelDeps> | null,
): void => {
  depsOverride = partial;
};

// ----------------- 小工具（纯） -----------------

/** 仓库 path 取尾巴（/a/b/crm-web → crm-web），空 = 未绑仓库 */
export const repoTailOf = (repoPaths: string[] | undefined): string =>
  repoTailOfAll(repoPaths)[0] ?? "未绑仓库";

/** 多仓任务列表展示：尾巴全列（`crm-web、pay`），空 = 未绑仓库 */
export const repoTailsLabel = (repoPaths: string[] | undefined): string => {
  const tails = repoTailOfAll(repoPaths);
  return tails.length > 0 ? tails.join("、") : "未绑仓库";
};

const repoTailOfAll = (repoPaths: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of repoPaths ?? []) {
    const tail = p.trim().replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (tail && !seen.has(tail)) {
      seen.add(tail);
      out.push(tail);
    }
  }
  return out;
};

/** 时间戳 → MM-DD HH:mm（列表行内时间） */
export const fmtPanelTime = (ts: number | undefined): string => {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 模型 id → 按钮短文案（按钮 20 字上限：先缩常见后缀，还超再截） */
export const shortModelLabel = (id: string): string => {
  const s = id.trim();
  if (s.length <= 20) return s;
  const shrunk = s
    .replace(/-contributor-free$/, "（C免）")
    .replace(/-contributor$/, "（C）")
    .replace(/-free$/, "（免）");
  if (shrunk.length <= 20) return shrunk;
  return `${shrunk.slice(0, 19)}…`;
};

const panelShell = (
  title: string,
  elements: unknown[],
  template = "blue",
): Record<string, unknown> => ({
  schema: "2.0",
  config: { update_multi: true },
  header: {
    title: { tag: "plain_text", content: title.slice(0, 50) },
    template,
  },
  body: { elements },
});

type ChatsOp = Extract<CardButtonValue, { kind: "chats" }>;

const chatsButton = (
  value: Omit<ChatsOp, "kind">,
  label: string,
  elementId: string,
  type: "default" | "primary" | "danger" = "default",
): unknown => ({
  tag: "button",
  element_id: elementId,
  text: { tag: "plain_text", content: label.slice(0, 20) },
  type,
  size: "medium",
  behaviors: [{ type: "callback", value: { kind: "chats", ...value } satisfies CardButtonValue }],
});

const chatsRowButtonId = (prefix: string, key: string): string =>
  `${prefix}${shortHash(key)}`;

// ----------------- 卡片构建（纯、无副作用） -----------------

export interface PanelCurrent {
  id: string;
  title: string;
  repoTail: string;
  modelId: string;
}

/**
 * 遥控器主卡：当前对话 + 换对话 / 新对话 / 换模型。
 * 无当前对话时不放换模型（点了也是教你先选，少一次无效往返）。
 */
export const buildChatsPanelCard = (
  current: PanelCurrent | null,
  activeCount: number,
): Record<string, unknown> => {
  const elements: unknown[] = [];
  if (current) {
    elements.push({
      tag: "markdown",
      element_id: "md_cur",
      content: `**正在聊**：${current.title || current.id}\n${current.repoTail} · ${current.modelId}`,
    });
  } else {
    elements.push({
      tag: "markdown",
      element_id: "md_cur",
      content: `还没有当前对话（进行中 ${activeCount} 个），下面直接新开一个`,
    });
  }
  elements.push({ tag: "hr", element_id: "hr_panel" });
  elements.push(chatsButton({ op: "list" }, "换对话", "btn_chats_list"));
  elements.push(
    chatsButton({ op: "new" }, "新对话", "btn_chats_new", current ? "default" : "primary"),
  );
  if (current) {
    elements.push(chatsButton({ op: "model", taskId: current.id }, "换模型", "btn_chats_model"));
  }
  return panelShell("对话遥控器", elements);
};

export interface PanelChatRow {
  id: string;
  title: string;
  repoTail: string;
  modelId: string;
  timeText: string;
  archived: boolean;
}

/** 对话列表卡：每行标题 + 一行小字 + 切过去按钮；底部翻页/仓库/新对话/搜/归档 */
export const buildChatListCard = (opts: {
  rows: PanelChatRow[];
  page: number;
  totalPages: number;
  total: number;
  currentId?: string;
  /**
   * 筛选用的完整仓库 path（空串 = 未绑仓库那一堆）；展示尾巴由内部派生。
   * 注意：按钮回填的必须是这个完整 path——之前回填尾巴，listPanelChats 全路径
   * 精确比对不上，筛选后点下一页必空（P0）。
   */
  repo?: string;
  archived?: boolean;
  title?: string;
}): Record<string, unknown> => {
  const elements: unknown[] = [];
  const repoTail = opts.repo === undefined ? undefined : opts.repo === "" ? "未绑仓库" : repoTailOf([opts.repo]);
  if (opts.rows.length === 0) {
    elements.push({
      tag: "markdown",
      element_id: "md_empty",
      content: "这里没有对话，换个筛选或新开一个",
    });
  }
  for (const r of opts.rows) {
    const mark = r.id === opts.currentId ? " ← 当前" : "";
    const flag = r.archived ? "（归档）" : "";
    elements.push({
      tag: "markdown",
      element_id: chatsRowButtonId("r", r.id),
      content: `**${r.title || r.id}**${flag}${mark}\n${r.repoTail} · ${r.modelId}${r.timeText ? ` · ${r.timeText}` : ""}`,
    });
    elements.push(
      chatsButton(
        { op: "switch", taskId: r.id },
        r.archived ? "切回去" : "切过去",
        chatsRowButtonId("e", r.id),
      ),
    );
  }
  elements.push({ tag: "hr", element_id: "hr_nav" });
  if (opts.page > 0) {
    elements.push(
      chatsButton(
        {
          op: "list",
          page: opts.page - 1,
          ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
          ...(opts.archived ? { archived: true } : {}),
        },
        "上一页",
        "btn_list_prev",
      ),
    );
  }
  if (opts.page < opts.totalPages - 1) {
    elements.push(
      chatsButton(
        {
          op: "list",
          page: opts.page + 1,
          ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
          ...(opts.archived ? { archived: true } : {}),
        },
        `下一页（${opts.total}）`,
        "btn_list_next",
      ),
    );
  }
  elements.push(chatsButton({ op: "repos", purpose: "switch" }, "按仓库找", "btn_list_repos"));
  elements.push(chatsButton({ op: "new" }, "新对话", "btn_list_new"));
  elements.push(chatsButton({ op: "search_hint" }, "搜标题/仓库/模型", "btn_list_search"));
  elements.push(
    chatsButton(
      {
        op: "list",
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        ...(opts.archived ? {} : { archived: true }),
      },
      opts.archived ? "只看进行中" : "含归档",
      "btn_list_arch",
    ),
  );
  const head = opts.title ?? (repoTail ? `对话列表 · ${repoTail}` : "对话列表");
  return panelShell(head, elements);
};

export interface PanelRepoStat {
  /** 完整 path；空串 = 未绑仓库那一堆 */
  path: string;
  tail: string;
  count: number;
}

/** 仓库选择卡：purpose=switch 进筛选列表，purpose=new 进选模型 */
export const buildRepoListCard = (opts: {
  repos: PanelRepoStat[];
  page: number;
  totalPages: number;
  purpose: "switch" | "new";
}): Record<string, unknown> => {
  const elements: unknown[] = [];
  if (opts.repos.length === 0) {
    elements.push({
      tag: "markdown",
      element_id: "md_empty",
      content: "设置页里还没配仓库，先去电脑上配一个",
    });
  }
  for (const r of opts.repos) {
    elements.push(
      chatsButton(
        opts.purpose === "new"
          ? { op: "new_model", repo: r.path }
          : { op: "repo", repo: r.path },
        `${r.tail}（${r.count}）`,
        chatsRowButtonId("rp", `${opts.purpose}:${r.path || "~"}`),
      ),
    );
  }
  elements.push({ tag: "hr", element_id: "hr_nav" });
  if (opts.page > 0) {
    elements.push(
      chatsButton(
        { op: "repos", purpose: opts.purpose, page: opts.page - 1 },
        "上一页",
        "btn_repo_prev",
      ),
    );
  }
  if (opts.page < opts.totalPages - 1) {
    elements.push(
      chatsButton(
        { op: "repos", purpose: opts.purpose, page: opts.page + 1 },
        "下一页",
        "btn_repo_next",
      ),
    );
  }
  if (opts.purpose === "new") {
    elements.push(
      chatsButton({ op: "create", repo: "" }, "跳过选仓直接建", "btn_repo_skip"),
    );
  } else {
    elements.push(chatsButton({ op: "list" }, "全部对话", "btn_repo_all"));
  }
  return panelShell(opts.purpose === "new" ? "新对话选仓库" : "按仓库找对话", elements);
};

export interface ModelQuickOption {
  id: string;
  /** 默认 / 星标 */
  tag: "默认" | "星标";
}

export interface ModelCardCtx {
  taskId?: string;
  forNew?: boolean;
  repo?: string;
}

/** 模型选择卡：当前 + 默认/星标快捷 + 全部模型 */
export const buildModelCard = (opts: {
  currentModelId: string;
  providerLabel: string;
  quick: ModelQuickOption[];
  ctx: ModelCardCtx;
}): Record<string, unknown> => {
  const elements: unknown[] = [];
  elements.push({
    tag: "markdown",
    element_id: "md_cur_model",
    content: `**当前模型**：${opts.currentModelId}\n提供方：${opts.providerLabel}`,
  });
  elements.push({ tag: "hr", element_id: "hr_models" });
  for (const q of opts.quick) {
    elements.push(
      chatsButton(
        { op: "model_set", modelId: q.id, ...opts.ctx },
        `${q.tag} · ${shortModelLabel(q.id)}`,
        chatsRowButtonId("m", q.id),
      ),
    );
  }
  elements.push(
    chatsButton({ op: "models_all", ...opts.ctx }, "全部模型", "btn_models_all"),
  );
  elements.push(chatsButton({ op: "panel" }, "回遥控器", "btn_back_panel"));
  return panelShell(opts.ctx.forNew ? "新对话选模型" : "换模型", elements);
};

/** 全量模型卡：单页 8 个，当前打 ✓ */
export const buildAllModelsCard = (opts: {
  models: Array<{ id: string; display: string }>;
  page: number;
  totalPages: number;
  total: number;
  currentModelId: string;
  ctx: ModelCardCtx;
}): Record<string, unknown> => {
  const elements: unknown[] = [];
  for (const m of opts.models) {
    const cur = m.id === opts.currentModelId ? "✓ " : "";
    elements.push(
      chatsButton(
        { op: "model_set", modelId: m.id, ...opts.ctx },
        `${cur}${shortModelLabel(m.display || m.id)}`,
        chatsRowButtonId("am", m.id),
      ),
    );
  }
  elements.push({ tag: "hr", element_id: "hr_nav" });
  if (opts.page > 0) {
    elements.push(
      chatsButton(
        { op: "models_all", page: opts.page - 1, ...opts.ctx },
        "上一页",
        "btn_am_prev",
      ),
    );
  }
  if (opts.page < opts.totalPages - 1) {
    elements.push(
      chatsButton(
        { op: "models_all", page: opts.page + 1, ...opts.ctx },
        `下一页（${opts.total}）`,
        "btn_am_next",
      ),
    );
  }
  elements.push(chatsButton({ op: "panel" }, "回遥控器", "btn_back_panel"));
  return panelShell("全部模型", elements);
};

// ----------------- 数据与逻辑 -----------------

export interface PanelProviderBrief {
  provider: string;
  providerLabel: string;
  defaultModelId: string;
  starredIds: string[];
  /** 设置页配的仓库 path（去重保序） */
  repos: string[];
  disabledMcpServers: string[];
  /** 建对话的门：没凭据直接拒，不建死对话 */
  hasCreds: boolean;
  /**
   * 目标提供方已不在（旧对话绑的自定义 provider 被删了）。
   * 此时默认/星标/目录全无意义，调用方直接拒、指去电脑设置页。
   */
  providerGone?: boolean;
}

/**
 * 从设置文件读某提供方 + 默认/星标模型 + 仓库（遥控器的数据底）。
 * 不传 = 当前窗口提供方；传 task 的 provider = 按那个对话的提供方取
 *（用户可能在建对话后换过窗口默认，直接用当前会拿错候选）。
 */
export const readPanelProviderBrief = async (
  providerOverride?: string,
): Promise<PanelProviderBrief | null> => {
  let result: Awaited<ReturnType<typeof readSettingsFile>>;
  try {
    result = await getDeps().readSettingsFile();
  } catch {
    return null;
  }
  if (!result || result.status !== "ok") return null;
  const raw = result.settings as Record<string, unknown>;
  const migrated = migrateProviderSettings(raw);
  // 目标提供方：对话自带的优先；未知 id（自定义被删）不硬套当前，直接标 gone
  const want = providerOverride?.trim() || migrated.provider;
  const known = isCursorProvider(want) || migrated.customProviders.some((p) => p.id === want);
  const provider = known ? want : migrated.provider;
  const providerGone = !known;
  const settings = {
    defaultModel: (raw.defaultModel as ModelSelection | undefined) ?? { id: "" },
    customProviders: migrated.customProviders,
    provider,
  };
  const defaultModelId = defaultModelForProvider(settings, provider).id.trim();
  const starredIds = starredIdsForProvider(
    raw.starredModels as Record<string, string[]> | undefined,
    provider,
  );
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw.repos) ? raw.repos : []) {
    const p =
      r && typeof r === "object"
        ? String((r as { path?: unknown }).path ?? "").trim().replace(/\/+$/, "")
        : "";
    if (p && !seen.has(p)) {
      seen.add(p);
      repos.push(p);
    }
  }
  const disabledMcpServers = Array.isArray(raw.disabledMcpServers)
    ? (raw.disabledMcpServers as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  // 凭据门对齐 loadBridgeBootContext：cursor 看 apiKey，自定义看 baseUrl
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const custom = findCustomProvider({ customProviders: migrated.customProviders }, provider);
  const hasCreds = isCursorProvider(provider)
    ? !!apiKey
    : !!custom?.baseUrl?.trim();
  const providerLabel = isCursorProvider(provider)
    ? "Cursor"
    : (custom?.name?.trim() || provider);
  return {
    provider,
    providerLabel,
    defaultModelId,
    starredIds,
    repos,
    disabledMcpServers,
    hasCreds,
    ...(providerGone ? { providerGone: true as const } : {}),
  };
};

/** 快捷模型：默认 1 个 + 星标（去重保序） */
export const modelQuickOptions = (
  brief: Pick<PanelProviderBrief, "defaultModelId" | "starredIds">,
): ModelQuickOption[] => {  const out: ModelQuickOption[] = [];
  const seen = new Set<string>();
  if (brief.defaultModelId.trim()) {
    seen.add(brief.defaultModelId.trim());
    out.push({ id: brief.defaultModelId.trim(), tag: "默认" });
  }
  for (const id of brief.starredIds ?? []) {
    const t = id.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ id: t, tag: "星标" });
  }
  return out;
};

/**
 * 语义层校验：modelId 是不是该提供方真可选的（快捷命中免拉目录，否则对照全量目录）。
 * parse 拦“错类型”，这里拦“对类型、错值”——伪造回调没有签名保护，只能靠白名单。
 * 目录拉失败时宁可拒（指去重试），也不把坏 id 写进任务（下次启动才炸、更难查）。
 */
export const checkPanelModelId = async (
  modelId: string,
  provider?: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const id = modelId.trim();
  if (!id || id.length > 200 || /[\s,;'"\\]/.test(id)) {
    return { ok: false, error: "模型 id 非法，重新选一个" };
  }
  const brief = await readPanelProviderBrief(provider).catch(() => null);
  if (!brief) return { ok: false, error: "设置读不到，先去电脑上确认配置" };
  if (brief.providerGone) return { ok: false, error: "这个对话的提供方已经没了，去电脑设置页看看" };
  if (brief.defaultModelId === id || brief.starredIds.includes(id)) return { ok: true };
  let models: ModelOption[];
  try {
    models = await getDeps().fetchAllModels(brief.provider);
  } catch {
    return { ok: false, error: "模型列表拉取失败，稍后再试" };
  }
  return models.some((m) => m.id === id)
    ? { ok: true }
    : { ok: false, error: "这个模型不在可选列表里，重新选一个" };
};

/**
 * 语义层校验：仓库 path 是不是可选范围（设置页配的 + 已有对话绑过的 + 空=不绑）。
 * 过滤用的 repo 值伪造了最多筛出空列表，但建对话会把坏 path 落盘，必须拦。
 */
export const isAllowedPanelRepo = async (repoPath: string): Promise<boolean> => {
  const repo = repoPath.trim().replace(/\/+$/, "");
  if (!repo) return true;
  if (repo.includes("..") || repo.length > 500) return false;
  const [brief, all] = await Promise.all([
    readPanelProviderBrief().catch(() => null),
    getDeps().listTasks().catch((): TaskSummary[] => []),
  ]);
  if (brief?.repos.includes(repo)) return true;
  return all.some(
    (t) =>
      t.mode === "chat" &&
      (t.repoPaths ?? []).map((p) => p.trim().replace(/\/+$/, "")).includes(repo),
  );
};

const toPanelRow = (t: TaskSummary, archived: boolean): PanelChatRow => ({
  id: t.id,
  title: t.title || t.id,
  repoTail: repoTailsLabel(t.repoPaths),
  modelId: t.model?.id?.trim() || "未设置",
  timeText: fmtPanelTime(t.updatedAt),
  archived,
});

/** 当前对话（指针 + 校验仍在）：失效返 null，不抛 */
export const getPanelCurrent = async (): Promise<PanelCurrent | null> => {
  try {
    const id = await getDeps().getCurrentChatTaskId();
    if (!id) return null;
    const all = await getDeps().listTasks();
    const hit = all.find((t) => t.id === id && t.mode === "chat");
    if (!hit) return null;
    return {
      id: hit.id,
      title: hit.title || hit.id,
      repoTail: repoTailsLabel(hit.repoPaths),
      modelId: hit.model?.id?.trim() || "未设置",
    };
  } catch {
    return null;
  }
};

/**
 * 遥控器对话列表：只看 chat 任务、按更新时间倒序。
 * 刻意**不设活跃时间窗**（listActiveChatTasks 那套会藏旧对话，手机上找的就是旧的）。
 * repo 传完整 path 精确筛；空串 = 只看未绑仓库。
 */
export const listPanelChats = async (opts: {
  repo?: string;
  includeArchived?: boolean;
} = {}): Promise<PanelChatRow[]> => {
  let all: TaskSummary[] = [];
  let ended: string[] = [];
  try {
    [all, ended] = await Promise.all([
      getDeps().listTasks(),
      getDeps().getEndedChatTaskIds(),
    ]);
  } catch {
    return [];
  }
  const endedSet = new Set(ended);
  return all
    .filter((t) => t.mode === "chat")
    .filter((t) => {
      if (opts.repo === undefined) return true;
      const paths = (t.repoPaths ?? []).map((p) => p.trim().replace(/\/+$/, ""));
      if (opts.repo === "") return paths.length === 0;
      return paths.includes(opts.repo);
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((t) => toPanelRow(t, endedSet.has(t.id)))
    .filter((r) => opts.includeArchived || !r.archived);
};

/** 关键词搜：标题 / 仓库尾巴 / 模型都不区分大小写，归档也搜（标出来），最多回一组 */
export const searchPanelChats = async (keyword: string): Promise<PanelChatRow[]> => {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const rows = await listPanelChats({ includeArchived: true });
  return rows
    .filter((r) =>
      `${r.title} ${r.repoTail} ${r.modelId}`.toLowerCase().includes(kw),
    )
    .slice(0, PANEL_SEARCH_MAX);
};

/** 切对话：校验还在 + 复活归档 + 刷指针。返回文案直接可回执。 */
export const switchPanelChat = async (
  taskId: string,
): Promise<{ ok: true; title: string } | { ok: false; error: string }> => {
  let all: TaskSummary[] = [];
  try {
    all = await getDeps().listTasks();
  } catch {
    return { ok: false, error: "对话列表读不出来，稍后重试" };
  }
  const hit = all.find((t) => t.id === taskId && t.mode === "chat");
  if (!hit) return { ok: false, error: "这个对话不在了，重新选一个" };
  try {
    // 回复旧卡片同款复活语义：归档过的切回去即重新激活
    await getDeps().removeEndedChatTaskId(taskId);
    await getDeps().setCurrentChatTaskId(taskId);
  } catch {
    return { ok: false, error: "切换失败，稍后重试" };
  }
  return { ok: true, title: hit.title || hit.id };
};

/**
 * 遥控器建对话：对齐 app 一键新建 + /new（MCP 黑名单跟设置页默认）。
 * 模型缺省跟默认模型；仓库缺省不绑（调用方传了才绑——默认跟随当前仓由出卡侧填好）。
 */
export const createPanelChat = async (opts: {
  repoPath?: string;
  modelId?: string;
  title?: string;
}): Promise<{ ok: true; taskId: string; title: string } | { ok: false; error: string }> => {
  const brief = await readPanelProviderBrief();
  if (!brief) return { ok: false, error: "设置读不到，先去电脑上确认配置" };
  if (!brief.hasCreds) return { ok: false, error: "缺少 API Key 或模型凭据，请先在设置页配置" };
  const modelId = opts.modelId?.trim() || brief.defaultModelId;
  if (!modelId) return { ok: false, error: "没有默认模型，请先在设置页配置默认模型" };
  const repo = opts.repoPath?.trim().replace(/\/+$/, "") ?? "";
  let task: Task;
  try {
    task = await getDeps().createTask({
      title: opts.title?.trim() || `飞书对话 ${new Date().toLocaleString("zh-CN")}`,
      mode: "chat",
      repoPaths: repo ? [repo] : [],
      model: { id: modelId },
      provider: brief.provider,
      disabledMcpServers:
        brief.disabledMcpServers.length > 0 ? brief.disabledMcpServers : undefined,
    });
  } catch (err) {
    return { ok: false, error: `建对话失败：${err instanceof Error ? err.message : String(err)}` };
  }
  getDeps().prewarm(task.id);
  try {
    await getDeps().setCurrentChatTaskId(task.id);
  } catch {
    // 指针没刷上只是下次说话进兜底，对话本身建好了——不算失败
  }
  return { ok: true, taskId: task.id, title: task.title };
};

/**
 * 给对话换模型：只落盘、下一轮 agent 启动生效（跟设置页切模型同款）。
 * 跑步中拒绝——切了也不会生效，还容易让人误会已经换了。
 * thinking 档（params）沿用旧的：那是档位偏好、跟模型 id 正交。
 */
export const setPanelChatModel = async (
  taskId: string,
  modelId: string,
): Promise<{ ok: true; title: string } | { ok: false; error: string }> => {
  const id = modelId.trim();
  if (!id) return { ok: false, error: "模型 id 为空，重新选一个" };
  let task: Task | null;
  try {
    task = await getDeps().getTask(taskId);
  } catch {
    return { ok: false, error: "对话读不出来，稍后重试" };
  }
  if (!task || task.mode !== "chat") return { ok: false, error: "这个对话不在了" };
  if (task.runStatus === "running") {
    return { ok: false, error: "这轮还没跑完，等跑完再切（切模型下一轮才生效）" };
  }
  try {
    const next = await getDeps().setTaskModel(taskId, {
      id,
      ...(task.model?.params ? { params: task.model.params } : {}),
    });
    if (!next) return { ok: false, error: "这个对话不在了" };
  } catch (err) {
    return { ok: false, error: `切换失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, title: task.title || task.id };
};

/** 全量模型：cursor 走 SDK，自定义走端点 /v1/models。慢（5-15s）但低频，调用方先回“正在拉取”。 */
const MODEL_LIST_TIMEOUT_MS = 20_000;

/**
 * 在途去重：同 key 并发只飞一次，后到的挂同一个 promise。
 * settle 后删 key（成功也删——下次点重新拉，目录可能变了；要缓存另做 TTL）。
 */
export const dedupInflight = <T,>(
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> => {
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
};

const allModelsInflight = new Map<string, Promise<ModelOption[]>>();

export const defaultFetchAllModels = async (provider: string): Promise<ModelOption[]> =>
  dedupInflight(allModelsInflight, provider.trim() || "cursor", () =>
    fetchAllModelsUncached(provider),
  );

const fetchAllModelsUncached = async (provider: string): Promise<ModelOption[]> => {
  let result: Awaited<ReturnType<typeof readSettingsFile>>;
  try {
    result = await readSettingsFile();
  } catch {
    throw new Error("设置读不到");
  }
  if (!result || result.status !== "ok") throw new Error("设置读不到");
  const raw = result.settings as Record<string, unknown>;
  if (isCursorProvider(provider)) {
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
    if (!apiKey) throw new Error("缺少 API Key，请先在设置页配置");
    const { Cursor } = await import("@cursor/sdk");
    const models = await new Promise<Awaited<ReturnType<typeof Cursor.models.list>>>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error("拉取超时")), MODEL_LIST_TIMEOUT_MS);
        Cursor.models
          .list({ apiKey })
          .then((v) => {
            clearTimeout(t);
            resolve(v);
          })
          .catch((e) => {
            clearTimeout(t);
            reject(e);
          });
      },
    );
    const seen = new Set<string>();
    return models
      .map((m): ModelOption => ({ id: m.id, displayName: m.displayName ?? m.id }))
      .filter((m) => m.id.trim() && !seen.has(m.id) && (seen.add(m.id), true))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }));
  }
  const migrated = migrateProviderSettings(raw);
  const entry = findCustomProvider({ customProviders: migrated.customProviders }, provider);
  if (!entry?.baseUrl?.trim()) throw new Error("自定义 provider  baseUrl 缺失");
  const { listCustomModels } = await import("@/lib/server/custom-provider");
  return listCustomModels({
    baseUrl: entry.baseUrl.trim(),
    apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
    format: entry.format ?? "openai",
  });
};

// ----------------- 出卡与回调 -----------------

const clampPage = (page: number | undefined, totalPages: number): number => {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.floor(page as number)), Math.max(0, totalPages - 1));
};

/** /chats：遥控器主卡 */
export const showChatsPanel = async (): Promise<"handled"> => {
  try {
    const [current, all, ended] = await Promise.all([
      getPanelCurrent(),
      getDeps().listTasks().catch((): TaskSummary[] => []),
      getDeps().getEndedChatTaskIds().catch((): string[] => []),
    ]);
    const endedSet = new Set(ended);
    const activeCount = all.filter((t) => t.mode === "chat" && !endedSet.has(t.id)).length;
    await getDeps().sendOwnerCard(buildChatsPanelCard(current, activeCount));
  } catch (err) {
    await getDeps()
      .sendOwnerText(`遥控器打开失败：${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
  }
  return "handled";
};

/** 换对话列表卡（recent / 按仓 / 含归档 / 搜索结果共用一张） */
export const showChatListCard = async (opts: {
  repo?: string;
  archived?: boolean;
  page?: number;
  title?: string;
  rows?: PanelChatRow[];
}): Promise<"handled"> => {
  try {
    const rows = opts.rows ?? (await listPanelChats({ repo: opts.repo, includeArchived: opts.archived }));
    const totalPages = Math.max(1, Math.ceil(rows.length / CHAT_PANEL_PAGE_SIZE));
    const page = clampPage(opts.page, totalPages);
    const current = await getPanelCurrent().catch(() => null);
    await getDeps().sendOwnerCard(
      buildChatListCard({
        rows: rows.slice(page * CHAT_PANEL_PAGE_SIZE, page * CHAT_PANEL_PAGE_SIZE + CHAT_PANEL_PAGE_SIZE),
        page,
        totalPages,
        total: rows.length,
        ...(current ? { currentId: current.id } : {}),
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        ...(opts.archived ? { archived: true } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      }),
    );
  } catch (err) {
    await getDeps()
      .sendOwnerText(`列表打开失败：${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
  }
  return "handled";
};

/** 仓库选择卡（purpose=switch 进筛选，purpose=new 进选模型） */
export const showRepoListCard = async (opts: {
  purpose: "switch" | "new";
  page?: number;
}): Promise<"handled"> => {
  try {
    const [all, brief] = await Promise.all([
      getDeps().listTasks().catch((): TaskSummary[] => []),
      readPanelProviderBrief().catch(() => null),
    ]);
    // 电脑对话里出现过的仓优先 + 设置页配的仓补齐（配了但还没聊过也可选）
    const counts = new Map<string, number>();
    for (const t of all) {
      if (t.mode !== "chat") continue;
      const paths = (t.repoPaths ?? []).map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean);
      if (paths.length === 0) {
        counts.set("", (counts.get("") ?? 0) + 1);
      } else {
        for (const p of new Set(paths)) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
    for (const p of brief?.repos ?? []) {
      if (!counts.has(p)) counts.set(p, 0);
    }
    const stats: PanelRepoStat[] = [...counts.entries()]
      .map(([path, count]) => ({
        path,
        tail: path === "" ? "未绑仓库" : repoTailOf([path]),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.tail.localeCompare(b.tail, "zh"));
    const totalPages = Math.max(1, Math.ceil(stats.length / PANEL_LIST_PAGE_SIZE));
    const page = clampPage(opts.page, totalPages);
    await getDeps().sendOwnerCard(
      buildRepoListCard({
        repos: stats.slice(page * PANEL_LIST_PAGE_SIZE, page * PANEL_LIST_PAGE_SIZE + PANEL_LIST_PAGE_SIZE),
        page,
        totalPages,
        purpose: opts.purpose,
      }),
    );
  } catch (err) {
    await getDeps()
      .sendOwnerText(`仓库列表打开失败：${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
  }
  return "handled";
};

/** 模型选择卡：给现有对话换，或给新对话挑（ctx.forNew + repo） */
export const showModelCard = async (ctx: ModelCardCtx = {}): Promise<"handled"> => {
  try {
    let currentModelId = "未设置";
    let taskId = ctx.taskId;
    // 候选跟对话自带的提供方走（用户可能在建对话后换过窗口默认，跟当前会拿错）
    let provider: string | undefined;
    if (!ctx.forNew) {
      if (!taskId) {
        const cur = await getPanelCurrent();
        taskId = cur?.id;
      }
      if (!taskId) {
        await getDeps().sendOwnerText("还没有当前对话，先换一个或新开一个");
        return await showChatsPanel();
      }
      const task = await getDeps().getTask(taskId).catch(() => null);
      if (!task || task.mode !== "chat") {
        await getDeps().sendOwnerText("这个对话不在了，重新选一个");
        return await showChatsPanel();
      }
      currentModelId = task.model?.id?.trim() || "未设置";
      provider = task.provider?.trim() || undefined;
    }
    const brief = await readPanelProviderBrief(provider);
    if (!brief) {
      await getDeps().sendOwnerText("设置读不到，先去电脑上确认配置");
      return "handled";
    }
    if (brief.providerGone) {
      await getDeps().sendOwnerText("这个对话的提供方已经没了，去电脑设置页看看");
      return "handled";
    }
    await getDeps().sendOwnerCard(
      buildModelCard({
        currentModelId,
        providerLabel: brief.providerLabel,
        quick: modelQuickOptions(brief),
        ctx: ctx.forNew ? { forNew: true, ...(ctx.repo ? { repo: ctx.repo } : {}) } : { taskId },
      }),
    );
  } catch (err) {
    await getDeps()
      .sendOwnerText(`模型选择打开失败：${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
  }
  return "handled";
};

/** 全量模型卡：先回“正在拉取”（SDK 5-15s），再出卡 */
export const showAllModelsCard = async (
  ctx: ModelCardCtx = {},
  page = 0,
): Promise<"handled"> => {
  try {
    let currentModelId = "";
    let provider = "";
    if (!ctx.forNew) {
      let taskId = ctx.taskId;
      if (!taskId) taskId = (await getPanelCurrent())?.id;
      if (!taskId) {
        await getDeps().sendOwnerText("还没有当前对话，先换一个或新开一个");
        return await showChatsPanel();
      }
      const task = await getDeps().getTask(taskId).catch(() => null);
      if (!task || task.mode !== "chat") {
        await getDeps().sendOwnerText("这个对话不在了，重新选一个");
        return await showChatsPanel();
      }
      currentModelId = task.model?.id?.trim() ?? "";
      provider = task.provider?.trim() ?? "";
      ctx = { taskId };
    }
    if (!provider) {
      const brief = await readPanelProviderBrief();
      provider = brief?.provider ?? "";
    }
    if (!provider) {
      await getDeps().sendOwnerText("提供方读不到，先去电脑上确认配置");
      return "handled";
    }
    await getDeps().sendOwnerText("正在拉取模型列表，稍等…");
    let models: ModelOption[];
    try {
      models = await getDeps().fetchAllModels(provider);
    } catch (err) {
      await getDeps()
        .sendOwnerText(`模型列表拉取失败：${err instanceof Error ? err.message : String(err)}（默认和星标照常用）`)
        .catch(() => undefined);
      return "handled";
    }
    if (models.length === 0) {
      await getDeps().sendOwnerText("模型列表是空的，回设置页点一次“获取列表”再试");
      return "handled";
    }
    const totalPages = Math.max(1, Math.ceil(models.length / PANEL_LIST_PAGE_SIZE));
    const safe = clampPage(page, totalPages);
    await getDeps().sendOwnerCard(
      buildAllModelsCard({
        models: models
          .slice(safe * PANEL_LIST_PAGE_SIZE, safe * PANEL_LIST_PAGE_SIZE + PANEL_LIST_PAGE_SIZE)
          .map((m) => ({ id: m.id, display: m.displayName || m.id })),
        page: safe,
        totalPages,
        total: models.length,
        currentModelId,
        ctx,
      }),
    );
  } catch (err) {
    await getDeps()
      .sendOwnerText(`模型列表打开失败：${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
  }
  return "handled";
};

/**
 * 遥控器按钮回调总入口（card-action 按 kind=chats 转过来）。
 * 全程不抛——失败转成一条 owner 私聊回执（手机上看得见）。
 */
export const handleChatsCardAction = async (
  value: Extract<CardButtonValue, { kind: "chats" }>,
): Promise<void> => {
  const say = (text: string): Promise<unknown> =>
    getDeps().sendOwnerText(text).catch(() => undefined);
  try {
    switch (value.op) {
      case "panel": {
        await showChatsPanel();
        return;
      }
      case "switch": {
        if (!value.taskId) {
          await say("这个按钮没带对话 id，重新打开列表再点一次");
          return;
        }
        const r = await switchPanelChat(value.taskId);
        await say(r.ok ? `已切到「${r.title}」，直接说话即聊` : r.error);
        return;
      }
      case "list": {
        await showChatListCard({
          ...(value.repo !== undefined ? { repo: value.repo } : {}),
          ...(value.archived ? { archived: true } : {}),
          ...(value.page !== undefined ? { page: value.page } : {}),
        });
        return;
      }
      case "repos": {
        await showRepoListCard({
          purpose: value.purpose ?? "switch",
          ...(value.page !== undefined ? { page: value.page } : {}),
        });
        return;
      }
      case "repo": {
        if (value.purpose === "new") {
          await showModelCard({ forNew: true, ...(value.repo ? { repo: value.repo } : {}) });
          return;
        }
        await showChatListCard({
          ...(value.repo !== undefined ? { repo: value.repo } : {}),
        });
        return;
      }
      case "new": {
        const brief = await readPanelProviderBrief().catch(() => null);
        if (brief && brief.repos.length > 0) {
          await showRepoListCard({ purpose: "new" });
          return;
        }
        // 没配仓库：跳过选仓，直达选模型（仓库缺省不绑）
        await showModelCard({ forNew: true });
        return;
      }
      case "new_model": {
        await showModelCard({
          forNew: true,
          ...(value.repo ? { repo: value.repo } : {}),
        });
        return;
      }
      case "create": {
        // 语义校验：仓库不在可选范围 / 模型不在目录都拒，不把脏值建进任务
        const repo = value.repo?.trim().replace(/\/+$/, "") ?? "";
        if (repo && !(await isAllowedPanelRepo(repo).catch(() => false))) {
          await say("这个仓库不在可选范围里，重新选一个");
          return;
        }
        const modelId = value.modelId?.trim() ?? "";
        if (modelId) {
          const brief = await readPanelProviderBrief().catch(() => null);
          const check = await checkPanelModelId(modelId, brief?.provider ?? "");
          if (!check.ok) {
            await say(check.error);
            return;
          }
        }
        const r = await createPanelChat({
          ...(repo ? { repoPath: repo } : {}),
          ...(modelId ? { modelId } : {}),
        });
        await say(
          r.ok ? `已建「${r.title}」，直接说话开聊` : r.error,
        );
        return;
      }
      case "model": {
        await showModelCard({
          ...(value.taskId ? { taskId: value.taskId } : {}),
        });
        return;
      }
      case "model_set": {
        if (!value.modelId?.trim()) {
          await say("这个按钮没带模型 id，重新打开再点一次");
          return;
        }
        if (value.forNew) {
          const repo = value.repo?.trim().replace(/\/+$/, "") ?? "";
          if (repo && !(await isAllowedPanelRepo(repo).catch(() => false))) {
            await say("这个仓库不在可选范围里，重新选一个");
            return;
          }
          const brief = await readPanelProviderBrief().catch(() => null);
          const check = await checkPanelModelId(value.modelId, brief?.provider ?? "");
          if (!check.ok) {
            await say(check.error);
            return;
          }
          const r = await createPanelChat({
            ...(repo ? { repoPath: repo } : {}),
            modelId: value.modelId,
          });
          await say(
            r.ok ? `已建「${r.title}」（${value.modelId}），直接说话开聊` : r.error,
          );
          return;
        }
        let taskId = value.taskId;
        if (!taskId) taskId = (await getPanelCurrent())?.id;
        if (!taskId) {
          await say("还没有当前对话，先换一个或新开一个");
          return;
        }
        // 语义校验：候选命中才写，伪造 id 进不了 setTaskModel
        const target = await getDeps().getTask(taskId).catch(() => null);
        const check = await checkPanelModelId(
          value.modelId,
          target && target.mode === "chat" ? (target.provider?.trim() || undefined) : undefined,
        );
        if (!check.ok) {
          await say(check.error);
          return;
        }
        const r = await setPanelChatModel(taskId, value.modelId);
        await say(r.ok ? `已切到 ${value.modelId.trim()}，跟它说话即用新模型` : r.error);
        return;
      }
      case "models_all": {
        await showAllModelsCard(
          {
            ...(value.taskId ? { taskId: value.taskId } : {}),
            ...(value.forNew ? { forNew: true } : {}),
            ...(value.repo ? { repo: value.repo } : {}),
          },
          value.page ?? 0,
        );
        return;
      }
      case "search_hint": {
        await getDeps().setAwaitingChatSearch().catch(() => undefined);
        await say("把要找的关键词直接发给我（标题 / 仓库 / 模型都行），下一条消息即搜");
        return;
      }
      default: {
        await say("这个按钮我还不认识，重新打开遥控器再试一次");
        return;
      }
    }
  } catch (err) {
    await say(`操作失败：${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * 搜关键词消费（router 在纯文本路径调）：flag 在则搜一次、回列表卡、吃掉这条消息。
 * flag 取值即清——搜完无论有没有结果都不留尾巴；空消息也清、不吞后面的正常聊天。
 * 带图片/附件的消息不消费（flag 原样保留、等下一条纯文本）：附件优先，静默吞附件
 * 比多等一条更恶劣；纯图（空文本）则仍按空消息烧掉 intent——改主意就别留尾巴。
 */
export const consumeChatSearchText = async (
  text: string,
  opts: { hasAttachments?: boolean } = {},
): Promise<boolean> => {
  // 这两类都不消费、不碰 flag：附件等下一条纯文本，空文本（不支持的消息类型）也别烧 intent
  if (opts.hasAttachments) return false;
  if (!text.trim()) return false;
  let was = false;
  try {
    was = await getDeps().takeAwaitingChatSearch();
  } catch {
    return false;
  }
  if (!was) return false;
  // 关键词封顶 50 字：原文直进搜索 includes + 卡片标题 + 未命中回显，不截会产出怪卡
  const kw = text.trim().slice(0, 50);
  if (!kw) return false;
  try {
    const rows = await searchPanelChats(kw);
    if (rows.length === 0) {
      await getDeps()
        .sendOwnerText(`没找到跟「${kw}」相关的对话，换个词或 /chats 翻翻`)
        .catch(() => undefined);
    } else {
      const totalPages = Math.max(1, Math.ceil(rows.length / CHAT_PANEL_PAGE_SIZE));
      const current = await getPanelCurrent().catch(() => null);
      await getDeps().sendOwnerCard(
        buildChatListCard({
          rows: rows.slice(0, CHAT_PANEL_PAGE_SIZE),
          page: 0,
          totalPages,
          total: rows.length,
          ...(current ? { currentId: current.id } : {}),
          title: `搜“${kw}”（${rows.length}）`,
        }),
      );
    }
  } catch (err) {
    await getDeps()
      .sendOwnerText(`搜索失败：${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
  }
  return true;
};
