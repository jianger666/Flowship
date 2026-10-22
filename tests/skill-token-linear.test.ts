/**
 * parseSkillTokens 线性化（第四轮 N2-03 / Q6-17）+ 中文句读结束 @ 词（Q6-05 / N2-04）
 *
 * - Q6-17：旧实现对每个 `/` 候选重切 `text.slice(0, start)` 再回溯到词首；中文长段没有半角空白、
 *   每次都回到行首 = O(n²)（25000 字 196ms、75000 字 1.7s），而且挂在每次按键整节点重算的 transform 上。
 *   新实现单次扫描维护「当前词里是否已有触发 @」。这里用「旧实现原样复制」做逐项等价，再卡性能上界。
 * - Q6-05：`@张三，请/review`、`感谢@张三，/`：`，。；！？、` 等中文句读结束 @ 词，之后的 slash 照常触发。
 * - N2-04：`看下@src/a.ts，然后…` 的文件 pill 在中文句读处收口，不再吞掉后面整句。
 */
import { describe, expect, it } from "vitest";

import {
  findAtFileTokens,
  isAtWordBreak,
  isInsideAtWord,
  matchAtTrigger,
} from "@/lib/composer-trigger";
import {
  matchLongestSkillName,
  matchSlashTrigger,
  parseSkillTokens,
  SKILL_TOKEN_RE,
} from "@/lib/skill-token";

/** 旧实现（第三轮 R6-02/03 版）原样复制：每个候选对前缀整体重跑 isInsideAtWord */
const parseSkillTokensOld = (
  text: string,
  knownNames: ReadonlySet<string>,
): Array<{ start: number; end: number; name: string }> => {
  const out: Array<{ start: number; end: number; name: string }> = [];
  SKILL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKILL_TOKEN_RE.exec(text)) !== null) {
    const candidate = m[2]!;
    const leading = m[1] ?? "";
    const start = m.index + leading.length;
    const name = isInsideAtWord(text.slice(0, start))
      ? null
      : matchLongestSkillName(candidate, knownNames);
    if (!name) {
      SKILL_TOKEN_RE.lastIndex = m.index + m[0].length - 1;
      continue;
    }
    const end = start + 1 + name.length;
    out.push({ start, end, name });
    SKILL_TOKEN_RE.lastIndex = end - 1;
  }
  return out;
};

const makeRng = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ALPHABET = [
  "a", "b", "x", "/", "/", "/", "/", "@", "@", "@", " ", "\n", "\t", ":", ".", "-",
  "他", "她", "组", "件", "，", "。", "；", "！", "？", "、", "（", "）", "＠", "／", "“",
  "review", "plan", "写代码", "读", "x.y", "src", "docs", "@a/b", "和/或",
] as const;
const KNOWN = new Set(["review", "plan", "写代码", "读", "x.y", "x"]);

describe("Q6-17 / N2-03：parseSkillTokens 线性化与旧实现逐项等价", () => {
  it("4 万条随机短语料：结果与旧实现完全一致（且确实命中过足量 token）", () => {
    const rnd = makeRng(20261021);
    let withTokens = 0;
    let withAt = 0;
    for (let i = 0; i < 40_000; i += 1) {
      const n = 1 + Math.floor(rnd() * 14);
      let s = "";
      for (let k = 0; k < n; k += 1) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
      const got = parseSkillTokens(s, KNOWN);
      const want = parseSkillTokensOld(s, KNOWN);
      expect(got).toEqual(want);
      if (want.length > 0) withTokens += 1;
      if (s.includes("@")) withAt += 1;
    }
    expect(withTokens).toBeGreaterThan(1_000);
    expect(withAt).toBeGreaterThan(5_000);
  });

  it("300 条随机长语料（2000+ 片段）同样一致", () => {
    const rnd = makeRng(7);
    for (let i = 0; i < 300; i += 1) {
      let s = "";
      for (let k = 0; k < 2_000; k += 1) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
      expect(parseSkillTokens(s, KNOWN)).toEqual(parseSkillTokensOld(s, KNOWN));
    }
  });

  it("性能不变量：7.5 万字无半角空白中文长段（每 26 字一个「和/或」）< 150ms，且与旧实现一致的小样本", () => {
    const unit = "这是一段没有半角空白的中文长文本用来制造很多斜杠和/或";
    expect(unit.length).toBeGreaterThanOrEqual(24);
    let big = "";
    while (big.length < 75_000) big += unit;
    const t0 = performance.now();
    const got = parseSkillTokens(big, KNOWN);
    const ms = performance.now() - t0;
    expect(got).toEqual([]); // 「或」不是已知 skill
    expect(ms).toBeLessThan(150); // 旧实现这里 1.7s；新实现个位数 ms，上界放宽防 CI 抖动

    // 含已知 skill 的变体：每 26 字一个 `/读`（命中）+ 一个 `@` 词，仍线性且结果与旧实现一致（用中等规模对拍）
    const mid = `${"说明文字文字文字文字 @src/a.ts，请/读 然后/plan"}`.repeat(300);
    expect(parseSkillTokens(mid, KNOWN)).toEqual(parseSkillTokensOld(mid, KNOWN));
    const bigHit = "没有空白的中文，请/读".repeat(8_000);
    const t1 = performance.now();
    const hit = parseSkillTokens(bigHit, KNOWN);
    expect(performance.now() - t1).toBeLessThan(300);
    expect(hit.length).toBe(8_000);
  });

  it("短路：无已知 skill / 文本无 `/` 直接返回空数组", () => {
    expect(parseSkillTokens("/review", new Set())).toEqual([]);
    expect(parseSkillTokens("review plan", KNOWN)).toEqual([]);
  });

  it("旧树能用：行首 / 空白后 / CJK 后的 token 与 `@` 词内排除照旧", () => {
    expect(parseSkillTokens("/review x", KNOWN)).toEqual([{ start: 0, end: 7, name: "review" }]);
    expect(parseSkillTokens("帮我看下/review", KNOWN).map((t) => t.name)).toEqual(["review"]);
    expect(parseSkillTokens("@src/组件/review", KNOWN)).toEqual([]); // R6-02：@ 词内的 / 是路径
    expect(parseSkillTokens("他/她/plan x", KNOWN).map((t) => t.name)).toEqual(["plan"]); // R6-03
  });
});

