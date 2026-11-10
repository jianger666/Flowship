/**
 * R6-05（sourcemap 拉取只按主机名字面判内网）+ R6-16（console sourcemap:true 无总时限 / 无并发上限 / 无活动日志）。
 * 全部用假 fetch + 注入的 DNS lookup + 假 tab，不依赖真实网络 / DNS。
 */
import { describe, expect, it, vi } from "vitest";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { CONSOLE_SOURCEMAP_CONCURRENCY, CONSOLE_SOURCEMAP_PARSE_CAP, assertMapHostSafe, createHandlers, fetchMapText, isPrivateIp, CrossHostMapError } from "../electron-app/browser/ops/sources.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { checkUrl } from "../electron-app/browser/url-policy.mjs";

void OP_HELPERS;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (n: number): string => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    out += B64[d];
  } while (v > 0);
  return out;
};
const MAP = JSON.stringify({
  version: 3,
  sources: ["src/a.ts"],
  sourcesContent: ["const a = 1;\nfunction f() {\n    boom();\n}\n"],
  names: ["boom"],
  mappings: `${vlq(0)}${vlq(0)}${vlq(0)}${vlq(0)},${vlq(10)}${vlq(0)}${vlq(2)}${vlq(4)}${vlq(0)}`,
});

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
const hang = (_u: string, init: { signal: AbortSignal }) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));

const envOf = (fetchFn: unknown, extra: Record<string, unknown> = {}) => ({ checkAiUrl, fetch: fetchFn as typeof fetch, trustedHosts: ["site.test"], pageHost: "site.test", lookup: PUBLIC, ...extra });

