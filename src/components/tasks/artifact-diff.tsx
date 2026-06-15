"use client";

/**
 * V0.5.12：artifact diff 视图（react-diff-viewer-continued 包装）
 *
 * 设计：
 * - useDarkTheme 跟随 next-themes 的 resolvedTheme（V0.7.20 主题化前是写死 dark）
 * - splitView=false → inline 模式（行内、增删合并展示）、splitView=true → side-by-side
 * - compareMethod=WORDS_WITH_SPACE：词级 diff、对 markdown 段落级修改友好
 * - showDiffOnly=true：折叠未变行（artifact 长、不折叠刷屏；用户点折叠条可展开）
 * - hideSummary=true：lib 自带顶部 summary bar 跟我们 artifact-panel 自己的 toolbar 重复、隐掉
 * - extraLinesSurroundingDiff=3：每个 diff hunk 上下展开 3 行上下文（默认值、明写注释）
 *
 * V0.5.12.1（用户反馈「raw text 太代码风」、拍板 C 方案：raw text + 语法高亮）：
 * - 接 prismjs + prism-markdown 语言定义、给 markdown 语法标记（# 标题、* 强调、` 代码、> 引用、列表等）
 * - 通过 renderContent prop 注入 Prism 高亮器、给词级 diff 也叠加 syntax 颜色
 * - 不是「rendered markdown」、是「VSCode 打开 .md 的视感」、性价比方案
 *
 * V0.7.20 主题化：不再 import prism-tomorrow.css（dark-only 全局主题）——token 颜色统一走
 * globals.css 的 `.token.*` 主题变量（light 压暗 / dark 提亮）、和全站主题一致、light 下也可读。
 */

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import Prism from "prismjs";
// 顺序敏感：prism core 先 import、再 import markdown 语言定义（注册到 Prism.languages.markdown）
import "prismjs/components/prism-markdown";

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
}: Props) => {
  // diff viewer 的明暗跟随全站主题；mounted 前默认 dark、避免水合首帧闪色
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = !mounted || resolvedTheme === "dark";

  return (
    <ReactDiffViewer
      oldValue={oldText}
      newValue={newText}
      splitView={splitView}
      useDarkTheme={isDark}
      compareMethod={DiffMethod.WORDS_WITH_SPACE}
      showDiffOnly
      hideSummary
      extraLinesSurroundingDiff={3}
      leftTitle={leftTitle}
      rightTitle={rightTitle}
      renderContent={highlightMarkdown}
    />
  );
};
