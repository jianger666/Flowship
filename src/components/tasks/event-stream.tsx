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
 *
 * V0.5.11 拆分：原 890 行单文件按职责拆成
 *   - event-stream.tsx       主组件 EventStream（本文件）
 *   - event-stream/utils.tsx 事件标签 / 图标 / 时间 / thinking 合并 / meta 解析 等纯函数
 *   - event-stream/rows.tsx  MarkdownText / StreamingAssistantRow / EventRow / AskUserRequestRow
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { FsPickerDialog } from "@/components/ui/fs-picker-dialog";
import { useImageAttach } from "@/hooks/use-image-attach";
import { getEffectiveCwd, pathBasename } from "@/lib/path-utils";
import type { ChatReplyImage } from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";

import {
  mergeAdjacentThinking,
  mergeAdjacentToolCall,
} from "./event-stream/utils";
import {
  AskUserRequestRow,
  EventRow,
  StreamingAssistantRow,
} from "./event-stream/rows";

// streaming placeholder 作为 list 末尾的「虚拟 item」、参与虚拟滚动
// kind 用未出现在 EventKind 里的字面量、做 discriminated union 区分
// 这样 streamingText 不再走 Footer / Component slot、而是直接进 data 数组、
// followOutput 跟着它的追加触发滚动、不用单独 ref 控制
interface StreamingItem {
  kind: "__streaming__";
  id: string;
  text: string;
}

type RenderItem = TaskEvent | StreamingItem;

const isStreamingItem = (it: RenderItem): it is StreamingItem =>
  it.kind === "__streaming__";

interface Props {
  task: Task;
  // 流式 placeholder：chat-view 维护、SDK chunk 推到这里、收到正式 assistant_message 事件清空
  // 非空时在事件流末尾渲染一个「AI 回复中...」卡片、内容随 chunk 拼接增长（打字机效果）
  // V1 仅 chat 模式用、plan 模式不传
  streamingText?: string;
  // attachments：附加的文件 / 目录绝对路径数组、后端 wait_for_user return 会拼成
  // [ATTACHED_PATHS] 段给 agent、agent 用 `read` 工具自己读
  onUserReply?: (
    text: string,
    images?: ChatReplyImage[],
    attachments?: string[],
  ) => void;
  // V0.2 plan workflow 模式下传 true、不渲染底部「自由回复」输入框
  // 因为 plan 模式的 HITL 是 phase ack（通过 / 再聊聊）、不是 free-form 聊天
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

// 用 React.memo 包裹：详情页输入交互（如「再聊聊」对话框输入）触发 page 重渲染时、
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
  // 文件 / 目录路径选择器开关（点「附文件」按钮触发）
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  // 待发送的文件 / 目录绝对路径列表、跟图片 hook 平行的 state
  // 发送后清空；元素本身就是绝对路径字符串（不像 images 是 base64 blob）
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  // Virtuoso 句柄：必要时用于手动 scrollToIndex（目前没用上、留着兜底）
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // 输入框：用于「awaiting_user 时自动聚焦」、避免用户每次都得手动点输入框
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 渲染前两道合并 pass + 拼 streaming placeholder：
  // 1) thinking 合并：连续相邻 thinking 拼成一条、避免「思考被切碎」
  // 2) tool_call 合并：同 phase 连续 ≥2 条合一、降密度（review 阶段一连
  //    十几条 edit artifact 视觉重、合并后变一行 ×N）
  // 3) streamingText 非空时追加为末尾 `__streaming__` 虚拟 item、跟普通 event
  //    一起参与虚拟滚动 + followOutput 贴底跟随
  const items: RenderItem[] = useMemo(() => {
    const merged = mergeAdjacentToolCall(mergeAdjacentThinking(task.events));
    if (!streamingText) return merged;
    return [
      ...merged,
      { kind: "__streaming__", id: "__streaming__", text: streamingText },
    ];
  }, [task.events, streamingText]);

