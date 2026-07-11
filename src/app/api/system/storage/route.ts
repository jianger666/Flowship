/**
 * GET /api/system/storage（v1.0.x 存储清理）
 *
 * 返回 data/tasks/ 的磁盘占用总览：总字节数 + 每个任务目录的大小 / 关键元信息。
 * 给设置页「存储」卡片用——app 越用越大（events.jsonl / 上传图片 / artifact 无限积累）、
 * 用户手动挑着删（删除走既有 DELETE /api/tasks/[id]、带停 agent / 清 worktree 的完整链路）。
 *
 * 大小统计是递归 walk（本地盘、任务数量级几十上百、无压力）；单个目录 walk 失败按 0 记、不挡整表。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR, META_FILE, ensureDataDir } from "@/lib/server/task-fs-core";
import type { RepoStatus, TaskMode } from "@/lib/types";

export const runtime = "nodejs";

// 递归算目录字节数（软链不跟、避免环）
const dirSize = async (dir: string): Promise<number> => {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        total += await dirSize(p);
      } else if (e.isFile()) {
        total += (await fs.stat(p)).size;
      }
    } catch {
      /* 单个文件读不到不挡整表 */
    }
  }
  return total;
};

export interface StorageEntry {
  id: string;
  title: string;
  mode: TaskMode;
  repoStatus: RepoStatus;
  updatedAt: number;
  bytes: number;
}

export const GET = async () => {
  try {
    await ensureDataDir();
    const dirents = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const entries: StorageEntry[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const dir = path.join(DATA_DIR, d.name);
      // meta 读不出的目录（残留 / 损坏）也列出来、让用户能删掉
      let title = d.name;
      let mode: TaskMode = "task";
      let repoStatus: RepoStatus = "developing";
      let updatedAt = 0;
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(dir, META_FILE), "utf8"),
        ) as {
          title?: string;
          mode?: TaskMode;
          repoStatus?: RepoStatus;
          updatedAt?: number;
        };
        if (typeof raw.title === "string" && raw.title) title = raw.title;
        if (raw.mode === "chat" || raw.mode === "task") mode = raw.mode;
        if (typeof raw.repoStatus === "string") repoStatus = raw.repoStatus;
        if (typeof raw.updatedAt === "number") updatedAt = raw.updatedAt;
      } catch {
        /* meta 缺失照常按目录列出 */
      }
      entries.push({
        id: d.name,
        title,
        mode,
        repoStatus,
        updatedAt,
        bytes: await dirSize(dir),
      });
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
    return NextResponse.json({ dataDir: DATA_DIR, totalBytes, entries });
  } catch (err) {
    console.error("[GET /api/system/storage] failed", err);
    return NextResponse.json({ error: "storage_scan_failed" }, { status: 500 });
  }
};
