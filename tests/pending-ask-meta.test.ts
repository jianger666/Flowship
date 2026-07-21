/**
 * pendingAskId meta 写清链：registerPendingAsk → 落盘；clear / cancel → 清空
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-pending-ask-meta-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { readMetaV06, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  cancelPendingIf,
  clearPendingAsk,
  registerPendingAsk,
  whenPendingAskMetaSynced,
} = await import("@/lib/server/chat-pending");

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `pending-ask-meta ${id}`,
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
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

let seq = 0;
const alloc = (): string => `pam_${Date.now()}_${seq++}`;

afterEach(async () => {
  // 等可能仍在飞的 sync 落完，避免 afterAll rm 踩并发写
  await new Promise((r) => setTimeout(r, 20));
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("pendingAskId meta 写清链", () => {
  it("registerPendingAsk → meta.pendingAskId 有值", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    registerPendingAsk(id, {
      askId: "ask_reg_1",
      questions: [{ id: "q1", question: "吗？", allowText: true }],
    });
    await whenPendingAskMetaSynced(id);
    const meta = await readMetaV06(id);
    expect(meta?.pendingAskId).toBe("ask_reg_1");
  });

  it("clearPendingAsk → meta.pendingAskId 清空", async () => {
    const id = alloc();
    await writeMeta({ ...makeMeta(id), pendingAskId: "ask_old" });
    registerPendingAsk(id, {
      askId: "ask_clr_1",
      questions: [{ id: "q1", question: "吗？", allowText: true }],
    });
    await whenPendingAskMetaSynced(id);
    expect((await readMetaV06(id))?.pendingAskId).toBe("ask_clr_1");

    clearPendingAsk(id);
    await whenPendingAskMetaSynced(id);
    const meta = await readMetaV06(id);
    expect(meta?.pendingAskId).toBeUndefined();
  });

  it("cancelPendingIf 匹配 → meta 清空；不匹配不动盘上 askId", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    registerPendingAsk(id, {
      askId: "ask_a",
      questions: [{ id: "q1", question: "A?", allowText: true }],
    });
    await whenPendingAskMetaSynced(id);
    registerPendingAsk(id, {
      askId: "ask_b",
      questions: [{ id: "q1", question: "B?", allowText: true }],
    });
    await whenPendingAskMetaSynced(id);
    expect((await readMetaV06(id))?.pendingAskId).toBe("ask_b");

    expect(cancelPendingIf(id, "ask_a")).toBe(false);
    // 未删内存 → 不应另起 sync；盘上仍是 B
    expect((await readMetaV06(id))?.pendingAskId).toBe("ask_b");

    expect(cancelPendingIf(id, "ask_b")).toBe(true);
    await whenPendingAskMetaSynced(id);
    expect((await readMetaV06(id))?.pendingAskId).toBeUndefined();
  });
});
