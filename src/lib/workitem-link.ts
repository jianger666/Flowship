/**
 * 工作项预览页的链接处理（S13-20）：外链白名单 + 防重复建任务的匹配口径。
 *
 * 预览页的 `url` 来自 query（可被任意构造）：
 * - 直接塞进 `<a href>` 会放过 `javascript:` / `data:` 等协议 → 只放行 http(s)；
 * - 防重复只比 story id 太弱（路由 id 与链接里的 id 可能不一致）→
 *   同时比「路由 id / 链接里的 id / 归一化后的链接」。
 * - 链接里的 id 只从已知的工作项详情路径形态（`/<空间>/<类型>/detail/<id>`）的 **pathname** 里取，
 *   不对整串扫数字——query 里的时间戳、无关长数字不能当工作项 id（旧 extractFeishuStoryId 的
 *   「≥6 位数字兜底」会误命中）。
 */

import { deriveListLoadView } from "./load-outcome";

/** 只允许 http / https 外链；非法 / 其它协议返回 ""（调用方当「没有链接」处理） */
export const safeHttpUrl = (raw: string | null | undefined): string => {
  const text = (raw ?? "").trim();
  if (!text) return "";
  try {
    const u = new URL(text);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    // 带账号密码的链接（user:pass@host）既不是飞书详情页、也常用于钓鱼混淆
    if (u.username || u.password) return "";
    return u.toString();
  } catch {
    return "";
  }
};

/**
 * 链接归一化（比对用）：小写 host、去 hash / query、去尾部斜杠。
 * 非 http(s) / 解析失败 → ""，不参与比对。
 */
export const normalizeWorkitemUrl = (raw: string | null | undefined): string => {
  const safe = safeHttpUrl(raw);
  if (!safe) return "";
  const u = new URL(safe);
  u.hash = "";
  u.search = "";
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
};

/**
 * 从工作项详情链接取 id：仅认 pathname 里的 `/detail/<digits>`
 *（飞书项目 / Meegle：`/<空间>/story|bug|issue/detail/<id>`、`/<空间>/workitem/<类型>/detail/<id>` 等同形）。
 * query / hash 里的数字、路径其它段里的长数字一律不取；非 http(s) / 抠不到 → null。
 */
export const extractWorkitemIdFromUrl = (
  raw: string | null | undefined,
): string | null => {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  const m = new URL(safe).pathname.match(/\/detail\/(\d+)(?:\/|$)/);
  return m ? m[1]! : null;
};

interface TaskLike {
  mode?: string;
  feishuStoryUrl?: string;
}

/**
 * 预览页「启动区」的四态：加载中 / 列表加载失败（查不了有没有已有任务）/ 已有任务（表单收起）/ 新建表单
 */
export type WorkitemGate = "loading" | "error" | "existing" | "form";

/**
 * 决定预览页启动区渲染什么（纯函数，页面只负责按结果渲染）。
 *
 * 为什么必须看 loaded（N9-02）：useTaskList 首次加载前 tasks 是空数组，`existing` 必然查不到——
 * 此时若直接渲染表单，用户会先看到表单、任务加载完匹配上后表单又被卸载：已填内容丢失，
 * 或者在「其实已有任务」的窗口里手快点了创建、建出重复任务。所以没加载完一律 loading。
 *
 * formShown：表单一旦放出来过（用户可能已经在填）就不再收回。轮询 / 窗口聚焦刷新、
 * 别的窗口 / 飞书桥接建了同一工作项的任务，都会让 `existing` 之后才命中，
 * 这时只补一条「已存在」提示、不能把表单卸载掉丢输入。
 *
 * 保持上一轮设计：首次就撞上已有任务 → 表单默认收起（existing），点「仍要新建」（forceNew）才展开。
 *
 * 为什么还要看 loadError（F3-03）：loaded 只表示「拉过一次了」、不表示「拉成功了」——
 * 列表首拉失败时 loaded 照样为 true、tasks 是空数组，`existing` 必然查不到，
 * 若此时放表单，用户会在「其实已有任务、只是没拉到」的情况下对同一需求重复启动。
 * 所以没命中 + 列表是「没数据 + 有失败」（deriveListLoadView === "error"）→ error：
 * 不放表单、页面给「加载失败 + 重试」。几个刻意的取舍：
 *  - 命中 existing 是正证据，不看 loadError（旧数据里命中了也成立）；
 *  - formShown 优先于 error：表单已放出、用户可能在填，后台刷新失败不能把它收回丢输入；
 *  - 已有旧数据时（taskCount > 0）后台刷新失败仍按 ready 走，口径与侧栏 / /chats 一致
 *    （不拿失败态盖掉能用的旧列表）；
 *  - loadError / taskCount 可缺省（老调用方）：只传 loadError 不传 taskCount 时 taskCount 按 0 算，
 *    宁可多挡一次表单也不在失败时放行。
 */
