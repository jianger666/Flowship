/**
 * Chat 运行中消息队列（P5.1）纯函数 / Map 契约测试
 * + 自动 compact 触发判定 / tool-outputs 清理纯函数
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  beginChatQueueInFlight,
  CHAT_QUEUE_MAX,
  clearChatQueue,
  cleanupChatQueueState,
  dequeueChatMessage,
  endChatQueueInFlight,
  enqueueChatMessage,
  enqueueChatMessageFront,
  getChatQueueCount,
  getChatQueueGeneration,
  getChatQueueInFlight,
  tryEnqueueMsg,
  type QueuedChatMsg,
} from "../src/lib/server/chat-queue";
import {
  COMPACT_SUGGEST_INFO_INPUT_TOKENS,
  shouldAutoCompactAfterTurn,
} from "../src/lib/server/chat-context-usage";
import {
  selectToolOutputsToPrune,
  TOOL_OUTPUTS_MAX_BYTES,
  TOOL_OUTPUTS_MAX_FILES,
} from "../src/lib/server/tool-result-persist";

const msg = (n: number): QueuedChatMsg => ({
  itemId: `item_${n}`,
  agentText: `agent-${n}`,
  displayText: `user-${n}`,
  enqueuedAt: n,
});

describe("tryEnqueueMsg（纯函数）", () => {
  it("空队列可入队", () => {
    const r = tryEnqueueMsg([], msg(1));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next).toHaveLength(1);
  });

  it("满了拒绝", () => {
    const full = Array.from({ length: CHAT_QUEUE_MAX }, (_, i) => msg(i));
    const r = tryEnqueueMsg(full, msg(99));
    expect(r).toEqual({ ok: false, reason: "full" });
  });

  it("自定义 max", () => {
    const r = tryEnqueueMsg([msg(1)], msg(2), 1);
    expect(r.ok).toBe(false);
  });
});

describe("enqueue / dequeue / clear（per-task Map）", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids) clearChatQueue(id);
    ids.length = 0;
  });

  const alloc = (): string => {
    const id = `q-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  it("入队递增 queuedCount、dequeue FIFO", () => {
    const id = alloc();
    const r1 = enqueueChatMessage(id, msg(1));
    expect(r1).toMatchObject({ ok: true, queuedCount: 1 });
    if (r1.ok) expect(r1.itemId).toBeTruthy();
    const r2 = enqueueChatMessage(id, msg(2));
    expect(r2).toMatchObject({ ok: true, queuedCount: 2 });
    if (r2.ok) expect(r2.itemId).toBeTruthy();
    expect(getChatQueueCount(id)).toBe(2);
    const d1 = dequeueChatMessage(id);
    expect(d1?.displayText).toBe("user-1");
    expect(d1?.itemId).toBeTruthy();
    expect(dequeueChatMessage(id)?.displayText).toBe("user-2");
    expect(dequeueChatMessage(id)).toBeNull();
    expect(getChatQueueCount(id)).toBe(0);
  });

  it("超上限 409 语义（reason=full）", () => {
    const id = alloc();
    for (let i = 0; i < CHAT_QUEUE_MAX; i++) {
      expect(enqueueChatMessage(id, msg(i)).ok).toBe(true);
    }
    expect(enqueueChatMessage(id, msg(99))).toEqual({
      ok: false,
      reason: "full",
      queuedCount: CHAT_QUEUE_MAX,
    });
  });

  it("enqueueFront 保序", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    enqueueChatMessageFront(id, msg(0));
    expect(dequeueChatMessage(id)?.displayText).toBe("user-0");
    expect(dequeueChatMessage(id)?.displayText).toBe("user-1");
  });

  it("S4：in-flight 占位时第 6 条 enqueue 返 full（容量含 in-flight）", () => {
    const id = alloc();
    // 模拟 flush：dequeue 一条后标 in-flight，队列空出 1 位但容量仍满
    for (let i = 1; i <= CHAT_QUEUE_MAX; i++) {
      expect(enqueueChatMessage(id, msg(i)).ok).toBe(true);
    }
    const head = dequeueChatMessage(id)!;
    expect(head.displayText).toBe("user-1");
    beginChatQueueInFlight(id);
    expect(getChatQueueInFlight(id)).toBe(1);
    expect(getChatQueueCount(id)).toBe(CHAT_QUEUE_MAX - 1);
    // 新消息诚实拒绝——不得 202 后再靠塞回丢队尾
    expect(enqueueChatMessage(id, msg(99))).toEqual({
      ok: false,
      reason: "full",
      queuedCount: CHAT_QUEUE_MAX, // 4 在队 + 1 in-flight
    });
    // 塞回后全部已入队消息保留且 FIFO
    enqueueChatMessageFront(id, head);
    endChatQueueInFlight(id);
    const order: string[] = [];
    for (let m = dequeueChatMessage(id); m; m = dequeueChatMessage(id)) {
      order.push(m.displayText);
    }
    expect(order).toEqual(
      Array.from({ length: CHAT_QUEUE_MAX }, (_, i) => `user-${i + 1}`),
    );
  });

  it("S4：enqueueFront 理论超限保留 MAX+1、不丢已接受消息", () => {
    const id = alloc();
    for (let i = 1; i <= CHAT_QUEUE_MAX; i++) {
      expect(enqueueChatMessage(id, msg(i)).ok).toBe(true);
    }
    enqueueChatMessageFront(id, msg(0)); // 理论超限仍保留塞回
    expect(getChatQueueCount(id)).toBe(CHAT_QUEUE_MAX + 1);
    expect(dequeueChatMessage(id)?.displayText).toBe("user-0");
    const rest: string[] = [];
    for (let m = dequeueChatMessage(id); m; m = dequeueChatMessage(id)) {
      rest.push(m.displayText);
    }
    expect(rest).toEqual(
      Array.from({ length: CHAT_QUEUE_MAX }, (_, i) => `user-${i + 1}`),
    );
  });

  it("S4：clear / cleanup 清零 in-flight", () => {
    const id = alloc();
    beginChatQueueInFlight(id);
    expect(getChatQueueInFlight(id)).toBe(1);
    clearChatQueue(id);
    expect(getChatQueueInFlight(id)).toBe(0);
    beginChatQueueInFlight(id);
    cleanupChatQueueState(id);
    expect(getChatQueueInFlight(id)).toBe(0);
    endChatQueueInFlight(id); // 幂等
    expect(getChatQueueInFlight(id)).toBe(0);
  });

  it("clear 清空", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    enqueueChatMessage(id, msg(2));
    clearChatQueue(id);
    expect(getChatQueueCount(id)).toBe(0);
    expect(dequeueChatMessage(id)).toBeNull();
  });

  it("compact 期间入队语义：send 返 false 后仍可 enqueue、完成后 FIFO 发出", () => {
    // 对齐 chat-reply：compactInProgress → sendChatMessage false → enqueue
    const id = alloc();
    expect(enqueueChatMessage(id, msg(1)).ok).toBe(true);
    expect(enqueueChatMessage(id, msg(2)).ok).toBe(true);
    // compact 结束 flush：dequeue 保序
    expect(dequeueChatMessage(id)?.displayText).toBe("user-1");
    expect(dequeueChatMessage(id)?.displayText).toBe("user-2");
  });

  it("flush 遇 busy 时 enqueueFront 保序（compact/runActive 同口径）", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(2));
    enqueueChatMessage(id, msg(3));
    // 模拟 flush 取出 msg2 后发现 compact 中 → 塞回队首
    const head = dequeueChatMessage(id)!;
    enqueueChatMessageFront(id, head);
    expect(dequeueChatMessage(id)?.displayText).toBe("user-2");
    expect(dequeueChatMessage(id)?.displayText).toBe("user-3");
  });

  it("skipPersistEvent 入队/出队透传（并发起会话已落 user_reply）", () => {
    const id = alloc();
    const withSkip: QueuedChatMsg = {
      ...msg(1),
      skipPersistEvent: true,
    };
    expect(enqueueChatMessage(id, withSkip).ok).toBe(true);
    expect(enqueueChatMessage(id, msg(2)).ok).toBe(true);
    const first = dequeueChatMessage(id);
    expect(first?.skipPersistEvent).toBe(true);
    expect(first?.displayText).toBe("user-1");
    const second = dequeueChatMessage(id);
    expect(second?.skipPersistEvent).toBeUndefined();
    expect(second?.displayText).toBe("user-2");
  });

  it("generation：初始 0；enqueue/dequeue 不变；clear 递增", () => {
    const id = alloc();
    expect(getChatQueueGeneration(id)).toBe(0);
    enqueueChatMessage(id, msg(1));
    expect(getChatQueueGeneration(id)).toBe(0);
    dequeueChatMessage(id);
    expect(getChatQueueGeneration(id)).toBe(0);
    clearChatQueue(id);
    expect(getChatQueueGeneration(id)).toBe(1);
    clearChatQueue(id);
    expect(getChatQueueGeneration(id)).toBe(2);
  });

  it("drain 竞态语义：dequeue 后 clear → generation 变了不得塞回", () => {
    // 模拟 flush：dequeue 记 gen → 期间 stop/rewind clear → 塞回前比对丢弃
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    enqueueChatMessage(id, msg(2));
    const genAtDequeue = getChatQueueGeneration(id);
    const head = dequeueChatMessage(id)!;
    expect(head.displayText).toBe("user-1");
    clearChatQueue(id); // stop / rewind：清队 + generation+1
    expect(getChatQueueGeneration(id)).not.toBe(genAtDequeue);
    // 新逻辑：generation 变了不 enqueueFront
    if (getChatQueueGeneration(id) === genAtDequeue) {
      enqueueChatMessageFront(id, head);
    }
    expect(getChatQueueCount(id)).toBe(0);
    expect(dequeueChatMessage(id)).toBeNull();
  });
});

describe("shouldAutoCompactAfterTurn（纯函数）", () => {
  it("低于阈值不触发", () => {
    expect(
      shouldAutoCompactAfterTurn(COMPACT_SUGGEST_INFO_INPUT_TOKENS, false),
    ).toBe(false);
    expect(
      shouldAutoCompactAfterTurn(COMPACT_SUGGEST_INFO_INPUT_TOKENS - 1, false),
    ).toBe(false);
  });

  it("超过阈值且未尝试过 → 触发", () => {
    expect(
      shouldAutoCompactAfterTurn(COMPACT_SUGGEST_INFO_INPUT_TOKENS + 1, false),
    ).toBe(true);
  });

  it("已尝试过 → 不重试（防死循环）", () => {
    expect(
      shouldAutoCompactAfterTurn(COMPACT_SUGGEST_INFO_INPUT_TOKENS + 50_000, true),
    ).toBe(false);
  });
});

describe("selectToolOutputsToPrune（纯函数）", () => {
  it("未超限不删", () => {
    const files = [
      { name: "a.txt", mtimeMs: 1, size: 100 },
      { name: "b.txt", mtimeMs: 2, size: 100 },
    ];
    expect(selectToolOutputsToPrune(files)).toEqual([]);
  });

  it("超文件数删最老", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`,
      mtimeMs: i,
      size: 10,
    }));
    expect(
      selectToolOutputsToPrune(files, { maxFiles: 3, maxBytes: 1e9 }),
    ).toEqual(["f0.txt", "f1.txt"]);
  });

  it("超字节删最老直到达标", () => {
    const files = [
      { name: "old.bin", mtimeMs: 1, size: 80 },
      { name: "mid.bin", mtimeMs: 2, size: 80 },
      { name: "new.bin", mtimeMs: 3, size: 80 },
    ];
    expect(
      selectToolOutputsToPrune(files, { maxFiles: 100, maxBytes: 100 }),
    ).toEqual(["old.bin", "mid.bin"]);
  });

  it("默认常量存在", () => {
    expect(TOOL_OUTPUTS_MAX_FILES).toBe(200);
    expect(TOOL_OUTPUTS_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});
