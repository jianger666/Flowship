/**
 * remark：给顶层块打 data-revision-*（块级增删改左边条 / 跳转锚点）
 * blockMarks 的 index 对齐 buildRevisionView 输出的顶层块序。
 *
 * 跳转 hit 策略（`jumpRevisionHit` 靠 `[data-revision-hit]` 逐个跳，一处改动只能命中一次）：
 * - added / removed：整块带 data-revision-hit（无内联标记）
 * - modified 且块内有 ins/del：只打 status / 左边条，跳转靠块内 ins/del 的 hit（避免一处改动命中两次）
 * - modified 但块内没有 ins/del（只改了格式 / 结构、整块代码 / 表格被改、列表整项增删按块回退…）：
 *   块上带 data-revision-hit="modified"——否则「下一处改动」永远够不到这些块
 *
 * 注意两个渲染端的坑（见 revision-rehype-plugins.ts 与下面的 {@link remarkAnnotateRevisionBlocks}）：
 * - 块上的 data-* 要放行 sanitize 才到得了 DOM；
 * - Streamdown 的处理器缓存键是「插件函数名 + JSON.stringify(options)」，闭包式匿名插件会撞键。
 */

interface MdNode {
  type: string;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

export interface RevisionBlockAnnotate {
  index: number;
  status: "modified" | "added" | "removed";
}

interface AnnotateOptions {
  marks: RevisionBlockAnnotate[];
}

/** 子树里是否已有提升好的词级修订节点（remarkSentinelToRevision 产出的 hName=ins|del） */
const hasInlineRevision = (node: MdNode): boolean =>
  node.data?.hName === "ins" ||
  node.data?.hName === "del" ||
  (node.children ?? []).some(hasInlineRevision);

/**
 * 具名插件函数（缓存键里的名字），marks 走 options。
 * 必须在 remarkSentinelToRevision 之后跑——这里靠它产出的 ins/del 节点判断「块内有没有词级修订」。
 */
function remarkAnnotateRevisionBlocksPlugin({ marks }: AnnotateOptions) {
  return (tree: MdNode) => {
    const map = new Map(marks.map((m) => [m.index, m]));
    const children = tree.children ?? [];
    children.forEach((node, i) => {
      const mark = map.get(i);
      const prev = node.data?.hProperties ?? {};
      let hit: string | undefined;
      if (mark) {
        if (mark.status === "added" || mark.status === "removed") {
          hit = mark.status;
        } else if (!hasInlineRevision(node)) {
          hit = "modified";
        }
      }
      const hProperties = {
        ...prev,
        "data-block-index": i,
        ...(mark ? { "data-revision-status": mark.status } : {}),
        ...(hit ? { "data-revision-hit": hit } : {}),
      };
      // 代码块（含 mermaid）：Streamdown 用自己的 code-block 组件渲染，不转发 hast 属性，
      // 标在 node 上到不了 DOM。块级公式（math）同理：remark-math 产出 `pre > code.language-math`，
      // rehype-katex 把整个 `pre` 替换成 katex-display，`pre` 上的 data-* 随之丢失
      // （放行 data-revision-status / data-block-index 之后，公式块的左边条 / 角标仍然出不来，真实 SSR 实测）。
      // 需要 hit 时包一层 div 承载（位置不变，index 不错位；
      // 无 hit 的代码 / 公式块不包，渲染与原来一致）。raw html 顶层块不包：包一层会改变
      // 跨块未闭合标签的解析，而且它本身不是 element、没法带属性——这类块仍够不到，属已知局限。
      if (hit && (node.type === "code" || node.type === "math")) {
        children[i] = {
          type: "revisionBlock",
          data: { hName: "div", hProperties },
          children: [node],
        };
        return;
      }
      node.data = { ...node.data, hProperties };
    });
  };
}

/**
 * 用法不变：`remarkAnnotateRevisionBlocks(blockMarks)` 放进 remarkPlugins 数组。
 *
 * 返回 `[插件, { marks }]` 而不是闭包：Streamdown 缓存 unified 处理器，键 =
 * 各插件的 `function.name`（tuple 形式再拼 `JSON.stringify(options)`）。
 * 闭包式匿名插件 name 恒为空串，所有 marks 共用一个键 → 第二次渲染复用第一次的处理器、
 * 块标注停在旧文档的 marks 上（切换产物 / 版本后标到别的块）。把 marks 放进 options 键才随内容变。
 * 只带 index / status（别带 oldSource：它会进缓存键、也被缓存的处理器长期持有）。
 */
export const remarkAnnotateRevisionBlocks = (
  marks: RevisionBlockAnnotate[],
): [typeof remarkAnnotateRevisionBlocksPlugin, AnnotateOptions] => [
  remarkAnnotateRevisionBlocksPlugin,
  { marks: marks.map(({ index, status }) => ({ index, status })) },
];
