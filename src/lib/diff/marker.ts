/**
 * `\ No newline at end of file` 标记行的判定。
 *
 * 单独放一个无运行时依赖的小文件：diff 模型（model）、词级高亮（intraline）、语法高亮（diff-syntax）
 * 都要认它——三处各写一份，哪天改了一处就会悄悄不一致；而 model 已经引用 intraline，
 * 反过来让 intraline 引用 model 会成环。
 */
import type { DiffViewLine } from "@/lib/tool-display";

/**
 * 是不是 `\ No newline at end of file` 标记行（git 会按 locale 本地化文案，所以认「反斜杠 + 空格」开头）。
 *
 * `parseUnifiedDiff` 把它当 context 行返回：text 保留原样（含 `\`）、没有行号。
 * 光看「context 且没行号」不够——缺 `@@` 头的残缺 diff 里真正的上下文行也没行号，所以再加上文字前缀。
 *
 * 它属于**紧挨在它前面的那一行**（那一侧的最后一行没有结尾换行），不是独立的一行：
 * 切变更块、配对词级高亮、摆分栏时都不能把它当成「上下文」去打断前后的删 / 增行。
 */
export const isNoNewlineMarker = (line: DiffViewLine): boolean =>
  line.kind === "context" &&
  line.oldLine === undefined &&
  line.newLine === undefined &&
  line.text.startsWith("\\ ");
