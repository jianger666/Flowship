/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P4 / A5 + B1 主进程 op（ops/net-rules.mjs）：**真实** BrowserSession + BrowserTab（假 debugger），夹具见 helpers/browser-e2-p4-fakes.ts。
 * 覆盖：normalize 校验、Fetch 域「有规则才开 / 清空就关」、requestPaused → 处理 + 网络条目 ruled 标记、
 * 用户接管自动暂停 / 交还恢复、tab 关闭清规则、OOPIF 子会话重放、Flowship origin 不生效、凭据不进任何输出、
 * 面板一键清除（ext）、状态贡献者、HAR 导出（net_export：0600 / 脱敏 / 开关 / 活动日志）。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { REFUSE_URL } from "../electron-app/browser/net-rules-engine.mjs";

import { BrowserError, makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

const SECRET = "sk-live-SUPERSECRETVALUE123456";
const BEARER_SECRET = "abcdef0123456789abcdef0123456789";

let env: P4Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const mk = async (o: Parameters<typeof makeP4Env>[0] = {}) => (env = await makeP4Env(o));
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof BrowserError ? e.code : `非 BrowserError：${String(e)}`;
  }
};
const msg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "";
  } catch (e) {
    return String((e as Error).message);
  }
};
const fetchEnables = (e: P4Env, sid: string | null = null) => e.cmds("Fetch.enable").filter((c) => c.sessionId === sid);

describe("normalize：参数在进 runAction / 碰页面之前就校验（BAD_ARGS）", () => {
  it("net_rules：action 必填且在枚举内；禁改头 / 多余参数 / 非法 rule_id / 越界值都被拒", async () => {
    const e = await mk();
    const bad: Array<Record<string, unknown>> = [
      {},
      { action: "nope" },
      { action: "block" },
      { action: "block", pattern: "example.com/x" },
      { action: "block", pattern: "*/x", headers: { A: "1" } },
      { action: "set_headers", pattern: "*/x", headers: { Host: "evil" } },
      { action: "set_headers", pattern: "*/x", headers: { Cookie: "a=1" } },
      { action: "set_headers", pattern: "*/x" },
      { action: "mock", pattern: "*/x", status: 99 },
      { action: "mock", pattern: "*/x", body: "a".repeat(1024 * 1024 + 1) },
      { action: "delay", pattern: "*/x", delayMs: 30_001 },
      { action: "delay", pattern: "*/x" },
      { action: "fail", pattern: "*/x", errorReason: "Evil" },
      { action: "clear", ruleId: "../etc" },
      { action: "clear", ruleId: "r" },
    ];
    for (const args of bad) expect(await code(Promise.resolve().then(() => e.norm("net_rules", args))), JSON.stringify(args).slice(0, 80)).toBe("BAD_ARGS");
    // 合法写法不报错，tabId 透传
    expect(e.norm("net_rules", { action: "list" })).toEqual({ action: "list" });
    expect(e.norm("net_rules", { action: "clear", ruleId: "r3", tabId: "t1" })).toEqual({ action: "clear", ruleId: "r3", tabId: "t1" });
    expect((e.norm("net_rules", { action: "delay", pattern: "*/x", delayMs: 500 }) as any).def).toMatchObject({ action: "delay", delayMs: 500 });
  });

  it("net_export：沿用 browser_network 的过滤参数；默认 limit 500、includeBodies 默认 true；clear 参数被丢弃（导出不清空）", async () => {
    const e = await mk();
    const q = e.norm("net_export", { type: "xhr", status: "4xx", clear: true }) as any;
    expect(q).toMatchObject({ types: ["XHR"], status: { kind: "class", digit: 4 }, limit: 500, includeBodies: true });
    expect("clear" in q).toBe(false);
    expect((e.norm("net_export", { includeBodies: false }) as any).includeBodies).toBe(false);
    expect(await code(Promise.resolve().then(() => e.norm("net_export", { urlRegex: "(a+)+$" })))).toBe("BAD_ARGS");
  });
});

