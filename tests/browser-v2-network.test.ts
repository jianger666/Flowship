/* eslint-disable @typescript-eslint/no-explicit-any -- 假 electron 对象 / 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * V2：网络环形缓冲的 id / 详情暂存 / 淘汰 / 取 body（tab.mjs），以及 network_detail 的纯组装逻辑（net-detail.mjs）。
 * 真 CDP 的响应体读取见 scripts/browser-e2e/v2-smoke.cjs。
 */
import { describe, expect, it, vi } from "vitest";

import {
  assembleNetworkDetail,
  clipBody,
  createNetworkDetailStore,
  decodeBody,
  isSensitiveHeader,
  isSensitiveQueryKey,
  isTextMime,
  missedResourceEntries,
  NET_BODY_MAX,
  NET_DETAIL_MAX,
  REDACTED,
  redactHeaders,
  redactUrlSecrets,
  resourceTypeOf,
  stashHeaders,
} from "../electron-app/browser/net-detail.mjs";
import { BrowserTab } from "../electron-app/browser/tab.mjs";

// ───────────────────────── 纯函数 ─────────────────────────

describe("net-detail：头脱敏", () => {
  it("契约列出的 6 个头一律 [已隐藏]（大小写不敏感），其它头原样", () => {
    const out: Record<string, string> = redactHeaders({
      Authorization: "Bearer abc",
      Cookie: "sid=1",
      "Set-Cookie": "sid=2; HttpOnly",
      "Proxy-Authorization": "Basic zzz",
      "X-Api-Key": "k",
      "x-auth-token": "t",
      "Content-Type": "application/json",
      Accept: "*/*",
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out["Set-Cookie"]).toBe(REDACTED);
    expect(out["Proxy-Authorization"]).toBe(REDACTED);
    expect(out["X-Api-Key"]).toBe(REDACTED);
    expect(out["x-auth-token"]).toBe(REDACTED);
    expect(out["Content-Type"]).toBe("application/json");
    expect(out.Accept).toBe("*/*");
  });

  it("名字里带 token / secret / api-key / password 的头也隐藏（比契约更严）；头名本身保留", () => {
    const out = redactHeaders({ "X-CSRF-Token": "c", "x-client-secret": "s", "X-Custom-Api-Key": "k", "X-Password": "p", "X-Trace": "ok" });
    expect(Object.keys(out)).toEqual(["X-CSRF-Token", "x-client-secret", "X-Custom-Api-Key", "X-Password", "X-Trace"]);
    expect(out["X-CSRF-Token"]).toBe(REDACTED);
    expect(out["x-client-secret"]).toBe(REDACTED);
    expect(out["X-Custom-Api-Key"]).toBe(REDACTED);
    expect(out["X-Password"]).toBe(REDACTED);
    expect(out["X-Trace"]).toBe("ok");
    expect(isSensitiveHeader("Content-Length")).toBe(false);
    expect(isSensitiveHeader(undefined)).toBe(false);
  });

  it("redactHeaders / stashHeaders 对非法输入稳健；stash 限条数与单值长度、不脱敏", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders(null)).toEqual({});
    expect(stashHeaders("x")).toEqual({});
    const many: Record<string, string> = {};
    for (let i = 0; i < 150; i++) many[`h${i}`] = "v";
    expect(Object.keys(stashHeaders(many))).toHaveLength(100);
    const long = stashHeaders({ a: "x".repeat(5000), Authorization: "Bearer raw" });
    expect(long.a).toHaveLength(2001);
    expect(long.Authorization).toBe("Bearer raw"); // 暂存不脱敏，输出才脱敏
  });
});

