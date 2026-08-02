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
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { PasswordInput } from "@/components/ui/password-input";
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

  const runProbe = useCallback(async (baseUrl: string, token?: string) => {
    setProbing(true);
    try {
      const res = await fetch("/api/system/wk-config/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 有草稿时测试草稿；没草稿时服务端会用 ~/.wk/config.yaml 里的已保存 Token。
        body: JSON.stringify({ baseUrl, ...(token ? { token } : {}) }),
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
  }, [savedHubUrl, saved.hubToken, runProbe]);

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
    if (value && !normalizeHubUrl(value)) {
      toast.error("Delivery Hub 地址格式不对，要形如 http://主机:端口");
      update("hubBaseUrl", saved.hubBaseUrl);
      return;
    }
    if (value === saved.hubBaseUrl) return;
    void save({ ...config, hubBaseUrl: value });
  };

  const handleTokenCommit = () => {
    const value = config.hubToken.trim();
    if (value === saved.hubToken) return;
    void save({ ...config, hubToken: value });
  };

  const handleTokenClear = async () => {
    await save({ ...config, hubToken: "" });
  };

  if (!loaded) {
    return <LoadingState variant="inline" />;
  }

  // 探测 / 「测试连接」按钮跟着草稿走：地址和 Token 都没失焦也能先一起验证
  const draftHubUrl = config.hubBaseUrl.trim();
  // 只显示「探的就是眼前这个地址」的结论——地址一改，旧结论先收起来，别指着 A 的状态说 B
  const shownProbe = probe?.url === draftHubUrl ? probe : null;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">团队 wk 流程</div>
        {/* 真实绝对路径挂 title：直接铺开会把这行撑成两行 */}
        <Tooltip content={configPath}>
          <p className="text-xs text-muted-foreground">
            写入 ~/.wk/config.yaml、和团队 wk:* 指令共用
          </p>
        </Tooltip>
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
              <Tooltip content="选择目录">
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={picking}
                    onClick={() => void handlePickDocRepo()}
                  >
                    {picking ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                  </Button>
                </span>
              </Tooltip>
            </div>
          }
        />

        <SettingRow
          stacked
          label="Delivery Hub"
          hint="共享产物服务地址与访问凭证"
          control={
            <div className="overflow-hidden rounded-xl border bg-muted/20">
              <div className="space-y-4 p-4">
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    服务地址
                  </div>
                  <Input
                    value={config.hubBaseUrl}
                    onChange={(e) => {
                      update("hubBaseUrl", e.target.value);
                      setProbe(null);
                    }}
                    onBlur={handleHubCommit}
                    placeholder={DEFAULT_HUB_BASE_URL}
                    className="bg-background font-mono text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    访问 Token
                  </div>
                  <PasswordInput
                    value={config.hubToken}
                    onChange={(e) => {
                      update("hubToken", e.target.value);
                      // Token 变了，旧的鉴权探测结果立即失效，不能继续显示“已连上”。
                      setProbe(null);
                    }}
                    onBlur={handleTokenCommit}
                    placeholder="wkdh_..."
                    autoComplete="new-password"
                    spellCheck={false}
                    className="bg-background font-mono text-xs"
                    wrapperClassName="min-w-0"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-background/60 px-4 py-3">
                <div className="min-w-0">
                  {probing ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      正在验证地址和 Token…
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
                      <Tooltip content={shownProbe.message}>
                        <span className="min-w-0 truncate">
                          {shownProbe.message}
                        </span>
                      </Tooltip>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      测试会同时验证服务地址和 Token
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {config.hubTokenConfigured ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleTokenClear()}
                    >
                      清除 Token
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={probing || !draftHubUrl}
                    onClick={() =>
                      void runProbe(draftHubUrl, config.hubToken.trim() || undefined)
                    }
                  >
                    <RefreshCw />
                    测试连接
                  </Button>
                </div>
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
};
