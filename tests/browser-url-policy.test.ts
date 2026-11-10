/**
 * URL 策略（electron-app/browser/url-policy.mjs）纯逻辑单测：契约 §7。
 * 重点钉死：只放行 http/https 与恰为 about:blank；按 new URL 解析后的真实 host 判定应用地址，
 * 不做字符串前缀匹配（userinfo 伪装两个方向都要判对）。
 */
import { describe, expect, it } from "vitest";

import { checkUrl, normalizeAiUrl, resolveUserInput, SEARCH_URL_PREFIX } from "../electron-app/browser/url-policy.mjs";

/** 假 isAppUrl：只认「真实 host 是回环 + 端口 8876」的应用地址（按解析结果判定，和契约要求一致） */
const isAppUrl = (url: string) => {
  try {
    const u = new URL(url);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]") && u.port === "8876";
  } catch {
    return false;
  }
};
const opts = { isAppUrl };

describe("checkUrl：放行", () => {
  it("http / https 正常放行并返回规整后的 href", () => {
    expect(checkUrl("https://example.com/a?b=1#h", opts)).toEqual({ ok: true, url: "https://example.com/a?b=1#h" });
    expect(checkUrl("http://example.com", opts)).toEqual({ ok: true, url: "http://example.com/" });
  });

  it("恰为 about:blank 放行（大小写 / 首尾空白不敏感），返回固定串", () => {
    expect(checkUrl("about:blank", opts)).toEqual({ ok: true, url: "about:blank" });
    expect(checkUrl("  About:Blank  ", opts)).toEqual({ ok: true, url: "about:blank" });
  });

  it("协议 / 主机大小写被 URL 规整，不影响判定", () => {
    expect(checkUrl("HTTP://EXAMPLE.COM/Path", opts)).toEqual({ ok: true, url: "http://example.com/Path" });
    expect(checkUrl("  https://example.com/a  ", opts).ok).toBe(true);
  });

  it("带 userinfo 的伪装按真实 host 判定：127.0.0.1:8876 是 userinfo、真实 host 是 evil.com → 放行", () => {
    const r = checkUrl("http://127.0.0.1:8876@evil.com/", opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new URL(r.url).hostname).toBe("evil.com");
  });
});

