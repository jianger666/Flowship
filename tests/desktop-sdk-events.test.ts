/**
 * Cursor SDK 路径下 desktop_* 工具调用 → 事件落盘（handleSdkMessage 的真实咽喉）：
 *  · 打出去的文字（desktop_type.text）/ 单字符按键不得以明文进 events.jsonl / SSE / 飞书回流；
 *  · MCP 外壳拆成扁平 `desktop_xxx` 展示名，但工具级失败（value.isError）仍要落成 error；
 *  · 截图（图片内容块）不得把 base64 塞进事件。
 * 做法同 tests/browser-tool-result-status.test.ts：状态判定 / 脱敏走真实实现，只 mock 落盘与广播的边界。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.FLOWSHIP_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fe-desktop-sdk-events-"));

type WrittenEvent = { kind: string; text?: string; meta?: Record<string, unknown> };

const writeOwnedEventAndPublish = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const appendEvent = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
  appendEvent: (...a: unknown[]) => appendEvent(...a),
}));
vi.mock("@/lib/server/failpoints", () => ({ failpoint: vi.fn(async () => {}) }));
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeOwnedEventAndPublish: (...a: unknown[]) => writeOwnedEventAndPublish(...a),
    publish: vi.fn(),
    publishIfCurrent: vi.fn(),
  };
});

const { handleSdkMessage, __resetToolCallRunningSeenForTest } = await import("@/lib/server/sdk-message-handler");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const leaseOk = () => true;
const newCtx = (extra: Partial<AssistantBufferCtx> = {}): AssistantBufferCtx => ({ buffer: "", flush: async () => {}, ...extra });
const written = (): WrittenEvent[] => writeOwnedEventAndPublish.mock.calls.map((c) => c[2] as WrittenEvent);
const appended = (): WrittenEvent[] => appendEvent.mock.calls.map((c) => c[1] as WrittenEvent);
const everything = (): string => JSON.stringify([written(), appended()]);
const resultsOf = (evs: WrittenEvent[]): WrittenEvent[] => evs.filter((e) => e.kind === "tool_result");
const callsOf = (evs: WrittenEvent[]): WrittenEvent[] => evs.filter((e) => e.kind === "tool_call" || e.kind === "tool_block");

const mcpShell = (toolName: string, inner: unknown) => ({ providerIdentifier: "custom-user-tools", toolName, args: inner });
const call = (name: string, args: unknown, status: string, callId: string, result?: unknown) =>
  ({ type: "tool_call", call_id: callId, name, status, args, ...(result === undefined ? {} : { result }) }) as never;
const envelope = (text: string, isError: boolean, extraContent: unknown[] = []) => ({
  status: "success",
  value: { isError, content: [{ text: { text } }, ...extraContent] },
});

beforeEach(() => {
  writeOwnedEventAndPublish.mockClear();
  appendEvent.mockClear();
  __resetToolCallRunningSeenForTest();
});

describe("Cursor 路径：打出去的文字不落盘", () => {
  it("desktop_type（running → completed 两帧）：events / meta 里都找不到明文，只有 [已隐藏 N 字符]", async () => {
    const SECRET = "hunter2-很机密"; // 7 + 1 + 3 = 11 个字符
    const args = mcpShell("desktop_type", { text: SECRET, submit: true });
    await handleSdkMessage("t1", call("mcp", args, "running", "c-ty"), newCtx(), leaseOk);
    await handleSdkMessage("t1", call("mcp", args, "completed", "c-ty", envelope("已输入 11 个字符，并按了回车。", false)), newCtx(), leaseOk);
    const dump = everything();
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("很机密");
    // 占位符落在 running 帧的 tool_call 事件里（args 已脱敏、submit 等结构信息保留）
    const [callEv] = callsOf(written());
    expect(callEv).toBeDefined();
    expect(callEv?.meta?.name).toBe("desktop_type");
    expect(JSON.parse(String(callEv?.meta?.args))).toEqual({ text: "[已隐藏 11 字符]", submit: true });
  });

  it("askSeen 消音审计路径（appendEvent）同样脱敏", async () => {
    const args = mcpShell("desktop_type", { text: "p4ssw0rd!!" });
    await handleSdkMessage("t1", call("mcp", args, "running", "c-muted"), newCtx({ askSeen: true }), leaseOk);
    await handleSdkMessage("t1", call("mcp", args, "completed", "c-muted", envelope("ok", false)), newCtx({ askSeen: true }), leaseOk);
    expect(written()).toHaveLength(0);
    expect(appended().length).toBeGreaterThan(0);
    expect(everything()).not.toContain("p4ssw0rd");
    expect(JSON.stringify(callsOf(appended()))).toContain("[已隐藏 10 字符]");
  });

  it("desktop_key 单字符键：隐藏；快捷键保持可读", async () => {
    await handleSdkMessage("t1", call("mcp", mcpShell("desktop_key", { keys: "q" }), "running", "c-k1"), newCtx(), leaseOk);
    await handleSdkMessage("t1", call("mcp", mcpShell("desktop_key", { keys: "cmd+shift+v" }), "running", "c-k2"), newCtx(), leaseOk);
    const calls = JSON.stringify(callsOf(written()));
    expect(calls).toContain("cmd+shift+v");
    expect(calls).not.toMatch(/"keys":"q"/);
    expect(calls).toContain("[已隐藏 1 字符]");
  });

  it("pi 路径（裸名 desktop_type）同样在咽喉处脱敏", async () => {
    await handleSdkMessage("t1", call("desktop_type", { text: "pi-secret-9" }, "running", "c-pi"), newCtx(), leaseOk);
    await handleSdkMessage("t1", call("desktop_type", { text: "pi-secret-9" }, "completed", "c-pi", { content: [{ type: "text", text: "已输入 11 个字符。" }] }), newCtx(), leaseOk);
    expect(everything()).not.toContain("pi-secret-9");
    expect(JSON.stringify(callsOf(written()))).toContain("[已隐藏 11 字符]");
  });
});

describe("Cursor 路径：状态与展示名", () => {
  it("信封 status:success + value.isError:true → 落成 error；展示名是扁平 desktop_click、没有外壳字段", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("desktop_click", { x: 1, y: 2 }), "completed", "c-fail", envelope("电脑操作没有开启", true)),
      newCtx(),
      leaseOk,
    );
    const [res] = resultsOf(written());
    expect(res).toBeDefined();
    expect(res?.meta?.status).toBe("error");
    expect(res?.meta?.name).toBe("desktop_click");
    expect(res?.text).toBe("工具失败 desktop_click");
    expect(String(res?.meta?.output)).toContain("电脑操作没有开启");
    expect(JSON.stringify(res)).not.toContain("custom-user-tools");
  });

  it("成功信封 → success", async () => {
    await handleSdkMessage("t1", call("mcp", mcpShell("desktop_click", { x: 1, y: 2 }), "completed", "c-ok", envelope("已点击 (1, 2)", false)), newCtx(), leaseOk);
    const [res] = resultsOf(written());
    expect(res?.meta?.status).toBe("success");
    expect(res?.meta?.name).toBe("desktop_click");
  });

  it("tool_call 事件的展示名是扁平 desktop_xxx（折叠行摘要按前缀认它）", async () => {
    await handleSdkMessage("t1", call("mcp", mcpShell("desktop_click", { x: 320, y: 240 }), "running", "c-run"), newCtx(), leaseOk);
    const dump = JSON.stringify(callsOf(written()));
    expect(dump).toContain("desktop_click");
    expect(dump).not.toContain("providerIdentifier");
  });
});

describe("Cursor 路径：截图不进事件", () => {
  it("结果里带图片内容块（真实截图量级）：事件里不出现 base64，只留「图片已省略」占位", async () => {
    // image-redact 只认 ≥2048 字符的 data（防小图标误判）；真实截图是几十到上千 KB
    const B64 = `QUJD${"REVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(300)}=`;
    await handleSdkMessage(
      "t1",
      call(
        "mcp",
        mcpShell("desktop_screenshot", {}),
        "completed",
        "c-shot",
        envelope("已截取屏幕。", false, [{ image: { data: B64, mimeType: "image/jpeg" } }]),
      ),
      newCtx(),
      leaseOk,
    );
    expect(everything()).not.toContain("REVGR0hJSktMTU5PUFFSU1RVVldYWVo");
    const [res] = resultsOf(written());
    expect(res?.meta?.status).toBe("success");
    expect(String(res?.meta?.output)).toContain("已截取屏幕");
    expect(String(res?.meta?.output)).toContain("已省略");
  });
});