describe("net-detail：mime / body 判断", () => {
  it("isTextMime：文本类放行（含参数 / +json / +xml），二进制拒绝", () => {
    for (const m of [
      "application/json",
      "application/json; charset=utf-8",
      "text/html",
      "text/plain;charset=UTF-8",
      "application/xml",
      "application/ld+json",
      "image/svg+xml",
      "application/javascript",
      "text/javascript",
      "application/x-www-form-urlencoded",
      "TEXT/CSS",
    ]) {
      expect(isTextMime(m), m).toBe(true);
    }
    for (const m of ["image/png", "application/octet-stream", "application/pdf", "video/mp4", "font/woff2", "", undefined, null]) {
      expect(isTextMime(m as string), String(m)).toBe(false);
    }
  });

  it("clipBody 在上限处截断并标记；decodeBody 处理 base64", () => {
    expect(clipBody("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(clipBody("abcdefg", 5)).toEqual({ text: "abcde", truncated: true });
    expect(clipBody("x".repeat(NET_BODY_MAX + 1)).truncated).toBe(true);
    expect(decodeBody({ body: "hello", base64Encoded: false })).toBe("hello");
    expect(decodeBody({ body: Buffer.from("中文 body", "utf8").toString("base64"), base64Encoded: true })).toBe("中文 body");
  });
});

describe("net-detail：详情暂存表", () => {
  it("上限 200，插入序淘汰最旧；clear 清空", () => {
    expect(NET_DETAIL_MAX).toBe(200);
    const s = createNetworkDetailStore(3);
    for (let i = 1; i <= 5; i++) s.add(i, { n: i });
    expect(s.ids()).toEqual([3, 4, 5]);
    expect(s.has(1)).toBe(false);
    expect(s.get(5)).toEqual({ n: 5 });
    s.clear();
    expect(s.size()).toBe(0);
  });
});

describe("net-detail：assembleNetworkDetail", () => {
  const entry = { id: 12, ts: 1, method: "POST", url: "https://a.test/api", status: 200, type: "Fetch", durationMs: 33 };
  const detail = {
    requestHeaders: { Authorization: "Bearer abc", "Content-Type": "application/json" },
    responseHeaders: { "Set-Cookie": "s=1", "Content-Type": "application/json" },
    mimeType: "application/json",
    postData: '{"a":1}',
  };

  it("不带 body：只有状态与脱敏后的头，没有 body 相关字段", () => {
    const r = assembleNetworkDetail({ entry, detail, includeBody: false });
    expect(r).toMatchObject({ id: 12, method: "POST", status: 200, type: "Fetch", durationMs: 33, mimeType: "application/json" });
    expect(r.requestHeaders.Authorization).toBe(REDACTED);
    expect(r.responseHeaders["Set-Cookie"]).toBe(REDACTED);
    expect(r.requestHeaders["Content-Type"]).toBe("application/json");
    expect(r).not.toHaveProperty("requestBody");
    expect(r).not.toHaveProperty("responseBody");
    expect(r).not.toHaveProperty("bodyUnavailableReason");
  });

  it("带 body：文本类给 responseBody + requestBody；失败给 reason；非文本 mime 给 reason", () => {
    const ok = assembleNetworkDetail({ entry, detail, includeBody: true, response: { ok: true, body: '{"ok":true}', base64Encoded: false } });
    expect(ok.requestBody).toBe('{"a":1}');
    expect(ok.responseBody).toBe('{"ok":true}');
    expect(ok).not.toHaveProperty("bodyUnavailableReason");

    const gone = assembleNetworkDetail({ entry, detail, includeBody: true, response: { ok: false, reason: "已被回收" } });
    expect(gone.bodyUnavailableReason).toBe("已被回收");
    expect(gone).not.toHaveProperty("responseBody");

    const bin = assembleNetworkDetail({
      entry,
      detail: { ...detail, mimeType: "image/png" },
      includeBody: true,
      response: { ok: true, body: "AAAA", base64Encoded: true },
    });
    expect(bin.bodyUnavailableReason).toMatch(/image\/png/);
    expect(bin).not.toHaveProperty("responseBody");
  });

  it("body 超 20000 字符截断并标 bodyTruncated；失败请求带 failed / errorText", () => {
    const big = assembleNetworkDetail({
      entry: { ...entry, failed: true, errorText: "net::ERR_FAILED" },
      detail,
      includeBody: true,
      response: { ok: true, body: "y".repeat(30_000) },
    });
    expect(big.responseBody).toHaveLength(NET_BODY_MAX);
    expect(big.bodyTruncated).toBe(true);
    expect(big.failed).toBe(true);
    expect(big.errorText).toBe("net::ERR_FAILED");
  });
});

// ───────────────────────── R1-26：头名包含式 + URL / Location / Referer 的查询参数脱敏 ─────────────────────────

describe("net-detail：头名包含式脱敏（R1-26）", () => {
  it("评审点名的漏项：x-auth-key / ocp-apim-subscription-key / *signature* / *session* 都被隐藏，且大小写不敏感", () => {
    const sensitive = [
      "X-Auth-Key", "x-auth-key", "Ocp-Apim-Subscription-Key", "X-Hub-Signature", "X-Hub-Signature-256", "X-Amz-Signature",
      "X-Session-Id", "Session-Token", "Cf-Access-Jwt-Assertion", "X-Amz-Security-Token", "X-Amz-Credential", "X-XSRF-TOKEN",
      "X-CSRF-Token", "Api-Key", "apikey", "x-functions-key", "X-Goog-Api-Key", "Private-Key", "Proxy-Authorization",
      "Authorization", "Cookie", "Set-Cookie", "Cookie2", "X-Access-Token", "X-Client-Secret", "X-Password", "X-Passwd",
    ];
    for (const n of sensitive) expect(isSensitiveHeader(n), n).toBe(true);
    const out = redactHeaders(Object.fromEntries(sensitive.map((n) => [n, "RAW-SECRET-VALUE"])));
    for (const n of sensitive) expect(out[n], n).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain("RAW-SECRET-VALUE");
  });

  it("常见的无害头不被误藏（回归：不能把整页头都藏光）", () => {
    const harmless = [
      "Content-Type", "Content-Length", "Content-Encoding", "Content-Disposition", "Content-Security-Policy", "Strict-Transport-Security",
      "Cache-Control", "Etag", "Expires", "Last-Modified", "Vary", "Date", "Server", "Via", "Age", "Pragma", "Connection", "Keep-Alive",
      "Accept", "Accept-Encoding", "Accept-Language", "Host", "Origin", "Referer", "Location", "User-Agent", "Sec-Fetch-Site",
      "Sec-Fetch-Mode", "Sec-Ch-Ua", "Sec-Ch-Ua-Platform", "Access-Control-Allow-Origin", "Access-Control-Allow-Headers",
      "Access-Control-Allow-Methods", "Access-Control-Expose-Headers", "Referrer-Policy", "X-Frame-Options", "X-Content-Type-Options",
      "X-Request-Id", "X-Forwarded-For", "Server-Timing", "Timing-Allow-Origin", "Transfer-Encoding", "Link", "Alt-Svc", "Report-To",
      "Upgrade-Insecure-Requests", "Permissions-Policy", "Cf-Ray", "X-Powered-By", "Retry-After",
    ];
    for (const n of harmless) expect(isSensitiveHeader(n), n).toBe(false);
  });

  it("豁免：www-authenticate / proxy-authenticate（服务端质询）与 access-control-allow-credentials（布尔开关）保持可见", () => {
    const out = redactHeaders({
      "WWW-Authenticate": 'Bearer realm="api", error="invalid_token"',
      "Proxy-Authenticate": "Basic realm=proxy",
      "Access-Control-Allow-Credentials": "true",
    });
    expect(out["WWW-Authenticate"]).toBe('Bearer realm="api", error="invalid_token"');
    expect(out["Proxy-Authenticate"]).toBe("Basic realm=proxy");
    expect(out["Access-Control-Allow-Credentials"]).toBe("true");
    // 但豁免的头值里若嵌着带密钥的 URL，仍然脱敏
    expect(redactHeaders({ "WWW-Authenticate": 'Bearer realm="https://a/b?token=SECRET"' })["WWW-Authenticate"]).not.toContain("SECRET");
  });
});

describe("net-detail：redactUrlSecrets / isSensitiveQueryKey（R1-26）", () => {
  it("查询串：评审点名的 code / key / sig / sid 与常见凭据参数，值被隐藏、键名保留、别的参数原样", () => {
    const r = redactUrlSecrets("https://a.test/cb?code=AUTHCODE&state=xyz&key=K1&sig=S1&sid=SID1&page=2&q=hello");
    expect(r).toBe(`https://a.test/cb?code=${REDACTED}&state=xyz&key=${REDACTED}&sig=${REDACTED}&sid=${REDACTED}&page=2&q=hello`);
    for (const s of ["AUTHCODE", "K1", "S1", "SID1"]) expect(r).not.toContain(s);
  });

  it("各种写法的凭据参数名：驼峰 / 下划线 / 连字符 / 方括号 / percent 编码 / 拼在一起", () => {
    const keys = [
      "access_token", "refresh_token", "id_token", "accessToken", "client_secret", "clientSecret", "api_key", "apiKey", "APIKey", "apikey",
      "api-key", "auth", "authorization", "Authorization", "password", "passwd", "pwd", "session", "sessionid", "sessionId", "jsessionid",
      "PHPSESSID", "signature", "X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token", "oauth_token", "oauth_signature", "sign",
      "ticket", "otp", "jwt", "auth[token]", "user[password]", "%74oken", "ACCESSTOKEN", "mySecretValue",
    ];
    for (const k of keys) {
      expect(isSensitiveQueryKey(k), k).toBe(true);
      const url = `https://a.test/x?${k}=RAW&ok=1`;
      const out = redactUrlSecrets(url);
      expect(out, k).not.toContain("RAW");
      expect(out, k).toContain("ok=1");
    }
  });

  it("不误伤：keyword / author / design / passenger / bypass / monkey / zipcode / page / q / lang / utm_source", () => {
    for (const k of ["keyword", "keywords", "author", "authority", "design", "passenger", "bypass", "monkey", "zipcode", "page", "q", "lang", "utm_source", "id", "name", "filter", "sort", "redirect_uri", "state", "size", "format"]) {
      expect(isSensitiveQueryKey(k), k).toBe(false);
      expect(redactUrlSecrets(`https://a.test/x?${k}=VISIBLE`), k).toContain("VISIBLE");
    }
  });

  it("fragment（OAuth implicit 流的 #access_token=…）、`;` 矩阵参数（;jsessionid=）也脱敏", () => {
    expect(redactUrlSecrets("https://a.test/cb#access_token=TOK&token_type=bearer&expires_in=3600&state=s")).toBe(
      `https://a.test/cb#access_token=${REDACTED}&token_type=${REDACTED}&expires_in=3600&state=s`,
    );
    expect(redactUrlSecrets("/app;jsessionid=ABC123?x=1")).toBe(`/app;jsessionid=${REDACTED}?x=1`);
    expect(redactUrlSecrets("https://a.test/doc#section-2")).toBe("https://a.test/doc#section-2"); // 普通锚点原样
  });

  it("userinfo：user:pass@host 与 token@host 整段隐藏；路径里的 @ 不是 userinfo", () => {
    expect(redactUrlSecrets("https://alice:hunter2@host.test/p?x=1")).toBe(`https://${REDACTED}@host.test/p?x=1`);
    expect(redactUrlSecrets("https://ghp_abcdefghijklmnop@github.com/a/b.git")).toBe(`https://${REDACTED}@github.com/a/b.git`);
    expect(redactUrlSecrets("https://example.com/@user/profile?k=1")).toBe("https://example.com/@user/profile?k=1");
    expect(redactUrlSecrets("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("值本身长得像凭据（JWT / 常见带前缀的密钥）：不管参数名叫什么都隐藏", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl";
    expect(redactUrlSecrets(`https://a.test/?foo=${jwt}&x=1`)).toBe(`https://a.test/?foo=${REDACTED}&x=1`);
    for (const v of ["ghp_abcdefghijklmnopqrstuv", "sk-abcdefghijklmnopqrstuv", "xoxb-1234567890-abcdef", "AKIAIOSFODNN7EXAMPLE"]) {
      expect(redactUrlSecrets(`/p?data=${v}`), v).toBe(`/p?data=${REDACTED}`);
    }
    expect(redactUrlSecrets("/p?data=eyJ")).toBe("/p?data=eyJ"); // 太短不算
  });

  it("相对 Location、Link（多个内嵌 URL）、Refresh（值里再嵌 URL）都能处理，内层参数不会被外层吞掉而漏脱敏", () => {
    expect(redactUrlSecrets("/oauth/cb?code=1&x=2")).toBe(`/oauth/cb?code=${REDACTED}&x=2`);
    expect(redactUrlSecrets('<https://a/b?token=1>; rel="next", <https://a/c?sig=2&x=3>; rel=prev')).toBe(
      `<https://a/b?token=${REDACTED}>; rel="next", <https://a/c?sig=${REDACTED}&x=3>; rel=prev`,
    );
    expect(redactUrlSecrets("0;url=https://a/b?token=1&q=2")).toBe(`0;url=https://a/b?token=${REDACTED}&q=2`);
  });

  it("不改普通头值 / 空值 / 非字符串；值里的 = 与重复键都处理", () => {
    expect(redactUrlSecrets("text/html; charset=utf-8")).toBe("text/html; charset=utf-8");
    expect(redactUrlSecrets("application/json;charset=utf-8")).toBe("application/json;charset=utf-8");
    expect(redactUrlSecrets('attachment;filename="a.pdf"')).toBe('attachment;filename="a.pdf"');
    expect(redactUrlSecrets("max-age=0, no-cache")).toBe("max-age=0, no-cache");
    expect(redactUrlSecrets("")).toBe("");
    expect(redactUrlSecrets(undefined)).toBe("");
    expect(redactUrlSecrets(null)).toBe("");
    expect(redactUrlSecrets(123)).toBe("123");
    expect(redactUrlSecrets("https://a/?q=a=b==&sid=zz")).toBe(`https://a/?q=a=b==&sid=${REDACTED}`);
    expect(redactUrlSecrets("https://a/?token=1&token=2&keep=3")).toBe(`https://a/?token=${REDACTED}&token=${REDACTED}&keep=3`);
  });

  it("redactHeaders：Location / Referer / Link / Origin 等「非敏感名」的头值里的 URL 参数也脱敏", () => {
    const out = redactHeaders({
      Location: "https://idp.test/cb?code=SECRETCODE&state=s",
      Referer: "https://app.test/page?session_id=SECRETSID&tab=1",
      Link: "<https://a/n?sig=SECRETSIG>; rel=next",
      "X-Forwarded-Uri": "/x?api_key=SECRETKEY",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(out.Location).toBe(`https://idp.test/cb?code=${REDACTED}&state=s`);
    expect(out.Referer).toBe(`https://app.test/page?session_id=${REDACTED}&tab=1`);
    expect(out.Link).toBe(`<https://a/n?sig=${REDACTED}>; rel=next`);
    expect(out["X-Forwarded-Uri"]).toBe(`/x?api_key=${REDACTED}`);
    expect(out["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
  });

  it("assembleNetworkDetail：url 字段与头里的 URL 都脱敏；失败请求 / 缺 url 不炸", () => {
    const entry = { id: 1, ts: 1, method: "GET", url: "https://a.test/cb?code=SECRETCODE&page=2#access_token=SECRETTOK", status: 302, type: "Document" };
    const detail = {
      requestHeaders: { Referer: "https://a.test/login?password=SECRETPW" },
      responseHeaders: { Location: "https://a.test/home?ticket=SECRETTICKET&next=%2F", "Set-Cookie": "s=SECRETCOOKIE" },
      mimeType: "text/html",
    };
    const r = assembleNetworkDetail({ entry, detail, includeBody: false });
    expect(r.url).toBe(`https://a.test/cb?code=${REDACTED}&page=2#access_token=${REDACTED}`);
    expect(r.requestHeaders.Referer).toBe(`https://a.test/login?password=${REDACTED}`);
    expect(r.responseHeaders.Location).toBe(`https://a.test/home?ticket=${REDACTED}&next=%2F`);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    expect(assembleNetworkDetail({ entry: { id: 2, method: "GET", type: "Other" }, detail: {}, includeBody: false }).url).toBeUndefined();
  });
});

// ───────────────────────── BrowserTab 的网络环形缓冲 ─────────────────────────

const makeTab = (handlers: Record<string, (params: Record<string, unknown>, sessionId: string | null) => unknown> = {}) => {
  const sent: Array<{ method: string; params: Record<string, unknown>; sessionId: string | null }> = [];
  let attached = false;
  let onMessage: (e: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void = () => {};
  const dbg = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    on: (ev: string, fn: never) => {
      if (ev === "message") onMessage = fn;
    },
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId: sessionId ?? null });
      const h = handlers[method];
      if (h) return h(params, sessionId ?? null);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      return {};
    }),
  };
  const wc = {
    debugger: dbg,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    loadURL: vi.fn(async () => {}),
    getURL: () => "https://example.com/",
    getTitle: () => "示例",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    close: vi.fn(),
  };
  class FakeView {
    webContents = wc;
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  const hooks = new Proxy({}, { get: () => vi.fn() }) as never;
  const tab = new BrowserTab({
    id: "t1",
    WebContentsView: FakeView as never,
    parkingWindow: { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } },
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: () => false,
    hooks,
  } as any);
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => onMessage(null, method, params, sessionId);

  let ts = 100;
  /** 一个完整请求：发起 → 响应 → 完成 */
  const request = (rid: string, o: { url?: string; method?: string; status?: number; mime?: string; postData?: string; type?: string; sessionId?: string } = {}) => {
    emit(
      "Network.requestWillBeSent",
      {
        requestId: rid,
        timestamp: ts,
        type: o.type ?? "Fetch",
        request: {
          url: o.url ?? `https://a.test/${rid}`,
          method: o.method ?? "GET",
          headers: { Authorization: "Bearer topsecret", "Content-Type": "application/json" },
          ...(o.postData !== undefined ? { postData: o.postData, hasPostData: true } : {}),
        },
      },
      o.sessionId,
    );
    emit(
      "Network.responseReceived",
      {
        requestId: rid,
        type: o.type ?? "Fetch",
        response: { status: o.status ?? 200, mimeType: o.mime ?? "application/json", headers: { "Set-Cookie": "s=1", "X-Req": rid } },
      },
      o.sessionId,
    );
    ts += 0.05;
    emit("Network.loadingFinished", { requestId: rid, timestamp: ts }, o.sessionId);
  };
  return { tab, sent, emit, request, dbg };
};

describe("BrowserTab 网络环形缓冲：id", () => {
  it("每条带单调递增 id（flush 时分配 = 列表顺序），环里的条目只有轻量字段、没有暂存头 / 内部字段", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.request("r1");
    h.request("r2", { method: "POST", status: 500 });
    const list = h.tab.networkRing.list();
    expect(list.map((e: any) => e.id)).toEqual([1, 2]);
    expect(list[1]).toMatchObject({ id: 2, method: "POST", status: 500, failed: true, type: "Fetch" });
    for (const e of list) {
      expect(Object.keys(e).some((k) => k.startsWith("__"))).toBe(false);
      expect(e).not.toHaveProperty("requestHeaders");
      expect(e).not.toHaveProperty("responseHeaders");
    }
  });

  it("详情暂存：请求头 / 响应头 / mime / postData / requestId / sessionId；getNetworkEntry 按 id 取", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.request("rid-A", { method: "POST", postData: '{"x":1}', mime: "application/json", sessionId: "child-1" });
    const got = h.tab.getNetworkEntry(1)!;
    expect(got.entry).toMatchObject({ id: 1, method: "POST" });
    expect(got.detail).toMatchObject({
      requestId: "rid-A",
      sessionId: "child-1",
      mimeType: "application/json",
      postData: '{"x":1}',
      redirected: false,
    });
    expect(got.detail.requestHeaders.Authorization).toBe("Bearer topsecret"); // 暂存里是原值，输出时才脱敏
    expect(got.detail.responseHeaders["X-Req"]).toBe("rid-A");
    expect(h.tab.getNetworkEntry(99)).toBeNull();
  });

  it("postData 只留前 20000 字符", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.request("big", { method: "POST", postData: "p".repeat(30_000) });
    expect(h.tab.getNetworkEntry(1)!.detail!.postData).toHaveLength(NET_BODY_MAX);
  });

  it("重定向：中间跳单独成条并标 redirected（没有响应体），最终跳照常", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.emit("Network.requestWillBeSent", { requestId: "rr", timestamp: 1, type: "Document", request: { url: "https://a.test/old", method: "GET", headers: {} } });
    h.emit("Network.requestWillBeSent", {
      requestId: "rr",
      timestamp: 1.1,
      type: "Document",
      request: { url: "https://a.test/new", method: "GET", headers: {} },
      redirectResponse: { status: 302, mimeType: "text/html", headers: { Location: "/new" } },
    });
    h.emit("Network.responseReceived", { requestId: "rr", type: "Document", response: { status: 200, mimeType: "text/html", headers: {} } });
    h.emit("Network.loadingFinished", { requestId: "rr", timestamp: 1.3 });
    const list = h.tab.networkRing.list();
    expect(list.map((e: any) => [e.id, e.status])).toEqual([
      [1, 302],
      [2, 200],
    ]);
    expect(h.tab.getNetworkEntry(1)!.detail).toMatchObject({ redirected: true, responseHeaders: { Location: "/new" } });
    const body = await h.tab.fetchNetworkResponseBody(1);
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/重定向/);
    expect(h.sent.some((s) => s.method === "Network.getResponseBody")).toBe(false);
  });

  it("淘汰：详情暂存只留最近 200 条；更早的条目仍在环里（上限 500）但 detail 为 null，id 不回绕", async () => {
    const h = makeTab();
    await h.tab.ready;
    for (let i = 1; i <= 260; i++) h.request(`r${i}`);
    expect(h.tab.networkRing.size()).toBe(260);
    expect(h.tab.netDetails.size()).toBe(200);
    expect(h.tab.getNetworkEntry(1)!.detail).toBeNull();
    expect(h.tab.getNetworkEntry(60)!.detail).toBeNull(); // 260 条里保留最近 200 条 = id 61..260
    expect(h.tab.getNetworkEntry(61)!.detail).not.toBeNull();
    expect(h.tab.getNetworkEntry(260)!.detail!.requestId).toBe("r260");

    // 超过环上限：最旧的从环里丢掉，id 保持单调
    for (let i = 261; i <= 520; i++) h.request(`r${i}`);
    const ids = h.tab.networkRing.list().map((e: any) => e.id);
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe(21);
    expect(ids[499]).toBe(520);
    expect(h.tab.networkRing.dropped).toBe(20);
    expect(h.tab.getNetworkEntry(5)).toBeNull();
  });

  describe("早期子资源补录（渲染进程 Network 代理晚启用：没有 requestWillBeSent，只有 responseReceived / loadingFinished）", () => {
    it("responseReceived 带 URL 时补建一条：GET、状态 / 类型 / 耗时取自响应计时，之后 loadingFinished 正常收尾并进环", async () => {
      const h = makeTab();
      await h.tab.ready;
      h.emit("Network.responseReceived", {
        requestId: "early-img",
        timestamp: 50.2,
        type: "Image",
        response: { url: "https://a.test/logo.png", status: 200, mimeType: "image/png", headers: { "Content-Length": "68" }, timing: { requestTime: 50.0 } },
      });
      expect(h.tab.networkRing.size()).toBe(0); // 还没收尾不进环
      h.emit("Network.loadingFinished", { requestId: "early-img", timestamp: 50.25 });
      const [e] = h.tab.networkRing.list() as any[];
      expect(e).toMatchObject({ id: 1, method: "GET", url: "https://a.test/logo.png", status: 200, type: "Image" });
      expect(e.durationMs).toBe(250);
      expect(e.failed).toBeUndefined();
      // 暂存里有响应头 / mime；请求头拿不到，是空对象；仍可按 requestId 取响应体
      const got = h.tab.getNetworkEntry(1)!;
      expect(got.detail).toMatchObject({ requestId: "early-img", mimeType: "image/png", requestHeaders: {} });
      expect(got.detail.responseHeaders["Content-Length"]).toBe("68");
    });

    it("没有 timing.requestTime 时耗时退回以响应到达时刻为起点（≥ 0，不会是 NaN）", async () => {
      const h = makeTab();
      await h.tab.ready;
      h.emit("Network.responseReceived", { requestId: "e2", timestamp: 10, type: "Script", response: { url: "https://a.test/a.js", status: 200, mimeType: "text/javascript", headers: {} } });
      h.emit("Network.loadingFinished", { requestId: "e2", timestamp: 10.1 });
      const [e] = h.tab.networkRing.list() as any[];
      expect(e.url).toBe("https://a.test/a.js");
      expect(Number.isFinite(e.durationMs)).toBe(true);
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("4xx / 5xx 的早期子资源照样标 failed（走 flush 里统一的状态码规则）", async () => {
      const h = makeTab();
      await h.tab.ready;
      h.emit("Network.responseReceived", { requestId: "e3", timestamp: 1, type: "Stylesheet", response: { url: "https://a.test/missing.css", status: 404, mimeType: "text/html", headers: {} } });
      h.emit("Network.loadingFinished", { requestId: "e3", timestamp: 1.05 });
      expect((h.tab.networkRing.list() as any[])[0]).toMatchObject({ status: 404, failed: true, type: "Stylesheet" });
    });

    it("补不了的情况：没有 URL / data: / blob: 的 responseReceived，以及单独到达的 loadingFinished / loadingFailed，都静默忽略", async () => {
      const h = makeTab();
      await h.tab.ready;
      h.emit("Network.responseReceived", { requestId: "x1", timestamp: 1, type: "Image", response: { status: 200, mimeType: "image/png", headers: {} } });
      h.emit("Network.responseReceived", { requestId: "x2", timestamp: 1, type: "Image", response: { url: "data:image/png;base64,AAAA", status: 200, mimeType: "image/png", headers: {} } });
      h.emit("Network.responseReceived", { requestId: "x3", timestamp: 1, type: "Image", response: { url: "blob:https://a.test/uuid", status: 200, mimeType: "image/png", headers: {} } });
      h.emit("Network.loadingFinished", { requestId: "x4", timestamp: 2 });
      h.emit("Network.loadingFailed", { requestId: "x5", timestamp: 2, errorText: "net::ERR_FAILED" });
      for (const rid of ["x1", "x2", "x3", "x4", "x5"]) h.emit("Network.loadingFinished", { requestId: rid, timestamp: 3 });
      expect(h.tab.networkRing.size()).toBe(0);
    });

    it("补录建的在途条目与正常路径一样封顶 2000（只来 responseReceived、一直收不到完成事件时不能无限涨）", async () => {
      const h = makeTab();
      await h.tab.ready;
      for (let i = 0; i < 2100; i++) {
        h.emit("Network.responseReceived", { requestId: `never-${i}`, timestamp: 1, type: "Image", response: { url: `https://a.test/${i}.png`, status: 200, mimeType: "image/png", headers: {} } });
      }
      expect(h.tab.inflight.size).toBe(2000);
      expect(h.tab.inflightRequestCount).toBe(2000);
    });

    it("正常路径不受影响：有 requestWillBeSent 的请求仍用它的方法 / 请求头，不会被补录覆盖", async () => {
      const h = makeTab();
      await h.tab.ready;
      h.request("normal", { method: "POST", url: "https://a.test/api", type: "XHR" });
      const [e] = h.tab.networkRing.list() as any[];
      expect(e).toMatchObject({ method: "POST", url: "https://a.test/api", type: "XHR" });
      expect(h.tab.getNetworkEntry(1)!.detail.requestHeaders.Authorization).toBe("Bearer topsecret");
    });
  });

  it("canceled 的 loadingFailed 不算失败（保留记录，failed 不置位）；非 canceled 才算", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.emit("Network.requestWillBeSent", { requestId: "c1", timestamp: 1, type: "Image", request: { url: "https://a.test/c.png", method: "GET", headers: {} } });
    h.emit("Network.loadingFailed", { requestId: "c1", timestamp: 1.1, errorText: "net::ERR_ABORTED", canceled: true });
    h.emit("Network.requestWillBeSent", { requestId: "c2", timestamp: 2, type: "Fetch", request: { url: "https://a.test/dead", method: "GET", headers: {} } });
    h.emit("Network.loadingFailed", { requestId: "c2", timestamp: 2.1, errorText: "net::ERR_CONNECTION_REFUSED" });
    const list = h.tab.networkRing.list() as any[];
    expect(list[0]).toMatchObject({ url: "https://a.test/c.png", errorText: "net::ERR_ABORTED" });
    expect(list[0].failed).toBe(false);
    expect(list[1]).toMatchObject({ url: "https://a.test/dead", failed: true });
  });

  it("clearNetwork：清环与详情；之后新条目的 id 继续递增，不回绕", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.request("a");
    h.request("b");
    h.tab.clearNetwork();
    expect(h.tab.networkRing.size()).toBe(0);
    expect(h.tab.netDetails.size()).toBe(0);
    expect(h.tab.getNetworkEntry(1)).toBeNull();
    h.request("c");
    expect(h.tab.networkRing.list().map((e: any) => e.id)).toEqual([3]);
  });

  it("data: / blob: 请求不记录、不占 id", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.request("d", { url: "data:text/plain,hi" });
    h.request("e", { url: "blob:https://a.test/xyz" });
    h.request("f");
    expect(h.tab.networkRing.list().map((e: any) => e.id)).toEqual([1]);
  });
});

