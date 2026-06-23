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
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { AskUserDialog } from "@/components/tasks/ask-user-dialog";
import { ChatModelPicker } from "@/components/tasks/chat-model-picker";
import { ChatBranchPicker } from "@/components/tasks/chat-branch-picker";
import { ChatWorkdirPicker } from "@/components/tasks/chat-workdir-picker";
import { EventStream } from "@/components/tasks/event-stream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTaskWatch } from "@/hooks/use-task-watch";
import { useDialog } from "@/hooks/use-dialog";
import { prepareRunArgs } from "@/lib/run-args";
import { RUN_STATUS_LABEL, RUN_STATUS_VARIANT } from "@/lib/task-display";
import {
  sendChatReply,
  stopTask,
  updateTaskFields,
  type ImagePayload,
} from "@/lib/task-store";
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
  // SSE 重连 epoch：agent 上一轮 done 后 SSE 会 close、自动重连不处理 done（靠这个 key）；
  // 用户再发消息自动启新 agent 时 ++、触发 useTaskWatch 重连、否则收不到新一轮事件（V0.6.12 修）
  const [watchEpoch, setWatchEpoch] = useState(0);
  // 「停止」按钮提交锁——中断 running 的 chat agent 期间禁用、防连点
  const [stopping, setStopping] = useState(false);

  // 全局 prompt 弹窗（重命名对话用）
  const { prompt } = useDialog();

  // 把 callback ref 化、避免 SSE effect 因为父组件 re-render 反复重连
  const onTaskUpdateRef = useRef(onTaskUpdate);
  const onEventAppendRef = useRef(onEventAppend);
  onTaskUpdateRef.current = onTaskUpdate;
  onEventAppendRef.current = onEventAppend;

  // 切 task 时把 streaming / submitting / stopping 重置
  useEffect(() => {
    setStreamingText("");
    setIsSubmitting(false);
    setStopping(false);
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
    // enabled=true 恒开；reconnectKey=watchEpoch 让「自动启新 agent」后能重连 SSE
  }, true, watchEpoch);

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
          // 起手 loading 行由 EventStream 按「最后一条是用户消息 + running」渲染（取代旧 toast）
          // 上一轮 agent done 后 SSE 已断、++ 触发重连、才能收到新一轮 agent 的事件流
          setWatchEpoch((n) => n + 1);
        }
      } catch (err) {
        toast.error(`回复失败：${(err as Error).message}`);
      } finally {
        setIsSubmitting(false);
      }
    },
    [task],
  );

  // 停止当前正在跑的 chat agent
  // chat 打断生成是高频低风险操作（chat 不改代码、只聊 / 答疑）、不弹二次确认、即点即停
  // 走通用 /stop：后端 cancelChatRun 停 runningChats + runStatus 回 idle
  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      const latest = await stopTask(task.id);
      setStreamingText(""); // 清掉打字机 placeholder、避免半截 streaming 残留
      onTaskUpdateRef.current(latest);
    } catch (err) {
      toast.error(`停止失败：${(err as Error).message}`);
    } finally {
      setStopping(false);
    }
  }, [task.id]);

  // 重命名对话：chat 模式去掉了新建弹窗、这个是唯一改名入口
  // 走通用 prompt 拿新名 → PATCH 落盘 → 回填最新 task（复用 task 模式的 updateTaskFields）
  const handleRename = useCallback(async () => {
    const next = await prompt({
      title: "重命名对话",
      defaultValue: task.title,
      placeholder: "对话名称",
      validate: (v) => (v.trim() ? "" : "名称不能为空"),
    });
    // null=取消；与原名相同省去一次请求
    if (next === null || next === task.title) return;
    try {
      const updated = await updateTaskFields(task.id, { title: next });
      onTaskUpdateRef.current(updated);
    } catch (err) {
      toast.error(`重命名失败：${(err as Error).message}`);
    }
  }, [prompt, task.id, task.title]);

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

  // 顶部状态条文案——只在「异常」时常驻一行（V0.7.21：运行态已收进输入岛的 loading + 红停止键、
  // 发送态 < 1s、空闲 / 等待是常态、都不值得在标题下常驻占行）
  const statusHint = (() => {
    if (task.runStatus === "error") {
      return "上一轮 agent 异常退出、再发一条可重启新一轮 run";
    }
    return null;
  })();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* 顶部 bar：返回 + title + 状态 badge + 进行中转圈、不放任何动作按钮（删除走首页卡片）
          V0.7.11：轻量化——无底色、状态文案只在异常 / 进行中出现（不常驻占行） */}
      <div className="border-b px-6 py-2.5">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-medium tracking-tight">
                {task.title}
              </h1>
              {/* 重命名：chat 模式没有编辑弹窗、这个铅笔是唯一改名入口 */}
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
        {/* 状态条文案：仅异常 / 发送中显示 */}
        {statusHint && (
          <div className="mt-1 w-full text-xs text-muted-foreground">
            {statusHint}
          </div>
        )}
      </div>

      {/* 中间区：EventStream（chat 形态：窄列对话流 + 圆角输入岛）+ 底部输入框 */}
      <div className="min-h-0 flex-1">
        <EventStream
          task={task}
          variant="chat"
          streamingText={streamingText}
          onUserReply={handleUserReply}
          canReply={canReply}
          disabledHint={disabledHint}
          isRunning={task.runStatus === "running"}
          onStop={handleStop}
          stopping={stopping}
          composerLeading={
            <ChatModelPicker task={task} onTaskUpdate={onTaskUpdate} />
          }
          composerTop={
            <>
              <ChatWorkdirPicker task={task} onTaskUpdate={onTaskUpdate} />
              <ChatBranchPicker task={task} />
            </>
          }
        />
      </div>

      {/* agent 误调 ask_user 时兜底（chat 模式 prompt 已禁、走这里基本不该发生） */}
      <AskUserDialog task={task} />
    </div>
  );
};
