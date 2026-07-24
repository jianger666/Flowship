"use client";

/**
 * MCP servers 卡片（V0.13 独立化重做）
 *
 * fe 自管 MCP 是唯一运行时来源（不再 live 合并 Cursor）：
 * - 条目化管理：每个 server 一行、**常用开关 + 健康徽标 + OAuth 都并在行内**
 *  （用户拍板「常用 MCP 整合到配置上、不然太长」——不再单独两个区块）
 * - 新增 / 编辑走 dialog；从 Cursor 导入 dialog 勾选挑 server（一次性拷贝、之后互不影响）
 * - 高级：整体 JSON 编辑（折叠、批量粘贴场景用）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import type { McpServerConfig } from "@cursor/sdk";

import type { McpHealth } from "@/lib/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/checkbox-row";
import { CodeEditor } from "@/components/ui/code-editor";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBadge } from "@/components/tasks/mcp-toggle-list";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/hooks/use-dialog";
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useMcpHealth } from "@/hooks/use-mcp-health";
import { useMcpOAuth } from "@/hooks/use-mcp-oauth";
import { RESERVED_MCP_NAMES } from "@/lib/mcp-config";
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
  const { confirm } = useDialog();
  const { statuses, busy, authorize, revoke } = useMcpOAuth();

  const names = useMemo(() => Object.keys(appServers), [appServers]);
  const enabledServers = useMemo(
    () => names.filter((n) => !disabledServers.includes(n)),
    [names, disabledServers],
  );

  const {
    health,
    loadingServers,
    refresh: recheckHealth,
    probeOne,
  } = useMcpHealth(enabledServers, true);

  // 编辑 dialog：null = 关；{ name: "" } = 新增
  const [editing, setEditing] = useState<{ name: string } | null>(null);
  // 导入 dialog 开关
  const [importOpen, setImportOpen] = useState(false);
  // 高级 JSON 折叠
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 失败日志弹窗：当前查看的失败 server 的 health（null = 不开）
  const [logHealth, setLogHealth] = useState<McpHealth | null>(null);

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: `删除 MCP「${name}」？`,
      description: "已建任务的开关记录不受影响、可重新导入或新增找回",
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    const next = { ...appServers };
    delete next[name];
    onAppServersCommit(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <CardDescription>本应用独立配置、传给 agent；可从 Cursor 导入</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
          >
            <Download />
            从 Cursor 导入
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing({ name: "" })}
          >
            <Plus />
            新增
          </Button>
          {names.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={recheckHealth}
              disabled={loadingServers.size > 0}
            >
              <RefreshCw
                className={cn(loadingServers.size > 0 && "animate-spin")}
              />
              重新检测
            </Button>
          )}
        </div>

        {/* 条目列表：常用开关 + 健康徽标 + OAuth 全并在行内（不再单独区块、页面不拉长） */}
        {names.length === 0 ? (
          <EmptyHint>还没配 MCP server——从 Cursor 导入或手动新增</EmptyHint>
        ) : (
          <div className="divide-y divide-border/60 rounded-md border border-border/60">
            {names.map((name) => {
              const isDisabled = disabledServers.includes(name);
              const oauth = statuses[name];
              return (
                <div key={name} className="flex items-center gap-2 px-3 py-2">
                  {/* 只留名称（用户拍板：指令摘要太长、想看细节点编辑看 JSON） */}
                  <div
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      isDisabled && "text-muted-foreground/60 line-through",
                    )}
                    title={name}
                  >
                    {name}
                  </div>
                  {!isDisabled && (
                    <HealthBadge
                      h={health[name]}
                      loading={loadingServers.has(name)}
                      onShowLog={() => {
                        const h = health[name];
                        if (h) setLogHealth(h);
                      }}
                    />
                  )}
                  {/* OAuth：需要授权的 server 行内给动作（已授权 hover 换「重新授权 / 撤销」入口在编辑侧边） */}
                  {oauth &&
                    (oauth.authorized ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground"
                        onClick={() => revoke(name)}
                        disabled={busy === name}
                        title="已授权、点击撤销"
                      >
                        <ShieldCheck className="text-emerald-500" />
                        已授权
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => authorize(name)}
                        disabled={busy === name}
                      >
                        授权
                      </Button>
                    ))}
                  {/* 行操作：常驻文字按钮（与能力页 Skill/Action 统一） */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={() => setEditing({ name })}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDelete(name)}
                  >
                    删除
                  </Button>
                  {/* 常用开关：关 = 进新任务默认黑名单（跟原「常用 MCP」区同语义） */}
                  <Switch
                    checked={!isDisabled}
                    onCheckedChange={(checked) => {
                      onChange(
                        checked
                          ? disabledServers.filter((s) => s !== name)
                          : [...new Set([...disabledServers, name])],
                      );
                      if (checked) probeOne(name);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* 高级：整体 JSON 编辑（批量粘贴 / 精调） */}
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            高级：整体 JSON 编辑
          </button>
          {advancedOpen && (
            <div className="mt-1.5">
              <BulkJsonEditor
                appServers={appServers}
                onChange={onAppServersChange}
                onCommit={onAppServersCommit}
              />
            </div>
          )}
        </div>

      </CardContent>

      {/* 健康探测失败日志弹窗（点行内失败徽标弹出） */}
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
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {logHealth?.detail ?? "（无详情、可能是未知错误）"}
          </pre>
        </DialogContent>
      </Dialog>

      {editing !== null && (
        <ServerEditDialog
          existingName={editing.name || null}
          appServers={appServers}
          onClose={() => setEditing(null)}
          onSave={(name, cfg, oldName) => {
            const next = { ...appServers };
            if (oldName && oldName !== name) delete next[oldName];
            next[name] = cfg;
            onAppServersCommit(next);
            setEditing(null);
            // 新增 / 改配置的 server 立即探连通性（首探只探挂载时那批、不会自动带上新条目）
            if (!disabledServers.includes(name)) probeOne(name);
          }}
        />
      )}

      <ImportCursorDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        appServers={appServers}
        onImport={(picked) => {
          const next = { ...appServers, ...picked };
          onAppServersCommit(next);
          setImportOpen(false);
          toast.success(`已导入 ${Object.keys(picked).length} 个 server`);
          // 导入的 server 立即探连通性（同上、首探不会自动带上新条目）
          for (const name of Object.keys(picked)) {
            if (!disabledServers.includes(name)) probeOne(name);
          }
        }}
      />
    </Card>
  );
};

// ----------------- 高级：整体 JSON 编辑 -----------------

const BulkJsonEditor = ({
  appServers,
  onChange,
  onCommit,
}: {
  appServers: Record<string, McpServerConfig>;
  onChange: (next: Record<string, McpServerConfig>) => void;
  onCommit: (next: Record<string, McpServerConfig>) => void;
}) => {
  // JSON 草稿（编辑中途可暂时非法、合法时才回写）
  const [draft, setDraft] = useState(
    JSON.stringify({ mcpServers: appServers }, null, 2),
  );
  // 自己最后一次成功 commit 的序列化值：外部 appServers 变化回流时据此区分
  // 「自己打字引起的回声」（不重置 draft、免得正在编辑被顶掉）和「条目操作 / 导入
  // 等外部变更」（重置、保持同步——否则展开着的旧 JSON 一 commit 会把删掉的写回来）
  const lastEmittedRef = useRef(JSON.stringify(appServers));
  useEffect(() => {
    const incoming = JSON.stringify(appServers);
    if (incoming === lastEmittedRef.current) return;
    lastEmittedRef.current = incoming;
    setDraft(JSON.stringify({ mcpServers: appServers }, null, 2));
  }, [appServers]);

  return (
    <CodeEditor
      id="app-mcp-json"
      value={draft}
      onChange={(raw) => {
        setDraft(raw);
        try {
          const parsed = JSON.parse(raw) as {
            mcpServers?: Record<string, McpServerConfig>;
          };
          if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
            lastEmittedRef.current = JSON.stringify(parsed.mcpServers);
            onChange(parsed.mcpServers);
            onCommit(parsed.mcpServers);
          }
        } catch {
          // 编辑中途 JSON 可能暂时非法
        }
      }}
      language="json"
      rows={10}
    />
  );
};

