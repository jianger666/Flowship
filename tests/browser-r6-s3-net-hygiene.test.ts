/**
 * R6-10 / R6-11 / R6-22 / R6-23（S3）：
 *  - R6-10 清除数据 / 会话结束 / 无痕 wipe 后断开已建立的连接（closeAllConnections）+ 证书例外按 partition 清；
 *  - R6-11 任务结束清认证缓存（clearAuthCache）；
 *  - R6-22 证书例外 / 权限授予按 partition 隔离、无痕 export_state 被拒；
 *  - R6-23 `*.local` 不再自动放行。
 * 假 session / 假 tab（FakeTab 来自 p1 测试夹具）；真 BrowserSession。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 假 session 的松散形状，只在本测试里用 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthCacheSafe, closeConnectionsSafe, releaseSessionNetwork } from "../electron-app/browser/conn-hygiene.mjs";
import { createIncognitoManager, wipeIncognitoSession } from "../electron-app/browser/incognito.mjs";
import {
  certScopeKey,
  createNetGuard,
  decideCertError,
  getNetGuardState,
  isLoopbackTrustHost,
  peekNetGuardState,
} from "../electron-app/browser/net-guard.mjs";
import { createPermissionGate, getPermissionState } from "../electron-app/browser/permission-gate.mjs";
import { createHandlers as createPermissionHandlers } from "../electron-app/browser/ops/permissions.mjs";
import { createHandlers as createStorageHandlers } from "../electron-app/browser/ops/storage.mjs";
import { firstPrompt, flush, makeEnv, type FakeTab } from "./helpers/browser-e2-p1-fakes";

const PERSIST = "persist:flowship-browser";
const INCOG = "flowship-incognito-task-p1-t2-1";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── R6-10 / R6-11：conn-hygiene ─────────────────────────

describe("conn-hygiene：防御式断连 / 清认证缓存", () => {
  it("方法存在：调用并 await 其 Promise；返回 true", async () => {
    let done = false;
    const ses = {
      closeAllConnections: vi.fn(async () => {
        await Promise.resolve();
        done = true;
      }),
      clearAuthCache: vi.fn(async () => {}),
    };
    await expect(closeConnectionsSafe(ses)).resolves.toBe(true);
    expect(done).toBe(true);
    await expect(clearAuthCacheSafe(ses)).resolves.toBe(true);
    expect(ses.clearAuthCache).toHaveBeenCalledTimes(1);
  });

  it("fake session 没有该方法 / 不是函数 / 是 null：跳过不抛", async () => {
    await expect(closeConnectionsSafe({})).resolves.toBe(false);
    await expect(closeConnectionsSafe({ closeAllConnections: "x" })).resolves.toBe(false);
    await expect(closeConnectionsSafe(null)).resolves.toBe(false);
    await expect(clearAuthCacheSafe(undefined)).resolves.toBe(false);
  });

  it("同步抛错 / reject：吞掉并记日志，不向上冒泡", async () => {
    const log = vi.fn();
    await expect(closeConnectionsSafe({ closeAllConnections: () => { throw new Error("boom-sync"); } }, log)).resolves.toBe(false);
    await expect(closeConnectionsSafe({ closeAllConnections: async () => { throw new Error("boom-async"); } }, log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0][0])).toContain("boom-sync");
    // 日志函数自己抛错也不冒泡
    await expect(closeConnectionsSafe({ closeAllConnections: async () => { throw new Error("x"); } }, () => { throw new Error("log-boom"); })).resolves.toBe(false);
  });
});

describe("releaseSessionNetwork：任务结束的持久 partition 清理（R6-11 / R6-10）", () => {
  it("R6-11：无论有没有证书例外，认证缓存都被清（dispose 后 clearAuthCache 被调用）", async () => {
    const ses = { clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) };
    const r = await releaseSessionNetwork({ netState: { hasCertExceptions: () => false }, ses, partition: PERSIST });
    expect(ses.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ authCleared: true, connectionsClosed: false });
    // 没有例外 → 不断连接（会打断并发任务里进行中的加载 / 下载）
    expect(ses.closeAllConnections).not.toHaveBeenCalled();
  });

  it("R6-10：有证书例外 → 同时断开已建立的连接", async () => {
    const ses = { clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) };
    const r = await releaseSessionNetwork({ netState: { hasCertExceptions: (p: string) => p === PERSIST }, ses, partition: PERSIST });
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(r.connectionsClosed).toBe(true);
  });

  it("判断例外出错按「有」处理（宁可多断一次）；session 方法抛错不 reject", async () => {
    const ses = { clearAuthCache: vi.fn(async () => { throw new Error("no"); }), closeAllConnections: vi.fn(async () => { throw new Error("no"); }) };
    const r = await releaseSessionNetwork({
      netState: { hasCertExceptions: () => { throw new Error("bad"); } },
      ses,
      partition: PERSIST,
      log: () => {},
    });
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ authCleared: false, connectionsClosed: false });
  });
});

describe("无痕 wipe（R6-10）", () => {
  it("wipeIncognitoSession：存储 / 缓存 / 认证缓存清完后调 closeAllConnections；缺方法跳过；它失败不让 wipe 失败", async () => {
    const order: string[] = [];
    const ses = {
      clearStorageData: vi.fn(async () => void order.push("storage")),
      clearCache: vi.fn(async () => void order.push("cache")),
      clearAuthCache: vi.fn(async () => void order.push("auth")),
      closeAllConnections: vi.fn(async () => void order.push("conn")),
    };
    await wipeIncognitoSession(ses);
    expect(order).toEqual(["storage", "cache", "auth", "conn"]);

    // fake session 没有 closeAllConnections
    await expect(wipeIncognitoSession({ clearStorageData: async () => {} })).resolves.toBeUndefined();
    // closeAllConnections 失败：只记日志，wipe 本身成功（抛了 partition 就退役）
    const log = vi.fn();
    await expect(wipeIncognitoSession({ clearStorageData: async () => {}, closeAllConnections: async () => { throw new Error("conn-fail"); } }, log)).resolves.toBeUndefined();
    expect(String(log.mock.calls[0][0])).toContain("conn-fail");
  });

  it("经 createIncognitoManager 的 release：最后一个 tab 关闭 → wipe 里断了连接，partition 回到复用池", async () => {
    const ses = { clearStorageData: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) };
    const mgr = createIncognitoManager({ wipe: (name: string) => wipeIncognitoSession({ ...ses, name } as any), nextSeq: () => 7 });
    const name = mgr.allocate({ taskId: "t", tabId: "t2" });
    mgr.retain(name);
    await mgr.release(name);
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(mgr.stats().free).toBe(1);
  });
});

// ───────────────────────── R6-23：*.local ─────────────────────────

describe("R6-23：`*.local` 不再自动放行", () => {
  it.each(["dev.local", "printer.local", "DEV.LOCAL", "a.b.local", "dev.local."])("isLoopbackTrustHost(%s) = false", (h) => {
    expect(isLoopbackTrustHost(h)).toBe(false);
  });

  it("真正的回环仍放行：localhost / *.localhost / 127.0.0.0/8 / ::1", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.9.9.9", "[::1]"]) expect(isLoopbackTrustHost(h)).toBe(true);
  });

  it("决策：开关开着 + 主框架 `*.local` → ask（不是 allow）；子资源 → deny；回环 → allow", () => {
    const base = { config: { trustLoopbackCerts: true }, isAppUrl: () => false };
    expect(decideCertError({ ...base, url: "https://nas.local:8443/", isMainFrame: true })).toMatchObject({ action: "ask" });
    expect(decideCertError({ ...base, url: "https://nas.local:8443/x.js", isMainFrame: false })).toMatchObject({ action: "deny" });
    expect(decideCertError({ ...base, url: "https://localhost:8443/", isMainFrame: true })).toMatchObject({ action: "allow", reason: "loopback" });
  });
});

// ───────────────────────── R6-22：partition 隔离 ─────────────────────────

const setupNet = async () => {
  const env = makeEnv();
  const guard = createNetGuard({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
  const normal = await env.openTab("about:blank");
  (normal as any).partition = PERSIST;
  (normal as any).incognito = false;
  const incog = await env.openTab("about:blank");
  (incog as any).partition = INCOG;
  (incog as any).incognito = true;
  guard.bindTab(normal);
  guard.bindTab(incog);
  const CERT = { fingerprint: "sha256/AAAAAAAAAAAA", subjectName: "CN=x", issuerName: "CN=x" };
  const certError = (tab: FakeTab, url: string, isMainFrame = true) => {
    const cb = vi.fn();
    tab.wc.emit("certificate-error", { preventDefault: vi.fn() }, url, "net::ERR_CERT_AUTHORITY_INVALID", CERT, cb, isMainFrame);
    return cb;
  };
  const allowHost = async (tab: FakeTab, url: string) => {
    const cb = certError(tab, url);
    await flush();
    const p = (env.session.prompts.list() as Array<{ id: string; kind: string; tabId?: string }>).find((x) => x.kind === "cert" && x.tabId === tab.id)!;
    env.session.prompts.answer(p.id, { action: "allow-host" });
    await flush();
    return cb;
  };
  return { ...env, guard, normal, incog, certError, allowHost, CERT };
};

describe("R6-22：证书例外按 partition 隔离", () => {
  it("certScopeKey：带 partition 前缀；缺省退回裸 host（旧 key 兼容）", () => {
    expect(certScopeKey(PERSIST, "a.com:443")).toBe(`${PERSIST}|a.com:443`);
    expect(certScopeKey(undefined, "a.com")).toBe("a.com");
    expect(certScopeKey("", "a.com")).toBe("a.com");
  });

  it("纯决策：A partition 的例外对 B partition 不生效（恶意：同 host 同指纹）", () => {
    const allowedCerts = new Map([[certScopeKey(PERSIST, "self.example"), new Set(["sha256/AAAAAAAAAAAA"])]]);
    const base = { url: "https://self.example/", isMainFrame: true, config: { trustLoopbackCerts: false }, isAppUrl: () => false, allowedCerts, fingerprint: "sha256/AAAAAAAAAAAA" };
    expect(decideCertError({ ...base, partition: PERSIST })).toMatchObject({ action: "allow", reason: "user-allowed" });
    expect(decideCertError({ ...base, partition: INCOG })).toMatchObject({ action: "ask" });
  });

  it("接线：普通标签 allow-host 后，同 host 同证书的无痕标签仍要问；反之亦然", async () => {
    const s = await setupNet();
    const cb1 = await s.allowHost(s.normal as FakeTab, "https://self.example/");
    expect(cb1).toHaveBeenCalledWith(true);
    // 普通标签再访问：免提示
    expect(s.certError(s.normal as FakeTab, "https://self.example/")).toHaveBeenCalledWith(true);
    // 无痕标签：不受影响，要问
    const cbI = s.certError(s.incog as FakeTab, "https://self.example/");
    await flush();
    expect(cbI).not.toHaveBeenCalled();
    expect((s.session.prompts.list() as Array<{ kind: string; tabId?: string }>).some((p) => p.kind === "cert" && p.tabId === (s.incog as any).id)).toBe(true);
  });

  it("接线：无痕标签的 allow-host 不影响普通标签", async () => {
    const s = await setupNet();
    await s.allowHost(s.incog as FakeTab, "https://self.example/");
    const cb = s.certError(s.normal as FakeTab, "https://self.example/");
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it("clearBrowsingData(persistent)：只清持久 partition 的例外，无痕的保留；无参 = 全清（旧行为）", async () => {
    const s = await setupNet();
    await s.allowHost(s.normal as FakeTab, "https://a.example/");
    await s.allowHost(s.incog as FakeTab, "https://b.example/");
    const st = getNetGuardState(s.session);
    expect(st.hasCertExceptions(PERSIST)).toBe(true);
    expect(st.hasCertExceptions(INCOG)).toBe(true);
    st.onBrowsingDataCleared(PERSIST);
    expect(st.hasCertExceptions(PERSIST)).toBe(false);
    expect(st.hasCertExceptions(INCOG)).toBe(true);
    expect(st.overrideHosts.size).toBe(1);
    // 清完后同 host 再导航：重新询问（R6-10：例外表被清）
    const cb = s.certError(s.normal as FakeTab, "https://a.example/");
    await flush();
    expect(cb).not.toHaveBeenCalled();
    st.onBrowsingDataCleared();
    expect(st.allowedCerts.size).toBe(0);
    expect(st.overrideHosts.size).toBe(0);
  });

  it("无痕 wipe 广播（onPartitionWiped）：只丢该 partition 的例外；peekNetGuardState 不建状态", async () => {
    const s = await setupNet();
    await s.allowHost(s.normal as FakeTab, "https://a.example/");
    await s.allowHost(s.incog as FakeTab, "https://b.example/");
    const st = getNetGuardState(s.session);
    st.onPartitionWiped(INCOG);
    expect(st.hasCertExceptions(INCOG)).toBe(false);
    expect(st.hasCertExceptions(PERSIST)).toBe(true);
    expect(st.certExceptionPartitions()).toEqual([PERSIST]);
    expect(peekNetGuardState({ ext: new Map() })).toBeNull();
  });
});

describe("R6-22：权限授予按 partition 隔离", () => {
  const setupPerm = async () => {
    const env = makeEnv({ pagePermissions: true });
    const gate = createPermissionGate({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: () => {} });
    const normal = await env.openTab("https://site.example/page");
    (normal as any).incognito = false;
    const incog = await env.openTab("https://site.example/page");
    (incog as any).incognito = true;
    gate.bindTab(normal);
    gate.bindTab(incog);
    const request = (tab: FakeTab, permission = "geolocation") => {
      const cb = vi.fn();
      gate.handleRequest(tab.wc, permission, cb, { requestingUrl: "https://site.example/page", isMainFrame: true });
      return cb;
    };
    return { ...env, gate, normal, incog, request };
  };

  it("普通标签选「本会话一直允许」→ 同源无痕标签仍要问（反之亦然）", async () => {
    const s = await setupPerm();
    const cb1 = s.request(s.normal as FakeTab);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow-session" });
    await flush();
    expect(cb1).toHaveBeenCalledWith(true);
    // 普通：免提示
    const cb2 = s.request(s.normal as FakeTab);
    await flush();
    expect(cb2).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    // 无痕：要问
    const cb3 = s.request(s.incog as FakeTab);
    await flush();
    expect(cb3).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
    expect(getPermissionState(s.session).grants.size).toBe(1);
    expect(getPermissionState(s.session).incognitoGrants.size).toBe(0);
  });

  it("无痕的授予不影响普通；clearBrowsingData(persistent) 不清无痕授予，wipe 才清", async () => {
    const s = await setupPerm();
    const cb1 = s.request(s.incog as FakeTab);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow-session" });
    await flush();
    expect(cb1).toHaveBeenCalledWith(true);
    const st = getPermissionState(s.session);
    expect(st.incognitoGrants.size).toBe(1);
    expect(st.grants.size).toBe(0);
    const cbN = s.request(s.normal as FakeTab);
    await flush();
    expect(cbN).not.toHaveBeenCalled();
    s.session.prompts.cancelWhere(() => true);

    st.onBrowsingDataCleared(PERSIST);
    expect(st.incognitoGrants.size).toBe(1);
    st.onPartitionWiped("persist:flowship-browser");
    expect(st.incognitoGrants.size).toBe(1); // 持久名的 wipe 广播不动无痕表
    st.onPartitionWiped(INCOG);
    expect(st.incognitoGrants.size).toBe(0);
  });

  it("AI `permissions grant` 只写目标 tab 所在 partition；list 只看目标 tab 那份；reset 两份都清", async () => {
    const s = await setupPerm();
    const handlers = createPermissionHandlers({
      requireSession: () => s.session,
      getConfig: () => s.config,
      electron: { isAppUrl: s.isAppUrl },
      permissionGate: s.gate,
      log: () => {},
    } as any);
    const normalId = (s.normal as any).id;
    const incogId = (s.incog as any).id;
    await handlers.permissions("task-p1", { action: "grant", permission: "geolocation", tabId: incogId } as any);
    const st = getPermissionState(s.session);
    expect(st.incognitoGrants.size).toBe(1);
    expect(st.grants.size).toBe(0);
    const listN: any = await handlers.permissions("task-p1", { action: "list", tabId: normalId } as any);
    const listI: any = await handlers.permissions("task-p1", { action: "list", tabId: incogId } as any);
    expect(listN.grants).toHaveLength(0);
    expect(listI.grants).toHaveLength(1);
    await handlers.permissions("task-p1", { action: "grant", permission: "geolocation", tabId: normalId } as any);
    expect(st.grants.size).toBe(1);
    const r: any = await handlers.permissions("task-p1", { action: "reset", tabId: normalId } as any);
    expect(r.cleared).toBe(2);
    expect(st.grants.size + st.incognitoGrants.size).toBe(0);
  });
});

describe("R6-23：设置页文案（源码契约）", () => {
  const card = readFileSync(path.resolve(import.meta.dirname, "../src/components/settings/browser-card.tsx"), "utf8");

  it("自动放行证书：写清只对真正的回环生效，`*.local` 明确「不在此列、仍会询问」，不再把 *.local 说成本机开发站点", () => {
    const hint = /label="自动放行本机的自签名证书"\s*hint="([^"]+)"/.exec(card)?.[1] ?? "";
    expect(hint).toContain("127.0.0.0/8");
    expect(hint).toContain("::1");
    expect(hint).toContain("*.localhost");
    expect(hint).toMatch(/\*\.local（[^）]*）[^；]*不在此列[^；]*询问/);
    // 旧文案把 *.local 与 localhost / 127.0.0.1 并列为「本机开发站点」
    expect(card).not.toContain("localhost / 127.0.0.1 / *.local");
  });

  it("读写登录态：写明导出文件含明文凭据、任务目录 0600、14 天后自动清理、无痕不能导出", () => {
    const hint = /label="允许 AI 读写登录态"\s*hint="([^"]+)"/.exec(card)?.[1] ?? "";
    expect(hint).toContain("明文凭据");
    expect(hint).toContain("0600");
    expect(hint).toContain("14 天后自动清理");
    expect(hint).toContain("无痕标签的数据不允许导出");
    expect(card).not.toContain("导出文件只放在任务目录里");
  });
});

// ───────────────────────── R6-22：无痕 export_state 被拒 ─────────────────────────

describe("R6-22：无痕标签 export_state 被拒（DENIED，且在读 cookie 之前）", () => {
  const mk = (incognito: boolean) => {
    const sentMethods: string[] = [];
    const tab: any = {
      id: "t1",
      url: "https://site.example/app",
      incognito,
      destroyed: false,
      send: vi.fn(async (m: string) => {
        sentMethods.push(m);
        return {};
      }),
      wc: { session: { cookies: { get: vi.fn(async () => []) } } },
      ext: new Map(),
      getExt: (k: string, f: () => unknown) => {
        if (!tab.ext.has(k)) tab.ext.set(k, f());
        return tab.ext.get(k);
      },
    };
    const session: any = {
      taskId: "task-x",
      tabs: [tab],
      controller: "idle",
      getTab: () => tab,
      runAction: async (_o: unknown, fn: (ctx: any) => unknown) => fn({ tab, signal: undefined, describe: () => {}, check: () => {} }),
      activityLog: { addAI: vi.fn(), addSystem: vi.fn() },
    };
    const handlers = createStorageHandlers({
      requireSession: () => session,
      abortable: <T>(p: Promise<T>) => p,
      getConfig: () => ({ storageAccess: true }),
      userDataDir: () => "/tmp/r6-s3-nonexistent",
      scheduleState: () => {},
      log: () => {},
    } as any);
    return { handlers, tab, sentMethods };
  };

  it("无痕 tab：export_state → DENIED，文案含「无痕标签的数据不允许导出到磁盘」，没有任何 CDP / cookie 读取", async () => {
    const { handlers, tab, sentMethods } = mk(true);
    const err: any = await handlers.storage("task-x", { action: "export_state" } as any).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(err.code).toBe("DENIED");
    expect(String(err.message)).toContain("无痕标签的数据不允许导出到磁盘");
    expect(String(err.message)).toContain("storage get/list");
    expect(sentMethods).toEqual([]);
    expect(tab.wc.session.cookies.get).not.toHaveBeenCalled();
  });

  it("普通 tab 不受影响：不会因为无痕检查被拒（会走到后面的真实逻辑，错误不是 DENIED 的无痕文案）", async () => {
    const { handlers } = mk(false);
    const err: any = await handlers.storage("task-x", { action: "export_state" } as any).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err?.message ?? "")).not.toContain("无痕标签的数据不允许导出到磁盘");
  });
});
