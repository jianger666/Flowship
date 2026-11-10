/**
 * chat 页右侧浏览器栏的宽度 / 开合记忆（纯逻辑 + 可注入 storage，可在 node 里测）
 *
 * 为什么不沿用 task 页的 `task.uiLayout`（setTaskUiLayout）：那条路写进服务端 meta、
 * 字段 / 校验在 server（artifactPanelSize 之外的字段会被 PATCH 路由拒掉），UI 组不能碰。
 * 所以宽度记在本机 localStorage（全局一个值，不分任务——浏览器栏的合适宽度跟屏幕有关、跟任务无关）；
 * 开合只在本次运行内按任务记忆（默认收起，重启后不自动弹出一个空面板）。
 */

export const CHAT_BROWSER_WIDTH_KEY = "flowship.chat-browser-width";

/** 默认宽度（占整个分栏组的百分比） */
export const CHAT_BROWSER_DEFAULT_PERCENT = 42;
/** 合法范围：太窄浏览器没法用、太宽把对话挤没了 */
export const CHAT_BROWSER_MIN_PERCENT = 25;
export const CHAT_BROWSER_MAX_PERCENT = 70;

/** 对话栏的像素下限（与 task 页事件流栏同口径：再窄输入框 / 答题卡就失效） */
export const CHAT_MAIN_MIN_PX = 320;
/** 浏览器栏的像素下限（拖到它以下自动收起） */
export const CHAT_BROWSER_MIN_PX = 300;

/**
 * task 页左栏（产物栏）的 minSize：产物标签下照旧 20%；**浏览器标签激活时用像素下限**（R1-37）。
 * 960px 最小窗口下主区只有 ~700px，20% 只有约 140px，浏览器工具栏（后退 / 前进 / 地址栏 / 拾取 / 更多…）
 * 没有溢出收纳，挤成一团；像素下限与 chat 页的浏览器栏同口径（CHAT_BROWSER_MIN_PX）。
 * 拖到下限以下仍会自动折叠（ResizablePanel 是 collapsible），所以不是「卡死不让缩」。
 * react-resizable-panels v4 的 minSize 接受 "300px" 这类字符串，组件重渲时会按新约束重算布局。
 */
export const TASK_ARTIFACT_MIN_PERCENT = 20;
export const TASK_BROWSER_MIN_PX = CHAT_BROWSER_MIN_PX;
export const resolveTaskLeftPaneMinSize = (browserTabActive: boolean): string =>
  browserTabActive ? `${TASK_BROWSER_MIN_PX}px` : `${TASK_ARTIFACT_MIN_PERCENT}%`;

/**
 * 切到浏览器标签之前，把左栏放宽到像素下限（R2-14 ③）。
 *
 * 为什么必须「先放宽、再换标签」：`minSize` 随标签变化会让 Panel 重新注册，库随即按**新约束**重新校验当前布局
 * （react-resizable-panels 4.11.1 已读源码）——栏宽 < 新下限一半时直接折叠，一半以上才夹到下限；
 * 命令式 `expand()` 读的却是**上一次注册**的约束（`derivedPanelConstraints`，换标签的重渲染还没发生），
 * 所以在 `setLeftTab("browser")` 之后立刻 `expand()` 也救不了：展开到旧下限（20% ≈ 140px），随后被新约束再折叠一次。
 * 做法：在旧约束仍然有效的这一刻（换标签之前）把栏显式 resize 到像素下限——旧下限 ≤ 300px、旧上限 ≥ 它，
 * resize 合法；之后新约束注册时当前宽度已经 ≥ 下限，库不会折叠也不会夹取。
 *
 * 这里只含决策（纯函数）：真窗口里库的实际表现未验证（需要真窗口，见 R2-14 ③ 的处理说明）。
 */
export interface BrowserPaneEntryPlan {
  /** 要 resize 到的像素串（如 "300px"）；null = 不用动 */
  resizeTo: string | null;
}

