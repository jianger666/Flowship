"use client";

/**
 * 右侧事件流 + HITL 输入区
 *
 * 这块的关键交互区分：
 * - 事件流（上半部）：agent 输出 + phase 边界 + tool call、按时间排
 * - HITL 输入框（底部）：仅当 task.status === "awaiting_user" 时可输入
 *   → 这正好对应 user 拍的「chat 是 HITL 闸门、不是 prompt window」
 *
 * V1 骨架：输入只是 mock、点了发送会落一条 user_reply 事件、不真正触发 agent
 * V2 接 SDK 后输入会推 server、agent 阻塞解除、继续跑
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  File as FileIcon,
  Folder,
  FolderOpen,
  Paperclip,
  Send,
  Sparkles,
  UserCircle2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { FsPickerDialog } from "@/components/ui/fs-picker-dialog";
import { PHASE_LABEL_SHORT } from "@/lib/task-display";
import type { ChatReplyImage } from "@/lib/task-store";
import type { EventKind, Task, TaskEvent } from "@/lib/types";

// 支持的图片 mime 白名单（跟后端 task-fs.ts 的 ALLOWED_IMAGE_MIME 保持一致）
// 用户粘 / 拖 / 选了别的 mime 直接 toast 拒、避免后端 400
const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

// 单图上限 10 MB（跟后端 task-fs.ts 保持一致、前端先拦防止白白上传）
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_REPLY = 6;

/**
 * 输入框待发送的图片附件、UI 内部状态、发送后清空。
 * - id: React key、本地随机
 * - dataUrl: 完整 data: URL（含 mime 前缀）、给 <img> src 预览用
 * - data:    纯 base64（不带前缀）、发送时塞 POST body
 */
interface PendingImage {
  id: string;
  file: File;
  dataUrl: string;
  data: string;
  mimeType: string;
}

// FileReader.readAsDataURL Promise 化、解出 dataUrl + 纯 base64
const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("读文件失败"));
    reader.readAsDataURL(file);
  });

// 从 dataUrl 切出纯 base64（"data:image/png;base64,xxx" → "xxx"）
const stripDataUrlPrefix = (dataUrl: string): string => {
  const idx = dataUrl.indexOf("base64,");
  return idx >= 0 ? dataUrl.slice(idx + "base64,".length) : dataUrl;
};

