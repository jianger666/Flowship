/**
 * 同事的真实场景（第二十一轮）：内置浏览器里「页面要麦克风，却弹不出权限提示」；第二十二轮评审（R22-1…R22-5）之后的形态。
 * 钉的是 electron-app/browser/permission-gate.mjs 的几条规则（见该文件头）：
 *  A. 页面的 `permissions.query()` 在「会弹提示」时读到 prompt、不是 denied——**靠页内小桩（MEDIA_QUERY_STUB_SOURCE）改页面看到的值，检查处理器绝不能因为「会弹提示」回 true**：
 *     WebRTC 的 ICE 收集走同一条媒体检查，回 true = 页面不经授权拿到真实内网 / 公网 IP（R22-1，真 Electron 实测；第二十一轮的「query 形状回 true」就是这么泄露的）。
 *  B. 被顶层委托了的跨源 iframe：核对 `allowsFeature` 通过才按顶层站点弹提示 / 放行；没委托 / 核对不出来拒绝（含兄弟框架核对、核对途中页面导航）。
 *  C. 自动拒绝可见：活动记录（限速）+ 「最近被自动拒绝」清单（按 partition 分开）。
 *  D. 系统层（macOS 隐私 / Windows 全局开关）挡住时，提示 detail 多带 systemDenied / systemRestricted / platform。
 *  E. 提示被取消（导航 / 关标签 / 会话销毁）不是用户的拒绝：不进 30 秒冷却（R22-2）；提示超时也不进冷却（R23-4）；同一标签同站点连续被取消 ≥3 次才进 10 秒短冷却（R23-1）。
 *  F. 证据范围：这些规则依赖的 Chromium 行为只在 `VERIFIED_ELECTRON_VERSION` 那个版本的真 Electron 上验证过（R23-8，见文件末尾的版本钉子）。
 * 真 BrowserSession（真 PromptHub / 真活动日志）+ 假 tab（tests/helpers/browser-e2-p1-fakes.ts）；真 Electron 的行为（含 ICE 候选）见 scripts/browser-e2e/r21-mic-prompt.cjs。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLOCK_REASON_TEXT,
  CANCEL_COOLDOWN_MS,
  CANCEL_STREAK_LIMIT,
  CANCEL_STREAK_WINDOW_MS,
  CDP_HEAL_MIN_INTERVAL_MS,
  FRAME_DELEGATION_EVAL_TIMEOUT_MS,
  FRAME_DELEGATION_POLL_MS,
  FRAME_DELEGATION_TOTAL_MS,
  MAX_RECENT_BLOCKED,
  MEDIA_QUERY_STUB_SOURCE,
  PERMISSION_COOLDOWN_MS,
  PERMISSION_PROMPT_TIMEOUT_MS,
  createPermissionGate,
  delegationProbeSource,
  getPermissionState,
  putBounded,
} from "../electron-app/browser/permission-gate.mjs";

import { APP_ORIGIN, firstPrompt, flush, makeEnv, type P1Config } from "./helpers/browser-e2-p1-fakes";

const A = "https://a.example.com";
const B = "https://b.example.com";
const C = "https://c.example.com";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Rows = Array<{ key: string; value: unknown }>;

const setup = async (cfg: Partial<P1Config> = {}, url = `${A}/page`, gateExtra: Record<string, unknown> = {}) => {
  const env = makeEnv(cfg);
  const gate = createPermissionGate({
    findOwner: env.findOwner,
    getConfig: () => env.config,
    isAppUrl: env.isAppUrl,
    log: (m: string) => env.logs.push(m),
    ...gateExtra,
  });
  const tab = await env.openTab(url);
  gate.bindTab(tab);
  const request = (permission: string, details: Record<string, unknown> = { requestingUrl: `${A}/page`, isMainFrame: true }) => {
    const cb = vi.fn();
    gate.handleRequest(tab.wc, permission, cb, details);
    return cb;
  };
  /** 请求：顶层页面自己要某类媒体 */
  const topRequest = (mediaTypes: string[]) => request("media", { requestingUrl: `${A}/page`, isMainFrame: true, mediaTypes });
  /** 请求：来自 origin 的子框架 */
  const frameRequest = (frameOrigin: string, mediaTypes: string[] = ["audio"]) => request("media", { requestingUrl: `${frameOrigin}/f`, isMainFrame: false, mediaTypes });
  const check = (permission: string, origin: string, details: Record<string, unknown>) => gate.handleCheck(tab.wc, permission, origin, details);
  /** `navigator.permissions.query()` 形状（实测 Electron 42：带 embeddingOrigin、不带 securityOrigin；WebRTC 的 ICE 收集检查与它同形） */
  const query = (mediaType: string, origin = A, embedding = A, isMainFrame = true) =>
    check("media", origin, { embeddingOrigin: embedding, isMainFrame, mediaType, requestingUrl: `${origin}/` });
  /** `enumerateDevices()` 取设备名的检查形状（带 securityOrigin、不带 embeddingOrigin） */
  const enumerate = (mediaType: string, origin = A, isMainFrame = true) => check("media", origin, { securityOrigin: origin, isMainFrame, mediaType, requestingUrl: `${origin}/` });
  /** 让 tab 的各 frame 隔离世界里「现有这些框架」 */
  const frames = (rows: Array<{ href: string; ok: boolean }>) => {
    tab.evalInFrames = async (expression: string, opts?: { timeoutMs?: number; totalMs?: number }) => {
      tab.evalInFramesCalls.push(expression);
      tab.evalInFramesOpts.push(opts);
      return rows.map((value, i): { key: string; value: unknown } => ({ key: `main:f${i}`, value }));
    };
    // 与 evalInFrames 同一批框架的清单（真 tab 的 frameInventory = 各会话 Page.getFrameTree 合并）：权限闸靠它确认「同 origin 的框架都回应了」，缺它按核对不出来处理（R23-5）
    tab.frameInventory = async (opts?: { timeoutMs?: number }) => {
      tab.frameInventoryOpts.push(opts);
      return rows.map((value, i) => ({ id: `f${i}`, url: value.href }));
    };
  };
  const blocked = () => getPermissionState(env.session).recentBlocked as Array<Record<string, unknown>>;
  const activity = () => (env.session.activityLog.list() as Array<{ kind: string; summary: string }>).filter((e) => e.kind === "permission").map((e) => e.summary);
  return { ...env, gate, tab, request, topRequest, frameRequest, check, query, enumerate, frames, blocked, activity };
};

const MEDIA_TYPES = ["audio", "video", "unknown"] as const;

describe("A. 检查处理器：media 只在授予后回 true，「会弹提示」绝不回 true（R22-1：WebRTC 的 ICE 收集走同一条检查，回 true = 泄露真实 IP）", () => {
  it("没授予、没被拒绝（= 会弹提示）：所有形状 × 所有媒体类型 × 顶层 / 同源子框架 / 跨源子框架 / 嵌套的 media 检查一律 false；检查本身不产生提示、授予、记录", async () => {
    const s = await setup();
    for (const mt of MEDIA_TYPES) {
      expect(s.query(mt), `query ${mt}`).toBe(false); // permissions.query 与 ICE 收集的检查同形
      expect(s.enumerate(mt), `enumerate ${mt}`).toBe(false);
      expect(s.check("media", A, { isMainFrame: true, mediaType: mt }), `旧形状 ${mt}`).toBe(false);
      expect(s.check("media", A, { embeddingOrigin: A, securityOrigin: A, isMainFrame: true, mediaType: mt }), `两个字段都有 ${mt}`).toBe(false);
      expect(s.query(mt, A, A, false), `同源子框架 ${mt}`).toBe(false);
      expect(s.query(mt, B, A, false), `跨源子框架 ${mt}`).toBe(false);
      expect(s.query(mt, A, B, false), `夹在别的站点里的同源框架 ${mt}`).toBe(false);
      expect(s.query(mt, C, B, false), `嵌套 ${mt}`).toBe(false);
    }
    expect(s.session.prompts.size()).toBe(0);
    expect(getPermissionState(s.session).grants.size).toBe(0);
    expect(s.blocked()).toHaveLength(0);
    expect(s.activity()).toEqual([]);
  });

  it("对照（防空转）：授予之后同样的形状回 true——证明上面的 false 来自「没授予」而不是处理器一律 false；摄像头没被连带，unknown 要两个都授予过", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "microphone", "user");
    expect(s.query("audio")).toBe(true);
    expect(s.enumerate("audio")).toBe(true);
    expect(s.check("media", A, { isMainFrame: true, mediaType: "audio" })).toBe(true);
    expect(s.check("media", A, { embeddingOrigin: A, securityOrigin: A, isMainFrame: true, mediaType: "audio" })).toBe(true);
    expect(s.query("video")).toBe(false);
    expect(s.query("unknown")).toBe(false);
    getPermissionState(s.session).grants.allow(A, "camera", "user");
    expect(s.query("video")).toBe(true);
    expect(s.query("unknown")).toBe(true);
    // 授予按 origin：别的站点仍然 false
    expect(s.query("audio", B, B)).toBe(false);
  });

  it("用户拒绝 / 提示超时（冷却期内）/ 显式拒绝记录：query 形状同样 false；AI 的授予在开关关着时不生效、打开后才认", async () => {
    const s = await setup();
    const cb = s.topRequest(["audio"]);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.query("audio")).toBe(false);

    const t = await setup();
    getPermissionState(t.session).grants.deny(A, "camera", "ai");
    expect(t.query("video")).toBe(false);
    expect(t.query("audio")).toBe(false);

    const u = await setup({ pagePermissions: false });
    getPermissionState(u.session).grants.allow(A, "microphone", "ai");
    expect(u.query("audio")).toBe(false);
    expect(u.enumerate("audio")).toBe(false);
    u.config.pagePermissions = true;
    expect(u.query("audio")).toBe(true);
    expect(u.enumerate("audio")).toBe(true);
  });

  it("Flowship 自己的页面 / 不透明来源 / 没找到 tab → false（授予了也不给）", async () => {
    const app = await setup({}, `${APP_ORIGIN}/x`);
    getPermissionState(app.session).grants.allow(APP_ORIGIN, "microphone", "user");
    expect(app.query("audio", APP_ORIGIN, APP_ORIGIN)).toBe(false);
    const blank = await setup({}, "about:blank");
    expect(blank.check("media", "", { embeddingOrigin: "about:blank", isMainFrame: true, mediaType: "audio", requestingUrl: "" })).toBe(false);
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "microphone", "user");
    expect(s.query("audio")).toBe(true); // 对照：同一个 s 上授予的是真的
    expect(s.gate.handleCheck({}, "media", A, { embeddingOrigin: A, isMainFrame: true, mediaType: "audio" })).toBe(false);
    expect(s.gate.handleCheck(null, "media", A, { embeddingOrigin: A, isMainFrame: true, mediaType: "audio" })).toBe(false);
  });

  it("非 media 的权限没有任何放宽：定位 / 通知 / 剪贴板读等 query 形状的检查，没授予回 false，授予后（通知要代理装好）才回 true", async () => {
    const s = await setup();
    const details = { embeddingOrigin: A, isMainFrame: true, requestingUrl: `${A}/` };
    for (const permission of ["geolocation", "notifications", "clipboard-read", "midi", "sensors"]) {
      expect(s.check(permission, A, details), permission).toBe(false);
    }
    getPermissionState(s.session).grants.allow(A, "geolocation", "user");
    expect(s.check("geolocation", A, details)).toBe(true);
  });
});

/**
 * vm 里的「页面」：假的 Permissions.prototype.query（每次调用返回一个**新的**假 PermissionStatus；没有权限变化通知——旧对象不会自己更新，页面再对同一个权限 query() 之后旧对象才跟着变，与真 Electron 42.4.0 实测一致，见桩源码注释）+ 假 document.permissionsPolicy
 * + 假 window.isSecureContext / location.protocol；install() 跑一遍桩源码。
 *
 * 假 PermissionStatus 是**带品牌检查的类**（第二十三轮 R23-2）：name / state / onchange 的访问器和 addEventListener 等方法都在原型上，`this` 不是真实例（比如是 Proxy）就抛 Illegal invocation——
 * 与真 Chromium 一致。此前它是个普通对象，删掉桩里的 `set` 陷阱 / `bind(target)` 断言照样通过，「真对象会抛」只是注释里的一句话；现在删掉任何一个都会变红（见用例 + 变异）。
 */
const stubWorld = (
  cfg: { states?: Record<string, string>; allows?: (feature: string) => unknown; policyKey?: "permissionsPolicy" | "featurePolicy" | null; secure?: unknown; protocol?: string | null } = {},
) => {
  type Rec = Record<string, unknown>;
  const states: Record<string, string> = { microphone: "denied", camera: "denied", geolocation: "denied", notifications: "denied", ...cfg.states };
  type Slot = { name: string; state: string; onchange: unknown; listenerThis: unknown[] };
  const slots = new WeakMap<object, Slot>();
  const slotOf = (self: unknown): Slot => {
    const s = typeof self === "object" && self !== null ? slots.get(self) : undefined;
    if (!s) throw new TypeError("Illegal invocation");
    return s;
  };
  class FakePermissionStatus {
    constructor(name: string, state: string) {
      slots.set(this, { name, state, onchange: null, listenerThis: [] });
    }
    get name() {
      return slotOf(this).name;
    }
    get state() {
      return slotOf(this).state;
    }
    get onchange() {
      return slotOf(this).onchange;
    }
    set onchange(v: unknown) {
      slotOf(this).onchange = v;
    }
    addEventListener() {
      slotOf(this).listenerThis.push(this);
    }
    removeEventListener() {
      slotOf(this);
    }
    dispatchEvent() {
      slotOf(this);
      return true;
    }
  }
  /** 原生 query 最近一次按名字返回的真对象（桩「原样返回原对象」的断言用） */
  const raws = new Map<string, FakePermissionStatus>();
  const rawStatus = (name: string): FakePermissionStatus => {
    const have = raws.get(name);
    if (!have) throw new Error(`还没有对 ${name} 调过原生 query`);
    return have;
  };
  const nativeCalls: Array<{ self: unknown; arg: unknown }> = [];
  /** 每个权限名发出过的全部真对象：真 Electron 42.4.0 上页面再 query() 同一个权限时，旧对象的 state 会跟着刷新（没有事件），平时不会自己更新 */
  const issued = new Map<string, FakePermissionStatus[]>();
  class Permissions {
    query(this: unknown, desc: { name?: unknown } | undefined) {
      nativeCalls.push({ self: this, arg: desc });
      if (desc === undefined || desc === null || typeof desc !== "object") return Promise.reject(new TypeError("descriptor 必须是对象"));
      const name = String(desc.name);
      const current = states[name] ?? "prompt";
      const raw = new FakePermissionStatus(name, current);
      for (const old of issued.get(name) ?? []) slotOf(old).state = current;
      issued.set(name, [...(issued.get(name) ?? []), raw]);
      raws.set(name, raw);
      return Promise.resolve(raw);
    }
  }
  const location = cfg.protocol === null ? undefined : { protocol: cfg.protocol ?? "https:" };
  const window: Rec = { Permissions, isSecureContext: cfg.secure === undefined ? true : cfg.secure, ...(location ? { location } : {}) };
  const policyKey = cfg.policyKey === undefined ? "permissionsPolicy" : cfg.policyKey;
  const document: Rec = policyKey ? { [policyKey]: { allowsFeature: cfg.allows ?? (() => true) } } : {};
  const ctx = vm.createContext({ window, document });
  const navigatorPermissions = { tag: "navigator.permissions" };
  const proto = Permissions.prototype as unknown as { query: ((desc?: unknown) => Promise<Rec>) & { __fsMediaQueryStub?: boolean } };
  return {
    states,
    rawStatus,
    slotOf,
    nativeCalls,
    navigatorPermissions,
    proto,
    original: proto.query,
    install: () => vm.runInContext(MEDIA_QUERY_STUB_SOURCE, ctx),
    query: (name: unknown) => proto.query.call(navigatorPermissions, { name }) as Promise<Rec>,
    ctx,
    document,
    window,
  };
};

