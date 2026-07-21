/**
 * 统一输入岛 Composer（v1.1.x、用户点名「封装一个高级的输入框、chat / task 都复用」）
 *
 * 之前 chat 输入岛（event-stream 内）和 task「跟 AI 说」条（task-talk-composer）
 * 各手写一份、长得像但代码两套。本组件收口全部输入岛能力：
 *
 * - 岛容器：圆角 + focus 高亮 + 拖拽文件落入高亮
 * - 顶边拖柄：往上拉变高（贴底输入条的直觉方向）、高度记全局偏好
 * - skill / 文件内联 token：Lexical SkillTokenNode + FileTokenNode
 * - `/` slash 菜单 + `@` 文件菜单（浮岛上方）
 * - 附件预览：图缩略（可移除 / 点看大图）+ 文件 / 目录路径 chips
 * - 输入引擎：Lexical PlainText（提交快捷键 + IME 安全 + 拖高滚动 + ↑ 历史）
 * - footer：左 slot（模型 / 自定义）+ 右动作组（附图 / 附文件 / 附目录 + 发送）；
 *   运行态原地换成 spinner + 红色停止键（不顶布局）
 *
 * 状态归调用方（草稿 / 附件 hook / slash / 提交逻辑）、本组件只管交互和视觉——
 * 两个调用方各自的业务分支（disabled 判定 / placeholder / 发送通道）不进来。
 * `@` / 历史 / 未绑仓警示读 ComposerSessionProvider（ChatView / TaskTalk 注入）。
 */

"use client";

import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ArrowUp,
  File as FileIcon,
  Folder,
  FolderOpen,
  ImagePlus,
  Info,
  Loader2,
  Square,
  X,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ComposerEditor,
  type ComposerFocusHandle,
} from "@/components/composer-editor";
import { SlashSkillMenu, type SlashSkillsApi } from "@/components/slash-skills";
import { AtMentionMenu, useAtMention } from "@/components/at-mention";
import { useComposerSession } from "@/components/composer-session";
import { Button } from "@/components/ui/button";
import { ImageThumb } from "@/components/ui/image-preview";
import { getSubmitShortcutTitle } from "@/lib/submit-shortcut";
import { oppositeSubmitShortcut } from "@/lib/keyboard-shortcuts";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { pathBasename } from "@/lib/path-utils";
import { loadBoxHeight, saveBoxHeight } from "@/lib/view-memory";
import type { UseImageAttachReturn } from "@/hooks/use-image-attach";

// 拖高上下界（px）：下界 = 默认两行高、上界防把上方内容顶没
const MIN_BOX_HEIGHT = 52;
const MAX_BOX_HEIGHT = 400;

export type { ComposerFocusHandle };

export interface ComposerProps {
  /**
   * 编辑上下文标识（如 task.id）：变化时强制重建 Lexical 编辑器——
   * 撤销栈 / 内部文档树跟着上下文走、防「切 task 后 Cmd+Z 回滚出上一个任务的草稿」
   */
  editorKey?: string;
  value: string;
  /** 值变化（调用方存 state + 草稿）；slash 的光标同步组件内部代办 */
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** 整体禁用：编辑器 + 附件动作 + 发送（停止键不受它管） */
  disabled?: boolean;
  /** 请求飞行中：发送键转圈（跟 running 的区别：这是「提交这条」的短暂态） */
  submitting?: boolean;
  /**
   * 聚焦句柄（调用方做自动聚焦 / Cmd+J）。
   * 旧 textareaRef 已退役——调用方只用 `.focus()` / `.prepareCursor()`。
   */
  focusRef?: RefObject<ComposerFocusHandle | null>;

  /** `/` 唤起 skill（不传 = 无 slash 能力） */
  slash?: SlashSkillsApi;

  /** 图片附件（useImageAttach 返回值整个传入；不传 = 无附图能力） */
  attach?: UseImageAttachReturn;

  /** 文件 / 目录路径附件（不传 onPickPaths = 不显示附文件 / 目录按钮） */
  paths?: string[];
  onRemovePath?: (p: string) => void;
  onPickPaths?: (mode: "file" | "folder") => void;
  picking?: false | "file" | "folder";
  /**
   * 粘贴超长纯文本 → 转路径附件（父组件调 paste-text API + addAbsPath）。
   * 不传 = 超长文本仍正常插入编辑器；失败应返 false 让编辑器把原文插回。
   */
  onPasteLongText?: (content: string) => Promise<boolean>;

  /** 岛顶配置行（chat 的工作目录 / 分支选择器） */
  topRow?: ReactNode;
  /** footer 左 slot（模型选择器） */
  leading?: ReactNode;

  /** agent 运行态：右侧动作组换成 spinner + 停止键 */
  running?: boolean;
  onStop?: () => void;
  stopping?: boolean;

  /**
   * chat 排队：运行中仍可发送（footer 同时显示停止 + 发送）。
   * 不传 / false = 旧行为（运行中只显示停止）。
   */
  allowQueueWhileRunning?: boolean;
  /**
   * B 批次「立即发送」：运行中打断当前回复立刻发（默认发送键 = 排队）。
   * 仅 running + allowQueueWhileRunning 时生效；快捷键用提交偏好的对位组合。
   */
  onSubmitNow?: () => void;
  /** 输入区上方排队提示条 */
  queueBanner?: ReactNode;

