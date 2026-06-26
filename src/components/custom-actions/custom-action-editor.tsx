"use client";

/**
 * 自定义 action 编辑器（V0.9、新建 / 编辑共用一个 Dialog）
 *
 * 字段：动作名 + 一句话简介 + playbook（大文本、带 3 段推荐模板）+ skill 多选 + 可选 check 命令。
 * 协议层（产出 artifact / HITL / wait_for_user / 再聊聊）由 runner 自动包、用户不用在 playbook 里写。
 *
 * 复用：MultiSelect（skill 勾选）、RepoCheckCommands（check 命令编辑、纯受控）。
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MultiSelect } from "@/components/ui/multi-select";
import { RepoCheckCommands } from "@/components/settings/repo-check-commands";
import {
  createCustomActionReq,
  fetchSkills,
  updateCustomActionReq,
  type SkillOption,
} from "@/lib/custom-action-client";
import type { CustomActionDef, CustomActionInput } from "@/lib/types";

// 新建时预填的 playbook 模板（3 段、改改就能用）
const PLAYBOOK_TEMPLATE = `## 目标
（这个 action 让 agent 干什么、一两句说清）

## 怎么做
（agent 按这些步骤干活）
1.
2.

## 产出什么
（产出的报告 / artifact 长什么样；留空则让 agent 自己组织一份 markdown 报告）
`;

const emptyDraft = (): CustomActionInput => ({
  label: "",
  summary: "",
  playbook: PLAYBOOK_TEMPLATE,
  skills: [],
  checkCommands: [],
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 编辑现有 = 传 def；新建 = null
  editing: CustomActionDef | null;
  // 保存成功回调（列表页据此刷新）
  onSaved: (def: CustomActionDef) => void;
}

export const CustomActionEditor = ({
  open,
  onOpenChange,
  editing,
  onSaved,
}: Props) => {
  // 表单草稿（单对象 state、合并多个相关字段）
  const [draft, setDraft] = useState<CustomActionInput>(emptyDraft);
  // 可勾选的 skill 列表（打开时拉一次）
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  // 保存中（防双击）
  const [saving, setSaving] = useState(false);

  // 打开 / 切换编辑对象时重置草稿
  useEffect(() => {
    if (!open) return;
    setDraft(
      editing
        ? {
            label: editing.label,
            summary: editing.summary ?? "",
            playbook: editing.playbook,
            skills: editing.skills ?? [],
            checkCommands: editing.checkCommands ?? [],
            freshAgent: editing.freshAgent,
          }
        : emptyDraft(),
    );
  }, [open, editing]);

  // 打开时拉一次可用 skill（失败 toast、不阻塞编辑）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchSkills()
      .then((s) => {
        if (alive) setSkillOptions(s);
      })
      .catch((err) =>
        toast.error(
          `拉取 skill 失败：${err instanceof Error ? err.message : err}`,
        ),
      );
    return () => {
      alive = false;
    };
  }, [open]);

  const patch = (p: Partial<CustomActionInput>) =>
    setDraft((d) => ({ ...d, ...p }));

  const handleSave = async () => {
    if (!draft.label.trim()) {
      toast.error("请填动作名");
      return;
    }
    if (!draft.playbook.trim()) {
      toast.error("请填 playbook");
      return;
    }
    setSaving(true);
    try {
      const saved = editing
        ? await updateCustomActionReq(editing.id, draft)
        : await createCustomActionReq(draft);
      toast.success(editing ? "已保存" : "已创建");
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "编辑自定义 Action" : "新建自定义 Action"}
          </DialogTitle>
          <DialogDescription>
            把 playbook + skill + 可选 check 封装成一个能在任务里推进的 action
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[60vh] gap-4 overflow-y-auto px-0.5">
          <div className="grid gap-1.5">
            <Label htmlFor="ca-label">动作名</Label>
            <Input
              id="ca-label"
              value={draft.label}
              onChange={(e) => patch({ label: e.target.value })}
              placeholder="如：性能审计"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ca-summary">一句话简介（可选）</Label>
            <Input
              id="ca-summary"
              value={draft.summary ?? ""}
              onChange={(e) => patch({ summary: e.target.value })}
              placeholder="列表里显示、帮你认出这个 action"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ca-playbook">Playbook</Label>
            <Textarea
              id="ca-playbook"
              value={draft.playbook}
              onChange={(e) => patch({ playbook: e.target.value })}
              className="min-h-64 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              写「干什么 / 怎么做 / 产出什么」；产出 artifact、等你确认、再聊聊这套系统会自动包上、不用写
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label>带哪些 skill（可选）</Label>
            <MultiSelect
              options={skillOptions}
              value={draft.skills ?? []}
              onChange={(next) => patch({ skills: next })}
              getKey={(s) => s.name}
              placeholder="不选则不带 skill"
              renderOption={(s) => (
                <>
                  <span className="font-medium">{s.name}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {s.description}
                  </span>
                </>
              )}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>跑完校验命令（可选）</Label>
            <RepoCheckCommands
              commands={draft.checkCommands ?? []}
              onChange={(next) => patch({ checkCommands: next })}
              onCommit={(next) => patch({ checkCommands: next })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : editing ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
