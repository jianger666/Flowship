"use client";

/**
 * 子代理详情面板（右侧抽屉）：给子代理的任务书全文 + 子代理自己的工作过程
 *
 * 两个入口共用同一个面板（用户 2026-10-17：「事件流里的子代理和聊天框上方那条的子代理，都能点击查看详情，
 * 详情包括了给子代理的提示词、子代理干活的事件流」）：
 *  - 事件流里的「子代理」卡片（按工具调用 callId 找记录，见 `tool-block.tsx` 的 TaskSubagentBlock）
 *  - 聊天框上方「子代理在后台工作」条（按记录 key 找，见 `background-subagents-bar.tsx`）
 *
 * # 为什么面板的宿主放在 EventStream 这一层（`SubagentDetailHost`）
 * 卡片在 Virtuoso 虚拟列表里：滚出视口就卸载，面板状态放在卡片里，一滚动抽屉就没了。
 * 宿主包住整个 EventStream（卡片和输入框上方的条都在它里面），通过 context 把 `open(target)` 递下去。
 * 没有宿主的地方（单独复用卡片、单测）`useOpenSubagentDetail()` 返回 null，卡片 / 条退成不可点的展示行。
 *
 * # 怎么开 / 怎么关
 * 开：点子代理任务条（整条都是点击区，没有单独的「详情」按钮、也没有内联展开）；
 * 关：左上 X / Esc / 点抽屉外面。抽屉是非模态的（不盖遮罩），点外面的那一下同时落到被点的东西上；
 * 点「开抽屉」的入口、点抽屉里弹出的二级浮层（大图预览 / 菜单）不算点外面（见 `keepsSubagentDrawerOpen`）；焦点移出抽屉不关（见 `shouldBlockSubagentDrawerClose`）。
 *
 * # 内容怎么画
 * 过程记录和主事件流同形（TaskEvent），直接走同一条渲染管线（`buildSubagentRunItems`）：
 * 工作过程组 / 工具块 / 思考行都是主流里那几个组件，子代理的过程看起来和主 AI 的一模一样；
 * 只有「回复」用一个更轻的行（不带「分享到需求群」之类主流才有的操作）。
 * 记录找不到（功能上线前的历史卡片 / 被清理）时退回展示卡片自己手上的任务书和产出，并说明原因。
 *
 * # 取数
 * `useSubagentRun`：打开时取一次，运行中每秒轮询到终态；面板关闭 / 换目标立刻掐掉在飞请求。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Bot, TriangleAlert } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableBlock } from "@/components/ui/copy-button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useStreamFollow } from "@/hooks/use-stream-follow";
import { useSubagentRun } from "@/hooks/use-subagent-run";
import { isToolBlock, isToolVerbGroup } from "@/lib/tool-display";
import { formatDurationCoarse } from "@/lib/duration-display";
import {
  subagentDetailTargetId,
  subagentRunElapsedMs,
  subagentRunStatusLabel,
  type SubagentDetailTarget,
  type SubagentRunMeta,
  type SubagentRunSnapshot,
} from "@/lib/subagent-run";
import {
  buildSubagentRunItems,
  releaseFollowOnOpen,
  shouldBlockSubagentDrawerClose,
  shouldStickToBottom,
} from "@/lib/subagent-run-display";
import type { Task, TaskEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

import { EventRow } from "./event-stream/rows";
import { ToolBlockRow, ToolVerbGroupRow } from "./event-stream/tool-block";
import { WorkGroupRow } from "./event-stream/work-group";
import {
  SubagentDetailContext,
  type OpenSubagentDetail,
} from "./subagent-detail-context";

// ---------- 小件 ----------

/** 每秒刷新的「现在」，只在 `active` 时才有定时器（终态不再走字） */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
};

const Section = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section className="min-w-0 space-y-1.5">
    <div className="flex items-center gap-2 text-xs font-medium text-foreground">
      <span className="h-3 w-0.5 shrink-0 rounded-full bg-subagent/60" aria-hidden />
      {title}
      {aside}
    </div>
    {children}
  </section>
);

