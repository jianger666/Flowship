/**
 * CSP 违规收集的纯逻辑（src/lib/server/csp-report.ts）。
 *
 * 回归点：
 * - 两种报文（旧式 application/csp-report / reports+json 数组）都能解析；畸形一律静默
 * - 记录里不能出现 query / hash（token 会泄露进日志）、userinfo、控制字符（伪造日志行）
 * - 体积、条数、去重表都有硬上限，不会被灌爆内存 / 日志
 */
import { describe, expect, it, vi } from "vitest";

import {
  CSP_REPORT_WARN_EVERY,
  MAX_CSP_REPORTS_PER_BODY,
  MAX_CSP_REPORT_BODY_BYTES,
  MAX_CSP_URL_LENGTH,
  createCspReportStore,
  createWindowLimiter,
  handleCspReportPost,
  ingestCspReportText,
  parseCspReports,
  readBodyTextCapped,
  type CspViolation,
} from "../src/lib/server/csp-report";

const legacy = (body: Record<string, unknown>): string =>
  JSON.stringify({ "csp-report": body });

const viol = (over: Partial<CspViolation> = {}): CspViolation => ({
  directive: "img-src",
  blockedUri: "http://cdn.example.com/a.png",
  blockedKey: "http://cdn.example.com",
  documentUri: "http://127.0.0.1:8876/tasks/t_1",
  ...over,
});

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

describe("parseCspReports：旧式 application/csp-report", () => {
  it("提取白名单字段，directive 优先取 effective-directive", () => {
    const out = parseCspReports(
      legacy({
        "document-uri": "http://127.0.0.1:8876/tasks/t_1",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://evil.example.com/x.js",
        "source-file": "http://127.0.0.1:8876/_next/static/a.js",
        "line-number": 42,
        "original-policy": "default-src 'self'; report-uri /api/csp-report",
        referrer: "http://secret.example/",
      }),
    );
    expect(out).toEqual([
      {
        directive: "script-src-elem",
        blockedUri: "https://evil.example.com/x.js",
        blockedKey: "https://evil.example.com",
        documentUri: "http://127.0.0.1:8876/tasks/t_1",
        sourceFile: "http://127.0.0.1:8876/_next/static/a.js",
        lineNumber: 42,
      },
    ]);
    // original-policy / referrer 等非白名单字段一律不进结果
    expect(JSON.stringify(out)).not.toContain("secret.example");
    expect(JSON.stringify(out)).not.toContain("original-policy");
  });

  it("老 Chromium 的 violated-directive 带整条指令值：只取第一个 token", () => {
    const [v] = parseCspReports(
      legacy({
        "violated-directive": "img-src 'self' data: blob: https:",
        "blocked-uri": "http://insecure.example.com/a.png",
        "document-uri": "http://127.0.0.1:8876/",
      }),
    );
    expect(v?.directive).toBe("img-src");
  });

  it("inline / eval / data: / blob: 这类类型值：key 是类型而不是 origin", () => {
    const f = (blocked: string) =>
      parseCspReports(
        legacy({ "effective-directive": "script-src", "blocked-uri": blocked }),
      )[0];
    expect(f("inline")).toMatchObject({ blockedUri: "inline", blockedKey: "inline" });
    expect(f("eval")).toMatchObject({ blockedKey: "eval" });
    expect(f("")).toMatchObject({ blockedUri: "", blockedKey: "(none)" });
    // data: / blob: / javascript: 的「正文」可能很大或含内联内容，只留 scheme
    expect(f("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toMatchObject({
      blockedUri: "data:",
      blockedKey: "data:",
    });
    expect(f("blob:http://127.0.0.1:8876/3f2a-uuid")).toMatchObject({
      blockedUri: "blob:",
      blockedKey: "blob:",
    });
    expect(f("javascript:alert(document.cookie)")).toMatchObject({
      blockedKey: "javascript:",
    });
  });

  it("没有可识别的指令名 / 指令名形态非法 → 不是 CSP 报告，丢弃", () => {
    expect(parseCspReports(legacy({ "blocked-uri": "https://a.com/" }))).toEqual([]);
    expect(
      parseCspReports(legacy({ "effective-directive": "<script>alert(1)</script>" })),
    ).toEqual([]);
    expect(parseCspReports(legacy({ "effective-directive": 123 }))).toEqual([]);
  });
});

