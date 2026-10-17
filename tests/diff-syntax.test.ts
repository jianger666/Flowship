import { describe, expect, it } from "vitest";
import { code as shikiCode, type HighlightOptions } from "@streamdown/code";

import {
  assembleDiffLineTokens,
  buildDiffSegments,
  DIFF_SYNTAX_MAX_CHARS,
  DIFF_SYNTAX_MAX_LINES,
  diffLanguageFromPath,
  normalizeHighlightResult,
  normalizeUpstreamResult,
  shouldHighlightDiff,
  toUpstreamCode,
  type DiffSyntaxToken,
  type RawHighlightToken,
} from "@/lib/diff-syntax";
import { parseUnifiedDiff, type DiffViewLine } from "@/lib/tool-display";

const L = (kind: DiffViewLine["kind"], text = ""): DiffViewLine => ({
  kind,
  text,
});

describe("diffLanguageFromPath", () => {
  it("按扩展名映射到 Shiki 语言 id（复用 extToShikiLang）", () => {
    expect(diffLanguageFromPath("src/a/b.ts")).toBe("typescript");
    expect(diffLanguageFromPath("/abs/Foo.TSX")).toBe("tsx");
    expect(diffLanguageFromPath("x.py")).toBe("python");
    expect(diffLanguageFromPath("ci.yml")).toBe("yaml");
    expect(diffLanguageFromPath("a/b/c.go")).toBe("go");
  });

  it("没扩展名取文件名（Dockerfile）；Windows 路径分隔符也认", () => {
    expect(diffLanguageFromPath("deploy/Dockerfile")).toBe("dockerfile");
    expect(diffLanguageFromPath("C:\\work\\repo\\main.rs")).toBe("rs");
  });

  it("空路径 / 空值 → null", () => {
    expect(diffLanguageFromPath(null)).toBeNull();
    expect(diffLanguageFromPath(undefined)).toBeNull();
    expect(diffLanguageFromPath("")).toBeNull();
    expect(diffLanguageFromPath("dir/")).toBeNull();
  });
});

describe("shouldHighlightDiff", () => {
  it("空 diff 不上色；正常大小上色", () => {
    expect(shouldHighlightDiff([])).toBe(false);
    expect(shouldHighlightDiff([L("add", "const a = 1;")])).toBe(true);
  });

  it("超过行数上限 / 字符数上限不上色（防分词卡主线程）", () => {
    const many = Array.from({ length: DIFF_SYNTAX_MAX_LINES + 1 }, () =>
      L("add", "x"),
    );
    expect(shouldHighlightDiff(many)).toBe(false);
    expect(
      shouldHighlightDiff([L("add", "x".repeat(DIFF_SYNTAX_MAX_CHARS + 1))]),
    ).toBe(false);
    expect(
      shouldHighlightDiff([L("add", "x".repeat(DIFF_SYNTAX_MAX_CHARS))]),
    ).toBe(true);
  });
});

