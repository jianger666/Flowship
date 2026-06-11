"use client";

/**
 * 新建任务 Dialog（V0.6.0.1 重新加 mode tab 切换）
 *
 * 顶部两选一 ModeCard：
 *   - **任务**：mode="task"、走 plan → build → review 完整流
 *     字段：title / repos / feishuStoryUrl 三必填 + role + 模型 + MCP
 *   - **自由对话**：mode="chat"、跑独立 chat-runner、UI 是简单聊天页
 *     字段：title / repos 都选填 + 模型 + MCP（不展示 role / feishu）
 *
 * V0.5 → V0.6.0.1 沿用一致：用户拍板「跟以前一样」、自由对话独立于 action 体系。
 */

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  MessageCircle,
  Plug,
  Plus,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
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
import { resolveBranchTemplate } from "@/lib/branch-template";
import { getSettings } from "@/lib/local-store";
import { createTask } from "@/lib/task-store";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import {
  TASK_ROLE_LABEL,
  type RepoConfig,
  type CheckCommand,
  type Task,
  type TaskMode,
  type TaskRole,
} from "@/lib/types";

const ROLE_OPTIONS: TaskRole[] = ["fe", "be", "adaptive"];

// task 模式创建强制依赖的飞书 MCP——按 url 域名认、不认 key 名（别人把 key 叫 lark-mcp、
// my-feishu 也能识别、只要它连的是飞书）。整个「需求 → PR」流程的命脉：plan 拉 story /
// build 摸需求 / ship @ 测试人员全靠它。chat 模式不强制（自由对话不依赖飞书）。
const REQUIRED_FEISHU_MCP: { host: string; label: string }[] = [
  { host: "mcp.feishu.cn", label: "飞书 MCP" },
  { host: "project.feishu.cn", label: "飞书项目 MCP" },
];

interface Props {
  onCreated: (task: Task) => void;
}

