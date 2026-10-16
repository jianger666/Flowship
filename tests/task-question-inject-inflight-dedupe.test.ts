/**
 * P3-C（H3-01 / H2-06）：空闲直送幂等的「在途登记」与「正文指纹」。
 *
 * 上一轮（R4）的 deliveredDedupe 只在 200 **之后**登记，留下两个洞：
 * 1. 并发重发：第一次还挂在底层注入（deliverTaskQuestion）上、没返回，第二次同 id 已到——
 *    此刻表里没有它，第二次照样注入，agent 收到两遍；
 * 2. 只比 id：同 id 配不同正文也回 `deduped:true`，把真正的新消息吞了。
 *
 * 修法（入口同步登记「处理中」+ 表项带正文指纹）要钉住的行为：
 * - 同 id 同正文并发：只注入一次；后到者等第一次——成功 → deduped；失败 → 登记已撤销、
 *   后到者自己走一遍（消息不丢）；多个等待者之间只有一个真去注入；
 * - 同 id 不同正文：不是重复，按新消息注入；
 * - 失败（409 / 抛错 / opGen 复查拒 / closing / 202 入队 / 400）一律撤销在途登记；
 * - 僵死在途项可被接管、不泄漏；等待有上限（不接管、回 409，防双注入）；
 * - 等待期间 stop 整个跑完 → 等待者不得借「重试」把被取消的输入复活；
 * - deduped 的 200 回放首次的 persistWarning。
 *
 * 全走真实注入链（真 opGen / 真 lifecycle / 真队列 / 真 route），只 mock 读盘与「真正送达
 * agent」那一下；挂起用可控 promise、时钟用 fake timers（只 fake setTimeout / Date），
 * 不真实等待。契约数值写死、不从实现 import，实现改了数字测试要报。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-inflight-dedupe-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks, revokeTaskOps, PERSIST_WARNING_DELIVERED } = await import(
  "@/lib/server/task-stream"
);
const taskStream = await import("@/lib/server/task-stream");
const taskFs = await import("@/lib/server/task-fs");
const taskRunner = await import("@/lib/server/task-runner");
const taskArtifacts = await import("@/lib/server/task-artifacts");
const { beginChatLifecycle, clearChatGate } = await import(
  "@/lib/server/chat-gate"
);
const {
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  listTalkQueue,
} = await import("@/lib/server/task-talk-queue");
const {
  handleTaskQuestionInject,
  fingerprintTaskQuestionBody,
  __taskQuestionDedupeSnapshotForTest,
  __resetTaskQuestionDedupeForTest,
} = await import("@/lib/server/task-question-inject");
const questionRoute = await import("@/app/api/tasks/[id]/question/route");

/** 在途项僵死阈值 / 等待者等待上限（见实现注释：契约值） */
const STALE_MS = 5 * 60 * 1000;
const WAIT_MAX_MS = 60 * 1000;

let seq = 0;
const freshTaskId = (): string => `ifl_task_${++seq}`;

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
  actions: [] as unknown[],
  currentActionId: null,
  mrs: [],
  events: [] as unknown[],
  createdAt: 1,
  updatedAt: 1,
});

type DeliverFn = typeof taskRunner.deliverTaskQuestion;
type DeliverResult = Awaited<ReturnType<DeliverFn>>;

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
    .mockResolvedValue("sent" as DeliverResult);
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
    persistWarning?: string;
    task?: { id: string };
    error?: string;
  };

/** 让所有已就绪的微任务 / mock 的 async 链跑完（setImmediate 不被 fake） */
const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
};

/** 轮询到 spy 被调用到 n 次（用于「第一次已走到底层注入」的同步点） */
const untilCalled = async (
  spy: { mock: { calls: unknown[] } },
  n: number,
): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (spy.mock.calls.length >= n) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`等不到第 ${n} 次调用（当前 ${spy.mock.calls.length}）`);
};

/**
 * 断言这个 promise 在 flush 内就完成——残留在途项会让后来者挂在等待上，
 * 这里立即红，而不是拖到 vitest 超时。
 */
const promptly = async <T>(p: Promise<T>, label: string): Promise<T> => {
  let done = false;
  let value: T | undefined;
  let failure: unknown;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      failure = e;
    },
  );
  await flush(20);
  if (!done) throw new Error(`${label}：flush 后仍未完成（疑似在等残留的在途项）`);
  if (failure !== undefined) throw failure;
  return value as T;
};

