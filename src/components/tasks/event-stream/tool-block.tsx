"use client";

/**
 * 工具块 UI（Phase 1）：running→completed 合并渲染 + GB 折叠规则 + inline diff
 *
 * 视觉：图标 + 名称 + 摘要一行；展开区缩进 + 左边线；token 用 muted/border。
 * Chat 打磨：shell 默认折叠、摘要绝不 dump args JSON；运行中直播输出、完成后收起。
 * task 工具：专属「子代理」卡片（Bot 图标 + 任务书 / 产出分区）。
 */

import { memo, useMemo, useState, type CSSProperties } from "react";
import {
  Bot,
  Check,
  Circle,
  CircleSlash,
  FileCode2,
  ListTodo,
  Loader2,
  PanelRightOpen,
  Terminal,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { MarkdownText } from "@/components/markdown-text";
import {
  CopyableBlock,
  type CopyTextSource,
} from "@/components/ui/copy-button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  IdePathLink,
  useIdePathLinker,
  type IdePathLinker,
} from "@/components/ui/ide-path-link";
import { useOpenSubagentDetail } from "@/components/tasks/subagent-detail-context";
import { useDiffSyntaxTokens } from "@/hooks/use-diff-syntax-tokens";
import { useTaskBaseDir } from "@/hooks/use-task-base-dir";
import { diffLanguageFromPath, type DiffSyntaxToken } from "@/lib/diff-syntax";
import { subagentTargetFromToolBlock } from "@/lib/subagent-run-display";
import { isSkippableWaitBlock } from "@/lib/wait-display";
import { cn } from "@/lib/utils";
import {
  countDiffStats,
  isTodoTool,
  parseTaskToolArgs,
  parseTodoToolArgs,
  parseUnifiedDiff,
  todoListSummary,
  toolBlockDefaultCollapsed,
  toolBlockAutoCollapsed,
  toolBlockDetailLine,
  toolBlockExpandedArgsPreview,
  toolBlockFilePath,
  toolBlockSummary,
  toolDetailPathSegment,
  toolPathNeedsBaseDir,
  verbGroupLabel,
  type DiffViewLine,
  type TodoItem,
  type ToolBlock,
  type ToolVerbGroup,
} from "@/lib/tool-display";
import {
  CollapseChevron,
  PROCESS_BODY_RAIL,
  PROCESS_ROW_BUTTON,
} from "./stream-style";
import { Collapse } from "./collapse";
import { SkipWaitButton } from "./skip-wait-button";
import { formatTs } from "./utils";

// ---------- 干净 diff 视图（解析层 parseUnifiedDiff；双列行号 + 无 @@ 原文）----------

const DIFF_LINE_NUM_CLASS =
  "w-8 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground";

/**
 * diff 行号格。给了 linker + filePath 的那一列可点、跳 IDE 对应行。
 * 只有「新文件行号」列接跳转——删除行在盘上已经没了、跳过去定位必偏。
 */
const DiffLineNum = ({
  n,
  linker,
  filePath,
}: {
  n?: number;
  linker?: IdePathLinker;
  filePath?: string | null;
}) => {
  if (n == null || !linker || !filePath) {
    return <span className={DIFF_LINE_NUM_CLASS}>{n ?? ""}</span>;
  }
  return (
    <IdePathLink
      linker={linker}
      path={filePath}
      line={n}
      className={DIFF_LINE_NUM_CLASS}
      // 行号保持原本的暗色、只在 hover 时提示可点（整列染蓝太吵）
      linkClassName="cursor-pointer underline-offset-2 hover:text-info hover:underline"
    >
      {n}
    </IdePathLink>
  );
};

/**
 * 语法色 token 的颜色：浅色走 `--sdm-c`，深色走 `--shiki-dark`（Shiki 双主题）。
 * class 串与 Streamdown 代码块里的完全一致——那组 class 已经被 Tailwind 生成过、在本应用两种主题下实测可用。
 */
const DIFF_TOKEN_CLASS =
  "text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]";

const DiffTokens = ({ tokens }: { tokens: DiffSyntaxToken[] }) => {
  if (tokens.length === 0) return <>{" "}</>;
  return (
    <>
      {tokens.map((t, i) => (
        <span
          key={i}
          className={DIFF_TOKEN_CLASS}
          style={
            {
              "--sdm-c": t.light,
              "--shiki-dark": t.dark,
              ...(t.italic ? { fontStyle: "italic" } : {}),
              ...(t.bold ? { fontWeight: 600 } : {}),
            } as CSSProperties
          }
        >
          {t.content}
        </span>
      ))}
    </>
  );
};

