/**
 * GET /api/system/storage（v1.0.x 存储清理）
 * DELETE /api/system/storage?stale=<id>（清残留工作区）
 *
 * 返回 data/tasks/ + worktrees/ 的磁盘占用总览：总字节数 + 每个任务的
 * 任务数据 / 工作区分项 + 无对应任务的残留工作区列表。
 * 给会话管理页用——app 越用越大（events.jsonl / 上传图片 / artifact /
 * 前端仓 node_modules 工作区），用户手动挑着删。
 *
 * 量尺走缓存（2026-11-12：每次进页面把 18GB worktree 全 `du` 一遍、把机器拖卡）：
 * - 任务数据目录：缓存 10 分钟，没缓存的请求内并发限 4 量一遍（总共才 ~2GB、实测 543 个目录 0.8 秒；
 *   同一目录的并发请求共用一次 du）；
 * - worktree：缓存 6 小时（+ 容器目录 mtime 失效）；**没缓存的不在请求里量**——先以 `null`（统计中）返回，
 *   后台单路慢慢量，前端按 `worktreeScan.pending` 轮询到 0；
 * - `?refresh=1`：用户点「重新统计」才整表作废重量。
 * 实现见 storage-size-cache.ts / dir-size.ts。
 *
 * 只枚举 data/tasks/ 与 data/worktrees/ 下的**目录**，不枚举数据根：数据根里的 config.json 同族文件
 * （.bak / .bak.shrink / .corrupt-<ts> / .tmp.*）含明文旧凭据，既不列出、也不计入占用——
 * 日后若要扩展到数据根，必须整族排除（行为钉在 tests/settings-backup-exclusion.test.ts）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { stripBom } from "@/lib/server/data-root";
import { dirSize, mapPool } from "@/lib/server/dir-size";
import {
  TASK_DATA_TTL_MS,
  WORKTREE_TTL_MS,
  clearSizeCache,
  failedScanCount,
  getAnySize,
  getFreshSize,
  getSizeMeasuredAt,
  loadSizeCache,
  pendingScanCount,
  pruneSizeCache,
  putSize,
  scheduleSizeScan,
} from "@/lib/server/storage-size-cache";
import { DATA_DIR, META_FILE, ensureDataDir, sanitizeId } from "@/lib/server/task-fs-core";
import {
  cleanupStaleTaskWorktrees,
  getTaskWorktreesDir,
  getWorktreesRoot,
  type WipSnapshotInfo,
} from "@/lib/server/task-worktrees";
import { errorResponse } from "@/lib/server/route-helpers";
import type { RepoStatus, TaskMode } from "@/lib/types";

export const runtime = "nodejs";

/** 任务数据目录大小的并发上限（du 虽快、同时开太多也会抢盘） */
const DATA_SIZE_CONCURRENCY = 4;

/**
 * 任务数据目录量尺的在途去重：两个请求同时进来（页面轮询 + 手动刷新 / 两个窗口）时，同一个目录只起一个 du，
 * 后到的直接等先到的结果。按完整路径做 key（数据根可能被测试 / 多实例切换）。
 */
const dataSizeInflight = new Map<string, Promise<number | null>>();
const measureDataDir = (dir: string): Promise<number | null> => {
  let p = dataSizeInflight.get(dir);
  if (!p) {
    p = dirSize(dir).finally(() => dataSizeInflight.delete(dir));
    dataSizeInflight.set(dir, p);
  }
  return p;
};

export interface StorageEntry {
  id: string;
  title: string;
  mode: TaskMode;
  repoStatus: RepoStatus;
  updatedAt: number;
  /** 任务数据目录（data/tasks/<id>）字节数 */
  bytes: number;
  /** 该任务 worktree 目录字节数；没有 = 0；null = 后台还在量（统计中） */
  worktreeBytes: number | null;
}

/** worktrees/ 下有、但 data/tasks/ 无对应任务的残留工作区 */
export interface StaleWorktree {
  id: string;
  /** null = 后台还在量（统计中） */
  bytes: number | null;
}

