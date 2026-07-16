"use client";

/**
 * 任务工作区快捷操作条（V0.10.1、worktree 隔离的配套体验）
 *
 * 渲染在任务详情页路径行下方：按仓分组（多仓有边框+短名 label、单仓扁平）
 * 1. 在 IDE 打开该仓工作区——cursor:// deep link
 * 2. 复制该仓实际工作目录路径——终端 cd 用
 * 3. 预览（按仓多预览位）——设置页配了「预览启动命令」才显示；组内挂载；
 *    不同仓可同时预览、同仓被别的任务占着时再起会顶掉
 * 4. 「任务文件夹」固定整条末尾
 *
 * 预览状态轮询 /api/preview（仅本组件挂载期间、4s 一次、本地调用很轻）。
 */

import {
  Copy,
  ExternalLink,
  FileTerminal,
  FolderOpen,
  Loader2,
  Play,
  Square,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getIdeAnchorProps } from "@/lib/ide-open";
import { getRepoWorkDirs, shellQuotePath } from "@/lib/path-utils";
import { getSettings, initSettings } from "@/lib/local-store";
import {
  fetchPreviewStatus,
  startTaskPreview,
  stopTaskPreview,
} from "@/lib/task-store";
import type { JumpIde, PreviewSlotStatus, Task } from "@/lib/types";

interface Props {
  task: Task;
}

// 小号按钮统一样式（这行是辅助操作、视觉上要比主操作区收敛）
const BTN_CLS = "h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground";

