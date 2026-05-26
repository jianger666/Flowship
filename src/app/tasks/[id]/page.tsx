"use client";

/**
 * 任务详情页（V0.2）
 *
 * 两种模式：
 *
 * - **plan 模式**（V0.2 主流程、feishu-story-impl workflow）：
 *   - 整段任务跑在一次 SDK Run 里、按 phase 顺序执行（plan → build → review、V0.5 起）
 *   - 每个 phase 完成后 agent 调 wait_for_user 阻塞、用户在右侧底部点「通过」/「再聊聊」
 *   - 启动按钮：draft / failed / completed 时显示、点击调 /start-workflow
 *   - 自动 watch SSE：进页面立即订阅、agent 输出 → 事件流、phase 边界 → PhaseProgress
 *
 * - **chat 模式**（V1 legacy、临时探索用）：整页 ChatView、不展示 phase 进度
 *
 * 布局（plan 模式）：
 *   ┌──────────────────────────────────────────────────┐
 *   │ 顶: title + status + PhaseProgress + 启动 / Ack  │
 *   ├──────────────────────────┬───────────────────────┤
 *   │  左: ArtifactPanel       │  右: EventStream      │
 *   │  当前 active phase 产物  │  事件流 + ack 按钮区  │
 *   └──────────────────────────┴───────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MessageCircleQuestion,
  Sparkles,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { AdvanceDialog } from "@/components/tasks/advance-dialog";
import { ApprovePhaseDialog } from "@/components/tasks/approve-phase-dialog";
import { ArtifactPanel } from "@/components/tasks/artifact-panel";
import { AskUserDialog } from "@/components/tasks/ask-user-dialog";
import { ChatView } from "@/components/tasks/chat-view";
import { ContextDocsPanel } from "@/components/tasks/context-docs-panel";
import { EventStream } from "@/components/tasks/event-stream";
import { PhaseProgress } from "@/components/tasks/phase-progress";
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
import { useTaskWatch } from "@/hooks/use-task-watch";

import { getSettings } from "@/lib/local-store";
import { prepareBootArgs, prepareRunArgs } from "@/lib/run-args";
import {
  fetchTask,
  setTaskUiLayout,
  startWorkflow,
  submitPhaseAck,
  type ChatReplyImage,
  type StartWorkflowMode,
} from "@/lib/task-store";
import {
  PHASE_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  formatRepoPathsForDisplay,
} from "@/lib/task-display";
import { getEffectiveCwd } from "@/lib/path-utils";
import { WORKFLOWS, type PhaseId, type Task, type TaskEvent } from "@/lib/types";

const TaskDetailPage = () => {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // 任务对象（含 events / phases / status 等）
  const [task, setTask] = useState<Task | null>(null);
  // loaded：首次 fetchTask 完成；为 false 时显示「加载中」、避免闪 not-found
  const [loaded, setLoaded] = useState(false);
  // 用户当前在产物面板上看的 phase（独立于 currentPhase、允许翻看历史 phase）
  const [activePhase, setActivePhase] = useState<PhaseId>("plan");
  // 启动按钮 loading 态、提交期间 disable
  const [starting, setStarting] = useState(false);
  // 「再聊聊」对话框开关
  // 用户可能是想改 artifact、可能只是有疑问想问、AI 会先弹 ask_user 复述、再自己判断
  // draft 状态已下沉到 ReviseDialog 内部、page 不持、避免打字触发整页 re-render
  const [reviseOpen, setReviseOpen] = useState(false);
  // 「通过 / 再聊聊」按钮提交锁、防连点
  const [ackSubmitting, setAckSubmitting] = useState(false);
  // 流式打字态（assistant chunk 累加、收到正式 assistant_message 事件清空）
  // plan 模式跟 chat 一样需要、SDK 的 assistant_delta 也走这条
  const [streamingText, setStreamingText] = useState("");
  // V0.5：phase ack 高级选项 dialog 开关（点「通过 PHASE」按钮打开、内部配模型/换 agent）
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  // V0.5.7：「推进」dialog 开关——合并历史的「继续监听」 + 「重启 workflow」按钮入口
  // dialog 内部让用户选 resume / fork / restart 三种推进模式
  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  // SSE 重连 epoch：上次任务终态后服务端会关流、客户端 useTaskWatch 不会自动重连——
  // 任何让 agent 重新跑起来的成功路径（推进 / fork）++ 一下、让 useTaskWatch 重连
  // 不然得手动刷新页面才能看到 agent 新事件
  const [watchEpoch, setWatchEpoch] = useState(0);

  // ---- 拉一次任务详情 ----
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const t = await fetchTask(id);
      setTask(t);
      if (t) {
        // 默认看 currentPhase 的产物（即 agent 最近产出 / 在做的那一档）
        setActivePhase((prev) => (t.phases[prev] ? prev : t.currentPhase));
      }
    } catch (err) {
      toast.error(`加载任务失败：${(err as Error).message}`);
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // task.id / currentPhase 变化时把 activePhase 跟到 currentPhase
  // deps 故意只取原始字段、避免 task 整体引用变化触发反复重置
  useEffect(() => {
    if (!task) return;
    setActivePhase(task.currentPhase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.currentPhase]);

  // ---- 自动 watch SSE（plan + chat 通用、watch-chat 路由已放开 mode 校验） ----
  // chat 模式由 ChatView 自己订阅、这里 enabled=false 不重复
  // task.id 变化时 use-task-watch 内部 effect 会自然 abort 旧连接重连、外面切 task 时也清下 streaming
  useEffect(() => {
    setStreamingText("");
  }, [task?.id]);

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
      onDone: (t) => {
        setStreamingText("");
        setTask(t);
      },
      onAssistantDelta: (text) => setStreamingText((p) => p + text),
      onErrorMessage: (msg) => toast.error(`watch 出错：${msg}`),
      onWatchException: (err) => toast.error(`watch 异常：${err.message}`),
    },
    !!task && task.mode === "plan",
    watchEpoch,
  );

  // chat 模式给 ChatView 用的 setter（避免 ChatView 内部 setState 跟父组件 fight）
  const handleChatEventAppend = useCallback((ev: TaskEvent) => {
    setTask((prev) => {
      if (!prev) return prev;
      if (prev.events.some((e) => e.id === ev.id)) return prev;
      return { ...prev, events: [...prev.events, ev] };
    });
  }, []);

  // ---- 计算派生状态（必须在 if (!task) return 之前、避免 hooks order 报错） ----
  // chat 模式不用 workflow / phase 概念、走 ["plan"] 占位（PhaseProgress 不渲染）
  const workflowPhases: PhaseId[] = useMemo(() => {
    if (!task) return ["plan"];
    if (task.mode !== "plan") return ["plan"];
    const wf = task.workflowId ? WORKFLOWS[task.workflowId] : null;
    return wf?.phases ?? ["plan", "build", "review"];
  }, [task]);

  const activePhaseState = useMemo(
    () => task?.phases[activePhase],
    [task, activePhase],
  );

  // V0.5.4：ApprovePhaseDialog 的 defaultModel / apiKey 之前是 IIFE 每次 page re-render
  // 都重读 localStorage。SSE 频繁 setTask → 一秒读好几次 localStorage + JSON.parse、
  // 浪费 + 加重主线程开销。改成只在 dialog 打开瞬间读一次、关闭后忽略变化。
  // 用户在设置页改完模型、关掉 ApprovePhaseDialog 重开就能拿到最新值、足够。
  const approveDialogSettings = useMemo(() => {
    if (typeof window === "undefined" || !approveDialogOpen) return null;
    const s = getSettings();
    return {
      defaultModel: s.defaultModel?.id ? s.defaultModel : null,
      apiKey: s.apiKey ?? "",
    };
  }, [approveDialogOpen]);

  // V0.5.10：Resizable 分栏初始 size（artifact 栏百分比）
  // - 从 task.uiLayout.artifactPanelSize 读、没就默认 70（artifact 大、event-stream 小）
  // - ⚠️ react-resizable-panels 4.x 的 Panel.defaultSize/minSize/maxSize：
  //     数字 → px（lib.js:19-21 case "number": return [e, "px"]）
  //     字符串无单位 → %、`70%` 也 → %（lib.js:23 endsWith "%"）
  //   V0.5.10 hot-fix（实测踩坑）：之前传数字 70、库当成 70px、用户拖动看不出变化（minSize=20px / maxSize=80px 范围只有 60px、相对 1200px 视口几乎没动）
  //   正解：传字符串 "70%" 显式百分比
  const artifactSizePercent = useMemo(() => {
    const v = task?.uiLayout?.artifactPanelSize;
    if (typeof v === "number" && v >= 10 && v <= 90) return v;
    return 70;
  }, [task?.uiLayout?.artifactPanelSize]);

  // V0.5.10：debounce 写 task.uiLayout
  // - onLayoutChanged 是「释放鼠标后」触发（区别于 onLayoutChange 在拖动中高频触发）
  //   理论上释放后只触发一次、debounce 是双保险（用户连续点 reset / 拖动也只发最后一次）
  // - 500ms 窗口：用户体感不延迟、又避免高频 PATCH（拖动期间多次释放也只写最后一次）
  // - taskId 变化时清掉 pending timer、避免给新 task 写错布局
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeLayoutDebounced = useCallback(
    (taskId: string, artifactSize: number) => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        // 失败不 toast 不抛、布局偏好属于「锦上添花」、写挂了下次拖动还能重写
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

  const cur = task.currentPhase;
  const curStatus = task.phases[cur]?.status ?? "pending";
  const isChatMode = task.mode === "chat";

  // ---- V0.5.7：统一推进入口（合并历史的「启动 / 重启 workflow / 继续监听」）----
  //
  // mode 三选一、由 AdvanceDialog 让用户显式选：
  //   - resume  : 复用旧 agentId、保留对话历史。backend 拒（NGHTTP2_ENHANCE_YOUR_CALM）时
  //               plan-runner 内部自动降级 fork、用户视角一次推进就能续走
  //   - fork    : 起新 agent 从 fromPhase 接力（上游 artifact 复用）
  //   - restart : 起新 agent 从 Plan 完全重跑（覆盖现有 artifact）
  //
  // draft 状态（任务刚建、还没启动过）的特殊处理：
  //   - 不弹 AdvanceDialog（resume/fork 都不可用、唯一选项 restart 等同于「启动 workflow」）
  //   - 直接以 mode=restart 调 startWorkflow
  const handleAdvance = async (
    mode: StartWorkflowMode,
    fromPhase?: PhaseId,
    // V0.5.7.1：fork 时用户填的「想修什么 bug / 重启原因」、可空
    reason?: string,
  ) => {
    const args = prepareRunArgs(task);
    if (!args) return;
    if (!task.feishuStoryUrl && mode === "restart") {
      // 软警告：从头跑 + plan 模式没飞书 story 链接、agent Phase 1 没东西拉
      toast.warning("没填飞书 story 链接、Phase 1 上下文收集会跑空");
    }

    setStarting(true);
    try {
      const { task: latest, already } = await startWorkflow(
        task.id,
        args.apiKey,
        args.model,
        args.mcpServers,
        { mode, fromPhase, reason },
      );
      setTask(latest);
      setAdvanceDialogOpen(false);
      // 上次任务终态 watch-chat 服务端 bootstrap 完直接 close、客户端 SSE 已断、
      // ++ 这下让 useTaskWatch 重连、否则新 agent 推的事件没人收
      setWatchEpoch((n) => n + 1);
      if (already) {
        toast.info("workflow 已在跑、已为你接上事件流");
      } else if (mode === "resume") {
        toast.success("已叫醒原 agent 续接监听、马上能看到新事件");
      } else if (mode === "fork") {
        toast.success(
          `已起新 agent、从 ${PHASE_LABEL[fromPhase!]} 开始（上游 artifact 复用）`,
        );
      } else {
        toast.success("workflow 已启动、agent 从 Plan 开始一气跑到底");
      }
    } catch (err) {
      toast.error(`推进失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  // ---- Phase ack：通过（普通、同 agent 续跑、不计费）----
  const handleApprove = async () => {
    setAckSubmitting(true);
    try {
      const updated = await submitPhaseAck(task.id, "approve", undefined, cur);
      setTask(updated);
      toast.success(`${PHASE_LABEL[cur]} 已通过、agent 正在进入下一 phase`);
    } catch (err) {
      toast.error(`通过失败：${(err as Error).message}`);
    } finally {
      setAckSubmitting(false);
    }
  };

  // ---- V0.5 Phase ack：起新 agent 并通过（用户在 ApprovePhaseDialog 里点确认）----
  // 跟普通 approve 区别：透传 forkAgent + nextModel + bootArgs（apiKey + mcpServers）
  // 失败 toast 后 dialog 不关、让用户可以重试 / 改选项
  const handleApproveWithFork = async (opts: {
    forkAgent: boolean;
    nextModel: { id: string; params?: Array<{ id: string; value: string }> };
  }) => {
    if (!opts.forkAgent) {
      setApproveDialogOpen(false);
      await handleApprove();
      return;
    }
    // 复用 prepareBootArgs：跟 prepareRunArgs 共享「读 settings → 校验 apiKey →
    // parseMcpServers → filterMcpServersByTask」逻辑、唯一差别是不校验 model（dialog 里挑过了）
    // 失败已 toast、直接 return
    const boot = prepareBootArgs(task);
    if (!boot) return;

    setAckSubmitting(true);
    try {
      const updated = await submitPhaseAck(task.id, "approve", undefined, cur, {
        forkAgent: true,
        nextModel: opts.nextModel,
        bootArgs: { apiKey: boot.apiKey, mcpServers: boot.mcpServers },
      });
      setTask(updated);
      setApproveDialogOpen(false);
      // fork 启了新 agent、旧 SSE 连接可能在旧 run 结束时已收 done 关流、
      // ++ 让 useTaskWatch 重连接新 agent 的事件流
      setWatchEpoch((n) => n + 1);
      toast.success(
        `${PHASE_LABEL[cur]} 已通过、新 agent 已启动接管下一 phase`,
      );
    } catch (err) {
      toast.error(`通过失败：${(err as Error).message}`);
    } finally {
      setAckSubmitting(false);
    }
  };

  // ---- Phase ack：再聊聊（补充澄清、提改进意见、追问、纯答疑都走这条）
  // V0.5.2：协议层还是 [PHASE_ACK revise]、但 agent 拿到后会先 ask_user 复述、
  // 然后自己判断「用户是要改」还是「用户只是想问问」、改 → 动 artifact、问 → 仅答疑后回 wait_for_user
  // V0.5.4：draft state 下沉到 ReviseDialog 内部、本函数接收 feedback 文本 + 可选 images
  // 不 useCallback：本函数在 early return 之后定义、useCallback 会破坏 hooks order；
  // ReviseDialog 的 onSubmit 引用每次 re-render 都变没关系——子组件 draft state 内置、
  // 打字时本 page 根本不 re-render、不存在「ref 变 → 子重渲染」的卡顿路径
  // ----
  const handleSubmitRevise = async (
    feedback: string,
    images?: ChatReplyImage[],
  ) => {
    setAckSubmitting(true);
    try {
      const updated = await submitPhaseAck(
        task.id,
        "revise",
        feedback,
        cur,
        undefined,
        images,
      );
      setTask(updated);
      setReviseOpen(false);
      const suffix = images && images.length > 0 ? `（含 ${images.length} 张图）` : "";
      toast.success(
        `已发给 AI${suffix}、它会按你的意见调整 ${PHASE_LABEL[cur]} 的产物`,
      );
    } catch (err) {
      toast.error(`提交失败：${(err as Error).message}`);
    } finally {
      setAckSubmitting(false);
    }
  };

  // ---- 按钮渲染条件（plan 模式） ----
  // 「推进」按钮：draft / failed / completed / awaiting_user 四种状态显示
  // V0.5.7：合并历史的「启动 workflow / 重启 workflow / 继续监听」三个按钮
  //   - draft：唯一选项 restart、点了直接启动、不弹 dialog
  //   - 其它状态：弹 AdvanceDialog 让用户选 resume / fork / restart
  const canAdvance =
    task.status === "draft" ||
    task.status === "failed" ||
    task.status === "completed" ||
    task.status === "awaiting_user";

  // ack 按钮：当前 phase 处于 awaiting_ack（agent 等用户拍板）
  // V0.3.3：必须 task 也在 awaiting_user 状态、agent 才可能还活着
  //   - 早退场景下、phase=awaiting_ack 但 task=failed（agent 已死）、点 ack 会被 410 拒
  //   - 这种情况只显示「推进」按钮、不显示通过 / 修改
  const canAck =
    curStatus === "awaiting_ack" && task.status === "awaiting_user";

  // 「推进」按钮文案：draft 状态显示「启动 workflow」、其它显示「推进」
  const advanceLabel = (() => {
    if (starting) return "推进中…";
    if (task.status === "draft") return "启动 workflow";
    if (task.status === "completed") return "再跑一次";
    return "推进";
  })();

  // 「推进」按钮的入口逻辑：draft 直接启动、其它弹 dialog
  const handleAdvanceClick = () => {
    if (task.status === "draft") {
      void handleAdvance("restart");
    } else {
      setAdvanceDialogOpen(true);
    }
  };

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
                <Badge variant={STATUS_VARIANT[task.status]}>
                  {STATUS_LABEL[task.status]}
                </Badge>
              </div>
              <div
                className="text-xs text-muted-foreground"
                title={task.repoPaths.join("\n")}
              >
                {formatRepoPathsForDisplay(task.repoPaths)}
              </div>
            </div>
          </div>

          {/* 主操作区：plan 模式才显示、chat 模式启动在 ChatView 头部 */}
          {!isChatMode && (
            <div className="flex items-center gap-2">
              {canAdvance && (
                <Button
                  // awaiting_user 状态下用 ghost 让位给「通过 PHASE」（主操作）
                  // 其它状态下保持 default（无主操作竞争）
                  variant={
                    task.status === "awaiting_user" ? "ghost" : "default"
                  }
                  size="sm"
                  onClick={handleAdvanceClick}
                  disabled={starting}
                  title={
                    task.status === "draft"
                      ? "启动 workflow run、agent 自动跑 plan → build → review、phase 间会停下来等你 ack"
                      : "推进 workflow：让原 agent 续接 / 起新 agent 接力 / 从头重跑、由你选"
                  }
                >
                  {starting ? <Loader2 className="animate-spin" /> : <Zap />}
                  {advanceLabel}
                </Button>
              )}
              {canAck && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReviseOpen(true)}
                    disabled={ackSubmitting}
                    title={`想改 ${PHASE_LABEL[cur]} 产物、或对它有疑问想问问——都走这里。AI 会先弹窗复述、然后自己判断要不要改`}
                  >
                    <MessageCircleQuestion />
                    再聊聊
                  </Button>
                  {/* 通过 PHASE：直接打开 dialog 让用户配「下一 phase 模型 / 换 agent」、再通过
                      之前试过 ack 行内 inline 配置、用户拍板：逻辑走通先、UI 优化后说 */}
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => setApproveDialogOpen(true)}
                    disabled={ackSubmitting}
                    title={`通过 ${PHASE_LABEL[cur]} 的产物、确认下一 phase 用哪个模型`}
                  >
                    {ackSubmitting ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <CheckCircle2 />
                    )}
                    通过 {PHASE_LABEL[cur]}
                  </Button>
                </>
              )}
              {/* running 状态显示一个静默的 loading 状态条、不挂按钮 */}
              {task.status === "running" && !canAdvance && !canAck && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  agent 正在跑 {PHASE_LABEL[cur]}
                </div>
              )}
            </div>
          )}
        </div>
        {/* 上下文文档 + MCP：两个紧凑按钮、点击各自弹 Dialog
            不再占顶部高度、内容区不被挤
            V0.4：chat 模式也展示 ContextDocsPanel（用户可随时补 / 删上下文给 agent） */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ContextDocsPanel task={task} onTaskUpdate={setTask} />
          <TaskMcpPanel task={task} />
        </div>
        {/* phase 进度条：plan 模式才有 */}
        {!isChatMode && (
          <div className="mt-3">
            <PhaseProgress
              phaseOrder={workflowPhases}
              phases={task.phases}
              currentPhase={task.currentPhase}
              activePhase={activePhase}
              onActivePhaseChange={setActivePhase}
            />
          </div>
        )}
      </div>

      <Separator />

      {/* 主区 */}
      {isChatMode ? (
        <div className="flex flex-1 min-h-0">
          <ChatView
            task={task}
            onTaskUpdate={setTask}
            onEventAppend={handleChatEventAppend}
          />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/*
            V0.5.10：左右双栏支持拖拽调宽
            - key={task.id}：切 task 时整个 Group 重建、initialArtifactSize 重新生效
              （react-resizable-panels 4.x 的 defaultSize 只在 mount 时读、改 prop 不会同步）
            - id="task-layout-{task.id}"：给 group 一个稳定 id、防 React Strict mode 警告
            - onLayoutChanged 释放鼠标后触发（区别于 onLayoutChange 在拖动中高频触发）、debounce 写 task.uiLayout
            - 左 artifact：minSize=20（保留可读宽度）/ maxSize=80
            - 右 event-stream：minSize=20 / maxSize=80（两边都用 20 让用户能极限调）
          */}
          <ResizablePanelGroup
            key={task.id}
            id={`task-layout-${task.id}`}
            orientation="horizontal"
            onLayoutChanged={(layout) => {
              // layout[panelId] = 百分比（0..100）、d.ts L43-45 注释明确
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
                {activePhaseState ? (
                  <ArtifactPanel
                    phase={activePhaseState}
                    // V0.5.12：artifact-panel 内部要 fetch revisions / diff、需要 task id
                    taskId={task.id}
                    // V0.5.9：单仓 = 仓本身、多仓 = 公共父目录、buildCursorLink 用这个拼相对路径
                    baseDir={getEffectiveCwd(task.repoPaths)}
                    onArtifactRefClick={setActivePhase}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    <Sparkles className="mr-2 size-4" />
                    该阶段数据缺失
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
                {/* hideReplyComposer=true：plan 模式不要 free-form 输入框、HITL 走顶部 ack 按钮 */}
                <EventStream
                  task={task}
                  streamingText={streamingText}
                  hideReplyComposer
                />
              </aside>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      {/* AskUserDialog：agent 调 ask_user 时弹窗、统一渲染（chat + plan 两个模式都用、用户拍板） */}
      <AskUserDialog task={task} />

      {/* V0.5：phase ack 配置 dialog（点「通过 PHASE」按钮打开、配下一 phase 模型 / 换 agent）
          defaultModel / apiKey 走 approveDialogSettings useMemo、只在 dialog 打开瞬间读一次 */}
      <ApprovePhaseDialog
        open={approveDialogOpen}
        onOpenChange={setApproveDialogOpen}
        phaseId={cur}
        defaultModel={approveDialogSettings?.defaultModel ?? null}
        apiKey={approveDialogSettings?.apiKey ?? ""}
        onSubmit={handleApproveWithFork}
        submitting={ackSubmitting}
      />

      {/* 再聊聊 Dialog（plan 模式专用、想改 artifact 或想答疑都走这里）
          draft state 在子组件内部、打字不触发本 page re-render、输入流畅 */}
      <ReviseDialog
        open={reviseOpen}
        onOpenChange={setReviseOpen}
        phaseLabel={PHASE_LABEL[cur]}
        submitting={ackSubmitting}
        onSubmit={handleSubmitRevise}
      />

      {/* V0.5.7：推进 dialog（合并历史的「继续监听 / 重启 workflow」按钮入口）
          用户选 resume / fork / restart 三种推进模式之一、详情见 advance-dialog.tsx */}
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
