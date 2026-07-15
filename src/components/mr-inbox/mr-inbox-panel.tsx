"use client";

/**
 * 收件箱面板（公共组件、单一来源）
 *
 * 三分组：待测 MR / 我的 BUG / 待回归——按 settings.userRole 显隐。
 * 两处复用：顶栏 Popover + 任务详情提醒条（filterWorkItemId 只滤待测 MR）。
 */

import { useMemo, useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitMerge,
  Inbox,
  RefreshCw,
  Undo2,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import {
  useMrInbox,
  type BugInboxEntry,
  type BugTransitionOption,
  type MrInboxEntry,
} from "@/hooks/use-mr-inbox";
import { useTaskList } from "@/hooks/use-task-list";
import { extractFeishuStoryId } from "@/lib/branch-template";
import {
  launchFixBugAdvance,
  reinstallFixBugPreset,
} from "@/lib/fix-bug-advance";
import { getSettings } from "@/lib/local-store";
import {
  buildStoryUrlFromBug,
  inboxGroupsVisibleForRole,
  type InboxGroupId,
} from "@/lib/mr-inbox";
import { formatRelative } from "@/lib/task-display";
import { cn } from "@/lib/utils";

interface MrInboxPanelProps {
  /** 只显示指定工作项的待测 MR（任务详情提醒条） */
  filterWorkItemId?: string;
  className?: string;
}

/** 小 chip（优先级 / 状态 / MR 可合性） */
const Chip = ({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "danger" | "warn";
  title?: string;
}) => {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : tone === "danger"
        ? "bg-destructive/10 text-destructive"
        : tone === "warn"
          ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
          : "bg-muted text-muted-foreground";
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-4xl px-2 text-xs",
        toneClass,
      )}
    >
      {children}
    </span>
  );
};

const MrStatusChip = ({ entry }: { entry: MrInboxEntry }) => {
  if (entry.mrError) {
    return (
      <Chip tone="danger" title={entry.mrError}>
        详情获取失败
      </Chip>
    );
  }
  if (!entry.mr) return null;
  if (entry.mr.hasConflicts) return <Chip tone="danger">有冲突</Chip>;
  if (entry.mr.mergeable) return <Chip tone="ok">可合并</Chip>;
  return (
    <Chip title={entry.mr.detailedMergeStatus}>检查中</Chip>
  );
};

