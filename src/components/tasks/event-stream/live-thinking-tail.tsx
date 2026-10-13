"use client";

import { useLayoutEffect, useRef, useState } from "react";

import {
  isLiveTailOverflowing,
  liveTailOffset,
  type LiveTailMetrics,
} from "@/lib/live-tail-scroll";
import { cn } from "@/lib/utils";

/**
 * 进行中思考的实时文本区（ProcessEventRow 在「进行中的思考」行展开时渲染，落盘后换回全文）。
 *
 * 为什么是一个固定高度的滚动窗口，而不是像落盘后那样渲染全文：
 *  - 一段思考动辄几千字，全文随吐字不断长高，会把后面的工具行一路往下顶、整个列表跟着抖；
 *  - 用户要的是「看一眼它正在想什么」，跟读最新几行就够，完整内容等落盘后在思考行里看。
 *
 * 为什么不是旧的「折叠行里的最近一行摘要」（2026-10-12 之前的样子）：那一行取的是行尾 80 字，
 * 每来一个新字，整行内容就向左滑一格，眼睛没法跟读——「思考吐字很机械」的一半来自这里。
 * 现在字是一个个往后长的，窗口随书写连续上移，和读正文的体验一致。
 *
 * 形态：
 *  - 最多 ~5 行高（max-h-28），内容贴底：最新的字始终可见；窗口随光标在行内的书写进度**连续**上移，
 *    不是「换一行滚一行」——后者每次都是一段 ease-in-out 的浏览器动画，行与行之间纹丝不动，
 *    实测 82% 的时间不动、其余时间猛滚一下，正是「加速又刹车又加速」（算法与取舍见 lib/live-tail-scroll）；
 *  - 内容溢出时顶部渐隐，暗示「上面还有、没有被生硬截断」；没溢出（刚开始想）就不渐隐；
 *  - 末尾一个脉冲光标，表示还在生长；
 *  - 排版与落盘后的思考行一致（text-xs / italic / muted），落盘换成全文时不会跳样式。
 *
 * 实现要点：
 *  - 用 transform 平移内容，不用 scrollTop：scrollTop 夹在 [0, scrollHeight − clientHeight]，
 *    连续上移要求内容底部再多出一行空白，而空白会改变窗口的布局高度；transform 没有这个约束；
 *  - 每次文本变化（吐字平滑后每帧至多一次）在 layout effect 里量光标位置、写 transform——
 *    绘制之前同步完成，文字与窗口位置永远是同一帧的；直接写 DOM、不走 setState，免得每帧多一次渲染；
 *  - ResizeObserver 盯着**内容**：窗口变窄 / 字号缩放导致重排时，文本没变也要重新定位。
 */
export const LiveThinkingTail = ({ text }: { text: string }) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  /** 定位函数：挂载时建好（闭包里带着行高 / 窗口上限 / 「减少动态效果」这些不随文本变的量），文本每次变化调用 */
  const placeRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    const caret = caretRef.current;
    if (!scroller || !content || !caret) return;
    // 偏好「减少动态效果」的用户：只按整行阶跃，不做行内的连续上移
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // 行高与窗口上限不随文本变：量一次；重排 / 字号缩放时在 ResizeObserver 里重量
    let lineHeight = 0;
    let viewport = 0;
    const measure = () => {
      const style = getComputedStyle(content);
      lineHeight =
        parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.625;
      viewport = parseFloat(getComputedStyle(scroller).maxHeight);
    };
    const place = () => {
      const metrics: LiveTailMetrics = {
        caretTop: caret.offsetTop,
        caretLeft: caret.offsetLeft,
        width: content.clientWidth,
        lineHeight,
        viewport,
      };
      // 吸附到设备像素：亚像素位移会让文字发虚；运动中每帧 ≤ 1 个设备像素的量化误差肉眼不可见
      const dpr = window.devicePixelRatio || 1;
      const offset =
        Math.round(liveTailOffset(metrics, !reduceMotion) * dpr) / dpr;
      content.style.transform = offset > 0 ? `translateY(${-offset}px)` : "";
      const over = isLiveTailOverflowing(metrics);
      setOverflowing((prev) => (prev === over ? prev : over));
    };
    measure();
    placeRef.current = place;
    // layout effect 里同步做一次：首次绘制前就在正确位置，不会闪一帧「停在顶部」
    place();
    const ro = new ResizeObserver(() => {
      measure();
      place();
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      placeRef.current = () => {};
    };
  }, []);

  // 文本变了（逐帧）→ 重新定位。声明在建立 place 的 effect 之后：挂载时先建、再用
  useLayoutEffect(() => {
    placeRef.current();
  }, [text]);

  return (
    <div
      ref={scrollerRef}
      className={cn(
        "max-h-28 overflow-hidden",
        overflowing &&
          "[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]",
      )}
    >
      {/* relative：让光标的 offsetTop / offsetLeft 相对内容区（而不是更外层的定位祖先） */}
      <div
        ref={contentRef}
        className="relative wrap-break-word text-xs italic leading-relaxed text-muted-foreground"
      >
        {text}
        <span
          ref={caretRef}
          className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 animate-pulse rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
          aria-hidden
        />
      </div>
    </div>
  );
};
