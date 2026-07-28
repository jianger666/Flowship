"use client";

/**
 * 错误卡（2026-07-28 事件流体验第二批）
 *
 * 以前 error 事件的三个毛病叠在一起：进「工作过程」组 → run 一结束整组自动收起、
 * 用户正在读的错误啪一下消失；视觉权重跟 thinking 一样是条灰细行；runner 明明把原始
 * 诊断写进了 `meta.detail`（见 sdk-error.ts）、UI 从来没读过。跑了 40 分钟的 build 挂了，
 * 用户只能看到一行灰字，分不清是网断了、key 过期了还是 worktree 锁没了。
 *
 * 现在：error 不进组（见 lib/chat-turns.ts 的 MEMBER_KINDS）、独立平铺成这张卡——
 * destructive 边框 + 底衬给足视觉权重，原始诊断可展开，一键复制整份，
 * 当轮失败还能直接重试（= 把最后一条用户消息原样再发）。
 */

import { useState } from "react";
import { ChevronDown, CircleAlert, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { isLatestErrorEvent } from "@/lib/chat-turns";
import type { TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

import { useStreamActions } from "./stream-actions";
import { ActionTag, EVENT_LABEL, formatTs } from "./utils";

/** 原始诊断段的分隔标题（复制出去时也带上、贴给别人一眼分得清哪段是哪段） */
const DETAIL_HEADING = "--- 原始诊断 ---";

export const ErrorCard = ({
  ev,
  events,
  runActive,
  actionTag,
}: {
  ev: TaskEvent;
  /** 整条事件流：判断这条错误是不是「当轮失败」（决定给不给重试入口） */
  events: readonly TaskEvent[];
  /** agent 正在跑：这条错误已经翻篇、不给重试 */
  runActive?: boolean;
  /** log 形态的 action 归属标（plan / build / …），chat 形态不传 */
  actionTag?: string;
}) => {
  // 原始诊断展开态：默认收起（正文那句友好文案已够日常判断、详情是排查时才看）
  const [detailOpen, setDetailOpen] = useState(false);
  // 重试飞行中：按钮 spinner + 禁用，防连点发两条
  const [retrying, setRetrying] = useState(false);
  // 重试能力由 ChatView 通过 Context 注入；log 形态（task 详情页）没有 Provider = 不显示
  const streamActions = useStreamActions();

  const detail =
    typeof ev.meta?.detail === "string" ? ev.meta.detail.trim() : "";
  // 有诊断、且不等于正文才值得单开一段（连接断那种正文是友好文案、detail 才是原始串）
  const hasDetail = !!detail && detail !== ev.text.trim();
  const copyText = hasDetail
    ? `${ev.text}\n\n${DETAIL_HEADING}\n${detail}`
    : ev.text;

  // 只有「当轮失败」给重试：重试发的是最后一条用户消息，翻历史时点旧错误上的重试
  // 会把今天最后那条消息重发出去、完全不是用户预期
  const canRetry =
    !!streamActions?.onRetryLastMessage &&
    !runActive &&
    isLatestErrorEvent(events, ev.id);

  const handleRetry = () => {
    if (retrying || !streamActions?.onRetryLastMessage) return;
    setRetrying(true);
    void (async () => {
      try {
        await streamActions.onRetryLastMessage?.();
      } finally {
        setRetrying(false);
      }
    })();
  };

  return (
    <div className="mt-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-destructive">
              {EVENT_LABEL.error}
            </span>
            {actionTag && <ActionTag label={actionTag} />}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatTs(ev.ts)}
            </span>
          </div>
          {/* whitespace-pre-wrap：正文可能是多行结构（如 wk 门禁「结论 + 逐条明细」），
              不保留换行会被压成一团、明细完全没法读 */}
          <div className="mt-1 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground">
            {ev.text}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {hasDetail && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDetailOpen((v) => !v)}
              >
                查看详情
                <ChevronDown
                  className={cn(
                    "transition-transform",
                    detailOpen && "rotate-180",
                  )}
                />
              </Button>
            )}
            {/* 复制走公共件（勾号反馈 / 失败提示都在里面）；p-1.5 对齐旁边 xs 按钮的 h-6 */}
            <CopyButton text={copyText} label="复制错误" className="p-1.5" />
            {canRetry && (
              <Button
                variant="destructive"
                size="xs"
                disabled={retrying}
                onClick={handleRetry}
              >
                <RotateCcw className={cn(retrying && "animate-spin")} />
                重试
              </Button>
            )}
          </div>
          {detailOpen && hasDetail && (
            // 诊断串常含无空格长 JSON / 路径：wrap-anywhere + 限高滚动，别把卡片撑爆
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground wrap-anywhere">
              {detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
