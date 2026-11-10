/**
 * E2·P1 · A4 证书错误 / A3 HTTP 认证（electron-app/browser/net-guard.mjs）：
 *  - 纯策略：本机信任的边界（localhost.evil.com / 127.0.0.1.evil.com / evil-localhost / IPv6 / 大小写 / 端口 / userinfo 欺骗）、证书决策、认证回答校验；
 *  - 事件接线：certificate-error / login / select-client-certificate 的回调恰好一次、取消 / 超时 / tab 销毁按默认动作；
 *  - **凭据不泄漏**：用户名 / 密码不进 getState / PromptHub 列表 / log 回调 / 活动日志 / 会话扩展状态 / host 的通知参数。
 * 真 BrowserSession（真 PromptHub / 真活动日志 / 真 getState）+ 假 tab / 假 wc。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_COOLDOWN_MS,
  AUTH_PASSWORD_MAX,
  AUTH_USERNAME_MAX,
  CERT_COOLDOWN_MS,
  NET_PROMPT_TIMEOUT_MS,
  certFingerprint,
  createNetGuard,
  decideCertError,
  getNetGuardState,
  isLoopbackTrustHost,
  parseHttpUrl,
  validateAuthAnswer,
} from "../electron-app/browser/net-guard.mjs";

import { APP_ORIGIN, dumpAll, firstPrompt, flush, makeEnv, type P1Config } from "./helpers/browser-e2-p1-fakes";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── 纯策略 ─────────────────────────

describe("isLoopbackTrustHost：本机信任的边界", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "foo.localhost",
    "a.b.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "[::1]",
  ])("信任：%s", (host) => {
    expect(isLoopbackTrustHost(host)).toBe(true);
  });

  it.each([
    "localhost.evil.com",
    "127.0.0.1.evil.com",
    "evil-localhost",
    "notlocalhost",
    "evil.com",
    "local",
    ".local",
    // R6-23：`*.local` 是 mDNS（可能是局域网里别人的机器），不再自动放行、改为询问
    "dev.local",
    "my-nas.local",
    "DEV.LOCAL",
    "dev.local.",
    "a.b.local",
    ".localhost",
    "localhost.localdomain",
    "xlocal",
    "128.0.0.1",
    "126.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "1.127.0.0.1",
    "127.0.0.1.1",
    "127.0.0",
    "127.0.0.256",
    "[::2]",
    "[::]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "",
  ])("不信任：%j", (host) => {
    expect(isLoopbackTrustHost(host)).toBe(false);
  });

  it("非字符串 → false", () => {
    expect(isLoopbackTrustHost(null as never)).toBe(false);
    expect(isLoopbackTrustHost(undefined as never)).toBe(false);
    expect(isLoopbackTrustHost(127 as never)).toBe(false);
  });

  it("经 URL 解析后判断：userinfo / 反斜杠 / fragment 欺骗都按真实主机算；端口与大小写不影响", () => {
    const trusted = (u: string) => {
      const p = parseHttpUrl(u);
      return p ? isLoopbackTrustHost(p.hostname) : false;
    };
    // 真本机
    expect(trusted("https://localhost:8443/x")).toBe(true);
    expect(trusted("https://LocalHost/")).toBe(true);
    expect(trusted("http://[::1]:3000/")).toBe(true);
    expect(trusted("http://127.1/")).toBe(true); // URL 归一成 127.0.0.1
    expect(trusted("http://0x7f.0.0.1/")).toBe(true);
    expect(trusted("http://2130706433/")).toBe(true);
    expect(trusted("http://localhost.:3000/")).toBe(true);
    expect(trusted("https://app.localhost:5173/")).toBe(true);
    // 欺骗：真实主机是 evil.com
    expect(trusted("http://localhost@evil.com/")).toBe(false);
    expect(trusted("http://127.0.0.1@evil.com/")).toBe(false);
    expect(trusted("http://localhost:80@evil.com/")).toBe(false);
    expect(trusted("http://localhost:pw@evil.com:8443/")).toBe(false);
    expect(trusted("http://evil.com#@localhost/")).toBe(false);
    expect(trusted("http://evil.com\\@localhost/")).toBe(false);
    expect(trusted("http://evil.com/?h=localhost")).toBe(false);
    expect(trusted("http://localhost.evil.com/")).toBe(false);
    expect(trusted("http://127.0.0.1.evil.com/")).toBe(false);
    expect(trusted("http://evil-localhost/")).toBe(false);
    expect(trusted("http://[::ffff:127.0.0.1]/")).toBe(false);
    // 非 http(s)
    expect(trusted("ftp://localhost/")).toBe(false);
    expect(trusted("file://localhost/etc/passwd")).toBe(false);
    expect(trusted("not a url")).toBe(false);
  });

  it("parseHttpUrl：host 含非默认端口；超长 / 非字符串 → null", () => {
    expect(parseHttpUrl("https://a.com:8443/x")).toEqual({ host: "a.com:8443", hostname: "a.com" });
    expect(parseHttpUrl("https://a.com:443/x")).toEqual({ host: "a.com", hostname: "a.com" });
    expect(parseHttpUrl(`https://a.com/${"x".repeat(5000)}`)).toBeNull();
    expect(parseHttpUrl(5 as never)).toBeNull();
  });
});

describe("decideCertError：证书决策真值表", () => {
  const isAppUrl = (u: string) => new URL(u).origin === APP_ORIGIN;
  const base = { config: { trustLoopbackCerts: true }, isAppUrl, allowedCerts: new Map<string, Set<string>>(), fingerprint: "sha256/AAAAAAAA" };

  it("Flowship 自己的 origin → 永远拒绝（即使是本机、信任开关开着）", () => {
    for (const isMainFrame of [true, false]) {
      expect(decideCertError({ ...base, url: `${APP_ORIGIN}/x`, isMainFrame })).toMatchObject({ action: "deny", reason: "app-origin" });
    }
    // 已被用户放行过的指纹也不能让 app origin 通过
    const allowed = new Map([["127.0.0.1:8876", new Set(["sha256/AAAAAAAA"])]]);
    expect(decideCertError({ ...base, allowedCerts: allowed, url: `${APP_ORIGIN}/x`, isMainFrame: true }).action).toBe("deny");
  });

  it("isAppUrl 抛错 → 按 Flowship 自己处理（拒绝）", () => {
    const throwing = () => {
      throw new Error("x");
    };
    expect(decideCertError({ ...base, isAppUrl: throwing, url: "https://localhost/", isMainFrame: true })).toMatchObject({ action: "deny", reason: "app-origin" });
  });

  it("本机 + 开关开 → allow（主框架与子资源一样）；开关关 / 缺省 → 主框架 ask、子资源 deny", () => {
    expect(decideCertError({ ...base, url: "https://localhost:8443/", isMainFrame: true })).toEqual({ action: "allow", reason: "loopback", host: "localhost:8443" });
    expect(decideCertError({ ...base, url: "https://api.localhost/", isMainFrame: false }).action).toBe("allow");
    expect(decideCertError({ ...base, config: { trustLoopbackCerts: false }, url: "https://localhost/", isMainFrame: true }).action).toBe("ask");
    expect(decideCertError({ ...base, config: { trustLoopbackCerts: false }, url: "https://localhost/", isMainFrame: false }).action).toBe("deny");
    expect(decideCertError({ ...base, config: {}, url: "https://localhost/", isMainFrame: true }).action).toBe("ask");
    expect(decideCertError({ ...base, config: null, url: "https://localhost/", isMainFrame: true }).action).toBe("ask");
  });

  it("本机信任不被主机名欺骗：localhost@evil.com / localhost.evil.com / 127.0.0.1.evil.com 都走正常的 ask / deny", () => {
    for (const url of ["https://localhost@evil.com/", "https://localhost.evil.com/", "https://127.0.0.1.evil.com/", "https://evil-localhost/"]) {
      expect(decideCertError({ ...base, url, isMainFrame: true }).action, url).toBe("ask");
      expect(decideCertError({ ...base, url, isMainFrame: false }).action, url).toBe("deny");
    }
  });

  it("非本机：主框架 ask、子资源 deny；用户放行过「同 host + 同指纹」→ allow（主框架与子资源）", () => {
    expect(decideCertError({ ...base, url: "https://self-signed.example/", isMainFrame: true })).toEqual({ action: "ask", reason: "needs-user", host: "self-signed.example" });
    expect(decideCertError({ ...base, url: "https://self-signed.example/a.js", isMainFrame: false })).toMatchObject({ action: "deny", reason: "subresource" });
    const allowed = new Map([["self-signed.example", new Set(["sha256/AAAAAAAA"])]]);
    expect(decideCertError({ ...base, allowedCerts: allowed, url: "https://self-signed.example/", isMainFrame: true })).toMatchObject({ action: "allow", reason: "user-allowed" });
    expect(decideCertError({ ...base, allowedCerts: allowed, url: "https://self-signed.example/a.js", isMainFrame: false }).action).toBe("allow");
  });

  it("放行只对「同 host（含端口）+ 同指纹」有效：指纹不同 / 端口不同 / 别的 host / 指纹为空都不命中", () => {
    const allowed = new Map([["self-signed.example", new Set(["sha256/AAAAAAAA"])]]);
    expect(decideCertError({ ...base, allowedCerts: allowed, fingerprint: "sha256/BBBBBBBB", url: "https://self-signed.example/", isMainFrame: true }).action).toBe("ask");
    expect(decideCertError({ ...base, allowedCerts: allowed, url: "https://self-signed.example:8443/", isMainFrame: true }).action).toBe("ask");
    expect(decideCertError({ ...base, allowedCerts: allowed, url: "https://other.example/", isMainFrame: true }).action).toBe("ask");
    expect(decideCertError({ ...base, allowedCerts: allowed, fingerprint: "", url: "https://self-signed.example/", isMainFrame: true }).action).toBe("ask");
    expect(decideCertError({ ...base, allowedCerts: allowed, url: "https://other.example/x.js", isMainFrame: false }).action).toBe("deny");
  });

  it("URL 不是 http(s) / 解析失败 → deny", () => {
    for (const url of ["ftp://a.com/", "about:blank", "", "not a url", "wss://a.com/"]) {
      expect(decideCertError({ ...base, url, isMainFrame: true }).action, url).toBe("deny");
    }
  });
});

describe("certFingerprint / validateAuthAnswer", () => {
  it("指纹：合格式才收，其余返回空串", () => {
    expect(certFingerprint({ fingerprint: "sha256/AbCd+/=1234" })).toBe("sha256/AbCd+/=1234");
    expect(certFingerprint({ fingerprint: "bad" })).toBe("");
    expect(certFingerprint({ fingerprint: "has space inside!" })).toBe("");
    expect(certFingerprint({})).toBe("");
    expect(certFingerprint(null)).toBe("");
    expect(certFingerprint({ fingerprint: 5 })).toBe("");
  });

  it("submit：用户名 / 密码必须是字符串、长度合理、无控制字符、不能都为空；返回规整后的对象", () => {
    expect(validateAuthAnswer({ action: "submit", username: "alice", password: "pw", extra: "x" })).toEqual({ action: "submit", username: "alice", password: "pw" });
    expect(validateAuthAnswer({ action: "submit", username: "alice", password: "" })).toEqual({ action: "submit", username: "alice", password: "" });
    expect(() => validateAuthAnswer({ action: "submit", username: 1, password: "pw" })).toThrow();
    expect(() => validateAuthAnswer({ action: "submit", username: "a" })).toThrow();
    expect(() => validateAuthAnswer({ action: "submit", username: "", password: "" })).toThrow();
    expect(() => validateAuthAnswer({ action: "submit", username: "a".repeat(AUTH_USERNAME_MAX + 1), password: "p" })).toThrow();
    expect(() => validateAuthAnswer({ action: "submit", username: "a", password: "p".repeat(AUTH_PASSWORD_MAX + 1) })).toThrow();
    expect(() => validateAuthAnswer({ action: "submit", username: "a\r\nX: y", password: "p" })).toThrow();
    expect(() => validateAuthAnswer({ action: "submit", username: "a", password: "p\u0000" })).toThrow();
    expect(() => validateAuthAnswer(null)).toThrow();
    expect(validateAuthAnswer({ action: "submit", username: "a".repeat(AUTH_USERNAME_MAX), password: "p".repeat(AUTH_PASSWORD_MAX) }).action).toBe("submit");
  });

  it("非 submit 的动作只回 { action }（不带任何别的字段）", () => {
    expect(validateAuthAnswer({ action: "cancel", username: "x", password: "y" })).toEqual({ action: "cancel" });
  });

  it("错误信息里不带凭据（抛错 = 回答无效，提示保持挂起）", () => {
    try {
      validateAuthAnswer({ action: "submit", username: "alice", password: 5 });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("alice");
    }
  });
});

// ───────────────────────── 事件接线 ─────────────────────────

const setup = async (cfg: Partial<P1Config> = {}) => {
  const env = makeEnv(cfg);
  const guard = createNetGuard({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: (m: string) => env.logs.push(m) });
  const tab = await env.openTab("about:blank");
  guard.bindTab(tab);
  const ev = () => ({ preventDefault: vi.fn() });
  const CERT = { fingerprint: "sha256/AAAAAAAAAAAA", subjectName: "CN=dev.example", issuerName: "CN=dev.example" };
  const certError = (url: string, isMainFrame: boolean | undefined = true, cert: Record<string, unknown> = CERT, error = "net::ERR_CERT_AUTHORITY_INVALID") => {
    const e = ev();
    const cb = vi.fn();
    tab.wc.emit("certificate-error", e, url, error, cert, cb, isMainFrame);
    return { e, cb };
  };
  const AUTH_INFO = { isProxy: false, scheme: "basic", host: "127.0.0.1", port: 8123, realm: "t" };
  const login = (authInfo: Record<string, unknown> = AUTH_INFO, url = "http://127.0.0.1:8123/private") => {
    const e = ev();
    const cb = vi.fn();
    tab.wc.emit("login", e, { url }, authInfo, cb);
    return { e, cb };
  };
  return { ...env, guard, tab, ev, certError, login, CERT, AUTH_INFO };
};

describe("certificate-error 接线", () => {
  it("本机 + 信任开关开：放行（回调恰好一次、已 preventDefault）并在 tab 上记 certOverride；不产生提示", async () => {
    const s = await setup();
    const { e, cb } = s.certError("https://localhost:8443/");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.tab.certOverride).toMatchObject({ host: "localhost:8443", error: "net::ERR_CERT_AUTHORITY_INVALID", source: "loopback" });
  });

  it("本机子资源放行但不改 certOverride（只有主框架页面本身被放行才标注）", async () => {
    const s = await setup();
    const { cb } = s.certError("https://localhost:8443/app.js", false);
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.tab.certOverride).toBeNull();
  });

  it("开关关：本机也要问用户（cert 提示：detail 含错误码 / 主题 / 颁发者 / 指纹，host 含端口）", async () => {
    const s = await setup({ trustLoopbackCerts: false });
    const { cb } = s.certError("https://localhost:8443/");
    await flush();
    expect(cb).not.toHaveBeenCalled();
    const p = firstPrompt(s.session, "cert");
    expect(p.host).toBe("localhost:8443");
    expect(p.tabId).toBe(s.tab.id);
    expect(p.detail).toMatchObject({ error: "net::ERR_CERT_AUTHORITY_INVALID", subject: "CN=dev.example", issuer: "CN=dev.example" });
    expect((s.session.prompts.list()[0] as { actions: string[] }).actions).toEqual(["deny", "allow-host"]);
  });

  it("allow-host：放行 + certOverride(source:user)；之后同 host + 同指纹（含子资源）免提示；换指纹 / 换 host 仍要问或拒绝", async () => {
    const s = await setup();
    const { cb } = s.certError("https://self-signed.example/");
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "cert").id, { action: "allow-host" });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.tab.certOverride).toMatchObject({ host: "self-signed.example", source: "user" });
    expect(getNetGuardState(s.session).allowedCerts.get("self-signed.example")?.has(s.CERT.fingerprint)).toBe(true);

    // 同 host + 同指纹：主框架 / 子资源都直接放行
    expect(s.certError("https://self-signed.example/").cb).toHaveBeenCalledWith(true);
    expect(s.certError("https://self-signed.example/x.js", false).cb).toHaveBeenCalledWith(true);
    expect(s.session.prompts.size()).toBe(0);
    // 别的 host 的子资源：拒绝
    expect(s.certError("https://cdn.other.example/x.js", false).cb).toHaveBeenCalledWith(false);
    // 同 host 换了证书：要再问
    const swapped = s.certError("https://self-signed.example/", true, { ...s.CERT, fingerprint: "sha256/ZZZZZZZZZZZZ" });
    await flush();
    expect(swapped.cb).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("deny：回调 false；冷却期内同请求直接拒绝不再弹；过了冷却重新问", async () => {
    const s = await setup();
    const { cb } = s.certError("https://self-signed.example/");
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "cert").id, { action: "deny" });
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.tab.certOverride).toBeNull();
    const again = s.certError("https://self-signed.example/");
    await flush();
    expect(again.cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(CERT_COOLDOWN_MS + 500);
    s.certError("https://self-signed.example/");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("超时（60 秒无人处理）→ 默认拒绝，回调恰好一次", async () => {
    const s = await setup();
    const { cb } = s.certError("https://self-signed.example/");
    await flush();
    await vi.advanceTimersByTimeAsync(NET_PROMPT_TIMEOUT_MS + 10);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.tab.certOverride).toBeNull();
  });

  it("非本机的子资源错误 / 主框架 isMainFrame 不是 true → 拒绝、不弹提示", async () => {
    const s = await setup();
    expect(s.certError("https://cdn.example/x.js", false).cb).toHaveBeenCalledWith(false);
    expect(s.certError("https://cdn.example/", null as never).cb).toHaveBeenCalledWith(false);
    await flush();
    expect(s.session.prompts.size()).toBe(0);
  });

  it("Flowship 自己的 origin：永远拒绝（本机信任也救不了）", async () => {
    const s = await setup();
    const { cb } = s.certError(`${APP_ORIGIN}/`);
    await flush();
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.session.prompts.size()).toBe(0);
    expect(s.tab.certOverride).toBeNull();
  });

  it("找不到所属 tab（已销毁）→ 拒绝；回调抛错不外溢", async () => {
    const s = await setup();
    s.tab.destroy();
    const { cb } = s.certError("https://localhost:8443/");
    expect(cb).toHaveBeenCalledWith(false);
    const s2 = await setup();
    const e = s2.ev();
    const throwing = vi.fn(() => {
      throw new Error("cb boom");
    });
    expect(() => s2.tab.wc.emit("certificate-error", e, "https://localhost/", "net::ERR_CERT_COMMON_NAME_INVALID", s2.CERT, throwing, true)).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("等用户时 tab 被关 / 会话销毁 / 主框架导航离开 → 提示作废、回调 false；证书放行标记在新导航开始时清空", async () => {
    const s = await setup();
    const a = s.certError("https://self-signed.example/");
    await flush();
    s.tab.destroy();
    await flush();
    expect(a.cb).toHaveBeenCalledTimes(1);
    expect(a.cb).toHaveBeenCalledWith(false);

    const s2 = await setup();
    const b = s2.certError("https://self-signed.example/");
    await flush();
    s2.tab.wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    s2.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    await flush();
    expect(s2.session.prompts.size()).toBe(1);
    s2.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(b.cb).toHaveBeenCalledWith(false);
    expect(s2.session.prompts.size()).toBe(0);

    const s3 = await setup();
    const c = s3.certError("https://self-signed.example/");
    await flush();
    s3.session.destroy();
    await flush();
    expect(c.cb).toHaveBeenCalledTimes(1);
    expect(c.cb).toHaveBeenCalledWith(false);

    const s4 = await setup();
    s4.certError("https://localhost:8443/");
    expect(s4.tab.certOverride).not.toBeNull();
    s4.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(s4.tab.certOverride).toBeNull();
  });

  it("tab 销毁钩子触发时 findOwner 已经找不到该 tab（真机：tab 先被摘出会话）：仍按发提示时记下的会话取消提示、回调 callback()", async () => {
    const env = makeEnv();
    let gone = false;
    const guard = createNetGuard({ findOwner: (wc: unknown) => (gone ? null : env.findOwner(wc)), getConfig: () => env.config, isAppUrl: env.isAppUrl });
    const tab = await env.openTab("about:blank");
    guard.bindTab(tab);
    const cb = vi.fn();
    tab.wc.emit("login", { preventDefault: vi.fn() }, { url: "http://127.0.0.1:8123/p" }, { isProxy: false, scheme: "basic", host: "127.0.0.1", port: 8123, realm: "t" }, cb);
    await flush();
    expect(env.session.prompts.size()).toBe(1);
    gone = true;
    tab.destroy();
    await flush();
    expect(env.session.prompts.size()).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith();
  });

  it("同一主机再次导航时引擎复用连接、没有再触发 certificate-error：提交时补回 certOverride（只限 https、只限放行过的主机）", async () => {
    const s = await setup();
    s.certError("https://localhost:8443/");
    expect(s.tab.certOverride).toMatchObject({ host: "localhost:8443", source: "loopback" });
    // 第二次导航：did-start-navigation 清标注；没有 certificate-error；did-navigate 提交 → 补回
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(s.tab.certOverride).toBeNull();
    s.tab.wc.emit("did-navigate", {}, "https://localhost:8443/next");
    expect(s.tab.certOverride).toMatchObject({ host: "localhost:8443", source: "loopback", error: "net::ERR_CERT_AUTHORITY_INVALID" });
    // 去别的主机 / 退到 http：不带标注
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    s.tab.wc.emit("did-navigate", {}, "https://other.example/");
    expect(s.tab.certOverride).toBeNull();
    s.tab.wc.emit("did-navigate", {}, "http://localhost:8443/");
    expect(s.tab.certOverride).toBeNull();
    // 清除浏览数据后记录作废：不会再无中生有地标注
    s.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    const state = getNetGuardState(s.session) as { onBrowsingDataCleared: () => void };
    state.onBrowsingDataCleared();
    s.tab.wc.emit("did-navigate", {}, "https://localhost:8443/");
    expect(s.tab.certOverride).toBeNull();
  });

  it("并发的同一证书错误合并成一个提示，回答后各自回调一次", async () => {
    const s = await setup();
    const a = s.certError("https://self-signed.example/");
    const b = s.certError("https://self-signed.example/");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    s.session.prompts.answer(firstPrompt(s.session, "cert").id, { action: "allow-host" });
    await flush();
    expect(a.cb).toHaveBeenCalledTimes(1);
    expect(b.cb).toHaveBeenCalledTimes(1);
    expect(a.cb).toHaveBeenCalledWith(true);
    expect(b.cb).toHaveBeenCalledWith(true);
  });

  it("清除浏览数据 / 会话销毁：证书例外清空，之后同一站点重新要问", async () => {
    const s = await setup();
    s.certError("https://self-signed.example/");
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "cert").id, { action: "allow-host" });
    await flush();
    const state = getNetGuardState(s.session);
    expect(state.allowedCerts.size).toBe(1);
    state.onBrowsingDataCleared();
    expect(state.allowedCerts.size).toBe(0);
    s.certError("https://self-signed.example/");
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    s.session.destroy();
    expect(state.allowedCerts.size).toBe(0);
  });

  it("promptHold：有挂起的证书提示时返回「结算」Promise，处理完才 resolve；没有挂起返回 null", async () => {
    const s = await setup();
    expect(s.tab.promptHold?.()).toBeNull();
    s.certError("https://self-signed.example/");
    await flush();
    const hold = s.tab.promptHold?.();
    expect(hold).toBeInstanceOf(Promise);
    let done = false;
    void hold!.then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    s.session.prompts.answer(firstPrompt(s.session, "cert").id, { action: "deny" });
    await flush();
    expect(done).toBe(true);
    expect(s.tab.promptHold?.()).toBeNull();
  });

  it("处理过程异常 → 拒绝（回调恰好一次）", async () => {
    const env = makeEnv();
    const guard = createNetGuard({
      findOwner: () => {
        throw new Error("boom");
      },
      getConfig: () => env.config,
      isAppUrl: env.isAppUrl,
      log: (m: string) => env.logs.push(m),
    });
    const tab = await env.openTab("about:blank");
    guard.bindTab(tab);
    const cb = vi.fn();
    tab.wc.emit("certificate-error", { preventDefault: vi.fn() }, "https://localhost/", "net::ERR_CERT_AUTHORITY_INVALID", {}, cb, true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false);
  });
});

describe("login（HTTP 认证）接线", () => {
  const SECRET_USER = "alice-the-user";
  const SECRET_PASS = "p@ss-W0rd-SECRET-9f3a";

  it("发 auth 提示（host:port；detail 只有 realm / scheme / proxy / port）；submit → callback(username, password) 恰好一次", async () => {
    const s = await setup();
    const { e, cb } = s.login();
    expect(e.preventDefault).toHaveBeenCalled();
    await flush();
    const p = firstPrompt(s.session, "auth");
    expect(p.host).toBe("127.0.0.1:8123");
    expect(p.detail).toEqual({ realm: "t", scheme: "basic", proxy: "false", port: "8123" });
    expect(p.tabId).toBe(s.tab.id);
    expect((s.session.prompts.list()[0] as { actions: string[] }).actions).toEqual(["cancel", "submit"]);
    expect(cb).not.toHaveBeenCalled();
    expect(s.session.prompts.answer(p.id, { action: "submit", username: SECRET_USER, password: SECRET_PASS })).toBe(true);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(SECRET_USER, SECRET_PASS);
  });

  it("凭据不泄漏：提交前后 getState / PromptHub 列表 / log / 活动日志 / 会话扩展状态 / host 通知参数里都没有用户名与密码", async () => {
    const s = await setup();
    const { cb } = s.login();
    await flush();
    const scan = (when: string) => {
      const everything = [
        dumpAll(s.session.getState()),
        dumpAll(s.session.prompts.list()),
        dumpAll(s.logs),
        dumpAll(s.session.activityLog.list()),
        dumpAll(s.session.ext),
        dumpAll(s.host.onChange.mock.calls),
        dumpAll(s.host.emitEvent.mock.calls),
        dumpAll(s.tab.ext),
      ].join("\n");
      expect(everything, `${when}：用户名泄漏`).not.toContain(SECRET_USER);
      expect(everything, `${when}：密码泄漏`).not.toContain(SECRET_PASS);
    };
    scan("提交前");
    s.session.prompts.answer(firstPrompt(s.session, "auth").id, { action: "submit", username: SECRET_USER, password: SECRET_PASS });
    await flush();
    expect(cb).toHaveBeenCalledWith(SECRET_USER, SECRET_PASS);
    scan("提交后");
    // 活动日志只写事实
    const auth = (s.session.activityLog.list() as Array<{ kind: string; summary: string }>).filter((x) => x.kind === "auth");
    expect(auth).toHaveLength(1);
    expect(auth[0].summary).toContain("提供了 HTTP 认证");
    // 提示结束后状态里也没有挂起项
    expect(s.session.getState().prompts).toEqual([]);
  });

  it("无效回答（类型不对 / 超长 / 含控制字符 / 都为空）被拒绝、提示保持挂起；之后正常回答仍可用", async () => {
    const s = await setup();
    const { cb } = s.login();
    await flush();
    const id = firstPrompt(s.session, "auth").id;
    expect(s.session.prompts.answer(id, { action: "submit", username: 5, password: "x" })).toBe(false);
    expect(s.session.prompts.answer(id, { action: "submit", username: "a".repeat(AUTH_USERNAME_MAX + 1), password: "x" })).toBe(false);
    expect(s.session.prompts.answer(id, { action: "submit", username: "a\nb", password: "x" })).toBe(false);
    expect(s.session.prompts.answer(id, { action: "submit", username: "", password: "" })).toBe(false);
    expect(s.session.prompts.answer(id, { action: "bogus" })).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
    expect(s.session.prompts.answer(id, { action: "submit", username: "ok", password: "" })).toBe(true);
    await flush();
    expect(cb).toHaveBeenCalledWith("ok", "");
  });

  it("cancel：callback() 无参恰好一次；冷却期内同一请求直接取消不再弹；过了冷却重新问", async () => {
    const s = await setup();
    const { cb } = s.login();
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "auth").id, { action: "cancel", username: SECRET_USER, password: SECRET_PASS });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([]);

    const again = s.login();
    await flush();
    expect(again.cb.mock.calls[0]).toEqual([]);
    expect(s.session.prompts.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTH_COOLDOWN_MS + 500);
    s.login();
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    // cancel 回答里夹带的凭据也不会被保存
    expect(dumpAll([s.logs, s.session.activityLog.list(), s.session.ext])).not.toContain(SECRET_PASS);
  });

  it("超时（60 秒无人处理）→ callback() 取消", async () => {
    const s = await setup();
    const { cb } = s.login();
    await flush();
    await vi.advanceTimersByTimeAsync(NET_PROMPT_TIMEOUT_MS + 10);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([]);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("tab 关闭 / 会话销毁 / 主框架导航离开 → callback() 取消", async () => {
    const a = await setup();
    const l1 = a.login();
    await flush();
    a.tab.destroy();
    await flush();
    expect(l1.cb).toHaveBeenCalledTimes(1);
    expect(l1.cb.mock.calls[0]).toEqual([]);

    const b = await setup();
    const l2 = b.login();
    await flush();
    b.session.destroy();
    await flush();
    expect(l2.cb).toHaveBeenCalledTimes(1);
    expect(l2.cb.mock.calls[0]).toEqual([]);

    const c = await setup();
    const l3 = c.login();
    await flush();
    c.tab.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(l3.cb).toHaveBeenCalledTimes(1);
    expect(l3.cb.mock.calls[0]).toEqual([]);
  });

  it("代理认证：detail.proxy = true，活动日志标注代理服务器", async () => {
    const s = await setup();
    s.login({ isProxy: true, scheme: "basic", host: "proxy.corp.example", port: 3128, realm: "corp" }, "https://anything.example/");
    await flush();
    const p = firstPrompt(s.session, "auth");
    expect(p.detail.proxy).toBe("true");
    expect(p.host).toBe("proxy.corp.example:3128");
    s.session.prompts.answer(p.id, { action: "cancel" });
    await flush();
    const note = (s.session.activityLog.list() as Array<{ kind: string; summary: string }>).find((x) => x.kind === "auth");
    expect(note?.summary).toContain("代理服务器");
  });

  it("默认不记忆：同一站点再次要认证 → 再问一次（我们这层不缓存凭据）", async () => {
    const s = await setup();
    s.login();
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "auth").id, { action: "submit", username: SECRET_USER, password: SECRET_PASS });
    await flush();
    const second = s.login();
    await flush();
    expect(second.cb).not.toHaveBeenCalled();
    expect(s.session.prompts.size()).toBe(1);
  });

  it("并发的同一认证请求合并成一个提示，提交后各自拿到凭据", async () => {
    const s = await setup();
    const a = s.login();
    const b = s.login();
    await flush();
    expect(s.session.prompts.size()).toBe(1);
    s.session.prompts.answer(firstPrompt(s.session, "auth").id, { action: "submit", username: "u", password: "p" });
    await flush();
    expect(a.cb).toHaveBeenCalledWith("u", "p");
    expect(b.cb).toHaveBeenCalledWith("u", "p");
  });

  it("Flowship 自己的 origin / 缺 host 的认证 → 直接取消、不弹提示", async () => {
    const s = await setup();
    const a = s.login({ ...s.AUTH_INFO, host: "127.0.0.1", port: 8876 }, `${APP_ORIGIN}/api`);
    const b = s.login({ ...s.AUTH_INFO, host: "" });
    await flush();
    expect(a.cb.mock.calls[0]).toEqual([]);
    expect(b.cb.mock.calls[0]).toEqual([]);
    expect(s.session.prompts.size()).toBe(0);
  });

  it("realm / scheme / host 里的格式字符与超长文字被剥掉 / 截断（来自网络，不可信）", async () => {
    const s = await setup();
    s.login({ isProxy: false, scheme: "basic\u202E", host: "evil\u200B.example", port: 80, realm: `x\u3164${"R".repeat(500)}` }, "http://evil.example/");
    await flush();
    const p = firstPrompt(s.session, "auth");
    expect(p.host).toBe("evil.example:80");
    expect(p.detail.realm.length).toBeLessThan(250);
    expect(p.detail.realm).not.toMatch(/[\u202E\u3164\u200B]/);
    expect(p.detail.scheme).toBe("basic");
  });

  it("promptHold：认证提示挂着时返回结算 Promise（navigate 超时分支据此继续等用户）", async () => {
    const s = await setup();
    s.login();
    await flush();
    const hold = s.tab.promptHold?.();
    expect(hold).toBeInstanceOf(Promise);
    let done = false;
    void hold!.then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    s.session.prompts.answer(firstPrompt(s.session, "auth").id, { action: "cancel" });
    await flush();
    expect(done).toBe(true);
  });
});

describe("select-client-certificate 接线", () => {
  const CC = { subjectName: "CN=alice", issuerName: "CN=corp-ca", fingerprint: "sha256/CCCCCCCCCC" };
  const emit = (s: Awaited<ReturnType<typeof setup>>, list: unknown[], url = "https://mtls.example/") => {
    const e = s.ev();
    const cb = vi.fn();
    s.tab.wc.emit("select-client-certificate", e, url, list, cb);
    return { e, cb };
  };

  it("一律 preventDefault（否则 Electron 自动选第一张证书）；默认不提供", async () => {
    const s = await setup();
    const { e, cb } = emit(s, [CC]);
    expect(e.preventDefault).toHaveBeenCalled();
    await flush();
    expect(cb).not.toHaveBeenCalled();
    const p = firstPrompt(s.session, "clientcert");
    expect(p.detail).toMatchObject({ subject: "CN=alice", issuer: "CN=corp-ca" });
    s.session.prompts.answer(p.id, { action: "decline" });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([]);
  });

  it("只有用户点「选择证书」才提供那张证书", async () => {
    const s = await setup();
    const { cb } = emit(s, [CC]);
    await flush();
    s.session.prompts.answer(firstPrompt(s.session, "clientcert").id, { action: "select" });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(CC);
  });

  it("多张候选证书（还没有选择器面板）/ 零张 / Flowship 自己的 origin → 不提供、不弹提示", async () => {
    const s = await setup();
    const a = emit(s, [CC, { ...CC, subjectName: "CN=bob" }]);
    const b = emit(s, []);
    const c = emit(s, [CC], `${APP_ORIGIN}/`);
    await flush();
    for (const x of [a, b, c]) {
      expect(x.e.preventDefault).toHaveBeenCalled();
      expect(x.cb).toHaveBeenCalledTimes(1);
      expect(x.cb.mock.calls[0]).toEqual([]);
    }
    expect(s.session.prompts.size()).toBe(0);
  });

  it("超时 → 不提供", async () => {
    const s = await setup();
    const { cb } = emit(s, [CC]);
    await flush();
    await vi.advanceTimersByTimeAsync(NET_PROMPT_TIMEOUT_MS + 10);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([]);
  });
});

describe("常量", () => {
  it("提示超时 60s、冷却合理", () => {
    expect(NET_PROMPT_TIMEOUT_MS).toBe(60_000);
    expect(CERT_COOLDOWN_MS).toBeGreaterThan(0);
    expect(AUTH_COOLDOWN_MS).toBeGreaterThanOrEqual(CERT_COOLDOWN_MS);
  });
});
