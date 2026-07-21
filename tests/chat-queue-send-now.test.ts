/**
 * send_now 编排单测：take → stop → start 顺序；404 / 400 / skipPersistEvent 透传
 */
import { describe, expect, it, vi } from "vitest";

import type { QueuedChatMsg } from "@/lib/server/chat-queue";
import {
  sendQueuedChatMessageNow,
  type SendNowDeps,
} from "@/lib/server/chat-queue-send-now";
import type { Task } from "@/lib/types";

const makeTask = (id: string): Task =>
  ({
    id,
    mode: "chat",
    title: "t",
    runStatus: "running",
    repoStatus: "active",
    repoPaths: [],
    actions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const makeMsg = (overrides: Partial<QueuedChatMsg> = {}): QueuedChatMsg => ({
  itemId: "cq_test_1",
  agentText: "agent final text",
  displayText: "user text",
  enqueuedAt: 1,
  ...overrides,
});

const validBoot = {
  apiKey: "sk-test",
  model: { id: "composer-2" },
};

describe("sendQueuedChatMessageNow 编排", () => {
  it("调用顺序：take → stop → start，且 start 收到取出的条目", async () => {
    const order: string[] = [];
    const taken = makeMsg({ skipPersistEvent: true });
    const task = makeTask("t_order");

    const deps: SendNowDeps = {
      getTask: vi.fn(async () => task),
      take: vi.fn(() => {
        order.push("take");
        return taken;
      }),
      stop: vi.fn(async () => {
        order.push("stop");
        return { hadAgent: true, task };
      }),
      start: vi.fn(async (_id, msg) => {
        order.push("start");
        expect(msg).toBe(taken);
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }),
    };

    const res = await sendQueuedChatMessageNow(
      "t_order",
      "cq_test_1",
      validBoot,
      deps,
    );
    expect(res.status).toBe(202);
    expect(order).toEqual(["take", "stop", "start"]);
    expect(deps.take).toHaveBeenCalledWith("t_order", "cq_test_1");
    expect(deps.stop).toHaveBeenCalledWith(task);
    expect(deps.start).toHaveBeenCalledWith("t_order", taken, {
      apiKey: validBoot.apiKey,
      model: validBoot.model,
    });
  });

  it("条目不存在 → 404，且不调 stop/start", async () => {
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_404")),
      take: vi.fn(() => null),
      stop: vi.fn(async () => ({ hadAgent: false, task: makeTask("t_404") })),
      start: vi.fn(async () => new Response("should not", { status: 500 })),
    };

    const res = await sendQueuedChatMessageNow(
      "t_404",
      "missing",
      validBoot,
      deps,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/找不到/);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("缺 bootArgs.apiKey → 400，且不调 take/stop/start", async () => {
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_400")),
      take: vi.fn(() => makeMsg()),
      stop: vi.fn(async () => ({ hadAgent: false, task: makeTask("t_400") })),
      start: vi.fn(async () => new Response("should not", { status: 500 })),
    };

    const res = await sendQueuedChatMessageNow("t_400", "cq_1", undefined, deps);
    expect(res.status).toBe(400);
    expect(deps.getTask).not.toHaveBeenCalled();
    expect(deps.take).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("bootArgs.model 非法 → 400", async () => {
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_model")),
      take: vi.fn(() => makeMsg()),
      stop: vi.fn(async () => ({ hadAgent: false, task: makeTask("t_model") })),
      start: vi.fn(async () => new Response("should not", { status: 500 })),
    };

    const res = await sendQueuedChatMessageNow(
      "t_model",
      "cq_1",
      { apiKey: "sk", model: { id: "" } as never },
      deps,
    );
    expect(res.status).toBe(400);
    expect(deps.take).not.toHaveBeenCalled();
  });

  it("skipPersistEvent 透传到 start", async () => {
    const taken = makeMsg({
      skipPersistEvent: true,
      agentText: "prebuilt with skill",
    });
    let startedMsg: QueuedChatMsg | undefined;
    const start: SendNowDeps["start"] = async (_id, msg) => {
      startedMsg = msg;
      return new Response("{}", { status: 202 });
    };
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_skip")),
      take: vi.fn(() => taken),
      stop: vi.fn(async () => ({
        hadAgent: true,
        task: makeTask("t_skip"),
      })),
      start,
    };

    await sendQueuedChatMessageNow("t_skip", taken.itemId, validBoot, deps);
    expect(startedMsg?.skipPersistEvent).toBe(true);
    expect(startedMsg?.agentText).toBe("prebuilt with skill");
  });
});
