/**
 * 事件流的 utility + 类型 + 小函数
 *
 * 从 event-stream.tsx 抽出（V0.5.11）、避免主文件 890 行混杂主组件 + 子组件 + 小工具
 * 这里集中放：
 *   - 事件标签 / 图标 / 时间格式化
 *   - thinking 事件合并算法
 *   - meta.images / meta.attachments 类型解析（user_reply 附图 / 附路径）
 *   - 默认展开 / 折叠规则 + 摘要截断
 *
 * 主文件 event-stream.tsx 只关心 EventStream 主组件、子 Row 在 ./rows.tsx
 */

import {
  ArrowUpRight,
  Brain,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Sparkles,
  UserCircle2,
} from "lucide-react";

import type { EventKind, TaskEvent } from "@/lib/types";

// 中文 + 英文学名（团队沟通时英文锚点）
// V0.6：phase_* → action_*
export const EVENT_LABEL: Record<EventKind, string> = {
  info: "信息",
  thinking: "思考",
  action_start: "Action 启动",
  action_ack: "Action 确认",
  action_failed: "Action 失败",
  tool_call: "工具调用",
  user_reply: "用户回复",
  assistant_message: "AI 回复",
  ask_user_request: "向你提问",
  ask_user_reply: "你的回答",
  error: "错误",
};

export const renderEventIcon = (kind: EventKind) => {
  switch (kind) {
    case "action_start":
      return <Sparkles className="size-4 text-primary" />;
    case "action_ack":
      return <CheckCircle2 className="size-4 text-emerald-500" />;
    case "action_failed":
      return <CircleAlert className="size-4 text-destructive" />;
    case "tool_call":
      return <ArrowUpRight className="size-4 text-blue-500" />;
    case "thinking":
      return <Brain className="size-4 text-violet-500" />;
    case "user_reply":
      return <UserCircle2 className="size-4 text-foreground" />;
    case "ask_user_request":
      return <Sparkles className="size-4 text-amber-500" />;
    case "ask_user_reply":
      return <UserCircle2 className="size-4 text-emerald-500" />;
    case "error":
      return <CircleAlert className="size-4 text-destructive" />;
    default:
      return <CircleDashed className="size-4 text-muted-foreground" />;
  }
};

// HH:MM 简洁格式、事件流里只显示「这条事件几点几分」、不显示秒 / 日期
export const formatTs = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * 合并相邻 thinking 事件
 *
 * 背景：SDK 把一段连贯思考流式拆成多个 SDKThinkingMessage、每条 100~300 字。
 * 一条条独立渲染会出现「The user wants to」「function as a planning」「agent.」
 * 这种孤立片段、读不通。这里把同 phase、连续相邻的 thinking 合并成一条卡片。
 *
 * 不动 events.jsonl 落盘内容（多条原貌保留、便于复盘）、只在 UI 渲染前做这步合并。
 *
 * 合并策略：
 *   - text：按顺序换行拼接
 *   - durationMs：累加
 *   - id / ts：取第一条（保证 React key 稳定 + 时间标签是思考开始时间）
 */
export const mergeAdjacentThinking = (events: TaskEvent[]): TaskEvent[] => {
  const out: TaskEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (
      ev.kind === "thinking" &&
      last &&
      last.kind === "thinking" &&
      last.actionId === ev.actionId
    ) {
      const lastDur = Number(last.meta?.durationMs) || 0;
      const curDur = Number(ev.meta?.durationMs) || 0;
      out[out.length - 1] = {
        ...last,
        text: `${last.text}\n${ev.text}`,
        meta: {
          ...(last.meta ?? {}),
          durationMs: lastDur + curDur,
        },
      };
    } else {
      out.push(ev);
    }
  }
  return out;
};

// 默认展开的事件类型：核心对话、HITL 里程碑和失败信号。
// 这个集合也是 log 形态视觉降权的单一判断源：默认折叠的过程类才降权，信号事件必须保可见。
// **注意**：这只决定「初始 collapsed state」、不决定可不可折叠——所有事件都可手动折叠 / 展开
export const DEFAULT_EXPANDED_KINDS: ReadonlySet<EventKind> = new Set([
  "action_ack",
  "action_failed",
  "assistant_message",
  "ask_user_reply",
  "error",
  "user_reply",
]);

// 折叠态摘要：把所有换行 / 多空白压成单空格、再 200 字截
// 历史方案：取首行 + 80 字。问题：thinking / tool_call 首行常常很短
// （像「The user wants to」这种 setup 句）、80 字以内不加省略号、用户看不到
// 「下面还有内容」的暗示——视觉上就一句短话、像内容只有这点
// 现方案：合并所有行、给 truncate class 一段足够长的预览、容器宽度截到哪
// 算哪、超出自动 `...`、最后一道 200 字兜底（防极端 case 全 string 都进 DOM）
export const summarize = (text: string, max = 200): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
};

