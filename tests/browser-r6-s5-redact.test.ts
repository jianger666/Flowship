/**
 * R6-41（脱敏误伤与漏网）：
 *  ① 邮箱：完整域名；`logo@2x.png` / `lodash@4.17.21` 不打码；用户输入的邮箱（recordInputValues 开着）仍打码，设置文案如实说明；
 *  ② 紧贴字母 / 数字 / 下划线前缀的令牌（xeyJ… / 1eyJ… / xBearer … / foo_ghp_…）一遍就脱敏，safeText 2 遍后是不动点；
 *  ③ card-number：IIN 前缀 + 合法长度 + 卡面分组 + 关键词语境；2 万样本级随机量化误杀率（对比改前 ≈10%）与真卡召回 100%；
 *  ④ 会话 cookie 名（JSESSIONID / PHPSESSID / connect.sid / ASP.NET_SessionId / ASPSESSIONID*）。
 * 向量表在 tests/helpers/browser-redact-vectors.ts（同时喂 browser-redact-parity.test.ts 两端）；样本生成器在 tests/helpers/browser-redact-fp-samples.ts。
 */
import nodeFs from "node:fs";
import { describe, expect, it } from "vitest";
import { createActivityLog, maskEmails } from "../electron-app/browser/activity-log.mjs";
import { isCredentialName } from "../electron-app/browser/debug-policy.mjs";
import * as mainMod from "../electron-app/browser/text-redact.mjs";
import * as serverMod from "../src/lib/server/browser/redact-text";
import { REDACT_FRAGMENTS, REDACT_VECTORS } from "./helpers/browser-redact-vectors";
import { FALSE_POSITIVE_CATEGORIES, REAL_CARD_GENERATORS, mulberry32, withLuhn } from "./helpers/browser-redact-fp-samples";

const H = "[已隐藏]";
const IMPLS = [
  ["text-redact.mjs（主进程）", mainMod.redactSensitiveText as (s: string) => string],
  ["redact-text.ts（server）", serverMod.redactSensitiveText as (s: string) => string],
] as const;

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123";

// ───────────────────────────── ① 邮箱 ─────────────────────────────

