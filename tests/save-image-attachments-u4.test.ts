/**
 * U4：saveImageAttachments 与 DELETE 互斥 + 失败清理
 *
 * 回归：
 * - 正常路径写 uploads
 * - DELETE 占锁删目录后，排队中的 save 复查失败且不重建任务目录
 * - lifecycle=deleting 拒绝写入；end 后恢复可写
 * - 写盘中途失败时清理本次已写入文件
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉
 * FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-save-img-u4-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { taskDir, withTaskLock, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { saveImageAttachments } = await import("@/lib/server/task-artifacts");
const {
  beginChatLifecycle,
  clearChatGate,
  endChatLifecycle,
} = await import("@/lib/server/chat-gate");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`save-img-u4 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_1700000002200_save_img_u4";

/** 1×1 透明 PNG（合法 image/png） */
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const makeMeta = (id: string): TaskMetaV06 => ({
  id,
  title: "U4 附件单测",
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: ["/tmp/fake-repo"],
  createdAt: 1_000,
  updatedAt: 1_000,
});

const seedTask = async (): Promise<void> => {
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });
  await writeMeta(makeMeta(TASK_ID));
};

const pngInput = (filename?: string) => ({
  data: PNG_1X1_B64,
  mimeType: "image/png",
  filename,
});

beforeEach(async () => {
  clearChatGate(TASK_ID);
  await seedTask();
});

afterEach(() => {
  clearChatGate(TASK_ID);
  vi.restoreAllMocks();
});

afterAll(async () => {
  clearChatGate(TASK_ID);
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("saveImageAttachments U4", () => {
  it("正常路径：两张合法 png 落盘并返回两条", async () => {
    const saved = await saveImageAttachments(TASK_ID, [
      pngInput("a.png"),
      pngInput("b.png"),
    ]);
    expect(saved).toHaveLength(2);
    for (const s of saved) {
      expect(s.mimeType).toBe("image/png");
      expect(s.bytes).toBeGreaterThan(0);
      await expect(fs.stat(s.absPath)).resolves.toBeTruthy();
    }
  });

  it("U4 核心时序：DELETE 占锁删目录后，save 拒绝且不重建任务目录", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let heldResolve!: () => void;
    const held = new Promise<void>((resolve) => {
      heldResolve = resolve;
    });

    // 模拟 deleteTask：持锁 → 等并发 save 排队 → 删 meta+目录 → 放锁
    const deletePromise = withTaskLock(TASK_ID, async () => {
      heldResolve();
      await gate;
      await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });
    });

    await held;

    const savePromise = saveImageAttachments(TASK_ID, [
      pngInput("race.png"),
    ]);
    // 让 save 进入 withTaskLock 等待队列（校验已在锁外做完）
    await new Promise((r) => setTimeout(r, 20));

    releaseGate();
    await expect(savePromise).rejects.toThrow(/不存在或已删除/);
    await deletePromise;

    await expect(fs.stat(taskDir(TASK_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lifecycle deleting：拒绝写入；end 后恢复可写", async () => {
    beginChatLifecycle(TASK_ID, "deleting");
    await expect(
      saveImageAttachments(TASK_ID, [pngInput("blocked.png")]),
    ).rejects.toThrow(/正在删除/);

    endChatLifecycle(TASK_ID, "deleting");
    const saved = await saveImageAttachments(TASK_ID, [
      pngInput("ok.png"),
    ]);
    expect(saved).toHaveLength(1);
    await expect(fs.stat(saved[0]!.absPath)).resolves.toBeTruthy();
  });

  it("写盘中途失败：清理本次已写入文件、无残留", async () => {
    const realWriteFile = fs.writeFile.bind(fs);
    let writeCount = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("模拟第二次写盘失败");
      }
      return realWriteFile(file, data, options);
    });

    await expect(
      saveImageAttachments(TASK_ID, [
        pngInput("first.png"),
        pngInput("second.png"),
      ]),
    ).rejects.toThrow(/模拟第二次写盘失败/);

    const uploadsDir = path.join(taskDir(TASK_ID), "uploads");
    // mkdir 可能已建目录，但本次调用写入的文件必须被清掉
    const entries = await fs.readdir(uploadsDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[];
      throw err;
    });
    expect(entries).toEqual([]);
  });
});
