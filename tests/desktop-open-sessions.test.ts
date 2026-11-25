/**
 * 「任务名下可能还开着电脑操作会话」的登记（src/lib/server/desktop/open-sessions.ts）。
 *
 * 它是停止钩子的依据：用户点停止 / 删除任务时，如果这个任务可能开着会话（电脑是我们解锁的、遮罩盖着），
 * 即使此刻没有任何请求在飞，也要通知主进程撤遮罩、锁回去。这里钉死登记本身的语义：宁多勿少、可清、有上限、全局单例。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetDesktopOpenSessionsForTest,
  hasOpenDesktopSession,
  markDesktopSessionClosed,
  markDesktopSessionOpen,
  MAX_TRACKED_TASKS,
} from "@/lib/server/desktop/open-sessions";

afterEach(() => __resetDesktopOpenSessionsForTest());

describe("登记 / 查询 / 清除", () => {
  it("没登记过 → false；登记后 → true；清除后 → false；重复登记 / 重复清除都无害", () => {
    expect(hasOpenDesktopSession("t1")).toBe(false);
    markDesktopSessionOpen("t1");
    markDesktopSessionOpen("t1");
    expect(hasOpenDesktopSession("t1")).toBe(true);
    markDesktopSessionClosed("t1");
    markDesktopSessionClosed("t1");
    expect(hasOpenDesktopSession("t1")).toBe(false);
    expect(() => markDesktopSessionClosed("从没登记过")).not.toThrow();
  });

  it("按任务隔离：清一个不影响另一个", () => {
    markDesktopSessionOpen("t1");
    markDesktopSessionOpen("t2");
    markDesktopSessionClosed("t1");
    expect(hasOpenDesktopSession("t1")).toBe(false);
    expect(hasOpenDesktopSession("t2")).toBe(true);
  });

  it("不合格的 taskId 不登记（路径穿越 / 空 / 超长 / 非字符串）；查询 / 清除对它们也不抛", () => {
    for (const id of ["../x", "a b", "", "x".repeat(201), 123, null, undefined, {}]) {
      markDesktopSessionOpen(id as never);
      expect(hasOpenDesktopSession(id as never)).toBe(false);
      expect(() => markDesktopSessionClosed(id as never)).not.toThrow();
    }
    markDesktopSessionOpen("x".repeat(200)); // 正好 200 个字符可以
    expect(hasOpenDesktopSession("x".repeat(200))).toBe(true);
  });
});

describe("上限：长期运行下不会无限增长，满了丢最老的", () => {
  it(`超过 ${MAX_TRACKED_TASKS} 个任务：最老的被挤掉，最新的都在`, () => {
    for (let i = 0; i < MAX_TRACKED_TASKS + 5; i += 1) markDesktopSessionOpen(`task-${i}`);
    expect(hasOpenDesktopSession("task-0")).toBe(false);
    expect(hasOpenDesktopSession("task-4")).toBe(false);
    expect(hasOpenDesktopSession("task-5")).toBe(true);
    expect(hasOpenDesktopSession(`task-${MAX_TRACKED_TASKS + 4}`)).toBe(true);
  });

  it("重新登记 = 挪到最新（正在用的任务不会因为排得靠前被先挤掉）", () => {
    for (let i = 0; i < MAX_TRACKED_TASKS; i += 1) markDesktopSessionOpen(`task-${i}`);
    markDesktopSessionOpen("task-0"); // 最老的又被用了一次
    markDesktopSessionOpen("newcomer"); // 满了：挤掉的应该是 task-1，不是 task-0
    expect(hasOpenDesktopSession("task-0")).toBe(true);
    expect(hasOpenDesktopSession("task-1")).toBe(false);
    expect(hasOpenDesktopSession("newcomer")).toBe(true);
  });
});

describe("全局单例（HMR / 多 bundle 共用一份）", () => {
  it("重新加载模块后还是同一份登记：停止钩子（browser/tools.ts）与工具（desktop/tools.ts）各看各的就等于没有", async () => {
    markDesktopSessionOpen("t-shared");
    vi.resetModules();
    const again = await import("@/lib/server/desktop/open-sessions");
    expect(again.hasOpenDesktopSession("t-shared")).toBe(true);
    again.markDesktopSessionClosed("t-shared");
    expect(hasOpenDesktopSession("t-shared")).toBe(false);
  });
});
