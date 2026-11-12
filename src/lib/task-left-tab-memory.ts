/**
 * 任务页左栏「产物 | 浏览器」标签的记忆（纯函数 + 可注入 storage，可在 node 里测；client / server 都能 import）
 *
 * 之前：左栏标签是页面里的一个 useState，切到别的任务 / 对话页再回来就被重置成「产物」——
 * 在浏览器里盯着预览页的人，每次切走再切回都要重新点一下「浏览器」。
 * 现在：每个任务各记一份「上次停在哪个标签」，切走再切回来定位回去。
 *
 * 存储形态：一个 JSON 对象 { [taskId]: "browser" }，**只存浏览器**——「产物」是默认值，切回产物就是删掉那一条，
 * 所以绝大多数任务一条记录都没有；上限 MAX_ENTRIES 条（超出丢最久没动过的），不会随任务数无限长。
 * 脏值 / 缺失 / storage 抛错一律当「没有记忆」（= 产物），永远不抛。
 */

export type RememberedLeftTab = "artifact" | "browser";

export const TASK_LEFT_TAB_KEY = "flowship.task-left-tab";

/** 最多记多少个任务的「浏览器」标签；超出时丢最久没写过的那条 */
export const TASK_LEFT_TAB_MAX_ENTRIES = 100;

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

/** 读出整张表：只留「值恰好是 browser、键是非空字符串」的条目；任何异常 → 空表 */
const readTable = (storage: StorageLike | null): Map<string, "browser"> => {
  const table = new Map<string, "browser">();
  try {
    const raw = storage?.getItem(TASK_LEFT_TAB_KEY);
    if (!raw) return table;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return table;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && value === "browser") table.set(id, "browser");
    }
  } catch {
    /* 脏 JSON / storage 抛错 → 当没有记忆 */
  }
  return table;
};

const writeTable = (storage: StorageLike | null, table: Map<string, "browser">): boolean => {
  try {
    if (!storage) return false;
    storage.setItem(TASK_LEFT_TAB_KEY, JSON.stringify(Object.fromEntries(table)));
    return true;
  } catch {
    return false;
  }
};

/** 这个任务上次停在哪个标签；没记过 / 读不出 → "artifact" */
export const readTaskLeftTab = (
  taskId: string,
  storage: StorageLike | null = defaultStorage(),
): RememberedLeftTab => (taskId && readTable(storage).has(taskId) ? "browser" : "artifact");

/**
 * 记下这个任务当前的标签。写「浏览器」= 记一条（并挪到最新）；写「产物」= 删掉那条（默认值不占位置）。
 * 存不下就算了（本次运行内由组件状态保证生效）；返回是否写成功。没有变化时不写盘。
 */
export const writeTaskLeftTab = (
  taskId: string,
  tab: RememberedLeftTab,
  storage: StorageLike | null = defaultStorage(),
): boolean => {
  if (!taskId) return false;
  const table = readTable(storage);
  if (tab === "artifact") {
    if (!table.delete(taskId)) return true; // 本来就没记 = 已经是目标状态
    return writeTable(storage, table);
  }
  // 浏览器：已经是「最新的一条」就不用重写
  const last = [...table.keys()].at(-1);
  if (last === taskId) return true;
  table.delete(taskId);
  table.set(taskId, "browser");
  while (table.size > TASK_LEFT_TAB_MAX_ENTRIES) {
    const oldest = table.keys().next().value;
    if (oldest === undefined) break;
    table.delete(oldest);
  }
  return writeTable(storage, table);
};

/** 任务被删除时顺手忘掉它（等价于写回「产物」） */
export const forgetTaskLeftTab = (taskId: string, storage: StorageLike | null = defaultStorage()): boolean =>
  writeTaskLeftTab(taskId, "artifact", storage);
