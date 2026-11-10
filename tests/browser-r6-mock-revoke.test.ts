/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-31：撤销 evaluate 批准 / 总闸 开→关 时，「批准过的」可执行 mock 必须一并收回。
 *
 * 之前的洞：html / js / svg 这类 mock 只在**创建那一刻**过一次 evaluate 审批；之后用户点面板「撤销批准」、或在设置里把「免审批执行页面脚本」总闸关掉，
 * 规则仍留在规则表里继续向目标站 origin 注入脚本——撤销批准形同虚设。修法是两道：
 *   ① 联动清理：revokeEvaluateApproval 触发会话级 hook，同步把本会话所有 tab 里「需要审批类型」的 mock 从规则表摘掉 + 写一条用户可见的系统活动日志；
 *   ② 二次判定：命中决策前 / fulfill 前按「当下」授权状态重判（总闸关且无会话批准 → 当作没有这条 mock，放行原请求），防 hook 没跑到 / 总闸与批准之间的时间窗。
 * 两道**互相掩护**（①清掉后②看不到东西；②拦着时①的缺失看不出来），所以测试要把它们拆开单独验：
 *   · ① 的专属观测量：规则表 / Fetch.enable 的 patterns / Fetch.disable / 「因撤销批准清除了 n 条」日志——手工改会话标记绕过 hook 时这些都不会变；
 *   · ② 的专属观测量：手工改会话标记（不走 revokeEvaluateApproval，hook 不会跑）后，规则仍在表里，但命中时不 fulfill + 写「批准已失效」日志。
 * manager 层（onConfig 开→关）的接线见 browser-r6-evaluate-wiring.test.ts。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVALUATE_APPROVAL_EXT, revokeEvaluateApproval } from "../electron-app/browser/evaluate-approval.mjs";
