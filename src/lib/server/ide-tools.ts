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
  windsurf: "Windsurf",
  trae: "Trae",
  idea: "IDEA",
  webstorm: "WebStorm",
  pycharm: "PyCharm",
  goland: "GoLand",
  phpstorm: "PhpStorm",
  "android-studio": "Android Studio",
};

/**
 * 每个 IDE 的探测配置（V0.11.10 改配置驱动、从写死四个扩到 10 个）：
 * - family=vscode：VS Code 系（Cursor / VS Code / Windsurf / Trae）——win 装在
 *   `%LOCALAPPDATA%\Programs\<dir>` 或 Program Files、打开参数 `-g path:line`
 * - family=jetbrains：IntelliJ 平台系——win 装目录带版本号前缀匹配、支持 Toolbox
 *   两代安装位、打开参数 `--line N path`
 */
interface IdeSpec {
  family: "vscode" | "jetbrains";
  /** mac /Applications 下的 .app 名候选（不带 .app 后缀） */
  macApps: string[];
  /** PATH 上的命令名候选 */
  pathBins: string[];
  /** vscode 系：win 安装目录名候选（Programs / Program Files 下） */
  winProgramDirs?: string[];
  /** vscode 系：win 可执行文件名 */
  winExe?: string;
  /** jetbrains 系：win 安装目录前缀（带版本号、前缀匹配） */
  winDirPrefix?: string;
  /** jetbrains 系：bin/ 下的可执行文件名 */
  winExeName?: string;
  /** jetbrains 系：Toolbox scripts 目录里的脚本名 */
  toolboxScript?: string;
  /** jetbrains 系：win 额外的安装父目录（默认只扫 Programs + Program Files\JetBrains） */
  winExtraParents?: string[];
}

