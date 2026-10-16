/**
 * 在文件夹中显示 / 用系统默认应用打开：按平台拼 spawn 参数（纯函数、可单测）
 *
 * server route 与 vitest 共用，避免 macOS / Windows 分支在 API 里复制粘贴。
 */

import path from "node:path";

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

/**
 * Windows 不经 cmd 打开「文件 / URL」：`rundll32 url.dll,FileProtocolHandler <target>`
 * （底层即 ShellExecute，与双击 / start 同款关联逻辑）。
 *
 * 为什么不用 `cmd /c start "" <target>`：cmd 会把 target 里的 `&` `|` `^` `%VAR%`
 * 当元字符解释——URL 带 query 的 `&`（飞书授权链接必有）会把命令截断，
 * 文件名含 `&`（如 `A&B.md`）同理，且攻击者可构造 `x&calc` 注入任意命令。
 * 直接 spawn rundll32 时 target 只是一个 argv，没有 shell 解析这一层。
 */
const winShellOpenSpec = (target: string): OsSpawnSpec => ({
  command: "rundll32.exe",
  args: ["url.dll,FileProtocolHandler", target],
});

/**
 * 「用系统默认应用打开」会被 ShellExecute / LaunchServices 当成「执行」的扩展名（小写、不含点）。
 * 命中的文件一律不直接打开，降级为「在文件管理器中显示」。
 * 注意：这是黑名单，只能挡住已知危险类型；macOS 上无扩展名的 Unix 可执行文件
 * 纯函数层无法识别（需要 stat 可执行位），见 buildOpenPathPlan 注释。
 */
const WIN_EXECUTABLE_EXTS = new Set([
  "bat", "cmd", "com", "exe", "scr", "pif", "lnk", "url", "hta", "msi", "msp", "mst",
  "ps1", "psm1", "psd1", "ps1xml", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ws", "reg", "jar",
  "cpl", "msc", "inf", "scf", "sct", "gadget", "application", "appref-ms", "settingcontent-ms",
  "library-ms", "search-ms", "diagcab", "xll", "appx", "msix", "appxbundle", "msixbundle",
  "dll", "sys", "drv", "ocx",
]);
const MAC_EXECUTABLE_EXTS = new Set([
  "app", "command", "terminal", "workflow", "pkg", "mpkg", "action", "tool", "sh", "csh", "zsh",
  "bash", "scpt", "scptd", "osax", "prefpane", "saver", "kext", "jar", "webloc", "inetloc",
  "fileloc",
]);
const LINUX_EXECUTABLE_EXTS = new Set(["desktop", "appimage", "run", "bin", "jar"]);

/**
 * 取「Windows 实际会用来匹配关联程序的扩展名」：
 * 先规范化路径、取最后一段有效文件名；
 * 去掉盘符前缀（`C:evil.exe`）、NTFS 备用数据流（`evil.exe::$DATA` / `evil.bat:x`），
 * 再去掉尾部的空格 / 点（Win32 路径规范化会静默丢掉它们：`evil.bat. ` 实际就是 evil.bat）。
 */
const windowsEffectiveExt = (absPath: string): string => {
  // path.win32.normalize 先消掉 `.` / `..` 段（`evil.exe\.`、`x\..\evil.exe` 都会落到 evil.exe）
  const segments = path.win32.normalize(toWindowsExplorerPath(absPath)).split("\\");
  for (let i = segments.length - 1; i >= 0; i--) {
    let base = segments[i].replace(/^[a-zA-Z]:/, "");
    const colon = base.indexOf(":");
    if (colon >= 0) base = base.slice(0, colon);
    base = base.replace(/[\s.]+$/, "");
    // 段在剥掉空格 / 点后为空（如 `. `、尾部分隔符）：Win32 会丢掉它，看上一段
    if (!base) continue;
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  }
  return "";
};

/** macOS：路径中任一祖先目录是 .app 包（`Foo.app/Contents/MacOS/Foo` 会被 open 当可执行文件跑） */
const insideMacAppBundle = (absPath: string): boolean =>
  absPath
    .split("/")
    .slice(0, -1)
    .some((seg) => /\.app\s*$/i.test(seg));

