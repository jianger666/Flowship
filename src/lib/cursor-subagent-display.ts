/**
 * Cursor 路径 `subagent` 自定义工具 → 事件流里的「子代理」卡片（纯函数，不依赖 SDK）
 *
 * Cursor SDK 把 `local.customTools` 注册成合成 MCP server `custom-user-tools`，
 * 事件流里这类调用是 `name:"mcp"`、`args:{ providerIdentifier, toolName, args:{…真入参} }`，
 * 结果是 `{ status, value:{ content:[{ text:{ text } }], isError } }` 这层 MCP 信封
 *（2026-10-13 真实运行实测）。UI 的子代理卡片（`TaskSubagentBlock`、「子代理工作中」状态行、
 * model / effort 徽标）按工具名 `task` + 扁平入参渲染——pi 的 `task` 和 Cursor 原生 `task` 都是这形状。
 *
 * 所以在落事件前把 `subagent` 这一类调用**改写成同形的 `task`**：卡片、状态行、徽标一处都不用改，
 * 结果也拆掉 MCP 信封（否则卡片里显示的是 `{"content":[{"text":{"text":…`的 JSON 转义串）。
 * 只改展示用的副本，不动 SDK 原消息。
 */

import { isDefaultThinkingValue } from "@/lib/custom-effort";
import { currentEffortValue, isInheritModelArg } from "@/lib/subagent-spec";
import { WAIT_TOOL_NAME } from "@/lib/wait-display";

/** Cursor 侧子代理工具名（模型通过 MCP 调它；与 pi 的 `task` 同参） */
export const CURSOR_SUBAGENT_TOOL_NAME = "subagent";

/** SDK 给 `local.customTools` 起的合成 MCP server 名（与 flowship-tools 的同名常量由测试守护） */
export const CURSOR_CUSTOM_TOOLS_SERVER = "custom-user-tools";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** SDK 消息里的 tool_call 的最小形状（只读这几个字段） */
export interface ToolCallShape {
  name?: unknown;
  args?: unknown;
  result?: unknown;
  status?: unknown;
}

/** 是不是我们的 `subagent` 工具调用（MCP 外壳：name=mcp + providerIdentifier + toolName） */
export const isCursorSubagentCall = (msg: ToolCallShape): boolean => {
  if (msg.name !== "mcp") return false;
  if (!isRecord(msg.args)) return false;
  return (
    msg.args.providerIdentifier === CURSOR_CUSTOM_TOOLS_SERVER &&
    msg.args.toolName === CURSOR_SUBAGENT_TOOL_NAME
  );
};

/**
 * 拆 MCP 信封取文本：`value.content[]` 的元素可能是 `{ text: "…" }` 或 `{ text: { text: "…" } }`
 *（SDK 的实际形状是后者）。取不到返回 null，调用方保留原结果。
 */
export const unwrapMcpText = (
  result: unknown,
): { text: string; isError: boolean } | null => {
  if (typeof result === "string") return { text: result, isError: false };
  if (!isRecord(result)) return null;
  const value = isRecord(result.value) ? result.value : null;
  const content = value?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const t = item.text;
    if (typeof t === "string") parts.push(t);
    else if (isRecord(t) && typeof t.text === "string") parts.push(t.text);
  }
  return { text: parts.join("\n"), isError: value?.isError === true };
};

/**
 * 取 `subagent` MCP 调用里模型传的**原始入参**（完整任务书 / 摘要）。
 * 不是 `isCursorSubagentCall` 的调用 → null。入参缺失 / 类型不对时对应字段为 undefined。
 *
 * 给子代理过程记录配对用（`subagent-transcript` 的 `noteSubagentToolCall`）：
 * 落事件的 args 会被截到 2000 字，配对要拿完整任务书，所以要在改写 / 截断之前取。
 */
export const extractSubagentCallArgs = (
  msg: ToolCallShape,
): { prompt?: string; description?: string } | null => {
  if (!isCursorSubagentCall(msg)) return null;
  const outer = msg.args as Record<string, unknown>;
  const inner = isRecord(outer.args) ? outer.args : {};
  return {
    ...(typeof inner.prompt === "string" ? { prompt: inner.prompt } : {}),
    ...(typeof inner.description === "string"
      ? { description: inner.description }
      : {}),
  };
};

/** 改写展示参数时需要的父会话信息（不传 = 徽标保持模型传的原始值） */
export interface SubagentDisplayContext {
  /** 父会话当前模型（含思考档参数）；子代理「沿用」时就是它 */
  parentModel?: { id: string; params?: Array<{ id: string; value: string }> };
}

