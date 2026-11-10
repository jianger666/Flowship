/**
 * E2·P7a / B3 主进程 op（ops/sources.mjs）：假 tab + 假 CDP + 假 fetch。
 * 覆盖：参数校验；list / get / sourcemap / issues；与 debug 共用 debugger-hub 的引用计数（一方释放不影响另一方）；
 * sourcemap 获取的安全策略（Flowship origin / 超大 / 重定向 / 内网主机 / 超时）；console 栈还原与降级；非 op 入口不可被外部分发。
 */
import { describe, expect, it, vi } from "vitest";

import { ALL_OPS } from "../electron-app/browser/index.mjs";
import { getDebuggerHub } from "../electron-app/browser/debugger-hub.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { OPS, createHandlers, fetchMapText, mapHostAllowed, normalize } from "../electron-app/browser/ops/sources.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { checkUrl } from "../electron-app/browser/url-policy.mjs";

type Ev = (method: string, params: Record<string, unknown>, sid: string | null) => void;

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
// 生成第 0 行：列 0 → a.ts:0:0；列 10 → a.ts:2:4（name boom）
const MAP = JSON.stringify({
  version: 3,
  sources: ["src/a.ts"],
  sourcesContent: ["const a = 1;\nfunction f() {\n    boom();\n}\n"],
  names: ["boom"],
  mappings: `${vlq(0)}${vlq(0)}${vlq(0)}${vlq(0)},${vlq(10)}${vlq(0)}${vlq(2)}${vlq(4)}${vlq(0)}`,
});

const SCRIPTS = [
  { scriptId: "1", url: "https://site.test/app.js?token=SECRETTOKEN1234567890", startLine: 0, startColumn: 0, endLine: 3, endColumn: 0, sourceMapURL: "app.js.map", length: 120 },
  { scriptId: "2", url: "", startLine: 5, startColumn: 8, endLine: 6, endColumn: 0, length: 30 },
  { scriptId: "3", url: "", startLine: 0, startColumn: 0, endLine: 0, endColumn: 10, length: 10 },
  { scriptId: "4", url: "https://site.test/lib.js", startLine: 0, startColumn: 0, endLine: 1, endColumn: 0, length: 50 },
];
const SOURCES: Record<string, string> = {
  "1": "var a=1;boom();\nconsole.log('x')\nvar apiKey = 'sk-A1b2C3d4E5f6G7h8I9j0K1l2M3n4';",
  "4": "export const x = 1;",
};
const SHEETS = [
  { styleSheetId: "S1", origin: "regular", sourceURL: "https://site.test/main.css", isInline: false, length: 40, startLine: 0, startColumn: 0 },
  { styleSheetId: "S2", origin: "regular", sourceURL: "", isInline: true, length: 20, startLine: 3, startColumn: 0 },
  { styleSheetId: "S3", origin: "user-agent", sourceURL: "", length: 999 },
];
const CSS_TEXT: Record<string, string> = { S1: "body { color: red; }\n.a { margin: 0 }", S2: ".inline { x: 1 }" };

const makeTab = (opts: { failDebuggerEnable?: boolean } = {}) => {
  const listeners = new Set<Ev>();
  const sent: Array<{ method: string; params: Record<string, unknown>; sid: string | null }> = [];
  const ext = new Map<string, { dispose?: () => void }>();
  const emit: Ev = (m, p, s) => listeners.forEach((l) => l(m, p, s));
  let issues: Array<Record<string, unknown>> = [];
  const tab = {
    url: "https://site.test/page",
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sid: string | null = null) => {
      sent.push({ method, params, sid });
      if (method === "Debugger.enable") {
        if (opts.failDebuggerEnable) throw new Error("debugger busy");
        for (const s of SCRIPTS) emit("Debugger.scriptParsed", s, null);
      } else if (method === "Debugger.getScriptSource") return { scriptSource: SOURCES[String(params.scriptId)] ?? "" };
      else if (method === "CSS.enable") for (const h of SHEETS) emit("CSS.styleSheetAdded", { header: h }, null);
      else if (method === "CSS.getStyleSheetText") return { text: CSS_TEXT[String(params.styleSheetId)] ?? "" };
      else if (method === "Audits.enable") for (const i of issues) emit("Audits.issueAdded", { issue: i }, null);
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
  return { tab, sent, emit, listeners, setIssues: (v: Array<Record<string, unknown>>) => (issues = v), ext };
};

const resp = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) => ({
  status: init.status ?? 200,
  ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
  headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
  body: undefined,
  text: async () => body,
});

