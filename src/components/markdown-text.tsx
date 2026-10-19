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
import { streamingCodePlugin } from "@/lib/streaming-code-highlighter";
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
import { wrapLocalMarkdownImageDestinations } from "@/lib/local-image-src";
import { rehypeRewriteLocalImages } from "@/lib/rehype-rewrite-local-images";
import { remarkCodeReference } from "@/lib/remark-code-reference";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";

// 插件实例全局一份（Shiki 高亮器有初始化开销、别每次 render 新建）
const STREAMDOWN_PLUGINS = { code, mermaid, math, cjk };
// 流式中专用：代码块限频高亮。上游每帧把整块代码重新分词（缓存键含 length、增长中必 miss），
// 代码密集的回复里占主线程 ~40%；这里文字照常逐帧增长、只把「上色」摊薄（见 throttled-code-plugin.ts）。
// 流式结束后（streaming=false）换回上游插件：命中其缓存、即时补全最终配色。
const STREAMDOWN_STREAMING_PLUGINS = {
  ...STREAMDOWN_PLUGINS,
  code: streamingCodePlugin,
};
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

/** chat 变体的正文字号档，见 MarkdownTextProps.size */
export type MarkdownTextSize = "default" | "reply";

/**
 * 对话正文档（ui-conventions「字号阶梯」的 15px）。
 *
 * ⚠ 必须落在 **prose 元素自己**身上，包在外层 div 上无效：typography 的 `.prose-sm` 在 prose 元素上
 * 自带 `font-size:.875rem; line-height:1.714`，外层的 `text-[15px] leading-7` 只会被它盖掉——
 * 2026-07-21 立 15px 起 AI 正文实际一直是 14px / 24px，2026-10-12 浏览器实测才发现。
 * 所以 AI 回复一律传 `<MarkdownText size="reply">`；外层 wrapper 可以继续写这个常量
 * （给 wrapper 里非 prose 的元素用），但正文字号不靠它。
 */
export const MARKDOWN_REPLY_TEXT = "text-[15px] leading-7";

/**
 * task(log) 右栏的 AI 回复正文档：14px / leading-6（24px）= prose-sm 的原生值。
 *
 * 为什么 task 栏不跟 chat 用 15px：2026-10-12 事件流 v2 把 AI 正文真正落到 15px / 28px 后，
 * 用户（2026-10-13）反馈「事件流本身就不宽、文字变大了体验不好」——task 的事件流是右侧分栏、
 * 只有 chat 居中宽列（max-w-3xl）的一半多一点，每行字数少、行高又大，一屏装不下几句话。
 * 14px / 24px 正是 v2 之前用户一直在用的实际渲染值（三个月没人抱怨）。
 *
 * 所以这一档**不传 `size="reply"`**（走 default = prose-sm 原生 14px / 24px），
 * 外层 wrapper 用这个常量给非 prose 元素对齐；chat 宽列仍是 15px。
 * 流式占位与定稿必须同档，否则收尾换成正式行时整段文字会跳一下。
 */
export const MARKDOWN_LOG_REPLY_TEXT = "text-sm leading-6";

/**
 * reply 档在 prose 元素上加的类：正文 15px / leading-7 + 行内 code 钉 12px。
 * prose-sm 里行内 code 是 `.857em`，基准从 14px 抬到 15px 后会变 12.86px——落在字号阶梯
 * （15 / 14 / 12 / 11）之外，所以钉回 `text-xs`。选择器 `:not(pre)>code` 只命中行内 code，
 * 代码块里的 `pre > code` 不受影响（它由 globals.css 管）。
 */
const REPLY_PROSE_CLASS = cn(MARKDOWN_REPLY_TEXT, "[&_:not(pre)>code]:text-xs");

/**
 * 路径类行内 code（可点开的文件路径）的字号：默认 `0.85em`（14px 基准下 ≈ 12px）；
 * reply 档（15px 基准）下 em 派生会落到 12.75px（阶梯外），钉 `text-xs`。
 */
