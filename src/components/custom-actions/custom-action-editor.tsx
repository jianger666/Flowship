"use client";

/**
 * 自定义 action 编辑器（新建 / 编辑共用 Dialog）
 *
 * 瘦身后 = skill 挂载壳：动作名 + 主 skill 下拉 + 产出要求 + placeholder。
 * 内容创作走 Skill tab；这里只把已有 skill 挂到推进面板上跑。
 */

import { useEffect, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createCustomActionReq,
  fetchSkills,
  updateCustomActionReq,
  type SkillOption,
} from "@/lib/custom-action-client";
import type { CustomActionDef, CustomActionInput } from "@/lib/types";
import { cn } from "@/lib/utils";

// 主 skill 下拉选项：正常 skill + 「已选但本机没有」的合成灰项（编辑旧定义时可能出现）
type EditorSkillOption = SkillOption & { missing?: boolean };

const emptyDraft = (): CustomActionInput => ({
  label: "",
  summary: "",
  skill: "",
  output: "",
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
  // 可勾选的 skill 列表（打开时拉一次、只含 enabled）
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
            skill: editing.skill,
            output: editing.output ?? "",
            placeholder: editing.placeholder ?? "",
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

  // 主 skill 下拉：已选但不在 enabled 列表里的（被关 / 删了）合成一项、避免 Select 空白
  const mainSkillOptions = useMemo<EditorSkillOption[]>(() => {
    const known = new Set(skillOptions.map((s) => s.name));
    if (draft.skill && !known.has(draft.skill)) {
      return [
        {
          name: draft.skill,
          description: "本机未找到或已停用",
          missing: true,
        },
        ...skillOptions,
      ];
    }
    return skillOptions;
  }, [skillOptions, draft.skill]);

  const handleSave = async () => {
    if (!draft.label.trim()) {
      toast.error("请填动作名");
      return;
    }
    if (!draft.skill.trim()) {
      toast.error("请选主 skill");
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "编辑自定义 Action" : "新建自定义 Action"}
          </DialogTitle>
          <DialogDescription>
            把某个 skill 挂到任务推进链上跑
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
            <Label>主 skill</Label>
            {/* 用户纠偏：skill = 纯方法论可拆卸；产出要求属壳参数 */}
            <p className="text-xs text-muted-foreground">
              做什么写在 skill 里；这次要产出什么写在下面（可选）
            </p>
            <Select
              value={draft.skill || undefined}
              onValueChange={(v) => {
                if (v == null) return;
                patch({ skill: v });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选一个 skill 作为执行内容">
                  {draft.skill
                    ? mainSkillOptions.find((s) => s.name === draft.skill)
                        ?.name ?? draft.skill
                    : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {mainSkillOptions.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                      <span
                        className={cn(
                          "font-medium",
                          s.missing && "text-muted-foreground line-through",
                        )}
                      >
                        {s.name}
                      </span>
                      {s.description ? (
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {s.description}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ca-output">产出要求（可选）</Label>
            <Textarea
              id="ca-output"
              value={draft.output ?? ""}
              onChange={(e) => patch({ output: e.target.value })}
              placeholder="如：输出回滚记录——回到哪个版本、动了哪些分支、验证结果"
              rows={3}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ca-placeholder">推进输入框提示（可选）</Label>
            <Input
              id="ca-placeholder"
              value={draft.placeholder ?? ""}
              onChange={(e) => patch({ placeholder: e.target.value })}
              placeholder="推进选中这个 action 时、告诉使用者该填什么"
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
