/**
 * R6-19（二轮打回）：提示名额满（overflow）不进拒绝冷却，却每次写一条系统日志 → 页面循环请求把 500 条的活动日志环形缓冲刷满，
 * 真实的用户 / 系统条目被挤掉、AI 的 handback 也就读不到了。
 *
 * 修法：overflow 的**日志**单独限速（每会话、每类提示每 60 秒一条，其余只计数，下一条带「另有 N 次」）；
 * 决策不变——overflow 仍然立刻按默认动作拒绝 / 取消，且**不进冷却**（名额空出后同一主机仍要能被询问）。
 *
 * 覆盖 overflow 的全部消费点：permission-gate（权限）、net-guard（cert / auth；clientcert 没有 overflow 日志）、
 * evaluate-approval（只抛 DENIED，不写活动日志）、PromptHub 自己的进程日志。
 * 真 BrowserSession（真 PromptHub / 真活动日志）+ 假 tab / 假 wc（tests/helpers/browser-e2-p1-fakes.ts）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 假 session / 假 wc 的松散形状 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { ensureEvaluateApproval } from "../electron-app/browser/evaluate-approval.mjs";
import { createNetGuard } from "../electron-app/browser/net-guard.mjs";
import { createPermissionGate } from "../electron-app/browser/permission-gate.mjs";
import {
  OVERFLOW_LOG_WINDOW_MS,
  PROMPT_KIND_LIMITS,
  createOverflowLogThrottle,
  createPromptHub,
  overflowSuppressedNote,
} from "../electron-app/browser/prompts.mjs";
import { flush, makeEnv, type FakeTab } from "./helpers/browser-e2-p1-fakes";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const FLOOD = 600; // > 活动日志环形缓冲（500）：旧行为下每次请求一条日志，真实条目一定被挤掉
type Entry = { actor: string; kind: string; summary: string };
const entriesOf = (env: { session: any }): Entry[] => env.session.activityLog.list();
const overflowEntries = (env: { session: any }, kind: string) => entriesOf(env).filter((e) => e.actor === "system" && e.kind === kind && e.summary.includes("提示太多"));
/** 一条「真实的用户条目」：必须在洪水之后仍留在日志里 */
const addRealUserEntry = (env: { session: any }) => {
  const e = env.session.activityLog.ingest({ type: "key", key: "Enter", tabId: "t-real", url: "https://real.example/" });
  expect(e).not.toBeNull();
};
const userEntries = (env: { session: any }) => env.session.activityLog.list({ actors: ["user"] }) as Entry[];

// ───────────────────────── 纯限速器 ─────────────────────────

describe("createOverflowLogThrottle（纯）", () => {
  const make = (windowMs = 1000) => {
    let t = 10_000;
    const th = createOverflowLogThrottle({ now: () => t, windowMs });
    return { th, advance: (ms: number) => void (t += ms), setNow: (v: number) => void (t = v) };
  };

  it("窗口内只放行第一条，其余只计数；窗口过后下一条放行并带出被吞掉的次数", () => {
    const { th, advance } = make(1000);
    expect(th.take("permission")).toEqual({ log: true, suppressed: 0 });
    for (let i = 0; i < 299; i++) expect(th.take("permission")).toEqual({ log: false, suppressed: 0 });
    advance(999);
    expect(th.take("permission").log).toBe(false); // 第 300 次吞掉的之一
    advance(1);
    expect(th.take("permission")).toEqual({ log: true, suppressed: 300 });
    // 新窗口重新计数
    expect(th.take("permission")).toEqual({ log: false, suppressed: 0 });
    advance(1000);
    expect(th.take("permission")).toEqual({ log: true, suppressed: 1 });
  });

  it("不同 key（permission / cert / auth）互相独立：一类被刷，不会吞掉另一类的第一条日志", () => {
    const { th } = make();
    expect(th.take("permission").log).toBe(true);
    expect(th.take("permission").log).toBe(false);
    expect(th.take("cert").log).toBe(true);
    expect(th.take("auth").log).toBe(true);
  });

  it("时钟倒退按「窗口已过」处理（系统改时间后日志不会被永久吞掉）", () => {
    const { th, setNow } = make(1000);
    expect(th.take("k").log).toBe(true);
    setNow(1); // 倒退
    expect(th.take("k")).toEqual({ log: true, suppressed: 0 });
  });

  it("key 表有上限（防御）：超过后整表清空重来，不会无限增长；reset 清空", () => {
    const { th } = make();
    for (let i = 0; i < 200; i++) th.take(`k${i}`);
    // 清空发生过：最早的 key 再来是「新的」→ 放行
    expect(th.take("k0").log).toBe(true);
    th.reset();
    expect(th.take("k0")).toEqual({ log: true, suppressed: 0 });
  });

  it("overflowSuppressedNote：0 / 非法值 → 空串；正数 → 带次数", () => {
    expect(overflowSuppressedNote(0)).toBe("");
    expect(overflowSuppressedNote(-3)).toBe("");
    expect(overflowSuppressedNote(Number.NaN)).toBe("");
    expect(overflowSuppressedNote(undefined as never)).toBe("");
    expect(overflowSuppressedNote(299)).toContain("299");
  });
});

