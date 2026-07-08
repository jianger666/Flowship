/**
 * IDE 工具探测 + 后端拉起（V0.11.8、用户同事 Windows 实测痛点）
 *
 * 背景：`idea://` 协议在 Windows 上由 JetBrains Toolbox 注册——直接装 IDEA（不装 Toolbox）
 * 的机器根本没有这个协议处理器、点跳转弹「找不到应用」。协议这条路对 JetBrains 系不可靠。
 *
 * 方案：本地 app 不需要经过浏览器协议——server 直接探测各 IDE 的安装位置、
 * 点跳转时后端 spawn 可执行文件（带文件路径 + 行号）、协议没注册也能开：
 * - cursor / vscode：协议（cursor:// / vscode://）由安装器可靠注册、仍走 deep link（前端直开）、
 *   这里只负责「探测到没有」给设置页下拉列表用
 * - idea / webstorm：探测安装位置、跳转走 POST /api/system/open-in-ide → spawn
 *
 * 探测顺序（每平台）：常规安装目录 → JetBrains Toolbox 目录 → PATH。
 * 结果缓存 60s（设置页开一次探一轮、别每次点链接都扫盘）。
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JumpIde } from "@/lib/types";

const execFileAsync = promisify(execFile);

export interface IdeToolInfo {
  id: JumpIde;
  /** 展示名（跟 JUMP_IDE_LABEL 一致、server 独立返回省得客户端拼） */
  name: string;
  available: boolean;
}

// 探测到的可执行文件路径（open 时用）；cursor/vscode 走协议、不需要 exec
interface DetectResult {
  available: boolean;
  exec?: string;
  /** exec 是 .cmd/.bat（Toolbox 脚本）、Windows 上必须经 cmd /c 拉起 */
  isCmdScript?: boolean;
  /** mac：exec 是 .app 包路径、用 `open -na <app> --args` 拉起 */
  isMacApp?: boolean;
}

const IDE_NAMES: Record<JumpIde, string> = {
  cursor: "Cursor",
  vscode: "VS Code",
  idea: "IDEA",
  webstorm: "WebStorm",
};

// ---------- 平台探测 ----------

// mac：/Applications + ~/Applications 找 .app（JetBrains Toolbox 默认装 ~/Applications）
const findMacApp = (appNames: string[]): DetectResult => {
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  for (const root of roots) {
    for (const name of appNames) {
      const p = path.join(root, `${name}.app`);
      if (existsSync(p)) return { available: true, exec: p, isMacApp: true };
    }
  }
  return { available: false };
};