describe("BrowserTab：取响应体 / 请求体", () => {
  it("fetchNetworkResponseBody 用 requestId + sessionId 调 Network.getResponseBody", async () => {
    const h = makeTab({ "Network.getResponseBody": () => ({ body: '{"hello":1}', base64Encoded: false }) });
    await h.tab.ready;
    h.request("rid-1", { sessionId: "child-9" });
    const r = await h.tab.fetchNetworkResponseBody(1);
    expect(r).toEqual({ ok: true, body: '{"hello":1}', base64Encoded: false });
    const call = h.sent.find((s) => s.method === "Network.getResponseBody");
    expect(call?.params).toEqual({ requestId: "rid-1" });
    expect(call?.sessionId).toBe("child-9");
  });

  it("body 已被回收 / CDP 报错：不抛，返回 { ok:false, reason }；详情被淘汰也一样", async () => {
    const h = makeTab({
      "Network.getResponseBody": () => {
        throw new Error("No resource with given identifier found");
      },
    });
    await h.tab.ready;
    h.request("rid-1");
    const r = await h.tab.fetchNetworkResponseBody(1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/回收|无法读取/);
    const missing = await h.tab.fetchNetworkResponseBody(999);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/淘汰/);
  });

  it("fetchNetworkPostData：暂存里已有就不再问 CDP；只有 hasPostData 但没带全时补取", async () => {
    const h = makeTab({ "Network.getRequestPostData": () => ({ postData: "补取的请求体" }) });
    await h.tab.ready;
    h.request("has", { method: "POST", postData: "已有" });
    expect(await h.tab.fetchNetworkPostData(1)).toBeUndefined();
    expect(h.sent.some((s) => s.method === "Network.getRequestPostData")).toBe(false);

    // 模拟 requestWillBeSent 只给了 hasPostData:true、没给 postData
    h.emit("Network.requestWillBeSent", {
      requestId: "late",
      timestamp: 5,
      type: "Fetch",
      request: { url: "https://a.test/late", method: "POST", headers: {}, hasPostData: true },
    });
    h.emit("Network.loadingFinished", { requestId: "late", timestamp: 5.1 });
    expect(await h.tab.fetchNetworkPostData(2)).toBe("补取的请求体");
    // GET 没有请求体：不问
    h.request("get");
    expect(await h.tab.fetchNetworkPostData(3)).toBeUndefined();
  });
});

