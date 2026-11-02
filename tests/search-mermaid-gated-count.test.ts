/**
 * 被 mermaid 预扫闸退回成普通代码块的围栏，搜索模型要计数（R8-7）
 *
 * DOM 侧：正常 mermaid 围栏渲染成图、整块忽略（`[data-streamdown="mermaid-block"]`）；但含外部资源引用的围栏被
 * `mermaid-rehype-gate` 改成 `language-text` 普通代码块，源码就是一段可见正文、DOM 搜索会计数。
 * 模型侧（`markdown-visible-search`）必须用同一个判定 `scanMermaidSource` 对齐，否则命中序号整体错位。
 */
import { describe, expect, it } from "vitest";

import { markdownToSearchableFields } from "@/lib/markdown-visible-search";
import { scanMermaidSource } from "@/lib/mermaid-source-gate";

const fieldsText = (md: string): string[] =>
  markdownToSearchableFields(md, "a", "body").map((f) => f.text);

const SAFE = "graph TD; foo-->bar";
const BLOCKED = "graph TD; A[\"<img src='https://x/p?d=1'>\"] foo-->bar";

describe("mermaid 围栏：被预扫闸命中的计数、正常渲染成图的不计", () => {
  it("前置：两个样本在预扫里的判定与用例意图一致", () => {
    expect(scanMermaidSource(SAFE).blocked).toBe(false);
    expect(scanMermaidSource(BLOCKED).blocked).toBe(true);
  });

  it("正常 mermaid 围栏不计（回归 D3-02）", () => {
    expect(fieldsText("```mermaid\n" + SAFE + "\n```")).toEqual([]);
  });

  it("被闸命中的 mermaid 围栏按普通代码块计数（源码是 DOM 里的可见正文）", () => {
    expect(fieldsText("```mermaid\n" + BLOCKED + "\n```")).toEqual([BLOCKED]);
  });

  it("语言标签大小写不敏感；同一文档里混排时顺序与数量都对得上 DOM", () => {
    const md = [
      "```Mermaid\n" + BLOCKED + "\n```",
      "```mermaid\n" + SAFE + "\n```",
      "```ts\nconst foo = 1\n```",
    ].join("\n\n");
    expect(fieldsText(md)).toEqual([BLOCKED, "const foo = 1"]);
  });

  it("超长源码被闸挡（too-long）同样计数", () => {
    const long = "A-->B\n".repeat(40_000); // > 200,000 字符
    expect(scanMermaidSource(long).blocked).toBe(true);
    const texts = fieldsText("```mermaid\n" + long + "\n```");
    expect(texts).toHaveLength(1);
    expect(texts[0].length).toBeGreaterThan(200_000);
    expect(texts[0].startsWith("A-->B\nA-->B")).toBe(true);
  });
});
