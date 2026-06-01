"use client";

/**
 * MCP servers 卡片（V0.6.2 起改为只读展示 Cursor 配置）
 *
 * 背景「跟 Cursor 共用工具」：fe 不再自己存 / 编辑 MCP 配置、统一读 Cursor 的
 * `~/.cursor/mcp.json` 展示（单一源）。用户要改 MCP 去 Cursor 改、fe 这边只读 +
 * 留 task 级黑名单开关（在任务详情页 / 新建弹窗里选本任务挂哪些）。
 *
 * 不脱敏（用户拍板）：本地单机工具、原样展示完整 JSON（含 token / env）、跟 Cursor 一致。
 */

import { FileCode } from "lucide-react";

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

export const McpCard = () => {
  const { servers, names, dirs, loading, error } = useCursorMcp();

  // 原样拼回 { mcpServers: {...} }（跟 ~/.cursor/mcp.json 文件结构一致）、只读展示
  const json = JSON.stringify({ mcpServers: servers }, null, 2);
  // 读取来源（展示「配置读自哪个文件」、让用户知道去哪改）
  const sourceFile = dirs[0] ? `${dirs[0]}/mcp.json` : "~/.cursor/mcp.json";

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>
          只读、读自 Cursor 的 <code className="text-xs">{sourceFile}</code>
          。要改去 Cursor 改、这里跟它保持同步
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <LoadingState variant="inline" />
        ) : error ? (
          <div className="text-destructive text-xs">读取失败：{error}</div>
        ) : names.length === 0 ? (
          <EmptyHint>Cursor 里没配 MCP server（{sourceFile}）</EmptyHint>
        ) : (
          <>
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
