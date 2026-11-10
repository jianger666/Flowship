/**
 * 「HTML 和网页链接默认用内置浏览器打开」的决策与流程（src/lib/builtin-open.ts，纯 TS、依赖注入）。
 *
 * 钉住：
 * - 设置值：默认内置，只认显式 "system"
 * - 自动回退系统的每一个条件（设置选系统 / 非 Electron / 壳太旧 / 没有任务 / 登录授权链接 / 站内地址 / 非 http）各自单独能触发
 * - 登录授权链接启发式：正例（OAuth / SSO / SAML / CAS / 飞书授权）全命中，普通文档页不误伤
 * - R7-11：本机 / 局域网主机（localhost、127/8、RFC1918、::1、v4-mapped）整体豁免授权启发式——`localhost:3000/login` 走内置；
 *   豁免只认 `new URL` 规范化后的精确主机形态，伪装（`localhost.evil.com`、`evil.com/?next=http://localhost/login` …）不豁免
 * - 本地 HTML 流程：成功 / 登记失败回退 / 抛错回退 / 没人接单回退 / 过宽目录提示；每条路径最终都会「打开点什么」
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LINK_OPEN_MODE,
  LINK_OPEN_MODES,
  SCOPE_FILE_NOTICE,
  decideHttpOpen,
  decideLocalHtmlOpen,
  isAuthFlowUrl,
  isLocalOrPrivateHost,
  isSameAppOrigin,
  normalizeLinkOpenMode,
  openHttpLink,
  openLocalHtml,
  type BuiltinOpenDeps,
  type BuiltinOpenEnv,
} from "@/lib/builtin-open";

const APP = { hostname: "127.0.0.1", port: "8876" };
const env = (over: Partial<BuiltinOpenEnv> = {}): BuiltinOpenEnv => ({
  mode: "builtin",
  bridgeReady: true,
  serveLocalHtmlReady: true,
  hasTask: true,
  app: APP,
  ...over,
});

describe("设置值：默认内置，只认显式 system", () => {
  it("默认 builtin；候选集合固定两项", () => {
    expect(DEFAULT_LINK_OPEN_MODE).toBe("builtin");
    expect([...LINK_OPEN_MODES]).toEqual(["builtin", "system"]);
  });

  it.each([
    ["system", "system"],
    ["builtin", "builtin"],
    [undefined, "builtin"],
    [null, "builtin"],
    ["", "builtin"],
    ["SYSTEM", "builtin"],
    [1, "builtin"],
    [{}, "builtin"],
  ])("normalizeLinkOpenMode(%j) = %s", (input, expected) => {
    expect(normalizeLinkOpenMode(input)).toBe(expected);
  });
});

describe("decideHttpOpen：默认内置，每个回退条件各自独立生效", () => {
  const url = "https://example.com/docs/page";

  it("全部条件满足 → 内置", () => {
    expect(decideHttpOpen(url, env())).toEqual({ kind: "builtin" });
    expect(decideHttpOpen("http://localhost:3000/preview", env())).toEqual({ kind: "builtin" }); // 用户自己项目的 localhost:3000 不是站内
  });

  it("设置选系统 → system（setting-system）", () => {
    expect(decideHttpOpen(url, env({ mode: "system" }))).toEqual({ kind: "system", reason: "setting-system" });
  });

  it("不在 Electron（没有桥）→ system（no-electron）", () => {
    expect(decideHttpOpen(url, env({ bridgeReady: false }))).toEqual({ kind: "system", reason: "no-electron" });
  });

  it("没有任务上下文（设置页 / 首页）→ system（no-task）", () => {
    expect(decideHttpOpen(url, env({ hasTask: false }))).toEqual({ kind: "system", reason: "no-task" });
  });

  it("登录授权链接 → system（auth-flow），即使其它条件都满足", () => {
    expect(decideHttpOpen("https://github.com/login/oauth/authorize?client_id=abc", env())).toEqual({ kind: "system", reason: "auth-flow" });
  });

  it("explicit（右键「在内置浏览器打开」）：不再按授权链接启发式回退——显式意图优先", () => {
    const auth = "https://gitlab.com/users/sign_in";
    expect(decideHttpOpen(auth, env())).toEqual({ kind: "system", reason: "auth-flow" });
    expect(decideHttpOpen(auth, env({ explicit: true }))).toEqual({ kind: "builtin" });
    expect(decideHttpOpen(auth, env({ explicit: false }))).toEqual({ kind: "system", reason: "auth-flow" });
  });

  it("explicit 不绕过「做不到」的条件：没有桥 / 没有任务 / 站内地址 / 非 http 仍回退", () => {
    const auth = "https://gitlab.com/users/sign_in";
    expect(decideHttpOpen(auth, env({ explicit: true, bridgeReady: false }))).toEqual({ kind: "system", reason: "no-electron" });
    expect(decideHttpOpen(auth, env({ explicit: true, hasTask: false }))).toEqual({ kind: "system", reason: "no-task" });
    expect(decideHttpOpen("http://127.0.0.1:8876/", env({ explicit: true }))).toEqual({ kind: "system", reason: "app-origin" });
    expect(decideHttpOpen("file:///tmp/a.html", env({ explicit: true }))).toEqual({ kind: "system", reason: "not-http" });
  });

  it("Flowship 自己的地址 → system（app-origin）", () => {
    expect(decideHttpOpen("http://127.0.0.1:8876/api/tasks", env())).toEqual({ kind: "system", reason: "app-origin" });
    expect(decideHttpOpen("http://localhost:8876/", env())).toEqual({ kind: "system", reason: "app-origin" });
  });

  it("不是 http(s) → system（not-http）：不管设置 / 环境", () => {
    for (const u of ["file:///tmp/a.html", "javascript:alert(1)", "mailto:a@b.c", "cursor://file/tmp/a.ts", "/relative/path", ""]) {
      expect(decideHttpOpen(u, env()), u).toEqual({ kind: "system", reason: "not-http" });
    }
  });

  it("设置选系统时，优先级高于其它原因（原因报设置本身）", () => {
    expect(decideHttpOpen(url, env({ mode: "system", bridgeReady: false, hasTask: false }))).toEqual({ kind: "system", reason: "setting-system" });
  });
});

describe("decideLocalHtmlOpen", () => {
  it("全部满足 → 内置", () => {
    expect(decideLocalHtmlOpen(env())).toEqual({ kind: "builtin" });
  });
  it("设置选系统 / 没有桥 / 壳没有 serveLocalHtml / 没有任务 → 各自回退", () => {
    expect(decideLocalHtmlOpen(env({ mode: "system" }))).toEqual({ kind: "system", reason: "setting-system" });
    expect(decideLocalHtmlOpen(env({ bridgeReady: false, serveLocalHtmlReady: false }))).toEqual({ kind: "system", reason: "no-electron" });
    expect(decideLocalHtmlOpen(env({ serveLocalHtmlReady: false }))).toEqual({ kind: "system", reason: "no-serve-local-html" });
    expect(decideLocalHtmlOpen(env({ hasTask: false }))).toEqual({ kind: "system", reason: "no-task" });
  });
  it("本地 HTML 不看 URL 层面的条件（授权 / 站内）——那是 http 链接的事", () => {
    expect(decideLocalHtmlOpen(env({ app: null }))).toEqual({ kind: "builtin" });
  });
});

describe("isAuthFlowUrl：登录 / 授权类链接（启发式）", () => {
  it.each([
    // OAuth
    "https://github.com/login/oauth/authorize?client_id=Iv1.abc&redirect_uri=http%3A%2F%2Flocalhost",
    "https://gitlab.com/oauth/authorize?client_id=x",
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
    "https://auth.example.com/",
    "https://example.com/api/oauth2/authorize",
    "https://idp.example.com/realms/x/protocol/openid-connect/auth",
    "https://tenant.auth0.com/authorize?audience=x",
    "https://dev-123.okta.com/app/xyz/sso/saml",
    // 公司 SSO / 内网身份服务
    "https://sso.corp.example.com/login?service=https%3A%2F%2Fapp.corp.example.com",
    "https://login.corp.example.com/",
    "https://passport.corp.example.com/cas/login",
    "https://example.com/sso/start",
    "https://example.com/saml/acs",
    "https://example.com/cas/login?service=x",
    "https://example.com/login",
    "https://example.com/signin?next=/home",
    // 飞书
    "https://open.feishu.cn/open-apis/authen/v1/index?redirect_uri=https%3A%2F%2Fx&app_id=cli_abc",
    "https://open.feishu.cn/open-apis/authen/v1/index", // 只靠路径（没有 query）也要认
    "https://accounts.feishu.cn/accounts/page/login?app_id=1",
    "https://passport.feishu.cn/suite/passport/oauth/authorize?client_id=x",
    // 只靠 query 参数识别
    "https://example.com/start?client_id=abc&redirect_uri=https%3A%2F%2Fapp",
    "https://example.com/start?SAMLRequest=abc",
    "https://example.com/start?response_type=code&state=1",
    // R7-09：复审实测漏判的登录页写法
    "https://gitlab.com/users/sign_in",
    "https://my.feishu.cn/accounts/page/login?redirect_uri=x",
    "https://example.com/account/login",
    "https://example.com/user/login?redirect=%2Fhome",
    "https://example.com/session/new",
    "https://example.com/sessions/new",
    "https://example.com/accounts/foo", // 路径第一段 accounts
    "https://example.com/a/b/sign-in",
    "https://example.com/a/signin",
    "https://example.com/a/b/logon",
    "https://example.com/a/b/sso",
  ])("授权链接：%s", (u) => {
    expect(isAuthFlowUrl(u)).toBe(true);
  });

  it.each([
    "https://example.com/docs/page",
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure",
    "https://developer.example.com/docs/oauth-guide",
    "https://example.com/blog/how-to-login-faster",
    "https://github.com/anthropics/anthropic-sdk-python/issues/12",
    "https://stackoverflow.com/questions/1/oauth-vs-saml",
    "https://auth.io/",
    "https://login.com/",
    "http://localhost:3000/preview/index.html",
    "https://xxx.feishu.cn/docx/AbCdEf",
    "https://example.com/?q=login",
    "https://example.com/search?client=firefox",
    "https://example.com/author/zhangsan",
    "https://example.com/authors",
    "https://example.com/authentic",
    // R7-09：新增规则不能误伤的（路径段必须完整相等）
    "https://example.com/session/list",
    "https://example.com/sessions/42",
    "https://example.com/session",
    "https://example.com/blog/sign-in-with-apple-guide",
    "https://example.com/docs/ssolution",
    "https://example.com/logins",
    "https://example.com/users/signing",
    "https://example.com/account/settings",
  ])("普通页面不误伤：%s", (u) => {
    expect(isAuthFlowUrl(u)).toBe(false);
  });

  it("非法 URL → false（不抛）", () => {
    expect(isAuthFlowUrl("not a url")).toBe(false);
    expect(isAuthFlowUrl("")).toBe(false);
  });

  it("大小写不敏感（主机 / 路径 / query 参数名）", () => {
    expect(isAuthFlowUrl("https://SSO.Corp.Example.com/")).toBe(true);
    expect(isAuthFlowUrl("https://example.com/OAuth/Authorize")).toBe(true);
    expect(isAuthFlowUrl("https://example.com/x?Client_Id=1")).toBe(true);
  });
});

describe("R7-11 isLocalOrPrivateHost：本机 / 局域网主机（只认规范化后的精确形态）", () => {
  /** 与 isAuthFlowUrl 同一条路径：先过 `new URL` 规范化（`127.1` → `127.0.0.1`、`[0:0:0:0:0:0:0:1]` → `[::1]`），再看 hostname */
  const hostOf = (u: string) => new URL(u).hostname;

  it.each([
    // localhost 家族
    "http://localhost/",
    "http://LOCALHOST:3000/",
    "http://localhost./", // FQDN 末尾的点
    "http://foo.localhost:3000/",
    "http://a.b.localhost/",
    "http://a.localhost./",
    // 127.0.0.0/8
    "http://127.0.0.1/",
    "http://127.0.0.0/",
    "http://127.255.255.254/",
    "http://127.1/", // 规范成 127.0.0.1
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0177.0.0.1/",
    // 0.0.0.0
    "http://0.0.0.0:5173/",
    "http://0/",
    // RFC1918
    "http://10.0.0.5:8080/",
    "http://10.255.255.255/",
    "http://172.16.0.0/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.0.1/",
    "http://192.168.1.10:3000/",
    "http://192.168.255.255/",
    // IPv6：回环 / 未指定 / v4-mapped（规范成两个十六进制组）
    "http://[::1]:3000/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:10.0.0.5]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[::ffff:172.16.0.1]/",
    "http://[::ffff:172.31.0.1]/",
  ])("是本机 / 内网：%s", (u) => {
    expect(isLocalOrPrivateHost(hostOf(u))).toBe(true);
  });

  it.each([
    // 伪装：子串像、实际不是
    "http://localhost.evil.com/",
    "http://127.0.0.1.evil.com/",
    "http://notlocalhost/",
    "http://xlocalhost/",
    "http://localhostx/",
    "http://localhostx.com/",
    "http://localhost.localhost.evil.com/",
    "http://10.0.0.5.nip.io/",
    "http://192.168.1.1.nip.io/",
    "http://127.example.com/",
    "http://10.example.com/",
    "http://172.16.example.com/",
    "http://192.168.example.com/",
    "http://localhost@evil.com/", // hostname 是 evil.com
    "http://user:pass@localhost.evil.com/",
    // 紧挨着边界的公网 / 非内网地址
    "http://126.255.255.255/",
    "http://128.0.0.1/",
    "http://9.255.255.255/",
    "http://11.0.0.1/",
    "http://172.15.255.255/",
    "http://172.32.0.0/",
    "http://192.167.255.255/",
    "http://192.169.0.0/",
    "http://191.168.1.1/",
    "http://193.168.1.1/",
    "http://0.0.0.1/", // 只有 0.0.0.0 本身算
    "http://0.1.0.0/",
    "http://1.0.0.0/",
    "http://8.8.8.8/",
    "http://1.1.1.1/",
    "http://169.254.1.1/", // 链路本地不在名单里（只认 reviewer 列的范围）
    // IPv6：非回环 / 非 v4-mapped 本机
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[2001:db8::1]/",
    "http://[::2]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[::ffff:172.15.0.1]/",
    "http://[::ffff:172.32.0.1]/",
    "http://[::ffff:11.0.0.1]/",
    // 普通域名
    "http://example.com/",
    "https://accounts.google.com/",
    "http://local/",
    "http://host.docker.internal/", // 不要求（reviewer：剩 host.docker.internal / dev.local 不要求）
    "http://dev.local/",
  ])("不是本机 / 内网：%s", (u) => {
    expect(isLocalOrPrivateHost(hostOf(u)), u).toBe(false);
  });

  it("直接传非规范形态也不放行（函数自己有八位组范围检查；URL 规范化之后本来到不了这里）", () => {
    for (const h of ["127.0.0.256", "256.0.0.1", "10.300.0.1", "172.16.999.1", "192.168.1.256", "1.2.3", "1.2.3.4.5", "", ".", ".."]) {
      expect(isLocalOrPrivateHost(h), h).toBe(false);
    }
    // 非规范但在范围内的点分写法：函数按字面认（与 URL 规范化后一致）
    expect(isLocalOrPrivateHost("127.0.0.1")).toBe(true);
    expect(isLocalOrPrivateHost("[::ffff:127.0.0.1]")).toBe(true); // 点分的 v4-mapped 写法也兜
    expect(isLocalOrPrivateHost("[::ffff:8.8.8.8]")).toBe(false);
    expect(isLocalOrPrivateHost("[::ffff:300.0.0.1]")).toBe(false);
    // IPv6 必须成对方括号：只有开头的 `[`、尾巴多了字符，`slice(1, -1)` 恰好得到 `::1` 也不能算（变异 LP-v6-bracket）
    for (const h of ["[::1x", "[::]x", "[::ffff:7f00:1x", "[::1 ", "::1", "::", "::1]", "[::1"]) {
      expect(isLocalOrPrivateHost(h), h).toBe(false);
    }
    expect(isLocalOrPrivateHost("[::1]")).toBe(true);
    // 前缀 + IPv4 尾巴：整串不是 IP 字面量（`new URL` 对这种主机名会直接抛错，所以只能直接传字符串给函数测）
    for (const h of ["evil.127.0.0.1", "a.10.0.0.5", "x.192.168.1.1", "evil.0.0.0.0", "1.127.0.0.1", "foo.172.16.0.1"]) {
      expect(isLocalOrPrivateHost(h), h).toBe(false);
    }
    // 前几位命中、末位越界：不能因为 a 命中就放行（点分 v4-mapped 同样要查范围）
    expect(isLocalOrPrivateHost("[::ffff:127.0.0.256]")).toBe(false);
    expect(isLocalOrPrivateHost("[::ffff:10.0.0.999]")).toBe(false);
    expect(isLocalOrPrivateHost("[::ffff:192.168.256.1]")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(isLocalOrPrivateHost("LocalHost")).toBe(true);
    expect(isLocalOrPrivateHost("FOO.LOCALHOST")).toBe(true);
    expect(isLocalOrPrivateHost("[::FFFF:7F00:1]")).toBe(true);
  });
});

