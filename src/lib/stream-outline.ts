/**
 * 事件流左侧「提问时间线」的纯逻辑（chat / task 共用，服务端扫盘与前端合并同一份口径）。
 *
 * 一条时间线项 = 一次「触发一轮 agent 的输入」：属主可见的 user_reply（用户提问）与 action_start（task 推进了一个
 * action）——判定直接复用 {@link isTailAnchorEvent}（群里陌生人的提问等对主流隐藏的事件不进来，与
 * 「300 条窗口补锚点」「错误卡恢复入口」「↑ 输入历史」同口径，别另写一份）。
 *
 * ## 为什么不能只看前端窗口
 * 前端只持有最近 300 条事件、更早的靠上拉分页；长会话里提问大多落在窗口之外。所以服务端给一条轻量大纲
 * （`GET /api/tasks/:id/outline`，只含 id / 时刻 / 预览），前端再把**窗口里的实时事件**并进去
 * （{@link mergeOutline}）——新提问不用重拉、回退后截掉的提问立刻消失。
 *
 * ## 定时触发
 * AI 给自己设的定时到点后也是以 user_reply 落盘的（`meta.source === "schedule"`）。它们不是用户说的话、
 * 长会话里每 20 分钟一条，会把时间线刷满：标 `schedule: true`，界面默认隐藏、可手动打开。
 */

import {
  isScheduleBoilerplateText,
  isScheduleUserReply,
  userReplyDisplayText,
} from "@/lib/chat-stream-display";
import { isTailAnchorEvent } from "@/lib/tail-anchor";
import type { TaskEvent } from "@/lib/types";

/** 预览文本的字数上限（落进接口 / 内存的长度；界面再用 line-clamp 截） */
export const OUTLINE_PREVIEW_MAX = 120;
/** 服务端一次最多回多少项（取**最新**的；一个任务有几千次提问就是极端情况了） */
export const OUTLINE_MAX_ITEMS = 5000;
/** 折叠态刻度条最多画几格（超过就把相邻的项并成一格，点哪格 = 跳到那格的第一项） */
export const OUTLINE_MAX_TICKS = 36;
/** 一次点击跳转最多往前拉多少条原始事件（再早的提示用户、再点一次继续往前拉） */
export const OUTLINE_JUMP_MAX_EVENTS = 5000;

export type OutlineKind = "user_reply" | "action_start";

export interface OutlineItem {
  /** 事件 id（跳转定位用） */
  id: string;
  ts: number;
  kind: OutlineKind;
  /** 预览文本：单行、≤ OUTLINE_PREVIEW_MAX 字 */
  text: string;
  /** 定时到点的系统消息（不是用户说的话），默认不画 */
  schedule?: true;
}

/** 折叠空白、截断到 max 个字符（按码点算，不把代理对劈成两半） */
export const previewText = (raw: string, max = OUTLINE_PREVIEW_MAX): string => {
  if (!raw) return "";
  // 先粗截再折叠空白：一条几十万字的粘贴不该整段跑一遍正则
  const flat = raw.slice(0, max * 4).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
};

/** 「开始 Plan（plan）n=2」→「开始 Plan #2」；认不出格式就退回首行 */
const actionStartHead = (firstLine: string): string => {
  const m = /^开始\s+(.+?)（[^）]*）\s*n=(\d+)\s*$/.exec(firstLine);
  if (!m) return firstLine;
  const n = Number.parseInt(m[2]!, 10);
  return n > 1 ? `开始 ${m[1]} #${n}` : `开始 ${m[1]}`;
};

const hasNonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** 事件 → 时间线项；不是时间线事件返回 null */
export const toOutlineItem = (ev: TaskEvent): OutlineItem | null => {
  if (!isTailAnchorEvent(ev)) return null;
  const rawText = typeof ev.text === "string" ? ev.text : "";

  if (ev.kind === "action_start") {
    const [first = "", ...rest] = rawText.split("\n");
    const head = actionStartHead(first.trim());
    const instr = rest
      .map((l) => l.trim())
      .find((l) => l.startsWith("用户指令："))
      ?.slice("用户指令：".length)
      .trim();
    return {
      id: ev.id,
      ts: ev.ts,
      kind: "action_start",
      text: previewText(instr ? `${head} · ${instr}` : head),
    };
  }

  // user_reply
  const schedule = isScheduleUserReply(ev) || isScheduleBoilerplateText(rawText);
  if (schedule) {
    const title =
      typeof ev.meta?.scheduleTitle === "string" ? ev.meta.scheduleTitle.trim() : "";
    const body = userReplyDisplayText(ev);
    // 老事件没有 meta：展示文本就是整段系统样板，不拿它当预览
    const memo = isScheduleBoilerplateText(body) ? "" : body;
    return {
      id: ev.id,
      ts: ev.ts,
      kind: "user_reply",
      text: previewText(title ? `定时 · ${title}` : memo ? `定时 · ${memo}` : "定时触发"),
      schedule: true,
    };
  }
  let text = previewText(userReplyDisplayText(ev));
  if (!text) {
    text = hasNonEmptyArray(ev.meta?.images)
      ? "[图片]"
      : hasNonEmptyArray(ev.meta?.attachments)
        ? "[附件]"
        : "（空消息）";
  }
  return { id: ev.id, ts: ev.ts, kind: "user_reply", text };
};

/**
 * 把前端窗口里的实时事件并进服务端大纲。
 *
 * - `rewindFromEventId`：本地已知的最近一次回退的目标事件——它**及之后**的服务端项都已被删，先砍掉
 *   （服务端大纲可能是回退之前拉的，重拉回来之前不能让用户点到已经不存在的消息）；
 * - 窗口里有、大纲里没有的（刚到的新提问）并进去；通常都在末尾，乱序时按时刻稳定插入。
 */
export const mergeOutline = (
  server: readonly OutlineItem[],
  windowEvents: readonly TaskEvent[],
  rewindFromEventId?: string | null,
): OutlineItem[] => {
  let base: readonly OutlineItem[] = server;
  if (rewindFromEventId) {
    const i = base.findIndex((it) => it.id === rewindFromEventId);
    if (i >= 0) base = base.slice(0, i);
  }
  const known = new Set<string>();
  for (const it of base) known.add(it.id);
  const extra: OutlineItem[] = [];
  for (const ev of windowEvents) {
    const it = toOutlineItem(ev);
    if (!it || known.has(it.id)) continue;
    known.add(it.id);
    extra.push(it);
  }
  if (extra.length === 0) return base === server ? (server as OutlineItem[]) : [...base];
  const last = base[base.length - 1];
  const merged = [...base, ...extra];
  const inOrder =
    (!last || extra[0]!.ts >= last.ts) &&
    extra.every((it, i) => i === 0 || it.ts >= extra[i - 1]!.ts);
  // Array.prototype.sort 稳定：同时刻的保持「大纲在前、窗口在后」
  return inOrder ? merged : merged.sort((a, b) => a.ts - b.ts);
};

/** 内容没变就返回旧引用（时间线组件靠引用相等跳过重渲，别每来一条事件就重画一遍） */
export const stabilizeOutline = (
  prev: readonly OutlineItem[],
  next: OutlineItem[],
): readonly OutlineItem[] => {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (
      a.id !== b.id ||
      a.ts !== b.ts ||
      a.text !== b.text ||
      a.kind !== b.kind ||
      a.schedule !== b.schedule
    ) {
      return next;
    }
  }
  return prev;
};

/** 界面实际画哪些：默认不含定时触发 */
export const visibleOutline = (
  items: readonly OutlineItem[],
  showSchedule: boolean,
): OutlineItem[] => (showSchedule ? [...items] : items.filter((it) => !it.schedule));

/**
 * 折叠态刻度分格：项数 ≤ maxTicks 一项一格；否则按比例并成 maxTicks 格（每格至少一项、连续不重叠、
 * 覆盖全部）。返回闭区间下标 `[first, last]`——点这格跳到 first 那一项。
 */
