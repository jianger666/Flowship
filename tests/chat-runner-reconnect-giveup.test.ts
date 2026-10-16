/**
 * chat 自动重连放弃 / run 出错时的收尾（S04-01 / S05-01）
 *
 * S04-01：重连在退避前已把坏实例摘表（runReconnectAttempt → closeChatSession(stale)），
 * 放弃（次数耗尽 / 不可重试 / 凭据缺失）后 consumeChatRun 走 handleChatRunFailure，
 * 实例 CAS 因表空必然落空 → runStatus 永远停在 running、没有 error 事件。
 * 修复：表空 + 本实例已被重连链摘除 → finalizeReconnectGaveUp 落 error 事件 + error 状态 + done(ok=false)。
 *
 * S05-01：run 出错清队（failQueuedItems reason=error）前端静默清占位、不弹 toast，
 * 用户看不出排队的话被丢了 → 清队后落一条 info「N 条排队消息未送达」。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 重连退避用真计时器（首次退避 2s），不用 fake timers——避免和落盘 / SDK deadline 的 setTimeout 互相干扰。
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
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-reconnect-giveup-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const {
  beginChatQueueInFlight,
  enqueueChatMessage,
  getChatQueueCount,
  findRecentSettledEntry,
} = await import("@/lib/server/chat-queue");
const { getTask, setTaskRunStatus } = await import("@/lib/server/task-fs");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-reconnect-giveup DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000002000_reconnect_giveup";
const AGENT_ID = "agent_fake_giveup";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `reconnect giveup ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

const hasReconnectingEvent = (events: TaskEvent[], attempt: number): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      e.meta?.kind === "reconnecting" &&
      e.meta?.attempt === attempt,
  );

/** 入队一条排队消息（模拟「run 在跑时用户又发了一句」） */
const enqueueOne = (itemId: string, text = "排队的话"): void => {
  const r = enqueueChatMessage(TASK_ID, {
    itemId,
    agentText: text,
    displayText: text,
    enqueuedAt: Date.now(),
  });
  expect(r).toMatchObject({ ok: true });
};

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 是惰性的（首次 getTask 才跑），会把「当时是 running」的任务标成 error。
  // 在任务还是 idle 时先触发一次，之后用例里的 running 才不会被它提前改成中间状态
  await getTask(TASK_ID);
  // 自动重连读服务端凭据（readServerChatCreds）：钉一份 config.json
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      apiKey: "server-key",
      defaultModel: { id: "gpt-test", params: [] },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("chat 自动重连放弃 → 落 error（S04-01）", () => {
  it(
    "重连 resume 后 send 抛不可重试错 → 放弃：runStatus=error + error 事件 + 无会话/闩锁残留，排队消息有提示",
    async () => {
      // 实例 A：run stream 立抛网络错 → 进自动重连（第 1 次退避 2s）。
      // 流里等 gate，保证测试能在 run 在飞时先入队一条排队消息
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((r) => {
        releaseStream = r;
      });
      const failingRun = {
        stream: async function* (): AsyncGenerator<never> {
          await streamGate;
          throw new Error("fetch failed");
        },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      const agentASend = vi.fn().mockResolvedValue(failingRun);
      // 重连实例 R：reconnect prompt send 抛「不可重试」错（invalid key）→ 重连链放弃
      const agentRSend = vi.fn().mockRejectedValue(new Error("invalid api key"));
      mockResume
        .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: agentASend })
        .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: agentRSend });

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

      // run 在飞时排一条消息，随后放行 stream 触发失败
      enqueueOne("item_giveup_q1");
      expect(getChatQueueCount(TASK_ID)).toBe(1);
      releaseStream();

      // 等到重连链放弃「收尾完成」：R 的 send 被调过 + 表内无会话 + error 状态 + 清队 + 「未送达」提示落盘。
      // 不能只等 runStatus=error：task-fs 的 boot recovery 是惰性触发的，可能在放弃收尾之前就把
      // running 的任务标成 error，导致「状态已 error」先于「清队 / 提示」成立（测试竞态、非生产顺序问题）
      await vi.waitFor(
        async () => {
          expect(agentRSend).toHaveBeenCalledTimes(1);
          expect(hasChatSession(TASK_ID)).toBe(false);
          const meta = await readMetaV06(TASK_ID);
          expect(meta?.runStatus).toBe("error");
          expect(getChatQueueCount(TASK_ID)).toBe(0);
          const evs = await readEvents(TASK_ID);
          expect(
            evs.some(
              (e) => e.kind === "info" && e.text.includes("1 条排队消息未送达"),
            ),
          ).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );

      const events = await readEvents(TASK_ID);
      expect(hasReconnectingEvent(events, 1)).toBe(true);
      // 带可读原因的 error 事件
      expect(
        events.some((e) => e.kind === "error" && e.text.includes("自动重连失败")),
      ).toBe(true);
      // 闩锁 / 租约：会话摘净、不再假 busy
      expect(isChatRunActive(TASK_ID)).toBe(false);
      expect(hasChatSession(TASK_ID)).toBe(false);
      // 排队消息：队列已清 + ledger 有终态 + 事件流有「未送达」提示（S05-01）
      expect(getChatQueueCount(TASK_ID)).toBe(0);
      expect(findRecentSettledEntry(TASK_ID, "item_giveup_q1")?.outcome).toBe(
        "error",
      );
      expect(
        events.some(
          (e) => e.kind === "info" && e.text.includes("1 条排队消息未送达"),
        ),
      ).toBe(true);
    },
    25_000,
  );
});

