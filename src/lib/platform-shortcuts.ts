/**
 * 壳平台 + 快捷键展示文案（SSR 安全、可单测）
 *
 * macOS 显示 ⌘，Windows/Linux 显示 Ctrl——禁止写死 Cmd/Ctrl 或只写 Mac 文案。
 */

export type ShellPlatform = "darwin" | "win32" | "linux" | "";

export const normalizeShellPlatform = (
  platform: string | undefined | null,
): ShellPlatform => {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  return "";
};

/** 客户端读 Electron preload 平台；SSR / 无壳时返回 "" */
export const getShellPlatform = (): ShellPlatform => {
  if (typeof window === "undefined") return "";
  const platform = (
    window as unknown as { __shell?: { platform?: string } }
  ).__shell?.platform;
  return normalizeShellPlatform(platform);
};

export const isMacPlatform = (platform: ShellPlatform): boolean =>
  platform === "darwin";

/** Mod+F 键位胶囊（⌘F / Ctrl+F） */
export const getModFShortcutLabel = (platform: ShellPlatform): string =>
  isMacPlatform(platform) ? "⌘F" : "Ctrl+F";

/** 「搜索此栏」tooltip / aria 完整文案 */
export const getSearchThisPaneLabel = (platform: ShellPlatform): string =>
  `搜索此栏（${getModFShortcutLabel(platform)}）`;
