"use client";

/**
 * 设置页「消息桥接」块（提案 4.4b / 决策 #3 #4 #14 #19）
 *
 * 挂在 FeishuCliSection 下方：全局开关 → 展开后引导检查 + 欢迎消息 + 三个选项
 * （流式回复 / 限制群里非宿主成员 / 机器人与真人同权）。
 * 开机自启 / 插电防休眠已挪到偏好。
 *
 * 文案约定（2026-11-24 用户点名这一块「一大串字」）：每行说明只留一句；休眠会话怎么处理、各后端的工具范围、
 * 所有者备注这些规则收进「更多规则与提示词」折叠区；做决定要看到的风险句（两个开关叠加后机器人也能改文件）留在行内。
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
import {
  GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW,
  GROUP_NON_OWNER_OPEN_NOTE_PREVIEW,
} from "@/lib/group-non-owner-prompt";
import { formatRelative } from "@/lib/task-display";
import { cn } from "@/lib/utils";

/**
 * 三个选项行的文案（label / hint / detail）。提成可导入的常量（S-4）：tests/settings-hint-brevity.test.ts 直接扫这份数据的字数，
 * 不再靠正则从 JSX 里抠 `hint="…"`。改文案只改这里；折叠区里的长段落不在此列（它们是折叠的规则说明，不是「一句话」）。
 *
 * 「限制群里非宿主成员」关着（同权）时到底放开什么、仍拒什么（S-1，2026-11-24 逐项核对代码）：
 * - 放开：读写文件、跑命令等任务 / 代码类能力；
 * - 仍由代码恒拒（flowship-tools.ts 的 GROUP_OPEN_TURN_DENIED_RULES 与 desktop_* 的专用闸）：写所有者备注、新建定时、自动推进、
 *   挂自定义 Action、电脑操作（desktop_*）、浏览器登录态（browser_storage）、页面脚本及其兄弟入口（browser_evaluate / 堆快照 / 可执行 mock /
 *   读运行时变量与带条件断点）、读网络请求 / 响应的正文（browser_network 的 include_body / export_har）、授予 / 拒绝 / 重置页面权限（browser_permissions）。
 * 所以这里不能把「同权」说成工具全放开。只改 UI 文案，不动发给 AI 的提示词（group-non-owner-prompt.ts）。
 *
 * 行内 hint 受字数上限约束（HINT_MAX），装不下全部类别的名字，所以只点名「备注、定时、推进、电脑操作」四个最常被问到的 + 「浏览器里的敏感能力」一个类别；
 * **完整清单在下面折叠区「关」那一段**。清单漏项的风险由 tests/group-copy-wiring.test.ts 反向把关：GROUP_OPEN_TURN_DENIED_RULES 里每一条都必须在折叠区文案里
 * 有对应的词（R20-13：此前只检查「文案里列的都在表里」，表里新增 / 漏列的不会红——实际就漏了网络响应正文与页面权限两类）。
 */
