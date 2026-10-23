"use client";

/**
 * 团队 wk 流程配置 hook（`~/.wk/config.yaml`）
 *
 * 和 useSettings 的区别：这份配置不在 app 自己的 config.json 里、而是团队 wk-harness 的
 * 本机配置文件（不用 Flowship 的同事也读同一份），所以走 `/api/system/wk-config` 读写。
 *
 * 用法同设置页定式：`update` 改草稿（文本框 onChange）、`save` 落盘
 * （选目录直接调，文本框 onBlur 调）。成功不弹 toast（编辑即存、刷屏没意义），失败才提示。
 *
 * 读取失败时**不许保存**（FE5）：首次读取失败（HTTP 非 2xx / 网络抖动 / 解析失败 / 服务端读文件失败）时草稿是空表单，
 * 而 `save` 是「整份提交」我们托管的那几项——用户在空表单里改一格再失焦，就会拿一份空值把已有的
 * Hub 地址 / Token / 产出目录清掉（服务端是键级合并：同事配的其它键和注释不动，但这几项是团队共用的凭据，丢了得重新去要）。
 * 所以读不到就标 `loadError`、`save` 直接拒绝，卡片据此显示「读取失败 + 重新读取」而不是一份空表单。
 * 服务端配合：文件存在但读不动时 GET 回 500（`read_failed`）、PUT 拒绝写，不再当成「空配置 / 首次写入」
 * （见 server/wk-config.ts；契约见 tests/wk-config-read-failure.test.ts）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { EMPTY_WK_CONFIG, type WkConfig } from "@/lib/wk-config";

export interface UseWkConfigResult {
  /** 编辑中的草稿 */
  config: WkConfig;
  /** 首次读取完成（避免闪空表单） */
  loaded: boolean;
  /** 读取失败（此时 `save` 一律拒绝，不能拿空草稿覆盖已有配置）；`reload` 成功后复位 */
  loadError: string | null;
  /** 重新读一次（读取失败后的出路） */
  reload: () => void;
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
  // 读取失败信息（null = 读成功）+ 同步镜像 ref：save 在事件回调里读它，不能等一次渲染
  const [loadError, setLoadError] = useState<string | null>(null);
  const readOkRef = useRef(false);
  // 重新读取的代次：reload() 自增触发 effect 重跑；effect 清理里 alive=false 作废在途的旧读取
  const [loadSeq, setLoadSeq] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const fail = (reason: string) => {
        if (!alive) return;
        readOkRef.current = false;
        setLoadError(reason);
      };
      try {
        const res = await fetch("/api/system/wk-config");
        if (!res.ok) {
          fail(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { config?: WkConfig; path?: string };
        if (!alive) return;
        if (!data.config) {
          fail("响应里没有配置内容");
          return;
        }
        setConfig(data.config);
        setSaved(data.config);
        savedRef.current = data.config;
        if (data.path) setConfigPath(data.path);
        readOkRef.current = true;
        setLoadError(null);
      } catch (err) {
        // 读不到不再当空配置放行保存——否则下一次失焦就会用空值清掉 ~/.wk/config.yaml 里托管的几项
        fail(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadSeq]);

  const reload = useCallback(() => {
    setLoaded(false);
    setLoadSeq((n) => n + 1);
  }, []);

  const update = useCallback(
    <K extends keyof WkConfig>(key: K, value: WkConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const save = useCallback(async (next: WkConfig): Promise<boolean> => {
    // 没成功读到过现有配置就不落盘：草稿是空表单，提交下去会清掉文件里已有的托管项（见文件头 FE5）
    if (!readOkRef.current) {
      toast.error("还没读到现有配置，为避免覆盖已有内容，未保存。请先点「重新读取」");
      return false;
    }
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

  return { config, loaded, loadError, reload, configPath, saved, update, save };
};
