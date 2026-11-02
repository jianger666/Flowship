/**
 * 修订视图「改变 markdown 语法解析」的插件——parse 侧（md-revision.ts 切块 / 配对 / 复验）与
 * render 侧（artifact-revision-view.tsx 的 Streamdown `plugins`）共用这一份，不各写各的。
 *
 * 为什么必须一致：词级 diff 把哨兵塞进 markdown 源码，parse 侧据此判断「哨兵落在哪种节点里」。
 * parse 侧只有 gfm 时，渲染侧多出来的语法对它是盲区：
 * - math（`$$…$$` 行内 / 块级公式）：parse 侧当普通段落文本，哨兵被塞进公式源码，
 *   渲染端 KaTeX 拿到私有区字符 → 公式报错且哨兵字面量泄漏到页面（真实渲染链实测）；
 * - cjk-friendly：改变强调 / 删除线的边界判定（`**“重点”**内容`），parse 侧看到的行内节点与渲染侧不同。
 *
 * 渲染侧 Streamdown 内部拼装顺序（streamdown dist `plugins.cjk` / `plugins.math` 的处理）：
 * `[...cjk.remarkPluginsBefore, ...用户 remarkPlugins, ...cjk.remarkPluginsAfter, math.remarkPlugin]`，
 * 其中「用户 remarkPlugins」= defaultRemarkPlugins（gfm / codeMeta）+ 业务插件。
 * parse 侧只 `.parse()`、不跑 transformer，所以业务插件（code-reference / 哨兵转换 / 块标注…）不需要，
 * 但语法扩展（micromark）的相对顺序要与渲染侧一致，这里按同一顺序拼。
 */
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { defaultRemarkPlugins } from "streamdown";
import type { Pluggable } from "unified";

/** 传给 Streamdown `plugins` 的语法类插件（render 侧引用这个常量；code / mermaid 只影响渲染不影响切块，不在此列） */
export const REVISION_SYNTAX_PLUGINS = { cjk, math } as const;

/** parse 侧的 remark 插件表：与 Streamdown 内部对 `plugins.cjk` / `plugins.math` 的拼装顺序一致 */
export const REVISION_PARSE_REMARK_PLUGINS: Pluggable[] = [
  ...REVISION_SYNTAX_PLUGINS.cjk.remarkPluginsBefore,
  ...Object.values(defaultRemarkPlugins),
  ...REVISION_SYNTAX_PLUGINS.cjk.remarkPluginsAfter,
  REVISION_SYNTAX_PLUGINS.math.remarkPlugin,
];
