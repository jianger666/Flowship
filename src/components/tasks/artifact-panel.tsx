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
import { PHASE_LABEL, PHASE_LABEL_EN } from "@/lib/task-display";
import type { PhaseState } from "@/lib/types";

// artifact-panel 的标题用「中文（英文）」复合形式、跟单纯展示中文的地方区分
// 不在 task-display 里直接 export 这个变种、避免污染单一职责
const formatPhaseTitle = (id: PhaseState["id"]) =>
  `${PHASE_LABEL[id]} (${PHASE_LABEL_EN[id]})`;

/**
 * 判断 inline code 内容像不像「文件路径」
 *
 * 启发式规则（求覆盖、不求精确）：
 *   - 含 `/`、且最后一段含 `.`（扩展名）
 *   - 不能含空格 / 反引号 / 引号（这些通常是表达式不是路径）
 *   - 长度合理（< 200、避免误判超长字符串）
 *
 * 不动 markdown 原文、只在视图层把长路径里的目录置灰、文件名加粗、且包成 deep link。
 * 用户切「原文」视图能看到原始 path、复制粘贴也是 plain string、下游兼容。
 */
const looksLikePath = (s: string): boolean => {
  if (!s || s.length > 200) return false;
  if (/\s|"|'|`/.test(s)) return false;
  if (!s.includes("/")) return false;
  const lastSeg = s.slice(s.lastIndexOf("/") + 1);
  return lastSeg.length > 0 && lastSeg.includes(".");
};

/**
 * 把相对仓库路径转成 cursor:// deep link
 *
 * - 已经是绝对路径就直接用
 * - 否则跟仓库根拼起来
 * - Cursor 支持 cursor://file/<absolute>、点开就跳到 IDE 对应文件
 */
const buildCursorLink = (
  pathLike: string,
  repoPath: string | undefined,
): string | null => {
  if (!pathLike) return null;
  // 已经是 url / 协议、不动
  if (/^[a-z]+:\/\//i.test(pathLike)) return null;
  let absolute = pathLike;
  if (!pathLike.startsWith("/")) {
    if (!repoPath) return null;
    const base = repoPath.replace(/\/+$/, "");
    absolute = `${base}/${pathLike.replace(/^\.?\/+/, "")}`;
  }
  // cursor:// 协议第一段是 host、然后是 path、所以 file 后面再带绝对路径
  // encode 防中文路径炸
  return `cursor://file${absolute.split("/").map(encodeURIComponent).join("/")}`;
};

const buildMarkdownComponents = (
  repoPath: string | undefined,
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
    if (looksLikePath(text)) {
      const href = buildCursorLink(text, repoPath);
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
  // 仓库根绝对路径、用来把 plan.md 里相对路径转成 cursor:// deep link
  // 没传或传空、纯展示、不带链接
  repoPath?: string;
}

export const ArtifactPanel = ({ phase, repoPath }: Props) => {
  const phaseLabel = formatPhaseTitle(phase.id);
  // 视图模式：preview = 渲染、source = 原始 markdown
  const [mode, setMode] = useState<"preview" | "source">("preview");
  // 包过 repoPath 的 markdown components、避免每次 render 重建
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(repoPath),
    [repoPath],
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
