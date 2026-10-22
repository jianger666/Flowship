/**
 * 输入框 `@` / `/` 触发 → 选中写回 → 再解析：三步一致（第三轮 review R6-02 / R6-03 / R6-06）
 *
 * 背景：
 * - R6-02：`/` 允许 CJK 前缀后，`@src/组件/` 同时命中 `@` 触发和 slash 触发（`start:7` 空 query），
 *   slash 优先，Enter / Tab 选中的是 skill、路径里的 `/` 被静默换成 `/skill-name `。
 *   → `@` 词内的 `/` 属于路径，不当 slash（触发侧、解析侧同口径）。
 * - R6-03：`parseSkillTokens("他/她/plan x")` 返回 `[]`，而 `matchSlashTrigger("他/她/plan")` 命中——
 *   候选「她」没命中 skill，却已把「她」消费成前缀位，后面紧贴的 `/plan` 没了前缀；
 *   菜单弹出并选中后 pill 不生成、发送时 skills 为空（审查在 8 万条随机语料里复现 1050 例）。
 *   → 未命中的候选同样把 lastIndex 回拨到候选末字。
 * - R6-06：CJK 前缀 + 空 query 不展开 8 项（「前端/UI」「增/删/改」刚打 `/` 就弹菜单、收尾 Enter 被吞）。
 *
 * 这里用确定性随机语料（固定种子）把三条性质锁死，而不是只测几个手写例子：
 *   P1 触发 → 选中写回 → 再解析：必须还原出同一个 token（菜单选了不能是个寂寞）；
 *   P2 解析出的每个 token，都必须是触发侧也认的（解析不能比触发宽）；
 *   P3 `@` 触发与 `/` 触发互斥（同一个词不会同时弹两个菜单）；
 *   P4 skill token 与 `@path` pill 的区间不重叠。
 * 每条性质都断言「语料确实触发过足够多次」，防止语料太稀、性质空转。
 */
import { describe, expect, it } from "vitest";

import {
  findAtFileTokens,
  isInsideAtWord,
  matchAtTrigger,
} from "@/lib/composer-trigger";
import {
  matchSlashMenuTrigger,
  matchSlashTrigger,
  parseSkillTokens,
} from "@/lib/skill-token";

/** 确定性 PRNG（mulberry32）：失败可复现 */
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

// 中英文 / 邮箱 / 路径 / 多个 @ 与 / / 全角 / 换行 / 冒号 / 已知 skill 名片段（`/` `@` 与 CJK 故意放得密）
const ALPHABET = [
  "a", "b", "e", "r", "x",
  "/", "/", "/", "/", "@", "@", "@",
  " ", "\n", ":", ".", "-", "_", "1",
  "他", "她", "设", "计", "组", "件", "文", "档", "评", "审",
  "，", "。", "（", "）", "＠", "／",
  "review", "plan", "写代码", "读", "x.y",
  "src", "docs",
] as const;

const KNOWN = new Set(["review", "plan", "写代码", "读", "x.y", "x"]);
const KNOWN_LIST = [...KNOWN];
/** 打到一半的 query 片段（含空） */
const QUERY_TAILS = ["", "", "p", "pl", "plan", "re", "review", "写", "读", "写代码", "x", "未知"];

const genText = (rnd: () => number, maxPieces: number): string => {
  const n = 1 + Math.floor(rnd() * maxPieces);
  let s = "";
  for (let i = 0; i < n; i += 1) {
    s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
  }
  return s;
};

/** 光标前文：一段随机文本 + （大概率）一个「正在打的 `/query`」尾巴，保证触发能被足量覆盖 */
const genBefore = (rnd: () => number): string => {
  const head = genText(rnd, 8);
  if (rnd() < 0.15) return head;
  return `${head}/${QUERY_TAILS[Math.floor(rnd() * QUERY_TAILS.length)]!}`;
};

const CORPUS_SIZE = 40_000;

