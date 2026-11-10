/**
 * R6-08（调试器 scope 变量名词表 + 值规则的名字侧）/ R6-12（活动日志写入口统一脱敏）/ R6-13（cookie 域 Flowship 排除：真实 createIsAppUrl）。
 * R6-08 的值规则（PEM / 卡号 / JWT）与 R6-14 的两端一致性在 tests/browser-redact-parity.test.ts。
 */
import nodeFs from "node:fs";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { createIsAppUrl } from "../electron-app/browser/app-origin.mjs";
import { isCredentialName } from "../electron-app/browser/debug-policy.mjs";
import { isAppCookieDomain, parseStateFile } from "../electron-app/browser/storage-policy.mjs";
import { checkUrl, normalizeAiUrl } from "../electron-app/browser/url-policy.mjs";

describe("R6-08：scope 变量名凭据词表（按词 / 驼峰 / 下划线分段，不用子串）", () => {
  const hidden = [
    // reviewer 条目原文列出的漏判
    "userPass", "dbPass", "pass", "user_pass", "cvv", "CVV", "cvv2", "cvc", "ssn", "userSsn", "pem", "privateKeyPem", "private_key_pem", "mfa", "mfaCode", "seedPhrase", "seed_phrase",
    "codeVerifier", "code_verifier", "cardNumber", "card_number", "authCode", "auth_code", "oauthCode", "refreshToken",
    // 口径补充的常见词
    "passwd", "pwd", "secret", "token", "apikey", "api_key", "auth", "bearer", "cookie", "session", "credential", "otp", "pin", "signature", "userSignature", "privatekey", "private_key",
  ];
  for (const n of hidden) it(`隐藏：${n}`, () => expect(isCredentialName(n)).toBe(true));

  const visible = [
    // 整词不是凭据（子串匹配会误杀的）
    "author", "authority", "authored", "authorName", "passenger", "passage", "passport", "compass", "bypass", "passed",
    "seeded", "seedling", "pemmican", "signal", "design", "sigma", "assign", "cvvx".replace("cvvx", "cv"),
    // 裸 code 是普通数据（status / error / key code 等）
    "statusCode", "errorCode", "status_code", "zipCode", "postcode", "encode", "decoder", "codec",
    "total", "count", "index", "name", "result",
  ];
  for (const n of visible) it(`不隐藏：${n}`, () => expect(isCredentialName(n)).toBe(false));
});

