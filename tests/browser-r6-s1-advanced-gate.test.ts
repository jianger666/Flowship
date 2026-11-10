/**
 * R6-21：browserAdvancedTools 只在会话创建时判断——已建会话关开关后，调试器 / 网络规则 / 录制仍可用。
 * 修法：高级组每个工具 handler 入口实时读 `getBrowserSettingsSync().advancedTools`，只有显式 true 才放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBrowserSettingsForTest } from "../src/lib/server/browser/settings";
import { getBrowserTools } from "../src/lib/server/browser/tools";
import { ADVANCED_TOOLS_OFF_TEXT, gateAdvancedTools } from "../src/lib/server/browser/tools-e2";
import type { FlowshipToolResult } from "../src/lib/server/flowship-tools";
import { installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

const TASK = "task-r6-21";
const ADVANCED = ["browser_network_rules", "browser_perf", "browser_sources", "browser_debug", "browser_record"];
const textOf = (r: FlowshipToolResult): string => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

let fake: FakeBrowser | null = null;
beforeEach(() => {
  __resetBrowserSettingsForTest({ advancedTools: true });
  fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }) } as Parameters<typeof installFakeBrowser>[0]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  vi.restoreAllMocks();
  __resetBrowserSettingsForTest();
});

const minimalArgs: Record<string, Record<string, unknown>> = {
  browser_network_rules: { action: "list" },
  browser_perf: { action: "metrics" },
  browser_sources: { action: "list" },
  browser_debug: { action: "status" },
  browser_record: { action: "status" },
};

describe("R6-21·高级组实时读开关", () => {
  it("会话创建时开着 → 5 个高级工具注册；之后关开关：每个高级工具调用都被拒，且不发任何请求到主进程", async () => {
    const tools = getBrowserTools({ taskId: TASK });
    for (const n of ADVANCED) expect(tools.map((t) => t.name), n).toContain(n);

    __resetBrowserSettingsForTest({ advancedTools: false }); // 用户在设置里把开关关了（会话不重建）
    for (const n of ADVANCED) {
      const before = fake!.calls.length;
      const r = await tools.find((t) => t.name === n)!.handler(minimalArgs[n], "tok", { taskId: TASK });
      expect(r.isError, n).toBe(true);
      expect(textOf(r), n).toContain("高级调试");
      expect(textOf(r), n).toMatch(/请不要重试/);
      expect(textOf(r), n).toMatch(/ask_user/); // 文案能自修复：给出出路
      expect(fake!.calls.length, `${n} 不应发请求到主进程`).toBe(before);
    }
  });

  it("再打开：同一批工具对象立刻恢复可用（实时读，不是建表时固化）", async () => {
    const tools = getBrowserTools({ taskId: TASK });
    __resetBrowserSettingsForTest({ advancedTools: false });
    const perf = tools.find((t) => t.name === "browser_perf")!;
    expect((await perf.handler(minimalArgs.browser_perf, "tok", { taskId: TASK })).isError).toBe(true);
    __resetBrowserSettingsForTest({ advancedTools: true });
    fake!.handlers.perf = () => ({ action: "metrics", first: true, metrics: { domNodes: 3 } });
    const r = await perf.handler(minimalArgs.browser_perf, "tok", { taskId: TASK });
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toContain("DOM 节点");
  });

  it("只认显式 true：读到 undefined / 脏值 / 读设置抛错，一律拒绝（fail-closed）", async () => {
    const inner = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const mkKit = (getSettings: () => unknown) => ({ getSettings, errorOut: (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true }) }) as never;
    const tool = { name: "x", label: "x", description: "x", parameters: {}, handler: inner };
    for (const v of [undefined, null, "true", 1, {}]) {
      const [g] = gateAdvancedTools(mkKit(() => ({ advancedTools: v })), [tool]);
      const r = await g.handler({}, undefined);
      expect(r.isError, String(v)).toBe(true);
      expect(textOf(r)).toBe(ADVANCED_TOOLS_OFF_TEXT);
    }
    const [thrower] = gateAdvancedTools(
      mkKit(() => {
        throw new Error("boom");
      }),
      [tool],
    );
    expect((await thrower.handler({}, undefined)).isError).toBe(true);
    expect(inner).not.toHaveBeenCalled();
    const [ok] = gateAdvancedTools(mkKit(() => ({ advancedTools: true })), [tool]);
    expect(textOf(await ok.handler({}, undefined))).toBe("ran");
  });

  it("核心组（storage / permissions / touch / clipboard / evaluate 等）不受高级开关影响", async () => {
    const tools = getBrowserTools({ taskId: TASK });
    __resetBrowserSettingsForTest({ advancedTools: false });
    fake!.handlers.clipboard = () => ({ action: "write", length: 1, watching: false });
    const clip = tools.find((t) => t.name === "browser_clipboard")!;
    const r = await clip.handler({ action: "write", text: "x" }, "tok", { taskId: TASK });
    expect(textOf(r)).not.toContain("高级调试");
  });
});