describe("A. 页内桩 MEDIA_QUERY_STUB_SOURCE（vm 里模拟页面）：麦克风 / 摄像头 denied → 页面读到 prompt", () => {
  it("denied 且 Permissions-Policy 允许 → state 读到 prompt（麦克风 / 摄像头各自）；浏览器自己的状态不动；其余成员落在原对象上", async () => {
    const w = stubWorld();
    w.install();
    const mic = await w.query("microphone");
    expect(mic.state).toBe("prompt");
    expect((await w.query("camera")).state).toBe("prompt");
    expect(w.rawStatus("microphone").state).toBe("denied");
    expect(mic.name).toBe("microphone");
    // 对照（防空转）：原对象是品牌检查的——直接拿代理去调原型上的访问器必须抛（证明下面的「不抛」来自桩的绑定 / 穿透，而不是假对象太宽松）
    const rawProtoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w.rawStatus("microphone")), "onchange");
    expect(() => rawProtoDesc?.set?.call(mic, () => {})).toThrow(TypeError);
    expect(() => rawProtoDesc?.get?.call(mic)).toThrow(TypeError);
    // 写穿透（`status.onchange = fn` 是最常见写法：真对象的 setter 在原型上，this 是 Proxy 就会抛 Illegal invocation）、事件方法绑回原对象
    const handler = () => {};
    expect(() => {
      mic.onchange = handler;
    }).not.toThrow();
    expect(w.slotOf(w.rawStatus("microphone")).onchange).toBe(handler);
    expect(mic.onchange).toBe(handler); // 读回来也是（R23-2：真 Electron 里 r21 同样断言赋值后读回）
    expect(() => (mic.addEventListener as (t: string, f: () => void) => void)("change", handler)).not.toThrow();
    expect(w.slotOf(w.rawStatus("microphone")).listenerThis[0]).toBe(w.rawStatus("microphone"));
    expect(() => (mic.removeEventListener as (t: string, f: () => void) => void)("change", handler)).not.toThrow();
    expect(() => (mic.dispatchEvent as (e: unknown) => boolean)({})).not.toThrow();
  });

  it("没有权限变化通知（Electron 42.4.0 真机实测）：授予后旧对象不会自己更新；页面再 query() 一次之后旧对象也读到新值（都没有事件）——桩现读 target.state、不缓存，granted 不改", async () => {
    const w = stubWorld();
    w.install();
    const mic = await w.query("microphone");
    expect(mic.state).toBe("prompt");
    w.states.microphone = "granted"; // 用户在浏览器里允许了
    expect(mic.state).toBe("prompt"); // 没有变化通知：同一个对象不会自己更新
    const fresh = await w.query("microphone");
    expect(fresh.state).toBe("granted");
    expect(fresh).toBe(w.rawStatus("microphone")); // granted 原样返回原对象，桩不包
    expect(mic.state).toBe("granted"); // 页面再 query 之后，旧对象也读到新值（桩的 Proxy 每次读 target.state）
  });

  it("只在 denied 时改：granted / prompt 原样返回原对象；认不出的状态也不碰", async () => {
    const w = stubWorld({ states: { microphone: "granted", camera: "prompt" } });
    w.install();
    expect(await w.query("microphone")).toBe(w.rawStatus("microphone"));
    expect(await w.query("camera")).toBe(w.rawStatus("camera"));
    w.states.microphone = "weird";
    expect(await w.query("microphone")).toBe(w.rawStatus("microphone"));
  });

  it("Permissions-Policy 不允许（没被顶层委托的 iframe）→ 仍是 denied、原对象；allowsFeature 只认严格的 true；没有 permissionsPolicy 就退回 featurePolicy；都没有 / 抛错 → 原对象", async () => {
    const no = stubWorld({ allows: () => false });
    no.install();
    expect(await no.query("microphone")).toBe(no.rawStatus("microphone"));
    expect((await no.query("microphone")).state).toBe("denied");

    const truthy = stubWorld({ allows: () => "yes" });
    truthy.install();
    expect((await truthy.query("microphone")).state).toBe("denied");

    const old = stubWorld({ policyKey: "featurePolicy" });
    old.install();
    expect((await old.query("microphone")).state).toBe("prompt");

    const none = stubWorld({ policyKey: null });
    none.install();
    expect(await none.query("microphone")).toBe(none.rawStatus("microphone"));

    const boom = stubWorld({
      allows: () => {
        throw new Error("policy 坏了");
      },
    });
    boom.install();
    expect(await boom.query("microphone")).toBe(boom.rawStatus("microphone"));
  });

  it("非安全上下文 / 非 http(s) 协议的文档（R23-2）：denied 才是如实的——不改成 prompt（getUserMedia 在那里本来不可用 / 来源会被闸门判成不透明）；对照：https / http 安全上下文照改", async () => {
    // isSecureContext 只认严格的 true（假值 / 其它真值 / 缺失都不改）
    for (const secure of [false, 0, null, "true", 1]) {
      const w = stubWorld({ secure });
      w.install();
      expect((await w.query("microphone")).state, `isSecureContext=${String(secure)}`).toBe("denied");
    }
    const missingSecure = stubWorld();
    delete missingSecure.window.isSecureContext;
    missingSecure.install();
    expect((await missingSecure.query("microphone")).state).toBe("denied");
    // 协议：about: / file: / data: / blob: / 缺 location 都不改
    for (const protocol of ["about:", "file:", "data:", "blob:", "chrome-extension:", ""]) {
      const w = stubWorld({ protocol });
      w.install();
      expect((await w.query("microphone")).state, `protocol=${protocol}`).toBe("denied");
      expect((await w.query("camera")).state, `protocol=${protocol}`).toBe("denied");
    }
    const noLocation = stubWorld({ protocol: null });
    noLocation.install();
    expect((await noLocation.query("microphone")).state).toBe("denied");
    // 对照（防空转）：https 与 http（localhost 等安全上下文）照改
    for (const protocol of ["https:", "http:"]) {
      const w = stubWorld({ protocol });
      w.install();
      expect((await w.query("microphone")).state, `protocol=${protocol}`).toBe("prompt");
    }
  });

  it("只处理 microphone / camera：定位 / 通知 / 剪贴板等 denied 一律原样（不能让页面误以为这些也会弹提示）；下游描述符奇怪时原样透传、不抛", async () => {
    const w = stubWorld();
    w.install();
    for (const name of ["geolocation", "notifications", "clipboard-read", "midi"]) {
      expect(await w.query(name), name).toBe(w.rawStatus(name));
    }
    // 缺参数：原生行为（reject）原样透传
    await expect(w.proto.query.call(w.navigatorPermissions)).rejects.toThrow(TypeError);
    // 名字转字符串就抛：返回的就是原生那个 promise，不抛、不改写
    const nativePromise = Promise.resolve({ state: "denied" });
    const ctx = vm.createContext({
      window: {
        isSecureContext: true,
        location: { protocol: "https:" },
        Permissions: class {
          query() {
            return nativePromise;
          }
        },
      },
      document: { permissionsPolicy: { allowsFeature: () => true } },
    });
    vm.runInContext(MEDIA_QUERY_STUB_SOURCE, ctx);
    const W = (ctx as { window: { Permissions: { prototype: { query: (d: unknown) => unknown } } } }).window;
    expect(W.Permissions.prototype.query({ name: { toString: () => { throw new Error("x"); } } })).toBe(nativePromise);
  });

  it("幂等：重复注入只包一层（query 函数不变、带标记且不可枚举）；包装后函数名 / 长度与原生一致（是普通函数，不是 Proxy）；没有 Permissions / document 时不抛", async () => {
    const w = stubWorld();
    w.install();
    const first = w.proto.query;
    w.install();
    w.install();
    expect(w.proto.query).toBe(first);
    expect(first).not.toBe(w.original);
    expect(first.__fsMediaQueryStub).toBe(true);
    expect(Object.keys(first)).not.toContain("__fsMediaQueryStub");
    expect(first.name).toBe(w.original.name);
    expect(first.length).toBe(w.original.length);
    expect((await w.query("microphone")).state).toBe("prompt");
    expect(w.nativeCalls.every((c) => c.self === w.navigatorPermissions)).toBe(true); // this 原样传给原生
    // 页面环境残缺：什么都不做
    expect(() => vm.runInNewContext(MEDIA_QUERY_STUB_SOURCE, { window: {} })).not.toThrow();
    expect(() => vm.runInNewContext(MEDIA_QUERY_STUB_SOURCE, {})).not.toThrow();
    // document 在调用时不可用：返回原对象，不抛
    const late = stubWorld();
    late.install();
    (late.ctx as { document: unknown }).document = undefined;
    expect(await late.query("microphone")).toBe(late.rawStatus("microphone"));
  });
});

