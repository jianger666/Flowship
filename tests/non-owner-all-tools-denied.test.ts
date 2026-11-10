/**
 * 第 20 轮评审探针（建议收进 tests/）：非属主轮标记在场时，**每一个** Flowship 系统工具（除 wait）都被硬拒，
 * 且只靠 ctx.taskId 命中（args 里不带 task_id——schedule 等工具本来就没有这个入参）。
 * 现有测试没钉「ctx.taskId 这一路」：把 invokeFlowshipTool 里 `isNonOwnerTurnActive(ctx?.taskId)` 改成 false，
 * 41 条相关用例全绿（突变 M1b 存活），但 schedule 之类没有 task_id 入参的工具会因此被放行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBrowserSettingsForTest } from "@/lib/server/browser/settings";
import { BROWSER_TOOL_NAMES, getBrowserTools } from "@/lib/server/browser/tools";

import { installFakeBrowser } from "./helpers/browser-bridge-fake";

// R2-15：下面「真实注册点」的遍历会真的调 execute；闸一旦失效，真 handler 会被调到——数据目录指向临时目录，副作用只落在这里
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-non-owner-all-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

const { buildSdkCustomTools, flowShipTools, invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { __buildCustomToolsForTest, NON_OWNER_TURN_PI_TOOL_NAMES } = await import("@/lib/server/custom-agent-backend");
const guard = await import("@/lib/server/non-owner-turn-guard");

afterEach(() => {
  guard.__resetNonOwnerTurnGuardForTest();
  __resetBrowserSettingsForTest();
});

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

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
  it("R1-33：枚举真实的 getBrowserTools（flowShipTools 常量里没有它们，按会话追加）：每个浏览器工具（含 evaluate）在非属主轮都 [DENIED] 且 handler / 主进程都没被碰", async () => {
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    const fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }) });
    try {
      const browserTools = getBrowserTools({ taskId: "tX", readOnly: false });
      // 守住枚举本身：25 个常驻 + evaluate；少了说明这里的前提（bridge 可用、evaluate 开）失效，测试会空转
      // E2 起增强包会追加自己的 browser_* 工具（storage / permissions / network_rules / clipboard …）：R1 的 26 个必须都在，多出来的也必须是 browser_*，
      // 且下面的遍历把它们一并纳入「非属主轮全 [DENIED]」——枚举范围只会更大，不会漏
      const browserNames = browserTools.map((t) => t.name);
      expect(browserNames).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]));
      expect(browserNames.every((n) => n.startsWith("browser_"))).toBe(true);
      expect(browserTools.length).toBeGreaterThanOrEqual(26);

      guard.beginNonOwnerTurn("tX");
      const leaked: string[] = [];
      for (const t of browserTools) {
        let called = false;
        const spy = { ...t, handler: async (...a: Parameters<typeof t.handler>) => { called = true; return t.handler(...a); } };
        const r = await invokeFlowshipTool(spy as never, {}, "tok", { taskId: "tX" } as never);
        if (!textOf(r).includes("[DENIED]") || called) leaked.push(t.name);
      }
      expect(leaked).toEqual([]);
      expect(fake.calls).toEqual([]); // 一条 req 都没发到主进程
    } finally {
      fake.cleanup();
    }
  });
  it("R1-33 正控：非属主标记没有时，浏览器工具的 handler 会被调用（拒的是标记，不是 bridge / 参数）", async () => {
    __resetBrowserSettingsForTest();
    const fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }) });
    try {
      const nav = getBrowserTools({ taskId: "tZ", readOnly: false }).find((t) => t.name === "browser_snapshot")!;
      let called = false;
      const spy = { ...nav, handler: async (...a: Parameters<typeof nav.handler>) => { called = true; return nav.handler(...a); } };
      const r = await invokeFlowshipTool(spy as never, {}, "tok", { taskId: "tZ" } as never);
      expect(called).toBe(true);
      expect(textOf(r)).not.toContain("[DENIED]");
      expect(fake.calls.map((c) => c.op)).toContain("snapshot");
    } finally {
      fake.cleanup();
    }
  });
  it("正控：标记没有时 handler 会被调用（拒的是标记，不是别的）", async () => {
    let called = false;
    const probe = { name: "schedule", handler: async () => { called = true; return { content: [{ type: "text", text: "ok" }] }; } };
    await invokeFlowshipTool(probe as never, {}, "tok", { taskId: "tY" } as never);
    expect(called).toBe(true);
  });
});

/**
 * R2-15 ①：上面两条「枚举」用的是 spy 包装后的 def 直接走 invokeFlowshipTool，枚举与 BROWSER_TOOL_NAMES 同源，
 * 只能证明「咽喉函数」会拒，**没有穿过两条后端真正的注册点**。这里遍历注册点的真实产物：
 *  · Cursor：`buildSdkCustomTools(...)` 返回的每个 customTool 的 execute；
 *  · pi：`buildCustomTools(...)`（`__buildCustomToolsForTest`）返回的每个 ToolDefinition 的 execute——含 `withNonOwnerTurnDeny` 包装、编码工具。
 * 并且断言「真实产物里确实有全部 26 个 browser_* 与全部 flowShipTools」，防工具被漏注册 / 前提失效造成空转。
 */