describe("Q6-05：中文句读结束 @ 词，之后的 slash 照常触发", () => {
  it("`@张三，请/review`：「请」是 CJK 前缀，slash 触发、解析也认", () => {
    const before = "@张三，请/review";
    expect(matchSlashTrigger(before)).toEqual({ start: 5, query: "review" });
    expect(parseSkillTokens(`${before} 看看`, KNOWN).map((t) => t.name)).toEqual(["review"]);
  });

  it("`感谢@张三，/`：句读后直接 `/` 也触发（空 query）", () => {
    expect(matchSlashTrigger("感谢@张三，/")).toEqual({ start: 6, query: "" });
  });

  it("每个句读都能结束 @ 词：，。；！？、：", () => {
    for (const p of ["，", "。", "；", "！", "？", "、", "："]) {
      expect(isAtWordBreak(p)).toBe(true);
      expect(matchSlashTrigger(`@张三${p}/review`)).not.toBeNull();
      expect(matchAtTrigger(`@张三${p}`)).toBeNull(); // 句读之后不再是 @ 词
    }
  });

  it("旧树能用：ASCII `@a.ts, /` 仍弹；@ 词内的路径分隔 `/`（含中文目录）仍不弹", () => {
    expect(matchSlashTrigger("@a.ts, /")).not.toBeNull();
    expect(matchSlashTrigger("@src/组件/")).toBeNull();
    expect(matchSlashTrigger("请看@文档/")).toBeNull();
    expect(matchSlashTrigger("@docs/设计/but")).toBeNull();
    expect(matchAtTrigger("看下@src/组件/a")).toEqual({ start: 2, query: "src/组件/a" });
  });
});

describe("N2-04：`@path` pill 在中文句读处收口，不吞后面整句", () => {
  it("`看下@src/a.ts，然后把这个函数改成异步的` → pill 只到 `.ts`", () => {
    const line = "看下@src/a.ts，然后把这个函数改成异步的";
    const toks = findAtFileTokens(line);
    expect(toks).toEqual([{ start: 2, end: 11, path: "src/a.ts" }]);
    expect(line.slice(toks[0]!.end)).toBe("，然后把这个函数改成异步的");
  });

  it("全角括号 / 句号 / 引号也收口：`（@src/a.ts）`、`@src/a.ts。`、`“@docs/x.md”`", () => {
    expect(findAtFileTokens("（@src/a.ts）说").map((t) => t.path)).toEqual(["src/a.ts"]);
    expect(findAtFileTokens("改@src/a.ts。然后").map((t) => t.path)).toEqual(["src/a.ts"]);
    expect(findAtFileTokens("看“@docs/x.md”").map((t) => t.path)).toEqual(["docs/x.md"]);
  });

  it("旧树能用：中文目录名 / 空白结束 / `:行号` 结束照旧", () => {
    expect(findAtFileTokens("@src/组件/a.ts 然后").map((t) => t.path)).toEqual(["src/组件/a.ts"]);
    expect(findAtFileTokens("@src/a.ts:10-20").map((t) => t.path)).toEqual(["src/a.ts"]);
    expect(findAtFileTokens("@src/a.ts").map((t) => t.path)).toEqual(["src/a.ts"]);
    expect(findAtFileTokens("邮箱 me@x.com 不算")).toEqual([]);
  });
});

