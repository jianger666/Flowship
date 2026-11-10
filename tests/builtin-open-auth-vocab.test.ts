/**
 * R7-12-B4：「登录 / 授权链接」启发式词表的表驱动测试——**每个词表条目至少一个真 URL**，删掉任何一个条目 / 改松边界都要红。
 *
 * 重叠规则怎么隔离（否则「删一个条目」会被另一条规则兜住、测试看不出来）：
 * - 主机首段 vs 已知身份域：已知身份域一律用 `tenant.<域>`（首段是 `tenant`，只有「已知身份域」规则能命中）；
 * - 路径第一段 vs 任一段：只在第一段才算的词，另测 `/docs/<词>` 必须不算；任一段词用 `/docs/<词>/x`（第一段是 docs，只有「任一段」规则能命中）；
 * - 主机首段：用 `<词>.corp.example.com` + 空路径（路径 / query 不会命中），并要求 ≥ 3 段主机（`login.com` 不算）。
 * 与 reviewer 的存活变异（`/tmp/rv10-R/mutants.mjs`）一一对应；真正互相等价的重叠项（如 FIRST 与 ANY 都含 `login`）无法观察，不要求。
 */
import { describe, expect, it } from "vitest";

import { decideHttpOpen, isAuthFlowUrl, isSameAppOrigin, type BuiltinOpenEnv } from "@/lib/builtin-open";

const HOST_FIRST_LABELS = ["sso", "login", "signin", "passport", "auth", "oauth", "idp", "cas", "accounts", "adfs", "authn"];
const HOST_SUFFIXES = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "auth0.com",
  "okta.com",
  "oktapreview.com",
  "onelogin.com",
  "b2clogin.com",
  "amazoncognito.com",
  "accounts.feishu.cn",
  "passport.feishu.cn",
  "accounts.larksuite.com",
];
const FIRST_SEGMENTS = [
  "login", "logon", "signin", "sign-in", "sign_in", "accounts", "auth", "oauth", "oauth2", "sso", "saml", "saml2", "cas",
  "authorize", "authorization", "authenticate", "authen", "openid", "openid-connect", "passport", "idp", "adfs",
];
const ANY_SEGMENTS = ["authorize", "oauth2", "openid-connect", "saml2", "login", "logon", "signin", "sign-in", "sign_in", "sso"];
const FIRST_ONLY = FIRST_SEGMENTS.filter((s) => !ANY_SEGMENTS.includes(s));
const QUERY_KEYS = ["redirect_uri", "response_type", "client_id", "code_challenge", "samlrequest", "samlresponse", "relaystate", "login_hint"];

describe("主机名首段（≥ 3 段主机）", () => {
  it.each(HOST_FIRST_LABELS)("%s.corp.example.com → 授权（路径 / query 都是普通的）", (l) => {
    expect(isAuthFlowUrl(`https://${l}.corp.example.com/`)).toBe(true);
    expect(isAuthFlowUrl(`https://${l}.corp.example.com/dashboard?tab=1`)).toBe(true);
    expect(isAuthFlowUrl(`https://${l.toUpperCase()}.CORP.example.com/`)).toBe(true); // URL 会把主机名小写化
  });

  it.each(HOST_FIRST_LABELS)("%s 只有两段主机（%s.com）→ 不算；不是首段（corp.%s.example.com）→ 不算", (l) => {
    expect(isAuthFlowUrl(`https://${l}.com/`)).toBe(false);
    expect(isAuthFlowUrl(`https://corp.${l}.example.com/`)).toBe(false);
  });
});

describe("已知身份域（精确或其子域，按「点」边界）", () => {
  it.each(HOST_SUFFIXES)("%s：本身 / 子域（tenant.<域>、a.b.<域>）→ 授权", (s) => {
    expect(isAuthFlowUrl(`https://${s}/`)).toBe(true);
    expect(isAuthFlowUrl(`https://tenant.${s}/`)).toBe(true);
    expect(isAuthFlowUrl(`https://a.b.${s}/page`)).toBe(true);
  });

  it.each(HOST_SUFFIXES)("%s：没有点边界的拼接（evil<域>）→ 不算", (s) => {
    expect(isAuthFlowUrl(`https://evil${s}/`)).toBe(false);
    expect(isAuthFlowUrl(`https://not-${s}/`)).toBe(false);
  });

  it.each(HOST_SUFFIXES.filter((s) => !HOST_FIRST_LABELS.includes(s.split(".")[0]!)))("%s：当作别人域名的前缀（<域>.evil.org）→ 不算", (s) => {
    expect(isAuthFlowUrl(`https://${s}.evil.org/`)).toBe(false);
  });
});

