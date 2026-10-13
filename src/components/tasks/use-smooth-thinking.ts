"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createRevealer } from "@/lib/smooth-reveal";
import {
  liveThinkingFloor,
  revealLiveThinking,
  skipLiveReveal,
  stepLiveReveal,
  type LiveThinking,
} from "@/lib/thinking-live";

/**
 * 思考吐字平滑（chat-view 用）：把服务端「250ms 一批」的实时思考，摊成逐帧匀速长出来的文本。
 *
 * 为什么需要（2026-10-12 用户反馈「正文吐字很丝滑、思考吐字很机械」）：
 * 正文一路有 use-smooth-streaming 兜着，而思考原来是 250ms 一批整块替换——
 * 每 0.25s 跳一下。这里在「到达」和「显示」之间加一层匀速推进（算法见 lib/smooth-reveal）。
 * 正文那一层 `max(2, 12%)/帧` 的追赶在这里不合适：一批几十字约 130ms 就吐完、再停约 120ms，
 * 等于把批次节奏原样画出来；所以思考用「按到达速率放字、积压只做缓慢修正」的推进——
 * 第一版的指数追赶（速度 = 积压 / τ）消掉了整块跳变，却把批次节奏换成了速度的锯齿
 * （「像开车加速又刹车又加速」），原因和现在的做法见 lib/smooth-reveal 的头注释。
 *
 * 两处「别从头来 / 别补演」（2026-10-13 用户反馈「首轮思考很长，切窗口再切回来又从第一个字开始吐」）：
 *  - 初始位置 = liveThinkingFloor（窗口起点与 base 取大），不是 0：快照重建的实时态（切回对话 /
 *    SSE 重连，见 chat-view 的 onThinkingSnapshot）里 base 之前的字是「已经看过的」，
 *    第一帧就整段显示，只有之后新到的字才演；
 *  - 标签页 / 窗口回到前台（visibilitychange）时位置直接跳到最新：后台期间 rAF 暂停、SSE 照常到，
 *    回来时积压几百上千字——不跳的话推进器会把它当大积压，先一帧刷出一大块、再以几倍于正常的
 *    速度滚几秒（浏览器实测：积压 2400 字，回前台 250ms 内跳 1560 字、之后高速追 5 秒）。
 *    没在看的时候长出来的字不用演。
 *
 * 分工：
 *  - 输入 `live`：chat-view 累积出来的实时态（每批变一次）；
 *  - state `revealed`：已显示到累计坐标的哪里（整数）。位置变了才 setState——低速时三帧才出一个字，
 *    其余帧不触发渲染；
 *  - rAF 循环：未追平就继续、追平就停；新一批到达时由 effect 重新点火；
 *  - 渲染期只从 state 派生（revealLiveThinking，纯函数、已单测），不读 ref。
 *
 * 不负责：整段思考结束 / 被打断时的清理（chat-view 把 `live` 置 null，本 hook 随之丢位置）。
 */
export const useSmoothThinking = (
  live: LiveThinking | null,
): LiveThinking | null => {
  // 带 id：换段时旧位置自动作废（渲染里比一下 id 即可，不用读 ref）
  const [revealed, setRevealed] = useState<{ id: string; len: number }>({
    id: "",
    len: 0,
  });
  const revealerRef = useRef(createRevealer());
  /** 最新的实时态：rAF 回调读它（回调不随每批重建） */
  const liveRef = useRef<LiveThinking | null>(null);
  /** 位置属于哪一段：变了就从头吐 */
  const segmentRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);

  /** 位置属于哪一段：换段了先把推进器归零（旧段的位置 / 速率估计对新段没有意义） */
  const syncSegment = useCallback((cur: LiveThinking) => {
    if (segmentRef.current === cur.id) return;
    revealerRef.current.reset();
    segmentRef.current = cur.id;
  }, []);

  const tick = useCallback(
    (now: number) => {
      rafRef.current = null;
      const cur = liveRef.current;
      if (!cur) return;
      syncSegment(cur);
      // 位置推进的全部规则（目标取累计总数、窗口截尾后位置跳到起点、是否追平）在 stepLiveReveal，
      // 已有行为测试；这里只剩 setState 和排下一帧
      const { len, done } = stepLiveReveal(revealerRef.current, cur, now);
      setRevealed((prev) =>
        prev.id === cur.id && prev.len === len ? prev : { id: cur.id, len },
      );
      if (!done) rafRef.current = requestAnimationFrame(tick);
    },
    [syncSegment],
  );

  // 每批新到达（live 换了对象）：登记最新目标，保证循环在跑；没在思考就丢掉位置与残留 rAF
  useEffect(() => {
    liveRef.current = live;
    if (!live) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      revealerRef.current.reset();
      segmentRef.current = null;
      return;
    }
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
  }, [live, tick]);

  // 回到前台：位置直接到最新，不把后台期间攒下的字当「大积压」去追（规则见 skipLiveReveal）。
  // 挂在 document 上、只在可见时处理；卸载时摘掉
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const cur = liveRef.current;
      if (!cur) return;
      // 换段后第一次 tick 可能还没来得及跑：先对齐段，免得这里 seek 的位置被随后的 reset 抹掉
      syncSegment(cur);
      const { len } = skipLiveReveal(revealerRef.current, cur);
      setRevealed((prev) =>
        prev.id === cur.id && prev.len === len ? prev : { id: cur.id, len },
      );
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [syncSegment]);

  // 卸载：取消未决的 rAF
  useEffect(
    () => () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    [],
  );

  return useMemo(
    () =>
      live
        ? revealLiveThinking(
            live,
            // 这一段的位置还没登记（新挂载 / 刚换段）：从下限起步，而不是 0——
            // 快照重建的实时态第一帧就该是整段已有内容，不能先空着、再从头长一遍
            revealed.id === live.id ? revealed.len : liveThinkingFloor(live),
          )
        : null,
    [live, revealed],
  );
};
