"use client";

/**
 * ChatView：chat 模式 task 详情布局（V0.6.0.1 重新引入、对齐 V0.5 体验）
 *
 * 跟正经 task 模式（page.tsx 的 ResizablePanelGroup）的区别：
 *   - 不展示 ActionTimeline / ArtifactPanel / ContextDocs / MCP 面板 / repo / branch / role
 *   - 不展示推进 / 再聊聊 / 终结 / 删除按钮（chat 就是临时聊、删除走首页卡片入口）
 *   - 只有 EventStream + 底部输入框、用户随时发消息
 *
 * 跟 V0.5 ChatView 的区别：
 *   - 字段对齐 V0.6：task.runStatus 取代 task.status、不再依赖 phases
 *   - SSE 走 watchTaskStream（统一通道、复用 task-runner publish）
 *   - 客户端用 sendChatReply、后端 chat-reply 路由
 *
 * 组件高度自治：
 *   - 内部订阅 SSE、内部管 streamingText / isSubmitting
 *   - 父组件只负责 task state 同步（onTaskUpdate / onEventAppend）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { ChatProviderModelPicker } from "@/components/tasks/chat-provider-model-picker";
import { BranchSwitcher } from "@/components/tasks/branch-switcher";
import { TaskChangesPanel } from "@/components/tasks/task-changes-panel";
import {
  ChatWorkdirPicker,
  type ChatWorkdirPickerHandle,
} from "@/components/tasks/chat-workdir-picker";
import { ChatMcpPicker } from "@/components/tasks/chat-mcp-picker";
import { ChatQueueBanner } from "@/components/tasks/chat-queue-banner";
import { useSmoothStreaming } from "./use-smooth-streaming";
import { useSmoothThinking } from "./use-smooth-thinking";
import { EventStream } from "@/components/tasks/event-stream";
import { StreamActionsProvider } from "@/components/tasks/event-stream/stream-actions";
import {
  buildResendPayload,
  findLastUserReply,
} from "@/components/tasks/event-stream/resend-payload";
import { ComposerSessionProvider } from "@/components/composer-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useTaskWatch } from "@/hooks/use-task-watch";
import {
  backgroundSubagentJobsEqual,
  type BackgroundSubagentJobView,
} from "@/lib/background-subagents";
import { useDialog } from "@/hooks/use-dialog";
import {
  clearChatOpLedger,
  dispatchChatOp,
  getChatOpLedger,
  subscribeChatOp,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  decideChatStop,
  hasPendingBubbleContent,
  settleStopIntent,
} from "@/lib/chat-pending-display";
import { projectPendingForStream } from "@/lib/stream-pending";
import {
  advanceLiveThinking,
  applyThinkingSnapshot,
  type LiveThinking,
  type ThinkingSnapshot,
} from "@/lib/thinking-live";
import { buildInputHistory } from "@/lib/composer-history";
import { editRewindConfirmCopy, planEditRewind } from "@/lib/edit-rewind";
import {
  REWIND_BUSY_NOTICE,
  rewindFailureToast,
  runExclusiveRewind,
} from "@/lib/rewind-failure";
import {
  allocClientChatQueueItemId,
  findReusableUncertainOperation,
  initialProductState,
  projectPendingUncertain,
  shouldHideLocalPlaceholder,
  type ChatOpState,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import {
  commitHttpChatReject,
  commitHttpChatReply,
  shouldApplyTaskUpdateForOperation,
  shouldReleaseSubmitLock,
} from "@/lib/chat-submit-controller";
import { effectiveQueueCount, nextQueueAutoOpenTickForPending } from "@/lib/queue-banner";
import { prepareRunArgs } from "@/lib/run-args";
import { findPendingAskEvent } from "@/lib/ask-pending";
import { effectiveRunActive } from "@/lib/owner-run-signal";
import { deriveChatHeaderRunBadge } from "@/lib/task-header-status";
import {
  ApiRequestError,
  rewindChatToEvent,
  sendChatReply,
  stopTask,
  updateTaskFields,
  type ImagePayload,
  type RewoundResult,
  type TaskEventMeta,
} from "@/lib/task-store";
import { canCommitTaskSnapshot, commitTaskDeleted } from "@/lib/task-terminal";
import { reconcileRunActive, watchDormantToastId } from "@/lib/watch-reconnect";
import { promoteSidebarChat } from "@/lib/view-memory";
import { useLiveToolOutputs } from "@/hooks/use-live-tool-outputs";
import type { Task, TaskEvent } from "@/lib/types";

interface Props {
  task: Task;
  // 父组件持 task state、ChatView 把最新 task / event 推回去（SSE 增量驱动）
  onTaskUpdate: (next: Task) => void;
  /**
   * 追加一条 SSE 事件进本地 events。meta.replay = bootstrap 回放的历史尾部事件（不是刚发生的）——
   * 父组件据此丢弃「比本地窗口首条还早」的回放事件（评审 N5，见 task-store.appendTaskEvent）
   */
  onEventAppend: (ev: TaskEvent, meta?: TaskEventMeta) => void;
  /**
   * 回退成功后、响应体直给的回退标记：父级据此把本地事件窗口对齐到这次回退
   * （不依赖标记 info 事件写入 / SSE 到达）。不传 = 只靠事件流里的标记。
   */
  onRewound?: (rewound: RewoundResult) => void;
  // v1.0.x 事件懒加载：上拉分页拉到的更早事件、插到父组件事件列表头部
  onPrependEvents?: (events: TaskEvent[]) => void;
  /** task_deleted / watch 410 → 清本地态后通知父级（setTask null + 侧栏失效） */
  onTaskDeleted?: (taskId: string) => void;
}

/**
 * 本地 Operation 占位（完整 payload + fingerprint）。
 * images / attachments / skillRefs 供 uncertain 同 fingerprint 重发复用。
 * 是否隐藏占位只看 persistence；uncertain 样式派生自 network/terminal 轴。
 */
type PendingLocalReply = ChatOperation & {
  id: string;
  /** 派生投影，给 event-stream 占位行用（非事实源） */
  uncertain?: boolean;
  images?: ImagePayload[];
  attachments?: string[];
  skillRefs?: Array<{ name: string; absPath: string }>;
};

