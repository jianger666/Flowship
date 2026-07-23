/**
 * team skill 启停状态独立存储（2026-07-22 所有权收敛）
 *
 * 背景：原方案把 team skill 的默认禁用写进 settings.disabledSkills——
 * server（首次禁用策略）和 client（设置保存链整写 config.json）两个 writer
 * 抢同一个字段，client 缓存不知道 server 追加的名单、随手一次保存就全冲掉（P0 已实测）。
 *
 * 收敛：team skill 状态单一 owner = team-library 模块，存
 * `<dataRoot>/team-library/skill-states.json`：
 *   Record<skill 名, "enabled" | "disabled">
 * 不在表里 = 还没见过（sync 后由默认策略补写）；在表里的永不被策略覆盖。
 * settings.disabledSkills 从此只管非 team 源。
 *
 * 本模块刻意零业务依赖（只 import fs/path/data-root）——
 * skills-loader 与 team-library 都要读它、放任一边都会循环 import。
 * 写入方（team-library 的 sync 默认策略 / install / uninstall）必须持
 * withTeamLibraryLock、本模块不自带锁（读方无锁直读、单文件原子写保证不撕裂）。
 *
 * 读分两路（2026-07-23）：
 * - readTeamSkillStates：loader / list 用，fail-open（损坏当空表 = 全 enabled）
 * - readTeamSkillStatesForSync：仅 sync 默认策略用，区分 ENOENT（首次可写默认）
 *   与「文件在但损坏」（绝不能当首次、否则用户 disabled 偏好被冲掉）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot, writePrivateFileAtomic } from "./data-root";

export type TeamSkillState = "enabled" | "disabled";

export const teamSkillStatesPath = (): string =>
  path.join(dataRoot(), "team-library", "skill-states.json");

/** 把 JSON 对象收成合法状态表；结构非法返 null（与「空表」区分） */
const parseStatesObject = (
  parsed: unknown,
): Record<string, TeamSkillState> | null => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, TeamSkillState> = {};
  for (const [name, state] of Object.entries(parsed)) {
    if (state === "enabled" || state === "disabled") out[name] = state;
  }
  return out;
};

/**
 * 读全部状态表；文件不存在 / 损坏 → 空表（fail-open、不阻断 loader）。
 * loader 读到空表 = 全 enabled——这是既定语义，不要改成 fail-closed。
 */
export const readTeamSkillStates = async (): Promise<
  Record<string, TeamSkillState>
> => {
  try {
    const raw = await fs.readFile(teamSkillStatesPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parseStatesObject(parsed) ?? {};
  } catch {
    return {};
  }
};

export type TeamSkillStatesSyncRead = {
  states: Record<string, TeamSkillState>;
  /**
   * true = ENOENT（首次）或合法 JSON，可走默认策略；
   * false = 文件存在但损坏 / 结构非法，绝不能当「首次」写全量 enabled。
   */
  trusted: boolean;
};

/** 损坏文件 rename 备份；失败忽略（别因备份失败再抛、阻断 sync） */
const backupCorruptSkillStates = async (): Promise<void> => {
  const filePath = teamSkillStatesPath();
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    await fs.rename(filePath, backupPath);
    console.warn(
      `[team-skill-states] skill-states.json 损坏、已备份到 ${path.basename(backupPath)}`,
    );
  } catch {
    // rename 失败忽略——调用方仍以 trusted:false 跳过默认策略
  }
};

/**
 * sync 默认策略专用读：区分「真没文件」和「文件坏了」。
 * ENOENT → trusted:true（首次、可补默认）；JSON/结构坏 → 备份 + trusted:false。
 */
export const readTeamSkillStatesForSync =
  async (): Promise<TeamSkillStatesSyncRead> => {
    const filePath = teamSkillStatesPath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // 真没文件 = 首次安装态，允许默认策略写入
      if (code === "ENOENT") return { states: {}, trusted: true };
      // 权限等其它读失败：保守跳过默认策略，别误当首次
      console.warn(
        "[team-skill-states] 读取 skill-states.json 失败、跳过默认策略:",
        err instanceof Error ? err.message : err,
      );
      return { states: {}, trusted: false };
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const states = parseStatesObject(parsed);
      if (!states) {
        // 根类型不是对象（null / 数组 / 标量）——当损坏
        await backupCorruptSkillStates();
        return { states: {}, trusted: false };
      }
      return { states, trusted: true };
    } catch {
      await backupCorruptSkillStates();
      return { states: {}, trusted: false };
    }
  };

/** 整表原子写（0600、tmp+rename）；调用方负责先持 team-library 仓锁 */
export const writeTeamSkillStates = async (
  states: Record<string, TeamSkillState>,
): Promise<void> => {
  // key 排序稳定输出、diff 友好
  const sorted = Object.fromEntries(
    Object.entries(states).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writePrivateFileAtomic(
    teamSkillStatesPath(),
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
};
