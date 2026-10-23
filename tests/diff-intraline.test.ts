import { describe, expect, it } from "vitest";

import type { DiffSyntaxToken } from "@/lib/diff-syntax";
import {
  computeIntralineRanges,
  diffLineWords,
  INTRALINE_TOTAL_BUDGET,
  type InlineRange,
  mayBeSimilar,
  overlayRanges,
  pairChangeBlock,
  tokenizeForDiff,
} from "@/lib/diff/intraline";
import type { DiffViewLine } from "@/lib/tool-display";

/** range 合法性：升序、互不重叠、非空、不越界 */
const expectValidRanges = (ranges: readonly InlineRange[], text: string) => {
  let prevEnd = 0;
  for (const r of ranges) {
    expect(r.start).toBeGreaterThanOrEqual(prevEnd);
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.end).toBeLessThanOrEqual(text.length);
    prevEnd = r.end;
  }
};

const expectStrictlyIncreasing = (
  pairs: ReadonlyArray<{ del: number; add: number }>,
) => {
  for (let i = 1; i < pairs.length; i += 1) {
    expect(pairs[i]!.del).toBeGreaterThan(pairs[i - 1]!.del);
    expect(pairs[i]!.add).toBeGreaterThan(pairs[i - 1]!.add);
  }
};

describe("tokenizeForDiff", () => {
  it("标识符 / 下划线 / $ 各自成词", () => {
    expect(tokenizeForDiff("foo_bar")).toEqual(["foo_bar"]);
    expect(tokenizeForDiff("$el1")).toEqual(["$el1"]);
    expect(tokenizeForDiff("const a = 1")).toEqual([
      "const",
      " ",
      "a",
      " ",
      "=",
      " ",
      "1",
    ]);
  });

  it("连续空白合为一个 token，制表符也算空白", () => {
    expect(tokenizeForDiff("a \t b")).toEqual(["a", " \t ", "b"]);
  });

  it("标点 / 符号逐个独立", () => {
    expect(tokenizeForDiff("a.b.c")).toEqual(["a", ".", "b", ".", "c"]);
    expect(tokenizeForDiff("(){}")).toEqual(["(", ")", "{", "}"]);
    expect(tokenizeForDiff("a=>b")).toEqual(["a", "=", ">", "b"]);
  });

  it("中日韩逐字成 token，且不黏连相邻拉丁词", () => {
    expect(tokenizeForDiff("你好世界")).toEqual(["你", "好", "世", "界"]);
    expect(tokenizeForDiff("ひらカナ")).toEqual(["ひ", "ら", "カ", "ナ"]);
    expect(tokenizeForDiff("한글")).toEqual(["한", "글"]);
    expect(tokenizeForDiff("修复bug了")).toEqual(["修", "复", "bug", "了"]);
  });

  it("emoji 代理对保持完整", () => {
    expect(tokenizeForDiff("a😀b")).toEqual(["a", "😀", "b"]);
    expect(tokenizeForDiff("😀😀")).toEqual(["😀", "😀"]);
  });

  it("空串返回空数组", () => {
    expect(tokenizeForDiff("")).toEqual([]);
  });

  it("join 不变量", () => {
    for (const s of [
      "  indent();",
      "x\t=\t'中文 😀 mixed_1';",
      "\r",
      "é ñ 1.5e-3",
      "a\u00a0b",
    ]) {
      expect(tokenizeForDiff(s).join("")).toBe(s);
    }
  });
});

