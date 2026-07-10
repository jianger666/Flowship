"use client";

/**
 * Skills 卡片（V0.13-P1 独立化）
 *
 * 列出 agent 可用的全部 skill（带来源标签）：
 * - 内置（平台随包发布）/ 飞书 CLI 官方 / Cursor 全局（~/.cursor/skills、跟 IDE 共用）→ 只读
 * - 自管（data/skills、本 app 独立）→ 可新增 / 编辑 / 删除（就是编辑 SKILL.md）
 * - 「从 Cursor 导入」勾选式 dialog（整目录拷贝、含脚本附属文件）——对齐 MCP 卡交互
 *
 * 同名覆盖优先级（loadSkills 决定）：内置 > 自管 > Cursor 全局 > 飞书 CLI。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useDialog } from "@/hooks/use-dialog";
import { getSettings } from "@/lib/local-store";
import { setPendingSlashSkill } from "@/components/slash-skills";
import { createTask } from "@/lib/task-store";

// 跟 /api/skills 返回对齐的条目形态
interface SkillRow {
  name: string;
  description: string;
  source: "builtin" | "app" | "cursor" | "feishu-cli";
  editable: boolean;
  absPath: string;
}

interface CursorGlobalSkill {
  dirName: string;
  name: string;
  description: string;
}

const SOURCE_LABEL: Record<SkillRow["source"], string> = {
  builtin: "内置",
  app: "自管",
  cursor: "Cursor 全局",
  "feishu-cli": "飞书 CLI",
};

// 新增 skill 时预填的 frontmatter 模板（用户改 description 和正文即可）
const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: 一句话说清这个 skill 什么场景用（agent 靠它决定要不要读全文）
---

# 我的 skill

这里写给 agent 看的完整指引。
`;

export const SkillsCard = () => {
  const { confirm } = useDialog();
  const router = useRouter();
  // 全部来源的 skill 列表（null = 还没加载完）
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  // Cursor 全局可导入清单
  const [cursorGlobal, setCursorGlobal] = useState<CursorGlobalSkill[]>([]);
  // 自管 skills 目录绝对路径（「对话创建」开对话当 cwd 用、server 返回）
  const [appSkillsDir, setAppSkillsDir] = useState("");
  // 编辑 dialog：null 关；name 空串 = 新增
  const [editing, setEditing] = useState<{
    name: string;
    content: string;
  } | null>(null);
  // 导入 dialog 开关
  const [importOpen, setImportOpen] = useState(false);
  // 请求飞行中（防双击）
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/skills", { cache: "no-store" });
      const data = (await res.json()) as {
        skills?: SkillRow[];
        cursorGlobal?: CursorGlobalSkill[];
        appSkillsDir?: string;
      };
      setSkills(data.skills ?? []);
      setCursorGlobal(data.cursorGlobal ?? []);
      setAppSkillsDir(data.appSkillsDir ?? "");
    } catch (err) {
      toast.error(
        `读取 skills 失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setSkills([]);
    }
  }, []);

  // 「对话创建」（v1.0 直跳版、用户拍板「不用弹窗输入那么麻烦」）：
  // 点按钮直接开一个工作目录锁在 data/skills 的对话、输入框自动挂上
  // skill-creator 的 / chip（setPendingSlashSkill handoff）、用户到对话里说需求即可
  const handleAiCreate = async () => {
    const s = getSettings();
    if (!s.apiKey?.trim() || !s.defaultModel?.id?.trim()) {
      toast.error("先在设置页配好 API Key 和默认模型");
      return;
    }
    if (!appSkillsDir) {
      toast.error("skills 目录还没就绪、点「刷新」后重试");
      return;
    }
    setBusy(true);
    try {
      const task = await createTask({
        mode: "chat",
        title: "创建 skill",
        repoPaths: [appSkillsDir],
        model: s.defaultModel,
        disabledMcpServers:
          s.disabledMcpServers && s.disabledMcpServers.length > 0
            ? s.disabledMcpServers
            : undefined,
      });
      setPendingSlashSkill("skill-creator");
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      toast.error(
        `发起失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openEdit = async (name: string) => {
    try {
      const res = await fetch(
        `/api/skills/content?name=${encodeURIComponent(name)}`,
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
      title: `删除 skill「${name}」？`,
      description: "整个 skill 目录（含附属脚本）会被删除",
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/skills?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
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

  const handleImport = async (dirNames: string[]) => {
    setBusy(true);
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: dirNames }),
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
        toast.success(`已导入 ${data.imported!.length} 个 skill`);
      }
      for (const f of data.failed ?? []) {
        toast.error(`「${f.name}」导入失败：${f.error}`);
      }
      setImportOpen(false);
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>
          agent 按场景自动取用的能力扩展（SKILL.md）；自管的可编辑、其余只读
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleAiCreate()}
            disabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            对话创建
          </Button>
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
            onClick={() => setEditing({ name: "", content: NEW_SKILL_TEMPLATE })}
          >
            <Plus />
            手写
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void refresh()}
          >
            <RefreshCw />
            刷新
          </Button>
        </div>

        {skills === null ? (
          <LoadingState variant="inline" />
        ) : skills.length === 0 ? (
          <EmptyHint>还没有任何 skill——从 Cursor 导入或手动新增</EmptyHint>
        ) : (
          // 按来源分组（用户拍板「几十上百个太长」）：自管常驻展开（用户自己管的）、
          // 其余来源各一个折叠组、标题带数量、默认收起
          <SkillGroups
            skills={skills}
            onEdit={(name) => void openEdit(name)}
            onDelete={(name) => void handleDelete(name)}
          />
        )}
      </CardContent>

      {editing !== null && (
        <SkillEditDialog
          initialName={editing.name}
          initialContent={editing.content}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (name, content) => {
            setBusy(true);
            try {
              const res = await fetch("/api/skills", {
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
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      <ImportSkillsDialog
        open={importOpen}
        busy={busy}
        cursorGlobal={cursorGlobal}
        appNames={
          new Set((skills ?? []).filter((s) => s.source === "app").map((s) => s.name))
        }
        onClose={() => setImportOpen(false)}
        onImport={(names) => void handleImport(names)}
      />
    </Card>
  );
};

// ----------------- 分组列表（自管展开、其余折叠） -----------------

// 分组展示顺序：自管在前（可编辑、用户最关心）、然后内置 / Cursor / 飞书 CLI
const GROUP_ORDER: SkillRow["source"][] = ["app", "builtin", "cursor", "feishu-cli"];

const SkillGroups = ({
  skills,
  onEdit,
  onDelete,
}: {
  skills: SkillRow[];
  onEdit: (name: string) => void;
  onDelete: (name: string) => void;
}) => {
  // 各折叠组的展开态（自管组不折叠、不进这个 state）
  const [openGroups, setOpenGroups] = useState<Set<SkillRow["source"]>>(
    new Set(),
  );

  const row = (s: SkillRow) => (
    <div
      key={`${s.source}:${s.name}`}
      className="flex items-center gap-2 px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={s.absPath}>
          {s.name}
        </div>
        <div
          className="truncate text-[11px] text-muted-foreground"
          title={s.description}
        >
          {s.description}
        </div>
      </div>
      {s.editable && (
        <>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`编辑 ${s.name}`}
            title="编辑 SKILL.md"
            onClick={() => onEdit(s.name)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`删除 ${s.name}`}
            title="删除"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(s.name)}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      {GROUP_ORDER.map((source) => {
        const group = skills.filter((s) => s.source === source);
        if (group.length === 0) return null;
        // 自管组：常驻展开、无折叠头
        if (source === "app") {
          return (
            <div key={source}>
              <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="default" className="text-[10px]">
                  {SOURCE_LABEL[source]}
                </Badge>
                {group.length} 个
              </div>
              <div className="divide-y divide-border/60 rounded-md border border-border/60">
                {group.map(row)}
              </div>
            </div>
          );
        }
        const opened = openGroups.has(source);
        return (
          <div key={source}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() =>
                setOpenGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(source)) next.delete(source);
                  else next.add(source);
                  return next;
                })
              }
            >
              {opened ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              <Badge variant="secondary" className="text-[10px]">
                {SOURCE_LABEL[source]}
              </Badge>
              {group.length} 个（只读）
            </button>
            {opened && (
              <div className="mt-1 divide-y divide-border/60 rounded-md border border-border/60">
                {group.map(row)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ----------------- 新增 / 编辑 dialog -----------------

const SkillEditDialog = ({
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
  onSave: (name: string, content: string) => void;
}) => {
  // 目录名草稿（编辑已有 skill 时锁定不可改、避免「改名」产生孤儿目录）
  const [name, setName] = useState(initialName);
  // SKILL.md 内容草稿
  const [content, setContent] = useState(initialContent);
  const isNew = initialName === "";

  return (
    // disablePointerDismissal：带表单草稿、点外误关丢草稿（ui-conventions 约定）
    <Dialog open onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "新增 skill" : `编辑 ${initialName}`}</DialogTitle>
        </DialogHeader>
        {isNew && (
          <div className="grid gap-1.5">
            <Label htmlFor="skill-edit-name">名称（目录名、字母数字 - _）</Label>
            <Input
              id="skill-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 my-team-review"
            />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="skill-edit-content">SKILL.md</Label>
          <CodeEditor
            id="skill-edit-content"
            value={content}
            onChange={setContent}
            language="markdown"
            rows={16}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => onSave(name.trim(), content)}
            disabled={busy || !name.trim() || !content.trim()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ----------------- 从 Cursor 导入 dialog -----------------

const ImportSkillsDialog = ({
  open,
  busy,
  cursorGlobal,
  appNames,
  onClose,
  onImport,
}: {
  open: boolean;
  busy: boolean;
  cursorGlobal: CursorGlobalSkill[];
  /** 已存在的自管 skill 名（标「导入将覆盖」） */
  appNames: Set<string>;
  onClose: () => void;
  onImport: (dirNames: string[]) => void;
}) => {
  // 勾选集合；关闭清空、重开不残留
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setPicked(new Set());
  }, [open]);

  const toggle = (dirName: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) next.delete(dirName);
      else next.add(dirName);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Cursor 导入 skill</DialogTitle>
          <p className="text-xs text-muted-foreground">
            整目录拷贝（含脚本）为本应用独立副本、之后在 Cursor 改不影响这里
          </p>
        </DialogHeader>
        {cursorGlobal.length === 0 ? (
          <EmptyHint size="sm">~/.cursor/skills 下没有 skill</EmptyHint>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {cursorGlobal.map((s) => (
              <label
                key={s.dirName}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
              >
                <Checkbox
                  checked={picked.has(s.dirName)}
                  onCheckedChange={() => toggle(s.dirName)}
                />
                <span className="min-w-0 flex-1 truncate text-sm" title={s.description}>
                  {s.dirName}
                </span>
                {appNames.has(s.name) && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    已存在、导入将覆盖
                  </Badge>
                )}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => onImport([...picked])}
            disabled={busy || picked.size === 0}
          >
            导入{picked.size > 0 ? `（${picked.size}）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