/** 提示条（说明性的、不抢戏）：muted 白卡；`tone="error"` 才用 destructive */
const Notice = ({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: ReactNode;
}) => (
  <div
    className={cn(
      "flex min-w-0 items-start gap-2 rounded-md border bg-card px-2.5 py-2 text-xs leading-relaxed",
      tone === "error"
        ? "border-destructive/30 text-destructive"
        : "border-border text-muted-foreground",
    )}
  >
    {tone === "error" ? (
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
    ) : null}
    <div className="min-w-0 flex-1 wrap-anywhere">{children}</div>
  </div>
);

/** 任务书超过这么长（字符）/ 这么多行才给「展开全文」 */
const PROMPT_COLLAPSE_CHARS = 360;
const PROMPT_COLLAPSE_LINES = 6;

const PromptBlock = ({ prompt }: { prompt: string }) => {
  const [expanded, setExpanded] = useState(false);
  const long =
    prompt.length > PROMPT_COLLAPSE_CHARS ||
    prompt.split("\n").length > PROMPT_COLLAPSE_LINES;
  return (
    <div className="min-w-0 space-y-1">
      {/* 复制的永远是全文，不是折叠后看到的那截 */}
      <CopyableBlock text={prompt} label="复制任务书">
        <pre
          className={cn(
            "wrap-anywhere whitespace-pre-wrap rounded-md border border-border bg-card p-2.5 font-mono text-[11px] leading-relaxed text-foreground",
            expanded
              ? "max-h-[55vh] overflow-y-auto"
              : "max-h-32 overflow-hidden",
          )}
        >
          {prompt}
        </pre>
      </CopyableBlock>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? "收起" : `展开全文（${prompt.length} 字）`}
        </button>
      ) : null}
    </div>
  );
};

/** 产出 / 回复的 markdown 白卡 */
const OutputBlock = ({
  text,
  baseDir,
  label,
}: {
  text: string;
  baseDir?: string;
  label: string;
}) => (
  <CopyableBlock text={text} label={label}>
    <div className="max-h-[50vh] min-w-0 overflow-y-auto rounded-md border border-border bg-card p-2.5 text-xs leading-relaxed text-foreground [--prose-code-size:0.75rem] [&_.prose]:text-xs">
      <MarkdownText text={text} baseDir={baseDir} />
    </div>
  </CopyableBlock>
);

/** 子代理的一段回复：比主流的 AI 回复行轻（不带分享到群 / 重新生成 / 引用等主流才有的操作），可复制 */
const SubagentReplyRow = ({
  ev,
  streaming,
  baseDir,
}: {
  ev: TaskEvent;
  streaming: boolean;
  baseDir?: string;
}) => (
  <CopyableBlock text={ev.text} label="复制">
    <div
      data-subagent-reply
      className="min-w-0 px-1.5 py-1 text-xs leading-relaxed text-foreground [--prose-code-size:0.75rem] [&_.prose]:text-xs"
    >
      <MarkdownText text={ev.text} streaming={streaming} baseDir={baseDir} />
    </div>
  </CopyableBlock>
);

// ---------- 头部 ----------

const StatusBadge = ({
  meta,
  now,
}: {
  meta: Pick<SubagentRunMeta, "status" | "startedAt" | "endedAt">;
  now: number;
}) => {
  const elapsed = formatDurationCoarse(subagentRunElapsedMs(meta, now));
  const label = subagentRunStatusLabel(meta.status);
  const text = elapsed ? `${label} · ${elapsed}` : label;
  if (meta.status === "running") {
    return (
      <Badge variant="outline" size="xs" className="tabular-nums">
        {/* 静态 info 点：运行中全站只用 info；「还活着」靠走字的计时，不加新动效 */}
        <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden />
        {text}
      </Badge>
    );
  }
  const variant =
    meta.status === "done"
      ? "success"
      : meta.status === "failed"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} size="xs" className="tabular-nums">
      {text}
    </Badge>
  );
};

