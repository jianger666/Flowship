/**
 * R6-14：主进程 `text-redact.mjs` ⇄ server `redact-text.ts` 的真实一致性测试。
 * 之前 text-redact.mjs 头注释声称有这个测试，其实不存在；WS / SSE / HAR / perf / sources / debug / record 的出站脱敏都靠主进程这份副本。
 * 同一张向量表（tests/helpers/browser-redact-vectors.ts）同时喂两端：逐条相同且等于期望；另加规则清单一致 + 确定性随机拼接的逐字一致。
 */
import { describe, expect, it } from "vitest";
import { REDACT_FRAGMENTS, REDACT_VECTORS } from "./helpers/browser-redact-vectors";
import * as serverMod from "../src/lib/server/browser/redact-text";

const mainMod = (await import("../electron-app/browser/text-redact.mjs")) as {
  redactSensitiveText: (s: string) => string;
  redactSensitiveTextCounted: (s: string) => { text: string; count: number };
  REDACT_RULE_NAMES: readonly string[];
  REDACT_PATTERNS: Record<string, unknown>;
  REDACTED_TEXT: string;
};

/** REDACT_PATTERNS 必须覆盖的条目（两端各自导出；增 / 删规则要同步改这张表——防止「两端同时悄悄少导出一项」） */
const EXPECTED_PATTERN_KEYS = [
  "PEM_RE", "CARD_RE", "CARD_BRANDS", "CARD_GROUPINGS", "CARD_CONTEXT_RE", "JWT_HEADER_MAX", "JWT_RE", "AUTH_TOKEN_SCHEMES", "AUTH_LINE_SCHEMES",
  "AUTH_HEADER_QUOTED_RE", "AUTH_HEADER_RE", "AUTH_SCHEME_ONLY_RE", "AUTH_SCHEME_RE", "BARE_SECRET_RES", "COOKIE_HEADER_RE", "USERINFO_RE", "QUERY_CODE_RE",
  "KEY_SUFFIX", "KEY_CLOSE", "KEY_CHARS", "GENERAL_WORDS", "SHORT_WORDS", "KEY_NAME", "VALUE", "KEY_VALUE_RE",
];

describe("R6-39 ⑤ 两端导出的正则源码 / 词表 / 上限逐项相同（只改一端必红）", () => {
  const a = mainMod.REDACT_PATTERNS;
  const b = serverMod.REDACT_PATTERNS as Record<string, unknown>;

  it("两端导出的条目名恰好是约定的那一组（不多不少）", () => {
    expect(Object.keys(a).sort()).toEqual([...EXPECTED_PATTERN_KEYS].sort());
    expect(Object.keys(b).sort()).toEqual([...EXPECTED_PATTERN_KEYS].sort());
  });

  it.each(EXPECTED_PATTERN_KEYS)("%s：mjs 与 ts 完全一致", (key) => {
    expect(b[key], `${key} 两端分叉（mjs=${JSON.stringify(a[key])?.slice(0, 160)}）`).toEqual(a[key]);
  });

  it("导出内容是真实管线用的：SHORT_WORDS / GENERAL_WORDS 含关键词，cookie 前瞻上限 256，JWT 头上限 2048（基线值，防导出被改成空壳）", () => {
    const re = (k: string) => a[k] as { source: string; flags: string };
    expect(String(a.SHORT_WORDS).split("|")).toEqual(expect.arrayContaining(["key", "sid", "sig", "session", "auth", "pass"]));
    expect(String(a.GENERAL_WORDS)).toContain("session[_-]?id");
    expect(re("COOKIE_HEADER_RE").source).toContain("{1,256}");
    expect(a.JWT_HEADER_MAX).toBe(2048);
    expect(re("KEY_VALUE_RE").source).toContain(String(a.SHORT_WORDS));
    expect(re("KEY_VALUE_RE").flags).toBe("gi");
    expect((a.CARD_BRANDS as Array<{ name: string }>).map((x) => x.name)).toEqual(expect.arrayContaining(["visa", "mastercard", "amex", "unionpay"]));
  });
});

