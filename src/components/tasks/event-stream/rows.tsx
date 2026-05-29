"use client";

/**
 * 事件流子组件：Row 系列 + Markdown 渲染
 *
 * 从 event-stream.tsx 抽出（V0.5.11）：
 *   - MarkdownText：assistant_message / user_reply 用 markdown 渲染
 *   - StreamingAssistantRow：chat 模式流式 placeholder「AI 回复中...」
 *   - EventRow：单条事件渲染（含图标 / phase 标签 / 时间 / 折叠 / 附图 / 附路径）
 *   - AskUserRequestRow：ask_user 事件历史回放卡（V0.3.2 起交互移到 modal、这里只放历史）
 */

import { memo, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { buildCursorLink, pathBasename } from "@/lib/path-utils";
import { ACTION_LABEL_SHORT } from "@/lib/task-display";
import type { ActionType, Task, TaskEvent } from "@/lib/types";

import {
  DEFAULT_EXPANDED_KINDS,
  EVENT_LABEL,
  extractUserReplyAttachments,
  extractUserReplyImages,
  formatTs,
  renderEventIcon,
  summarize,
  type ToolCallBatchItem,
} from "./utils";

/**
 * Markdown 渲染组件：用于 assistant_message / user_reply / 流式 placeholder
 *
 * 为什么用 markdown：AI 输出常含粗体 / 列表 / inline code / 标题 / 表格、
 *   纯文本渲染会出现 `**xxx**` 字面量、易读性差（用户实测反馈）。
 *
 * 实现要点：
 *   - prose 类来自 @tailwindcss/typography、dark:prose-invert 让暗色背景下也能读
 *   - max-w-none：取消 prose 自带的 65ch 宽度限制（聊天窗口已经够窄了）
 *   - prose-sm：缩到聊天卡片的字号档（默认 prose 偏大）
 *   - prose-p:my-1 等：把 prose 默认的大段 margin 拉小、贴近聊天气泡密度
 *   - remark-gfm：支持表格 / 删除线 / 任务清单等扩展语法
 *   - 流式拼接的 markdown 可能不完整（比如开头有 ** 但还没闭合）、react-markdown 容错够好、不会炸
 */
export const MarkdownText = ({ text }: { text: string }) => (
  <div
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none wrap-break-word",
      // 聊天密度：默认 prose 段间距太松、缩紧
      "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
      // 标题：常见 AI 用 ## / ### 起标题、prose 默认 mt 太大、缩
      "prose-headings:mt-2 prose-headings:mb-1",
      // inline code：默认会加引号 + 灰底、去掉引号、保留底色
      "prose-code:before:content-none prose-code:after:content-none",
      // pre 代码块：暗色调对齐 muted 背景、文字色继承 foreground
      "prose-pre:bg-muted prose-pre:text-foreground prose-pre:my-2",
    )}
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
);

/**
 * 流式 placeholder 卡片：复用 assistant_message 的视觉样式
 *
 * 出现条件：chat-view 收到 SDK assistant chunk 推 streamingText 非空
 * 消失条件：收到正式 assistant_message 事件、chat-view setStreamingText("")
 *
 * 视觉提示：左侧图标 + 标签「AI 回复中...」+ 末尾闪烁光标、明显区分「流式中」vs「已完成」
 */
const StreamingAssistantRowImpl = ({ text }: { text: string }) => (
  <div className="flex gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
    <div className="mt-0.5 shrink-0">
      <Sparkles className="size-4 animate-pulse text-emerald-500" />
    </div>
    <div className="min-w-0 flex-1 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground/70 text-[10px]">
          AI 回复中…
        </span>
      </div>
      <div className="mt-1 leading-relaxed wrap-break-word text-foreground">
        {/* 流式过程中也按 markdown 渲染、用户看到的就是最终样式、不会出现 **xx** 字面量 */}
        <MarkdownText text={text} />
        {/* 末尾闪烁光标、强提示「正在打字」 */}
        <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-emerald-500/70 align-middle" />
      </div>
    </div>
  </div>
);

// React.memo（V0.5.14）：text 频繁因 chunk 追加而变化、其他时候稳定
// memo 让 SSE 推 chunk 时只有 text 真的变了才重渲染、Virtuoso 内部 item 不无意义 reconcile
export const StreamingAssistantRow = memo(StreamingAssistantRowImpl);

