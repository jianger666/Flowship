/**
 * 启动链 ephemeral 进度（server publishBootProgress）↔ 前端识别（chat-stream-display）的契约。
 *
 * 钉死：server 打的形状必须能被前端的渐进单行识别；user_reply 不会把它顶没；
 * agent 真活动出现才清；推送失败绝不影响发送主流程。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractActiveBootStage,
  isBootStageInfo,
} from "@/lib/chat-stream-display";
import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import type { TaskEvent } from "@/lib/types";

/** server 推送的流事件（只关心 event 这一种） */
type TaskStreamEventLike = { kind: string; event?: TaskEvent };

const publishTaskStreamEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/task-stream", () => ({ publishTaskStreamEvent }));

const { BOOT_TEXT_RESUME, BOOT_TEXT_SEND, publishBootProgress } = await import(
  "@/lib/server/boot-progress"
);

/** 取最近一次推送的 event（server 形状） */
const lastPublished = (): TaskEvent => {
  const call = publishTaskStreamEvent.mock.calls.at(-1)!;
  const published = call[1] as TaskStreamEventLike;
  expect(published.kind).toBe("event");
  return published.event as TaskEvent;
};

const ev = (kind: TaskEvent["kind"], text = ""): TaskEvent => ({
  id: `ev_${Math.random().toString(36).slice(2)}`,
  ts: Date.now(),
  kind,
  text,
});

describe("publishBootProgress", () => {
  beforeEach(() => {
    publishTaskStreamEvent.mockReset();
  });

  it("发给对应 task 的流；ephemeral id 前缀 + bootStage 标记 + 阶段名", () => {
    publishBootProgress("t_1", "resume", BOOT_TEXT_RESUME);
    expect(publishTaskStreamEvent).toHaveBeenCalledTimes(1);
    expect(publishTaskStreamEvent.mock.calls[0]![0]).toBe("t_1");
    const e = lastPublished();
    expect(e.kind).toBe("info");
    expect(e.id.startsWith("ephemeral_boot_resume_")).toBe(true);
    expect(e.text).toBe("正在恢复对话…");
    expect(e.meta).toEqual({ stage: "resume", bootStage: true });
  });

  it("续聊两阶段的文案", () => {
    expect(BOOT_TEXT_RESUME).toBe("正在恢复对话…");
    expect(BOOT_TEXT_SEND).toBe("正在发送…");
  });

  it("推送抛错：吞掉，绝不影响发送主流程", () => {
    publishTaskStreamEvent.mockImplementation(() => {
      throw new Error("sse 通道坏了");
    });
    expect(() => publishBootProgress("t_1", "send", BOOT_TEXT_SEND)).not.toThrow();
  });
});

describe("server 形状 ↔ 前端渐进单行契约", () => {
  beforeEach(() => {
    publishTaskStreamEvent.mockReset();
  });

  it("四个阶段都被前端识别为 boot 行，且 chat 事件流里不渲染它们", () => {
    for (const stage of ["mcp", "resume", "create", "send"] as const) {
      publishBootProgress("t_1", stage, "x");
      const e = lastPublished();
      expect(isBootStageInfo(e)).toBe(true);
      expect(isHiddenFromEventStream(e, { isChat: true })).toBe(true);
    }
  });

  it("续聊冷路径时序：上一轮回复在前，恢复 → 发送阶段相继到来，当前展示最新一条", () => {
    const events: TaskEvent[] = [ev("user_reply", "上一句"), ev("assistant_message", "上一轮回复")];
    publishBootProgress("t_1", "resume", BOOT_TEXT_RESUME);
    events.push(lastPublished());
    expect(extractActiveBootStage(events)?.text).toBe("正在恢复对话…");
    publishBootProgress("t_1", "send", BOOT_TEXT_SEND);
    events.push(lastPublished());
    expect(extractActiveBootStage(events)?.text).toBe("正在发送…");
  });

  it("user_reply 落盘不会把进度顶没（排队进来的消息 / 本条自己落盘都不算 AI 开口）", () => {
    const events: TaskEvent[] = [ev("assistant_message", "上一轮回复")];
    publishBootProgress("t_1", "send", BOOT_TEXT_SEND);
    events.push(lastPublished());
    events.push(ev("user_reply", "这条消息落盘了"));
    expect(extractActiveBootStage(events)?.text).toBe("正在发送…");
  });

  it("AI 真开口（thinking / 工具 / 正文 / 错误）才清", () => {
    for (const kind of ["thinking", "tool_call", "assistant_message", "error"] as const) {
      const events: TaskEvent[] = [ev("assistant_message", "上一轮回复")];
      publishBootProgress("t_1", "send", BOOT_TEXT_SEND);
      events.push(lastPublished());
      events.push(ev("user_reply", "本条"));
      events.push(ev(kind));
      expect(extractActiveBootStage(events)).toBeNull();
    }
  });
});