describe("第五轮：`@` 硬边界收窄为 `，。；！？、：`，括号 / 书名号 / 引号 / 破折号 / 省略号只在 token 尾部剥离", () => {
  const SOFT = ["（", "）", "【", "】", "《", "》", "「", "」", "『", "』", "“", "”", "‘", "’", "…", "—"];

  it("这些符号不再是 @ 词的硬边界；七个句读仍是", () => {
    for (const ch of SOFT) expect(isAtWordBreak(ch), ch).toBe(false);
    for (const ch of ["，", "。", "；", "！", "？", "、", "："]) expect(isAtWordBreak(ch), ch).toBe(true);
  });

  it("文件名里真有 `—` `…` `（）` `《》` 时 pill 不再被截在半截", () => {
    for (const p of ["docs/设计—终稿.md", "docs/报告…初稿.md", "docs/a（1）.md", "docs/《设计》说明.md", "docs/【草稿】a.md"]) {
      const line = `看下@${p} 然后`;
      expect(findAtFileTokens(line).map((t) => t.path), p).toEqual([p]);
    }
  });

  it("落在 token 尾部的包裹 / 修饰符号被剥掉（不进 pill、区间也不含它们）", () => {
    for (const [line, path] of [
      ["看@docs/a.md）", "docs/a.md"],
      ["看@docs/a.md…", "docs/a.md"],
      ["看@src/a.ts——", "src/a.ts"],
      ["看@docs/设计.md》", "docs/设计.md"],
      ["看@src/a.ts」』”’", "src/a.ts"],
    ] as const) {
      const toks = findAtFileTokens(line);
      expect(toks.map((t) => t.path), line).toEqual([path]);
      expect(line.slice(toks[0]!.start, toks[0]!.end), line).toBe(`@${path}`);
    }
  });

  it("被开括号 / 开引号紧贴包住的 @：在配对闭合符处收口，闭合符后紧跟汉字也不吞", () => {
    for (const [line, path] of [
      ["（@src/a.ts）说", "src/a.ts"],
      ["《@docs/设计.md》然后", "docs/设计.md"],
      ["「@a/b.ts」后", "a/b.ts"],
      ["看“@docs/x.md”再说", "docs/x.md"],
      ["【@a/b.md】改", "a/b.md"],
    ] as const) {
      expect(findAtFileTokens(line).map((t) => t.path), line).toEqual([path]);
    }
    // 没有开符紧贴：中间的闭合符是文件名的一部分，不提前收口
    expect(findAtFileTokens("看@docs/a）b.md").map((t) => t.path)).toEqual(["docs/a）b.md"]);
  });

  it("slash 触发口径：句读后照常弹；软符号（无配对闭合时）不结束 @ 词——`@docs/《设计》/` 仍是路径", () => {
    expect(matchSlashTrigger("@a.ts，请/review")).not.toBeNull();
    expect(matchSlashTrigger("@docs/《设计》/")).toBeNull();
    expect(matchSlashTrigger("（@src/a.ts） 请/review")).not.toBeNull();
    expect(matchSlashTrigger("（@src/a.ts），请/review")).not.toBeNull();
  });
});

