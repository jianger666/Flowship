"use client";

/**
 * Action artifact 面板（V0.6 重写、原 phase artifact 面板）
 *
 * V0.6 变更：
 *   - 接收 `action: ActionRecord` 而非 `phase: PhaseState`
 *   - 拉 artifact 内容走 `fetchActionRevisions(taskId, actionId)`、自己异步加载
 *   - 修订对比走 `fetchActionDiff(taskId, actionId, from, to)` + buildRevisionView 内联渲染
 *   - PHASE_LABEL → ACTION_LABEL
 *   - looksLikeArtifactRef 返 { n, type }、点击切到目标 action（父组件自己根据 n+type 在 task.actions 里查）
 *
 * 保留：
 *   - 正文常显 +「修订」开关（原 Diff tab 已退役）
 *   - revision 对比基准 Select
 *   - inline code 路径 → cursor:// 跳转
 *   - 红点提示「有未看 revision」（按 actionId 维度记 localStorage）
 *
 * Content 加载策略：
 *   - 进 action / action.endedAt 变化（agent 写完 artifact 后会 setActionStatus）→ 重拉
 *   - revisions 列表跟 content 同一接口返回（`fetchActionRevisions`）、节省一次 fetch
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  Gamepad2,
  Info,
  Layers,
  Loader2,
  Share2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Streamdown,
  defaultRemarkPlugins,
  type Components,
  type ThemeInput,
} from "streamdown";
import { code as streamdownCode } from "@streamdown/code";
import { mermaid as streamdownMermaid } from "@streamdown/mermaid";
import { math as streamdownMath } from "@streamdown/math";
import { cjk as streamdownCjk } from "@streamdown/cjk";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

// Streamdown 插件 / 主题（模块级一份、Shiki 高亮器有初始化开销）
const ARTIFACT_STREAMDOWN_PLUGINS = {
  code: streamdownCode,
  mermaid: streamdownMermaid,
  math: streamdownMath,
  cjk: streamdownCjk,
};
const ARTIFACT_SHIKI_THEME: [ThemeInput, ThemeInput] = [
  "github-light",
  "github-dark",
];
// remark 插件：带上 defaultRemarkPlugins（含 gfm）再追加自定义（同 markdown-text）
const ARTIFACT_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkCodeReference,
  remarkKeepTrailingUnderscore,
  remarkTrimAutolinkCjk,
];

import { MarkdownLink } from "@/components/markdown-link";
import {
  MARKDOWN_PROSE_DOCUMENT,
  STREAMDOWN_CONTROLS,
  STREAMDOWN_REHYPE_PLUGINS,
} from "@/components/markdown-text";
import { EventStreamSearchBar } from "@/components/tasks/event-stream-search-bar";
import { BatchPlanTable } from "@/components/tasks/batch-plan-table";
import { ShareToGroupDialog } from "@/components/tasks/share-to-group-dialog";
import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { Tooltip } from "@/components/ui/tooltip";
import { MarkdownImage } from "@/components/ui/image-preview";
import { LoadingState } from "@/components/ui/loading-state";
import {
  SelectionFloatButton,
  useSelectionFloat,
} from "@/components/ui/selection-float";
import { useShareToGroup } from "@/hooks/use-share-to-group";
import { extractMrUrlsFromText } from "@/lib/mr-inbox";
import {
  SHARE_TO_GROUP_CONTENT_MAX,
  buildSelectionShareInput,
} from "@/lib/share-to-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LocalFileLink,
  LocalFilePathSegments,
  useLocalFilePathLinker,
  type LocalFilePathLinker,
} from "@/components/ui/local-file-link";
import { resolveLocalFileAbsolute } from "@/components/ui/local-file-preview";
import { jumpRevisionHit } from "@/lib/revision-hit";
import { normalizeArtifactSearchQuery } from "@/lib/artifact-search";
import {
  applyDomSearchHighlights,
  clearDomSearchHighlights,
  findRootDomSearchMatches,
  scrollDomSearchMatchIntoView,
  type DomSearchMatch,
} from "@/lib/dom-text-search";
import {
  ARTIFACT_SEARCH_FOCUS_EVENT,
  setActivePaneSearchScope,
} from "@/lib/pane-search";
import {
  stabilizeOccurrenceIndex,
  stepOccurrenceIndex,
} from "@/lib/text-search-highlight";
import {
  hasValidRepoPrefix,
  looksLikeArtifactRef,
  looksLikePath,
  parsePathSegments,
  pathDisplayLabel,
  type ActionArtifactRef,
} from "@/lib/path-utils";
import { remarkCodeReference } from "@/lib/remark-code-reference";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";
import {
  ACTION_LABEL_EN,
  ACTION_LABEL_SHORT,
  type EffectivePlanBatch,
} from "@/lib/task-display";

/** toolbar 展示用（与 md-revision.RevisionStats 结构对齐，避免 panel 依赖 md-revision 运行时） */
type RevisionToolbarStats = {
  ins: number;
  del: number;
  degraded?: boolean;
};

