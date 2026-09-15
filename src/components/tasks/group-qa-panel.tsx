/**
 * 群问答 tab（一轮一行：时间 / 谁问的 / 一行回答，点击展开看问答全文）。
 *
 * 数据源 {@link collectGroupQaRounds}：只读呈现，不发任何请求。
 * 进行中的轮次显示“回答中…”；历史数据 temporal 配对的挂“历史”标（口径可能串，仅供参考）。
 */

import { memo, useState } from "react";

import { MarkdownText } from "@/components/markdown-text";
import {
  formatGroupQaTs,
  oneLineAnswer,
  type GroupQaRound,
} from "@/lib/group-qa";
import { cn } from "@/lib/utils";

const RoundRow = memo(function RoundRow({
  round,
  expanded,
  onToggle,
}: {
  round: GroupQaRound;
  expanded: boolean;
  onToggle: () => void;
}) {
  const oneLine = round.answerText
    ? oneLineAnswer(round.answerText)
    : round.answering
      ? "回答中…"
      : "未收到回答";
  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left hover:bg-muted/40"
      >
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {formatGroupQaTs(round.ts)}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-xs font-medium">
            {round.askerName}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              round.answerText
                ? "text-muted-foreground"
                : "text-muted-foreground/60 italic",
            )}
          >
            {oneLine}
          </span>
        </span>
        {round.legacy && (
          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
            历史
          </span>
        )}
        {!round.ok && round.answerText && (
          <span className="shrink-0 rounded bg-destructive/10 px-1 text-[10px] text-destructive">
            失败
          </span>
        )}
        <span
          className={cn(
            "shrink-0 text-[10px] text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        >
          ▶
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 px-4 pb-3 pl-4">
          {round.askerOpenId && (
            <div className="text-[10px] tabular-nums text-muted-foreground/70">
              {round.askerOpenId}
            </div>
          )}
          {round.questionText && (
            <div className="border-l-2 border-border pl-2 text-xs whitespace-pre-wrap text-foreground/90">
              {round.questionText}
            </div>
          )}
          {round.answerText ? (
            <MarkdownText text={round.answerText} />
          ) : (
            <div className="text-xs text-muted-foreground/60 italic">
              {round.answering ? "正在回答…" : "未收到回答"}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export const GroupQaPanel = memo(function GroupQaPanel({
  rounds,
}: {
  rounds: GroupQaRound[];
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  if (rounds.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        还没有群问答
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto py-1">
      {rounds.map((r) => (
        <RoundRow
          key={r.key}
          round={r}
          expanded={expandedKey === r.key}
          onToggle={() => setExpandedKey((k) => (k === r.key ? null : r.key))}
        />
      ))}
    </div>
  );
});
