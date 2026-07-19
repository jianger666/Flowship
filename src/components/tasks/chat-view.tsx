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
import { Pencil, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { ChatModelPicker } from "@/components/tasks/chat-model-picker";
import { ChatBranchPicker } from "@/components/tasks/chat-branch-picker";
import {
  ChatWorkdirPicker,
  type ChatWorkdirPickerHandle,
} from "@/components/tasks/chat-workdir-picker";
import { ChatMcpPicker } from "@/components/tasks/chat-mcp-picker";
import { EventStream } from "@/components/tasks/event-stream";
import {
  ComposerSessionProvider,
  buildInputHistory,
} from "@/components/composer-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { useDialog } from "@/hooks/use-dialog";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  allocClientChatQueueItemId,
  emptyChatOpState,
  findReusableUncertainOperation,
  reduceChatOperation,
  type ChatOpState,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import { prepareRunArgs } from "@/lib/run-args";
import {
  CHAT_ATTACHMENT_ONLY_TEXT,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
} from "@/lib/task-display";
import {
  ApiRequestError,
  compactChatSession,
  fetchChatContext,
  rewindChatToEvent,
  sendChatReply,
  stopTask,
  updateTaskFields,
  type ChatContextInfo,
  type ImagePayload,
} from "@/lib/task-store";
import { canCommitTaskSnapshot, commitTaskDeleted } from "@/lib/task-terminal";
import {
  isEphemeralToolOutputDelta,
  parseToolOutputDelta,
  trimLiveOutputLines,
} from "@/lib/tool-display";
import type { Task, TaskEvent } from "@/lib/types";

interface Props {
  task: Task;
  // 父组件持 task state、ChatView 把最新 task / event 推回去（SSE 增量驱动）
  onTaskUpdate: (next: Task) => void;
  onEventAppend: (ev: TaskEvent) => void;
  // v1.0.x 事件懒加载：上拉分页拉到的更早事件、插到父组件事件列表头部
  onPrependEvents?: (events: TaskEvent[]) => void;
  /** R34-5：task_deleted / watch 404 → 清本地态后通知父级（setTask null + 侧栏失效） */
  onTaskDeleted?: (taskId: string) => void;
}

/**
 * R35-2：本地 Operation 占位（完整 payload + fingerprint，文案不参与 retry identity）。
 * images / attachments / skillRefs 供 uncertain 同 fingerprint 重发复用。
 */
type PendingLocalReply = ChatOperation & {
  id: string;
  /** 派生自 phase，给 event-stream 占位行用 */
  uncertain?: boolean;
  images?: ImagePayload[];
  attachments?: string[];
  skillRefs?: Array<{ name: string; absPath: string }>;
};

const formatTokensWan = (n: number | null): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 10000) return `~${Math.round(n)} tokens`;
  return `~${(n / 10000).toFixed(1)}万 tokens`;
};

