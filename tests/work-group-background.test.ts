/**
 * 折叠的「工作过程」组头：组里有工具已返回、但后台还在干活（shell 转后台 / 后台子代理）时，组头要继续转圈
 *（2026-10-19 用户要求全面排查「明明还在跑却显示完成」——折叠后里面的转圈看不见，
 * 组头只剩「工作过程 · N 步 · 时长」，读起来像全部结束了）。
 *
 * 关键边界：它只管组头转圈，**不**并进 hasRunning——hasRunning 管自动展开 / 「处理中…」占位，
 * 后台的活可能跑很久（dev server 一类），不能让组一直弹开。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { groupChatRenderItems, isWorkGroup } from "@/lib/chat-turns";
import {
  markBackgroundSubagentTools,
  mergeToolDisplayEvents,
  type StreamRenderItem,
} from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "kind" | "text">,
): TaskEvent => ({ id: `e${++seq}`, ts: 1000 + seq, ...partial });

const call = (callId: string, name = "task"): TaskEvent =>
  ev({
    kind: "tool_call",
    text: `调用 ${name}`,
    meta: { callId, name, args: '{"description":"渲染","prompt":"去渲染"}' },
  });
const result = (callId: string, output: string, name = "task"): TaskEvent =>
  ev({
    kind: "tool_result",
    text: `工具完成 ${name}`,
    meta: { callId, name, status: "success", output },
  });

const LAUNCH =
  "已在后台启动子代理「渲染」（后台任务 bg_0a1b2c3d）。它做完后系统会把它的输出作为一条消息发给你。";

const groupOf = (items: StreamRenderItem[]) => {
  const out = groupChatRenderItems(items);
  const g = out.find(isWorkGroup);
  if (!g || !isWorkGroup(g)) throw new Error("no work group");
  return g;
};

describe("WorkGroupItem.hasBackground", () => {
  it("组里有后台在跑的子代理卡 → hasBackground=true，且 hasRunning 仍是 false（不触发自动展开）", () => {
    const merged = mergeToolDisplayEvents([call("c1"), result("c1", LAUNCH)]);
    const marked = markBackgroundSubagentTools(merged, new Set(["bg_0a1b2c3d"]));
    const g = groupOf(marked);
    expect(g.hasBackground).toBe(true);
    expect(g.hasRunning).toBe(false);
  });

  it("清单里没有它了（跑完 / 取消）→ hasBackground=false，回到纯完成态", () => {
    const merged = mergeToolDisplayEvents([call("c1"), result("c1", LAUNCH)]);
    const marked = markBackgroundSubagentTools(merged, new Set());
    const g = groupOf(marked);
    expect(g.hasBackground).toBe(false);
    expect(g.hasRunning).toBe(false);
  });

  it("工具真的还在 running → 是 hasRunning、不是 hasBackground（两个信号分工不重叠）", () => {
    const merged = mergeToolDisplayEvents([call("c1", "shell")]);
    const g = groupOf(merged);
    expect(g.hasRunning).toBe(true);
    expect(g.hasBackground).toBe(false);
  });

  it("组里没有这类工具块（普通已完成工具）→ hasBackground=false", () => {
    const merged = mergeToolDisplayEvents([
      call("c1", "shell"),
      result("c1", "ok", "shell"),
    ]);
    const g = groupOf(merged);
    expect(g.hasBackground).toBe(false);
  });
});

describe("折叠组头的转圈（源码契约）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/components/tasks/event-stream/work-group.tsx"),
    "utf8",
  );

  it("组头：仅在 hasBackground 且折叠时替成员转圈；展开时让成员行自己转（同屏动效收敛）", () => {
    expect(src).toContain("group.hasBackground && !expanded");
    const idx = src.indexOf("group.hasBackground && !expanded");
    // 在 hasRunning 分支之后、时长之前：hasRunning 优先、转圈优先于时长
    expect(src.indexOf("group.hasRunning ?")).toBeLessThan(idx);
    expect(idx).toBeLessThan(src.indexOf("formatGroupDuration(group.startTs"));
    expect(src.slice(idx, idx + 600)).toContain("animate-spin");
  });

  it("hasBackground 不参与自动展开：autoExpanded 的判据里没有它", () => {
    const m = src.match(/const autoExpanded =[\s\S]*?;\n/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain("hasBackground");
  });
});
