/**
 * R2-01（P1）：Cursor 路径下浏览器工具的失败不得落成 success；同时 R1-02「明文入参不落盘」不退化。
 *
 * 回归成因：sdk-message-handler 把 `toBrowserDisplayCall` 拆壳后的 msg（name 变成扁平 `browser_click`）同时用于
 * `emitToolResult`，`resolveToolResultStatus` 里 `isMcpToolName(name) && value.isError` 的 MCP 分支对扁平名失效；
 * Cursor 的信封是 `status:"success"` + `value.isError:true`，于是工具级失败被落成 success。
 *
 * 与 browser-args-redact.test.ts 的区别：那边 mock 掉了 `buildToolResultMeta`（状态判定与 meta 构造都看不到）；
 * 这里**不 mock 判定逻辑**：`buildToolResultMeta` 走真实实现（只包一层 spy 记录入参），只 mock 落盘 / 广播的边界
 * （task-fs 的 appendEvent、task-stream 的 writeOwnedEventAndPublish / publish）。
 *
 * 两层修法各有独立的钉子：
 *  ① handler 把展示改写前的 MCP 外壳身份作为 `statusFrom` 交给 `buildToolResultMeta`（展示名仍是扁平 browser_xxx）；
 *  ② `resolveToolResultStatus` 自己也认 `browser_` 前缀的扁平名。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.FLOWSHIP_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fe-browser-result-status-"));

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
// 只包一层 spy：行为仍是真实 buildToolResultMeta（状态判定 / 抽文本 / 脱敏全走真代码），spy 只用来记录 handler 交给它的入参
vi.mock("@/lib/server/tool-result-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/tool-result-persist")>();
  return { ...actual, buildToolResultMeta: vi.fn(actual.buildToolResultMeta) };
});

const { handleSdkMessage, __resetToolCallRunningSeenForTest } = await import("@/lib/server/sdk-message-handler");
const persist = await import("@/lib/server/tool-result-persist");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const leaseOk = () => true;
const newCtx = (extra: Partial<AssistantBufferCtx> = {}): AssistantBufferCtx => ({ buffer: "", flush: async () => {}, ...extra });
const written = (): WrittenEvent[] => writeOwnedEventAndPublish.mock.calls.map((c) => c[2] as WrittenEvent);
const appended = (): WrittenEvent[] => appendEvent.mock.calls.map((c) => c[1] as WrittenEvent);
const everything = (): string => JSON.stringify([written(), appended()]);
const resultsOf = (evs: WrittenEvent[]): WrittenEvent[] => evs.filter((e) => e.kind === "tool_result");

const mcpShell = (toolName: string, inner: unknown) => ({
  providerIdentifier: "custom-user-tools",
  toolName,
  args: inner,
});
const call = (name: string, args: unknown, status: string, callId: string, result?: unknown) =>
  ({ type: "tool_call", call_id: callId, name, status, args, ...(result === undefined ? {} : { result }) }) as never;

/** Cursor 的 MCP 信封：工具级失败仍是 status:"success"，只有 value.isError 能看出来 */
const cursorEnvelope = (text: string, isError: boolean) => ({
  status: "success",
  value: { isError, content: [{ text: { text } }] },
});

beforeEach(() => {
  writeOwnedEventAndPublish.mockClear();
  appendEvent.mockClear();
  vi.mocked(persist.buildToolResultMeta).mockClear();
  __resetToolCallRunningSeenForTest();
});

describe("R2-01：Cursor MCP 外壳的浏览器工具 → tool_result 状态（不 mock buildToolResultMeta）", () => {
  it("信封 status:success + value.isError:true → 落成 error（回归点）；展示名仍是扁平 browser_click", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_click", { ref: "e12" }), "completed", "c-fail", cursorEnvelope("找不到元素 e12", true)),
      newCtx(),
      leaseOk,
    );
    const [res] = resultsOf(written());
    expect(res).toBeDefined();
    expect(res?.meta?.status).toBe("error");
    expect(res?.text).toBe("工具失败 browser_click");
    // 展示名必须保持扁平：工具块的名字取 tool_result.meta.name 优先、折叠行摘要按 browser_ 前缀认它（R1-20）
    expect(res?.meta?.name).toBe("browser_click");
    expect(String(res?.meta?.output)).toContain("找不到元素 e12");
  });

  it("信封 isError:false → success（成功信封不被误判）", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_click", { ref: "e12" }), "completed", "c-ok", cursorEnvelope("已点击 e12", false)),
      newCtx(),
      leaseOk,
    );
    const [res] = resultsOf(written());
    expect(res?.meta?.status).toBe("success");
    expect(res?.meta?.name).toBe("browser_click");
  });

  it("SDK 自己报 status:error（工具抛错）→ error，不受影响", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_navigate", { url: "https://a.test/" }), "error", "c-throw", { status: "error", error: "boom" }),
      newCtx(),
      leaseOk,
    );
    expect(resultsOf(written())[0]?.meta?.status).toBe("error");
  });

  it("askSeen 消音审计路径（appendEvent，muted）同样判成 error", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_click", { ref: "e1" }), "completed", "c-muted", cursorEnvelope("失败了", true)),
      newCtx({ askSeen: true }),
      leaseOk,
    );
    expect(written()).toHaveLength(0);
    const [res] = resultsOf(appended());
    expect(res?.meta?.muted).toBe(true);
    expect(res?.meta?.status).toBe("error");
  });

  it("工具真实失败文案之外，没有把 MCP 外壳字段（providerIdentifier）泄进 tool_result", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_click", { ref: "e12" }), "completed", "c-shell", cursorEnvelope("失败", true)),
      newCtx(),
      leaseOk,
    );
    const [res] = resultsOf(written());
    expect(JSON.stringify(res)).not.toContain("custom-user-tools");
  });
});

