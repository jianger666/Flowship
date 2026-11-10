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
/** 记住的宽度的合法范围：太窄浏览器没法用 */
export const CHAT_BROWSER_MIN_PERCENT = 25;
/**
 * 浏览器栏的 maxSize（%）= 100：允许盖住整个对话栏（对话栏 collapsible，被挤到像素下限的一半以下就折叠成 0）。
 * 以前是 70，再加对话栏 320px 的像素下限，1000px 宽的主区里浏览器最多 ~680px——「最宽也没多宽」。
 */
export const CHAT_BROWSER_MAX_PERCENT = 100;
/**
 * 能被**记住**的最大宽度（%）。盖住对话栏时浏览器是 100%，不在此列：那是一次性的「放大」状态，
 * 不写进记忆——否则下次打开浏览器就直接盖住对话，用户得先还原。
 * 90 而不是 70：大屏上用户拖到 80% 多也是对话还剩 300px 以上的合理宽度，应该被记住。
 */
export const CHAT_BROWSER_REMEMBER_MAX_PERCENT = 90;

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
  v <= CHAT_BROWSER_REMEMBER_MAX_PERCENT;

/**
 * 点「浏览器」打开面板时要 resize 到的百分比：记住的宽度，但不能让对话栏落到像素下限以下。
 * 对话栏现在是 collapsible——命令式 resize 把它挤到下限的一半以下，库会直接把它折叠（= 打开浏览器的同时对话消失），
 * 这不是用户点「浏览器」想要的。窗口比记宽度时小（换显示器 / 侧栏被拖宽了）就会这样。
 * 量不到分栏组宽度时原样返回；窗口窄到连「对话下限 + 浏览器下限」都放不下，保浏览器下限（这时库自己会裁决）。
 */
export const resolveChatBrowserOpenPercent = (
  rememberedPercent: number,
  groupWidthPx: number | null | undefined,
): number => {
  if (typeof groupWidthPx !== "number" || !Number.isFinite(groupWidthPx) || groupWidthPx <= 0) {
    return rememberedPercent;
  }
  const maxPercent = (1 - CHAT_MAIN_MIN_PX / groupWidthPx) * 100;
  const minPercent = (CHAT_BROWSER_MIN_PX / groupWidthPx) * 100;
  const clamped = Math.max(minPercent, Math.min(rememberedPercent, maxPercent));
  return Math.round(clamped * 100) / 100;
};

/** 对话栏当前宽度（占分栏组的百分比）是否已被浏览器盖住（collapsedSize=0；同 isArtifactCollapsedSize 口径） */
export const isChatCoveredSize = (chatMainPercent: number): boolean => chatMainPercent < 0.5;

export const CHAT_MAIN_PANEL_ID = "chat-main";
export const CHAT_BROWSER_PANEL_ID = "chat-browser";

/** chat 分栏里 Panel 命令式句柄用到的方法（结构类型：库的 PanelImperativeHandle 满足它，测试里用假的） */
export interface ChatPanelHandleLike {
  resize: (size: string) => void;
  collapse: () => void;
  isCollapsed: () => boolean;
}

/** Group 句柄用到的方法（库的 GroupImperativeHandle 满足它） */
export interface ChatGroupHandleLike {
  setLayout: (layout: Record<string, number>) => unknown;
}

export interface ChatSplitHandles {
  main: ChatPanelHandleLike | null | undefined;
  browser: ChatPanelHandleLike | null | undefined;
  group: ChatGroupHandleLike | null | undefined;
}

export type ChatSplitCommand =
  /** 放大：浏览器栏占满，对话栏折叠成 0 */
  | { kind: "cover" }
  /** 还原：回到「浏览器栏 = browserPercent」 */
  | { kind: "restore"; browserPercent: number }
  /** 关闭浏览器：对话栏占满，浏览器栏折叠成 0 */
  | { kind: "close" };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 对 chat 分栏下命令——**命令发给哪个 Panel 是关键**，所以收成一处、有单测、有真库回归（scripts/browser-e2e/r9-chat-split-cover.cjs）。
 *
 * 为什么不能一律对浏览器栏下命令：react-resizable-panels 4.11.1 对「最后一个 Panel 缩小、且它前面的 Panel 全是折叠态」
 * 有一条特判——直接把它设成 100 − 前面之和（= 100），即**什么都不变、也不抛错**。盖住态下对话栏折叠、浏览器栏是最后一个，
 * 所以对浏览器栏的 resize(记住宽度) / collapse() 全部静默无效（审核 R8-02：还原 / 头部按钮 / X 都失灵）。
 * 因此：还原 = 让**对话栏**展开到 100 − 浏览器宽度；盖住态下关闭 = 让**对话栏**占满（浏览器栏随之折叠）。
 *
 * 发完命令回读折叠态：没生效就用 Group 的 setLayout 兜底（它直接给出整份布局，不走 delta 特判），
 * 不再靠 try/catch 把「静默无效」吞掉。返回 true = 最终生效了（含走了兜底）。
 */
export const applyChatSplitCommand = (cmd: ChatSplitCommand, handles: ChatSplitHandles): boolean => {
  const { main, browser, group } = handles;
  if (!main || !browser) return false;
  const fallback = (layout: { main: number; browser: number }) => {
    try {
      group?.setLayout({ [CHAT_MAIN_PANEL_ID]: layout.main, [CHAT_BROWSER_PANEL_ID]: layout.browser });
    } catch {
      // Group 已卸载 / 约束冲突：保持现状
    }
  };
  try {
    switch (cmd.kind) {
      case "cover": {
        browser.resize("100%");
        if (!main.isCollapsed()) fallback({ main: 0, browser: 100 });
        return main.isCollapsed();
      }
      case "restore": {
        const browserPercent = round2(cmd.browserPercent);
        const mainPercent = round2(100 - browserPercent);
        main.resize(`${mainPercent}%`);
        if (main.isCollapsed()) fallback({ main: mainPercent, browser: browserPercent });
        return !main.isCollapsed();
      }
      case "close": {
        // 以布局本身（对话栏是不是折叠）为准，不信 React 里可能慢一拍的 chatCovered
        if (main.isCollapsed()) main.resize("100%");
        else browser.collapse();
        if (!browser.isCollapsed()) fallback({ main: 100, browser: 0 });
        return browser.isCollapsed();
      }
    }
  } catch {
    return false;
  }
};

/**
 * 挂载后修一次：挂载路径（切任务 / 重进聊天页、open 在内存里是 true）把记住的百分比原样当 defaultSize，
 * 记住 85–90% 而容器放不下 320px 对话栏时，库在注册时就把对话栏折叠了——页面一打开就是被盖住的（审核 R8-03）。
 * 「被盖住」是一次性的放大状态、从不持久化，所以挂载时对话栏折叠一定是库的产物，不是用户意图 → 还原到夹取后的宽度。
 * 没折叠（正常，或库只是夹到了下限）就不动。返回 true = 做了修复。
 */
export const repairChatSplitAfterMount = (
  handles: ChatSplitHandles,
  rememberedPercent: number,
  groupWidthPx: number | null | undefined,
): boolean => {
  try {
    if (!handles.main?.isCollapsed()) return false;
  } catch {
    // Panel 还没注册完：交回库按它的规则处理
    return false;
  }
  return applyChatSplitCommand(
    { kind: "restore", browserPercent: resolveChatBrowserOpenPercent(rememberedPercent, groupWidthPx) },
    handles,
  );
};

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
