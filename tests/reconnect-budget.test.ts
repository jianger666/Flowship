/**
 * 自动重连预算（S1b-04）：纯函数 + task-runner 接线契约
 *
 * 行为级验证见 tests/task-reconnect-budget-reset.test.ts（真走 tryAutoReconnect）；
 * 这里钉：① 哪些 SDK 消息算「重连恢复了」；② 追踪器只在 used>0 时归零；
 * ③ task-runner 里归零信号、catch 重连、追问续跑、总次数上限四处接线没被改丢。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  RECONNECT_TOTAL_MAX,
  createReconnectBudget,
  isReconnectRecoverySignal,
} from "@/lib/server/reconnect-budget";

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf-8");

describe("isReconnectRecoverySignal：只认模型那头真有产出的消息", () => {
  it("assistant 非空正文 / tool_use 块 → 算", () => {
    expect(
      isReconnectRecoverySignal({
        type: "assistant",
        message: { content: [{ type: "text", text: "你好" }] },
      }),
    ).toBe(true);
    expect(
      isReconnectRecoverySignal({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "c1", name: "shell", input: {} }] },
      }),
    ).toBe(true);
  });

  it("thinking 有文本 / tool_call / usage → 算", () => {
    expect(isReconnectRecoverySignal({ type: "thinking", text: "想一想" })).toBe(true);
    expect(
      isReconnectRecoverySignal({ type: "tool_call", call_id: "c", name: "shell", status: "running" }),
    ).toBe(true);
    expect(isReconnectRecoverySignal({ type: "usage", usage: {} })).toBe(true);
  });

  it("system init / status（含 RUNNING、ERROR、EXPIRED）/ request / task / user → 不算", () => {
    expect(isReconnectRecoverySignal({ type: "system", subtype: "init" })).toBe(false);
    expect(isReconnectRecoverySignal({ type: "status", status: "RUNNING" })).toBe(false);
    // ERROR / EXPIRED 是「没通」的明证，更不能算
    expect(
      isReconnectRecoverySignal({ type: "status", status: "ERROR", message: "boom" }),
    ).toBe(false);
    expect(isReconnectRecoverySignal({ type: "status", status: "EXPIRED" })).toBe(false);
    expect(isReconnectRecoverySignal({ type: "request", request_id: "r" })).toBe(false);
    expect(isReconnectRecoverySignal({ type: "task", status: "x" })).toBe(false);
    expect(
      isReconnectRecoverySignal({
        type: "user",
        message: { content: [{ type: "text", text: "我说的" }] },
      }),
    ).toBe(false);
  });

  it("空文本 / 空内容 / 畸形消息一律不算（脏数据不能放开重连环）", () => {
    expect(isReconnectRecoverySignal({ type: "thinking", text: "" })).toBe(false);
    expect(isReconnectRecoverySignal({ type: "thinking" })).toBe(false);
    expect(
      isReconnectRecoverySignal({
        type: "assistant",
        message: { content: [{ type: "text", text: "" }] },
      }),
    ).toBe(false);
    expect(isReconnectRecoverySignal({ type: "assistant", message: { content: [] } })).toBe(false);
    expect(isReconnectRecoverySignal({ type: "assistant", message: { content: "x" } })).toBe(false);
    expect(isReconnectRecoverySignal({ type: "assistant" })).toBe(false);
    expect(isReconnectRecoverySignal(null)).toBe(false);
    expect(isReconnectRecoverySignal(undefined)).toBe(false);
    expect(isReconnectRecoverySignal("assistant")).toBe(false);
    expect(isReconnectRecoverySignal({})).toBe(false);
  });
});

describe("createReconnectBudget", () => {
  const productive = {
    type: "assistant",
    message: { content: [{ type: "text", text: "继续干活" }] },
  };

  it("初始用量带进来；非恢复消息不归零；恢复信号后归零并返回 true", () => {
    const b = createReconnectBudget(3);
    expect(b.used).toBe(3);
    expect(b.noteSdkMessage({ type: "system", subtype: "init" })).toBe(false);
    expect(b.noteSdkMessage({ type: "status", status: "ERROR" })).toBe(false);
    expect(b.used).toBe(3);
    expect(b.noteSdkMessage(productive)).toBe(true);
    expect(b.used).toBe(0);
  });

  it("已是 0 时不再「归零」（返回 false、不重复打日志）", () => {
    const b = createReconnectBudget(0);
    expect(b.noteSdkMessage(productive)).toBe(false);
    expect(b.used).toBe(0);
    expect(createReconnectBudget().used).toBe(0);
  });

  it("非法初值（负数 / NaN 之外的小数）被收敛成非负整数", () => {
    expect(createReconnectBudget(-2).used).toBe(0);
    expect(createReconnectBudget(2.9).used).toBe(2);
  });

  it("归零后只在又一次恢复信号时再归零（不会「负数」）", () => {
    const b = createReconnectBudget(2);
    b.noteSdkMessage(productive);
    expect(b.used).toBe(0);
    b.noteSdkMessage(productive);
    expect(b.used).toBe(0);
  });
});

describe("task-runner 接线契约（S1b-04）", () => {
  const src = read("src/lib/server/task-runner.ts");

  it("总次数硬上限 > 单轮预算 5，且不改 RECONNECT_MAX 的既有语义", () => {
    expect(RECONNECT_TOTAL_MAX).toBeGreaterThan(5);
    expect(src).toMatch(/const RECONNECT_MAX = 5;/);
  });

  it("tryAutoReconnect：累计 reconnectTotal，超上限直接 give-up，并透传给下一轮与重连后的 consume", () => {
    expect(src).toMatch(/const total = \(opts\.reconnectTotal \?\? 0\) \+ 1;/);
    expect(src).toMatch(/if \(total > RECONNECT_TOTAL_MAX\) return "give-up";/);
    expect(src).toMatch(/reconnectTotal: total,\s*\n\s*reconnectSessionInstanceId/);
    expect(src).toMatch(
      /await consumeSessionRun\(fresh, resumedAgent, run, \{[\s\S]*?reconnectAttempt: attempt,\s*\n\s*reconnectTotal: total,/,
    );
  });

  it("consumeSessionRun：用入场的已用次数建预算，流循环里喂每条消息", () => {
    expect(src).toMatch(
      /const reconnectBudget = createReconnectBudget\(opts\.reconnectAttempt \?\? 0\);/,
    );
    expect(src).toMatch(
      /for await \(const msg of run\.stream\(\)\) \{[\s\S]*?reconnectBudget\.noteSdkMessage\(msg\)[\s\S]*?await handleSdkMessage\(task\.id, msg/,
    );
  });

  it("consume 的 catch 重连 / 追问续跑都取「当前」预算，而不是入场时的旧 opts.reconnectAttempt", () => {
    expect(src).toMatch(
      /tryAutoReconnect\(\s*task,\s*err,\s*\{ \.\.\.opts, reconnectAttempt: reconnectBudget\.used \},/,
    );
    expect(src).toMatch(
      /consumeSessionRun\(task, agent, nextRun, \{\s*\.\.\.opts,[\s\S]*?reconnectAttempt: reconnectBudget\.used,/,
    );
  });

  it("归零信号不得放宽成「send 受理」：tryAutoReconnect 里没有在 send 成功后把 reconnectAttempt 置 0", () => {
    const start = src.indexOf("const tryAutoReconnect = async (");
    const end = src.indexOf("export const handleRunFailure");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/reconnectAttempt:\s*0\b/);
  });
});