const gate = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * 该 task 名下残留的在途项。key 形如 `${taskId}\0${id}\0${指纹}`，必须带分隔符匹配：
 * 只用 startsWith(taskId) 的话 `ifl_task_1` 会误匹配 `ifl_task_10…19` 的项。
 */
const keyPrefixOf = (taskId: string): string => `${taskId}\u0000`;
const inflightOf = (taskId: string): string[] =>
  __taskQuestionDedupeSnapshotForTest().inflight.filter((k) =>
    k.startsWith(keyPrefixOf(taskId)),
  );

/** 在途登记已撤销的判据：登记表里没有它；同 id 重发立即真注入（不等待、不 deduped） */
const expectCleanRetry = async (
  taskId: string,
  itemId: string,
  deliver: { mock: { calls: unknown[] } },
): Promise<void> => {
  expect(inflightOf(taskId)).toEqual([]);
  const before = deliver.mock.calls.length;
  const res = await promptly(
    handleTaskQuestionInject(taskId, body({ clientItemId: itemId })),
    "失败后同 id 重发",
  );
  expect(res.status).toBe(200);
  expect((await json(res)).deduped).toBeUndefined();
  expect(deliver.mock.calls.length).toBe(before + 1);
};

beforeEach(() => {
  // 只 fake 定时器与 Date：promise / setImmediate 照常，flush 才能推动 mock 链
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
  vi.restoreAllMocks();
  // 用例间清表：某条用例失败时会遗留挂起的在途项，不清的话后面用例的僵死清扫 /
  // 容量冲击会把它 settle，遗留的等待者「诈尸」去调下一条用例的 mock，
  // 红灯就从真实缺陷扩散成一串无关的连带失败。reset 会把在途项 settle 为失败——
  // 放在 restoreAllMocks 之后、再 flush 一下：诈尸者此时只会撞上真实（空数据目录的）
  // getTaskMeta 回 404 就收尾，碰不到下一条用例的 spy。
  __resetTaskQuestionDedupeForTest();
  await flush();
});