const EventRowImpl = ({
  ev,
  taskId,
  task,
}: {
  ev: TaskEvent;
  taskId: string;
  task: Task;
}) => {
  // V0.6：用 actionId 查 action 类型、渲染 tag
  const action = ev.actionId
    ? task.actions.find((a) => a.id === ev.actionId)
    : undefined;
  const actionType: ActionType | undefined = action?.type;
  const isUser = ev.kind === "user_reply";
  const isAssistant = ev.kind === "assistant_message";
  const isThinking = ev.kind === "thinking";
  const isToolCall = ev.kind === "tool_call";
  // 是否用 markdown 渲染：AI 回复 / 用户回复（用户也可能贴 markdown 进来）
  // thinking / tool_call / info / error 一律纯文本（结构化输出 / 错误消息、markdown 反而碍事）
  const useMarkdown = isAssistant || isUser;

  // tool_call 合并卡判定（V0.5.13）：mergeAdjacentToolCall 给同 phase + 同 tool name
  // 连续 ≥2 条合一时塞 meta.batch + meta.count、UI 折叠 / 展开走 batch 分支
  const batch = useMemo<ToolCallBatchItem[] | null>(
    () => (Array.isArray(ev.meta?.batch) ? (ev.meta.batch as ToolCallBatchItem[]) : null),
    [ev.meta],
  );
  const batchCount = batch?.length ?? 0;

  // user_reply 才解 meta.images / meta.attachments、其他 kind 一律空
  // 避免每行都跑一遍 extract
  const images = useMemo(
    () => (isUser ? extractUserReplyImages(ev.meta) : []),
    [isUser, ev.meta],
  );
  const attachments = useMemo(
    () => (isUser ? extractUserReplyAttachments(ev.meta) : []),
    [isUser, ev.meta],
  );

  // 折叠状态：所有事件都可折叠、默认值由 DEFAULT_EXPANDED_KINDS 决定
  // - assistant_message / user_reply：默认展开（用户主要看的就是这俩）
  // - info 里带 meta.awaitingAck 的「Action 产出完成、等待 ack」里程碑事件也默认展开（用户要 ack）
  // - 其他：默认折叠（避免 thinking / tool_call 刷屏）
  // 组件内 state、用户手动切换后保持（不会被新事件刷掉）
  const isAwaitingAck = ev.meta?.awaitingAck === true;
  const defaultCollapsed = !DEFAULT_EXPANDED_KINDS.has(ev.kind) && !isAwaitingAck;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const handleToggle = () => setCollapsed((c) => !c);

  // 折叠态文本：摘要、不让超长
  // 展开态：原样 ev.text；batch 模式下展开走 batch 列表
  // batch 模式 summary 追加「×N」后缀、用户一眼看到「这 N 条都是同种工具调用」
  const summary = batch ? `${summarize(ev.text)} ×${batchCount}` : summarize(ev.text);

  return (
    <div
      className={cn(
        "flex gap-2 rounded-md border bg-card/40 p-2",
        isUser && "border-primary/30 bg-primary/5",
        isThinking && "border-violet-500/20 bg-violet-500/5",
        isToolCall && "border-blue-500/20 bg-blue-500/5",
      )}
    >
      <div className="mt-0.5 shrink-0">{renderEventIcon(ev.kind)}</div>
      {/* min-w-0 防止 flex 子项把容器撑爆、配合下面的 break-all / break-words 让长文本自动换行 */}
      <div className="min-w-0 flex-1 text-xs">
        {/* header：整行 hover、点击切换折叠 */}
        <button
          type="button"
          onClick={handleToggle}
          className="flex w-full cursor-pointer items-center gap-2 text-left hover:opacity-80"
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          )}
          {actionType && (
            <span className="rounded bg-muted/60 px-1 py-0.5 text-[10px] tracking-wide text-muted-foreground">
              {ACTION_LABEL_SHORT[actionType]}
            </span>
          )}
          <span className="text-muted-foreground/70 text-[10px]">
            {EVENT_LABEL[ev.kind]}
          </span>
          <span className="text-muted-foreground">{formatTs(ev.ts)}</span>
          {/* 折叠态把摘要也放 header 里、用户一眼看到这是啥事件、不用展开 */}
          {collapsed && summary && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
              {summary}
            </span>
          )}
        </button>
        {/* 展开态才渲染 body */}
        {!collapsed &&
          (batch ? (
            // tool_call 合并卡展开：列表展示每条子 tool_call 的时间 + tool 名 + 文案
            // 一行一条、紧凑、所有路径 break-all 防溢出
            // V0.5.13.1 合并放宽到「不分 tool 名」、给每条加 `[name]` prefix 看得清谁是谁
            <ul className="mt-1 space-y-1">
              {batch.map((item) => (
                <li
                  key={item.id}
                  className="flex gap-2 break-all font-mono text-[11px] text-foreground/80"
                >
                  <span className="shrink-0 text-muted-foreground">
                    {formatTs(item.ts)}
                  </span>
                  {item.name && (
                    <span className="shrink-0 rounded bg-blue-500/10 px-1 text-blue-600 dark:text-blue-400">
                      {item.name}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div
              className={cn(
                "mt-1 leading-relaxed wrap-break-word",
                // tool_call 文本里常含长 JSON 路径、break-all 比 break-words 更强（任意字符断行）
                isToolCall && "break-all font-mono text-[11px] text-foreground/80",
                isThinking && "italic text-muted-foreground",
                !isToolCall && !isThinking && !useMarkdown && "text-foreground",
              )}
            >
              {useMarkdown ? <MarkdownText text={ev.text} /> : ev.text}
            </div>
          ))}
        {/* user_reply 附图缩略图：折叠 / 展开都显示（图比文字更值得"始终见到"）
            点缩略图新 tab 打开看大图、不内嵌 lightbox（保持轻量、浏览器自带的图片查看够用）*/}
        {isUser && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => {
              const url = `/api/tasks/${taskId}/uploads/${pathBasename(img.absPath)}`;
              const sizeKb = img.bytes > 0 ? (img.bytes / 1024).toFixed(1) : "?";
              return (
                <a
                  key={img.absPath}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block size-16 overflow-hidden rounded-md border bg-card transition-opacity hover:opacity-80"
                  title={`${img.filename ?? pathBasename(img.absPath)} · ${sizeKb} KB`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={img.filename ?? "附图"}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </a>
              );
            })}
          </div>
        )}
        {/* user_reply 附路径 chips：跟图片一样、始终显示（不受折叠影响）
            点击在 Cursor 中打开（cursor:// deep link、跟 artifact-panel 同款）*/}
        {isUser && attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {attachments.map((att) => {
              const sizeStr =
                att.bytes != null
                  ? att.bytes < 1024
                    ? `${att.bytes} B`
                    : att.bytes < 1024 * 1024
                      ? `${(att.bytes / 1024).toFixed(1)} KB`
                      : `${(att.bytes / 1024 / 1024).toFixed(1)} MB`
                  : "";
              // att.absPath 一定是绝对路径（FsPickerDialog 选出来的）、
              // buildCursorLink 在绝对路径下永远不会返 null；?? "" 兜底纯为满足 href 类型
              const href = buildCursorLink(att.absPath) ?? "";
              return (
                <a
                  key={att.absPath}
                  href={href}
                  className="flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs no-underline hover:bg-muted"
                  title={`${att.absPath}${sizeStr ? ` · ${sizeStr}` : ""}\n点击在 Cursor 中打开`}
                >
                  {att.isDir ? (
                    <Folder className="size-3 shrink-0 text-amber-500" />
                  ) : (
                    <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-mono text-[11px] text-sky-600 dark:text-sky-400">
                    {pathBasename(att.absPath)}
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// React.memo（V0.5.14）：props 是 ev / taskId 这种引用稳定值、Virtuoso 滚动时
// 已渲染 item 不重渲染、SSE 推新 chunk 时其他 item props 不变也跳过 reconcile
export const EventRow = memo(EventRowImpl);

// ===========================================
// AskUserRequestRow（V0.3.2 简化版：纯回放卡片）
// ===========================================
//
// V0.3.2 改造（用户拍板）：交互移到 AskUserDialog modal、事件流里只做「历史回放」
//
// 渲染规则：
//   - 没找到 reply：显示「AI 在弹窗里问你 N 个问题、请到弹窗答」（简洁占位、不放交互）
//   - 找到 reply：显示拼接好的 Q&A 文本（reply 事件的 text 就是 markdown 拼好的）
//
// 这样做的好处：
//   - 不会被 thinking / tool_call 等过程事件淹没（真正的交互在 modal、屏幕中央可见）
//   - 历史回放清晰、所有 Q1/Q2 一目了然
//   - 取消「inline 一次只能答一个」的破碎感

interface AskUserRequestRowProps {
  ev: TaskEvent;
  task: Task;
}

const AskUserRequestRowImpl = ({ ev, task }: AskUserRequestRowProps) => {
  const askId =
    ev.meta && typeof ev.meta.askId === "string" ? ev.meta.askId : "";

  // 找对应 reply 事件
  const replyEvent = useMemo(
    () =>
      task.events.find(
        (e) =>
          e.kind === "ask_user_reply" &&
          typeof e.meta?.askId === "string" &&
          e.meta.askId === askId,
      ),
    [task.events, askId],
  );
  const answered = !!replyEvent;

  // 问题数量：从 meta.questions 拿、没有就尝试用 text 行数估
  const questionsCount =
    ev.meta && Array.isArray(ev.meta.questions)
      ? (ev.meta.questions as unknown[]).length
      : ev.text.split("\n").filter((l) => l.trim().length > 0).length;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border-2 p-3",
        answered
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {answered ? (
          <CheckCircle2 className="size-4 text-emerald-500" />
        ) : (
          <Sparkles className="size-4 text-amber-500 animate-pulse" />
        )}
        <span className="font-medium">
          {answered
            ? `已回答 ${questionsCount} 个问题`
            : `AI 正在弹窗里问你 ${questionsCount} 个问题`}
        </span>
        <span className="text-muted-foreground/70">{formatTs(ev.ts)}</span>
      </div>

      {/* 未答：占位提示、不放交互、引导用户看弹窗 */}
      {!answered && (
        <div className="rounded-md border border-dashed bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          请在屏幕中央的弹窗里答完所有问题、答完后这里会显示完整 Q&A 历史
        </div>
      )}

      {/* 已答：展示拼接好的 Q&A markdown */}
      {answered && replyEvent && (
        <div className="rounded-md border bg-card/60 px-3 py-2 text-sm">
          <MarkdownText text={replyEvent.text} />
        </div>
      )}
    </div>
  );
};

// React.memo（V0.5.14）：props 是 ev / task、ev 稳定 + task 父组件 memo 过的引用
// 跟 EventRow 同理、SSE 频繁推 chunk 时 ask 卡片不无意义重渲染
export const AskUserRequestRow = memo(AskUserRequestRowImpl);
