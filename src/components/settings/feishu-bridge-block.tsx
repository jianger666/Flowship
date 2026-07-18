"use client";

/**
 * 设置页「消息桥接」块（提案 4.4b / 决策 #3 #4 #14 #19）
 *
 * 挂在 FeishuCliSection 下方：全局开关 → 展开后引导检查 + 欢迎消息 + 防休眠 / 自启。
 * 开机自启走 window.__autoLaunch（系统层），不进 settings。
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** GET /api/feishu-bridge/status 响应（与 probe.ts 对齐） */
interface BridgeStatusPayload {
  ok?: boolean;
  cli?: {
    ok: boolean;
    installed: boolean;
    loggedIn: boolean;
    detail?: string;
    error?: string;
  };
  scopes?: {
    ok: boolean;
    appId?: string;
    granted: string[];
    missing: string[];
    authUrl?: string;
    detail?: string;
    error?: string;
  };
  cardkit?: {
    ok: boolean;
    cardId?: string;
    consoleUrl?: string;
    detail?: string;
    error?: string;
  };
  runtime?: null;
  error?: string;
}

const CheckRow = ({
  ok,
  title,
  detail,
  action,
}: {
  ok: boolean;
  title: string;
  detail?: string;
  action?: ReactNode;
}) => (
  <div className="flex items-start gap-2.5 py-2">
    {ok ? (
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-500" />
    ) : (
      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
    )}
    <div className="min-w-0 flex-1">
      <div
        className={cn("text-sm font-medium", ok && "text-muted-foreground")}
      >
        {title}
      </div>
      {detail && (
        <div className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">
          {detail}
        </div>
      )}
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);

/** 外链「去开通」——base-ui Button 无 asChild，用 buttonVariants 套 a */
const OpenAuthLink = ({ href }: { href: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className={cn(
      buttonVariants({ variant: "outline", size: "xs" }),
      "no-underline",
    )}
  >
    去开通
    <ExternalLink className="size-3" />
  </a>
);

export const FeishuBridgeBlock = ({
  feishuChatBridge,
  onFeishuChatBridgeChange,
  feishuBridgeKeepAwake,
  onFeishuBridgeKeepAwakeChange,
}: {
  feishuChatBridge: boolean;
  onFeishuChatBridgeChange: (next: boolean) => void;
  feishuBridgeKeepAwake: boolean;
  onFeishuBridgeKeepAwakeChange: (next: boolean) => void;
}) => {
  // 探测结果快照（null = 尚未拉到）
  const [status, setStatus] = useState<BridgeStatusPayload | null>(null);
  // 探测飞行中
  const [loading, setLoading] = useState(false);
  // 欢迎消息发送中
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  // 开机自启：undefined = 非桌面端 / 尚未读到 → 该行隐藏
  const [autoLaunch, setAutoLaunch] = useState<boolean | undefined>(undefined);
  // 自启读写飞行中
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/feishu-bridge/status", { cache: "no-store" });
      const data = (await res.json()) as BridgeStatusPayload;
      if (!res.ok) {
        toast.error(data.error ?? "桥接探测失败");
        return;
      }
      setStatus(data);
    } catch (err) {
      toast.error(
        `桥接探测失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // 开关打开时拉一次探测
  useEffect(() => {
    if (!feishuChatBridge) return;
    void refresh();
  }, [feishuChatBridge, refresh]);

  // 桌面端读开机自启；无通道则整行隐藏
  useEffect(() => {
    const api = window.__autoLaunch;
    if (!api) return;
    let alive = true;
    void (async () => {
      try {
        const v = await api.get();
        if (alive) setAutoLaunch(v);
      } catch {
        // 读失败当无通道、不展示
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleWelcome = async () => {
    setWelcomeBusy(true);
    try {
      const res = await fetch("/api/feishu-bridge/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "welcome" }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "发送欢迎消息失败");
        return;
      }
      toast.success("已发送，去飞书看机器人私聊");
    } catch (err) {
      toast.error(
        `发送欢迎消息失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setWelcomeBusy(false);
    }
  };

  const handleAutoLaunch = async (next: boolean) => {
    const api = window.__autoLaunch;
    if (!api) return;
    setAutoLaunchBusy(true);
    try {
      await api.set(next);
      setAutoLaunch(next);
    } catch (err) {
      toast.error(
        `设置开机自启动失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAutoLaunchBusy(false);
    }
  };

  const allGreen =
    !!status?.cli?.ok && !!status?.scopes?.ok && !!status?.cardkit?.ok;

  return (
    <div className="space-y-1 border-t pt-3">
      <SettingRow
        label="飞书消息桥接"
        className="py-2"
        control={
          <Switch
            checked={feishuChatBridge}
            onCheckedChange={onFeishuChatBridgeChange}
          />
        }
      />

      {feishuChatBridge && (
        <div className="space-y-3 pl-0.5">
          {/* 引导检查（样式对齐 setup-checklist：勾/叉 + 一行说明 + 动作） */}
          <div className="divide-y rounded-md border px-3">
            {loading && !status ? (
              <div className="py-3">
                <LoadingState variant="inline" />
              </div>
            ) : (
              <>
                <CheckRow
                  ok={!!status?.cli?.ok}
                  title="CLI 已装已登录"
                  detail={status?.cli?.detail ?? status?.cli?.error}
                />
                <CheckRow
                  ok={!!status?.scopes?.ok}
                  title="权限 scope 齐全"
                  detail={status?.scopes?.detail ?? status?.scopes?.error}
                  action={
                    !status?.scopes?.ok && status?.scopes?.authUrl ? (
                      <OpenAuthLink href={status.scopes.authUrl} />
                    ) : undefined
                  }
                />
                <CheckRow
                  ok={!!status?.cardkit?.ok}
                  title="cardkit 可用"
                  detail={status?.cardkit?.detail ?? status?.cardkit?.error}
                  action={
                    !status?.cardkit?.ok && status?.cardkit?.consoleUrl ? (
                      <OpenAuthLink href={status.cardkit.consoleUrl} />
                    ) : undefined
                  }
                />
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              重试
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={welcomeBusy || !allGreen}
              onClick={() => void handleWelcome()}
            >
              {welcomeBusy ? <Loader2 className="animate-spin" /> : null}
              发送欢迎消息
            </Button>
          </div>

          <div className="divide-y">
            <SettingRow
              label="插电时防休眠"
              className="py-2"
              control={
                <Switch
                  checked={feishuBridgeKeepAwake}
                  onCheckedChange={onFeishuBridgeKeepAwakeChange}
                />
              }
            />
            {autoLaunch !== undefined && (
              <SettingRow
                label="开机自启动"
                className="py-2"
                control={
                  <Switch
                    checked={autoLaunch}
                    disabled={autoLaunchBusy}
                    onCheckedChange={(v) => void handleAutoLaunch(v)}
                  />
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
