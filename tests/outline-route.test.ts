/**
 * GET /api/tasks/[id]/outline（提问时间线的大纲接口）：
 *   1. 可读任务 → 200 { items, truncated }：只含属主可见的 user_reply / action_start，时间正序；
 *   2. 不存在的任务 → 404（走 taskVisibilityErrorResponse，与 events 路由同一套 404 / 410 / 503 口径）；
 *   3. 已删除（tombstone）的任务不返回大纲——它的 events.jsonl 可能还在盘上，但对外不可见；
 *   4. 读取完成后任务才被删（扫盘期间）→ 不把已删任务的大纲交出去（扫完复查）；
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-outline-route-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({ Agent: { create: vi.fn(), resume: vi.fn() } }));

const { appendEventLine, newEventId, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { listTasks, writeDeleteTombstone } = await import("@/lib/server/task-fs");
const { clearEventsOutlineCache } = await import("@/lib/server/events-outline");
const { setFailpoint, clearFailpoints } = await import("@/lib/server/failpoints");
const { GET } = await import("@/app/api/tasks/[id]/outline/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`outline-route DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

// 与既有 ownership 测试同一做法：先让 listTasks 走完启动恢复，再把恢复标记置成「已完成」
await listTasks();
(globalThis as unknown as Record<string, Promise<void>>).__flowshipBootRecoveryPromiseV2__ =
  Promise.resolve();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const made: string[] = [];
afterEach(async () => {
  clearFailpoints();
  clearEventsOutlineCache();
  for (const id of made.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `outline ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const mkEv = (
  kind: TaskEvent["kind"],
  text: string,
  meta?: Record<string, unknown>,
): TaskEvent => ({
  id: newEventId(),
  ts: Date.now(),
  kind,
  text,
  ...(meta ? { meta } : {}),
});

const seedTask = async (): Promise<{ id: string; ids: string[] }> => {
  const id = `t_outline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  made.push(id);
  await fs.mkdir(taskDir(id), { recursive: true });
  await writeMeta(makeMeta(id));
  const u1 = mkEv("user_reply", "第一问");
  const a1 = mkEv("action_start", "开始 Plan（plan）n=1");
  const u2 = mkEv("user_reply", "第二问");
  await appendEventLine(id, mkEv("info", "boot"));
  await appendEventLine(id, u1);
  await appendEventLine(id, mkEv("assistant_message", "答"));
  await appendEventLine(id, mkEv("user_reply", "陌生人", { source: "feishu_group", restrictedRunTag: "r1" }));
  await appendEventLine(id, a1);
  await appendEventLine(id, u2);
  return { id, ids: [u1.id, a1.id, u2.id] };
};

const call = (id: string) =>
  GET(new Request(`http://localhost/api/tasks/${id}/outline`), {
    params: Promise.resolve({ id }),
  });

describe("GET /api/tasks/[id]/outline", () => {
  it("可读任务：200，只含属主可见的提问 / action 开始，时间正序", async () => {
    const { id, ids } = await seedTask();
    const res = await call(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; kind: string; text: string }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items.map((i) => i.id)).toEqual(ids);
    expect(body.items.map((i) => i.text)).toEqual(["第一问", "开始 Plan", "第二问"]);
  });

  it("追加新提问后再取：含新项（增量缓存不吞新内容）", async () => {
    const { id, ids } = await seedTask();
    await call(id);
    const u3 = mkEv("user_reply", "第三问");
    await appendEventLine(id, u3);
    const body = (await (await call(id)).json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([...ids, u3.id]);
  });

  it("不存在的任务：404", async () => {
    const res = await call("t_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("已删除（tombstone）的任务：不返回大纲", async () => {
    const { id } = await seedTask();
    await writeDeleteTombstone(id);
    const res = await call(id);
    expect([404, 410]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("第一问");
  });

  it("扫盘期间任务被删：扫完复查，不把已删任务的大纲交出去", async () => {
    const { id } = await seedTask();
    setFailpoint("getTaskEventsOutline.afterRead", async () => {
      await writeDeleteTombstone(id);
    });
    const res = await call(id);
    expect([404, 410]).toContain(res.status);
    expect(await res.text()).not.toContain("第一问");
  });
});