describe("parseCspReports：application/reports+json", () => {
  const report = (body: Record<string, unknown>, type = "csp-violation") => ({
    type,
    age: 10,
    url: "http://127.0.0.1:8876/tasks/t_1?token=abc",
    user_agent: "Mozilla/5.0",
    body,
  });

  it("数组：只收 type=csp-violation，驼峰字段也能取", () => {
    const text = JSON.stringify([
      report({
        documentURL: "http://127.0.0.1:8876/settings",
        blockedURL: "https://img.example.com/a.png",
        effectiveDirective: "img-src",
        sourceFile: "http://127.0.0.1:8876/_next/static/b.js",
        lineNumber: 7,
        disposition: "report",
      }),
      report({ id: "x", message: "old API" }, "deprecation"),
      report({ effectiveDirective: "frame-src", blockedURL: "about" }),
    ]);
    const out = parseCspReports(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      directive: "img-src",
      blockedUri: "https://img.example.com/a.png",
      blockedKey: "https://img.example.com",
      documentUri: "http://127.0.0.1:8876/settings",
      sourceFile: "http://127.0.0.1:8876/_next/static/b.js",
      lineNumber: 7,
    });
    expect(out[1]?.directive).toBe("frame-src");
  });

  it("单个对象（非数组）的 reports+json 也接住", () => {
    const out = parseCspReports(
      JSON.stringify(report({ effectiveDirective: "style-src", blockedURL: "inline" })),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ directive: "style-src", blockedKey: "inline" });
  });

  it("没有 body 或 body 不是对象 → 忽略", () => {
    expect(
      parseCspReports(JSON.stringify([{ type: "csp-violation" }, { type: "csp-violation", body: 1 }])),
    ).toEqual([]);
  });

  it("单个请求体最多处理 MAX_CSP_REPORTS_PER_BODY 条", () => {
    const many = Array.from({ length: MAX_CSP_REPORTS_PER_BODY + 30 }, (_, i) =>
      report({ effectiveDirective: "img-src", blockedURL: `https://h${i}.example.com/` }),
    );
    expect(parseCspReports(JSON.stringify(many))).toHaveLength(MAX_CSP_REPORTS_PER_BODY);
  });
});