describe("Fetch 域：只有存在规则才 enable、规则清空就 disable", () => {
  it("没规则时（含 list）从不发 Fetch.*；加第一条规则才 Fetch.enable 且 patterns 限定范围", async () => {
    const e = await mk();
    const r = await e.rules({ action: "list" });
    expect(r).toMatchObject({ rules: [], count: 0, limit: 20, paused: false });
    expect(e.cmds("Fetch.enable")).toHaveLength(0);
    expect(e.cmds("Fetch.disable")).toHaveLength(0);

    const added = await e.rules({ action: "block", pattern: "*/ads/*" });
    expect(added).toMatchObject({ action: "block", count: 1, limit: 20, rule: { id: "r1", action: "block", pattern: "*/ads/*", hits: 0 } });
    expect(fetchEnables(e)).toHaveLength(1);
    expect(fetchEnables(e)[0].params.patterns).toEqual([{ urlPattern: "*/ads/*", requestStage: "Request" }]);
  });

  it("再加规则：patterns 合并重发；清掉其中一条：patterns 缩小；清光：Fetch.disable", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/a/*" });
    await e.rules({ action: "delay", pattern: "*/b/*", delayMs: 10 });
    expect(e.lastCmd("Fetch.enable")!.params.patterns.map((p: any) => p.urlPattern)).toEqual(["*/a/*", "*/b/*"]);
    const one = await e.rules({ action: "clear", ruleId: "r1" });
    expect(one).toMatchObject({ action: "clear", removed: 1, count: 1 });
    expect(e.lastCmd("Fetch.enable")!.params.patterns.map((p: any) => p.urlPattern)).toEqual(["*/b/*"]);
    expect(e.cmds("Fetch.disable")).toHaveLength(0);
    const all = await e.rules({ action: "clear" });
    expect(all).toMatchObject({ removed: 1, count: 0 });
    expect(e.cmds("Fetch.disable")).toHaveLength(1);
    // 清空后再 clear：不重复 disable
    await e.rules({ action: "clear" });
    expect(e.cmds("Fetch.disable")).toHaveLength(1);
    expect((await e.rules({ action: "list" })).rules).toEqual([]);
  });

  it("每 tab 最多 20 条：第 21 条 BAD_ARGS 且文案给出清理办法；失败的添加不改变规则数", async () => {
    const e = await mk();
    for (let i = 0; i < 20; i += 1) await e.rules({ action: "block", pattern: `*/p${i}` });
    const m = await msg(e.rules({ action: "block", pattern: "*/overflow" }));
    expect(m).toContain("上限 20");
    expect(m).toContain("clear");
    expect((await e.rules({ action: "list" })).count).toBe(20);
  });

  it("clear 不存在的 rule_id → BAD_ARGS，并列出现有的", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/a" });
    const m = await msg(e.rules({ action: "clear", ruleId: "r9" }));
    expect(m).toContain("r9");
    expect(m).toContain("r1");
    expect(await code(e.rules({ action: "clear", ruleId: "r9" }))).toBe("BAD_ARGS");
  });

  it("Fetch.enable 在主会话上失败 → 回滚这条规则并抛 INTERNAL（规则没生效就不能留着让 UI 误导）", async () => {
    const e = await mk({
      cdp: {
        "Fetch.enable": () => {
          throw new Error("target closed");
        },
      },
    });
    expect(await code(e.rules({ action: "block", pattern: "*/a" }))).toBe("INTERNAL");
    expect((await e.rules({ action: "list" })).count).toBe(0);
    expect(e.stateJson()).not.toContain("netRules\":{\"count\"");
  });
});

describe("Fetch.requestPaused → 处理 + 网络条目标记", () => {
  it("block：failRequest(BlockedByClient)；条目带 ruled=block 且算 failed（即使 loadingFailed 是 canceled）", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "https://a.test/ads/*" });
    e.emit("Network.requestWillBeSent", { requestId: "N1", timestamp: 1, type: "Fetch", request: { url: "https://a.test/ads/1", method: "GET", headers: {} } });
    e.pause({ url: "https://a.test/ads/1", networkId: "N1" });
    await e.settle();
    expect(e.lastCmd("Fetch.failRequest")!.params.errorReason).toBe("BlockedByClient");
    e.emit("Network.loadingFailed", { requestId: "N1", timestamp: 1.1, errorText: "net::ERR_BLOCKED_BY_CLIENT", canceled: true, type: "Fetch" });
    const entry = e.tab.networkRing.list().find((x: any) => x.url.includes("/ads/1"));
    expect(entry).toMatchObject({ ruled: "block", failed: true });
    // 没命中的请求照常放行，没有标记
    e.emit("Network.requestWillBeSent", { requestId: "N2", timestamp: 2, type: "Fetch", request: { url: "https://a.test/api", method: "GET", headers: {} } });
    e.pause({ url: "https://a.test/api", networkId: "N2" });
    await e.settle();
    expect(e.lastCmd("Fetch.continueRequest")!.params).toEqual({ requestId: expect.any(String) });
  });

  it("requestPaused 比 requestWillBeSent 先到：标记暂存，条目创建时取走", async () => {
    const e = await mk();
    await e.rules({ action: "mock", pattern: "https://a.test/api/*", body: '{"mock":true}' });
    e.pause({ url: "https://a.test/api/x", networkId: "N9" });
    await e.settle();
    expect(e.lastCmd("Fetch.fulfillRequest")!.params).toMatchObject({ responseCode: 200 });
    e.request("N9", { url: "https://a.test/api/x" });
    expect(e.tab.networkRing.list().find((x: any) => x.url.endsWith("/api/x"))).toMatchObject({ ruled: "mock" });
  });

  it("R14：mock 命中跨源带体的 POST → 就地拒绝（continueRequest 改写 url，绝无 fulfillRequest / failRequest）；条目 ruled=mock-refused 且算 failed；命中次数照常累加；同源 POST 与跨源 GET 的 mock 照常 fulfill", async () => {
    const e = await mk();
    await e.rules({ action: "mock", pattern: "*/api/handover/*", status: 200, body: '{"total":1}' });
    const API = "https://crm-api.test/api/handover/unassigned/page";
    // ① 现场形态：页面 https://crm.test 向 https://crm-api.test 发带 JSON 体的 POST
    e.emit("Network.requestWillBeSent", { requestId: "X1", timestamp: 1, type: "XHR", request: { url: API, method: "POST", headers: { Origin: "https://crm.test" }, hasPostData: true } });
    e.pause({ url: API, method: "POST", headers: { Origin: "https://crm.test", "Content-Type": "application/json" }, hasPostData: true, postData: "{}", networkId: "X1" });
    await e.settle();
    expect(e.cmds("Fetch.fulfillRequest")).toHaveLength(0);
    expect(e.cmds("Fetch.failRequest")).toHaveLength(0);
    const refusal = e.lastCmd("Fetch.continueRequest")!.params;
    expect(refusal.url).toBe(REFUSE_URL);
    expect(Object.keys(refusal).sort()).toEqual(["requestId", "url"]); // 没有 headers / postData 等别的改写
    // canceled:true 与 block 用例同口径：CDP 对「被终结」的请求的 loadingFailed 可能带 canceled，那样默认不算失败——mock-refused 必须自己保证算 failed（tab.mjs 的 ruled 判定）
    e.emit("Network.loadingFailed", { requestId: "X1", timestamp: 1.1, errorText: "net::ERR_UNSAFE_PORT", canceled: true, type: "XHR" });
    expect(e.tab.networkRing.list().find((x: any) => x.url === API)).toMatchObject({ ruled: "mock-refused", failed: true });
    // ② 同源 POST（Origin = 请求 URL 的 origin）：照常 fulfill，标记 mock
    const SAME = "https://crm-api.test/api/handover/same";
    e.emit("Network.requestWillBeSent", { requestId: "X2", timestamp: 2, type: "XHR", request: { url: SAME, method: "POST", headers: {}, hasPostData: true } });
    e.pause({ url: SAME, method: "POST", headers: { Origin: "https://crm-api.test" }, hasPostData: true, postData: "{}", networkId: "X2" });
    // ③ 跨源 GET：照常 fulfill
    const GET = "https://crm-api.test/api/handover/get";
    e.emit("Network.requestWillBeSent", { requestId: "X3", timestamp: 3, type: "XHR", request: { url: GET, method: "GET", headers: {} } });
    e.pause({ url: GET, method: "GET", headers: { Origin: "https://crm.test" }, networkId: "X3" });
    await e.settle();
    expect(e.cmds("Fetch.fulfillRequest")).toHaveLength(2);
    expect(e.cmds("Fetch.failRequest")).toHaveLength(0);
    e.emit("Network.loadingFinished", { requestId: "X2", timestamp: 2.1 });
    e.emit("Network.loadingFinished", { requestId: "X3", timestamp: 3.1 });
    const byUrl = (u: string) => e.tab.networkRing.list().find((x: any) => x.url === u);
    expect(byUrl(SAME)).toMatchObject({ ruled: "mock" });
    expect(byUrl(GET)).toMatchObject({ ruled: "mock" });
    expect(byUrl(SAME)?.failed).toBeFalsy();
    // 三次都算命中（包括被拒的那次）
    expect(((await e.rules({ action: "list" })).rules as any[])[0].hits).toBe(3);
  });

  it("R14：block / fail 命中跨源带体的 POST 同样就地拒绝（failRequest 对它们同样会令 Chromium 崩溃）；条目 ruled 仍是 block / fail 且算 failed", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/api/blocked*" });
    await e.rules({ action: "fail", pattern: "*/api/failed*", errorReason: "ConnectionRefused" });
    for (const [rid, path] of [["B1", "blocked"], ["F1", "failed"]] as const) {
      const url = `https://crm-api.test/api/${path}`;
      e.emit("Network.requestWillBeSent", { requestId: rid, timestamp: 1, type: "XHR", request: { url, method: "POST", headers: { Origin: "https://crm.test" }, hasPostData: true } });
      e.pause({ url, method: "POST", headers: { Origin: "https://crm.test" }, hasPostData: true, postData: "x", networkId: rid });
      await e.settle();
      e.emit("Network.loadingFailed", { requestId: rid, timestamp: 1.1, errorText: "net::ERR_UNSAFE_PORT", canceled: false, type: "XHR" });
    }
    expect(e.cmds("Fetch.failRequest")).toHaveLength(0);
    expect(e.cmds("Fetch.fulfillRequest")).toHaveLength(0);
    expect(e.cmds("Fetch.continueRequest").map((c) => c.params.url)).toEqual([REFUSE_URL, REFUSE_URL]);
    const list = e.tab.networkRing.list();
    expect(list.find((x: any) => x.url.endsWith("/api/blocked"))).toMatchObject({ ruled: "block", failed: true });
    expect(list.find((x: any) => x.url.endsWith("/api/failed"))).toMatchObject({ ruled: "fail", failed: true });
    // 对照：同一条 block 规则对跨源 GET 仍是 failRequest(BlockedByClient)
    e.pause({ url: "https://crm-api.test/api/blocked?g=1", method: "GET", headers: { Origin: "https://crm.test" } });
    await e.settle();
    expect(e.lastCmd("Fetch.failRequest")!.params.errorReason).toBe("BlockedByClient");
  });

  it("set_headers：continueRequest 带整体 headers（原头 + 新头）；命中次数累加到 list", async () => {
    const e = await mk();
    await e.rules({ action: "set_headers", pattern: "*/api/*", headers: [{ name: "X-Debug", value: "1" }] });
    e.pause({ url: "https://a.test/api/x", headers: { Accept: "*/*" } });
    e.pause({ url: "https://a.test/api/y", headers: { Accept: "*/*" } });
    await e.settle();
    const cont = e.cmds("Fetch.continueRequest").filter((c) => c.params.headers);
    expect(cont).toHaveLength(2);
    expect(cont[0].params.headers).toEqual([
      { name: "Accept", value: "*/*" },
      { name: "X-Debug", value: "1" },
    ]);
    expect(((await e.rules({ action: "list" })).rules as any[])[0].hits).toBe(2);
  });

  it("红线：Flowship origin 的请求即使 pattern 是 * 也只放行、不打标记", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*" });
    await e.rules({ action: "set_headers", pattern: "*", headers: { "X-Evil": SECRET } });
    e.emit("Network.requestWillBeSent", { requestId: "A1", timestamp: 1, type: "Fetch", request: { url: "https://flowship.local/api/tasks", method: "GET", headers: {} } });
    e.pause({ url: "https://flowship.local/api/tasks", networkId: "A1" });
    await e.settle();
    expect(e.cmds("Fetch.failRequest")).toHaveLength(0);
    expect(e.lastCmd("Fetch.continueRequest")!.params).toEqual({ requestId: expect.any(String) });
    e.emit("Network.loadingFinished", { requestId: "A1", timestamp: 1.1 });
    expect(e.tab.networkRing.list().find((x: any) => x.url.includes("flowship.local"))?.ruled).toBeUndefined();
    // 对照：非 Flowship 的同一规则照常生效
    e.pause({ url: "https://other.test/x" });
    await e.settle();
    expect(e.cmds("Fetch.failRequest")).toHaveLength(1);
  });
});