describe("buildDiffSegments", () => {
  it("一个 hunk：旧侧 = 上下文 + 删除，新侧 = 上下文 + 新增，行号对回 diff 行下标", () => {
    const lines = [
      L("hunk"), // 0
      L("context", "a"), // 1
      L("del", "old"), // 2
      L("add", "new1"), // 3
      L("add", "new2"), // 4
      L("context", "z"), // 5
    ];
    const segs = buildDiffSegments(lines);
    expect(segs).toEqual([
      { side: "old", code: "a\nold\nz", lineIndexes: [1, 2, 5] },
      { side: "new", code: "a\nnew1\nnew2\nz", lineIndexes: [1, 3, 4, 5] },
    ]);
  });

  it("每个 hunk 各自成段、互不串（hunk 分隔处断开）", () => {
    const lines = [
      L("hunk"),
      L("del", "x"),
      L("add", "y"),
      L("hunk"),
      L("context", "c"),
      L("add", "d"),
    ];
    const segs = buildDiffSegments(lines);
    expect(segs.map((s) => [s.side, s.code])).toEqual([
      ["old", "x"],
      ["new", "y"],
      ["new", "c\nd"],
    ]);
  });

  it("没有删除行的 hunk 不出旧侧；只有删除行的 hunk 不出新侧", () => {
    expect(
      buildDiffSegments([L("hunk"), L("context", "a"), L("add", "b")]).map(
        (s) => s.side,
      ),
    ).toEqual(["new"]);
    expect(buildDiffSegments([L("hunk"), L("del", "a"), L("del", "b")])).toEqual(
      [{ side: "old", code: "a\nb", lineIndexes: [1, 2] }],
    );
  });

  it("CRLF 文件：行尾 \\r 不进源码（高亮器的 token 里没有 \\r）", () => {
    const segs = buildDiffSegments([L("add", "a\r"), L("add", "b\r")]);
    expect(segs).toEqual([{ side: "new", code: "a\nb", lineIndexes: [0, 1] }]);
  });

  it("没有 hunk 标记的 diff 也当一个 hunk；空输入无段", () => {
    expect(buildDiffSegments([L("add", "a")]).length).toBe(1);
    expect(buildDiffSegments([])).toEqual([]);
  });

  it("`\\ No newline at end of file` 不当源码：旧 / 新两侧都不收，夹在 del 与 add 之间也不污染", () => {
    const lines = parseUnifiedDiff(
      [
        "@@ -1,2 +1,2 @@",
        " keep", // 1
        "-old", // 2
        "\\ No newline at end of file", // 3
        "+new", // 4
        "\\ No newline at end of file", // 5
      ].join("\n"),
    );
    // 前提：解析器确实把标记行当成「没有行号的 context」
    expect(lines[3]).toEqual({
      kind: "context",
      text: "\\ No newline at end of file",
    });
    expect(buildDiffSegments(lines)).toEqual([
      { side: "old", code: "keep\nold", lineIndexes: [1, 2] },
      { side: "new", code: "keep\nnew", lineIndexes: [1, 4] },
    ]);
  });

  it("标记行的文案被 git 本地化（中文等）也认：只看「反斜杠 + 空格」开头", () => {
    const lines = parseUnifiedDiff(
      ["@@ -1 +1 @@", "-a", "\\ 文件末尾没有换行符", "+b"].join("\n"),
    );
    expect(buildDiffSegments(lines).map((s) => s.code)).toEqual(["a", "b"]);
  });

  it("只有标记行的 hunk 不出段；没有行号的真上下文行（缺 @@ 头的截断 diff）照常收", () => {
    expect(
      buildDiffSegments([L("hunk"), L("context", "\\ No newline at end of file")]),
    ).toEqual([]);
    // 缺 @@ 头：上下文行同样没有行号，但不是标记行，必须仍进源码
    expect(
      buildDiffSegments([L("context", "a"), L("context", "\\foo")]),
    ).toEqual([
      { side: "new", code: "a\n\\foo", lineIndexes: [0, 1] },
    ]);
  });
});

describe("normalizeHighlightResult", () => {
  const tok = (
    content: string,
    extra: Partial<RawHighlightToken> = {},
  ): RawHighlightToken => ({ content, ...extra });

  it("取 htmlStyle 的亮 / 暗色；没有 htmlStyle 退回 color；fontStyle 位掩码转 italic / bold", () => {
    const out = normalizeHighlightResult("ab\n", [
      [
        tok("a", { htmlStyle: { color: "#111", "--shiki-dark": "#eee" } }),
        tok("b", { color: "#222", fontStyle: 3 }),
      ],
      [],
    ]);
    expect(out).toEqual([
      [
        { content: "a", light: "#111", dark: "#eee" },
        { content: "b", light: "#222", italic: true, bold: true },
      ],
      [],
    ]);
  });

  it("文字与源码对不上（上游缓存键撞车拿回别的源码的 token）→ null，不能把别人的文字渲染出来", () => {
    expect(
      normalizeHighlightResult("const name = 1", [[tok("const other = 1")]]),
    ).toBeNull();
  });

  it("行数对不上 → null", () => {
    expect(normalizeHighlightResult("a\nb", [[tok("a")]])).toBeNull();
    expect(
      normalizeHighlightResult("a", [[tok("a")], [tok("b")]]),
    ).toBeNull();
  });
});

describe("toUpstreamCode / normalizeUpstreamResult", () => {
  const tok = (content: string): RawHighlightToken => ({ content });

  it("末尾追加「换行 + 指纹」一行；同源码结果稳定", () => {
    const out = toUpstreamCode("a\nb");
    expect(out.startsWith("a\nb\n")).toBe(true);
    expect(out.split("\n").length).toBe(3);
    expect(toUpstreamCode("a\nb")).toBe(out);
  });

  it("同长度、仅中间不同的两份源码：指纹不同，上游缓存键用到的「总长度 + 末尾 100 字符」也不同", () => {
    const pad = "x".repeat(150);
    const a = `${pad}10${pad}`;
    const b = `${pad}20${pad}`;
    expect(a.length).toBe(b.length);
    const ua = toUpstreamCode(a);
    const ub = toUpstreamCode(b);
    // 上游键 = 总长度 + 前 100 + 后 100：前 100 必同，后 100 里必须带上区分度
    expect(ua.slice(0, 100)).toBe(ub.slice(0, 100));
    expect(ua.slice(-100)).not.toBe(ub.slice(-100));
  });

  it("丢掉指纹行的 token 再核对；文字对不上 / 行数不够 → null", () => {
    expect(
      normalizeUpstreamResult("a\nb", [[tok("a")], [tok("b")], [tok("fp")]]),
    ).toEqual([[{ content: "a" }], [{ content: "b" }]]);
    expect(
      normalizeUpstreamResult("a\nb", [[tok("a")], [tok("X")], [tok("fp")]]),
    ).toBeNull();
    expect(normalizeUpstreamResult("a\nb", [[tok("a")]])).toBeNull();
  });
});

