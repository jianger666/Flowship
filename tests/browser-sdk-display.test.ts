/**
 * Cursor SDK 路径下 `browser_*` 工具的展示改写（R1 评审：SDK 路径事件 `name` 是 `mcp` 外壳，折叠行摘要认不出）。
 * 与 wait / subagent 同一思路：落事件前拆壳成扁平 `browser_xxx`；只改 name / args，不动 result（结果可能带截图）。
 */
import { describe, expect, it } from "vitest";

import { browserToolSummary } from "@/lib/browser-tool-display";
import {
  CURSOR_CUSTOM_TOOLS_SERVER,
  isCursorBrowserCall,
  toBrowserDisplayCall,
  toSubagentDisplayCall,
  toWaitDisplayCall,
} from "@/lib/cursor-subagent-display";

const shell = (toolName: string, inner: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "tool_call",
  call_id: "tool_b1",
  name: "mcp",
  status: "running",
  args: { providerIdentifier: CURSOR_CUSTOM_TOOLS_SERVER, toolName, args: inner },
  ...extra,
});

describe("isCursorBrowserCall", () => {
  it("只认 mcp + custom-user-tools + browser_ 前缀", () => {
    expect(isCursorBrowserCall(shell("browser_click", { ref: "e12" }))).toBe(true);
    expect(isCursorBrowserCall(shell("browser_ask_user_to_act", { message: "登录" }))).toBe(true);
  });

  it("第三方 MCP（如 Playwright 也叫 browser_click）不沾光：server 必须正好是保留的合成名", () => {
    const third = { ...shell("browser_click", { element: "按钮" }), args: { providerIdentifier: "playwright", toolName: "browser_click", args: { element: "按钮" } } };
    expect(isCursorBrowserCall(third)).toBe(false);
    expect(toBrowserDisplayCall(third)).toBe(third);
  });

  it("不是浏览器工具 / 已是扁平名 / 入参不是对象：不认", () => {
    expect(isCursorBrowserCall(shell("wait", { seconds: 1 }))).toBe(false);
    expect(isCursorBrowserCall(shell("submit_work", {}))).toBe(false);
    expect(isCursorBrowserCall({ name: "browser_click", args: { ref: "e1" } })).toBe(false); // pi 路径：本来就是扁平的
    expect(isCursorBrowserCall({ name: "mcp", args: "oops" })).toBe(false);
    expect(isCursorBrowserCall({ name: "mcp" })).toBe(false);
  });
});

describe("toBrowserDisplayCall", () => {
  it("name → 内层工具名，args → 真入参；不动原消息", () => {
    const raw = shell("browser_click", { ref: "e12", double_click: true });
    const snapshot = JSON.parse(JSON.stringify(raw));
    const out = toBrowserDisplayCall(raw);
    expect(out.name).toBe("browser_click");
    expect(out.args).toEqual({ ref: "e12", double_click: true });
    expect(out.call_id).toBe("tool_b1");
    expect(out.status).toBe("running");
    expect(raw).toEqual(snapshot);
  });

  it("result 原样保留（同一引用）：结果可能带截图，拆信封取文本会丢图", () => {
    const result = { status: "success", value: { content: [{ text: { text: "已点击" } }, { image: { data: "AAAA", mimeType: "image/jpeg" } }], isError: false } };
    const out = toBrowserDisplayCall(shell("browser_screenshot", {}, { status: "completed", result }));
    expect(out.name).toBe("browser_screenshot");
    expect((out as { result?: unknown }).result).toBe(result);
  });

  it("入参缺失 → 空对象，不抛", () => {
    const out = toBrowserDisplayCall({ ...shell("browser_snapshot", {}), args: { providerIdentifier: CURSOR_CUSTOM_TOOLS_SERVER, toolName: "browser_snapshot" } });
    expect(out.name).toBe("browser_snapshot");
    expect(out.args).toEqual({});
  });

  it("不是浏览器工具的消息原样返回（同一引用）", () => {
    const sh = { name: "shell", args: { command: "ls" } };
    expect(toBrowserDisplayCall(sh)).toBe(sh);
    const w = shell("wait", { seconds: 3 });
    expect(toBrowserDisplayCall(w)).toBe(w);
  });

  it("与 wait / subagent 改写链式互不干扰（sdk-message-handler 里的真实顺序）", () => {
    const chain = (m: Parameters<typeof toSubagentDisplayCall>[0]) => toBrowserDisplayCall(toWaitDisplayCall(toSubagentDisplayCall(m)));
    expect(chain(shell("wait", { seconds: 3 })).name).toBe("wait");
    expect(chain(shell("subagent", { prompt: "p" })).name).toBe("task");
    expect(chain(shell("browser_navigate", { url: "https://example.com/a" })).name).toBe("browser_navigate");
    expect(chain(shell("submit_work", {})).name).toBe("mcp"); // 其它自有工具不受影响
  });

  it("拆壳后折叠行摘要认得出（拆壳前是空串、会退化成整段外壳 JSON）", () => {
    const raw = shell("browser_click", { ref: "e12" });
    const rawSummary = browserToolSummary(raw.name, JSON.stringify(raw.args));
    expect(rawSummary).toBe("");
    const out = toBrowserDisplayCall(raw);
    const summary = browserToolSummary(out.name as string, JSON.stringify(out.args));
    expect(summary).toContain("e12");
  });
});
