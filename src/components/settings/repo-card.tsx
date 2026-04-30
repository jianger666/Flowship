"use client";

/**
 * 仓库列表卡片
 *
 * 选目录优先走 macOS 原生 dialog（/api/fs/pick-folder）；
 * 失败 / 非 macOS 时降级到「手填路径」对话框、避免 Linux/Windows 同事完全用不了。
 *
 * 仓库名规则：
 * - 默认取目录 basename
 * - 用户可重命名、但提交（onBlur）时如果是空串、自动 fallback 回 basename
 */

import { FolderOpen, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { RepoConfig } from "@/lib/types";
import { SaveButton } from "./save-button";

// 取绝对路径最后一段做仓库 name 默认值（处理末尾斜杠）
const basename = (p: string): string => {
  const cleaned = p.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
};

interface RepoCardProps {
  repos: RepoConfig[];
  onChange: (next: RepoConfig[]) => void;
  dirty: boolean;
  onSave: () => void;
}

export const RepoCard = ({ repos, onChange, dirty, onSave }: RepoCardProps) => {
  // 弹原生 dialog 期间禁止重复点（osascript 是模态阻塞的）
  const [pickingFolder, setPickingFolder] = useState(false);

  // 添加一条仓库（路径已确定的情况）、name 默认 basename、重复路径直接拒绝
  const addRepo = (path: string) => {
    if (!path) return;
    if (repos.some((r) => r.path === path)) {
      toast.error("这个目录已经在列表里");
      return;
    }
    onChange([...repos, { name: basename(path), path }]);
  };

  // 走 macOS 原生 dialog；非 macOS 会被 server 拒绝（501）、走 fallback 手填
  const pickFolder = async () => {
    setPickingFolder(true);
    try {
      const res = await fetch("/api/fs/pick-folder", { method: "POST" });
      const json = await res.json();
      if (json.canceled) return;
      if (res.status === 501) {
        // 非 macOS server、降级让用户手填
        promptManualPath();
        return;
      }
      if (!res.ok) {
        toast.error(json.error || "选择失败");
        return;
      }
      addRepo(json.path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingFolder(false);
    }
  };

  // 手填路径备份入口（非 macOS / 远程部署时用）
  const promptManualPath = () => {
    const input = window.prompt("输入仓库的绝对路径（仅 server 同机有效）");
    if (input === null) return;
    const trimmed = input.trim().replace(/\/+$/, "");
    if (!trimmed) {
      toast.error("路径不能为空");
      return;
    }
    if (!trimmed.startsWith("/")) {
      toast.error("请填绝对路径（以 / 开头）");
      return;
    }
    addRepo(trimmed);
  };

  // 仓库重命名：受控输入、空串 fallback 回 basename
  // 用 onBlur 触发 fallback、避免输入过程中误清回退
  const renameRepo = (path: string, name: string) => {
    onChange(repos.map((r) => (r.path === path ? { ...r, name } : r)));
  };
  const onRenameBlur = (path: string, name: string) => {
    if (name.trim()) return;
    onChange(
      repos.map((r) => (r.path === path ? { ...r, name: basename(path) } : r))
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
          点「选择文件夹」会调起 macOS 原生 dialog、其它平台请用「手填路径」
        </CardDescription>
        <CardAction>
          <SaveButton dirty={dirty} onSave={onSave} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {repos.length === 0 ? (
          <div className="text-xs text-muted-foreground border border-dashed rounded-lg p-6 text-center">
            尚未添加任何仓库
          </div>
        ) : (
          <div className="space-y-2">
            {repos.map((r) => (
              <div
                key={r.path}
                className="flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-2"
              >
                <Input
                  value={r.name}
                  onChange={(e) => renameRepo(r.path, e.target.value)}
                  onBlur={(e) => onRenameBlur(r.path, e.target.value)}
                  className="w-40"
                />
                <code className="flex-1 min-w-0 text-xs text-muted-foreground font-mono truncate">
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
            onClick={pickFolder}
            disabled={pickingFolder}
          >
            {pickingFolder ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            选择文件夹
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={promptManualPath}
            disabled={pickingFolder}
          >
            <Plus />
            手填路径
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