const DiffLine = ({
  line,
  tokens,
  linker,
  filePath,
}: {
  line: DiffViewLine;
  /** 语法色 token；null = 没有（语言不认 / 还没算出来 / diff 太大），退回整行红绿字 */
  tokens?: DiffSyntaxToken[] | null;
  linker?: IdePathLinker;
  filePath?: string | null;
}) => {
  // hunk：极细分隔，不回显 @@ 原文（文件名已在标题行）
  if (line.kind === "hunk") {
    return (
      <div className="flex select-none items-center gap-2 px-2 py-1">
        <div className="h-px flex-1 border-t border-dashed border-border/60" />
        <span className="text-[11px] leading-none text-muted-foreground">
          ⋯
        </span>
        <div className="h-px flex-1 border-t border-dashed border-border/60" />
      </div>
    );
  }

  // 有语法色时，文字颜色交给 token，「新增 / 删除」只靠底色区分（底色比整行染字时略深一档，
  // 否则文字不再带红绿后，改动行不够醒目）；没有语法色就保持原来的整行红绿字
  const highlighted = tokens != null;
  return (
    <div
      className={cn(
        "flex font-mono text-[11px] leading-relaxed",
        line.kind === "add" &&
          (highlighted ? "bg-success/15" : "bg-success/10 text-success"),
        line.kind === "del" &&
          (highlighted
            ? "bg-destructive/15"
            : "bg-destructive/10 text-destructive"),
        line.kind === "context" && !highlighted && "text-muted-foreground",
      )}
    >
      <DiffLineNum n={line.oldLine} />
      <DiffLineNum n={line.newLine} linker={linker} filePath={filePath} />
      {/* whitespace-pre + 外层横滚：折行会打乱双列行号对齐 */}
      <span className="min-w-0 flex-1 whitespace-pre px-2 py-px">
        {tokens ? <DiffTokens tokens={tokens} /> : line.text || " "}
      </span>
    </div>
  );
};

/**
 * 干净 diff 块。事件流内联（edit 工具）和任务「代码改动」面板共用。
 * 默认 `max-h-64` 滚动；面板里由外层滚动、传 `scrollClassName="max-h-none"` 取消高度上限。
 */
export const InlineDiff = ({
  diff,
  truncated,
  linker,
  filePath,
  highlightPath,
  className,
  scrollClassName,
}: {
  diff: string;
  truncated?: boolean;
  /** 有 linker + filePath 时新行号可点、跳 IDE 对应行 */
  linker?: IdePathLinker;
  filePath?: string | null;
  /**
   * 仅用来按扩展名选语法高亮的语言（默认取 filePath）。
   * 已删除文件没有可跳转的 filePath、但扩展名还在，由调用方单独传。
   */
  highlightPath?: string | null;
  /** 外层容器追加 class（默认已带 mt-1.5） */
  className?: string;
  /** 内层滚动区追加 class（靠 cn 覆盖默认的 max-h-64，如传 max-h-none） */
  scrollClassName?: string;
}) => {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const tokenLines = useDiffSyntaxTokens(
    lines,
    diffLanguageFromPath(highlightPath ?? filePath),
  );
  return (
    // 复制的是 unified diff 原文（能直接贴回终端 / patch）；服务端截断过的就只有这些、
    // diff 没有「加载完整」通道（跟工具输出不同、落盘的只有截断后的那份）
    <CopyableBlock
      text={diff}
      label="复制 diff"
      className={cn("mt-1.5 min-w-0 max-w-full", className)}
    >
      <div
        className={cn(
          "max-h-64 w-full max-w-full overflow-auto rounded-md border border-border bg-card",
          scrollClassName,
        )}
      >
        {/* min-w-max：横滚内容宽 = 最长行，行级 diff 高亮铺满整行（否则背景只到容器宽、右侧无底色） */}
        <div className="min-w-max">
          {lines.map((line, i) => (
            <DiffLine
              key={i}
              line={line}
              tokens={tokenLines?.[i]}
              linker={linker}
              filePath={filePath}
            />
          ))}
          {truncated && (
            <div className="border-t border-border/50 px-2 py-1 text-[11px] text-muted-foreground">
              diff 已截断
            </div>
          )}
        </div>
      </div>
    </CopyableBlock>
  );
};

// ---------- 单工具块 ----------