describe("A. 页内桩的安装：bindTab 把桩注册成「早钩子」，每个 CDP 会话（主会话 / OOPIF 子会话）各装一份（R23-3）", () => {
  const addAndEvalOf = (s: Awaited<ReturnType<typeof setup>>) => s.tab.sent.map((x) => [x.method, x.sessionId]);
  const stubHookOf = (s: Awaited<ReturnType<typeof setup>>) => [...s.tab.earlySessionHooks][0];

  it("注册的是早钩子（不是普通会话钩子）：与域启用并行发、不等 setup 末尾；对主会话 / 子会话各装：新文档脚本（源码 = MEDIA_QUERY_STUB_SOURCE）+ 当前文档立即执行，都发到对应的 sessionId", async () => {
    const s = await setup();
    s.tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "stub-1" } : {});
    expect(s.tab.earlySessionHooks.size).toBe(1);
    expect(s.tab.sessionHooks.size).toBe(0);
    const hook = stubHookOf(s);
    await hook(null);
    await hook("child-1");
    expect(addAndEvalOf(s)).toEqual([
      ["Page.addScriptToEvaluateOnNewDocument", null],
      ["Runtime.evaluate", null],
      ["Page.addScriptToEvaluateOnNewDocument", "child-1"],
      ["Runtime.evaluate", "child-1"],
    ]);
    expect(s.tab.sent[0].params).toEqual({ source: MEDIA_QUERY_STUB_SOURCE });
    expect(s.tab.sent[1].params).toEqual({ expression: MEDIA_QUERY_STUB_SOURCE, silent: true });
    // 注册在页面主世界：不带 worldName / contextId（隔离世界里的 Permissions 不是页面看到的那个）
    for (const x of s.tab.sent) {
      expect(x.params).not.toHaveProperty("worldName");
      expect(x.params).not.toHaveProperty("contextId");
    }
  });

  it("没有早钩子 API 的 tab（旧版 / 精简替身）退回普通会话钩子：桩照装", async () => {
    const env = makeEnv();
    const gate = createPermissionGate({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
    const tab = await env.openTab(`${A}/page`);
    (tab as unknown as { addEarlySessionHook?: unknown }).addEarlySessionHook = undefined;
    gate.bindTab(tab);
    expect(tab.earlySessionHooks.size).toBe(0);
    expect(tab.sessionHooks.size).toBe(1);
    tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "fallback-1" } : {});
    await [...tab.sessionHooks][0](null);
    expect(tab.sent.map((x) => x.method)).toEqual(["Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
  });

  it("同一会话重复安装（debugger 重连 / 会话重新初始化）：先摘掉上一次注册的新文档脚本再注册，不叠多份；不同会话各记各的", async () => {
    const s = await setup();
    let n = 0;
    s.tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: `stub-${++n}` } : {});
    s.tab.attachChild("child-1");
    const hook = stubHookOf(s);
    await hook(null);
    await hook("child-1");
    s.tab.sent.length = 0;
    await hook(null);
    expect(addAndEvalOf(s)).toEqual([
      ["Page.removeScriptToEvaluateOnNewDocument", null],
      ["Page.addScriptToEvaluateOnNewDocument", null],
      ["Runtime.evaluate", null],
    ]);
    expect(s.tab.sent[0].params).toEqual({ identifier: "stub-1" }); // 摘的是主会话上一次那个，不是子会话的 stub-2
    s.tab.sent.length = 0;
    await hook("child-1");
    expect(s.tab.sent[0].params).toEqual({ identifier: "stub-2" });
  });

  it("装不上（CDP 命令失败）：钩子不抛、写日志 + 一条限速的活动记录，并进 permissionGate.queryStubProblems（list 的「桩状态」）；摘旧脚本失败不影响装新的；之后装成功就清掉", async () => {
    const s = await setup();
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") throw new Error("cdp gone");
      return {};
    };
    s.tab.attachChild("child-1");
    s.tab.attachChild("child-2");
    const hook = stubHookOf(s);
    expect(s.gate.queryStubProblems(s.tab)).toEqual([]);
    await expect(hook(null)).resolves.toBeUndefined();
    expect(s.logs.join("\n")).toContain("页内权限查询桩装不上");
    expect(s.gate.queryStubProblems(s.tab)).toEqual([{ scope: "main", message: "cdp gone" }]);
    // 活动记录：Flowship 自己的盲区得让用户 / AI 看得见（同一类每 60 秒一条）
    expect(s.activity().filter((x) => x.includes("页内权限状态桩没装上"))).toHaveLength(1);
    expect(s.activity().join("\n")).toContain("页面读麦克风 / 摄像头权限状态时可能读到 denied");
    await hook("child-1");
    await hook("child-2");
    expect(s.gate.queryStubProblems(s.tab).map((p) => p.scope)).toEqual(["main", "frame", "frame"]);
    expect(s.activity().filter((x) => x.includes("页内权限状态桩没装上"))).toHaveLength(1); // 限速：窗口内不重复写
    // 之后装成功（debugger 重连后重放）：该会话的失败记录清掉，别的会话的仍在
    s.tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "ok" } : {});
    await hook(null);
    expect(s.gate.queryStubProblems(s.tab).map((p) => p.scope)).toEqual(["frame", "frame"]);

    const t = await setup();
    let first = true;
    t.tab.sendImpl = async (method) => {
      if (method === "Page.removeScriptToEvaluateOnNewDocument") throw new Error("already gone");
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: first ? "x1" : "x2" };
      return {};
    };
    const hook2 = stubHookOf(t);
    await hook2(null);
    first = false;
    await hook2(null);
    expect(t.logs.join("\n")).not.toContain("页内权限查询桩装不上");
    expect(t.gate.queryStubProblems(t.tab)).toEqual([]);
    expect(t.tab.sent.filter((x) => x.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2);
  });

  it("装桩失败的会话最多记 8 个（子会话很多又都失败时不无限增长）；已记的会话再失败只刷新、不占新名额；装成功后腾出名额，新的失败又能记进来；满了之后主页面的失败照样准入（挤掉最老的子框架记录，P3-1）", async () => {
    const s = await setup();
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") throw new Error("cdp gone");
      return {};
    };
    for (let i = 0; i < 20; i++) s.tab.attachChild(`child-${i}`);
    s.tab.attachChild("child-99");
    const hook = stubHookOf(s);
    for (let i = 0; i < 20; i++) await hook(`child-${i}`);
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(8);
    await hook("child-0"); // 已记的会话再失败：不占新名额
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(8);
    s.tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "ok" } : {});
    await hook("child-0"); // 装成功 → 腾出一个名额
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(7);
    s.tab.sendImpl = async () => {
      throw new Error("cdp gone again");
    };
    await hook("child-99");
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(8);
    expect(s.gate.queryStubProblems(s.tab).some((p) => p.message === "cdp gone again")).toBe(true);
    // 8 个名额全被子框架占着：又一个子框架失败仍然丢弃；但主页面的失败必须记得上（此前一律丢弃，连主页面的真失败也看不到）
    await hook("child-5"); // 已记的：只刷新
    expect(s.gate.queryStubProblems(s.tab).filter((p) => p.scope === "main")).toHaveLength(0);
    await hook(null);
    const afterMain = s.gate.queryStubProblems(s.tab);
    expect(afterMain).toHaveLength(8);
    expect(afterMain.filter((p) => p.scope === "main")).toEqual([{ scope: "main", message: "cdp gone again" }]);
    expect(afterMain.filter((p) => p.scope === "frame")).toHaveLength(7);
    // 主页面已经占着名额时再失败只刷新，不再挤别的
    await hook(null);
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(8);
  });

  it("装桩途中子会话已经 detach（命令随之失败 / 命令成功但返回时会话已没了）：失败只写日志，不进清单、不写活动记录；脚本编号也不登记——detach 的清理先跑完，之后不会又写回清不掉的幽灵记录（P3-1）", async () => {
    const s = await setup();
    s.tab.attachChild("child-1");
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        s.tab.emitCdp("Target.detachedFromTarget", { sessionId: "child-1" }, null); // 命令在飞时会话 detach：清理先跑完
        throw new Error("Session with given id not found");
      }
      return {};
    };
    await expect(stubHookOf(s)("child-1")).resolves.toBeUndefined();
    expect(s.logs.join("\n")).toContain("页内权限查询桩装不上"); // 日志仍写（排查用）
    expect(s.gate.queryStubProblems(s.tab)).toEqual([]);
    expect(s.activity().join("\n")).not.toContain("页内权限状态桩没装上");

    // 命令成功、但返回时会话已经没了：脚本编号不登记
    const t = await setup();
    t.tab.attachChild("child-2");
    let detachedOnce = false;
    t.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        if (!detachedOnce) {
          detachedOnce = true; // 只在 child-2 的这一次 detach（之后主会话再装时不能再替它清一遍，否则分不出是「没登记」还是「被后面的清理顺手清掉了」）
          t.tab.emitCdp("Target.detachedFromTarget", { sessionId: "child-2" }, null);
        }
        return { identifier: "late" };
      }
      return {};
    };
    const ts = t.tab.getExt("permissions", () => ({})) as { queryStubScripts: Map<string, string> };
    await stubHookOf(t)("child-2");
    expect([...ts.queryStubScripts.keys()], "子会话已经没了：新文档脚本编号不登记（不然成了一条永远清不掉的幽灵记录）").toEqual([]);
    await stubHookOf(t)(null); // 主会话照常登记
    expect([...ts.queryStubScripts.keys()]).toEqual(["main"]);
  });

  it("自愈重连清了子会话表（`children.clear()` 不产生 detach 事件）：旧子会话的失败记录 / 脚本编号在下一次读 list 时被清掉，不会把早已不存在的框架报成「桩装不上」（P3-1）", async () => {
    const s = await setup();
    s.tab.attachChild("child-1");
    s.tab.attachChild("child-2");
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") throw new Error("cdp gone");
      return {};
    };
    const hook = stubHookOf(s);
    await hook(null);
    await hook("child-1");
    await hook("child-2");
    expect(s.gate.queryStubProblems(s.tab).map((p) => p.scope)).toEqual(["main", "frame", "frame"]);
    s.tab.children.clear(); // tab.ensureCdp 自愈的做法：直接清表、没有 detach 事件
    expect(s.gate.queryStubProblems(s.tab)).toEqual([{ scope: "main", message: "cdp gone" }]); // 主页面的仍在，两个旧子框架的没了

    // 脚本编号同理（一次成功安装后子会话被清、再读 list 时一起修剪）
    const t = await setup();
    t.tab.attachChild("child-9");
    t.tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "ok" } : {});
    await stubHookOf(t)("child-9");
    const ts = t.tab.getExt("permissions", () => ({})) as { queryStubScripts: Map<string, string> };
    expect([...ts.queryStubScripts.keys()]).toEqual(["child-9"]);
    t.tab.children.clear();
    t.gate.queryStubProblems(t.tab);
    expect([...ts.queryStubScripts.keys()]).toEqual([]);
  });

  /** 桩状态表的内部键（读 `queryStubProblems()` 自己会修剪，会盖住「写入前 / 钩子开头有没有修剪」，所以直接看 tab 状态） */
  const stubStateOf = (s: Awaited<ReturnType<typeof setup>>) => {
    const ts = s.tab.getExt("permissions", () => ({})) as { queryStubProblems: Map<string, unknown>; queryStubScripts: Map<string, string> };
    return { problems: () => [...ts.queryStubProblems.keys()], scripts: () => [...ts.queryStubScripts.keys()] };
  };
  const failingSend = (s: Awaited<ReturnType<typeof setup>>) => {
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") throw new Error("cdp gone");
      return {};
    };
  };

  it("满 8 个之后主页面的失败挤掉的是**最老**的子框架记录（按登记先后），其余原样保留；这时子框架的新失败仍丢弃（P3-1；第二十五轮评审测试 D）", async () => {
    const s = await setup();
    failingSend(s);
    for (let i = 0; i < 9; i++) s.tab.attachChild(`child-${i}`);
    const hook = stubHookOf(s);
    for (let i = 0; i < 8; i++) await hook(`child-${i}`); // 占满 8 个名额，登记顺序 child-0 … child-7
    const st = stubStateOf(s);
    const full = Array.from({ length: 8 }, (_, i) => `child-${i}`);
    expect(st.problems()).toEqual(full);
    await hook("child-8"); // 第 9 个子框架：丢弃
    expect(st.problems()).toEqual(full);
    await hook(null); // 主页面：准入，挤掉最老的 child-0
    expect(st.problems()).toEqual([...full.slice(1), "main"]);
    await hook(null); // 主页面再失败：只刷新、不再挤别人
    expect(st.problems()).toEqual([...full.slice(1), "main"]);
  });

  it("写入前先修剪（P3-1 ①）：失败发生时名额里全是已经不存在的旧子会话（命令在飞期间发生了自愈重连：清了表、没有 detach 事件），新子框架的失败仍记得进来——不靠读 list 时才修剪（评审测试 D）", async () => {
    const s = await setup();
    failingSend(s);
    for (let i = 0; i < 8; i++) s.tab.attachChild(`child-${i}`);
    const hook = stubHookOf(s);
    for (let i = 0; i < 8; i++) await hook(`child-${i}`);
    const st = stubStateOf(s);
    expect(st.problems()).toHaveLength(8);
    // 新子框架的安装命令在飞时发生了自愈重连：旧的 8 个子会话没了（表被清、没有 detach 事件），新子框架 child-new 已经挂上；随后这条命令失败
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        s.tab.children.clear();
        s.tab.attachChild("child-new");
        throw new Error("cdp gone again");
      }
      return {};
    };
    await hook("child-new"); // 钩子开头那次修剪时旧会话还「在」；写入前的修剪是唯一能清掉它们的一次
    expect(st.problems()).toEqual(["child-new"]);
  });

  it("会话表读不出来（cdpSessionIds 抛错 / 这个 tab 没有该接口）：fail-open——失败照记、不修剪任何已有记录（宁可多记，不把真失败吞掉；评审测试 D）", async () => {
    const s = await setup();
    failingSend(s);
    s.tab.attachChild("child-1");
    const hook = stubHookOf(s);
    await hook("child-1");
    await hook(null);
    const st = stubStateOf(s);
    expect(st.problems()).toEqual(["child-1", "main"]);
    s.tab.children.clear(); // child-1 其实已经没了
    const probe = s.tab as unknown as { cdpSessionIds?: () => unknown };
    probe.cdpSessionIds = () => {
      throw new Error("session table unreadable");
    };
    await hook("child-ghost"); // 会话表读不出来：当作「在」→ 照记；旧的 child-1 也不被修剪
    expect(st.problems()).toEqual(["child-1", "main", "child-ghost"]);
    probe.cdpSessionIds = undefined; // 没有这个接口（旧版 / 精简替身）：同样 fail-open
    await hook("child-ghost-2");
    expect(st.problems()).toEqual(["child-1", "main", "child-ghost", "child-ghost-2"]);
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(4); // 读 list 时的修剪同样 fail-open
  });

  it("每次桩钩子开头顺手修剪已不存在的子会话记录（N-6）：自愈重连清了子会话表后，重连里主会话的钩子一跑，旧子会话的失败记录 / 脚本编号就没了——不用等到有人读 permissions list", async () => {
    const s = await setup();
    s.tab.attachChild("child-1");
    s.tab.attachChild("child-2");
    let ok = false;
    let n = 0;
    s.tab.sendImpl = async (method) => {
      if (method !== "Page.addScriptToEvaluateOnNewDocument") return {};
      if (!ok) throw new Error("cdp gone");
      return { identifier: `id-${++n}` };
    };
    const hook = stubHookOf(s);
    await hook(null);
    await hook("child-1"); // 失败：main、child-1 进失败记录
    ok = true;
    await hook("child-2"); // 成功：child-2 有脚本编号
    const st = stubStateOf(s);
    expect(st.problems()).toEqual(["main", "child-1"]);
    expect(st.scripts()).toEqual(["child-2"]);
    s.tab.children.clear(); // 自愈重连：直接清表、没有 detach 事件
    await hook(null); // 重连里主会话的钩子（这次成功）
    expect(st.problems()).toEqual([]); // main 装成功被清；child-1 的旧失败记录被钩子开头的修剪清掉（没人读过 list）
    expect(st.scripts()).toEqual(["main"]); // child-2 的旧脚本编号同样被修剪
  });

  it("新文档脚本登记成功、只是「当前文档补一遍」失败（早钩子可能赶在主世界上下文建好之前）：不算桩没装上——只记日志，不进 queryStubProblems / 活动记录", async () => {
    const s = await setup();
    s.tab.sendImpl = async (method) => {
      if (method === "Runtime.evaluate") throw new Error("Cannot find default execution context");
      return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "reg-1" } : {};
    };
    await expect(stubHookOf(s)(null)).resolves.toBeUndefined();
    expect(s.gate.queryStubProblems(s.tab)).toEqual([]);
    expect(s.activity().join("\n")).not.toContain("页内权限状态桩没装上");
    expect(s.logs.join("\n")).toContain("补装到当前文档失败（已由新文档脚本兜底）");
  });

  it("tab 已销毁时在飞的安装失败（OAuth 之类的弹窗一出来就关）：不写「桩装不上」日志、不进 queryStubProblems、不写活动记录；补装当前文档失败的那一行日志同样不写——tab 没销毁时两者照写（对照，第二十六轮 T-6）", async () => {
    // 对照：tab 还在，同样的失败照记
    const live = await setup();
    failingSend(live);
    await stubHookOf(live)(null);
    expect(live.logs.join("\n")).toContain("页内权限查询桩装不上");
    expect(live.gate.queryStubProblems(live.tab)).toHaveLength(1);
    const liveEval = await setup();
    liveEval.tab.sendImpl = async (method) => {
      if (method === "Runtime.evaluate") throw new Error("Cannot find default execution context");
      return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "reg-1" } : {};
    };
    await stubHookOf(liveEval)(null);
    expect(liveEval.logs.join("\n")).toContain("补装到当前文档失败");

    // 命令在飞时 tab 被销毁、随后命令失败：注册新文档脚本那一步
    const s = await setup();
    s.tab.sendImpl = async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        s.tab.destroy();
        throw new Error("Target closed");
      }
      return {};
    };
    await expect(stubHookOf(s)(null)).resolves.toBeUndefined();
    expect(s.tab.destroyed).toBe(true);
    expect(s.logs.join("\n")).not.toContain("页内权限查询桩装不上");
    expect(s.gate.queryStubProblems(s.tab)).toEqual([]);
    expect(s.activity().join("\n")).not.toContain("页内权限状态桩没装上");

    // 当前文档补装那一步：注册成功之后 tab 才被销毁、补装失败
    const t = await setup();
    t.tab.sendImpl = async (method) => {
      if (method === "Runtime.evaluate") {
        t.tab.destroy();
        throw new Error("Target closed");
      }
      return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "reg-1" } : {};
    };
    await expect(stubHookOf(t)(null)).resolves.toBeUndefined();
    expect(t.tab.destroyed).toBe(true);
    expect(t.logs.join("\n")).not.toContain("补装到当前文档失败");
    expect(t.gate.queryStubProblems(t.tab)).toEqual([]);
  });

  it("子会话 detach（Target.detachedFromTarget）：它的「新文档脚本记录」和失败记录一并清掉，别的会话不受影响（页面反复跨站导航时这两张表不无限增长，R23-4）", async () => {
    const s = await setup();
    let n = 0;
    s.tab.sendImpl = async (method) => (method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: `stub-${++n}` } : {});
    for (const sid of ["child-1", "child-2", "child-3"]) s.tab.attachChild(sid);
    const hook = stubHookOf(s);
    await hook(null);
    await hook("child-1");
    await hook("child-2");
    const scripts = () => {
      const ts = s.tab.getExt("permissions", () => ({})) as { queryStubScripts: Map<string, string> };
      return [...ts.queryStubScripts.keys()];
    };
    expect(scripts()).toEqual(["main", "child-1", "child-2"]);
    s.tab.emitCdp("Target.detachedFromTarget", { sessionId: "child-1" }, null);
    expect(scripts()).toEqual(["main", "child-2"]);
    // 脏输入：没有 sessionId / 不是字符串 / 空串 → 什么都不动
    for (const params of [{}, { sessionId: 7 }, { sessionId: "" }]) s.tab.emitCdp("Target.detachedFromTarget", params, null);
    expect(scripts()).toEqual(["main", "child-2"]);
    // 别的事件不触发清理
    s.tab.emitCdp("Target.attachedToTarget", { sessionId: "child-2" }, null);
    expect(scripts()).toEqual(["main", "child-2"]);
    // 失败记录同样随会话作废
    s.tab.sendImpl = async () => {
      throw new Error("x");
    };
    await hook("child-3");
    expect(s.gate.queryStubProblems(s.tab)).toHaveLength(1);
    s.tab.emitCdp("Target.detachedFromTarget", { sessionId: "child-3" }, null);
    expect(s.gate.queryStubProblems(s.tab)).toEqual([]);
  });
});

