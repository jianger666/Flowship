/**
 * G3-06：群问题队列与订阅集合必须挂 globalThis（group-shared 头注释的约定）。
 *
 * 缺陷：`groupQuestionQueues` / `groupQueueListeners` 是模块级变量。dev 下 HMR 重新求值
 * group-shared 后，task-talk-queue 的「已订阅」标记（globalThis）还在、监听集合却是新的空集，
 * 于是「群里排队中」推给 UI 的通知永久丢失；排队中的问题也随旧模块实例一起消失。
 *
 * 用 `vi.resetModules()` 再 import 一份新的模块实例来模拟 HMR 重求值。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const entry = (messageId: string, text = "问题") => ({
  messageId,
  chatId: "oc_x",
  text,
  parsed: { text, images: [], attachments: [] } as never,
  requester: { openId: "ou_li", name: "李四" },
  boot: null,
});

afterEach(() => {
  vi.resetModules();
});

describe("G3-06：HMR 重求值 group-shared 后队列与订阅不丢", () => {
  it("重求值前的订阅者，仍能收到新模块实例上的队列变化通知", async () => {
    const a = await import("@/lib/server/feishu-bridge/group-shared");
    a.__resetGroupReplyStateForTest();
    const seen: string[] = [];
    a.subscribeGroupQuestionQueue((taskId) => seen.push(taskId));

    vi.resetModules();
    const b = await import("@/lib/server/feishu-bridge/group-shared");
    expect(b).not.toBe(a); // 前提：确实是新的模块实例

    b.enqueueGroupQuestion("task-hmr", entry("om_1"));
    expect(seen).toContain("task-hmr");
    b.__resetGroupReplyStateForTest();
  });

  it("重求值前入队的问题，新模块实例仍看得到（队列表不随模块实例重置）", async () => {
    const a = await import("@/lib/server/feishu-bridge/group-shared");
    a.__resetGroupReplyStateForTest();
    a.enqueueGroupQuestion("task-hmr", entry("om_1"));

    vi.resetModules();
    const b = await import("@/lib/server/feishu-bridge/group-shared");
    expect(b).not.toBe(a);
    expect(b.groupQuestionQueueLength("task-hmr")).toBe(1);
    expect(b.listGroupQuestionQueueView("task-hmr").map((e) => e.id)).toEqual([
      "om_1",
    ]);
    // 两个实例操作同一份表：新实例摘掉，旧实例也看不到了
    expect(b.removeGroupQuestionFromQueue("task-hmr", "om_1")).toBe(true);
    expect(a.groupQuestionQueueLength("task-hmr")).toBe(0);
    b.__resetGroupReplyStateForTest();
  });
});
