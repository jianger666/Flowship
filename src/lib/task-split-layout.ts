/**
 * task 详情页左右分栏（产物栏 / 事件流栏）的尺寸规则（纯函数、可单测；client / server 都能 import）
 *
 * 背景（第二轮 review V13-01/03/04/05）：Electron 默认 1280×800，侧栏 257px + 事件流栏默认 30%
 * ⇒ task 事件流栏只有约 307px——4 列表格每列只剩 2 个汉字宽、答题卡「提交全部回答」顶出卡边、
 * Cmd+F 搜索框只剩约 5 个汉字宽。治本是三件事（窗口 minWidth/minHeight 在 Electron main 里另改）：
 *  - 事件流面板用**像素**下限，而不是 20%；
 *  - 默认宽度 `max(30%, 380px)`；
 *  - 产物栏可一键折叠（把整个宽度让给事件流）。
 *
 * react-resizable-panels 的 defaultSize 只认 %/px/rem/vh/vw，写不了 CSS `max()`，
 * 所以由调用方量出容器宽度，再在这里换算成百分比。
 */

/** 事件流面板的最小宽度（px）：低于它表格 / 答题卡 / 搜索框就失效 */
export const EVENT_STREAM_MIN_PX = 320;
/** 事件流面板没有已存布局时的默认宽度下限（px）；与默认比例 30% 取较大者 */
export const EVENT_STREAM_DEFAULT_MIN_PX = 380;
/** 事件流面板的默认比例 */
export const EVENT_STREAM_DEFAULT_PERCENT = 30;
/**
 * 产物栏未折叠时事件流栏的占比上限（%）= 100 − 产物栏 minSize(20%)。
 * 事件流 Panel 自己**不设** maxSize（默认 100%）：产物栏折叠后它才能吃满整行；
 * 未折叠时这条上限由产物栏的 minSize 保证，这里只用来给默认宽度封顶。
 */
export const EVENT_STREAM_MAX_PERCENT = 80;
/**
 * 产物栏的 maxSize（%）。以前是 80（事件流不可折叠、至少留 20%）；事件流栏现在也能折叠（把整行让给浏览器 / 产物），
 * 折叠后产物栏必须能占满 100%，否则库会把 20% 还给事件流、折叠不住。
 * 事件流不会因此被「盖没」：拖到它的像素下限（EVENT_STREAM_MIN_PX）以下只会夹住，再往下过一半才折叠。
 */
export const ARTIFACT_PANEL_MAX_PERCENT = 100;
/** 没有已存布局、也量不到容器宽度时的旧默认（产物栏 70%） */
export const FALLBACK_ARTIFACT_PERCENT = 70;

const ARTIFACT_SIZE_MIN_VALID = 10;
const ARTIFACT_SIZE_MAX_VALID = 90;

/**
 * 已存的产物栏比例是否有效（读与写同一个口径）。
 * 写的一侧靠它挡掉折叠态的 0——否则折叠一下就把用户上次拖出来的宽度覆盖成 0。
 */
export const isValidArtifactPanelSize = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= ARTIFACT_SIZE_MIN_VALID &&
  v <= ARTIFACT_SIZE_MAX_VALID;

/** 产物栏当前宽度（占整个分栏组的百分比）是否已折叠（collapsedSize=0） */
export const isArtifactCollapsedSize = (sizePercent: number): boolean => sizePercent < 1;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 产物栏的默认比例（事件流 = 100 − 它）。
 *  - 已存的合法布局优先；
 *  - 否则事件流取 max(30%, 380px)，且不超过它的 maxSize；
 *  - 量不到宽度（null / 0 / NaN）→ 旧默认 70。
 */
export const resolveArtifactDefaultPercent = (input: {
  persisted: number | null | undefined;
  containerWidth: number | null | undefined;
}): number => {
  if (isValidArtifactPanelSize(input.persisted)) return input.persisted;
  const width = input.containerWidth;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    return FALLBACK_ARTIFACT_PERCENT;
  }
  const eventPercent = Math.min(
    Math.max(EVENT_STREAM_DEFAULT_PERCENT, (EVENT_STREAM_DEFAULT_MIN_PX / width) * 100),
    EVENT_STREAM_MAX_PERCENT,
  );
  return round2(100 - eventPercent);
};

export type SplitPane = "artifact" | "event-stream";

export interface SplitTogglePlan {
  action: "collapse" | "expand";
  /** collapse 之前要先展开的另一栏：两栏都折叠就是一片空白，且库对「两栏同时为 0」的布局没有定义 */
  expandFirst: SplitPane | null;
}

/**
 * 点某一栏的折叠 / 展开按钮该做什么（纯决策，页面按它命令式驱动 Panel）。
 * 折叠目标栏时若另一栏已经折叠了 → 先把另一栏展开（等于「换边」），永远至少有一栏看得见。
 */
export const planSplitToggle = (input: {
  target: SplitPane;
  artifactCollapsed: boolean;
  eventStreamCollapsed: boolean;
}): SplitTogglePlan => {
  const { target, artifactCollapsed, eventStreamCollapsed } = input;
  const targetCollapsed = target === "artifact" ? artifactCollapsed : eventStreamCollapsed;
  if (targetCollapsed) return { action: "expand", expandFirst: null };
  const otherCollapsed = target === "artifact" ? eventStreamCollapsed : artifactCollapsed;
  const other: SplitPane = target === "artifact" ? "event-stream" : "artifact";
  return { action: "collapse", expandFirst: otherCollapsed ? other : null };
};
