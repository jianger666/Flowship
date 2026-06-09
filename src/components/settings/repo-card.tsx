"use client";

/**
 * 仓库列表卡片
 *
 * 选目录走 FsPickerDialog（服务端文件浏览器、跨平台、能拿绝对路径）。
 * 之前用 macOS osascript 限制了 Linux / Windows 同事用、已下线（保留路由文件做归档参考）。
 *
 * 仓库名规则：
 * - 默认取目录 basename
 * - 用户可重命名、但提交（onBlur）时如果是空串、自动 fallback 回 basename
 */

import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { FsPickerDialog } from "@/components/ui/fs-picker-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RepoCheckCommands } from "@/components/settings/repo-check-commands";
import { useDialog } from "@/hooks/use-dialog";
import { pathBasename } from "@/lib/path-utils";

import type { CheckCommand, RepoConfig } from "@/lib/types";

interface RepoCardProps {
  repos: RepoConfig[];
  // onChange 改草稿（文本框输入用）、onCommit 落盘（增删 / 失焦时调）
  onChange: (next: RepoConfig[]) => void;
  onCommit: (next: RepoConfig[]) => void;
}

export const RepoCard = ({ repos, onChange, onCommit }: RepoCardProps) => {
  const { prompt } = useDialog();

  // FsPickerDialog 的打开状态
  const [pickerOpen, setPickerOpen] = useState(false);

  // 添加一条仓库（路径已确定的情况）、name 默认 basename、重复路径直接拒绝
  const addRepo = (path: string) => {
    if (!path) return;
    if (repos.some((r) => r.path === path)) {
      toast.error("这个目录已经在列表里");
      return;
    }
    // 增删是离散操作、直接落盘
    onCommit([...repos, { name: pathBasename(path), path }]);
  };

  // 手填路径备份入口（粘贴绝对路径、给极端场景兜底）
  // 用 useDialog().prompt 替代 window.prompt——shadcn 风格 + 内联校验、不阻塞主线程
  const promptManualPath = async () => {
    const input = await prompt({
      title: "手填仓库路径",
      description: "输入绝对路径（以 / 开头）、仅 server 同机有效",
      placeholder: "/Users/me/some-repo",
      confirmLabel: "添加",
      validate: (v) => {
        const trimmed = v.trim().replace(/\/+$/, "");
        if (!trimmed) return "路径不能为空";
        if (!trimmed.startsWith("/")) return "请填绝对路径（以 / 开头）";
        return "";
      },
    });
    if (input === null) return;
    addRepo(input.replace(/\/+$/, ""));
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
    field: "onlineBranch" | "testBranch" | "devBranch" | "branchTemplate",
    value: string,
  ) => {
    onChange(repos.map((r) => (r.path === path ? { ...r, [field]: value } : r)));
  };
  const onRepoFieldBlur = () => {
    onCommit(repos);
  };

  // V0.6.25：改某仓 checkCommands（编辑器内部维护完整数组、这里只塞回对应 repo）
  // commit 语义同上：文本输入中改草稿（false）、增删 / select / switch / 失焦落盘（true）
  const setRepoCheckCommands = (
    path: string,
    next: CheckCommand[],
    commit: boolean,
  ) => {
    const updated = repos.map((r) =>
      r.path === path ? { ...r, checkCommands: next } : r,
    );
    (commit ? onCommit : onChange)(updated);
  };

  // 删除是离散操作、直接落盘
  const removeRepo = (path: string) => {
    onCommit(repos.filter((r) => r.path !== path));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>仓库列表</CardTitle>
        <CardDescription>
          点「选择文件夹」添加仓库；每仓可配分支 + 检查命令（build 后自动跑）、均选填
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {repos.length === 0 ? (
          <EmptyHint size="lg" align="center">
            尚未添加任何仓库
          </EmptyHint>
        ) : (
          <div className="space-y-2">
            {repos.map((r) => (
              <div
                key={r.path}
                className="grid gap-2 rounded-lg border bg-card/50 px-3 py-2"
              >
                {/* 第一行：仓名 + 路径 + 删除 */}
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

                {/* 第二行：线上 / 测试 / dev 分支（都选填） */}
                <div className="grid grid-cols-3 gap-2">
                  <Input
                    value={r.onlineBranch ?? ""}
                    onChange={(e) =>
                      setRepoField(r.path, "onlineBranch", e.target.value)
                    }
                    onBlur={onRepoFieldBlur}
                    placeholder="线上分支"
                    title="feature 从这个分支拉、留空则 build 时自动探测默认分支"
                  />
                  <Input
                    value={r.testBranch ?? ""}
                    onChange={(e) =>
                      setRepoField(r.path, "testBranch", e.target.value)
                    }
                    onBlur={onRepoFieldBlur}
                    placeholder="测试分支"
                    title="ship 提测 MR 的目标分支、留空则默认 test"
                  />
                  <Input
                    value={r.devBranch ?? ""}
                    onChange={(e) =>
                      setRepoField(r.path, "devBranch", e.target.value)
                    }
                    onBlur={onRepoFieldBlur}
                    placeholder="dev 分支"
                    title="dev / 联调分支（当前仅存配置）"
                  />
                </div>

                {/* 第三行：分支模板覆盖（留空用设置页全局默认） */}
                <Input
                  value={r.branchTemplate ?? ""}
                  onChange={(e) =>
                    setRepoField(r.path, "branchTemplate", e.target.value)
                  }
                  onBlur={onRepoFieldBlur}
                  placeholder="分支模板覆盖（留空用全局默认）"
                  title="覆盖该仓 feature 分支命名模板、占位符同全局模板"
                  className="font-mono text-xs"
                />

                {/* 第四行：检查命令（build 后 runner 自动跑、per-repo 配、失败可挡提测） */}
                <div className="grid gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    检查命令（build 后自动跑）
                  </span>
                  <RepoCheckCommands
                    commands={r.checkCommands ?? []}
                    onChange={(next) =>
                      setRepoCheckCommands(r.path, next, false)
                    }
                    onCommit={(next) => setRepoCheckCommands(r.path, next, true)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setPickerOpen(true)}
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

      {/* 文件夹选择器：仅目录、单选 */}
      <FsPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="dir"
        title="选择仓库目录"
        description="选一个目录作为仓库根、agent 启动时会以此为 cwd"
        onConfirm={(paths) => {
          const p = paths[0];
          if (p) addRepo(p);
        }}
      />
    </Card>
  );
};