const MetaBadges = ({
  meta,
  fallback,
}: {
  meta: SubagentRunMeta | null;
  fallback: SubagentDetailTarget["fallback"];
}) => {
  const model = meta ? meta.model : fallback?.model;
  const effort = meta ? meta.effort : fallback?.effort;
  return (
    <>
      {model ? (
        <Badge variant="outline" size="xs" className="font-mono">
          {model}
        </Badge>
      ) : null}
      {effort ? (
        <Badge variant="outline" size="xs" className="font-mono">
          {effort}
        </Badge>
      ) : null}
      {meta ? (
        <>
          <Badge variant="outline" size="xs">
            {meta.explore ? "只读探索" : "可读写"}
          </Badge>
          {meta.background ? (
            <Badge variant="outline" size="xs">
              {meta.detached ? "插话转后台" : "后台运行"}
            </Badge>
          ) : null}
          {meta.resumed ? (
            <Badge variant="outline" size="xs">
              接着上次做
            </Badge>
          ) : null}
        </>
      ) : null}
    </>
  );
};

// ---------- 过程 ----------

/** 跟随控制器的「没有滚动容器可写」兜底动作：本面板永远有容器、用不到，给个空函数 */
const NOOP = () => {};

const RunProcess = ({
  snapshot,
  task,
  baseDir,
}: {
  snapshot: SubagentRunSnapshot;
  task: Task;
  baseDir?: string;
}) => {
  const running = snapshot.meta.status === "running";
  const items = useMemo(
    () => buildSubagentRunItems(snapshot.events, running),
    [snapshot.events, running],
  );

  if (items.length === 0) {
    return (
      <div className="px-1 text-xs text-muted-foreground">
        {running
          ? "子代理已经开始，还没有产生内容…"
          : "这次没有记录到子代理的过程。"}
      </div>
    );
  }

  const lastIdx = items.length - 1;
  return (
    <div className="min-w-0 space-y-0.5">
      {items.map((item, i) => {
        const isLast = i === lastIdx;
        if (item.kind === "__work_group__") {
          return (
            <WorkGroupRow
              key={item.id}
              group={item}
              taskId={task.id}
              task={task}
              variant="chat"
              // 专门来看过程的面板：打开就是展开的，完成了也不自动收起
              defaultExpanded
              isRunningTail={running && isLast}
              showProcessingPlaceholder={running && isLast && !item.hasRunning}
            />
          );
        }
        if (isToolBlock(item)) {
          return <ToolBlockRow key={item.id} block={item} taskId={task.id} />;
        }
        if (isToolVerbGroup(item)) {
          return <ToolVerbGroupRow key={item.id} group={item} taskId={task.id} />;
        }
        if (item.kind === "assistant_message") {
          return (
            <SubagentReplyRow
              key={item.id}
              ev={item}
              // 只有最后一段回复、且子代理还在跑时才可能还在吐字
              streaming={running && isLast}
              baseDir={baseDir}
            />
          );
        }
        return (
          <EventRow
            key={item.id}
            ev={item}
            taskId={task.id}
            task={task}
            variant="chat"
            runActive={running}
          />
        );
      })}
    </div>
  );
};

// ---------- 面板本体 ----------

const END_NOTE: Record<"cancelled" | "interrupted", string> = {
  cancelled: "这个子代理已被取消（会话被停止或关闭），没有跑完。上面是它取消前已经做的部分。",
  interrupted:
    "这个子代理没有正常收尾——应用被重启或进程中断。上面是中断前已经记下来的部分。",
};

