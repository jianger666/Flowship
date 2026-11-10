/**
 * 全局左侧栏（任务 / 对话列表）的宽度规则（纯函数 + 可注入 storage，可在 node 里测；client / server 都能 import）
 *
 * 以前侧栏是写死的 256px（w-64），只能整体展开 / 收起。现在可以拖右缘调宽、拖到很窄自动收起、
 * 双击复位、键盘调整；宽度记在本机 localStorage（全局一个值：合适的侧栏宽度跟屏幕有关，跟任务无关）。
 * 展开 / 收起态不在这里：它由 AppShell 按页型给默认值（设置页收、其余展），手动结果只在同页型内保留。
 */

export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
/**
 * 拖动时分隔条被拖到这个位置（距窗口左缘 px）以左 → 收起。
 * 低于 MIN 但高于它的这一段只夹到 MIN（不是「卡死」：再往左一点就收起），避免侧栏在 MIN 附近抖着收起 / 展开。
 */
export const SIDEBAR_COLLAPSE_BELOW = 140;
/** 拖宽侧栏时主区至少留这么宽：再窄任务页的分栏 / 对话输入条就挤坏了（窗口最小宽度 960 → 侧栏最宽 320） */
export const SIDEBAR_MAIN_MIN_WIDTH = 640;
/** 键盘方向键一次调整的宽度 */
export const SIDEBAR_KEY_STEP = 16;

export const SIDEBAR_WIDTH_KEY = "flowship:sidebar-width";

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 当前能拖到的最大宽度：不超过 MAX，也不把主区挤到 MAIN_MIN 以下；永远 ≥ MIN。
 * 容器宽度量不到（SSR / 0 / NaN）就只看 MAX。
 */
export const maxSidebarWidth = (containerWidth?: number | null): number => {
  if (!isFiniteNumber(containerWidth) || containerWidth <= 0) return SIDEBAR_MAX_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, containerWidth - SIDEBAR_MAIN_MIN_WIDTH));
};

/** 把任意宽度夹进 [MIN, 当前最大]，取整（半像素宽度会让右缘的 1px 分隔线发虚）；不是有限数 → 默认宽度 */
export const clampSidebarWidth = (width: unknown, containerWidth?: number | null): number => {
  const w = isFiniteNumber(width) ? width : SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(maxSidebarWidth(containerWidth), Math.max(SIDEBAR_MIN_WIDTH, w)));
};

export interface SidebarDragResult {
  open: boolean;
  /** 要写入的新宽度；null = 不改（收起时保留上次宽度，再展开回到它） */
  width: number | null;
}

/**
 * 拖动中分隔条应处的位置 → 侧栏该是什么状态。
 * @param boundaryX 分隔条左缘相对窗口左缘的 px（已扣掉按下时的抓取偏移）
 */
export const resolveSidebarDrag = (
  boundaryX: number,
  containerWidth?: number | null,
): SidebarDragResult => {
  if (!isFiniteNumber(boundaryX) || boundaryX < SIDEBAR_COLLAPSE_BELOW) {
    return { open: false, width: null };
  }
  return { open: true, width: clampSidebarWidth(boundaryX, containerWidth) };
};

/**
 * 分隔条聚焦时的键盘操作：← / → 按步长调、Home / End 到最小 / 最大、Enter 开合。
 * 返回 null = 这个键不处理（调用方别 preventDefault）。方向键不会把侧栏调到「收起」：收起走 Enter / 拖动 / 头部按钮。
 */
export const resolveSidebarKey = (
  key: string,
  state: { open: boolean; width: number },
  containerWidth?: number | null,
): SidebarDragResult | null => {
  const current = clampSidebarWidth(state.width, containerWidth);
  switch (key) {
    case "ArrowLeft":
      if (!state.open) return null;
      return { open: true, width: clampSidebarWidth(current - SIDEBAR_KEY_STEP, containerWidth) };
    case "ArrowRight":
      // 收起态按右键 = 展开（回到上次宽度）
      if (!state.open) return { open: true, width: current };
      return { open: true, width: clampSidebarWidth(current + SIDEBAR_KEY_STEP, containerWidth) };
    case "Home":
      return { open: true, width: SIDEBAR_MIN_WIDTH };
    case "End":
      return { open: true, width: maxSidebarWidth(containerWidth) };
    case "Enter":
      return { open: !state.open, width: null };
    default:
      return null;
  }
};

/** 存的值有效就用（夹进合法范围），否则默认宽度 */
export const resolveStoredSidebarWidth = (raw: unknown): number => {
  if (raw === null || raw === undefined || raw === "") return SIDEBAR_DEFAULT_WIDTH;
  const n = typeof raw === "number" ? raw : Number(raw);
  return isFiniteNumber(n) ? clampSidebarWidth(n) : SIDEBAR_DEFAULT_WIDTH;
};

export interface SidebarStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const defaultStorage = (): SidebarStorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const readSidebarWidth = (storage: SidebarStorageLike | null = defaultStorage()): number => {
  try {
    return resolveStoredSidebarWidth(storage?.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
};

export const writeSidebarWidth = (
  width: number,
  storage: SidebarStorageLike | null = defaultStorage(),
): boolean => {
  if (!isFiniteNumber(width)) return false;
  try {
    storage?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
    return true;
  } catch {
    // 存不下就算了，本次运行内仍然生效
    return false;
  }
};

// ---- 运行期 store（useSyncExternalStore 用）----
// 为什么不是 useState(() => readSidebarWidth())：AppShell 会先在服务端渲染一遍，服务端读不到 localStorage，
// 客户端首渲染读到了存的宽度 → hydration 时 style 对不上。useSyncExternalStore 的 getServerSnapshot
// 让 hydration 阶段先用默认宽度、之后再切到存的值，不报 mismatch。

let cachedWidth: number | null = null;
const listeners = new Set<() => void>();

export const getSidebarWidthSnapshot = (): number => {
  if (cachedWidth === null) cachedWidth = readSidebarWidth();
  return cachedWidth;
};

export const getSidebarWidthServerSnapshot = (): number => SIDEBAR_DEFAULT_WIDTH;

export const subscribeSidebarWidth = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** 更新运行期宽度；persist=false 用于拖动过程中（每帧写盘没必要，松手时再写一次） */
export const setSidebarWidth = (width: number, options: { persist?: boolean } = {}): void => {
  const next = clampSidebarWidth(width);
  if (next !== cachedWidth) {
    cachedWidth = next;
    for (const l of listeners) l();
  }
  if (options.persist !== false) writeSidebarWidth(next);
};

/** 测试用：丢掉运行期缓存与订阅 */
export const __resetSidebarWidthStoreForTests = (): void => {
  cachedWidth = null;
  listeners.clear();
};
