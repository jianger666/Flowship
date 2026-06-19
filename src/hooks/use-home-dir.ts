"use client";

/**
 * useHomeDir：拿当前用户主目录（os.homedir()）的客户端 hook
 *
 * home 路径进程内不变——用 module 级缓存全 app 只拉一次（多个工作目录选择器共享、
 * 不重复请求）。首次异步拉、拉到前返回空串、调用方按需兜底文案。
 */

import { useEffect, useState } from "react";

// module 级缓存：null = 还没拉、字符串 = 已拉到（含拉失败时的空串）
let cached: string | null = null;
// 同一时刻只发一个请求、并发调用共享这个 promise
let inflight: Promise<string> | null = null;

const loadHome = (): Promise<string> => {
  if (cached !== null) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/system/home")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { home?: string } | null) => {
        cached = d?.home ?? "";
        return cached;
      })
      .catch(() => {
        cached = "";
        return cached;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
};

export const useHomeDir = (): string => {
  // 主目录路径、初始取 module 缓存（命中则同步出值、不闪空）
  const [home, setHome] = useState(cached ?? "");

  useEffect(() => {
    if (cached !== null) {
      setHome(cached);
      return;
    }
    let alive = true;
    void loadHome().then((h) => {
      if (alive) setHome(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  return home;
};
