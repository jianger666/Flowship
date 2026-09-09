/**
 * setTaskPinArchive 落盘语义（review：客户端过滤盖的是展示层，落盘这半零用例）。
 * 锁死三条：动 archived 才 bump updatedAt；恢复用 delete（不是 false）；
 * pinned 用赋值；双字段同请求单锁单写一次落地。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-pin-archive-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { readMetaV06, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { setTaskPinArchive } = await import("@/lib/server/task-fs");

const OLD_TS = Date.now() - 60000;
let seq = 0;
const makeTask = async (over: Record<string, unknown> = {}) => {
  const id = `pa_${Date.now()}_${seq++}`;
  await writeMeta({
    id,
    title: `pin-archive ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: "act_1",
    actions: [
      {
        id: "act_1",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: "actions/1-plan.md",
        startedAt: OLD_TS,
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  } as unknown as TaskMetaV06);
  return id;
};

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("setTaskPinArchive", () => {
  it("归档：archived=true + bump updatedAt", async () => {
    const id = await makeTask();
    const task = await setTaskPinArchive(id, { archived: true });
    expect(task?.archived).toBe(true);
    const raw = await readMetaV06(id);
    expect(raw?.archived).toBe(true);
    expect(raw?.updatedAt ?? 0).toBeGreaterThan(OLD_TS);
  });

  it("恢复：delete 掉 archived（不是置 false）+ bump updatedAt", async () => {
    const id = await makeTask({ archived: true });
    const task = await setTaskPinArchive(id, { archived: false });
    expect(task?.archived).toBeUndefined();
    const raw = await readMetaV06(id);
    // 客户端靠 `archived !== true` / 缺键判定，false 会悄悄改变语义，锁死 delete
    expect(raw && "archived" in raw).toBe(false);
    expect(raw?.updatedAt ?? 0).toBeGreaterThan(OLD_TS);
  });

  it("置顶：赋值 pinned，不 bump updatedAt", async () => {
    const id = await makeTask();
    await setTaskPinArchive(id, { pinned: true });
    const raw = await readMetaV06(id);
    expect(raw?.pinned).toBe(true);
    expect(raw?.updatedAt).toBe(OLD_TS);
    await setTaskPinArchive(id, { pinned: false });
    const raw2 = await readMetaV06(id);
    expect(raw2?.pinned).toBe(false);
  });

  it("双字段同请求一次落地", async () => {
    const id = await makeTask();
    const task = await setTaskPinArchive(id, {
      pinned: true,
      archived: true,
    });
    expect(task?.pinned).toBe(true);
    expect(task?.archived).toBe(true);
  });

  it("任务不存在 → null", async () => {
    expect(await setTaskPinArchive("no-such-task", { archived: true })).toBeNull();
  });
});
