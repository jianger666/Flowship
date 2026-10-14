/**
 * 群问题排队队列（group-shared 纯函数）：上限 / TTL / 幂等入队 / 变更订阅 / 按 id 摘除 / 清空。
 * 不碰路由、不碰飞书。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-question-queue-${Date.now()}`,
  "data",
);

const {
  __resetGroupReplyStateForTest,
  clearGroupQuestionQueue,
  enqueueGroupQuestion,
  GROUP_QUESTION_QUEUE_MAX,
  GROUP_QUESTION_QUEUE_TTL_MS,
  groupQuestionQueueLength,
  listGroupQuestionQueueView,
  removeGroupQuestionFromQueue,
  shiftGroupQuestionQueue,
  subscribeGroupQuestionQueue,
  unshiftGroupQuestionQueue,
} = await import("@/lib/server/feishu-bridge/group-shared");

const TASK = "task-gq";

const entry = (id: string, text = `问题 ${id}`) => ({
  messageId: id,
  chatId: "oc_x",
  text,
  parsed: { text, images: [], attachments: [] } as never,
  requester: { openId: "ou_li", name: "李四" },
  boot: { apiKey: "k", model: { id: "m" } },
});

beforeEach(() => {
  __resetGroupReplyStateForTest();
});
afterEach(() => {
  __resetGroupReplyStateForTest();
  vi.restoreAllMocks();
});

describe("上限 / TTL 常量", () => {
  it("队列上限 10、TTL 30 分钟", () => {
    expect(GROUP_QUESTION_QUEUE_MAX).toBe(10);
    expect(GROUP_QUESTION_QUEUE_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("攒满 10 个后第 11 个 queued:false；满了不改队列", () => {
    for (let i = 0; i < 10; i++) {
      expect(enqueueGroupQuestion(TASK, entry(`om_${i}`)).queued).toBe(true);
    }
    const r = enqueueGroupQuestion(TASK, entry("om_over"));
    expect(r.queued).toBe(false);
    expect(groupQuestionQueueLength(TASK)).toBe(10);
  });

  it("29 分钟还有效、30 分钟整过期（入队清过期并如数返回）", () => {
    const t0 = 1_000_000;
    enqueueGroupQuestion(TASK, entry("om_a"), t0);
    const alive = enqueueGroupQuestion(TASK, entry("om_b"), t0 + 29 * 60 * 1000);
    expect(alive.ejected).toHaveLength(0);
    expect(groupQuestionQueueLength(TASK)).toBe(2);
    const expired = enqueueGroupQuestion(TASK, entry("om_c"), t0 + 30 * 60 * 1000);
    expect(expired.ejected.map((e) => e.messageId)).toEqual(["om_a"]);
    expect(groupQuestionQueueLength(TASK)).toBe(2);
  });
});

describe("同 message_id 重复入队幂等", () => {
  it("重复入队不增长队列，返回已有位置", () => {
    expect(enqueueGroupQuestion(TASK, entry("om_1"))).toMatchObject({
      queued: true,
      position: 1,
    });
    expect(enqueueGroupQuestion(TASK, entry("om_2"))).toMatchObject({
      queued: true,
      position: 2,
    });
    // om_1 重投：仍报第 1 位，队长不变
    const dup = enqueueGroupQuestion(TASK, entry("om_1", "重投的内容"));
    expect(dup).toMatchObject({ queued: true, position: 1, ejected: [] });
    expect(groupQuestionQueueLength(TASK)).toBe(2);
    // 保留首次入队的内容，不被重投覆盖
    expect(listGroupQuestionQueueView(TASK)[0]?.preview).toBe("问题 om_1");
    // om_2 重投：位置 2
    expect(enqueueGroupQuestion(TASK, entry("om_2")).position).toBe(2);
  });

  it("重复入队不触发订阅通知（队列没变）", () => {
    enqueueGroupQuestion(TASK, entry("om_1"));
    const listener = vi.fn();
    const off = subscribeGroupQuestionQueue(listener);
    enqueueGroupQuestion(TASK, entry("om_1"));
    off();
    expect(listener).not.toHaveBeenCalled();
  });

  it("队满时重复入队已在队里的 id 仍幂等 queued:true（不被当成溢出）", () => {
    for (let i = 0; i < 10; i++) enqueueGroupQuestion(TASK, entry(`om_${i}`));
    const dup = enqueueGroupQuestion(TASK, entry("om_3"));
    expect(dup).toMatchObject({ queued: true, position: 4 });
    expect(groupQuestionQueueLength(TASK)).toBe(10);
  });
});

describe("队列变更订阅", () => {
  it("入队 / 出队 / 放回 / 清空 / 摘除都会带 taskId 通知", () => {
    const listener = vi.fn();
    const off = subscribeGroupQuestionQueue(listener);

    enqueueGroupQuestion(TASK, entry("om_1"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(TASK);

    enqueueGroupQuestion(TASK, entry("om_2"));
    expect(listener).toHaveBeenCalledTimes(2);

    const { head } = shiftGroupQuestionQueue(TASK);
    expect(head?.messageId).toBe("om_1");
    expect(listener).toHaveBeenCalledTimes(3);

    if (head) unshiftGroupQuestionQueue(TASK, head);
    expect(listener).toHaveBeenCalledTimes(4);

    expect(removeGroupQuestionFromQueue(TASK, "om_2")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(5);

    expect(clearGroupQuestionQueue(TASK)).toBe(1);
    expect(listener).toHaveBeenCalledTimes(6);
    off();
  });

  it("空队清空 / 摘不到 / 溢出都不通知", () => {
    const listener = vi.fn();
    const off = subscribeGroupQuestionQueue(listener);
    expect(clearGroupQuestionQueue(TASK)).toBe(0);
    expect(removeGroupQuestionFromQueue(TASK, "om_none")).toBe(false);
    for (let i = 0; i < 10; i++) enqueueGroupQuestion(TASK, entry(`om_${i}`));
    listener.mockClear();
    enqueueGroupQuestion(TASK, entry("om_over"));
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("入队顺带清掉过期条目也通知（即便本次因满溢出）", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) enqueueGroupQuestion(TASK, entry(`om_${i}`), t0);
    const listener = vi.fn();
    const off = subscribeGroupQuestionQueue(listener);
    // 全部过期：清掉 10 个后新问题入队成功
    const r = enqueueGroupQuestion(
      TASK,
      entry("om_new"),
      t0 + GROUP_QUESTION_QUEUE_TTL_MS,
    );
    expect(r.queued).toBe(true);
    expect(r.ejected).toHaveLength(10);
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("取消订阅后不再收到；监听器抛错不影响队列与其它监听器", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const offBad = subscribeGroupQuestionQueue(bad);
    const offGood = subscribeGroupQuestionQueue(good);
    expect(() => enqueueGroupQuestion(TASK, entry("om_1"))).not.toThrow();
    expect(groupQuestionQueueLength(TASK)).toBe(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();

    offGood();
    offBad();
    enqueueGroupQuestion(TASK, entry("om_2"));
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("按 id 摘除 / 只读视图", () => {
  it("摘中间一条：其余保持 FIFO 顺序，返回 true", () => {
    for (const id of ["om_1", "om_2", "om_3"]) enqueueGroupQuestion(TASK, entry(id));
    expect(removeGroupQuestionFromQueue(TASK, "om_2")).toBe(true);
    expect(listGroupQuestionQueueView(TASK).map((v) => v.id)).toEqual(["om_1", "om_3"]);
    // 重复摘 / 不存在 / 别的 task 都是 false
    expect(removeGroupQuestionFromQueue(TASK, "om_2")).toBe(false);
    expect(removeGroupQuestionFromQueue("other-task", "om_1")).toBe(false);
    expect(groupQuestionQueueLength(TASK)).toBe(2);
  });

  it("摘空整队后长度为 0、视图为空", () => {
    enqueueGroupQuestion(TASK, entry("om_1"));
    expect(removeGroupQuestionFromQueue(TASK, "om_1")).toBe(true);
    expect(groupQuestionQueueLength(TASK)).toBe(0);
    expect(listGroupQuestionQueueView(TASK)).toEqual([]);
  });

  it("视图字段：发送人 / 机器人标记 / 折叠空白并截断到 120 / 入队时间；不含启动凭据", () => {
    enqueueGroupQuestion(
      TASK,
      {
        ...entry("om_bot", `  头部\n\n  ${"长".repeat(200)}`),
        requester: { openId: "ou_bot", name: "对方机器人" },
        requesterIsBot: true,
      },
      42,
    );
    const [v] = listGroupQuestionQueueView(TASK);
    expect(v).toMatchObject({
      id: "om_bot",
      senderName: "对方机器人",
      senderIsBot: true,
      createdAt: 42,
    });
    expect(v?.preview.startsWith("头部 长")).toBe(true);
    expect(v?.preview.length).toBe(120);
    expect(v).not.toHaveProperty("boot");
  });

  it("视图不剔除过期条目（过期由入队 / pump 清理并通知）", () => {
    enqueueGroupQuestion(TASK, entry("om_old"), 1);
    expect(listGroupQuestionQueueView(TASK)).toHaveLength(1);
  });
});

describe("清空语义（任务删除 / 终结时整队丢弃）", () => {
  it("clearGroupQuestionQueue 丢掉整队并返回条数，别的 task 不受影响", () => {
    enqueueGroupQuestion(TASK, entry("om_1"));
    enqueueGroupQuestion(TASK, entry("om_2"));
    enqueueGroupQuestion("task-other", entry("om_9"));
    expect(clearGroupQuestionQueue(TASK)).toBe(2);
    expect(groupQuestionQueueLength(TASK)).toBe(0);
    expect(groupQuestionQueueLength("task-other")).toBe(1);
  });
});
