/**
 * 第八轮 review（测试质量）：`foldWithMap`（group-reply-protocol 里「NFKC + 去 Cf 的逐码点折叠 + 折叠后下标 → 原文区间的映射」）
 * 没有种子 fuzz，也没有「全角化 / 插零宽变形后应与 ASCII 版一致」的元测试。
 *
 * 两层：
 * 1. **不变量**：对随机码点串（混进会展开 / 折叠 / 删除 / 代理对 / 落单代理 / 组合字符）直接断言 `__foldWithMapForTest` 的输出——
 *    折叠文本 = 独立写的逐码点预言；映射长度 / 单调 / 每组区间单独折叠回本组字符。
 * 2. **元测试（变形一致性）**：从「需属主确认」标记的 ASCII 写法出发，把括号 / 冒号 / 空白随机换成全角或兼容形态、在随机位置插零宽（Cf）字符，
 *    经 `stripNeedsOwnerMarkers` / `parseGroupReply` 解析，说明与剥完的正文必须与 ASCII 版一致
 *    （零宽只插在标记内部和紧贴两侧时，剥完的正文与 ASCII 版逐字一致）。
 *
 * 伪随机种子固定（mulberry32，纯整数运算）、条数有上限、不依赖耗时。
 * 预期以实际代码为准：关键词「需属主确认」是汉字，NFKC 对 CJK 统一表意文字恒等、没有全角形态——运行时扫一遍兼容表意文字 / 康熙部首，
 * 有能 NFKC 到这五个字的就用上，没有就只做零宽变形。
 */
import { describe, expect, it } from "vitest";

import type { GroupMember } from "@/lib/server/feishu-bridge/group-contract";
import {
  __closedFenceLineSpansForTest,
  __foldWithMapForTest,
  parseGroupReply,
  stripNeedsOwnerMarkers,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
  { openId: "ou_self", name: "Flowship机器人", kind: "bot" },
];

const mk = (): ParseGroupReplyCtx => ({
  members,
  owner: { openId: "ou_owner", name: "曾进有" },
  requester: { openId: "ou_anruo", name: "安若流年", isBot: true },
  selfOpenId: "ou_self",
});

const strip = (raw: string) => {
  const explains: string[] = [];
  const r = stripNeedsOwnerMarkers(raw, (e) => explains.push(e));
  return { ...r, explains };
};

/** mulberry32：种子固定、纯整数运算，跨平台结果一致 */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

/** 格式控制字符（\p{Cf}）池：ZWSP / ZWNJ / ZWJ / BOM / WORD JOINER / 软连字符 / bidi 控制 / 两个非 BMP 的 Cf（代理对） */
const CF_POOL = [
  "\u200b",
  "\u200c",
  "\u200d",
  "\ufeff",
  "\u2060",
  "\u00ad",
  "\u200e",
  "\u202e",
  "\u{e0041}",
  "\u{1d173}",
] as const;

const CF_RE = /\p{Cf}+/gu;
const stripCf = (s: string): string => s.replace(CF_RE, "");

describe("元测试自检 · 池子没写错（防 fuzz 空转）", () => {
  it("CF_POOL 里的每个字符都匹配 \\p{Cf}", () => {
    for (const c of CF_POOL) expect(/^\p{Cf}$/u.test(c), JSON.stringify(c)).toBe(true);
  });
});

