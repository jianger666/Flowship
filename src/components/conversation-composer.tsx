/**
 * ConversationComposer：会话输入壳（v1.1.x、用户点名「封装一个高级的输入框、chat / task 都复用」）
 *
 * 层次：`RichInput`（输入内核、见 rich-input.tsx）+ 本文件（会话外壳）。
 * chat 输入岛（event-stream chat 变体）与 task「跟 AI 说」条都用本组件——
 * 差异全部走 props 开关（排队 / 停止 / 模型 slot / 工作目录行），不复制组件。
 * 推进弹窗 / ask 答题卡只用内核、不进这一层（它们的提交按钮是自己的）。
 *
 * 本文件只剩贴底输入岛专属的东西：
 * - 顶边拖柄：往上拉变高（贴底输入条的直觉方向）、高度记全局偏好
 * - 未绑仓警示条 / 排队提示条 / 岛顶配置行（工作目录 / 分支）
 * - footer 右侧发送键；运行态原地换成 spinner + 红色停止键（不顶布局）、可选排队发送
 *
 * 状态归调用方（草稿 / 附件 hook / slash / 提交逻辑）、本组件只管交互和视觉——
 * 两个调用方各自的业务分支（disabled 判定 / placeholder / 发送通道）不进来。
 * `@` / 历史 / 未绑仓警示读 ComposerSessionProvider（ChatView / TaskTalk 注入）。
 */

"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUp, Info, Loader2, Square } from "lucide-react";

import {
  RichInput,
  type ComposerFocusHandle,
} from "@/components/rich-input";
import type { SlashSkillsApi } from "@/components/slash-skills";
import { useComposerSession } from "@/components/composer-session";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { composerSubmitBlock, deriveComposerActions } from "@/lib/composer-actions";
import { getSubmitShortcutTitle } from "@/lib/submit-shortcut";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { loadBoxHeight, saveBoxHeight } from "@/lib/view-memory";
import type { UseImageAttachReturn } from "@/hooks/use-image-attach";

// 拖高上下界（px）：下界 = 默认两行高、上界防把上方内容顶没
const MIN_BOX_HEIGHT = 52;
const MAX_BOX_HEIGHT = 400;
// 提交在途按 Enter 的「正在发送…」提示停留时长（ms）
const SEND_HINT_MS = 1500;

export type { ComposerFocusHandle };

export interface ConversationComposerProps {
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
  /**
   * 请求飞行中（跟 running 的区别：这是「提交这条」的短暂态）：发送键转圈、提示「发送中」并禁用防连点；
   * 编辑器本身不锁（调用方的 disabled 不应折进它，第三轮 review D7-03）。
   * 运行态下转圈归发送键、左侧「AI 在跑」的圈让出——同屏只留一个（见 lib/composer-actions）。
   */
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
  /**
   * 只多出停止键（后台子代理还在跑、主 AI 空闲）：不改发送键 / 附件 / 转圈的语义（第三轮 review R3-02）。
   * 已经是 running 时无意义（运行态自带停止键）。
   */
  stopOnly?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  /** 停止键 tooltip（不传 = 「停止生成（中断 agent）」）；停止还会连带取消后台子代理时由调用方点明 */
  stopLabel?: string;

  /**
   * chat 排队：运行中仍可发送（footer 同时显示停止 + 发送）。
   * 不传 / false = 旧行为（运行中只显示停止）。
   */
  allowQueueWhileRunning?: boolean;
  /** 输入区上方排队提示条 */
  queueBanner?: ReactNode;

  /** 岛容器附加 class（如禁用态降低边框 / 底色对比；⛔ 不要整体压 opacity，文字 / placeholder 会掉到 AA 以下） */
  className?: string;

  /** 输入框的可访问名称（调用方必传、同屏互不重名；N2-06） */
  ariaLabel?: string;
}