const SubagentDetailPanel = ({
  taskId,
  task,
  target,
}: {
  taskId: string;
  task: Task;
  target: SubagentDetailTarget;
}) => {
  const view = useSubagentRun(taskId, target);
  const { snapshot } = view;
  const meta = snapshot?.meta ?? null;
  const running = meta?.status === "running";
  const now = useNow(running);
  const fallback = target.fallback;

  const title =
    meta?.description || target.title || fallback?.description || "子代理";
  const prompt = meta?.prompt ?? fallback?.prompt ?? "";
  // 相对路径（回复里的 `path/to/file`）拼成可跳 IDE 的绝对路径用：子代理的工作目录就是任务的工作目录
  const baseDir = task.workCwd;

  // ---- 运行中贴底跟随（用户往上翻就停，翻回底部再继续）----
  // 贴底只走控制器（与主事件流同一套：手势意图判定 + rAF 合批 + 每帧复查，规则见 ui-conventions）。
  // 控制器没有 Virtuoso 兜底可退：本面板是普通滚动容器，挂上 scroller 后它自己写 scrollTop
  const follow = useStreamFollow(NOOP);
  const rev = snapshot?.rev;
  // 一打开就是终态（历史记录）：把控制器初值的 following=true 放掉。它另有一条不经过 shouldStickToBottom 的
  // 「滚动区高度一变就贴底」路径（缩窗口 / 头部徽标长出来把滚动区挤矮），不放掉就会被拽到最底、读不到任务书。
  // 用 layout effect：要赶在浏览器下一次布局回调（ResizeObserver）之前定下来；判据与理由见 releaseFollowOnOpen
  const openDecidedRef = useRef(false);
  const openStatus = meta?.status;
  const openPhase = view.phase;
  useLayoutEffect(() => {
    if (openDecidedRef.current) return;
    const release = releaseFollowOnOpen({ status: openStatus, phase: openPhase });
    if (release === undefined) return;
    openDecidedRef.current = true;
    if (release) follow.setFollowing(false);
  }, [openStatus, openPhase, follow]);
  // 上一次 effect 跑的时候是不是在运行：用来认出「刚跑完的那一帧」——终态快照会在过程下面追加
  // 产出 / 失败原因 / 取消说明，这一帧也要贴底，否则结论留在折叠线下面（判定见 shouldStickToBottom）
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = running;
    if (!shouldStickToBottom({ following: follow.isFollowing(), running, wasRunning })) {
      return;
    }
    follow.requestScrollToBottom();
  }, [running, rev, follow]);

  const hasAssistantReply = snapshot?.events.some(
    (e) => e.kind === "assistant_message",
  );

  return (
    <>
      <SheetHeader>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-subagent/15">
            <Bot className="size-3.5 text-subagent" aria-hidden />
          </span>
          <SheetTitle className="min-w-0 flex-1">{title}</SheetTitle>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {meta ? <StatusBadge meta={meta} now={now} /> : null}
          <MetaBadges meta={meta} fallback={fallback} />
        </div>
      </SheetHeader>

      <div
        ref={follow.attachScroller}
        data-subagent-detail-scroll
        className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-3 py-3"
      >
        {/* 提示：没记录 / 加载失败 / 在等记录建好 */}
        {view.phase === "missing" ? (
          <Notice>
            没有找到这次子代理的过程记录（可能是它早于「详情」功能，或记录已被清理）。
            下面是卡片上留存的任务书和产出，任务书过长时可能被截断。
          </Notice>
        ) : null}
        {view.phase === "error" ? (
          <Notice tone="error">
            <span>过程记录加载失败。</span>
            <Button
              variant="link"
              size="xs"
              className="ml-1 h-auto p-0 align-baseline"
              onClick={view.reload}
            >
              重试
            </Button>
          </Notice>
        ) : null}
        {view.phase === "loading" && view.waiting ? (
          <Notice>子代理刚启动，过程记录还在建立，稍候会自动出现…</Notice>
        ) : null}
        {view.phase === "loading" && !view.waiting && !fallback?.prompt ? (
          <div className="px-1 text-xs text-muted-foreground">加载中…</div>
        ) : null}

        <Section title="任务书">
          {prompt ? (
            <PromptBlock prompt={prompt} />
          ) : (
            <div className="px-1 text-xs text-muted-foreground">无任务书</div>
          )}
        </Section>

        {snapshot ? (
          <Section
            title="工作过程"
            aside={
              <span className="text-[11px] font-normal text-muted-foreground">
                {snapshot.events.length > 0 ? `${snapshot.events.length} 条` : null}
              </span>
            }
          >
            <RunProcess snapshot={snapshot} task={task} baseDir={baseDir} />
            {snapshot.droppedEvents > 0 ? (
              <Notice>
                过程较长，超出记录上限，后面 {snapshot.droppedEvents} 步没有记录。
              </Notice>
            ) : null}
          </Section>
        ) : null}

        {/* 收尾：失败原因 / 取消·中断说明 / 没有流式回复时单独给产出（有回复时产出就在上面的过程里，不重复画） */}
        {meta?.status === "failed" && meta.error ? (
          <Section title="失败原因">
            <Notice tone="error">{meta.error}</Notice>
          </Section>
        ) : null}
        {meta && (meta.status === "cancelled" || meta.status === "interrupted") ? (
          <Notice>{END_NOTE[meta.status]}</Notice>
        ) : null}
        {meta?.status === "done" &&
        meta.result &&
        (!hasAssistantReply || (snapshot?.droppedEvents ?? 0) > 0) ? (
          <Section title="产出">
            <OutputBlock text={meta.result} baseDir={baseDir} label="复制产出" />
          </Section>
        ) : null}

        {/* 没有记录时退回卡片自带的产出 */}
        {!snapshot && fallback?.output ? (
          <Section title="产出">
            <OutputBlock
              text={fallback.output}
              baseDir={baseDir}
              label="复制产出"
            />
          </Section>
        ) : null}
      </div>
    </>
  );
};

