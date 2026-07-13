/**
 * GET /api/system/storage（v1.0.x 存储清理）
 * DELETE /api/system/storage?stale=<id>（清残留工作区）
 *
 * 返回 data/tasks/ + worktrees/ 的磁盘占用总览：总字节数 + 每个任务的
 * 任务数据 / 工作区分项 + 无对应任务的残留工作区列表。
 * 给设置页「存储」卡片用——app 越用越大（events.jsonl / 上传图片 / artifact /
 * 前端仓 node_modules 工作区），用户手动挑着删。
 *
 * 大小统计优先 `du -sk`（mac/linux、秒级扫完数十万文件的 node_modules）；
 * 失败或 Windows 回退 Node 递归 walk。工作区目录逐任务并发限 4。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { DATA_DIR, META_FILE, ensureDataDir, sanitizeId } from "@/lib/server/task-fs-core";
import { getTaskWorktreesDir, getWorktreesRoot } from "@/lib/server/task-worktrees";
import { errorResponse } from "@/lib/server/route-helpers";
import type { RepoStatus, TaskMode } from "@/lib/types";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

/** 工作区目录大小并发上限（node_modules 动辄数十万文件、全开会把盘打爆） */
const WORKTREE_SIZE_CONCURRENCY = 4;

/** `du -sk` 超时（大仓偶发慢、别无限挂） */
const DU_TIMEOUT_MS = 120_000;

// 递归算目录字节数（软链不跟、避免环）——du 不可用时的回退
const dirSizeWalk = async (dir: string): Promise<number> => {
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
        total += await dirSizeWalk(p);
      } else if (e.isFile()) {
        total += (await fs.stat(p)).size;
      }
    } catch {
      /* 单个文件读不到不挡整表 */
    }
  }
  return total;
};

/**
 * 优先 `du -sk`（块大小 1KB → ×1024 得字节）；mac/linux 才走、失败或 win 回退 walk。
 * 为什么：前端仓 worktree 里 node_modules 几十万文件，Node readdir 递归要分钟级，
 * du 走内核元数据、秒级。
 */
const dirSize = async (dir: string): Promise<number> => {
  // 目录不存在直接 0（任务没建过 worktree 很常见）
  try {
    await fs.access(dir);
  } catch {
    return 0;
  }
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("du", ["-sk", dir], {
        timeout: DU_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      // 输出形如 "12345\t/path" 或 "12345 /path"
      const kb = parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
      if (Number.isFinite(kb) && kb >= 0) return kb * 1024;
    } catch {
      /* du 超时 / 未装 / 权限 → 走 walk */
    }
  }
  return dirSizeWalk(dir);
};

/** 简易并发池：对 items 跑 fn、最多 concurrency 路同时跑 */
const mapPool = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (idx < items.length) {
        const cur = idx++;
        out[cur] = await fn(items[cur]);
      }
    },
  );
  if (items.length > 0) await Promise.all(workers);
  return out;
};

export interface StorageEntry {
  id: string;
  title: string;
  mode: TaskMode;
  repoStatus: RepoStatus;
  updatedAt: number;
  /** 任务数据目录（data/tasks/<id>）字节数 */
  bytes: number;
  /** 该任务 worktree 目录字节数；没有 = 0 */
  worktreeBytes: number;
}

/** worktrees/ 下有、但 data/tasks/ 无对应任务的残留工作区 */
export interface StaleWorktree {
  id: string;
  bytes: number;
}

export const GET = async () => {
  try {
    await ensureDataDir();
    const worktreesRoot = getWorktreesRoot();

    const dirents = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const taskIds: string[] = [];
    const entries: StorageEntry[] = [];

    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      taskIds.push(d.name);
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
        worktreeBytes: 0, // 下面并发补
      });
    }

    const liveIds = new Set(taskIds);

    // 活任务的 worktree 大小：并发限 4（du 虽快、同时开太多也会抢盘）
    const wtSizes = await mapPool(entries, WORKTREE_SIZE_CONCURRENCY, async (e) =>
      dirSize(getTaskWorktreesDir(e.id)),
    );
    for (let i = 0; i < entries.length; i++) {
      entries[i].worktreeBytes = wtSizes[i];
    }

    // 残留工作区：worktrees/ 下有、但 tasks/ 无对应目录
    const staleWorktrees: StaleWorktree[] = [];
    try {
      const wtDirents = await fs.readdir(worktreesRoot, { withFileTypes: true });
      const staleIds = wtDirents
        .filter((d) => d.isDirectory() && !liveIds.has(d.name))
        .map((d) => d.name);
      const staleSizes = await mapPool(staleIds, WORKTREE_SIZE_CONCURRENCY, async (id) =>
        dirSize(path.join(worktreesRoot, id)),
      );
      for (let i = 0; i < staleIds.length; i++) {
        staleWorktrees.push({ id: staleIds[i], bytes: staleSizes[i] });
      }
      staleWorktrees.sort((a, b) => b.bytes - a.bytes);
    } catch {
      /* worktrees 根不存在 = 从没建过、无残留 */
    }

    // 按合计占用降序（工作区往往远大于任务数据）
    entries.sort((a, b) => b.bytes + b.worktreeBytes - (a.bytes + a.worktreeBytes));
    const totalBytes =
      entries.reduce((s, e) => s + e.bytes + e.worktreeBytes, 0) +
      staleWorktrees.reduce((s, e) => s + e.bytes, 0);

    return NextResponse.json({
      dataDir: DATA_DIR,
      worktreesDir: worktreesRoot,
      totalBytes,
      entries,
      staleWorktrees,
    });
  } catch (err) {
    console.error("[GET /api/system/storage] failed", err);
    return NextResponse.json({ error: "storage_scan_failed" }, { status: 500 });
  }
};

/**
 * 删除残留工作区：仅当 data/tasks/<id> 不存在时才允许删，
 * 防误删还活着的任务的 worktree。
 */
export const DELETE = async (req: Request) => {
  const raw = new URL(req.url).searchParams.get("stale")?.trim() ?? "";
  if (!raw) return errorResponse("stale 必填", 400);

  let id: string;
  try {
    id = sanitizeId(raw);
  } catch {
    return errorResponse("非法 id", 400);
  }

  // 活任务 → 拒删（走 DELETE /api/tasks/[id] 才能连带清）
  const taskPath = path.join(DATA_DIR, id);
  try {
    const st = await fs.stat(taskPath);
    if (st.isDirectory()) {
      return errorResponse("任务仍存在、请走任务删除", 409);
    }
  } catch {
    /* 任务目录不存在 = 允许清残留 */
  }

  const wtDir = getTaskWorktreesDir(id);
  try {
    const st = await fs.stat(wtDir);
    if (!st.isDirectory()) {
      return errorResponse("残留工作区不存在", 404);
    }
  } catch {
    return errorResponse("残留工作区不存在", 404);
  }

  try {
    await fs.rm(wtDir, { recursive: true, force: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/system/storage] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "删除残留工作区失败",
      500,
    );
  }
};
