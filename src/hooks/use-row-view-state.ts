"use client";

/**
 * `useRowViewState(key, initial)`：像 useState，但值会进模块级 LRU 存档（`@/lib/event-row-view-state`），
 * 行被 Virtuoso 卸载后再挂回来，首帧就是用户上次留下的状态（V2-05）。
 *
 * 语义要点：
 *  - 没调过 setter → 不写存档（只存用户真动过的），重挂仍是 initial；
 *  - **setter 在组件卸载后调用也照样写存档**：「加载完整输出」的请求发出去后用户把行滚走了，
 *    请求回来时行已卸载——结果仍落进存档，滚回来直接是完整输出，不用再请求一次；
 *  - 支持函数式更新（`set(prev => !prev)`），语义同 useState；
 *  - `key` 为 null = 不持久化（退化成普通 useState）；key 变了（同一个实例被复用到另一行）会按新 key 重读；
 *  - `initial` 可以是函数，只在没有存档时才求值；
 *  - setter 引用恒稳定（可放心进 effect 依赖）。
 *
 * 作用域：{@link RowViewStateScope}。主事件流不需要；子代理详情抽屉里的行 id 每份记录都从 sr_1 起，
 * 抽屉在外面套一层 `<RowViewStateScope.Provider value="sa:<记录 key>">` 隔离。
 */

import { createContext, useCallback, useContext, useRef, useState } from "react";

import {
  rowViewStateStore,
  withRowViewStateScope,
  type RowViewValue,
} from "@/lib/event-row-view-state";

export const RowViewStateScope = createContext<string>("");

export const useRowViewState = <T extends RowViewValue>(
  key: string | null,
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] => {
  const scope = useContext(RowViewStateScope);
  const fullKey = key == null ? null : withRowViewStateScope(key, scope);

  const read = (): T => {
    if (fullKey != null) {
      const hit = rowViewStateStore.get(fullKey);
      if (hit !== undefined) return hit as T;
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  };

  // 值和它所属的 key 放在一起：key 变了的那一次渲染就能发现并重读（React 推荐的「由 props 推导 state」写法，
  // 渲染期 setState 会立刻按新值重渲、不会先画一帧旧值）
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({
    key: fullKey,
    value: read(),
  }));
  let current = state;
  if (state.key !== fullKey) {
    current = { key: fullKey, value: read() };
    setState(current);
  }

  // setter 读这两个 ref、自己不依赖渲染闭包：既保持引用稳定，也让卸载后的异步写入走最新的 key / 值
  const valueRef = useRef(current.value);
  valueRef.current = current.value;
  const keyRef = useRef(fullKey);
  keyRef.current = fullKey;

  const set = useCallback((next: T | ((prev: T) => T)) => {
    const resolved =
      typeof next === "function"
        ? (next as (prev: T) => T)(valueRef.current)
        : next;
    valueRef.current = resolved;
    const k = keyRef.current;
    if (k != null) rowViewStateStore.set(k, resolved);
    setState({ key: k, value: resolved });
  }, []);

  return [current.value, set];
};
