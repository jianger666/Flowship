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

import { ChatModelPicker } from "@/components/tasks/chat-model-picker";
import { ChatBranchPicker } from "@/components/tasks/chat-branch-picker";
import {
  ChatWorkdirPicker,
  type ChatWorkdirPickerHandle,
} from "@/components/tasks/chat-workdir-picker";
import { ChatMcpPicker } from "@/components/tasks/chat-mcp-picker";
import { ChatQueueBanner } from "@/components/tasks/chat-queue-banner";
import { EventStream } from "@/components/tasks/event-stream";
import {
  ComposerSessionProvider,
  buildInputHistory,
} from "@/components/composer-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { useDialog } from "@/hooks/use-dialog";
import {
  clearChatOpLedger,
  dispatchChatOp,
  getChatOpLedger,
  subscribeChatOp,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
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
import { prepareRunArgs } from "@/lib/run-args";
import {
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
} from "@/lib/task-display";
import {
  ApiRequestError,
  rewindChatToEvent,
  sendChatReply,
  stopTask,
  updateTaskFields,
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
  // 提交锁绑定 request token——旧 A finally 不得释放 B 的锁
  const submitTokenRef = useRef<string | null>(null);
  // 「停止」按钮提交锁——中断 running 的 chat agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);
  // shell 流式输出：callId → 尾部窗口文本（ephemeral，不进 task.events）
  const [liveToolOutputs, setLiveToolOutputs] = useState<
    Record<string, string>
  >({});
  // P5：排队条（第 N 条）；null = 无排队
  const [queuedCount, setQueuedCount] = useState<number | null>(null);
  // Operation ledger（pending + settled + outcomes）——HTTP/SSE 同一 reducer
  const [pendingLocalReplies, setPendingLocalReplies] = useState<
    PendingLocalReply[]
  >([]);
  // 与 pending 同步：onDone 需读最新值（避免闭包陈旧）
  const pendingLocalRepliesRef = useRef(pendingLocalReplies);
  pendingLocalRepliesRef.current = pendingLocalReplies;
  // settled / outcomes 用 ref（不触发渲染）；与 pending 组成完整 ledger
  const opSettledRef = useRef<string[]>([]);
  const opOutcomesRef = useRef<ChatOpState["outcomes"]>({});
  // 闭包捕获的 taskId——卸载后异步回调先验 terminal
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;

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

  // 切 task：清 streaming 等 UI 态；订阅当前 task ledger
  useEffect(() => {
    setStreamingText("");
    // 切走时作废旧提交锁，避免 A finally 误清 B、也避免 UI 锁残留
    submitTokenRef.current = null;
    setIsSubmitting(false);
    setStopping(false);
    setLiveToolOutputs({});
    // 立即投影当前 ledger，再订阅后续 dispatch
    applyLedgerToUi(getChatOpLedger(task.id));
    return subscribeChatOp(task.id, applyLedgerToUi);
  }, [task.id, applyLedgerToUi]);

  // 是否渲染本地占位只看 persistence（与 terminal/network 轴正交）
  const pendingForStream = useMemo(
    () => pendingLocalReplies.filter((p) => !shouldHideLocalPlaceholder(p)),
    [pendingLocalReplies],
  );

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

      // user_reply → 标 persisted（非终态），不写 delivered
      // SSE 绑当前 watch task.id，显式传入（不靠可变 ref 推断）
      if (ev.kind === "user_reply") {
        dispatchChatOp(task.id, { type: "user_reply", ev });
      }

      onEventAppendRef.current(ev);
    },
    // 整队作废 → reducer 记 failed
    onQueueFailed: (itemIds, reason) => {
      dispatchChatOp(task.id, { type: "queue_failed", itemIds });
      // cancelled = 用户主动操作（队列面板删除 / 停止取消）——不是事故、不弹 error
      if (itemIds.length > 0 && reason !== "cancelled") {
        // reason 不止 persist_failed——文案按语义区分
        toast.error(
          reason === "persist_failed"
            ? `${itemIds.length} 条消息因磁盘写入失败未发送`
            : `${itemIds.length} 条排队消息未送达、请重新发送`,
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
    // 重连 bootstrap → 含 operationSnapshot，ghost 不写 delivered
    onQueueState: (serverItemIds, recentSettled, operationSnapshot) => {
      const before = pendingLocalRepliesRef.current.filter(
        (p) => !shouldHideLocalPlaceholder(p),
      ).length;
      const result = dispatchChatOp(task.id, {
        type: "queue_state",
        serverItemIds,
        recentSettled,
        operationSnapshot,
      });
      // 仍算「活跃排队」：未 persisted 且非 retryable uncertain
      const after = result.state.pending.filter(
        (p) =>
          !shouldHideLocalPlaceholder(p) &&
          !p.networkUncertain &&
          p.terminalKnowledge !== "unknown",
      ).length;
      const cleared = before - after;
      if (cleared > 0) {
        toast.message(`已清除 ${cleared} 条失效的排队占位`);
      }
    },
    // task 快照提交前验 sticky terminal（卸载后迟到回调也不复活）
    onTaskUpdate: (t) => {
      if (!canCommitTaskSnapshot(t.id)) return;
      onTaskUpdateRef.current(t);
    },
    onDone: (t) => {
      setStreamingText("");
      setLiveToolOutputs({});
      const remaining = pendingLocalRepliesRef.current.length;
      // done_clear 只清已有明确终态；无终态保持 uncertain/persisted
      if (
        remaining > 0 &&
        (t.runStatus === "idle" || t.runStatus === "error")
      ) {
        const result = dispatchChatOp(task.id, { type: "done_clear" });
        const n = (result.clearedIds ?? []).length;
        if (n > 0) {
          toast.message(
            `会话已结束，已清除 ${n} 条已确认终态的排队占位`,
          );
        }
      } else {
        const active = pendingLocalRepliesRef.current.filter(
          (p) => !shouldHideLocalPlaceholder(p),
        ).length;
        setQueuedCount(active > 0 ? active : null);
      }
      if (!canCommitTaskSnapshot(t.id)) return;
      onTaskUpdateRef.current(t);
    },
    onAssistantDelta: (text) => setStreamingText((prev) => prev + text),
    onErrorMessage: (msg) => toast.error(`Chat watch 出错：${msg}`),
    onWatchException: (err) => toast.error(`Chat watch 异常：${err.message}`),
    // task_deleted / watch 410 → 清 pending/streaming + ledger，再走统一 sink
    onTaskDeleted: (deletedId) => {
      setStreamingText("");
      setLiveToolOutputs({});
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

  // 用户回复：允许 running 时入队（P5）；返回 false = 失败（调用方保留草稿）
  const handleUserReply = useCallback(
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

      const registerOp = (itemId: string) => {
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
      setStreamingText("");
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
  }, [task.id]);

  const handleStop = useCallback(async () => {
    await stopAgentCore();
  }, [stopAgentCore]);

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

  // D 批次：排队条可点开小面板（列排队消息 + 行内删除 / 立即发送）、组件见 chat-queue-banner
  const queueBanner =
    queuedCount != null && queuedCount > 0 ? (
      <ChatQueueBanner task={task} queuedCount={queuedCount} />
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
          pendingLocalReplies={pendingForStream}
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
