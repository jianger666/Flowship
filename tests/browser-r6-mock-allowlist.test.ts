/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-32 / R6-39④：network_rules mock 的两张「默认放行」名单改成白名单 + 审批卡给足判断依据。
 *
 * ① 响应头：之前是黑名单（禁 Content-Length / Set-Cookie 等 8 个），Clear-Site-Data（清用户整个站点的 cookie / 存储）、Content-Security-Policy、
 *    Strict-Transport-Security、Location、Refresh、Link、Service-Worker-Allowed、Content-Disposition…全放行——mock 能借它们改变浏览器状态 / 页面行为，
 *    而且**不需要审批**（json mock 免审批）。改成白名单：只放 Cache-Control / ETag / Last-Modified / Expires / Vary / Content-Language / Access-Control-* / X-*。
 * ② 免审批内容类型：之前是黑名单（html / js / svg / xml / css / wasm），`multipart/x-mixed-replace`（服务器推送式文档，Chrome 会渲染）/ `message/rfc822` /
 *    `multipart/related` / `application/pdf` 都漏过去。改成白名单：json / text/plain / text/csv / 位图 / octet-stream / font/*；其余一律审批（fail-closed）。
 * ③ 审批卡：类型 + body 大小 + `<script` / `on*=` 个数放最前，开头预览放最后（卡片展示链路有上限，见 buildMockApprovalSummary 的注释）。
 * R6-39④：buildRuleDef 里剔除 Content-Type 头那行删掉后，原有测试全绿 → 补「响应里只有一个 Content-Type」的断言，buildFulfillParams 里再剔一次作纵深。
 * R6-01 的语义（可执行类型要审批、不能借 storageAccess 旁路）由 browser-r6-s1-mock-approval.test.ts 继续守着。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWED_RESPONSE_HEADERS,
  buildFulfillParams,
  buildRuleDef,
  isAllowedResponseHeader,
  isApprovalFreeContentType,
  isExecutableContentType,
  isForbiddenResponseHeader,
  mockBodyStats,
  NetRuleError,
  normalizeRuleHeaders,
  ruleNeedsEvaluateApproval,
} from "../electron-app/browser/net-rules-engine.mjs";
import { buildMockApprovalSummary, MOCK_PREVIEW_MIN_CHARS } from "../electron-app/browser/ops/net-rules.mjs";
import { makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

let env: P4Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const mk = async () => (env = await makeP4Env());

const mockDef = (p: Record<string, unknown>) => buildRuleDef({ action: "mock", pattern: "*/x", ...p }) as any;
const respHeaders = (params: any): Array<{ name: string; value: string }> => params.responseHeaders;
const countHeader = (params: any, name: string) => respHeaders(params).filter((h) => h.name.toLowerCase() === name.toLowerCase()).length;
const valueOf = (params: any, name: string) => respHeaders(params).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

// ───────────────────────── ① 响应头白名单 ─────────────────────────