describe("R7-11 isAuthFlowUrl：本机 / 局域网开发页整体豁免，伪装不豁免", () => {
  it.each([
    // reviewer 复现的 5 条
    "http://localhost:3000/login",
    "http://127.0.0.1:5173/auth/callback?code=abc",
    "http://localhost:8000/accounts/login/",
    "http://[::1]:3000/signin",
    "http://myapp.localhost:3000/login",
    // 清单里的其它常见开发路径
    "http://localhost:5173/auth/callback",
    "http://localhost:8080/oauth2/authorization/github",
    "http://localhost:3000/users/sign_in",
    "http://localhost:3000/api/auth/signin",
    "http://localhost:3000/admin/login",
    "http://192.168.1.10:3000/login",
    "http://10.0.0.5:8080/login",
    "http://172.16.5.5/signin",
    "http://foo.localhost:3000/login",
    // 其它规则（query 参数 / 主机名第一段 / 路径第一段）命中也一样豁免
    "http://localhost:3000/start?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb",
    "http://127.0.0.1/?SAMLRequest=abc",
    "http://login.myapp.localhost:3000/",
    "http://sso.corp.localhost/",
    "http://localhost:3000/sso/start",
    "http://localhost:3000/oauth/authorize",
    // 规范化后的各种写法
    "http://[::ffff:7f00:1]/login",
    "http://[::ffff:127.0.0.1]/login",
    "http://127.1/login",
    "http://2130706433/login",
    "http://0x7f.1/login",
    "http://localhost./login",
    "http://LOCALHOST:3000/Login",
    "http://0.0.0.0:3000/login",
  ])("本机 / 内网开发页不算授权：%s", (u) => {
    expect(isAuthFlowUrl(u)).toBe(false);
  });

  it.each([
    // reviewer 点名「必须仍判授权」的伪装
    "http://localhost.evil.com/login",
    "http://127.0.0.1.evil.com/login",
    "http://localhost@evil.com/login",
    "http://evil.com/login#@localhost",
    "http://evil.com/?next=http://localhost/login&client_id=x",
    "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb&client_id=x&response_type=code",
    "https://github.com/login/oauth/authorize?client_id=x&redirect_uri=http://127.0.0.1:8080/cb",
    "http://notlocalhost/login",
    // 其它伪装 / 边界外的地址
    "http://xlocalhost:3000/login",
    "http://localhostx.com/login",
    "http://user:pass@localhost.evil.com/login",
    "http://10.0.0.5.nip.io/login",
    "http://192.168.1.1.nip.io/signin",
    "http://127.example.com/login",
    "http://172.32.0.1/login",
    "http://172.15.0.1/login",
    "http://192.169.1.1/login",
    "http://192.167.1.1/login",
    "http://11.0.0.1/login",
    "http://9.0.0.1/login",
    "http://128.0.0.1/login",
    "http://8.8.8.8/login",
    "http://[fe80::1]/login",
    "http://[::ffff:808:808]/login",
    "http://[2001:db8::1]/login",
    "http://evil.com/login",
    // 公网授权页不变
    "https://example.com/login",
    "https://accounts.google.com/",
    "https://sso.corp.example.com/",
  ])("仍判授权：%s", (u) => {
    expect(isAuthFlowUrl(u), u).toBe(true);
  });

  it("本机页也没有「豁免之后误判成别的东西」：普通页仍不是授权", () => {
    for (const u of ["http://localhost:3000/dashboard", "http://localhost:3000/", "http://192.168.1.10/docs/page"]) {
      expect(isAuthFlowUrl(u), u).toBe(false);
    }
  });
});

