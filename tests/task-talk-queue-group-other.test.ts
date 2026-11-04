/**
 * task 待送达队列 × group_other（群里非属主并入同会话时的排队来源）
 *
 * 钉死的语义：
 * - 独立上限 5（不吃属主那 10 格的余量）+ 每人最多 2 条；超了返回各自的 reason
 * - 重放优先级：属主自己的（app / group_owner / group_reply）永远先于 group_other
 * - 会话已不在 → group_other 不重放（不唤醒 / 新起 agent）、出队并通知发言人（failed）
 * - 过期 / 属主在 app 里删除 / 停止 → 都通知发言人（钩子），不静默
 * - 停止只清 group_other（单独一步）；STOP_CLEARED_SOURCES 的口径（只清 app）不变
 *
 * 走真实 drain（tick），只 mock 注入链本身（它是被保护的下游）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-talk-q-gother-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockInject = vi.fn();
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: (...args: unknown[]) => mockInject(...args),
}));
vi.mock("@/lib/server/chat-gate", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/server/chat-gate")>();
  return { ...orig, getChatLifecycle: vi.fn(() => null) };
});

const { writeMeta, readEvents } = await import("@/lib/server/task-fs-core");
const { agentSessions, runningTasks } = await import(
  "@/lib/server/task-stream"
);
const {
  TALK_QUEUE_GROUP_OTHER_MAX,
  TALK_QUEUE_GROUP_OTHER_MAX_PER_SENDER,
  TALK_QUEUE_MAX,
  TALK_QUEUE_TTL_MS,
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  clearGroupOtherQueueOnStop,
  clearTalkQueue,
  enqueueTalkMessage,
  isStopClearedTalkSource,
  listTalkQueue,
  removeTalkQueueItems,
  setTalkQueueGroupOtherDropHandler,
} = await import("@/lib/server/task-talk-queue");

const mkTask = async (id: string): Promise<void> => {
  const meta = {
    id,
    title: "t",
    mode: "task",
    runStatus: "idle",
    repoStatus: "developing",
    repoPaths: [],
    actions: [
      {
        id: "act_1",
        type: "build",
        status: "awaiting_ack",
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

const okResp = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

let seq = 0;
const alloc = (): string => `tq-gother-${Date.now()}-${seq++}`;

const meta = (openId: string, name: string, id = `om_${seq++}`) => ({
  source: "feishu_group",
  groupChatId: "oc_x",
  groupSender: name,
  groupSenderOpenId: openId,
  feishuMessageId: id,
  groupNonOwnerTurn: true,
});

const enqOther = (
  taskId: string,
  who: { openId: string; name: string },
  text = "问个问题",
) =>
  enqueueTalkMessage(taskId, {
    source: "group_other",
    rawBody: { text },
    options: { userReplyMetaExtra: meta(who.openId, who.name) },
    senderName: who.name,
    senderKey: who.openId,
    preview: text,
  });

const A = { openId: "ou_a", name: "甲" };
const B = { openId: "ou_b", name: "乙" };

type Dropped = {
  taskId: string;
  reason: string;
  detail?: string;
  meta: Record<string, unknown> | undefined;
  senderIsBot: boolean;
};
let dropped: Dropped[] = [];

beforeEach(() => {
  mockInject.mockReset();
  mockInject.mockResolvedValue(okResp());
  agentSessions.clear();
  runningTasks.clear();
  dropped = [];
  setTalkQueueGroupOtherDropHandler((info) => {
    dropped.push(info as Dropped);
  });
});
afterEach(() => {
  vi.useRealTimers();
  setTalkQueueGroupOtherDropHandler(null);
  __resetTaskTalkQueueForTest();
  agentSessions.clear();
  runningTasks.clear();
});

describe("容量：独立上限 + 每人槽位", () => {
  it("每人最多 2 条，第 3 条 reason=group_other_sender_full；别人不受影响", () => {
    const t = alloc();
    expect(TALK_QUEUE_GROUP_OTHER_MAX_PER_SENDER).toBe(2);
    expect(enqOther(t, A).ok).toBe(true);
    expect(enqOther(t, A).ok).toBe(true);
    expect(enqOther(t, A)).toMatchObject({
      ok: false,
      reason: "group_other_sender_full",
    });
    expect(enqOther(t, B).ok).toBe(true);
  });

  it("group_other 总共最多 5 条（reason=group_other_full），且不吃属主的余量", () => {
    const t = alloc();
    expect(TALK_QUEUE_GROUP_OTHER_MAX).toBe(5);
    const people = [
      { openId: "ou_1", name: "1" },
      { openId: "ou_2", name: "2" },
      { openId: "ou_3", name: "3" },
    ];
    // 3 个人 × 2 = 6 > 5：第 6 条（第 3 人的第 2 条）撞总上限
    for (const p of people) {
      enqOther(t, p);
    }
    expect(enqOther(t, people[0]!).ok).toBe(true); // 第 4 条（人 1 的第 2 条）
    expect(enqOther(t, people[1]!).ok).toBe(true); // 第 5 条（人 2 的第 2 条）
    expect(enqOther(t, people[2]!)).toMatchObject({
      ok: false,
      reason: "group_other_full",
    });
    expect(listTalkQueue(t)).toHaveLength(TALK_QUEUE_GROUP_OTHER_MAX);
    // 属主输入条仍有余量
    const r = enqueueTalkMessage(t, {
      source: "app",
      rawBody: { text: "属主追问" },
      options: {},
    });
    expect(r.ok).toBe(true);
    expect(TALK_QUEUE_MAX - TALK_QUEUE_GROUP_OTHER_MAX).toBeGreaterThan(0);
  });

  it("总队列满（10）时 group_other 也进不去，走原 full", () => {
    const t = alloc();
    for (let i = 0; i < TALK_QUEUE_MAX; i++) {
      enqueueTalkMessage(t, {
        source: "app",
        rawBody: { text: `m${i}` },
        options: {},
      });
    }
    expect(enqOther(t, A)).toMatchObject({ ok: false, reason: "full" });
  });
});

describe("重放：属主优先、会话不在不唤醒", () => {
  it("队首是 group_other、后面有属主的：先放属主的", async () => {
    const t = alloc();
    await mkTask(t);
    agentSessions.set(t, {} as never);
    enqOther(t, A, "陌生人的问题");
    enqueueTalkMessage(t, {
      source: "group_owner",
      rawBody: { text: "属主追问" },
      options: {},
    });
    await __tickTalkQueueDrainForTest(t);
    expect(mockInject).toHaveBeenCalledTimes(1);
    expect((mockInject.mock.calls[0]![1] as { text: string }).text).toBe(
      "属主追问",
    );
    expect(listTalkQueue(t).map((e) => e.preview)).toEqual(["陌生人的问题"]);
  });

  it("只剩 group_other：会话在 → 照常重放；重放选项里带 groupNonOwner（来自入队时的选项）", async () => {
    const t = alloc();
    await mkTask(t);
    agentSessions.set(t, {} as never);
    enqueueTalkMessage(t, {
      source: "group_other",
      rawBody: { text: "问" },
      options: {
        groupNonOwner: { name: A.name },
        userReplyMetaExtra: meta(A.openId, A.name),
      },
      senderName: A.name,
      senderKey: A.openId,
    });
    await __tickTalkQueueDrainForTest(t);
    expect(mockInject).toHaveBeenCalledTimes(1);
    expect(mockInject.mock.calls[0]![2]).toMatchObject({
      groupNonOwner: { name: A.name },
    });
    expect(listTalkQueue(t)).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it("会话已不在：不重放（不唤醒 / 新起 agent）、出队、通知发言人 failed、事件流留 info", async () => {
    const t = alloc();
    await mkTask(t);
    expect(agentSessions.has(t)).toBe(false);
    enqOther(t, A);
    await __tickTalkQueueDrainForTest(t);
    expect(mockInject).not.toHaveBeenCalled();
    expect(listTalkQueue(t)).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      taskId: t,
      reason: "failed",
      senderIsBot: false,
    });
    expect(dropped[0]!.meta).toMatchObject({ groupSenderOpenId: A.openId });
    const events = await readEvents(t);
    expect(
      events.some((e) => e.kind === "info" && e.text?.includes("没送出去")),
    ).toBe(true);
  });
});

describe("被丢弃都通知发言人（不静默）", () => {
  it("TTL 过期 → expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = alloc();
    await mkTask(t);
    agentSessions.set(t, {} as never);
    // 让任务「忙」：这样 tick 不会放行，只会走过期清扫
    runningTasks.set(t, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });
    enqOther(t, A);
    vi.setSystemTime(Date.now() + TALK_QUEUE_TTL_MS + 1000);
    await __tickTalkQueueDrainForTest(t);
    expect(listTalkQueue(t)).toHaveLength(0);
    expect(dropped.map((d) => d.reason)).toEqual(["expired"]);
  });

  it("属主在 app 里删除这一条 → deleted", () => {
    const t = alloc();
    const r = enqOther(t, A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    removeTalkQueueItems(t, [r.itemId]);
    expect(dropped.map((d) => d.reason)).toEqual(["deleted"]);
  });

  it("删除别的来源的条目不触发钩子", () => {
    const t = alloc();
    const r = enqueueTalkMessage(t, {
      source: "group_owner",
      rawBody: { text: "属主" },
      options: {},
    });
    if (!r.ok) throw new Error("enqueue failed");
    removeTalkQueueItems(t, [r.itemId]);
    expect(dropped).toHaveLength(0);
  });
});

describe("任务终结 / 归档 / 删除（整队清）也通知发言人", () => {
  it("clearTalkQueue 无 onlySources：group_other 逐条通知 closed；其它来源不触发", () => {
    const t = alloc();
    enqOther(t, A);
    enqOther(t, B);
    enqueueTalkMessage(t, {
      source: "group_owner",
      rawBody: { text: "属主" },
      options: {},
    });
    expect(clearTalkQueue(t)).toBe(3);
    expect(dropped.map((d) => d.reason)).toEqual(["closed", "closed"]);
  });

  it("clearTalkQueue({ onlySources: [\"app\"] })（停止的口径）不碰 group_other、不通知", () => {
    const t = alloc();
    enqOther(t, A);
    enqueueTalkMessage(t, {
      source: "app",
      rawBody: { text: "输入条" },
      options: {},
    });
    expect(clearTalkQueue(t, { onlySources: ["app"] })).toBe(1);
    expect(dropped).toHaveLength(0);
    expect(listTalkQueue(t).map((e) => e.source)).toEqual(["group_other"]);
  });
});

describe("停止：只清 group_other（单独一步），STOP_CLEARED_SOURCES 口径不变", () => {
  it("clearGroupOtherQueueOnStop 只清 group_other、通知 stopped、返回条数；属主来源保留", async () => {
    const t = alloc();
    await mkTask(t);
    enqOther(t, A);
    enqOther(t, B);
    enqueueTalkMessage(t, {
      source: "group_owner",
      rawBody: { text: "属主群消息" },
      options: {},
    });
    enqueueTalkMessage(t, {
      source: "group_reply",
      rawBody: { text: "回执" },
      options: { correlatedAnswer: true },
    });
    expect(clearGroupOtherQueueOnStop(t)).toBe(2);
    expect(dropped.map((d) => d.reason)).toEqual(["stopped", "stopped"]);
    expect(listTalkQueue(t).map((e) => e.source).sort()).toEqual([
      "group_owner",
      "group_reply",
    ]);
    // 没有可清的 → 0、不通知
    dropped = [];
    expect(clearGroupOtherQueueOnStop(t)).toBe(0);
    expect(dropped).toHaveLength(0);
  });

  it("STOP_CLEARED_SOURCES 口径没变：停止只清 app，group_other 不在其中（它走单独的一步）", () => {
    expect(isStopClearedTalkSource("app")).toBe(true);
    expect(isStopClearedTalkSource("group_other")).toBe(false);
    expect(isStopClearedTalkSource("group_owner")).toBe(false);
    expect(isStopClearedTalkSource("group_reply")).toBe(false);
  });
});
