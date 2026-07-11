"use client";

/**
 * 任务工作区快捷操作条（V0.10.1、worktree 隔离的配套体验）
 *
 * 渲染在任务详情页路径行下方、三组能力：
 * 1. 在 IDE 打开工作区——cursor:// deep link 直接打开 agent 实际干活的目录
 *    （隔离 task = worktree、路径很深、手动找很费劲）
 * 2. 复制工作区路径——终端 cd 用
 * 3. 预览（单预览位）——设置页给仓库配了「预览启动命令」才显示；点了自动停掉
 *    上一个任务的 dev server、在本任务工作区起新的（体验对齐单分支时代）
 *
 * 预览状态轮询 /api/preview（仅本组件挂载期间、4s 一次、本地调用很轻）。
 */

import {
  Copy,
  ExternalLink,
  FileTerminal,
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
import { getRepoWorkDirs } from "@/lib/path-utils";
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
  // 预览位全局状态（null = 没人在预览）
  const [slot, setSlot] = useState<PreviewSlotStatus | null>(null);
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

  const refreshSlot = useCallback(async () => {
    try {
      setSlot(await fetchPreviewStatus());
    } catch {
      // 本地接口偶发失败不打扰、下一轮轮询自纠
    }
  }, []);

  // 有可预览仓才轮询（4s、本地调用很轻）；没配预览命令的任务零开销
  useEffect(() => {
    if (candidates.length === 0) return;
    void refreshSlot();
    const timer = setInterval(() => void refreshSlot(), 4000);
    return () => clearInterval(timer);
  }, [candidates.length, refreshSlot]);

  const workCwd = task.workCwd;
  if (!workCwd || task.repoPaths.length === 0) return null;

  // V0.12.3：IDE 逐仓打开各自项目根、不再打开多仓公共父目录（同事实测 IDEA 把整个
  // D:/IdeaProjects 当项目开了）；每仓一个按钮、单仓时不带短名后缀
  const ideTargets = getRepoWorkDirs(
    task.repoPaths,
    workCwd,
    task.isolateWorktree === true,
  );

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(workCwd);
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
      setSlot(res.slot);
      if (res.replacedTaskTitle) {
        toast.info(`已停掉「${res.replacedTaskTitle}」的预览`);
      }
      toast.success("预览启动中、探测到地址后可点「打开」");
    } catch (err) {
      toast.error(`预览启动失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopTaskPreview();
      setSlot(null);
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 预览位属于本任务才展示运行态（别的任务在预览时、本任务仍显示「预览」、点了顶掉）
  const mine = slot?.taskId === task.id ? slot : null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {/* cursor:// 同 frame 裸 <a>（壳 will-navigate 拦截转系统协议、页面不动）——ui-conventions 约定；
          JetBrains 系走 onClick 后端拉起（getIdeAnchorProps 内部切换）。
          多仓逐仓一个按钮（各开各的项目窗口）、单仓不带短名后缀 */}
      {ideTargets.map((t) => {
        // newWindow：开的是整个工作区目录、必须新窗口——cursor:// 默认会把当前活跃
        // 窗口的工作区直接换掉（用户实测正干活的窗口没了）
        const anchor = getIdeAnchorProps(t.workDir, undefined, prefs?.jumpIde ?? "cursor", {
          newWindow: true,
        });
        if (!anchor) return null;
        return (
          <Button
            key={t.repoPath}
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
            {ideTargets.length > 1 && `（${t.shortName}）`}
          </Button>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className={BTN_CLS}
        onClick={copyPath}
        title={`复制工作区路径\n${workCwd}`}
      >
        <Copy className="size-3" />
        复制路径
      </Button>

      {/* 「需求详情」按钮已删（v1.1.x 用户拍板）：工作项的 description 字段团队实践里
          都是空的（产品写飞书文档、往工作项贴链接）、点开永远空白纯误导 */}

      {candidates.length > 0 && !mine && (
        // 未在预览（或预览位被别的任务占着）：起本任务的预览。
        // 多仓多命令时逐仓给按钮（常见就 1 个、不上 dropdown）
        candidates.map((c) => (
          <Button
            key={c.repoPath}
            variant="ghost"
            size="sm"
            className={BTN_CLS}
            disabled={busy}
            onClick={() => void start(c.repoPath)}
            title={
              `在任务工作区起 dev server：${c.command}` +
              (slot && !slot.exited && slot.taskId !== task.id
                ? `\n（会停掉「${slot.taskTitle}」正在跑的预览——全局单预览位）`
                : "")
            }
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            预览
            {candidates.length > 1 &&
              `（${c.repoPath.split("/").filter(Boolean).pop()}）`}
          </Button>
        ))
      )}

      {mine && !mine.exited && (
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
            onClick={() => void stop()}
            title="停止预览 dev server"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
            停止
          </Button>
        </>
      )}

      {mine && mine.exited && (
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
