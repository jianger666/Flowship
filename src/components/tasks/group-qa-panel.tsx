/**
 * 群问答 tab（一轮一行：时间 / 谁问的 / 一行回答，点击展开看问答全文）。
 *
 * 数据源 {@link collectGroupQaRounds}：只读呈现，不发任何请求。
 * 进行中的轮次显示“回答中…”；历史数据 temporal 配对的挂“历史”标（口径可能串，仅供参考）。
 *
 * 2026-10-14 群协作 v2：
 * - 顶部「待你决定」区：答疑 agent 标了「需属主确认」的轮次（近 24h）汇总在这里，点一条展开对应轮次；
 * - 单轮的形态（机器人徽标 / 不回复淡化 / 用时 / 已 @ 谁 / 查看过程）见 group-qa-round-card。
 */

import { CircleAlert } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { pickRoundsNeedingOwner, type GroupQaRound } from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";

import {
  GroupQaAsker,
  GroupQaRoundCard,
  groupQaRoundDomId,
} from "./group-qa-round-card";

/** events 不传时的稳定空数组（默认值写 `[]` 每次渲染都是新引用，会让子组件 memo 白做） */
const NO_EVENTS: readonly TaskEvent[] = [];

/**
 * 范围说明条：事件只加载了最近一段时，群问答与「待你决定」只统计已加载的部分（D8-01）。
 * 不是虚拟列表里的卡片，role=status 可用；入口复用事件流的上拉分页（加载后轮次自动重算）。
 */
const GroupQaScopeNotice = ({
  text,
  onLoadEarlier,
  loading,
}: {
  text: string;
  onLoadEarlier?: () => void;
  loading?: boolean;
}) => (
  <div
    role="status"
    className="mx-4 mt-2 mb-1 flex items-center gap-2 text-[11px] text-muted-foreground"
  >
    <span className="min-w-0 flex-1 wrap-anywhere">{text}</span>
    {onLoadEarlier && (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={loading}
        onClick={onLoadEarlier}
        className="shrink-0"
      >
        {loading ? "加载中…" : "加载更早的"}
      </Button>
    )}
  </div>
);

export const GroupQaPanel = memo(function GroupQaPanel({
  rounds,
  events = NO_EVENTS,
  scopeNotice = null,
  onLoadEarlier,
  loadingEarlier,
}: {
  rounds: GroupQaRound[];
  /** 统计范围说明（{@link deriveGroupQaScope}）；null = 窗口完整，不显示 */
  scopeNotice?: string | null;
  /** 「加载更早的」入口；不传 = 只提示、不给按钮 */
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  /**
   * 任务全量事件（可选）：展开详情里「查看过程」按 meta.groupRun === round.key 从中挑选。
   * 不传 = 不显示过程块，其余功能照常。
   */
  events?: readonly TaskEvent[];
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const needOwner = useMemo(() => pickRoundsNeedingOwner(rounds), [rounds]);
  // 点「待你决定」里的一条：展开该轮并滚到可见（列表可能很长，光展开用户看不到）
  const pickRound = useCallback((key: string) => {
    setExpandedKey(key);
    requestAnimationFrame(() => {
      document
        .getElementById(groupQaRoundDomId(key))
        ?.scrollIntoView({ block: "nearest" });
    });
  }, []);
  const notice = scopeNotice ? (
    <GroupQaScopeNotice
      text={scopeNotice}
      onLoadEarlier={onLoadEarlier}
      loading={loadingEarlier}
    />
  ) : null;
  if (rounds.length === 0) {
    // 窗口被截过时进到这里（tab 因绑了群而出现）：不能说「还没有」，只能说已加载的里没有
    if (notice) {
      return <div className="h-full overflow-y-auto py-1">{notice}</div>;
    }
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        还没有群问答
      </div>
    );
  }
  return (
    <div className="h-full overflow-x-hidden overflow-y-auto py-1">
      {notice}
      {needOwner.length > 0 && (
        <section
          aria-label="待你决定"
          className="mx-4 mt-2 mb-1 rounded-md border border-brand/40 bg-brand/[0.06] px-3 py-2.5"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-brand">
            <CircleAlert aria-hidden className="size-3.5" />
            待你决定（{needOwner.length}）
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {needOwner.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => pickRound(r.key)}
                  className="flex w-full cursor-pointer items-baseline gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-brand/10"
                >
                  <GroupQaAsker name={r.askerName} isBot={r.askerIsBot} />
                  <span className="min-w-0 flex-1 text-xs wrap-anywhere whitespace-pre-wrap text-foreground">
                    {r.needsOwner}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rounds.map((r) => (
        <GroupQaRoundCard
          key={r.key}
          round={r}
          events={events}
          expanded={expandedKey === r.key}
          onToggle={() => setExpandedKey((k) => (k === r.key ? null : r.key))}
        />
      ))}
    </div>
  );
});
