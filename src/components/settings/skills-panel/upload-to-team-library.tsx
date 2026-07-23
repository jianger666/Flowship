"use client";

/**
 * 「上传我的 skill/action 到共享库」按钮 + dialog
 *
 * mode 区分两种入口；打开时按需拉数据；API 统一 POST /api/team-library/upload。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/use-settings";
import { fetchCustomActions } from "@/lib/custom-action-client";
import type { CustomActionDef } from "@/lib/types";

import {
  defaultUploadCategory,
  UploadSkillsDialog,
  type UploadActionRow,
  type UploadDialogMode,
} from "./upload-dialog";
import {
  isSharedTeamCategory,
  sharedCategoryOf,
  skillsForNav,
  type SkillRow,
} from "./types";

type Props = {
  mode: UploadDialogMode;
  /** 可选：上传成功后回调（如刷新列表） */
  onUploaded?: () => void;
};

const BUTTON_LABEL: Record<UploadDialogMode, string> = {
  skill: "上传我的 skill 到共享库",
  action: "上传我的 action 到共享库",
};

export const UploadToTeamLibraryButton = ({ mode, onUploaded }: Props) => {
  const { settings } = useSettings();
  // dialog 开关
  const [open, setOpen] = useState(false);
  // 上传请求中
  const [busy, setBusy] = useState(false);
  // skill 模式列表
  const [appSkills, setAppSkills] = useState<SkillRow[]>([]);
  // action 模式列表（含不可传置灰项）
  const [actions, setActions] = useState<UploadActionRow[]>([]);
  // 共享库 skills/ 名 → 分类列表（跨分类冲突 / 同分类覆盖）
  const [teamSkillCategories, setTeamSkillCategories] = useState<
    Record<string, string[]>
  >({});

  const loadDialogData = useCallback(async () => {
    try {
      const skillsRes = await fetch("/api/skills", { cache: "no-store" });
      if (!skillsRes.ok) {
        toast.error("读取 skills 失败");
        return;
      }
      const data = (await skillsRes.json()) as { skills?: SkillRow[] };
      const all = data.skills ?? [];
      // 仅组沉淀 shared:*；同名多分类全记（供跨分类冲突）
      const byName: Record<string, string[]> = {};
      for (const s of all) {
        if (s.source !== "team" || !isSharedTeamCategory(s.teamCategory)) {
          continue;
        }
        const cat = sharedCategoryOf(s);
        const cur = byName[s.name] ?? [];
        if (!cur.includes(cat)) cur.push(cat);
        byName[s.name] = cur;
      }
      setTeamSkillCategories(byName);

      if (mode === "skill") {
        setAppSkills(skillsForNav(all, "app"));
        setActions([]);
        return;
      }

      // action 模式：带壳的自管 skill（origin=app-skill）
      const actionsRes = await fetchCustomActions().catch(
        () => [] as CustomActionDef[],
      );
      const app = skillsForNav(all, "app");
      const appNameSet = new Set(app.map((s) => s.name));
      const sourceByName = new Map<string, SkillRow["source"]>();
      for (const s of all) sourceByName.set(s.name, s.source);

      setAppSkills([]);
      setActions(
        actionsRes
          .filter((a) => a.origin === "app-skill" && !a.legacyPlaybook)
          .map((a) => {
            const skill = a.skill?.trim() ?? "";
            let disabledReason: string | null = null;
            if (!skill) {
              disabledReason = "未挂载 skill";
            } else if (!appNameSet.has(skill)) {
              const src = sourceByName.get(skill);
              if (src === "builtin")
                disabledReason = "挂载的是内置 skill，不可传";
              else if (src === "team")
                disabledReason = "挂载的是团队 skill，不可传";
              else if (src === "feishu-cli")
                disabledReason = "挂载的是飞书 CLI skill，不可传";
              else disabledReason = "挂载的 skill 非自管，不可传";
            }
            return {
              id: a.id,
              label: a.label,
              skill,
              disabledReason,
            };
          }),
      );
    } catch (err) {
      toast.error(
        `读取失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    void loadDialogData();
  }, [open, loadDialogData]);

  const defaultCategory = useMemo(
    () => defaultUploadCategory(settings.userRole),
    [settings.userRole],
  );

  const handleUpload = async (skillNames: string[], category: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/team-library/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillNames, category }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        results?: Array<{ name: string; ok: boolean; error?: string }>;
        pendingReview?: boolean;
        mrUrl?: string;
      };
      if (!res.ok && !data.results) {
        toast.error(data.error ?? "上传失败");
        return;
      }
      const results = data.results ?? [];
      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      for (const f of failed) {
        toast.error(`「${f.name}」上传失败：${f.error ?? "未知错误"}`);
      }
      if (data.pendingReview) {
        toast.success("已提交审核", {
          description: data.mrUrl ? (
            <a
              href={data.mrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              查看 Merge Request
            </a>
          ) : (
            "等待 maintainer 审批"
          ),
        });
      } else if (succeeded.length > 0 && failed.length === 0) {
        toast.success(
          mode === "action"
            ? `已上传 ${succeeded.length} 个 action`
            : `已上传 ${succeeded.length} 个 skill`,
        );
      } else if (succeeded.length > 0) {
        toast.success(`已上传 ${succeeded.length} 个，${failed.length} 个失败`);
      }
      setOpen(false);
      onUploaded?.();
    } catch (err) {
      toast.error(
        `上传失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Upload />
        {BUTTON_LABEL[mode]}
      </Button>
      <UploadSkillsDialog
        open={open}
        busy={busy}
        mode={mode}
        appSkills={appSkills}
        actions={actions}
        teamSkillCategories={teamSkillCategories}
        defaultCategory={defaultCategory}
        onClose={() => setOpen(false)}
        onUpload={(names, category) => void handleUpload(names, category)}
      />
    </>
  );
};