describe("R6-32①·mock 响应头白名单", () => {
  it("放行：Content-Type / Cache-Control / ETag / Last-Modified / Expires / Vary / Content-Language / Access-Control-* / X-*（大小写不敏感）", () => {
    for (const n of [
      "Content-Type",
      "cache-control",
      "ETAG",
      "Last-Modified",
      "Expires",
      "Vary",
      "Content-Language",
      "Access-Control-Allow-Origin",
      "access-control-allow-methods",
      "Access-Control-Allow-Headers",
      "Access-Control-Expose-Headers",
      "Access-Control-Max-Age",
      "Access-Control-Allow-Credentials",
      "X-Mock",
      "x-request-id",
      "X-Content-Type-Options",
    ]) {
      expect(isAllowedResponseHeader(n), n).toBe(true);
      expect(isForbiddenResponseHeader(n), n).toBe(false);
      expect(() => normalizeRuleHeaders({ [n]: "1" }, { kind: "response" }), n).not.toThrow();
    }
  });

  it("拒绝：会改变浏览器状态 / 页面行为 / 触发导航与下载的头（Set-Cookie / Clear-Site-Data / CSP / HSTS / Location / Refresh / Link / Service-Worker-Allowed / Content-Disposition …）", () => {
    for (const n of [
      "Set-Cookie",
      "Set-Cookie2",
      "Clear-Site-Data",
      "CLEAR-SITE-DATA",
      "cLeAr-SiTe-DaTa",
      "Content-Security-Policy",
      "Content-Security-Policy-Report-Only",
      "Strict-Transport-Security",
      "Location",
      "Refresh",
      "Link",
      "Service-Worker-Allowed",
      "Content-Disposition",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Embedder-Policy",
      "Cross-Origin-Resource-Policy",
      "Report-To",
      "NEL",
      "Alt-Svc",
      "Accept-CH",
      "Origin-Agent-Cluster",
      "Document-Policy",
      "Timing-Allow-Origin",
      "Public-Key-Pins",
      "SourceMap",
      // 原黑名单里本来就有的
      "Content-Length",
      "Content-Encoding",
      "Transfer-Encoding",
      "Connection",
      // 不是白名单前缀（X 开头但不是 X-；Access-Control 少了尾巴的 -）
      "XSRF",
      "Access-Controller",
      "Cache-Controls",
    ]) {
      expect(isAllowedResponseHeader(n), n).toBe(false);
      expect(isForbiddenResponseHeader(n), n).toBe(true);
      expect(() => normalizeRuleHeaders({ [n]: "x" }, { kind: "response" }), n).toThrow(NetRuleError);
      expect(() => mockDef({ headers: [{ name: n, value: "x" }], contentType: "application/json", body: "{}" }), `buildRuleDef ${n}`).toThrow(NetRuleError);
    }
  });

  it("导出的名单是冻结数组（运行期不能被改写扩权），且不含任何危险头", () => {
    expect(Object.isFrozen(ALLOWED_RESPONSE_HEADERS)).toBe(true);
    expect(Array.isArray(ALLOWED_RESPONSE_HEADERS)).toBe(true);
    expect(() => (ALLOWED_RESPONSE_HEADERS as string[]).push("clear-site-data")).toThrow();
    expect(isAllowedResponseHeader("Clear-Site-Data")).toBe(false);
    expect(ALLOWED_RESPONSE_HEADERS).not.toContain("clear-site-data");
    expect(ALLOWED_RESPONSE_HEADERS).not.toContain("set-cookie");
  });

  it("错误信息写清楚：哪个头被拒、能用哪些头、Content-Type 怎么设（模型据此自行修正，不用猜）", () => {
    let msg = "";
    try {
      normalizeRuleHeaders({ "Clear-Site-Data": '"cookies"' }, { kind: "response" });
    } catch (err: any) {
      msg = String(err.message);
    }
    expect(msg).toContain("不允许在 mock 里设置响应头 Clear-Site-Data");
    expect(msg).toMatch(/只放行 Cache-Control \/ ETag \/ Last-Modified \/ Expires \/ Vary \/ Content-Language \/ Access-Control-\* \/ X-\*/);
    expect(msg).toContain("content_type");
    expect(msg).toMatch(/Set-Cookie.*Clear-Site-Data.*Content-Security-Policy/);
  });

  it("只有一个头不合规整条规则就失败（不会悄悄丢掉那个头、让模型以为都生效了）", () => {
    expect(() => mockDef({ headers: { "X-Ok": "1", "Set-Cookie": "a=b" }, contentType: "application/json", body: "{}" })).toThrow(/Set-Cookie/);
  });

  it("请求头那一侧（set_headers）不受影响：仍是自己的禁改清单（Cookie / Host / Sec-* 拒，X-Dbg 放）", () => {
    expect(() => normalizeRuleHeaders({ "X-Dbg": "1", Authorization: "Bearer x" }, { kind: "request" })).not.toThrow();
    for (const n of ["Cookie", "Host", "Sec-Fetch-Mode", "Content-Length"]) expect(() => normalizeRuleHeaders({ [n]: "x" }, { kind: "request" }), n).toThrow(NetRuleError);
  });

  it("工具层：被拒的响应头 → BAD_ARGS（带上述文案），Fetch 没有被启用、规则没有落地", async () => {
    const e = await mk();
    await expect(e.rules({ action: "mock", pattern: "*/x", contentType: "application/json", body: "{}", headers: { "Clear-Site-Data": '"*"' } })).rejects.toMatchObject({
      code: "BAD_ARGS",
      message: expect.stringContaining("Clear-Site-Data"),
    });
    expect(e.cmds("Fetch.enable")).toHaveLength(0);
    expect((await e.rules({ action: "list" })).count).toBe(0);
    // 对照：白名单里的头照常创建
    const ok = await e.rules({ action: "mock", pattern: "*/x", contentType: "application/json", body: "{}", headers: { "Cache-Control": "max-age=60", "X-Mock": "1" } });
    expect(ok.rule.headerNames).toEqual(["Cache-Control", "X-Mock"]);
  });
});

