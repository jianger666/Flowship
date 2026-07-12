"use client";

/**
 * Rules 卡片（v1.1.x Rules 独立化、能力页 Rules tab）
 *
 * 分层（用户拍板）：
 * - Cursor 全局 rules（~/.cursor/rules）= 个人偏好、只读展示 + 可导入
 * - app 自管 rules（data/rules/*.mdc）= 团队 / 项目级、可建可关可删
 *
 * 注入语义跟 Cursor rules 一致：frontmatter `alwaysApply: true` 全文进 prompt、
 * 其余列 index 让 agent 按需 read。开关（disabledRules）只作用于自管条目。
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/hooks/use-dialog";
import { getSettings, initSettings, saveSettings } from "@/lib/local-store";
import { cn } from "@/lib/utils";

// 跟 /api/rules 返回对齐
interface RuleRow {
  name: string;
  description: string;
  alwaysApply: boolean;
  enabled: boolean;
  absPath: string;
}

interface CursorRule {
  name: string;
  description: string;
  alwaysApply: boolean;
}

// 新增 rule 预填模板（跟 Cursor .mdc 规范一致）
const NEW_RULE_TEMPLATE = `---
description: 一句话说清这条规则管什么（alwaysApply 为 false 时 agent 靠它决定要不要读）
alwaysApply: true
---

这里写规则正文（agent 每次运行都会遵守）。
`;

export const RulesCard = () => {
  const { confirm } = useDialog();
  // 自管 rules（null = 还没加载完）
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  // Cursor 全局可导入清单
  const [cursorGlobal, setCursorGlobal] = useState<CursorRule[]>([]);
  // 编辑 dialog：null 关；name 空串 = 新增
  const [editing, setEditing] = useState<{ name: string; content: string } | null>(
    null,
  );
  // 导入 dialog 开关
  const [importOpen, setImportOpen] = useState(false);
  // 请求飞行中（防双击）
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/rules", { cache: "no-store" });
      const data = (await res.json()) as {
        rules?: RuleRow[];
        cursorGlobal?: CursorRule[];
      };
      setRules(data.rules ?? []);
      setCursorGlobal(data.cursorGlobal ?? []);
    } catch (err) {
      toast.error(
        `读取 rules 失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setRules([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openEdit = async (name: string) => {
    try {
      const res = await fetch(
        `/api/rules/content?name=${encodeURIComponent(name)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "读取失败");
        return;
      }
      setEditing({ name, content: data.content ?? "" });
    } catch (err) {
      toast.error(
        `读取失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: `删除规则「${name}」？`,
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/rules?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? "删除失败");
        return;
      }
      toast.success(`已删除「${name}」`);
      void refresh();
    } catch (err) {
      toast.error(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // 开关：本地即时切 + settings.disabledRules 落盘（注入时过滤）
  const handleToggle = async (name: string, enabled: boolean) => {
    setRules((prev) =>
      prev ? prev.map((r) => (r.name === name ? { ...r, enabled } : r)) : prev,
    );
    await initSettings();
    const s = getSettings();
    const cur = new Set(s.disabledRules ?? []);
    if (enabled) cur.delete(name);
    else cur.add(name);
    const ok = await saveSettings({ ...s, disabledRules: [...cur] });
    if (!ok) toast.error("开关保存失败、请重试");
  };

  const handleImport = async (names: string[]) => {
    setBusy(true);
    try {
      const res = await fetch("/api/rules/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const data = (await res.json()) as {
        imported?: string[];
        failed?: Array<{ name: string; error: string }>;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "导入失败");
        return;
      }
      if ((data.imported?.length ?? 0) > 0) {
        toast.success(`已导入 ${data.imported!.length} 条规则`);
      }
      for (const f of data.failed ?? []) {
        toast.error(`「${f.name}」导入失败：${f.error}`);
      }
      setImportOpen(false);
      void refresh();
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>
          注入给 agent 的团队 / 项目级规则（.mdc）；Cursor 全局规则照常生效、这里管本 app 自己的
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing({ name: "", content: NEW_RULE_TEMPLATE })}
            disabled={busy}
          >
            <Plus />
            新增
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            disabled={busy || cursorGlobal.length === 0}
            title={
              cursorGlobal.length === 0
                ? "~/.cursor/rules 下没有可导入的规则"
                : "从 Cursor 全局规则拷贝为本应用独立副本"
            }
          >
            <Download />
            从 Cursor 导入
          </Button>
        </div>

        {rules === null ? (
          <LoadingState variant="inline" />
        ) : rules.length === 0 ? (
          <EmptyHint>还没有自管规则——从 Cursor 导入或手动新增</EmptyHint>
        ) : (
          <div className="divide-y divide-border/60 rounded-md border border-border/60">
            {rules.map((r) => (
              <div key={r.name} className="flex items-center gap-2 px-3 py-2">
                <div className={cn("min-w-0 flex-1", !r.enabled && "opacity-50")}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm" title={r.absPath}>
                      {r.name}
                    </span>
                    {r.alwaysApply && (
                      <Badge variant="secondary" className="text-[10px]">
                        总是注入
                      </Badge>
                    )}
                  </div>
                  <div
                    className="truncate text-[11px] text-muted-foreground"
                    title={r.description}
                  >
                    {r.description || "（无描述）"}
                  </div>
                </div>
                <Switch
                  checked={r.enabled}
                  onCheckedChange={(v) => void handleToggle(r.name, v)}
                  aria-label={`${r.enabled ? "禁用" : "启用"} ${r.name}`}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`编辑 ${r.name}`}
                  title="编辑 .mdc"
                  onClick={() => void openEdit(r.name)}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`删除 ${r.name}`}
                  title="删除"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void handleDelete(r.name)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {editing && (
        <RuleEditDialog
          initialName={editing.name}
          initialContent={editing.content}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (name, content) => {
            setBusy(true);
            try {
              const res = await fetch("/api/rules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, content }),
              });
              if (!res.ok) {
                const data = (await res.json().catch(() => null)) as {
                  error?: string;
                } | null;
                toast.error(data?.error ?? "保存失败");
                return;
              }
              toast.success(`已保存「${name}」`);
              setEditing(null);
              void refresh();
            } catch (err) {
              toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      <ImportRulesDialog
        open={importOpen}
        busy={busy}
        cursorGlobal={cursorGlobal}
        appNames={new Set((rules ?? []).map((r) => r.name))}
        onClose={() => setImportOpen(false)}
        onImport={(names) => void handleImport(names)}
      />
    </Card>
  );
};

// ----------------- 新增 / 编辑 dialog -----------------

const RuleEditDialog = ({
  initialName,
  initialContent,
  busy,
  onClose,
  onSave,
}: {
  initialName: string;
  initialContent: string;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, content: string) => void | Promise<void>;
}) => {
  // 文件名草稿（编辑已有时锁定、防改名产生孤儿文件）
  const [name, setName] = useState(initialName);
  // .mdc 内容草稿
  const [content, setContent] = useState(initialContent);
  const isNew = initialName === "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "新增规则" : `编辑 ${initialName}`}</DialogTitle>
        </DialogHeader>
        {isNew && (
          <div className="grid gap-1.5">
            <Label htmlFor="rule-edit-name">名称（文件名）</Label>
            <Input
              id="rule-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 team-code-style"
            />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="rule-edit-content">.mdc 内容</Label>
          <CodeEditor
            id="rule-edit-content"
            value={content}
            onChange={setContent}
            language="markdown"
            rows={14}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void onSave(name.trim(), content)}
            disabled={busy || !name.trim() || !content.trim()}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ----------------- 从 Cursor 导入 dialog -----------------

const ImportRulesDialog = ({
  open,
  busy,
  cursorGlobal,
  appNames,
  onClose,
  onImport,
}: {
  open: boolean;
  busy: boolean;
  cursorGlobal: CursorRule[];
  appNames: Set<string>;
  onClose: () => void;
  onImport: (names: string[]) => void;
}) => {
  // 勾选集合；关闭清空、重开不残留
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setPicked(new Set());
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Cursor 导入规则</DialogTitle>
          <p className="text-xs text-muted-foreground">
            拷贝为本应用独立副本、之后在 Cursor 改不影响这里
          </p>
        </DialogHeader>
        {cursorGlobal.length === 0 ? (
          <EmptyHint>~/.cursor/rules 下没有规则</EmptyHint>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {cursorGlobal.map((r) => {
              const exists = appNames.has(r.name);
              return (
                <label
                  key={r.name}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={picked.has(r.name)}
                    onCheckedChange={(v) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(r.name);
                        else next.delete(r.name);
                        return next;
                      })
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm">
                      <span className="truncate">{r.name}</span>
                      {exists && (
                        <Badge variant="secondary" className="text-[10px]">
                          已有同名、导入将覆盖
                        </Badge>
                      )}
                    </span>
                    <span
                      className="block truncate text-[11px] text-muted-foreground"
                      title={r.description}
                    >
                      {r.description || "（无描述）"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => onImport([...picked])}
            disabled={busy || picked.size === 0}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            导入所选（{picked.size}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
