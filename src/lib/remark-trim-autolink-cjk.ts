/**
 * remark 插件：把 GFM autolink 误吞的「URL 后紧跟的中文 / 全角字符」切出来（V0.8.x）
 *
 * 背景（用户实测 bug）：AI 输出裸 URL 后直接跟中文、如
 * `…/merge_requests/3951。要我智能解决？` ——GFM autolink literal 只把 ASCII 标点
 * 当 URL 边界、中文句号「。」和后续汉字都不算标点 → 整段「。要我智能解决？」被吞进链接、
 * 点开 404、且后面正文也跟着变成可点链接的一部分。
 *
 * 行为：只处理「裸链接」（link 展示文本 === url、即 autolink 产物）、显式 `[文本](url)` 不动；
 * 找到 url 里第一个 CJK / 全角字符、从那里切断——前半留作真链接、后半（中文）挪回普通文本。
 * 跟 remark-keep-trailing-underscore 同一套 mdast 遍历模式。
 */

// 不引 mdast 类型包（传递依赖、pnpm isolated 下不可直接 import）、自描述最小类型
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
}

// 第一个中文 / 假名 / 全角字符的位置 = 裸 URL 真正的结束点。
// 覆盖：CJK 符号标点（含。、！？「」等、\u3000-\u303f）/ 假名（\u3040-\u30ff）/
// 汉字含扩展 A（\u3400-\u4dbf、\u4e00-\u9fff）/ 全角 ASCII 变体（\uff00-\uffef、全角！？，．等）。
// 正常 URL 是纯 ASCII / 百分号编码、不含这些、所以第一个命中处就是 URL 该结束的地方。
const CJK_RE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

export const remarkTrimAutolinkCjk = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const cur = children[i];
      // 先深后处理、嵌套（段落里 strong 里的链接等）也覆盖
      walk(cur);
      if (cur.type !== "link" || !cur.url || !/^https?:\/\//.test(cur.url))
        continue;
      const only = cur.children?.length === 1 ? cur.children[0] : undefined;
      // 裸链接特征：唯一 text 子节点、内容跟 url 一致（autolink 产物）
      if (!only || only.type !== "text" || only.value !== cur.url) continue;
      const m = CJK_RE.exec(cur.url);
      // 没 CJK、或第一个字符就是 CJK（整串都不像正常 URL）→ 不动
      if (!m || m.index === 0) continue;
      const cut = m.index;
      const trailing = cur.url.slice(cut); // 中文及之后、要挪出链接
      cur.url = cur.url.slice(0, cut);
      only.value = cur.url;
      // trailing 并回紧邻的下一个 text 节点开头、否则新插一个 text 节点
      const next = children[i + 1];
      if (next && next.type === "text") {
        next.value = trailing + (next.value ?? "");
      } else {
        children.splice(i + 1, 0, { type: "text", value: trailing });
      }
    }
  };
  walk(tree);
};
