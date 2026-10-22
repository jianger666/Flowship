/**
 * D8-04：task 页排队的话被丢（重放失败 / 过期 / 停止清队）时，事件流要落一条带完整原文的「未送达」事件。
 *
 * 此前：chat 的清队（chat-runner.noticeQueuedItemsDropped）有 `meta.droppedTexts`，前端 `DroppedQueueCard` 也早已在
 * chat / log 两形态共用；task 侧却只有两种结局——
 *   - drain 丢弃：一条 80 字摘要、无 meta 的灰色细线（长消息原话找不回来）；
 *   - 用户点停止清 app 输入条：`clearTalkQueue` 只发 SSE 快照、**不落任何事件**，排的话悄悄没了。
 * 本测试锁住服务端这一半：丢弃时事件带 `droppedTexts`（完整文本、已脱敏）+ `droppedItemIds`，
 * 前端读者（extractDroppedTexts / droppedNoticeTitle）对得上；没有文本（纯图片）与外部回执不当「用户的话」。
 * 真实 stopTaskAgent 的接线在 talk-queue-clear-callsites.test.ts。
 */
import { mkdirSync, mkdtempSync, promises as fs } from "node:fs";
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
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-queue-dropped-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;
mkdirSync(DATA_DIR, { recursive: true });

const mockInject = vi.fn();
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: (...args: unknown[]) => mockInject(...args),
}));
vi.mock("@/lib/server/chat-gate", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/server/chat-gate")>();
  return { ...orig, getChatLifecycle: vi.fn(() => null) };
});

const { getEventsLogPath, readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { runningTasks } = await import("@/lib/server/task-stream");
const {
  TALK_QUEUE_TTL_MS,
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  clearTalkQueueCapturing,
  enqueueTalkMessage,
  listTalkQueue,
  noticeTalkQueueDropped,
} = await import("@/lib/server/task-talk-queue");
const { droppedNoticeTitle, extractDroppedTexts } = await import(
  "@/lib/chat-stream-display"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`task-queue-dropped-notice DATA_DIR 未隔离：${taskDir("probe")}`);
}

const FAKE_GIT_TOKEN = "glpat-FAKEtaskQueueDroppedToken0123456789";
const LEAKED_PREFIX = FAKE_GIT_TOKEN.slice(0, 8);

const mkTask = async (id: string): Promise<void> => {
  await writeMeta({
    id,
    title: "t",
    mode: "task",
    runStatus: "idle",
    repoStatus: "developing",
    repoPaths: [],
    actions: [],
    currentActionId: null,
    mrs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
};

let seq = 0;
const freshId = (): string => `tq-dropped-${Date.now()}-${seq++}`;

const resp = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** 等到事件流里出现满足条件的 info（过期丢弃是 fire-and-forget 写盘，没法直接 await） */
const waitInfo = async (
  taskId: string,
  pred: (e: TaskEvent) => boolean,
): Promise<TaskEvent> => {
  const box: { hit?: TaskEvent } = {};
  await vi.waitFor(
    async () => {
      const evs = await readEvents(taskId);
      box.hit = evs.find((e) => e.kind === "info" && pred(e));
      expect(box.hit).toBeTruthy();
    },
    { timeout: 5_000, interval: 25 },
  );
  return box.hit!;
};

const dropInfosOf = async (taskId: string): Promise<TaskEvent[]> =>
  (await readEvents(taskId)).filter(
    (e) => e.kind === "info" && e.text.includes("没送出去"),
  );

const LONG_TEXT = `${"需求背景：".repeat(40)}\n第二段：请把这个改动拆成两个 MR\n第三段：先别动 CI`;

beforeEach(async () => {
  mockInject.mockReset();
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({ apiKey: "k", gitToken: FAKE_GIT_TOKEN }),
    "utf-8",
  );
});

afterEach(() => {
  vi.useRealTimers();
  __resetTaskTalkQueueForTest();
  runningTasks.clear();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("drain 丢弃：事件带完整原文，卡片读得到", () => {
  it("重放遇非忙错误：info 的 meta.droppedTexts 是未截断的完整原文（含换行），标题只含原因", async () => {
    const taskId = freshId();
    await mkTask(taskId);
    const r = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: LONG_TEXT },
      options: {},
    });
    expect(r.ok).toBe(true);
    mockInject.mockResolvedValueOnce(resp(404, "not_found"));

    await __tickTalkQueueDrainForTest(taskId);

    const [ev] = await dropInfosOf(taskId);
    expect(ev).toBeTruthy();
    expect(extractDroppedTexts(ev!.meta)).toEqual([LONG_TEXT]);
    expect(ev!.meta?.droppedItemIds).toEqual([r.ok ? r.itemId : "?"]);
    // 卡片标题 = 首行（去尾冒号）：只说原因，不再把 80 字摘要塞进标题里跟下面的完整原文重复
    expect(droppedNoticeTitle(ev!.text)).toBe("排队的消息没送出去：not_found");
    // 摘要列表仍在正文里（不渲染卡片的地方 / 搜索 / 老前端仍然看得到去向）
    expect(ev!.text).toContain("\n- 需求背景：");
  });

  it("过期（TTL）丢弃：同样带完整原文", async () => {
    const taskId = freshId();
    await mkTask(taskId);
    // 只冻结 Date：waitInfo 里的轮询要靠真实定时器
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    vi.setSystemTime(now);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: LONG_TEXT },
      options: {},
    });
    vi.setSystemTime(now + TALK_QUEUE_TTL_MS + 1000);

    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId)).toHaveLength(0);

    const ev = await waitInfo(taskId, (e) => e.text.includes("没送出去"));
    expect(extractDroppedTexts(ev.meta)).toEqual([LONG_TEXT]);
    expect(droppedNoticeTitle(ev.text)).toBe(
      "排队的消息没送出去：排队超过 30 分钟已过期",
    );
  });

  it("纯图片（拿不到文本）：不带 meta、保留原来的单行摘要——不画空卡", async () => {
    const taskId = freshId();
    await mkTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "", images: [{ mime: "image/png", data: "AAAA" }] },
      options: {},
    });
    mockInject.mockResolvedValueOnce(resp(404, "not_found"));

    await __tickTalkQueueDrainForTest(taskId);

    const [ev] = await dropInfosOf(taskId);
    expect(ev).toBeTruthy();
    expect(ev!.meta?.droppedTexts).toBeUndefined();
    expect(extractDroppedTexts(ev!.meta)).toEqual([]);
    expect(ev!.text).toContain("附图片");
  });

  it("群托办回执（外部机器人的话）丢弃：不把它当「用户的话」存进 droppedTexts", async () => {
    const taskId = freshId();
    await mkTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "group_reply",
      rawBody: { text: "外部机器人回执：已处理完毕" },
      options: {},
    });
    // 无会话 → 重放前判定「会话已断开」直接丢弃（不走 inject）

    await __tickTalkQueueDrainForTest(taskId);

    expect(mockInject).not.toHaveBeenCalled();
    const [ev] = await dropInfosOf(taskId);
    expect(ev).toBeTruthy();
    expect(ev!.meta?.droppedTexts).toBeUndefined();
    expect(ev!.text).toContain("会话已断开");
  });

  it("凭据横跨 80 字摘要截断点：先脱敏再截断，前缀不落盘（正文摘要 + meta 都干净）", async () => {
    const taskId = freshId();
    await mkTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: `${"前".repeat(70)}${FAKE_GIT_TOKEN} 后面还有话` },
      options: {},
    });
    mockInject.mockResolvedValueOnce(resp(404, "not_found"));

    await __tickTalkQueueDrainForTest(taskId);

    const raw = await fs.readFile(getEventsLogPath(taskId), "utf-8");
    expect(raw).not.toContain(LEAKED_PREFIX);
    const [ev] = await dropInfosOf(taskId);
    const texts = extractDroppedTexts(ev!.meta);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("[REDACTED:gitToken]");
    expect(texts[0]).toContain("后面还有话");
  });
});

