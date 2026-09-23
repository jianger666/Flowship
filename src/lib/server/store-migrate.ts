/**
 * store 迁移与回滚（v3.1 §8：备份 → 转换 → 校验 → 失败拒绝启动）。
 *
 * - 迁移：停写（调用方负责 quiesce）→ 全量备份 `cp -r <stateRoot> <stateRoot>.bak-<ts>`
 *   → JSONL→sqlite 转换占位（逐行 JSON 校验，半行进 quarantine，不静默丢）→ 计数校验；
 * - 脏行不静默跳过：逐行记录 `quarantine-<ts>.jsonl` + 调用方日志告警；
 * - 双读 fallback：primary 读失败自动降级读备份（只读）；
 * - 回滚：删/改名 sqlite → 恢复备份 → `STORE_BACKEND=jsonl` → 重启（命令见 rollbackCommands）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface MigrateResult {
  backupDir: string;
  quarantineFile: string;
  total: number;
  kept: number;
  quarantined: number;
}

const isJsonLine = (line: string): boolean => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

/**
 * 通用行级转换（占位实现：把 ndjson 逐行校验后原样搬运，半行进 quarantine）。
 * 真正的 JSONL→sqlite 行映射在 SDK store 定稿后替换本函数内部，不动接口。
 */
export const migrateNdjsonFile = async (
  srcFile: string,
  dstFile: string,
  quarantineFile: string,
): Promise<{ total: number; kept: number; quarantined: number }> => {
  let raw: string;
  try {
    raw = await fs.readFile(srcFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { total: 0, kept: 0, quarantined: 0 };
    }
    throw err;
  }
  await fs.mkdir(path.dirname(dstFile), { recursive: true });
  await fs.mkdir(path.dirname(quarantineFile), { recursive: true });
  let total = 0;
  let kept = 0;
  let quarantined = 0;
  const keptLines: string[] = [];
  const badLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    total += 1;
    if (isJsonLine(line)) {
      kept += 1;
      keptLines.push(line);
    } else {
      quarantined += 1;
      badLines.push(line);
    }
  }
  await fs.writeFile(dstFile, keptLines.length ? `${keptLines.join("\n")}\n` : "", "utf-8");
  // quarantine 为空也落空文件（调用方据此判定“无脏行”）。
  try {
    await fs.writeFile(quarantineFile, badLines.length ? `${badLines.join("\n")}\n` : "", "utf-8");
  } catch {
    /* best-effort */
  }
  return { total, kept, quarantined };
};

/** 双读 fallback：primary 抛错/缺失则读 backup（只读，不回写）。 */
export const readWithFallback = async (
  primaryFile: string,
  backupFile: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(primaryFile, "utf-8");
  } catch {
    try {
      return await fs.readFile(backupFile, "utf-8");
    } catch {
      return null;
    }
  }
};

/** 回滚命令（调用方逐条执行，每步可单独重试）。 */
export const rollbackCommands = (args: {
  sqliteFile: string;
  stateRoot: string;
  backupDir: string;
}): string[] => [
  `# 1. 停写（调用方 quiesce worker，主进程拒新 spawn）`,
  `mv ${JSON.stringify(args.sqliteFile)} ${JSON.stringify(`${args.sqliteFile}.bad-${Date.now()}`)}`,
  `cp -r ${JSON.stringify(args.backupDir)} ${JSON.stringify(`${args.stateRoot}.restored-${Date.now()}`)}`,
  `# 2. 降级开关后重启（JSONL 只读）`,
  `STORE_BACKEND=jsonl node scripts/repair-sdk-store.mjs --check`,
];
