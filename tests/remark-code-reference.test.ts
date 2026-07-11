import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";

import { remarkCodeReference } from "../src/lib/remark-code-reference";

// 自描述最小 mdast 节点（跟插件里一致）
interface Node {
  type: string;
  lang?: string | null;
  meta?: string | null;
  value?: string;
  children?: Node[];
}

const run = (md: string): Node => {
  const processor = unified().use(remarkParse).use(remarkCodeReference);
  return processor.runSync(processor.parse(md)) as unknown as Node;
};

const collect = (node: Node, type: string, acc: Node[] = []): Node[] => {
  if (node.type === type) acc.push(node);
  node.children?.forEach((c) => collect(c, type, acc));
  return acc;
};

describe("remarkCodeReference", () => {
  it("代码引用围栏：lang 重写为后缀语言 + 前插出处行", () => {
    const tree = run(
      "看这段：\n\n```12:34:src/pages/foo/bar.tsx\nconst a = 1;\n```\n",
    );
    const codes = collect(tree, "code");
    expect(codes).toHaveLength(1);
    expect(codes[0].lang).toBe("tsx");
    // 出处行是 inlineCode、内容带路径 + 行号
    const inlines = collect(tree, "inlineCode");
    expect(inlines).toHaveLength(1);
    expect(inlines[0].value).toBe("src/pages/foo/bar.tsx · L12-34");
  });

  it("路径带空格（info 被 mdast 切成 lang+meta）也能整体识别", () => {
    const tree = run("```1:2:src/my dir/file.py\nx = 1\n```\n");
    const codes = collect(tree, "code");
    expect(codes[0].lang).toBe("python");
    const inlines = collect(tree, "inlineCode");
    expect(inlines[0].value).toBe("src/my dir/file.py · L1-2");
  });

  it("未知后缀降级 text、不认识的 info 串不动", () => {
    const tree = run(
      "```3:4:Makefile.custom.xyz\nall:\n```\n\n```ts\nconst b = 2;\n```\n",
    );
    const codes = collect(tree, "code");
    expect(codes[0].lang).toBe("text");
    // 正常语言围栏原样保留
    expect(codes[1].lang).toBe("ts");
    // 正常围栏不产生出处行
    const inlines = collect(tree, "inlineCode");
    expect(inlines).toHaveLength(1);
  });

  it("多个引用围栏各自处理、互不吞并", () => {
    const tree = run(
      "```1:2:a/b.ts\nx\n```\n\n中间文字\n\n```5:9:c/d.go\ny\n```\n",
    );
    const codes = collect(tree, "code");
    expect(codes.map((c) => c.lang)).toEqual(["ts", "go"]);
    const inlines = collect(tree, "inlineCode");
    expect(inlines.map((i) => i.value)).toEqual([
      "a/b.ts · L1-2",
      "c/d.go · L5-9",
    ]);
  });
});
