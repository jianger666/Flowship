/**
 * E2·P1 · A8 `permissions` op（electron-app/browser/ops/permissions.mjs）：参数校验、开关（主进程独立校验）、接管、DENIED 规则、活动日志。
 * 真 BrowserSession + 假 tab；gate 用真的 createPermissionGate。
 */
import { describe, expect, it, vi } from "vitest";

import { normalizeOpArgs } from "../electron-app/browser/index.mjs";
import { createHandlers } from "../electron-app/browser/ops/permissions.mjs";
import { createPermissionGate, getPermissionState } from "../electron-app/browser/permission-gate.mjs";
import { MAX_GRANT_ENTRIES } from "../electron-app/browser/permission-policy.mjs";

import { APP_ORIGIN, flush, makeEnv, type P1Config } from "./helpers/browser-e2-p1-fakes";

const A = "https://a.example.com";

const setup = async (cfg: Partial<P1Config> = {}, url = `${A}/page`) => {
  const env = makeEnv(cfg);
  const gate = createPermissionGate({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
  const tab = await env.openTab(url);
  gate.bindTab(tab);
  const scheduleState = vi.fn();
  const handlers = createHandlers({
    requireSession: () => env.session,
    getConfig: () => env.config,
    electron: { isAppUrl: env.isAppUrl },
    permissionGate: gate,
    scheduleState,
    log: (m: string) => env.logs.push(m),
  });
  /** 经 normalizeOpArgs（真实分发前的校验）再交给 handler */
  const call = (args: Record<string, unknown>) => handlers.permissions("task-p1", normalizeOpArgs("permissions", args));
  const aiEntries = () => (env.session.activityLog.list() as Array<{ actor: string; kind: string; summary: string }>).filter((e) => e.actor === "ai" && e.kind === "permission");
  const request = (permission: string, requestingUrl = `${A}/page`) => {
    const cb = vi.fn();
    gate.handleRequest(tab.wc, permission, cb, { requestingUrl, isMainFrame: true });
    return cb;
  };
  return { ...env, gate, tab, handlers, call, aiEntries, scheduleState, request };
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? "NO_CODE";
  }
};

describe("参数校验（normalizeOpArgs('permissions')）", () => {
  it("list 缺省可用；action 必填且在枚举内", () => {
    expect(normalizeOpArgs("permissions", { action: "list" })).toEqual({ action: "list" });
    expect(() => normalizeOpArgs("permissions", {})).toThrow(/action/);
    expect(() => normalizeOpArgs("permissions", { action: "bogus" })).toThrow(/action/);
  });

  it("grant / deny 必须给 permission；名字格式不合法 → BAD_ARGS；别名规整成规范名", () => {
    expect(() => normalizeOpArgs("permissions", { action: "grant" })).toThrow(/permission/);
    expect(() => normalizeOpArgs("permissions", { action: "deny" })).toThrow(/permission/);
    expect(() => normalizeOpArgs("permissions", { action: "grant", permission: "bad name!" })).toThrow(/权限名/);
    expect(normalizeOpArgs("permissions", { action: "grant", permission: "location", origin: "example.com" })).toEqual({ action: "grant", permission: "geolocation", origin: "example.com" });
    expect(normalizeOpArgs("permissions", { action: "deny", permission: "Notification", tabId: "t2" })).toEqual({ action: "deny", permission: "notifications", tabId: "t2" });
  });

  it("reset 的 permission / origin 都可省", () => {
    expect(normalizeOpArgs("permissions", { action: "reset" })).toEqual({ action: "reset" });
    expect(normalizeOpArgs("permissions", { action: "reset", permission: "geolocation" })).toEqual({ action: "reset", permission: "geolocation" });
  });
});

describe("list：总可用，只读", () => {
  it("开关关着也能 list；返回开关状态 / 当前 origin / 授予记录 / 定位模拟；不写活动日志", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "notifications", "user");
    getPermissionState(s.session).grants.deny("https://b.example.com", "geolocation", "ai");
    await s.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 } });
    const r = (await s.call({ action: "list" })) as { enabled: boolean; currentOrigin: string; grants: Array<Record<string, unknown>>; emulatedGeolocation: unknown[] };
    expect(r.enabled).toBe(false);
    expect(r.currentOrigin).toBe(A);
    expect(r.grants).toHaveLength(2);
    expect(r.grants).toEqual(
      expect.arrayContaining([
        { origin: A, permission: "notifications", decision: "allow", source: "user", active: true },
        { origin: "https://b.example.com", permission: "geolocation", decision: "deny", source: "ai", active: true },
      ]),
    );
    expect(r.emulatedGeolocation).toEqual([{ tabId: s.tab.id, origin: A }]);
    expect(s.aiEntries()).toHaveLength(0);
  });

  it("AI 写的授予在开关关着时标 active:false（不生效）", async () => {
    const s = await setup({ pagePermissions: true });
    await s.call({ action: "grant", permission: "geolocation" });
    s.config.pagePermissions = false;
    const r = (await s.call({ action: "list" })) as { grants: Array<{ active: boolean }> };
    expect(r.grants[0].active).toBe(false);
  });
});

