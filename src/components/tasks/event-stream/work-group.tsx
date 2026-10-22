"use client";

/**
 * 工作过程组折叠行（CHAT-REDESIGN Batch B）
 *
 * 把 turn 内正文之前的 thinking / 工具调用收成一行摘要；
 * running 自动展开、完成后自动收起；用户手动 toggle 后以手动为准。
 * error 事件**不**进组（2026-07-28）——自动收起会把用户正在读的错误吃掉、见 lib/chat-turns.ts。
 * 本文件只交付组件，Batch C 再接到 event-stream items 管线。
 */

import { memo, useMemo, useRef } from "react";
import { Loader2, TriangleAlert, X } from "lucide-react";

import { usePaneSearchHighlight } from "@/components/ui/pane-search-highlight-context";
import { Tooltip } from "@/components/ui/tooltip";
import { useRowViewState } from "@/hooks/use-row-view-state";
import { useStreamFollowContext } from "@/hooks/use-stream-follow";
import {
  PROCESSING_PLACEHOLDER_LABEL,
  groupHasBootWarn,
  isBootInfoItem,
  isLiveThinkingEvent,
  type WorkGroupItem,
} from "@/lib/chat-turns";
import { formatDurationCoarse } from "@/lib/duration-display";
import { ROW_VIEW_FIELD, workGroupViewKey } from "@/lib/row-view-keys";
import { shouldPinWorkGroupOpen } from "@/lib/scroll-follow";
import {
  isToolBlock,
  isToolVerbGroup,
  streamItemStableId,
  type StreamRenderItem,
} from "@/lib/tool-display";
import type { Task, TaskEvent } from "@/lib/types";
import {
  workGroupMemberPropsEqual,
  type WorkGroupMemberCmpProps,
} from "@/lib/work-group-member";
import { cn } from "@/lib/utils";

import { Collapse } from "./collapse";
import { EventRow } from "./rows";
import { CollapseChevron, PROCESS_ROW_BUTTON } from "./stream-style";
import { ToolBlockRow, ToolVerbGroupRow } from "./tool-block";

// ---------- 耗时 / 活动摘要 ----------

/** 组头耗时：口径（秒级密度、<1s 不显示）收在 lib/duration-display、跟事件流其它耗时同源 */
const formatGroupDuration = (startTs: number, endTs: number): string | null =>
  formatDurationCoarse(Math.max(0, endTs - startTs));

/**
 * 折叠且 running 时右侧活动摘要：从末尾找最近一个 running 工具名即可。
 * 不追 liveOutput、不拼复杂文案——组头要极淡不抢戏。
 */
const lastRunningName = (members: StreamRenderItem[]): string | null => {
  for (let i = members.length - 1; i >= 0; i--) {
    const m = members[i]!;
    if (isToolBlock(m) && m.status === "running") return m.name;
    if (isToolVerbGroup(m)) {
      for (let j = m.members.length - 1; j >= 0; j--) {
        const child = m.members[j]!;
        if (child.status === "running") return child.name;
      }
    }
  }
  return null;
};

// ---------- 成员渲染 ----------

const WorkGroupMemberImpl = ({
  member,
  taskId,
  task,
  variant,
  liveOutput,
}: WorkGroupMemberCmpProps) => {
  if (isToolBlock(member)) {
    return (
      <ToolBlockRow block={member} taskId={taskId} liveOutput={liveOutput} />
    );
  }
  if (isToolVerbGroup(member)) {
    return <ToolVerbGroupRow group={member} taskId={taskId} />;
  }
  // thinking（assistant 插话 / error 都不进组、各自独立平铺）→ EventRow 细行分支
  return (
    <div data-search-owner-id={(member as TaskEvent).id}>
      <EventRow
        ev={member as TaskEvent}
        taskId={taskId}
        task={task}
        variant={variant}
      />
    </div>
  );
};

/**
 * 成员行 memo（D5-01）：展开的运行中尾组每个事件 / 每个输出增量，宿主传下来的 `task` 与 `liveToolOutputs`
 * 整体都换新对象，不拦的话几百个成员每次整组重渲。比较规则见 lib/work-group-member。
 * 前提是成员对象引用稳定（mergeToolDisplayEvents / buildWorkGroup 的缓存保证，见 tests/tool-block-ref-stability.test.ts）。
 */
const WorkGroupMember = memo(WorkGroupMemberImpl, workGroupMemberPropsEqual);

// ---------- WorkGroupRow ----------

