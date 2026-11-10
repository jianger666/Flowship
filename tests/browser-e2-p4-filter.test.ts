/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P4 / B1 `browser_network` 过滤参数（net-filter.mjs）：type / status / method / url_regex / failed_only / since_id 的真值表，
 * url_regex 的 ReDoS 防护（静态拒绝 + vm 超时，用计时断言证明病态输入不卡死），以及「正则只看脱敏后的 URL」（不做 query 密钥的正则预言机）。
 */
import { describe, expect, it } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { redactUrlSecrets } from "../electron-app/browser/net-detail.mjs";
import * as filterMod from "../electron-app/browser/net-filter.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";

// .mjs 的 JSDoc 推断类型过窄（selectNetworkEntries 的 q 只认 filter / limit / clear），测试里按 any 用
const {
  compileUrlRegex,
  isNetworkLayerFailure,
  NetFilterError,
  normalizeNetworkArgs,
  parseMethodFilter,
  parseStatusFilter,
  parseTypeFilter,
  runRegexBatch,
  selectNetworkEntries,
  URL_REGEX_MAX_CHARS,
  validateUrlRegexSource,
} = filterMod as any;

describe("type / status / method 解析", () => {
  it("type：大小写不敏感、认简称、逗号分隔去重、最多 6 个", () => {
    expect(parseTypeFilter("xhr")).toEqual(["XHR"]);
    expect(parseTypeFilter("XHR, fetch ,xhr")).toEqual(["XHR", "Fetch"]);
    expect(parseTypeFilter("ws,sse,js,css,img,doc")).toEqual(["WebSocket", "EventSource", "Script", "Stylesheet", "Image", "Document"]);
    expect(() => parseTypeFilter("")).toThrow(NetFilterError);
    expect(() => parseTypeFilter("nope")).toThrow(/不认识/);
    expect(() => parseTypeFilter("xhr,fetch,ws,sse,js,css,img")).toThrow(/最多 6/);
  });

  it("status：404 精确 / 4xx 一类 / failed 网络层失败；其余报错", () => {
    expect(parseStatusFilter("404")).toEqual({ kind: "exact", code: 404 });
    expect(parseStatusFilter(404)).toEqual({ kind: "exact", code: 404 });
    expect(parseStatusFilter("4XX")).toEqual({ kind: "class", digit: 4 });
    expect(parseStatusFilter("failed")).toEqual({ kind: "failed" });
    for (const bad of ["", "99", "600", "6xx", "40x", "4xxx", "ok", "-1", "4 04"]) expect(() => parseStatusFilter(bad)).toThrow(NetFilterError);
  });

  it("method：转大写、去重、1–6 个、只允许字母", () => {
    expect(parseMethodFilter("post, put,POST")).toEqual(["POST", "PUT"]);
    expect(() => parseMethodFilter("")).toThrow(NetFilterError);
    expect(() => parseMethodFilter("A,B,C,D,E,F,G")).toThrow(NetFilterError);
    expect(() => parseMethodFilter("PO ST")).toThrow(NetFilterError);
    expect(() => parseMethodFilter("GET;DROP")).toThrow(NetFilterError);
  });
});

