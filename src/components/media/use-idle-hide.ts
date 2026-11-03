"use client";

/**
 * 「鼠标几秒没动就收控件」的计时器（全屏用）。
 *
 * - `active` 为 false（非全屏）时不计时、`idle` 恒为 false；
 * - active 期间：鼠标真的动了（坐标变化）/ 按任意键 / 点击 → 立刻醒来并重新计时，ms 毫秒没动 → idle = true；
 * - 返回的 `wake` 可手动唤醒（比如从别处弹出菜单后）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isRealPointerMove } from "@/lib/media/media-chrome";

export const useIdleHide = (
  active: boolean,
  ms: number,
): { idle: boolean; wake: () => void; onPointerMove: (e: { clientX: number; clientY: number }) => void } => {
  const [idle, setIdle] = useState(false);
  const timerRef = useRef<number | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    clear();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setIdle(true);
    }, ms);
  }, [clear, ms]);

  const onPointerMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const next = { x: e.clientX, y: e.clientY };
      if (!isRealPointerMove(lastPosRef.current, next)) return;
      lastPosRef.current = next;
      wake();
    },
    [wake],
  );

  useEffect(() => {
    if (!active) {
      clear();
      lastPosRef.current = null;
      setIdle(false);
      return;
    }
    wake();
    window.addEventListener("keydown", wake, true);
    window.addEventListener("pointerdown", wake, true);
    return () => {
      clear();
      window.removeEventListener("keydown", wake, true);
      window.removeEventListener("pointerdown", wake, true);
    };
  }, [active, wake, clear]);

  return { idle, wake, onPointerMove };
};
