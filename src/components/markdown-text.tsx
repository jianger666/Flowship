"use client";

/**
 * 统一 Markdown 渲染器（v1.0：react-markdown → Streamdown、Vercel 官方 AI 流式渲染库）
 *
 * 为什么换 Streamdown（用户点名「要最好、要高级感」）：
 *   - **流式容错**：AI 边吐字边渲染时、没闭合的代码块 / 粗体不再字面量闪烁乱跳（remend）
 *   - **Shiki 代码高亮**：VS Code 同款引擎、200+ 语言、带复制按钮（原来代码块只有灰底无高亮）
 *   - **Mermaid 图表**：AI 爱输出流程图 / 时序图、直接渲染
 *   - **KaTeX 数学公式** + **CJK 优化**（中文标点 / 折行）
 *   - **块级 memo**：长对话流式时只重渲变化的块、配合 Virtuoso 性能更稳
 *
 * 三处 md 渲染统一走这里（事件流 assistant/user、流式 placeholder、artifact 面板、ask 卡）：
 *   - 保留原 components 覆盖：a → MarkdownLink（新窗口 / 本地图片预览 / 幻觉链接降级）、
 *     img → MarkdownImage（本地图走 /api/local-image、点击站内 lightbox）
 *   - 保留两个自定义 remark 插件（裸链接尾 _ 修正 / CJK autolink 修剪）
 *   - shikiTheme 跟随主题（github-light / github-dark）
 *   - 全站 shadcn oklch token、Streamdown 组件直接吃现有主题变量
 */

import { memo, useMemo, type ReactNode } from "react";
import {
  Streamdown,
  defaultRemarkPlugins,
  defaultRehypePlugins,
  type Components,
  type ThemeInput,
} from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

import { cn } from "@/lib/utils";
import { useSearchFieldGlobalOffset } from "@/components/ui/pane-search-highlight-context";
import { rehypeSearchHighlight } from "@/lib/rehype-search-highlight";
import { MarkdownLink } from "@/components/markdown-link";
import { MarkdownImage } from "@/components/ui/image-preview";
import { Tooltip } from "@/components/ui/tooltip";
import {
  LocalFileLink,
  LocalFilePathSegments,
  useLocalFilePathLinker,
  type LocalFilePathLinker,
} from "@/components/ui/local-file-link";
import { resolveLocalFileAbsolute } from "@/components/ui/local-file-preview-context";
import {
  looksLikePath,
  parsePathSegments,
  pathDisplayLabel,
} from "@/lib/path-utils";
import { rehypeRewriteLocalImages } from "@/lib/rehype-rewrite-local-images";
import { remarkCodeReference } from "@/lib/remark-code-reference";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";

// 插件实例全局一份（Shiki 高亮器有初始化开销、别每次 render 新建）
const STREAMDOWN_PLUGINS = { code, mermaid, math, cjk };
// Shiki 主题对（浅 / 深）——跟站内 next-themes 的 .light/.dark 对齐
const SHIKI_THEME: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];
// remark 插件：**必须带上 Streamdown 内置的 defaultRemarkPlugins（含 remark-gfm）**——
// 直接传 remarkPlugins 是整表替换、不追加、漏了 gfm 表格/删除线/autolink 全失效
//（已实测）；我们三个自定义插件跟在其后
const REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkCodeReference,
  remarkKeepTrailingUnderscore,
  remarkTrimAutolinkCjk,
];
// rehype：传自定义列表也是整表替换。顺序 = raw → 本地图改写 → sanitize → harden。
// 本地图必须在 sanitize 前改写（file:// 会被剥 src）；artifact / 修订视图共用此表。
export const STREAMDOWN_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  rehypeRewriteLocalImages,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];
// 操作栏精简（用户反馈「又有间距又有操作栏、太重」）：代码块只留复制、表格全关、
// mermaid 留全屏 + 拖拽缩放（图表真需要）；行号也关（聊天场景不引用行号、纯噪音）
export const STREAMDOWN_CONTROLS = {
  code: { copy: true, download: false },
  table: false,
  mermaid: { copy: false, download: false, fullscreen: true, panZoom: true },
} as const;

/** 产物栏 / 本地文件预览等「文档面」共用 prose 壳；禁止再复制一份 className 字符串 */
export const MARKDOWN_PROSE_DOCUMENT = cn(
  "prose prose-sm dark:prose-invert max-w-none",
  "prose-headings:scroll-mt-4",
  "prose-code:before:content-none prose-code:after:content-none",
  "min-w-0 wrap-break-word",
);
// remarkCodeReference 插入的出处行：`path · L12-34`
const CODE_REF_CAPTION_SEP = " · L";

const parseCodeRefCaption = (
  text: string,
): { path: string; line?: number; display: string } | null => {
  const idx = text.indexOf(CODE_REF_CAPTION_SEP);
  if (idx <= 0) return null;
  const path = text.slice(0, idx);
  const lineMatch = /^(\d+)/.exec(text.slice(idx + CODE_REF_CAPTION_SEP.length));
  if (!lineMatch || !looksLikePath(path)) return null;
  const line = Number(lineMatch[1]);
  const suffix = text.slice(idx);
  return { path, line, display: `${pathDisplayLabel(path)}${suffix}` };
};

