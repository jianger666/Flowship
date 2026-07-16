/**
 * Windows Agent shell：把 process.env.SHELL 指到 Git Bash，绕开 SDK PowerShell 执行器
 *
 * 背景：Cursor SDK 在 Windows 上默认走 PowerShell，有官方已认的「命令结束检测失败→挂死 /
 * 输出为空」bug。SDK 选壳逻辑优先读 process.env.SHELL，若指向 Git Bash 的 bash.exe
 *（路径匹配 /git.*bash\.exe$/i）就改走 Bash 执行器。本模块探测 git-bash 路径并按设置项
 * 写入 SHELL；Agent.create 是本进程子进程，会继承。
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { readSettingsFile } from "@/lib/server/settings-fs";

const execFileAsync = promisify(execFile);

/** 子进程探测超时——reg / where 挂起时别拖死启动 / 设置保存 */
const EXEC_TIMEOUT_MS = 5_000;

/** 探测结果缓存 TTL（设置页开一次探一轮、别每次开关都扫盘） */
const DETECT_CACHE_TTL_MS = 60_000;

/** 模块加载时记下原始 SHELL——关闭开关时恢复，原本没有就 delete */
const ORIGINAL_SHELL: string | undefined = process.env.SHELL;

type DetectCache = { at: number; path: string | null };

let detectCache: DetectCache | null = null;

/**
 * 从 git.exe 位置推导同安装根下的 bash.exe（可单测纯函数）。
 * 覆盖 Git for Windows 三种常见布局；不认识的路径返 null。
 */
export const deriveBashFromGitExe = (gitExePath: string): string | null => {
  const trimmed = gitExePath.trim();
  if (!trimmed) return null;
  // 统一用 win32 语义拼路径——单测可能在 mac 上跑、不能跟当前平台 path 走
  const normalized = path.win32.normalize(trimmed.replace(/\//g, "\\"));
  const baseName = path.win32.basename(normalized).toLowerCase();
  if (baseName !== "git.exe" && baseName !== "git") return null;

  const dir = path.win32.dirname(normalized);
  const dirBase = path.win32.basename(dir).toLowerCase();

  // <root>\cmd\git.exe → <root>\bin\bash.exe
  if (dirBase === "cmd") {
    return path.win32.join(path.win32.dirname(dir), "bin", "bash.exe");
  }

  if (dirBase === "bin") {
    const parent = path.win32.dirname(dir);
    const parentBase = path.win32.basename(parent).toLowerCase();
    // <root>\mingw64\bin\git.exe（或 mingw32）→ <root>\bin\bash.exe
    if (parentBase === "mingw64" || parentBase === "mingw32") {
      return path.win32.join(path.win32.dirname(parent), "bin", "bash.exe");
    }
    // <root>\bin\git.exe → <root>\bin\bash.exe
    return path.win32.join(dir, "bash.exe");
  }

  return null;
};

/** fs.access 验证文件存在且可读；失败返 null */
const accessOrNull = async (absPath: string): Promise<string | null> => {
  try {
    await fs.access(absPath);
    return absPath;
  } catch {
    return null;
  }
};

/** 解析 `reg query ... /v InstallPath` 的 REG_SZ 值 */
const parseRegInstallPath = (stdout: string): string | null => {
  const m = stdout.match(/InstallPath\s+REG_\w+\s+(.+)/i);
  const value = m?.[1]?.trim();
  return value || null;
};

/** 注册表 GitForWindows InstallPath → bin\bash.exe */
const detectViaRegistry = async (): Promise<string | null> => {
  const hives = [
    "HKLM\\SOFTWARE\\GitForWindows",
    "HKCU\\SOFTWARE\\GitForWindows",
  ];
  for (const hive of hives) {
    try {
      const { stdout } = await execFileAsync(
        "reg",
        ["query", hive, "/v", "InstallPath"],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
      const installPath = parseRegInstallPath(stdout);
      if (!installPath) continue;
      const bash = path.win32.join(installPath, "bin", "bash.exe");
      const hit = await accessOrNull(bash);
      if (hit) return hit;
    } catch {
      // 该 hive 无键 / 超时 / reg 失败 → 试下一层
    }
  }
  return null;
};

/** `where git.exe` 第一条 → deriveBashFromGitExe → access */
const detectViaWhere = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("where", ["git.exe"], {
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) return null;
    const bash = deriveBashFromGitExe(first);
    if (!bash) return null;
    return accessOrNull(bash);
  } catch {
    return null;
  }
};

/** 常规安装路径兜底（含用户级 LocalAppData） */
const detectViaWellKnownPaths = async (): Promise<string | null> => {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    path.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const candidate of candidates) {
    const hit = await accessOrNull(candidate);
    if (hit) return hit;
  }
  return null;
};

/**
 * 探测本机 Git Bash（bash.exe）路径。
 * 仅 win32 有动作；结果缓存 60s。按 注册表 → where → 常规路径 顺序命中即返。
 */
export const detectGitBashPath = async (): Promise<string | null> => {
  if (process.platform !== "win32") return null;

  const now = Date.now();
  if (detectCache && now - detectCache.at < DETECT_CACHE_TTL_MS) {
    return detectCache.path;
  }

  let found: string | null = null;
  found = await detectViaRegistry();
  if (!found) found = await detectViaWhere();
  if (!found) found = await detectViaWellKnownPaths();

  detectCache = { at: now, path: found };
  return found;
};

/**
 * 按设置项应用 / 恢复 process.env.SHELL（幂等、可反复调用）。
 * 仅 win32：agentShellGitBash === true 且探测到路径 → 写入 SHELL；否则恢复启动时快照。
 */
export const applyAgentShellPreference = async (): Promise<void> => {
  if (process.platform !== "win32") return;

  const result = await readSettingsFile();
  const enabled =
    result.status === "ok" && result.settings.agentShellGitBash === true;

  if (enabled) {
    const gitBash = await detectGitBashPath();
    if (gitBash) {
      process.env.SHELL = gitBash;
      console.log(`[agent-shell] SHELL → Git Bash: ${gitBash}`);
      return;
    }
    console.warn(
      "[agent-shell] 已开启「用 Git Bash」但未探测到 bash.exe，恢复原始 SHELL",
    );
  }

  // 关闭 / 探测失败：恢复模块加载时的原始值（原本没有就删掉，避免残留空串）
  if (ORIGINAL_SHELL === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = ORIGINAL_SHELL;
  }
};

/** 测试用：清探测缓存（不导出给业务） */
export const __resetDetectCacheForTests = (): void => {
  detectCache = null;
};
