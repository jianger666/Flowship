/**
 * Windows Agent shell：把 process.env.SHELL 指到 Git Bash，绕开 SDK PowerShell 执行器
 *
 * 背景：Cursor SDK 在 Windows 上默认走 PowerShell，有官方已认的「命令结束检测失败→挂死 /
 * 输出为空」bug。SDK 选壳逻辑优先读 process.env.SHELL，若指向 Git Bash 的 bash.exe
 *（路径匹配 /git.*bash\.exe$/i）就改走 Bash 执行器。本模块探测 git-bash 路径并按设置项
 * 写入 SHELL；Agent.create 是本进程子进程，会继承。
 *
 * ⚠️ SDK 选壳器与 Bash 执行器是两套逻辑（v1.1.18 线上事故）：选壳器读 SHELL，但 win32
 * 下 Bash 执行器只靠 userTerminalHint / PATH 里 `where bash` 找 `/git.*bash/i`——装 Git
 * 默认只把 `Git\cmd` 加进 PATH（无 bash.exe），只写 SHELL 会选中 Bash 执行器却抛
 * `Can't find Bash`，工具调用永不结束。因此开关打开时必须同时把 `Git\bin` 前置进 PATH。
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

/**
 * 本模块注入进 PATH 的 Git Bash bin 目录。
 * null = 当前没有由我们注入（关开关时只清这个标记对应的段，不误删用户原有 PATH）。
 */
let injectedBinDir: string | null = null;

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

export type DetectGitBashOptions = {
  /**
   * 强制旁路缓存重探。设置开关打开时用——负缓存（path: null）会挡住
   * 「刚装完 Git 立刻开开关」的场景（审查修复）。
   */
  bypassCache?: boolean;
};

/**
 * 探测本机 Git Bash（bash.exe）路径。
 * 仅 win32 有动作；结果缓存 60s（含失败负缓存）。按 注册表 → where → 常规路径 顺序命中即返。
 */
export const detectGitBashPath = async (
  options: DetectGitBashOptions = {},
): Promise<string | null> => {
  if (process.platform !== "win32") return null;

  const now = Date.now();
  if (
    !options.bypassCache &&
    detectCache &&
    now - detectCache.at < DETECT_CACHE_TTL_MS
  ) {
    return detectCache.path;
  }

  let found: string | null = null;
  found = await detectViaRegistry();
  if (!found) found = await detectViaWhere();
  if (!found) found = await detectViaWellKnownPaths();

  detectCache = { at: now, path: found };
  return found;
};

/** 恢复模块加载时快照的 SHELL（原本没有就删掉，避免残留空串） */
const restoreOriginalShell = (): void => {
  if (ORIGINAL_SHELL === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = ORIGINAL_SHELL;
  }
};

/**
 * PATH 分隔符固定用 win32 的 `;`。
 * 本模块只服务 Windows Agent shell；若跟宿主 path.delimiter 走，mac 单测会把
 * `C:\...` 盘符里的冒号拆碎（v1.1.18 修复单测踩过）。
 */
const WIN_PATH_DELIM = path.win32.delimiter;

/**
 * 把 Git Bash 的 bin 目录前置进 PATH（幂等）。
 * 仅当本次真正新加时记下 injectedBinDir——用户 PATH 里本来就有同目录时不标记，
 * 关开关才不会误删用户原有段。参考 feishu-cli 的 injectFeishuCliPath。
 */
export const injectGitBashBinToPath = (binDir: string): void => {
  const cur = process.env.PATH ?? "";
  const parts = cur.split(WIN_PATH_DELIM);
  if (parts.includes(binDir)) return;
  process.env.PATH = `${binDir}${WIN_PATH_DELIM}${cur}`;
  injectedBinDir = binDir;
};

/**
 * 仅移除本模块注入的 bin 段（按 injectedBinDir 精确过滤）。
 * injectedBinDir 为 null 时 noop——不碰 PATH 其它段。
 */