describe("第六轮 P3-2：「@ 词在哪结束」触发 / slash / 解析 / pill 四处同一个状态机（含配对闭合符）", () => {
  it("`（@src/a.ts）/review`：闭合符结束 @ 词 → slash 弹、skill 解析生效（R5 行为恢复；上一版是 R6 的回归）", () => {
    const text = "（@src/a.ts）/review";
    expect(matchSlashTrigger(text)).toEqual({ start: 11, query: "review" });
    expect(parseSkillTokens(`${text} 看看`, KNOWN).map((t) => t.name)).toEqual(["review"]);
    expect(findAtFileTokens(text).map((t) => t.path)).toEqual(["src/a.ts"]);
  });

  it("`（@src/a.ts）请`：闭合符之后菜单关闭（上一版把 `src/a.ts）请` 当查询重新打开）；闭合符之前仍在 @ 词内", () => {
    expect(matchAtTrigger("（@src/a.ts）请")).toBeNull();
    expect(matchAtTrigger("（@src/a.ts）")).toBeNull();
    expect(matchAtTrigger("（@src/a.ts")).toEqual({ start: 1, query: "src/a.ts" });
    expect(matchAtTrigger("看“@docs/x”再")).toBeNull();
    expect(matchAtTrigger("《@docs/设计")).toEqual({ start: 1, query: "docs/设计" });
    // 闭合符之后紧跟新的 @ 词：起点换成新的那个
    expect(matchAtTrigger("（@a/b）@c/d")).toEqual({ start: 6, query: "c/d" });
  });

  it("没有开符紧贴的闭合符不结束词：`@src/a）b/` 仍在词内（文件名里真有 `）`）", () => {
    expect(matchAtTrigger("@src/a）b/")).toEqual({ start: 0, query: "src/a）b/" });
    expect(matchSlashTrigger("@src/a）b/")).toBeNull();
    // 开符与闭合符必须配对：`（` 开的词不被 `》` 结束
    expect(matchAtTrigger("（@src/a》b")).toEqual({ start: 1, query: "src/a》b" });
  });

  it("已知取舍（R5 报告列出）：`@src/a.ts…/review` 的 `/` 在 @ 词内——pill 吞到词尾、slash 不弹，两侧口径一致", () => {
    const text = "@src/a.ts…/review";
    expect(matchSlashTrigger(text)).toBeNull();
    expect(parseSkillTokens(text, KNOWN)).toEqual([]);
    expect(findAtFileTokens(text).map((t) => t.path)).toEqual(["src/a.ts…/review"]);
  });

  it("性质（随机语料）：pill 内任意光标位置，触发侧都认为在同一个 @ 词里且起点一致；pill 区间内没有 skill token；解析与旧实现等价", () => {
    const ALPHA = [
      "@", "@", "/", "/", "a", "b", ".", "x", "ts", "他", "组", "（", "）", "《", "》", "“", "”", "「", "」", "…", "—",
      "，", "。", "：", ":", " ", "\n", "review", "plan", "-",
    ];
    const rnd = makeRng(60606);
    let pills = 0;
    let withCloser = 0;
    for (let n = 0; n < 60000; n++) {
      const len = 1 + Math.floor(rnd() * 14);
      let text = "";
      for (let i = 0; i < len; i++) text += ALPHA[Math.floor(rnd() * ALPHA.length)]!;
      const skills = parseSkillTokens(text, KNOWN);
      for (const t of findAtFileTokens(text)) {
        pills += 1;
        if (/[）》”」’】]/.test(text.slice(t.end))) withCloser += 1;
        for (let cursor = t.start + 1; cursor <= t.end; cursor++) {
          const m = matchAtTrigger(text.slice(0, cursor));
          expect(m?.start, `${JSON.stringify(text)} cursor=${cursor}`).toBe(t.start);
        }
        for (const sk of skills) {
          expect(sk.start < t.end && t.start < sk.end, `${JSON.stringify(text)} skill ${sk.start}-${sk.end} pill ${t.start}-${t.end}`).toBe(false);
        }
      }
      // 解析侧线性扫描 ≡ 对每个候选整段重算 isInsideAtWord（旧实现原样复制）
      expect(skills, JSON.stringify(text)).toEqual(parseSkillTokensOld(text, KNOWN));
    }
    expect(pills).toBeGreaterThan(2000);
    expect(withCloser).toBeGreaterThan(100);
  });
});

describe("第八轮 P5-6：「被包起来的 @」的已知边界（既有行为，钉住——要改请连 JSDoc 一起改）", () => {
  it("ASCII 括号不收口：`(@src/a.ts)/review` 里 `)` 不是硬边界，`/review` 算在 @ 词内（slash 不弹，pill 连 `)/review` 一起吞）", () => {
    const t = "(@src/a.ts)/review";
    const before = t.slice(0, t.indexOf("/review"));
    expect(isInsideAtWord(before)).toBe(true);
    expect(matchAtTrigger(before)).toEqual({ start: 1, query: "src/a.ts)" });
    expect(findAtFileTokens(t).map((m) => m.path)).toEqual(["src/a.ts)/review"]);
  });

  it("括号内的第二个 `@` 前面是空格、不是开符，不带闭合符：`（@a/b @c/d）/review` 的第二个 pill 连 `）/review` 一起吞", () => {
    const t = "（@a/b @c/d）/review";
    const before = t.slice(0, t.indexOf("/review"));
    expect(isInsideAtWord(before)).toBe(true);
    expect(findAtFileTokens(t).map((m) => m.path)).toEqual(["a/b", "c/d）/review"]);
  });

  it("对照（全角配对，第六轮行为）：`（@src/a.ts）/review` 在 `）` 处收口，slash 能弹", () => {
    const t = "（@src/a.ts）/review";
    const before = t.slice(0, t.indexOf("/review"));
    expect(isInsideAtWord(before)).toBe(false);
    expect(matchAtTrigger(before)).toBeNull();
    expect(findAtFileTokens(t).map((m) => m.path)).toEqual(["src/a.ts"]);
  });
});
