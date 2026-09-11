/**
 * 视图记忆（v1.1.x、用户拍板「切走再切回要记住」）——轻量记忆点的单一收口。
 *
 * 三档存储、按「该记多久」选：
 * - sessionStorage：最后浏览的对话 / 输入草稿 / 看板时间范围——重启 app 即忘（符合预期、
 *   不产生陈旧状态）；Electron 单窗口、session 生命周期 = app 生命周期
 * - localStorage：输入条拖过的高度 / 侧栏分组折叠与置顶序——用户的全局偏好、跨重启保留
 * - 模块级内存 Map：事件流滚动锚点 / 输入条附件快照（图 File 对象不可序列化、也不进配额）——
 *   SPA 路由切换组件会卸载、但模块常驻；reload 即忘无妨
 */

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

/** 记住「最后浏览的对话」task id；切到胶囊其它页再切回时优先落它 */
export const rememberLastChat = (taskId: string) => {
  ss()?.setItem(LAST_CHAT_KEY, taskId);
};

/** 读回最后浏览的对话 task id；没记过或存储不可用返回 null */
export const getLastChatId = (): string | null =>
  ss()?.getItem(LAST_CHAT_KEY) ?? null;

// ---------- 最后浏览的工作台视图（胶囊切回「工作台」时恢复它：任务 or 甘特） ----------

const LAST_WORK_KEY = "flowship:last-work-id";
const LAST_WORK_KIND_KEY = "flowship:last-work-kind";

/** 记住「最后浏览的工作台任务」task id；切到对话再切回时按 kind 决定回任务还是甘特 */
export const rememberLastWork = (taskId: string) => {
  const s = ss();
  if (!s) return;
  s.setItem(LAST_WORK_KEY, taskId);
  s.setItem(LAST_WORK_KIND_KEY, "task");
};

/** 记住「最后停在甘特」；切到对话再切回时回到甘特、而不是被拽到老任务 */
export const rememberWorkBoard = () => {
  ss()?.setItem(LAST_WORK_KIND_KEY, "board");
};

/** 读回最后浏览的工作台任务 task id；没记过或存储不可用返回 null */
export const getLastWorkId = (): string | null =>
  ss()?.getItem(LAST_WORK_KEY) ?? null;

/** 读回上次离开工作台时是在任务还是甘特；没记过返回 null（首进按甘特） */
export const getLastWorkKind = (): "board" | "task" | null => {
  const v = ss()?.getItem(LAST_WORK_KIND_KEY);
  return v === "board" || v === "task" ? v : null;
};

/**
 * 清掉工作台任务记忆、退回看板（删任务时调）。
 * 不清的话：下次点工作台胶囊、`loaded=false` 会乐观跳到已删 id，
 * 详情页闪一下空态才回甘特——多余的一跳。
 */
export const clearLastWork = () => {
  const s = ss();
  if (!s) return;
  s.removeItem(LAST_WORK_KEY);
  s.setItem(LAST_WORK_KIND_KEY, "board");
};

// ---------- 输入草稿（按 task 记、发送后清；打了半段切页不丢） ----------

// scope 区分同一 task 的多个输入位（chat 事件流输入岛 / 任务「跟 AI 说」条）
// 只有「常驻输入位」才留草稿——弹窗 / 答题卡关掉就该清空、不进这套
export type DraftScope = "reply" | "talk";

const draftKey = (scope: DraftScope, taskId: string) =>
  `flowship:draft:${scope}:${taskId}`;

/** 读指定 scope + task 的输入草稿；无草稿返回空串 */
export const loadDraft = (scope: DraftScope, taskId: string): string =>
  ss()?.getItem(draftKey(scope, taskId)) ?? "";

/** 保存输入草稿；text 为空串时删除该草稿位（发送后清） */
export const saveDraft = (scope: DraftScope, taskId: string, text: string) => {
  const s = ss();
  if (!s) return;
  if (text) s.setItem(draftKey(scope, taskId), text);
  else s.removeItem(draftKey(scope, taskId));
};

// ---------- 输入条附件快照（图 + 路径、切页/切任务不丢） ----------
//
// 为什么不用 sessionStorage：图附件是 File / base64 dataUrl（单图 10MB、上限 6 张），
// 序列化进 storage 必爆 5MB 配额；File 对象根本不可序列化。模块级内存 Map 跟
// 滚动锚点同策略：SPA 切页组件卸载但模块常驻、回来照样在；reload 即忘（正文不受影响、
// 仍走上面的 sessionStorage）。key 按 scope + task 隔离——A 任务的图绝不串进 B。

