"use client";

/**
 * V0.5.12：artifact diff 视图（react-diff-viewer-continued 包装）
 *
 * 设计：
 * - 项目 next-themes forcedTheme="dark"、直接写 useDarkTheme=true、不做动态探测
 * - splitView=false → inline 模式（行内、增删合并展示）、splitView=true → side-by-side
 * - compareMethod=WORDS_WITH_SPACE：词级 diff、对 markdown 段落级修改友好
 * - showDiffOnly=true：折叠未变行（artifact 长、不折叠刷屏；用户点折叠条可展开）
 * - hideSummary=true：lib 自带顶部 summary bar 跟我们 artifact-panel 自己的 toolbar 重复、隐掉
 * - extraLinesSurroundingDiff=3：每个 diff hunk 上下展开 3 行上下文（默认值、明写注释）
 *
 * V0.5.12.1（用户反馈「raw text 太代码风」、拍板 C 方案：raw text + 语法高亮）：
 * - 接 prismjs + prism-markdown 语言定义、给 markdown 语法标记（# 标题、* 强调、` 代码、> 引用、列表等）
 * - 主题用 prism-tomorrow（dark 友好、token 颜色明显）
 * - 通过 renderContent prop 注入 Prism 高亮器、给词级 diff 也叠加 syntax 颜色
 * - 不是「rendered markdown」、是「VSCode 打开 .md 的视感」、性价比方案
 *
 * 为啥不抽 useDarkTheme prop：项目 hard force dark、`light` 视觉根本不会出现、扛标志位徒增 surface
 */

import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import Prism from "prismjs";
// 顺序敏感：prism core 先 import、再 import markdown 语言定义（注册到 Prism.languages.markdown）
import "prismjs/components/prism-markdown";
// dark theme：tomorrow 紫红绿色 token、跟 react-diff-viewer dark 灰背景兼容
import "prismjs/themes/prism-tomorrow.css";

interface Props {
  // 旧版本正文（如「上次 revision」/「初版」）
  oldText: string;
  // 新版本正文（如当前 artifact）
  newText: string;
  // 左侧标题、显示哪个时刻
  leftTitle?: string;
  // 右侧标题
  rightTitle?: string;
  // true = side-by-side、false = inline（默认 false、artifact-panel 不宽、inline 更紧凑）
  splitView?: boolean;
}

// markdown 行级 / 词级片段都过这个高亮器
// Prism.highlight 输入空字符串返回空字符串、ok
// dangerouslySetInnerHTML 安全性：Prism 只输出 <span class="token ..."> 结构、不会注入 user-supplied script
const highlightMarkdown = (source: string) => (
  <span
    dangerouslySetInnerHTML={{
      __html: Prism.highlight(source, Prism.languages.markdown, "markdown"),
    }}
  />
);

export const ArtifactDiff = ({
  oldText,
  newText,
  leftTitle,
  rightTitle,
  splitView = false,
}: Props) => (
  <ReactDiffViewer
    oldValue={oldText}
    newValue={newText}
    splitView={splitView}
    useDarkTheme
    compareMethod={DiffMethod.WORDS_WITH_SPACE}
    showDiffOnly
    hideSummary
    extraLinesSurroundingDiff={3}
    leftTitle={leftTitle}
    rightTitle={rightTitle}
    renderContent={highlightMarkdown}
  />
);
