/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 session 是刻意的，被测 .mjs 无类型声明 */
/**
 * E2·P3 / A1：ops/storage.mjs 主进程 op——参数规整、开关（storageAccess）在主进程独立判、值脱敏、Flowship origin 排除、
 * 接管期间 USER_CONTROL、导出文件路径 / 权限、导入文件校验、clear_site、活动日志不写值。
 * 真实 BrowserSession + 假 tab（内存 cookie jar / DOMStorage / IndexedDB）；真 Electron 行为见 scripts/browser-e2e/e2-p3-storage-evaluate.cjs。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTRA_OPS, OP_MODULES } from "../electron-app/browser/ops/index.mjs";
import { OPS, createHandlers } from "../electron-app/browser/ops/storage.mjs";
import { STORAGE_ACTIONS, STORAGE_REVEAL_ACTIONS, STORAGE_WRITE_ACTIONS, defaultStateName } from "../electron-app/browser/storage-policy.mjs";
import { makeStorageEnv, type StorageEnv } from "./helpers/browser-e2-p3-storage-fake";

const isWin = process.platform === "win32";
const SECRET = "Sup3rSecret-VALUE-0123456789";
const SECRET2 = "AnotherSecret-ZZZZ-9876543210";
const APP_HOST = "flowship.app.test";
const NOW = 1_700_000_000_000;

const envs: StorageEnv[] = [];
const mk = async (opts: Parameters<typeof makeStorageEnv>[0] = {}) => {
  const e = await makeStorageEnv({ extraAppHosts: [APP_HOST], now: () => NOW, ...opts });
  envs.push(e);
  return e;
};
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

const seedCookies = () => [
  { name: "sid", value: SECRET, domain: ".a.test", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_900_000_000 },
  { name: "theme", value: "dark", domain: "a.test" },
  { name: "other", value: SECRET2, domain: "other.test" },
  { name: "flow", value: "app-cookie", domain: APP_HOST },
];

const rej = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe("P3·注册与参数规整", () => {
  it("OPS = [storage]，进了 EXTRA_OPS，且与别的模块的 op 互不相交", () => {
    expect([...OPS]).toEqual(["storage"]);
    expect(EXTRA_OPS).toContain("storage");
    const all = OP_MODULES.flatMap((m: any) => [...m.OPS]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("action 必填且必须在枚举里；未知 action → BAD_ARGS", async () => {
    const e = await mk();
    expect(() => e.norm({})).toThrow(/action/);
    expect(() => e.norm({ action: "cookies_steal" })).toThrow(/action/);
    for (const a of STORAGE_ACTIONS) {
      const base: Record<string, unknown> = { action: a, name: "n", value: "v", area: "local", key: "k", file: "f" };
      expect(() => e.norm(base), a).not.toThrow();
    }
  });

  it("reveal 只对读类动作生效；url / domain / all 只能给一个；name / key / area / file 按动作必填", async () => {
    const e = await mk();
    expect(e.norm({ action: "cookies_list", reveal: true })).toMatchObject({ reveal: true });
    expect(e.norm({ action: "cookies_list" })).not.toHaveProperty("reveal");
    expect(e.norm({ action: "cookies_clear", reveal: true })).not.toHaveProperty("reveal");
    expect(e.norm({ action: "idb_list", reveal: true })).not.toHaveProperty("reveal");
    expect(() => e.norm({ action: "cookies_list", url: "https://a.test/", domain: "a.test" })).toThrow(/只能给一个/);
    expect(() => e.norm({ action: "cookies_list", all: true, domain: "a.test" })).toThrow(/只能给一个/);
    expect(() => e.norm({ action: "cookies_get" })).toThrow(/name/);
    expect(() => e.norm({ action: "cookies_delete" })).toThrow(/name/);
    expect(() => e.norm({ action: "storage_list" })).toThrow(/area/);
    expect(() => e.norm({ action: "storage_list", area: "cloud" })).toThrow(/area/);
    expect(() => e.norm({ action: "storage_get", area: "local" })).toThrow(/key/);
    expect(() => e.norm({ action: "storage_set", area: "local", key: "k" })).toThrow(/value/);
    expect(e.norm({ action: "storage_set", area: "session", key: "k", value: "" })).toMatchObject({ area: "session", key: "k", value: "" });
    expect(() => e.norm({ action: "import_state" })).toThrow(/file/);
    expect(e.norm({ action: "export_state", includeStorage: false })).toMatchObject({ includeStorage: false });
    expect(e.norm({ action: "export_state" })).not.toHaveProperty("includeStorage");
    expect(e.norm({ action: "cookies_list", tabId: "t7" })).toMatchObject({ tabId: "t7" });
  });

  it("cookies_set：在 normalize 里就校验（非法 cookie 在任何副作用之前被拒），规整后的 cookie 放进 args", async () => {
    const e = await mk();
    const a: any = e.norm({ action: "cookies_set", name: "sid", value: "v", domain: ".A.test", secure: true, httpOnly: true, sameSite: "none", expires: 1_900_000_000 });
    expect(a.cookie).toEqual({ name: "sid", value: "v", domain: ".a.test", path: "/", secure: true, httpOnly: true, sameSite: "none", expires: 1_900_000_000 });
    expect(() => e.norm({ action: "cookies_set", name: "a=b", value: "v" })).toThrow();
    expect(() => e.norm({ action: "cookies_set", name: "a", value: "x;y" })).toThrow();
    expect(() => e.norm({ action: "cookies_set", name: "a", value: "v", sameSite: "none" })).toThrow(/secure/);
    expect(() => e.norm({ action: "cookies_set", name: "a", value: "v", domain: "evil.com/x" })).toThrow();
    expect(() => e.norm({ action: "cookies_set", name: "a" })).toThrow(/value/);
    expect((e.norm({ action: "cookies_set", name: "a", value: "" }) as any).cookie.value).toBe("");
  });
});

describe("P3·开关 storageAccess 在主进程独立判（不信 server 侧）", () => {
  const writeArgs: Record<string, Record<string, unknown>> = {
    cookies_set: { name: "a", value: "v" },
    cookies_delete: { name: "sid" },
    cookies_clear: {},
    storage_set: { area: "local", key: "k", value: "v" },
    storage_remove: { area: "local", key: "k" },
    storage_clear: { area: "local" },
    export_state: { file: "x" },
    import_state: { file: "x" },
    clear_site: {},
  };

  it("写 / 删 / 清 / 导入 / 导出的每个动作：开关关着一律 ACCESS_DISABLED，且不碰 jar / CDP / 磁盘 / 会话队列", async () => {
    for (const closed of [{ storageAccess: false }, {}, { storageAccess: "true" }, { storageAccess: 1 }, { storageAccess: undefined }]) {
      const e = await mk({ config: { storageAccess: undefined, ...closed } });
      const runAction = vi.spyOn(e.session, "runAction");
      expect(Object.keys(writeArgs).sort()).toEqual([...STORAGE_WRITE_ACTIONS].sort());
      for (const [action, extra] of Object.entries(writeArgs)) {
        await rej(e.call({ action, ...extra }), "ACCESS_DISABLED");
      }
      expect(runAction).not.toHaveBeenCalled();
      expect(e.jar.set).not.toHaveBeenCalled();
      expect(e.jar.remove).not.toHaveBeenCalled();
      expect(e.jar.get).not.toHaveBeenCalled();
      expect(e.cdp.calls).toEqual([]);
      expect(e.clearStorageData).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(e.userData, "data"))).toBe(false);
      expect(e.activitySummaries()).toEqual([]);
    }
  });

  it("读类动作带 reveal：开关关着 ACCESS_DISABLED（四个读动作都是）；错误文案指向设置、不泄漏任何值", async () => {
    const e = await mk({ config: { storageAccess: false }, cookies: seedCookies(), local: { token: SECRET } });
    const args: Record<string, Record<string, unknown>> = {
      cookies_list: {},
      cookies_get: { name: "sid" },
      storage_list: { area: "local" },
      storage_get: { area: "local", key: "token" },
    };
    expect(Object.keys(args).sort()).toEqual([...STORAGE_REVEAL_ACTIONS].sort());
    for (const [action, extra] of Object.entries(args)) {
      const err: any = await e.call({ action, reveal: true, ...extra }).then(
        () => null,
        (x: unknown) => x,
      );
      expect(err?.code, action).toBe("ACCESS_DISABLED");
      expect(err.message).toContain("设置");
      expect(err.message).toContain("允许 AI 读写登录态");
      expect(err.message).not.toContain(SECRET);
    }
    expect(e.jar.get).not.toHaveBeenCalled();
    expect(e.cdp.calls).toEqual([]);
  });

  it("开关先于会话判断：关着时 requireSession 都不会被调用（不会为一个被拒的请求去建会话）", async () => {
    const requireSession = vi.fn(() => {
      throw new Error("不该被调用");
    });
    const h: any = createHandlers({ requireSession, getConfig: () => ({ storageAccess: false }), abortable: (p: any) => p, scheduleState: vi.fn(), app: { getPath: () => os.tmpdir() }, checkAiUrl: (u: string) => u, electron: {}, log: () => {} } as any);
    await rej(h.storage("t", { action: "cookies_clear" }), "ACCESS_DISABLED");
    await rej(h.storage("t", { action: "cookies_list", reveal: true }), "ACCESS_DISABLED");
    expect(requireSession).not.toHaveBeenCalled();
  });

  it("R6-27：写操作进了动作队列排队，等待期间用户把开关关了 → 真正执行前再判一次，ACCESS_DISABLED，jar / CDP / 磁盘都不动", async () => {
    const e = await mk({ config: { storageAccess: true } });
    // 用一个「占着队列」的动作把后面的写操作堵在队列里
    let release!: () => void;
    const holder = e.session.runAction({ op: "hold" }, () => new Promise<void>((res) => (release = res)));
    await Promise.resolve();
    const queued = e.call({ action: "cookies_set", name: "late", value: "v" });
    const queuedExport = e.call({ action: "export_state", file: "late" });
    // 此时两个写操作都已通过入口判定（开关是开的），正在排队
    e.cfg.storageAccess = false;
    release();
    await holder;
    await rej(queued, "ACCESS_DISABLED");
    await rej(queuedExport, "ACCESS_DISABLED");
    expect(e.jar.set).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(e.userData, "data"))).toBe(false);
  });

  it("开关关着时只读（不带 reveal）照常可用：名称 / 属性 / 脱敏值；idb_list 也可用", async () => {
    const e = await mk({ config: { storageAccess: false }, cookies: seedCookies(), local: { token: SECRET }, idb: [{ name: "db1", stores: ["s1"] }] });
    const c = await e.call({ action: "cookies_list" });
    expect(c.cookies.map((x: any) => x.name).sort()).toEqual(["sid", "theme"]);
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(c.revealed).toBe(false);
    const s = await e.call({ action: "storage_list", area: "local" });
    expect(s.items).toEqual([{ key: "token", size: SECRET.length, valueHint: `[${SECRET.length} 字符，前 4 位「Sup3」…]` }]);
    const g = await e.call({ action: "storage_get", area: "local", key: "token" });
    expect(g.exists).toBe(true);
    expect(JSON.stringify(g)).not.toContain(SECRET);
    const i = await e.call({ action: "idb_list" });
    expect(i.databases[0]).toMatchObject({ name: "db1", objectStores: [{ name: "s1" }] });
    expect(e.activitySummaries()).toEqual([]); // 读脱敏信息不刷活动日志
  });

  it("开关打开后：reveal 返回明文；只有 storageAccess === true 才算打开", async () => {
    const e = await mk({ cookies: seedCookies(), local: { token: SECRET } });
    const c = await e.call({ action: "cookies_get", name: "sid", reveal: true });
    expect(c.revealed).toBe(true);
    expect(c.cookies[0]).toMatchObject({ name: "sid", value: SECRET, httpOnly: true, secure: true });
    const s = await e.call({ action: "storage_get", area: "local", key: "token", reveal: true });
    expect(s.item.value).toBe(SECRET);
    // 明文读取写了活动日志（actor ai），日志里没有值
    const sums = e.activitySummaries();
    expect(sums.some((x) => x.includes("明文值"))).toBe(true);
    expect(JSON.stringify(sums)).not.toContain(SECRET);
  });
});

describe("P3·列表：默认只给名称与属性；Flowship origin 排除", () => {
  it("默认范围 = 当前页面所在站点；HttpOnly / Secure / SameSite / 过期都在；值脱敏", async () => {
    const e = await mk({ cookies: seedCookies() });
    const r = await e.call({ action: "cookies_list" });
    expect(r).toMatchObject({ action: "cookies_list", scope: "a.test", total: 2, truncated: false, revealed: false });
    const sid = r.cookies.find((c: any) => c.name === "sid");
    expect(sid).toMatchObject({ domain: ".a.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expires: 1_900_000_000 });
    expect(sid).not.toHaveProperty("value");
    expect(sid.valueHint).toBe(`[${SECRET.length} 字符，前 4 位「Sup3」…]`);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET2);
    expect(r.tabId).toBe("t1");
  });

  it("all / domain / url 范围；all 也会排除 Flowship 域的 cookie", async () => {
    const e = await mk({ cookies: seedCookies() });
    const all = await e.call({ action: "cookies_list", all: true });
    expect(all.cookies.map((c: any) => c.name).sort()).toEqual(["other", "sid", "theme"]);
    expect(all.cookies.some((c: any) => c.domain.includes(APP_HOST))).toBe(false);
    const dom = await e.call({ action: "cookies_list", domain: "other.test" });
    expect(dom.cookies.map((c: any) => c.name)).toEqual(["other"]);
    const byUrl = await e.call({ action: "cookies_list", url: "https://other.test/x" });
    expect(byUrl.cookies.map((c: any) => c.name)).toEqual(["other"]);
    const get = await e.call({ action: "cookies_get", name: "theme" });
    expect(get.cookies.map((c: any) => c.name)).toEqual(["theme"]);
  });

  it("Flowship origin 被拒：url（回环 + 应用端口 / 已知端口）、domain（应用域名）、当前页面本身", async () => {
    const e = await mk({ cookies: seedCookies() });
    for (const url of ["http://127.0.0.1:8876/", "http://localhost:8676/x", "http://[::1]:8776/", "http://evil@127.0.0.1:8876/"]) {
      await rej(e.call({ action: "cookies_list", url }), "URL_BLOCKED");
      await rej(e.call({ action: "cookies_get", name: "sid", url }), "URL_BLOCKED");
    }
    await rej(e.call({ action: "cookies_list", domain: APP_HOST }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_list", domain: `.${APP_HOST}` }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_list", domain: "bad domain" }), "BAD_ARGS");
    // 非 http(s) 一律拒
    await rej(e.call({ action: "cookies_list", url: "file:///etc/passwd" }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_list", url: "javascript:alert(1)" }), "URL_BLOCKED");

    // 当前页面就是 Flowship：默认范围 / storage / idb / clear_site 全都被拒
    const f = await mk({ url: "http://127.0.0.1:8876/app", cookies: seedCookies(), local: { k: "v" } });
    for (const a of [{ action: "cookies_list" }, { action: "storage_list", area: "local" }, { action: "idb_list" }, { action: "clear_site" }, { action: "export_state" }]) {
      await rej(f.call(a), "URL_BLOCKED");
    }
    expect(f.clearStorageData).not.toHaveBeenCalled();
  });

  it("空白页：没有站点可操作 → BAD_ARGS（指向 browser_navigate）", async () => {
    const e = await mk({ url: "about:blank" });
    const err: any = await e.call({ action: "storage_list", area: "local" }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err.code).toBe("BAD_ARGS");
    expect(err.message).toContain("browser_navigate");
  });

  it("超过 200 条只给前 200 条，并标注 truncated 与总数", async () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ name: `c${String(i).padStart(3, "0")}`, value: "v", domain: "a.test" }));
    const e = await mk({ cookies: many });
    const r = await e.call({ action: "cookies_list" });
    expect(r.cookies).toHaveLength(200);
    expect(r.total).toBe(230);
    expect(r.truncated).toBe(true);
  });

  it("不存在的 tabId → TAB_NOT_FOUND", async () => {
    const e = await mk();
    await rej(e.call({ action: "cookies_list", tabId: "t99" }), "TAB_NOT_FOUND");
  });
});

describe("P3·用户接管期间：写类 USER_CONTROL；读明文也拒；读脱敏信息照常", () => {
  it("controller=user：写 / 删 / 清 / 导入 / 导出 → USER_CONTROL，什么都没动", async () => {
    const e = await mk({ cookies: seedCookies(), local: { k: "v" } });
    e.session.controller = "user";
    for (const [action, extra] of Object.entries({
      cookies_set: { name: "a", value: "v" },
      cookies_delete: { name: "sid" },
      cookies_clear: {},
      storage_set: { area: "local", key: "k", value: "v" },
      storage_remove: { area: "local", key: "k" },
      storage_clear: { area: "local" },
      export_state: { file: "x" },
      import_state: { file: "x" },
      clear_site: {},
    })) {
      await rej(e.call({ action, ...extra }), "USER_CONTROL");
    }
    expect(e.jar.set).not.toHaveBeenCalled();
    expect(e.jar.remove).not.toHaveBeenCalled();
    expect(e.clearStorageData).not.toHaveBeenCalled();
    expect(fs.existsSync(e.stateDir)).toBe(false);
    // 读明文也拒；不带 reveal 的名称 / 属性列表照常
    await rej(e.call({ action: "cookies_list", reveal: true }), "USER_CONTROL");
    await rej(e.call({ action: "storage_get", area: "local", key: "k", reveal: true }), "USER_CONTROL");
    const ok = await e.call({ action: "cookies_list" });
    expect(ok.cookies.length).toBeGreaterThan(0);
    expect(e.session.controller).toBe("user");
  });
});

describe("P3·cookies_set / delete / clear", () => {
  it("cookies_set：写进 jar，回读确认，返回脱敏描述；活动日志有名字、没有值", async () => {
    const e = await mk();
    const r = await e.call({ action: "cookies_set", name: "token", value: SECRET, secure: true, httpOnly: true, sameSite: "lax", expires: 1_900_000_000 });
    expect(r.action).toBe("cookies_set");
    expect(r.set).toMatchObject({ name: "token", secure: true, httpOnly: true, sameSite: "lax", expires: 1_900_000_000 });
    expect(r.set).not.toHaveProperty("value");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(e.store.find((c) => c.name === "token")?.value).toBe(SECRET);
    const sums = e.activitySummaries();
    expect(sums.some((x) => x.includes("token"))).toBe(true);
    expect(JSON.stringify(sums)).not.toContain(SECRET);
  });

  it("secure cookie + http 页面：改用同主机 https URL 写入（不会静默失败）", async () => {
    const e = await mk({ url: "http://a.test/home" });
    await e.call({ action: "cookies_set", name: "s", value: "v", secure: true });
    expect(e.jar.set.mock.calls[0][0].url).toBe("https://a.test/home");
  });

  it("指定 domain：必须域匹配目标主机；域 cookie 回读按带点 / 不带点归一", async () => {
    const e = await mk();
    const ok = await e.call({ action: "cookies_set", name: "d", value: "v", domain: "a.test" });
    expect(ok.set.domain).toBe(".a.test");
    await rej(e.call({ action: "cookies_set", name: "d2", value: "v", domain: "b.test" }), "BAD_ARGS");
    const sub = await mk({ url: "https://www.a.test/x" });
    const s = await sub.call({ action: "cookies_set", name: "d3", value: "v", domain: ".a.test" });
    expect(s.set.domain).toBe(".a.test");
  });

  it("Flowship origin：url 指向应用 / domain 是应用域名 → URL_BLOCKED，jar 不被写", async () => {
    const e = await mk();
    await rej(e.call({ action: "cookies_set", name: "x", value: "v", url: "http://127.0.0.1:8876/" }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_set", name: "x", value: "v", url: "http://localhost:8676/" }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_set", name: "x", value: "v", domain: APP_HOST }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_set", name: "x", value: "v", domain: `.${APP_HOST}`, url: `https://${APP_HOST}/` }), "URL_BLOCKED");
    expect(e.jar.set).not.toHaveBeenCalled();
  });

  it("浏览器悄悄拒绝（回读不到）→ BAD_ARGS 说清楚原因，不假装成功，也不写活动日志", async () => {
    const e = await mk();
    e.jarState.silentReject = true;
    const err: any = await e.call({ action: "cookies_set", name: "x", value: "v" }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err.code).toBe("BAD_ARGS");
    expect(err.message).toContain("浏览器拒绝了这个 cookie");
    expect(e.activitySummaries()).toEqual([]);
  });

  it("cookies_delete：只删当前站点里指定名字的；Flowship 域的 cookie 碰都不碰", async () => {
    const e = await mk({ cookies: [...seedCookies(), { name: "sid", value: "other-sid", domain: "other.test" }] });
    const r = await e.call({ action: "cookies_delete", name: "sid" });
    expect(r).toMatchObject({ action: "cookies_delete", scope: "a.test", removed: 1, remaining: 0 });
    expect(e.store.map((c) => `${c.domain}|${c.name}`).sort()).toEqual([`${APP_HOST}|flow`, "a.test|theme", "other.test|other", "other.test|sid"].sort());
    expect(e.activitySummaries().some((x) => x.includes("sid"))).toBe(true);
  });

  it("cookies_clear：默认只清当前站点；all=true 清所有，但 Flowship 域的 cookie 留着", async () => {
    const e = await mk({ cookies: seedCookies() });
    const r = await e.call({ action: "cookies_clear" });
    expect(r).toMatchObject({ removed: 2, remaining: 0, scope: "a.test" });
    expect(e.store.map((c) => c.name).sort()).toEqual(["flow", "other"]);
    const all = await e.call({ action: "cookies_clear", all: true });
    expect(all.removed).toBe(1);
    expect(e.store.map((c) => c.name)).toEqual(["flow"]); // 应用自己的 cookie 永远不被 AI 动
    await rej(e.call({ action: "cookies_clear", domain: APP_HOST }), "URL_BLOCKED");
    await rej(e.call({ action: "cookies_delete", name: "flow", domain: APP_HOST }), "URL_BLOCKED");
    expect(e.store.map((c) => c.name)).toEqual(["flow"]);
  });
});

describe("P3·localStorage / sessionStorage / IndexedDB（CDP）", () => {
  it("storage_list / get：按 area 区分 local / session；用 storageKey 标识；用完 disable", async () => {
    const e = await mk({ local: { b: "2", a: SECRET }, session: { s: "1" } });
    const l = await e.call({ action: "storage_list", area: "local" });
    expect(l).toMatchObject({ area: "local", origin: "https://a.test", total: 2, truncated: false, revealed: false });
    expect(l.items.map((i: any) => i.key)).toEqual(["a", "b"]);
    expect(JSON.stringify(l)).not.toContain(SECRET);
    const s = await e.call({ action: "storage_list", area: "session" });
    expect(s.items.map((i: any) => i.key)).toEqual(["s"]);
    const miss = await e.call({ action: "storage_get", area: "local", key: "nope" });
    expect(miss).toMatchObject({ exists: false, revealed: false });
    expect(miss).not.toHaveProperty("item");
    const get = e.cdp.calls.find((c) => c.method === "DOMStorage.getDOMStorageItems");
    expect(get?.params.storageId).toEqual({ storageKey: "https://a.test/", isLocalStorage: true });
    const methods = e.cdp.calls.map((c) => c.method);
    expect(methods.filter((m) => m === "DOMStorage.enable").length).toBe(methods.filter((m) => m === "DOMStorage.disable").length);
  });

  it("取不到 storageKey 时回退 securityOrigin", async () => {
    const e = await mk({ local: { a: "1" } });
    e.cdp.state.noStorageKey = true;
    await e.call({ action: "storage_list", area: "local" });
    const get = e.cdp.calls.find((c) => c.method === "DOMStorage.getDOMStorageItems");
    expect(get?.params.storageId).toEqual({ securityOrigin: "https://a.test", isLocalStorage: true });
  });

  it("storage_set / remove / clear：真的改了；结果与活动日志都不含值", async () => {
    const e = await mk({ local: { keep: "1", gone: "2" } });
    const set = await e.call({ action: "storage_set", area: "local", key: "token", value: SECRET });
    expect(set).toMatchObject({ key: "token", size: SECRET.length });
    expect(JSON.stringify(set)).not.toContain(SECRET);
    expect(e.cdp.local.get("token")).toBe(SECRET);
    const rm = await e.call({ action: "storage_remove", area: "local", key: "gone" });
    expect(rm).toMatchObject({ existed: true, key: "gone" });
    expect([...e.cdp.local.keys()].sort()).toEqual(["keep", "token"]);
    const clr = await e.call({ action: "storage_clear", area: "local" });
    expect(clr.cleared).toBe(2);
    expect(e.cdp.local.size).toBe(0);
    const sums = e.activitySummaries();
    expect(sums).toHaveLength(3);
    expect(JSON.stringify(sums)).not.toContain(SECRET);
    expect(sums[0]).toContain("token");
  });

  it("idb_list：只列库名与 object store 名，不读数据；超多库只展开前 20 个", async () => {
    const dbs = Array.from({ length: 25 }, (_, i) => ({ name: `db${i}`, version: i + 1, stores: i === 0 ? ["users", "tokens"] : [] }));
    const e = await mk({ idb: dbs });
    const r = await e.call({ action: "idb_list" });
    expect(r).toMatchObject({ total: 25, truncated: true });
    expect(r.databases).toHaveLength(20);
    expect(r.databases[0]).toMatchObject({ name: "db0", version: 1, objectStoresTotal: 2 });
    expect(r.databases[0].objectStores.map((s: any) => s.name)).toEqual(["users", "tokens"]);
    const methods = e.cdp.calls.map((c) => c.method);
    expect(methods).not.toContain("IndexedDB.requestData");
    expect(methods).toContain("IndexedDB.disable");
  });
});

describe("P3·export_state / import_state", () => {
  const readState = (e: StorageEnv, name: string) => JSON.parse(fs.readFileSync(path.join(e.stateDir, name), "utf8"));

  it("导出：文件在 <userData>/data/tasks/<taskId>/browser-state/，内容含明文凭据，返回值与活动日志不含值", async () => {
    const e = await mk({ cookies: seedCookies(), local: { token: SECRET2 } });
    const r = await e.call({ action: "export_state", file: "my-login" });
    expect(r).toMatchObject({ action: "export_state", file: "my-login.json", dir: "browser-state", cookies: 2, origins: [{ origin: "https://a.test", items: 1 }] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET2);
    const doc = readState(e, "my-login.json");
    expect(doc).toMatchObject({ version: 1, kind: "flowship-browser-state" });
    expect(doc.cookies.map((c: any) => c.name).sort()).toEqual(["sid", "theme"]);
    expect(doc.cookies.find((c: any) => c.name === "sid").value).toBe(SECRET);
    expect(doc.origins).toEqual([{ origin: "https://a.test", localStorage: [{ name: "token", value: SECRET2 }] }]);
    expect(JSON.stringify(e.activitySummaries())).not.toContain(SECRET);
    expect(JSON.stringify(e.session.getState())).not.toContain(SECRET2);
    expect(e.activitySummaries().some((x) => x.includes("my-login.json"))).toBe(true);
  });

  it.skipIf(isWin)("导出文件权限 0600、目录 0700", async () => {
    const e = await mk({ cookies: seedCookies() });
    await e.call({ action: "export_state", file: "perm" });
    expect(fs.statSync(path.join(e.stateDir, "perm.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(e.stateDir).mode & 0o777).toBe(0o700);
  });

  it("缺省文件名 state-<时间>；all=true 导出所有站点但排除 Flowship 域；includeStorage=false 不带 localStorage", async () => {
    const e = await mk({ cookies: seedCookies(), local: { k: "v" } });
    const r = await e.call({ action: "export_state", all: true, includeStorage: false });
    expect(r.file).toBe(`${defaultStateName(new Date(NOW))}.json`);
    const doc = readState(e, r.file);
    expect(doc.cookies.map((c: any) => c.name).sort()).toEqual(["other", "sid", "theme"]);
    expect(JSON.stringify(doc)).not.toContain("app-cookie");
    expect(doc.origins).toEqual([]);
  });

  it("没有任何可导出的内容 → BAD_ARGS，不落盘", async () => {
    const e = await mk();
    await rej(e.call({ action: "export_state", file: "empty" }), "BAD_ARGS");
    expect(fs.existsSync(e.stateDir)).toBe(false);
  });

  it("路径净化：../、绝对路径、特殊字符、超长都只会落在 browser-state 目录内，文件名只含 [A-Za-z0-9._-]", async () => {
    const e = await mk({ cookies: seedCookies() });
    const names: string[] = [];
    // 超过 100 字符的 file 在参数规整阶段就被拒（BAD_ARGS）；100 以内的超长名字被截到 60 字符
    await rej(e.call({ action: "export_state", file: "x".repeat(300) }), "BAD_ARGS");
    for (const file of ["../../evil", "/tmp/abs-name", "..\\..\\win", "we ird$`name", "a/b/c", "x".repeat(90), "登录态", ".."]) {
      const r = await e.call({ action: "export_state", file });
      names.push(r.file);
      expect(r.file, file).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*\.json$/);
      expect(r.file.length).toBeLessThanOrEqual(65);
    }
    expect(names[0]).toBe("evil.json");
    expect(names[1]).toBe("abs-name.json");
    // 所有文件都在 stateDir 里；userData 下除了 data/ 没有别的东西；tmp 目录没被写
    const inDir = fs.readdirSync(e.stateDir);
    for (const n of names) expect(inDir).toContain(n);
    expect(fs.readdirSync(e.userData)).toEqual(["data"]);
    expect(fs.existsSync(path.join(os.tmpdir(), "abs-name.json"))).toBe(false);
    expect(fs.existsSync(path.join(e.userData, "evil.json"))).toBe(false);
    expect(fs.existsSync(path.join(e.userData, "data", "evil.json"))).toBe(false);
  });

  it("taskId 不是安全字符（含 ../）→ INTERNAL，什么都不写", async () => {
    const e = await mk({ taskId: "../evil", cookies: seedCookies() });
    await rej(e.call({ action: "export_state", file: "x" }), "INTERNAL");
    await rej(e.call({ action: "import_state", file: "x" }), "INTERNAL");
    expect(fs.readdirSync(e.userData)).toEqual([]);
  });

  it("往返：导出 → 清空 → 导入，cookie 与当前站点的 localStorage 都回来；已过期的跳过；其它 origin 的 localStorage 报告跳过", async () => {
    const e = await mk({ cookies: [...seedCookies(), { name: "stale", value: "x", domain: "a.test", expirationDate: 1_000_000_000 }], local: { token: SECRET2 } });
    const out = await e.call({ action: "export_state", file: "rt" });
    expect(out.cookies).toBe(3);
    // 再手写一个带别的 origin 的文件
    const doc = readState(e, "rt.json");
    doc.origins.push({ origin: "https://other.test", localStorage: [{ name: "o", value: "1" }] });
    fs.writeFileSync(path.join(e.stateDir, "rt2.json"), JSON.stringify(doc));
    e.store.length = 0;
    e.cdp.local.clear();
    const r = await e.call({ action: "import_state", file: "rt2.json" });
    expect(r).toMatchObject({ action: "import_state", file: "rt2.json", cookiesSet: 2, cookiesExpired: 1, failed: 0, localStorageSet: 1, skippedOrigins: ["https://other.test"] });
    expect(e.store.map((c) => c.name).sort()).toEqual(["sid", "theme"]);
    expect(e.store.find((c) => c.name === "sid")?.value).toBe(SECRET);
    expect(e.cdp.local.get("token")).toBe(SECRET2);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(e.activitySummaries())).not.toContain(SECRET);
    // 也能带不带 .json 后缀
    const again = await e.call({ action: "import_state", file: "rt" });
    expect(again.file).toBe("rt.json");
  });

  it("导入的 file 是严格校验的：路径 / 特殊字符 / 绝对路径 / 不存在的文件都是 BAD_ARGS，不会被「悄悄改写」成别的文件", async () => {
    const e = await mk({ cookies: seedCookies() });
    await e.call({ action: "export_state", file: "good" });
    fs.writeFileSync(path.join(e.userData, "outside.json"), JSON.stringify({ version: 1, cookies: [{ name: "pwn", value: "1", domain: "evil.test" }] }));
    for (const file of ["../../../outside", "../outside.json", `${e.userData}/outside.json`, "good/../good", "go od", "good\u0000", "nope", "con"]) {
      await rej(e.call({ action: "import_state", file }), "BAD_ARGS");
    }
    expect(e.jar.set).not.toHaveBeenCalled();
  });

  it("导入恶意文件整体拒绝、一条 cookie 都不写：指向 Flowship origin / 非法域 / 非数组 / 超大 / 坏 JSON", async () => {
    const e = await mk();
    fs.mkdirSync(e.stateDir, { recursive: true });
    const put = (name: string, text: string) => fs.writeFileSync(path.join(e.stateDir, `${name}.json`), text);
    const good = { name: "ok", value: "1", domain: "a.test" };
    put("flowdomain", JSON.stringify({ version: 1, cookies: [good, { name: "x", value: "1", domain: APP_HOST }] }));
    put("flowurl", JSON.stringify({ version: 1, cookies: [good, { name: "x", value: "1", url: "http://127.0.0.1:8876/" }] }));
    put("floworigin", JSON.stringify({ version: 1, cookies: [good], origins: [{ origin: "http://127.0.0.1:8876", localStorage: [{ name: "k", value: "v" }] }] }));
    put("baddomain", JSON.stringify({ version: 1, cookies: [{ name: "x", value: "1", domain: "evil.com/path" }] }));
    put("notarray", JSON.stringify({ version: 1, cookies: { name: "x" } }));
    put("rootarray", JSON.stringify([good]));
    put("badjson", "{not json");
    put("huge", JSON.stringify({ version: 1, cookies: [good], pad: "x".repeat(4 * 1024 * 1024 + 10) }));
    for (const f of ["flowdomain", "flowurl", "floworigin", "baddomain", "notarray", "rootarray", "badjson", "huge"]) {
      const err: any = await e.call({ action: "import_state", file: f }).then(
        () => null,
        (x: unknown) => x,
      );
      expect(err?.code, f).toBe("BAD_ARGS");
    }
    expect(e.jar.set).not.toHaveBeenCalled();
    expect(e.store).toEqual([]);
    expect(e.cdp.local.size).toBe(0);
  });

  it.skipIf(isWin)("导入时 browser-state 里的文件是符号链接 → 拒绝（不会读到别处的文件）", async () => {
    const e = await mk();
    fs.mkdirSync(e.stateDir, { recursive: true });
    const outside = path.join(e.userData, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ version: 1, cookies: [{ name: "ok", value: "1", domain: "a.test" }] }));
    fs.symlinkSync(outside, path.join(e.stateDir, "link.json"));
    const err: any = await e.call({ action: "import_state", file: "link" }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err.code).toBe("BAD_ARGS");
    expect(err.message).toContain("符号链接");
    expect(e.jar.set).not.toHaveBeenCalled();
  });
});

describe("P3·clear_site", () => {
  it("只清当前站点：该站点的 cookie、两种 web storage、clearStorageData({origin})；别的站点不动", async () => {
    const e = await mk({ cookies: seedCookies(), local: { a: "1" }, session: { b: "2" } });
    const r = await e.call({ action: "clear_site" });
    expect(r).toMatchObject({ action: "clear_site", origin: "https://a.test", cookiesRemoved: 2, cookiesRemaining: 0, webStorageCleared: true });
    expect(e.clearStorageData).toHaveBeenCalledWith({ origin: "https://a.test" });
    expect(e.cdp.local.size).toBe(0);
    expect(e.cdp.session.size).toBe(0);
    expect(e.store.map((c) => c.name).sort()).toEqual(["flow", "other"]);
    expect(e.activitySummaries().some((x) => x.includes("a.test"))).toBe(true);
  });

  it("CDP 清 web storage 失败不影响整站清理：webStorageCleared=false 仍然清了 cookie 和 origin 数据", async () => {
    const e = await mk({ cookies: seedCookies() });
    e.cdp.state.failClear = true;
    const r = await e.call({ action: "clear_site" });
    expect(r.webStorageCleared).toBe(false);
    expect(r.cookiesRemoved).toBe(2);
    expect(e.clearStorageData).toHaveBeenCalledWith({ origin: "https://a.test" });
  });
});

describe("P3·活动日志与状态里永远没有值", () => {
  it("把所有会处理值的动作都跑一遍：session 状态（含活动日志）里找不到任何明文值", async () => {
    const e = await mk({ cookies: seedCookies(), local: { token: SECRET } });
    await e.call({ action: "cookies_list", reveal: true });
    await e.call({ action: "cookies_get", name: "sid", reveal: true });
    await e.call({ action: "storage_list", area: "local", reveal: true });
    await e.call({ action: "storage_get", area: "local", key: "token", reveal: true });
    await e.call({ action: "cookies_set", name: "n1", value: SECRET2 });
    await e.call({ action: "storage_set", area: "session", key: "n2", value: SECRET2 });
    await e.call({ action: "export_state", file: "log-check" });
    await e.call({ action: "import_state", file: "log-check" });
    await e.call({ action: "cookies_delete", name: "n1" });
    await e.call({ action: "storage_remove", area: "session", key: "n2" });
    await e.call({ action: "clear_site" });
    const dump = JSON.stringify(e.session.getState());
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(SECRET2);
    expect(e.activitySummaries().length).toBeGreaterThanOrEqual(8);
  });
});
