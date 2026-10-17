"use client";

import { useCallback, useRef, useState } from "react";

/**
 * 截取终点别落在代理对（emoji / 生僻字）中间：UTF-16 下一个 emoji 占两个码元，
 * 按码元硬切会让上屏的那一帧出现半个字符（渲染成 �），下一帧才补全——吐字时 emoji 一闪一闪。
 * 终点前一个码元是高位代理就多带一个（低位代理）；已经到末尾则不动（流还没把后半个送来时，
 * 末尾的半个字符由下一帧补齐，这里不越界）。
 */
export const safeSliceEnd = (text: string, end: number): number => {
  if (end <= 0 || end >= text.length) return end;
  const prev = text.charCodeAt(end - 1);
  return prev >= 0xd800 && prev <= 0xdbff ? end + 1 : end;
};

/**
 * Codex 式丝滑吐字（chat-view / 任务详情页共用）。
 *
 * 三层管线：
 *  1. SSE 帧先进 pendingDeltaRef，rAF 合帧攒字；
 *  2. 攒好的字追加进目标串 targetRef；
 *  3. 平滑追赶循环按帧推进「已显示长度」：突发大段指数加速追上（~0.12/帧）、
 *     滴流保底 2 字/帧不卡住——视觉上从「一坨坨蹦」变成连续流出。
 */
export const useSmoothStreaming = () => {
  const [streamingText, setStreamingText] = useState("");
  const pendingDeltaRef = useRef("");
  const streamingTargetRef = useRef("");
  const displayedLenRef = useRef(0);
  const deltaRafRef = useRef<number | null>(null);
  const smoothRafRef = useRef<number | null>(null);

  const smoothTick = useCallback(() => {
    const target = streamingTargetRef.current;
    const remaining = target.length - displayedLenRef.current;
    if (remaining <= 0) {
      smoothRafRef.current = null;
      return;
    }
    const step = Math.max(2, Math.ceil(remaining * 0.12));
    displayedLenRef.current = safeSliceEnd(
      target,
      Math.min(target.length, displayedLenRef.current + step),
    );
    setStreamingText(target.slice(0, displayedLenRef.current));
    smoothRafRef.current =
      displayedLenRef.current < target.length
        ? requestAnimationFrame(smoothTick)
        : null;
  }, []);

  /** onAssistantDelta 入口：攒帧 → 追加目标 → 确保追赶循环在跑 */
  const pushDelta = useCallback(
    (text: string) => {
      pendingDeltaRef.current += text;
      if (deltaRafRef.current == null) {
        deltaRafRef.current = requestAnimationFrame(() => {
          deltaRafRef.current = null;
          const chunk = pendingDeltaRef.current;
          if (!chunk) return;
          pendingDeltaRef.current = "";
          streamingTargetRef.current += chunk;
          // 目标变长即确保追赶循环在跑（已在跑则不动）
          if (smoothRafRef.current == null) {
            smoothRafRef.current = requestAnimationFrame(smoothTick);
          }
        });
      }
    },
    [smoothTick],
  );

  /** 清流式态的唯一入口：同步丢弃未上屏的残留 + 取消所有未决 rAF */
  const clearStreaming = useCallback(() => {
    for (const ref of [deltaRafRef, smoothRafRef]) {
      if (ref.current != null) {
        cancelAnimationFrame(ref.current);
        ref.current = null;
      }
    }
    pendingDeltaRef.current = "";
    streamingTargetRef.current = "";
    displayedLenRef.current = 0;
    setStreamingText("");
  }, []);

  return { streamingText, pushDelta, clearStreaming };
};
