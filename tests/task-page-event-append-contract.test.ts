/**
 * task 模式页面的事件追加语义要与 chat 路径一致（评审：page.tsx 的 task 模式 onEvent 是裸追加，
 * 没有 replay / rewind 处理，bootstrap 回放比本地更早的尾部会被接到末尾、时间序错乱）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(process.cwd(), "src/app/tasks/[id]/page.tsx"),
  "utf8",
);

describe("task 模式 useTaskWatch.onEvent", () => {
  const start = src.indexOf("onEvent: (ev, meta) => {");
  const body = src.slice(start, src.indexOf("onTaskUpdate: absorbTask,", start));

  it("走 appendTaskEvent（带 replay 标记），不再裸 [...prev.events, ev]", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("appendTaskEvent(prev, ev, { replay: meta?.replay === true })");
    expect(body).not.toContain("[...prev.events, ev]");
  });

  it("回退标记事件本地窗口对不齐时完整重拉（与 chat 路径同口径）", () => {
    expect(body).toContain("rewindNeedsResync(cur, ev)");
    expect(body).toContain("void resyncEvents()");
  });
});
