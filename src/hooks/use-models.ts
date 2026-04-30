"use client";

/**
 * 拉 Cursor 模型列表的 hook
 *
 * 抽出来主要解决两件事：
 * 1. race condition：用户连点「验证」或先后改 apiKey 再点、之前实现里
 *    后发请求未必后到、可能用旧响应覆盖新响应
 *    → AbortController + ref：每次新请求 abort 旧的、AbortError 静默吞掉
 * 2. 把 settings 页里跟模型相关的 4 个 state（models / loading / error / abort ref）打包
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

export const useModels = (): UseModelsResult => {
  // 通过 /api/models 拉到的模型列表（依赖有效 API key）
  const [models, setModels] = useState<ModelOption[]>([]);

  // 模型列表加载中状态、控制刷新按钮 spinner
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

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError("");

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
        setModels([]);
        setError(json.error || "拉取失败");
        return;
      }
      setModels(json.models || []);
      toast.success(`已加载 ${json.models?.length ?? 0} 个模型`);
    } catch (err) {
      // AbortError 是用户主动 abort（比如点了第二次「验证」）、不视为错误
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // abort 的请求其 loading 状态已被新请求接管、这里别覆盖
      if (!ctrl.signal.aborted) setLoading(false);
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
