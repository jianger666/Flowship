/**
 * desktop_* 工具在两条后端「真实注册点」上的挂载与非属主轮硬拒：
 *  · Cursor：`buildSdkCustomTools(...)` 返回的每个 customTool 的 execute；
 *  · pi：`buildCustomTools(...)`（`__buildCustomToolsForTest`）返回的每个 ToolDefinition 的 execute（含 withNonOwnerTurnDeny 包装）。
 * 与 tests/non-owner-all-tools-denied.test.ts 同一套路：枚举真实产物，守住「群里的陌生人不能让 AI 动属主的电脑 / 解锁」。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NON_OWNER_TURN_ALLOWED_TOOLS } from "@/lib/group-non-owner-prompt";
import { __resetBrowserSettingsForTest } from "@/lib/server/browser/settings";
import { DESKTOP_TOOL_NAMES } from "@/lib/server/desktop/tools";

import { OpError, installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

// 闸一旦失效，下面的遍历会真的调 execute：数据目录指向临时目录，副作用只落在这里
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-desktop-mount-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

const { buildSdkCustomTools, invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { __buildCustomToolsForTest, NON_OWNER_TURN_PI_TOOL_NAMES } = await import("@/lib/server/custom-agent-backend");
const guard = await import("@/lib/server/non-owner-turn-guard");
const { bindSessionToken, releaseSessionToken } = await import("./helpers/session-token");

const DESKTOP_NAMES = [...DESKTOP_TOOL_NAMES].sort();
const DESKTOP_CAPS = ["browser.v1", "desktop.v1"];

type Exec = (...a: unknown[]) => Promise<unknown>;
const runText = async (execute: Exec, ...a: unknown[]): Promise<string> => {
  try {
    const r = (await execute(...a)) as { content?: Array<{ type: string; text?: string }> };
    return (r.content ?? []).map((c) => c.text ?? "").join("");
  } catch (e) {
    return `[THREW] ${(e as Error).message}`;
  }
};

let fake: FakeBrowser | null = null;
const install = (caps: string[] = DESKTOP_CAPS) => {
  __resetBrowserSettingsForTest({ desktopEnabled: true, desktopLockedAccess: true });
  fake = installFakeBrowser(
    {
      desktop_status: () => ({ ok: true, enabled: true, platform: "darwin", driverReady: true, session: { active: false } }),
      desktop_end_session: () => ({ ok: true, ended: true, unlockedByUs: true, relocked: true }),
      status: () => ({ exists: true, pendingCount: 0 }),
    },
    { capabilities: caps },
  );
  return fake;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  for (const t of ["tX", "tZ", "tOther"]) releaseSessionToken(t);
  guard.__resetNonOwnerTurnGuardForTest();
  __resetBrowserSettingsForTest();
  vi.restoreAllMocks();
});

describe("挂载：两条后端的真实注册产物里有 / 没有 desktop_*", () => {
  it("Cursor：主进程声明了 desktop.v1 → buildSdkCustomTools 里有全部 desktop_* 工具", () => {
    install();
    const names = Object.keys(buildSdkCustomTools("tok", { taskId: "tX" })).filter((n) => n.startsWith("desktop_"));
    expect(names.sort()).toEqual(DESKTOP_NAMES);
  });

  it("pi：主进程声明了 desktop.v1 → buildCustomTools 里有全部 desktop_* 工具", () => {
    install();
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{ name: string }>;
    expect(defs.map((d) => d.name).filter((n) => n.startsWith("desktop_")).sort()).toEqual(DESKTOP_NAMES);
  });

  it("没声明 desktop.v1（Linux / 网页版 / 旧版桌面端）→ 两条后端都不挂（模型看不到、也就不会幻觉调用）", () => {
    install(["browser.v1"]);
    expect(Object.keys(buildSdkCustomTools("tok", { taskId: "tX" })).filter((n) => n.startsWith("desktop_"))).toEqual([]);
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{ name: string }>;
    expect(defs.filter((d) => d.name.startsWith("desktop_"))).toEqual([]);
  });

  it("没有 taskId 的一次性调用（标题生成等）→ 不挂", () => {
    install();
    expect(Object.keys(buildSdkCustomTools("tok", {})).filter((n) => n.startsWith("desktop_"))).toEqual([]);
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], undefined) as unknown as Array<{ name: string }>;
    expect(defs.filter((d) => d.name.startsWith("desktop_"))).toEqual([]);
  });

  it("没有 callerToken（受限答疑等）→ pi 不挂", () => {
    install();
    const defs = __buildCustomToolsForTest(undefined, TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{ name: string }>;
    expect(defs.filter((d) => d.name.startsWith("desktop_"))).toEqual([]);
  });

  it("desktop_* 不在任何非属主放行白名单里", () => {
    for (const n of DESKTOP_TOOL_NAMES) {
      expect(NON_OWNER_TURN_ALLOWED_TOOLS, n).not.toContain(n);
      expect(NON_OWNER_TURN_PI_TOOL_NAMES, n).not.toContain(n);
    }
  });
});

describe("正控：没有非属主标记时，工具真的会到主进程", () => {
  // 过期会话闸（第十八轮）：desktop_* 要求调用方 token 是任务当前会话的——这里的 "tok" 就是 tZ 的当前会话
  beforeEach(() => bindSessionToken("tZ"));

  it("Cursor：desktop_status 的 execute 发出 op desktop_status", async () => {
    const f = install();
    const tools = buildSdkCustomTools("tok", { taskId: "tZ" });
    const txt = await runText(tools.desktop_status!.execute as unknown as Exec, {}, undefined);
    expect(txt).not.toContain("[DENIED]");
    expect(txt).toContain("电脑操作状态");
    expect(f.calls.map((c) => c.op)).toEqual(["desktop_status"]);
    expect(f.calls[0]!.taskId).toBe("tZ");
  });

  it("pi：desktop_status 的 execute 发出 op desktop_status", async () => {
    const f = install();
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tZ") as unknown as Array<{ name: string; execute: Exec }>;
    const d = defs.find((x) => x.name === "desktop_status")!;
    const txt = await runText(d.execute, "call-1", {}, undefined);
    expect(txt).toContain("电脑操作状态");
    expect(f.calls.map((c) => c.op)).toEqual(["desktop_status"]);
  });

  it("pi：失败（比如主进程回 ACCESS_DISABLED）以抛错形式交给 agent-loop，文案带「请用户去设置里打开」", async () => {
    const f = install();
    f.handlers.desktop_click = () => {
      throw new OpError("ACCESS_DISABLED", "电脑操作没开");
    };
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tZ") as unknown as Array<{ name: string; execute: Exec }>;
    const d = defs.find((x) => x.name === "desktop_click")!;
    const txt = await runText(d.execute, "call-2", { x: 1, y: 2 }, undefined);
    expect(txt).toContain("[THREW]");
    expect(txt).toContain("「设置 → 电脑操作」里打开开关");
    expect(f.calls.map((c) => c.op)).toEqual(["desktop_click"]);
  });
});

describe("非属主轮：每一个 desktop_* 工具都被硬拒，主进程一条请求都收不到（即使设置里开着「锁屏时也能用」）", () => {
  it("Cursor：遍历 buildSdkCustomTools 里的每个 desktop_*", async () => {
    const f = install();
    const tools = buildSdkCustomTools("tok", { taskId: "tX" });
    guard.beginNonOwnerTurn("tX");
    const leaked: string[] = [];
    let denied = 0;
    for (const [name, tool] of Object.entries(tools)) {
      if (!name.startsWith("desktop_")) continue;
      const txt = await runText(tool.execute as unknown as Exec, { x: 1, y: 2, text: "t", keys: "enter", name: "微信", from_x: 1, from_y: 1, to_x: 2, to_y: 2, dy: 1 }, undefined);
      if (txt.includes("[DENIED]")) denied += 1;
      else leaked.push(`${name} → ${txt.slice(0, 80)}`);
    }
    expect(leaked).toEqual([]);
    expect(denied).toBe(DESKTOP_NAMES.length);
    expect(f.calls).toEqual([]);
  });

  it("pi：遍历 buildCustomTools 里的每个 desktop_*（含 withNonOwnerTurnDeny 包装）", async () => {
    const f = install();
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{ name: string; execute: Exec }>;
    guard.beginNonOwnerTurn("tX");
    const leaked: string[] = [];
    let denied = 0;
    for (const d of defs) {
      if (!d.name.startsWith("desktop_")) continue;
      const txt = await runText(d.execute, "call-x", { x: 1, y: 2, text: "t", keys: "enter", name: "微信" }, undefined);
      if (txt.includes("[DENIED]")) denied += 1;
      else leaked.push(`${d.name} → ${txt.slice(0, 80)}`);
    }
    expect(leaked).toEqual([]);
    expect(denied).toBe(DESKTOP_NAMES.length);
    expect(f.calls).toEqual([]);
  });

  it("invokeFlowshipTool 咽喉：只靠 ctx.taskId 命中（入参里不带任何 id），handler 本身没被调用", async () => {
    const f = install();
    const tools = buildSdkCustomTools("tok", { taskId: "tX" });
    expect(Object.keys(tools)).toContain("desktop_click");
    // 直接拿真实 def 走咽喉：用 spy 包一层 handler，确认被拒时它根本没执行
    const { getDesktopTools } = await import("@/lib/server/desktop/tools");
    guard.beginNonOwnerTurn("tX");
    for (const t of getDesktopTools({ taskId: "tX", readOnly: false })) {
      let called = false;
      const spy = { ...t, handler: async (...a: Parameters<typeof t.handler>) => { called = true; return t.handler(...a); } };
      const r = await invokeFlowshipTool(spy as never, {}, "tok", { taskId: "tX" } as never);
      const txt = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      expect(txt, t.name).toContain("[DENIED]");
      expect(called, t.name).toBe(false);
    }
    expect(f.calls).toEqual([]);
  });

  it("标记只针对那个任务：另一个任务（属主轮）不受影响", async () => {
    const f = install();
    bindSessionToken("tOther");
    const tools = buildSdkCustomTools("tok", { taskId: "tOther" });
    guard.beginNonOwnerTurn("tX");
    const txt = await runText(tools.desktop_status!.execute as unknown as Exec, {}, undefined);
    expect(txt).not.toContain("[DENIED]");
    expect(f.calls.map((c) => c.op)).toEqual(["desktop_status"]);
  });
});

// 「只答疑」提示词开关关着（群成员与属主同权）的那一轮：标记 scope=desktop。
// 同权只放开任务 / 代码类权限，**不放开属主的电脑**：desktop_* 照样全拒（唯一的例外是收尾 desktop_end_session——
// 它只会把电脑锁回去；恒拒的话「属主的一轮中途读到群里别人的话」之后 AI 想锁也锁不了），其它系统工具 / 浏览器工具照常放行。
describe("同权的群非属主轮（提示词开关关、scope=desktop）：电脑操作仍然全拒（除收尾），其它工具不受影响", () => {
  const beginOpenTurn = (taskId: string) => guard.beginNonOwnerTurn(taskId, Date.now(), "desktop");
  /** 同权轮里放行的那一个（收尾）；其余 desktop_* 的数量 */
  const END = "desktop_end_session";
  const DENIED_COUNT = DESKTOP_NAMES.length - 1;

  it("Cursor：遍历 buildSdkCustomTools 里的每个 desktop_*（收尾除外），全部 [DENIED]，主进程一条请求都收不到", async () => {
    const f = install();
    const tools = buildSdkCustomTools("tok", { taskId: "tX" });
    beginOpenTurn("tX");
    const leaked: string[] = [];
    let denied = 0;
    for (const [name, tool] of Object.entries(tools)) {
      if (!name.startsWith("desktop_") || name === END) continue;
      const txt = await runText(tool.execute as unknown as Exec, { x: 1, y: 2, text: "t", keys: "enter", name: "微信", from_x: 1, from_y: 1, to_x: 2, to_y: 2, dy: 1 }, undefined);
      if (txt.includes("[DENIED]") && txt.includes("电脑操作")) denied += 1;
      else leaked.push(`${name} → ${txt.slice(0, 80)}`);
    }
    expect(leaked).toEqual([]);
    expect(denied).toBe(DENIED_COUNT);
    expect(f.calls).toEqual([]);
  });

  it("pi：遍历 buildCustomTools 里的每个 desktop_*（含 withNonOwnerTurnDeny 包装；收尾除外），全部 [DENIED]", async () => {
    const f = install();
    const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{ name: string; execute: Exec }>;
    beginOpenTurn("tX");
    const leaked: string[] = [];
    let denied = 0;
    for (const d of defs) {
      if (!d.name.startsWith("desktop_") || d.name === END) continue;
      const txt = await runText(d.execute, "call-x", { x: 1, y: 2, text: "t", keys: "enter", name: "微信" }, undefined);
      if (txt.includes("[DENIED]") && txt.includes("电脑操作")) denied += 1;
      else leaked.push(`${d.name} → ${txt.slice(0, 80)}`);
    }
    expect(leaked).toEqual([]);
    expect(denied).toBe(DENIED_COUNT);
    expect(f.calls).toEqual([]);
  });

  it("收尾 desktop_end_session：同权轮里三个入口（Cursor / pi / 咽喉）都放行并真的到主进程；「只答疑」轮（scope=all）仍然拒", async () => {
    const f = install();
    const cursor = buildSdkCustomTools("tok", { taskId: "tX" });
    const pi = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{ name: string; execute: Exec }>;
    beginOpenTurn("tX");
    expect(await runText(cursor[END]!.execute as unknown as Exec, {}, undefined)).toContain("电脑已经锁回去了");
    expect(await runText(pi.find((d) => d.name === END)!.execute, "call-end", {}, undefined)).toContain("电脑已经锁回去了");
    const { getDesktopTools } = await import("@/lib/server/desktop/tools");
    const endDef = getDesktopTools({ taskId: "tX", readOnly: false }).find((t) => t.name === END)!;
    const viaThroat = await invokeFlowshipTool(endDef, {}, "tok", { taskId: "tX" } as never);
    expect(viaThroat.isError).not.toBe(true);
    expect(f.calls.map((c) => c.op)).toEqual([END, END, END]);

    // 「只答疑」轮：整个系统工具集走白名单，收尾也不例外
    guard.beginNonOwnerTurn("tX");
    const before = f.calls.length;
    expect(await runText(cursor[END]!.execute as unknown as Exec, {}, undefined)).toContain("[DENIED]");
    expect(await runText(pi.find((d) => d.name === END)!.execute, "call-end2", {}, undefined)).toContain("[DENIED]");
    expect(f.calls).toHaveLength(before);
  });

  it("invokeFlowshipTool 咽喉：handler 没被调用（收尾除外）；只认 ctx.taskId（入参里的 task_id 不算）", async () => {
    const f = install();
    const { getDesktopTools } = await import("@/lib/server/desktop/tools");
    beginOpenTurn("tX");
    for (const t of getDesktopTools({ taskId: "tX", readOnly: false })) {
      if (t.name === END) continue;
      let called = false;
      const spy = { ...t, handler: async (...a: Parameters<typeof t.handler>) => { called = true; return t.handler(...a); } };
      const r = await invokeFlowshipTool(spy as never, {}, "tok", { taskId: "tX" } as never);
      expect(r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), t.name).toContain("[DENIED]");
      expect(called, t.name).toBe(false);
      // 模型自己在入参里填别的 task_id 绕不过：ctx.taskId 才是真任务
      const r2 = await invokeFlowshipTool(spy as never, { task_id: "tOther" }, "tok", { taskId: "tX" } as never);
      expect(r2.content.map((c) => (c.type === "text" ? c.text : "")).join(""), t.name).toContain("[DENIED]");
      expect(called, t.name).toBe(false);
    }
    expect(f.calls).toEqual([]);
  });

  it("其它系统工具不受影响（同权）：scope=desktop 时非 desktop 工具照常进 handler；scope=all 时才被白名单拒", async () => {
    install();
    const fakeTool = (name: string) => ({
      name,
      label: name,
      description: "x",
      parameters: { type: "object", properties: {} },
      handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `handled:${name}` }] })),
    });
    const t = fakeTool("submit_work");

    beginOpenTurn("tX");
    const open = await invokeFlowshipTool(t as never, {}, "tok", { taskId: "tX" } as never);
    expect(open.content[0]).toEqual({ type: "text", text: "handled:submit_work" });
    expect(t.handler).toHaveBeenCalledTimes(1);

    guard.beginNonOwnerTurn("tX"); // 覆盖成 scope=all（提示词开关开）
    const closed = await invokeFlowshipTool(t as never, {}, "tok", { taskId: "tX" } as never);
    expect((closed.content[0] as { text: string }).text).toContain("[DENIED]");
    expect(t.handler).toHaveBeenCalledTimes(1);
  });

  it("同权轮里调浏览器 / 系统工具时，标记照样被续期（长轮次里电脑操作拦截不会被 45 分钟 TTL 熬过期）", async () => {
    install();
    const t0 = 1_000_000;
    guard.beginNonOwnerTurn("tX", t0, "desktop");
    const spy = { name: "wait", label: "wait", description: "x", parameters: { type: "object" }, handler: async () => ({ content: [] }) };
    // 40 分钟时调一次系统工具（续期）→ 再过 40 分钟（距起点 80 分钟，但距上次续期只有 40 分钟）仍在拦截范围内
    vi.spyOn(Date, "now").mockReturnValue(t0 + 40 * 60_000);
    await invokeFlowshipTool(spy as never, {}, "tok", { taskId: "tX" } as never);
    expect(guard.isGroupNonOwnerTurnActive("tX", t0 + 80 * 60_000)).toBe(true);
    // 对照：没有续期就会过期
    guard.beginNonOwnerTurn("tY", t0, "desktop");
    expect(guard.isGroupNonOwnerTurnActive("tY", t0 + 80 * 60_000)).toBe(false);
  });
});