describe("R6-05：map 主机必须与脚本 / 页面同 host + 解析后 IP 复核", () => {
  it.each(["https://169.254.169.254.nip.io/a.map", "https://localtest.me/a.map", "https://127.0.0.1.sslip.io/a.map", "https://cdn.example.com/a.map", "https://SITE.test.evil.com/a.map"])(
    "跨 host（DNS 别名 / 公网 CDN）一律不拉：%s",
    async (u) => {
      const f = vi.fn(async () => resp(MAP));
      const lookup = vi.fn(PUBLIC);
      await expect(fetchMapText(u, envOf(f, { lookup }))).rejects.toThrow(/跨域 sourcemap 已跳过/);
      await expect(fetchMapText(u, envOf(f, { lookup }))).rejects.toBeInstanceOf(CrossHostMapError);
      expect(f).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled(); // 连 DNS 都不查（不给页面「探测」的机会）
    },
  );

  it("同 host 正常：解析到公网 → 放行并取到文本（map 相对路径同 host）", async () => {
    const f = vi.fn(async () => resp(MAP));
    expect(await fetchMapText("https://site.test/static/a.map", envOf(f))).toBe(MAP);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["127.0.0.1", "回环"],
    ["10.0.0.5", "私网"],
    ["169.254.169.254", "云元数据 / 链路本地"],
    ["100.100.100.200", "阿里云元数据（CGNAT 段）"],
    ["::1", "IPv6 回环"],
    ["fd00:ec2::254", "AWS IPv6 元数据（唯一本地）"],
    ["::ffff:10.0.0.5", "IPv4 映射的私网"],
  ])("同 host 但 DNS 解析到内网（%s，%s）→ 拒绝，不发请求", async (ip) => {
    const f = vi.fn(async () => resp(MAP));
    await expect(fetchMapText("https://site.test/a.map", envOf(f, { lookup: async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }] }))).rejects.toThrow(/内网|本机/);
    expect(f).not.toHaveBeenCalled();
  });

  it("多个 DNS 结果里只要有一个落内网就拒绝（all:true，不能只看第一条）", async () => {
    const f = vi.fn(async () => resp(MAP));
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(fetchMapText("https://site.test/a.map", envOf(f, { lookup }))).rejects.toThrow(/内网|本机/);
    expect(f).not.toHaveBeenCalled();
  });

  it("lookup 以 all:true 调用；解析失败 / 无结果 fail-closed", async () => {
    const lookup = vi.fn(PUBLIC);
    await fetchMapText("https://site.test/a.map", envOf(async () => resp(MAP), { lookup }));
    expect(lookup).toHaveBeenCalledWith("site.test", expect.objectContaining({ all: true }));
    const f = vi.fn(async () => resp(MAP));
    await expect(fetchMapText("https://site.test/a.map", envOf(f, { lookup: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })) }))).rejects.toThrow(/无法解析/);
    await expect(fetchMapText("https://site.test/a.map", envOf(f, { lookup: async () => [] }))).rejects.toThrow(/无法解析/);
    expect(f).not.toHaveBeenCalled();
  });

  it("页面本身就在 localhost 开发站：同 host 放行（不查 DNS）；但 127.0.0.1 对 localhost 页面仍是跨 host", async () => {
    const f = vi.fn(async () => resp(MAP));
    const lookup = vi.fn(PUBLIC);
    const dev = { trustedHosts: ["localhost"], pageHost: "localhost", lookup };
    expect(await fetchMapText("http://localhost:3000/a.map", envOf(f, dev))).toBe(MAP);
    expect(lookup).not.toHaveBeenCalled();
    await expect(fetchMapText("http://127.0.0.1:3000/a.map", envOf(f, dev))).rejects.toThrow(/跨域/);
  });

  it("页面在内网 IP（非 localhost）：同 host 的 map 也拒绝（页面 host 不是 loopback，不享受开发站例外）", async () => {
    const f = vi.fn(async () => resp(MAP));
    await expect(fetchMapText("http://192.168.1.8:3000/a.map", envOf(f, { trustedHosts: ["192.168.1.8"], pageHost: "192.168.1.8" }))).rejects.toThrow(/内网|本机/);
    expect(f).not.toHaveBeenCalled();
  });

  it("重定向每一跳都重走：跳到跨 host 被拒；同 host 但第二次解析变成内网也被拒", async () => {
    const toCdn = vi.fn(async () => resp("", { status: 302, headers: { location: "https://169.254.169.254.nip.io/x.map" } }));
    await expect(fetchMapText("https://site.test/a.map", envOf(toCdn))).rejects.toThrow(/跨域/);
    expect(toCdn).toHaveBeenCalledTimes(1);
    const same = vi.fn(async () => resp("", { status: 302, headers: { location: "https://site.test/b.map" } }));
    let n = 0;
    const flip = async () => (n++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]);
    await expect(fetchMapText("https://site.test/a.map", envOf(same, { lookup: flip }))).rejects.toThrow(/内网|本机/);
    expect(same).toHaveBeenCalledTimes(1);
  });

  it("isPrivateIp / assertMapHostSafe 纯函数口径", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.1.1", "0.0.0.0", "::1", "fe80::1", "fc00::1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
    await expect(assertMapHostSafe("site.test", { trustedHosts: [], lookup: PUBLIC })).rejects.toBeInstanceOf(CrossHostMapError);
    await expect(assertMapHostSafe("site.test", { trustedHosts: ["site.test"], lookup: PUBLIC })).resolves.toBeUndefined();
    await expect(assertMapHostSafe("SITE.test.", { trustedHosts: ["site.test"], lookup: PUBLIC })).resolves.toBeUndefined();
  });
});

// ───────────────────────── 假 tab（只实现 hub + sources 用得到的部分） ─────────────────────────

