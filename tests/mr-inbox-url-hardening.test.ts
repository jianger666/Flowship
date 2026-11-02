/**
 * MR 链接提取 / canonicalUrl 的两处加固：
 *  - 评论里大量重复的 `http://`（无空白、无 /-/merge_requests/）曾让提取正则逐起点扫到串尾，二次方耗时；
 *  - host 大小写不同的同一条 MR（`GitLab.Example.com` vs `gitlab.example.com`）曾得到不同 canonicalUrl，去重 / 已读 / 忽略 key 对不上。
 */
import { describe, expect, it } from "vitest";

import { extractMrUrlsFromText, parseGitlabMrUrl } from "@/lib/mr-inbox";

describe("extractMrUrlsFromText 最坏输入不二次方", () => {
  it("20 万码元的重复 http://（无空白、无 MR 路径）在 1 秒内返回空", () => {
    const text = "http://".repeat(30_000);
    const t0 = performance.now();
    expect(extractMrUrlsFromText(text)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("MR 路径在串首、后面跟大量 http://：同样不二次方", () => {
    const text = "x /-/merge_requests/1 " + "http://".repeat(30_000);
    const t0 = performance.now();
    extractMrUrlsFromText(text);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("正常 MR 链接（含较长项目路径）仍能提取", () => {
    const long = "g/" + "sub/".repeat(40) + "repo";
    const url = `https://gitlab.example.com/${long}/-/merge_requests/123`;
    expect(extractMrUrlsFromText(`看 ${url} 这个`)).toEqual([url]);
  });
});

describe("parseGitlabMrUrl.canonicalUrl 归一 host 大小写", () => {
  it("host 大小写不同的同一条 MR：canonicalUrl 相同（host 小写）", () => {
    const a = parseGitlabMrUrl("https://GitLab.Example.com/g/r/-/merge_requests/7");
    const b = parseGitlabMrUrl("https://gitlab.example.com/g/r/-/merge_requests/7");
    expect(a?.canonicalUrl).toBe("https://gitlab.example.com/g/r/-/merge_requests/7");
    expect(a?.canonicalUrl).toBe(b?.canonicalUrl);
  });

  it("projectPath 大小写保持（路径大小写敏感，不能动）", () => {
    const a = parseGitlabMrUrl("https://gitlab.example.com/Group/Repo/-/merge_requests/7");
    expect(a?.canonicalUrl).toBe("https://gitlab.example.com/Group/Repo/-/merge_requests/7");
  });

  it("提取时 host 大小写不同的重复链接只留一条", () => {
    const text =
      "https://GitLab.Example.com/g/r/-/merge_requests/7 和 https://gitlab.example.com/g/r/-/merge_requests/7";
    expect(extractMrUrlsFromText(text)).toEqual([
      "https://gitlab.example.com/g/r/-/merge_requests/7",
    ]);
  });
});
