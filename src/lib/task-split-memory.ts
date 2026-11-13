/**
 * 任务页左右分栏「哪一栏被收起」的记忆（纯函数 + 可注入 storage，可在 node 里测；client / server 都能 import）
 *
 * 之前：分栏的折叠态只活在 react-resizable-panels 的内存里——用户点头部分栏按钮把产物栏收起（事件流占满）、
 * 或把浏览器「放大」（事件流收起）之后，切到别的任务 / 对话页再切回来，页面重挂，两栏又都是展开的，要重新点一次。
 * 现在：每个任务各记一份「上次被收起的是哪一栏」，切回来按记忆把它收起。
 *
 * 存储形态：一个 JSON 对象 { [taskId]: "artifact" | "event-stream" }，**只存被收起的那一栏**——
 * 两栏都展开是默认值，展开就是删掉那一条，所以绝大多数任务一条记录都没有；上限 TASK_SPLIT_MAX_ENTRIES 条
 * （超出丢最久没动过的）。脏值 / 缺失 / storage 抛错一律当「没有记忆」（= 两栏都展开），永远不抛。
 *
 * 只记「用户的选择」：拖分隔条 / 点分栏按钮 / 点浏览器的放大；库因为窗口太窄自己折叠的不记
 * （窗口放大后它会自己回来，记下来反而把用户困在收起态）。写入点都在页面的用户动作里，见 page.tsx。
 */
import { isArtifactCollapsedSize } from "./task-split-layout";

/** 被收起的那一栏：artifact = 产物栏收起（事件流占满）；event-stream = 事件流收起（产物 / 浏览器占满） */
export type CollapsedPane = "artifact" | "event-stream";

export const TASK_SPLIT_KEY = "flowship.task-split-collapsed";

/** 最多记多少个任务的收起态；超出时丢最久没写过的那条 */
export const TASK_SPLIT_MAX_ENTRIES = 100;

/** 分栏组里两个 Panel 的 id（与 page.tsx 的 ResizablePanel id 一致；onLayoutChanged 的 layout 以它为键） */
export const ARTIFACT_PANEL_ID = "artifact";
export const EVENT_STREAM_PANEL_ID = "event-stream";

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // 隐私模式 / 被禁用时访问 localStorage 本身会抛
    return null;
  }
};

const isCollapsedPane = (v: unknown): v is CollapsedPane => v === "artifact" || v === "event-stream";

/** 读出整张表：只留「键是非空字符串、值是合法的栏名」的条目；任何异常 → 空表。用 Map：特殊 key（__proto__）不会污染原型 */
const readTable = (storage: StorageLike | null): Map<string, CollapsedPane> => {
  const table = new Map<string, CollapsedPane>();
  try {
    const raw = storage?.getItem(TASK_SPLIT_KEY);
    if (!raw) return table;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return table;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && isCollapsedPane(value)) table.set(id, value);
    }
  } catch {
    /* 脏 JSON / storage 抛错 → 当没有记忆 */
  }
  return table;
};

const writeTable = (storage: StorageLike | null, table: Map<string, CollapsedPane>): boolean => {
  try {
    if (!storage) return false;
    storage.setItem(TASK_SPLIT_KEY, JSON.stringify(Object.fromEntries(table)));
    return true;
  } catch {
    return false;
  }
};

/** 这个任务上次被收起的是哪一栏；没记过 / 读不出 → null（两栏都展开） */
export const readTaskSplit = (
  taskId: string,
  storage: StorageLike | null = defaultStorage(),
): CollapsedPane | null => (taskId ? (readTable(storage).get(taskId) ?? null) : null);

/**
 * 记下这个任务当前被收起的那一栏。写某一栏 = 记一条（并挪到最新）；写 null（都展开）= 删掉那条（默认值不占位置）。
 * 存不下就算了（本次运行内由组件状态保证生效）；返回是否写成功。没有变化时不写盘。
 */
export const writeTaskSplit = (
  taskId: string,
  pane: CollapsedPane | null,
  storage: StorageLike | null = defaultStorage(),
): boolean => {
  if (!taskId) return false;
  const table = readTable(storage);
  if (pane === null) {
    if (!table.delete(taskId)) return true; // 本来就没记 = 已经是目标状态
    return writeTable(storage, table);
  }
  if (!isCollapsedPane(pane)) return false;
  // 已经是「最新的一条」且值相同就不用重写
  const last = [...table.keys()].at(-1);
  if (last === taskId && table.get(taskId) === pane) return true;
  table.delete(taskId);
  table.set(taskId, pane);
  while (table.size > TASK_SPLIT_MAX_ENTRIES) {
    const oldest = table.keys().next().value;
    if (oldest === undefined) break;
    table.delete(oldest);
  }
  return writeTable(storage, table);
};

/** 任务被删除时顺手忘掉它（等价于写回「都展开」） */
export const forgetTaskSplit = (taskId: string, storage: StorageLike | null = defaultStorage()): boolean =>
  writeTaskSplit(taskId, null, storage);

/**
 * 从 onLayoutChanged 给的整份布局（{ [panelId]: 占比% }）判定「此刻哪一栏是收起的」：
 *  - "artifact" / "event-stream"：那一栏收起了（占比 < 1%，与 isArtifactCollapsedSize 同口径）；
 *  - "none"：两栏都有宽度；
 *  - "unknown"：布局里缺其中一栏 / 不是有限数字 / 两栏同时 < 1%（库对它没有定义）——**调用方不要据此写记忆**，
 *    免得一份残缺的布局把用户的记忆冲掉。
 */
export const collapsedPaneFromLayout = (
  layout: Readonly<Record<string, number>> | null | undefined,
): CollapsedPane | "none" | "unknown" => {
  const artifact = layout?.[ARTIFACT_PANEL_ID];
  const eventStream = layout?.[EVENT_STREAM_PANEL_ID];
  if (typeof artifact !== "number" || !Number.isFinite(artifact)) return "unknown";
  if (typeof eventStream !== "number" || !Number.isFinite(eventStream)) return "unknown";
  const artifactCollapsed = isArtifactCollapsedSize(artifact);
  const eventStreamCollapsed = isArtifactCollapsedSize(eventStream);
  if (artifactCollapsed && eventStreamCollapsed) return "unknown";
  if (artifactCollapsed) return "artifact";
  if (eventStreamCollapsed) return "event-stream";
  return "none";
};

/** Panel 命令式句柄里这里用到的两个方法（结构类型：库的 PanelImperativeHandle 满足它，测试里用假的） */
export interface CollapsiblePanelHandle {
  isCollapsed: () => boolean;
  collapse: () => void;
}

/**
 * 分栏挂好之后，按记忆把那一栏收起。返回 true = 此刻那一栏确实是收起的（本来就是 / 刚收成）。
 * 任何一步抛错（Group 还没挂好 / 约束冲突）都吞掉并返回 false：页面保持两栏展开，不会因为恢复失败而坏掉。
 * 只做「收起」一个动作——展开是默认态，不需要恢复。
 */
export const applyTaskSplitRestore = (
  pane: CollapsedPane | null,
  handles: { artifact: CollapsiblePanelHandle | null | undefined; eventStream: CollapsiblePanelHandle | null | undefined },
): boolean => {
  if (!pane) return false;
  const target = pane === "artifact" ? handles.artifact : handles.eventStream;
  if (!target) return false;
  try {
    if (target.isCollapsed()) return true;
    target.collapse();
    return target.isCollapsed();
  } catch {
    return false;
  }
};