describe("clearTalkQueueCapturing（用户点停止清 app 输入条）", () => {
  it("清掉的 app 条：返回完整原文（不是 120 字预览）与 itemId；群来源保留、不返回", () => {
    const taskId = freshId();
    const long = `${"很长的一句话".repeat(40)}\n第二行`; // 远超 120 字预览上限
    const a = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: long },
      options: {},
    });
    const img = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "", images: [{ mime: "image/png", data: "AAAA" }] },
      options: {},
    });
    enqueueTalkMessage(taskId, {
      source: "group_owner",
      rawBody: { text: "属主在群里说" },
      options: {},
    });
    enqueueTalkMessage(taskId, {
      source: "group_reply",
      rawBody: { text: "托办回执" },
      options: {},
    });
    expect(a.ok && img.ok).toBe(true);

    const out = clearTalkQueueCapturing(taskId, { onlySources: ["app"] });

    // count = 2；items 含有文本的条 + 纯图片条（只带「1 张图片」文字占位、text 为空，Q6-04）；群来源不进 items
    expect(out.count).toBe(2);
    expect(out.items).toEqual([
      { itemId: a.ok ? a.itemId : "?", text: long },
      { itemId: img.ok ? img.itemId : "?", text: "", attachments: "1 张图片" },
    ]);
    expect(listTalkQueue(taskId).map((e) => e.source)).toEqual([
      "group_owner",
      "group_reply",
    ]);
  });

  it("没有可清的：count 0、items 空", () => {
    expect(clearTalkQueueCapturing(freshId(), { onlySources: ["app"] })).toEqual({
      count: 0,
      items: [],
    });
  });

  it("文本在返回前已脱敏（凭据不会经 stop 的事件落盘）", () => {
    const taskId = freshId();
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: `用 ${FAKE_GIT_TOKEN} 拉代码` },
      options: {},
    });
    const out = clearTalkQueueCapturing(taskId, { onlySources: ["app"] });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.text).toContain("[REDACTED:gitToken]");
    expect(out.items[0]!.text).not.toContain(LEAKED_PREFIX);
  });
});

describe("noticeTalkQueueDropped", () => {
  it("落一条 info：header + 摘要列表 + meta.droppedTexts / droppedItemIds", async () => {
    const taskId = freshId();
    await mkTask(taskId);

    await noticeTalkQueueDropped(taskId, {
      header: "已停止，2 条排队消息未送达、请重新发送",
      count: 2,
      items: [
        { itemId: "tq_a", text: "第一条" },
        { itemId: "tq_b", text: LONG_TEXT },
      ],
    });

    const ev = await waitInfo(taskId, (e) => e.text.includes("条排队消息未送达"));
    expect(droppedNoticeTitle(ev.text)).toBe("已停止，2 条排队消息未送达、请重新发送");
    expect(extractDroppedTexts(ev.meta)).toEqual(["第一条", LONG_TEXT]);
    expect(ev.meta?.droppedItemIds).toEqual(["tq_a", "tq_b"]);
  });

  it("count 为 0 不写事件", async () => {
    const taskId = freshId();
    await mkTask(taskId);
    await noticeTalkQueueDropped(taskId, { header: "H", count: 0, items: [] });
    expect(await readEvents(taskId)).toEqual([]);
  });
});