  // V0.4：输入框可用 = 父组件传 canReply（chat-view 自由化用）
  // 父组件没传时回退老行为 status === "awaiting_user"（plan 模式用、不影响）
  // 重命名内部变量为 canCompose、避免「awaiting_user」语义跟可用判定耦合
  const canCompose = canReply ?? task.status === "awaiting_user";

  // 输入框自动聚焦判定：跟 canCompose 同款（之前用 isAwaitingUser、现在统一走 canCompose）
  // - chat 自由化下、agent 起手就 wait_for_user、进 ChatView 时 status 大概率立刻变 awaiting_user
  //   → canCompose 变 true 触发 focus
  const isAwaitingUser = canCompose;

  // V0.5.4 图附件管理统一走 hook、跟 revise-dialog 共用（同款约束、同款交互）
  // disabled=!isAwaitingUser 时所有 handler 短路、防止 agent 没等待时也能添图
  const {
    images: attachedImages,
    isDragging,
    fileInputRef,
    maxImages: MAX_IMAGES_PER_REPLY,
    removeImage: handleRemoveImage,
    triggerFilePicker: handleAttachClick,
    onPaste: handlePaste,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
    onFileInputChange: handleFilePicked,
    reset: resetAttachedImages,
    toUploadPayload: imagesToUploadPayload,
  } = useImageAttach({ disabled: !isAwaitingUser });

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
    const images: ChatReplyImage[] | undefined = imagesToUploadPayload();
    const attachments = attachedPaths.length > 0 ? attachedPaths : undefined;
    onUserReply?.(text, images, attachments);
    setDraft("");
    resetAttachedImages();
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
      {/* min-h-0 让 flex-1 子项能正确 shrink、Virtuoso 拿到确定高度才能内部 scroll */}
      <div className="min-h-0 flex-1">
        {items.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">
            任务还没开始、暂无事件
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            className="h-full"
            data={items}
            // 贴底跟随语义：用户贴在底部时新 item 来自动滚（smooth）；
            // 用户主动滚走看历史时不打扰；滚回底部恢复跟随
            // 这一行替代了老的 stickToBottomRef + handleScroll + autoScroll useEffect、
            // 库自己维护「是否贴底」、不需要外部 ref 状态
            followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
            // 初始定位到末尾（任务详情首次进来直接看最新事件、不用手动滚）
            initialTopMostItemIndex={items.length - 1}
            // 每条 item 自带 padding、模拟原 gap-3 + p-4 间距
            // pt 用 idx 0 给 4 / 其他给 3、pb 给末尾 4 / 其他无（让 pt 接力）
            itemContent={(idx, item) => (
              <div
                className={cn(
                  "px-4",
                  idx === 0 ? "pt-4" : "pt-3",
                  idx === items.length - 1 && "pb-4",
                )}
              >
                {isStreamingItem(item) ? (
                  <StreamingAssistantRow text={item.text} />
                ) : item.kind === "ask_user_request" ? (
                  <AskUserRequestRow ev={item} task={task} />
                ) : (
                  <EventRow ev={item} taskId={task.id} />
                )}
              </div>
            )}
          />
        )}
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
              title="附文件 / 目录路径（agent 会用 `read` 工具看）"
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
      {/* 文件 / 目录选择对话框：mode=any、多选、agent 拿到这些路径后自己用 `read` 工具读 */}
      <FsPickerDialog
        open={pathPickerOpen}
        onOpenChange={setPathPickerOpen}
        mode="any"
        multiple
        title="附加文件 / 目录"
        description="选完点确认、绝对路径会跟你的消息一起发给 agent、由它用 `read` 工具自己读"
        initialPath={getEffectiveCwd(task.repoPaths)}
        onConfirm={handlePathsPicked}
      />
        </>
      )}
    </div>
  );
};

export const EventStream = memo(EventStreamImpl);
