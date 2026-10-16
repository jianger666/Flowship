/**
 * POST /api/csp-report 的 route handler 行为测试：真调 handler（构造 Request），断言
 * - 204：合法报文（两种格式）/ 畸形 / 被限频，一律不让浏览器重试
 * - 413：声明的 Content-Length 超限、或实际读到的字节数超限
 * - 405：其它方法
 * - 日志：首次出现 `console.warn('[csp-report] ...')` 一行，且 query / token 不会进日志
 * 以及：该端点被全站 /api/** middleware 守门覆盖（没有比其它路由更宽松的口子）。
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as route from "../src/app/api/csp-report/route";
import { config as middlewareConfig, middleware } from "../src/middleware";
import {
  CSP_REPORT_RATE_MAX,
  MAX_CSP_REPORT_BODY_BYTES,
  defaultCspReportDeps,
} from "../src/lib/server/csp-report";

type Globals = { __feCspReportStore?: unknown; __feCspReportLimiter?: unknown };

/** store / 限频器挂在 globalThis 上（HMR 共享）：每个用例前清掉，保证互不影响 */
const resetGlobalState = (): void => {
  const g = globalThis as unknown as Globals;
  delete g.__feCspReportStore;
  delete g.__feCspReportLimiter;
};

const URL_ = "http://127.0.0.1:8876/api/csp-report";

const post = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
  new Request(URL_, { method: "POST", headers, body });

const legacyBody = (blocked = "https://evil.example.com/x.js?token=SECRET_TOKEN") =>
  JSON.stringify({
    "csp-report": {
      "document-uri": "http://127.0.0.1:8876/tasks/t_1?ticket=SECRET_TICKET",
      "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem",
      "blocked-uri": blocked,
      "line-number": 12,
    },
  });

const entries = () => defaultCspReportDeps().store.snapshot().entries;

// 模块级 spy：吞掉真实输出（避免测试日志里全是 [csp-report]），同时能断言日志内容
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  warn.mockClear();
  resetGlobalState();
});

afterEach(() => {
  resetGlobalState();
});

describe("POST /api/csp-report：204", () => {
  it("旧式 application/csp-report → 204，入库并 warn 一行，query 不进日志", async () => {
    const res = await route.POST(
      post(legacyBody(), { "content-type": "application/csp-report" }),
    );
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      directive: "script-src-elem",
      blockedKey: "https://evil.example.com",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line.startsWith("[csp-report]")).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("SECRET_TOKEN");
    expect(line).not.toContain("SECRET_TICKET");
  });

  it("application/reports+json（数组）→ 204 并入库", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          documentURL: "http://127.0.0.1:8876/settings",
          blockedURL: "inline",
          effectiveDirective: "script-src-elem",
        },
      },
    ]);
    const res = await route.POST(post(body, { "content-type": "application/reports+json" }));
    expect(res.status).toBe(204);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ blockedKey: "inline" });
  });

  it("同一违规重复上报：只首次 warn、计数累加", async () => {
    for (let i = 0; i < 5; i += 1) await route.POST(post(legacyBody()));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]?.count).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("畸形 JSON / 空体 / 非 CSP 报文 → 204，不入库、不 warn", async () => {
    for (const body of ["{oops", "", "[]", '{"foo":1}']) {
      const res = await route.POST(post(body));
      expect(res.status).toBe(204);
    }
    expect(entries()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("读请求体失败（连接被重置）→ 仍是 204，不抛 5xx", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    const req = new Request(URL_, {
      method: "POST",
      body: stream,
      // Node 的 fetch 规范：流式 body 必须声明 duplex
      duplex: "half",
    } as RequestInit);
    const res = await route.POST(req);
    expect(res.status).toBe(204);
  });

  it("限频：窗口内超过上限的请求静默 204、不再入库", async () => {
    for (let i = 0; i < CSP_REPORT_RATE_MAX + 20; i += 1) {
      const res = await route.POST(post(legacyBody()));
      expect(res.status).toBe(204);
    }
    // 只有前 CSP_REPORT_RATE_MAX 次被处理
    expect(entries()[0]?.count).toBe(CSP_REPORT_RATE_MAX);
  });
});

describe("POST /api/csp-report：413", () => {
  it("声明的 Content-Length 超过 16KB → 413，不入库", async () => {
    const res = await route.POST(
      post(legacyBody(), { "content-length": String(MAX_CSP_REPORT_BODY_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(entries()).toHaveLength(0);
  });

  it("没声明 Content-Length 但实际体积超过 16KB → 413，不入库", async () => {
    const padded = JSON.stringify({
      "csp-report": {
        "effective-directive": "img-src",
        "blocked-uri": "https://a.example.com/",
        junk: "x".repeat(MAX_CSP_REPORT_BODY_BYTES),
      },
    });
    const res = await route.POST(post(padded));
    expect(res.status).toBe(413);
    expect(entries()).toHaveLength(0);
  });

  it("恰好在上限内的报文正常处理", async () => {
    const base = JSON.stringify({
      "csp-report": { "effective-directive": "img-src", "blocked-uri": "https://a.example.com/", junk: "" },
    });
    const pad = "x".repeat(MAX_CSP_REPORT_BODY_BYTES - new TextEncoder().encode(base).length);
    const body = base.replace('"junk":""', `"junk":"${pad}"`);
    expect(new TextEncoder().encode(body).length).toBe(MAX_CSP_REPORT_BODY_BYTES);
    const res = await route.POST(post(body));
    expect(res.status).toBe(204);
    expect(entries()).toHaveLength(1);
  });
});

describe("非 POST 方法 → 405", () => {
  it.each(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "%s → 405 且 Allow: POST",
    async (method) => {
      const handler = route[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    },
  );

  it("非 POST 方法共用同一个 405 处理器（防止以后有人给 GET/PUT 加上处理逻辑）", () => {
    for (const m of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      expect(route[m]).toBe(route.GET);
    }
  });
});

describe("访问控制：沿用全站 /api/** middleware，没有更宽松的口子", () => {
  it("middleware 的 matcher 覆盖 /api/csp-report", () => {
    // matcher 是 "/api/:path*"：若被改窄（如只列部分路由），上报端点会失去 Host / Origin 守门
    expect(middlewareConfig.matcher).toBe("/api/:path*");
  });

  const mreq = (headers: Record<string, string>) =>
    new NextRequest(URL_, { method: "POST", headers });

  it("同源页面发来的违规报告（Origin = 页面自身）放行", () => {
    const res = middleware(
      mreq({ host: "127.0.0.1:8876", origin: "http://127.0.0.1:8876" }),
    );
    expect(res.status).toBe(200);
  });

  it("不带 Origin 的请求（顶层导航 / 不发 Origin 的上报实现）放行", () => {
    expect(middleware(mreq({ host: "127.0.0.1:8876" })).status).toBe(200);
  });

  it("跨 origin / 本机其它端口 / 非 loopback Host → 403", () => {
    expect(
      middleware(mreq({ host: "127.0.0.1:8876", origin: "http://evil.example.com" })).status,
    ).toBe(403);
    expect(
      middleware(mreq({ host: "127.0.0.1:8876", origin: "http://127.0.0.1:9999" })).status,
    ).toBe(403);
    expect(
      middleware(mreq({ host: "192.168.1.10:8876", origin: "http://192.168.1.10:8876" })).status,
    ).toBe(403);
  });
});