const buildMarkdownComponents = (
  linker: LocalFilePathLinker,
): Components =>
  ({
    a: MarkdownLink,
    img: MarkdownImage,
    // Streamdown 的 inline code 槽（覆盖 code 会连 fenced 一起接管、失去 Shiki）
    inlineCode: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => {
      const text = String(children ?? "");
      const caption = parseCodeRefCaption(text);
      const pathText = caption?.path ?? text;
      const line = caption?.line;

      if (looksLikePath(pathText)) {
        const resolved = resolveLocalFileAbsolute(pathText, linker.baseDir);
        const parsed = parsePathSegments(pathText);
        if (resolved && parsed && parsed.segments.length > 1) {
          return (
            <LocalFilePathSegments
              linker={linker}
              parsedPath={parsed.path}
              segments={parsed.segments}
              className="text-[0.85em]"
            />
          );
        }
        if (!resolved) {
          return (
            <Tooltip content={text}>
              <span className="min-w-0 max-w-full" {...rest}>
                <span className="font-mono text-[0.85em] text-foreground">{text}</span>
              </span>
            </Tooltip>
          );
        }
        return (
          <LocalFileLink
            linker={linker}
            path={pathText}
            line={line}
            linkClassName="font-mono text-[0.85em] text-info underline-offset-2 hover:underline"
          >
            {caption?.display ?? pathDisplayLabel(resolved.absolute)}
          </LocalFileLink>
        );
      }
      return <code {...rest}>{children}</code>;
    },
  }) as unknown as Components;

interface MarkdownTextProps {
  text: string;
  /** 是否流式中（AI 还在吐字）——开动画光标 + 未闭合块平滑处理 */
  streaming?: boolean;
  /** 相对路径解析基准（task cwd）；不传则路径类 inline code 退化为纯文本 */
  baseDir?: string;
  /** chat = 事件流密度；document = 产物栏 / 预览弹窗文档面（同 MARKDOWN_PROSE_DOCUMENT） */
  variant?: "chat" | "document";
  /** 外层 prose 容器额外 class */
  className?: string;
  /** 栏内搜索：事件 / 产物 ownerId（与 PaneSearchHighlightContext 或显式 props 配合） */
  searchOwnerId?: string;
  /** 栏内搜索字段 key，默认 body */
  searchField?: string;
  /** 显式搜索高亮（产物栏等不挂 Context 时用） */
  searchQuery?: string;
  searchActiveGlobalIndex?: number;
  searchGlobalOffset?: number;
}

const MarkdownTextImpl = ({
  text,
  streaming,
  baseDir,
  variant = "chat",
  className,
  searchOwnerId,
  searchField = "body",
  searchQuery: searchQueryProp,
  searchActiveGlobalIndex: searchActiveProp = -1,
  searchGlobalOffset: searchGlobalOffsetProp,
}: MarkdownTextProps) => {
  const linker = useLocalFilePathLinker(baseDir);
  const components = useMemo(
    () => buildMarkdownComponents(linker),
    [linker],
  );
  const ctxHighlight = useSearchFieldGlobalOffset(
    searchOwnerId ?? "",
    searchField,
  );
  const searchQuery = searchQueryProp ?? ctxHighlight?.query ?? "";
  const searchActiveGlobalIndex =
    searchActiveProp >= 0
      ? searchActiveProp
      : (ctxHighlight?.activeGlobalIndex ?? -1);
  const searchGlobalOffset =
    searchGlobalOffsetProp ?? ctxHighlight?.globalOffset ?? -1;

  const rehypePlugins = useMemo(() => {
    const base = [...STREAMDOWN_REHYPE_PLUGINS];
    if (searchQuery.trim() && searchGlobalOffset >= 0) {
      base.push(
        rehypeSearchHighlight({
          query: searchQuery,
          activeGlobalIndex: searchActiveGlobalIndex,
          globalOffset: searchGlobalOffset,
        }),
      );
    }
    return base;
  }, [searchQuery, searchActiveGlobalIndex, searchGlobalOffset]);

  return (
  <div
    data-search-content="true"
    className={cn(
      variant === "document"
        ? MARKDOWN_PROSE_DOCUMENT
        : [
            "prose prose-sm dark:prose-invert min-w-0 max-w-full wrap-break-word",
            // 聊天密度：默认 prose 段间距太松、缩紧
            "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
            "prose-headings:mt-2 prose-headings:mb-1",
            "prose-code:before:content-none prose-code:after:content-none",
          ],
      className,
    )}
  >
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      // 流式末尾闪烁光标（caret 无默认、不显式传就没光标）
      caret={streaming ? "block" : undefined}
      shikiTheme={SHIKI_THEME}
      plugins={STREAMDOWN_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={components}
      controls={STREAMDOWN_CONTROLS}
      // 行号视觉上不要（globals.css 藏 ::before 计数器）、但 **不能传 lineNumbers=false**：
      // 上游该路径行 span 不带 block class 也不吐换行、整块代码塌成一行（headless 实测）
    >
      {text}
    </Streamdown>
  </div>
  );
};

// memo：text 频繁因 chunk 追加而变化、其它 props 稳定——SSE 推 chunk 时才重渲
export const MarkdownText = memo(MarkdownTextImpl);