export const bucketOutlineTicks = (
  count: number,
  maxTicks = OUTLINE_MAX_TICKS,
): Array<{ first: number; last: number }> => {
  if (count <= 0) return [];
  if (count <= maxTicks) {
    return Array.from({ length: count }, (_, i) => ({ first: i, last: i }));
  }
  const out: Array<{ first: number; last: number }> = [];
  for (let b = 0; b < maxTicks; b++) {
    const first = Math.floor((b * count) / maxTicks);
    const last = Math.floor(((b + 1) * count) / maxTicks) - 1;
    out.push({ first, last });
  }
  return out;
};

/** 渲染项里时间线事件的最小形状（工作过程组带 members） */
export interface OutlineRenderItem {
  id: string;
  kind: string;
  members?: ReadonlyArray<{ id: string; kind: string }>;
}

const isOutlineKind = (kind: string): boolean =>
  kind === "user_reply" || kind === "action_start";

/**
 * 视口顶项（渲染项下标）所在的那一轮：从它往上找最近一个 user_reply / action_start 的事件 id
 * （顶项自己就是的话就是它——与 sticky 轮次头不同，那边「顶项自己还看得见」时不粘）。没有 = null。
 * 滚动热路径上调：纯函数、只读、不分配。
 */
export const resolveActiveOutlineId = (
  items: readonly OutlineRenderItem[],
  localIdx: number,
): string | null => {
  if (items.length === 0 || localIdx < 0) return null;
  for (let i = Math.min(localIdx, items.length - 1); i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (isOutlineKind(it.kind)) return it.id;
    if (it.kind === "__work_group__" && it.members) {
      for (let j = it.members.length - 1; j >= 0; j--) {
        const m = it.members[j]!;
        if (isOutlineKind(m.kind)) return m.id;
      }
    }
  }
  return null;
};

/**
 * 当前轮对应到「界面上画着的那一项」：当前轮是被隐藏的定时触发项时，落到它之前最近一个画着的项
 * （读者感知上就是「这是接着那条提问的后续」）。找不到 = null。
 */
