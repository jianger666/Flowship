"use client";

/**
 * 「团队 wk 流程」配置节（设置页「连接」卡的一节）
 *
 * 放「连接」而不是「仓库」的理由：这两项都是**对接团队 harness 基建**的参数——
 * Delivery Hub 就是一台团队服务器（和 GitLab / 飞书 / 环境配置同类）；WK 产出目录虽是本机目录、
 * 但它和 Hub 写的是同一份 `~/.wk/config.yaml`、属于同一个接入动作，拆开放会让人配一半忘一半。
 * 「仓库」卡管的是业务代码仓（settings.repos → app 自己的 config.json），产出目录不是代码仓、
 * 混进去会污染那边的数据模型。
 *
 * ⚠️ 这里没有「运行前拉取最新产物 / 产物变更推回」两个开关（2026-07-28 用户拍板
 * 「这是理应开启的」）——写文件时固定 true，见 `applyWkConfig`。
 */

import { FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { SettingRow } from "@/components/ui/setting-row";
import { useWkConfig } from "@/hooks/use-wk-config";
import { pickNativePaths } from "@/lib/native-picker";
import { isAbsolutePathLike } from "@/lib/path-utils";
import { cn } from "@/lib/utils";
import { DEFAULT_HUB_BASE_URL } from "@/lib/wk-config";
import { normalizeHubUrl, type WkHubProbeResult, type WkHubProbeStatus } from "@/lib/wk-hub";

/** 探测结论 → 状态点颜色（绿=确认是 hub、黄=连上了但不像 hub、红=不通 / 格式错） */
const PROBE_DOT: Record<WkHubProbeStatus, string> = {
  ok: "bg-success",
  unexpected: "bg-warning",
  unreachable: "bg-destructive",
  "invalid-url": "bg-destructive",
};

export const WkHarnessSection = () => {
  const { config, loaded, configPath, saved, update, save } = useWkConfig();

  // 原生 picker 调用中（防双击连开两个系统对话框）
  const [picking, setPicking] = useState(false);
  /**
   * Delivery Hub 探测结果 + **探的是哪个地址**；null = 还没探 / 没配地址。
   *
   * 地址必须跟着结论一起存：草稿一改（尤其是非法草稿被打回落盘值那下），旧结论说的
   * 就是另一个地址的事了——挂着红点说「地址格式不对」、输入框里却是个好地址，对不上。
   */
  const [probe, setProbe] = useState<(WkHubProbeResult & { url: string }) | null>(
    null,
  );
  // 探测飞行中
  const [probing, setProbing] = useState(false);

  const savedHubUrl = saved.hubBaseUrl;

  const runProbe = useCallback(async (baseUrl: string) => {
    setProbing(true);
    try {
      const res = await fetch("/api/system/wk-config/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<
        WkHubProbeResult & { message: string }
      >;
      setProbe(
        res.ok && data.status
          ? { url: baseUrl, status: data.status, message: data.message ?? "" }
          : {
              url: baseUrl,
              status: "unreachable",
              message: data.message ?? `探测失败（HTTP ${res.status}）`,
            },
      );
    } catch (err) {
      setProbe({
        url: baseUrl,
        status: "unreachable",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProbing(false);
    }
  }, []);

  // 地址落盘后自动探一次（含进页面时的初值）；清空地址就把状态收掉
  useEffect(() => {
    if (!savedHubUrl) {
      setProbe(null);
      return;
    }
    void runProbe(savedHubUrl);
  }, [savedHubUrl, runProbe]);

  const handlePickDocRepo = async () => {
    setPicking(true);
    try {
      const paths = await pickNativePaths({
        mode: "folder",
        prompt: "选择 WK 产出目录",
      });
      // 用户取消静默（pickNativePaths 内部已对失败 toast）
      if (!paths?.[0]) return;
      await save({ ...config, docRepoPath: paths[0] });
    } finally {
      setPicking(false);
    }
  };

  // 文本框失焦落盘：先做一次本地格式校验，省掉一次必然失败的请求
  const handleDocRepoCommit = () => {
    const value = config.docRepoPath.trim();
    if (value && !isAbsolutePathLike(value)) {
      toast.error("WK产出目录要填绝对路径");
      update("docRepoPath", saved.docRepoPath);
      return;
    }
    if (value === saved.docRepoPath) return;
    void save({ ...config, docRepoPath: value });
  };

  const handleHubCommit = () => {
    const value = config.hubBaseUrl.trim();
    // 探不通也还能用（内网 / 没起服务），但格式不对一定是填错——就地打回、不落盘。
    // 草稿必须退回落盘真值（同产出目录那条）：留着非法草稿的话，之后另一格落盘会把
    // 「当前草稿 + 这次改的字段」整份存下去、非法地址反而被带进文件
    if (value && !normalizeHubUrl(value)) {
      toast.error("Delivery Hub 地址格式不对，要形如 http://主机:端口");
      update("hubBaseUrl", saved.hubBaseUrl);
      // 输入框已经换回落盘地址：刚才对着非法草稿点过「测试」的话，结论停在 invalid-url、
      // 说的不是眼前这个地址。savedHubUrl 没变、自动探测那个 effect 不会重跑，这里补一次
      if (saved.hubBaseUrl) void runProbe(saved.hubBaseUrl);
      else setProbe(null);
      return;
    }
    if (value === saved.hubBaseUrl) return;
    void save({ ...config, hubBaseUrl: value });
  };

  if (!loaded) {
    return <LoadingState variant="inline" />;
  }

  // 探测 / 「测试」按钮跟着草稿走：刚敲完地址还没失焦也能点
  const draftHubUrl = config.hubBaseUrl.trim();
  // 只显示「探的就是眼前这个地址」的结论——地址一改，旧结论先收起来，别指着 A 的状态说 B
  const shownProbe = probe?.url === draftHubUrl ? probe : null;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">团队 wk 流程</div>
        {/* 真实绝对路径挂 title：直接铺开会把这行撑成两行 */}
        <p className="text-xs text-muted-foreground" title={configPath}>
          写入 ~/.wk/config.yaml、和团队 wk:* 指令共用
        </p>
      </div>

      <div className="divide-y">
        <SettingRow
          stacked
          label="WK产出目录"
          hint="wk 流程的方案文档落在这个目录的 requirements/<REQ-ID>/ 下"
          control={
            <div className="flex gap-2">
              <Input
                value={config.docRepoPath}
                onChange={(e) => update("docRepoPath", e.target.value)}
                onBlur={handleDocRepoCommit}
                placeholder="/Users/you/wk-doc"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={picking}
                title="选择目录"
                onClick={() => void handlePickDocRepo()}
              >
                {picking ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              </Button>
            </div>
          }
        />

        <SettingRow
          stacked
          label="Delivery Hub"
          hint="共享产物存放地址"
          labelExtra={
            <div className="flex min-w-0 items-center gap-2">
              {probing ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  探测中…
                </span>
              ) : shownProbe ? (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      PROBE_DOT[shownProbe.status],
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate" title={shownProbe.message}>
                    {shownProbe.message}
                  </span>
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={probing || !draftHubUrl}
                onClick={() => void runProbe(draftHubUrl)}
              >
                <RefreshCw />
                测试
              </Button>
            </div>
          }
          control={
            <Input
              value={config.hubBaseUrl}
              onChange={(e) => update("hubBaseUrl", e.target.value)}
              onBlur={handleHubCommit}
              placeholder={DEFAULT_HUB_BASE_URL}
              className="font-mono text-xs"
            />
          }
        />
      </div>
    </div>
  );
};