/** 快照 → 给前端的精简字段（ref 让 toast 能告诉用户「改动存在哪、去哪找回」） */
const toSnapshotDto = (s: WipSnapshotInfo & { dirName: string }) => ({
  dirName: s.dirName,
  repoPath: s.repoPath,
  ref: s.ref,
});

const dataKey = (id: string): string => `data:${id}`;
const worktreeKey = (id: string): string => `wt:${id}`;

/**
 * 某个 worktree 容器目录此刻的占用：
 * - 目录不在（任务没建过 / 归档清掉了）→ 0；
 * - 缓存有效 → 缓存值；
 * - 缓存过期 / 戳对不上 → 先拿旧值顶着、同时排进后台量尺（stale-while-revalidate，界面不闪「统计中」）；
 * - 从没量过 → null（统计中），并排进后台单路量尺（不在请求里量）。
 */
const worktreeBytesOf = async (id: string): Promise<number | null> => {
  const dir = getTaskWorktreesDir(id);
  let stamp: number | null = null;
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return 0;
    stamp = st.mtimeMs;
  } catch {
    return 0;
  }
  const hit = getFreshSize(worktreeKey(id), { stamp, ttlMs: WORKTREE_TTL_MS });
  if (hit !== null) return hit;
  scheduleSizeScan(worktreeKey(id), dir, stamp);
  return getAnySize(worktreeKey(id));
};

export const GET = async (req?: Request) => {
  try {
    await ensureDataDir();
    await loadSizeCache();
    // 「重新统计」：整表作废重量（普通进页面 / 删除后的刷新都走缓存、不碰磁盘）
    if (req && new URL(req.url).searchParams.get("refresh") === "1") clearSizeCache();
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
          stripBom(await fs.readFile(path.join(dir, META_FILE), "utf8")),
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
        bytes: 0, // 下面并发补
        worktreeBytes: 0,
      });
    }

    const liveIds = new Set(taskIds);

    // 任务数据目录大小：缓存有效的直接用；没有的并发限 4 量一遍（mapPool 按入参顺序回结果——
    // 结果与 entries 一一对应，不受完成先后影响）。worktree 不在这里量（见 worktreeBytesOf）。
    const dataSizes = await mapPool(entries, DATA_SIZE_CONCURRENCY, async (e) => {
      const hit = getFreshSize(dataKey(e.id), { stamp: null, ttlMs: TASK_DATA_TTL_MS });
      if (hit !== null) return hit;
      const bytes = await measureDataDir(path.join(DATA_DIR, e.id));
      // 量不出（du 超时 / 被杀）：用旧值顶着、不缓存失败，下次请求再试
      if (bytes === null) return getAnySize(dataKey(e.id)) ?? 0;
      putSize(dataKey(e.id), bytes, null);
      return bytes;
    });
    for (let i = 0; i < entries.length; i++) entries[i].bytes = dataSizes[i];

    // worktree：stat 很轻、逐个来；量尺交给后台队列
    for (const e of entries) e.worktreeBytes = await worktreeBytesOf(e.id);

    // 残留工作区：worktrees/ 下有、但 tasks/ 无对应目录
    const staleWorktrees: StaleWorktree[] = [];
    try {
      const wtDirents = await fs.readdir(worktreesRoot, { withFileTypes: true });
      const staleIds = wtDirents
        // 点开头的是内部中转目录（如依赖克隆的 .dep-clone-tmp）、不是任务残留：别列给用户删
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !liveIds.has(d.name))
        .map((d) => d.name);
      for (const id of staleIds) {
        staleWorktrees.push({ id, bytes: await worktreeBytesOf(id) });
      }
      // 已知大小的按大小降序排前面；统计中的排后面（量完下一轮轮询自然归位）
      staleWorktrees.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    } catch {
      /* worktrees 根不存在 = 从没建过、无残留 */
    }

    // 缓存里不再对应任何任务 / 目录的条目清掉，别让缓存无限长
    const liveKeys = new Set<string>();
    for (const e of entries) {
      liveKeys.add(dataKey(e.id));
      liveKeys.add(worktreeKey(e.id));
    }
    for (const s of staleWorktrees) liveKeys.add(worktreeKey(s.id));
    pruneSizeCache(liveKeys);

    // 按合计占用降序（工作区往往远大于任务数据；统计中的工作区按 0 计、量完下一轮归位）
    entries.sort(
      (a, b) => b.bytes + (b.worktreeBytes ?? 0) - (a.bytes + (a.worktreeBytes ?? 0)),
    );
    const totalBytes =
      entries.reduce((s, e) => s + e.bytes + (e.worktreeBytes ?? 0), 0) +
      staleWorktrees.reduce((s, e) => s + (e.bytes ?? 0), 0);

    // 已量出的 worktree 里最旧的一条的量尺时间——界面标「工作区占用为 x 前的统计」
    let oldestAt: number | null = null;
    for (const e of entries) {
      if (!e.worktreeBytes) continue;
      const at = getSizeMeasuredAt(worktreeKey(e.id));
      if (at !== null && (oldestAt === null || at < oldestAt)) oldestAt = at;
    }

    return NextResponse.json({
      dataDir: DATA_DIR,
      worktreesDir: worktreesRoot,
      totalBytes,
      entries,
      staleWorktrees,
      // pending = 后台还在量的工作区个数：>0 时前端隔几秒再拉一次（拉的是缓存、不重新 du；
      // 每次仍会 readdir + 读各任务 meta.json + stat worktree 容器目录，毫秒级）；
      // failed = 最近量不出（du 超时 / 被杀）的个数：这些不在排队、没有新值，界面标「量不出」、别一直转圈；
      // measuredAt = 已量出的最旧一条
      worktreeScan: { pending: pendingScanCount(), failed: failedScanCount(), measuredAt: oldestAt },
    });
  } catch (err) {
    console.error("[GET /api/system/storage] failed", err);
    return NextResponse.json({ error: "storage_scan_failed" }, { status: 500 });
  }
};

