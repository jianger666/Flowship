"use client";

/**
 * 拉 Cursor 模型列表的 hook
 *
 * 抽出来主要解决两件事：
 * 1. race condition：用户连点「验证」或先后改 apiKey 再点、之前实现里
 *    后发请求未必后到、可能用旧响应覆盖新响应
 *    → AbortController + ref：每次新请求 abort 旧的、AbortError 静默吞掉
 * 2. 把 settings 页里跟模型相关的 4 个 state（models / loading / error / abort ref）打包
 *
 * V0.7.13 加 SWR 缓存（用户实测「到处都要拉、很慢」）：
 * - localStorage 存 { keyHash, models, ts }、TTL 24h
 * - 命中：立即出缓存数据（不转圈）、后台静默 re-fetch、回来刷新缓存 + state
 * - 未命中 / key 换了：老流程（转圈等接口）
 * - server 端 /api/models 另有 10 分钟内存缓存、双层叠加后台刷新也快
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ModelOption } from "@/lib/types";

export interface UseModelsResult {
  models: ModelOption[];
  loading: boolean;
  error: string;
  fetchModels: (apiKey: string) => Promise<void>;
}

const CACHE_KEY = "flowship:models-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// apiKey 摘要：缓存归属判定用（不存明文、本地工具够用的弱指纹）
const keyHashOf = (apiKey: string): string =>
  `${apiKey.length}:${apiKey.slice(0, 4)}:${apiKey.slice(-4)}`;

interface ModelsCache {
  keyHash: string;
  models: ModelOption[];
  ts: number;
}

const readCache = (apiKey: string): ModelOption[] | null => {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as ModelsCache;
    if (c.keyHash !== keyHashOf(apiKey)) return null;
    if (Date.now() - c.ts > CACHE_TTL_MS) return null;
    return Array.isArray(c.models) && c.models.length > 0 ? c.models : null;
  } catch {
    return null;
  }
};

const writeCache = (apiKey: string, models: ModelOption[]) => {
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ keyHash: keyHashOf(apiKey), models, ts: Date.now() } satisfies ModelsCache),
    );
  } catch {
    // quota 满等失败不影响主流程
  }
};

export const useModels = (): UseModelsResult => {
  // 通过 /api/models 拉到的模型列表（依赖有效 API key）
  const [models, setModels] = useState<ModelOption[]>([]);

  // 模型列表加载中状态、控制刷新按钮 spinner（缓存命中时的后台刷新不置 true）
  const [loading, setLoading] = useState(false);

  // 模型列表拉取的错误信息（API key 错 / 网络错 / 超时）
  const [error, setError] = useState("");

  // 当前 in-flight 请求的 controller、新请求来时 abort 旧的
  const abortRef = useRef<AbortController | null>(null);

  const fetchModels = useCallback(async (apiKey: string) => {
    abortRef.current?.abort();

    const trimmed = apiKey.trim();
    if (!trimmed) {
      setModels([]);
      setError("");
      setLoading(false);
      return;
    }

    // SWR：缓存命中先出数据、后台静默刷新（silent=true 时不转圈、错误不打扰）
    const cached = readCache(trimmed);
    const silent = cached !== null;
    if (cached) {
      setModels(cached);
      setError("");
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!silent) {
      setLoading(true);
      setError("");
    }

    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;

      const json = await res.json();
      if (ctrl.signal.aborted) return;

      if (!res.ok) {
        // 后台刷新失败：保留缓存数据、静默（多半是网络抖动、缓存还能用）
        if (!silent) {
          setModels([]);
          setError(json.error || "拉取失败");
        }
        return;
      }
      const fresh: ModelOption[] = json.models || [];
      setModels(fresh);
      writeCache(trimmed, fresh);
      // 静默刷新不弹 toast、首次（或缓存失效后）拉取保留成功提示
      if (!silent) toast.success(`已加载 ${fresh.length} 个模型`);
    } catch (err) {
      // AbortError 是用户主动 abort（比如点了第二次「验证」）、不视为错误
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (ctrl.signal.aborted) return;
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      // abort 的请求其 loading 状态已被新请求接管、这里别覆盖
      if (!ctrl.signal.aborted && !silent) setLoading(false);
    }
  }, []);

  // 组件卸载时把 in-flight 请求 abort 掉、避免 setState on unmounted
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  return { models, loading, error, fetchModels };
};
