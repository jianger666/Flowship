"use client";

/**
 * 任务工作区快捷操作条（V0.10.1、worktree 隔离的配套体验）
 *
 * 渲染在任务详情页路径行下方：按仓分组（多仓有边框+短名 label、单仓扁平）
 * 1. 在 IDE 打开该仓工作区——cursor:// deep link
 * 2. 复制该仓实际工作目录路径——终端 cd 用
 * 3. 预览（按仓多预览位）——设置页配了「预览启动命令」才显示；组内挂载；
 *    不同仓可同时预览、同仓被别的任务占着时再起会顶掉；控件见 preview-control.tsx（一个状态胶囊 + 菜单）
 * 4. 「需求群」——需求任务建/打开飞书需求群（日常轻量任务隐藏）
 * 5. 「任务文件夹」固定整条末尾（点击后用系统文件管理器打开）
 *
 * 预览状态轮询 /api/preview（仅本组件挂载期间、平时 4s 一次、有预览在启动时 1.5s、本地调用很轻）。
 */

import { Copy, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { requestOpenInBrowser } from "@/components/browser/browser-panel-bridge";
import { useBrowserAvailable } from "@/components/browser/use-browser-session";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getIdeAnchorProps } from "@/lib/ide-open";
import { getRepoWorkDirs, repoTail, shellQuotePath } from "@/lib/path-utils";
import {
  derivePreviewPhase,
  mergePreviewSnapshot,
  previewPollInterval,
} from "@/lib/preview-ui-state";
import { getSettings, initSettings } from "@/lib/local-store";
import {
  fetchPreviewStatus,
  startTaskPreview,
  stopTaskPreview,
} from "@/lib/task-store";
import type { JumpIde, PreviewSlotStatus, Task } from "@/lib/types";
import { BranchSwitcher } from "./branch-switcher";
import { PreviewControl } from "./preview-control";

interface Props {
  task: Task;
  /**
   * 紧凑态（任务页头部在「浏览器可见」时收成一行）：只留「有预览位 / 请求在途」的仓的预览胶囊——
   * 点端口进内置浏览器之后正是最需要「看日志 / 重启 / 停止」的时刻，不能跟着仓库 / 分支一起藏起来；
   * IDE 打开 / 复制路径 / 分支等其余操作收起（展开「任务详情」后回到完整形态）。组件始终挂着、轮询与状态不丢。
   */
  compact?: boolean;
}

// 小号纯图标按钮统一样式（省空间、给项目名/分支腾位置；语义靠 Tooltip）
const BTN_CLS = "size-6 shrink-0 justify-center p-0 text-muted-foreground hover:text-foreground";

// 这些按钮只有图标（语义靠 Tooltip，而 Tooltip 只在 hover 时才有），读屏读不出名字（R14 Q19-01）：
// 可访问名 = 动作 +（仓名）——多仓时每个仓都有一排同样的按钮，不带仓名就分不清是哪个仓的
const iconLabel = (action: string, repoName: string): string => `${action}（${repoName}）`;