export const decideWorkitemGate = (input: {
  loaded: boolean;
  existing: unknown;
  forceNew: boolean;
  formShown?: boolean;
  /** useTaskList().loadError：最近一次列表拉取的失败原因，null / 缺省 = 最近一次是好的 */
  loadError?: string | null;
  /** useTaskList().tasks.length：判断「有没有旧数据可用」 */
  taskCount?: number;
}): WorkitemGate => {
  if (!input.loaded) return "loading";
  if (input.formShown) return "form";
  if (input.existing) return input.forceNew ? "form" : "existing";
  const view = deriveListLoadView({
    loaded: input.loaded,
    loadError: input.loadError ?? null,
    count: input.taskCount ?? 0,
  });
  return view === "error" ? "error" : "form";
};

/** 「按已有任务做分流」时的查找结果：列表未就绪 / 命中 / 没命中 / 列表加载失败（不知道有没有） */
export type TaskLookupState = "pending" | "hit" | "miss" | "unknown";

/**
 * 任务列表首次加载完成前，「没找到」不等于「没有」：tasks 还是空数组，hit 必然为空。
 * 任何靠「列表里有没有」来决定「引导新建」的入口（如收件箱「改bug」）都先过这一关，
 * 避免列表没就绪时误判成没有、引导用户重复建任务。
 * 命中是正证据（不管列表是否加载完都成立），只有「没命中 + 没加载完」才算 pending。
 */
export const resolveTaskLookup = (
  loaded: boolean,
  hit: unknown,
  /**
   * 列表拉取失败信息（useTaskList 的 loadError / tasks.length）：首拉失败时 loaded 也会是 true、tasks 是空的，
   * 「没命中」不等于「没有」——此时返回 "unknown"（不下「没有」的结论、别引导新建，第二轮 review F3-03 同类）。
   * 已有旧数据（count>0）时后台刷新失败仍按 miss 走，与侧栏 / 工作项页同口径。缺省 = 旧行为。
   */
  listState?: { loadError?: string | null; taskCount?: number },
): TaskLookupState => {
  if (hit) return "hit";
  if (!loaded) return "pending";
  if (listState?.loadError && (listState.taskCount ?? 0) === 0) return "unknown";
  return "miss";
};

/**
 * 看板缓存里记着的 task id 要不要信：列表没就绪、或列表首拉失败（没数据 + 有失败）时拿不到「实时存活任务」
 * 做校验，回退信任缓存映射——否则点已有任务会被误导去预览页、可能对同一工作项重复建任务。
 */
export const shouldTrustCachedTaskLink = (s: {
  loaded: boolean;
  loadError?: string | null;
  taskCount: number;
}): boolean => {
  const view = deriveListLoadView({
    loaded: s.loaded,
    loadError: s.loadError ?? null,
    count: s.taskCount,
  });
  return view === "loading" || view === "error";
};

/**
 * 找该工作项已有的非 chat 任务：
 * 任务链接的 story id 等于「路由 id」或「预览链接里的 id」，
 * 或任务链接归一化后与预览链接归一化后相同。
 */
export const findExistingWorkitemTask = <T extends TaskLike>(
  tasks: T[],
  opts: { id: string; url?: string },
): T | undefined => {
  const ids = new Set<string>();
  if (opts.id) ids.add(opts.id);
  const urlId = extractWorkitemIdFromUrl(opts.url);
  if (urlId) ids.add(urlId);
  const normUrl = normalizeWorkitemUrl(opts.url);
  return tasks.find((t) => {
    if (t.mode === "chat") return false;
    const taskId = extractWorkitemIdFromUrl(t.feishuStoryUrl);
    if (taskId && ids.has(taskId)) return true;
    return normUrl !== "" && normalizeWorkitemUrl(t.feishuStoryUrl) === normUrl;
  });
};