describe("R7-11 decideHttpOpen：本机 / 局域网开发页的 /login 默认走内置", () => {
  it.each([
    "http://localhost:3000/login",
    "http://127.0.0.1:5173/auth/callback?code=abc",
    "http://localhost:8000/accounts/login/",
    "http://[::1]:3000/signin",
    "http://myapp.localhost:3000/login",
    "http://192.168.1.10:3000/login",
    "http://10.0.0.5:8080/login",
  ])("默认左键 → builtin：%s", (u) => {
    expect(decideHttpOpen(u, env())).toEqual({ kind: "builtin" });
    expect(decideHttpOpen(u, env({ explicit: true }))).toEqual({ kind: "builtin" });
  });

  it("豁免只管授权启发式，其它回退条件照旧：设置选系统 / 没桥 / 没任务 / 站内地址", () => {
    const u = "http://localhost:3000/login";
    expect(decideHttpOpen(u, env({ mode: "system" }))).toEqual({ kind: "system", reason: "setting-system" });
    expect(decideHttpOpen(u, env({ bridgeReady: false }))).toEqual({ kind: "system", reason: "no-electron" });
    expect(decideHttpOpen(u, env({ hasTask: false }))).toEqual({ kind: "system", reason: "no-task" });
    // 指向 Flowship 自己的 /login（同端口）：先判站内，仍是 app-origin，不因为是 login / 本机而变
    expect(decideHttpOpen("http://127.0.0.1:8876/login", env())).toEqual({ kind: "system", reason: "app-origin" });
    expect(decideHttpOpen("http://localhost:8876/auth/callback", env())).toEqual({ kind: "system", reason: "app-origin" });
  });

  it("伪装仍回退系统（auth-flow）；公网授权页不变", () => {
    expect(decideHttpOpen("http://localhost.evil.com/login", env())).toEqual({ kind: "system", reason: "auth-flow" });
    expect(decideHttpOpen("http://127.0.0.1.evil.com/auth/callback", env())).toEqual({ kind: "system", reason: "auth-flow" });
    expect(decideHttpOpen("https://github.com/login/oauth/authorize?client_id=abc", env())).toEqual({ kind: "system", reason: "auth-flow" });
    // explicit 仍然能把公网授权页打到内置（原行为不变）
    expect(decideHttpOpen("https://gitlab.com/users/sign_in", env({ explicit: true }))).toEqual({ kind: "builtin" });
  });
});