describe("B. 被顶层委托的跨源 iframe：请求侧（先核对 allowsFeature）", () => {
  it("被委托：按顶层站点弹提示（detail 带 frame），用户「本会话一直允许」→ 授予记在顶层 origin 上、回调 true；之后同类请求免提示", async () => {
    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: true }]);
    const cb = s.frameRequest(B);
    await flush();
    const p = firstPrompt(s.session, "permission");
    expect(p.detail).toEqual({ permission: "microphone", origin: A, frame: B });
    expect(p.host).toBe("a.example.com");
    expect(cb).not.toHaveBeenCalled();
    s.session.prompts.answer(p.id, { action: "allow-session" });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    const grants = getPermissionState(s.session).grants;
    expect(grants.get(A, "microphone")).toMatchObject({ decision: "allow", source: "user" });
    expect(grants.get(B, "microphone")).toBeUndefined(); // 嵌入框架自己的 origin 没有授予
    expect(s.activity().join("\n")).toContain("由页面内嵌的 b.example.com 发起");
    // 之后：iframe 与顶层自己都免提示
    const again = s.frameRequest(B);
    const top = s.topRequest(["audio"]);
    await flush();
    expect(again).toHaveBeenCalledWith(true);
    expect(top).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("顶层已有授予（用户 / AI 的）：被委托的 iframe 免提示直接放行；授予被 AI 显式拒绝时拒绝并留记录", async () => {
    const s = await setup({ pagePermissions: true });
    s.frames([{ href: `${B}/f`, ok: true }]);
    getPermissionState(s.session).grants.allow(A, "microphone", "ai");
    const ok = s.frameRequest(B);
    await flush();
    expect(ok).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    getPermissionState(s.session).grants.deny(A, "camera", "ai");
    const no = s.frameRequest(B, ["video"]);
    await flush();
    expect(no).toHaveBeenCalledWith(false);
    expect(s.blocked()[0]).toMatchObject({ origin: A, frameOrigin: B, permission: "camera", reason: "explicit-deny-ai" });
  });

  it("顶层已授予、但这个 iframe 没被委托（allowsFeature = false）→ 仍拒绝、不弹提示（顶层的授予不替没委托的框架开口）", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "microphone", "user");
    s.frames([{ href: `${B}/f`, ok: false }]);
    const cb = s.frameRequest(B);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ origin: A, frameOrigin: B, reason: "frame-not-delegated" });
    // 对照：顶层自己照常放行
    expect(s.topRequest(["audio"])).toHaveBeenCalledWith(true);
  });

  it("嵌套（顶层 A → B → C，请求来自 C）：按 C 自己的核对结果（含整条嵌套链），授予记在顶层 A 上，C / B 自己的 origin 没有授予；链上有一环没委托就拒绝", async () => {
    const s = await setup();
    s.frames([
      { href: `${B}/mid`, ok: true },
      { href: `${C}/f`, ok: true },
    ]);
    const cb = s.frameRequest(C);
    await flush();
    const p = firstPrompt(s.session, "permission");
    expect(p.detail).toEqual({ permission: "microphone", origin: A, frame: C });
    s.session.prompts.answer(p.id, { action: "allow-session" });
    await flush();
    expect(cb).toHaveBeenCalledWith(true);
    const grants = getPermissionState(s.session).grants;
    expect(grants.get(A, "microphone")).toMatchObject({ decision: "allow" });
    expect(grants.get(C, "microphone")).toBeUndefined();
    expect(grants.get(B, "microphone")).toBeUndefined();

    const t = await setup();
    t.frames([
      { href: `${B}/mid`, ok: true },
      { href: `${C}/f`, ok: false }, // Chromium 算好的 allowsFeature 已经含整条链：中间层没往下委托，C 里就是 false
    ]);
    const no = t.frameRequest(C);
    await flush();
    expect(no).toHaveBeenCalledWith(false);
    expect(t.blocked()[0]).toMatchObject({ frameOrigin: C, reason: "frame-not-delegated" });
    expect(t.session.prompts.size()).toBe(0);
  });

  it("没被委托（allowsFeature = false）→ 拒绝、不弹提示，记一条 frame-not-delegated（活动记录 + 最近被拒清单）", async () => {
    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: false }]);
    const cb = s.frameRequest(B);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()).toEqual([expect.objectContaining({ origin: A, frameOrigin: B, permission: "microphone", reason: "frame-not-delegated", count: 1 })]);
    const line = s.activity().join("\n");
    expect(line).toContain("已自动拒绝页面内嵌的 b.example.com（顶层 a.example.com）的「麦克风」权限请求（未弹提示）");
    // 整句原因都读得到（活动记录摘要有 160 字上限，原因文案太长会被截成「…」）
    expect(line).toContain(BLOCK_REASON_TEXT["frame-not-delegated"]);
  });

  it("同一 origin 有多个框架：必须全部被委托，一个没委托就拒绝；别的 origin 的框架 / 顶层自己的行不参与匹配", async () => {
    const s = await setup();
    s.frames([
      { href: `${A}/page`, ok: true },
      { href: `${B}/f1`, ok: true },
      { href: `${B}/f2`, ok: false },
      { href: `${C}/f`, ok: true },
    ]);
    const cb = s.frameRequest(B);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.blocked()[0]).toMatchObject({ reason: "frame-not-delegated" });
    // 只有别的 origin 的行 = 没找到这个框架（等不到就是核对不出来），不会因为 C 被委托就放行 B
    const t = await setup();
    t.frames([{ href: `${C}/f`, ok: true }]);
    const cb2 = t.frameRequest(B);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_TOTAL_MS + 500);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(false);
    expect(t.blocked()[0]).toMatchObject({ reason: "frame-check-failed" });
  });

  it("同 origin 还有「存在却没有隔离世界」的兄弟框架（清单里有、核对里没回应）：不能凭别的框架的答复放行；它出现并被委托后放行；一直不出现就拒绝；清单取不到也拒绝", async () => {
    const s = await setup();
    const inventory = [
      { id: "f0", url: `${B}/f` },
      { id: "f1", url: `${B}/g` },
      { id: "x9", url: `${C}/other` }, // 别的 origin 的框架没有上下文不影响
    ];
    s.tab.frameInventory = async () => inventory;
    s.tab.evalInFrames = async () => [{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]; // 只有 f0 回应
    const cb = s.frameRequest(B);
    await flush();
    expect(s.session.prompts.size()).toBe(0);
    expect(cb).not.toHaveBeenCalled(); // 还在等 f1，不是放行也不是拒绝
    // f1 的隔离世界建好了、也被委托
    s.tab.evalInFrames = async () => [
      { key: "main:f0", value: { href: `${B}/f`, ok: true } },
      { key: "child-1:f1", value: { href: `${B}/g`, ok: true } }, // key 里 frameId 在第一个冒号之后
    ];
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_POLL_MS);
    await flush();
    expect(firstPrompt(s.session, "permission").detail).toEqual({ permission: "microphone", origin: A, frame: B });

    // 一直不出现：TOTAL 之后拒绝（核对不出来）
    const never = await setup();
    never.tab.frameInventory = async () => inventory;
    never.tab.evalInFrames = async () => [{ key: "main:f0", value: { href: `${B}/f`, ok: true } }];
    const cb2 = never.frameRequest(B);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_TOTAL_MS + 500);
    expect(cb2).toHaveBeenCalledWith(false);
    expect(never.blocked()[0]).toMatchObject({ reason: "frame-check-failed", frameOrigin: B });
    expect(never.session.prompts.size()).toBe(0);

    // 已回应的框架里有没委托的：不用等兄弟，直接 no
    const no = await setup();
    no.tab.frameInventory = async () => inventory;
    no.tab.evalInFrames = async () => [{ key: "main:f0", value: { href: `${B}/f`, ok: false } }];
    const cb3 = no.frameRequest(B);
    await flush();
    expect(cb3).toHaveBeenCalledWith(false);
    expect(no.blocked()[0]).toMatchObject({ reason: "frame-not-delegated" });

    // 清单取不到（null / 抛错）：fail closed
    for (const impl of [async () => null, async () => Promise.reject(new Error("tree gone"))]) {
      const t = await setup();
      t.tab.frameInventory = impl as never;
      t.tab.evalInFrames = async () => [{ key: "main:f0", value: { href: `${B}/f`, ok: true } }];
      const cb4 = t.frameRequest(B);
      await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_TOTAL_MS + 500);
      expect(cb4).toHaveBeenCalledWith(false);
      expect(t.blocked()[0]).toMatchObject({ reason: "frame-check-failed" });
    }

    // 清单里的框架都回应了：照常放行（兄弟核对不制造误拒）
    const ok = await setup();
    ok.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }, { id: "top", url: `${A}/page` }];
    ok.tab.evalInFrames = async () => [{ key: "main:f0", value: { href: `${B}/f`, ok: true } }];
    ok.frameRequest(B);
    await flush();
    expect(firstPrompt(ok.session, "permission").detail).toMatchObject({ frame: B });
  });

  it("框架的隔离世界还没建好：隔 POLL 重试，出现后照常处理；一直没有就在 TOTAL 之后拒绝（frame-check-failed）", async () => {
    const s = await setup();
    let n = 0;
    s.tab.evalInFrames = async () => {
      n += 1;
      return n < 3 ? [] : [{ key: "x", value: { href: `${B}/f`, ok: true } }];
    };
    s.tab.frameInventory = async () => [{ id: "x", url: `${B}/f` }];
    const cb = s.frameRequest(B);
    await flush();
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_POLL_MS);
    expect(n).toBe(2);
    expect(s.session.prompts.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_POLL_MS);
    await flush();
    expect(n).toBe(3);
    expect(firstPrompt(s.session, "permission").detail).toEqual({ permission: "microphone", origin: A, frame: B });
    expect(cb).not.toHaveBeenCalled();

    const never = await setup();
    let calls = 0;
    never.tab.evalInFrames = async () => {
      calls += 1;
      return [];
    };
    never.tab.frameInventory = async () => [];
    const cb2 = never.frameRequest(B);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_TOTAL_MS + 1000);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(false);
    expect(calls).toBeGreaterThan(2);
    expect(calls).toBeLessThanOrEqual(Math.ceil(FRAME_DELEGATION_TOTAL_MS / FRAME_DELEGATION_POLL_MS) + 1);
    expect(never.blocked()[0]).toMatchObject({ reason: "frame-check-failed", frameOrigin: B });
    expect(never.session.prompts.size()).toBe(0);
  });

  it("调试连接没就绪（evalInFrames 回 null）：立刻按核对不出来拒绝，不空转到期限；单次页内取值的 timeoutMs 传下去了", async () => {
    const s = await setup();
    let calls = 0;
    s.tab.evalInFrames = async () => {
      calls += 1;
      return null;
    };
    s.tab.frameInventory = async () => [];
    const cb = s.frameRequest(B);
    await flush(); // 不推进计时器：null 不该触发重试等待
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(calls).toBe(1);
    expect(s.blocked()[0]).toMatchObject({ reason: "frame-check-failed", frameOrigin: B });

    // timeoutMs：页面卡死时不让权限回调悬挂太久——必须真的传给 evalInFrames，且就是导出的那个常量（1.5 秒）；
    // totalMs（R23-5）：整个核对的剩余时间，evalInFrames 按批发命令时不能把它累加过头
    expect(FRAME_DELEGATION_EVAL_TIMEOUT_MS).toBe(1500);
    const t = await setup();
    t.frames([{ href: `${B}/f`, ok: true }]);
    t.frameRequest(B);
    await flush();
    expect(t.tab.evalInFramesOpts).toEqual([{ timeoutMs: FRAME_DELEGATION_EVAL_TIMEOUT_MS, totalMs: FRAME_DELEGATION_TOTAL_MS }]);
    expect(t.tab.frameInventoryOpts).toEqual([{ timeoutMs: FRAME_DELEGATION_EVAL_TIMEOUT_MS }]);
  });

  it("总时限是硬的（R23-5）：每次页内取值 / 清单读取的超时都不超过「剩余时间」，页面每次都卡到超时也在 TOTAL 附近就拒绝，不是 TOTAL + 一轮 timeout", async () => {
    const s = await setup();
    const opts: Array<{ timeoutMs?: number; totalMs?: number }> = [];
    s.tab.evalInFrames = async (_e: string, o?: { timeoutMs?: number; totalMs?: number }) => {
      opts.push({ ...o });
      // 模拟页面卡住：占满这次的 timeoutMs 才回「没有框架」
      await new Promise((r) => setTimeout(r, o?.timeoutMs ?? 0));
      return [];
    };
    s.tab.frameInventory = async () => [];
    const cb = s.frameRequest(B);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_TOTAL_MS + 20);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.blocked()[0]).toMatchObject({ reason: "frame-check-failed" });
    expect(opts.length).toBeGreaterThanOrEqual(2);
    // 第一次拿满 1.5 秒；之后每次的 timeoutMs / totalMs 都被「剩余时间」压住，且总剩余单调不增
    expect(opts[0]).toEqual({ timeoutMs: FRAME_DELEGATION_EVAL_TIMEOUT_MS, totalMs: FRAME_DELEGATION_TOTAL_MS });
    let prevTotal = Infinity;
    for (const o of opts) {
      expect(o.timeoutMs).toBeLessThanOrEqual(FRAME_DELEGATION_EVAL_TIMEOUT_MS);
      expect(o.timeoutMs).toBeLessThanOrEqual(o.totalMs ?? 0);
      expect(o.totalMs ?? 0).toBeLessThanOrEqual(prevTotal);
      prevTotal = o.totalMs ?? 0;
    }
    expect(opts[opts.length - 1].totalMs).toBeLessThan(FRAME_DELEGATION_EVAL_TIMEOUT_MS + 1); // 最后一次已经被压到剩余的零头
  });

  it("没有 frameInventory 的 tab（无法确认同 origin 的兄弟框架都回应了）：与缺 evalInFrames 同口径——fail closed，拒绝 + 记 frame-check-failed，且不白跑页内取值（R23-5）", async () => {
    const s = await setup();
    s.tab.evalInFrames = async (expression: string) => {
      s.tab.evalInFramesCalls.push(expression);
      return [{ key: "main:f0", value: { href: `${B}/f`, ok: true } }];
    };
    const cb = s.frameRequest(B);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.blocked()[0]).toMatchObject({ reason: "frame-check-failed", frameOrigin: B });
    expect(s.session.prompts.size()).toBe(0);
    expect(s.tab.evalInFramesCalls).toHaveLength(0);
  });

  it("同一 tab 上同一框架 origin + 权限的并发请求合并成一次核对（R23-5）：只发一轮页内取值 / 清单读取，几个回调都收到同一结论；不同权限 / 不同框架 origin 不合并；结束后下一次重新核对", async () => {
    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: true }, { href: `${C}/f`, ok: true }]);
    const first = s.frameRequest(B);
    const second = s.frameRequest(B);
    const third = s.frameRequest(B);
    await flush();
    expect(s.tab.evalInFramesCalls).toHaveLength(1);
    expect(s.tab.frameInventoryOpts).toHaveLength(1);
    expect(s.session.prompts.size()).toBe(1); // 三个请求合并成一个提示（授予按顶层 origin）
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow" });
    await flush();
    for (const cb of [first, second, third]) {
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(true);
    }
    // 不合并：不同框架 origin / 不同权限各自核对
    const t = await setup();
    t.frames([{ href: `${B}/f`, ok: true }, { href: `${C}/f`, ok: true }]);
    t.frameRequest(B);
    t.frameRequest(C);
    t.frameRequest(B, ["video"]);
    await flush();
    expect(t.tab.evalInFramesCalls).toHaveLength(3);
    // 结束后下一次重新核对（不缓存上一轮的结论）：上面用户点的是一次性「允许」（没留授予），所以这次要再弹提示——但弹之前仍核对一次委托，多一次页内取值
    const n0 = s.tab.evalInFramesCalls.length;
    s.frameRequest(B);
    await flush();
    expect(s.tab.evalInFramesCalls.length).toBe(n0 + 1);
  });

  it("调试连接没就绪（evalInFrames 回 null）→ 顺手触发一次自愈重连（不等它，请求本身仍拒绝）；单飞、间隔 ≥5 秒、失败不抛；没有 ensureCdp 的 tab 照常拒绝（R23-3）", async () => {
    const s = await setup();
    let healCalls = 0;
    let release: () => void = () => {};
    s.tab.ensureCdp = () => {
      healCalls += 1;
      return new Promise<void>((resolve) => (release = resolve));
    };
    s.tab.evalInFrames = async () => null;
    s.tab.frameInventory = async () => [];
    const a = s.frameRequest(B);
    await flush();
    expect(a).toHaveBeenCalledWith(false); // 不等自愈
    expect(healCalls).toBe(1);
    // 自愈还没完成时再来请求：单飞，不再触发
    s.frameRequest(B);
    s.frameRequest(B, ["video"]);
    await flush();
    expect(healCalls).toBe(1);
    // 自愈悬挂超过间隔（5 秒）之后仍然单飞：这一次只有「在飞就不再触发」的判断能挡住（间隔限制早已过去）——删掉它这里会变成 2（P3-7：此前的用例都落在间隔以内，删了单飞判断也不红）
    await vi.advanceTimersByTimeAsync(CDP_HEAL_MIN_INTERVAL_MS + 10);
    s.frameRequest(B);
    await flush();
    expect(healCalls).toBe(1);
    release();
    await flush();
    expect(s.logs.join("\n")).toContain("已触发重连");
    // 第二次自愈：距上次触发已超过间隔、也没有在飞的 → 触发；完成之后仍在间隔内不重发；过了间隔再触发
    s.frameRequest(B);
    await flush();
    expect(healCalls).toBe(2);
    release();
    await flush();
    s.frameRequest(B);
    await flush();
    expect(healCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(CDP_HEAL_MIN_INTERVAL_MS + 10);
    s.frameRequest(B);
    await flush();
    expect(healCalls).toBe(3);
    release();
    await flush();
    // 自愈失败：只记日志，请求照常拒绝，也不抛
    const t = await setup();
    t.tab.ensureCdp = async () => {
      throw new Error("reconnect failed");
    };
    t.tab.evalInFrames = async () => null;
    t.tab.frameInventory = async () => [];
    const cb = t.frameRequest(B);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(t.logs.join("\n")).toContain("重连失败：reconnect failed");
    // 没有 ensureCdp
    const bare = await setup();
    bare.tab.evalInFrames = async () => null;
    bare.tab.frameInventory = async () => [];
    const cb2 = bare.frameRequest(B);
    await flush();
    expect(cb2).toHaveBeenCalledWith(false);
  });

  it("自愈间隔的时钟边界（注入小时钟，第二十五轮评审测试 E）：时钟读数小于间隔 / 恰为 0 时首次也触发（cdpHealAt 初值是 -Infinity、不是 0）；差 1 毫秒不触发、整 5 秒触发；时钟回拨（读数比上次触发还小）不被当成「刚触发过」永久挡住", async () => {
    const run = async (startAt: number, steps: (clock: { t: number }, kick: () => Promise<void>, calls: () => number) => Promise<void>) => {
      const clock = { t: startAt };
      const s = await setup({}, `${A}/page`, { now: () => clock.t });
      let healCalls = 0;
      s.tab.ensureCdp = async () => {
        healCalls += 1;
      };
      s.tab.evalInFrames = async () => null;
      s.tab.frameInventory = async () => [];
      await steps(
        clock,
        async () => {
          s.frameRequest(B);
          await flush();
        },
        () => healCalls,
      );
    };
    await run(1_000, async (clock, kick, calls) => {
      await kick();
      expect(calls()).toBe(1); // 首次：读数 1000 小于 5000，初值若是 0 就会被误当成「刚触发过」
      clock.t = 1_000 + CDP_HEAL_MIN_INTERVAL_MS - 1;
      await kick();
      expect(calls()).toBe(1); // 差 1 毫秒：不触发
      clock.t = 1_000 + CDP_HEAL_MIN_INTERVAL_MS;
      await kick();
      expect(calls()).toBe(2); // 整 5 秒：触发
      clock.t = 10; // 回拨到比上次触发时刻（6000）小得多：负的差不能算「刚触发过」
      await kick();
      expect(calls()).toBe(3);
      clock.t = 10 + CDP_HEAL_MIN_INTERVAL_MS - 1; // 回拨之后的新基准照常生效
      await kick();
      expect(calls()).toBe(3);
    });
    await run(0, async (_clock, kick, calls) => {
      await kick();
      expect(calls()).toBe(1); // 读数恰为 0（假时钟的常见起点）：首次照样触发
    });
  });

  it("evalInFrames 抛错 / 这个 tab 没有该方法 → 核对不出来：拒绝（fail closed），回调恰好一次", async () => {
    const s = await setup();
    s.tab.evalInFrames = async () => {
      throw new Error("cdp down");
    };
    const cb = s.frameRequest(B);
    await vi.advanceTimersByTimeAsync(FRAME_DELEGATION_TOTAL_MS + 500);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    const bare = await setup();
    const cb2 = bare.frameRequest(B);
    await flush();
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(false);
    expect(bare.blocked()[0]).toMatchObject({ reason: "frame-check-failed" });
  });

  it("核对期间 tab 被销毁 → 回调 false、不弹提示、回调只一次", async () => {
    const s = await setup();
    let release: (rows: Rows) => void = () => {};
    s.tab.evalInFrames = () => new Promise<Rows>((resolve) => (release = resolve));
    const cb = s.frameRequest(B);
    await flush();
    s.tab.destroy();
    release([{ key: "x", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("核对期间页面导航走了（顶层 origin 变了）：这个请求属于已经不存在的旧页面——丢弃：回调 false，不弹提示；留一条 navigated-during-check 记录（R22-3 / R23-4）", async () => {
    const s = await setup();
    let release: (rows: Rows) => void = () => {};
    s.tab.evalInFrames = () => new Promise<Rows>((resolve) => (release = resolve));
    s.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    const cb = s.frameRequest(B);
    await flush();
    s.tab.url = `${C}/other`; // 顶层从 A 走到了 C
    release([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.logs.join("\n")).toContain("页面已导航，丢弃");
    // R23-4：不再「悄无声息」——页面读到被拒、list 里却什么都没有会让人误以为权限闸坏了；记一条（带旧页面的 origin / 框架），活动记录写明原因
    expect(s.blocked()).toHaveLength(1);
    expect(s.blocked()[0]).toMatchObject({ reason: "navigated-during-check", origin: A, frameOrigin: B, permission: "microphone", count: 1 });
    expect(s.activity().join("\n")).toContain(BLOCK_REASON_TEXT["navigated-during-check"]);
    // 同 origin 内换页（顶层 origin 没变、文档没重新加载，比如 hash / pushState）不算：照常弹
    const t = await setup();
    let release2: (rows: Rows) => void = () => {};
    t.tab.evalInFrames = () => new Promise<Rows>((resolve) => (release2 = resolve));
    t.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    t.frameRequest(B);
    await flush();
    t.tab.url = `${A}/another-page`;
    t.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true }); // 同文档导航：navEpoch 不动
    release2([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(firstPrompt(t.session, "permission").detail).toEqual({ permission: "microphone", origin: A, frame: B });
    expect(t.blocked()).toEqual([]);
  });

  it("核对期间页面同 origin 重新加载（顶层 origin 没变但文档换了，R23-5 的 navEpoch）：旧文档里发起的请求同样丢弃；子框架自己的导航不算", async () => {
    const s = await setup();
    let release: (rows: Rows) => void = () => {};
    s.tab.evalInFrames = () => new Promise<Rows>((resolve) => (release = resolve));
    s.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    const cb = s.frameRequest(B);
    await flush();
    s.tab.wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false }); // 子框架导航：不算
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); // 顶层刷新：URL 没变
    release([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "navigated-during-check", origin: A, frameOrigin: B });

    const t = await setup();
    let release2: (rows: Rows) => void = () => {};
    t.tab.evalInFrames = () => new Promise<Rows>((resolve) => (release2 = resolve));
    t.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    t.frameRequest(B);
    await flush();
    t.tab.wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    release2([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(firstPrompt(t.session, "permission").detail).toMatchObject({ frame: B }); // 只有子框架导航：请求照常弹
  });

  it("同框架并发核对的合并键带导航计数（P3-3）：旧文档的核对还没回来时页面刷新了，新文档里同一框架 origin 的请求另起一次核对、不拿旧文档那一轮的结论", async () => {
    const s = await setup();
    const releases: Array<(rows: Rows) => void> = [];
    s.tab.evalInFrames = () => new Promise<Rows>((resolve) => releases.push(resolve));
    s.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    const old = s.frameRequest(B);
    await flush();
    expect(releases).toHaveLength(1);
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); // 页面刷新：文档换了
    const fresh = s.frameRequest(B); // 新文档里同一框架 origin + 同一权限的请求
    await flush();
    expect(releases).toHaveLength(2); // 另起了一次核对（没有并入旧一轮）
    // 旧一轮的结论是「没委托」（旧文档的框架），新一轮是「委托了」：新请求只该看到自己那一轮
    releases[0]([{ key: "main:f0", value: { href: `${B}/f`, ok: false } }]);
    releases[1]([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(old).toHaveBeenCalledWith(false);
    expect(s.blocked().some((e) => e.reason === "navigated-during-check")).toBe(true);
    expect(s.blocked().some((e) => e.reason === "frame-not-delegated")).toBe(false); // 新请求没有被旧一轮的「没委托」误拒
    expect(s.session.prompts.size()).toBe(1);
    expect(firstPrompt(s.session, "permission").detail).toMatchObject({ frame: B });
    expect(fresh).not.toHaveBeenCalled();
  });

  it("导航提交（did-navigate）时再加一次导航计数、再取消本 tab 的提示（P3-3）：开始导航之后、提交之前发起的旧文档请求，核对回来时判成旧文档的、不弹提示；提交时还挂着的提示取消（不算拒绝）；同文档导航不算", async () => {
    const s = await setup();
    let release: (rows: Rows) => void = () => {};
    s.tab.evalInFrames = () => new Promise<Rows>((resolve) => (release = resolve));
    s.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); // 导航开始（计数 +1）
    const old = s.frameRequest(B); // 开始之后、提交之前：旧文档里的框架发起的请求（拿到的是开始时加过的计数，比不出它是旧文档的）
    await flush();
    s.tab.wc.emit("did-navigate", {}, `${A}/page`); // 提交：计数再 +1
    release([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(old).toHaveBeenCalledTimes(1);
    expect(old).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "navigated-during-check", origin: A, frameOrigin: B });

    // 提交时还挂着的（旧文档的）提示一并取消：回调 false、不进冷却
    const t = await setup();
    const cb = t.topRequest(["audio"]);
    await flush();
    expect(t.session.prompts.size()).toBe(1);
    // 同文档导航不算（hash / pushState：Electron 发的是 did-navigate-in-page、没有 did-navigate；开始事件带 isSameDocument: true）：挂着的提示留着、不取消（第二十五轮评审测试 H：标题写了、此前用例体里没有）
    // 第二十六轮 X-4 注明：权限闸**没有订阅** did-navigate-in-page，下面这一发在当前实现里没有任何监听者、本身断言不了什么——留着只为还原 Electron 真实的事件序列；
    // 真正起作用的是后面 isSameDocument: true 的 did-start-navigation（门看它判「同文档不加计数、不取消」）。若将来 bindTab 订阅了 did-navigate-in-page，这一发才开始生效
    t.tab.wc.emit("did-navigate-in-page", {}, `${A}/page#x`, true);
    t.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    await flush();
    expect(t.session.prompts.size()).toBe(1);
    expect(cb).not.toHaveBeenCalled();
    t.tab.wc.emit("did-navigate", {}, `${A}/page`);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(t.session.prompts.size()).toBe(0);
    expect(getPermissionState(t.session).cooldown.size).toBe(0);
    expect(t.activity().join("\n")).toContain("权限提示已取消");

    // 同文档导航不改导航计数：核对期间只发生了同文档导航，这次请求照常弹提示、不记 navigated-during-check
    const v = await setup();
    let releaseV: (rows: Rows) => void = () => {};
    v.tab.evalInFrames = () => new Promise<Rows>((resolve) => (releaseV = resolve));
    v.tab.frameInventory = async () => [{ id: "f0", url: `${B}/f` }];
    v.frameRequest(B);
    await flush();
    v.tab.wc.emit("did-navigate-in-page", {}, `${A}/page#x`, true); // 同上（X-4）：无监听者、只还原事件序列；起作用的是下一行的 did-start-navigation
    v.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    releaseV([{ key: "main:f0", value: { href: `${B}/f`, ok: true } }]);
    await flush();
    expect(firstPrompt(v.session, "permission").detail).toMatchObject({ frame: B });
    expect(v.blocked()).toEqual([]);

    // 提交之后新文档发起的请求不受影响（拿到的是提交后的计数）
    const u = await setup();
    u.frames([{ href: `${B}/f`, ok: true }]);
    u.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    u.tab.wc.emit("did-navigate", {}, `${A}/page`);
    u.frameRequest(B);
    await flush();
    expect(firstPrompt(u.session, "permission").detail).toMatchObject({ frame: B });
  });

  it("问什么核对什么：只要麦克风就只核对 microphone；两个都要核对两个；同源子框架 / 顶层自己不走核对", async () => {
    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: true }]);
    s.frameRequest(B, ["audio"]);
    s.frameRequest(B, ["video"]);
    s.frameRequest(B, ["audio", "video"]);
    await flush();
    expect(s.tab.evalInFramesCalls).toHaveLength(3);
    expect(s.tab.evalInFramesCalls[0]).toContain('["microphone"]');
    expect(s.tab.evalInFramesCalls[1]).toContain('["camera"]');
    expect(s.tab.evalInFramesCalls[2]).toContain('["microphone","camera"]');
    const t = await setup();
    t.frames([]);
    t.request("media", { requestingUrl: `${A}/frame`, isMainFrame: false, mediaTypes: ["audio"] }); // 同源子框架
    t.topRequest(["audio"]);
    await flush();
    expect(t.tab.evalInFramesCalls).toHaveLength(0);
    expect(t.session.prompts.size()).toBe(1); // 两个请求合并成一个提示
  });

  it("顶层与被委托框架同时要同一项：合并成一个提示（授予按顶层 origin、对两者一样），回答后两个回调各一次", async () => {
    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: true }]);
    const top = s.topRequest(["audio"]);
    const frame = s.frameRequest(B);
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow" });
    await flush();
    expect(top).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledWith(true);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(frame).toHaveBeenCalledWith(true);
  });

  it("用户拒绝被委托框架的请求 → 冷却记在顶层 origin 上：30 秒内顶层 / 框架再请求都不重复弹", async () => {
    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: true }]);
    s.frameRequest(B);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    const top = s.topRequest(["audio"]);
    const again = s.frameRequest(B);
    await flush();
    expect(top).toHaveBeenCalledWith(false);
    expect(again).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "cooldown" });
  });

  it("Flowship 自己的页面作为顶层：不核对、直接拒绝；非 media 权限（定位）的跨源子框架照旧静默拒绝并留记录（不走委托）", async () => {
    const app = await setup({}, `${APP_ORIGIN}/x`);
    app.frames([{ href: `${B}/f`, ok: true }]);
    const cb = app.frameRequest(B);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(app.tab.evalInFramesCalls).toHaveLength(0);
    expect(app.session.prompts.size()).toBe(0);

    const s = await setup();
    s.frames([{ href: `${B}/f`, ok: true }]);
    const geo = s.request("geolocation", { requestingUrl: `${B}/f`, isMainFrame: false });
    await flush();
    expect(geo).toHaveBeenCalledWith(false);
    expect(s.tab.evalInFramesCalls).toHaveLength(0);
    expect(s.blocked()[0]).toMatchObject({ origin: A, frameOrigin: B, permission: "geolocation", reason: "cross-origin-frame" });
  });
});