describe("R2-01 ①：handler 把展示改写前的 MCP 外壳身份（仅名字）交给 buildToolResultMeta", () => {
  it("browser_type：statusFrom 只含 server / tool 名，不含 text 明文；rawName 仍是扁平名", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_type", { ref: "e5", text: "hunter2" }), "completed", "c-ty", cursorEnvelope("已输入 7 个字符", false)),
      newCtx(),
      leaseOk,
    );
    expect(persist.buildToolResultMeta).toHaveBeenCalledTimes(1);
    const input = vi.mocked(persist.buildToolResultMeta).mock.calls[0]![0];
    expect(input.rawName).toBe("browser_type");
    expect(input.statusFrom).toEqual({
      rawName: "mcp",
      args: { providerIdentifier: "custom-user-tools", toolName: "browser_type" },
    });
    expect(JSON.stringify(input.statusFrom)).not.toContain("hunter2");
    // 交给 buildToolResultMeta 的 args 也是脱敏后的（R1-02 不退化）
    expect(JSON.stringify(input.args)).not.toContain("hunter2");
  });

  it("pi 路径（裸名 browser_click）与非浏览器工具：不传 statusFrom（行为与改动前一致）", async () => {
    await handleSdkMessage("t1", call("browser_click", { ref: "e1" }, "completed", "c-pi", { content: [{ type: "text", text: "ok" }] }), newCtx(), leaseOk);
    await handleSdkMessage("t1", call("shell", { command: "echo hi" }, "completed", "c-sh", { status: "success", value: { stdout: "hi\n", exitCode: 0 } }), newCtx(), leaseOk);
    const inputs = vi.mocked(persist.buildToolResultMeta).mock.calls.map((c) => c[0]);
    expect(inputs).toHaveLength(2);
    expect(inputs.every((i) => i.statusFrom === undefined)).toBe(true);
  });
});

describe("R2-01 ①：buildToolResultMeta 的 statusFrom（独立于 ② 的钉子）", () => {
  it("展示名改写成一个非 browser_ 前缀的扁平名时，只有 statusFrom 能让 isError 判成 error；meta.name 仍是展示名", async () => {
    const base = {
      taskId: "t-sf",
      callId: "c-sf",
      rawName: "flat_display_name",
      args: { x: 1 },
      result: cursorEnvelope("坏了", true),
      msgStatus: "completed",
    };
    const without = await persist.buildToolResultMeta(base);
    expect(without.status).toBe("success"); // 名字认不出 MCP → 没有 statusFrom 就会误判（这正是回归）
    const withFrom = await persist.buildToolResultMeta({
      ...base,
      statusFrom: { rawName: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "flat_display_name" } },
    });
    expect(withFrom.status).toBe("error");
    expect(withFrom.name).toBe("flat_display_name");
  });

  it("buildInlineToolResultMeta（子代理过程记录用的内存版）同样认 statusFrom", () => {
    const meta = persist.buildInlineToolResultMeta({
      callId: "c-inline",
      rawName: "flat_display_name",
      result: cursorEnvelope("坏了", true),
      msgStatus: "completed",
      statusFrom: { rawName: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "flat_display_name" } },
    });
    expect(meta.status).toBe("error");
  });
});