/**
 * 卡片徽标要显示**实际生效**的模型 / 思考档，而不是模型随手写的 `inherit`：
 *  - model 缺省 / inherit → 父会话模型 id；
 *  - 模型沿用、effort 又没填 → 父会话当前的思考档（子代理沿用它，见 resolveSubagentModel）；
 *  - 显式填了别的模型 / effort → 原样（那就是实际值）；
 *  - resume 调用不改写：接着的是之前那个子代理，它当初用什么模型这里不知道，不硬造。
 * 只改展示副本，工具真实入参（模型看到的、SDK 收到的）一个字不动。
 */
const withEffectiveModelBadges = (
  inner: Record<string, unknown>,
  parent: NonNullable<SubagentDisplayContext["parentModel"]>,
): Record<string, unknown> => {
  if (typeof inner.resume === "string" && inner.resume.trim()) return inner;
  const out: Record<string, unknown> = { ...inner };
  const inherits =
    isInheritModelArg(inner.model) ||
    (typeof inner.model === "string" &&
      inner.model.trim().toLowerCase() === parent.id.toLowerCase());
  if (isInheritModelArg(inner.model)) out.model = parent.id;
  const effortEmpty =
    typeof inner.effort !== "string" ||
    !inner.effort.trim() ||
    isDefaultThinkingValue(inner.effort);
  if (inherits && effortEmpty) {
    const effort = currentEffortValue(parent.params);
    if (effort) out.effort = effort;
  }
  return out;
};

/** 是不是我们的 `wait` 工具调用（Cursor 的 MCP 外壳；pi 里它本来就叫 `wait`、不需要改写） */
export const isCursorWaitCall = (msg: ToolCallShape): boolean => {
  if (msg.name !== "mcp") return false;
  if (!isRecord(msg.args)) return false;
  return (
    msg.args.providerIdentifier === CURSOR_CUSTOM_TOOLS_SERVER &&
    msg.args.toolName === WAIT_TOOL_NAME
  );
};

/**
 * 把 `wait` 的 MCP 调用改写成扁平的 `wait`（name → "wait"，args → 真入参 `{seconds, reason}`，
 * result 拆掉 MCP 信封）；其它消息原样返回（同一引用）。
 *
 * 为什么要改：UI（状态行「等待中」+ 跳过按钮、工具块摘要）按工具名 `wait` + 扁平入参认它，
 * pi 路径本来就是这个形状；不改的话 Cursor 下就是一个 `mcp`、摘要里是整段外壳 JSON。
 * 只改展示用的副本，不动 SDK 原消息。
 */
export const toWaitDisplayCall = <M extends ToolCallShape>(msg: M): M => {
  if (!isCursorWaitCall(msg)) return msg;
  const outer = msg.args as Record<string, unknown>;
  const inner = isRecord(outer.args) ? outer.args : {};
  const next: Record<string, unknown> = {
    ...(msg as Record<string, unknown>),
    name: WAIT_TOOL_NAME,
    args: inner,
  };
  if (msg.result !== undefined) {
    const unwrapped = unwrapMcpText(msg.result);
    if (unwrapped) {
      next.result = unwrapped.text;
      if (unwrapped.isError) next.status = "error";
    }
  }
  return next as M;
};

/**
 * 把 `subagent` 的 MCP 调用改写成 `task` 的展示形状；其它消息原样返回（同一引用）。
 *  - name → "task"，args → 真入参（扁平；传了 ctx.parentModel 时徽标字段换成实际生效值）
 *  - result → 纯文本（MCP 信封里的 `isError` 折成 status:"error"，卡片才会标红）
 */
export const toSubagentDisplayCall = <M extends ToolCallShape>(
  msg: M,
  ctx?: SubagentDisplayContext,
): M => {
  if (!isCursorSubagentCall(msg)) return msg;
  const outer = msg.args as Record<string, unknown>;
  const rawInner = isRecord(outer.args) ? outer.args : {};
  const inner = ctx?.parentModel
    ? withEffectiveModelBadges(rawInner, ctx.parentModel)
    : rawInner;
  const next: Record<string, unknown> = {
    ...(msg as Record<string, unknown>),
    name: "task",
    args: inner,
  };
  if (msg.result !== undefined) {
    const unwrapped = unwrapMcpText(msg.result);
    if (unwrapped) {
      next.result = unwrapped.text;
      if (unwrapped.isError) next.status = "error";
    }
  }
  return next as M;
};
