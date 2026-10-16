/**
 * G4-02 残留（服务端幂等）：空闲直送（200）路径按 (taskId, clientItemId) 去重。
 *
 * 此前服务端只在 queueIfBusy 排队路径用 clientItemId 去重；空闲时直送 200 的路径没有幂等——
 * 响应丢失（网络抖动 / 超时）后前端用同一个 clientItemId 重发（src/lib/talk-send-attempt.ts
 * 的失败重试会复用同 id），同一句话会被再注入一次、agent 收到两遍。
 *
 * 口径（与排队路径一致：只认带 clientItemId 的请求）：
 * - 送达成功（200）后登记；同 task + 同 id 再来 → 200 + `deduped: true`，不再注入；
 * - 不带 clientItemId 的请求行为完全不变；
 * - 失败（非 200）不登记，否则重试永远被吃掉；
 * - 带 TTL（2 分钟）与上限（200 条），防内存表无限长。
 *
 * 全走真实注入链 + 真实 route（只 mock 读盘 / 真正送达给 agent 的那一下）。
 * 每个用例用独一无二的 taskId / clientItemId，不依赖表的清理。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-deliver-dedupe-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks } = await import("@/lib/server/task-stream");
const taskStream = await import("@/lib/server/task-stream");
const taskFs = await import("@/lib/server/task-fs");
const taskRunner = await import("@/lib/server/task-runner");
const {
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  listTalkQueue,
} = await import("@/lib/server/task-talk-queue");
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
);
const questionRoute = await import("@/app/api/tasks/[id]/question/route");

// 与需求一致的契约值（见文件头）；这里写死、不从实现里 import，实现改了数字测试要报
const TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 200;

let seq = 0;
/** 每个用例独占的 taskId：登记表按 (taskId, clientItemId) 分，互不串 */
const freshTaskId = (): string => `dd_task_${++seq}_${Date.now()}`;

