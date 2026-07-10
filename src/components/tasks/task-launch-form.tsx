"use client";

/**
 * 任务启动表单（V0.14、原 NewTaskDialog 的表单核心内联成页面组件）
 *
 * V0.14 起任务只从飞书工作项进（用户拍板砍「新建任务」入口）：
 * 看板点工作项 → 预览页（工作项详情 + 本表单）→ 启动 = 创建任务并开跑。
 *
 * 零操作设计（解「不选仓库就卡住」的痛点）：
 * - 仓库 / 角色预填「上次启动用的」（localStorage 记忆）、90% 场景直接点启动
 * - 真缺仓库时启动置灰 + 琥珀高亮引导（卡点可见、不是谜题）
 * - 标题预填工作项名（可改）、飞书链接来自工作项（不可改）
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plug, Rocket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Label } from "@/components/ui/label";
import { ModelSelect } from "@/components/ui/model-select";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useModels } from "@/hooks/use-models";
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { resolveBranchTemplate } from "@/lib/branch-template";
import { getSettings, recordModelUsage } from "@/lib/local-store";
import { settingsUrl } from "@/lib/settings-link";
import { createTask } from "@/lib/task-store";

import {
  TASK_ROLE_LABEL,
  TASK_ROLES,
  type ModelSelection,
  type RepoConfig,
  type Task,
  type TaskRole,
} from "@/lib/types";

const ROLE_OPTIONS: readonly TaskRole[] = TASK_ROLES;

// 上次启动配置的记忆 key（仓库组合 + 角色——下次预填、零操作启动）
const LAST_LAUNCH_KEY = "feaiflow.lastLaunch.v1";

interface LastLaunch {
  repoPaths?: string[];
  role?: TaskRole;
}

const readLastLaunch = (): LastLaunch => {
  try {
    return JSON.parse(localStorage.getItem(LAST_LAUNCH_KEY) ?? "{}") as LastLaunch;
  } catch {
    return {};
  }
};

interface Props {
  /** 工作项名（标题预填、可改） */
  initialTitle: string;
  /** 工作项详情页 URL（固定带入 feishuStoryUrl、不可改） */
  feishuStoryUrl: string;
  onCreated: (task: Task) => void;
}

