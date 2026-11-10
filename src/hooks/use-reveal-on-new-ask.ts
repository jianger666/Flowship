"use client";

/**
 * 出现新的待回答提问时，若答题卡所在的栏被浏览器「放大」遮住，就把它还原（审核 R8-05 ①，判定见 lib/ask-reveal）。
 *
 * `isHidden` / `reveal` 都经 ref 读取最新值：调用方不用 useCallback 包它们，也不会因为它们的引用变化重跑 effect——
 * effect 只由 `askId` 变化驱动（上升沿检测）。首次渲染时已经在等的提问不算新（prevRef 以首次的 askId 起步）。
 */

import { useEffect, useRef } from "react";

import { shouldRevealForNewAsk } from "@/lib/ask-reveal";

export const useRevealOnNewAsk = (
  askId: string | null,
  isHidden: () => boolean,
  reveal: () => void,
): void => {
  const isHiddenRef = useRef(isHidden);
  isHiddenRef.current = isHidden;
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const prevAskIdRef = useRef(askId);

  useEffect(() => {
    const prev = prevAskIdRef.current;
    prevAskIdRef.current = askId;
    if (shouldRevealForNewAsk(prev, askId, isHiddenRef.current())) revealRef.current();
  }, [askId]);
};