// 修订视图懒加载（含 Streamdown 修订插件 + buildRevisionView），关修订时不进主 chunk
const ArtifactRevisionView = dynamic(
  () =>
    import("@/components/tasks/artifact-revision-view").then(
      (m) => m.ArtifactRevisionView,
    ),
  {
    ssr: false,
    loading: () => <LoadingState variant="block" label="加载修订…" />,
  },
);

// 恐龙快跑懒加载：内联 canvas 引擎较重、且只要客户端；不拖任务页首屏
const DinoRunner = dynamic(
  () =>
    import("@/components/games/dino-runner").then((m) => m.DinoRunner),
  {
    ssr: false,
    loading: () => <LoadingState variant="block" label="加载游戏…" />,
  },
);
import { fetchActionDiff, fetchActionRevisions } from "@/lib/task-store";
import {
  type ActionRecord,
  type ArtifactRevision,
} from "@/lib/types";

// artifact-panel 的标题用「中文（英文）」复合形式
// V0.7：中文部分用 SHORT、跟 timeline 同口径——build 全工作区统一叫「实现」、不再「改代码」
const formatActionTitle = (type: string) => {
  const short = ACTION_LABEL_SHORT[type] ?? type;
  const en = ACTION_LABEL_EN[type];
  return en ? `${short} (${en})` : short;
};

// 短时间格式（dropdown 选项用）：MM-DD HH:mm
const pad2 = (n: number) => String(n).padStart(2, "0");
const formatShortTime = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// artifact 读到空、但 action 已是「该有产物」态时的退避重试参数
// 修「agent 产出了 artifact、但页面停在『没有产物』、要手动刷新 / 切 tab 才看到」：
// 产出那一刻文件刚落盘 / agent 调 submit_work 与写文件有时序差、一次性拉可能读到 null、
// 之后 action.status 不再变 effect 就不会重拉 → 退避重试几次自愈。
//
// V0.6.12 实测加码：agent 第一次 edit 新 artifact 因工具参数名（contents/content）写失败、
// 却抢跑调 submit_work 标了 awaiting_ack（meta 已写 artifactPath、文件却还不存在）、
// 2~3s 后才 thinking「写入失败」并重写落盘——原 5×800ms=4s 固定退避刚好差 ~2s 没等到、
// 停在「没有产物」要切 tab 才出。改指数退避、总时长拉到 ~28s 覆盖 agent 重写落盘的延迟。
const ARTIFACT_LOAD_MAX_RETRIES = 8;
const ARTIFACT_LOAD_BASE_MS = 800; // 首次退避间隔（之后 ×1.7 指数增长）
const ARTIFACT_LOAD_MAX_MS = 5000; // 单次退避上限（指数增长封顶、避免越等越久）

// localStorage key：分 task × actionId 维度
const seenStorageKey = (taskId: string, actionId: string) =>
  `flowship:artifact-revisions-seen:${taskId}:${actionId}`;

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

