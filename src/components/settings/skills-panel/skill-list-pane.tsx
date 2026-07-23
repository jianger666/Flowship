"use client";

/**
 * Skills 右侧列表区：组头（一句说明 + 专属操作）+ 分类 chip 行 + skill 行
 */

import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Switch } from "@/components/ui/switch";
import { formatRelative } from "@/lib/task-display";
import type { TeamLibraryStatus } from "@/hooks/use-team-library";
import { cn } from "@/lib/utils";

import { SkillRowItem } from "./skill-row";
import {
  isSharedTeamCategory,
  sourceTagForSkill,
  type CategoryChip,
  type SkillRow,
  type SourceNavKey,
} from "./types";

type Props = {
  /** 当前展示的 skill（已按导航 / chip / 搜索过滤） */
  skills: SkillRow[];
  /** 搜索激活 → 平铺 + 来源标签、隐藏组头 / chip 行 */
  searching: boolean;
  selected: SourceNavKey;
  /** 分类 chip（仅共享 / 团队规范非空） */
  chips: CategoryChip[];
  activeChip: string;
  onChipChange: (chip: string) => void;
  knowledgeEnabled: boolean;
  onKnowledgeEnabledChange: (v: boolean) => void;
  teamStatus: TeamLibraryStatus | null;
  syncing: boolean;
  mirroring: boolean;
  onSync: () => void;
  onMirror: () => void;
  /** 正在安装 / 卸载的 skill 名（行内 spinner + 防双击） */
  busyName: string | null;
  onEdit: (name: string) => void;
  onView: (name: string, source: SkillRow["source"]) => void;
  onDelete: (name: string) => void;
  onToggleApp: (row: SkillRow, enabled: boolean) => void;
  onInstall: (row: SkillRow) => void;
  onUninstall: (row: SkillRow) => void;
  /** 共享行：从远端库删除（误上传清理） */
  onDeleteFromLibrary?: (row: SkillRow) => void;
};

/** 组头一句说明 */
const headerMeta = (
  selected: SourceNavKey,
): { title: string; hint: string } => {
  switch (selected) {
    case "app":
      return { title: "自管", hint: "本机 data/skills，可编辑上传" };
    case "shared":
      return { title: "共享", hint: "组内沉淀，按需安装" };
    case "knowledge":
      return { title: "团队规范", hint: "知识库镜像，可临时启停" };
    case "builtin":
      return { title: "内置", hint: "随包发布，必备" };
    default:
      return { title: "飞书 CLI", hint: "官方 skill，必备" };
  }
};

export const SkillListPane = ({
  skills,
  searching,
  selected,
  chips,
  activeChip,
  onChipChange,
  knowledgeEnabled,
  onKnowledgeEnabledChange,
  teamStatus,
  syncing,
  mirroring,
  onSync,
  onMirror,
  busyName,
  onEdit,
  onView,
  onDelete,
  onToggleApp,
  onInstall,
  onUninstall,
  onDeleteFromLibrary,
}: Props) => {
  const meta = headerMeta(selected);
  const groupDimmed = selected === "knowledge" && !knowledgeEnabled;

  // 行级弱化：仅 knowledge 条目跟团队规范开关走（搜索平铺里也生效）
  const rowDimmed = (s: SkillRow): boolean =>
    s.source === "team" &&
    !isSharedTeamCategory(s.teamCategory) &&
    !knowledgeEnabled;

  /** 同步按钮 + 相对时间（共享 / 团队规范组头共用） */
  const syncControls = (disabled: boolean) => (
    <>
      {teamStatus?.syncedAt != null && (
        <span
          className="max-w-[5.5rem] truncate text-[10px] text-muted-foreground"
          title={new Date(teamStatus.syncedAt).toLocaleString("zh-CN")}
        >
          {formatRelative(teamStatus.syncedAt)}
        </span>
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="同步"
        title="同步"
        disabled={syncing || mirroring || disabled}
        onClick={onSync}
      >
        {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      </Button>
    </>
  );

  return (
    <div className="min-w-0 flex-1">
      {/* 组头：非搜索时展示 */}
      {!searching && (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{meta.title}</div>
            <div className="text-[11px] text-muted-foreground">{meta.hint}</div>
          </div>
          {selected === "shared" && (
            <div className="flex shrink-0 items-center gap-1.5">
              {syncControls(false)}
            </div>
          )}
          {selected === "knowledge" && (
            <div className="flex shrink-0 items-center gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">团队规范</span>
                <Switch
                  checked={knowledgeEnabled}
                  onCheckedChange={onKnowledgeEnabledChange}
                  aria-label="启用团队规范"
                />
              </div>
              {syncControls(!knowledgeEnabled)}
              {teamStatus?.canMirror && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={syncing || mirroring || !knowledgeEnabled}
                  onClick={onMirror}
                >
                  {mirroring ? <Loader2 className="animate-spin" /> : null}
                  更新知识库镜像
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 分类 chip 行（仅共享 / 团队规范、非搜索时） */}
      {!searching && chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {chips.map((c) => (
            <ChoiceButton
              key={c.value}
              shape="chip"
              selected={activeChip === c.value}
              onClick={() => onChipChange(c.value)}
            >
              {c.label} {c.count}
            </ChoiceButton>
          ))}
        </div>
      )}

      {/* 共享 / 团队规范：token / 未同步提示 */}
      {!searching &&
        (selected === "shared" || selected === "knowledge") &&
        teamStatus?.needsToken && (
          <EmptyHint size="sm" className="mb-2">
            配置 GitLab Token 后可用 ·{" "}
            <Link
              href="/settings"
              className="underline underline-offset-2 hover:text-foreground"
            >
              去设置
            </Link>
          </EmptyHint>
        )}
      {!searching &&
        (selected === "shared" || selected === "knowledge") &&
        teamStatus &&
        !teamStatus.needsToken &&
        !teamStatus.cloned && (
          <EmptyHint size="sm" className="mb-2">
            点同步拉取
          </EmptyHint>
        )}

      {skills.length === 0 ? (
        <EmptyHint size="sm">
          {searching ? "没有匹配的 skill，试试别的关键词" : "此来源暂无 skill"}
        </EmptyHint>
      ) : (
        <div
          className={cn(
            "divide-y divide-border/60 rounded-md border border-border/60",
            groupDimmed && "opacity-60",
          )}
        >
          {skills.map((s) => (
            <SkillRowItem
              key={`${s.source}:${s.teamCategory ?? ""}:${s.name}`}
              skill={s}
              dimmed={rowDimmed(s)}
              sourceTag={searching ? sourceTagForSkill(s) : undefined}
              busy={busyName === s.name}
              anyBusy={busyName !== null}
              onEdit={onEdit}
              onView={onView}
              onDelete={onDelete}
              onToggleApp={onToggleApp}
              onInstall={onInstall}
              onUninstall={onUninstall}
              onDeleteFromLibrary={onDeleteFromLibrary}
            />
          ))}
        </div>
      )}
    </div>
  );
};
