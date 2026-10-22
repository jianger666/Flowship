"use client";

/**
 * 事件流的屏幕阅读器播报区（V14-01 + V16-10）。
 *
 * 为什么单拎一个组件、放在列表外：
 *   - 事件流是虚拟列表，卡片每次滚进视口都会重新挂载——live region 贴在卡片上会反复播报
 *     （error-card.tsx 头注释的禁令是对的，所以事件流目录里仍然没有任何 live 属性）。
 *   - 这里是挂载一次、一直在的 `sr-only` 区，只在内容**变化**时才被读屏播报。
 *
 * 里面两格，各管各的：
 *   1. 状态行 label（「思考中」「正在运行 shell」…）——只放 label，不放秒数：
 *      秒数逐秒走字，放进来会每秒播一次。可见的 ActiveStatusLine 不是 live region，
 *      所以走字也不会被念。
 *   2. 最近一次关键事件（失败 / 待答 / 完成，规则与基线去重见 lib/stream-announce.ts）。
 *      用递增 id 做 key：连续两条同文案也算「新增节点」、会再播一次。
 *
 * `aria-atomic="false"`：role=status 默认 atomic=true，那样 label 一变就会把整块
 * （含上一条早已播过的关键事件）重念一遍；false 只念变化的那一格。
 */

import { memo } from "react";

import { useStreamAnnouncement } from "@/hooks/use-stream-announcement";
import { announceStatusPresence } from "@/lib/stream-announce";
import type { TaskEvent } from "@/lib/types";

interface StreamAnnouncerProps {
  taskId: string;
  events: readonly TaskEvent[];
  isChat: boolean;
  /** 状态行当前 label；没在跑 = 空串 */
  statusLabel: string;
}

const StreamAnnouncerImpl = ({
  taskId,
  events,
  isChat,
  statusLabel,
}: StreamAnnouncerProps) => {
  const announcement = useStreamAnnouncement(taskId, events, isChat);
  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {/* Q8-05：只在「空 ↔ 非空」间切换，阶段细节（工具名 / 思考 / 等待）不进播报 */}
      <span>{announceStatusPresence(statusLabel)}</span>
      <span key={announcement.id}>{announcement.text}</span>
    </div>
  );
};

export const StreamAnnouncer = memo(StreamAnnouncerImpl);
