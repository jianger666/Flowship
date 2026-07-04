"use client";

/**
 * Action artifact 面板（V0.6 重写、原 phase artifact 面板）
 *
 * V0.6 变更：
 *   - 接收 `action: ActionRecord` 而非 `phase: PhaseState`
 *   - 拉 artifact 内容走 `fetchActionRevisions(taskId, actionId)`、自己异步加载
 *   - diff 走 `fetchActionDiff(taskId, actionId, from, to)`
 *   - PHASE_LABEL → ACTION_LABEL
 *   - looksLikeArtifactRef 返 { n, type }、点击切到目标 action（父组件自己根据 n+type 在 task.actions 里查）
 *
 * 保留：
 *   - 正文 / Diff 切换
 *   - revision 选择 dropdown
 *   - inline code 路径 → cursor:// 跳转
 *   - 红点提示「有未看 revision」（按 actionId 维度记 localStorage）
 *
 * Content 加载策略：
 *   - 进 action / action.endedAt 变化（agent 写完 artifact 后会 setActionStatus）→ 重拉
 *   - revisions 列表跟 content 同一接口返回（`fetchActionRevisions`）、节省一次 fetch
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileText, Info, Layers } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MarkdownLink } from "@/components/markdown-link";
import { BatchPlanTable } from "@/components/tasks/batch-plan-table";
import { ChoiceButton } from "@/components/ui/choice-button";
import { MarkdownImage } from "@/components/ui/image-preview";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  buildIdeLink,
  hasValidRepoPrefix,
  looksLikeArtifactRef,
  looksLikePath,
  parsePathSegments,
  type ActionArtifactRef,
} from "@/lib/path-utils";
import { useJumpIde } from "@/hooks/use-settings";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";
import {
  ACTION_LABEL_EN,
  ACTION_LABEL_SHORT,
  type EffectivePlanBatch,
} from "@/lib/task-display";
import { fetchActionDiff, fetchActionRevisions } from "@/lib/task-store";
import {
  JUMP_IDE_LABEL,
  type ActionRecord,
  type ActionType,
  type ArtifactRevision,
  type JumpIde,
} from "@/lib/types";

// V0.5.12 perf：react-diff-viewer-continued 体积大、懒加载
const ArtifactDiff = dynamic(
  () => import("@/components/tasks/artifact-diff").then((m) => m.ArtifactDiff),
  {
    ssr: false,
    loading: () => <LoadingState variant="block" label="加载 diff 库…" />,
  },
);

// artifact-panel 的标题用「中文（英文）」复合形式
// V0.7：中文部分用 SHORT、跟 timeline 同口径——build 全工作区统一叫「实现」、不再「改代码」
const formatActionTitle = (type: ActionType) =>
  `${ACTION_LABEL_SHORT[type]} (${ACTION_LABEL_EN[type]})`;

// 短时间格式（dropdown 选项用）：MM-DD HH:mm
const pad2 = (n: number) => String(n).padStart(2, "0");
const formatShortTime = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// artifact 读到空、但 action 已是「该有产物」态时的退避重试参数
// 修「agent 产出了 artifact、但页面停在『没有产物』、要手动刷新 / 切 tab 才看到」：
// 产出那一刻文件刚落盘 / agent 调 wait_for_user 与写文件有时序差、一次性拉可能读到 null、
// 之后 action.status 不再变 effect 就不会重拉 → 退避重试几次自愈。
//
// V0.6.12 实测加码：agent 第一次 edit 新 artifact 因工具参数名（contents/content）写失败、
// 却抢跑调 wait_for_user 标了 awaiting_ack（meta 已写 artifactPath、文件却还不存在）、
// 2~3s 后才 thinking「写入失败」并重写落盘——原 5×800ms=4s 固定退避刚好差 ~2s 没等到、
// 停在「没有产物」要切 tab 才出。改指数退避、总时长拉到 ~28s 覆盖 agent 重写落盘的延迟。
const ARTIFACT_LOAD_MAX_RETRIES = 8;
const ARTIFACT_LOAD_BASE_MS = 800; // 首次退避间隔（之后 ×1.7 指数增长）
const ARTIFACT_LOAD_MAX_MS = 5000; // 单次退避上限（指数增长封顶、避免越等越久）

// localStorage key：分 task × actionId 维度
const seenStorageKey = (taskId: string, actionId: string) =>
  `fe-ai-flow:artifact-revisions-seen:${taskId}:${actionId}`;

const readSeenTs = (taskId: string, actionId: string): number => {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(seenStorageKey(taskId, actionId));
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
};

const writeSeenTs = (taskId: string, actionId: string, ts: number) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(seenStorageKey(taskId, actionId), String(ts));
  } catch {
    // 忽略 quota 失败
  }
};

const buildMarkdownComponents = (
  baseDir: string | undefined,
  repoShortNames: string[] | undefined,
  ide: JumpIde,
  onArtifactRefClick: ((ref: ActionArtifactRef) => void) | undefined,
): Components => ({
  // markdown 原生链接：http(s) 新窗口 / 系统浏览器、相对路径降级纯文本（V0.7.7）
  // （inline code 路径的 cursor:// 跳转在下面 code 组件、不受影响）
  a: MarkdownLink,
  // markdown 内嵌图（![]()）走统一组件、点击站内看大图（V0.8.8）
  img: MarkdownImage,
  // 只覆盖 inline code、fenced code block 走默认渲染
  code: ({ className, children, ...rest }) => {
    if (className) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    const text = String(children ?? "");
    const ref = looksLikeArtifactRef(text);
    if (ref && onArtifactRefClick) {
      return (
        <button
          type="button"
          className="group cursor-pointer bg-transparent p-0 align-baseline"
          onClick={() => onArtifactRefClick(ref)}
          title={`跳到 ${ACTION_LABEL_SHORT[ref.type]} action #${ref.n}`}
        >
          <span className="font-mono text-[0.85em] text-sky-600 dark:text-sky-400 underline-offset-2 group-hover:underline">
            {text}
          </span>
        </button>
      );
    }
    if (looksLikePath(text)) {
      // 多仓 task：相对路径首段不是任务里的仓名 = agent 漏写仓名前缀、
      // 拼出来的链接必 404（实测弹「路径不存在」）——降级纯文本、不给误导性链接
      const prefixOk = hasValidRepoPrefix(text, repoShortNames);
      const href = prefixOk ? buildIdeLink(text, baseDir, ide) : null;
      // 多段行号（`path:147-175、341-370、485-508`）→ 每段独立链接、点哪段跳哪段
      //   首段渲染 `path:147-175`、后续段渲染 `、341-370`（sep 原样保留、视觉跟原文一致）
      //   单段 / 无行号 / 拼不出链接（href null）→ 走下面原有的整条单链接 / 纯文本分支
      const parsed = parsePathSegments(text);
      if (href && parsed && parsed.segments.length > 1) {
        return (
          <span className="font-mono text-[0.85em]">
            {parsed.segments.map((seg, i) => {
              // 每段单独拼 `path:起始行` 生成各自的跳转目标
              const segHref = buildIdeLink(
                `${parsed.path}:${seg.line}`,
                baseDir,
                ide,
              );
              return (
                <span key={`${seg.line}-${i}`}>
                  {seg.sep}
                  <a
                    href={segHref ?? undefined}
                    className="no-underline"
                    title={`点击在 ${JUMP_IDE_LABEL[ide]} 中打开：${parsed.path}:${seg.line}`}
                  >
                    <span className="text-sky-600 dark:text-sky-400 underline-offset-2 hover:underline">
                      {i === 0 ? `${parsed.path}:${seg.text}` : seg.text}
                    </span>
                  </a>
                </span>
              );
            })}
          </span>
        );
      }
      const inner = (
        <span
          className={cn(
            "font-mono text-[0.85em]",
            href
              ? "text-sky-600 dark:text-sky-400 underline-offset-2 group-hover:underline"
              : "text-foreground",
          )}
        >
          {text}
        </span>
      );
      if (!href) {
        return (
          <span
            title={
              prefixOk
                ? text
                : `${text}\n（路径缺少仓名前缀、定位不到文件、无法跳转）`
            }
            {...rest}
          >
            {inner}
          </span>
        );
      }
      return (
        <a
          href={href}
          className="group no-underline"
          title={`点击在 ${JUMP_IDE_LABEL[ide]} 中打开：${text}`}
        >
          {inner}
        </a>
      );
    }
    return <code {...rest}>{children}</code>;
  },
});

interface Props {
  action: ActionRecord;
  taskId: string;
  baseDir?: string;
  /** 多仓 task 的仓短名清单（相对 baseDir）、用于路径前缀校验；单仓不传 = 不校验 */
  repoShortNames?: string[];
  /**
   * 全量有效批次（plan action 才传、来自 deriveEffectiveBatches）。
   * 批次表用它而非 action.planBatches——追加补充需求后也能看到完整批次盘子 + 进度。
   */
  effectiveBatches?: EffectivePlanBatch[];
  /**
   * 前序 plan 列表（仅追加 / 重建 plan 时传）——在 artifact 顶部给「前序方案」跳转入口、
   * 让用户一键回看主方案、解决追加方案「只见增量、总览难」。
   */
  priorPlans?: Array<{ n: number }>;
  onArtifactRefClick?: (ref: ActionArtifactRef) => void;
  /**
   * 当前 artifact 文件名上报给工作区 Header（V0.7：filename 归 Header、Panel toolbar 不再显示）。
   * null = 没有产物 / 加载中尚无内容。父组件需用 useCallback 稳定引用、否则 effect 反复触发。
   */
  onArtifactMetaChange?: (meta: { filename: string } | null) => void;
}