// ───────────────────────── 资源计时补录（CDP 事件投递竞态的兜底） ─────────────────────────

describe("net-detail：resourceTypeOf（Resource Timing 的 initiatorType → CDP 资源类型）", () => {
  it("明确的 initiatorType 直接映射", () => {
    expect(resourceTypeOf("img", "https://a.test/x")).toBe("Image");
    expect(resourceTypeOf("script", "https://a.test/x")).toBe("Script");
    expect(resourceTypeOf("fetch", "https://a.test/x")).toBe("Fetch");
    expect(resourceTypeOf("xmlhttprequest", "https://a.test/x")).toBe("XHR");
    expect(resourceTypeOf("iframe", "https://a.test/x")).toBe("Document");
    expect(resourceTypeOf("beacon", "https://a.test/x")).toBe("Ping");
    expect(resourceTypeOf("VIDEO", "https://a.test/x")).toBe("Media");
  });

  it("link / css / other 太笼统：按扩展名推断（字体和背景图的发起者也是 css），推断不出记 Other", () => {
    expect(resourceTypeOf("link", "https://a.test/s.css?v=3")).toBe("Stylesheet");
    expect(resourceTypeOf("css", "https://a.test/f.woff2")).toBe("Font");
    expect(resourceTypeOf("css", "https://a.test/bg.PNG")).toBe("Image");
    expect(resourceTypeOf("other", "https://a.test/m.js")).toBe("Script");
    expect(resourceTypeOf("other", "https://a.test/data")).toBe("Other");
    expect(resourceTypeOf("link", "not a url")).toBe("Other");
  });
});

