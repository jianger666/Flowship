"use client";

/**
 * 任务级 MCP 开关列表
 *
 * - 列出 Cursor 配的所有 MCP server、每条一个 switch
 * - 默认全开、关掉的进 disabledMcpServers 黑名单
 * - 同时支持新建任务（受控 disabled state）和详情页（每改一次 PATCH 到后端）
 *
 * 提供两种用法：
 * 1. 受控模式：传 value + onChange、组件内部不发请求（用于新建任务弹窗、还没 taskId）
 * 2. 自管模式：传 taskId + initial、组件自己 PATCH 后端 + toast（用于详情页面板）
 *    （为了避免组件状态分裂、自管模式只 hold 「乐观更新」一份 state、失败回滚）
 *
 * 设计依赖：调用方负责传入「当前 Cursor 配的所有 MCP 名」、组件不读配置（保持纯展示）。
 */

import { useState } from "react";
import { Loader2, Plug } from "lucide-react";
import { toast } from "sonner";

import { EmptyHint } from "@/components/ui/empty-hint";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { setTaskDisabledMcpServers } from "@/lib/task-store";

interface McpToggleListProps {
  // 当前可选的 MCP server 名（来自 Cursor ~/.cursor/mcp.json）
  availableServers: string[];
  // 当前禁用的 server 名（受控）
  disabled: string[];
  // 受控模式：onChange 同步给父组件；自管模式不传、组件自己 PATCH
  onChange?: (nextDisabled: string[]) => void;
  // 自管模式必填、用于发 PATCH 请求
  taskId?: string;
  // 空状态文案
  emptyHint?: string;
  // 容器额外 className
  className?: string;
}

export const McpToggleList = ({
  availableServers,
  disabled,
  onChange,
  taskId,
  emptyHint = "Cursor 里没配 MCP server",
  className,
}: McpToggleListProps) => {
  // 自管模式下、PATCH 进行中的 server 名集合（按 server 名锁、避免重复点）
  const [pending, setPending] = useState<Set<string>>(new Set());

  const isAutoMode = !onChange && !!taskId;

  // 切换一个 server 的启用状态
  // - 受控模式：直接调 onChange
  // - 自管模式：乐观更新、PATCH 失败 toast 但不回滚（避免抖动、用户重试就行）
  const toggle = async (server: string, enable: boolean) => {
    const next = enable
      ? disabled.filter((s) => s !== server)
      : [...new Set([...disabled, server])];

    if (!isAutoMode) {
      onChange?.(next);
      return;
    }

    setPending((prev) => new Set(prev).add(server));
    try {
      await setTaskDisabledMcpServers(taskId!, next.length > 0 ? next : null);
      // SSE / 父组件 fetchTask 会拿到最新 task、disabled 自然同步、这里不主动 setState
    } catch (err) {
      toast.error(
        `切换失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(server);
        return next;
      });
    }
  };

  if (availableServers.length === 0) {
    return <EmptyHint className={className}>{emptyHint}</EmptyHint>;
  }

  return (
    <ul className={cn("divide-y rounded-md border", className)}>
      {availableServers.map((name) => {
        const isDisabled = disabled.includes(name);
        const isPending = pending.has(name);
        return (
          <li
            key={name}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Plug
                className={cn(
                  "size-3.5 shrink-0",
                  isDisabled ? "text-muted-foreground/40" : "text-emerald-500",
                )}
              />
              <span
                className={cn(
                  "truncate font-mono text-xs",
                  isDisabled && "text-muted-foreground/60 line-through",
                )}
              >
                {name}
              </span>
            </div>
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <Switch
                checked={!isDisabled}
                onCheckedChange={(checked) => void toggle(name, checked)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
};
