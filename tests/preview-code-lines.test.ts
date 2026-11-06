/**
 * 代码查看器的按行数据层：token 摊平 / 行内搜索 / 命中切段 / 日志级别
 */
import { describe, expect, it } from "vitest";

import { findMatches, markSegments, splitLines, tokenizeToLines, type Segment } from "@/lib/preview/code-lines";
import { classifyLogLines, detectLogLevel } from "@/lib/preview/log-level";
import { grammarForExt } from "@/lib/preview/prism-grammars";

const plain = (lines: Segment[][]): string[] => lines.map((l) => l.map((s) => s.text).join(""));

describe("grammarForExt", () => {
  it("常见扩展名都有语法；未知 / 纯文本没有", () => {
    for (const ext of ["ts", "tsx", "js", "py", "json", "yaml", "yml", "css", "scss", "sh", "md", "go", "rs", "java", "kt", "php", "cpp", "cs", "sql", "toml", "xml", "svg", "dockerfile", "makefile", "env", "diff"]) {
      expect(grammarForExt(ext), ext).not.toBeNull();
    }
    expect(grammarForExt("txt")).toBeNull();
    expect(grammarForExt("log")).toBeNull();
    expect(grammarForExt("csv")).toBeNull();
    expect(grammarForExt("")).toBeNull();
    expect(grammarForExt(".TS")?.id).toBe("typescript");
  });
});

describe("tokenizeToLines", () => {
  it("逐行还原：拼起来等于原文，行数 = splitLines 行数（含末尾空行）", () => {
    const src = "const a = 1;\n/* multi\nline */\nlet s = `x\ny`;\n";
    const g = grammarForExt("ts")!.grammar;
    const lines = tokenizeToLines(src, g);
    expect(plain(lines)).toEqual(src.split("\n"));
    expect(lines.length).toBe(splitLines(src).length);
  });

  it("跨行 token（多行注释）每一行都带着注释类型", () => {
    const g = grammarForExt("ts")!.grammar;
    const lines = tokenizeToLines("x\n/* a\nb */\ny", g);
    expect(lines[1]!.every((s) => s.type?.includes("comment"))).toBe(true);
    expect(lines[2]!.some((s) => s.type?.includes("comment"))).toBe(true);
  });

  it("关键字 / 字符串被标出类型", () => {
    const lines = tokenizeToLines('const s = "hi";', grammarForExt("ts")!.grammar);
    const types = Object.fromEntries(lines[0]!.map((s) => [s.text, s.type]));
    expect(types["const"]).toContain("keyword");
    expect(types['"hi"']).toContain("string");
  });

  it("没有 grammar：每行一个无类型段；CRLF / CR 都按换行处理且不残留 \\r", () => {
    const lines = tokenizeToLines("a\r\nb\rc", null);
    expect(plain(lines)).toEqual(["a", "b", "c"]);
    expect(lines.every((l) => l.every((s) => !s.text.includes("\r")))).toBe(true);
  });

  it("空串 → 一行空行", () => {
    expect(tokenizeToLines("", null)).toEqual([[{ text: "" }]]);
    expect(tokenizeToLines("", grammarForExt("ts")!.grammar)).toEqual([[]]);
  });

  it("文本里的 HTML 不会被当成标签（输出的是纯文本段，渲染层走 React 文本节点）", () => {
    const lines = tokenizeToLines("<script>alert(1)</script>", grammarForExt("html")!.grammar);
    expect(plain(lines)).toEqual(["<script>alert(1)</script>"]);
  });
});

describe("findMatches", () => {
  const lines = ["Foo foo FOO", "nothing", "foofoo"];

  it("不区分大小写：所有命中（含同一行多处、不重叠）", () => {
    const { matches } = findMatches(lines, "foo", false);
    expect(matches).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 4, end: 7 },
      { line: 0, start: 8, end: 11 },
      { line: 2, start: 0, end: 3 },
      { line: 2, start: 3, end: 6 },
    ]);
  });

  it("不区分大小写时，查询词本身的大小写也不影响（输入 FOO 也能搜到 foo / Foo）", () => {
    expect(findMatches(["foo Foo FOO"], "FOO", false).matches).toHaveLength(3);
    expect(findMatches(["foo Foo FOO"], "fOo", false).matches).toHaveLength(3);
  });

  it("区分大小写", () => {
    expect(findMatches(lines, "foo", true).matches).toHaveLength(3);
    expect(findMatches(lines, "Foo", true).matches).toEqual([{ line: 0, start: 0, end: 3 }]);
  });

  it("空查询无命中；命中数封顶并标记 capped", () => {
    expect(findMatches(lines, "", false).matches).toEqual([]);
    const r = findMatches(["aaaaaaaa"], "a", false, 3);
    expect(r.matches).toHaveLength(3);
    expect(r.capped).toBe(true);
  });

  it("小写后长度会变的字符（İ → i̇）不让命中偏移错位：偏移必须落在原文范围内且指向命中处", () => {
    const line = "İx";
    expect("İ".toLowerCase().length).toBeGreaterThan(1); // 前提：这个字符确实会变长
    const { matches } = findMatches([line], "x", false);
    expect(matches).toEqual([{ line: 0, start: 1, end: 2 }]);
    expect(line.slice(matches[0]!.start, matches[0]!.end)).toBe("x");
  });

  it("查询里的正则元字符按字面量处理", () => {
    expect(findMatches(["a.b", "axb"], ".", false).matches).toEqual([{ line: 0, start: 1, end: 2 }]);
    expect(findMatches(["(x)"], "(", false).matches).toHaveLength(1);
  });
});