describe("B. 被顶层委托的跨源 iframe：检查侧（R22-1 之后同样一律不回 true）", () => {
  it("跨源 iframe 的 media 检查（带 embeddingOrigin = 顶层）：顶层授予前后都是 false——授予记在顶层 origin 上、框架自己没有授予；取流走请求处理器里的委托核对；设备名检查同样 false", async () => {
    const s = await setup();
    expect(s.query("audio", B, A, false)).toBe(false);
    expect(s.enumerate("audio", B, false)).toBe(false);
    getPermissionState(s.session).grants.allow(A, "microphone", "user");
    expect(s.query("audio", B, A, false)).toBe(false);
    expect(s.enumerate("audio", B, false)).toBe(false); // 就算顶层授予了，设备名也只给顶层自己的框架
    expect(s.query("audio")).toBe(true); // 对照：顶层自己确实已授予
  });

  it("夹在别的站点里的「同源于顶层」框架（origin = 顶层、embeddingOrigin ≠ origin）与更深的嵌套都 false；Flowship 自己的页面作顶层 → false；非 media 不放宽", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.allow(A, "microphone", "user");
    expect(s.query("audio", A, B, false)).toBe(false);
    expect(s.query("audio", C, B, false)).toBe(false);
    const app = await setup({}, `${APP_ORIGIN}/x`);
    expect(app.query("audio", B, APP_ORIGIN, false)).toBe(false);
    expect(s.check("geolocation", B, { embeddingOrigin: A, isMainFrame: false, requestingUrl: `${B}/` })).toBe(false);
  });
});

describe("C. 自动拒绝可见：活动记录（限速）+ 最近被自动拒绝清单（按 partition 分开）", () => {
  it("显式拒绝记录：请求被拒时留一条记录；同来源同权限同原因合并计数，活动记录每 60 秒一条并带「另有 N 次」", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.deny(A, "microphone", "ai");
    for (let i = 0; i < 5; i++) {
      expect(s.topRequest(["audio"])).toHaveBeenCalledWith(false);
    }
    await flush();
    expect(s.blocked()).toEqual([expect.objectContaining({ origin: A, frameOrigin: null, permission: "microphone", reason: "explicit-deny-ai", count: 5, incognito: false })]);
    expect(s.activity()).toHaveLength(1);
    expect(s.activity()[0]).toContain("已自动拒绝a.example.com的「麦克风」权限请求（未弹提示）");
    expect(s.activity()[0]).toContain(BLOCK_REASON_TEXT["explicit-deny-ai"]);
    await vi.advanceTimersByTimeAsync(61_000);
    s.topRequest(["audio"]);
    expect(s.activity()).toHaveLength(2);
    expect(s.activity()[1]).toContain("另有 4 次同类请求");
    expect(s.blocked()[0]).toMatchObject({ count: 6 });
  });

  it("不同权限 / 原因各有各的条目与限速；最多保留 MAX_RECENT_BLOCKED 条（最新在前）", async () => {
    const s = await setup();
    const grants = getPermissionState(s.session).grants;
    grants.deny(A, "microphone", "ai");
    grants.deny(A, "camera", "user");
    s.topRequest(["audio"]);
    s.topRequest(["video"]);
    expect(s.blocked().map((e) => [e.permission, e.reason])).toEqual([
      ["camera", "explicit-deny-user"],
      ["microphone", "explicit-deny-ai"],
    ]);
    expect(s.activity()).toHaveLength(2);
    for (let i = 0; i < MAX_RECENT_BLOCKED + 3; i++) {
      grants.deny(`https://h${i}.example.com`, "geolocation", "ai");
      s.request("geolocation", { requestingUrl: `https://h${i}.example.com/`, isMainFrame: true });
    }
    expect(s.blocked()).toHaveLength(MAX_RECENT_BLOCKED);
    expect(s.blocked()[0]).toMatchObject({ origin: `https://h${MAX_RECENT_BLOCKED + 2}.example.com` });
  });

  it("硬规则拒绝（永远拒绝 / 未知权限名 / Flowship 自己的页面）和放行项不记；非网页来源（about:blank）的询问类请求记 opaque-origin", async () => {
    const s = await setup();
    for (const permission of ["display-capture", "usb", "fullscreen", "brand-new-permission", "clipboard-sanitized-write"]) s.request(permission);
    expect(s.blocked()).toEqual([]);
    expect(s.activity()).toEqual([]);
    // 不在「询问类」名单里的权限，哪怕被拒的原因不是硬规则也不记：扬声器选择（放行项）只给顶层站点自己的框架，跨源框架请求被拒（cross-origin-frame）
    // ——它不是用户会期待弹提示的权限，记了只是噪声（去掉「非询问类不记」这道过滤，这里就会多出一条）
    const cb = s.request("speaker-selection", { requestingUrl: `${B}/frame`, isMainFrame: false });
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.blocked()).toEqual([]);
    expect(s.activity()).toEqual([]);
    const app = await setup({}, `${APP_ORIGIN}/x`);
    app.request("media", { requestingUrl: `${APP_ORIGIN}/x`, isMainFrame: true, mediaTypes: ["audio"] });
    expect(app.blocked()).toEqual([]);
    const blank = await setup({}, "about:blank");
    blank.request("media", { requestingUrl: "about:blank", isMainFrame: true, mediaTypes: ["audio"] });
    expect(blank.blocked()).toEqual([expect.objectContaining({ origin: null, permission: "microphone", reason: "opaque-origin" })]);
    expect(blank.activity()[0]).toContain("非网页来源");
  });

  it("冷却期内的重复请求记 cooldown（让 AI 知道是刚被拒绝、不是提示弹不出来）；每个权限名对应展示名（两项合称 media）", async () => {
    const s = await setup();
    s.topRequest(["audio", "video"]);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    const cb = s.topRequest(["audio", "video"]);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.blocked()[0]).toMatchObject({ permission: "media", reason: "cooldown" });
    const line = s.activity().join("\n");
    expect(line).toContain("30 秒内同一标签页上的该站点不再重复弹提示");
    expect(line).toContain("刷新页面也不会重置"); // 冷却键含 tab + origin + 权限，刷新不清——文案不能再说「刷新就行」
  });

  it("清除浏览数据 / 会话销毁：最近被拒清单清空；每个原因码都有固定文案，且短到能整句进活动记录（摘要上限 160 字）", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.deny(A, "microphone", "ai");
    s.topRequest(["audio"]);
    expect(s.blocked()).toHaveLength(1);
    getPermissionState(s.session).onBrowsingDataCleared();
    expect(s.blocked()).toHaveLength(0);
    getPermissionState(s.session).grants.deny(A, "microphone", "ai"); // 清除浏览数据把授予 / 拒绝记录一并清了，重新写一条
    s.topRequest(["audio"]);
    expect(s.blocked()).toHaveLength(1);
    const state = getPermissionState(s.session);
    s.session.destroy();
    expect(state.recentBlocked).toHaveLength(0);
    // 全部原因码（含第二十三轮新增的 cancel-streak / prompt-overflow / navigated-during-check）：新增原因码忘了配文案或写太长都会红
    expect(Object.keys(BLOCK_REASON_TEXT).sort()).toEqual(
      ["cancel-streak", "cooldown", "cross-origin-frame", "explicit-deny-ai", "explicit-deny-user", "frame-check-failed", "frame-not-delegated", "navigated-during-check", "notifications-main-frame-only", "opaque-origin", "prompt-overflow"].sort(),
    );
    for (const [reason, text] of Object.entries(BLOCK_REASON_TEXT)) {
      expect(text, reason).toBeTruthy();
      expect(text.length, `${reason} 文案过长（${text.length} 字）`).toBeLessThanOrEqual(80);
    }
    // 最长的那条真的整句进得了活动记录（不被摘要上限截成「…」）
    const longest = Object.entries(BLOCK_REASON_TEXT).sort((x, y) => y[1].length - x[1].length)[0][1];
    const t = await setup();
    t.frames([{ href: `${B}/f`, ok: false }]);
    t.frameRequest(B);
    await flush();
    const line = t.activity().find((x) => x.includes(BLOCK_REASON_TEXT["frame-not-delegated"]));
    expect(line, "frame-not-delegated 整句应进活动记录").toBeTruthy();
    expect(line?.length ?? 0).toBeLessThanOrEqual(160);
    expect(longest.length).toBeLessThanOrEqual(80);
  });

  it("R23-6 顶层页面是不透明来源（file: / about:blank）时，跨源子框架的请求记 opaque-origin（不误导成「去加 iframe allow」）；顶层是普通网页时仍记 cross-origin-frame", async () => {
    for (const topUrl of ["file:///tmp/page.html", "about:blank"]) {
      const s = await setup({}, topUrl);
      s.request("geolocation", { requestingUrl: `${B}/f`, isMainFrame: false });
      s.request("media", { requestingUrl: `${B}/f`, isMainFrame: false, mediaTypes: ["audio"] });
      await flush();
      expect(s.blocked().map((e) => [e.permission, e.reason, e.origin, e.frameOrigin]).sort(), topUrl).toEqual([
        ["geolocation", "opaque-origin", null, B],
        ["microphone", "opaque-origin", null, B],
      ]);
      expect(s.activity().join("\n")).toContain(BLOCK_REASON_TEXT["opaque-origin"]);
    }
    // 对照（防空转）：顶层是普通网页，非 media 的跨源子框架仍是 cross-origin-frame
    const web = await setup();
    web.request("geolocation", { requestingUrl: `${B}/f`, isMainFrame: false });
    expect(web.blocked()[0]).toMatchObject({ reason: "cross-origin-frame", origin: A, frameOrigin: B });
  });

  it("R23-6 最近被拒清单每个 partition 各自最多 MAX_RECENT_BLOCKED 条：普通标签刷满不挤掉无痕那几条，反过来也一样", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    const deny = (incognito: boolean, host: string) => {
      s.tab.incognito = incognito;
      (incognito ? state.incognitoGrants : state.grants).deny(`https://${host}`, "geolocation", "ai");
      s.request("geolocation", { requestingUrl: `https://${host}/`, isMainFrame: true });
      s.tab.incognito = false;
    };
    deny(true, "private-1.example.com");
    deny(true, "private-2.example.com");
    for (let i = 0; i < MAX_RECENT_BLOCKED + 5; i++) deny(false, `normal-${i}.example.com`);
    const normal = () => s.blocked().filter((e) => e.incognito === false);
    const priv = () => s.blocked().filter((e) => e.incognito === true);
    expect(priv().map((e) => e.origin)).toEqual(["https://private-2.example.com", "https://private-1.example.com"]); // 没被挤掉
    expect(normal()).toHaveLength(MAX_RECENT_BLOCKED);
    expect(normal()[0]).toMatchObject({ origin: `https://normal-${MAX_RECENT_BLOCKED + 4}.example.com` }); // 保留的是最新的
    // 反过来：无痕刷满，普通那 MAX 条原封不动
    const before = normal().map((e) => e.key);
    for (let i = 0; i < MAX_RECENT_BLOCKED + 3; i++) deny(true, `private-more-${i}.example.com`);
    expect(priv()).toHaveLength(MAX_RECENT_BLOCKED);
    expect(normal().map((e) => e.key)).toEqual(before);
    // 总数上限是两份相加，而不是共用一份
    expect(s.blocked()).toHaveLength(MAX_RECENT_BLOCKED * 2);
  });

  it("R22-3 无痕与普通标签分开记：同来源同权限同原因也是两条；list 只看同 partition（见 ops 单测）；无痕 partition wipe 只清无痕那几条；清除浏览数据按 partition 范围清", async () => {
    const s = await setup();
    getPermissionState(s.session).grants.deny(A, "microphone", "ai");
    getPermissionState(s.session).incognitoGrants.deny(A, "microphone", "ai");
    s.topRequest(["audio"]); // 普通标签
    s.tab.incognito = true;
    s.topRequest(["audio"]); // 同一页面当作无痕标签
    s.tab.incognito = false;
    expect(s.blocked().map((e) => e.incognito).sort()).toEqual([false, true]);
    expect(s.blocked().every((e) => e.count === 1)).toBe(true); // 没有合并成一条 count 2

    const state = getPermissionState(s.session);
    state.onPartitionWiped("persist:flowship-browser"); // 不是无痕 partition：不动
    expect(s.blocked()).toHaveLength(2);
    state.onPartitionWiped("flowship-incognito-1");
    expect(s.blocked().map((e) => e.incognito)).toEqual([false]);

    // 重新造两条：清除浏览数据（给了 partition = 只清这个 partition 的那份）
    s.tab.incognito = true;
    getPermissionState(s.session).incognitoGrants.deny(A, "microphone", "ai");
    s.topRequest(["audio"]);
    s.tab.incognito = false;
    expect(s.blocked()).toHaveLength(2);
    state.onBrowsingDataCleared("persist:flowship-browser");
    expect(s.blocked().map((e) => e.incognito)).toEqual([true]); // 普通那条清了、无痕那条留着
    state.onBrowsingDataCleared(); // 没给 partition = 两份都清
    expect(s.blocked()).toHaveLength(0);
  });
});

