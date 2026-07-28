"use client";

/**
 * 团队 wk 流程配置 hook（`~/.wk/config.yaml`）
 *
 * 和 useSettings 的区别：这份配置不在 app 自己的 config.json 里、而是团队 wk-harness 的
 * 本机配置文件（不用 Flowship 的同事也读同一份），所以走 `/api/system/wk-config` 读写。
 *
 * 用法同设置页定式：`update` 改草稿（文本框 onChange）、`save` 落盘
 * （选目录直接调，文本框 onBlur 调）。成功不弹 toast（编辑即存、刷屏没意义），失败才提示。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { EMPTY_WK_CONFIG, type WkConfig } from "@/lib/wk-config";

export interface UseWkConfigResult {
  /** 编辑中的草稿 */
  config: WkConfig;
  /** 首次读取完成（避免闪空表单） */
  loaded: boolean;
  /** 配置文件绝对路径，显示「写到哪」用 */
  configPath: string;
  /** 落盘后的真值（探测等副作用跟着它走、不跟草稿） */
  saved: WkConfig;
  update: <K extends keyof WkConfig>(key: K, value: WkConfig[K]) => void;
  /**
   * 整份落盘。调用方一律传「当前草稿 + 这次改的字段」——
   * 这样「一格还没失焦就去改另一格」也能一次存对（不会丢掉没提交的草稿）。
   */
  save: (next: WkConfig) => Promise<boolean>;
}

export const useWkConfig = (): UseWkConfigResult => {
  // 草稿态（UI 双向绑定）
  const [config, setConfig] = useState<WkConfig>(EMPTY_WK_CONFIG);
  // 已落盘态（服务端回读的真值）
  const [saved, setSaved] = useState<WkConfig>(EMPTY_WK_CONFIG);
  // 首次读取是否完成
  const [loaded, setLoaded] = useState(false);
  // `~/.wk/config.yaml` 绝对路径（服务端给，客户端拿不到 homedir）
  const [configPath, setConfigPath] = useState("");
  // 落盘真值的 ref：连续存不同字段时基于「最新落盘值」拼整份 payload、不会互相覆盖
  const savedRef = useRef<WkConfig>(EMPTY_WK_CONFIG);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/system/wk-config");
        if (!res.ok) return;
        const data = (await res.json()) as { config?: WkConfig; path?: string };
        if (!alive || !data.config) return;
        setConfig(data.config);
        setSaved(data.config);
        savedRef.current = data.config;
        if (data.path) setConfigPath(data.path);
      } catch {
        // 读不到就当空配置、不挡设置页
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(
    <K extends keyof WkConfig>(key: K, value: WkConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const save = useCallback(async (next: WkConfig): Promise<boolean> => {
    // 先乐观更新，开关拨下去立刻有反馈；失败再整体回滚到落盘真值
    setConfig(next);
    try {
      const res = await fetch("/api/system/wk-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: next }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        config?: WkConfig;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        toast.error(
          `保存失败：${data.message ?? data.error ?? `HTTP ${res.status}`}`,
        );
        setConfig(savedRef.current);
        return false;
      }
      // 服务端会做归一（地址规范化、没配过时补团队默认值）、以回读结果为准
      const fresh = data.config ?? next;
      savedRef.current = fresh;
      setSaved(fresh);
      setConfig(fresh);
      return true;
    } catch (err) {
      toast.error(
        `保存失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setConfig(savedRef.current);
      return false;
    }
  }, []);

  return { config, loaded, configPath, saved, update, save };
};