describe("开关（主进程独立校验）", () => {
  it("pagePermissions 关：grant / deny / reset 一律 ACCESS_DISABLED，授予表不变", async () => {
    const s = await setup({ pagePermissions: false });
    for (const args of [
      { action: "grant", permission: "geolocation" },
      { action: "deny", permission: "geolocation" },
      { action: "reset" },
    ]) {
      expect(await codeOf(s.call(args)), JSON.stringify(args)).toBe("ACCESS_DISABLED");
    }
    expect(getPermissionState(s.session).grants.size).toBe(0);
    expect(s.aiEntries()).toHaveLength(0);
    expect(s.scheduleState).not.toHaveBeenCalled();
    await expect(s.call({ action: "grant", permission: "geolocation" })).rejects.toThrow(/允许 AI 授予页面权限/);
  });

  it("开关只认 === true（truthy 不算）", async () => {
    const s = await setup();
    (s.config as unknown as { pagePermissions: unknown }).pagePermissions = "yes";
    expect(await codeOf(s.call({ action: "grant", permission: "geolocation" }))).toBe("ACCESS_DISABLED");
  });
});

describe("用户接管期间", () => {
  it("grant / deny / reset 一律 USER_CONTROL；list 仍可用", async () => {
    const s = await setup({ pagePermissions: true });
    s.session.controller = "user";
    for (const args of [
      { action: "grant", permission: "geolocation" },
      { action: "deny", permission: "geolocation" },
      { action: "reset" },
    ]) {
      expect(await codeOf(s.call(args)), JSON.stringify(args)).toBe("USER_CONTROL");
    }
    expect(getPermissionState(s.session).grants.size).toBe(0);
    expect(await codeOf(s.call({ action: "list" }))).toBe("OK");
  });

  it("开关优先于接管判断：开关关着 + 接管 → ACCESS_DISABLED（不泄露「现在在接管」）", async () => {
    const s = await setup({ pagePermissions: false });
    s.session.controller = "user";
    expect(await codeOf(s.call({ action: "grant", permission: "geolocation" }))).toBe("ACCESS_DISABLED");
  });
});