export const removeInjectedGitBashBinFromPath = (): void => {
  if (injectedBinDir === null) return;
  const dir = injectedBinDir;
  const cur = process.env.PATH ?? "";
  process.env.PATH = cur
    .split(WIN_PATH_DELIM)
    .filter((p) => p !== dir)
    .join(WIN_PATH_DELIM);
  injectedBinDir = null;
};

/**
 * 最小自检：真能拉起 bash 才算成功，防「SHELL/PATH 写了但执行器仍挂」的假成功。
 * 失败不抛——调用方回滚后继续用 PowerShell。
 */
export const verifyGitBashRunnable = async (
  gitBash: string,
): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      gitBash,
      ["-c", "echo __shell_ok__"],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
    return String(stdout).includes("__shell_ok__");
  } catch (err) {
    console.warn(
      "[agent-shell] Git Bash 自检失败:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};

/** 自检实现可替换（单测 mock，避免真拉子进程） */
let verifyGitBashImpl: typeof verifyGitBashRunnable = verifyGitBashRunnable;

/**
 * 按开关状态同步 SHELL + PATH（幂等、可单测）。
 * enabled 且有 bash 路径 → 前置 bin 到 PATH + 写 SHELL + 自检；自检失败回滚。
 * 否则恢复 SHELL 并卸掉我们注入的 PATH 段。
 */
export const syncAgentShellEnv = async (
  enabled: boolean,
  gitBash: string | null,
): Promise<void> => {
  if (enabled && gitBash) {
    // win32 语义取 dirname——单测在 mac 上跑时 path.dirname 会把整段当文件名
    const binDir = path.win32.dirname(gitBash);

    // 换了一套 Git 安装路径时，先卸掉旧注入再注新的
    if (injectedBinDir !== null && injectedBinDir !== binDir) {
      removeInjectedGitBashBinFromPath();
    }
    injectGitBashBinToPath(binDir);
    process.env.SHELL = gitBash;

    const ok = await verifyGitBashImpl(gitBash);
    if (!ok) {
      console.warn(
        "[agent-shell] Git Bash 自检未通过，回滚 SHELL+PATH（退回 PowerShell）",
      );
      restoreOriginalShell();
      removeInjectedGitBashBinFromPath();
      return;
    }

    console.log(`[agent-shell] SHELL → Git Bash: ${gitBash}`);
    return;
  }

  if (enabled && !gitBash) {
    console.warn(
      "[agent-shell] 已开启「用 Git Bash」但未探测到 bash.exe，恢复原始 SHELL",
    );
  }

  restoreOriginalShell();
  removeInjectedGitBashBinFromPath();
};

/**
 * 按设置项应用 / 恢复 process.env.SHELL + PATH（幂等、可反复调用）。
 * 仅 win32：agentShellGitBash === true 且探测到路径 → 写入；否则恢复启动时快照。
 */
export const applyAgentShellPreference = async (): Promise<void> => {
  if (process.platform !== "win32") return;

  const result = await readSettingsFile();
  const enabled =
    result.status === "ok" && result.settings.agentShellGitBash === true;

  if (enabled) {
    // 设置开关路径强制重探，避免吃到「未安装时」留下的 60s 负缓存
    const gitBash = await detectGitBashPath({ bypassCache: true });
    await syncAgentShellEnv(true, gitBash);
    return;
  }

  await syncAgentShellEnv(false, null);
};

/** 测试用：清探测缓存（不导出给业务） */
export const __resetDetectCacheForTests = (): void => {
  detectCache = null;
};

/** 测试用：写入探测缓存（模拟负缓存 / 命中） */
export const __setDetectCacheForTests = (path: string | null): void => {
  detectCache = { at: Date.now(), path };
};

/** 测试用：读当前注入标记 */
export const __getInjectedBinDirForTests = (): string | null => injectedBinDir;

/** 测试用：只清注入标记（PATH 由用例 afterEach 自己还原） */
export const __resetInjectedBinDirForTests = (): void => {
  injectedBinDir = null;
};

/** 测试用：替换 / 恢复自检实现 */
export const __setVerifyGitBashForTests = (
  fn: typeof verifyGitBashRunnable | null,
): void => {
  verifyGitBashImpl = fn ?? verifyGitBashRunnable;
};
