/**
 * Streamdown 的「配置常量 + 流式 → 定稿的模式判定」（纯 TS、不碰 React / DOM）。
 *
 * 单独成文件的原因：markdown-text.tsx 是 .tsx（vitest 不转 JSX、测试没法 import），
 * 而这几样东西都需要「修前红、修后绿」的行为测试（tests/streamdown-options.test.ts）。
 */
import {
  defaultRehypePlugins,
  parseMarkdownIntoBlocks,
  type StreamdownProps,
  type StreamdownTranslations,
} from "streamdown";

import {
  rehypeBlockUncReferences,
  rehypeRewriteLocalImages,
} from "@/lib/rehype-rewrite-local-images";

/**
 * rehype：传自定义列表也是整表替换。顺序 = raw → UNC 拦截 → 本地图改写 → sanitize → harden。
 * - UNC 拦截必须在 harden 之前（harden 会把 `//host/x` 改成 `/x`，host 被吞，之后没人认得出 UNC，Q4-06）；
 * - 本地图必须在 sanitize 前改写（file:// 会被剥 src）；artifact / 修订视图共用此表。
 */
export const STREAMDOWN_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  rehypeBlockUncReferences,
  rehypeRewriteLocalImages,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];

/**
 * remend 配置：不完整的链接只显示文字、不画链接。
 *
 * 默认 `linkMode: "protocol"` 会把流式中还没写完的 `[文字](https://exa` 补成
 * `[文字](streamdown:incomplete-link)`；这个占位 URL 过不了管线里的 rehype-harden，
 * 被替换成灰色的 `文字 [blocked]`（还带原生 title `Blocked URL: undefined`）——
 * 每个链接在写完前都会闪一下英文（2026-10-20 第二轮 review V15-02，实测前缀里 81% 受影响）。
 * `text-only` 直接把没写完的链接显示成纯文字，链接写完那一帧再变成可点链接。
 */
export const STREAMDOWN_REMEND_OPTIONS: NonNullable<StreamdownProps["remend"]> =
  { linkMode: "text-only" };

/**
 * Streamdown 内置控件（代码块复制、mermaid 全屏 / 下载、表格复制 / 下载、外链确认、图片兜底）的中文文案。
 * 键名来自 streamdown 2.5.0 `StreamdownTranslations`；写成完整类型（不是 Partial）——
 * 升级后上游新增键时 tsc 会直接报错，不会悄悄漏出英文（tests 里还有一条键集合对照）。
 */
export const STREAMDOWN_TRANSLATIONS_ZH: StreamdownTranslations = {
  close: "关闭",
  copied: "已复制",
  copyCode: "复制代码",
  copyLink: "复制链接",
  copyTable: "复制表格",
  copyTableAsCsv: "复制为 CSV",
  copyTableAsMarkdown: "复制为 Markdown",
  copyTableAsTsv: "复制为 TSV",
  downloadDiagram: "下载图表",
  downloadDiagramAsMmd: "下载为 MMD",
  downloadDiagramAsPng: "下载为 PNG",
  downloadDiagramAsSvg: "下载为 SVG",
  downloadFile: "下载文件",
  downloadImage: "下载图片",
  downloadTable: "下载表格",
  downloadTableAsCsv: "下载为 CSV",
  downloadTableAsMarkdown: "下载为 Markdown",
  exitFullscreen: "退出全屏",
  externalLinkWarning: "你即将访问一个外部网站。",
  imageNotAvailable: "图片无法显示",
  mermaidFormatMmd: "MMD",
  mermaidFormatPng: "PNG",
  mermaidFormatSvg: "SVG",
  openExternalLink: "要打开外部链接吗？",
  openLink: "打开链接",
  tableFormatCsv: "CSV",
  tableFormatMarkdown: "Markdown",
  tableFormatTsv: "TSV",
  viewFullscreen: "全屏查看",
};

/**
 * 引用定义行：`[label]: destination`（行首缩进 ≤ 3 个空格；`[^x]:` 是脚注、由上游自己整篇处理，这里排除）。
 * 宁可误判（代码块里形似定义的行也命中）也不漏判——误判的代价只是这一篇不拆块（与 static 同构），不影响正确性。
 */
const REFERENCE_DEFINITION_RE = /^ {0,3}\[(?!\^)[^\]\n]+\]:\s*\S/m;

/**
 * 传给 Streamdown 的 `parseMarkdownIntoBlocksFn`（R8-01）：文本里有引用定义就**整篇当一个块**，否则走上游逐块解析。
 *
 * 为什么：streaming 模式把全文按块拆开、逐块解析，引用式链接 `[文档][1]` 的定义 `[1]: https://…` 在另一个块里，
 * 块之间不共享定义（上游只对脚注有这个特判）→ 引用式链接全成字面量。而「流式过的实例定稿后恒用 streaming 模式」
 * （见 {@link resolveStreamdownMode}）让这个问题**固化**了：旧版定稿换 static 会自愈，现在不会。
 * 整篇一个块 = 与 static 同构的解析语义；流式中定义行一到达链接就生效（之前整个流式期间都是字面量）。
 * 没有引用定义的文本（绝大多数）仍逐块解析，流式性能不变。
 *
 * 上游 memo 比较器**不看**这个 prop，所以必须是模块级常量（引用稳定）、内部只看文本、不看流式状态。
 */
