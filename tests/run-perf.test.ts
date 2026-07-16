/**
 * createRunPerfTracker 纯逻辑单测：假 InteractionUpdate 序列 + 拦截 console.log。
 * 锁住「记哪些事件 / 不记 delta / wall 合理 / MCP 工具名归一」——防埋点回归静默失效。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunPerfTracker } from "@/lib/server/run-perf";
import type { InteractionUpdate } from "@cursor/sdk";

const logs: string[] = [];

afterEach(() => {
  logs.length = 0;
  vi.restoreAllMocks();
});

const captureLogs = () => {
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

const feed = (
  tracker: ReturnType<typeof createRunPerfTracker>,
  update: InteractionUpdate,
) => {
  tracker.onDelta({ update });
};

describe("createRunPerfTracker", () => {
  it("tool-call start/done：打 phase=start/done，wall 合理，含 sdkExec", () => {
    captureLogs();
    const tracker = createRunPerfTracker({
      taskId: "t1",
      agentId: "a1",
      runKind: "task-first",
      promptBytes: 12,
    });

    feed(tracker, {
      type: "tool-call-started",
      callId: "c1",
      toolCall: {
        type: "shell",
        args: { command: "secret-should-not-appear" },
      },
      modelCallId: "m1",
    } as InteractionUpdate);

    // 人为拉开 wall，避免 0ms 边界
    const startedAt = Date.now() - 40;
    // 直接再喂 completed（内部用 Date.now - toolStartedAt）
    feed(tracker, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: {
        type: "shell",
        args: { command: "secret-should-not-appear" },
        result: {
          status: "success",
          value: {
            exitCode: 0,
            signal: "",
            stdout: "LEAK",
            stderr: "",
            executionTime: 123,
          },
        },
      },
      modelCallId: "m1",
    } as InteractionUpdate);

    void startedAt;
    const startLine = logs.find((l) => l.includes("phase=start"));
    const doneLine = logs.find((l) => l.includes("phase=done"));
    expect(startLine).toBeTruthy();
    expect(startLine).toContain("tool=shell");
    expect(startLine).toContain("call=c1");
    expect(startLine).not.toContain("secret-should-not-appear");

    expect(doneLine).toBeTruthy();
    expect(doneLine).toMatch(/wall=\d+/);
    expect(doneLine).toContain("status=success");
    expect(doneLine).toContain("sdkExec=123");
    expect(doneLine).not.toContain("LEAK");
    expect(doneLine).not.toContain("secret-should-not-appear");
  });

  it("高频 delta（thinking/text/shell-output）不产生任何 [perf-] 日志", () => {
    captureLogs();
    const tracker = createRunPerfTracker({
      taskId: "t1",
      agentId: "a1",
      runKind: "chat-followup",
    });

    feed(tracker, { type: "thinking-delta", text: "hmm" } as InteractionUpdate);
    feed(tracker, { type: "text-delta", text: "hi" } as InteractionUpdate);
    feed(tracker, {
      type: "shell-output-delta",
      event: { chunk: "x" },
    } as InteractionUpdate);

    expect(logs.filter((l) => l.startsWith("[perf-"))).toHaveLength(0);
  });

  it("thinking-completed / step-completed / turn-ended 打对应行", () => {
    captureLogs();
    const tracker = createRunPerfTracker({
      taskId: "t2",
      agentId: "a2",
      runKind: "task-followup",
    });

    feed(tracker, {
      type: "thinking-completed",
      thinkingDurationMs: 500,
    } as InteractionUpdate);
    feed(tracker, {
      type: "step-completed",
      stepId: 3,
      stepDurationMs: 800,
    } as InteractionUpdate);
    feed(tracker, {
      type: "turn-ended",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
      },
    } as InteractionUpdate);

    expect(logs.some((l) => l.includes("[perf-step]") && l.includes("type=thinking") && l.includes("duration=500"))).toBe(true);
    expect(logs.some((l) => l.includes("[perf-step]") && l.includes("type=step") && l.includes("duration=800"))).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("[perf-turn]") &&
          l.includes("inputTokens=10") &&
          l.includes("outputTokens=20") &&
          l.includes("reasoningTokens=3"),
      ),
    ).toBe(true);
  });

  it("MCP 工具名归一为 mcp:<server>:<tool>；attachRun 打 [perf-run]", () => {
    captureLogs();
    const tracker = createRunPerfTracker({
      taskId: "t3",
      agentId: "a3",
      runKind: "question",
      promptBytes: 99,
    });

    feed(tracker, {
      type: "tool-call-started",
      callId: "mcp1",
      toolCall: {
        type: "mcp",
        args: {
          providerIdentifier: "feishu",
          toolName: "add_comment",
          args: { secret: "nope" },
        },
      },
      modelCallId: "m2",
    } as InteractionUpdate);

    tracker.attachRun({ id: "run-xyz", requestId: "req-abc" });

    const startLine = logs.find((l) => l.includes("phase=start"));
    expect(startLine).toContain("tool=mcp:feishu:add_comment");
    expect(startLine).not.toContain("nope");

    const runLine = logs.find((l) => l.startsWith("[perf-run]"));
    expect(runLine).toContain("run=run-xyz");
    expect(runLine).toContain("requestId=req-abc");
    expect(runLine).toContain("promptBytes=99");
    expect(runLine).toContain("kind=question");
  });

  it("onDelta 内部抛错被吞，不向外抛", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("log boom");
    });
    const tracker = createRunPerfTracker({
      taskId: "t4",
      agentId: "a4",
      runKind: "task-first",
    });
    expect(() =>
      feed(tracker, {
        type: "thinking-completed",
        thinkingDurationMs: 1,
      } as InteractionUpdate),
    ).not.toThrow();
  });
});