describe("assembleDiffLineTokens", () => {
  const T = (content: string): DiffSyntaxToken[] => [{ content }];

  it("删除行取旧侧；新增 / 上下文行取新侧；hunk 分隔行为 null", () => {
    const lines = [
      L("hunk"),
      L("context", "a"),
      L("del", "old"),
      L("add", "new"),
    ];
    const segs = buildDiffSegments(lines);
    const out = assembleDiffLineTokens(lines, segs, (seg) =>
      seg.side === "old"
        ? [T("OLD-a"), T("OLD-old")]
        : [T("NEW-a"), T("NEW-new")],
    );
    expect(out).toEqual([null, T("NEW-a"), T("OLD-old"), T("NEW-new")]);
  });

  it("`\\ No newline at end of file` 标记行铺回后保持 null（退回无语法色），相邻行的颜色不受影响", () => {
    const lines = parseUnifiedDiff(
      ["@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new"].join("\n"),
    );
    const segs = buildDiffSegments(lines);
    const out = assembleDiffLineTokens(lines, segs, (seg) =>
      seg.side === "old" ? [T("OLD")] : [T("NEW")],
    );
    expect(out).toEqual([null, T("OLD"), null, T("NEW")]);
  });

  it("某段还没出结果（lookup 给 null）→ 该段的行保持 null，别的段不受影响", () => {
    const lines = [L("hunk"), L("add", "a"), L("hunk"), L("add", "b")];
    const segs = buildDiffSegments(lines);
    const out = assembleDiffLineTokens(lines, segs, (seg) =>
      seg.code === "b" ? [T("b")] : null,
    );
    expect(out).toEqual([null, null, null, T("b")]);
  });
});

