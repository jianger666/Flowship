"use client";

/**
 * Chat 模式整页视图
 *
 * 跟 plan 模式的「3 区布局（产物左 / 事件流右）」不同：
 * chat 模式没有产物概念、整段对话就是事件流本身、所以整页都给事件流。
 *
 * 复用 EventStream 组件、它已经处理好：
 *   - 智能置底（用户往上滚就不强制）
 *   - 思考事件合并
 *   - 各类事件的 icon / 颜色
 *   - HITL 输入框（task.status === "awaiting_user" 时激活）
 *
 * 架构（v2）：
 *   - 进入页面立即 watchChatStream（GET SSE）、无论任务什么状态、都先订阅
 *   - watch 第一帧会 push 当前 task + 全部历史 events、跟服务端对齐
 *   - 「启动 Chat」按钮只调 POST /start-chat（启动 + 立即返回）、不参与 SSE 消费
 *   - 这样刷新页面 / 多 tab / 关浏览器再回来都能正确恢复 UI 状态
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";

import { EventStream } from "@/components/tasks/event-stream";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { prepareRunArgs } from "@/lib/run-args";
import {
  sendChatReply,
  startChat,
  type ChatReplyImage,
} from "@/lib/task-store";
import type { Task } from "@/lib/types";

interface Props {
  task: Task;
  // 由父组件传进来、ChatView 通过它把最新 task / event 推回去
  onTaskUpdate: (next: Task) => void;
  onEventAppend: (ev: Task["events"][number]) => void;
}

export const ChatView = ({ task, onTaskUpdate, onEventAppend }: Props) => {
  const [starting, setStarting] = useState(false);
  // 流式打字态：SDK 推 assistant chunk → 累加到这；收到 assistant_message 事件 → 清空（被正式事件取代）
  // 切 task.id 也要清、避免上个任务的 streaming 串到新任务
  const [streamingText, setStreamingText] = useState("");
  // 把 callback ref 化、避免 watch effect 因为父组件 re-render 反复重连
  const onTaskUpdateRef = useRef(onTaskUpdate);
  const onEventAppendRef = useRef(onEventAppend);
  onTaskUpdateRef.current = onTaskUpdate;
  onEventAppendRef.current = onEventAppend;

  // ---- 自动 watch：进页面立即订阅、任务终止 / 卸载 / id 切换才断 ----
  // 切 task 时把 streaming 重置（避免旧 buffer 串到新任务、罕见 case 但很难 debug）
  useEffect(() => {
    setStreamingText("");
  }, [task.id]);

  useTaskWatch(task.id, {
    onEvent: (ev) => {
      // 当 flush 后的正式 assistant_message 事件到达：清掉 streaming placeholder
      // 避免「placeholder + 正式卡片」两段同时出现的重影
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

  // ---- 启动按钮：只调 POST /start-chat、SSE 由上面的 useTaskWatch 持续接管 ----
  const handleStart = useCallback(async () => {
    const args = prepareRunArgs(task);
    if (!args) return;

    setStarting(true);
    try {
      const { task: latest, already } = await startChat(
        task.id,
        args.apiKey,
        args.model,
        args.mcpServers,
      );
      onTaskUpdateRef.current(latest);
      if (already) {
        toast.info("Chat 任务已在跑、已为你接上事件流");
      } else {
        toast.success("Chat 任务已启动、agent 全程长存活、计费一次跑到底");
      }
    } catch (err) {
      toast.error(`启动失败：${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
    // task 整体进依赖：prepareRunArgs 内部要读 task.disabledMcpServers
    // 用户在 task-mcp-panel 里改了黑名单后、点启动要拿到最新值
  }, [task]);

  // ---- 用户回复：HTTP POST chat-reply、SSE 那边自然能收到后续事件 ----
  // images：可选附图（粘贴 / 拖拽 / 选文件得到）、由后端校验 / 落盘 / 拼到 wait_for_user return
  // attachments：可选附路径（文件或目录绝对路径数组）、后端校验存在 / 拼到 wait_for_user return
  //   → agent 拿到后用 SDK read_file 自己读、不在这里上传内容
  const handleUserReply = useCallback(
    async (
      text: string,
      images?: ChatReplyImage[],
      attachments?: string[],
    ) => {
      try {
        const updated = await sendChatReply(task.id, text, images, attachments);
        onTaskUpdateRef.current(updated);
      } catch (err) {
        toast.error(`回复失败：${(err as Error).message}`);
      }
    },
    [task.id],
  );

  // 是否显示启动按钮：
  //   - draft（首次启动）
  //   - failed（异常崩了重启）
  //   - completed（agent 自然退出后用户想接着聊、注意会计费再算一次）
  // running / awaiting_user 不显示（agent 在跑）
  const canStart =
    task.status === "draft" ||
    task.status === "failed" ||
    task.status === "completed";

  // 启动按钮文案随状态变
  const startButtonLabel = (() => {
    if (starting) return "启动中...";
    if (task.status === "failed") return "重新启动 Chat";
    if (task.status === "completed") return "继续对话（计费再算一次）";
    return "启动 Chat";
  })();

  // 顶部状态条文案
  const statusHint = (() => {
    if (task.status === "draft") {
      return "Chat 任务尚未启动、点右侧按钮开始（agent 长存活、整段对话计费一次）";
    }
    if (task.status === "running") {
      return "agent 正在思考、等它先说完一段";
    }
    if (task.status === "awaiting_user") {
      return "agent 正在等你回复、消息发完会继续跑";
    }
    if (task.status === "completed") {
      return "对话已结束（agent 自然退出 / 任务取消）。点右侧按钮可继续对话、但会按 SDK 重新计费一次。";
    }
    if (task.status === "failed") {
      return "Chat 任务异常退出、点右侧按钮可重新启动";
    }
    return null;
  })();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* chat 顶部操作条：启动按钮 + 状态提示 */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <div className="text-xs text-muted-foreground">{statusHint}</div>
        {canStart && (
          <Button size="sm" onClick={handleStart} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" /> : <Zap />}
            {startButtonLabel}
          </Button>
        )}
      </div>
      <Separator />
      {/* 整段事件流撑满主区 */}
      <div className="min-h-0 flex-1">
        <EventStream
          task={task}
          streamingText={streamingText}
          onUserReply={handleUserReply}
        />
      </div>
    </div>
  );
};
