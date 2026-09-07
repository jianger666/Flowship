/**
 * Windows 自定义安装目录静默更新保护（E 盘坑）。
 *
 * 背景：
 * - NSIS 静默更新是“先卸后装”：新安装器调老卸载器把 $INSTDIR 整个 RMDir，再写新文件。
 *   $INSTDIR 取值 = 注册表 InstallLocation → /D= 覆盖。
 * - NSIS 要求 /D= 必须是最后一个参数且不能带引号；Node spawn 在路径含空格时会自动包
 *   一层双引号，而 electron-builder 26.x 的 GetDParameter 只是粗暴截取 /D= 后面全部、
 *   不去引号 → $INSTDIR 变成 `"E:\Foo Bar\Flowship"` → 安装失败，而旧目录已被删。
 *   纯 `E:\Flowship` 无空格反而没事，`E:\Program Files\Flowship` 这类必挂。
 *
 * 策略（双保险）：
 * 1. 主进程侧：含空格时优先用 8.3 短路径（无空格、无需引号，spawn 不加引号、NSIS 直接认）。
 *    短路径拿不到（多见于禁用 8.3 的盘）则继续用长路径——新版 installer.nsh 已加去引号兜底。
 * 2. 安装器侧（packaging/installer.nsh customInit）：剥掉 $INSTDIR 首尾引号 + 尾部分隔符。
 *
 * 本文件是纯函数、无 electron 依赖，可被 vitest 直接单测。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

/** 剥首尾空白 + 首尾成对引号，去尾部分隔符（保留盘符根如 `E:\`）。 */
export const normalizeWinInstallDir = (dir) => {
  if (typeof dir !== "string") return dir;
  let d = dir.trim();
  if (d.length >= 2) {
    const first = d[0];
    const last = d[d.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      d = d.slice(1, -1).trim();
    }
  }
  // 去尾部 \ /（保留 `X:\` 这类根）
  while (d.length > 3 && /[\\/]$/.test(d)) d = d.slice(0, -1);
  return d;
};

/**
 * 取 8.3 短路径（无空格），失败返回 null（fail-open）。
 * @param {string} longPath
 * @param {(cmd:string,args:string[],opts:object)=>string|Buffer} [execFn] 可注入 mock，便于单测
 */
export const getWinShortPathSync = (longPath, execFn = execFileSync) => {
  if (typeof longPath !== "string" || longPath === "") return null;
  // 无空格/引号无需短路径——调用方直接用长路径即可（返回 null 表示“不需要”）
  if (!/[\s"']/.test(longPath)) return null;
  try {
    const out = execFn("cmd.exe", ["/c", `for %A in ("${longPath}") do @echo %~sA`], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    });
    const short = String(out ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!short) return null;
    // 短路径本身不应再含空格/引号，否则说明 8.3 被禁用或转换失败
    if (/[\s"']/.test(short)) return null;
    return short;
  } catch {
    return null;
  }
};

/**
 * 给 electron-updater 用的安装目录决议。
 * @param {string} [execPath] 默认 process.execPath
 * @param {string} [platform] 默认 process.platform（单测可注入 win32）
 * @param {(p:string)=>string|null} [shortPathFn] 默认 getWinShortPathSync（单测可注入）
 * @returns {{dir:string, raw:string, viaShort:boolean}}
 */
export const resolveWinInstallDirForUpdater = (
  execPath = process.execPath,
  platform = process.platform,
  shortPathFn = getWinShortPathSync,
) => {
  // Windows 路径必须按 win32 语义取 dirname——单测跑在 mac 上时 path.dirname 会把
  // `E:\Foo\Flowship.exe` 当成单个文件名返回 `.`，线上 Windows 则正常。用 win32 写死最稳。
  const rawDir = path.win32.dirname(String(execPath));
  const normalized = normalizeWinInstallDir(rawDir);
  // 非 Windows（单测/CI）直接返回归一化结果
  if (platform !== "win32") return { dir: normalized, raw: rawDir, viaShort: false };
  let short = null;
  try {
    short = shortPathFn(normalized);
  } catch {
    short = null;
  }
  if (short) return { dir: normalizeWinInstallDir(short), raw: rawDir, viaShort: true };
  return { dir: normalized, raw: rawDir, viaShort: false };
};