/**
 * 删除残留工作区：仅当 data/tasks/<id> 不存在时才允许删，
 * 防误删还活着的任务的 worktree。
 *
 * 逐个仓目录走 WIP 快照守卫（与删任务 / 归档同一道，见 cleanupStaleTaskWorktrees）：
 * 未提交改动存得下 → 先落 ref 再删；存不下（冲突态 / 子模块有改动 / 嵌套仓 / 原仓不可用…）→ 该目录保留，
 * 整个请求回 409 + `kept`（原因列表）。前端据此再问用户一次，确认后带 `force=1` 才越过守卫。
 * 旧实现是裸 `fs.rm`——而守卫保留下来的目录恰好就是之后出现在这个列表里的那批（第三轮 review D2b-01）。
 */
export const DELETE = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const raw = params.get("stale")?.trim() ?? "";
  const force = params.get("force") === "1";
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
    const res = await cleanupStaleTaskWorktrees(id, { force });
    if (res.kept.length > 0) {
      // 已处理掉的那部分照常生效；保留的目录里还有没存下的改动，交给用户决定
      return NextResponse.json(
        {
          error: `有 ${res.kept.length} 个工作区目录里的未提交改动无法自动保存，已保留未删除`,
          kept: res.kept.map((k) => ({
            dirName: k.dirName,
            reason: k.reason,
            // 快照其实落了、只是目录没删掉：前端据此别再说「删了就找不回」（Q3-07）
            ...(k.snapshotSaved ? { snapshotSaved: true } : {}),
          })),
          removedDirs: res.removedDirs,
          snapshots: res.snapshots.map(toSnapshotDto),
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      removedDirs: res.removedDirs,
      snapshots: res.snapshots.map(toSnapshotDto),
      // force 越过守卫强删的目录（快照没存下、改动已丢）：让调用方 / 日志看得到，不静默（Q3-06）
      ...(res.forced.length > 0
        ? { forced: res.forced.map((k) => ({ dirName: k.dirName, reason: k.reason })) }
        : {}),
    });
  } catch (err) {
    console.error("[DELETE /api/system/storage] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "删除残留工作区失败",
      500,
    );
  }
};
