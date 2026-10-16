/**
 * G4-02（行为侧）：clientItemId 从输入条一路到 POST /question 的 body。
 *
 * talk-send-attempt.test.ts 测的是「什么时候复用 / 换号」，接线那两条只能读组件源码；
 * 这里补中间一段真行为：submitTaskQuestion 真的把 id 放进请求体（报告说「已支持」但此前没有测试），
 * 并用真实的 claim / settle + submitTaskQuestion 走一遍输入条的序列——
 * 响应丢失 → 同一条重试 → 成功入队 → 下一条。React 组件本身没在浏览器里看过。
 * 全程 mock fetch，不打网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTalkSendAttemptsForTest,
  claimTalkClientItemId,
  settleTalkClientItemId,
} from "@/lib/talk-send-attempt";
import { submitTaskQuestion } from "@/lib/task-store";
import type { Task } from "@/lib/types";

const task = { id: "t_g402", actions: [] } as unknown as Task;

type Seen = Record<string, unknown>;

/** 按次序给 fetch 桩响应：Error = 网络层失败（响应丢了）；对象 = HTTP 响应 */
const stubFetchSequence = (
  steps: Array<Error | { status: number; payload: unknown }>,
): Seen[] => {
  const bodies: Seen[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ? (JSON.parse(init.body) as Seen) : {});
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return {
        ok: step.status >= 200 && step.status < 300,
        status: step.status,
        json: async () => step.payload,
      };
    }),
  );
  return bodies;
};

const QUEUED_202 = {
  status: 202,
  payload: { ok: true, queued: true, itemId: "tq_1", position: 1 },
};

beforeEach(() => {
  __resetTalkSendAttemptsForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitTaskQuestion 的 clientItemId 透传", () => {
  it("传了就进 body（去首尾空白），queueIfBusy 一并带上", async () => {
    const bodies = stubFetchSequence([QUEUED_202]);
    await submitTaskQuestion(task, "改一下", undefined, undefined, undefined, undefined, {
      queueIfBusy: true,
      clientItemId: "  cq_abc  ",
    });
    expect(bodies[0]).toMatchObject({ clientItemId: "cq_abc", queueIfBusy: true });
  });

  it("没传 / 全空白：body 里没有 clientItemId 这个键", async () => {
    const bodies = stubFetchSequence([QUEUED_202]);
    await submitTaskQuestion(task, "a", undefined, undefined, undefined, undefined, {
      queueIfBusy: true,
    });
    await submitTaskQuestion(task, "b", undefined, undefined, undefined, undefined, {
      queueIfBusy: true,
      clientItemId: "   ",
    });
    expect("clientItemId" in bodies[0]!).toBe(false);
    expect("clientItemId" in bodies[1]!).toBe(false);
  });
});

describe("输入条序列：失败重试复用 id、成功后换新 id", () => {
  /** 与 TaskTalkComposer.handleSubmit 同序：claim → 发送 →（成功才）settle */
  const sendLikeComposer = async (text: string) => {
    const clientItemId = claimTalkClientItemId(task.id, { text });
    try {
      const r = await submitTaskQuestion(
        task,
        text,
        undefined,
        undefined,
        undefined,
        undefined,
        { queueIfBusy: true, clientItemId },
      );
      settleTalkClientItemId(task.id, clientItemId);
      return { ok: true as const, r };
    } catch (error) {
      return { ok: false as const, error };
    }
  };

  it("响应丢失 → 同一条重试带同一个 id → 入队成功 → 下一条（同样内容）换新 id", async () => {
    const bodies = stubFetchSequence([
      new TypeError("Failed to fetch"),
      QUEUED_202,
      QUEUED_202,
    ]);

    const first = await sendLikeComposer("把 A 改成 B");
    expect(first.ok).toBe(false);
    const retry = await sendLikeComposer("把 A 改成 B");
    expect(retry.ok).toBe(true);
    const next = await sendLikeComposer("把 A 改成 B");
    expect(next.ok).toBe(true);

    const ids = bodies.map((b) => b.clientItemId);
    expect(ids).toHaveLength(3);
    expect(typeof ids[0]).toBe("string");
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]); // 重试 = 同一条
    expect(ids[2]).not.toBe(ids[0]); // 成功后的下一条 = 新的一条
  });

  it("失败后用户改了内容再发：换新 id（服务端按 id 去重，同 id 会把新内容吞掉）", async () => {
    const bodies = stubFetchSequence([new TypeError("Failed to fetch"), QUEUED_202]);
    await sendLikeComposer("把 A 改成 B");
    await sendLikeComposer("把 A 改成 C");
    expect(bodies[0]!.clientItemId).toBeTruthy();
    expect(bodies[1]!.clientItemId).toBeTruthy();
    expect(bodies[1]!.clientItemId).not.toBe(bodies[0]!.clientItemId);
  });

  it("服务端 4xx 拒绝也算没成功：保留 id，原样再发仍是同一条", async () => {
    const bodies = stubFetchSequence([
      { status: 409, payload: { error: "忙" } },
      QUEUED_202,
    ]);
    const a = await sendLikeComposer("x");
    expect(a.ok).toBe(false);
    await sendLikeComposer("x");
    // 先断言 id 真的存在：两边都是 undefined 时 toBe 也会过，会让这条用例空转
    expect(typeof bodies[0]!.clientItemId).toBe("string");
    expect(bodies[0]!.clientItemId).toBeTruthy();
    expect(bodies[1]!.clientItemId).toBe(bodies[0]!.clientItemId);
  });
});