export const FEISHU_ROW_COPY = {
  streaming: {
    label: "流式回复",
    hint: "开：飞书里 AI 的回复边写边出现。关：写完后一次性发整张卡。某个任务的群可在「需求群」弹窗里单独改。",
  },
  nonOwnerGuard: {
    label: "限制群里非宿主成员",
    hint: "开：非宿主成员只答疑、不改代码。关：真人成员可读写文件、跑命令，但备注、定时、推进、电脑操作和浏览器里的敏感能力仍被拒。",
  },
  botsEqualRights: {
    label: "机器人与真人同权",
    hint: "关：别的机器人 @ 只答疑。开：与真人一视同仁、跟随上面的开关——上面关着时，机器人也能让 AI 改文件。",
    detail:
      "机器人唤不醒休眠的会话：会话休眠时机器人的 @ 仍只读答疑，只有「限制」关着时真人成员的 @ 才会把它自动接回来。",
  },
} as const;

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
  feishuChatBridgeSaved = true,
  onFeishuChatBridgeChange,
  feishuBridgeStreaming,
  onFeishuBridgeStreamingChange,
  feishuGroupNonOwnerGuard,
  onFeishuGroupNonOwnerGuardChange,
  feishuGroupBotsEqualRights,
  onFeishuGroupBotsEqualRightsChange,
}: {
  feishuChatBridge: boolean;
  /**
   * 总开关的值**已经落盘**（草稿 = 已保存值，父级的 `!dirty.feishuChatBridge`；缺省 true = 不等落盘，老调用方行为不变）。
   * 为什么要它（R20-15）：乐观更新下开关一拨 `feishuChatBridge` 就变 true，而 PATCH /api/settings 此刻才发出去——
   * 这时拉 /api/feishu-bridge/status，服务端读盘多半还是旧值 false、consumer 还没起，返回「未运行」，之后又没有人再拉一次（只在开关变化时拉一次）。
   * 现在改成「已打开 **且已落盘**」才拉：落盘时服务端已经因写盘通知开始对账，这次 GET 会并入那次对账、等它收尾，读到的是起来之后的状态。
   * 保存失败（重试中 / 被拒回滚）时不拉：盘上的值还没变，拉了也只会读到旧状态。
   */
  feishuChatBridgeSaved?: boolean;
  onFeishuChatBridgeChange: (next: boolean) => void;
  /** 飞书私聊流式回复（全局，默认开：关则回复完成后一次性发整张卡） */
  feishuBridgeStreaming: boolean;
  onFeishuBridgeStreamingChange: (next: boolean) => void;
  /** 群里非宿主成员的提示词约束（全局，默认开；见 group-non-owner-prompt） */
  feishuGroupNonOwnerGuard: boolean;
  onFeishuGroupNonOwnerGuardChange: (next: boolean) => void;
  /** 机器人与真人同权（全局，默认关：别的机器人 @ 始终只答疑） */
  feishuGroupBotsEqualRights: boolean;
  onFeishuGroupBotsEqualRightsChange: (next: boolean) => void;
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

  // 开关打开时拉一次探测——等**落盘之后**（见 feishuChatBridgeSaved 的说明）：刚拨开关、PATCH 还没落盘时先拉会读到旧状态
  useEffect(() => {
    if (!feishuChatBridge || !feishuChatBridgeSaved) return;
    void refresh();
  }, [feishuChatBridge, feishuChatBridgeSaved, refresh]);

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
                {/* 新机器人首次接入引导：订阅状态探测不到，只能当一次性指引。
                    之前只要权限没齐就常驻红——已配好事件、收消息都通了还红，误导。
                    改为只在“从没收到过消息”时才出现，收到过就收起、不常驻打扰 */}
                {!status?.scopes?.ok &&
                  !status?.scopes?.networkError &&
                  status?.scopes?.appId &&
                  !status?.runtime?.lastInboundAt &&
                  !status?.runtime?.everInbound && (
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

          {/* 三个选项一组：和浏览器 / 偏好卡同一个「行 + divide-y」定式。
              每行说明只留一句，放不下的规则进 ⓘ / 折叠区（用户点名过这一块「一大串字」）；
              但「开两个开关叠加后机器人也能改文件」这类要做决定的风险句留在行内、不藏进气泡 */}
          <div className="divide-y border-t pt-3">
            <SettingRow
              {...FEISHU_ROW_COPY.streaming}
              className="py-3"
              control={
                <Switch
                  checked={feishuBridgeStreaming}
                  onCheckedChange={onFeishuBridgeStreamingChange}
                />
              }
            />

            {/* 群里非宿主成员 @ 机器人：并入宿主同一个会话后，「只答疑不改代码」靠提示词 + 系统工具硬拒。
                关 = 群成员与宿主同权——文案必须说清，别让人以为「关 = 恢复旧的受限行为」 */}
            <div className="space-y-2 py-3">
              <SettingRow
                {...FEISHU_ROW_COPY.nonOwnerGuard}
                className="py-0"
                control={
                  <Switch
                    checked={feishuGroupNonOwnerGuard}
                    onCheckedChange={onFeishuGroupNonOwnerGuardChange}
                  />
                }
              />
              <details className="rounded-md border px-3 py-2 text-xs">
                <summary className="cursor-pointer select-none text-muted-foreground">
                  更多规则与提示词（只读）
                </summary>
                <div className="mt-2 space-y-2 text-muted-foreground">
                  {/* 注意：JSX 里在中文句子中间换行会被渲染成一个多余的空格，所以每段写成一行 */}
                  <p>
                    <b>开</b>：交卷 / 提问 / 定时等 Flowship 自带的工具一律被拒。自定义模型只开放读文件 / 搜索；Cursor 模型没有硬限制，只靠提示词。
                  </p>
                  <p>
                    <b>关</b>：群里的<b>真人</b>成员与宿主<b>同权</b>：不限制读写文件和命令；但写所有者备注、新建定时、自动推进、自定义 Action、电脑操作、浏览器登录态、页面脚本（含堆快照、可执行的 mock、读运行时变量和带条件断点）、读网络请求 / 响应的正文、授予 / 拒绝 / 重置页面权限仍被拒；任务会话已休眠（闲置约 12~22 分钟、或重启 Flowship 后）也会被<b>自动接回来</b>；仍不会触发群里的「推进」、不会顶掉你待答的提问。
                  </p>
                  <p>
                    <b>开着时，休眠的任务只能只读答疑</b>：会话没了，群成员 @ 机器人只能读文件 / 搜索，不能改文件、跑命令、造数据；你在任务页说句话或推进一步，通常能把会话接回来。关着时没有可接回的会话（比如任务还没跑起来过、或接回失败）、或对方是机器人且会话已休眠，同样只读答疑。
                  </p>
                  <p>
                    想只放开个别事项、不整体关掉：在任务页「上下文文档」里加一条标题为「所有者备注」的文本，写明授权范围（AI 按你的话记下的备注也在那里，能看能删）。
                  </p>
                </div>
                <pre className="mt-3 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
                  {feishuGroupNonOwnerGuard
                    ? GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW
                    : GROUP_NON_OWNER_OPEN_NOTE_PREVIEW}
                </pre>
                <p className="mt-2 text-muted-foreground">
                  {feishuGroupNonOwnerGuard
                    ? "上面这段会追加在每条并入任务会话的非宿主真人群消息最后（机器人的消息用内容相近的机器人版；任务有「所有者备注」时，真人的会多一条，原文贴在后面）"
                    : "开关关着时，上面这段会追加在每条非宿主真人群消息的最后（告诉 AI 限制已关；机器人另有规则）。其中点名的「交卷 / 提 MR」只是对 AI 的口头约束，代码硬拒的是上面「关」那条列出的几类"}
                  ；「{"{发言人}"}」运行时替换成对方的群昵称。
                </p>
              </details>
            </div>

            <SettingRow
              {...FEISHU_ROW_COPY.botsEqualRights}
              className="py-3"
              control={
                <Switch
                  checked={feishuGroupBotsEqualRights}
                  onCheckedChange={onFeishuGroupBotsEqualRightsChange}
                />
              }
            />
          </div>
        </div>
      )}
    </div>
  );
};