/** 「没有后台子代理」的稳定空数组：切任务重置时不产生新引用（EventStream 是 memo、新引用 = 白白重渲染） */
const NO_BACKGROUND_SUBAGENTS: BackgroundSubagentJobView[] = [];

export const ChatView = ({
  task,
  onTaskUpdate,
  onEventAppend,
  onRewound,
  onPrependEvents,
  onTaskDeleted,
}: Props) => {
  // 流式打字态：SDK 推 assistant chunk → 累加到这；收到正式 assistant_message → 清空
  // 切 task.id 也要清、避免上个任务的 streaming 串到新任务
  // 流式打字态：SDK 推 assistant chunk → 累加到这；收到正式 assistant_message → 清空
  // 切 task.id 也要清、避免上个任务的 streaming 串到新任务
  // （Codex 式平滑追赶 + rAF 合帧逻辑在 use-smooth-streaming.ts，与任务详情页共用）
  // applyAssistantSnapshot：每次（重）连接 bootstrap 的「进行中正文」快照——切到别的对话再切回（本组件重挂）、
  // SSE 重连后立刻铺上已生成的全部，再接着拼实时增量，而不是只剩后半截、等整段落盘才看到全文
  const {
    streamingText,
    pushDelta,
    applySnapshot: applyAssistantSnapshot,
    clearStreaming,
  } = useSmoothStreaming();
  // 思考实时态（thinking_delta 帧）：累积本段思考原文，交给事件流合成一条「进行中的
  // thinking 事件」放进工作过程流程，由已有的思考行渲染。落盘后那条 thinking 事件与它同 id
  // （服务端预定），是同一个 React 节点——用户点开着读的内容不会被收起。
  // 为什么需要：一段思考要攒到结束才落一条 thinking 事件，期间事件流纹丝不动——
  // 实测一段 65s 的思考（模型第 6s 就开始了）让界面干写了 70s「等待模型响应…」。
  // null = 没在思考。ref 与 state 同步更新：ref 让 clear 能先判空挡掉（见下）。
  // 服务端已 250ms 节流，这里不必再合帧——但 250ms 一批直接上屏就是「一顿一顿」，
  // 所以交给下面的 useSmoothThinking 摊成逐帧匀速吐出（thinkingLive 是「到达了多少」，
  // smoothThinking 是「显示了多少」；事件流只看后者）。
  const [thinkingLive, setThinkingLive] = useState<LiveThinking | null>(null);
  const thinkingRef = useRef<LiveThinking | null>(null);
  const clearThinkingLive = useCallback(() => {
    // ref 判空先挡掉：落盘事件 / assistant_delta 每条都会走到这里，绝大多数时候没在思考
    if (thinkingRef.current === null) return;
    thinkingRef.current = null;
    setThinkingLive(null);
  }, []);
  const pushThinkingDelta = useCallback((text: string, id: string) => {
    // 累积规则（同段拼接 / 换段重置 / 累计字数 / 起点时刻）在 advanceLiveThinking，
    // 这里只管 state 与 ref。起点 = 收到本段首帧的时刻（合成事件的 ts、状态行「思考中 · 12s」的起点）
    const next = advanceLiveThinking(thinkingRef.current, id, text, Date.now());
    thinkingRef.current = next;
    setThinkingLive(next);
  }, []);
  // 每次（重）连接 bootstrap 末尾的「进行中思考」快照（2026-10-13）：
  //   - 对象 = 此刻正在思考、带服务端已发出的文本——切到别的对话再切回（本组件重挂）、
  //     SSE 断流重连后，据此重建 / 对齐实时态、**接着往下长**，而不是只剩重连后新到的字、从头重新吐；
  //   - null = 没在思考，清掉本地可能残留的（断线期间这段思考已经结束了）。
  // 合并规则（同段不回退 / 换段重建 / 已有的字不重演）在 applyThinkingSnapshot；
  // 没变化就不 setState（同一引用）——重连时快照与本地一致是常态
  const applySnapshot = useCallback((snap: ThinkingSnapshot | null) => {
    const next = applyThinkingSnapshot(thinkingRef.current, snap, Date.now());
    if (next === thinkingRef.current) return;
    thinkingRef.current = next;
    setThinkingLive(next);
  }, []);
  const smoothThinking = useSmoothThinking(thinkingLive);
  // 本地「提交中」标记：sendChatReply 飞行期间 disable 输入框、防双击
  // 区别于 task.runStatus="running"（agent 在说话）、这个是请求飞行中、通常 < 1s
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 提交锁绑定 request token——旧 A finally 不得释放 B 的锁
  const submitTokenRef = useRef<string | null>(null);
  // 「停止」按钮提交锁——中断 running 的 chat agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);
  // 受理前点过停止（提交还在飞、服务端还没接住这条消息）：先登记在这里、提交一落地再兑现。
  // 直接停会撞热路径「发送前快照」窗口里没占位的竞态——停止后 AI 又被重新拉起来（见 decideChatStop）。
  const stopAfterSubmitRef = useRef(false);
  // run 进行中锁：runStatus 交卷后会从 running → awaiting_ack、但 run 还在流式吐消息；
  // 用 latch 把「输入框 loading」保持到 run 真正结束（done 事件）再放开。
  // 初值吃 task 当前态：打开 / 切回一个正在运行的会话，首个 commit 就是「在跑」（D9-03）
  const [runActive, setRunActive] = useState(() => task.runStatus === "running");
  // shell 流式输出：callId → 尾部窗口文本（ephemeral，不进 task.events）；与 task 页共用同一个 hook
  const { liveToolOutputs, absorbLiveToolOutputEvent, clearLiveToolOutputs } =
    useLiveToolOutputs();
  // P5：排队条（第 N 条）；null = 无排队
  const [queuedCount, setQueuedCount] = useState<number | null>(null);
  // 排队条「自动弹开」信号：订阅到的实时 dispatch 里发现「从无到有」时递增（恢复路径不递增，见 onLedgerLive）
  const [queueAutoOpenTick, setQueueAutoOpenTick] = useState(0);
  // 此刻还在后台跑的子代理（SSE background_subagents 帧维护整份快照，每次连接 bootstrap 补发当前值）。
  // 与 runActive 无关：主 AI 说完一轮后 runActive 归零、会话看上去「已结束」，后台子代理却可能还在干活，
  // 输入框上方的「子代理在后台工作」条靠它画（切任务清空，新任务 bootstrap 会补发）
  const [backgroundSubagents, setBackgroundSubagents] = useState<
    BackgroundSubagentJobView[]
  >(NO_BACKGROUND_SUBAGENTS);
  // Operation ledger（pending + settled + outcomes）——HTTP/SSE 同一 reducer
  const [pendingLocalReplies, setPendingLocalReplies] = useState<
    PendingLocalReply[]
  >([]);
  // 与 pending 同步：onDone 需读最新值（避免闭包陈旧）
  const pendingLocalRepliesRef = useRef(pendingLocalReplies);
  pendingLocalRepliesRef.current = pendingLocalReplies;
  // itemId → 提交那一刻 run 是否已在跑（true = 排队消息）。登记时写、渲染时读；
  // 只有事件处理器写它，写完紧跟的 ledger dispatch 会触发重渲染，读到的一定是新值
  const queuedAtSubmitRef = useRef<Map<string, boolean>>(new Map());
  // run 进行中 latch 的 ref 镜像（handleUserReply 不把 runActive 放进依赖，免得每次 run 状态变化重建回调）
  const runActiveRef = useRef(false);
  runActiveRef.current = runActive;
  // settled / outcomes 用 ref（不触发渲染）；与 pending 组成完整 ledger
  const opSettledRef = useRef<string[]>([]);
  const opOutcomesRef = useRef<ChatOpState["outcomes"]>({});
  // 闭包捕获的 taskId——卸载后异步回调先验 terminal
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;
  // 最新 task 快照（给稳定回调读事件窗口 / 仓库绑定，免得每来一条事件就重建回调、让消息行全部重渲）
  const latestTaskRef = useRef(task);
  latestTaskRef.current = task;
  // 回退（含编辑回退）单飞锁（第二轮 review V7-05）：确认后到服务端回退完成要几秒（还原多个仓 + 截断），
  // 期间再点一次会发出第二个 POST、换来红色「已有回退在进行中」，而第一次其实在成功。
  // ref 是锁本身（同步判重、不等渲染），state 给 UI（被回退的那一行转圈、其余行的回退按钮禁用）
  const rewindLockRef = useRef<string | null>(null);
  const [rewindingEventId, setRewindingEventId] = useState<string | null>(null);

  // 全局 prompt / confirm（重命名 / 回退）
  const { prompt, confirm } = useDialog();
  // 未绑仓警示「绑定」→ 打开工作目录选择器
  const workdirPickerRef = useRef<ChatWorkdirPickerHandle | null>(null);
  const onBindWorkdir = useCallback(() => {
    workdirPickerRef.current?.open();
  }, []);

  // Composer session：@ 引用 / ↑ 历史 / 未绑仓警示（不改 event-stream，靠 Context 注入）
  const composerSession = useMemo(
    () => ({
      taskId: task.id,
      repoPaths: task.repoPaths,
      inputHistory: buildInputHistory(task.events),
      showUnboundBanner: true,
      onBindWorkdir,
    }),
    [task.id, task.repoPaths, task.events, onBindWorkdir],
  );

  // 把 callback ref 化、避免 SSE effect 因为父组件 re-render 反复重连
  const onTaskUpdateRef = useRef(onTaskUpdate);
  const onEventAppendRef = useRef(onEventAppend);
  const onRewoundRef = useRef(onRewound);
  const onTaskDeletedRef = useRef(onTaskDeleted);
  onTaskUpdateRef.current = onTaskUpdate;
  onEventAppendRef.current = onEventAppend;
  onRewoundRef.current = onRewound;
  onTaskDeletedRef.current = onTaskDeleted;

  /**
   * 把 ledger state 投影到组件 UI（仅当前订阅的 task）。
   * 离屏 task 的 dispatch 不会打进这里——subscribe 按 taskId 隔离。
   */
  const applyLedgerToUi = useCallback((state: ChatOpState) => {
    opSettledRef.current = state.settled;
    opOutcomesRef.current = state.outcomes;
    const nextPending: PendingLocalReply[] = state.pending.map((p) => ({
      ...p,
      id: p.id ?? p.itemId,
      uncertain: projectPendingUncertain(p),
    })) as PendingLocalReply[];
    pendingLocalRepliesRef.current = nextPending;
    setPendingLocalReplies(nextPending);
    // 排队条：未落盘的本地占位数（persisted 已有正式气泡，不计）
    const activeCount = nextPending.filter(
      (p) => !shouldHideLocalPlaceholder(p),
    ).length;
    setQueuedCount(activeCount > 0 ? activeCount : null);
  }, []);

  // 订阅到的「实时」dispatch：投影之外，判一下排队条要不要自动弹开（第三轮 review R6-01）。
  // 排队条常驻挂载（0 条返回 null），「从无到有」不能再靠它挂载时的条数比较——只有这里知道
  // 这一次是用户刚发的 / SSE 推来的实时变化；切回会话时的恢复（下面的 applyLedgerToUi 直调）不弹（N1）
  const onLedgerLive = useCallback(
    (state: ChatOpState) => {
      const prevPending = pendingLocalRepliesRef.current;
      applyLedgerToUi(state);
      const nextPending = pendingLocalRepliesRef.current;
      // 「从无到有」才递增 tick；bootstrap 从服务端重建出来的占位（无指纹）不算（Q6-01）——
      // 纯函数、连真实 ledger 的行为测试见 tests/queue-banner.test.ts
      setQueueAutoOpenTick((t) => nextQueueAutoOpenTickForPending(t, prevPending, nextPending));
    },
    [applyLedgerToUi],
  );

  // 切 task：清 streaming 等 UI 态；订阅当前 task ledger
  useEffect(() => {
    clearStreaming();
    // 上个任务的「思考中」不能串到新任务
    clearThinkingLive();
    // 切走时作废旧提交锁，避免 A finally 误清 B、也避免 UI 锁残留
    submitTokenRef.current = null;
    setIsSubmitting(false);
    setStopping(false);
    // 上个任务登记的「提交落地后再停」不能带到新任务（否则新任务的第一条消息一落地就被停掉）
    stopAfterSubmitRef.current = false;
    clearLiveToolOutputs();
    setRunActive(false);
    // 上个任务的后台子代理不能串到新任务（新任务连上 SSE 后 bootstrap 会补发它自己的）
    setBackgroundSubagents(NO_BACKGROUND_SUBAGENTS);
    // 排队快照只对「本次挂载内登记的占位」有意义；切走后丢掉，免得越攒越多
    queuedAtSubmitRef.current = new Map();
    // 立即投影当前 ledger，再订阅后续 dispatch
    applyLedgerToUi(getChatOpLedger(task.id));
    return subscribeChatOp(task.id, onLedgerLive);
  }, [
    task.id,
    applyLedgerToUi,
    onLedgerLive,
    clearStreaming,
    clearThinkingLive,
    clearLiveToolOutputs,
  ]);

  // run 进行中 latch：runStatus 一旦进入 running 就锁上、直到 done 事件才松开——
  // 交卷后（awaiting_ack）run 还在流式吐消息时、输入框 loading 不会提前关掉。
  useEffect(() => {
    if (task.runStatus === "running") setRunActive(true);
  }, [task.runStatus]);

  // 是否渲染本地占位只看 persistence（与 terminal/network 轴正交）；
  // 展示分类 mode（立即发送 / 排队 / 状态不明）见 lib/chat-pending-display：
  // 排队与否取「提交那一刻 run 是否在跑」的快照（登记时记入 queuedAtSubmitRef），
  // 不能渲染时看 runActive——受理（running）早于 user_reply 落盘，会把立即发送误判成排队、气泡来回闪。
  // 没登记过的占位才退回「当前 run 是否在跑」兜底——它们来自重连 bootstrap 按服务端快照重建
  // （切走再切回 / 第二窗口；ledger 是纯内存，**没有**任何刷新后的持久化恢复）。
  // 重建的占位没有正文（快照只有 itemId + phase），画出来是空白的虚线气泡 + 空编辑框（V1-07），
  // 所以没有内容可画的不送进事件流；它仍在 ledger 里、计入排队数，排队条会去服务端拉带正文的清单。
  // 投影（visible / mode / local 的口径）在 lib/stream-pending.projectPendingForStream（纯函数、有单测）：
  // local = 本窗口本次挂载内登记过的才是「用户刚按了回车」（事件流据此提交即到底），
  // bootstrap 重建的占位没登记过 → false，出现时不能把正在翻历史的人拽到底部（R5-03）
  const pendingForStream = useMemo(
    () =>
      projectPendingForStream(pendingLocalReplies, {
        visible: (p) => !shouldHideLocalPlaceholder(p) && hasPendingBubbleContent(p),
        queuedAtSubmit: queuedAtSubmitRef.current,
        runActive,
      }),
    [pendingLocalReplies, runActive],
  );

  useTaskWatch(task.id, {
    onEvent: (ev, meta) => {
      // ephemeral shell delta：不进持久 events，按 callId 累积到运行中工具块（与 task 页共用 hook）；
      // tool_result 到达时 hook 会顺手清掉该 callId 的直播缓冲（最终 output 在 meta），事件本身继续往下走
      if (absorbLiveToolOutputEvent(ev)) return;

      // 任何落盘事件到达 = 这段思考已经有正式内容（thinking 事件本身 / 紧随的工具 / 正文）
      // 或新一轮开始（user_reply）——实时「思考中」到此为止。服务端保证实时帧不会晚于
      // 它之后的落盘事件到达（段结束先丢尾巴再落盘），所以这里清了不会被幽灵帧复活。
      // 例外：bootstrap 回放的历史事件（meta.replay）不算「刚发生」——每次（重）连接都会把尾部
      // 历史重新读一遍，若也当作「这段思考结束了」，就会把同页重连时本地正在长的思考清零、
      // 之后从第一个字重新吐（2026-10-13 用户反馈）。思考是否真的结束了，由紧随其后的
      // thinking_snapshot 对齐（null = 已结束、清；对象 = 仍在、接着长）
      if (!meta?.replay) clearThinkingLive();

      // 收到正式 assistant_message 事件：清掉 streaming placeholder、避免「placeholder + 正式卡片」重影。
      // 同思考：bootstrap 回放的历史尾部（meta.replay）不算「刚定稿」——重连时尾部会重读一遍，
      // 若也清，同页重连时本地正在长的正文会突然消失；这段到底有没有定稿，由紧随其后的 assistant_snapshot 对齐
      if (ev.kind === "assistant_message" && !meta?.replay) clearStreaming();

      // user_reply → 标 persisted（非终态），不写 delivered
      // SSE 绑当前 watch task.id，显式传入（不靠可变 ref 推断）
      if (ev.kind === "user_reply") {
        dispatchChatOp(task.id, { type: "user_reply", ev });
      }

      onEventAppendRef.current(ev, meta);
    },
    // 整队作废 → reducer 记 failed（清占位，气泡消失）。
    // 只有磁盘写入失败这种真事故才弹 toast；「气泡消失」本身只说「没了」不说「去哪了」，
    // 所以 stop / run 出错清掉的排队消息由服务端另落一张「未送达」卡（可复制 / 放回输入框，Q6-02），
    // 不靠这里弹窗；「立即发送」不清队（其余排队条放回），也不打扰。
    onQueueFailed: (itemIds, reason) => {
      dispatchChatOp(task.id, { type: "queue_failed", itemIds });
      if (
        itemIds.length > 0 &&
        (reason === "persist_failed" || reason === "flush_error")
      ) {
        toast.error(
          reason === "persist_failed"
            ? `${itemIds.length} 条消息因磁盘写入失败未发送`
            : `${itemIds.length} 条排队消息发送失败、请重新发送`,
        );
      }
    },
    // message_op 成功/失败终态
    onMessageOp: ({ itemId, phase, outcome }) => {
      dispatchChatOp(task.id, {
        type: "message_op",
        itemId,
        phase,
        outcome,
      });
    },
    // 重连 bootstrap → 含 operationSnapshot，ghost 不写 delivered（静默对齐、不弹）
    onQueueState: (serverItemIds, recentSettled, operationSnapshot) => {
      dispatchChatOp(task.id, {
        type: "queue_state",
        serverItemIds,
        recentSettled,
        operationSnapshot,
      });
    },
    // task 快照提交前验 sticky terminal（卸载后迟到回调也不复活）
    onTaskUpdate: (t) => {
      if (!canCommitTaskSnapshot(t.id)) return;
      onTaskUpdateRef.current(t);
    },
    onDone: (t) => {
      clearStreaming();
      clearThinkingLive();
      clearLiveToolOutputs();
      setRunActive(false);
      const remaining = pendingLocalRepliesRef.current.length;
      // done_clear 只清已有明确终态；无终态保持 uncertain/persisted（静默、不弹）
      if (
        remaining > 0 &&
        (t.runStatus === "idle" || t.runStatus === "error")
      ) {
        dispatchChatOp(task.id, { type: "done_clear" });
      } else {
        const active = pendingLocalRepliesRef.current.filter(
          (p) => !shouldHideLocalPlaceholder(p),
        ).length;
        setQueuedCount(active > 0 ? active : null);
      }
      if (!canCommitTaskSnapshot(t.id)) return;
      onTaskUpdateRef.current(t);
    },
    // 正文开始流 = 思考结束了：先清「思考中」再拼字（ref 判空、几乎零成本）
    onAssistantDelta: (text) => {
      clearThinkingLive();
      pushDelta(text);
    },
    onThinkingDelta: pushThinkingDelta,
    onThinkingSnapshot: applySnapshot,
    onAssistantSnapshot: applyAssistantSnapshot,
    // 后台子代理在飞清单：整份替换；与现值相同（bootstrap 补发 vs 实时帧常常同一份）就不 setState，
    // 省一次整个聊天视图的重渲染
    onBackgroundSubagents: (jobs) =>
      setBackgroundSubagents((prev) =>
        backgroundSubagentJobsEqual(prev, jobs) ? prev : jobs,
      ),
    // msg 已是 runner 拼好的可读文案（「Chat agent 异常：…」），别再套一层
    // 「watch 出错」——那会误导成 SSE 断了，实际是 agent 挂了
    onErrorMessage: (msg) => toast.error(msg),
    // resume 有值 = 重试预算耗尽、已休眠：挂「重连」按钮并常驻，别让用户面对静默停更的页面
    // 稳定 id：同一任务重复休眠只原位更新、不叠加；连接恢复 / 卸载 / 切任务时由 onWatchDormantEnd 撤掉
    onWatchException: (err, resume) =>
      toast.error(
        `Chat watch 异常：${err.message}`,
        resume
          ? {
              id: watchDormantToastId("chat", task.id),
              action: { label: "重连", onClick: resume },
              duration: Infinity,
            }
          : undefined,
      ),
    onWatchDormantEnd: (taskId) =>
      toast.dismiss(watchDormantToastId("chat", taskId)),
    // 重连 / 休眠唤醒后的服务端快照校准 run latch：断线期间漏了 done 也不会一直卡「运行中」
    onBootstrapSnapshot: (t) =>
      setRunActive((prev) => reconcileRunActive(prev, t.runStatus)),
    // task_deleted / watch 410 → 清 pending/streaming + ledger，再走统一 sink
    onTaskDeleted: (deletedId) => {
      clearStreaming();
      clearThinkingLive();
      clearLiveToolOutputs();
      dispatchChatOp(deletedId, { type: "clear_all" });
      clearChatOpLedger(deletedId);
      // 父级会再调 commitTaskDeleted；此处先清本地，父级负责 sticky + 列表
      // 若父级未挂 onTaskDeleted，本处仍保证 sticky（双保险）
      if (onTaskDeletedRef.current) {
        onTaskDeletedRef.current(deletedId);
      } else {
        commitTaskDeleted(deletedId);
      }
    },
  }, true);

  // 用户回复：允许 running 时入队（P5）；返回 false = 失败（调用方保留草稿）。
  // 这是「提交」本体；对外的 handleUserReply 在它外面多包了一层「兑现受理前点过的停止」（见 handleStop 附近）
  const submitUserReply = useCallback(
    async (
      text: string,
      images?: ImagePayload[],
      attachments?: string[],
      skillRefs?: Array<{ name: string; absPath: string }>,
    ): Promise<boolean> => {
      // 请求发起时捕获不可变 owner——迟到回调禁止读 taskIdRef.current 定账
      const operationTaskId = task.id;
      // 已 deleted → 丢弃（含卸载后在飞 async）
      if (!canCommitTaskSnapshot(operationTaskId)) return false;

      const args = prepareRunArgs(task);
      // prepareRunArgs 已 toast；返回 false 让调用方保留草稿+附件
      if (!args) return false;

      // fingerprint 判定 retry identity；改 payload → 新 id
      // 纯附件消息不放占位文案（2026-07-20 用户拍板）——缩略图/chip 本身就是内容
      const displayText = text;
      const payloadFingerprint = fingerprintFromChatSendArgs({
        text,
        images,
        attachments,
        skills: skillRefs,
      });
      // 从该 task 的 ledger 读（可能离屏后仍有 uncertain）
      const reuseUncertain = findReusableUncertainOperation(
        getChatOpLedger(operationTaskId).pending,
        payloadFingerprint,
      );
      let clientItemId =
        reuseUncertain?.itemId ?? allocClientChatQueueItemId();

      // 提交这一刻 run 是否已在跑：是 → 这条是排队消息（别在渲染时再判，见 pendingForStream 注释）
      const queuedNow =
        task.runStatus === "running" || runActiveRef.current;
      const registerOp = (itemId: string) => {
        queuedAtSubmitRef.current.set(itemId, queuedNow);
        dispatchChatOp(operationTaskId, {
          type: "register",
          op: {
            id: itemId,
            itemId,
            payloadFingerprint,
            ...initialProductState(),
            text,
            displayText,
            images,
            attachments,
            skillRefs,
          },
        });
      };

      if (!reuseUncertain) {
        registerOp(clientItemId);
      }

      /** 单次 POST；payload_mismatch 时外层转新 id 重试一次 */
      const postOnce = async (itemId: string): Promise<boolean> => {
        const result = await sendChatReply(
          operationTaskId,
          text,
          images,
          attachments,
          {
            apiKey: args.apiKey,
            model: args.model,
          },
          skillRefs,
          itemId,
          payloadFingerprint,
        );
        // operation 所属 task 已删——不复活；草稿可丢
        if (!canCommitTaskSnapshot(operationTaskId)) {
          return true;
        }
        // HTTP → ledger 仲裁清草稿；owner=operationTaskId
        const committed = commitHttpChatReply({
          operationTaskId,
          clientItemId: itemId,
          result,
        });
        if (committed.persistWarning) {
          toast.error(
            `消息已送达但记录保存失败：${committed.persistWarning}`,
          );
        }
        // 只有当前页仍是 A 才推父级 task 快照（防止把 B 切回 A）
        if (
          committed.task &&
          canCommitTaskSnapshot(committed.task.id) &&
          shouldApplyTaskUpdateForOperation(
            taskIdRef.current,
            operationTaskId,
          )
        ) {
          onTaskUpdateRef.current(committed.task);
        }
        if (committed.clearDraft) {
          promoteSidebarChat(operationTaskId);
        }
        return committed.clearDraft;
      };

      // 锁绑定本请求 token
      const submitToken = allocClientChatQueueItemId();
      submitTokenRef.current = submitToken;
      setIsSubmitting(true);
      try {
        try {
          return await postOnce(clientItemId);
        } catch (err) {
          // 同 id payload 不同 → 提示并转新 id 重发一次
          if (
            err instanceof ApiRequestError &&
            err.code === "payload_mismatch"
          ) {
            toast.message("上一条同 id 消息内容不同，已改用新 id 重发");
            dispatchChatOp(operationTaskId, {
              type: "payload_mismatch",
              itemId: clientItemId,
            });
            clientItemId = allocClientChatQueueItemId();
            registerOp(clientItemId);
            try {
              return await postOnce(clientItemId);
            } catch (retryErr) {
              err = retryErr;
            }
          }

          if (!canCommitTaskSnapshot(operationTaskId)) {
            // 已删：不保留草稿打扰
            return true;
          }

          // 4xx 业务拒绝 / 网络不确定都走同一 reducer
          const status =
            err instanceof ApiRequestError ? err.status : undefined;
          const isBizReject =
            typeof status === "number" && status >= 400 && status < 500;
          if (isBizReject) {
            commitHttpChatReject({
              operationTaskId,
              clientItemId,
              kind: "biz",
            });
            toast.error(`回复失败：${(err as Error).message}`);
            return false;
          }
          const net = commitHttpChatReject({
            operationTaskId,
            clientItemId,
            kind: "network",
          });
          // SSE 终态先到 → clearDraft=true，视为已接受
          if (net.clearDraft) {
            return true;
          }
          toast.message("发送状态未知、正在确认…");
          return false;
        }
      } finally {
        // 只有本 token 仍是当前锁才释放——旧 A 不得解开 B
        if (shouldReleaseSubmitLock(submitTokenRef.current, submitToken)) {
          submitTokenRef.current = null;
          setIsSubmitting(false);
        }
      }
    },
    [task],
  );

  // 停止当前正在跑的 chat agent
  const stopAgentCore = useCallback(async (): Promise<boolean> => {
    setStopping(true);
    try {
      const latest = await stopTask(task.id);
      clearStreaming();
      clearThinkingLive();
      // stop 后只清已有明确终态；其余等 queue_failed / message_op
      const result = dispatchChatOp(task.id, { type: "done_clear" });
      if (canCommitTaskSnapshot(latest.id)) {
        onTaskUpdateRef.current(latest);
      }
      if ((result.clearedIds ?? []).length > 0) {
        toast.message(
          `已确认 ${(result.clearedIds ?? []).length} 条消息终态`,
        );
      }
      return true;
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
      return false;
    } finally {
      setStopping(false);
    }
  }, [task.id, clearStreaming, clearThinkingLive]);

  // 停止键。提交还在飞、服务端还没受理这条消息时不能直接停（见 decideChatStop）：
  // 只登记意图并让停止键立刻转圈（「停止中」），等提交落地（下面的 handleUserReply）再兑现。
  // 读 ref 不读 state：回调保持稳定，且 ref 与提交锁 / run latch 同步更新、不会读到上一帧的值。
  const handleStop = useCallback(async () => {
    const mode = decideChatStop({
      submitting: submitTokenRef.current !== null,
      runActive: runActiveRef.current,
    });
    if (mode === "after_submit") {
      stopAfterSubmitRef.current = true;
      setStopping(true);
      return;
    }
    await stopAgentCore();
  }, [stopAgentCore]);

  // 对外的「发送」：提交本体 + 提交落地后兑现受理前点过的停止。
  // 没发出去（被拒 / 状态不明）不 stop——没有 run 可停，只收掉停止键的「停止中」，
  // 草稿由调用方保留、用户可重发；任务已删同理（stop 只会 404 弹一条多余的错）。
  const handleUserReply = useCallback(
    async (
      text: string,
      images?: ImagePayload[],
      attachments?: string[],
      skillRefs?: Array<{ name: string; absPath: string }>,
    ): Promise<boolean> => {
      const accepted = await submitUserReply(
        text,
        images,
        attachments,
        skillRefs,
      );
      const settlement = settleStopIntent({
        pending: stopAfterSubmitRef.current,
        accepted,
        alive: canCommitTaskSnapshot(task.id),
      });
      if (settlement !== "none") {
        stopAfterSubmitRef.current = false;
        if (settlement === "stop") await stopAgentCore();
        else setStopping(false);
      }
      return accepted;
    },
    [submitUserReply, stopAgentCore, task.id],
  );

  // 重命名对话
  const handleRename = useCallback(async () => {
    const next = await prompt({
      title: "重命名对话",
      defaultValue: task.title,
      placeholder: "对话名称",
      validate: (v) => (v.trim() ? "" : "名称不能为空"),
    });
    if (next === null || next === task.title) return;
    try {
      const updated = await updateTaskFields(task.id, { title: next });
      onTaskUpdateRef.current(updated);
    } catch (err) {
      toast.error(`重命名失败：${(err as Error).message}`);
    }
  }, [prompt, task.id, task.title]);

  // P3：回退（「回退到这里」按钮保留；会话改动面板已砍）
  const handleRewind = useCallback(
    async (eventId: string) => {
      // 已有回退在进行（含编辑回退）：连确认框都不弹——再确认一次只会换来服务端的「已有回退在进行中」
      if (rewindLockRef.current !== null) {
        toast.info(REWIND_BUSY_NOTICE);
        return;
      }
      const ok = await confirm({
        title: "回退到这里？",
        description:
          "将恢复文件到该时刻并删除之后的对话。未提交的改动会被覆盖；原暂存区（staged/unstaged）区分无法恢复，回退后的内容可能全部处于已暂存状态",
        destructive: true,
        confirmLabel: "回退",
      });
      if (!ok) return;
      // 确认框开着的这段时间别处（编辑回退）可能已经起了回退：锁没抢到就直接提示，不发第二个 POST
      const outcome = await runExclusiveRewind(
        rewindLockRef,
        eventId,
        setRewindingEventId,
        async () => {
          // 回退要几秒：给个 loading toast，成败都用同一个 id 就地换成结果（V7-05：原来整段零反馈）
          const toastId = toast.loading("正在回退…");
          try {
            const {
              task: latest,
              refreshRequired,
              rewound,
            } = await rewindChatToEvent(task.id, eventId);
            // 响应体里的回退标记先于 task 快照应用：标记事件写失败 / SSE 没到时，本地也能截掉被删的后半段
            if (rewound) onRewoundRef.current?.(rewound);
            if (!latest || refreshRequired) {
              // 回退已提交但服务端读 task 失败：勿 onTaskUpdate(null)，提示用户刷新
              toast.success("已回退，请刷新查看最新状态", { id: toastId });
              return;
            }
            onTaskUpdateRef.current(latest);
            toast.success("已回退", { id: toastId });
          } catch (err) {
            // 按服务端 409 的稳定 code 选提示（V7-06），不再匹配中文报错文案
            toast.error(rewindFailureToast(err, "rewind"), { id: toastId });
          }
        },
      );
      if (!outcome.ran) toast.info(REWIND_BUSY_NOTICE);
    },
    [confirm, task.id],
  );

  // 编辑已发送的消息（Codex / Cursor IDE 式）的「回退」那一半：确认（会丢东西才问）→ 先停当前回复 →
  // 回退到这条消息之前（有文件检查点连文件一起还原、没有就只回退对话）。回退成功返回 ok，
  // EventStream 随后把编辑后的内容作为新消息发出——被编辑的消息及之后的对话就这样被替换。
  // cancelled = 用户在确认框取消；failed = 已弹错误提示。两者都让编辑态保持、什么都没删。
  const handleEditRewind = useCallback(
    async (ev: TaskEvent): Promise<"ok" | "cancelled" | "failed"> => {
      // 别的回退还在进行：先别确认、别停当前回复——回退成功后这条消息可能已经不在了（V7-05）
      if (rewindLockRef.current !== null) {
        toast.info(REWIND_BUSY_NOTICE);
        return "failed";
      }
      const cur = latestTaskRef.current;
      const plan = planEditRewind({
        events: cur.events,
        eventId: ev.id,
        runActive: runActiveRef.current || cur.runStatus === "running",
      });
      if (!plan) {
        toast.error("找不到这条消息，无法编辑");
        return "failed";
      }
      if (plan.needsConfirm) {
        const ok = await confirm({
          ...editRewindConfirmCopy(plan, {
            repoBound: cur.repoPaths.length > 0,
          }),
          destructive: true,
        });
        if (!ok) return "cancelled";
      }
      if (plan.needsStop && !(await stopAgentCore())) return "failed";
      try {
        // 回退 HTTP（含 409 短重试）整段持单飞锁（V7-05）：期间别行的「回退到这里」被禁用、
        // 再起的回退直接被拒——编辑那一行自己的反馈是发送钮上的转圈（rows.tsx editSubmitting），这里不再叠 toast
        const outcome = await runExclusiveRewind(
          rewindLockRef,
          ev.id,
          setRewindingEventId,
          async () => {
            // 刚停下的 run 收尾可能还差一拍（服务端回退要求没有 run / 排队 / 启动中）：409 短暂重试
            let got: Awaited<ReturnType<typeof rewindChatToEvent>> | null = null;
            for (let attempt = 0; got === null; attempt++) {
              try {
                got = await rewindChatToEvent(taskIdRef.current, ev.id, {
                  mode: "edit",
                });
              } catch (err) {
                const transient =
                  plan.needsStop &&
                  err instanceof ApiRequestError &&
                  err.status === 409;
                if (!transient || attempt >= 3) throw err;
                await new Promise((r) => setTimeout(r, 400));
              }
            }
            return got;
          },
        );
        if (!outcome.ran) {
          // 确认 / 停止期间别处起了回退：编辑态保持、什么都没删
          toast.info(REWIND_BUSY_NOTICE);
          return "failed";
        }
        const result = outcome.value;
        // 响应体里的回退标记先于 task 快照应用（同 handleRewind）
        if (result.rewound) onRewoundRef.current?.(result.rewound);
        if (!result.task || result.refreshRequired) {
          toast.success("已回退，请刷新查看最新状态");
        } else {
          onTaskUpdateRef.current(result.task);
        }
        return "ok";
      } catch (err) {
        // 按服务端 409 的稳定 code 选提示（V7-06）；没有 code 的老响应退回原文
        toast.error(rewindFailureToast(err, "edit"));
        return "failed";
      }
    },
    [confirm, stopAgentCore],
  );

  // C：待发送气泡直改 / 直删（服务端队列 + 本地 ledger 乐观更新）。
  // 成功 / 已发出都静默（气泡变化本身就是反馈）；真失败才弹 error。
  const handleEditPending = useCallback(
    async (itemId: string, newText: string): Promise<boolean> => {
      try {
        const { updateChatQueueItem } = await import("@/lib/task-store");
        const updated = await updateChatQueueItem(task.id, itemId, newText);
        setPendingLocalReplies((prev) =>
          prev.map((p) =>
            (p.itemId ?? p.id) === itemId
              ? { ...p, displayText: updated.displayText, text: updated.displayText }
              : p,
          ),
        );
        return true;
      } catch (err) {
        const msg = (err as Error).message;
        // 已发出就静默删掉本地占位、对齐现实（正式气泡已在事件流）
        if (msg.includes("找不到") || msg.includes("404")) {
          dispatchChatOp(task.id, { type: "queue_failed", itemIds: [itemId] });
        } else {
          toast.error(`更新失败：${msg}`);
        }
        return false;
      }
    },
    [task.id],
  );

  const handleDeletePending = useCallback(
    (itemId: string) => {
      void (async () => {
        try {
          const { removeChatQueueItems } = await import("@/lib/task-store");
          await removeChatQueueItems(task.id, [itemId]);
        } catch (err) {
          toast.error(`删除失败：${(err as Error).message}`);
          return;
        }
        // SSE queue_failed 会再清一次、幂等无害；先乐观清、气泡立刻消失
        dispatchChatOp(task.id, { type: "queue_failed", itemIds: [itemId] });
      })();
    },
    [task.id],
  );

  // P5：running 时仍可排队发送；isSubmitting 期间短暂关掉「行内动作 + 自动聚焦」（重发 / 重新生成 / 原地编辑 / 引用）。
  // 编辑器本身不锁（EventStream 的 composeEnabled 另算、submitting 不会关掉它，第三轮 review D7-03）：
  // 防双发靠同步提交闩（event-stream sendingLatch）+ 发送键 disabled，发完能立刻补一句 / 贴图
  const canReply = !isSubmitting;

  // 事件流行内动作（错误卡「重试」）：能力住在这里（握着 ledger / 提交锁），
  // 靠 Context 注入给深层的错误卡，避免为一个按钮往 EventStream 加一路 prop
  const streamActions = useMemo(
    () => ({
      // source = 错误卡判定出的「触发失败那一轮的用户消息」；没传才退回最后一条（单点判定见 resolveErrorRecovery）
      onRetryLastMessage: async (source?: TaskEvent) => {
        const last = source ?? findLastUserReply(task.events);
        if (!last) return;
        const payload = await buildResendPayload(task.id, last);
        if (payload.imagesPartial) toast.warning("部分附图未能重发");
        await handleUserReply(
          payload.text,
          payload.images,
          payload.attachments,
          payload.skillRefs,
        );
      },
    }),
    [task.events, task.id, handleUserReply],
  );

  // 头部运行态徽标：AI 提问等你回答时 runStatus 仍是 running，徽标写「待回答」而不是「运行中」
  // （与底部状态行「等你回答」同口径，R3-03）。只取布尔、按 events 引用缓存，流式吐字不重扫
  const awaitingAsk = useMemo(
    () => !!findPendingAskEvent(task.events),
    [task.events],
  );
  const headerRunBadge = deriveChatHeaderRunBadge(task.runStatus, awaitingAsk);

  const statusHint = (() => {
    if (task.runStatus === "error") {
      return "上一轮 agent 异常退出、再发一条可重启新一轮 run";
    }
    return null;
  })();

  // D 批次：排队条可点开小面板（列排队消息 + 行内删除 / 立即发送）、组件见 chat-queue-banner。
  // 条子只在 run SES alive 时才显示：“排队” = 在当前回复后面等着（effectiveQueueCount：run 没在跑 = 0）。
  // 空闲时发的消息只是直发在途（输入框 loading + 待发送气泡已经表达了），
  // 也算一条“排队中”纯属误导——之前恢复/直发 loading 闪条子就是这么来的。
  // 常驻挂载、0 条由组件自己返回 null（R6-01）：条件挂载会让它每次都「挂上来就是 N」，自动弹开永远不可达
  const queueBanner = (
    <ChatQueueBanner
      key={task.id}
      task={task}
      queuedCount={effectiveQueueCount({ runActive, queuedCount })}
      autoOpenTick={queueAutoOpenTick}
    />
  );

  return (
    <ComposerSessionProvider value={composerSession}>
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="border-b px-6 py-2.5">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-sm font-medium tracking-tight">
                {task.title}
              </h1>
              <Tooltip content="重命名对话">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={handleRename}
                  aria-label="重命名对话"
                >
                  <Pencil />
                </Button>
              </Tooltip>
              <Badge variant="outline" size="xs">
                对话
              </Badge>
              {headerRunBadge.kind === "badge" && (
                <Badge variant={headerRunBadge.variant} size="xs">
                  {headerRunBadge.label}
                </Badge>
              )}
            </div>
          </div>
          {/* 右上角：代码改动入口（当前分支相对线上分支的全部改动，含已提交 + 未提交）。
              原来挤在输入框上方的工具行里、和目录 / 分支 / MCP 排成一串，用户找不到——那一行放的是
              「发送前要选的上下文」，页面级入口该在页面头部。xs 尺寸 = 标题栏一行的高度，
              入口异步出现 / 消失时标题栏不跳。换工作目录就整个重挂，免得带着上一个目录的范围 / 基线 */}
          <div className="flex shrink-0 items-center gap-2">
            <TaskChangesPanel key={`${task.id}:${task.workCwd ?? ""}`} task={task} size="xs" />
          </div>
        </div>
        {statusHint && (
          <div className="mt-1 w-full text-xs text-muted-foreground">
            {statusHint}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <StreamActionsProvider value={streamActions}>
        <EventStream
          key={task.id}
          task={task}
          variant="chat"
          streamingText={streamingText}
          liveToolOutputs={liveToolOutputs}
          liveThinking={smoothThinking}
          onUserReply={handleUserReply}
          canReply={canReply}
          submitting={isSubmitting}
          // 渲染期也看 task.runStatus：latch 要等 effect 才置位，首个 commit 不能把在跑的工具画成「已中断」（D9-03）
          isRunning={effectiveRunActive(runActive, task.runStatus)}
          onStop={handleStop}
          stopping={stopping}
          onPrependEvents={onPrependEvents}
          onTaskUpdate={onTaskUpdate}
          onRewind={handleRewind}
          onEditRewind={handleEditRewind}
          rewindingEventId={rewindingEventId}
          pendingLocalReplies={pendingForStream}
          queueBanner={queueBanner}
          backgroundSubagents={backgroundSubagents}
          allowQueueWhileRunning
          onEditPending={handleEditPending}
          onDeletePending={handleDeletePending}
          composerLeading={
            <ChatProviderModelPicker task={task} onTaskUpdate={onTaskUpdate} />
          }
          composerTop={
            <>
              <ChatWorkdirPicker
                ref={workdirPickerRef}
                task={task}
                onTaskUpdate={onTaskUpdate}
              />
              <BranchSwitcher task={task} variant="select" />
              <ChatMcpPicker task={task} onTaskUpdate={onTaskUpdate} />
            </>
          }
        />
        </StreamActionsProvider>
      </div>
    </div>
    </ComposerSessionProvider>
  );
};
