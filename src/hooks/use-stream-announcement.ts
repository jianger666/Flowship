"use client";

import { useEffect, useRef, useState } from "react";

import {
  deriveAnnouncements,
  maxEventSeq,
  nextReplyTimerAction,
  REPLY_ANNOUNCE_QUIET_MS,
  REPLY_ANNOUNCEMENT,
} from "@/lib/stream-announce";
import type { TaskEvent } from "@/lib/types";

export interface StreamAnnouncementState {
  /** 递增 id：播报区用它做 key，连续两条同文案（比如两次一样的错误）也能再播一次 */
  id: number;
  text: string;
}

const EMPTY: StreamAnnouncementState = { id: 0, text: "" };

/**
 * 事件流关键事件播报（V14-01）：挂载 / 切任务那一刻已有的事件是基线、不播；
 * 之后新增的失败 / 待答 / 完成才播（规则见 lib/stream-announce.ts）。
 *
 * 基线放 ref（不触发渲染），只有「这批有话要说」时才 setState，所以普通过程事件不会多一次渲染。
 */
export const useStreamAnnouncement = (
  taskId: string,
  events: readonly TaskEvent[],
  isChat: boolean,
): StreamAnnouncementState => {
  const baselineRef = useRef<{ taskId: string; seq: number } | null>(null);
  const [announcement, setAnnouncement] = useState<StreamAnnouncementState>(EMPTY);
  // 「AI 有新回复」的 trailing 计时器（Q8-05）：最后一条回复之后静默一段时间才念
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReplyTimer = () => {
    if (replyTimerRef.current) {
      clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
    }
  };
  // 卸载时清掉，避免离开页面后还念
  useEffect(() => clearReplyTimer, []);

  useEffect(() => {
    // 挂载 / 详情页内切任务：把此刻已有的事件当基线，这一轮不播
    if (!baselineRef.current || baselineRef.current.taskId !== taskId) {
      baselineRef.current = { taskId, seq: maxEventSeq(events) };
      // 上一个任务留下的最后一句（含还没到点的「新回复」）不能挂在新任务的播报区里
      clearReplyTimer();
      setAnnouncement(EMPTY);
      return;
    }
    const derived = deriveAnnouncements(baselineRef.current.seq, events, {
      isChat,
    });
    baselineRef.current.seq = derived.nextSeq;
    // 失败 / 待答 / 完成：立刻播
    if (derived.urgentText) {
      setAnnouncement((prev) => ({ id: prev.id + 1, text: derived.urgentText }));
    }
    // 「AI 有新回复」：trailing 节流——最后一条回复之后静默 REPLY_ANNOUNCE_QUIET_MS 才播；
    // 期间又来了工具往返（那条回复只是叙述句）就取消
    const action = nextReplyTimerAction(derived, replyTimerRef.current !== null);
    if (action === "cancel") {
      clearReplyTimer();
    } else if (action === "restart") {
      clearReplyTimer();
      replyTimerRef.current = setTimeout(() => {
        replyTimerRef.current = null;
        setAnnouncement((prev) => ({ id: prev.id + 1, text: REPLY_ANNOUNCEMENT }));
      }, REPLY_ANNOUNCE_QUIET_MS);
    }
  }, [taskId, events, isChat]);

  return announcement;
};
