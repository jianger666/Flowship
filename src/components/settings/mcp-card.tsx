"use client";

/**
 * MCP servers 卡片
 *
 * - JSON 编辑器、schema 与 Cursor IDE 的 ~/.cursor/mcp.json 一致（外层带 mcpServers wrapper）
 * - 边输边校验：用 useMemo 同步派生 mcpError、不再走 effect roundtrip
 * - 「填入示例」按钮：写入 stdio + http 两种 transport 的真实示例、有内容时 confirm 防误覆盖
 */

import { useMemo } from "react";
import { FileCode } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useDialog } from "@/hooks/use-dialog";
import { DEFAULT_MCP_JSON } from "@/lib/local-store";

import { SaveButton } from "./save-button";

// MCP 配置示例：包含 stdio（npx 启动）和 http 远端两种 server 写法
// 用户点「填入示例」会写到 textarea、可以直接编辑成自己的配置
export const MCP_EXAMPLE_JSON = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"]
    },
    "feishu": {
      "command": "npx",
      "args": ["-y", "@example/feishu-mcp"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxx"
      }
    },
    "context7-remote": {
      "type": "http",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}`;

// 校验 MCP JSON：必须有 mcpServers 这层 wrapper、且为对象
// 与 Cursor IDE ~/.cursor/mcp.json schema 对齐、便于直接复制粘贴
// 不深入校单个 server 的 schema、留给 SDK 自己报错
export const validateMcpJson = (text: string): string => {
  if (!text.trim()) return "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "MCP 配置必须是 JSON 对象";
    }
    if (!("mcpServers" in parsed)) {
      return '缺少外层 "mcpServers" 键、请参照示例';
    }
    const servers = (parsed as { mcpServers: unknown }).mcpServers;
    if (
      typeof servers !== "object" ||
      servers === null ||
      Array.isArray(servers)
    ) {
      return '"mcpServers" 必须是对象（key 为 server 名）';
    }
    return "";
  } catch (err) {
    return `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

interface McpCardProps {
  value: string;
  onChange: (next: string) => void;
  dirty: boolean;
  onSave: () => void;
}

export const McpCard = ({ value, onChange, dirty, onSave }: McpCardProps) => {
  const { confirm } = useDialog();

  // 同步派生：边输边校验、避免 effect roundtrip 也避免每 keypress 多 1 帧延迟
  const mcpError = useMemo(() => validateMcpJson(value), [value]);

  // 是否「空」状态、决定「填入示例」点击时要不要 confirm
  const isEmpty = !value.trim() || value.trim() === DEFAULT_MCP_JSON.trim();

  const fillExample = async () => {
    if (!isEmpty) {
      const ok = await confirm({
        title: "覆盖当前 MCP 配置？",
        description: "当前编辑器已有内容、点确认会用示例 JSON 替换。",
        confirmLabel: "覆盖",
        destructive: true,
      });
      if (!ok) return;
    }
    onChange(MCP_EXAMPLE_JSON);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>
          与 Cursor IDE 的 ~/.cursor/mcp.json 同 schema、可直接从那边复制过来
        </CardDescription>
        <CardAction>
          <SaveButton
            dirty={dirty}
            disabled={!!mcpError}
            onSave={onSave}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="mcp-json" className="text-xs text-muted-foreground">
            JSON 配置（外层 mcpServers 包一层、对照示例）
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={fillExample}
          >
            <FileCode />
            填入示例
          </Button>
        </div>
        <CodeEditor
          id="mcp-json"
          value={value}
          onChange={onChange}
          language="json"
          placeholder={MCP_EXAMPLE_JSON}
          rows={14}
          ariaInvalid={!!mcpError}
        />
        {mcpError && <div className="text-destructive text-xs">{mcpError}</div>}
        <p className="text-xs text-muted-foreground">
          这些 MCP 会传给所有任务的 SDK agent、可调用 read/write 之外的外部服务。stdio 和 http/sse 两种 transport 都支持。
        </p>
      </CardContent>
    </Card>
  );
};
