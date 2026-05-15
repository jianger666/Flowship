"use client";

/**
 * 任务级 MCP 开关（V0.3.3 button + dialog 形态）
 *
 * - 按钮显示当前启用数：「MCP servers (3/4)」
 * - 点击弹 Dialog、内部列出所有 server、每条一个 Switch
 * - 切换 → 立即 PATCH 后端（McpToggleList 内部 handle）、不需要保存按钮
 * - 任务正在跑时 Dialog 底部提示「下次启动 / revise 时生效」
 */

import { useEffect, useMemo, useState } from "react";
import { Plug } from "lucide-react";

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
import { getSettings } from "@/lib/local-store";
import { parseMcpServers } from "@/lib/task-store";
import type { Task } from "@/lib/types";

interface TaskMcpPanelProps {
  task: Task;
}

export const TaskMcpPanel = ({ task }: TaskMcpPanelProps) => {
  // 主 Dialog 开关、默认关
  const [open, setOpen] = useState(false);
  // 当前 settings 里所有 MCP server 名（从 localStorage 解析）
  const [availableServers, setAvailableServers] = useState<string[]>([]);

  // 首次挂载 + window 拿焦点时 refresh（用户可能去 settings 改了 MCP 配置）
  useEffect(() => {
    const sync = () => {
      try {
        const parsed = parseMcpServers(getSettings().mcpServersJson);
        setAvailableServers(parsed ? Object.keys(parsed) : []);
      } catch {
        setAvailableServers([]);
      }
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  // 当前禁用的 server 列表（来自 task）、用 useMemo 避免无谓 re-render
  const disabled = useMemo(
    () => task.disabledMcpServers ?? [],
    [task.disabledMcpServers],
  );

  // 启用计数（用于按钮上的数字提示）
  const enabledCount = useMemo(
    () => availableServers.filter((s) => !disabled.includes(s)).length,
    [availableServers, disabled],
  );

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
              选本任务启用哪些 MCP。改完下次启动 workflow / chat 时生效——已在跑的 SDK Run 不会热改
            </DialogDescription>
          </DialogHeader>

          {availableServers.length === 0 ? (
            <EmptyHint>
              全局 settings 里没配置 MCP server、去「设置」加一下
            </EmptyHint>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <McpToggleList
                availableServers={availableServers}
                disabled={disabled}
                taskId={task.id}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
