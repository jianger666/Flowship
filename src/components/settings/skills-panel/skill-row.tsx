"use client";

/**
 * Skills 列表单行（行尾控件按来源分）：
 * - 自管：常驻「编辑 / 删除」文字按钮 + Switch（disabledSkills）
 * - team「共享」（shared:*）：市场模型——未安装「安装」；已安装「已安装」标 + 常驻「卸载」；
 *   另有低调「从库删除」（远端清理误上传）
 * - team「团队规范」（knowledge）：Switch 启停（开=install / 关=uninstall；总开关关时禁用）
 * - 内置 / 飞书 CLI：必备只读、常驻「查看」
 *
 * 操作区一律常驻文字按钮（与 Action tab 统一；废除 hover 显现 + 纯 icon）。
 * 行布局：左侧两行文本 + 右侧操作区垂直居中（items-center）。
 */

import { Loader2 } from "lucide-react";

import { AuthorByline } from "@/components/ui/author-byline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { isSharedTeamCategory, type SkillRow } from "./types";

/** 行内次要操作：紧凑 ghost 文字按钮（查看/编辑/删除/卸载共用） */
const ROW_ACTION_BTN =
  "h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-foreground";

type Props = {
  skill: SkillRow;
  /** 团队规范开关关 → 行弱化 + Switch/按钮禁用 */
  dimmed?: boolean;
  /** 搜索平铺时带来源小标签 */
  sourceTag?: string;
  /** 本行安装 / 卸载请求飞行中（控 spinner） */
  busy?: boolean;
  /** 任意行飞行中 → 本行装卸控件全禁用（防点别的行静默无反应） */
  anyBusy?: boolean;
  onEdit: (name: string) => void;
  onView: (name: string, source: SkillRow["source"]) => void;
  onDelete: (name: string) => void;
  /** 仅自管：Switch 切 disabledSkills */
  onToggleApp: (row: SkillRow, enabled: boolean) => void;
  /** team：安装 / 卸载（shared 市场按钮；knowledge Switch 开/关也走这两条） */
  onInstall: (row: SkillRow) => void;
  onUninstall: (row: SkillRow) => void;
  /** 仅共享行：从远端共享库删除 */
  onDeleteFromLibrary?: (row: SkillRow) => void;
};

export const SkillRowItem = ({
  skill: s,
  dimmed = false,
  sourceTag,
  busy = false,
  anyBusy = false,
  onEdit,
  onView,
  onDelete,
  onToggleApp,
  onInstall,
  onUninstall,
  onDeleteFromLibrary,
}: Props) => {
  const isTeam = s.source === "team";
  // 共享 vs 团队规范：行尾交互分流（装卸 vs 启停）
  const isShared = isTeam && isSharedTeamCategory(s.teamCategory);
  const isKnowledge = isTeam && !isSharedTeamCategory(s.teamCategory);
  const installed = isShared && s.enabled;
  // 装卸控件：任意行忙就禁；spinner 仍只看本行 busy
  const controlsDisabled = dimmed || anyBusy;

  return (
    <div
      className={cn(
        // 操作区相对整行垂直居中（单行 / 两行文本都稳定）
        "flex items-center gap-2 px-3 py-2.5",
        dimmed && "opacity-50",
      )}
    >
      <div
        className={cn(
          "min-w-0 flex-1",
          // 自管被关 / team 未启用 → 内容弱化
          !s.enabled && "opacity-50",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={s.displayPath ?? s.absPath}
          >
            {s.name}
          </span>
          {s.teamAction && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              action
            </Badge>
          )}
          {/* 「已安装」仅共享市场语义；knowledge 靠 Switch 自表达 */}
          {installed && (
            <Badge
              variant="secondary"
              className="shrink-0 text-[10px] text-muted-foreground"
            >
              已安装
            </Badge>
          )}
          {sourceTag && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {sourceTag}
            </Badge>
          )}
          {/* 创建人：仅共享沉淀显示（组内谁传的有意义）；团队规范是镜像的官方库、不标 by */}
          {isShared && s.author && <AuthorByline author={s.author} />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
          {s.description}
        </p>
      </div>

      {/* 操作区常驻（与 Switch / 安装同排；纯文字按钮） */}
      <div className="flex shrink-0 items-center gap-0.5">
        {s.editable ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className={ROW_ACTION_BTN}
              onClick={() => onEdit(s.name)}
            >
              编辑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={cn(ROW_ACTION_BTN, "hover:text-destructive")}
              onClick={() => onDelete(s.name)}
            >
              删除
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION_BTN}
            onClick={() => onView(s.name, s.source)}
          >
            查看
          </Button>
        )}
        {/* 共享已安装：常驻卸载（区别于自管「删除」） */}
        {installed && (
          <Button
            size="sm"
            variant="ghost"
            className={cn(ROW_ACTION_BTN, "hover:text-destructive")}
            disabled={controlsDisabled}
            onClick={() => onUninstall(s)}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : "卸载"}
          </Button>
        )}
        {/* 共享市场：从远端库删除（已装/未装都有；放最后、destructive hover） */}
        {isShared && onDeleteFromLibrary && (
          <Button
            size="sm"
            variant="ghost"
            className={cn(ROW_ACTION_BTN, "hover:text-destructive")}
            disabled={controlsDisabled}
            onClick={() => onDeleteFromLibrary(s)}
          >
            从库删除
          </Button>
        )}
      </div>

      {/* 行尾常驻控件：Switch / 安装 */}
      {s.source === "app" && (
        <Switch
          className="shrink-0"
          checked={s.enabled}
          onCheckedChange={(v) => onToggleApp(s, v)}
          aria-label={`${s.enabled ? "禁用" : "启用"} ${s.name}`}
        />
      )}
      {/* 团队规范：Switch 启停（开=install / 关=uninstall）；总开关关时禁用置灰 */}
      {isKnowledge && (
        <Switch
          className="shrink-0"
          checked={s.enabled}
          disabled={controlsDisabled}
          onCheckedChange={(v) => {
            if (v) onInstall(s);
            else onUninstall(s);
          }}
          aria-label={`${s.enabled ? "关闭" : "启用"} ${s.name}`}
        />
      )}
      {/* 共享未安装：安装按钮（市场召唤、outline 例外） */}
      {isShared && !installed && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2.5 text-[12px]"
          disabled={controlsDisabled}
          onClick={() => onInstall(s)}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : "安装"}
        </Button>
      )}
    </div>
  );
};
