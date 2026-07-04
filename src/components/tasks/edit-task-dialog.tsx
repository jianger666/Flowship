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
 *   - MCP 开关（走 TaskMcpPanel）、上下文 doc（走 ContextDocsPanel）——详情页已有各自面板
 *
 * 仓库（V0.6.28）：**只允许追加、不允许移除**——同事实测场景「做着做着发现还依赖另一个仓」；
 *   删仓涉及已建分支 / MR 残留引用、边界多收益低、不做。已绑仓只读展示、新仓走下方 MultiSelect、
 *   生效于下一个 action（正在跑的 run cwd 已绑死）；新仓的 per-repo 快照（线上 / 测试 / dev 分支、
 *   命名模板、check 命令）提交时从 settings 现取随行传（跟建 task 同款逻辑）。
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
import { Combobox } from "@/components/ui/combobox";
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
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { resolveBranchTemplate } from "@/lib/branch-template";
import { getSettings } from "@/lib/local-store";
import { updateTaskFields } from "@/lib/task-store";
import {
  TASK_ROLE_LABEL,
  type RepoConfig,
  type Task,
  type TaskRole,
} from "@/lib/types";

const ROLE_OPTIONS: TaskRole[] = ["fe", "be", "adaptive"];

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
  // V0.6.28：本次要追加的仓库路径（只增不删、已绑仓不在此列表）
  const [addRepos, setAddRepos] = useState<string[]>([]);
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
    setAddRepos([]);
    setSubmitting(false);
  }, [open]);

  // settings 快照（追加候选 / 仓名展示 / 提交时取新仓分支快照都用它）
  // mount 时读一次即可（编辑 task 期间不会同时改设置页仓库配置）
  const settings = useMemo(() => getSettings(), []);
  const settingsRepos = settings.repos;

  // 仓库名展示（featureBranches / 只读列表用）：settings.repos 查、查不到用路径尾段
  const repoNameOf = useMemo(() => {
    return (p: string) =>
      settingsRepos.find((r) => r.path === p)?.name ??
      p.split("/").filter(Boolean).pop() ??
      p;
  }, [settingsRepos]);

  // 追加候选 = settings 里配过、且还没绑进本 task 的仓
  const addableRepos = useMemo(
    () => settingsRepos.filter((r) => !task.repoPaths.includes(r.path)),
    [settingsRepos, task.repoPaths],
  );

  // v0.9.11：分支候选（已绑仓 + 本次追加仓、「已有工作分支」Combobox 用）
  const branchMap = useRepoBranches([...task.repoPaths, ...addRepos]);

  const canSubmit = title.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 收集 per-repo 已有工作分支（已绑仓 + 本次追加仓、去空）；后端还会再清洗一道
      const cleanedBranches: Record<string, string> = {};
      for (const p of [...task.repoPaths, ...addRepos]) {
        const b = featureBranches[p]?.trim();
        if (b) cleanedBranches[p] = b;
      }

      // V0.6.28：新追加仓的 per-repo 快照（跟 new-task-dialog 建 task 时同款逻辑）——
      // settings 在 localStorage、server 读不到、必须 client 取好随行传
      const addRepoBaseBranches: Record<string, string> = {};
      const addRepoTestBranches: Record<string, string> = {};
      const addRepoDevBranches: Record<string, string> = {};
      const addRepoBranchTemplates: Record<string, string> = {};
      for (const p of addRepos) {
        const repo = settingsRepos.find((r) => r.path === p);
        const online = repo?.onlineBranch?.trim();
        if (online) addRepoBaseBranches[p] = online;
        const tb = repo?.testBranch?.trim();
        if (tb) addRepoTestBranches[p] = tb;
        const db = repo?.devBranch?.trim();
        if (db) addRepoDevBranches[p] = db;
        addRepoBranchTemplates[p] = resolveBranchTemplate(
          repo?.branchTemplate,
          settings.branchTemplate,
        );
      }

      const updated = await updateTaskFields(task.id, {
        title: title.trim(),
        role,
        feishuStoryUrl: feishuStoryUrl.trim() || null,
        repoFeatureBranches:
          Object.keys(cleanedBranches).length > 0 ? cleanedBranches : null,
        ...(addRepos.length > 0
          ? {
              addRepoPaths: addRepos,
              addRepoBaseBranches,
              addRepoTestBranches,
              addRepoDevBranches,
              addRepoBranchTemplates,
            }
          : {}),
      });
      onSaved(updated);
      onOpenChange(false);
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
            <Label htmlFor="edit-role" required>
              角色
            </Label>
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
          </div>

          {/* 标题 */}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-title" required>
              任务标题
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
          </div>

          {/* 仓库：已绑只读（不可移除）、下方可追加 */}
          <div className="grid gap-1.5">
            <Label>
              目标仓库{" "}
              <span className="text-xs text-muted-foreground">
                （已绑不可移除）
              </span>
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

          {/* V0.6.28：追加仓库（只增不删、下一个 action 生效） */}
          {addableRepos.length > 0 && (
            <div className="grid gap-1.5">
              <Label>追加仓库</Label>
              <MultiSelect<RepoConfig>
                options={addableRepos}
                value={addRepos}
                onChange={setAddRepos}
                getKey={(r) => r.path}
                placeholder="选填、下一个 action 生效"
                renderOption={(r) => (
                  <>
                    <span className="block w-full truncate font-medium">
                      {r.name}
                    </span>
                    <span className="block w-full truncate text-xs text-muted-foreground">
                      {r.path}
                    </span>
                  </>
                )}
              />
            </div>
          )}

          {/* 已有工作分支：per-repo（已绑仓 + 本次追加仓）。
              v0.9.11 换 Combobox：候选自动拉该仓本地 + 远端分支、可搜索、缺分支可手填；非 git 禁用 */}
          {task.repoPaths.length + addRepos.length > 0 && (
            <div className="grid gap-1.5">
              <Label>已有工作分支（选填）</Label>
              <div className="grid gap-2">
                {[...task.repoPaths, ...addRepos].map((p) => {
                  const entry = branchMap[p];
                  return (
                    <div key={p} className="flex items-center gap-2">
                      <span
                        className="w-28 shrink-0 truncate text-sm text-muted-foreground"
                        title={repoNameOf(p)}
                      >
                        {repoNameOf(p)}
                      </span>
                      <Combobox
                        value={featureBranches[p] ?? ""}
                        onValueChange={(v) =>
                          setFeatureBranches((prev) => ({ ...prev, [p]: v }))
                        }
                        options={entry?.branches ?? []}
                        loading={!entry}
                        disabled={!entry?.isRepo}
                        placeholder={
                          entry?.isRepo === false
                            ? "非 git 仓库"
                            : "留空自动建 feature/…"
                        }
                        className="min-w-0 flex-1"
                      />
                    </div>
                  );
                })}
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
