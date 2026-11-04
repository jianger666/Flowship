/**
 * 第 20 轮评审探针（建议收进 tests/）：非属主轮标记在场时，**每一个** Flowship 系统工具（除 wait）都被硬拒，
 * 且只靠 ctx.taskId 命中（args 里不带 task_id——schedule 等工具本来就没有这个入参）。
 * 现有测试没钉「ctx.taskId 这一路」：把 invokeFlowshipTool 里 `isNonOwnerTurnActive(ctx?.taskId)` 改成 false，
 * 41 条相关用例全绿（突变 M1b 存活），但 schedule 之类没有 task_id 入参的工具会因此被放行。
 */
import { afterEach, describe, expect, it } from "vitest";

const { flowShipTools, invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const guard = await import("@/lib/server/non-owner-turn-guard");

afterEach(() => guard.__resetNonOwnerTurnGuardForTest());

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("非属主轮：全部系统工具硬拒（只给 ctx.taskId）", () => {
  it("枚举真实的 flowShipTools：除 wait 外全部 [DENIED] 且 handler 没被调用", async () => {
    guard.beginNonOwnerTurn("tX");
    const leaked: string[] = [];
    for (const t of flowShipTools) {
      if (t.name === "wait") continue;
      let called = false;
      const spy = { ...t, handler: async (...a: Parameters<typeof t.handler>) => { called = true; return t.handler(...a); } };
      const r = await invokeFlowshipTool(spy as never, {}, "tok", { taskId: "tX" } as never);
      if (!textOf(r).includes("[DENIED]") || called) leaked.push(t.name);
    }
    expect(leaked).toEqual([]);
  });
  it("正控：标记没有时 handler 会被调用（拒的是标记，不是别的）", async () => {
    let called = false;
    const probe = { name: "schedule", handler: async () => { called = true; return { content: [{ type: "text", text: "ok" }] }; } };
    await invokeFlowshipTool(probe as never, {}, "tok", { taskId: "tY" } as never);
    expect(called).toBe(true);
  });
});
