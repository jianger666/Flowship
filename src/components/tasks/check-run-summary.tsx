"use client";

/**
 * CheckRun 结果展示卡（V0.6.25）
 *
 * 渲染 build action 的 `checkRun` 结构化摘要——server 跑完每仓 checkCommands 后落的明细。
 * 展示层级：整体状态 → 每仓状态 → 每条命令状态 + 失败日志末尾 + 完整日志路径。
 *
 * 设计：
 * - 失败 / 超时 / 工作区污染的命令默认展开 logTail（摘要直接定位问题）、通过的折叠不占地方。
 * - 完整日志落文件（CheckRepoResult.logPath、相对 data/tasks/<id>/）、这里只给路径文本、
 *   用户要看全量自己去文件系统翻（前端拿不到 data 目录绝对路径、不强做 cursor link）。
 */

import { Badge } from "@/components/ui/badge";
import { pathBasename } from "@/lib/path-utils";
import { CHECK_STATUS_LABEL, CHECK_STATUS_VARIANT } from "@/lib/task-display";
import { CHECK_COMMAND_KIND_LABEL } from "@/lib/types";
import type { CheckRunSummary } from "@/lib/types";

// 耗时格式化：<1s 给 ms、<1min 给秒、否则 m+s（check 专属、一次性、不抽 lib）
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
};

interface Props {
  checkRun: CheckRunSummary;
}

export const CheckRunSummaryCard = ({ checkRun }: Props) => {
  const totalMs = Math.max(0, checkRun.endedAt - checkRun.startedAt);

  return (
    <div className="grid gap-2 rounded-lg border bg-card/40 px-3 py-2 text-xs">
      {/* 顶部：整体状态 + 总耗时 */}
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">确定性检查</span>
        <Badge variant={CHECK_STATUS_VARIANT[checkRun.status]}>
          {CHECK_STATUS_LABEL[checkRun.status]}
        </Badge>
        <span className="ml-auto text-muted-foreground">
          {formatDuration(totalMs)}
        </span>
      </div>

      {/* 每仓一块 */}
      {checkRun.repos.map((repo) => (
        <div key={repo.repoPath} className="grid gap-1.5 rounded-md border bg-background/40 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate font-mono text-foreground/80"
              title={repo.repoPath}
            >
              {pathBasename(repo.repoPath)}
            </code>
            <Badge variant={CHECK_STATUS_VARIANT[repo.status]}>
              {CHECK_STATUS_LABEL[repo.status]}
            </Badge>
          </div>

          {repo.status === "not_configured" ? (
            <div className="text-muted-foreground">
              有改动但没配检查命令、ship 需确认
            </div>
          ) : repo.status === "skipped" ? (
            <div className="text-muted-foreground">本次没改动、跳过</div>
          ) : (
            <div className="grid gap-1.5">
              {repo.commands.map((cmd) => {
                // 失败 / 超时 / 偷改工作区 → 默认展开末尾日志定位问题
                const showLog =
                  cmd.status !== "passed" || cmd.mutatedWorktree;
                return (
                  <div key={cmd.name} className="grid gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground/90">
                        {cmd.name}
                      </span>
                      <span className="text-muted-foreground">
                        {CHECK_COMMAND_KIND_LABEL[cmd.kind]}
                      </span>
                      {!cmd.required && (
                        <span className="text-muted-foreground">（选填）</span>
                      )}
                      <Badge
                        variant={CHECK_STATUS_VARIANT[cmd.status]}
                        className="ml-auto"
                      >
                        {CHECK_STATUS_LABEL[cmd.status]}
                      </Badge>
                      <span className="text-muted-foreground">
                        {formatDuration(cmd.durationMs)}
                      </span>
                    </div>
                    {/* 命令把 tracked 文件改了——可能手滑配了 --fix、判不可信 */}
                    {cmd.mutatedWorktree && (
                      <div className="text-destructive">
                        ⚠ 命令改动了工作区（疑似偷改源码、已判失败）
                      </div>
                    )}
                    {showLog && cmd.logTail && (
                      <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80 wrap-anywhere">
                        {cmd.logTail}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {repo.logPath && (
            <div className="text-muted-foreground">
              完整日志：<code className="font-mono">{repo.logPath}</code>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