describe("路径", () => {
  it.each(FIRST_SEGMENTS)("第一段 /%s → 授权（后面跟什么都行、大小写不敏感）", (seg) => {
    expect(isAuthFlowUrl(`https://example.com/${seg}`)).toBe(true);
    expect(isAuthFlowUrl(`https://example.com/${seg}/callback/x`)).toBe(true);
    expect(isAuthFlowUrl(`https://example.com/${seg.toUpperCase()}`)).toBe(true);
  });

  it.each(FIRST_ONLY)("%s 只在第一段才算：/docs/%s、/docs/%s/x 不算（路径段完整相等、多数只看第一段）", (seg) => {
    expect(isAuthFlowUrl(`https://example.com/docs/${seg}`)).toBe(false);
    expect(isAuthFlowUrl(`https://example.com/docs/${seg}/x`)).toBe(false);
  });

  it.each(ANY_SEGMENTS)("任一段 %s：/docs/%s/x → 授权", (seg) => {
    expect(isAuthFlowUrl(`https://example.com/docs/${seg}/x`)).toBe(true);
    expect(isAuthFlowUrl(`https://example.com/api/v1/${seg}`)).toBe(true);
  });

  it.each(["/docs/oauth-guide", "/blog/login-page-design", "/en/authentication", "/authors/x", "/authority", "/ssoo", "/signing", "/docs/session", "/session/old", "/new/session"])(
    "普通文档 / 近似词 %s → 不算（只认完整相等的段）",
    (p) => {
      expect(isAuthFlowUrl(`https://example.com${p}`)).toBe(false);
    },
  );

  it.each(["/app/session/new", "/sessions/new", "/x/y/sessions/new/z", "/Session/New"])("相邻两段 %s（Rails / Devise 登录页）→ 授权", (p) => {
    expect(isAuthFlowUrl(`https://example.com${p}`)).toBe(true);
  });

  it("飞书开放平台授权：open-apis 与 authen 两段都在才算（&&，不是 ||）", () => {
    expect(isAuthFlowUrl("https://open.feishu.cn/open-apis/authen/v1/index?app_id=x")).toBe(true);
    expect(isAuthFlowUrl("https://example.com/open-apis/authen/v1/index")).toBe(true);
    expect(isAuthFlowUrl("https://open.feishu.cn/open-apis/drive/v1/files")).toBe(false); // 只有 open-apis
    expect(isAuthFlowUrl("https://example.com/api/authen/v1/x")).toBe(false); // 只有 authen（且不在第一段）
  });
});

describe("query 键", () => {
  it.each(QUERY_KEYS)("?%s=… → 授权；键名大小写不敏感；必须整键相等（前后加字符不算）；放在 # 后面不算", (k) => {
    expect(isAuthFlowUrl(`https://example.com/page?${k}=1`)).toBe(true);
    expect(isAuthFlowUrl(`https://example.com/page?a=1&${k}=1`)).toBe(true);
    expect(isAuthFlowUrl(`https://example.com/page?${k.toUpperCase()}=1`)).toBe(true);
    expect(isAuthFlowUrl(`https://example.com/page?${k}x=1`)).toBe(false);
    expect(isAuthFlowUrl(`https://example.com/page?x${k}=1`)).toBe(false);
    expect(isAuthFlowUrl(`https://example.com/page#${k}=1`)).toBe(false);
  });

  it("普通 query（redirect / code / state / next）不算", () => {
    expect(isAuthFlowUrl("https://example.com/page?redirect=/home&code=abc&state=x&next=/a")).toBe(false);
  });
});

