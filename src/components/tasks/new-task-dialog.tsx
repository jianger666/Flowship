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
import { getSettings } from "@/lib/local-store";
import { createTask } from "@/lib/task-store";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import {
  TASK_ROLE_LABEL,
  type RepoConfig,
  type Task,
  type TaskMode,
  type TaskRole,
} from "@/lib/types";

const ROLE_OPTIONS: TaskRole[] = ["fe", "be"];

interface Props {
  onCreated: (task: Task) => void;
}

export const NewTaskDialog = ({ onCreated }: Props) => {
  // dialog 开关
  const [open, setOpen] = useState(false);
  // V0.6.0.1：任务模式（"task" / "chat"、对应顶部 ModeCard 切换）
  const [mode, setMode] = useState<TaskMode>("task");
  // V0.4 任务角色：决定 agent 以哪种视角读 story / 出方案（仅 task 模式显示）
  const [role, setRole] = useState<TaskRole>("fe");
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
  const { names: availableMcp } = useCursorMcp(open);
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
    setRole("fe");
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

  // task 模式三必填；chat 模式全选填、随便点都能提交
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (mode === "task") {
      if (!title.trim()) return false;
      if (repoPaths.length === 0) return false;
      if (!feishuStoryUrl.trim()) return false;
    }
    return true;
  }, [submitting, mode, title, repoPaths, feishuStoryUrl]);

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

      const task = await createTask({
        mode,
        role,
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
            <Label>类型 *</Label>
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
            <Label htmlFor="t-title">
              {mode === "chat" ? (
                "标题（选填）"
              ) : (
                <>
                  任务标题 <span className="text-destructive">*</span>
                </>
              )}
            </Label>
            <Input
              id="t-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                mode === "chat"
                  ? "不填用「未命名对话 MM-DD HH:mm」占位"
                  : "如：用户列表批量导出"
              }
              autoFocus
            />
          </div>

          {/* 仓库：task 必填、chat 选填 */}
          <div className="grid gap-1.5">
            <Label>
              {mode === "chat" ? (
                "目标仓库（选填）"
              ) : (
                <>
                  目标仓库 <span className="text-destructive">*</span>
                </>
              )}
            </Label>
            {repos.length > 0 ? (
              <MultiSelect<RepoConfig>
                options={repos}
                value={repoPaths}
                onChange={setRepoPaths}
                getKey={(r) => r.path}
                placeholder={
                  mode === "chat"
                    ? "选填、不选时 agent 起在 fe-ai-flow 项目本身"
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
            {repoPaths.length > 1 && (
              <p className="text-xs text-muted-foreground">
                多仓场景：agent cwd = 公共父目录、AI 视角下面挂这{" "}
                {repoPaths.length} 个 git 仓子目录、写路径首段是仓名
              </p>
            )}
          </div>

          {/* 角色、飞书：仅 task 模式展示 */}
          {mode === "task" && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="t-role">角色</Label>
                <Select
                  value={role}
                  onValueChange={(v) => v && setRole(v as TaskRole)}
                >
                  <SelectTrigger id="t-role" className="w-full">
                    <SelectValue placeholder="选择角色">
                      {TASK_ROLE_LABEL[role]}
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
                <p className="text-xs text-muted-foreground">
                  飞书 story 跨角色共享、agent 会按你的角色挑相关部分
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="t-story">
                  飞书项目链接 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="t-story"
                  value={feishuStoryUrl}
                  onChange={(e) => setFeishuStoryUrl(e.target.value)}
                  placeholder="https://project.feishu.cn/<space>/story/detail/..."
                />
                <p className="text-xs text-muted-foreground">
                  agent 跑 plan / build / ship 时拉它作上下文 + 抠 storyId 做 branch 名
                </p>
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
              value={pickedModelId || undefined}
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
            <p className="text-xs text-muted-foreground">
              默认 = 设置页的模型；可以为本任务单独挑别的
              {pickedModelId &&
                defaultModelId &&
                pickedModelId !== defaultModelId && (
                  <span className="ml-1 text-amber-500">
                    （已切到非默认模型）
                  </span>
                )}
            </p>
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