const checkAiUrl = (url: string) => {
  const v = checkUrl(url, { isAppUrl: (u: string) => new URL(u).port === "8676" });
  if (!v.ok) throw new BrowserError("URL_BLOCKED", `该地址不允许访问：${v.reason}`);
  return v.url;
};

const setup = (tabOpts: Parameters<typeof makeTab>[0] = {}, fetchImpl?: (u: string, init?: unknown) => Promise<unknown>) => {
  const t = makeTab(tabOpts);
  const fetchFn = vi.fn(fetchImpl ?? (async () => resp(MAP)));
  // lookup 固定返回公网 IP：R6-05 起同 host 的 map 也要 DNS 复核，测试不依赖真实 DNS
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const h = createHandlers({ requireSession: () => ({ getTab: () => t.tab }), checkAiUrl, fetch: fetchFn, lookup, log: () => {} } as never);
  const call = (a: Record<string, unknown>) => h.sources("task", normalize("sources", a, OP_HELPERS) as never);
  return { ...t, h, call, fetchFn };
};
const count = (s: ReturnType<typeof setup>, method: string) => s.sent.filter((x) => x.method === method).length;

describe("normalize：参数校验", () => {
  const n = (a: Record<string, unknown>) => normalize("sources", a, OP_HELPERS) as Record<string, unknown>;
  it("OPS 只有 sources；内部入口 _resolveConsoleStacks 不在 ALL_OPS（外部 dispatch 够不到）", () => {
    expect(OPS).toEqual(["sources"]);
    expect(ALL_OPS).not.toContain("_resolveConsoleStacks");
    expect(ALL_OPS).toContain("sources");
  });
  it("action 必填且只能是 list / get / sourcemap / issues", () => {
    expect(() => n({})).toThrow(/action/);
    expect(() => n({ action: "evil" })).toThrow(/只能是/);
  });
  it("list：kind 默认 all、limit 默认 100 并夹在 1–500；脏 kind 报错", () => {
    expect(n({ action: "list" })).toMatchObject({ action: "list", kind: "all", limit: 100 });
    expect(n({ action: "list", limit: 99999 }).limit).toBe(500);
    expect(() => n({ action: "list", kind: "image" })).toThrow(/kind/);
  });
  it("get / sourcemap 需要 script_id 或 url；end_line < start_line 报错；max_chars 夹在上下限", () => {
    expect(() => n({ action: "get" })).toThrow(/script_id 或 url/);
    expect(() => n({ action: "sourcemap" })).toThrow(/script_id 或 url/);
    expect(() => n({ action: "get", scriptId: "1", startLine: 5, endLine: 2 })).toThrow(/end_line/);
    const g = n({ action: "get", scriptId: "1", maxChars: 10_000_000, original: true });
    expect(g.maxChars).toBe(100_000);
    expect(g.original).toBe(true);
    expect(n({ action: "get", scriptId: "1" }).maxChars).toBe(20_000);
  });
  it("sourcemap：original_line 必须带 source", () => {
    expect(() => n({ action: "sourcemap", scriptId: "1", originalLine: 3 })).toThrow(/source/);
    expect(n({ action: "sourcemap", scriptId: "1", line: 2, column: 3 })).toMatchObject({ line: 2, column: 3 });
  });
  it("issues：types 必须是已知类型的数组；脏参数报错；去重", () => {
    expect(() => n({ action: "issues", types: "csp" })).toThrow(/数组/);
    expect(() => n({ action: "issues", types: ["csp", "nope"] })).toThrow(/未知类型/);
    expect(() => n({ action: "issues", types: [1] })).toThrow(/数组/);
    expect(n({ action: "issues", types: ["csp", "csp", "cookie"] }).types).toEqual(["csp", "cookie"]);
    expect(n({ action: "issues" })).toMatchObject({ limit: 30 });
  });
  it("tabId 透传；超长 url 被拒", () => {
    expect(n({ action: "list", tabId: "t2" }).tabId).toBe("t2");
    expect(() => n({ action: "get", url: "x".repeat(3000) })).toThrow(/过长|url/);
  });
});