describe("isSameAppOrigin：指向 Flowship 自己", () => {
  it("同端口 + 回环别名 / 同主机名 → true", () => {
    for (const u of ["http://127.0.0.1:8876/x", "http://localhost:8876/", "http://[::1]:8876/", "https://127.0.0.1:8876/", "http://0.0.0.0:8876/"]) {
      expect(isSameAppOrigin(u, APP), u).toBe(true);
    }
    expect(isSameAppOrigin("http://my-mac.local:8876/", { hostname: "my-mac.local", port: "8876" })).toBe(true);
  });
  it("端口不同（用户自己的 localhost:3000 / 本地 HTML 服务的随机端口）→ false", () => {
    expect(isSameAppOrigin("http://localhost:3000/", APP)).toBe(false);
    expect(isSameAppOrigin("http://127.0.0.1:54321/tok/index.html", APP)).toBe(false);
  });
  it("别的主机同端口 → false；非 http(s) → false；没有 app location → false；非法 → false", () => {
    expect(isSameAppOrigin("http://example.com:8876/", APP)).toBe(false);
    expect(isSameAppOrigin("file:///tmp/a.html", APP)).toBe(false);
    // 协议检查要独立生效：端口为空 + 默认端口的场景下，ftp 也不能被当成站内
    expect(isSameAppOrigin("ftp://localhost/", { hostname: "localhost", port: "" })).toBe(false);
    expect(isSameAppOrigin("http://127.0.0.1:8876/", null)).toBe(false);
    expect(isSameAppOrigin("nope", APP)).toBe(false);
  });
  it("默认端口：app 端口为空（80 / 443）时按协议默认端口比", () => {
    expect(isSameAppOrigin("http://localhost/", { hostname: "localhost", port: "" })).toBe(true);
    expect(isSameAppOrigin("https://localhost/", { hostname: "localhost", port: "" })).toBe(true);
    expect(isSameAppOrigin("http://localhost:8080/", { hostname: "localhost", port: "" })).toBe(false);
  });
});

