"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { planAssistantSnapshot, type AssistantSnapshot } from "@/lib/assistant-live";

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
 * 回到前台时的追赶规划：后台期间 rAF 暂停、SSE 照常到——字都攒在合帧队列 / 目标串里，已显示长度停在离开那一刻。
 * 回来后若按平滑追赶走，用户要看一秒多的「补打字」（评审 N6；思考侧 use-smooth-thinking 早就有对应的前台快进）。
 * 没在看的时候长出来的字不用演：把队列并进目标串、已显示长度直接跳到末尾。
 * `changed=false` = 本来就追平了（不需要动、也不要 setState）。纯函数、有单测。
 */
export const planForegroundCatchUp = (
  target: string,
  pending: string,
  displayedLen: number,
): { target: string; changed: boolean } => {
  const full = pending ? target + pending : target;
  return { target: full, changed: displayedLen < full.length };
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

  // 回到前台：没在看的时候攒下的字直接上屏，不演「补打字」（规则见 planForegroundCatchUp）。
  // 挂 document、只在可见时处理；卸载时摘掉同一个处理函数
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const plan = planForegroundCatchUp(
        streamingTargetRef.current,
        pendingDeltaRef.current,
        displayedLenRef.current,
      );
      if (!plan.changed) return;
      for (const ref of [deltaRafRef, smoothRafRef]) {
        if (ref.current != null) {
          cancelAnimationFrame(ref.current);
          ref.current = null;
        }
      }
      pendingDeltaRef.current = "";
      streamingTargetRef.current = plan.target;
      displayedLenRef.current = plan.target.length;
      setStreamingText(plan.target);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

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

  /**
   * 每次（重）连接 bootstrap 的「进行中正文」快照（assistant_snapshot 帧）：
   *  - null / 空 = 此刻没有进行中的正文：清掉本地残留（断线期间这段已经落盘了）；
   *  - 新挂载（切走再切回、本地什么都没有）：整段直接铺上、不逐字动画——用户要的是立刻看到已生成的全部；
   *  - 同页重连、本地已收到的是快照前缀：保留已上屏长度、只补尾巴（吐字动画接着走、不闪空）；
   *  - 已经一致：不动。合并规则在 lib/assistant-live.planAssistantSnapshot（纯函数、有单测）。
   * 快照之后的实时帧由服务端排在它后面回放，所以这里「整段替换 / 补尾巴」之后接着 pushDelta 不重不漏。
   */
  const applySnapshot = useCallback(
    (snap: AssistantSnapshot | null) => {
      const plan = planAssistantSnapshot(
        // 「已收到」= 已并入目标串的 + 还在 rAF 合帧队列里的
        streamingTargetRef.current + pendingDeltaRef.current,
        snap,
      );
      if (plan.kind === "keep") return;
      if (plan.kind === "clear") {
        clearStreaming();
        return;
      }
      // extend / replace 都要先丢掉合帧队列：它里面的字已经包含在快照里了，留着会重复一遍
      if (deltaRafRef.current != null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      pendingDeltaRef.current = "";
      streamingTargetRef.current = plan.target;
      if (plan.kind === "replace") {
        if (smoothRafRef.current != null) {
          cancelAnimationFrame(smoothRafRef.current);
          smoothRafRef.current = null;
        }
        displayedLenRef.current = plan.target.length;
        setStreamingText(plan.target);
        return;
      }
      // extend：已上屏长度不动，目标变长 → 确保追赶循环在跑
      if (smoothRafRef.current == null) {
        smoothRafRef.current = requestAnimationFrame(smoothTick);
      }
    },
    [smoothTick, clearStreaming],
  );

  return { streamingText, pushDelta, applySnapshot, clearStreaming };
};
