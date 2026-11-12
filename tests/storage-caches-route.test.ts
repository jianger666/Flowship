/**
 * /api/system/storage/caches：会话管理页「清理缓存」的服务端（真实 task-fs + 临时数据目录）。
 *
 * 钉：GET 只读且数得对；POST 清已归档任务的会话锚点 + 孤儿 pi 会话文件；未归档任务 / 被引用的文件 / 宽限内的文件不碰；
 * 收尾窗口里的任务跳过；并发第二次 409；清完再点什么都不剩。
 *
 * 诚实声明：Cursor SDK 被 mock，SDK store 的 GC 回收空间不在这里验证（见 sdk-store-gc*.test.ts）；
 * 内存里在忙的 chat 热会话造不出来，「在忙不动」由 session-cache-release.test.ts 用注入的 deps 验证。
 */
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-storage-caches-"));
const DATA = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA;

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
  registerManagedChild: vi.fn(),
}));
// SDK store GC 不在这里跑（它会去扫真实 store 句柄）：只记录有没有被触发
const gcSpy = vi.fn();
vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/sdk-store-gc")>();
  return { ...actual, maybeGcSdkStore: () => gcSpy() };
});

const taskFs = await import("@/lib/server/task-fs");
const { beginChatLifecycle, endChatLifecycle } = await import("@/lib/server/chat-gate");
const route = await import("@/app/api/system/storage/caches/route");

(globalThis as unknown as Record<string, Promise<void> | undefined>)["__flowshipBootRecoveryPromiseV2__"] =
  Promise.resolve();

const PI_DIR = path.join(DATA, "pi-sessions");
mkdirSync(PI_DIR, { recursive: true });

const piFile = (name: string, bytes: number, ageMs = 3 * 3600_000): string => {
  const f = path.join(PI_DIR, name);
  writeFileSync(f, "x".repeat(bytes));
  const t = new Date(Date.now() - ageMs);
  utimesSync(f, t, t);
  return f;
};

let seq = 0;
const mkTask = async (over: {
  mode?: "chat" | "task";
  archived?: boolean;
  anchor?: string;
  /** 缺省 = 新建任务的常态（带 provider）；null = 没有 provider 字段的老任务（评审 R16-03） */
  provider?: string | null;
}): Promise<string> => {
  seq += 1;
  const task = await taskFs.createTask({
    title: `caches #${seq}`,
    repoPaths: [],
    mode: over.mode ?? "chat",
    workRole: "other",
    ...(over.provider === null ? {} : { provider: over.provider ?? "cursor" }),
  });
  if (over.anchor) await taskFs.setTaskSessionAgentId(task.id, over.anchor);
  if (over.archived) await taskFs.setTaskPinArchive(task.id, { archived: true });
  return task.id;
};
const anchorOf = async (id: string): Promise<string | undefined> => (await taskFs.getTaskMeta(id))?.sessionAgentId;