// win：目录扫描（JetBrains 装目录带版本号、前缀匹配）
const findWinExeInDirs = (
  parents: string[],
  dirPrefix: string,
  relExe: string,
): string | null => {
  for (const parent of parents) {
    if (!parent || !existsSync(parent)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    // 多版本并存时取字典序最大（一般是最新版本）
    const hits = entries
      .filter((e) => e.toLowerCase().startsWith(dirPrefix.toLowerCase()))
      .sort()
      .reverse();
    for (const hit of hits) {
      const p = path.join(parent, hit, relExe);
      if (existsSync(p)) return p;
    }
  }
  return null;
};

// PATH 探测（where / which）
const findOnPath = async (bins: string[]): Promise<string | null> => {
  const probe = process.platform === "win32" ? "where" : "which";
  for (const bin of bins) {
    try {
      const { stdout } = await execFileAsync(probe, [bin], { timeout: 5_000 });
      const first = stdout.split(/\r?\n/).find((l) => l.trim());
      if (first) return first.trim();
    } catch {
      // 不在 PATH、试下一个
    }
  }
  return null;
};

// JetBrains 系（idea / webstorm）探测
const detectJetBrains = async (
  dirPrefix: string, // "IntelliJ IDEA" / "WebStorm"
  macApps: string[],
  winExe: string, // "idea64.exe" / "webstorm64.exe"
  pathBins: string[], // ["idea"] / ["webstorm"]
  toolboxScript: string, // "idea" / "webstorm"
): Promise<DetectResult> => {
  if (process.platform === "darwin") {
    const app = findMacApp(macApps);
    if (app.available) return app;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const exe = findWinExeInDirs(
      [
        // Toolbox 新式安装位（2023+ 默认）：%LOCALAPPDATA%\Programs\IntelliJ IDEA Ultimate\bin\
        local ? path.join(local, "Programs") : "",
        // 直接安装器默认位：C:\Program Files\JetBrains\IntelliJ IDEA 2024.x\bin\
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", "JetBrains"),
      ],
      dirPrefix,
      path.join("bin", winExe),
    );
    if (exe) return { available: true, exec: exe };
    // Toolbox 旧式 shell scripts：%LOCALAPPDATA%\JetBrains\Toolbox\scripts\idea.cmd
    if (local) {
      const script = path.join(
        local,
        "JetBrains",
        "Toolbox",
        "scripts",
        `${toolboxScript}.cmd`,
      );
      if (existsSync(script)) {
        return { available: true, exec: script, isCmdScript: true };
      }
    }
  }
  const onPath = await findOnPath(pathBins);
  if (onPath) {
    return {
      available: true,
      exec: onPath,
      isCmdScript: /\.(cmd|bat)$/i.test(onPath),
    };
  }
  return { available: false };
};

// VS Code 系（cursor / vscode）探测——只探「装没装」（跳转走协议、不需要 exec）
const detectVsCodeFamily = async (
  macApps: string[],
  winProgramDirs: string[], // %LOCALAPPDATA%\Programs 下的目录名
  winExe: string,
  pathBins: string[],
): Promise<DetectResult> => {
  if (process.platform === "darwin") {
    const app = findMacApp(macApps);
    if (app.available) return app;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    for (const dir of winProgramDirs) {
      const candidates = [
        local ? path.join(local, "Programs", dir, winExe) : "",
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", dir, winExe),
      ].filter(Boolean);
      for (const p of candidates) {
        if (existsSync(p)) return { available: true, exec: p };
      }
    }
  }
  const onPath = await findOnPath(pathBins);
  if (onPath) return { available: true, exec: onPath };
  return { available: false };
};

// ---------- 探测入口（缓存 60s） ----------

let cache: { at: number; results: Record<JumpIde, DetectResult> } | null = null;
const CACHE_TTL_MS = 60_000;

const detectAll = async (): Promise<Record<JumpIde, DetectResult>> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.results;
  const [cursor, vscode, idea, webstorm] = await Promise.all([
    detectVsCodeFamily(["Cursor"], ["cursor"], "Cursor.exe", ["cursor"]),
    detectVsCodeFamily(
      ["Visual Studio Code"],
      ["Microsoft VS Code"],
      "Code.exe",
      ["code"],
    ),
    detectJetBrains(
      "IntelliJ IDEA",
      ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"],
      "idea64.exe",
      ["idea"],
      "idea",
    ),
    detectJetBrains("WebStorm", ["WebStorm"], "webstorm64.exe", ["webstorm"], "webstorm"),
  ]);
  const results: Record<JumpIde, DetectResult> = { cursor, vscode, idea, webstorm };
  cache = { at: Date.now(), results };
  return results;
};

/** 探测所有支持的 IDE、返回可用性列表（设置页下拉用） */
export const listIdeTools = async (): Promise<IdeToolInfo[]> => {
  const results = await detectAll();
  return (Object.keys(IDE_NAMES) as JumpIde[]).map((id) => ({
    id,
    name: IDE_NAMES[id],
    available: results[id].available,
  }));
};

// ---------- 拉起 ----------

/**
 * 用指定 IDE 打开文件 / 目录（带可选行号）。
 * 协议不可靠的工具（JetBrains 系）走这里；cursor / vscode 前端直接 deep link 不进来。
 * @returns null = 成功；string = 给用户看的失败原因
 */
export const openInIde = async (
  ide: JumpIde,
  absPath: string,
  line?: number,
): Promise<string | null> => {
  const results = await detectAll();
  const tool = results[ide];
  if (!tool.available || !tool.exec) {
    return `本机没探测到 ${IDE_NAMES[ide]}——确认已安装、或去设置页换一个跳转工具`;
  }

  // 参数拼法：JetBrains `--line N <path>`；VS Code 系 `-g <path>:N`
  const isVsCodeFamily = ide === "cursor" || ide === "vscode";
  const args: string[] = [];
  if (isVsCodeFamily) {
    args.push("-g", line ? `${absPath}:${line}` : absPath);
  } else {
    if (line) args.push("--line", String(line));
    args.push(absPath);
  }

  try {
    if (tool.isMacApp) {
      // mac：open -na <App>.app --args <IDE 参数>（open 立即返回、IDE 自己接管）
      await execFileAsync("open", ["-na", tool.exec, "--args", ...args], {
        timeout: 15_000,
      });
      return null;
    }
    // Windows / Linux：直接 spawn 可执行文件、detach 不等它退（GUI 进程）
    // Toolbox 的 .cmd 脚本必须经 cmd /c（Windows 不能直接 exec 批处理）
    const [cmd, cmdArgs] = tool.isCmdScript
      ? ["cmd.exe", ["/d", "/s", "/c", tool.exec, ...args]]
      : [tool.exec, args];
    const child = spawn(cmd, cmdArgs as string[], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return null;
  } catch (err) {
    return `拉起 ${IDE_NAMES[ide]} 失败：${err instanceof Error ? err.message : String(err)}`;
  }
};
