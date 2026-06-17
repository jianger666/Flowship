"use client";

/**
 * Action 时间线（V0.6 新增、替代 V0.5 的 phase-progress）
 *
 * 渲染任务的 action 历史、按时间从左到右展示。每个 chip：
 *   - 文案：`N <ACTION_LABEL>`、如 `1 plan`
 *   - 状态色：用 ACTION_STATUS_VARIANT
 *   - 点击切换 selected 状态、父组件控制 selectedActionId
 *   - 「当前」action（task.currentActionId）多一个外圈高亮
 *   - **stale chip**（V0.6.0.1 加、用户拍板）：同 type 有更晚一次（n 更大）的 action 时、
 *     旧那一次淡化展示（opacity-50 + text-muted-foreground）、视觉表达「已被取代的旧版本」
 *     - 仅视觉降权、点击仍可下发选中、ArtifactPanel 看历史版本不受影响
 *     - 跟 status 解耦：error / cancelled 的 chip 在 stale 时同样淡化、不再用 status 单独区分
 *     - hover title 后缀「已被 #N type 取代」、用户能确认是被哪个新版本取代
 *
 * 不渲染（V0.5 phase-progress 有但 V0.6 砍）：
 *   - 「下一步推荐」chip：V0.6.0.1 起 AdvanceDialog 仅按 task 状态选默认 chip、UI 不再标推荐二字、time-line 自然也不挂这个 chip
 *   - 圆环状态机：actions 是线性时间序、不再画 plan→build→review 强绑环节
 *   - 失败 chip 上的 retry 入口：V0.6.0.1 加过一阵、用户反馈语义不清（点旧 error chip 会打断当前 running、起一个全新 action）、V0.6.0.1 末段拍板砍掉；现在统一从顶部「推进」按钮 + forceNewAgent 开关恢复
 *
 * 空态：task.actions.length === 0 时显示一行 EmptyHint「还没推进过任何 action」
 */

import { useState } from "react";
import { RotateCcw, X } from "lucide-react";

import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL_SHORT,
  ACTION_STATUS_LABEL,
} from "@/lib/task-display";
import type { ActionRecord, ActionType } from "@/lib/types";

interface Props {
  actions: ActionRecord[];
  currentActionId: string | null;
  selectedActionId: string | null;
  onSelectAction: (actionId: string) => void;
  /**
   * 划除 / 恢复某个 action（软删）——父组件实现二次确认 + 调 API。
   * 不传则不渲染划除按钮。
   */
  onToggleExclude?: (action: ActionRecord) => void;
}

const RECENT_ACTION_LIMIT = 6;

// 同 type 内 n 最大的 action 是「最新生效版本」、其他都是 stale
// 返回：actionId -> 取代它的那个 latest action（仅 stale 的 action 才有值、用于 hover title）
const computeLatestByType = (actions: ActionRecord[]): Map<ActionType, ActionRecord> => {
  const latest = new Map<ActionType, ActionRecord>();
  for (const a of actions) {
    const cur = latest.get(a.type);
    if (!cur || a.n > cur.n) latest.set(a.type, a);
  }
  return latest;
};

interface ActionChipProps {
  action: ActionRecord;
  currentActionId: string | null;
  selectedActionId: string | null;
  latestByType: Map<ActionType, ActionRecord>;
  onSelectAction: (actionId: string) => void;
  onToggleExclude?: (action: ActionRecord) => void;
}