// ───────────────────────── ② 免审批内容类型白名单 ─────────────────────────

describe("R6-32②·免审批内容类型白名单（其余一律审批）", () => {
  const FREE = [
    "application/json",
    "application/json; charset=utf-8",
    "APPLICATION/JSON",
    "  application/json  ;charset=UTF-8",
    "text/plain",
    "text/plain; charset=utf-8",
    "text/csv",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/x-icon",
    "application/octet-stream",
    "font/woff",
    "font/woff2",
    "font/ttf",
    "font/otf",
    "FONT/WOFF2",
  ];
  const NEEDS_APPROVAL = [
    // R6-01 就有的
    "text/html",
    "TEXT/HTML; charset=utf-8",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/jscript",
    "text/xml",
    "application/xml",
    "application/atom+xml",
    "application/vnd.foo+xml",
    "text/css",
    "application/wasm",
    // R6-32 点名：黑名单漏掉的
    "multipart/x-mixed-replace",
    "multipart/x-mixed-replace; boundary=frame",
    "multipart/related",
    "multipart/form-data",
    "multipart/mixed",
    "message/rfc822",
    "message/http",
    "application/pdf",
    // 其它不在白名单的（fail-closed）
    "application/x-www-form-urlencoded",
    "application/zip",
    "application/x-shockwave-flash",
    "application/x-msdownload",
    "application/ld+json",
    "application/problem+json",
    "application/json+x",
    "text/event-stream",
    "text/markdown",
    "text/vcard",
    "text/calendar",
    "text/x-component",
    "image/tiff",
    "image/svg",
    "audio/mpeg",
    "video/mp4",
    // font/* 不能借前缀夹带 +xml（Chrome 把任何 *+xml 当 XML 文档渲染）/ 其它畸形
    "font/x+xml",
    "font/svg+xml",
    "font/",
    "font/a b",
    "font/../html",
    "",
    "   ",
  ];

  it("白名单内：免审批（isApprovalFreeContentType=true，isExecutableContentType=false）", () => {
    for (const ct of FREE) {
      expect(isApprovalFreeContentType(ct), ct).toBe(true);
      expect(isExecutableContentType(ct), ct).toBe(false);
    }
  });

  it("白名单外一律要审批（含 multipart/x-mixed-replace / message/rfc822 / multipart/related / application/pdf / 空值），且与旧名 isExecutableContentType 同步", () => {
    for (const ct of NEEDS_APPROVAL) {
      expect(isApprovalFreeContentType(ct), JSON.stringify(ct)).toBe(false);
      expect(isExecutableContentType(ct), JSON.stringify(ct)).toBe(true);
    }
  });

  it("非字符串 / 缺失 → 不免审批（fail-closed）", () => {
    for (const v of [undefined, null, 0, {}, []]) expect(isApprovalFreeContentType(v as never), String(v)).toBe(false);
  });

  it("规则层：mock 的有效类型不在白名单 → 需要审批；block / set_headers / fail / delay 永远不要", () => {
    for (const ct of ["multipart/x-mixed-replace", "message/rfc822", "multipart/related", "application/pdf"]) {
      const d = mockDef({ contentType: ct, body: "x" });
      expect(ruleNeedsEvaluateApproval(d), ct).toBe(true);
      // headers 里写的 Content-Type 同样算（大小写混写）
      const viaHeader = mockDef({ headers: { "cOnTeNt-TyPe": ct }, body: "x" });
      expect(ruleNeedsEvaluateApproval(viaHeader), `header ${ct}`).toBe(true);
    }
    for (const ct of FREE.filter((x) => !x.startsWith(" ") && !x.includes("  "))) {
      const d = mockDef({ contentType: ct, body: "x" });
      expect(ruleNeedsEvaluateApproval(d), ct).toBe(false);
    }
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "block", pattern: "*/x" }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "set_headers", pattern: "*/x", headers: { Accept: "application/pdf" } }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "fail", pattern: "*/x" }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "delay", pattern: "*/x", delayMs: 5 }))).toBe(false);
  });

  it("嗅探默认类型（没给 content_type）：JSON / 纯文本免审批，标记类 / xml 仍要审批（R6-01 语义不退化）", () => {
    expect(ruleNeedsEvaluateApproval(mockDef({ body: '{"a":1}' }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(mockDef({ body: "hello" }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(mockDef({}))).toBe(false);
    expect(ruleNeedsEvaluateApproval(mockDef({ body: "<!doctype html><script>1</script>" }))).toBe(true);
    expect(ruleNeedsEvaluateApproval(mockDef({ body: "<svg onload=1>" }))).toBe(true);
    expect(ruleNeedsEvaluateApproval(mockDef({ body: '<?xml version="1.0"?><a/>' }))).toBe(true);
  });

  it("工具层（真 session + PromptHub）：新增要审批的类型都弹 evaluate 卡、拒绝 → DENIED、规则不落地；白名单内的不弹卡", async () => {
    for (const ct of ["multipart/x-mixed-replace", "message/rfc822", "multipart/related", "application/pdf"]) {
      const e = await mk();
      const done = e.rules({ action: "mock", pattern: "https://t.example/*", contentType: ct, body: "x" }).then(
        () => "OK",
        (err: any) => String(err?.code ?? err),
      );
      for (let i = 0; i < 100 && e.session.prompts.list().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
      const card = e.session.prompts.list()[0] as any;
      expect(card?.kind, ct).toBe("evaluate");
      expect(card.detail.summary, ct).toContain(ct);
      e.session.prompts.answer(card.id, { action: "deny" });
      expect(await done, ct).toBe("DENIED");
      expect((await e.rules({ action: "list" })).count, ct).toBe(0);
      expect(e.cmds("Fetch.enable"), ct).toHaveLength(0);
      e.cleanup();
      env = null;
    }
    const e = await mk();
    for (const ct of ["application/json", "text/csv", "image/png", "application/octet-stream", "font/woff2"]) {
      expect((await e.rules({ action: "mock", pattern: `https://t.example/${ct.replace(/\W/g, "")}`, contentType: ct, body: "x" })).rule, ct).toBeTruthy();
    }
    expect(e.session.prompts.list()).toHaveLength(0);
  });

  it("总闸开着：新增类型同样免审批直接创建（总闸语义不变）", async () => {
    const e = await mk();
    (e.session.host as any).isEvaluateEnabled = () => true;
    expect((await e.rules({ action: "mock", pattern: "*/pdf", contentType: "application/pdf", body: "%PDF" })).rule).toBeTruthy();
    expect(e.session.prompts.list()).toHaveLength(0);
  });
});

// ───────────────────────── ③ 审批卡摘要 ─────────────────────────

describe("R6-32③·mockBodyStats / 审批卡摘要", () => {
  it("mockBodyStats：字节数按 UTF-8；<script 大小写不敏感；on*= 事件属性（空白 / 引号 / 斜杠 开头，等号前可有空白）", () => {
    expect(mockBodyStats("")).toEqual({ bytes: 0, scripts: 0, handlers: 0 });
    expect(mockBodyStats("中").bytes).toBe(3);
    expect(mockBodyStats("<script>a</script><SCRIPT src=x></SCRIPT><ScRiPt>").scripts).toBe(3);
    expect(mockBodyStats('<img src=x onerror=alert(1) onload="y"><a href="#" onclick = 1><svg/onload=1><b title=\'a\'onfocus=1>').handlers).toBe(5);
    // 没有事件属性：普通词里出现的 on（person=… 的 on 前面是字母，不算）
    expect(mockBodyStats("person=1&reason=2&json=3").handlers).toBe(0);
    expect(mockBodyStats(undefined as never)).toEqual({ bytes: 0, scripts: 0, handlers: 0 });
  });

  const def = (body: string, pattern = "https://t.example/app.js", contentType = "text/html") => mockDef({ pattern, contentType, body });

  it("摘要写出类型 / 大小 / <script 与 on*= 个数 / 匹配范围 / 开头预览，风险信号在最前面", () => {
    const s = buildMockApprovalSummary(def('<html><script>a()</script><img onerror=x()><script src=//e/x.js></script></html>'));
    expect(s).toContain("替换页面请求的响应，等同在页面里执行脚本");
    expect(s).toContain("text/html");
    expect(s).toMatch(/\d+B/); // 大小
    expect(s).toContain("<script×2");
    expect(s).toContain("on*=×1");
    expect(s).toContain("匹配 https://t.example/app.js");
    expect(s).toContain("开头：<html><script>a()</script>");
    // 风险信号（计数）排在预览之前
    expect(s.indexOf("<script×2")).toBeLessThan(s.indexOf("开头："));
  });

  it("计数统计整个 body：藏在预览之后的脚本也看得见（预览只有开头一小段）", () => {
    const body = `<p>${"a".repeat(5000)}</p><script>steal()</script>`;
    const s = buildMockApprovalSummary(def(body));
    expect(s).not.toContain("steal()"); // 预览够不到
    expect(s).toContain("<script×1"); // 但计数提示了它的存在
    expect(s).toMatch(/\d(\.\d)?KB/); // 大小：5KB 级
  });

  it("预览预算：普通 pattern 下预览 ≥ 90 字；就算 pattern 很长也不会把预览挤到少于 MOCK_PREVIEW_MIN_CHARS；整段不超过「预算 + 头」", () => {
    const body = "x".repeat(1000);
    const normal = buildMockApprovalSummary(def(body));
    const preview = normal.slice(normal.indexOf("开头：") + 3);
    expect(preview.length).toBeGreaterThanOrEqual(90);
    expect(normal.length).toBeLessThanOrEqual(200 + 1); // 末尾可能带一个「…」
    // 最坏情况：类型名与 pattern 都被截到上限、body 接近 1MB（大小标签最长）→ 前面各段合计 > 140 字，若不设下限预算会被挤到 < 60
    const longPattern = buildMockApprovalSummary(def("x".repeat(900_000), `https://t.example/${"p".repeat(300)}`, "application/vnd.very-long-type-name-for-testing+xml"));
    const headLen = longPattern.indexOf("开头：") + 3;
    expect(headLen).toBeGreaterThan(200 - MOCK_PREVIEW_MIN_CHARS); // 前提成立：不设下限的话预览不足 60 字
    const lp = longPattern.slice(headLen);
    expect(lp.length).toBeGreaterThanOrEqual(MOCK_PREVIEW_MIN_CHARS);
    expect(longPattern).toContain("匹配 https://t.example/pppp");
    expect(longPattern).toContain("…"); // pattern 被截断过
  });

  it("预览与 pattern 都过脱敏：body 开头的 token / pattern 里的 query 密钥不会出现在卡片上", () => {
    const SECRET = "sk-live-SUPERSECRETVALUE123456";
    const s = buildMockApprovalSummary(def(`<script>fetch('/x',{headers:{Authorization:'Bearer ${SECRET}'}})</script>`, `https://t.example/x?access_token=${SECRET}`));
    expect(s).not.toContain(SECRET);
    expect(s).toContain("<script×1");
  });

  it("body 为空 / 极短也不抛，开头预览为空", () => {
    const s = buildMockApprovalSummary(def("", "*/x", "application/pdf"));
    expect(s).toContain("application/pdf");
    expect(s).toContain("0B");
    expect(s).toContain("<script×0 on*=×0");
  });

  it("计数封顶显示 99+（极端 body 不会把摘要撑长）", () => {
    const s = buildMockApprovalSummary(def("<script>".repeat(500)));
    expect(s).toContain("<script×99+");
  });

  it("接线：真实审批卡（PromptHub）上能看到类型 / 大小 / <script 计数 / 预览开头（卡片展示链路本身的上限由 PromptHub / 面板决定）", async () => {
    const e = await mk();
    const done = e.rules({ action: "mock", pattern: "https://t.example/*", contentType: "text/html", body: `<html><script>a()</script>${"y".repeat(3000)}<script>b()</script></html>` }).catch(() => null);
    for (let i = 0; i < 100 && e.session.prompts.list().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
    const card = e.session.prompts.list()[0] as any;
    expect(card.detail.summary).toContain("text/html");
    expect(card.detail.summary).toMatch(/\d(\.\d)?KB/);
    expect(card.detail.summary).toContain("<script×2");
    e.session.prompts.answer(card.id, { action: "deny" });
    await done;
  });
});

// ───────────────────────── 副作用头：nosniff / no-store ─────────────────────────

describe("R6-32·fulfill 响应头的强制项", () => {
  it("免审批类型：强制 X-Content-Type-Options: nosniff（覆盖模型写的同名头），模型的 Cache-Control / ETag 等白名单头原样带上", () => {
    const m = mockDef({ contentType: "application/json", body: "{}", headers: { "Cache-Control": "max-age=60", ETag: '"v1"', "X-Content-Type-Options": "" } }).mock;
    const p = buildFulfillParams(m, { headers: {} }, "r1");
    expect(countHeader(p, "x-content-type-options")).toBe(1);
    expect(valueOf(p, "x-content-type-options")).toBe("nosniff");
    expect(valueOf(p, "cache-control")).toBe("max-age=60");
    expect(valueOf(p, "etag")).toBe('"v1"');
  });

  it("需审批类型（已获批准）：强制 Cache-Control: no-store、去掉模型写的 Cache-Control / Expires（可缓存的可执行 mock 会让撤销批准后页面仍拿到旧脚本）", () => {
    const m = mockDef({ contentType: "text/html", body: "<script>1</script>", headers: { "cache-control": "max-age=31536000, immutable", Expires: "Wed, 21 Oct 2099 07:28:00 GMT", ETag: '"v1"', "X-Mock": "1" } }).mock;
    const p = buildFulfillParams(m, { headers: {} }, "r1");
    expect(countHeader(p, "cache-control")).toBe(1);
    expect(valueOf(p, "cache-control")).toBe("no-store");
    expect(countHeader(p, "expires")).toBe(0);
    expect(valueOf(p, "x-mock")).toBe("1"); // 其它白名单头不受影响
    // 模型没写缓存头时也加 no-store
    const bare = buildFulfillParams(mockDef({ contentType: "application/pdf", body: "%PDF" }).mock, { headers: {} }, "r1");
    expect(valueOf(bare, "cache-control")).toBe("no-store");
  });

  it("CORS 预检（OPTIONS + Access-Control-Request-Method）：204、不返回 mock body（行为不变）", () => {
    const p = buildFulfillParams(mockDef({ contentType: "text/html", body: "<script>1</script>" }).mock, { method: "OPTIONS", headers: { Origin: "https://a.test", "Access-Control-Request-Method": "GET" } }, "r1");
    expect(p.responseCode).toBe(204);
    expect(p.body).toBe("");
  });
});

// ───────────────────────── R6-39④：响应里只有一个 Content-Type ─────────────────────────

describe("R6-39④·mock 响应里恰好一个 Content-Type", () => {
  it("buildRuleDef：headers 里的 Content-Type（任意大小写）被并入 contentType 后从 mock.headers 剔除", () => {
    for (const name of ["Content-Type", "content-type", "CONTENT-TYPE", "cOnTeNt-tYpE"]) {
      const d = mockDef({ headers: [{ name, value: "application/json" }, { name: "X-A", value: "1" }], body: "{}" });
      expect(d.mock.headers.map((h: any) => h.name.toLowerCase()), name).not.toContain("content-type");
      expect(d.mock.headers.map((h: any) => h.name)).toEqual(["X-A"]);
      expect(d.mock.contentType).toBe("application/json");
    }
  });

  it("json mock（显式 content_type + 同时在 headers 里再写一个别的类型）→ fulfill 响应里只有一个 Content-Type，值是显式的那个", () => {
    const d = mockDef({ contentType: "application/json", headers: { "Content-Type": "text/html", "X-A": "x" }, body: "{}" });
    const p = buildFulfillParams(d.mock, { headers: {} }, "r1");
    expect(countHeader(p, "content-type")).toBe(1);
    expect(valueOf(p, "content-type")).toBe("application/json");
    expect(countHeader(p, "x-content-type-options")).toBe(1);
  });

  it("json mock 只靠 headers 给类型：同样恰好一个 Content-Type（没有重复）", () => {
    const d = mockDef({ headers: [{ name: "content-type", value: "application/json; charset=utf-8" }], body: '{"a":1}' });
    const p = buildFulfillParams(d.mock, { headers: {} }, "r1");
    expect(countHeader(p, "content-type")).toBe(1);
    expect(valueOf(p, "content-type")).toBe("application/json; charset=utf-8");
  });

  it("纵深：不经过 buildRuleDef 手工拼的 mock 对象（headers 里带 Content-Type）→ buildFulfillParams 自己再剔一次，仍只有系统生成的那一个", () => {
    const hand = {
      status: 200,
      contentType: "application/json",
      body: "{}",
      headers: [
        { name: "content-type", value: "text/html" },
        { name: "Content-Type", value: "image/svg+xml" },
        { name: " CONTENT-TYPE ", value: "application/javascript" },
        { name: "X-Keep", value: "1" },
      ],
    };
    const p = buildFulfillParams(hand, { headers: {} }, "r1");
    expect(countHeader(p, "content-type")).toBe(1);
    expect(valueOf(p, "content-type")).toBe("application/json");
    expect(valueOf(p, "x-keep")).toBe("1");
    expect(JSON.stringify(respHeaders(p))).not.toMatch(/text\/html|svg|javascript/);
  });

  it("纵深（需审批类型也一样）：手工 mock 里夹带第二个 Content-Type 不会让响应出现两个", () => {
    const hand = { status: 200, contentType: "text/html", body: "<b/>", headers: [{ name: "Content-Type", value: "application/json" }] };
    const p = buildFulfillParams(hand, { headers: {} }, "r1");
    expect(countHeader(p, "content-type")).toBe(1);
    expect(valueOf(p, "content-type")).toBe("text/html");
  });

  it("端到端（真 session + 假 CDP）：json mock 命中后实际发出的 Fetch.fulfillRequest 只有一个 Content-Type", async () => {
    const e = await mk();
    await e.rules({ action: "mock", pattern: "https://t.example/*", contentType: "application/json", body: '{"ok":true}', headers: [{ name: "Content-Type", value: "text/html" }, { name: "X-Mock", value: "1" }] });
    e.pause({ url: "https://t.example/api" });
    await e.settle();
    const params = e.lastCmd("Fetch.fulfillRequest")!.params;
    expect(countHeader(params, "content-type")).toBe(1);
    expect(valueOf(params, "content-type")).toBe("application/json");
    expect(valueOf(params, "x-mock")).toBe("1");
  });
});