const PATH_CODE_SIZE: Record<MarkdownTextSize, string> = {
  default: "text-[0.85em]",
  reply: "text-xs",
};

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

/**
 * 不加载图片的占位（只显示 alt 文字）。用于**不可信来源**的 markdown（别家机器人发的群消息）：
 * 图片一渲染浏览器就会向 src 发请求，发消息的人能借此知道你什么时候打开、从哪个 IP 打开（追踪像素）。
 * 管线里 `harden` 对图片是全放行的（allowedImagePrefixes ["*"]、允许 data:），所以只能在组件层拦；
 * markdown 的 `![](url)` 和原始 HTML 的 `<img>` 最后都是 hast 的 img 元素、都走这个槽。
 */
export const BlockedMarkdownImage = ({ alt }: { alt?: string }) => (
  <span className="text-muted-foreground">[图片{alt ? `：${alt}` : ""}]</span>
);

const buildMarkdownComponents = (
  linker: LocalFilePathLinker,
  size: MarkdownTextSize,
  blockImages: boolean,
): Components =>
  ({
    a: MarkdownLink,
    img: blockImages ? BlockedMarkdownImage : MarkdownImage,
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
              className={PATH_CODE_SIZE[size]}
            />
          );
        }
        if (!resolved) {
          return (
            <Tooltip content={text}>
              <span className="min-w-0 max-w-full" {...rest}>
                <span className={cn("font-mono text-foreground", PATH_CODE_SIZE[size])}>
                  {text}
                </span>
              </span>
            </Tooltip>
          );
        }
        return (
          <LocalFileLink
            linker={linker}
            path={pathText}
            line={line}
            linkClassName={cn(
              "font-mono text-info underline-offset-2 hover:underline",
              PATH_CODE_SIZE[size],
            )}
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
  /**
   * 正文字号档（只对 variant="chat" 生效）：
   * - default：14px（prose-sm 原值）——问答卡、工具产出等次要面
   * - reply：对话正文 15px / leading-7（{@link MARKDOWN_REPLY_TEXT}）——**chat 宽列里的 AI 回复**用这档；
   *   task(log) 右栏窄、用 default（14px / 24px，见 {@link MARKDOWN_LOG_REPLY_TEXT}）。
   *   流式占位与定稿必须同档，否则流式结束换成正式行时整段文字会跳一下
   */
  size?: MarkdownTextSize;
  /**
   * 不加载图片（只显示「[图片：alt]」）。不可信来源的 markdown 用——别家机器人的群消息等：
   * 远程图片一渲染就会发请求（追踪像素）。AI 自己的回复 / 产物不传。
   */
  blockImages?: boolean;
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
  size = "default",
  blockImages = false,
  className,
  searchOwnerId,
  searchField = "body",
  searchQuery: searchQueryProp,
  searchActiveGlobalIndex: searchActiveProp = -1,
  searchGlobalOffset: searchGlobalOffsetProp,
}: MarkdownTextProps) => {
  const linker = useLocalFilePathLinker(baseDir);
  const components = useMemo(
    () => buildMarkdownComponents(linker, size, blockImages),
    [linker, size, blockImages],
  );
  // Application Support 等路径带空格：裸 markdown 图 destination 会被截断，包 <> 后再解析
  const displayText = useMemo(
    () => wrapLocalMarkdownImageDestinations(text),
    [text],
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
            size === "reply" && REPLY_PROSE_CLASS,
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
      plugins={streaming ? STREAMDOWN_STREAMING_PLUGINS : STREAMDOWN_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={components}
      controls={STREAMDOWN_CONTROLS}
      // 行号视觉上不要（globals.css 藏 ::before 计数器）、但 **不能传 lineNumbers=false**：
      // 上游该路径行 span 不带 block class 也不吐换行、整块代码塌成一行（headless 实测）
    >
      {displayText}
    </Streamdown>
  </div>
  );
};

// memo：text 频繁因 chunk 追加而变化、其它 props 稳定——SSE 推 chunk 时才重渲
export const MarkdownText = memo(MarkdownTextImpl);