describe("R6-02：@ 词内的 `/` 不当 slash", () => {
  it("审查报告的原始反例：@src/组件/、@docs/设计/but、请看@文档/ 都不再触发 slash", () => {
    // 修前：{start:7,query:""} / {start:8,query:"but"} / {start:5,query:""}
    expect(matchSlashTrigger("@src/组件/")).toBeNull();
    expect(matchSlashTrigger("@docs/设计/but")).toBeNull();
    expect(matchSlashTrigger("请看@文档/")).toBeNull();
    // 同一串仍是 @ 触发（路径下钻的菜单是它的）
    expect(matchAtTrigger("@src/组件/")).toEqual({ start: 0, query: "src/组件/" });
    expect(matchAtTrigger("请看@文档/")).toEqual({ start: 2, query: "文档/" });
  });

  it("@ 词结束（空白 / 冒号）之后新词里的 `/` 照常触发", () => {
    expect(matchSlashTrigger("@src/a.ts /rev")).toEqual({ start: 10, query: "rev" });
    expect(matchSlashTrigger("@src/组件/x.ts\n/rev")).toEqual({ start: 13, query: "rev" });
    expect(matchSlashTrigger("@src/组件 好的，/rev")).toEqual({ start: 11, query: "rev" });
  });

  it("邮箱里的 @ 不是 @ 触发（不会连带吞掉后面中文里的 slash）", () => {
    expect(matchAtTrigger("a@b.com组件/")).toBeNull();
    expect(matchSlashTrigger("a@b.com组件/re")).toEqual({ start: 9, query: "re" });
  });

  it("不退化：纯中文行文里的 slash 触发（V5-06 主诉求）照旧", () => {
    expect(matchSlashTrigger("帮我看下/wr")).toEqual({ start: 4, query: "wr" });
    expect(matchSlashTrigger("好的，/写")).toEqual({ start: 3, query: "写" });
    expect(matchSlashTrigger("/")).toEqual({ start: 0, query: "" });
  });

  it("isInsideAtWord：与 matchAtTrigger 同口径（光标所在词内有满足边界的 @）", () => {
    expect(isInsideAtWord("@src/组件")).toBe(true);
    expect(isInsideAtWord("看下@src")).toBe(true);
    expect(isInsideAtWord("a@b.com")).toBe(false);
    expect(isInsideAtWord("@src/a.ts ")).toBe(false);
    expect(isInsideAtWord("")).toBe(false);
  });

  it("解析侧同口径：@ 路径里恰好叫 review 的目录不会变成 skill token", () => {
    expect(parseSkillTokens("@src/组件/review x", KNOWN)).toEqual([]);
    expect(parseSkillTokens("看下@docs/设计/plan", KNOWN)).toEqual([]);
    // 词结束之后的才是 token
    expect(parseSkillTokens("@src/a.ts /review", KNOWN)).toEqual([
      { start: 10, end: 17, name: "review" },
    ]);
  });
});

describe("R6-03：未命中的候选以中文收尾时，紧贴的 /skill 仍要能解析", () => {
  it("审查报告的原始反例：他/她/plan x、看下/设计/review 、/评审/review 都能解析出 token", () => {
    expect(parseSkillTokens("他/她/plan x", KNOWN)).toEqual([
      { start: 3, end: 8, name: "plan" },
    ]);
    expect(parseSkillTokens("看下/设计/review ", KNOWN)).toEqual([
      { start: 5, end: 12, name: "review" },
    ]);
    expect(parseSkillTokens("/评审/review ", KNOWN)).toEqual([
      { start: 3, end: 10, name: "review" },
    ]);
  });

  it("连续多个未命中候选后面的 token 也不丢", () => {
    expect(parseSkillTokens("增/删/改/读", KNOWN)).toEqual([
      { start: 5, end: 7, name: "读" },
    ]);
  });

  it("英文未命中候选不会被回拨成「重复命中」或死循环", () => {
    expect(parseSkillTokens("src/app/review", KNOWN)).toEqual([]);
    expect(parseSkillTokens("/a/b/c/d", KNOWN)).toEqual([]);
    expect(parseSkillTokens("/", KNOWN)).toEqual([]);
    expect(parseSkillTokens("//", KNOWN)).toEqual([]);
  });
});

describe("R6-06：CJK 前缀 + 空 query 不展开菜单", () => {
  it("紧贴中文 / 全角标点的空 query：触发判定仍认（V5-06），但菜单不弹", () => {
    for (const s of ["前端/", "增/删/", "先试试/", "好的，/", "（/"]) {
      expect(matchSlashTrigger(s), s).not.toBeNull();
      expect(matchSlashMenuTrigger(s), s).toBeNull();
    }
  });

  it("紧贴中文但已经有 query：照常弹（「帮我看下/wr」）", () => {
    expect(matchSlashMenuTrigger("帮我看下/wr")).toEqual({ start: 4, query: "wr" });
    expect(matchSlashMenuTrigger("好的，/写")).toEqual({ start: 3, query: "写" });
  });

  it("行首 / 空白后 / 换行后的空 query 照旧展开（发现 skill 的主入口，不能动）", () => {
    expect(matchSlashMenuTrigger("/")).toEqual({ start: 0, query: "" });
    expect(matchSlashMenuTrigger("请用 /")).toEqual({ start: 3, query: "" });
    expect(matchSlashMenuTrigger("第一行\n/")).toEqual({ start: 4, query: "" });
    expect(matchSlashMenuTrigger("a\u3000/")).toEqual({ start: 2, query: "" });
  });

  it("没有 slash 触发就没有菜单触发", () => {
    expect(matchSlashMenuTrigger("src/app")).toBeNull();
    expect(matchSlashMenuTrigger("@src/组件/")).toBeNull();
  });
});