const metaOf = (
  id: string,
  runStatus: "idle" | "running" = "idle",
) => ({
  id,
  title: "t",
  mode: "task" as const,
  runStatus,
  repoStatus: "developing" as const,
  repoPaths: [] as string[],
  // 无 action：会话没了就走一次性答疑；这里 deliver 被 mock 成 sent，走不到
  actions: [] as unknown[],
  currentActionId: null,
  mrs: [],
  events: [] as unknown[],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

type DeliverFn = typeof taskRunner.deliverTaskQuestion;

/**
 * 搭「空闲 + 会话在、送达成功」：getTaskMeta 按 taskId 现造；
 * deliverTaskQuestion 默认 "sent"（可按次覆盖）；user_reply 落盘 mock 成功。
 * 返回送达 / 落盘的 spy，用来数「真正注入了几次」。
 */
const arrangeIdleDelivery = (
  opts: { status?: () => "idle" | "running" } = {},
) => {
  const status = opts.status ?? ((): "idle" => "idle");
  vi.spyOn(taskFs, "getTaskMeta").mockImplementation((async (id: string) =>
    metaOf(id, status())) as never);
  vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation((async (
    id: string,
  ) => metaOf(id, status())) as never);
  const deliver = vi
    .spyOn(taskRunner, "deliverTaskQuestion")
    .mockResolvedValue("sent" as Awaited<ReturnType<DeliverFn>>);
  const persist = vi
    .spyOn(taskStream, "writeUserEventAndPublishStrict")
    .mockResolvedValue({ id: "ev_1" } as never);
  return { deliver, persist };
};

const body = (extra: Record<string, unknown> = {}) => ({
  text: "同一句话",
  bootArgs: { apiKey: "k", model: { id: "m" } },
  ...extra,
});

const json = async (res: Response) =>
  (await res.json()) as {
    ok?: boolean;
    deduped?: boolean;
    task?: { id: string };
    error?: string;
  };

afterEach(() => {
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
  vi.restoreAllMocks();
});

describe("G4-02：空闲直送路径按 (taskId, clientItemId) 去重", () => {
  it("同 id 重发（响应丢失后的前端重试）→ 200 + deduped:true、不重复注入", async () => {
    const taskId = freshTaskId();
    const { deliver, persist } = arrangeIdleDelivery();

    const first = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-1" }),
    );
    expect(first.status).toBe(200);
    expect((await json(first)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);

    const retry = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-1" }),
    );
    expect(retry.status).toBe(200);
    const retryBody = await json(retry);
    expect(retryBody).toMatchObject({ ok: true, deduped: true });
    // 带回 task：前端 submitTaskQuestion 成功分支要读 data.task
    expect(retryBody.task?.id).toBe(taskId);
    // 真正的判据：agent 只收到一遍、user_reply 只落一条
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("走真实 route：不带 queueIfBusy、只带 clientItemId 的 POST 也去重", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const post = () =>
      questionRoute.POST(
        new Request(`http://x/api/tasks/${taskId}/question`, {
          method: "POST",
          body: JSON.stringify(body({ clientItemId: "  c-route  " })),
        }),
        { params: Promise.resolve({ id: taskId }) },
      );

    expect((await post()).status).toBe(200);
    const retry = await post();
    expect(retry.status).toBe(200);
    expect((await json(retry)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("不带 clientItemId：行为完全不变——每次都送达、没有 deduped", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();

    const a = await handleTaskQuestionInject(taskId, body());
    const b = await handleTaskQuestionInject(taskId, body());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await json(b)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("空白 clientItemId 视同没带（不会把所有空 id 请求吃成一条）", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();

    await handleTaskQuestionInject(taskId, body({ clientItemId: "   " }));
    await handleTaskQuestionInject(taskId, body({ clientItemId: "   " }));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("不同 id、不同 task 的同 id 互不影响", async () => {
    const taskA = freshTaskId();
    const taskB = freshTaskId();
    const { deliver } = arrangeIdleDelivery();

    await handleTaskQuestionInject(taskA, body({ clientItemId: "x" }));
    // 同 task 不同 id
    const other = await handleTaskQuestionInject(
      taskA,
      body({ clientItemId: "y" }),
    );
    // 不同 task 同 id
    const crossTask = await handleTaskQuestionInject(
      taskB,
      body({ clientItemId: "x" }),
    );
    expect((await json(other)).deduped).toBeUndefined();
    expect((await json(crossTask)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("失败不登记：首次送达被拒（409 stale）后同 id 重试要真送达，之后才被去重", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    deliver.mockResolvedValueOnce("stale" as Awaited<ReturnType<DeliverFn>>);

    const failed = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fail" }),
    );
    expect(failed.status).toBe(409);

    const retry = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fail" }),
    );
    expect(retry.status).toBe(200);
    expect((await json(retry)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);

    // 这回送达成功了，再来才是重复
    const again = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fail" }),
    );
    expect((await json(again)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("TTL 2 分钟：窗口内去重，过期后同 id 视作新请求", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);

    await handleTaskQuestionInject(taskId, body({ clientItemId: "c-ttl" }));
    expect(deliver).toHaveBeenCalledTimes(1);

    offset = TTL_MS - 1_000;
    const inWindow = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-ttl" }),
    );
    expect((await json(inWindow)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);

    offset = TTL_MS + 1_000;
    const expired = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-ttl" }),
    );
    expect(expired.status).toBe(200);
    expect((await json(expired)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it(`上限 ${MAX_ENTRIES} 条：超出后最老的被挤掉（可再送达），较新的仍去重`, async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();

    // 登记 MAX+1 条不同 id：第 0 条是最老的
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      const res = await handleTaskQuestionInject(
        taskId,
        body({ clientItemId: `cap-${i}` }),
      );
      expect(res.status).toBe(200);
    }
    expect(deliver).toHaveBeenCalledTimes(MAX_ENTRIES + 1);

    // 最新的仍在表里 → 去重
    const newest = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: `cap-${MAX_ENTRIES}` }),
    );
    expect((await json(newest)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(MAX_ENTRIES + 1);

    // 最老的已被挤出 → 当作新请求再送达
    const oldest = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "cap-0" }),
    );
    expect((await json(oldest)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(MAX_ENTRIES + 2);
  });
});

describe("G4-02：与排队路径的衔接", () => {
  it("排队 202 后同 id 在空闲时直送，随后队列重放同一条 → 去重、不二次注入", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    const { deliver } = arrangeIdleDelivery({ status: () => status });
    runningTasks.set(taskId, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });

    // agent 在跑：入队（202），响应假设丢了
    const queued = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-q" }),
      { queueIfBusy: { source: "app", clientItemId: "c-q" } },
    );
    expect(queued.status).toBe(202);
    expect(listTalkQueue(taskId)).toHaveLength(1);

    // 这一轮跑完、空闲了；用户在队列重放之前原样重发（同 id）→ 直送
    runningTasks.clear();
    status = "idle";
    const direct = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-q" }),
    );
    expect(direct.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);

    // 队列随后重放排着的那一条（rawBody 里仍带着同一个 clientItemId）：
    // 不去重就会把同一句话再注入一遍
    await __tickTalkQueueDrainForTest(taskId);
    expect(listTalkQueue(taskId)).toHaveLength(0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
