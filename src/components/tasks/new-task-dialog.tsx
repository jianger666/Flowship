"use client";

/**
 * 新建任务 Dialog（结构化任务专用）
 *
 * 只建 mode="task"：走 plan → build → review 完整流。
 * 字段：title / repos / feishuStoryUrl / role 必填 + 模型 + MCP（飞书 MCP 是命脉、缺了不让建）。
 *
 * 自由对话已独立成一键入口（侧栏 / 首页「新建对话」→ useNewChat）、不再塞进本表单的 mode 切换。
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plug, Plus } from "lucide-react";
import { toast } from "sonner";
import type { McpServerConfig } from "@cursor/sdk";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
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
import { useCursorMcp } from "@/hooks/use-cursor-mcp";
import { useModels } from "@/hooks/use-models";
import { useRepoBranches } from "@/hooks/use-repo-branches";
import { resolveBranchTemplate } from "@/lib/branch-template";
import { getSettings, recordModelUsage } from "@/lib/local-store";
import { SettingsLink, settingsUrl } from "@/lib/settings-link";
import { createTask } from "@/lib/task-store";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import {
  TASK_ROLE_LABEL,
  type ModelSelection,
  type RepoConfig,
  type Task,
  type TaskRole,
} from "@/lib/types";

const ROLE_OPTIONS: TaskRole[] = ["fe", "be", "adaptive"];

// task 模式创建强制依赖的飞书 MCP——按域名认、不认 key 名（别人把 key 叫 lark-mcp、
// my-feishu 也能识别、只要它连的是飞书）。整个「需求 → PR」流程的命脉：plan 拉 story /
// build 摸需求 / ship @ 测试人员全靠它。chat 模式不强制（自由对话不依赖飞书）。
// 两种配法都兼容：① url 远程型（url 含域名）② stdio 命令型（域名藏在 command/args/env、
//   如 npx @lark-project/mcp --domain https://project.feishu.cn）。
const REQUIRED_FEISHU_MCP: { host: string; label: string }[] = [
  { host: "mcp.feishu.cn", label: "飞书 MCP" },
  { host: "project.feishu.cn", label: "飞书项目 MCP" },
];

// 把单个 MCP server 配置里「所有可能出现飞书域名的字符串」拼成一段、供域名 substring 匹配。
// - url 远程型：url 字段（如 https://project.feishu.cn/mcp_server/v1）
// - stdio 命令型：command + args + env 值都扫（域名常作 --domain 参数塞 args、token 塞 env）
const collectMcpHaystack = (cfg: McpServerConfig): string => {
  const parts: string[] = [];
  if ("url" in cfg && typeof cfg.url === "string") parts.push(cfg.url);
  if ("command" in cfg && typeof cfg.command === "string") {
    parts.push(cfg.command);
  }
  if ("args" in cfg && Array.isArray(cfg.args)) {
    for (const a of cfg.args) {
      if (typeof a === "string") parts.push(a);
    }
  }
  if ("env" in cfg && cfg.env && typeof cfg.env === "object") {
    for (const v of Object.values(cfg.env)) parts.push(String(v));
  }
  return parts.join("\n");
};

interface Props {
  onCreated: (task: Task) => void;
  // 自定义触发元素（侧栏要全宽「+ 新建任务」按钮）；不传用默认「新建」按钮
  trigger?: React.ReactElement;
}

export const NewTaskDialog = ({ onCreated, trigger }: Props) => {
  // dialog 开关
  const [open, setOpen] = useState(false);
  // V0.4 任务角色：决定 agent 以哪种视角读 story / 出方案
  // V0.6.12：不默认前端、初始空——强制用户主动选、避免后端同学顺手提交成前端
  const [role, setRole] = useState<TaskRole | "">("");
  // 任务标题（必填）
  const [title, setTitle] = useState("");
  // 目标仓库（必填至少 1 个）
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  // 飞书项目链接（必填）
  const [feishuStoryUrl, setFeishuStoryUrl] = useState("");
  // V0.6.3：per-repo「已有工作分支」覆盖（key=repoPath、用户已自己建分支做了一部分时填、build 复用不另建）
  const [featureBranches, setFeatureBranches] = useState<
    Record<string, string>
  >({});
  // 仓库下拉源、open 时从 settings 同步过来
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  // 用户配置的 MCP server 列表（从 Cursor ~/.cursor/mcp.json 读、open 时拉）
  // servers：完整配置（含 url）、飞书 MCP 校验靠它读域名；mcpLoading：首拉中、
  // 用来避免「列表还没回来就误判飞书 MCP 缺失」闪一下红
  const {
    names: availableMcp,
    servers: mcpServers,
    loading: mcpLoading,
  } = useCursorMcp(open);
  // 用户在弹窗里勾掉的 MCP（黑名单）、open 时初始化为设置页「常用」快照、可临时增减
  const [disabledMcp, setDisabledMcp] = useState<string[]>([]);
  // MCP 区折叠态、默认收起
  const [mcpExpanded, setMcpExpanded] = useState(false);
  // V0.10 逃生口：勾了直接在原仓库运行（不建隔离 worktree）、默认不勾 = 隔离
  const [runInRepo, setRunInRepo] = useState(false);
  // 任务级模型选择（含 thinking/effort/context 等 params）；默认 = settings.defaultModel
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  // 默认模型 id（仅用于「已切到非默认模型」提示判断）
  const [defaultModelId, setDefaultModelId] = useState<string>("");
  // 模型列表（异步拉）
  const {
    models: availableModels,
    loading: modelsLoading,
    fetchModels,
  } = useModels();
  // v0.9.11：已选仓的分支候选（「已有工作分支」Combobox 用）——undefined=拉取中、isRepo=false=非 git
  const branchMap = useRepoBranches(repoPaths);

  // 打开时读 settings.repos + 拉模型（MCP 候选源走 useCursorMcp）
  useEffect(() => {
    if (!open) return;
    const s = getSettings();
    setRepos(s.repos);
    // V0.6.5：默认带上设置页配的「常用 MCP」黑名单快照、用户可在下面临时增减
    setDisabledMcp(s.disabledMcpServers ?? []);
    setDefaultModelId(s.defaultModel?.id ?? "");
    setPickedModel(s.defaultModel?.id?.trim() ? s.defaultModel : { id: "" });
    if (s.apiKey?.trim() && availableModels.length === 0 && !modelsLoading) {
      void fetchModels(s.apiKey);
    }
  }, [open, fetchModels, availableModels.length, modelsLoading]);

  // 关闭时重置
  useEffect(() => {
    if (open) return;
    setRole("");
    setTitle("");
    setRepoPaths([]);
    setFeishuStoryUrl("");
    setFeatureBranches({});
    setDisabledMcp([]);
    setMcpExpanded(false);
    setRunInRepo(false);
    setPickedModel({ id: "" });
    setDefaultModelId("");
  }, [open]);

  const [submitting, setSubmitting] = useState(false);

  // 「未配置 or 本次被关掉」的飞书 MCP——非空则禁止创建（飞书是任务命脉）。
  // 判定：启用的 server（key 不在本次黑名单）的配置里、有没有命中飞书域名；没命中 = 缺。
  //   配置扫 url + command/args/env（兼容 url 远程型 + stdio 命令型两种配法）。
  // mcpLoading 时先按「不缺」处理、避免列表没拉回来就误报缺失闪一下红。
  const missingFeishuMcp = useMemo(() => {
    if (mcpLoading) return [];
    const enabledHaystacks = Object.entries(mcpServers)
      .filter(([key]) => !disabledMcp.includes(key))
      .map(([, cfg]) => collectMcpHaystack(cfg));
    return REQUIRED_FEISHU_MCP.filter(
      (m) => !enabledHaystacks.some((h) => h.includes(m.host)),
    );
  }, [mcpLoading, mcpServers, disabledMcp]);

  // 必填 title/repos/feishu/role + 飞书 MCP 齐全才放行
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!title.trim()) return false;
    if (repoPaths.length === 0) return false;
    if (!feishuStoryUrl.trim()) return false;
    if (!role) return false; // V0.6.12：角色必选、不再默认前端
    if (mcpLoading) return false; // MCP 列表还没拉回来、等确认飞书依赖再放行
    if (missingFeishuMcp.length > 0) return false; // 飞书 MCP 缺失、不让建
    return true;
  }, [
    submitting,
    title,
    repoPaths,
    feishuStoryUrl,
    role,
    mcpLoading,
    missingFeishuMcp,
  ]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const settings = getSettings();
      // pickedModel 已含完整 params（ModelSelect 维护）、直接用；没选 id 留 undefined 走默认
      const model = pickedModel.id?.trim() ? pickedModel : undefined;
      if (model) recordModelUsage(model); // 常用模型计数（建任务是一次真实使用）

      // V0.6.3：从 settings 查选中仓的「线上分支」、快照进 task
      //   （settings 在 localStorage、server 读不到、故建 task 时固化、之后 build 用这份）
      const repoBaseBranches: Record<string, string> = {};
      for (const p of repoPaths) {
        const branch = settings.repos
          .find((r) => r.path === p)
          ?.onlineBranch?.trim();
        if (branch) repoBaseBranches[p] = branch;
      }

      // V0.6.3：per-repo「已有工作分支」覆盖（用户填了才带、key 限定已选仓、去空）
      //   填了 build 复用这个分支（他的代码都在）、不另建算法名分支
      const repoFeatureBranches: Record<string, string> = {};
      for (const p of repoPaths) {
        const b = featureBranches[p]?.trim();
        if (b) repoFeatureBranches[p] = b;
      }

      // V0.6.7：从 settings.repos 快照每仓的测试分支 / dev 分支 / 有效命名模板
      //   （settings 在 localStorage、server 读不到、故建 task 时固化、之后 build / ship 用这份）
      const repoTestBranches: Record<string, string> = {};
      const repoDevBranches: Record<string, string> = {};
      const repoBranchTemplates: Record<string, string> = {};
      for (const p of repoPaths) {
        const repo = settings.repos.find((r) => r.path === p);
        const tb = repo?.testBranch?.trim();
        if (tb) repoTestBranches[p] = tb;
        const db = repo?.devBranch?.trim();
        if (db) repoDevBranches[p] = db;
        // 有效模板 = 仓覆盖 ?? 全局 ?? 内置默认（总有值、固化进 task、build 直接用不再回退 settings）
        repoBranchTemplates[p] = resolveBranchTemplate(
          repo?.branchTemplate,
          settings.branchTemplate,
        );
      }

      const task = await createTask({
        mode: "task",
        // canSubmit 已保证 role 非空
        role: role || undefined,
        title: title.trim(),
        repoPaths,
        feishuStoryUrl: feishuStoryUrl.trim() || undefined,
        repoBaseBranches:
          Object.keys(repoBaseBranches).length > 0
            ? repoBaseBranches
            : undefined,
        repoFeatureBranches:
          Object.keys(repoFeatureBranches).length > 0
            ? repoFeatureBranches
            : undefined,
        repoTestBranches:
          Object.keys(repoTestBranches).length > 0
            ? repoTestBranches
            : undefined,
        repoDevBranches:
          Object.keys(repoDevBranches).length > 0 ? repoDevBranches : undefined,
        repoBranchTemplates:
          Object.keys(repoBranchTemplates).length > 0
            ? repoBranchTemplates
            : undefined,
        disabledMcpServers: disabledMcp.length > 0 ? disabledMcp : undefined,
        // V0.10：默认隔离 worktree、勾了逃生口才直跑原仓库
        isolateWorktree: !runInRepo,
        model,
      });
      setOpen(false);
      onCreated(task);
    } catch (err) {
      toast.error(`创建失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // disablePointerDismissal：点弹窗外不关（用户实测：关「目标仓库」下拉要点空白、
    // 一点把整个弹窗带没了、表单草稿全丢）；Esc / X / 取消仍可关
    <Dialog open={open} onOpenChange={setOpen} disablePointerDismissal>
      <DialogTrigger
        render={
          trigger ?? (
            <Button>
              <Plus />
              新建
            </Button>
          )
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 标题 */}
          <div className="grid gap-1.5">
            <Label htmlFor="t-title" required>
              任务标题
            </Label>
            <Input
              id="t-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：需求标题"
              autoFocus
            />
          </div>

          {/* 仓库 */}
          <div className="grid gap-1.5">
            <Label required>目标仓库</Label>
            {repos.length > 0 ? (
              <MultiSelect<RepoConfig>
                options={repos}
                value={repoPaths}
                onChange={setRepoPaths}
                getKey={(r) => r.path}
                placeholder="选择仓库（可多选）"
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
                      <span className="shrink-0 font-medium">
                        已选 {selected.length} 个
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {selected.map((r) => r.name).join(" + ")}
                      </span>
                    </>
                  );
                }}
              />
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
            <Label htmlFor="t-role" required>
              角色
            </Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as TaskRole)}
            >
              <SelectTrigger id="t-role" className="w-full">
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

          {/* 飞书项目链接 */}
          <div className="grid gap-1.5">
            <Label htmlFor="t-story" required>
              飞书项目链接
            </Label>
            <Input
              id="t-story"
              value={feishuStoryUrl}
              onChange={(e) => setFeishuStoryUrl(e.target.value)}
              placeholder="https://project.feishu.cn/<space>/story/detail/..."
            />
          </div>

          {/* V0.6.3：per-repo「已有工作分支」覆盖——已自己建分支做了一部分时填、build 复用不另建。
              v0.9.11 换 Combobox：候选自动拉该仓本地 + 远端分支、可搜索、缺分支可手填；非 git 禁用 */}
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
              <p className="text-xs text-muted-foreground">
                已自己建分支做了一部分？填进来、build 直接复用、不另建
              </p>
            </div>
          )}

          {/* 模型选择（两种模式都展示） */}
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
            {pickedModel.id &&
              defaultModelId &&
              pickedModel.id !== defaultModelId && (
                <p className="text-xs text-amber-500">已切到非默认模型</p>
              )}
          </div>

          {/* MCP 开关：默认全开 + 默认折叠 */}
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
                  （{availableMcp.length - disabledMcp.length}/
                  {availableMcp.length}）
                </span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  默认全开、不需要的关掉
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

          {/* V0.10 逃生口：默认每 task 建隔离 worktree、特殊场景（想直接看着原仓库改）勾这个 */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="t-run-in-repo"
              checked={runInRepo}
              onCheckedChange={setRunInRepo}
            />
            <Label htmlFor="t-run-in-repo" className="cursor-pointer font-normal">
              直接在原仓库运行（不隔离工作区、并行任务会互相影响）
            </Label>
          </div>
        </div>

        {/* 缺飞书 MCP 时的硬提示——飞书是「需求 → PR」命脉、缺了按钮置灰不让建 */}
        {missingFeishuMcp.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            创建任务需先启用{" "}
            <strong>{missingFeishuMcp.map((m) => m.label).join("、")}</strong>
            （
            <SettingsLink focus="mcp" className="text-destructive">
              去设置页启用
            </SettingsLink>
            ）
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