describe("随机语料性质：触发 → 选中写回 → 再解析（固定种子，失败可复现）", () => {
  it("P1：只要 matchSlashTrigger 命中，选中任一 skill 写回后再解析，必须还原出这个 token", () => {
    const rnd = makeRng(20261021);
    let triggered = 0;
    const failures: string[] = [];
    for (let i = 0; i < CORPUS_SIZE; i += 1) {
      const before = genBefore(rnd);
      // 光标后面还有一段随机正文（模拟在中间改）
      const rest = rnd() < 0.5 ? "" : genText(rnd, 4);
      const text = `${before}${rest}`;
      const cursor = before.length;
      const m = matchSlashTrigger(before);
      if (!m) continue;
      triggered += 1;
      const skill = KNOWN_LIST[Math.floor(rnd() * KNOWN_LIST.length)]!;
      // 与 composer-editor.$replaceSlashPartialWithToken 同一个写回：切掉 `/partial`，换成 `/skill `
      const next = `${text.slice(0, m.start)}/${skill} ${text.slice(cursor)}`;
      const hit = parseSkillTokens(next, KNOWN).find((t) => t.start === m.start);
      if (!hit || hit.name !== skill || hit.end !== m.start + 1 + skill.length) {
        failures.push(JSON.stringify({ text, cursor, skill, next }));
        if (failures.length >= 5) break;
      }
    }
    // 语料确实触发过足够多次（防止性质空转）
    expect(triggered).toBeGreaterThan(3000);
    expect(failures).toEqual([]);
  });

  it("P2：解析出的每个 token，触发侧在它末尾也认（解析不比触发宽）", () => {
    const rnd = makeRng(777);
    let tokens = 0;
    const failures: string[] = [];
    for (let i = 0; i < CORPUS_SIZE; i += 1) {
      const text = genText(rnd, 12);
      for (const t of parseSkillTokens(text, KNOWN)) {
        tokens += 1;
        const m = matchSlashTrigger(text.slice(0, t.end));
        if (!m || m.start !== t.start || m.query !== t.name) {
          failures.push(JSON.stringify({ text, token: t, trigger: m }));
        }
      }
      if (failures.length >= 5) break;
    }
    expect(tokens).toBeGreaterThan(1000);
    expect(failures).toEqual([]);
  });

  it("P3：同一个光标前文，@ 触发与 / 触发互斥（不会同时弹两个菜单）", () => {
    const rnd = makeRng(4242);
    let atHits = 0;
    let slashHits = 0;
    const failures: string[] = [];
    for (let i = 0; i < CORPUS_SIZE; i += 1) {
      const before = genBefore(rnd);
      const at = matchAtTrigger(before);
      const slash = matchSlashTrigger(before);
      if (at && slash) failures.push(JSON.stringify({ before, at, slash }));
      if (at) atHits += 1;
      if (slash) slashHits += 1;
      if (failures.length >= 5) break;
    }
    expect(atHits).toBeGreaterThan(3000);
    expect(slashHits).toBeGreaterThan(3000);
    expect(failures).toEqual([]);
  });

  it("P4：skill token 与 @path pill 的区间不重叠（composer-editor 靠区间排序消重，不能靠运气）", () => {
    const rnd = makeRng(99);
    let both = 0;
    const failures: string[] = [];
    for (let i = 0; i < CORPUS_SIZE; i += 1) {
      const text = genBefore(rnd) + genText(rnd, 4);
      const skills = parseSkillTokens(text, KNOWN);
      const files = findAtFileTokens(text);
      if (skills.length > 0 && files.length > 0) both += 1;
      for (const s of skills) {
        for (const f of files) {
          if (s.start < f.end && f.start < s.end) {
            failures.push(JSON.stringify({ text, skill: s, file: f }));
          }
        }
      }
      if (failures.length >= 5) break;
    }
    expect(both).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  });
});