// ───────────────────────── PromptHub 自己的进程日志 ─────────────────────────

describe("PromptHub：overflow 的进程日志限速，决策不变", () => {
  it(`permission 桶满后 ${FLOOD} 次请求：每次仍立即按默认拒绝（overflow:true、无 timedOut），进程日志只有 1 行；窗口过后再来一次带「另有 N 次」`, async () => {
    const log = vi.fn();
    const hub = createPromptHub({ log });
    for (let i = 0; i < PROMPT_KIND_LIMITS.permission; i++) void hub.request({ kind: "permission", host: `fill${i}.example` });
    expect(hub.size()).toBe(PROMPT_KIND_LIMITS.permission);

    for (let i = 0; i < FLOOD; i++) {
      await expect(hub.request({ kind: "permission", host: `flood${i}.example` })).resolves.toEqual({ action: "deny", overflow: true });
    }
    expect(hub.size()).toBe(PROMPT_KIND_LIMITS.permission); // 没有一个挤进挂起表
    const full = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("已达上限"));
    expect(full).toHaveLength(1);

    vi.setSystemTime(Date.now() + OVERFLOW_LOG_WINDOW_MS + 1);
    await hub.request({ kind: "permission", host: "again.example" });
    const after = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("已达上限"));
    expect(after).toHaveLength(2);
    expect(after[1]).toContain(String(FLOOD - 1)); // 上一条之后被吞掉的 FLOOD-1 次
  });
});

// ───────────────────────── permission-gate ─────────────────────────