export const ChatView = ({
  task,
  onTaskUpdate,
  onEventAppend,
  onPrependEvents,
  onTaskDeleted,
}: Props) => {
  // 流式打字态：SDK 推 assistant chunk → 累加到这；收到正式 assistant_message → 清空
  // 切 task.id 也要清、避免上个任务的 streaming 串到新任务
  const [streamingText, setStreamingText] = useState("");
  // 本地「提交中」标记：sendChatReply 飞行期间 disable 输入框、防双击
  // 区别于 task.runStatus="running"（agent 在说话）、这个是请求飞行中、通常 < 1s
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 「停止」按钮提交锁——中断 running 的 chat agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);
  // shell 流式输出：callId → 尾部窗口文本（ephemeral，不进 task.events）
  const [liveToolOutputs, setLiveToolOutputs] = useState<
    Record<string, string>
  >({});
  // P5：排队条（第 N 条）；null = 无排队
  const [queuedCount, setQueuedCount] = useState<number | null>(null);
  // P5 / R35-2：Operation ledger（pending + settled + outcomes）——HTTP/SSE 同一 reducer
  const [pendingLocalReplies, setPendingLocalReplies] = useState<
    PendingLocalReply[]
  >([]);
  // 与 pending 同步：onDone 需读最新值（避免闭包陈旧）
  const pendingLocalRepliesRef = useRef(pendingLocalReplies);
  pendingLocalRepliesRef.current = pendingLocalReplies;
  // R35-2：settled / outcomes 用 ref（不触发渲染）；与 pending 组成完整 ledger
  const opSettledRef = useRef<string[]>([]);
  const opOutcomesRef = useRef<ChatOpState["outcomes"]>({});
  // 闭包捕获的 taskId——卸载后异步回调先验 terminal
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;
  // P4：上下文透视
  const [contextOpen, setContextOpen] = useState(false);
  const [contextInfo, setContextInfo] = useState<ChatContextInfo | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [keepHints, setKeepHints] = useState("");
  const [compacting, setCompacting] = useState(false);

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
  const onTaskDeletedRef = useRef(onTaskDeleted);
  onTaskUpdateRef.current = onTaskUpdate;
  onEventAppendRef.current = onEventAppend;
  onTaskDeletedRef.current = onTaskDeleted;

  /** R35-2：把 reducer 结果写回 state/ref，并同步 queuedCount */
  const commitOpResult = useCallback(
    (result: ReturnType<typeof reduceChatOperation>): typeof result => {
      opSettledRef.current = result.state.settled;
      opOutcomesRef.current = result.state.outcomes;
      // uncertain 派生自 phase，供 event-stream 占位行（未改其 props 契约）
      const nextPending: PendingLocalReply[] = result.state.pending.map((p) => ({
        ...p,
        id: p.id ?? p.itemId,
        uncertain: p.phase === "uncertain",
      })) as PendingLocalReply[];
      pendingLocalRepliesRef.current = nextPending;
      setPendingLocalReplies(nextPending);
      setQueuedCount(nextPending.length > 0 ? nextPending.length : null);
      return result;
    },
    [],
  );

  const readOpState = useCallback(
    (): ChatOpState => ({
      pending: pendingLocalRepliesRef.current,
      settled: opSettledRef.current,
      outcomes: opOutcomesRef.current,
    }),
    [],
  );

  // 切 task 时把 streaming / submitting / stopping / live 输出 / 排队重置
  useEffect(() => {
    setStreamingText("");
    setIsSubmitting(false);
    setStopping(false);
    setLiveToolOutputs({});
    setQueuedCount(null);
    setPendingLocalReplies([]);
    pendingLocalRepliesRef.current = [];
    opSettledRef.current = [];
    opOutcomesRef.current = {};
    setContextInfo(null);
    setKeepHints("");
  }, [task.id]);

  useTaskWatch(task.id, {
    onEvent: (ev) => {
      // ephemeral shell delta：不进持久 events，按 callId 累积到运行中工具块
      const delta = parseToolOutputDelta(ev);
      if (delta) {
        setLiveToolOutputs((prev) => ({
          ...prev,
          [delta.callId]: trimLiveOutputLines(
            `${prev[delta.callId] ?? ""}${delta.chunk}`,
          ),
        }));
        return;
      }
      // 双保险：其它 ephemeral 也不落盘
      if (isEphemeralToolOutputDelta(ev)) return;

      // tool_result 到达 → 清掉该 callId 的直播缓冲（最终 output 在 meta）
      if (ev.kind === "tool_result") {
        const cid =
          typeof ev.meta?.callId === "string" ? ev.meta.callId : "";
        if (cid) {
          setLiveToolOutputs((prev) => {
            if (!(cid in prev)) return prev;
            const next = { ...prev };
            delete next[cid];
            return next;
          });
        }
      }

      // 收到正式 assistant_message 事件：清掉 streaming placeholder、避免「placeholder + 正式卡片」重影
      if (ev.kind === "assistant_message") setStreamingText("");

      // R35-2：user_reply → 同一 Operation reducer（记 delivered）
      if (ev.kind === "user_reply") {
        commitOpResult(
          reduceChatOperation(readOpState(), { type: "user_reply", ev }),
        );
      }

      onEventAppendRef.current(ev);
    },
    // R35-2：整队作废 → reducer 记 failed
    onQueueFailed: (itemIds, reason) => {
      commitOpResult(
        reduceChatOperation(readOpState(), {
          type: "queue_failed",
          itemIds,
        }),
      );
      if (itemIds.length > 0) {
        // R32-2：reason 不止 persist_failed——文案按语义区分
        toast.error(
          reason === "persist_failed"
            ? `${itemIds.length} 条消息因磁盘写入失败未发送`
            : `${itemIds.length} 条排队消息未送达、请重新发送`,
        );
      }
    },
    // R35-2：重连 bootstrap → 同一 reducer
    onQueueState: (serverItemIds, recentSettled) => {
      const before = pendingLocalRepliesRef.current.length;
      const result = commitOpResult(
        reduceChatOperation(readOpState(), {
          type: "queue_state",
          serverItemIds,
          recentSettled,
        }),
      );
      const cleared = before - result.state.pending.length;
      if (cleared > 0) {
        toast.message(`已清除 ${cleared} 条失效的排队占位`);
      }
    },
    // R35-5：task 快照提交前验 sticky terminal（卸载后迟到回调也不复活）
    onTaskUpdate: (t) => {
      if (!canCommitTaskSnapshot(t.id)) return;
      onTaskUpdateRef.current(t);
    },
    onDone: (t) => {
      setStreamingText("");
      setLiveToolOutputs({});
      const remaining = pendingLocalRepliesRef.current.length;
      // R33-1：idle/error 清 pending 时把 itemId 记入 settled（pending 登记先于请求，done 必有 id）
      // awaiting_user：自然回合结束，队可能正在 flush，保留 pending 等 SSE user_reply 对账
      if (
        remaining > 0 &&
        (t.runStatus === "idle" || t.runStatus === "error")
      ) {
        const result = commitOpResult(
          reduceChatOperation(readOpState(), { type: "done_clear" }),
        );
        toast.message(
          `会话已结束，已清除 ${(result.clearedIds ?? []).length} 条未确认的排队占位（若仍需发送请重新输入）`,
        );
      } else {
        setQueuedCount(remaining > 0 ? remaining : null);
      }
      if (!canCommitTaskSnapshot(t.id)) return;
      onTaskUpdateRef.current(t);
    },
    onAssistantDelta: (text) => setStreamingText((prev) => prev + text),
    onErrorMessage: (msg) => toast.error(`Chat watch 出错：${msg}`),
    onWatchException: (err) => toast.error(`Chat watch 异常：${err.message}`),
    // R35-5：task_deleted / watch 404 → 清 pending/streaming，再走统一 sink
    onTaskDeleted: (deletedId) => {
      setStreamingText("");
      setLiveToolOutputs({});
      commitOpResult(
        reduceChatOperation(emptyChatOpState(), { type: "clear_all" }),
      );
      // 父级会再调 commitTaskDeleted；此处先清本地，父级负责 sticky + 列表
      // 若父级未挂 onTaskDeleted，本处仍保证 sticky（双保险）
      if (onTaskDeletedRef.current) {
        onTaskDeletedRef.current(deletedId);
      } else {
        commitTaskDeleted(deletedId);
      }
    },
  }, true);

  // 用户回复：允许 running 时入队（P5）；返回 false = 失败（调用方保留草稿）
  const handleUserReply = useCallback(
    async (
      text: string,
      images?: ImagePayload[],
      attachments?: string[],
      skillRefs?: Array<{ name: string; absPath: string }>,
    ): Promise<boolean> => {
      // R35-5：已 deleted → 丢弃（含卸载后在飞 async）
      if (!canCommitTaskSnapshot(taskIdRef.current)) return false;

      const args = prepareRunArgs(task);
      // prepareRunArgs 已 toast；返回 false 让调用方保留草稿+附件
      if (!args) return false;

      // R35-2：fingerprint 判定 retry identity；改 payload → 新 id
      const displayText = text || CHAT_ATTACHMENT_ONLY_TEXT;
      const payloadFingerprint = fingerprintFromChatSendArgs({
        text,
        images,
        attachments,
        skills: skillRefs,
      });
      const reuseUncertain = findReusableUncertainOperation(
        pendingLocalRepliesRef.current,
        payloadFingerprint,
      );
      let clientItemId =
        reuseUncertain?.itemId ?? allocClientChatQueueItemId();

      const registerOp = (itemId: string) => {
        commitOpResult(
          reduceChatOperation(readOpState(), {
            type: "register",
            op: {
              id: itemId,
              itemId,
              payloadFingerprint,
              phase: "sending",
              text,
              displayText,
              images,
              attachments,
              skillRefs,
            },
          }),
        );
      };

      if (!reuseUncertain) {
        registerOp(clientItemId);
      }

      /** 单次 POST；payload_mismatch 时外层转新 id 重试一次 */
      const postOnce = async (itemId: string): Promise<boolean> => {
        const result = await sendChatReply(
          taskIdRef.current,
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
        // R35-5：响应到达时 task 可能已删——不复活 UI
        if (!canCommitTaskSnapshot(taskIdRef.current)) {
          return true;
        }
        // R30-3：send 后落盘失败——不可忽略提示
        if ("persistWarning" in result && result.persistWarning) {
          toast.error(
            `消息已送达但记录保存失败：${result.persistWarning}`,
          );
        }
        if ("settled" in result && result.settled) {
          commitOpResult(
            reduceChatOperation(readOpState(), {
              type: "http_settled",
              itemId: result.itemId,
              outcome: result.outcome,
            }),
          );
          if (result.task && canCommitTaskSnapshot(result.task.id)) {
            onTaskUpdateRef.current(result.task);
          }
          return true;
        }
        if ("queued" in result && result.queued) {
          setQueuedCount(result.queuedCount);
          commitOpResult(
            reduceChatOperation(readOpState(), {
              type: "http_queued",
              itemId: result.itemId,
            }),
          );
          if (result.task && canCommitTaskSnapshot(result.task.id)) {
            onTaskUpdateRef.current(result.task);
          }
          return true;
        }
        // 200 非 queued：摘掉本条预登记 pending（真实气泡走 SSE user_reply）
        commitOpResult(
          reduceChatOperation(readOpState(), {
            type: "http_direct_ok",
            itemId,
          }),
        );
        if (
          "task" in result &&
          result.task &&
          canCommitTaskSnapshot(result.task.id)
        ) {
          onTaskUpdateRef.current(result.task);
        }
        return true;
      };

      setIsSubmitting(true);
      try {
        try {
          return await postOnce(clientItemId);
        } catch (err) {
          // R35-2：同 id payload 不同 → 提示并转新 id 重发一次
          if (
            err instanceof ApiRequestError &&
            err.code === "payload_mismatch"
          ) {
            toast.message("上一条同 id 消息内容不同，已改用新 id 重发");
            commitOpResult(
              reduceChatOperation(readOpState(), {
                type: "payload_mismatch",
                itemId: clientItemId,
              }),
            );
            clientItemId = allocClientChatQueueItemId();
            registerOp(clientItemId);
            try {
              return await postOnce(clientItemId);
            } catch (retryErr) {
              err = retryErr;
            }
          }

          if (!canCommitTaskSnapshot(taskIdRef.current)) {
            // 已删：不保留草稿打扰
            return true;
          }

          // R35-2：4xx 业务拒绝 / 网络不确定都走同一 reducer
          const status =
            err instanceof ApiRequestError ? err.status : undefined;
          const isBizReject =
            typeof status === "number" && status >= 400 && status < 500;
          if (isBizReject) {
            commitOpResult(
              reduceChatOperation(readOpState(), {
                type: "http_reject_biz",
                itemId: clientItemId,
              }),
            );
            toast.error(`回复失败：${(err as Error).message}`);
            return false;
          }
          const net = commitOpResult(
            reduceChatOperation(readOpState(), {
              type: "http_reject_network",
              itemId: clientItemId,
            }),
          );
          // SSE 终态先到 → clearDraft=true，视为已接受
          if (net.clearDraft) {
            return true;
          }
          toast.message("发送状态未知、正在确认…");
          return false;
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [task, commitOpResult, readOpState],
  );

  // 停止当前正在跑的 chat agent
  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      const latest = await stopTask(task.id);
      setStreamingText("");
      // R35-2：stop 清队走同一 reducer
      const result = commitOpResult(
        reduceChatOperation(readOpState(), { type: "done_clear" }),
      );
      if (canCommitTaskSnapshot(latest.id)) {
        onTaskUpdateRef.current(latest);
      }
      if ((result.clearedIds ?? []).length > 0) {
        toast.message(
          `已丢弃 ${(result.clearedIds ?? []).length} 条未发送的排队消息`,
        );
      }
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
    } finally {
      setStopping(false);
    }
  }, [task.id, commitOpResult, readOpState]);

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
      const ok = await confirm({
        title: "回退到这里？",
        description:
          "将恢复文件到该时刻并删除之后的对话。未提交的改动会被覆盖；原暂存区（staged/unstaged）区分无法恢复，回退后的内容可能全部处于已暂存状态",
        destructive: true,
        confirmLabel: "回退",
      });
      if (!ok) return;
      try {
        const { task: latest, refreshRequired } = await rewindChatToEvent(
          task.id,
          eventId,
        );
        if (!latest || refreshRequired) {
          // 回退已提交但服务端读 task 失败：勿 onTaskUpdate(null)，提示用户刷新
          toast.success("已回退，请刷新查看最新状态");
          return;
        }
        onTaskUpdateRef.current(latest);
        toast.success("已回退");
      } catch (err) {
        const msg = (err as Error).message;
        if (/跑|running|停止|409/i.test(msg)) {
          toast.error("请先停止当前回复再回退");
        } else {
          toast.error(`回退失败：${msg}`);
        }
      }
    },
    [confirm, task.id],
  );

  // P4：打开上下文 Popover 时拉一次
  const handleContextOpenChange = useCallback(
    async (open: boolean) => {
      setContextOpen(open);
      if (!open) return;
      setContextLoading(true);
      try {
        const info = await fetchChatContext(task.id);
        setContextInfo(info);
      } catch (err) {
        toast.error(`拉取上下文失败：${(err as Error).message}`);
        setContextInfo(null);
      } finally {
        setContextLoading(false);
      }
    },
    [task.id],
  );

  const handleCompact = useCallback(async () => {
    setCompacting(true);
    try {
      const latest = await compactChatSession(
        task.id,
        keepHints.trim() || undefined,
      );
      onTaskUpdateRef.current(latest);
      toast.success("会话已压缩");
      setContextOpen(false);
      // 刷新透视
      try {
        setContextInfo(await fetchChatContext(task.id));
      } catch {
        /* ignore */
      }
    } catch (err) {
      toast.error(`压缩失败：${(err as Error).message}`);
    } finally {
      setCompacting(false);
    }
  }, [keepHints, task.id]);

  // P5：running 时仍可排队发送；仅 isSubmitting 短暂锁
  const canReply = !isSubmitting;

  const disabledHint = (() => {
    if (isSubmitting) return "正在发送、稍候";
    return undefined;
  })();

  const statusHint = (() => {
    if (task.runStatus === "error") {
      return "上一轮 agent 异常退出、再发一条可重启新一轮 run";
    }
    return null;
  })();

  const queueBanner =
    queuedCount != null && queuedCount > 0 ? (
      <div className="mx-2.5 mb-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        已排队，将在当前回复完成后发送（第 {queuedCount} 条）
      </div>
    ) : null;

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
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={handleRename}
                title="重命名对话"
                aria-label="重命名对话"
              >
                <Pencil />
              </Button>
              <Badge variant="outline" className="text-[10px]">
                对话
              </Badge>
              {task.runStatus !== "idle" && task.runStatus !== "awaiting_user" && (
                <Badge
                  variant={RUN_STATUS_VARIANT[task.runStatus]}
                  className="text-[10px]"
                >
                  {RUN_STATUS_LABEL[task.runStatus]}
                </Badge>
              )}
            </div>
          </div>

          {/* 标题行右侧：上下文用量 */}
          <div className="flex shrink-0 items-center gap-1">
            <Popover open={contextOpen} onOpenChange={(o) => void handleContextOpenChange(o)}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    title="上下文用量"
                  >
                    <Sparkles className="size-3" />
                    <span className="tabular-nums">
                      {formatTokensWan(contextInfo?.totalTokens ?? null)}
                    </span>
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-72 p-3">
                <div className="space-y-2.5">
                  <div className="text-xs font-medium">上下文</div>
                  {contextLoading ? (
                    <div className="text-xs text-muted-foreground">加载中…</div>
                  ) : contextInfo ? (
                    <>
                      <div className="text-sm tabular-nums">
                        {formatTokensWan(contextInfo.totalTokens)}
                      </div>
                      {contextInfo.breakdown.length > 0 && (
                        <ul className="space-y-1 text-[11px] text-muted-foreground">
                          {contextInfo.breakdown.map((b) => (
                            <li
                              key={b.label}
                              className="flex justify-between gap-2"
                            >
                              <span className="min-w-0 truncate">{b.label}</span>
                              <span className="shrink-0 tabular-nums">
                                {b.tokens.toLocaleString()}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {contextInfo.compactRecommended && (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
                          上下文较大，建议压缩
                        </div>
                      )}
                      <Input
                        value={keepHints}
                        onChange={(e) => setKeepHints(e.target.value)}
                        placeholder="保留要点（可选）"
                        className="h-7 text-xs"
                        disabled={compacting}
                      />
                      <Button
                        size="sm"
                        className="h-7 w-full text-xs"
                        disabled={compacting || task.runStatus === "running"}
                        onClick={() => void handleCompact()}
                      >
                        {compacting ? "压缩中…" : "压缩会话"}
                      </Button>
                    </>
                  ) : (
                    <div className="text-xs text-muted-foreground">暂无数据</div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        {statusHint && (
          <div className="mt-1 w-full text-xs text-muted-foreground">
            {statusHint}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <EventStream
          key={task.id}
          task={task}
          variant="chat"
          streamingText={streamingText}
          liveToolOutputs={liveToolOutputs}
          onUserReply={handleUserReply}
          canReply={canReply}
          submitting={isSubmitting}
          disabledHint={disabledHint}
          isRunning={task.runStatus === "running"}
          onStop={handleStop}
          stopping={stopping}
          onPrependEvents={onPrependEvents}
          onRewind={handleRewind}
          pendingLocalReplies={pendingLocalReplies}
          queueBanner={queueBanner}
          allowQueueWhileRunning
          composerLeading={
            <ChatModelPicker task={task} onTaskUpdate={onTaskUpdate} />
          }
          composerTop={
            <>
              <ChatWorkdirPicker
                ref={workdirPickerRef}
                task={task}
                onTaskUpdate={onTaskUpdate}
              />
              <ChatBranchPicker task={task} />
              <ChatMcpPicker task={task} onTaskUpdate={onTaskUpdate} />
            </>
          }
        />
      </div>
    </div>
    </ComposerSessionProvider>
  );
};
