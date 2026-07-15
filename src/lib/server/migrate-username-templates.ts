/**
 * 一次性幂等迁移：清掉历史 task meta 里 repoBranchTemplates 的 username 占位符残留
 *
 * 背景：分支模板占位符曾靠 settings.username 烘焙；config 侧已烘干净，
 * 但建 task 时固化进 meta.json 的 per-repo 覆盖快照仍可能含该占位符。
 * 运行时 renderBranchName 收不到 username 变量 → 渲染为空段（靠 / 清理兜住），
 * 等于坏值。本迁移：含该占位符的 override 条目直接删掉 → 回退全局/内置默认模板。
 *
 * 幂等：第二次启动扫不到残留 → 零写盘。
 *
 * 写盘不用 writeMeta：task-fs-core 的 DATA_DIR 在模块加载时冻结，
 * 测试 / 动态 FE_AI_FLOW_DATA_DIR 场景会写错目录；这里全程走运行时 dataRoot()。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot, writePrivateFileAtomic } from "./data-root";
import {
  isValidMetaShape,
  META_FILE,
  type TaskMetaV06,
} from "./task-fs-core";

const USERNAME_TOKEN = "{username}";

/**
 * 从 repoBranchTemplates 里删掉值含 username 占位符的条目。
 * @returns 是否有改动 + 清洗后的 map（空 map 返 undefined、与落盘约定一致）
 */
export const pruneUsernameBranchTemplates = (
  templates: Record<string, string> | undefined,
): {
  changed: boolean;
  next: Record<string, string> | undefined;
} => {
  if (!templates || typeof templates !== "object") {
    return { changed: false, next: templates };
  }
  let changed = false;
  const next: Record<string, string> = {};
  for (const [repo, tpl] of Object.entries(templates)) {
    if (typeof tpl === "string" && tpl.includes(USERNAME_TOKEN)) {
      changed = true;
      continue; // 删掉该 override
    }
    next[repo] = tpl;
  }
  if (!changed) return { changed: false, next: templates };
  return {
    changed: true,
    next: Object.keys(next).length > 0 ? next : undefined,
  };
};

/**
 * 扫 data/tasks 下各任务 meta.json，清含 username 占位符的 override。
 * @returns 实际改写的 task 数（供日志 / 单测断言）
 */
export const migrateUsernameBranchTemplates = async (): Promise<number> => {
  const tasksRoot = path.join(dataRoot(), "tasks");
  let entries: string[];
  try {
    entries = await fs.readdir(tasksRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0; // 尚无 tasks 目录、无事可做
    throw err;
  }

  let modified = 0;
  for (const id of entries) {
    const metaPath = path.join(tasksRoot, id, META_FILE);
    let rawText: string;
    try {
      rawText = await fs.readFile(metaPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // 非 task 目录 / 无 meta
      console.warn(
        `[migrate-username] 读 meta 失败 taskId=${id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.warn(`[migrate-username] meta JSON 损坏、跳过 taskId=${id}`);
      continue;
    }
    if (!isValidMetaShape(parsed)) {
      // V0.5 残留等——不硬改
      continue;
    }

    const meta = parsed as TaskMetaV06;
    const { changed, next } = pruneUsernameBranchTemplates(
      meta.repoBranchTemplates,
    );
    if (!changed) continue;

    meta.repoBranchTemplates = next;
    try {
      // 原子写（tmp+rename）；路径跟读侧一样走运行时 dataRoot()
      await writePrivateFileAtomic(
        metaPath,
        JSON.stringify(meta, null, 2) + "\n",
      );
      modified += 1;
      console.log(
        `[migrate-username] 已清除 repoBranchTemplates 中的 username 占位符：taskId=${id}`,
      );
    } catch (err) {
      console.warn(
        `[migrate-username] 写回失败 taskId=${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return modified;
};