describe("permission-gate：overflow 日志限速，不挤掉用户条目，不进冷却", () => {
  const A = "https://a.example.com";
  const setup = async () => {
    const env = makeEnv({ pagePermissions: true });
    const gate = createPermissionGate({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
    const tab = await env.openTab(`${A}/page`);
    gate.bindTab(tab);
    const request = (permission: string, origin: string) => {
      const cb = vi.fn();
      gate.handleRequest(tab.wc, permission, cb, { requestingUrl: `${origin}/`, isMainFrame: true });
      return cb;
    };
    const fillBucket = async (prefix = "fill") => {
      for (let i = 0; i < PROMPT_KIND_LIMITS.permission; i++) request("geolocation", `https://${prefix}${i}.example`);
      await flush();
      expect(env.session.prompts.size()).toBe(PROMPT_KIND_LIMITS.permission);
    };
    return { ...env, gate, tab, request, fillBucket };
  };

  it(`占满 permission 桶后循环请求 ${FLOOD} 次（两种权限交替）：每次都被拒、日志只有个位数、真实用户条目没被挤掉`, async () => {
    const s = await setup();
    addRealUserEntry(s);
    await s.fillBucket();

    const cbs: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < FLOOD; i++) cbs.push(s.request(i % 2 === 0 ? "geolocation" : "notifications", `https://flood${i}.example`));
    await flush(30);

    // 决策不变：每个回调恰好一次、都是拒绝
    for (const cb of cbs) {
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(false);
    }
    const flooded = overflowEntries(s, "permission");
    expect(flooded.length).toBeGreaterThanOrEqual(1);
    expect(flooded.length).toBeLessThanOrEqual(3); // 个位数（实际 1 条）
    expect(entriesOf(s).length).toBeLessThan(10); // 整个日志没被刷
    expect(userEntries(s)).toHaveLength(1); // 真实用户条目还在（旧行为：FLOOD 条日志把它挤出 500 条环形缓冲）
    // 文案：是「提示太多」，不是「无人处理」
    expect(flooded[0].summary).not.toContain("无人处理");
    expect(flooded[0].summary).toContain("默认拒绝");
  });

  it("overflow 不进冷却：名额空出后，同一 origin + 权限立刻能被询问（限速只管日志，不影响决策）", async () => {
    const s = await setup();
    await s.fillBucket();
    const cb = s.request("geolocation", "https://victim.example");
    await flush();
    expect(cb).toHaveBeenCalledWith(false); // 名额满：立即拒绝
    expect((s.session.prompts.list() as Array<{ host: string }>).some((p) => p.host === "victim.example")).toBe(false);

    // 空出一个名额
    const first = (s.session.prompts.list() as Array<{ id: string }>)[0];
    expect(s.session.prompts.answer(first.id, { action: "deny" })).toBe(true);
    await flush();
    const cb2 = s.request("geolocation", "https://victim.example");
    await flush();
    expect(cb2).not.toHaveBeenCalled(); // 没被冷却挡成立即拒绝
    expect((s.session.prompts.list() as Array<{ host: string }>).some((p) => p.host === "victim.example")).toBe(true); // 而是真的弹了提示
  });

  it("窗口过后再来一次 overflow：再写 1 条，带「另有 N 次」；中间的洪水没有一条被逐条记录", async () => {
    const s = await setup();
    await s.fillBucket();
    for (let i = 0; i < 50; i++) s.request("geolocation", `https://flood${i}.example`);
    await flush(20);
    expect(overflowEntries(s, "permission")).toHaveLength(1);

    // 过一个窗口：原来挂着的 4 个提示也到了 60s 超时，所以重新占满
    await vi.advanceTimersByTimeAsync(OVERFLOW_LOG_WINDOW_MS + 1000);
    await s.fillBucket("refill");
    s.request("geolocation", "https://late.example");
    await flush();
    const entries = overflowEntries(s, "permission");
    expect(entries).toHaveLength(2);
    expect(entries[1].summary).toContain("49"); // 第一条之后被吞掉的 49 次
  });

  it("限速是按会话 + 类别的：permission 被刷时，cert 的第一条 overflow 日志不被吞", async () => {
    const s = await setup();
    const guard = createNetGuard({ findOwner: s.findOwner, getConfig: () => s.config, isAppUrl: s.isAppUrl, log: () => {} });
    guard.bindTab(s.tab);
    await s.fillBucket();
    for (let i = 0; i < 20; i++) s.request("geolocation", `https://flood${i}.example`);
    for (let i = 0; i < PROMPT_KIND_LIMITS.cert + 5; i++) {
      s.tab.wc.emit("certificate-error", { preventDefault: vi.fn() }, `https://c${i}.example/`, "net::ERR_CERT_AUTHORITY_INVALID", { fingerprint: "sha256/AAAAAAAAAAAA" }, vi.fn(), true);
    }
    await flush(30);
    expect(overflowEntries(s, "permission")).toHaveLength(1);
    expect(overflowEntries(s, "cert")).toHaveLength(1);
  });
});

// ───────────────────────── net-guard：cert / auth ─────────────────────────

describe("net-guard：cert / auth 的 overflow 日志限速，不挤掉用户条目，不进冷却", () => {
  const CERT = { fingerprint: "sha256/AAAAAAAAAAAA", subjectName: "CN=x", issuerName: "CN=x" };
  const setup = async () => {
    const env = makeEnv();
    const guard = createNetGuard({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
    const tab = (await env.openTab("https://page.example/")) as FakeTab;
    guard.bindTab(tab);
    const certError = (host: string) => {
      const cb = vi.fn();
      tab.wc.emit("certificate-error", { preventDefault: vi.fn() }, `https://${host}/`, "net::ERR_CERT_AUTHORITY_INVALID", CERT, cb, true);
      return cb;
    };
    const login = (host: string, realm = "r") => {
      const cb = vi.fn();
      tab.wc.emit("login", { preventDefault: vi.fn() }, { url: `http://${host}/` }, { isProxy: false, scheme: "basic", host, port: 80, realm }, cb);
      return cb;
    };
    const hosts = () => (env.session.prompts.list() as Array<{ host: string; id: string; kind: string }>);
    return { ...env, guard, tab, certError, login, hosts };
  };

  it(`cert 桶满后循环 ${FLOOD} 次：每次都被拒、日志个位数、用户条目还在；overflow 不进冷却（名额空出后同一主机能被询问）`, async () => {
    const s = await setup();
    addRealUserEntry(s);
    for (let i = 0; i < PROMPT_KIND_LIMITS.cert; i++) s.certError(`fill${i}.example`);
    await flush();
    expect(s.hosts().filter((p) => p.kind === "cert")).toHaveLength(PROMPT_KIND_LIMITS.cert);

    const cbs: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < FLOOD; i++) cbs.push(s.certError(`flood${i}.example`));
    await flush(30);
    for (const cb of cbs) {
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(false);
    }
    const flooded = overflowEntries(s, "cert");
    expect(flooded.length).toBeGreaterThanOrEqual(1);
    expect(flooded.length).toBeLessThanOrEqual(3);
    expect(entriesOf(s).length).toBeLessThan(10);
    expect(userEntries(s)).toHaveLength(1);
    expect(flooded[0].summary).not.toContain("无人处理");

    // 不进冷却：桶还满着时 victim 被 overflow 立即拒绝；腾出名额后，同一个 victim 立刻能弹提示
    // （用洪水之后的专用 victim：洪水本身有 600 个 key，冷却表有 100 条的容量上限会把早期 key 的冷却清掉，不能拿 flood0 来验）
    const cbV = s.certError("victim.example");
    await flush();
    expect(cbV).toHaveBeenCalledWith(false);
    const first = s.hosts().find((p) => p.kind === "cert")!;
    expect(s.session.prompts.answer(first.id, { action: "deny" })).toBe(true);
    await flush();
    const cb = s.certError("victim.example");
    await flush();
    expect(cb).not.toHaveBeenCalled();
    expect(s.hosts().some((p) => p.kind === "cert" && p.host === "victim.example")).toBe(true);
  });

  it(`auth 桶满后循环 ${FLOOD} 次：每次都被取消（callback() 无凭据）、日志个位数、用户条目还在；overflow 不进冷却`, async () => {
    const s = await setup();
    addRealUserEntry(s);
    for (let i = 0; i < PROMPT_KIND_LIMITS.auth; i++) s.login(`fill${i}.example`);
    await flush();
    expect(s.hosts().filter((p) => p.kind === "auth")).toHaveLength(PROMPT_KIND_LIMITS.auth);

    const cbs: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < FLOOD; i++) cbs.push(s.login(`flood${i}.example`));
    await flush(30);
    for (const cb of cbs) {
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(); // 取消 = 不带凭据
    }
    const flooded = overflowEntries(s, "auth");
    expect(flooded.length).toBeGreaterThanOrEqual(1);
    expect(flooded.length).toBeLessThanOrEqual(3);
    expect(entriesOf(s).length).toBeLessThan(10);
    expect(userEntries(s)).toHaveLength(1);
    expect(flooded[0].summary).not.toContain("无人处理");
    expect(flooded[0].summary).toContain("取消");

    // 不进冷却（同 cert：用洪水之后的专用 victim）
    const cbV = s.login("victim.example");
    await flush();
    expect(cbV).toHaveBeenCalledWith();
    const first = s.hosts().find((p) => p.kind === "auth")!;
    expect(s.session.prompts.answer(first.id, { action: "cancel" })).toBe(true);
    await flush();
    const cb = s.login("victim.example");
    await flush();
    expect(cb).not.toHaveBeenCalled();
    expect(s.hosts().some((p) => p.kind === "auth" && p.host.startsWith("victim.example"))).toBe(true);
  });

  it("cert 与 auth 各自限速：auth 被刷不吞 cert 的第一条", async () => {
    const s = await setup();
    for (let i = 0; i < PROMPT_KIND_LIMITS.auth; i++) s.login(`afill${i}.example`);
    for (let i = 0; i < PROMPT_KIND_LIMITS.cert; i++) s.certError(`cfill${i}.example`);
    await flush();
    for (let i = 0; i < 30; i++) s.login(`aflood${i}.example`);
    s.certError("cflood.example");
    await flush(30);
    expect(overflowEntries(s, "auth")).toHaveLength(1);
    expect(overflowEntries(s, "cert")).toHaveLength(1);
  });
});

// ───────────────────────── evaluate-approval ─────────────────────────

describe("evaluate-approval：overflow 只抛 DENIED，不写活动日志（不存在日志泛滥面）", () => {
  it(`evaluate 桶满后 ${FLOOD} 次授权请求：全部 DENIED（文案是「还有未处理」而不是「无人处理」），活动日志与进程日志都没有新增`, async () => {
    const exts = new Map<string, unknown>();
    const activityLog = createActivityLog();
    const logs: string[] = [];
    const prompts = createPromptHub({ log: (m: string) => logs.push(m) });
    const session = {
      taskId: "t-r6-19",
      prompts,
      activityLog,
      getExt: (key: string, factory: () => unknown) => {
        if (!exts.has(key)) exts.set(key, factory());
        return exts.get(key);
      },
      log: () => {},
      host: { isEvaluateEnabled: () => false, emitEvent: () => {} },
    };
    // 直接把 evaluate 桶占满（真实路径里同会话并发的 evaluate 共用一张卡，所以这是「别处还挂着授权请求」的构造）
    for (let i = 0; i < PROMPT_KIND_LIMITS.evaluate; i++) void prompts.request({ kind: "evaluate", host: `fill${i}.example` });
    const before = activityLog.list().length;
    const outcomes: string[] = [];
    for (let i = 0; i < FLOOD; i++) {
      await ensureEvaluateApproval(session as never, { summary: `x${i}` }).then(
        () => outcomes.push("ok"),
        (e: { code?: string; message?: string }) => outcomes.push(`${e.code}:${/还有未处理/.test(e.message ?? "") && !/没有在 2 分钟/.test(e.message ?? "") ? "overflow-text" : "other"}`),
      );
    }
    expect(new Set(outcomes)).toEqual(new Set(["DENIED:overflow-text"]));
    expect(activityLog.list().length).toBe(before); // evaluate 的 overflow 不写活动日志
    expect(logs.filter((m) => m.includes("已达上限"))).toHaveLength(1); // 进程日志同样被 PromptHub 限速
  });
});
