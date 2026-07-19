"use client";

/**
 * 设置页「消息桥接」块（提案 4.4b / 决策 #3 #4 #14 #19）
 *
 * 挂在 FeishuCliSection 下方：全局开关 → 展开后引导检查 + 欢迎消息 + 防休眠 / 自启。
 * 开机自启走 window.__autoLaunch（系统层），不进 settings。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { formatRelative } from "@/lib/task-display";
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
  runtime?: {
    overall: string;
    consumers: Array<{
      eventKey: string;
      status: string;
      lastError?: string;
      subscribeUrl?: string;
    }>;
    /** 最近收到飞书消息的时刻（undefined = 本次启动后从未）——收消息自检 */
    lastInboundAt?: number;
  } | null;
  error?: string;
}

/** consumer 事件 key → 人话标题 */
const CONSUMER_LABEL: Record<string, string> = {
  "im.message.receive_v1": "收消息",
  "card.action.trigger": "卡片按钮",
};

/** 问题行的说明：讲作用、不讲技术细节（2026-07-19 用户反馈） */
const CONSUMER_HINT: Record<string, string> = {
  "im.message.receive_v1": "恢复后才能在飞书里回消息",
  "card.action.trigger": "开通后可直接点卡片按钮答题",
};

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

/** 外链「去开通 / 去订阅」——base-ui Button 无 asChild，用 buttonVariants 套 a */
const OpenAuthLink = ({ href, label = "去开通" }: { href: string; label?: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className={cn(
      buttonVariants({ variant: "outline", size: "xs" }),
      "no-underline",
    )}
  >
    {label}
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
  // 卸载守卫：async setState 前检查（对齐 use-settings alive 惯例，R1-17f）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    try {
      const res = await fetch("/api/feishu-bridge/status", { cache: "no-store" });
      const data = (await res.json()) as BridgeStatusPayload;
      if (!mountedRef.current) return;
      if (!res.ok) {
        toast.error(data.error ?? "桥接探测失败");
        return;
      }
      setStatus(data);
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(
        `桥接探测失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (mountedRef.current) setLoading(false);
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
    if (!mountedRef.current) return;
    setWelcomeBusy(true);
    try {
      const res = await fetch("/api/feishu-bridge/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "welcome" }),
      });
      const data = (await res.json()) as { error?: string };
      if (!mountedRef.current) return;
      if (!res.ok) {
        toast.error(data.error ?? "发送欢迎消息失败");
        return;
      }
      toast.success("已发送，去飞书看机器人私聊");
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(
        `发送欢迎消息失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (mountedRef.current) setWelcomeBusy(false);
    }
  };

  const handleAutoLaunch = async (next: boolean) => {
    const api = window.__autoLaunch;
    if (!api || !mountedRef.current) return;
    setAutoLaunchBusy(true);
    try {
      await api.set(next);
      if (!mountedRef.current) return;
      setAutoLaunch(next);
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(
        `设置开机自启动失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (mountedRef.current) setAutoLaunchBusy(false);
    }
  };

  const allGreen =
    !!status?.cli?.ok && !!status?.scopes?.ok && !!status?.cardkit?.ok;

  // 监听器里需要用户处理的问题行（unsupported/conflict/error）
  const problemConsumers = (status?.runtime?.consumers ?? []).filter((c) =>
    ["unsupported", "conflict", "error"].includes(c.status),
  );
  // 全绿（含收到过消息、无问题监听器）→ 检查区收成一行（用户反馈：四行占空间）
  const allChecksOk =
    allGreen &&
    !!status?.runtime?.lastInboundAt &&
    problemConsumers.length === 0;

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
            ) : allChecksOk ? (
              // 全绿收成一行（2026-07-19 用户反馈：四行占空间）；任一有问题才展开逐项
              <CheckRow
                ok
                title="前置检查全部通过"
                detail={`连接 / 权限 / 卡片 / 收消息${
                  status?.runtime?.lastInboundAt
                    ? `（最近收到：${formatRelative(status.runtime.lastInboundAt)}）`
                    : ""
                }`}
              />
            ) : (
              <>
                <CheckRow
                  ok={!!status?.cli?.ok}
                  title="飞书连接就绪"
                  detail={status?.cli?.detail ?? status?.cli?.error}
                />
                <CheckRow
                  ok={!!status?.scopes?.ok}
                  title="权限齐全"
                  detail={status?.scopes?.detail ?? status?.scopes?.error}
                  action={
                    !status?.scopes?.ok && status?.scopes?.authUrl ? (
                      <OpenAuthLink href={status.scopes.authUrl} />
                    ) : undefined
                  }
                />
                <CheckRow
                  ok={!!status?.cardkit?.ok}
                  title="卡片服务可用"
                  detail={status?.cardkit?.detail ?? status?.cardkit?.error}
                  action={
                    !status?.cardkit?.ok && status?.cardkit?.consoleUrl ? (
                      <OpenAuthLink href={status.cardkit.consoleUrl} />
                    ) : undefined
                  }
                />
                {/* 新机器人首次接入：权限没开齐时补「消息订阅」入口——
                    订阅状态探测不到（CLI 连上了也可能没配订阅）、跟权限同批配置最顺手；
                    权限齐了就收起、不常驻打扰 */}
                {!status?.scopes?.ok && status?.scopes?.appId && (
                  <CheckRow
                    ok={false}
                    title="消息订阅"
                    detail="在「事件与回调」里添加：事件 im.message.receive_v1、回调 card.action.trigger（长连接），配完发布版本"
                    action={
                      <OpenAuthLink
                        href={`https://open.feishu.cn/app/${status.scopes.appId}/event`}
                        label="去配置"
                      />
                    }
                  />
                )}
                {/* 收消息自检：订阅配没配对后台探测不到，用「实际收到过消息」当端到端信号。
                    从未收到时给操作指引（发一句→点刷新验证）；收到过就绿灯不啰嗦 */}
                <CheckRow
                  ok={!!status?.runtime?.lastInboundAt}
                  title="收消息自检"
                  detail={
                    status?.runtime?.lastInboundAt
                      ? `最近收到：${formatRelative(status.runtime.lastInboundAt)}`
                      : "在飞书给机器人发一句，然后点刷新——收到即通"
                  }
                />
                {/* 监听器只展示「需要用户动作/关注」的问题行（unsupported/conflict/error）；
                    ready 正常态和启动瞬态（starting/stopped/backoff 几秒内自愈）不展示、
                    避免误解（2026-07-19 用户反馈：正常也一排 stopped 很吓人） */}
                {(status?.runtime?.consumers ?? [])
                  .filter((c) =>
                    ["unsupported", "conflict", "error"].includes(c.status),
                  )
                  .map((c) => (
                    <CheckRow
                      key={c.eventKey}
                      ok={false}
                      title={CONSUMER_LABEL[c.eventKey] ?? c.eventKey}
                      detail={CONSUMER_HINT[c.eventKey] ?? c.lastError}
                      action={
                        c.subscribeUrl ? (
                          <OpenAuthLink href={c.subscribeUrl} label="去订阅" />
                        ) : undefined
                      }
                    />
                  ))}
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
