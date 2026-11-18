import { describe, expect, it, vi } from "vitest";

import {
  MAX_MERMAID_BLOCKS,
  findMermaidFences,
  renderMermaidFencesInMarkdown,
} from "@/lib/server/feishu-bridge/mermaid-blocks";

const FLOW = "graph TD\n  A[开始] --> B[结束]";
const fence = (src = FLOW, lang = "mermaid") => `\`\`\`${lang}\n${src}\n\`\`\``;

describe("findMermaidFences：围栏识别", () => {
  it("找到一个已闭合的 mermaid 围栏，返回源码与原文位置", () => {
    const md = `前言\n\n${fence()}\n\n后记`;
    const fs = findMermaidFences(md);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.source).toBe(FLOW);
    expect(fs[0]!.text).toBe(fence());
    expect(md.slice(fs[0]!.start, fs[0]!.end)).toBe(fence());
  });

  it("没有 mermaid 字样 / 空串 → 空", () => {
    expect(findMermaidFences("")).toEqual([]);
    expect(findMermaidFences("```js\nconsole.log(1)\n```")).toEqual([]);
  });

  it("语言名大小写不敏感，信息串带附加词也认；别的语言不认", () => {
    expect(findMermaidFences(fence(FLOW, "Mermaid"))).toHaveLength(1);
    expect(findMermaidFences(fence(FLOW, "MERMAID"))).toHaveLength(1);
    expect(findMermaidFences(fence(FLOW, "mermaid title=\"x\""))).toHaveLength(1);
    expect(findMermaidFences(fence(FLOW, "mermaidjs"))).toEqual([]);
    expect(findMermaidFences(fence(FLOW, "text"))).toEqual([]);
  });

  it("波浪线围栏、更长的围栏、缩进（≤3 格）都认", () => {
    expect(findMermaidFences(`~~~mermaid\n${FLOW}\n~~~`)).toHaveLength(1);
    expect(findMermaidFences(`\`\`\`\`mermaid\n${FLOW}\n\`\`\`\``)).toHaveLength(1);
    const indented = findMermaidFences(`   \`\`\`mermaid\n   graph TD\n     A-->B\n   \`\`\``);
    expect(indented).toHaveLength(1);
    // 开栏缩进 3 格 → 内容行去掉至多 3 格前导空格，更深的缩进保留
    expect(indented[0]!.source).toBe("graph TD\n  A-->B");
  });

  it("缩进 ≥ 4 格是缩进代码块，不算围栏", () => {
    expect(findMermaidFences(`    \`\`\`mermaid\n    ${FLOW}\n    \`\`\``)).toEqual([]);
  });

  it("未闭合的围栏不认（多半是被截断的半截）", () => {
    expect(findMermaidFences(`\`\`\`mermaid\n${FLOW}`)).toEqual([]);
  });

  it("闭栏必须同字符、至少同长度；较短的反引号行属于内容", () => {
    const md = "````mermaid\ngraph TD\n```\nA-->B\n````";
    const fs = findMermaidFences(md);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.source).toBe("graph TD\n```\nA-->B");
    // 波浪线不能闭合反引号围栏
    expect(findMermaidFences("```mermaid\ngraph TD\n~~~\nA-->B\n```")[0]!.source).toBe("graph TD\n~~~\nA-->B");
  });

  it("被更外层围栏包住的 ```mermaid 是在讲源码、不是出图：不认", () => {
    const md = "示例：\n\n````markdown\n```mermaid\ngraph TD\n  A-->B\n```\n````\n";
    expect(findMermaidFences(md)).toEqual([]);
  });

  it("其它语言围栏之后的 mermaid 围栏照常识别（状态不串）", () => {
    const md = `\`\`\`js\nconst a = 1;\n\`\`\`\n\n${fence()}`;
    expect(findMermaidFences(md)).toHaveLength(1);
  });

  it("反引号围栏的信息串里有反引号 = 行内代码，不是围栏", () => {
    expect(findMermaidFences("```mermaid`x` y\ngraph TD\n```")).toEqual([]);
  });

  it("CRLF 换行：源码里不带 \\r，位置仍然对得上", () => {
    const md = `前言\r\n\`\`\`mermaid\r\ngraph TD\r\n  A-->B\r\n\`\`\`\r\n后记`;
    const fs = findMermaidFences(md);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.source).toBe("graph TD\n  A-->B");
    expect(md.slice(fs[0]!.start, fs[0]!.end).startsWith("```mermaid")).toBe(true);
    expect(md.slice(fs[0]!.start, fs[0]!.end).endsWith("```")).toBe(true);
  });

  it("多个围栏按出现顺序返回", () => {
    const md = `${fence("graph TD\nA-->B")}\n\n文字\n\n${fence("graph TD\nC-->D")}`;
    expect(findMermaidFences(md).map((f) => f.source)).toEqual(["graph TD\nA-->B", "graph TD\nC-->D"]);
  });
});