describe("红线：set_headers 的值不出现在任何输出里", () => {
  it("返回值 / list / 状态 JSON / 活动日志 / 状态推送参数都只有头名", async () => {
    const e = await mk();
    const added = await e.rules({ action: "set_headers", pattern: "*/api/*", headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }, { name: "X-Api-Key", value: SECRET }] });
    const listed = await e.rules({ action: "list" });
    expect(added.rule.headerNames).toEqual(["Authorization", "X-Api-Key"]);
    for (const out of [JSON.stringify(added), JSON.stringify(listed), e.stateJson(), JSON.stringify(e.activitySummaries()), JSON.stringify(e.scheduleState.mock.calls)]) {
      expect(out).not.toContain(SECRET);
    }
    expect(e.activitySummaries().join("\n")).toContain("Authorization");
    expect(e.activitySummaries().join("\n")).toContain("值已隐藏");
    // 值只存在于主进程规则对象里（用于 Fetch.continueRequest），确实被用上了
    e.pause({ url: "https://a.test/api/x" });
    await e.settle();
    expect(JSON.stringify(e.lastCmd("Fetch.continueRequest")!.params)).toContain(SECRET);
  });

  it("mock 的 body / 响应头值同样不进 list / 活动日志（只有大小与头名）；pattern 里的 query 密钥被脱敏", async () => {
    const e = await mk();
    await e.rules({ action: "mock", pattern: "https://a.test/api?token=SUPERSECRETTOKEN123456", body: `{"k":"${SECRET}"}`, headers: { "X-Mock": SECRET } });
    const listed = await e.rules({ action: "list" });
    const all = JSON.stringify([listed, e.stateJson(), e.activitySummaries()]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("SUPERSECRETTOKEN123456");
    expect(listed.rules[0]).toMatchObject({ action: "mock", status: 200, bodyBytes: expect.any(Number), headerNames: ["X-Mock"] });
  });
});