import { buildRuleDef, createPauseController, createRuleStore } from "../electron-app/browser/net-rules-engine.mjs";
import { makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

let env: P4Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const mk = async () => (env = await makeP4Env());

const TARGET = "https://target.example/page.html";
const html = { action: "mock", pattern: "https://target.example/*", contentType: "text/html", body: "<script>fetch('/me')</script>", status: 200 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起一次可执行 mock 创建、等审批卡、按 action 回答，返回创建结果 */
const createApproved = async (e: P4Env, args: Record<string, unknown>, action: "task" | "always" = "task") => {
  const done = e.rules(args);
  for (let i = 0; i < 100 && e.session.prompts.list().length === 0; i += 1) await sleep(2);
  const card = e.session.prompts.list()[0] as any;
  expect(card?.kind, "应弹 evaluate 审批卡").toBe("evaluate");
  e.session.prompts.answer(card.id, { action });
  return done;
};

/** 会话级批准标记所在的状态对象（直接改它 = 绕过 revokeEvaluateApproval 的联动清理） */
const approvalState = (e: P4Env) => e.session.getExt(EVALUATE_APPROVAL_EXT, () => ({ approved: false, inflight: null })) as { approved: boolean };
const setGate = (e: P4Env, initial: boolean) => {
  const g = { on: initial };
  (e.session.host as any).isEvaluateEnabled = () => g.on;
  return g;
};
/** 系统活动日志（actor=system）的摘要 */
const sysLog = (e: P4Env): string[] => (e.session.getState().recent as Array<{ actor: string; summary?: string }>).filter((x) => x.actor === "system").map((x) => x.summary ?? "");
const fulfilledIds = (e: P4Env) => e.cmds("Fetch.fulfillRequest").map((c) => c.params.requestId);
const continuedIds = (e: P4Env) => e.cmds("Fetch.continueRequest").map((c) => c.params.requestId);
const patternsOf = (e: P4Env) => (e.lastCmd("Fetch.enable")?.params.patterns ?? []).map((p: any) => p.urlPattern).sort();

describe("R6-31·第一道：撤销批准 → 联动清掉需审批的 mock", () => {
  it("revoke：需审批的 mock 同步从规则表消失、其它规则保留；Fetch 重新同步；写「因撤销批准清除了 1 条模拟响应」；之后命中不再 fulfill", async () => {
    const e = await mk();
    await createApproved(e, html);
    await e.rules({ action: "mock", pattern: "https://other.example/*", contentType: "application/json", body: '{"a":1}' });
    await e.rules({ action: "block", pattern: "*/ads/*" });
    // 对照：撤销前命中 → fulfill
    e.pause({ url: TARGET, requestId: "before" });
    await e.settle();
    expect(fulfilledIds(e)).toEqual(["before"]);

    expect(revokeEvaluateApproval(e.session)).toBe(true); // 之前确实处于「仅本任务」批准状态
    // 同步性：revoke 一返回规则就已不在表里（不是等异步 Fetch 同步完）——紧接着到的请求不会命中它
    e.pause({ url: TARGET, requestId: "after" });
    await e.settle(12);
    expect(fulfilledIds(e)).toEqual(["before"]);
    expect(continuedIds(e)).toContain("after");

    const list = await e.rules({ action: "list" });
    expect(list.count).toBe(2);
    expect(list.rules.map((r: any) => r.pattern).sort()).toEqual(["*/ads/*", "https://other.example/*"]);
    expect(patternsOf(e)).toEqual(["*/ads/*", "https://other.example/*"]); // Fetch.enable 的 patterns 已不含目标站
    const log = sysLog(e).join("|");
    expect(log).toContain("因撤销批准清除了 1 条模拟响应");
    expect(log).not.toContain("总开关"); // 面板「撤销批准」不是总闸被关
    // 日志不含 body / 脚本内容
    expect(log).not.toContain("fetch('/me')");
  });

  it("撤销后清空了所有规则 → Fetch.disable（不留空转的拦截）", async () => {
    const e = await mk();
    await createApproved(e, html);
    expect(e.cmds("Fetch.disable")).toHaveLength(0);
    revokeEvaluateApproval(e.session);
    await e.settle(12);
    expect(e.cmds("Fetch.disable")).toHaveLength(1);
    expect((await e.rules({ action: "list" })).count).toBe(0);
  });

  it("总闸 开→关（reason=gate-off）：总闸开着时免审批创建的可执行 mock 同样被收回（此前没有会话批准，had=false），日志写明是总开关被关", async () => {
    const e = await mk();
    const gate = setGate(e, true);
    await e.rules(html); // 总闸开着：免审批
    expect(e.session.prompts.list()).toHaveLength(0);
    e.pause({ url: TARGET, requestId: "gate-on" });
    await e.settle();
    expect(fulfilledIds(e)).toEqual(["gate-on"]);

    gate.on = false;
    expect(revokeEvaluateApproval(e.session, { reason: "gate-off" })).toBe(false); // 没有会话批准可撤，但 mock 照样要清
    expect((await e.rules({ action: "list" })).count).toBe(0);
    e.pause({ url: TARGET, requestId: "gate-off" });
    await e.settle(12);
    expect(fulfilledIds(e)).toEqual(["gate-on"]);
    expect(sysLog(e).join("|")).toMatch(/因撤销批准清除了 1 条模拟响应.*总开关/);
  });

  it("没有需审批的 mock（只有 json mock / block）：撤销不动它们、不写「因撤销批准」日志（不刷屏、不误删）", async () => {
    const e = await mk();
    await e.rules({ action: "mock", pattern: "https://j.example/*", contentType: "application/json", body: "{}" });
    await e.rules({ action: "block", pattern: "*/ads/*" });
    expect(revokeEvaluateApproval(e.session)).toBe(false);
    await e.settle(12);
    expect((await e.rules({ action: "list" })).count).toBe(2);
    expect(sysLog(e).join("|")).not.toContain("因撤销批准");
    expect(e.cmds("Fetch.disable")).toHaveLength(0);
  });

  it("多个需审批的 mock 一次清完，日志写总条数（多 tab 的规则也在内）", async () => {
    const e = await mk();
    const gate = setGate(e, true);
    await e.rules(html);
    await e.rules({ ...html, pattern: "https://target2.example/*", contentType: "image/svg+xml", body: "<svg onload=1/>" });
    await e.rules({ ...html, pattern: "https://target3.example/*", contentType: "application/javascript", body: "1" });
    const tab2: any = await e.session.openTab({});
    await e.rules({ ...html, pattern: "https://target4.example/*", tabId: tab2.id });
    gate.on = false;
    revokeEvaluateApproval(e.session, { reason: "gate-off" });
    await e.settle(16);
    expect((await e.rules({ action: "list" })).count).toBe(0);
    expect((await e.rules({ action: "list", tabId: tab2.id })).count).toBe(0);
    expect(sysLog(e).join("|")).toContain("因撤销批准清除了 4 条模拟响应");
  });
});

describe("R6-31·第二道：命中 / fulfill 前按当下授权重判（绕过联动清理单独验）", () => {
  it("会话标记被改回未批准（模拟 hook 没跑到）：规则仍在表里，但命中不再 fulfill、放行原请求；「批准已失效」日志每条规则只写一次", async () => {
    const e = await mk();
    const gate = setGate(e, false);
    await createApproved(e, html);
    approvalState(e).approved = false; // 直接改标记，不走 revokeEvaluateApproval
    for (const id of ["a", "b", "c"]) e.pause({ url: TARGET, requestId: id });
    await e.settle(12);
    expect(fulfilledIds(e)).toEqual([]);
    expect(continuedIds(e)).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect((await e.rules({ action: "list" })).count).toBe(1); // 联动清理没发生：规则还在，只是不生效
    expect(sysLog(e).filter((s) => s.includes("批准已失效"))).toHaveLength(1);
    expect(sysLog(e).join("|")).not.toContain("因撤销批准清除了");

    // 授权恢复（总闸开了）→ 同一条规则又生效（说明拦下的是「授权判定」而不是把规则弄坏了）
    gate.on = true;
    e.pause({ url: TARGET, requestId: "d" });
    await e.settle();
    expect(fulfilledIds(e)).toEqual(["d"]);
  });

  it("命中决策前就把不被允许的 mock 当作不存在：后创建的、仍被允许的 json mock 照常生效（而不是被前面失效的 html mock「占位」后整体放行）", async () => {
    const e = await mk();
    await createApproved(e, html); // r1：html mock（先创建 → 终结类里它优先）
    approvalState(e).approved = false;
    await e.rules({ action: "mock", pattern: "https://target.example/*", contentType: "application/json", body: '{"fallback":true}' }); // r2：不需要审批
    e.pause({ url: TARGET, requestId: "x" });
    await e.settle();
    const f = e.cmds("Fetch.fulfillRequest");
    expect(f).toHaveLength(1);
    expect(Buffer.from(f[0].params.body, "base64").toString()).toBe('{"fallback":true}');
    expect(JSON.stringify(f[0].params.responseHeaders)).toContain("application/json");
  });

  it("延迟等待期间批准被撤销：fulfill 前再判一次——不 fulfill、放行原请求（对照：没撤销的请求照常 fulfill）", async () => {
    const e = await mk();
    await createApproved(e, html);
    await e.rules({ action: "delay", pattern: "https://target.example/*", delayMs: 120 });
    // 对照：不撤销 → 延迟后 fulfill
    e.pause({ url: TARGET, requestId: "ok" });
    await e.settle();
    expect(fulfilledIds(e)).toEqual([]); // 还在等
    await sleep(220);
    expect(fulfilledIds(e)).toEqual(["ok"]);
    // 撤销（绕过联动清理，规则仍在表里 → 只有 fulfill 前的重判能拦住）
    e.pause({ url: TARGET, requestId: "slow" });
    await e.settle();
    approvalState(e).approved = false;
    await sleep(220);
    expect(fulfilledIds(e)).toEqual(["ok"]);
    expect(continuedIds(e)).toContain("slow");
    expect(sysLog(e).filter((s) => s.includes("批准已失效"))).toHaveLength(1);
  });

  it("延迟等待期间走完整的撤销（联动清理摘掉规则）：同样不 fulfill", async () => {
    const e = await mk();
    await createApproved(e, html);
    await e.rules({ action: "delay", pattern: "https://target.example/*", delayMs: 120 });
    e.pause({ url: TARGET, requestId: "slow" });
    await e.settle();
    revokeEvaluateApproval(e.session);
    await sleep(240);
    expect(fulfilledIds(e)).toEqual([]);
    expect(continuedIds(e)).toContain("slow");
  });

  it("批准与落地之间隔着动作队列：排队期间批准被撤销 → DENIED，规则没落地、Fetch 没开", async () => {
    const e = await mk();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const holder = e.session.runAction({ op: "x" }, () => hold); // 占住动作队列
    const done = e.rules(html).then(
      (v: unknown) => ({ ok: true as const, v }),
      (err: any) => ({ ok: false as const, code: String(err?.code ?? err) }),
    );
    for (let i = 0; i < 100 && e.session.prompts.list().length === 0; i += 1) await sleep(2);
    e.session.prompts.answer((e.session.prompts.list()[0] as any).id, { action: "task" });
    await e.settle(12); // 审批通过，规则正在队列里排队
    revokeEvaluateApproval(e.session);
    release();
    await holder;
    const r = await done;
    expect(r).toMatchObject({ ok: false, code: "DENIED" });
    expect((r as any).code).toBe("DENIED");
    expect((await e.rules({ action: "list" })).count).toBe(0);
    expect(e.cmds("Fetch.enable")).toHaveLength(0);
  });

  it("「永久开启」批准：总闸要等 server 写设置才变 true——规则能创建（落地时不重判），但总闸真的变 true 之前命中不生效（并写日志），变 true 后才生效", async () => {
    const e = await mk();
    const gate = setGate(e, false);
    const r = await createApproved(e, html, "always");
    expect(r.rule).toMatchObject({ action: "mock" });
    expect((await e.rules({ action: "list" })).count).toBe(1);
    e.pause({ url: TARGET, requestId: "early" });
    await e.settle();
    expect(fulfilledIds(e)).toEqual([]);
    expect(sysLog(e).join("|")).toContain("批准已失效");
    gate.on = true; // server 把设置写好了，主进程收到 config
    e.pause({ url: TARGET, requestId: "late" });
    await e.settle();
    expect(fulfilledIds(e)).toEqual(["late"]);
  });
});

// ───────────────────────── 引擎层：ruleAllowed / onRuleRefused 的契约（纯逻辑，不依赖 session） ─────────────────────────

const ev = (requestId: string, url: string) => ({ requestId, networkId: `n-${requestId}`, request: { url, method: "GET", headers: { Accept: "*/*" } } });
const rulesOf = (...defs: any[]) => {
  const s = createRuleStore();
  for (const d of defs) s.add(buildRuleDef(d));
  return s;
};
const mkCtl = (store: any, deps: Record<string, unknown>) => {
  const sent: Array<{ method: string; params: any }> = [];
  const c = createPauseController({
    send: vi.fn(async (method: string, params: any) => {
      sent.push({ method, params });
      return {};
    }),
    getRules: () => store.rules(),
    isPaused: () => false,
    log: () => {},
    ...deps,
  });
  return { c, sent, methods: () => sent.map((s) => s.method) };
};
const MOCK = { action: "mock", pattern: "https://a.test/*", contentType: "text/html", body: "<b>x</b>" };

describe("createPauseController：ruleAllowed / onRuleRefused", () => {
  it("没传 ruleAllowed：行为与旧版完全一致（mock 照常 fulfill）", async () => {
    const { c, methods } = mkCtl(rulesOf(MOCK), {});
    await c.onPaused(ev("1", "https://a.test/x"));
    expect(methods()).toEqual(["Fetch.fulfillRequest"]);
  });

  it("ruleAllowed=false 的 mock 当作不存在：原请求放行、不 fulfill；命中它的请求触发 onRuleRefused（调用方据此写日志）", async () => {
    const store = rulesOf(MOCK);
    const refused: string[] = [];
    const { c, methods } = mkCtl(store, { ruleAllowed: () => false, onRuleRefused: (r: any) => refused.push(r.id) });
    await c.onPaused(ev("1", "https://a.test/x"));
    await c.onPaused(ev("2", "https://other.test/x")); // 不匹配的规则不算「被拒」
    expect(methods()).toEqual(["Fetch.continueRequest", "Fetch.continueRequest"]);
    expect(refused).toEqual(["r1"]);
  });

  it("被拒的 mock 不挡别的规则：set_headers 仍生效（请求头照加），后创建的允许的 mock 照常 fulfill", async () => {
    const store = rulesOf(MOCK, { action: "set_headers", pattern: "https://a.test/*", headers: { "X-Dbg": "1" } });
    const { c, sent } = mkCtl(store, { ruleAllowed: (r: any) => r.action !== "mock" });
    await c.onPaused(ev("1", "https://a.test/x"));
    expect(sent.map((s) => s.method)).toEqual(["Fetch.continueRequest"]);
    expect(JSON.stringify(sent[0].params.headers)).toContain("X-Dbg");

    const store2 = rulesOf(MOCK, { action: "mock", pattern: "https://a.test/*", contentType: "application/json", body: "{}" });
    const second = mkCtl(store2, { ruleAllowed: (r: any) => r.mock.contentType === "application/json" });
    await second.c.onPaused(ev("2", "https://a.test/x"));
    expect(second.methods()).toEqual(["Fetch.fulfillRequest"]);
    expect(JSON.stringify(second.sent[0].params.responseHeaders)).toContain("application/json");
  });

  it("ruleAllowed 抛错 → 一律按「不允许」处理（宁可规则不生效），请求不挂起、不 throw", async () => {
    const { c, methods } = mkCtl(rulesOf(MOCK), {
      ruleAllowed: () => {
        throw new Error("boom");
      },
    });
    await expect(c.onPaused(ev("1", "https://a.test/x"))).resolves.toBeUndefined();
    expect(methods()).toEqual(["Fetch.continueRequest"]);
  });

  it("延迟期间 ruleAllowed 变 false：fulfill 前重判 → 不 fulfill（命中决策时它还是被允许的，只有第二道能拦）", async () => {
    let ok = true;
    const refused: string[] = [];
    const store = rulesOf({ action: "delay", pattern: "https://a.test/*", delayMs: 40 }, MOCK);
    const { c, methods } = mkCtl(store, { ruleAllowed: () => ok, onRuleRefused: (r: any) => refused.push(r.id) });
    const p = c.onPaused(ev("1", "https://a.test/x"));
    ok = false;
    await p;
    expect(methods()).toEqual(["Fetch.continueRequest"]);
    expect(refused).toEqual(["r2"]);
  });

  it("延迟期间规则被摘掉（联动清理）：fulfill 前找不到决定性的规则 → 不 fulfill", async () => {
    const store = rulesOf({ action: "delay", pattern: "https://a.test/*", delayMs: 40 }, MOCK);
    const { c, methods } = mkCtl(store, { ruleAllowed: () => true });
    const p = c.onPaused(ev("1", "https://a.test/x"));
    store.remove("r2");
    await p;
    expect(methods()).toEqual(["Fetch.continueRequest"]);
  });
});
