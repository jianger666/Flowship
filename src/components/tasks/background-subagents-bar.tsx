"use client";

/**
 * 「子代理在后台工作」条（输入框上方）
 *
 * 主 AI 把活派给后台子代理（`run_in_background`，或用户插话时前台子代理自动转后台）后，主 AI 这一轮会正常说完：
 * 状态行消失、输入框回到「发送」、事件流里没有任何东西还在转——会话看上去「已经结束」，
 * 可子代理其实还在干活（2026-10-17 用户反馈「聊天框就呈现了结束的状态，但是其实还有子代理在干活我根本不知道」）。
 * 这一条就是补这个信号：只要还有后台子代理在跑就一直挂在输入框上方，一个都不剩时收起。
 *
 * 数据只认服务端的整份快照（SSE `background_subagents` 帧，bootstrap 补发；见 `@/lib/background-subagents`），
 * 不从事件流里的「已在后台启动 / 已完成」几行字推断（取消 / 关会话 / 重启都不留对应的行，必然漂移）。
 *
 * 设计取舍（遵守 ui-conventions「事件流 v2」）：
 *  - **静止、不加新动效**：同屏的主动效只留状态行 shimmer 一处；状态点是静态的 info 色（运行中全站只用 text-info），
 *    「还活着」靠右侧每秒走字的计时表达（与状态行「· 12s」同口径）。
 *  - 颜色只落在图标 / 点上、文字保持中性；底是白卡 + 边（`bg-card border-border`），Bot 小方块沿用子代理卡的身份色。
 *  - 出没走 `Collapse`（高度过渡）：最后一个子代理收尾 / 第一个派出时条不「啪」地冒出或消失；
 *    收起期间 Collapse 继续画最后一次的内容，所以条是带着最后那份清单收起来的，不会先变空再缩。
 *  - **点开看详情**（任务书全文 + 子代理自己的工作过程，右侧抽屉，与事件流里的子代理卡共用同一个面板）：
 *    只有一个子代理时整条直接打开它的详情；有多个时点条先弹 Popover 列出每个子代理（摘要 + 各自计时），
 *    再点某一行打开那个的详情。没有过程记录 key 的（记录没起来）只展示、不可点。
 *    列表只读：目前没有「单独停某一个后台子代理」的入口（停止会话才会连带取消），不画按钮误导用户。
 */

import { useEffect, useState, type ReactNode } from "react";
import { Bot, ChevronRight } from "lucide-react";

import { Collapse } from "@/components/tasks/event-stream/collapse";
import {
  useOpenSubagentDetail,
  type OpenSubagentDetail,
} from "@/components/tasks/subagent-detail-context";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import {
  formatBackgroundElapsed,
  oldestBackgroundStartedAt,
  summarizeBackgroundSubagents,
  type BackgroundSubagentJobView,
} from "@/lib/background-subagents";
import { subagentTargetFromJob } from "@/lib/subagent-run-display";
import { cn } from "@/lib/utils";

/** 走字刷新间隔：秒级显示，1s 足够（与状态行同） */
const ELAPSED_TICK_MS = 1000;

/** 每秒刷新的「现在」。只在条挂着（含收起动画期间）才存在，条收起卸载后定时器随之清掉 */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

/** 条本体的样式：单个直接开详情（button）/ 多个当 Popover 的触发器，两处共用 */
const BAR_CLASS =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50";

const BarContent = ({
  summary,
  elapsed,
  multiple,
}: {
  summary: NonNullable<ReturnType<typeof summarizeBackgroundSubagents>>;
  elapsed: string | null;
  multiple: boolean;
}): ReactNode => (
  <>
    {/* 子代理身份色小方块（与事件流里的子代理卡同款，只落在图标上） */}
    <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-subagent/15">
      <Bot className="size-3.5 text-subagent" aria-hidden />
    </span>
    {/* 静态 info 色点（running = info）：不动，「还活着」靠右边的计时 */}
    <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden />
    <span
      className={cn(
        "font-medium text-foreground",
        // 多个时后面还要排摘要列表、标题不让位；单个时标题自己吃满剩余宽度、过长截断
        summary.names ? "shrink-0" : "min-w-0 flex-1 truncate",
      )}
    >
      {summary.title}
    </span>
    {summary.names ? (
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {summary.names}
      </span>
    ) : null}
    {elapsed ? (
      // tabular-nums：数字等宽，逐秒走字时不抖动旁边的箭头
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {multiple ? `最久 ${elapsed}` : elapsed}
      </span>
    ) : null}
    <ChevronRight
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-hidden
    />
  </>
);