describe("openHttpLink：点网页链接", () => {
  const deps = (over: { env?: Partial<BuiltinOpenEnv>; open?: boolean } = {}) => ({
    env: () => env(over.env),
    openInBuiltin: vi.fn(() => over.open ?? true),
  });

  it("内置：交给面板桥，返回 builtin（调用方 preventDefault）", () => {
    const d = deps();
    expect(openHttpLink("https://example.com/a", d)).toBe("builtin");
    expect(d.openInBuiltin).toHaveBeenCalledWith("https://example.com/a");
  });

  it.each([
    ["设置选系统", { mode: "system" as const }],
    ["非 Electron", { bridgeReady: false }],
    ["没有任务", { hasTask: false }],
  ])("%s → system，且完全没碰面板桥", (_label, over) => {
    const d = deps({ env: over });
    expect(openHttpLink("https://example.com/a", d)).toBe("system");
    expect(d.openInBuiltin).not.toHaveBeenCalled();
  });

  it("授权链接 / 站内地址 → system，没碰面板桥", () => {
    const d = deps();
    expect(openHttpLink("https://sso.corp.example.com/login", d)).toBe("system");
    expect(openHttpLink("http://127.0.0.1:8876/api/x", d)).toBe("system");
    expect(d.openInBuiltin).not.toHaveBeenCalled();
  });

  it("决策时有任务、真发请求时没人接单 → system（不吞点击）", () => {
    const d = deps({ open: false });
    expect(openHttpLink("https://example.com/a", d)).toBe("system");
    expect(d.openInBuiltin).toHaveBeenCalledTimes(1);
  });
});

