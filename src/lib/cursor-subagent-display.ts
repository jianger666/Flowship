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
 * 把 `subagent` 的 MCP 调用改写成 `task` 的展示形状；其它消息原样返回（同一引用）。
 *  - name → "task"，args → 真入参（扁平）
 *  - result → 纯文本（MCP 信封里的 `isError` 折成 status:"error"，卡片才会标红）
 */
export const toSubagentDisplayCall = <M extends ToolCallShape>(msg: M): M => {
  if (!isCursorSubagentCall(msg)) return msg;
  const outer = msg.args as Record<string, unknown>;
  const inner = isRecord(outer.args) ? outer.args : {};
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