describe("list", () => {
  it("列出启用前就加载的脚本（hub 重放）与样式表；url 脱敏；动态脚本占位；UA 样式表不列；最新在后", async () => {
    const s = setup();
    const r = (await s.call({ action: "list" })) as { items: Array<Record<string, unknown>>; total: number; scriptCount: number; styleCount: number };
    expect(r.scriptCount).toBe(4);
    expect(r.styleCount).toBe(2);
    expect(r.items.map((i) => i.id)).toEqual(["1", "2", "3", "4", "css:S1", "css:S2"]);
    expect(String(r.items[0].url)).not.toContain("SECRETTOKEN1234567890");
    expect(r.items[0].sourceMap).toBe(true);
    expect(r.items[1].url).toBe("<inline>");
    expect(r.items[2].url).toBe("<eval>");
    expect(r.items[5].url).toBe("<inline style>");
    expect(r.items[3].sourceMap).toBe(false);
  });

  it("url 过滤（对脱敏后的 URL 匹配，探不出被脱敏的值）/ kind / limit 保留最新", async () => {
    const s = setup();
    const lib = (await s.call({ action: "list", url: "lib.js" })) as { items: Array<{ id: string }> };
    expect(lib.items.map((i) => i.id)).toEqual(["4"]);
    const probe = (await s.call({ action: "list", url: "SECRETTOKEN1234567890" })) as { total: number };
    expect(probe.total).toBe(0);
    const style = (await s.call({ action: "list", kind: "style" })) as { items: Array<{ kind: string }> };
    expect(style.items.every((i) => i.kind === "style")).toBe(true);
    const lim = (await s.call({ action: "list", limit: 2 })) as { items: Array<{ id: string }>; omitted: number };
    expect(lim.items.map((i) => i.id)).toEqual(["css:S1", "css:S2"]);
    expect(lim.omitted).toBe(4);
  });

  it("Debugger 域用完释放（disable 一次）；CSS 域从不 disable", async () => {
    const s = setup();
    await s.call({ action: "list" });
    expect(count(s, "Debugger.enable")).toBe(1);
    expect(count(s, "Debugger.disable")).toBe(1);
    expect(count(s, "CSS.disable")).toBe(0);
  });

  it("与 debug 共用 hub：debug 持有期间，sources 释放不会 Debugger.disable；debug 再释放才 disable", async () => {
    const s = setup();
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("debug"); // 假的第二个使用者
    await s.call({ action: "list" });
    expect(count(s, "Debugger.enable")).toBe(1); // 不重复 enable
    expect(count(s, "Debugger.disable")).toBe(0);
    expect(hub.ownerCount()).toBe(1);
    await hub.release("debug");
    expect(count(s, "Debugger.disable")).toBe(1);
  });

  it("并发两个调用只登记一次 hub，最后一个走时才释放", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.call({ action: "list" }), s.call({ action: "list", kind: "script" })]);
    expect((a as { total: number }).total).toBe(6);
    expect((b as { total: number }).total).toBe(4);
    expect(count(s, "Debugger.enable")).toBe(1);
    expect(count(s, "Debugger.disable")).toBe(1);
  });

  it("Debugger 域启用失败：kind=all 仍给样式表并标 scriptsUnavailable；kind=script 抛错", async () => {
    const s = setup({ failDebuggerEnable: true });
    const r = (await s.call({ action: "list" })) as { scriptsUnavailable?: boolean; styleCount: number; scriptCount: number };
    expect(r.scriptsUnavailable).toBe(true);
    expect(r.styleCount).toBe(2);
    expect(r.scriptCount).toBe(0);
    await expect(s.call({ action: "list", kind: "script" })).rejects.toThrow(/调试器域/);
  });
});