export const planBrowserPaneEntry = (input: {
  /** 栏当前宽度占分栏组的百分比（折叠态 0） */
  percent: number;
  /** 分栏组的像素宽度；量不到传 null / 0 */
  groupWidthPx: number | null | undefined;
  minPx?: number;
}): BrowserPaneEntryPlan => {
  const minPx = input.minPx ?? TASK_BROWSER_MIN_PX;
  const { percent, groupWidthPx } = input;
  // 量不到就不动：交回库按它的规则处理（= 本修复之前的行为），不拿一个猜出来的宽度去 resize
  if (!Number.isFinite(percent) || percent < 0) return { resizeTo: null };
  if (typeof groupWidthPx !== "number" || !Number.isFinite(groupWidthPx) || groupWidthPx <= 0) {
    return { resizeTo: null };
  }
  const widthPx = (percent / 100) * groupWidthPx;
  // 0.5px 容差：百分比 ↔ 像素换算的浮点误差不该触发一次多余的 resize
  return widthPx + 0.5 < minPx ? { resizeTo: `${minPx}px` } : { resizeTo: null };
};

/** Panel 命令式句柄里这里用到的那几个方法（结构类型：库的 PanelImperativeHandle 满足它，测试里用假的） */
export interface PaneHandleLike {
  isCollapsed: () => boolean;
  expand: () => void;
  resize: (size: number | string) => void;
  getSize: () => { asPercentage: number };
}

export interface BrowserPaneEntryResult {
  /** 进来时栏是折叠的，已 expand() */
  expanded: boolean;
  /** 放宽到的像素串；null = 没动 */
  widenedTo: string | null;
}

/**
 * 切到浏览器标签前对左栏做的全部命令式操作（调用方在 `setLeftTab("browser")` 之前调它）：
 * 折叠态先 expand()（恢复折叠前的宽度）→ 读展开后的宽度 → 不足下限就 resize 到下限。
 * 任何一步抛错（Group 还没挂好 / 约束冲突）都吞掉并返回「没动」：状态切换照常进行，布局交回库兜底。
 */
export const prepareBrowserPaneEntry = (
  panel: PaneHandleLike | null | undefined,
  groupWidthPx: number | null | undefined,
): BrowserPaneEntryResult => {
  const result: BrowserPaneEntryResult = { expanded: false, widenedTo: null };
  if (!panel) return result;
  try {
    if (panel.isCollapsed()) {
      panel.expand();
      result.expanded = true;
    }
    const plan = planBrowserPaneEntry({ percent: panel.getSize().asPercentage, groupWidthPx });
    if (plan.resizeTo) {
      panel.resize(plan.resizeTo);
      result.widenedTo = plan.resizeTo;
    }
  } catch {
    // 见函数注释
  }
  return result;
};

export const isValidChatBrowserPercent = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= CHAT_BROWSER_MIN_PERCENT &&
  v <= CHAT_BROWSER_MAX_PERCENT;

/** 存的值有效就用，否则默认；两位小数 */
export const resolveChatBrowserPercent = (stored: unknown): number => {
  if (isValidChatBrowserPercent(stored)) return Math.round(stored * 100) / 100;
  return CHAT_BROWSER_DEFAULT_PERCENT;
};

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const readChatBrowserPercent = (storage: StorageLike | null = defaultStorage()): number => {
  try {
    const raw = storage?.getItem(CHAT_BROWSER_WIDTH_KEY);
    return resolveChatBrowserPercent(raw == null ? null : Number(raw));
  } catch {
    return CHAT_BROWSER_DEFAULT_PERCENT;
  }
};

/** 只写有效值：折叠态的 0 写下去会把用户上次拖出来的宽度覆盖掉（与 task 页 isValidArtifactPanelSize 同理） */
export const writeChatBrowserPercent = (
  percent: number,
  storage: StorageLike | null = defaultStorage(),
): boolean => {
  if (!isValidChatBrowserPercent(percent)) return false;
  try {
    storage?.setItem(CHAT_BROWSER_WIDTH_KEY, String(Math.round(percent * 100) / 100));
    return true;
  } catch {
    // 存不下就算了，本次运行内仍然生效
    return false;
  }
};

/** 本次运行内「某任务的 chat 浏览器栏开没开」；模块级，切走再切回不丢，重启后默认收起 */
const openMemory = new Map<string, boolean>();

export const readChatBrowserOpen = (taskId: string): boolean => openMemory.get(taskId) === true;

export const writeChatBrowserOpen = (taskId: string, open: boolean): void => {
  if (open) openMemory.set(taskId, true);
  else openMemory.delete(taskId);
};