describe("R2-01 ②：resolveToolResultStatus 认 browser_ 前缀的扁平名（纵深）", () => {
  const failEnv = cursorEnvelope("坏了", true);

  it("扁平 browser_xxx + value.isError:true → error；isError:false → success", () => {
    expect(persist.resolveToolResultStatus("completed", "browser_click", failEnv)).toBe("error");
    expect(persist.resolveToolResultStatus("completed", "browser_screenshot", failEnv)).toBe("error");
    expect(persist.resolveToolResultStatus("completed", "browser_click", cursorEnvelope("ok", false))).toBe("success");
  });

  it("归一化 MCP 名与 mcp__ 名照旧认（不退化）", () => {
    expect(persist.resolveToolResultStatus("completed", "mcp:custom-user-tools:browser_click", failEnv)).toBe("error");
    expect(persist.resolveToolResultStatus("completed", "mcp__custom-user-tools__browser_click", failEnv)).toBe("error");
  });

  it("不扩大：非浏览器的扁平工具名（read / shell）带 value.isError 仍不判 error；pi 形态（无 value 信封）不受影响", () => {
    expect(persist.resolveToolResultStatus("completed", "read", failEnv)).toBe("success");
    expect(persist.resolveToolResultStatus("completed", "shell", failEnv)).toBe("success");
    expect(persist.resolveToolResultStatus("completed", "browser_click", { content: [{ type: "text", text: "ok" }], details: {} })).toBe("success");
    expect(persist.resolveToolResultStatus("completed", "browser_click", { content: [{ type: "text", text: "x" }], details: { isError: true } })).toBe("error");
    expect(persist.resolveToolResultStatus("error", "browser_click", { content: [] })).toBe("error");
  });
});

describe("R2-01：R1-02「明文入参不落盘」在真实 tool_result 路径上不退化", () => {
  it("browser_type 的明文 text：tool_call 事件与 tool_result 落盘 meta 里都不出现（SDK 外壳 + pi 裸名各一次）", async () => {
    await handleSdkMessage("t1", call("mcp", mcpShell("browser_type", { ref: "e5", text: "hunter2" }), "running", "c-sdk"), newCtx(), leaseOk);
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("browser_type", { ref: "e5", text: "hunter2" }), "completed", "c-sdk", cursorEnvelope("已输入 7 个字符", false)),
      newCtx(),
      leaseOk,
    );
    await handleSdkMessage("t1", call("browser_type", { ref: "e5", text: "hunter2" }, "running", "c-pi"), newCtx(), leaseOk);
    await handleSdkMessage(
      "t1",
      call("browser_type", { ref: "e5", text: "hunter2" }, "completed", "c-pi", { content: [{ type: "text", text: "已输入 7 个字符" }], details: {} }),
      newCtx(),
      leaseOk,
    );
    expect(resultsOf(written())).toHaveLength(2);
    expect(everything()).not.toContain("hunter2");
    expect(everything()).toContain("[已隐藏 7 字符]");
  });
});

describe("R2-01：不动 subagent / wait 的现有改写语义", () => {
  it("wait（MCP 外壳）：改写成扁平 wait，信封里的 isError 折成 status:error（原有行为）", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("wait", { seconds: 5 }), "completed", "c-wait", cursorEnvelope("参数错误：seconds", true)),
      newCtx(),
      leaseOk,
    );
    const [res] = resultsOf(written());
    expect(res?.meta?.name).toBe("wait");
    expect(res?.meta?.status).toBe("error");
    expect(vi.mocked(persist.buildToolResultMeta).mock.calls[0]![0].statusFrom).toBeUndefined();
  });

  it("subagent（MCP 外壳）：改写成 task，结果拆信封；成功 → success、isError → error", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("subagent", { prompt: "p", description: "d" }), "completed", "c-sub-ok", cursorEnvelope("done", false)),
      newCtx(),
      leaseOk,
    );
    await handleSdkMessage(
      "t1",
      call("mcp", mcpShell("subagent", { prompt: "p", description: "d" }), "completed", "c-sub-bad", cursorEnvelope("failed", true)),
      newCtx(),
      leaseOk,
    );
    const [ok, bad] = resultsOf(written());
    expect(ok?.meta?.name).toBe("task");
    expect(ok?.meta?.status).toBe("success");
    expect(bad?.meta?.name).toBe("task");
    expect(bad?.meta?.status).toBe("error");
  });

  it("其它 MCP 自定义工具（非浏览器）的 value.isError 仍判 error（原 MCP 分支不变）", async () => {
    await handleSdkMessage(
      "t1",
      call("mcp", { providerIdentifier: "feishu", toolName: "add_comment", args: {} }, "completed", "c-feishu", cursorEnvelope("权限不足", true)),
      newCtx(),
      leaseOk,
    );
    const [res] = resultsOf(written());
    expect(res?.meta?.name).toBe("mcp:feishu:add_comment");
    expect(res?.meta?.status).toBe("error");
  });
});