describe("用户接管：规则自动暂停，交还后恢复", () => {
  it("controller=user → Fetch.disable、list 标 paused、状态 paused=true、挂起的请求不再被改写；交还 → Fetch.enable 恢复且规则没丢", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/ads/*" });
    expect(fetchEnables(e)).toHaveLength(1);

    e.session.controller = "user";
    await e.settle();
    expect(e.cmds("Fetch.disable")).toHaveLength(1);
    const paused = await e.rules({ action: "list" });
    expect(paused).toMatchObject({ paused: true, count: 1 });
    expect(e.session.getState().netRules).toEqual({ count: 1, paused: true });
    // 暂停期间（理论上 Fetch 已关；万一有迟到的事件）命中的请求也只放行
    e.pause({ url: "https://a.test/ads/1" });
    await e.settle();
    expect(e.cmds("Fetch.failRequest")).toHaveLength(0);
    expect(e.cmds("Fetch.continueRequest").length).toBeGreaterThan(0);

    e.session.controller = "idle";
    await e.settle();
    expect(fetchEnables(e)).toHaveLength(2);
    expect(e.session.getState().netRules).toEqual({ count: 1, paused: false });
    e.pause({ url: "https://a.test/ads/2" });
    await e.settle();
    expect(e.cmds("Fetch.failRequest")).toHaveLength(1);
  });

  it("接管期间 AI 的添加 / 清除一律 USER_CONTROL；list 仍可读", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/a" });
    e.session.controller = "user";
    expect(await code(e.rules({ action: "block", pattern: "*/b" }))).toBe("USER_CONTROL");
    expect(await code(e.rules({ action: "clear" }))).toBe("USER_CONTROL");
    expect((await e.rules({ action: "list" })).count).toBe(1);
  });

  it("等延迟的请求在用户接管瞬间被立刻放行（不会等满 delay 或被改写）", async () => {
    const e = await mk();
    await e.rules({ action: "delay", pattern: "*/slow", delayMs: 20_000 });
    e.pause({ url: "https://a.test/slow", requestId: "slow-1" });
    await e.settle();
    expect(e.cmds("Fetch.continueRequest")).toHaveLength(0); // 还在等
    const t0 = Date.now();
    e.session.controller = "user";
    await e.settle(12);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(e.cmds("Fetch.continueRequest").some((c) => c.params.requestId === "slow-1")).toBe(true);
  });
});

