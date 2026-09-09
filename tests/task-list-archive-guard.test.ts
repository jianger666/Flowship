/**
 * 归档乐观更新守卫（review：归档新路不能裸奔，旧快照不得闪掉乐观态）。
 * 纯函数用例；hook 接线（mark/unmark/upsert/refresh）与之一一对应。
 * 方向感知：归档窗口只收 true，恢复窗口只收非 true。
 */
import { describe, expect, it } from "vitest";

import {
  applyPendingArchives,
  shouldRejectArchiveSnapshot,
} from "@/lib/task-list-refresh";
import type { TaskSummary } from "@/lib/types";

const row = (over: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: "t1",
    title: "t",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: 1,
    createdAt: 1,
    repoPaths: [],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    ...over,
  }) as TaskSummary;

const archivePending = (id = "t1") => new Map([[id, true]]);
const unarchivePending = (id = "t1") => new Map([[id, false]]);

describe("shouldRejectArchiveSnapshot", () => {
  it("归档窗口：旧快照拒收，已提交态放行", () => {
    const pending = archivePending();
    // 服务端还没写完的旧快照（轮询/SSE）：拒
    expect(shouldRejectArchiveSnapshot("t1", false, pending)).toBe(true);
    expect(shouldRejectArchiveSnapshot("t1", undefined, pending)).toBe(true);
    // 服务端写完的新快照：放行（其它新字段要落地）
    expect(shouldRejectArchiveSnapshot("t1", true, pending)).toBe(false);
    // 没标记的不管
    expect(shouldRejectArchiveSnapshot("t2", false, pending)).toBe(false);
    expect(shouldRejectArchiveSnapshot("t1", false, new Map())).toBe(false);
  });

  it("恢复窗口：旧快照（archived:true）拒收，非 true 放行", () => {
    const pending = unarchivePending();
    expect(shouldRejectArchiveSnapshot("t1", true, pending)).toBe(true);
    expect(shouldRejectArchiveSnapshot("t1", false, pending)).toBe(false);
    expect(shouldRejectArchiveSnapshot("t1", undefined, pending)).toBe(false);
  });
});

describe("applyPendingArchives", () => {
  it("空集原样返回（不分配新数组）", () => {
    const list = [row()];
    expect(applyPendingArchives(list, new Map())).toBe(list);
  });

  it("归档窗口：旧快照强制已归档、其它字段取服务端最新", () => {
    const out = applyPendingArchives(
      [row({ id: "t1", archived: false, title: "new-title" }), row({ id: "t2" })],
      archivePending(),
    );
    expect(out[0]).toMatchObject({ archived: true, title: "new-title" });
    expect(out[1]).not.toHaveProperty("archived");
  });

  it("恢复窗口：旧快照（archived:true）强制去掉归档位", () => {
    const out = applyPendingArchives(
      [row({ id: "t1", archived: true })],
      unarchivePending(),
    );
    expect(out[0].archived).not.toBe(true);
  });
});
