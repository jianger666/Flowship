/**
 * send-now（立即发送）打断重发路径：塞回「其余排队」不丢、不乱序（审查 BE2-01）。
 *
 * 旧实现逐条 `enqueueChatMessage` 且无视返回值：
 *   - stop → start 的窗口里又来了几条新消息、队列又接近上限（CHAT_QUEUE_MAX=5）时，
 *     塞回的老消息被 `full` 拒掉——已经回过 202 的消息静默丢失，留下永远「排队中」的幽灵气泡；
 *   - 且是 append：老消息排到窗口内新到的消息后面，先来的反而后发。
 * 现在整批按原顺序塞队首（enqueueChatMessagesFront）：不过容量、先于新到达、幂等、不复活已终态的。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_QUEUE_MAX,
  clearChatQueue,
  enqueueChatMessage,
  enqueueChatMessageFront,
  enqueueChatMessagesFront,
  listQueuedChatMessages,
  settleMessageFailed,
  takeQueuedChatMessage,
  type QueuedChatMsg,
} from "@/lib/server/chat-queue";
import { sendQueuedChatMessageNow, type SendNowDeps } from "@/lib/server/chat-queue-send-now";
import type { Task } from "@/lib/types";

const tids: string[] = [];
const newTid = (): string => {
  const id = `t_rqf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  tids.push(id);
  return id;
};
afterEach(() => {
  for (const id of tids.splice(0)) clearChatQueue(id);
});

const input = (id: string) => ({
  itemId: id,
  agentText: `agent-${id}`,
  displayText: `user-${id}`,
  enqueuedAt: Date.now(),
});
const ids = (tid: string): string[] => listQueuedChatMessages(tid).map((m) => m.itemId);
const makeTask = (id: string): Task =>
  ({ id, mode: "chat", title: "t", runStatus: "running", repoStatus: "active", repoPaths: [], actions: [] }) as unknown as Task;
const validBoot = { apiKey: "sk-test", model: { id: "composer-2" } };

describe("enqueueChatMessagesFront", () => {
  it("整批按原顺序塞队首，先于队里已有的（窗口内的新到达）", () => {
    const tid = newTid();
    enqueueChatMessage(tid, input("n1"));
    enqueueChatMessage(tid, input("n2"));
    const r = enqueueChatMessagesFront(tid, [input("a"), input("b")]);
    expect(r).toEqual({ requeued: 2, skipped: 0 });
    expect(ids(tid)).toEqual(["a", "b", "n1", "n2"]);
  });

  it("不过容量：队里已接近上限也一条不丢（理论超限允许 MAX+N、只打 error）", () => {
    const tid = newTid();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < CHAT_QUEUE_MAX - 1; i++) enqueueChatMessage(tid, input(`n${i}`));
      const r = enqueueChatMessagesFront(tid, [input("a"), input("b"), input("c")]);
      expect(r.requeued).toBe(3);
      expect(ids(tid).slice(0, 3)).toEqual(["a", "b", "c"]);
      expect(ids(tid)).toHaveLength(CHAT_QUEUE_MAX - 1 + 3);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("幂等：已经在队里的同 id 不叠两份", () => {
    const tid = newTid();
    enqueueChatMessage(tid, input("a"));
    const r = enqueueChatMessagesFront(tid, [input("a"), input("b")]);
    expect(r).toEqual({ requeued: 1, skipped: 1 });
    expect(ids(tid)).toEqual(["b", "a"]);
  });

  it("不复活已终态的消息（窗口内被作废 / 已送达的不再塞回）", () => {
    const tid = newTid();
    enqueueChatMessage(tid, input("a"));
    enqueueChatMessage(tid, input("b"));
    // 模拟 stop 前救出来的：先取走再作废 a
    const a = takeQueuedChatMessage(tid, "a")!;
    const b = takeQueuedChatMessage(tid, "b")!;
    settleMessageFailed(tid, "a", "stopped");
    const r = enqueueChatMessagesFront(tid, [a, b]);
    expect(r).toEqual({ requeued: 1, skipped: 1 });
    expect(ids(tid)).toEqual(["b"]);
  });

  it("afterItemId：队首恰是目标条（start 失败时被放回队首）→ 插在它后面，目标条仍排第一", () => {
    const tid = newTid();
    enqueueChatMessage(tid, input("n1"));
    enqueueChatMessageFront(tid, input("target"));
    enqueueChatMessagesFront(tid, [input("a"), input("b")], { afterItemId: "target" });
    expect(ids(tid)).toEqual(["target", "a", "b", "n1"]);
  });

  it("afterItemId 不在队首（start 成功、目标条已出队）→ 照常塞队首", () => {
    const tid = newTid();
    enqueueChatMessage(tid, input("n1"));
    enqueueChatMessagesFront(tid, [input("a")], { afterItemId: "target" });
    expect(ids(tid)).toEqual(["a", "n1"]);
  });

  it("空数组 / 全被跳过：不动队列", () => {
    const tid = newTid();
    enqueueChatMessage(tid, input("n1"));
    expect(enqueueChatMessagesFront(tid, [])).toEqual({ requeued: 0, skipped: 0 });
    expect(ids(tid)).toEqual(["n1"]);
  });
});

describe("sendQueuedChatMessageNow：stop → start 窗口内又来了新消息", () => {
  it("队列接近上限时，塞回的老消息一条不丢、且仍排在窗口内新消息之前（旧实现：丢 b 且 a 排在新消息后）", async () => {
    const tid = newTid();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const id of ["target", "a", "b"]) {
        expect(enqueueChatMessage(tid, input(id)).ok).toBe(true);
      }
      const deps: SendNowDeps = {
        getTask: vi.fn(async () => makeTask(tid)),
        take: takeQueuedChatMessage,
        stop: vi.fn(async () => {
          // stop 期间用户又连发了 4 条（队列此刻只剩它们，没满）
          for (const id of ["n1", "n2", "n3", "n4"]) enqueueChatMessage(tid, input(id));
          return { hadAgent: true, task: makeTask(tid) };
        }),
        start: vi.fn(async () => new Response("{}", { status: 202 })),
      };
      const res = await sendQueuedChatMessageNow(tid, "target", validBoot, deps);
      expect(res.status).toBe(202);
      // 老消息 a、b 都在，且先于新到达的 n1..n4
      expect(ids(tid)).toEqual(["a", "b", "n1", "n2", "n3", "n4"]);
    } finally {
      err.mockRestore();
    }
  });

  it("start 失败：目标条仍排第一，其余跟在它后面（requeueRest 收到 afterItemId）", async () => {
    const tid = newTid();
    for (const id of ["target", "a"]) enqueueChatMessage(tid, input(id));
    const seen: Array<string | undefined> = [];
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask(tid)),
      take: takeQueuedChatMessage,
      stop: vi.fn(async () => ({ hadAgent: true, task: makeTask(tid) })),
      // start 失败的约定：内部把目标条放回队首再返回错误响应
      start: vi.fn(async (taskId: string, msg: QueuedChatMsg) => {
        enqueueChatMessageFront(taskId, msg);
        return new Response("boom", { status: 500 });
      }),
      requeueRest: vi.fn((taskId: string, rest: QueuedChatMsg[], afterItemId?: string) => {
        seen.push(afterItemId);
        enqueueChatMessagesFront(
          taskId,
          rest.map((m) => ({ ...m })),
          { afterItemId },
        );
      }),
    };
    const res = await sendQueuedChatMessageNow(tid, "target", validBoot, deps);
    expect(res.status).toBe(500);
    expect(seen).toEqual(["target"]);
    expect(ids(tid)).toEqual(["target", "a"]);
  });
});
