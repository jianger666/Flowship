/**
 * R6-35（sourcemap 同 host 判断不比端口 + 文档「全局 fetch 无法钉 IP」不成立）。
 * 两件事：
 *  ① map 必须与脚本 / 页面「同 hostname 且有效端口全等」（loopback 例外也比端口）；受信条目写 `host:port` 才比端口，纯 `host` 兼容旧调用方；
 *  ② 生产路径（没注入 env.fetch）用 `createPinnedFetch`（node:http(s).request + 自定义 lookup）在连接时解析 + 校验 IP，DNS 复核与连接之间没有 rebinding 窗口。
 * 全部用假 fetch / 注入的 lookup / 本机 127.0.0.1 随机端口的 http.createServer，不依赖真实外网与真实 DNS。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { CrossHostMapError, assertMapHostSafe, createHandlers, createPinnedFetch, fetchMapText, mapHostAllowed } from "../electron-app/browser/ops/sources.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { checkUrl } from "../electron-app/browser/url-policy.mjs";

void OP_HELPERS;

const MAP = JSON.stringify({ version: 3, sources: ["src/a.ts"], sourcesContent: ["boom();\n"], names: [], mappings: "AAAA" });

const checkAiUrl = (url: string) => {
  const v = checkUrl(url, { isAppUrl: (u: string) => new URL(u).port === "8676" });
  if (!v.ok) throw new BrowserError("URL_BLOCKED", `该地址不允许访问：${v.reason}`);
  return v.url;
};

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const resp = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) => ({
  status: init.status ?? 200,
  ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
  headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
  body: undefined,
  text: async () => body,
});
const envOf = (fetchFn: unknown, extra: Record<string, unknown> = {}) => ({ checkAiUrl, fetch: fetchFn as typeof fetch, trustedHosts: ["site.test:443"], pageHost: "site.test:443", lookup: PUBLIC, ...extra });

// ───────────────────────── ① 端口全等（假 fetch） ─────────────────────────

describe("R6-35 · 同 hostname 且有效端口全等", () => {
  it("同 host 不同端口被拒（CrossHostMapError，不发请求、不查 DNS）", async () => {
    const f = vi.fn(async () => resp(MAP));
    const lookup = vi.fn(PUBLIC);
    const env = envOf(f, { trustedHosts: ["app.example.com:5173"], pageHost: "app.example.com:5173", lookup });
    for (const u of ["https://app.example.com:5174/a.map", "https://app.example.com/a.map", "https://app.example.com:443/a.map", "http://app.example.com/a.map"]) {
      await expect(fetchMapText(u, env), u).rejects.toBeInstanceOf(CrossHostMapError);
    }
    expect(f).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("端口相同（含大小写 / 尾点）通过", async () => {
    const f = vi.fn(async () => resp(MAP));
    const env = envOf(f, { trustedHosts: ["App.Example.com:5173"], pageHost: "App.Example.com:5173" });
    expect(await fetchMapText("https://app.example.com:5173/a.map", env)).toBe(MAP);
    expect(await fetchMapText("https://APP.example.COM.:5173/b.map", env)).toBe(MAP);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("默认端口等价：https://x 与 https://x:443、http://x 与 http://x:80；http 与 https 互不等价", async () => {
    const f = vi.fn(async () => resp(MAP));
    const https443 = envOf(f, { trustedHosts: ["x.test:443"], pageHost: "x.test:443" });
    expect(await fetchMapText("https://x.test/a.map", https443)).toBe(MAP);
    expect(await fetchMapText("https://x.test:443/a.map", https443)).toBe(MAP);
    await expect(fetchMapText("http://x.test/a.map", https443)).rejects.toBeInstanceOf(CrossHostMapError); // 80 ≠ 443
    const http80 = envOf(f, { trustedHosts: ["x.test:80"], pageHost: "x.test:80" });
    expect(await fetchMapText("http://x.test/a.map", http80)).toBe(MAP);
    expect(await fetchMapText("http://x.test:80/a.map", http80)).toBe(MAP);
    await expect(fetchMapText("https://x.test/a.map", http80)).rejects.toBeInstanceOf(CrossHostMapError);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("脚本与页面端口不同：map 与其中任一个 host:port 全等即可，其它端口一律拒", async () => {
    const f = vi.fn(async () => resp(MAP));
    const env = envOf(f, { trustedHosts: ["site.test:8443", "site.test:443"], pageHost: "site.test:443" });
    expect(await fetchMapText("https://site.test:8443/a.map", env)).toBe(MAP);
    expect(await fetchMapText("https://site.test/a.map", env)).toBe(MAP);
    await expect(fetchMapText("https://site.test:9443/a.map", env)).rejects.toBeInstanceOf(CrossHostMapError);
  });

  it("兼容：纯 hostname 条目只比 hostname（旧调用方）；写了 host:port 才比端口", async () => {
    const f = vi.fn(async () => resp(MAP));
    expect(await fetchMapText("https://site.test:8443/a.map", envOf(f, { trustedHosts: ["site.test"], pageHost: "site.test" }))).toBe(MAP);
    await expect(fetchMapText("https://site.test:8443/a.map", envOf(f, { trustedHosts: ["site.test:443"], pageHost: "site.test:443" }))).rejects.toBeInstanceOf(CrossHostMapError);
  });

  it("IPv6：方括号条目 `[::1]:3000`，端口不同被拒", async () => {
    const f = vi.fn(async () => resp(MAP));
    const env = envOf(f, { trustedHosts: ["[::1]:3000"], pageHost: "[::1]:3000" });
    expect(await fetchMapText("http://[::1]:3000/a.map", env)).toBe(MAP);
    await expect(fetchMapText("http://[::1]:6379/a.map", env)).rejects.toBeInstanceOf(CrossHostMapError);
  });

  it("loopback 页面 localhost:3000：map 指向 localhost:6379 被拒，localhost:3000 放行（且不查 DNS）", async () => {
    const f = vi.fn(async () => resp(MAP));
    const lookup = vi.fn(PUBLIC);
    const env = envOf(f, { trustedHosts: ["localhost:3000", "localhost:3000"], pageHost: "localhost:3000", lookup });
    await expect(fetchMapText("http://localhost:6379/a.map", env)).rejects.toBeInstanceOf(CrossHostMapError);
    await expect(fetchMapText("http://localhost/a.map", env)).rejects.toBeInstanceOf(CrossHostMapError);
    expect(f).not.toHaveBeenCalled();
    expect(await fetchMapText("http://localhost:3000/a.map", env)).toBe(MAP);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("loopback 页面 localhost:3000、脚本在 localhost:3001：map 在 3001 放行（脚本端口一致），3002 被拒", async () => {
    const f = vi.fn(async () => resp(MAP));
    const env = envOf(f, { trustedHosts: ["localhost:3001", "localhost:3000"], pageHost: "localhost:3000" });
    expect(await fetchMapText("http://localhost:3001/a.map", env)).toBe(MAP);
    await expect(fetchMapText("http://localhost:3002/a.map", env)).rejects.toBeInstanceOf(CrossHostMapError);
  });

  it("重定向跳到同 host 不同端口：每一跳重走校验，被拒", async () => {
    const hop = vi.fn(async () => resp("", { status: 302, headers: { location: "https://site.test:8443/b.map" } }));
    await expect(fetchMapText("https://site.test/a.map", envOf(hop))).rejects.toBeInstanceOf(CrossHostMapError);
    expect(hop).toHaveBeenCalledTimes(1);
    // 对照：重定向跳到同 host 同端口 → 继续取
    let n = 0;
    const ok = vi.fn(async () => (n++ === 0 ? resp("", { status: 302, headers: { location: "https://site.test:443/b.map" } }) : resp(MAP)));
    expect(await fetchMapText("https://site.test/a.map", envOf(ok))).toBe(MAP);
  });

  it("纯函数：mapHostAllowed / assertMapHostSafe 的端口口径（条目带端口而调用方没给端口 → fail-closed）", async () => {
    expect(mapHostAllowed("localhost", ["localhost:3000"], 3000)).toBe(true);
    expect(mapHostAllowed("localhost", ["localhost:3000"], "3000")).toBe(true);
    expect(mapHostAllowed("localhost", ["localhost:3000"], 6379)).toBe(false);
    expect(mapHostAllowed("localhost", ["localhost:3000"])).toBe(false);
    expect(mapHostAllowed("localhost", ["localhost"], 6379)).toBe(true); // 纯 host 兼容
    expect(mapHostAllowed("cdn.example.com", [], 443)).toBe(true); // 公网字面量不受 trusted 限制（同 R6-05：host 同一性由 assertMapHostSafe 管）
    await expect(assertMapHostSafe("site.test", { trustedHosts: ["site.test:443"], lookup: PUBLIC })).rejects.toBeInstanceOf(CrossHostMapError);
    await expect(assertMapHostSafe("site.test", { trustedHosts: ["site.test:443"], port: 8443, lookup: PUBLIC })).rejects.toBeInstanceOf(CrossHostMapError);
    await expect(assertMapHostSafe("site.test", { trustedHosts: ["site.test:443"], port: 443, lookup: PUBLIC })).resolves.toBeUndefined();
    await expect(assertMapHostSafe("localhost", { trustedHosts: ["localhost:3000"], pageHost: "localhost:3000", port: 3000, lookup: PUBLIC })).resolves.toBeUndefined();
    await expect(assertMapHostSafe("localhost", { trustedHosts: ["localhost:3000"], pageHost: "localhost:3000", port: 6379, lookup: PUBLIC })).rejects.toBeInstanceOf(CrossHostMapError);
  });
});

// ───────────────────────── loadMap 接线：受信条目带端口 ─────────────────────────

type Ev = (method: string, params: Record<string, unknown>, sid: string | null) => void;
const makeTab = (scripts: Array<Record<string, unknown>>, url: string) => {
  const listeners = new Set<Ev>();
  const ext = new Map<string, { dispose?: () => void }>();
  return {
    id: "t1",
    url,
    send: vi.fn(async (method: string) => {
      if (method === "Debugger.enable") for (const s of scripts) listeners.forEach((l) => l("Debugger.scriptParsed", s, null));
      return {};
    }),
    onCdpEvent: (fn: Ev) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    addSessionHook: () => () => {},
    cdpSessionIds: () => [null],
    getExt: (key: string, factory: () => { dispose?: () => void }) => {
      if (!ext.has(key)) ext.set(key, factory());
      return ext.get(key)!;
    },
    consoleRing: { list: () => [] },
  };
};
type Resolve = (t: unknown, e: unknown[], o?: { activity?: (s: string) => void }) => Promise<{ resolvedFrames: number; note?: string }>;
const stackOf = (scriptUrl: string) => [{ ts: 1, level: "error", text: "Error: boom", stack: [{ functionName: "f", url: scriptUrl, line: 0, column: 0 }] }];
const resolveWith = async (pageUrl: string, scriptUrl: string, sourceMapURL: string, fetchFn: unknown) => {
  const script = { scriptId: "1", url: scriptUrl, startLine: 0, startColumn: 0, endLine: 1, endColumn: 0, sourceMapURL, length: 100 };
  const h = createHandlers({ requireSession: () => ({}), checkAiUrl, fetch: fetchFn, lookup: PUBLIC, log: () => {} } as never) as unknown as { _resolveConsoleStacks: Resolve };
  return h._resolveConsoleStacks(makeTab([script], pageUrl), stackOf(scriptUrl));
};

describe("R6-35 · loadMap 接线：脚本 / 页面的 host:port 作为受信条目", () => {
  it("脚本在 :5173：同端口的相对 map 取得；指向 :5174 / 默认端口的绝对 map 跳过并计入跨域", async () => {
    const f = vi.fn(async () => resp(MAP));
    const ok = await resolveWith("https://app.example.com:5173/", "https://app.example.com:5173/s.js", "s.js.map", f);
    expect(ok.resolvedFrames).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
    for (const m of ["https://app.example.com:5174/s.js.map", "https://app.example.com/s.js.map"]) {
      const g = vi.fn(async () => resp(MAP));
      const r = await resolveWith("https://app.example.com:5173/", "https://app.example.com:5173/s.js", m, g);
      expect(r.resolvedFrames, m).toBe(0);
      expect(r.note, m).toContain("跨域 sourcemap 已跳过");
      expect(g, m).not.toHaveBeenCalled();
    }
  });

  it("localhost:3000 开发页：map 指向 localhost:6379 跳过；默认端口的 https://x 与 :443 等价", async () => {
    const g = vi.fn(async () => resp(MAP));
    const r = await resolveWith("http://localhost:3000/", "http://localhost:3000/s.js", "http://localhost:6379/s.js.map", g);
    expect(r.resolvedFrames).toBe(0);
    expect(g).not.toHaveBeenCalled();
    const h = vi.fn(async () => resp(MAP));
    expect((await resolveWith("http://localhost:3000/", "http://localhost:3000/s.js", "http://localhost:3000/s.js.map", h)).resolvedFrames).toBe(1);
    const d = vi.fn(async () => resp(MAP));
    expect((await resolveWith("https://x.test/", "https://x.test:443/s.js", "https://x.test/s.js.map", d)).resolvedFrames).toBe(1);
  });
});

// ───────────────────────── ② pinnedFetch：连接时校验并钉住 IP ─────────────────────────

type Srv = { port: number; hits: () => number; seen: () => http.IncomingHttpHeaders[]; close: () => Promise<void> };
const servers: Srv[] = [];
const startServer = async (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Srv> => {
  let hits = 0;
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    hits++;
    seen.push(req.headers);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const srv: Srv = {
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
    seen: () => seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  servers.push(srv);
  return srv;
};
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const serveMap = () => startServer((_req, res) => res.end(MAP));
/** 测试里把回环当「公网」，其它沿用真实口径里的内网段（这样才能用本机服务器验证「放行」路径） */
const loopbackIsPublic = (ip: string) => ip.startsWith("10.") || ip.startsWith("169.254.") || ip.startsWith("192.168.");
const lookupTo =
  (...addrs: string[]) =>
  async () =>
    addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const readAll = async (res: { body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } }) => {
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value!));
  }
  return Buffer.concat(chunks).toString("utf8");
};

