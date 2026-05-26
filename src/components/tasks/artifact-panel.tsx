"use client";

/**
 * 左侧产物面板
 * - 显示当前 active phase 的产物（spec.md / plan.md / build diff）
 * - V1 用 react-markdown + remark-gfm + @tailwindcss/typography prose 类、
 *   表格 / 代码块 / 列表 / 任务清单都能渲染
 * - 没产物时显示占位（"该 phase 还没产物"）
 *
 * V0.5.11 hot-fix（2026-05-25）：去掉「渲染 / 原文」切换
 * - 实际无看 raw markdown 的场景、保留切换徒增心智
 *
 * V0.5.12（2026-05-25）：加 artifact diff 视图
 * - toolbar 加「正文 / Diff」切换、Diff 模式下显示 dropdown 选对比快照
 * - 有未看 revision 时 Diff 按钮右上角挂红点、点 Diff 切过去后红点消失
 *   （第一版用过 banner、用户拍板「简单点」、改成红点提示）
 * - dropdown 走 react-diff-viewer-continued、inline / side-by-side 可切
 * - 「已看」状态走 localStorage 持久化（不污染 task meta、不同浏览器各自独立、可接受）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileText } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChoiceButton } from "@/components/ui/choice-button";
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
  buildCursorLink,
  looksLikeArtifactRef,
  looksLikePath,
} from "@/lib/path-utils";
import { PHASE_LABEL, PHASE_LABEL_EN } from "@/lib/task-display";
import { fetchArtifactDiff, fetchArtifactRevisions } from "@/lib/task-store";
import type { ArtifactRevision, PhaseId, PhaseState } from "@/lib/types";

// V0.5.12 perf：react-diff-viewer-continued 体积大（~36KB First Load JS）、
// 用户 90% 时间在看正文、只有切到 Diff 模式才需要 → next/dynamic 懒加载
// ssr: false：react-diff-viewer 内部用了 DOM API（measureContentColumnWidth 等）、不能 SSR
// loading 元素用项目统一的 LoadingState、跟 diffLoading 占位语义连贯
const ArtifactDiff = dynamic(
  () => import("@/components/tasks/artifact-diff").then((m) => m.ArtifactDiff),
  {
    ssr: false,
    loading: () => <LoadingState variant="block" label="加载 diff 库…" />,
  },
);

// artifact-panel 的标题用「中文（英文）」复合形式、跟单纯展示中文的地方区分
// 不在 task-display 里直接 export 这个变种、避免污染单一职责
const formatPhaseTitle = (id: PhaseState["id"]) =>
  `${PHASE_LABEL[id]} (${PHASE_LABEL_EN[id]})`;

// 短时间格式（dropdown 选项用）：MM-DD HH:mm
const pad2 = (n: number) => String(n).padStart(2, "0");
const formatShortTime = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// localStorage key：分 task × phase 维度、不同 phase 的「已看 revision」状态独立
// 不污染 task meta（uiLayout 已经在那、再塞 seen 状态会让 meta 在每次点 Diff 时频繁回写）
const seenStorageKey = (taskId: string, phaseId: PhaseId) =>
  `fe-ai-flow:artifact-revisions-seen:${taskId}:${phaseId}`;

const readSeenTs = (taskId: string, phaseId: PhaseId): number => {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(seenStorageKey(taskId, phaseId));
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // safari 私密模式 / quota 异常等场景、不阻塞主流程
    return 0;
  }
};

const writeSeenTs = (taskId: string, phaseId: PhaseId, ts: number) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(seenStorageKey(taskId, phaseId), String(ts));
  } catch {
    // 忽略写失败、UI 不报错（next time refresh 再算一遍即可）
  }
};

const buildMarkdownComponents = (
  baseDir: string | undefined,
  onArtifactRefClick: ((phaseId: PhaseId) => void) | undefined,
): Components => ({
  // 只覆盖 inline code、fenced code block 走默认渲染（pre + code）
  code: ({ className, children, ...rest }) => {
    // fenced code block 会带 language-xxx class、跳过；inline 没有
    if (className) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    const text = String(children ?? "");
    // V0.5.8：artifact ref（`01-plan.md` 之类）不含 `/`、走不到 looksLikePath、
    // 单独识别后渲染成「切 tab」按钮、不走 cursor:// 跳转
    const refPhase = looksLikeArtifactRef(text);
    if (refPhase && onArtifactRefClick) {
      return (
        <button
          type="button"
          className="group cursor-pointer bg-transparent p-0 align-baseline"
          onClick={() => onArtifactRefClick(refPhase)}
          title={`跳转到 ${PHASE_LABEL[refPhase]} 产物`}
        >
          <span className="font-mono text-[0.85em] text-sky-600 dark:text-sky-400 underline-offset-2 group-hover:underline">
            {text}
          </span>
        </button>
      );
    }
    if (looksLikePath(text)) {
      const href = buildCursorLink(text, baseDir);
      // 整段路径用一个统一的蓝、不再分目录/文件名颜色（之前淡灰目录反而不好看）
      // 默认无下划线、hover 才上、明确是链接
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
          <span title={text} {...rest}>
            {inner}
          </span>
        );
      }
      return (
        <a
          href={href}
          className="group no-underline"
          title={`点击在 Cursor 中打开：${text}`}
        >
          {inner}
        </a>
      );
    }
    return <code {...rest}>{children}</code>;
  },
});

interface Props {
  phase: PhaseState;
  // V0.5.12：取 revision / diff 都需要 task id
  taskId: string;
  // V0.5.9 改名（原 repoPath）：cursor:// deep link 的基准目录绝对路径
  // - 单仓 = 仓库自身（行为同 V0.5.9 前）
  // - 多仓 = effective cwd（公共父目录、AI 写的路径首段是仓名、跟 cwd 拼回的就是绝对路径）
  // 没传或传空、纯展示、不带链接
  baseDir?: string;
  // V0.5.8：用户点 inline code 形式的 artifact 引用（`01-plan.md` 等）时调它切到对应 phase tab
  // 没传则 artifact ref 退化成普通 inline code（不可点）、纯展示场景用
  onArtifactRefClick?: (phaseId: PhaseId) => void;
}

type ViewMode = "content" | "diff";

// dropdown 选项的 label 文案
// idxInDesc：在倒序列表（最新在前）中的索引、0 = 最新
// total：总 revision 数
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
  phase,
  taskId,
  baseDir,
  onArtifactRefClick,
}: Props) => {
  const phaseLabel = formatPhaseTitle(phase.id);
  // 包过 baseDir / onArtifactRefClick 的 markdown components、避免每次 render 重建
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(baseDir, onArtifactRefClick),
    [baseDir, onArtifactRefClick],
  );

  // ---- V0.5.12 state ----
  // 视图模式：正文 / Diff、默认正文（用户主动切才看 Diff）
  const [mode, setMode] = useState<ViewMode>("content");
  // 当前 phase 的 revision 元数据清单（升序、最老在前）
  const [revisions, setRevisions] = useState<ArtifactRevision[]>([]);
  // diff 的 from 选哪条 revision、null = revisions 为空尚未加载
  // 默认选最新 revision（用户最高频需求：「这次改了啥」= 上次 vs 当前）
  const [compareFromTs, setCompareFromTs] = useState<number | null>(null);
  // side-by-side 还是 inline、默认 inline（artifact-panel 不一定宽、紧凑优先）
  const [splitView, setSplitView] = useState(false);
  // diff 内容（来自 artifact-diff API）
  const [diffData, setDiffData] = useState<{
    from: { content: string; timestamp: number };
    to: { content: string; timestamp: number | null };
  } | null>(null);
  // diff 加载态、避免快速切 dropdown 时旧数据闪烁
  const [diffLoading, setDiffLoading] = useState(false);
  // 当前 mount/进 phase 时读到的「已看 revision ts」（localStorage）
  // 用来跟 revisions 比、判定有没有未看的、有就在 Diff 按钮上挂红点
  const [seenTsLoaded, setSeenTsLoaded] = useState<number>(0);

  // ---- effects ----
  // taskId / phaseId / 当前 artifact 内容变化时 → 重拉 revisions 列表
  // 注意：phase.artifact?.content 在 SSE 推 artifact 帧时会变（AI 改完 artifact 后）、
  // 这时 Diff 按钮红点应该亮起、所以把 content 作为依赖
  // listArtifactRevisions 接口轻（只读 meta、不读 content）、refetch 开销低
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchArtifactRevisions(taskId, phase.id);
        if (cancelled) return;
        setRevisions(data.revisions);
        // 默认 compareFromTs = 最新 revision（按用户视角的「上次」）
        // 但要避免「用户已经手动选了某个、refetch 时被覆盖」
        // 策略：只在 compareFromTs=null 或选的那条已经被 GC 掉时才重设
        setCompareFromTs((cur) => {
          if (data.revisions.length === 0) return null;
          if (cur != null && data.revisions.some((r) => r.timestamp === cur)) {
            return cur;
          }
          return data.revisions[data.revisions.length - 1]!.timestamp;
        });
      } catch (err) {
        if (cancelled) return;
        console.warn("[artifact-panel] fetch revisions 失败", err);
        // 失败不 toast、artifact-panel 主流程不能挂、保留空数组继续显示正文
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [taskId, phase.id, phase.artifact?.content]);

  // taskId / phaseId 变化时读 localStorage seen ts
  // 顺便重置 mode 到 content（切 phase 时用户回到默认正文）
  useEffect(() => {
    setSeenTsLoaded(readSeenTs(taskId, phase.id));
    setMode("content");
    setDiffData(null);
  }, [taskId, phase.id]);

  // mode === "diff" + compareFromTs 变化时 → 拉两份内容
  useEffect(() => {
    if (mode !== "diff" || compareFromTs == null) {
      setDiffData(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setDiffLoading(true);
      try {
        const data = await fetchArtifactDiff(
          taskId,
          phase.id,
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
  }, [mode, compareFromTs, taskId, phase.id]);

  // ---- derived ----
  // 有没有「新于已看 ts」的 revision、Diff 按钮上挂红点用
  // 在 Diff 模式下不挂（用户已经在看 diff、红点冗余）
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

  // 倒序（最新在上）、给 dropdown 用
  const revisionsDesc = useMemo(
    () => [...revisions].reverse(),
    [revisions],
  );

  // ---- handlers ----
  // 切到 Diff 模式时把当前最大 revision ts 标已看、Diff 按钮上的红点消失
  const handleSwitchToDiff = useCallback(() => {
    setMode("diff");
    if (maxRevisionTs > 0 && maxRevisionTs > seenTsLoaded) {
      writeSeenTs(taskId, phase.id, maxRevisionTs);
      setSeenTsLoaded(maxRevisionTs);
    }
  }, [maxRevisionTs, seenTsLoaded, taskId, phase.id]);

  // ---- 渲染 ----
  if (!phase.artifact) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="text-sm text-muted-foreground">
          <div className="mb-2 flex justify-center">
            <FileText className="size-8 opacity-40" />
          </div>
          {phase.status === "pending"
            ? `${phaseLabel} 还未启动`
            : phase.status === "running"
              ? `${phaseLabel} 正在生成产物...`
              : `${phaseLabel} 没有产物`}
        </div>
      </div>
    );
  }

  // Diff 模式下可用的 dropdown：revisions.length === 1 时只有一个选项（同时是「上次」和「初版」）
  // length === 0 时按钮 disabled、不会走到这里
  const totalRevisions = revisions.length;
  const canDiff = totalRevisions > 0;

  return (
    <div className="flex h-full flex-col">
      {/* toolbar：文件名 + 模式切换 + Diff 模式下显示快照 dropdown / 视图切换 */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-4 text-xs">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{phase.artifact.filename}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* 模式切换：正文 / Diff、ChoiceButton tab 形态、视觉跟现有 phase-progress 一致 */}
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
                : "该 phase 还没有修订记录、用户「再聊聊」一次后才会有"
            }
            className="relative"
          >
            Diff
            {/* V0.5.12 红点：有未看 revision 时挂在 Diff 按钮右上角
                点 Diff 切过去后由 handleSwitchToDiff 把 seen ts 推到最大值、红点消失 */}
            {hasUnseen && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-red-500 ring-2 ring-background"
              />
            )}
          </ChoiceButton>

          {/* Diff 模式下：inline/side-by-side 切换 + 快照选择 dropdown
              顺序刻意：dropdown 放最右、popup 向左展开（align="end"）避免盖到右侧别的按钮
              「行内/并排」chip 放 dropdown 左边、popup 弹下来不会重叠 */}
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
                value={compareFromTs == null ? undefined : String(compareFromTs)}
                onValueChange={(v) => setCompareFromTs(Number(v))}
              >
                <SelectTrigger size="sm" className="ml-1 max-w-[160px]">
                  {/* base-ui Select 没传 items prop 时、SelectValue 默认显示 raw value 字符串
                      （这里就是 timestamp 数字 ID）、必须用 children-function 自己 resolve label */}
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
                {/* alignItemWithTrigger=false：popup 弹在 trigger 下方、不覆盖 trigger 位置
                    （base-ui 默认 true 会让选中项叠在 trigger 上、视觉上跟 toolbar 旁边的按钮串味）
                    align=end：popup 跟 trigger 右端对齐、不会向右侧伸出 panel 外 */}
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
          <div className="prose prose-sm dark:prose-invert max-w-none px-6 py-4 prose-headings:scroll-mt-4 prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {phase.artifact.content}
            </ReactMarkdown>
          </div>
        ) : diffLoading || !diffData ? (
          // 加载或拉失败时显示占位、避免 react-diff-viewer 空字符串 diff 闪烁
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