describe("net-detail：missedResourceEntries（挑出 CDP 没记到的资源）", () => {
  const row = (u: string, t: number, o: Partial<{ i: string; s: number; d: number }> = {}) => ({ u, i: o.i ?? "img", s: o.s ?? 200, t, d: o.d ?? 5 });
  const ORIGIN = 1000;

  it("环里没有的才补；类型 / 状态 / 耗时取自计时；状态 0（跨域不透出）记 null；按开始时间升序", () => {
    const out = missedResourceEntries({
      rows: [row("https://a.test/b.png", 1020, { s: 0, d: 3 }), row("https://a.test/a.css", 1010, { i: "link", s: 404, d: 7 })],
      origin: ORIGIN,
      existing: [],
      seen: new Set(),
    });
    expect(out).toEqual([
      { ts: 1010, method: "GET", url: "https://a.test/a.css", status: 404, type: "Stylesheet", durationMs: 7 },
      { ts: 1020, method: "GET", url: "https://a.test/b.png", status: null, type: "Image", durationMs: 3 },
    ]);
  });

  it("环里已有同 URL（当前文档内）就跳过；之前文档里的同 URL 不算数", () => {
    const rows = [row("https://a.test/a.js", 1010, { i: "script" })];
    const have = missedResourceEntries({ rows, origin: ORIGIN, existing: [{ url: "https://a.test/a.js", ts: 1011 }], seen: new Set() });
    expect(have).toEqual([]);
    const oldDoc = missedResourceEntries({ rows, origin: ORIGIN, existing: [{ url: "https://a.test/a.js", ts: 500 }], seen: new Set() });
    expect(oldDoc).toHaveLength(1);
  });

  it("同 URL 请求了多次：环里有几条就当作已记过几条，只补多出来的（漏记的取最早的——代理启用晚丢的就是最早发出的）", () => {
    const rows = [row("https://a.test/p", 1010, { i: "fetch" }), row("https://a.test/p", 1020, { i: "fetch" }), row("https://a.test/p", 1030, { i: "fetch" })];
    const out = missedResourceEntries({ rows, origin: ORIGIN, existing: [{ url: "https://a.test/p", ts: 1010 }], seen: new Set() });
    expect(out.map((e) => e.ts)).toEqual([1010, 1020]);
  });

  it("seen 去重：同一批行再调一次不重复补；环淘汰后（existing 变空）也不把旧的重新补回来", () => {
    const seen = new Set<string>();
    const rows = [row("https://a.test/a.png", 1010)];
    expect(missedResourceEntries({ rows, origin: ORIGIN, existing: [], seen })).toHaveLength(1);
    expect(missedResourceEntries({ rows, origin: ORIGIN, existing: [], seen })).toHaveLength(0);
  });

  it("since：clear 之前开始的不补；只认 http(s)（data: / blob: / chrome-extension: 之类不要）；脏数据不抛", () => {
    const out = missedResourceEntries({
      rows: [
        row("https://a.test/old.png", 1005),
        row("https://a.test/new.png", 1500),
        row("data:image/png;base64,AAAA", 1600),
        row("blob:https://a.test/x", 1600),
        row("chrome-extension://abc/x.js", 1600),
        null as never,
        { u: 5 as never, i: "", s: 0, t: 1600, d: 0 },
      ],
      origin: ORIGIN,
      existing: [],
      since: 1100,
      seen: new Set(),
    });
    expect(out.map((e) => e.url)).toEqual(["https://a.test/new.png"]);
    expect(missedResourceEntries({ rows: undefined as never, origin: ORIGIN, existing: [], seen: new Set() })).toEqual([]);
  });

  it("seen 有上限，超出时丢最旧的（不无限涨）", () => {
    const seen = new Set<string>();
    const rows = Array.from({ length: 30 }, (_, i) => row(`https://a.test/${i}.png`, 1010 + i));
    missedResourceEntries({ rows, origin: ORIGIN, existing: [], seen, seenMax: 10 });
    expect(seen.size).toBe(10);
  });
});