describe("R6-12：活动日志写入口统一脱敏（红线 2）", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  it("通知标题 / 正文里的 token / 邮箱 / 卡号 → 日志里已打码（addSystem 入口）", () => {
    const log = createActivityLog();
    const e = log.addSystem({
      kind: "notification",
      tabId: "1",
      url: "https://a.test/",
      summary: "页面发出通知（已拦截，未弹系统通知）：「token=abcdef1234567890xyz」— 请联系 bob.smith@example.com，卡号 4111 1111 1111 1111",
    });
    expect(e.summary).not.toContain("abcdef1234567890xyz");
    expect(e.summary).not.toContain("bob.smith@example.com");
    expect(e.summary).not.toContain("4111 1111 1111 1111");
    expect(e.summary).toContain("[已隐藏]");
    expect(e.summary).toContain("页面发出通知"); // 非敏感文字仍在
  });

  it("JWT 在截断点附近也完整脱敏（先脱敏、后截断）：前面塞 120 个字符把 JWT 顶过 160 的截断线", () => {
    const log = createActivityLog();
    const e = log.addSystem({ kind: "notification", summary: `${"x".repeat(120)} ${JWT}` });
    expect(e.summary.length).toBeLessThanOrEqual(160);
    expect(e.summary).not.toContain("eyJ");
    expect(e.summary).not.toMatch(/eyJhbGci/);
    const e2 = log.addSystem({ kind: "notification", summary: `${"y".repeat(130)} ${JWT}` });
    expect(e2.summary).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/); // 不能残留被劈开的前半段
  });

  it("addAI / addSystem / ingest 的 system 分支、控件名、合并更新的 summary 全走同一入口", () => {
    const log = createActivityLog({ recordInputValues: true });
    expect(log.addAI({ kind: "click", summary: "点击了 password=hunter2hunter2" }).summary).not.toContain("hunter2");
    expect(log.ingest({ type: "system", kind: "dialog", summary: `对话框：Bearer ${JWT}` })?.summary).not.toContain("eyJ");
    // 控件名（页面可控的 aria-label）
    const click = log.ingest({ type: "click", tabId: "1", url: "https://a.test/", target: { role: "button", name: "token=ZZZZtopsecret12345" } });
    expect(click?.summary).not.toContain("topsecret");
    expect(click?.target?.name ?? "").not.toContain("topsecret");
    // recordInputValues 开着时，输入值里的凭据也被打码，连续输入合并更新同样如此
    const t = { role: "textbox", name: "备注", tag: "input", inputType: "text" };
    log.ingest({ type: "input", tabId: "1", url: "https://a.test/", target: t, value: "api_key=AAAABBBBCCCC1234", ts: 1000 });
    const merged = log.ingest({ type: "input", tabId: "1", url: "https://a.test/", target: t, value: "api_key=AAAABBBBCCCC1234 and 4111111111111111", ts: 1100 });
    expect(merged?.summary).not.toContain("AAAABBBBCCCC1234");
    expect(merged?.summary).not.toContain("4111111111111111");
  });

  it("幂等：已脱敏的文字再进日志不会叠加占位符、不变形；其它调用点不必（也没有）重复脱敏", () => {
    const log = createActivityLog();
    const once = log.addSystem({ kind: "notification", summary: "通知「token=abcdef1234567890xyz」" }).summary;
    const twice = log.addSystem({ kind: "notification", summary: once }).summary;
    expect(twice).toBe(once);
    expect(twice).not.toContain("[已隐藏][已隐藏]");
    expect(log.addSystem({ kind: "navigate", summary: "打开了页面 https://a.test/docs" }).summary).toBe("打开了页面 https://a.test/docs");
  });

  it("超长自由文本不卡死（窗口截取后脱敏）", () => {
    const log = createActivityLog();
    const t0 = Date.now();
    log.addSystem({ kind: "notification", summary: `${"a ".repeat(500_000)}token=abcdef1234567890xyz` });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("接线：permission-gate 的通知文字在 cleanPromptText 截断之前先脱敏", () => {
    const src = nodeFs.readFileSync(new URL("../electron-app/browser/permission-gate.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/cleanPromptText\(redactSensitiveText\(String\(data\.t \?\? ""\)\.slice\(0, 2048\)\), NOTIFY_TITLE_MAX\)/);
    expect(src).toMatch(/cleanPromptText\(redactSensitiveText\(String\(data\.b \?\? ""\)\.slice\(0, 2048\)\), NOTIFY_BODY_MAX\)/);
  });
});

describe("R6-13：cookie 域的 Flowship 排除——用真实 createIsAppUrl（不再用假主机名）", () => {
  const real = createIsAppUrl(() => 8876);
  const checkReal = (url: string) => {
    const v = checkUrl(normalizeAiUrl(url), { isAppUrl: real });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason };
  };
  const deps = { checkUrl: checkReal, isAppUrl: real, now: () => 1_700_000_000_000 };
  const file = (cookie: Record<string, unknown>) => JSON.stringify({ version: 1, cookies: [{ name: "sid", value: "abc", path: "/", secure: false, httpOnly: false, sameSite: "lax", ...cookie }], origins: [] });

  it("真实 isAppUrl：带 Flowship 端口的 URL 被判为应用自身，同主机其它端口 / 无端口不是", () => {
    expect(real("http://localhost:8876/")).toBe(true);
    expect(real("http://127.0.0.1:8876/x")).toBe(true);
    expect(real("http://[::1]:8876/")).toBe(true);
    expect(real("http://localhost:3000/")).toBe(false);
    expect(real("http://localhost/")).toBe(false);
  });

  it("isAppCookieDomain 对 loopback 域名不生效（cookie 不分端口，如实钉住；不会整体排除用户自己的 localhost 开发站）", () => {
    for (const host of ["localhost", ".localhost", "127.0.0.1", "::1", "[::1]", "foo.localhost"]) {
      expect(isAppCookieDomain(host, real), host).toBe(false);
    }
    // 非法域名仍按「不能碰」；isAppUrl 抛错同理（fail-closed）
    expect(isAppCookieDomain("not a domain", real)).toBe(true);
    expect(isAppCookieDomain("localhost", () => { throw new Error("x"); })).toBe(true);
  });

  it("import_state：带 Flowship 端口的 URL → 整个文件被拒（真正的排除在 URL 策略这一层）", () => {
    for (const url of ["http://localhost:8876/", "http://127.0.0.1:8876/app", "http://[::1]:8876/"]) {
      const r = parseStateFile(file({ domain: "localhost", url }), deps);
      expect(r.ok, url).toBe(false);
    }
  });

  it("import_state：不带端口的 loopback 域（用户自己的开发站）不被误排除", () => {
    for (const domain of ["localhost", "127.0.0.1"]) {
      const r = parseStateFile(file({ domain }), deps);
      expect(r.ok, `${domain}: ${r.ok ? "" : r.reason}`).toBe(true);
    }
    const dev = parseStateFile(file({ domain: "localhost", url: "http://localhost:3000/" }), deps);
    expect(dev.ok).toBe(true);
  });
});