describe("生命周期：tab 关闭 / 子会话重放 / 面板一键清除", () => {
  it("tab 关闭 → 规则随 ext.dispose 清掉、状态里不再有 netRules；旧 tab 的迟到事件不再被处理", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/a" });
    expect(e.session.getState().netRules).toEqual({ count: 1, paused: false });
    const oldTab = e.tab;
    const rt = oldTab.ext.get("netrules");
    await e.session.closeTab(oldTab.id);
    expect(rt.count()).toBe(0);
    expect(e.session.getState().netRules ?? null).toBeNull();
    const before = e.cmds("Fetch.failRequest").length;
    e.emit("Fetch.requestPaused", { requestId: "late", networkId: "x", request: { url: "https://a.test/a", method: "GET", headers: {} } });
    await e.settle();
    expect(e.cmds("Fetch.failRequest")).toHaveLength(before);
  });

  it("OOPIF 子会话初始化时重放：有规则 → 子会话也 Fetch.enable；没规则 → 不发", async () => {
    const e = await mk();
    e.emit("Target.attachedToTarget", { sessionId: "child0", targetInfo: { type: "iframe", targetId: "T0" } });
    await e.settle(12);
    expect(fetchEnables(e, "child0")).toHaveLength(0);

    await e.rules({ action: "block", pattern: "*/ads/*" });
    e.emit("Target.attachedToTarget", { sessionId: "child1", targetInfo: { type: "iframe", targetId: "T1" } });
    await e.settle(12);
    expect(fetchEnables(e, "child1")).toHaveLength(1);
    expect(fetchEnables(e, "child1")[0].params.patterns).toEqual([{ urlPattern: "*/ads/*", requestStage: "Request" }]);

    // 子会话里的暂停用子会话回复
    e.pause({ url: "https://a.test/ads/1", sessionId: "child1" });
    await e.settle();
    expect(e.lastCmd("Fetch.failRequest")!.sessionId).toBe("child1");
  });

  it("清空规则时子会话也 Fetch.disable", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/a" });
    e.emit("Target.attachedToTarget", { sessionId: "child1", targetInfo: { type: "iframe", targetId: "T1" } });
    await e.settle(12);
    await e.rules({ action: "clear" });
    expect(e.cmds("Fetch.disable").map((c) => c.sessionId).sort()).toEqual([null, "child1"].sort());
  });

  it("ext netrules.clear：用户一键清除（接管期间也可用）→ 规则清光、Fetch.disable、写一条系统活动、状态回到 null", async () => {
    const e = await mk();
    await e.rules({ action: "block", pattern: "*/a" });
    await e.rules({ action: "mock", pattern: "*/b", body: "x" });
    expect(e.exts.has("netrules.clear")).toBe(true);
    e.session.controller = "user";
    await e.settle();
    const r = (await e.exts.get("netrules.clear")!(e.session)) as { cleared: number };
    expect(r.cleared).toBe(2);
    expect((await e.rules({ action: "list" })).count).toBe(0);
    expect(e.session.getState().netRules ?? null).toBeNull();
    const recent = (e.session.getState().recent as Array<{ summary?: string }>).map((x) => x.summary ?? "");
    expect(recent.some((s) => s.includes("用户清除了") && s.includes("2"))).toBe(true);
    // 没规则时再清：cleared=0，不写活动
    const n = recent.length;
    expect(((await e.exts.get("netrules.clear")!(e.session)) as any).cleared).toBe(0);
    expect((e.session.getState().recent as unknown[]).length).toBe(n);
  });

  it("状态贡献者：没规则 → 不贡献；有规则 → { count, paused }（多 tab 汇总）", async () => {
    const e = await mk();
    expect(e.stateContributors[0](e.session)).toEqual({});
    await e.rules({ action: "block", pattern: "*/a" });
    await e.rules({ action: "block", pattern: "*/b" });
    expect(e.stateContributors[0](e.session)).toEqual({ netRules: { count: 2, paused: false } });
  });
});

