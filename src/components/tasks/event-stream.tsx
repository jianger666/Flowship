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
 *   - event-stream/rows.tsx  MarkdownText / StreamingAssistantRow / EventRow / AskUserRequestRow
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Loader2, Sparkles as SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Composer, type ComposerFocusHandle } from "@/components/composer";
import { useSlashSkills } from "@/components/slash-skills";
import { useImageAttach } from "@/hooks/use-image-attach";
import { usePathAttach } from "@/hooks/use-path-attach";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { findPendingAskEvent } from "@/lib/ask-pending";
import { getSubmitShortcutHint } from "@/lib/submit-shortcut";
import { fetchEarlierEvents, type ImagePayload } from "@/lib/task-store";
import {
  getScrollAnchor,
  loadDraft,
  saveDraft,
  saveScrollAnchor,
} from "@/lib/view-memory";
import type { Task, TaskEvent } from "@/lib/types";

import {
  mergeAdjacentThinking,
  mergeAdjacentToolCall,
} from "./event-stream/utils";
import {
  AskUserRequestRow,
  EventRow,
  ReconnectingRow,
  StreamingAssistantRow,
} from "./event-stream/rows";
import { AskUserInlineCard } from "./ask-user-inline";

// streaming placeholder 作为 list 末尾的「虚拟 item」、参与虚拟滚动
// kind 用未出现在 EventKind 里的字面量、做 discriminated union 区分
// 这样 streamingText 不再走 Footer / Component slot、而是直接进 data 数组、
// followOutput 跟着它的追加触发滚动、不用单独 ref 控制
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
}

type RenderItem = TaskEvent | StreamingItem | LoadingItem;

const isStreamingItem = (it: RenderItem): it is StreamingItem =>
  it.kind === "__streaming__";

const isLoadingItem = (it: RenderItem): it is LoadingItem =>
  it.kind === "__loading__";

// 「发出消息 → 程序受理」空白期的 loading 占位行：小转圈 +「正在响应…」、muted 细行风格
const PendingRow = () => (
  <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
    <Loader2 className="size-3.5 animate-spin" />
    <span>正在响应…</span>
  </div>
);

interface Props {
  task: Task;
  // 流式 placeholder：chat-view 维护、SDK chunk 推到这里、收到正式 assistant_message 事件清空
  // 非空时在事件流末尾渲染一个「AI 回复中...」卡片、内容随 chunk 拼接增长（打字机效果）
  // V1 仅 chat 模式用、plan 模式不传
  streamingText?: string;
  // attachments：附加的文件 / 目录绝对路径数组、后端发给 agent 时拼成
  // [ATTACHED_PATHS] 段、agent 用 `read` 工具自己读
  onUserReply?: (
    text: string,
    images?: ImagePayload[],
    attachments?: string[],
  ) => void;
  // V0.2 plan workflow 模式下传 true、不渲染底部「自由回复」输入框
  // 因为 plan 模式的 HITL 是 phase ack（通过 / 再聊聊）、不是 free-form 聊天
  // ack 按钮由父组件渲染在顶部 / 详情区其他位置
  hideReplyComposer?: boolean;
  // V0.4：输入框可用判定下放给父组件
  // - 不传：用旧行为（task.status === "awaiting_user" 才可用、给 plan 用）
  // - 传：父组件决定（chat-view 传：draft / completed / failed / awaiting_user 都可用、running / starting 不可用）
  // 命名上跟 awaiting_user 解耦——父组件知道更多状态（如 starting）、UI 该不该可用归它判
  canReply?: boolean;
  // V0.4：禁用时底部的状态文案（chat 自由化下、文案需要随 task.status / starting 动态变）
  // 不传：用旧 plan 文案「agent 在等待你回复时输入框才会激活」
  disabledHint?: string;
  // V0.6.24：footer 左侧 slot（chat 模式注入模型选择器、plan / task 模式不传）
  composerLeading?: ReactNode;
  // chat 模式 textarea 上方一行 slot（注入工作目录 + 分支选择器、跟底部 model 分两处放）
  composerTop?: ReactNode;
  // V0.7.21：chat 运行态——agent 正在生成时、底部操作行把发送键换成红色停止键 + loading 转圈
  // （取代顶栏旧的「AI 正在回 + 停止」、统一收进输入岛、靠原地替换不顶布局）
  isRunning?: boolean;
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
}