/**
 * 多个子代理时的列表 Popover。
 *
 * 「是否展开」的状态**必须放在这个子组件里、不能放在 BarBody**：只剩一个子代理（条换成「整条直接开详情」的按钮）
 * 或全部收尾时，这个组件随分支一起卸载、状态跟着丢；放在 BarBody 里就会粘住——
 * 列表开着时子代理收尾到只剩一个，之后再派出第二个，列表会自己弹开。
 * 点某一行打开详情前要先收起它（详情是非模态抽屉，不收会叠在一起）。
 */
const JobsListPopover = ({
  jobs,
  summary,
  elapsed,
  multiple,
  now,
  openDetail,
}: {
  jobs: readonly BackgroundSubagentJobView[];
  summary: NonNullable<ReturnType<typeof summarizeBackgroundSubagents>>;
  elapsed: string | null;
  multiple: boolean;
  now: number;
  openDetail: OpenSubagentDetail | null;
}) => {
  const [listOpen, setListOpen] = useState(false);
  return (
    <Popover open={listOpen} onOpenChange={setListOpen}>
      <PopoverTrigger
        render={
          <button type="button" className={BAR_CLASS}>
            <BarContent summary={summary} elapsed={elapsed} multiple={multiple} />
          </button>
        }
      />
      <PopoverContent side="top" align="start" className="w-80 p-2">
        <div className="mb-1.5 px-1 text-xs font-medium">后台工作中的子代理</div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {jobs.map((job) => {
            const own = formatBackgroundElapsed(job.startedAt, now);
            const target = openDetail ? subagentTargetFromJob(job) : null;
            const rowBody = (
              <>
                <span
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 break-words">
                  {job.description}
                  {job.detached ? (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      插话时转入后台
                    </span>
                  ) : null}
                </span>
                {own ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {own}
                  </span>
                ) : null}
                {target ? (
                  <ChevronRight
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                ) : null}
              </>
            );
            return (
              <li key={job.id}>
                {target && openDetail ? (
                  <button
                    type="button"
                    data-bg-subagent-open-detail
                    onClick={() => {
                      setListOpen(false);
                      openDetail(target);
                    }}
                    className="flex w-full cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/60"
                  >
                    {rowBody}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/40">
                    {rowBody}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          {openDetail ? "点某一行查看它的任务书和工作过程。" : ""}
          它们做完后，结果会自动交给主 AI。
        </p>
      </PopoverContent>
    </Popover>
  );
};

const BarBody = ({ jobs }: { jobs: readonly BackgroundSubagentJobView[] }) => {
  const now = useNow();
  const openDetail = useOpenSubagentDetail();
  const summary = summarizeBackgroundSubagents(jobs);
  if (!summary) return null;

  const oldest = oldestBackgroundStartedAt(jobs);
  const elapsed = oldest === null ? null : formatBackgroundElapsed(oldest, now);
  const multiple = jobs.length > 1;
  // 只有一个且有过程记录：整条直接开详情
  const singleTarget =
    !multiple && openDetail ? subagentTargetFromJob(jobs[0]!) : null;

  return (
    // pb-1.5：条与下面的输入岛之间的间距放在折叠体里面——条收起时这点间距一起收掉
    <div className="pb-1.5">
      {singleTarget && openDetail ? (
        <Tooltip content="查看任务书和它的工作过程；做完后结果会自动交给主 AI">
          <button
            type="button"
            data-bg-subagent-open-detail
            onClick={() => openDetail(singleTarget)}
            className={BAR_CLASS}
          >
            <BarContent summary={summary} elapsed={elapsed} multiple={false} />
          </button>
        </Tooltip>
      ) : (
        <JobsListPopover
          jobs={jobs}
          summary={summary}
          elapsed={elapsed}
          multiple={multiple}
          now={now}
          openDetail={openDetail}
        />
      )}
    </div>
  );
};

export const BackgroundSubagentsBar = ({
  jobs,
}: {
  jobs: readonly BackgroundSubagentJobView[];
}) => (
  <Collapse open={jobs.length > 0}>
    <BarBody jobs={jobs} />
  </Collapse>
);
