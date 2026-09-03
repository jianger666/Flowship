"use client";

/**
 * 编辑任务 Dialog（V0.6.6）
 *
 * 详情页「编辑」按钮打开、改建任务时填的软配置字段：
 *   标题 / 飞书链接（仅需求任务可改具体 URL） / 被测业务分支（仅测试任务、per-repo）
 *
 * 刻意不在此改：
 *   - 模型 model（SDK Run 启动时绑定的硬约束、改了只能换新 agent、要换走推进 dialog 的模型选择）
 *   - mode（task/chat 是两套通路、切了等于换任务）
 *   - MCP 开关（走 TaskMcpPanel）、上下文 doc（走 ContextDocsPanel）——详情页已有各自面板
 *   - 日常/需求身份（有无飞书链接）：isolateWorktree 创建时定死，禁止有↔无切换
 *
 * 仓库：可追加也可解绑（至少留 1 个）。解绑不删 feature 分支 / 不关 MR，只拆该仓
 *   isolation worktree；仓一变下一个 Action 起新 agent（旧会话 cwd 已失效）。
 *   新仓的 per-repo 快照提交时从 settings 现取随行传（跟建 task 同款）。
 *
 * 副作用约定（V0.6.6 热更）：
 *   - 标题 / 飞书链接：长生 agent reused 推进时 task-runner 会 diff 启动快照、有变拼 [TASK_UPDATED] 注入告知（立即生效）
 *   - 标题 / 飞书链接：已建的 git 分支名不会改（建时已固化）、只影响之后新建的
 *   - running 时不让编辑（详情页入口禁用）、避免改了跟正在跑的不一致
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FeatureBranchesField } from "@/components/tasks/feature-branches-field";
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
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { resolveBranchTemplate } from "@/lib/branch-template";
import { getSettings } from "@/lib/local-store";
import { pathBasename, sameRepoPathList } from "@/lib/path-utils";
import { normalizeReqId, reqIdPatchValue } from "@/lib/req-id";
import { updateTaskFields } from "@/lib/task-store";
import { isTestingRequirementTask } from "@/lib/testing-task";
import type { RepoConfig, Task } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  // 保存成功后回传最新 task、父组件 setTask 刷新
  onSaved: (task: Task) => void;
}

export const EditTaskDialog = ({ open, onOpenChange, task, onSaved }: Props) => {
  const testingTask = isTestingRequirementTask(task);
  // 任务标题（必填）
  const [title, setTitle] = useState(task.title);
  // 飞书项目链接草稿：需求任务可改具体 URL；日常任务禁用（身份创建后不可有↔无）
  const [feishuStoryUrl, setFeishuStoryUrl] = useState(task.feishuStoryUrl ?? "");
  // 打开时锁定身份：有链接 = 需求任务（可改 URL、不可清空）；无链接 = 日常（不可补链接）
  const [storyUrlLockedHas, setStoryUrlLockedHas] = useState(
    !!(task.feishuStoryUrl ?? "").trim(),
  );
  // wk 需求编号草稿：回填库里存的值、没有就空着（我们不猜、不预填任何派生值）。
  // 清空并保存 = 这个 task 没有 REQ-ID（后端删字段、wk 门禁跳过）
  const [reqId, setReqId] = useState(() => normalizeReqId(task.reqId) ?? "");
  // 测试任务 per-repo 被测业务分支草稿（key=repoPath）
  const [featureBranches, setFeatureBranches] = useState<
    Record<string, string>
  >(task.repoFeatureBranches ?? {});
  // 当前选中的仓库路径（可取消、至少 1 个才能提交）
  const [selectedRepos, setSelectedRepos] = useState<string[]>(task.repoPaths);
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
    setTitle(t.title);
    setFeishuStoryUrl(t.feishuStoryUrl ?? "");
    setStoryUrlLockedHas(!!(t.feishuStoryUrl ?? "").trim());
    setReqId(normalizeReqId(t.reqId) ?? "");
    setFeatureBranches(t.repoFeatureBranches ?? {});
    setSelectedRepos([...t.repoPaths]);
    setSubmitting(false);
  }, [open]);

  // settings 快照（仓选项 / 仓名展示 / 提交时取新仓分支快照都用它）
  // mount 时读一次即可（编辑 task 期间不会同时改设置页仓库配置）
  const settings = useMemo(() => getSettings(), []);
  const settingsRepos = settings.repos;

  // 仓库名展示：settings.repos 查、查不到用路径尾段
  const repoNameOf = useMemo(() => {
    return (p: string) =>
      settingsRepos.find((r) => r.path === p)?.name ?? pathBasename(p) ?? p;
  }, [settingsRepos]);

  // 选项 = 设置页仓库 + 已选但不在设置里的（仓从设置删了仍绑着）
  const repoOptions = useMemo(() => {
    const extras = selectedRepos
      .filter((p) => !settingsRepos.some((r) => r.path === p))
      .map((p) => ({ name: repoNameOf(p), path: p }) as RepoConfig);
    return [...settingsRepos, ...extras];
  }, [settingsRepos, selectedRepos, repoNameOf]);

  // v0.9.11：分支候选（测试任务 Combobox 用）
  const branchMap = useRepoBranches(testingTask ? selectedRepos : []);

  // 需求任务改链接时不可清空（身份闸门）；日常任务不传 feishuStoryUrl；任务至少 1 仓
  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    selectedRepos.length > 0 &&
    (!storyUrlLockedHas || feishuStoryUrl.trim().length > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 测试任务：收集 per-repo 被测业务分支（当前选中仓、去空）
      const cleanedBranches: Record<string, string> = {};
      if (testingTask) {
        for (const p of selectedRepos) {
          const b = featureBranches[p]?.trim();
          if (b) cleanedBranches[p] = b;
        }
      }

      // 新追加仓的 per-repo 快照（跟 new-task-dialog 建 task 时同款）——
      // settings 在 localStorage、server 读不到、必须 client 取好随行传
      // 顺序跟 MultiSelect 的 selectedRepos 走（用户重排要生效），不要按旧 repoPaths 过滤
      const seen = new Set<string>();
      const newRepoPaths: string[] = [];
      for (const p of selectedRepos) {
        if (!seen.has(p)) {
          seen.add(p);
          newRepoPaths.push(p);
        }
      }
      const reposChanged = !sameRepoPathList(task.repoPaths, newRepoPaths);
      const original = new Set(task.repoPaths);
      const added = newRepoPaths.filter((p) => !original.has(p));
      const addRepoBaseBranches: Record<string, string> = {};
      const addRepoTestBranches: Record<string, string> = {};
      const addRepoDevBranches: Record<string, string> = {};
      const addRepoBranchTemplates: Record<string, string> = {};
      for (const p of added) {
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
        // 日常任务不传链接字段；需求任务只传非空 URL（禁止清空）
        ...(storyUrlLockedHas
          ? { feishuStoryUrl: feishuStoryUrl.trim() }
          : {}),
        // 需求编号：填了什么存什么、清空落 null（后端删字段 = 这个 task 没有 REQ-ID）
        ...(storyUrlLockedHas ? { reqId: reqIdPatchValue(reqId) } : {}),
        ...(testingTask
          ? {
              repoFeatureBranches:
                Object.keys(cleanedBranches).length > 0
                  ? cleanedBranches
                  : null,
            }
          : {}),
        ...(reposChanged
          ? {
              repoPaths: newRepoPaths,
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
    // disablePointerDismissal：带草稿表单，点外误关会丢编辑内容；Esc / X / 取消仍可关
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>任务基本信息</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
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

          {/* 飞书链接：需求任务可改具体 URL、不可清空；日常任务禁用（身份创建后定死） */}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-story">飞书项目链接</Label>
            <Input
              id="edit-story"
              value={feishuStoryUrl}
              onChange={(e) => setFeishuStoryUrl(e.target.value)}
              disabled={!storyUrlLockedHas}
              placeholder={
                storyUrlLockedHas
                  ? "https://project.feishu.cn/<space>/story/detail/..."
                  : "日常任务无飞书链接"
              }
            />
            <p className="text-xs text-muted-foreground">
              日常/需求身份创建后不可改、需要请新建任务
            </p>
          </div>

          {/* wk 需求编号：只对需求任务有意义（日常任务推进面板不出 wk 流程组） */}
          {storyUrlLockedHas && !testingTask && (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-req-id">REQ-ID</Label>
              <Input
                id="edit-req-id"
                value={reqId}
                onChange={(e) => setReqId(e.target.value)}
                placeholder="暂无 REQ-ID、可后补"
              />
            </div>
          )}

          {/* 仓库：可取消、至少留 1 个 */}
          <div className="grid gap-1.5">
            <Label required>目标仓库</Label>
            {repoOptions.length > 0 ? (
              <MultiSelect<RepoConfig>
                options={repoOptions}
                value={selectedRepos}
                onChange={(next) => {
                  setSelectedRepos(next);
                  setFeatureBranches((prev) => {
                    const keep = new Set(next);
                    const cleaned: Record<string, string> = {};
                    for (const [k, v] of Object.entries(prev)) {
                      if (keep.has(k)) cleaned[k] = v;
                    }
                    return cleaned;
                  });
                }}
                getKey={(r) => r.path}
                invalid={selectedRepos.length === 0}
                placeholder="请选择"
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
            ) : (
              <EmptyHint size="sm">设置里还没有仓库</EmptyHint>
            )}
          </div>

          {/* 被测业务分支：仅测试任务展示（per-repo、当前选中仓） */}
          {testingTask && selectedRepos.length > 0 && (
            <FeatureBranchesField
              repoPaths={selectedRepos}
              repoNameOf={repoNameOf}
              featureBranches={featureBranches}
              onChange={setFeatureBranches}
              branchMap={branchMap}
              hint="补上后从下一个 Action 起生效；留空时 AI 只把当前仓库作为结构参考，不视为需求实现"
            />
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