describe("parseCspReports：脱敏 / 截断 / 畸形", () => {
  it("URL 一律去掉 query 和 hash（blocked / document / source-file 三处）", () => {
    const out = parseCspReports(
      legacy({
        "effective-directive": "connect-src",
        "blocked-uri": "https://api.example.com/v1/x?token=SECRET_BLOCKED#frag-secret",
        "document-uri": "http://127.0.0.1:8876/tasks/t_1?code=SECRET_DOC&state=s",
        "source-file": "http://127.0.0.1:8876/_next/a.js?v=SECRET_SRC#h",
      }),
    );
    const text = JSON.stringify(out);
    for (const s of ["SECRET_BLOCKED", "SECRET_DOC", "SECRET_SRC", "frag-secret", "token=", "code="]) {
      expect(text).not.toContain(s);
    }
    expect(out[0]).toMatchObject({
      blockedUri: "https://api.example.com/v1/x",
      documentUri: "http://127.0.0.1:8876/tasks/t_1",
      sourceFile: "http://127.0.0.1:8876/_next/a.js",
    });
  });

  it("URL 里的 userinfo（user:pass@）不进记录", () => {
    const [v] = parseCspReports(
      legacy({
        "effective-directive": "img-src",
        "blocked-uri": "https://user:p4ssw0rd@img.example.com/a.png",
      }),
    );
    expect(JSON.stringify(v)).not.toContain("p4ssw0rd");
    expect(v?.blockedKey).toBe("https://img.example.com");
  });

  it("解析不了的 URL：手工从 ? / # 处截断，key 归为 other", () => {
    const [v] = parseCspReports(
      legacy({
        "effective-directive": "img-src",
        "blocked-uri": "not a url/with path?token=SECRET#h",
      }),
    );
    expect(JSON.stringify(v)).not.toContain("SECRET");
    expect(v).toMatchObject({ blockedUri: "not a url/with path", blockedKey: "other" });
  });

  it("超长 URL 被截断（MAX_CSP_URL_LENGTH + 省略号）", () => {
    const long = `https://a.example.com/${"x".repeat(5000)}`;
    const [v] = parseCspReports(
      legacy({ "effective-directive": "img-src", "blocked-uri": long }),
    );
    expect(v?.blockedUri.length).toBe(MAX_CSP_URL_LENGTH + 1);
    expect(v?.blockedUri.endsWith("…")).toBe(true);
    expect(v?.blockedKey).toBe("https://a.example.com");
  });

  it("控制字符 / 换行 / Unicode 行分隔符被剔除（防伪造日志行）", () => {
    const [v] = parseCspReports(
      legacy({
        "effective-directive": "img-src",
        "blocked-uri": "bad uri\n[csp-report] 伪造的一行\r\u2028\u0007",
        "document-uri": "http://127.0.0.1:8876/a\nb",
        "source-file": "not a url\n[csp-report] x",
      }),
    );
    const strings = [v?.blockedUri, v?.documentUri, v?.sourceFile].filter(
      (s): s is string => typeof s === "string",
    );
    expect(strings.length).toBeGreaterThan(0);
    // 用 includes 逐个查而不是正则：控制字符进正则字面量会触发 eslint no-control-regex
    for (const s of strings) {
      for (const ch of ["\n", "\r", "\u2028", "\u2029", "\u0007"]) {
        expect(s.includes(ch)).toBe(false);
      }
    }
  });

  it("line-number：非数字 / 负数 / NaN 省略，小数取整，过大截到上限", () => {
    const f = (line: unknown) =>
      parseCspReports(legacy({ "effective-directive": "img-src", "line-number": line }))[0]
        ?.lineNumber;
    expect(f("12")).toBeUndefined();
    expect(f(-1)).toBeUndefined();
    expect(f(null)).toBeUndefined();
    expect(f(12.9)).toBe(12);
    expect(f(0)).toBe(0);
    expect(f(1e15)).toBe(10_000_000);
  });

  it("畸形 JSON / 非对象 / 垃圾 → 空数组，不抛", () => {
    for (const text of ["", "{", "not json", "null", "123", '"str"', "[]", "{}", "[1,2,3]", '{"csp-report":"x"}']) {
      expect(() => parseCspReports(text)).not.toThrow();
      expect(parseCspReports(text)).toEqual([]);
    }
  });
});

