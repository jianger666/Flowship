"use client";

/**
 * 事件流折叠体：展开 / 收起带高度动画（2026-10-17「完成后抖一下、全是大动作」）
 *
 * 用法：把原来的 `{!collapsed && (<div>…body…</div>)}` 换成
 * `<Collapse open={!collapsed}><div>…body…</div></Collapse>`。
 *
 * 为什么是它而不是各处自己写 transition：过程层有七八处折叠体（工作过程组 / 思考行 / 工具块 /
 * 子代理卡 / 待办卡 / 动词组 / 提问回放…），阶段机和兜底收尾只许有一份。阶段转移在
 * `@/lib/collapse-motion`（纯函数、有单测），这里只管 DOM 接线。
 *
 * 实现要点（每一条都是为了让它在 Virtuoso 虚拟列表里也稳）：
 *  - **grid-template-rows 1fr ↔ 0fr**：不用量高度，内容高度变了（流式增长 / 异步回填）动画也不会算错；
 *    Virtuoso 的 ResizeObserver 逐帧收到高度变化，总高 / 跟随贴底照常工作（跟随态下浏览器还会自己
 *    把 scrollTop 夹到新的最大值，内容收缩时视口里的东西纹丝不动）。
 *  - **首次挂载不播动画**：行随滚动反复进出视口，已展开的组不能每次滚进来都「长」一遍（见 collapse-motion 第 1 条）。
 *  - **收起时继续画「最后一次展开时」的子树**，动画结束再卸载。这一条是「思考自动收起」成立的前提：
 *    进行中的思考落盘的那一刻，行的 body 同时从「~5 行的实时窗口」换成「几千字全文」+ 触发自动收起——
 *    如果收起动画期间画的是新 body，高度会先暴涨到全文高度再收，比不动画还糟。
 *    被冻结的子树只是不再收到新 props，里面的组件仍然挂着、保持自己的内部状态。
 *  - **静止展开时撤掉 overflow:hidden**（只有过渡中才裁剪）：否则 focus ring、阴影、绝对定位的小按钮会被裁掉。
 *  - **过渡中 inert**：收起动画那 220ms 里键盘焦点不能钻进正在消失的内容里。
 *  - **兜底定时器**：transitionend 在标签页后台 / 元素被隐藏时可能不来，超时强制收尾（见 COLLAPSE_END_SLACK_MS）。
 *  - 「减少动态效果」：阶段机直接 open ↔ closed、CSS 也 `motion-reduce:transition-none`。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  COLLAPSE_END_SLACK_MS,
  COLLAPSE_MOTION_MS,
  collapseIsAnimating,
  collapseMounted,
  collapseOnEnd,
  collapseOnFrame,
  collapseRowsExpanded,
  initialCollapsePhase,
  stepCollapse,
  type CollapsePhase,
} from "@/lib/collapse-motion";
import { cn } from "@/lib/utils";

/** 全局缓存一个 MediaQueryList（`.matches` 是活的）：每次渲染现建一个没必要，折叠体在列表里有几十个 */
let reducedMotionQuery: MediaQueryList | null = null;

/** 读「减少动态效果」偏好；SSR / 无 matchMedia 的环境当没开 */
const prefersReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery.matches;
};

export const Collapse = ({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) => {
  const [phase, setPhase] = useState<CollapsePhase>(() =>
    initialCollapsePhase(open),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 最后一次「展开」时的子树：收起动画期间继续画它（原因见文件头第三条）。
  // 渲染期写 ref 是幂等的（open 时恒等于当前 children），StrictMode 双渲染安全
  const lastOpenChildren = useRef<ReactNode>(children);
  if (open) lastOpenChildren.current = children;

  // 渲染期把「想开 / 想关」折算成阶段（幂等）。需要换阶段时立刻 setState、本次渲染也按新阶段画——
  // 这是 React 官方的「由 props 推导 state」写法，不会先画一帧旧阶段
  const synced = stepCollapse(phase, open, prefersReducedMotion());
  if (synced !== phase) setPhase(synced);

  // 起跑线（0fr）画出来之后强制一次样式计算、再切到 1fr——不强制的话浏览器会把两次变化合成一次、
  // 看不到 0fr 起点，transition 就不触发
  useLayoutEffect(() => {
    if (synced !== "enter-from") return;
    void rootRef.current?.getBoundingClientRect();
    setPhase((p) => collapseOnFrame(p));
  }, [synced]);

  // 兜底收尾：transitionend 没来也要把过渡中的阶段结束掉
  useEffect(() => {
    if (!collapseIsAnimating(synced)) return;
    const timer = window.setTimeout(
      () => setPhase((p) => collapseOnEnd(p)),
      COLLAPSE_MOTION_MS + COLLAPSE_END_SLACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [synced]);

  if (!collapseMounted(synced)) {
    // 稳定折叠后别再抓着旧子树（里面带着整段事件文本）不放
    if (!open) lastOpenChildren.current = null;
    return null;
  }

  const animating = collapseIsAnimating(synced);
  // 正在消失（leaving）和 0fr 起跑线（enter-from）里的东西都不该被键盘聚焦
  const inert = synced === "leaving" || synced === "enter-from";

  return (
    <div
      ref={rootRef}
      // 列 minmax(0,1fr)：不让内部的长命令 / 长路径把列撑宽（grid 子项默认 min-width:auto）
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] motion-reduce:transition-none",
        animating &&
          "transition-[grid-template-rows] duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
        collapseRowsExpanded(synced) ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      inert={inert}
      onTransitionEnd={(e) => {
        // 子孙的 transition（chevron 旋转 / 嵌套折叠体）会冒泡上来，只认自己这一条
        if (e.target !== e.currentTarget) return;
        if (e.propertyName !== "grid-template-rows") return;
        setPhase((p) => collapseOnEnd(p));
      }}
    >
      {/* min-h-0 + overflow-hidden 才能让 0fr 真的收到 0；静止展开后改回 visible（见文件头） */}
      <div
        className={cn(
          "min-h-0 min-w-0",
          synced === "open" ? "overflow-visible" : "overflow-hidden",
        )}
      >
        {open ? children : lastOpenChildren.current}
      </div>
    </div>
  );
};
