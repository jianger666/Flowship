"use client";

/**
 * 右侧事件流 + HITL 输入区
 *
 * 这块的关键交互区分：
 * - 事件流（上半部）：agent 输出 + phase 边界 + tool call、按时间排
 * - HITL 输入框（底部）：仅当 task.status === "awaiting_user" 时可输入
 *   → 这正好对应 user 拍的「chat 是 HITL 闸门、不是 prompt window」
 *
 * V1 骨架：输入只是 mock、点了发送会落一条 user_reply 事件、不真正触发 agent
 * V2 接 SDK 后输入会推 server、agent 阻塞解除、继续跑
 *
 * V0.5.11 拆分：原 890 行单文件按职责拆成
 *   - event-stream.tsx       主组件 EventStream（本文件）
 *   - event-stream/utils.tsx 事件标签 / 图标 / 时间 / thinking 合并 / meta 解析 等纯函数
 *   - event-stream/rows.tsx  MarkdownText / EventRow（含流式中的 AI 回复）/ AskUserRequestRow
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ArrowDown as ArrowDownIcon,
  Loader2,
  Sparkles as SparklesIcon,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ConversationComposer } from "@/components/conversation-composer";
import {
  resolveSkillReferences,
  fetchSkills,
} from "@/components/slash-skills";
import { useRichInput } from "@/hooks/use-rich-input";
import { useSubmitShortcut } from "@/hooks/use-settings";
import {
  StreamFollowContext,
  useIsFollowing,
  useStreamFollow,
  type StreamFollowController,
} from "@/hooks/use-stream-follow";
import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import {
  RHYTHM_GROUP_DIVIDER_TOP,
  rhythmPaddingBottom,
  rhythmPaddingTop,
  rhythmShowsGroupDivider,
  rhythmTier,
  type RhythmFacts,
} from "@/lib/event-stream-rhythm";
import { pruneAskDrafts } from "@/lib/ask-draft";
import { askIdOfEvent, findPendingAskEvent } from "@/lib/ask-pending";
import { collectGroupQaRounds, pickRoundsNeedingOwner } from "@/lib/group-qa";
import { deriveGroupQaScope } from "@/lib/group-qa-scope";
import {
  deriveSearchScopeNotice,
  findRenderIndexForEventId,
  normalizeEventStreamSearchQuery,
  searchEventStreamRenderOccurrences,
  stabilizeOccurrenceSelection,
} from "@/lib/event-stream-search";
import { stepOccurrenceIndex } from "@/lib/text-search-highlight";
import {
  applyDomSearchHighlights,
  clearDomSearchHighlights,
  findOwnerDomSearchMatches,
  ownerOccurrenceIndexAt,
  scrollDomSearchMatchIntoView,
} from "@/lib/dom-text-search";
import { PaneSearchHighlightProvider } from "@/components/ui/pane-search-highlight-context";
import { isInsideSheet, isModCombo } from "@/lib/keyboard-shortcuts";
import {
  EVENT_STREAM_SEARCH_FOCUS_EVENT,
  setActivePaneSearchScope,
} from "@/lib/pane-search";
import {
  VIRTUOSO_NEVER_AT_BOTTOM,
  advanceNewItemsTracker,
  initNewItemsTracker,
} from "@/lib/scroll-follow";
import {
  INITIAL_STREAM_HANDOFF,
  findLastAssistantId,
  nextStreamHandoff,
  resolveItemKey,
  streamItemId,
} from "@/lib/stream-handoff";
import { getSubmitShortcutHint } from "@/lib/submit-shortcut";
import { fetchEarlierBatch, shouldReopenEarlierPaging } from "@/lib/earlier-events";
import { useTaskOutline } from "@/hooks/use-task-outline";
import {
  OUTLINE_JUMP_MAX_EVENTS,
  createActiveOutlineStore,
  resolveActiveOutlineId,
} from "@/lib/stream-outline";
import { StreamOutlineRail } from "./stream-outline-rail";
import {
  fetchEarlierEvents,
  skipWait,
  type ImagePayload,
} from "@/lib/task-store";
import { runOptimisticSubmit } from "@/lib/optimistic-submit";
import { appendToDraft, registerComposerInsert } from "@/lib/composer-insert-bridge";
import { shouldAutoFocusComposer } from "@/lib/composer-refocus";
import { createSubmitLatch, startLatchedSubmit } from "@/lib/composer-actions";
import { restoreDraftMerged } from "@/lib/talk-draft-merge";
import { MAX_PATHS } from "@/hooks/use-path-attach";
import type { Task, TaskEvent } from "@/lib/types";
import { isCompactionInfo } from "@/lib/compaction-display";
import {
  applyPendingScan,
  composeStreamTail,
  type PendingScanBaseline,
} from "@/lib/stream-pending";

import {
  attachLiveThinking,
  deriveActiveStatus,
  groupChatRenderItems,
  isBootOnlyWorkGroup,
  latestEventTs,
  shouldShowProcessingPlaceholder,
  sliceCurrentRunEvents,
  type WorkGroupItem,
} from "@/lib/chat-turns";
import {
  coerceStaleRunningTools,
  isToolBlock,
  isToolVerbGroup,
  streamItemStableId,
  markBackgroundRunningTools,
  markBackgroundSubagentTools,
  mergeToolDisplayEvents,
  type StreamRenderItem,
} from "@/lib/tool-display";
import { collectRunningBackgroundCallIds } from "@/lib/shell-background";
import {
  hasInflightPending,
  loadingSinceTs,
  resolveLoadingStart,
  deriveComposeEnabled,
  shouldShowComposerRunning,
  shouldShowComposerStopOnly,
  shouldShowSendLoading,
  type PendingBubbleMode,
} from "@/lib/chat-pending-display";
import type { LiveThinking } from "@/lib/thinking-live";
import {
  extractActiveBootStage,
  isScheduleUserReply,
  prependRestoredToDraft,
  resolveStickyTurn,
  shouldShowTurnDivider,
} from "@/lib/chat-stream-display";
import {
  StreamActionsProvider,
  useStreamActions,
} from "./event-stream/stream-actions";
import {
  extractUserReplyAttachments,
  extractUserReplyImages,
  formatTs,
  mergeAdjacentThinking,
  summarize,
} from "./event-stream/utils";
import { buildResendPayload } from "./event-stream/resend-payload";
import {
  AskUserRequestRow,
  CompactionRow,
  EventRow,
  PendingLocalReplyRow,
  ReconnectingRow,
} from "./event-stream/rows";
import {
  ToolBlockRow,
  ToolVerbGroupRow,
} from "./event-stream/tool-block";
import { GroupQaPanel } from "./group-qa-panel";
import { ActiveStatusLine } from "./event-stream/active-status-line";
import { BackgroundSubagentsBar } from "./background-subagents-bar";
import { ScheduleChip } from "./schedule-chip";
import { SubagentDetailHost } from "./subagent-detail";
import {
  backgroundJobIdSet,
  type BackgroundSubagentJobView,
} from "@/lib/background-subagents";
import { WorkGroupRow } from "./event-stream/work-group";
import { AskUserInlineCard } from "./ask-user-inline";
import { EventStreamSearchBar } from "./event-stream-search-bar";
import { EventStreamSearchScopeNotice } from "./event-stream-search-scope-notice";
import { StreamAnnouncer } from "./stream-announcer";
import { pathBasename } from "@/lib/path-utils";

  // streaming placeholder 作为 list 末尾的「虚拟 item」、参与虚拟滚动
// kind 用未出现在 EventKind 里的字面量、做 discriminated union 区分
// 这样 streamingText 不再走 Footer / Component slot、而是直接进 data 数组、
// 跟随控制器的贴底跟着它的追加触发、不用单独 ref 控制
interface StreamingItem {
  kind: "__streaming__";
  id: string;
  text: string;
}

// agent 已在跑、但还没吐出第一个 token 的「起手空窗」占位
// （取代旧的「正在启动 agent」toast、不打断、收到首个 delta 即被 streaming item 取代）
interface LoadingItem {
  kind: "__loading__";
  id: string;
  /**
   * 「已等待」的起算时间（落盘的 user_reply 的 ts，见 loadingSinceTs）。
   * 没有（inflight 占位 / 取不到）= 按组件挂载起算；切走再切回重挂后靠它接着数。
   */
  since?: number;
}

/** P5：本地排队占位（尚未落盘的 user_reply） */
interface PendingLocalItem {
  kind: "__pending_local__";
  id: string;
  text: string;
  /** HTTP 不确定时为 true（与 network 轴对齐） */
  uncertain?: boolean;
  /** 展示分类（lib/chat-pending-display） */
  mode?: PendingBubbleMode;
  /** 对应服务端 queue itemId（直改 / 直删用） */
  itemId?: string;
}

/**
 * 启动进度虚拟项（F 批次）：boot stage info 不逐条渲染、
 * 只在末尾挂「最新一条 + spinner」的渐进单行；agent 活动出现后整组消失。
 */
interface BootStageItem {
  kind: "__boot_stage__";
  id: string;
  text: string;
}

type RenderItem =
  | StreamRenderItem
  | WorkGroupItem
  | StreamingItem
  | LoadingItem
  | PendingLocalItem
  | BootStageItem;

const isStreamingItem = (it: RenderItem): it is StreamingItem =>
  it.kind === "__streaming__";

const isLoadingItem = (it: RenderItem): it is LoadingItem =>
  it.kind === "__loading__";

const isPendingLocalItem = (it: RenderItem): it is PendingLocalItem =>
  it.kind === "__pending_local__";

const isBootStageItem = (it: RenderItem): it is BootStageItem =>
  it.kind === "__boot_stage__";

/** 启动进度渐进单行：同一时刻只有最新阶段（正在检查 MCP → 创建会话 → 发送首包） */
/** boot 阶段行最小停留时长——快阶段也能被看见（挨个切换、不闪跳） */
const BOOT_STAGE_MIN_MS = 700;

/**
 * boot 进度「最小停留」缓冲：新阶段到达时若上一阶段停留不足 BOOT_STAGE_MIN_MS
 * 则排队按序补播；latest=null（agent 真活动到达）立即清空、不拖住真内容。
 */
const useStagedBootDisplay = (
  latest: { id: string; text: string } | null,
): { id: string; text: string } | null => {
  // 当前展示的阶段（滞后于 latest、保证每阶段可见）
  const [shown, setShown] = useState<{ id: string; text: string } | null>(null);
  // 待播队列 / 当前展示起始时刻 / 播报定时器 / shown 的 ref 镜像（effect 内读最新值）
  const queueRef = useRef<Array<{ id: string; text: string }>>([]);
  const shownAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownRef = useRef<typeof shown>(null);
  shownRef.current = shown;
  const latestRef = useRef(latest);
  latestRef.current = latest;

  useEffect(() => {
    const cur = latestRef.current;
    if (cur === null) {
      queueRef.current = [];
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setShown(null);
      return;
    }
    if (shownRef.current?.id === cur.id) return;
    if (!queueRef.current.some((q) => q.id === cur.id)) {
      queueRef.current.push(cur);
    }
    const advance = () => {
      timerRef.current = null;
      const next = queueRef.current.shift();
      if (!next) return;
      shownAtRef.current = Date.now();
      setShown(next);
      // 播完当前后若队列还有排队阶段、按最小停留继续推进
      timerRef.current = setTimeout(advance, BOOT_STAGE_MIN_MS);
    };
    if (!shownRef.current) {
      advance();
      return;
    }
    if (!timerRef.current) {
      const elapsed = Date.now() - shownAtRef.current;
      timerRef.current = setTimeout(
        advance,
        Math.max(0, BOOT_STAGE_MIN_MS - elapsed),
      );
    }
  }, [latest?.id]);

  // 卸载清定时器
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return shown;
};

const BootStageRow = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
    <Loader2 className="size-3.5 animate-spin text-info" />
    <span>{text}</span>
  </div>
);

/**
 * 发出消息后、AI 开口前的空窗进度（没有服务端分阶段信息时的兜底）。
 *
 * 有真实阶段（新建会话 mcp / create / send、续聊恢复 resume / send）时由 BootStageRow 说真话、
 * 压制本行；走到这里 = 会话是热的（或阶段还没到），只剩「把消息交给模型 → 等首个 token」。
 * 所以不再按秒数编「创建会话…」「发送消息…」这类实际没发生的阶段（热会话续聊从没创建过会话）。
 *
 * 占位气泡（inflight）→ user_reply 落盘 → 等首 token 全程是同一个 `__loading__` 项（同 key），
 * 本组件不重挂载、「已等待 Ns」从按下回车起连续计时。
 * 切走再切回（组件重挂）时靠 `since`（落盘的 user_reply 的 ts）接着数——起算点只在首次挂载时定，
 * 交接过程中 since 才到也不会让计时往回跳（见 chat-pending-display 的 loadingSinceTs / resolveLoadingStart）。
 *
 * 模型一开始思考，这一行就会被工作过程流程里「进行中的那条 thinking 行」取代
 * （见 attachLiveThinking）——2026-10-10 实测模型第 6s 就在想了，
 * 这里却一直写「等待模型响应… 已等待 62s」。
 */
const PendingRow = ({ since }: { since?: number }) => {
  // 起算点只在首次挂载时定（之后 since 才到——占位 → 落盘交接——不能让计时往回跳）；
  // 重挂载（回车后切走再切回）时 since 已经在、按真实起点接着数，阶段文案也不会退回「准备环境…」
  const [t0] = useState(() => resolveLoadingStart(since, Date.now()));
  // state 存「整秒数」而不是时间戳：500ms 一次的 tick 里同一秒内 setState 同值会被 React 跳过，
  // 重渲染维持在每秒一次（存 Date.now() 每次都变、等于翻倍）
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - t0) / 1000)),
  );
  useEffect(() => {
    const id = window.setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - t0) / 1000))),
      500,
    );
    return () => window.clearInterval(id);
  }, [t0]);
  const phase = elapsed < 3 ? "准备环境…" : "等待模型响应…";
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-info" />
      <span>
        {phase}
        {elapsed > 0 && (
          <span className="ml-1.5 tabular-nums">已等待 {elapsed}s</span>
        )}
      </span>
    </div>
  );
};

/** uploads 文件 → base64 ImagePayload（重发带图） */
const fetchUploadAsPayload = async (
  taskId: string,
  absPath: string,
  mimeType: string,
  filename?: string,
): Promise<ImagePayload | null> => {
  try {
    const name = pathBasename(absPath);
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return {
      data: btoa(binary),
      mimeType,
      filename,
    };
  } catch {
    return null;
  }
};