export const parseMarkdownIntoBlocksKeepReferences = (
  markdown: string,
): string[] =>
  REFERENCE_DEFINITION_RE.test(markdown)
    ? [markdown]
    : parseMarkdownIntoBlocks(markdown);

/** 末行是引用定义（含半截：`[1]:`、`[1]: h`、`[1]: https://exa`），且没有换行收尾 */
const TRAILING_DEFINITION_LINE_RE = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S*$/;

/**
 * 去掉「末尾正在写的引用定义行」（没有换行收尾的最后一行）。
 * 只在流式中用：定义行逐字到达时，`[文档][1]` 会先解析到被截断的 URL（`https://e/`、`https://ex/`…），
 * 链接文字变蓝可点、点了打开截断域名（Q7b-01，R8-01 整篇单块的副作用）。把这一行当未完成处理——
 * 定义行写完（换行收尾）或定稿（走 {@link parseMarkdownIntoBlocksKeepReferences}，不裁）那一刻链接才生效。
 */
export const stripTrailingDefinitionLine = (markdown: string): string => {
  const cut = markdown.lastIndexOf("\n") + 1;
  return TRAILING_DEFINITION_LINE_RE.test(markdown.slice(cut))
    ? markdown.slice(0, cut)
    : markdown;
};

/**
 * 流式中用的 `parseMarkdownIntoBlocksFn`（Q7b-01）：与 {@link parseMarkdownIntoBlocksKeepReferences} 同口径，
 * 只是先裁掉末尾未写完的引用定义行。同样必须是模块级常量；MarkdownText 按 `streaming` 在两个常量间选，
 * 定稿那一帧（isAnimating true → false、children 换成定稿全文）带出重渲、换成不裁的版本。
 */
export const parseMarkdownIntoBlocksKeepReferencesStreaming = (
  markdown: string,
): string[] => parseMarkdownIntoBlocksKeepReferences(stripTrailingDefinitionLine(markdown));

export interface StreamdownModeProps {
  /** 传给 Streamdown 的 `mode` */
  mode: "static" | "streaming";
  /**
   * 传给 Streamdown 的 `parseIncompleteMarkdown`（remend 补全未闭合标记）。
   * 只在 `mode="streaming"` 下生效：流式中要补；定稿后文本已完整，再补只会改写它，必须关。
   */
  parseIncompleteMarkdown: boolean;
  /** 是否用「限频高亮」的流式代码插件（流式过的实例定稿后也继续用，不换回上游 code） */
  throttledCode: boolean;
}

const STATIC_MODE: StreamdownModeProps = {
  mode: "static",
  parseIncompleteMarkdown: true,
  throttledCode: false,
};

/**
 * 决定 Streamdown 用哪个 mode（V15-01）。
 *
 * 上游 `mode` 一换，Streamdown 内部返回的子树形状就变：
 *   - `static`    → `<div>{<Markdown>整篇</Markdown>}</div>`（单个元素 child）
 *   - `streaming` → `<div>{[caret, blocks.map(<Block key>)]}</div>`（数组 child）
 * React 对「单元素 ↔ 数组」是 `reconcileSingleElement` / 数组协调两条路径，类型对不上就**删旧挂新**——
 * 所有 Block / 代码块 / mermaid 实例整棵重建（Shiki 的 `highlighted-body` 是 `useState(raw)` +
 * `useEffect` 里才上色，重挂后至少一帧无色；选区也会消失）。所以「流式 → 定稿」时 mode 一换，
 * 就算 Virtuoso 外壳（lib/stream-handoff）接住了，Streamdown 里面照样整树重挂。
 *
 * 做法：**这个实例流式过，之后恒用 `streaming` 模式**，用 `isAnimating`（调用方另传）单独控制
 * 「还在不在吐字」；定稿时 `parseIncompleteMarkdown` 置 false（文本完整、不再补全）。
 * 从没流式过的实例（历史消息、产物栏、文件预览）仍走 `static`，整篇一次解析、不拆块，开销不变。
 *
 * ⚠ 上游 `Streamdown` 的 memo 比较**不看** `parseIncompleteMarkdown`：它靠定稿那一帧
 * `isAnimating` true → false（以及 children 换成定稿全文）带出重渲，这里的 false 才会生效。
 *
 * @param streaming 此刻是否还在流式吐字
 * @param hasStreamed 这个实例是否流式过（含此刻；调用方用 useRef 记、只增不减）
 */
export const resolveStreamdownMode = (
  streaming: boolean,
  hasStreamed: boolean,
): StreamdownModeProps => {
  if (!streaming && !hasStreamed) return STATIC_MODE;
  return {
    mode: "streaming",
    parseIncompleteMarkdown: streaming,
    throttledCode: true,
  };
};
