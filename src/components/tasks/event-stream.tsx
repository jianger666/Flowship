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

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ArrowUp,
  File as FileIcon,
  Folder,
  FolderOpen,
  Loader2,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ImageThumb } from "@/components/ui/image-preview";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { pickNativePaths } from "@/lib/native-picker";
import { pathBasename } from "@/lib/path-utils";
import {
  getSubmitShortcutHint,
  getSubmitShortcutTitle,
  shouldSubmitOnKeyDown,
} from "@/lib/submit-shortcut";
import type { ImagePayload } from "@/lib/task-store";
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

// agent 已在跑、但还没吐出第一个 token 的「起手空窗」占位
// （取代旧的「正在启动 agent」toast、不打断、收到首个 delta 即被 streaming item 取代）
interface LoadingItem {
  kind: "__loading__";
  id: string;
}

type RenderItem = TaskEvent | StreamingItem | LoadingItem;

const isStreamingItem = (it: RenderItem): it is StreamingItem =>
  it.kind === "__streaming__";

const isLoadingItem = (it: RenderItem): it is LoadingItem =>
  it.kind === "__loading__";

// 「发出消息 → 程序受理」空白期的 loading 占位行：小转圈 +「正在响应…」、muted 细行风格
const PendingRow = () => (
  <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
    <Loader2 className="size-3.5 animate-spin" />
    <span>正在响应…</span>
  </div>
);

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
    images?: ImagePayload[],
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
  // V0.6.24：footer 左侧 slot（chat 模式注入模型选择器、plan / task 模式不传）
  composerLeading?: ReactNode;
  // chat 模式 textarea 上方一行 slot（注入工作目录 + 分支选择器、跟底部 model 分两处放）
  composerTop?: ReactNode;
  // V0.7.21：chat 运行态——agent 正在生成时、底部操作行把发送键换成红色停止键 + loading 转圈
  // （取代顶栏旧的「AI 正在回 + 停止」、统一收进输入岛、靠原地替换不顶布局）
  isRunning?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  // V0.7.11：渲染形态
  // log（默认）：task 模式事件流——卡片行 + header 折叠、信息密度优先
  // chat：自由模式对话——Cursor agent window 风格（窄列居中 / AI 平铺 /
  //       用户浅色块 / 过程细行 / 圆角输入岛）
  variant?: "log" | "chat";
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
  composerLeading,
  composerTop,
  isRunning,
  onStop,
  stopping,
  variant = "log",
}: Props) => {
  const isChat = variant === "chat";
  // 输入草稿、发送后清空
  const [draft, setDraft] = useState("");
  // 原生 picker 调用中（防双击连开系统对话框）；存 mode 让被点的那颗按钮转 spinner
  // ——mac osascript 弹窗有 ~1s 冷启动延迟、用户反馈「点了没反应」、需要即时视觉反馈
  const [picking, setPicking] = useState<false | "file" | "folder">(false);
  // 待发送的文件 / 目录绝对路径列表、跟图片 hook 平行的 state
  // 发送后清空；元素本身就是绝对路径字符串（不像 images 是 base64 blob）
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  // 个人偏好的提交快捷键：默认 Cmd/Ctrl+Enter，设置页可切 Enter 提交。
  const submitShortcut = useSubmitShortcut();
  const submitShortcutHint = getSubmitShortcutHint(submitShortcut);
  const submitShortcutTitle = getSubmitShortcutTitle(submitShortcut);
  // Virtuoso 句柄：流式增长时手动 scrollToIndex 贴底（见下方 streaming 自动滚 effect）
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // 用户当前是否贴在底部（由 Virtuoso atBottomStateChange 维护）。
  // 初始 true：进来 initialTopMostItemIndex 定位到末尾、就是贴底态。
  // 关键作用：流式回复时只有「用户本来就在底部」才自动跟随、用户主动往上翻看历史就不打扰。
  const atBottomRef = useRef(true);
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
    // agent 在吐字 → 末尾打字机 item；
    // 在跑但还没吐字（起手空窗）→ 末尾 loading item；都没有 → 原样
    if (streamingText) {
      return [
        ...merged,
        { kind: "__streaming__", id: "__streaming__", text: streamingText },
      ];
    }
    // 「发出消息 → 程序受理」空白期：agent 已在跑、但事件流最后一条还是用户刚发的消息
    // （启动 info / thinking / tool 都还没冒出来）→ 末尾挂一行 loading。
    // 一旦出现第一个 agent 事件、last 不再是 user_reply、loading 自动消失（不会盖住链路）。
    const last = merged[merged.length - 1];
    if (isRunning && last?.kind === "user_reply") {
      return [...merged, { kind: "__loading__", id: "__loading__" }];
    }
    return merged;
  }, [task.events, streamingText, isRunning]);

  // 流式回复自动贴底（V0.8.3 修）：
  // 根因——流式回复是往同一个 `__streaming__` 虚拟 item 的 text 里追加、items 长度不变（始终
  // merged.length + 1）。react-virtuoso 的 followOutput 只在 data 条数变化时触发滚动、对「最后一项
  // 内容增高」无感、所以流式增长期间不会自动滚（用户实测：滚到底聊天、AI 回复过程不跟随）。
  // 修法——streamingText 每变一次（每个 chunk）、若用户本来贴在底部、就手动把最后一项滚到视口底。
  // 用 behavior:"auto"（瞬时）避免每个 chunk smooth 动画互相打架卡顿。atBottomRef 由下方
  // atBottomStateChange 维护、配合 Virtuoso 的 atBottomThreshold（给足余量、防单 chunk 增高把
  // atBottom 误判成 false 导致自废）。useEffect（非 layout）跑在 Virtuoso 测完新高度之后、scrollToIndex
  // 才能命中真正的新底部。
  useEffect(() => {
    if (!streamingText) return;
    if (!atBottomRef.current) return;
    virtuosoRef.current?.scrollToIndex({
      index: items.length - 1,
      align: "end",
      behavior: "auto",
    });
  }, [streamingText, items.length]);

  // V0.6：输入框可用 = 父组件传 canReply
  // 父组件没传时回退 task.runStatus === "awaiting_user"
  const canCompose = canReply ?? task.runStatus === "awaiting_user";

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

  // 原生 picker（V0.7.13）：附文件 / 附目录各自一键、桌面端走主进程系统对话框
  const pickPaths = async (mode: "file" | "folder") => {
    setPicking(mode);
    try {
      const paths = await pickNativePaths({
        mode,
        multiple: true,
        prompt: mode === "folder" ? "附加目录（agent 用 read 工具看）" : "附加文件（agent 用 read 工具看）",
      });
      if (paths) handlePathsPicked(paths);
    } finally {
      setPicking(false);
    }
  };

  const handleRemovePath = (p: string) => {
    setAttachedPaths((prev) => prev.filter((x) => x !== p));
  };

  const handleSend = () => {
    const text = draft.trim();
    // 文本 / 图 / 路径至少有一个、纯空消息不发
    if (!text && attachedImages.length === 0 && attachedPaths.length === 0) return;
    const images: ImagePayload[] | undefined = imagesToUploadPayload();
    const attachments = attachedPaths.length > 0 ? attachedPaths : undefined;
    onUserReply?.(text, images, attachments);
    setDraft("");
    resetAttachedImages();
    setAttachedPaths([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitOnKeyDown(e, submitShortcut)) {
      e.preventDefault();
      handleSend();
    }
  };

  // chat 形态间距：对话消息（AI / 用户 / streaming / ask_user）之间留大段落感、
  // 连续过程行（thinking / tool_call / info…）紧凑堆叠成一组
  const isConversational = (it: RenderItem) =>
    isStreamingItem(it) ||
    it.kind === "assistant_message" ||
    it.kind === "user_reply" ||
    it.kind === "ask_user_request";

  return (
    <div className="flex h-full flex-col">
      {/* chat 形态不渲染「事件流」标签条（ChatView 自有顶部 bar、少一层视觉框） */}
      {!isChat && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
          事件流
        </div>
      )}
      {/* min-h-0 让 flex-1 子项能正确 shrink、Virtuoso 拿到确定高度才能内部 scroll */}
      <div className="min-h-0 flex-1">
        {items.length === 0 ? (
          <div
            className={cn(
              "p-4 text-xs text-muted-foreground",
              isChat && "flex h-full items-center justify-center text-sm",
            )}
          >
            {isChat ? "说点什么、agent 会自动启动" : "任务还没开始、暂无事件"}
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
            // 维护「用户是否贴底」给上面的流式自动滚 effect 用。
            atBottomStateChange={(atBottom) => {
              atBottomRef.current = atBottom;
            }}
            // 贴底判定余量调大（默认仅 4px）：流式时最后一项每来一个 chunk 会增高若干像素、
            // 余量太小会立刻被判成「离开底部」→ effect 自废不再跟随。120px 覆盖常见 chunk 增量、
            // 让「滚到底跟随」稳定；用户真往上翻 >120px 才停跟随。
            atBottomThreshold={120}
            // 初始定位到末尾（任务详情首次进来直接看最新事件、不用手动滚）
            initialTopMostItemIndex={items.length - 1}
            // 每条 item 自带 padding；chat 形态窄列居中 + 按消息类型分配段落间距
            itemContent={(idx, item) => (
              <div
                className={cn(
                  "px-4",
                  isChat && "mx-auto w-full max-w-3xl px-6",
                  isChat
                    ? idx === 0
                      ? "pt-6"
                      : isConversational(item)
                        ? "pt-6"
                        : isConversational(items[idx - 1])
                          ? "pt-4"
                          : "pt-0.5"
                    : idx === 0
                      ? "pt-4"
                      : "pt-3",
                  idx === items.length - 1 && (isChat ? "pb-6" : "pb-4"),
                )}
              >
                {isStreamingItem(item) ? (
                  <StreamingAssistantRow text={item.text} variant={variant} />
                ) : isLoadingItem(item) ? (
                  <PendingRow />
                ) : item.kind === "ask_user_request" ? (
                  <AskUserRequestRow ev={item} task={task} />
                ) : (
                  <EventRow ev={item} taskId={task.id} task={task} variant={variant} />
                )}
              </div>
            )}
          />
        )}
      </div>
      {/* hideReplyComposer=true 时（plan workflow 模式）只展示事件流、底部输入区由父组件用 phase ack 区替代
          这里 early-return 避免下面整大段输入区 JSX 进 DOM */}
      {hideReplyComposer ? null : isChat ? (
        /* ---------- chat 形态：圆角输入岛（V0.7.11、Cursor agent window 风格） ---------- */
        <div className="shrink-0 px-6 pb-5 pt-1">
          <div
            className={cn(
              "mx-auto w-full max-w-3xl rounded-xl border bg-card/70 shadow-sm transition-all",
              "focus-within:border-ring/60 focus-within:shadow-md",
              isDragging && "border-primary/50 bg-primary/5",
              !isAwaitingUser && "opacity-70",
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* 选择器行（工作目录 / 分支）：岛最顶、本次对话配置归一条。
                workdir 常驻 → 此行高度恒定、不随 branch 显隐而跳动 */}
            {composerTop && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-3 pb-2.5 pt-3">
                {composerTop}
              </div>
            )}
            {/* 附件预览：紧贴输入框上方（图缩略 + 路径 chips） */}
            {(attachedImages.length > 0 || attachedPaths.length > 0) && (
              <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                {attachedImages.map((img, i) => (
                  <ImageThumb
                    key={img.id}
                    src={img.dataUrl}
                    alt={img.file.name}
                    onRemove={() => handleRemoveImage(img.id)}
                    group={attachedImages.map((im) => ({
                      src: im.dataUrl,
                      alt: im.file.name,
                    }))}
                    index={i}
                  />
                ))}
                {attachedPaths.map((p) => {
                  const looksLikeDir = !pathBasename(p).includes(".");
                  return (
                    <div
                      key={p}
                      className="group flex max-w-full items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs"
                      title={p}
                    >
                      {looksLikeDir ? (
                        <Folder className="size-3 shrink-0 text-amber-500" />
                      ) : (
                        <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 truncate font-mono text-[11px]">{pathBasename(p)}</span>
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
            {/* 输入框：去边框嵌入岛内、岛本身的 focus-within 提供聚焦反馈 */}
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={2}
              placeholder={
                isAwaitingUser
                  ? `随便聊、贴图、拖文件（${submitShortcutHint}）`
                  : (disabledHint ?? "agent 当前没有等待你回复")
              }
              disabled={!isAwaitingUser}
              className="max-h-48 min-h-13 resize-none overflow-y-auto border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            {/* 底部操作行：左下放模型选择器（composerLeading）、右侧放动作（附图 / 文件 / 目录 + 发送）。
                工作目录 / 分支选择器在岛顶部 composerTop 一条。
                运行态：右侧整组换成 loading 转圈 + 红色停止键——原地替换、不新增行、不顶布局 */}
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1.5">
              {/* 左下：模型选择器（chat 注入 composerLeading）；不传时空 div、右侧仍靠右 */}
              <div className="flex min-w-0 items-center">{composerLeading}</div>
              <div className="flex shrink-0 items-center gap-0.5">
                {isRunning ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    <Button
                      type="button"
                      size="sm"
                      onClick={onStop}
                      disabled={stopping}
                      title="停止生成（中断 agent）"
                      className="ml-1 size-7 rounded-lg bg-destructive p-0 text-white hover:bg-destructive/90"
                    >
                      {stopping ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Square className="size-3 fill-current" />
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!isAwaitingUser}
                      onClick={handleAttachClick}
                      className="size-7 p-0 text-muted-foreground hover:text-foreground"
                      title="附图（也支持粘贴 / 拖拽）"
                    >
                      <Paperclip className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!isAwaitingUser || picking !== false}
                      onClick={() => void pickPaths("file")}
                      className="size-7 p-0 text-muted-foreground hover:text-foreground"
                      title="附文件（agent 会用 `read` 工具看）"
                    >
                      {picking === "file" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FileIcon className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!isAwaitingUser || picking !== false}
                      onClick={() => void pickPaths("folder")}
                      className="size-7 p-0 text-muted-foreground hover:text-foreground"
                      title="附目录（agent 会用 `read` 工具看）"
                    >
                      {picking === "folder" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        !isAwaitingUser ||
                        (!draft.trim() && attachedImages.length === 0 && attachedPaths.length === 0)
                      }
                      onClick={handleSend}
                      className="ml-1 size-7 rounded-lg p-0"
                      title={`发送（${submitShortcutTitle}）`}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
          {/* 隐藏 input：附图按钮触发它 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={handleFilePicked}
          />
        </div>
      ) : (
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
        {/* 缩略图区：发送前可移除单张、点击站内看大图（多图左右切换） */}
        {attachedImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachedImages.map((img, i) => (
              <ImageThumb
                key={img.id}
                src={img.dataUrl}
                alt={img.file.name}
                className="size-16"
                onRemove={() => handleRemoveImage(img.id)}
                group={attachedImages.map((im) => ({
                  src: im.dataUrl,
                  alt: im.file.name,
                }))}
                index={i}
              />
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
              ? `回复 / 粘贴或拖拽图片 / 点附图按钮（${submitShortcutHint}）`
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
          {/* 左边：模型选择器 slot（chat 注入、其它模式不传）+ 状态文案、附件计数 */}
          <div className="flex min-w-0 items-center gap-2">
            {composerLeading}
            <span className="min-w-0 truncate">
              {isAwaitingUser
                ? attachedImages.length > 0 || attachedPaths.length > 0
                  ? `图 ${attachedImages.length}/${MAX_IMAGES_PER_REPLY}、路径 ${attachedPaths.length}/${MAX_ATTACHMENTS_PER_REPLY}`
                  : "agent 在等你回复"
                : (disabledHint ?? "agent 在等待你回复时输入框才会激活")}
            </span>
          </div>
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
              disabled={!isAwaitingUser || picking !== false}
              onClick={() => void pickPaths("file")}
              className="h-7 gap-1 px-2 text-xs"
              title="附文件（agent 会用 `read` 工具看）"
            >
              {picking === "file" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileIcon className="size-3.5" />
              )}
              附文件
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!isAwaitingUser || picking !== false}
              onClick={() => void pickPaths("folder")}
              className="h-7 gap-1 px-2 text-xs"
              title="附目录（agent 会用 `read` 工具看）"
            >
              {picking === "folder" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FolderOpen className="size-3.5" />
              )}
              附目录
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
        </>
      )}
    </div>
  );
};

export const EventStream = memo(EventStreamImpl);