export interface SnapshotImage {
  id: string;
  // 只存裸 base64 + mime：dataUrl 用时现拼（`data:${mime};base64,${data}`），
  // 不存双份——6 张×10MB×20 快照的最坏内存直接翻倍（v1.9.13 review P0）。
  data: string;
  mimeType: string;
  filename: string;
}

export interface ComposerAttachmentSnapshot {
  images: SnapshotImage[];
  paths: string[];
}

// 防无限膨胀：个数 + 字节双 cap（base64 按字符≈字节估，路径同理）。
// 20 个是“切页/切任务记一个”的经验值；100MB 兜底病态大图（6 张×10MB 全满也只占一小半）。
const ATTACH_SNAP_COUNT_CAP = 20;
let attachSnapBytesCap = 100 * 1024 * 1024;

// key = 输入位：key 里已有 scope + taskId，不再另拼前缀
const attachmentSnapshots = new Map<string, ComposerAttachmentSnapshot>();

const attachSnapKey = (scope: DraftScope, id: string): string =>
  `${scope}:${id}`;

const attachmentSnapBytes = (snap: ComposerAttachmentSnapshot): number =>
  snap.images.reduce((n, im) => n + im.data.length, 0) +
  snap.paths.reduce((n, p) => n + p.length, 0);

/** 测试专用：调字节 cap（默认 100MB，单测里调小验淘汰逻辑） */
export const __setAttachmentSnapBytesCapForTests = (bytes: number): void => {
  attachSnapBytesCap = bytes;
};

// 淘汰最老的，直到个数/字节都达标；protectKey（刚写入的）永远不被挤掉
// （单条超 cap 的极端情况就留着它、不死循环）
const evictAttachmentSnapshots = (protectKey: string): void => {
  const totalBytes = (): number => {
    let n = 0;
    for (const snap of attachmentSnapshots.values()) n += attachmentSnapBytes(snap);
    return n;
  };
  while (attachmentSnapshots.size > ATTACH_SNAP_COUNT_CAP) {
    const oldest = attachmentSnapshots.keys().next().value;
    if (oldest === undefined || oldest === protectKey) break;
    attachmentSnapshots.delete(oldest);
  }
  while (totalBytes() > attachSnapBytesCap) {
    const oldest = attachmentSnapshots.keys().next().value;
    if (oldest === undefined || oldest === protectKey) break;
    attachmentSnapshots.delete(oldest);
  }
};

/**
 * 原子更新附件快照（图和路径两边都走它，不要各自 load+save）。
 *
 * 背景：addFiles 读文件（async）和 picker 选路径（~1s）都会跨 await，
 * 两边各读一份旧值再全量 save，后写的会把先写的吃掉。这里 updater 在同步临界区里
 * 跑（单线程、无 await 可插队），天然原子。
 *
 * 空即删：updater 返回空快照（图和路径都没了）时直接删条目、不存空占位——
 * 否则 restore() 每次切任务都会给无附件的任务建空条目，连逛 20 个空任务就把
 * 有图的挤出 cap；删到最后一张/一条同理。rich.reset 照常调 clear，不受影响。
 */
export const updateAttachmentSnapshot = (
  scope: DraftScope,
  id: string,
  updater: (
    prev: ComposerAttachmentSnapshot | undefined,
  ) => ComposerAttachmentSnapshot,
): void => {
  const key = attachSnapKey(scope, id);
  const next = updater(attachmentSnapshots.get(key));
  if (next.images.length === 0 && next.paths.length === 0) {
    attachmentSnapshots.delete(key);
    return;
  }
  // 删了重插 = 顶到最新（LRU 语义：刚动过的最后被淘汰）
  attachmentSnapshots.delete(key);
  attachmentSnapshots.set(key, next);
  evictAttachmentSnapshots(key);
};

/** 存输入条附件快照（每次增删图/路径都直写；发送成功后由调用方 clear） */
export const saveAttachmentSnapshot = (
  scope: DraftScope,
  id: string,
  snap: ComposerAttachmentSnapshot,
): void => {
  updateAttachmentSnapshot(scope, id, () => snap);
};

/** 读输入条附件快照；没记过返回 undefined */
export const loadAttachmentSnapshot = (
  scope: DraftScope,
  id: string,
): ComposerAttachmentSnapshot | undefined =>
  attachmentSnapshots.get(attachSnapKey(scope, id));