export const resolveVisibleActiveId = (
  visible: readonly OutlineItem[],
  full: readonly OutlineItem[],
  activeId: string | null,
): string | null => {
  if (!activeId) return null;
  if (visible.some((it) => it.id === activeId)) return activeId;
  // 没隐藏任何项、当前轮却不在表里（大纲还没带上它）：认不出
  if (visible.length === full.length) return null;
  const at = full.findIndex((it) => it.id === activeId);
  if (at < 0) return null;
  const visibleIds = new Set(visible.map((it) => it.id));
  for (let i = at; i >= 0; i--) {
    if (visibleIds.has(full[i]!.id)) return full[i]!.id;
  }
  return null;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 「HH:mm」（本地时区、24 小时制） */
export const formatOutlineTime = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 日期小标题：今天 / 昨天 / MM-DD（跨年带年份） */
export const formatOutlineDay = (ts: number, now: number = Date.now()): string => {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}-${md}`;
};

export type OutlineRow =
  | { type: "day"; key: string; label: string }
  | { type: "item"; key: string; item: OutlineItem };

/** 展开面板的行：每换一天插一行日期小标题 */
export const groupOutlineRows = (
  items: readonly OutlineItem[],
  now: number = Date.now(),
): OutlineRow[] => {
  const rows: OutlineRow[] = [];
  let lastDay = "";
  for (const item of items) {
    const label = formatOutlineDay(item.ts, now);
    if (label !== lastDay) {
      lastDay = label;
      rows.push({ type: "day", key: `day:${item.id}`, label });
    }
    rows.push({ type: "item", key: item.id, item });
  }
  return rows;
};

/** 展开面板的宽度（px）。与 StreamOutlineRail 里面板的 `w-72`（18rem）同值——契约测试钉着，改一处必须改另一处 */
export const OUTLINE_PANEL_WIDTH_PX = 288;
/** 面板与刻度把手之间的间隙（px）。与面板的 `mr-1`（0.25rem）同值 */
export const OUTLINE_PANEL_GAP_PX = 4;

export type OutlinePanelSide = "left" | "right";

/**
 * 展开面板往哪一侧开。
 *
 * chat 形态下刻度把手贴着居中内容列的左缘（离事件区左边缘可能有几百 px）：
 * - 把手左侧放得下整块面板（含间隙）→ 向左开：面板落在左侧空白区，不盖住居中的正文；
 * - 放不下（窗口窄、内容列已顶到左缘；task 形态把手本来就贴最左缘）→ 向右开，盖住正文左侧——
 *   面板钉回事件区最左缘（`outlinePanelRightShift`），对正文的覆盖量与「把手贴最左缘」时的老行为一致。
 *
 * @param roomLeftPx 把手左缘到事件区左缘的距离（px）；量不出来（NaN）按放不下算
 */
export const pickOutlinePanelSide = (roomLeftPx: number): OutlinePanelSide =>
  roomLeftPx >= OUTLINE_PANEL_WIDTH_PX + OUTLINE_PANEL_GAP_PX ? "left" : "right";

/**
 * 向右开时面板左缘的落点：事件区最左缘往里这么多（px）。与 task 形态把手的 `left-0.5`（0.125rem）同值——
 * 旧版面板就固定在这儿，向右开时对正文的覆盖量必须与旧版一致。
 */
export const OUTLINE_EDGE_INSET_PX = 2;

/**
 * 向右开时面板 `left` 的取值（px，相对把手左缘，≤ 0）：把面板拉回事件区最左缘。
 *
 * 为什么不让面板跟着把手左缘走：chat 把手贴着内容列、离最左缘可能有几百 px，窄窗口里它放不下左开；
 * 此时若向右开还与把手左缘对齐，面板会**固定**盖住正文 258px（面板 288 − 把手左缘到正文的 30px），
 * 而旧版（面板钉在最左缘）只盖 max(0, 266 − 内容列左缘)——事件区宽 1000px 时多盖 104px、1300px 时多盖 254px。
 * 拉回最左缘后覆盖量与旧版逐档相等；task 形态把手本来就在 2px，结果是 0（行为不变）。
 *
 * @param roomLeftPx 把手左缘到事件区左缘的距离（px）；量不出来（非有限数）按 0 算（= 与把手左缘对齐）；
 *   比 2px 更靠左也按 0 算（只往左拉、不往右推）
 */
export const outlinePanelRightShift = (roomLeftPx: number): number =>
  Number.isFinite(roomLeftPx) ? Math.min(0, OUTLINE_EDGE_INSET_PX - roomLeftPx) : 0;

/**
 * 「当前在看哪一轮」的外部小 store。
 *
 * 为什么不放 React state：它在滚动热路径（Virtuoso 的 rangeChanged）里更新、事件流父组件（EventStream）
 * 一 setState 就整页重渲——契约测试明令禁止在 rangeChanged 里 setState 父组件。放进这个 store、
 * 只有订阅它的时间线组件（useSyncExternalStore）会重渲，值没变不通知。
 */
export interface ActiveOutlineStore {
  get: () => string | null;
  set: (next: string | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export const createActiveOutlineStore = (): ActiveOutlineStore => {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** 可被 abort 打断的等待：abort 时立刻 resolve（调用方随后自己检查 signal.aborted） */
const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * 带退避的重试：`run` 失败后按 `delaysMs` 依次等待再试（共 1 + delaysMs.length 次），全失败抛最后一次的错。
 * 等待期间 / 每次尝试前 `signal` 已 abort → 立刻抛 AbortError，不再发请求。
 * 用于时间线取大纲：长会话里一次瞬时网络错误，不该让时间线一直只剩窗口内的项。
 */
export const fetchWithBackoff = async <T>(
  run: () => Promise<T>,
  delaysMs: readonly number[],
  opts: {
    signal?: AbortSignal;
    /** 测试注入：默认走可被 abort 打断的 setTimeout */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** 这个错值不值得重试（默认都重试）；返回 false 立刻抛出，比如任务已删的 404 / 410 */
    shouldRetry?: (err: unknown) => boolean;
  } = {},
): Promise<T> => {
  const { signal, sleep = abortableSleep, shouldRetry } = opts;
  const aborted = (): Error => {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
  };
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw aborted();
    try {
      return await run();
    } catch (err) {
      if (signal?.aborted) throw aborted();
      if (shouldRetry && !shouldRetry(err)) throw err;
      const delay = delaysMs[attempt];
      if (delay === undefined) throw err;
      await sleep(delay, signal);
    }
  }
};
