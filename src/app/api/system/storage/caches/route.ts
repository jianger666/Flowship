/**
 * GET  /api/system/storage/caches  → 可清理的无用缓存概览（只读）
 * POST /api/system/storage/caches  → 执行清理（会话管理页「清理缓存」，用户点了才跑；不在启动时自动清）
 *
 * 清什么（背景见 session-cache-release.ts）：
 *   ① 已归档、却仍握着会话锚点（sessionAgentId）的任务：放掉锚点（Cursor SDK 的 store GC 才能回收它的对话数据），
 *      自定义提供方的会话文件一并删；会话在忙 / 有收尾流程在管的跳过；
 *      **老任务**（没有 provider 字段、锚点是自定义形态）也跳过——锚点是它「用哪家提供方」的唯一证据，
 *      清了之后取消归档再发消息会无声改走 Cursor 云端（评审 R16-03）；
 *   ② pi-sessions 里没有任何任务指向的孤儿会话文件（旁路会话、换新会话后的旧文件、已删任务的遗留）；最近 10 分钟写过的不算。
 * 不清什么：会话内容 / 事件记录（events.jsonl）/ 代码 / 工作区——UI 数据源不受影响，恢复归档后下一条消息起新会话、靠事件流回读上下文。
 *
 * Cursor SDK store 的空间由它自己的 GC 回收（有 10 分钟宽限 + 50 MB 下限）：POST 之后触发一次，没到条件的留给下次启动。
 */

import { NextResponse } from "next/server";

import type { CachesCleanupResult, CachesSummary } from "@/lib/cache-cleanup-text";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import { maybeGcSdkStore } from "@/lib/server/sdk-store-gc";
import {
  deletePiSessionFile,
  listArchivedSessionHolders,
  listOrphanPiSessionFiles,
} from "@/lib/server/session-cache-release";
import { releaseArchivedTaskSessionCache } from "@/lib/server/task-runner";

export const runtime = "nodejs";

/** 清理进行中再点直接 409（清理逐个任务串行走、并发两遍没有收益、只会互相抢锚点） */
const inFlight = { current: false };

export const GET = async () => {
  try {
    const [allHolders, orphans] = await Promise.all([
      listArchivedSessionHolders(),
      listOrphanPiSessionFiles(),
    ]);
    // 保留提供方证据的老任务不算「可清理」，单独数
    const holders = allHolders.filter((h) => !h.keepsProviderEvidence);
    const summary: CachesSummary = {
      archivedHolders: holders.length,
      legacyKept: allHolders.length - holders.length,
      archivedPiBytes: holders.reduce((s, h) => s + (h.piBytes ?? 0), 0),
      orphanFiles: orphans?.length ?? 0,
      orphanBytes: (orphans ?? []).reduce((s, o) => s + o.bytes, 0),
      orphanSkipped: orphans === null,
    };
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[GET /api/system/storage/caches] failed", err);
    return NextResponse.json({ error: "caches_scan_failed" }, { status: 500 });
  }
};

export const POST = async () => {
  if (inFlight.current) {
    return NextResponse.json({ error: "正在清理中、请稍后再试" }, { status: 409 });
  }
  inFlight.current = true;
  try {
    let released = 0;
    let skippedBusy = 0;
    let skippedKept = 0;
    let skippedLegacy = 0;
    let piBytesFreed = 0;

    for (const h of await listArchivedSessionHolders()) {
      // 有 stopping / deleting / finalizing 等收尾流程在管的任务不插手
      if (getChatLifecycle(h.id) !== null) {
        skippedBusy += 1;
        continue;
      }
      // 老任务保留锚点（R16-03）。名单阶段就跳过省一次读盘；释放函数在锁内还会再复核一遍
      if (h.keepsProviderEvidence) {
        skippedLegacy += 1;
        continue;
      }
      // requireArchived：名单是前面列的，逐个释放期间用户可能把其中某个取消归档——释放那一刻锁内再复核一次（R15-07）
      const res = await releaseArchivedTaskSessionCache(
        { id: h.id, mode: h.mode, sessionAgentId: h.sessionAgentId },
        { requireArchived: true },
      );
      if (res.status === "released") {
        released += 1;
        piBytesFreed += res.piBytes;
      } else if (res.status === "busy") skippedBusy += 1;
      else if (res.status === "legacy") skippedLegacy += 1;
      else if (res.status === "kept") skippedKept += 1;
    }

    // 孤儿文件放在上一步之后重新数：已归档任务名下刚删掉的不会重复算
    const orphans = await listOrphanPiSessionFiles();
    let orphanFilesDeleted = 0;
    let orphanBytesFreed = 0;
    for (const o of orphans ?? []) {
      const freed = await deletePiSessionFile(o.file);
      if (freed > 0 || o.bytes === 0) {
        orphanFilesDeleted += 1;
        orphanBytesFreed += freed;
      }
    }

    const gcTriggered = released > 0;
    if (gcTriggered) maybeGcSdkStore();

    const result: CachesCleanupResult = {
      ok: true,
      released,
      skippedBusy,
      skippedKept,
      skippedLegacy,
      piBytesFreed,
      orphanFilesDeleted,
      orphanBytesFreed,
      orphanSkipped: orphans === null,
      gcTriggered,
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/system/storage/caches] failed", err);
    return NextResponse.json({ error: "清理缓存失败" }, { status: 500 });
  } finally {
    inFlight.current = false;
  }
};
