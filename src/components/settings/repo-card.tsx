"use client";

/**
 * 仓库列表卡片
 *
 * 选目录走系统原生 picker（V0.7.13 用户拍板）——Electron 壳走主进程 dialog.showOpenDialog。
 *
 * 仓库名规则：
 * - 默认取目录 basename
 * - 用户可重命名、但提交（onBlur）时如果是空串、自动 fallback 回 basename
 */

import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useDialog } from "@/hooks/use-dialog";
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { pickNativePaths } from "@/lib/native-picker";
import { isAbsolutePathLike, pathBasename } from "@/lib/path-utils";

import type { RepoConfig } from "@/lib/types";

interface RepoCardProps {
  repos: RepoConfig[];
  // onChange 改草稿（文本框输入用）、onCommit 落盘（增删 / 失焦时调）
  onChange: (next: RepoConfig[]) => void;
  onCommit: (next: RepoConfig[]) => void;
}

export const RepoCard = ({ repos, onChange, onCommit }: RepoCardProps) => {
  const { prompt } = useDialog();

  // 原生 picker 调用中（防双击连开两个系统对话框）
  const [picking, setPicking] = useState(false);

  // v0.9.11：每仓分支候选（本地 + 远端）——undefined=拉取中、isRepo=false=非 git（分支字段禁用）
  const branchMap = useRepoBranches(repos.map((r) => r.path));

  // 添加若干仓库、name 默认 basename、重复路径跳过
  const addRepos = (paths: string[]) => {
    const fresh = paths.filter((p) => p && !repos.some((r) => r.path === p));
    if (fresh.length === 0) {
      toast.error("选的目录已经在列表里");
      return;
    }
    // 增删是离散操作、直接落盘
    onCommit([...repos, ...fresh.map((p) => ({ name: pathBasename(p), path: p }))]);
  };

  // 原生选目录（mac 支持多选、win 单选）
  const pickFolders = async () => {
    setPicking(true);
    try {
      const paths = await pickNativePaths({
        mode: "folder",
        multiple: true,
        prompt: "选择仓库目录",
      });
      if (paths) addRepos(paths);
    } finally {
      setPicking(false);
    }
  };

  // 手填路径备份入口（粘贴绝对路径、给极端场景兜底）
  // 用 useDialog().prompt 替代 window.prompt——shadcn 风格 + 内联校验、不阻塞主线程
  // CR-11：校验走共享跨平台判断——Windows 盘符（D:\repo）/ UNC 路径也放行、
  // 原实现只认 `/` 开头、Windows 用户手填兜底完全不可用
  const promptManualPath = async () => {
    const input = await prompt({
      title: "手填仓库路径",
      description: "输入绝对路径、仅 server 同机有效",
      placeholder: "/Users/me/some-repo",
      confirmLabel: "添加",
      validate: (v) => {
        const trimmed = v.trim().replace(/[\\/]+$/, "");
        if (!trimmed) return "路径不能为空";
        if (!isAbsolutePathLike(trimmed)) return "请填绝对路径";
        return "";
      },
    });
    if (input === null) return;
    addRepos([input.trim().replace(/[\\/]+$/, "")]);
  };

  // 仓库重命名：输入时改草稿、blur 落盘（空串 fallback 回 basename）
  const renameRepo = (path: string, name: string) => {
    onChange(repos.map((r) => (r.path === path ? { ...r, name } : r)));
  };
  const onRenameBlur = (path: string, name: string) => {
    const finalName = name.trim() || pathBasename(path);
    onCommit(repos.map((r) => (r.path === path ? { ...r, name: finalName } : r)));
  };

  // V0.6.3/V0.6.7：仓库分支字段（线上 / 测试 / dev 分支 + 分支模板覆盖、都 per-repo 选填）
  // 通用 setter：输入改草稿、blur 落盘——按 field 改对应字段、省得每个字段写一对
  const setRepoField = (
    path: string,
    field: "onlineBranch" | "testBranch" | "devBranch" | "branchTemplate" | "previewCommand",
    value: string,
  ) => {
    onChange(repos.map((r) => (r.path === path ? { ...r, [field]: value } : r)));
  };
  const onRepoFieldBlur = () => {
    onCommit(repos);
  };

  // v0.9.11：分支字段改 Combobox 后是离散选择、选中即落盘（不再走「草稿 + blur」）
  const commitRepoField = (
    path: string,
    field: "onlineBranch" | "testBranch" | "devBranch",
    value: string,
  ) => {
    onCommit(
      repos.map((r) => (r.path === path ? { ...r, [field]: value } : r)),
    );
  };

  // 删除是离散操作、直接落盘
  const removeRepo = (path: string) => {
    onCommit(repos.filter((r) => r.path !== path));
  };

  // 只读 / 脚本仓开关：离散选择、选中即落盘（关 = undefined、不落 false 脏 config）
  const commitRepoFlag = (
    path: string,
    field: "readonly" | "scriptRepo",
    value: boolean,
  ) => {
    onCommit(
      repos.map((r) =>
        r.path === path ? { ...r, [field]: value ? true : undefined } : r,
      ),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>仓库列表</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {repos.length === 0 ? (
          <EmptyHint size="lg" align="center">
            尚未添加任何仓库
          </EmptyHint>
        ) : (
          <div className="space-y-2">
            {repos.map((r) => {
              // v0.9.11：该仓分支候选——undefined=拉取中（先禁用）、真非 git 仓禁用；
              // gitMissing（git 命令不可用、判定不了）不禁用、放开手填（同事 Windows 踩过：
              // git 只在 IDE 内置、全部输入被禁死没法配置）
              const entry = branchMap[r.path];
              const branchDisabled = !entry || (entry.isRepo === false && !entry.gitMissing);
              const branchPlaceholder =
                entry?.isRepo === false
                  ? entry.pathMissing
                    ? "路径不存在、检查一下"
                    : entry.gitMissing
                      ? "未检测到 git、可手填分支"
                      : "非 git 仓库"
                  : undefined;
              return (
                // *:min-w-0：行内长路径的 min-content 会把 grid 隐式轨道撑得比容器宽、
                // 第二三行跟着溢出块右缘（路径越长越明显、实测踩过）——直接子行统一压回 0
                <div
                  key={r.path}
                  className="grid gap-2 rounded-lg border bg-card/50 px-3 py-2 *:min-w-0"
                >
                  {/* 第一行：仓名 + 路径 + 只读 / 脚本仓开关 + 删除 */}
                  <div className="flex items-center gap-2">
                    <Input
                      value={r.name}
                      onChange={(e) => renameRepo(r.path, e.target.value)}
                      onBlur={(e) => onRenameBlur(r.path, e.target.value)}
                      className="w-40 shrink-0"
                      placeholder="仓库名"
                    />
                    <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono">
                      {r.path}
                    </code>
                    <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      只读
                      <Switch
                        checked={r.readonly === true}
                        onCheckedChange={(v) => commitRepoFlag(r.path, "readonly", v)}
                      />
                    </label>
                    <label
                      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                      title="标注该仓专门存放脚本类产出（测试脚本 / 工具脚本等）——AI 往里写文件前会先看仓内 README / AGENTS.md 约定。与只读正交：只读脚本仓 = 纯参考库。"
                    >
                      脚本仓
                      <Switch
                        checked={r.scriptRepo === true}
                        onCheckedChange={(v) => commitRepoFlag(r.path, "scriptRepo", v)}
                      />
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeRepo(r.path)}
                      title="删除"
                    >
                      <Trash2 />
                    </Button>
                  </div>

                  {/* 第二行：线上 / 提测 / 联调 分支（都选填）。
                      v0.9.11 换 Combobox：候选自动拉本地 + 远端分支、可搜索、列表缺分支时可手填；
                      非 git 目录（手填的坏路径 / 普通文件夹）禁用——没分支可选。
                      v1.0.x：三框加迷你 label（原来 placeholder-only、有值后就不知道哪个框是啥了） */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">线上分支</span>
                      <Combobox
                        value={r.onlineBranch ?? ""}
                        onValueChange={(v) =>
                          commitRepoField(r.path, "onlineBranch", v)
                        }
                        options={entry?.branches ?? []}
                        loading={!entry}
                        disabled={branchDisabled}
                        placeholder={branchPlaceholder ?? "留空自动探测"}
                        title="feature 从这个分支拉、留空则 build 时自动探测默认分支"
                      />
                    </div>
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">提测分支</span>
                      <Combobox
                        value={r.testBranch ?? ""}
                        onValueChange={(v) =>
                          commitRepoField(r.path, "testBranch", v)
                        }
                        options={entry?.branches ?? []}
                        loading={!entry}
                        disabled={branchDisabled}
                        placeholder={branchPlaceholder ?? "留空默认 test"}
                        title="ship 提测 MR 的目标分支、留空则默认 test"
                      />
                    </div>
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">联调分支</span>
                      <Combobox
                        value={r.devBranch ?? ""}
                        onValueChange={(v) =>
                          commitRepoField(r.path, "devBranch", v)
                        }
                        options={entry?.branches ?? []}
                        loading={!entry}
                        disabled={branchDisabled}
                        placeholder={branchPlaceholder ?? "选填"}
                        title="dev / 联调分支（联调 action 的推送目标）"
                      />
                    </div>
                  </div>

                  {/* 第三行：分支模板覆盖（留空用全局默认）+ 预览启动命令 */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">分支模板覆盖</span>
                      <Input
                        value={r.branchTemplate ?? ""}
                        onChange={(e) =>
                          setRepoField(r.path, "branchTemplate", e.target.value)
                        }
                        onBlur={onRepoFieldBlur}
                        placeholder="留空用全局默认"
                        title="覆盖该仓 feature 分支命名模板、占位符同全局模板"
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">预览启动命令</span>
                      <Input
                        value={r.previewCommand ?? ""}
                        onChange={(e) =>
                          setRepoField(r.path, "previewCommand", e.target.value)
                        }
                        onBlur={onRepoFieldBlur}
                        placeholder="如 npm run dev"
                        title="配了任务页才显示「预览」按钮、点击在该任务工作区起 dev server"
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={picking}
            onClick={pickFolders}
          >
            <FolderOpen />
            选择文件夹
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={promptManualPath}
          >
            <Plus />
            手填路径
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