describe("foldWithMap 不变量（种子 fuzz）", () => {
  // 刻意混进会展开 / 会折叠 / 会删除 / 成对（代理对）/ 落单代理 / 组合字符的各类码点
  const POOL = [
    "a", "Z", "0", " ", "\n", "[", "]", "【", "】", ":", "：", "需", "属", "主", "确", "认",
    "［", "］", "　", "…", "㈱", "①", "ﬁ", "ａ", "Ｑ", "😀", "𝐀", "\u0301", "\ud83d", "\ude00",
    ...CF_POOL,
  ] as const;
  const CASES = 600;

  it(`随机 ${CASES} 串：折叠文本 = 独立的逐码点预言；映射长度 / 单调 / 每组区间单独折叠回本组字符`, () => {
    const r = rng(0x1ee7f01d);
    for (let c = 0; c < CASES; c++) {
      const len = Math.floor(r() * 24);
      let s = "";
      for (let k = 0; k < len; k++) s += pick(r, POOL);
      const fo = __foldWithMapForTest(s);
      const label = JSON.stringify(s);

      // 独立预言：逐码点 NFKC + 去 Cf（Array.from 对落单代理给出单个码元，与 codePointAt 同口径）
      const expected = Array.from(s)
        .map((ch) => stripCf(ch.normalize("NFKC")))
        .join("");
      expect(fo.text, label).toBe(expected);

      if (fo.map === null) {
        // 恒等折叠（整串 NFKC + 去 Cf 后与原文相同）才没有映射
        expect(fo.text, label).toBe(s);
        expect(stripCf(s.normalize("NFKC")), label).toBe(s);
        continue;
      }
      const { start, end } = fo.map;
      expect(start.length, label).toBe(fo.text.length);
      expect(end.length, label).toBe(fo.text.length);
      for (let k = 0; k < start.length; k++) {
        expect(start[k], label).toBeGreaterThanOrEqual(0);
        expect(end[k], label).toBeGreaterThan(start[k]);
        expect(end[k], label).toBeLessThanOrEqual(s.length);
        if (k > 0) {
          expect(start[k], label).toBeGreaterThanOrEqual(start[k - 1]);
          expect(end[k], label).toBeGreaterThanOrEqual(end[k - 1]);
        }
      }
      // 同一组（同一个起点）= 同一个原文码点折叠出来的所有字符：把这段原文单独折叠，必须正好得到这一组字符
      for (let k = 0; k < start.length; ) {
        let j = k;
        while (j < start.length && start[j] === start[k]) j++;
        expect(stripCf(s.slice(start[k], end[k]).normalize("NFKC")), `${label} @${k}`).toBe(
          fo.text.slice(k, j),
        );
        expect(end[j - 1], label).toBe(end[k]);
        k = j;
      }
    }
  });

  it("纯 ASCII / 汉字（NFKC 恒等、不含 Cf）不建映射：下标恒等", () => {
    // （注意冒号 / 逗号用 ASCII：全角 `：` `，`（U+FF1A / U+FF0C）的 NFKC 是 `:` `,`，它们会建映射）
    for (const s of ["", "abc", "需属主确认:x", "[[需属主确认:好的]]\n后文", "好的,收到。"]) {
      const fo = __foldWithMapForTest(s);
      expect(fo.map).toBeNull();
      expect(fo.text).toBe(s);
    }
  });
});

