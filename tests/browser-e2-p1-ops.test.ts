/**
 * E2·P1 · A8 `permissions` op（electron-app/browser/ops/permissions.mjs）：参数校验、开关（主进程独立校验）、接管、DENIED 规则、活动日志。
 * 真 BrowserSession + 假 tab；gate 用真的 createPermissionGate。
 */
import { describe, expect, it, vi } from "vitest";

import { normalizeOpArgs } from "../electron-app/browser/index.mjs";
import { createHandlers } from "../electron-app/browser/ops/permissions.mjs";
import { MAX_RECENT_BLOCKED, createPermissionGate, getPermissionState } from "../electron-app/browser/permission-gate.mjs";
import { MAX_GRANT_ENTRIES } from "../electron-app/browser/permission-policy.mjs";

import { APP_ORIGIN, flush, makeEnv, type P1Config } from "./helpers/browser-e2-p1-fakes";

const A = "https://a.example.com";

const setup = async (cfg: Partial<P1Config> = {}, url = `${A}/page`, gateExtra: Record<string, unknown> = {}) => {
  const env = makeEnv(cfg);
  const gate = createPermissionGate({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m), ...gateExtra });
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
  /** extra：并进 Electron 的 details（如 media 的 mediaTypes） */
  const request = (permission: string, requestingUrl = `${A}/page`, extra: Record<string, unknown> = {}) => {
    const cb = vi.fn();
    gate.handleRequest(tab.wc, permission, cb, { requestingUrl, isMainFrame: true, ...extra });
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

  it("第二十一轮：list 带「最近被自动拒绝」清单（最新在前、最多 5 条、含固定文案 / 次数 / 几秒前）——页面要权限却没弹提示时 AI 据此排查", async () => {
    const s = await setup();
    expect(((await s.call({ action: "list" })) as { recentBlocked: unknown[] }).recentBlocked).toEqual([]);
    getPermissionState(s.session).grants.deny(A, "microphone", "ai");
    s.request("media", `${A}/page`, { mediaTypes: ["audio"] });
    s.request("media", `${A}/page`, { mediaTypes: ["audio"] });
    for (let i = 0; i < 6; i++) {
      getPermissionState(s.session).grants.deny(`https://h${i}.example.com`, "geolocation", "ai");
      s.request("geolocation", `https://h${i}.example.com/`);
    }
    const r = (await s.call({ action: "list" })) as { recentBlocked: Array<Record<string, unknown>> };
    expect(r.recentBlocked).toHaveLength(5);
    expect(r.recentBlocked[0]).toMatchObject({ origin: "https://h5.example.com", permission: "geolocation", reason: "explicit-deny-ai", count: 1 });
    expect(r.recentBlocked[0].ageSec as number).toBeGreaterThanOrEqual(0);
    expect(r.recentBlocked[0].ageSec as number).toBeLessThanOrEqual(5);
    expect(typeof r.recentBlocked[0].reasonText).toBe("string");
    expect(String(r.recentBlocked[0].reasonText)).toContain("拒绝");
    // 内嵌框架来源另带 frameOrigin；顶层自己的请求没有这个字段
    expect(r.recentBlocked[0]).not.toHaveProperty("frameOrigin");
    expect(s.aiEntries()).toHaveLength(0); // list 只读，不写 AI 活动记录
    const mic = (getPermissionState(s.session).recentBlocked as Array<Record<string, unknown>>).find((e) => e.permission === "microphone");
    expect(mic).toMatchObject({ count: 2 });
  });

  it("第二十一轮：清单里的 ageSec 按「现在 − 记录时间」算（不是写死）；来自内嵌框架的请求带 frameOrigin（来源 = 顶层、frameOrigin = 嵌入页面）", async () => {
    const s = await setup();
    s.request("geolocation", "https://b.example.com/embed", { isMainFrame: false });
    // 同一个会话 / gate，另起一份 handlers 把「现在」拨快 12 秒
    const later = createHandlers({
      requireSession: () => s.session,
      getConfig: () => s.config,
      electron: { isAppUrl: s.isAppUrl },
      permissionGate: s.gate,
      scheduleState: vi.fn(),
      log: () => {},
      now: () => Date.now() + 12_000,
    });
    const r = (await later.permissions("task-p1", normalizeOpArgs("permissions", { action: "list" }))) as { recentBlocked: Array<Record<string, unknown>> };
    expect(r.recentBlocked).toHaveLength(1);
    expect(r.recentBlocked[0]).toMatchObject({ origin: A, frameOrigin: "https://b.example.com", permission: "geolocation", reason: "cross-origin-frame" });
    expect(r.recentBlocked[0].ageSec as number).toBeGreaterThanOrEqual(11);
    expect(r.recentBlocked[0].ageSec as number).toBeLessThanOrEqual(13);
  });

  it("reset（不带 origin / permission）之后清单一并清空（授予 / 拒绝记录没了，原因就过期了）", async () => {
    const s = await setup({ pagePermissions: true });
    getPermissionState(s.session).grants.deny(A, "microphone", "ai");
    s.request("media", `${A}/page`, { mediaTypes: ["audio"] });
    expect(((await s.call({ action: "list" })) as { recentBlocked: unknown[] }).recentBlocked).toHaveLength(1);
    await s.call({ action: "reset" });
    expect(((await s.call({ action: "list" })) as { recentBlocked: unknown[] }).recentBlocked).toEqual([]);
  });

  it("R22-3：reset 带 origin / permission 时只清对应的几条（别的站点 / 别的权限的诊断仍有效）；media 合称与麦克风 / 摄像头互相算相关", async () => {
    const H1 = "https://h1.example.com";
    const H2 = "https://h2.example.com";
    const seed = async () => {
      const s = await setup({ pagePermissions: true });
      const grants = getPermissionState(s.session).grants;
      grants.deny(A, "microphone", "ai");
      grants.deny(A, "camera", "ai");
      grants.deny(H1, "geolocation", "ai");
      grants.deny(H2, "microphone", "ai");
      s.request("media", `${A}/page`, { mediaTypes: ["audio"] });
      s.request("media", `${A}/page`, { mediaTypes: ["video"] });
      s.request("geolocation", `${H1}/`);
      s.request("media", `${H2}/`, { mediaTypes: ["audio"] });
      return s;
    };
    const pairs = async (s: Awaited<ReturnType<typeof setup>>) =>
      ((await s.call({ action: "list" })) as { recentBlocked: Array<{ origin: string; permission: string }> }).recentBlocked.map((e) => `${e.origin.replace("https://", "")}|${e.permission}`).sort();

    const a = await seed();
    expect(await pairs(a)).toEqual(["a.example.com|camera", "a.example.com|microphone", "h1.example.com|geolocation", "h2.example.com|microphone"]);
    await a.call({ action: "reset", origin: A, permission: "microphone" });
    expect(await pairs(a)).toEqual(["a.example.com|camera", "h1.example.com|geolocation", "h2.example.com|microphone"]);

    const b = await seed();
    await b.call({ action: "reset", origin: A }); // 只给 origin：该站点的都清，别的站点留着
    expect(await pairs(b)).toEqual(["h1.example.com|geolocation", "h2.example.com|microphone"]);

    const c = await seed();
    await c.call({ action: "reset", permission: "media" }); // 只给 permission（media = 麦克风 + 摄像头）：所有站点的麦克风 / 摄像头清，定位留着
    expect(await pairs(c)).toEqual(["h1.example.com|geolocation"]);

    const d = await seed();
    await d.call({ action: "reset", permission: "geolocation" });
    expect(await pairs(d)).toEqual(["a.example.com|camera", "a.example.com|microphone", "h2.example.com|microphone"]);

    // 合称 media 的那条记录（麦克风 + 摄像头一起请求时记的）：重置其中任意一项都算相关
    const e = await setup({ pagePermissions: true });
    getPermissionState(e.session).grants.deny(A, "microphone", "ai");
    getPermissionState(e.session).grants.deny(A, "camera", "ai");
    e.request("media", `${A}/page`, { mediaTypes: ["audio", "video"] });
    expect(await pairs(e)).toEqual(["a.example.com|media"]);
    await e.call({ action: "reset", permission: "camera" });
    expect(await pairs(e)).toEqual([]);
  });

  it("R22-3：清单按目标标签的 partition 分开（与授予表同口径）：普通标签的 list 看不到无痕标签上被拒的来源，反之亦然；总数也只算同一份", async () => {
    const s = await setup({ pagePermissions: true });
    const H = "https://incog.example.com";
    getPermissionState(s.session).grants.deny(A, "microphone", "ai");
    s.request("media", `${A}/page`, { mediaTypes: ["audio"] }); // 普通标签
    s.tab.incognito = true;
    getPermissionState(s.session).incognitoGrants.deny(H, "geolocation", "ai");
    s.request("geolocation", `${H}/`); // 无痕标签
    const incog = (await s.call({ action: "list" })) as { recentBlocked: Array<{ origin: string }>; recentBlockedTotal: number };
    expect(incog.recentBlocked.map((e) => e.origin)).toEqual([H]);
    expect(incog.recentBlockedTotal).toBe(1);
    s.tab.incognito = false;
    const normal = (await s.call({ action: "list" })) as { recentBlocked: Array<{ origin: string }>; recentBlockedTotal: number };
    expect(normal.recentBlocked.map((e) => e.origin)).toEqual([A]);
    expect(normal.recentBlockedTotal).toBe(1);
    // 无痕 partition 被 wipe（最后一个无痕标签关闭）：无痕那条作废，普通那条还在
    s.tab.incognito = true;
    getPermissionState(s.session).onPartitionWiped("flowship-incognito-1");
    expect(((await s.call({ action: "list" })) as { recentBlocked: unknown[] }).recentBlocked).toEqual([]);
    s.tab.incognito = false;
    expect(((await s.call({ action: "list" })) as { recentBlocked: unknown[] }).recentBlocked).toHaveLength(1);
  });

  it("R22-3：清单被截断时回总数 recentBlockedTotal（只列最近 5 条，总数照实）", async () => {
    const s = await setup();
    for (let i = 0; i < 8; i++) {
      getPermissionState(s.session).grants.deny(`https://t${i}.example.com`, "geolocation", "ai");
      s.request("geolocation", `https://t${i}.example.com/`);
    }
    const r = (await s.call({ action: "list" })) as { recentBlocked: unknown[]; recentBlockedTotal: number };
    expect(r.recentBlocked).toHaveLength(5);
    expect(r.recentBlockedTotal).toBe(8);
    const empty = (await (await setup()).call({ action: "list" })) as { recentBlockedTotal: number };
    expect(empty.recentBlockedTotal).toBe(0);
  });

  it("R23-6：同 partition 的记录到 MAX_RECENT_BLOCKED 上限（更早的已被挤掉）时带 recentBlockedAtLeast，总数只是下限；没到上限不带；两个 partition 各算各的", async () => {
    const s = await setup({ pagePermissions: true });
    const deny = (incognito: boolean, host: string) => {
      s.tab.incognito = incognito;
      getPermissionState(s.session)[incognito ? "incognitoGrants" : "grants"].deny(`https://${host}`, "geolocation", "ai");
      s.request("geolocation", `https://${host}/`);
      s.tab.incognito = false;
    };
    for (let i = 0; i < MAX_RECENT_BLOCKED - 1; i++) deny(false, `n${i}.example.com`);
    const below = (await s.call({ action: "list" })) as { recentBlockedTotal: number };
    expect(below.recentBlockedTotal).toBe(MAX_RECENT_BLOCKED - 1);
    expect(below).not.toHaveProperty("recentBlockedAtLeast");
    deny(false, "n-last.example.com"); // 刚好到上限
    const at = (await s.call({ action: "list" })) as { recentBlockedTotal: number; recentBlockedAtLeast?: boolean };
    expect(at.recentBlockedTotal).toBe(MAX_RECENT_BLOCKED);
    expect(at.recentBlockedAtLeast).toBe(true);
    // 普通 partition 满了不影响无痕那一份的判断
    deny(true, "private.example.com");
    s.tab.incognito = true;
    const incog = (await s.call({ action: "list" })) as { recentBlockedTotal: number };
    expect(incog.recentBlockedTotal).toBe(1);
    expect(incog).not.toHaveProperty("recentBlockedAtLeast");
  });

  it("R23-3：页内查询桩没装上时 list 带 queryStub.problems（scope + message，不带页面内容）；装上 / 没问题时不带这个字段", async () => {
    const s = await setup();
    expect(await s.call({ action: "list" })).not.toHaveProperty("queryStub");
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") throw new Error("cdp gone");
      return {};
    };
    s.tab.attachChild("child-1");
    const hook = [...s.tab.earlySessionHooks][0];
    await hook(null);
    await hook("child-1");
    const r = (await s.call({ action: "list" })) as { queryStub?: { problems: Array<{ scope: string; message: string }> } };
    expect(r.queryStub).toEqual({
      problems: [
        { scope: "main", message: "cdp gone" },
        { scope: "frame", message: "cdp gone" },
      ],
    });
    // 目标 tab 不存在 / 老版本 gate 没有该方法：不带、不崩
    expect(await s.call({ action: "list", tabId: "t99" })).not.toHaveProperty("queryStub");
    s.tab.sendImpl = async () => ({});
    await hook(null);
    await hook("child-1");
    expect(await s.call({ action: "list" })).not.toHaveProperty("queryStub");
  });

  it("R22-3：系统层挡住麦克风 / 摄像头时 list 带 systemMedia（AI 点了授予页面仍无声时能直接看到这一层）；没问题时不带这个字段", async () => {
    const blocked = await setup({}, `${A}/page`, { getMediaAccessStatus: (k: string) => (k === "microphone" ? "denied" : "restricted"), platform: "darwin" });
    const r = (await blocked.call({ action: "list" })) as { systemMedia?: { platform: string; problems: Array<{ permission: string; status: string }> } };
    expect(r.systemMedia).toEqual({
      platform: "darwin",
      problems: [
        { permission: "microphone", status: "denied" },
        { permission: "camera", status: "restricted" },
      ],
    });
    const fine = await setup({}, `${A}/page`, { getMediaAccessStatus: () => "granted", platform: "darwin" });
    expect(await fine.call({ action: "list" })).not.toHaveProperty("systemMedia");
    expect(await (await setup()).call({ action: "list" })).not.toHaveProperty("systemMedia");
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
    for (const permission of ["display-capture", "screen", "usb", "hid", "serial", "openExternal", "fullscreen", "fileSystem"]) {
      expect(await codeOf(s.call({ action: "grant", permission })), permission).toBe("DENIED");
      expect(await codeOf(s.call({ action: "deny", permission })), permission).toBe("DENIED");
    }
    expect(getPermissionState(s.session).grants.size).toBe(0);
    expect(s.aiEntries()).toHaveLength(0);
    // gate 仍然拒绝
    const cb = s.request("display-capture");
    expect(cb).toHaveBeenCalledWith(false);
  });

  it("麦克风 / 摄像头不再是红线：AI 的 grant / deny 能写进授予表（要开着「AI 管理页面权限」），gate 随之放行 / 拒绝；两者互相独立", async () => {
    const s = await setup({ pagePermissions: true });
    const audio = { mediaTypes: ["audio"] };
    const video = { mediaTypes: ["video"] };
    // 只授予麦克风（别名 mic / audio 同义）：摄像头不被连带
    expect(await s.call({ action: "grant", permission: "microphone" })).toEqual({ action: "grant", permission: "microphone", origin: A });
    const grants = getPermissionState(s.session).grants;
    expect(grants.get(A, "microphone")).toMatchObject({ decision: "allow", source: "ai" });
    expect(grants.get(A, "camera")).toBeUndefined();
    expect(s.request("media", undefined, audio)).toHaveBeenCalledWith(true);
    expect(s.gate.handleCheck(s.tab.wc, "media", A, { isMainFrame: true, mediaType: "audio" })).toBe(true);
    expect(s.gate.handleCheck(s.tab.wc, "media", A, { isMainFrame: true, mediaType: "video" })).toBe(false);
    // 单独拒绝摄像头（别名 video 同义）：只影响摄像头
    expect(await s.call({ action: "deny", permission: "video" })).toEqual({ action: "deny", permission: "camera", origin: A });
    expect(s.request("media", undefined, video)).toHaveBeenCalledWith(false);
    expect(s.request("media", undefined, audio)).toHaveBeenCalledWith(true);
    expect(s.gate.handleCheck(s.tab.wc, "media", A, { isMainFrame: true, mediaType: "audio" })).toBe(true);
    // 没开「AI 管理页面权限」：AI 不能授予
    const off = await setup({ pagePermissions: false });
    expect(await codeOf(off.call({ action: "grant", permission: "media" }))).toBe("ACCESS_DISABLED");
    expect(await codeOf(off.call({ action: "grant", permission: "camera" }))).toBe("ACCESS_DISABLED");
    expect(getPermissionState(off.session).grants.size).toBe(0);
  });

  it("R9-02：permission 写 media = 麦克风 + 摄像头一起（grant / deny / reset 都是两项）；授予表里只有这两个独立条目", async () => {
    const s = await setup({ pagePermissions: true });
    const grants = getPermissionState(s.session).grants;
    expect(await s.call({ action: "grant", permission: "media" })).toEqual({ action: "grant", permission: "media", origin: A });
    expect(grants.get(A, "microphone")).toMatchObject({ decision: "allow", source: "ai" });
    expect(grants.get(A, "camera")).toMatchObject({ decision: "allow", source: "ai" });
    expect(grants.get(A, "media")).toBeUndefined();
    expect(grants.size).toBe(2);
    expect(s.request("media", undefined, { mediaTypes: ["audio", "video"] })).toHaveBeenCalledWith(true);
    expect(s.aiEntries().at(-1)?.summary).toContain("摄像头 + 麦克风");
    // reset media：两项都清，返回条数 2；只 reset 其中一个则只清一个
    expect(await s.call({ action: "reset", permission: "media" })).toMatchObject({ cleared: 2, permission: "media" });
    expect(grants.size).toBe(0);
    await s.call({ action: "grant", permission: "media" });
    expect(await s.call({ action: "reset", permission: "camera" })).toMatchObject({ cleared: 1, permission: "camera" });
    expect(grants.get(A, "microphone")).toBeDefined();
    expect(grants.get(A, "camera")).toBeUndefined();
    // deny media：两项都记显式拒绝
    await s.call({ action: "reset" });
    expect(await s.call({ action: "deny", permission: "Media" })).toEqual({ action: "deny", permission: "media", origin: A });
    expect(grants.get(A, "microphone")).toMatchObject({ decision: "deny", source: "ai" });
    expect(grants.get(A, "camera")).toMatchObject({ decision: "deny", source: "ai" });
    // list 里列出的是两条独立记录（AI 看到的名字可以直接拿去 reset）
    const listed = (await s.call({ action: "list" })) as { grants: Array<{ permission: string }> };
    expect(listed.grants.map((g) => g.permission).sort()).toEqual(["camera", "microphone"]);
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
    // speaker-selection 现在也是默认放行：grant / deny 都只提示、不写记录（摄像头 / 麦克风不在此列，是询问类，见上面两条）
    const sp = (await s.call({ action: "grant", permission: "speaker-selection" })) as { note: string };
    expect(sp.note).toContain("默认允许");
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

  it("reset：按 origin / permission / 全部清；返回清掉的条数；写日志；冷却只清范围内匹配的那些（R23-6：此前带范围的 reset 也会清空整张冷却表）", async () => {
    const s = await setup({ pagePermissions: true });
    await s.call({ action: "grant", permission: "geolocation" });
    await s.call({ action: "grant", permission: "notifications" });
    await s.call({ action: "grant", permission: "geolocation", origin: "https://b.example.com" });
    const state = getPermissionState(s.session);
    const until = Date.now() + 60_000;
    const key = (origin: string, perm: string) => `${s.tab.id}|${origin}|${perm}`;
    const B = "https://b.example.com";
    for (const k of [key(A, "geolocation"), key(A, "notifications"), key(B, "geolocation")]) state.cooldown.set(k, until);
    state.cancelCooldown.set(key(A, "geolocation"), until);
    state.cancelStreak.set(key(B, "geolocation"), { n: 2, at: Date.now() });
    const cooling = () => [...state.cooldown.keys()].map((k) => k.slice(s.tab.id.length + 1));
    expect(await s.call({ action: "reset", permission: "geolocation", origin: A })).toMatchObject({ cleared: 1, origin: A, permission: "geolocation" });
    // 只清 A + geolocation 的那一条（含短冷却）；A 的通知、B 的定位冷却 / 取消计数都还在——页面行为与 list 的诊断记录保持一致
    expect(cooling()).toEqual([`${A}|notifications`, `${B}|geolocation`]);
    expect(state.cancelCooldown.size).toBe(0);
    expect(state.cancelStreak.size).toBe(1);
    expect(await s.call({ action: "reset", origin: A })).toMatchObject({ cleared: 1 });
    expect(cooling()).toEqual([`${B}|geolocation`]);
    expect(await s.call({ action: "reset" })).toMatchObject({ cleared: 1 });
    expect(cooling()).toEqual([]);
    expect(state.cancelStreak.size).toBe(0);
    expect(getPermissionState(s.session).grants.size).toBe(0);
    const resets = s.aiEntries().filter((e) => e.summary.includes("重置"));
    expect(resets).toHaveLength(3);
  });

  it("reset media（合称）展开成麦克风 + 摄像头两项：两项的冷却与取消计数都清；别的权限不动；只 reset 麦克风时摄像头的不动（R23-6；冷却类三张表的键都是独立权限名，门不产生合称 media 的键）", async () => {
    const s = await setup({ pagePermissions: true });
    const state = getPermissionState(s.session);
    const until = Date.now() + 60_000;
    const key = (perm: string) => `${s.tab.id}|${A}|${perm}`;
    for (const p of ["microphone", "camera", "geolocation"]) state.cooldown.set(key(p), until);
    for (const p of ["microphone", "camera"]) state.cancelStreak.set(key(p), { n: 1, at: Date.now() });
    state.cancelCooldown.set(key("camera"), until);
    await s.call({ action: "reset", permission: "media", origin: A });
    expect([...state.cooldown.keys()].map((k) => k.split("|").pop())).toEqual(["geolocation"]);
    expect(state.cancelStreak.size).toBe(0);
    expect(state.cancelCooldown.size).toBe(0);
    // 只 reset 麦克风：摄像头键不动
    state.cooldown.clear();
    for (const p of ["microphone", "camera"]) state.cooldown.set(key(p), until);
    await s.call({ action: "reset", permission: "microphone", origin: A });
    expect([...state.cooldown.keys()].map((k) => k.split("|").pop())).toEqual(["camera"]);
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