interface Props {
  task: Task;
  // 流式 placeholder：chat-view 维护、SDK chunk 推到这里、收到正式 assistant_message 事件清空
  // 非空时在事件流末尾渲染一个「AI 回复中...」卡片、内容随 chunk 拼接增长（打字机效果）
  // V1 仅 chat 模式用、plan 模式不传
  streamingText?: string;
  // attachments：附加的文件 / 目录绝对路径数组、后端发给 agent 时拼成
  // [ATTACHED_PATHS] 段、agent 用 `read` 工具自己读
  // skillRefs：选中的 skill（name + absPath）、后端拼进 agent 消息、不进 user_reply 气泡
  onUserReply?: (
    text: string,
    images?: ImagePayload[],
    attachments?: string[],
    skillRefs?: Array<{ name: string; absPath: string }>,
  ) => boolean | void | Promise<boolean | void>;
  // V0.2 plan workflow 模式下传 true、不渲染底部「自由回复」输入框
  // 因为 plan 模式的 HITL 是 phase ack（通过 / 再聊聊）、不是 free-form 聊天
  // ack 按钮由父组件渲染在顶部 / 详情区其他位置
  hideReplyComposer?: boolean;
  // V0.4：输入框可用判定下放给父组件
  // - 不传：用旧行为（task.status === "awaiting_user" 才可用、给 plan 用）
  // - 传：父组件决定（chat-view 传：draft / completed / failed / awaiting_user 都可用、running / starting 不可用）
  // 命名上跟 awaiting_user 解耦——父组件知道更多状态（如 starting）、UI 该不该可用归它判
  canReply?: boolean;
  // 请求飞行中：透传 Composer.submitting（防连点；与 canReply 互补）
  submitting?: boolean;
  // V0.4：禁用时底部的状态文案（chat 自由化下、文案需要随 task.status / starting 动态变）
  // 不传：用旧 plan 文案「agent 在等待你回复时输入框才会激活」
  disabledHint?: string;
  // V0.6.24：footer 左侧 slot（chat 模式注入模型选择器、plan / task 模式不传）
  composerLeading?: ReactNode;
  // chat 模式 textarea 上方一行 slot（注入工作目录 + 分支选择器、跟底部 model 分两处放）
  composerTop?: ReactNode;
  // agent 正在跑。两个用途：
  // 1) chat 运行态——底部操作行把发送键换成红色停止键 + loading 转圈（V0.7.21）
  // 2) **工具块是否还该转圈**——false 时 coerceStaleRunningTools 把未闭合的 tool_call
  //    改判「已中断」（治历史脏数据）
  // **必填**：曾漏传（task 详情页）→ 恒 false → 跑 action 时长 shell / subagent 全被
  // 渲染成灰色「已中断」。别改回可选。
  isRunning: boolean;
  /**
   * **属主主 run** 在跑（不含旁路群答疑 run）。错误卡的「当轮失败」资格、底部状态行及其占位槽、
   * 组尾「处理中…」只看属主的 run——否则主任务失败后群里来一个提问，错误卡整张翻篇
   * （恢复入口消失、样式变灰），旁路结束又弹回来（D6-02），空闲任务也会为旁路撑开一个空状态槽（R3-05）。
   * 第四轮 Q5-01 起 task 页的 `isRunning` 也不再并入旁路在飞（旁路过程事件整条藏在「群问答」tab，
   * 主流里没有旁路工具块可画），所以两者在 task 页同值；缺省 = isRunning（chat 没有旁路）。
   */
  mainRunActive?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  // V0.7.11：渲染形态
  // log（默认）：task 模式事件流——卡片行 + header 折叠、信息密度优先
  // chat：自由模式对话——Cursor agent window 风格（窄列居中 / AI 平铺 /
  //       用户浅色块 / 过程细行 / 圆角输入岛）
  variant?: "log" | "chat";
  // v1.0.x 事件懒加载：上拉到顶自动拉更早分页、拉到的事件通过它插到父组件事件列表头部。
  // 不传 = 不启用分页（task.eventsTruncated 也不看）。
  onPrependEvents?: (events: TaskEvent[]) => void;
  /** 答题卡提交成功：把接口返回的 task 合进页面（完成信号由提交者发出，不单等 SSE） */
  onTaskUpdate?: (task: Task) => void;
  /** 群问答 tab 显隐变化（父页面据此隐藏底部输入条：只读 tab 下输入框会误导） */
  onGroupQaVisibleChange?: (visible: boolean) => void;
  /** shell 流式输出：callId → 已累积文本（尾部窗口由父组件维护） */
  liveToolOutputs?: Record<string, string>;
  /**
   * 思考实时态：thinking_delta 帧累积出的本段思考原文 + 事件 id + 起点时刻（父组件维护，只给 chat 用）。
   * null / undefined = 没在思考。
   * 思考段要攒到结束才落 thinking 事件，期间靠它合成一条「进行中的 thinking 事件」并进工作过程流程
   * （attachLiveThinking，由已有的思考行渲染）、并让状态行说「思考中」，
   * 而不是让用户对着「等待模型响应…」干等。
   * 服务端 ≤250ms 才发一帧，所以对象身份变得不频繁；EventStream 本来就要随它重渲。
   */
  liveThinking?: LiveThinking | null;
  /** P3：回退到 checkpointed user_reply */
  onRewind?: (eventId: string) => void;
  /**
   * 编辑已发送的消息（Codex / Cursor IDE 式）的「回退」那一半：父组件负责 确认 → 停当前回复 → 回退
   * 到这条消息之前（有文件检查点连文件一起还原、没有就只回退对话）。返回 ok 后本组件把编辑后的
   * 内容作为新消息发出——于是被编辑的消息及之后的对话被替换。cancelled = 用户在确认框取消、
   * failed = 父组件已弹错误提示，两种都保持编辑态。不传 = 退回旧语义（只有最后一条、编辑后追加）。
   */
  onEditRewind?: (ev: TaskEvent) => Promise<"ok" | "cancelled" | "failed">;
  /**
   * 正在回退的那条用户消息 id（回退 / 编辑回退进行中，null / 不传 = 没有回退在飞；第二轮 review V7-05）。
   * 被回退的那一行「回退到这里」转圈、其余行的该按钮禁用——回退要几秒，期间再点只会换来服务端
   * 「已有回退在进行中」。只在回退开始 / 结束时变，不会拖累流式渲染。
   */
  rewindingEventId?: string | null;
  /** P5：本地排队占位气泡（displayText 与服务端 user_reply 文案对齐） */
  pendingLocalReplies?: Array<{
    id: string;
    text: string;
    displayText: string;
    /** HTTP 不确定 */
    uncertain?: boolean;
    /**
     * 展示分类（lib/chat-pending-display）：inflight = 立即发送途中（正式气泡 + 底部进度行）、
     * queued = 排队中；缺省 = 旧样式「发送中…」（uncertain / task 模式占位）
     */
    mode?: PendingBubbleMode;
    /** 对应服务端 queue itemId（直改 / 直删用） */
    itemId?: string;
    /**
     * 是否本窗口本次挂载内用户自己提交的（「提交即到底」只认它）。`false` = bootstrap 从服务端快照
     * 重建的 / 别的窗口登记的，它们出现时不能把正在翻历史的人拽到底部。**必须显式 `true` 才算本地发起**
     * （缺省不算，fail-closed）：新增占位来源忘了标，最多是不滚动，不会拽人。
     */
    local?: boolean;
  }>;
  /** C：待发送气泡直改 / 直删（父组件接 task-store + ledger） */
  onEditPending?: (itemId: string, newText: string) => Promise<boolean | void>;
  onDeletePending?: (itemId: string) => void;
  /** P5：排队条文案 / 节点（渲染在 composer 上方） */
  queueBanner?: ReactNode;
  /**
   * 此刻还在后台跑的子代理（整份快照，服务端 SSE `background_subagents` 帧；只给 chat 用）。
   * 非空时在输入框上方画「子代理在后台工作」条——主 AI 说完一轮后会话呈现「已结束」，
   * 后台子代理却可能还在干活，没有这条用户完全看不出来。不传 / 空数组 = 不画。
   */
  backgroundSubagents?: readonly BackgroundSubagentJobView[];
  /** P5：运行中仍可排队发送 */
  allowQueueWhileRunning?: boolean;
}

// 路径附件上限在 use-path-attach hook 内统一管（10 条、跟服务端路由对齐）

// 用 React.memo 包裹：详情页输入交互（如「再聊聊」对话框输入）触发 page 重渲染时、
// 只要 task / streamingText 引用没变就跳过本组件、避免几百条 events 的子树参与 reconcile
// 这是用户实测踩过的性能坑（输入卡顿 / [Violation] message handler took XXXms）
// Virtuoso firstItemIndex 起始基数（prepend 分页时递减、官方要求保持正数——取个够大的）
const FIRST_INDEX_BASE = 1_000_000;

// 提问时间线跳到窗口之外的更早一轮时，每页拉多少条原始事件（服务端单页上限 500、见 events/route）
const OUTLINE_JUMP_PAGE_SIZE = 500;
// 点中的目标迟迟没渲染出来（找不到对应条目）就放弃的等待时长（ms）
const OUTLINE_JUMP_SETTLE_TIMEOUT_MS = 3000;
// 往前找目标超过这么久才弹「正在往前找…」提示（ms）
const OUTLINE_JUMP_LOADING_TOAST_DELAY_MS = 500;

/** loadEarlier 的收口结果（只有带 until 的跳转调用才看 found / capped / exhausted） */
interface EarlierJumpResult {
  /** 真的起跑了一轮拉取（false = 已有分页在飞 / 历史已读完 / 只读视图 / 任务切走了） */
  started: boolean;
  found: boolean;
  /** 拉取途中被取消（用户自己滚了 / 对话被回退 / 切任务）：停在已拉到的位置，不再继续、也不跳转 */
  aborted: boolean;
  /** 拉满 maxEvents 仍没到目标（再点一次继续往前） */
  capped: boolean;
  /** 历史读完了也没找到目标（它已不存在，比如被回退删了） */
  exhausted: boolean;
  failed: boolean;
}

// Virtuoso context 形状（Header 靠它拿「正在拉更早」状态、组件本身保持模块级稳定引用）
interface StreamListContext {
  loadingEarlier: boolean;
  /** 上一次上拉失败：Virtuoso 不会再自动触发，顶部给手动重试 */
  earlierFailed: boolean;
  onRetryEarlier: () => void;
}

// 顶部「加载更早…」细行：分页请求飞行中显示；失败后换成可点的重试
const EarlierLoadingHeader = ({ context }: { context?: StreamListContext }) => {
  if (context?.loadingEarlier) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        加载更早…
      </div>
    );
  }
  if (context?.earlierFailed) {
    return (
      <div className="flex items-center justify-center py-2 text-xs">
        <button
          type="button"
          onClick={context.onRetryEarlier}
          className="rounded-md px-2 py-1 text-muted-foreground underline-offset-2 hover:bg-muted hover:text-foreground hover:underline"
        >
          加载更早失败，点击重试
        </button>
      </div>
    );
  }
  return null;
};

const VIRTUOSO_COMPONENTS = { Header: EarlierLoadingHeader };

/**
 * 视口外预渲染余量（Virtuoso overscan）：快速往下滚时视口外没有备好的 item 会
 * 先露白再补齐、观感就是「抖」。
 *
 * ⚠️ **top 必须留 0**：`rangeChanged` 报的是「已渲染范围」不是「可见范围」，
 * 顶部余量会把 startIndex 往前推——sticky 轮次头会晚出现一屏、
 * 「本轮提问」条显示的轮次也会漂。底部余量不影响 startIndex，可以放心加。
 *
 * bottom 取 1500（2026-08 用户反馈「滚到代码块闪一下」）：带代码块的消息真实高度
 * 动辄 2000px+，余量太小的话消息还没测完高度就被滚进视口、Virtuoso 用估算高度
 * 渲染后一次性校正——就是那一下闪。加大余量让未测量的消息在屏外完成挂载+测量+校正，
 * 进视口前已经稳定。代价是快滚时多渲几条 md（MarkdownText / Streamdown 都有 memo，可控）。
 */
const VIEWPORT_OVERSCAN = { top: 0, bottom: 1500 };

/**
 * 粘性轮次横幅的显隐类（applyStickyTurn 命令式切换，必须是源码里的完整字面量才会被 Tailwind 生成）。
 * 用 invisible 而不是 hidden：visibility 参与 transition（淡出结束才真正不可点、淡入时立刻可见），
 * 淡出期间横幅仍占位但 root 是 pointer-events-none，不挡下面的正文。
 */
const STICKY_SHOWN_CLASSES = ["visible", "translate-y-0", "opacity-100"];
const STICKY_HIDDEN_CLASSES = ["invisible", "-translate-y-1", "opacity-0"];

/**
 * 事件流底部悬浮层：「回到最新」按钮 +「AI 在等你回答」提示条。
 *
 * **为什么合成一颗**（而不是两个各自定位的组件）：
 * 两条的显示条件都含「用户滚离底部」，琥珀条只是多要一个未答提问——
 * 也就是「琥珀条出现 ⟹ 回底按钮一定也在」。共存位置必须由同一处拍板，
 * 各定各的迟早在窄面板（task 模式右栏）里叠上。这里的分工是
 * **琥珀条横向居中（bottom-14）；回底按钮在右下角（bottom-3 right-3）**，
 * 纵向错开、不在同一横轴上叠成一团。
 *
 * 另外只订阅一次跟随态：贴底翻转只重渲这一颗，主组件不参与
 * （滚动热路径上重渲整条事件流本身就是抖动源）。
 */
const StreamFloatingBar = ({
  follow,
  unitIds,
  prependBaselineBumpRef,
  hasPendingAsk,
  onJumpToAsk,
  onBackToBottom,
}: {
  follow: StreamFollowController;
  /**
   * 全部内容单元的稳定身份、按时间顺序（工作过程组已按成员摊开）——算「离开底部后又追加了几条」：
   * 以离开那一刻的最后一个单元为锚点、数它之后的单元数（见 scroll-follow.advanceNewItemsTracker）。
   */
  unitIds: readonly string[];
  /** loadEarlier prepend 后待同步的基线抬升量（消费即清零） */
  prependBaselineBumpRef: MutableRefObject<number>;
  hasPendingAsk: boolean;
  onJumpToAsk: () => void;
  onBackToBottom: () => void;
}) => {
  const following = useIsFollowing(follow);
  // 离开底部那一刻的尾锚点 + 条数基线。用 ref 不用 state：它是从 props 推出来的缓存、
  // 自己不该触发重渲；推进函数幂等，渲染期写安全（StrictMode 双渲同结果）
  const trackerRef = useRef(initNewItemsTracker(unitIds));
  const prependDelta = prependBaselineBumpRef.current;
  if (prependDelta > 0) prependBaselineBumpRef.current = 0;
  const advanced = advanceNewItemsTracker(
    trackerRef.current,
    unitIds,
    following,
    prependDelta,
  );
  trackerRef.current = advanced.tracker;
  const newCount = advanced.newCount;
  // 贴底跟随中 = 最新内容就在眼前，两条都不用出
  if (following) return null;

  return (
    <>
      {hasPendingAsk && (
        <button
          type="button"
          onClick={onJumpToAsk}
          // 入场淡入（animate-in 只动 opacity / transform；居中用的是 translate 属性、互不打架）：
          // 滚离底部那一刻按钮不再「啪」地冒出来
          // 浮在正文之上的面必须实心（事件流 v2）：bg-background + 品牌描边 / 品牌字；
          // 原来 bg-brand/15 + 毛玻璃模糊是半透明、会透出下面的正文
          className="absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 animate-in items-center gap-1.5 rounded-full border border-brand/50 bg-background px-3 py-1.5 text-xs font-medium text-brand shadow-md transition-colors duration-150 fade-in-0 hover:bg-accent motion-reduce:animate-none"
        >
          <SparklesIcon className="size-3.5" />
          AI 在等你回答、点击查看
        </button>
      )}
      {/* 有新内容时摊成带计数的胶囊、没有就是个纯圆钮；两态同高（h-9）、不跳 */}
      <Tooltip content="回到最新">
        <Button
          variant="outline"
          size={newCount > 0 ? "lg" : "icon-lg"}
          onClick={onBackToBottom}
          // 无新内容时只有一个箭头图标、没有可读文本，读屏得靠它
          aria-label="回到最新"
          className={cn(
            // 实心底（浮层不许半透明 + 毛玻璃模糊）；Button outline 暗色自带 dark:bg-input/30（半透明），
            // 这里 dark: 一并盖成实色，否则暗色下去掉 blur 后正文会透出来
            "absolute bottom-3 right-3 z-10 rounded-full bg-background text-xs shadow-md dark:bg-background dark:hover:bg-muted",
            // 入场：淡入 + 自下方 4px 浮上来（离底那一刻不再「啪」地冒出）
            "animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none",
            newCount > 0 && "px-3.5",
          )}
        >
          <ArrowDownIcon />
          {newCount > 0 && (
            // 长 action 能刷出四位数、胶囊会被撑得离谱——封顶显示
            <span className="tabular-nums">
              {newCount > 99 ? "99+" : newCount} 条新内容
            </span>
          )}
        </Button>
      </Tooltip>
    </>
  );
};

/** 渲染管线入口过滤：藏什么只认 isHiddenFromEventStream，别在组件里再写一份 */
const eventsForStreamRender = (
  events: TaskEvent[],
  isChat: boolean,
): TaskEvent[] =>
  events.filter((e) => !isHiddenFromEventStream(e, { isChat }));

/**
 * 共用纯管线：过滤 → thinking 合并 → tool 配对 → 工作过程分组。
 * items useMemo 与 loadEarlier 的 beforeLen/afterLen 必须走同一函数，
 * 否则跨页组合并时 firstItemIndex 差值不准、滚动会跳。
 * 分组对 chat / task(log) 两形态统一生效（2026-07-21 用户拍板 task 不必单独保旧样）；
 * pending / streaming / loading / boot 虚拟项在分组之后追加、不进本函数。
 */
const buildStreamItems = (
  events: TaskEvent[],
  isChat: boolean,
  /**
   * false = 会话已非 running → 把仍挂转圈的工具块改成「已中断」（治历史脏数据）。
   * **无默认值**：默认成 true / false 都会在某条调用路径上悄悄判错（漏传 isRunning
   * 那次就是恒 false、跑着的工具全成「已中断」）——强制每个调用点自己说清楚。
   */
  runActive: boolean,
  /**
   * 此刻还在后台跑的子代理任务 id（服务端实时下发的清单，见 background-subagents.ts）。
   * 子代理卡在 `run_in_background` 派出时就「完成」了（工具调用立刻返回），图标要靠它继续转圈。
   * 同样无默认值：漏传 = 后台子代理的卡悄悄亮绿勾（2026-10-19 用户截图的就是这个）。没有就传空集合。
   */
  backgroundJobIds: ReadonlySet<string>,
): Array<StreamRenderItem | WorkGroupItem> => {
  const src = eventsForStreamRender(events, isChat);
  const merged = mergeToolDisplayEvents(mergeAdjacentThinking(src));
  // 仅非 running 时 coerce——running 中的真·进行中工具保持转圈
  const tools = runActive ? merged : coerceStaleRunningTools(merged);
  // 已转后台、进程还在跑的 shell：tool_call 虽已「完成」，会话还在跑时图标仍转圈。
  // 标记事件在上面 eventsForStreamRender 里被藏了（不渲染），这里直接读未过滤的 events。
  // 会话已停 → 不转（见 markBackgroundRunningTools 注释）
  const withBackgroundShells = runActive
    ? markBackgroundRunningTools(tools, collectRunningBackgroundCallIds(events))
    : tools;
  // 已转后台、仍在跑的子代理：清单是权威、不看 runActive（后台子代理常在主 AI 说完之后才跑完）
  const withBackground = markBackgroundSubagentTools(
    withBackgroundShells,
    backgroundJobIds,
  );
  return groupChatRenderItems(withBackground);
};

/** 与 contentUnitIds 同一计量（长度恒等）：工作过程组按成员摊开（loadEarlier 算 prepend 增量用） */
const countStreamContentUnits = (
  units: Array<StreamRenderItem | WorkGroupItem | RenderItem>,
): number =>
  units.reduce(
    (n, it) => n + (it.kind === "__work_group__" ? it.members.length : 1),
    0,
  );

/**
 * 全部内容单元的稳定身份（`streamItemStableId`），按时间顺序；工作过程组按**成员**摊开——
 * 与 countStreamContentUnits 同一计量（长度恒等）。「N 条新内容」以它做尾锚点计数（scroll-follow.advanceNewItemsTracker）。
 * 取 chronological 的 baseItems、不取 orderedItems（后者把未答 ask 挪到末尾、会盖住真正的尾部）。
 */
