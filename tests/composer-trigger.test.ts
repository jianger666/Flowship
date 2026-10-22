/**
 * 输入框 `/`、`@` 触发口径（第二轮 review V5-06）
 *
 * 旧口径：`/` 与 `@` 都必须在行首 / 空白后——「帮我看下@src/app.ts」「先试试/review」紧贴中文不弹，
 * 且没有任何提示；而 skill 解析侧对「/name 后紧贴中文正文」本就宽松，两边口径不一致。
 *
 * 新口径（单一来源：lib/composer-trigger.ts + lib/skill-token.ts）：
 * - `@`：任意位置触发；前一字符是 ASCII 字母数字 / `._%+-` 视为邮箱前缀不触发；
 *   前一字符是 `/` `\` 视为路径中段（`x.com/@user`、`src/@types`）也不触发。
 * - `/`：只在行首、空白后、或 CJK / 全角标点后触发；URL / 路径里的 `/`
 *   （前一字符是 ASCII 字母数字、`.`、`:`、`/`、`~` 等）一律不触发。
 * - 触发（菜单）与解析（token / pill 还原）同口径——否则选中后写回草稿再还原，token 会丢，
 *   发送时 skillRefs 也跟着丢。
 *
 * 纯函数测试（UI 在 node 下跑不起来，见 vitest.config.ts）+ 接线源码契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findAtFileTokens,
  isAtBoundaryChar,
  isSlashBoundaryChar,
  matchAtTrigger,
} from "@/lib/composer-trigger";
import {
  matchSlashTrigger,
  parseSkillTokens,
  SKILL_TOKEN_RE,
  SLASH_RE,
} from "@/lib/skill-token";

const readSrc = (...seg: string[]): string =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "src", ...seg),
    "utf-8",
  );

describe("isSlashBoundaryChar：`/` 前一字符", () => {
  it("行首（空串）、空白、CJK、全角标点、日韩文 → 可触发", () => {
    for (const ch of [
      "",
      " ",
      "\n",
      "\t",
      "\u3000", // 全角空格
      "帮",
      "，",
      "。",
      "（",
      "：",
      "“",
      "”",
      "…",
      "—",
      "あ",
      "ア",
      "한",
    ]) {
      expect(isSlashBoundaryChar(ch), JSON.stringify(ch)).toBe(true);
    }
  });

  it("ASCII 字母数字、. : / ~ 与其它 ASCII 标点 → 不触发（URL / 路径 / 分数）", () => {
    for (const ch of [
      "a",
      "Z",
      "0",
      "_",
      "-",
      ".",
      ":",
      "/",
      "~",
      "\\",
      "(",
      '"',
      "'",
      "[",
      "=",
      "@",
      "#",
    ]) {
      expect(isSlashBoundaryChar(ch), JSON.stringify(ch)).toBe(false);
    }
  });
});

describe("isAtBoundaryChar：`@` 前一字符", () => {
  it("行首 / 空白 / CJK / 全角标点 / ASCII 标点（括号、引号、等号、逗号…）→ 可触发", () => {
    for (const ch of [
      "",
      " ",
      "\n",
      "帮",
      "，",
      "（",
      "(",
      '"',
      "'",
      "=",
      ",",
      ";",
      ":",
      "#",
      "[",
      ">",
    ]) {
      expect(isAtBoundaryChar(ch), JSON.stringify(ch)).toBe(true);
    }
  });

  it("ASCII 字母数字、`._%+-` → 邮箱前缀、不触发", () => {
    for (const ch of ["a", "Z", "0", "9", ".", "_", "%", "+", "-"]) {
      expect(isAtBoundaryChar(ch), JSON.stringify(ch)).toBe(false);
    }
  });

  it("`/` `\\` → 路径中段（x.com/@user、src/@types）也不触发", () => {
    expect(isAtBoundaryChar("/")).toBe(false);
    expect(isAtBoundaryChar("\\")).toBe(false);
  });
});

describe("matchSlashTrigger / SLASH_RE：触发判定", () => {
  it("行首 / 空白后 / 换行后（旧口径不退化）", () => {
    expect(matchSlashTrigger("/")).toEqual({ start: 0, query: "" });
    expect(matchSlashTrigger("/wr")).toEqual({ start: 0, query: "wr" });
    expect(matchSlashTrigger("请用 /rev")).toEqual({ start: 3, query: "rev" });
    expect(matchSlashTrigger("第一行\n/rev")).toEqual({
      start: 4,
      query: "rev",
    });
  });

  it("紧贴中文 / 全角标点后也触发（V5-06 主诉求）", () => {
    expect(matchSlashTrigger("帮我看下/wr")).toEqual({ start: 4, query: "wr" });
    expect(matchSlashTrigger("先试试/")).toEqual({ start: 3, query: "" });
    expect(matchSlashTrigger("好的，/写")).toEqual({ start: 3, query: "写" });
    expect(matchSlashTrigger("（/rev")).toEqual({ start: 1, query: "rev" });
    expect(matchSlashTrigger("他说：/rev")).toEqual({ start: 3, query: "rev" });
    expect(matchSlashTrigger("“/rev")).toEqual({ start: 1, query: "rev" });
  });

  it("URL / 路径 / 分数里的 `/` 绝不触发", () => {
    const negatives = [
      "https://a.com/b",
      "https://a.com/",
      "https://",
      "http://localhost:3000/api/x",
      "file:///etc/hosts",
      "src/app",
      "src/app/",
      "./foo",
      "../x",
      "~/x",
      "~/",
      "/usr/bin",
      "a/b/c",
      "C:/Users/me",
      "10/20",
      "foo.bar/baz",
      "v1.2/",
      "a-b/c",
      "foo_bar/",
      "看下src/app",
      "看下https://a.com/b",
      "(/foo",
    ];
    for (const s of negatives) {
      expect(matchSlashTrigger(s), s).toBeNull();
      expect(SLASH_RE.test(s), s).toBe(false);
    }
  });

  it("中文里的 `和/或` 会触发（口径内的已知取舍），但只在有同名 skill 候选时才会真弹菜单", () => {
    expect(matchSlashTrigger("是/否")).toEqual({ start: 1, query: "否" });
  });

  it("SLASH_RE 与 matchSlashTrigger 同口径：m[2] = query", () => {
    expect("帮我/写".match(SLASH_RE)?.[2]).toBe("写");
    expect("请用 /perf-audit".match(SLASH_RE)?.[2]).toBe("perf-audit");
    expect("src/app".match(SLASH_RE)).toBeNull();
  });
});

describe("matchAtTrigger：`@` 触发判定", () => {
  it("行首 / 空白后 / 换行后（旧口径不退化）", () => {
    expect(matchAtTrigger("@")).toEqual({ start: 0, query: "" });
    expect(matchAtTrigger("@But")).toEqual({ start: 0, query: "But" });
    expect(matchAtTrigger("看看 @src/ap")).toEqual({
      start: 3,
      query: "src/ap",
    });
    expect(matchAtTrigger("第一行\n@x")).toEqual({ start: 4, query: "x" });
    expect(matchAtTrigger("a\u3000@x")).toEqual({ start: 2, query: "x" });
  });

  it("紧贴中文 / 全角标点 / ASCII 标点后也触发（V5-06 主诉求）", () => {
    expect(matchAtTrigger("帮我看下@src/app.ts")).toEqual({
      start: 4,
      query: "src/app.ts",
    });
    expect(matchAtTrigger("看看，@But")).toEqual({ start: 3, query: "But" });
    expect(matchAtTrigger("(@foo")).toEqual({ start: 1, query: "foo" });
    expect(matchAtTrigger('"@foo')).toEqual({ start: 1, query: "foo" });
    expect(matchAtTrigger("path=@foo")).toEqual({ start: 5, query: "foo" });
  });

  it("邮箱前缀不触发：前一字符是 ASCII 字母数字 / ._%+-", () => {
    const negatives = [
      "foo@bar.com",
      "foo@",
      "a.b+c@gmail",
      "user_name%x@host",
      "foo-@bar",
      "1@x",
      "联系 me@x.io",
      "联系foo@bar.com",
    ];
    for (const s of negatives) {
      expect(matchAtTrigger(s), s).toBeNull();
    }
  });

  it("路径中段的 @ 不触发（x.com/@user、src/@types、反斜杠）", () => {
    expect(matchAtTrigger("https://x.com/@user")).toBeNull();
    expect(matchAtTrigger("node_modules/@types/")).toBeNull();
    expect(matchAtTrigger("a\\@b")).toBeNull();
  });

  it("`:` 后的行号区间收尾不弹（旧口径：query 里不含 `:`）", () => {
    expect(matchAtTrigger("@src/a.ts:10")).toBeNull();
    expect(matchAtTrigger("@src/a.ts:10-20")).toBeNull();
  });

  it("同一个词里多个 @：取最左一个满足边界的（query 可含 @，如 @node_modules/@types/）", () => {
    expect(matchAtTrigger("@node_modules/@types/")).toEqual({
      start: 0,
      query: "node_modules/@types/",
    });
    expect(matchAtTrigger("foo@a@b")).toBeNull(); // 两个 @ 前面都是字母
  });

  it("邮箱后面空格再打 @：新的词、照常触发", () => {
    expect(matchAtTrigger("a@b.com @")).toEqual({ start: 8, query: "" });
    expect(matchAtTrigger("邮箱 a@b.com 和 @src")).toEqual({
      start: 13,
      query: "src",
    });
  });

  it("无 @ / 空串 → null", () => {
    expect(matchAtTrigger("")).toBeNull();
    expect(matchAtTrigger("hello world")).toBeNull();
    expect(matchAtTrigger("@ab cd")).toBeNull(); // 光标在空格后的新词里、没有 @
  });
});

describe("findAtFileTokens：草稿还原 pill 的同口径解析", () => {
  it("空白后 / 行首的 @path（旧口径不退化）、停在空白与 `:` 前", () => {
    expect(findAtFileTokens("看 @src/app.ts 和 @README.md")).toEqual([
      { start: 2, end: 2 + "@src/app.ts".length, path: "src/app.ts" },
      {
        start: 2 + "@src/app.ts 和 ".length,
        end: 2 + "@src/app.ts 和 ".length + "@README.md".length,
        path: "README.md",
      },
    ]);
    const t = findAtFileTokens("@src/a.ts:10-20");
    expect(t).toEqual([{ start: 0, end: "@src/a.ts".length, path: "src/a.ts" }]);
  });

  it("紧贴中文的 @path 也还原（与触发同口径）", () => {
    expect(findAtFileTokens("帮我看下@src/app.ts")).toEqual([
      { start: 4, end: 4 + "@src/app.ts".length, path: "src/app.ts" },
    ]);
  });

  it("邮箱 / 路径中段 / 裸 @word 都不还原", () => {
    expect(findAtFileTokens("联系 a@b.com")).toEqual([]);
    expect(findAtFileTokens("x/@types/node")).toEqual([]);
    expect(findAtFileTokens("https://x.com/@user.name")).toEqual([]);
    expect(findAtFileTokens("@Button")).toEqual([]); // 无 / 也无 .：普通 @ 提及
    expect(findAtFileTokens("@")).toEqual([]);
  });

  it("词内第一个 @ 不满足边界时，继续试后面的 @（不整串放弃）", () => {
    // foo@a@b/c.ts：第一个 @ 前是 o（邮箱）、第二个 @ 前是 a（邮箱）→ 都不是
    expect(findAtFileTokens("foo@a@b/c.ts")).toEqual([]);
    // 「帮@a/b.ts」前是 CJK、满足
    expect(findAtFileTokens("帮@a/b.ts")).toEqual([
      { start: 1, end: 1 + "@a/b.ts".length, path: "a/b.ts" },
    ]);
  });
});

describe("parseSkillTokens：解析侧与触发同口径", () => {
  it("`/name` 前紧贴中文也认（否则选中后写回草稿 / 历史翻出就变回纯文本、skillRefs 丢失）", () => {
    const known = new Set(["write", "写代码"]);
    expect(parseSkillTokens("帮我看下/write 文件", known)).toEqual([
      { start: 4, end: 4 + "/write".length, name: "write" },
    ]);
    expect(parseSkillTokens("帮我/写代码继续", known)).toEqual([
      { start: 2, end: 2 + 4, name: "写代码" },
    ]);
    expect(parseSkillTokens("好的，/write", known)).toEqual([
      { start: 3, end: 3 + "/write".length, name: "write" },
    ]);
  });

  it("URL / 路径里的 /name 即使 name 恰好是已知 skill 也不当 token", () => {
    const known = new Set(["write", "app"]);
    expect(parseSkillTokens("src/write", known)).toEqual([]);
    expect(parseSkillTokens("https://a.com/write", known)).toEqual([]);
    expect(parseSkillTokens("看下src/app", known)).toEqual([]);
    expect(parseSkillTokens("~/write", known)).toEqual([]);
  });

  it("相邻 token：前一个 token 的最后一个字是中文时，后面紧贴的 `/x` 仍能扫到", () => {
    const known = new Set(["写", "读"]);
    expect(parseSkillTokens("/写/读", known)).toEqual([
      { start: 0, end: 2, name: "写" },
      { start: 2, end: 4, name: "读" },
    ]);
  });

  it("旧口径（行首 / 空白后、中文 skill 紧贴正文、多个 token）不退化", () => {
    const known = new Set(["写代码", "review"]);
    expect(parseSkillTokens("/写代码继续 /review 收尾", known).map((t) => t.name)).toEqual([
      "写代码",
      "review",
    ]);
    expect(parseSkillTokens("/写", known)).toEqual([]);
    expect(parseSkillTokens("/未知技能", known)).toEqual([]);
  });

  it("SKILL_TOKEN_RE 是全局正则、每次 parse 前 lastIndex 归零（连续两次结果一致）", () => {
    expect(SKILL_TOKEN_RE.global).toBe(true);
    const known = new Set(["write"]);
    const a = parseSkillTokens("帮我/write", known);
    const b = parseSkillTokens("帮我/write", known);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
  });
});

describe("接线源码契约", () => {
  const atMention = readSrc("components", "at-mention.tsx");
  const editor = readSrc("components", "composer-editor.tsx");
  const skillToken = readSrc("lib", "skill-token.ts");

  it("at-mention / composer-editor 都走 matchAtTrigger，不再留旧的行首 / 空白正则 AT_RE", () => {
    expect(atMention).toContain("matchAtTrigger(");
    expect(editor).toContain("matchAtTrigger(");
    expect(atMention).not.toMatch(/\bAT_RE\b/);
    expect(editor).not.toMatch(/\bAT_RE\b/);
  });

  it("composer 的 pill 还原走 findAtFileTokens，不再自带 `(^|\\s)@` 的 FILE_TOKEN_RE", () => {
    // 纯文本 → 段落树的逻辑已从 composer-editor.tsx 抽到 lib/composer-lexical.ts（第四轮，便于 headless 测试）
    const lexicalLib = readSrc("lib", "composer-lexical.ts");
    expect(lexicalLib).toContain("findAtFileTokens(");
    expect(lexicalLib).not.toContain("FILE_TOKEN_RE");
    expect(editor).not.toContain("FILE_TOKEN_RE");
    expect(editor).toContain('from "@/lib/composer-lexical"');
  });

  it("skill-token 的 SLASH_RE / SKILL_TOKEN_RE 共用同一个前缀字符类（触发与解析不再各写一份）", () => {
    expect(skillToken).toContain("SLASH_PREFIX_CLASS");
    // 两个正则都从常量拼，不再写死 `(^|\\s)`
    expect(skillToken).not.toContain("(^|\\\\s)");
  });
});
