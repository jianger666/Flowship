"use client";

/**
 * ChatView：chat 模式 task 详情布局（V0.6.0.1 重新引入、对齐 V0.5 体验）
 *
 * 跟正经 task 模式（page.tsx 的 ResizablePanelGroup）的区别：
 *   - 不展示 ActionTimeline / ArtifactPanel / ContextDocs / MCP 面板 / repo / branch / role
 *   - 不展示推进 / 再聊聊 / 通过 / 终结 / 删除按钮（chat 就是临时聊、删除走首页卡片入口）
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

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AskUserDialog } from "@/components/tasks/ask-user-dialog";
import { EventStream } from "@/components/tasks/event-stream";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { prepareRunArgs } from "@/lib/run-args";
import { RUN_STATUS_LABEL, RUN_STATUS_VARIANT } from "@/lib/task-display";
import { sendChatReply, type ImagePayload } from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";

interface Props {
  task: Task;
  // 父组件持 task state、ChatView 把最新 task / event 推回去（SSE 增量驱动）
  onTaskUpdate: (next: Task) => void;
  onEventAppend: (ev: TaskEvent) => void;
}

export const ChatView = ({
  task,
  onTaskUpdate,
  onEventAppend,
}: Props) => {
  // 流式打字态：SDK 推 assistant chunk → 累加到这；收到正式 assistant_message → 清空
  // 切 task.id 也要清、避免上个任务的 streaming 串到新任务
  const [streamingText, setStreamingText] = useState("");
  // 本地「提交中」标记：sendChatReply 飞行期间 disable 输入框、防双击
  // 区别于 task.runStatus="running"（agent 在说话）、这个是请求飞行中、通常 < 1s
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 把 callback ref 化、避免 SSE effect 因为父组件 re-render 反复重连
  const onTaskUpdateRef = useRef(onTaskUpdate);
  const onEventAppendRef = useRef(onEventAppend);
  onTaskUpdateRef.current = onTaskUpdate;
  onEventAppendRef.current = onEventAppend;

  // 切 task 时把 streaming / submitting 重置
  useEffect(() => {
    setStreamingText("");
    setIsSubmitting(false);
  }, [task.id]);

  useTaskWatch(task.id, {
    onEvent: (ev) => {
      // 收到正式 assistant_message 事件：清掉 streaming placeholder、避免「placeholder + 正式卡片」重影
      if (ev.kind === "assistant_message") setStreamingText("");
      onEventAppendRef.current(ev);
    },
    onTaskUpdate: (t) => onTaskUpdateRef.current(t),
    onDone: (t) => {
      setStreamingText("");
      onTaskUpdateRef.current(t);
    },
    onAssistantDelta: (text) => setStreamingText((prev) => prev + text),
    onErrorMessage: (msg) => toast.error(`Chat watch 出错：${msg}`),
    onWatchException: (err) => toast.error(`Chat watch 异常：${err.message}`),
  });

  // 用户回复：无论 task.runStatus 是什么、统一走 sendChatReply
  // 后端 chat-reply 路由按 runStatus + hasPending 自己决定：
  //   - awaiting_user：解 wait_for_user（正常回合）
  //   - idle / error / completed：bootArgs 启 agent + 投递首条
  // 前端为最简化、永远附 bootArgs（后端用得上就用、用不上就忽略）
  const handleUserReply = useCallback(
    async (text: string, images?: ImagePayload[], attachments?: string[]) => {
      if (task.runStatus === "running") {
        toast.warning("agent 正在回、等它先说完一段");
        return;
      }

      const args = prepareRunArgs(task);
      if (!args) return;

      setIsSubmitting(true);
      try {
        const { task: latest, autoStarted } = await sendChatReply(
          task.id,
          text,
          images,
          attachments,
          {
            apiKey: args.apiKey,
            model: args.model,
          },
        );
        onTaskUpdateRef.current(latest);
        if (autoStarted) {
          toast.info("正在启动 agent、首条消息会在它就位后自动回复");
        }
      } catch (err) {
        toast.error(`回复失败：${(err as Error).message}`);
      } finally {
        setIsSubmitting(false);
      }
    },
    [task],
  );

  // 输入框可用条件
  // - running：agent 在说话、disable
  // - isSubmitting：请求飞行中、disable 防双击
  // - 其它（idle / awaiting_user / error）：开放
  const canReply = task.runStatus !== "running" && !isSubmitting;

  // disabled 时输入框 placeholder
  const disabledHint = (() => {
    if (isSubmitting) return "正在发送、稍候";
    if (task.runStatus === "running") return "agent 正在思考、稍候";
    return undefined;
  })();

  // 顶部状态条文案
  const statusHint = (() => {
    if (isSubmitting) return "正在发送消息...";
    if (task.runStatus === "running") {
      return "agent 正在回、等它先说完一段";
    }
    if (task.runStatus === "awaiting_user") {
      return "agent 在等你回复、随时输入";
    }
    if (task.runStatus === "error") {
      return "上一轮 agent 异常退出、再发一条可重启新一轮 run";
    }
    return "直接在底部输入框开始对话、agent 会自动启动（整段对话 SDK 计费一次跑到底）";
  })();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* 顶部 bar：title + 状态 badge + 进行中转圈、不放任何动作按钮（删除走首页卡片） */}
      <div className="border-b bg-card/40 px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">
                {task.title}
              </h1>
              <Badge variant="outline" className="text-[10px]">
                对话
              </Badge>
              {task.runStatus !== "idle" && (
                <Badge
                  variant={RUN_STATUS_VARIANT[task.runStatus]}
                  className="text-[10px]"
                >
                  {RUN_STATUS_LABEL[task.runStatus]}
                </Badge>
              )}
            </div>
          </div>

          {task.runStatus === "running" && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              AI 正在回
            </div>
          )}
        </div>
        {/* 状态条文案：始终展示、用户能看到当前阶段 */}
        <div className="mt-1 text-xs text-muted-foreground">{statusHint}</div>
      </div>

      <Separator />

      {/* 中间区：EventStream + 底部输入框 */}
      <div className="min-h-0 flex-1">
        <EventStream
          task={task}
          streamingText={streamingText}
          onUserReply={handleUserReply}
          canReply={canReply}
          disabledHint={disabledHint}
        />
      </div>

      {/* agent 误调 ask_user 时兜底（chat 模式 prompt 已禁、走这里基本不该发生） */}
      <AskUserDialog task={task} />
    </div>
  );
};
