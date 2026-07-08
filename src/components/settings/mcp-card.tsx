"use client";

/**
 * MCP servers 卡片
 *
 * fe 自管 MCP（可编辑 JSON）+ Cursor mcp.json（只读）+ 一键从 Cursor 导入；
 * agent 启动时 server 端 merge 两份配置后再按黑名单过滤。
 */

import { useEffect, useMemo, useState } from "react";
import { Download, Plug, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { McpServerConfig } from "@cursor/sdk";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import { useDialog } from "@/hooks/use-dialog";
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useMcpHealth } from "@/hooks/use-mcp-health";
import { useMcpOAuth } from "@/hooks/use-mcp-oauth";
import { mergeMcpSources } from "@/lib/mcp-config";
import { fetchCursorMcp } from "@/lib/task-store";
import { cn } from "@/lib/utils";

interface McpCardProps {
  appServers: Record<string, McpServerConfig>;
  onAppServersChange: (next: Record<string, McpServerConfig>) => void;
  onAppServersCommit: (next: Record<string, McpServerConfig>) => void;
  disabledServers: string[];
  onChange: (next: string[]) => void;
}

export const McpCard = ({
  appServers,
  onAppServersChange,
  onAppServersCommit,
  disabledServers,
  onChange,
}: McpCardProps) => {
  const { prompt } = useDialog();
  const { cursorServers, dirs, loading, error, refresh } = useCursorMcp();
  const { statuses, busy, authorize, revoke } = useMcpOAuth();

  // 合并后的 server 集合（常用开关 / 健康探测候选）
  const mergedServers = useMemo(
    () => mergeMcpSources(cursorServers, appServers),
    [cursorServers, appServers],
  );
  const mergedNames = useMemo(() => Object.keys(mergedServers), [mergedServers]);

  const enabledServers = useMemo(
    () => mergedNames.filter((n) => !disabledServers.includes(n)),
    [mergedNames, disabledServers],
  );

  const {
    health,
    loadingServers,
    refresh: recheckHealth,
    probeOne,
  } = useMcpHealth(enabledServers, !loading);

  const appJson = JSON.stringify({ mcpServers: appServers }, null, 2);
  const cursorJson = JSON.stringify({ mcpServers: cursorServers }, null, 2);
  const sourceFile = dirs[0] ? `${dirs[0]}/mcp.json` : "~/.cursor/mcp.json";
  const oauthServers = Object.keys(statuses);

  // 编辑 fe 自管 JSON 草稿（blur 落盘）
  const [appJsonDraft, setAppJsonDraft] = useState(appJson);
  const [importing, setImporting] = useState(false);

  const syncAppJsonDraft = (next: Record<string, McpServerConfig>) => {
    setAppJsonDraft(JSON.stringify({ mcpServers: next }, null, 2));
  };

  useEffect(() => {
    syncAppJsonDraft(appServers);
  }, [appServers]);

  const handleAppJsonChange = (raw: string) => {
    setAppJsonDraft(raw);
    try {
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        onAppServersChange(parsed.mcpServers);
        onAppServersCommit(parsed.mcpServers);
      }
    } catch {
      // 编辑中途 JSON 可能暂时非法
    }
  };

  const handleImportCursor = async () => {
    setImporting(true);
    try {
      const data = await fetchCursorMcp();
      const next = { ...appServers, ...data.servers };
      onAppServersCommit(next);
      syncAppJsonDraft(next);
      toast.success(`已从 Cursor 导入 ${Object.keys(data.servers).length} 个 server`);
    } catch (err) {
      toast.error(
        `导入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImporting(false);
    }
  };

  const handleAddServer = async () => {
    const name = await prompt({
      title: "新增 MCP",
      placeholder: "server 名称",
      confirmLabel: "添加",
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "名称不能为空";
        if (mergedServers[trimmed]) return "名称已存在";
        return "";
      },
    });
    if (name === null) return;
    const key = name.trim();
    const next = {
      ...appServers,
      [key]: { type: "http", url: "" } as McpServerConfig,
    };
    onAppServersCommit(next);
    syncAppJsonDraft(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>本应用配置与 Cursor 合并后传给 agent</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={importing}
            onClick={() => void handleImportCursor()}
          >
            <Download />
            从 Cursor 导入
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void handleAddServer()}>
            <Plus />
            新增
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw />
            刷新 Cursor
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium">本应用 MCP</div>
          <CodeEditor
            id="app-mcp-json"
            value={appJsonDraft}
            onChange={handleAppJsonChange}
            language="json"
            rows={10}
          />
        </div>

        {loading ? (
          <LoadingState variant="inline" />
        ) : error ? (
          <div className="text-destructive text-xs">读取 Cursor 失败：{error}</div>
        ) : Object.keys(cursorServers).length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">
              Cursor（只读）<code className="ml-1 text-[11px]">{sourceFile}</code>
            </div>
            <CodeEditor
              id="cursor-mcp-json"
              value={cursorJson}
              onChange={() => {}}
              language="json"
              rows={8}
              disabled
            />
          </div>
        ) : (
          <EmptyHint size="sm">Cursor 里没配 MCP（{sourceFile}）</EmptyHint>
        )}

        {mergedNames.length === 0 ? (
          <EmptyHint>还没有任何 MCP server</EmptyHint>
        ) : (
          <>
            {oauthServers.length > 0 && (
              <div className="space-y-2 rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  OAuth 授权
                </div>
                <div className="space-y-1.5">
                  {oauthServers.map((name) => {
                    const authorized = statuses[name]?.authorized;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm" title={name}>
                          {name}
                        </span>
                        {authorized && (
                          <Badge variant="secondary" className="shrink-0">
                            已授权
                          </Badge>
                        )}
                        <Button
                          size="xs"
                          variant={authorized ? "ghost" : "default"}
                          onClick={() => authorize(name)}
                          disabled={busy === name}
                        >
                          {authorized ? "重新授权" : "授权"}
                        </Button>
                        {authorized && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => revoke(name)}
                            disabled={busy === name}
                          >
                            撤销
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Plug className="size-3.5 shrink-0" />
                  常用 MCP
                </div>
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
              <McpToggleList
                availableServers={mergedNames}
                disabled={disabledServers}
                onChange={onChange}
                health={health}
                loadingServers={loadingServers}
                onEnableProbe={probeOne}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};
