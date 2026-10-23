"use client";

/**
 * SmoothEventStream：把「平滑吐字」的逐帧 state 圈在事件流这一层（第二轮 review V11-07）。
 *
 * 为什么存在：useSmoothStreaming 靠 rAF 逐帧 setState。它原先写在 task 详情页组件里——
 * AI 一边吐字，**整个页面**（头部 / 时间线 / 产物栏 / 事件流）按帧重渲，产物栏里整篇 markdown
 * 也跟着被拖进 reconcile。把 hook 下沉到这里，逐帧重渲只发生在本组件 + EventStream（本来就要随吐字刷新）。
 *
 * 页面仍然是 SSE 的接收方（assistant_delta / 收到正式 assistant_message 时清流），
 * 所以通过 `controlsRef` 把 pushDelta / clearStreaming 命令式暴露出去——函数身份稳定、不引起页面重渲。
 * ChatView 仍直接用 useSmoothStreaming（它整页就是对话流，没有这个问题）。
 */

import { useImperativeHandle, type ComponentProps, type Ref } from "react";

import { EventStream } from "@/components/tasks/event-stream";
import { useSmoothStreaming } from "@/components/tasks/use-smooth-streaming";
import type { AssistantSnapshot } from "@/lib/assistant-live";

export interface SmoothStreamControls {
  /** SSE assistant_delta 入口 */
  pushDelta: (text: string) => void;
  /** SSE assistant_snapshot（每次连接 bootstrap 一帧）：整段铺上 / 补尾巴 / 清残留，见 useSmoothStreaming.applySnapshot */
  applySnapshot: (snap: AssistantSnapshot | null) => void;
  /** 清流式态的唯一入口（正式 assistant_message 到达 / 切 task / 被中断时） */
  clearStreaming: () => void;
}

type EventStreamProps = ComponentProps<typeof EventStream>;

// streamingText 由本组件自己产出，不接受外部传入——防止有人又把逐帧 state 提回页面
type Props = Omit<EventStreamProps, "streamingText"> & {
  controlsRef: Ref<SmoothStreamControls>;
};

export const SmoothEventStream = ({
  controlsRef,
  isRunning,
  ...streamProps
}: Props) => {
  const { streamingText, pushDelta, applySnapshot, clearStreaming } =
    useSmoothStreaming();
  useImperativeHandle(
    controlsRef,
    () => ({ pushDelta, applySnapshot, clearStreaming }),
    [pushDelta, applySnapshot, clearStreaming],
  );
  // isRunning 单独解构、显式透传：它是 EventStream 的必填 prop（漏传 = 运行中的工具全渲染成「已中断」），
  // tests/event-stream-run-active 逐个调用点检查它；Props 里它仍是必填，页面漏传会直接 tsc 报错
  return (
    <EventStream
      {...streamProps}
      isRunning={isRunning}
      streamingText={streamingText}
    />
  );
};