describe("R6-35 · createPinnedFetch：lookup 在建连时校验", () => {
  it("lookup 返回合法地址 → 连到校验过的 IP 取到文本；Host 头保持原主机名；不带 cookie / 认证头；不跟随重定向", async () => {
    const srv = await serveMap();
    const pf = createPinnedFetch({ lookup: lookupTo("127.0.0.1"), isPrivateIp: loopbackIsPublic });
    const res = await pf(`http://map.test:${srv.port}/a.map?x=1`, { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await readAll(res)).toBe(MAP);
    const h = srv.seen()[0]!;
    expect(h.host).toBe(`map.test:${srv.port}`);
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h.accept).toBe("application/json");
  });

  it("lookup 返回内网地址 → 拒绝，服务器没收到任何连接", async () => {
    const srv = await serveMap();
    for (const ip of ["10.0.0.5", "169.254.169.254", "127.0.0.1", "::1"]) {
      const pf = createPinnedFetch({ lookup: lookupTo(ip) }); // 默认 isPrivateIp：回环也是内网
      await expect(pf(`http://map.test:${srv.port}/a.map`), ip).rejects.toThrow(/内网|本机/);
    }
    expect(srv.hits()).toBe(0);
  });

  it("lookup 返回多个地址、其中任一是内网 → 拒绝（不论顺序）", async () => {
    const srv = await serveMap();
    for (const addrs of [["127.0.0.1", "10.0.0.5"], ["10.0.0.5", "127.0.0.1"], ["127.0.0.1", "127.0.0.2", "169.254.169.254"]]) {
      const pf = createPinnedFetch({ lookup: lookupTo(...addrs), isPrivateIp: (ip) => ip.startsWith("10.") || ip.startsWith("169.254.") });
      await expect(pf(`http://map.test:${srv.port}/a.map`), addrs.join()).rejects.toThrow(/内网|本机/);
    }
    expect(srv.hits()).toBe(0);
    // 对照：全部合法 → 通过
    const ok = createPinnedFetch({ lookup: lookupTo("127.0.0.1", "127.0.0.2"), isPrivateIp: loopbackIsPublic });
    expect(await readAll(await ok(`http://map.test:${srv.port}/a.map`))).toBe(MAP);
  });

  it("解析失败 / 无结果 → fail-closed", async () => {
    const srv = await serveMap();
    await expect(createPinnedFetch({ lookup: async () => [] })(`http://map.test:${srv.port}/a.map`)).rejects.toThrow(/无法解析/);
    await expect(createPinnedFetch({ lookup: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })) })(`http://map.test:${srv.port}/a.map`)).rejects.toThrow(/无法解析/);
    expect(srv.hits()).toBe(0);
  });

  it("IP 字面量：net 不会调 lookup，这里直接校验（内网拒、loopbackHost 例外只放回环）", async () => {
    const srv = await serveMap();
    const lookup = vi.fn(lookupTo("93.184.216.34"));
    await expect(createPinnedFetch({ lookup })(`http://10.0.0.5:${srv.port}/a.map`)).rejects.toThrow(/内网|本机/);
    await expect(createPinnedFetch({ lookup })(`http://127.0.0.1:${srv.port}/a.map`)).rejects.toThrow(/内网|本机/);
    expect(srv.hits()).toBe(0);
    const loop = createPinnedFetch({ lookup, loopbackHost: (h) => h === "127.0.0.1" });
    expect(await readAll(await loop(`http://127.0.0.1:${srv.port}/a.map`))).toBe(MAP);
    expect(lookup).not.toHaveBeenCalled();
    await expect(createPinnedFetch({ lookup, loopbackHost: () => true })(`http://10.0.0.5:${srv.port}/a.map`)).rejects.toThrow(/内网|本机/); // 例外只放回环
  });

  it("loopbackHost 例外：解析结果必须全是回环才放行，混进内网 / 公网地址仍拒", async () => {
    const srv = await serveMap();
    const base = { loopbackHost: (h: string) => h === "localhost" };
    expect(await readAll(await createPinnedFetch({ ...base, lookup: lookupTo("127.0.0.1") })(`http://localhost:${srv.port}/a.map`))).toBe(MAP);
    for (const addrs of [["127.0.0.1", "10.0.0.5"], ["10.0.0.5"], ["93.184.216.34"]]) {
      await expect(createPinnedFetch({ ...base, lookup: lookupTo(...addrs) })(`http://localhost:${srv.port}/a.map`), addrs.join()).rejects.toThrow(/内网|本机/);
    }
    // 非例外主机上，回环仍是内网
    await expect(createPinnedFetch({ ...base, lookup: lookupTo("127.0.0.1") })(`http://other.test:${srv.port}/a.map`)).rejects.toThrow(/内网|本机/);
    expect(srv.hits()).toBe(1);
  });

  it("signal 取消 → 请求被销毁（不挂死）；每次新连接（不复用 keep-alive）", async () => {
    const hang = await startServer(() => {
      /* 不回复 */
    });
    const ac = new AbortController();
    const pf = createPinnedFetch({ lookup: lookupTo("127.0.0.1"), isPrivateIp: loopbackIsPublic });
    const p = pf(`http://map.test:${hang.port}/a.map`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 40);
    await expect(p).rejects.toThrow();
    const lookup = vi.fn(lookupTo("127.0.0.1"));
    const srv = await serveMap();
    const pf2 = createPinnedFetch({ lookup, isPrivateIp: loopbackIsPublic });
    await readAll(await pf2(`http://map.test:${srv.port}/a.map`));
    await readAll(await pf2(`http://map.test:${srv.port}/a.map`));
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("R6-35 · fetchMapText 生产路径（没注入 env.fetch）走 pinnedFetch", () => {
  const prodEnv = (port: number, extra: Record<string, unknown> = {}) => ({
    checkAiUrl,
    trustedHosts: [`map.test:${port}`],
    pageHost: `map.test:${port}`,
    ...extra,
  });

  it("对照：lookup 合法（公网判定里回环放行）→ 真的连本地服务器取到 map，预检与连接各查一次 DNS", async () => {
    const srv = await serveMap();
    const lookup = vi.fn(lookupTo("127.0.0.1"));
    const text = await fetchMapText(`http://map.test:${srv.port}/a.map`, prodEnv(srv.port, { lookup, isPrivateIp: loopbackIsPublic }));
    expect(text).toBe(MAP);
    expect(srv.hits()).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("rebinding：预检返回公网、连接时返回 127.0.0.1 → 被拒，服务器没收到连接", async () => {
    const srv = await serveMap();
    let n = 0;
    const lookup = vi.fn(async () => (n++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
    await expect(fetchMapText(`http://map.test:${srv.port}/a.map`, prodEnv(srv.port, { lookup }))).rejects.toThrow(/内网|本机/);
    expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(2); // 预检 + 连接时各一次
    expect(srv.hits()).toBe(0);
  });

  it("rebinding（多地址）：连接时多个结果里混进内网 → 被拒", async () => {
    const srv = await serveMap();
    let n = 0;
    const lookup = async () =>
      n++ === 0
        ? [{ address: "93.184.216.34", family: 4 }]
        : [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ];
    await expect(fetchMapText(`http://map.test:${srv.port}/a.map`, prodEnv(srv.port, { lookup }))).rejects.toThrow(/内网|本机/);
    expect(srv.hits()).toBe(0);
  });

  it("loopback 开发站：host + 端口全等放行；连接时解析被 rebinding 成内网 → 拒；不同端口 → 跨域", async () => {
    const srv = await serveMap();
    const env = (lookup: () => Promise<Array<{ address: string; family: number }>>) => ({ checkAiUrl, trustedHosts: [`localhost:${srv.port}`], pageHost: `localhost:${srv.port}`, lookup });
    expect(await fetchMapText(`http://localhost:${srv.port}/a.map`, env(lookupTo("127.0.0.1")))).toBe(MAP);
    expect(srv.hits()).toBe(1);
    await expect(fetchMapText(`http://localhost:${srv.port}/a.map`, env(lookupTo("10.0.0.5")))).rejects.toThrow(/内网|本机/);
    await expect(fetchMapText(`http://localhost:${srv.port}/a.map`, env(lookupTo("127.0.0.1", "10.0.0.5")))).rejects.toThrow(/内网|本机/);
    await expect(fetchMapText(`http://localhost:${srv.port + 1}/a.map`, env(lookupTo("127.0.0.1")))).rejects.toBeInstanceOf(CrossHostMapError);
    expect(srv.hits()).toBe(1);
  });

  it("重定向：同 host 同端口继续取；跳到同 host 不同端口 → 跨域拒，另一端口的服务器没收到请求", async () => {
    const other = await serveMap();
    const srv = await startServer((req, res) => {
      if (req.url === "/a.map") {
        res.writeHead(302, { location: "/b.map" });
        res.end();
      } else if (req.url === "/c.map") {
        res.writeHead(302, { location: `http://map.test:${other.port}/x.map` });
        res.end();
      } else res.end(MAP);
    });
    const env = prodEnv(srv.port, { lookup: lookupTo("127.0.0.1"), isPrivateIp: loopbackIsPublic });
    expect(await fetchMapText(`http://map.test:${srv.port}/a.map`, env)).toBe(MAP);
    await expect(fetchMapText(`http://map.test:${srv.port}/c.map`, env)).rejects.toBeInstanceOf(CrossHostMapError);
    expect(other.hits()).toBe(0);
  });

  it("读取语义保持：非 2xx / 超限 / 超时 / gzip 解压后限量 / 外部取消", async () => {
    const srv = await startServer((req, res) => {
      if (req.url === "/404.map") {
        res.statusCode = 404;
        res.end("no");
      } else if (req.url === "/big.map") {
        res.write("x".repeat(600));
        res.end("y".repeat(600)); // chunked，无 Content-Length
      } else if (req.url === "/len.map") {
        res.setHeader("content-length", "2000");
        res.end("z".repeat(2000));
      } else if (req.url === "/gz.map") {
        res.setHeader("content-encoding", "gzip");
        res.end(zlib.gzipSync(MAP));
      } else if (req.url === "/bomb.map") {
        res.setHeader("content-encoding", "gzip");
        res.end(zlib.gzipSync(Buffer.alloc(1_000_000, 0x61)));
      }
      // /hang.map：不回复
    });
    const env = (extra: Record<string, unknown> = {}) => prodEnv(srv.port, { lookup: lookupTo("127.0.0.1"), isPrivateIp: loopbackIsPublic, ...extra });
    const url = (p: string) => `http://map.test:${srv.port}${p}`;
    await expect(fetchMapText(url("/404.map"), env())).rejects.toThrow(/HTTP 404/);
    await expect(fetchMapText(url("/big.map"), env({ maxBytes: 1000 }))).rejects.toThrow(/上限/);
    await expect(fetchMapText(url("/len.map"), env({ maxBytes: 1000 }))).rejects.toThrow(/上限/);
    expect(await fetchMapText(url("/gz.map"), env())).toBe(MAP);
    await expect(fetchMapText(url("/bomb.map"), env({ maxBytes: 5000 }))).rejects.toThrow(/上限/); // 解压后才计量
    await expect(fetchMapText(url("/hang.map"), env({ timeoutMs: 60 }))).rejects.toThrow(/超时/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    await expect(fetchMapText(url("/hang.map"), env({ signal: ac.signal }))).rejects.toThrow(/已取消/);
  });
});
