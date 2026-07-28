"use client";

/**
 * token 用量小 chip（任务详情页顶部 badge 区 + 对话页头部共用、单一来源）
 *
 * 定位是**辅助信息**：一眼看到「最近这一轮烧了多少」，hover 才展开明细（输入 / 输出 /
 * 缓存命中 / 思考 / 累计）。所以是一段 muted 小字、不是徽章也不是进度条。
 *
 * ## 为什么没有百分比 / 占用环
 * 「上下文占用 X%」的分子分母都拿不到，硬凑就是编数字：
 *   - 分母：SDK（@cursor/sdk 1.0.24）从没暴露过模型的 context window——
 *     models.list 返回的 ModelListItem 只有 id / displayName / description /
 *     aliases / parameters / variants；
 *   - 分子：turn-ended 的 inputTokens 是**一轮内所有模型调用的 prompt 之和**
 *     （线上实测单轮 542 万），跟「当前上下文有多长」不是一回事。
 * 拿得到窗口大小之前，这里只显示绝对值。详见 lib/token-usage.ts 顶部注释。
 */

import { Tooltip } from "@/components/ui/tooltip";
import {
  cacheHitRatio,
  formatTokens,
  turnTotalTokens,
} from "@/lib/token-usage";
import type { TokenUsageRollup } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TokenUsageChipProps {
  /** task 级用量；没有（没跑过 / 老数据）时整个 chip 不渲染 */
  usage?: TokenUsageRollup;
  /** 可选：当前查看的 action 用量，多一行「#3 改代码 · 2.1M」 */
  actionUsage?: { label: string; usage: TokenUsageRollup };
  className?: string;
}

/**
 * tooltip 里的一行：左标题右数值。
 * label 自己是 truncate（nowrap）→ min-w-0 必须加在它身上，
 * 不然自定义 action 那种长名字会把数值挤出气泡（见 ui-conventions）。
 */
const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4">
    <span className="min-w-0 truncate text-muted-foreground" title={label}>
      {label}
    </span>
    <span className="shrink-0 font-mono">{value}</span>
  </div>
);

export const TokenUsageChip = ({
  usage,
  actionUsage,
  className,
}: TokenUsageChipProps) => {
  if (!usage) return null;

  const { last, total, turns } = usage;
  const hit = cacheHitRatio(last);
  const detail = (
    <div className="flex w-52 flex-col gap-0.5 text-[11px] leading-relaxed">
      <DetailRow label="本轮输入" value={formatTokens(last.inputTokens)} />
      {hit != null && (
        <DetailRow label="其中缓存命中" value={`${Math.round(hit * 100)}%`} />
      )}
      <DetailRow label="本轮输出" value={formatTokens(last.outputTokens)} />
      {last.reasoningTokens != null && (
        <DetailRow
          label="其中思考"
          value={formatTokens(last.reasoningTokens)}
        />
      )}
      {/* 分隔「本轮」与「累计」两段、否则 #3 改代码 会被误读成本轮的一项 */}
      <div className="my-1 border-t border-border/60" />
      {actionUsage && (
        <DetailRow
          label={actionUsage.label}
          value={formatTokens(turnTotalTokens(actionUsage.usage.total))}
        />
      )}
      <DetailRow
        label={`任务累计 ${turns} 轮`}
        value={formatTokens(turnTotalTokens(total))}
      />
      {/* 不写这句、5.4M 这种数会被当成「上下文快爆了」——它其实是一轮里几十次调用的和 */}
      <div className="mt-1 text-muted-foreground">
        输入 = 一轮内各次模型调用之和
      </div>
    </div>
  );

  return (
    <Tooltip content={detail}>
      <span
        className={cn(
          "shrink-0 cursor-help font-mono text-[11px] text-muted-foreground",
          className,
        )}
      >
        {formatTokens(turnTotalTokens(last))} tok
      </span>
    </Tooltip>
  );
};
