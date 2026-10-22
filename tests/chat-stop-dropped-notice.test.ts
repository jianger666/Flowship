/**
 * Q6-02 + Q6-04：chat 点「停止」时，排队里还没发出去的消息要像 task 一样留一张「未送达」卡。
 *
 * 此前：stop-task 的 chat 分支 `failQueuedItems(id,{reason:"stopped"})` 返回值被丢弃，
 * `noticeTalkQueueDropped` 对 chat 空队什么也不写——排的话静默消失、事后无记录（事件流里只有「用户停止了对话」）；
 * 纯图片 / 文件的排队条更糟：就算落了卡，也只有一行、看不出丢了什么。
 *
 * 这里不 mock 队列与事件落盘：真实 `stopTaskAgent` + 临时 FLOWSHIP_DATA_DIR + 真实 chat 队列，
 * 排队多条（含一条纯图片）→ 停止 → 读真实 events.jsonl。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-stop-dropped-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));

const { readEvents, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { droppedNoticeTitle, extractDroppedTexts } = await import(
  "@/lib/chat-stream-display"
);
const { extractDroppedAttachments } = await import("@/lib/dropped-queue-notice");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { enqueueChatMessage, getChatQueueCount } = await import(
  "@/lib/server/chat-queue"
);
const { __resetTaskTalkQueueForTest, enqueueTalkMessage } = await import(
  "@/lib/server/task-talk-queue"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-stop-dropped-notice DATA_DIR 未隔离：${taskDir("probe")}`);
}

// 跳过 boot 恢复：别让它扫到别的测试的残留
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
await listTasks();
(globalThis as unknown as Record<string, Promise<void> | undefined>)[RECOVERY_FLAG] =
  Promise.resolve();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const makeMeta = (id: string, over: Partial<TaskMetaV06> = {}): TaskMetaV06 =>
  ({
    id,
    title: `chat-stop-dropped ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }) as unknown as TaskMetaV06;

const ids: string[] = [];
const alloc = (): string => {
  const id = `t_chatstop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};

beforeEach(() => {
  __resetTaskTalkQueueForTest();
});
afterEach(async () => {
  __resetTaskTalkQueueForTest();
  for (const id of ids.splice(0)) {
    clearChatGate(id);
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const enqueue = (
  id: string,
  itemId: string,
  text: string,
  extra: Record<string, unknown> = {},
) =>
  enqueueChatMessage(id, {
    agentText: text,
    displayText: text,
    enqueuedAt: Date.now(),
    itemId,
    ...extra,
  } as never);

const stopAndRead = async (id: string) => {
  const task = (await getTask(id))!;
  await stopTaskAgent(task);
  return readEvents(id);
};

describe("chat 停止 → 排队消息落「未送达」卡（Q6-02 / Q6-04）", () => {
  it("排 3 条（含 1 条纯图片）→ 停止 → 在「用户停止了」之后落一张卡：全部原文 + 图片占位，一条不丢", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    expect(enqueue(id, "cq_u1", "第一条：帮我看下这个报错\n第二行").ok).toBe(true);
    expect(
      enqueue(id, "cq_img", "", {
        imageAbsPaths: ["/tmp/a.png", "/tmp/b.png"],
        savedImages: [{}, {}],
      }).ok,
    ).toBe(true);
    expect(enqueue(id, "cq_u3", "第三条：顺便更新 README").ok).toBe(true);
    expect(getChatQueueCount(id)).toBe(3);

    const evs = await stopAndRead(id);

    expect(getChatQueueCount(id)).toBe(0);
    const stopIdx = evs.findIndex((e) => e.kind === "info" && e.meta?.stopped === true);
    const dropIdx = evs.findIndex(
      (e) => e.kind === "info" && /未送达/.test(e.text ?? ""),
    );
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(stopIdx);
    const ev = evs[dropIdx]!;
    // 卡的标题：3 条（含纯图片那条）
    expect(droppedNoticeTitle(ev.text)).toBe("已停止，3 条排队消息未送达、请重新发送");
    // 全部原文完整保留（含换行）、顺序不变
    expect(extractDroppedTexts(ev.meta)).toEqual([
      "第一条：帮我看下这个报错\n第二行",
      "第三条：顺便更新 README",
    ]);
    // 纯图片条：占位而不是丢掉
    expect(extractDroppedAttachments(ev.meta)).toEqual(["一条只有 2 张图片、没有文字"]);
    expect(ev.text).toContain("只有 2 张图片");
    // 图片路径 / 内容绝不进事件
    expect(JSON.stringify(ev)).not.toContain("/tmp/a.png");
  });

  it("带文字又带文件的条：文字进 droppedTexts，附件占位说明指向第几条", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    enqueue(id, "cq_a", "只有文字");
    enqueue(id, "cq_b", "看下这份文档", {
      attachmentAbsPaths: ["/tmp/doc.pdf"],
      attachmentMetas: [{}],
    });

    const evs = await stopAndRead(id);
    const ev = evs.find((e) => e.kind === "info" && /未送达/.test(e.text ?? ""))!;
    expect(extractDroppedTexts(ev.meta)).toEqual(["只有文字", "看下这份文档"]);
    expect(extractDroppedAttachments(ev.meta)).toEqual(["第 2 条附带 1 个文件"]);
    expect(ev.text).toContain("（附 1 个文件）");
  });

  it("全是纯图片 / 文件条：仍然是一张卡（不退回一行灰字）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    enqueue(id, "cq_i1", "", { imageAbsPaths: ["/tmp/x.png"], savedImages: [{}] });
    enqueue(id, "cq_f1", "", {
      imageAbsPaths: ["/tmp/y.png"],
      savedImages: [{}],
      attachmentAbsPaths: ["/tmp/z.txt"],
      attachmentMetas: [{}],
    });

    const evs = await stopAndRead(id);
    const ev = evs.find((e) => e.kind === "info" && /未送达/.test(e.text ?? ""))!;
    expect(ev).toBeTruthy();
    expect(extractDroppedTexts(ev.meta)).toEqual([]);
    expect(extractDroppedAttachments(ev.meta)).toEqual([
      "一条只有 1 张图片、没有文字",
      "一条只有 1 张图片、1 个文件、没有文字",
    ]);
  });

  it("定时样板项继续被剔除：不进卡、不算进条数（第三轮 R2-02）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    enqueue(id, "cq_u1", "用户的话");
    enqueue(id, "sch_s1.1.1", "[SCHEDULE_FIRED id=s1] 定时触发了");

    const evs = await stopAndRead(id);
    const ev = evs.find((e) => e.kind === "info" && /未送达/.test(e.text ?? ""))!;
    expect(droppedNoticeTitle(ev.text)).toBe("已停止，1 条排队消息未送达、请重新发送");
    expect(extractDroppedTexts(ev.meta)).toEqual(["用户的话"]);
    expect(JSON.stringify(evs)).not.toContain("SCHEDULE_FIRED");
  });

  it("只有定时样板：什么「未送达」都不写（那条的去向由 schedule-queue-loss 另报）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    enqueue(id, "sch_s2.1.1", "[SCHEDULE_FIRED id=s2] 定时触发了");

    const evs = await stopAndRead(id);
    expect(evs.some((e) => /未送达/.test(e.text ?? ""))).toBe(false);
  });

  it("空队停止：不写「未送达」（不制造空提示）；停止事件照常写（旧行为不变）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    const evs = await stopAndRead(id);
    expect(evs.some((e) => /未送达/.test(e.text ?? ""))).toBe(false);
    expect(evs.some((e) => e.kind === "info" && e.meta?.stopped === true)).toBe(true);
  });

  it("task 模式回归：app 输入条（含纯图片）停止后同样落带占位的卡；群来源保留不被清", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, { mode: "task" }));
    const base = { options: {}, senderName: "t" };
    enqueueTalkMessage(id, {
      ...base,
      source: "app",
      rawBody: { text: "task 排队的话" },
      clientItemId: "c1",
    });
    enqueueTalkMessage(id, {
      ...base,
      source: "app",
      rawBody: { text: "", images: [{ data: "x" }] },
      clientItemId: "c2",
    });

    const evs = await stopAndRead(id);
    const ev = evs.find((e) => e.kind === "info" && /未送达/.test(e.text ?? ""))!;
    expect(droppedNoticeTitle(ev.text)).toBe("已停止，2 条排队消息未送达、请重新发送");
    expect(extractDroppedTexts(ev.meta)).toEqual(["task 排队的话"]);
    expect(extractDroppedAttachments(ev.meta)).toEqual(["一条只有 1 张图片、没有文字"]);
  });
});