type ViewMode = "content" | "diff";

const revisionOptionLabel = (
  rev: ArtifactRevision,
  idxInDesc: number,
  total: number,
): string => {
  const time = formatShortTime(rev.timestamp);
  if (idxInDesc === 0) return `${time}（上次）`;
  if (idxInDesc === total - 1) return `${time}（初版）`;
  return time;
};

export const ArtifactPanel = ({
  action,
  taskId,
  baseDir,
  repoShortNames,
  effectiveBatches,
  priorPlans,
  onArtifactRefClick,
  onArtifactMetaChange,
}: Props) => {
  const actionTitle = formatActionTitle(action.type);
  // 代码跳转 IDE 配置（设置页可切 Cursor / IDEA）
  const jumpIde = useJumpIde();
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents(baseDir, repoShortNames, jumpIde, onArtifactRefClick),
    [baseDir, repoShortNames, jumpIde, onArtifactRefClick],
  );

  const [mode, setMode] = useState<ViewMode>("content");
  // artifact 正文（异步加载）+ 文件名
  const [currentArtifact, setCurrentArtifact] = useState<{
    content: string;
    filename: string;
  } | null>(null);
  // 初始 true：组件（含按 action.id remount）一挂载就要拉产物、
  // 首帧直接走「加载产物…」、不闪上一个 action 的内容、也不误显「没有产物」。
  const [contentLoading, setContentLoading] = useState(true);
  // revision 列表
  const [revisions, setRevisions] = useState<ArtifactRevision[]>([]);
  const [compareFromTs, setCompareFromTs] = useState<number | null>(null);
  const [splitView, setSplitView] = useState(false);
  const [diffData, setDiffData] = useState<{
    from: { content: string; timestamp: number };
    to: { content: string; timestamp: number | null };
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [seenTsLoaded, setSeenTsLoaded] = useState<number>(0);

  // action 维度的「已看」状态：进 action 时读、切 action 时重置
  useEffect(() => {
    setSeenTsLoaded(readSeenTs(taskId, action.id));
    setMode("content");
    setDiffData(null);
  }, [taskId, action.id]);

  // filename 上报给工作区 Header（V0.7：filename 归 Header、Panel toolbar 不再显示）。
  // 卸载（selected 切到空态）时报 null、避免 Header 残留上一个产物的文件名。
  useEffect(() => {
    onArtifactMetaChange?.(
      currentArtifact ? { filename: currentArtifact.filename } : null,
    );
  }, [currentArtifact, onArtifactMetaChange]);
  useEffect(() => () => onArtifactMetaChange?.(null), [onArtifactMetaChange]);

  // artifact 内容 + revision 列表一起拉
  // 依赖：action.id + action.endedAt（agent 写完 artifact 会 patchAction(endedAt) ）+ action.status
  // status / endedAt 变化时正文应该刷新
  //
  // 兜底重试：action 已进入「该有产物」态（awaiting_ack / completed）却读到空、
  // 大概率是产出那一刻文件刚落盘 / SSE 事件时序、退避重试几次直到读到（见顶部常量注释）。
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    // 这些状态下 agent 已交卷、artifact 文件理应存在；读到空 = 时序、值得重试
    const shouldHaveArtifact =
      action.status === "awaiting_ack" || action.status === "completed";
    const load = async () => {
      setContentLoading(true);
      // 本次是否安排了重试：是的话保持 loading 态、避免重试间隙闪「没有产物」
      let willRetry = false;
      try {
        const data = await fetchActionRevisions(taskId, action.id);
        if (cancelled) return;
        setCurrentArtifact(data.current);
        setRevisions(data.revisions);
        setCompareFromTs((cur) => {
          if (data.revisions.length === 0) return null;
          if (cur != null && data.revisions.some((r) => r.timestamp === cur)) {
            return cur;
          }
          return data.revisions[data.revisions.length - 1]!.timestamp;
        });
        // 读到空但理应有产物（agent 抢跑标 awaiting_ack / 重写未落盘）→ 指数退避重试
        if (
          !data.current &&
          shouldHaveArtifact &&
          tries < ARTIFACT_LOAD_MAX_RETRIES
        ) {
          const delay = Math.min(
            ARTIFACT_LOAD_BASE_MS * 1.7 ** tries,
            ARTIFACT_LOAD_MAX_MS,
          );
          tries += 1;
          willRetry = true;
          retryTimer = setTimeout(() => void load(), delay);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn("[artifact-panel] fetch revisions 失败", err);
        if (shouldHaveArtifact && tries < ARTIFACT_LOAD_MAX_RETRIES) {
          const delay = Math.min(
            ARTIFACT_LOAD_BASE_MS * 1.7 ** tries,
            ARTIFACT_LOAD_MAX_MS,
          );
          tries += 1;
          willRetry = true;
          retryTimer = setTimeout(() => void load(), delay);
        }
      } finally {
        if (!cancelled && !willRetry) setContentLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // V0.6.12：依赖里加 action.artifactUpdatedAt——agent 每次写成功后端会刷新它、
    // 这里据此事件驱动重拉（不再只靠退避猜落盘时刻、根治「产出后停在『没有产物』」）
  }, [
    taskId,
    action.id,
    action.endedAt,
    action.status,
    action.artifactPath,
    action.artifactUpdatedAt,
  ]);

  // diff 模式下拉对比数据
  useEffect(() => {
    if (mode !== "diff" || compareFromTs == null) {
      setDiffData(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setDiffLoading(true);
      try {
        const data = await fetchActionDiff(
          taskId,
          action.id,
          compareFromTs,
          "current",
        );
        if (cancelled) return;
        setDiffData(data);
      } catch (err) {
        if (cancelled) return;
        console.warn("[artifact-panel] fetch diff 失败", err);
        setDiffData(null);
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [mode, compareFromTs, taskId, action.id]);

  const hasUnseen = useMemo(
    () => mode !== "diff" && revisions.some((r) => r.timestamp > seenTsLoaded),
    [revisions, seenTsLoaded, mode],
  );

  const maxRevisionTs = useMemo(
    () =>
      revisions.length > 0
        ? revisions[revisions.length - 1]!.timestamp
        : 0,
    [revisions],
  );

  const revisionsDesc = useMemo(() => [...revisions].reverse(), [revisions]);

  const handleSwitchToDiff = useCallback(() => {
    setMode("diff");
    if (maxRevisionTs > 0 && maxRevisionTs > seenTsLoaded) {
      writeSeenTs(taskId, action.id, maxRevisionTs);
      setSeenTsLoaded(maxRevisionTs);
    }
  }, [maxRevisionTs, seenTsLoaded, taskId, action.id]);

  // ---- 渲染 ----
  if (contentLoading && !currentArtifact) {
    return <LoadingState variant="block" label="加载产物…" />;
  }

  if (!currentArtifact) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="text-sm text-muted-foreground">
          <div className="mb-2 flex justify-center">
            <FileText className="size-8 opacity-40" />
          </div>
          {action.status === "running"
            ? `${actionTitle} 正在生成产物…`
            : `${actionTitle} 没有产物`}
        </div>
      </div>
    );
  }

  const totalRevisions = revisions.length;
  const canDiff = totalRevisions > 0;

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-b px-4 text-xs">
        <div className="flex shrink-0 items-center gap-1">
          <ChoiceButton
            shape="tab"
            selected={mode === "content"}
            onClick={() => setMode("content")}
          >
            正文
          </ChoiceButton>
          <ChoiceButton
            shape="tab"
            selected={mode === "diff"}
            onClick={handleSwitchToDiff}
            disabled={!canDiff}
            title={
              canDiff
                ? hasUnseen
                  ? "AI 有新的修订、点开看改了哪"
                  : "对比 artifact 修订历史"
                : "该 action 还没有修订记录、用户「再聊聊」一次后才会有"
            }
            className="relative"
          >
            Diff
            {hasUnseen && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-red-500 ring-2 ring-background"
              />
            )}
          </ChoiceButton>

          {mode === "diff" && canDiff && (
            <>
              <ChoiceButton
                shape="tab"
                selected={splitView}
                onClick={() => setSplitView((s) => !s)}
                title={splitView ? "切到行内对比" : "切到并排对比"}
              >
                {splitView ? "并排" : "行内"}
              </ChoiceButton>
              <Select
                // 未选对比版本时用 null 保持受控（undefined 会被判为非受控、选版本后切换会报警告）
                value={compareFromTs == null ? null : String(compareFromTs)}
                onValueChange={(v) => v != null && setCompareFromTs(Number(v))}
              >
                <SelectTrigger size="sm" className="ml-1 max-w-[160px]">
                  <SelectValue>
                    {(value) => {
                      if (value == null) return null;
                      const ts = Number(value);
                      if (!Number.isFinite(ts)) return null;
                      const idx = revisionsDesc.findIndex(
                        (r) => r.timestamp === ts,
                      );
                      if (idx < 0) return null;
                      return revisionOptionLabel(
                        revisionsDesc[idx]!,
                        idx,
                        totalRevisions,
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false}>
                  {revisionsDesc.map((rev, idx) => (
                    <SelectItem
                      key={rev.timestamp}
                      value={String(rev.timestamp)}
                    >
                      {revisionOptionLabel(rev, idx, totalRevisions)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      </div>

      {/* content area */}
      <div className="flex-1 overflow-y-auto">
        {mode === "content" ? (
          <div className="px-6 py-4">
            {/* V0.8.x：追加 / 重建 plan——顶部给前序方案跳转入口、解决「只见增量、总览难」 */}
            {action.type === "plan" &&
              action.replanMode &&
              priorPlans &&
              priorPlans.length > 0 && (
                <div className="mb-3 rounded-md border bg-muted/20 px-3 py-2 text-xs">
                  <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
                    <Layers className="size-3.5 shrink-0" />
                    <span>
                      本方案在以下方案基础上
                      {action.replanMode === "append" ? "追加补充需求" : "重建后续"}
                      、点开可回看完整方案
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {priorPlans.map((p) => (
                      <button
                        key={p.n}
                        type="button"
                        onClick={() =>
                          onArtifactRefClick?.({ n: p.n, type: "plan" })
                        }
                        className="rounded border bg-background px-2 py-0.5 font-medium text-foreground transition-colors hover:border-primary hover:text-primary"
                      >
                        方案 #{p.n}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            {/* V0.6.24 (A')：plan 没拆批次时显式提示——这里用全量有效批次判空（不是单 action
                delta）、避免「追加 plan 自己没上报批次、但 task 其实有批次」时误显示未分批 */}
            {action.type === "plan" &&
              (!effectiveBatches || effectiveBatches.length === 0) && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
                  <Info className="size-3.5 shrink-0" />
                  <span>
                    本方案未分批（单次 build）· 大需求可「再聊聊」让 AI 拆批次
                  </span>
                </div>
              )}
            {/* max-w-none：覆盖 Tailwind prose 默认的 max-width(65ch) 上限——
                让正文随左栏拖宽撑满容器、不再卡固定字宽导致右侧大片留白
                （用户拖中间分隔条把左栏拉宽时、md 应跟着铺满、表格 / 代码块也能多显示） */}
            <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:scroll-mt-4 prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
              <ReactMarkdown
                remarkPlugins={[
                  remarkGfm,
                  remarkKeepTrailingUnderscore,
                  remarkTrimAutolinkCjk,
                ]}
                components={markdownComponents}
              >
                {currentArtifact.content}
              </ReactMarkdown>
            </div>
            {/* V0.8.x：plan 批次表用全量有效批次（deriveEffectiveBatches）、不是单 action delta——
                追加补充需求后也能看到完整批次盘子 b1/b2/b3 + 进度 + 来源 / 本次新增标记 */}
            {action.type === "plan" &&
              effectiveBatches &&
              effectiveBatches.length > 0 && (
                <BatchPlanTable
                  batches={effectiveBatches}
                  currentActionN={action.n}
                />
              )}
          </div>
        ) : diffLoading || !diffData ? (
          <LoadingState variant="block" label="加载 diff…" />
        ) : (
          <div className="px-2 py-2">
            <ArtifactDiff
              oldText={diffData.from.content}
              newText={diffData.to.content}
              splitView={splitView}
              leftTitle={formatShortTime(diffData.from.timestamp)}
              rightTitle={
                diffData.to.timestamp == null
                  ? "当前正文"
                  : formatShortTime(diffData.to.timestamp)
              }
            />
          </div>
        )}
      </div>
    </div>
  );
};
