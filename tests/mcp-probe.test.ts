/**
 * MCP 连通性探测（src/lib/server/mcp-probe.ts）单测
 *
 * 为什么值得钉：探测判错是**静默失败**——MCP 被 filterHealthyMcp 剔掉、agent 少一堆工具、
 * 用户只看到「AI 好像不会用那个工具了」。分支又多（POST / GET 两条探法 + 404/405 兜底），
 * 尤其「显式 type: 'http' 不兜底 GET」是有意设计（见实现注释），被顺手改成「也兜底」很隐蔽。
 *
 * 探测函数直接调 global fetch（不像 wk-hub-probe 支持注入），故主体用 vi.stubGlobal 桩掉；
 * 末尾照 tests/wk-hub-probe.test.ts 的做法补一轮真 fetch（临时端口起假 server）——
 * 桩版测不到「真实发 GET/POST + 真实 undici 报错」这一段。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { McpServerConfig } from "@cursor/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterHealthyMcp,
  invalidateMcpProbeCache,
  probeMcpHealthAll,
  withInferredTransport,
} from "@/lib/server/mcp-probe";
import type { McpHealth } from "@/lib/types";

/** fetch 收到的一次调用——断言「发了几次、什么方法」全靠它 */
type FakeCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

/**
 * 桩掉全局 fetch，省得真发请求。handler 按调用序号决定回什么；
 * handler 里 throw = 「连不上」（undici 的失败形态由调用方自己造）。
 */
const stubFetch = (handler: (call: FakeCall, index: number) => Response): FakeCall[] => {
  const calls: FakeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: FakeCall = {
        method: init?.method ?? "GET",
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return handler(call, calls.length - 1);
    }),
  );
  return calls;
};

const statusResponse = (status: number): Response => new Response(null, { status });

/** undici 连不上时的形态：message 恒为 fetch failed、真因在 cause */
const fetchFailed = (causeMessage: string, code?: string): Error =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(causeMessage), code ? { code } : {}),
  });

/** 探一个 server 拿 health（probeMcpHealthAll 真探不读缓存、适合钉探测行为） */
const probeOne = async (cfg: McpServerConfig, name = "srv"): Promise<McpHealth> =>
  (await probeMcpHealthAll({ [name]: cfg }))[name];