const ToolBlockIcon = ({
  block,
}: {
  block: ToolBlock;
}) => {
  if (block.status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />;
  }
  // run 终结未收到完成帧 / 渲染层 coerce：中性灰、不转圈
  if (block.status === "interrupted") {
    return <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (block.status === "error") {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  // 完成态一律 success 色：形状表达「哪种工具」（终端 / 文件 / 通用），
  // 颜色只表达「跑完了没出错」。原来 edit/write 用 amber、跟 warning 撞语义，
  // 看起来像「这次编辑有问题」，其实只是成功的编辑。
  if (block.name.toLowerCase() === "shell") {
    return <Terminal className="size-3.5 shrink-0 text-success" />;
  }
  if (
    block.name.toLowerCase() === "edit" ||
    block.name.toLowerCase() === "write"
  ) {
    return <FileCode2 className="size-3.5 shrink-0 text-success" />;
  }
  return <Check className="size-3.5 shrink-0 text-success" />;
};

const formatDuration = (ms?: number): string | null => {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/** 任务书截断阈值（展开区「显示更多」） */
const TASK_PROMPT_PREVIEW_CHARS = 400;

interface ToolBlockRowProps {
  block: ToolBlock;
  taskId: string;
  /** shell 流式实时输出（仅 running；完成后被 result.output 替换） */
  liveOutput?: string;
  /** verb group 内成员：强制更紧凑、默认折叠 */
  nested?: boolean;
}

/**
 * 从 tool_result.fullPath 取已消毒的文件名（无目录 / 无 .txt）。
 * 子代理 callId 常含 `\n`，直接拿 callId 请求会被旧 API 拒或 URL 怪异；
 * fullPath 落盘时已 sanitize，与磁盘文件名一致。
 */
const toolOutputIdFromFullPath = (fullPath: string): string =>
  fullPath.replace(/^.*\//, "").replace(/\.txt$/i, "");

/**
 * 拉工具完整输出（展示被截断时用）。「加载完整输出」按钮和「复制」共用这一条通道。
 * 404（写盘失败 / 已被 prune）与网络错误都 toast 后返 null——调用方按「拿不到」处理。
 */
const fetchToolFullOutput = async (
  taskId: string,
  block: ToolBlock,
): Promise<string | null> => {
  try {
    const fromPath = toolOutputIdFromFullPath(block.result?.fullPath ?? "");
    // 优先 fullPath 消毒名；兜底 callId（普通工具 callId 本身已安全）
    const outputId = fromPath || block.callId;
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/tool-output/${encodeURIComponent(outputId)}`,
    );
    // 历史事件写盘失败 / 已被 prune：降级提示，不当成硬错误
    if (res.status === 404) {
      toast.error("完整输出已不可用（可能未保存或已清理）");
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch {
    toast.error("完整输出加载失败");
    return null;
  }
};

/**
 * 「复制输出」的取值源——复制的永远是**全量**、不是滚动框里可见的那截：
 * 展示被截断且还没拉过全量 → 复制时现拉（顺手补进视图、跟按钮同源）；否则直接给当前文本。
 */
const buildOutputCopySource = (
  taskId: string,
  block: ToolBlock,
  fullText: string | null,
  displayOutput: string | undefined,
  onLoaded: (text: string) => void,
): CopyTextSource => {
  if (fullText != null) return fullText;
  if (block.result?.truncated && block.result?.fullPath) {
    return async () => {
      const text = await fetchToolFullOutput(taskId, block);
      if (text != null) onLoaded(text);
      return text;
    };
  }
  return displayOutput ?? "";
};

/** 展开区底部：加载完整输出按钮（truncated + fullPath） */
const LoadFullOutputButton = ({
  block,
  taskId,
  fullText,
  fullLoading,
  onLoaded,
  onLoadingChange,
  onEnsureOpen,
}: {
  block: ToolBlock;
  taskId: string;
  fullText: string | null;
  fullLoading: boolean;
  onLoaded: (text: string) => void;
  onLoadingChange: (v: boolean) => void;
  onEnsureOpen: () => void;
}) => {
  if (
    !block.result?.truncated ||
    !block.result?.fullPath ||
    fullText !== null
  ) {
    return null;
  }
  return (
    <button
      type="button"
      disabled={fullLoading}
      onClick={() => {
        onLoadingChange(true);
        onEnsureOpen();
        void (async () => {
          const text = await fetchToolFullOutput(taskId, block);
          if (text != null) onLoaded(text);
          onLoadingChange(false);
        })();
      }}
      className="mt-1 cursor-pointer text-[11px] text-primary hover:underline disabled:opacity-50"
    >
      {fullLoading ? "加载中…" : "已截断 · 加载完整输出"}
    </button>
  );
};

/** 展开区空态：running → 等待输出；interrupted → 已中断；完成 → 无输出 */
const ExpandedEmptyPlaceholder = ({
  status,
}: {
  status: ToolBlock["status"];
}) => {
  if (status === "running") {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span>等待输出…</span>
      </div>
    );
  }
  if (status === "interrupted") {
    return <div className="text-[11px] text-muted-foreground">已中断</div>;
  }
  return <div className="text-[11px] text-muted-foreground">无输出</div>;
};

/**
 * name=task 子代理专属迷你卡。
 * 与普通工具行拉开层次：左侧紫轨 + 浅紫渐变底 + 圆角边框；
 * 完成态产出走 MarkdownText（running 仍用 pre，避免流式 markdown 闪烁）。
 */
const TaskSubagentBlock = ({
  block,
  taskId,
  liveOutput,
  nested,
}: ToolBlockRowProps) => {
  // 默认折叠（与 toolBlockDefaultCollapsed 一致）
  const [collapsed, setCollapsed] = useState(() =>
    toolBlockDefaultCollapsed(block.name, nested),
  );
  // 打开详情抽屉（宿主在 EventStream 层）；不在宿主里（单独复用卡片 / 单测）为 null → 不画入口
  const openDetail = useOpenSubagentDetail();
  // 任务书超长：点「显示更多」内联展开全文
  const [promptExpanded, setPromptExpanded] = useState(false);
  // 产出区第二层折叠（完成态）
  const [outputOpen, setOutputOpen] = useState(false);
  // 截断输出就地加载后的全文
  const [fullText, setFullText] = useState<string | null>(null);
  // 「加载完整输出」请求中
  const [fullLoading, setFullLoading] = useState(false);

  const taskArgs = useMemo(
    () => parseTaskToolArgs(block.args),
    [block.args],
  );
  const title = taskArgs?.description?.trim() || "子代理任务";
  const prompt = taskArgs?.prompt ?? "";
  const promptLong = prompt.length > TASK_PROMPT_PREVIEW_CHARS;
  const promptShown =
    promptExpanded || !promptLong
      ? prompt
      : `${prompt.slice(0, TASK_PROMPT_PREVIEW_CHARS)}…`;

  const displayOutput =
    block.status === "running" && liveOutput
      ? liveOutput
      : block.result?.output;

  const outputBody = fullText ?? displayOutput;
  const markdownBaseDir = useTaskBaseDir(
    taskId,
    !!outputBody && block.status !== "running",
    block.actionId,
  );
  // 复制产出：截断时现拉全量（不是复制滚动框里可见的那截）
  const outputCopySource = buildOutputCopySource(
    taskId,
    block,
    fullText,
    displayOutput,
    setFullText,
  );

  const liveTail =
    collapsed &&
    block.status === "running" &&
    liveOutput
      ? liveOutput.trim().split("\n").filter(Boolean).slice(-1)[0]
      : null;

  const statusIcon =
    block.status === "running" ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
    ) : block.status === "interrupted" ? (
      <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />
    ) : block.status === "error" ? (
      <X className="size-3.5 shrink-0 text-destructive" />
    ) : (
      <Check className="size-3.5 shrink-0 text-success" />
    );

  return (
    <div
      className={cn(
        // 迷你卡：与普通工具行拉开层次（边框 + 渐变底 + 左侧紫轨）
        "group/tool min-w-0 max-w-full overflow-hidden rounded-lg border border-subagent/25",
        "bg-gradient-to-br from-subagent/[0.08] via-subagent/[0.02] to-transparent",
        "dark:from-subagent/15 dark:via-subagent/[0.04]",
        nested && "pl-0",
      )}
    >
      <div className="border-l-[3px] border-l-subagent/60">
        {/* 头部 = 折叠开关 + 右侧「详情」入口并排（不能把详情按钮嵌进折叠按钮里：button 套 button 不合法） */}
        <div className="flex min-w-0 items-stretch">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-subagent/[0.08] hover:text-foreground"
        >
          <CollapseChevron open={!collapsed} />
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-subagent/15">
            <Bot className="size-3.5 text-subagent" />
          </span>
          <span className="shrink-0 rounded-sm bg-subagent/15 px-1.5 py-px text-[11px] font-semibold tracking-wide text-subagent">
            子代理
          </span>
          <span className="min-w-0 shrink truncate text-[11px] font-medium text-foreground">
            {title}
          </span>
          {/* 模型徽标：args.model 有值才显示；历史缺 model 不硬造。
              effort 同理。徽标显示的是模型传的入参：pi 的 task 校验不过会整个调用报错
              （卡片是错误态、没起子会话），所以非错误态卡片上的徽标 = 实际生效值 */}
          {taskArgs?.model && (
            <span className="shrink-0 rounded-sm border border-subagent/25 bg-background/60 px-1 py-px font-mono text-[11px] text-subagent">
              {taskArgs.model}
            </span>
          )}
          {taskArgs?.effort && (
            <span className="shrink-0 rounded-sm border border-subagent/25 bg-background/60 px-1 py-px font-mono text-[11px] text-muted-foreground">
              {taskArgs.effort}
            </span>
          )}
          {statusIcon}
          {collapsed && liveTail && (
            <span className="min-w-0 flex-1 truncate text-[11px]">
              {liveTail}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums opacity-0 transition-opacity group-hover/tool:opacity-100 group-focus-within/tool:opacity-100">
            {formatTs(block.ts)}
          </span>
        </button>
        {openDetail ? (
          // 详情：右侧抽屉里看给子代理的完整任务书 + 它自己的工作过程（thinking / 工具调用 / 回复）。
          // 卡片里的任务书只是被截断的预览、产出只是最后一段文字，过程根本没在这里
          <Tooltip content="查看给子代理的任务书和它的工作过程">
            <button
              type="button"
              onClick={() => openDetail(subagentTargetFromToolBlock(block))}
              aria-label="查看子代理详情"
              className="flex shrink-0 cursor-pointer items-center gap-1 px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-subagent/[0.08] hover:text-foreground"
            >
              <PanelRightOpen className="size-3.5" aria-hidden />
              详情
            </button>
          </Tooltip>
        ) : null}
        </div>

        <Collapse open={!collapsed}>
          <div className="space-y-2.5 px-3 pb-3 pt-0.5">
            {/* 任务书 */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium tracking-wide text-subagent">
                任务书
              </div>
              {prompt ? (
                <div className="space-y-1">
                  {/* 复制的是完整任务书、不是「显示更多」之前的那截 */}
                  <CopyableBlock text={prompt} label="复制任务书">
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-subagent/15 bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground dark:bg-background/40">
                      {promptShown}
                    </pre>
                  </CopyableBlock>
                  {promptLong && (
                    <button
                      type="button"
                      onClick={() => setPromptExpanded((v) => !v)}
                      className="cursor-pointer text-[11px] text-subagent hover:underline"
                    >
                      {promptExpanded ? "收起" : "显示更多"}
                    </button>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">无任务书</div>
              )}
            </div>

            {/* 产出：完成态 markdown；running 用 pre 防流式闪烁 */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium tracking-wide text-subagent">
                产出
              </div>
              {block.status === "running" && !displayOutput ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 shrink-0 animate-spin text-info" />
                  <span>运行中…</span>
                </div>
              ) : displayOutput ? (
                <div>
                  {block.status !== "running" && (
                    <button
                      type="button"
                      onClick={() => setOutputOpen((o) => !o)}
                      className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <CollapseChevron open={outputOpen} />
                      输出
                    </button>
                  )}
                  {(block.status === "running" || outputOpen) && (
                    <CopyableBlock
                      text={outputCopySource}
                      label="复制产出"
                      className="mt-1"
                    >
                      <div className="max-h-64 overflow-y-auto rounded-md border border-subagent/15 bg-background/80 p-2 dark:bg-background/40">
                        {block.status === "running" ? (
                          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {outputBody}
                          </pre>
                        ) : (
                          // --prose-code-size：这个容器是 12px 档，代码块跟着降一档（默认 14px 会比周围正文还大）
                          <div className="text-xs leading-relaxed text-foreground [--prose-code-size:0.75rem] [&_.prose]:text-xs">
                            <MarkdownText text={outputBody ?? ""} baseDir={markdownBaseDir} />
                          </div>
                        )}
                      </div>
                    </CopyableBlock>
                  )}
                  <LoadFullOutputButton
                    block={block}
                    taskId={taskId}
                    fullText={fullText}
                    fullLoading={fullLoading}
                    onLoaded={setFullText}
                    onLoadingChange={setFullLoading}
                    onEnsureOpen={() => setOutputOpen(true)}
                  />
                </div>
              ) : (
                <ExpandedEmptyPlaceholder status={block.status} />
              )}
            </div>
          </div>
        </Collapse>
      </div>
    </div>
  );
};


const RegularToolBlockRow = ({
  block,
  taskId,
  liveOutput,
  nested = false,
}: ToolBlockRowProps) => {
  // write 完成后收起（产物栏已有文件）；用户点过则以手动为准。
  // 其余工具仍走 toolBlockDefaultCollapsed（edit 展开看 diff；读/shell 折叠）。
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const autoCollapsed = toolBlockAutoCollapsed(block.name, block.status, nested);
  const collapsed = manualCollapsed ?? autoCollapsed;
  // 第二层：完整 output（默认折叠；展开一层只看摘要/命令）
  const [outputOpen, setOutputOpen] = useState(false);
  // edit diff：默认展开（collapsed_edit_blocks=OFF）
  const [diffCollapsed, setDiffCollapsed] = useState(false);
  // 截断输出的完整内容（2026-07-20 用户拍板去弹窗：点「加载完整输出」就地替换进滚动框）
  const [fullText, setFullText] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);

  // 原「运行中自动展开、完成自动收起」已删（2026-07-20 用户实测「图标像反了」）：
  // running 强制展开（v）但 task 子代理等工具展开区无内容、空撑一块；完成行反而
  // 折叠（>）带摘要——观感颠倒。折叠行内 liveTail 实时滚动已够看，想看全点开即可。

  const summary = toolBlockSummary(block);
  const detailLine = toolBlockDetailLine(block);
  const argsPreview = toolBlockExpandedArgsPreview(block);
  const diff = block.result?.diff;
  const diffStats = useMemo(
    () => (diff ? countDiffStats(diff) : null),
    [diff],
  );

  // 本块指向的文件（edit / write / read）——路径、diff 标题、diff 行号都拿它去跳 IDE
  const filePath = useMemo(() => toolBlockFilePath(block), [block]);
  // 只有相对路径才需要 task cwd 兜底：SDK 给的基本是绝对路径、不为它们白发一次详情请求
  const baseDir = useTaskBaseDir(
    taskId,
    !!filePath && toolPathNeedsBaseDir(filePath),
    block.actionId,
  );
  // 拼不出绝对路径时 IdePathLink 自己退化成纯文本（不给点了没反应的假链接）
  const linker = useIdePathLinker(baseDir);
  // detail 行里可点的那一段（不是路径行 → null、整行走原纯文本）
  const detailPath = toolDetailPathSegment(detailLine, filePath);

  // 成功不写 ✓：左边图标已经是 success 色。exit 0 每行都写太吵，只留非 0。
  const statusBits: string[] = [];
  if (block.status === "error") statusBits.push("✗");
  if (block.status === "interrupted") statusBits.push("已中断");
  if (block.result?.exitCode != null && block.result.exitCode !== 0) {
    statusBits.push(`exit ${block.result.exitCode}`);
  }
  const dur = formatDuration(block.result?.executionTime);
  if (dur) statusBits.push(dur);

  const displayOutput =
    block.status === "running" && liveOutput
      ? liveOutput
      : block.result?.output;

  // 折叠态仍可瞥一眼 shell 直播尾行（一行）
  const liveTail =
    collapsed &&
    block.status === "running" &&
    liveOutput
      ? liveOutput.trim().split("\n").filter(Boolean).slice(-1)[0]
      : null;

  // 展开区是否已有实质内容（detail / args 兜底 / diff / output）
  const hasExpandedBody = Boolean(
    detailLine || argsPreview || diff || displayOutput,
  );

  // 复制输出：截断时现拉全量（不是复制滚动框里可见的那截）
  const outputCopySource = buildOutputCopySource(
    taskId,
    block,
    fullText,
    displayOutput,
    setFullText,
  );

  return (
    <div className={cn("group/tool w-full min-w-0 max-w-full", nested && "pl-0")}>
      <button
        type="button"
        onClick={() => setManualCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className={PROCESS_ROW_BUTTON}
      >
        <CollapseChevron open={!collapsed} />
        <ToolBlockIcon block={block} />
        <span className="shrink-0 font-medium text-foreground">
          {block.name}
        </span>
        {collapsed && (liveTail || summary) && (
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              // shell 命令 / 路径用 mono，一眼可辨
              (block.name.toLowerCase() === "shell" ||
                block.name.toLowerCase() === "edit" ||
                block.name.toLowerCase() === "write" ||
                block.name.toLowerCase() === "read") &&
                "font-mono",
            )}
          >
            {liveTail ?? summary}
          </span>
        )}
        {/* 展开态的路径：点它跳 IDE、点行内其它地方仍是折叠（IdePathLink 内部 stopPropagation） */}
        {!collapsed && block.result?.filePath && !diff && (
          <IdePathLink
            linker={linker}
            path={block.result.filePath}
            className="min-w-0 flex-1 truncate font-mono"
          />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {statusBits.length > 0 && block.status !== "running" && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {statusBits.join(" · ")}
            </span>
          )}
          <span className="text-[11px] tabular-nums opacity-0 transition-opacity group-hover/tool:opacity-100 group-focus-within/tool:opacity-100">
            {formatTs(block.ts)}
          </span>
        </span>
      </button>

      {/* wait 在睡：不论折叠与否都露出「跳过等待」（task 形态没有状态行，这是唯一入口）。
          放在标题按钮外面——按钮套按钮不合法、点击也会冒泡成折叠 / 展开 */}
      {isSkippableWaitBlock(block) && (
        <div className="ml-5 mt-0.5">
          <SkipWaitButton taskId={taskId} />
        </div>
      )}

      {/* 展开 / 收起走高度动画：write 完成自动收起、用户手动点开都不再「啪」地跳 */}
      <Collapse open={!collapsed}>
        <div
          className={cn(
            "ml-5 mt-1 min-w-0 max-w-full space-y-1.5",
            PROCESS_BODY_RAIL,
          )}
        >
          {/* 一层：可读命令 / 路径；无 detailLine 时用 args 截断兜底 */}
          {(detailLine || (!displayOutput && !diff && argsPreview)) && (
            <div
              className={cn(
                "min-w-0 max-w-full text-[11px] text-muted-foreground",
                // 展开就是为了看全：折行吃满宽度，不要再 truncate 留一截空白
                "whitespace-pre-wrap break-all font-mono",
              )}
            >
              {/* detail 打头是文件路径（read 的路径 / edit 的「路径 +N/−M」）→ 路径段可点 */}
              {detailPath && filePath ? (
                <>
                  <IdePathLink linker={linker} path={filePath}>
                    {detailPath}
                  </IdePathLink>
                  {detailLine?.slice(detailPath.length)}
                </>
              ) : (
                (detailLine ?? argsPreview)
              )}
            </div>
          )}

          {/* edit diff */}
          {diff && (
            <div className="min-w-0 max-w-full">
              <button
                type="button"
                onClick={() => setDiffCollapsed((c) => !c)}
                className="flex w-full min-w-0 cursor-pointer items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
              >
                <CollapseChevron open={!diffCollapsed} />
                {filePath ? (
                  <IdePathLink
                    linker={linker}
                    path={filePath}
                    className="min-w-0 flex-1 truncate font-mono"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono">diff</span>
                )}
                {diffStats && (
                  <span className="shrink-0 tabular-nums">
                    +{diffStats.added}/−{diffStats.removed}
                  </span>
                )}
                {block.result?.diffTruncated && (
                  <span className="shrink-0 text-[11px] text-warning">
                    已截断
                  </span>
                )}
              </button>
              <Collapse open={!diffCollapsed}>
                <InlineDiff
                  diff={diff}
                  truncated={block.result?.diffTruncated}
                  linker={linker}
                  filePath={filePath}
                />
              </Collapse>
            </div>
          )}

          {/* 输出：running 直播 / completed 可再展开 */}
          {displayOutput && (
            <div>
              {block.status !== "running" && (
                <button
                  type="button"
                  onClick={() => setOutputOpen((o) => !o)}
                  className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CollapseChevron open={outputOpen} />
                  输出
                </button>
              )}
              <Collapse open={block.status === "running" || outputOpen}>
                <CopyableBlock
                  text={outputCopySource}
                  label="复制输出"
                  className="mt-1"
                >
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {fullText ?? displayOutput}
                  </pre>
                </CopyableBlock>
              </Collapse>
              {/* 仅 truncated+fullPath 都有才出按钮；写盘失败只有 truncated、点开会 404。
                  点击就地拉全量替换进上面的滚动框（不再弹 Dialog——用户嫌重） */}
              <LoadFullOutputButton
                block={block}
                taskId={taskId}
                fullText={fullText}
                fullLoading={fullLoading}
                onLoaded={setFullText}
                onLoadingChange={setFullLoading}
                onEnsureOpen={() => setOutputOpen(true)}
              />
            </div>
          )}

          {/* 仍无内容：running 等输出 / 完成态无输出 */}
          {!hasExpandedBody && (
            <ExpandedEmptyPlaceholder status={block.status} />
          )}
        </div>
      </Collapse>
    </div>
  );
};

/**
 * name=updateTodos 待办清单专属卡。
 * 默认展开（清单本身就是要看的）；解析失败由分流点回退 RegularToolBlockRow。
 */
const TodoToolBlock = ({
  block,
  nested,
}: ToolBlockRowProps) => {
  // 清单默认展开；nested（verb 内）仍跟 defaultCollapsed
  const [collapsed, setCollapsed] = useState(() =>
    toolBlockDefaultCollapsed(block.name, nested),
  );

  const todos = useMemo(
    () => parseTodoToolArgs(block.args) ?? [],
    [block.args],
  );
  const summary = todoListSummary(todos);

  const statusIcon =
    block.status === "running" ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
    ) : block.status === "interrupted" ? (
      <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />
    ) : block.status === "error" ? (
      <X className="size-3.5 shrink-0 text-destructive" />
    ) : (
      <Check className="size-3.5 shrink-0 text-success" />
    );

  return (
    <div className={cn("group/tool w-full min-w-0 max-w-full", nested && "pl-0")}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={PROCESS_ROW_BUTTON}
      >
        <CollapseChevron open={!collapsed} />
        <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-info/15">
          <ListTodo className="size-3.5 text-info" />
        </span>
        <span className="shrink-0 rounded-sm bg-info/15 px-1.5 py-px text-[11px] font-semibold tracking-wide text-info">
          待办
        </span>
        <span className="min-w-0 flex-1 truncate tabular-nums">{summary}</span>
        {statusIcon}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums opacity-0 transition-opacity group-hover/tool:opacity-100 group-focus-within/tool:opacity-100">
          {formatTs(block.ts)}
        </span>
      </button>

      <Collapse open={!collapsed}>
        <ul className={cn("ml-5 mt-1 space-y-1", PROCESS_BODY_RAIL)}>
          {todos.map((item, i) => (
            <TodoToolItemRow key={i} item={item} />
          ))}
        </ul>
      </Collapse>
    </div>
  );
};

/** 单行待办：状态图标 + 内容（truncate + title 全文） */
const TodoToolItemRow = ({ item }: { item: TodoItem }) => {
  const done = item.status === "completed";
  const cancelled = item.status === "cancelled";
  const active = item.status === "in_progress";

  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <TodoStatusIcon status={item.status} />
      <Tooltip content={item.content}>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-5",
            done && "text-muted-foreground line-through",
            cancelled && "text-muted-foreground line-through",
            active && "font-medium text-foreground",
            !done && !cancelled && !active && "text-muted-foreground",
          )}
        >
          {item.content || "（无标题）"}
        </span>
      </Tooltip>
    </li>
  );
};

const TodoStatusIcon = ({ status }: { status: TodoItem["status"] }) => {
  if (status === "completed") {
    return (
      <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
    );
  }
  if (status === "in_progress") {
    // 实心点 primary：当前推进项高亮
    return (
      <span
        className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
        aria-hidden
      />
    );
  }
  if (status === "cancelled") {
    return (
      <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    );
  }
  // pending：空心圈
  return <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
};

const ToolBlockRowImpl = (props: ToolBlockRowProps) => {
  // task 子代理：走专属卡片（独立组件，避免 hooks 条件分支）
  if (props.block.name.toLowerCase() === "task") {
    return <TaskSubagentBlock {...props} />;
  }
  // updateTodos：解析成功才走专属卡；失败回退普通行（别渲空清单）
  if (isTodoTool(props.block.name) && parseTodoToolArgs(props.block.args)) {
    return <TodoToolBlock {...props} />;
  }
  return <RegularToolBlockRow {...props} />;
};

export const ToolBlockRow = memo(ToolBlockRowImpl);

// ---------- verb group ----------

const ToolVerbGroupRowImpl = ({
  group,
  taskId,
}: {
  group: ToolVerbGroup;
  taskId: string;
}) => {
  // 默认折叠成一行（GB group_tool_verbs）
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="group/verb">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={PROCESS_ROW_BUTTON}
      >
        <CollapseChevron open={!collapsed} />
        <Check className="size-3.5 shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate">{verbGroupLabel(group)}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums opacity-0 transition-opacity group-hover/verb:opacity-100 group-focus-within/verb:opacity-100">
          {formatTs(group.ts)}
        </span>
      </button>
      <Collapse open={!collapsed}>
        <div className="ml-5 mt-0.5 space-y-0.5 border-l border-border pl-2">
          {group.members.map((m) => (
            <ToolBlockRow
              key={m.id}
              block={m}
              taskId={taskId}
              nested
            />
          ))}
        </div>
      </Collapse>
    </div>
  );
};

export const ToolVerbGroupRow = memo(ToolVerbGroupRowImpl);
