"use client";

/**
 * 右侧侧栏占位接线：开着就占位、别人占了位就让位（关掉自己）。
 * 协调规则与动机见 lib/right-dock。
 *
 * 用法：每个贴右边缘的非模态侧栏，在持有 open 状态的组件里调一次：
 *   useRightDockSlot("changes", open, () => handleOpenChange(false));
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  claimRightDock,
  getRightDockOwner,
  releaseRightDock,
  shouldYieldRightDock,
  subscribeRightDock,
  type RightDockId,
} from "@/lib/right-dock";

/**
 * @param me        自己是谁
 * @param open      自己现在是不是开着
 * @param yieldSlot 别人占了位时怎么关掉自己（走自己原本的关闭路径，比如带「放弃未保存修改」确认的 requestClose；
 *                  确认被取消 = 没关成，两条栏会暂时叠着，用户自己决定，不会反复重试）
 */
export const useRightDockSlot = (
  me: RightDockId,
  open: boolean,
  yieldSlot: () => void,
): void => {
  // 订阅占位变化：别人占位时本组件重渲染，下面的让位 effect 才会重新判断（服务端渲染时没人占位）
  const owner = useSyncExternalStore(subscribeRightDock, getRightDockOwner, () => null);
  // 最新的让位回调：调用方每次渲染都可能传新函数，不进 effect 依赖，免得每次渲染都重跑
  const yieldRef = useRef(yieldSlot);
  yieldRef.current = yieldSlot;

  // 开着就占位；关掉 / 卸载时还位（releaseRightDock 内部只在「位子还是自己的」时才清）
  useEffect(() => {
    if (!open) return;
    claimRightDock(me);
    return () => releaseRightDock(me);
  }, [me, open]);

  // 别人占了位、自己还开着 → 让位。
  // 必须在上面的占位 effect 之后判断，并读「此刻」的占位人（getRightDockOwner）而不是渲染时的 owner：
  // 否则自己刚打开的那一帧，渲染时的 owner 还是上一个占位的别人，会把自己刚打开的栏立刻关掉。
  useEffect(() => {
    if (shouldYieldRightDock(me, open, getRightDockOwner())) yieldRef.current();
  }, [me, open, owner]);
};
