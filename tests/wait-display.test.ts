/**
 * `wait` 工具的展示层（纯函数）：入参解析 / 一行摘要 / Cursor MCP 外壳改写 / 状态行 / 工具块摘要。
 * 消息形状取自 2026-10-16 真实 Cursor SDK 运行（E2E s2/s4/s5：name=mcp、providerIdentifier=custom-user-tools、
 * toolName=wait、args 里再套一层真入参）。
 */
import { describe, expect, it } from "vitest";

import {
  CURSOR_CUSTOM_TOOLS_SERVER,
  isCursorWaitCall,
  toSubagentDisplayCall,
  toWaitDisplayCall,
} from "@/lib/cursor-subagent-display";
import {
  WAIT_STATUS_LABEL,
  deriveActiveStatus,
} from "@/lib/chat-turns";
import { toolBlockSummary, type ToolBlock } from "@/lib/tool-display";
import {
  WAIT_TOOL_NAME,
  isSkippableWaitBlock,
  parseWaitToolArgs,
  waitToolSummary,
} from "@/lib/wait-display";
import { FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER, flowShipTools } from "@/lib/server/flowship-tools";
import type { TaskEvent } from "@/lib/types";

const running = {
  type: "tool_call",
  call_id: "tool_w1",
  name: "mcp",
  status: "running",
  args: {
    providerIdentifier: "custom-user-tools",
    toolName: "wait",
    args: { seconds: 14, reason: "等待后台 sleep 12 命令完成" },
  },
};

const envelope = (text: string, isError = false) => ({
  status: "success",
  value: { content: [{ text: { text } }], isError },
});

describe("常量守护", () => {
  it("工具名 = flowShipTools 里注册的那个（改了一边另一边要跟着改，否则 UI 认不出）", () => {
    expect(flowShipTools.map((t) => t.name)).toContain(WAIT_TOOL_NAME);
  });

  it("合成 MCP server 名与 SDK 注册名一致", () => {
    expect(CURSOR_CUSTOM_TOOLS_SERVER).toBe(FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER);
  });
});

describe("parseWaitToolArgs", () => {
  it("正常入参", () => {
    expect(parseWaitToolArgs('{"seconds":60,"reason":" 等 CI "}')).toEqual({
      seconds: 60,
      reason: "等 CI",
    });
  });

  it("缺字段 / 字段类型不对 = 当没有，不抛", () => {
    expect(parseWaitToolArgs('{"seconds":"60","reason":5}')).toEqual({});
    expect(parseWaitToolArgs('{"seconds":-3}')).toEqual({});
    expect(parseWaitToolArgs('{"seconds":0}')).toEqual({});
    expect(parseWaitToolArgs('{"reason":"   "}')).toEqual({});
  });

  it("不是对象 / 坏 JSON / 空 = null", () => {
    expect(parseWaitToolArgs(undefined)).toBeNull();
    expect(parseWaitToolArgs("")).toBeNull();
    expect(parseWaitToolArgs("not json")).toBeNull();
    expect(parseWaitToolArgs("[1,2]")).toBeNull();
    expect(parseWaitToolArgs("42")).toBeNull();
  });
});

describe("waitToolSummary", () => {
  it("计划时长 + 原因", () => {
    expect(waitToolSummary('{"seconds":60,"reason":"等 CI 跑完"}')).toBe(
      "共 1m0s · 等 CI 跑完",
    );
  });

  it("只有一项也成句", () => {
    expect(waitToolSummary('{"seconds":15}')).toBe("共 15s");
    expect(waitToolSummary('{"reason":"冷却"}')).toBe("冷却");
  });

  it("什么都没有 → 空串（调用方回落通用摘要）", () => {
    expect(waitToolSummary(undefined)).toBe("");
    expect(waitToolSummary("{}")).toBe("");
    expect(waitToolSummary("garbage")).toBe("");
  });
});