/** 分组标题 + 各自空态 */
const GroupSection = ({
  title,
  icon,
  count,
  emptyText,
  children,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  emptyText: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col">
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground">
      {icon}
      {title}
      {count > 0 && (
        <span className="font-normal tabular-nums">({count})</span>
      )}
    </div>
    {count === 0 ? (
      <div className="px-3 pb-2">
        <EmptyHint size="sm" align="center">
          {emptyText}
        </EmptyHint>
      </div>
    ) : (
      <ul className="px-1">{children}</ul>
    )}
  </section>
);

const SeenToggle = ({
  unread,
  onToggle,
}: {
  unread: boolean;
  onToggle: () => void;
}) => (
  <Button
    variant="ghost"
    size="sm"
    className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
    onClick={onToggle}
  >
    {unread ? (
      <>
        <Check className="size-3" />
        标已读
      </>
    ) : (
      <>
        <Undo2 className="size-3" />
        取消已读
      </>
    )}
  </Button>
);

const MrInboxRow = ({ entry }: { entry: MrInboxEntry }) => {
  const { data, setSeen, mergeMr } = useMrInbox();
  const { confirm } = useDialog();
  const [merging, setMerging] = useState(false);
  const unread = entry.seenAtMs === null;

  const mrTitle =
    entry.mr?.title ||
    (() => {
      const m = entry.mrUrl.match(/([^/]+)\/-\/merge_requests\/(\d+)$/);
      return m ? `${m[1]} !${m[2]}` : entry.mrUrl;
    })();

  const handleMerge = async () => {
    const ok = await confirm({
      title: "合并这个 MR？",
      description: `${mrTitle}（${entry.mr?.sourceBranch} → ${entry.mr?.targetBranch}）`,
      confirmLabel: "合并",
    });
    if (!ok) return;
    setMerging(true);
    try {
      await mergeMr(entry.mrUrl);
      toast.success("MR 已合并");
    } catch (err) {
      toast.error(
        `合并失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setMerging(false);
    }
  };

  return (
    <li
      className={cn(
        "group relative flex flex-col gap-1 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/50",
        !unread && "opacity-60",
      )}
    >
      {unread && (
        <span
          aria-label="未读"
          className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-primary"
        />
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {entry.workItemUrl ? (
          <a
            href={entry.workItemUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit max-w-full min-w-0 truncate hover:text-foreground hover:underline"
            title={entry.workItemName}
          >
            {entry.workItemName}
          </a>
        ) : (
          <span className="min-w-0 truncate" title={entry.workItemName}>
            {entry.workItemName}
          </span>
        )}
        <span className="shrink-0">
          {entry.commentAtMs > 0 ? formatRelative(entry.commentAtMs) : ""}
        </span>
      </div>
      {/* 标题左 + 可合性 chip 右，与 BUG 行视觉对齐 */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={mrTitle}>
          {mrTitle}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <MrStatusChip entry={entry} />
        </span>
      </div>
      {entry.commentSnippet && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {entry.commentSnippet}
        </p>
      )}
      <div className="mt-0.5 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          nativeButton={false}
          render={
            <a
              href={entry.mrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="no-underline"
            />
          }
        >
          <ExternalLink className="size-3" />
          打开 MR
        </Button>
        <SeenToggle
          unread={unread}
          onToggle={() => void setSeen(entry.mrUrl, unread)}
        />
        {data?.gitTokenConfigured && entry.mr?.mergeable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={merging}
            onClick={() => void handleMerge()}
          >
            {merging ? (
              <RefreshCw className="size-3 animate-spin" />
            ) : (
              <GitMerge className="size-3" />
            )}
            合并
          </Button>
        )}
      </div>
    </li>
  );
};

/**
 * 我的 BUG 行：「改bug」直接推进（2026-07-14 拍板：点按钮即确认、不弹推进弹窗）。
 * 预置 action / skill 被删 → confirm 重建后再继续推进（不再深链降级）。
 * 无对应任务（story 已合并 / 从未建过）→ 引导去「新建改bug任务」（预填 bug 上下文、
 * 创建后自动推进、见 /workitems/new 的 fixBug 引流参数）。
 * 状态 chip 可点下拉就地流转（懒加载可流转目标）。
 */
const MyBugRow = ({ entry }: { entry: BugInboxEntry }) => {
  const { setSeen, listBugTransitions, transitionBug } = useMrInbox();
  const { tasks } = useTaskList();
  const { confirm } = useDialog();
  const router = useRouter();
  // 推进请求进行中（按钮 disabled + 转圈、防双击）
  const [fixing, setFixing] = useState(false);
  // 状态流转进行中（chip 转圈、防双击）
  const [transitioning, setTransitioning] = useState(false);
  // 下拉是否打开（打开时懒加载可流转列表）
  const [menuOpen, setMenuOpen] = useState(false);
  // 可流转目标（null = 未拉 / 加载中用 loading 态）
  const [transitions, setTransitions] = useState<BugTransitionOption[] | null>(
    null,
  );
  // 拉流转列表失败文案（空 = 无错）
  const [transitionsError, setTransitionsError] = useState("");
  // 正在拉流转列表
  const [loadingTransitions, setLoadingTransitions] = useState(false);
  const unread = entry.seenAtMs === null;

  // 状态变了 → 旧可流转列表作废，下次打开重新懒加载
  useEffect(() => {
    setTransitions(null);
    setTransitionsError("");
  }, [entry.statusLabel]);

  const handleFix = async () => {
    const storyId = entry.relatedStoryId?.trim();
    const hit = storyId
      ? tasks.find(
          (t) =>
            t.mode !== "chat" &&
            t.repoStatus === "developing" &&
            extractFeishuStoryId(t.feishuStoryUrl) === storyId,
        )
      : undefined;
    if (!hit) {
      // 死路打通（2026-07-14）：原来只 toast「找不到对应任务」就没下文了——
      // 线上 bug 的 story 任务早已合并归档、这是常态而非异常。改为引导新建改bug任务。
      const ok = await confirm({
        title: "新建改bug任务？",
        description: `没有找到${
          entry.relatedStoryName ? `「${entry.relatedStoryName}」` : "关联需求"
        }对应的开发中任务（可能已合并归档）。新建一个任务来改这个 bug、创建后自动开始。`,
        confirmLabel: "去新建",
      });
      if (!ok) return;
      const q = new URLSearchParams({
        fixBug: "1",
        name: entry.name,
        // 任务的飞书链接优先挂关联 story（之后同 story 的 bug「改bug」能匹配上这个任务）、
        // 推不出 story URL 时退 bug 自身链接
        url:
          buildStoryUrlFromBug(entry.bugUrl, entry.relatedStoryId) ??
          entry.bugUrl,
        bugUrl: entry.bugUrl,
        ...(entry.relatedStoryName ? { storyName: entry.relatedStoryName } : {}),
      });
      router.push(`/workitems/new?${q.toString()}`);
      return;
    }
    // 任务正在跑：不叠加推进、跳过去看现场
    if (hit.runStatus === "running") {
      toast.error("该任务正在运行、等它完成后再推进");
      router.push(`/tasks/${hit.id}`);
      return;
    }
    setFixing(true);
    try {
      const bugCtx = {
        bugTitle: entry.name,
        bugUrl: entry.bugUrl,
        storyName: entry.relatedStoryName,
      };
      let result = await launchFixBugAdvance(hit.id, bugCtx);
      // 预置 action / skill 被删：二次确认重建后重试一次（取消则原地不动）
      if (result.kind === "missing-preset") {
        const ok = await confirm({
          title: "重建「改bug」预置？",
          description:
            "改bug 预置不可用。重建将恢复出厂版本（覆盖对该 action 的修改）并继续推进。",
          confirmLabel: "重建并继续",
        });
        if (!ok) return;
        await reinstallFixBugPreset();
        result = await launchFixBugAdvance(hit.id, bugCtx);
        if (result.kind === "missing-preset") {
          toast.error("重建后预置仍缺失、请到能力页检查");
          return;
        }
      }
      if (result.kind === "started") {
        void setSeen(entry.bugUrl, true);
        toast.success("已开始改bug、跳转查看执行");
        router.push(`/tasks/${hit.id}`);
      }
      // aborted（缺 apiKey / 模型）：prepareRunArgs 内部已 toast、原地不动
    } catch (err) {
      toast.error(
        `推进失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setFixing(false);
    }
  };

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (!open || transitions !== null || loadingTransitions) return;
    setLoadingTransitions(true);
    setTransitionsError("");
    void listBugTransitions({
      projectKey: entry.projectKey,
      workItemId: entry.workItemId,
    })
      .then((list) => setTransitions(list))
      .catch((err) => {
        setTransitionsError(
          err instanceof Error ? err.message : String(err),
        );
        setTransitions([]);
      })
      .finally(() => setLoadingTransitions(false));
  };

  const handlePickTransition = async (opt: BugTransitionOption) => {
    if (transitioning) return;
    setMenuOpen(false);
    setTransitioning(true);
    try {
      const result = await transitionBug({
        bugUrl: entry.bugUrl,
        projectKey: entry.projectKey,
        workItemId: entry.workItemId,
        action: "transition",
        transitionId: opt.transitionId,
        targetStateKey: opt.targetStateKey,
        targetStateLabel: opt.targetStateLabel,
      });
      const label = result.targetStateLabel || opt.targetStateLabel;
      toast.success(`已流转到 ${label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const bugUrl =
        err && typeof err === "object" && "bugUrl" in err
          ? String((err as { bugUrl?: string }).bugUrl || entry.bugUrl)
          : entry.bugUrl;
      if (message.includes("必填字段")) {
        toast.error(message, {
          action: {
            label: "去飞书",
            onClick: () => {
              window.open(bugUrl, "_blank", "noopener,noreferrer");
            },
          },
        });
      } else {
        toast.error(`流转失败：${message}`);
      }
    } finally {
      setTransitioning(false);
    }
  };

  return (
    <li
      className={cn(
        "group relative flex flex-col gap-1 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/50",
        !unread && "opacity-60",
      )}
    >
      {unread && (
        <span
          aria-label="未读"
          className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-primary"
        />
      )}
      {/* 标题左、优先级 + 可点状态 chip 靠右（justify-between） */}
      <div className="flex items-center justify-between gap-2">
        <a
          href={entry.bugUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit max-w-full min-w-0 truncate text-sm font-medium hover:underline"
          title={entry.name}
        >
          {entry.name}
        </a>
        <span className="flex shrink-0 items-center gap-1">
          {entry.priorityLabel && <Chip tone="warn">{entry.priorityLabel}</Chip>}
          <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
            {/* outline 小 chip：边框 + chevron 明示可点（与 Regression 静态 chip 区分） */}
            <DropdownMenuTrigger
              disabled={transitioning}
              className={cn(
                "inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-4xl border border-input bg-background px-2 text-[10px] text-muted-foreground outline-none",
                "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
              title="切换状态"
            >
              {transitioning ? (
                <RefreshCw className="size-3 animate-spin" />
              ) : (
                <>
                  {entry.statusLabel || "—"}
                  <ChevronDown className="size-3 opacity-70" />
                </>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              {loadingTransitions && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  加载中…
                </div>
              )}
              {!loadingTransitions && transitionsError && (
                <div className="px-2 py-1.5 text-xs text-destructive">
                  {transitionsError}
                </div>
              )}
              {!loadingTransitions &&
                !transitionsError &&
                transitions &&
                transitions.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    无可流转状态
                  </div>
                )}
              {!loadingTransitions &&
                transitions?.map((opt) => (
                  <DropdownMenuItem
                    key={opt.transitionId}
                    onClick={() => void handlePickTransition(opt)}
                  >
                    {opt.targetStateLabel}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {entry.relatedStoryName && (
        <p className="truncate text-xs text-muted-foreground" title={entry.relatedStoryName}>
          关联：{entry.relatedStoryName}
        </p>
      )}
      <div className="mt-0.5 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={fixing}
          onClick={() => void handleFix()}
        >
          {fixing ? (
            <RefreshCw className="size-3 animate-spin" />
          ) : (
            <Wrench className="size-3" />
          )}
          改bug
        </Button>
        <SeenToggle
          unread={unread}
          onToggle={() => void setSeen(entry.bugUrl, unread)}
        />
      </div>
    </li>
  );
};

/** 待回归行：通过 / 不通过 */
const RegressionBugRow = ({ entry }: { entry: BugInboxEntry }) => {
  const { setSeen, transitionBug } = useMrInbox();
  const { confirm, prompt } = useDialog();
  const [busy, setBusy] = useState<"pass" | "reject" | null>(null);
  const unread = entry.seenAtMs === null;

  const runTransition = async (action: "pass" | "reject", reason?: string) => {
    setBusy(action);
    try {
      await transitionBug({
        bugUrl: entry.bugUrl,
        projectKey: entry.projectKey,
        workItemId: entry.workItemId,
        action,
        reason,
      });
      toast.success(action === "pass" ? "已标记通过并关闭" : "已打回并写评论");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const bugUrl =
        err && typeof err === "object" && "bugUrl" in err
          ? String((err as { bugUrl?: string }).bugUrl || entry.bugUrl)
          : entry.bugUrl;
      if (message.includes("必填字段")) {
        toast.error(message, {
          action: {
            label: "去飞书",
            onClick: () => {
              window.open(bugUrl, "_blank", "noopener,noreferrer");
            },
          },
        });
      } else {
        toast.error(`流转失败：${message}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const handlePass = async () => {
    const ok = await confirm({
      title: "确认回归通过？",
      description: entry.name,
      confirmLabel: "通过并关闭",
    });
    if (!ok) return;
    await runTransition("pass");
  };

  const handleReject = async () => {
    const reason = await prompt({
      title: "打回原因",
      defaultValue: "",
      confirmLabel: "不通过",
      validate: (v) => (v.trim() ? "" : "请填写打回原因"),
    });
    if (reason === null) return;
    await runTransition("reject", reason.trim());
  };

  return (
    <li
      className={cn(
        "group relative flex flex-col gap-1 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/50",
        !unread && "opacity-60",
      )}
    >
      {unread && (
        <span
          aria-label="未读"
          className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-primary"
        />
      )}
      {/* 标题左、状态 chip 靠右；静态无边框（与 MyBugRow 可点控件区分） */}
      <div className="flex items-center justify-between gap-2">
        <a
          href={entry.bugUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit max-w-full min-w-0 truncate text-sm font-medium hover:underline"
          title={entry.name}
        >
          {entry.name}
        </a>
        <span className="flex shrink-0 items-center gap-1">
          <Chip tone="ok">{entry.statusLabel || "RESOLVED"}</Chip>
        </span>
      </div>
      {entry.relatedStoryName && (
        <p className="truncate text-xs text-muted-foreground" title={entry.relatedStoryName}>
          关联：{entry.relatedStoryName}
        </p>
      )}
      <div className="mt-0.5 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={busy !== null}
          onClick={() => void handlePass()}
        >
          {busy === "pass" ? (
            <RefreshCw className="size-3 animate-spin" />
          ) : (
            <CheckCircle2 className="size-3" />
          )}
          通过
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={busy !== null}
          onClick={() => void handleReject()}
        >
          {busy === "reject" ? (
            <RefreshCw className="size-3 animate-spin" />
          ) : (
            <XCircle className="size-3" />
          )}
          不通过
        </Button>
        <SeenToggle
          unread={unread}
          onToggle={() => void setSeen(entry.bugUrl, unread)}
        />
      </div>
    </li>
  );
};

export const MrInboxPanel = ({
  filterWorkItemId,
  className,
}: MrInboxPanelProps) => {
  const { data, refreshing, refresh } = useMrInbox();

  // 角色显隐：读本地 settings（与扫描端一致）；任务条场景强制只看 MR 组
  const visible = useMemo(() => {
    if (filterWorkItemId) {
      return new Set<InboxGroupId>(["pendingMr"]);
    }
    return inboxGroupsVisibleForRole(getSettings().userRole);
  }, [filterWorkItemId]);

  const pendingMr =
    data?.status === "ok"
      ? filterWorkItemId
        ? data.pendingMr.filter((it) => it.workItemId === filterWorkItemId)
        : data.pendingMr
      : [];
  const myBugs = data?.status === "ok" && visible.has("myBugs") ? data.myBugs : [];
  const pendingRegression =
    data?.status === "ok" && visible.has("pendingRegression")
      ? data.pendingRegression
      : [];

  const showMr = visible.has("pendingMr");
  const showMyBugs = visible.has("myBugs");
  const showRegression = visible.has("pendingRegression");

  const unreadHere =
    pendingMr.filter((it) => it.seenAtMs === null).length +
    myBugs.filter((it) => it.seenAtMs === null).length +
    pendingRegression.filter((it) => it.seenAtMs === null).length;

  return (
    <div className={cn("flex w-95 max-w-[92vw] flex-col", className)}>
      <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Inbox className="size-4 text-muted-foreground" />
          收件箱
          {unreadHere > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {unreadHere} 条未读
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh({ force: true })}
          disabled={refreshing}
          aria-label="刷新收件箱"
          title="重新扫描"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>

      {data?.status === "ok" && data.gitTokenConfigured === false && showMr && (
        <div className="mx-3 mb-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          未配置 GitLab Token、仅展示 MR 链接——
          <Link href="/settings" className="underline hover:text-foreground">
            去设置页配置
          </Link>
        </div>
      )}

      {!data ? (
        <div className="px-3 pb-3">
          <LoadingState variant="inline" label="扫描收件箱中…" />
        </div>
      ) : data.status === "not_installed" ? (
        <div className="px-3 pb-3">
          <EmptyHint>
            meegle CLI 未安装——
            <Link href="/settings" className="underline hover:text-foreground">
              去设置页
            </Link>
            安装并授权后这里会汇总待办。
          </EmptyHint>
        </div>
      ) : data.status === "not_authed" ? (
        <div className="px-3 pb-3">
          <EmptyHint>
            meegle 未登录——
            <Link href="/settings" className="underline hover:text-foreground">
              去设置页授权
            </Link>
            后这里会汇总待办。
          </EmptyHint>
        </div>
      ) : data.status === "error" ? (
        <div className="px-3 pb-3">
          <EmptyHint>
            扫描失败：{data.message || "未知错误"}——
            <button
              type="button"
              className="cursor-pointer underline hover:text-foreground"
              onClick={() => void refresh({ force: true })}
            >
              重试
            </button>
          </EmptyHint>
        </div>
      ) : (
        <div className="max-h-105 space-y-2 overflow-y-auto pb-1">
          {showMr && (
            <GroupSection
              title="待测 MR"
              icon={<GitMerge className="size-3.5" />}
              count={pendingMr.length}
              emptyText={
                refreshing
                  ? "扫描中…"
                  : filterWorkItemId
                    ? "本需求暂无待测 MR"
                    : "没有待测的 MR"
              }
            >
              {pendingMr.map((entry) => (
                <MrInboxRow key={entry.mrUrl} entry={entry} />
              ))}
            </GroupSection>
          )}
          {showMyBugs && (
            <GroupSection
              title="我的 BUG"
              icon={<Bug className="size-3.5" />}
              count={myBugs.length}
              emptyText={refreshing ? "扫描中…" : "没有待修的 BUG"}
            >
              {myBugs.map((entry) => (
                <MyBugRow key={entry.bugUrl} entry={entry} />
              ))}
            </GroupSection>
          )}
          {showRegression && (
            <GroupSection
              title="待回归"
              icon={<CheckCircle2 className="size-3.5" />}
              count={pendingRegression.length}
              emptyText={refreshing ? "扫描中…" : "没有待回归的 BUG"}
            >
              {pendingRegression.map((entry) => (
                <RegressionBugRow key={entry.bugUrl} entry={entry} />
              ))}
            </GroupSection>
          )}
        </div>
      )}
    </div>
  );
};