describe("url_regex：静态校验真值表", () => {
  it.each([
    ["/api/users"],
    ["^https://a\\.test/(v1|v2)/"],
    ["\\.(png|jpg)$"],
    ["a.*b"],
    ["(?:abc)+"], // 带量词的分组里没有量词 / 竖线：安全
    ["(abc)+"],
    ["[a-z]+\\d{2,4}"],
    ["x{1,3}y"],
    ["(foo|bar)"], // 竖线分组没有重复量词：安全
    ["a?b?c?"],
  ])("接受：%s", (src) => {
    expect(() => validateUrlRegexSource(src)).not.toThrow();
    expect(compileUrlRegex(src)).toBeInstanceOf(RegExp);
  });

  it.each([
    ["(a+)+$", "嵌套量词"],
    ["(a*)*b", "嵌套量词"],
    ["(a|aa)+$", "带量词的分组里有竖线"],
    ["(a|b)*c", "带量词的分组里有竖线"],
    ["(a{2,})+x", "嵌套量词（{n,}）"],
    ["((a+)b)+", "多层嵌套"],
    ["(?:a+)+", "非捕获分组也一样"],
    ["(a+){2,}", "{n,} 重复"],
    ["(.*a)+", "典型 ReDoS"],
    ["(a)\\1", "回溯引用"],
    ["(?<n>a)\\k<n>", "命名引用"],
    ["(?=a)a", "正向环视"],
    ["(?!a)b", "负向环视"],
    ["(?<=a)b", "后行断言"],
    ["(?<!a)b", "负后行断言"],
    ["a*a*a*a*b", "4 个无上界量词（多项式回溯）"],
    ["a+b+c+d+", "4 个无上界量词"],
    ["a{1,}b{1,}c{1,}d{1,}", "4 个 {n,}"],
    ["a\\", "以反斜杠结尾"],
    ["(abc", "括号不匹配"],
    ["abc)", "括号不匹配"],
    ["", "空"],
  ])("拒绝：%s（%s）", (src) => {
    expect(() => validateUrlRegexSource(src)).toThrow(NetFilterError);
  });

  it("长度上限 100：100 可、101 拒", () => {
    expect(() => validateUrlRegexSource("a".repeat(URL_REGEX_MAX_CHARS))).not.toThrow();
    expect(() => validateUrlRegexSource("a".repeat(URL_REGEX_MAX_CHARS + 1))).toThrow(/过长/);
    expect(() => validateUrlRegexSource(5 as never)).toThrow(NetFilterError);
  });

  it("语法错误的正则：报「不是合法的正则」而不是抛出 SyntaxError", () => {
    expect(() => compileUrlRegex("[a-")).toThrow(/不是合法的正则/);
    expect(() => compileUrlRegex("a{2,1}")).toThrow(/不是合法的正则|NetFilterError/);
  });

  it("拒绝文案能让模型自修复（指出怎么改）", () => {
    try {
      validateUrlRegexSource("(a+)+$");
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/改写|不嵌套/);
    }
    try {
      validateUrlRegexSource("a*a*a*a*b");
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/pattern|子串/);
    }
  });
});

