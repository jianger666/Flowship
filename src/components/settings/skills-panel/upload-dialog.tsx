"use client";

/**
 * 上传到共享库 dialog（skill / action 两种语境复用）
 *
 * - mode=skill：只列自管 skill
 * - mode=action：只列自建非 legacy action；勾选 = 上传挂载的自管 skill，
 *   server uploadSkillsToTeamLibrary 会按挂载关系写 .flowship-action.json
 *
 * 候选行 / 强制上传勾选一律用 CheckboxRow（整行可点）—— base-ui Checkbox
 * 非原生 input，不能靠 `<label>` 联动，见 checkbox-row.tsx 顶部注释。
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/checkbox-row";
import { ChoiceButton } from "@/components/ui/choice-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import type { UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  labelUploadCategory,
  UPLOAD_CATEGORIES,
  type SkillRow,
  type UploadCategory,
} from "./types";

type Step = "pick" | "category";

export type UploadDialogMode = "skill" | "action";

/** action 模式行（自建 app-skill；不可传的带 disabledReason） */
export type UploadActionRow = {
  id: string;
  label: string;
  skill: string;
  /** null = 可勾选；非空 = 置灰原因 */
  disabledReason: string | null;
};

type Props = {
  open: boolean;
  busy: boolean;
  mode: UploadDialogMode;
  /** mode=skill */
  appSkills?: SkillRow[];
  /** mode=action */
  actions?: UploadActionRow[];
  /**
   * 共享库 skills/ 已有名 → 所在分类列表（跨分类冲突用）。
   * 仅 shared 组沉淀，不含 knowledge。
   */
  teamSkillCategories: Record<string, string[]>;
  /** 默认分类：settings.userRole；未配 → common */
  defaultCategory: UploadCategory;
  /**
   * 敏感扫描命中（已脱敏）；有则停在分类步展示明细 + 强制勾选。
   * 由父组件在 API 409 + sensitiveHits 时注入。
   */
  sensitiveHits?: Array<{
    file: string;
    line: number;
    kind: string;
    snippet: string;
  }>;
  onClose: () => void;
  /** 最终提交 skill 名列表（action 勾选会展开成其 skill）；force=误报强制上传 */
  onUpload: (skillNames: string[], category: string, force?: boolean) => void;
};

/** 相对目标分类：覆盖 / 跨分类冲突 / 无 */
const uploadNameStatus = (
  name: string,
  targetCategory: string,
  teamSkillCategories: Record<string, string[]>,
): "none" | "overwrite" | { conflict: string } => {
  const cats = teamSkillCategories[name] ?? [];
  if (cats.length === 0) return "none";
  const other = cats.find((c) => c !== targetCategory);
  if (other) return { conflict: other };
  if (cats.includes(targetCategory)) return "overwrite";
  return "none";
};