describe("D. 系统层挡住时，提示 detail 多带 systemDenied / systemRestricted / platform（restricted = 用户自己改不了，话术不同）", () => {
  const withStatus = (statuses: Record<string, string | (() => string)>, platform = "darwin") =>
    ({
      getMediaAccessStatus: (kind: string) => {
        const v = statuses[kind];
        return typeof v === "function" ? v() : (v ?? "unknown");
      },
      platform,
    }) as Record<string, unknown>;

  it("麦克风被系统层拒绝（denied）：问麦克风的提示带 systemDenied=microphone；摄像头没拒绝就不带；restricted 单独写 systemRestricted；两项各归各的", async () => {
    const s = await setup({}, `${A}/page`, withStatus({ microphone: "denied", camera: "granted" }));
    s.topRequest(["audio"]);
    await flush();
    expect(firstPrompt(s.session, "permission").detail).toEqual({ permission: "microphone", origin: A, systemDenied: "microphone", platform: "darwin" });

    const cam = await setup({}, `${A}/page`, withStatus({ microphone: "denied", camera: "granted" }));
    cam.topRequest(["video"]);
    await flush();
    expect(firstPrompt(cam.session, "permission").detail).toEqual({ permission: "camera", origin: A });

    const restricted = await setup({}, `${A}/page`, withStatus({ microphone: "restricted" }));
    restricted.topRequest(["audio"]);
    await flush();
    expect(firstPrompt(restricted.session, "permission").detail).toEqual({ permission: "microphone", origin: A, systemRestricted: "microphone", platform: "darwin" });

    const both = await setup({}, `${A}/page`, withStatus({ microphone: "restricted", camera: "denied" }, "win32"));
    both.topRequest(["audio", "video"]);
    await flush();
    expect(firstPrompt(both.session, "permission").detail).toEqual({ permission: "media", origin: A, systemDenied: "camera", systemRestricted: "microphone", platform: "win32" });
  });

  it("granted / not-determined / unknown / 取状态抛错 / 没传 getMediaAccessStatus：都不带（not-determined 时系统自己会弹授权框）", async () => {
    for (const status of ["granted", "not-determined", "unknown"]) {
      const s = await setup({}, `${A}/page`, withStatus({ microphone: status }));
      s.topRequest(["audio"]);
      await flush();
      expect(firstPrompt(s.session, "permission").detail, status).toEqual({ permission: "microphone", origin: A });
    }
    const boom = await setup({}, `${A}/page`, withStatus({ microphone: () => { throw new Error("no api"); } }));
    boom.topRequest(["audio"]);
    await flush();
    expect(firstPrompt(boom.session, "permission").detail).toEqual({ permission: "microphone", origin: A });
    const none = await setup();
    none.topRequest(["audio"]);
    await flush();
    expect(firstPrompt(none.session, "permission").detail).toEqual({ permission: "microphone", origin: A });
  });

  it("非麦克风 / 摄像头的提示（定位等）不带，也不去读系统状态", async () => {
    const spy = vi.fn(() => "denied");
    const s = await setup({}, `${A}/page`, { getMediaAccessStatus: spy });
    s.request("geolocation");
    await flush();
    expect(firstPrompt(s.session, "permission").detail).toEqual({ permission: "geolocation", origin: A });
    expect(spy).not.toHaveBeenCalled();
  });

  it("每个原子每次提示只读一次系统状态（R23-6）：状态在两次读之间变了，也不会读出自相矛盾的两份（同时 denied 与 restricted）", async () => {
    const calls: string[] = [];
    // 同一个原子第一次读到 denied、第二次读到 restricted：旧写法 denied / restricted 各读一遍，提示 detail 里会同时出现两个字段
    const flipping = (kind: string) => {
      calls.push(kind);
      return calls.filter((k) => k === kind).length === 1 ? "denied" : "restricted";
    };
    const one = await setup({}, `${A}/page`, { getMediaAccessStatus: flipping, platform: "darwin" });
    one.topRequest(["audio"]);
    await flush();
    expect(calls).toEqual(["microphone"]);
    expect(firstPrompt(one.session, "permission").detail).toEqual({ permission: "microphone", origin: A, systemDenied: "microphone", platform: "darwin" });

    calls.length = 0;
    const both = await setup({}, `${A}/page`, { getMediaAccessStatus: flipping, platform: "darwin" });
    both.topRequest(["audio", "video"]);
    await flush();
    expect(calls.slice().sort()).toEqual(["camera", "microphone"]); // 问两项 = 各读一次，不是各读两次
    expect(firstPrompt(both.session, "permission").detail).toEqual({ permission: "media", origin: A, systemDenied: "microphone,camera", platform: "darwin" });
  });

  it("systemMediaProblems()（给 permissions list 的「系统层」一行）：只列 denied / restricted 的麦克风 / 摄像头；其余状态 / 抛错 / 没传 → 空", async () => {
    const s = await setup({}, `${A}/page`, withStatus({ microphone: "denied", camera: "restricted" }, "darwin"));
    expect(s.gate.systemMediaProblems()).toEqual({
      platform: "darwin",
      problems: [
        { permission: "microphone", status: "denied" },
        { permission: "camera", status: "restricted" },
      ],
    });
    const ok = await setup({}, `${A}/page`, withStatus({ microphone: "granted", camera: "not-determined" }));
    expect(ok.gate.systemMediaProblems().problems).toEqual([]);
    const boom = await setup({}, `${A}/page`, withStatus({ microphone: () => { throw new Error("x"); } }));
    expect(boom.gate.systemMediaProblems().problems).toEqual([]);
    expect((await setup()).gate.systemMediaProblems().problems).toEqual([]);
  });
});