beforeEach(() => {
  // 缓存挂在 globalThis 上、用例之间会串味
  invalidateMcpProbeCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transport 判定：用哪种方法探", () => {
  it("显式 type: sse → 只发一次 GET（POST 过去必吃 404、白付一轮超时）", async () => {
    const calls = stubFetch(() => statusResponse(200));
    const health = await probeOne({ type: "sse", url: "http://mcp.test/anything" });
    expect(health.status).toBe("ok");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0].headers.accept).toContain("text/event-stream");
  });

  it("显式 type: http + 404 → 只发一次 POST、不兜底 GET（哪怕端点名是 /sse）", async () => {
    // 有意设计：Streamable HTTP 的承诺下 404 就是真坏了。若兜底 GET 探出 ok、
    // SDK 仍按 Streamable HTTP 连不上 —— 等于放行一个死的。
    const calls = stubFetch(() => statusResponse(404));
    const health = await probeOne({ type: "http", url: "http://mcp.test/sse" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(health.status).toBe("fail");
    expect(health.detail).toContain("服务异常 HTTP 404");
  });

  it("无 type + url 以 /sse 结尾 → 直接走 GET（尾部斜杠不算数）", async () => {
    for (const url of ["http://mcp.test/sse", "http://mcp.test/sse/"]) {
      const calls = stubFetch(() => statusResponse(200));
      expect((await probeOne({ url })).status).toBe("ok");
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
      vi.unstubAllGlobals();
    }
  });

  it("无 type + 普通端点名 → 先 POST 发 initialize", async () => {
    const calls = stubFetch(() => statusResponse(200));
    await probeOne({ url: "http://mcp.test/mcp" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ method: "initialize" });
  });

  it("无 type + POST 吃 404/405 → 再 GET 兜一次（老式 SSE server 的入口是 GET）", async () => {
    for (const postCode of [404, 405]) {
      const calls = stubFetch((call) =>
        statusResponse(call.method === "POST" ? postCode : 200),
      );
      const health = await probeOne({ url: "http://mcp.test/mcp" });
      expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
      expect(health.status).toBe("ok");
      vi.unstubAllGlobals();
    }
  });

  it("无 type + POST 吃 500 → 不兜底（只有 404/405 才可能是认错了 transport）", async () => {
    const calls = stubFetch(() => statusResponse(500));
    const health = await probeOne({ url: "http://mcp.test/mcp" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(health.detail).toContain("服务异常 HTTP 500");
  });

  it("兜底的 GET 也连不上 → 报 POST 的原始症状、别拿兜底的错遮住", async () => {
    stubFetch((call) => {
      if (call.method === "POST") return statusResponse(404);
      throw fetchFailed("connect ECONNREFUSED 127.0.0.1:8765", "ECONNREFUSED");
    });
    const health = await probeOne({ url: "http://mcp.test/mcp" });
    expect(health.httpCode).toBe(404);
    expect(health.detail).toContain("服务异常 HTTP 404");
    expect(health.detail).not.toContain("连接失败");
  });

  it("stdio（无 url）→ 乐观标 ok、一个请求都不发", async () => {
    const calls = stubFetch(() => statusResponse(500));
    const health = await probeOne({ command: "npx", args: ["-y", "some-mcp"] });
    expect(health.status).toBe("ok");
    expect(calls).toHaveLength(0);
  });
});

describe("withInferredTransport：注入给 SDK 前补 type", () => {
  it("用户显式写了 type → 原样返回、不替用户改主意", () => {
    // 写了 http 却指向 /sse 也照原样——尊重用户，别偷偷改成 sse
    const http: McpServerConfig = { type: "http", url: "http://mcp.test/sse" };
    const sse: McpServerConfig = { type: "sse", url: "http://mcp.test/mcp" };
    expect(withInferredTransport(http)).toBe(http);
    expect(withInferredTransport(sse)).toBe(sse);
  });

  it("无 type + /sse 端点 → 补 type: sse（否则 SDK 按 Streamable HTTP 连不上）", () => {
    expect(withInferredTransport({ url: "http://mcp.test/sse" })).toEqual({
      url: "http://mcp.test/sse",
      type: "sse",
    });
    expect(withInferredTransport({ url: "http://mcp.test/sse/" })).toMatchObject({
      type: "sse",
    });
    // 其余字段原样带过去、别在补 type 时丢了 headers
    expect(
      withInferredTransport({
        url: "http://mcp.test/sse",
        headers: { authorization: "Bearer x" },
      }),
    ).toEqual({
      url: "http://mcp.test/sse",
      headers: { authorization: "Bearer x" },
      type: "sse",
    });
  });

  it("无 type + 普通 url → 不补（交给 SDK 默认的 Streamable HTTP）", () => {
    const cfg: McpServerConfig = { url: "http://mcp.test/mcp" };
    expect(withInferredTransport(cfg)).toBe(cfg);
    // /ssefoo、/sse 在中间等等都不算 SSE 端点
    expect(withInferredTransport({ url: "http://mcp.test/ssefoo" })).not.toMatchObject({
      type: "sse",
    });
    expect(withInferredTransport({ url: "http://mcp.test/sse/rpc" })).not.toMatchObject({
      type: "sse",
    });
  });

  it("stdio（无 url）/ url 乱填 → 原样返回、不炸", () => {
    const stdio: McpServerConfig = { command: "node", args: ["srv.js"] };
    expect(withInferredTransport(stdio)).toBe(stdio);
    const broken: McpServerConfig = { url: "不是个 url/sse" };
    expect(withInferredTransport(broken)).toBe(broken);
  });
});

describe("状态分级", () => {
  it("GET 401 → 需要授权（内网 wk-knowledge 的形态：GET 401 / POST 404）", async () => {
    // 这条判成「服务异常」用户就不知道该去授权——两者的行动指引完全不同
    const calls = stubFetch(() => statusResponse(401));
    const health = await probeOne({ url: "http://127.0.0.1:8765/sse" }, "wk-knowledge");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(health.status).toBe("fail");
    expect(health.httpCode).toBe(401);
    expect(health.detail).toContain("需要授权");
    expect(health.detail).toContain("wk-knowledge");
    expect(health.detail).not.toContain("服务异常");
    expect(health.detail).toContain("http://127.0.0.1:8765/sse");
  });

  it("403 → 同样是需要授权", async () => {
    stubFetch(() => statusResponse(403));
    const health = await probeOne({ type: "http", url: "http://mcp.test/mcp" });
    expect(health.status).toBe("fail");
    expect(health.detail).toContain("需要授权");
  });

  it("2xx → ok，httpCode 带回去", async () => {
    for (const code of [200, 202, 204]) {
      stubFetch(() => statusResponse(code));
      const health = await probeOne({ type: "http", url: "http://mcp.test/mcp" });
      expect(health).toMatchObject({ status: "ok", httpCode: code });
      vi.unstubAllGlobals();
    }
  });

  it("其它非 2xx（404 / 405 / 500）→ 服务异常，不是「需要授权」", async () => {
    for (const code of [404, 405, 500]) {
      stubFetch(() => statusResponse(code));
      const health = await probeOne({ type: "http", url: "http://mcp.test/mcp" });
      expect(health).toMatchObject({ status: "fail", httpCode: code });
      expect(health.detail).toContain(`服务异常 HTTP ${code}`);
      expect(health.detail).not.toContain("需要授权");
      vi.unstubAllGlobals();
    }
  });

  it("连不上 → 失败、detail 带 URL（点开日志能直接排查）", async () => {
    stubFetch(() => {
      throw fetchFailed("connect ECONNREFUSED 127.0.0.1:8765", "ECONNREFUSED");
    });
    const health = await probeOne({ type: "http", url: "http://127.0.0.1:8765/mcp" });
    expect(health.status).toBe("fail");
    expect(health.httpCode).toBeUndefined();
    expect(health.detail).toContain("连接失败");
    expect(health.detail).toContain("http://127.0.0.1:8765/mcp");
  });
});

describe("失败原因摊开 cause", () => {
  // undici 的 fetch 失败 message 恒为 "fetch failed"、真因藏在 cause 里——
  // 不摊开的话用户点开日志看到的等于没说
  it("cause 的 message 里已带 code → 直接用，不拼成「ECONNREFUSED connect ECONNREFUSED …」", async () => {
    stubFetch(() => {
      throw fetchFailed("connect ECONNREFUSED 127.0.0.1:8765", "ECONNREFUSED");
    });
    const health = await probeOne({ type: "http", url: "http://127.0.0.1:8765/mcp" });
    expect(health.detail).toContain("ECONNREFUSED");
    expect(health.detail).not.toContain("ECONNREFUSED connect ECONNREFUSED");
  });

  it("cause 的 message 里没带 code → 前缀补上 code", async () => {
    stubFetch(() => {
      throw fetchFailed("getaddrinfo failed", "ENOTFOUND");
    });
    const health = await probeOne({ type: "http", url: "http://no-such-host/mcp" });
    expect(health.detail).toContain("ENOTFOUND getaddrinfo failed");
  });

  it("没有 cause（如超时 abort）→ 退回 message 本身", async () => {
    stubFetch(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const health = await probeOne({ type: "http", url: "http://mcp.test/mcp" });
    expect(health.detail).toContain("The operation was aborted due to timeout");
  });
});

describe("filterHealthyMcp：放行 / 剔除 / 缓存", () => {
  beforeEach(() => {
    // filterHealthyMcp 会打一行缓存命中率日志、测试输出里是噪音
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("放行时补上推导出的 transport（探测放行还不够、SDK 得连得上）", async () => {
    stubFetch(() => statusResponse(200));
    const { servers, dropped } = await filterHealthyMcp({
      legacy: { url: "http://mcp.test/sse" },
      local: { command: "node", args: ["srv.js"] },
    });
    expect(dropped).toEqual([]);
    expect(servers.legacy).toMatchObject({ type: "sse" });
    // stdio 原样带过去
    expect(servers.local).toMatchObject({ command: "node" });
  });

  it("探失败的被剔除、health 落到 dropped 给调用方写提示", async () => {
    stubFetch((call) => statusResponse(call.url.includes("bad") ? 401 : 200));
    const { servers, dropped } = await filterHealthyMcp({
      good: { type: "http", url: "http://mcp.test/mcp" },
      bad: { type: "http", url: "http://mcp.test/bad" },
    });
    expect(Object.keys(servers)).toEqual(["good"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ name: "bad", status: "fail", httpCode: 401 });
  });

  it("同一份配置重复调 → 命中缓存不重探", async () => {
    const calls = stubFetch(() => statusResponse(200));
    const cfg: Record<string, McpServerConfig> = {
      srv: { url: "http://mcp.test/sse" },
    };
    await filterHealthyMcp(cfg);
    await filterHealthyMcp(cfg);
    expect(calls).toHaveLength(1);
  });

  it("改了 type → 缓存失效重探（否则改了 transport 还吃旧结论）", async () => {
    const calls = stubFetch(() => statusResponse(200));
    await filterHealthyMcp({ srv: { url: "http://mcp.test/sse" } });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    await filterHealthyMcp({ srv: { type: "http", url: "http://mcp.test/sse" } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("换了 headers（OAuth token 刷新）/ 换了名字 → 同样重探", async () => {
    const calls = stubFetch(() => statusResponse(200));
    await filterHealthyMcp({ srv: { type: "http", url: "http://mcp.test/mcp" } });
    await filterHealthyMcp({
      srv: { type: "http", url: "http://mcp.test/mcp", headers: { authorization: "Bearer new" } },
    });
    await filterHealthyMcp({ other: { type: "http", url: "http://mcp.test/mcp" } });
    expect(calls).toHaveLength(3);
  });

  it("invalidateMcpProbeCache 后必真探（run 失败时清缓存、重试不吃过期 ok）", async () => {
    const calls = stubFetch(() => statusResponse(200));
    const cfg: Record<string, McpServerConfig> = {
      srv: { type: "http", url: "http://mcp.test/mcp" },
    };
    await filterHealthyMcp(cfg);
    invalidateMcpProbeCache();
    await filterHealthyMcp(cfg);
    expect(calls).toHaveLength(2);
  });
});

describe("已知边界（记录，不是期望行为）", () => {
  /**
   * 没写 type、端点名又恰好叫 /sse 的 Streamable HTTP server 会被当成 SSE：
   * 探测走 GET、withInferredTransport 还会把错的 type 固化给 SDK。
   * 现实里很罕见（/sse 是 SSE 约定俗成的端点名），且配上 type: "http" 就能规避——
   * 留这条用例把「边界存在 + 逃生口有效」写在案上；哪天真去修了，这里会红、顺手更新即可。
   */
  it("无 type 的 Streamable HTTP server 用了 /sse 端点名 → 误判成 SSE；写 type: http 可规避", async () => {
    const calls = stubFetch((call) =>
      // 假设这台其实是 Streamable HTTP：POST 才通、GET 建流不认
      statusResponse(call.method === "POST" ? 200 : 405),
    );
    const misjudged = await probeOne({ url: "http://mcp.test/sse" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(misjudged.status).toBe("fail");
    expect(withInferredTransport({ url: "http://mcp.test/sse" })).toMatchObject({
      type: "sse",
    });

    vi.unstubAllGlobals();
    const calls2 = stubFetch(() => statusResponse(200));
    const fixed = await probeOne({ type: "http", url: "http://mcp.test/sse" });
    expect(calls2.map((c) => c.method)).toEqual(["POST"]);
    expect(fixed.status).toBe("ok");
  });
});

/**
 * 走真 fetch 的一轮（假 MCP server 起在临时端口）：桩版测不到「真实发 GET/POST +
 * 真实读响应 + 真实 undici 报错」，这里补上——顺便用真链路复现 wk-knowledge 的形态。
 */
describe("mcp-probe（真实 HTTP）", () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  });

  /** 起一个假 MCP server（按方法/路径回状态码），返回 origin 和它收到的请求 */
  const startFakeMcp = async (
    handler: (hit: { method: string; path: string }) => number,
  ): Promise<{ origin: string; hits: { method: string; path: string }[] }> => {
    const hits: { method: string; path: string }[] = [];
    const server = createServer((req, res) => {
      const hit = { method: req.method ?? "", path: req.url ?? "" };
      hits.push(hit);
      // 探测拿到响应头就 abort（SSE 长连接不掐会一直占着）——连接被掐别让 server 抛出去
      req.on("error", () => {});
      res.on("error", () => {});
      res.writeHead(handler(hit), { "content-type": "application/json", connection: "close" });
      res.end("{}");
    });
    server.on("clientError", () => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, hits };
  };

  it("wk-knowledge 形态（/sse：GET 401、POST 404）→ 一次 GET 判出「需要授权」", async () => {
    const { origin, hits } = await startFakeMcp((hit) => (hit.method === "GET" ? 401 : 404));
    const health = await probeOne({ url: `${origin}/sse` }, "wk-knowledge");
    expect(hits).toEqual([{ method: "GET", path: "/sse" }]);
    expect(health).toMatchObject({ status: "fail", httpCode: 401 });
    expect(health.detail).toContain("需要授权");
  });

  it("老式 SSE server 但端点名不带 /sse → POST 吃 404 后 GET 兜底探出 ok", async () => {
    const { origin, hits } = await startFakeMcp((hit) => (hit.method === "POST" ? 404 : 200));
    const health = await probeOne({ url: `${origin}/stream` });
    expect(hits.map((h) => h.method)).toEqual(["POST", "GET"]);
    expect(health.status).toBe("ok");
  });

  it("Streamable HTTP server → 一次 POST（initialize）探出 ok", async () => {
    const { origin, hits } = await startFakeMcp(() => 200);
    const health = await probeOne({ url: `${origin}/mcp` });
    expect(hits).toEqual([{ method: "POST", path: "/mcp" }]);
    expect(health.status).toBe("ok");
  });

  it("没人监听的端口 → 真 undici 报错也能摊出 ECONNREFUSED", async () => {
    // 先起再关，拿一个确定没人占的端口
    const { origin } = await startFakeMcp(() => 200);
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => resolve());
    });
    const health = await probeOne({ url: `${origin}/mcp` });
    expect(health.status).toBe("fail");
    expect(health.detail).toContain("连接失败");
    expect(health.detail).toContain("ECONNREFUSED");
  });
});
