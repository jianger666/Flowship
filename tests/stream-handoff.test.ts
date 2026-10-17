/**
 * 流式 → 定稿「同一个节点」交接的判定（lib/stream-handoff）。
 * 症状：吐完字、定稿事件一到，整段正文卸载重挂 → 闪一下 / 跳几个像素。
 */
import { describe, expect, it } from "vitest";

import {
  INITIAL_STREAM_HANDOFF,
  findLastAssistantId,
  nextStreamHandoff,
  resolveItemKey,
  streamItemId,
  type StreamHandoffState,
} from "@/lib/stream-handoff";

const start = (
  prev: StreamHandoffState,
  lastAssistantId: string | null,
): StreamHandoffState =>
  nextStreamHandoff(prev, { streaming: true, lastAssistantId });
const end = (
  prev: StreamHandoffState,
  lastAssistantId: string | null,
): StreamHandoffState =>
  nextStreamHandoff(prev, { streaming: false, lastAssistantId });

describe("nextStreamHandoff", () => {
  it("没在流式、也没在等收尾：原样返回同一个引用（调用方靠它判断「没变化」不 setState）", () => {
    expect(end(INITIAL_STREAM_HANDOFF, "a1")).toBe(INITIAL_STREAM_HANDOFF);
  });

  it("流式开始：段号 +1、记下此刻最后一条 assistant 作基线；流式中重复推进返回同一个引用", () => {
    const s1 = start(INITIAL_STREAM_HANDOFF, "a1");
    expect(s1).toMatchObject({ active: true, seq: 1, baselineAssistantId: "a1" });
    expect(start(s1, "a1")).toBe(s1);
    // 流式中间别的 assistant 冒出来也不动基线（基线只在开始时取一次）
    expect(start(s1, "a2")).toBe(s1);
  });

  it("流式结束且流里冒出了新的 assistant_message：它接管这一段的流式项 key", () => {
    const s1 = start(INITIAL_STREAM_HANDOFF, "a1");
    const s2 = end(s1, "a2");
    expect(s2.active).toBe(false);
    expect(s2.aliases).toEqual({ a2: streamItemId(1) });
    expect(resolveItemKey("a2", s2.aliases)).toBe(streamItemId(1));
    // 别的事件仍用自己的 id
    expect(resolveItemKey("a1", s2.aliases)).toBe("a1");
  });

  it("首条回复：基线为 null、结束时冒出第一条 assistant 同样接管", () => {
    const s = end(start(INITIAL_STREAM_HANDOFF, null), "a1");
    expect(s.aliases).toEqual({ a1: streamItemId(1) });
  });

  it("流式结束但没有新定稿（被停止 / 报错 / 定稿还在路上）：不登记——不会错认别的事件", () => {
    const s1 = start(INITIAL_STREAM_HANDOFF, "a1");
    const s2 = end(s1, "a1");
    expect(s2.aliases).toEqual({});
    expect(s2.active).toBe(false);
    const s3 = end(start(INITIAL_STREAM_HANDOFF, null), null);
    expect(s3.aliases).toEqual({});
  });

  it("多段流式：每段 key 唯一，上一段被接管的 key 不会被下一段撞上", () => {
    let s = start(INITIAL_STREAM_HANDOFF, null);
    s = end(s, "a1");
    s = start(s, "a1");
    expect(streamItemId(s.seq)).toBe(streamItemId(2));
    expect(streamItemId(2)).not.toBe(streamItemId(1));
    s = end(s, "a2");
    expect(s.aliases).toEqual({
      a1: streamItemId(1),
      a2: streamItemId(2),
    });
    // 新一段流式中，streamItemId(3) 与两个已接管 key 都不同
    s = start(s, "a2");
    expect(Object.values(s.aliases)).not.toContain(streamItemId(s.seq));
  });

  it("不改入参：老状态的 aliases 保持不变", () => {
    const s1 = start(INITIAL_STREAM_HANDOFF, null);
    const s2 = end(s1, "a1");
    expect(s1.aliases).toEqual({});
    expect(INITIAL_STREAM_HANDOFF.aliases).toEqual({});
    expect(s2.aliases).not.toBe(s1.aliases);
  });
});

describe("findLastAssistantId", () => {
  it("从尾往前找第一条 assistant_message；没有 → null", () => {
    expect(
      findLastAssistantId([
        { kind: "user_reply", id: "u1" },
        { kind: "assistant_message", id: "a1" },
        { kind: "__work_group__", id: "g1" },
        { kind: "assistant_message", id: "a2" },
        { kind: "__work_group__", id: "g2" },
      ]),
    ).toBe("a2");
    expect(findLastAssistantId([{ kind: "user_reply", id: "u1" }])).toBeNull();
    expect(findLastAssistantId([])).toBeNull();
  });
});

describe("streamItemId", () => {
  it("以 __ 开头（滚动锚点 / 虚拟项判定按前缀跳过），且按段编号", () => {
    expect(streamItemId(7).startsWith("__")).toBe(true);
    expect(streamItemId(1)).not.toBe(streamItemId(2));
  });
});