// 返回体断言成 Streamdown Components——我们的 a/img/code 用宽松 props（string|Blob 等）、
// 跟 Streamdown 严格签名对不上、运行时形状兼容
const buildMarkdownComponents = (
  linker: LocalFilePathLinker,
  repoShortNames: string[] | undefined,
  onArtifactRefClick: ((ref: ActionArtifactRef) => void) | undefined,
): Components => (({
  // markdown 原生链接：http(s) 新窗口 / 系统浏览器、相对路径降级纯文本（V0.7.7）
  a: MarkdownLink,
  // markdown 内嵌图（![]()）走统一组件、点击站内看大图（V0.8.8）
  img: MarkdownImage,
  // 只覆盖 **inline code**（走 Streamdown 的 inlineCode 槽、原来覆盖 code
  // 会连 fenced 一起接管、fenced 失去 Shiki 高亮）——fenced 交给 code 插件的 CodeBlock。
  // inline code 里识别文件路径 / artifact 引用、转可点（预览 Sheet / 跳 action）
  inlineCode: ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const text = String(children ?? "");
    const ref = looksLikeArtifactRef(text);
    if (ref && onArtifactRefClick) {
      return (
        <Tooltip content={`跳到 ${ACTION_LABEL_SHORT[ref.type] ?? ref.type} action #${ref.n}`}>
          <button
            type="button"
            className="group cursor-pointer bg-transparent p-0 align-baseline"
            onClick={() => onArtifactRefClick(ref)}
          >
            <span className="font-mono text-[0.85em] text-info underline-offset-2 group-hover:underline">
              {text}
            </span>
          </button>
        </Tooltip>
      );
    }
    if (looksLikePath(text)) {
      const prefixOk = hasValidRepoPrefix(text, repoShortNames);
      const resolved = prefixOk ? resolveLocalFileAbsolute(text, linker.baseDir) : null;
      const parsed = parsePathSegments(text);
      if (resolved && parsed && parsed.segments.length > 1) {
        return (
          <LocalFilePathSegments
            linker={linker}
            parsedPath={parsed.path}
            segments={parsed.segments}
          />
        );
      }
      if (!resolved) {
        return (
          <Tooltip
            content={
              prefixOk
                ? text
                : `${text}\n（路径缺少仓名前缀、定位不到文件、无法预览）`
            }
          >
            <span {...rest}>
              <span className="font-mono text-[0.85em] text-foreground">{text}</span>
            </span>
          </Tooltip>
        );
      }
      return (
        <LocalFileLink
          linker={linker}
          path={text}
          linkClassName="font-mono text-[0.85em] text-info underline-offset-2 hover:underline"
        >
          {pathDisplayLabel(resolved.absolute)}
        </LocalFileLink>
      );
    }
    return <code {...rest}>{children}</code>;
  },
}) as unknown as Components);

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
  /**
   * 是否可「分享到需求群」。日常轻量任务（无飞书链接）为 false → 隐藏分享按钮。
   * 由父组件用 isLightweightDailyTask 判定后传入。
   */
  canShareToGroup?: boolean;
}

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
  canShareToGroup = false,
}: Props) => {
  const actionTitle = formatActionTitle(action.type);
  const pathLinker = useLocalFilePathLinker(baseDir);
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(pathLinker, repoShortNames, onArtifactRefClick),
    [pathLinker, repoShortNames, onArtifactRefClick],
  );
  // 分享到需求群（确认 dialog + API；日常任务 canShareToGroup=false 不渲按钮）
  // guideDialog = bot 不在群时的手动添加引导（叠在确认 dialog 之上、加完可原地重试）
  const { runShare, guideDialog } = useShareToGroup();
  const [shareOpen, setShareOpen] = useState(false); // 分享确认 dialog 开关
  const [sharing, setSharing] = useState(false); // 整份产物分享飞行中、防双击
  const [sharingSelection, setSharingSelection] = useState(false); // 选中段分享飞行中

  // 产物栏内联搜索
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitIndex, setSearchHitIndex] = useState(-1);
  const [searchHitCount, setSearchHitCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchMatchesRef = useRef<DomSearchMatch[]>([]);
  const lastSearchQueryRef = useRef("");

  const activateArtifactSearch = useCallback(() => {
    setActivePaneSearchScope("artifact");
    setSearchActive(true);
    searchInputRef.current?.focus();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    });
  }, []);

  const closeArtifactSearch = useCallback(() => {
    setSearchActive(false);
    setSearchQuery("");
    setSearchHitIndex(-1);
    setSearchHitCount(0);
  }, []);

  useEffect(() => {
    const onFocusSearch = () => activateArtifactSearch();
    window.addEventListener(ARTIFACT_SEARCH_FOCUS_EVENT, onFocusSearch);
    return () =>
      window.removeEventListener(ARTIFACT_SEARCH_FOCUS_EVENT, onFocusSearch);
  }, [activateArtifactSearch]);

  useEffect(() => {
    closeArtifactSearch();
    lastSearchQueryRef.current = "";
  }, [action.id, closeArtifactSearch]);

  const [revisionOn, setRevisionOn] = useState(false); // 修订开关：开则正文变内联修订视图
  // 产物 / 游戏视图：推进中无产物时自动进游戏，也可随时手动切换摸鱼
  const [panelView, setPanelView] = useState<"artifact" | "game">(() =>
    action.status === "running" ? "game" : "artifact",
  );
  // 本 action 是否已做过「自动进游戏」——用户手动切回产物后不再强拉回游戏
  const autoGameAppliedRef = useRef(false);
  // 本 action 是否已提示过「产物已生成」——从无到有只 toast 一次
  const artifactToastShownRef = useRef(false);
  // 上一次「加载完成后」是否有产物：null = 初始加载还没出结果。
  // 三态是为了区分「挂载后亲眼看到的从无到有」（该 toast）和「remount 时产物本来
  // 就在」（静默显示、不打扰）——从设置页返回会 remount、二态版会误弹（用户实测踩过）
  const prevHadArtifactRef = useRef<boolean | null>(null);
  // 小恐龙是否在局中（onStart/onGameOver 维护）——产物到达时据此决定立即切回还是等局末
  const gamePlayingRef = useRef(false);
  // 产物到达时正在局中 → 记「局末自动切回」标记、Game over 时消费
  const pendingReturnRef = useRef(false);
  // 局末切回的延迟 timer（留 1.5s 看一眼分数）；卸载/手动切走时清理
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // 对比基准时间戳（默认最新快照 =「上次」）
  const [compareFromTs, setCompareFromTs] = useState<number | null>(null);
  // 修订对比两端全文（开修订后拉取）
  const [diffData, setDiffData] = useState<{
    from: { content: string; timestamp: number };
    to: { content: string; timestamp: number | null };
  } | null>(null);
  // 拉对比全文中
  const [diffLoading, setDiffLoading] = useState(false);
  // 拉对比失败文案（null = 无错）；失败时修订区展示 + 重试，避免假「加载修订…」
  const [diffError, setDiffError] = useState<string | null>(null);
  // 子组件算完后回传的词级统计（toolbar +/−）
  const [revisionStats, setRevisionStats] = useState<RevisionToolbarStats | null>(
    null,
  );
  // 强制重拉 diff（重试按钮递增）
  const [diffRetryKey, setDiffRetryKey] = useState(0);
  // localStorage 已读最大 revision timestamp
  const [seenTsLoaded, setSeenTsLoaded] = useState<number>(0);
  // 「上一处 / 下一处」当前 hit 下标（-1 = 尚未跳过）
  const hitIndexRef = useRef(-1);
  // 修订正文滚动容器（跳转 scrollIntoView 用）
  const scrollRef = useRef<HTMLDivElement>(null);
  // 切 action 时读最新 status（不把 status 放进 reset effect 依赖，避免交卷后强切视图）
  const actionStatusRef = useRef(action.status);
  actionStatusRef.current = action.status;

  // 选中正文一段 → 浮「分享到群」（与事件流「引用」同一个公共件）。
  // 修订视图下关掉：那时正文是 diff 标记、选出来的片段带增删痕迹、发出去没意义
  const {
    containerRef: contentRef,
    selection: shareSelection,
    onMouseUp: onContentMouseUp,
    clear: clearShareSelection,
  } = useSelectionFloat({
    enabled: canShareToGroup && !revisionOn,
    maxLength: SHARE_TO_GROUP_CONTENT_MAX,
  });

  // action 维度的「已看」状态：进 action 时读、切 action 时重置
  useEffect(() => {
    setSeenTsLoaded(readSeenTs(taskId, action.id));
    setRevisionOn(false);
    setDiffData(null);
    setDiffError(null);
    setRevisionStats(null);
    hitIndexRef.current = -1;
    // 切 action（或 remount）按自动规则重算默认视图：running → 先默认游戏（等待产物）
    autoGameAppliedRef.current = false;
    artifactToastShownRef.current = false;
    prevHadArtifactRef.current = null;
    const defaultGame = actionStatusRef.current === "running";
    setPanelView(defaultGame ? "game" : "artifact");
    if (defaultGame) autoGameAppliedRef.current = true;
  }, [taskId, action.id]);

  // 同 action 内：推进刚变为 running 且还没有产物 → 自动切到游戏（只自动一次）
  useEffect(() => {
    if (autoGameAppliedRef.current) return;
    if (action.status === "running" && !currentArtifact) {
      setPanelView("game");
      autoGameAppliedRef.current = true;
    }
  }, [action.status, currentArtifact]);

  // 产物从无到有、且用户还停在游戏视图 → 自动切回策略（2026-07-15 用户拍板）：
  // - 没在局中（Game over / 没开跑）→ 直接自动切回产物
  // - 正在局中 → 不打断、toast 带「查看产物」按钮；这局 Game over 后停 1.5s（看眼分数）自动切回
  // 只认「挂载后亲眼看到的 无→有」（基线 false → true）；remount 时产物本来就在
  //（基线 null → true）静默显示产物、不弹 toast——从设置页返回等场景不重复打扰
  useEffect(() => {
    if (contentLoading) return; // 加载中不动基线：还没出结果、谈不上「无→有」
    const hasArtifact = !!currentArtifact;
    const prev = prevHadArtifactRef.current;
    prevHadArtifactRef.current = hasArtifact;
    if (
      !hasArtifact ||
      prev === true ||
      panelView !== "game" ||
      artifactToastShownRef.current
    ) {
      return;
    }
    artifactToastShownRef.current = true;
    if (prev === null) {
      // 初始加载就有产物（remount）：游戏是默认视图不是用户选的、直接静默纠正
      setPanelView("artifact");
      return;
    }
    if (gamePlayingRef.current) {
      pendingReturnRef.current = true;
      toast.success("产物已生成、这局结束后自动切回", {
        duration: 10_000,
        action: {
          label: "立即查看",
          onClick: () => {
            pendingReturnRef.current = false;
            setPanelView("artifact");
          },
        },
      });
    } else {
      setPanelView("artifact");
      toast.success("产物已生成");
    }
  }, [currentArtifact, panelView, contentLoading]);

  // 手动切走 / 卸载时清掉局末切回的余波（防切走后 timer 又把视图拽回来）
  useEffect(() => {
    if (panelView !== "game") {
      pendingReturnRef.current = false;
      if (returnTimerRef.current) {
        clearTimeout(returnTimerRef.current);
        returnTimerRef.current = null;
      }
    }
  }, [panelView]);
  useEffect(
    () => () => {
      if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
    },
    [],
  );

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

  // 修订开启时拉对比两端全文
  useEffect(() => {
    if (!revisionOn || compareFromTs == null) {
      setDiffData(null);
      setDiffError(null);
      setRevisionStats(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setDiffLoading(true);
      setDiffError(null);
      try {
        const data = await fetchActionDiff(
          taskId,
          action.id,
          compareFromTs,
          "current",
        );
        if (cancelled) return;
        setDiffData(data);
        hitIndexRef.current = -1;
      } catch (err) {
        if (cancelled) return;
        console.warn("[artifact-panel] fetch diff 失败", err);
        setDiffData(null);
        setDiffError(
          err instanceof Error ? err.message : "加载修订对比失败",
        );
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [revisionOn, compareFromTs, taskId, action.id, diffRetryKey]);

  const handleRevisionStatsChange = useCallback(
    (stats: RevisionToolbarStats | null) => {
      setRevisionStats(stats);
    },
    [],
  );

  const handleDiffRetry = useCallback(() => {
    setDiffRetryKey((k) => k + 1);
  }, []);

  const hasUnseen = useMemo(
    () =>
      !revisionOn && revisions.some((r) => r.timestamp > seenTsLoaded),
    [revisions, seenTsLoaded, revisionOn],
  );

  const maxRevisionTs = useMemo(
    () =>
      revisions.length > 0
        ? revisions[revisions.length - 1]!.timestamp
        : 0,
    [revisions],
  );

  const revisionsDesc = useMemo(() => [...revisions].reverse(), [revisions]);

  const markRevisionsSeen = useCallback(() => {
    if (maxRevisionTs > 0 && maxRevisionTs > seenTsLoaded) {
      writeSeenTs(taskId, action.id, maxRevisionTs);
      setSeenTsLoaded(maxRevisionTs);
    }
  }, [maxRevisionTs, seenTsLoaded, taskId, action.id]);

  const handleRevisionToggle = useCallback(
    (next: boolean) => {
      setRevisionOn(next);
      if (next) markRevisionsSeen();
      else hitIndexRef.current = -1;
    },
    [markRevisionsSeen],
  );

  const handleJumpHit = useCallback((direction: "prev" | "next") => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    hitIndexRef.current = jumpRevisionHit(
      scroller,
      direction,
      hitIndexRef.current,
    );
  }, []);

  // 后置检查未过：交卷事件不保证落盘、check fail 仍 awaiting_ack（by design）、
  // 以前 postCheck 前端 0 处渲染 → 坏结果被静默吞掉。空态尤其要挂红条、用户才知道「AI 说写了但文件不在」。
  const postCheckFailed = action.postCheck?.passed === false;
  const postCheckBanner = postCheckFailed ? (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">后置检查未通过</div>
        <div className="mt-0.5 whitespace-pre-wrap text-xs text-destructive/90">
          {action.postCheck!.details}
        </div>
      </div>
    </div>
  ) : null;

  const artifactBody = currentArtifact?.content ?? "";
  const isSearchFiltering =
    searchActive &&
    !revisionOn &&
    normalizeArtifactSearchQuery(searchQuery).length > 0;

  useEffect(() => {
    if (!isSearchFiltering) {
      setSearchHitIndex(-1);
      setSearchHitCount(0);
      return;
    }
    setSearchHitIndex((prev) =>
      stabilizeOccurrenceIndex(prev, searchHitCount),
    );
  }, [isSearchFiltering, searchHitCount]);

  const goToSearchHit = useCallback((index: number) => {
    if (index < 0 || index >= searchHitCount) return;
    setSearchHitIndex(index);
  }, [searchHitCount]);

  const goToNextSearchHit = useCallback(() => {
    const next = stepOccurrenceIndex(
      searchHitIndex,
      searchHitCount,
      "next",
    );
    if (next >= 0) goToSearchHit(next);
  }, [goToSearchHit, searchHitCount, searchHitIndex]);

  const goToPrevSearchHit = useCallback(() => {
    const prev = stepOccurrenceIndex(
      searchHitIndex,
      searchHitCount,
      "prev",
    );
    if (prev >= 0) goToSearchHit(prev);
  }, [goToSearchHit, searchHitCount, searchHitIndex]);

  useEffect(() => {
    if (!isSearchFiltering || searchHitCount === 0) return;
    if (lastSearchQueryRef.current !== searchQuery) {
      lastSearchQueryRef.current = searchQuery;
      goToSearchHit(0);
    }
  }, [goToSearchHit, isSearchFiltering, searchHitCount, searchQuery]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root || !isSearchFiltering || panelView !== "artifact") {
      searchMatchesRef.current = [];
      clearDomSearchHighlights(
        "flowship-artifact-search",
        "flowship-artifact-search-active",
      );
      return;
    }

    let frame = 0;
    const refresh = () => {
      frame = 0;
      const matches = findRootDomSearchMatches(root, searchQuery);
      searchMatchesRef.current = matches;
      setSearchHitCount((count) =>
        count === matches.length ? count : matches.length,
      );
      applyDomSearchHighlights(
        matches,
        "flowship-artifact-search",
        "flowship-artifact-search-active",
        (match) => match.ownerOccurrenceIndex === searchHitIndex,
      );
    };
    const scheduleRefresh = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    scheduleRefresh();
    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearDomSearchHighlights(
        "flowship-artifact-search",
        "flowship-artifact-search-active",
      );
    };
  }, [
    artifactBody,
    contentRef,
    isSearchFiltering,
    panelView,
    searchHitIndex,
    searchQuery,
  ]);

  useEffect(() => {
    if (!isSearchFiltering || searchHitIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      scrollDomSearchMatchIntoView(searchMatchesRef.current[searchHitIndex]);
    });
    return () => cancelAnimationFrame(frame);
  }, [isSearchFiltering, searchHitIndex]);

  // ---- 渲染 ----
  // 整页 loading：仅「产物」视图且尚无内容、且不是推进中（推进中默认游戏，不挡开玩）
  if (
    contentLoading &&
    !currentArtifact &&
    panelView === "artifact" &&
    action.status !== "running"
  ) {
    return <LoadingState variant="block" label="加载产物…" />;
  }

  const totalRevisions = revisions.length;
  const canRevise = totalRevisions > 0;
  const showGame = panelView === "game";

  // 选中段分享：直接发、不再弹确认（选区本身就是用户的明确意图）。
  // kind=message：短内容进卡片正文，不像整份产物那样另发 md 文件。
  const handleShareSelection = async (text: string) => {
    if (sharingSelection) return;
    const input = buildSelectionShareInput(text, actionTitle);
    if (!input) return;
    setSharingSelection(true);
    try {
      // 成败的 toast 由 runShare 收口；发出去了才清选区（失败时保留、方便原样重试）
      if (await runShare(taskId, input)) clearShareSelection(true);
    } finally {
      setSharingSelection(false);
    }
  };

  // 整份产物分享：正文不截断（走 md 文件）；MR 链接复用 extractMrUrlsFromText
  const handleShareConfirm = async () => {
    if (!currentArtifact || sharing) return;
    setSharing(true);
    try {
      const mrUrls = extractMrUrlsFromText(currentArtifact.content);
      const links =
        mrUrls.length > 0
          ? mrUrls.map((url, i) => ({
              label: mrUrls.length === 1 ? "MR" : `MR ${i + 1}`,
              url,
            }))
          : undefined;
      const ok = await runShare(taskId, {
        kind: "artifact",
        title: actionTitle,
        content: currentArtifact.content,
        links,
      });
      if (ok) setShareOpen(false);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      data-pane-search="artifact"
      onPointerDown={() => setActivePaneSearchScope("artifact")}
    >
      {/* toolbar：左视图切换 / 右修订 + 搜索（跟修订同栏、切换别抢戏） */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-4 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <Tooltip content="查看产物">
            <ChoiceButton
              shape="tab"
              selected={panelView === "artifact"}
              onClick={() => setPanelView("artifact")}
              className="inline-flex items-center gap-1"
            >
              <FileText className="size-3.5" />
              产物
            </ChoiceButton>
          </Tooltip>
          <Tooltip content="恐龙快跑">
            <ChoiceButton
              shape="tab"
              selected={panelView === "game"}
              onClick={() => setPanelView("game")}
              className="inline-flex items-center gap-1"
            >
              <Gamepad2 className="size-3.5" />
              等待
            </ChoiceButton>
          </Tooltip>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!showGame && !revisionOn && currentArtifact && (
            <EventStreamSearchBar
              active={searchActive}
              query={searchQuery}
              hitIndex={searchHitIndex}
              hitCount={searchHitCount}
              onActivate={activateArtifactSearch}
              onQueryChange={setSearchQuery}
              onClose={closeArtifactSearch}
              onPrev={goToPrevSearchHit}
              onNext={goToNextSearchHit}
              inputRef={searchInputRef}
              placeholder="搜索产物…"
              ariaLabel="搜索产物"
              className="mr-1"
            />
          )}
          {/* 有飞书链接 + 有产物正文才显示；日常轻量任务隐藏 */}
          {canShareToGroup && currentArtifact && (
            <Tooltip content="分享到需求群">
              <span className="inline-flex">
                <ChoiceButton
                  shape="tab"
                  selected={false}
                  disabled={sharing}
                  onClick={() => setShareOpen(true)}
                  className="inline-flex items-center gap-1"
                >
                  {sharing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Share2 className="size-3.5" />
                  )}
                  分享到群
                </ChoiceButton>
              </span>
            </Tooltip>
          )}
          <Tooltip
            content={
              canRevise
                ? hasUnseen
                  ? "AI 有新的修订、打开看改了哪"
                  : revisionOn
                    ? "关闭修订视图"
                    : "打开修订视图（Track Changes）"
                : "该 action 还没有修订记录、用户「再聊聊」一次后才会有"
            }
          >
            <span className="inline-flex">
              <ChoiceButton
                shape="tab"
                selected={revisionOn}
                onClick={() => handleRevisionToggle(!revisionOn)}
                disabled={!canRevise}
                className="relative"
              >
                修订
                {hasUnseen && (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive ring-2 ring-background"
                  />
                )}
              </ChoiceButton>
            </span>
          </Tooltip>

          {revisionOn && canRevise && (
            <>
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
              {revisionStats && (
                <Tooltip content="词级增删统计">
                  <span className="ml-1 tabular-nums text-[11px] text-muted-foreground">
                    <span className="text-success">+{revisionStats.ins}</span>{" "}
                    <span className="text-destructive">−{revisionStats.del}</span>
                  </span>
                </Tooltip>
              )}
              <Tooltip content="上一处改动">
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-0.5"
                    disabled={!diffData || !!diffError}
                    onClick={() => handleJumpHit("prev")}
                  >
                    <ChevronUp />
                  </Button>
                </span>
              </Tooltip>
              <Tooltip content="下一处改动">
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={!diffData || !!diffError}
                    onClick={() => handleJumpHit("next")}
                  >
                    <ChevronDown />
                  </Button>
                </span>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* 游戏视图：贴面板背景；少 padding 避免再套一层「卡片感」。
          captureGlobalKeys 默认开：按键不要求焦点停在游戏小框上（点了页面别处也能跳、
          2026-07-15 用户反馈「焦点只有那么点」）；组件内部已忽略 input/textarea 的按键、
          右侧聊天输入不受影响；切走视图组件卸载、监听随之移除 */}
      {showGame ? (
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-2 py-3">
          {/* autoStart：进游戏视图就开跑、不用先按键（action 开始即有动静）。
              onStart/onGameOver 喂局中状态：产物到达时局中不打断、局末 1.5s 后自动切回产物 */}
          <DinoRunner
            className="w-full max-w-xl"
            autoFocus
            autoStart
            onStart={() => {
              gamePlayingRef.current = true;
            }}
            onGameOver={() => {
              gamePlayingRef.current = false;
              if (pendingReturnRef.current) {
                pendingReturnRef.current = false;
                returnTimerRef.current = setTimeout(
                  () => setPanelView("artifact"),
                  1500,
                );
              }
            }}
          />
        </div>
      ) : contentLoading && !currentArtifact ? (
        <LoadingState variant="block" label="加载产物…" />
      ) : !currentArtifact ? (
        <div className="flex flex-1 flex-col">
          {postCheckBanner && (
            <div className="shrink-0 px-6 pt-4">{postCheckBanner}</div>
          )}
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="text-sm text-muted-foreground">
              <div className="mb-2 flex justify-center">
                <FileText className="size-8 opacity-40" />
              </div>
              {action.status === "running"
                ? `${actionTitle} 正在生成产物…`
                : `${actionTitle} 没有产物`}
            </div>
          </div>
        </div>
      ) : (
        /* content area */
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="px-6 py-4">
            {/* 有产物时也显示：检查失败可能是必备段缺失等其它原因、不只是「没落盘」 */}
            {postCheckBanner && <div className="mb-3">{postCheckBanner}</div>}
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
                      {action.replanMode === "append"
                        ? "追加补充需求"
                        : "重建后续"}
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

            {revisionOn ? (
              diffLoading ? (
                <LoadingState variant="block" label="加载修订…" />
              ) : diffError ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <p className="text-sm text-muted-foreground">
                    加载修订失败：{diffError}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDiffRetry}
                  >
                    重试
                  </Button>
                </div>
              ) : diffData ? (
                <ArtifactRevisionView
                  oldMd={diffData.from.content}
                  newMd={diffData.to.content}
                  baseComponents={markdownComponents}
                  onStatsChange={handleRevisionStatsChange}
                />
              ) : (
                <LoadingState variant="block" label="加载修订…" />
              )
            ) : (
              <>
                {/* relative：选区浮动「分享到群」按钮相对本容器定位（跟着滚动一起走） */}
                <div
                  ref={contentRef}
                  className="relative"
                  onMouseUp={onContentMouseUp}
                >
                  {shareSelection && (
                    <SelectionFloatButton
                      state={shareSelection}
                      label="分享到群"
                      disabled={sharingSelection}
                      icon={
                        sharingSelection ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Share2 className="size-3" />
                        )
                      }
                      onTrigger={(text) => void handleShareSelection(text)}
                    />
                  )}
                  {/* max-w-none：覆盖 Tailwind prose 默认的 max-width(65ch) 上限——
                      让正文随左栏拖宽撑满容器、不再卡固定字宽导致右侧大片留白
                      （用户拖中间分隔条把左栏拉宽时、md 应跟着铺满、表格 / 代码块也能多显示） */}
                  <div className={MARKDOWN_PROSE_DOCUMENT}>
                    <Streamdown
                      mode="static"
                      shikiTheme={ARTIFACT_SHIKI_THEME}
                      plugins={ARTIFACT_STREAMDOWN_PLUGINS}
                      remarkPlugins={ARTIFACT_REMARK_PLUGINS}
                      rehypePlugins={STREAMDOWN_REHYPE_PLUGINS}
                      components={markdownComponents}
                      controls={STREAMDOWN_CONTROLS}
                    >
                      {currentArtifact.content}
                    </Streamdown>
                  </div>
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
              </>
            )}
          </div>
        </div>
      )}
      {canShareToGroup && currentArtifact && (
        <ShareToGroupDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          title={actionTitle}
          sharing={sharing}
          onConfirm={() => void handleShareConfirm()}
        />
      )}
      {guideDialog}
    </div>
  );
};
