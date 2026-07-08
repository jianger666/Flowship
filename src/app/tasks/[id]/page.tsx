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
 * 布局（V0.7：ActionTimeline 从顶部条归位到 artifact 工作区顶部）：
 *   ┌──────────────────────────────────────────────────┐
 *   │ 顶部条：标题 + 状态徽章 + 推进 / ack 按钮         │
 *   │ ContextDocs + MCP + 批次 chip                   │
 *   ├──────────────────────────┬───────────────────────┤
 *   │ ActionWorkbenchHeader     │ 右：EventStream      │
 *   │  (timeline+status+file)   │  全任务事件流        │
 *   │ 左：ArtifactPanel         │                      │
 *   │  当前 selected action     │                      │
 *   └──────────────────────────┴───────────────────────┘
 *
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notFound, useParams } from "next/navigation";
import {
  Ban,
  ExternalLink,
  Flag,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { ActionWorkbenchHeader } from "@/components/tasks/action-workbench-header";
import { AdvanceDialog } from "@/components/tasks/advance-dialog";
import { ArtifactPanel } from "@/components/tasks/artifact-panel";
import { AskUserDialog } from "@/components/tasks/ask-user-dialog";
import { BatchProgress } from "@/components/tasks/batch-progress";
import { ChatView } from "@/components/tasks/chat-view";
import { ContextDocsPanel } from "@/components/tasks/context-docs-panel";
import { EditTaskDialog } from "@/components/tasks/edit-task-dialog";
import { EventStream } from "@/components/tasks/event-stream";
import { TaskMcpPanel } from "@/components/tasks/task-mcp-panel";
import { TaskTalkComposer } from "@/components/tasks/task-talk-composer";
import { WorkspaceActions } from "@/components/tasks/workspace-actions";
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
import { useTaskList } from "@/hooks/use-task-list";
import { useTaskWatch } from "@/hooks/use-task-watch";

import { getSettings } from "@/lib/local-store";
import { prepareRunArgs } from "@/lib/run-args";
import {
  fetchTask,
  finalizeTask,
  reopenTask,
  setActionExcluded,
  setTaskUiLayout,
  stopTask,
  type ImagePayload,
} from "@/lib/task-store";
import {
  actionDisplayLabel,
  MR_KIND_LABEL,
  REPO_STATUS_LABEL,
  REPO_STATUS_VARIANT,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
  deriveEffectiveBatches,
  formatRepoPathsForDisplay,
  mrKindOf,
  mrTargetBranchOf,
} from "@/lib/task-display";
import {
  getEffectiveCwd,
  getRepoShortNames,
  getUniqueRepoDirNames,
} from "@/lib/path-utils";
import type {
  ActionRecord,
  ActionType,
  DevPushMode,
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
  // selectedActionId 属于哪个 task；切 task 时必须重置，避免不同 task 复用 act_1/act_2 造成误定位
  const selectedActionTaskIdRef = useRef<string | null>(null);
  // 推进按钮 loading 态
  const [starting, setStarting] = useState(false);
  // 流式打字态（assistant chunk 累加、收到 assistant_message 事件清空）
  const [streamingText, setStreamingText] = useState("");
  // 「推进」dialog 开关——V0.6.0.1 末段砍掉 ActionTimeline retry 入口、所有推进都从顶部按钮进、不再有预填
  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  // SSE 重连 epoch：任意「让 agent 又活起来」的路径 ++、useTaskWatch 重连
  const [watchEpoch, setWatchEpoch] = useState(0);
  // 「停止」按钮提交锁——中断 running agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);
  // V0.6.6「编辑任务」dialog 开关（改角色 / 标题 / 飞书链接 / 模型 / 工作分支）
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // 当前 artifact 文件名：ArtifactPanel 上报、透传给工作区 Header 显示（filename 归 Header）
  const [artifactFilename, setArtifactFilename] = useState<string | null>(null);
  const handleArtifactMeta = useCallback(
    (meta: { filename: string } | null) => {
      setArtifactFilename(meta?.filename ?? null);
    },
    [],
  );
  // 全局 confirm hook（终结任务 / 停止 / 划除二次确认用）
  const { confirm } = useDialog();
  // 侧栏全局任务列表：把当前任务关键状态同步进去（侧栏运行态实时 + 触发条件轮询）
  const { upsertTask } = useTaskList();

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

  // 把当前任务的关键状态同步进侧栏全局列表（任务 + 对话模式都经过这里）：
  //  1) 你正在看的这个任务、侧栏的转圈 / 等你回复点实时准（不等轮询）
  //  2) 让 useTaskList「知道」有任务在跑 → 触发它的条件轮询去刷后台其它任务
  // 仅依赖影响侧栏展示 / 轮询触发的关键字段、不随 events 高频 setState 全列表重渲染
  useEffect(() => {
    if (task) upsertTask(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    task?.id,
    task?.runStatus,
    task?.repoStatus,
    task?.currentActionId,
    task?.title,
    task?.pinned,
    task?.actions.length,
  ]);

  // task.id 变化时清下 streamingText（防切 task 残留）
  useEffect(() => {
    setStreamingText("");
  }, [task?.id]);

  // currentActionId 变化时把 selectedActionId 跟到 currentActionId
  // 用户主动切别的 action 后、currentActionId 又变（agent 又推进一步）时不强行带回——
  // 但「当前没选 / 选的 action 已被 GC」时回到 currentActionId
  useEffect(() => {
    if (!task) return;
    if (selectedActionTaskIdRef.current !== task.id) {
      // 切到新 task：默认选中最后一个（最近）action、直接看最新产物——
      // 不用 currentActionId（idle 时它可能为空 / 指向较早的步）
      selectedActionTaskIdRef.current = task.id;
      const lastAction = task.actions[task.actions.length - 1];
      setSelectedActionId(lastAction?.id ?? task.currentActionId ?? null);
      return;
    }
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

  // 全量有效批次（task 级、跨所有 plan action 派生）——传给 ArtifactPanel 的批次表、
  // 让追加 plan 也能看到完整批次盘子 b1/b2/b3 + 进度，跟选批界面 / 进度条同源
  const effectiveBatches = useMemo(
    () => (task ? deriveEffectiveBatches(task).batches : []),
    [task],
  );

  // 当前查看的 plan 之前的历次 plan（仅追加 / 重建场景用）——artifact 顶部「前序方案」入口
  const priorPlans = useMemo(() => {
    if (!task || selectedAction?.type !== "plan" || !selectedAction.replanMode) {
      return [];
    }
    return task.actions
      .filter(
        (a) => a.type === "plan" && !a.excluded && a.n < selectedAction.n,
      )
      .map((a) => ({ n: a.n }));
  }, [task, selectedAction]);

  // ack 按钮可用态：current action 处于 awaiting_ack 且 runStatus = awaiting_user
  // （hooks 必须在早返回前、所以在这里 useMemo 算、下方渲染区直接用）
  const canAck = useMemo(
    () =>
      !!task &&
      !!currentAction &&
      currentAction.status === "awaiting_ack" &&
      task.runStatus === "awaiting_user",
    [task, currentAction],
  );

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
  // canAck 在上方 hooks 区 useMemo 算好（auto-close effect 也要用）

  // 推进按钮：任务非终结态 + agent 不在跑代码
  //   - idle / error：没活 agent、推进会起新 Run
  //   - awaiting_user（含当前 action 等 ack 时）：去掉「通过」按钮后、推进会隐式认可当前 action、
  //     再走 submitNextAction 续接 / force-new 起新（V0.x 去掉了原先「先 ack 才解锁」的 !canAck 限制）
  const canAdvance =
    task.runStatus !== "running" &&
    task.repoStatus !== "merged" &&
    task.repoStatus !== "abandoned";

  // 终结按钮：任务有 action（不是空壳）且没在跑（不是 running）、并且没被终结过
  const canFinalize =
    task.actions.length > 0 &&
    task.runStatus !== "running" &&
    task.repoStatus !== "merged" &&
    task.repoStatus !== "abandoned";

  // 恢复按钮：终态（merged / abandoned）才显示——给误 abandon / 想重新捡起的 task 留出路
  // 终态时 canAdvance / canFinalize 都 false、其它操作按钮全隐藏、恢复是唯一入口
  const canReopen =
    task.repoStatus === "merged" || task.repoStatus === "abandoned";

  // ---- 推进 ----
  const handleAdvance = async (input: {
    actionType: ActionType;
    userInstruction: string;
    // V0.6.27：默认每 action 新 agent、勾「续用当前 agent」才续接
    reuseAgent: boolean;
    // 用户在 advance-dialog 里临时挑的模型；仅起新 agent 时透传、续接 Run 不能换
    model?: ModelSelection;
    // 指令配的截图附件（选填）
    images?: ImagePayload[];
    // V0.6.14：合并后是否删源分支（advance-dialog 仅 ship 时给值、否则 undefined）
    removeSourceBranch?: boolean;
    // V0.6.23：build 分批——本次做哪些批次（advance-dialog 仅 build 且 plan 拆批时给值）
    requestedBatchIds?: string[];
    // V0.x：联调推送方式（advance-dialog 仅 dev 时给值、direct 直推 / mr 提 PR）
    devPushMode?: DevPushMode;
    // V0.8.x：plan 重跑时的批次合并语义（追加补充 / 重建后续）
    replanMode?: "append" | "rebuild";
    // V0.9：自定义 action 指向的定义 id（advance-dialog 仅 custom 时给值）
    customActionId?: string;
  }) => {
    setStarting(true);
    try {
      // 统一走 prepareRunArgs：apiKey + model（task.model || settings.defaultModel）
      // MCP 由 server 端读 cursor 配置、不在此传。校验失败 helper 内部 toast.error、返 null
      const args = prepareRunArgs(task);
      if (!args) return;
      // input.model 仅起新 agent 时由 dialog 临时挑、优先级最高、覆盖 prepareRunArgs 算的
      const model = input.model?.id ? input.model : args.model;
      // gitHost / gitToken / username 不在 prepareRunArgs 暴露字段里、单独读 settings
      const settings = getSettings();
      // V0.x A 方案：带上设置页最新分支配置（只收本 task 各仓 + settings 找得到 + 非空）、
      //   server 据此刷新 task 分支快照——设置页改了 dev/test/线上分支、老 task 下次推进就生效。
      const repoBaseBranches: Record<string, string> = {};
      const repoTestBranches: Record<string, string> = {};
      const repoDevBranches: Record<string, string> = {};
      for (const p of task.repoPaths) {
        const repo = settings.repos.find((r) => r.path === p);
        if (!repo) continue;
        const ob = repo.onlineBranch?.trim();
        if (ob) repoBaseBranches[p] = ob;
        const tb = repo.testBranch?.trim();
        if (tb) repoTestBranches[p] = tb;
        const db = repo.devBranch?.trim();
        if (db) repoDevBranches[p] = db;
      }

      const res = await fetch(`/api/tasks/${task.id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: input.actionType,
          userInstruction: input.userInstruction,
          // 截图附件（选填）、后端落盘后把路径注入 agent prompt
          images:
            input.images && input.images.length > 0 ? input.images : undefined,
          apiKey: args.apiKey,
          model,
          reuseAgent: input.reuseAgent,
          username: settings.username?.trim() || undefined,
          // V0.6.1 ship action 用：每次推进都带上 settings 里最新的 gitHost/gitToken
          // task-runner 闭包到 internalStartAgent 里、续接路径只在 ship 准入校验时用
          gitHost: settings.gitHost?.trim() || undefined,
          gitToken: settings.gitToken?.trim() || undefined,
          // V0.6.14 ship action：合并后是否删源分支（advance-dialog 仅 ship 时给值、否则 undefined）
          removeSourceBranch: input.removeSourceBranch,
          // V0.6.23 build action：本次做哪些批次（仅 build 且 plan 拆批时有值、否则 undefined=全做）
          requestedBatchIds: input.requestedBatchIds,
          // V0.x dev action：联调推送方式（direct 直推 / mr 提 PR）
          devPushMode: input.devPushMode,
          // V0.8.x plan action：重跑方案时的批次合并语义
          replanMode: input.replanMode,
          // V0.9 custom action：指向的定义 id（仅 custom 时有值）
          customActionId: input.customActionId,
          // V0.x A 方案：设置页最新分支配置（server 据此刷新 task 分支快照、设置页改了下次推进生效）
          repoBaseBranches:
            Object.keys(repoBaseBranches).length > 0
              ? repoBaseBranches
              : undefined,
          repoTestBranches:
            Object.keys(repoTestBranches).length > 0
              ? repoTestBranches
              : undefined,
          repoDevBranches:
            Object.keys(repoDevBranches).length > 0
              ? repoDevBranches
              : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: unknown;
        };
        // 服务端 errorResponse 返回 { error: "文字" }——error 是字符串、不是带 .message 的对象。
        // 之前写成 data.error?.message → 永远 undefined → 真实报错被吞成「HTTP 404」误导排查、必须直接读 data.error。
        throw new Error(
          typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as { task: Task; action: ActionRecord };
      setTask(data.task);
      setSelectedActionId(data.action.id);
      setAdvanceDialogOpen(false);
      setWatchEpoch((n) => n + 1);
    } catch (err) {
      toast.error(`推进失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
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
        title: `划除 #${action.n} ${actionDisplayLabel(action)}？`,
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
          ? "标记本任务对应 MR 已合入 main、agent 收尾结束 run"
          : "标记本任务已放弃、agent 收尾结束 run、产物保留只读",
      destructive: finalStatus === "abandoned",
      confirmLabel: finalStatus === "merged" ? "已合入" : "放弃任务",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const updated = await finalizeTask(task.id, finalStatus);
      setTask(updated);
      if (finalStatus === "abandoned") toast.success("任务已放弃");
    } catch (err) {
      toast.error(`终结失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  // ---- 恢复：merged / abandoned → developing ----
  // 给误 abandon / 想重新捡起的终态 task 留出路（否则终态后操作按钮全隐藏、锁死只读）
  const handleReopen = async () => {
    if (!task) return;
    const ok = await confirm({
      title: "恢复任务？",
      description: "把已终结的任务拉回「开发中」、可重新推进 action。",
      confirmLabel: "恢复",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const updated = await reopenTask(task.id);
      setTask(updated);
      // 终态时订阅已按「终态 done」停掉（V0.11.6 语义）、恢复后要强制重订阅
      setWatchEpoch((n) => n + 1);
    } catch (err) {
      toast.error(`恢复失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  // chat 模式：走 ChatView 单栏布局、它内部订阅 SSE、内部处理 sendChatReply
  // 父组件只把 onTaskUpdate / onEventAppend 传下去、不传任何动作按钮 callback
  if (task.mode === "chat") {
    return (
      <div className="flex h-full flex-col">
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
    <div className="flex h-full flex-col">
      {/* 顶部条 */}
      <div className="shrink-0 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              {/* min-w-0：让 h1 的 truncate 真正生效——否则长标题撑满、把后面的状态
                  badge（已带 shrink-0）挤到溢出 / 换行。标题省略、状态 badge 始终同一行。 */}
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 truncate text-base font-semibold">
                  {task.title}
                </h1>
                <Badge variant={REPO_STATUS_VARIANT[task.repoStatus]}>
                  {REPO_STATUS_LABEL[task.repoStatus]}
                </Badge>
                {task.runStatus === "error" ? (
                  <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-destructive/80" />
                    {RUN_STATUS_LABEL[task.runStatus]}
                  </span>
                ) : task.runStatus !== "idle" ? (
                  <Badge variant={RUN_STATUS_VARIANT[task.runStatus]}>
                    {RUN_STATUS_LABEL[task.runStatus]}
                  </Badge>
                ) : null}
                {/* V0.6.6 编辑任务：紧跟标题（改任务属性、跟身份信息绑定）、running 时隐藏 */}
                {task.runStatus !== "running" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditDialogOpen(true)}
                    title="编辑任务：角色 / 标题 / 飞书链接 / 模型 / 工作分支"
                    className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
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
              {/* V0.10.1：工作区快捷操作（IDE 打开 / 复制路径 / 单预览位）
                  ——本分支已是 task 模式（chat 模式在上面提前 return ChatView） */}
              <WorkspaceActions task={task} />
              {/* V0.6.1：MR 链接（ship action 落档后展示、多仓 task 平铺多条） */}
              {task.mrs.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {task.mrs.map((mr) => {
                    const tail =
                      mr.repoPath.split("/").filter(Boolean).pop() ?? mr.repoPath;
                    const versionTag = mr.version > 1 ? ` v${mr.version}` : "";
                    // V0.x：标注提测 / 联调（同仓提测 MR→test 和联调 MR→dev 可并存、按目标分支区分）
                    const kind = mrKindOf(
                      mr,
                      task.repoTestBranches,
                      task.repoDevBranches,
                    );
                    const target = mrTargetBranchOf(mr, task.repoTestBranches);
                    return (
                      <a
                        key={`${mr.repoPath}-${target}-${mr.version}`}
                        href={mr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                        title={`${MR_KIND_LABEL[kind]} → ${target}\n${mr.title}\n${mr.url}\nstatus: ${mr.status}`}
                      >
                        <ExternalLink className="size-3" />
                        <Badge
                          variant="outline"
                          className="px-1 py-0 text-[10px] font-normal"
                        >
                          {MR_KIND_LABEL[kind]}
                        </Badge>
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
            {canAdvance && (
              <Button
                variant="default"
                size="sm"
                onClick={() => setAdvanceDialogOpen(true)}
                disabled={starting}
                title="推进任务：选下一个 action（plan / build / review / ship / learn / dev）"
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
                  {currentAction && ` ${actionDisplayLabel(currentAction)}`}
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
            {canReopen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReopen}
                disabled={starting}
                title="恢复任务：拉回开发中、可重新推进"
              >
                {starting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                恢复
              </Button>
            )}
          </div>
        </div>

        {/* 上下文文档 + MCP + 批次：都是 chip + 点开 dialog、同一行、不各占一行 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ContextDocsPanel task={task} onTaskUpdate={setTask} />
          <TaskMcpPanel task={task} onTaskUpdate={setTask} />
          {/* V0.6.24：分批进度 chip（拆了=「批次进度 N/M」、没拆=灰色「未分批」、点开看详情） */}
          <BatchProgress task={task} />
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
              <ActionWorkbenchHeader
                actions={task.actions}
                selectedAction={selectedAction}
                selectedActionId={selectedActionId}
                onSelectAction={setSelectedActionId}
                onToggleExclude={handleToggleExclude}
                artifactFilename={artifactFilename}
              />
              <div className="min-h-0 flex-1">
                {selectedAction ? (
                  <ArtifactPanel
                    // P1：按 action.id remount——切 action 时彻底重置内部产物状态
                    // （content/revisions/diff/filename），避免「Header 身份已切到新
                    // action、正文/filename 还停在旧 action」的错误配对；卸载时回调
                    // 上报 filename=null、Header 同步进入过渡态。
                    key={selectedAction.id}
                    action={selectedAction}
                    taskId={task.id}
                    // V0.6.28：优先用 action 创建时的 cwd 快照——task 中途追加仓库后
                    // effectiveCwd 会变、老 artifact 的相对路径必须按写入时基准解析；
                    // 老数据没快照（V0.6.28 前的 action）回退实时计算
                    baseDir={selectedAction.cwd ?? getEffectiveCwd(task.repoPaths)}
                    // 多仓 task：仓短名清单给路径前缀校验用（agent 漏写仓名前缀的
                    // 路径不渲染链接、点了必 404）；单仓不传 = 不校验
                    // V0.10 隔离 task：cwd 是 worktrees/<taskId>、原仓库路径不在其下、
                    // 短名 = worktree 子目录名（getUniqueRepoDirNames、跟 server 同源）
                    repoShortNames={
                      task.repoPaths.length > 1
                        ? task.isolateWorktree
                          ? getUniqueRepoDirNames(task.repoPaths)
                          : getRepoShortNames(
                              task.repoPaths,
                              selectedAction.cwd ?? getEffectiveCwd(task.repoPaths),
                            )
                        : undefined
                    }
                    // V0.8.x：批次表全量化 + 追加方案前序入口
                    effectiveBatches={effectiveBatches}
                    priorPlans={priorPlans}
                    onArtifactRefClick={(ref) => {
                      // 找最近匹配 (n, type) 的 action、切过去
                      const target = task.actions.find(
                        (a) => a.n === ref.n && a.type === ref.type,
                      );
                      if (target) setSelectedActionId(target.id);
                    }}
                    onArtifactMetaChange={handleArtifactMeta}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    <Sparkles className="mr-2 size-4" />
                    {task.actions.length === 0
                      ? "推进后、action 产物显示在这里"
                      : "选一个 action 查看其产物"}
                  </div>
                )}
              </div>
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
              {/* V0.11.9 统一「跟 AI 说」入口：等审阅时按再聊聊送（agent 二分类）、其他时刻纯提问 */}
              <TaskTalkComposer task={task} onTaskUpdate={setTask} />
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* AskUserDialog：agent 调 ask_user 时弹窗。
          onAnswered=refresh 兜底：提交成功后主动拉一次最新 task——正常靠 SSE 推
          ask_user_reply 关弹窗、万一流恰好在重连间隙也能靠这次 refetch 收口、
          不会再出现「后端已送达、弹窗永远卡提交中」（V0.11.6 事故的第二道保险） */}
      <AskUserDialog task={task} onAnswered={() => void refresh()} />

      {/* 推进 dialog */}
      <AdvanceDialog
        open={advanceDialogOpen}
        onOpenChange={setAdvanceDialogOpen}
        task={task}
        onSubmit={handleAdvance}
        submitting={starting}
      />

      {/* V0.6.6 编辑任务 dialog */}
      <EditTaskDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        task={task}
        onSaved={setTask}
      />
    </div>
  );
};

export default TaskDetailPage;
