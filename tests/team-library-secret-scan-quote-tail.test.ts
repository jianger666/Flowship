/**
 * 团队库密钥扫描：URL 首个查询参数被切出来以后，「落单的闭合引号 / 括号」不能让占位符判断失效（F2-03 的误报侧）
 *
 * 背景：F2-03 让 `?` 与 `&` 一样切段，`https://x/p?api_key=$KEY` 里的 `api_key` 现在会被当成独立键值对。
 * 但无引号取值的字符类只排除空白 / `,;}&?`，**会把包住 URL 的闭合引号 / 右括号一起吞进值里**：
 *   curl "https://x/p?api_key=$API_KEY"   → 值是 `$API_KEY"`
 *   [文档](https://x/p?token=$TOKEN)       → 值是 `$TOKEN)`
 * `isPlaceholderSecretValue` 只剥「成对」引号，`$API_KEY"` 认不出是环境变量引用，于是文档 / 脚本里最常见的
 * 「带占位符的示例 URL」在 F2-03 之后新增了误报（此前 `https:` 把整段吞掉，反而不报）。
 * `curl -H "api_key=$API_KEY"` / `…?a=1&token=$TOKEN"` 在 F2-03 之前就有同类误报，一并收掉。
 *
 * 只对**占位符判断**去掉尾部包裹字符；真实口令照报，且脱敏片段不变。
 * 所有口令都是无害的合成值。
 */
import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "@/lib/server/team-library-secret-scan";

const scan = (content: string) =>
  scanSensitiveFiles([{ path: "skills/fe/demo/README.md", content }]);
const snippets = (content: string): string[] => scan(content).map((h) => h.snippet);

/** 无害的合成口令（16 位字母 + 数字、不含任何占位词） */
const PW = "Zx9fQ2mK7pLw1234";

describe("示例 URL 里的占位符 + 落单的闭合引号 / 括号：不报", () => {
  it.each([
    ["双引号包住的环境变量", 'curl "https://x.example.com/y?api_key=$API_KEY"'],
    ["单引号包住的环境变量", "curl 'https://x.example.com/y?token=$TOKEN'"],
    ["markdown 链接右括号", "[文档](https://x.example.com/y?token=$TOKEN)"],
    ["尖括号占位符", 'curl "https://x.example.com/y?api_key=<your-key>"'],
    ["xxx 占位符", 'curl "https://x.example.com/y?api_key=xxx"'],
    ["your- 前缀占位符", 'curl "https://x.example.com/y?api_key=your-api-key"'],
    ["第二个参数（`&` 之后，F2-03 之前就有）", 'curl "https://x.example.com/y?a=1&token=$TOKEN"'],
    ["header 形态（F2-03 之前就有）", 'curl -H "api_key=$API_KEY" https://x.example.com'],
    ["引号 + 右括号叠在一起", 'run("https://x.example.com/y?api_key=$API_KEY")'],
    ["对照：花括号写法本来就不报", 'curl "https://x.example.com/y?api_key=${API_KEY}"'],
    ["对照：无引号环境变量本来就不报", "curl https://x.example.com/y?token=$TOKEN"],
  ])("%s", (_name, content) => {
    expect(snippets(content)).toEqual([]);
  });
});

describe("真实口令 + 同样的包裹字符：照报，脱敏片段不变", () => {
  it.each([
    ["双引号包住", `curl "https://x.example.com/y?api_key=${PW}"`, ["api_key=Zx9***"]],
    ["单引号包住", `curl 'https://x.example.com/y?token=${PW}'`, ["token=Zx9***"]],
    ["markdown 链接右括号", `[文档](https://x.example.com/y?token=${PW})`, ["token=Zx9***"]],
    ["引号 + 右括号叠在一起", `run("https://x.example.com/y?api_key=${PW}")`, ["api_key=Zx9***"]],
    [
      "一个 URL 里真实参数在前、占位符在后：只报真实的那个",
      `curl "https://x.example.com/y?token=${PW}&api_key=$API_KEY"`,
      ["token=Zx9***"],
    ],
    [
      "一个 URL 里占位符在前、真实参数在后：只报真实的那个",
      `curl "https://x.example.com/y?api_key=$API_KEY&token=${PW}"`,
      ["token=Zx9***"],
    ],
  ])("%s", (_name, content, expected) => {
    expect(snippets(content)).toEqual(expected);
  });

  it("口令本身含引号（中间的不剥）：整体不是占位符，照报", () => {
    // 只剥尾部那一串包裹字符，值中间的引号不动；`ab"cd` 不是占位符
    expect(snippets(`password=Zx9f"Q2mK7pLw1234`).length).toBe(1);
  });
});

describe("线性复杂度：尾部包裹字符的剥离不能引入二次方", () => {
  it("20 万个右括号 / 引号紧跟在占位符之后", () => {
    const t0 = Date.now();
    const a = scan(`curl x?token=$TOKEN${")".repeat(200_000)}`);
    const b = scan(`curl x?token=$TOKEN${"'".repeat(200_000)}`);
    const c = scan(`curl x?token=a${")\"".repeat(100_000)}b`);
    const elapsed = Date.now() - t0;
    // 只要不是二次方：20 万字符的量级下实测几十毫秒，给负载很高的机器留足余量
    expect(elapsed).toBeLessThan(5000);
    // 结果本身不做强断言（超长病态输入的命中与否不是本用例要钉的），只要求能正常返回数组
    expect(Array.isArray(a) && Array.isArray(b) && Array.isArray(c)).toBe(true);
  });
});
