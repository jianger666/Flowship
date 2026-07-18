/**
 * T1 时序钉扎：stop/DELETE 收尾窗口内禁止覆盖 cancelled 启动 lease
 *
 * 纯 gate 层模拟（不起真 route / Agent）：
 *   请求 A reserve → stop/DELETE 到达（cancel + begin lifecycle）
 *   → 并发请求 B tryReserve 必须 null
 *   → lifecycle 结束（end / clearChatGate）后 B 才能 reserve 成功
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  beginChatLifecycle,
  cancelChatStart,
  clearChatGate,
  endChatLifecycle,
  getChatLifecycle,
  isChatStartLeaseValid,
  tryReserveChatStart,
} from "../src/lib/server/chat-gate";

describe("T1 lifecycle 时序（gate 层）", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids) clearChatGate(id);
    ids.length = 0;
  });

  const alloc = (): string => {
    const id = `life-t1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  it("stop 窗口：A reserve → cancel+stopping → B reserve null → end 后 B 成功", () => {
    const id = alloc();

    // 请求 A 已占启动 lease（模拟 checkpoint 窗口中）
    const tokenA = tryReserveChatStart(id)!;
    expect(tokenA).toEqual(expect.any(Number));

    // stop 到达：cancel + begin stopping（对齐 stopTaskAgent 入口）
    cancelChatStart(id);
    expect(beginChatLifecycle(id, "stopping")).toBe(true);
    expect(isChatStartLeaseValid(id, tokenA)).toBe(false);

    // 并发请求 B：收尾 await 期间不得覆盖 cancelled lease
    expect(tryReserveChatStart(id)).toBeNull();
    expect(getChatLifecycle(id)).toBe("stopping");

    // stop 完成
    endChatLifecycle(id, "stopping");
    expect(getChatLifecycle(id)).toBeNull();

    // stop 完成后允许立刻重发（覆盖 cancelled）
    const tokenB = tryReserveChatStart(id);
    expect(tokenB).not.toBeNull();
    expect(tokenB).not.toBe(tokenA);
    expect(isChatStartLeaseValid(id, tokenB!)).toBe(true);
    expect(isChatStartLeaseValid(id, tokenA)).toBe(false);
  });

  it("DELETE 窗口：begin deleting 后永远 null，直到 clearChatGate", () => {
    const id = alloc();

    const tokenA = tryReserveChatStart(id)!;
    cancelChatStart(id);
    expect(beginChatLifecycle(id, "deleting")).toBe(true);

    // DELETE 收尾（含 waitFor* / 清 refs）期间反复尝试仍失败
    expect(tryReserveChatStart(id)).toBeNull();
    expect(tryReserveChatStart(id)).toBeNull();
    expect(isChatStartLeaseValid(id, tokenA)).toBe(false);

    // 成功删除路径：clearChatGate 顺带清 lifecycle（不单独 end）
    clearChatGate(id);
    expect(getChatLifecycle(id)).toBeNull();

    const tokenB = tryReserveChatStart(id);
    expect(tokenB).not.toBeNull();
    expect(isChatStartLeaseValid(id, tokenB!)).toBe(true);
  });

  it("stop 进行中 DELETE 升级：B 仍被挡，clearChatGate 后才放行", () => {
    const id = alloc();
    tryReserveChatStart(id);
    cancelChatStart(id);
    expect(beginChatLifecycle(id, "stopping")).toBe(true);

    // DELETE 到达：升级成 deleting（stop finally 带 phase 不会误清）
    expect(beginChatLifecycle(id, "deleting")).toBe(true);
    expect(getChatLifecycle(id)).toBe("deleting");
    endChatLifecycle(id, "stopping");
    expect(getChatLifecycle(id)).toBe("deleting");
    expect(tryReserveChatStart(id)).toBeNull();

    clearChatGate(id);
    expect(tryReserveChatStart(id)).toEqual(expect.any(Number));
  });

  it("U2：deleting 持有期间（模拟 refs 清理窗口）tryReserve 必 null，clear 后恢复", () => {
    const id = alloc();
    expect(beginChatLifecycle(id, "deleting")).toBe(true);

    // 模拟 DELETE 已 cancel 旧 run、尚未 clearChatGate / deleteTask 的慢窗口
    expect(tryReserveChatStart(id)).toBeNull();
    expect(tryReserveChatStart(id)).toBeNull();
    expect(getChatLifecycle(id)).toBe("deleting");

    // 对齐成功路径：物理删完才 clearChatGate
    clearChatGate(id);
    expect(getChatLifecycle(id)).toBeNull();
    expect(tryReserveChatStart(id)).not.toBeNull();
  });
});
