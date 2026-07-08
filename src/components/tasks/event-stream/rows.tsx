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
  Ban,
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
import { MarkdownLink } from "@/components/markdown-link";
import {
  ImageThumb,
  MarkdownImage,
  type PreviewImage,
} from "@/components/ui/image-preview";
import { isAskSuperseded } from "@/lib/ask-pending";
import { getIdeAnchorProps } from "@/lib/ide-open";
import { pathBasename } from "@/lib/path-utils";
import { useJumpIde } from "@/hooks/use-settings";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";
import { ACTION_LABEL_SHORT } from "@/lib/task-display";
import {
  JUMP_IDE_LABEL,
  type ActionType,
  type Task,
  type TaskEvent,
} from "@/lib/types";

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
 *
 * export 给 ask-user-dialog 复用（V0.6.29）：agent 问的问题常带 inline code / 列表、弹窗里也要渲染
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
    <ReactMarkdown
      // keepTrailingUnderscore：裸链接尾部 _ 被 GFM 剥掉的修正（V0.7.13、用户实测 404）
      remarkPlugins={[
        remarkGfm,
        remarkKeepTrailingUnderscore,
        remarkTrimAutolinkCjk,
      ]}
      components={{
        // 链接统一新窗口 / 系统浏览器打开、相对路径降级纯文本（V0.7.7）
        a: MarkdownLink,
        // markdown 内嵌图（![]()）走统一组件、点击站内看大图（V0.8.8）
        img: MarkdownImage,
      }}
    >
      {text}
    </ReactMarkdown>
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
const StreamingAssistantRowImpl = ({
  text,
  variant = "log",
}: {
  text: string;
  variant?: "log" | "chat";
}) => {
  // chat 形态：跟正式 AI 回复同样平铺、只多一个末尾闪烁光标（Cursor 风格、流式无容器）
  if (variant === "chat") {
    return (
      <div className="text-sm leading-relaxed">
        <MarkdownText text={text} />
        <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-foreground/60 align-middle" />
      </div>
    );
  }
  return (
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
};

// React.memo（V0.5.14）：text 频繁因 chunk 追加而变化、其他时候稳定
// memo 让 SSE 推 chunk 时只有 text 真的变了才重渲染、Virtuoso 内部 item 不无意义 reconcile
export const StreamingAssistantRow = memo(StreamingAssistantRowImpl);

interface ProcessEventRowProps {
  ev: TaskEvent;
  collapsed: boolean;
  summary: string;
  batch: ToolCallBatchItem[] | null;
  actionTag?: string;
  isToolCall: boolean;
  isThinking: boolean;
  onToggle: () => void;
}

/**
 * 过程事件行：thinking / tool_call / 普通 info 等低权重事件统一用 chat 的细行样式。
 * task(log) 会额外传 actionTag 保留归属，chat 不传，避免两种场景丢上下文。
 */
const ProcessEventRow = ({
  ev,
  collapsed,
  summary,
  batch,
  actionTag,
  isToolCall,
  isThinking,
  onToggle,
}: ProcessEventRowProps) => (
  <div className="group/proc">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-muted-foreground"
    >
      {collapsed ? (
        <ChevronRight className="size-3 shrink-0 opacity-50" />
      ) : (
        <ChevronDown className="size-3 shrink-0 opacity-50" />
      )}
      <span className="shrink-0 [&_svg]:size-3">
        {renderEventIcon(ev.kind)}
      </span>
      <span className="shrink-0 text-[11px]">{EVENT_LABEL[ev.kind]}</span>
      {actionTag && (
        <span className="shrink-0 rounded bg-muted/35 px-1 py-0.5 text-[10px] text-muted-foreground/80">
          {actionTag}
        </span>
      )}
      {collapsed && summary && (
        <span className="min-w-0 flex-1 truncate text-[11px] opacity-80">
          {summary}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] opacity-0 transition-opacity group-hover/proc:opacity-60">
        {formatTs(ev.ts)}
      </span>
    </button>
    {!collapsed && (
      <div className="ml-5 mt-1 border-l border-border/50 pl-3">
        {batch ? (
          <ul className="space-y-1">
            {batch.map((item) => (
              <li
                key={item.id}
                className="flex gap-2 break-all font-mono text-[11px] text-muted-foreground"
              >
                <span className="shrink-0 opacity-60">{formatTs(item.ts)}</span>
                {item.name && (
                  <span className="shrink-0 text-blue-500/80">{item.name}</span>
                )}
                <span className="min-w-0 flex-1">{item.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div
            className={cn(
              "wrap-break-word text-xs leading-relaxed text-muted-foreground",
              isToolCall && "break-all font-mono text-[11px]",
              isThinking && "italic",
            )}
          >
            {ev.text}
          </div>
        )}
      </div>
    )}
  </div>
);

const EventRowImpl = ({
  ev,
  taskId,
  task,
  variant = "log",
}: {
  ev: TaskEvent;
  taskId: string;
  task: Task;
  // log：task 模式事件流（卡片 + header + 折叠、信息密度优先）
  // chat：自由模式对话（V0.7.11、Cursor agent window 风格——AI 平铺 / 用户浅色块 / 过程细行）
  variant?: "log" | "chat";
}) => {
  // V0.6：用 actionId 查 action 类型、渲染 tag
  const action = ev.actionId
    ? task.actions.find((a) => a.id === ev.actionId)
    : undefined;
  const actionType: ActionType | undefined = action?.type;
  // 附件 chip 的跳转 IDE（设置页可切 Cursor / IDEA）
  const jumpIde = useJumpIde();
  const isUser = ev.kind === "user_reply";
  // ask_user_reply（弹窗答题）也可能带每题贴的图、meta.images 形状跟 user_reply 一致、
  // 共用同一套缩略图渲染（V0.8.3）。attachments 仍只 user_reply 有、不放宽。
  const hasImageMeta = isUser || ev.kind === "ask_user_reply";
  const isAssistant = ev.kind === "assistant_message";
  const isThinking = ev.kind === "thinking";
  const isToolCall = ev.kind === "tool_call";
  const isAwaitingAck = ev.meta?.awaitingAck === true;
  // log 形态降权只看默认折叠规则：过程类降噪，HITL / 失败 / 核心对话保持可见。
  const isDefaultVisible = DEFAULT_EXPANDED_KINDS.has(ev.kind) || isAwaitingAck;
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
    () => (hasImageMeta ? extractUserReplyImages(ev.meta) : []),
    [hasImageMeta, ev.meta],
  );
  const attachments = useMemo(
    () => (isUser ? extractUserReplyAttachments(ev.meta) : []),
    [isUser, ev.meta],
  );

  // 同组附图（lightbox 内左右切换整组）：缩略图 / 大图同源（uploads 静态文件）、title 带文件名 + 大小
  const imageGroup = useMemo<PreviewImage[]>(
    () =>
      images.map((img) => {
        const url = `/api/tasks/${taskId}/uploads/${pathBasename(img.absPath)}`;
        const sizeKb = img.bytes > 0 ? (img.bytes / 1024).toFixed(1) : "?";
        return {
          src: url,
          alt: img.filename ?? "附图",
          title: `${img.filename ?? pathBasename(img.absPath)} · ${sizeKb} KB`,
        };
      }),
    [images, taskId],
  );

  // 折叠状态：所有事件都可折叠、默认值由 DEFAULT_EXPANDED_KINDS 决定
  // - assistant_message / user_reply：默认展开（用户主要看的就是这俩）
  // - info 里带 meta.awaitingAck 的「Action 产出完成、等待 ack」里程碑事件也默认展开（用户要 ack）
  // - 其他：默认折叠（避免 thinking / tool_call 刷屏）
  // 组件内 state、用户手动切换后保持（不会被新事件刷掉）
  const defaultCollapsed = !isDefaultVisible;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const handleToggle = () => setCollapsed((c) => !c);

  // 折叠态文本：摘要、不让超长
  // 展开态：原样 ev.text；batch 模式下展开走 batch 列表
  // batch 模式 summary 追加「×N」后缀、用户一眼看到「这 N 条都是同种工具调用」
  const summary = batch ? `${summarize(ev.text)} ×${batchCount}` : summarize(ev.text);
  const processRow = (
    <ProcessEventRow
      ev={ev}
      collapsed={collapsed}
      summary={summary}
      batch={batch}
      actionTag={variant === "log" && actionType ? ACTION_LABEL_SHORT[actionType] : undefined}
      isToolCall={isToolCall}
      isThinking={isThinking}
      onToggle={handleToggle}
    />
  );

  // ---------- chat 形态（V0.7.11）----------
  // 设计参照 Cursor agent window：
  //   - AI 回复：无容器平铺、prose 直接落在页面底色上（对话主体、最大可读性）
  //   - 用户消息：浅色圆角块（带左侧细线、视觉「引用」感）、附件随块内显示
  //   - thinking / tool_call / info：单行细条目（小图标 + 摘要 + 时间）、点击展开、
  //     视觉权重压到最低——过程可查但不抢戏
  if (variant === "chat") {
    // AI 回复：平铺 prose、不进卡片
    if (isAssistant) {
      return (
        <div className="text-sm leading-relaxed">
          <MarkdownText text={ev.text} />
        </div>
      );
    }
    // 用户消息：浅色圆角块 + 附件
    if (isUser) {
      return (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5">
          <div className="text-sm leading-relaxed">
            <MarkdownText text={ev.text} />
          </div>
          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {imageGroup.map((g, i) => (
                <ImageThumb
                  key={images[i].absPath}
                  src={g.src}
                  alt={g.alt}
                  title={g.title}
                  group={imageGroup}
                  index={i}
                />
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {attachments.map((att) => (
                <a
                  key={att.absPath}
                  {...(getIdeAnchorProps(att.absPath, undefined, jumpIde) ?? { href: "" })}
                  className="flex max-w-full items-center gap-1 rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11px] no-underline hover:bg-muted"
                  title={`${att.absPath}\n点击在 ${JUMP_IDE_LABEL[jumpIde]} 中打开`}
                >
                  {att.isDir ? (
                    <Folder className="size-3 shrink-0 text-amber-500" />
                  ) : (
                    <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-mono">{pathBasename(att.absPath)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      );
    }
    // 过程行（thinking / tool_call / info / error…）：单行细条目、可展开
    return processRow;
  }

  if (!isDefaultVisible) {
    return processRow;
  }

  return (
    <div
      className={cn(
        "flex gap-2 rounded-md transition-colors",
        isDefaultVisible
          ? "border bg-card/40 p-2"
          : "border border-transparent bg-transparent px-1.5 py-1 text-muted-foreground/80 hover:bg-muted/20",
        isDefaultVisible && isUser && "border-primary/30 bg-primary/5",
      )}
    >
      <div
        className={cn(
          "mt-0.5 shrink-0",
          !isDefaultVisible && "opacity-60 [&_svg]:text-muted-foreground",
        )}
      >
        {renderEventIcon(ev.kind)}
      </div>
      {/* min-w-0 防止 flex 子项把容器撑爆、配合下面的 break-all / break-words 让长文本自动换行 */}
      <div className="min-w-0 flex-1 text-xs">
        {/* header：整行 hover、点击切换折叠 */}
        <button
          type="button"
          onClick={handleToggle}
          className={cn(
            "flex w-full cursor-pointer items-center text-left hover:opacity-80",
            isDefaultVisible ? "gap-2" : "gap-1.5",
          )}
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          )}
          {actionType && (
            <span
              className={cn(
                "rounded px-1 py-0.5 text-[10px] tracking-wide text-muted-foreground",
                isDefaultVisible ? "bg-muted/60" : "bg-muted/30",
              )}
            >
              {ACTION_LABEL_SHORT[actionType]}
            </span>
          )}
          <span className="text-muted-foreground/70 text-[10px]">
            {EVENT_LABEL[ev.kind]}
          </span>
          <span className="text-muted-foreground">{formatTs(ev.ts)}</span>
          {/* 折叠态把摘要也放 header 里、用户一眼看到这是啥事件、不用展开 */}
          {collapsed && summary && (
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isDefaultVisible
                  ? "text-muted-foreground/80"
                  : "text-muted-foreground/65",
              )}
            >
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
                isToolCall &&
                  "break-all font-mono text-[11px] text-muted-foreground/75",
                isThinking && "italic text-muted-foreground",
                !isToolCall &&
                  !isThinking &&
                  !useMarkdown &&
                  (isDefaultVisible ? "text-foreground" : "text-muted-foreground/75"),
              )}
            >
              {useMarkdown ? <MarkdownText text={ev.text} /> : ev.text}
            </div>
          ))}
        {/* user_reply / ask_user_reply 附图缩略图：折叠 / 展开都显示（图比文字更值得"始终见到"）
            点缩略图站内 lightbox 看大图、多图可左右切换（V0.8.8 统一 ImageThumb）*/}
        {hasImageMeta && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {imageGroup.map((g, i) => (
              <ImageThumb
                key={images[i].absPath}
                src={g.src}
                alt={g.alt}
                title={g.title}
                className="size-16"
                group={imageGroup}
                index={i}
              />
            ))}
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
              // att.absPath 一定是绝对路径（原生 picker 选出来的）、
              // getIdeAnchorProps 在绝对路径下永远不会返 null；?? 兜底纯为满足类型
              const anchor =
                getIdeAnchorProps(att.absPath, undefined, jumpIde) ?? { href: "" };
              return (
                <a
                  key={att.absPath}
                  {...anchor}
                  className="flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs no-underline hover:bg-muted"
                  title={`${att.absPath}${sizeStr ? ` · ${sizeStr}` : ""}\n点击在 ${JUMP_IDE_LABEL[jumpIde]} 中打开`}
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

  // 是否已被作废：断线重启 / 换 agent / 停止时后端补一条 info 标记（判定见 lib/ask-pending）。
  // 作废的 ask 没有真实 reply、显示中性失效态、别再误导成「正在等你答」。
  const superseded = useMemo(
    () => isAskSuperseded(task.events, askId),
    [task.events, askId],
  );

  // 问题数量：从 meta.questions 拿、没有就尝试用 text 行数估
  const questionsCount =
    ev.meta && Array.isArray(ev.meta.questions)
      ? (ev.meta.questions as unknown[]).length
      : ev.text.split("\n").filter((l) => l.trim().length > 0).length;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border-2 p-3",
        superseded
          ? "border-muted bg-muted/30"
          : answered
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {superseded ? (
          <Ban className="size-4 text-muted-foreground" />
        ) : answered ? (
          <CheckCircle2 className="size-4 text-emerald-500" />
        ) : (
          <Sparkles className="size-4 text-amber-500 animate-pulse" />
        )}
        <span
          className={cn("font-medium", superseded && "text-muted-foreground")}
        >
          {superseded
            ? "这组提问已失效"
            : answered
              ? `已回答 ${questionsCount} 个问题`
              : `AI 正在弹窗里问你 ${questionsCount} 个问题`}
        </span>
        <span className="text-muted-foreground/70">{formatTs(ev.ts)}</span>
      </div>

      {/* 未答（且未失效）：占位提示、不放交互、引导用户看弹窗 */}
      {!answered && !superseded && (
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
