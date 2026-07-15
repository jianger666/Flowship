/**
 * Cursor agent shell 提速守卫
 *
 * Cursor SDK 的 agent shell 每条命令走「快照恢复→执行→重新序列化 shell 状态」。
 * rc 里加载的重型工具函数表会让序列化滚雪球、越用越慢（官方论坛已确认的性能 bug）。
 * 官方缓解：在 shell rc **最顶部**加守卫，agent 的非交互 shell（COMPOSER_NO_INTERACTION=1）
 * 跳过重型初始化。本模块提供探测 + 一键注入（设置页入口）。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 守卫注释——说明来源与可删，用户看到就知道是谁写的 */
export const SHELL_BOOST_COMMENT =
  "# Cursor agent 非交互 shell 跳过重型初始化——缓解 SDK shell 状态序列化膨胀（Flowship 一键优化写入、可随时删）";

/** 守卫本体：agent 非交互 shell 直接 return，跳过后续 rc 重型加载 */
export const SHELL_BOOST_GUARD =
  '[[ "$COMPOSER_NO_INTERACTION" == "1" ]] && return';

/**
 * 探测「是否已注入」的特征串——用 env 名比整段匹配更稳
 *（用户可能改过注释文案，但守卫条件不会变）
 */
export const SHELL_BOOST_MARKER = "COMPOSER_NO_INTERACTION";

/** 生成要顶插的两行（末尾带换行，方便直接拼接原文） */
export const buildShellBoostBlock = (): string =>
  `${SHELL_BOOST_COMMENT}\n${SHELL_BOOST_GUARD}\n`;

/** 内容是否已含守卫（按特征串判断） */
export const hasShellBoost = (content: string): boolean =>
  content.includes(SHELL_BOOST_MARKER);

/**
 * 纯函数：把守卫块插到内容最顶部。
 * 已含守卫则原样返回（幂等）；必须顶插，否则重型初始化已经跑完、守卫无效。
 */
export const injectShellBoostContent = (content: string): string => {
  if (hasShellBoost(content)) return content;
  return buildShellBoostBlock() + content;
};

export type ShellBoostTarget = {
  /** 绝对路径（fs 操作用） */
  absPath: string;
  /** 展示用 ~ 路径 */
  path: string;
};

/**
 * 按平台列出目标 rc。不存在的文件由调用方跳过创建——
 * 没有 rc 说明没有重型加载，注入无意义。
 */
export const listShellBoostTargets = (
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): ShellBoostTarget[] => {
  // win32 只处理 Git Bash 的 ~/.bashrc；PowerShell 无官方守卫机制
  const names =
    platform === "win32" ? [".bashrc"] : [".zshrc", ".bashrc"];
  return names.map((name) => ({
    absPath: path.join(home, name),
    path: `~/${name}`,
  }));
};

export type ShellBoostFileStatus = {
  path: string;
  exists: boolean;
  boosted: boolean;
};

/** 探测单个 rc：存在 && 含特征串 → boosted */
export const probeShellBoostFile = async (
  absPath: string,
  displayPath: string,
): Promise<ShellBoostFileStatus> => {
  try {
    const content = await fs.readFile(absPath, "utf-8");
    return {
      path: displayPath,
      exists: true,
      boosted: hasShellBoost(content),
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
    targets.map((t) => probeShellBoostFile(t.absPath, t.path)),
  );
};

export type ShellBoostAction = "injected" | "already" | "missing";

export type ShellBoostInjectResult = {
  path: string;
  action: ShellBoostAction;
};

/**
 * 原子写用户 rc：tmp + rename。
 * 与 writePrivateFileAtomic 思路相同，但 rc 是用户文件——保留原 mode、不 chmod。
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

/** 对单个存在的 rc 注入守卫；不存在 → missing；已含 → already */
export const injectShellBoostFile = async (
  absPath: string,
  displayPath: string,
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

  if (hasShellBoost(content)) {
    return { path: displayPath, action: "already" };
  }

  // 备份：同日已有 .bak-YYYYMMDD 就不覆盖，避免重复一键优化冲掉更早备份
  const bakPath = `${absPath}.bak-${formatBackupDate(now)}`;
  try {
    await fs.access(bakPath);
  } catch {
    await fs.copyFile(absPath, bakPath);
  }

  await writeUserRcAtomic(absPath, injectShellBoostContent(content), mode);
  return { path: displayPath, action: "injected" };
};

export const injectAllShellBoost = async (): Promise<
  ShellBoostInjectResult[]
> => {
  const targets = listShellBoostTargets();
  const results: ShellBoostInjectResult[] = [];
  // 串行写：避免同盘多文件并行 rename 的边角问题；rc 也就 1～2 个
  for (const t of targets) {
    results.push(await injectShellBoostFile(t.absPath, t.path));
  }
  return results;
};
