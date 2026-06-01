"use client";

/**
 * 任务详情页（V0.6 重写）
 *
 * V0.5 → V0.6 主要变更：
 *   - phase chain → action history（task 容器 + N 条 ActionRecord）
 *   - status（draft/running/awaiting_user/completed/failed）→ repoStatus + runStatus 双状态
 *   - mode（plan/chat）取消、所有任务统一容器
 *   - 删 chat-view / phase-progress / approve-phase-dialog（旧 phase 模型遗物）
 *   - 加 ActionTimeline、action 切换、推进 dialog 选 action 类型
 *
 * 布局：
 *   ┌──────────────────────────────────────────────────┐
 *   │ 顶部条：标题 + 状态徽章 + 推进 / ack 按钮         │
 *   │ ContextDocs + MCP 按钮                          │
 *   │ ActionTimeline（chip）                          │
 *   ├──────────────────────────┬───────────────────────┤
 *   │ 左：ArtifactPanel       │ 右：EventStream      │
 *   │  当前 selected action    │  全任务事件流        │
 *   └──────────────────────────┴───────────────────────┘
 *
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ExternalLink,
  Flag,
  Loader2,
  MessageCircleQuestion,
  Sparkles,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { ActionTimeline } from "@/components/tasks/action-timeline";
import { AdvanceDialog } from "@/components/tasks/advance-dialog";
import { ArtifactPanel } from "@/components/tasks/artifact-panel";
import { AskUserDialog } from "@/components/tasks/ask-user-dialog";
import { ChatView } from "@/components/tasks/chat-view";
import { ContextDocsPanel } from "@/components/tasks/context-docs-panel";
import { EventStream } from "@/components/tasks/event-stream";
import { ReviseDialog } from "@/components/tasks/revise-dialog";
import { TaskMcpPanel } from "@/components/tasks/task-mcp-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { useDialog } from "@/hooks/use-dialog";
import { useTaskWatch } from "@/hooks/use-task-watch";

import { getSettings } from "@/lib/local-store";
import { prepareRunArgs } from "@/lib/run-args";
import {
  fetchTask,
  finalizeTask,
  setActionExcluded,
  setTaskUiLayout,
  stopTask,
  submitActionAck,
  type ImagePayload,
} from "@/lib/task-store";
import {
  ACTION_LABEL,
  REPO_STATUS_LABEL,
  REPO_STATUS_VARIANT,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
  formatRepoPathsForDisplay,
} from "@/lib/task-display";
import { getEffectiveCwd } from "@/lib/path-utils";
import type {
  ActionRecord,
  ActionType,
  ModelSelection,
  Task,
} from "@/lib/types";

const TaskDetailPage = () => {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // 任务对象（V0.6 含 actions / mrs / repoStatus / runStatus 等）
  const [task, setTask] = useState<Task | null>(null);
  // 首次 fetchTask 完成、为 false 时显示加载占位
  const [loaded, setLoaded] = useState(false);
  // 用户当前在产物面板上看的 action（null = 没选、默认走 task.currentActionId）
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  // 推进按钮 loading 态
  const [starting, setStarting] = useState(false);
  // 「再聊聊」对话框开关
  const [reviseOpen, setReviseOpen] = useState(false);
  // 「通过 / 再聊聊」按钮提交锁、防连点
  const [ackSubmitting, setAckSubmitting] = useState(false);
  // 流式打字态（assistant chunk 累加、收到 assistant_message 事件清空）
  const [streamingText, setStreamingText] = useState("");
  // 「推进」dialog 开关——V0.6.0.1 末段砍掉 ActionTimeline retry 入口、所有推进都从顶部按钮进、不再有预填
  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  // SSE 重连 epoch：任意「让 agent 又活起来」的路径 ++、useTaskWatch 重连
  const [watchEpoch, setWatchEpoch] = useState(0);
  // 「停止」按钮提交锁——中断 running agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);
  // 全局 confirm hook（终结任务 / 停止 / 划除二次确认用）
  const { confirm } = useDialog();

  // ---- 拉一次任务详情 ----
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const t = await fetchTask(id);
      setTask(t);
    } catch (err) {
      toast.error(`加载任务失败：${(err as Error).message}`);
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // task.id 变化时清下 streamingText（防切 task 残留）
  useEffect(() => {
    setStreamingText("");
  }, [task?.id]);

  // currentActionId 变化时把 selectedActionId 跟到 currentActionId
  // 用户主动切别的 action 后、currentActionId 又变（agent 又推进一步）时不强行带回——
  // 但「当前没选 / 选的 action 已被 GC」时回到 currentActionId
  useEffect(() => {
    if (!task) return;
    if (!selectedActionId) {
      setSelectedActionId(task.currentActionId ?? null);
      return;
    }
    if (!task.actions.some((a) => a.id === selectedActionId)) {
      setSelectedActionId(task.currentActionId ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.currentActionId, task?.actions.length]);

  // ---- 自动 watch SSE ----
  // V0.6.0.1：chat 模式 task 走 ChatView 内部自己的 useTaskWatch（避免父子两份订阅重复 setTask）
  // 这里只在 task 模式下订阅
  useTaskWatch(
    task?.id,
    {
      onEvent: (ev) => {
        if (ev.kind === "assistant_message") setStreamingText("");
        setTask((prev) => {
          if (!prev) return prev;
          if (prev.events.some((e) => e.id === ev.id)) return prev;
          return { ...prev, events: [...prev.events, ev] };
        });
      },
      onTaskUpdate: (t) => setTask(t),
      onActionUpdate: (action) => {
        // 单独 action 更新事件（status 变 / artifact 重写）→ 合并进 task.actions
        setTask((prev) => {
          if (!prev) return prev;
          const idx = prev.actions.findIndex((a) => a.id === action.id);
          if (idx < 0) {
            return { ...prev, actions: [...prev.actions, action] };
          }
          const next = [...prev.actions];
          next[idx] = action;
          return { ...prev, actions: next };
        });
      },
      onDone: (t) => {
        setStreamingText("");
        setTask(t);
      },
      onAssistantDelta: (text) => setStreamingText((p) => p + text),
      onErrorMessage: (msg) => toast.error(`watch 出错：${msg}`),
      onWatchException: (err) => toast.error(`watch 异常：${err.message}`),
    },
    !!task && task.mode !== "chat",
    watchEpoch,
  );

  // ---- 派生状态 ----
  const selectedAction = useMemo<ActionRecord | null>(() => {
    if (!task || !selectedActionId) return null;
    return task.actions.find((a) => a.id === selectedActionId) ?? null;
  }, [task, selectedActionId]);

  const currentAction = useMemo<ActionRecord | null>(() => {
    if (!task || !task.currentActionId) return null;
    return task.actions.find((a) => a.id === task.currentActionId) ?? null;
  }, [task]);

  // V0.5.10：Resizable 分栏初始 size
  const artifactSizePercent = useMemo(() => {
    const v = task?.uiLayout?.artifactPanelSize;
    if (typeof v === "number" && v >= 10 && v <= 90) return v;
    return 70;
  }, [task?.uiLayout?.artifactPanelSize]);

  // V0.5.10：debounce 写 task.uiLayout
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeLayoutDebounced = useCallback(
    (taskId: string, artifactSize: number) => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        void setTaskUiLayout(taskId, { artifactPanelSize: artifactSize }).catch(
          (err) => {
            console.warn("[uiLayout] PATCH 失败", err);
          },
        );
      }, 500);
    },
    [],
  );
  useEffect(
    () => () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    },
    [],
  );

  if (!loaded) {
    return <LoadingState variant="block" />;
  }

  if (!task) {
    notFound();
  }

  // ---- 按钮渲染条件 ----
  // ack 按钮：current action 处于 awaiting_ack 且 runStatus = awaiting_user
  const canAck =
    !!currentAction &&
    currentAction.status === "awaiting_ack" &&
    task.runStatus === "awaiting_user";

  // 推进按钮：任务非终结态 + agent 不在跑代码 + 当前没有待 ack 的 action
  //   - idle / error：没活 agent、推进会起新 Run
  //   - awaiting_user + currentAction.status != awaiting_ack：agent 在待命态等下一指令、推进走 submitNextAction 续接
  //   - awaiting_user + awaiting_ack：先 ack、本按钮隐藏（!canAck 兜底）
  const canAdvance =
    task.runStatus !== "running" &&
    !canAck &&
    task.repoStatus !== "merged" &&
    task.repoStatus !== "abandoned";

  // 终结按钮：任务有 action（不是空壳）且没在跑（不是 running）、并且没被终结过
  const canFinalize =
    task.actions.length > 0 &&
    task.runStatus !== "running" &&
    task.repoStatus !== "merged" &&
    task.repoStatus !== "abandoned";

  // ---- 推进 ----
  const handleAdvance = async (input: {
    actionType: ActionType;
    userInstruction: string;
    forceNewAgent: boolean;
    // 用户在 advance-dialog 里临时挑的模型；仅 forceNewAgent=true 时透传、续接 Run 不能换
    model?: ModelSelection;
  }) => {
    setStarting(true);
    try {
      // 统一走 prepareRunArgs：apiKey + model（task.model || settings.defaultModel）
      // MCP 由 server 端读 cursor 配置、不在此传。校验失败 helper 内部 toast.error、返 null
      const args = prepareRunArgs(task);
      if (!args) return;
      // input.model 仅 forceNewAgent=true 时由 dialog 临时挑、优先级最高、覆盖 prepareRunArgs 算的
      const model = input.model?.id ? input.model : args.model;
      // gitHost / gitToken / username 不在 prepareRunArgs 暴露字段里、单独读 settings
      const settings = getSettings();

      const res = await fetch(`/api/tasks/${task.id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: input.actionType,
          userInstruction: input.userInstruction,
          apiKey: args.apiKey,
          model,
          forceNewAgent: input.forceNewAgent,
          username: settings.username?.trim() || undefined,
          // V0.6.1 ship action 用：每次推进都带上 settings 里最新的 gitHost/gitToken
          // task-runner 闭包到 internalStartAgent 里、续接路径只在 ship 准入校验时用
          gitHost: settings.gitHost?.trim() || undefined,
          gitToken: settings.gitToken?.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { task: Task; action: ActionRecord };
      setTask(data.task);
      setSelectedActionId(data.action.id);
      setAdvanceDialogOpen(false);
      setWatchEpoch((n) => n + 1);
      toast.success(`已推进、agent 跑 ${ACTION_LABEL[input.actionType]} action`);
    } catch (err) {
      toast.error(`推进失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  // ---- ack：通过 ----
  const handleApprove = async () => {
    if (!currentAction) return;
    setAckSubmitting(true);
    try {
      const updated = await submitActionAck(task.id, currentAction.id, "approve");
      setTask(updated);
      toast.success(
        `${ACTION_LABEL[currentAction.type]} 已通过、agent 在等下一指令`,
      );
    } catch (err) {
      toast.error(`通过失败：${(err as Error).message}`);
    } finally {
      setAckSubmitting(false);
    }
  };

  // ---- ack：再聊聊（revise）----
  const handleSubmitRevise = async (
    feedback: string,
    images?: ImagePayload[],
  ) => {
    if (!currentAction) return;
    setAckSubmitting(true);
    try {
      const updated = await submitActionAck(
        task.id,
        currentAction.id,
        "revise",
        { feedback, images },
      );
      setTask(updated);
      setReviseOpen(false);
      const suffix = images && images.length > 0 ? `（含 ${images.length} 张图）` : "";
      toast.success(
        `已发给 AI${suffix}、它会调整 ${ACTION_LABEL[currentAction.type]} 的产出`,
      );
    } catch (err) {
      toast.error(`提交失败：${(err as Error).message}`);
    } finally {
      setAckSubmitting(false);
    }
  };

  // ---- 停止：中断当前正在跑 / 等 ack 的 action ----
  const handleStop = async () => {
    if (!task) return;
    const ok = await confirm({
      title: "停止当前 action？",
      description:
        "会中断正在跑的 agent（如果它正在改代码、可能留下半成品）。停止后可重新「推进」。",
      confirmLabel: "停止",
      destructive: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const updated = await stopTask(task.id);
      setTask(updated);
      toast.success("已停止、agent 已中断");
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
    } finally {
      setStopping(false);
    }
  };

  // ---- 划除 / 恢复某个 action（软删）----
  // 划除会把 action 排出 agent 上下文、要二次确认；恢复无害、直接做
  const handleToggleExclude = async (action: ActionRecord) => {
    if (!task) return;
    if (!action.excluded) {
      const ok = await confirm({
        title: `划除 #${action.n} ${ACTION_LABEL[action.type]}？`,
        description:
          "把这个 action 从 agent 上下文里排除（后续推进 / 接力不再参考它）。不删数据、随时可恢复。",
        confirmLabel: "划除",
      });
      if (!ok) return;
    }
    try {
      const updated = await setActionExcluded(
        task.id,
        action.id,
        !action.excluded,
      );
      setTask(updated);
      toast.success(action.excluded ? "已恢复" : "已划除");
    } catch (err) {
      toast.error(`操作失败：${(err as Error).message}`);
    }
  };

  // ---- 终结：merged / abandoned ----
  // V0.6.0.1：仅 task 模式可终结（MR 合入 / 放弃）；chat 模式 ChatView 顶部没按钮、走自然清理
  const handleFinalize = async (finalStatus: "merged" | "abandoned") => {
    if (!task) return;
    const ok = await confirm({
      title: finalStatus === "merged" ? "确认任务已合入" : "确认放弃任务",
      description:
        finalStatus === "merged"
          ? "标记本任务对应 MR 已合入 main、agent 收尾结束 run（V0.6.3 起这里会跳 learn action 沉淀经验）"
          : "标记本任务已放弃、agent 收尾结束 run、产物保留只读",
      destructive: finalStatus === "abandoned",
      confirmLabel: finalStatus === "merged" ? "已合入" : "放弃任务",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const updated = await finalizeTask(task.id, finalStatus);
      setTask(updated);
      toast.success(finalStatus === "merged" ? "任务已标记合入" : "任务已放弃");
    } catch (err) {
      toast.error(`终结失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  // chat 模式：走 ChatView 单栏布局、它内部订阅 SSE、内部处理 sendChatReply
  // 父组件只把 onTaskUpdate / onEventAppend 传下去、不传任何动作按钮 callback
  if (task.mode === "chat") {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col">
        <ChatView
          task={task}
          onTaskUpdate={setTask}
          onEventAppend={(ev) => {
            setTask((prev) => {
              if (!prev) return prev;
              if (prev.events.some((e) => e.id === ev.id)) return prev;
              return { ...prev, events: [...prev.events, ev] };
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* 顶部条 */}
      <div className="shrink-0 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<Link href="/" className="no-underline" />}
            >
              <ArrowLeft />
              返回
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-semibold">
                  {task.title}
                </h1>
                <Badge variant={REPO_STATUS_VARIANT[task.repoStatus]}>
                  {REPO_STATUS_LABEL[task.repoStatus]}
                </Badge>
                {task.runStatus !== "idle" && (
                  <Badge variant={RUN_STATUS_VARIANT[task.runStatus]}>
                    {RUN_STATUS_LABEL[task.runStatus]}
                  </Badge>
                )}
              </div>
              <div
                className="text-xs text-muted-foreground"
                title={task.repoPaths.join("\n")}
              >
                {task.repoPaths.length > 0
                  ? formatRepoPathsForDisplay(task.repoPaths)
                  : "(未绑仓库、agent 在 home 跑)"}
                {(task.gitBranches?.length ?? 0) > 0 && task.gitBranches?.[0]?.name && (
                  <span
                    className="ml-2 font-mono"
                    title={task.gitBranches
                      .map((b) =>
                        `${b.repoPath.split("/").pop()}: based on ${b.baseBranch || "?"}`,
                      )
                      .join("\n")}
                  >
                    @ {task.gitBranches[0].name}
                    {task.gitBranches.length > 1 && (
                      <span className="ml-1 text-muted-foreground">
                        ({task.gitBranches.length} 仓)
                      </span>
                    )}
                  </span>
                )}
              </div>
              {/* V0.6.1：MR 链接（ship action 落档后展示、多仓 task 平铺多条） */}
              {task.mrs.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {task.mrs.map((mr) => {
                    const tail =
                      mr.repoPath.split("/").filter(Boolean).pop() ?? mr.repoPath;
                    const versionTag = mr.version > 1 ? ` v${mr.version}` : "";
                    return (
                      <a
                        key={`${mr.repoPath}-${mr.version}`}
                        href={mr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                        title={`${mr.title}\n${mr.url}\nstatus: ${mr.status}`}
                      >
                        <ExternalLink className="size-3" />
                        {tail}
                        {versionTag}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 主操作区 */}
          <div className="flex items-center gap-2">
            {canAck && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReviseOpen(true)}
                  disabled={ackSubmitting}
                  title={`想改 ${currentAction ? ACTION_LABEL[currentAction.type] : ""} 产物 / 有疑问、走这里`}
                >
                  <MessageCircleQuestion />
                  再聊聊
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleApprove}
                  disabled={ackSubmitting}
                  title={`通过 ${currentAction ? ACTION_LABEL[currentAction.type] : ""}、等下一指令`}
                >
                  {ackSubmitting ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <CheckCircle2 />
                  )}
                  通过 {currentAction && ACTION_LABEL[currentAction.type]}
                </Button>
              </>
            )}
            {canAdvance && (
              <Button
                variant={canAck ? "ghost" : "default"}
                size="sm"
                onClick={() => setAdvanceDialogOpen(true)}
                disabled={starting}
                title="推进任务：选下一个 action（plan / build / review / ship / test / learn）"
              >
                {starting ? <Loader2 className="animate-spin" /> : <Zap />}
                推进
              </Button>
            )}
            {canFinalize && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleFinalize("merged")}
                  disabled={starting}
                  title="已合入 main、终结本任务"
                >
                  <Flag />
                  已合入
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleFinalize("abandoned")}
                  disabled={starting}
                  title="放弃本任务、终结 run"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <XCircle />
                  放弃
                </Button>
              </>
            )}
            {task.runStatus === "running" && !canAck && (
              <>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  agent 正在跑
                  {currentAction && ` ${ACTION_LABEL[currentAction.type]}`}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleStop}
                  disabled={stopping}
                  title="停止当前 action（中断 agent、可重新推进）"
                  className="text-muted-foreground hover:text-destructive"
                >
                  {stopping ? <Loader2 className="animate-spin" /> : <Ban />}
                  停止
                </Button>
              </>
            )}
          </div>
        </div>

        {/* 上下文文档 + MCP */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ContextDocsPanel task={task} onTaskUpdate={setTask} />
          <TaskMcpPanel task={task} />
        </div>

        {/* Action timeline */}
        <div className="mt-3">
          <ActionTimeline
            actions={task.actions}
            currentActionId={task.currentActionId}
            selectedActionId={selectedActionId}
            onSelectAction={setSelectedActionId}
            onToggleExclude={handleToggleExclude}
          />
        </div>
      </div>

      <Separator />

      {/* 主区 */}
      <div className="flex flex-1 min-h-0">
        <ResizablePanelGroup
          key={task.id}
          id={`task-layout-${task.id}`}
          orientation="horizontal"
          onLayoutChanged={(layout) => {
            const artifact = layout["artifact"];
            if (typeof artifact === "number" && Number.isFinite(artifact)) {
              writeLayoutDebounced(task.id, artifact);
            }
          }}
        >
          <ResizablePanel
            id="artifact"
            defaultSize={`${artifactSizePercent}%`}
            minSize="20%"
            maxSize="80%"
          >
            <div className="flex h-full flex-col">
              {selectedAction ? (
                <ArtifactPanel
                  action={selectedAction}
                  taskId={task.id}
                  baseDir={getEffectiveCwd(task.repoPaths)}
                  onArtifactRefClick={(ref) => {
                    // 找最近匹配 (n, type) 的 action、切过去
                    const target = task.actions.find(
                      (a) => a.n === ref.n && a.type === ref.type,
                    );
                    if (target) setSelectedActionId(target.id);
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Sparkles className="mr-2 size-4" />
                  {task.actions.length === 0
                    ? "还没推进过任何 action、点上方「推进」按钮开始"
                    : "选一个 action 查看其产物"}
                </div>
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="event-stream"
            defaultSize={`${100 - artifactSizePercent}%`}
            minSize="20%"
            maxSize="80%"
          >
            <aside className="flex h-full flex-col">
              {/* hideReplyComposer=true：V0.6 任务推进通过顶部「推进」按钮、回复通过「再聊聊」dialog */}
              <EventStream
                task={task}
                streamingText={streamingText}
                hideReplyComposer
              />
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* AskUserDialog：agent 调 ask_user 时弹窗 */}
      <AskUserDialog task={task} />

      {/* 再聊聊 Dialog */}
      {currentAction && (
        <ReviseDialog
          open={reviseOpen}
          onOpenChange={setReviseOpen}
          actionLabel={ACTION_LABEL[currentAction.type]}
          submitting={ackSubmitting}
          onSubmit={handleSubmitRevise}
        />
      )}

      {/* 推进 dialog */}
      <AdvanceDialog
        open={advanceDialogOpen}
        onOpenChange={setAdvanceDialogOpen}
        task={task}
        onSubmit={handleAdvance}
        submitting={starting}
      />
    </div>
  );
};

export default TaskDetailPage;