const posixEffectiveExt = (absPath: string): string => {
  const trimmed = absPath.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/\s+$/, "");
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/**
 * Windows UNC / 设备命名空间路径（`\\host\share`、`//host/share`、`\\?\...`、`\\.\...`）。
 * 对这类路径做 open 或 explorer /select 都会让系统主动连 SMB（泄漏 NTLM 凭据），一律拒绝。
 * 仅对 Windows 有意义（posix 上 `//x` 只是普通路径），调用方按平台判断。
 */
export const isWindowsUncPath = (absPath: string): boolean =>
  /^[\\/]{2}/.test(absPath);

export type OpenPathPlan =
  | { kind: "open"; spec: OsSpawnSpec }
  /** 危险文件类型：不执行，只在文件管理器中选中 */
  | { kind: "reveal"; spec: OsSpawnSpec; notice: string }
  /** 没有安全的替代手段：什么都不做，error 可直接展示 */
  | { kind: "reject"; error: string };

/**
 * 「打开文件」的执行计划（纯函数、可单测）。
 * - 普通文件 / 目录：macOS `open`、Windows `rundll32 FileProtocolHandler`、Linux `xdg-open`
 * - 可执行 / 脚本 / 快捷方式等危险扩展名（大小写不敏感、处理尾部空格 / 点 / `::$DATA`）：
 *   降级为 buildRevealInFolderSpec，不执行
 * - Windows UNC / 设备路径、含双引号的路径（会破坏 explorer 的 /select,"..." 单 argv）：拒绝
 */
export const buildOpenPathPlan = (
  absPath: string,
  platform: NodeJS.Platform,
): OpenPathPlan => {
  if (platform === "win32") {
    if (isWindowsUncPath(absPath)) {
      return {
        kind: "reject",
        error: "出于安全考虑，不支持打开网络共享（UNC）路径",
      };
    }
    if (absPath.includes('"')) {
      return { kind: "reject", error: "路径含非法字符（双引号）" };
    }
  }

  const ext =
    platform === "win32" ? windowsEffectiveExt(absPath) : posixEffectiveExt(absPath);
  const dangerous =
    platform === "win32"
      ? WIN_EXECUTABLE_EXTS
      : platform === "darwin"
        ? MAC_EXECUTABLE_EXTS
        : LINUX_EXECUTABLE_EXTS;
  if ((ext && dangerous.has(ext)) || (platform === "darwin" && insideMacAppBundle(absPath))) {
    return {
      kind: "reveal",
      spec: buildRevealInFolderSpec(absPath, platform),
      notice: `出于安全考虑，不直接运行${ext ? ` .${ext} ` : "此"}文件，已改为在文件管理器中显示`,
    };
  }

  if (platform === "darwin") {
    return { kind: "open", spec: { command: "open", args: [absPath] } };
  }
  if (platform === "win32") {
    return { kind: "open", spec: winShellOpenSpec(toWindowsExplorerPath(absPath)) };
  }
  return { kind: "open", spec: { command: "xdg-open", args: [absPath] } };
};

/**
 * 用系统默认浏览器打开外链：按平台拼 spawn 参数（纯函数、可单测）。
 *
 * 只放行 http / https——其它协议（file: / javascript: / ms-msdt: / 自定义协议）一律返 null，
 * 调用方应当「不打开」。返回的 URL 用 `new URL().href` 规范化（空格 / 引号等会被 percent-encode），
 * 且保证以 `http(s)://` 开头、不会被 open / xdg-open 当成命令行 flag。
 * 所有平台都是「可执行文件 + argv」，不经任何 shell。
 */
export const buildOpenUrlSpec = (
  rawUrl: string,
  platform: NodeJS.Platform,
): OsSpawnSpec | null => {
  let href: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    href = u.href;
  } catch {
    return null;
  }
  if (platform === "darwin") return { command: "open", args: [href] };
  if (platform === "win32") return winShellOpenSpec(href);
  return { command: "xdg-open", args: [href] };
};
