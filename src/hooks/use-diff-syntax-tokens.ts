"use client";

/**
 * diff 语法高亮 hook：把 diff 行变成「每行一串带颜色的 token」。
 *
 * 引擎复用聊天代码块那一套（@streamdown/code → Shiki，github-light / github-dark 双主题），
 * 所以颜色与聊天里的代码块一致、语言覆盖 200+、不新增依赖。
 *
 * 高亮是异步的（Shiki 首次按语言加载文法）：
 * - 没出结果前返回 null / 对应行 null，调用方走原来的整行红绿色，出结果后再补色，版面不抖（只换颜色）；
 * - 结果存进模块级缓存（按「语言 + 源码」，LRU + 体积上限 + 上游无响应超时兜底，见 `lib/diff-syntax-store`），
 *   同一份 hunk 再次出现（切回文件、面板自动刷新但这块没变）首帧就是带色的，不会闪一下无色。
 * 纯逻辑（分段、核对、铺回行号）在 `lib/diff-syntax.ts`。
 */

import { useEffect, useMemo, useReducer } from "react";
import {
  code as shikiCode,
  type HighlightOptions,
  type HighlightResult,
  type ThemeInput,
} from "@streamdown/code";

import {
  assembleDiffLineTokens,
  buildDiffSegments,
  shouldHighlightDiff,
  type DiffSyntaxToken,
} from "@/lib/diff-syntax";
import { createDiffSyntaxStore } from "@/lib/diff-syntax-store";
import type { DiffViewLine } from "@/lib/tool-display";

/** 与 markdown-text.tsx 的 SHIKI_THEME 同一对：上游缓存键含主题名，对齐才能共用 */
const DIFF_SHIKI_THEMES: [ThemeInput, ThemeInput] = [
  "github-light",
  "github-dark",
];

type ShikiLanguage = HighlightOptions["language"];

/**
 * 模块级结果仓（缓存 / 合并请求 / 超时兜底都在 `lib/diff-syntax-store`，可脱离 React 单测）。
 * 上游高亮器在这里接上：`highlight` 命中上游缓存同步返回、否则结果走回调。
 */
const store = createDiffSyntaxStore({
  highlight: (language, code, callback) =>
    shikiCode.highlight(
      {
        code,
        language: language as ShikiLanguage,
        themes: DIFF_SHIKI_THEMES,
      },
      (result: HighlightResult) => callback(result),
    ),
});

/**
 * @param lines    parseUnifiedDiff 的结果（引用要稳定，调用方 useMemo）
 * @param language Shiki 语言 id；null / 高亮器不认 = 不上色
 * @returns 与 lines 等长的数组；某行 null = 这行暂时没有语法色；整体 null = 不上色
 */
export const useDiffSyntaxTokens = (
  lines: DiffViewLine[],
  language: string | null,
): (DiffSyntaxToken[] | null)[] | null => {
  // 每个请求完成 bump 一次，驱动下面的 useMemo 重新从缓存里铺色
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  const segments = useMemo(() => {
    if (!language || !shouldHighlightDiff(lines)) return [];
    if (!shikiCode.supportsLanguage(language as ShikiLanguage)) return [];
    return buildDiffSegments(lines);
  }, [lines, language]);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    for (const seg of segments) {
      if (store.has(language, seg.code)) {
        // 这一份又被用到了：刷新它的新旧（LRU），反复看的 hunk 不会因为「写得早」先被挤掉
        store.touch(language, seg.code);
        continue;
      }
      void store.request(language, seg.code).then(() => {
        if (!cancelled) bump();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [segments, language]);

  return useMemo(() => {
    if (!language || segments.length === 0) return null;
    return assembleDiffLineTokens(
      lines,
      segments,
      (seg) => store.get(language, seg.code) ?? null,
    );
    // version 不在函数体里用到：它的变化 = 缓存里有新结果，需要重新铺一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, segments, language, version]);
};