export const TaskLaunchForm = ({ initialTitle, feishuStoryUrl, onCreated }: Props) => {
  // 任务标题（预填工作项名、可改）
  const [title, setTitle] = useState(initialTitle);
  // 角色（预填上次的）
  const [role, setRole] = useState<TaskRole | "">("");
  // 目标仓库（预填上次的、过滤掉已从设置删除的）
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  // per-repo「已有工作分支」覆盖
  const [featureBranches, setFeatureBranches] = useState<Record<string, string>>({});
  // 仓库下拉源（settings）
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  // MCP 黑名单（默认设置页快照、可临时增减）
  const { names: availableMcp } = useCursorMcp(true);
  const [disabledMcp, setDisabledMcp] = useState<string[]>([]);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  // 逃生口：直接在原仓库运行
  const [runInRepo, setRunInRepo] = useState(false);
  // 模型（默认 settings.defaultModel）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  const [defaultModelId, setDefaultModelId] = useState("");
  const { models: availableModels, fetchModels } = useModels();
  const branchMap = useRepoBranches(repoPaths);
  const [submitting, setSubmitting] = useState(false);

  // mount：settings + 上次启动记忆预填
  useEffect(() => {
    const s = getSettings();
    setRepos(s.repos);
    setDisabledMcp(s.disabledMcpServers ?? []);
    setDefaultModelId(s.defaultModel?.id ?? "");
    setPickedModel(s.defaultModel?.id?.trim() ? s.defaultModel : { id: "" });
    const last = readLastLaunch();
    const validPaths = (last.repoPaths ?? []).filter((p) =>
      s.repos.some((r) => r.path === p),
    );
    // 只配了一个仓库时天然零操作：直接选它
    if (validPaths.length > 0) setRepoPaths(validPaths);
    else if (s.repos.length === 1) setRepoPaths([s.repos[0].path]);
    if (last.role) setRole(last.role);
    if (s.apiKey?.trim()) void fetchModels(s.apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 预填一次
  }, []);

  // initialTitle 异步到位（详情拉回来）时回填未被用户改过的标题
  useEffect(() => {
    setTitle((cur) => (cur.trim() ? cur : initialTitle));
  }, [initialTitle]);

  const canSubmit = useMemo(
    () =>
      !submitting && !!title.trim() && repoPaths.length > 0 && !!role && !!feishuStoryUrl,
    [submitting, title, repoPaths, role, feishuStoryUrl],
  );
  // 缺项引导文案（启动置灰时告诉用户差什么、防隐性卡点）
  const missingHint = useMemo(() => {
    if (!feishuStoryUrl) return "工作项链接缺失、回看板重新进入";
    if (repoPaths.length === 0) return "选个目标仓库即可启动";
    if (!role) return "选个角色即可启动";
    if (!title.trim()) return "填个任务标题即可启动";
    return null;
  }, [feishuStoryUrl, repoPaths, role, title]);

  const handleLaunch = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const settings = getSettings();
      const model = pickedModel.id?.trim() ? pickedModel : undefined;
      if (model) recordModelUsage(model);

      // 从 settings 快照选中仓的分支配置（settings 在 localStorage、server 读不到、建 task 时固化）
      const repoBaseBranches: Record<string, string> = {};
      const repoTestBranches: Record<string, string> = {};
      const repoDevBranches: Record<string, string> = {};
      const repoBranchTemplates: Record<string, string> = {};
      const repoFeatureBranches: Record<string, string> = {};
      for (const p of repoPaths) {
        const repo = settings.repos.find((r) => r.path === p);
        const ob = repo?.onlineBranch?.trim();
        if (ob) repoBaseBranches[p] = ob;
        const tb = repo?.testBranch?.trim();
        if (tb) repoTestBranches[p] = tb;
        const db = repo?.devBranch?.trim();
        if (db) repoDevBranches[p] = db;
        repoBranchTemplates[p] = resolveBranchTemplate(
          repo?.branchTemplate,
          settings.branchTemplate,
        );
        const fb = featureBranches[p]?.trim();
        if (fb) repoFeatureBranches[p] = fb;
      }

      const task = await createTask({
        mode: "task",
        role: role || undefined,
        title: title.trim(),
        repoPaths,
        feishuStoryUrl,
        repoBaseBranches:
          Object.keys(repoBaseBranches).length > 0 ? repoBaseBranches : undefined,
        repoFeatureBranches:
          Object.keys(repoFeatureBranches).length > 0 ? repoFeatureBranches : undefined,
        repoTestBranches:
          Object.keys(repoTestBranches).length > 0 ? repoTestBranches : undefined,
        repoDevBranches:
          Object.keys(repoDevBranches).length > 0 ? repoDevBranches : undefined,
        repoBranchTemplates:
          Object.keys(repoBranchTemplates).length > 0 ? repoBranchTemplates : undefined,
        disabledMcpServers: disabledMcp.length > 0 ? disabledMcp : undefined,
        isolateWorktree: !runInRepo,
        model,
      });
      // 记住这次的配置、下次预填零操作
      try {
        localStorage.setItem(
          LAST_LAUNCH_KEY,
          JSON.stringify({
            repoPaths,
            role: role || undefined,
          } satisfies LastLaunch),
        );
      } catch {
        /* 存不了不影响主流程 */
      }
      onCreated(task);
    } catch (err) {
      toast.error(`创建失败：${(err as Error).message}`);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 标题（预填工作项名、可改） */}
      <div className="grid gap-1.5">
        <Label htmlFor="l-title" required>
          任务标题
        </Label>
        <Input
          id="l-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题"
        />
      </div>

      {/* 仓库（缺项时琥珀高亮引导） */}
      <div className="grid gap-1.5">
        <Label required>目标仓库</Label>
        {repos.length > 0 ? (
          <div
            className={
              repoPaths.length === 0
                ? "rounded-md ring-1 ring-amber-500/60"
                : undefined
            }
          >
            <MultiSelect<RepoConfig>
              options={repos}
              value={repoPaths}
              onChange={setRepoPaths}
              getKey={(r) => r.path}
              placeholder="选择仓库（可多选）"
              renderOption={(r) => (
                <>
                  <span className="block w-full truncate font-medium">{r.name}</span>
                  <span className="block w-full truncate text-xs text-muted-foreground">
                    {r.path}
                  </span>
                </>
              )}
              renderTrigger={(selected) => {
                if (selected.length === 1) {
                  const r = selected[0]!;
                  return (
                    <>
                      <span className="shrink-0 font-medium">{r.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {r.path}
                      </span>
                    </>
                  );
                }
                return (
                  <>
                    <span className="shrink-0 font-medium">已选 {selected.length} 个</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {selected.map((r) => r.name).join(" + ")}
                    </span>
                  </>
                );
              }}
            />
          </div>
        ) : (
          <EmptyHint size="sm">
            还没配置仓库——
            <a
              href={settingsUrl("repos")}
              className="text-primary underline-offset-2 hover:underline"
            >
              去设置页添加
            </a>
          </EmptyHint>
        )}
      </div>

      {/* 角色 */}
      <div className="grid gap-1.5">
        <Label htmlFor="l-role" required>
          角色
        </Label>
        <Select value={role || undefined} onValueChange={(v) => v && setRole(v as TaskRole)}>
          <SelectTrigger id="l-role" className="w-full">
            <SelectValue placeholder="选择角色">
              {role ? TASK_ROLE_LABEL[role] : null}
            </SelectValue>
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

      {/* 已有工作分支（选填、已自己建分支做了一部分时填） */}
      {repoPaths.length > 0 && (
        <div className="grid gap-1.5">
          <Label>已有工作分支（选填）</Label>
          <div className="grid gap-2">
            {repoPaths.map((p) => {
              const repo = repos.find((r) => r.path === p);
              const entry = branchMap[p];
              return (
                <div key={p} className="flex items-center gap-2">
                  <span
                    className="w-28 shrink-0 truncate text-sm text-muted-foreground"
                    title={repo?.name ?? p}
                  >
                    {repo?.name ?? p}
                  </span>
                  <Combobox
                    value={featureBranches[p] ?? ""}
                    onValueChange={(v) =>
                      setFeatureBranches((prev) => ({ ...prev, [p]: v }))
                    }
                    options={entry?.branches ?? []}
                    loading={!entry}
                    disabled={!entry || (entry.isRepo === false && !entry.gitMissing)}
                    placeholder={
                      entry?.isRepo === false
                        ? entry.pathMissing
                          ? "路径不存在"
                          : entry.gitMissing
                            ? "未检测到 git、可手填分支"
                            : "非 git 仓库"
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

      {/* 模型 */}
      <div className="grid gap-1.5">
        <Label>模型</Label>
        <ModelSelect
          models={availableModels}
          selection={pickedModel}
          onChange={setPickedModel}
          variant="full"
          quickPicks
          emptyPlaceholder={
            defaultModelId
              ? `默认: ${defaultModelId}（API Key 没填、改不了）`
              : "未配模型、请先去设置页选"
          }
        />
        {pickedModel.id && defaultModelId && pickedModel.id !== defaultModelId && (
          <p className="text-xs text-amber-500">已切到非默认模型</p>
        )}
      </div>

      {/* MCP 开关（默认全开、折叠） */}
      {availableMcp.length > 0 && (
        <div className="rounded-md border bg-card">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setMcpExpanded((v) => !v)}
            className="h-auto w-full justify-start rounded-none rounded-t-md px-3 py-2 text-sm font-medium text-foreground/90"
          >
            {mcpExpanded ? <ChevronUp /> : <ChevronDown />}
            <Plug />
            <span>启用的 MCP servers</span>
            <span className="text-xs text-muted-foreground">
              （{availableMcp.length - disabledMcp.length}/{availableMcp.length}）
            </span>
          </Button>
          {mcpExpanded && (
            <div className="border-t p-3">
              <McpToggleList
                availableServers={availableMcp}
                disabled={disabledMcp}
                onChange={setDisabledMcp}
              />
            </div>
          )}
        </div>
      )}

      {/* 逃生口 */}
      <div className="flex items-center gap-2">
        <Checkbox id="l-run-in-repo" checked={runInRepo} onCheckedChange={setRunInRepo} />
        <Label htmlFor="l-run-in-repo" className="cursor-pointer font-normal">
          直接在原仓库运行（不隔离工作区、并行任务会互相影响）
        </Label>
      </div>

      {/* 启动 + 缺项引导 */}
      <div className="flex items-center gap-3">
        <Button onClick={handleLaunch} disabled={!canSubmit} className="gap-1.5">
          <Rocket className="size-4" />
          {submitting ? "创建中…" : "启动任务"}
        </Button>
        {missingHint && (
          <span className="text-xs text-amber-600 dark:text-amber-500">{missingHint}</span>
        )}
      </div>
    </div>
  );
};
