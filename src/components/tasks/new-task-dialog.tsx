"use client";

/**
 * 新建任务 Dialog
 *
 * V0.2 起：默认 plan 模式 + feishu-story-impl workflow、用户贴一条飞书 story 链接即可启动
 * chat 模式：自由对话、临时探索 / 调试用
 *
 * 字段（plan 模式）：
 *   - 任务标题 *
 *   - 仓库 *（select 自 settings.repos）
 *   - 角色 *（V0.4、当前仅 fe、未来扩 be / data / mobile / qa）
 *   - 飞书 story 链接 *（plan workflow 的核心输入、不填没法跑）
 *   - 描述补充（可选）
 *
 * 字段（chat 模式、V0.4 起全选填）：
 *   - 任务名称（选填、不填用「未命名对话 MM-DD HH:mm」占位）
 *   - 仓库（选填、不填用 ~ 作为 agent cwd、跟 ChatGPT/Claude 一样不绑项目）
 *   - 飞书项目链接（选填、复用 feishuStoryUrl 字段、agent 可顺手拉来当上下文）
 *
 *   chat 模式自由化意图（用户拍板 2026-05-15）：
 *     - 不强制填首条消息、进任务后用户在底部输入框直接发即可（chat-view 自动启 agent）
 *     - 不强制绑仓库、自由聊天 / 写脚本 / 查资料场景不需要仓库上下文
 *     - 飞书链接复用 plan 模式的 feishuStoryUrl 字段、UI 文案改通用「飞书项目链接」
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getSettings } from "@/lib/local-store";
import { createTask, parseMcpServers } from "@/lib/task-store";
import { McpToggleList } from "@/components/tasks/mcp-toggle-list";
import { TASK_ROLE_LABEL, type RepoConfig, type Task, type TaskMode, type TaskRole } from "@/lib/types";

// V0.4 阶段角色单值 fe、UI 仍显式给选择器、给用户「以后会扩」的预期
// 未来扩 enum 时只需要往 TaskRole union 加值 + 这里加 option、其他地方按 TASK_ROLE_LABEL 自动同步
const ROLE_OPTIONS: TaskRole[] = ["fe"];

interface Props {
  onCreated: (task: Task) => void;
}

export const NewTaskDialog = ({ onCreated }: Props) => {
  // dialog 开关
  const [open, setOpen] = useState(false);
  // 任务模式：V0.2 默认 plan（公司主要场景：飞书 story → PR）
  const [mode, setMode] = useState<TaskMode>("plan");
  // V0.4 任务角色：决定 agent 以哪种视角读 story / 出方案、当前只 fe、未来扩 be / data / mobile / qa
  const [role, setRole] = useState<TaskRole>("fe");
  // 任务标题（chat 模式下也作为首条消息）
  const [title, setTitle] = useState("");
  // 目标仓库绝对路径
  const [repoPath, setRepoPath] = useState("");
  // 飞书项目链接（V0.4 起 plan/chat 共用同一字段、不再分 feishuUrl）
  // plan 模式：必填、agent 用来拉 story 详情页
  // chat 模式：选填、agent 当作上下文文档之一
  const [feishuStoryUrl, setFeishuStoryUrl] = useState("");
  // plan 模式可选的描述补充（story 文档信息不够时用）
  const [description, setDescription] = useState("");
  // 仓库下拉源、open 时从 settings 同步过来
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  // settings 里配置的 MCP server 名列表（来自 mcpServersJson 解析、open 时刷新）
  const [availableMcp, setAvailableMcp] = useState<string[]>([]);
  // 用户在弹窗里勾掉的 MCP（黑名单）、默认空 = 全开
  const [disabledMcp, setDisabledMcp] = useState<string[]>([]);
  // MCP 区折叠态、默认收起——MCP 多的话能撑很高、用户大多不需要改
  const [mcpExpanded, setMcpExpanded] = useState(false);

  // 打开时读 settings.repos + 解析 mcpServersJson
  useEffect(() => {
    if (!open) return;
    const s = getSettings();
    setRepos(s.repos);
    try {
      const parsed = parseMcpServers(s.mcpServersJson);
      setAvailableMcp(parsed ? Object.keys(parsed) : []);
    } catch {
      // 配置坏了不阻断建任务、设置页有错会单独提示
      setAvailableMcp([]);
    }
  }, [open]);

  // 关闭时重置、防止下次再开还显示上次的输入
  useEffect(() => {
    if (open) return;
    setMode("plan");
    setRole("fe");
    setTitle("");
    setRepoPath("");
    setFeishuStoryUrl("");
    setDescription("");
    setDisabledMcp([]);
    setMcpExpanded(false);
  }, [open]);

  // 提交锁、避免连点
  const [submitting, setSubmitting] = useState(false);

  // 可提交判定
  // V0.4：chat 模式全选填、任何输入都能直接提交（后端 task-fs.createTask 给默认值）
  // plan 模式保留原约束：title + repoPath + feishuStoryUrl 必填
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (mode === "plan") {
      if (!title.trim() || !repoPath.trim() || !feishuStoryUrl.trim()) {
        return false;
      }
    }
    return true;
  }, [submitting, title, repoPath, mode, feishuStoryUrl]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const task = await createTask({
        mode,
        // plan 默认 workflow（task-fs.createTask 兜底也会塞、这里显式更清楚）
        workflowId: mode === "plan" ? "feishu-story-impl" : undefined,
        // V0.4：角色（当前 enum 只有 fe、UI 显式选了再传）
        role,
        title: title.trim(),
        repoPath: repoPath.trim(),
        // V0.4：plan/chat 共用 feishuStoryUrl 字段、统一以飞书项目链接为起点
        feishuStoryUrl: feishuStoryUrl.trim() || undefined,
        description:
          mode === "plan" && description.trim() ? description.trim() : undefined,
        disabledMcpServers: disabledMcp.length > 0 ? disabledMcp : undefined,
      });
      toast.success("任务已创建（草稿）");
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
            新建任务
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label>任务模式 *</Label>
            <div className="grid grid-cols-2 gap-2">
              <ModeCard
                active={mode === "plan"}
                onClick={() => setMode("plan")}
                icon={<Workflow className="size-4" />}
                title="方案规划（推荐）"
                desc="从飞书 story 起步、走 plan → build → review 三段、agent 自己读上下文 + 扫仓库 + 出方案 + 写代码 + 复核交付、每段你 ack 才推进"
              />
              <ModeCard
                active={mode === "chat"}
                onClick={() => setMode("chat")}
                icon={<MessageCircle className="size-4" />}
                title="自由对话"
                desc="临时探索 / 调试用、agent 长存活、靠 wait_for_user 等下一句"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="t-title">
              {mode === "chat" ? "任务名称（选填）" : "需求标题 *"}
            </Label>
            <Input
              id="t-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                mode === "chat"
                  ? "选填、不填用「未命名对话 MM-DD HH:mm」"
                  : "如：用户列表批量导出"
              }
              autoFocus
            />
            {mode === "chat" && (
              <p className="text-xs text-muted-foreground">
                只是任务标识、不会作为发给 agent 的首条消息。进任务后在底部输入框发即可
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="t-repo">
              {mode === "chat" ? "目标仓库（选填）" : "目标仓库 *"}
            </Label>
            {repos.length > 0 ? (
              <Select
                value={repoPath}
                onValueChange={(v) => v && setRepoPath(v)}
              >
                <SelectTrigger id="t-repo" className="w-full min-w-0">
                  <SelectValue
                    placeholder="选择仓库"
                    className="min-w-0 overflow-hidden"
                  >
                    {(value: unknown) => {
                      if (typeof value !== "string" || !value) return "选择仓库";
                      const r = repos.find((x) => x.path === value);
                      if (!r) return value;
                      return (
                        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <span className="shrink-0 font-medium">{r.name}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {r.path}
                          </span>
                        </span>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {repos.map((r) => (
                    <SelectItem key={r.path} value={r.path}>
                      <div className="flex flex-col items-start">
                        <span className="font-medium">{r.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.path}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : mode === "chat" ? (
              <EmptyHint size="sm">
                还没配置仓库——自由对话默认在你 home 目录跑、不绑特定项目也没关系。需要绑仓库就先去 <strong>设置</strong> 加一个
              </EmptyHint>
            ) : (
              <EmptyHint size="sm">
                还没配置仓库、先去 <strong>设置</strong> 加一个、回来再建任务
              </EmptyHint>
            )}
            {mode === "chat" && (
              <p className="text-xs text-muted-foreground">
                选填、不填 agent 默认 cwd 在你 home 目录（适合纯聊天 / 查资料 / 写脚本）
              </p>
            )}
          </div>

          {mode === "plan" ? (
            <>
              {/* V0.4 角色选择器：决定 agent 以哪种视角读 story / 出方案
                  当前 enum 只有 fe、未来扩 be / data / mobile / qa 时这里自动跟着多 option */}
              <div className="grid gap-1.5">
                <Label htmlFor="t-role">角色 *</Label>
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
                  飞书 story 是跨角色共享的、agent 会按你选的角色挑相关部分。当前仅前端、后端
                  / 数仓 / 测试等角色后续扩
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="t-story">飞书 story 链接 *</Label>
                <Input
                  id="t-story"
                  value={feishuStoryUrl}
                  onChange={(e) => setFeishuStoryUrl(e.target.value)}
                  placeholder="https://project.feishu.cn/<space>/story/detail/<id>..."
                />
                <p className="text-xs text-muted-foreground">
                  方案规划阶段会自动拉这条 story 的描述、验收标准、关联文档
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="t-desc">补充说明（可选）</Label>
                <Textarea
                  id="t-desc"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="飞书 story 没写清楚的点、想强调的约束、想避开的地方……"
                  className="resize-none"
                />
              </div>
            </>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="t-story">飞书项目链接（选填）</Label>
              <Input
                id="t-story"
                value={feishuStoryUrl}
                onChange={(e) => setFeishuStoryUrl(e.target.value)}
                placeholder="https://project.feishu.cn/<space>/story/detail/..."
              />
              <p className="text-xs text-muted-foreground">
                填了 agent 会把它作为上下文文档之一、对话里可主动拉来看
              </p>
            </div>
          )}

          {/* MCP 开关：默认全开 + 默认折叠（避免 MCP 多时撑弹窗）
              视觉风格跟详情页的 TaskMcpPanel 对齐、滚动区限高避免无限增高 */}
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
                  <div className="max-h-48 overflow-y-auto">
                    <McpToggleList
                      availableServers={availableMcp}
                      disabled={disabledMcp}
                      onChange={setDisabledMcp}
                    />
                  </div>
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

interface ModeCardProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}

const ModeCard = ({ active, onClick, icon, title, desc }: ModeCardProps) => (
  <ChoiceButton shape="card" selected={active} onClick={onClick}>
    <div
      className={cn(
        "flex items-center gap-2 text-sm font-medium",
        active ? "text-primary" : "text-foreground",
      )}
    >
      {icon}
      {title}
    </div>
    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
      {desc}
    </div>
  </ChoiceButton>
);
