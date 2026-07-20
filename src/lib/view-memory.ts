/**
 * 视图记忆（v1.1.x、用户拍板「切走再切回要记住」）——轻量记忆点的单一收口。
 *
 * 三档存储、按「该记多久」选：
 * - sessionStorage：最后浏览的对话 / 输入草稿 / 看板时间范围——重启 app 即忘（符合预期、
 *   不产生陈旧状态）；Electron 单窗口、session 生命周期 = app 生命周期
 * - localStorage：输入条拖过的高度 / 侧栏分组折叠与置顶序——用户的全局偏好、跨重启保留
 * - 模块级内存 Map：事件流滚动锚点——SPA 路由切换组件会卸载、但模块常驻；reload 即忘无妨
 */

import type { SidebarGroupMode } from "@/lib/sidebar-groups";

// SSR / 存储被禁时兜底 null（客户端组件在 server 也会跑一遍首渲）
const ss = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

// ---------- 最后浏览的对话（胶囊切回「对话」时优先落它、不是最近活跃那条） ----------

const LAST_CHAT_KEY = "flowship:last-chat-id";

export const rememberLastChat = (taskId: string) => {
  ss()?.setItem(LAST_CHAT_KEY, taskId);
};

export const getLastChatId = (): string | null =>
  ss()?.getItem(LAST_CHAT_KEY) ?? null;

// ---------- 输入草稿（按 task 记、发送后清；打了半段切页不丢） ----------

// scope 区分同一 task 的多个输入位（chat 事件流输入岛 / 任务「跟 AI 说」条）
const draftKey = (scope: string, taskId: string) =>
  `flowship:draft:${scope}:${taskId}`;

export const loadDraft = (scope: string, taskId: string): string =>
  ss()?.getItem(draftKey(scope, taskId)) ?? "";

export const saveDraft = (scope: string, taskId: string, text: string) => {
  const s = ss();
  if (!s) return;
  if (text) s.setItem(draftKey(scope, taskId), text);
  else s.removeItem(draftKey(scope, taskId));
};

// ---------- 事件流滚动锚点（离开时视口顶部的事件 id；贴底则回来照常落底） ----------

interface ScrollAnchor {
  /** 视口顶部第一条渲染 item 的事件 id */
  anchorId: string;
  /** 离开时是否贴底（贴底 = 回来不恢复、维持「跟随最新」默认行为） */
  atBottom: boolean;
}

// 模块级内存：key = taskId
const scrollAnchors = new Map<string, ScrollAnchor>();

export const saveScrollAnchor = (taskId: string, anchor: ScrollAnchor) => {
  scrollAnchors.set(taskId, anchor);
};

export const getScrollAnchor = (taskId: string): ScrollAnchor | undefined =>
  scrollAnchors.get(taskId);

// ---------- 任务已读（「待确认」已读即清、用户拍板） ----------
//
// 交卷后侧栏标「待确认」、但用户**点进去看过**之后这个状态就该清掉（否则常亮 = 没信号）。
// localStorage（跨重启保留、丢了会重新全亮很烦）：{ [taskId]: 最后打开详情的时间戳 }。
// 判定在消费方：seenAt >= task.updatedAt = 已读（交卷后没再有新动静）。

const SEEN_KEY = "flowship:task-seen";
// 防无限膨胀：只保留最近 300 个任务的记录
const SEEN_CAP = 300;

const readSeenMap = (): Record<string, number> => {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

export const markTaskSeen = (taskId: string) => {
  try {
    const map = readSeenMap();
    map[taskId] = Date.now();
    const ids = Object.keys(map);
    if (ids.length > SEEN_CAP) {
      // 按时间升序裁掉最老的（早被删的任务记录自然被挤出去）
      ids
        .sort((a, b) => map[a] - map[b])
        .slice(0, ids.length - SEEN_CAP)
        .forEach((id) => delete map[id]);
    }
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    /* 存储被禁忽略 */
  }
};

export const getTaskSeenAt = (taskId: string): number =>
  readSeenMap()[taskId] ?? 0;

// ---------- 输入条拖过的高度（全局偏好、跨任务共用） ----------

const BOX_HEIGHT_KEY = "flowship:talk-box-height";

export const loadBoxHeight = (): number | null => {
  try {
    const v = Number(localStorage.getItem(BOX_HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

export const saveBoxHeight = (h: number) => {
  try {
    localStorage.setItem(BOX_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* 存储被禁忽略 */
  }
};

// ---------- 看板时间范围（会话级：改过区间切页不重置、重启回默认防陈旧日期） ----------

const BOARD_RANGE_KEY = "flowship:board-range";

export const loadBoardRange = (): { from: number; to: number } | null => {
  try {
    const raw = ss()?.getItem(BOARD_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown };
    if (
      typeof parsed.from === "number" &&
      typeof parsed.to === "number" &&
      parsed.from <= parsed.to
    ) {
      return { from: parsed.from, to: parsed.to };
    }
    return null;
  } catch {
    return null;
  }
};

export const saveBoardRange = (range: { from: number; to: number }) => {
  ss()?.setItem(BOARD_RANGE_KEY, JSON.stringify(range));
};

// ---------- 侧栏 chat 分组视图（跨重启保留、localStorage） ----------
//
// 对标 grok Dashboard 的 grouping / pin reorder / 折叠态——不进 task meta，避免污染业务数据。

const SIDEBAR_GROUP_MODE_KEY = "flowship:sidebar-group-mode";
const SIDEBAR_COLLAPSED_KEY = "flowship:sidebar-collapsed-groups";
const SIDEBAR_PINNED_ORDER_KEY = "flowship:sidebar-pinned-order";

export const loadSidebarGroupMode = (): SidebarGroupMode => {
  try {
    const v = localStorage.getItem(SIDEBAR_GROUP_MODE_KEY);
    return v === "status" ? "status" : "repo";
  } catch {
    return "repo";
  }
};

export const saveSidebarGroupMode = (mode: SidebarGroupMode) => {
  try {
    localStorage.setItem(SIDEBAR_GROUP_MODE_KEY, mode);
  } catch {
    /* 存储被禁忽略 */
  }
};

/** 折叠中的组 key 集合（repo:… / unbound / status:…；置顶一般不折叠但仍可记） */
export const loadSidebarCollapsedGroups = (): Set<string> => {
  try {
    const raw = JSON.parse(
      localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(raw)) return new Set();
    return new Set(
      raw.filter((x): x is string => typeof x === "string" && x.length > 0),
    );
  } catch {
    return new Set();
  }
};

export const saveSidebarCollapsedGroups = (keys: Iterable<string>) => {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* 存储被禁忽略 */
  }
};

/** 置顶区手动序（task id 数组）；未出现的 pinned 追加到末尾 */
export const loadSidebarPinnedOrder = (): string[] => {
  try {
    const raw = JSON.parse(
      localStorage.getItem(SIDEBAR_PINNED_ORDER_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
};

export const saveSidebarPinnedOrder = (ids: readonly string[]) => {
  try {
    localStorage.setItem(SIDEBAR_PINNED_ORDER_KEY, JSON.stringify([...ids]));
  } catch {
    /* 存储被禁忽略 */
  }
};
