/**
 * remark 插件：把 GFM autolink 剥掉的「裸链接尾部下划线」缝回去（V0.7.13）
 *
 * 背景（用户实测 bug）：AI 输出裸 URL `https://…/xxx-ft_`、GFM autolink literal
 * 把结尾 `_` 当强调标点剥离——渲染出的链接少一个字符、点开 404。
 * CommonMark 对「尾部标点不进 autolink」是有意设计（句末 `提问？` 场景）、
 * 但 `_` 在真实 URL（短链 / share id）里是合法常见字符、剥掉弊大于利。
 *
 * 行为：只处理「裸链接」（link 的展示文本 === url、即 autolink 产物）、
 * 显式 `[文本](url)` 不动；把紧跟其后 text 节点开头的连续 `_` 挪回 url + 文本。
 */

// 不引 mdast 类型包（传递依赖、pnpm isolated 下不可直接 import）、自描述最小类型
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
}

export const remarkKeepTrailingUnderscore = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const cur = children[i];
      // 先深后处理、嵌套（段落里 strong 里的链接等）也覆盖
      walk(cur);
      if (cur.type !== "link" || !cur.url || !/^https?:\/\//.test(cur.url)) continue;
      const only = cur.children?.length === 1 ? cur.children[0] : undefined;
      // 裸链接特征：唯一 text 子节点、内容跟 url 一致（autolink 产物）
      if (!only || only.type !== "text" || only.value !== cur.url) continue;
      const next = children[i + 1];
      if (!next || next.type !== "text" || !next.value?.startsWith("_")) continue;
      const tail = /^_+/.exec(next.value)?.[0] ?? "";
      cur.url += tail;
      only.value += tail;
      next.value = next.value.slice(tail.length);
      if (!next.value) children.splice(i + 1, 1);
    }
  };
  walk(tree);
};