describe("foldWithMap 元测试 · 全角化 / 插零宽变形后的标记，解析结果与 ASCII 写法一致（种子 fuzz）", () => {
  /** 一个结构单元：ascii 写法 + 它的等价变体（NFKC + 去 Cf 之后与 ascii 相同，解析上等价） */
  interface Unit {
    ascii: string;
    variants: readonly string[];
  }

  const compatOf = (target: string): string[] => {
    const out: string[] = [];
    const ranges: Array<[number, number]> = [
      [0x2f00, 0x2fd5], // 康熙部首
      [0xf900, 0xfaff], // CJK 兼容表意文字
      [0x2f800, 0x2fa1d], // CJK 兼容表意文字补充
    ];
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        const ch = String.fromCodePoint(cp);
        if (ch !== target && ch.normalize("NFKC") === target) out.push(ch);
      }
    }
    return out;
  };
  const keyword: Unit[] = ["需", "属", "主", "确", "认"].map((k) => ({
    ascii: k,
    variants: [k, ...compatOf(k)],
  }));

  const colon: Unit = { ascii: ":", variants: [":", "：", "﹕"] }; // U+FF1A / U+FE55 的 NFKC 都是 ":"
  const space: Unit = { ascii: " ", variants: [" ", "\u3000", "\u00a0"] };
  const open1: Unit = { ascii: "[", variants: ["[", "［"] };
  const close1: Unit = { ascii: "]", variants: ["]", "］"] };
  const fixed = (s: string): Unit => ({ ascii: s, variants: [s] });

  /** 说明里的片段：ASCII / 汉字 / 会展开的字符 / 代理对 / 组合字符 / 一对配平的方括号（不含孤立括号，免得牵动配平回退） */
  const EXPLAIN_POOL = [
    "要", "不", "上", "线", "a", "b", "Z", "0", "9", " ", "，", "的", "…", "㈱", "①", "ﬁ", "😀", "𝐀", "e\u0301", "a[0]",
  ] as const;
  const PREFIXES = ["", "好的\n", "前文 ", "👨\u200d👩\u200d👧 ", "a…㈱ ", "说明如下：\n", "𝐀😀 ", "ｘ\n"] as const;
  const SUFFIXES = ["", "\n后文", " 尾巴", "\n\n另一段 ㈱", "…", "\n😀"] as const;

  interface Marker {
    head: Unit[];
    close: Unit[];
    explain: string;
  }

  const buildMarker = (r: () => number): Marker => {
    const square = r() < 0.7;
    const head: Unit[] = square ? [open1, open1] : [fixed("【")];
    if (r() < 0.3) head.push(space);
    head.push(...keyword);
    if (r() < 0.3) head.push(space);
    head.push(colon);
    const n = Math.floor(r() * 7); // 0 = 空说明
    let explain = "";
    for (let i = 0; i < n; i++) explain += pick(r, EXPLAIN_POOL);
    const close: Unit[] = square ? [close1, close1] : [fixed("】")];
    return { head, close, explain };
  };

  // 说明**内部**的零宽字符池：去掉 U+FEFF。JS 的 `\s` 匹配 U+FEFF，`normalizeSpaces`（needsOwner 的后处理）会把说明里的 BOM
  // 压成一个空格（实测：说明 `😀\ufeff㈱` → needsOwner `😀 ㈱`）——这是后处理的既有行为、与位置映射无关，所以说明内部不取它；
  // 它在标记的结构位置（说明之外）照常出现、不受影响。
  const INNER_CF_POOL = CF_POOL.filter((c) => !/\s/.test(c));

  const sprinkle = (text: string, r: () => number): string => {
    let s = "";
    for (const ch of Array.from(text)) {
      s += ch;
      if (r() < 0.25) s += pick(r, INNER_CF_POOL);
    }
    return s;
  };

  /**
   * ascii：每个单元取 ascii、不插零宽（`r` 不会被调用）；
   * structural：每个单元随机取变体，单元之前 / 冒号之后 / 标记收尾之后随机插零宽——零宽只在标记的结构位置；
   * anywhere：在 structural 的基础上，说明内部也随机插零宽。
   */
  const render = (m: Marker, mode: "ascii" | "structural" | "anywhere", r: () => number): string => {
    const zw = (p: number): string => (r() < p ? pick(r, CF_POOL) : "");
    const emit = (units: Unit[]): string =>
      units
        .map((u, i) =>
          mode === "ascii"
            ? u.ascii
            : zw(0.25) + pick(r, u.variants) + (i === units.length - 1 ? zw(0.5) : ""),
        )
        .join("");
    const explain = mode === "anywhere" ? sprinkle(m.explain, r) : m.explain;
    return emit(m.head) + explain + emit(m.close);
  };

  const CASES = 220;
  const never = (): number => {
    throw new Error("ascii 模式不该取随机数");
  };

  it("元测试自检：变体确实被变形过、ASCII 版确实触发了标记（不是每条都等于 ASCII 版 / 都不触发）", () => {
    const r = rng(0xc0ffee);
    let differing = 0;
    let withCf = 0;
    let withFullwidth = 0;
    let triggered = 0;
    for (let c = 0; c < CASES; c++) {
      const m = buildMarker(r);
      const ascii = render(m, "ascii", never);
      const variant = render(m, "structural", rng(1000 + c));
      if (variant !== ascii) differing++;
      if (/\p{Cf}/u.test(variant)) withCf++;
      if (/[［］：]/.test(variant)) withFullwidth++;
      if (strip(ascii).found) triggered++;
    }
    expect(differing).toBeGreaterThan(CASES * 0.8);
    expect(withCf).toBeGreaterThan(CASES * 0.5);
    expect(withFullwidth).toBeGreaterThan(CASES * 0.3);
    expect(triggered).toBe(CASES);
  });

  for (const mode of ["structural", "anywhere"] as const) {
    it(`${
      mode === "structural"
        ? "零宽只插在标记的结构位置（括号 / 关键词 / 冒号之间、冒号后、标记后）"
        : "零宽还插进说明内部"
    }：说明与剥完的正文与 ASCII 版一致（${CASES} 条）`, () => {
      const r = rng(mode === "structural" ? 0x5eed0001 : 0x5eed0002);
      for (let c = 0; c < CASES; c++) {
        const m = buildMarker(r);
        const prefix = pick(r, PREFIXES);
        const suffix = pick(r, SUFFIXES);
        const second = r() < 0.3 ? `\n中间 ㈱ ${render(buildMarker(r), "ascii", never)}` : "";
        const asciiRaw = `${prefix}${render(m, "ascii", never)}${second}${suffix}`;
        const variantRaw = `${prefix}${render(m, mode, rng(77 + c))}${second}${suffix}`;

        const a = strip(asciiRaw);
        const v = strip(variantRaw);
        const label = `#${c} ${JSON.stringify(variantRaw)}`;

        expect(v.found, label).toBe(a.found);
        // 说明取的是原文：structural 时一字不差；anywhere 时说明内部的零宽字符原样在内，去掉 Cf 后一致
        expect(v.explains.map(stripCf), label).toEqual(a.explains.map(stripCf));
        if (mode === "structural") expect(v.explains, label).toEqual(a.explains);
        // 剥完的正文：标记被整段剪掉（连同紧贴两侧的零宽），其余一字不动 → 与 ASCII 版逐字一致
        expect(v.text, label).toBe(a.text);

        // 全链路：needsOwner 与 ASCII 版一致
        const pa = parseGroupReply(asciiRaw, mk());
        const pv = parseGroupReply(variantRaw, mk());
        expect(pv.kind, label).toBe(pa.kind);
        if (mode === "structural") {
          expect(pv.needsOwner, label).toBe(pa.needsOwner);
          expect(pv.text, label).toBe(pa.text);
        } else {
          // anywhere：needsOwner 经过 normalizeSpaces（压空白）——说明内部被 Cf 隔开的两个空格不会被合并，
          // 所以事后「去 Cf + 压空白」再比（这是后处理的口径差，不是位置映射问题）
          const norm = (s: string | undefined): string | undefined =>
            s === undefined ? undefined : stripCf(s).replace(/\s+/g, " ").trim();
          expect(norm(pv.needsOwner), label).toBe(norm(pa.needsOwner));
        }
      }
    });
  }

  it("正文里的零宽字符（不紧贴标记）原样保留：只有标记内部和紧贴两侧的会被剪掉", () => {
    const r = rng(0xbeef);
    for (let c = 0; c < 80; c++) {
      const m = buildMarker(r);
      const marker = render(m, "structural", rng(5 + c));
      const before = `前\u200b文${pick(r, CF_POOL)}段 `; // 末尾是普通空格：零宽夹在正文中间、不紧贴标记
      const after = ` 后${pick(r, CF_POOL)}文\u200d尾`;
      const v = strip(`${before}${marker}${after}`);
      expect(v.found, JSON.stringify(marker)).toBe(true);
      expect(v.text, JSON.stringify(marker)).toBe(`${before}${after}`);
    }
  });
});

