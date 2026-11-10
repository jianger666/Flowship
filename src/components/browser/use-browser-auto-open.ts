"use client";

/**
 * 浏览器面板自动展开（task 页 / chat 页共用）。
 *
 * 零重渲：整个 hook 只有 effect 和 ref，没有 state——订阅的是 store 的「信号」（controller / ask），
 * 信号变了才回调，回调里直接调页面传进来的 onOpen。没有 bridge（网页版）时什么都不挂。
 * 判定规则见 browser-auto-open.ts（纯函数、有单测）。
 *
 * 只管「展开面板」，**不发系统通知**：ask 的通知由全局 BrowserAskWatcher 统一发（R1-16，免得两处各发一条）。
 */

import { useEffect, useRef } from "react";

import {
  classifyPanelTransition,
  decideAutoOpen,
  initialAutoOpenMemory,
  noteUserClosedPanel,
  noteUserOpenedPanel,
  type AutoOpenMemory,
} from "./browser-auto-open";
import {
  deriveSignals,
  getBrowserStore,
  isBrowserBridgeAvailable,
  type BrowserStateSource,
} from "./browser-state-store";

/**
 * 记忆按任务存在模块级：任务页切走再切回（hook 重挂）时，「用户已手动收起」「这个 ask 已处理」不能丢，
 * 否则每次切回都会重新弹开。条目很小，且只为真正出现过浏览器会话的任务创建。
 */
const memories = new Map<string, AutoOpenMemory>();
const memoryOf = (taskId: string): AutoOpenMemory => memories.get(taskId) ?? initialAutoOpenMemory();

export interface UseBrowserAutoOpenOptions {
  /** 当前正在显示的任务 id；null = 没有（后台任务不抢焦点：只给「当前显示」的任务挂 hook） */
  taskId: string | null | undefined;
  /** 总开关（比如 task 页里 chat 任务不走这条） */
  enabled?: boolean;
  /** 面板当前是否展开（task：浏览器标签可见且产物栏已展开；chat：右栏已打开） */
  panelOpen: boolean;
  /** 展开面板并切到浏览器；页面保证它是稳定回调或自己用 ref 兜底 */
  onOpen: () => void;
  /**
   * 这次 展开→收起 是不是用户意图（点按钮 / 切标签 / 拖分隔条）。缺省 = 一律当用户收起（旧行为）。
   * 页面应传入：布局库自己折叠 / 夹取造成的收起不是用户意图，不能记「已收起」（R2-14 ③，见 browser-auto-open.ts）。
   */
  isUserClose?: () => boolean;
}

export const useBrowserAutoOpen = ({
  taskId,
  enabled = true,
  panelOpen,
  onOpen,
  isUserClose,
}: UseBrowserAutoOpenOptions): void => {
  // 最新值走 ref：订阅 effect 只随 taskId / enabled 重建，不会因为 panelOpen / onOpen 变化反复重订阅
  const panelOpenRef = useRef(panelOpen);
  const onOpenRef = useRef(onOpen);
  const isUserCloseRef = useRef(isUserClose);
  panelOpenRef.current = panelOpen;
  onOpenRef.current = onOpen;
  isUserCloseRef.current = isUserClose;

  // 面板「展开 → 收起」= 用户手动关（同一个 taskId 内才算，切任务导致的重置不算）；
  // 面板处于展开态 = 用户手动再展开（或被 ask 弹开）：清掉「已收起」，之后 AI 的动作才可以再自动弹（R1-17）
  const prevPanelRef = useRef<{ taskId: string | null | undefined; open: boolean }>({
    taskId,
    open: panelOpen,
  });
  useEffect(() => {
    const prev = prevPanelRef.current;
    prevPanelRef.current = { taskId, open: panelOpen };
    if (!enabled || !taskId || !isBrowserBridgeAvailable()) return;
    const kind = classifyPanelTransition(
      prev,
      { taskId, open: panelOpen },
      () => isUserCloseRef.current?.() ?? true,
    );
    if (kind === "opened") {
      const cur = memoryOf(taskId);
      const next = noteUserOpenedPanel(cur);
      if (next !== cur) memories.set(taskId, next);
      return;
    }
    // auto-closed（库自动折叠 / 夹取）不记「已收起」：用户没有要关，AI 的下一个动作仍可以再把面板弹开
    if (kind !== "user-closed") return;
    const signals = deriveSignals(getBrowserStore().getState(taskId));
    memories.set(taskId, noteUserClosedPanel(memoryOf(taskId), signals));
  }, [taskId, panelOpen, enabled]);

  useEffect(() => {
    if (!enabled || !taskId || !isBrowserBridgeAvailable()) return;
    const store = getBrowserStore();

    const handle = (
      next: ReturnType<typeof deriveSignals>,
      source: BrowserStateSource,
    ) => {
      const decision = decideAutoOpen(memoryOf(taskId), next, {
        panelOpen: panelOpenRef.current,
        source,
      });
      memories.set(taskId, decision.memory);
      if (decision.open) onOpenRef.current();
    };

    // 订阅前缓存里就已有的状态（别处订阅者先拉到的）：当基线评估一次，别漏掉已挂着的 ask
    const cached = store.getState(taskId);
    if (cached) handle(deriveSignals(cached), "seed");

    return store.subscribeSignals(taskId, (next, _prev, source) => handle(next, source));
  }, [taskId, enabled]);
};