const streamContentUnitIds = (
  units: ReadonlyArray<StreamRenderItem | WorkGroupItem>,
): string[] => {
  const ids: string[] = [];
  for (const it of units) {
    if (it.kind === "__work_group__") {
      for (const m of it.members) ids.push(streamItemStableId(m));
    } else {
      ids.push(streamItemStableId(it));
    }
  }
  return ids;
};

const EventStreamImpl = ({
  task,
  streamingText,
  onUserReply,
  hideReplyComposer,
  canReply,
  submitting,
  disabledHint,
  composerLeading,
  composerTop,
  isRunning,
  mainRunActive = isRunning,
  onStop,
  stopping,
  variant = "log",
  onPrependEvents,
  onTaskUpdate,
  onGroupQaVisibleChange,
  liveToolOutputs,
  liveThinking,
  onRewind,
  onEditRewind,
  rewindingEventId,
  pendingLocalReplies,
  queueBanner,
  backgroundSubagents,
  allowQueueWhileRunning,
  onEditPending,
  onDeletePending,
}: Props) => {
  const isChat = variant === "chat";

  // 当前待答的 ask（V0.13.x 内联答题卡分流用）：命中的那条渲染 AskUserInlineCard、
  // 其余 ask 行走回放卡。判定收口在 lib/ask-pending（只认最新一条未了结的）。
  // 放在 items 之前算：items 构建要用它做「答题卡置底」。
  const pendingAskEvent = useMemo(
    () => findPendingAskEvent(task.events),
    [task.events],
  );
  // 答题卡草稿回收：本任务名下「不是当前待答」的草稿（已答 / 已作废 / 换了新 ask）已无用，
  // 在流这一层（不随虚拟列表卸载）判定并清理——卡自己卸载时无法区分「滚走了」与「已作废」，
  // 所以回收不能放在卡里。用 askId 原始值做依赖（pendingAskEvent 引用会随 events 变）。
  const pendingAskIdForDrafts = pendingAskEvent
    ? askIdOfEvent(pendingAskEvent)
    : null;
  useEffect(() => {
    pruneAskDrafts(task.id, pendingAskIdForDrafts);
  }, [task.id, pendingAskIdForDrafts]);

  // 输入框可用 = 父组件传 canReply（没传回退 awaiting_user）；提前算、下面 useRichInput 要用
  const canCompose = canReply ?? task.runStatus === "awaiting_user";
  // 自动聚焦判定：跟 canCompose 同款（chat 下 agent 答完 → canCompose true → focus）
  const isAwaitingUser = canCompose;
  // 提问期间输入条仍可发（回车顶掉当前卡）；chat 运行中还可排队
  const awaitingAsk = !!pendingAskEvent;
  // 能不能输入：提交飞行中（submitting）也可输入——编辑器不锁，防双发靠同步提交闩（sendingLatch）+ ConversationComposer 对 submitting 的拦截 + 发送键 disabled
  // （第三轮 review D7-03：chat 的 canReply=!isSubmitting 曾折进来，空闲首发回车到受理的 1.3–6.7s 整个编辑器灰掉）。
  // 只管编辑器；行内动作（重发 / 重新生成 / 原地编辑 / 引用）和自动聚焦仍看 canCompose
  const composeEnabled = deriveComposeEnabled({
    awaitingUser: isAwaitingUser,
    awaitingAsk,
    isRunning,
    allowQueueWhileRunning: !!allowQueueWhileRunning,
    submitting: !!submitting,
  });
  // 输入框按运行态画（停止键）：run 在跑，或回车后提交还在飞（服务端还没受理、isRunning 尚为假）。
  // 后者气泡已是正式消息、列表末尾是「准备环境…」，输入框不能还只是一个转圈的发送键、停不了
  // （实测这段窗口热路径 1.3–2.7s、冷路径 4.5–6.7s）。判定与停止语义见 lib/chat-pending-display。
  const composerRunning = shouldShowComposerRunning({
    isRunning,
    submitting: !!submitting,
    awaitingAsk,
  });
  // 后台子代理还在跑（V16-03）：主 AI 说完一轮后 isRunning 归零，没有它输入框就没有停止入口——
  // 只多一个停止键（stopOnly），不把整套运行态带出来（R3-02：转圈 / 「排队发送」/ 附件按钮消失）
  const composerStopOnly = shouldShowComposerStopOnly({
    isRunning,
    submitting: !!submitting,
    awaitingAsk,
    backgroundSubagentCount: backgroundSubagents?.length ?? 0,
  });
  // 停止键 tooltip：有后台子代理时点名「含 N 个」——停止 = 关整个会话，会连带取消它们，别让用户以为只停主 AI
  // （没有后台子代理 = undefined，沿用 composer 默认文案）
  const stopLabel =
    backgroundSubagents && backgroundSubagents.length > 0
      ? `停止（含 ${backgroundSubagents.length} 个后台子代理）`
      : undefined;

  // 输入态整套（草稿 + skill + 图 + 路径附件 + 聚焦句柄）走公共 hook、
  // 跟 task「跟 AI 说」条 / 推进弹窗 / 答题卡同一份实现（见 hooks/use-rich-input.ts）
  const rich = useRichInput({
    taskId: task.id,
    draft: { scope: "reply", id: task.id },
    // 不可输入时附件 handler 短路；chat 排队时 running 仍可附图
    disabled: !composeEnabled,
  });
  const setDraft = rich.setValue;
  const restoreDraft = rich.restore;
  const inputRef = rich.focusRef;
  // 路径 / 图片附件的最新值镜像：提交失败恢复（submitVia 的 restore）发生在 POST 返回之后，
  // 闭包里的 rich.pathAttach.paths / rich.attach.images 是发送那一刻（已秒清）的陈旧值——
  // 合并要读「此刻」的（R5-01：飞行中又贴的图 / 拖的文件不能被快照覆盖）
  const pathsRef = useRef(rich.pathAttach.paths);
  pathsRef.current = rich.pathAttach.paths;
  const imagesRef = useRef(rich.attach.images);
  imagesRef.current = rich.attach.images;

  // 个人偏好的提交快捷键（placeholder 提示用；提交判定在 Composer 内部）
  const submitShortcutHint = getSubmitShortcutHint(useSubmitShortcut());
  // Virtuoso 句柄：搜索命中 / 提问锚点这类「跳到某一项」用 scrollToIndex；
  // 跟随最新的贴底不走它（见下方 scrollToBottom 与跟随控制器）
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // 贴底的**兜底**动作：只有控制器拿不到滚动容器时才会被调——挂载后控制器自己直接写 scrollTop。
  // 不用 Virtuoso 的 scrollToIndex 做日常贴底：它有条内容一直增长就永不结束、又没法取消的重试链，
  // 用户上滚后仍会被它每 ~100ms 拉回底部（2026-10-12 实测，见 scroll-follow 文件头第 4 条）。
  // index:"LAST" 比 items.length-1 稳（分页 firstItemIndex 下不用管索引空间）；
  // behavior 恒 "auto"——流式期间用 smooth 会跟下一次滚动互相打断
  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  }, []);
  // 跟随控制器（2026-07-28）：唯一的「现在该不该自动贴底」判定源。
  // 老实现靠 Virtuoso 的 atBottomThreshold=120 兼职这件事——用户上滚 50px 仍算贴底、
  // 下一个 chunk 就把他拽回去 = 用户实测的「一滚就抖」。现在改成听用户手势意图。
  const follow = useStreamFollow(scrollToBottom);
  // 初始滚动定位闸：首次有 items 时算一次、一律落在最后一条（不再按上次离开的位置恢复，见下方渲染期 latch）；
  // null = 还没算（切 task 时重开）
  const initialTopRef = useRef<number | null>(null);
  // rangeChanged 去重：同一个 startIndex 重复回调直接短路（Virtuoso 重渲会重发同 range）
  const lastRangeStartRef = useRef<number | null>(null);

  // 启动进度渐进单行的「最小停留」缓冲（2026-07-20 用户实测：MCP/建会话两阶段
  // 太快、一闪而过像丢了——每个阶段至少停 BOOT_STAGE_MIN_MS、按序补播；
  // agent 真活动到达（activeBoot=null）时立即清、不为动画拖住真内容）
  //
  // 思考一开始（实时帧到了）启动阶段行就该让位：冷续聊的「正在发送…」在事件流里要等
  // agent 活动事件落盘才会清，而 thinking 事件要整段思考结束才落——不压的话会对着
  // 「正在发送…」干等整段思考。用布尔做依赖：liveThinking 逐帧在变（吐字平滑后每帧最多一次），
  // 别让它拖着 extractActiveBootStage 反复重扫事件。
  const isThinkingLive = liveThinking != null;
  // 状态行「思考中 · 12s」只要一个计时起点——不要原文：原文已经在工作过程组的思考行里滚动展示，
  // 状态行再带一遍就是上下重复（2026-10-12 用户截图）。取原始值（number）而不是整个对象：
  // 起点在整段思考内不变，状态行不跟着每帧重算。null = 没在思考
  const thinkingSince = liveThinking ? liveThinking.since : null;
  const activeBoot = useMemo(
    () =>
      isChat && !isThinkingLive ? extractActiveBootStage(task.events) : null,
    [isChat, isThinkingLive, task.events],
  );
  const displayedBoot = useStagedBootDisplay(activeBoot);

  // 渲染管线拆三层（2026-07-28 性能修）。**层次不能合并**：
  // 老实现把 streamingText 放进同一个 useMemo 的 deps，于是每来一个 chunk 都重跑
  // 一遍 buildStreamItems，产出的 ToolBlock / WorkGroupItem 全是新对象身份 →
  // memo(ToolBlockRow) / memo(WorkGroupRow) 集体失效 → 整个可视工具子树每 chunk
  // 重渲一次。事件一多就掉帧，正好在「流式吐字时去滚动」的场景下最明显。
  //
  // 第一层：只吃真实事件（滤噪声 → thinking 合并 → tool 配对 → 工作过程分组）。
  // isRunning=false 时 coerce 脏 running 工具 →「已中断」（chat / task 共用）
  // 群问答 tab：有旁路问答轮次时才出现；切过去只读呈现，主流程事件流不受影响
  const [showGroupQa, setShowGroupQa] = useState(false);
  // 后台在跑的子代理 id 集合：chat-view 对清单做了相等判断（没变不换引用），这里按引用 memo 即可
  const backgroundJobIds = useMemo(
    () => backgroundJobIdSet(backgroundSubagents),
    [backgroundSubagents],
  );
  const baseItems = useMemo(
    () => buildStreamItems(task.events, isChat, isRunning, backgroundJobIds),
    [task.events, isChat, isRunning, backgroundJobIds],
  );
  // 群问答轮次（原始事件聚合，不走主流程过滤管线；chat 形态无群桥接不展示）
  const groupQaRounds = useMemo(
    () => collectGroupQaRounds(task.events ?? []),
    [task.events],
  );
  // 还有没有更早的可拉（初值来自 task.eventsTruncated、之后由分页响应维护）。
  // 声明放这里而不是分页那一段：群问答只统计已加载的事件，tab 要据此说明范围（D8-01）
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const groupQaScope = deriveGroupQaScope({
    roundCount: groupQaRounds.length,
    hasMoreEarlier,
    hasGroup: !!task.feishuGroupChatId,
    isChat,
  });
  const showQaPanel = showGroupQa && groupQaScope.showTab;
  // 群问答是只读 tab：通知父页面隐藏底部输入条（否则输入框会误导用户在此发言）
  useEffect(() => {
    onGroupQaVisibleChange?.(showQaPanel);
    return () => onGroupQaVisibleChange?.(false);
  }, [showQaPanel, onGroupQaVisibleChange]);
  // 进出 QA tab 时 Virtuoso 会卸载/重挂：range 起点缓存清掉，下一次 rangeChanged
  // 才不会因「同 startIndex 短路」跳过 sticky 重算（否则切回事件流粘顶头状态是旧的）。
  useEffect(() => {
    lastRangeStartRef.current = null;
    // 进群问答 tab 时 Virtuoso 整个卸载、切回来是重新挂载，而 initialTopMostItemIndex 读的是 initialTopRef——
    // 它只在为 null 时写一次、只有切 task 才复位，不清的话切回来会用首次加载时的陈旧下标重挂（V17-02）。
    // 只在「进入」时清：切回事件流那次渲染的 latch（见下方「初始定位」）会重新落在最后一条并恢复跟随，
    // 与进入对话 / 任务同一个行为（2026-10-17 用户拍板「进入一律落在最后一条」）
    if (showQaPanel) initialTopRef.current = null;
  }, [showQaPanel]);
  // agent 正好 ask_user 时自动切回事件流：QA 是只读 tab，问答卡+提示条+输入框全藏，
  // 用户盯着 QA 页收不到任何信号、agent 干等。只在 null→有 的上升沿切一次；
  // 之后用户爱看哪看哪（ask 等人期间最可能要翻 QA 再回追问，不能每次点 QA 都被踢回）。
  const prevHadPendingAskRef = useRef(false);
  useEffect(() => {
    const has = !!pendingAskEvent;
    const rose = has && !prevHadPendingAskRef.current;
    prevHadPendingAskRef.current = has;
    if (rose && showQaPanel) setShowGroupQa(false);
  }, [pendingAskEvent, showQaPanel]);
  // 进行中轮次 → tab 上亮蓝点（主流程里它完全隐身，不给提示用户不知道有人问了，review P1-4）。
  // 已知局限：answering 按快照时间算，无新事件就不重算——崩溃打断的那轮蓝点会常亮到下个事件到来。
  // 故意的：这组件有过输入卡顿 perf 坑，不加分钟级 tick；下个事件（属主说句话）到就灭。
  const groupQaAnswering = groupQaRounds.some((r) => r.answering);
  // 答疑 agent 标了「需属主确认」的轮次数（24h 内）：tab 上亮 brand 点，群里有事等属主拍板时不至于没人发现。
  const groupQaNeedsOwnerCount = useMemo(
    () => pickRoundsNeedingOwner(groupQaRounds).length,
    [groupQaRounds],
  );

  // 第二层：未答的答题卡固定挪到流末尾——AI 提问后若又输出了正文（prompt 约束外的
  // 漏网），渲染层兜底保证答题卡不被顶走（纯显示排序、数据不动、2026-07-23 用户实测痛点）。
  // 不原地 splice：baseItems 是 memo 结果、改它会污染下一次复用。
  const orderedItems = useMemo(() => {
    if (!pendingAskEvent) return baseItems;
    const askIdx = baseItems.findIndex(
      (it) => it.kind === "ask_user_request" && it.id === pendingAskEvent.id,
    );
    if (askIdx < 0 || askIdx === baseItems.length - 1) return baseItems;
    const next = [...baseItems];
    const [askItem] = next.splice(askIdx, 1);
    next.push(askItem!);
    return next;
  }, [baseItems, pendingAskEvent]);

  // 有「立即发送途中」的占位（刚按回车、user_reply 还没落盘）：气泡按正式消息显示，
  // 「在等什么」由列表末尾的进度行说明（取代旧的虚线「发送中…」气泡）
  const hasInflight = useMemo(
    () => isChat && hasInflightPending(pendingLocalReplies),
    [isChat, pendingLocalReplies],
  );

  // 流式 → 定稿的「同一个节点」交接（lib/stream-handoff，2026-10-17「吐完字整段抖一下」）：
  // 流式项 id 按段编号；流式结束时流里新冒出来的 assistant_message 接管这一段的 Virtuoso key，
  // 整段正文不再卸载重挂。渲染期 setState（由输入推导 state）：同输入重算结果不变，StrictMode 安全。
  const lastRenderedAssistantId = useMemo(
    () => findLastAssistantId(orderedItems),
    [orderedItems],
  );
  const [handoffState, setHandoffState] = useState(INITIAL_STREAM_HANDOFF);
  const handoff = nextStreamHandoff(handoffState, {
    streaming: !!streamingText,
    lastAssistantId: lastRenderedAssistantId,
  });
  if (handoff !== handoffState) setHandoffState(handoff);

  // 第三层：追加 pending / streaming / loading / boot 虚拟项（不参与分组）。
  // 只有这层跟着 chunk 变、而它产出的新身份只有末尾那一两个虚拟项。
  const items: RenderItem[] = useMemo(() => {
    // 正在进行的思考：合成一条 thinking 事件、并进工作过程流程的流尾，由已有的思考行渲染
    // （落盘后同 id 的真实 thinking 事件接替它、是同一个节点）。
    // 正文已经在流（streamingText）就不再是思考态——兜住实时帧晚于正文到达的竞态。
    // 放在这一层而不是 baseItems：它随思考实时帧变、不能拖着整条分组管线重算；
    // attachLiveThinking 只改流尾一项、前面的项引用不变，memo 的成员行不会被击穿
    const live = isChat && isRunning && !streamingText ? liveThinking : null;
    const flow = live ? attachLiveThinking(orderedItems, live) : orderedItems;
    const pendingItems = (pendingLocalReplies ?? []).map(
      (p): PendingLocalItem => ({
        kind: "__pending_local__",
        id: p.id,
        text: p.displayText,
        uncertain: p.uncertain,
        mode: p.mode,
        itemId: p.itemId ?? p.id,
      }),
    );
    const withPending: RenderItem[] = [...flow, ...pendingItems];
    if (streamingText) {
      // 流式气泡排在 flow 之后、**所有 pending 之前**（V1-01）：老写法对拼好 pending 的数组插，
      // 流式项落到排队气泡下面（排队气泡画在回复上方），定稿后回复变成 flow 里的事件、排队气泡又跳到它下面。
      // 压缩 info 会落在 events 尾部；流式气泡默认拼末尾会跑到压缩上面——
      // composeStreamTail 内部插到尾部连续 compaction 之前，视觉上是「回复 → 正在压缩」。
      return composeStreamTail<RenderItem>(flow, pendingItems, {
        kind: "__streaming__",
        // 按段编号（不是固定 "__streaming__"）：上一段被定稿事件接管的 key 不能被下一段撞上
        id: streamItemId(handoff.seq),
        text: streamingText,
      });
    }
    // 流程里已经有「正在思考」这一行 = 模型已经在干活：不再叠启动阶段行 / 「等待模型响应…」
    if (live) return withPending;
    // F 批次：启动链进度（正在检查 MCP / 创建会话 / 发送首包）——
    // 渐进单行（经最小停留缓冲挨个切换）；agent 活动后整组消失。
    // 有活跃 boot 行时它就是进度指示、压制通用 __loading__ 占位。
    if (isChat && displayedBoot) {
      return [
        ...withPending,
        {
          kind: "__boot_stage__",
          id: displayedBoot.id,
          text: displayedBoot.text,
        },
      ];
    }
    // 「发出消息 → 程序受理」空白期：排除本地 pending 占位后看末项，
    // 避免 pending 压制 loading（二者可并存）。分组后 user_reply 仍独立，
    // last.kind === "user_reply" 判定不变。
    let last: RenderItem | undefined;
    for (let i = withPending.length - 1; i >= 0; i--) {
      const it = withPending[i]!;
      if (it.kind !== "__pending_local__") {
        last = it;
        break;
      }
    }
    const lastIsUser =
      !!last &&
      last.kind !== "__streaming__" &&
      last.kind !== "__loading__" &&
      last.kind !== "__tool_block__" &&
      last.kind !== "__tool_verb_group__" &&
      last.kind !== "__work_group__" &&
      last.kind === "user_reply";
    // ③ 已受理、启动提示（如「已跳过不可用的 MCP」）已落盘成「启动过程」组、模型还没开口：
    // 末项不再是 user_reply，但仍是「等 AI」。启动阶段的 ephemeral 进度行（displayedBoot）只在内存里，
    // 回车后立刻切走再切回会丢——不在这里补，列表里就一个「在转」的东西都没有（2026-10-17 用户截图）。
    // 只在 chat 判：task 形态没有状态行、启动组本来就带自己的进行态。
    const lastIsBootOnly = isChat && isBootOnlyWorkGroup(last);
    // 两段共用同一个 __loading__ 项（同 id → 占位落盘交接时不重挂载、「已等待 Ns」不清零）：
    // ① 已按回车、user_reply 还没落盘（inflight 占位）——此时 runStatus 可能还没 running；
    // ② 已受理、user_reply 已落盘、AI 还没动静（原有）；③ 同上、但流尾是纯启动提示组。
    if (
      shouldShowSendLoading({
        isRunning,
        lastIsUser: lastIsUser || lastIsBootOnly,
        hasInflight,
      })
    ) {
      return [
        ...withPending,
        {
          kind: "__loading__",
          id: "__loading__",
          since: loadingSinceTs(withPending as ReadonlyArray<{ kind: string; ts?: number }>, hasInflight),
        },
      ];
    }
    return withPending;
  }, [
    orderedItems,
    streamingText,
    handoff.seq,
    isRunning,
    isChat,
    pendingLocalReplies,
    hasInflight,
    displayedBoot,
    liveThinking,
  ]);

  // 「N 条新内容」的计量单位（回到最新按钮）：工作过程组按**成员**摊开算。
  //
  // 直接用 items.length 会在最需要它的场景下失灵——一个 build action 打出的几十上百个
  // 工具块是连续过程项，groupChatRenderItems 全收进同一个工作过程组，items.length
  // 一动不动；于是用户翻在历史里、agent 忙了十分钟，按钮上还挂着「0」。
  //
  // 挂 baseItems 不挂 items：虚拟项（streaming / loading）是在分组之后才追加的、不在 baseItems 里，
  // 不会让计数每秒重算几十次；流式那段落成 assistant_message 事件时自然计进来。
  // 取 baseItems 而不是 orderedItems：后者把未答 ask 挪到末尾，会盖住真正的时间序尾部（锚点要认真尾）。
  const contentUnitIds = useMemo(() => streamContentUnitIds(baseItems), [baseItems]);
  // 上拉 prepend 后待抬高「新内容」基线的增量（StreamFloatingBar 渲染期消费）
  const prependBaselineBumpRef = useRef(0);
  // Virtuoso prepend 的锚定基准；itemContent 回调会带此偏移，命令式 scrollToIndex
  // 仍使用 data 本地下标（两套坐标不要混用）。
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_INDEX_BASE);

  // ---------- 事件流内联搜索 ----------
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitIndex, setSearchHitIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastSearchQueryRef = useRef("");
  const searchScrollRootRef = useRef<HTMLElement | null>(null);
  const [searchScrollRoot, setSearchScrollRoot] = useState<HTMLElement | null>(
    null,
  );

  // 切 task 回事件流（群问答 tab 是任务内视图，别串台）；搜一激活也切回（搜索只查主流程）
  // review P2-8：搜的时候停在 QA tab 里容易懵。
  useEffect(() => {
    setShowGroupQa(false);
  }, [task.id]);
  const activateStreamSearch = useCallback(() => {
    setActivePaneSearchScope("event-stream");
    setShowGroupQa(false);
    setSearchActive(true);
    searchInputRef.current?.focus();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    });
  }, []);

  const closeStreamSearch = useCallback(() => {
    setSearchActive(false);
    setSearchQuery("");
    setSearchHitIndex(-1);
  }, []);

  useEffect(() => {
    const onFocusSearch = () => activateStreamSearch();
    window.addEventListener(EVENT_STREAM_SEARCH_FOCUS_EVENT, onFocusSearch);
    return () =>
      window.removeEventListener(EVENT_STREAM_SEARCH_FOCUS_EVENT, onFocusSearch);
  }, [activateStreamSearch]);

  const searchOccurrences = useMemo(
    () =>
      searchActive
        ? searchEventStreamRenderOccurrences(items, searchQuery)
        : [],
    [items, searchActive, searchQuery],
  );

  const isSearchFiltering =
    searchActive &&
    normalizeEventStreamSearchQuery(searchQuery).length > 0;

  const currentSearchOwnerId =
    searchHitIndex >= 0
      ? (searchOccurrences[searchHitIndex]?.ownerId ?? null)
      : null;
  const currentSearchOwnerOccurrenceIndex = ownerOccurrenceIndexAt(
    searchOccurrences,
    searchHitIndex,
  );

  const searchHitOwnerIds = useMemo(() => {
    if (!isSearchFiltering) return new Set<string>();
    return new Set(searchOccurrences.map((o) => o.ownerId));
  }, [isSearchFiltering, searchOccurrences]);
  // Provider 的 value 必须引用稳定：搜索开着时每帧新对象会让所有消费者行绕过 memo（D3-03 放大器）。
  // 文本高亮统一交给 DOM/CSS Highlight；这里只保留 owner 集合，供折叠行自动展开。
  const searchHighlightCtx = useMemo(
    () => (isSearchFiltering ? { hitOwnerIds: searchHitOwnerIds } : null),
    [isSearchFiltering, searchHitOwnerIds],
  );
  // DOM 高亮 / 定位只扫「模型有命中」的 owner（D3-07：用户气泡 / 思考 / info 不进索引，别涂黄）。
  // 走 ref 读取：命中集合每来一个事件都是新 Set，进 effect 依赖会让 reveal effect 每个事件重滚一次
  const searchHitOwnerIdsRef = useRef(searchHitOwnerIds);
  searchHitOwnerIdsRef.current = searchHitOwnerIds;

  // 查询 / 事件变化：保持「当前命中」。上一轮的命中表放 ref——按 occurrence 身份找回原选中项，
  // 而不是只按下标：上拉 / 「加载更早的再搜」prepend 更早事件后，新命中插在前面，
  // 同一个下标会指向另一处命中、视口被拽走（见 stabilizeOccurrenceSelection）
  const prevSearchOccurrencesRef = useRef(searchOccurrences);
  useEffect(() => {
    const prevOccurrences = prevSearchOccurrencesRef.current;
    prevSearchOccurrencesRef.current = searchOccurrences;
    if (!isSearchFiltering) {
      setSearchHitIndex(-1);
      return;
    }
    setSearchHitIndex((prev) =>
      stabilizeOccurrenceSelection(prevOccurrences, prev, searchOccurrences),
    );
  }, [searchOccurrences, isSearchFiltering]);

  // 搜索 / 跳旧事件：暂停自动跟随
  useEffect(() => {
    if (isSearchFiltering) follow.setFollowing(false);
  }, [follow, isSearchFiltering]);

  // 切 task 退出搜索并重置查询记忆
  useEffect(() => {
    closeStreamSearch();
    lastSearchQueryRef.current = "";
  }, [task.id, closeStreamSearch]);

  // 全流最后一个工作过程组 id：尾部 running 展开判定用（isRunningTail）。
  // 挂 orderedItems 不挂 items——虚拟项里没有工作过程组，跟着 chunk 重算纯属浪费
  const lastGroupId = useMemo(() => {
    for (let i = orderedItems.length - 1; i >= 0; i--) {
      const it = orderedItems[i]!;
      // 用 kind 判别收窄（RenderItem 比 ChatRenderItem 宽，不能直接调 isWorkGroup）
      if (it.kind === "__work_group__") return it.id;
    }
    return null;
  }, [orderedItems]);
  // 流的最后一项是不是工作过程组（后面已经有正文 / 流式占位就不再挂「处理中…」）
  const lastItemIsWorkGroup =
    orderedItems[orderedItems.length - 1]?.kind === "__work_group__";

  // 粘性状态行的输入切片：只保留「最近一条 user_reply / action_start 起」的本轮事件
  // （切法在 chat-turns 的 sliceCurrentRunEvents；task 形态一轮 run 以 action_start 开头，V16-05）。
  //
  // 为什么要切（2026-07-28 性能修）：deriveActiveStatus 的第一步是 O(全部事件) 地收
  // doneCallIds，而下面那个 memo 的依赖里有 liveToolOutputs——shell 直播每来一个
  // delta 就是一个新对象引用，memo 必然重算。跑 `pnpm build` 这种每秒几十行输出的
  // 命令、events 又攒到几千条时，主线程就在持续重扫全量事件。
  //
  // 为什么切了等价：deriveActiveStatus 从尾部回扫、**撞到 user_reply 必定收尾**
  //（「正在启动…」那条分支），所以它根本走不到最近一条 user_reply 之前；而 tool_result
  // 永远晚于自己的 tool_call，切片里的 tool_call 要配的 result 也一定在切片内，
  // doneCallIds 因此不会漏。结论：同样的答案，扫描量从「全量」降到「本轮」。
  // 没有起点事件（刚建的 chat）时退回全量，那会儿本来也没几条。
  // task 形态原先整个吃全量（那时没有状态行）；接上状态行后必须和 chat 走同一条切片路，
  // 否则 task 的 shell 直播每个 delta 都会重扫整个任务的事件（V16-05）。
  const statusEvents = useMemo(
    () =>
      sliceCurrentRunEvents(task.events).filter(
        (e) => !isHiddenFromEventStream(e, { isChat }),
      ),
    [isChat, task.events],
  );

  // 流尾是不是一行进度（「等待模型响应…」/ 启动阶段）。是 = 它已经在说「还在等」，
  // 状态行的「正在启动…」就别再说一遍（同一件事上下各一句，和思考原文重复是一个毛病）。
  // 只取布尔：items 逐 chunk / 逐帧在变，别让状态行跟着重算
  const tailHasProgressRow = useMemo(() => {
    const last = items[items.length - 1];
    return !!last && (isLoadingItem(last) || isBootStageItem(last));
  }, [items]);
  // 正文是否已经在流：只取布尔——streamingText 逐帧变，状态行没必要逐帧重算、逐帧换新对象
  const isStreamingText = !!streamingText;
  // 整个任务最后一条事件的 ts：状态行「静默兜底」的锚。O(1) 取尾项、产出原始数值，
  // 不用 statusEvents（它滤掉了隐藏事件，而隐藏事件也是「还在动」的证据）
  const lastEventTs = latestEventTs(task.events);

  // 运行中粘性状态行（Batch C）：running 时 chat / task 都有；有 streamingText 时 label「正在回复…」正常。
  // task 形态（V16-05）：assistant_message 之后 / 落盘的 thinking 之后 / action_start 后的「启动过程」组，
  // 流里没有任何转圈或计时、唯一的活信号是页面头部的「停止」（长列表滚下去就看不见）——
  // 同一个纯函数、同一份本轮切片，画在事件流底部（见下方 reserveTaskStatusSlot）。
  // task 的 liveToolOutputs 每个 delta 也是新引用：输入只能是本轮切片（statusEvents），别挂回全量事件
  const activeStatus = useMemo(() => {
    // 只看属主主 run：旁路群答疑 run 在飞不该让主任务的状态行冒出来（R3-05）
    if (!mainRunActive) return null;
    // 刚按回车、user_reply 还没落盘：列表末尾已有「准备环境…」进度行；
    // 此时 statusEvents 还停在上一轮，回扫会闪出上一轮的「正在回复…」——不并存
    if (hasInflight) return null;
    const status = deriveActiveStatus(statusEvents, liveToolOutputs, {
      // 静默兜底的锚：整个任务最后一条事件的 ts（原始数值、在 memo 外算——
      // 这里不能碰全量事件列表，见 statusEvents 上方「2026-07-28 性能修」）
      lastActivityTs: lastEventTs,
      // 有未答的提问：事件流静默是在等用户答，不是卡住——别改口「仍在等待 · 暂无新输出」
      awaitingUser: awaitingAsk,
      streaming: isStreamingText,
      // 思考进行中：落盘的 thinking 事件要等整段结束才有，不靠它状态行会一直说「处理中…」。
      // 只传计时起点、不传原文——原文在工作过程组的思考行里，不上下各摆一遍
      thinkingSince,
    });
    // 「正在启动…」让位：流尾已经有一行进度时，状态行不再并存（见 tailHasProgressRow）
    if (status?.yieldToTail && tailHasProgressRow) return null;
    return status;
  }, [
    mainRunActive,
    hasInflight,
    statusEvents,
    lastEventTs,
    awaitingAsk,
    liveToolOutputs,
    isStreamingText,
    thinkingSince,
    tailHasProgressRow,
  ]);

  // 状态行这一帧会不会真的画出来：与下方渲染条件同口径——
  // chat = 输入框上方那条（隐藏输入区时不画）；task = 事件流底部那条（V16-05，恒画、有 activeStatus 才有内容）。
  // 画出来时它已经在说「正在分析 X 的结果 · 12s」，工作过程组尾的「处理中…」据此让位，
  // 不再同一句废话上下各说一遍；没有状态行可让位时（没在跑 / 让位给流尾进度行），组尾仍兜底
  const statusLineVisible = (!isChat || !hideReplyComposer) && !!activeStatus;

  // 状态行「跳过等待」：叫醒本会话里在睡的 wait（0 个 = 刚好到点自己醒了，不提示）。
  // 失败才 toast；成功后状态行靠事件流里 wait 的 tool_result 自己切走
  const taskIdForSkip = task.id;
  const handleSkipWait = useCallback(async () => {
    try {
      await skipWait(taskIdForSkip);
    } catch (err) {
      toast.error(`跳过等待失败：${(err as Error).message}`);
    }
  }, [taskIdForSkip]);

  // 状态行槽位：运行期间（含刚按回车、还没 running 的那一小段）始终占住 h-7 的位置。
  // 状态行有 / 无（让位给流尾进度行、两种状态切换的间隙）时，输入框和事件流可视区高度不变——
  // 不预留的话，状态行每出没一次，输入框就整体上下跳 28px、事件流底部跟着伸缩。
  const reserveStatusSlot = isChat && (isRunning || hasInflight || !!submitting);
  // task 形态的同款槽位（事件流底部）：运行期间预留，状态行出没不带着列表可视区高度上下跳。
  // 没有 hasInflight / submitting：那两个是 chat 输入框的提交飞行态，task 的「跟 AI 说」在页面级输入条里
  // 只看属主主 run：旁路群答疑在飞时空闲任务不该撑开一个空槽并动画伸缩（R3-05）
  const reserveTaskStatusSlot = !isChat && mainRunActive;

  // 轮次分割判定用的 kind 序列。挂 orderedItems 不挂 items：虚拟项一律追加在尾部、
  // 且都不是 user_reply，越界读回 undefined、shouldShowTurnDivider 自然返回 false，
  // 语义等价但少一次每 chunk 的全量 map
  const itemKinds = useMemo(
    () => orderedItems.map((it) => it.kind),
    [orderedItems],
  );

  // E1 sticky 轮次头：当前轮的用户消息句（滚出视口上沿后粘顶、点击回滚到该轮头部）。
  // Virtuoso 无逐组 sticky API——用 rangeChanged + 绝对定位 overlay。
  // ⚠️ 必须命令式更新 DOM、禁止 setState：滚动热路径 setState → Virtuoso 重渲 →
  // startIndex 在 user_reply 边界来回翻 → 粘顶显隐振荡 = 快速持续抖动（2026-07-23）。
  const stickyRootRef = useRef<HTMLDivElement | null>(null);
  const stickyTextRef = useRef<HTMLSpanElement | null>(null);
  // 当前粘顶的 user_reply id（点击回滚 + 去重用）
  const stickyTurnIdRef = useRef<string | null>(null);
  // items 最新快照：rangeChanged / sticky 点击不闭包陈旧 items
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const attachScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      follow.attachScroller(el);
      const root = el instanceof HTMLElement ? el : null;
      searchScrollRootRef.current = root;
      setSearchScrollRoot(root);
    },
    [follow],
  );

  // 「跳到某一项」的唯一出口（搜索命中 / 未答提问 / 点横幅回到本轮开头）。
  //
  // **先停跟随、再滚**——这是「流式吐字时点横幅回到上一条、回去一半又弹回来」的修法
  // （2026-10-17 用户实测）：流式期间跟随态是 true，每个 chunk 都会触发贴底（跟随 effect /
  // totalListHeightChanged / 控制器的贴底链），程序化的 scrollToIndex 没有「用户上滚」手势、
  // 状态机不会自己停跟随，于是它刚往上滚了一半就被下一帧的贴底写回底部。
  // 先 setFollowing(false)（它还会取消正在进行的「回到最新」滑行）：之后用户自己往下翻
  // 回到贴底带才恢复，期间悬浮条给「回到最新」。
  //
  // index 是 data 的本地下标；firstItemIndex 只服务 prepend 锚定、传绝对偏移会被 Virtuoso 钳制到末项。
  const jumpToItem = useCallback(
    (
      index: number,
      align: "start" | "center",
      behavior: "auto" | "smooth",
    ) => {
      follow.setFollowing(false);
      virtuosoRef.current?.scrollToIndex({ index, align, behavior });
    },
    [follow],
  );

  const scrollToSearchHit = useCallback(
    (eventId: string | null) => {
      if (!eventId) return;
      const idx = findRenderIndexForEventId(itemsRef.current, eventId);
      if (idx < 0) return;
      jumpToItem(idx, "center", "auto");
    },
    [jumpToItem],
  );

  const goToSearchHit = useCallback(
    (index: number) => {
      if (index < 0 || index >= searchOccurrences.length) return;
      setSearchHitIndex(index);
    },
    [searchOccurrences.length],
  );

  const goToNextSearchHit = useCallback(() => {
    const next = stepOccurrenceIndex(
      searchHitIndex,
      searchOccurrences.length,
      "next",
    );
    if (next >= 0) goToSearchHit(next);
  }, [goToSearchHit, searchHitIndex, searchOccurrences.length]);

  const goToPrevSearchHit = useCallback(() => {
    const prev = stepOccurrenceIndex(
      searchHitIndex,
      searchOccurrences.length,
      "prev",
    );
    if (prev >= 0) goToSearchHit(prev);
  }, [goToSearchHit, searchHitIndex, searchOccurrences.length]);

  useEffect(() => {
    if (!isSearchFiltering || searchOccurrences.length === 0) return;
    if (lastSearchQueryRef.current !== searchQuery) {
      lastSearchQueryRef.current = searchQuery;
      goToSearchHit(0);
    }
  }, [goToSearchHit, isSearchFiltering, searchOccurrences.length, searchQuery]);

  useEffect(() => {
    if (!isSearchFiltering || !currentSearchOwnerId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const revealMountedTarget = (): boolean => {
      const root = searchScrollRootRef.current;
      const matches = root
        ? findOwnerDomSearchMatches(root, searchQuery, searchHitOwnerIdsRef.current)
        : [];
      const target = matches.find(
        (match) =>
          match.ownerId === currentSearchOwnerId &&
          match.ownerOccurrenceIndex === currentSearchOwnerOccurrenceIndex,
      );
      if (target) {
        applyDomSearchHighlights(
          matches,
          "flowship-event-search",
          "flowship-event-search-active",
          (match) => match === target,
        );
        scrollDomSearchMatchIntoView(target, root);
        return true;
      }
      return false;
    };

    // 同一虚拟视口内切换命中时直接精确滚到文字，避免先滚整行、再滚文字造成抖动。
    // 只有目标尚未挂载时才先唤醒对应 Virtuoso 行，再等待正文出现。
    if (revealMountedTarget()) return;
    scrollToSearchHit(currentSearchOwnerId);

    const revealTarget = () => {
      if (cancelled || revealMountedTarget()) return;
      // Virtuoso 目标行和命中后自动展开的正文都可能晚一拍挂载；在一秒内重试，
      // 避免旧实现只查一次、遇到隐藏/未挂载内容就静默失效。
      attempts += 1;
      if (attempts < 25) timer = setTimeout(revealTarget, 40);
    };
    timer = setTimeout(revealTarget, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    currentSearchOwnerOccurrenceIndex,
    currentSearchOwnerId,
    isSearchFiltering,
    searchQuery,
    scrollToSearchHit,
  ]);

  // 高亮以当前已渲染 DOM 为准。虚拟列表换行、折叠区展开或流式文本变化后自动重建，
  // 不再让 Streamdown 的块级 memo 留下旧查询的半截 <mark>。
  useEffect(() => {
    const root = searchScrollRoot;
    if (!root || !isSearchFiltering) {
      clearDomSearchHighlights(
        "flowship-event-search",
        "flowship-event-search-active",
      );
      return;
    }
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const matches = findOwnerDomSearchMatches(
        root,
        searchQuery,
        searchHitOwnerIdsRef.current,
      );
      applyDomSearchHighlights(
        matches,
        "flowship-event-search",
        "flowship-event-search-active",
        (match) =>
          match.ownerId === currentSearchOwnerId &&
          match.ownerOccurrenceIndex === currentSearchOwnerOccurrenceIndex,
      );
    };
    const scheduleRefresh = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    scheduleRefresh();
    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearDomSearchHighlights(
        "flowship-event-search",
        "flowship-event-search-active",
      );
    };
  }, [
    currentSearchOwnerId,
    currentSearchOwnerOccurrenceIndex,
    isSearchFiltering,
    searchQuery,
    searchScrollRoot,
  ]);

  const applyStickyTurn = (next: { id: string; text: string } | null) => {
    const nextId = next?.id ?? null;
    // 同 id 已应用过 → 跳过（滚动热路径高频）
    if (nextId === stickyTurnIdRef.current) return;
    const root = stickyRootRef.current;
    const textEl = stickyTextRef.current;
    // root 尚未挂上时不提前写 id——否则永远补不上显隐
    if (!root) return;
    stickyTurnIdRef.current = nextId;
    if (next) {
      root.classList.remove(...STICKY_HIDDEN_CLASSES);
      root.classList.add(...STICKY_SHOWN_CLASSES);
      if (textEl) textEl.textContent = summarize(next.text);
    } else {
      // 淡出而不是 display:none 一下消失；文字留着（淡出期间还看得见），下次显示时再覆盖
      root.classList.remove(...STICKY_SHOWN_CLASSES);
      root.classList.add(...STICKY_HIDDEN_CLASSES);
    }
  };

  // ---------- v1.0.x 事件懒加载（上拉分页） ----------
  // firstItemIndex：Virtuoso prepend 保滚动位置的官方机制——头部插 N 个 item 就减 N
  // （hasMoreEarlier / setHasMoreEarlier 的声明提到了「群问答 tab」那一段之前——tab 的范围提示要用它）
  // 拉取飞行中（顶部小 spinner、渲染用）
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // 上一次拉取失败（顶部显示手动重试；下一次开拉时清掉）
  const [earlierFailed, setEarlierFailed] = useState(false);
  // 同步重入闸（state 版有一帧延迟、startReached 同帧可双进 → firstItemIndex 多减）
  const loadingEarlierRef = useRef(false);
  // 是否已经拉过至少一页（防 SSE 重连把 eventsTruncated 重新置 true 时误重开分页）
  const pagedOnceRef = useRef(false);
  // 最新 events 的 ref：分页请求飞行期间可能有新事件 append、算 items 增量要用最新值
  const latestEventsRef = useRef(task.events);
  latestEventsRef.current = task.events;
  // 当前 task.id 的 ref——上拉分页迟到回调比对用（快切后丢弃串任务的 prepend）
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;

  // 切 task 重置分页状态 + 换载对应输入（hook 的初值只在 mount 时读一次、详情页内导航不重挂）
  useEffect(() => {
    pagedOnceRef.current = false;
    loadingEarlierRef.current = false;
    setFirstItemIndex(FIRST_INDEX_BASE);
    setHasMoreEarlier(false);
    setLoadingEarlier(false);
    setEarlierFailed(false);
    // 切 task 换载对应输入：正文草稿 + 图/路径快照一起回来（restore 内部先读后装，
    // 不会像老的两段式那样把空串写回存储抹掉目标草稿）
    restoreDraft();
    // 重开初始定位闸；跟随态**不在这里**改——它跟初始定位是同一个决定，
    // 统一由下面的渲染期 latch 出（effect 跑在渲染之后，在这里置 true 会把
    // 同一帧刚按锚点恢复出来的「非贴底」冲掉）
    initialTopRef.current = null;
    lastRangeStartRef.current = null;
    stickyTurnIdRef.current = null;
    // 切 task：命令式藏 sticky（不走 setState；root 可能尚未挂上、下帧再清也行）。
    // 切任务不需要淡出——旧任务的文案立刻清掉，免得淡出的那 150ms 里挂着上个任务的提问
    const root = stickyRootRef.current;
    if (root) {
      root.classList.remove(...STICKY_SHOWN_CLASSES);
      root.classList.add(...STICKY_HIDDEN_CLASSES);
    }
    const textEl = stickyTextRef.current;
    if (textEl) textEl.textContent = "";
  }, [task.id, restoreDraft]);
  // eventsTruncated 就绪（refresh / SSE bootstrap 都可能晚于 mount）时同步分页开关（升降都跟）；
  // 已经拉过页就不再被它改（本地分页状态才是准的）
  useEffect(() => {
    if (!pagedOnceRef.current) setHasMoreEarlier(!!task.eventsTruncated);
  }, [task.eventsTruncated]);
  // 窗口被整体换成更晚的尾窗口（resync）：首条事件往后移了 → 「已翻到头」的结论作废、重开分页（评审 N4，
  // 规则与理由见 earlier-events.shouldReopenEarlierPaging）。放在 eventsTruncated 同步 effect 之后：
  // 同一次提交里两者都跑时，这里的 true 是最终值。
  const lastFirstEventTsRef = useRef<number | null>(null);
  const firstEventTs = task.events[0]?.ts ?? null;
  useEffect(() => {
    const prevFirstTs = lastFirstEventTsRef.current;
    lastFirstEventTsRef.current = firstEventTs;
    if (
      shouldReopenEarlierPaging({
        prevFirstTs,
        firstTs: firstEventTs,
        pagedOnce: pagedOnceRef.current,
        truncated: !!task.eventsTruncated,
      })
    ) {
      pagedOnceRef.current = false;
      setHasMoreEarlier(true);
    }
  }, [firstEventTs, task.eventsTruncated]);

  // 上拉到顶：拉更早的事件、prepend + firstItemIndex 同步递减（同一次 React batch、滚动不跳）。
  //
  // ⚠️ 一次上拉必须「顶部多出至少一条可见条目、或历史读完」才算完（fetchEarlierBatch）：
  // 分页按原始事件条数切、渲染按回合折叠，一整页事件可能全是最顶上那个工作过程组的成员——
  // 这样 prepend 后条目数不变 → firstItemIndex 不变 → Virtuoso 的 startReached（按第一项序号
  // distinctUntilChanged）不会再触发，用户停在 scrollTop=0 就再也翻不动了（2026-10-13 用户反馈）。
  //
  // 带 `until`（提问时间线点了窗口之外的更早一轮）= 一直拉到目标事件出现为止（最多 until.maxEvents 条原始事件）；
  // 复用同一套 prepend + firstItemIndex 同步递减，**不**另起「整窗替换」——那会让 Virtuoso 的视口锚定整个失效。
  // 返回 started=false 表示没起跑（已有分页在飞 / 历史已读完 / 只读视图）；其余字段只在带 until 时有意义。
  const loadEarlier = async (until?: {
    eventId: string;
    maxEvents: number;
    /** 每批开拉之前问一次：返回 true 就停（用户自己滚了 / 回退 / 切任务） */
    isAborted?: () => boolean;
  }): Promise<EarlierJumpResult> => {
    const result: EarlierJumpResult = {
      started: false,
      found: false,
      aborted: false,
      capped: false,
      exhausted: false,
      failed: false,
    };
    if (loadingEarlierRef.current || !hasMoreEarlier || !onPrependEvents) return result;
    if (!latestEventsRef.current[0]) return result;
    result.started = true;
    let loadedEvents = 0;
    // 闭包捕获当次 task.id；await 后与当前 props 比对，不一致则丢弃（审查：快切串任务）
    const requestedTaskId = task.id;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    setEarlierFailed(false);
    try {
      for (;;) {
        if (until?.isAborted?.()) {
          result.aborted = true;
          break;
        }
        const batch = await fetchEarlierBatch({
          ...(until
            ? { untilEventId: until.eventId, pageSize: OUTLINE_JUMP_PAGE_SIZE }
            : {}),
          getCurrent: () => latestEventsRef.current,
          fetchPage: (beforeId, limit) =>
            fetchEarlierEvents(requestedTaskId, beforeId, limit),
          // 与 items useMemo / 下面的 firstItemIndex 差值同一个函数
          countItems: (evs) =>
            buildStreamItems(evs as TaskEvent[], isChat, isRunning, backgroundJobIds)
              .length,
          isCancelled: () => taskIdRef.current !== requestedTaskId,
        });
        if (!batch || taskIdRef.current !== requestedTaskId) {
          return { ...result, started: false };
        }
        pagedOnceRef.current = true;
        // 再按提交时刻的本地事件去重一次（飞行期间本地可能已合入部分重叠事件、
        // 用原始 older 算差值会虚高 → firstItemIndex 多减 → 滚动错位）
        const cur = latestEventsRef.current;
        const known = new Set(cur.map((e) => e.id));
        const fresh = batch.fresh.filter((e) => !known.has(e.id));
        if (fresh.length > 0) {
          // items 增量不能直接用 fresh.length：渲染层有 thinking / tool 配对 /
          // chat 工作组跨页合并——必须与 items 同一套 buildStreamItems 算前后条数差值
          const beforeItems = buildStreamItems(
            cur,
            isChat,
            isRunning,
            backgroundJobIds,
          );
          const afterItems = buildStreamItems(
            [...fresh, ...cur],
            isChat,
            isRunning,
            backgroundJobIds,
          );
          const beforeLen = beforeItems.length;
          const afterLen = afterItems.length;
          // 非贴底时 prepend 会让内容单元数变大，须同步抬高基线以免误报「N 条新内容」（锚点丢了时才会用到）
          if (!follow.isFollowing()) {
            prependBaselineBumpRef.current +=
              countStreamContentUnits(afterItems) -
              countStreamContentUnits(beforeItems);
          }
          onPrependEvents(fresh);
          // 循环里下一批紧接着就开始、要拿「最新的第一条」当游标：latestEventsRef 平时只在渲染时更新，
          // 这里同步预置成已 prepend 的列表——否则下一批开头读到的还是旧的第一条，
          // 会把刚拉到的这一页再请求一次（按 id 去重不出错，只是白多一次请求）。
          // 下一次渲染会用真实的 task.events 覆盖它，不会有偏差。
          latestEventsRef.current = [...fresh, ...cur];
          setFirstItemIndex((fi) => fi - (afterLen - beforeLen));
        }
        setHasMoreEarlier(batch.hasMore);
        if (until) {
          loadedEvents += fresh.length;
          if (batch.found) {
            result.found = true;
            break;
          }
          if (!batch.hasMore) {
            result.exhausted = true;
            break;
          }
          if (loadedEvents >= until.maxEvents) {
            result.capped = true;
            break;
          }
          continue;
        }
        // 有进展 / 读完就收工；否则（一批全并进了已有条目、还有更早的）提交后接着拉
        if (batch.progressed || !batch.hasMore) break;
      }
    } catch (err) {
      if (taskIdRef.current !== requestedTaskId) return { ...result, started: false };
      // 失败后 Virtuoso 不会再触发 startReached（第一项序号没变），顶部给手动重试入口
      setEarlierFailed(true);
      result.failed = true;
      toast.error(`加载更早事件失败：${(err as Error).message}`);
    } finally {
      if (taskIdRef.current === requestedTaskId) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
    return result;
  };

  // ---------- 提问时间线（左侧刻度 / 展开面板，chat / task 共用） ----------
  // 数据 = 服务端大纲（窗口被截断才取）+ 窗口里的实时事件；当前轮由 rangeChanged 写进外部 store
  // （只让时间线自己重渲，滚动路径零 setState）。点击跳转的三条路：
  //   ① 目标已渲染 → 直接 jumpToItem（唯一 scrollToIndex 出口，会先停跟随）；
  //   ② 目标在更早的历史里 → 复用上拉分页一路拉到它出现（loadEarlier 的 until 模式，封顶
  //      OUTLINE_JUMP_MAX_EVENTS 条、超了提示再点一次继续），拉到后等它渲染进 Virtuoso 再跳；
  //   ③ 历史读完也没有 → 它已不存在（被回退删了等）：从时间线里摘掉并提示。
  // 不做「整窗替换成目标附近」：窗口整体换掉会让 Virtuoso 的视口锚定失效（评审 RC2 的雷区）。
  const outlineItems = useTaskOutline({
    taskId: task.id,
    events: task.events,
    truncated: !!task.eventsTruncated,
    lastRewind: task.lastRewind,
  });
  const outlineActiveStore = useMemo(() => createActiveOutlineStore(), []);
  // 点过才发现已不存在的项（大纲是之前拉的、期间被回退删了）：本任务内不再画
  const [deadOutlineIds, setDeadOutlineIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const railItems = useMemo(
    () =>
      deadOutlineIds.size === 0
        ? outlineItems
        : outlineItems.filter((it) => !deadOutlineIds.has(it.id)),
    [outlineItems, deadOutlineIds],
  );
  // 正在往前加载、要跳去的那一项（时间线上该项显示加载中、期间不叠加新的跳转）
  const [jumpingId, setJumpingId] = useState<string | null>(null);
  // 拉到了、等它渲染进 Virtuoso 再跳的目标；jumpTick 只用来唤醒下面的 effect
  const pendingJumpRef = useRef<string | null>(null);
  const [jumpTick, setJumpTick] = useState(0);
  useEffect(() => {
    // 切 task：上一个任务的跳转 / 死项 / 当前轮全作废
    pendingJumpRef.current = null;
    setJumpingId(null);
    setDeadOutlineIds(new Set());
    outlineActiveStore.set(null);
  }, [task.id, outlineActiveStore]);
  useEffect(() => {
    if (!pendingJumpRef.current) return;
    // 等一帧：prepend 的 data / firstItemIndex 同一次提交，Virtuoso 下一帧才吃下去，
    // 此时 scrollToIndex 才有对应的下标
    const raf = requestAnimationFrame(() => {
      const id = pendingJumpRef.current;
      if (!id) return;
      const idx = findRenderIndexForEventId(itemsRef.current, id);
      if (idx < 0) return; // 还没渲染进来：items 再变时本 effect 会重跑
      pendingJumpRef.current = null;
      jumpToItem(idx, "start", "auto");
    });
    return () => cancelAnimationFrame(raf);
  }, [items, jumpTick, jumpToItem]);
  const settleOutlineJump = (eventId: string) => {
    const requestedTaskId = task.id;
    pendingJumpRef.current = eventId;
    setJumpTick((t) => t + 1);
    window.setTimeout(() => {
      if (taskIdRef.current !== requestedTaskId) return;
      if (pendingJumpRef.current !== eventId) return;
      pendingJumpRef.current = null;
      toast.error("没能定位到这条消息");
    }, OUTLINE_JUMP_SETTLE_TIMEOUT_MS);
  };
  const markOutlineItemGone = (eventId: string) => {
    setDeadOutlineIds((prev) => new Set(prev).add(eventId));
    toast.error("这条消息已经不存在了（可能被回退删除）");
  };
  // 跳转取消旗：切任务 / 回退（lastRewind 推进）/ 加载期间用户自己滚了 → true，加载循环下一批前停手、
  // 拉到之后也不再跳转（不能把用户从他刚滚到的地方拽走）；每次发起跳转时复位
  const jumpCancelledRef = useRef(false);
  useEffect(() => {
    jumpCancelledRef.current = true;
  }, [task.id, task.lastRewind?.ts]);
  // 主动回到最新（点「回到最新」/ Cmd+End / 提交即到底）= 用户要看最新，作废进行中的时间线跳转
  // （加载完成后也不再跳回历史处）。ref 稳定、依赖空
  const cancelOutlineJump = useCallback(() => {
    jumpCancelledRef.current = true;
    pendingJumpRef.current = null;
  }, []);
  // 卸载（离开页面）也作废：否则点了很早的提问后立刻走开，往前加载会在后台跑完（最多 5000 条、几批请求），
  // 全局的 loading toast / 3 秒超时 toast 还会在别的页面残留几秒。StrictMode 的模拟卸载无害——每次发起跳转都会复位旗标
  useEffect(() => cancelOutlineJump, [cancelOutlineJump]);
  useEffect(() => {
    if (!jumpingId) return;
    const el = searchScrollRootRef.current;
    if (!el) return;
    const cancel = () => {
      jumpCancelledRef.current = true;
    };
    el.addEventListener("wheel", cancel, { passive: true });
    el.addEventListener("touchstart", cancel, { passive: true });
    el.addEventListener("keydown", cancel);
    return () => {
      el.removeEventListener("wheel", cancel);
      el.removeEventListener("touchstart", cancel);
      el.removeEventListener("keydown", cancel);
    };
  }, [jumpingId]);
  const jumpToOutlineItem = async (eventId: string) => {
    // 新的点击作废上一次「拉到了、等渲染」的目标：否则先点了窗口内未渲染的项、下一帧前又点了已渲染的项，
    // 旧目标会在下一帧把人拽回去
    pendingJumpRef.current = null;
    const idx = findRenderIndexForEventId(itemsRef.current, eventId);
    if (idx >= 0) {
      jumpToItem(idx, "start", "auto");
      return;
    }
    const inWindow = latestEventsRef.current.some((e) => e.id === eventId);
    if (inWindow) {
      settleOutlineJump(eventId);
      return;
    }
    if (!onPrependEvents) {
      // 只读视图没有分页能力
      toast.info("这条在更早的历史里，当前视图不能加载更早的消息");
      return;
    }
    if (loadingEarlierRef.current) {
      toast.info("正在加载更早的消息，稍后再点");
      return;
    }
    if (!hasMoreEarlier) {
      markOutlineItemGone(eventId);
      return;
    }
    const requestedTaskId = task.id;
    jumpCancelledRef.current = false;
    setJumpingId(eventId);
    // 时间线点完就收起、用户的视口又不在顶部（看不到顶部的「加载更早」行）：加载超过一会儿就给个常驻提示，
    // 免得以为没点中而重复点击；很快拉到的不闪这个提示
    let loadingToastId: string | number | undefined;
    const loadingToastTimer = window.setTimeout(() => {
      loadingToastId = toast.loading("正在往前找这条消息…");
    }, OUTLINE_JUMP_LOADING_TOAST_DELAY_MS);
    try {
      const res = await loadEarlier({
        eventId,
        maxEvents: OUTLINE_JUMP_MAX_EVENTS,
        isAborted: () => jumpCancelledRef.current,
      });
      if (taskIdRef.current !== requestedTaskId) return;
      // 加载期间用户自己滚了 / 对话被回退：静默收手（时间线上的转圈消失就是信号）
      if (jumpCancelledRef.current) return;
      if (res.found) settleOutlineJump(eventId);
      else if (res.capped)
        toast.info(
          `这条比较早，已往前加载 ${OUTLINE_JUMP_MAX_EVENTS} 条仍未到达，再点一次继续往前`,
        );
      else if (res.exhausted) markOutlineItemGone(eventId);
      else if (!res.started && !res.failed)
        toast.info("正在加载更早的消息，稍后再点");
    } finally {
      window.clearTimeout(loadingToastTimer);
      if (loadingToastId !== undefined) toast.dismiss(loadingToastId);
      if (taskIdRef.current === requestedTaskId) setJumpingId(null);
    }
  };
  // 给 memo 化的时间线一个稳定的回调（本函数每次渲染都是新闭包）
  const jumpToOutlineItemRef = useRef(jumpToOutlineItem);
  jumpToOutlineItemRef.current = jumpToOutlineItem;
  const onOutlineJump = useCallback((eventId: string) => {
    void jumpToOutlineItemRef.current(eventId);
  }, []);

  // 初始定位：进入一个对话 / 任务，**一律落在最后一条、并处于「跟随最新」**（渲染期 latch、每个 task 只写一次）。
  //
  // 2026-10-17 用户拍板「切换对话后应该始终定位到最后一条 / 底部」——撤掉了 v1.1.x 的「滚动位置记忆」
  // （离开时记视口顶部事件 id、非贴底离开则回来恢复到那条）。它的问题：① 锚点只有「视口顶部那条 item 的 id」，
  // 那条是大段回复时回来只能对齐到它的开头、读到一半的位置丢了；② 恢复成非贴底态后，AI 还在流式输出时
  // 用户看到的是一段不动的旧内容，要自己再点「回到最新」；③ 锚点不在当前尾页（懒加载没包含）时静默退回底部，
  // 同一个对话有时恢复有时不恢复，行为不可预期。
  // 想看上面的内容就往上滚——滚了之后的行为（上滚不被拽回、回到底部才恢复跟随）一点没变。
  //
  // 同一个控制器的通知走微任务，渲染期写它不会触发 React 的跨组件更新告警。
  if (initialTopRef.current === null && items.length > 0) {
    follow.setFollowing(true);
    initialTopRef.current = items.length - 1;
  }

  // 跟随最新（V0.8.3 引入、2026-07-28 收口成唯一入口）：
  //
  // 为什么需要它——react-virtuoso 的 followOutput 只在 data **条数**变化时触发滚动，
  // 对「最后一项内容增高」无感；而流式回复是往同一个 `__streaming__` 虚拟 item 的
  // text 里追加、条数不变，所以光靠 followOutput 流式期间不会跟随。
  // （2026-10-12 起连 followOutput 也不传了：它会启动没法取消的 scrollToIndex 重试链，
  // 用户上滚后还被拉回底部。条数变化的贴底也由这里接管。）
  //
  // 为什么把条数变化也一起收进来——除了流式追加，还有一堆「不改条数但改高度」的路径
  // 会让贴底态漂掉：工作过程组 run 结束自动收起、Streamdown 的 Shiki / Mermaid 异步
  // 渲染完成、图片 / 代码块布局回填。统一在这里 rAF 合批重新贴底、一帧最多滚一次，
  // 比逐条打补丁稳（Virtuoso 报总高变化的那一路见 onTotalHeightChanged）。
  // 控制器内部还会先看「是不是已经贴着了」、贴着就不空跑。
  //
  // useEffect（非 layout）跑在 Virtuoso 测完新高度之后、贴底才能命中真底部。
  useEffect(() => {
    if (!follow.isFollowing()) return;
    follow.requestScrollToBottom();
  }, [follow, items, streamingText, isRunning]);

  // 提交即到底（V2-01）：上滚读历史后在输入框回车，新气泡和流式回复全在视口外、只剩一个「回到最新」圆钮，
  // 用户容易以为没发出去而重复回车。检测到「本窗口新发起的占位」出现就缓动回底并恢复跟随。
  // **只认本地发起**（占位的 `local === true`，缺省不算——fail-closed，R5-03）：飞书 / 别的窗口的消息走 user_reply 事件、
  // 不会有占位；bootstrap 重建的占位 local=false——它们出现不是用户按了回车，不能把正在翻历史的人拽走。
  // 基线按 task 存：首次挂载 / 切 task 时已有的占位只记基线、不触发。
  // effect 体在 lib/stream-pending.applyPendingScan（纯函数、有单测：fake 回调断言「新本地占位 → 调用」）
  const pendingScanRef = useRef<PendingScanBaseline | null>(null);
  useEffect(() => {
    pendingScanRef.current = applyPendingScan(
      pendingScanRef.current,
      task.id,
      pendingLocalReplies ?? [],
      () => {
        cancelOutlineJump();
        follow.scrollToBottomSmooth();
      },
    );
  }, [pendingLocalReplies, task.id, follow, cancelOutlineJump]);

  // 「回到最新」：短缓动滑到底 + 落地恢复自动跟随（太远 / 减少动态效果时直接跳）。
  // **不新开滚动入口**——滑行与落地后的贴底都在控制器里（自己写 scrollTop、落地交给它那条
  // rAF 合批的贴底链）。这里若自己再调一次 scrollToIndex，
  // 就等于把「两套自动滚」的老毛病请回来（源码契约测试也盯着这条）。
  const backToBottom = useCallback(() => {
    cancelOutlineJump();
    follow.scrollToBottomSmooth();
  }, [follow, cancelOutlineJump]);

  // Virtuoso 报「总高变了」：跟随中就补一次贴底。它是 followOutput 的替代——后者只在条数变化时触发、
  // 还会启动一条没法取消的 scrollToIndex 重试链（见下方 Virtuoso 的 prop 注释）；
  // 这里只发出「请贴底」的请求，真正写不写 scrollTop 由控制器按跟随态 + 距底判定
  const onTotalHeightChanged = useCallback(() => {
    if (follow.isFollowing()) follow.requestScrollToBottom();
  }, [follow]);

  // Cmd/Ctrl+End 回到最新（对齐 Claude Code 的 scroll:bottom）。
  // 跟 Cmd+J 一档的局部 listener——绑的是本组件的跟随控制器、不上收 global-shortcuts。
  // 带修饰键、输入框里按也放行（正在打字时想看最新才是主场景）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isModCombo(e, "End")) return;
      // 焦点在右侧抽屉里（子代理详情等）时让行：抽屉自己滚、主流不该被带着动，也别吞掉浏览器默认行为
      if (isInsideSheet(e.target)) return;
      e.preventDefault();
      backToBottom();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [backToBottom]);

  // 悬浮条「点击查看」：滚到未答答题卡。用 ref 读最新 items、回调引用恒定，
  // 悬浮条子组件不会因为 items 变化而重渲
  const pendingAskId = pendingAskEvent?.id;
  const jumpToPendingAsk = useCallback(() => {
    if (!pendingAskId) return;
    const idx = itemsRef.current.findIndex((it) => it.id === pendingAskId);
    if (idx < 0) return;
    jumpToItem(idx, "center", "smooth");
  }, [pendingAskId, jumpToItem]);

  // 自动聚焦：进入「可输入」时把光标放进输入框、用户立刻可以打字
  // - 解决以前的痛点：agent 回完话、用户得鼠标点输入框才能输入
  // - 仅在 status「变成」awaiting_user 的边缘触发、避免用户主动点别处后被强抢焦点
  // - autoFocus 属性不行（只 mount 时生效）、必须 useEffect 跟着 status 变
  useEffect(() => {
    if (isAwaitingUser) {
      // 加个微延迟、让 disabled→enabled 的 DOM 变化先 commit、再 focus 才稳
      // 焦点已在右侧抽屉里（比如正盯着子代理详情）就不抢：否则后台子代理唤醒主 AI、一轮说完，
      // 用户在抽屉里按空格 / 翻页的键会变成往输入框里打字。在 timer 回调里判（不是 effect 体里），
      // 取的是「真正要 focus 那一刻」的焦点位置
      // 页面上有非空选区也不抢（R5-01 ◐）：受理后 / 一轮说完回到可输入时，用户可能正选着上一条 AI 回复要复制，
      // 一 focus 选区就没了。判定见 lib/composer-refocus.shouldAutoFocusComposer
      const timer = setTimeout(() => {
        if (
          !shouldAutoFocusComposer({
            activeInsideSheet: isInsideSheet(document.activeElement),
            selection: window.getSelection(),
          })
        ) {
          return;
        }
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
    // inputRef 是 useRichInput 里的 useRef、引用恒定；进 deps 只为满足 lint
  }, [isAwaitingUser, inputRef]);

  // v1.0：chat「最后一条用户消息」重发 / 原地编辑——把（编辑后的）内容作为新消息发到末尾。
  // 原消息保留（append-only）；重发携带原 meta.images / attachments（批 B 补图）。
  // 〔更新〕「编辑」现在走下面的 handleEditInPlace（替换这条及之后的对话）；本函数只剩原样重发 / 重新生成
  // 返回 false = 失败（编辑态保持）；true = 成功
  const resendLockRef = useRef(false);
  const handleResend = useCallback(
    async (text: string, sourceEv?: TaskEvent): Promise<boolean> => {
      if (resendLockRef.current) return false;
      resendLockRef.current = true;
      try {
        const skills = await fetchSkills();
        const refs = resolveSkillReferences(text, skills);
        const skillRefs =
          refs.length > 0
            ? refs.map((s) => ({ name: s.name, absPath: s.absPath }))
            : undefined;

        let images: ImagePayload[] | undefined;
        let attachments: string[] | undefined;
        if (sourceEv) {
          const imgs = extractUserReplyImages(sourceEv.meta);
          if (imgs.length > 0) {
            const payloads = await Promise.all(
              imgs.map((img) =>
                fetchUploadAsPayload(
                  task.id,
                  img.absPath,
                  img.mimeType,
                  img.filename,
                ),
              ),
            );
            const ok = payloads.filter((p): p is ImagePayload => p != null);
            if (ok.length > 0) images = ok;
            if (ok.length < imgs.length) {
              toast.warning("部分附图未能重发");
            }
          }
          const atts = extractUserReplyAttachments(sourceEv.meta);
          if (atts.length > 0) {
            attachments = atts.map((a) => a.absPath);
          }
        }

        const result = await onUserReply?.(
          text,
          images,
          attachments,
          skillRefs,
        );
        return result !== false;
      } finally {
        resendLockRef.current = false;
      }
    },
    [onUserReply, task.id],
  );

  // 最新的 onUserReply：它闭包着发送那一刻的 task 快照（runStatus 等）。原地编辑里回退会把 task 换掉，
  // 之后发送要用换过之后的那一份（否则刚停掉的 run 在旧快照里还是 running、新消息被误标成「排队中」）
  const onUserReplyRef = useRef(onUserReply);
  onUserReplyRef.current = onUserReply;

  // chat 原地编辑任意一条用户消息：编辑后的内容替换「这条及之后的对话」，然后从这里重新跑。
  // 顺序：先回读图 / 附件（回退会删事件，图要在删之前取）→ 父组件 确认 / 停 / 回退 → 发新消息。
  // 回退成功但新消息没发出去时旧消息已经删了，把用户打的字放回输入框、别让它丢。
  // 返回 false = 没改成（编辑态保持）；true = 回退已提交（这一行已不在了，编辑态随之消失）。
  const handleEditInPlace = useCallback(
    async (text: string, sourceEv?: TaskEvent): Promise<boolean> => {
      if (!sourceEv || !onEditRewind || resendLockRef.current) return false;
      resendLockRef.current = true;
      try {
        const payload = await buildResendPayload(task.id, {
          ...sourceEv,
          text,
        });
        if (payload.imagesPartial) toast.warning("部分附图未能带上");
        const rewound = await onEditRewind(sourceEv);
        if (rewound !== "ok") return false;
        // 回退把 task 快照换掉了：让出一拍给 React 渲染出去、onUserReplyRef 才是新的那一份
        //（只影响「排队中 / 发送中」这类展示判断，不影响消息本身是否送达；用定时器不用 rAF——窗口在后台时 rAF 不触发）
        await new Promise<void>((r) => setTimeout(r, 50));
        const sent = await onUserReplyRef.current?.(
          text,
          payload.images,
          payload.attachments,
          payload.skillRefs,
        );
        if (sent === false) {
          setDraft((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
          inputRef.current?.focus();
          toast.warning(
            "已回到这条消息之前，但新消息没发出去；内容已放回输入框，可修改后重发",
          );
        }
        return true;
      } finally {
        resendLockRef.current = false;
      }
    },
    [onEditRewind, task.id, setDraft, inputRef],
  );

  // 最后一条用户消息：重发入口挂它；「重新生成」也复用它的原文 + 图/附件
  const lastUserReply = useMemo(() => {
    for (let i = task.events.length - 1; i >= 0; i--) {
      if (task.events[i]!.kind === "user_reply") return task.events[i]!;
    }
    return undefined;
  }, [task.events]);
  const lastUserReplyId = lastUserReply?.id;

  // 最后一条 AI 回复：只有它 hover 出「重新生成」（其后没有更新的 assistant / 等价于尾部往前第一条）
  const lastAssistantId = useMemo(() => {
    for (let i = task.events.length - 1; i >= 0; i--) {
      if (task.events[i]!.kind === "assistant_message") return task.events[i]!.id;
    }
    return undefined;
  }, [task.events]);

  // 最后一条是定时到点发的（不是用户说的话）：没有「重新生成」——原样再发 = 把系统样板 / AI 自己写的备忘当成用户的话发出去
  const canRegenerateFromLastUserReply = !!lastUserReply && !isScheduleUserReply(lastUserReply);

  // 重新生成 = 把最后一条用户消息原样再发一遍（append-only、历史保留、不弹确认）
  const handleRegenerate = useCallback(async () => {
    if (!lastUserReply || isScheduleUserReply(lastUserReply)) return;
    await handleResend(lastUserReply.text, lastUserReply);
  }, [handleResend, lastUserReply]);

  // 引用追问：选中 AI 回复 → 浮动「引用」→ 把选区写成 markdown blockquote 前置进 draft
  // （零服务端改动；blockquote 语义模型天然理解；不进 composer 内部）
  const handleQuote = useCallback(
    (text: string) => {
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      setDraft((prev) => `${quoted}\n\n${prev}`);
      inputRef.current?.focus();
    },
    [setDraft, inputRef],
  );

  // 「未送达」卡的「放回输入框」（V3-05）：run 出错 / 会话关闭时排队消息被清掉，把丢掉的话前置回草稿、聚焦。
  // 草稿住在这一层（rich），所以由这里注入、卡片不碰输入框；父层（ChatView / 详情页）注入的能力原样透传。
  // 只在 chat 且渲染了输入岛时提供——否则放回的是一个看不见的草稿、等于没放
  const parentStreamActions = useStreamActions();
  const handleRestoreDraft = useCallback(
    (text: string) => {
      setDraft((prev) => prependRestoredToDraft(prev, text));
      inputRef.current?.focus();
    },
    [setDraft, inputRef],
  );
  const canRestoreDraft = isChat && !hideReplyComposer;

  // 代码改动面板「引用到对话」：把选中的 diff 片段接在草稿后面、聚焦输入框。
  // 同「放回输入框」：只在 chat 且渲染了输入岛时接单——没有输入框就不注册（面板据此提示「找不到输入框」）
  useEffect(() => {
    if (!canRestoreDraft) return;
    return registerComposerInsert(task.id, (text) => {
      setDraft((prev) => appendToDraft(prev, text));
      inputRef.current?.focus();
    });
  }, [canRestoreDraft, task.id, setDraft, inputRef]);
  const mergedStreamActions = useMemo(
    () => ({
      ...parentStreamActions,
      onRestoreDraft: canRestoreDraft ? handleRestoreDraft : undefined,
    }),
    [parentStreamActions, canRestoreDraft, handleRestoreDraft],
  );

  // 同步飞行闩：防 isSubmitting state 一帧延迟导致连点 / 连按 Enter 重复提交
  // （纯函数 createSubmitLatch / startLatchedSubmit 见 lib/composer-actions，行为测试 tests/submit-latch.test.ts，Q6-03）
  const [sendingLatch] = useState(createSubmitLatch);
  // 取草稿 → 发送 → 成功清空
  // 提交模式走公共 runOptimisticSubmit（与 task 输入条同一份）：
  // 快照 payload 后立刻 reset（气泡靠 SSE user_reply 补），失败才恢复正文+路径。
  const submitVia = (send: typeof onUserReply) => {
    // 没发送函数 / 文本 / 图 / 路径一个都没有（纯空消息不发）/ 闩被占 → 不发；落定（成功 / 失败 / 抛错）都释放闩
    startLatchedSubmit({
      latch: sendingLatch,
      hasSend: !!send,
      hasContent: rich.hasContent,
      run: () => {
        if (!send) return Promise.resolve();
        // skill 指引不拼进 text——独立字段传服务端，气泡只显示用户原文
        const snap = rich.payload();
        return runOptimisticSubmit({
          payload: snap,
          reset: () => rich.reset(),
          // 失败恢复：chat 编辑器不锁（D7-03），POST 飞行期间输入框可能已有新敲的下一句 / 新图 / 新路径——
          // 合并而不是覆盖（原文在前、新敲的在后；图 / 路径去重、守上限），与 task 说话条同一套规则（R5-01）
          restore: (p) =>
            restoreDraftMerged(p, {
              setValue: (updater) => rich.setValue(updater),
              currentPaths: () => pathsRef.current,
              currentImages: () => imagesRef.current,
              replacePaths: (paths) => rich.pathAttach.replaceAll(paths),
              replaceImages: (imgs) => rich.attach.replaceAll(imgs),
              maxPaths: MAX_PATHS,
              maxImages: rich.attach.maxImages,
            }),
          // 占位走父级 ledger，不过这里。onUserReply 可同步可异步，包一层统一成 Promise。
          send: () =>
            Promise.resolve(send(snap.text, snap.images, snap.attachments, snap.skillRefs)),
          // 返 false=失败（恢复草稿）；成功靠 SSE user_reply 补气泡
          isFailure: (result) => result === false,
        });
      },
    });
  };
  const handleSend = () => submitVia(onUserReply);

  // 对话类 item（AI / 用户 / streaming / ask_user）：回合节奏里「一段新的话」的开头。
  // 各档间距的数值与理由在 lib/event-stream-rhythm（组间大、组内小，chat / task 同一套）
  const isConversational = (it: RenderItem): boolean => {
    if (isStreamingItem(it)) return true;
    if (isLoadingItem(it)) return false;
    if (isPendingLocalItem(it)) return true;
    // 工作过程组走紧凑间距，不与正文抢段落感
    if (it.kind === "__work_group__") return false;
    if (it.kind === "__tool_block__" || it.kind === "__tool_verb_group__") {
      return false;
    }
    return (
      it.kind === "assistant_message" ||
      it.kind === "user_reply" ||
      it.kind === "ask_user_request"
    );
  };

  // 节奏档所需的两个事实：是不是对话、是不是过程层的「行」（工作过程组 / 工具块）
  const rhythmFacts = (it: RenderItem): RhythmFacts => ({
    talk: isConversational(it),
    process:
      it.kind === "__work_group__" ||
      it.kind === "__tool_block__" ||
      it.kind === "__tool_verb_group__",
    // AI 平铺正文（定稿 + 流式）：无框无底色，组间要靠分隔线读出来
    aiText: isStreamingItem(it) || it.kind === "assistant_message",
    // 用户这一侧的话：自带气泡 / 边框，且与紧随其后的回答是一组
    userSide:
      isPendingLocalItem(it) ||
      it.kind === "user_reply" ||
      it.kind === "ask_user_request",
  });

  // 搜索范围提示：还有更早事件没加载时，搜索只覆盖已加载那段——有无命中都要说明，
  // 并复用上拉分页（loadEarlier）给「加载更早的再搜」入口；加载后 items 变、命中自动重算
  const searchScopeNotice = deriveSearchScopeNotice({
    // 群问答 tab 下展示的是只读 QA 列表、搜索不作用于它，提示条也不出
    filtering: isSearchFiltering && !showQaPanel,
    hasMoreEarlier,
    loadedCount: task.events.length,
    canLoadEarlier: !!onPrependEvents,
  });
  const renderSearchScopeNotice = (className: string) =>
    searchScopeNotice ? (
      <EventStreamSearchScopeNotice
        text={searchScopeNotice.text}
        canLoadEarlier={searchScopeNotice.canLoadEarlier}
        loading={loadingEarlier}
        onLoadEarlier={() => void loadEarlier()}
        className={className}
      />
    ) : null;

  return (
    // 子代理详情面板的宿主：事件流里的子代理卡（Virtuoso 里滚出视口就卸载）和输入框上方的
    // 「后台工作」条都从这里打开同一个抽屉——状态放卡片里的话一滚动抽屉就没了
    <SubagentDetailHost task={task}>
    {/* 跟随控制器透给深层子树：工作过程组的「自动折叠」要看用户是不是在翻历史 */}
    <StreamFollowContext.Provider value={follow}>
    {/* 行内动作：透传父层注入的（错误卡重试 / 重新推进）+ 本层补的「放回输入框」（草稿住在这一层） */}
    <StreamActionsProvider value={mergedStreamActions}>
    <PaneSearchHighlightProvider value={searchHighlightCtx}>
    <div
      className="flex h-full flex-col"
      data-pane-search="event-stream"
      onPointerDown={() => setActivePaneSearchScope("event-stream")}
    >
      {/* log 形态保留固定标题栏；chat 搜索改为内容区右上角悬浮，不占垂直布局。 */}
      {!isChat && (
        <EventStreamSearchBar
          active={searchActive}
          query={searchQuery}
          hitIndex={searchHitIndex}
          hitCount={searchOccurrences.length}
          onActivate={activateStreamSearch}
          onQueryChange={setSearchQuery}
          onClose={closeStreamSearch}
          onPrev={goToPrevSearchHit}
          onNext={goToNextSearchHit}
          inputRef={searchInputRef}
          placeholder="搜索 AI 回复…"
          ariaLabel="搜索 AI 回复"
          // 搜索激活态 leading 让位（V13-04）：tab 是 flex-1、Input 也是 flex-1，两者平分剩余宽度——
          // 307px 的事件流栏里 Input 只剩约 71px（有群问答 tab 时约 25px）。搜索一激活就已切回事件流
          // （activateStreamSearch 里 setShowGroupQa(false)），tab 此刻没有用处；关掉搜索后原样回来
          leading={
            searchActive ? null : (
            <span className="flex flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() => setShowGroupQa(false)}
                className={cn(
                  "text-xs",
                  !showQaPanel
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                事件流
              </button>
              {groupQaScope.showTab && (
                <button
                  type="button"
                  onClick={() => setShowGroupQa(true)}
                  className={cn(
                    "flex items-center gap-1 text-xs tabular-nums",
                    showQaPanel
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {/* 窗口只含最近一段事件时计数带「+」（至少这么多），范围说明在面板顶部 */}
                  群问答{groupQaScope.countText && `（${groupQaScope.countText}）`}
                  {/* 状态点一律静态（事件流 v2「动效同屏只留一处主动效」）；
                      点只有颜色，role=img + aria-label 给读屏，hover 提示走 Tooltip（不用原生 title） */}
                  {groupQaAnswering && (
                    <Tooltip content="群里有提问正在回答">
                      <span
                        role="img"
                        aria-label="群里有提问正在回答"
                        className="inline-block size-1.5 rounded-full bg-info"
                      />
                    </Tooltip>
                  )}
                  {groupQaNeedsOwnerCount > 0 && (
                    <Tooltip
                      content={`有 ${groupQaNeedsOwnerCount} 件事等你在群问答里拍板`}
                    >
                      <span
                        role="img"
                        aria-label={`有 ${groupQaNeedsOwnerCount} 件事等你在群问答里拍板`}
                        className="inline-block size-1.5 rounded-full bg-brand"
                      />
                    </Tooltip>
                  )}
                </button>
              )}
            </span>
            )
          }
          className="h-10 shrink-0 border-b px-4"
        />
      )}
      {/* log 形态：范围提示是标题栏下方一条细行（占位只在搜索且有更早未加载时出现） */}
      {!isChat && renderSearchScopeNotice("border-b px-4 py-1")}
      {/* min-h-0 让 flex-1 子项能正确 shrink、Virtuoso 拿到确定高度才能内部 scroll。
          relative：给 chat 搜索与「AI 在等你回答」悬浮条定位 */}
      <div className="relative min-h-0 flex-1">
        {isChat && (
          <EventStreamSearchBar
            active={searchActive}
            query={searchQuery}
            hitIndex={searchHitIndex}
            hitCount={searchOccurrences.length}
            onActivate={activateStreamSearch}
            onQueryChange={setSearchQuery}
            onClose={closeStreamSearch}
            onPrev={goToPrevSearchHit}
            onNext={goToNextSearchHit}
            inputRef={searchInputRef}
            placeholder="搜索 AI 回复…"
            ariaLabel="搜索 AI 回复"
            className={cn(
              "absolute right-3 top-2 z-20 rounded-lg border border-border bg-background shadow-sm",
              searchActive
                ? "w-[min(28rem,calc(100%-1.5rem))] p-1"
                : "p-0.5",
            )}
          />
        )}
        {/* chat 形态：搜索框是右上角悬浮的，范围提示紧贴其下同样悬浮（不占垂直布局） */}
        {isChat &&
          renderSearchScopeNotice(
            "absolute right-3 top-12 z-20 max-w-[min(28rem,calc(100%-1.5rem))] rounded-md border border-border bg-background px-2 py-0.5 shadow-sm",
          )}
        {/* E1 sticky 轮次头：默认 hidden，rangeChanged 里命令式显隐（见 applyStickyTurn）。
            chat / task 都启用：task 事件流里用户也会直接发消息提问（user_reply）、
            回滚看历史时同样需要「回到最近提问」的锚。
            群问答 tab 下不渲染：它是事件流的轮次锚，浮在只读 QA 列表上会挡住首行
            （QA 有自己的独立滚动容器，rangeChanged 早已停发，sticky 会卡在旧文案）。 */}
        {!showQaPanel && (
        <div
          ref={stickyRootRef}
          // 初始 = 隐藏态（STICKY_HIDDEN_CLASSES）；显隐由 applyStickyTurn 命令式切两组类、
          // 走淡入淡出 + 4px 位移，不再 display:none 一下出现 / 消失（那是原来「横幅突然蹦出来」的手感）
          className="pointer-events-none invisible absolute inset-x-0 top-0 z-10 -translate-y-1 opacity-0 transition-[opacity,translate,visibility] duration-150 ease-out motion-reduce:transition-none"
        >
            <div className="mx-auto w-full max-w-3xl px-6">
              <Tooltip content="回到本轮开头">
                <button
                  type="button"
                  onClick={() => {
                    const id = stickyTurnIdRef.current;
                    if (!id) return;
                    const idx = itemsRef.current.findIndex((it) => it.id === id);
                    // 走 jumpToItem：先停跟随再滚（流式时直接 scrollToIndex 会被贴底拽回，见其注释）
                    if (idx >= 0) jumpToItem(idx, "start", "smooth");
                  }}
                  // 事件流 v2：不透明底 + 完整边 + 轻阴影。旧版 bg-background/75 + backdrop-blur
                  // 实测挡不住下面的正文（半透明条上叠着正文第一行、两行字糊在一起）——
                  // 浮在内容之上的东西必须是实心面，才读得出「这是浮层、不是正文」
                  className="pointer-events-auto flex w-full cursor-pointer items-center gap-2 rounded-b-lg border-x border-b border-border bg-background px-3 py-1.5 text-left text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                >
                  <span className="shrink-0 font-medium text-foreground">
                    本轮提问
                  </span>
                  <span
                    ref={stickyTextRef}
                    className="min-w-0 flex-1 truncate"
                  />
                </button>
              </Tooltip>
            </div>
          </div>
        )}
        {/* 底部悬浮层：回到最新（带新增条数）+ 未答提问提示条。
            显隐由子组件自己订阅跟随态，主组件不参与（滚动路径零重渲）。
            key 挂 task.id：详情页内切任务不重挂 EventStream、计数基线得跟着重来
            群问答 tab 下不渲染：计数口径是事件流的，浮在 QA 上文不对题。 */}
        {!showQaPanel && (
        <StreamFloatingBar
          key={task.id}
          follow={follow}
          unitIds={contentUnitIds}
          prependBaselineBumpRef={prependBaselineBumpRef}
          hasPendingAsk={!!pendingAskEvent}
          onJumpToAsk={jumpToPendingAsk}
          onBackToBottom={backToBottom}
        />
        )}
        {/* 左侧提问时间线：只在事件流视图（群问答 tab 是另一份只读列表、轮次口径不同） */}
        {!showQaPanel && (
          <StreamOutlineRail
            items={railItems}
            activeStore={outlineActiveStore}
            onJump={onOutlineJump}
            jumpingId={jumpingId}
          />
        )}
        {showQaPanel ? (
          <GroupQaPanel
            rounds={groupQaRounds}
            events={task.events}
            scopeNotice={groupQaScope.notice}
            onLoadEarlier={onPrependEvents ? () => void loadEarlier() : undefined}
            loadingEarlier={loadingEarlier}
          />
        ) : items.length === 0 ? (
          <div
            className={cn(
              "p-4 text-xs text-muted-foreground",
              isChat && "flex h-full items-center justify-center text-sm",
            )}
          >
            {isChat ? "说点什么、agent 会自动启动" : "任务还没开始、暂无事件"}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            // overflow-y-auto 不是为了改 overflow（Virtuoso 自己内联了同值），
            // 是为了吃到 globals.css 挂在该工具类上的 `scrollbar-gutter: stable`——
            // 否则内容首次超过一屏时滚动条突然占掉 8px、居中列横向跳一下
            className="h-full overflow-y-auto"
            data={items}
            // v1.0.x 上拉分页三件套：
            // - computeItemKey：item 身份稳定（prepend 后不整列重挂）
            // - firstItemIndex：头部插 N 项就减 N、Virtuoso 保滚动位置（官方 prepend 机制）
            // - startReached：滚到顶自动拉上一页
            // key = 事件 id；唯一例外：刚流式结束的那条定稿 assistant_message 沿用它接管的流式项 key
            // （lib/stream-handoff），Virtuoso / React 复用同一个节点、正文不重挂
            computeItemKey={(_idx, item) => resolveItemKey(item.id, handoff.aliases)}
            firstItemIndex={firstItemIndex}
            startReached={() => void loadEarlier()}
            context={{
              loadingEarlier,
              earlierFailed,
              onRetryEarlier: () => void loadEarlier(),
            }}
            components={VIRTUOSO_COMPONENTS}
            // 滚动容器交给跟随控制器接手势（滚轮 / 触摸 / 键盘 / 拖滚动条）
            scrollerRef={attachScrollerRef}
            // 不传 followOutput（2026-10-12）：它在条数变化时让 Virtuoso 自己 scrollToIndex("LAST")，
            // 函数形式下跟不跟完全由返回值决定、跟 isAtBottom 无关；而每次 scrollToIndex 都会启动
            // 一条「内容在长就永不结束、又没法取消」的重试链，用户上滚后还会每 ~100ms 把人拉回底部
            // （实测：流式第一个 chunk 让条数 +1、触发它，这条链一直活到用户滚轮之后）。
            // 条数 / 高度变化后的贴底统一由控制器负责：items 变了走下方的跟随 effect，
            // 总高变了走 totalListHeightChanged
            // 视口顶项变化：只用来算 sticky 轮次头（不再记滚动位置——进入对话一律落底，见上方初始定位）
            rangeChanged={(range) => {
              // 同 startIndex 重复回调短路：Virtuoso 每次重渲都会重发一遍 range，
              // 而 sticky 计算只在顶项真的换了时才有意义
              if (lastRangeStartRef.current === range.startIndex) return;
              lastRangeStartRef.current = range.startIndex;
              const list = itemsRef.current;
              const localIdx = range.startIndex - firstItemIndex;
              // E1 sticky：纯函数算目标 + 命令式 DOM，滚动路径零 setState
              // chat / task 都启用（task 事件流里用户也会直接发消息提问、同样需要锚）
              applyStickyTurn(resolveStickyTurn(list, localIdx));
              // 时间线的「当前轮」：写外部 store（只重渲时间线自己）、不 setState 本组件
              outlineActiveStore.set(resolveActiveOutlineId(list, localIdx));
            }}
            // 底部带 = 永远不算「在底部」（2026-10-12）：Virtuoso 有两条不问我们跟随态的自动贴底
            // （内容增高掉出底部带 / 视口变矮），都拿它的 atBottom 当闸门；带宽给任何正数，
            // 用户往回滚 <= 带宽就仍在带内、下一个 chunk 撑高内容就被拽回（实测滚轮上滚 30px 后 49ms 弹回）。
            // 跟随时的贴底由控制器负责（直接写 scrollTop，见 use-stream-follow）、视口变矮由它的
            // ResizeObserver 接手——原因与细节见 scroll-follow 的 VIRTUOSO_NEVER_AT_BOTTOM
            atBottomThreshold={VIRTUOSO_NEVER_AT_BOTTOM}
            // 总高变了（新项测完高度 / 流式增高 / 异步内容回填）：跟随中补一次贴底
            totalListHeightChanged={onTotalHeightChanged}
            // 视口外预渲染余量：快滚时先露白再补齐同样被感知成「抖」
            increaseViewportBy={VIEWPORT_OVERSCAN}
            // 初始定位：一律末尾（直接看最新事件）；只在 mount 时生效，所以切任务必须重挂（chat 在 EventStream 上、task 页在外层 ResizablePanelGroup 上都挂了 key={task.id}）
            initialTopMostItemIndex={initialTopRef.current ?? items.length - 1}
            // 每条 item 自带 padding；chat 形态窄列居中 + 按消息类型分配段落间距。
            // 注意：firstItemIndex 存在时 Virtuoso 传来的 idx 是「偏移后」的绝对索引、
            // 要先减回 firstItemIndex 才能对 items 数组做定位（分页 prepend 后不减必错位）
            itemContent={(absIdx, item) => {
              const idx = absIdx - firstItemIndex;
              const facts = rhythmFacts(item);
              const prevFacts = idx > 0 ? rhythmFacts(items[idx - 1]) : null;
              const tier = rhythmTier(idx, facts, prevFacts);
              // AI 一段新话的开头：在留白正中画一条渐隐细线（条件与理由见 rhythmShowsGroupDivider）
              const showGroupDivider = rhythmShowsGroupDivider(tier, facts, prevFacts);
              return (
              <div
                data-search-owner-id={
                  item.kind === "__work_group__" ||
                  item.kind === "__tool_block__" ||
                  item.kind === "__tool_verb_group__"
                    ? undefined
                    : item.id
                }
                className={cn(
                  "min-w-0 max-w-full px-4",
                  isChat && "mx-auto w-full max-w-3xl px-6",
                  // 回合节奏（chat / task 同一套）：组间大、组内小——说了一句话 + 它接着干的活读成一组
                  rhythmPaddingTop(variant, tier),
                  idx === items.length - 1 && rhythmPaddingBottom(variant),
                  // 绝对定位的分隔线以本容器的 padding 盒为基准
                  showGroupDivider && "relative",
                )}
              >
                {/* 组间分隔线：两端渐隐（不是整宽实线——整宽线太像 AI 正文里的 markdown hr），
                    横向与内容区同边距，纵向落在对话档留白正中。纯装饰、不拦指针 */}
                {showGroupDivider && (
                  <div
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute h-px bg-gradient-to-r from-transparent via-border to-transparent",
                      RHYTHM_GROUP_DIVIDER_TOP,
                      isChat ? "inset-x-6" : "inset-x-4",
                    )}
                  />
                )}
                {/* A3 每轮分割线：用户消息 = 新一轮开始、上方细线 + 轮次时间（第一轮不画） */}
                {isChat &&
                  item.kind === "user_reply" &&
                  shouldShowTurnDivider(itemKinds, idx) && (
                    // 轮次分割改「居中时间胶囊 + 两侧渐隐短线」——与 AI 回复正文里的
                    // markdown hr（整宽实线）视觉区分（2026-07-20 用户实测太像）
                    <div
                      className="mb-5 mt-1 flex items-center justify-center gap-2"
                      aria-hidden
                    >
                      <div className="h-px w-16 bg-gradient-to-r from-transparent to-border" />
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                        {formatTs(item.ts)}
                      </span>
                      <div className="h-px w-16 bg-gradient-to-l from-transparent to-border" />
                    </div>
                  )}
                {isStreamingItem(item) ? (
                  // 流式中的 AI 回复：合成一条 assistant_message、走和定稿事件同一个 EventRow（streaming 态）。
                  // 定稿事件接管 key 后只是 streaming true → false、ev 换成真事件，节点原地更新
                  <EventRow
                    ev={{
                      id: item.id,
                      ts: 0,
                      kind: "assistant_message",
                      text: item.text,
                    }}
                    taskId={task.id}
                    task={task}
                    variant={variant}
                    runActive={isRunning}
                    streaming
                  />
                ) : isLoadingItem(item) ? (
                  <PendingRow since={item.since} />
                ) : isBootStageItem(item) ? (
                  <BootStageRow text={item.text} />
                ) : isPendingLocalItem(item) ? (
                  <PendingLocalReplyRow
                    text={item.text}
                    uncertain={item.uncertain}
                    mode={item.mode}
                    ownerId={item.id}
                    itemId={item.itemId}
                    onEdit={onEditPending}
                    onDelete={onDeletePending}
                  />
                ) : item.kind === "__work_group__" ? (
                  <WorkGroupRow
                    group={item}
                    taskId={task.id}
                    task={task}
                    variant={variant}
                    // 直播输出只有「运行中」的工具块会用（status !== running 时展示落盘 output）；
                    // 没有运行中成员的组不收它，否则别的工具每个输出增量都会击穿所有可见组的 memo（D5-01）
                    liveToolOutputs={
                      item.hasRunning ? liveToolOutputs : undefined
                    }
                    isRunningTail={item.id === lastGroupId && isRunning}
                    showProcessingPlaceholder={shouldShowProcessingPlaceholder({
                      isRunning,
                      isLastItem:
                        lastItemIsWorkGroup && item.id === lastGroupId,
                      hasRunning: item.hasRunning,
                      hasStreamingText: !!streamingText,
                      lastMemberKind: item.members[item.members.length - 1]?.kind,
                      // 流尾已有一行进度（「准备环境…」/ 启动阶段）时状态行会让位给它——
                      // 它同样已经在说「还在等」，组尾的「处理中…」不再上下各说一遍
                      statusLineVisible: statusLineVisible || tailHasProgressRow,
                    })}
                  />
                ) : isToolBlock(item) ? (
                  <ToolBlockRow
                    block={item}
                    taskId={task.id}
                    liveOutput={liveToolOutputs?.[item.callId]}
                  />
                ) : isToolVerbGroup(item) ? (
                  <ToolVerbGroupRow group={item} taskId={task.id} />
                ) : item.kind === "ask_user_request" ? (
                  // V0.13.x：当前待答的 ask 直接内联答题卡（原模态弹窗淘汰、用户拍板
                  // 「弹窗挡整屏不合理」）；已答 / 已作废走回放卡
                  pendingAskEvent?.id === item.id ? (
                    <AskUserInlineCard
                      task={task}
                      ev={item}
                      onTaskUpdate={onTaskUpdate}
                    />
                  ) : (
                    <AskUserRequestRow ev={item} task={task} />
                  )
                ) : item.kind === "info" && item.meta?.kind === "reconnecting" ? (
                  // V0.13.x 自动重连过程行（spinner、同 thinking 一档的细行）
                  <ReconnectingRow ev={item} events={task.events} />
                ) : isCompactionInfo(item) ? (
                  // 自定义 pi 压缩：跟重连同档，不要走普通 info 灰细线
                  <CompactionRow ev={item} events={task.events} isRunning={isRunning} />
                ) : (
                  <EventRow
                    ev={item}
                    taskId={task.id}
                    task={task}
                    variant={variant}
                    // chat 最后一条用户消息：hover 出「重发 / 原地编辑」两 icon（可发消息时才给）
                    onResend={
                      isChat && canCompose && item.id === lastUserReplyId
                        ? handleResend
                        : undefined
                    }
                    // chat 最后一条 AI 回复：hover 出「重新生成」（可发 + 有用户消息 + 非 running）
                    onRegenerate={
                      isChat &&
                      canCompose &&
                      !isRunning &&
                      canRegenerateFromLastUserReply &&
                      item.id === lastAssistantId
                        ? handleRegenerate
                        : undefined
                    }
                    onRewind={isChat ? onRewind : undefined}
                    rewindingEventId={rewindingEventId}
                    // chat 任意一条用户消息原地编辑（替换这条及之后的对话）：可发消息 + 父组件接了回退才给
                    onEditInPlace={
                      isChat && canCompose && onEditRewind
                        ? handleEditInPlace
                        : undefined
                    }
                    // 引用追问：可发消息时所有 AI 回复都可引用（不限最后一条）
                    onQuote={isChat && canCompose ? handleQuote : undefined}
                    // 错误卡「当轮失败」资格 / 回退按钮只看属主主 run：旁路群答疑在飞不让主任务的错误卡翻篇（D6-02）
                    runActive={mainRunActive}
                  />
                )}
              </div>
              );
            }}
          />
        )}
      </div>
      {/* hideReplyComposer=true 时（task 模式）只展示事件流、底部输入区由父组件的
          TaskTalkComposer 替代；chat 形态渲染统一输入岛 <ConversationComposer>（v1.1.x 收口） */}
      {hideReplyComposer || !isChat ? null : (
        <div className="shrink-0 px-6 pb-5 pt-1">
          {/* 运行中粘性状态行：挂 Composer 上方，turn 结束（非 running）自然消失 */}
          <div className="mx-auto w-full max-w-3xl">
            {/* 槽位：运行期间始终占住 h-7（ActiveStatusLine 自己也是 h-7、不叠加），
                状态行出没不带着输入框上下跳 */}
            <div
              className={cn(
                // 高度过渡：run 结束 / 开始时槽位 28px ↔ 0 平滑伸缩，输入框和事件流底边不再整体硬跳一格
                // （run 一结束这 28px 就消失、恰好跟「吐字收尾 / 工作过程组收起」撞在同一帧——就是「完成后抖一下」的一份）
                "overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none",
                reserveStatusSlot ? "h-7" : "h-0",
              )}
            >
              {activeStatus && (
                <ActiveStatusLine
                  status={activeStatus}
                  onSkipWait={handleSkipWait}
                />
              )}
            </div>
            {/* 后台子代理还在干活的提示条：独立于 run 状态——主 AI 说完这一轮、状态行收起之后它仍然挂着，
                直到最后一个后台子代理收尾。贴在状态行槽位下、输入岛上（槽位收起时它自然贴到输入岛上沿） */}
            {backgroundSubagents ? (
              <BackgroundSubagentsBar jobs={backgroundSubagents} />
            ) : null}
            {/* 会话里已设的定时（AI 用 schedule 工具给自己设的「到点叫我」）：没有时整条收起。
                task 模式的同一条挂在 page.tsx 的「跟 AI 说」输入条上方 */}
            <ScheduleChip taskId={task.id} events={task.events} />
          </div>
          <ConversationComposer
            {...rich.bind}
            editorKey={task.id}
            onSubmit={handleSend}
            placeholder={
              awaitingAsk
                ? "可先答上方提问，也可在此继续说"
                : composeEnabled
                  ? `随便聊、贴图、拖文件、/ 唤起 skill（${submitShortcutHint}）`
                  : (disabledHint ?? "agent 当前没有等待你回复")
            }
            disabled={!composeEnabled}
            ariaLabel="发消息"
            submitting={submitting}
            topRow={composerTop}
            leading={composerLeading}
            running={composerRunning}
            stopOnly={composerStopOnly}
            onStop={onStop}
            stopping={stopping}
            stopLabel={stopLabel}
            allowQueueWhileRunning={allowQueueWhileRunning && !awaitingAsk}
            queueBanner={queueBanner}
            className={cn(
              "mx-auto w-full max-w-3xl",
              // 失活态（AI 没在等你回复）：只降低边框 / 底色 / 阴影的对比，⛔ 不整体压 opacity——
              // 旧的整岛 opacity-70 连 placeholder 与文字一起压（实测 3.45 / 4.02:1，低于 AA 4.5:1，V13-12）；
              // 现在文字 / placeholder 保持 text-muted-foreground 的原始对比度
              !isAwaitingUser &&
                !composerRunning &&
                !awaitingAsk &&
                "border-border/60 bg-muted/30 shadow-none",
            )}
          />
        </div>
      )}
      {/* task 形态的粘性状态行（V16-05）：列表容器之外、固定在事件流底部——长列表滚下去也看得见，
          不是列表里的虚拟项（那样滚走就没了，正是「AI 在跑但流里没有转圈 / 计时」要修的）。
          槽位运行期间始终占住 h-7，状态行出没不带着列表可视区高度跳（同 chat 槽位的做法）。
          task 的输入条在页面级（TaskTalkComposer），所以这里只有状态行、没有输入岛 */}
      {isChat ? null : (
        <div className="shrink-0 px-4">
          <div
            className={cn(
              "overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none",
              reserveTaskStatusSlot ? "h-7" : "h-0",
            )}
          >
            {activeStatus && (
              <ActiveStatusLine
                status={activeStatus}
                onSkipWait={handleSkipWait}
              />
            )}
          </div>
        </div>
      )}
      {/* 读屏播报区（V14-01 / V16-10）：sr-only、挂在列表之外，只念状态行 label（不含秒数）与
          挂载之后新增的失败 / 待答 / 完成。列表里的卡片不加 live 属性（虚拟列表滚入视口会反复播报） */}
      <StreamAnnouncer
        taskId={task.id}
        events={task.events}
        isChat={isChat}
        statusLabel={activeStatus?.label ?? ""}
      />
    </div>
    </PaneSearchHighlightProvider>
    </StreamActionsProvider>
    </StreamFollowContext.Provider>
    </SubagentDetailHost>
  );
};

export const EventStream = memo(EventStreamImpl);
