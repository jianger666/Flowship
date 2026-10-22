/**
 * 第三轮 review D9-03：打开 / 切回一个**正在运行**的会话，首个 commit 把在跑的工具块画成「已中断」
 *
 * 事实：`runActive` latch 初值 false，`runStatus === "running"` 要等 effect（paint 之后）才置 true；
 * 而 EventStream 的 `isRunning=false` 会走 `coerceStaleRunningTools`（未闭合 tool_call → interrupted）、
 * 也不跑 `markBackgroundRunningTools`。passive effect 补 true 之前，那一帧就是灰色「已中断」。
 * 注意：task 页的 task 是异步加载的（挂载时 null），所以光改 `useState` 初值不够——
 * 加载完成那次渲染里 latch 仍是上一次 reset 出来的 false；必须**渲染期**就吃 task.runStatus。
 *
 * 修法：渲染期 `effectiveRunActive(latch, runStatus) = latch || runStatus === "running"`；
 * latch 只负责「runStatus 已落下去但流式尾巴还在吐」那一段（语义不变）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { deriveRunFlags, effectiveRunActive } from "../src/lib/owner-run-signal";
import { coerceStaleRunningTools, mergeToolDisplayEvents } from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const ev = (id: string, kind: TaskEvent["kind"], extra: Partial<TaskEvent> = {}): TaskEvent =>
  ({ id, ts: 1000 + Number(id.replace(/\D/g, "")), kind, text: "", ...extra }) as TaskEvent;

const events: TaskEvent[] = [
  ev("e1", "user_reply", { text: "跑一下测试" }),
  ev("e2", "tool_call", {
    text: "shell",
    meta: { callId: "c1", name: "shell", args: JSON.stringify({ command: "pnpm test" }) },
  }),
];

/** event-stream 对 isRunning 的用法（event-stream.tsx 的 buildStreamItems：未在跑就 coerce） */
const toolStatusesOnFirstFrame = (isRunning: boolean): string[] => {
  const merged = mergeToolDisplayEvents(events);
  const tools = isRunning ? merged : coerceStaleRunningTools(merged);
  return tools
    .filter((b) => (b as { kind?: string }).kind === "__tool_block__")
    .map((b) => (b as unknown as { status: string }).status);
};

describe("effectiveRunActive：渲染期口径", () => {
  it("runStatus 是 running → 一定算在跑（哪怕 latch 还没来得及置位）", () => {
    expect(effectiveRunActive(false, "running")).toBe(true);
    expect(effectiveRunActive(true, "running")).toBe(true);
  });

  it("latch 仍负责收尾窗口：runStatus 已落下去、latch 还没放 → 仍算在跑；都没有才是空闲", () => {
    expect(effectiveRunActive(true, "awaiting_user")).toBe(true);
    expect(effectiveRunActive(true, "idle")).toBe(true);
    expect(effectiveRunActive(false, "idle")).toBe(false);
    expect(effectiveRunActive(false, "awaiting_user")).toBe(false);
    expect(effectiveRunActive(false, "error")).toBe(false);
  });
});

describe("deriveRunFlags 吃 runStatus", () => {
  it("首个 commit：latch=false 但 runStatus=running → isRunning / mainRunActive 都已是 true", () => {
    expect(
      deriveRunFlags({ runActive: false, runStatus: "running" }),
    ).toEqual({ isRunning: true, mainRunActive: true });
  });

  it("主任务空闲：isRunning / mainRunActive 都 false（旁路不并入，第四轮 Q5-01）", () => {
    expect(deriveRunFlags({ runActive: false, runStatus: "idle" })).toEqual({
      isRunning: false,
      mainRunActive: false,
    });
  });

  it("不传 runStatus = 旧行为（只看 latch）", () => {
    expect(deriveRunFlags({ runActive: false })).toEqual({
      isRunning: false,
      mainRunActive: false,
    });
  });
});

describe("D9-03 首帧：在跑的工具块不被画成「已中断」", () => {
  it("复现（改前口径）：latch=false 的首帧 → interrupted", () => {
    expect(toolStatusesOnFirstFrame(false)).toEqual(["interrupted"]);
  });

  it("修后：首帧用 deriveRunFlags(runStatus=running).isRunning → 仍是 running（转圈）", () => {
    const { isRunning } = deriveRunFlags({
      runActive: false,
      runStatus: "running",
    });
    expect(toolStatusesOnFirstFrame(isRunning)).toEqual(["running"]);
  });

  it("真空闲（runStatus=idle、无 latch）的历史脏数据照旧被判「已中断」（coerce 的本职不被削弱）", () => {
    const { isRunning } = deriveRunFlags({
      runActive: false,
      runStatus: "idle",
    });
    expect(toolStatusesOnFirstFrame(isRunning)).toEqual(["interrupted"]);
  });
});

describe("接线（源码契约，仅钉位置）", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");

  it("task 页：运行态来自 deriveRunFlags({…, runStatus: task.runStatus})", () => {
    const page = read("src/app/tasks/[id]/page.tsx");
    expect(page).toContain(
      "deriveRunFlags({ runActive, runStatus: task.runStatus })",
    );
    // Q5-01 / Q5-05：旁路不进页面状态；输入条吃 mainRunActive（含 runStatus 补位），不吃裸 latch
    expect(page).not.toContain("restrictedRunActive");
    expect(page).toContain("runActive={runFlags.mainRunActive}");
  });

  it("chat 页：EventStream 的 isRunning 与 latch 初值都吃 task.runStatus", () => {
    const src = read("src/components/tasks/chat-view.tsx");
    expect(src).toContain("isRunning={effectiveRunActive(runActive, task.runStatus)}");
    expect(src).toContain('useState(() => task.runStatus === "running")');
  });
});
