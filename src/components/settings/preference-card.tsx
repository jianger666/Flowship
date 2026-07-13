"use client";

/**
 * 「偏好」卡内容（v1.0.x 设置整合二次修——用户实测「还是有点乱」后定型）
 *
 * 布局定式：**统一设置行**（对标 VS Code / Linear）——每项一行、左边「名称 + 一句说明」、
 * 右边控件右对齐；宽控件（分支模板 / 模型选择）用堆叠行（名称行 + 全宽控件）。
 * 行间 divide-y 出结构、不再用小节头（三层文字层级挤在一起就是「乱」的根源）。
 *
 * 原 user-profile-card（IDE + 分支模板）/ model-card（默认模型）已并入本文件、单一来源。
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { renderBranchName } from "@/lib/branch-template";
import { openSystemNotificationSettings } from "@/lib/shell-notify";
import { SUBMIT_SHORTCUT_LABEL } from "@/lib/submit-shortcut";
import {
  JUMP_IDES,
  JUMP_IDE_LABEL,
  USER_ROLE_LABEL,
  USER_ROLES,
  type JumpIde,
  type ModelOption,
  type ModelSelection,
  type SubmitShortcut,
  type UserRole,
} from "@/lib/types";

interface PreferenceSectionsProps {
  // 代码跳转 IDE
  jumpIde: JumpIde;
  onJumpIdeChange: (next: JumpIde) => void;
  // 我的角色（身份注入视角锚点）
  userRole: UserRole | undefined;
  onUserRoleChange: (next: UserRole) => void;
  // 分支模板（输入改草稿、失焦落盘）
  branchTemplate: string;
  onBranchTemplateChange: (next: string) => void;
  onBranchTemplateCommit: (value: string) => void;
  // 提交快捷键 / 续用 Agent / 隔离工作区默认值 / 系统通知
  submitShortcut: SubmitShortcut;
  reuseAgentDefault: boolean;
  onSubmitShortcutChange: (next: SubmitShortcut) => void;
  onReuseAgentDefaultChange: (next: boolean) => void;
  isolateWorktreeDefault: boolean;
  onIsolateWorktreeDefaultChange: (next: boolean) => void;
  notificationsEnabled: boolean;
  onNotificationsEnabledChange: (next: boolean) => void;
  // 默认模型
  models: ModelOption[];
  modelsError: string;
  modelSelection: ModelSelection;
  onModelChange: (next: ModelSelection) => void;
  apiKey: string;
  modelsRefreshing: boolean;
  onModelsRefresh: (apiKey: string) => void;
}

export const PreferenceSections = ({
  jumpIde,
  onJumpIdeChange,
  userRole,
  onUserRoleChange,
  branchTemplate,
  onBranchTemplateChange,
  onBranchTemplateCommit,
  submitShortcut,
  reuseAgentDefault,
  onSubmitShortcutChange,
  onReuseAgentDefaultChange,
  isolateWorktreeDefault,
  onIsolateWorktreeDefaultChange,
  notificationsEnabled,
  onNotificationsEnabledChange,
  models,
  modelsError,
  modelSelection,
  onModelChange,
  apiKey,
  modelsRefreshing,
  onModelsRefresh,
}: PreferenceSectionsProps) => {
  // 本机探测到的可用 IDE 集合（后端扫安装位置 + PATH）；null = 还没回来（全部可选）
  const [availableIdes, setAvailableIdes] = useState<Set<JumpIde> | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/system/ide-tools")
      .then((r) => r.json())
      .then((data: { tools?: Array<{ id: JumpIde; available: boolean }> }) => {
        if (!alive || !Array.isArray(data.tools)) return;
        setAvailableIdes(
          new Set(data.tools.filter((t) => t.available).map((t) => t.id)),
        );
      })
      .catch(() => {
        // 探测失败不挡配置、保持全部可选
      });
    return () => {
      alive = false;
    };
  }, []);

  // 模板预览：示例变量实时渲染（留空 = 内置兜底）
  const preview = useMemo(
    () =>
      renderBranchName(branchTemplate, {
        storyId: "6956910305",
        taskTitle: "需求标题",
      }),
    [branchTemplate],
  );

  return (
    <div className="divide-y">
      <SettingRow
        label="我的角色"
        hint="不同角色会解锁对应的辅助能力"
        control={
          <Select
            value={userRole ?? ""}
            onValueChange={(v) => {
              if (USER_ROLES.includes(v as UserRole)) {
                onUserRoleChange(v as UserRole);
              }
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="请选择">
                {userRole ? USER_ROLE_LABEL[userRole] : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {USER_ROLES.map((id) => (
                <SelectItem key={id} value={id}>
                  {USER_ROLE_LABEL[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <SettingRow
        label="代码跳转 IDE"
        hint="路径链接 / 打开工作区用哪个"
        control={
          <Select
            value={jumpIde}
            onValueChange={(v) =>
              onJumpIdeChange(
                JUMP_IDES.includes(v as JumpIde) ? (v as JumpIde) : "cursor",
              )
            }
          >
            <SelectTrigger className="w-44">
              <SelectValue>{JUMP_IDE_LABEL[jumpIde]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {JUMP_IDES.filter(
                // 只列本机装了的；当前已选的即使没探到也列；探测没回来前全列
                (id) =>
                  availableIdes === null ||
                  availableIdes.has(id) ||
                  id === jumpIde,
              ).map((id) => (
                <SelectItem key={id} value={id}>
                  {JUMP_IDE_LABEL[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <SettingRow
        label="提交快捷键"
        hint="聊天 / 推进输入框的发送方式"
        control={
          <Select
            value={submitShortcut}
            onValueChange={(v) =>
              onSubmitShortcutChange(v === "enter" ? "enter" : "mod-enter")
            }
          >
            <SelectTrigger className="w-64">
              <SelectValue>{SUBMIT_SHORTCUT_LABEL[submitShortcut]}</SelectValue>
            </SelectTrigger>
            <SelectContent
              side="bottom"
              alignItemWithTrigger={false}
              collisionAvoidance={{
                side: "shift",
                align: "shift",
                fallbackAxisSide: "none",
              }}
            >
              <SelectItem value="mod-enter">
                {SUBMIT_SHORTCUT_LABEL["mod-enter"]}
              </SelectItem>
              <SelectItem value="enter">{SUBMIT_SHORTCUT_LABEL.enter}</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {/* 下面两个是「默认值」不是全局行为开关（用户点名歧义）——hint 说清只影响默认勾选 */}
      <SettingRow
        label="推进时默认续用当前 Agent"
        hint="控制推进弹窗的默认勾选、每次推进可改"
        // 不绑 htmlFor：点标题就切开关误触率高（用户点名）、只有开关本体可点
        control={
          <Switch
            checked={reuseAgentDefault}
            onCheckedChange={onReuseAgentDefaultChange}
          />
        }
      />

      <SettingRow
        label="新任务默认使用 worktree"
        hint="worktree = 隔离工作区、任务改动不影响原仓库；关掉后新任务默认直接在原仓库运行"
        control={
          <Switch
            checked={isolateWorktreeDefault}
            onCheckedChange={onIsolateWorktreeDefaultChange}
          />
        }
      />

      {/* 开关自解释不加 hint；旁路「系统设置里开启」给系统层误拒权限的找回入口 */}
      <SettingRow
        label="任务系统通知"
        control={
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs text-muted-foreground"
              onClick={() => openSystemNotificationSettings()}
            >
              系统设置里开启
            </Button>
            <Switch
              checked={notificationsEnabled}
              onCheckedChange={onNotificationsEnabledChange}
            />
          </div>
        }
      />

      <SettingRow
        stacked
        label="默认分支命名模板"
        hint={
          <>
            占位符 <code className="font-mono">{"{storyId}"}</code>{" "}
            <code className="font-mono">{"{taskTitle}"}</code>{" "}
            <code className="font-mono">{"{date:MM-dd}"}</code>
            ；预览：
            <code className="font-mono text-foreground/80">{preview}</code>
          </>
        }
        control={
          <Input
            value={branchTemplate}
            onChange={(e) => onBranchTemplateChange(e.target.value)}
            onBlur={() => onBranchTemplateCommit(branchTemplate)}
            placeholder="留空默认 feature/{storyId}-{taskTitle}（想带名字直接写、如 feature/clj/…）"
            className="font-mono"
          />
        }
      />

      <SettingRow
        stacked
        label="默认模型"
        hint={
          modelsError ? (
            <span className="text-destructive">{modelsError}</span>
          ) : models.length > 0 ? (
            `共 ${models.length} 个可用模型`
          ) : (
            "新任务 / 对话的默认 AI"
          )
        }
        labelExtra={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onModelsRefresh(apiKey)}
            disabled={modelsRefreshing || !apiKey.trim()}
            title={apiKey.trim() ? "重新拉取可用模型列表" : "请先填 API key"}
          >
            {modelsRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            获取列表
          </Button>
        }
        control={
          <ModelSelect
            models={models}
            selection={modelSelection}
            onChange={onModelChange}
            variant="full"
          />
        }
      />
    </div>
  );
};