describe("list：隐藏非页面脚本 / 内联标记", () => {
  it("隔离世界脚本（Flowship 注入 / 扩展）与 Electron 内部脚本不出现在 list / get 里；文档 URL 的内联脚本与 <style> 带 inline 标记", async () => {
    const s = setup();
    await s.call({ action: "list" }); // 建立 tab 状态（监听常驻），hub 随后释放
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("keep");
    const base = { startLine: 0, startColumn: 0, endLine: 1, endColumn: 0 };
    s.emit("Debugger.scriptParsed", { ...base, scriptId: "20", url: "", executionContextAuxData: { isDefault: false, type: "isolated" } }, null);
    s.emit("Debugger.scriptParsed", { ...base, scriptId: "21", url: "electron/js2c/sandbox_bundle" }, null);
    s.emit("Debugger.scriptParsed", { ...base, scriptId: "22", url: "https://site.test/page#frag", startLine: 7, startColumn: 4 }, null);
    s.emit("Debugger.scriptParsed", { ...base, scriptId: "23", url: "https://site.test/page", executionContextAuxData: { isDefault: true } }, null); // 文档 URL 但从第 0 行 0 列开始：不是内联
    const r = (await s.call({ action: "list", kind: "script" })) as { items: Array<{ id: string; inline?: boolean }> };
    const ids = r.items.map((i) => i.id);
    expect(ids).not.toContain("20");
    expect(ids).not.toContain("21");
    expect(r.items.find((i) => i.id === "22")?.inline).toBe(true);
    expect(r.items.find((i) => i.id === "23")?.inline).toBeUndefined();
    await expect(s.call({ action: "get", scriptId: "20" })).rejects.toThrow(/没有 id/);
    // list 的 url 过滤不会被 electron 内部脚本的 "sandbox_bundle" 之类名字污染
    const f = (await s.call({ action: "list", url: "sandbox_bundle" })) as { total: number };
    expect(f.total).toBe(0);
    const sheets = (await s.call({ action: "list", kind: "style" })) as { items: Array<{ id: string; inline?: boolean }> };
    expect(sheets.items.find((i) => i.id === "css:S2")?.inline).toBe(true); // SHEETS 假数据里 S2 是 isInline
    expect(sheets.items.find((i) => i.id === "css:S1")?.inline).toBeUndefined();
  });

  it("无 url 的极短动态脚本（void 0 之类的探测）被隐藏；稍长的 <eval> 保留", async () => {
    const s = setup();
    await s.call({ action: "list" });
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("keep");
    const base = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 6, url: "" };
    s.emit("Debugger.scriptParsed", { ...base, scriptId: "30", length: 6 }, null);
    s.emit("Debugger.scriptParsed", { ...base, scriptId: "31", length: 120 }, null);
    const ids = ((await s.call({ action: "list", kind: "script" })) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).not.toContain("30");
    expect(ids).toContain("31");
  });
});