describe("E. 提示被取消（页面导航 / 关标签 / 会话销毁）不是用户的拒绝：不进冷却（R22-2）；只有用户明确点的拒绝进 30 秒冷却，超时也不进（R23-4）", () => {
  it("提示挂着时页面主框架导航：回调 false，但不进冷却——页面重新请求会再弹；活动记录写「已取消」而不是「已拒绝」，也不进最近被拒清单", async () => {
    const s = await setup();
    const cb = s.topRequest(["audio"]);
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(getPermissionState(s.session).cooldown.size).toBe(0);
    const again = s.topRequest(["audio"]);
    await flush();
    expect(s.session.prompts.size()).toBe(1); // 又弹了，不是被冷却静默拒绝
    expect(again).not.toHaveBeenCalled();
    const log = s.activity().join("\n");
    expect(log).toContain("权限提示已取消");
    expect(log).toContain("不算拒绝");
    expect(log).not.toContain("已拒绝");
    expect(s.blocked()).toEqual([]);
  });

  it("同文档导航 / 子框架导航不取消提示", async () => {
    const s = await setup();
    s.topRequest(["audio"]);
    await flush();
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    s.tab.wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    await flush();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("标签页被关闭 / 会话被销毁时提示被取消：回调 false、冷却表保持为空、没有「已拒绝」", async () => {
    const s = await setup();
    const cb = s.topRequest(["audio", "video"]);
    await flush();
    s.tab.destroy();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(getPermissionState(s.session).cooldown.size).toBe(0);
    expect(s.activity().join("\n")).not.toContain("已拒绝");

    const t = await setup();
    const cb2 = t.topRequest(["audio"]);
    await flush();
    const state = getPermissionState(t.session);
    t.session.destroy();
    await flush();
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(false);
    expect(state.cooldown.size).toBe(0);
  });

  it("对照：用户点拒绝进 30 秒冷却并写「已拒绝」；提示无人处理（60 秒超时）只拒绝这一次、不进冷却（R23-4），之后页面重新发起请求立刻再弹", async () => {
    const s = await setup();
    s.topRequest(["audio"]);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    expect(getPermissionState(s.session).cooldown.size).toBe(1);
    expect(s.activity().join("\n")).toContain("已拒绝a.example.com的「麦克风」权限请求");

    // 超时：用户根本没看到 / 没处理，不能再让他干等 30 秒才被问第二次（那就是「弹不出权限提示」的变种）
    const t = await setup();
    const cb = t.topRequest(["audio"]);
    await flush();
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS + 10);
    expect(cb).toHaveBeenCalledWith(false);
    expect(getPermissionState(t.session).cooldown.size).toBe(0);
    expect(getPermissionState(t.session).cancelCooldown.size).toBe(0);
    expect(t.activity().join("\n")).toContain("无人处理，已自动拒绝a.example.com的「麦克风」权限请求");
    expect(t.activity().join("\n")).toContain("超时不进冷却");
    expect(t.blocked()).toEqual([]); // 提示是真弹了、只是没人理：不是「没弹就拒绝」
    const again = t.topRequest(["audio"]);
    await flush();
    expect(t.session.prompts.size()).toBe(1);
    expect(again).not.toHaveBeenCalled();
  });

  it("冷却时长就是 30 秒：拒绝后 29 秒内同一页面再请求被静默拒绝（记 cooldown），过了 30 秒才再弹", async () => {
    expect(PERMISSION_COOLDOWN_MS).toBe(30_000);
    const s = await setup();
    s.topRequest(["audio"]);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    const inside = s.topRequest(["audio"]);
    await flush();
    expect(inside).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "cooldown" });
    await vi.advanceTimersByTimeAsync(2_000);
    const after = s.topRequest(["audio"]);
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    expect(after).not.toHaveBeenCalled();
  });

  /** 弹出提示后页面主框架立刻跨文档导航（= 提示被取消），返回这次请求的回调 */
  const cancelOnce = async (s: Awaited<ReturnType<typeof setup>>, mediaTypes: string[] = ["audio"]) => {
    const cb = s.topRequest(mediaTypes);
    await flush();
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    return cb;
  };

  it("取消的日志限速（R23-1）：页面循环「请求 → 刷新」时每 60 秒最多一条「已取消」日志，其余只计数，下一条带「另有 N 次」；决策不变（每次都拒绝）", async () => {
    const s = await setup();
    const cancelLines = () => s.activity().filter((x) => x.includes("权限提示已取消"));
    expect(await cancelOnce(s)).toHaveBeenCalledWith(false);
    expect(cancelLines()).toHaveLength(1);
    // 间隔 > 连续取消窗口：不会触发短冷却，只看日志限速
    await vi.advanceTimersByTimeAsync(CANCEL_STREAK_WINDOW_MS + 1_000);
    expect(await cancelOnce(s)).toHaveBeenCalledWith(false);
    expect(cancelLines()).toHaveLength(1); // 60 秒窗口内：吞掉、只计数
    await vi.advanceTimersByTimeAsync(CANCEL_STREAK_WINDOW_MS + 1_000);
    expect(await cancelOnce(s)).toHaveBeenCalledWith(false);
    expect(cancelLines()).toHaveLength(2);
    expect(cancelLines()[1]).toContain("另有 1 次同类取消，未逐条记录");
    expect(getPermissionState(s.session).cancelCooldown.size).toBe(0);
  });

  it("连续取消 3 次（间隔都在 30 秒内、中间没有用户回答）→ 10 秒短冷却：期间页面再请求静默拒绝（不弹、记 cancel-streak，话术是「连续被取消」不是「被拒绝」），冷却过了照常再弹（R23-1）", async () => {
    expect([CANCEL_STREAK_LIMIT, CANCEL_STREAK_WINDOW_MS, CANCEL_COOLDOWN_MS]).toEqual([3, 30_000, 10_000]);
    const s = await setup();
    const state = getPermissionState(s.session);
    for (let i = 0; i < CANCEL_STREAK_LIMIT - 1; i++) {
      expect(await cancelOnce(s)).toHaveBeenCalledWith(false);
      expect(state.cancelCooldown.size).toBe(0);
    }
    expect(state.cancelStreak.size).toBe(1);
    expect(await cancelOnce(s)).toHaveBeenCalledWith(false); // 第 3 次
    expect(state.cancelCooldown.size).toBe(1);
    expect(state.cancelStreak.size).toBe(0);
    expect(state.cooldown.size).toBe(0); // 不是「用户拒绝」的 30 秒冷却
    expect(s.activity().join("\n")).toContain(`连续被取消 ${CANCEL_STREAK_LIMIT} 次`);
    expect(s.activity().join("\n")).not.toContain("已拒绝");

    const inside = s.topRequest(["audio"]);
    await flush();
    expect(inside).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "cancel-streak", permission: "microphone", origin: A, count: 1 });
    expect(s.activity().join("\n")).toContain(BLOCK_REASON_TEXT["cancel-streak"]);
    // 10 秒的边界：差一点还在冷却里，过了就再弹
    await vi.advanceTimersByTimeAsync(CANCEL_COOLDOWN_MS - 100);
    s.topRequest(["audio"]);
    await flush();
    expect(s.session.prompts.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    const after = s.topRequest(["audio"]);
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    expect(after).not.toHaveBeenCalled();
  });

  it("连续取消的计数口径：间隔恰好 30 秒仍算连续、超过就从头数；按 tab + origin + 独立权限各算各的（只要麦克风 / 只要摄像头互不累加；同时问两项的请求对两项各记一次，P3-4）", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    await cancelOnce(s);
    await vi.advanceTimersByTimeAsync(CANCEL_STREAK_WINDOW_MS); // 恰好 30 秒
    await cancelOnce(s);
    expect([...state.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 2 })]);
    await vi.advanceTimersByTimeAsync(CANCEL_STREAK_WINDOW_MS + 1); // 超过窗口：重新从 1 数
    await cancelOnce(s);
    expect([...state.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 1 })]);
    expect(state.cancelCooldown.size).toBe(0);

    // 各算各的：只要麦克风 2 次 + 只要摄像头 2 次，互不累加（两个键各 n=2、都不到 3）
    const t = await setup();
    const tState = getPermissionState(t.session);
    for (const types of [["audio"], ["video"]]) {
      await cancelOnce(t, types);
      await cancelOnce(t, types);
    }
    expect(tState.cancelCooldown.size).toBe(0);
    expect(tState.cancelStreak.size).toBe(2);
    expect([...tState.cancelStreak.keys()].map((k) => k.split("|").pop()).sort()).toEqual(["camera", "microphone"]); // 计数键是独立权限，没有合称 media
    expect([...tState.cancelStreak.values()].every((v) => v.n === 2)).toBe(true);
    // 另一个 tab 上同 origin 的取消不累加（键里带 tabId）
    const other = await t.openTab(`${A}/page`);
    t.gate.bindTab(other);
    const cb = vi.fn();
    t.gate.handleRequest(other.wc, "media", cb, { requestingUrl: `${A}/page`, isMainFrame: true, mediaTypes: ["audio"] });
    await flush();
    other.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(tState.cancelCooldown.size).toBe(0);
    expect(tState.cancelStreak.size).toBe(3); // 新增的是另一个 tab 自己的计数（n=1），没有叠到第一个 tab 的麦克风键上
    expect([...tState.cancelStreak.values()].filter((v) => v.n === 1)).toHaveLength(1);
  });

  it("连续取消计数遇到时钟回拨（读数比上一次取消还小）：从头数，不把负的间隔当成「窗口内」累加（注入小时钟，第二十五轮评审测试 E）", async () => {
    const clock = { t: 100_000 };
    const s = await setup({}, `${A}/page`, { now: () => clock.t });
    const state = getPermissionState(s.session);
    await cancelOnce(s); // n = 1，at = 100000
    expect([...state.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 1, at: 100_000 })]);
    clock.t = 90_000; // 回拨 10 秒
    await cancelOnce(s);
    expect([...state.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 1, at: 90_000 })]); // 重新从 1 数（没有回拨守卫会得到 2）
    clock.t = 95_000; // 之后正常前进：接着数
    await cancelOnce(s);
    expect([...state.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 2, at: 95_000 })]);
    // 回拨留下的「未来」记录在表满时按过期处理（putBounded 的 isExpired 里 `t < v.at` 一支）由「三张表各有 100 条上限」那条用例覆盖
  });

  it("同时问麦克风 + 摄像头的请求连续取消 3 次（P3-4 / P3-7）：两项各记一份计数、同时进短冷却（两个独立权限的键）；期间只要麦克风 / 只要摄像头 / 两个一起的请求都被静默拒绝并记 cancel-streak；10 秒后恢复", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    const tails = (m: Map<string, unknown>) => [...m.keys()].map((k) => k.split("|").pop()).sort();
    for (let i = 0; i < CANCEL_STREAK_LIMIT - 1; i++) {
      expect(await cancelOnce(s, ["audio", "video"])).toHaveBeenCalledWith(false);
      expect(state.cancelCooldown.size).toBe(0);
    }
    expect(tails(state.cancelStreak)).toEqual(["camera", "microphone"]);
    expect([...state.cancelStreak.values()].every((v) => v.n === CANCEL_STREAK_LIMIT - 1)).toBe(true);
    expect(await cancelOnce(s, ["audio", "video"])).toHaveBeenCalledWith(false); // 第 3 次
    expect(tails(state.cancelCooldown)).toEqual(["camera", "microphone"]);
    // 第二十六轮 T-1：两项都到了上限——话术仍用本次请求的合称（不是只写其中一项）
    expect(s.activity().find((x) => x.includes("连续被取消"))).toContain("「摄像头 + 麦克风」");
    expect(state.cancelStreak.size).toBe(0);
    expect(state.cooldown.size).toBe(0); // 仍不是「用户拒绝」的 30 秒冷却
    for (const types of [["audio"], ["video"], ["audio", "video"]]) {
      const cb = s.topRequest(types);
      await flush();
      expect(cb, types.join("+")).toHaveBeenCalledWith(false);
    }
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked().every((e) => e.reason === "cancel-streak")).toBe(true);
    expect(s.blocked().map((e) => e.permission).sort()).toEqual(["camera", "media", "microphone"]);
    await vi.advanceTimersByTimeAsync(CANCEL_COOLDOWN_MS + 100);
    s.topRequest(["audio", "video"]);
    await flush();
    expect(s.session.prompts.size()).toBe(1); // 冷却过了：照常再弹
  });

  it("页面轮换请求形态（只要麦克风 / 麦克风 + 摄像头 / 只要麦克风）：按每项累计，第 3 次就触发——此前计数按合称 media 记、冷却按原子记，各数各的，要多轮才触发（P3-4）；触发时只有到了上限的那一项进短冷却，同一次请求里没到上限的另一项不被连坐（N-5）", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    await cancelOnce(s, ["audio"]); // 麦克风 1
    await cancelOnce(s, ["audio", "video"]); // 麦克风 2、摄像头 1
    expect(state.cancelCooldown.size).toBe(0);
    await cancelOnce(s, ["audio"]); // 麦克风 3 → 触发（这次只问了麦克风：只给麦克风进短冷却）
    expect([...state.cancelCooldown.keys()].map((k) => k.split("|").pop())).toEqual(["microphone"]);
    // 摄像头的计数（1）还在；之后页面换成「麦克风 + 摄像头」一起问：麦克风在冷却里 → 静默拒绝（任一项在冷却就拒）
    expect([...state.cancelStreak.keys()].map((k) => k.split("|").pop())).toEqual(["camera"]);
    const cb = s.topRequest(["audio", "video"]);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "cancel-streak", permission: "media" });

    // 反过来：前两次只问麦克风、第 3 次才是「麦克风 + 摄像头」——麦克风到 3 就触发（这次请求里摄像头只有 1 次，不能要求「每一项都到上限」）。
    // 第二十五轮 N-5：只有到了上限的麦克风进短冷却；摄像头（这次请求里只被问到 1 次）不被连坐——计数继续累加，要自己连续被取消到 3 次才触发
    const u = await setup();
    const uState = getPermissionState(u.session);
    const tailsOf = (m: Map<string, unknown>) => [...m.keys()].map((k) => k.split("|").pop()).sort();
    await cancelOnce(u, ["audio"]);
    await cancelOnce(u, ["audio"]);
    expect(uState.cancelCooldown.size).toBe(0);
    await cancelOnce(u, ["audio", "video"]);
    expect(tailsOf(uState.cancelCooldown)).toEqual(["microphone"]);
    // 日志话术与限速桶仍按「任一项到了上限」判（这次请求里麦克风到 3 = 触发，哪怕摄像头只有 1 次）：写的是「连续被取消 3 次」、不是普通的「已取消」
    // （N-5 之后 `tripped` 只剩这一个用处——第二十四轮的变异 H04「任一项 → 全部项」在第二十五轮最终源码上重跑时存活了，补上这条断言才又被杀）
    expect(u.activity().join("\n")).toContain(`连续被取消 ${CANCEL_STREAK_LIMIT} 次`);
    // 第二十六轮 T-1：话术只列真正进了短冷却的那一项。这里只有麦克风到了上限——写合称「摄像头 + 麦克风」会让人以为摄像头也被暂停了（它没有：下面单独问摄像头照常弹提示）
    const tripLine = u.activity().find((x) => x.includes("连续被取消")) ?? "";
    expect(tripLine).toContain("「麦克风」");
    expect(tripLine).not.toContain("摄像头");
    expect(tailsOf(uState.cancelStreak)).toEqual(["camera"]);
    expect([...uState.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 1 })]);
    // 摄像头没有被冷却：只要摄像头的请求照常弹提示（此前这里会被静默拒绝 10 秒）；这次请求被取消 → 摄像头计数 2
    const camOnly = u.topRequest(["video"]);
    await flush();
    expect(u.session.prompts.size()).toBe(1);
    expect(camOnly).not.toHaveBeenCalled();
    u.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(camOnly).toHaveBeenCalledWith(false);
    expect([...uState.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 2 })]);
    expect(tailsOf(uState.cancelCooldown)).toEqual(["microphone"]); // 摄像头 n = 2 还没到上限
    // 麦克风仍在冷却里：两个一起问被静默拒绝（任一项在冷却就拒）；而这一次被拒的请求不改摄像头的计数
    const both = u.topRequest(["audio", "video"]);
    await flush();
    expect(both).toHaveBeenCalledWith(false);
    expect(u.session.prompts.size()).toBe(0);
    expect(u.blocked()[0]).toMatchObject({ reason: "cancel-streak", permission: "media" });
    expect([...uState.cancelStreak.values()]).toEqual([expect.objectContaining({ n: 2 })]);
    // 摄像头自己再被取消一次 → n = 3 → 它也进短冷却
    await cancelOnce(u, ["video"]);
    expect(tailsOf(uState.cancelCooldown)).toEqual(["camera", "microphone"]);
    expect(uState.cancelStreak.size).toBe(0);
  });

  it("用户回答了（这里是允许一次）就结束这次请求**每一项**的连续取消计数——同时问两项时两项都清，不是只清第一项（P3-4）", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    await cancelOnce(s, ["audio", "video"]);
    await cancelOnce(s, ["audio", "video"]); // 两项各 n = 2
    expect([...state.cancelStreak.keys()].map((k) => k.split("|").pop()).sort()).toEqual(["camera", "microphone"]);
    s.topRequest(["audio", "video"]);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "allow" }); // 允许一次：不留授予、也不进冷却，但要结束计数
    await flush();
    expect(state.cancelStreak.size).toBe(0);
    // 再取消一次：从头数（两项 n = 1）、不会因为残留的 n = 2 在这第 3 次触发短冷却
    await cancelOnce(s, ["audio", "video"]);
    expect(state.cancelCooldown.size).toBe(0);
    expect([...state.cancelStreak.values()].every((v) => v.n === 1)).toBe(true);
    expect(state.cancelStreak.size).toBe(2);
  });

  it("冷却类的三张表各有 100 条上限（P3-4）：满了先剔掉已过期的、仍满再挤掉最老的一项——不整表清空，还在生效的冷却（含用户刚点的拒绝）不会被一并丢掉", async () => {
    const t0 = Date.now();
    // 过期项散布在队首 / 中间 / 队尾（第二十五轮评审测试 C：此前过期项全在插入序最老的那一端，「只从队首剔过期」的实现与「全表剔过期」分不开）
    const EXPIRED = [0, 1, 17, 38, 50, 66, 98, 99];
    const fillRows = (map: Map<string, unknown>, make: (expired: boolean, i: number) => unknown, expired: number[]) => {
      map.clear();
      for (let i = 0; i < 100; i++) map.set(`old|${A}|p${i}`, make(expired.includes(i), i));
    };
    /** 过期的一律没了、有效的一个不少（除指定被挤掉的） */
    const expectOnlyValidLeft = (map: Map<string, unknown>, expired: number[]) => {
      for (let i = 0; i < 100; i++) expect(map.has(`old|${A}|p${i}`), `p${i}`).toBe(!expired.includes(i));
    };
    const deny = async (s: Awaited<ReturnType<typeof setup>>) => {
      s.topRequest(["audio"]);
      await flush();
      s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
      await flush();
    };
    // ① 用户拒绝（state.cooldown）：8 条已过期（散布各处）、92 条有效 → 只剔过期的，有效的全留，新的写进去
    const s = await setup();
    const state = getPermissionState(s.session);
    fillRows(state.cooldown, (expired) => t0 + (expired ? -60_000 : 60_000), EXPIRED);
    await deny(s);
    expect(state.cooldown.size).toBe(100 - EXPIRED.length + 1);
    expectOnlyValidLeft(state.cooldown, EXPIRED);
    expect(state.cooldown.has(`${s.tab.id}|${A}|microphone`)).toBe(true);
    // 全部有效：挤掉最老的一项（p0），其余全留
    const s2 = await setup();
    const state2 = getPermissionState(s2.session);
    fillRows(state2.cooldown, () => t0 + 60_000, []);
    await deny(s2);
    expect(state2.cooldown.size).toBe(100);
    expect(state2.cooldown.has(`old|${A}|p0`)).toBe(false);
    expect(state2.cooldown.has(`old|${A}|p1`)).toBe(true);
    expect(state2.cooldown.has(`${s2.tab.id}|${A}|microphone`)).toBe(true);

    // ② 连续取消计数（state.cancelStreak）：窗口外的算过期；`at` 在「现在」之后（时钟回拨留下的）同样算过期（isExpired 里的 `t < v.at` 一支）
    const s3 = await setup();
    const state3 = getPermissionState(s3.session);
    fillRows(state3.cancelStreak, (expired, i) => ({ n: 1, at: !expired ? t0 : i % 2 === 1 ? t0 + 120_000 : t0 - CANCEL_STREAK_WINDOW_MS - 1_000 }), EXPIRED);
    await cancelOnce(s3);
    expect(state3.cancelStreak.size).toBe(100 - EXPIRED.length + 1);
    expectOnlyValidLeft(state3.cancelStreak, EXPIRED);
    // 全部有效：挤最老
    const s4 = await setup();
    const state4 = getPermissionState(s4.session);
    fillRows(state4.cancelStreak, () => ({ n: 1, at: t0 }), []);
    await cancelOnce(s4);
    expect(state4.cancelStreak.size).toBe(100);
    expect(state4.cancelStreak.has(`old|${A}|p0`)).toBe(false);
    expect(state4.cancelStreak.has(`old|${A}|p1`)).toBe(true);

    // ③ 短冷却（state.cancelCooldown）：触发那一次写入
    const s5 = await setup();
    const state5 = getPermissionState(s5.session);
    fillRows(state5.cancelCooldown, (expired) => t0 + (expired ? -60_000 : 60_000), EXPIRED);
    for (let i = 0; i < CANCEL_STREAK_LIMIT; i++) await cancelOnce(s5);
    expect(state5.cancelCooldown.size).toBe(100 - EXPIRED.length + 1);
    expectOnlyValidLeft(state5.cancelCooldown, EXPIRED);
    const s6 = await setup();
    const state6 = getPermissionState(s6.session);
    fillRows(state6.cancelCooldown, () => t0 + 60_000, []);
    for (let i = 0; i < CANCEL_STREAK_LIMIT; i++) await cancelOnce(s6);
    expect(state6.cancelCooldown.size).toBe(100);
    expect(state6.cancelCooldown.has(`old|${A}|p0`)).toBe(false);
    expect(state6.cancelCooldown.has(`old|${A}|p1`)).toBe(true);
  });

  it("putBounded（纯）：同键重写挪到末尾；没满不动别的；满了先剔过期再挤最老；全部过期时一条不剩只留新的", () => {
    const m = new Map<string, number>();
    putBounded(m, "a", 1, (v) => v < 0);
    putBounded(m, "b", 2, (v) => v < 0);
    putBounded(m, "a", 3, (v) => v < 0); // 重写：挪到末尾
    expect([...m.keys()]).toEqual(["b", "a"]);
    const big = new Map<string, number>();
    for (let i = 0; i < 100; i++) big.set(`k${i}`, i);
    putBounded(big, "new", 1000, (v) => v < 10); // 前 10 条过期 → 剔掉后 90 + 1
    expect(big.size).toBe(91);
    expect(big.has("k9")).toBe(false);
    expect(big.has("k10")).toBe(true);
    expect(big.has("new")).toBe(true);
    // 过期项散布在队首 / 中间 / 队尾（值 % 10 === 3 的 10 条：k3、k13 … k93，其中 k93 在靠后的位置；k0 / k99 不过期）：全表都要剔到，不只是从队首剔到第一个有效项为止
    const scattered = new Map<string, number>();
    for (let i = 0; i < 100; i++) scattered.set(`k${i}`, i);
    putBounded(scattered, "new", 1000, (v) => v % 10 === 3);
    expect(scattered.size).toBe(91);
    for (let i = 0; i < 100; i++) expect(scattered.has(`k${i}`), `k${i}`).toBe(i % 10 !== 3);
    expect([...scattered.keys()].at(-1)).toBe("new");
    // 末尾那一项过期（最新写进去的反而过期了）：照样剔掉，且不误挤最老的有效项
    const tail = new Map<string, number>();
    for (let i = 0; i < 100; i++) tail.set(`k${i}`, i === 99 ? -1 : 1);
    putBounded(tail, "new", 1, (v) => v < 0);
    expect(tail.size).toBe(100);
    expect(tail.has("k99")).toBe(false);
    expect(tail.has("k0")).toBe(true);
    const all = new Map<string, number>();
    for (let i = 0; i < 100; i++) all.set(`k${i}`, -1);
    putBounded(all, "fresh", 1, (v) => v < 0);
    expect([...all.keys()]).toEqual(["fresh"]);
    const none = new Map<string, number>();
    for (let i = 0; i < 100; i++) none.set(`k${i}`, 1);
    putBounded(none, "x", 1, () => false); // 没有过期的：挤掉最老的一项
    expect(none.size).toBe(100);
    expect(none.has("k0")).toBe(false);
    expect(none.has("x")).toBe(true);
    // 已有的键重写不会触发挤掉别人（先删后加，大小不变）
    putBounded(none, "k5", 7, () => false);
    expect(none.size).toBe(100);
    expect(none.has("k1")).toBe(true);
  });

  it("清除浏览数据带无痕分区名：什么都不清（持久授予 / 冷却 / 最近被拒都不动，P3-8）；带持久分区名或不带才清；冷却清的是全部（含无痕标签上的——只是反打扰的短期记忆，清掉的后果只是多问一次）", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    state.grants.allow(A, "geolocation", "user");
    state.grants.deny(A, "camera", "ai");
    s.topRequest(["video"]); // 显式拒绝记录 → 进「最近被拒」清单
    await flush();
    state.cooldown.set(`${s.tab.id}|${A}|microphone`, Date.now() + 60_000);
    state.cancelCooldown.set(`${s.tab.id}|${A}|camera`, Date.now() + 10_000);
    state.cancelStreak.set(`${s.tab.id}|${A}|microphone`, { n: 1, at: Date.now() });
    // 无痕标签上的冷却（第二十五轮评审测试 H：标题写了「含无痕标签上的」，此前用例体里没有任何无痕标签）：在一个真的无痕标签上点拒绝 → state.cooldown 里多一条带无痕 tab id 的键
    const inc = await s.openTab(`${A}/page`);
    inc.incognito = true;
    s.gate.bindTab(inc);
    s.gate.handleRequest(inc.wc, "media", vi.fn(), { requestingUrl: `${A}/page`, isMainFrame: true, mediaTypes: ["audio"] });
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "permission").id, { action: "deny" });
    await flush();
    const incKey = `${inc.id}|${A}|microphone`;
    expect(state.cooldown.has(incKey)).toBe(true);
    expect(s.blocked().filter((e) => e.incognito === true)).toHaveLength(0); // 这条是用户点的拒绝（冷却），不进「最近被自动拒绝」
    expect(s.blocked()).toHaveLength(1);
    state.onBrowsingDataCleared("flowship-incognito-1"); // 无痕分区名：不动
    expect(state.grants.get(A, "geolocation")).toBeDefined();
    expect(state.cooldown.size).toBe(2);
    expect(state.cooldown.has(incKey)).toBe(true);
    expect(state.cancelCooldown.size).toBe(1);
    expect(state.cancelStreak.size).toBe(1);
    expect(s.blocked()).toHaveLength(1);
    state.onBrowsingDataCleared("persist:flowship-browser"); // 持久分区名：清（冷却清的是全部，含无痕标签那条）
    expect(state.grants.get(A, "geolocation")).toBeUndefined();
    expect(state.cooldown.has(incKey)).toBe(false);
    expect(state.cooldown.size + state.cancelCooldown.size + state.cancelStreak.size).toBe(0);
    expect(s.blocked()).toHaveLength(0);
  });

  it("用户有回答（允许 / 拒绝）或超时，连续取消的计数就断了；reset / 清除浏览数据 / 会话销毁也清计数和短冷却（R23-1）", async () => {
    // 允许
    const a = await setup();
    const aState = getPermissionState(a.session);
    await cancelOnce(a);
    await cancelOnce(a);
    a.topRequest(["audio"]);
    await flush();
    a.session.prompts.answer(firstPrompt(a.session, "permission").id, { action: "allow" });
    await flush();
    expect(aState.cancelStreak.size).toBe(0);
    await cancelOnce(a);
    await cancelOnce(a); // 若计数没断，这里已经是第 4 次
    expect(aState.cancelCooldown.size).toBe(0);
    // 拒绝：进 30 秒冷却，计数同样清掉
    const d = await setup();
    const dState = getPermissionState(d.session);
    await cancelOnce(d);
    await cancelOnce(d);
    d.topRequest(["audio"]);
    await flush();
    d.session.prompts.answer(firstPrompt(d.session, "permission").id, { action: "deny" });
    await flush();
    expect(dState.cancelStreak.size).toBe(0);
    expect(dState.cooldown.size).toBe(1);
    // 超时
    const t = await setup();
    const tState = getPermissionState(t.session);
    await cancelOnce(t);
    await cancelOnce(t);
    t.topRequest(["audio"]);
    await flush();
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS + 10);
    expect(tState.cancelStreak.size).toBe(0);
    // 短冷却也随 reset / 清除浏览数据 / 销毁清掉
    const r = await setup();
    const rState = getPermissionState(r.session);
    for (let i = 0; i < CANCEL_STREAK_LIMIT; i++) await cancelOnce(r);
    expect(rState.cancelCooldown.size).toBe(1);
    rState.dropCooldown();
    expect(rState.cancelCooldown.size).toBe(0);
    for (let i = 0; i < CANCEL_STREAK_LIMIT; i++) await cancelOnce(r);
    expect(rState.cancelCooldown.size).toBe(1);
    rState.onBrowsingDataCleared();
    expect(rState.cancelCooldown.size).toBe(0);
    await cancelOnce(r);
    expect(rState.cancelStreak.size).toBe(1);
    r.session.destroy();
    expect(rState.cancelStreak.size).toBe(0);
    expect(rState.cancelCooldown.size).toBe(0);
  });

  it("dropCooldown(scope)（R23-6）：带 origin / permissions 只清键里匹配的冷却 / 短冷却 / 取消计数（三张表的键都是独立权限名，门不产生合称 media 的键）；permissions 给两项（ops 的 reset media 展开成这样）两项都清；不带参数全清；别的站点的不动", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    const until = Date.now() + 60_000;
    const k = (origin: string, perm: string) => `${s.tab.id}|${origin}|${perm}`;
    const fill = () => {
      state.cooldown.clear();
      state.cancelCooldown.clear();
      state.cancelStreak.clear();
      for (const key of [k(A, "microphone"), k(A, "camera"), k(B, "microphone"), k(B, "geolocation")]) state.cooldown.set(key, until);
      for (const key of [k(A, "microphone"), k(B, "microphone")]) state.cancelCooldown.set(key, until);
      for (const key of [k(A, "microphone"), k(A, "camera"), k(B, "camera"), k(A, "geolocation")]) state.cancelStreak.set(key, { n: 1, at: Date.now() });
    };
    const keysOf = () => [[...state.cooldown.keys()], [...state.cancelCooldown.keys()], [...state.cancelStreak.keys()]].map((x) => x.map((key) => key.slice(s.tab.id.length + 1)));

    fill();
    state.dropCooldown({ origin: A });
    expect(keysOf()).toEqual([[`${B}|microphone`, `${B}|geolocation`], [`${B}|microphone`], [`${B}|camera`]]);

    fill();
    state.dropCooldown({ permissions: ["microphone"] });
    // microphone 键（两个站点）清；摄像头 / 定位的不动
    expect(keysOf()).toEqual([[`${A}|camera`, `${B}|geolocation`], [], [`${A}|camera`, `${B}|camera`, `${A}|geolocation`]]);

    // origin 与 permissions 同时给 = 两个条件都要满足：只有 A 的摄像头键清；B 的摄像头键、A 的麦克风 / 定位键不动
    fill();
    state.dropCooldown({ origin: A, permissions: ["camera"] });
    expect(keysOf()).toEqual([
      [`${A}|microphone`, `${B}|microphone`, `${B}|geolocation`],
      [`${A}|microphone`, `${B}|microphone`],
      [`${A}|microphone`, `${B}|camera`, `${A}|geolocation`],
    ]);

    // permissions 给两项：两项（所有站点）都清，定位不动
    fill();
    state.dropCooldown({ permissions: ["microphone", "camera"] });
    expect(keysOf()).toEqual([[`${B}|geolocation`], [], [`${A}|geolocation`]]);

    fill();
    state.dropCooldown({});
    expect(keysOf()).toEqual([[], [], []]);
    fill();
    state.dropCooldown();
    expect(keysOf()).toEqual([[], [], []]);
  });

  it("拒绝的 30 秒冷却与取消的 10 秒短冷却是两张表：两者同时在时先报「cooldown」；短冷却先过期后，30 秒的照样在，不被缩短", async () => {
    const s = await setup();
    const state = getPermissionState(s.session);
    const key = `${s.tab.id}|${A}|microphone`;
    state.cooldown.set(key, Date.now() + PERMISSION_COOLDOWN_MS);
    state.cancelCooldown.set(key, Date.now() + CANCEL_COOLDOWN_MS);
    s.topRequest(["audio"]);
    await flush();
    expect(s.blocked()[0]).toMatchObject({ reason: "cooldown" });
    await vi.advanceTimersByTimeAsync(CANCEL_COOLDOWN_MS + 100); // 短冷却过了，30 秒的还在
    s.topRequest(["audio"]);
    await flush();
    expect(s.session.prompts.size()).toBe(0);
    expect(s.blocked()[0]).toMatchObject({ reason: "cooldown", count: 2 });
  });
});

