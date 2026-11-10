/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明 */
/**
 * E2·P3 / A1：storage-policy.mjs（纯逻辑）单测——值脱敏格式、开关归类、cookie 输入校验、导出文件名净化（路径穿越 / 绝对路径 /
 * 超长 / 特殊字符 / 符号链接）、导入文件 schema 的恶意用例、落盘权限 0600 / 目录 0700、旧文件清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_REVEAL_VALUE_CHARS,
  MAX_STATE_BYTES,
  MAX_STATE_COOKIES,
  MAX_STATE_ITEMS_PER_ORIGIN,
  MAX_STATE_ORIGINS,
  STATE_FILE_BASE_MAX,
  STATE_KEEP_FILES,
  STATE_MAX_AGE_MS,
  STORAGE_ACTIONS,
  STORAGE_REVEAL_ACTIONS,
  STORAGE_WRITE_ACTIONS,
  actionNeedsAccess,
  buildStateFile,
  cleanName,
  cookieUrlOf,
  cookieWriteUrl,
  defaultStateName,
  describeCookie,
  describeStorageItem,
  domainMatchesHost,
  isAppCookieDomain,
  maskValue,
  normalizeCookie,
  normalizeCookieHost,
  normalizeSameSite,
  parseStateFile,
  pruneStateDir,
  readStateFile,
  revealValue,
  sanitizeStateName,
  stateDirFor,
  strictStateName,
  toElectronCookie,
  validateCookieInput,
  writeStateFile,
} from "../electron-app/browser/storage-policy.mjs";

const isWin = process.platform === "win32";
const SECRET = "SuperSecretToken-ABCDEFGH-12345";

const appHost = "flowship.app.test";
const isAppUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.hostname === appHost || (x.hostname === "127.0.0.1" && x.port === "8876");
  } catch {
    return false;
  }
};
/** 与 ops/storage.mjs 的 checkUrlSoft 同口径的假实现：非 http(s) / Flowship origin 拒绝 */
const checkUrl = (url: string) => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "无法解析" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "协议不允许" };
  if (isAppUrl(u.href)) return { ok: false, reason: "不能访问 Flowship 应用自身" };
  return { ok: true };
};
const deps = { checkUrl, isAppUrl, now: () => 1_700_000_000_000 };