export const NewTaskDialog = ({ onCreated }: Props) => {
  // dialog 开关
  const [open, setOpen] = useState(false);
  // V0.6.0.1：任务模式（"task" / "chat"、对应顶部 ModeCard 切换）
  const [mode, setMode] = useState<TaskMode>("task");
  // V0.4 任务角色：决定 agent 以哪种视角读 story / 出方案（仅 task 模式显示）
  // V0.6.12：不默认前端、初始空——强制用户主动选、避免后端同学顺手提交成前端
  const [role, setRole] = useState<TaskRole | "">("");
  // 任务标题（task 模式必填；chat 模式选填、空时后端自动补「未命名对话 MM-DD HH:mm」）
  const [title, setTitle] = useState("");
  // 目标仓库（task 模式必填至少 1 个；chat 模式选填、空时 agent cwd = home）
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  // 飞书项目链接（仅 task 模式必填、chat 模式不展示）
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
  // 任务级模型 id；默认 = settings.defaultModel.id
  const [pickedModelId, setPickedModelId] = useState<string>("");
  // 默认模型 id（用来判断「选了跟默认一样就保留 params」）
  const [defaultModelId, setDefaultModelId] = useState<string>("");
  // 模型列表（异步拉）
  const {
    models: availableModels,
    loading: modelsLoading,
    fetchModels,
  } = useModels();

  // 打开时读 settings.repos + 拉模型（MCP 候选源走 useCursorMcp）
  useEffect(() => {
    if (!open) return;
    const s = getSettings();
    setRepos(s.repos);
    // V0.6.5：默认带上设置页配的「常用 MCP」黑名单快照、用户可在下面临时增减
    setDisabledMcp(s.disabledMcpServers ?? []);
    const defaultId = s.defaultModel?.id ?? "";
    setDefaultModelId(defaultId);
    setPickedModelId(defaultId);
    if (s.apiKey?.trim() && availableModels.length === 0 && !modelsLoading) {
      void fetchModels(s.apiKey);
    }
  }, [open, fetchModels, availableModels.length, modelsLoading]);

  // 关闭时重置
  useEffect(() => {
    if (open) return;
    setMode("task");
    setRole("");
    setTitle("");
    setRepoPaths([]);
    setFeishuStoryUrl("");
    setFeatureBranches({});
    setDisabledMcp([]);
    setMcpExpanded(false);
    setPickedModelId("");
    setDefaultModelId("");
  }, [open]);

  const [submitting, setSubmitting] = useState(false);

  // task 模式下「未配置 or 本次被关掉」的飞书 MCP——非空则禁止创建（飞书是 task 命脉）。
  // 判定：启用的 server（key 不在本次黑名单）里、有没有 url 命中飞书域名；没命中 = 缺。
  // mcpLoading 时先按「不缺」处理、避免列表没拉回来就误报缺失闪一下红。
  const missingFeishuMcp = useMemo(() => {
    if (mode !== "task" || mcpLoading) return [];
    const enabledUrls = Object.entries(mcpServers)
      .filter(([key]) => !disabledMcp.includes(key))
      .map(([, cfg]) => ("url" in cfg ? cfg.url : ""))
      .filter(Boolean);
    return REQUIRED_FEISHU_MCP.filter(
      (m) => !enabledUrls.some((u) => u.includes(m.host)),
    );
  }, [mode, mcpLoading, mcpServers, disabledMcp]);

  // task 模式必填 title/repos/feishu/role + 飞书 MCP 齐全；chat 模式全选填、随便点都能提交
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (mode === "task") {
      if (!title.trim()) return false;
      if (repoPaths.length === 0) return false;
      if (!feishuStoryUrl.trim()) return false;
      if (!role) return false; // V0.6.12：角色必选、不再默认前端
      if (mcpLoading) return false; // MCP 列表还没拉回来、等确认飞书依赖再放行
      if (missingFeishuMcp.length > 0) return false; // 飞书 MCP 缺失、不让建
    }
    return true;
  }, [
    submitting,
    mode,
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
      let model;
      if (pickedModelId) {
        if (
          pickedModelId === defaultModelId &&
          settings.defaultModel?.id === pickedModelId
        ) {
          model = settings.defaultModel;
        } else {
          model = { id: pickedModelId };
        }
      }

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
      // V0.6.25：同款快照每仓的 check 命令（build 后 runner 跑、详见 types.ts CheckCommand）
      const repoTestBranches: Record<string, string> = {};
      const repoDevBranches: Record<string, string> = {};
      const repoBranchTemplates: Record<string, string> = {};
      const repoCheckCommands: Record<string, CheckCommand[]> = {};
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
        const cmds = repo?.checkCommands;
        if (cmds && cmds.length > 0) repoCheckCommands[p] = cmds;
      }

      const task = await createTask({
        mode,
        // task 模式 canSubmit 已保证 role 非空；chat 模式无角色、"" → undefined
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
        repoCheckCommands:
          Object.keys(repoCheckCommands).length > 0
            ? repoCheckCommands
            : undefined,
        disabledMcpServers: disabledMcp.length > 0 ? disabledMcp : undefined,
        model,
      });
      toast.success(mode === "chat" ? "已创建对话" : "任务已创建");
      setOpen(false);
      onCreated(task);
    } catch (err) {
      toast.error(`创建失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus />
            新建
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建{mode === "chat" ? "对话" : "任务"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 顶部模式切换：task / chat */}
          <div className="grid gap-1.5">
            <Label required>类型</Label>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceButton
                shape="card"
                selected={mode === "task"}
                onClick={() => setMode("task")}
              >
                <div className="flex items-center gap-2">
                  <Workflow className="size-4" />
                  <span className="font-medium">任务</span>
                </div>
              </ChoiceButton>
              <ChoiceButton
                shape="card"
                selected={mode === "chat"}
                onClick={() => setMode("chat")}
              >
                <div className="flex items-center gap-2">
                  <MessageCircle className="size-4" />
                  <span className="font-medium">自由对话</span>
                </div>
              </ChoiceButton>
            </div>
          </div>

          {/* 标题：task 必填、chat 选填 */}
          <div className="grid gap-1.5">
            <Label htmlFor="t-title" required={mode === "task"}>
              {mode === "chat" ? "标题（选填）" : "任务标题"}
            </Label>
            <Input
              id="t-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                mode === "chat"
                  ? "不填用「未命名对话 MM-DD HH:mm」占位"
                  : "如：需求标题"
              }
              autoFocus
            />
          </div>

          {/* 仓库：task 必填、chat 选填 */}
          <div className="grid gap-1.5">
            <Label required={mode === "task"}>
              {mode === "chat" ? "目标仓库（选填）" : "目标仓库"}
            </Label>
            {repos.length > 0 ? (
              <MultiSelect<RepoConfig>
                options={repos}
                value={repoPaths}
                onChange={setRepoPaths}
                getKey={(r) => r.path}
                placeholder={
                  mode === "chat"
                    ? "选填、不选时 agent 起在 AI工作流项目本身"
                    : "选择仓库（可多选）"
                }
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
                还没配置仓库——先去 <strong>设置</strong> 加一个
                {mode === "chat" && "、或者不选直接聊"}
              </EmptyHint>
            )}
          </div>

          {/* 角色、飞书：仅 task 模式展示 */}
          {mode === "task" && (
            <>
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

              {/* V0.6.3：per-repo「已有工作分支」覆盖——已自己建分支做了一部分时填、build 复用不另建 */}
              {repoPaths.length > 0 && (
                <div className="grid gap-1.5">
                  <Label>已有工作分支（选填）</Label>
                  <div className="grid gap-2">
                    {repoPaths.map((p) => {
                      const repo = repos.find((r) => r.path === p);
                      return (
                        <div key={p} className="flex items-center gap-2">
                          <span
                            className="w-28 shrink-0 truncate text-sm text-muted-foreground"
                            title={repo?.name ?? p}
                          >
                            {repo?.name ?? p}
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
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    已自己建分支做了一部分？填进来、build 直接复用、不另建
                  </p>
                </div>
              )}
            </>
          )}

          {/* 模型选择（两种模式都展示） */}
          <div className="grid gap-1.5">
            <Label htmlFor="t-model">模型</Label>
            <Select
              // 空值用 null 保持受控（避免 Base UI Select 非受控转受控警告）
              value={pickedModelId || null}
              onValueChange={(v) => v && setPickedModelId(v)}
              disabled={availableModels.length === 0}
            >
              <SelectTrigger id="t-model" className="w-full">
                <SelectValue
                  placeholder={
                    availableModels.length === 0
                      ? defaultModelId
                        ? `默认: ${defaultModelId}（API Key 没填、改不了）`
                        : "未配模型、请先去设置页选"
                      : "选模型"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex flex-col">
                      <span>{m.displayName}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {m.id}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {pickedModelId &&
              defaultModelId &&
              pickedModelId !== defaultModelId && (
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
        </div>

        {/* task 模式缺飞书 MCP 时的硬提示——飞书是「需求 → PR」命脉、缺了按钮置灰不让建 */}
        {mode === "task" && missingFeishuMcp.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            创建任务需先启用{" "}
            <strong>{missingFeishuMcp.map((m) => m.label).join("、")}</strong>
            （在 Cursor 配置、或在上方 MCP 区打开）
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
