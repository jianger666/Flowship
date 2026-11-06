"use client";

import { useCallback, useState } from "react";

/**
 * 布尔偏好持久化到 localStorage（换行开关、查看器的大纲开关等）。
 * 仅用于客户端动态加载的预览正文（ssr:false），首帧就能同步读到存的值，不会有「先闪一下默认值」。
 * localStorage 不可用（隐私模式 / 配额）时退回纯内存状态。
 */
export const usePersistedBoolean = (key: string, initial: boolean): [boolean, (v: boolean) => void] => {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // 存不下就算了，本次会话内仍然生效
      }
    },
    [key],
  );
  return [value, set];
};
