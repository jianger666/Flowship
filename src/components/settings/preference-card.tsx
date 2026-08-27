"use client";

/**
 * 「偏好」卡内容（v1.0.x 设置整合二次修——用户实测「还是有点乱」后定型）
 *
 * 布局定式：**统一设置行**（对标 VS Code / Linear）——每项一行、左边「名称 + 一句说明」、
 * 右边控件右对齐；宽控件（分支模板）用堆叠行（名称行 + 全宽控件）。
 * 行间 divide-y 出结构、不再用小节头（三层文字层级挤在一起就是「乱」的根源）。
 *
 * 原 user-profile-card（IDE + 分支模板）已并入本文件；默认模型在设置页「模型」卡。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import {
  findUnknownPlaceholders,
  renderBranchName,
} from "@/lib/branch-template";
import { openSystemNotificationSettings } from "@/lib/shell-notify";
import { SUBMIT_SHORTCUT_LABEL } from "@/lib/submit-shortcut";
import { roleSupportsWorktree } from "@/lib/role-worktree";
import {
  JUMP_IDES,
  JUMP_IDE_LABEL,
  USER_ROLE_LABEL,
  USER_ROLES,
  type JumpIde,
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
  // 提交快捷键 / 续用 Agent / Agent shell Git Bash / 隔离工作区默认值 / 系统通知
  submitShortcut: SubmitShortcut;
  reuseAgentDefault: boolean;
  onSubmitShortcutChange: (next: SubmitShortcut) => void;
  onReuseAgentDefaultChange: (next: boolean) => void;
  /** Windows：Agent shell 用 Git Bash（非 win32 不传也无妨、UI 按 platform 隐藏） */
  agentShellGitBash: boolean;
  /** 落盘完成后再 resolve，便于拨开关后刷新 agentShellKind */
  onAgentShellGitBashChange: (next: boolean) => void | Promise<unknown>;
  isolateWorktreeDefault: boolean;
  onIsolateWorktreeDefaultChange: (next: boolean) => void;
  /** 插电防休眠（默认开；桥接开着时才真正 caffeinate） */
  feishuBridgeKeepAwake: boolean;
  onFeishuBridgeKeepAwakeChange: (next: boolean) => void;
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
  agentShellGitBash,
  onAgentShellGitBashChange,
  isolateWorktreeDefault,
  onIsolateWorktreeDefaultChange,
  feishuBridgeKeepAwake,
  onFeishuBridgeKeepAwakeChange,
}: PreferenceSectionsProps) => {
  // 本机探测到的可用 IDE 集合（后端扫安装位置 + PATH）；null = 还没回来（全部可选）
  const [availableIdes, setAvailableIdes] = useState<Set<JumpIde> | null>(null);
  // SDK 实际选用的壳类型（拨 Git Bash 开关后刷新）；null = 尚未拿到
  const [agentShellKind, setAgentShellKind] = useState<string | null>(null);
  // 服务端 platform（仅 win32 显示「用 Git Bash」行）；null = 尚未拿到
  const [shellPlatform, setShellPlatform] = useState<string | null>(null);
  // 本机探测到的 Git Bash 路径；null = 未探测到 / 非 win32；undefined = 尚未请求回来
  const [gitBashPath, setGitBashPath] = useState<string | null | undefined>(
    undefined,
  );
  // mac 菜单栏图标：undefined = 非桌面 / 非 darwin / 尚未读到 → 不渲染这一行
  const [menuBarIcon, setMenuBarIcon] = useState<boolean | undefined>(undefined);
  const [menuBarIconBusy, setMenuBarIconBusy] = useState(false);
  // 开机自启：undefined = 非桌面端 / 尚未读到 → 不渲染
  const [autoLaunch, setAutoLaunch] = useState<boolean | undefined>(undefined);
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);

  useEffect(() => {
    const api = window.__menuBarIcon;
    if (!api) return;
    let alive = true;
    void (async () => {
      try {
        const v = await api.get();
        if (alive && typeof v === "boolean") setMenuBarIcon(v);
      } catch {
        /* 读失败当无通道、不展示 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const api = window.__autoLaunch;
    if (!api) return;
    let alive = true;
    void (async () => {
      try {
        const v = await api.get();
        if (alive) setAutoLaunch(v);
      } catch {
        /* 读失败当无通道、不展示 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleMenuBarIcon = async (next: boolean) => {
    const api = window.__menuBarIcon;
    if (!api) return;
    setMenuBarIconBusy(true);
    try {
      await api.set(next);
      setMenuBarIcon(next);
    } catch (err) {
      toast.error(
        `设置菜单栏图标失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setMenuBarIconBusy(false);
    }
  };

  const handleAutoLaunch = async (next: boolean) => {
    const api = window.__autoLaunch;
    if (!api) return;
    setAutoLaunchBusy(true);
    try {
      await api.set(next);
      setAutoLaunch(next);
    } catch (err) {
      toast.error(
        `设置开机自启动失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAutoLaunchBusy(false);
    }
  };

  /** 拉当前 Agent shell 类型 / Git Bash 路径（挂载 + 拨开关后刷新） */
  const refreshAgentShell = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/system/agent-shell");
      const data = (await res.json()) as {
        agentShellKind?: string;
        platform?: string;
        gitBashPath?: string | null;
      };
      if (typeof data.agentShellKind === "string") {
        setAgentShellKind(data.agentShellKind);
      }
      if (typeof data.platform === "string") {
        setShellPlatform(data.platform);
      }
      setGitBashPath(
        typeof data.gitBashPath === "string" ? data.gitBashPath : null,
      );
    } catch {
      // 探测失败不挡设置页
    }
  }, []);

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

  useEffect(() => {
    void refreshAgentShell();
  }, [refreshAgentShell]);

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
        hint="用于告诉 AI 你的工作视角/身份（注入任务与对话的发起人信息）"
        control={
          <Picker
            className="w-44"
            value={userRole ?? ""}
            placeholder="请选择"
            onChange={(v) => {
              if (USER_ROLES.includes(v as UserRole)) {
                onUserRoleChange(v as UserRole);
              }
            }}
            options={USER_ROLES.map((id) => ({
              value: id,
              label: USER_ROLE_LABEL[id],
            }))}
          />
        }
      />

      <SettingRow
        label="代码跳转 IDE"
        hint="路径链接 / 打开工作区用哪个"
        control={
          <Picker
            className="w-44"
            value={jumpIde}
            onChange={(v) =>
              onJumpIdeChange(
                JUMP_IDES.includes(v as JumpIde) ? (v as JumpIde) : "cursor",
              )
            }
            options={JUMP_IDES.filter(
              // 只列本机装了的；当前已选的即使没探到也列；探测没回来前全列
              (id) =>
                availableIdes === null ||
                availableIdes.has(id) ||
                id === jumpIde,
            ).map((id) => ({
              value: id,
              label: JUMP_IDE_LABEL[id],
            }))}
          />
        }
      />

      <SettingRow
        label="提交快捷键"
        hint="聊天 / 推进输入框的发送方式"
        control={
          <Picker
            className="w-64"
            value={submitShortcut}
            onChange={(v) =>
              onSubmitShortcutChange(v === "enter" ? "enter" : "mod-enter")
            }
            options={[
              {
                value: "mod-enter",
                label: SUBMIT_SHORTCUT_LABEL["mod-enter"],
              },
              { value: "enter", label: SUBMIT_SHORTCUT_LABEL.enter },
            ]}
          />
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

      {roleSupportsWorktree(userRole) && (
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
      )}

      {/* 通知开关本质在系统层（用户拍板：不放 app 层 Switch）——这行只做「找回入口」 */}
      <SettingRow
        label="任务系统通知"
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openSystemNotificationSettings()}
          >
            去系统设置
          </Button>
        }
      />

      {menuBarIcon !== undefined && (
        <SettingRow
          label="显示菜单栏图标"
          control={
            <Switch
              checked={menuBarIcon}
              disabled={menuBarIconBusy}
              onCheckedChange={(v) => void handleMenuBarIcon(v)}
            />
          }
        />
      )}

      {autoLaunch !== undefined && (
        <SettingRow
          label="开机自启动"
          control={
            <Switch
              checked={autoLaunch}
              disabled={autoLaunchBusy}
              onCheckedChange={(v) => void handleAutoLaunch(v)}
            />
          }
        />
      )}

      <SettingRow
        label="插电时防休眠"
        control={
          <Switch
            checked={feishuBridgeKeepAwake}
            onCheckedChange={onFeishuBridgeKeepAwakeChange}
          />
        }
      />

      {/* 仅 Windows：把 SHELL 指到 Git Bash，绕开 SDK PowerShell 挂死 bug */}
      {shellPlatform === "win32" ? (
        <SettingRow
          label="Agent shell 用 Git Bash"
          hint={
            <>
              {gitBashPath ? (
                <Tooltip content={gitBashPath}>
                  <span className="block min-w-0 truncate">{gitBashPath}</span>
                </Tooltip>
              ) : gitBashPath === null ? (
                "未检测到 Git Bash"
              ) : (
                "探测中…"
              )}
              {agentShellKind ? (
                <span className="block">当前：{agentShellKind}</span>
              ) : null}
            </>
          }
          control={
            <Switch
              checked={agentShellGitBash}
              disabled={!gitBashPath}
              onCheckedChange={(v) => {
                // 等落盘 + server apply SHELL 完成，再刷新「当前」展示
                void Promise.resolve(onAgentShellGitBashChange(v)).then(() =>
                  refreshAgentShell(),
                );
              }}
            />
          }
        />
      ) : null}

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
            onBlur={() => {
              // 失焦才校验：拦 `{yyMMdd}` 这类 typo（正确 `{date:yyMMdd}`），避免落盘后建出字面分支
              const unknown = findUnknownPlaceholders(branchTemplate);
              if (unknown.length > 0) {
                toast.error(
                  `模板含未知占位符 ${unknown.join("、")}——日期请用 {date:yyMMdd}`,
                );
                return;
              }
              onBranchTemplateCommit(branchTemplate);
            }}
            placeholder="留空默认 feature/{storyId}-{taskTitle}（想带名字直接写、如 feature/clj/…）"
            className="font-mono"
          />
        }
      />

      </div>
  );
};