const newPendingId = (): string =>
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// 中文 + 英文学名（团队沟通时英文锚点）
const EVENT_LABEL: Record<EventKind, string> = {
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


const renderEventIcon = (kind: EventKind) => {
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

const formatTs = (ts: number): string => {
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
const mergeAdjacentThinking = (events: TaskEvent[]): TaskEvent[] => {
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

interface Props {
  task: Task;
  // 流式 placeholder：chat-view 维护、SDK chunk 推到这里、收到正式 assistant_message 事件清空
  // 非空时在事件流末尾渲染一个「AI 回复中...」卡片、内容随 chunk 拼接增长（打字机效果）
  // V1 仅 chat 模式用、plan 模式不传
  streamingText?: string;
  // attachments：附加的文件 / 目录绝对路径数组、后端 wait_for_user return 会拼成
  // [ATTACHED_PATHS] 段给 agent、agent 用 read_file 自己读
  onUserReply?: (
    text: string,
    images?: ChatReplyImage[],
    attachments?: string[],
  ) => void;
  // V0.2 plan workflow 模式下传 true、不渲染底部「自由回复」输入框
  // 因为 plan 模式的 HITL 是 phase ack（通过 / 补意见再跑）、不是 free-form 聊天
  // ack 按钮由父组件渲染在顶部 / 详情区其他位置
  hideReplyComposer?: boolean;
  // V0.4：输入框可用判定下放给父组件
  // - 不传：用旧行为（task.status === "awaiting_user" 才可用、给 plan 用）
  // - 传：父组件决定（chat-view 传：draft / completed / failed / awaiting_user 都可用、running / starting 不可用）
  // 命名上跟 awaiting_user 解耦——父组件知道更多状态（如 starting）、UI 该不该可用归它判
  canReply?: boolean;
  // V0.4：禁用时底部的状态文案（chat 自由化下、文案需要随 task.status / starting 动态变）
  // 不传：用旧 plan 文案「agent 在等待你回复时输入框才会激活」
  disabledHint?: string;
}

// chat 单次最多附几条路径（防滥用 / context 爆）
// 跟图片上限保持一致：6 个、但路径不算大、其实可以高点；先 10 平衡
const MAX_ATTACHMENTS_PER_REPLY = 10;

// 取绝对路径末尾段做显示用
const pathBasename = (p: string): string => {
  const cleaned = p.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) || cleaned : cleaned;
};

// 用 React.memo 包裹：详情页输入交互（如「跟 AI 聊聊」对话框输入）触发 page 重渲染时、
// 只要 task / streamingText 引用没变就跳过本组件、避免几百条 events 的子树参与 reconcile
// 这是用户实测踩过的性能坑（输入卡顿 / [Violation] message handler took XXXms）
const EventStreamImpl = ({
  task,
  streamingText,
  onUserReply,
  hideReplyComposer,
  canReply,
  disabledHint,
}: Props) => {
  // 输入草稿、发送后清空
  const [draft, setDraft] = useState("");
  // 待发送的图片附件列表（粘贴 / 拖拽 / 选文件三种途径添进来）
  // 发送成功后清空；发送中保留、失败可重试
  const [attachedImages, setAttachedImages] = useState<PendingImage[]>([]);
  // 拖拽状态：drag over 时整片输入区高亮、给用户视觉反馈
  const [isDragging, setIsDragging] = useState(false);
  // 隐藏 <input type="file">、点击附图按钮触发它
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 文件 / 目录路径选择器开关（点「附文件」按钮触发）
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  // 待发送的文件 / 目录绝对路径列表、跟 attachedImages 平行的 state
  // 发送后清空；元素本身就是绝对路径字符串（不像 images 是 base64 blob）
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  // 滚动容器：智能置底用
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 输入框：用于「awaiting_user 时自动聚焦」、避免用户每次都得手动点输入框
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 智能置底：仅当用户「贴在底部」时新事件才把视图滚到底
  // 用户主动往上滚就不再强制下拉、滚回底部时自动重新激活
  // 用 ref 而不是 state、避免每次滚动都触发 re-render
  const stickToBottomRef = useRef(true);

  // 滚动事件：判断是否贴底（< 50px 就视为贴底、宽容滚动条像素差）
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 50;
  };

  // 渲染前合并连续 thinking、避免「思考被切碎」的视觉断裂
  const renderEvents = useMemo(
    () => mergeAdjacentThinking(task.events),
    [task.events],
  );

  // 新事件 / artifact 触发的 events.length 变化：贴底时才滚到底
  // 注意 dep 用 renderEvents.length 而不是 task.events.length、合并后才是 UI 真实卡片数
  // streamingText.length 也加入 dep：流式打字时贴底跟随、不然字一直加但视图不动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [renderEvents.length, streamingText?.length]);

  // V0.4：输入框可用 = 父组件传 canReply（chat-view 自由化用）
  // 父组件没传时回退老行为 status === "awaiting_user"（plan 模式用、不影响）
  // 重命名内部变量为 canCompose、避免「awaiting_user」语义跟可用判定耦合
  const canCompose = canReply ?? task.status === "awaiting_user";

  // 输入框自动聚焦判定：跟 canCompose 同款（之前用 isAwaitingUser、现在统一走 canCompose）
  // - chat 自由化下、agent 起手就 wait_for_user、进 ChatView 时 status 大概率立刻变 awaiting_user
  //   → canCompose 变 true 触发 focus
  const isAwaitingUser = canCompose;

  // 自动聚焦：进入「可输入」时把光标放进输入框、用户立刻可以打字
  // - 解决以前的痛点：agent 回完话、用户得鼠标点输入框才能输入
  // - 仅在 status「变成」awaiting_user 的边缘触发、避免用户主动点别处后被强抢焦点
  // - autoFocus 属性不行（只 mount 时生效）、必须 useEffect 跟着 status 变
  useEffect(() => {
    if (isAwaitingUser) {
      // 加个微延迟、让 disabled→enabled 的 DOM 变化先 commit、再 focus 才稳
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isAwaitingUser]);

  /**
   * 把 File[] 转成 PendingImage[] 加进 attachedImages
   * 校验：mimeType 白名单 / 单图 size / 总张数上限（任何一项失败 → toast + 跳过该图）
   */
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const remainingSlots = MAX_IMAGES_PER_REPLY - attachedImages.length;
    if (remainingSlots <= 0) {
      toast.error(`最多附 ${MAX_IMAGES_PER_REPLY} 张图、先发送 / 移除几张再加`);
      return;
    }
    const toProcess = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.warning(
        `图太多、超出上限 ${MAX_IMAGES_PER_REPLY} 张、已截断到 ${remainingSlots} 张`,
      );
    }
    const additions: PendingImage[] = [];
    for (const file of toProcess) {
      if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
        toast.error(`${file.name || "(未命名)"} 不是支持的图片格式（${file.type || "未知"}）`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(
          `${file.name || "(未命名)"} 太大（${(file.size / 1024 / 1024).toFixed(2)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`,
        );
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        additions.push({
          id: newPendingId(),
          file,
          dataUrl,
          data: stripDataUrlPrefix(dataUrl),
          mimeType: file.type,
        });
      } catch (err) {
        toast.error(`读 ${file.name || "(未命名)"} 失败：${(err as Error).message}`);
      }
    }
    if (additions.length > 0) {
      setAttachedImages((prev) => [...prev, ...additions]);
    }
  };

  // 粘贴：clipboardData.items 里可能含 image（截图工具粘贴 / 浏览器右键复制图片）
  // 有 image → 阻止默认 + addFiles。纯文本粘贴不拦、走 Textarea 默认行为
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!isAwaitingUser) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  // 拖拽：dragenter / dragover 标 isDragging + preventDefault（不然 drop 不触发）
  // drop 时 dataTransfer.files 拿到 file 列表
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isAwaitingUser) return;
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragging(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // 子元素 dragleave 会冒泡、用 relatedTarget 判断「真离开了输入区」才置 false
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isAwaitingUser) return;
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) void addFiles(files);
  };

  // 附图按钮：点击触发隐藏 input file 的 click、选完文件回调 onChange
  const handleAttachClick = () => fileInputRef.current?.click();
  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void addFiles(files);
    // 清掉 input value、不然连选同一张图不触发 onChange
    e.target.value = "";
  };

  const handleRemoveImage = (id: string) => {
    setAttachedImages((prev) => prev.filter((p) => p.id !== id));
  };

  // 文件 / 目录选完回调：去重 + 上限校验、加进 attachedPaths
  const handlePathsPicked = (paths: string[]) => {
    setAttachedPaths((prev) => {
      const set = new Set(prev);
      let dupCount = 0;
      for (const p of paths) {
        if (set.has(p)) {
          dupCount++;
        } else {
          set.add(p);
        }
      }
      const merged = Array.from(set);
      if (merged.length > MAX_ATTACHMENTS_PER_REPLY) {
        toast.warning(
          `路径数超上限 ${MAX_ATTACHMENTS_PER_REPLY}、已截断到前 ${MAX_ATTACHMENTS_PER_REPLY} 条`,
        );
        return merged.slice(0, MAX_ATTACHMENTS_PER_REPLY);
      }
      if (dupCount > 0) {
        toast.info(`已忽略 ${dupCount} 条重复路径`);
      }
      return merged;
    });
  };

  const handleRemovePath = (p: string) => {
    setAttachedPaths((prev) => prev.filter((x) => x !== p));
  };

  const handleSend = () => {
    const text = draft.trim();
    // 文本 / 图 / 路径至少有一个、纯空消息不发
    if (!text && attachedImages.length === 0 && attachedPaths.length === 0) return;
    const images: ChatReplyImage[] | undefined =
      attachedImages.length > 0
        ? attachedImages.map((p) => ({
            data: p.data,
            mimeType: p.mimeType,
            filename: p.file.name,
          }))
        : undefined;
    const attachments = attachedPaths.length > 0 ? attachedPaths : undefined;
    onUserReply?.(text, images, attachments);
    setDraft("");
    setAttachedImages([]);
    setAttachedPaths([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter 发送、单 Enter 换行、避免误发
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
        事件流
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="flex flex-col gap-3 p-4">
          {renderEvents.length === 0 && !streamingText ? (
            <div className="text-xs text-muted-foreground">
              任务还没开始、暂无事件
            </div>
          ) : (
            <>
              {renderEvents.map((ev) => {
                if (ev.kind === "ask_user_request") {
                  // 单独走 AskUserRequestRow、内含选项按钮 + Other textarea + 提交逻辑
                  // 已经回答过的、显示 disabled 状态（看 task.events 里 ask_user_reply 是否存在）
                  return (
                    <AskUserRequestRow
                      key={ev.id}
                      ev={ev}
                      task={task}
                    />
                  );
                }
                return <EventRow key={ev.id} ev={ev} taskId={task.id} />;
              })}
              {/* 流式 placeholder：仅当后端在推 chunk 时显示、收到正式 assistant_message 事件后清空 */}
              {streamingText && (
                <StreamingAssistantRow text={streamingText} />
              )}
            </>
          )}
        </div>
      </div>
      {/* hideReplyComposer=true 时（plan workflow 模式）只展示事件流、底部输入区由父组件用 phase ack 区替代
          这里 early-return 避免下面整大段 JSX 进 DOM、也避免 FsPickerDialog 多挂一个 */}
      {hideReplyComposer ? null : (
        <>
      <Separator />
      {/* 输入区整片支持拖拽：drag over 时整片轮廓变虚线提示 */}
      <div
        className={cn(
          "shrink-0 p-3 transition-colors",
          isDragging && "bg-primary/5 ring-1 ring-primary/30 ring-inset",
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* 缩略图区：发送前可移除单张 */}
        {attachedImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachedImages.map((img) => (
              <div
                key={img.id}
                className="group relative size-16 overflow-hidden rounded-md border bg-card"
                title={img.file.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.dataUrl}
                  alt={img.file.name}
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="移除"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* 路径附件区：一行一个 chip、显示 basename、hover 显完整路径、可单独移除 */}
        {attachedPaths.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedPaths.map((p) => {
              // 简单判断：末尾不带 . 视为目录（启发式、最终 server 会再 stat）
              // UI 这里只是图标提示、不影响发送数据
              const looksLikeDir = !pathBasename(p).includes(".");
              return (
                <div
                  key={p}
                  className="group flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs"
                  title={p}
                >
                  {looksLikeDir ? (
                    <Folder className="size-3 shrink-0 text-amber-500" />
                  ) : (
                    <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-mono text-[11px]">
                    {pathBasename(p)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemovePath(p)}
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-full opacity-60 hover:bg-muted hover:opacity-100"
                    aria-label="移除"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <Textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={3}
          placeholder={
            isAwaitingUser
              ? "回复 / 粘贴或拖拽图片 / 点附图按钮（Cmd+Enter 发送）"
              : (disabledHint ?? "agent 当前没有等待你回复")
          }
          disabled={!isAwaitingUser}
          className="resize-none text-sm"
        />
        {/* 隐藏 input：附图按钮触发它 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={handleFilePicked}
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {/* 左边只放状态文案、附件计数 */}
          <span className="min-w-0 truncate">
            {isAwaitingUser
              ? attachedImages.length > 0 || attachedPaths.length > 0
                ? `图 ${attachedImages.length}/${MAX_IMAGES_PER_REPLY}、路径 ${attachedPaths.length}/${MAX_ATTACHMENTS_PER_REPLY}`
                : "agent 在等你回复"
              : (disabledHint ?? "agent 在等待你回复时输入框才会激活")}
          </span>
          {/* 右边一行：附图 / 附文件 / 发送（聊一起、对齐发送动作）*/}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!isAwaitingUser}
              onClick={handleAttachClick}
              className="h-7 gap-1 px-2 text-xs"
              title="附图（也支持粘贴 / 拖拽）"
            >
              <Paperclip className="size-3.5" />
              附图
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!isAwaitingUser}
              onClick={() => setPathPickerOpen(true)}
              className="h-7 gap-1 px-2 text-xs"
              title="附文件 / 目录路径（agent 会用 read_file 看）"
            >
              <FolderOpen className="size-3.5" />
              附文件
            </Button>
            <Button
              size="sm"
              disabled={
                !isAwaitingUser ||
                (!draft.trim() && attachedImages.length === 0 && attachedPaths.length === 0)
              }
              onClick={handleSend}
            >
              <Send className="size-3.5" />
              发送
            </Button>
          </div>
        </div>
      </div>
      {/* 文件 / 目录选择对话框：mode=any、多选、agent 拿到这些路径后自己用 read_file 读 */}
      <FsPickerDialog
        open={pathPickerOpen}
        onOpenChange={setPathPickerOpen}
        mode="any"
        multiple
        title="附加文件 / 目录"
        description="选完点确认、绝对路径会跟你的消息一起发给 agent、由它用 read_file 自己读"
        initialPath={task.repoPath}
        onConfirm={handlePathsPicked}
      />
        </>
      )}
    </div>
  );
};

export const EventStream = memo(EventStreamImpl);

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
const MarkdownText = ({ text }: { text: string }) => (
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
const StreamingAssistantRow = ({ text }: { text: string }) => (
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

// 默认展开的事件类型：核心对话两端（AI 回复 + 用户回复）
// 其他都默认折叠（thinking / tool_call / info / error / phase_*）
// **注意**：这只决定「初始 collapsed state」、不决定可不可折叠——所有事件都可手动折叠 / 展开
const DEFAULT_EXPANDED_KINDS: ReadonlySet<EventKind> = new Set([
  "assistant_message",
  "user_reply",
]);

// 折叠态摘要：取首行（按 \n 切）、再截到 max 字符
// 思考 / tool_call 这种动辄几百字的、折叠后只看一眼一行就够
const summarize = (text: string, max = 80): string => {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max)}…`;
};

/**
 * user_reply 事件里 meta.images 的形状（跟 chat-reply route 写入保持一致）
 * 这里不抽到 types.ts：types.ts 把 meta 设成 Record<string, unknown>、就地校验更轻
 */
interface UserReplyImageMeta {
  absPath: string;
  relPath: string;
  mimeType: string;
  bytes: number;
  filename?: string;
}

// user_reply 事件里 meta.attachments 的形状（chat-reply route 写）
// 跟图片不同：这是用户在 FsPickerDialog 选的真实文件 / 目录、不上传内容、只存路径
interface UserReplyAttachmentMeta {
  absPath: string;
  isDir: boolean;
  bytes?: number;
}

// 从 absPath / relPath 末尾取 filename（前端不能用 node:path、手切就行）
const basename = (p: string): string => {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
};

// 把 meta.images 解成强类型数组、形状不对的丢掉、不抛错
// 现实场景：旧事件可能没 images / 字段缺失、不应该让 UI 炸
const extractUserReplyImages = (
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
const extractUserReplyAttachments = (
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

// 构造 cursor:// deep link（点击在 IDE 打开）
// 复用思路：跟 artifact-panel.tsx 中 buildCursorLink 等价、为避免跨模块循环依赖、就地实现
const buildCursorLinkForPath = (absPath: string): string => {
  // 已经是 url 协议则 noop（理论不应出现）
  if (/^[a-z]+:\/\//i.test(absPath)) return absPath;
  return `cursor://file${absPath.split("/").map(encodeURIComponent).join("/")}`;
};

const EventRow = ({ ev, taskId }: { ev: TaskEvent; taskId: string }) => {
  const isUser = ev.kind === "user_reply";
  const isAssistant = ev.kind === "assistant_message";
  const isThinking = ev.kind === "thinking";
  const isToolCall = ev.kind === "tool_call";
  // 是否用 markdown 渲染：AI 回复 / 用户回复（用户也可能贴 markdown 进来）
  // thinking / tool_call / info / error 一律纯文本（结构化输出 / 错误消息、markdown 反而碍事）
  const useMarkdown = isAssistant || isUser;

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
  // - 其他：默认折叠（避免 thinking / tool_call 刷屏）
  // 组件内 state、用户手动切换后保持（不会被新事件刷掉）
  const defaultCollapsed = !DEFAULT_EXPANDED_KINDS.has(ev.kind);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const handleToggle = () => setCollapsed((c) => !c);

  // 折叠态文本：摘要、不让超长
  // 展开态：原样 ev.text
  const summary = summarize(ev.text);

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
          {ev.phase && (
            <span className="rounded bg-muted/60 px-1 py-0.5 text-[10px] tracking-wide text-muted-foreground">
              {PHASE_LABEL_SHORT[ev.phase]}
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
        {!collapsed && (
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
        )}
        {/* user_reply 附图缩略图：折叠 / 展开都显示（图比文字更值得"始终见到"）
            点缩略图新 tab 打开看大图、不内嵌 lightbox（保持轻量、浏览器自带的图片查看够用）*/}
        {isUser && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => {
              const url = `/api/tasks/${taskId}/uploads/${basename(img.absPath)}`;
              const sizeKb = img.bytes > 0 ? (img.bytes / 1024).toFixed(1) : "?";
              return (
                <a
                  key={img.absPath}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block size-16 overflow-hidden rounded-md border bg-card transition-opacity hover:opacity-80"
                  title={`${img.filename ?? basename(img.absPath)} · ${sizeKb} KB`}
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
              return (
                <a
                  key={att.absPath}
                  href={buildCursorLinkForPath(att.absPath)}
                  className="flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs no-underline hover:bg-muted"
                  title={`${att.absPath}${sizeStr ? ` · ${sizeStr}` : ""}\n点击在 Cursor 中打开`}
                >
                  {att.isDir ? (
                    <Folder className="size-3 shrink-0 text-amber-500" />
                  ) : (
                    <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-mono text-[11px] text-sky-600 dark:text-sky-400">
                    {basename(att.absPath)}
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

const AskUserRequestRow = ({ ev, task }: AskUserRequestRowProps) => {
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
