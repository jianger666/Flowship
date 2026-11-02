/**
 * 修订视图的 remark 插件表（render 侧生产组合）——抽成 `.ts` 让视图组件与测试共用同一份顺序，
 * 避免「测试 harness 自己拼一份、与生产漂移」（第 2 轮 harness 缺 cjk / math 就是这么漏掉问题的）。
 *
 * 顺序约束（注释即契约，tests/revision-render-chain.test.ts 有行为用例钉住）：
 * 1. `remarkSentinelToRevision` 必须在 `remarkAnnotateRevisionBlocks` 之前——后者靠前者产出的 ins/del
 *    判断「modified 块内是否已有词级标记」；
 * 2. `remarkAnnotateRevisionBlocks` 必须在 `remarkCodeReference` 之前：blockMarks.index 对齐的是
 *    buildRevisionView 输出（= parse 侧）的顶层块序，而 remarkCodeReference 会在每个「行号:行号:路径」
 *    代码围栏前面插入一个出处段落——它若先跑，顶层块序整体后移一格，其后所有块的标注错位一格
 *    （改动的标记打到前一个块上，真正改动的块没标记）。让标注先跑，再由 remarkCodeReference
 *    在标注好的块（包括被 revisionBlock 包裹的代码块）里就地插入出处段落，不影响块序。
 */
import { defaultRemarkPlugins } from "streamdown";
import type { Pluggable } from "unified";

import { remarkSentinelToRevision } from "./md-revision";
import { remarkAnnotateRevisionBlocks } from "./remark-annotate-revision-blocks";
import type { RevisionBlockAnnotate } from "./remark-annotate-revision-blocks";
import { remarkCodeReference } from "./remark-code-reference";
import { remarkKeepTrailingUnderscore } from "./remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "./remark-trim-autolink-cjk";

interface RevisionRemarkOptions {
  /**
   * 是否挂「哨兵 → ins/del」插件，默认 true。
   * 视图已降级为无标记纯渲染（stats.leakFallback）时传 false：此时渲染的是原样的新版全文，
   * 其中可能含字面的私有区字符，不能再被当哨兵消费（成对会变假 ins/del，孤儿会被静默吃掉）。
   */
  sentinels?: boolean;
}

export const createRevisionRemarkPlugins = (
  blockMarks: RevisionBlockAnnotate[],
  options: RevisionRemarkOptions = {},
): Pluggable[] => [
  ...Object.values(defaultRemarkPlugins),
  remarkKeepTrailingUnderscore,
  remarkTrimAutolinkCjk,
  ...(options.sentinels === false ? [] : [remarkSentinelToRevision]),
  remarkAnnotateRevisionBlocks(blockMarks),
  remarkCodeReference,
];
