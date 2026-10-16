/**
 * task 模式待送达队列：入队 / 幂等 / 满队 / drain / clear / 快照合并
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-talk-q-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockInject = vi.fn();
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: (...args: unknown[]) => mockInject(...args),
}));
vi.mock("@/lib/server/chat-gate", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/server/chat-gate")>();
  return {
    ...orig,
    getChatLifecycle: vi.fn(() => null),
  };
});

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { runningTasks, subscribeTaskStream } = await import(
  "@/lib/server/task-stream"
);
const { enqueueGroupQuestion } = await import(
  "@/lib/server/feishu-bridge/group-shared"
);
const {
  TALK_QUEUE_MAX,
  TALK_QUEUE_TTL_MS,
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  buildTalkQueueSnapshot,
  clearTalkQueue,
  enqueueTalkMessage,
  listTalkQueue,
  removeTalkQueueItems,
} = await import("@/lib/server/task-talk-queue");
const { readEvents } = await import("@/lib/server/task-fs-core");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`task-talk-queue DATA_DIR 未隔离：${taskDir("probe")}`);
}

const mkTask = async (
  id: string,
  runStatus: "idle" | "running" = "idle",
): Promise<void> => {
  const meta = {
    id,
    title: "t",
    mode: "task",
    runStatus,
    repoStatus: "developing",
    repoPaths: [],
    actions: [
      {
        id: "act_1",
        type: "build",
        status: runStatus === "running" ? "running" : "completed",
        n: 1,
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    ],
    currentActionId: "act_1",
    mrs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06;
  await writeMeta(meta);
};

describe("task-talk-queue 入队", () => {
  afterEach(() => {
    __resetTaskTalkQueueForTest();
    mockInject.mockReset();
  });

  it("FIFO、满队、clientItemId 幂等（id + 正文指纹都相同才算重复）", () => {
    const taskId = "tq-enq-1";
    const r1 = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "a" },
      options: {},
      clientItemId: "c1",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.position).toBe(1);

    // 同 id 同正文（trim 后一致、clientSentAt 这类每次重试都变的字段不参与）= 重试重发 → 重复
    const dup = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: " a ", clientSentAt: 123 },
      options: {},
      clientItemId: "c1",
    });
    expect(dup).toMatchObject({ ok: true, position: 1, duplicate: true });
    expect(dup.ok && dup.itemId).toBe(r1.itemId);

    // 同 id 不同正文 = 另一条消息（K2-04）：老行为是静默当重复吞掉、用户的新内容凭空消失
    const other = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "a2" },
      options: {},
      clientItemId: "c1",
    });
    expect(other).toMatchObject({ ok: true, position: 2 });
    expect(other).not.toHaveProperty("duplicate");
    expect(other.ok && other.itemId).not.toBe(r1.itemId);

    for (let i = 3; i <= TALK_QUEUE_MAX; i++) {
      expect(
        enqueueTalkMessage(taskId, {
          source: "app",
          rawBody: { text: String(i) },
          options: {},
        }).ok,
      ).toBe(true);
    }
    expect(
      enqueueTalkMessage(taskId, {
        source: "app",
        rawBody: { text: "overflow" },
        options: {},
      }),
    ).toEqual({ ok: false, reason: "full" });
    expect(listTalkQueue(taskId)).toHaveLength(TALK_QUEUE_MAX);
  });

  it("clearTalkQueue onlySources=app 保留群来源", () => {
    const taskId = "tq-clear-1";
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "app" },
      options: {},
    });
    enqueueTalkMessage(taskId, {
      source: "group_owner",
      rawBody: { text: "群" },
      options: {},
    });
    expect(clearTalkQueue(taskId, { onlySources: ["app"] })).toBe(1);
    const left = listTalkQueue(taskId);
    expect(left).toHaveLength(1);
    expect(left[0]?.source).toBe("group_owner");
  });

  it("clearTalkQueue：停止只清 app、不动群来源（含 group_question）；整队清才连群提问一起清", () => {
    const taskId = "tq-clear-2";
    enqueueTalkMessage(taskId, { source: "app", rawBody: { text: "app" }, options: {} });
    enqueueGroupQuestion(taskId, {
      messageId: "om_gq_keep",
      chatId: "oc_chat",
      text: "同事问",
      parsed: { text: "同事问", images: [], attachments: [] },
      requester: { openId: "ou_x", name: "张三" },
      boot: { apiKey: "k", model: { id: "m" } },
    });
    expect(clearTalkQueue(taskId, { onlySources: ["app"] })).toBe(1);
    expect(buildTalkQueueSnapshot(taskId).map((e) => e.source)).toEqual([
      "group_question",
    ]);
    expect(clearTalkQueue(taskId)).toBe(1);
    expect(buildTalkQueueSnapshot(taskId)).toHaveLength(0);
  });

  it("buildTalkQueueSnapshot 合并 group_question", () => {
    const taskId = "tq-merge-1";
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "我" },
      options: {},
    });
    enqueueGroupQuestion(taskId, {
      messageId: "om_gq_1",
      chatId: "oc_chat",
      text: "同事问",
      parsed: { text: "同事问", images: [], attachments: [] },
      requester: { openId: "ou_x", name: "张三" },
      requesterIsBot: false,
      boot: { apiKey: "k", model: { id: "m" } },
    });
    const snap = buildTalkQueueSnapshot(taskId);
    expect(snap.map((s) => s.source).sort()).toEqual(
      ["app", "group_question"].sort(),
    );
    expect(removeTalkQueueItems(taskId, ["om_gq_1"])).toContain("om_gq_1");
  });
});

describe("task-talk-queue drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInject.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetTaskTalkQueueForTest();
    runningTasks.clear();
  });

  it("忙时不放行、空闲后重放；409 忙类回队首", async () => {
    const taskId = "tq-drain-1";
    await mkTask(taskId);
    runningTasks.set(taskId, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });

    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "queued" },
      options: {},
    });
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).not.toHaveBeenCalled();

    runningTasks.delete(taskId);
    mockInject.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "agent 正在跑、等它说完这轮再问" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(1);

    mockInject.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, task: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await __tickTalkQueueDrainForTest(taskId);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("非忙 409 丢弃并写 info", async () => {
    const taskId = "tq-drain-2";
    await mkTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "bad" },
      options: {},
    });
    mockInject.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await __tickTalkQueueDrainForTest(taskId);
    expect(listTalkQueue(taskId)).toHaveLength(0);
    const events = await readEvents(taskId);
    expect(events.some((e) => e.kind === "info" && e.text?.includes("没送出去"))).toBe(
      true,
    );
  });

  it("409 带结构化忙标记 code=task_busy：文案里没有「正在跑」也回队首、不丢（K2-03 契约）", async () => {
    const taskId = "tq-drain-busy-code";
    await mkTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "keep-me" },
      options: {},
    });
    // 文案故意不含「正在跑 / 等它说完」：判忙只能靠标记（真实场景 = 在途等待超时的「还在处理中」）
    mockInject.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "同一条消息上一次发送还在处理中、请稍后再试", code: "task_busy" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(1);
    const events = await readEvents(taskId);
    expect(events.some((e) => e.kind === "info" && e.text?.includes("没送出去"))).toBe(
      false,
    );
  });

  it("409 既无忙标记、文案也不是忙类（停止中 / 状态已变）：仍丢弃并写 info（对照）", async () => {
    const taskId = "tq-drain-nonbusy-409";
    await mkTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "gone" },
      options: {},
    });
    mockInject.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "任务正在停止，稍后再试" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await __tickTalkQueueDrainForTest(taskId);
    expect(listTalkQueue(taskId)).toHaveLength(0);
    const events = await readEvents(taskId);
    expect(events.some((e) => e.kind === "info" && e.text?.includes("没送出去"))).toBe(
      true,
    );
  });

  it("超过 TTL 丢弃", async () => {
    const taskId = "tq-drain-3";
    await mkTask(taskId);
    const now = Date.now();
    vi.setSystemTime(now);
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "old" },
      options: {},
    });
    vi.setSystemTime(now + TALK_QUEUE_TTL_MS + 1000);
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("重放：清掉 queueIfBusy、打 fromQueue 标记，一次 tick 只放一条（FIFO 串行）", async () => {
    const taskId = "tq-drain-replay";
    await mkTask(taskId);
    const rawA = { text: "A" };
    enqueueTalkMessage(taskId, {
      source: "group_owner",
      rawBody: rawA,
      options: {
        userReplyMetaExtra: { source: "feishu_group" },
        queueIfBusy: { source: "group_owner" },
      },
    });
    enqueueTalkMessage(taskId, { source: "app", rawBody: { text: "B" }, options: {} });
    mockInject.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);
    const [id, body, opts] = mockInject.mock.calls[0]!;
    expect(id).toBe(taskId);
    expect(body).toBe(rawA);
    expect(opts.queueIfBusy).toBeUndefined();
    expect(opts.userReplyMetaExtra).toMatchObject({
      source: "feishu_group",
      fromQueue: true,
    });
    // B 还在队里，等下一轮空闲再放
    expect(listTalkQueue(taskId).map((e) => e.preview)).toEqual(["B"]);
  });

  it("两个 tick 重叠（meta 读盘慢）也只重放一条，不连珠炮", async () => {
    const taskId = "tq-drain-overlap";
    await mkTask(taskId);
    for (const t of ["A", "B"]) {
      enqueueTalkMessage(taskId, { source: "app", rawBody: { text: t }, options: {} });
    }
    let release!: (r: Response) => void;
    mockInject.mockReturnValueOnce(
      new Promise<Response>((r) => {
        release = r;
      }),
    );
    const t1 = __tickTalkQueueDrainForTest(taskId);
    const t2 = __tickTalkQueueDrainForTest(taskId);
    await t2;
    // 第一条重放还在飞，第二个 tick 必须直接让路
    await vi.waitFor(() => expect(mockInject).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await t1;
    expect(mockInject).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(1);
  });

  it("tick 读 meta 期间用户把队列删光 → 不会把已删的条目重放出去", async () => {
    const taskId = "tq-drain-stale";
    await mkTask(taskId);
    const r = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "要被删" },
      options: {},
    });
    if (!r.ok) throw new Error("应入队");
    const tick = __tickTalkQueueDrainForTest(taskId);
    // tick 的第一个 await 是读 meta：此刻同步删除
    expect(removeTalkQueueItems(taskId, [r.itemId])).toEqual([r.itemId]);
    await tick;
    expect(mockInject).not.toHaveBeenCalled();
  });

  it("重放期间队列被清空、随后仍遇忙 409 → 条目放回队首、不丢", async () => {
    const taskId = "tq-drain-putback";
    await mkTask(taskId);
    enqueueTalkMessage(taskId, { source: "app", rawBody: { text: "A" }, options: {} });
    mockInject.mockImplementationOnce(async () => {
      clearTalkQueue(taskId);
      return new Response(
        JSON.stringify({ error: "agent 正在跑、等它说完这轮再问" }),
        { status: 409 },
      );
    });
    await __tickTalkQueueDrainForTest(taskId);
    expect(listTalkQueue(taskId).map((e) => e.preview)).toEqual(["A"]);
  });

  it("publish talk_queue 帧", async () => {
    const taskId = "tq-pub-1";
    const seen: number[] = [];
    const unsub = subscribeTaskStream(taskId, (ev) => {
      if (ev.kind === "talk_queue") seen.push(ev.items.length);
    });
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "x" },
      options: {},
    });
    expect(seen.length).toBeGreaterThan(0);
    unsub();
  });
});

describe("task-talk-queue TTL（忙时也过期、写 info 不静默）", () => {
  beforeEach(() => {
    // 只拟 Date：drain 写 info 要走真实文件 IO，不能让整套定时器被冻住
    vi.useFakeTimers({ toFake: ["Date"] });
    mockInject.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetTaskTalkQueueForTest();
    runningTasks.clear();
  });

  it("agent 一直在跑、条目躺满 30 分钟 → 丢弃并写 info，且不重放", async () => {
    const taskId = "tq-ttl-busy";
    await mkTask(taskId, "running");
    runningTasks.set(taskId, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });
    const now = Date.now();
    vi.setSystemTime(now);
    enqueueTalkMessage(taskId, {
      source: "group_reply",
      rawBody: { text: "后端回执" },
      options: {},
    });
    vi.setSystemTime(now + TALK_QUEUE_TTL_MS + 1000);
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId)).toHaveLength(0);
    await vi.waitFor(async () => {
      const events = await readEvents(taskId);
      expect(
        events.some((e) => e.kind === "info" && e.text?.includes("已过期")),
      ).toBe(true);
    });
  });
});
