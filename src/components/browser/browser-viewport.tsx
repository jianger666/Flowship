"use client";

/**
 * 浏览器视口：一个「占位 div」，原生 WebContentsView 盖在它的位置上。
 *
 * 职责：
 *  - 把这个 div 的屏幕矩形（getBoundingClientRect 取整）汇报给 attach / setBounds；
 *    容器不可见或宽高为 0 时 detach，卸载 / 离开任务页也 detach；
 *  - 被 Flowship 自己的浮层遮盖时，在 div 里画主进程给的占位截图（见 use-overlay-cover）。
 *
 * 为什么 bounds 的触发源这么多：原生视图完全靠这里算出的坐标定位，漏一种位置变化就会「视图和占位 div 错位」。
 *  - ResizeObserver 挂在自己和所有祖先上：拖分栏 / 折叠产物栏 / 侧栏开合 / 窗口缩放，任何一层尺寸变了都能触发
 *    （只观察自己抓不到「自己尺寸不变、位置被挤动」）；它每帧最多触发一次，回调里直接同步汇报（再等 rAF 只会更慢，
 *    拖动时视图就比占位 div 多落后一帧）；
 *  - window resize / 祖先滚动：事件远多于帧数，走 rAF 节流（一帧一次）；
 *  - 1 秒一次的心跳兜底：CSS transform 动画这类没有任何事件的位移。
 */

import { memo, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import type { BrowserState } from "@/lib/browser-bridge-types";
import { cn } from "@/lib/utils";
import { getBrowserStore } from "./browser-state-store";
import { viewFitCssOf } from "./browser-user-logic";
import { useActiveViewFit } from "./use-browser-session";
import { useOverlayCover } from "./use-overlay-cover";
import {
  boundsEqual,
  computeViewportBounds,
  createFrameThrottle,
  isElementRendered,
} from "./viewport-bounds";

interface BrowserViewportProps {
  taskId: string;
  /**
   * 是否该把视图挂到窗口上。false = 只画占位（还没有会话时：attach 会懒创建会话 + 一个渲染进程，
   * 没人要用就不该建）。
   */
  attachEnabled: boolean;
  /** attach 成功（视图已挂上窗口）后回调；面板在这里消费「待导航」意图 */
  onAttached?: (state: BrowserState) => void;
  className?: string;
  children?: React.ReactNode;
}

const HEARTBEAT_MS = 1000;

const BrowserViewportImpl = ({
  taskId,
  attachEnabled,
  onAttached,
  className,
  children,
}: BrowserViewportProps) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 视图是否已挂上（决定遮盖 hook 要不要工作）：attach 是异步的，用 state 驱动一次重渲即可
  const [attached, setAttached] = useState(false);
  const onAttachedRef = useRef(onAttached);
  onAttachedRef.current = onAttached;

  const { covered, coverImage, reevaluate } = useOverlayCover({
    taskId,
    viewportRef: boxRef,
    enabled: attached,
  });
  const reevaluateRef = useRef(reevaluate);
  reevaluateRef.current = reevaluate;
  // 设备模拟把原生视图收窄（居中、顶部对齐）时，遮盖占位图要摆在同一个位置，否则会被拉伸成整个占位 div
  const coverBox = viewFitCssOf(useActiveViewFit(taskId));

  useEffect(() => {
    const bridge = window.__browser;
    const el = boxRef.current;
    if (!bridge || !el || !attachEnabled) return;

    let disposed = false;
    // 与主进程对齐的「是否已 attach」与最后一次汇报的 bounds
    let isAttached = false;
    let last: ReturnType<typeof computeViewportBounds> = null;

    const sync = () => {
      if (disposed) return;
      const bounds = computeViewportBounds(el.getBoundingClientRect(), isElementRendered(el));
      if (!bounds) {
        // 不可见 / 0 尺寸：把视图撤回停车场，别在窗口上留一个 0 尺寸（或错位）的原生视图
        if (isAttached) {
          isAttached = false;
          last = null;
          bridge.detach(taskId);
          setAttached(false);
        }
        return;
      }
      if (!isAttached) {
        isAttached = true;
        last = bounds;
        setAttached(true);
        void bridge
          .attach(taskId, bounds)
          .then((state) => {
            if (disposed || !state) return;
            // attach 回包就是最新状态：直接灌进 store，面板不用等下一次推送
            getBrowserStore().setState(state);
            onAttachedRef.current?.(state);
          })
          .catch(() => {
            // 主进程拒绝 / 旧壳：撤回「已挂上」，下一次 sync 会重试
            if (disposed) return;
            isAttached = false;
            last = null;
            setAttached(false);
          });
        return;
      }
      if (!boundsEqual(last, bounds)) {
        last = bounds;
        bridge.setBounds(taskId, bounds);
        // 视口挪动后可能刚好从浮层下挪出来 / 挪进去
        reevaluateRef.current();
      }
    };

    const throttle = createFrameThrottle(sync);

    // 自己 + 所有祖先：任一层尺寸变化都可能挤动视口
    const ro = new ResizeObserver(() => throttle.flush());
    for (let n: Element | null = el; n; n = n.parentElement) ro.observe(n);

    const onWindowResize = () => throttle.schedule();
    // 祖先滚动才会挪动视口；其它元素（比如事件流）的滚动与我们无关，别白白排帧
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && t.contains(el)) throttle.schedule();
    };
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const heartbeat = setInterval(throttle.schedule, HEARTBEAT_MS);

    // 首次同步：此时布局已完成（effect 在提交之后）
    sync();

    return () => {
      disposed = true;
      throttle.cancel();
      ro.disconnect();
      clearInterval(heartbeat);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onScroll, { capture: true });
      if (isAttached) bridge.detach(taskId);
      setAttached(false);
    };
  }, [taskId, attachEnabled]);

  return (
    <div
      ref={boxRef}
      data-browser-viewport
      className={cn("relative min-h-0 flex-1 overflow-hidden bg-muted/30", className)}
    >
      {/* 遮盖时的占位：原生视图被主进程隐藏，这里画它的截图，视觉上浏览器还在 */}
      {covered &&
        (coverImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- 主进程给的 dataURL，用不着 next/image
          <img
            src={coverImage}
            alt=""
            draggable={false}
            className={cn("absolute select-none object-fill", !coverBox && "inset-0 size-full")}
            style={coverBox ?? undefined}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/60 text-xs text-muted-foreground">
            浏览器画面已暂时隐藏
          </div>
        ))}
      {/* 已决定要挂但还没挂上（attach 往返中）：给个轻提示，别让用户对着空白发呆 */}
      {attachEnabled && !attached && !covered && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          正在连接浏览器…
        </div>
      )}
      {children}
    </div>
  );
};

export const BrowserViewport = memo(BrowserViewportImpl);