describe("grant / deny / reset", () => {
  it("grant：写 source:ai 的授予（缺省 = 当前页面 origin）；gate 随即免提示放行；写 actor:ai 活动日志；通知前端刷新", async () => {
    const s = await setup({ pagePermissions: true });
    const r = await s.call({ action: "grant", permission: "geolocation" });
    expect(r).toEqual({ action: "grant", permission: "geolocation", origin: A });
    expect(getPermissionState(s.session).grants.get(A, "geolocation")).toMatchObject({ decision: "allow", source: "ai" });
    const cb = s.request("geolocation");
    await flush();
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    const entries = s.aiEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain("授予了");
    expect(entries[0].summary).toContain("a.example.com");
    expect(entries[0].summary).toContain("位置信息");
    expect(s.scheduleState).toHaveBeenCalled();
  });

  it("origin 参数：裸域名补 https、带端口保留；非法 origin → BAD_ARGS；origin 缺省且当前页是 about:blank → BAD_ARGS", async () => {
    const s = await setup({ pagePermissions: true });
    expect(await s.call({ action: "grant", permission: "notifications", origin: "example.com" })).toMatchObject({ origin: "https://example.com" });
    expect(await s.call({ action: "grant", permission: "notifications", origin: "http://localhost:3000/x" })).toMatchObject({ origin: "http://localhost:3000" });
    expect(await codeOf(s.call({ action: "grant", permission: "notifications", origin: "javascript:alert(1)" }))).toBe("BAD_ARGS");
    expect(await codeOf(s.call({ action: "grant", permission: "notifications", origin: "file:///etc/passwd" }))).toBe("BAD_ARGS");
    const blank = await setup({ pagePermissions: true }, "about:blank");
    expect(await codeOf(blank.call({ action: "grant", permission: "notifications" }))).toBe("BAD_ARGS");
  });

  it("永远拒绝的权限（含别名）→ DENIED，AI 开着开关也放不开；不写授予、不写日志", async () => {
    const s = await setup({ pagePermissions: true });
    for (const permission of ["media", "camera", "microphone", "display-capture", "usb", "hid", "serial", "openExternal", "fullscreen", "fileSystem"]) {
      expect(await codeOf(s.call({ action: "grant", permission })), permission).toBe("DENIED");
      expect(await codeOf(s.call({ action: "deny", permission })), permission).toBe("DENIED");
    }
    expect(getPermissionState(s.session).grants.size).toBe(0);
    expect(s.aiEntries()).toHaveLength(0);
    // gate 仍然拒绝
    const cb = s.request("media");
    expect(cb).toHaveBeenCalledWith(false);
  });

  it("Flowship 自己的 origin → DENIED（显式 origin 或当前页面都一样）", async () => {
    const s = await setup({ pagePermissions: true });
    expect(await codeOf(s.call({ action: "grant", permission: "geolocation", origin: APP_ORIGIN }))).toBe("DENIED");
    expect(await codeOf(s.call({ action: "deny", permission: "geolocation", origin: `${APP_ORIGIN}/x` }))).toBe("DENIED");
    const onApp = await setup({ pagePermissions: true }, `${APP_ORIGIN}/page`);
    expect(await codeOf(onApp.call({ action: "grant", permission: "geolocation" }))).toBe("DENIED");
    expect(getPermissionState(onApp.session).grants.size).toBe(0);
  });

  it("未知权限名 → BAD_ARGS；clipboard-sanitized-write 本来就放行 → 提示无需授予（不写记录）", async () => {
    const s = await setup({ pagePermissions: true });
    expect(await codeOf(s.call({ action: "grant", permission: "brand-new-permission" }))).toBe("BAD_ARGS");
    const r = (await s.call({ action: "grant", permission: "clipboard-sanitized-write" })) as { note: string };
    expect(r.note).toContain("默认允许");
    expect(getPermissionState(s.session).grants.size).toBe(0);
  });

  it("deny：显式拒绝记录，之后该 origin 的请求直接拒绝（不弹提示），优先于定位模拟", async () => {
    const s = await setup({ pagePermissions: true });
    await s.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 } });
    expect(await s.call({ action: "deny", permission: "geolocation" })).toEqual({ action: "deny", permission: "geolocation", origin: A });
    const cb = s.request("geolocation");
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.aiEntries()[0].summary).toContain("拒绝了");
  });

  it("reset：按 origin / permission / 全部清；返回清掉的条数；写日志；同时清冷却", async () => {
    const s = await setup({ pagePermissions: true });
    await s.call({ action: "grant", permission: "geolocation" });
    await s.call({ action: "grant", permission: "notifications" });
    await s.call({ action: "grant", permission: "geolocation", origin: "https://b.example.com" });
    getPermissionState(s.session).cooldown.set("k", Date.now() + 60_000);
    expect(await s.call({ action: "reset", permission: "geolocation", origin: A })).toMatchObject({ cleared: 1, origin: A, permission: "geolocation" });
    expect(await s.call({ action: "reset", origin: A })).toMatchObject({ cleared: 1 });
    expect(getPermissionState(s.session).cooldown.size).toBe(0);
    expect(await s.call({ action: "reset" })).toMatchObject({ cleared: 1 });
    expect(getPermissionState(s.session).grants.size).toBe(0);
    const resets = s.aiEntries().filter((e) => e.summary.includes("重置"));
    expect(resets).toHaveLength(3);
  });

  it("所有改动类动作都写 actor:ai 的活动日志（grant / deny / reset 各一条）", async () => {
    const s = await setup({ pagePermissions: true });
    await s.call({ action: "grant", permission: "geolocation" });
    await s.call({ action: "deny", permission: "notifications" });
    await s.call({ action: "reset" });
    expect(s.aiEntries()).toHaveLength(3);
  });

  it("授予记录满了（上限）→ DENIED 并提示先 reset", async () => {
    const s = await setup({ pagePermissions: true });
    const grants = getPermissionState(s.session).grants;
    for (let i = 0; i < MAX_GRANT_ENTRIES; i++) grants.allow(`https://h${i}.example.com`, "geolocation", "ai");
    expect(await codeOf(s.call({ action: "grant", permission: "geolocation" }))).toBe("DENIED");
    await expect(s.call({ action: "grant", permission: "geolocation" })).rejects.toThrow(/reset/);
  });

  it("grant 通知：预装当前 origin 上标签的通知代理（页面常先读 Notification.permission）", async () => {
    const s = await setup({ pagePermissions: true });
    await s.call({ action: "grant", permission: "notifications" });
    expect(s.tab.sent.map((x) => x.method)).toContain("Runtime.addBinding");
    // 别的权限不装
    const s2 = await setup({ pagePermissions: true });
    await s2.call({ action: "grant", permission: "geolocation" });
    expect(s2.tab.sent).toHaveLength(0);
  });

  it("tabId 不存在 + 没给 origin → TAB_NOT_FOUND", async () => {
    const s = await setup({ pagePermissions: true });
    expect(await codeOf(s.call({ action: "grant", permission: "geolocation", tabId: "t99" }))).toBe("TAB_NOT_FOUND");
  });

  it("授予表按会话隔离：另一个会话看不到、清不掉", async () => {
    const s1 = await setup({ pagePermissions: true });
    const s2 = await setup({ pagePermissions: true });
    await s1.call({ action: "grant", permission: "geolocation" });
    expect(getPermissionState(s2.session).grants.size).toBe(0);
    expect(getPermissionState(s1.session).grants.size).toBe(1);
  });
});