describe("R6-41 ①：邮箱规则要求完整域名，排除 retina 资源名 / 版本号 / 源码资源文件名", () => {
  const untouched = [
    "logo@2x.png", "icon@3x.webp", "bg@1.5x.png", "sprite@2x.svg", "hero@2x.jpg",
    "lodash@4.17.21", "react@18.2.0", "typescript@5.4.5", "@scope/pkg@1.2.3", "left-pad@1.3.0",
    "import x from 'a@b.js'", "a@b.css", "foo@bar.json", "src@main.map", "x@y", "a@b.", "name@localhost", "user@192.168.0.1",
    // 验收补（变异存活）：域名尾部断言 `(?![A-Za-z0-9])`——末级标签后紧跟数字 / 字母不是完整域名（预发布版本号 `1.0.0-beta.alpha1`）
    "pkg@1.0.0-beta.alpha1", "lib@2.0.0-rc.next2",
  ];
  for (const s of untouched) it(`不打码：${s}`, () => expect(maskEmails(s)).toBe(s));

  const masked: Array<[string, string]> = [
    ["bob.smith@example.com", H],
    ["a@163.com", H], // 数字开头的真实邮箱域名
    ["x@126.com", H],
    ["x@mail.example.co.uk", H],
    ["alice@example.com-", `${H}-`], // 域名后紧跟连字符也要打码（尾部断言不能把 `-` 当域名字符）
    ["联系 bob@example.com，谢谢", `联系 ${H}，谢谢`],
    ["a@b.com.", `${H}.`],
    ["ivan@example.xn--p1ai", H],
    ["USER+tag@Example.ORG", H],
    ["安装 lodash@4.17.21 并联系 bob@example.com", `安装 lodash@4.17.21 并联系 ${H}`],
    ["logo@2x.png 与 bob@example.com", `logo@2x.png 与 ${H}`],
    ["a@b.md", H], // `.md` 同时是 ccTLD（摩尔多瓦），不当文件名排除：宁可多藏
  ];
  for (const [input, expected] of masked) it(`打码：${input}`, () => expect(maskEmails(input)).toBe(expected));

  // 验收补（变异存活：FILE_LIKE_TLDS 删 png 等任一项原测试仍全绿——retina 正则 / 其它项遮住了）：把整张扩展名表逐项钉死（表里每一项都不能被悄悄删掉）
  const FILE_EXTS = [
    "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tiff", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "tsx", "json", "map", "html", "htm", "xml",
    "txt", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "webm", "wasm", "lock", "yml", "yaml", "csv", "tar", "tgz", "gz",
  ];
  for (const ext of FILE_EXTS) it(`资源 / 源码扩展名不打码：a@b.${ext}`, () => expect(maskEmails(`a@b.${ext}`)).toBe(`a@b.${ext}`));
  for (const ext of ["com", "org", "net", "io", "cn", "co", "md", "py", "sh", "rs", "ts", "pl"]) it(`真邮箱 TLD 仍打码（含与扩展名同形的 ccTLD）：a@b.${ext}`, () => expect(maskEmails(`a@b.${ext}`)).toBe(H));

  it("幂等：打码后再过一遍不变", () => {
    for (const [input] of masked) {
      const once = maskEmails(input);
      expect(maskEmails(once)).toBe(once);
    }
  });

  it("线性：超长 @ / 点 / 标签不卡死", () => {
    for (const s of ["a@".repeat(50_000), "a.".repeat(50_000), `x@${"a.".repeat(40_000)}`, `${"a".repeat(100_000)}@b.com`, "@a.b".repeat(30_000), `x@${"a-".repeat(60_000)}.com`]) {
      const t0 = Date.now();
      maskEmails(s);
      expect(Date.now() - t0).toBeLessThan(1500);
    }
  });

  it("活动日志出口：文件名 / 版本号原样保留，真邮箱打码（summary / 控件名 / url 路径都走同一入口）", () => {
    const log = createActivityLog();
    const e = log.addSystem({ kind: "notification", summary: "资源 logo@2x.png 与 lodash@4.17.21 加载完毕，客服 bob.smith@example.com" });
    expect(e.summary).toContain("logo@2x.png");
    expect(e.summary).toContain("lodash@4.17.21");
    expect(e.summary).not.toContain("bob.smith@example.com");
    expect(e.summary).toContain(H);
  });

  it("用户自己输入的邮箱（recordInputValues 开着）也打码——设置文案如实说明「敏感格式仍会自动打码」", () => {
    const log = createActivityLog({ recordInputValues: true });
    const t = { role: "textbox", name: "邮箱", tag: "input", inputType: "text" };
    const e = log.ingest({ type: "input", tabId: "1", url: "https://a.test/", target: t, value: "me@example.com", ts: 1000 });
    expect(e?.summary).not.toContain("me@example.com");
    expect(e?.summary).toContain(H);

    const src = nodeFs.readFileSync(new URL("../src/components/settings/browser-card.tsx", import.meta.url), "utf8");
    const hint = src.match(/hint="(开启后，你在浏览器里的输入[^"]*)"/)?.[1] ?? "";
    expect(hint, "设置页「记录输入内容」的说明文案不见了").not.toBe("");
    expect(hint).toContain("仍会自动打码");
    expect(hint).toContain("邮箱");
    expect(hint).toContain("密码框的内容无论如何都不记录");
  });
});

// ───────────────────────────── ② 前缀令牌 ─────────────────────────────