const okDeps = () => {
  let n = 0;
  return {
    renderPng: vi.fn(async () => Buffer.from("png")),
    uploadPng: vi.fn(async () => `img_key_${++n}`),
  };
};

describe("renderMermaidFencesInMarkdown：图 + 原围栏", () => {
  it("成功：图在上、原围栏在下；其余正文一字不动", async () => {
    const md = `前言\n\n${fence()}\n\n后记`;
    const deps = okDeps();
    const r = await renderMermaidFencesInMarkdown(md, deps);
    expect(r.rendered).toBe(1);
    expect(r.kept).toBe(0);
    expect(r.markdown).toBe(`前言\n\n![Mermaid 图](img_key_1)\n\n${fence()}\n\n后记`);
    expect(deps.renderPng).toHaveBeenCalledWith(FLOW);
  });

  it("图前面紧挨着文字（没有空行）→ 补空行，避免图被并进上一段", async () => {
    const r = await renderMermaidFencesInMarkdown(`看图：\n${fence()}`, okDeps());
    expect(r.markdown).toBe(`看图：\n\n![Mermaid 图](img_key_1)\n\n${fence()}`);
    const r2 = await renderMermaidFencesInMarkdown(`看图：${"\n"}${"\n"}${fence()}`, okDeps());
    expect(r2.markdown.startsWith("看图：\n\n![Mermaid 图]")).toBe(true);
  });

  it("正文开头就是围栏：不多补空行", async () => {
    const r = await renderMermaidFencesInMarkdown(fence(), okDeps());
    expect(r.markdown.startsWith("![Mermaid 图](img_key_1)\n\n```mermaid")).toBe(true);
  });

  it("没有 mermaid 围栏：原样返回、不调用渲染", async () => {
    const deps = okDeps();
    const md = "普通文字 mermaid 只是个词\n\n```js\nx\n```";
    const r = await renderMermaidFencesInMarkdown(md, deps);
    expect(r).toEqual({ markdown: md, rendered: 0, kept: 0, failures: [] });
    expect(deps.renderPng).not.toHaveBeenCalled();
  });

  it("渲染失败：该块原样保留，其它块照常出图", async () => {
    const deps = okDeps();
    deps.renderPng.mockImplementationOnce(async () => {
      throw new Error("Parse error on line 3");
    });
    const md = `${fence("graph TD\nbad")}\n\n${fence("graph TD\nA-->B")}`;
    const r = await renderMermaidFencesInMarkdown(md, deps);
    expect(r.rendered).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.failures[0]).toContain("Parse error");
    // 第一块原样、第二块变「图 + 围栏」
    expect(r.markdown.startsWith(fence("graph TD\nbad"))).toBe(true);
    expect(r.markdown).toContain(`![Mermaid 图](img_key_1)\n\n${fence("graph TD\nA-->B")}`);
  });

  it("上传失败：该块原样保留（不留半截图片语法）", async () => {
    const deps = okDeps();
    deps.uploadPng.mockRejectedValueOnce(new Error("upload fail"));
    const r = await renderMermaidFencesInMarkdown(fence(), deps);
    expect(r.markdown).toBe(fence());
    expect(r.rendered).toBe(0);
    expect(r.kept).toBe(1);
    expect(r.markdown).not.toContain("![");
  });

  it("安全预扫命中（外部资源引用）：不交给渲染、原样保留", async () => {
    const deps = okDeps();
    const evil = `graph TD\n  A["<img src='https://evil.example/p.png'>"] --> B`;
    const css = `graph TD\n  A-->B\n  classDef x background-image:url(https://evil.example/c.png)`;
    const r = await renderMermaidFencesInMarkdown(`${fence(evil)}\n\n${fence(css)}`, deps);
    expect(deps.renderPng).not.toHaveBeenCalled();
    expect(deps.uploadPng).not.toHaveBeenCalled();
    expect(r.rendered).toBe(0);
    expect(r.kept).toBe(2);
    expect(r.failures.every((f) => f.includes("安全预扫"))).toBe(true);
  });

  it("空围栏（只有空白）：跳过、不渲染", async () => {
    const deps = okDeps();
    const r = await renderMermaidFencesInMarkdown("```mermaid\n   \n```", deps);
    expect(deps.renderPng).not.toHaveBeenCalled();
    expect(r.rendered).toBe(0);
  });

  it(`超过 ${MAX_MERMAID_BLOCKS} 块：多出来的保留成代码块`, async () => {
    const deps = okDeps();
    const md = Array.from({ length: MAX_MERMAID_BLOCKS + 2 }, (_, i) => fence(`graph TD\nN${i}-->M${i}`)).join("\n\n");
    const r = await renderMermaidFencesInMarkdown(md, deps);
    expect(deps.renderPng).toHaveBeenCalledTimes(MAX_MERMAID_BLOCKS);
    expect(r.rendered).toBe(MAX_MERMAID_BLOCKS);
    expect(r.kept).toBe(2);
  });

  it("相同源码只渲染 / 上传一次，两处都换成同一张图", async () => {
    const deps = okDeps();
    const r = await renderMermaidFencesInMarkdown(`${fence()}\n\n中间\n\n${fence()}`, deps);
    expect(deps.renderPng).toHaveBeenCalledTimes(1);
    expect(deps.uploadPng).toHaveBeenCalledTimes(1);
    expect(r.markdown.match(/!\[Mermaid 图\]\(img_key_1\)/g)).toHaveLength(2);
    expect(r.rendered).toBe(2);
  });

  it("同一份失败的源码不重复试", async () => {
    const deps = okDeps();
    deps.renderPng.mockRejectedValue(new Error("boom"));
    await renderMermaidFencesInMarkdown(`${fence()}\n\n${fence()}`, deps);
    expect(deps.renderPng).toHaveBeenCalledTimes(1);
  });

  it("shouldStop 为真：后面的块不再处理（总时间用尽）", async () => {
    const deps = okDeps();
    let calls = 0;
    const r = await renderMermaidFencesInMarkdown(`${fence("graph TD\nA-->B")}\n\n${fence("graph TD\nC-->D")}`, {
      ...deps,
      shouldStop: () => calls++ >= 1,
    });
    expect(deps.renderPng).toHaveBeenCalledTimes(1);
    expect(r.rendered).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.failures).toContain("渲染总时间已用尽");
  });

  it("被外层围栏包住的示例不会被渲染", async () => {
    const deps = okDeps();
    const md = "````markdown\n```mermaid\ngraph TD\nA-->B\n```\n````";
    const r = await renderMermaidFencesInMarkdown(md, deps);
    expect(deps.renderPng).not.toHaveBeenCalled();
    expect(r.markdown).toBe(md);
  });

  it("源码里自带 ![x](y) 之类的 markdown 不影响替换位置", async () => {
    const src = "graph TD\n  A[\"![x](y)\"] --> B";
    const md = `前\n\n${fence(src)}\n\n后`;
    const r = await renderMermaidFencesInMarkdown(md, okDeps());
    expect(r.markdown).toBe(`前\n\n![Mermaid 图](img_key_1)\n\n${fence(src)}\n\n后`);
  });
});