describe("checkUrl：拒绝", () => {
  it.each([
    "file:///etc/passwd",
    "file:///C:/Windows/win.ini",
    "devtools://devtools/bundled/inspector.html",
    "chrome://settings",
    "chrome-extension://abcdefgh/popup.html",
    "view-source:https://example.com/",
    "javascript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "blob:https://example.com/1234",
    "ftp://example.com/file",
    "about:config",
    "about:blank?x=1", // 只有「恰为」about:blank 才放行
    "ws://example.com/socket",
  ])("拒绝协议：%s", (url) => {
    const r = checkUrl(url, opts);
    expect(r.ok).toBe(false);
  });

  it("换行伪装的 javascript: 经 URL 解析后现形、被拒", () => {
    expect(checkUrl("java\nscript:alert(1)", opts).ok).toBe(false);
    expect(checkUrl("java\tscript:alert(1)", opts).ok).toBe(false);
  });

  it("真实 host 是应用地址时拒绝（哪怕前面挂了 userinfo 伪装）", () => {
    expect(checkUrl("http://evil.com@127.0.0.1:8876/tasks", opts).ok).toBe(false);
    expect(checkUrl("http://127.0.0.1:8876/tasks", opts).ok).toBe(false);
    expect(checkUrl("https://localhost:8876/", opts).ok).toBe(false);
  });

  it("isAppUrl 命中即拒绝（与协议无关的第二道闸）", () => {
    const r = checkUrl("https://app.internal/", { isAppUrl: () => true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("应用自身");
  });

  it("空 / 非字符串 / 非法 URL / 超长都拒绝且给中文 reason", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}, "http://", "https://exa mple.com/", ":::not a url"]) {
      const r = checkUrl(bad as never, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    const long = `https://example.com/${"a".repeat(9000)}`;
    const r = checkUrl(long, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("过长");
  });

  it("没传 isAppUrl 时只按协议判定（回环地址本身不拦，拦应用是壳注入的职责）", () => {
    expect(checkUrl("http://127.0.0.1:8876/").ok).toBe(true);
  });
});

describe("normalizeAiUrl：无协议补协议", () => {
  it("普通域名补 https，带路径 / 端口不变", () => {
    expect(normalizeAiUrl("example.com")).toBe("https://example.com");
    expect(normalizeAiUrl("example.com/a/b?x=1")).toBe("https://example.com/a/b?x=1");
    expect(normalizeAiUrl("example.com:8080/a")).toBe("https://example.com:8080/a");
    expect(normalizeAiUrl("sub.example.co.uk")).toBe("https://sub.example.co.uk");
  });

  it("回环 / 本机 host 补 http（本地 dev server 没有 TLS）", () => {
    expect(normalizeAiUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeAiUrl("localhost:3000/dashboard")).toBe("http://localhost:3000/dashboard");
    expect(normalizeAiUrl("localhost/app")).toBe("http://localhost/app");
    expect(normalizeAiUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(normalizeAiUrl("127.0.0.1/app")).toBe("http://127.0.0.1/app");
    expect(normalizeAiUrl("[::1]:3000")).toBe("http://[::1]:3000");
    expect(normalizeAiUrl("LOCALHOST:3000")).toBe("http://LOCALHOST:3000");
  });

  it("已有协议原样返回（放不放行交给 checkUrl）；协议相对补 https", () => {
    expect(normalizeAiUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeAiUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(normalizeAiUrl("//example.com/x")).toBe("https://example.com/x");
  });

  it("空 / 非字符串 / 纯空白返回空串", () => {
    expect(normalizeAiUrl("")).toBe("");
    expect(normalizeAiUrl("   ")).toBe("");
    expect(normalizeAiUrl(null as never)).toBe("");
    expect(normalizeAiUrl(123 as never)).toBe("");
    expect(normalizeAiUrl("  example.com  ")).toBe("https://example.com");
  });
});

describe("resolveUserInput：地址栏输入", () => {
  it("像网址的当网址：裸域名补 https、localhost:3000 补 http", () => {
    expect(resolveUserInput("example.com", opts)).toEqual({ ok: true, url: "https://example.com/", kind: "url" });
    expect(resolveUserInput("example.com/a", opts)).toEqual({ ok: true, url: "https://example.com/a", kind: "url" });
    expect(resolveUserInput("localhost:3000", opts)).toEqual({ ok: true, url: "http://localhost:3000/", kind: "url" });
    expect(resolveUserInput("localhost", opts)).toEqual({ ok: true, url: "http://localhost/", kind: "url" });
    expect(resolveUserInput("https://example.com/x", opts)).toEqual({ ok: true, url: "https://example.com/x", kind: "url" });
  });

  it("裸词 / 带空格的输入走 bing 搜索且做 URL 编码", () => {
    expect(resolveUserInput("hello", opts)).toEqual({
      ok: true,
      url: `${SEARCH_URL_PREFIX}${encodeURIComponent("hello")}`,
      kind: "search",
    });
    const r = resolveUserInput("rust 语言 & 教程?", opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("search");
      expect(r.url).toBe(`${SEARCH_URL_PREFIX}rust%20%E8%AF%AD%E8%A8%80%20%26%20%E6%95%99%E7%A8%8B%3F`);
      expect(r.url).not.toContain(" ");
    }
    // 带空格哪怕长得像网址也当搜索词
    const spaced = resolveUserInput("example .com 好用吗", opts);
    expect(spaced.ok && spaced.kind).toBe("search");
  });

  it("危险协议走网址路径被策略拒绝，不会被悄悄变成搜索", () => {
    expect(resolveUserInput("file:///etc/passwd", opts).ok).toBe(false);
    expect(resolveUserInput("javascript:alert(1)", opts).ok).toBe(false);
    expect(resolveUserInput("data:text/html,hi", opts).ok).toBe(false);
  });

  it("应用自身地址被拒；userinfo 伪装按真实 host 放行", () => {
    expect(resolveUserInput("http://127.0.0.1:8876/tasks", opts).ok).toBe(false);
    const r = resolveUserInput("http://127.0.0.1:8876@evil.com/", opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new URL(r.url).hostname).toBe("evil.com");
  });

  it("空 / 非字符串拒绝", () => {
    expect(resolveUserInput("", opts).ok).toBe(false);
    expect(resolveUserInput("   ", opts).ok).toBe(false);
    expect(resolveUserInput(null as never, opts).ok).toBe(false);
  });
});
