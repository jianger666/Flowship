/**
 * E2·C5 `browser_save` kind=pdf 打印选项：纯函数（electron-app/browser/pdf-options.mjs）、op 接线（ops/read.mjs）、server 工具透传。
 * 重点：页眉页脚模板清洗（不放行脚本 / 外链 / 任意标签）、取值范围、不传选项 = E1 老行为。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeOpArgs } from "../electron-app/browser/index.mjs";
import { createHandlers } from "../electron-app/browser/ops/read.mjs";
import {
  PDF_PAPER_FORMATS,
  PDF_TEMPLATE_MAX,
  buildElectronPdfOptions,
  buildPrintToPdfParams,
  normalizePageRanges,
  parsePdfOptions,
  sanitizePdfTemplate,
} from "../electron-app/browser/pdf-options.mjs";
import { __resetBrowserSettingsForTest } from "../src/lib/server/browser/settings";
import { getBrowserTools } from "../src/lib/server/browser/tools";
import type { FlowshipToolDef, FlowshipToolResult } from "../src/lib/server/flowship-tools";

import { installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

const opts = (args: Record<string, unknown>) => {
  const r = parsePdfOptions(args) as { options?: Record<string, unknown>; error?: string };
  if (r.error) throw new Error(r.error);
  return r.options;
};
const errOf = (args: Record<string, unknown>) => (parsePdfOptions(args) as { error?: string }).error;

describe("sanitizePdfTemplate：只放行纯文字 + 五个官方占位 span", () => {
  it("占位 span 保留并规整（丢掉多余属性 / 大小写混淆）", () => {
    expect(sanitizePdfTemplate('<span class="title"></span>')).toBe('<span class="title"></span>');
    // 带额外属性（style / onclick …）的 span 不放行，整个标签丢弃
    expect(sanitizePdfTemplate("<SPAN CLASS='pageNumber' style='x'>")).toBe("");
    expect(sanitizePdfTemplate('<span class="title" onclick="x()"></span>')).toBe("");
    expect(sanitizePdfTemplate("第 <span class=pageNumber></span> / <span class='totalPages'></span> 页")).toBe(
      '第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页',
    );
    expect(sanitizePdfTemplate('<SPAN CLASS="URL"></SPAN>')).toBe('<span class="url"></span>');
  });

  it("script / style / iframe / svg 连同内容一起删；事件属性、外链图片、其它标签全剥", () => {
    const vectors = [
      '<script>alert(1)</script>正文',
      '<img src="http://evil.test/x.png" onerror="alert(1)">正文',
      '<iframe src="http://evil.test"></iframe>正文',
      '<svg onload="alert(1)"><circle/></svg>正文',
      '<style>body{display:none}</style>正文',
      '<a href="javascript:alert(1)">正文</a>',
      '<div onclick="x()">正文</div>',
      '<link rel="stylesheet" href="http://evil.test/a.css">正文',
      '<SCRIPT>alert(1)</SCRIPT>正文',
      '<scr<script>ipt>alert(1)</scr</script>ipt>正文',
      '<!-- <script>alert(1)</script> -->正文',
    ];
    for (const v of vectors) {
      const out = sanitizePdfTemplate(v);
      expect(out, v).not.toMatch(/<(?!span class="(?:date|title|url|pageNumber|totalPages)"><\/span>)/);
      expect(out, v).not.toMatch(/alert|onerror|onclick|onload|javascript:|evil\.test|display:none/i);
      expect(out, v).toContain("正文");
    }
  });

  it("文字里的 & < > 转成实体（不会拼出新标签）", () => {
    const out = sanitizePdfTemplate("R&D & Q&A, 3 < 5 <<b>x");
    expect(out).not.toContain("<");
    expect(out).toContain("R&amp;D &amp; Q&amp;A");
    expect(out).toContain("&lt;");
  });

  it("未闭合的 <script（后面全是内容）整段删除；超长输入被限长且不卡死", () => {
    expect(sanitizePdfTemplate("前缀<script>alert(1)")).toBe("前缀");
    const huge = "<script ".repeat(200_000);
    const t0 = Date.now();
    const out = sanitizePdfTemplate(huge);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(PDF_TEMPLATE_MAX);
    const many = '<span class="title"></span>'.repeat(5000);
    const t1 = Date.now();
    expect(sanitizePdfTemplate(many).length).toBeLessThanOrEqual(PDF_TEMPLATE_MAX);
    expect(Date.now() - t1).toBeLessThan(500);
  });

  it("非字符串 → 空串", () => {
    expect(sanitizePdfTemplate(undefined)).toBe("");
    expect(sanitizePdfTemplate(123)).toBe("");
  });
});

describe("normalizePageRanges", () => {
  it("合法写法规整（去空白）；非法 / 0 页 / 倒序 / 夹带字符 → null", () => {
    expect(normalizePageRanges("1-3, 5")).toBe("1-3,5");
    expect(normalizePageRanges(" 2 ")).toBe("2");
    expect(normalizePageRanges("8-")).toBe("8-");
    expect(normalizePageRanges("-3")).toBe("-3");
    for (const bad of ["", "0", "0-3", "3-1", "a", "1;2", "1-3,a", "1--3", "1,,2", "1 2", "9".repeat(70), "１-３", null, 5]) {
      expect(normalizePageRanges(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("parsePdfOptions：取值范围真值表", () => {
  it("全空 = options undefined（沿用 E1 行为）", () => {
    expect(parsePdfOptions({})).toEqual({ options: undefined });
    expect(parsePdfOptions({ landscape: null, scale: undefined, header: "" })).toEqual({ options: undefined });
  });

  it("合法值通过并规整（paperFormat 大小写不敏感、margins 只取给出的边）", () => {
    expect(opts({ landscape: true, scale: 0.5, pageRanges: "1-2", paperFormat: "A4", margins: { top: 1, left: 0 }, printBackground: false })).toEqual({
      landscape: true,
      scale: 0.5,
      pageRanges: "1-2",
      paperFormat: "a4",
      margins: { top: 1, left: 0 },
      printBackground: false,
    });
  });

  it("越界 / 类型不对 → error（每一项）", () => {
    expect(errOf({ landscape: "yes" })).toMatch(/landscape/);
    for (const scale of [0, 0.09, 2.01, -1, "1", Number.NaN, Number.POSITIVE_INFINITY]) expect(errOf({ scale }), String(scale)).toMatch(/scale/);
    expect(errOf({ pageRanges: "3-1" })).toMatch(/pageRanges/);
    expect(errOf({ paperFormat: "a7" })).toMatch(/paperFormat/);
    expect(errOf({ margins: [1] })).toMatch(/margins/);
    expect(errOf({ margins: { top: -0.1 } })).toMatch(/margins\.top/);
    expect(errOf({ margins: { bottom: 3.01 } })).toMatch(/margins\.bottom/);
    expect(errOf({ margins: { middle: 1 } })).toMatch(/middle/);
    expect(errOf({ margins: { top: "1" } })).toMatch(/margins\.top/);
    expect(errOf({ printBackground: 1 })).toMatch(/printBackground/);
    expect(errOf({ header: 5 })).toMatch(/header/);
    expect(errOf({ footer: "x".repeat(PDF_TEMPLATE_MAX + 1) })).toMatch(/footer.*过长/);
  });

  it("header / footer 经过清洗；清洗后空也算「给了模板」（显式空模板）", () => {
    expect(opts({ header: '标题 <script>x</script><span class="title"></span>' })!.header).toBe('标题 <span class="title"></span>');
    expect(opts({ header: "<script>x</script>" })!.header).toBe("");
  });
});

describe("buildPrintToPdfParams / buildElectronPdfOptions", () => {
  it("没有选项 = E1 老参数（两个入口都是）", () => {
    expect(buildPrintToPdfParams(undefined)).toEqual({ printBackground: true, preferCSSPageSize: true });
    expect(buildElectronPdfOptions(undefined)).toEqual({ printBackground: true, preferCSSPageSize: true });
  });

  it("只调方向 / 缩放 / 页码：仍尊重页面 @page（preferCSSPageSize 保持 true）", () => {
    const p = buildPrintToPdfParams(opts({ landscape: true, scale: 0.8, pageRanges: "1-2" }));
    expect(p).toMatchObject({ landscape: true, scale: 0.8, pageRanges: "1-2", printBackground: true, preferCSSPageSize: true });
    expect(p).not.toHaveProperty("paperWidth");
  });

  it("给了纸张：英寸宽高 + preferCSSPageSize=false；页边距四边齐全（缺省 0.4）", () => {
    const p = buildPrintToPdfParams(opts({ paperFormat: "a4", margins: { top: 1 } }));
    expect(p).toMatchObject({ paperWidth: 8.27, paperHeight: 11.69, preferCSSPageSize: false, marginTop: 1, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4 });
  });

  it("所有纸张格式都有尺寸", () => {
    for (const f of PDF_PAPER_FORMATS) {
      const p = buildPrintToPdfParams(opts({ paperFormat: f })) as { paperWidth: number; paperHeight: number };
      expect(p.paperWidth).toBeGreaterThan(0);
      expect(p.paperHeight).toBeGreaterThan(p.paperWidth);
    }
  });

  it("只给 header：displayHeaderFooter 开，footer 是显式空模板（避免回落到 Chromium 默认的日期 / 网址）", () => {
    const p = buildPrintToPdfParams(opts({ header: "报告" })) as Record<string, unknown>;
    expect(p.displayHeaderFooter).toBe(true);
    expect(String(p.headerTemplate)).toContain("报告");
    expect(String(p.headerTemplate)).toContain("font-size");
    expect(p.footerTemplate).toBe("<span></span>");
  });

  it("Electron 退路参数语义一致（pageSize / margins 字段名）", () => {
    const e = buildElectronPdfOptions(opts({ paperFormat: "letter", margins: { top: 1, bottom: 1, left: 1, right: 1 }, footer: "第 <span class=pageNumber></span> 页", landscape: false }));
    expect(e).toMatchObject({
      landscape: false,
      pageSize: { width: 8.5, height: 11 },
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
      displayHeaderFooter: true,
      preferCSSPageSize: false,
    });
    expect(String(e.footerTemplate)).toContain('<span class="pageNumber"></span>');
  });
});

describe("op 接线：normalizeOpArgs('save') 与 handler", () => {
  it("E1 的老入参不变（toEqual 不含 pdf 字段）", () => {
    expect(normalizeOpArgs("save", { kind: "pdf" })).toEqual({ kind: "pdf", fullPage: true });
  });

  it("pdf 选项进 args.pdf；非法 → BAD_ARGS；非 pdf kind 带 pdf 选项 → BAD_ARGS", () => {
    expect(normalizeOpArgs("save", { kind: "pdf", landscape: true, pageRanges: "1-2" })).toMatchObject({ kind: "pdf", pdf: { landscape: true, pageRanges: "1-2" } });
    expect(() => normalizeOpArgs("save", { kind: "pdf", scale: 9 })).toThrow(/scale/);
    expect(() => normalizeOpArgs("save", { kind: "html", landscape: true })).toThrow(/只在 kind=pdf/);
    expect(() => normalizeOpArgs("save", { kind: "screenshot", header: "x" })).toThrow(/只在 kind=pdf/);
  });

  const makeEnv = (sendImpl?: (m: string) => unknown) => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "c5-pdf-"));
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const tab = {
      id: "t1",
      url: "https://a.test/",
      title: "页面",
      ensureCdp: async () => {},
      send: vi.fn(async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        const r = sendImpl?.(method);
        if (r !== undefined) return r;
        return {};
      }),
      wc: { printToPDF: vi.fn(async () => Buffer.from("%PDF-fallback")) },
    };
    const session = { getTab: () => tab, activityLog: { addAI: vi.fn() } };
    const handlers = createHandlers({
      requireSession: () => session,
      getConfig: () => ({}),
      abortable: (p: Promise<unknown>) => p,
      scheduleState: vi.fn(),
      app: { getPath: () => downloadsDir },
      now: () => new Date(2026, 10, 9, 9, 0, 0),
      actions: {},
      log: () => {},
    });
    return { handlers, tab, sent, cleanup: () => fs.rmSync(downloadsDir, { recursive: true, force: true }) };
  };
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("save pdf 带选项：Page.printToPDF 收到翻译后的参数；不带选项收到老参数", async () => {
    const e = makeEnv((m) => (m === "Page.printToPDF" ? { data: Buffer.from("%PDF-cdp").toString("base64") } : undefined));
    cleanups.push(e.cleanup);
    await e.handlers.save("task", normalizeOpArgs("save", { kind: "pdf", landscape: true, paperFormat: "a4", header: "<script>x</script>页眉", pageRanges: "1-2" }), undefined);
    const withOpts = e.sent.find((s) => s.method === "Page.printToPDF")!.params;
    expect(withOpts).toMatchObject({ landscape: true, paperWidth: 8.27, pageRanges: "1-2", displayHeaderFooter: true, preferCSSPageSize: false });
    expect(String(withOpts.headerTemplate)).toContain("页眉");
    expect(String(withOpts.headerTemplate)).not.toContain("script");

    e.sent.length = 0;
    await e.handlers.save("task", normalizeOpArgs("save", { kind: "pdf" }), undefined);
    expect(e.sent.find((s) => s.method === "Page.printToPDF")!.params).toEqual({ printBackground: true, preferCSSPageSize: true });
  });

  it("CDP 不可用时退回 webContents.printToPDF，参数是 Electron 形态", async () => {
    const e = makeEnv((m) => {
      if (m === "Page.printToPDF") throw new Error("not supported");
      return undefined;
    });
    cleanups.push(e.cleanup);
    await e.handlers.save("task", normalizeOpArgs("save", { kind: "pdf", paperFormat: "letter", landscape: true }), undefined);
    expect(e.tab.wc.printToPDF).toHaveBeenCalledWith(expect.objectContaining({ landscape: true, pageSize: { width: 8.5, height: 11 }, preferCSSPageSize: false }));
  });
});

// ───────────────────────── server 工具 ─────────────────────────

const TASK = "task-c5";
let fake: FakeBrowser | null = null;
const tool = (): FlowshipToolDef => {
  const t = getBrowserTools({ taskId: TASK }).find((x) => x.name === "browser_save");
  if (!t) throw new Error("browser_save 未注册");
  return t;
};
const call = (args: Record<string, unknown>) => tool().handler(args, "caller-token", { taskId: TASK });
const textOf = (r: FlowshipToolResult): string => r.content.map((c) => (c.type === "text" ? c.text : "<img>")).join("\n");

describe("browser_save（server）：pdf 选项透传", () => {
  beforeEach(() => {
    __resetBrowserSettingsForTest();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }), save: () => ({ tabId: "t1", kind: "pdf", path: "/x/a.pdf", bytes: 100 }) });
  });
  afterEach(() => {
    fake?.cleanup();
    fake = null;
    vi.restoreAllMocks();
  });

  it("schema 有全部 pdf 选项且都可选；snake_case → camelCase 透传", async () => {
    const params = tool().parameters as { properties: Record<string, unknown>; required?: string[] };
    for (const k of ["landscape", "scale", "page_ranges", "paper_format", "margins", "print_background", "header", "footer"]) {
      expect(params.properties[k], k).toBeDefined();
      expect(params.required ?? []).not.toContain(k);
    }
    await call({ kind: "pdf", landscape: true, scale: 0.9, page_ranges: "1-2", paper_format: "a4", margins: { top: 1 }, print_background: false, header: "h", footer: "f" });
    const saved = fake!.calls.find((c) => c.op === "save")!;
    expect(saved.args).toEqual({ kind: "pdf", landscape: true, scale: 0.9, pageRanges: "1-2", paperFormat: "a4", margins: { top: 1 }, printBackground: false, header: "h", footer: "f" });
  });

  it("不带选项时 args 与 E1 一致；形状不对 / 非 pdf 带选项在 server 侧就拒、不发 bridge", async () => {
    await call({ kind: "pdf" });
    expect(fake!.calls.find((c) => c.op === "save")!.args).toEqual({ kind: "pdf" });
    fake!.calls.length = 0;
    expect(textOf(await call({ kind: "pdf", landscape: "yes" }))).toContain("landscape");
    expect(textOf(await call({ kind: "pdf", margins: [1] }))).toContain("margins");
    expect(textOf(await call({ kind: "html", landscape: true }))).toContain("只在 kind=pdf");
    expect(fake!.calls.filter((c) => c.op === "save")).toEqual([]);
  });

  it("工具描述提到 pdf 可调项，且仍不超过 2 句（工具描述精炼约定）", () => {
    expect(tool().description).toContain("page_ranges");
    expect(tool().description.split("。").filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});
