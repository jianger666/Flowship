"use client";

/**
 * 编辑任务 Dialog（V0.6.6）
 *
 * 详情页「编辑」按钮打开、改建任务时填的软配置字段：
 *   角色 / 标题 / 飞书链接 / 已有工作分支（per-repo）
 *
 * 刻意不在此改：
 *   - 模型 model（SDK Run 启动时绑定的硬约束、改了只能换新 agent、要换走推进 dialog 的模型选择）
 *   - mode（task/chat 是两套通路、切了等于换任务）
 *   - 仓库 repoPaths（副作用大：变 agent cwd、已建 git 分支/MR 对不上）——只读展示
 *   - MCP 开关（走 TaskMcpPanel）、上下文 doc（走 ContextDocsPanel）——详情页已有各自面板
 *
 * 副作用约定（V0.6.6 热更）：
 *   - 角色 / 标题 / 飞书链接：长生 agent reused 推进时 task-runner 会 diff 启动快照、有变拼 [TASK_UPDATED] 注入告知（立即生效）
 *   - 标题 / 飞书链接：已建的 git 分支名不会改（建时已固化）、只影响之后新建的
 *   - running 时不让编辑（详情页入口禁用）、避免改了跟正在跑的不一致
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSettings } from "@/lib/local-store";
import { updateTaskFields } from "@/lib/task-store";
import { TASK_ROLE_LABEL, type Task, type TaskRole } from "@/lib/types";

const ROLE_OPTIONS: TaskRole[] = ["fe", "be"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  // 保存成功后回传最新 task、父组件 setTask 刷新
  onSaved: (task: Task) => void;
}

export const EditTaskDialog = ({ open, onOpenChange, task, onSaved }: Props) => {
  // 角色（fe/be）
  const [role, setRole] = useState<TaskRole>(task.role);
  // 任务标题（必填）
  const [title, setTitle] = useState(task.title);
  // 飞书项目链接（选填、空=清空）
  const [feishuStoryUrl, setFeishuStoryUrl] = useState(task.feishuStoryUrl ?? "");
  // per-repo「已有工作分支」草稿（key=repoPath）
  const [featureBranches, setFeatureBranches] = useState<
    Record<string, string>
  >(task.repoFeatureBranches ?? {});
  // 提交锁、防连点
  const [submitting, setSubmitting] = useState(false);

  // task ref 化：让「打开时初始化」effect 只依赖 open、不依赖 task——
  // 否则 dialog 开着时 task 因 SSE 更新（引用变）会重跑 effect、把用户正在编辑的草稿重置（advance-dialog 同款教训）
  const taskRef = useRef(task);
  taskRef.current = task;

  // 打开瞬间从「当时的 task」灌初始值
  useEffect(() => {
    if (!open) return;
    const t = taskRef.current;
    setRole(t.role);
    setTitle(t.title);
    setFeishuStoryUrl(t.feishuStoryUrl ?? "");
    setFeatureBranches(t.repoFeatureBranches ?? {});
    setSubmitting(false);
  }, [open]);

  // 仓库名展示（featureBranches / 只读列表用）：settings.repos 查、查不到用路径尾段
  // mount 时读一次 settings.repos 即可（编辑 task 期间不会同时改设置页仓库名）
  const repoNameOf = useMemo(() => {
    const repos = getSettings().repos;
    return (p: string) =>
      repos.find((r) => r.path === p)?.name ??
      p.split("/").filter(Boolean).pop() ??
      p;
  }, []);

  const canSubmit = title.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 收集 per-repo 已有工作分支（限定当前 repoPaths、去空）；后端还会再清洗一道
      const cleanedBranches: Record<string, string> = {};
      for (const p of task.repoPaths) {
        const b = featureBranches[p]?.trim();
        if (b) cleanedBranches[p] = b;
      }
      const updated = await updateTaskFields(task.id, {
        title: title.trim(),
        role,
        feishuStoryUrl: feishuStoryUrl.trim() || null,
        repoFeatureBranches:
          Object.keys(cleanedBranches).length > 0 ? cleanedBranches : null,
      });
      onSaved(updated);
      onOpenChange(false);
      toast.success("任务已更新");
    } catch (err) {
      toast.error(`更新失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑任务</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          {/* 角色 */}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-role">角色</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as TaskRole)}
            >
              <SelectTrigger id="edit-role" className="w-full">
                <SelectValue>{TASK_ROLE_LABEL[role]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {TASK_ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              改完下次推进 action 时 AI 按新角色视角跑
            </p>
          </div>

          {/* 标题 */}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-title">
              任务标题 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：需求标题"
            />
          </div>

          {/* 飞书链接 */}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-story">飞书项目链接</Label>
            <Input
              id="edit-story"
              value={feishuStoryUrl}
              onChange={(e) => setFeishuStoryUrl(e.target.value)}
              placeholder="https://project.feishu.cn/<space>/story/detail/..."
            />
            <p className="text-xs text-muted-foreground">
              已建的 git 分支名不会改（建时已固化）、只影响之后新建的
            </p>
          </div>

          {/* 仓库：只读展示（不可改） */}
          <div className="grid gap-1.5">
            <Label>
              目标仓库{" "}
              <span className="text-xs text-muted-foreground">（不可改）</span>
            </Label>
            {task.repoPaths.length > 0 ? (
              <div className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2">
                {task.repoPaths.map((p) => (
                  <div
                    key={p}
                    className="flex min-w-0 items-baseline gap-2 text-xs"
                    title={p}
                  >
                    <span className="shrink-0 font-medium text-foreground/80">
                      {repoNameOf(p)}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {p}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyHint size="sm">未绑仓库</EmptyHint>
            )}
          </div>

          {/* 已有工作分支：per-repo（仅有仓时展示） */}
          {task.repoPaths.length > 0 && (
            <div className="grid gap-1.5">
              <Label>已有工作分支（选填）</Label>
              <div className="grid gap-2">
                {task.repoPaths.map((p) => (
                  <div key={p} className="flex items-center gap-2">
                    <span
                      className="w-28 shrink-0 truncate text-sm text-muted-foreground"
                      title={repoNameOf(p)}
                    >
                      {repoNameOf(p)}
                    </span>
                    <Input
                      value={featureBranches[p] ?? ""}
                      onChange={(e) =>
                        setFeatureBranches((prev) => ({
                          ...prev,
                          [p]: e.target.value,
                        }))
                      }
                      placeholder="留空自动建 feature/…"
                      className="min-w-0 flex-1"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
