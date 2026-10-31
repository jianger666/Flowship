/**
 * 在文件夹中显示 / 用系统默认应用打开：按平台拼 spawn 参数（纯函数、可单测）
 *
 * server route 与 vitest 共用，避免 macOS / Windows 分支在 API 里复制粘贴。
 */

import path from "node:path";

import { isUncLikePath } from "./unc-path";

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
 * 注意：这是黑名单，只能挡住已知危险类型；macOS 上无扩展名的 Unix 可执行文件、
 * 名字无害的符号链接，纯函数只看路径字符串认不出来——要读盘才知道，
 * 由 route 先取 {@link OpenPathFacts} 再传给 buildOpenPathPlan（Q14-01）。
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
 * 判定复用 `unc-path.ts` 的单一实现（R12-05）；那边是平台无关的，这里保留旧名给 open / reveal 的调用方。
 */
export const isWindowsUncPath = (absPath: string): boolean => isUncLikePath(absPath);

export type OpenPathPlan =
  | { kind: "open"; spec: OsSpawnSpec }
  /** 危险文件类型：不执行，只在文件管理器中选中 */
  | { kind: "reveal"; spec: OsSpawnSpec; notice: string }
  /** 没有安全的替代手段：什么都不做，error 可直接展示 */
  | { kind: "reject"; error: string };

/**
 * 服务端读盘得到的、纯函数光看路径字符串认不出来的事实（Q14-01）。
 *
 * 只有扩展名黑名单时有两个洞：① 无扩展名（或扩展名无害）但带可执行位的文件——macOS 的 `open` 会在终端里运行它，
 * Linux 的 `xdg-open` 也可能直接执行；② 名字无害的符号链接（`notes.txt → Foo.app`、`readme → /bin/ls`）：
 * 黑名单只看链接自己的名字，系统打开时却会顺着链接走到目标。
 * route 在调用 {@link buildOpenPathPlan} 之前读一次盘（见 `server/open-path-facts.ts`），把结果传进来；
 * 不传（没读到 / Windows）就是原来的纯路径判断，行为不变。
 */
export interface OpenPathFacts {
  /** 解开所有符号链接后的真实路径（fs.realpath）。省略 / 与原路径相同 = 没有符号链接要处理 */
  realPath?: string;
  /** 真实路径是「带可执行位（owner / group / other 任一）的普通文件」；目录不算。win32 没有可执行位，忽略 */
  executableFile?: boolean;
}

/**
 * 「打开文件」的执行计划（纯函数、可单测）。
 * - 普通文件 / 目录：macOS `open`、Windows `rundll32 FileProtocolHandler`、Linux `xdg-open`
 * - 可执行 / 脚本 / 快捷方式等危险扩展名（大小写不敏感、处理尾部空格 / 点 / `::$DATA`）：
 *   降级为 buildRevealInFolderSpec，不执行
 * - Windows UNC / 设备路径、含双引号的路径（会破坏 explorer 的 /select,"..." 单 argv）：拒绝
 * - `facts`（Q14-01，可选）：给了真实路径就把它和原路径**都**过一遍上面的判断，之后交给系统的也是真实路径
 *   （不再经符号链接，缩小「检查之后、打开之前」链接被换掉的窗口）；`executableFile` 为真（macOS / Linux）同样降级为在文件管理器中显示
 */
export const buildOpenPathPlan = (
  absPath: string,
  platform: NodeJS.Platform,
  facts?: OpenPathFacts,
): OpenPathPlan => {
  const real = facts?.realPath && facts.realPath !== absPath ? facts.realPath : undefined;
  /** 要判断的路径：原路径；有真实路径时再加上它 */
  const candidates = real ? [absPath, real] : [absPath];
  /** 真正交给系统的路径 */
  const target = real ?? absPath;

  if (platform === "win32") {
    for (const c of candidates) {
      if (isWindowsUncPath(c)) {
        return {
          kind: "reject",
          error: "出于安全考虑，不支持打开网络共享（UNC）路径",
        };
      }
      if (c.includes('"')) {
        return { kind: "reject", error: "路径含非法字符（双引号）" };
      }
    }
  }

  const dangerous =
    platform === "win32"
      ? WIN_EXECUTABLE_EXTS
      : platform === "darwin"
        ? MAC_EXECUTABLE_EXTS
        : LINUX_EXECUTABLE_EXTS;
  for (const c of candidates) {
    const ext = platform === "win32" ? windowsEffectiveExt(c) : posixEffectiveExt(c);
    if ((ext && dangerous.has(ext)) || (platform === "darwin" && insideMacAppBundle(c))) {
      return {
        kind: "reveal",
        spec: buildRevealInFolderSpec(target, platform),
        notice: `出于安全考虑，不直接运行${ext ? ` .${ext} ` : "此"}文件，已改为在文件管理器中显示`,
      };
    }
  }
  if (platform !== "win32" && facts?.executableFile === true) {
    return {
      kind: "reveal",
      spec: buildRevealInFolderSpec(target, platform),
      notice: "出于安全考虑，不直接打开带可执行权限的文件，已改为在文件管理器中显示",
    };
  }

  if (platform === "darwin") {
    return { kind: "open", spec: { command: "open", args: [target] } };
  }
  if (platform === "win32") {
    return { kind: "open", spec: winShellOpenSpec(toWindowsExplorerPath(target)) };
  }
  return { kind: "open", spec: { command: "xdg-open", args: [target] } };
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