// ---------- 宿主 ----------

export const SubagentDetailHost = ({
  task,
  children,
}: {
  task: Task;
  children: ReactNode;
}) => {
  // 目标连同它属于哪个 task 一起存：宿主被复用到别的 task 时旧抽屉自然不再显示，不用 effect 去关
  const [opened, setOpened] = useState<{
    taskId: string;
    target: SubagentDetailTarget;
  } | null>(null);
  const [open, setOpen] = useState(false);

  const openDetail = useCallback<OpenSubagentDetail>(
    (target) => {
      setOpened({ taskId: task.id, target });
      setOpen(true);
    },
    [task.id],
  );

  const visible = open && opened?.taskId === task.id;

  const handleOpenChange = useCallback<
    NonNullable<ComponentProps<typeof Sheet>["onOpenChange"]>
  >((next, eventDetails) => {
    // 两类关闭请求要拦（判据在 shouldBlockSubagentDrawerClose，单测钉死）：
    // - outside-press 落在「开抽屉」的入口（任务条 / 后台条）或抽屉里弹出的二级浮层（大图预览、菜单）上：不算点了外面，
    //   入口自己的 click 会去 openDetail（同一条不动、另一条换内容）；
    // - focus-out：`disablePointerDismissal={false}` 会顺带打开 base-ui 的「焦点移出即关」，点另一条任务条 / 大图上的按钮 /
    //   Tab 出抽屉都会触发，用户并不是想关抽屉，一律拦掉。Esc / X / 点外面仍是正式的关闭路径。
    if (!next && shouldBlockSubagentDrawerClose(eventDetails.reason, eventDetails.event.target)) {
      eventDetails.cancel();
      return;
    }
    setOpen(next);
  }, []);

  return (
    <SubagentDetailContext.Provider value={openDetail}>
      {children}
      <Sheet
        open={visible}
        onOpenChange={handleOpenChange}
        // 点抽屉外面关闭（Sheet 默认不响应外部点击；用户 2026-10-18 要这个抽屉能点外面关）。
        // 仍是非模态：不盖遮罩、外面的东西照常可点——这一下既关抽屉、也落到被点的东西上
        disablePointerDismissal={false}
      >
        <SheetContent className="sm:max-w-2xl">
          {opened && opened.taskId === task.id ? (
            <SubagentDetailPanel
              key={subagentDetailTargetId(opened.target)}
              taskId={task.id}
              task={task}
              target={opened.target}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </SubagentDetailContext.Provider>
  );
};