// 真实高亮器（与聊天代码块同一个 @streamdown/code → Shiki）：
// 钉住「分段 → 高亮 → 规整 → 铺回」整条链路，以及按 hunk 拼源码的意义（多行注释中间的行）
describe("端到端：真实 Shiki", () => {
  const highlight = (src: string, language: string) =>
    new Promise<RawHighlightToken[][]>((resolve) => {
      const req: HighlightOptions = {
        code: src,
        language: language as HighlightOptions["language"],
        themes: ["github-light", "github-dark"],
      };
      const sync = shikiCode.highlight(req, (r) =>
        resolve(r.tokens as unknown as RawHighlightToken[][]),
      );
      if (sync) resolve(sync.tokens as unknown as RawHighlightToken[][]);
    });

  /** 与 use-diff-syntax-tokens 同一条路径：喂「源码 + 指纹行」、结果丢掉指纹行再核对 */
  const highlightSegment = async (code: string, language: string) =>
    normalizeUpstreamResult(
      code,
      await highlight(toUpstreamCode(code), language),
    );

  const run = async (
    diff: string,
    language: string,
    mode: "sequential" | "concurrent" = "sequential",
  ) => {
    const lines = parseUnifiedDiff(diff);
    const segs = buildDiffSegments(lines);
    const cache = new Map<string, DiffSyntaxToken[][] | null>();
    const one = async (seg: (typeof segs)[number]) => {
      cache.set(seg.side + seg.code, await highlightSegment(seg.code, language));
    };
    if (mode === "concurrent") await Promise.all(segs.map(one));
    else for (const seg of segs) await one(seg);
    return {
      lines,
      out: assembleDiffLineTokens(
        lines,
        segs,
        (seg) => cache.get(seg.side + seg.code) ?? null,
      ),
    };
  };

  it("关键字有亮 / 暗两套颜色，渲染文字与原行逐字一致", async () => {
    const { lines, out } = await run(
      [
        "@@ -1,2 +1,2 @@",
        " const keep = 1;",
        "-const a = 1;",
        '+const a = "x";',
      ].join("\n"),
      "typescript",
    );
    // hunk 分隔行没有 token，其余行都应该有
    expect(
      out.every((row, i) => lines[i].kind === "hunk" || row !== null),
    ).toBe(true);
    out.forEach((row, i) => {
      if (lines[i].kind === "hunk") return;
      expect(row!.map((t) => t.content).join("")).toBe(lines[i].text);
    });
    const kwDel = out[lines.findIndex((l) => l.kind === "del")]![0];
    expect(kwDel.content).toBe("const");
    expect(kwDel.light).toMatch(/^#[0-9a-f]{6}$/i);
    expect(kwDel.dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(kwDel.light).not.toBe(kwDel.dark);
  });

  it("多行块注释中间被改的行：新旧两侧都按注释上色（逐行单独高亮会染错）", async () => {
    const { lines, out } = await run(
      [
        "@@ -1,4 +1,4 @@",
        " /*",
        "- * const x = 1;",
        "+ * const y = 2;",
        " */",
      ].join("\n"),
      "typescript",
    );
    const delIdx = lines.findIndex((l) => l.kind === "del");
    const addIdx = lines.findIndex((l) => l.kind === "add");
    const commentColor = out[1]![0].light;
    // 注释内的 `const` 不能被当成关键字：整行同一个颜色
    expect(new Set(out[delIdx]!.map((t) => t.light)).size).toBe(1);
    expect(new Set(out[addIdx]!.map((t) => t.light)).size).toBe(1);
    expect(out[delIdx]![0].light).toBe(commentColor);
    expect(out[addIdx]![0].light).toBe(commentColor);
  });

  // 回归：上游缓存键 = 语言 + 主题 + 总长度 + 首尾各 100 字符。
  // 同长度、改动落在中间、整段 > 200 字符的 hunk，旧 / 新两侧会撞同一个键，
  // 新侧拿到旧侧的 token → 核对不过 → 新增 / 上下文行整行没有语法色，同一块里删除行有色、新增行没有。
  // 每条用例的源码都不同：上游缓存是进程内模块级的，复用同一份源码会互相污染。
  const sameLengthDiff = (tag: string, before: string, after: string) => {
    const ctx = (side: string) =>
      Array.from({ length: 6 }, (_, i) => ` const ${tag}${side}${i} = compute(${i});`);
    return [
      "@@ -1,13 +1,13 @@",
      ...ctx("h"),
      `-const limit = ${before};`,
      `+const limit = ${after};`,
      ...ctx("t"),
    ].join("\n");
  };

  const expectEveryLineColored = (
    lines: DiffViewLine[],
    out: (DiffSyntaxToken[] | null)[],
  ) => {
    out.forEach((row, i) => {
      if (lines[i].kind === "hunk") return;
      expect(row, `第 ${i} 行（${lines[i].kind}）没有语法色`).not.toBeNull();
      expect(row!.map((t) => t.content).join("")).toBe(lines[i].text);
    });
  };

  it("前提（canary）：不加指纹直接喂上游，同长度的新旧两侧确实撞键、至少一侧拿到别人的 token", async () => {
    const lines = parseUnifiedDiff(sameLengthDiff("pre", "10", "20"));
    const segs = buildDiffSegments(lines);
    expect(segs.every((s) => s.code.length > 200)).toBe(true);
    expect(segs[0].code.length).toBe(segs[1].code.length);
    const raws = await Promise.all(segs.map((s) => highlight(s.code, "typescript")));
    const normalized = segs.map((s, i) => normalizeHighlightResult(s.code, raws[i]));
    // 若这条失败 = 上游已修好撞键，toUpstreamCode 可以删了
    expect(normalized.some((n) => n === null)).toBe(true);
  });

  it("同长度改动（10 → 20，hunk > 200 字符）：并发请求，新增行与上下文行都有语法色", async () => {
    const { lines, out } = await run(
      sameLengthDiff("par", "10", "20"),
      "typescript",
      "concurrent",
    );
    expectEveryLineColored(lines, out);
  });

  it("同长度改动：顺序请求（第二个请求会同步命中上游缓存）也一样", async () => {
    const { lines, out } = await run(
      sameLengthDiff("seq", "'p-2'", "'p-4'"),
      "typescript",
      "sequential",
    );
    expectEveryLineColored(lines, out);
    // 新增行拿到的是新侧自己的 token，不是旧侧的
    const addIdx = lines.findIndex((l) => l.kind === "add");
    expect(out[addIdx]!.map((t) => t.content).join("")).toContain("p-4");
  });

  it("高亮器认语言：别名 / 扩展名派生的 id 都被接受；纯文本类不认", () => {
    expect(shikiCode.supportsLanguage(diffLanguageFromPath("a.ts")! as never)).toBe(true);
    expect(shikiCode.supportsLanguage(diffLanguageFromPath("a.tsx")! as never)).toBe(true);
    expect(shikiCode.supportsLanguage(diffLanguageFromPath("a.mjs")! as never)).toBe(true);
    expect(shikiCode.supportsLanguage(diffLanguageFromPath("Dockerfile")! as never)).toBe(true);
    expect(shikiCode.supportsLanguage(diffLanguageFromPath("notes.txt")! as never)).toBe(false);
  });
});
