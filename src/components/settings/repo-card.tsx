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
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useDialog } from "@/hooks/use-dialog";
import { pathBasename } from "@/lib/path-utils";

import type { RepoConfig } from "@/lib/types";
import { SaveButton } from "./save-button";

interface RepoCardProps {
  repos: RepoConfig[];
  onChange: (next: RepoConfig[]) => void;
  dirty: boolean;
  onSave: () => void;
}

export const RepoCard = ({ repos, onChange, dirty, onSave }: RepoCardProps) => {
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
    onChange([...repos, { name: pathBasename(path), path }]);
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

  // 仓库重命名：受控输入、空串 fallback 回 basename
  // 用 onBlur 触发 fallback、避免输入过程中误清回退
  const renameRepo = (path: string, name: string) => {
    onChange(repos.map((r) => (r.path === path ? { ...r, name } : r)));
  };
  const onRenameBlur = (path: string, name: string) => {
    if (name.trim()) return;
    onChange(
      repos.map((r) => (r.path === path ? { ...r, name: pathBasename(path) } : r))
    );
  };

  const removeRepo = (path: string) => {
    onChange(repos.filter((r) => r.path !== path));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>仓库列表</CardTitle>
        <CardDescription>
          点「选择文件夹」会弹出服务端文件浏览器、跨平台都能用
        </CardDescription>
        <CardAction>
          <SaveButton dirty={dirty} onSave={onSave} />
        </CardAction>
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
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/50 px-3 py-2"
              >
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
