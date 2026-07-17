/**
 * Cursor agent shell 提速守卫
 *
 * Cursor SDK 的 agent shell 每条命令走「快照恢复→执行→重新序列化 shell 状态」。
 * rc / Profile 里加载的重型工具函数表会让序列化滚雪球、越用越慢（官方论坛已确认的性能 bug）。
 *
 * 官方缓解：在 shell 配置**最顶部**加守卫，agent 跳过重型初始化。
 * - bash/zsh：COMPOSER_NO_INTERACTION=1（非交互）
 * - PowerShell：CURSOR_AGENT=1（SDK 注入到 agent shell 子进程的 env）
 *
 * 本模块提供探测 + 一键注入（设置页入口）。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 配置文件方言：决定守卫语法与幂等特征串 */
export type ShellBoostFileKind = "posix" | "powershell";

/** bash/zsh 守卫注释——说明来源与可删，用户看到就知道是谁写的 */
export const SHELL_BOOST_COMMENT =
  "# Cursor agent 非交互 shell 跳过重型初始化——缓解 SDK shell 状态序列化膨胀（Flowship 一键优化写入、可随时删）";

/** bash/zsh 守卫本体：agent 非交互 shell 直接 return，跳过后续 rc 重型加载 */
export const SHELL_BOOST_GUARD =
  '[[ "$COMPOSER_NO_INTERACTION" == "1" ]] && return';

/**
 * bash/zsh env 名（展示 / 测试辅助用）
 * ⚠️ 不能当「已注入」判定——rc 里注释、`export COMPOSER_NO_INTERACTION=0` 等提及会误判
 */
export const SHELL_BOOST_MARKER = "COMPOSER_NO_INTERACTION";

/** PowerShell Profile 守卫注释（可整段删除） */
export const PS_SHELL_BOOST_COMMENT =
  "# Flowship: Cursor agent shell 跳过重型 Profile 初始化（可整段删除）";

/**
 * PowerShell 守卫：SDK 给 agent shell 注入 CURSOR_AGENT=1，
 * 且启动时不带 -NoProfile——每条命令都会全量跑 Profile（conda/oh-my-posh 等），
 * 用此 env 在顶部提前 return。
 */
export const PS_SHELL_BOOST_GUARD =
  'if ($env:CURSOR_AGENT -eq "1") { return }';

/**
 * PowerShell env 名（展示 / 测试辅助用）
 * ⚠️ 同 SHELL_BOOST_MARKER：仅提及不算已注入，判定必须匹配守卫本体
 */
export const PS_SHELL_BOOST_MARKER = "CURSOR_AGENT";

/** 生成要顶插的两行（末尾带换行，方便直接拼接原文） */
export const buildShellBoostBlock = (
  kind: ShellBoostFileKind = "posix",
): string =>
  kind === "powershell"
    ? `${PS_SHELL_BOOST_COMMENT}\n${PS_SHELL_BOOST_GUARD}\n`
    : `${SHELL_BOOST_COMMENT}\n${SHELL_BOOST_GUARD}\n`;

/**
 * 内容是否已含守卫——匹配守卫本体（GUARD），不匹配裸 env 名。
 * 历史核查：GUARD 字符串自 v1.1.13 / PowerShell 自 v1.1.16 引入后未改过，无需兼容旧守卫行。
 */
export const hasShellBoost = (
  content: string,
  kind: ShellBoostFileKind = "posix",
): boolean =>
  content.includes(
    kind === "powershell" ? PS_SHELL_BOOST_GUARD : SHELL_BOOST_GUARD,
  );

/**
 * 纯函数：把守卫块插到内容最顶部。
 * 已含守卫则原样返回（幂等）；必须顶插，否则重型初始化已经跑完、守卫无效。
 */
export const injectShellBoostContent = (
  content: string,
  kind: ShellBoostFileKind = "posix",
): string => {
  if (hasShellBoost(content, kind)) return content;
  return buildShellBoostBlock(kind) + content;
};

export type ShellBoostTarget = {
  /** 绝对路径（fs 操作用） */
  absPath: string;
  /** 展示用 ~ 路径 */
  path: string;
  /** 方言：决定注入哪段守卫 */
  kind: ShellBoostFileKind;
};

/** win32 PowerShell Profile 相对 home 的路径片段（含 OneDrive 重定向变体） */
const WIN_PS_PROFILE_RELS: ReadonlyArray<readonly string[]> = [
  ["Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"],
  ["Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"],
  ["OneDrive", "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"],
  [
    "OneDrive",
    "Documents",
    "WindowsPowerShell",
    "Microsoft.PowerShell_profile.ps1",
  ],
];

/**
 * 按平台列出目标配置文件。不存在的文件由调用方跳过创建——
 * 没有配置说明没有重型加载，注入无意义。
 *
 * - darwin/linux：.zshrc / .bashrc / .bash_profile（login shell 可能不 source .bashrc）
 * - win32：Git Bash 的 .bashrc / .bash_profile + PowerShell 5.1/7+ Profile（含 OneDrive）
 */