describe("H3-01：同 clientItemId + 同正文的并发重发只注入一次", () => {
  it("第一次挂在底层注入上、第二次已到 → 不双注入；第一次成功后第二次回 deduped:true", async () => {
    const taskId = freshTaskId();
    const { deliver, persist } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-1" }));
    await untilCalled(deliver, 1);

    let bDone = false;
    const pB = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-1" }),
    ).then((r) => {
      bDone = true;
      return r;
    });
    await flush();
    // 关键：第一次还没返回时，第二次不能自己去注入，也不能抢先回 deduped
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(bDone).toBe(false);

    g.resolve("sent");
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.status).toBe(200);
    expect((await json(a)).deduped).toBeUndefined();
    expect(b.status).toBe(200);
    expect(await json(b)).toMatchObject({
      ok: true,
      deduped: true,
      task: { id: taskId },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(inflightOf(taskId)).toEqual([]);
  });

  it("三个并发（第一次 + 两个重发）→ 仍只注入一次", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-3" }));
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-3" }));
    const pC = handleTaskQuestionInject(taskId, body({ clientItemId: "c-3" }));
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    g.resolve("sent");
    const [a, b, c] = await Promise.all([pA, pB, pC]);
    expect((await json(a)).deduped).toBeUndefined();
    expect((await json(b)).deduped).toBe(true);
    expect((await json(c)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("走真实 route：并发 POST 同样只注入一次", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);
    const post = () =>
      questionRoute.POST(
        new Request(`http://x/api/tasks/${taskId}/question`, {
          method: "POST",
          body: JSON.stringify(body({ clientItemId: "c-route" })),
        }),
        { params: Promise.resolve({ id: taskId }) },
      );

    const pA = post();
    await untilCalled(deliver, 1);
    const pB = post();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    g.resolve("sent");
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.status).toBe(200);
    expect((await json(b)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("重发时 clientSentAt / apiKey 变了也算同一条（指纹只看会被注入的内容）", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();

    await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-vary", clientSentAt: 1000 }),
    );
    const retry = await handleTaskQuestionInject(
      taskId,
      body({
        clientItemId: "c-vary",
        clientSentAt: 99999,
        bootArgs: { apiKey: "other-key", model: { id: "m2" } },
      }),
    );
    expect((await json(retry)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("H3-01：第一次失败 → 在途登记撤销，等待者自己重试（消息不丢）", () => {
  it("第一次 409（stale）→ 等待者随后自己注入并成功；之后再来才是重复", async () => {
    const taskId = freshTaskId();
    const { deliver, persist } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-f1" }));
    await untilCalled(deliver, 1);
    let bDone = false;
    const pB = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-f1" }),
    ).then((r) => {
      bDone = true;
      return r;
    });
    await flush();
    // 第一次失败之前，等待者不得抢先注入（否则第一次若成功就是双注入）
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(bDone).toBe(false);

    g.resolve("stale");
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.status).toBe(409);
    expect(b.status).toBe(200);
    expect((await json(b)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
    // user_reply 只落一条：第一次 stale 前没写，是等待者写的
    expect(persist).toHaveBeenCalledTimes(1);

    const again = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-f1" }),
    );
    expect((await json(again)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("第一次抛错 → 异常照常抛给第一次的调用方，等待者自己重试成功", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-f2" }),
    ).then(
      (r) => ({ r }),
      (e: unknown) => ({ e }),
    );
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-f2" }));
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    g.reject(new Error("boom"));
    const a = await pA;
    expect("e" in a ? (a.e as Error).message : null).toBe("boom");
    const b = await pB;
    expect(b.status).toBe(200);
    expect((await json(b)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("两个等待者 + 第一次失败 → 只有一个去重试、另一个跟着它（不双注入）", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-f3" }));
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-f3" }));
    const pC = handleTaskQuestionInject(taskId, body({ clientItemId: "c-f3" }));
    await flush();

    g.resolve("stale");
    const [a, b, c] = await Promise.all([pA, pB, pC]);
    expect(a.status).toBe(409);
    const bj = await json(b);
    const cj = await json(c);
    // 恰好一个真注入（无 deduped）、一个跟随（deduped）
    expect([bj.deduped, cj.deduped].filter((d) => d === true)).toHaveLength(1);
    expect([bj.deduped, cj.deduped].filter((d) => d === undefined)).toHaveLength(
      1,
    );
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("等待期间 stop 整个跑完 → 等待者回 409 作废、不借重试把被取消的输入复活", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-stop" }));
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-stop" }));
    await flush();

    // stop 在 B 等待期间整个跑完（opGen 已 bump、lifecycle 已放开）；A 因此被作废
    revokeTaskOps(taskId);
    g.resolve("stale");
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.status).toBe(409);
    expect(b.status).toBe(409);
    expect((await json(b)).error).toBe(taskRunner.TASK_OP_STALE_HTTP_MESSAGE);
    expect(deliver).toHaveBeenCalledTimes(1);

    // stop 之后用户的新一次发送（新 opGen）不受影响
    const fresh = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-stop" }),
    );
    expect(fresh.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

describe("H3-01：失败（各类非 200 / 抛错）都撤销在途登记", () => {
  it("deliver 返回 stale → 409，登记撤销、重发能真注入", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    deliver.mockResolvedValueOnce("stale" as DeliverResult);
    const res = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-x1" }),
    );
    expect(res.status).toBe(409);
    await expectCleanRetry(taskId, "c-x1", deliver);
  });

  it("deliver 抛错 → 异常上抛，登记撤销、重发能真注入", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    deliver.mockRejectedValueOnce(new Error("boom"));
    await expect(
      handleTaskQuestionInject(taskId, body({ clientItemId: "c-x2" })),
    ).rejects.toThrow("boom");
    await expectCleanRetry(taskId, "c-x2", deliver);
  });

  it("送达后 opGen 复查被拒（deliver 期间 stop 跑完）→ 409，登记撤销、重发能真注入", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    deliver.mockImplementationOnce((async () => {
      revokeTaskOps(taskId);
      return "sent";
    }) as never);
    const res = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-x3" }),
    );
    expect(res.status).toBe(409);
    await expectCleanRetry(taskId, "c-x3", deliver);
  });

  it("closing（lifecycle=stopping）409 → 登记撤销、放开后重发能真注入", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    beginChatLifecycle(taskId, "stopping");
    const res = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-x4" }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain("停止");
    expect(deliver).not.toHaveBeenCalled();
    clearChatGate(taskId);
    await expectCleanRetry(taskId, "c-x4", deliver);
  });

  it("请求校验失败 400（缺 bootArgs）→ 登记撤销、补齐后重发能真注入", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const res = await handleTaskQuestionInject(taskId, {
      text: "同一句话",
      clientItemId: "c-x5",
    });
    expect(res.status).toBe(400);
    await expectCleanRetry(taskId, "c-x5", deliver);
  });

  it("202 入队（不是送达）→ 不留在途、不登记已送达；之后空闲直送同 id 能真注入", async () => {
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
    const queued = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-x6" }),
      { queueIfBusy: { source: "app", clientItemId: "c-x6" } },
    );
    expect(queued.status).toBe(202);
    expect(inflightOf(taskId)).toEqual([]);

    runningTasks.clear();
    status = "idle";
    await expectCleanRetry(taskId, "c-x6", deliver);
  });
});

describe("H3-01：与排队重放的并发", () => {
  it("直送同 id 还挂在底层注入时队列重放同一条 → 重放者等它、不二次注入", async () => {
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
    // 忙 → 入队（响应假设丢了）
    const queued = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-qr" }),
      { queueIfBusy: { source: "app", clientItemId: "c-qr" } },
    );
    expect(queued.status).toBe(202);
    expect(listTalkQueue(taskId)).toHaveLength(1);

    // 空闲了；用户重发同 id → 直送，挂在底层注入上
    runningTasks.clear();
    status = "idle";
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);
    const pDirect = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-qr" }),
    );
    await untilCalled(deliver, 1);

    // 队列此刻重放同一条：必须等直送，而不是并发再注入
    const pDrain = __tickTalkQueueDrainForTest(taskId);
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    g.resolve("sent");
    const direct = await pDirect;
    await pDrain;
    expect(direct.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });
});

describe("H2-06：同 id 不同正文不是重复（正文指纹）", () => {
  it("先后两条：第二条按新消息注入（agent 收到的是新正文），各自重发才各自去重", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();

    const a = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fp", text: "第一句话" }),
    );
    expect((await json(a)).deduped).toBeUndefined();

    const b = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fp", text: "完全不同的第二句话" }),
    );
    expect(b.status).toBe(200);
    expect((await json(b)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
    // 注入给 agent 的确实是新正文（没被吞、也没拿旧正文顶替）
    expect(String(deliver.mock.calls[1]?.[1])).toContain("完全不同的第二句话");

    // 各自的重发各自命中
    const retryA = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fp", text: "第一句话" }),
    );
    const retryB = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fp", text: "完全不同的第二句话" }),
    );
    expect((await json(retryA)).deduped).toBe(true);
    expect((await json(retryB)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("第一条还在途时同 id 不同正文到达 → 不等待、直接按新消息注入", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-fp2", text: "在途的第一句" }),
    );
    await untilCalled(deliver, 1);

    const b = await promptly(
      handleTaskQuestionInject(
        taskId,
        body({ clientItemId: "c-fp2", text: "后到的另一句" }),
      ),
      "同 id 不同正文",
    );
    expect(b.status).toBe(200);
    expect((await json(b)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);

    g.resolve("sent");
    expect((await pA).status).toBe(200);
  });

  it("同 id 同 text、图片不同 → 不是重复；图片相同才去重", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    vi.spyOn(taskArtifacts, "saveImageAttachments").mockImplementation((async (
      _id: string,
      imgs: Array<{ filename?: string }>,
    ) =>
      imgs.map((im, i) => ({
        absPath: `/tmp/fake-${i}.png`,
        name: im.filename ?? `img-${i}.png`,
      }))) as never);
    const img = (data: string) => ({
      data,
      mimeType: "image/png",
      filename: "a.png",
    });

    await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-img", images: [img("AAAA")] }),
    );
    const other = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-img", images: [img("BBBB")] }),
    );
    expect((await json(other)).deduped).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);

    const same = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-img", images: [img("AAAA")] }),
    );
    expect((await json(same)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("表里只存指纹：key 不含正文原文", async () => {
    const taskId = freshTaskId();
    arrangeIdleDelivery();
    const marker = "ULTRA-SECRET-BODY-MARKER-12345";
    const g = gate<DeliverResult>();
    vi.spyOn(taskRunner, "deliverTaskQuestion").mockImplementationOnce(
      (() => g.promise) as never,
    );
    const p = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-leak", text: marker }),
    );
    await flush();
    // 在途期间 + 送达之后两个阶段都不能把原文放进表
    expect(JSON.stringify(__taskQuestionDedupeSnapshotForTest())).not.toContain(
      marker,
    );
    g.resolve("sent");
    await p;
    const snap = __taskQuestionDedupeSnapshotForTest();
    expect(snap.delivered.some((k) => k.startsWith(keyPrefixOf(taskId)))).toBe(
      true,
    );
    expect(JSON.stringify(snap)).not.toContain(marker);
  });
});

describe("fingerprintTaskQuestionBody：对会被注入的内容取稳定哈希", () => {
  const base = {
    text: "hello",
    images: [{ data: "AAAA", mimeType: "image/png", filename: "a.png" }],
    attachments: ["/tmp/a"],
    skills: [{ name: "s", absPath: "/skills/s" }],
  };

  it("稳定：同内容同指纹；输出是 sha256 hex、不含原文", () => {
    const fp = fingerprintTaskQuestionBody(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintTaskQuestionBody(structuredClone(base))).toBe(fp);
    expect(fp).not.toContain("hello");
  });

  it("text 首尾空白与注入端同口径（trim）", () => {
    expect(fingerprintTaskQuestionBody({ ...base, text: "  hello \n" })).toBe(
      fingerprintTaskQuestionBody(base),
    );
  });

  it("文本 / 图片 / 附件 / skill 任何一项不同 → 指纹不同", () => {
    const fp = fingerprintTaskQuestionBody(base);
    const variants: Array<Record<string, unknown>> = [
      { ...base, text: "hello!" },
      { ...base, images: [{ ...base.images[0], data: "AAAB" }] },
      { ...base, images: [{ ...base.images[0], mimeType: "image/jpeg" }] },
      { ...base, images: [{ ...base.images[0], filename: "b.png" }] },
      { ...base, images: [] },
      { ...base, attachments: ["/tmp/b"] },
      { ...base, attachments: [] },
      { ...base, skills: [{ name: "s", absPath: "/skills/other" }] },
      { ...base, skills: [] },
    ];
    for (const v of variants) {
      expect(fingerprintTaskQuestionBody(v)).not.toBe(fp);
    }
  });

  it("字段边界无歧义（text+附件拼起来相同也不撞）", () => {
    const a = fingerprintTaskQuestionBody({ text: "ab", attachments: [] });
    const b = fingerprintTaskQuestionBody({ text: "a", attachments: ["b"] });
    const c = fingerprintTaskQuestionBody({ text: "", attachments: ["ab"] });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("不含 clientSentAt / bootArgs / forceModel 等非正文字段", () => {
    const fp = fingerprintTaskQuestionBody(base);
    expect(
      fingerprintTaskQuestionBody({
        ...base,
        clientSentAt: 123,
        clientItemId: "x",
        bootArgs: { apiKey: "k" },
        forceModel: { id: "m" },
      }),
    ).toBe(fp);
  });

  it("畸形输入（null / 非对象 / 字段类型错）不抛", () => {
    expect(() => fingerprintTaskQuestionBody(null)).not.toThrow();
    expect(() => fingerprintTaskQuestionBody("x")).not.toThrow();
    expect(() =>
      fingerprintTaskQuestionBody({ text: 1, images: "x", attachments: [1] }),
    ).not.toThrow();
  });
});

describe("H3-01：在途项不泄漏（僵死接管 / 等待上限 / 清扫）", () => {
  it("等待有上限：在途没僵死但挂超过上限 → 等待者回 409（不接管、不注入）；第一次最终成功后登记转已送达", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-w" }));
    await untilCalled(deliver, 1);
    let bDone = false;
    const pB = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-w" }),
    ).then((r) => {
      bDone = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(WAIT_MAX_MS - 1_000);
    await flush();
    expect(bDone).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const b = await pB;
    expect(b.status).toBe(409);
    expect((await json(b)).error).toContain("处理中");
    expect(deliver).toHaveBeenCalledTimes(1);
    // 第一次仍在途：登记还在
    expect(inflightOf(taskId)).toHaveLength(1);

    g.resolve("sent");
    expect((await pA).status).toBe(200);
    expect(inflightOf(taskId)).toEqual([]);
    // 客户端稍后重试 → 已送达 → deduped
    const retry = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-w" }),
    );
    expect((await json(retry)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("在途超过僵死阈值 → 后来者接管（自己注入）；僵死那次迟到完成不影响接管者的登记", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const gA = gate<DeliverResult>();
    const gB = gate<DeliverResult>();
    deliver
      .mockImplementationOnce((() => gA.promise) as never)
      .mockImplementationOnce((() => gB.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-s" }));
    await untilCalled(deliver, 1);

    await vi.advanceTimersByTimeAsync(STALE_MS + 1_000);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-s" }));
    await untilCalled(deliver, 2); // 接管：没有等第一次
    expect(deliver).toHaveBeenCalledTimes(2);

    // 僵死的第一次这时才失败：不得把接管者的登记撤掉
    gA.resolve("stale");
    expect((await pA).status).toBe(409);
    expect(inflightOf(taskId)).toHaveLength(1);

    // 所以后到的 C 仍然要等接管者（B），不会自己注入第三次
    let cDone = false;
    const pC = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-s" }),
    ).then((r) => {
      cDone = true;
      return r;
    });
    await flush();
    expect(cDone).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(2);

    gB.resolve("sent");
    const [b, c] = await Promise.all([pB, pC]);
    expect(b.status).toBe(200);
    expect((await json(c)).deduped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(inflightOf(taskId)).toEqual([]);
  });

  it("僵死项在没人重发同 id 时也会被后续入口清扫（不随挂起请求常驻）", async () => {
    const taskA = freshTaskId();
    const taskB = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskA, body({ clientItemId: "c-sw" }));
    await untilCalled(deliver, 1);
    expect(inflightOf(taskA)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(STALE_MS + 1_000);
    // 任意别的带 clientItemId 的请求进来都会顺手清扫
    await handleTaskQuestionInject(taskB, body({ clientItemId: "other" }));
    expect(inflightOf(taskA)).toEqual([]);

    g.resolve("sent");
    await pA; // 迟到完成不崩
  });

  it("在途项不被已送达表的容量淘汰误删（>200 条已送达期间在途项仍互斥）", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeIdleDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-keep", text: "在途那条" }),
    );
    await untilCalled(deliver, 1);

    // 冲击已送达表：登记 205 条不同 id，触发容量淘汰
    for (let i = 0; i < 205; i++) {
      await handleTaskQuestionInject(
        taskId,
        body({ clientItemId: `fill-${i}`, text: `填充 ${i}` }),
      );
    }
    expect(deliver).toHaveBeenCalledTimes(206);

    // 在途那条的重发仍要等它、不能被当成没登记
    let bDone = false;
    const pB = handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-keep", text: "在途那条" }),
    ).then((r) => {
      bDone = true;
      return r;
    });
    await flush();
    expect(bDone).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(206);

    g.resolve("sent");
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.status).toBe(200);
    expect((await json(b)).deduped).toBe(true);
  });
});

describe("H2-06：deduped 的 200 回放首次的 persistWarning", () => {
  it("首次送达但 user_reply 落盘失败 → 200 + persistWarning；重发 deduped 同样带上（响应丢了用户也不该丢告警）", async () => {
    const taskId = freshTaskId();
    const { deliver, persist } = arrangeIdleDelivery();
    persist.mockResolvedValue(null as never);

    const first = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-pw" }),
    );
    expect(first.status).toBe(200);
    expect((await json(first)).persistWarning).toBe(PERSIST_WARNING_DELIVERED);

    const retry = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "c-pw" }),
    );
    const retryBody = await json(retry);
    expect(retryBody.deduped).toBe(true);
    expect(retryBody.persistWarning).toBe(PERSIST_WARNING_DELIVERED);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("等待者跟随第一次成功时也带 persistWarning；落盘成功的不带", async () => {
    const taskId = freshTaskId();
    const { deliver, persist } = arrangeIdleDelivery();
    persist.mockResolvedValue(null as never);
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-pw2" }));
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-pw2" }));
    await flush();
    g.resolve("sent");
    const [, b] = await Promise.all([pA, pB]);
    const bj = await json(b);
    expect(bj.deduped).toBe(true);
    expect(bj.persistWarning).toBe(PERSIST_WARNING_DELIVERED);

    // 对照：落盘正常的那条重发不带 persistWarning
    persist.mockResolvedValue({ id: "ev" } as never);
    await handleTaskQuestionInject(taskId, body({ clientItemId: "ok-1" }));
    const okRetry = await handleTaskQuestionInject(
      taskId,
      body({ clientItemId: "ok-1" }),
    );
    expect((await json(okRetry)).persistWarning).toBeUndefined();
  });
});