describe("isCursorWaitCall / toWaitDisplayCall", () => {
  it("只认 mcp + custom-user-tools + wait", () => {
    expect(isCursorWaitCall(running)).toBe(true);
    expect(isCursorWaitCall({ ...running, name: "wait" })).toBe(false);
    expect(
      isCursorWaitCall({ ...running, args: { ...running.args, toolName: "subagent" } }),
    ).toBe(false);
    expect(
      isCursorWaitCall({ ...running, args: { ...running.args, providerIdentifier: "x" } }),
    ).toBe(false);
    expect(isCursorWaitCall({ name: "mcp", args: "oops" })).toBe(false);
    expect(isCursorWaitCall({})).toBe(false);
  });

  it("running：name → wait，args → 扁平真入参；不动原消息", () => {
    const snapshot = JSON.parse(JSON.stringify(running));
    const out = toWaitDisplayCall(running);
    expect(out.name).toBe("wait");
    expect(out.args).toEqual({ seconds: 14, reason: "等待后台 sleep 12 命令完成" });
    expect(out.call_id).toBe("tool_w1");
    expect(out.status).toBe("running");
    expect(running).toEqual(snapshot);
  });

  it("completed：拆 MCP 信封成纯文本", () => {
    const out = toWaitDisplayCall({
      ...running,
      status: "completed",
      result: envelope("[WAIT_DONE] 已等 14 秒"),
    });
    expect(out.result).toBe("[WAIT_DONE] 已等 14 秒");
    expect(out.status).toBe("completed");
  });

  it("信封 isError → status 折成 error（卡片才会标红）", () => {
    const out = toWaitDisplayCall({
      ...running,
      status: "completed",
      result: envelope("boom", true),
    });
    expect(out.status).toBe("error");
    expect(out.result).toBe("boom");
  });

  it("认不出的结果形状原样保留（不吞信息）", () => {
    const weird = { something: "else" };
    const out = toWaitDisplayCall({ ...running, status: "completed", result: weird });
    expect(out.result).toBe(weird);
  });

  it("入参缺失 / 不是对象 → 空对象，不抛", () => {
    const out = toWaitDisplayCall({
      ...running,
      args: { providerIdentifier: "custom-user-tools", toolName: "wait" },
    });
    expect(out.name).toBe("wait");
    expect(out.args).toEqual({});
  });

  it("不是 wait 的消息原样返回（同一引用）", () => {
    const shell = { name: "shell", args: { command: "ls" } };
    expect(toWaitDisplayCall(shell)).toBe(shell);
    const sub = { ...running, args: { ...running.args, toolName: "subagent" } };
    expect(toWaitDisplayCall(sub)).toBe(sub);
  });

  it("与 subagent 改写互不干扰：链式调用时各改各的", () => {
    // sdk-message-handler 里是 toWaitDisplayCall(toSubagentDisplayCall(raw))
    const chained = toWaitDisplayCall(toSubagentDisplayCall(running));
    expect(chained.name).toBe("wait");
    const sub = {
      ...running,
      args: { ...running.args, toolName: "subagent", args: { prompt: "p" } },
    };
    expect(toWaitDisplayCall(toSubagentDisplayCall(sub)).name).toBe("task");
  });
});

// ---------- 状态行 ----------

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({ ts: 1, ...partial });

const user = ev({ id: "u", kind: "user_reply", text: "等一会", ts: 1 });

const waitCall = (args: string | Record<string, unknown> | undefined, ts = 2): TaskEvent =>
  ev({
    id: "w",
    kind: "tool_call",
    text: "调用 wait",
    ts,
    meta: {
      callId: "w1",
      name: WAIT_TOOL_NAME,
      ...(args === undefined
        ? {}
        : { args: typeof args === "string" ? args : JSON.stringify(args) }),
    },
  });

