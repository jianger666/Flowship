/**
 * 在文件夹中显示 / 用系统默认应用打开：按平台拼 spawn 参数（纯函数、可单测）
 *
 * server route 与 vitest 共用，避免 macOS / Windows 分支在 API 里复制粘贴。
 */

export interface OsSpawnSpec {
  command: string;
  args: string[];
  /**
   * Windows explorer 常以非 0 退出但仍成功拉起资源管理器——
   * route 对这类 command 应忽略 exit code（只认 spawn error）。
   */
  ignoreNonZeroExit?: boolean;
}

/** Windows 路径交给 explorer 前必须用反斜杠：正斜杠会被当成 /switch（打开错目录 / Documents） */
export const toWindowsExplorerPath = (absPath: string): string =>
  absPath.replace(/\//g, "\\");

/** macOS: open -R；Windows: explorer /select,；其它平台 best-effort 打开父目录 */
export const buildRevealInFolderSpec = (
  absPath: string,
  platform: NodeJS.Platform,
): OsSpawnSpec => {
  if (platform === "darwin") {
    return { command: "open", args: ["-R", absPath] };
  }
  if (platform === "win32") {
    // 正斜杠会被 explorer 当成 /switch（打开错目录）；空格路径需引号。
    // 单 argv `/select,"C:\a b\f"` 与 Electron shell.showItemInFolder 同款。
    const winPath = toWindowsExplorerPath(absPath);
    return {
      command: "explorer.exe",
      args: [`/select,"${winPath}"`],
      ignoreNonZeroExit: true,
    };
  }
  // Linux 等：xdg-open 父目录（无法选中文件本身、比完全没反应强）
  const sep = absPath.includes("\\") ? "\\" : "/";
  const parent = absPath.slice(0, absPath.lastIndexOf(sep));
  return { command: "xdg-open", args: [parent || absPath] };
};

/** macOS: open；Windows: cmd /c start ""；Linux: xdg-open */
export const buildOpenPathSpec = (
  absPath: string,
  platform: NodeJS.Platform,
): OsSpawnSpec => {
  if (platform === "darwin") {
    return { command: "open", args: [absPath] };
  }
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", toWindowsExplorerPath(absPath)],
    };
  }
  return { command: "xdg-open", args: [absPath] };
};
