"use client";

/**
 * 拉 API Key 归属信息（Cursor.me）的 hook —— 设置页 ApiKeyCard 展示用
 *
 * 跟 use-models 同套路（抽出来复用同一套防抖 / 缓存模式）：
 * 1. race：连点验证 / 改 key 再验时、AbortController + ref 保证后发后到、AbortError 静默吞
 * 2. SWR 缓存：localStorage 存 { keyHash, info, ts }、TTL 24h
 *    - 命中：立即出缓存（不转圈）、后台静默 re-fetch 刷新
 *    - 未命中 / key 换了：转圈等接口
 *    - server /api/me 另有 10 分钟内存缓存、双层叠加
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { isLegacyKeyHash, keyHashOf } from "@/lib/api-key-cache";
import type { ApiKeyInfo } from "@/lib/types";

export interface UseApiKeyInfoOptions {
  /** 用户手动触发（如点「验证」）：即使命中缓存也走非静默，弹出成功/失败 toast */
  manual?: boolean;
}

export interface UseApiKeyInfoResult {
  info: ApiKeyInfo | null;
  loading: boolean;
  error: string;
  fetchInfo: (apiKey: string, options?: UseApiKeyInfoOptions) => Promise<void>;
}

const CACHE_KEY = "flowship:api-key-info-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface InfoCache {
  keyHash: string;
  info: ApiKeyInfo;
  ts: number;
}

const readCache = (apiKey: string): ApiKeyInfo | null => {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as InfoCache;
    // 旧版把 key 前后 4 位明文写进了指纹：读到就清掉（S13-15 隐私）
    if (isLegacyKeyHash(c.keyHash)) {
      window.localStorage.removeItem(CACHE_KEY);
      return null;
    }
    if (c.keyHash !== keyHashOf(apiKey)) return null;
    if (Date.now() - c.ts > CACHE_TTL_MS) return null;
    return c.info ?? null;
  } catch {
    return null;
  }
};

const writeCache = (apiKey: string, info: ApiKeyInfo) => {
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        keyHash: keyHashOf(apiKey),
        info,
        ts: Date.now(),
      } satisfies InfoCache),
    );
  } catch {
    // quota 满等失败不影响主流程
  }
};

const clearCache = () => {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // 隐私模式等失败不影响主流程
  }
};

export const useApiKeyInfo = (): UseApiKeyInfoResult => {
  // Cursor.me 返回的账号信息（依赖有效 API key）
  const [info, setInfo] = useState<ApiKeyInfo | null>(null);

  // 加载中（缓存命中时的后台刷新不置 true）
  const [loading, setLoading] = useState(false);

  // 拉取错误信息（key 错 / 网络错 / 超时）
  const [error, setError] = useState("");

  // 当前 in-flight 请求的 controller、新请求来时 abort 旧的
  const abortRef = useRef<AbortController | null>(null);

  const fetchInfo = useCallback(async (apiKey: string, options?: UseApiKeyInfoOptions) => {
    const manual = options?.manual ?? false;
    abortRef.current?.abort();

    const trimmed = apiKey.trim();
    if (!trimmed) {
      // 清空 key：账号信息块随之消失，缓存的姓名 / 邮箱也一并清掉
      clearCache();
      setInfo(null);
      setError("");
      setLoading(false);
      return;
    }

    // SWR：缓存命中先出数据、后台静默刷新；手动验证时即使有缓存也转圈 + toast
    const cached = readCache(trimmed);
    const silent = cached !== null && !manual;
    if (cached) {
      setInfo(cached);
      setError("");
    } else {
      // 没有这把 key 的缓存：上一把 key 的姓名 / 邮箱不能继续挂在新 key 下面等接口——
      // 用户会误以为新 key 属于那个人（接口失败时才清掉就太晚了，成功前一直显示的是别人的账号）
      setInfo(null);
    }
    // 静默刷新不会走下面的 setLoading(true)，而上面的 abort 可能刚中止了一个非静默请求——
    // 被中止的请求在 finally 里不会复位 loading（`!ctrl.signal.aborted` 守卫），这里补一次，否则转圈永远不停
    if (silent) setLoading(false);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!silent) {
      setLoading(true);
      setError("");
    }

    try {
      const res = await fetch("/api/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;

      const json = await res.json();
      if (ctrl.signal.aborted) return;

      if (!res.ok) {
        // 后台刷新失败：保留缓存数据、静默；非静默才暴露错误
        if (!silent) {
          setInfo(null);
          setError(json.error || "获取失败");
        }
        if (manual) {
          toast.error(json.error || `获取失败（HTTP ${res.status}）`);
        }
        return;
      }
      const fresh: ApiKeyInfo | null = json.user ?? null;
      setInfo(fresh);
      if (fresh) writeCache(trimmed, fresh);
      if (manual) {
        toast.success(fresh ? "API Key 验证成功" : "API Key 验证完成（未返回账号信息）");
      }
    } catch (err) {
      // AbortError 是主动 abort（连点 / 改 key）、不算错误
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (ctrl.signal.aborted) return;
      if (!silent) setError(err instanceof Error ? err.message : String(err));
      if (manual) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!ctrl.signal.aborted && !silent) setLoading(false);
    }
  }, []);

  // 卸载时 abort in-flight、避免 setState on unmounted
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return { info, loading, error, fetchInfo };
};