describe("R2-15 ①：非属主轮——遍历两条后端的真实注册产物", () => {
  const BROWSER_26 = [...BROWSER_TOOL_NAMES].sort();
  // 拒绝时 invokeFlowshipTool 会 console.warn、bridge 就绪会 console.info：逐个工具刷屏，静音（断言看返回值，不看日志）
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const setup = () => {
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    return installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }) });
  };
  type Exec = (...a: unknown[]) => Promise<unknown>;
  /** 把任意 execute 的返回值（Cursor：{content,isError?}；pi：{content,details}）压成文本，抛错也算「没拒」要暴露出来 */
  const runText = async (execute: Exec, ...a: unknown[]): Promise<string> => {
    try {
      const r = (await execute(...a)) as { content?: Array<{ type: string; text?: string }> };
      return (r.content ?? []).map((c) => c.text ?? "").join("");
    } catch (e) {
      return `[THREW] ${(e as Error).message}`;
    }
  };

  it("前提：BROWSER_TOOL_NAMES 恰好 26 个（25 常驻 + evaluate）；pi 的非属主白名单里没有浏览器工具、没有 wait 之外的 Flowship 系统工具、没有会写 / 跑命令的编码工具", () => {
    expect(BROWSER_TOOL_NAMES.length).toBe(26);
    const mustNotBeAllowed = [
      ...BROWSER_TOOL_NAMES,
      ...flowShipTools.map((t) => t.name).filter((n) => n !== "wait"),
      "shell", "delete", "task", "write", "edit", "merge_test_mr",
    ];
    for (const n of mustNotBeAllowed) expect(NON_OWNER_TURN_PI_TOOL_NAMES, n).not.toContain(n);
  });

  it("Cursor：buildSdkCustomTools 里有全部 26 个浏览器工具 + 全部 flowShipTools；非属主轮除 wait 外每个 execute 都 [DENIED]，主进程一条请求都没收到", async () => {
    const fake = setup();
    try {
      const tools = buildSdkCustomTools("tok", { taskId: "tX" });
      const names = Object.keys(tools);
      // R1 的 26 个必须都在；E2 增强包追加的 browser_* 工具也在遍历范围内（见上方 R1-33 的说明）
      expect(names.filter((n) => n.startsWith("browser_"))).toEqual(expect.arrayContaining(BROWSER_26));
      for (const t of flowShipTools) expect(names, t.name).toContain(t.name);

      guard.beginNonOwnerTurn("tX");
      const leaked: string[] = [];
      for (const [name, tool] of Object.entries(tools)) {
        if (name === "wait") continue;
        const txt = await runText(tool.execute as unknown as Exec, {}, undefined);
        if (!txt.includes("[DENIED]")) leaked.push(`${name} → ${txt.slice(0, 80)}`);
      }
      expect(leaked).toEqual([]);
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  it("Cursor 正控：没有非属主标记时，同一份注册产物里的 browser_snapshot 会真的到主进程（上面的拒绝来自标记，不是 bridge / 参数）", async () => {
    const fake = setup();
    try {
      const tools = buildSdkCustomTools("tok", { taskId: "tZ" });
      const txt = await runText(tools.browser_snapshot!.execute as unknown as Exec, {}, undefined);
      expect(txt).not.toContain("[DENIED]");
      expect(fake.calls.map((c) => c.op)).toContain("snapshot");
    } finally {
      fake.cleanup();
    }
  });

  it("pi：buildCustomTools 里有全部 26 个浏览器工具 + 全部 flowShipTools + 编码工具；非属主轮不在白名单的每个 execute 都 [DENIED]，主进程一条请求都没收到", async () => {
    const fake = setup();
    try {
      const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tX") as unknown as Array<{
        name: string;
        execute: Exec;
      }>;
      const names = defs.map((d) => d.name);
      expect(names.filter((n) => n.startsWith("browser_"))).toEqual(expect.arrayContaining(BROWSER_26));
      for (const t of flowShipTools) expect(names, t.name).toContain(t.name);
      // 守住「编码工具」也在遍历范围内：withNonOwnerTurnDeny 是给它们（shell / 写文件 / 删文件 / 子代理）设的，不是只为 Flowship 工具
      for (const n of ["shell", "delete"]) expect(names, n).toContain(n);

      guard.beginNonOwnerTurn("tX");
      const leaked: string[] = [];
      let denied = 0;
      for (const d of defs) {
        if (NON_OWNER_TURN_PI_TOOL_NAMES.includes(d.name)) continue; // 白名单（wait / 只读工具）本来就放行，另有守卫
        const txt = await runText(d.execute, "call-x", {}, undefined);
        if (txt.includes("[DENIED]")) denied += 1;
        else leaked.push(`${d.name} → ${txt.slice(0, 80)}`);
      }
      expect(leaked).toEqual([]);
      // 至少覆盖了 26 + 全部 Flowship 工具（除 wait）+ 若干编码工具：防「白名单误含一切 → 一个都没遍历」的空转
      expect(denied).toBeGreaterThanOrEqual(26 + flowShipTools.length - 1 + 2);
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  it("pi 正控：没有非属主标记时，浏览器工具 execute 会真的到主进程；编码工具不再被 [DENIED]（拒的是标记）", async () => {
    const fake = setup();
    try {
      const defs = __buildCustomToolsForTest("tok", TMP_ROOT, { input: {} } as never, [], "tZ") as unknown as Array<{
        name: string;
        execute: Exec;
      }>;
      const snap = defs.find((d) => d.name === "browser_snapshot")!;
      expect(await runText(snap.execute, "c1", {}, undefined)).not.toContain("[DENIED]");
      expect(fake.calls.map((c) => c.op)).toContain("snapshot");
      // shell 不带命令：没有标记时会因参数不合法失败，但不会是 [DENIED]
      const shell = defs.find((d) => d.name === "shell")!;
      expect(await runText(shell.execute, "c2", {}, undefined)).not.toContain("[DENIED]");
    } finally {
      fake.cleanup();
    }
  });
});