const IDE_SPECS: Record<JumpIde, IdeSpec> = {
  cursor: {
    family: "vscode",
    macApps: ["Cursor"],
    pathBins: ["cursor"],
    winProgramDirs: ["cursor"],
    winExe: "Cursor.exe",
  },
  vscode: {
    family: "vscode",
    macApps: ["Visual Studio Code"],
    pathBins: ["code"],
    winProgramDirs: ["Microsoft VS Code"],
    winExe: "Code.exe",
  },
  windsurf: {
    family: "vscode",
    macApps: ["Windsurf"],
    pathBins: ["windsurf"],
    winProgramDirs: ["Windsurf"],
    winExe: "Windsurf.exe",
  },
  trae: {
    family: "vscode",
    macApps: ["Trae"],
    pathBins: ["trae"],
    winProgramDirs: ["Trae"],
    winExe: "Trae.exe",
  },
  idea: {
    family: "jetbrains",
    macApps: [
      "IntelliJ IDEA",
      "IntelliJ IDEA Ultimate",
      "IntelliJ IDEA CE",
      "IntelliJ IDEA Community Edition",
    ],
    pathBins: ["idea"],
    winDirPrefix: "IntelliJ IDEA",
    winExeName: "idea64.exe",
    toolboxScript: "idea",
  },
  webstorm: {
    family: "jetbrains",
    macApps: ["WebStorm"],
    pathBins: ["webstorm"],
    winDirPrefix: "WebStorm",
    winExeName: "webstorm64.exe",
    toolboxScript: "webstorm",
  },
  pycharm: {
    family: "jetbrains",
    macApps: [
      "PyCharm",
      "PyCharm Professional",
      "PyCharm Community Edition",
      "PyCharm CE",
    ],
    pathBins: ["pycharm"],
    winDirPrefix: "PyCharm",
    winExeName: "pycharm64.exe",
    toolboxScript: "pycharm",
  },
  goland: {
    family: "jetbrains",
    macApps: ["GoLand"],
    pathBins: ["goland"],
    winDirPrefix: "GoLand",
    winExeName: "goland64.exe",
    toolboxScript: "goland",
  },
  phpstorm: {
    family: "jetbrains",
    macApps: ["PhpStorm"],
    pathBins: ["phpstorm"],
    winDirPrefix: "PhpStorm",
    winExeName: "phpstorm64.exe",
    toolboxScript: "phpstorm",
  },
  // Android Studio 是 IntelliJ 平台但 win 装在 Program Files\Android 下、exe 叫 studio64
  "android-studio": {
    family: "jetbrains",
    macApps: ["Android Studio"],
    pathBins: ["studio"],
    winDirPrefix: "Android Studio",
    winExeName: "studio64.exe",
    toolboxScript: "studio",
    winExtraParents: [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Android"),
    ],
  },
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

// 按 spec 探测单个 IDE（family 决定 win 侧扫哪些目录、mac / PATH 两层通用）
const detectOne = async (spec: IdeSpec): Promise<DetectResult> => {
  if (process.platform === "darwin") {
    const app = findMacApp(spec.macApps);
    if (app.available) return app;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    if (spec.family === "vscode") {
      for (const dir of spec.winProgramDirs ?? []) {
        const candidates = [
          local ? path.join(local, "Programs", dir, spec.winExe!) : "",
          path.join(programFiles, dir, spec.winExe!),
        ].filter(Boolean);
        for (const p of candidates) {
          if (existsSync(p)) return { available: true, exec: p };
        }
      }
    } else {
      const exe = findWinExeInDirs(
        [
          // Toolbox 新式安装位（2023+ 默认）：%LOCALAPPDATA%\Programs\IntelliJ IDEA Ultimate\bin\
          local ? path.join(local, "Programs") : "",
          // 直接安装器默认位：C:\Program Files\JetBrains\IntelliJ IDEA 2024.x\bin\
          path.join(programFiles, "JetBrains"),
          ...(spec.winExtraParents ?? []),
        ],
        spec.winDirPrefix!,
        path.join("bin", spec.winExeName!),
      );
      if (exe) return { available: true, exec: exe };
      // Toolbox 旧式 shell scripts：%LOCALAPPDATA%\JetBrains\Toolbox\scripts\idea.cmd
      if (local && spec.toolboxScript) {
        const script = path.join(
          local,
          "JetBrains",
          "Toolbox",
          "scripts",
          `${spec.toolboxScript}.cmd`,
        );
        if (existsSync(script)) {
          return { available: true, exec: script, isCmdScript: true };
        }
      }
    }
  }
  const onPath = await findOnPath(spec.pathBins);
  if (onPath) {
    return {
      available: true,
      exec: onPath,
      isCmdScript: /\.(cmd|bat)$/i.test(onPath),
    };
  }
  return { available: false };
};

// ---------- 探测入口（缓存 60s） ----------

let cache: { at: number; results: Record<JumpIde, DetectResult> } | null = null;
const CACHE_TTL_MS = 60_000;

const detectAll = async (): Promise<Record<JumpIde, DetectResult>> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.results;
  const ids = Object.keys(IDE_SPECS) as JumpIde[];
  const detected = await Promise.all(ids.map((id) => detectOne(IDE_SPECS[id])));
  const results = Object.fromEntries(
    ids.map((id, i) => [id, detected[i]]),
  ) as Record<JumpIde, DetectResult>;
  cache = { at: Date.now(), results };
  // 探测结果落日志（同事机器排查「点了没反应」全靠这行——exec 指到哪一眼看清）
  console.log(
    `[ide-tools] 探测：${(Object.keys(results) as JumpIde[])
      .map((k) => `${k}=${results[k].available ? results[k].exec : "无"}`)
      .join(" | ")}`,
  );
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

/** 带 exec 路径的探测明细（诊断包用、不进普通 API 响应） */
export const listIdeToolsDetailed = async (): Promise<
  Array<IdeToolInfo & { exec?: string }>
> => {
  const results = await detectAll();
  return (Object.keys(IDE_NAMES) as JumpIde[]).map((id) => ({
    id,
    name: IDE_NAMES[id],
    available: results[id].available,
    exec: results[id].exec,
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
  const isVsCodeFamily = IDE_SPECS[ide].family === "vscode";
  const args: string[] = [];
  if (isVsCodeFamily) {
    args.push("-g", line ? `${absPath}:${line}` : absPath);
  } else {
    if (line) args.push("--line", String(line));
    args.push(absPath);
  }

  console.log(
    `[ide-tools] open ide=${ide} exec=${tool.exec} cmdScript=${!!tool.isCmdScript} args=${JSON.stringify(args)}`,
  );

  try {
    if (tool.isMacApp) {
      // mac：open -na <App>.app --args <IDE 参数>（open 立即返回、IDE 自己接管）
      await execFileAsync("open", ["-na", tool.exec, "--args", ...args], {
        timeout: 15_000,
      });
      return null;
    }
    // Windows / Linux：直接 spawn 可执行文件。
    // Toolbox 的 .cmd 脚本必须经 cmd /c（Windows 不能直接 exec 批处理）
    const [cmd, cmdArgs] = tool.isCmdScript
      ? ["cmd.exe", ["/d", "/s", "/c", tool.exec, ...args]]
      : [tool.exec, args];
    const child = spawn(cmd, cmdArgs as string[], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // 静默失败探测（V0.11.9、同事 Windows 实测「点了没反应」）：spawn 本身成功但进程
    // 秒退（脚本路径带空格被 cmd 拆坏 / exe 损坏）时原实现直接当成功、用户零反馈。
    // 等 1.5s：spawn error / 非零码退出 → 报错给前端 toast；仍在跑 / 零码退出 → 视为已拉起。
    const failure = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null); // 1.5s 还活着 = IDE 正常启动中
      }, 1_500);
      const onError = (err: Error) => {
        cleanup();
        resolve(`拉起失败：${err.message}（exec=${tool.exec}）`);
      };
      const onExit = (code: number | null) => {
        cleanup();
        // GUI exe 常驻不会退；launcher / .cmd 正常退 0。非零码 = 启动失败
        resolve(
          code === 0 || code === null
            ? null
            : `启动进程立即退出（code=${code}、exec=${tool.exec}）——把 app 日志发我排查`,
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.once("error", onError);
      child.once("exit", onExit);
    });
    if (failure) {
      console.error(`[ide-tools] open 失败 ide=${ide}：${failure}`);
      return `拉起 ${IDE_NAMES[ide]} 失败：${failure}`;
    }
    child.unref();
    return null;
  } catch (err) {
    return `拉起 ${IDE_NAMES[ide]} 失败：${err instanceof Error ? err.message : String(err)}`;
  }
};