/** 清输入条附件快照（发送成功后调；切任务/切页不调——回来还要） */
export const clearAttachmentSnapshot = (
  scope: DraftScope,
  id: string,
): void => {
  attachmentSnapshots.delete(attachSnapKey(scope, id));
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

/** 记录离开任务事件流时的滚动锚点（模块内存，reload 即忘） */
export const saveScrollAnchor = (taskId: string, anchor: ScrollAnchor) => {
  scrollAnchors.set(taskId, anchor);
};

/** 读回滚动锚点；没记过（或贴底跟随中不恢复）由消费方判断 atBottom */
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

/** 标记任务详情已被打开（写入当前时间戳，超容量按最老裁剪） */
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

/** 读任务最后被打开的时间戳；从未打开过返回 0 */
export const getTaskSeenAt = (taskId: string): number =>
  readSeenMap()[taskId] ?? 0;

// ---------- 输入条拖过的高度（全局偏好、跨任务共用） ----------

const BOX_HEIGHT_KEY = "flowship:talk-box-height";

/** 读用户拖过的输入条高度；没存过或值非法返回 null */
export const loadBoxHeight = (): number | null => {
  try {
    const v = Number(localStorage.getItem(BOX_HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

/** 保存输入条拖动后的高度（四舍五入取整） */
export const saveBoxHeight = (h: number) => {
  try {
    localStorage.setItem(BOX_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* 存储被禁忽略 */
  }
};

// ---------- 看板时间范围（会话级：改过区间切页不重置、重启回默认防陈旧日期） ----------

const BOARD_RANGE_KEY = "flowship:board-range";

/** 读看板时间范围；没存过或数据非法（from > to / 类型不对）返回 null */
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

/** 保存看板时间范围（会话级，重启后回默认防陈旧日期） */
export const saveBoardRange = (range: { from: number; to: number }) => {
  ss()?.setItem(BOARD_RANGE_KEY, JSON.stringify(range));
};

// ---------- 侧栏 chat 分组视图（跨重启保留、localStorage） ----------
//
// 对标 grok Dashboard 的 pin reorder / 折叠态——不进 task meta，避免污染业务数据。
// 分组轴固定按仓（不再记「按状态」模式）。

const SIDEBAR_COLLAPSED_KEY = "flowship:sidebar-collapsed-groups";
const SIDEBAR_PINNED_ORDER_KEY = "flowship:sidebar-pinned-order";

/** 折叠中的组 key 集合（repo:… / unbound；置顶一般不折叠但仍可记） */
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

/** 保存折叠中的侧栏分组 key 集合（覆盖写） */
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

/** 保存置顶区手动顺序（整体覆盖）；未出现的 pinned 由消费方追加末尾 */
export const saveSidebarPinnedOrder = (ids: readonly string[]) => {
  try {
    localStorage.setItem(SIDEBAR_PINNED_ORDER_KEY, JSON.stringify([...ids]));
  } catch {
    /* 存储被禁忽略 */
  }
};

// ---------- 对话侧栏粘性序（跨重启保留） ----------
//
// 不跟 meta.updatedAt 走：agent 流式每 5s 节流 bump 一次，并行对话会整组对跳。
// 粘性序只在新建 / 用户发送时往前顶。侧栏订阅事件刷新，不靠轮询。

const SIDEBAR_CHAT_ORDER_KEY = "flowship:sidebar-chat-order";

/** 同页 promote 后派发，驱动侧栏重读 localStorage */
export const SIDEBAR_CHAT_ORDER_EVENT = "flowship:sidebar-chat-order";

/** 对话侧栏粘性 id 序（靠前的组 / 行在上） */
export const loadSidebarChatOrder = (): string[] => {
  try {
    const raw = JSON.parse(
      localStorage.getItem(SIDEBAR_CHAT_ORDER_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
};

/** 保存对话侧栏粘性序（整体覆盖） */
export const saveSidebarChatOrder = (ids: readonly string[]) => {
  try {
    localStorage.setItem(SIDEBAR_CHAT_ORDER_KEY, JSON.stringify([...ids]));
  } catch {
    /* 存储被禁忽略 */
  }
};

/** 用户发送 / 新建：把这条对话顶到粘性序最前，侧栏组也会跟着上来 */
export const promoteSidebarChat = (id: string): void => {
  const tid = id.trim();
  if (!tid) return;
  const prev = loadSidebarChatOrder();
  if (prev[0] === tid) return;
  saveSidebarChatOrder([tid, ...prev.filter((x) => x !== tid)]);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SIDEBAR_CHAT_ORDER_EVENT));
};
