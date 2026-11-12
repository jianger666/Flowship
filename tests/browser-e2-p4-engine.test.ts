/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P4 / A5 网络规则引擎（纯逻辑）：pattern 规整与匹配、头校验（禁改清单 / 头注入）、规则定义校验（mock ≤1MB / delay ≤30s / 多余参数）、
 * 规则仓库（每 tab ≤20 条）、命中决策（Flowship origin 永不处理）、`Fetch.requestPaused` 处理器「恰好一次 + 兜底」。
 * 真实 tab / session 的接线见 browser-e2-p4-ops.test.ts，真 CDP 见 scripts/browser-e2e/e2-p4-net-rules.cjs。
 */
import { describe, expect, it, vi } from "vitest";

import * as engineMod from "../electron-app/browser/net-rules-engine.mjs";

// .mjs 的 JSDoc 推断类型过窄（如 buildRuleDef 的返回值没有 mock / headers 字段），测试里按 any 用
const {
  ALLOWED_RESPONSE_HEADERS,
  buildFulfillParams,
  buildRuleDef,
  createPauseController,
  createRuleStore,
  decideForRequest,
  describeRule,
  FAIL_REASONS,
  FORBIDDEN_REQUEST_HEADERS,
  globMatch,
  isConfirmedSameOrigin,
  isCorsPreflight,
  isForbiddenRequestHeader,
  isForbiddenResponseHeader,
  MAX_DELAY_MS,
  MAX_MOCK_BODY_BYTES,
  MAX_RULES_PER_TAB,
  mergeRequestHeaders,
  NetRuleError,
  normalizePattern,
  normalizeRuleHeaders,
  PAUSE_SAFETY_SLACK_MS,
  REFUSE_URL,
  requestHasBody,
  terminalWouldCrashChromium,
  toCdpUrlPattern,
} = engineMod as any;

const SECRET = "sk-live-SUPERSECRETVALUE123456";

describe("normalizePattern：整个 URL 的 glob", () => {
  it("接受 http(s):// 开头或 * 开头；scheme / host 规整成小写，path 保持原样；连续 * 合并", () => {
    expect(normalizePattern("HTTPS://API.Example.COM/V1/*")).toBe("https://api.example.com/V1/*");
    expect(normalizePattern("*/api/users**")).toBe("*/api/users*");
    expect(normalizePattern("*")).toBe("*");
    expect(normalizePattern("http://127.0.0.1:8080/x?y=1")).toBe("http://127.0.0.1:8080/x?y=1");
  });

  it.each([
    ["缺失", undefined],
    ["空串", ""],
    ["非字符串", 123],
    ["没有 scheme 也不以 * 开头", "example.com/api"],
    ["相对路径", "/api/x"],
    ["含空格", "https://a.test/a b"],
    ["含换行", "https://a.test/a\nb"],
    ["含控制字符", "https://a.test/a\u0000b"],
    ["含反斜杠", "https://a.test/a\\b"],
    ["带 #fragment", "https://a.test/a#frag"],
    ["WebSocket scheme（拦不了）", "wss://a.test/ws"],
    ["ws scheme", "ws://a.test/ws"],
    ["超长", `https://a.test/${"a".repeat(600)}`],
  ])("拒绝：%s", (_n, raw) => {
    expect(() => normalizePattern(raw)).toThrow(NetRuleError);
  });

  it("报错文案能让模型自修复（给出改法）", () => {
    try {
      normalizePattern("example.com/api");
    } catch (e) {
      expect(String((e as Error).message)).toContain("http://");
      expect(String((e as Error).message)).toContain("*");
    }
  });
});

describe("globMatch：* 通配、其余按字面（含 ?）", () => {
  it.each([
    ["https://a.test/*", "https://a.test/x/y?z=1", true],
    ["*/api/*", "https://a.test/api/users", true],
    ["*/api/*", "https://a.test/v1/users", false],
    ["https://a.test/x?y=1", "https://a.test/x?y=1", true],
    ["https://a.test/x?y=1", "https://a.test/xAy=1", false], // ? 不是通配符
    ["*.png", "https://a.test/a.png", true],
    ["*.png", "https://a.test/a.png?x=1", false],
    ["*a*b*c", "xaxbxc", true],
    ["*a*b*c", "xaxcxb", false],
    ["*", "", true],
    ["a", "", false],
    ["", "", true],
  ])("%s ⟷ %s → %s", (p, t, ok) => {
    expect(globMatch(p, t)).toBe(ok);
  });

  it("病态 pattern（*a*a*a*…*b）对 2 万字符 URL 不会指数 / 多项式卡死（不用正则）", () => {
    const pattern = `${"*a".repeat(12)}*b`;
    const text = "a".repeat(20_000);
    const t0 = Date.now();
    expect(globMatch(pattern, text)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("toCdpUrlPattern：CDP 里 ? 是单字符通配，所以字面 ? 要转义", () => {
    expect(toCdpUrlPattern("https://a.test/x?y=1*")).toBe("https://a.test/x\\?y=1*");
  });
});

describe("normalizeRuleHeaders：禁改清单 / 头注入 / 形状", () => {
  it("数组、对象、JSON 字符串三种写法都收；同名（大小写不敏感）后者覆盖前者", () => {
    expect(normalizeRuleHeaders([{ name: "X-A", value: "1" }], { kind: "request" })).toEqual([{ name: "X-A", value: "1" }]);
    expect(normalizeRuleHeaders({ "X-A": "1", "x-a": "2" }, { kind: "request" })).toEqual([{ name: "x-a", value: "2" }]);
    expect(normalizeRuleHeaders('{"X-B":"v"}', { kind: "request" })).toEqual([{ name: "X-B", value: "v" }]);
    expect(normalizeRuleHeaders({ "X-N": 5 }, { kind: "request" })).toEqual([{ name: "X-N", value: "5" }]);
  });

  it.each(["Host", "host", "Content-Length", "Transfer-Encoding", "Connection", "Keep-Alive", "Upgrade", "TE", "Trailer", "Expect", "Proxy-Connection", "Proxy-Authorization", "proxy-x", "Cookie", "Cookie2", "Sec-Fetch-Mode", "sec-ch-ua"])(
    "请求头禁改：%s",
    (name) => {
      expect(isForbiddenRequestHeader(name)).toBe(true);
      expect(() => normalizeRuleHeaders({ [name]: "x" }, { kind: "request" })).toThrow(NetRuleError);
    },
  );

  it("允许 Authorization / Origin / Referer / User-Agent / Accept-*（调试常见需求）", () => {
    for (const n of ["Authorization", "Origin", "Referer", "User-Agent", "Accept-Language", "X-Debug"]) {
      expect(isForbiddenRequestHeader(n)).toBe(false);
      expect(() => normalizeRuleHeaders({ [n]: "v" }, { kind: "request" })).not.toThrow();
    }
    // 清单本身要钉住（防止被悄悄改小）
    for (const n of ["host", "content-length", "transfer-encoding", "connection", "cookie"]) expect(FORBIDDEN_REQUEST_HEADERS.has(n)).toBe(true);
  });

  it("mock 响应头禁改：Content-Length / Content-Encoding / Transfer-Encoding / Connection / Set-Cookie（mock 不能成为写 cookie 的通道；R6-32 起是白名单，完整矩阵见 browser-r6-mock-allowlist.test.ts）", () => {
    for (const n of ["Content-Length", "content-encoding", "Transfer-Encoding", "Connection", "Set-Cookie", "set-cookie2"]) {
      expect(isForbiddenResponseHeader(n)).toBe(true);
      expect(() => normalizeRuleHeaders({ [n]: "x" }, { kind: "response" })).toThrow(NetRuleError);
    }
    expect(ALLOWED_RESPONSE_HEADERS.includes("set-cookie")).toBe(false);
    expect(() => normalizeRuleHeaders({ "X-Mock": "1", "Access-Control-Allow-Origin": "*" }, { kind: "response" })).not.toThrow();
  });

  it.each([
    ["值含 CRLF（头注入）", { "X-A": "a\r\nSet-Cookie: x=1" }],
    ["值含换行", { "X-A": "a\nb" }],
    ["值含 NUL", { "X-A": "a\u0000b" }],
    ["值含非 Latin-1 字符", { "X-A": "你好" }],
    ["值过长", { "X-A": "a".repeat(2001) }],
    ["头名含空格", { "X A": "1" }],
    ["头名含冒号", { "X:A": "1" }],
    ["头名为空", { "": "1" }],
    ["头名过长", { ["X".repeat(101)]: "1" }],
    ["值是对象", { "X-A": { a: 1 } }],
    ["空对象", {}],
    ["空数组", []],
    ["数组项不是对象", ["X-A: 1"]],
    ["不是 JSON 的字符串", "X-A: 1"],
    ["空串", "  "],
    ["数字", 5],
  ])("拒绝：%s", (_n, raw) => {
    expect(() => normalizeRuleHeaders(raw, { kind: "request" })).toThrow(NetRuleError);
  });

  it("超过 20 个头被拒", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]));
    expect(() => normalizeRuleHeaders(many, { kind: "request" })).toThrow(NetRuleError);
    expect(() => normalizeRuleHeaders(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`X-H${i}`, "v"])), { kind: "request" })).not.toThrow();
  });
});