describe.each(IMPLS)("R6-41 ②：紧贴前缀的令牌一遍就脱敏 · %s", (_name, redact) => {
  const cases: Array<[string, string, string]> = [
    ["xeyJ… JWT", `xeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123`, `x${H}`],
    ["1eyJ… JWT", `1eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123`, `1${H}`],
    ["_eyJ… JWT", `t_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123`, `t_${H}`],
    ["卡号紧贴 JWT", `4111111111111111${JWT}`, `${H}${H}`],
    ["字段名紧贴 JWT", `tokenvalue${JWT}`, `tokenvalue${H}`],
    ["xBearer", "xBearer abcdef123456", `xBearer ${H}`],
    ["转义换行紧贴 Bearer", "a\\nBearer abcdef123456", `a\\nBearer ${H}`],
    ["xBasic", "xBasic dXNlcjpwYXNz", `xBasic ${H}`],
    ["foo_ghp_", "foo_ghp_abcdefghijklmnopqrstuvwxyz0123", `foo_${H}`],
    ["数字前缀 github_pat_", "1github_pat_abcdefghijklmnopqrstuv", `1${H}`],
    ["前缀 glpat-", "xglpat-abcdefghijklmnopqrst", `x${H}`],
    ["前缀 xoxb-", "dataxoxb-1234567890-abcdefghij", `data${H}`],
    ["前缀 AKIA", "keyAKIAIOSFODNN7EXAMPLE", `key${H}`],
    ["前缀 AIza", `idAIza${"A".repeat(35)}`, `id${H}`],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name}：一遍脱敏且幂等`, () => {
      const once = redact(input);
      expect(once).toBe(expected);
      expect(redact(once)).toBe(once);
    });
  }

  it("`sk-` 保留词首边界：task- / risk- 的长 slug 不被误杀，独立的 sk-… 仍脱敏", () => {
    expect(redact("/tasks/task-1234-some-long-slug-name-here")).toBe("/tasks/task-1234-some-long-slug-name-here");
    expect(redact("risk-assessment-2024-q3-final-report-v2")).toBe("risk-assessment-2024-q3-final-report-v2");
    expect(redact("key sk-abcdefghij1234567890abcdef")).toBe(`key ${H}`);
  });

  it("不误杀：纯 eyJ 片段 / 两段式 / 普通单词", () => {
    for (const s of ["eyJ", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0", "Bearer", "Bearer x", "ghp_short", "the basics are simple"]) expect(redact(s)).toBe(s);
  });
});

describe("R6-41 ②：safeText 迭代 2 遍——一遍就是完备的，且再过一遍不变", () => {
  const summaryOf = (text: string) => createActivityLog().addSystem({ kind: "notification", summary: text }).summary;

  it("需要两遍才完整的拼接：卡号后紧跟 AKIA 令牌（第一遍卡号被替换后，AKIA 的 `\\b` 才成立）", () => {
    const s = summaryOf("keyAKIAIOSFODNN7EXAMPLE2221000000000009");
    expect(s).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(s).not.toContain("2221000000000009");
    expect(s).toBe(`key${H}${H}`);
  });

  it("所有「前缀令牌」类拼接一遍就不含明文", () => {
    for (const s of [`4111111111111111${JWT}`, `xBearer abcdef123456 and 4111111111111111`, `foo_ghp_abcdefghijklmnopqrstuvwxyz0123card 4111111111111111`, `a@b.com${JWT}`]) {
      const out = summaryOf(s);
      expect(out).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/);
      expect(out).not.toContain("abcdef123456");
      expect(out).not.toContain("ghp_");
      expect(out).not.toContain("4111111111111111");
      expect(out).not.toContain("a@b.com");
    }
  });

  it("确定性随机拼接 20 万条：脱敏一遍与再脱敏一遍的结果相同（2 遍是不动点）", { timeout: 120_000 }, () => {
    const rnd = mulberry32(0x5eed41);
    const frags = [...REDACT_FRAGMENTS, ...REDACT_VECTORS.map((v) => v.input), "bob@example.com", "a@b.co", "[已隐藏]", "token=", "card ", "-", " "].filter((f) => f.length <= 60);
    const pass = (x: string) => maskEmails(mainMod.redactSensitiveText(x));
    let bad = 0;
    for (let i = 0; i < 200_000; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      let input = "";
      for (let k = 0; k < n; k++) input += frags[Math.floor(rnd() * frags.length)];
      const a = pass(pass(input)); // safeText 的两遍
      if (pass(a) !== a) {
        bad++;
        expect(pass(a), `两遍之后仍在变：${JSON.stringify(input).slice(0, 200)}`).toBe(a);
      }
    }
    expect(bad).toBe(0);
  });

  it("活动日志出口再过一遍不变（summary 不叠加占位符）", () => {
    const rnd = mulberry32(0x5eed42);
    const frags = [...REDACT_VECTORS.map((v) => v.input), "bob@example.com", " ", "card "].filter((f) => f.length <= 30);
    for (let i = 0; i < 4000; i++) {
      let input = "";
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) input += frags[Math.floor(rnd() * frags.length)];
      if (input.trim() === "") continue; // 空摘要会落到默认文案，不在本用例范围
      const once = summaryOf(input);
      if (once.endsWith("…")) continue; // 超 160 被截断的不比较
      expect(summaryOf(once), JSON.stringify(input)).toBe(once);
    }
  });
});

// ───────────────────────────── ③ card-number ─────────────────────────────

describe.each(IMPLS)("R6-41 ③：card-number 语义 · %s", (_name, redact) => {
  it("同样 Luhn 通过的 16 位：有品牌前缀脱敏，没有品牌前缀（订单号 / id）不动", () => {
    expect(redact(withLuhn("411111111111111"))).toBe(H); // 4… Visa
    expect(redact(withLuhn("123456789012345"))).toBe("1234567890123452"); // 12… 无品牌
    expect(redact(withLuhn("100000000000000"))).toBe("1000000000000008");
    expect(redact(withLuhn("900000000000000"))).toBe("9000000000000001");
  });

  it("品牌 × 合法长度：Visa 只认 16 / 19，Amex 只认 15，Mastercard 只认 16（Luhn 通过但长度不合法的不动）", () => {
    const luhn = (prefix: string, total: number) => withLuhn(prefix.padEnd(total - 1, "1"));
    for (const [prefix, okLens, badLens] of [
      ["4", [16, 19], [17, 18]],
      ["37", [15], [14, 16, 17]],
      ["55", [16], [15, 17, 18]],
    ] as const) {
      for (const n of okLens) expect(redact(luhn(prefix, n)), `${prefix}… ${n} 位应脱敏`).toBe(H);
      for (const n of badLens) expect(redact(luhn(prefix, n)), `${prefix}… ${n} 位不是该品牌的合法长度`).toBe(luhn(prefix, n));
    }
  });

  it("分组像卡面才算：4-4-4-4 / 4-4-4-4-3 / Amex 4-6-5 / Diners 4-6-4 脱敏；电话 / ISBN 式分组不动", () => {
    expect(redact("4111 1111 1111 1111")).toBe(H);
    expect(redact("4111-1111-1111-1111")).toBe(H);
    expect(redact("3782 822463 10005")).toBe(H);
    expect(redact("3056 930902 5904")).toBe(H);
    expect(redact("+86 138 1234 5678")).toBe("+86 138 1234 5678");
    expect(redact("4111 11 1111 1111 11")).toBe("4111 11 1111 1111 11");
    expect(redact("4111 111 1111 1111 1")).toBe("4111 111 1111 1111 1");
  });

  it("卡号后面跟有效期 / CVV 仍能截出卡号前缀", () => {
    expect(redact("4111 1111 1111 1111 12/25")).toBe(`${H} 12/25`);
    expect(redact("卡 4111111111111111 cvv 123")).toBe(`卡 ${H} cvv 123`);
  });

  it("关键词语境（card / pan / credit / 卡号 / 银行卡 …，与号码之间 ≤ 24 个非数字字符）放宽到「任意 13–19 位 Luhn 通过」", () => {
    const odd = "6012345678901234"; // 6012… 不是 Discover（6011）
    for (const ctx of ["卡号：", "银行卡号 ", "信用卡：", "card ", "Card Number: ", "credit card number is ", "PAN=", "cc_num=", "cvv ", '"cardNumber":"']) {
      expect(redact(`${ctx}${odd}`), ctx).toBe(`${ctx}${H}`);
    }
    expect(redact(odd)).toBe(odd);
    expect(redact(`order ${odd}`)).toBe(`order ${odd}`);
    // 关键词离得太远（> 24 个非数字字符）不算语境
    expect(redact(`card${"x".repeat(25)}${odd}`)).toBe(`card${"x".repeat(25)}${odd}`);
    expect(redact(`card${"x".repeat(24)}${odd}`)).toBe(`card${"x".repeat(24)}${H}`);
  });

  it("语境放宽也不放过：分组不像卡面 / 13–14 位无分隔（毫秒时间戳、日期时间）", () => {
    const d13 = withLuhn("169999999999"); // 13 位 Luhn 通过（毫秒时间戳形态）
    const d14 = withLuhn("2026010112304"); // 14 位 Luhn 通过（日期时间形态）
    expect(d13).toHaveLength(13);
    expect(d14).toHaveLength(14);
    expect(redact(`card ${d13}`)).toBe(`card ${d13}`);
    expect(redact(`卡号 ${d14}`)).toBe(`卡号 ${d14}`);
    const d16 = withLuhn("601234567890123"); // 16 位 Luhn 通过、冷门前缀
    const badGroup = `${d16.slice(0, 4)} ${d16.slice(4, 6)} ${d16.slice(6, 10)} ${d16.slice(10, 14)} ${d16.slice(14)}`; // 4-2-4-4-2
    expect(redact(`card ${badGroup}`)).toBe(`card ${badGroup}`);
    const d13i = withLuhn("978316148410"); // ISBN-13 形态（Luhn 恰好通过的那 10%）
    const isbn = `${d13i.slice(0, 3)}-${d13i[3]}-${d13i.slice(4, 6)}-${d13i.slice(6, 12)}-${d13i[12]}`;
    expect(redact(`card ${isbn}`)).toBe(`card ${isbn}`);
    expect(redact("card +86 138 1234 5678")).toBe("card +86 138 1234 5678");
  });

  it("幂等：一个卡号被打码后，紧跟其后的候选看到的语境与第二遍一致（脱敏一遍 === 两遍）", () => {
    const s = '{"cardNumber":"6012345678901234"}3527000000000008 3590000000000000';
    const once = redact(s);
    expect(redact(once)).toBe(once);
    expect(once).toBe(`{"cardNumber":"${H}"}${H} ${H}`);
  });

  it("全数字 UUID / 小数不当卡号（起点 / 终点排除没被放松）", () => {
    expect(redact("12345678-1234-1234-1234-123456789012")).toBe("12345678-1234-1234-1234-123456789012");
    expect(redact("3.141592653589793238")).toBe("3.141592653589793238");
  });
});

describe("R6-41 ③：2 万样本随机量化——误杀率与召回率（改前 / 改后数字见 R6-41 报告）", () => {
  const N = 20_000;
  // 改前（只有 Luhn）实测：手机号 / 德国手机号 / 订单号 / JSON id / 身份证 / 雪花 id / 快递单号各 ≈ 10%，ISBN-13 5.3%；
  // 改后实测（确定性种子，可复现）：订单号无分隔 3.10% / 四位一组 2.99% / 身份证 1.26% / JSON id 0.81%，其余 0%。
  // 剩下的是「真长得像卡号」的（以 4 / 5 / 62 等开头的 16 位订单号碰巧 Luhn 通过），无法再靠格式区分。
  const CAP_PCT: Record<string, number> = {
    "16 位订单号（无分隔）": 4,
    "16 位订单号（四位一组空格分隔）": 4,
    "17 位 JSON id": 1.5,
    "18 位身份证（含 X 结尾，按 17 位前缀计）": 2,
  };
  const DEFAULT_CAP_PCT = 0.2;

  describe.each(IMPLS)("%s", (_name, redact) => {
    it("每个误杀类的误杀率 ≤ 上限（改前约 10%）", { timeout: 120_000 }, () => {
      let ci = 0;
      const report: string[] = [];
      for (const cat of FALSE_POSITIVE_CATEGORIES) {
        const rnd = mulberry32(0xc0ffee + ci++);
        let hit = 0;
        for (let i = 0; i < N; i++) {
          const s = cat.gen(rnd);
          if (redact(s) !== s) hit++;
        }
        const pct = (hit / N) * 100;
        const cap = CAP_PCT[cat.name] ?? DEFAULT_CAP_PCT;
        report.push(`${pct.toFixed(2)}% ${cat.name}`);
        expect(pct, `${cat.name} 误杀率 ${pct.toFixed(2)}% 超过上限 ${cap}%（全部：${report.join(" | ")}）`).toBeLessThanOrEqual(cap);
      }
    });

    it("真卡号召回 100%（Visa / MC 含 2 系 / Amex / 银联 16–19 位 / Discover / JCB / Diners / 工行农行；无分隔 / 空格 / 连字符；裸号 / 带语境 / JSON）", { timeout: 120_000 }, () => {
      let ci = 100;
      for (const g of REAL_CARD_GENERATORS) {
        const rnd = mulberry32(0xbeef00 + ci++);
        let miss = 0;
        let firstMiss = "";
        const n = 3000;
        for (let i = 0; i < n; i++) {
          const c = g.gen(rnd);
          const text = i % 3 === 0 ? c.text : i % 3 === 1 ? `card ${c.text} exp 12/27` : `{"pan":"${c.text}","n":1}`;
          const red = redact(text);
          if (red.includes(c.digits) || red === text) {
            miss++;
            if (!firstMiss) firstMiss = text;
          }
        }
        expect(miss, `${g.name} 漏 ${miss}/${n}，例：${firstMiss}`).toBe(0);
      }
    });
  });

  it("样本生成器自检：误杀类样本至少 11 位数字（否则量化没意义）、真卡样本全部 Luhn 通过", () => {
    const rnd = mulberry32(7);
    for (const g of REAL_CARD_GENERATORS) {
      const c = g.gen(rnd);
      expect(c.digits).toMatch(/^\d{14,19}$/);
      expect(withLuhn(c.digits.slice(0, -1))).toBe(c.digits);
    }
    for (const cat of FALSE_POSITIVE_CATEGORIES) expect(cat.gen(rnd).replace(/\D/g, "").length).toBeGreaterThanOrEqual(11);
  });
});

// ───────────────────────────── ④ 会话 cookie 名 ─────────────────────────────

describe("R6-41 ④：会话 cookie 名", () => {
  const names = ["JSESSIONID", "PHPSESSID", "connect.sid", "ASP.NET_SessionId", "ASPSESSIONIDAQSTRDCT", "laravel_session"];

  describe.each(IMPLS)("文本脱敏 · %s", (_n, redact) => {
    for (const n of names) {
      it(`${n}=… / "${n}":"…" / Cookie 头`, () => {
        expect(redact(`${n}=ABC123DEF456xyz`)).toBe(`${n}=${H}`);
        expect(redact(`{"${n}":"ABC123DEF456xyz"}`)).toBe(`{"${n}":"${H}"}`);
        expect(redact(`Cookie: ${n}=ABC123DEF456xyz; theme=dark`)).toBe(`Cookie: ${H}`);
      });
    }
    it("不误杀：assess / essential 这类含 sess 子串的普通词", () => {
      expect(redact("assessment=done")).toBe("assessment=done");
      expect(redact("essential=true")).toBe("essential=true");
    });
  });

  describe("调试器 scope 变量名（isCredentialName）", () => {
    for (const n of [...names, "koa.sess", "jsessionid", "phpsessid", "sessid", "SESS", "mySessId", "aspsessionid", "ASPSESSIONIDQQQ"]) it(`隐藏：${n}`, () => expect(isCredentialName(n)).toBe(true));
    for (const n of ["assess", "assessment", "essential", "sessidx", "address", "process"]) it(`不隐藏：${n}`, () => expect(isCredentialName(n)).toBe(false));
  });
});

// ───────────────────────────── 验收补：30 万字符对抗输入 ─────────────────────────────

describe("R6-41 验收补：30 万字符对抗输入 < 1s（词首边界去掉后「每个前缀都是起点」不能退化成 O(N × 窗口)）", () => {
  const N = 300_000;
  const rep = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  // 变异实测：JWT 起点不分档（紧贴前缀的起点也扫 2048）时 `eyJ`×10 万 ≈ 0.7–1.6s（随机器负载）；分档（256）后 ≈ 0.1s——这一项收紧到 600ms（修后最慢 ≈ 0.34s，变异后 ≥ 0.7s）才能稳定抓到退化
  const evil: Array<[string, string, number?]> = [
    ["eyJ×10 万（每个 eyJ 都是起点）", rep("eyJ"), 600],
    ["xeyJabcde-×3 万", rep("xeyJabcde-")],
    ["eyJ + a×30 万", `eyJ${"a".repeat(N)}`],
    ["eyJabcde.eyJabcde.", rep("eyJabcde.eyJabcde.")],
    ["xBearer ×3.7 万", rep("xBearer ")],
    ["Bearer + 空格×30 万", `Bearer${" ".repeat(N)}`],
    ["ghp_×7.5 万", rep("ghp_")],
    ["AKIA×7.5 万", rep("AKIA")],
    ["sk-×10 万", rep("sk-")],
  ];
  for (const [name, input, budget = 1000] of evil) {
    it(`${name}：两端脱敏与活动日志出口都 < ${budget}ms`, () => {
      expect(input.length).toBeGreaterThanOrEqual(N);
      for (const [label, fn] of [
        ["mjs", mainMod.redactSensitiveText],
        ["ts", serverMod.redactSensitiveText],
        ["safeText", (s: string) => createActivityLog().addSystem({ kind: "notification", summary: s }).summary],
      ] as const) {
        const t0 = performance.now();
        fn(input);
        const ms = performance.now() - t0;
        expect(ms, `${label} 耗时 ${ms.toFixed(0)}ms`).toBeLessThan(budget);
      }
    });
  }
});
