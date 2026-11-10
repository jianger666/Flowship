/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-01：network_rules mock 返回 html / js / svg … ≈ 无审批的 evaluate（还旁路 storageAccess）。
 * 修法：有效 Content-Type（显式 > headers 里大小写不敏感的 Content-Type > 嗅探默认）属于「可执行 / 可渲染」集合时，
 * 创建规则前必须过 ensureEvaluateApproval（总闸开着免审批；拒绝 / 超时 → DENIED，规则不落地）；非可执行 mock 强制 nosniff。
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildFulfillParams, buildRuleDef, isExecutableContentType, ruleNeedsEvaluateApproval, sniffContentType } from "../electron-app/browser/net-rules-engine.mjs";
import { makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

let env: P4Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const mk = async () => (env = await makeP4Env());

const def = (p: Record<string, unknown>) => buildRuleDef({ action: "mock", pattern: "*/x", ...p }) as any;
const nopeOf = (p: Record<string, unknown>) => ruleNeedsEvaluateApproval(def(p));

describe("R6-01·有效 Content-Type 判定（纯逻辑）", () => {
  it("可执行 / 可渲染集合全部命中（含 +xml / css / wasm / 任意 *javascript* / ecmascript）", () => {
    for (const ct of [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/javascript",
      "application/javascript",
      "application/x-javascript",
      "text/ecmascript",
      "application/ecmascript",
      "text/jscript",
      "text/xml",
      "application/xml",
      "application/atom+xml",
      "application/rss+xml",
      "application/vnd.foo+xml",
      "text/css",
      "application/wasm",
      "",
    ]) {
      expect(isExecutableContentType(ct), ct).toBe(true);
    }
  });

  it("json / plain / 二进制 / 位图不算可执行（R6-32：免审批改成白名单后，application/pdf 与 application/x-www-form-urlencoded 从这里移走，改走审批，见 browser-r6-mock-allowlist.test.ts）", () => {
    for (const ct of ["application/json", "application/json; charset=utf-8", "text/plain", "text/plain; charset=utf-8", "application/octet-stream", "image/png", "text/csv"]) {
      expect(isExecutableContentType(ct), ct).toBe(false);
    }
  });

  it("显式 content_type：html / js / svg 需要审批，json / plain 不需要", () => {
    expect(nopeOf({ contentType: "text/html", body: "<b>x</b>" })).toBe(true);
    expect(nopeOf({ contentType: "application/javascript", body: "alert(1)" })).toBe(true);
    expect(nopeOf({ contentType: "image/svg+xml", body: "<svg/>" })).toBe(true);
    expect(nopeOf({ contentType: "application/json", body: '{"a":1}' })).toBe(false);
    expect(nopeOf({ contentType: "text/plain", body: "<script>alert(1)</script>" })).toBe(false); // 显式 text/plain：浏览器不会当 html 渲染
  });

  it("headers 里大小写混写的 Content-Type 同样生效（CoNtEnT-tYpE: TEXT/HTML）", () => {
    expect(nopeOf({ headers: { "CoNtEnT-tYpE": "TEXT/HTML" }, body: "x" })).toBe(true);
    expect(nopeOf({ headers: [{ name: "content-TYPE", value: "application/javascript" }], body: "x" })).toBe(true);
    expect(nopeOf({ headers: { "Content-Type": "application/json" }, body: "{}" })).toBe(false);
    // 显式 content_type 优先于 headers（与既有语义一致）：这里有效类型是 json
    expect(nopeOf({ contentType: "application/json", headers: { "Content-Type": "text/html" }, body: "{}" })).toBe(false);
  });

  it("headers 里畸形 / 多值的 Content-Type 直接 BAD_ARGS（没法可靠判断它是不是可执行类型）", () => {
    expect(() => def({ headers: { "Content-Type": "text/plain, text/html" }, body: "x" })).toThrow(/Content-Type 不合法/);
    expect(() => def({ headers: { "Content-Type": "html" }, body: "x" })).toThrow(/Content-Type 不合法/);
  });

  it("默认 content-type（没给）：body 像 html / svg / xml → 当可执行；json / 纯文本 / 空 body 不算", () => {
    expect(sniffContentType("  <!DOCTYPE html><title>x</title>")).toMatch(/^text\/html/);
    expect(sniffContentType("<HTML><body>")).toMatch(/^text\/html/);
    expect(sniffContentType("\n\t<script>fetch('/x')</script>")).toMatch(/^text\/html/);
    expect(sniffContentType("<svg onload=alert(1)>")).toBe("image/svg+xml");
    expect(sniffContentType('<?xml version="1.0"?><a/>')).toMatch(/^application\/xml/);
    expect(sniffContentType("<div>hi</div>")).toMatch(/^text\/html/);
    expect(sniffContentType('{"a":1}')).toMatch(/^application\/json/);
    expect(sniffContentType("[1,2]")).toMatch(/^application\/json/);
    expect(sniffContentType("hello <b>")).toMatch(/^text\/plain/);
    expect(sniffContentType("")).toMatch(/^text\/plain/);
    expect(nopeOf({ body: "<!doctype html><script>steal()</script>" })).toBe(true);
    expect(nopeOf({ body: "<svg/onload=1>" })).toBe(true);
    expect(nopeOf({ body: '{"ok":true}' })).toBe(false);
    expect(nopeOf({ body: "plain text" })).toBe(false);
    expect(nopeOf({})).toBe(false); // 空 body → text/plain
  });

  it("只有 mock 受影响：block / set_headers / fail / delay 不要审批（set_headers 只改请求头，改不了响应类型）", () => {
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "block", pattern: "*/x" }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "set_headers", pattern: "*/x", headers: { Accept: "text/html" } }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "fail", pattern: "*/x" }))).toBe(false);
    expect(ruleNeedsEvaluateApproval(buildRuleDef({ action: "delay", pattern: "*/x", delayMs: 5 }))).toBe(false);
  });

  it("非可执行 mock 的响应强制 X-Content-Type-Options: nosniff（text/plain 的 <script src> 否则照样执行），并覆盖模型自己写的同名头", () => {
    const hdr = (p: any) => (p.responseHeaders as Array<{ name: string; value: string }>).filter((h) => h.name.toLowerCase() === "x-content-type-options");
    const json = buildFulfillParams(def({ contentType: "application/json", body: "{}" }).mock, { headers: {} }, "r1");
    expect(hdr(json)).toEqual([{ name: "X-Content-Type-Options", value: "nosniff" }]);
    const plain = buildFulfillParams(def({ contentType: "text/plain", body: "alert(1)", headers: { "x-content-type-options": "" } }).mock, { headers: {} }, "r1");
    expect(hdr(plain)).toEqual([{ name: "X-Content-Type-Options", value: "nosniff" }]);
    // 可执行类型（已经过审批）不改写
    const html = buildFulfillParams(def({ contentType: "text/html", body: "<p/>" }).mock, { headers: {} }, "r1");
    expect(hdr(html)).toEqual([]);
  });
});