describe("diffLineWords", () => {
  it("单词替换", () => {
    expect(diffLineWords("const a = 1", "const b = 1")).toEqual({
      old: [{ start: 6, end: 7 }],
      new: [{ start: 6, end: 7 }],
    });
  });

  it("插入：只标新侧", () => {
    // foo(a) -> foo(a, b)：新增 ", b" 位于 [5, 8)
    expect(diffLineWords("foo(a)", "foo(a, b)")).toEqual({
      old: [],
      new: [{ start: 5, end: 8 }],
    });
  });

  it("删除：只标旧侧", () => {
    expect(diffLineWords("foo(a, b)", "foo(a)")).toEqual({
      old: [{ start: 5, end: 8 }],
      new: [],
    });
  });

  it("标点变化", () => {
    expect(diffLineWords("foo.bar(1)", "foo?.bar(1)")).toEqual({
      old: [],
      new: [{ start: 3, end: 4 }],
    });
  });

  it("缩进变化：保留纯空白 range", () => {
    expect(diffLineWords("foo();", "    foo();")).toEqual({
      old: [],
      new: [{ start: 0, end: 4 }],
    });
    expect(diffLineWords("\tfoo()", "    foo()")).toEqual({
      old: [{ start: 0, end: 1 }],
      new: [{ start: 0, end: 4 }],
    });
  });

  it("行尾加空格：纯空白 range 保留", () => {
    expect(diffLineWords("a b", "a b ")).toEqual({
      old: [],
      new: [{ start: 3, end: 4 }],
    });
  });

  it("CRLF：尾部 \\r 不被标记，偏移基于去掉 \\r 的文本", () => {
    const r = diffLineWords("let a = 1\r", "let a = 2\r");
    expect(r).toEqual({
      old: [{ start: 8, end: 9 }],
      new: [{ start: 8, end: 9 }],
    });
    // 一侧有 \r、一侧没有：\r 不算差异
    expect(diffLineWords("same\r", "same")).toBeNull();
    // 末尾新增内容时，range 也止于 \r 之前
    const r2 = diffLineWords("foo(a)\r", "foo(a, b)\r");
    expect(r2).toEqual({ old: [], new: [{ start: 5, end: 8 }] });
  });

  it("相邻 range 之间只夹纯标点 / 空白（<=2 字符）时合并", () => {
    // a、b 之间夹 ", "：合并为 "a, b" / "x, y"
    expect(diffLineWords("f(a, b)", "f(x, y)")).toEqual({
      old: [{ start: 2, end: 6 }],
      new: [{ start: 2, end: 6 }],
    });
  });

  it("夹着词字符的间隔不合并", () => {
    // 中间夹的 "爱" 是词字符
    expect(diffLineWords("我爱你们", "他爱她们")).toEqual({
      old: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
      new: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
    });
  });

  it("间隔超过 2 个字符不合并", () => {
    // 间隔 " and " 共 5 个字符
    expect(diffLineWords("a and b and c", "x and b and z")).toEqual({
      old: [
        { start: 0, end: 1 },
        { start: 12, end: 13 },
      ],
      new: [
        { start: 0, end: 1 },
        { start: 12, end: 13 },
      ],
    });
  });

  it("range 首尾空白收边（尾部）", () => {
    // 新增 "x + " 后面带空格：收成 [0, 3)
    expect(diffLineWords("foo(a)", "x + foo(a)")).toEqual({
      old: [],
      new: [{ start: 0, end: 3 }],
    });
  });

  it("range 首尾空白收边（头部）", () => {
    // 新增 " + b" 前面带空格：收成 [7, 10)
    expect(diffLineWords("foo(a)", "foo(a) + b")).toEqual({
      old: [],
      new: [{ start: 7, end: 10 }],
    });
  });

  it("相似度过低（整行重写）返回 null", () => {
    expect(diffLineWords("abc def", "xyz uvw")).toBeNull();
    expect(diffLineWords("", "x")).toBeNull();
  });

  it("两行相同返回 null", () => {
    expect(diffLineWords("same line", "same line")).toBeNull();
    expect(diffLineWords("", "")).toBeNull();
  });

  it("超长行返回 null", () => {
    const tail = "x".repeat(1998);
    // 2001 个单元：超限
    expect(diffLineWords(`a ${tail}y`, `b ${tail}y`)).toBeNull();
    expect(diffLineWords(`a ${tail}`, `b ${tail}y`)).toBeNull();
    // 恰好 2000 个单元仍可处理
    expect(diffLineWords(`a ${tail}`, `b ${tail}`)).toEqual({
      old: [{ start: 0, end: 1 }],
      new: [{ start: 0, end: 1 }],
    });
  });

  it("token 数超过 800 返回 null", () => {
    const base = "a ".repeat(450); // 900 个 token、900 个字符
    expect(diffLineWords(base, `${base}b`)).toBeNull();
    // 同样结构、规模内则正常
    const small = "a ".repeat(50);
    expect(diffLineWords(small, `${small}b`)).toEqual({
      old: [],
      new: [{ start: 100, end: 101 }],
    });
  });

  it("返回的 range 合法", () => {
    const pairs: Array<[string, string]> = [
      ["const a = foo(1, 2);", "const b = foo(1, 3, 4);"],
      ["  return x + y;", "return x - y;"],
      ["修复了一个 bug", "修复了两个 bug"],
      ["a😀b", "a😀c"],
    ];
    for (const [o, n] of pairs) {
      const r = diffLineWords(o, n);
      expect(r).not.toBeNull();
      expectValidRanges(r!.old, o);
      expectValidRanges(r!.new, n);
    }
  });

  it("emoji 不会被切开", () => {
    // 😀 占 2 个 UTF-16 单元，range 必须覆盖整个代理对
    expect(diffLineWords("ab😀cd", "ab😁cd")).toEqual({
      old: [{ start: 2, end: 4 }],
      new: [{ start: 2, end: 4 }],
    });
  });
});