type Ev = (method: string, params: Record<string, unknown>, sid: string | null) => void;
const makeTab = (scripts: Array<Record<string, unknown>>, url = "https://site.test/page") => {
  const listeners = new Set<Ev>();
  const ext = new Map<string, { dispose?: () => void }>();
  const sent: string[] = [];
  const tab = {
    id: "t1",
    url,
    send: vi.fn(async (method: string) => {
      sent.push(method);
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
  return { tab, sent };
};

type Resolve = (t: unknown, e: unknown[], o?: { signal?: AbortSignal; activity?: (s: string) => void }) => Promise<{ entries: Array<{ stack: Array<{ original?: { source: string } }> }>; resolvedFrames: number; note?: string }>;

const scriptsN = (n: number, host = "site.test") =>
  Array.from({ length: n }, (_, i) => ({ scriptId: String(i + 1), url: `https://${host}/s${i}.js`, startLine: 0, startColumn: 0, endLine: 3, endColumn: 0, sourceMapURL: `s${i}.js.map`, length: 100 }));
const entriesFor = (scripts: Array<Record<string, unknown>>) => [
  { ts: 1, level: "error", text: "Error: boom", stack: scripts.map((s) => ({ functionName: "f", url: s.url, line: 0, column: 12 })) },
];
const handlersOf = (fetchFn: unknown, extra: Record<string, unknown> = {}) =>
  createHandlers({ requireSession: () => ({}), checkAiUrl, fetch: fetchFn, lookup: PUBLIC, log: () => {}, ...extra } as never) as unknown as { _resolveConsoleStacks: Resolve };

describe("R6-05 · console 路径：跨 host 的 map 跳过并注明", () => {
  it.each(["https://169.254.169.254.nip.io/a.map", "https://localtest.me/a.map", "https://127.0.0.1.sslip.io/a.map", "https://cdn.example.com/a.map"])("%s", async (mapUrl) => {
    const scripts = [{ ...scriptsN(1)[0], sourceMapURL: mapUrl }];
    const f = vi.fn(async () => resp(MAP));
    const lookup = vi.fn(PUBLIC);
    const { tab } = makeTab(scripts);
    const activity = vi.fn();
    const r = await handlersOf(f, { lookup })._resolveConsoleStacks(tab, entriesFor(scripts), { activity });
    expect(f).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(r.resolvedFrames).toBe(0);
    expect(r.note).toContain("跨域 sourcemap 已跳过");
    expect(activity).toHaveBeenCalledWith("已取 0 张 sourcemap（跳过 1）");
  });

  it("同 host 正常 + data: 内联 map 放行；二者混合时跨 host 那张被跳过，其余正常还原", async () => {
    const inline = `data:application/json;base64,${Buffer.from(MAP).toString("base64")}`;
    const scripts = [
      { ...scriptsN(3)[0], sourceMapURL: "s0.js.map" },
      { ...scriptsN(3)[1], sourceMapURL: inline },
      { ...scriptsN(3)[2], sourceMapURL: "https://cdn.example.com/s2.js.map" },
    ];
    const f = vi.fn(async () => resp(MAP));
    const { tab } = makeTab(scripts);
    const activity = vi.fn();
    const r = await handlersOf(f)._resolveConsoleStacks(tab, entriesFor(scripts), { activity });
    expect(r.resolvedFrames).toBe(2);
    expect(f).toHaveBeenCalledTimes(1); // 只有同 host 那张发了请求；data: 不发、跨 host 不发
    expect(r.note).toContain("跨域 sourcemap 已跳过");
    expect(activity).toHaveBeenCalledWith("已取 2 张 sourcemap（跳过 1）");
  });
});

describe("R6-16：console sourcemap 阶段的总时限 / 并发 / 体积 / 取消 / 活动日志", () => {
  it("常量口径：并发 4、同步解析上限 2MB", () => {
    expect(CONSOLE_SOURCEMAP_CONCURRENCY).toBe(4);
    expect(CONSOLE_SOURCEMAP_PARSE_CAP).toBe(2 * 1024 * 1024);
  });

  it("总时限：全部 map 都挂起 → 在时限附近返回（不是 N×10s），note 注明，活动日志记「已取 0 张（跳过 N）」", async () => {
    const scripts = scriptsN(6);
    const { tab } = makeTab(scripts);
    const activity = vi.fn();
    const t0 = Date.now();
    const r = await handlersOf(hang, { sourcemapBudgetMs: 80 })._resolveConsoleStacks(tab, entriesFor(scripts), { activity });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.resolvedFrames).toBe(0);
    expect(r.note).toMatch(/总时限/);
    expect(activity).toHaveBeenCalledWith("已取 0 张 sourcemap（跳过 6）");
  });

  it("总时限：已解析的部分照常返回（快的 2 张还原，挂起的跳过）", async () => {
    const scripts = scriptsN(4);
    const { tab } = makeTab(scripts);
    const fetchFn = vi.fn((u: string, init: { signal: AbortSignal }) => (/s[01]\.js\.map/.test(u) ? Promise.resolve(resp(MAP)) : hang(u, init)));
    const activity = vi.fn();
    const r = await handlersOf(fetchFn, { sourcemapBudgetMs: 100 })._resolveConsoleStacks(tab, entriesFor(scripts), { activity });
    expect(r.resolvedFrames).toBe(2);
    expect(r.note).toMatch(/总时限.*2\/4/);
    expect(activity).toHaveBeenCalledWith("已取 2 张 sourcemap（跳过 2）");
  });

  it("并发上限：同时在途的 fetch 不超过 4，且确实并发了（> 1）", async () => {
    const scripts = scriptsN(12);
    const { tab } = makeTab(scripts);
    let inflight = 0;
    let peak = 0;
    const fetchFn = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight--;
      return resp(MAP);
    };
    const r = await handlersOf(fetchFn)._resolveConsoleStacks(tab, entriesFor(scripts));
    expect(r.resolvedFrames).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("超大 map：Content-Length > 2MB 在下载前就拒；data: 内联 > 2MB 拒绝同步解析；两者都不进 parseSourceMap（resolvedFrames 0）", async () => {
    const big = JSON.stringify({ version: 3, sources: [], names: [], mappings: "", pad: "x".repeat(3 * 1024 * 1024) });
    const inlineBig = `data:application/json;base64,${Buffer.from(big).toString("base64")}`;
    const scripts = [
      { ...scriptsN(2)[0], sourceMapURL: "s0.js.map" },
      { ...scriptsN(2)[1], sourceMapURL: inlineBig },
    ];
    const { tab } = makeTab(scripts);
    const fetchFn = vi.fn(async () => resp(big, { headers: { "content-length": String(big.length) } }));
    const activity = vi.fn();
    const r = await handlersOf(fetchFn)._resolveConsoleStacks(tab, entriesFor(scripts), { activity });
    expect(r.resolvedFrames).toBe(0);
    expect(r.note).toMatch(/2MB/);
    expect(activity).toHaveBeenCalledWith("已取 0 张 sourcemap（跳过 2）");
  });

  it("2MB 以内的 map 照常解析（边界另一侧）", async () => {
    const ok = JSON.stringify({ ...JSON.parse(MAP), pad: "x".repeat(1024 * 1024) });
    const scripts = scriptsN(1);
    const { tab } = makeTab(scripts);
    const r = await handlersOf(async () => resp(ok))._resolveConsoleStacks(tab, entriesFor(scripts));
    expect(r.resolvedFrames).toBe(1);
  });

  it("解析前后让出事件循环：每张 map 至少 2 次 setImmediate", async () => {
    const scripts = scriptsN(3);
    const { tab } = makeTab(scripts);
    const spy = vi.spyOn(globalThis, "setImmediate");
    try {
      const before = spy.mock.calls.length;
      await handlersOf(async () => resp(MAP))._resolveConsoleStacks(tab, entriesFor(scripts));
      expect(spy.mock.calls.length - before).toBeGreaterThanOrEqual(6);
    } finally {
      spy.mockRestore();
    }
  });

  it("AbortSignal：fetch 挂起时外部取消 → 立刻返回，note 注明已取消", async () => {
    const scripts = scriptsN(3);
    const { tab } = makeTab(scripts);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    const r = await handlersOf(hang)._resolveConsoleStacks(tab, entriesFor(scripts), { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.note).toMatch(/已取消/);
    expect(r.resolvedFrames).toBe(0);
  });

  it("已取消的 signal：一张都不取", async () => {
    const scripts = scriptsN(3);
    const { tab } = makeTab(scripts);
    const ac = new AbortController();
    ac.abort();
    const f = vi.fn(async () => resp(MAP));
    const r = await handlersOf(f)._resolveConsoleStacks(tab, entriesFor(scripts), { signal: ac.signal });
    expect(f).not.toHaveBeenCalled();
    expect(r.resolvedFrames).toBe(0);
  });

  it("活动日志：成功路径记「已取 N 张 sourcemap（跳过 M）」；没有 map 的脚本不触发日志", async () => {
    const scripts = [scriptsN(2)[0], { ...scriptsN(2)[1], sourceMapURL: undefined }];
    const { tab } = makeTab(scripts);
    const activity = vi.fn();
    await handlersOf(async () => resp(MAP))._resolveConsoleStacks(tab, entriesFor(scripts), { activity });
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledWith("已取 1 张 sourcemap（跳过 0）");
    const noMap = [{ ...scriptsN(1)[0], sourceMapURL: undefined }];
    const a2 = vi.fn();
    await handlersOf(async () => resp(MAP))._resolveConsoleStacks(makeTab(noMap).tab, entriesFor(noMap), { activity: a2 });
    expect(a2).not.toHaveBeenCalled();
  });
});

describe("R6-16 · index.mjs 接线（合同）", () => {
  it("opConsole 把 signal 与活动日志回调传给 _resolveConsoleStacks，dispatch 传 signal", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../electron-app/browser/index.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const opConsole = async \(taskId, a, signal\)/);
    expect(src).toMatch(/_resolveConsoleStacks\(tab, entries, \{[\s\S]{0,200}signal,[\s\S]{0,200}activity:[\s\S]{0,160}activityLog\.addAI/);
    expect(src).toMatch(/return opConsole\(taskId, a, signal\)/);
  });
});