  /** 岛容器附加 class（如禁用态调暗 opacity-70） */
  className?: string;
}

export const Composer = ({
  editorKey,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  submitting,
  focusRef,
  slash,
  attach,
  paths,
  onRemovePath,
  onPickPaths,
  picking = false,
  onPasteLongText,
  topRow,
  leading,
  running,
  onStop,
  stopping,
  allowQueueWhileRunning,
  onSubmitNow,
  queueBanner,
  className,
}: ComposerProps) => {
  // 手动拖过的高度（null = 未拖过、编辑器随内容自增）；记全局偏好、跨任务共用
  const [boxHeight, setBoxHeight] = useState<number | null>(() => {
    const saved = loadBoxHeight();
    return saved != null
      ? Math.min(MAX_BOX_HEIGHT, Math.max(MIN_BOX_HEIGHT, saved))
      : null;
  });
  // 量高容器：拖柄读 contentEditable 外包一层的高度
  const boxContainerRef = useRef<HTMLDivElement | null>(null);
  const submitShortcut = useSubmitShortcut();
  const session = useComposerSession();

  // `@` 文件引用：依赖 session（taskId + repoPaths）；无 Provider 则不启用
  const atApplyDraft = useMemo(
    () => (next: string, cursor?: number) => {
      if (cursor != null) focusRef?.current?.prepareCursor(cursor);
      onChange(next);
      requestAnimationFrame(() => focusRef?.current?.focus());
    },
    [focusRef, onChange],
  );
  const atMention = useAtMention({
    taskId: session?.taskId ?? "",
    repoPaths: session?.repoPaths ?? [],
    applyDraft: atApplyDraft,
  });
  // 无 session 时仍创建 hook（规则要求）、但不把菜单 / pick 接到编辑器
  const atForEditor = session ? atMention : undefined;

  const images = attach?.images ?? [];
  const pathList = paths ?? [];
  const hasContent =
    value.trim().length > 0 || images.length > 0 || pathList.length > 0;
  // 上下文行只剩图 / 路径（skill / @ 已内联进文本、不再单独占一行）
  const hasContextRow = images.length > 0 || pathList.length > 0;

  const handleSubmit = () => {
    if (disabled || submitting || !hasContent) return;
    onSubmit();
  };

  // 立即发送（打断当前回复）：仅运行中排队场景有意义、guard 与 handleSubmit 同口径
  const canSendNow = !!(running && allowQueueWhileRunning && onSubmitNow);
  const handleSubmitNow = () => {
    if (!canSendNow || disabled || submitting || !hasContent) return;
    onSubmitNow?.();
  };

  const showUnbound =
    !!session?.showUnboundBanner && (session.repoPaths?.length ?? 0) === 0;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border bg-card/70 shadow-sm transition-all",
        "focus-within:border-ring/60 focus-within:shadow-md",
        attach?.isDragging && "border-primary/50 bg-primary/5",
        className,
      )}
      onDragOver={attach?.onDragOver}
      onDragLeave={attach?.onDragLeave}
      onDrop={attach?.onDrop}
    >
      {/* `/` skill 与 `@` 文件菜单（浮岛上方；同时最多开一个） */}
      {slash && <SlashSkillMenu slash={slash} />}
      {atForEditor && <AtMentionMenu at={atForEditor} />}

      {/* 顶边拖柄：往上拉变高、往下拉变矮；setPointerCapture 让拖出手柄仍跟手 */}
      <div
        className="group flex h-2.5 w-full shrink-0 cursor-ns-resize items-center justify-center"
        onPointerDown={(e) => {
          e.preventDefault();
          const handle = e.currentTarget;
          handle.setPointerCapture(e.pointerId);
          const startY = e.clientY;
          const startH =
            boxHeight ??
            boxContainerRef.current?.getBoundingClientRect().height ??
            MIN_BOX_HEIGHT;
          // 拖动过程中的最新高度（结束时落盘、避免每次 move 都写 localStorage）
          let latest: number | null = null;
          const onMove = (ev: PointerEvent) => {
            const next = Math.min(
              MAX_BOX_HEIGHT,
              Math.max(MIN_BOX_HEIGHT, startH + (startY - ev.clientY)),
            );
            latest = next;
            setBoxHeight(next);
          };
          const finish = () => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", finish);
            handle.removeEventListener("pointercancel", finish);
            if (latest != null) saveBoxHeight(latest);
          };
          handle.addEventListener("pointermove", onMove);
          handle.addEventListener("pointerup", finish);
          handle.addEventListener("pointercancel", finish);
        }}
        aria-label="拖动调整输入框高度"
        title="上下拖动调整高度"
      >
        <div className="h-1 w-10 rounded-full bg-border/60 transition-colors group-hover:bg-muted-foreground/50" />
      </div>

      {/* P1.6：Home（未绑仓）轻量提示（对标 Cursor 上下文条——无警示底色、一行融入 composer） */}
      {showUnbound && (
        <div className="mx-2.5 mb-1 flex items-center gap-1.5 bg-muted/30 px-1 py-0.5">
          <Info
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            AI 将在 Home 目录运行
          </span>
          {session?.onBindWorkdir && (
            <button
              type="button"
              className="shrink-0 cursor-pointer text-xs text-primary hover:underline"
              onClick={session.onBindWorkdir}
            >
              绑定
            </button>
          )}
        </div>
      )}

      {/* P5：排队提示（输入框上方） */}
      {queueBanner}

      {/* 岛顶配置行（工作目录 / 分支等）：恒定一条、不随内容显隐跳动 */}
      {topRow && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-3 pb-2.5 pt-0.5">
          {topRow}
        </div>
      )}

      {/* 上下文行：图缩略 + 路径 chips（skill / @ 已内联、不在这里） */}
      {hasContextRow && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 pt-1.5">
          {images.map((img, i) => (
            <ImageThumb
              key={img.id}
              src={img.dataUrl}
              alt={img.file.name}
              className="size-10 rounded bg-background"
              onRemove={() => attach?.removeImage(img.id)}
              group={images.map((im) => ({
                src: im.dataUrl,
                alt: im.file.name,
              }))}
              index={i}
            />
          ))}
          {pathList.map((p) => {
            // 启发式：末尾不带 . 视为目录（只影响图标、server 会再 stat）
            const looksLikeDir = !pathBasename(p).includes(".");
            return (
              <span
                key={p}
                className="flex max-w-full items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs"
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
                {onRemovePath && (
                  <button
                    type="button"
                    onClick={() => onRemovePath(p)}
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-full opacity-60 hover:bg-muted hover:opacity-100"
                    aria-label="移除"
                  >
                    <X className="size-2.5" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Lexical 输入区：skill / file token + slash / @ / 提交 / 粘贴图。
          key=editorKey：切上下文（如换 task）整体重建、撤销栈不跨任务串（Bugbot 揪出） */}
      <ComposerEditor
        key={editorKey}
        editorKey={editorKey}
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        // 运行中才把「立即发送」快捷通道交给编辑器（提交偏好的对位组合）
        onSubmitNow={canSendNow ? handleSubmitNow : undefined}
        placeholder={placeholder}
        disabled={disabled}
        focusRef={focusRef}
        boxContainerRef={boxContainerRef}
        boxHeight={boxHeight}
        slash={slash}
        atMention={atForEditor}
        attach={attach}
        onPasteLongText={onPasteLongText}
      />

      {/* footer：左 slot + 右动作组（运行态原地替换、不顶布局） */}
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-0.5">
        <div className="flex min-w-0 items-center">{leading}</div>
        <div className="flex shrink-0 items-center gap-0.5">
          {running ? (
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
              {/* B 批次：立即发送（打断当前回复）——排队键旁的低调次动作 */}
              {canSendNow && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || submitting || !hasContent}
                  onClick={handleSubmitNow}
                  className="ml-1 size-7 rounded-lg p-0 text-muted-foreground hover:text-foreground"
                  aria-label="立即发送"
                  title={`立即发送（打断当前回复；${getSubmitShortcutTitle(oppositeSubmitShortcut(submitShortcut))}）`}
                >
                  <Zap className="size-3.5" />
                </Button>
              )}
              {/* chat 排队：运行中仍可发下一条 */}
              {allowQueueWhileRunning && (
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || submitting || !hasContent}
                  onClick={handleSubmit}
                  className="ml-1 size-7 rounded-lg p-0"
                  aria-label="排队发送"
                  title={`排队发送（${getSubmitShortcutTitle(submitShortcut)}）`}
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              )}
            </>
          ) : (
            <>
              {attach && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={attach.triggerFilePicker}
                  disabled={disabled || images.length >= attach.maxImages}
                  className="size-7 p-0 text-muted-foreground hover:text-foreground"
                  aria-label="附图"
                  title="附图（也支持粘贴 / 拖拽）"
                >
                  <ImagePlus className="size-3.5" />
                </Button>
              )}
              {onPickPaths && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || picking !== false}
                    onClick={() => onPickPaths("file")}
                    className="size-7 p-0 text-muted-foreground hover:text-foreground"
                    aria-label="附文件"
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
                    disabled={disabled || picking !== false}
                    onClick={() => onPickPaths("folder")}
                    className="size-7 p-0 text-muted-foreground hover:text-foreground"
                    aria-label="附目录"
                    title="附目录（agent 会用 `read` 工具看）"
                  >
                    {picking === "folder" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <FolderOpen className="size-3.5" />
                    )}
                  </Button>
                </>
              )}
              <Button
                type="button"
                size="sm"
                disabled={disabled || submitting || !hasContent}
                onClick={handleSubmit}
                className="ml-1 size-7 rounded-lg p-0"
                aria-label="发送"
                title={`发送（${getSubmitShortcutTitle(submitShortcut)}）`}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 隐藏 input：附图按钮触发它 */}
      {attach && (
        <input
          ref={attach.fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={attach.onFileInputChange}
        />
      )}
    </div>
  );
};
