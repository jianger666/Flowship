"use client";

/**
 * Chat 模式整页视图（V0.4 自由化版）
 *
 * 跟 plan 模式的「3 区布局（产物左 / 事件流右）」不同：
 * chat 模式没有产物概念、整段对话就是事件流本身、所以整页都给事件流。
 *
 * 复用 EventStream 组件、它已经处理好：
 *   - 智能置底（用户往上滚就不强制）
 *   - 思考事件合并
 *   - 各类事件的 icon / 颜色
 *   - HITL 输入框（chat 模式 canReply 由父组件传、不限定 awaiting_user）
 *
 * V0.4 自由化（用户拍板 2026-05-15）：
 *   - 删「启动 Chat」按钮 + /api/tasks/:id/start-chat 路由：合并到 /chat-reply
 *   - 任意状态下用户发消息都走 sendChatReply、后端按 status 决定要不要自动启 agent：
 *     - awaiting_user：正常对话回合（submitUserMessage 解 wait_for_user）
 *     - draft/completed/failed：自动启 agent + 把首条消息直接拼进 initialPrompt
 *       agent 第一次 turn 就回答用户首条、答完调 wait_for_user 进等待
 *   - 建任务时不强制填首条 / 仓库、整流程「建任务 → 输入 → 回复」三步搞定
 *
 * 状态机（前端视角）：
 *   - draft：输入框开、用户发消息 → 后端切 status=running + 启 agent → SSE 推回 awaiting_user
 *   - awaiting_user：输入框开、用户发消息 → 后端切 status=running → SSE 推回 awaiting_user
 *   - running：agent 正在说话、输入框 disable
 *   - completed / failed：输入框开、用户发消息 = 自动重启新一轮 SDK Run
 *
 * 架构：
 *   - 进入页面立即 watchChatStream（GET SSE）、无论任务什么状态、都先订阅
 *   - 输入框可用状态完全由 task.status 决定（+ isSubmitting 防双击）
 *   - 刷新页面 / 多 tab / 关浏览器再回来都能正确恢复 UI 状态
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { EventStream } from "@/components/tasks/event-stream";
import { Separator } from "@/components/ui/separator";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { prepareRunArgs } from "@/lib/run-args";
import {
  sendChatReply,
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
  // 流式打字态：SDK 推 assistant chunk → 累加到这；收到 assistant_message 事件 → 清空（被正式事件取代）
  // 切 task.id 也要清、避免上个任务的 streaming 串到新任务
  const [streamingText, setStreamingText] = useState("");
  // 本地「提交中」标记：sendChatReply 网络调用期间 disable 输入框、防双击 + 视觉反馈
  // 区别于 task.status="running"（后者是 agent 在说话）、这个是「请求飞行中」、通常 < 1s
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 把 callback ref 化、避免 watch effect 因为父组件 re-render 反复重连
  const onTaskUpdateRef = useRef(onTaskUpdate);
  const onEventAppendRef = useRef(onEventAppend);
  onTaskUpdateRef.current = onTaskUpdate;
  onEventAppendRef.current = onEventAppend;

  // 切 task 时把 streaming / submitting 重置（避免旧 buffer 串到新任务）
  useEffect(() => {
    setStreamingText("");
    setIsSubmitting(false);
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

  // 用户回复：无论 task.status 是什么、统一走 sendChatReply
  // 后端 chat-reply 路由根据 status 自己决定：
  //   - awaiting_user：解 wait_for_user（正常回合）
  //   - draft/completed/failed：bootArgs 启 agent + 队列首条（自动启动）
  // 前端为最简化、永远附 bootArgs（后端用得上就用、用不上就忽略）
  const handleUserReply = useCallback(
    async (
      text: string,
      images?: ChatReplyImage[],
      attachments?: string[],
    ) => {
      // running 状态不应该走到这（UI 已 disable 输入）、防御性兜底
      if (task.status === "running") {
        toast.warning("agent 正在说话、等它先说完一段");
        return;
      }

      // prepareRunArgs 从 settings 拿 apiKey/model + 按 task 黑名单过滤 mcpServers
      // 失败（缺 apiKey/model）会自己 toast、这里直接 return
      const args = prepareRunArgs(task);
      if (!args) return;

      setIsSubmitting(true);
      try {
        const { task: latest, autoStarted } = await sendChatReply(
          task.id,
          text,
          images,
          attachments,
          // 永远传 bootArgs：后端在 awaiting_user 时不看、终态时才用
          {
            apiKey: args.apiKey,
            model: args.model,
            mcpServers: args.mcpServers,
          },
        );
        onTaskUpdateRef.current(latest);
        if (autoStarted) {
          // 终态发消息触发了自动启动：提示用户「在启动 agent」
          // task.status 已经从后端切到 running、UI 自动 disable 输入框
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

  // V0.4：输入框可用条件
  // - running：agent 在说话、disable
  // - isSubmitting：网络请求飞行中、disable 防双击
  // - 其它（draft / awaiting_user / completed / failed）：开放
  const canReply = task.status !== "running" && !isSubmitting;

  // disabled 时输入框 placeholder + 底部状态文案
  const disabledHint = (() => {
    if (isSubmitting) return "正在发送、稍候";
    if (task.status === "running") return "agent 正在思考、稍候";
    return undefined;
  })();

  // 顶部状态条文案（V0.4 删启动按钮、纯文案告知当前状态）
  const statusHint = (() => {
    if (isSubmitting) return "正在发送消息...";
    if (task.status === "draft") {
      return "直接在底部输入框开始对话、agent 会自动启动（整段对话 SDK 计费一次跑到底）";
    }
    if (task.status === "running") {
      return "agent 正在思考、等它先说完一段";
    }
    if (task.status === "awaiting_user") {
      return "agent 在等你回复、随时输入";
    }
    if (task.status === "completed") {
      return "对话已结束。再发一条消息可继续聊、SDK 会按新一次 run 计费";
    }
    if (task.status === "failed") {
      return "Chat agent 异常退出。再发一条消息可自动重启新一轮 run";
    }
    return null;
  })();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* chat 顶部状态条：V0.4 删启动按钮、纯文案提示 */}
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <div className="text-xs text-muted-foreground">{statusHint}</div>
      </div>
      <Separator />
      {/* 整段事件流撑满主区 */}
      <div className="min-h-0 flex-1">
        <EventStream
          task={task}
          streamingText={streamingText}
          canReply={canReply}
          disabledHint={disabledHint}
          onUserReply={handleUserReply}
        />
      </div>
    </div>
  );
};
