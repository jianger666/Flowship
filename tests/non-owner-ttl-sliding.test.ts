/**
 * 非属主轮标记的 TTL 是「滑动」的（第 20 轮评审 N1，审查方探针收编 + 补充）。
 *
 * 漏洞链（修前）：固定 45 分钟 TTL，而白名单里的 `wait` 单次最长 30 分钟、且放行路径不刷新标记——
 * 同一轮里连调两次 wait（共 61 分钟）标记过期，之后 submit_work / ask_user / schedule（pi 上还有 shell / write）全放行。
 *
 * 现在：工具咽喉（`invokeFlowshipTool`，含放行的 wait；pi 的 execute 包装 / 只读工具守卫）命中标记就续期，
 * TTL 只兜「漏清后再没有任何工具调用」。`isNonOwnerTurnActive` 保持纯查询、不续期。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const guard = await import("@/lib/server/non-owner-turn-guard");

afterEach(() => {
  vi.useRealTimers();
  guard.__resetNonOwnerTurnGuardForTest();
});

const mkTool = (name: string) => {
  const handler = vi.fn(async () => ({
    content: [{ type: "text" as const, text: `HANDLED:${name}` }],
  }));
  return {
    tool: { name, label: name, description: "", parameters: {} as never, handler } as never,
    handler,
  };
};
const textOf = (r: { content: Array<{ text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");
const at = (hhmm: string) => vi.setSystemTime(new Date(`2026-11-04T${hhmm}:00Z`));
const call = (tool: never, args: Record<string, unknown>, taskId: string) =>
  invokeFlowshipTool(tool, args, "tok", { taskId } as never);

describe("非属主轮标记：仍在调工具就不过期", () => {
  it("正控：10 分钟内 submit_work 被拒", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    at("10:10");
    const sw = mkTool("submit_work");
    const r = await call(sw.tool, { task_id: "t1" }, "t1");
    expect(textOf(r)).toContain("[DENIED]");
    expect(sw.handler).not.toHaveBeenCalled();
  });

  it("同一轮里连调两次 wait（共 61 分钟）后 submit_work 仍被拒（N1 本体）", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    const wait = mkTool("wait");
    const sw = mkTool("submit_work");
    at("10:30");
    await call(wait.tool, { seconds: 1800 }, "t1");
    at("11:01");
    await call(wait.tool, { seconds: 1800 }, "t1");
    // wait 是白名单放行的：handler 照常被调用（续期不能把 wait 也拒了）
    expect(wait.handler).toHaveBeenCalledTimes(2);
    const r = await call(sw.tool, { task_id: "t1" }, "t1");
    expect(textOf(r)).toContain("[DENIED]");
    expect(sw.handler).not.toHaveBeenCalled();
  });

  it("被拒的调用本身也续期（模型反复试探也不会把标记熬过期）", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    const sched = mkTool("schedule");
    // 每 30 分钟试探一次，共跨 90 分钟：每次都在 45 分钟窗内被拒
    for (const hhmm of ["10:30", "11:00", "11:30"]) {
      at(hhmm);
      expect(textOf(await call(sched.tool, {}, "t1"))).toContain("[DENIED]");
    }
    expect(sched.handler).not.toHaveBeenCalled();
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
  });

  it("真漏清（之后再没有任何工具调用）：超过 TTL 视为不在非属主轮（兜底语义保留）", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    at("10:46");
    expect(guard.isNonOwnerTurnActive("t1")).toBe(false);
  });

  it("漏清 + 最后一次工具调用后又过了 TTL：属主的 submit_work 恢复放行（不会永久误拒）", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    const wait = mkTool("wait");
    at("10:40");
    await call(wait.tool, {}, "t1"); // 续期到 10:40
    at("11:26"); // 距上次续期 46 分钟
    const sw = mkTool("submit_work");
    const r = await call(sw.tool, { task_id: "t1" }, "t1");
    expect(textOf(r)).toBe("HANDLED:submit_work");
  });
});

describe("touchNonOwnerTurn / isNonOwnerTurnActive 语义", () => {
  it("isNonOwnerTurnActive 是纯查询：不续期（查了也照样按原起点过期）", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    at("10:40");
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
    at("10:50"); // 距起点 50 分钟：若上一次查询续了期，这里还会是 true
    expect(guard.isNonOwnerTurnActive("t1")).toBe(false);
  });

  it("touchNonOwnerTurn：命中续期并返回 true；过期 / 无标记 / 无 taskId 返回 false 且不新建标记", () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("t1");
    at("10:40");
    expect(guard.touchNonOwnerTurn("t1")).toBe(true);
    at("11:20"); // 距续期点 40 分钟，仍在
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
    at("12:10"); // 距续期点 90 分钟：过期
    expect(guard.touchNonOwnerTurn("t1")).toBe(false);
    expect(guard.isNonOwnerTurnActive("t1")).toBe(false);
    expect(guard.touchNonOwnerTurn("nope")).toBe(false);
    expect(guard.touchNonOwnerTurn(undefined)).toBe(false);
    expect(guard.isNonOwnerTurnActive("nope")).toBe(false);
  });

  it("续期不换 token：后继轮的 token 判定（endNonOwnerTurn 按 token 收口）不受影响", () => {
    vi.useFakeTimers();
    at("10:00");
    const tokenA = guard.beginNonOwnerTurn("t1");
    at("10:10");
    guard.touchNonOwnerTurn("t1");
    // 旧 token 收口：标记在，被清
    guard.endNonOwnerTurn("t1", tokenA);
    expect(guard.isNonOwnerTurnActive("t1")).toBe(false);
    // 后继轮覆盖后，旧 token 收口是 no-op
    const tokenB = guard.beginNonOwnerTurn("t1");
    guard.touchNonOwnerTurn("t1");
    guard.endNonOwnerTurn("t1", tokenA);
    expect(guard.isNonOwnerTurnActive("t1")).toBe(true);
    guard.endNonOwnerTurn("t1", tokenB);
    expect(guard.isNonOwnerTurnActive("t1")).toBe(false);
  });

  it("模型自己填的 args.task_id 只用来拒、不用来续命别的任务的标记", async () => {
    vi.useFakeTimers();
    at("10:00");
    guard.beginNonOwnerTurn("victim");
    // 另一个任务（ctx.taskId=other，没有标记）里的模型，反复拿 wait 把 victim 的 id 填进 args 想续命
    const wait = mkTool("wait");
    at("10:40");
    await call(wait.tool, { task_id: "victim" }, "other");
    at("10:50"); // 距 victim 的起点 50 分钟：若被 args 续了期这里还在
    expect(guard.isNonOwnerTurnActive("victim")).toBe(false);
  });

  it("args.task_id 命中仍然会拒（不留「靠填别的 id 绕闸」的口子，行为没变）", async () => {
    guard.beginNonOwnerTurn("victim");
    const sw = mkTool("submit_work");
    const r = await call(sw.tool, { task_id: "victim" }, "other");
    expect(textOf(r)).toContain("[DENIED]");
    expect(sw.handler).not.toHaveBeenCalled();
  });
});