// ===========================================
// tool_call 合并（V0.5.13 事件流密度优化）
// ===========================================

// tool_call 合并后、保留每条子条信息、展开时一行一条
// id / ts 给 React key + 时间显示用、text 是原 ev.text、name 给展开时显示 tool 类型前缀
export interface ToolCallBatchItem {
  id: string;
  ts: number;
  text: string;
  name: string;
}

// 从 ev.meta 里安全取出 tool name（chat-runner / plan-runner 写入时塞了 meta.name）
const getToolName = (ev: TaskEvent): string =>
  typeof ev.meta?.name === "string" ? ev.meta.name : "";

/**
 * 合并相邻 tool_call（同 phase、不分 tool 名）
 *
 * V0.5.13 初版要求「同 tool name」连续才合并、但实测 AI 探索式调用经常 read /
 * grep / edit 交错（『read 1.tsx → grep "useMemo" → read 2.tsx → edit ...』）、
 * 严格相邻不触发、压不了几条。
 *
 * 用户拍板放宽到「同 phase 连续 tool_call」、不分 tool 名（Cursor IDE 风格）：
 *   - 折叠态：「工具调用 ×N」+ 最后一条 ev.text 摘要、给用户看「收尾在干嘛」
 *   - 展开态：每条子条带 `[tool name]` prefix、看得清谁是谁
 *   - meta.batch 保留所有子条 + 每条的 tool name、UI 展开时列表展示
 *   - meta.count 给折叠态显示「×N」
 *
 * 不动 events.jsonl 落盘内容（原貌保留、便于复盘）、只在 UI 渲染前合并。
 */
export const mergeAdjacentToolCall = (events: TaskEvent[]): TaskEvent[] => {
  const out: TaskEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (
      ev.kind === "tool_call" &&
      last &&
      last.kind === "tool_call" &&
      last.actionId === ev.actionId
    ) {
      const prevBatch = Array.isArray(last.meta?.batch)
        ? (last.meta.batch as ToolCallBatchItem[])
        : null;
      const curItem: ToolCallBatchItem = {
        id: ev.id,
        ts: ev.ts,
        text: ev.text,
        name: getToolName(ev),
      };
      const newBatch: ToolCallBatchItem[] = prevBatch
        ? [...prevBatch, curItem]
        : [
            {
              id: last.id,
              ts: last.ts,
              text: last.text,
              name: getToolName(last),
            },
            curItem,
          ];
      out[out.length - 1] = {
        ...last,
        // 显示最后一条作为代表文本（reflect 最新状态）
        text: ev.text,
        // ts 用最后一条、不然「时间」显示成第一条很奇怪
        ts: ev.ts,
        meta: {
          ...(last.meta ?? {}),
          batch: newBatch,
          count: newBatch.length,
        },
      };
    } else {
      out.push(ev);
    }
  }
  return out;
};

/**
 * user_reply 事件里 meta.images 的形状（跟 chat-reply route 写入保持一致）
 * 这里不抽到 types.ts：types.ts 把 meta 设成 Record<string, unknown>、就地校验更轻
 */
export interface UserReplyImageMeta {
  absPath: string;
  relPath: string;
  mimeType: string;
  bytes: number;
  filename?: string;
}

// user_reply 事件里 meta.attachments 的形状（chat-reply route 写）
// 跟图片不同：这是用户用原生 picker 选的真实文件 / 目录、不上传内容、只存路径
export interface UserReplyAttachmentMeta {
  absPath: string;
  isDir: boolean;
  bytes?: number;
}

// 把 meta.images 解成强类型数组、形状不对的丢掉、不抛错
// 现实场景：旧事件可能没 images / 字段缺失、不应该让 UI 炸
export const extractUserReplyImages = (
  meta: TaskEvent["meta"],
): UserReplyImageMeta[] => {
  if (!meta || !Array.isArray(meta.images)) return [];
  const out: UserReplyImageMeta[] = [];
  for (const item of meta.images as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.absPath !== "string" || typeof m.relPath !== "string") continue;
    out.push({
      absPath: m.absPath,
      relPath: m.relPath,
      mimeType: typeof m.mimeType === "string" ? m.mimeType : "image/png",
      bytes: typeof m.bytes === "number" ? m.bytes : 0,
      filename: typeof m.filename === "string" ? m.filename : undefined,
    });
  }
  return out;
};

// 把 meta.attachments 解成强类型数组、形状不对的丢掉
export const extractUserReplyAttachments = (
  meta: TaskEvent["meta"],
): UserReplyAttachmentMeta[] => {
  if (!meta || !Array.isArray(meta.attachments)) return [];
  const out: UserReplyAttachmentMeta[] = [];
  for (const item of meta.attachments as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.absPath !== "string") continue;
    out.push({
      absPath: m.absPath,
      isDir: typeof m.isDir === "boolean" ? m.isDir : false,
      bytes: typeof m.bytes === "number" ? m.bytes : undefined,
    });
  }
  return out;
};