describe("pairChangeBlock", () => {
  it("等长按序一一配对（不看相似度）", () => {
    expect(pairChangeBlock(["aaa", "bbb"], ["xxx", "yyy"])).toEqual([
      { del: 0, add: 0 },
      { del: 1, add: 1 },
    ]);
  });

  it("不等长：中间插入一行时按相似度对齐", () => {
    const dels = ["const foo = 1;", "return foo;"];
    const adds = ["const foo = 2;", "// brand new comment here", "return foo + 1;"];
    expect(pairChangeBlock(dels, adds)).toEqual([
      { del: 0, add: 0 },
      { del: 1, add: 2 },
    ]);
  });

  it("不等长：前面多出一行", () => {
    expect(
      pairChangeBlock(
        ["let alpha = compute(x);"],
        ["// note", "let alpha = compute(y);"],
      ),
    ).toEqual([{ del: 0, add: 1 }]);
  });

  it("不等长：都不相似则不配对", () => {
    expect(pairChangeBlock(["aaaa"], ["zzzz", "yyyy"])).toEqual([]);
  });

  it("极短文本：相同视为相似、不同视为不相似", () => {
    expect(pairChangeBlock(["a"], ["a", "b"])).toEqual([{ del: 0, add: 0 }]);
    expect(pairChangeBlock([""], ["", "x"])).toEqual([{ del: 0, add: 0 }]);
    expect(pairChangeBlock(["a"], ["b", "c"])).toEqual([]);
  });

  it("m*n 恰为 900 仍配对，超过则退化为 []", () => {
    const adds = Array.from({ length: 36 }, (_, i) => `line number ${i} content`);
    const dels25 = adds.slice(0, 25); // 25 * 36 = 900
    const ok = pairChangeBlock(dels25, adds);
    expect(ok).toHaveLength(25);
    for (const p of ok) expect(p.del).toBe(p.add);
    expectStrictlyIncreasing(ok);

    const dels26 = adds.slice(0, 26); // 26 * 36 = 936
    expect(pairChangeBlock(dels26, adds)).toEqual([]);
  });

  it("空输入返回 []", () => {
    expect(pairChangeBlock([], [])).toEqual([]);
    expect(pairChangeBlock(["a"], [])).toEqual([]);
    expect(pairChangeBlock([], ["a"])).toEqual([]);
  });

  it("下标严格递增", () => {
    const dels = ["foo(1)", "bar(2)", "baz(3)"];
    const adds = ["baz(3)", "foo(1)", "bar(2)", "qux(9)", "baz(3)"];
    const pairs = pairChangeBlock(dels, adds);
    expect(pairs.length).toBeGreaterThan(0);
    expectStrictlyIncreasing(pairs);
  });
});

const L = (kind: DiffViewLine["kind"], text: string): DiffViewLine => ({
  kind,
  text,
});

