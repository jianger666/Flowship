/**
 * Windows titleBarOverlay（右上角系统窗口按钮条）配色
 *
 * 原生按钮画在 web 内容之上：Dialog / Sheet 蒙层盖不住它们。
 * 弹层打开时把 overlay 底色压到接近 `bg-black/10` 叠在 header 上的观感，关层再还原。
 *
 * 改 globals.css --background 时：这里 + electron-app/main.js 的 HEADER_BG_* 一起换算。
 */

export type TitleBarOverlayTheme = "light" | "dark";

export type TitleBarOverlayColors = {
  color: string;
  symbolColor: string;
};

/** 与 app header / 壳启动底色对齐的 oklch(--background) 精确 hex */
export const TITLEBAR_OVERLAY_COLOR: Record<
  TitleBarOverlayTheme,
  TitleBarOverlayColors
> = {
  dark: { color: "#0e0f12", symbolColor: "#e5e5e5" },
  light: { color: "#f3f4f5", symbolColor: "#404040" },
};

/**
 * 蒙层打开时的底色：header 色 × 90% + 黑 10%（对齐 Dialog `bg-black/10`）。
 * Sheet 是 black/20，略深一点仍可接受——共用一份避免嵌套弹层跳色。
 */
export const TITLEBAR_OVERLAY_DIMMED: Record<
  TitleBarOverlayTheme,
  TitleBarOverlayColors
> = {
  dark: { color: "#0d0e10", symbolColor: "#e5e5e5" },
  light: { color: "#dbdcdd", symbolColor: "#404040" },
};

/** 嵌套 Dialog / Sheet 共用计数，避免内层关掉时过早还原 */
let dimDepth = 0;
let lastTheme: TitleBarOverlayTheme = "light";

type ShellWithTitleBar = {
  platform?: string;
  setTitleBarOverlay?: (opts: TitleBarOverlayColors) => void;
};

const readShell = (): ShellWithTitleBar | undefined => {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { __shell?: ShellWithTitleBar }).__shell;
};

const applyOverlay = (dimmed: boolean) => {
  const shell = readShell();
  if (!shell?.setTitleBarOverlay || shell.platform === "darwin") return;
  const table = dimmed ? TITLEBAR_OVERLAY_DIMMED : TITLEBAR_OVERLAY_COLOR;
  shell.setTitleBarOverlay(table[lastTheme]);
};

/** AppHeader 主题变化时调用：记住主题；无蒙层时立刻刷底色 */
export const syncTitleBarOverlayTheme = (theme: TitleBarOverlayTheme) => {
  lastTheme = theme;
  applyOverlay(dimDepth > 0);
};

/** 蒙层挂载（open）时 acquire；卸载 / close 时 release */
export const acquireTitleBarOverlayDim = () => {
  dimDepth += 1;
  if (dimDepth === 1) applyOverlay(true);
};

export const releaseTitleBarOverlayDim = () => {
  dimDepth = Math.max(0, dimDepth - 1);
  if (dimDepth === 0) applyOverlay(false);
};

/** 测试用：重置计数与主题 */
export const resetTitleBarOverlayDimForTests = () => {
  dimDepth = 0;
  lastTheme = "light";
};
