"use client";

/**
 * 代码改动预览入口（task 与 chat 共用）：看到现在改了什么、代码有没有问题，不用再开 IDE。
 *
 * - 入口：task 页头部 chip 行 / chat 页标题栏右上角的「改动 N +a −r」小按钮（数字随 agent 运行实时涨）
 *   （chat 原来挂在输入框上方的工具行里，和目录 / 分支 / MCP 排成一串，用户反馈找不到——那一行放的是
 *   「发送前要选的上下文」，不是页面级入口）
 * - 面板：右侧非模态 Sheet（边看任务 / 对话边看 diff），见 changes/changes-sheet.tsx
 *   左边按仓分组的文件树（搜索、已查看进度），右边单文件 diff（统一 / 分栏、词级 + 语法高亮、
 *   展开上下文、选中行引用到对话、j/k/n/p 快捷键……）
 * - 范围：整条分支（默认，相对线上分支分叉点、含已提交 + 未提交 + 新建文件）/ 仅未提交 / 单个提交；
 *   对比基线可手动改。chat 永远以「当前所在分支」为准——每次读 HEAD、切分支后自动跟随
 * - 只读预览：不提供暂存 / 提交 / 回滚；想深看点文件路径或行号跳 IDE
 *
 * 这一层持有：开关、范围、手动基线、显示偏好（localStorage）；并用它们驱动清单取数（useTaskChanges）。
 * 面板内的选中 / 导航 / 已查看 / 快捷键在 ChangesSheet。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDiff } from "lucide-react";
import { toast } from "sonner";

import { ChangesSheet } from "@/components/tasks/changes/changes-sheet";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { clearFileDiffCache } from "@/hooks/use-file-diff";
import { useTaskChanges } from "@/hooks/use-task-changes";
import {
  loadDiffPrefs,
  saveDiffPrefs,
  type DiffPrefs,
} from "@/lib/changes/prefs";
import {
  canLoadChanges,
  shouldFallBackToBranch,
  shouldShowChangesEntry,
} from "@/lib/changes/panel-state";
import { DEFAULT_CHANGE_SCOPE, type ChangesQuery } from "@/lib/changes/scope";
import { getBrowserStorage } from "@/lib/changes/viewed-store";
import type { Task, TaskChangeScope } from "@/lib/types";

interface Props {
  task: Task;
  /**
   * 入口按钮尺寸：默认 `sm`（28px，task 页头部 chip 行里与其他 chip 同高）；
   * chat 页标题栏右上角用 `xs`（24px = 标题栏一行的高度）——用 sm 会把标题栏撑高 4px，
   * 而入口要等数据回来才出现，标题栏会在加载完的那一刻跳一下
   */
  size?: "sm" | "xs";
}

export const TaskChangesPanel = ({ task, size = "sm" }: Props) => {
  const chat = task.mode === "chat";
  // task：工作区已启动且绑了仓；chat：选了工作目录（repoPaths[0]）
  const enabled = canLoadChanges(task);
  const running = task.runStatus === "running";

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<TaskChangeScope>(DEFAULT_CHANGE_SCOPE);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<DiffPrefs>(() => loadDiffPrefs(getBrowserStorage()));
  const [refreshKey, setRefreshKey] = useState(0);

  // 切任务（chat 切对话）：上一个任务的开关 / 范围 / 基线不带过来
  const [prevTaskId, setPrevTaskId] = useState(task.id);
  if (prevTaskId !== task.id) {
    setPrevTaskId(task.id);
    setOpen(false);
    setScope(DEFAULT_CHANGE_SCOPE);
    setBaseRef(null);
  }

  const query = useMemo<ChangesQuery>(
    () => ({ scope, baseRef, ignoreWs: prefs.ignoreWs }),
    [scope, baseRef, prefs.ignoreWs],
  );

  const { data, error, loading, updatedAt, refresh, stale } = useTaskChanges({
    taskId: task.id,
    enabled,
    running,
    open,
    query,
  });

  // 选中的提交已不在当前分支上（切了分支 / 提交被改写）：所有仓都读不到 → 自动切回整条分支
  useEffect(() => {
    if (!shouldFallBackToBranch(scope, data?.repos ?? null, stale)) return;
    setScope(DEFAULT_CHANGE_SCOPE);
    toast.info("所选提交已不在当前分支上，已切回整条分支");
  }, [data, stale, scope]);

  const handlePrefsChange = useCallback((patch: Partial<DiffPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveDiffPrefs(getBrowserStorage(), next);
      return next;
    });
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    // 关面板就回到「整条分支 + 自动基线」：chip 上的数字永远是默认口径，
    // 不会停在某个临时视角上（只看某个提交 / 手动选了别的对比基线，却被当成「整条分支」的数字）
    if (!next) {
      setScope(DEFAULT_CHANGE_SCOPE);
      setBaseRef(null);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    clearFileDiffCache();
    setRefreshKey((k) => k + 1);
    void refresh();
  }, [refresh]);

  // 没有可看改动的任务（未启动 / 全是非 git·只读仓）：不挂入口。
  // chat 额外：选的目录不是 git 仓 / 目录不存在，也不挂（挂一个只会说「不是 git 仓库」的按钮没有意义）。
  // 首次数据没回来前也不渲染，避免 chip 闪一下又消失
  if (!enabled || !data || !shouldShowChangesEntry(data.repos, chat)) return null;

  const { totals } = data;
  return (
    <>
      <Tooltip
        content={
          chat
            ? "查看当前分支相对线上分支的全部代码改动"
            : "查看本任务相对线上分支的全部代码改动"
        }
      >
        <Button type="button" variant="outline" size={size} onClick={() => setOpen(true)}>
          <FileDiff />
          改动
          {totals.files > 0 && (
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              <span>{totals.files}</span>
              <span className="text-success">+{totals.added}</span>
              <span className="text-destructive">−{totals.removed}</span>
            </span>
          )}
        </Button>
      </Tooltip>

      <ChangesSheet
        key={task.id}
        taskId={task.id}
        chat={chat}
        open={open}
        onOpenChange={handleOpenChange}
        data={data}
        stale={stale}
        error={error}
        loading={loading}
        updatedAt={updatedAt}
        running={running}
        query={query}
        onScopeChange={setScope}
        onBaseRefChange={setBaseRef}
        prefs={prefs}
        onPrefsChange={handlePrefsChange}
        onRefresh={handleRefresh}
        refreshKey={refreshKey}
      />
    </>
  );
};
