/**
 * 非属主轮标记的「范围（scope）」：群里非属主 ≠「只答疑」开关。
 *
 * 背景：电脑操作（desktop_*）会看属主的屏幕、动键鼠、锁屏时还会用属主的开机密码解锁。以前它的「非属主不放行」
 * 只靠「只答疑」提示词开关登记的标记——开关一关（群成员与属主同权），群里的任何人都能让 AI 动属主的电脑。
 * 现在开关关着的群非属主轮也登记一个 scope=desktop 的标记：它**只**拦电脑操作，其它系统工具照常放行（同权的本意）。
 *
 * 守住四件事：
 *  1. 两种范围的查询语义（isNonOwnerTurnActive 只认 all；isGroupNonOwnerTurnActive 两种都认），原有调用方语义不变；
 *  2. 两种范围共用同一套生命周期（token 收口 / 无条件清 / TTL / 滑动续期）；
 *  3. invokeFlowshipTool 咽喉：desktop_*（按前缀，失败即关闭）在任一范围都拒，非 desktop 工具只在 scope=all 被拒；
 *  4. 只认 ctx.taskId，模型自己填的 task_id 绕不过。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_NON_OWNER_ALLOWED_TOOLS,
  DESKTOP_TOOL_NAMES,
  desktopDeniedInNonOwnerTurn,
  isDesktopToolAllowedInNonOwnerTurn,
  isDesktopToolName,
} from "@/lib/server/desktop/tools";

const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const guard = await import("@/lib/server/non-owner-turn-guard");
const { bindSessionToken } = await import("./helpers/session-token");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  guard.__resetNonOwnerTurnGuardForTest();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);

const mkTool = (name: string) => {
  const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] }));
  return { tool: { name, label: name, description: "", parameters: {} as never, handler } as never, handler };
};
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const call = (tool: never, args: Record<string, unknown>, taskId: string | undefined) => {
  // 过期会话闸（第十八轮）：标记放行的 desktop_* 还要求调用方 token 是该任务当前会话的——这里每次调用前把 "tok" 登记成当前会话（模拟「本会话的 agent 在调」）
  if (taskId) bindSessionToken(taskId);
  return invokeFlowshipTool(tool, args, "tok", (taskId ? { taskId } : {}) as never);
};

describe("标记范围的查询语义", () => {
  it("缺省 scope=all：两个查询都为真（原有调用方语义不变）", () => {
    guard.beginNonOwnerTurn("t1", T0);
    expect(guard.isNonOwnerTurnActive("t1", T0)).toBe(true);
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(true);
  });

  it("scope=desktop：isNonOwnerTurnActive 为假（不触发系统工具整体硬拒 / pi 收窄工具集），isGroupNonOwnerTurnActive 为真", () => {
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    expect(guard.isNonOwnerTurnActive("t1", T0)).toBe(false);
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(true);
  });

  it("没标记 / 没 taskId / 别的任务：都为假", () => {
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    expect(guard.isGroupNonOwnerTurnActive("nope", T0)).toBe(false);
    expect(guard.isGroupNonOwnerTurnActive(undefined, T0)).toBe(false);
    expect(guard.isGroupNonOwnerTurnActive("", T0)).toBe(false);
    expect(guard.isNonOwnerTurnActive(undefined, T0)).toBe(false);
  });

  it("空字符串 taskId 永远不命中（「没有任务上下文」不能碰上一个登记在空 id 下的标记）", () => {
    guard.beginNonOwnerTurn("", T0, "desktop");
    guard.beginNonOwnerTurn("", T0);
    expect(guard.isGroupNonOwnerTurnActive("", T0)).toBe(false);
    expect(guard.isNonOwnerTurnActive("", T0)).toBe(false);
    expect(guard.touchNonOwnerTurn("", T0)).toBe(false);
  });

  it("后继轮覆盖：all → desktop（开关被关掉后的下一轮）与 desktop → all 都按最新一轮算", () => {
    guard.beginNonOwnerTurn("t1", T0);
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    expect(guard.isNonOwnerTurnActive("t1", T0)).toBe(false);
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(true);
    guard.beginNonOwnerTurn("t1", T0);
    expect(guard.isNonOwnerTurnActive("t1", T0)).toBe(true);
  });
});

describe("两种范围共用同一套生命周期", () => {
  it("TTL：scope=desktop 过期后 isGroupNonOwnerTurnActive 为假，并顺手清掉", () => {
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    expect(guard.isGroupNonOwnerTurnActive("t1", T0 + guard.NON_OWNER_TURN_TTL_MS)).toBe(true); // 恰好等于 TTL 还算在
    expect(guard.isGroupNonOwnerTurnActive("t1", T0 + guard.NON_OWNER_TURN_TTL_MS + 1)).toBe(false);
    // 已被清掉：之后即便查询时间回拨也不会复活
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(false);
  });

  it("滑动续期：touch 刷新 scope=desktop 的起点，但返回假（它不是系统工具硬拒轮）", () => {
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    expect(guard.touchNonOwnerTurn("t1", T0 + 40 * MIN)).toBe(false);
    // 距起点 80 分钟，距续期点 40 分钟：仍在
    expect(guard.isGroupNonOwnerTurnActive("t1", T0 + 80 * MIN)).toBe(true);
    // 距续期点 46 分钟：过期
    expect(guard.isGroupNonOwnerTurnActive("t1", T0 + 86 * MIN)).toBe(false);
  });

  it("touch：scope=all 仍返回真（原语义）；已过期 / 无标记返回假且不新建标记", () => {
    guard.beginNonOwnerTurn("t1", T0);
    expect(guard.touchNonOwnerTurn("t1", T0 + 10 * MIN)).toBe(true);
    expect(guard.touchNonOwnerTurn("t1", T0 + 10 * MIN + guard.NON_OWNER_TURN_TTL_MS + 1)).toBe(false);
    expect(guard.touchNonOwnerTurn("nope", T0)).toBe(false);
    expect(guard.isGroupNonOwnerTurnActive("nope", T0)).toBe(false);
  });

  it("按 token 收口：本轮 token 清得掉，被后继覆盖后的旧 token 是 no-op", () => {
    const a = guard.beginNonOwnerTurn("t1", T0, "desktop");
    const b = guard.beginNonOwnerTurn("t1", T0, "desktop");
    expect(a).not.toBe(b);
    guard.endNonOwnerTurn("t1", a);
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(true);
    guard.endNonOwnerTurn("t1", b);
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(false);
    guard.endNonOwnerTurn("t1", undefined); // 没 token 不炸
  });

  it("无条件清（属主自己的 send 起点 / 会话关闭）：scope=desktop 一并清掉", () => {
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    guard.clearNonOwnerTurn("t1");
    expect(guard.isGroupNonOwnerTurnActive("t1", T0)).toBe(false);
  });
});

describe("invokeFlowshipTool 咽喉：电脑操作与「只答疑」开关解耦", () => {
  it("isDesktopToolName：按前缀判（比 DESKTOP_TOOL_NAMES 宽，失败即关闭）；非 desktop 工具不误伤", () => {
    for (const n of DESKTOP_TOOL_NAMES) expect(isDesktopToolName(n), n).toBe(true);
    expect(isDesktopToolName("desktop_some_future_op")).toBe(true);
    for (const n of ["wait", "submit_work", "browser_click", "ask_user", "subagent", "desktop", "my_desktop_tool", ""]) {
      expect(isDesktopToolName(n), n).toBe(false);
    }
  });

  it("scope=desktop：每个 desktop_*（含名单之外的未来工具）都被拒，handler 一次都没执行——唯一的例外是收尾 desktop_end_session", async () => {
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    for (const name of [...DESKTOP_TOOL_NAMES, "desktop_some_future_op"]) {
      if (name === "desktop_end_session") continue; // 下一条专测
      const t = mkTool(name);
      const txt = textOf(await call(t.tool, {}, "t1"));
      expect(txt, name).toContain("[DENIED]");
      expect(txt, name).toContain("电脑操作");
      expect(t.handler, name).not.toHaveBeenCalled();
    }
  });

  it("scope=desktop：收尾 desktop_end_session 放行（只会把电脑锁回去）；名字稍有出入的 desktop_* 照拒（精确名字，不是前缀）", async () => {
    // 第三轮评审：恒拒它的话，属主的一轮中途读到群里别人的话（标记 scope=desktop）之后，AI 想把自动解锁的电脑锁回去也锁不了
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    const end = mkTool("desktop_end_session");
    expect(textOf(await call(end.tool, {}, "t1"))).toBe("HANDLED:desktop_end_session");
    expect(end.handler).toHaveBeenCalledTimes(1);
    for (const name of ["desktop_end_session_now", "desktop_end", "desktop_end_session2", "desktop_end_sessions", "desktop_end_session "]) {
      const t = mkTool(name);
      expect(textOf(await call(t.tool, {}, "t1")), name).toContain("[DENIED]");
      expect(t.handler, name).not.toHaveBeenCalled();
    }
  });

  it("放行名单与判定口径：名单恰好只有 desktop_end_session；scope=all 一律拒（收尾也不例外）；没有标记的轮不拒；别的任务的标记不影响", () => {
    expect([...DESKTOP_NON_OWNER_ALLOWED_TOOLS]).toEqual(["desktop_end_session"]);
    expect(isDesktopToolAllowedInNonOwnerTurn("desktop_end_session")).toBe(true);
    for (const n of ["desktop_status", "desktop_screenshot", "desktop_click", "desktop_end_session2", "end_session", "", "constructor", "toString"]) {
      expect(isDesktopToolAllowedInNonOwnerTurn(n), n).toBe(false);
    }
    // 没有标记
    expect(desktopDeniedInNonOwnerTurn("desktop_click", "t1")).toBe(false);
    expect(desktopDeniedInNonOwnerTurn("desktop_click", undefined)).toBe(false);
    // 同权轮
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    expect(desktopDeniedInNonOwnerTurn("desktop_click", "t1")).toBe(true);
    expect(desktopDeniedInNonOwnerTurn("desktop_end_session", "t1")).toBe(false);
    expect(desktopDeniedInNonOwnerTurn("desktop_click", "other")).toBe(false);
    guard.clearNonOwnerTurn("t1");
    // 「只答疑」轮（scope=all）：收尾也拒
    guard.beginNonOwnerTurn("t1");
    expect(desktopDeniedInNonOwnerTurn("desktop_end_session", "t1")).toBe(true);
    expect(desktopDeniedInNonOwnerTurn("desktop_click", "t1")).toBe(true);
  });

  it("scope=all：每个 desktop_* 也拒（走原有白名单硬拒 → 文案是通用那条）", async () => {
    guard.beginNonOwnerTurn("t1");
    for (const name of DESKTOP_TOOL_NAMES) {
      const t = mkTool(name);
      expect(textOf(await call(t.tool, {}, "t1")), name).toContain("[DENIED]");
      expect(t.handler, name).not.toHaveBeenCalled();
    }
  });

  it("scope=desktop：非 desktop 的系统工具照常放行（同权的本意——只是不放开属主的电脑）", async () => {
    guard.beginNonOwnerTurn("t1", Date.now(), "desktop");
    for (const name of ["submit_work", "ask_user", "schedule", "wait", "browser_click", "subagent"]) {
      const t = mkTool(name);
      expect(textOf(await call(t.tool, {}, "t1")), name).toBe(`HANDLED:${name}`);
      expect(t.handler, name).toHaveBeenCalledTimes(1);
    }
  });

  it("scope=all：非 desktop 工具除白名单（wait）外照旧被拒（原有行为没变）", async () => {
    guard.beginNonOwnerTurn("t1");
    const sw = mkTool("submit_work");
    expect(textOf(await call(sw.tool, {}, "t1"))).toContain("[DENIED]");
    expect(sw.handler).not.toHaveBeenCalled();
    const wait = mkTool("wait");
    expect(textOf(await call(wait.tool, {}, "t1"))).toBe("HANDLED:wait");
  });

  it("没有标记的属主轮：desktop_* 正常进 handler", async () => {
    const t = mkTool("desktop_click");
    expect(textOf(await call(t.tool, {}, "t1"))).toBe("HANDLED:desktop_click");
    expect(t.handler).toHaveBeenCalledTimes(1);
  });

  it("只认 ctx.taskId：模型把 task_id 填成别的任务绕不过；也不会去拒别的任务的属主轮", async () => {
    guard.beginNonOwnerTurn("victim", Date.now(), "desktop");
    // 受害任务自己的轮：入参里填别的 id 也一样被拒
    const a = mkTool("desktop_click");
    expect(textOf(await call(a.tool, { task_id: "other" }, "victim"))).toContain("[DENIED]");
    expect(a.handler).not.toHaveBeenCalled();
    // 别的任务（属主轮）里，哪怕入参填了 victim 的 id，也不被误拒
    const b = mkTool("desktop_click");
    expect(textOf(await call(b.tool, { task_id: "victim" }, "other"))).toBe("HANDLED:desktop_click");
    // 没有 ctx.taskId：不判（也就拒不了——桌面工具本身没 taskId 会在 run() 里报错）
    const c = mkTool("desktop_click");
    expect(textOf(await call(c.tool, { task_id: "victim" }, undefined))).toBe("HANDLED:desktop_click");
  });

  it("被拒的调用本身也续期（同权轮里模型反复试探电脑操作，标记不会被 TTL 熬过期）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    guard.beginNonOwnerTurn("t1", T0, "desktop");
    for (const mins of [30, 60, 90]) {
      vi.setSystemTime(T0 + mins * MIN);
      expect(textOf(await call(mkTool("desktop_click").tool, {}, "t1"))).toContain("[DENIED]");
    }
    expect(guard.isGroupNonOwnerTurnActive("t1", T0 + 100 * MIN)).toBe(true);
  });
});