describe("computeIntralineRanges", () => {
  it("一个 del + add 块：key 是行下标", () => {
    const lines = [
      L("context", "head"),
      L("del", "const a = 1"),
      L("add", "const b = 1"),
      L("context", "tail"),
    ];
    const m = computeIntralineRanges(lines);
    expect([...m.keys()].sort()).toEqual([1, 2]);
    expect(m.get(1)).toEqual([{ start: 6, end: 7 }]);
    expect(m.get(2)).toEqual([{ start: 6, end: 7 }]);
    expect(m.has(0)).toBe(false);
    expect(m.has(3)).toBe(false);
  });

  it("context 行打断块：不跨 context 配对", () => {
    const lines = [
      L("del", "const a = 1"),
      L("context", "mid"),
      L("add", "const b = 1"),
    ];
    expect(computeIntralineRanges(lines).size).toBe(0);
  });

  it("hunk 行打断块", () => {
    const lines = [
      L("del", "const a = 1"),
      L("hunk", ""),
      L("add", "const b = 1"),
    ];
    expect(computeIntralineRanges(lines).size).toBe(0);
  });

  it("只有 del 或只有 add 的块不处理", () => {
    expect(
      computeIntralineRanges([L("del", "x = 1"), L("del", "y = 2")]).size,
    ).toBe(0);
    expect(
      computeIntralineRanges([L("add", "x = 1"), L("add", "y = 2")]).size,
    ).toBe(0);
    expect(computeIntralineRanges([]).size).toBe(0);
  });

  it("多个块各自独立", () => {
    const lines = [
      L("del", "const a = 1"), // 0
      L("add", "const b = 1"), // 1
      L("context", "x"), // 2
      L("del", "let p = foo(1)"), // 3
      L("del", "let q = foo(2)"), // 4
      L("add", "let p = foo(10)"), // 5
      L("add", "let q = bar(2)"), // 6
    ];
    const m = computeIntralineRanges(lines);
    expect(m.get(0)).toEqual([{ start: 6, end: 7 }]);
    expect(m.get(1)).toEqual([{ start: 6, end: 7 }]);
    expect(m.get(3)).toEqual([{ start: 12, end: 13 }]);
    expect(m.get(5)).toEqual([{ start: 12, end: 14 }]);
    expect(m.get(4)).toEqual([{ start: 8, end: 11 }]);
    expect(m.get(6)).toEqual([{ start: 8, end: 11 }]);
  });

  it("add 之后紧跟的 del 开启新块", () => {
    const lines = [
      L("del", "const a = 1"), // 0
      L("add", "const b = 1"), // 1
      L("del", "let x = 1"), // 2
      L("add", "let y = 1"), // 3
    ];
    const m = computeIntralineRanges(lines);
    expect(m.get(0)).toEqual([{ start: 6, end: 7 }]);
    expect(m.get(1)).toEqual([{ start: 6, end: 7 }]);
    expect(m.get(2)).toEqual([{ start: 4, end: 5 }]);
    expect(m.get(3)).toEqual([{ start: 4, end: 5 }]);
  });

  it("不等长块：用相似度配对，下标挂在正确的行上", () => {
    const lines = [
      L("del", "const foo = 1;"), // 0
      L("del", "return foo;"), // 1
      L("add", "const foo = 2;"), // 2
      L("add", "// brand new comment here"), // 3
      L("add", "return foo + 1;"), // 4
    ];
    const m = computeIntralineRanges(lines);
    expect(m.get(0)).toEqual([{ start: 12, end: 13 }]);
    expect(m.get(2)).toEqual([{ start: 12, end: 13 }]);
    // "return foo;" 与 add 4 配对：只在新侧插入了 " + 1"（收边后 [11, 14)），旧侧无 range
    expect(m.has(1)).toBe(false);
    expect(m.get(4)).toEqual([{ start: 11, end: 14 }]);
    // 无关的注释行不参与
    expect(m.has(3)).toBe(false);
  });

  it("旧侧最后一行没有结尾换行：标记不打断「删 → 增」，照样配对出词级 range；标记行自己不挂 range", () => {
    const MARK = "\\ No newline at end of file";
    const lines = [
      L("context", "head"), // 0
      L("del", "const total = price * 2;"), // 1
      L("context", MARK), // 2：旧侧标记，属于上一行
      L("add", "const total = price * 3;"), // 3
      L("context", MARK), // 4：新侧标记
    ];
    const m = computeIntralineRanges(lines);
    expect(m.get(1)).toEqual([{ start: 22, end: 23 }]);
    expect(m.get(3)).toEqual([{ start: 22, end: 23 }]);
    expect([...m.keys()].sort()).toEqual([1, 3]);
  });

  it("只放行标记：纯删除 + 标记不报错；连着两条标记（畸形）第二条照样打断；没前缀的无行号 context 不算标记", () => {
    const MARK = "\\ No newline at end of file";
    expect(computeIntralineRanges([L("del", "x = 1"), L("context", MARK), L("context", "tail")]).size).toBe(0);
    expect(
      computeIntralineRanges([L("del", "const a = 1"), L("context", MARK), L("context", MARK), L("add", "const b = 1")]).size,
    ).toBe(0);
    expect(
      computeIntralineRanges([L("del", "const a = 1"), L("context", "mid"), L("add", "const b = 1")]).size,
    ).toBe(0);
  });

  it("整行重写的配对不产生 range；context / hunk 行永远不进 Map", () => {
    const lines = [
      L("context", "keep"), // 0
      L("hunk", ""), // 1
      L("del", "abc def"), // 2
      L("add", "xyz uvw"), // 3
    ];
    const m = computeIntralineRanges(lines);
    expect(m.size).toBe(0);
  });
});

