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

describe("toSubagentDisplayCall · 徽标显示实际生效的模型 / 思考档", () => {
  const PARENT = {
    id: "claude-sonnet-5-5",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  };
  const call = (inner: Record<string, unknown>) => ({
    ...running,
    args: { ...running.args, args: inner },
  });
  const badge = (inner: Record<string, unknown>, parentModel: typeof PARENT | undefined = PARENT) => {
    const out = toSubagentDisplayCall(call(inner), { parentModel });
    return out.args as Record<string, unknown>;
  };

  it("model 缺省 / inherit：显示父会话实际模型；effort 没填：显示父会话当前思考档", () => {
    for (const model of [undefined, "inherit", " INHERIT ", ""]) {
      expect(badge({ prompt: "p", ...(model === undefined ? {} : { model }) })).toMatchObject({
        prompt: "p",
        model: "claude-sonnet-5-5",
        effort: "high",
      });
    }
  });

  it("显式写了别的模型：model 原样；effort 没填也不套父会话的档（那是另一个模型自己的默认）", () => {
    const a = badge({ prompt: "p", model: "composer-2.5" });
    expect(a.model).toBe("composer-2.5");
    expect(a).not.toHaveProperty("effort");
  });

  it("显式写了 effort：原样（那就是实际值）", () => {
    expect(badge({ prompt: "p", model: "inherit", effort: "low" })).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    expect(badge({ prompt: "p", model: "composer-2.5", effort: "max" })).toMatchObject({
      model: "composer-2.5",
      effort: "max",
    });
  });

  it("写成与父同 id：算沿用，effort 没填就补父会话当前档", () => {
    expect(badge({ prompt: "p", model: "Claude-Sonnet-5-5" })).toMatchObject({
      model: "Claude-Sonnet-5-5",
      effort: "high",
    });
  });

  it("effort=default 当没填；父会话没有档位型参数（只有开关）→ 不硬造 effort", () => {
    expect(badge({ prompt: "p", effort: "default" })).toMatchObject({ effort: "high" });
    const noEffort = badge(
      { prompt: "p" },
      { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
    );
    expect(noEffort.model).toBe("composer-2.5");
    expect(noEffort).not.toHaveProperty("effort");
  });

  it("resume 调用不改写：接着的是之前那个子代理，它当初用什么这里不知道，不硬造", () => {
    const out = badge({ prompt: "p", resume: "agent-1" });
    expect(out).toEqual({ prompt: "p", resume: "agent-1" });
  });

  it("不传 ctx / 没有父模型：行为与之前完全一样（徽标是原始入参）", () => {
    const raw = { prompt: "p", model: "inherit" };
    expect(toSubagentDisplayCall(call(raw)).args).toEqual(raw);
    expect(toSubagentDisplayCall(call(raw), {}).args).toEqual(raw);
    expect(toSubagentDisplayCall(call(raw), { parentModel: undefined }).args).toEqual(raw);
  });

  it("只改展示副本：原消息 / 原 args 对象一个字不动", () => {
    const msg = call({ prompt: "p", model: "inherit" });
    const snapshot = JSON.parse(JSON.stringify(msg));
    toSubagentDisplayCall(msg, { parentModel: PARENT });
    expect(msg).toEqual(snapshot);
  });

  it("completed 的 result 拆文本照旧，且不影响徽标改写", () => {
    const out = toSubagentDisplayCall(
      { ...call({ prompt: "p" }), status: "completed", result: envelope("答案") },
      { parentModel: PARENT },
    );
    expect(out.result).toBe("答案");
    expect((out.args as Record<string, unknown>).model).toBe("claude-sonnet-5-5");
  });

  it("不是 subagent 的消息：带 ctx 也原样返回（同一个引用）", () => {
    const shell = { name: "shell", args: { command: "ls" } };
    expect(toSubagentDisplayCall(shell, { parentModel: PARENT })).toBe(shell);
  });
});

describe("toSubagentDisplayCall · 默认档与 resume 的徽标", () => {
  const PARENT = {
    id: "gemini-4-argon",
    params: [{ id: "reasoning_effort", value: "high" }],
  };
  // 2026-10-19 真实 Cursor 清单：sonnet-5-5 默认 high、gemini-4-argon 默认 medium
  const DEFAULTS: Record<string, string> = {
    "claude-sonnet-5-5": "high",
    "gemini-4-argon": "medium",
  };
  const defaultEffortOf = (id: string) => DEFAULTS[id.toLowerCase()];
  const call = (inner: Record<string, unknown>) => ({
    ...running,
    args: { ...running.args, args: inner },
  });
  const badge = (
    inner: Record<string, unknown>,
    ctx: Parameters<typeof toSubagentDisplayCall>[1],
  ) => toSubagentDisplayCall(call(inner), ctx).args as Record<string, unknown>;

  it("显式写了别的模型、没写 effort：显示该模型清单里的默认档（不套父会话的 high）", () => {
    const out = badge(
      { prompt: "p", model: "claude-sonnet-5-5", subagentType: "explore" },
      { parentModel: PARENT, defaultEffortOf },
    );
    expect(out).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    // 另一个模型就用它自己的默认档，证明不是写死 / 不是抄父会话
    expect(
      badge({ prompt: "p", model: "gemini-4-argon" }, { defaultEffortOf }),
    ).toMatchObject({ effort: "medium" });
  });

  it("没有父模型也能补默认档（显式模型不依赖父会话）", () => {
    expect(
      badge({ prompt: "p", model: "claude-sonnet-5-5" }, { defaultEffortOf }),
    ).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
  });

  it("effort=default / 空白也算没写：补默认档", () => {
    for (const effort of ["default", "  ", "DEFAULT"]) {
      expect(
        badge({ prompt: "p", model: "claude-sonnet-5-5", effort }, { defaultEffortOf }),
      ).toMatchObject({ effort: "high" });
    }
  });

  it("显式写了 effort：原样，不被默认档覆盖", () => {
    expect(
      badge(
        { prompt: "p", model: "claude-sonnet-5-5", effort: "xhigh" },
        { parentModel: PARENT, defaultEffortOf },
      ),
    ).toMatchObject({ effort: "xhigh" });
  });

  it("沿用父会话：父会话当前档优先；父会话参数里没有档位才退到父模型的默认档", () => {
    expect(
      badge({ prompt: "p" }, { parentModel: PARENT, defaultEffortOf }),
    ).toMatchObject({ model: "gemini-4-argon", effort: "high" });
    expect(
      badge(
        { prompt: "p" },
        { parentModel: { id: "gemini-4-argon" }, defaultEffortOf },
      ),
    ).toMatchObject({ model: "gemini-4-argon", effort: "medium" });
  });

  it("清单里没有 / 没标默认档 / 模型是 list：不硬造 effort", () => {
    const unknown = badge(
      { prompt: "p", model: "composer-2.5" },
      { parentModel: PARENT, defaultEffortOf },
    );
    expect(unknown.model).toBe("composer-2.5");
    expect(unknown).not.toHaveProperty("effort");
    expect(
      badge({ prompt: "p", model: "list" }, { defaultEffortOf }),
    ).not.toHaveProperty("effort");
  });

  it("沿用但不知道父模型：model 保持原样、也不去查默认档", () => {
    const seen: string[] = [];
    const out = badge(
      { prompt: "p", model: "inherit" },
      {
        defaultEffortOf: (id) => {
          seen.push(id);
          return "high";
        },
      },
    );
    expect(out).toEqual({ prompt: "p", model: "inherit" });
    expect(seen).toEqual([]);
  });

  it("resume：模型 / effort 取当初那个子代理的；resume 字段与其它入参保留", () => {
    const resumedChildOf = (id: string) =>
      id === "agent-1" ? { model: "claude-sonnet-5-5", effort: "high" } : undefined;
    const out = badge(
      { description: "d", prompt: "p", resume: " agent-1 " },
      { parentModel: PARENT, defaultEffortOf, resumedChildOf },
    );
    expect(out).toEqual({
      description: "d",
      prompt: "p",
      resume: " agent-1 ",
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("resume：登记表里查不到（应用重启后）/ 没有 resumedChildOf → 原样不改写，不硬造", () => {
    const raw = { prompt: "p", resume: "agent-gone" };
    expect(
      badge(raw, { parentModel: PARENT, defaultEffortOf, resumedChildOf: () => undefined }),
    ).toEqual(raw);
    expect(badge(raw, { parentModel: PARENT, defaultEffortOf })).toEqual(raw);
    expect(
      badge(raw, { resumedChildOf: () => ({}) }),
    ).toEqual(raw);
  });

  it("resume：只有 model 没有 effort 也只补 model，不抄父会话的档位", () => {
    const out = badge(
      { prompt: "p", resume: "a" },
      { parentModel: PARENT, resumedChildOf: () => ({ model: "composer-2.5" }) },
    );
    expect(out).toMatchObject({ model: "composer-2.5" });
    expect(out).not.toHaveProperty("effort");
  });

  it("只给查表函数、没有 parentModel 也会走改写（不是只在有父模型时才生效）", () => {
    const out = badge(
      { prompt: "p", resume: "a" },
      { resumedChildOf: () => ({ model: "m", effort: "low" }) },
    );
    expect(out).toMatchObject({ model: "m", effort: "low" });
  });

  it("只改展示副本：原消息一个字不动", () => {
    const msg = call({ prompt: "p", model: "claude-sonnet-5-5" });
    const snapshot = JSON.parse(JSON.stringify(msg));
    toSubagentDisplayCall(msg, { parentModel: PARENT, defaultEffortOf });
    expect(msg).toEqual(snapshot);
  });
});
