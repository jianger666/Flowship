/**
 * 修订视图专用的 rehype 插件表：在共用的 {@link STREAMDOWN_REHYPE_PLUGINS} 基础上，
 * 只给 sanitize 的属性白名单加上「下一处改动」导航用的 `data-revision-hit`。
 *
 * 为什么需要：Streamdown 默认的 sanitize 用 hast-util-sanitize 的 defaultSchema，不放行 `data-*`。
 * remarkAnnotateRevisionBlocks 打在块上的 `data-revision-hit` 在 sanitize 这一步就被剥掉了，
 * DOM 里根本没有——`jumpRevisionHit`（`querySelectorAll("[data-revision-hit]")`）只够得到
 * 修订视图自定义 `<ins>/<del>` 组件自己写的那份，整块新增 / 删除 / 只改了格式的块跳不到。
 *
 * 放行三个只读标记属性（都带值域校验，值不合法的整个属性被剥掉）：
 * - `data-revision-hit`：枚举 ins | del | added | removed | modified（下一处改动导航）；
 * - `data-revision-status`：枚举 added | removed | modified（块级左边条 CSS `[data-revision-status=…]`、
 *   「已修改」角标的定位都靠它）；
 * - `data-block-index`：非负整数（≤ 9 位、无前导零；角标用它拼 `[data-block-index="N"]` 选择器）。
 *
 * 为什么要放行 status / block-index：它们原先被默认 schema 剥掉，导致左边条 / 角标 / 旧文弹窗
 * 在生产里整套不出现（代码写了但从未跑过）。放行后它们才真正生效，对应的 DOM / CSS / 弹窗路径由
 * tests/revision-render-chain.test.ts 的「块级状态」用例用真实 Streamdown SSR 逐个钉住。
 *
 * 属性名是 hast 规范化后的 camelCase（rehype-raw 之后 `data-revision-hit` → `dataRevisionHit`），写成 kebab 不生效。
 *
 * 安全面：这些属性只是样式 / 定位标记，不带行为；放行不削弱 sanitize 对脚本 / 事件属性 / 危险协议的过滤。
 * 不可信 markdown 里的原始 HTML（`<div data-revision-status="added">`）在 rehype-raw 之后与插件产出的节点
 * 无法区分，所以做不到「只有插件节点能带」；能做的是值域校验——攻击者最多伪造出一条左边条 /
 * 一个 hit 锚点（纯样式 + 导航落点），值永远落在有限枚举 / 整数里，进不了 class 名或任意 CSS 选择器；
 * 旧文弹窗的内容取自 buildRevisionView 的 blockMarks（不读 DOM），DOM 上伪造不出别的旧文内容。
 *
 * 不改 streamdown-options.ts：那张表被正文渲染共用，修订视图的需求不该放宽正文的白名单。
 */
import { createElement, type ReactNode } from "react";
import { defaultRehypePlugins } from "streamdown";

import { STREAMDOWN_REHYPE_PLUGINS } from "@/lib/streamdown-options";

/** 块下标值域：非负整数，≤ 9 位、无前导零（`007` / `-1` / `1e3` / `1 ` / 空串都不过） */
export const REVISION_BLOCK_INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;

/**
 * 修订视图额外放行的 hast 属性（hast-util-sanitize 的 PropertyDefinition：`[name, ...允许的值 | RegExp]`，
 * 多于一个值 = 白名单校验；单独写属性名则任意值放行，所以这里每项都带值域）
 */
export const REVISION_ALLOWED_ATTRIBUTES = [
  ["dataRevisionHit", "ins", "del", "added", "removed", "modified"],
  ["dataRevisionStatus", "added", "removed", "modified"],
  ["dataBlockIndex", REVISION_BLOCK_INDEX_RE],
] as const;

interface SanitizeSchema {
  attributes?: Record<string, unknown[]>;
  [key: string]: unknown;
}

/** 把 `[rehypeSanitize, schema]` 的 schema 通配属性加上白名单项；形状不认识就原样返回（测试会发现没生效） */
const widenSanitize = (entry: unknown): unknown => {
  if (!Array.isArray(entry)) return entry;
  const [plugin, schema] = entry as [unknown, SanitizeSchema | undefined];
  if (!schema || typeof schema !== "object") return entry;
  const attributes = schema.attributes ?? {};
  return [
    plugin,
    {
      ...schema,
      attributes: {
        ...attributes,
        "*": [...(attributes["*"] ?? []), ...REVISION_ALLOWED_ATTRIBUTES],
      },
    },
  ];
};

export const REVISION_REHYPE_PLUGINS = STREAMDOWN_REHYPE_PLUGINS.map((p) =>
  p === defaultRehypePlugins.sanitize ? widenSanitize(p) : p,
) as typeof STREAMDOWN_REHYPE_PLUGINS;

// ---------- ins / del 组件：只认修订渲染链自己打的标记 ----------

/** 新增：success 底衬；删除：destructive 底衬 + 删除线——两个 token 浅深两套都调过对比度 */
export const REVISION_INS_CLASS =
  "rounded-[2px] bg-success/15 px-0.5 text-success no-underline";
export const REVISION_DEL_CLASS =
  "rounded-[2px] bg-destructive/15 px-0.5 text-destructive line-through decoration-destructive/70";

interface InlineProps {
  children?: ReactNode;
  [key: string]: unknown;
}

/**
 * 生成 ins / del 组件：只有带修订标记（`data-revision-hit` = "ins" | "del"，由 remarkSentinelToRevision 提升节点时
 * 写进 hProperties、经 {@link REVISION_REHYPE_PLUGINS} 放行后落到元素上）的才画修订样式并带 hit。
 *
 * 为什么不能无条件套：GFM 删除线 `~~x~~` 和正文里自带的 `<del>` / `<ins>` 同样渲染成 <del> / <ins>。
 * 旧实现的组件对所有 <del> 都写 `data-revision-hit="del"` + 红色删除样式，
 * 「下一处改动」（`[data-revision-hit]`）会把正文里的删除线当成一处修订，样式上也像被删掉的内容。
 * 现在原生的按普通元素渲染（不带 hit、不套修订样式）。
 *
 * 模块级具名函数（不是每次 render 现建的闭包）：组件身份稳定，不会随父组件重渲染反复卸载重挂。
 */
const makeInlineRevision = (tag: "ins" | "del", className: string) => {
  const RevisionInline = ({ children, node, ...rest }: InlineProps) => {
    // Streamdown 会把 hast `node` 传给自定义组件；不剥掉会被展开到 DOM 上变成 node="[object Object]"
    void node;
    const marked = rest["data-revision-hit"] === tag;
    return marked
      ? createElement(
          tag,
          { ...rest, className, "data-revision-hit": tag },
          children,
        )
      : createElement(tag, rest, children);
  };
  RevisionInline.displayName = tag === "ins" ? "RevisionIns" : "RevisionDel";
  return RevisionInline;
};

export const RevisionIns = makeInlineRevision("ins", REVISION_INS_CLASS);
export const RevisionDel = makeInlineRevision("del", REVISION_DEL_CLASS);
