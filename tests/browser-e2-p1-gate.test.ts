/**
 * E2·P1 · A8 页面权限闸（electron-app/browser/permission-gate.mjs）：请求 / 检查处理器的行为。
 * 真 BrowserSession（真 PromptHub / 真活动日志）+ 假 tab / 假 wc（tests/helpers/browser-e2-p1-fakes.ts）。
 */
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOTIFICATION_STUB_SOURCE,
  NOTIFY_BINDING_NAME,
  NOTIFY_RATE_PER_MIN,
  PERMISSION_COOLDOWN_MS,
  PERMISSION_PROMPT_TIMEOUT_MS,
  createPermissionGate,
  getPermissionState,
} from "../electron-app/browser/permission-gate.mjs";

import { APP_ORIGIN, FakeTab, firstPrompt, flush, makeEnv, type P1Config } from "./helpers/browser-e2-p1-fakes";

const A = "https://a.example.com";
const B = "https://b.example.com";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const setup = async (cfg: Partial<P1Config> = {}, url = `${A}/page`) => {
  const env = makeEnv(cfg);
  const gate = createPermissionGate({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
  const tab = await env.openTab(url);
  gate.bindTab(tab);
  /** 发一次请求，返回回调 mock */
  const request = (permission: string, details: Record<string, unknown> = { requestingUrl: `${A}/page`, isMainFrame: true }, wc: unknown = tab.wc) => {
    const cb = vi.fn();
    gate.handleRequest(wc, permission, cb, details);
    return cb;
  };
  const check = (permission: string, origin = A, details: Record<string, unknown> = { isMainFrame: true }, wc: unknown = tab.wc) => gate.handleCheck(wc, permission, origin, details);
  return { ...env, gate, tab, request, check };
};

describe("请求处理器：硬规则（不弹提示）", () => {
  it.each(["media", "display-capture", "usb", "hid", "serial", "openExternal", "fullscreen", "keyboardLock", "fileSystem", "unknown"])("%s：直接拒绝，回调恰好一次，不产生提示", async (permission) => {
    const s = await setup();
    const cb = s.request(permission);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.check(permission)).toBe(false);
  });

  it("clipboard-sanitized-write 放行（请求与检查口径一致）", async () => {
    const s = await setup();
    const cb = s.request("clipboard-sanitized-write");
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.check("clipboard-sanitized-write")).toBe(true);
  });

  it("找不到所属 tab（wc 是陌生对象 / null）→ 拒绝；检查处理器同样", async () => {
    const s = await setup();
    for (const wc of [{}, null]) {
      const cb = s.request("clipboard-sanitized-write", { requestingUrl: `${A}/`, isMainFrame: true }, wc);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(false);
      expect(s.check("clipboard-sanitized-write", A, { isMainFrame: true }, wc)).toBe(false);
    }
    expect(s.session.prompts.size()).toBe(0);
  });

  it("Flowship 自己的 origin：什么都不给，连剪贴板写也拒绝", async () => {
    const s = await setup({}, `${APP_ORIGIN}/x`);
    const cb = s.request("clipboard-sanitized-write", { requestingUrl: `${APP_ORIGIN}/x`, isMainFrame: true });
    expect(cb).toHaveBeenCalledWith(false);
    const cb2 = s.request("geolocation", { requestingUrl: `${APP_ORIGIN}/x`, isMainFrame: true });
    await flush();
    expect(cb2).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.check("geolocation", APP_ORIGIN)).toBe(false);
  });

  it("不透明来源 / 不认识的权限名 → 拒绝且不弹提示", async () => {
    const s = await setup({}, "about:blank");
    const cb = s.request("geolocation", { requestingUrl: "about:blank", isMainFrame: true });
    const cb2 = s.request("brand-new-permission", { requestingUrl: `${A}/`, isMainFrame: true });
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(cb2).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("处理过程出任何异常都按拒绝回调，且只回调一次", async () => {
    const env = makeEnv();
    const gate = createPermissionGate({
      findOwner: () => {
        throw new Error("boom");
      },
      getConfig: () => env.config,
      isAppUrl: env.isAppUrl,
      log: (m: string) => env.logs.push(m),
    });
    const cb = vi.fn();
    gate.handleRequest({}, "geolocation", cb, { requestingUrl: `${A}/` });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(gate.handleCheck({}, "geolocation", A, {})).toBe(false);
    expect(env.logs.join("\n")).toContain("已拒绝");
  });

  it("回调本身抛错不外溢（只记日志）", async () => {
    const s = await setup();
    const cb = vi.fn(() => {
      throw new Error("cb boom");
    });
    expect(() => s.gate.handleRequest(s.tab.wc, "clipboard-sanitized-write", cb, { requestingUrl: `${A}/` })).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(s.logs.join("\n")).toContain("权限回调失败");
  });
});

describe("请求处理器：询问用户", () => {
  it("geolocation：发 permission 提示（detail 只有权限名 / origin），allow = 仅这一次", async () => {
    const s = await setup();
    const cb = s.request("geolocation");
    await flush();
    const p = firstPrompt(s.session, "permission");
    expect(p.detail).toEqual({ permission: "geolocation", origin: A });
    expect(p.host).toBe("a.example.com");
    expect(p.tabId).toBe(s.tab.id);
    expect(cb).not.toHaveBeenCalled();
    expect(s.session.prompts.answer(p.id, { action: "allow" })).toBe(true);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    // 仅这一次：下一次请求又要问；检查处理器也不认
    expect(s.check("geolocation")).toBe(false);
    s.request("geolocation");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("allow-session：之后同 origin 同权限不再弹提示，检查处理器也认；别的 origin / 权限仍要问", async () => {
    const s = await setup();
    const cb = s.request("notifications");
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow-session" });
    await flush();
    expect(cb).toHaveBeenCalledWith(true);
    expect(getPermissionState(s.session).grants.get(A, "notifications")).toMatchObject({ decision: "allow", source: "user" });

    const cb2 = s.request("notifications");
    await flush();
    expect(cb2).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.check("notifications")).toBe(true);

    s.request("geolocation");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    expect(s.check("notifications", B)).toBe(false);
  });

  it("deny：回调 false；冷却期内同请求直接拒绝（不再弹），过了冷却才重新问", async () => {
    const s = await setup();
    const cb = s.request("geolocation");
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    expect(cb).toHaveBeenCalledWith(false);

    const cb2 = s.request("geolocation");
    await flush();
    expect(cb2).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);

    await vi.advanceTimersByTimeAsync(PERMISSION_COOLDOWN_MS + 1000);
    s.request("geolocation");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("超时（60 秒无人处理）→ 默认拒绝，回调恰好一次", async () => {
    const s = await setup();
    const cb = s.request("geolocation");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS + 10);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("同一 tab + origin + 权限的并发请求合并成一个提示，回答后各自回调一次", async () => {
    const s = await setup();
    const cbs = [s.request("clipboard-read"), s.request("clipboard-read"), s.request("clipboard-read")];
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow-session" });
    await flush();
    for (const cb of cbs) {
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(true);
    }
    // 不同权限各有各的提示
    s.request("geolocation");
    s.request("midi");
    await flush();
    expect(s.session.prompts.size()).toBe(2);
  });

  it("主框架导航离开 → 该 tab 上的权限提示作废（回调 false）；同文档导航 / 子框架导航不作废", async () => {
    const s = await setup();
    const cb = s.request("geolocation");
    await flush();
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    s.tab.wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    expect(cb).not.toHaveBeenCalled();
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("tab 销毁 → 权限提示作废（回调 false）；会话销毁 → 全部按默认拒绝", async () => {
    const s = await setup();
    const cb = s.request("geolocation");
    await flush();
    s.tab.destroy();
    await flush();
    expect(cb).toHaveBeenCalledWith(false);

    const s2 = await setup();
    const cb2 = s2.request("geolocation");
    await flush();
    s2.session.destroy();
    await flush();
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(false);
  });

  it("跨源子框架（origin ≠ 顶层）一律拒绝、不弹提示；同源子框架正常询问", async () => {
    const s = await setup();
    const cb = s.request("geolocation", { requestingUrl: "https://evil.example.org/frame", isMainFrame: false });
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    s.request("geolocation", { requestingUrl: `${A}/frame`, isMainFrame: false });
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    // 检查处理器：授予是按顶层站点给的——同源的框架认；被别的站点嵌着（embeddingOrigin ≠ 请求来源）/ 别的站点嵌在本页里，都不认
    const grants = getPermissionState(s.session).grants;
    grants.allow(A, "geolocation", "user");
    grants.allow(B, "geolocation", "user");
    expect(s.check("geolocation", A, { isMainFrame: true })).toBe(true);
    expect(s.check("geolocation", A, { isMainFrame: false })).toBe(true);
    expect(s.check("geolocation", A, { isMainFrame: false, embeddingOrigin: B })).toBe(false);
    expect(s.check("geolocation", B, { isMainFrame: false, embeddingOrigin: A })).toBe(false);
    // 放行请求同理：B 的框架嵌在顶层 A 里，即使 B 有授予记录也拒绝
    const cb2 = s.request("geolocation", { requestingUrl: `${B}/f`, isMainFrame: false });
    expect(cb2).toHaveBeenCalledWith(false);
  });

  it("提示条挂太多时（上限 8）溢出的请求按拒绝处理，不会卡住回调", async () => {
    const s = await setup();
    const cbs: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < 10; i++) cbs.push(s.request("geolocation", { requestingUrl: `https://h${i}.example.com/`, isMainFrame: true }, s.tab.wc));
    await flush();
    // 这些请求的 origin 与顶层 A 不同、又是主框架——策略按「主框架」询问；上限之外的立即被拒
    expect(s.session.prompts.size()).toBeLessThanOrEqual(8);
    const settled = cbs.filter((c) => c.mock.calls.length > 0);
    expect(settled.every((c) => c.mock.calls.length === 1 && c.mock.calls[0][0] === false)).toBe(true);
  });
});

describe("授予的生命周期", () => {
  it("AI 授予（source:ai）只在 pagePermissions 开着时生效；关掉后回到询问", async () => {
    const s = await setup({ pagePermissions: true });
    getPermissionState(s.session).grants.allow(A, "geolocation", "ai");
    const cb = s.request("geolocation");
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.check("geolocation")).toBe(true);
    s.config.pagePermissions = false;
    const cb2 = s.request("geolocation");
    await flush();
    expect(cb2).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
    expect(s.check("geolocation")).toBe(false);
  });

  it("清除浏览数据 / 会话销毁：授予与冷却清空", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    state.grants.allow(A, "notifications", "user");
    state.cooldown.set("k", Date.now() + 99_999);
    state.onBrowsingDataCleared();
    expect(state.grants.size).toBe(0);
    expect(state.cooldown.size).toBe(0);
    state.grants.allow(A, "midi", "user");
    s.session.destroy();
    expect(state.grants.size).toBe(0);
  });
});

describe("定位模拟自动授权（修「定位模拟基本无效」）", () => {
  const geo = { geolocation: { latitude: 31.2, longitude: 121.5 } };

  it("emulate 设了位置：当前 origin 免提示放行（请求 + 检查）；别的 origin 不放行；回到原 origin 又放行", async () => {
    const s = await setup();
    expect(s.check("geolocation")).toBe(false); // 没模拟：不放行
    await s.tab.applyEmulation(geo);
    const cb = s.request("geolocation");
    await flush();
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.check("geolocation")).toBe(true);
    // 导航到别的 origin：不再放行（要问）
    s.tab.url = `${B}/`;
    expect(s.check("geolocation", B)).toBe(false);
    const cb2 = s.request("geolocation", { requestingUrl: `${B}/`, isMainFrame: true });
    await flush();
    expect(cb2).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
    // 回到被模拟的 origin：又放行
    s.tab.url = `${A}/other`;
    expect(s.check("geolocation", A)).toBe(true);
  });

  it("只对 geolocation 生效；通知等仍要问", async () => {
    const s = await setup();
    await s.tab.applyEmulation(geo);
    s.request("notifications");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("模拟里改别的项（UA / 视口）不重绑 origin；reset 之后不再放行", async () => {
    const s = await setup();
    await s.tab.applyEmulation(geo);
    s.tab.url = `${B}/`;
    await s.tab.applyEmulation({ userAgent: "x" }); // 不动定位：绑定仍是 A
    expect(s.check("geolocation", B)).toBe(false);
    s.tab.url = `${A}/`;
    expect(s.check("geolocation", A)).toBe(true);
    await s.tab.applyEmulation({ reset: true });
    expect(s.check("geolocation", A)).toBe(false);
  });

  it("在空白页上设置位置：等第一次导航提交后绑定到那个 origin", async () => {
    const s = await setup({}, "about:blank");
    await s.tab.applyEmulation(geo);
    expect(s.gate.emulatedGeolocationOrigins(s.tab)).toEqual([]);
    s.tab.url = "https://c.example.com/";
    s.tab.wc.emit("did-navigate", {}, "https://c.example.com/");
    expect(s.gate.emulatedGeolocationOrigins(s.tab)).toEqual(["https://c.example.com"]);
    expect(s.check("geolocation", "https://c.example.com")).toBe(true);
    // 之后再导航不会改绑
    s.tab.url = `${B}/`;
    s.tab.wc.emit("did-navigate", {}, `${B}/`);
    expect(s.gate.emulatedGeolocationOrigins(s.tab)).toEqual(["https://c.example.com"]);
  });

  it("模拟只属于设置它的那个 tab：别的 tab 同 origin 仍要问", async () => {
    const s = await setup();
    const tab2 = await s.openTab(`${A}/second`);
    s.gate.bindTab(tab2);
    await s.tab.applyEmulation(geo);
    const cb = vi.fn();
    s.gate.handleRequest(tab2.wc, "geolocation", cb, { requestingUrl: `${A}/second`, isMainFrame: true });
    await flush();
    expect(cb).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
  });
});

describe("通知：不弹系统通知（代理 + fail closed）", () => {
  it("请求通知并被允许：先装代理（binding + 新文档脚本 + 当前文档）再回调 true；之后检查处理器才报已授予", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "notifications", "user");
    expect(s.check("notifications")).toBe(false); // 代理没装好：不报已授予（否则页面读到 granted 直接弹真通知）
    const cb = s.request("notifications");
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    const methods = s.tab.sent.map((x) => x.method);
    expect(methods).toEqual(["Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
    expect(s.tab.sent[0].params).toEqual({ name: NOTIFY_BINDING_NAME });
    expect(s.tab.sent[1].params.source).toBe(NOTIFICATION_STUB_SOURCE);
    expect(s.tab.sent[2].params.expression).toBe(NOTIFICATION_STUB_SOURCE);
    expect(s.check("notifications")).toBe(true);
    // 已装好：再来一次不重复安装
    s.request("notifications");
    await flush();
    expect(s.tab.sent).toHaveLength(3);
  });

  it("代理装不上（CDP 失败）→ 不授予：请求回调 false，检查也是 false", async () => {
    const s = await setup();
    s.tab.sendImpl = async (method) => {
      if (method === "Runtime.addBinding") throw new Error("cdp down");
      return {};
    };
    getPermissionState(s.session).grants.allow(A, "notifications", "user");
    const cb = s.request("notifications");
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.check("notifications")).toBe(false);
    expect(s.logs.join("\n")).toContain("通知代理安装失败");
  });

  it("子框架请求通知一律拒绝（代理只装在主框架）", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "notifications", "user");
    const cb = s.request("notifications", { requestingUrl: `${A}/frame`, isMainFrame: false });
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.tab.sent).toHaveLength(0);
    expect(s.check("notifications", A, { isMainFrame: false })).toBe(false);
  });

  it("页面发出的通知只进活动记录：剥格式字符、限长；binding 名不对 / 载荷畸形的忽略", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "notifications", "user");
    s.request("notifications");
    await flush();
    const entries = () => s.session.activityLog.list().filter((e: { kind: string }) => e.kind === "notification");
    s.tab.emitCdp("Runtime.bindingCalled", { name: NOTIFY_BINDING_NAME, payload: JSON.stringify({ t: "你好\u202E\u200B世界", b: "正文".repeat(200) }) });
    s.tab.emitCdp("Runtime.bindingCalled", { name: "__other", payload: JSON.stringify({ t: "x", b: "y" }) });
    s.tab.emitCdp("Runtime.bindingCalled", { name: NOTIFY_BINDING_NAME, payload: "not json" });
    s.tab.emitCdp("Runtime.consoleAPICalled", { name: NOTIFY_BINDING_NAME, payload: "{}" });
    expect(entries()).toHaveLength(1);
    const e = entries()[0] as { actor: string; summary: string };
    expect(e.actor).toBe("system");
    expect(e.summary).toContain("你好世界");
    expect(e.summary).not.toMatch(/[\u202E\u200B]/);
    expect(e.summary.length).toBeLessThan(400);
  });

  it(`通知记录限速：每分钟最多 ${NOTIFY_RATE_PER_MIN} 条，超出只记一条「过于频繁」；过了窗口恢复`, async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "notifications", "user");
    s.request("notifications");
    await flush();
    const fire = () => s.tab.emitCdp("Runtime.bindingCalled", { name: NOTIFY_BINDING_NAME, payload: JSON.stringify({ t: "n", b: "" }) });
    for (let i = 0; i < NOTIFY_RATE_PER_MIN + 5; i++) fire();
    const notes = () => s.session.activityLog.list().filter((e: { kind: string }) => e.kind === "notification") as Array<{ summary: string }>;
    expect(notes()).toHaveLength(NOTIFY_RATE_PER_MIN + 1);
    expect(notes().filter((n) => n.summary.includes("过于频繁"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    fire();
    expect(notes()).toHaveLength(NOTIFY_RATE_PER_MIN + 2);
  });

  it("prepareGrant：只给就在该 origin 上的 tab 预装代理（仅 notifications）", async () => {
    const s = await setup();
    const other = await s.openTab(`${B}/`);
    s.gate.bindTab(other);
    expect(await s.gate.prepareGrant(s.session, A, "geolocation")).toBe(0);
    expect(await s.gate.prepareGrant(s.session, A, "notifications")).toBe(1);
    expect(s.tab.sent.length).toBeGreaterThan(0);
    expect((other as FakeTab).sent).toHaveLength(0);
  });
});

