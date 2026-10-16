/**
 * task 待送达队列的两个 HTTP 入口：
 * - POST /api/tasks/[id]/question：queueIfBusy / clientItemId 只认严格值并透传成 source=app
 * - GET / DELETE /api/tasks/[id]/talk-queue：快照 + 按 id 删除（含群提问 group_question）
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-talk-q-route-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

// 显式给 mock 签名：下面要读 mock.calls[n][2]（第三参 = 透传的 options），
// 实现体不用入参，写成 `(..._args)` 会触发 no-unused-vars warning
const mockInject = vi.fn<(...args: unknown[]) => Promise<Response>>(
  async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
);
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: (...args: unknown[]) => mockInject(...args),
}));

const { writeMeta } = await import("@/lib/server/task-fs-core");
const { enqueueGroupQuestion } = await import(
  "@/lib/server/feishu-bridge/group-shared"
);
const {
  __resetTaskTalkQueueForTest,
  buildTalkQueueSnapshot,
  enqueueTalkMessage,
} = await import("@/lib/server/task-talk-queue");
const questionRoute = await import("@/app/api/tasks/[id]/question/route");
const talkQueueRoute = await import("@/app/api/tasks/[id]/talk-queue/route");

const TASK_ID = "route_tq1";

const mkTask = async (): Promise<void> => {
  await writeMeta({
    id: TASK_ID,
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

const ctx = { params: Promise.resolve({ id: TASK_ID }) };
const post = (body: unknown) =>
  questionRoute.POST(
    new Request("http://x/api/tasks/route_tq1/question", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    ctx,
  );
const del = (body: unknown) =>
  talkQueueRoute.DELETE(
    new Request("http://x/api/tasks/route_tq1/talk-queue", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
    ctx,
  );

afterEach(() => {
  __resetTaskTalkQueueForTest();
  mockInject.mockClear();
});

describe("POST /question 的 queueIfBusy 透传", () => {
  it("queueIfBusy:true + clientItemId → source=app 且带幂等键", async () => {
    await post({ text: "hi", queueIfBusy: true, clientItemId: "  c1 " });
    expect(mockInject.mock.calls[0]?.[2]).toEqual({
      queueIfBusy: { source: "app", clientItemId: "c1" },
    });
  });

  it("没传 / 非严格 true（如字符串）→ 不排队，仍走原 409 语义", async () => {
    await post({ text: "hi" });
    await post({ text: "hi", queueIfBusy: "true" });
    expect(mockInject.mock.calls[0]?.[2]).toEqual({});
    expect(mockInject.mock.calls[1]?.[2]).toEqual({});
  });

  it("body 是 JSON null 也不炸", async () => {
    const res = await post(null);
    expect(res.status).toBe(200);
    expect(mockInject.mock.calls[0]?.[2]).toEqual({});
  });
});

describe("GET / DELETE /talk-queue", () => {
  it("任务不存在 → 404", async () => {
    const res = await talkQueueRoute.GET(
      new Request("http://x"),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(404);
  });

  it("GET 返回合并快照；DELETE 能删本模块条目与群提问，删不到的不报成功", async () => {
    await mkTask();
    const r = enqueueTalkMessage(TASK_ID, {
      source: "app",
      rawBody: { text: "我的" },
      options: {},
    });
    if (!r.ok) throw new Error("应入队");
    enqueueGroupQuestion(TASK_ID, {
      messageId: "om_gq_route",
      chatId: "oc",
      text: "同事问",
      parsed: { text: "同事问", images: [], attachments: [] },
      requester: { openId: "ou_x", name: "张三" },
      boot: { apiKey: "k", model: { id: "m" } },
    });

    const got = (await (
      await talkQueueRoute.GET(new Request("http://x"), ctx)
    ).json()) as { items: Array<{ id: string; source: string }> };
    expect(got.items.map((i) => i.source).sort()).toEqual([
      "app",
      "group_question",
    ]);

    const res = await del({ itemIds: [r.itemId, "om_gq_route", "ghost"] });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { removedIds: string[] }).removedIds.sort(),
    ).toEqual([r.itemId, "om_gq_route"].sort());
    expect(buildTalkQueueSnapshot(TASK_ID)).toHaveLength(0);
  });

  it("DELETE 入参校验：非数组 / 空数组 / 非 JSON → 400", async () => {
    await mkTask();
    expect((await del({ itemIds: "x" })).status).toBe(400);
    expect((await del({ itemIds: [] })).status).toBe(400);
    const bad = await talkQueueRoute.DELETE(
      new Request("http://x", { method: "DELETE", body: "not json" }),
      ctx,
    );
    expect(bad.status).toBe(400);
  });
});