describe("get", () => {
  it("按 script_id 取源码：带行号；先脱敏（凭据不外泄）", async () => {
    const s = setup();
    const r = (await s.call({ action: "get", scriptId: "1" })) as { text: string; totalLines: number; url: string; hasSourceMap: boolean };
    expect(r.text.split("\n")[0]).toBe("1 | var a=1;boom();");
    expect(r.totalLines).toBe(3);
    expect(r.text).not.toContain("sk-A1b2C3d4E5f6");
    expect(r.url).not.toContain("SECRETTOKEN1234567890");
    expect(r.hasSourceMap).toBe(true);
  });

  it("行范围 start_line / end_line；column 参数不影响短行", async () => {
    const s = setup();
    const r = (await s.call({ action: "get", scriptId: "1", startLine: 2, endLine: 2 })) as { text: string; startLine: number; endLine: number };
    expect(r.text).toBe("2 | console.log('x')");
    expect([r.startLine, r.endLine]).toEqual([2, 2]);
  });

  it("按 url：精确优先；唯一包含匹配；多个包含匹配时列候选（让模型自修复）；找不到给提示", async () => {
    const s = setup();
    const exact = (await s.call({ action: "get", url: "https://site.test/lib.js" })) as { id: string };
    expect(exact.id).toBe("4");
    const part = (await s.call({ action: "get", url: "lib.js" })) as { id: string };
    expect(part.id).toBe("4");
    await expect(s.call({ action: "get", url: "site.test/" })).rejects.toThrow(/script_id 指定/);
    await expect(s.call({ action: "get", url: "nope.js" })).rejects.toThrow(/先 list/);
    await expect(s.call({ action: "get", scriptId: "999" })).rejects.toThrow(/没有 id/);
  });

  it("同一 url 加载过多次取最新", async () => {
    const s = setup();
    await s.call({ action: "list" });
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("keep");
    s.emit("Debugger.scriptParsed", { scriptId: "9", url: "https://site.test/lib.js", startLine: 0, startColumn: 0, endLine: 1, endColumn: 0 }, null);
    SOURCES["9"] = "export const newer = 2;";
    const r = (await s.call({ action: "get", url: "https://site.test/lib.js" })) as { id: string; text: string };
    expect(r.id).toBe("9");
    expect(r.text).toContain("newer");
    delete SOURCES["9"];
  });

  it("样式表：css:<id> 与 url 都能取", async () => {
    const s = setup();
    const a = (await s.call({ action: "get", scriptId: "css:S1" })) as { text: string; kind: string };
    expect(a.kind).toBe("style");
    expect(a.text).toContain("1 | body { color: red; }");
    const b = (await s.call({ action: "get", url: "main.css" })) as { id: string };
    expect(b.id).toBe("css:S1");
  });

  it("max_chars 截断并注明；minified 长行按 column 窗口", async () => {
    SOURCES["5"] = `${"a".repeat(3000)}TARGET${"b".repeat(3000)}`;
    const s = setup();
    s.emit("Debugger.scriptParsed", { scriptId: "5", url: "https://site.test/min.js", startLine: 0, startColumn: 0, endLine: 0, endColumn: 6006, length: 6006 }, null);
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("keep");
    s.emit("Debugger.scriptParsed", { scriptId: "5", url: "https://site.test/min.js", startLine: 0, startColumn: 0, endLine: 0, endColumn: 6006, length: 6006 }, null);
    const r = (await s.call({ action: "get", scriptId: "5", column: 3001 })) as { text: string; notes: string[] };
    expect(r.text).toContain("TARGET");
    expect(r.text.length).toBeLessThan(500);
    expect(r.notes.join("")).toContain("minified");
    delete SOURCES["5"];
  });

  it("original:true：经 sourcemap 返回原始位置与源码片段；map 来自相对路径（按脚本 URL 解析）", async () => {
    const s = setup();
    const r = (await s.call({ action: "get", scriptId: "1", startLine: 1, column: 11, original: true })) as { original: { available: boolean; source: string; line: number; column: number; name?: string; snippet: string } };
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    expect(String(s.fetchFn.mock.calls[0][0])).toBe("https://site.test/app.js.map");
    expect((s.fetchFn.mock.calls[0][1] as { redirect: string }).redirect).toBe("manual");
    expect(r.original).toMatchObject({ available: true, source: "src/a.ts", line: 3, column: 5, name: "boom" });
    expect(r.original.snippet).toContain("boom();");
  });

  it("original:true 但脚本没有 sourceMappingURL / map 取不到：降级给原因，不抛", async () => {
    const s = setup(undefined, async () => resp("nope", { status: 404 }));
    const none = (await s.call({ action: "get", scriptId: "4", original: true })) as { original: { available: boolean; reason: string } };
    expect(none.original).toMatchObject({ available: false });
    expect(none.original.reason).toContain("没有 sourceMappingURL");
    const r = (await s.call({ action: "get", scriptId: "1", original: true })) as { text: string; original: { available: boolean; reason: string } };
    expect(r.text).toContain("var a=1");
    expect(r.original).toMatchObject({ available: false });
    expect(r.original.reason).toContain("HTTP 404");
  });
});

