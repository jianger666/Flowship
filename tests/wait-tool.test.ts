/**
 * `wait` 工具：工具层接线（handler / Cursor 工具构建 / 停止与删除唤醒 / pi 透传 signal）
 *
 * 运行时本身（时序 / 清理 / 文案）在 tests/session-wait.test.ts；steer 插话唤醒在 tests/chat-queue-send-now.test.ts。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupChatTaskState,
  invalidateCallerToken,
} from "@/lib/server/chat-pending";
import {
  buildSdkCustomTools,
  flowShipTools,
  withFlowshipSdkCustomTools,
} from "@/lib/server/flowship-tools";
import { WAIT_TOOL_NAME } from "@/lib/wait-display";
import {
  WAIT_MAX_SECONDS,
  activeWaitCount,
  interruptWaits,
} from "@/lib/server/session-wait";

const waitDef = flowShipTools.find((t) => t.name === WAIT_TOOL_NAME)!;

const textOf = (r: { content: Array<{ type: "text"; text: string }> }): string =>
  r.content.map((c) => c.text).join("");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("wait 工具定义", () => {
  it("工具名是 wait，且和 Cursor 原生 await / pi 编码工具不撞名", () => {
    expect(WAIT_TOOL_NAME).toBe("wait");
    expect(waitDef).toBeDefined();
    const names = flowShipTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("await");
    expect(names).not.toContain("sleep");
  });

  it("描述把关键事说清：别用 shell sleep / 原生 await；只是睡觉不替你检查；四种返回前缀", () => {
    const d = waitDef.description;
    expect(d).toContain("sleep");
    expect(d).toContain("await");
    expect(d).toContain("不会替你检查");
    expect(d).toContain(`1–${WAIT_MAX_SECONDS}`);
    for (const p of [
      "[WAIT_DONE]",
      "[WAIT_SKIPPED]",
      "[WAIT_INTERRUPTED]",
      "[WAIT_CANCELLED]",
    ]) {
      expect(d).toContain(p);
    }
  });

  it("描述不过度承诺：只有「立即发送」插话 / 子代理结果 / 停止 / 跳过会提前返回，普通排队消息不会；跳过不等于已完成", () => {
    const d = waitDef.description;
    expect(d).toContain("立即发送");
    expect(d).toContain("普通发送排进队列的消息要等这一轮结束才会送达，不会唤醒它");
    // 旧说法「用户插话也会让它提前返回」没有限定是哪种插话
    expect(d).not.toContain("用户插话也会让它提前返回");
    expect(d).toContain("不代表要等的事已完成");
    expect(d).toContain("立刻结束本轮");
  });

  it("schema：seconds 必填、reason 可选", () => {
    const schema = JSON.parse(JSON.stringify(waitDef.parameters)) as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["reason", "seconds"]);
    expect(schema.required).toEqual(["seconds"]);
  });
});

describe("wait handler", () => {
  it("到点：[WAIT_DONE]，带 reason；等待期间登记在 taskId 名下", async () => {
    const p = waitDef.handler({ seconds: 30, reason: "等 CI 跑完" }, "tok", {
      taskId: "t1",
    });
    expect(activeWaitCount("t1")).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const t = textOf(await p);
    expect(t).toMatch(/^\[WAIT_DONE\]/);
    expect(t).toContain("已等待 30s");
    expect(t).toContain("（等 CI 跑完）");
    expect(activeWaitCount("t1")).toBe(0);
  });

  it("seconds 非法（缺省 / 字符串 / 0 / 负数 / NaN）：报用法错误、不睡、不登记", async () => {
    for (const bad of [undefined, "30", 0, -1, Number.NaN]) {
      const t = textOf(await waitDef.handler({ seconds: bad }, "tok", { taskId: "t1" }));
      expect(t).toContain("参数错误");
      expect(t).toContain("seconds");
    }
    expect(activeWaitCount("t1")).toBe(0);
  });

  it("超上限：按上限等，并在返回里说一声", async () => {
    const p = waitDef.handler({ seconds: 99_999 }, "tok", { taskId: "t1" });
    await vi.advanceTimersByTimeAsync(WAIT_MAX_SECONDS * 1000);
    const t = textOf(await p);
    expect(t).toMatch(/^\[WAIT_DONE\]/);
    expect(t).toContain(`单次上限 ${WAIT_MAX_SECONDS}s`);
  });

  it("reason 超长被截断（模型自己填的，别让一段长文顶满状态行）", async () => {
    const p = waitDef.handler({ seconds: 1, reason: "长".repeat(500) }, "tok", {
      taskId: "t1",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const t = textOf(await p);
    expect(t).toContain("长".repeat(120));
    expect(t).not.toContain("长".repeat(121));
  });

  it("skip / steer：被对应原因叫醒，文案各自带下一步指示", async () => {
    const a = waitDef.handler({ seconds: 600 }, "tok", { taskId: "t1" });
    await vi.advanceTimersByTimeAsync(4000);
    interruptWaits("t1", "skip");
    const skip = textOf(await a);
    expect(skip).toMatch(/^\[WAIT_SKIPPED\]/);
    expect(skip).toContain("已等 4s / 计划 10m0s");

    const b = waitDef.handler({ seconds: 600 }, "tok", { taskId: "t1" });
    interruptWaits("t1", "steer");
    expect(textOf(await b)).toMatch(/^\[WAIT_INTERRUPTED\]/);
  });

  it("pi 路径带 signal：run 被取消 → 立刻 [WAIT_CANCELLED]", async () => {
    const ac = new AbortController();
    const p = waitDef.handler({ seconds: 600 }, "tok", {
      taskId: "t1",
      signal: ac.signal,
    });
    await vi.advanceTimersByTimeAsync(1000);
    ac.abort();
    expect(textOf(await p)).toMatch(/^\[WAIT_CANCELLED\]/);
  });

  it("没有 taskId 也能等（只是只能被定时器 / signal 结束，叫不醒）", async () => {
    const p = waitDef.handler({ seconds: 5 }, "tok");
    expect(interruptWaits(undefined, "cancel")).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(textOf(await p)).toMatch(/^\[WAIT_DONE\]/);
  });
});

describe("Cursor 路径：buildSdkCustomTools 把 taskId 带进回调", () => {
  it("带 taskId：回调登记在该任务名下，能被按 taskId 叫醒", async () => {
    const tools = buildSdkCustomTools("tok", { taskId: "t-cursor" });
    const p = tools.wait!.execute!({ seconds: 600 }, {} as never) as Promise<{
      content: Array<{ type: "text"; text: string }>;
    }>;
    expect(activeWaitCount("t-cursor")).toBe(1);
    interruptWaits("t-cursor", "skip");
    expect(textOf(await p)).toMatch(/^\[WAIT_SKIPPED\]/);
  });

  it("不带 taskId：不登记（叫不醒，等定时器）——调用方必须传 taskId 才有跳过 / 停止唤醒", async () => {
    const tools = buildSdkCustomTools("tok");
    const p = tools.wait!.execute!({ seconds: 3 }, {} as never) as Promise<{
      content: Array<{ type: "text"; text: string }>;
    }>;
    expect(activeWaitCount("t-cursor")).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(textOf(await p)).toMatch(/^\[WAIT_DONE\]/);
  });

  it("withFlowshipSdkCustomTools 把 opts.taskId 透传给 buildSdkCustomTools", async () => {
    const attached = withFlowshipSdkCustomTools(
      { cwd: "/tmp" },
      "tok",
      undefined,
      { taskId: "t-attach" },
    ) as { customTools: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }> };
    const p = attached.customTools.wait!.execute({ seconds: 600 }, {});
    expect(activeWaitCount("t-attach")).toBe(1);
    interruptWaits("t-attach", "cancel");
    await p;
  });
});

describe("停止 / 删除任务：在睡的 wait 立刻醒（Cursor 回调拿不到取消信号，必须主动叫醒）", () => {
  it("stop 路径：invalidateCallerToken 只失效 lease、不提前叫醒；cancel 之后的 cleanupChatTaskState 才叫醒 → [WAIT_CANCELLED]，且只叫醒这个任务", async () => {
    const mine = waitDef.handler({ seconds: 600 }, "tok", { taskId: "t-stop" });
    const other = waitDef.handler({ seconds: 600 }, "tok", { taskId: "t-other" });
    await vi.advanceTimersByTimeAsync(2000);
    invalidateCallerToken("t-stop");
    // stop 此刻还要等资源任务收尾、再取消主 run：wait 不能先把结果还给一个还没被取消的 run
    expect(activeWaitCount("t-stop")).toBe(1);
    cleanupChatTaskState("t-stop");
    expect(textOf(await mine)).toMatch(/^\[WAIT_CANCELLED\]/);
    expect(activeWaitCount("t-other")).toBe(1);
    interruptWaits("t-other", "cancel");
    await other;
  });

  it("stop-task 里叫醒（cleanupChatTaskState）必须排在取消主 run（cancelTaskRun / cancelChatRun）之后（源码契约）", () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, "..", "src", "lib", "server", "stop-task.ts"),
      "utf-8",
    );
    const cancelAt = src.indexOf("cancelTaskRun(id) || cancelChatRun(id)");
    const cleanupAt = src.indexOf("cleanupChatTaskState(id)");
    const invalidateAt = src.indexOf("invalidateCallerToken(id)");
    expect(invalidateAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(invalidateAt);
    expect(cleanupAt).toBeGreaterThan(cancelAt);
  });

  it("delete 路径（cleanupChatTaskState，不经 invalidateCallerToken）也叫醒", async () => {
    const p = waitDef.handler({ seconds: 600 }, "tok", { taskId: "t-del" });
    cleanupChatTaskState("t-del");
    expect(textOf(await p)).toMatch(/^\[WAIT_CANCELLED\]/);
    expect(activeWaitCount("t-del")).toBe(0);
  });

  it("没人在睡时停止 / 删除照常（不抛）", () => {
    expect(() => invalidateCallerToken("t-nobody")).not.toThrow();
    expect(() => cleanupChatTaskState("t-nobody")).not.toThrow();
  });
});

describe("pi 适配：execute 第三位 signal 与 taskId 必须透传（源码契约，pi 运行时在 node 测试里起不来）", () => {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "lib", "server", "custom-agent-backend.ts"),
    "utf-8",
  );
  const start = src.indexOf("? flowShipTools.map(");
  const end = src.indexOf("...buildCodingToolDefs(", start);
  const block = src.slice(start, end);

  it("映射块存在", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("execute 收 signal、handler 第三参带上 taskId / signal（漏了 = pi 下停止后 wait 睡到自然结束）", () => {
    expect(block).toMatch(/signal\?: AbortSignal/);
    expect(block).toMatch(/\.\.\.\(taskId \? \{ taskId \} : \{\}\)/);
    expect(block).toMatch(/\.\.\.\(signal \? \{ signal \} : \{\}\)/);
  });
});
