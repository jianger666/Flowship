/**
 * 进行中正文快照的合并决策（planAssistantSnapshot）+ 前端接线的契约检查。
 *
 * 用户反馈（2026-10-22）：生成中切走再切回，只看到后半截。服务端补了 assistant_snapshot 帧，
 * 这里钉死前端「把快照并回本地流式态」的规则：
 *   - 新挂载（本地什么都没有）→ 整段直接铺上（不逐字动画）；
 *   - 同页重连、本地是快照前缀 → 只补尾巴（已上屏长度不动、不闪空）；
 *   - 快照为空 / null → 清残留；已一致 → 不动；
 *   - 本地与快照冲突 → 以服务端为准整段替换。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { planAssistantSnapshot, type AssistantSnapshot } from "@/lib/assistant-live";
import { shouldClearStreamingOnEvent } from "@/lib/owner-run-signal";
import type { TaskEvent } from "@/lib/types";

const snap = (text: string): AssistantSnapshot => ({ id: "e1", text, total: text.length });

describe("planAssistantSnapshot", () => {
  it("快照为 null / 空文本：清掉本地残留（断线期间这段已经落盘了）", () => {
    expect(planAssistantSnapshot("残留的字", null)).toEqual({ kind: "clear" });
    expect(planAssistantSnapshot("", null)).toEqual({ kind: "clear" });
    expect(planAssistantSnapshot("残留", snap(""))).toEqual({ kind: "clear" });
  });

  it("新挂载（本地什么都没有）：整段直接铺上", () => {
    expect(planAssistantSnapshot("", snap("已经生成的全部"))).toEqual({
      kind: "replace",
      target: "已经生成的全部",
    });
  });

  it("同页重连、本地是快照前缀：只补尾巴（extend，保留已上屏长度）", () => {
    expect(planAssistantSnapshot("你好", snap("你好，世界"))).toEqual({
      kind: "extend",
      target: "你好，世界",
    });
  });

  it("已经一致：不动", () => {
    expect(planAssistantSnapshot("一致", snap("一致"))).toEqual({ kind: "keep" });
  });

  it("本地反而更长且以快照为前缀（不应出现的时序）：保守不动，不回退已显示的字", () => {
    expect(planAssistantSnapshot("你好，世界", snap("你好"))).toEqual({ kind: "keep" });
  });

  it("本地与快照冲突（换了一段）：以服务端为准整段替换", () => {
    expect(planAssistantSnapshot("旧的一段", snap("新的一段"))).toEqual({
      kind: "replace",
      target: "新的一段",
    });
  });

  it("emoji / 代理对不被拆：前缀判断按 UTF-16 串、与流式累积同口径", () => {
    expect(planAssistantSnapshot("好👍", snap("好👍棒"))).toEqual({ kind: "extend", target: "好👍棒" });
  });
});

describe("shouldClearStreamingOnEvent：bootstrap 回放不清流", () => {
  const msg = (extra: Partial<TaskEvent> = {}): TaskEvent =>
    ({ id: "x", ts: 1, kind: "assistant_message", text: "t", ...extra }) as TaskEvent;

  it("刚发生的属主 assistant_message 清；回放的历史尾部不清（由紧随的快照对齐）", () => {
    expect(shouldClearStreamingOnEvent(msg())).toBe(true);
    expect(shouldClearStreamingOnEvent(msg(), {})).toBe(true);
    expect(shouldClearStreamingOnEvent(msg(), { replay: false })).toBe(true);
    expect(shouldClearStreamingOnEvent(msg(), { replay: true })).toBe(false);
  });

  it("非 assistant_message 不清", () => {
    expect(shouldClearStreamingOnEvent(msg({ kind: "info" }))).toBe(false);
  });
});

describe("前端接线契约", () => {
  const read = (rel: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

  it("ChatView：接 onAssistantSnapshot；assistant_message 清流要带 !meta?.replay 守卫", () => {
    const src = read("src/components/tasks/chat-view.tsx");
    expect(src).toContain("onAssistantSnapshot: applyAssistantSnapshot");
    expect(src).toMatch(/applySnapshot: applyAssistantSnapshot/);
    expect(src).toContain('ev.kind === "assistant_message" && !meta?.replay');
  });

  it("任务页：onEvent 把 meta 交给 shouldClearStreamingOnEvent；接 onAssistantSnapshot", () => {
    const src = read("src/app/tasks/[id]/page.tsx");
    expect(src).toContain("shouldClearStreamingOnEvent(ev, meta)");
    expect(src).toContain("onAssistantSnapshot: applyAssistantSnapshot");
  });

  it("useTaskWatch：onAssistantSnapshot 经 callbacksRef 透传（带 cancelled 守卫）", () => {
    const src = read("src/hooks/use-task-watch.ts");
    expect(src).toMatch(
      /onAssistantSnapshot: \(snapshot\) => \{\s*if \(cancelled\) return;\s*callbacksRef\.current\.onAssistantSnapshot\?\.\(snapshot\);\s*\}/,
    );
  });

  it("三处 run 的 flush 都走 flushAssistantSegment（落盘复用预定 id、同步清快照），不再直接用 flushPendingAssistantDeltas + 手写落盘", () => {
    for (const rel of [
      "src/lib/server/chat-runner.ts",
      "src/lib/server/task-runner.ts",
      "src/lib/server/restricted-question.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("flushAssistantSegment(");
      expect(src, rel).not.toContain("flushPendingAssistantDeltas");
    }
  });
});
