/**
 * Chat 门闩 / 启动占位（chat-gate）原子性契约
 *
 * 覆盖 P1 #6 启动预约 + rewind 互斥、S1 可取消 lease，以及 T1 lifecycle：
 * tryReserveChatStart / cancelChatStart / isChatStartLeaseValid /
 * beginChatLifecycle / clearChatGate。纯同步、无 IO。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  beginChatLifecycle,
  cancelChatStart,
  clearChatGate,
  endChatLifecycle,
  endChatRewind,
  getChatLifecycle,
  hasChatStartReservation,
  isChatRewindInProgress,
  isChatStartLeaseValid,
  releaseChatStart,
  tryBeginChatRewind,
  tryReserveChatStart,
} from "../src/lib/server/chat-gate";

describe("chat-gate", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids) clearChatGate(id);
    ids.length = 0;
  });

  const alloc = (): string => {
    const id = `gate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  it("tryReserveChatStart 原子：第二次返回 null", () => {
    const id = alloc();
    const token = tryReserveChatStart(id);
    expect(token).toEqual(expect.any(Number));
    expect(hasChatStartReservation(id)).toBe(true);
    expect(tryReserveChatStart(id)).toBeNull();
    expect(hasChatStartReservation(id)).toBe(true);
  });

  it("release 后可再预约", () => {
    const id = alloc();
    const token = tryReserveChatStart(id);
    expect(token).not.toBeNull();
    releaseChatStart(id, token!);
    expect(hasChatStartReservation(id)).toBe(false);
    expect(tryReserveChatStart(id)).toEqual(expect.any(Number));
  });

  it("rewind 进行中预约失败", () => {
    const id = alloc();
    expect(tryBeginChatRewind(id)).toBe(true);
    expect(isChatRewindInProgress(id)).toBe(true);
    expect(tryReserveChatStart(id)).toBeNull();
    expect(hasChatStartReservation(id)).toBe(false);
    endChatRewind(id);
    expect(tryReserveChatStart(id)).toEqual(expect.any(Number));
  });

  it("tryBeginChatRewind 互斥：并发第二次 false", () => {
    const id = alloc();
    expect(tryBeginChatRewind(id)).toBe(true);
    expect(tryBeginChatRewind(id)).toBe(false);
    endChatRewind(id);
    expect(isChatRewindInProgress(id)).toBe(false);
    expect(tryBeginChatRewind(id)).toBe(true);
  });

  it("clearChatGate 清 rewind + 启动预约 + lifecycle", () => {
    const id = alloc();
    expect(tryBeginChatRewind(id)).toBe(true);
    // 手动塞启动预约（rewind 占着时 tryReserve 会失败，直接测 clear）
    expect(tryReserveChatStart(id)).toBeNull();
    endChatRewind(id);
    expect(tryReserveChatStart(id)).toEqual(expect.any(Number));
    expect(tryBeginChatRewind(id)).toBe(true);
    expect(beginChatLifecycle(id, "deleting")).toBe(true);
    clearChatGate(id);
    expect(isChatRewindInProgress(id)).toBe(false);
    expect(hasChatStartReservation(id)).toBe(false);
    expect(getChatLifecycle(id)).toBeNull();
    expect(tryReserveChatStart(id)).toEqual(expect.any(Number));
    expect(tryBeginChatRewind(id)).toBe(true);
  });

  describe("T1：stop/DELETE lifecycle", () => {
    it("begin stopping 后：tryReserve 返 null、既有 lease 失效；end 后可再预约", () => {
      const id = alloc();
      const token = tryReserveChatStart(id)!;
      expect(isChatStartLeaseValid(id, token)).toBe(true);
      expect(beginChatLifecycle(id, "stopping")).toBe(true);
      expect(getChatLifecycle(id)).toBe("stopping");
      expect(tryReserveChatStart(id)).toBeNull();
      expect(isChatStartLeaseValid(id, token)).toBe(false);
      endChatLifecycle(id, "stopping");
      expect(getChatLifecycle(id)).toBeNull();
      // 旧 lease 仍在（未 cancel）→ 仍挡新预约；先 release 再验「可预约」
      releaseChatStart(id, token);
      expect(tryReserveChatStart(id)).toEqual(expect.any(Number));
    });

    it("cancelled lease + stopping 进行中：tryReserve 仍 null（禁止覆盖）", () => {
      const id = alloc();
      const token = tryReserveChatStart(id)!;
      cancelChatStart(id);
      expect(beginChatLifecycle(id, "stopping")).toBe(true);
      // T1 核心：取消态在 stop 完成前不可被覆盖
      expect(tryReserveChatStart(id)).toBeNull();
      expect(isChatStartLeaseValid(id, token)).toBe(false);
      endChatLifecycle(id, "stopping");
      // stop 完成后才允许覆盖 cancelled
      const newToken = tryReserveChatStart(id);
      expect(newToken).not.toBeNull();
      expect(newToken).not.toBe(token);
    });

    it("deleting 优先：deleting 中 begin stopping 失败；stopping 可升级 deleting", () => {
      const id = alloc();
      expect(beginChatLifecycle(id, "deleting")).toBe(true);
      expect(beginChatLifecycle(id, "stopping")).toBe(false);
      expect(getChatLifecycle(id)).toBe("deleting");
      endChatLifecycle(id, "deleting");

      expect(beginChatLifecycle(id, "stopping")).toBe(true);
      expect(beginChatLifecycle(id, "deleting")).toBe(true);
      expect(getChatLifecycle(id)).toBe("deleting");
      // stop finally 带 phase=stopping → 升级后 no-op
      endChatLifecycle(id, "stopping");
      expect(getChatLifecycle(id)).toBe("deleting");
      endChatLifecycle(id, "deleting");
      expect(getChatLifecycle(id)).toBeNull();
    });

    it("R23-7：finalizing 与 stopping 同级；deleting 可从 finalizing 升级", () => {
      const id = alloc();
      expect(beginChatLifecycle(id, "finalizing")).toBe(true);
      expect(getChatLifecycle(id)).toBe("finalizing");
      // 同级互不覆盖
      expect(beginChatLifecycle(id, "stopping")).toBe(false);
      expect(getChatLifecycle(id)).toBe("finalizing");
      expect(tryReserveChatStart(id)).toBeNull();
      // deleting 可升级
      expect(beginChatLifecycle(id, "deleting")).toBe(true);
      expect(getChatLifecycle(id)).toBe("deleting");
      endChatLifecycle(id, "finalizing");
      expect(getChatLifecycle(id)).toBe("deleting");
      endChatLifecycle(id, "deleting");
      expect(getChatLifecycle(id)).toBeNull();
    });

    it("同 phase 重入返 false", () => {
      const id = alloc();
      expect(beginChatLifecycle(id, "stopping")).toBe(true);
      expect(beginChatLifecycle(id, "stopping")).toBe(false);
      endChatLifecycle(id, "stopping");
    });
  });

  describe("S1：可取消启动 lease", () => {
    it("cancelChatStart 后 isChatStartLeaseValid 为 false", () => {
      const id = alloc();
      const token = tryReserveChatStart(id);
      expect(token).not.toBeNull();
      expect(isChatStartLeaseValid(id, token!)).toBe(true);
      cancelChatStart(id);
      expect(isChatStartLeaseValid(id, token!)).toBe(false);
      // 条目仍在（标 cancelled），has 仍为真——rewind 交叉闭合
      expect(hasChatStartReservation(id)).toBe(true);
    });

    it("cancel 后新请求可覆盖预约（新 token），旧 token 仍失效", () => {
      const id = alloc();
      const oldToken = tryReserveChatStart(id)!;
      cancelChatStart(id);
      const newToken = tryReserveChatStart(id);
      expect(newToken).not.toBeNull();
      expect(newToken).not.toBe(oldToken);
      expect(isChatStartLeaseValid(id, oldToken)).toBe(false);
      expect(isChatStartLeaseValid(id, newToken!)).toBe(true);
    });

    it("release 带错 token 不删；带对 token 才删", () => {
      const id = alloc();
      const token = tryReserveChatStart(id)!;
      releaseChatStart(id, token + 999);
      expect(hasChatStartReservation(id)).toBe(true);
      releaseChatStart(id, token);
      expect(hasChatStartReservation(id)).toBe(false);
    });

    it("owner 可 release 已 cancelled 的本 token（自清）", () => {
      const id = alloc();
      const token = tryReserveChatStart(id)!;
      cancelChatStart(id);
      releaseChatStart(id, token);
      expect(hasChatStartReservation(id)).toBe(false);
    });
  });
});