export const ConversationComposer = ({
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
  stopOnly,
  onStop,
  stopping,
  stopLabel,
  allowQueueWhileRunning,
  queueBanner,
  ariaLabel,
  className,
}: ConversationComposerProps) => {
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

  const images = attach?.images ?? [];
  const pathList = paths ?? [];
  const hasContent =
    value.trim().length > 0 || images.length > 0 || pathList.length > 0;

  // 提交在途时按 Enter：被拦下（防双发）不能静默——给一点轻反馈（Q6-10）：发送键旁短暂写「正在发送…」，
  // 与发送键的转圈 / tooltip「发送中」同口径（D7-03）；提交一落地（submitting 变 false）提示立刻消失
  const [sendHint, setSendHint] = useState(false);
  const sendHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sendHintTimerRef.current) clearTimeout(sendHintTimerRef.current);
    },
    [],
  );
  const flashSendHint = () => {
    setSendHint(true);
    if (sendHintTimerRef.current) clearTimeout(sendHintTimerRef.current);
    sendHintTimerRef.current = setTimeout(() => setSendHint(false), SEND_HINT_MS);
  };

  const handleSubmit = () => {
    const block = composerSubmitBlock({ disabled, submitting, hasContent });
    if (block === "submitting") flashSendHint();
    if (block) return;
    onSubmit();
  };

  const showUnbound =
    !!session?.showUnboundBanner && (session.repoPaths?.length ?? 0) === 0;

  // 右侧动作组的决策（附件 / 转圈 / 停止 / 发送）收在 lib/composer-actions：
  // 提交飞行中发送键转圈并提示「发送中」（D7-03），stopOnly 只多一个停止键（R3-02）
  const actions = deriveComposerActions({
    running: !!running,
    stopOnly: !!stopOnly,
    submitting: !!submitting,
    allowQueueWhileRunning: !!allowQueueWhileRunning,
  });

  // 发送键：运行态排队发送与常态发送共用。提交飞行中禁用防连点 + 转圈 + tooltip「发送中」；
  // 转圈只有这一个（运行态左侧「AI 在跑」的圈此时让出，见 deriveComposerActions）。
  const sendButton = (send: NonNullable<typeof actions.send>) => (
    <Tooltip
      content={
        submitting
          ? send.tip
          : `${send.tip}（${getSubmitShortcutTitle(submitShortcut)}）`
      }
    >
      <span className="inline-flex">
        <Button
          type="button"
          size="sm"
          disabled={composerSubmitBlock({ disabled, submitting, hasContent }) !== null}
          onClick={handleSubmit}
          className="ml-1 size-7 rounded-lg p-0"
          aria-label={send.tip}
        >
          {send.spinning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
      </span>
    </Tooltip>
  );

  // 停止键：运行态与 stopOnly 共用（停止不受 disabled 管——受理前点停止走「登记意图」）
  const stopButton = (
    <Tooltip content={stopLabel ?? "停止生成（中断 agent）"}>
      <span className="inline-flex">
        <Button
          type="button"
          size="sm"
          onClick={onStop}
          disabled={stopping}
          // 停止键文字色：项目没有 --destructive-foreground，用 text-primary-foreground——
          // 浅色近白（在 destructive 上约 4.6:1）、深色近黑（在暗色 destructive 上约 6.1:1，oklch 换算）；
          // 原来写死 text-white 在暗色下只有 2.89:1（V13-08）
          className="ml-1 size-7 rounded-lg bg-destructive p-0 text-primary-foreground hover:bg-destructive/90"
          aria-label="停止"
        >
          {stopping ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Square className="size-3 fill-current" />
          )}
        </Button>
      </span>
    </Tooltip>
  );

  return (
    <RichInput
      editorKey={editorKey}
      value={value}
      onChange={onChange}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      disabled={disabled}
      focusRef={focusRef}
      slash={slash}
      attach={attach}
      paths={paths}
      onRemovePath={onRemovePath}
      onPickPaths={onPickPaths}
      picking={picking}
      onPasteLongText={onPasteLongText}
      ariaLabel={ariaLabel}
      boxHeight={boxHeight}
      boxContainerRef={boxContainerRef}
      // 运行态整组换成 spinner + 停止键、附件按钮让位（stopOnly 不让位——它只多一个停止键）
      showAttachActions={actions.showAttach}
      className={className}
      header={
        <>
          {/* 顶边拖柄：往上拉变高、往下拉变矮；setPointerCapture 让拖出手柄仍跟手 */}
          <Tooltip content="上下拖动调整高度">
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
          >
            <div className="h-1 w-10 rounded-full bg-border/60 transition-colors group-hover:bg-muted-foreground/50" />
          </div>
          </Tooltip>

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
        </>
      }
      leading={leading}
      trailing={
        <>
          {/* running = info（项目约定：进行中只用 text-info，跟状态行 / 组头 spinner 同色）；
              提交飞行中转圈归发送键，这里让出（同屏只留一个圈） */}
          {actions.runSpinner && (
            <Loader2 className="size-3.5 animate-spin text-info" />
          )}
          {actions.stopButton && stopButton}
          {/* 提交在途又按了 Enter（被防双发拦下）：轻提示「正在发送…」（读屏播报；提交落地即消失，Q6-10） */}
          {sendHint && submitting && (
            <span role="status" className="text-xs text-muted-foreground">
              正在发送…
            </span>
          )}
          {/* 常态「发送」；chat 运行态仍可排队发下一条（「排队发送」） */}
          {actions.send && sendButton(actions.send)}
        </>
      }
    />
  );
};
