"use client";

/**
 * MCP servers 卡片（V0.6.2 起只读展示 Cursor 配置 + V0.6.4 加 OAuth 授权区）
 *
 * 背景「跟 Cursor 共用工具」：fe 不再自己存 / 编辑 MCP 配置、统一读 Cursor 的
 * `~/.cursor/mcp.json` 展示（单一源）。用户要改 MCP 去 Cursor 改、fe 这边只读 +
 * 留 task 级黑名单开关（在任务详情页 / 新建弹窗里选本任务挂哪些）。
 *
 * V0.6.4：走 OAuth 授权的远程 MCP（如飞书项目）token 不在 mcp.json、Cursor 存自己内部、
 * fe 的 SDK agent 是 headless 弹不了浏览器 → 这里给这类 server 一个「授权」入口、
 * fe 自己跑标准 OAuth flow、token 落盘、起 agent 时注入。详见 mcp-oauth.ts。
 *
 * 不脱敏（用户拍板）：本地单机工具、原样展示完整 JSON（含 token / env）、跟 Cursor 一致。
 */

import { useMemo } from "react";
import { FileCode, ShieldCheck } from "lucide-react";

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
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useMcpOAuth } from "@/hooks/use-mcp-oauth";

export const McpCard = () => {
  const { servers, names, dirs, loading, error } = useCursorMcp();
  const { statuses, busy, authorize, revoke } = useMcpOAuth();

  // 原样拼回 { mcpServers: {...} }（跟 ~/.cursor/mcp.json 文件结构一致）、只读展示
  const json = JSON.stringify({ mcpServers: servers }, null, 2);
  // 读取来源（展示「配置读自哪个文件」、让用户知道去哪改）
  const sourceFile = dirs[0] ? `${dirs[0]}/mcp.json` : "~/.cursor/mcp.json";

  // 可走 OAuth 的 server：http/sse 类（有 url）、且没在 mcp.json 手配 Authorization header
  const oauthCandidates = useMemo(
    () =>
      Object.entries(servers)
        .filter(([, cfg]) => {
          if (!("url" in cfg)) return false;
          const hasAuth =
            cfg.headers &&
            Object.keys(cfg.headers).some(
              (k) => k.toLowerCase() === "authorization",
            );
          return !hasAuth;
        })
        .map(([name]) => name),
    [servers],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>
          只读、读自 Cursor 的 <code className="text-xs">{sourceFile}</code>
          。要改去 Cursor 改、这里跟它保持同步
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <LoadingState variant="inline" />
        ) : error ? (
          <div className="text-destructive text-xs">读取失败：{error}</div>
        ) : names.length === 0 ? (
          <EmptyHint>Cursor 里没配 MCP server（{sourceFile}）</EmptyHint>
        ) : (
          <>
            {/* OAuth 授权区：走 OAuth 的 MCP 在这点授权、token 自动续期 */}
            {oauthCandidates.length > 0 && (
              <div className="space-y-2 rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  OAuth 授权——走 OAuth 的 MCP（如飞书项目）在这授权、token 自动续期
                </div>
                <div className="space-y-1.5">
                  {oauthCandidates.map((name) => {
                    const authorized = statuses[name]?.authorized;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span
                          className="min-w-0 flex-1 truncate text-sm"
                          title={name}
                        >
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

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileCode className="size-3.5 shrink-0" />共 {names.length} 个
              server、按 task 级黑名单过滤后传给 agent
            </div>
            <CodeEditor
              id="mcp-json"
              value={json}
              onChange={() => {}}
              language="json"
              rows={14}
              disabled
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};
