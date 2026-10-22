/**
 * V8-02：shell 输出流式帧 id 同毫秒碰撞。
 *
 * 旧 id = `ephemeral_tod_${callId}_${Date.now()}`。watch-task 路由用 sentEventIds 对 event 帧去重
 * （同一 id 只发一次），所以同一 callId 在同一毫秒内 flush 两次（≥2KB 的大块连着来 /
 * 刚 flush 完紧接着 tool-call-completed 的收尾 flush）时，后一块被当「已发过」整块丢掉——
 * 实时输出缺一截，且只在 SSE 里出现、不落盘、事后无从补。
 *
 * 修法：id 末尾加进程内单调计数；前缀 `ephemeral_tod_` 不变（tool-display 靠它识别 ephemeral）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { InteractionUpdate } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isEphemeralToolOutputDelta } from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

const hoisted = vi.hoisted(() => ({
  published: [] as Array<{ taskId: string; ev: { kind: string; event?: TaskEvent } }>,
}));

vi.mock("@/lib/server/task-stream", () => ({
  publish: (taskId: string, ev: { kind: string; event?: TaskEvent }) => {
    hoisted.published.push({ taskId, ev });
  },
  writeOwnedEventAndPublish: vi.fn(),
}));

const { createShellOutputDeltaPublisher } = await import("@/lib/server/shell-output-bridge");

const started = (callId: string): { update: InteractionUpdate } => ({
  update: { type: "tool-call-started", callId, toolCall: { type: "shell" } } as InteractionUpdate,
});
const stdout = (data: string): { update: InteractionUpdate } => ({
  update: {
    type: "shell-output-delta",
    event: { case: "stdout", value: { data } },
  } as InteractionUpdate,
});
const completed = (callId: string): { update: InteractionUpdate } => ({
  update: { type: "tool-call-completed", callId } as InteractionUpdate,
});

const frameIds = (): string[] =>
  hoisted.published
    .filter((p) => p.ev.kind === "event" && p.ev.event?.kind === "tool_output_delta")
    .map((p) => p.ev.event!.id);

/** 与 watch-task 路由同口径的去重：同一 id 只放行一次 */
const passRouteDedup = (ids: string[]): string[] => {
  const sent = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (sent.has(id)) continue;
    sent.add(id);
    out.push(id);
  }
  return out;
};

beforeEach(() => {
  hoisted.published.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(1_760_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("shell-output-bridge ephemeral 帧 id", () => {
  it("同一 callId 同一毫秒内连发多块 → id 各不相同，过路由去重一块不丢", () => {
    const onDelta = createShellOutputDeltaPublisher("t_same_ms");
    onDelta(started("call_1"));
    // 每块 ≥2KB → 每块都立刻 flush；假时钟不走 → Date.now() 完全相同
    onDelta(stdout("a".repeat(2100)));
    onDelta(stdout("b".repeat(2100)));
    onDelta(stdout("c".repeat(2100)));
    // 收尾 flush：缓冲里还有一小块
    onDelta(stdout("tail"));
    onDelta(completed("call_1"));

    const ids = frameIds();
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(passRouteDedup(ids)).toHaveLength(4);
  });

  it("不同发布器（不同任务 / 不同 run）撞上同 callId 同毫秒也不重复（计数是进程级的）", () => {
    const a = createShellOutputDeltaPublisher("t_a");
    const b = createShellOutputDeltaPublisher("t_b");
    a(started("call_same"));
    b(started("call_same"));
    a(stdout("x".repeat(2100)));
    b(stdout("y".repeat(2100)));
    const ids = frameIds();
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("id 单调递增（计数部分严格增长）", () => {
    const onDelta = createShellOutputDeltaPublisher("t_mono");
    onDelta(started("call_m"));
    for (let i = 0; i < 5; i += 1) onDelta(stdout(String(i).repeat(2100)));
    const seqs = frameIds().map((id) => Number(id.slice(id.lastIndexOf("_") + 1)));
    expect(seqs).toHaveLength(5);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("前缀仍是 ephemeral_tod_（tool-display 靠它识别 ephemeral 帧），且含 callId", () => {
    const onDelta = createShellOutputDeltaPublisher("t_prefix");
    onDelta(started("call_p"));
    onDelta(stdout("z".repeat(2100)));
    const ev = hoisted.published.find((p) => p.ev.kind === "event")!.ev.event!;
    expect(ev.id.startsWith("ephemeral_tod_call_p_")).toBe(true);
    expect(isEphemeralToolOutputDelta({ ...ev, kind: "info" } as TaskEvent)).toBe(true);
  });

  it("帧内容不受影响：callId / chunk 原样带出", () => {
    const onDelta = createShellOutputDeltaPublisher("t_content");
    onDelta(started("call_c"));
    onDelta(stdout("h".repeat(2100)));
    const ev = hoisted.published.find((p) => p.ev.kind === "event")!.ev.event!;
    expect(ev.kind).toBe("tool_output_delta");
    expect(ev.meta?.callId).toBe("call_c");
    expect(ev.meta?.chunk).toBe("h".repeat(2100));
  });
});

describe("成因契约：watch-task 路由确实按 event id 去重（所以 id 必须唯一）", () => {
  it("dispatchStreamEvent 对 event 帧 sentEventIds.has → return", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/api/tasks/[id]/watch-task/route.ts"),
      "utf8",
    );
    expect(src).toMatch(/if \(sentEventIds\.has\(ev\.event\.id\)\) return;/);
  });
});
