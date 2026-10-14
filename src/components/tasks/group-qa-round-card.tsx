/**
 * 群问答一轮的卡片（一行摘要 + 展开详情），从 group-qa-panel 拆出来：
 * 面板只管「待你决定」汇总 + 列表编排，单轮的各种形态（普通 / 不回复 / 待属主决定 / 过程）收在这里。
 *
 * 三种形态：
 * - 普通轮：时间 / 提问人 / 一行回答；展开看问答全文
 * - noReply 轮（答疑 agent 选择不回复）：淡化成一行「已读、无需回复」，不抢注意力；
 *   点开仍能看到 agent 原话（审计用）
 * - needsOwner 轮：行上带「待你决定」标，展开后顶部是醒目的说明块（brand = 「等你行动」信号族）
 *
 * 老数据（汇总事件没有新字段）一律落在「普通轮」形态，不会误判成不回复 / 机器人。
 */

import { ChevronRight, CircleAlert, MessageSquareText, Wrench } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { MarkdownText } from "@/components/markdown-text";
import { Badge } from "@/components/ui/badge";
import { formatDurationCoarse } from "@/lib/duration-display";
import {
  collectGroupRunSteps,
  formatGroupQaTs,
  oneLineAnswer,
  type GroupQaRound,
} from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CollapseChevron } from "./event-stream/stream-style";

/** 卡片根节点的 DOM id（待决定区点击后据此滚到对应卡片） */
export const groupQaRoundDomId = (key: string): string => `group-qa-round-${key}`;

/** 提问人名字 + 机器人徽标（待决定区与卡片行共用，保证两处长得一样） */
export const GroupQaAsker = ({
  name,
  isBot,
}: {
  name: string;
  isBot?: boolean;
}) => (
  <span className="inline-flex shrink-0 items-center gap-1">
    <span className="text-xs font-medium">{name}</span>
    {isBot === true && (
      <Badge variant="secondary" size="xs">
        机器人
      </Badge>
    )}
  </span>
);

/**
 * 「查看过程（n 步）」：该轮答疑 run 的精简过程（旁白首行 / 工具名 + 参数摘要 / 错误）。
 * 只在展开且 events 里真有这轮的过程事件时渲染；thinking 不展示。
 * 步骤只在点开「查看过程」时才算（collectGroupRunSteps 要扫全量事件，别在每次渲染都跑）。
 */
const RunSteps = memo(function RunSteps({
  runTag,
  events,
}: {
  runTag: string;
  events: readonly TaskEvent[];
}) {
  const [open, setOpen] = useState(false);
  const { steps, total } = useMemo(
    () => collectGroupRunSteps(events, runTag),
    [events, runTag],
  );
  if (total === 0) return null;
  const more = total - steps.length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <CollapseChevron open={open} />
        查看过程（{total} 步）
      </button>
      {open && (
        <ul className="mt-1 ml-1.5 space-y-1 border-l border-border pl-3">
          {steps.map((s) => (
            <li key={s.id} className="flex items-baseline gap-1.5 text-xs">
              {s.kind === "tool" ? (
                <Wrench
                  aria-hidden
                  className="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
                />
              ) : s.kind === "error" ? (
                <CircleAlert
                  aria-hidden
                  className="size-3 shrink-0 translate-y-0.5 text-destructive"
                />
              ) : (
                <MessageSquareText
                  aria-hidden
                  className="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
                />
              )}
              {s.kind === "tool" && (
                <span className="shrink-0 font-mono text-[11px] text-foreground">
                  {s.tool}
                </span>
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  s.kind === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {s.text}
              </span>
            </li>
          ))}
          {more > 0 && (
            <li className="text-[11px] text-muted-foreground">还有 {more} 条</li>
          )}
        </ul>
      )}
    </div>
  );
});

export const GroupQaRoundCard = memo(function GroupQaRoundCard({
  round,
  expanded,
  onToggle,
  events,
}: {
  round: GroupQaRound;
  expanded: boolean;
  onToggle: () => void;
  /** 任务全量事件：「查看过程」按 meta.groupRun === round.key 从里面挑；不传则不显示过程块 */
  events: readonly TaskEvent[];
}) {
  const noReply = round.noReply === true;
  const needsOwner = round.needsOwner?.trim() ? round.needsOwner.trim() : "";
  const duration = formatDurationCoarse(round.durationMs);
  const mentioned = round.mentioned ?? [];
  const oneLine = noReply
    ? "已读、无需回复"
    : round.answerText
      ? oneLineAnswer(round.answerText)
      : round.answering
        ? "回答中…"
        : "未收到回答";
  return (
    <div
      id={groupQaRoundDomId(round.key)}
      className="border-b border-border/50 last:border-b-0"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left hover:bg-muted/40"
      >
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {formatGroupQaTs(round.ts)}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <GroupQaAsker name={round.askerName} isBot={round.askerIsBot} />
          {/* noReply 行降到 11px 档：一行带过、不跟「有实质回答」的行抢视觉 */}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-muted-foreground",
              noReply ? "text-[11px]" : "text-xs",
              (!round.answerText || noReply) && "italic",
            )}
          >
            {oneLine}
          </span>
        </span>
        {needsOwner && (
          <span className="shrink-0 rounded-sm bg-brand/10 px-1 text-[11px] font-medium text-brand">
            待你决定
          </span>
        )}
        {round.legacy && (
          <Badge variant="secondary" size="xs">
            历史
          </Badge>
        )}
        {!round.ok && round.answerText && !noReply && (
          <Badge variant="destructive" size="xs">
            失败
          </Badge>
        )}
        {duration && (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
            {duration}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 translate-y-0.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="space-y-2 px-4 pb-3 pl-4">
          {(round.askerOpenId || mentioned.length > 0) && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              {round.askerOpenId && (
                <span className="tabular-nums">{round.askerOpenId}</span>
              )}
              {mentioned.length > 0 && (
                <span>已 @ {mentioned.join("、")}</span>
              )}
            </div>
          )}
          {needsOwner && (
            <div className="rounded-md border border-brand/40 bg-brand/[0.06] px-2.5 py-2 text-xs">
              <div className="mb-0.5 flex items-center gap-1 font-medium text-brand">
                <CircleAlert aria-hidden className="size-3" />
                需要你决定
              </div>
              <div className="whitespace-pre-wrap text-foreground">
                {needsOwner}
              </div>
            </div>
          )}
          {round.questionText && (
            <div className="border-l-2 border-border pl-2 text-xs whitespace-pre-wrap text-foreground/90">
              {round.questionText}
            </div>
          )}
          {noReply ? (
            <div className="space-y-0.5">
              <div className="text-[11px] text-muted-foreground">
                答疑 agent 选择不回复，群里没有发任何内容。它的原话：
              </div>
              <div className="rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-foreground">
                {round.answerText.trim() || "（无）"}
              </div>
            </div>
          ) : round.answerText ? (
            <MarkdownText text={round.answerText} />
          ) : (
            <div className="text-xs text-muted-foreground italic">
              {round.answering ? "正在回答…" : "未收到回答"}
            </div>
          )}
          {!round.legacy && <RunSteps runTag={round.key} events={events} />}
        </div>
      )}
    </div>
  );
});
