/**
 * markdown 裸链接解析回归（V0.7.13）
 *
 * 用户实测 bug：AI 输出裸 URL `…ft_`（结尾下划线）、GFM autolink 把尾部 `_`
 * 当标点剥掉、点开的链接少一个字符 404。
 * 修法见 src/lib/remark-keep-trailing-underscore.ts、这里锁行为。
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";

const parseLinks = (md: string, withFix: boolean): { url: string; text: string }[] => {
  const proc = unified().use(remarkParse).use(remarkGfm);
  if (withFix) proc.use(remarkKeepTrailingUnderscore);
  const tree = proc.runSync(proc.parse(md)) as unknown as Node1;
  const links: { url: string; text: string }[] = [];
  interface Node1 {
    type?: string;
    url?: string;
    value?: string;
    children?: Node1[];
  }
  const walk = (n: Node1) => {
    if (n.type === "link") {
      links.push({
        url: n.url ?? "",
        text: (n.children ?? []).map((c) => c.value ?? "").join(""),
      });
    }
    (n.children ?? []).forEach(walk);
  };
  walk(tree);
  return links;
};

describe("GFM autolink 尾部下划线", () => {
  const md = "手机版: https://mcp.edgeone.site/share/7AU-C_Jj45W6OrXBR-ft_";

  it("原生 GFM 会剥掉尾部 _（bug 复现基线）", () => {
    const links = parseLinks(md, false);
    expect(links).toHaveLength(1);
    // 上游行为：尾部 _ 被当标点剥离（如果上游修了、这条假设变了要重新评估插件）
    expect(links[0].url.endsWith("_")).toBe(false);
  });

  it("挂插件后尾部 _ 保留进 url 和文本", () => {
    const links = parseLinks(md, true);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(
      "https://mcp.edgeone.site/share/7AU-C_Jj45W6OrXBR-ft_",
    );
    expect(links[0].text.endsWith("ft_")).toBe(true);
  });

  it("正常结尾的链接不受影响", () => {
    const links = parseLinks("看 https://example.com/a_b/c 这个", true);
    expect(links[0].url).toBe("https://example.com/a_b/c");
  });

  it("显式 markdown 链接（带尾 _ 的 href）原样保留", () => {
    const links = parseLinks("[x](https://e.com/a_)", true);
    expect(links[0].url).toBe("https://e.com/a_");
  });
});
