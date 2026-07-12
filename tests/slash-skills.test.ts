/**
 * slash / skill token：中文名 + 最长前缀命中
 *
 * 中文 skill 后常不打空格（「/写代码帮我改下」），正则贪婪会把正文吞进候选；
 * parseSkillTokens 必须按 knownNames 最长前缀收窄，余下当正文。
 */
import { describe, expect, it } from "vitest";

import {
  matchLongestSkillName,
  parseSkillTokens,
  SKILL_NAME_CHAR_CLASS,
  SLASH_RE,
} from "@/lib/skill-token";

describe("SKILL_NAME_CHAR_CLASS / SLASH_RE", () => {
  it("字符类含中文，菜单触发认中文 partial", () => {
    expect(SKILL_NAME_CHAR_CLASS).toContain("\\u4e00");
    expect("/写".match(SLASH_RE)?.[2]).toBe("写");
    expect("/写代码".match(SLASH_RE)?.[2]).toBe("写代码");
    expect("帮我/写".match(SLASH_RE)).toBeNull(); // 前置非空白不触发
  });
});

describe("matchLongestSkillName", () => {
  it("取最长前缀；无命中返 null", () => {
    const known = new Set(["写", "写代码", "perf-audit"]);
    expect(matchLongestSkillName("写代码帮我改下", known)).toBe("写代码");
    expect(matchLongestSkillName("写代码", known)).toBe("写代码");
    expect(matchLongestSkillName("写", known)).toBe("写");
    expect(matchLongestSkillName("写报", known)).toBe("写"); // 「写」是前缀
    expect(matchLongestSkillName("不存在", known)).toBeNull();
    expect(matchLongestSkillName("perf-audit-extra", known)).toBe("perf-audit");
  });
});

describe("parseSkillTokens 最长前缀", () => {
  it("中文 token 紧贴正文：只吃命中名，余下是正文", () => {
    const known = new Set(["写代码", "perf-audit"]);
    const text = "/写代码帮我改下";
    const tokens = parseSkillTokens(text, known);
    expect(tokens).toEqual([{ start: 0, end: 4, name: "写代码" }]); // `/` + 3 字
    expect(text.slice(tokens[0]!.end)).toBe("帮我改下");
  });

  it("英文 exact + 行尾 / 空格边界仍可用", () => {
    const known = new Set(["perf-audit", "写代码"]);
    expect(parseSkillTokens("/perf-audit", known)).toEqual([
      { start: 0, end: "/perf-audit".length, name: "perf-audit" },
    ]);
    expect(parseSkillTokens("请用 /perf-audit 扫一下", known)).toEqual([
      { start: 3, end: 3 + "/perf-audit".length, name: "perf-audit" },
    ]);
  });

  it("打到一半不命中；未知名不高亮", () => {
    const known = new Set(["写代码"]);
    expect(parseSkillTokens("/写", known)).toEqual([]);
    expect(parseSkillTokens("/未知技能", known)).toEqual([]);
  });

  it("多个 token：前一个中文紧贴后，仍能扫到后面的 /", () => {
    const known = new Set(["写代码", "review"]);
    const text = "/写代码继续 /review 收尾";
    const tokens = parseSkillTokens(text, known);
    expect(tokens.map((t) => t.name)).toEqual(["写代码", "review"]);
  });
});