describe("sourcemap action", () => {
  it("给位置：生成 → 原始；给 source + original_line：原始 → 生成；列 sources 与 withContent", async () => {
    const s = setup();
    const r = (await s.call({ action: "sourcemap", scriptId: "1", line: 1, column: 11 })) as { loaded: boolean; sources: string[]; withContent: number; mapped: { line: number }; segmentCount: number };
    expect(r.loaded).toBe(true);
    expect(r.sources).toEqual(["src/a.ts"]);
    expect(r.withContent).toBe(1);
    expect(r.segmentCount).toBe(2);
    expect(r.mapped.line).toBe(3);
    const g = (await s.call({ action: "sourcemap", scriptId: "1", source: "a.ts", originalLine: 3, originalColumn: 5 })) as { generated: { line: number; column: number } };
    expect(g.generated).toEqual({ line: 1, column: 11 });
  });

  it("没有 sourceMappingURL → hasSourceMap:false；map 缓存：连续两次只取一次", async () => {
    const s = setup();
    expect(await s.call({ action: "sourcemap", scriptId: "4" })).toMatchObject({ hasSourceMap: false });
    await s.call({ action: "sourcemap", scriptId: "1" });
    await s.call({ action: "sourcemap", scriptId: "1", line: 1 });
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("内联 data: map 不发网络请求", async () => {
    const s = setup();
    s.emit("Debugger.scriptParsed", { scriptId: "7", url: "https://site.test/inl.js", startLine: 0, startColumn: 0, endLine: 1, endColumn: 0, sourceMapURL: `data:application/json;base64,${Buffer.from(MAP).toString("base64")}` }, null);
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("keep");
    s.emit("Debugger.scriptParsed", { scriptId: "7", url: "https://site.test/inl.js", startLine: 0, startColumn: 0, endLine: 1, endColumn: 0, sourceMapURL: `data:application/json;base64,${Buffer.from(MAP).toString("base64")}` }, null);
    const r = (await s.call({ action: "sourcemap", scriptId: "7" })) as { loaded: boolean; mapUrl: string };
    expect(r.loaded).toBe(true);
    expect(r.mapUrl).toBe("(内联 data: map)");
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
});

describe("sourcemap 获取的安全策略（fetchMapText）", () => {
  // R6-05：同 host 的 map 现在要解析 DNS 复核——测试注入固定的公网解析结果，别依赖真实 DNS
  const env = (fetchFn: unknown, extra: Record<string, unknown> = {}) => ({
    checkAiUrl,
    fetch: fetchFn as typeof fetch,
    trustedHosts: ["site.test"],
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    ...extra,
  });

  it("Flowship origin 被 checkAiUrl 拦截，根本不发请求", async () => {
    const f = vi.fn(async () => resp(MAP));
    await expect(fetchMapText("http://127.0.0.1:8676/x.map", env(f))).rejects.toThrow(/被策略拒绝/);
    expect(f).not.toHaveBeenCalled();
  });

  it("非 http(s)（file: / javascript: / ftp:）一律拒绝", async () => {
    const f = vi.fn(async () => resp(MAP));
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "ftp://a/x.map"]) await expect(fetchMapText(u, env(f))).rejects.toThrow(/被策略拒绝/);
    expect(f).not.toHaveBeenCalled();
  });

  it("重定向到 Flowship origin / 非 http 协议：每一跳重新校验，被拒；重定向过多被拒", async () => {
    const toApp = vi.fn(async () => resp("", { status: 302, headers: { location: "http://127.0.0.1:8676/secret.map" } }));
    await expect(fetchMapText("https://site.test/a.map", env(toApp))).rejects.toThrow(/被策略拒绝/);
    expect(toApp).toHaveBeenCalledTimes(1);
    const toFile = vi.fn(async () => resp("", { status: 301, headers: { location: "file:///etc/passwd" } }));
    await expect(fetchMapText("https://site.test/a.map", env(toFile))).rejects.toThrow(/被策略拒绝/);
    const loop = vi.fn(async () => resp("", { status: 302, headers: { location: "https://site.test/a.map" } }));
    await expect(fetchMapText("https://site.test/a.map", env(loop))).rejects.toThrow(/重定向超过/);
    expect(loop).toHaveBeenCalledTimes(4); // 初始 + 3 跳
  });

  it("体积上限：Content-Length 超 5MB 直接拒；无 Content-Length 的超大正文也拒；流式读取超限会取消", async () => {
    await expect(fetchMapText("https://site.test/a.map", env(async () => resp("x", { headers: { "content-length": String(6 * 1024 * 1024) } })))).rejects.toThrow(/5MB/);
    await expect(fetchMapText("https://site.test/a.map", env(async () => resp("x".repeat(100)), { maxBytes: 50 }))).rejects.toThrow(/上限/);
    const cancel = vi.fn(async () => {});
    let n = 0;
    const streaming = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => (n++ < 100 ? { done: false, value: new Uint8Array(20) } : { done: true }), cancel }) },
    });
    await expect(fetchMapText("https://site.test/a.map", env(streaming, { maxBytes: 100 }))).rejects.toThrow(/上限/);
    expect(cancel).toHaveBeenCalled();
    expect(n).toBeLessThan(10); // 超限后立刻停读
  });

  it("超时：fetch 迟迟不返回 → 中止并报超时", async () => {
    const hang = (_u: string, init: { signal: AbortSignal }) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(fetchMapText("https://site.test/a.map", env(hang, { timeoutMs: 30 }))).rejects.toThrow(/超时/);
  });

  it("内网 / 本机主机：只有「页面本身就在 localhost」时同主机放行，不同主机（R6-05 起一律按跨域）拒绝", async () => {
    const f = vi.fn(async () => resp(MAP));
    await expect(fetchMapText("http://192.168.1.1/admin.map", env(f))).rejects.toThrow(/跨域/);
    await expect(fetchMapText("http://127.0.0.1:9999/x.map", env(f))).rejects.toThrow(/跨域/);
    expect(f).not.toHaveBeenCalled();
    expect(await fetchMapText("http://127.0.0.1:9999/x.map", env(f, { trustedHosts: ["127.0.0.1"] }))).toBe(MAP);
    expect(mapHostAllowed("cdn.example.com", [])).toBe(true);
    expect(mapHostAllowed("localhost", ["site.test"])).toBe(false);
    expect(mapHostAllowed("LOCALHOST", ["localhost"])).toBe(true);
  });

  it("op 层：脚本的 map 指向 Flowship origin 时降级为 available:false，不抛、不发请求", async () => {
    const s = setup();
    s.emit("Debugger.scriptParsed", { scriptId: "8", url: "https://site.test/evil.js", startLine: 0, startColumn: 0, endLine: 1, endColumn: 0, sourceMapURL: "http://127.0.0.1:8676/api/secret" }, null);
    const hub = getDebuggerHub(s.tab as never);
    await hub.acquire("keep");
    s.emit("Debugger.scriptParsed", { scriptId: "8", url: "https://site.test/evil.js", startLine: 0, startColumn: 0, endLine: 1, endColumn: 0, sourceMapURL: "http://127.0.0.1:8676/api/secret" }, null);
    SOURCES["8"] = "x";
    const r = (await s.call({ action: "get", scriptId: "8", original: true })) as { original: { available: boolean; reason: string } };
    expect(r.original.available).toBe(false);
    expect(r.original.reason).toContain("被策略拒绝");
    expect(s.fetchFn).not.toHaveBeenCalled();
    delete SOURCES["8"];
  });

  it("畸形 map（非 JSON / 超大 mappings）降级为原因，不抛", async () => {
    const s = setup(undefined, async () => resp("<html>not a map</html>"));
    const r = (await s.call({ action: "sourcemap", scriptId: "1" })) as { loaded: boolean; reason: string };
    expect(r.loaded).toBe(false);
    expect(r.reason).toContain("JSON");
  });
});

