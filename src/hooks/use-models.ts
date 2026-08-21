"use client";

/**
 * 拉模型列表的 hook（cursor 与自定义 provider 共用）
 *
 * 抽出来主要解决两件事：
 * 1. race condition：用户连点「获取列表」或先后改凭据再点、之前实现里
 *    后发请求未必后到、可能用旧响应覆盖新响应
 *    → AbortController + ref：每次新请求 abort 旧的、AbortError 静默吞掉
 * 2. 把 settings 页里跟模型相关的 4 个 state（models / loading / error / abort ref）打包
 *
 * V0.7.13 加 SWR 缓存（用户实测「到处都要拉、很慢」）：
 * - localStorage 存 { keyHash, models, ts }、TTL 24h
 * - 命中：立即出缓存数据（不转圈）、后台静默 re-fetch、回来刷新缓存 + state
 * - 未命中 / 凭据换了：老流程（转圈等接口）
 * - server 端 /api/models 另有 10 分钟内存缓存、双层叠加后台刷新也快
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { AgentProviderId, CustomProviderFormat, ModelOption } from "@/lib/types";

export interface ModelsFetchInput {
  apiKey: string;
  /** 自定义 provider 的 baseUrl；有值走 /v1/models、无值走 Cursor SDK */
  baseUrl?: string;
  format?: CustomProviderFormat;
  /** 当前 Agent 后端，参与缓存 key 区分（cursor / custom） */
  provider?: AgentProviderId;
}

export interface ModelsFetchOptions {
  /** 用户手动触发（如点「获取列表」）：即使命中缓存也要转圈 + 成功/失败 toast，避免“点击没效果” */
  manual?: boolean;
}

export interface UseModelsResult {
  models: ModelOption[];
  loading: boolean;
  error: string;
  fetchModels: (input: ModelsFetchInput, options?: ModelsFetchOptions) => Promise<void>;
}

const CACHE_KEY = "flowship:models-cache:v5";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// 凭据摘要：缓存归属判定用（不存明文、本地工具够用的弱指纹）
const keyHashOf = (input: ModelsFetchInput): string => {
  const apiKey = input.apiKey ?? "";
  const fmt = input.format ?? "";
  const baseUrl = input.baseUrl ?? "";
  const provider = input.provider ?? "";
  return `${provider}|${apiKey.length}:${apiKey.slice(0, 4)}:${apiKey.slice(-4)}|${baseUrl}|${fmt}`;
};

interface ModelsCache {
  keyHash: string;
  models: ModelOption[];
  ts: number;
}

const readCache = (input: ModelsFetchInput): ModelOption[] | null => {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as ModelsCache;
    if (c.keyHash !== keyHashOf(input)) return null;
    if (Date.now() - c.ts > CACHE_TTL_MS) return null;
    return Array.isArray(c.models) && c.models.length > 0 ? c.models : null;
  } catch {
    return null;
  }
};

const writeCache = (input: ModelsFetchInput, models: ModelOption[]) => {
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ keyHash: keyHashOf(input), models, ts: Date.now() } satisfies ModelsCache),
    );
  } catch {
    // quota 满等失败不影响主流程
  }
};

export const useModels = (): UseModelsResult => {
  // 通过 /api/models 拉到的模型列表（依赖有效凭据）
  const [models, setModels] = useState<ModelOption[]>([]);

  // 模型列表加载中状态、控制刷新按钮 spinner（缓存命中时的后台刷新不置 true）
  const [loading, setLoading] = useState(false);

  // 模型列表拉取的错误信息（凭据错 / 网络错 / 超时）
  const [error, setError] = useState("");

  // 当前 in-flight 请求的 controller、新请求来时 abort 旧的
  const abortRef = useRef<AbortController | null>(null);

  const fetchModels = useCallback(async (input: ModelsFetchInput, options?: ModelsFetchOptions) => {
    const manual = options?.manual ?? false;
    abortRef.current?.abort();

    const trimmedKey = input.apiKey?.trim() ?? "";
    const trimmedBaseUrl = input.baseUrl?.trim() ?? "";
    // 无有效凭据（cursor 无 key / custom 无 baseUrl）→ 清空、不请求
    if (!trimmedKey && !trimmedBaseUrl) {
      setModels([]);
      setError("");
      setLoading(false);
      return;
    }

    // SWR：缓存命中先出数据、后台静默刷新（silent=true 时不转圈、错误不打扰）
    // 手动触发（manual=true）时即使有缓存也走非静默：要转圈 + toast，避免用户觉得“点击没效果”
    const normalized: ModelsFetchInput = {
      provider: input.provider,
      apiKey: trimmedKey,
      baseUrl: trimmedBaseUrl || undefined,
      format: input.format,
    };
    const cached = readCache(normalized);
    const silent = cached !== null && !manual;
    if (cached) {
      setModels(cached);
      setError("");
    } else {
      // 缓存未命中立刻清空——切 provider 时别把上一侧的列表（composer-2.5 等）留在下拉里
      setModels([]);
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
        body: JSON.stringify({
          apiKey: trimmedKey,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
          ...(input.format ? { format: input.format } : {}),
        }),
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
        // 手动触发必须让用户看到失败原因，不能只把错误丢在偏好卡里
        if (manual) {
          toast.error(json.error || `拉取失败（HTTP ${res.status}）`);
        }
        return;
      }
      const fresh: ModelOption[] = json.models || [];
      setModels(fresh);
      writeCache(normalized, fresh);
      // 只在用户手动触发时弹成功 toast；自动拉取（进设置页/后台刷新/首次预热）不打扰
      if (manual) toast.success(`已加载 ${fresh.length} 个模型`);
    } catch (err) {
      // AbortError 是用户主动 abort（比如点了第二次「验证」）、不视为错误
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (ctrl.signal.aborted) return;
      if (!silent) setError(err instanceof Error ? err.message : String(err));
      if (manual) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
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