describe("decideHttpOpen：协议大小写与 reason 的先后顺序", () => {
  const env = (over: Partial<BuiltinOpenEnv> = {}): BuiltinOpenEnv => ({
    mode: "builtin",
    bridgeReady: true,
    serveLocalHtmlReady: true,
    hasTask: true,
    app: { hostname: "flowship.local", port: "8876" },
    ...over,
  });

  it.each(["HTTP://example.com/x", "HTTPS://example.com/x", "HtTpS://example.com/x"])("协议大小写不敏感：%s → builtin", (u) => {
    expect(decideHttpOpen(u, env())).toEqual({ kind: "builtin" });
  });

  it.each(["ftp://example.com/x", "file:///tmp/a.html", "mailto:a@b.c", "example.com/x", "//example.com/x"])("%s → not-http（排在设置 / 环境判断之前）", (u) => {
    expect(decideHttpOpen(u, env({ mode: "system", bridgeReady: false, hasTask: false }))).toEqual({ kind: "system", reason: "not-http" });
  });

  it("reason 的先后：not-http > setting-system > no-electron > no-task > app-origin > auth-flow", () => {
    const U = "https://sso.corp.example.com/login";
    const worst = env({ mode: "system", bridgeReady: false, hasTask: false, app: { hostname: "sso.corp.example.com", port: "" } });
    expect(decideHttpOpen(U, worst)).toEqual({ kind: "system", reason: "setting-system" });
    expect(decideHttpOpen(U, { ...worst, mode: "builtin" })).toEqual({ kind: "system", reason: "no-electron" });
    expect(decideHttpOpen(U, { ...worst, mode: "builtin", bridgeReady: true })).toEqual({ kind: "system", reason: "no-task" });
    expect(decideHttpOpen(U, { ...worst, mode: "builtin", bridgeReady: true, hasTask: true })).toEqual({ kind: "system", reason: "app-origin" });
    expect(decideHttpOpen(U, env())).toEqual({ kind: "system", reason: "auth-flow" });
    expect(decideHttpOpen(U, env({ explicit: true }))).toEqual({ kind: "builtin" }); // 显式内置：不再按授权启发式回退
    // 站内地址即使显式也回退（做不到的情况）
    expect(decideHttpOpen(U, { ...worst, mode: "builtin", bridgeReady: true, hasTask: true, explicit: true })).toEqual({ kind: "system", reason: "app-origin" });
  });
});

describe("isSameAppOrigin：回环别名 / 大小写 / 默认端口", () => {
  it("app 的主机名可能是 `localhost` / `127.0.0.1` / `[::1]` / `::1` / `0.0.0.0`：回环别名互通（同端口）", () => {
    for (const appHost of ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]) {
      for (const urlHost of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
        expect(isSameAppOrigin(`http://${urlHost}:3000/x`, { hostname: appHost, port: "3000" }), `${appHost} ↔ ${urlHost}`).toBe(true);
      }
      expect(isSameAppOrigin("http://localhost:3001/x", { hostname: appHost, port: "3000" }), `${appHost} 端口不同`).toBe(false);
    }
  });

  it("主机名大小写不敏感（app 侧也要转小写）；不同主机同端口不算", () => {
    expect(isSameAppOrigin("http://flowship.local:8876/", { hostname: "Flowship.LOCAL", port: "8876" })).toBe(true);
    expect(isSameAppOrigin("http://FLOWSHIP.local:8876/", { hostname: "flowship.local", port: "8876" })).toBe(true);
    expect(isSameAppOrigin("http://other.local:8876/", { hostname: "flowship.local", port: "8876" })).toBe(false);
    expect(isSameAppOrigin("http://flowship.local:8876/", { hostname: "localhost", port: "8876" })).toBe(false); // 非回环别名
  });

  it("默认端口：http 80 / https 443；app.port 为空按协议默认", () => {
    expect(isSameAppOrigin("http://example.com/", { hostname: "example.com", port: "" })).toBe(true);
    expect(isSameAppOrigin("http://example.com:80/", { hostname: "example.com", port: "" })).toBe(true);
    expect(isSameAppOrigin("https://example.com/", { hostname: "example.com", port: "" })).toBe(true);
    expect(isSameAppOrigin("https://example.com:443/", { hostname: "example.com", port: "443" })).toBe(true);
    expect(isSameAppOrigin("https://example.com/", { hostname: "example.com", port: "8876" })).toBe(false);
    expect(isSameAppOrigin("http://example.com:8876/", { hostname: "example.com", port: "" })).toBe(false);
  });

  it("非 http(s) / 解析失败 / app 为空 → false", () => {
    expect(isSameAppOrigin("ftp://example.com/", { hostname: "example.com", port: "" })).toBe(false);
    expect(isSameAppOrigin("not a url", { hostname: "example.com", port: "" })).toBe(false);
    expect(isSameAppOrigin("http://example.com/", null)).toBe(false);
    expect(isSameAppOrigin("http://example.com/", undefined)).toBe(false);
  });
});