describe("openLocalHtml：点本地 .html", () => {
  const FILE = "/Users/me/project/index.html";
  const make = (over: Partial<BuiltinOpenDeps> & { envOver?: Partial<BuiltinOpenEnv> } = {}) => {
    const base = {
      env: () => env(over.envOver),
      openInBuiltin: vi.fn<BuiltinOpenDeps["openInBuiltin"]>(() => true),
      serveLocalHtml: vi.fn<BuiltinOpenDeps["serveLocalHtml"]>(async () => ({ ok: true, url: "http://127.0.0.1:50000/tok/index.html", scope: "dir" })),
      openSystemPath: vi.fn<BuiltinOpenDeps["openSystemPath"]>(async () => {}),
      notify: vi.fn<BuiltinOpenDeps["notify"]>(),
    };
    const { envOver: _envOver, ...rest } = over;
    void _envOver;
    return { ...base, ...rest } as typeof base;
  };

  it("成功：登记 → 内置新标签；不碰系统打开，也不提示", async () => {
    const d = make();
    await expect(openLocalHtml(FILE, d)).resolves.toBe("builtin");
    expect(d.serveLocalHtml).toHaveBeenCalledWith(FILE);
    expect(d.openInBuiltin).toHaveBeenCalledWith("http://127.0.0.1:50000/tok/index.html");
    expect(d.openSystemPath).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("过宽目录（scope=file）：仍内置打开，但提示「只加载这一个文件」", async () => {
    const d = make({ serveLocalHtml: vi.fn(async () => ({ ok: true as const, url: "http://127.0.0.1:50000/tok/x.html", scope: "file" as const })) });
    await expect(openLocalHtml(FILE, d)).resolves.toBe("builtin");
    expect(d.notify).toHaveBeenCalledWith("info", SCOPE_FILE_NOTICE);
  });

  it.each([
    ["设置选系统", { mode: "system" as const }],
    ["非 Electron", { bridgeReady: false, serveLocalHtmlReady: false }],
    ["壳没有 serveLocalHtml", { serveLocalHtmlReady: false }],
    ["没有任务", { hasTask: false }],
  ])("%s → 直接系统默认应用，完全不登记服务", async (_label, envOver) => {
    const d = make({ envOver });
    await expect(openLocalHtml(FILE, d)).resolves.toBe("system");
    expect(d.openSystemPath).toHaveBeenCalledWith(FILE);
    expect(d.serveLocalHtml).not.toHaveBeenCalled();
    expect(d.openInBuiltin).not.toHaveBeenCalled();
  });

  it("登记失败（敏感文件 / 超大 / 不存在…）→ 提示原因 + 回退系统默认应用；不开内置标签", async () => {
    const d = make({ serveLocalHtml: vi.fn(async () => ({ ok: false as const, error: "文件太大（超过 50MB）" })) });
    await expect(openLocalHtml(FILE, d)).resolves.toBe("system");
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0]![1]).toContain("文件太大");
    expect(d.openSystemPath).toHaveBeenCalledWith(FILE);
    expect(d.openInBuiltin).not.toHaveBeenCalled();
  });

  it("登记抛错（IPC 被拒等）→ 同样回退系统，不抛", async () => {
    const d = make({
      serveLocalHtml: vi.fn(async () => {
        throw new Error("untrusted sender");
      }),
    });
    await expect(openLocalHtml(FILE, d)).resolves.toBe("system");
    expect(d.notify.mock.calls[0]![1]).toContain("untrusted sender");
    expect(d.openSystemPath).toHaveBeenCalledWith(FILE);
  });

  it("登记成功但没人接单（页面刚切走）→ 回退系统默认应用", async () => {
    const d = make({ openInBuiltin: vi.fn(() => false) });
    await expect(openLocalHtml(FILE, d)).resolves.toBe("system");
    expect(d.openSystemPath).toHaveBeenCalledWith(FILE);
  });

  it("系统打开本身失败：错误向调用方冒泡（组件 toast「浏览器打开失败」）", async () => {
    const d = make({
      envOver: { mode: "system" },
      openSystemPath: vi.fn(async () => {
        throw new Error("没有可用的默认应用");
      }),
    });
    await expect(openLocalHtml(FILE, d)).rejects.toThrow("没有可用的默认应用");
  });
});