const ActionChip = ({
  action,
  currentActionId,
  selectedActionId,
  latestByType,
  onSelectAction,
  onToggleExclude,
}: ActionChipProps) => {
  const isCurrent = action.id === currentActionId;
  const isSelected = action.id === selectedActionId;
  const isExcluded = action.excluded === true;
  const latest = latestByType.get(action.type);
  const isStale = latest !== undefined && latest.id !== action.id;
  // 多个状态修饰拼一起、用户 hover 看到能直接判断 chip 此刻意味着什么
  // 当前 = 还在跑 / 等 ack 的 action（ring 高亮）
  // stale = 已被同 type 更新一次取代（淡化）
  // excluded = 用户划除、line-through、不进 agent 上下文
  const titleParts = [
    `#${action.n} ${ACTION_LABEL_SHORT[action.type]} · ${ACTION_STATUS_LABEL[action.status]}`,
  ];
  if (isCurrent && !isSelected) {
    titleParts.push("当前 action、点可跳回");
  }
  if (isStale) {
    titleParts.push(
      `已被 #${latest!.n} ${ACTION_LABEL_SHORT[latest!.type]} 取代`,
    );
  }
  if (isExcluded) {
    titleParts.push("已划除、不进 agent 上下文");
  }
  const title =
    titleParts.length > 1
      ? `${titleParts[0]}（${titleParts.slice(1).join("、")}）`
      : titleParts[0];
  return (
    <div className="group/chip relative inline-flex items-center">
      <ChoiceButton
        shape="tab"
        selected={isSelected}
        onClick={() => onSelectAction(action.id)}
        className={cn(
          "relative",
          isCurrent && !isSelected && "ring-1 ring-primary/40",
          isStale && !isSelected && "opacity-50 text-muted-foreground",
          isExcluded && "line-through opacity-40",
        )}
        title={title}
      >
        <span className="mr-1 text-[10px] text-muted-foreground">
          #{action.n}
        </span>
        <span>{ACTION_LABEL_SHORT[action.type]}</span>
        <span
          className={cn(
            "ml-1 inline-block size-1.5 shrink-0 rounded-full",
            action.status === "completed" && "bg-emerald-500",
            action.status === "running" && "bg-amber-500 animate-pulse",
            action.status === "awaiting_ack" && "bg-blue-500",
            action.status === "error" && "bg-destructive",
            action.status === "cancelled" && "bg-muted-foreground/40",
          )}
          aria-hidden
        />
      </ChoiceButton>
      {onToggleExclude && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExclude(action);
          }}
          className={cn(
            "ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors",
            isExcluded
              ? "opacity-100 hover:text-primary"
              : "opacity-0 group-hover/chip:opacity-100 hover:text-destructive",
          )}
          title={
            isExcluded
              ? "恢复这个 action（重新纳入 agent 上下文）"
              : "划除（把这个 action 排出 agent 上下文、可恢复）"
          }
        >
          {isExcluded ? (
            <RotateCcw className="size-3" />
          ) : (
            <X className="size-3" />
          )}
        </button>
      )}
    </div>
  );
};

const EllipsisChip = ({ title }: { title: string }) => (
  <span
    className="inline-flex h-7 items-center rounded px-1.5 text-xs text-muted-foreground/60"
    title={title}
  >
    …
  </span>
);

export const ActionTimeline = ({
  actions,
  currentActionId,
  selectedActionId,
  onSelectAction,
  onToggleExclude,
}: Props) => {
  // 「查看全部」弹层开关；选中弹层里的 action 后关闭，避免用户还停在历史列表上迷路。
  const [allOpen, setAllOpen] = useState(false);

  if (actions.length === 0) {
    return (
      <EmptyHint size="sm" variant="dashed">
        还没推进过任何 action、点上方「推进」按钮开始
      </EmptyHint>
    );
  }

  const latestByType = computeLatestByType(actions);
  const recentStart = Math.max(0, actions.length - RECENT_ACTION_LIMIT);
  const recentActions = actions.slice(recentStart);
  const selectedIndex = selectedActionId
    ? actions.findIndex((a) => a.id === selectedActionId)
    : -1;
  const selectedAction = selectedIndex >= 0 ? actions[selectedIndex] : null;
  const selectedInRecent =
    !!selectedAction && recentActions.some((a) => a.id === selectedAction.id);
  const needsCollapse = actions.length > RECENT_ACTION_LIMIT;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {needsCollapse && selectedAction && !selectedInRecent && selectedIndex > 0 && (
        <EllipsisChip title={`已折叠 #1-#${selectedAction.n - 1} action`} />
      )}
      {needsCollapse && selectedAction && !selectedInRecent && (
        <ActionChip
          action={selectedAction}
          currentActionId={currentActionId}
          selectedActionId={selectedActionId}
          latestByType={latestByType}
          onSelectAction={onSelectAction}
          onToggleExclude={onToggleExclude}
        />
      )}
      {needsCollapse && (
        <EllipsisChip
          title={
            selectedAction && !selectedInRecent
              ? "已折叠中间历史 action"
              : `已折叠前 ${recentStart} 个 action`
          }
        />
      )}
      {(needsCollapse ? recentActions : actions).map((action) => (
        <ActionChip
          key={action.id}
          action={action}
          currentActionId={currentActionId}
          selectedActionId={selectedActionId}
          latestByType={latestByType}
          onSelectAction={onSelectAction}
          onToggleExclude={onToggleExclude}
        />
      ))}
      {needsCollapse && (
        <Popover open={allOpen} onOpenChange={setAllOpen}>
          <PopoverTrigger
            aria-label={`查看全部 ${actions.length} 个 action`}
            className="inline-flex h-7 cursor-pointer items-center rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            title="查看全部 action"
          >
            查看全部 ({actions.length})
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 max-w-[80vw] p-2">
            <div className="mb-2 px-1 text-xs text-muted-foreground">
              全部 action
            </div>
            <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {actions.map((action) => (
                <ActionChip
                  key={action.id}
                  action={action}
                  currentActionId={currentActionId}
                  selectedActionId={selectedActionId}
                  latestByType={latestByType}
                  onSelectAction={(actionId) => {
                    onSelectAction(actionId);
                    setAllOpen(false);
                  }}
                  onToggleExclude={onToggleExclude}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
};
