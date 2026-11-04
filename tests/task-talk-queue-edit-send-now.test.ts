/**
 * task 模式排队消息：编辑（原地改文字）+ 立即发送（打断重发）的服务端行为
 *
 * 守的是行为而非源码形状：
 * - 编辑：只认 app 来源、重放的是编辑后的文本、位置 / TTL 起点 / 附件不变、清空文字仅限带附件的条、
 *   编辑前的指纹留作别名（原文重试不会再排一条）；
 * - 立即发送：先试后停（空闲不停任何东西）、busy 才 stop、stop 之前救出其余 app 排队（stop 的清队不波及）、
 *   失败一律放回队首、撞上别人的 stop 按 stop 清队语义处理、drain 锁期间定时 drain 不插队。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-talk-q-edit-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockInject = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: (...args: unknown[]) => mockInject(...args),
  lifecycleBlockedResponse: () =>
    new Response(JSON.stringify({ error: "正在停止、请稍后再试" }), { status: 409 }),
}));
vi.mock("@/lib/server/stop-task", () => ({
  stopTaskAgent: vi.fn(async () => ({ hadAgent: true })),
}));
vi.mock("@/lib/server/chat-gate", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/server/chat-gate")>();
  return { ...orig, getChatLifecycle: vi.fn(() => null) };
});

const { writeMeta, readEvents } = await import("@/lib/server/task-fs-core");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
const {
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  beginTalkQueueSendNow,
  buildTalkQueueSnapshot,
  clearTalkQueue,
  endTalkQueueSendNow,
  enqueueTalkMessage,
  listTalkQueue,
  listTalkQueueEditTexts,
  removeTalkQueueItems,
  removeTalkQueueItemsByDedupe,
  updateTalkQueueItemText,
} = await import("@/lib/server/task-talk-queue");
const { shouldAutoOpenQueue } = await import("@/lib/queue-banner");
const { sendQueuedTalkMessageNow, TALK_SEND_NOW_LOCK_WAIT_MS } = await import(
  "@/lib/server/task-talk-queue-send-now"
);
const { fingerprintTaskQuestionBody } = await import(
  "@/lib/server/task-inject-shared"
);
const talkQueueRoute = await import("@/app/api/tasks/[id]/talk-queue/route");

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

const taskOf = (id: string, mode: "task" | "chat" = "task"): Task =>
  ({ id, mode }) as unknown as Task;

const enq = (
  taskId: string,
  text: string,
  extra: Record<string, unknown> = {},
  source: "app" | "group_owner" | "group_reply" = "app",
  clientItemId?: string,
): string => {
  const r = enqueueTalkMessage(taskId, {
    source,
    rawBody: { text, ...extra },
    options: {},
    ...(clientItemId ? { clientItemId } : {}),
  });
  if (!r.ok) throw new Error("应入队");
  return r.itemId;
};

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });
const BUSY = (): Response =>
  jsonRes(409, { error: "agent 正在跑、等它说完这轮再问", code: "task_busy" });
const STOPPING = (): Response =>
  jsonRes(409, { error: "正在停止、请稍后再试", code: "task_busy", phase: "stopping" });
const OK = (): Response => jsonRes(200, { ok: true });

const texts = (taskId: string): string[] =>
  listTalkQueue(taskId).map((i) => i.preview);

afterEach(() => {
  __resetTaskTalkQueueForTest();
  mockInject.mockReset();
  vi.useRealTimers();
});

describe("updateTalkQueueItemText（编辑）", () => {
  it("原地改：位置 / 入队时间不变，快照预览更新并重发 SSE 帧", () => {
    const taskId = "edit-1";
    const a = enq(taskId, "第一条");
    const b = enq(taskId, "第二条");
    enq(taskId, "第三条");
    const before = listTalkQueue(taskId).find((i) => i.id === b)!;

    const frames: string[][] = [];
    const unsub = subscribeTaskStream(taskId, (ev) => {
      if (ev.kind === "talk_queue") frames.push(ev.items.map((i) => i.preview));
    });
    const r = updateTalkQueueItemText(taskId, b, "  第二条（改过）  ");
    unsub();

    expect(r).toMatchObject({ ok: true, item: { id: b, preview: "第二条（改过）" } });
    expect(texts(taskId)).toEqual(["第一条", "第二条（改过）", "第三条"]);
    expect(listTalkQueue(taskId).find((i) => i.id === b)!.createdAt).toBe(before.createdAt);
    expect(listTalkQueue(taskId)[0]!.id).toBe(a);
    expect(frames.at(-1)).toEqual(["第一条", "第二条（改过）", "第三条"]);
  });

  it("重放的是编辑后的文本，且保留原请求体里的其它字段（bootArgs 等）", async () => {
    const taskId = "edit-replay";
    await mkTask(taskId);
    const id = enq(taskId, "原文", { bootArgs: { apiKey: "k" }, clientSentAt: 1 });
    expect(updateTalkQueueItemText(taskId, id, "改后").ok).toBe(true);
    mockInject.mockResolvedValue(OK());

    await __tickTalkQueueDrainForTest(taskId);

    expect(mockInject).toHaveBeenCalledTimes(1);
    expect(mockInject.mock.calls[0]![1]).toMatchObject({
      text: "改后",
      bootArgs: { apiKey: "k" },
    });
  });

  it("只有 app 来源能编辑；群属主 / 回执 / 不存在都拒（并给出原因）", () => {
    const taskId = "edit-source";
    const owner = enq(taskId, "群属主", {}, "group_owner");
    const reply = enq(taskId, "回执", {}, "group_reply");
    expect(updateTalkQueueItemText(taskId, owner, "x")).toEqual({
      ok: false,
      reason: "not_editable",
    });
    expect(updateTalkQueueItemText(taskId, reply, "x")).toEqual({
      ok: false,
      reason: "not_editable",
    });
    expect(updateTalkQueueItemText(taskId, "tq_nope", "x")).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(texts(taskId)).toEqual(["群属主", "回执"]);
  });

  it("已被 drain 取走（重放中）的条目编辑 → gone，不会改到正在送的那条", async () => {
    const taskId = "edit-gone";
    await mkTask(taskId);
    const id = enq(taskId, "正在送");
    let release!: () => void;
    mockInject.mockImplementation(
      () => new Promise<Response>((resolve) => (release = () => resolve(OK()))),
    );
    const tick = __tickTalkQueueDrainForTest(taskId);
    await vi.waitFor(() => expect(mockInject).toHaveBeenCalled());

    expect(updateTalkQueueItemText(taskId, id, "迟了")).toEqual({
      ok: false,
      reason: "gone",
    });
    release();
    await tick;
    expect(mockInject.mock.calls[0]![1]).toMatchObject({ text: "正在送" });
  });

  it("清空文字：纯文字条拒（empty）；带图片的条允许、预览变「(附图片)」", () => {
    const taskId = "edit-empty";
    const plain = enq(taskId, "纯文字");
    const withImg = enq(taskId, "带图", { images: [{ data: "AA", mimeType: "image/png" }] });
    expect(updateTalkQueueItemText(taskId, plain, "   ")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(updateTalkQueueItemText(taskId, withImg, "")).toMatchObject({
      ok: true,
      item: { preview: "(附图片)", hasAttachments: true },
    });
    expect(listTalkQueueEditTexts(taskId)[withImg]).toBe("");
  });

  it("超长拒（too_long），队里原文不变", () => {
    const taskId = "edit-long";
    const id = enq(taskId, "短");
    expect(updateTalkQueueItemText(taskId, id, "x".repeat(20001))).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(listTalkQueueEditTexts(taskId)[id]).toBe("短");
    expect(updateTalkQueueItemText(taskId, id, "x".repeat(20000)).ok).toBe(true);
  });

  it("快照带 hasAttachments；完整正文只给可编辑来源且不截断（preview 只有 120 字）", () => {
    const taskId = "edit-full";
    const long = "长".repeat(300);
    const a = enq(taskId, long);
    enq(taskId, "群里的", {}, "group_owner");
    enq(taskId, "图", { attachments: ["/tmp/a.txt"] });

    const snap = buildTalkQueueSnapshot(taskId);
    expect(snap.find((i) => i.id === a)!.preview).toHaveLength(120);
    expect(snap.map((i) => i.hasAttachments === true)).toEqual([false, false, true]);
    const full = listTalkQueueEditTexts(taskId);
    expect(full[a]).toBe(long);
    expect(Object.keys(full)).toHaveLength(2); // group_owner 不在
  });

  it("编辑前的指纹留作别名：用同一个 clientItemId + 原文重试不会再排一条；新文本也认；别的正文是新条", () => {
    const taskId = "edit-alias";
    const first = enq(taskId, "原文", {}, "app", "c1");
    expect(updateTalkQueueItemText(taskId, first, "改后").ok).toBe(true);

    const retryOriginal = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "原文" },
      options: {},
      clientItemId: "c1",
    });
    expect(retryOriginal).toMatchObject({ ok: true, itemId: first, duplicate: true });
    const retryEdited = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "改后" },
      options: {},
      clientItemId: "c1",
    });
    expect(retryEdited).toMatchObject({ ok: true, itemId: first, duplicate: true });
    const another = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "第三种" },
      options: {},
      clientItemId: "c1",
    });
    expect(another).toMatchObject({ ok: true });
    expect(another.ok && another.itemId).not.toBe(first);
    expect(listTalkQueue(taskId)).toHaveLength(2);
  });

  it("直送成功的「摘掉队里同一条」也认别名：原文被直送后，改过的那条不会残留再重放一遍", () => {
    const taskId = "edit-alias-remove";
    const id = enq(taskId, "原文", {}, "app", "c2");
    updateTalkQueueItemText(taskId, id, "改后");
    expect(
      removeTalkQueueItemsByDedupe(taskId, "c2", fingerprintTaskQuestionBody({ text: "原文" })),
    ).toBe(1);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });
});

describe("beginTalkQueueSendNow / endTalkQueueSendNow（取出 + 救其余 + drain 锁）", () => {
  it("取出目标；app 来源的其余救出（stop 清不到），群来源留队；drain 锁占住期间定时 drain 不重放", async () => {
    const taskId = "begin-1";
    await mkTask(taskId);
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    const owner = enq(taskId, "群属主", {}, "group_owner");
    const c = enq(taskId, "C");

    const begun = beginTalkQueueSendNow(taskId, b);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.item.itemId).toBe(b);
    expect(begun.rest.map((e) => e.itemId)).toEqual([a, c]);
    // 被救出的 A / C 不在队列里（stop 的清队碰不到），但**快照里仍然有它们**并标 held——
    // 窗口常常是好几秒，快照里它们若消失，排队条会降成 0 整条消失、放回后又 0→N 自动弹开（第十七轮 N1）。
    // （以前这里断言的是 [owner]，把「界面上看不到它们」当成了正确答案）
    expect(
      listTalkQueue(taskId).map((i) => [i.id, i.held === true]),
    ).toEqual([
      [a, true],
      [owner, false],
      [c, true],
    ]);

    // 锁占住：定时 drain 即使任务空闲也不得重放（否则和立即发送并发起 run）
    mockInject.mockResolvedValue(OK());
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).not.toHaveBeenCalled();
    expect(beginTalkQueueSendNow(taskId, owner)).toEqual({ ok: false, reason: "drain_busy" });

    endTalkQueueSendNow(taskId, { rest: begun.rest });
    // 放回后按入队先后：A、群属主、C（目标 B 已送出、不在）
    expect(texts(taskId)).toEqual(["A", "群属主", "C"]);
  });

  it("没送出去的目标条放回队首（保持第一位），其余跟在后面", async () => {
    const taskId = "begin-putback";
    enq(taskId, "A");
    const b = enq(taskId, "B");
    enq(taskId, "C");
    const begun = beginTalkQueueSendNow(taskId, b);
    if (!begun.ok) throw new Error("应取出");
    expect(texts(taskId)).toEqual(["A", "C"]); // 暂存中（held）仍在列表里，目标条本身出队

    endTalkQueueSendNow(taskId, { putBack: begun.item, rest: begun.rest });
    expect(texts(taskId)).toEqual(["B", "A", "C"]);
  });

  it("放回不判满队：用户早已收到 202 的消息不能因窗口内新到的而被静默丢掉", () => {
    const taskId = "begin-full";
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(enq(taskId, `m${i}`));
    const begun = beginTalkQueueSendNow(taskId, ids[0]!);
    if (!begun.ok) throw new Error("应取出");
    for (let i = 0; i < 10; i++) enq(taskId, `new${i}`); // 窗口内又排满
    endTalkQueueSendNow(taskId, { putBack: begun.item, rest: begun.rest });
    expect(listTalkQueue(taskId)).toHaveLength(20);
    expect(texts(taskId)[0]).toBe("m0");
  });

  it("群回执不能立即发送（not_allowed）；不存在 → gone；二者都不动队列也不占锁", () => {
    const taskId = "begin-deny";
    const reply = enq(taskId, "回执", {}, "group_reply");
    expect(beginTalkQueueSendNow(taskId, reply)).toEqual({ ok: false, reason: "not_allowed" });
    expect(beginTalkQueueSendNow(taskId, "tq_nope")).toEqual({ ok: false, reason: "gone" });
    expect(texts(taskId)).toEqual(["回执"]);
    const a = enq(taskId, "A");
    expect(beginTalkQueueSendNow(taskId, a).ok).toBe(true); // 锁没被前两次污染
  });
});

describe("暂存区（held）：立即发送窗口内快照不跳变（第十七轮 N1）", () => {
  const heldFlags = (taskId: string) =>
    buildTalkQueueSnapshot(taskId).map((i) => [i.preview, i.held === true]);
  const noHeld = (taskId: string) =>
    expect(buildTalkQueueSnapshot(taskId).some((i) => i.held)).toBe(false);
  const noDuplicateIds = (taskId: string) => {
    const ids = buildTalkQueueSnapshot(taskId).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  };

  it("begin 之后、end 之前快照仍含被救出的其余条（条数 = N-1、带 held、次序与放回后一致）；end 后 held 清空", () => {
    const taskId = "held-1";
    enq(taskId, "A");
    const b = enq(taskId, "B");
    enq(taskId, "C");
    enq(taskId, "D");
    const before = buildTalkQueueSnapshot(taskId).map((i) => i.preview);

    const begun = beginTalkQueueSendNow(taskId, b);
    if (!begun.ok) throw new Error("应取出");
    expect(heldFlags(taskId)).toEqual([
      ["A", true],
      ["C", true],
      ["D", true],
    ]);

    endTalkQueueSendNow(taskId, { rest: begun.rest }); // 目标 B 已送出
    noHeld(taskId);
    expect(buildTalkQueueSnapshot(taskId).map((i) => i.preview)).toEqual(
      before.filter((t) => t !== "B"),
    );
  });

  it("三种收尾（成功 / 失败放回 / 抛错）：held 都清掉，快照没有重复项", async () => {
    const taskId = "held-end";
    const mk = () => {
      const a = enq(taskId, "A");
      const b = enq(taskId, "B");
      return { a, b };
    };
    const run = async (inject: () => Promise<Response>, stop?: () => Promise<void>) => {
      mockInject.mockReset();
      mockInject.mockImplementation(async () => inject());
      const deps = {
        getTask: vi.fn(async (id: string) => taskOf(id)),
        inject: vi.fn(async (...args: unknown[]) => mockInject(...args)),
        stop: vi.fn(stop ?? (async () => {})),
        getLifecycle: vi.fn(() => null),
        sleep: vi.fn(async () => {}),
      };
      return sendQueuedTalkMessageNow(taskId, ids.b, deps);
    };

    let ids = mk();
    expect((await run(async () => OK())).status).toBe(200);
    noHeld(taskId);
    noDuplicateIds(taskId);
    expect(texts(taskId)).toEqual(["A"]);

    __resetTaskTalkQueueForTest();
    ids = mk();
    expect((await run(async () => jsonRes(400, { error: "附件不存在" }))).status).toBe(400);
    noHeld(taskId);
    noDuplicateIds(taskId);
    expect(texts(taskId)).toEqual(["B", "A"]);

    __resetTaskTalkQueueForTest();
    ids = mk();
    await expect(
      run(async () => BUSY(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    noHeld(taskId);
    noDuplicateIds(taskId);
    expect(texts(taskId)).toEqual(["B", "A"]);
  });

  it("撞别人的 stop：被丢弃的 app 条收尾后不再留在快照里，也没有 held 残留", async () => {
    const taskId = "held-stopping";
    await mkTask(taskId);
    enq(taskId, "A");
    const owner = enq(taskId, "群属主话", {}, "group_owner");
    const b = enq(taskId, "B");
    mockInject.mockResolvedValueOnce(STOPPING());
    const { deps } = (() => {
      const calls: string[] = [];
      return {
        deps: {
          getTask: vi.fn(async (id: string) => taskOf(id)),
          inject: vi.fn(async (...args: unknown[]) => {
            calls.push("inject");
            return mockInject(...args);
          }),
          stop: vi.fn(async () => {}),
          getLifecycle: vi.fn(() => null),
          sleep: vi.fn(async () => {}),
        },
      };
    })();

    await sendQueuedTalkMessageNow(taskId, b, deps);

    noHeld(taskId);
    expect(buildTalkQueueSnapshot(taskId).map((i) => i.id)).toEqual([owner]);
  });

  it("窗口内对暂存条的编辑 / 删除 / 立即发送都被拒；不影响它们稍后放回", async () => {
    const taskId = "held-guard";
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    const begun = beginTalkQueueSendNow(taskId, b);
    if (!begun.ok) throw new Error("应取出");

    // 编辑：不在队列里 → gone（路由回 409 queue_item_gone，客户端静默 / 提示「已送出」）
    expect(updateTalkQueueItemText(taskId, a, "偷改")).toEqual({ ok: false, reason: "gone" });
    // 删除：删不到（removedIds 空），暂存条原样还在
    expect(removeTalkQueueItems(taskId, [a])).toEqual([]);
    expect(heldFlags(taskId)).toEqual([["A", true]]);
    // 立即发送：drain 锁被这次窗口占着 → 稍后再点（等不到就 409 task_busy，不碰队列）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const res = await sendQueuedTalkMessageNow(taskId, a, {
      getTask: vi.fn(async (id: string) => taskOf(id)),
      inject: vi.fn(async () => OK()),
      stop: vi.fn(async () => {}),
      getLifecycle: vi.fn(() => null),
      sleep: vi.fn(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms + 1000);
      }),
    });
    expect(res.status).toBe(409);
    vi.useRealTimers();

    endTalkQueueSendNow(taskId, { rest: begun.rest });
    expect(texts(taskId)).toEqual(["A"]);
    expect(listTalkQueueEditTexts(taskId)[a]).toBe("A"); // 没被偷改
  });

  it("整段窗口里排队条数不掉到 0：真实 shouldAutoOpenQueue 过一遍条数序列，不会触发 0→N 自动弹开", async () => {
    const taskId = "held-count";
    enq(taskId, "A");
    const b = enq(taskId, "B");
    enq(taskId, "C");
    enq(taskId, "D");
    mockInject.mockResolvedValueOnce(BUSY()).mockResolvedValueOnce(OK());
    const counts: number[] = [buildTalkQueueSnapshot(taskId).length];
    const unsub = subscribeTaskStream(taskId, (ev) => {
      if (ev.kind === "talk_queue") counts.push(ev.items.length);
    });
    const { deps } = {
      deps: {
        getTask: vi.fn(async (id: string) => taskOf(id)),
        inject: vi.fn(async (...args: unknown[]) => mockInject(...args)),
        // 真实 stop 的清队：app 来源整队清
        stop: vi.fn(async () => {
          clearTalkQueue(taskId, { onlySources: ["app"] });
        }),
        getLifecycle: vi.fn(() => null),
        sleep: vi.fn(async () => {}),
      },
    };

    await sendQueuedTalkMessageNow(taskId, b, deps);
    unsub();

    // 开始 4 条 → 目标出队后 3 条（A / C / D 暂存、仍在列表）→ 送出后还是 3 条
    expect(counts[0]).toBe(4);
    expect(Math.min(...counts.slice(1))).toBe(3);
    for (let i = 1; i < counts.length; i++) {
      expect(shouldAutoOpenQueue(counts[i - 1]!, counts[i]!)).toBe(false);
    }
  });

  it("只有目标一条时窗口内本来就是 0（对的）；失败放回后回到 1", async () => {
    const taskId = "held-single";
    const only = enq(taskId, "唯一");
    mockInject.mockResolvedValueOnce(jsonRes(400, { error: "x" }));
    const counts: number[] = [];
    const unsub = subscribeTaskStream(taskId, (ev) => {
      if (ev.kind === "talk_queue") counts.push(ev.items.length);
    });
    await sendQueuedTalkMessageNow(taskId, only, {
      getTask: vi.fn(async (id: string) => taskOf(id)),
      inject: vi.fn(async (...args: unknown[]) => mockInject(...args)),
      stop: vi.fn(async () => {}),
      getLifecycle: vi.fn(() => null),
      sleep: vi.fn(async () => {}),
    });
    unsub();
    expect(counts[0]).toBe(0);
    expect(counts.at(-1)).toBe(1);
  });

  it("去重也认暂存条：窗口内同 clientItemId + 同正文的原 POST 重试回同一条（不会再排一份、放回后不会双发）", () => {
    const taskId = "held-dedupe";
    const a = enq(taskId, "A", {}, "app", "ca");
    const b = enq(taskId, "B");
    const begun = beginTalkQueueSendNow(taskId, b);
    if (!begun.ok) throw new Error("应取出");

    const retry = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "A" },
      options: {},
      clientItemId: "ca",
    });
    expect(retry).toMatchObject({ ok: true, itemId: a, duplicate: true });

    endTalkQueueSendNow(taskId, { rest: begun.rest });
    expect(texts(taskId)).toEqual(["A"]);
  });

  it("窗口内同一句话被直送（按去重键摘掉）：暂存的那条也被摘、放回时不再出现（否则重放成二次注入）", () => {
    const taskId = "held-dedupe-remove";
    enq(taskId, "A", {}, "app", "cb");
    const b = enq(taskId, "B");
    const begun = beginTalkQueueSendNow(taskId, b);
    if (!begun.ok) throw new Error("应取出");

    expect(
      removeTalkQueueItemsByDedupe(taskId, "cb", fingerprintTaskQuestionBody({ text: "A" })),
    ).toBe(1);
    expect(buildTalkQueueSnapshot(taskId)).toHaveLength(0);

    endTalkQueueSendNow(taskId, { rest: begun.rest });
    expect(texts(taskId)).toEqual([]);
  });
});

describe("sendQueuedTalkMessageNow（编排）", () => {
  const makeDeps = (over: Partial<Parameters<typeof sendQueuedTalkMessageNow>[2]> = {}) => {
    const calls: string[] = [];
    const deps = {
      getTask: vi.fn(async (id: string) => taskOf(id)),
      inject: vi.fn(async (...args: unknown[]) => {
        calls.push("inject");
        return mockInject(...args);
      }),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
      getLifecycle: vi.fn(() => null),
      sleep: vi.fn(async () => {}),
      ...over,
    };
    return { deps, calls };
  };

  it("任务空闲：直接注入成功，一次 stop 都不调；目标条出队、其余原样还在", async () => {
    const taskId = "sn-idle";
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    mockInject.mockResolvedValue(OK());
    const { deps, calls } = makeDeps();

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, itemId: b });
    expect(calls).toEqual(["inject"]);
    expect(mockInject.mock.calls[0]![1]).toMatchObject({ text: "B" });
    // 重放选项与 drain 同源：queueIfBusy 清掉、标 fromQueue
    expect(mockInject.mock.calls[0]![2]).toMatchObject({
      queueIfBusy: undefined,
      userReplyMetaExtra: { fromQueue: true },
    });
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([a]);
  });

  it("agent 在跑（task_busy）：先注入失败 → stop → 再注入成功；其余排队没被 stop 清掉", async () => {
    const taskId = "sn-busy";
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    const c = enq(taskId, "C");
    mockInject.mockResolvedValueOnce(BUSY()).mockResolvedValueOnce(OK());
    const calls: string[] = [];
    // 真 stop 会清掉队里所有 app 来源——模拟它，证明「其余」在 stop 之前已被救出
    const stop = vi.fn(async () => {
      calls.push("stop");
      // 救出的 a / c 在快照里仍在（标 held、条数不跳变），但不在队列里
      expect(listTalkQueue(taskId).map((i) => [i.id, i.held === true])).toEqual([
        [a, true],
        [c, true],
      ]);
      enq(taskId, "窗口内新到"); // 期间新排的会被 stop 清掉——这里只验证救出的不在其列
      // 真实 stop 的清队：app 来源整队清（与 stop-task 的 onlySources 同口径，直接调真实实现）
      clearTalkQueue(taskId, { onlySources: ["app"] });
      // 清队之后：只剩暂存的 a / c（窗口内新到的被清了；暂存的清不到）
      expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([a, c]);
    });
    const { deps } = makeDeps({
      stop,
      inject: vi.fn(async (...args: unknown[]) => {
        calls.push("inject");
        return mockInject(...args);
      }),
    });

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(200);
    expect(calls).toEqual(["inject", "stop", "inject"]);
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([a, c]);
  });

  it("stop 之后再注入仍失败：目标条放回队首（排第一）、其余跟回，错误原样回给客户端", async () => {
    const taskId = "sn-fail-after-stop";
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    mockInject
      .mockResolvedValueOnce(BUSY())
      .mockResolvedValueOnce(jsonRes(500, { error: "起会话失败" }));
    const { deps } = makeDeps();

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(500);
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([b, a]);
  });

  it("首次注入就是非忙的失败（如附件路径失效 400）：不停任何东西，条目放回原样", async () => {
    const taskId = "sn-400";
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    mockInject.mockResolvedValueOnce(jsonRes(400, { error: "附件不存在" }));
    const { deps, calls } = makeDeps();

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(400);
    expect(calls).toEqual(["inject"]);
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([b, a]);
  });

  it("stop 本身抛错：条目全部放回、drain 锁释放（之后还能点）", async () => {
    const taskId = "sn-stop-throws";
    const a = enq(taskId, "A");
    const b = enq(taskId, "B");
    mockInject.mockResolvedValueOnce(BUSY());
    const { deps } = makeDeps({
      stop: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(sendQueuedTalkMessageNow(taskId, b, deps)).rejects.toThrow("boom");

    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([b, a]);
    expect(beginTalkQueueSendNow(taskId, b).ok).toBe(true);
  });

  it("撞上别人的 stop（注入回 phase=stopping）：app 条目按 stop 清队语义不放回、落「未送达」卡；群属主条放回", async () => {
    const taskId = "sn-stopping";
    await mkTask(taskId);
    enq(taskId, "A");
    const owner = enq(taskId, "群属主话", {}, "group_owner");
    const b = enq(taskId, "B");
    mockInject.mockResolvedValueOnce(STOPPING());
    const { deps, calls } = makeDeps();

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(409);
    expect(calls).toEqual(["inject"]); // 别人在停，我们不再自己停
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([owner]);
    const events = await readEvents(taskId);
    const notice = events.find((e) => e.kind === "info" && e.text?.includes("未送达"));
    expect(notice).toBeTruthy();
    expect(JSON.stringify(notice)).toContain("B");
    expect(JSON.stringify(notice)).toContain("A");
  });

  it("目标是群属主的话：可立即发送；撞 stopping 时该条放回（stop 不清群来源）", async () => {
    const taskId = "sn-owner";
    await mkTask(taskId);
    const owner = enq(taskId, "群属主话", {}, "group_owner");
    mockInject.mockResolvedValueOnce(STOPPING());
    const { deps } = makeDeps();

    const res = await sendQueuedTalkMessageNow(taskId, owner, deps);

    expect(res.status).toBe(409);
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([owner]);
  });

  it("条目已不在队里 → 409 queue_item_gone（客户端据此静默对齐，不弹错）", async () => {
    const taskId = "sn-gone";
    const { deps } = makeDeps();
    const res = await sendQueuedTalkMessageNow(taskId, "tq_nope", deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "queue_item_gone" });
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it("群回执 → 400 不支持；chat 任务 → 409；任务不存在 → 404；lifecycle 收尾中 → 409 且队列没被动", async () => {
    const taskId = "sn-guards";
    const reply = enq(taskId, "回执", {}, "group_reply");
    const a = enq(taskId, "A");

    expect((await sendQueuedTalkMessageNow(taskId, reply, makeDeps().deps)).status).toBe(400);
    expect(
      (
        await sendQueuedTalkMessageNow(
          taskId,
          a,
          makeDeps({ getTask: vi.fn(async (id: string) => taskOf(id, "chat")) }).deps,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await sendQueuedTalkMessageNow(
          taskId,
          a,
          makeDeps({ getTask: vi.fn(async () => null) }).deps,
        )
      ).status,
    ).toBe(404);
    const blocked = makeDeps({ getLifecycle: vi.fn(() => "stopping" as const) });
    expect((await sendQueuedTalkMessageNow(taskId, a, blocked.deps)).status).toBe(409);
    expect(blocked.deps.inject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([reply, a]);
    expect((await sendQueuedTalkMessageNow(taskId, "  ", makeDeps().deps)).status).toBe(400);
  });

  it("drain 锁被定时 drain 短暂占着：等它放开再继续，不让用户为这点巧合重点一次", async () => {
    const taskId = "sn-lock-wait";
    const other = enq(taskId, "别的");
    const b = enq(taskId, "B");
    // 模拟「另一个立即发送 / drain」占锁：取出 other 即占锁
    const held = beginTalkQueueSendNow(taskId, other);
    if (!held.ok) throw new Error("应取出");
    mockInject.mockResolvedValue(OK());
    let sleeps = 0;
    const { deps } = makeDeps({
      sleep: vi.fn(async () => {
        sleeps++;
        if (sleeps === 2) endTalkQueueSendNow(taskId, { putBack: held.item, rest: held.rest });
      }),
    });

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(200);
    expect(sleeps).toBe(2);
  });

  it("drain 锁一直占着：超过等待上限回 409 task_busy，不动队列", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const taskId = "sn-lock-timeout";
    const other = enq(taskId, "别的");
    // 用群属主来源：app 来源的其余会被占锁方救走、不在队里
    const b = enq(taskId, "B", {}, "group_owner");
    const held = beginTalkQueueSendNow(taskId, other);
    if (!held.ok) throw new Error("应取出");
    const { deps } = makeDeps({
      sleep: vi.fn(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms + 1000);
      }),
    });

    const res = await sendQueuedTalkMessageNow(taskId, b, deps);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "task_busy" });
    expect(TALK_SEND_NOW_LOCK_WAIT_MS).toBeGreaterThan(0);
    expect(deps.inject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId).map((i) => i.id)).toEqual([b]);
  });
});

describe("/talk-queue 路由：GET ?full=1 / PUT / POST", () => {
  const TASK_ID = "route_edit1";
  const ctx = { params: Promise.resolve({ id: TASK_ID }) };
  const req = (method: string, body?: unknown, url = "http://x/api/tasks/route_edit1/talk-queue") =>
    new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  it("GET 默认不带 texts；?full=1 带可编辑条的完整正文", async () => {
    await mkTask(TASK_ID);
    const long = "字".repeat(200);
    const id = enq(TASK_ID, long);
    enq(TASK_ID, "群里的", {}, "group_owner");

    const plain = (await (await talkQueueRoute.GET(req("GET"), ctx)).json()) as {
      items: unknown[];
      texts?: unknown;
    };
    expect(plain.items).toHaveLength(2);
    expect(plain).not.toHaveProperty("texts");

    const full = (await (
      await talkQueueRoute.GET(req("GET", undefined, "http://x/a?full=1"), ctx)
    ).json()) as { texts: Record<string, string> };
    expect(full.texts).toEqual({ [id]: long });
  });

  it("PUT：200 回新条目；已送出 → 409 queue_item_gone；群条 / 超长 / 空 → 400；任务不存在 → 404", async () => {
    await mkTask(TASK_ID);
    const id = enq(TASK_ID, "原");
    const owner = enq(TASK_ID, "群", {}, "group_owner");

    const ok = await talkQueueRoute.PUT(req("PUT", { itemId: id, text: "新" }), ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, item: { id, preview: "新" } });

    const gone = await talkQueueRoute.PUT(req("PUT", { itemId: "tq_nope", text: "x" }), ctx);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "queue_item_gone" });

    expect((await talkQueueRoute.PUT(req("PUT", { itemId: owner, text: "x" }), ctx)).status).toBe(400);
    expect(
      (await talkQueueRoute.PUT(req("PUT", { itemId: id, text: "x".repeat(20001) }), ctx)).status,
    ).toBe(400);
    expect((await talkQueueRoute.PUT(req("PUT", { itemId: id, text: "  " }), ctx)).status).toBe(400);
    expect((await talkQueueRoute.PUT(req("PUT", { itemId: id }), ctx)).status).toBe(400);
    expect(
      (
        await talkQueueRoute.PUT(req("PUT", { itemId: id, text: "x" }), {
          params: Promise.resolve({ id: "nope" }),
        })
      ).status,
    ).toBe(404);
    expect(listTalkQueueEditTexts(TASK_ID)[id]).toBe("新");
  });

  it("POST：缺 action / 缺 itemId / 坏 JSON → 400；action=send_now 走编排（条目不存在 → 409 gone）", async () => {
    await mkTask(TASK_ID);
    expect((await talkQueueRoute.POST(req("POST", { itemId: "a" }), ctx)).status).toBe(400);
    expect(
      (await talkQueueRoute.POST(req("POST", { action: "send_now" }), ctx)).status,
    ).toBe(400);
    expect(
      (
        await talkQueueRoute.POST(
          new Request("http://x", { method: "POST", body: "{" }),
          ctx,
        )
      ).status,
    ).toBe(400);
    const gone = await talkQueueRoute.POST(
      req("POST", { action: "send_now", itemId: "tq_nope" }),
      ctx,
    );
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "queue_item_gone" });
  });
});