export const UploadSkillsDialog = ({
  open,
  busy,
  mode,
  appSkills = [],
  actions = [],
  teamSkillCategories,
  defaultCategory,
  sensitiveHits = [],
  onClose,
  onUpload,
}: Props) => {
  // 勾选 id：skill 模式 = skill 名；action 模式 = action id
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // 目标分类（默认跟用户角色；pick 步也用来判定覆盖 / 跨分类冲突）
  const [category, setCategory] = useState<UploadCategory>(defaultCategory);
  // 步骤：先勾选再选分类
  const [step, setStep] = useState<Step>("pick");
  // 误报出口：确认无敏感信息后允许带 force 重试
  const [forceUpload, setForceUpload] = useState(false);

  useEffect(() => {
    if (!open) {
      setPicked(new Set());
      setStep("pick");
      setForceUpload(false);
      return;
    }
    setCategory(defaultCategory);
  }, [open, defaultCategory]);

  // 新一轮命中到来时重置 force（避免上次勾选残留）
  useEffect(() => {
    if (sensitiveHits.length > 0) setForceUpload(false);
  }, [sensitiveHits]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 统一展开成要上传的 skill 名
  const resolvedSkillNames = useMemo(() => {
    if (mode === "skill") {
      return [...picked].filter((name) => {
        const st = uploadNameStatus(name, category, teamSkillCategories);
        return typeof st !== "object";
      });
    }
    const names = new Set<string>();
    for (const a of actions) {
      if (!picked.has(a.id) || a.disabledReason || !a.skill) continue;
      const st = uploadNameStatus(a.skill, category, teamSkillCategories);
      if (typeof st === "object") continue;
      names.add(a.skill);
    }
    return [...names];
  }, [mode, picked, actions, category, teamSkillCategories]);

  // 分类步：已勾但相对当前分类冲突的项（禁用上传）
  const categoryStepConflicts = useMemo(() => {
    if (step !== "category") return [] as Array<{ name: string; cat: string }>;
    const names =
      mode === "skill"
        ? [...picked]
        : actions
            .filter((a) => picked.has(a.id) && !a.disabledReason && a.skill)
            .map((a) => a.skill);
    const out: Array<{ name: string; cat: string }> = [];
    for (const name of names) {
      const st = uploadNameStatus(name, category, teamSkillCategories);
      if (typeof st === "object") out.push({ name, cat: st.conflict });
    }
    return out;
  }, [
    step,
    mode,
    picked,
    actions,
    category,
    teamSkillCategories,
  ]);

  const emptyPick =
    mode === "skill" ? appSkills.length === 0 : actions.length === 0;

  const pickTitle =
    mode === "skill" ? "上传我的 skill 到共享库" : "上传我的 action 到共享库";

  const renderNameBadge = (name: string) => {
    const st = uploadNameStatus(name, category, teamSkillCategories);
    if (st === "overwrite") {
      return (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          将覆盖
        </Badge>
      );
    }
    if (typeof st === "object") {
      return (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          与库内同名冲突（{labelUploadCategory(st.conflict)} 分类）
        </Badge>
      );
    }
    return null;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      disablePointerDismissal
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "pick" ? pickTitle : "选择分类"}
          </DialogTitle>
        </DialogHeader>

        {step === "pick" && (
          <>
            {emptyPick ? (
              <EmptyHint size="sm">
                {mode === "skill"
                  ? "没有可上传的自管 skill"
                  : "没有可上传的自建 action"}
              </EmptyHint>
            ) : mode === "skill" ? (
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {appSkills.map((s) => {
                  const st = uploadNameStatus(
                    s.name,
                    category,
                    teamSkillCategories,
                  );
                  const conflict = typeof st === "object";
                  return (
                    <CheckboxRow
                      key={s.name}
                      checked={picked.has(s.name)}
                      disabled={conflict}
                      checkboxClassName="mt-0.5"
                      className={cn(
                        "items-start rounded-md px-2 py-1.5 transition-colors",
                        !conflict && "hover:bg-accent/50",
                      )}
                      onCheckedChange={() => {
                        if (!conflict) toggle(s.name);
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm">{s.name}</span>
                          {renderNameBadge(s.name)}
                        </div>
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">
                          {s.description}
                        </p>
                      </div>
                    </CheckboxRow>
                  );
                })}
              </div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {actions.map((a) => {
                  const nameConflict =
                    !!a.skill &&
                    typeof uploadNameStatus(
                      a.skill,
                      category,
                      teamSkillCategories,
                    ) === "object";
                  const disabled = !!a.disabledReason || nameConflict;
                  return (
                    <CheckboxRow
                      key={a.id}
                      checked={picked.has(a.id)}
                      disabled={disabled}
                      checkboxClassName="mt-0.5"
                      className={cn(
                        "items-start rounded-md px-2 py-1.5 transition-colors",
                        !disabled && "hover:bg-accent/50",
                      )}
                      onCheckedChange={() => {
                        if (!disabled) toggle(a.id);
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm">
                            {a.label}
                            {a.skill ? ` (skill: ${a.skill})` : ""}
                          </span>
                          {!a.disabledReason &&
                            a.skill &&
                            renderNameBadge(a.skill)}
                        </div>
                        {a.disabledReason && (
                          <p className="text-[11px] text-muted-foreground">
                            {a.disabledReason}
                          </p>
                        )}
                      </div>
                    </CheckboxRow>
                  );
                })}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button
                onClick={() => setStep("category")}
                disabled={busy || resolvedSkillNames.length === 0}
              >
                下一步（{picked.size}）
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "category" && (
          <>
            <p className="text-xs text-muted-foreground">
              将上传 {resolvedSkillNames.length} 个
              {mode === "skill" ? " skill" : " action"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {UPLOAD_CATEGORIES.map((cat) => (
                <ChoiceButton
                  key={cat}
                  shape="chip"
                  selected={category === cat}
                  onClick={() => {
                    setCategory(cat);
                    // 换分类后清掉变冲突的勾选，避免带回 pick 仍勾着禁选项
                    setPicked((prev) => {
                      const next = new Set<string>();
                      if (mode === "skill") {
                        for (const name of prev) {
                          const st = uploadNameStatus(
                            name,
                            cat,
                            teamSkillCategories,
                          );
                          if (typeof st !== "object") next.add(name);
                        }
                      } else {
                        for (const a of actions) {
                          if (!prev.has(a.id) || !a.skill || a.disabledReason) {
                            continue;
                          }
                          const st = uploadNameStatus(
                            a.skill,
                            cat,
                            teamSkillCategories,
                          );
                          if (typeof st !== "object") next.add(a.id);
                        }
                      }
                      return next;
                    });
                  }}
                >
                  {labelUploadCategory(cat)}
                </ChoiceButton>
              ))}
            </div>
            {categoryStepConflicts.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {categoryStepConflicts
                  .map(
                    (c) =>
                      `「${c.name}」与库内同名冲突（${labelUploadCategory(c.cat)} 分类）`,
                  )
                  .join("；")}
                ，请换分类或返回取消勾选
              </p>
            )}
            {sensitiveHits.length > 0 && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
                <p className="text-xs text-destructive">
                  发现 {sensitiveHits.length} 处疑似敏感信息，已阻断上传
                </p>
                <ul className="max-h-36 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
                  {sensitiveHits.map((h, i) => (
                    <li key={`${h.file}:${h.line}:${h.kind}:${i}`} className="min-w-0">
                      <span className="wrap-anywhere font-mono">
                        {h.file}:{h.line}
                      </span>
                      {" · "}
                      {h.kind}
                      {" · "}
                      <span className="wrap-anywhere">{h.snippet}</span>
                    </li>
                  ))}
                </ul>
                <CheckboxRow
                  checked={forceUpload}
                  disabled={busy}
                  checkboxClassName="mt-0.5"
                  className="items-start"
                  onCheckedChange={setForceUpload}
                >
                  <span className="text-xs">确认无敏感信息、强制上传</span>
                </CheckboxRow>
              </div>
            )}
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setStep("pick")}
                disabled={busy}
              >
                上一步
              </Button>
              <Button
                onClick={() =>
                  onUpload(
                    resolvedSkillNames,
                    category,
                    sensitiveHits.length > 0 ? forceUpload : false,
                  )
                }
                disabled={
                  busy ||
                  resolvedSkillNames.length === 0 ||
                  categoryStepConflicts.length > 0 ||
                  (sensitiveHits.length > 0 && !forceUpload)
                }
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                {sensitiveHits.length > 0 ? "强制上传" : "上传"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

/** 把 settings.userRole 映射成上传默认分类 */
export const defaultUploadCategory = (
  userRole: UserRole | undefined,
): UploadCategory => {
  if (
    userRole === "fe" ||
    userRole === "be" ||
    userRole === "qa" ||
    userRole === "other"
  ) {
    return userRole;
  }
  return "common";
};
