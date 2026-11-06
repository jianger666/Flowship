/**
 * 预览窗两个新增纯函数：front matter 拆分（markdown 预览顶部「属性」卡）与跨文本节点的查找定位（文档页内查找）
 *
 * 没有 jsdom / 浏览器：Range 的创建与 CSS Custom Highlight 的绘制不在这里验证，这里只证明「定位算得对」。
 */
import { describe, expect, it } from "vitest";

import { splitFrontMatter } from "@/lib/preview/front-matter";
import { locateMatches } from "@/lib/preview/text-locate";

describe("splitFrontMatter", () => {
  it("标准 skill 头：取出键值对，正文去掉头部和紧跟的空行", () => {
    const text = "---\nname: demo\ndescription: 做点事\n---\n\n# 标题\n正文";
    const r = splitFrontMatter(text);
    expect(r.entries).toEqual([
      { key: "name", value: "demo" },
      { key: "description", value: "做点事" },
    ]);
    expect(r.body).toBe("# 标题\n正文");
  });

  it("列表 / 多行值拼回上一个键；注释行与空行忽略", () => {
    const text = "---\n# 注释\ntags:\n  - a\n  - b\n\ntitle: x\n---\nbody";
    const r = splitFrontMatter(text);
    expect(r.entries).toEqual([
      { key: "tags", value: "- a\n- b" },
      { key: "title", value: "x" },
    ]);
    expect(r.body).toBe("body");
  });

  it("没有 front matter：原样返回（含「开头就是分隔线」的普通文档）", () => {
    expect(splitFrontMatter("# 标题\n---\nx: 1\n---")).toEqual({ entries: null, body: "# 标题\n---\nx: 1\n---" });
    // 以横线开头但没有收尾 → 不是 front matter，不吞正文
    expect(splitFrontMatter("---\n这是一段话\n没有结束")).toEqual({
      entries: null,
      body: "---\n这是一段话\n没有结束",
    });
  });

  it("横线之间是普通段落（不是 key: value）→ 不当 front matter，正文一个字都不丢", () => {
    const text = "---\n你好，世界\n---\n后面的内容";
    const r = splitFrontMatter(text);
    expect(r.entries).toBeNull();
    expect(r.body).toBe(text);
  });

  it("夹在键值之间出现一句普通话（既不是 key: value 也不是续行）→ 整体不当 front matter，正文一个字不丢", () => {
    const text = "---\nname: a\n随便一句话\nowner: b\n---\nbody";
    const r = splitFrontMatter(text);
    expect(r.entries).toBeNull();
    expect(r.body).toBe(text);
  });

  it("两条横线之间是空的 → 不当 front matter", () => {
    expect(splitFrontMatter("---\n---\nabc").entries).toBeNull();
  });

  it("CRLF 的收尾线也认", () => {
    const r = splitFrontMatter("---\r\nname: a\r\n---\r\nbody");
    expect(r.entries).toEqual([{ key: "name", value: "a" }]);
    expect(r.body).toBe("body");
  });

  it("收尾线在 80 行之外 → 不认（防止把整篇文档当 front matter）", () => {
    const text = `---\n${Array.from({ length: 100 }, (_, i) => `k${i}: v`).join("\n")}\n---\nbody`;
    expect(splitFrontMatter(text).entries).toBeNull();
  });
});

describe("locateMatches", () => {
  it("命中落在单个节点内", () => {
    const r = locateMatches(["hello world", "foo"], "world");
    expect(r.matches).toEqual([{ startNode: 0, startOffset: 6, endNode: 0, endOffset: 11 }]);
  });

  it("命中横跨多个节点（粗体 / 链接把一句话拆开）", () => {
    // "hel" + "lo wo" + "rld" 拼成 "hello world"
    const r = locateMatches(["hel", "lo wo", "rld"], "llo wor");
    expect(r.matches).toEqual([{ startNode: 0, startOffset: 2, endNode: 2, endOffset: 1 }]);
  });

  it("空节点被跳过，下标仍是原数组里的下标", () => {
    const r = locateMatches(["", "ab", "", "cd"], "bc");
    expect(r.matches).toEqual([{ startNode: 1, startOffset: 1, endNode: 3, endOffset: 1 }]);
  });

  it("默认不区分大小写，可切到区分", () => {
    expect(locateMatches(["Foo foo FOO"], "foo").matches).toHaveLength(3);
    expect(locateMatches(["Foo foo FOO"], "foo", true).matches).toHaveLength(1);
  });

  it("查询词里的正则元字符按字面量匹配", () => {
    const r = locateMatches(["a.b a*b (x)"], ".");
    expect(r.matches).toHaveLength(1);
    expect(locateMatches(["a.b a*b (x)"], "(x)").matches).toHaveLength(1);
    expect(locateMatches(["a+b"], "a+b").matches).toHaveLength(1);
  });

  it("空查询 / 没有命中", () => {
    expect(locateMatches(["abc"], "")).toEqual({ matches: [], capped: false });
    expect(locateMatches(["abc"], "zzz")).toEqual({ matches: [], capped: false });
    expect(locateMatches([], "a")).toEqual({ matches: [], capped: false });
  });

  it("命中数超过上限：截断并标记 capped", () => {
    const r = locateMatches(["a".repeat(50)], "a", false, 10);
    expect(r.matches).toHaveLength(10);
    expect(r.capped).toBe(true);
  });

  it("命中不重叠（aaaa 里找 aa 得 2 个）", () => {
    expect(locateMatches(["aaaa"], "aa").matches).toHaveLength(2);
  });

  it("中文与 emoji（代理对）按 UTF-16 偏移定位", () => {
    const r = locateMatches(["你好😀", "世界"], "😀世");
    expect(r.matches).toEqual([{ startNode: 0, startOffset: 2, endNode: 1, endOffset: 1 }]);
  });
});
