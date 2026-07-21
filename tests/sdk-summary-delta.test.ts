/**
 * SDK in-place summarization onDelta → info 事件
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-sdk-summary-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, taskDir, writeMeta } = taskFsCore;
const { createSdkSummaryDeltaPublisher } = await import(
  "@/lib/server/shell-output-bridge"
);

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: "sdk summary",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const seedTask = async (id: string): Promise<void> => {
  await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(id));
};

beforeEach(async () => {
  // 各用例独立 taskId，避免事件文件互相污染
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("createSdkSummaryDeltaPublisher", () => {
  it("summary-completed → 落 info（meta.kind=sdk_summary + summaryChars）", async () => {
    const taskId = "t_1700000001501_sdk_summary_ok";
    await seedTask(taskId);
    const onDelta = createSdkSummaryDeltaPublisher(taskId, () => true);
    onDelta({ update: { type: "summary-started" } });
    onDelta({ update: { type: "summary", summary: "hello-summary-text" } });
    onDelta({ update: { type: "summary-completed" } });

    await vi.waitFor(
      async () => {
        const events = await readEvents(taskId);
        const hit = events.find(
          (e) => e.kind === "info" && e.meta?.kind === "sdk_summary",
        );
        expect(hit).toBeTruthy();
        expect(hit!.text).toBe("上下文过长，SDK 已自动压缩会话");
        expect(hit!.meta?.summaryChars).toBe("hello-summary-text".length);
      },
      { timeout: 3_000, interval: 20 },
    );
  });

  it("失主 lease → 不写事件", async () => {
    const taskId = "t_1700000001502_sdk_summary_lease";
    await seedTask(taskId);
    const onDelta = createSdkSummaryDeltaPublisher(taskId, () => false);
    onDelta({ update: { type: "summary", summary: "x".repeat(40) } });
    onDelta({ update: { type: "summary-completed" } });
    await new Promise((r) => setTimeout(r, 120));
    const events = await readEvents(taskId);
    expect(
      events.some((e) => e.kind === "info" && e.meta?.kind === "sdk_summary"),
    ).toBe(false);
  });
});