describe("createCspReportStore：去重 / 计数 / 日志节奏", () => {
  it("同 (directive, blockedKey) 聚合：首次打一行带现场，之后不打", () => {
    const warn = vi.fn();
    const store = createCspReportStore({ warn });
    expect(store.record(viol({ sourceFile: "http://127.0.0.1:8876/a.js", lineNumber: 3 }))).toBe("new");
    // 同 origin 不同 path 仍是同一 key（按 origin 聚合）
    expect(store.record(viol({ blockedUri: "http://cdn.example.com/b.png" }))).toBe("counted");
    expect(store.record(viol())).toBe("counted");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line.startsWith("[csp-report]")).toBe(true);
    expect(line).toContain("directive=img-src");
    expect(line).toContain("blocked=http://cdn.example.com/a.png");
    expect(line).toContain("src=http://127.0.0.1:8876/a.js:3");
    expect(line).not.toContain("\n");
    const snap = store.snapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toMatchObject({ count: 3, directive: "img-src" });
  });

  it("不同 directive 或不同 origin 是不同 key", () => {
    const store = createCspReportStore({ warn: () => {} });
    store.record(viol());
    store.record(viol({ directive: "connect-src" }));
    store.record(viol({ blockedKey: "https://other.example.com", blockedUri: "https://other.example.com/x" }));
    expect(store.snapshot().entries).toHaveLength(3);
  });

  it("每累计 N 次再提示一次（N=50 的整数倍），中间不打", () => {
    const warn = vi.fn();
    const store = createCspReportStore({ warn });
    for (let i = 0; i < CSP_REPORT_WARN_EVERY * 2; i += 1) store.record(viol());
    // 1 次首次 + 第 50、100 次各一行汇总
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[1]?.[0])).toContain(`累计 ${CSP_REPORT_WARN_EVERY} 次`);
    expect(String(warn.mock.calls[2]?.[0])).toContain(`累计 ${CSP_REPORT_WARN_EVERY * 2} 次`);
  });

  it("Map 上限生效：满了停止新增（不淘汰旧的），已有 key 继续计数，丢弃数可见", () => {
    const warn = vi.fn();
    const store = createCspReportStore({ maxEntries: 3, warnEvery: 5, warn });
    const k = (i: number) =>
      viol({ blockedKey: `https://h${i}.example.com`, blockedUri: `https://h${i}.example.com/` });
    expect(store.record(k(1))).toBe("new");
    expect(store.record(k(2))).toBe("new");
    expect(store.record(k(3))).toBe("new");
    expect(store.record(k(4))).toBe("dropped");
    expect(store.record(k(5))).toBe("dropped");
    // 已有 key 不受影响，仍然累计
    expect(store.record(k(1))).toBe("counted");

    const snap = store.snapshot();
    expect(snap.entries.map((e) => e.blockedKey)).toEqual([
      "https://h1.example.com",
      "https://h2.example.com",
      "https://h3.example.com",
    ]);
    expect(snap.entries[0]?.count).toBe(2);
    expect(snap.dropped).toBe(2);

    // 日志：3 条首次 + 第 1 次丢弃提示一行；第 2 次丢弃不重复打（warnEvery=5）
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("首次违规"))).toHaveLength(3);
    expect(lines.filter((l) => l.includes("去重表已满"))).toHaveLength(1);
  });

  it("灌入大量不同 key：条目数与日志行数都有上限", () => {
    const warn = vi.fn();
    const store = createCspReportStore({ maxEntries: 200, warnEvery: 50, warn });
    for (let i = 0; i < 5000; i += 1) {
      store.record(
        viol({ blockedKey: `https://h${i}.example.com`, blockedUri: `https://h${i}.example.com/` }),
      );
    }
    const snap = store.snapshot();
    expect(snap.entries).toHaveLength(200);
    expect(snap.dropped).toBe(4800);
    // 200 条首次 + 丢弃提示（第 1 次 + 每 50 次一行 = 1 + 96）——远小于 5000
    expect(warn.mock.calls.length).toBe(200 + 1 + 4800 / 50);
  });

  it("reset 清空条目与丢弃计数", () => {
    const store = createCspReportStore({ maxEntries: 1, warn: () => {} });
    store.record(viol());
    store.record(viol({ directive: "frame-src" }));
    store.reset();
    expect(store.snapshot()).toEqual({ entries: [], dropped: 0 });
  });
});

describe("ingestCspReportText", () => {
  it("返回识别条数并入库；畸形文本返回 0", () => {
    const store = createCspReportStore({ warn: () => {} });
    expect(
      ingestCspReportText(
        legacy({ "effective-directive": "img-src", "blocked-uri": "https://a.com/x.png" }),
        store,
      ),
    ).toBe(1);
    expect(ingestCspReportText("{oops", store)).toBe(0);
    expect(store.snapshot().entries).toHaveLength(1);
  });

  it("store.record 抛错也不外泄", () => {
    const store = createCspReportStore({
      warn: () => {
        throw new Error("log sink down");
      },
    });
    expect(() =>
      ingestCspReportText(legacy({ "effective-directive": "img-src" }), store),
    ).not.toThrow();
  });
});