/** 工具都完成后的空等：转圈挂在这一行，不让 write 一直像没结束 */
const ProcessingPlaceholderRow = () => (
  <div className="flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
    <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
    <span>{PROCESSING_PLACEHOLDER_LABEL}</span>
  </div>
);

const WorkGroupRowImpl = ({
  group,
  taskId,
  task,
  variant = "chat",
  liveToolOutputs,
  isRunningTail,
  showProcessingPlaceholder,
  defaultExpanded = false,
}: {
  group: WorkGroupItem;
  taskId: string;
  task: Task;
  /** 宿主形态（成员 EventRow 渲染跟随；组头样式两形态同款） */
  variant?: "log" | "chat";
  /** callId → 直播输出（透传给成员 ToolBlockRow） */
  liveToolOutputs?: Record<string, string>;
  /** 本组是全流最后一个组且 agent 正在 running（展开判定用） */
  isRunningTail?: boolean;
  /** 流尾空等：write 已完成、下一句还没出来 */
  showProcessingPlaceholder?: boolean;
  /**
   * 默认就展开（完成后也不自动收起；用户手动点过仍以手动为准）。
   * 给「专门来看过程」的场景用——子代理详情面板：打开它就是为了看干了什么，不该再多点一下。
   */
  defaultExpanded?: boolean;
}) => {
  // null = 未手动干预，跟随 autoExpanded；boolean = 用户点过，以手动为准。
  // 走 useRowViewState（V2-05）：行被虚拟列表卸载再滚回来，用户手动展开 / 收起的结果不能丢。
  // 组 id = 第一个成员的「稳定身份」（lib/chat-turns buildWorkGroup → streamItemStableId）：
  // 后面追加成员不变；读类工具连续完成（单块并成 verb 组）、连续待办合并时也不变——
  // 不是「第一个成员的 id」（那个会变，组级状态按旧 id 存、翻 id 后整组 remount 并丢状态，R4-01）。
  // 分页补页让组向前长出更早成员时首成员换了、组 id 会随之换，这是已知限制。
  const [manual, setManual] = useRowViewState<boolean | null>(
    workGroupViewKey(taskId, group, ROW_VIEW_FIELD.workManual),
    null,
  );
  // 「钉住展开」闩锁（见下面 shouldPinWorkGroupOpen）：原来是 useRef，行一卸载就清零——用户没跟随时
  // 看着自动展开的组跑完被钉住、滚走再滚回来又被收起，等于白钉。同样进存档。
  const [pinnedOpen, setPinnedOpen] = useRowViewState<boolean>(
    workGroupViewKey(taskId, group, ROW_VIEW_FIELD.workPinned),
    false,
  );

  // 全启动链成员（唤醒/工作区/agent/MCP 跳过）→ 标题写「启动过程」别写「工作过程」。
  // 启动组永不自动展开（2026-09-24）：4 行 boot 提示运行时全弹出来太吵；
  // 组头本来就带 live 状态（runningTail 显示当前阶段 + 转圈），折叠零信息损失，
  // 警告靠 ⚠️ 标，想看点开展开。手动点过 / 搜索命中照常展开。
  const allBoot =
    group.members.length > 0 &&
    group.members.every((m) => isBootInfoItem(m));
  const autoExpanded =
    !allBoot && (group.hasRunning || !!isRunningTail || defaultExpanded);

  // 自动收起的「防打扰」闸（2026-07-28、用户实测「自动折叠也感觉怪」）：
  // 判定见 shouldPinWorkGroupOpen（纯函数、可单测）。
  // 用渲染期 latch 而不是 useEffect：effect 跑在 commit 之后，会先闪一帧折叠再弹回来。
  const followCtl = useStreamFollowContext();
  const searchCtx = usePaneSearchHighlight();
  const hasSearchHitInGroup = useMemo(() => {
    if (!searchCtx?.hitOwnerIds.size) return false;
    for (const m of group.members) {
      if (isToolBlock(m) || isToolVerbGroup(m)) continue;
      if (searchCtx.hitOwnerIds.has((m as TaskEvent).id)) return true;
    }
    return false;
  }, [group.members, searchCtx]);
  const prevAutoExpandedRef = useRef(autoExpanded);
  const pinThisRender = shouldPinWorkGroupOpen(
    prevAutoExpandedRef.current,
    autoExpanded,
    // 拿不到控制器（组件被单独复用）时按「跟随中」算、维持原自动收起行为
    followCtl ? followCtl.isFollowing() : true,
  );
  // 渲染期落闩锁（同 Collapse 的「由 props 推导 state」写法）：本次渲染用 `pinThisRender` 立刻生效、
  // 不等 state 回写，所以仍不会先闪一帧折叠
  if (pinThisRender && !pinnedOpen) setPinnedOpen(true);
  prevAutoExpandedRef.current = autoExpanded;
  // 搜索命中优先展开：即使用户此前手动收起，也不能让“下一条”跳向不可见内容。
  const expanded =
    hasSearchHitInGroup ||
    (manual ?? (autoExpanded || pinnedOpen || pinThisRender));

  // 折叠且 running / 处理中：右侧一眼活动，组头要极淡不抢戏
  let runningTail: string | null = null;
  // 警告标：MCP 跳过等 ⚠️ 行被折叠时组头留标，不吞提示（默认仍收起）
  const hasBootWarn = groupHasBootWarn(group.members);
  if (!expanded) {
    const tailMember = group.members[group.members.length - 1];
    if (isLiveThinkingEvent(tailMember)) {
      // 正在思考：组头不摘思考原文。原文在展开区的思考行里滚动展示、状态行已说「思考中 · 12s」，
      // 折叠态的组头（本来就有转圈）再摘一行就是第三处重复，而且那一行每个新字都在变。
      // 显式占住这个分支：别落到下面「最近 running 工具名」上去说一个早已结束的工具
      runningTail = null;
    } else if (group.hasRunning) {
      runningTail = lastRunningName(group.members);
    } else if (showProcessingPlaceholder) {
      runningTail = PROCESSING_PLACEHOLDER_LABEL;
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        aria-expanded={expanded}
        className={cn(PROCESS_ROW_BUTTON, "h-7 py-0")}
      >
        <CollapseChevron open={expanded} />
        <span className="shrink-0 font-medium">
          {allBoot ? "启动过程" : "工作过程"}
        </span>
        {hasBootWarn && (
          // 原来是 emoji ⚠️ + 原生 title：emoji 不跟主题走、原生 title 违反 Hover 提示规范
          <Tooltip content="含警告（多为 MCP 跳过），展开查看">
            <span className="inline-flex shrink-0">
              <TriangleAlert
                aria-label="含警告"
                className="size-3 text-warning"
              />
            </span>
          </Tooltip>
        )}
        <span className="shrink-0 tabular-nums">· {group.stepCount} 步</span>
        {group.hasRunning ? (
          // 动效收敛（每屏同时在动的元素 ≤ 1~2 个）：展开时成员行（当前在跑的工具 / 实时思考）
          // 自己会转，底部状态行还有 shimmer，组头再转一个就是同屏三处。折叠时才由组头替成员转圈。
          expanded ? null : (
            <Loader2 className="size-3 shrink-0 animate-spin text-info" />
          )
        ) : group.hasBackground && !expanded ? (
          // 组里有工具已返回、但后台还在干（shell 转后台 / 后台子代理）：折叠后里面的转圈看不见，
          // 组头替它转，别让折叠的「工作过程 · N 步 · 时长」读起来像全部结束了。展开时成员行自己在转
          <Loader2 className="size-3 shrink-0 animate-spin text-info" />
        ) : (
          // 同秒完成（<1s）不显示「0s」——空字符串时整段不渲染
          formatGroupDuration(group.startTs, group.endTs) && (
            <span className="shrink-0 tabular-nums">
              · {formatGroupDuration(group.startTs, group.endTs)}
            </span>
          )
        )}
        {group.hasError && (
          <X
            className="size-3 shrink-0 text-destructive"
            aria-label="含错误"
          />
        )}
        {runningTail && (
          <span className="min-w-0 flex-1 truncate font-mono">
            {runningTail}
          </span>
        )}
      </button>

      {/* 展开 / 收起走高度动画（Collapse）：action 完成自动收起时整组几十 ~ 几百像素不再「啪」地消失 */}
      <Collapse open={expanded}>
        <div className="ml-2 mt-0.5 min-w-0 max-w-full space-y-0.5 border-l border-border pl-2.5">
          {group.members.map((m) => (
            <WorkGroupMember
              key={streamItemStableId(m)}
              member={m}
              taskId={taskId}
              task={task}
              variant={variant}
              liveOutput={isToolBlock(m) ? liveToolOutputs?.[m.callId] : undefined}
            />
          ))}
          {showProcessingPlaceholder ? <ProcessingPlaceholderRow /> : null}
        </div>
      </Collapse>
    </div>
  );
};

export const WorkGroupRow = memo(WorkGroupRowImpl);
