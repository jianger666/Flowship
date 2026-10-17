/**
 * `wait` 工具的展示逻辑（纯函数，客户端 / 服务端共用，不依赖 SDK）
 *
 * 工具本身在 `lib/server/flowship-tools.ts`、运行时在 `lib/server/session-wait.ts`；
 * 这里只放「事件流里怎么说它」：工具名常量、入参解析、一行摘要。
 * 工具名放这里而不是 flowship-tools，是因为 UI（状态行 / 工具块摘要）也要认它，
 * 而 flowship-tools 是服务端模块——与 `CURSOR_SUBAGENT_TOOL_NAME` 放在 `cursor-subagent-display.ts` 同理。
 */

import { formatDurationCoarse } from "@/lib/duration-display";

/** 工具名：事件流里按它认「等待」（状态行 / 摘要 / 跳过按钮）。改名要同步改 flowship-tools 的描述和提示词 */
export const WAIT_TOOL_NAME = "wait";

/**
 * 这个工具块是不是「正在睡的 wait」——工具块上挂「跳过等待」按钮的条件。
 *
 * 为什么按钮要放在工具块上：状态行只有 chat 形态才有，task 形态（action 容器）的事件流不渲染状态行，
 * 模型在 task 里 `wait 1800` 时用户没有别的出路、只能「停止」，那会连整个 action 一起杀掉。
 * 工具块两种形态都渲染，所以挂这里；状态行上的按钮保留（chat 里输入框上方更顺手）。
 * 结构类型而不是 `ToolBlock`：本文件是纯函数层，不反向依赖 tool-display。
 */
export const isSkippableWaitBlock = (block: {
  name: string;
  status: string;
}): boolean =>
  block.status === "running" && block.name.toLowerCase() === WAIT_TOOL_NAME;

export interface WaitToolArgs {
  seconds?: number;
  reason?: string;
}

/**
 * 解析事件里存成字符串的工具入参。不是对象 / 解析失败 → null；
 * 字段类型不对（seconds 不是有限正数、reason 不是字符串）就当没有，不抛。
 */
export const parseWaitToolArgs = (
  args: string | undefined,
): WaitToolArgs | null => {
  if (!args) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: WaitToolArgs = {};
  if (typeof o.seconds === "number" && Number.isFinite(o.seconds) && o.seconds > 0) {
    out.seconds = o.seconds;
  }
  if (typeof o.reason === "string" && o.reason.trim()) {
    out.reason = o.reason.trim();
  }
  return out;
};

/**
 * 一行摘要：`共 1m0s · 等 CI 跑完`。两项都没有 → 空串（调用方回落到通用摘要）。
 * 「共」是计划时长——实际等了多久由状态行的走字（已等 Ns）说。
 */
export const waitToolSummary = (args: string | undefined): string => {
  const parsed = parseWaitToolArgs(args);
  if (!parsed) return "";
  const bits: string[] = [];
  if (parsed.seconds !== undefined) {
    const planned = formatDurationCoarse(parsed.seconds * 1000);
    if (planned) bits.push(`共 ${planned}`);
  }
  if (parsed.reason) bits.push(parsed.reason);
  return bits.join(" · ");
};
