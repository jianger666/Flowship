"use client";

/**
 * 任务级 MCP 开关（V0.3.3 button + dialog 形态）
 *
 * - 按钮显示当前启用数：「MCP servers (3/4)」
 * - 点击弹 Dialog、内部列出所有 server、每条一个 Switch
 * - 切换 → 立即 PATCH 后端（McpToggleList 内部 handle）、不需要保存按钮
 * - 任务正在跑时 Dialog 底部提示「下次启动 / revise 时生效」
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
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useMcpHealth } from "@/hooks/use-mcp-health";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";

interface TaskMcpPanelProps {
  task: Task;
}

export const TaskMcpPanel = ({ task }: TaskMcpPanelProps) => {
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
        MCP servers
        <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {enabledCount}/{availableServers.length}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>MCP servers</DialogTitle>
            <DialogDescription>
              选本任务启用哪些 MCP
            </DialogDescription>
          </DialogHeader>

          {availableServers.length === 0 ? (
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
                  health={health}
                  loadingServers={loadingServers}
                  onEnableProbe={probeOne}
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
