/**
 * 粘贴超长文本 → 附件：阈值判定 + paste-text route 校验分支
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

import {
  PASTE_TEXT_CHAR_THRESHOLD,
  PASTE_TEXT_LINE_THRESHOLD,
  PASTE_TEXT_MAX_BYTES,
  shouldConvertPasteToAttachment,
} from "@/lib/paste-text-attach";

describe("shouldConvertPasteToAttachment", () => {
  it("空串 / 短文本不转", () => {
    expect(shouldConvertPasteToAttachment("")).toBe(false);
    expect(shouldConvertPasteToAttachment("hello")).toBe(false);
    expect(
      shouldConvertPasteToAttachment("a".repeat(PASTE_TEXT_CHAR_THRESHOLD)),
    ).toBe(false);
  });

  it("字符数超过阈值则转", () => {
    expect(
      shouldConvertPasteToAttachment(
        "a".repeat(PASTE_TEXT_CHAR_THRESHOLD + 1),
      ),
    ).toBe(true);
  });

  it("行数超过阈值则转（短字符也转）", () => {
    // N 行 = N-1 个换行；阈值 24 → 25 行才转
    const lines = Array.from(
      { length: PASTE_TEXT_LINE_THRESHOLD + 1 },
      (_, i) => `L${i}`,
    ).join("\n");
    expect(lines.split("\n").length).toBe(PASTE_TEXT_LINE_THRESHOLD + 1);
    expect(shouldConvertPasteToAttachment(lines)).toBe(true);
  });

  it("刚好 24 行不转", () => {
    const lines = Array.from(
      { length: PASTE_TEXT_LINE_THRESHOLD },
      (_, i) => `L${i}`,
    ).join("\n");
    expect(lines.split("\n").length).toBe(PASTE_TEXT_LINE_THRESHOLD);
    expect(shouldConvertPasteToAttachment(lines)).toBe(false);
  });
});

// ---- route：隔离 DATA_DIR 后再动态 import（与 save-image-attachments-u4 同款）----

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-paste-text-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { savePastedTextAttachment } = await import(
  "@/lib/server/task-artifacts"
);
const { clearChatGate } = await import("@/lib/server/chat-gate");

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
}));

const { getTask } = await import("@/lib/server/task-fs");
const { POST } = await import("@/app/api/tasks/[id]/paste-text/route");

const getTaskMock = vi.mocked(getTask);

const TASK_ID = "t_1700000003300_paste_text";

const makeMeta = (id: string) => ({
  id,
  title: "paste-text 单测",
  repoStatus: "developing" as const,
  runStatus: "idle" as const,
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

const callPost = async (
  id: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const req = new Request(`http://local/api/tasks/${id}/paste-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
};

beforeEach(async () => {
  clearChatGate(TASK_ID);
  getTaskMock.mockReset();
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

describe("POST /api/tasks/[id]/paste-text", () => {
  it("task 不存在 → 404", async () => {
    getTaskMock.mockResolvedValue(null);
    const { status, json } = await callPost(TASK_ID, {
      content: "a".repeat(100),
    });
    expect(status).toBe(404);
    expect(json.error).toBe("not_found");
  });

  it("content 空 / 非字符串 → 400", async () => {
    getTaskMock.mockResolvedValue({ id: TASK_ID } as never);
    expect((await callPost(TASK_ID, { content: "" })).status).toBe(400);
    expect((await callPost(TASK_ID, { content: 1 })).status).toBe(400);
    expect((await callPost(TASK_ID, {})).status).toBe(400);
  });

  it("超 2MB → 413", async () => {
    getTaskMock.mockResolvedValue({ id: TASK_ID } as never);
    // 构造刚好超过上限的 ASCII 串（1 字符 = 1 字节）
    const content = "x".repeat(PASTE_TEXT_MAX_BYTES + 1);
    const { status, json } = await callPost(TASK_ID, { content });
    expect(status).toBe(413);
    expect(String(json.error)).toMatch(/过大|2 MB/);
  });

  it("正常落盘返回 absPath，且文件可读", async () => {
    getTaskMock.mockResolvedValue({ id: TASK_ID } as never);
    const content = "hello paste\n".repeat(100);
    const { status, json } = await callPost(TASK_ID, { content });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.absPath).toBe("string");
    const absPath = json.absPath as string;
    expect(absPath).toContain(path.join("uploads", "paste-"));
    expect(absPath.endsWith(".txt")).toBe(true);
    const read = await fs.readFile(absPath, "utf8");
    expect(read).toBe(content);
  });
});

describe("savePastedTextAttachment", () => {
  it("直接落盘到 uploads/paste-*.txt", async () => {
    const saved = await savePastedTextAttachment(TASK_ID, "direct body");
    expect(saved.filename).toMatch(/^paste-\d+\.txt$/);
    expect(await fs.readFile(saved.absPath, "utf8")).toBe("direct body");
    expect(saved.bytes).toBe(Buffer.byteLength("direct body", "utf8"));
  });
});