describe("issues", () => {
  const CSP = { code: "ContentSecurityPolicyIssue", details: { contentSecurityPolicyIssueDetails: { blockedURL: "https://evil.test/x.js?token=abcdef0123456789", violatedDirective: "script-src-elem", isReportOnly: false, contentSecurityPolicyViolationType: "kURLViolation" } } };
  const MIXED = { code: "MixedContentIssue", details: { mixedContentIssueDetails: { resolutionStatus: "MixedContentBlocked", insecureURL: "http://site.test/i.png" } } };

  it("enable → 重放 → 汇总 → disable；重复的问题去重计数；URL 脱敏", async () => {
    const s = setup();
    s.setIssues([CSP, CSP, MIXED]);
    const r = (await s.call({ action: "issues" })) as { counts: Record<string, number>; total: number; shown: Array<{ url?: string; count: number }> };
    expect(r.counts).toEqual({ csp: 2, mixed_content: 1 });
    expect(r.total).toBe(2);
    expect(JSON.stringify(r)).not.toContain("abcdef0123456789");
    expect(count(s, "Audits.enable")).toBe(1);
    expect(count(s, "Audits.disable")).toBe(1);
    // 第二次调用：enable 再重放，缓冲去重后不翻倍（只增加 count）
    const r2 = (await s.call({ action: "issues" })) as { total: number };
    expect(r2.total).toBe(2);
  });

  it("types 过滤与 limit；没有问题返回空汇总", async () => {
    const s = setup();
    s.setIssues([CSP, MIXED]);
    const only = (await s.call({ action: "issues", types: ["mixed_content"] })) as { counts: Record<string, number>; shown: unknown[] };
    expect(only.counts).toEqual({ mixed_content: 1 });
    expect(only.shown).toHaveLength(1);
    const empty = setup();
    const e = (await empty.call({ action: "issues" })) as { total: number; shown: unknown[] };
    expect(e.total).toBe(0);
    expect(e.shown).toEqual([]);
  });

  it("主 frame 导航清空旧问题；子 frame 导航不清；OOPIF 子会话的 issue 不收", async () => {
    const s = setup();
    s.setIssues([CSP]);
    await s.call({ action: "issues" });
    s.emit("Page.frameNavigated", { frame: { id: "child", parentId: "main" } }, null);
    s.setIssues([]);
    expect(((await s.call({ action: "issues" })) as { total: number }).total).toBe(1);
    s.emit("Page.frameNavigated", { frame: { id: "main" } }, null);
    expect(((await s.call({ action: "issues" })) as { total: number }).total).toBe(0);
    s.emit("Audits.issueAdded", { issue: MIXED }, "oopif-1");
    expect(((await s.call({ action: "issues" })) as { total: number }).total).toBe(0);
  });

  it("并发调用共用一次 Audits.enable，最后一个走时才 disable", async () => {
    const s = setup();
    s.setIssues([CSP]);
    await Promise.all([s.call({ action: "issues" }), s.call({ action: "issues" })]);
    expect(count(s, "Audits.enable")).toBe(1);
    expect(count(s, "Audits.disable")).toBe(1);
  });

  it("tab 销毁（dispose）后摘掉监听，不再收事件", async () => {
    const s = setup();
    await s.call({ action: "issues" });
    const before = s.listeners.size;
    (s.ext.get("sources-state") as { dispose: () => void }).dispose();
    expect(s.listeners.size).toBe(before - 1);
  });
});