describe("closedFenceLineSpans（L4-05 的闭合围栏判定）· 与朴素二次型预言对拍（种子 fuzz）", () => {
  // 预言：按定义写——起行之后逐行向后找第一个止行，找到才算围栏、扫过的行不再当起行；找不到这一行当普通行。最坏二次型，只用于短输入
  const FENCE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
  const oracle = (lines: readonly string[]): number[] => {
    const spans: number[] = [];
    for (let i = 0; i < lines.length; ) {
      const f = FENCE.exec(lines[i]);
      if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
        let j = i + 1;
        for (; j < lines.length; j++) {
          const g = FENCE.exec(lines[j]);
          if (g && g[1][0] === f[1][0] && g[1].length >= f[1].length && g[2].trim() === "") break;
        }
        if (j < lines.length) {
          spans.push(i, j);
          i = j + 1;
          continue;
        }
      }
      i++;
    }
    return spans;
  };

  // 各种长度 / 符号 / 缩进 / info string / 行内代码 / 普通行 / 空行
  const LINES = [
    "```", "```a", "``` ", "````", "`````", "~~~", "~~~b", "~~~~", "   ```", "    ```", "   ~~~", "~~~ x", "``` y ```", "```x```",
    "`x`", "x", "", "  ", "[[需属主确认：z]]", "NO_REPLY", "``", "~~",
  ] as const;
  const CASES = 800;

  it(`随机 ${CASES} 份「行汤」：每份 1–16 行，spans 与预言逐项一致`, () => {
    const r = rng(0xfe11ce);
    let withSpans = 0;
    let withUnclosedOpener = 0;
    for (let c = 0; c < CASES; c++) {
      const n = 1 + Math.floor(r() * 16);
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(pick(r, LINES));
      const got = __closedFenceLineSpansForTest(lines);
      const want = oracle(lines);
      expect(got, JSON.stringify(lines)).toEqual(want);
      if (want.length > 0) withSpans++;
      // 自检用：有起行形态的行、却没成为任何围栏的起行 = 出现过「未闭合的起行」
      const openers = lines.filter((l) => {
        const f = FENCE.exec(l);
        return f && !(f[1][0] === "`" && f[2].includes("`"));
      }).length;
      if (openers > 0 && want.length / 2 < openers) withUnclosedOpener++;
    }
    // 自检：预言对拍不是空转——一半以上的输入里真有闭合的围栏，也有相当数量的输入里出现了未闭合的起行
    expect(withSpans).toBeGreaterThan(CASES * 0.4);
    expect(withUnclosedOpener).toBeGreaterThan(CASES * 0.2);
  });
});
