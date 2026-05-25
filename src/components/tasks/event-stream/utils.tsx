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
export const EVENT_LABEL: Record<EventKind, string> = {
  info: "信息",
  thinking: "思考",
  phase_start: "阶段启动",
  phase_ack: "阶段确认",
  phase_failed: "阶段失败",
  tool_call: "工具调用",
  user_reply: "用户回复",
  assistant_message: "AI 回复",
  ask_user_request: "向你提问",
  ask_user_reply: "你的回答",
  error: "错误",
};

export const renderEventIcon = (kind: EventKind) => {
  switch (kind) {
    case "phase_start":
      return <Sparkles className="size-4 text-primary" />;
    case "phase_ack":
      return <CheckCircle2 className="size-4 text-emerald-500" />;
    case "phase_failed":
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
      last.phase === ev.phase
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

// 默认展开的事件类型：核心对话两端（AI 回复 + 用户回复）
// 其他都默认折叠（thinking / tool_call / info / error / phase_*）
// **注意**：这只决定「初始 collapsed state」、不决定可不可折叠——所有事件都可手动折叠 / 展开
export const DEFAULT_EXPANDED_KINDS: ReadonlySet<EventKind> = new Set([
  "assistant_message",
  "user_reply",
]);

// 折叠态摘要：取首行（按 \n 切）、再截到 max 字符
// 思考 / tool_call 这种动辄几百字的、折叠后只看一眼一行就够
export const summarize = (text: string, max = 80): string => {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max)}…`;
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
// 跟图片不同：这是用户在 FsPickerDialog 选的真实文件 / 目录、不上传内容、只存路径
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