const html = { action: "mock", pattern: "https://target.example/*", contentType: "text/html", body: "<script>fetch('/me').then(r=>r.text()).then(t=>document.title=t)</script>", status: 200 };

/** 起一次 mock 调用并等审批卡出现；返回 { done, card } */
const startMock = async (e: P4Env, args: Record<string, unknown>) => {
  const done = e.rules(args).then(
    (v: unknown) => ({ ok: true as const, v }),
    (err: any) => ({ ok: false as const, code: String(err?.code ?? err) }),
  );
  for (let i = 0; i < 50 && e.session.prompts.list().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
  return { done, card: e.session.prompts.list()[0] as any };
};

describe("R6-01·审批接线（真实 BrowserSession + PromptHub）", () => {
  it("html mock：弹 evaluate 审批卡（文案写清「替换响应、等同执行脚本」），批准前规则不入表、Fetch 没开", async () => {
    const e = await mk();
    const { done, card } = await startMock(e, html);
    expect(card?.kind).toBe("evaluate");
    expect(card.detail.summary).toMatch(/替换页面请求的响应，等同在页面里执行脚本/);
    expect(card.detail.summary).toContain("text/html");
    // 批准前：规则没落地
    expect((await e.rules({ action: "list" })).count).toBe(0);
    expect(e.cmds("Fetch.enable")).toHaveLength(0);
    e.session.prompts.answer(card.id, { action: "task" });
    const r = (await done) as any;
    expect(r.ok).toBe(true);
    expect(r.v.rule).toMatchObject({ action: "mock", contentType: "text/html" });
    expect((await e.rules({ action: "list" })).count).toBe(1);
    expect(e.cmds("Fetch.enable")).toHaveLength(1);
  });

  it("审批被拒 → DENIED，规则不入表、Fetch 不开、活动日志没有「设置网络规则」", async () => {
    const e = await mk();
    const { done, card } = await startMock(e, html);
    e.session.prompts.answer(card.id, { action: "deny" });
    expect(await done).toMatchObject({ ok: false, code: "DENIED" });
    expect((await e.rules({ action: "list" })).count).toBe(0);
    expect(e.cmds("Fetch.enable")).toHaveLength(0);
    expect(e.activitySummaries().join("|")).not.toMatch(/模拟响应/);
  });

  it("审批超时 / 任务取消 → DENIED（规则同样不落地）", async () => {
    const e = await mk();
    // 取消：signal 中止 → 审批卡被撤、抛错
    const ac = new AbortController();
    const p = (e.handlers.net_rules as any)(e.taskId, e.norm("net_rules", html), ac.signal).then(
      () => "OK",
      (err: any) => String(err?.code ?? err?.name ?? err),
    );
    for (let i = 0; i < 50 && e.session.prompts.list().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
    ac.abort(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
    expect(await p).toBe("CANCELLED");
    expect((await e.rules({ action: "list" })).count).toBe(0);
  });

  it("evaluateEnabled 总闸开着：免审批直接放行（不弹卡）", async () => {
    const e = await mk();
    (e.session.host as any).isEvaluateEnabled = () => true;
    const r = await e.rules(html);
    expect(r.rule).toMatchObject({ action: "mock" });
    expect(e.session.prompts.list()).toHaveLength(0);
    expect((await e.rules({ action: "list" })).count).toBe(1);
  });

  it("用例矩阵：js / svg / 无类型但 body 像 html / header 大小写混写 → 都弹卡；json / plain text 不弹卡", async () => {
    const needs: Array<Record<string, unknown>> = [
      { action: "mock", pattern: "*/a.js", contentType: "application/javascript", body: "alert(1)" },
      { action: "mock", pattern: "*/a.svg", contentType: "image/svg+xml", body: "<svg onload=alert(1)/>" },
      { action: "mock", pattern: "*/b", body: "<!DOCTYPE html><html><script>1</script></html>" }, // 无 content-type，嗅探成 html
      { action: "mock", pattern: "*/c", headers: { "cOnTeNt-TyPe": "Text/Html" }, body: "x" },
      { action: "mock", pattern: "*/d", contentType: "text/css", body: "a{}" },
    ];
    for (const args of needs) {
      const e = await mk();
      const { done, card } = await startMock(e, args);
      expect(card?.kind, JSON.stringify(args)).toBe("evaluate");
      e.session.prompts.answer(card.id, { action: "deny" });
      expect(await done).toMatchObject({ ok: false, code: "DENIED" });
      e.cleanup();
      env = null;
    }
    const e = await mk();
    for (const args of [
      { action: "mock", pattern: "*/j", contentType: "application/json", body: '{"a":1}' },
      { action: "mock", pattern: "*/k", body: '{"b":2}' }, // 无类型 + JSON body
      { action: "mock", pattern: "*/p", contentType: "text/plain", body: "hello" },
      { action: "mock", pattern: "*/q", body: "hello" },
      { action: "block", pattern: "*/ads/*" },
      { action: "set_headers", pattern: "*/api/*", headers: { "X-A": "1" } },
    ]) {
      const r = (await e.rules(args)) as any;
      expect(r.rule, JSON.stringify(args)).toBeTruthy();
    }
    expect(e.session.prompts.list()).toHaveLength(0);
    expect((await e.rules({ action: "list" })).count).toBe(6);
  });

  it("用户接管期间创建可执行 mock：先 USER_CONTROL，不弹卡", async () => {
    const e = await mk();
    e.session.takeover();
    const r = (await e.rules(html).then(
      () => "OK",
      (err: any) => String(err?.code),
    )) as string;
    expect(r).toBe("USER_CONTROL");
    expect(e.session.prompts.list()).toHaveLength(0);
  });

  it("活动日志写出有效 Content-Type（用户能看出这条 mock 是 html）且不含 body", async () => {
    const e = await mk();
    (e.session.host as any).isEvaluateEnabled = () => true;
    await e.rules(html);
    const log = e.activitySummaries().join("|");
    expect(log).toMatch(/模拟响应（状态 200，text\/html）/);
    expect(log).not.toContain("fetch('/me')");
  });
});