describe("状态行：wait 在跑", () => {
  it("未配对的 wait → 「等待中」+ 摘要 + 可跳过 + 走字起点", () => {
    const status = deriveActiveStatus(
      [user, waitCall({ seconds: 60, reason: "等 CI 跑完" })],
      undefined,
    );
    expect(status).toMatchObject({
      label: WAIT_STATUS_LABEL,
      detail: "共 1m0s · 等 CI 跑完",
      skippable: true,
      sinceTs: 2,
    });
  });

  it("入参读不出来 / 没有：照样是「等待中」+ 可跳过，只是没有 detail", () => {
    for (const args of ["garbage", undefined]) {
      const status = deriveActiveStatus([user, waitCall(args)], undefined);
      expect(status?.label).toBe(WAIT_STATUS_LABEL);
      expect(status?.skippable).toBe(true);
      expect(status?.detail).toBeUndefined();
    }
  });

  it("wait 返回后（tool_result 配对）不再是「等待中」、也不再可跳过", () => {
    const done = ev({
      id: "r",
      kind: "tool_result",
      text: "完成",
      ts: 62,
      meta: { callId: "w1", name: WAIT_TOOL_NAME, status: "success" },
    });
    const status = deriveActiveStatus(
      [user, waitCall({ seconds: 60 }), done],
      undefined,
    );
    expect(status?.label).not.toBe(WAIT_STATUS_LABEL);
    expect(status?.skippable).toBeUndefined();
  });

  it("别的工具在跑不带 skippable（按钮只属于 wait）", () => {
    const shell = ev({
      id: "s",
      kind: "tool_call",
      text: "调用 shell",
      ts: 2,
      meta: { callId: "s1", name: "shell", args: '{"command":"ls"}' },
    });
    const status = deriveActiveStatus([user, shell], undefined);
    expect(status?.skippable).toBeUndefined();
  });

  it("wait 在跑时不会叠上「仍在等待」沉默兜底（它自己就是等待，状态已经说清楚了）", () => {
    const status = deriveActiveStatus(
      [user, waitCall({ seconds: 60 })],
      undefined,
      { lastActivityTs: 2 },
    );
    expect(status).not.toHaveProperty("stallSinceTs");
  });
});

// ---------- 工具块摘要 ----------

describe("toolBlockSummary：wait", () => {
  const block = (args: string | undefined) =>
    ({
      kind: "__tool_block__",
      id: "b1",
      callId: "w1",
      name: WAIT_TOOL_NAME,
      status: "running",
      text: "调用 wait",
      args,
      ts: 1,
    }) satisfies ToolBlock;

  it("有入参 → 摘要走 waitToolSummary", () => {
    expect(
      toolBlockSummary(block('{"seconds":30,"reason":"等限流冷却"}')),
    ).toBe("共 30s · 等限流冷却");
  });

  it("入参读不出来 → 回落通用逻辑（最终兜底是 block.text），不抛、不空白", () => {
    expect(toolBlockSummary(block("garbage"))).toBe("garbage");
    expect(toolBlockSummary(block(undefined))).toBe("调用 wait");
    expect(toolBlockSummary(block("{}"))).toBe("调用 wait");
  });
});

describe("isSkippableWaitBlock：工具块上「跳过等待」的出现条件", () => {
  it("只有「wait 且正在跑」才出：跑完 / 出错 / 被中断都不出（睡眠已经结束，按钮没东西可叫醒）", () => {
    expect(isSkippableWaitBlock({ name: WAIT_TOOL_NAME, status: "running" })).toBe(true);
    for (const status of ["completed", "error", "interrupted"]) {
      expect(isSkippableWaitBlock({ name: WAIT_TOOL_NAME, status }), status).toBe(false);
    }
  });

  it("别的工具在跑不出（按钮只属于 wait）；工具名大小写不敏感，与状态行同口径", () => {
    expect(isSkippableWaitBlock({ name: "shell", status: "running" })).toBe(false);
    expect(isSkippableWaitBlock({ name: "subagent", status: "running" })).toBe(false);
    expect(isSkippableWaitBlock({ name: "Wait", status: "running" })).toBe(true);
  });
});