describe("markSegments", () => {
  const segs: Segment[] = [
    { text: "const ", type: "keyword" },
    { text: "name", type: undefined },
    { text: " = ", type: "operator" },
    { text: '"abc"', type: "string" },
  ];
  const text = (m: ReturnType<typeof markSegments>) => m.map((s) => s.text).join("");

  it("没有命中：原样返回（拷贝）", () => {
    expect(markSegments(segs, [])).toEqual(segs);
  });

  it("命中落在单个段里：该段被切成 前 / 命中 / 后，类型保留", () => {
    const out = markSegments(segs, [{ start: 1, end: 3, active: false }]);
    expect(text(out)).toBe('const name = "abc"');
    expect(out.slice(0, 3)).toEqual([
      { text: "c", type: "keyword" },
      { text: "on", type: "keyword", mark: "hit" },
      { text: "st ", type: "keyword" },
    ]);
  });

  it("命中跨多个段：每段各自带 mark，类型各自保留", () => {
    // 覆盖 "st name =" 横跨 keyword / 无类型 / operator
    const out = markSegments(segs, [{ start: 3, end: 13, active: true }]);
    expect(text(out)).toBe('const name = "abc"');
    const marked = out.filter((s) => s.mark);
    expect(marked.map((s) => s.text).join("")).toBe("st name = ");
    expect(marked.every((s) => s.mark === "active")).toBe(true);
    expect(marked.map((s) => s.type)).toEqual(["keyword", undefined, "operator"]);
  });

  it("多个命中、命中恰好贴着段边界", () => {
    const out = markSegments(segs, [
      { start: 0, end: 6, active: false },
      { start: 6, end: 10, active: true },
      { start: 13, end: 18, active: false },
    ]);
    expect(text(out)).toBe('const name = "abc"');
    expect(out.filter((s) => s.mark).map((s) => [s.text, s.mark])).toEqual([
      ["const ", "hit"],
      ["name", "active"],
      ['"abc"', "hit"],
    ]);
  });

  it("命中在行尾 / 行首：不产生空文本段", () => {
    const out = markSegments(segs, [{ start: 0, end: 1, active: false }, { start: 17, end: 18, active: false }]);
    expect(out.every((s) => s.text.length > 0)).toBe(true);
    expect(text(out)).toBe('const name = "abc"');
  });

  it("与 findMatches 联用：把命中切进 token 段后，拼回的文本不变", () => {
    const src = "foo(bar) // foo";
    const lines = tokenizeToLines(src, grammarForExt("ts")!.grammar);
    const { matches } = findMatches(splitLines(src), "foo", false);
    const out = markSegments(lines[0]!, matches.map((m) => ({ start: m.start, end: m.end, active: false })));
    expect(out.map((s) => s.text).join("")).toBe(src);
    expect(out.filter((s) => s.mark)).toHaveLength(2);
  });
});

describe("日志级别", () => {
  it("常见格式：大写级别词 / 方括号 / level= / JSON", () => {
    expect(detectLogLevel("2026-11-06 15:00:00 ERROR something broke")).toBe("error");
    expect(detectLogLevel("2026-11-06T15:00:00Z [WARN] disk 90%")).toBe("warn");
    expect(detectLogLevel("INFO: started")).toBe("info");
    expect(detectLogLevel("10:00 DEBUG cache miss")).toBe("debug");
    expect(detectLogLevel('{"level":"error","msg":"x"}')).toBe("error");
    expect(detectLogLevel("time=1 level=warning msg=x")).toBe("warn");
    expect(detectLogLevel("[error] nginx: upstream")).toBe("error");
    expect(detectLogLevel("FATAL: out of memory")).toBe("error");
  });

  it("普通句子里的小写 error / warn 不算（避免「no error found」标红）", () => {
    expect(detectLogLevel("INFO no error found")).toBe("info");
    expect(detectLogLevel("the error handler was registered")).toBeNull();
    expect(detectLogLevel("terror WARNING_LEVEL_X")).toBeNull();
    expect(detectLogLevel("")).toBeNull();
  });

  it("只看行首：长行末尾 payload 里的 ERROR 不影响这一行", () => {
    const line = `INFO ${"x".repeat(300)} ERROR`;
    expect(detectLogLevel(line)).toBe("info");
    expect(detectLogLevel(`${"x".repeat(300)} ERROR`)).toBeNull();
  });

  it("堆栈续行继承上一条有级别的行；无级别的普通行不继承", () => {
    const lines = [
      "INFO ok",
      "ERROR boom",
      "    at foo (a.js:1)",
      "    at bar (b.js:2)",
      "Caused by: x",
      "plain message line",
      "    at orphan (c.js:3)",
    ];
    // 注意：最后一行的堆栈帧仍继承 last（=error），因为中间普通行不清掉 last——真实堆栈常夹空行
    expect(classifyLogLines(lines)).toEqual(["info", "error", "error", "error", "error", null, "error"]);
  });

  it("文件开头就是堆栈帧（没有上文）：没有级别", () => {
    expect(classifyLogLines(["    at x (a.js:1)"])).toEqual([null]);
  });
});
