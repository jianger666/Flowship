/**
 * browser_* 工具接进两条后端（Cursor buildSdkCustomTools / pi buildCustomTools）与 invokeFlowshipTool 咽喉：
 * 注册条件、图片透传、失败呈现、非属主硬拒，以及 flowShipTools 常量保持不变。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-browser-wiring-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { buildSdkCustomTools, flowShipTools, invokeFlowshipTool, withFlowshipSdkCustomTools } = await import(
  "@/lib/server/flowship-tools"
);
const { __buildCustomToolsForTest } = await import("@/lib/server/custom-agent-backend");
const { NON_OWNER_TURN_ALLOWED_TOOLS } = await import("@/lib/group-non-owner-prompt");
const { __resetNonOwnerTurnGuardForTest, beginNonOwnerTurn } = await import("@/lib/server/non-owner-turn-guard");
const { __resetBrowserSettingsForTest } = await import("@/lib/server/browser/settings");
const { BROWSER_TOOL_NAMES, getBrowserTools } = await import("@/lib/server/browser/tools");
const { OpError, installFakeBrowser } = await import("./helpers/browser-bridge-fake");
type FakeBrowser = Awaited<ReturnType<typeof installFakeBrowser>>;

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

let fake: FakeBrowser | null = null;
beforeEach(() => {
  __resetBrowserSettingsForTest();
  __resetNonOwnerTurnGuardForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  vi.restoreAllMocks();
});

const b64 = Buffer.alloc(30_000, 7).toString("base64");
const install = () => {
  fake = installFakeBrowser({
    status: () => ({ exists: true, pendingCount: 0 }),
    screenshot: () => ({ tabId: "t1", mimeType: "image/jpeg", dataBase64: b64, width: 1280, height: 800 }),
    click: () => {
      throw new OpError("REF_STALE");
    },
    snapshot: () => ({ tabId: "t1", url: "https://a.test/", title: "t", text: "- link [e1]", refCount: 1 }),
  });
  return fake;
};

/** SDK customTool 的 execute 返回值被宽泛地标成 SDKJsonValue | null；这里按真实回包形状收窄，测试里读 content / isError 才有类型 */
interface SdkToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}
const runSdkTool = async (
  tools: ReturnType<typeof buildSdkCustomTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<SdkToolResult> =>
  // args 在测试里是随手写的普通对象；SDK 的签名要求 Record<string, SDKJsonValue>，在边界断言一次
  (await tools[name]!.execute(args as never, undefined as never)) as unknown as SdkToolResult;

describe("flowShipTools 常量不受影响", () => {
  it("不含 browser_*（browser 工具按会话动态追加；不少测试按这个常量的长度 / 名字断言）", () => {
    expect(flowShipTools.some((t) => t.name.startsWith("browser_"))).toBe(false);
  });
});

describe("Cursor：buildSdkCustomTools", () => {
  it("bridge 不可用 / 没有 taskId → 只有原有工具", () => {
    const base = Object.keys(buildSdkCustomTools("tok", { taskId: "t1" }));
    expect(base.some((n) => n.startsWith("browser_"))).toBe(false);
    install();
    const noTask = Object.keys(buildSdkCustomTools("tok"));
    expect(noTask.some((n) => n.startsWith("browser_"))).toBe(false);
    expect(noTask.sort()).toEqual(base.sort());
  });

  it("bridge 可用 + taskId：注册浏览器工具（E2·A7：evaluate 常驻，总闸开 / 关都在）", () => {
    install();
    const names = Object.keys(buildSdkCustomTools("tok", { taskId: "t1" }));
    for (const t of flowShipTools) expect(names).toContain(t.name);
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_evaluate");
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    expect(Object.keys(buildSdkCustomTools("tok", { taskId: "t1" }))).toContain("browser_evaluate");
  });

  it("withFlowshipSdkCustomTools：无 callerToken（readOnly / 受限答疑）不挂任何系统与浏览器工具", () => {
    install();
    const local = withFlowshipSdkCustomTools({}, undefined, undefined, { taskId: "t1" }) as { customTools?: unknown };
    expect(local.customTools).toBeUndefined();
    const full = withFlowshipSdkCustomTools({}, "tok", undefined, { taskId: "t1" }) as {
      customTools: Record<string, unknown>;
    };
    expect(Object.keys(full.customTools)).toContain("browser_navigate");
  });

  it("截图结果：image 块原样透传给 SDK（含 mimeType）", async () => {
    install();
    const tools = buildSdkCustomTools("tok", { taskId: "t1" });
    const r = await runSdkTool(tools, "browser_screenshot", {});
    expect(r.isError).toBeUndefined();
    const img = r.content.find((c) => c.type === "image");
    expect(img).toMatchObject({ type: "image", data: b64, mimeType: "image/jpeg" });
  });

  it("失败结果：isError:true + 文字（SDK customTool 原生支持）；成功结果不带 isError 字段", async () => {
    install();
    const tools = buildSdkCustomTools("tok", { taskId: "t1" });
    const bad = await runSdkTool(tools, "browser_click", { ref: "e1" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("重新调用 browser_snapshot");
    const ok = await runSdkTool(tools, "browser_snapshot", {});
    expect("isError" in ok).toBe(false);
  });
});

describe("invokeFlowshipTool 咽喉：非属主轮次硬拒浏览器工具", () => {
  it("白名单里没有 browser_*；非属主一轮里调用被 [DENIED]，且不发请求", async () => {
    const f = install();
    for (const name of BROWSER_TOOL_NAMES) expect(NON_OWNER_TURN_ALLOWED_TOOLS).not.toContain(name);
    const snapshot = getBrowserTools({ taskId: "t1" }).find((t) => t.name === "browser_snapshot")!;
    beginNonOwnerTurn("t1");
    const r = await invokeFlowshipTool(snapshot, {}, "tok", { taskId: "t1" });
    expect((r.content[0] as { text: string }).text).toContain("DENIED");
    expect(f.calls).toHaveLength(0);
  });

  it("属主轮次正常放行", async () => {
    install();
    const snapshot = getBrowserTools({ taskId: "t1" }).find((t) => t.name === "browser_snapshot")!;
    const r = await invokeFlowshipTool(snapshot, {}, "tok", { taskId: "t1" });
    expect((r.content[0] as { text: string }).text).toContain("页面快照");
  });
});

describe("pi：buildCustomTools", () => {
  const build = (callerToken: string | undefined, taskId?: string) =>
    __buildCustomToolsForTest(callerToken, TMP_ROOT, { input: {} } as never, [], taskId) as unknown as Array<{
      name: string;
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<Record<string, unknown>> }>;
    }>;

  it("无 callerToken / 无 taskId / bridge 不可用：不注册浏览器工具", () => {
    install();
    expect(build(undefined, "t1").some((t) => t.name.startsWith("browser_"))).toBe(false);
    expect(build("tok", undefined).some((t) => t.name.startsWith("browser_"))).toBe(false);
    fake!.cleanup();
    fake = null;
    expect(build("tok", "t1").some((t) => t.name.startsWith("browser_"))).toBe(false);
  });

  it("注册 + 截图的 image 块进 ToolResult.content（pi ImageContent 形状）", async () => {
    install();
    const tools = build("tok", "t1");
    expect(tools.map((t) => t.name)).toContain("browser_screenshot");
    const shot = tools.find((t) => t.name === "browser_screenshot")!;
    const r = await shot.execute("call-1", {}, undefined);
    expect(r.content.find((c) => c.type === "image")).toMatchObject({ type: "image", data: b64, mimeType: "image/jpeg" });
    expect(r.content.find((c) => c.type === "text")).toBeTruthy();
  });

  it("失败必须抛错（pi 的 execute 没有 isError 字段，agent-loop 靠抛错判失败），错误信息就是模型能自修复的文案", async () => {
    install();
    const click = build("tok", "t1").find((t) => t.name === "browser_click")!;
    await expect(click.execute("call-2", { ref: "e1" }, undefined)).rejects.toThrow(/重新调用 browser_snapshot/);
  });

  it("非属主一轮：execute 层先被 withNonOwnerTurnDeny 拒（返回 DENIED 文本、不发请求）", async () => {
    const f = install();
    const snapshot = build("tok", "t1").find((t) => t.name === "browser_snapshot")!;
    beginNonOwnerTurn("t1");
    const r = await snapshot.execute("call-3", {}, undefined);
    expect(JSON.stringify(r.content)).toContain("DENIED");
    expect(f.calls).toHaveLength(0);
  });
});