afterAll(async () => {
  const { rmSync } = await import("node:fs");
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("storage/caches", () => {
  // 一次造好全部场景，按顺序走：GET → POST → 再 GET / POST
  const world = (async () => {
    const archivedCursor = await mkTask({ archived: true, anchor: "cursor-uuid-1" });
    const piA = piFile("archived-a.jsonl", 1000);
    const archivedPi = await mkTask({ archived: true, anchor: piA, mode: "task" });
    const piActive = piFile("active.jsonl", 400);
    const active = await mkTask({ anchor: piActive }); // 未归档：绝不能动
    const piOrphan = piFile("orphan.jsonl", 300);
    const piRecent = piFile("recent.jsonl", 200, 1000); // 宽限内
    const closing = await mkTask({ archived: true, anchor: "closing-uuid" }); // 收尾窗口里
    return { archivedCursor, archivedPi, piA, active, piActive, piOrphan, piRecent, closing };
  })();

  it("GET：只读，数出已归档握着锚点的任务 + 孤儿文件（宽限内 / 被引用的不算）", async () => {
    const w = await world;
    const res = await route.GET();
    expect(res.status).toBe(200);
    const s = (await res.json()) as import("@/lib/cache-cleanup-text").CachesSummary;
    expect(s.archivedHolders).toBe(3); // archivedCursor / archivedPi / closing
    expect(s.archivedPiBytes).toBe(1000);
    expect(s.orphanFiles).toBe(1); // 只有 orphan.jsonl（recent 在宽限内、active/archived-a 被引用）
    expect(s.orphanBytes).toBe(300);
    expect(s.orphanSkipped).toBe(false);
    // 只读：什么都没动
    expect(await anchorOf(w.archivedCursor)).toBe("cursor-uuid-1");
    expect(existsSync(w.piOrphan)).toBe(true);
    expect(gcSpy).not.toHaveBeenCalled();
  });

  it("POST：放掉已归档任务的锚点、删它们的会话文件和孤儿文件；未归档 / 宽限内 / 收尾窗口里的不碰；触发 GC", async () => {
    const w = await world;
    expect(beginChatLifecycle(w.closing, "stopping")).toBe(true);
    try {
      const res = await route.POST();
      expect(res.status).toBe(200);
      const r = (await res.json()) as import("@/lib/cache-cleanup-text").CachesCleanupResult;
      expect(r.ok).toBe(true);
      expect(r.released).toBe(2); // archivedCursor + archivedPi
      expect(r.skippedBusy).toBe(1); // closing
      expect(r.piBytesFreed).toBe(1000);
      expect(r.orphanFilesDeleted).toBe(1);
      expect(r.orphanBytesFreed).toBe(300);
      expect(r.gcTriggered).toBe(true);
      expect(gcSpy).toHaveBeenCalledTimes(1);

      expect(await anchorOf(w.archivedCursor)).toBeUndefined();
      expect(await anchorOf(w.archivedPi)).toBeUndefined();
      expect(existsSync(w.piA)).toBe(false);
      expect(existsSync(w.piOrphan)).toBe(false);
      // 不该碰的
      expect(await anchorOf(w.active)).toBe(w.piActive);
      expect(existsSync(w.piActive)).toBe(true);
      expect(existsSync(w.piRecent)).toBe(true);
      expect(await anchorOf(w.closing)).toBe("closing-uuid");
    } finally {
      endChatLifecycle(w.closing, "stopping");
    }
  });

  it("清完再看：只剩收尾窗口里那个（窗口结束后才能清）；再 POST 清掉它，之后什么都不剩、不再触发 GC", async () => {
    const w = await world;
    const s1 = (await (await route.GET()).json()) as import("@/lib/cache-cleanup-text").CachesSummary;
    expect(s1.archivedHolders).toBe(1);
    expect(s1.orphanFiles).toBe(0);

    gcSpy.mockClear();
    const r2 = (await (await route.POST()).json()) as import("@/lib/cache-cleanup-text").CachesCleanupResult;
    expect(r2.released).toBe(1);
    expect(await anchorOf(w.closing)).toBeUndefined();

    gcSpy.mockClear();
    const r3 = (await (await route.POST()).json()) as import("@/lib/cache-cleanup-text").CachesCleanupResult;
    expect(r3).toMatchObject({ released: 0, skippedBusy: 0, orphanFilesDeleted: 0, gcTriggered: false });
    expect(gcSpy).not.toHaveBeenCalled();
  });

  it("并发第二次 POST 直接 409（不会两遍同时抢锚点）", async () => {
    await world;
    const first = route.POST();
    const second = await route.POST();
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });
});

describe("storage/caches：老任务（没有 provider、锚点是自定义形态）保留（评审 R16-03）", () => {
  it("GET 不把它算进「可清理」、单独数 legacyKept；POST 不动它的锚点与会话文件、计入 skippedLegacy、不触发 GC", async () => {
    // 前面的 describe 已把可清理的清干净了；这里重新造一个老任务
    const legacyFile = piFile("legacy-route.jsonl", 123);
    const legacy = await mkTask({ archived: true, anchor: legacyFile, mode: "task", provider: null });
    expect((await taskFs.getTaskMeta(legacy))?.provider).toBeUndefined(); // 前提：真是老任务

    const s = (await (await route.GET()).json()) as import("@/lib/cache-cleanup-text").CachesSummary;
    expect(s.archivedHolders).toBe(0);
    expect(s.legacyKept).toBe(1);
    expect(s.orphanFiles).toBe(0); // 它的文件被引用，不是孤儿

    gcSpy.mockClear();
    const r = (await (await route.POST()).json()) as import("@/lib/cache-cleanup-text").CachesCleanupResult;
    expect(r).toMatchObject({ released: 0, skippedLegacy: 1, orphanFilesDeleted: 0, gcTriggered: false });
    expect(gcSpy).not.toHaveBeenCalled();
    expect(await anchorOf(legacy)).toBe(legacyFile);
    expect(existsSync(legacyFile)).toBe(true);
  });
});