describe("R6-14 text-redact.mjs ⇄ redact-text.ts parity", () => {
  it("规则名清单两端一致、且非空", () => {
    expect(mainMod.REDACT_RULE_NAMES.length).toBeGreaterThanOrEqual(10);
    expect([...mainMod.REDACT_RULE_NAMES]).toEqual([...serverMod.REDACT_RULE_NAMES]);
    expect(mainMod.REDACTED_TEXT).toBe(serverMod.REDACTED_TEXT);
  });

  it("向量表覆盖了清单里的每一条规则（新增规则必须同时加正例）", () => {
    const covered = new Set(REDACT_VECTORS.map((v) => v.rule));
    for (const name of mainMod.REDACT_RULE_NAMES) expect(covered.has(name), `向量表缺规则 ${name}`).toBe(true);
  });

  it.each(REDACT_VECTORS.map((v) => [`${v.rule} · ${v.name}`, v] as const))("%s", (_n, v) => {
    const a = mainMod.redactSensitiveText(v.input);
    const b = serverMod.redactSensitiveText(v.input);
    expect(a, "主进程输出与期望不符").toBe(v.expected);
    expect(b, "server 输出与期望不符").toBe(v.expected);
    expect(a).toBe(b);
    // 计数也必须一致；反例（expected === input）计数为 0
    const ca = mainMod.redactSensitiveTextCounted(v.input).count;
    const cb = serverMod.redactSensitiveTextCounted(v.input).count;
    expect(ca).toBe(cb);
    if (v.expected === v.input) expect(ca).toBe(0);
    else expect(ca).toBeGreaterThan(0);
  });

  it("脱敏结果幂等：再脱敏一遍不变（两端）", () => {
    for (const v of REDACT_VECTORS) {
      const once = mainMod.redactSensitiveText(v.input);
      expect(mainMod.redactSensitiveText(once)).toBe(once);
      expect(serverMod.redactSensitiveText(once)).toBe(once);
    }
  });

  it("确定性随机拼接 3000 条：两端输出逐字相同（含卡号 / PEM / JWT 边界叠加）", () => {
    // mulberry32：固定种子，失败可复现
    let s = 0x6d2b79f5;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let diffs = 0;
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      let input = "";
      for (let k = 0; k < n; k++) input += REDACT_FRAGMENTS[Math.floor(rnd() * REDACT_FRAGMENTS.length)];
      const a = mainMod.redactSensitiveTextCounted(input);
      const b = serverMod.redactSensitiveTextCounted(input);
      if (a.text !== b.text || a.count !== b.count) {
        diffs++;
        expect(a, `拼接 #${i} 两端分叉：${JSON.stringify(input).slice(0, 200)}`).toEqual(b);
      }
    }
    expect(diffs).toBe(0);
  });

  it("对抗输入线性：长 BEGIN 无 END / 超长数字串 / 重复分隔数字，各 < 1.5s", () => {
    const evil = [
      "-----BEGIN PRIVATE KEY-----".repeat(5000),
      "9".repeat(60_000),
      "1 ".repeat(30_000),
      "1-".repeat(30_000),
      "4111 1111 1111 1111 ".repeat(3000),
      // R6-41 ②：JWT / Bearer 不再要求词首边界 → 每个 `eyJ` / `Bearer` 都是合法起点，仍须线性
      "eyJ".repeat(30_000),
      "xeyJabcde-".repeat(10_000),
      "eyJabcde.".repeat(10_000),
      "xBearer ".repeat(12_000),
      "Bearer".padEnd(100_000, " "),
      "ghp_".repeat(25_000),
      // R6-41 ③：卡号语境检查对每个候选只看前 40 字符
      "card 4111 1111 1111 1111 ".repeat(4000),
      "1234 ".repeat(20_000),
    ];
    for (const input of evil) {
      for (const fn of [mainMod.redactSensitiveText, serverMod.redactSensitiveText]) {
        const t0 = Date.now();
        fn(input);
        expect(Date.now() - t0).toBeLessThan(1500);
      }
    }
  });
});
