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

import { memo } from "react";
import {
  Streamdown,
  defaultRemarkPlugins,
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
import { MarkdownLink } from "@/components/markdown-link";
import { MarkdownImage } from "@/components/ui/image-preview";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";

// 插件实例全局一份（Shiki 高亮器有初始化开销、别每次 render 新建）
const STREAMDOWN_PLUGINS = { code, mermaid, math, cjk };
// Shiki 主题对（浅 / 深）——跟站内 next-themes 的 .light/.dark 对齐
const SHIKI_THEME: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];
// remark 插件：**必须带上 Streamdown 内置的 defaultRemarkPlugins（含 remark-gfm）**——
// 直接传 remarkPlugins 是整表替换、不追加、漏了 gfm 表格/删除线/autolink 全失效
//（审计 P1 实锤）；我们两个自定义插件跟在其后
const REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkKeepTrailingUnderscore,
  remarkTrimAutolinkCjk,
];
// a/img 覆盖：我们的组件用宽松 props（string|Blob 等）、跟 Streamdown Components 的
// 严格签名对不上、这里整体断言（运行时形状兼容、只是类型系统更严）
const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
} as unknown as Components;

interface MarkdownTextProps {
  text: string;
  /** 是否流式中（AI 还在吐字）——开动画光标 + 未闭合块平滑处理 */
  streaming?: boolean;
}

const MarkdownTextImpl = ({ text, streaming }: MarkdownTextProps) => (
  <div
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none wrap-break-word",
      // 聊天密度：默认 prose 段间距太松、缩紧
      "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
      "prose-headings:mt-2 prose-headings:mb-1",
      "prose-code:before:content-none prose-code:after:content-none",
    )}
  >
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      // 流式末尾闪烁光标（审计 P1：caret 无默认、不显式传就没光标）
      caret={streaming ? "block" : undefined}
      shikiTheme={SHIKI_THEME}
      plugins={STREAMDOWN_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </Streamdown>
  </div>
);

// memo：text 频繁因 chunk 追加而变化、其它 props 稳定——SSE 推 chunk 时才重渲
export const MarkdownText = memo(MarkdownTextImpl);