describe("BrowserTab：主会话 sessionId 归一化 + 资源计时补录", () => {
  const worldCtx = (id: number) => ({ context: { id, name: "flowship", auxData: { frameId: "F1" } } });
  // 初始化时 createIsolatedWorld 先写一次 main:F1（context 1）；之后页面导航产生的新 context 由事件覆盖同一个键
  const base = { "Page.createIsolatedWorld": () => ({ executionContextId: 1 }) };
  const timingHandler = (rows: unknown[], origin = 1000) => ({ ...base, "Runtime.evaluate": () => ({ result: { value: { origin, rows } } }) });

  it("真 Electron 给主会话的 sessionId 是空串：事件必须落在 main: 键上（不能分裂出 `:` 键），frameNavigated 更新 mainFrameId，contextsCleared 清得掉", async () => {
    const h = makeTab(base);
    await h.tab.ready;
    expect(h.tab.isoContexts.get("main:F1")).toBe(1);
    h.emit("Runtime.executionContextCreated", worldCtx(7), "");
    expect([...h.tab.isoContexts.keys()]).toEqual(["main:F1"]); // 修复前这里会多出一个 ":F1"，旧的 main:F1 永远过期
    expect(h.tab.isoContexts.get("main:F1")).toBe(7);

    h.emit("Page.frameNavigated", { frame: { id: "F2", url: "https://a.test/" } }, "");
    expect(h.tab.mainFrameId).toBe("F2");

    h.emit("Runtime.executionContextsCleared", {}, "");
    expect(h.tab.isoContexts.size).toBe(0);
  });

  it("子会话（OOPIF）不受影响：带真 sessionId 的事件仍按子会话键存放，不会被当成主会话", async () => {
    const h = makeTab(base);
    await h.tab.ready;
    h.emit("Runtime.executionContextCreated", { context: { id: 9, name: "flowship", auxData: { frameId: "C1" } } }, "child-sess");
    expect([...h.tab.isoContexts.keys()].sort()).toEqual(["child-sess:C1", "main:F1"]);
    h.emit("Page.frameNavigated", { frame: { id: "FX", url: "https://a.test/" } }, "child-sess");
    expect(h.tab.mainFrameId).toBe("F1"); // 子会话的 frameNavigated 不改主 frame
  });

  it("补录：把环里没有的子资源补进来（带 id / 详情暂存标 timingOnly），再调一次不重复", async () => {
    const h = makeTab(timingHandler([
      { u: "https://a.test/s.css", i: "link", s: 200, t: 1010, d: 4 },
      { u: "https://a.test/i.png", i: "img", s: 404, t: 1011, d: 2 },
    ]));
    await h.tab.ready;
    h.emit("Runtime.executionContextCreated", worldCtx(7), "");
    expect(await h.tab.backfillResourceTiming()).toBe(2);
    const list = h.tab.networkRing.list() as any[];
    expect(list.map((e) => [e.id, e.type, e.status, !!e.failed])).toEqual([
      [1, "Stylesheet", 200, false],
      [2, "Image", 404, true],
    ]);
    expect(h.tab.getNetworkEntry(1)!.detail).toMatchObject({ timingOnly: true, requestId: null, requestHeaders: {}, responseHeaders: {} });
    // 求值走的是隔离世界 context（contextId=7），不是页面主世界
    const ev = h.sent.filter((s) => s.method === "Runtime.evaluate").at(-1)!; // 前面还有初始化时注入录制脚本的那次
    expect(ev.params.contextId).toBe(7);
    expect(String(ev.params.expression)).toContain("getEntriesByType");
    expect(await h.tab.backfillResourceTiming()).toBe(0);
    expect(h.tab.networkRing.size()).toBe(2);
  });

  it("CDP 已经记到的不重复补（同 URL）", async () => {
    const h = makeTab(timingHandler([{ u: "https://a.test/api", i: "fetch", s: 200, t: 1010, d: 4 }]));
    await h.tab.ready;
    h.emit("Runtime.executionContextCreated", worldCtx(7), "");
    h.request("r1", { url: "https://a.test/api" }); // ts = this.now() = 当前真实时间 ≥ origin
    expect(await h.tab.backfillResourceTiming()).toBe(0);
    expect(h.tab.networkRing.size()).toBe(1);
  });

  it("clear 之后：clear 前开始的资源不会又被补回来", async () => {
    const t0 = Date.now();
    const h = makeTab(timingHandler([{ u: "https://a.test/old.png", i: "img", s: 200, t: t0 - 5000, d: 4 }], t0 - 6000));
    await h.tab.ready;
    h.emit("Runtime.executionContextCreated", worldCtx(7), "");
    expect(await h.tab.backfillResourceTiming()).toBe(1);
    h.tab.clearNetwork();
    expect(h.tab.networkRing.size()).toBe(0);
    expect(await h.tab.backfillResourceTiming()).toBe(0);
    expect(h.tab.networkRing.size()).toBe(0);
  });

  it("补录条目取响应体：给出「来自资源计时」的明确原因，不是误报「已被淘汰」，也不发 CDP", async () => {
    const h = makeTab(timingHandler([{ u: "https://a.test/s.css", i: "link", s: 200, t: 1010, d: 4 }]));
    await h.tab.ready;
    h.emit("Runtime.executionContextCreated", worldCtx(7), "");
    await h.tab.backfillResourceTiming();
    const r = await h.tab.fetchNetworkResponseBody(1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/资源计时/);
    expect(h.sent.some((s) => s.method === "Network.getResponseBody")).toBe(false);
  });

  it("补录是锦上添花：没有隔离世界 / 求值抛错 / 返回值不对，一律返回 0 且不抛", async () => {
    const none = makeTab(); // fake 的 createIsolatedWorld 没返回 context id → 没有可用的隔离世界
    await none.tab.ready;
    none.tab.isoContexts.clear();
    expect(await none.tab.backfillResourceTiming()).toBe(0);

    const boom = makeTab({
      ...base,
      "Runtime.evaluate": () => {
        throw new Error("Cannot find context with specified id");
      },
    });
    await boom.tab.ready;
    boom.emit("Runtime.executionContextCreated", worldCtx(7), "");
    expect(await boom.tab.backfillResourceTiming()).toBe(0);

    const bad = makeTab({ ...base, "Runtime.evaluate": () => ({ result: { value: "oops" } }) });
    await bad.tab.ready;
    bad.emit("Runtime.executionContextCreated", worldCtx(7), "");
    expect(await bad.tab.backfillResourceTiming()).toBe(0);
    expect(bad.tab.networkRing.size()).toBe(0);
  });
});