describe("B1：真实 tab 的条目字段（缓存 / Service Worker / initiator / 流式连接）", () => {
  it("内存缓存命中（requestServedFromCache）/ 磁盘缓存 / Service Worker 来源都进条目；initiator ≤3 帧且 URL 脱敏", async () => {
    const e = await mk();
    // 内存缓存：requestWillBeSent → requestServedFromCache → responseReceived → finished
    e.emit("Network.requestWillBeSent", {
      requestId: "C1",
      timestamp: 1,
      type: "Script",
      request: { url: "https://a.test/a.js", method: "GET", headers: {} },
      initiator: { type: "script", stack: { callFrames: Array.from({ length: 6 }, (_, i) => ({ functionName: `f${i}`, url: `https://a.test/app.js?token=${SECRET}`, lineNumber: i, columnNumber: 0 })) } },
    });
    e.emit("Network.requestServedFromCache", { requestId: "C1" });
    e.emit("Network.responseReceived", { requestId: "C1", type: "Script", response: { status: 200, mimeType: "text/javascript", headers: {} } });
    e.emit("Network.loadingFinished", { requestId: "C1", timestamp: 1.1 });
    // 磁盘缓存 + SW
    e.emit("Network.requestWillBeSent", { requestId: "C2", timestamp: 2, type: "Fetch", request: { url: "https://a.test/b", method: "GET", headers: {} } });
    e.emit("Network.responseReceived", { requestId: "C2", type: "Fetch", response: { status: 200, mimeType: "text/plain", headers: {}, fromDiskCache: true, fromServiceWorker: true } });
    e.emit("Network.loadingFinished", { requestId: "C2", timestamp: 2.1 });
    const [c1, c2] = e.tab.networkRing.list();
    expect(c1.cache).toBe("fromMemoryCache");
    expect(c1.initiator.stack).toHaveLength(3);
    expect(JSON.stringify(c1.initiator)).not.toContain(SECRET);
    expect(c2).toMatchObject({ cache: "fromDiskCache", fromServiceWorker: true });
  });

  it("WebSocket：创建即入环（不等收尾）、帧计数；network clear 与帧一起清空，清空后到达的帧不复活", async () => {
    const e = await mk();
    e.emit("Network.webSocketCreated", { requestId: "W1", url: "wss://a.test/ws" });
    e.emit("Network.webSocketHandshakeResponseReceived", { requestId: "W1", response: { status: 101, headers: {} } });
    e.emit("Network.webSocketFrameReceived", { requestId: "W1", response: { opcode: 1, payloadData: `hello Bearer ${BEARER_SECRET}` } });
    const [ws] = e.tab.networkRing.list();
    expect(ws).toMatchObject({ type: "WebSocket", status: 101, frameCount: 1 });
    const frames = e.tab.streams.framesOf(ws.id, 10);
    expect(JSON.stringify(frames)).not.toContain(BEARER_SECRET);
    e.tab.clearNetwork();
    expect(e.tab.networkRing.list()).toHaveLength(0);
    e.emit("Network.webSocketFrameReceived", { requestId: "W1", response: { opcode: 1, payloadData: "late" } });
    expect(e.tab.streams.size()).toBe(0);
    expect(e.tab.networkRing.list()).toHaveLength(0);
  });

  it("SSE：responseReceived 时入环并立刻出在途表（不会让 wait_for networkIdle 永远等不到空闲）", async () => {
    const e = await mk();
    e.emit("Network.requestWillBeSent", { requestId: "S1", timestamp: 1, type: "EventSource", request: { url: "https://a.test/sse", method: "GET", headers: {} } });
    e.emit("Network.responseReceived", { requestId: "S1", type: "EventSource", response: { status: 200, mimeType: "text/event-stream", headers: {} } });
    expect(e.tab.inflight.size).toBe(0);
    e.emit("Network.eventSourceMessageReceived", { requestId: "S1", eventName: "tick", eventId: "1", data: `x Bearer ${BEARER_SECRET}` });
    const [sse] = e.tab.networkRing.list();
    expect(sse).toMatchObject({ type: "EventSource", frameCount: 1 });
    e.emit("Network.loadingFinished", { requestId: "S1", timestamp: 2 });
    expect(e.tab.networkRing.list()[0]).toMatchObject({ closed: true });
    expect(JSON.stringify(e.tab.streams.framesOf(sse.id))).not.toContain(BEARER_SECRET);
  });
});