export const listShellBoostTargets = (
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): ShellBoostTarget[] => {
  if (platform === "win32") {
    const posix = [".bashrc", ".bash_profile"].map((name) => ({
      absPath: path.join(home, name),
      path: `~/${name}`,
      kind: "posix" as const,
    }));
    const powershell = WIN_PS_PROFILE_RELS.map((parts) => ({
      absPath: path.join(home, ...parts),
      // 展示统一用 /，跟 ~/.bashrc 风格一致
      path: `~/${parts.join("/")}`,
      kind: "powershell" as const,
    }));
    return [...posix, ...powershell];
  }
  return [".zshrc", ".bashrc", ".bash_profile"].map((name) => ({
    absPath: path.join(home, name),
    path: `~/${name}`,
    kind: "posix" as const,
  }));
};

/** SDK agent shell 实际会用的壳类型（给设置页展示，避免 Windows 用户以为只认 Git Bash） */
export type AgentShellKind = "PowerShell" | "Git Bash" | "zsh" | "bash";

/**
 * 复刻 SDK 选壳逻辑的简版（可注入 platform/env 便于单测，不改 process 全局）。
 * win32：有 MSYSTEM 或 SHELL 像 Git Bash → Git Bash；否则几乎总是 PowerShell
 * （SDK 找得到 pwsh/powershell 就用它，且默认不带 -NoProfile）。
 */
/** 只读 env 子集——单测可传普通对象，不必满足完整 ProcessEnv */
export type AgentShellEnv = {
  readonly SHELL?: string | undefined;
  readonly MSYSTEM?: string | undefined;
};

export const detectAgentShellKind = (
  platform: NodeJS.Platform = process.platform,
  // 默认只抽用到的键，避免 ProcessEnv 与精确可选属性不兼容
  env: AgentShellEnv = {
    SHELL: process.env.SHELL,
    MSYSTEM: process.env.MSYSTEM,
  },
): AgentShellKind => {
  if (platform === "win32") {
    const shell = env.SHELL ?? "";
    // Git Bash 常见：MSYSTEM=MINGW64/MSYS；SHELL 指向 .../Git/.../bash.exe
    const looksLikeGitBash =
      Boolean(env.MSYSTEM) ||
      /(?:^|[\\/])(?:bash(?:\.exe)?)$/i.test(shell) ||
      /git[\\/].*[\\/]bash/i.test(shell);
    return looksLikeGitBash ? "Git Bash" : "PowerShell";
  }
  const shell = env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  // macOS 默认 zsh；其余 Unix 无明确 SHELL 时按 bash 兜底
  return platform === "darwin" ? "zsh" : "bash";
};

export type ShellBoostFileStatus = {
  path: string;
  exists: boolean;
  boosted: boolean;
};

/** 探测单个配置：存在 && 含对应方言守卫本体 → boosted */
export const probeShellBoostFile = async (
  absPath: string,
  displayPath: string,
  kind: ShellBoostFileKind = "posix",
): Promise<ShellBoostFileStatus> => {
  try {
    const content = await fs.readFile(absPath, "utf-8");
    return {
      path: displayPath,
      exists: true,
      boosted: hasShellBoost(content, kind),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: displayPath, exists: false, boosted: false };
    }
    throw err;
  }
};

export const probeAllShellBoost = async (): Promise<ShellBoostFileStatus[]> => {
  const targets = listShellBoostTargets();
  return Promise.all(
    targets.map((t) => probeShellBoostFile(t.absPath, t.path, t.kind)),
  );
};

export type ShellBoostAction = "injected" | "already" | "missing";

export type ShellBoostInjectResult = {
  path: string;
  action: ShellBoostAction;
};

/**
 * 原子写用户配置：tmp + rename。
 * 与 writePrivateFileAtomic 思路相同，但配置是用户文件——保留原 mode、不 chmod。
 */
const writeUserRcAtomic = async (
  finalPath: string,
  content: string,
  mode: number,
): Promise<void> => {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode });
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
};

/** YYYYMMDD，给备份文件名用 */
export const formatBackupDate = (d: Date = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
};

/** 对单个存在的配置注入守卫；不存在 → missing；已含 → already */
export const injectShellBoostFile = async (
  absPath: string,
  displayPath: string,
  kind: ShellBoostFileKind = "posix",
  now: Date = new Date(),
): Promise<ShellBoostInjectResult> => {
  let content: string;
  let mode: number;
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(absPath, "utf-8"),
      fs.stat(absPath),
    ]);
    content = raw;
    // 只取权限位，避免把文件类型 bit 写进 mode
    mode = stat.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: displayPath, action: "missing" };
    }
    throw err;
  }

  if (hasShellBoost(content, kind)) {
    return { path: displayPath, action: "already" };
  }

  // 备份：同日已有 .bak-YYYYMMDD 就不覆盖，避免重复一键优化冲掉更早备份
  const bakPath = `${absPath}.bak-${formatBackupDate(now)}`;
  try {
    await fs.access(bakPath);
  } catch {
    await fs.copyFile(absPath, bakPath);
  }

  await writeUserRcAtomic(
    absPath,
    injectShellBoostContent(content, kind),
    mode,
  );
  return { path: displayPath, action: "injected" };
};

export const injectAllShellBoost = async (): Promise<
  ShellBoostInjectResult[]
> => {
  const targets = listShellBoostTargets();
  const results: ShellBoostInjectResult[] = [];
  // 串行写：避免同盘多文件并行 rename 的边角问题
  for (const t of targets) {
    results.push(await injectShellBoostFile(t.absPath, t.path, t.kind));
  }
  return results;
};