const goodCookie = (over: Record<string, unknown> = {}) => ({ name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", ...over });
const goodFile = (over: Record<string, unknown> = {}) => ({ version: 1, cookies: [goodCookie()], origins: [], ...over });
const parse = (doc: unknown, d: any = deps) => parseStateFile(typeof doc === "string" ? doc : JSON.stringify(doc), d);

describe("P3·值脱敏「长度 + 前 4 位」", () => {
  it("格式：空 / ≤8 只给长度 / >8 给长度 + 前 4 位；整串明文不会出现", () => {
    expect(maskValue("")).toBe("[空]");
    expect(maskValue(undefined)).toBe("[空]");
    expect(maskValue("abc")).toBe("[3 字符]");
    expect(maskValue("12345678")).toBe("[8 字符]"); // ≤8：前 4 位占一半以上，等于没脱敏 → 只给长度
    expect(maskValue("123456789")).toBe("[9 字符，前 4 位「1234」…]");
    const m = maskValue(SECRET);
    expect(m).toBe(`[${SECRET.length} 字符，前 4 位「Supe」…]`);
    expect(m).not.toContain("SuperSecret");
    expect(m).not.toContain("12345");
  });

  it("长度按码点计（不劈代理对）；前缀里的控制 / 格式字符被替换（页面可控文字不能借前缀藏东西）", () => {
    const emoji = "😀".repeat(10);
    expect(maskValue(emoji)).toBe(`[10 字符，前 4 位「${"😀".repeat(4)}」…]`);
    const sneaky = "\u202eev\u200bil-rest-of-value";
    const out = maskValue(sneaky);
    expect(out).not.toMatch(/[\u202e\u200b]/);
    expect(out).toContain("前 4 位");
  });

  it("cookie / storage 条目默认只有 valueHint、没有 value 字段；reveal 才给明文并对超长截断", () => {
    const c = normalizeCookie({ name: "sid", value: SECRET, domain: ".a.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_900_000_000 });
    // describeCookie / describeStorageItem 的返回是「脱敏形 | 明文形」联合类型：按字段名断言前先放宽成记录
    const hidden = describeCookie(c) as Record<string, unknown>;
    expect(hidden).not.toHaveProperty("value");
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect(hidden.valueHint).toBe(maskValue(SECRET));
    expect(hidden).toMatchObject({ name: "sid", domain: ".a.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expires: 1_900_000_000 });
    expect((describeCookie(c, { reveal: true }) as Record<string, unknown>).value).toBe(SECRET);

    const si = describeStorageItem("token", SECRET) as Record<string, unknown>;
    expect(si).not.toHaveProperty("value");
    expect(JSON.stringify(si)).not.toContain(SECRET);
    expect(si.size).toBe(SECRET.length);
    expect((describeStorageItem("token", SECRET, { reveal: true }) as Record<string, unknown>).value).toBe(SECRET);

    const long = "x".repeat(MAX_REVEAL_VALUE_CHARS + 500);
    const r = revealValue(long);
    expect(r.truncated).toBe(true);
    expect(r.value.length).toBe(MAX_REVEAL_VALUE_CHARS + 1);
    expect(describeStorageItem("k", long, { reveal: true })).toMatchObject({ valueTruncated: true });
  });

  it("cleanName：控制字符 / 换行被替换成 ·（页面可控的名字不能借换行伪造多行输出）、空白折叠、限长", () => {
    expect(cleanName("a\nb\tc")).toBe("a·b·c");
    expect(cleanName("a   b")).toBe("a b");
    expect(cleanName("  pad  ")).toBe("pad");
    expect(cleanName("x".repeat(500), 50).length).toBe(51);
  });
});

describe("P3·开关归类：每个写 / 删 / 清 / 导入 / 导出动作都需要 storageAccess", () => {
  it("写类全部需要；读类只有带 reveal 才需要；idb_list 永远不需要", () => {
    for (const a of STORAGE_WRITE_ACTIONS) {
      expect(actionNeedsAccess(a, false), a).toBe(true);
      expect(actionNeedsAccess(a, true), a).toBe(true);
    }
    for (const a of STORAGE_REVEAL_ACTIONS) {
      expect(actionNeedsAccess(a, false), a).toBe(false);
      expect(actionNeedsAccess(a, true), a).toBe(true);
    }
    expect(actionNeedsAccess("idb_list", false)).toBe(false);
    expect(actionNeedsAccess("idb_list", true)).toBe(false); // idb_list 只列库名，没有「明文」可言
    // 契约里的 14 个 action 都被归了类
    const classified = new Set<string>([...STORAGE_WRITE_ACTIONS, ...STORAGE_REVEAL_ACTIONS, "idb_list"]);
    expect([...classified].sort()).toEqual([...STORAGE_ACTIONS].sort());
    expect(STORAGE_ACTIONS).toHaveLength(14);
  });

  it("reveal 只有 === true 才算", () => {
    expect(actionNeedsAccess("cookies_list", "true" as any)).toBe(false);
    expect(actionNeedsAccess("cookies_list", 1 as any)).toBe(false);
  });
});

describe("P3·cookie 域名 / SameSite 规整与 Flowship origin 排除", () => {
  it("normalizeCookieHost：去前导点、小写、IPv6 括号化；非法 → null", () => {
    expect(normalizeCookieHost(".Example.COM")).toBe("example.com");
    expect(normalizeCookieHost("my_app.local")).toBe("my_app.local");
    expect(normalizeCookieHost("::1")).toBe("[::1]");
    expect(normalizeCookieHost("[::1]")).toBe("[::1]");
    for (const bad of ["", "a b.com", "evil.com/x", "a..b", "-a.com", "a.com-", "a@b.com", "a.com:80", "x".repeat(300), 5 as any, null as any]) {
      expect(normalizeCookieHost(bad), String(bad)).toBeNull();
    }
  });

  it("isAppCookieDomain：交给 isAppUrl 判；非法域名按「不能碰」；没有 isAppUrl 不误杀", () => {
    expect(isAppCookieDomain(appHost, isAppUrl)).toBe(true);
    expect(isAppCookieDomain(`.${appHost}`, isAppUrl)).toBe(true);
    expect(isAppCookieDomain("example.com", isAppUrl)).toBe(false);
    expect(isAppCookieDomain("not a domain", isAppUrl)).toBe(true);
    expect(isAppCookieDomain("example.com", undefined)).toBe(false);
    expect(isAppCookieDomain("example.com", () => {
      throw new Error("boom");
    })).toBe(true);
  });

  it("normalizeSameSite：no_restriction → none；缺省 → unspecified；不认识 → undefined", () => {
    expect(normalizeSameSite("no_restriction")).toBe("none");
    expect(normalizeSameSite("Lax")).toBe("lax");
    expect(normalizeSameSite(undefined)).toBe("unspecified");
    expect(normalizeSameSite("weird")).toBeUndefined();
  });

  it("cookieUrlOf / cookieWriteUrl / domainMatchesHost", () => {
    expect(cookieUrlOf({ domain: ".a.test", path: "/p", secure: true })).toBe("https://a.test/p");
    expect(cookieUrlOf({ domain: "a.test", path: "x", secure: false })).toBe("http://a.test/");
    expect(cookieWriteUrl({ domain: ".a.test", path: "/p", secure: true }, "https://zzz.test/")).toBe("https://a.test/p");
    expect(cookieWriteUrl({ path: "/" }, "https://base.test/")).toBe("https://base.test/");
    expect(domainMatchesHost("example.com", "example.com")).toBe(true);
    expect(domainMatchesHost(".example.com", "a.b.example.com")).toBe(true);
    expect(domainMatchesHost("example.com", "notexample.com")).toBe(false);
    expect(domainMatchesHost("bad domain", "example.com")).toBe(false);
  });
});

describe("P3·validateCookieInput：恶意 / 非法输入", () => {
  it("合法输入被规整；secure / httpOnly 只认 true；expires ≤0 当会话 cookie", () => {
    const r: any = validateCookieInput({ name: "sid", value: "v", domain: ".Example.com", path: "/a", secure: true, httpOnly: "yes", sameSite: "None", expires: -1 });
    expect(r.ok).toBe(true);
    expect(r.cookie).toEqual({ name: "sid", value: "v", domain: ".example.com", path: "/a", secure: true, httpOnly: false, sameSite: "none" });
    const r2: any = validateCookieInput({ name: "n", value: "v", expires: 1_900_000_000 });
    expect(r2.cookie).toMatchObject({ expires: 1_900_000_000, path: "/", secure: false });
    expect(r2.cookie).not.toHaveProperty("domain");
  });

  it.each([
    ["非对象", 5],
    ["数组", []],
    ["空名", { name: "", value: "" }],
    ["名含 =", { name: "a=b", value: "" }],
    ["名含 ;", { name: "a;b", value: "" }],
    ["名含控制字符", { name: "a\nb", value: "" }],
    ["名超长", { name: "x".repeat(257), value: "" }],
    ["值含 ;", { name: "a", value: "x; Domain=evil.com" }],
    ["值含换行", { name: "a", value: "x\r\nSet-Cookie: y=1" }],
    ["值超长", { name: "a", value: "x".repeat(4097) }],
    ["值非字符串", { name: "a", value: 5 }],
    ["非法 domain", { name: "a", value: "", domain: "evil.com/x" }],
    ["domain 带空格", { name: "a", value: "", domain: "a b.com" }],
    ["path 不以 / 开头", { name: "a", value: "", path: "x" }],
    ["path 含 ;", { name: "a", value: "", path: "/x;y" }],
    ["sameSite 非法", { name: "a", value: "", sameSite: "bogus" }],
    ["sameSite=none 但不 secure", { name: "a", value: "", sameSite: "none" }],
    ["expires 非数字", { name: "a", value: "", expires: "tomorrow" }],
    ["expires NaN", { name: "a", value: "", expires: Number.NaN }],
    ["expires 晚于 2100", { name: "a", value: "", expires: 9_999_999_999 }],
  ])("拒绝：%s", (_label, input) => {
    const r: any = validateCookieInput(input);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("拒绝理由里不带 cookie 的值（值是凭据）", () => {
    const r: any = validateCookieInput({ name: "a", value: `${SECRET};bad` });
    expect(r.ok).toBe(false);
    expect(r.reason).not.toContain(SECRET);
  });

  it("toElectronCookie：sameSite 映射回 Electron 写法", () => {
    const c: any = (validateCookieInput({ name: "a", value: "v", secure: true, sameSite: "none", domain: "a.test" }) as any).cookie;
    expect(toElectronCookie(c, "https://a.test/")).toMatchObject({ url: "https://a.test/", sameSite: "no_restriction", domain: "a.test", secure: true });
  });
});

describe("P3·导出文件名净化（路径不由 AI 任意字符串决定）", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["../../../x.json", "x"],
    ["/abs/path/state.json", "state"],
    ["C:\\Users\\me\\state.json", "state"],
    ["a b$c`d", "a_b_c_d"],
    ["state-2026.v1.json", "state-2026.v1"],
    ["..", ""],
    ["...", ""],
    [".json", ""],
    ["", ""],
    ["登录态", ""],
    ["CON", "_CON"],
    ["nul.json", "_nul"],
    ["a/b/..", ""],
    ["x\u0000y", "x_y"],
    // R6-26：多重 .json 后缀 / 去尾部符号后重新露出 .json，都要收敛到不含 .json 结尾的主体
    ["x.json.json", "x"],
    ["x.JSON.Json.json", "x"],
    ["a.json_.json", "a"],
    ["a.json-.json", "a"],
    [".json.json", ""],
    [".json".repeat(30), ""],
  ])("sanitizeStateName(%j) → %j", (raw, want) => {
    expect(sanitizeStateName(raw)).toBe(want);
  });

  it("R6-26：导出返回的名字（主体 + .json）永远能被 strictStateName 原样收回（往返不丢）", () => {
    for (const raw of ["x.json.json", "a.json_.json", "my.JSON", "state-1", "con.json.json", "A".repeat(80) + ".json.json", "a.json" + "_".repeat(70) + ".json"]) {
      const base = sanitizeStateName(raw);
      if (base === "") continue; // 空主体 → 调用方回落到 state-<时间戳>
      expect(base, raw).not.toMatch(/\.json$/i);
      const back: any = strictStateName(`${base}.json`);
      expect(back.ok, raw).toBe(true);
      expect(back.base, raw).toBe(base);
    }
  });

  it("超长截断；结果只含 [A-Za-z0-9._-]、不含路径分隔符、不以点开头", () => {
    const out = sanitizeStateName("a".repeat(500));
    expect(out.length).toBeLessThanOrEqual(STATE_FILE_BASE_MAX);
    for (const raw of ["a/../b", "..\\..\\x", "%2e%2e%2fetc", "a\u202eb", "~root", ".hidden", "x".repeat(200) + "/" + "y".repeat(200)]) {
      const s = sanitizeStateName(raw);
      expect(s, raw).toMatch(/^[A-Za-z0-9_-]?[A-Za-z0-9._-]*$/);
      expect(s).not.toMatch(/[\\/]/);
      expect(s.startsWith(".")).toBe(false);
      expect(s.length).toBeLessThanOrEqual(STATE_FILE_BASE_MAX);
    }
  });

  it("strictStateName（导入用）：只接受导出时返回的名字原样传回，不做「悄悄改写」", () => {
    expect(strictStateName("state-20260101-101010.json")).toEqual({ ok: true, base: "state-20260101-101010" });
    expect(strictStateName("my-login")).toEqual({ ok: true, base: "my-login" });
    for (const bad of ["../x", "../../etc/passwd", "/etc/passwd", "a/b.json", "a b", "x".repeat(STATE_FILE_BASE_MAX + 5), "", "   ", ".json", "con", null as any, 5 as any, "a\u0000b"]) {
      const r: any = strictStateName(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
  });

  it("defaultStateName：state-YYYYMMDD-HHmmss", () => {
    expect(defaultStateName(new Date(2026, 10, 9, 8, 7, 6))).toBe("state-20261109-080706");
  });

  it("stateDirFor：<userData>/data/tasks/<taskId>/browser-state；taskId / userData 不安全一律 null", () => {
    expect(stateDirFor("/u", "t1")).toBe(path.join("/u", "data", "tasks", "t1", "browser-state"));
    for (const bad of ["..", "../x", "a/b", "a\\b", "", "x".repeat(201), "a b", "t1/../t2", undefined, null]) {
      expect(stateDirFor("/u", bad as any), String(bad)).toBeNull();
    }
    expect(stateDirFor("", "t1")).toBeNull();
    expect(stateDirFor(undefined as any, "t1")).toBeNull();
  });
});

describe("P3·导入文件 schema：恶意用例整体拒绝", () => {
  it("合法文件：往返（buildStateFile → parseStateFile），cookie 被规整、过期的被标记", () => {
    const cookies = [
      normalizeCookie({ name: "sid", value: "v1", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_900_000_000 }),
      normalizeCookie({ name: "old", value: "v2", domain: "example.com", path: "/", expirationDate: 1_000_000_000 }),
    ];
    const text = JSON.stringify(buildStateFile({ cookies, origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }], now: new Date(0) }));
    const r: any = parseStateFile(text, deps);
    expect(r.ok).toBe(true);
    expect(r.cookies).toHaveLength(2);
    expect(r.cookies[0]).toMatchObject({ url: "https://example.com/", expired: false });
    expect(r.cookies[1].expired).toBe(true);
    expect(r.origins).toEqual([{ origin: "https://example.com", items: [{ name: "k", value: "v" }] }]);
  });

  it("BOM 开头的 JSON 也能解析", () => {
    expect((parse(`\ufeff${JSON.stringify(goodFile())}`) as any).ok).toBe(true);
  });

  it.each([
    ["不是 JSON", "not json {"],
    ["根是数组", [goodCookie()]],
    ["根是 null", "null"],
    ["根是字符串", '"x"'],
    ["版本不对", goodFile({ version: 2 })],
    ["cookies 不是数组", goodFile({ cookies: { a: 1 } })],
    ["cookies 缺失", { version: 1 }],
    ["origins 不是数组", goodFile({ origins: "x" })],
    ["cookie 条目不是对象", goodFile({ cookies: ["a=b"] })],
    ["cookie 名含 =", goodFile({ cookies: [goodCookie({ name: "a=b" })] })],
    ["cookie 值含 ;", goodFile({ cookies: [goodCookie({ value: "a;b" })] })],
    ["cookie 域非法", goodFile({ cookies: [goodCookie({ domain: "evil.com/x" })] })],
    ["cookie 缺 domain 与 url", goodFile({ cookies: [{ name: "a", value: "b" }] })],
    ["cookie 的 url 非字符串", goodFile({ cookies: [goodCookie({ url: 5 })] })],
    ["url 与 domain 不匹配", goodFile({ cookies: [goodCookie({ domain: "example.com", url: "https://other.test/" })] })],
    ["url 是 javascript:", goodFile({ cookies: [goodCookie({ domain: undefined, url: "javascript:alert(1)" })] })],
    ["url 是 file:", goodFile({ cookies: [goodCookie({ domain: undefined, url: "file:///etc/passwd" })] })],
    ["origin 缺失", goodFile({ origins: [{ localStorage: [] }] })],
    ["origin 非规范（带路径）", goodFile({ origins: [{ origin: "https://example.com/path", localStorage: [] }] })],
    ["origin 非 http(s)", goodFile({ origins: [{ origin: "ftp://example.com", localStorage: [] }] })],
    ["origin 无法解析", goodFile({ origins: [{ origin: "not a url", localStorage: [] }] })],
    ["localStorage 不是数组", goodFile({ origins: [{ origin: "https://example.com", localStorage: {} }] })],
    ["localStorage 条目值不是字符串", goodFile({ origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: 5 }] }] })],
    ["localStorage 条目是 null", goodFile({ origins: [{ origin: "https://example.com", localStorage: [null] }] })],
  ])("拒绝：%s", (_label, doc) => {
    const r: any = parse(doc);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
  });

  it("指向 Flowship origin：cookie 域 / cookie url / origin 任意一处命中，整个文件被拒（不做部分导入）", () => {
    const flow = [
      ["cookie 域名是应用", goodFile({ cookies: [goodCookie(), goodCookie({ domain: appHost })] })],
      ["cookie 域名是应用（带点）", goodFile({ cookies: [goodCookie({ domain: `.${appHost}` })] })],
      ["cookie url 指向应用", goodFile({ cookies: [goodCookie({ domain: undefined, url: "http://127.0.0.1:8876/" })] })],
      ["origin 指向应用", goodFile({ origins: [{ origin: "http://127.0.0.1:8876", localStorage: [] }] })],
      ["origin 指向应用域名", goodFile({ origins: [{ origin: `https://${appHost}`, localStorage: [] }] })],
    ] as const;
    for (const [label, doc] of flow) {
      const r: any = parse(doc);
      expect(r.ok, label).toBe(false);
      expect(r.cookies, label).toBeUndefined();
    }
  });

  it("条数 / 体积上限：cookie > 3000、origins > 20、单 origin 条目 > 1000、整体 > 4MB", () => {
    const many = Array.from({ length: MAX_STATE_COOKIES + 1 }, (_, i) => goodCookie({ name: `c${i}` }));
    expect((parse(goodFile({ cookies: many })) as any).ok).toBe(false);
    const origins = Array.from({ length: MAX_STATE_ORIGINS + 1 }, (_, i) => ({ origin: `https://o${i}.test`, localStorage: [] }));
    expect((parse(goodFile({ origins })) as any).ok).toBe(false);
    const items = Array.from({ length: MAX_STATE_ITEMS_PER_ORIGIN + 1 }, (_, i) => ({ name: `k${i}`, value: "v" }));
    expect((parse(goodFile({ origins: [{ origin: "https://example.com", localStorage: items }] })) as any).ok).toBe(false);
    const big = JSON.stringify(goodFile({ origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "x".repeat(MAX_STATE_BYTES) }] }] }));
    const r: any = parseStateFile(big, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("4MB");
    expect((parseStateFile(5 as any, deps) as any).ok).toBe(false);
  });

  it("上限边界：恰好 3000 条 cookie 通过", () => {
    const edge = Array.from({ length: MAX_STATE_COOKIES }, (_, i) => goodCookie({ name: `c${i}` }));
    expect((parse(goodFile({ cookies: edge })) as any).ok).toBe(true);
  });

  it("拒绝理由不回显 cookie 的值", () => {
    const r: any = parse(goodFile({ cookies: [goodCookie({ value: SECRET }), goodCookie({ name: "bad=name", value: SECRET })] }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("P3·落盘 / 读盘（临时目录：权限、符号链接、清理）", () => {
  let tmp: string;
  let dir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p3-policy-"));
    dir = path.join(tmp, "data", "tasks", "t1", "browser-state");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

  it.skipIf(isWin)("writeStateFile：文件 0600、目录 0700（即使目录已存在且权限宽松）；内容往返；不留临时文件", () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const text = JSON.stringify({ hello: "world" });
    const r = writeStateFile({ dir, base: "my-login", text });
    expect(r.file).toBe("my-login.json");
    expect(r.bytes).toBe(Buffer.byteLength(text));
    expect(modeOf(path.join(dir, "my-login.json"))).toBe(0o600);
    expect(modeOf(dir)).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, "my-login.json"), "utf8")).toBe(text);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(isWin)("全新目录也是 0700；覆盖已有同名文件后仍是 0600", () => {
    writeStateFile({ dir, base: "a", text: "1" });
    expect(modeOf(dir)).toBe(0o700);
    fs.chmodSync(path.join(dir, "a.json"), 0o644);
    writeStateFile({ dir, base: "a", text: "2" });
    expect(modeOf(path.join(dir, "a.json"))).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, "a.json"), "utf8")).toBe("2");
  });

  it.skipIf(isWin)("目标处是指向别处的符号链接：写入替换的是链接本身，被指向的文件原封不动", () => {
    fs.mkdirSync(dir, { recursive: true });
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "ORIGINAL");
    fs.symlinkSync(victim, path.join(dir, "evil.json"));
    writeStateFile({ dir, base: "evil", text: "NEW" });
    expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL");
    expect(fs.lstatSync(path.join(dir, "evil.json")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dir, "evil.json"), "utf8")).toBe("NEW");
  });

  it.skipIf(isWin)("browser-state 目录本身是符号链接 → 拒绝写入 / 读取", () => {
    const real = path.join(tmp, "elsewhere");
    fs.mkdirSync(real);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(real, dir);
    expect(() => writeStateFile({ dir, base: "x", text: "1" })).toThrow(/符号链接|普通目录/);
    expect(fs.readdirSync(real)).toEqual([]);
    fs.writeFileSync(path.join(real, "x.json"), "{}");
    expect(() => readStateFile({ dir, base: "x" })).toThrow(/普通目录/);
  });

  it("目标文件名被目录占用 → 拒绝；超过 4MB → 拒绝且什么都不写", () => {
    fs.mkdirSync(path.join(dir, "d.json"), { recursive: true });
    expect(() => writeStateFile({ dir, base: "d", text: "1" })).toThrow(/目录/);
    const before = fs.readdirSync(dir).sort();
    expect(() => writeStateFile({ dir, base: "big", text: "x".repeat(MAX_STATE_BYTES + 1) })).toThrow(/4MB/);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it.skipIf(isWin)("readStateFile：目标是符号链接 → 拒绝（O_NOFOLLOW），不会读出被指向文件的内容", () => {
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(tmp, "secret.json");
    fs.writeFileSync(secret, JSON.stringify({ cookies: [] }));
    fs.symlinkSync(secret, path.join(dir, "link.json"));
    expect(() => readStateFile({ dir, base: "link" })).toThrow(/符号链接/);
  });

  it("readStateFile：不存在 / 目录不存在 / 目录冒充文件 / 超限 → 各自有清楚的拒绝", () => {
    expect(() => readStateFile({ dir, base: "nope" })).toThrow(/还没有导出过/);
    fs.mkdirSync(dir, { recursive: true });
    expect(() => readStateFile({ dir, base: "nope" })).toThrow(/找不到导出文件/);
    fs.mkdirSync(path.join(dir, "d.json"));
    expect(() => readStateFile({ dir, base: "d" })).toThrow(/不是普通文件|无法读取/);
    fs.writeFileSync(path.join(dir, "huge.json"), Buffer.alloc(MAX_STATE_BYTES + 10, 0x20));
    expect(() => readStateFile({ dir, base: "huge" })).toThrow(/4MB/);
    fs.writeFileSync(path.join(dir, "ok.json"), "{\"a\":1}");
    expect(readStateFile({ dir, base: "ok" })).toBe("{\"a\":1}");
  });

  it("pruneStateDir：只留最新 30 个、删掉超过 14 天的；非 .json / 目录 / 符号链接不动", () => {
    fs.mkdirSync(dir, { recursive: true });
    const now = 2_000_000_000_000;
    for (let i = 0; i < STATE_KEEP_FILES + 5; i += 1) {
      const p = path.join(dir, `f${String(i).padStart(2, "0")}.json`);
      fs.writeFileSync(p, "{}");
      const t = new Date(now - 60_000 - i * 1000);
      fs.utimesSync(p, t, t);
    }
    const oldP = path.join(dir, "ancient.json");
    fs.writeFileSync(oldP, "{}");
    const oldT = new Date(now - STATE_MAX_AGE_MS - 60_000);
    fs.utimesSync(oldP, oldT, oldT);
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    fs.mkdirSync(path.join(dir, "sub.json"));
    const removed = pruneStateDir({ dir, now });
    const left = fs.readdirSync(dir).sort();
    expect(removed).toBe(6); // 5 个超出名额 + 1 个过期
    expect(left).toContain("notes.txt");
    expect(left).toContain("sub.json");
    expect(left).not.toContain("ancient.json");
    expect(left.filter((n) => /^f\d\d\.json$/.test(n))).toHaveLength(STATE_KEEP_FILES);
    expect(left).toContain("f00.json"); // 最新的留下
    expect(left).not.toContain(`f${String(STATE_KEEP_FILES + 4).padStart(2, "0")}.json`);
    expect(pruneStateDir({ dir: path.join(tmp, "missing"), now })).toBe(0);
  });
});
