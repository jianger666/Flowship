import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

import { remarkTrimAutolinkCjk } from "../src/lib/remark-trim-autolink-cjk";

// 自描述最小 mdast 节点（跟插件里一致、不引 @types/mdast 省得 cast 满天飞）
interface Node {
  type: string;
  url?: string;
  value?: string;
  children?: Node[];
}

// 跑完整 remark 管线：parse → gfm（生成 autolink）→ 本插件、返回处理后的 mdast root
const run = (md: string): Node => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkTrimAutolinkCjk);
  return processor.runSync(processor.parse(md)) as unknown as Node;
};

// 深度收集所有 link 节点
const collectLinks = (node: Node, acc: Node[] = []): Node[] => {
  if (node.type === "link") acc.push(node);
  node.children?.forEach((c) => collectLinks(c, acc));
  return acc;
};

// 深度收集所有 text 节点的拼接值（验证中文被挪回了正文）
const collectText = (node: Node, acc: string[] = []): string[] => {
  if (node.type === "text" && node.value) acc.push(node.value);
  node.children?.forEach((c) => collectText(c, acc));
  return acc;
};

describe("remarkTrimAutolinkCjk", () => {
  it("裸 URL 后紧跟中文句号 + 文字时、把中文切出链接（用户实测 case）", () => {
    const tree = run(
      "crm-web MR 跟 test 有冲突：https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3951。要我智能解决？",
    );
    const links = collectLinks(tree);
    expect(links).toHaveLength(1);
    // URL 截到 3951、不含「。要我智能解决？」
    expect(links[0].url).toBe(
      "https://gitlab.wukongedu.net/frontend/crm-web/-/merge_requests/3951",
    );
    // link 的展示文本也跟 url 一致（autolink 产物特征）
    expect(links[0].children?.[0]?.value).toBe(links[0].url);
    // 被切出的中文回到了正文
    expect(collectText(tree).join("")).toContain("。要我智能解决？");
  });

  it("纯 ASCII URL（含 query）不动", () => {
    const tree = run("见 https://example.com/a/b?x=1&y=2 谢谢");
    const links = collectLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/a/b?x=1&y=2");
  });

  it("显式 [文本](url) 链接不受影响（非 autolink）", () => {
    const tree = run("[看这里](https://example.com/x)后续中文");
    const links = collectLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/x");
  });

  it("全角标点（！）也算 URL 边界", () => {
    const tree = run("链接 https://example.com/p！后面");
    const links = collectLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/p");
  });
});
