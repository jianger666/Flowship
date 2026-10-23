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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { usePanelRef } from "react-resizable-panels";
import {
  ChevronLeft,
  Flag,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { MrInboxTaskBanner } from "@/components/mr-inbox/mr-inbox-task-banner";
import { ActionWorkbenchHeader } from "@/components/tasks/action-workbench-header";
import { AdvanceDialog } from "@/components/tasks/advance-dialog";
import { ArtifactPanel } from "@/components/tasks/artifact-panel";
import { BatchProgress } from "@/components/tasks/batch-progress";
import { ChatView } from "@/components/tasks/chat-view";
import { ContextDocsPanel } from "@/components/tasks/context-docs-panel";
import { EditTaskDialog } from "@/components/tasks/edit-task-dialog";
import {
  SmoothEventStream,
  type SmoothStreamControls,
} from "@/components/tasks/smooth-event-stream";
import { StreamActionsProvider } from "@/components/tasks/event-stream/stream-actions";
import {
  buildResendPayload,
  findLastUserReply,
} from "@/components/tasks/event-stream/resend-payload";
import { TaskMcpPanel } from "@/components/tasks/task-mcp-panel";
import { TASK_SEEN_EVENT } from "@/components/tasks/task-list-item";
import { TaskChangesPanel } from "@/components/tasks/task-changes-panel";
import { TaskUtilityActions } from "@/components/tasks/task-utility-actions";
import { TalkQueueBanner } from "@/components/tasks/talk-queue-banner";
import { TaskTalkComposer } from "@/components/tasks/task-talk-composer";
import { ScheduleChip } from "@/components/tasks/schedule-chip";
import type { TalkQueueItem } from "@/lib/talk-queue";
import type { AssistantSnapshot } from "@/lib/assistant-live";
import { stopConfirmDescription, stoppableQueuedCount } from "@/lib/stop-copy";
import { WorkspaceActions } from "@/components/tasks/workspace-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import { useTaskList } from "@/hooks/use-task-list";
import { useTaskWarmup } from "@/hooks/use-task-warmup";
import { useUiPerfReporter } from "@/hooks/use-ui-perf-reporter";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { useLiveToolOutputs } from "@/hooks/use-live-tool-outputs";
import { findPendingAskEvent } from "@/lib/ask-pending";
import {
  latestActionId,
  resolveSelectedActionOnChange,
} from "@/lib/action-selection";
import { describeCorruptTask } from "@/lib/corrupt-task-display";
import {
  deriveTaskHeaderRunBadge,
  taskStopButtonView,
} from "@/lib/task-header-status";
import {
  ARTIFACT_PANEL_MAX_PERCENT,
  EVENT_STREAM_MIN_PX,
  isArtifactCollapsedSize,
  isValidArtifactPanelSize,
  resolveArtifactDefaultPercent,
} from "@/lib/task-split-layout";
import { isEphemeralToolOutputDelta } from "@/lib/tool-display";

import { getSettings } from "@/lib/local-store";
import {
  BUILTIN_FIX_BUG_ACTION_ID,
  buildFixBugInstruction,
} from "@/lib/mr-inbox";
import { advanceErrorMessage, planAdvanceUi } from "@/lib/advance-submit";
import {
  classifyTaskDetailResult,
  type LoadOutcome,
} from "@/lib/load-outcome";
import { setArtifactPaneCollapsed } from "@/lib/pane-search";
import {
  createUserResizeIntent,
  isSeparatorTarget,
  shouldRecordResizePointerDown,
} from "@/lib/user-resize-intent";
import { prepareRunArgs } from "@/lib/run-args";
import { isLightweightDailyTask } from "@/lib/lightweight-task";
import {
  isTestingTask,
  isTestingRequirementTask,
  testingTaskMissingBranchRepoPaths,
} from "@/lib/testing-task";
import {
  fetchTask,
  finalizeTask,
  getPendingQuestionSend,
  appendTaskEvent,
  applyRewoundResult,
  lastRewindNeedsResync,
  mergeTaskEvents,
  replaceTaskEventsWithSnapshot,
  reopenTask,
  rewindNeedsResync,
  setActionExcluded,
  setTaskUiLayout,
  stopTask,
  submitTaskQuestion,
  type ImagePayload,
  type RewoundResult,
} from "@/lib/task-store";
import { reconcileRunActive, watchDormantToastId } from "@/lib/watch-reconnect";
import {
  deriveRunFlags,
  planDoneFrame,
  shouldClearStreamingOnEvent,
} from "@/lib/owner-run-signal";
import { resolveSessionModel, talkForceModel } from "@/lib/task-model";
import { loadTalkOverride } from "@/lib/talk-model-override";
import {
  canCommitTaskSnapshot,
  commitTaskDeleted,
} from "@/lib/task-terminal";
import {
  actionDisplayLabel,
  getActionExcludeConfirmCopy,
  REPO_STATUS_LABEL,
  REPO_STATUS_VARIANT,
  deriveEffectiveBatches,
  isStopButtonVisible,
} from "@/lib/task-display";
import {
  getEffectiveCwd,
  getRepoShortNames,
  getUniqueRepoDirNames,
  type ActionArtifactRef,
} from "@/lib/path-utils";
import { markTaskSeen, rememberLastChat, rememberLastWork } from "@/lib/view-memory";
import type {
  ActionRecord,
  ActionType,
  DevPushMode,
  ModelSelection,
  Task,
  TaskEvent,
} from "@/lib/types";

// 打开任务默认只加载最近这么多条事件（更早的上拉分页、v1.0.x 事件懒加载）
const EVENT_TAIL = 300;

const TaskDetailPage = () => {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id;
  // 任务对象（V0.6 含 actions / mrs / repoStatus / runStatus 等）
  const [task, setTask] = useState<Task | null>(null);
  // 首次 fetchTask 完成、为 false 时显示加载占位
  const [loaded, setLoaded] = useState(false);
  // 首次加载失败的原因（网络错误 / 5xx / 503 等「不确定」的失败）：有值 = 画「加载失败 + 重试」，
  // 而不是「任务不存在」——只有 404 / 410（服务端确定没有）才画不存在，见 lib/load-outcome
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  // 用户当前在产物面板上看的 action（null = 没选、默认走 task.currentActionId）
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  // selectedActionId 属于哪个 task；切 task 时必须重置，避免不同 task 复用 act_1/act_2 造成误定位
  const selectedActionTaskIdRef = useRef<string | null>(null);
  // 推进按钮 loading 态
  const [starting, setStarting] = useState(false);
  // 流式打字态（assistant chunk 累加、收到 assistant_message 事件清空）。
  // Codex 式平滑追赶 + rAF 合帧逻辑在 use-smooth-streaming.ts（与 ChatView 共用）；但它的逐帧 state
  // **不放在页面里**——放这儿 AI 每吐一帧整个页面（含产物栏整篇 markdown）都跟着重渲（V11-07）。
  // 现在 state 住在 SmoothEventStream 里，页面只留两个身份稳定的转发函数（空依赖 → controlsRef），
  // SSE 回调 / 各处 effect 的依赖不会因此抖动。
  const streamControlsRef = useRef<SmoothStreamControls | null>(null);
  const pushDelta = useCallback((text: string) => {
    streamControlsRef.current?.pushDelta(text);
  }, []);
  const clearStreaming = useCallback(() => {
    streamControlsRef.current?.clearStreaming();
  }, []);
  // 每次（重）连接 bootstrap 的「进行中正文」快照（assistant_snapshot）：切走再切回 / 重连后立刻铺上已生成的全部
  const applyAssistantSnapshot = useCallback((snap: AssistantSnapshot | null) => {
    streamControlsRef.current?.applySnapshot(snap);
  }, []);
  // 运行中 shell 的直播输出（callId → 尾部 20 行，ephemeral、不进 task.events）；与 ChatView 共用同一个 hook。
  // 只当 prop 传给 EventStream，别拿它喂要扫全量 events 的 memo（HANDOFF「别进 activeStatus memo」）
  const { liveToolOutputs, absorbLiveToolOutputEvent, clearLiveToolOutputs } =
    useLiveToolOutputs();
  // 旁路（需求群受限答疑）run 在不在飞：不再进页面状态（第四轮 Q5-01）——它的过程事件整条被
  // isHiddenFromEventStream 藏进「群问答」tab，主流里没有旁路工具块要画；并进「运行中」只会让组尾冒出
  // 「处理中…」转圈。SSE 的 restricted_run 帧仍会发，只是页面不消费。
  // 主 run 进行中 latch：runStatus 一进入 running 就锁上，只在 done 事件（或重连时服务端快照校准）才松。
  // 服务端已经让「交卷后收尾旁白还在跑」期间 runStatus 保持 running（task-runner 的 runActionPostCheck 里
  // wrapUpStillGoing：交卷当下 action 变 awaiting_ack，runStatus 等旁白 consume 结束才补成 awaiting_user），
  // 所以正常路径下 runStatus 自己就跨得过这段流式窗口；这个 latch 留作兜底（漏帧 / 旧快照先到），
  // 让输入条 / 事件流的「运行中」不至于在流式尾巴里提前熄灭。
  const [runActive, setRunActive] = useState(false);
  // 「推进」dialog 开关——V0.6.0.1 末段砍掉 ActionTimeline retry 入口、所有推进都从顶部按钮进、不再有预填
  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  // 收件箱「改bug」深链带来的指令 + 预选 custom action（打开 dialog 后消费掉）
  const [advancePrefill, setAdvancePrefill] = useState<{
    instruction?: string;
    customActionId?: string;
  } | null>(null);
  // 推进失败的完整原因（弹窗内展示、不截断）：失败不再关弹窗，用户在原地看原因、改了直接重试，
  // 指令 / 附图不丢。新一轮提交 / 弹窗关闭时清掉
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  // SSE 重连 epoch：任意「让 agent 又活起来」的路径 ++、useTaskWatch 重连
  const [watchEpoch, setWatchEpoch] = useState(0);
  // 「停止」按钮提交锁——中断 running agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);
  // 群问答 tab 可见时隐藏底部输入条（只读 tab 下输入框会误导用户在此发言）
  const [groupQaVisible, setGroupQaVisible] = useState(false);
  // task 模式待送达队列（SSE talk_queue 帧维护整份快照；切任务清空，新任务 bootstrap 会补发）
  const [talkQueue, setTalkQueue] = useState<TalkQueueItem[]>([]);
  // V0.6.6「编辑任务」dialog 开关（改角色 / 标题 / 飞书链接 / 模型 / 工作分支）
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // 任务输入条乐观占位行（HTTP 回来前事件流先出半透明气泡；按 taskId+nonce 隔离，
  // 同文案连发不互撤）
  const [pendingTalkRows, setPendingTalkRows] = useState<
    Array<{
      taskId: string;
      nonce: string;
      text: string;
      displayText: string;
      at: number;
    }>
  >([]);
  const addTalkPending = useCallback(
    (p: { taskId: string; nonce: string; text: string; displayText: string }) => {
      setPendingTalkRows((prev) => {
        // 同 nonce 幂等（跨挂载认领重加不叠行）；顺手清掉别的任务的残留
        const rest = prev.filter(
          (r) => r.taskId !== p.taskId || r.nonce !== p.nonce,
        );
        return [...rest, { ...p, at: Date.now() }];
      });
    },
    [],
  );
  const removeTalkPending = useCallback(
    (p: { taskId: string; nonce: string }) => {
      setPendingTalkRows((prev) =>
        prev.filter((r) => r.taskId !== p.taskId || r.nonce !== p.nonce),
      );
    },
    [],
  );
  // 全局 confirm hook（终结任务 / 停止 / 划除二次确认用）
  const { confirm } = useDialog();
  // 侧栏全局任务列表：把当前任务关键状态同步进去（侧栏运行态实时 + 触发条件轮询）
  // corrupt：meta.json 损坏的任务清单——损坏任务的详情接口回 503，页面「加载失败」分支靠它认出并说人话（F3-02 尾巴）
  const { upsertTask, corrupt } = useTaskList();

  // 当前路由 id 的 ref——快切时 in-flight refresh / 旧 SSE 回调仍持旧闭包，
  // 必须用 ref 比对「响应是否仍属当前页」，不能只靠 absorbTask 的 useCallback(id)
  const routeIdRef = useRef(id);
  routeIdRef.current = id;
  // onDone 判断过期快照用：setState 里读不到最新 task
  const taskRef = useRef<Task | null>(null);
  taskRef.current = task;
  // absorbTask（deps 为空）要调后面才声明的 resyncEvents：经 ref 转一道，且 resyncEvents 随 id 变也不会拿到旧闭包
  const resyncEventsRef = useRef<(() => Promise<void>) | null>(null);
  // 最近一次因「本地没见过的回退」触发重拉的标识（task id + lastRewind.ts），同一次回退只重拉一次
  const rewindResyncKeyRef = useRef<string | null>(null);

  // 统一 terminal sink——SSE task_deleted / watch 410 / 已 hydrate 的 404
  // 只调 commitTaskDeleted（503 unavailable 不进此 sink）
  // （列表 epoch / sticky 由 coordinator 通知；本页清 state；chat pending 由 ChatView 先清）
  const handleTaskDeleted = useCallback((deletedId: string) => {
    commitTaskDeleted(deletedId);
    if (deletedId !== routeIdRef.current) return;
    clearStreaming();
    setTask(null);
    toast.message("任务已被删除");
  }, [clearStreaming]);

  // 侧栏 A→B 快切：立刻清本地态，避免短暂显示 A 的内容盖在 B 的 URL 上
  useEffect(() => {
    setTask(null);
    setLoaded(false);
    setLoadFailure(null);
    clearStreaming();
    setSelectedActionId(null);
    setTalkQueue([]);
    setRunActive(false);
    // 折叠态属于上一个任务的 Group（key=task.id、切任务会重挂）；新 Group 总是展开着挂
    setArtifactCollapsed(false);
  }, [id, clearStreaming]);

  // run 进行中 latch：runStatus 一旦进入 running 就锁上、直到 done 事件才松——
  // 交卷后（awaiting_ack）run 还在流式吐消息时、输入条 loading 不会提前关掉。
  useEffect(() => {
    if (task?.runStatus === "running") setRunActive(true);
  }, [task?.runStatus]);

  // v1.0.x 事件懒加载：所有「服务端 task 快照 → 本地 state」都走 absorbTask、
  // events 按 id 并集（本地可能已上拉加载了更早分页、直接 setTask(next) 会把历史冲掉）
  // 审查发现快切竞态：丢弃 payload.id !== 当前路由 id 的迟到数据（守卫在组件层，
  // mergeTaskEvents 在 prev.id!==next.id 时 return next，不能靠它挡串任务）
  // sticky deleted → 丢弃迟到 detail / chat mutation 200，禁止复活
  const absorbTask = useCallback((next: Task | null) => {
    if (!next) {
      setTask(null);
      return;
    }
    if (!canCommitTaskSnapshot(next.id)) return;
    if (next.id !== routeIdRef.current) return;
    // 带着一次本地没见过的回退、而本地没有它的标记事件（标记被挤出了断线重连的 bootstrap 窗口）：
    // 本地事件窗口不可信，完整重新拉取并整体替换（D9-04）。必须用合并**前**的本地态判定——
    // 合并会把 lastRewind 推进到 next 的；resyncKey 再兜一层：同一次回退只重拉一次（含重拉失败后的后续帧）
    const cur = taskRef.current;
    const lr = next.lastRewind;
    if (cur && lr && lastRewindNeedsResync(cur, next)) {
      const key = `${next.id}:${lr.ts}`;
      if (rewindResyncKeyRef.current !== key) {
        rewindResyncKeyRef.current = key;
        void resyncEventsRef.current?.();
      }
    }
    setTask((prev) => mergeTaskEvents(prev, next));
  }, []);

  // v1.0.x：上拉分页拉到的更早事件、插到本地事件列表头部（按 id 去重）
  const handlePrependEvents = useCallback((older: TaskEvent[]) => {
    if (older.length === 0) return;
    setTask((prev) => {
      if (!prev) return prev;
      const known = new Set(prev.events.map((e) => e.id));
      const fresh = older.filter((e) => !known.has(e.id));
      if (fresh.length === 0) return prev;
      return { ...prev, events: [...fresh, ...prev.events] };
    });
  }, []);

  // ---- 拉一次任务详情（只带最近 EVENT_TAIL 条、更早的上拉分页）----
  const refresh = useCallback(async () => {
    if (!id) return;
    const requestedId = id;
    // 先把结果归类（ok / notFound / error）再决定画什么——
    // 以前 catch 一律 toast 后落到 task=null，页面画「任务不存在或已删除」：
    // 503 / 断网时对用户说谎（任务其实还在），且没有重试
    let fetched: Task | null = null;
    let outcome: LoadOutcome;
    try {
      fetched = await fetchTask(requestedId, { tail: EVENT_TAIL, anchored: true });
      outcome = classifyTaskDetailResult({ task: fetched });
    } catch (err) {
      outcome = classifyTaskDetailResult({ error: err });
    }
    // 快切后迟到响应：不 absorb、也不把 loaded 置 true（留给当前 id 自己的 refresh）
    if (routeIdRef.current !== requestedId) return;
    if (outcome.kind === "ok") {
      absorbTask(fetched);
      setLoadFailure(null);
    } else if (outcome.kind === "notFound") {
      // 404 / 410：服务端确定没有 / 已删除
      absorbTask(null);
      setLoadFailure(null);
    } else if (taskRef.current?.id === requestedId) {
      // 页面已有内容（只是这次刷新失败）：保留现有内容、toast 提示即可，别拿失败态盖掉能用的页面
      toast.error(`加载任务失败：${outcome.message}`);
    } else {
      // 首次加载就失败、没有内容可画：失败态 + 重试（不 toast——页面本身已说明原因）
      setLoadFailure(outcome.message);
    }
    setLoaded(true);
  }, [id, absorbTask]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 回退后本地事件窗口对不齐（见 rewind-marker.ts）：完整重新拉取一次并「整体替换」本地事件
  // （不能走 absorbTask——merge 只增不换，快照里没有回退标记时删不掉本地的过期后半段）
  const resyncEvents = useCallback(async () => {
    if (!id) return;
    const requestedId = id;
    try {
      const t = await fetchTask(requestedId, { tail: EVENT_TAIL, anchored: true });
      if (!t || routeIdRef.current !== requestedId) return;
      if (!canCommitTaskSnapshot(t.id)) return;
      setTask((prev) =>
        prev && prev.id === t.id ? replaceTaskEventsWithSnapshot(prev, t) : prev,
      );
    } catch (err) {
      if (routeIdRef.current !== requestedId) return;
      toast.error(`刷新任务失败：${(err as Error).message}`);
    }
  }, [id]);
  resyncEventsRef.current = resyncEvents;

  // 把当前任务的关键状态同步进侧栏全局列表（任务 + 对话模式都经过这里）：
  //  1) 你正在看的这个任务、侧栏的转圈 / 等你回复点实时准（不等轮询）
  //  2) 让 useTaskList「知道」有任务在跑 → 触发它的条件轮询去刷后台其它任务
  // 仅依赖影响侧栏展示 / 轮询触发的关键字段、不随 events 高频 setState 全列表重渲染
  // 对话换工作目录（ChatWorkdirPicker）= 侧栏要换仓组；不进依赖的话行会一直待在旧组（常是
  // 最底下的 Home）、直到下次整表刷新才挪走
  const repoPathsKey = task?.repoPaths?.join("\n");
  useEffect(() => {
    // deleted terminal 后不得把侧栏回灌
    if (task && canCommitTaskSnapshot(task.id)) upsertTask(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    task?.id,
    task?.runStatus,
    task?.repoStatus,
    task?.currentActionId,
    task?.title,
    task?.pinned,
    task?.actions.length,
    repoPathsKey,
  ]);

  // 记住「最后浏览的对话 / 工作台任务」（v1.1.x）：胶囊切回对应模式时优先落它
  // 对话 → /chats 落最后对话；工作台 → 胶囊落最后任务、而不是每次都回甘特
  useEffect(() => {
    if (!task?.id) return;
    if (task.mode === "chat") rememberLastChat(task.id);
    else rememberLastWork(task.id);
  }, [task?.id, task?.mode]);

  // 已读上报（v1.1.x「待确认」已读即清）：正在看这个任务 = 交卷动静都算已读、
  // 侧栏「待确认」标记 / 琥珀点随之熄灭（依赖 updatedAt：页内新交卷也即时算已读）
  useEffect(() => {
    if (!task?.id) return;
    markTaskSeen(task.id);
    // 同页侧栏靠此事件重读 localStorage（storage 事件不会在本 tab 触发）
    window.dispatchEvent(new Event(TASK_SEEN_EVENT));
  }, [task?.id, task?.updatedAt]);

  // 收件箱「改bug」主路径深链（命中开发中任务 / 新建引流都走这里）：
  // ?advance=fix-bug&bugTitle=&bugUrl=&storyName= → 打开推进 dialog、预填 bug 指令 + 预选「改bug」action；
  // 随后清掉 query 防刷新重复弹。用户在弹窗里确认 / 调模型后自己启动。
  // 一次性消费标记：router.replace 清参完成前 effect 可能因 task / searchParams 变化重跑，
  // 不加标记会重开用户刚关掉的弹窗、冲掉草稿（token 含 id，切 task 自动失效）
  const fixBugDeepLinkConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    if (searchParams.get("advance") !== "fix-bug") {
      // 清参落地后复位：同一 bug 之后再次深链（相同 query）仍能触发
      fixBugDeepLinkConsumedRef.current = null;
      return;
    }
    const token = `${id}|${searchParams.toString()}`;
    if (fixBugDeepLinkConsumedRef.current === token) return;
    // task 未加载完先等（不消费、下轮重试）
    if (!task) return;
    fixBugDeepLinkConsumedRef.current = token;
    // 与「推进」按钮的 canAdvance 口径对齐：chat 模式 / running / 终态 / 等提问答案不开弹窗
    //（深链不能绕过叠跑推进、也不能绕开未答的 ask）
    const deepLinkAwaitingAsk = !!findPendingAskEvent(task.events);
    const advanceable =
      task.mode !== "chat" &&
      !deepLinkAwaitingAsk &&
      task.runStatus !== "running" &&
      task.repoStatus !== "merged" &&
      task.repoStatus !== "abandoned";
    if (advanceable) {
      const bugTitle = searchParams.get("bugTitle") ?? "";
      const bugUrl = searchParams.get("bugUrl") ?? "";
      const storyName = searchParams.get("storyName") ?? undefined;
      setAdvancePrefill({
        instruction: buildFixBugInstruction({ bugTitle, bugUrl, storyName }),
        // 预选出厂「改bug」；弹窗内若列表没有该 id（被删）会忽略、只留指令
        customActionId: BUILTIN_FIX_BUG_ACTION_ID,
      });
      setAdvanceDialogOpen(true);
    } else if (task.runStatus === "running") {
      toast.info("任务正在运行中，等它跑完再推进改bug");
    } else if (deepLinkAwaitingAsk) {
      toast.info("AI 在等你回答提问，先回复后再推进");
    } else if (task.mode !== "chat") {
      toast.info("任务已是终态（已合入 / 已放弃），恢复后才能推进");
    }
    // 不可推进也清 query：避免 URL 残留 ?advance=fix-bug 之后误触发
    router.replace(`/tasks/${id}`, { scroll: false });
  }, [task, id, searchParams, router]);

  // 选中态怎么跟 action 列表（判定在 lib/action-selection 的 resolveSelectedActionOnChange，有单测）：
  //  - 当前没选 / 选的 action 已被 GC：回到 currentActionId；
  //  - wasLatest（V18-03）：用户原本就选着「上一次的最新条」、现在出现了更新的 action
  //    （飞书群里推进 / 另一个窗口推进——本页推进弹窗走 handleAdvance 自己直接选新的）→ 跟到新的最新条，
  //    不然右栏事件流在输出 build、左栏产物区还停在方案；
  //  - 用户手动选了更早的 action：不动，不抢他正在看的东西。
  // prevLatestActionIdRef 记着上一次 effect 跑完时的最新条 id，用来判断「用户当时选的是不是最新」
  const prevLatestActionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!task) return;
    const latestId = latestActionId(task.actions);
    if (selectedActionTaskIdRef.current !== task.id) {
      // 切到新 task：默认选中最后一个（最近）action、直接看最新产物——
      // 不用 currentActionId（idle 时它可能为空 / 指向较早的步）
      selectedActionTaskIdRef.current = task.id;
      prevLatestActionIdRef.current = latestId;
      setSelectedActionId(latestId ?? task.currentActionId ?? null);
      return;
    }
    const next = resolveSelectedActionOnChange({
      selectedActionId,
      actions: task.actions,
      currentActionId: task.currentActionId,
      prevLatestId: prevLatestActionIdRef.current,
    });
    prevLatestActionIdRef.current = latestId;
    if (next !== undefined) setSelectedActionId(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.currentActionId, task?.actions.length]);

  // v1.9.28：进入页面 / 窗口回到前台 / 聚焦输入框时后台预热（探活缓存 + 会话存储预读），
  // 让首条消息少等一轮冷启动。页面级只挂这一处（chat / task 两种模式都渲染本页）
  useTaskWarmup(task?.id);
  // v1.9.28：前端流畅度观测（长任务 / 慢交互 / 回前台追赶 / 页面规模）→ ui-perf.jsonl，
  // 只在有信号时上报、没信号时低频抽样；任何失败都静默、不影响页面
  useUiPerfReporter(task?.id);

  // 切任务：上个任务运行中 shell 的尾行不能串到新任务
  useEffect(() => {
    clearLiveToolOutputs();
  }, [task?.id, clearLiveToolOutputs]);

  // ---- 自动 watch SSE ----
  // V0.6.0.1：chat 模式 task 走 ChatView 内部自己的 useTaskWatch（避免父子两份订阅重复 setTask）
  // 这里只在 task 模式下订阅
  useTaskWatch(
    task?.id,
    {
      onEvent: (ev, meta) => {
        // ephemeral tool_output_delta 不进 task.events：累积进直播缓冲后到此为止；
        // tool_result 会顺手清掉该 callId 的缓冲、但仍要继续往下走正常落进 events
        if (absorbLiveToolOutputEvent(ev)) return;
        // 只有属主主链的 assistant_message 落盘才清流式气泡：旁路群答疑 run（meta.groupRun）与主 run 并存，
        // 它的回答落盘不该把属主正在吐的字清掉（D9-01）
        // bootstrap 回放的历史尾部（meta.replay）同样不清——由紧随其后的 assistant_snapshot 对齐（见 shouldClearStreamingOnEvent）
        if (shouldClearStreamingOnEvent(ev, meta)) clearStreaming();
        setTask((prev) => {
          if (!prev) return prev;
          if (prev.events.some((e) => e.id === ev.id)) return prev;
          return { ...prev, events: [...prev.events, ev] };
        });
      },
      onTaskUpdate: absorbTask,
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
      onDone: (t, _ok, origin) => {
        // 判定在 owner-run-signal.planDoneFrame（有单测）：
        //  - 旁路群答疑 run 的 done（origin）不动属主的流式气泡 / run latch（D9-01）；
        //  - 过期失败 done 不得解锁：唤醒后 running 已到、迟到的 error 快照会把输入条打开
        const plan = planDoneFrame({
          origin,
          doneUpdatedAt: t.updatedAt,
          currentUpdatedAt: taskRef.current?.updatedAt,
          runStatus: t.runStatus,
        });
        if (plan.clearStreaming) clearStreaming();
        if (!plan.absorbSnapshot) return;
        absorbTask(t);
        if (plan.releaseRunLatch) {
          setRunActive(false);
          // run 收尾：没等到 tool_result 的直播缓冲（中断 / 掉线）不能一直挂着
          clearLiveToolOutputs();
        }
      },
      onAssistantDelta: pushDelta,
      onAssistantSnapshot: applyAssistantSnapshot,
      onTalkQueue: setTalkQueue,
      onErrorMessage: (msg) => toast.error(`watch 出错：${msg}`),
      // resume 有值 = 重试预算耗尽、已休眠：挂「重连」按钮并常驻，别让用户面对静默停更的页面
      // 稳定 id：同一任务重复休眠只原位更新、不叠加；连接恢复 / 卸载 / 切任务时由 onWatchDormantEnd 撤掉
      onWatchException: (err, resume) =>
        toast.error(
          `watch 异常：${err.message}`,
          resume
            ? {
                id: watchDormantToastId("task", task?.id ?? ""),
                action: { label: "重连", onClick: resume },
                duration: Infinity,
              }
            : undefined,
        ),
      onWatchDormantEnd: (taskId) =>
        toast.dismiss(watchDormantToastId("task", taskId)),
      // 重连 / 休眠唤醒后的服务端快照校准 run latch：断线期间漏了 done 也不会一直卡「运行中」
      onBootstrapSnapshot: (t) =>
        setRunActive((prev) => reconcileRunActive(prev, t.runStatus)),
      onTaskDeleted: handleTaskDeleted,
    },
    !!task && task.mode !== "chat",
    watchEpoch,
  );

  // ---- 派生状态 ----
  // 下面 selectedAction / effectiveBatches / priorPlans 只依赖 task.actions、不依赖整个 task：
  // 事件追加会让 task 换引用、但 actions 引用不变——依赖整个 task 的话，AI 每吐一条事件都重算一遍，
  // 还会给 ArtifactPanel 递新 props（V11-07）。⚠️ 别把 liveToolOutputs 之类逐帧变的对象喂进这些 memo
  // （HANDOFF「别进 activeStatus memo」：它们会扫全量 events）
  const taskActions = task?.actions;
  const selectedAction = useMemo<ActionRecord | null>(() => {
    if (!taskActions || !selectedActionId) return null;
    return taskActions.find((a) => a.id === selectedActionId) ?? null;
  }, [taskActions, selectedActionId]);

  const currentAction = useMemo<ActionRecord | null>(() => {
    if (!task || !task.currentActionId) return null;
    return task.actions.find((a) => a.id === task.currentActionId) ?? null;
  }, [task]);

  // 全量有效批次（task 级、跨所有 plan action 派生）——传给 ArtifactPanel 的批次表、
  // 让追加 plan 也能看到完整批次盘子 b1/b2/b3 + 进度，跟选批界面 / 进度条同源
  const effectiveBatches = useMemo(
    () => (taskActions ? deriveEffectiveBatches({ actions: taskActions }).batches : []),
    [taskActions],
  );

  // 当前查看的 plan 之前的历次 plan（仅追加 / 重建场景用）——artifact 顶部「前序方案」入口
  const priorPlans = useMemo(() => {
    if (!taskActions || selectedAction?.type !== "plan" || !selectedAction.replanMode) {
      return [];
    }
    return taskActions
      .filter(
        (a) => a.type === "plan" && !a.excluded && a.n < selectedAction.n,
      )
      .map((a) => ({ n: a.n }));
  }, [taskActions, selectedAction]);

  // 传给 ArtifactPanel 的回调 / 数组必须身份稳定：它们进了产物 markdown components 的 useMemo 依赖，
  // 任何一项每次渲染换引用 = Streamdown 整篇重渲（V11-07）。
  // 点产物里的「#n 类型」引用跳 action：经 taskRef 读最新 actions，回调自己不依赖 task。
  const handleArtifactRefClick = useCallback((ref: ActionArtifactRef) => {
    // 找最近匹配 (n, type) 的 action、切过去
    const target = taskRef.current?.actions.find(
      (a) => a.n === ref.n && a.type === ref.type,
    );
    if (target) setSelectedActionId(target.id);
  }, []);

  // 多仓 task：仓短名清单给路径前缀校验用（agent 漏写仓名前缀的路径不渲染链接、点了必 404）；单仓 = undefined 不校验。
  // V0.10 隔离 task：cwd 是 worktrees/<taskId>、原仓库路径不在其下、短名 = worktree 子目录名
  // （getUniqueRepoDirNames、跟 server 同源）。依赖用仓路径 key（字符串）而不是 repoPaths 数组——
  // 服务端每帧 task 快照都会给一个新数组，数组身份不稳。
  const isolateWorktree = !!task?.isolateWorktree;
  const selectedActionCwd = selectedAction?.cwd;
  const artifactRepoShortNames = useMemo(() => {
    const paths = repoPathsKey ? repoPathsKey.split("\n") : [];
    if (paths.length <= 1) return undefined;
    return isolateWorktree
      ? getUniqueRepoDirNames(paths)
      : getRepoShortNames(paths, selectedActionCwd ?? getEffectiveCwd(paths));
  }, [repoPathsKey, isolateWorktree, selectedActionCwd]);

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

  // V0.5.10：Resizable 分栏初始 size；窄栏策略（第二轮 review V13-01/03/04/05）：
  // 默认 1280 窗口里事件流栏按 30% 只有 ~307px，所以 ① 事件流栏用像素下限 ② 默认取 max(30%, 380px)
  // ③ 产物栏可一键折叠。规则全在 lib/task-split-layout（有单测）。
  // defaultSize 写不了 CSS max()：由主区容器的 ref 回调在挂载时量一次宽度（提交阶段、绘制前），
  // 量到之前不挂 Group，免得先按旧默认 70/30 挂一遍再换。窗口之后再缩放由 Panel 的 px 下限兜住，不用 observer。
  const [mainWidth, setMainWidth] = useState<number | null>(null);
  const mainWidthRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setMainWidth(el.clientWidth);
  }, []);
  const artifactDefaultPercent = resolveArtifactDefaultPercent({
    persisted: task?.uiLayout?.artifactPanelSize,
    containerWidth: mainWidth,
  });
  // 产物栏折叠：Panel 命令式句柄 + 折叠态（由 Panel 的 onResize 回写，拖到最小宽度以下自动折叠时也同步）
  const artifactPanelRef = usePanelRef();
  const [artifactCollapsed, setArtifactCollapsed] = useState(false);
  // 折叠态同步给「搜索此栏」路由：折叠后 Cmd/Ctrl+F 不再落进看不见的产物搜索框（R9a-01）；离开页面复位
  useEffect(() => {
    setArtifactPaneCollapsed(artifactCollapsed);
  }, [artifactCollapsed]);
  useEffect(() => () => setArtifactPaneCollapsed(false), []);
  const toggleArtifactPanel = useCallback(() => {
    if (artifactPanelRef.current?.isCollapsed()) artifactPanelRef.current?.expand();
    else artifactPanelRef.current?.collapse();
  }, [artifactPanelRef]);

  // 事件流行内动作（错误卡「重试」）：与 chat 的 ChatView 同语义——把最后一条用户消息
  // 原样再发（图 / 路径附件 / skill 引用一起带回），走任务统一消息通道 submitTaskQuestion。
  // task 详情页之前没包 StreamActionsProvider，所以错误卡的重试按钮从不渲染；
  // 能力住在这里（手里有 task + absorbTask），靠 Context 注入给深层的错误卡。
  // 模型跟说话条对齐：手动覆盖（粘住）优先，否则跟会话模型一致时不传 forceModel。
  // （hooks 必须在早返回前，所以放这里；task 为 null 时 value 里空转即可）
  const taskRetryActions = useMemo(
    () => ({
      // source = 错误卡判定出的「触发失败那一轮的用户消息」；没传才退回最后一条（单点判定见 resolveErrorRecovery）
      onRetryLastMessage: async (source?: TaskEvent) => {
        if (!task) return;
        if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
          toast.error("任务已终态，不能再发送");
          return;
        }
        const last = source ?? findLastUserReply(task.events);
        if (!last) return;
        if (getPendingQuestionSend(task.id)) {
          toast.error("上一条消息还在发送中、稍等它发完再发");
          return;
        }
        try {
          const payload = await buildResendPayload(task.id, last);
          if (payload.imagesPartial) toast.warning("部分附图未能重发");
          const session = resolveSessionModel(task);
          const picked = loadTalkOverride(task.id) ?? session ?? { id: "" };
          const result = await submitTaskQuestion(
            task,
            payload.text,
            payload.images,
            talkForceModel(picked, session),
            payload.attachments,
            payload.skillRefs,
          );
          if (result.persistWarning) {
            toast.error(`消息已送达但记录保存失败：${result.persistWarning}`);
          }
          absorbTask(result.task);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        }
      },
      // 重新推进（错误卡：推进失败 / action 跑挂）：重放用户消息对这类失败没有意义，
      // 改为打开推进弹窗、让用户自己选 action 和指令再推。口径与顶部「推进」按钮的 canAdvance 一致：
      // 运行中 / 终态 / 在等提问答案都不开（推进会叠跑 / 绕开未答的 ask）
      onReadvance: () => {
        if (!task) return;
        if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
          toast.error("任务已终态（已合入 / 已放弃），恢复后才能推进");
          return;
        }
        if (task.runStatus === "running") {
          toast.info("任务正在运行中，等它跑完再推进");
          return;
        }
        if (findPendingAskEvent(task.events)) {
          toast.info("AI 在等你回答提问，先回复后再推进");
          return;
        }
        setAdvanceDialogOpen(true);
      },
    }),
    [task, absorbTask],
  );

  // R9a-03：只有用户在分隔条上真拖 / 按键之后产生的 onLayoutChanged 才写回；
  // 挂载 / 窗口缩放重算也会触发它，不拦的话窄窗口打开任务会把已存比例改写成「窗口校准后的值」
  const userResizeIntentRef = useRef(createUserResizeIntent());
  useEffect(() => {
    const onPointerEnd = () => userResizeIntentRef.current.pointerUp(Date.now());
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    // Q8-01：窗口失焦也复位（macOS 右键菜单 / 系统手势会吞掉 pointerup，意图不能卡在活跃）
    window.addEventListener("blur", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onPointerEnd);
    };
  }, []);

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
    return <LoadingState variant="hero" />;
  }

  // 首次加载失败（网络 / 5xx / 503）：不是「任务不存在」——亮出原因 + 重试
  if (!task && loadFailure) {
    // meta.json 损坏的任务：详情接口回 503（visibility=unavailable，不是 404），所以落在这个分支而不是下面的
    // 「任务不存在」。侧栏的 corrupt 清单里有它 → 用损坏原因 + 恢复说明替换干巴巴的 temporarily_unavailable（F3-02 尾巴）。
    // 只接这里、不接 404 / 410 的 notFound：那是服务端「确定没有 / 已删」，不能让一条过期的损坏记录盖过它。
    const corruptInfo = corrupt.find((c) => c.id === id);
    const corruptView = corruptInfo ? describeCorruptTask(corruptInfo) : null;
    return (
      <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-4 p-8">
        {corruptView ? (
          <div className="flex max-w-md flex-col items-center gap-1.5 text-center text-sm">
            <p className="font-medium">任务数据损坏，暂时打不开</p>
            <p>{corruptView.reason}</p>
            <p className="text-muted-foreground">{corruptView.recovery}</p>
            {corruptView.metaPath ? (
              // 需要手动修复 / 排查时才给路径，附复制按钮（与侧栏「数据损坏」弹层同口径）
              <div className="mt-1 flex w-full items-start gap-1.5 text-left">
                <code className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">
                  {corruptView.metaPath}
                </code>
                <CopyButton
                  text={corruptView.metaPath}
                  label="复制路径"
                  className="shrink-0"
                />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="max-w-md text-center text-sm text-destructive">
            加载任务失败：{loadFailure}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              // 回到加载态再拉一次（loaded=false 显示占位、避免失败态和结果态来回闪）
              setLoadFailure(null);
              setLoaded(false);
              void refresh();
            }}
          >
            <RefreshCw className="size-3.5" />
            重试
          </Button>
          <Button variant="ghost" onClick={() => router.push("/")}>
            回工作台
          </Button>
        </div>
      </div>
    );
  }

  // 已删 / 直开无效 URL（404 / 410）：友好空态，勿裸 notFound()（看板缓存旧 id / 侧栏删后直链都会撞）
  if (!task) {
    return (
      <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-4 p-8">
        <EmptyHint variant="dashed" size="md" align="center">
          任务不存在或已删除
        </EmptyHint>
        <Button variant="outline" onClick={() => router.push("/")}>
          回工作台
        </Button>
      </div>
    );
  }

  // ---- 按钮渲染条件 ----
  // canAck 在上方 hooks 区 useMemo 算好（auto-close effect 也要用）

  // AI 提问等答案中（未答 ask 且提问还有人接）：推进藏起来——此时推进会绕开答题打断
  // 会话语境（agent 还在等答案）；用户先答题（或底部输入条说话）后按钮自然恢复。
  // runStatus=error（提问已没人接）不拦、推进是恢复手段。
  const awaitingAskAnswer = !!findPendingAskEvent(task.events);
  // 头部运行态徽标 / 停止键外观（V6-02）：等答案时徽标写「待回答」（与侧栏同词）、停止键不转圈
  const headerRunBadge = deriveTaskHeaderRunBadge(task.runStatus, awaitingAskAnswer);
  const stopView = taskStopButtonView(
    headerRunBadge.kind === "badge" && headerRunBadge.awaitingAnswer,
  );

  // 推进按钮：任务非终结态 + agent 不在跑代码 + 不在等提问答案
  //   - idle / error：没活 agent、推进会起新 Run
  //   - awaiting_user（含当前 action 等 ack 时）：去掉「通过」按钮后、推进会隐式认可当前 action、
  //     再走 submitNextAction 续接 / force-new 起新（V0.x 去掉了原先「先 ack 才解锁」的 !canAck 限制）
  const canAdvance =
    !awaitingAskAnswer &&
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
    // 指令里 `/` 引用到的 skill（选填）——服务端拼进 agent 消息、不落进 action.userInstruction
    skillRefs?: Array<{ name: string; absPath: string }>;
    // 原生 picker 选的文件 / 目录绝对路径（选填）
    attachments?: string[];
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
    // 弹窗内换了提供方时带上切后的 task（用它算新家的凭据、不再读旧 task.provider）
    switchedTask?: Task;
  }) => {
    setStarting(true);
    // 新一轮提交：上一次的失败原因作废（失败了会重新写入）
    setAdvanceError(null);
    try {
      // 弹窗内换了提供方 = setTaskProvider 已落盘，用切后的 task 算凭据和分支；
      // 没换就是原 task。fetch 的 id 不变（同一任务）。
      const t = input.switchedTask ?? task;
      // 统一走 prepareRunArgs：apiKey + model（task.model || settings.defaultModel）
      // MCP 由 server 端读 cursor 配置、不在此传。校验失败 helper 内部 toast.error、返 null
      const args = prepareRunArgs(t);
      if (!args) return;
      // input.model 仅起新 agent 时由 dialog 临时挑、优先级最高、覆盖 prepareRunArgs 算的
      const model = input.model?.id ? input.model : args.model;
      // gitToken 不在 prepareRunArgs 暴露字段里、单独读 settings（host 由 server 按仓库 remote 现推）
      const settings = getSettings();
      // V0.x A 方案：带上设置页最新分支配置（只收本 task 各仓 + settings 找得到 + 非空）、
      //   server 据此刷新 task 分支快照——设置页改了 dev/test/线上分支、老 task 下次推进就生效。
      const repoBaseBranches: Record<string, string> = {};
      const repoTestBranches: Record<string, string> = {};
      const repoDevBranches: Record<string, string> = {};
      for (const p of t.repoPaths) {
        const repo = settings.repos.find((r) => r.path === p);
        if (!repo) continue;
        const ob = repo.onlineBranch?.trim();
        if (ob) repoBaseBranches[p] = ob;
        const tb = repo.testBranch?.trim();
        if (tb) repoTestBranches[p] = tb;
        const db = repo.devBranch?.trim();
        if (db) repoDevBranches[p] = db;
      }

      const res = await fetch(`/api/tasks/${t.id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: input.actionType,
          userInstruction: input.userInstruction,
          // 截图附件（选填）、后端落盘后把路径注入 agent prompt
          images:
            input.images && input.images.length > 0 ? input.images : undefined,
          // v1.1.x 富输入：文件 / 目录路径附件 + `/` skill 引用（跟输入条同款字段）
          attachments:
            input.attachments && input.attachments.length > 0
              ? input.attachments
              : undefined,
          skills:
            input.skillRefs && input.skillRefs.length > 0
              ? input.skillRefs
              : undefined,
          apiKey: args.apiKey,
          model,
          reuseAgent: input.reuseAgent,
          // V0.6.1 ship action 用：每次推进带上 settings 最新 PAT（host 服务端按 remote 现推）
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
        const data = (await res.json().catch(() => ({}))) as unknown;
        // 服务端 errorResponse 返回 { error: "文字" }——error 是字符串、不是带 .message 的对象。
        // 之前写成 data.error?.message → 永远 undefined → 真实报错被吞成「HTTP 404」误导排查、必须直接读 data.error。
        throw new Error(advanceErrorMessage(data, res.status));
      }
      const data = (await res.json()) as { task: Task; action: ActionRecord };
      absorbTask(data.task);
      setSelectedActionId(data.action.id);
      // 成功：关弹窗 + 清预填。程序化关弹窗不触发 onOpenChange，这里显式清预填——
      // 否则改bug 深链推进成功后，下次手动推进仍会灌入旧 bug 指令
      const ui = planAdvanceUi({ ok: true });
      if (ui.closeDialog) setAdvanceDialogOpen(false);
      if (ui.clearPrefill) setAdvancePrefill(null);
    } catch (err) {
      // 失败：**不关弹窗、不清预填**（契约见 lib/advance-submit）——之前一律关掉并清空，
      // 用户写好的指令 / 贴的图 / 深链预填全丢、原因只剩被截成首行的 toast。
      // 现在完整原因（多行原样）留在弹窗里，用户原地改了重试；服务端同时已把失败写进事件流留痕
      const ui = planAdvanceUi({ ok: false, error: err });
      if (ui.toastError) toast.error(ui.toastError);
      setAdvanceError(ui.inlineError);
      if (ui.closeDialog) setAdvanceDialogOpen(false);
      if (ui.clearPrefill) setAdvancePrefill(null);
    } finally {
      setStarting(false);
    }
  };

  // ---- 停止：中断当前正在跑 / 等 ack 的 action ----
  const handleStop = async () => {
    if (!task) return;
    const ok = await confirm({
      title: "停止当前 action？",
      // 文案单一来源 lib/stop-copy（D8-06）；排着的消息会被清掉要事先说（D8-04）
      description: stopConfirmDescription({
        queuedCount: stoppableQueuedCount(talkQueue),
      }),
      confirmLabel: "停止",
      destructive: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const updated = await stopTask(task.id);
      absorbTask(updated);
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
      // 文案与服务端同源：交卷等确认的那一步划除会停掉会话（V18-02），不能只说「随时可恢复」
      const copy = getActionExcludeConfirmCopy(action);
      const ok = await confirm({
        title: `划除 #${action.n} ${actionDisplayLabel(action)}？`,
        description: copy.description,
        confirmLabel: copy.confirmLabel,
      });
      if (!ok) return;
    }
    try {
      const updated = await setActionExcluded(
        task.id,
        action.id,
        !action.excluded,
      );
      absorbTask(updated);
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
          ? // 不写死「main」：合入的目标分支因任务 / 仓而异（与事件流那句 formatFinalizeNotice「任务已标记为已合入」同口径）
            "标记本任务已合入（对应 MR 已合并）、agent 收尾结束 run"
          : "标记本任务已放弃、agent 收尾结束 run、产物保留只读",
      destructive: finalStatus === "abandoned",
      confirmLabel: finalStatus === "merged" ? "已合入" : "放弃任务",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const updated = await finalizeTask(task.id, finalStatus);
      absorbTask(updated);
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
      absorbTask(updated);
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
          onTaskUpdate={absorbTask}
          onEventAppend={(ev, meta) => {
            // 双保险：ChatView 已滤 ephemeral，这里再挡一次防漏进持久 rows
            if (isEphemeralToolOutputDelta(ev)) return;
            // 回退标记事件本地窗口对不齐（只加载了尾部分页等）：不猜，完整重新拉取一次并整体替换本地
            // （此时 appendTaskEvent 不追加该事件；拉回的快照自带它）
            const cur = taskRef.current;
            if (cur && rewindNeedsResync(cur, ev)) void resyncEvents();
            // appendTaskEvent：按 id 去重追加；回退标记事件会先截掉本地被删的后半段；
            // 回放（meta.replay）里比本地窗口首条还早的事件直接丢弃（评审 N5，不接到末尾乱序）
            setTask((prev) =>
              prev ? appendTaskEvent(prev, ev, { replay: meta?.replay === true }) : prev,
            );
          }}
          onRewound={(r: RewoundResult) => {
            // 回退 HTTP 响应直给的标记：不依赖标记事件写入 / SSE 到达，直接把本地对齐到这次回退
            const cur = taskRef.current;
            if (!cur) return;
            const { resync } = applyRewoundResult(cur, r);
            setTask((prev) => (prev ? applyRewoundResult(prev, r).task : prev));
            if (resync) void resyncEvents();
          }}
          onPrependEvents={handlePrependEvents}
          onTaskDeleted={handleTaskDeleted}
        />
      </div>
    );
  }

  // 运行态只看属主主 run（旁路群答疑不并入，D6-02 / R3-05 / Q5-01）
  // runStatus 也进来：latch 要等 effect 才置位，首个 commit 不能把在跑的工具画成「已中断」（D9-03）
  const runFlags = deriveRunFlags({ runActive, runStatus: task.runStatus });

  return (
    <div className="flex h-full flex-col">
      {/* 顶部条 */}
      <div className="shrink-0 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              {/* min-w-0：让 h1 的 truncate 真正生效——否则长标题撑满、把后面的状态
                  badge（已带 shrink-0）挤到溢出 / 换行。标题省略、状态 badge 始终同一行。 */}
              <div className="flex min-w-0 items-center gap-1.5">
                {/* 面包屑返回：工作台 / 标题——跟 workitems 预览页同语义、零高度成本；
                    胶囊再点一次回甘特留着当老手快捷键 */}
                <Tooltip content="回工作台">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => router.push("/")}
                    aria-label="回工作台"
                    className="shrink-0 gap-0.5 px-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="size-4" />
                    返回
                  </Button>
                </Tooltip>
                <span className="shrink-0 text-muted-foreground/50">/</span>
                {/* 详情页顶栏标题档：与 chat 详情页（chat-view）同一规格、见 ui-conventions */}
                <h1 className="min-w-0 truncate text-sm font-medium tracking-tight">
                  {task.title}
                </h1>
                <Badge variant={REPO_STATUS_VARIANT[task.repoStatus]}>
                  {REPO_STATUS_LABEL[task.repoStatus]}
                </Badge>
                {/* 无飞书链接 = 日常轻量态；中性色、与 status badge 同排 */}
                {isLightweightDailyTask(task) && (
                  <Badge variant="secondary" size="xs" className="font-normal">
                    日常
                  </Badge>
                )}
                {isTestingTask(task) && (
                  <Tooltip
                    content={
                      isTestingRequirementTask(task) &&
                      testingTaskMissingBranchRepoPaths(task).length > 0
                        ? "被测业务分支尚未全部就绪，可先做需求分析和测试用例，之后从编辑任务补上"
                        : isTestingRequirementTask(task)
                          ? "测试任务：Action 启动前会校验并切到被测业务分支"
                          : "测试角色的日常任务"
                    }
                  >
                    <Badge
                      variant={
                        isTestingRequirementTask(task) &&
                        testingTaskMissingBranchRepoPaths(task).length > 0
                          ? "outline"
                          : "secondary"
                      }
                      size="xs"
                      className="font-normal"
                    >
                      {isTestingRequirementTask(task) &&
                      testingTaskMissingBranchRepoPaths(task).length > 0
                        ? "测试 · 待补分支"
                        : "测试"}
                    </Badge>
                  </Tooltip>
                )}
                {/* 运行态徽标：AI 在等 ask_user 答案时 runStatus 仍是 running，
                    只看 runStatus 会写「运行中」、与侧栏的「待回答」打架（V6-02）——判定见 task-header-status */}
                {headerRunBadge.kind === "error" ? (
                  <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-destructive/80" />
                    {headerRunBadge.label}
                  </span>
                ) : headerRunBadge.kind === "badge" ? (
                  <Badge variant={headerRunBadge.variant}>
                    {headerRunBadge.label}
                  </Badge>
                ) : null}
              </div>
              {/* V0.10.1：工作区快捷操作（IDE 打开 / 复制路径 / 单预览位）
                  ——本分支已是 task 模式（chat 模式在上面提前 return ChatView） */}
              <WorkspaceActions task={task} />
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
                >
                  <Flag />
                  已合入
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleFinalize("abandoned")}
                  disabled={starting}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <XCircle />
                  放弃
                </Button>
              </>
            )}
            {/* 显隐只认 isStopButtonVisible（runStatus 单一口径，安全契约：点下去走 stopTaskAgent 核弹路径），
                这里不并 runActive / awaitingAskAnswer。 */}
            {isStopButtonVisible(task) && !canAck && (
              // 转圈 +「停止」合体：运行中一体按钮、hover 变红；stopping 防双击。
              // 等答案时（stopView.spinning=false）不转圈、挂说明：此刻 AI 没在干活、转圈会说谎，
              // 但按钮不能拿掉——等答案期间底部输入条不是停止键，这是会话卡死时唯一的停止入口（V6-02 取舍）
              <Tooltip content={stopView.tooltip} side="bottom">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleStop}
                  disabled={stopping}
                  className="text-muted-foreground hover:text-destructive"
                >
                  {stopView.spinning ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Square />
                  )}
                  停止
                </Button>
              </Tooltip>
            )}
            {canReopen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReopen}
                disabled={starting}
              >
                {starting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                恢复
              </Button>
            )}
          </div>
        </div>

        {/* 任务级辅助入口同排：弹窗触发 chip（基本信息 / 任务上下文 / MCP / 分批）+
            竖分隔线 + 执行型按钮（需求群 / 任务文件夹）——按交互类型分组 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* 任务基本信息：编辑任务 dialog 入口（标题 / 角色 / 飞书链接 / 模型 / 分支）；
              跟标题同排会混进状态 Badge、放这排入口 chip 组首位；running 时隐藏 */}
          {task.runStatus !== "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditDialogOpen(true)}
            >
              <Pencil />
              基本信息
            </Button>
          )}
          <ContextDocsPanel task={task} onTaskUpdate={absorbTask} />
          <TaskMcpPanel task={task} onTaskUpdate={absorbTask} />
          {/* 提供方切换已搬进底部输入条 + 推进弹窗，顶栏不再放（用户拍板） */}
          {/* V0.6.24：分批进度 chip（拆了=「批次进度 N/M」、点开看详情；没拆=不渲染，BatchProgress 无批次时 return null） */}
          <BatchProgress task={task} />
          {/* 代码改动预览：各仓相对线上分支的净改动（数据直接读 git、不用再开 IDE 翻）；
              key=task.id：切任务时清掉上一个任务的清单 / 选中态 */}
          <TaskChangesPanel key={task.id} task={task} />
          <div className="h-4 w-px shrink-0 bg-border" />
          <TaskUtilityActions task={task} onTaskUpdate={absorbTask} />
          {/* 产物栏折叠：窄窗口下把整行宽度让给事件流（V13 窄栏策略）；拖分隔条到最小宽度以下也会自动折叠。
              折叠后产物区 / 时间线隐藏、再点展开回到折叠前的宽度 */}
          <Tooltip
            content={artifactCollapsed ? "展开产物栏" : "收起产物栏，事件流占满宽度"}
          >
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="ml-auto"
              onClick={toggleArtifactPanel}
              // label 固定、状态用 aria-expanded 表达（以前 label 随状态变 + aria-pressed 再说一遍且方向相反，
              // 读屏念「展开产物栏，开关按钮，已按下」自相矛盾，R9a-06）
              aria-label="产物栏"
              aria-expanded={!artifactCollapsed}
            >
              {artifactCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </Tooltip>
        </div>
        {/* 提测收件箱提醒条：本需求（feishuStoryUrl 对应工作项）有未读待测 MR 时挂出 */}
        <MrInboxTaskBanner feishuStoryUrl={task.feishuStoryUrl} className="mt-3" />
      </div>

      <Separator />

      {/* 主区 */}
      <div
        ref={mainWidthRef}
        className="flex flex-1 min-h-0"
        onPointerDownCapture={(e) => {
          // Q8-01：以库的裁决（defaultPrevented）+ 主键为准，不再只看 e.target
          if (shouldRecordResizePointerDown(e)) userResizeIntentRef.current.pointerDown();
        }}
        onKeyDownCapture={(e) => {
          if (isSeparatorTarget(e.target)) userResizeIntentRef.current.key(Date.now());
        }}
      >
        {mainWidth == null ? null : (
        <ResizablePanelGroup
          key={task.id}
          id={`task-layout-${task.id}`}
          orientation="horizontal"
          onLayoutChanged={(layout) => {
            const artifact = layout["artifact"];
            // 只存有效值：产物栏折叠时它是 0，存下去会把用户上次拖出来的宽度覆盖掉
            // （isValidArtifactPanelSize 与读取侧 resolveArtifactDefaultPercent 同一个口径）
            if (
              isValidArtifactPanelSize(artifact) &&
              userResizeIntentRef.current.isActive(Date.now())
            ) {
              writeLayoutDebounced(task.id, artifact);
            }
          }}
        >
          <ResizablePanel
            id="artifact"
            panelRef={artifactPanelRef}
            defaultSize={`${artifactDefaultPercent}%`}
            minSize="20%"
            maxSize={`${ARTIFACT_PANEL_MAX_PERCENT}%`}
            // 可折叠：拖到 minSize 以下自动折叠成 0、或点头部的折叠按钮；
            // 事件流栏不设 maxSize（默认 100%），折叠后才能把整行宽度吃满
            collapsible
            collapsedSize={0}
            onResize={(size) =>
              setArtifactCollapsed(isArtifactCollapsedSize(size.asPercentage))
            }
          >
            {/* 折叠态面板子树仍挂载（宽度 0）：加 inert 让它退出 Tab 序与读屏（R9a-06） */}
            <div className="flex h-full flex-col" inert={artifactCollapsed}>
              <ActionWorkbenchHeader
                actions={task.actions}
                selectedActionId={selectedActionId}
                onSelectAction={setSelectedActionId}
                onToggleExclude={handleToggleExclude}
              />
              <div className="min-h-0 flex-1">
                {selectedAction ? (
                  <ArtifactPanel
                    // P1：按 action.id remount——切 action 时彻底重置内部产物状态
                    // （content/revisions/diff/filename），避免「Header 身份已切到新
                    // action、正文/filename 还停在旧 action」的错误配对。
                    key={selectedAction.id}
                    action={selectedAction}
                    taskId={task.id}
                    // V0.6.28 / V0.10：相对路径链接的解析基准回退链——
                    // 1) action.cwd 快照（写入时基准，中途加仓后也不会漂）
                    // 2) task.workCwd（hydrate 算出的当前工作区：隔离=worktree、非隔离=原仓）
                    // 3) getEffectiveCwd(repoPaths)（最老兜底）
                    // 缺 cwd 的老隔离 action 若直接跳到 3、会把链接拼到原仓而非 worktree 副本
                    baseDir={
                      selectedAction.cwd ??
                      task.workCwd ??
                      getEffectiveCwd(task.repoPaths)
                    }
                    // 多仓 task：仓短名清单给路径前缀校验用（agent 漏写仓名前缀的
                    // 路径不渲染链接、点了必 404）；单仓不传 = 不校验
                    // V0.10 隔离 task：cwd 是 worktrees/<taskId>、原仓库路径不在其下、
                    // 短名 = worktree 子目录名（getUniqueRepoDirNames、跟 server 同源）
                    repoShortNames={artifactRepoShortNames}
                    // V0.8.x：批次表全量化 + 追加方案前序入口
                    effectiveBatches={effectiveBatches}
                    priorPlans={priorPlans}
                    onArtifactRefClick={handleArtifactRefClick}
                    canShareToGroup={!isLightweightDailyTask(task)}
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
            defaultSize={`${100 - artifactDefaultPercent}%`}
            // 像素下限：低于 ~320px 表格 / 答题卡 / 搜索框全部失效（以前是 20%、默认窗口里实际只有 ~307px）
            minSize={`${EVENT_STREAM_MIN_PX}px`}
          >
            <aside className="flex h-full flex-col">
              {/* min-h-0 + flex-1：EventStream 根节点是 h-full、必须给它一个「刨掉底部输入条后」
                  的确定高度容器、否则总高超 100%、事件流滚不到底（V0.11.9 加输入条时踩过） */}
              <div className="min-h-0 flex-1">
                {/* hideReplyComposer=true：任务模式回复走底部 TaskTalkComposer、不用 EventStream 内置输入框 */}
                {/* StreamActionsProvider：错误卡「重试」的能力注入（与 chat 的 ChatView 同款），
                    没有它 task 的错误卡不显示重试 */}
                <StreamActionsProvider value={taskRetryActions}>
                {/* SmoothEventStream：平滑吐字的逐帧 state 圈在这一层、页面不跟着重渲（V11-07）；
                    pushDelta / clearStreaming 经 controlsRef 命令式回到页面的 SSE 回调 */}
                <SmoothEventStream
                  controlsRef={streamControlsRef}
                  task={task}
                  // 运行中 shell 的直播输出：折叠行显示最新一行、展开区实时滚动（修前几分钟的 build / test 只有转圈）
                  liveToolOutputs={liveToolOutputs}
                  hideReplyComposer
                  // 任务输入条乐观占位：只喂当前任务的行。
                  // 状态收成一个：uncertain=false 即“发送中”单态（半透明+时钟、与真气泡区分即可）。
                  // uncertain=true 的“发送状态未知、正在确认…”留给 chat 那边真正的 202 排队语义——
                  // 这里单飞行 POST，失败本就有 toast+恢复，挂 19 秒“未知”纯属吓人。
                  pendingLocalReplies={pendingTalkRows
                    .filter((r) => r.taskId === task.id)
                    .map((r) => ({
                      id: r.nonce,
                      text: r.text,
                      displayText: r.displayText,
                      uncertain: false,
                      // task 说话条的占位都是本窗口刚提交的：显式标本地（缺省不算，见 stream-pending）→ 提交即到底
                      local: true,
                    }))}
                  // 必传：漏了会让运行中的长 shell / subagent 被当成脏数据渲染成「已中断」。
                  // 旁路答疑（需求群非属主提问）的过程事件整条隐藏在「群问答」tab，不并进来（Q5-01）
                  isRunning={runFlags.isRunning}
                  // 属主主 run：错误卡「当轮失败」资格 / 状态行 / 状态槽 / 组尾占位只看它（与 isRunning 同值，保留两个 prop）
                  mainRunActive={runFlags.mainRunActive}
                  onPrependEvents={handlePrependEvents}
                  onTaskUpdate={absorbTask}
                  onGroupQaVisibleChange={setGroupQaVisible}
                />
                </StreamActionsProvider>
              </div>
              {/* V0.13.x 统一「跟 AI 说」入口：单一消息语义、AI 自主二分类（服务端按状态附交卷上下文）
                  群问答 tab 可见时隐藏：只读 tab 下输入框会误导用户在此发言 */}
              {groupQaVisible ? null : (
                <>
                <TalkQueueBanner taskId={task.id} talkQueue={talkQueue} />
                {/* 会话里已设的定时（AI 给自己设的「到点叫我」）；没有时整条收起。chat 的同一条在 EventStream 里 */}
                <ScheduleChip taskId={task.id} events={task.events} inset />
                <TaskTalkComposer
                  task={task}
                  onTaskUpdate={absorbTask}
                  onStop={() => void handleStop()}
                  stopping={stopping}
                  // 吃 runFlags.mainRunActive（含 runStatus 补位）：裸 latch 初值 false，打开正在跑的 task 首帧会画「发送」键（Q5-05）
                  runActive={runFlags.mainRunActive}
                  onPendingAdd={addTalkPending}
                  onPendingRemove={removeTalkPending}
                />
                </>
              )}
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
        )}
      </div>

      {/* V0.13.x：ask_user 答题已内联进事件流（AskUserInlineCard、EventStream 内分流）、
          模态 AskUserDialog 淘汰（用户拍板「弹窗挡整屏不合理」） */}

      {/* 推进 dialog */}
      <AdvanceDialog
        open={advanceDialogOpen}
        onOpenChange={(open) => {
          setAdvanceDialogOpen(open);
          // 关掉时清预填，避免下次手动推进仍带旧 bug 指令；上次失败原因也一并作废
          if (!open) {
            setAdvancePrefill(null);
            setAdvanceError(null);
          }
        }}
        task={task}
        prefill={advancePrefill}
        submitError={advanceError}
        onTaskUpdate={absorbTask}
        onSubmit={handleAdvance}
        submitting={starting}
      />

      {/* V0.6.6 编辑任务 dialog；onSaved 走 absorbTask（直接 setTask 会被
          PATCH 响应的全量 events 冲掉已分页历史、懒加载契约打穿） */}
      <EditTaskDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        task={task}
        onSaved={absorbTask}
      />
    </div>
  );
};

// useSearchParams 必须包 Suspense（Next 15 构建约束 missing-suspense）
const TaskDetailPageWithSuspense = () => (
  <Suspense fallback={<LoadingState variant="block" />}>
    <TaskDetailPage />
  </Suspense>
);

export default TaskDetailPageWithSuspense;
