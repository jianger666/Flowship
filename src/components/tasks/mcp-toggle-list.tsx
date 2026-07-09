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
 * 2. 自管模式：传 taskId + onUpdated、组件自己 PATCH 后端 + toast（用于详情页面板）
 *    PATCH 成功后把返回的最新 task 经 onUpdated 回传给页面 setTask——
 *    改黑名单只写 meta 不产生事件、SSE 不会推、不回传开关就永远弹回
 *
 * 设计依赖：调用方负责传入「当前 Cursor 配的所有 MCP 名」、组件不读配置（保持纯展示）。
 */

import { useState } from "react";
import { Loader2, Plug } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { settingsUrl } from "@/lib/settings-link";
import { setTaskDisabledMcpServers } from "@/lib/task-store";
import { MCP_HEALTH_LABEL } from "@/lib/types";
import type { McpHealth, McpHealthStatus, Task } from "@/lib/types";

// 连通性状态点 / 文字配色（V0.6.13 收敛为 ok 绿 / fail 红两态）
const HEALTH_DOT: Record<McpHealthStatus, string> = {
  ok: "bg-emerald-500",
  fail: "bg-red-500",
};
const HEALTH_TEXT: Record<McpHealthStatus, string> = {
  ok: "text-emerald-600 dark:text-emerald-500",
  fail: "text-red-600 dark:text-red-500",
};

// 单个 server 的连通性徽标：点 + 中文。h 没探到 + loading → spinner。
// 失败（fail）渲染成可点 button、点 onShowLog 弹报错日志；正常（ok）是普通 span（hover 看详情）。
// export：设置页 MCP 卡条目行复用（V0.13 常用开关并入条目行后、设置页不再挂整个 McpToggleList）
export const HealthBadge = ({
  h,
  loading,
  onShowLog,
}: {
  h?: McpHealth;
  loading?: boolean;
  onShowLog?: () => void;
}) => {
  if (h) {
    const dot = (
      <span className={cn("size-1.5 rounded-full", HEALTH_DOT[h.status])} />
    );
    if (h.status === "fail") {
      return (
        <button
          type="button"
          onClick={onShowLog}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-1 text-[11px] underline-offset-2 hover:underline",
            HEALTH_TEXT[h.status],
          )}
          title="点击看报错日志"
        >
          {dot}
          {MCP_HEALTH_LABEL[h.status]}
        </button>
      );
    }
    return (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-[11px]",
          HEALTH_TEXT[h.status],
        )}
        title={
          h.detail
            ? `${MCP_HEALTH_LABEL[h.status]}：${h.detail}`
            : MCP_HEALTH_LABEL[h.status]
        }
      >
        {dot}
        {MCP_HEALTH_LABEL[h.status]}
      </span>
    );
  }
  if (loading) {
    return (
      <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/50" />
    );
  }
  return null;
};

interface McpToggleListProps {
  // 当前可选的 MCP server 名（来自 Cursor ~/.cursor/mcp.json）
  availableServers: string[];
  // 当前禁用的 server 名（受控）
  disabled: string[];
  // 受控模式：onChange 同步给父组件；自管模式不传、组件自己 PATCH
  onChange?: (nextDisabled: string[]) => void;
  // 自管模式必填、用于发 PATCH 请求
  taskId?: string;
  // 自管模式：PATCH 成功后把服务端返回的最新 task 回传（调用方 setTask 刷新页面 state）
  // ⚠️ 必传——改 MCP 黑名单只写 meta 不产生事件、SSE 不会推、不回传 disabled prop 永远不更新
  onUpdated?: (task: Task) => void;
  // 空状态文案
  emptyHint?: string;
  // 容器额外 className
  className?: string;
  // 各 server 连通性状态（V0.6.11、传了才展示状态点；只展示「已开启」的）
  health?: Record<string, McpHealth>;
  // 正在探测的 server 集合（V0.6.13、per-server spinner、哪行探哪行转圈）
  loadingServers?: Set<string>;
  // 把某 server 关→开时回调（V0.6.13、调用方据此单独探这一个的连通性、对齐 Cursor）
  onEnableProbe?: (server: string) => void;
}

export const McpToggleList = ({
  availableServers,
  disabled,
  onChange,
  taskId,
  onUpdated,
  emptyHint = "Cursor 里没配 MCP server",
  className,
  health,
  loadingServers,
  onEnableProbe,
}: McpToggleListProps) => {
  // 自管模式下、PATCH 进行中的 server 名集合（按 server 名锁、避免重复点）
  const [pending, setPending] = useState<Set<string>>(new Set());
  // 失败日志弹窗：当前查看的失败 server 的 health（null=不开）
  const [logHealth, setLogHealth] = useState<McpHealth | null>(null);

  const isAutoMode = !onChange && !!taskId;

  // 切换一个 server 的启用状态
  // - 受控模式：直接调 onChange
  // - 自管模式：乐观更新、PATCH 失败 toast 但不回滚（避免抖动、用户重试就行）
  const toggle = async (server: string, enable: boolean) => {
    const next = enable
      ? disabled.filter((s) => s !== server)
      : [...new Set([...disabled, server])];

    // 关→开：单独探这一个的连通性（对齐 Cursor、打开才连、不触发全量重探）
    if (enable) onEnableProbe?.(server);

    if (!isAutoMode) {
      onChange?.(next);
      return;
    }

    setPending((prev) => new Set(prev).add(server));
    try {
      const updated = await setTaskDisabledMcpServers(
        taskId!,
        next.length > 0 ? next : null,
      );
      // 改黑名单只写 meta、不产生事件、SSE 不会推——必须用 PATCH 返回的 task 回传刷新
      // （V0.6.29 修「开关点了闪一下弹回」：原来这里丢弃返回值干等 SSE、prop 永远不变）
      onUpdated?.(updated);
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
    <>
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
                    isDisabled
                      ? "text-muted-foreground/40"
                      : "text-emerald-500",
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
              {!isDisabled && (
                <HealthBadge
                  h={health?.[name]}
                  loading={loadingServers?.has(name)}
                  onShowLog={() => {
                    const h = health?.[name];
                    if (h) setLogHealth(h);
                  }}
                />
              )}
              {/* 固定 h-5 w-9 格子（与 Switch 同尺寸）：toggle 期间 Switch ↔ Loader2 互换时
                  行高恒定、不跳变——否则 popover 形态（ChatMcpPicker）下行高跳 4px 会触发重定位抖动 */}
              <span className="flex h-5 w-9 shrink-0 items-center justify-center">
                {isPending ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Switch
                    checked={!isDisabled}
                    onCheckedChange={(checked) => void toggle(name, checked)}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {/* 失败日志弹窗：点失败徽标弹出、展示探测时的报错详情（detail） */}
      <Dialog
        open={!!logHealth}
        onOpenChange={(o) => {
          if (!o) setLogHealth(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-red-500" />
              <span className="truncate font-mono">{logHealth?.name}</span>
              <span className="text-muted-foreground">连接失败</span>
            </DialogTitle>
            <DialogDescription>
              排查后
              <a
                href={settingsUrl("mcp")}
                className="text-primary underline-offset-2 hover:underline"
              >
                去设置页授权
              </a>
              ，再点「重新检测」
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {logHealth?.detail ?? "（无详情、可能是未知错误）"}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
};
