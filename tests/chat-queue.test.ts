/**
 * Chat 运行中消息队列（P5.1）纯函数 / Map 契约测试
 * + tool-outputs 清理纯函数
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  beginChatQueueInFlight,
  CHAT_QUEUE_MAX,
  clearChatQueue,
  cleanupChatQueueState,
  dequeueChatMessage,
  emitQueuedMessageFlushed,
  endChatQueueInFlight,
  enqueueChatMessage,
  enqueueChatMessageFront,
  findRecentSettledEntry,
  getMessageOperation,
  onQueuedMessageFlushed,
  removeQueuedChatMessages,
  promoteQueuedChatMessage,
  takeQueuedChatMessage,
  getChatQueueCount,
  getChatQueueGeneration,
  getChatQueueInFlight,
  listQueuedChatMessages,
  tryEnqueueMsg,
  __clearQueuedMessageFlushedListenersForTest,
  type QueuedChatMsg,
} from "../src/lib/server/chat-queue";
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

  it("removeQueuedChatMessages 按谓词移除、保留其余", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    enqueueChatMessage(id, msg(2));
    enqueueChatMessage(id, msg(3));
    const removed = removeQueuedChatMessages(
      id,
      (m) => m.displayText === "user-2",
    );
    expect(removed.map((m) => m.displayText)).toEqual(["user-2"]);
    expect(getChatQueueCount(id)).toBe(2);
    expect(dequeueChatMessage(id)?.displayText).toBe("user-1");
    expect(dequeueChatMessage(id)?.displayText).toBe("user-3");
  });

  // R1-13b：选择性出队必须闭环 op ledger（cancelled）
  it("removeQueuedChatMessages 对移除条目 settle cancelled", () => {
    const id = alloc();
    const r1 = enqueueChatMessage(id, msg(1));
    const r2 = enqueueChatMessage(id, msg(2));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const removed = removeQueuedChatMessages(
      id,
      (m) => m.itemId === r2.itemId,
    );
    expect(removed).toHaveLength(1);
    expect(findRecentSettledEntry(id, r2.itemId)?.outcome).toBe("cancelled");
    const op = getMessageOperation(id, r2.itemId);
    expect(op?.phase).toBe("cancelled");
    // 未移除的仍在队、未终态
    expect(findRecentSettledEntry(id, r1.itemId)).toBeUndefined();
    expect(getChatQueueCount(id)).toBe(1);
  });

  it("promoteQueuedChatMessage 存在项挪到队首、队列顺序正确", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    enqueueChatMessage(id, msg(2));
    enqueueChatMessage(id, msg(3));
    expect(promoteQueuedChatMessage(id, "item_3")).toBe(true);
    expect(listQueuedChatMessages(id).map((m) => m.itemId)).toEqual([
      "item_3",
      "item_1",
      "item_2",
    ]);
    // 已在队首再 promote = 幂等成功、顺序不变
    expect(promoteQueuedChatMessage(id, "item_3")).toBe(true);
    expect(listQueuedChatMessages(id).map((m) => m.itemId)).toEqual([
      "item_3",
      "item_1",
      "item_2",
    ]);
    expect(dequeueChatMessage(id)?.itemId).toBe("item_3");
    expect(dequeueChatMessage(id)?.itemId).toBe("item_1");
    expect(dequeueChatMessage(id)?.itemId).toBe("item_2");
  });

  it("promoteQueuedChatMessage 不存在项返 false", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    expect(promoteQueuedChatMessage(id, "item_missing")).toBe(false);
    expect(promoteQueuedChatMessage(id, "")).toBe(false);
    // 队列未被误改
    expect(listQueuedChatMessages(id).map((m) => m.itemId)).toEqual(["item_1"]);
  });

  it("takeQueuedChatMessage 按 id 取出完整条目、队内移除但不 settle", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    enqueueChatMessage(id, {
      ...msg(2),
      skipPersistEvent: true,
      agentText: "agent-with-skill",
    });
    enqueueChatMessage(id, msg(3));

    const taken = takeQueuedChatMessage(id, "item_2");
    expect(taken).not.toBeNull();
    expect(taken!.itemId).toBe("item_2");
    expect(taken!.skipPersistEvent).toBe(true);
    expect(taken!.agentText).toBe("agent-with-skill");
    expect(listQueuedChatMessages(id).map((m) => m.itemId)).toEqual([
      "item_1",
      "item_3",
    ]);
    // 与 remove 不同：不进 recentSettled cancelled
    expect(findRecentSettledEntry(id, "item_2")).toBeUndefined();
  });

  it("takeQueuedChatMessage 不存在项返 null", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(1));
    expect(takeQueuedChatMessage(id, "item_missing")).toBeNull();
    expect(takeQueuedChatMessage(id, "")).toBeNull();
    expect(getChatQueueCount(id)).toBe(1);
  });

  it("enqueue 后 FIFO dequeue 保序", () => {
    const id = alloc();
    expect(enqueueChatMessage(id, msg(1)).ok).toBe(true);
    expect(enqueueChatMessage(id, msg(2)).ok).toBe(true);
    expect(dequeueChatMessage(id)?.displayText).toBe("user-1");
    expect(dequeueChatMessage(id)?.displayText).toBe("user-2");
  });

  it("flush 遇 busy 时 enqueueFront 保序（runActive 同口径）", () => {
    const id = alloc();
    enqueueChatMessage(id, msg(2));
    enqueueChatMessage(id, msg(3));
    // 模拟 flush 取出 msg2 后发现 runActive → 塞回队首
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

  // review P0#1：flush 钩子中性签名
  it("onQueuedMessageFlushed / emitQueuedMessageFlushed 带原条目回调", () => {
    __clearQueuedMessageFlushedListenersForTest();
    const seen: Array<{ taskId: string; mid?: unknown }> = [];
    const unsub = onQueuedMessageFlushed((taskId, m) => {
      seen.push({ taskId, mid: m.extraMeta?.feishuMessageId });
    });
    const m: QueuedChatMsg = {
      ...msg(1),
      extraMeta: { feishuMessageId: "om_x" },
    };
    emitQueuedMessageFlushed("t_flush", m);
    expect(seen).toEqual([{ taskId: "t_flush", mid: "om_x" }]);
    unsub();
    emitQueuedMessageFlushed("t_flush", m);
    expect(seen).toHaveLength(1);
    __clearQueuedMessageFlushedListenersForTest();
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