describe("delegationProbeSource：在页内（这里用 vm 模拟）取 allowsFeature", () => {
  const run = (features: string[], doc: unknown, loc: unknown = { href: `${B}/f` }) => vm.runInNewContext(delegationProbeSource(features), { document: doc, location: loc });

  it("全部 feature 都被允许 → ok:true；有一个不允许 → ok:false；带上 href", () => {
    const policy = { allowsFeature: (n: string) => n === "microphone" };
    expect(run(["microphone"], { permissionsPolicy: policy })).toEqual({ href: `${B}/f`, ok: true });
    expect(run(["microphone", "camera"], { permissionsPolicy: policy })).toEqual({ href: `${B}/f`, ok: false });
  });

  it("只认严格的 true（真值但不是 true 不算）；老 API featurePolicy 也认；都没有 / 抛错 → null", () => {
    expect(run(["microphone"], { permissionsPolicy: { allowsFeature: () => "yes" } })).toEqual({ href: `${B}/f`, ok: false });
    expect(run(["camera"], { featurePolicy: { allowsFeature: () => true } })).toEqual({ href: `${B}/f`, ok: true });
    expect(run(["camera"], {})).toBeNull();
    expect(
      run(["camera"], {
        permissionsPolicy: {
          allowsFeature: () => {
            throw new Error("x");
          },
        },
      }),
    ).toBeNull();
  });
});

describe("证据范围：Electron 版本钉子（R23-8）", () => {
  /**
   * 权限闸靠的几处行为是 Chromium / Electron 没有文档承诺的：检查处理器与 WebRTC 的 ICE 收集共用同一条媒体检查（回 true 就泄露真实 IP）、
   * PermissionStatus 没有变化通知（授予后不自己更新、要页面再 query 才更新）、跨站 iframe 里页内桩的安装时序。它们只在这个版本的真 Electron（macOS）上
   * 用 scripts/browser-e2e/r21-mic-prompt.cjs 等脚本验证过。版本变了这条红 = 提醒「先重新验证、再改常量」，不是让你直接把常量改掉。
   */
  const VERIFIED_ELECTRON_VERSION = "42.4.0";
  const HOW_TO_REVERIFY =
    "请先在 macOS 上用真 Electron 重跑 scripts/browser-e2e/r21-mic-prompt.cjs（唯一的哨兵：ICE 不泄露 / 桩时序 / 授予后状态的更新语义），" +
    "再跑 r12-speaker-select.cjs、e2-p1-permissions-net.cjs；全部通过（SKIP 要看原因，不算通过）后，把本测试里的 VERIFIED_ELECTRON_VERSION 改成新版本，" +
    "并在 docs/BROWSER-AUTOMATION.md §19 记下新版本与结果。";
  /** 本机装的 electron 版本：没装（只跑服务端测试的 CI）= null；装了却读不出版本 = 直接抛（不静默当「没装」，P3-7） */
  const installed = (() => {
    try {
      const v = (createRequire(import.meta.url)("electron/package.json") as { version?: string }).version;
      if (typeof v !== "string" || v === "") throw new Error("electron/package.json 里没有 version 字段");
      return v;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return null;
      throw err;
    }
  })();

  it("锁文件（pnpm-lock.yaml）里 electron 解析到的版本与权限闸验证过的版本一致——无论本机装没装 electron 都判（装不上 / 读不到不会让它静默变绿，P3-7）", () => {
    const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
    // importers 里本仓自己对 electron 的依赖：`      electron:\n        specifier: ^42.4.0\n        version: 42.4.0`
    // 换行写成 `\r?\n`：Windows 上开了 autocrlf 的检出，锁文件是 CRLF，硬编码 `\n` 会找不到条目而假红（第二十五轮评审测试 I）
    const entry = /\r?\n {6}electron:\r?\n {8}specifier: [^\r\n]+\r?\n {8}version: ([0-9][^\s(]*)/;
    const m = entry.exec(lock);
    expect(m, "pnpm-lock.yaml 里找不到 electron 的 importers 条目（格式变了？先改这个解析再谈版本）").not.toBeNull();
    expect(m?.[1], `锁文件里 electron 解析到 ${m?.[1]}，而内置浏览器的权限闸只在 ${VERIFIED_ELECTRON_VERSION} 上验证过。${HOW_TO_REVERIFY}`).toBe(VERIFIED_ELECTRON_VERSION);
    // 同一份内容换成 CRLF（模拟 Windows autocrlf 检出）也要解析出同一个版本——没有这一条，把正则改回只认 `\n` 也是绿的
    expect(entry.exec(lock.replace(/\r?\n/g, "\r\n"))?.[1]).toBe(m?.[1]);
  });

  it.skipIf(installed === null)("本机安装的 electron 与权限闸验证过的版本一致（没装 electron 时由上一条的锁文件判断兜底）", () => {
    expect(
      installed,
      `本机 electron 是 ${installed}，而内置浏览器的权限闸（权限提示、麦克风 ICE 防泄露、页内查询桩）只在 ${VERIFIED_ELECTRON_VERSION} 上验证过。${HOW_TO_REVERIFY}`,
    ).toBe(VERIFIED_ELECTRON_VERSION);
  });
});

describe("关键常量的字面量（P3-7：改错了要红；其余常量测试里都是引用符号本身，改成别的值也照样绿）", () => {
  it("委托核对 / 自愈 / 提示 / 冷却的时限与上限", () => {
    expect(FRAME_DELEGATION_TOTAL_MS).toBe(3000); // 权限回调最多悬挂这么久（硬时限）
    expect(FRAME_DELEGATION_POLL_MS).toBe(150);
    expect(FRAME_DELEGATION_EVAL_TIMEOUT_MS).toBe(1500);
    expect(CDP_HEAL_MIN_INTERVAL_MS).toBe(5000); // 两次自愈触发的最小间隔：失败的重连不能被页面的权限请求循环触发成风暴
    expect(PERMISSION_PROMPT_TIMEOUT_MS).toBe(60_000);
    expect(PERMISSION_COOLDOWN_MS).toBe(30_000);
    expect([CANCEL_STREAK_LIMIT, CANCEL_STREAK_WINDOW_MS, CANCEL_COOLDOWN_MS]).toEqual([3, 30_000, 10_000]);
    expect(MAX_RECENT_BLOCKED).toBe(10);
  });
});
