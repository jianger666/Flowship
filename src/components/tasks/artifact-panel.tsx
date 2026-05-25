"use client";

/**
 * 左侧产物面板
 * - 显示当前 active phase 的产物（spec.md / plan.md / build diff）
 * - V1 用 react-markdown + remark-gfm + @tailwindcss/typography prose 类、
 *   表格 / 代码块 / 列表 / 任务清单都能渲染
 * - 顶部 toggle：渲染视图 / 原始 markdown
 *   - 渲染视图：默认、给人看
 *   - 原始：给开发者校验 frontmatter / 调试 prompt 输出格式
 * - 没产物时显示占位（"该 phase 还没产物"）
 */

import { useMemo, useState } from "react";
import { Code2, Eye, FileText } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildCursorLink,
  looksLikeArtifactRef,
  looksLikePath,
} from "@/lib/path-utils";
import { PHASE_LABEL, PHASE_LABEL_EN } from "@/lib/task-display";
import type { PhaseId, PhaseState } from "@/lib/types";

// artifact-panel 的标题用「中文（英文）」复合形式、跟单纯展示中文的地方区分
// 不在 task-display 里直接 export 这个变种、避免污染单一职责
const formatPhaseTitle = (id: PhaseState["id"]) =>
  `${PHASE_LABEL[id]} (${PHASE_LABEL_EN[id]})`;

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
  // V0.5.9 改名（原 repoPath）：cursor:// deep link 的基准目录绝对路径
  // - 单仓 = 仓库自身（行为同 V0.5.9 前）
  // - 多仓 = effective cwd（公共父目录、AI 写的路径首段是仓名、跟 cwd 拼回的就是绝对路径）
  // 没传或传空、纯展示、不带链接
  baseDir?: string;
  // V0.5.8：用户点 inline code 形式的 artifact 引用（`01-plan.md` 等）时调它切到对应 phase tab
  // 没传则 artifact ref 退化成普通 inline code（不可点）、纯展示场景用
  onArtifactRefClick?: (phaseId: PhaseId) => void;
}

export const ArtifactPanel = ({
  phase,
  baseDir,
  onArtifactRefClick,
}: Props) => {
  const phaseLabel = formatPhaseTitle(phase.id);
  // 视图模式：preview = 渲染、source = 原始 markdown
  const [mode, setMode] = useState<"preview" | "source">("preview");
  // 包过 baseDir / onArtifactRefClick 的 markdown components、避免每次 render 重建
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(baseDir, onArtifactRefClick),
    [baseDir, onArtifactRefClick],
  );

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
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <FileText className="size-3.5" />
          {phase.artifact.filename}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={mode === "preview" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setMode("preview")}
            title="渲染视图"
          >
            <Eye className="size-3.5" />
            渲染
          </Button>
          <Button
            variant={mode === "source" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setMode("source")}
            title="原始 markdown"
          >
            <Code2 className="size-3.5" />
            原文
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {mode === "preview" ? (
          <div className="prose prose-sm dark:prose-invert max-w-none px-6 py-4 prose-headings:scroll-mt-4 prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {phase.artifact.content}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="p-4 text-xs leading-relaxed whitespace-pre-wrap font-mono">
            {phase.artifact.content}
          </pre>
        )}
      </div>
    </div>
  );
};
