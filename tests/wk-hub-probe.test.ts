/**
 * Delivery Hub 可达性探测
 *
 * 探针端点取自官方 `wk-delivery-baseline.py:get_artifact_state`
 * （`GET /internal/harness/artifact-state?artifactKey=...`、无鉴权、无副作用）——
 * harness 没有健康检查端点，这是唯一能同时验证「网络通」和「对面确实是 hub」的接口。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { probeWkHub } from "@/lib/server/wk-hub-probe";
import {
  hubProbeUrl,
  isArtifactStateShape,
  normalizeHubUrl,
} from "@/lib/wk-hub";

/** 造一个假 fetch，省得真发请求 */
const fakeFetch = (
  impl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch =>
  impl as unknown as typeof fetch;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("normalizeHubUrl", () => {
  it("http / https 正常，末尾斜杠去掉（官方一律 rstrip('/') 后拼路径）", () => {
    expect(normalizeHubUrl("http://127.0.0.1:8088")).toBe("http://127.0.0.1:8088");
    expect(normalizeHubUrl("  http://127.0.0.1:8088/  ")).toBe(
      "http://127.0.0.1:8088",
    );
    expect(normalizeHubUrl("https://hub.corp")).toBe("https://hub.corp");
  });

  it("保留路径前缀（官方允许 base_url 带前缀）", () => {
    expect(normalizeHubUrl("http://hub.corp/harness/")).toBe(
      "http://hub.corp/harness",
    );
  });

  it("空 / 非 http 协议 / 乱填 → null", () => {
    expect(normalizeHubUrl("")).toBeNull();
    expect(normalizeHubUrl("   ")).toBeNull();
    expect(normalizeHubUrl("127.0.0.1:8088")).toBeNull();
    expect(normalizeHubUrl("ftp://hub.corp")).toBeNull();
    expect(normalizeHubUrl("file:///tmp/x")).toBeNull();
  });
});

describe("hubProbeUrl / isArtifactStateShape", () => {
  it("探针 URL 指向官方 artifact-state 端点", () => {
    expect(hubProbeUrl("http://127.0.0.1:8088")).toBe(
      "http://127.0.0.1:8088/internal/harness/artifact-state?artifactKey=flowship%3Aprobe%3Aconnectivity",
    );
  });

  it("认「顶层 exists」或「data 对象」两种官方读法", () => {
    expect(isArtifactStateShape({ exists: false })).toBe(true);
    expect(isArtifactStateShape({ data: { exists: false } })).toBe(true);
    expect(isArtifactStateShape({ hello: "world" })).toBe(false);
    expect(isArtifactStateShape([])).toBe(false);
    expect(isArtifactStateShape(null)).toBe(false);
    expect(isArtifactStateShape("ok")).toBe(false);
  });
});

describe("probeWkHub", () => {
  it("地址格式不对 → invalid-url，不发请求", async () => {
    let called = false;
    const res = await probeWkHub(
      "127.0.0.1:8088",
      fakeFetch(async () => {
        called = true;
        return jsonResponse({});
      }),
    );
    expect(res.status).toBe("invalid-url");
    expect(called).toBe(false);
  });

  it("hub 回 artifact-state → ok", async () => {
    const res = await probeWkHub(
      "http://127.0.0.1:8088/",
      fakeFetch(async () => jsonResponse({ data: { exists: false } })),
    );
    expect(res.status).toBe("ok");
  });

  it("带 Token 时使用 Authorization Bearer，且不会进入返回结果", async () => {
    let authorization = "";
    const res = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return jsonResponse({ data: { exists: false } });
      }),
      "wkdh_test-secret",
    );
    expect(authorization).toBe("Bearer wkdh_test-secret");
    expect(JSON.stringify(res)).not.toContain("wkdh_test-secret");
  });

  it("401 / 403 明确提示 Token 问题", async () => {
    const unauthorized = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => jsonResponse({}, 401)),
      "bad-token",
    );
    expect(unauthorized.message).toContain("Token");

    const forbidden = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => jsonResponse({}, 403)),
      "bad-token",
    );
    expect(forbidden.message).toContain("Token");
  });

  it("HTTP 404 → unexpected（端口上有服务但不是 harness 接口）", async () => {
    const res = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => jsonResponse({ error: "not found" }, 404)),
    );
    expect(res.status).toBe("unexpected");
    expect(res.message).toContain("404");
  });

  it("回的不是 JSON → unexpected", async () => {
    const res = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => new Response("<html>hi</html>", { status: 200 })),
    );
    expect(res.status).toBe("unexpected");
  });

  it("JSON 但不是 artifact-state 形状 → unexpected", async () => {
    const res = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => jsonResponse({ hello: "world" })),
    );
    expect(res.status).toBe("unexpected");
  });

  it("连接被拒 → unreachable，报底层 code", async () => {
    const res = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      }),
    );
    expect(res.status).toBe("unreachable");
    expect(res.message).toContain("拒绝");
  });

  it("超时 → unreachable", async () => {
    const res = await probeWkHub(
      "http://127.0.0.1:8088",
      fakeFetch(async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      }),
    );
    expect(res.status).toBe("unreachable");
    expect(res.message).toContain("超时");
  });
});

/**
 * 走真 fetch 的一轮（假 hub 起在临时端口）：注入版测不到「真实拼 URL + 真实读响应」，
 * 这里补上——顺便锁死我们查的确实是官方那个 artifact-state 路径。
 */
describe("probeWkHub（真实 HTTP）", () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  /** 起一个假 hub，返回 base_url 和它收到的请求路径 */
  const startFakeHub = async (
    handler: (url: string) => { status: number; body: string },
  ): Promise<{ baseUrl: string; hits: string[] }> => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, hits };
  };

  it("假 hub 按官方 artifact-state 回包 → ok，且请求打在官方路径上", async () => {
    const { baseUrl, hits } = await startFakeHub(() => ({
      status: 200,
      body: JSON.stringify({ data: { exists: false, versions: [] } }),
    }));
    const res = await probeWkHub(baseUrl);
    expect(res.status).toBe("ok");
    expect(hits[0]).toContain("/internal/harness/artifact-state?artifactKey=");
  });

  it("端口上是别的服务（404） → unexpected", async () => {
    const { baseUrl } = await startFakeHub(() => ({
      status: 404,
      body: JSON.stringify({ error: "Not Found" }),
    }));
    expect((await probeWkHub(baseUrl)).status).toBe("unexpected");
  });

  it("没人监听的端口 → unreachable", async () => {
    // 先起再关，拿一个确定没人占的端口
    const { baseUrl } = await startFakeHub(() => ({ status: 200, body: "{}" }));
    await new Promise<void>((resolve) => {
      servers.pop()!.close(() => resolve());
    });
    expect((await probeWkHub(baseUrl)).status).toBe("unreachable");
  });
});