describe("mayBeSimilar：词级 diff 之前的廉价预检", () => {
  it("没有足够共同字符的拒绝；整体接近的放行", () => {
    // 整行重写：除了一个空格没有任何共同字符
    expect(mayBeSimilar("abc def", "xyz uvw")).toBe(false);
    expect(mayBeSimilar("a".repeat(10), "b".repeat(10))).toBe(false);
    // 长度悬殊：共有字符再多也不到长行的 35%
    expect(mayBeSimilar("a".repeat(10), "a".repeat(100))).toBe(false);
    expect(mayBeSimilar("", "")).toBe(false);
    expect(mayBeSimilar("", "x")).toBe(false);
    expect(mayBeSimilar("const a = 1", "const b = 1")).toBe(true);
    expect(mayBeSimilar("foo(a)", "foo(a, b)")).toBe(true);
  });

  it("它只是上界：字符都共有、顺序却完全不同的两行预检放行，由后面的精确检查决定", () => {
    expect(mayBeSimilar("abcdef", "fedcba")).toBe(true);
  });

  it("多重集语义：同一个字符要按个数算（不能一个 a 配上对面所有的 a）", () => {
    // 共有字符只有 1 个 a：1 / 10 < 0.35
    expect(mayBeSimilar("a" + "x".repeat(9), "a".repeat(10))).toBe(false);
  });

  it("性质：预检拒绝的，diffLineWords 一定也是 null（预检只省功夫、不改结果）", () => {
    // 固定种子的伪随机（mulberry32）：用例可复现
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = ["a", "b", "c", " ", "(", ")", ",", ".", "foo", "bar", "中", "文"];
    const randomLine = (max: number) =>
      Array.from({ length: Math.floor(rand() * max) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    /** 从一行出发做若干次随机编辑：得到「像改过的」一对 */
    const edit = (s: string): string => {
      let out = s;
      for (let k = Math.floor(rand() * 4); k >= 0; k -= 1) {
        const at = Math.floor(rand() * (out.length + 1));
        const roll = rand();
        if (roll < 0.34) out = out.slice(0, at) + randomLine(4) + out.slice(at);
        else if (roll < 0.67) out = out.slice(0, at) + out.slice(at + 1 + Math.floor(rand() * 3));
        else out = out.slice(0, at) + randomLine(3) + out.slice(at + 2);
      }
      return out;
    };

    let rejected = 0;
    let accepted = 0;
    for (let n = 0; n < 1500; n += 1) {
      const a = randomLine(40);
      const b = n % 2 === 0 ? randomLine(40) : edit(a);
      if (mayBeSimilar(a, b)) {
        accepted += 1;
        continue;
      }
      rejected += 1;
      expect(diffLineWords(a, b), JSON.stringify([a, b])).toBeNull();
    }
    // 自检：两种情形都真的出现过（别让性质在空集上通过）
    expect(rejected).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThan(100);
  });
});

describe("词级高亮的规模保护", () => {
  it("pairChangeBlock：不等长块里的超长行不参与配对（不去做逐字符 bigram）", () => {
    const long = `const value = ${"x".repeat(5000)};`;
    // 超长行两侧都「一样」，但仍不配对；其余正常行照常配
    const pairs = pairChangeBlock([long, "return foo;"], [long, "return foo + 1;", "// another comment"]);
    expect(pairs).toEqual([{ del: 1, add: 1 }]);
  });

  it("超长行本身：不分词、不 diff，直接放弃", () => {
    const long = "y".repeat(2500);
    expect(diffLineWords(`a${long}`, `b${long}`)).toBeNull();
  });

  it("总量预算：超大 diff 只算前面的块，后面的块只做整行着色（不卡主线程）；已算出的照常返回", () => {
    // 每对两侧约 100 字符 → 200 字符；预算 INTRALINE_TOTAL_BUDGET
    const pad = "p".repeat(80);
    // 每对两侧至少 190 字符：预算最多覆盖 BUDGET / 190 对，多造 200 对保证一定会超
    const pairsNeeded = Math.ceil(INTRALINE_TOTAL_BUDGET / 190) + 200;
    const lines: DiffViewLine[] = [];
    for (let i = 0; i < pairsNeeded; i += 1) {
      lines.push(L("del", `let v${i} = f(${pad}, 1);`));
      lines.push(L("add", `let v${i} = f(${pad}, 2);`));
      lines.push(L("context", "-")); // 每个块各自独立
    }
    const m = computeIntralineRanges(lines);
    // 前面的块有词级 range
    expect(m.has(0)).toBe(true);
    expect(m.has(1)).toBe(true);
    // 最后一个块被预算挡掉
    const last = (pairsNeeded - 1) * 3;
    expect(m.has(last)).toBe(false);
    expect(m.has(last + 1)).toBe(false);
    // 算出的块数不超过预算能覆盖的
    expect(m.size).toBeLessThanOrEqual(2 * Math.ceil(INTRALINE_TOTAL_BUDGET / 190));
    expect(m.size).toBeGreaterThan(100);
  });

  it("预算只被真正要分词的行对消耗：整行重写（上界不够）的对不占预算", () => {
    const lines: DiffViewLine[] = [];
    // 先放一大堆「整行重写」的对：预检直接拒绝、不占预算
    const rewrite = Math.ceil(INTRALINE_TOTAL_BUDGET / 20);
    for (let i = 0; i < rewrite; i += 1) {
      lines.push(L("del", "a".repeat(10)));
      lines.push(L("add", "b".repeat(100)));
      lines.push(L("context", "-"));
    }
    // 最后一个真正可标的块
    lines.push(L("del", "const a = 1"));
    lines.push(L("add", "const b = 1"));
    const m = computeIntralineRanges(lines);
    expect(m.get(lines.length - 2)).toEqual([{ start: 6, end: 7 }]);
    expect(m.get(lines.length - 1)).toEqual([{ start: 6, end: 7 }]);
  });
});

describe("overlayRanges", () => {
  const tokens: DiffSyntaxToken[] = [
    { content: "const", light: "#d73a49", dark: "#f97583", bold: true },
    { content: " " },
    { content: "name", light: "#005cc5", dark: "#79b8ff", italic: true },
    { content: " = 1;", light: "#24292e" },
  ];
  const text = "const name = 1;";
  const joinContent = (segs: readonly { content: string }[]) =>
    segs.map((s) => s.content).join("");

  it("无 tokens：退化为单个无色 token，并按 range 切分", () => {
    expect(overlayRanges("abc", null, undefined)).toEqual([{ content: "abc" }]);
    expect(overlayRanges("abcdef", undefined, [{ start: 2, end: 4 }])).toEqual([
      { content: "ab" },
      { content: "cd", mark: true },
      { content: "ef" },
    ]);
    expect(overlayRanges("abc", [], undefined)).toEqual([{ content: "abc" }]);
  });

  it("tokens 与 text 不一致时忽略 tokens", () => {
    const bad: DiffSyntaxToken[] = [{ content: "other", light: "#fff" }];
    expect(overlayRanges("abc", bad, undefined)).toEqual([{ content: "abc" }]);
  });

  it("无 range：原样返回 token，样式保留且不带 mark", () => {
    const r = overlayRanges(text, tokens, undefined);
    expect(r).toEqual(tokens);
    for (const seg of r) expect("mark" in seg).toBe(false);
    expect(overlayRanges(text, tokens, [])).toEqual(tokens);
  });

  it("range 落在 token 中间", () => {
    // "name" 的 [6, 10)；标 "am"：偏移 7..9
    const r = overlayRanges(text, tokens, [{ start: 7, end: 9 }]);
    expect(r).toEqual([
      { content: "const", light: "#d73a49", dark: "#f97583", bold: true },
      { content: " " },
      { content: "n", light: "#005cc5", dark: "#79b8ff", italic: true },
      {
        content: "am",
        light: "#005cc5",
        dark: "#79b8ff",
        italic: true,
        mark: true,
      },
      { content: "e", light: "#005cc5", dark: "#79b8ff", italic: true },
      { content: " = 1;", light: "#24292e" },
    ]);
    expect(joinContent(r)).toBe(text);
  });

  it("range 跨多个 token，颜色保留", () => {
    // [3, 8)："st", " ", "na"
    const r = overlayRanges(text, tokens, [{ start: 3, end: 8 }]);
    expect(r).toEqual([
      { content: "con", light: "#d73a49", dark: "#f97583", bold: true },
      {
        content: "st",
        light: "#d73a49",
        dark: "#f97583",
        bold: true,
        mark: true,
      },
      { content: " ", mark: true },
      {
        content: "na",
        light: "#005cc5",
        dark: "#79b8ff",
        italic: true,
        mark: true,
      },
      { content: "me", light: "#005cc5", dark: "#79b8ff", italic: true },
      { content: " = 1;", light: "#24292e" },
    ]);
    expect(joinContent(r)).toBe(text);
  });

  it("range 恰好与 token 边界对齐：不产生空片段", () => {
    const r = overlayRanges(text, tokens, [{ start: 6, end: 10 }]);
    expect(r.map((s) => [s.content, s.mark === true])).toEqual([
      ["const", false],
      [" ", false],
      ["name", true],
      [" = 1;", false],
    ]);
  });

  it("多个 range", () => {
    const r = overlayRanges("abcdef", null, [
      { start: 0, end: 1 },
      { start: 4, end: 6 },
    ]);
    expect(r).toEqual([
      { content: "a", mark: true },
      { content: "bcd" },
      { content: "ef", mark: true },
    ]);
  });

  it("越界 range 被夹住或忽略，不抛错", () => {
    expect(() =>
      overlayRanges("abcdef", null, [
        { start: -5, end: 2 },
        { start: 4, end: 99 },
        { start: 3, end: 3 },
        { start: 5, end: 1 },
        { start: 100, end: 200 },
        { start: Number.NaN, end: 3 },
      ]),
    ).not.toThrow();
    const r = overlayRanges("abcdef", null, [
      { start: -5, end: 2 },
      { start: 4, end: 99 },
      { start: 3, end: 3 },
      { start: 5, end: 1 },
      { start: 100, end: 200 },
    ]);
    expect(r).toEqual([
      { content: "ab", mark: true },
      { content: "cd" },
      { content: "ef", mark: true },
    ]);
    // 全部非法：等同无 range
    expect(overlayRanges("abc", null, [{ start: 9, end: 10 }])).toEqual([
      { content: "abc" },
    ]);
  });

  it("重叠 / 乱序 range 先合并", () => {
    const r = overlayRanges("abcdefgh", null, [
      { start: 4, end: 7 },
      { start: 1, end: 3 },
      { start: 2, end: 5 },
    ]);
    expect(r).toEqual([
      { content: "a" },
      { content: "bcdefg", mark: true },
      { content: "h" },
    ]);
  });

  it("空 text 返回 []", () => {
    expect(overlayRanges("", null, undefined)).toEqual([]);
    expect(overlayRanges("", [{ content: "" }], [{ start: 0, end: 1 }])).toEqual(
      [],
    );
  });

  it("输入 token 数组不被修改", () => {
    const copy = JSON.parse(JSON.stringify(tokens)) as DiffSyntaxToken[];
    overlayRanges(text, tokens, [{ start: 1, end: 12 }]);
    expect(tokens).toEqual(copy);
  });
});

describe("随机不变量（固定种子）", () => {
  /** mulberry32：固定种子的简单伪随机，保证用例可复现 */
  const makeRng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const ALPHABET = [
    "a",
    "b",
    "foo",
    "bar_1",
    "$x",
    " ",
    "  ",
    "\t",
    ".",
    ",",
    "(",
    ")",
    "{",
    "=",
    "你",
    "好",
    "ひ",
    "😀",
    "é",
    "9",
  ];
  const randomText = (rng: () => number, maxParts: number) => {
    const n = Math.floor(rng() * (maxParts + 1));
    let s = "";
    for (let i = 0; i < n; i += 1) {
      s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    }
    return s;
  };
  /** 在 base 上随机替换 / 删除 / 插入一小段，使一对文本相似、更容易走到 range 分支 */
  const mutate = (rng: () => number, base: string) => {
    const at = Math.floor(rng() * (base.length + 1));
    const cut = Math.floor(rng() * 4);
    return base.slice(0, at) + randomText(rng, 2) + base.slice(at + cut);
  };

  it("tokenize / diffLineWords / overlayRanges 的不变量", () => {
    const rng = makeRng(20261023);
    let nonNull = 0;
    for (let i = 0; i < 400; i += 1) {
      const a = randomText(rng, 14);
      const b = i % 2 === 0 ? randomText(rng, 14) : mutate(rng, a);
      const crlf = i % 5 === 0 ? "\r" : "";

      expect(tokenizeForDiff(a).join("")).toBe(a);
      expect(tokenizeForDiff(b).join("")).toBe(b);

      const r = diffLineWords(a + crlf, b + crlf);
      if (r) {
        nonNull += 1;
        expectValidRanges(r.old, a);
        expectValidRanges(r.new, b);
        // 公共前缀以外至少有一处被标，且没有任何 range 覆盖 \r
        expect(r.old.length + r.new.length).toBeGreaterThan(0);

        const segsOld = overlayRanges(a, null, r.old);
        const segsNew = overlayRanges(b, null, r.new);
        expect(segsOld.map((s) => s.content).join("")).toBe(a);
        expect(segsNew.map((s) => s.content).join("")).toBe(b);
        for (const seg of [...segsOld, ...segsNew]) {
          expect(seg.content.length).toBeGreaterThan(0);
        }
      }

      // 任意（含越界、乱序）range 都不破坏拼接不变量
      const wild: InlineRange[] = [];
      for (let k = 0; k < 3; k += 1) {
        wild.push({
          start: Math.floor(rng() * (a.length + 6)) - 3,
          end: Math.floor(rng() * (a.length + 6)) - 3,
        });
      }
      const styled: DiffSyntaxToken[] = tokenizeForDiff(a).map((content, idx) => ({
        content,
        light: idx % 2 === 0 ? "#111111" : undefined,
      }));
      const segs = overlayRanges(a, styled, wild);
      expect(segs.map((s) => s.content).join("")).toBe(a);
    }
    // 保证确实走到了产出 range 的分支
    expect(nonNull).toBeGreaterThan(20);
  });
});
