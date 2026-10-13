/**
 * Cursor `subagent` 自定义工具的展示映射（纯函数）。
 * 消息形状取自 2026-10-13 真实 Cursor SDK 运行，不是凭空设想的。
 */
import { describe, expect, it } from "vitest";

import {
  CURSOR_CUSTOM_TOOLS_SERVER,
  CURSOR_SUBAGENT_TOOL_NAME,
  isCursorSubagentCall,
  toSubagentDisplayCall,
  unwrapMcpText,
} from "@/lib/cursor-subagent-display";
import {
  FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER,
  flowShipTools,
} from "@/lib/server/flowship-tools";

const running = {
  type: "tool_call",
  call_id: "tool_1",
  name: "mcp",
  status: "running",
  args: {
    providerIdentifier: "custom-user-tools",
    toolName: "subagent",
    args: { prompt: "p", model: "claude-sonnet-5-5", effort: "low" },
  },
};

const envelope = (text: string, isError = false) => ({
  status: "success",
  value: { content: [{ text: { text } }], isError },
});

describe("常量守护", () => {
  it("合成 MCP server 名与 SDK 注册名一致（改了一边另一边要跟着改）", () => {
    expect(CURSOR_CUSTOM_TOOLS_SERVER).toBe(FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER);
  });

  it("subagent 不与任何 Flowship 系统工具重名（同一个 customTools 表里）", () => {
    expect(flowShipTools.map((t) => t.name)).not.toContain(CURSOR_SUBAGENT_TOOL_NAME);
  });
});

describe("isCursorSubagentCall", () => {
  it("只认 mcp + custom-user-tools + subagent", () => {
    expect(isCursorSubagentCall(running)).toBe(true);
    expect(isCursorSubagentCall({ ...running, name: "task" })).toBe(false);
    expect(
      isCursorSubagentCall({
        ...running,
        args: { ...running.args, providerIdentifier: "feishu" },
      }),
    ).toBe(false);
    expect(
      isCursorSubagentCall({ ...running, args: { ...running.args, toolName: "ask_user" } }),
    ).toBe(false);
    expect(isCursorSubagentCall({ name: "mcp", args: "not-an-object" })).toBe(false);
    expect(isCursorSubagentCall({})).toBe(false);
  });
});

describe("unwrapMcpText", () => {
  it("SDK 的真实形状 { text: { text } }；多段用换行连起来", () => {
    expect(unwrapMcpText(envelope("你好"))).toEqual({ text: "你好", isError: false });
    expect(
      unwrapMcpText({
        value: { content: [{ text: { text: "a" } }, { text: { text: "b" } }] },
      }),
    ).toEqual({ text: "a\nb", isError: false });
  });

  it("也兼容 { text: 'str' }；isError 透出；忽略无文本段", () => {
    expect(unwrapMcpText({ value: { content: [{ text: "x" }, { image: 1 }, null], isError: true } })).toEqual({
      text: "x",
      isError: true,
    });
  });

  it("纯字符串原样；认不出的形状返回 null（调用方保留原结果）", () => {
    expect(unwrapMcpText("plain")).toEqual({ text: "plain", isError: false });
    expect(unwrapMcpText({ value: { stdout: "x" } })).toBeNull();
    expect(unwrapMcpText(undefined)).toBeNull();
    expect(unwrapMcpText(42)).toBeNull();
  });
});

describe("toSubagentDisplayCall", () => {
  it("running：name→task、args→扁平真入参；其余字段保留；不改原消息", () => {
    const snapshot = JSON.parse(JSON.stringify(running));
    const out = toSubagentDisplayCall(running);
    expect(out).toMatchObject({
      type: "tool_call",
      call_id: "tool_1",
      status: "running",
      name: "task",
      args: { prompt: "p", model: "claude-sonnet-5-5", effort: "low" },
    });
    expect(running).toEqual(snapshot);
  });

  it("completed：result 拆成纯文本", () => {
    const out = toSubagentDisplayCall({ ...running, status: "completed", result: envelope("答案") });
    expect(out.result).toBe("答案");
    expect(out.status).toBe("completed");
  });

  it("completed 但工具回 isError：status 折成 error", () => {
    const out = toSubagentDisplayCall({ ...running, status: "completed", result: envelope("没有这个模型", true) });
    expect(out.status).toBe("error");
    expect(out.result).toBe("没有这个模型");
  });

  it("结果形状认不出：不动 result（宁可原样也不丢信息）", () => {
    const weird = { status: "success", value: { stdout: "x" } };
    const out = toSubagentDisplayCall({ ...running, status: "completed", result: weird });
    expect(out.result).toBe(weird);
  });

  it("入参缺失：args 给空对象，不抛", () => {
    const out = toSubagentDisplayCall({
      name: "mcp",
      args: { providerIdentifier: "custom-user-tools", toolName: "subagent" },
    });
    expect(out.name).toBe("task");
    expect(out.args).toEqual({});
  });

  it("不是 subagent 的消息：原样返回（同一个引用）", () => {
    const shell = { name: "shell", args: { command: "ls" } };
    expect(toSubagentDisplayCall(shell)).toBe(shell);
    const other = {
      name: "mcp",
      args: { providerIdentifier: "custom-user-tools", toolName: "ask_user", args: {} },
    };
    expect(toSubagentDisplayCall(other)).toBe(other);
  });
});