describe("run 出错清队要给用户提示（S05-01）", () => {
  it("run 以不可重试错误结束 → error 状态 + 队列清空并落「未送达」info", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => {
      releaseStream = r;
    });
    const failingRun = {
      stream: async function* (): AsyncGenerator<never> {
        await streamGate;
        // 不可重试 → 不进重连，直接常规 error 收尾
        throw new Error("invalid api key");
      },
      wait: async () => ({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(failingRun),
    });

    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "会失败的消息")).toBe("sent");
    enqueueOne("item_err_q1");
    enqueueOne("item_err_q2");
    releaseStream();

    await vi.waitFor(
      async () => {
        expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
        expect(hasChatSession(TASK_ID)).toBe(false);
        const events = await readEvents(TASK_ID);
        expect(
          events.some(
            (e) => e.kind === "info" && e.text.includes("2 条排队消息未送达"),
          ),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(isChatRunActive(TASK_ID)).toBe(false);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("重连放弃收尾的边界（R2-04 / R2-05 / R2-06）", () => {
  /** A 实例：流先吐 prelude 再等 gate、然后抛网络错进自动重连；R 实例的 send 抛不可重试错 → 放弃 */
  const startFailingRun = async (
    prelude: unknown[] = [],
  ): Promise<{
    releaseStream: () => void;
    agentRSend: ReturnType<typeof vi.fn>;
  }> => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => {
      releaseStream = r;
    });
    const failingRun = {
      stream: async function* (): AsyncGenerator<unknown> {
        for (const m of prelude) yield m;
        await streamGate;
        throw new Error("fetch failed");
      },
      wait: async () => ({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const agentRSend = vi.fn().mockRejectedValue(new Error("invalid api key"));
    mockResume
      .mockResolvedValueOnce({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(failingRun),
      })
      .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: agentRSend });
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");
    return { releaseStream, agentRSend };
  };

  it("R2-05：流到一半断线、有未配对 tool_call → 放弃收尾把它补成 interrupted（先于 error 事件）", async () => {
    const { releaseStream, agentRSend } = await startFailingRun([
      {
        type: "tool_call",
        name: "read_file",
        call_id: "call_open_1",
        status: "running",
        args: { path: "a.ts" },
      },
    ]);
    releaseStream();

    await vi.waitFor(
      async () => {
        expect(agentRSend).toHaveBeenCalledTimes(1);
        expect(hasChatSession(TASK_ID)).toBe(false);
        const evs = await readEvents(TASK_ID);
        expect(
          evs.some((e) => e.kind === "error" && e.text.includes("自动重连失败")),
        ).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );

    const events = await readEvents(TASK_ID);
    const callIdx = events.findIndex(
      (e) => e.kind === "tool_call" && e.meta?.callId === "call_open_1",
    );
    const resultIdx = events.findIndex(
      (e) => e.kind === "tool_result" && e.meta?.callId === "call_open_1",
    );
    const errorIdx = events.findIndex(
      (e) => e.kind === "error" && e.text.includes("自动重连失败"),
    );
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(callIdx);
    expect(events[resultIdx]?.meta?.status).toBe("interrupted");
    expect(resultIdx).toBeLessThan(errorIdx);
    expect(isChatRunActive(TASK_ID)).toBe(false);
  }, 25_000);

  it("R2-04：退避期间任务已被 stop 写成 idle → 放弃时不落 error 事件、不发 error/done(ok=false)、状态保持 idle", async () => {
    const seen: Array<{ kind: string; ok?: boolean }> = [];
    const unsub = subscribeTaskStream(TASK_ID, (ev) => {
      seen.push({ kind: ev.kind, ok: (ev as { ok?: boolean }).ok });
    });
    try {
      const { releaseStream, agentRSend } = await startFailingRun();
      releaseStream();
      // 进入退避（A 已摘表）后模拟用户 stop 已把盘上状态写成 idle
      await vi.waitFor(
        async () => {
          expect(hasReconnectingEvent(await readEvents(TASK_ID), 1)).toBe(true);
        },
        { timeout: 5_000, interval: 30 },
      );
      await setTaskRunStatus(TASK_ID, "idle");
      seen.length = 0;

      await vi.waitFor(
        () => {
          expect(agentRSend).toHaveBeenCalledTimes(1);
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
      // 给放弃收尾留出落盘 / publish 的时间（旧实现这里会写 error 事件并把状态改成 error）
      await sleep(400);

      const events = await readEvents(TASK_ID);
      expect(
        events.some((e) => e.kind === "error" && e.text.includes("自动重连失败")),
      ).toBe(false);
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("idle");
      expect(seen.some((e) => e.kind === "error")).toBe(false);
      expect(seen.some((e) => e.kind === "done" && e.ok === false)).toBe(false);
      expect(isChatRunActive(TASK_ID)).toBe(false);
    } finally {
      unsub();
    }
  }, 25_000);

  it("R2-06：error 清队的提示附每条被丢弃消息的摘要（80 字截断、空白折叠），完整文本放 meta.droppedTexts", async () => {
    const { releaseStream, agentRSend } = await startFailingRun();
    const long = `甲${"长".repeat(199)}尾`; // 201 字：摘要必须被截断、meta 里是完整原文
    const huge = `乙${"大".repeat(2999)}`; // 3000 字：meta 里被截到 2000 字
    enqueueOne("item_drop_1", long);
    enqueueOne("item_drop_2", "第二条\n带   换行");
    enqueueOne("item_drop_3", huge);
    releaseStream();

    await vi.waitFor(
      async () => {
        expect(agentRSend).toHaveBeenCalledTimes(1);
        const evs = await readEvents(TASK_ID);
        expect(
          evs.some((e) => e.kind === "info" && e.text.includes("3 条排队消息未送达")),
        ).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );

    const notice = (await readEvents(TASK_ID)).find(
      (e) => e.kind === "info" && e.text.includes("3 条排队消息未送达"),
    )!;
    // 摘要：第一条被截断（不含末尾「尾」），第二条空白折叠
    expect(notice.text).toContain("甲");
    expect(notice.text).not.toContain("尾");
    expect(notice.text).toContain("第二条 带 换行");
    expect(notice.text).not.toContain("大".repeat(100));
    // 每条摘要行长度受限（"- " 前缀 + 80 字 + 省略号）
    for (const line of notice.text.split("\n").filter((l) => l.startsWith("- "))) {
      expect(Array.from(line).length).toBeLessThanOrEqual(2 + 80 + 1);
    }
    // meta：只存文本；完整原文 / 超长截到 2000 字
    const texts = notice.meta?.droppedTexts as string[];
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe(long);
    expect(texts[1]).toBe("第二条\n带   换行");
    expect(texts[2]!.startsWith("乙大")).toBe(true);
    expect(Array.from(texts[2]!).length).toBeLessThanOrEqual(2001);
    expect(notice.meta?.droppedItemIds).toEqual([
      "item_drop_1",
      "item_drop_2",
      "item_drop_3",
    ]);
    // 不把附件 / 图片之类塞进 meta
    expect(Object.keys(notice.meta ?? {}).sort()).toEqual([
      "droppedItemIds",
      "droppedTexts",
    ]);
  }, 25_000);

  it("R2-06：拿不到文本的条（已出队的 in-flight 条）只计数，提示写「…等 N 条」", async () => {
    const { releaseStream, agentRSend } = await startFailingRun();
    beginChatQueueInFlight(TASK_ID, "item_inflight_x");
    enqueueOne("item_drop_a", "排队甲");
    enqueueOne("item_drop_b", "排队乙");
    releaseStream();

    await vi.waitFor(
      async () => {
        expect(agentRSend).toHaveBeenCalledTimes(1);
        const evs = await readEvents(TASK_ID);
        expect(
          evs.some((e) => e.kind === "info" && e.text.includes("3 条排队消息未送达")),
        ).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    const notice = (await readEvents(TASK_ID)).find(
      (e) => e.kind === "info" && e.text.includes("3 条排队消息未送达"),
    )!;
    expect(notice.text).toContain("排队甲");
    expect(notice.text).toContain("排队乙");
    expect(notice.text).toContain("…等 3 条");
    expect(notice.meta?.droppedTexts).toEqual(["排队甲", "排队乙"]);
  }, 25_000);
});