describe("buildRuleDef：各 action 的校验与规整", () => {
  it("block：只要 pattern；带 headers / status 等多余参数被拒（模型多半选错了 action）", () => {
    expect(buildRuleDef({ action: "block", pattern: "*/ads/*" })).toEqual({ action: "block", pattern: "*/ads/*" });
    expect(() => buildRuleDef({ action: "block", pattern: "*/ads/*", headers: { A: "1" } })).toThrow(/不接受参数 headers/);
    expect(() => buildRuleDef({ action: "block", pattern: "*/ads/*", status: 500 })).toThrow(NetRuleError);
    // null / undefined 视为没传
    expect(() => buildRuleDef({ action: "block", pattern: "*/ads/*", headers: undefined, status: null })).not.toThrow();
  });

  it("set_headers：必须有 headers；值进规则对象，禁改头被拒", () => {
    const d = buildRuleDef({ action: "set_headers", pattern: "*/api/*", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(d.headers).toEqual([{ name: "Authorization", value: `Bearer ${SECRET}` }]);
    expect(() => buildRuleDef({ action: "set_headers", pattern: "*/api/*" })).toThrow(/需要 headers/);
    expect(() => buildRuleDef({ action: "set_headers", pattern: "*/api/*", headers: { Host: "evil.test" } })).toThrow(NetRuleError);
    expect(() => buildRuleDef({ action: "set_headers", pattern: "*/api/*", headers: { Cookie: "sid=1" } })).toThrow(/browser_storage/);
  });

  it("mock：status 默认 200、范围 200–599；content-type 缺省按 body 猜；body ≤ 1MB（恰好 1MB 可、多 1 字节不可）", () => {
    const j = buildRuleDef({ action: "mock", pattern: "*/api/*", body: '{"ok":true}' });
    expect(j.mock).toMatchObject({ status: 200, contentType: "application/json; charset=utf-8", body: '{"ok":true}', headers: [] });
    expect(buildRuleDef({ action: "mock", pattern: "*/x", body: "hi" }).mock.contentType).toBe("text/plain; charset=utf-8");
    expect(buildRuleDef({ action: "mock", pattern: "*/x", status: "404" }).mock.status).toBe(404);
    for (const bad of [199, 600, 1.5, "abc", -1]) expect(() => buildRuleDef({ action: "mock", pattern: "*/x", status: bad })).toThrow(NetRuleError);

    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", body: "a".repeat(MAX_MOCK_BODY_BYTES) })).not.toThrow();
    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", body: "a".repeat(MAX_MOCK_BODY_BYTES + 1) })).toThrow(/1MB/);
    // 按字节算：多字节字符 35 万个「中」≈ 1.05MB
    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", body: "中".repeat(350_000) })).toThrow(/1MB/);
    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", body: { a: 1 } })).toThrow(/字符串/);
  });

  it("mock：Content-Type 头并入 contentType；contentType 写法不合法被拒（防头注入）；响应头禁 Set-Cookie", () => {
    const d = buildRuleDef({ action: "mock", pattern: "*/x", headers: { "Content-Type": "text/html", "X-Mock": "1" } });
    expect(d.mock.contentType).toBe("text/html");
    expect(d.mock.headers).toEqual([{ name: "X-Mock", value: "1" }]);
    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", contentType: "text/html\r\nSet-Cookie: a=1" })).toThrow(NetRuleError);
    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", contentType: "not a type" })).toThrow(NetRuleError);
    expect(() => buildRuleDef({ action: "mock", pattern: "*/x", headers: { "Set-Cookie": "a=1" } })).toThrow(NetRuleError);
  });

  it("fail：error_reason 默认 Failed，只认白名单", () => {
    expect(buildRuleDef({ action: "fail", pattern: "*/x" }).errorReason).toBe("Failed");
    for (const r of FAIL_REASONS) expect(buildRuleDef({ action: "fail", pattern: "*/x", errorReason: r }).errorReason).toBe(r);
    expect(() => buildRuleDef({ action: "fail", pattern: "*/x", errorReason: "Evil" })).toThrow(/error_reason/);
    expect(() => buildRuleDef({ action: "fail", pattern: "*/x", errorReason: 5 })).toThrow(NetRuleError);
  });

  it("delay：必填，整数 1–30000ms", () => {
    expect(buildRuleDef({ action: "delay", pattern: "*/x", delayMs: 1 }).delayMs).toBe(1);
    expect(buildRuleDef({ action: "delay", pattern: "*/x", delayMs: MAX_DELAY_MS }).delayMs).toBe(30_000);
    expect(buildRuleDef({ action: "delay", pattern: "*/x", delayMs: "500" }).delayMs).toBe(500);
    expect(() => buildRuleDef({ action: "delay", pattern: "*/x" })).toThrow(/delay_ms/);
    for (const bad of [0, -5, 30_001, 1.5, "x", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildRuleDef({ action: "delay", pattern: "*/x", delayMs: bad })).toThrow(NetRuleError);
    }
  });

  it("未知 action 被拒", () => {
    expect(() => buildRuleDef({ action: "list", pattern: "*" })).toThrow(NetRuleError);
    expect(() => buildRuleDef({ action: "redirect", pattern: "*" })).toThrow(NetRuleError);
  });
});

describe("describeRule：对外视图不含头值 / body", () => {
  it("set_headers 只给头名；mock 只给大小与头名", () => {
    const store = createRuleStore();
    const a = store.add(buildRuleDef({ action: "set_headers", pattern: "*/api/*", headers: { Authorization: `Bearer ${SECRET}`, "X-Token": SECRET } }));
    const b = store.add(buildRuleDef({ action: "mock", pattern: "*/m", body: `{"token":"${SECRET}"}`, headers: { "X-Mock": SECRET } }));
    const views = [describeRule(a), describeRule(b)];
    expect(JSON.stringify(views)).not.toContain(SECRET);
    expect(views[0].headerNames).toEqual(["Authorization", "X-Token"]);
    expect(views[1]).toMatchObject({ action: "mock", status: 200, headerNames: ["X-Mock"] });
    expect(views[1].bodyBytes).toBe(Buffer.byteLength(`{"token":"${SECRET}"}`));
    expect(JSON.stringify(store.list())).not.toContain(SECRET);
    // test 闭包不外泄
    expect(Object.keys(views[0])).not.toContain("test");
  });
});

describe("createRuleStore：每 tab ≤ 20 条", () => {
  it("第 21 条被拒且文案给出清理办法；id 单调递增，clear 后不回绕", () => {
    const s = createRuleStore();
    for (let i = 0; i < MAX_RULES_PER_TAB; i += 1) expect(s.add({ action: "block", pattern: `*/${i}` }).id).toBe(`r${i + 1}`);
    expect(s.count()).toBe(20);
    expect(() => s.add({ action: "block", pattern: "*/overflow" })).toThrow(/上限 20/);
    expect(s.count()).toBe(20);
    expect(s.clear()).toBe(20);
    expect(s.add({ action: "block", pattern: "*/again" }).id).toBe("r21");
  });

  it("remove 只删指定 id；cdpPatterns 同 pattern 去重、字面 ? 转义、只拦请求阶段", () => {
    const s = createRuleStore();
    const a = s.add({ action: "block", pattern: "*/a?x" });
    s.add({ action: "delay", pattern: "*/a?x", delayMs: 5 });
    s.add({ action: "block", pattern: "*/b" });
    expect(s.cdpPatterns()).toEqual([
      { urlPattern: "*/a\\?x", requestStage: "Request" },
      { urlPattern: "*/b", requestStage: "Request" },
    ]);
    expect(s.remove(a.id)).toBe(true);
    expect(s.remove("r999")).toBe(false);
    expect(s.count()).toBe(2);
  });
});

describe("decideForRequest：命中决策", () => {
  const mk = (...defs: any[]) => {
    const s = createRuleStore();
    for (const d of defs) s.add(buildRuleDef(d));
    return s.rules();
  };
  const req = (url: string, extra: Record<string, unknown> = {}) => ({ url, method: "GET", headers: { Accept: "*/*" }, ...extra });

  it("没命中 → 原样放行（untouched）", () => {
    const d = decideForRequest(mk({ action: "block", pattern: "*/ads/*" }), req("https://a.test/api"));
    expect(d).toMatchObject({ verdict: "continue", untouched: true, delayMs: 0, ruled: null });
  });

  it("block → failRequest(BlockedByClient)；fail → 指定原因；mock → fulfill", () => {
    expect(decideForRequest(mk({ action: "block", pattern: "*/ads/*" }), req("https://a.test/ads/1"))).toMatchObject({ verdict: "fail", errorReason: "BlockedByClient", ruled: "block" });
    expect(decideForRequest(mk({ action: "fail", pattern: "*/f", errorReason: "ConnectionRefused" }), req("https://a.test/f"))).toMatchObject({
      verdict: "fail",
      errorReason: "ConnectionRefused",
      ruled: "fail",
    });
    expect(decideForRequest(mk({ action: "mock", pattern: "*/m", body: "x", status: 418 }), req("https://a.test/m"))).toMatchObject({ verdict: "fulfill", ruled: "mock", mock: { status: 418 } });
  });

  it("先创建的终结类规则赢；delay 取最长且与任何结果叠加；set_headers 全部合并（后创建的覆盖同名）", () => {
    const rules = mk(
      { action: "mock", pattern: "*/x", body: "first" },
      { action: "block", pattern: "*/x" },
      { action: "delay", pattern: "*/x", delayMs: 100 },
      { action: "delay", pattern: "*/x", delayMs: 300 },
      { action: "set_headers", pattern: "*/x", headers: { "X-A": "1", "X-B": "1" } },
      { action: "set_headers", pattern: "*/x", headers: { "x-a": "2" } },
    );
    const d = decideForRequest(rules, req("https://a.test/x"));
    expect(d.verdict).toBe("fulfill");
    expect(d.mock.body).toBe("first");
    expect(d.delayMs).toBe(300);
    expect(Object.fromEntries(d.extraHeaders.map((h: any) => [h.name.toLowerCase(), h.value]))).toEqual({ "x-a": "2", "x-b": "1" });
    expect(d.matched).toHaveLength(6);
  });

  it("只有 delay / set_headers → continue 且打 delay / headers 标记", () => {
    expect(decideForRequest(mk({ action: "delay", pattern: "*/x", delayMs: 5 }), req("https://a.test/x"))).toMatchObject({ verdict: "continue", ruled: "delay", delayMs: 5 });
    expect(decideForRequest(mk({ action: "set_headers", pattern: "*/x", headers: { A: "1" } }), req("https://a.test/x"))).toMatchObject({ verdict: "continue", ruled: "headers" });
  });

  it("红线：Flowship 自身 origin 永不处理——即使 pattern 是 `*`、即使 block / mock", () => {
    const rules = mk({ action: "block", pattern: "*" }, { action: "mock", pattern: "*", body: "x" }, { action: "set_headers", pattern: "*", headers: { A: SECRET } });
    const isAppUrl = (u: string) => u.startsWith("http://localhost:18876/");
    expect(decideForRequest(rules, req("http://localhost:18876/api/tasks"), { isAppUrl })).toMatchObject({ verdict: "continue", untouched: true });
    // 对照：别的 origin 照常被处理
    expect(decideForRequest(rules, req("http://localhost:3000/"), { isAppUrl }).verdict).toBe("fail");
  });

  it("isAppUrl 抛错 → 保守放行（宁可规则不生效也不误伤 Flowship）", () => {
    const rules = mk({ action: "block", pattern: "*" });
    const d = decideForRequest(rules, req("https://a.test/"), {
      isAppUrl: () => {
        throw new Error("boom");
      },
    });
    expect(d.untouched).toBe(true);
  });

  it("非 http(s) URL（data: / blob: / file: / chrome:）一律不碰", () => {
    const rules = mk({ action: "block", pattern: "*" });
    for (const u of ["data:text/html,hi", "blob:https://a.test/1", "file:///etc/passwd", "chrome://version", "", undefined]) {
      expect(decideForRequest(rules, req(u as string)).untouched).toBe(true);
    }
  });

  it("超长 URL 只看前 16384 字符，不会把主进程拖住", () => {
    const rules = mk({ action: "block", pattern: "*zzz" });
    const url = `https://a.test/${"a".repeat(2_000_000)}zzz`;
    const t0 = Date.now();
    // 末尾的 zzz 在截断范围之外 → 不命中
    expect(decideForRequest(rules, req(url)).untouched).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("mergeRequestHeaders / buildFulfillParams", () => {
  it("continueRequest 的 headers 是整体替换：保留原头、同名（大小写不敏感）以规则为准", () => {
    const out = mergeRequestHeaders({ Accept: "*/*", "x-a": "old" }, [{ name: "X-A", value: "new" }, { name: "X-B", value: "1" }]);
    expect(out).toEqual([
      { name: "Accept", value: "*/*" },
      { name: "X-A", value: "new" },
      { name: "X-B", value: "1" },
    ]);
    expect(mergeRequestHeaders(undefined, [{ name: "A", value: "1" }])).toEqual([{ name: "A", value: "1" }]);
  });

  it("mock 响应：body 走 base64；带 Origin 的跨域请求自动回显 ACAO，已写 ACAO 就不覆盖", () => {
    const mock = { status: 201, contentType: "application/json", headers: [{ name: "X-M", value: "1" }], body: '{"a":"中"}' };
    const p = buildFulfillParams(mock, { method: "GET", headers: { Origin: "https://app.test" } }, "R1");
    expect(p.requestId).toBe("R1");
    expect(p.responseCode).toBe(201);
    expect(Buffer.from(p.body, "base64").toString("utf8")).toBe('{"a":"中"}');
    expect(p.responseHeaders.find((h: any) => h.name === "Access-Control-Allow-Origin")?.value).toBe("https://app.test");
    const own = buildFulfillParams({ ...mock, headers: [{ name: "access-control-allow-origin", value: "*" }] }, { method: "GET", headers: { Origin: "https://app.test" } }, "R2");
    expect(own.responseHeaders.filter((h: any) => h.name.toLowerCase() === "access-control-allow-origin")).toHaveLength(1);
    // 没有 Origin 头：不加 CORS 头
    const same = buildFulfillParams(mock, { method: "GET", headers: {} }, "R3");
    expect(same.responseHeaders.some((h: any) => /access-control/i.test(h.name))).toBe(false);
  });

  it("CORS 预检（OPTIONS + Access-Control-Request-Method）命中 mock 时由系统代答 204，不返回 mock 的 body；Origin 里带控制字符不会进头", () => {
    const pre = { method: "OPTIONS", headers: { Origin: "https://app.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } };
    expect(isCorsPreflight(pre)).toBe(true);
    expect(isCorsPreflight({ method: "OPTIONS", headers: {} })).toBe(false);
    const p = buildFulfillParams({ status: 200, contentType: "text/plain", headers: [], body: "BODY" }, pre, "R");
    expect(p.responseCode).toBe(204);
    expect(p.body).toBe("");
    expect(p.responseHeaders.find((h: any) => h.name === "Access-Control-Allow-Methods")?.value).toBe("POST");
    const evil = buildFulfillParams({ status: 200, contentType: "text/plain", headers: [], body: "" }, { method: "OPTIONS", headers: { Origin: "https://a\r\nX-Evil: 1", "Access-Control-Request-Method": "GET" } }, "R");
    expect(JSON.stringify(evil.responseHeaders)).not.toContain("X-Evil");
  });
});

// ───────────────────────── Fetch.requestPaused 处理器 ─────────────────────────

const mkController = (
  rules: any[],
  opts: { paused?: () => boolean; isAppUrl?: (u: string) => boolean; send?: (m: string, p: any, s: any) => Promise<unknown>; onRuled?: (i: any) => void; log?: (m: string) => void } = {},
) => {
  const sent: Array<{ method: string; params: any; sessionId: string | null }> = [];
  const send = vi.fn(async (method: string, params: any, sessionId: string | null) => {
    sent.push({ method, params, sessionId });
    return opts.send ? opts.send(method, params, sessionId) : {};
  });
  const c = createPauseController({ send, getRules: () => rules, isPaused: opts.paused ?? (() => false), isAppUrl: opts.isAppUrl, onRuled: opts.onRuled, log: opts.log ?? (() => {}) });
  return { c, sent, send };
};
const ev = (requestId: string, url: string, extra: Record<string, unknown> = {}) => ({ requestId, networkId: `n-${requestId}`, request: { url, method: "GET", headers: { Accept: "*/*" } }, ...extra });
const rulesOf = (...defs: any[]) => {
  const s = createRuleStore();
  for (const d of defs) s.add(buildRuleDef(d));
  return s.rules();
};

describe("createPauseController：恰好一次 + 兜底", () => {
  it("没命中 → continueRequest；命中 block → failRequest(BlockedByClient)；mock → fulfillRequest；set_headers → continueRequest 带整体 headers", async () => {
    const rules = rulesOf({ action: "block", pattern: "*/b" }, { action: "mock", pattern: "*/m", body: "ok", status: 202 }, { action: "set_headers", pattern: "*/h", headers: { "X-Dbg": "1" } });
    const { c, sent } = mkController(rules);
    await c.onPaused(ev("1", "https://a.test/none"));
    await c.onPaused(ev("2", "https://a.test/b"));
    await c.onPaused(ev("3", "https://a.test/m"));
    await c.onPaused(ev("4", "https://a.test/h"));
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest", "Fetch.failRequest", "Fetch.fulfillRequest", "Fetch.continueRequest"]);
    expect(sent[1].params).toEqual({ requestId: "2", errorReason: "BlockedByClient" });
    expect(sent[2].params).toMatchObject({ requestId: "3", responseCode: 202 });
    expect(sent[3].params.headers).toEqual([
      { name: "Accept", value: "*/*" },
      { name: "X-Dbg", value: "1" },
    ]);
    expect(c.pendingCount()).toBe(0);
  });

  it("挂起（等延迟）期间重复到达的同一暂停事件被忽略：整个过程只发一次命令", async () => {
    const { c, sent } = mkController(rulesOf({ action: "delay", pattern: "*", delayMs: 40 }));
    const p = ev("1", "https://a.test/x");
    await Promise.all([c.onPaused(p), c.onPaused(p), c.onPaused(p)]);
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
    expect(c.pendingCount()).toBe(0);
    // 同 requestId 在不同 CDP 会话里是两个独立的暂停（key 含 sessionId）
    const q = ev("2", "https://a.test/x");
    await Promise.all([c.onPaused(q, "s1"), c.onPaused(q, "s2")]);
    expect(sent.filter((s) => s.params.requestId === "2")).toHaveLength(2);
  });

  it("sessionId 透传：子会话（OOPIF）里的请求用子会话回复", async () => {
    const { c, sent } = mkController(rulesOf({ action: "block", pattern: "*" }));
    await c.onPaused(ev("1", "https://a.test/x"), "child-1");
    expect(sent[0].sessionId).toBe("child-1");
  });

  it("响应阶段的暂停不是我们的：一律不碰（否则会抢走别人的请求）", async () => {
    const { c, sent } = mkController(rulesOf({ action: "block", pattern: "*" }));
    await c.onPaused(ev("1", "https://a.test/x", { responseStatusCode: 200 }));
    await c.onPaused(ev("2", "https://a.test/x", { responseErrorReason: "Failed" }));
    await c.onPaused({ requestId: "" });
    await c.onPaused({});
    await c.onPaused(null as never);
    expect(sent).toHaveLength(0);
  });

  it("规则暂停（用户接管）→ 命中的请求也原样放行，不改写", async () => {
    const { c, sent } = mkController(rulesOf({ action: "block", pattern: "*" }), { paused: () => true });
    await c.onPaused(ev("1", "https://a.test/x"));
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
  });

  it("红线：Flowship origin 命中 `*` 也只 continueRequest，且不打 ruled 标记", async () => {
    const onRuled = vi.fn();
    const { c, sent } = mkController(rulesOf({ action: "block", pattern: "*" }, { action: "mock", pattern: "*", body: "x" }), { isAppUrl: (u) => u.includes("flowship.local"), onRuled });
    await c.onPaused(ev("1", "https://flowship.local/api/x"));
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
    expect(sent[0].params).toEqual({ requestId: "1" });
    expect(onRuled).not.toHaveBeenCalled();
  });

  it("命中后给网络条目打标记（带 networkId / ruled / ruleId），并累计 hits", async () => {
    const onRuled = vi.fn();
    const rules = rulesOf({ action: "mock", pattern: "*/m", body: "x" });
    const { c } = mkController(rules, { onRuled });
    await c.onPaused(ev("1", "https://a.test/m"));
    await c.onPaused(ev("2", "https://a.test/m"));
    expect(onRuled).toHaveBeenCalledWith({ sessionId: null, networkId: "n-1", ruled: "mock", ruleId: "r1" });
    expect(rules[0].hits).toBe(2);
  });

  it("failRequest / fulfillRequest 被浏览器拒绝 → 退回 continueRequest（请求永不挂起）", async () => {
    const { c, sent } = mkController(rulesOf({ action: "block", pattern: "*/b" }, { action: "mock", pattern: "*/m", body: "x" }), {
      send: async (method) => {
        if (method !== "Fetch.continueRequest") throw new Error("Invalid InterceptionId");
        return {};
      },
    });
    await c.onPaused(ev("1", "https://a.test/b"));
    await c.onPaused(ev("2", "https://a.test/m"));
    expect(sent.map((s) => s.method)).toEqual(["Fetch.failRequest", "Fetch.continueRequest", "Fetch.fulfillRequest", "Fetch.continueRequest"]);
  });

  it("决策阶段抛错（规则读取失败）→ 放行，不 throw", async () => {
    const send = vi.fn(async () => ({}));
    const c = createPauseController({
      send,
      getRules: () => {
        throw new Error("boom");
      },
      isPaused: () => false,
      log: () => {},
    });
    await expect(c.onPaused(ev("1", "https://a.test/x"))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "1" }, null);
  });

  it("continueRequest 本身也失败 → 吞掉，不 throw、不再重试", async () => {
    const { c, send } = mkController(rulesOf({ action: "block", pattern: "*" }), {
      send: async () => {
        throw new Error("gone");
      },
    });
    await expect(c.onPaused(ev("1", "https://a.test/x"))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2); // failRequest + 兜底 continueRequest
  });

  it("delay：等够再放行（真定时器，耗时 ≥ 设定）", async () => {
    const { c, sent } = mkController(rulesOf({ action: "delay", pattern: "*", delayMs: 60 }));
    const t0 = Date.now();
    await c.onPaused(ev("1", "https://a.test/x"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
  });

  it("delay 期间 flush（规则暂停 / 清空）→ 立刻放行，且之后不会二次处理", async () => {
    const { c, sent } = mkController(rulesOf({ action: "delay", pattern: "*", delayMs: 20_000 }));
    const p = c.onPaused(ev("1", "https://a.test/x"));
    await new Promise((r) => setTimeout(r, 20));
    expect(c.pendingCount()).toBe(1);
    const t0 = Date.now();
    await c.flush();
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
    expect(c.pendingCount()).toBe(0);
  });

  it("delay 期间用户接管 → 到点后不再改写（block 变成放行）", async () => {
    let paused = false;
    const { c, sent } = mkController(rulesOf({ action: "delay", pattern: "*", delayMs: 40 }, { action: "block", pattern: "*" }), { paused: () => paused });
    const p = c.onPaused(ev("1", "https://a.test/x"));
    paused = true;
    await p;
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
  });

  it("兜底超时：决策卡住（send 永不返回）时，定时器到点无条件 continueRequest", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const sent: string[] = [];
    let hang = true;
    const c = createPauseController({
      send: async (method: string) => {
        sent.push(method);
        if (hang && method !== "Fetch.continueRequest") return new Promise(() => {}); // 永不返回
        return {};
      },
      getRules: () => rulesOf({ action: "block", pattern: "*" }),
      isPaused: () => false,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
      log: () => {},
    });
    void c.onPaused(ev("1", "https://a.test/x"));
    await new Promise((r) => setImmediate(r));
    // 第一个 send 是 failRequest 且挂住——但 done 已置位，所以兜底 continuePlain 会被 settle 的 done 检查挡掉……
    expect(sent[0]).toBe("Fetch.failRequest");
    expect(timers[0].ms).toBe(PAUSE_SAFETY_SLACK_MS);
    hang = false;
    // 即使定时器触发也不会二次处理已被 settle 的请求（恰好一次的不变量）
    timers[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(sent.filter((m) => m === "Fetch.continueRequest")).toHaveLength(0);
  });

  it("兜底超时：延迟中的请求（等待被卡住）到点放行；dispose 后到达的事件一律放行", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const sent: string[] = [];
    const c = createPauseController({
      send: async (method: string) => {
        sent.push(method);
        return {};
      },
      getRules: () => rulesOf({ action: "delay", pattern: "*", delayMs: 5_000 }),
      isPaused: () => false,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
      log: () => {},
    });
    const p = c.onPaused(ev("1", "https://a.test/x"));
    await new Promise((r) => setImmediate(r));
    // 安全定时器按「延迟 + slack」重新计时
    expect(timers.some((t) => t.ms === 5_000 + PAUSE_SAFETY_SLACK_MS)).toBe(true);
    timers.find((t) => t.ms === 5_000 + PAUSE_SAFETY_SLACK_MS)!.fn(); // 兜底触发
    await p;
    expect(sent).toEqual(["Fetch.continueRequest"]);
    c.dispose();
    await c.onPaused(ev("2", "https://a.test/y"));
    expect(sent).toEqual(["Fetch.continueRequest", "Fetch.continueRequest"]);
  });
});

// ───────────────────────── R14：终结命令崩溃防护 ─────────────────────────
//
// 2026-11-11 16:29 正式包 v1.9.47 闪退：对「CORS 模式、带请求体、跨源」的 XHR / fetch 下任何终结命令——Fetch.fulfillRequest **和 Fetch.failRequest**——
// Chromium 浏览器进程都会释放后使用（SIGSEGV；真 Electron 实测）。只有 Fetch.continueRequest 安全。
// 引擎的防护：block / fail / mock 命中这类请求时**不发任何终结命令、也不放行真请求**，改发 continueRequest 并把 url 改写到受限端口（REFUSE_URL），请求在本机立刻失败。
// 本组钉死判定的两边：必须拒的（宁可误拦）+ 必须照常处理的（不能误伤同源 / GET / 不带体 / 预检）。

describe("R14：终结类规则命中「带请求体且不能确认同源」的请求 → 绝不发 fulfillRequest / failRequest，就地拒绝", () => {
  const PAGE_ORIGIN = "https://crm-test.wukongedu.net";
  const API_ORIGIN = "https://crm-api-test.wukongedu.net";
  const API = `${API_ORIGIN}/api/handover/unassigned/page`;
  const mockRules = () => rulesOf({ action: "mock", pattern: "*unassigned/page*", status: 200, body: '{"total":1}' });
  /** 现场形态：跨源 JSON POST，hasPostData=true、postData 也给 */
  const baseReq = (): Record<string, any> => ({ url: API, method: "POST", headers: { Origin: PAGE_ORIGIN, "Content-Type": "application/json" }, hasPostData: true, postData: '{"pageNum":1}' });
  const paused = (id: string, over: Record<string, any> = {}) => ({ requestId: id, networkId: `n-${id}`, request: { ...baseReq(), ...over } });
  const methodsOf = (sent: Array<{ method: string }>) => sent.map((s) => s.method);
  /** 就地拒绝的唯一形态：continueRequest 带改写后的 url（且没有 headers / postData 等别的改写） */
  const REFUSED = (id: string) => ({ requestId: id, url: REFUSE_URL });

  it("REFUSE_URL：http、回环、端口 1（Chromium 受限端口，连接前就被拒）——不是 DNS 名、不是可能有服务在听的端口", () => {
    const u = new URL(REFUSE_URL);
    expect(u.protocol).toBe("http:");
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("1");
  });

  it("现场形态（跨源 POST + JSON 体 + mock）：只发 continueRequest(url→REFUSE_URL)，绝无 fulfillRequest / failRequest；打 mock-refused 标记、hits 照常计数、写一行日志（不含 URL）", async () => {
    const onRuled = vi.fn();
    const logs: string[] = [];
    const rules = mockRules();
    const { c, sent } = mkController(rules, { onRuled, log: (m) => logs.push(m) });
    await c.onPaused(paused("1"));
    expect(methodsOf(sent)).toEqual(["Fetch.continueRequest"]);
    expect(sent[0].params).toEqual(REFUSED("1"));
    expect(onRuled).toHaveBeenCalledTimes(1);
    expect(onRuled).toHaveBeenCalledWith({ sessionId: null, networkId: "n-1", ruled: "mock-refused", ruleId: "r1" });
    expect(rules[0].hits).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("R14");
    expect(logs[0]).toContain("mock 规则 r1");
    expect(logs[0]).not.toContain("crm-api-test"); // URL 的 query 里可能有凭据：日志不写 URL
    expect(c.pendingCount()).toBe(0);
  });

  it.each<[string, Record<string, any>]>([
    ["PUT 带体", { method: "PUT" }],
    ["PATCH 带体", { method: "PATCH" }],
    ["只有 hasPostData=true（大体积 / 流式体 CDP 不给 postData）", { postData: undefined }],
    ["只有非空 postData（没有 hasPostData 字段）", { hasPostData: undefined }],
    ["只有 postDataEntries 非空", { hasPostData: undefined, postData: undefined, postDataEntries: [{ bytes: "e30=" }] }],
    ["同 site 不同端口（现场就是这种）", { url: "http://127.0.0.1:4000/unassigned/page", headers: { Origin: "http://127.0.0.1:3000" } }],
    ["同 host 不同 scheme", { url: `${API_ORIGIN}/unassigned/page`, headers: { Origin: "http://crm-api-test.wukongedu.net" } }],
    ["Origin 头名小写（大小写不敏感地读）但值跨源", { headers: { origin: PAGE_ORIGIN } }],
    ["没有 Origin 头 → 无法确认同源，保守拒绝", { headers: { "Content-Type": "application/json" } }],
    ["headers 整个缺失", { headers: undefined }],
    ["Origin 是 null（沙箱 iframe / file:）", { headers: { Origin: "null" } }],
    ["Origin 解析失败", { headers: { Origin: "not a url" } }],
    ["Origin 是空串", { headers: { Origin: "" } }],
    ["请求 URL 解析失败（端口越界）", { url: "https://crm-api-test.wukongedu.net:99999/unassigned/page", headers: { Origin: "https://crm-api-test.wukongedu.net:99999" } }],
    ["Origin 是 file:// 之类不透明 origin，不能当作同源", { url: `${API_ORIGIN}/unassigned/page`, headers: { Origin: "file://" } }],
  ])("必须拒（mock）：%s → 就地拒绝，且绝不发 fulfillRequest / failRequest", async (_name, over) => {
    const onRuled = vi.fn();
    const { c, sent } = mkController(mockRules(), { onRuled });
    await c.onPaused(paused("1", over));
    expect(methodsOf(sent)).toEqual(["Fetch.continueRequest"]);
    expect(sent[0].params).toEqual(REFUSED("1"));
    expect(onRuled).toHaveBeenCalledWith(expect.objectContaining({ ruled: "mock-refused" }));
  });

  it.each<[string, Record<string, any>]>([
    ["同源 POST 带体", { url: `${API_ORIGIN}/unassigned/page`, headers: { Origin: API_ORIGIN } }],
    ["同源 PUT 带体", { url: `${API_ORIGIN}/unassigned/page`, method: "PUT", headers: { Origin: API_ORIGIN } }],
    ["同源 POST，Origin 头名小写", { url: `${API_ORIGIN}/unassigned/page`, headers: { origin: API_ORIGIN } }],
    ["同源 POST，Origin 带默认端口（序列化后与 URL 的 origin 相同）", { url: `${API_ORIGIN}/unassigned/page`, headers: { Origin: `${API_ORIGIN}:443` } }],
    ["跨源 GET（不带体）", { method: "GET", hasPostData: undefined, postData: undefined }],
    ["跨源 DELETE（不带体）", { method: "DELETE", hasPostData: undefined, postData: undefined }],
    ["跨源 POST 不带体（hasPostData 缺失）", { hasPostData: undefined, postData: undefined }],
    ["跨源 POST，hasPostData=false 且 postData 是空串", { hasPostData: false, postData: "" }],
    ["跨源 POST，postDataEntries 是空数组", { hasPostData: undefined, postData: undefined, postDataEntries: [] }],
  ])("不误伤（mock）：%s → 照常 fulfillRequest，标记仍是 mock", async (_name, over) => {
    const onRuled = vi.fn();
    const { c, sent } = mkController(mockRules(), { onRuled });
    await c.onPaused(paused("1", over));
    expect(methodsOf(sent)).toEqual(["Fetch.fulfillRequest"]);
    expect(sent[0].params).toMatchObject({ requestId: "1", responseCode: 200 });
    expect(onRuled).toHaveBeenCalledWith(expect.objectContaining({ ruled: "mock" }));
  });

  it("block / fail 规则命中同类请求也走就地拒绝（它们原来发的 failRequest 对这类请求同样会令 Chromium 崩溃）；条目 ruled 仍是 block / fail", async () => {
    const onRuled = vi.fn();
    const rules = rulesOf({ action: "block", pattern: "*/b" }, { action: "fail", pattern: "*/f", errorReason: "ConnectionRefused" });
    const logs: string[] = [];
    const { c, sent } = mkController(rules, { onRuled, log: (m) => logs.push(m) });
    await c.onPaused(paused("b", { url: `${API_ORIGIN}/b` }));
    await c.onPaused(paused("f", { url: `${API_ORIGIN}/f` }));
    expect(methodsOf(sent)).toEqual(["Fetch.continueRequest", "Fetch.continueRequest"]);
    expect(sent.map((x) => x.params)).toEqual([REFUSED("b"), REFUSED("f")]);
    expect(onRuled.mock.calls.map((x) => x[0].ruled)).toEqual(["block", "fail"]);
    expect(logs.map((l) => /命中 (\w+) 规则/.exec(l)?.[1])).toEqual(["block", "fail"]);
  });

  it("block / fail 对不危险的请求完全不变：跨源 GET / 同源带体 / 无体 POST 仍是 failRequest（errorReason 照旧）", async () => {
    const rules = rulesOf({ action: "block", pattern: "*/b" }, { action: "fail", pattern: "*/f", errorReason: "ConnectionRefused" });
    const { c, sent } = mkController(rules);
    await c.onPaused(paused("b", { url: `${API_ORIGIN}/b`, method: "GET", hasPostData: undefined, postData: undefined }));
    await c.onPaused(paused("f", { url: `${API_ORIGIN}/f`, headers: { Origin: API_ORIGIN } }));
    await c.onPaused(paused("n", { url: `${API_ORIGIN}/f`, hasPostData: undefined, postData: undefined }));
    expect(methodsOf(sent)).toEqual(["Fetch.failRequest", "Fetch.failRequest", "Fetch.failRequest"]);
    expect(sent[0].params).toEqual({ requestId: "b", errorReason: "BlockedByClient" });
    expect(sent[1].params).toEqual({ requestId: "f", errorReason: "ConnectionRefused" });
  });

  it("CORS 预检 OPTIONS（没有请求体）不受影响：mock 照常 204 代答、block / fail 照常 failRequest（实测预检的终结命令安全）；紧随其后的真 POST 才被就地拒绝", async () => {
    const preflight = (id: string) => ({
      requestId: id,
      networkId: `n-${id}`,
      request: { url: API, method: "OPTIONS", headers: { Origin: PAGE_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } },
    });
    const m = mkController(mockRules());
    await m.c.onPaused(preflight("pre"));
    await m.c.onPaused(paused("post"));
    expect(methodsOf(m.sent)).toEqual(["Fetch.fulfillRequest", "Fetch.continueRequest"]);
    expect(m.sent[0].params).toMatchObject({ requestId: "pre", responseCode: 204, body: "" });
    expect(m.sent[1].params).toEqual(REFUSED("post"));
    const b = mkController(rulesOf({ action: "block", pattern: "*unassigned/page*" }));
    await b.c.onPaused(preflight("pre"));
    expect(b.sent.map((x) => x.method)).toEqual(["Fetch.failRequest"]);
    expect(b.sent[0].params).toEqual({ requestId: "pre", errorReason: "BlockedByClient" });
  });

  it("set_headers / delay 对同样的请求行为与 R14 之前完全一致（continueRequest 实测安全）", async () => {
    const onRuled = vi.fn();
    const rules = rulesOf({ action: "set_headers", pattern: "*/h", headers: { "X-Dbg": "1" } }, { action: "delay", pattern: "*/d", delayMs: 5 });
    const { c, sent } = mkController(rules, { onRuled });
    await c.onPaused(paused("h", { url: `${API_ORIGIN}/h` }));
    await c.onPaused(paused("d", { url: `${API_ORIGIN}/d` }));
    expect(methodsOf(sent)).toEqual(["Fetch.continueRequest", "Fetch.continueRequest"]);
    expect(sent[0].params.headers).toEqual(expect.arrayContaining([{ name: "X-Dbg", value: "1" }]));
    expect(sent[0].params.url).toBeUndefined(); // 没有被改写 url
    expect(sent[1].params).toEqual({ requestId: "d" });
    expect(onRuled.mock.calls.map((x) => x[0].ruled)).toEqual(["headers", "delay"]);
  });

  it("mock + delay 叠加：照样先延迟、到点后仍是就地拒绝（延迟不能让它绕过防护）", async () => {
    const { c, sent } = mkController(rulesOf({ action: "delay", pattern: "*unassigned/page*", delayMs: 30 }, { action: "mock", pattern: "*unassigned/page*", body: "x" }));
    const t0 = Date.now();
    await c.onPaused(paused("1"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(methodsOf(sent)).toEqual(["Fetch.continueRequest"]);
    expect(sent[0].params).toEqual(REFUSED("1"));
  });

  it("mock + set_headers 同时命中：整体判就地拒绝，不会因为有 set_headers 退化成带头的 continueRequest 把真 POST 放出去", async () => {
    const { c, sent } = mkController(rulesOf({ action: "mock", pattern: "*unassigned/page*", body: "x" }, { action: "set_headers", pattern: "*unassigned/page*", headers: { "X-A": "1" } }));
    await c.onPaused(paused("1"));
    expect(sent.map((x) => x.params)).toEqual([REFUSED("1")]);
  });

  it("就地拒绝本身被浏览器拒绝（请求多半已经没了）：只记日志，**不**退回原样 continueRequest（那会把要拒绝的真请求放出去），也绝不发 failRequest / fulfillRequest", async () => {
    const logs: string[] = [];
    const { c, sent } = mkController(mockRules(), {
      log: (m) => logs.push(m),
      send: async () => {
        throw new Error("Invalid InterceptionId");
      },
    });
    await expect(c.onPaused(paused("1"))).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "Fetch.continueRequest", params: REFUSED("1") });
    expect(logs.some((l) => l.includes("就地拒绝失败"))).toBe(true);
    expect(c.pendingCount()).toBe(0);
  });

  it("decideForRequest：危险类的决定是 refuse，没有 mock 对象（调用方想 fulfill 也拿不到参数）、没有 errorReason（想 failRequest 也没有原因可用）", () => {
    const rules = mockRules();
    const d = decideForRequest(rules, baseReq());
    expect(d).toMatchObject({ verdict: "refuse", ruled: "mock-refused", mockRefused: true, terminalAction: "mock", decisiveRuleId: "r1", untouched: false });
    expect("mock" in d).toBe(false);
    expect("errorReason" in d).toBe(false);
    const blk = decideForRequest(rulesOf({ action: "block", pattern: "*unassigned/page*" }), baseReq());
    expect(blk).toMatchObject({ verdict: "refuse", ruled: "block", terminalAction: "block" });
    expect(blk.mockRefused).toBeUndefined();
    // 对照：能确认同源时仍是 fulfill，且不带 mockRefused
    const ok = decideForRequest(rules, { ...baseReq(), url: `${API_ORIGIN}/unassigned/page`, headers: { Origin: API_ORIGIN } });
    expect(ok).toMatchObject({ verdict: "fulfill", ruled: "mock" });
    expect(ok.mockRefused).toBeUndefined();
  });

  it("红线不被削弱：Flowship 自身 origin 的请求仍然只 continueRequest 原样放行（isAppUrl 先于 R14 判定，不会被改写 url）", async () => {
    const onRuled = vi.fn();
    const { c, sent } = mkController(mockRules(), { isAppUrl: (u) => u.startsWith(API_ORIGIN), onRuled });
    await c.onPaused(paused("1"));
    expect(methodsOf(sent)).toEqual(["Fetch.continueRequest"]);
    expect(sent[0].params).toEqual({ requestId: "1" });
    expect(onRuled).not.toHaveBeenCalled();
  });
});

describe("R14 纯函数：requestHasBody / isConfirmedSameOrigin / terminalWouldCrashChromium", () => {
  it("requestHasBody：任何一个带体信号成立就算；脏输入一律 false 且不抛", () => {
    expect(requestHasBody({ hasPostData: true })).toBe(true);
    expect(requestHasBody({ postData: "{}" })).toBe(true);
    expect(requestHasBody({ postDataEntries: [{}] })).toBe(true);
    expect(requestHasBody({})).toBe(false);
    expect(requestHasBody({ hasPostData: false, postData: "", postDataEntries: [] })).toBe(false);
    // 类型不对的信号不算（"true" 字符串、数字 1 都不是 hasPostData === true）
    expect(requestHasBody({ hasPostData: "true", postData: 1, postDataEntries: "x" })).toBe(false);
    for (const bad of [null, undefined, 0, "x", []]) expect(requestHasBody(bad)).toBe(false);
  });

  it("isConfirmedSameOrigin：必须有 Origin 且与请求 URL 的 origin 逐字相等；缺失 / null / 解析失败 / 数组头值一律 false", () => {
    const same = (origin: unknown, url: unknown, key = "Origin") => isConfirmedSameOrigin({ url, headers: { [key]: origin } });
    expect(same("https://a.test", "https://a.test/x?y=1")).toBe(true);
    expect(same("https://a.test", "https://a.test/x", "ORIGIN")).toBe(true);
    expect(same("https://a.test:443", "https://a.test/x")).toBe(true);
    expect(same("http://127.0.0.1:3000", "http://127.0.0.1:3000/p")).toBe(true);
    expect(same("http://127.0.0.1:3000", "http://127.0.0.1:4000/p")).toBe(false);
    expect(same("https://a.test", "http://a.test/x")).toBe(false);
    expect(same("https://a.test", "https://b.a.test/x")).toBe(false);
    expect(same("null", "https://a.test/x")).toBe(false);
    expect(same("file://", "file:///x")).toBe(false);
    expect(same("", "https://a.test/x")).toBe(false);
    expect(same("https://a.test", "")).toBe(false);
    expect(same("https://a.test", undefined)).toBe(false);
    expect(same(["https://a.test"], "https://a.test/x")).toBe(false);
    expect(isConfirmedSameOrigin({ url: "https://a.test/x" })).toBe(false);
    expect(isConfirmedSameOrigin({ url: "https://a.test/x", headers: {} })).toBe(false);
    for (const bad of [null, undefined, 0, "x"]) expect(isConfirmedSameOrigin(bad)).toBe(false);
  });

  it("terminalWouldCrashChromium = 带体 且 不能确认同源（真值表）", () => {
    const U = "https://a.test/x";
    const sameO = { Origin: "https://a.test" };
    const crossO = { Origin: "https://b.test" };
    expect(terminalWouldCrashChromium({ url: U, hasPostData: true, headers: crossO })).toBe(true);
    expect(terminalWouldCrashChromium({ url: U, hasPostData: true, headers: {} })).toBe(true);
    expect(terminalWouldCrashChromium({ url: U, hasPostData: true, headers: sameO })).toBe(false);
    expect(terminalWouldCrashChromium({ url: U, headers: crossO })).toBe(false);
    expect(terminalWouldCrashChromium({ url: U, headers: {} })).toBe(false);
    expect(terminalWouldCrashChromium({ url: U })).toBe(false);
  });
});