export const WorkspaceActions = ({ task, compact = false }: Props) => {
  // 内置浏览器只在桌面端有：网页版不画「在内置浏览器打开」
  const browserAvailable = useBrowserAvailable();
  // 设置快照（jumpIde + 每仓预览命令）——挂载时读一次、设置页改完回来重新挂载自然刷新
  const [prefs, setPrefs] = useState<{
    jumpIde: JumpIde;
    previewCommands: Record<string, string>;
  } | null>(null);
  // 全部预览位（按仓；本组件按 taskId+repoPath 挑「自己的」）
  const [slots, setSlots] = useState<PreviewSlotStatus[]>([]);
  // 启动 / 停止请求进行中的仓（防双击；按仓独立，一仓在起不影响另一仓）
  const [pendingRepos, setPendingRepos] = useState<ReadonlySet<string>>(() => new Set());
  // 请求在途仓的「同步镜像」：轮询回调（useCallback、依赖为空）里要读到最新值，不能读闭包里的旧 state
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  // 启动 / 停止每完成一次加 1：轮询发出时记一份，响应回来发现变了就丢掉这份快照（它可能早于刚完成的操作）
  const mutationEpochRef = useRef(0);
  // 轮询时刻：交给预览控件算「启动中 → 运行中」「已运行多久」，组件渲染本身不读时钟
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void initSettings().then(() => {
      const s = getSettings();
      const previewCommands: Record<string, string> = {};
      for (const r of s.repos) {
        const cmd = r.previewCommand?.trim();
        if (cmd) previewCommands[r.path] = cmd;
      }
      setPrefs({ jumpIde: s.jumpIde ?? "cursor", previewCommands });
    });
  }, []);

  // 本 task 可预览的仓（有配置命令的）——没配就整个预览区不渲染
  const candidates = useMemo(
    () =>
      prefs
        ? task.repoPaths
            .filter((p) => prefs.previewCommands[p])
            .map((p) => ({ repoPath: p, command: prefs.previewCommands[p] }))
        : [],
    [prefs, task.repoPaths],
  );

  const refreshSlots = useCallback(async () => {
    const epoch = mutationEpochRef.current;
    try {
      const snapshot = await fetchPreviewStatus();
      // 请求期间本地刚完成过启动 / 停止：这份快照可能早于它，丢掉、等下一轮（本地已按响应更新过）
      if (mutationEpochRef.current !== epoch) return;
      // 在途的仓以本地为准（重启时服务端有「旧槽已删、新槽未放」的空窗），见 mergePreviewSnapshot
      const pending = pendingRef.current;
      setSlots((prev) => mergePreviewSnapshot(prev, snapshot, pending));
      setNow(Date.now());
    } catch {
      // 本地接口偶发失败不打扰、下一轮轮询自纠
    }
  }, []);

  // 本任务有预览还在「启动中」：快轮询，探到地址立刻亮出来；超过宽限期自动回慢档
  const anyStarting = slots.some(
    (s) => s.taskId === task.id && derivePreviewPhase(s, now) === "starting",
  );

  // 有可预览仓才轮询（平时 4s、启动中 1.5s、本地调用很轻）；没配预览命令的任务零开销
  useEffect(() => {
    if (candidates.length === 0) return;
    void refreshSlots();
    const timer = setInterval(
      () => void refreshSlots(),
      previewPollInterval({ anyStarting }),
    );
    return () => clearInterval(timer);
  }, [candidates.length, anyStarting, refreshSlots]);

  const workCwd = task.workCwd;
  const hasRepoBar = !!workCwd && task.repoPaths.length > 0;
  // 任务级工具（需求群 / 任务文件夹）已拆到 TaskUtilityActions，这里只管按仓操作
  if (!hasRepoBar) return null;

  // V0.12.3：IDE 逐仓打开各自项目根、不再打开多仓公共父目录（同事实测 IDEA 把整个
  // D:/IdeaProjects 当项目开了）；每仓一个按钮、单仓时不带短名后缀
  const ideTargets = hasRepoBar
    ? getRepoWorkDirs(
        task.repoPaths,
        workCwd!,
        task.isolateWorktree === true,
        task.nonGitRepoPaths,
        task.readonlyRepoPaths,
      )
    : [];

  // 按仓复制该仓实际工作目录（与 IDE 打开同源的 workDir），不再复制公共父目录。
  // shell 引号化：Application Support 带空格、裸粘到 cd 后面会拆参（用户实测踩过）
  const copyPath = async (dir: string) => {
    try {
      await navigator.clipboard.writeText(shellQuotePath(dir));
      toast.success("工作区路径已复制");
    } catch {
      toast.error("复制失败、请手动复制");
    }
  };

  const setRepoPending = (repoPath: string, on: boolean) => {
    const next = new Set(pendingRef.current);
    if (on) next.add(repoPath);
    else next.delete(repoPath);
    pendingRef.current = next;
    setPendingRepos(next);
  };

  // 启动 / 重启 / 重新启动共用：命令由 server 从权威配置查（CR-01），server 起新进程前会先清掉同仓旧进程
  const start = async (repoPath: string) => {
    setRepoPending(repoPath, true);
    try {
      const res = await startTaskPreview(task.id, repoPath);
      // 合并进本地 slots（同仓替换），避免等下一轮轮询
      setSlots((prev) => [
        ...prev.filter((s) => s.repoPath !== res.slot.repoPath),
        res.slot,
      ]);
      setNow(Date.now());
      if (res.replacedTaskTitle) {
        toast.info(`已停掉「${res.replacedTaskTitle}」对该仓的预览`);
      }
    } catch (err) {
      toast.error(`预览启动失败：${(err as Error).message}`);
    } finally {
      mutationEpochRef.current += 1;
      setRepoPending(repoPath, false);
    }
  };

  const stop = async (repoPath: string) => {
    setRepoPending(repoPath, true);
    try {
      await stopTaskPreview(repoPath);
      setSlots((prev) => prev.filter((s) => s.repoPath !== repoPath));
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
    } finally {
      mutationEpochRef.current += 1;
      setRepoPending(repoPath, false);
    }
  };

  // 单仓 / 多仓统一：每仓一组边框 + 短名 label（task 头部展示口径对齐）
  const ideRepoSet = new Set(ideTargets.map((t) => t.repoPath));
  // candidates 理论上都挂在 ideTargets 上；对不上的兜底单独放（避免预览按钮消失）
  const orphanCandidates = candidates.filter((c) => !ideRepoSet.has(c.repoPath));
  // 按钮可访问名里的仓名：与卡片上显示的短名同源，对不上（兜底的孤儿仓）就取路径末段
  const repoNameOf = (repoPath: string): string =>
    ideTargets.find((t) => t.repoPath === repoPath)?.shortName ?? repoTail(repoPath);

  /** 某仓组内的预览区：每仓独立判断、互不隐藏（修旧 bug：一仓预览中另一仓按钮消失）。
   *  没配预览命令的仓不渲染；状态与菜单都在 PreviewControl 里。 */
  const renderPreviewForRepo = (repoPath: string) => {
    const c = candidates.find((x) => x.repoPath === repoPath);
    if (!c) return null;
    const mine = slots.find((s) => s.repoPath === repoPath && s.taskId === task.id);
    const occupiedBy = slots.find((s) => s.repoPath === repoPath && s.taskId !== task.id);
    return (
      <PreviewControl
        repoName={repoNameOf(repoPath)}
        command={c.command}
        slot={mine}
        occupiedBy={occupiedBy}
        now={now}
        pending={pendingRepos.has(repoPath)}
        browserAvailable={browserAvailable}
        onStart={() => void start(repoPath)}
        onStop={() => void stop(repoPath)}
        onOpenInBrowserPanel={(url) => {
          // 展开任务页的浏览器面板并导航；没人接单（页面里没有浏览器面板）时提示，不静默失败
          if (!requestOpenInBrowser(task.id, url)) {
            toast.info("当前页面没有内置浏览器面板");
          }
        }}
        // 稳定引用（useCallback、依赖为空）：不要在这里写内联箭头，否则每次渲染都是新回调
        onRefresh={refreshSlots}
      />
    );
  };

  // 紧凑态（见 Props.compact）：只有「有预览位 / 请求在途」的仓留一个预览胶囊，其余一律 hidden——
  // 用 CSS 收起而不是换一棵树：BranchSwitcher 等子组件不卸载，展开「任务详情」回到完整形态时状态还在
  const isLiveRepo = (repoPath: string): boolean =>
    pendingRepos.has(repoPath) ||
    slots.some((s) => s.repoPath === repoPath && s.taskId === task.id);
  const anyLive = candidates.some((c) => isLiveRepo(c.repoPath));
  // 多仓才在紧凑态带仓名：单仓时胶囊本身就够了
  const showNameInCompact = candidates.length > 1;
  /** 仓卡片外壳：紧凑态下无预览的仓整张藏起、有预览的仓去掉边框与内边距（只剩胶囊） */
  const cardClass = (repoPath: string): string =>
    cn(
      "flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border/50 px-2 py-1",
      compact && (isLiveRepo(repoPath) ? "gap-1 border-transparent p-0" : "hidden"),
    );

  return (
    <div className={cn("mt-1 flex flex-wrap items-center gap-1", compact && !anyLive && "hidden")}>
      {/* 按仓分组：IDE 打开 + 复制该仓路径 + 预览（有命令才有）。
          cursor:// 同 frame 裸 <a>（壳 will-navigate 拦截转系统协议）——ui-conventions 约定 */}
      {ideTargets.map((t) => {
        // newWindow：开的是整个工作区目录、必须新窗口——cursor:// 默认会把当前活跃
        // 窗口的工作区直接换掉（用户实测正干活的窗口没了）
        const anchor = getIdeAnchorProps(t.workDir, undefined, prefs?.jumpIde ?? "cursor", {
          newWindow: true,
        });
        const actions = (
          <>
            {/* contents：非紧凑态不产生盒子、布局与原来一致；紧凑态整体 hidden（只留后面的预览胶囊） */}
            <span className={cn("contents", compact && "hidden")}>
            {anchor && (
              <Tooltip content="在 IDE 打开项目">
                <Button
                  variant="ghost"
                  size="sm"
                  className={BTN_CLS}
                  aria-label={iconLabel("在 IDE 打开项目", t.shortName)}
                  nativeButton={false}
                  render={
                    <a
                      {...anchor}
                      className="no-underline"
                    />
                  }
                >
                  <SquareArrowOutUpRight className="size-3.5" />
                </Button>
              </Tooltip>
            )}
            <Tooltip content="复制工作区路径">
              <Button
                variant="ghost"
                size="sm"
                className={BTN_CLS}
                aria-label={iconLabel("复制工作区路径", t.shortName)}
                onClick={() => void copyPath(t.workDir)}
              >
                <Copy className="size-3.5" />
              </Button>
            </Tooltip>
            </span>
            {renderPreviewForRepo(t.repoPath)}
          </>
        );
        return (
          <div key={t.repoPath} className={cardClass(t.repoPath)}>
            {/* 单行：项目短名（截断）+ 分支 chip（可切换）+ 分隔线 + 操作按钮（不换行） */}
            <span
              className={cn(
                "min-w-0 max-w-36 truncate text-[11px] font-medium text-foreground",
                compact && (showNameInCompact ? "font-normal text-muted-foreground" : "hidden"),
              )}
            >
              {t.shortName}
            </span>
            <span className={cn("contents", compact && "hidden")}>
              <BranchSwitcher
                task={task}
                repoPath={t.repoPath}
                variant="chip"
                warning="切到非任务相关分支可能会有一些未知问题，请谨慎操作"
              />
              <span className="h-3 w-px shrink-0 bg-border" />
            </span>
            <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
          </div>
        );
      })}

      {/* candidates 的 repoPath 不在 ideTargets 时兜底（理论上不该发生） */}
      {orphanCandidates.map((c) => {
        const orphanInner = (
          <>
            <span className="px-1 text-[11px] text-muted-foreground">
              {repoTail(c.repoPath)}
            </span>
            {renderPreviewForRepo(c.repoPath)}
          </>
        );
        return (
          <div key={`orphan-${c.repoPath}`} className={cardClass(c.repoPath)}>
            {orphanInner}
          </div>
        );
      })}

    </div>
  );
};