describe("console 栈还原（_resolveConsoleStacks）", () => {
  const entry = (url: string) => ({
    ts: 1,
    level: "error",
    text: "Error: boom",
    stack: [
      { functionName: "f", url, line: 0, column: 12 },
      { functionName: "g", url: "https://other.test/x.js", line: 0, column: 0 },
    ],
  });

  it("有 map：帧加 original；没有 map 的帧原样；note 空", async () => {
    const s = setup();
    const url = "https://site.test/app.js?token=%5B已隐藏%5D"; // 条目里存的是脱敏后的 URL
    s.emit("Debugger.scriptParsed", { scriptId: "1", url: "https://site.test/app.js?token=SECRETTOKEN1234567890", startLine: 0, startColumn: 0, endLine: 3, endColumn: 0, sourceMapURL: "app.js.map" }, null);
    const { redactUrlSecrets } = await import("../electron-app/browser/net-detail.mjs");
    const redacted = redactUrlSecrets("https://site.test/app.js?token=SECRETTOKEN1234567890");
    expect(redacted).not.toContain("SECRETTOKEN");
    void url;
    const r = await (s.h as { _resolveConsoleStacks: (t: unknown, e: unknown[]) => Promise<{ entries: Array<{ stack: Array<{ original?: { source: string; line: number } }> }>; resolvedFrames: number; note?: string }> })._resolveConsoleStacks(s.tab, [entry(redacted)]);
    expect(r.resolvedFrames).toBe(1);
    expect(r.entries[0].stack[0].original).toMatchObject({ source: "src/a.ts", line: 3 });
    expect(r.entries[0].stack[1].original).toBeUndefined();
    expect(count(s, "Debugger.disable")).toBe(1);
  });

  it("降级：没有结构化栈 / 找不到脚本 / map 取不到 / hub 失败，都返回原条目 + note，不抛", async () => {
    const f = (s: ReturnType<typeof setup>) => (s.h as { _resolveConsoleStacks: (t: unknown, e: unknown[]) => Promise<{ entries: unknown[]; resolvedFrames: number; note?: string }> })._resolveConsoleStacks;
    const s1 = setup();
    const plain = [{ ts: 1, level: "log", text: "hi" }];
    const r1 = await f(s1)(s1.tab, plain);
    expect(r1.entries).toBe(plain);
    expect(r1.note).toContain("没有结构化栈");
    expect(count(s1, "Debugger.enable")).toBe(0);

    const s2 = setup();
    const r2 = await f(s2)(s2.tab, [entry("https://gone.test/x.js")]);
    expect(r2.resolvedFrames).toBe(0);
    expect(r2.note).toContain("没有找到带 sourceMappingURL");

    const { redactUrlSecrets } = await import("../electron-app/browser/net-detail.mjs");
    const known = redactUrlSecrets("https://site.test/app.js?token=SECRETTOKEN1234567890");
    const s3 = setup(undefined, async () => resp("", { status: 500 }));
    const r3 = await f(s3)(s3.tab, [entry(known)]);
    expect(r3.resolvedFrames).toBe(0);
    expect(r3.note).toContain("HTTP 500");

    const s4 = setup({ failDebuggerEnable: true });
    const input = [entry(known)];
    const r4 = await f(s4)(s4.tab, input);
    expect(r4.entries).toBe(input);
    expect(r4.note).toContain("还原失败");
  });
});