describe("通知代理源码（在 vm 里跑真代码）", () => {
  // 这组需要真定时器（show 事件靠 setTimeout 异步触发）；外层的 beforeEach 装了假定时器，这里覆盖回来
  beforeEach(() => {
    vi.useRealTimers();
  });

  const run = (permission: string) => {
    const sent: string[] = [];
    let constructed = 0;
    // 真浏览器里 Notification.prototype 继承 EventTarget.prototype；假实例的原型被设成它，这里保持一致
    class Notif extends EventTarget {
      static permission = permission;
      static maxActions = 2;
      static requestPermission = () => Promise.resolve(permission);
      constructor(
        public title: string,
        public options?: unknown,
      ) {
        super();
        constructed += 1;
      }
    }
    const ctx = vm.createContext({ EventTarget, Event, setTimeout, Notification: Notif, __flowshipNotify: (s: string) => sent.push(s) });
    vm.runInContext(NOTIFICATION_STUB_SOURCE, ctx);
    return { ctx, sent, constructed: () => constructed, Notif };
  };

  it("已授予：构造出假实例、不触发原生构造，标题 / 正文通过 binding 上报；binding 被取走（页面拿不到）", async () => {
    const r = run("granted");
    expect(vm.runInContext("typeof __flowshipNotify", r.ctx)).toBe("undefined");
    const fake = vm.runInContext("globalThis.n = new Notification('标题', { body: '正文', data: 7 }); n", r.ctx) as { title: string; body: string; data: number };
    expect(r.constructed()).toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(JSON.parse(r.sent[0])).toEqual({ t: "标题", b: "正文" });
    expect(fake.title).toBe("标题");
    expect(fake.body).toBe("正文");
    expect(fake.data).toBe(7);
    // 静态成员照常可用
    expect(vm.runInContext("Notification.permission", r.ctx)).toBe("granted");
    expect(vm.runInContext("Notification.maxActions", r.ctx)).toBe(2);
    // show 事件会异步触发（有 onshow 的页面逻辑能继续）
    const shown = await new Promise<boolean>((resolve) => {
      (vm.runInContext("n", r.ctx) as { onshow: unknown }).onshow = () => resolve(true);
      setTimeout(() => resolve(false), 200);
    });
    expect(shown).toBe(true);
  });

  it("未授予：保持原生行为（交给引擎自己拒绝），不上报", () => {
    const r = run("denied");
    vm.runInContext("new Notification('x')", r.ctx);
    expect(r.constructed()).toBe(1);
    expect(r.sent).toHaveLength(0);
  });

  it("同一文档装两次是空操作；标题 / 正文在页面侧就被截断", () => {
    const r = run("granted");
    vm.runInContext(NOTIFICATION_STUB_SOURCE, r.ctx);
    vm.runInContext(`new Notification('${"T".repeat(1000)}', { body: '${"B".repeat(1000)}' })`, r.ctx);
    expect(r.sent).toHaveLength(1);
    const d = JSON.parse(r.sent[0]) as { t: string; b: string };
    expect(d.t.length).toBeLessThanOrEqual(200);
    expect(d.b.length).toBeLessThanOrEqual(300);
  });

  it("没有 binding / 没有 Notification 时静默不装（不抛错）", () => {
    const ctx = vm.createContext({ EventTarget, Event, setTimeout });
    expect(() => vm.runInContext(NOTIFICATION_STUB_SOURCE, ctx)).not.toThrow();
  });
});
