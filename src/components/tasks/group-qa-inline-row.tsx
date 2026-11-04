/**
 * 群问答一轮的「事件流内联卡」：做完的旁路答疑轮次（轮次汇总事件）直接出现在主事件流里，
 * 不必切「群问答」tab 才看得到。
 *
 * 与 tab 里的卡是同一个 {@link GroupQaRoundCard}（同一份形态：普通 / 不回复 / 待你决定 / 过程），
 * 只是外面套一层事件流用的框，行首多一个「群问答」标签。
 *
 * 展开状态是行内本地态：虚拟列表把行卸载再挂回来会收起——和事件流里别的可折叠行同一个行为。
 * 找不到配对轮次（汇总缺 runTag 之类的脏数据）时调用方不走本组件，落回普通 info 细线。
 */

import { memo, useCallback, useState } from "react";

import { groupQaRoundOfSummaryEvent, type GroupQaRound } from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";

import { GroupQaRoundCard } from "./group-qa-round-card";

export const GroupQaInlineRow = memo(function GroupQaInlineRow({
  ev,
  roundsByKey,
  events,
}: {
  /** 轮次汇总事件（info + meta.groupQaSummary） */
  ev: TaskEvent;
  roundsByKey: ReadonlyMap<string, GroupQaRound>;
  /** 任务全量事件：卡片展开后的「查看过程」按 meta.groupRun 从里面挑 */
  events: readonly TaskEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const onToggle = useCallback(() => setExpanded((v) => !v), []);
  const round = groupQaRoundOfSummaryEvent(ev, roundsByKey);
  // 调用方已用同一个函数守过；防御性兜底，别在虚拟列表里抛
  if (!round) return null;
  return (
    <div className="my-1.5 overflow-hidden rounded-md border bg-card">
      <GroupQaRoundCard
        round={round}
        events={events}
        expanded={expanded}
        onToggle={onToggle}
        inline
      />
    </div>
  );
});
