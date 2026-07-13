/**
 * remark：给顶层块打 data-revision-*（块级增删改左边条 / 跳转锚点）
 * blockMarks 的 index 对齐 buildRevisionView 输出的顶层块序。
 *
 * 跳转 hit 策略（避免 modified 块被块级 + 内联 ins/del 重复命中）：
 * - added / removed：整块带 data-revision-hit（无内联标记）
 * - modified：只打 status / 左边条，跳转靠块内 ins/del 的 hit
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

export const remarkAnnotateRevisionBlocks =
  (marks: RevisionBlockAnnotate[]) => () => (tree: MdNode) => {
    const map = new Map(marks.map((m) => [m.index, m]));
    const children = tree.children ?? [];
    children.forEach((node, i) => {
      const mark = map.get(i);
      const prev = node.data?.hProperties ?? {};
      node.data = {
        ...node.data,
        hProperties: {
          ...prev,
          "data-block-index": i,
          ...(mark
            ? {
                "data-revision-status": mark.status,
                // modified 不带块级 hit——跳转靠块内 ins/del
                ...(mark.status === "added" || mark.status === "removed"
                  ? { "data-revision-hit": mark.status }
                  : {}),
              }
            : {}),
        },
      };
    });
  };