export const WorkspaceActions = ({ task }: Props) => {
  // 设置快照（jumpIde + 每仓预览命令）——挂载时读一次、设置页改完回来重新挂载自然刷新
  const [prefs, setPrefs] = useState<{
    jumpIde: JumpIde;
    previewCommands: Record<string, string>;
  } | null>(null);
  // 全部预览位（按仓；本组件按 taskId+repoPath 挑「自己的」）
  const [slots, setSlots] = useState<PreviewSlotStatus[]>([]);
  // 启动 / 停止请求进行中（防双击）
  const [busy, setBusy] = useState(false);

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
    try {
      setSlots(await fetchPreviewStatus());
    } catch {
      // 本地接口偶发失败不打扰、下一轮轮询自纠
    }
  }, []);

  // 有可预览仓才轮询（4s、本地调用很轻）；没配预览命令的任务零开销
  useEffect(() => {
    if (candidates.length === 0) return;
    void refreshSlots();
    const timer = setInterval(() => void refreshSlots(), 4000);
    return () => clearInterval(timer);
  }, [candidates.length, refreshSlots]);

  const workCwd = task.workCwd;
  // 任务数据目录（actions/ artifact + workspace/ 产出）——server hydrate 时算好带下来；
  // 无仓任务也有、单独判断（不跟 workCwd 一起 early return）
  const taskDirAnchor = task.taskDirPath
    ? getIdeAnchorProps(task.taskDirPath, undefined, prefs?.jumpIde ?? "cursor", {
        newWindow: true,
      })
    : null;
  const hasRepoBar = !!workCwd && task.repoPaths.length > 0;
  if (!hasRepoBar && !taskDirAnchor) return null;

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

  // 命令仅用于按钮 title 展示——实际执行的命令由 server 从权威配置查（CR-01）
  const start = async (repoPath: string) => {
    setBusy(true);
    try {
      const res = await startTaskPreview(task.id, repoPath);
      // 合并进本地 slots（同仓替换），避免等下一轮轮询
      setSlots((prev) => [
        ...prev.filter((s) => s.repoPath !== res.slot.repoPath),
        res.slot,
      ]);
      if (res.replacedTaskTitle) {
        toast.info(`已停掉「${res.replacedTaskTitle}」对该仓的预览`);
      }
      toast.success("预览启动中、探测到地址后可点「打开」");
    } catch (err) {
      toast.error(`预览启动失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (repoPath: string) => {
    setBusy(true);
    try {
      await stopTaskPreview(repoPath);
      setSlots((prev) => prev.filter((s) => s.repoPath !== repoPath));
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 多仓才画组边框 + 短名 label；单仓保持扁平、避免无谓加重
  const multi = ideTargets.length > 1;
  const ideRepoSet = new Set(ideTargets.map((t) => t.repoPath));
  // candidates 理论上都挂在 ideTargets 上；对不上的兜底单独放（避免预览按钮消失）
  const orphanCandidates = candidates.filter((c) => !ideRepoSet.has(c.repoPath));

  /** 某仓组内的预览区：未跑→启动钮；本仓本任务在跑→运行态；本仓本任务已退→重试。
   *  每仓独立判断、互不隐藏（修旧 bug：一仓预览中另一仓按钮消失）。 */
  const renderPreviewForRepo = (repoPath: string) => {
    const mine = slots.find(
      (s) => s.repoPath === repoPath && s.taskId === task.id,
    );
    if (mine && !mine.exited) {
      return (
        <>
          <span className="inline-flex items-center gap-1 px-1 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            预览中
          </span>
          {mine.url && (
            <Button
              variant="ghost"
              size="sm"
              className={BTN_CLS}
              nativeButton={false}
              render={
                <a
                  href={mine.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-underline"
                  title={`打开 ${mine.url}`}
                />
              }
            >
              <ExternalLink className="size-3" />
              打开
            </Button>
          )}
          <PreviewLogPopover slot={mine} />
          <Button
            variant="ghost"
            size="sm"
            className={BTN_CLS}
            disabled={busy}
            onClick={() => void stop(repoPath)}
            title="停止预览 dev server"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
            停止
          </Button>
        </>
      );
    }
    if (mine && mine.exited) {
      return (
        <>
          <span className="inline-flex items-center gap-1 px-1 text-xs text-destructive/80">
            <span className="size-1.5 rounded-full bg-destructive/80" />
            预览已退出{mine.exitCode !== null ? `（exit ${mine.exitCode}）` : ""}
          </span>
          <PreviewLogPopover slot={mine} />
          <Button
            variant="ghost"
            size="sm"
            className={BTN_CLS}
            disabled={busy}
            onClick={() => void start(mine.repoPath)}
            title="用同一命令重新启动预览"
          >
            <Play className="size-3" />
            重试
          </Button>
        </>
      );
    }
    // 本任务本仓未占预览位：有命令才显示启动钮
    const c = candidates.find((x) => x.repoPath === repoPath);
    if (!c) return null;
    // 同仓被别的任务占着且未退出 → title 提示会顶掉
    const occupiedByOther = slots.find(
      (s) => s.repoPath === repoPath && s.taskId !== task.id && !s.exited,
    );
    return (
      <Button
        variant="ghost"
        size="sm"
        className={BTN_CLS}
        disabled={busy}
        onClick={() => void start(c.repoPath)}
        title={
          `在任务工作区起 dev server：${c.command}` +
          (occupiedByOther
            ? `\n（会停掉「${occupiedByOther.taskTitle}」对该仓的预览）`
            : "")
        }
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
        预览
      </Button>
    );
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {/* 按仓分组：IDE 打开 + 复制该仓路径 + 预览（有命令才有）。
          cursor:// 同 frame 裸 <a>（壳 will-navigate 拦截转系统协议）——ui-conventions 约定 */}
      {ideTargets.map((t) => {
        // newWindow：开的是整个工作区目录、必须新窗口——cursor:// 默认会把当前活跃
        // 窗口的工作区直接换掉（用户实测正干活的窗口没了）
        const anchor = getIdeAnchorProps(t.workDir, undefined, prefs?.jumpIde ?? "cursor", {
          newWindow: true,
        });
        const groupInner = (
          <>
            {multi && (
              <span className="px-1 text-[11px] text-muted-foreground">{t.shortName}</span>
            )}
            {anchor && (
              <Button
                variant="ghost"
                size="sm"
                className={BTN_CLS}
                nativeButton={false}
                render={
                  <a
                    {...anchor}
                    className="no-underline"
                    title={`在 IDE 打开项目\n${t.workDir}`}
                  />
                }
              >
                <SquareArrowOutUpRight className="size-3" />
                在 IDE 打开
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className={BTN_CLS}
              onClick={() => void copyPath(t.workDir)}
              title={`复制工作区路径\n${t.workDir}`}
            >
              <Copy className="size-3" />
              复制路径
            </Button>
            {renderPreviewForRepo(t.repoPath)}
          </>
        );
        return multi ? (
          <div
            key={t.repoPath}
            className="inline-flex items-center gap-0.5 rounded-md border border-border/50 px-1 py-0.5"
          >
            {groupInner}
          </div>
        ) : (
          <div key={t.repoPath} className="contents">
            {groupInner}
          </div>
        );
      })}

      {/* candidates 的 repoPath 不在 ideTargets 时兜底（理论上不该发生） */}
      {orphanCandidates.map((c) => {
        const orphanInner = (
          <>
            {multi && (
              <span className="px-1 text-[11px] text-muted-foreground">
                {c.repoPath.split("/").filter(Boolean).pop()}
              </span>
            )}
            {renderPreviewForRepo(c.repoPath)}
          </>
        );
        return multi ? (
          <div
            key={`orphan-${c.repoPath}`}
            className="inline-flex items-center gap-0.5 rounded-md border border-border/50 px-1 py-0.5"
          >
            {orphanInner}
          </div>
        ) : (
          <div key={`orphan-${c.repoPath}`} className="contents">
            {orphanInner}
          </div>
        );
      })}

      {/* 打开任务数据目录——整条操作栏最后；无仓任务也只剩这一颗 */}
      {taskDirAnchor && (
        <Button
          variant="ghost"
          size="sm"
          className={BTN_CLS}
          nativeButton={false}
          render={
            <a
              {...taskDirAnchor}
              className="no-underline"
              title={`打开任务文件夹（artifact / workspace 产出都在这）\n${task.taskDirPath}`}
            />
          }
        >
          <FolderOpen className="size-3" />
          任务文件夹
        </Button>
      )}
    </div>
  );
};

// 预览日志 popover（启动失败排查 / 看 dev server 输出）
const PreviewLogPopover = ({ slot }: { slot: PreviewSlotStatus }) => (
  <Popover>
    <PopoverTrigger
      render={
        <Button
          variant="ghost"
          size="sm"
          className={BTN_CLS}
          title="查看 dev server 最近输出"
        />
      }
    >
      <FileTerminal className="size-3" />
      日志
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[480px] p-2">
      <div className="mb-1 truncate font-mono text-[10px] text-muted-foreground" title={slot.command}>
        $ {slot.command}
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
        {slot.logTail.length > 0 ? slot.logTail.join("\n") : "（暂无输出）"}
      </pre>
    </PopoverContent>
  </Popover>
);
