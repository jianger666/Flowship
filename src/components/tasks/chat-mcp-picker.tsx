"use client";

/**
 * ChatMcpPicker：chat 自由对话「切 MCP」入口（V0.8）
 *
 * 放 textarea 上方一行、跟工作目录 / 分支选择器并排（composerTop）。视觉对齐它们的 h-7 popover
 * 紧凑风格、点开下拉切换本次对话启用哪些 MCP。复用 task 模式的 McpToggleList + useCursorMcp +
 * useMcpHealth（开关 / 连通性绿红点 / 失败日志全复用、不重复造）。
 *
 * 硬约束（同切模型语义、用户拍板）：MCP 在 SDK run 启动时绑死（Agent.create 时按黑名单过滤）——
 * - runStatus=running 时禁用：agent 正用当前 Run、当轮换不了、禁用避免误导
 * - 改了不立即重启：只 PATCH task.disabledMcpServers、用户下条消息起的新 Run 才用新 MCP 集合
 *   （chat-reply 比对「当前 Run 绑定黑名单 vs 现在的」、变了才懒重启、对齐切模型那套）
 *
 * 切换即走 McpToggleList 自管模式（内部 PATCH + 乐观更新）、PATCH 成功回传最新 task。
 */

import { useMemo, useState } from "react";
import { ChevronDown, Plug, RefreshCw } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useMcpHealth } from "@/hooks/use-mcp-health";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";

interface Props {
  task: Task;
  // 开关 PATCH 成功后回传最新 task（黑名单变更不走 SSE、必须主动刷新页面 state）
  onTaskUpdate: (next: Task) => void;
}

export const ChatMcpPicker = ({ task, onTaskUpdate }: Props) => {
  // popover 开关（受控）
  const [open, setOpen] = useState(false);
  // 当前 Cursor 配的所有 MCP server 名（hook 内置首拉 + focus 刷新）
  const { names: availableServers, loading: mcpLoading } = useCursorMcp();
  // 当前禁用的 server 列表（来自 task）、useMemo 避免无谓 re-render
  const disabled = useMemo(
    () => task.disabledMcpServers ?? [],
    [task.disabledMcpServers],
  );
  // 已开启的 server（不在黑名单里的）——只探这些（关闭的不连、对齐 Cursor）
  const enabledServers = useMemo(
    () => availableServers.filter((s) => !disabled.includes(s)),
    [availableServers, disabled],
  );
  // 各 server 连通性（active 传 open && !mcpLoading：popover 打开且 names ready 才首探、修首探竞态）
  const {
    health,
    loadingServers,
    refresh: recheckHealth,
    probeOne,
  } = useMcpHealth(enabledServers, open && !mcpLoading);

  // running 时整组禁用（当轮换不了、对齐 model / workdir / branch picker）
  const running = task.runStatus === "running";
  // 启用计数（trigger 上的数字提示）
  const enabledCount = enabledServers.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={running}
            title="选本次对话启用哪些 MCP"
            // 视觉对齐 ChatBranchPicker / ChatWorkdirPicker、三者并排齐平
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            )}
          >
            <Plug className="size-3.5 shrink-0 text-muted-foreground" />
            <span>MCP</span>
            <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {enabledCount}/{availableServers.length}
            </span>
            <ChevronDown className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
        {/* 顶部：标题 + 重新检测（有 server 才显示检测按钮） */}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="text-xs font-medium">MCP servers</div>
          {availableServers.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={recheckHealth}
              disabled={loadingServers.size > 0}
            >
              <RefreshCw
                className={cn(
                  "size-3",
                  loadingServers.size > 0 && "animate-spin",
                )}
              />
              重新检测
            </Button>
          )}
        </div>

        {mcpLoading ? (
          <div className="p-3">
            <LoadingState variant="inline" />
          </div>
        ) : availableServers.length === 0 ? (
          <div className="p-3">
            <EmptyHint>
              Cursor 里没配 MCP server（~/.cursor/mcp.json）
            </EmptyHint>
          </div>
        ) : (
          <>
            <div className="max-h-72 overflow-y-auto p-2">
              <McpToggleList
                availableServers={availableServers}
                disabled={disabled}
                taskId={task.id}
                onUpdated={onTaskUpdate}
                health={health}
                loadingServers={loadingServers}
                onEnableProbe={probeOne}
              />
            </div>
            {/* 轻提示：MCP 在 run 启动时绑死、改动靠下条消息触发懒重启生效（用户要求保留这句） */}
            <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
              切换将在下一条消息生效
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};