describe("readBodyTextCapped：限制体积", () => {
  const enc = new TextEncoder();

  it("null body → 空文本", async () => {
    expect(await readBodyTextCapped({ body: null })).toEqual({ ok: true, text: "" });
  });

  it("恰好等于上限放行，多 1 字节拒绝", async () => {
    const ok = await readBodyTextCapped({ body: streamOf(enc.encode("a".repeat(100))) }, 100);
    expect(ok.ok).toBe(true);
    const big = await readBodyTextCapped({ body: streamOf(enc.encode("a".repeat(101))) }, 100);
    expect(big).toEqual({ ok: false, reason: "too-large" });
  });

  it("默认上限是 16KB", async () => {
    expect(MAX_CSP_REPORT_BODY_BYTES).toBe(16 * 1024);
    const big = await readBodyTextCapped({
      body: streamOf(enc.encode("a".repeat(MAX_CSP_REPORT_BODY_BYTES + 1))),
    });
    expect(big.ok).toBe(false);
  });

  it("分多个 chunk 累计超限：读到超限就停并 cancel，不读完整个流", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(enc.encode("a".repeat(40)));
        if (pulled > 1000) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await readBodyTextCapped({ body }, 100);
    expect(r).toEqual({ ok: false, reason: "too-large" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("多字节字符被切在两个 chunk 之间也能正确还原", async () => {
    const bytes = enc.encode("违规报告");
    const r = await readBodyTextCapped({
      body: streamOf(bytes.slice(0, 4), bytes.slice(4)),
    });
    expect(r).toEqual({ ok: true, text: "违规报告" });
  });

  it("流读取报错 → unreadable，不抛", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    expect(await readBodyTextCapped({ body })).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("createWindowLimiter", () => {
  it("窗口内超额拒绝、拒绝不占名额、过窗口重置", () => {
    const lim = createWindowLimiter({ max: 2, windowMs: 1000 });
    expect(lim.allow(0)).toBe(true);
    expect(lim.allow(10)).toBe(true);
    expect(lim.allow(20)).toBe(false);
    expect(lim.allow(999)).toBe(false);
    expect(lim.allow(1000)).toBe(true);
    expect(lim.allow(1001)).toBe(true);
    expect(lim.allow(1002)).toBe(false);
  });
});

describe("handleCspReportPost", () => {
  const mkDeps = (over: { allow?: boolean; maxBodyBytes?: number } = {}) => {
    const store = createCspReportStore({ warn: () => {} });
    return {
      store,
      deps: {
        store,
        limiter: { allow: () => over.allow ?? true },
        now: () => 0,
        maxBodyBytes: over.maxBodyBytes,
      },
    };
  };
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:8876/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report", ...headers },
      body,
    });
  const valid = legacy({ "effective-directive": "img-src", "blocked-uri": "https://a.com/x.png" });

  it("合法报文 → 204 并入库", async () => {
    const { store, deps } = mkDeps();
    expect(await handleCspReportPost(post(valid), deps)).toBe(204);
    expect(store.snapshot().entries).toHaveLength(1);
  });

  it("声明的 Content-Length 超限 → 413，不读体、不入库", async () => {
    const { store, deps } = mkDeps();
    const req = post(valid, { "content-length": String(MAX_CSP_REPORT_BODY_BYTES + 1) });
    expect(await handleCspReportPost(req, deps)).toBe(413);
    expect(store.snapshot().entries).toHaveLength(0);
  });

  it("没有 Content-Length 但实际体积超限 → 413", async () => {
    const { store, deps } = mkDeps({ maxBodyBytes: 64 });
    expect(await handleCspReportPost(post(valid + " ".repeat(200)), deps)).toBe(413);
    expect(store.snapshot().entries).toHaveLength(0);
  });

  it("畸形 JSON / 空体 → 204（静默，不让浏览器重试）", async () => {
    const { store, deps } = mkDeps();
    expect(await handleCspReportPost(post("{oops"), deps)).toBe(204);
    expect(await handleCspReportPost(post(""), deps)).toBe(204);
    expect(store.snapshot().entries).toHaveLength(0);
  });

  it("被限频 → 204 且不解析不入库", async () => {
    const { store, deps } = mkDeps({ allow: false });
    expect(await handleCspReportPost(post(valid), deps)).toBe(204);
    expect(store.snapshot().entries).toHaveLength(0);
  });
});