// ----------------- 新增 / 编辑单个 server -----------------

const ServerEditDialog = ({
  existingName,
  appServers,
  onClose,
  onSave,
}: {
  /** null = 新增；非 null = 编辑该名条目 */
  existingName: string | null;
  appServers: Record<string, McpServerConfig>;
  onClose: () => void;
  onSave: (name: string, cfg: McpServerConfig, oldName: string | null) => void;
}) => {
  // 名称草稿（编辑时可改名 = 删旧键写新键）
  const [name, setName] = useState(existingName ?? "");
  // 单 server 配置 JSON 草稿
  const [configDraft, setConfigDraft] = useState(
    JSON.stringify(
      existingName
        ? appServers[existingName]
        : { type: "http", url: "" },
      null,
      2,
    ),
  );

  const handleSave = () => {
    const key = name.trim();
    if (!key) {
      toast.error("名称不能为空");
      return;
    }
    if (RESERVED_MCP_NAMES.has(key)) {
      toast.error(`「${key}」是内置保留名、换一个`);
      return;
    }
    if (key !== existingName && appServers[key]) {
      toast.error(`「${key}」已存在`);
      return;
    }
    let cfg: McpServerConfig;
    try {
      cfg = JSON.parse(configDraft) as McpServerConfig;
    } catch {
      toast.error("配置不是合法 JSON");
      return;
    }
    onSave(key, cfg, existingName);
  };

  return (
    // disablePointerDismissal：带表单草稿、点外误关丢草稿（ui-conventions 约定）
    <Dialog open onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existingName ? `编辑 ${existingName}` : "新增 MCP server"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-edit-name">名称</Label>
          <Input
            id="mcp-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 github"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-edit-config">配置（单个 server 的 JSON）</Label>
          <CodeEditor
            id="mcp-edit-config"
            value={configDraft}
            onChange={setConfigDraft}
            language="json"
            rows={8}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ----------------- 从 Cursor 导入 -----------------
// 候选行用 CheckboxRow（整行可点）—— base-ui Checkbox 非原生 input，
// 不能靠 `<label>` 联动，见 checkbox-row.tsx 顶部注释。

const ImportCursorDialog = ({
  open,
  onClose,
  appServers,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  appServers: Record<string, McpServerConfig>;
  onImport: (picked: Record<string, McpServerConfig>) => void;
}) => {
  // 只在 dialog 打开时才读 Cursor mcp.json
  const { cursorServers, dirs, loading, error, refresh } = useCursorMcp(open);
  // 勾选集合（默认全不勾、用户自己挑）；关闭时清空、重开不残留上次勾选
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setPicked(new Set());
  }, [open]);

  const cursorNames = Object.keys(cursorServers);
  const sourceFile = dirs[0] ? `${dirs[0]}/mcp.json` : "~/.cursor/mcp.json";

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const handleImport = () => {
    const out: Record<string, McpServerConfig> = {};
    for (const name of picked) {
      if (cursorServers[name] && !RESERVED_MCP_NAMES.has(name)) {
        out[name] = cursorServers[name];
      }
    }
    if (Object.keys(out).length === 0) {
      toast.error("先勾选要导入的 server");
      return;
    }
    setPicked(new Set());
    onImport(out);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Cursor 导入 MCP</DialogTitle>
          <p className="text-xs text-muted-foreground">
            拷贝为本应用独立配置、之后在 Cursor 改不会影响这里
            <code className="ml-1 text-[11px]">{sourceFile}</code>
          </p>
        </DialogHeader>
        {loading ? (
          <div className="py-4 text-center text-sm text-muted-foreground">读取中…</div>
        ) : error ? (
          <div className="py-2 text-sm text-destructive">读取失败：{error}</div>
        ) : cursorNames.length === 0 ? (
          <EmptyHint size="sm">Cursor 里没配 MCP</EmptyHint>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {cursorNames.map((name) => (
              <CheckboxRow
                key={name}
                checked={picked.has(name)}
                className="rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
                onCheckedChange={() => toggle(name)}
              >
                <span className="min-w-0 flex-1 truncate text-sm" title={name}>
                  {name}
                </span>
                {appServers[name] && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    已存在、导入将覆盖
                  </Badge>
                )}
              </CheckboxRow>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw />
            重新读取
          </Button>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleImport} disabled={picked.size === 0}>
            导入{picked.size > 0 ? `（${picked.size}）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
