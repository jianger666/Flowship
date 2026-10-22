"use client";

/**
 * 任务级 MCP 开关（V0.3.3 button + dialog 形态）
 *
 * - 按钮是「MCP」+ 一个「已启用/总数」计数徽标（如 3/4）
 * - 点击弹 Dialog、内部列出所有 server、每条一个 Switch
 * - 切换 → 立即 PATCH 后端（McpToggleList 内部 handle）、不需要保存按钮
 * - 列表下方常驻一句「何时生效」（mcpEffectNote，按 runStatus 区分）：开关只写 task.disabledMcpServers，
 *   已启动的 agent 不会热更新，要等下次推进新起 agent 才按新开关加载（V11-02；
 *   以前这里的注释声称有一句运行中的底部提示，实际从来没有渲染过）
 */

import { useMemo, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useMcpHealth } from "@/hooks/use-mcp-health";
import { mcpEffectNote } from "@/lib/mcp-effect-note";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";

interface TaskMcpPanelProps {
  task: Task;
  // 开关 PATCH 成功后回传最新 task（页面 setTask）——黑名单变更不走 SSE、必须主动刷
  onTaskUpdate: (task: Task) => void;
}

export const TaskMcpPanel = ({ task, onTaskUpdate }: TaskMcpPanelProps) => {
  // 主 Dialog 开关、默认关
  const [open, setOpen] = useState(false);
  // 当前 Cursor 配的所有 MCP server 名（hook 内置首拉 + focus 刷新）
  const { names: availableServers, loading: mcpLoading } = useCursorMcp();
  // 当前禁用的 server 列表（来自 task）、用 useMemo 避免无谓 re-render
  const disabled = useMemo(
    () => task.disabledMcpServers ?? [],
    [task.disabledMcpServers],
  );

  // 已开启的 server（不在黑名单里的）——只探这些（关闭的不连、对齐 Cursor）
  const enabledServers = useMemo(
    () => availableServers.filter((s) => !disabled.includes(s)),
    [availableServers, disabled],
  );

  // 各 server 连通性（dialog 打开时探开启的那批、打开某个关闭项时单独探）
  // active 传 open && !mcpLoading：dialog 打开且 names 已 ready 才首探（V0.6.13 修首探竞态）
  const {
    health,
    loadingServers,
    refresh: recheckHealth,
    probeOne,
  } = useMcpHealth(enabledServers, open && !mcpLoading);

  // 启用计数（用于按钮上的数字提示）
  const enabledCount = enabledServers.length;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Plug />
        MCP
        <span className="ml-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {enabledCount}/{availableServers.length}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>MCP</DialogTitle>
            <DialogDescription>
              选本任务启用哪些 MCP
            </DialogDescription>
          </DialogHeader>

          {mcpLoading ? (
            <LoadingState variant="inline" />
          ) : availableServers.length === 0 ? (
            <EmptyHint>
              Cursor 里没配 MCP server（~/.cursor/mcp.json）
            </EmptyHint>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  绿=正常 / 红=失败（点击看日志）
                </span>
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
              </div>
              <div className="max-h-72 overflow-y-auto">
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
              {/* 何时生效：开关即时落盘，但对已在跑的 agent 无效（见 mcp-effect-note 的事实依据） */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {mcpEffectNote(task.runStatus)}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
