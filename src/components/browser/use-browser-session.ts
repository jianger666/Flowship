"use client";

/**
 * 订阅 `window.__browser.onState`，按 taskId 取浏览器会话状态。
 *
 * 重渲范围（任务页 / ChatView 已经很重，状态又是 50ms 一次的高频推送）：
 *  - 底层是 browser-state-store：全应用一个 onState 订阅、内容没变不通知、按 taskId 分桶；
 *  - `useBrowserSession` 返回完整状态，只给面板本体用（面板打开时才挂载）；
 *  - `useBrowserSignals` 只返回头部入口需要的几个字段，浅比较不变就不重渲，tabs / recent 变得再勤也不波及外层；
 *  - 没有 bridge（网页版 / SSR）→ `available:false`，不订阅任何东西。
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import type { BrowserState } from "@/lib/browser-bridge-types";
import {
  IDLE_SIGNALS,
  deriveSignals,
  getBrowserStore,
  isBrowserBridgeAvailable,
  signalsEqual,
  type BrowserSignals,
} from "./browser-state-store";

const noopSubscribe = () => () => {};

/** 当前是否有浏览器桥（桌面端 true）。服务端渲染 / 水合首帧恒为 false，水合后自动更新 */
export const useBrowserAvailable = (): boolean =>
  useSyncExternalStore(noopSubscribe, isBrowserBridgeAvailable, () => false);

export interface BrowserSessionView {
  available: boolean;
  /** 还没收到过该任务的状态 / 没有 bridge = null */
  state: BrowserState | null;
}

const UNAVAILABLE: BrowserSessionView = { available: false, state: null };

/**
 * 完整状态。taskId 为空 / 没有 bridge 时不订阅。
 * 返回对象按 (available, state) 缓存：state 引用不变就返回同一个对象。
 */
export const useBrowserSession = (taskId: string | null | undefined): BrowserSessionView => {
  const available = useBrowserAvailable();
  const active = available && !!taskId;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active || !taskId) return () => {};
      return getBrowserStore().subscribe(taskId, onChange);
    },
    [active, taskId],
  );
  const getSnapshot = useCallback(
    () => (active && taskId ? (getBrowserStore().getState(taskId) ?? null) : null),
    [active, taskId],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);

  return useMemo(() => (available ? { available, state } : UNAVAILABLE), [available, state]);
};

export interface BrowserSignalsView extends BrowserSignals {
  available: boolean;
}

const UNAVAILABLE_SIGNALS: BrowserSignalsView = { ...IDLE_SIGNALS, available: false };

/**
 * 头部入口按钮用的「小」状态：controller / ask / 未读用户操作数。
 * 快照用上一份缓存做浅比较——store 里的 state 再换引用（比如只是 tabs 变了），只要这几个字段没变就返回旧对象，
 * useSyncExternalStore 据此判定「没变化」、不重渲。
 */
export const useBrowserSignals = (taskId: string | null | undefined): BrowserSignalsView => {
  const available = useBrowserAvailable();
  const active = available && !!taskId;
  const cacheRef = useRef<{ key: string; view: BrowserSignalsView } | null>(null);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active || !taskId) return () => {};
      return getBrowserStore().subscribe(taskId, onChange);
    },
    [active, taskId],
  );
  const getSnapshot = useCallback((): BrowserSignalsView => {
    if (!active || !taskId) return UNAVAILABLE_SIGNALS;
    const next = deriveSignals(getBrowserStore().getState(taskId));
    const prev = cacheRef.current;
    if (prev && prev.key === taskId && signalsEqual(prev.view, next)) return prev.view;
    const view: BrowserSignalsView = { ...next, available: true };
    cacheRef.current = { key: taskId, view };
    return view;
  }, [active, taskId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => UNAVAILABLE_SIGNALS);
};