// 路径附件上限在 use-path-attach hook 内统一管（10 条、跟服务端路由对齐）

// 用 React.memo 包裹：详情页输入交互（如「再聊聊」对话框输入）触发 page 重渲染时、
// 只要 task / streamingText 引用没变就跳过本组件、避免几百条 events 的子树参与 reconcile
// 这是用户实测踩过的性能坑（输入卡顿 / [Violation] message handler took XXXms）
// Virtuoso firstItemIndex 起始基数（prepend 分页时递减、官方要求保持正数——取个够大的）
const FIRST_INDEX_BASE = 1_000_000;
// 上拉一页拉多少条
const EARLIER_PAGE_SIZE = 300;

// Virtuoso context 形状（Header 靠它拿「正在拉更早」状态、组件本身保持模块级稳定引用）
interface StreamListContext {
  loadingEarlier: boolean;
}

// 顶部「加载更早…」细行：仅分页请求飞行中显示
const EarlierLoadingHeader = ({ context }: { context?: StreamListContext }) =>
  context?.loadingEarlier ? (
    <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      加载更早…
    </div>
  ) : null;

const VIRTUOSO_COMPONENTS = { Header: EarlierLoadingHeader };

const EventStreamImpl = ({
  task,
  streamingText,
  onUserReply,
  hideReplyComposer,
  canReply,
  disabledHint,
  composerLeading,
  composerTop,
  isRunning,
  onStop,
  stopping,
  variant = "log",
  onPrependEvents,
}: Props) => {
  const isChat = variant === "chat";
  // 输入草稿、发送后清空；按 task 记进 sessionStorage（v1.1.x、打半段切页不丢）
  const [draft, setDraft] = useState(() => loadDraft("reply", task.id));
  // 文件 / 目录路径附件（原生 picker、跟 task「跟 AI 说」条共用 hook）
  const pathAttach = usePathAttach();
  // 个人偏好的提交快捷键（placeholder 提示用；提交判定在 Composer 内部）
  const submitShortcutHint = getSubmitShortcutHint(useSubmitShortcut());
  // Virtuoso 句柄：流式增长时手动 scrollToIndex 贴底（见下方 streaming 自动滚 effect）
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // 用户当前是否贴在底部（由 Virtuoso atBottomStateChange 维护）。
  // 初始 true：进来 initialTopMostItemIndex 定位到末尾、就是贴底态。
  // 关键作用：流式回复时只有「用户本来就在底部」才自动跟随、用户主动往上翻看历史就不打扰。
  const atBottomRef = useRef(true);
  // 贴底状态的 state 版（V0.13.x「AI 在等你回答」悬浮条显隐用——ref 不触发渲染）
  const [atBottomState, setAtBottomState] = useState(true);
  // 初始滚动定位闸（v1.1.x 滚动位置记忆）：首次有 items 时算一次——有「非贴底离开」的
  // 锚点就恢复到那条、否则默认落底；null = 还没算（切 task 时重开）
  const initialTopRef = useRef<number | null>(null);
  // 输入框：用于「awaiting_user 时自动聚焦」、避免用户每次都得手动点输入框
  const inputRef = useRef<ComposerFocusHandle | null>(null);


  // 渲染前两道合并 pass + 拼 streaming placeholder：
  // 1) thinking 合并：连续相邻 thinking 拼成一条、避免「思考被切碎」
  // 2) tool_call 合并：同 phase 连续 ≥2 条合一、降密度（review 阶段一连
  //    十几条 edit artifact 视觉重、合并后变一行 ×N）
  // 3) streamingText 非空时追加为末尾 `__streaming__` 虚拟 item、跟普通 event
  //    一起参与虚拟滚动 + followOutput 贴底跟随
  const items: RenderItem[] = useMemo(() => {
    const merged = mergeAdjacentToolCall(mergeAdjacentThinking(task.events));
    // agent 在吐字 → 末尾打字机 item；
    // 在跑但还没吐字（起手空窗）→ 末尾 loading item；都没有 → 原样
    if (streamingText) {
      return [
        ...merged,
        { kind: "__streaming__", id: "__streaming__", text: streamingText },
      ];
    }
    // 「发出消息 → 程序受理」空白期：agent 已在跑、但事件流最后一条还是用户刚发的消息
    // （启动 info / thinking / tool 都还没冒出来）→ 末尾挂一行 loading。
    // 一旦出现第一个 agent 事件、last 不再是 user_reply、loading 自动消失（不会盖住链路）。
    const last = merged[merged.length - 1];
    if (isRunning && last?.kind === "user_reply") {
      return [...merged, { kind: "__loading__", id: "__loading__" }];
    }
    return merged;
  }, [task.events, streamingText, isRunning]);

  // 当前待答的 ask（V0.13.x 内联答题卡分流用）：命中的那条渲染 AskUserInlineCard、
  // 其余 ask 行走回放卡。判定收口在 lib/ask-pending（只认最新一条未了结的）。
  const pendingAskEvent = useMemo(
    () => findPendingAskEvent(task.events),
    [task.events],
  );

  // ---------- v1.0.x 事件懒加载（上拉分页） ----------
  // firstItemIndex：Virtuoso prepend 保滚动位置的官方机制——头部插 N 个 item 就减 N
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_INDEX_BASE);
  // 还有没有更早的可拉（初值来自 task.eventsTruncated、之后由分页响应维护）
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  // 拉取飞行中（顶部小 spinner、渲染用）
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // 同步重入闸（蓝军 P1：state 版有一帧延迟、startReached 同帧可双进 → firstItemIndex 多减）
  const loadingEarlierRef = useRef(false);
  // 是否已经拉过至少一页（防 SSE 重连把 eventsTruncated 重新置 true 时误重开分页）
  const pagedOnceRef = useRef(false);
  // 最新 events 的 ref：分页请求飞行期间可能有新事件 append、算 items 增量要用最新值
  const latestEventsRef = useRef(task.events);
  latestEventsRef.current = task.events;

  // 切 task 重置分页状态 + 换载对应草稿 + 重开滚动恢复闸
  useEffect(() => {
    pagedOnceRef.current = false;
    loadingEarlierRef.current = false;
    setFirstItemIndex(FIRST_INDEX_BASE);
    setHasMoreEarlier(false);
    setLoadingEarlier(false);
    setDraft(loadDraft("reply", task.id));
    initialTopRef.current = null;
  }, [task.id]);
  // eventsTruncated 就绪（refresh / SSE bootstrap 都可能晚于 mount）时同步分页开关（升降都跟）；
  // 已经拉过页就不再被它改（本地分页状态才是准的）
  useEffect(() => {
    if (!pagedOnceRef.current) setHasMoreEarlier(!!task.eventsTruncated);
  }, [task.eventsTruncated]);

  // 上拉到顶：拉上一页、prepend + firstItemIndex 同步递减（同一次 React batch、滚动不跳）
  const loadEarlier = async () => {
    if (loadingEarlierRef.current || !hasMoreEarlier || !onPrependEvents) return;
    const anchor = latestEventsRef.current[0];
    if (!anchor) return;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const { events: older, hasMore } = await fetchEarlierEvents(
        task.id,
        anchor.id,
        EARLIER_PAGE_SIZE,
      );
      pagedOnceRef.current = true;
      // 先按当前本地事件去重（蓝军 P1：飞行期间本地可能已合入部分重叠事件、
      // 用原始 older 算差值会虚高 → firstItemIndex 多减 → 滚动错位）
      const cur = latestEventsRef.current;
      const known = new Set(cur.map((e) => e.id));
      const fresh = older.filter((e) => !known.has(e.id));
      if (fresh.length > 0) {
        // items 增量不能直接用 fresh.length：渲染层有 thinking / tool_call 相邻合并、
        // 拼接边界还可能跨页合并——用同一套纯函数分别算前后 items 数、差值才是真 prepend 数
        const beforeLen = mergeAdjacentToolCall(mergeAdjacentThinking(cur)).length;
        const afterLen = mergeAdjacentToolCall(
          mergeAdjacentThinking([...fresh, ...cur]),
        ).length;
        onPrependEvents(fresh);
        setFirstItemIndex((fi) => fi - (afterLen - beforeLen));
      }
      setHasMoreEarlier(hasMore);
    } catch (err) {
      toast.error(`加载更早事件失败：${(err as Error).message}`);
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  };

  // v1.1.x 滚动位置记忆：首次有 items 时把初始定位算进闸（渲染期 latch、只写一次）。
  // 锚点是「离开时视口顶部的事件 id」；贴底离开 / 锚点不在当前尾页（懒加载没包含）→ 落底
  if (initialTopRef.current === null && items.length > 0) {
    let idx = items.length - 1;
    const saved = getScrollAnchor(task.id);
    if (saved && !saved.atBottom) {
      const found = items.findIndex((it) => it.id === saved.anchorId);
      if (found >= 0) {
        idx = found;
        // 恢复到历史位置 = 非贴底态、流式自动跟随不要立刻把人拽回底部
        atBottomRef.current = false;
      }
    }
    initialTopRef.current = idx;
  }

  // 流式回复自动贴底（V0.8.3 修）：
  // 根因——流式回复是往同一个 `__streaming__` 虚拟 item 的 text 里追加、items 长度不变（始终
  // merged.length + 1）。react-virtuoso 的 followOutput 只在 data 条数变化时触发滚动、对「最后一项
  // 内容增高」无感、所以流式增长期间不会自动滚（用户实测：滚到底聊天、AI 回复过程不跟随）。
  // 修法——streamingText 每变一次（每个 chunk）、若用户本来贴在底部、就手动把最后一项滚到视口底。
  // 用 behavior:"auto"（瞬时）避免每个 chunk smooth 动画互相打架卡顿。atBottomRef 由下方
  // atBottomStateChange 维护、配合 Virtuoso 的 atBottomThreshold（给足余量、防单 chunk 增高把
  // atBottom 误判成 false 导致自废）。useEffect（非 layout）跑在 Virtuoso 测完新高度之后、scrollToIndex
  // 才能命中真正的新底部。
  useEffect(() => {
    if (!streamingText) return;
    if (!atBottomRef.current) return;
    virtuosoRef.current?.scrollToIndex({
      // "LAST"：末尾项——比 items.length-1 稳（firstItemIndex 分页下不用管 index 空间）
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  }, [streamingText, items.length]);

  // V0.6：输入框可用 = 父组件传 canReply
  // 父组件没传时回退 task.runStatus === "awaiting_user"
  const canCompose = canReply ?? task.runStatus === "awaiting_user";

  // 输入框自动聚焦判定：跟 canCompose 同款（之前用 isAwaitingUser、现在统一走 canCompose）
  // - chat 下 agent 答完自然结束回合、status 变 awaiting_user → canCompose 变 true 触发 focus
  const isAwaitingUser = canCompose;

  // V0.5.4 图附件管理统一走 hook（v1.1.x 起整个对象直传 <Composer>）
  // disabled=!isAwaitingUser 时所有 handler 短路、防止 agent 没等待时也能添图
  const attach = useImageAttach({ disabled: !isAwaitingUser });

  // 自动聚焦：进入「可输入」时把光标放进输入框、用户立刻可以打字
  // - 解决以前的痛点：agent 回完话、用户得鼠标点输入框才能输入
  // - 仅在 status「变成」awaiting_user 的边缘触发、避免用户主动点别处后被强抢焦点
  // - autoFocus 属性不行（只 mount 时生效）、必须 useEffect 跟着 status 变
  useEffect(() => {
    if (isAwaitingUser) {
      // 加个微延迟、让 disabled→enabled 的 DOM 变化先 commit、再 focus 才稳
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isAwaitingUser]);

  // `/` 唤起 skill：选中后补全成内联 `/name ` token（Codex 风、留在文本流里）
  const slash = useSlashSkills({
    draft,
    applyDraft: (next, cursor) => {
      // Lexical pick 通常已直接写编辑器；fallback / pending handoff 走这里
      if (cursor != null) inputRef.current?.prepareCursor(cursor);
      setDraft(next);
      saveDraft("reply", task.id, next);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    },
  });

  // v1.0：chat「最后一条用户消息」重发 / 原地编辑——把（编辑后的）内容作为新消息发到末尾。
  // 原消息保留（append-only 事件日志、持久会话没法真 fork）；只有最后一条才给入口（用户拍板：
  // 早期消息重发有上下文歧义、fork 语义做不了、砍掉）。不带图 / 附件（原消息的附件不重传）。
  const handleResend = useCallback(
    (text: string) => {
      onUserReply?.(text);
    },
    [onUserReply],
  );

  // 最后一条用户消息的 id：只有它 hover 出「重发 / 编辑」两 icon
  const lastUserReplyId = useMemo(() => {
    for (let i = task.events.length - 1; i >= 0; i--) {
      if (task.events[i].kind === "user_reply") return task.events[i].id;
    }
    return undefined;
  }, [task.events]);

  const handleSend = () => {
    const text = draft.trim();
    // 文本 / 图 / 路径至少有一个、纯空消息不发
    if (!text && attach.images.length === 0 && pathAttach.paths.length === 0) return;
    const images: ImagePayload[] | undefined = attach.toUploadPayload();
    const attachments = pathAttach.paths.length > 0 ? pathAttach.paths : undefined;
    // 选了 skill：消息头拼「先 read 这些 SKILL.md 再执行」指引
    onUserReply?.(slash.buildSkillPrefix() + text, images, attachments);
    setDraft("");
    saveDraft("reply", task.id, "");
    slash.reset();
    attach.reset();
    pathAttach.reset();
  };

  // chat 形态间距：对话消息（AI / 用户 / streaming / ask_user）之间留大段落感、
  // 连续过程行（thinking / tool_call / info…）紧凑堆叠成一组
  const isConversational = (it: RenderItem) =>
    isStreamingItem(it) ||
    it.kind === "assistant_message" ||
    it.kind === "user_reply" ||
    it.kind === "ask_user_request";

  return (
    <div className="flex h-full flex-col">
      {/* chat 形态不渲染「事件流」标签条（ChatView 自有顶部 bar、少一层视觉框） */}
      {!isChat && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
          事件流
        </div>
      )}
      {/* min-h-0 让 flex-1 子项能正确 shrink、Virtuoso 拿到确定高度才能内部 scroll。
          relative：给「AI 在等你回答」悬浮条定位 */}
      <div className="relative min-h-0 flex-1">
        {/* V0.13.x 注意力悬浮条（用户拍板「事件流太弱、怕注意不到」）：
            有未答提问且用户滚在历史里（不贴底）时、底部悬浮提示、点击滚到答题卡 */}
        {pendingAskEvent && !atBottomState && (
          <button
            type="button"
            onClick={() => {
              const idx = items.findIndex((it) => it.id === pendingAskEvent.id);
              if (idx >= 0) {
                virtuosoRef.current?.scrollToIndex({ index: idx, align: "center", behavior: "smooth" });
              }
            }}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-600 shadow-md backdrop-blur transition-colors hover:bg-amber-500/25 dark:text-amber-400"
          >
            <SparklesIcon className="size-3.5 animate-pulse" />
            AI 在等你回答、点击查看
          </button>
        )}
        {items.length === 0 ? (
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
            className="h-full"
            data={items}
            // v1.0.x 上拉分页三件套：
            // - computeItemKey：item 身份稳定（prepend 后不整列重挂）
            // - firstItemIndex：头部插 N 项就减 N、Virtuoso 保滚动位置（官方 prepend 机制）
            // - startReached：滚到顶自动拉上一页
            computeItemKey={(_idx, item) => item.id}
            firstItemIndex={firstItemIndex}
            startReached={() => void loadEarlier()}
            context={{ loadingEarlier }}
            components={VIRTUOSO_COMPONENTS}
            // 贴底跟随语义：用户贴在底部时新 item 来自动滚（smooth）；
            // 用户主动滚走看历史时不打扰；滚回底部恢复跟随
            // 这一行替代了老的 stickToBottomRef + handleScroll + autoScroll useEffect、
            // 库自己维护「是否贴底」、不需要外部 ref 状态
            followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
            // 维护「用户是否贴底」给上面的流式自动滚 effect 用。
            atBottomStateChange={(atBottom) => {
              atBottomRef.current = atBottom;
              setAtBottomState(atBottom);
              // 贴底状态变化也刷进锚点记忆（只更新 atBottom、锚点 id 由 rangeChanged 维护）
              const saved = getScrollAnchor(task.id);
              if (saved) saveScrollAnchor(task.id, { ...saved, atBottom });
            }}
            // v1.1.x 滚动位置记忆：滚动时持续记「视口顶部第一条事件 id + 是否贴底」、
            // 切走再切回按它恢复（虚拟 item __streaming__/__loading__ 不作锚点）
            rangeChanged={(range) => {
              const localIdx = range.startIndex - firstItemIndex;
              const top = items[localIdx];
              if (!top || top.id.startsWith("__")) return;
              saveScrollAnchor(task.id, {
                anchorId: top.id,
                atBottom: atBottomRef.current,
              });
            }}
            // 贴底判定余量调大（默认仅 4px）：流式时最后一项每来一个 chunk 会增高若干像素、
            // 余量太小会立刻被判成「离开底部」→ effect 自废不再跟随。120px 覆盖常见 chunk 增量、
            // 让「滚到底跟随」稳定；用户真往上翻 >120px 才停跟随。
            atBottomThreshold={120}
            // 初始定位：默认末尾（直接看最新事件）；有非贴底离开的锚点则恢复到那条（v1.1.x）
            initialTopMostItemIndex={initialTopRef.current ?? items.length - 1}
            // 每条 item 自带 padding；chat 形态窄列居中 + 按消息类型分配段落间距。
            // 注意：firstItemIndex 存在时 Virtuoso 传来的 idx 是「偏移后」的绝对索引、
            // 要先减回 firstItemIndex 才能对 items 数组做定位（分页 prepend 后不减必错位）
            itemContent={(absIdx, item) => {
              const idx = absIdx - firstItemIndex;
              return (
              <div
                className={cn(
                  "px-4",
                  isChat && "mx-auto w-full max-w-3xl px-6",
                  isChat
                    ? idx === 0
                      ? "pt-6"
                      : isConversational(item)
                        ? "pt-6"
                        : isConversational(items[idx - 1])
                          ? "pt-4"
                          : "pt-0.5"
                    : idx === 0
                      ? "pt-4"
                      : "pt-3",
                  idx === items.length - 1 && (isChat ? "pb-6" : "pb-4"),
                )}
              >
                {isStreamingItem(item) ? (
                  <StreamingAssistantRow text={item.text} variant={variant} />
                ) : isLoadingItem(item) ? (
                  <PendingRow />
                ) : item.kind === "ask_user_request" ? (
                  // V0.13.x：当前待答的 ask 直接内联答题卡（原模态弹窗淘汰、用户拍板
                  // 「弹窗挡整屏不合理」）；已答 / 已作废走回放卡
                  pendingAskEvent?.id === item.id ? (
                    <AskUserInlineCard task={task} ev={item} />
                  ) : (
                    <AskUserRequestRow ev={item} task={task} />
                  )
                ) : item.kind === "info" && item.meta?.kind === "reconnecting" ? (
                  // V0.13.x 自动重连过程行（spinner、同 thinking 一档的细行）
                  <ReconnectingRow ev={item} events={task.events} />
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
                  />
                )}
              </div>
              );
            }}
          />
        )}
      </div>
      {/* hideReplyComposer=true 时（task 模式）只展示事件流、底部输入区由父组件的
          TaskTalkComposer 替代；chat 形态渲染统一输入岛 <Composer>（v1.1.x 收口） */}
      {hideReplyComposer || !isChat ? null : (
        <div className="shrink-0 px-6 pb-5 pt-1">
          <Composer
            editorKey={task.id}
            value={draft}
            onChange={(v) => {
              setDraft(v);
              saveDraft("reply", task.id, v);
            }}
            onSubmit={handleSend}
            placeholder={
              isAwaitingUser
                ? `随便聊、贴图、拖文件、/ 唤起 skill（${submitShortcutHint}）`
                : (disabledHint ?? "agent 当前没有等待你回复")
            }
            disabled={!isAwaitingUser}
            focusRef={inputRef}
            slash={slash}
            attach={attach}
            paths={pathAttach.paths}
            onRemovePath={pathAttach.removePath}
            onPickPaths={(mode) => void pathAttach.pickPaths(mode)}
            picking={pathAttach.picking}
            topRow={composerTop}
            leading={composerLeading}
            running={isRunning}
            onStop={onStop}
            stopping={stopping}
            className={cn(
              "mx-auto w-full max-w-3xl",
              !isAwaitingUser && !isRunning && "opacity-70",
            )}
          />
        </div>
      )}
    </div>
  );
};

export const EventStream = memo(EventStreamImpl);
