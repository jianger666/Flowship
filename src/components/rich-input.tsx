"use client";

/**
 * RichInput：富输入「内核」（v1.1.x 从 composer.tsx 拆出、全站四处输入唯一实现）
 *
 * 拆分动机：推进弹窗的「指令」/ ask 答题卡的「回答」原本都是普通 textarea、跟事件流底部
 * 输入条能力差一大截（不能 `/` 唤起 skill、不能 `@` 引文件）。把「输入内核」单独抽出来、
 * 四处同一份实现、以后加能力只改这里。
 *
 * 谁在用（层次）：
 *   RichInput（本文件）
 *     ├─ ConversationComposer（会话壳：发送 / 停止 / 排队 / 模型 / 工作目录）
 *     │    ├─ event-stream.tsx（chat 输入岛 + task 事件流输入条同一个组件）
 *     │    └─ task-talk-composer.tsx（task「跟 AI 说」条）
 *     ├─ advance-dialog.tsx（推进弹窗「指令」——不要发送 / 排队那套、提交走弹窗按钮）
 *     └─ ask-user-inline.tsx（答题卡每题的「自定义回答」框）
 *
 * 内核（本文件）= 跟「输入」本身有关的一切：
 *   - 岛容器（圆角 + focus 高亮 + 拖文件落入高亮）
 *   - `/` slash 菜单 + `@` 文件菜单（浮在容器上方）
 *   - 附件预览行：图缩略（可移除 / 点看大图）+ 文件 / 目录路径 chips
 *   - Lexical 编辑器（skill / file token、提交快捷键、IME 安全、↑ 历史、粘贴转附件）
 *   - footer 右侧的附件动作组（附图 / 附文件 / 附目录）
 *
 * 外壳（调用方）= 跟「会话」有关的一切：发送 / 停止 / 排队 / 模型选择 / 工作目录 /
 * 拖高记忆 / 未绑仓警示 / 草稿存储——通过 `header` / `leading` / `trailing` 三个 slot 插进来。
 *
 * `@` 引用 / ↑ 历史依赖 ComposerSessionProvider（调用方注入 taskId + repoPaths + 历史）、
 * 没 Provider 时这两项自动关闭、其余能力照常。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  ImagePlus,
  Loader2,
  X,
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
import { pathBasename } from "@/lib/path-utils";
import type { UseImageAttachReturn } from "@/hooks/use-image-attach";

export type { ComposerFocusHandle };

export interface RichInputProps {
  /**
   * 编辑上下文标识（如 task.id）：变化时强制重建 Lexical 编辑器——
   * 撤销栈 / 内部文档树跟着上下文走、防「切 task 后 Cmd+Z 回滚出上一个任务的草稿」
   */
  editorKey?: string;
  value: string;
  /** 值变化（调用方存 state + 草稿）；slash / @ 的光标同步内核内部代办 */
  onChange: (value: string) => void;
  /** 提交快捷键触发（按设置页偏好判定；调用方自己判能不能发） */
  onSubmit: () => void;
  placeholder?: string;
  /** 整体禁用：编辑器 + 附件动作 */
  disabled?: boolean;
  /**
   * 聚焦句柄（调用方做自动聚焦 / Cmd+J）。
   * 内核也用它在 slash / @ 补全后把光标落回正确位置。
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

  /** 编辑区固定高度（px）；null = 随内容自增（上限 max-h-64） */
  boxHeight?: number | null;
  /** 量高容器（外壳拖柄读它算当前高度） */
  boxContainerRef?: RefObject<HTMLDivElement | null>;

  /** 编辑区上方 slot（外壳的拖柄 / 警示条 / 排队条 / 工作目录行） */
  header?: ReactNode;
  /** footer 左 slot（模型选择器等） */
  leading?: ReactNode;
  /** footer 右侧附加动作（发送 / 停止；附件按钮在它左边） */
  trailing?: ReactNode;
  /** 是否显示附件动作组（外壳运行态会整组换成 spinner + 停止键） */
  showAttachActions?: boolean;

  /**
   * slash / `@` 菜单开关变化。
   * 弹窗内调用方据此拦 Esc——菜单开着时 Esc 只关菜单、不能顺手把弹窗草稿关没。
   * 第二参是关菜单的手柄：拦下 Esc 的那一下必须自己把菜单关掉（焦点不在编辑器时
   * 编辑器收不到这次 Esc、光拦不关就成了死键）。
   */
  onMenuOpenChange?: (open: boolean, closeMenus: () => void) => void;

  /** 岛容器附加 class（如禁用态调暗 opacity-70） */
  className?: string;
}

export const RichInput = ({
  editorKey,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  focusRef,
  slash,
  attach,
  paths,
  onRemovePath,
  onPickPaths,
  picking = false,
  onPasteLongText,
  boxHeight = null,
  boxContainerRef,
  header,
  leading,
  trailing,
  showAttachActions = true,
  onMenuOpenChange,
  className,
}: RichInputProps) => {
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
  // 无 session 时仍创建 hook（hooks 顺序固定）、但不把菜单 / pick 接到编辑器
  const atForEditor = session ? atMention : undefined;

  // 菜单开关上报（弹窗调用方拦 Esc 用）+ 一并给出关菜单的手柄：
  // 焦点不在编辑器时（点了弹窗里别的控件）编辑器自己的 Esc 收不到，
  // 调用方拦下 Esc 后必须能主动把菜单关掉，否则 Esc 永远被拦、成死键
  const slashReset = slash?.reset;
  const atReset = atForEditor?.reset;
  const closeMenus = useCallback(() => {
    slashReset?.();
    atReset?.();
  }, [slashReset, atReset]);
  const menuOpen = !!slash?.menuOpen || !!atForEditor?.menuOpen;
  useEffect(() => {
    onMenuOpenChange?.(menuOpen, closeMenus);
  }, [menuOpen, closeMenus, onMenuOpenChange]);

  const images = attach?.images ?? [];
  const pathList = paths ?? [];
  // 上下文行只剩图 / 路径（skill / @ 已内联进文本、不再单独占一行）
  const hasContextRow = images.length > 0 || pathList.length > 0;

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

      {/* 外壳 slot：拖柄 / 警示条 / 排队条 / 工作目录行 */}
      {header}

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
                  <Folder className="size-3 shrink-0 text-muted-foreground" />
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
        onSubmit={onSubmit}
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

      {/* footer：左 slot + 右动作组（附件按钮 + 外壳传的发送 / 停止） */}
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-0.5">
        {/* `*:min-w-0` 与 DialogContent 同款兜底：slot 里塞的控件（模型选择器等）默认
            min-width:auto = 内容宽、窗口变窄时会顶穿本容器压到右侧动作组上。放开下限、
            让控件内部的 truncate 生效——新加 leading 内容不必再各自记得加 */}
        <div className="flex min-w-0 items-center *:min-w-0">{leading}</div>
        <div className="flex shrink-0 items-center gap-0.5">
          {showAttachActions && attach && (
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
          {showAttachActions && onPickPaths && (
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
          {trailing}
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