describe("url_regex：ReDoS 病态输入不卡死（计时断言）", () => {
  const ATTACK = `${"a".repeat(20_000)}!`;

  it("静态校验拦下的病态写法：在 compile 阶段就被拒，几乎不耗时", () => {
    const t0 = Date.now();
    for (const src of ["(a+)+$", "(a|aa)+$", "(a*)*$", "(.*a){20}", "(a+)+b"]) {
      expect(() => compileUrlRegex(src)).toThrow(NetFilterError);
    }
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("静态校验放行但仍可能很慢的（3 个 .*）对 2 万字符输入：要么快速给出结果，要么被 vm watchdog 打断并报错——绝不卡住", () => {
    const re = compileUrlRegex(".*.*.*x");
    const t0 = Date.now();
    let outcome: "ok" | "timeout" = "ok";
    try {
      runRegexBatch(re, [ATTACK], { timeoutMs: 100 });
    } catch (e) {
      expect(e).toBeInstanceOf(NetFilterError);
      expect(String((e as Error).message)).toMatch(/超时|简化/);
      outcome = "timeout";
    }
    // watchdog 100ms + 调度余量；远低于「真的卡死」的秒级
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(["ok", "timeout"]).toContain(outcome);
  });

  it("绕过静态校验直接把 (a+)+$ 交给 runRegexBatch（模拟将来校验有漏网）：watchdog 兜底，超时报错、耗时有界", () => {
    const re = new RegExp("(a+)+$", "i");
    const t0 = Date.now();
    expect(() => runRegexBatch(re, [ATTACK], { timeoutMs: 150 })).toThrow(NetFilterError);
    expect(Date.now() - t0).toBeLessThan(3000);
    // 超时之后共享上下文仍可用（isolate 没被破坏）
    expect(runRegexBatch(/ok/i, ["ok", "no"])).toEqual([true, false]);
  });

  it("整条 selectNetworkEntries 链路：病态正则（被静态拒绝）抛 NetFilterError、不会进入匹配", () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, url: `https://a.test/${"a".repeat(2000)}!`, type: "Fetch", method: "GET", status: 200 }));
    const t0 = Date.now();
    expect(() => selectNetworkEntries(entries, { urlRegex: "(a+)+$" })).toThrow(NetFilterError);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("超长输入 + 正常正则：500 条 × 2000 字符线性匹配很快", () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, url: `https://a.test/${"a".repeat(2000)}/${i}`, type: "Fetch", method: "GET", status: 200 }));
    const t0 = Date.now();
    const r = selectNetworkEntries(entries, { urlRegex: "/(1|2)\\d$", limit: 500 });
    expect(r.matched).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("selectNetworkEntries：过滤叠加与分页", () => {
  const E = (id: number, o: Record<string, unknown> = {}) => ({ id, url: `https://a.test/r${id}`, type: "Fetch", method: "GET", status: 200, ...o });
  const entries = [
    E(1, { type: "Document", url: "https://a.test/" }),
    E(2, { type: "XHR", method: "POST", status: 404 }),
    E(3, { type: "Fetch", status: 500 }),
    E(4, { type: "WebSocket", status: 101, url: "wss://a.test/ws" }),
    E(5, { type: "XHR", failed: true, errorText: "net::ERR_BLOCKED_BY_CLIENT", status: null }),
    E(6, { type: "EventSource", url: "https://a.test/sse" }),
    E(7, { type: "Image", status: 200, url: "https://a.test/a.png?token=SECRETVALUE1234" }),
    E(8, { type: "Fetch", failed: true, errorText: "", status: 502 }),
  ];
  const ids = (r: { entries: Array<{ id: number }> }) => r.entries.map((e) => e.id);

  it("默认取最近 limit 条（旧行为）", () => {
    expect(ids(selectNetworkEntries(entries, { limit: 3 }))).toEqual([6, 7, 8]);
  });

  it("type / method / status 真值表", () => {
    expect(ids(selectNetworkEntries(entries, { types: ["XHR"] }))).toEqual([2, 5]);
    expect(ids(selectNetworkEntries(entries, { types: ["WebSocket", "EventSource"] }))).toEqual([4, 6]);
    expect(ids(selectNetworkEntries(entries, { methods: ["POST"] }))).toEqual([2]);
    expect(ids(selectNetworkEntries(entries, { status: { kind: "exact", code: 404 } }))).toEqual([2]);
    expect(ids(selectNetworkEntries(entries, { status: { kind: "class", digit: 5 } }))).toEqual([3, 8]);
    expect(ids(selectNetworkEntries(entries, { status: { kind: "class", digit: 1 } }))).toEqual([4]);
    // failed = 网络层失败：有 errorText 的（#5），不含 4xx / 5xx 与没有 errorText 的 failed（#8）
    expect(ids(selectNetworkEntries(entries, { status: { kind: "failed" } }))).toEqual([5]);
    expect(isNetworkLayerFailure(entries[4])).toBe(true);
    expect(isNetworkLayerFailure(entries[7])).toBe(false);
    expect(isNetworkLayerFailure(null)).toBe(false);
  });

  it("failed_only 与旧 filter=failed / xhr 按 AND 叠加", () => {
    expect(ids(selectNetworkEntries(entries, { failedOnly: true }))).toEqual([5, 8]);
    expect(ids(selectNetworkEntries(entries, { filter: "failed" }))).toEqual([5, 8]);
    expect(ids(selectNetworkEntries(entries, { filter: "xhr", types: ["XHR"], failedOnly: true }))).toEqual([5]);
    expect(ids(selectNetworkEntries(entries, { filter: "xhr", methods: ["GET"] }))).toEqual([3, 5, 8]);
  });

  it("since_id：取 id 更大的最早 limit 条，可翻页；lastId 是下次该传的值", () => {
    const p1 = selectNetworkEntries(entries, { sinceId: 2, limit: 2 });
    expect(ids(p1)).toEqual([3, 4]);
    expect(p1).toMatchObject({ matched: 6, hasMore: true, lastId: 4 });
    const p2 = selectNetworkEntries(entries, { sinceId: p1.lastId, limit: 10 });
    expect(ids(p2)).toEqual([5, 6, 7, 8]);
    expect(p2).toMatchObject({ hasMore: false, lastId: 8 });
    // 没有新条目：lastId 不倒退
    expect(selectNetworkEntries(entries, { sinceId: 99 })).toMatchObject({ matched: 0, lastId: 99 });
  });

  it("url_regex 对**脱敏后**的 URL 匹配：不能用正则逐字符猜 query 里的密钥（正则预言机）", () => {
    const redactUrl = redactUrlSecrets;
    expect(redactUrl("https://a.test/a.png?token=SECRETVALUE1234")).not.toContain("SECRETVALUE1234");
    // 直接猜密钥内容 → 匹配不到（脱敏后的 URL 里没有它）
    expect(ids(selectNetworkEntries(entries, { urlRegex: "SECRETVALUE" }, { redactUrl }))).toEqual([]);
    expect(ids(selectNetworkEntries(entries, { urlRegex: "token=S" }, { redactUrl }))).toEqual([]);
    // 对照：匹配未敏感的部分正常
    expect(ids(selectNetworkEntries(entries, { urlRegex: "a\\.png" }, { redactUrl }))).toEqual([7]);
    expect(ids(selectNetworkEntries(entries, { urlRegex: "/R2$" }, { redactUrl }))).toEqual([2]); // 不区分大小写
  });

  it("不改入参数组（纯函数）", () => {
    const snapshot = JSON.stringify(entries);
    selectNetworkEntries(entries, { types: ["XHR"], sinceId: 1, limit: 1 });
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});

describe("normalizeNetworkArgs：op 入参规整（经真实 OP_HELPERS）", () => {
  const n = (args: Record<string, unknown>) => normalizeNetworkArgs(args, OP_HELPERS as any) as Record<string, any>;

  it("旧参数行为不变：默认 filter=all / limit=50 / clear=false", () => {
    expect(n({})).toEqual({ filter: "all", limit: 50, clear: false });
    expect(n({ filter: "failed", limit: 10, clear: true })).toEqual({ filter: "failed", limit: 10, clear: true });
  });

  it("新参数规整成内部结构；failed_only=false 与未传等价", () => {
    const q = n({ type: "xhr,ws", status: "4xx", method: "post", urlRegex: "/api/", failedOnly: true, sinceId: 12 });
    expect(q).toMatchObject({ types: ["XHR", "WebSocket"], status: { kind: "class", digit: 4 }, methods: ["POST"], urlRegex: "/api/", failedOnly: true, sinceId: 12 });
    expect(n({ failedOnly: false }).failedOnly).toBeUndefined();
    expect(n({ status: "" }).status).toBeUndefined();
    // 数值参数沿用仓库的 optNum 约定：越界夹到范围内（负的 since_id → 0），不是错误
    expect(n({ sinceId: -5 }).sinceId).toBe(0);
  });

  it("非法值一律 BAD_ARGS（BrowserError）而不是内部异常", () => {
    for (const bad of [{ type: "nope" }, { status: "xyz" }, { method: "a b" }, { urlRegex: "(a+)+$" }, { urlRegex: "[a-" }, { urlRegex: "\\1" }, { urlRegex: "a".repeat(200) }, { sinceId: "abc" }, { sinceId: Number.NaN }]) {
      try {
        n(bad);
        throw new Error(`应当拒绝：${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(BrowserError);
        expect((e as any).code).toBe("BAD_ARGS");
      }
    }
  });
});
