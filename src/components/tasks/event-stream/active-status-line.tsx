"use client";

/**
 * 运行中粘性状态行（CHAT-REDESIGN Batch B）
 *
 * Composer 上方一行：当前步骤 label + 可选已等待秒数 + 可选 detail。
 * 动效收敛（事件流 v2）：整行只有 label 的 shimmer 一处在动——左边的点是静态 info 色点
 * （旧版这里还有一个脉冲点，加上组头 / 成员 spinner 同屏三四处同时在动，抢注意力）。
 * shimmer 的 keyframes 在 globals.css（.status-shimmer），prefers-reduced-motion 下整体静态。
 *
 * 唯一的内部状态是「已等待」走字：status 带 sinceTs（工具执行中 / 子代理 / 工具跑完等模型）时，
 * 每秒刷新一次、等够 3 秒才显示「· 12s」，让人随时能回答「等了多久、是不是卡住了」。
 * 没有 sinceTs 的状态（启动 / 思考 / 回复 / 压缩）不起定时器、整个组件仍是纯展示。
 *
 * 静默兜底（status.stallSinceTs）：这一步是「空等」类、且给出了「上一次活动的时间」时，
 * 用一个 setTimeout（不是 interval）等到静默超过阈值（STATUS_STALL_AFTER_MS），
 * 然后把文案换成「仍在等待 · 已 Ns」，走字交还给上面的 useElapsedMs。
 * 用来兜 SDK 里对我们不可见的等待（如 Cursor 原生 await 的 sleep）——事件流在这期间一片空白，
 * 否则状态行要么静态说「思考中」、要么对着睡觉的模型说「正在分析 X 的结果」。
 */

import { useEffect, useState } from "react";

import {
  type ActiveStatus,
  formatStatusElapsed,
  msUntilStall,
  stallFallbackStatus,
} from "@/lib/chat-turns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 走字刷新间隔：秒级显示，1s 足够，比 PendingRow 的 500ms 省一半重渲染 */
const ELAPSED_TICK_MS = 1000;

/**
 * 这个锚点（stallSinceTs）对应的静默是不是已经够久。
 *
 * 状态存的是「哪个锚点已经够久」而不是布尔：来了新事件、锚点换成新值的那一帧，
 * 旧的「够久」立刻失效（锚点对不上），不会拿新状态顶着旧的「仍在等待」闪一帧。
 * 只起一次 setTimeout：到点翻一次状态就够了，之后的逐秒走字归 useElapsedMs。
 */
const useStalled = (stallSinceTs: number | undefined): boolean => {
  const [stalledFor, setStalledFor] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (stallSinceTs === undefined) return;
    const remaining = msUntilStall(stallSinceTs, Date.now());
    if (remaining <= 0) {
      setStalledFor(stallSinceTs);
      return;
    }
    const id = window.setTimeout(() => setStalledFor(stallSinceTs), remaining);
    return () => window.clearTimeout(id);
  }, [stallSinceTs]);
  return stallSinceTs !== undefined && stalledFor === stallSinceTs;
};

/**
 * 距 sinceTs 已过去的毫秒数；sinceTs 缺省 = 这一步不计时（返回 null、不起定时器）。
 * sinceTs 变化 = 换了一步（比如一个工具跑完、下一个开始），立刻按新起点重算、重新开始走字。
 */
const useElapsedMs = (sinceTs: number | undefined): number | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sinceTs === undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [sinceTs]);
  // 本机时钟和事件 ts 理论上同源，但容许轻微回拨 / 先于落盘的差值：钳到 0
  return sinceTs === undefined ? null : Math.max(0, now - sinceTs);
};

export const ActiveStatusLine = ({
  status: base,
  onSkipWait,
}: {
  status: ActiveStatus;
  /**
   * 「跳过等待」：仅 status.skippable（`wait` 工具在跑）时画按钮。抛错 / 失败由调用方自己提示，
   * 这里只负责「点了就禁用、处理完恢复」，别让人连点出一串请求。
   */
  onSkipWait?: () => void | Promise<void>;
}) => {
  const [skipping, setSkipping] = useState(false);
  const stalled = useStalled(base.stallSinceTs);
  // 静默够久 → 换成「仍在等待」；sinceTs 随之变成上一次活动的时间、useElapsedMs 据此开始走字
  const status =
    stalled && base.stallSinceTs !== undefined
      ? stallFallbackStatus(base.stallSinceTs)
      : base;
  const elapsedMs = useElapsedMs(status.sinceTs);
  const elapsed = elapsedMs === null ? null : formatStatusElapsed(elapsedMs);
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 px-1 text-xs">
      {/* 静态 info 色点（running = info）：不动，动效留给 label 的 shimmer */}
      <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden />
      <span
        className={cn(
          "status-shimmer shrink-0 bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground",
          "bg-[length:200%_100%] bg-clip-text text-transparent",
        )}
      >
        {status.label}
      </span>
      {elapsed ? (
        // tabular-nums：数字等宽，逐秒走字时不抖动后面的 detail
        <span className="shrink-0 tabular-nums text-muted-foreground">
          · {elapsed}
        </span>
      ) : null}
      {status.detail ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {status.detail}
        </span>
      ) : null}
      {status.skippable && onSkipWait ? (
        // 跳过等待：叫醒那个在睡的 wait，模型收到 [WAIT_SKIPPED] 后继续往下做。
        // ml-auto：detail 没有时（flex-1 不在）也贴右；h-6 放得进 h-7 的行、不撑高状态行
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto shrink-0 text-muted-foreground"
          disabled={skipping}
          onClick={async () => {
            setSkipping(true);
            try {
              await onSkipWait();
            } finally {
              setSkipping(false);
            }
          }}
        >
          跳过等待
        </Button>
      ) : null}
    </div>
  );
};
