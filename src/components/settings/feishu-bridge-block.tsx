"use client";

/**
 * 设置页「消息桥接」块（提案 4.4b / 决策 #3 #4 #14 #19）
 *
 * 挂在 FeishuCliSection 下方：全局开关 → 展开后引导检查 + 欢迎消息。
 * 开机自启 / 插电防休眠已挪到偏好。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
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
import {
  FEISHU_CONSUMER_LABEL,
  feishuConsumerIssueDetail,
  feishuConsumerIssueTone,
  isFeishuConsumerBlocking,
  type FeishuCheckTone,
} from "@/lib/feishu-bridge-display";
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
    /** 网络类失败——不是权限问题、不渲染「去开通」/首次接入引导 */
    networkError?: boolean;
  };
  cardkit?: {
    ok: boolean;
    cardId?: string;
    consoleUrl?: string;
    detail?: string;
    error?: string;
    networkError?: boolean;
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
    /** 历史上收到过（时间未知）——自检按通过展示 */
    everInbound?: boolean;
    /** 群消息认不出 @（bot 身份取不到）——群回流此刻是哑的 */
    groupMentionUnavailable?: boolean;
  } | null;
  error?: string;
}

const CHECK_TONE_ICON = {
  ok: { Icon: CheckCircle2, className: "text-success" },
  warning: { Icon: AlertTriangle, className: "text-warning" },
  error: { Icon: XCircle, className: "text-destructive" },
} as const;

const CheckRow = ({
  ok,
  tone,
  title,
  detail,
  action,
}: {
  ok?: boolean;
  /** 覆盖 ok：conflict 用 warning，不当成失败红叉 */
  tone?: FeishuCheckTone;
  title: string;
  detail?: string;
  action?: ReactNode;
}) => {
  const resolved: FeishuCheckTone = tone ?? (ok ? "ok" : "error");
  const { Icon, className: iconClass } = CHECK_TONE_ICON[resolved];
  return (
    <div className="flex items-start gap-2.5 py-2">
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-sm font-medium",
            resolved === "ok" && "text-muted-foreground",
          )}
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
};

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
}: {
  feishuChatBridge: boolean;
  onFeishuChatBridgeChange: (next: boolean) => void;
}) => {
  // 探测结果快照（null = 尚未拉到）
  const [status, setStatus] = useState<BridgeStatusPayload | null>(null);
  // 探测飞行中
  const [loading, setLoading] = useState(false);
  // 欢迎消息发送中
  const [welcomeBusy, setWelcomeBusy] = useState(false);
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
        toast.error(data.error ?? "发送失败");
        return;
      }
      toast.success("已发送，去飞书看机器人私聊");
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(
        `发送失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (mountedRef.current) setWelcomeBusy(false);
    }
  };

  const allGreen =
    !!status?.cli?.ok && !!status?.scopes?.ok && !!status?.cardkit?.ok;

  const consumers = status?.runtime?.consumers ?? [];
  // 没开通 / 监听挂了才算坏；conflict = 本机另一处已占长连接，飞书往往仍可用
  const blockingConsumers = consumers.filter((c) =>
    isFeishuConsumerBlocking(c.status),
  );
  const attentionConsumers = consumers.filter((c) =>
    ["unsupported", "conflict", "error"].includes(c.status),
  );
  // 全绿（含收到过消息、无阻塞监听故障、群 @ 认得出）→ 检查区收成一行
  // conflict 不挡收拢：自检已绿说明飞书在收，只在底下留注意行
  const allChecksOk =
    allGreen &&
    (!!status?.runtime?.lastInboundAt || !!status?.runtime?.everInbound) &&
    !status?.runtime?.groupMentionUnavailable &&
    blockingConsumers.length === 0;

  const consumerIssueRows = attentionConsumers.map((c) => (
    <CheckRow
      key={c.eventKey}
      tone={feishuConsumerIssueTone(c.status)}
      title={FEISHU_CONSUMER_LABEL[c.eventKey] ?? c.eventKey}
      detail={feishuConsumerIssueDetail(c)}
      action={
        c.subscribeUrl ? (
          <OpenAuthLink href={c.subscribeUrl} label="去订阅" />
        ) : undefined
      }
    />
  ));

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
              // 全绿收成一行（2026-07-19 用户反馈：四行占空间）；阻塞项才展开逐项
              <>
                <CheckRow
                  ok
                  title="前置检查全部通过"
                  detail={`连接 / 权限 / 卡片 / 收消息${
                    status?.runtime?.lastInboundAt
                      ? `（最近收到：${formatRelative(status.runtime.lastInboundAt)}）`
                      : ""
                  }`}
                />
                {consumerIssueRows}
              </>
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
                {!status?.scopes?.ok &&
                  !status?.scopes?.networkError &&
                  status?.scopes?.appId && (
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
                    从未收到 = 初次绑定还没完成，给操作指引；收到过就绿灯不啰嗦 */}
                <CheckRow
                  ok={
                    !!status?.runtime?.lastInboundAt ||
                    !!status?.runtime?.everInbound
                  }
                  title="收消息自检"
                  detail={
                    status?.runtime?.lastInboundAt
                      ? `最近收到：${formatRelative(status.runtime.lastInboundAt)}`
                      : status?.runtime?.everInbound
                        ? "曾收到过消息"
                        : "初次绑定：在飞书给机器人发一句，点刷新验证"
                  }
                />
                {/* 群消息认不出 @：bot open_id 与应用名都取不到时群回流整条哑掉、
                    现象只有「机器人在群里不理人」——必须摆出来，别静默 */}
                {status?.runtime?.groupMentionUnavailable && (
                  <CheckRow
                    ok={false}
                    title="群消息认不出 @"
                    detail="取不到机器人身份、群里 @ 它不会有反应，点刷新重试或重新授权 lark-cli"
                  />
                )}
                {/* 监听器只展示「需要用户动作/关注」的问题行（unsupported/conflict/error）；
                    ready 正常态和启动瞬态（starting/stopped/backoff 几秒内自愈）不展示、
                    避免误解（2026-07-19 用户反馈：正常也一排 stopped 很吓人） */}
                {consumerIssueRows}
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
              机器人打招呼
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