describe("net_export：HAR 导出", () => {
  const withBody = (body: string) => ({ "Network.getResponseBody": () => ({ body, base64Encoded: false }) });

  it("产出合法 HAR 1.2：写在 <userData>/data/tasks/<taskId>/browser-har/、文件 0600 / 目录 0700、不含明文 token；结果 redacted=true、无路径以外的敏感信息", async () => {
    const e = await mk({ cdp: withBody(`{"jwt":"Bearer ${BEARER_SECRET}","ok":1}`), url: "https://a.test/" });
    e.emit("Network.requestWillBeSent", { requestId: "R1", timestamp: 1, type: "Fetch", request: { url: `https://a.test/api?token=${SECRET}&ok=1`, method: "POST", headers: { Authorization: `Bearer ${BEARER_SECRET}`, "X-Trace": "t" }, postData: `{"password":"hunter2hunter2"}`, hasPostData: true } });
    e.emit("Network.responseReceived", { requestId: "R1", type: "Fetch", response: { status: 200, mimeType: "application/json", headers: { "Set-Cookie": "sid=NEWSESSIONSECRET", "Content-Type": "application/json" } } });
    e.emit("Network.loadingFinished", { requestId: "R1", timestamp: 1.2 });
    e.request("R2", { url: "https://a.test/second" });

    const r = await e.call("net_export", {});
    expect(r).toMatchObject({ entries: 2, omitted: 0, truncated: false, redacted: true, bodiesIncluded: true });
    expect(r.path.startsWith(e.harDir + path.sep)).toBe(true);
    expect(r.file).toMatch(/^net-\d{8}-\d{6}-a\.test\.har$/);
    const text = fs.readFileSync(r.path, "utf8");
    const har = JSON.parse(text);
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries).toHaveLength(2);
    for (const secret of [SECRET, BEARER_SECRET, "NEWSESSIONSECRET", "hunter2hunter2"]) expect(text).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(har.log.entries[0].request.url).toContain("ok=1");
    if (process.platform !== "win32") {
      expect(fs.statSync(r.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(e.harDir).mode & 0o777).toBe(0o700);
    }
    expect(e.activitySummaries().some((s) => s.includes("导出了网络记录") && s.includes("2"))).toBe(true);
    expect(e.activitySummaries().join("\n")).not.toContain(e.userData); // 活动日志不写路径
  });

  it("响应体里的凭据被脱敏后才进 HAR（Bearer / JWT / token=）", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const e = await mk({ cdp: withBody(`{"a":"${jwt}","b":"Bearer ${BEARER_SECRET}","c":"x"}`) });
    e.request("R1", { url: "https://a.test/api" });
    const r = await e.call("net_export", {});
    const text = fs.readFileSync(r.path, "utf8");
    expect(text).not.toContain(jwt);
    expect(text).not.toContain(BEARER_SECRET);
    expect(text).toContain('\\"c\\":\\"x\\"');
  });

  it("主进程独立判 networkBodyRead：关着 → 不取 body（没有 Network.getResponseBody 调用）、HAR 不含 body 与帧文本，结果标 bodiesDisabled", async () => {
    const e = await mk({ config: { networkBodyRead: false }, cdp: withBody(`{"secret":"${SECRET}"}`) });
    e.request("R1", { url: "https://a.test/api" });
    const r = await e.call("net_export", {});
    expect(r).toMatchObject({ bodiesIncluded: false, bodiesDisabled: true });
    expect(e.cmds("Network.getResponseBody")).toHaveLength(0);
    const text = fs.readFileSync(r.path, "utf8");
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).log.entries[0].response.content.text).toBeUndefined();
  });

  it("include_bodies=false：不取 body，也不标 bodiesDisabled", async () => {
    const e = await mk({ cdp: withBody("x") });
    e.request("R1");
    const r = await e.call("net_export", { includeBodies: false });
    expect(r).toMatchObject({ bodiesIncluded: false });
    expect(r.bodiesDisabled).toBeUndefined();
    expect(e.cmds("Network.getResponseBody")).toHaveLength(0);
  });

  it("过滤参数对导出同样生效；当前条件下没有条目 → BAD_ARGS 并提示放宽", async () => {
    const e = await mk({ cdp: withBody("{}") });
    e.request("R1", { url: "https://a.test/ok", status: 200 });
    e.request("R2", { url: "https://a.test/missing", status: 404 });
    const only404 = await e.call("net_export", { status: "404" });
    expect(only404.entries).toBe(1);
    expect(JSON.parse(fs.readFileSync(only404.path, "utf8")).log.entries[0].request.url).toContain("/missing");
    const m = await msg(e.call("net_export", { urlRegex: "nomatch-zzz" }));
    expect(m).toContain("没有可导出");
    expect(await code(e.call("net_export", { urlRegex: "nomatch-zzz" }))).toBe("BAD_ARGS");
  });

  it("导出不清空网络记录；连续导出不覆盖（文件名加后缀）", async () => {
    const e = await mk({ cdp: withBody("{}"), now: () => new Date(2026, 10, 9, 8, 0, 0).getTime() });
    e.request("R1");
    const a = await e.call("net_export", {});
    const b = await e.call("net_export", {});
    expect(a.file).not.toBe(b.file);
    expect(e.tab.networkRing.list()).toHaveLength(1);
    expect(fs.readdirSync(e.harDir).filter((f) => f.endsWith(".har"))).toHaveLength(2);
  });

  it("任务 id 不是安全字符 → INTERNAL（绝不拼路径），不写任何文件", async () => {
    const e = await mk({ taskId: "../evil", cdp: withBody("{}") });
    e.request("R1");
    expect(await code(e.call("net_export", {}))).toBe("INTERNAL");
    expect(fs.existsSync(path.join(e.userData, "data"))).toBe(false);
  });
});
