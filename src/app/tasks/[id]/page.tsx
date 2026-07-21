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
import {
  Ban,
  ExternalLink,
  Flag,
  Loader2,
  Lock,
  Pencil,
  RotateCcw,
  ScrollText,
  Sparkles,
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
import { EventStream } from "@/components/tasks/event-stream";
import { TaskMcpPanel } from "@/components/tasks/task-mcp-panel";
import { TASK_SEEN_EVENT } from "@/components/tasks/task-list-item";
import { TaskTalkComposer } from "@/components/tasks/task-talk-composer";
import { WorkspaceActions } from "@/components/tasks/workspace-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
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
import { isEphemeralToolOutputDelta } from "@/lib/tool-display";

import { getSettings } from "@/lib/local-store";
import {
  BUILTIN_FIX_BUG_ACTION_ID,
  buildFixBugInstruction,
} from "@/lib/mr-inbox";
import { prepareRunArgs } from "@/lib/run-args";
import {
  fetchTask,
  finalizeTask,
  mergeTaskEvents,
  reopenTask,
  setActionExcluded,
  setTaskUiLayout,
  stopTask,
  type ImagePayload,
} from "@/lib/task-store";
import {
  canCommitTaskSnapshot,
  commitTaskDeleted,
} from "@/lib/task-terminal";
import {
  actionDisplayLabel,
  MR_KIND_LABEL,
  REPO_STATUS_LABEL,
  REPO_STATUS_VARIANT,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
  deriveEffectiveBatches,
  mrKindOf,
  mrTargetBranchOf,
} from "@/lib/task-display";
import {
  getEffectiveCwd,
  getRepoShortNames,
  getUniqueRepoDirNames,
} from "@/lib/path-utils";
import { markTaskSeen, rememberLastChat } from "@/lib/view-memory";
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
  // 收件箱「改bug」深链带来的指令 + 预选 custom action（打开 dialog 后消费掉）
  const [advancePrefill, setAdvancePrefill] = useState<{
    instruction?: string;
    customActionId?: string;
  } | null>(null);
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

  // 当前路由 id 的 ref——快切时 in-flight refresh / 旧 SSE 回调仍持旧闭包，
  // 必须用 ref 比对「响应是否仍属当前页」，不能只靠 absorbTask 的 useCallback(id)
  const routeIdRef = useRef(id);
  routeIdRef.current = id;

  // 统一 terminal sink——SSE task_deleted / watch 410 / 已 hydrate 的 404
  // 只调 commitTaskDeleted（503 unavailable 不进此 sink）
  // （列表 epoch / sticky 由 coordinator 通知；本页清 state；chat pending 由 ChatView 先清）
  const handleTaskDeleted = useCallback((deletedId: string) => {
    commitTaskDeleted(deletedId);
    if (deletedId !== routeIdRef.current) return;
    setStreamingText("");
    setTask(null);
    toast.message("任务已被删除");
  }, []);

  // 侧栏 A→B 快切：立刻清本地态，避免短暂显示 A 的内容盖在 B 的 URL 上
  useEffect(() => {
    setTask(null);
    setLoaded(false);
    setStreamingText("");
    setSelectedActionId(null);
  }, [id]);

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
    try {
      const t = await fetchTask(requestedId, { tail: EVENT_TAIL });
      // 快切后迟到响应：不 absorb、也不把 loaded 置 true（留给当前 id 自己的 refresh）
      if (routeIdRef.current !== requestedId) return;
      absorbTask(t);
    } catch (err) {
      if (routeIdRef.current !== requestedId) return;
      toast.error(`加载任务失败：${(err as Error).message}`);
    } finally {
      if (routeIdRef.current === requestedId) setLoaded(true);
    }
  }, [id, absorbTask]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 把当前任务的关键状态同步进侧栏全局列表（任务 + 对话模式都经过这里）：
  //  1) 你正在看的这个任务、侧栏的转圈 / 等你回复点实时准（不等轮询）
  //  2) 让 useTaskList「知道」有任务在跑 → 触发它的条件轮询去刷后台其它任务
  // 仅依赖影响侧栏展示 / 轮询触发的关键字段、不随 events 高频 setState 全列表重渲染
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
  ]);

  // 记住「最后浏览的对话」（v1.1.x）：胶囊切回「对话」时 /chats 优先落它、不是最近活跃那条
  useEffect(() => {
    if (task?.mode === "chat") rememberLastChat(task.id);
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
    // 与「推进」按钮的 canAdvance 口径对齐：chat 模式 / running / 终态不开弹窗（深链不能绕过叠跑推进）
    const advanceable =
      task.mode !== "chat" &&
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
    } else if (task.mode !== "chat") {
      toast.info("任务已是终态（已合入 / 已放弃），恢复后才能推进");
    }
    // 不可推进也清 query：避免 URL 残留 ?advance=fix-bug 之后误触发
    router.replace(`/tasks/${id}`, { scroll: false });
  }, [task, id, searchParams, router]);

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
        // ephemeral tool_output_delta 不进 task.events（task 模式暂不渲染直播，仍要挡落盘）
        if (isEphemeralToolOutputDelta(ev)) return;
        if (ev.kind === "assistant_message") setStreamingText("");
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
      onDone: (t) => {
        setStreamingText("");
        absorbTask(t);
      },
      onAssistantDelta: (text) => setStreamingText((p) => p + text),
      onErrorMessage: (msg) => toast.error(`watch 出错：${msg}`),
      onWatchException: (err) => toast.error(`watch 异常：${err.message}`),
      onTaskDeleted: handleTaskDeleted,
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
    return <LoadingState variant="hero" />;
  }

  // 已删 / 直开无效 URL：友好空态，勿裸 notFound()（看板缓存旧 id / 侧栏删后直链都会撞）
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
      // gitToken 不在 prepareRunArgs 暴露字段里、单独读 settings（host 由 server 按仓库 remote 现推）
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
      absorbTask(data.task);
      setSelectedActionId(data.action.id);
      setAdvanceDialogOpen(false);
      // 程序化关弹窗不触发 onOpenChange，这里显式清预填——
      // 否则改bug 深链推进成功后，下次手动推进仍会灌入旧 bug 指令
      setAdvancePrefill(null);
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
        "会中断正在跑的 agent（如果它正在改代码、可能留下半成品）。停止后在底部输入条说句话即可唤醒继续。",
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
          ? "标记本任务对应 MR 已合入 main、agent 收尾结束 run"
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
          onEventAppend={(ev) => {
            // 双保险：ChatView 已滤 ephemeral，这里再挡一次防漏进持久 rows
            if (isEphemeralToolOutputDelta(ev)) return;
            setTask((prev) => {
              if (!prev) return prev;
              if (prev.events.some((e) => e.id === ev.id)) return prev;
              return { ...prev, events: [...prev.events, ev] };
            });
          }}
          onPrependEvents={handlePrependEvents}
          onTaskDeleted={handleTaskDeleted}
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
                {task.repoPaths.length > 0 ? (
                  <span className="inline-flex flex-wrap items-center gap-x-1">
                    {task.repoPaths.map((p, i) => {
                      const readonly = (task.readonlyRepoPaths ?? []).includes(p);
                      const script = (task.scriptRepoPaths ?? []).includes(p);
                      const label =
                        task.repoPaths.length === 1
                          ? p
                          : p.replace(/\/+$/, "").split("/").pop() || p;
                      return (
                        <span
                          key={p}
                          className="inline-flex items-center gap-0.5"
                        >
                          {i > 0 && <span className="text-muted-foreground">+</span>}
                          <span>{label}</span>
                          {readonly && (
                            <span title="只读仓库" className="inline-flex">
                              <Lock
                                className="size-3 text-muted-foreground"
                                aria-label="只读仓库"
                              />
                            </span>
                          )}
                          {script && (
                            <span title="脚本仓" className="inline-flex">
                              <ScrollText
                                className="size-3 text-muted-foreground"
                                aria-label="脚本仓"
                              />
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  "(未绑仓库、agent 在 home 跑)"
                )}
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
                title="推进任务：选下一个 action（plan / build / review / ship / dev）"
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
                {/* 只留 spinner 示意运行中（2026-07-21 用户拍板去掉「agent 正在跑 …」文字、顶栏减噪） */}
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
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
          <ContextDocsPanel task={task} onTaskUpdate={absorbTask} />
          <TaskMcpPanel task={task} onTaskUpdate={absorbTask} />
          {/* V0.6.24：分批进度 chip（拆了=「批次进度 N/M」、没拆=灰色「未分批」、点开看详情） */}
          <BatchProgress task={task} />
        </div>
        {/* 提测收件箱提醒条：本需求（feishuStoryUrl 对应工作项）有未读待测 MR 时挂出 */}
        <MrInboxTaskBanner feishuStoryUrl={task.feishuStoryUrl} className="mt-3" />
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
              {/* min-h-0 + flex-1：EventStream 根节点是 h-full、必须给它一个「刨掉底部输入条后」
                  的确定高度容器、否则总高超 100%、事件流滚不到底（V0.11.9 加输入条时踩过） */}
              <div className="min-h-0 flex-1">
                {/* hideReplyComposer=true：任务模式回复走底部 TaskTalkComposer、不用 EventStream 内置输入框 */}
                <EventStream
                  task={task}
                  streamingText={streamingText}
                  hideReplyComposer
                  onPrependEvents={handlePrependEvents}
                />
              </div>
              {/* V0.13.x 统一「跟 AI 说」入口：单一消息语义、AI 自主二分类（服务端按状态附交卷上下文） */}
              <TaskTalkComposer task={task} onTaskUpdate={absorbTask} />
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* V0.13.x：ask_user 答题已内联进事件流（AskUserInlineCard、EventStream 内分流）、
          模态 AskUserDialog 淘汰（用户拍板「弹窗挡整屏不合理」） */}

      {/* 推进 dialog */}
      <AdvanceDialog
        open={advanceDialogOpen}
        onOpenChange={(open) => {
          setAdvanceDialogOpen(open);
          // 关掉时清预填，避免下次手动推进仍带旧 bug 指令
          if (!open) setAdvancePrefill(null);
        }}
        task={task}
        prefill={advancePrefill}
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
