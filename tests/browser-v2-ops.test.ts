/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 session 是刻意的，被测 .mjs 无类型声明 */
/**
 * V2 主进程 op（electron-app/browser/ops/read.mjs）：参数校验 / 文件名清洗 / 落盘路径 / 不覆盖写入 /
 * inspect 再保险 / handler 编排（假 tab 驱动，真 CDP 行为见 scripts/browser-e2e/v2-smoke.cjs）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTRA_OPS, OP_MODULES } from "../electron-app/browser/ops/index.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { PDF_MAX_BYTES } from "../electron-app/browser/output-caps.mjs";
import {
  OPS,
  SAVE_SUBDIR,
  buildSavePath,
  createHandlers,
  formatStamp,
  normalize,
  pickBaseName,
  sanitizeFileName,
  sanitizeInspectResult,
  truncateUtf8,
  writeFileUnique,
} from "../electron-app/browser/ops/read.mjs";

const norm = (op: string, args: Record<string, unknown>) => normalize(op, args, OP_HELPERS);

describe("ops/read：注册与参数校验", () => {
  it("OPS = read / inspect / network_detail / save，且都进了 EXTRA_OPS、与别的模块互不相交", () => {
    expect([...OPS]).toEqual(["read", "inspect", "network_detail", "save"]);
    for (const op of OPS) expect(EXTRA_OPS).toContain(op);
    const all = OP_MODULES.flatMap((m: any) => [...m.OPS]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("read：缺省值、夹紧 maxChars、非法 format → BAD_ARGS", () => {
    expect(norm("read", {})).toEqual({ format: "markdown", maxChars: 30_000, mainContent: true });
    expect(norm("read", { ref: "e3", format: "text", maxChars: 5, mainContent: false, tabId: "t2" })).toEqual({
      ref: "e3",
      format: "text",
      maxChars: 1000,
      mainContent: false,
      tabId: "t2",
    });
    expect(() => norm("read", { format: "html" })).toThrow(/format/);
    expect(() => norm("read", { mainContent: "yes" })).toThrow(/布尔/);
  });

  it("inspect：ref 必填；include / styleProps 严格校验（≤30、字符集）", () => {
    expect(norm("inspect", { ref: "e1" })).toEqual({ ref: "e1", include: ["box", "styles", "attrs"] });
    expect(norm("inspect", { ref: "e1", include: ["html", "html", "box"], styleProps: [" Color ", "--x"] })).toEqual({
      ref: "e1",
      include: ["html", "box"],
      styleProps: ["color", "--x"],
    });
    expect(() => norm("inspect", {})).toThrow(/ref/);
    expect(() => norm("inspect", { ref: "e1", include: [] })).toThrow(/include/);
    expect(() => norm("inspect", { ref: "e1", include: ["cookies"] })).toThrow(/include/);
    expect(() => norm("inspect", { ref: "e1", styleProps: ["a;b"] })).toThrow(/CSS 属性名/);
    expect(() => norm("inspect", { ref: "e1", styleProps: Array.from({ length: 31 }, (_, i) => `p${i}`) })).toThrow(/30/);
  });

  it("network_detail：id 必填正整数；includeBody 默认 false", () => {
    // E2·B1 起 network_detail 多了 frameLimit（WebSocket / SSE 帧条数上限，默认 50）
    expect(norm("network_detail", { id: 12 })).toEqual({ id: 12, includeBody: false, frameLimit: 50 });
    expect(norm("network_detail", { id: 3, includeBody: true, tabId: "t2" })).toEqual({ id: 3, includeBody: true, frameLimit: 50, tabId: "t2" });
    expect(() => norm("network_detail", {})).toThrow(/id/);
    expect(() => norm("network_detail", { id: "12" })).toThrow(/数字/);
  });

  it("save：kind 必填枚举；fullPage 默认 true；nameHint 限长", () => {
    expect(norm("save", { kind: "pdf" })).toEqual({ kind: "pdf", fullPage: true });
    expect(norm("save", { kind: "screenshot", fullPage: false, nameHint: "x" })).toEqual({ kind: "screenshot", fullPage: false, nameHint: "x" });
    expect(() => norm("save", {})).toThrow(/kind/);
    expect(() => norm("save", { kind: "docx" })).toThrow(/kind/);
    expect(() => norm("save", { kind: "html", nameHint: "x".repeat(201) })).toThrow(/过长/);
  });
});

describe("ops/read：文件名与落盘路径（AI 不能指定路径）", () => {
  it("sanitizeFileName：只留字母数字中文与 ._- 空格；路径分隔 / 控制字符 / 引号冒号都变 _；不以 . 开头；主体 ≤120 字节", () => {
    expect(sanitizeFileName("我的 页面_v1.2-final")).toBe("我的 页面_v1.2-final");
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFileName("a/b\\c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("name\u0000with\nnewline\ttab")).toBe("name_with_newline_tab"); // 控制字符（含 \n \t）都变 _，只有普通空格保留
    expect(sanitizeFileName("   ")).toBe("page");
    expect(sanitizeFileName("///")).toBe("page");
    expect(sanitizeFileName(undefined)).toBe("page");
    expect(sanitizeFileName("x".repeat(200))).toHaveLength(120); // ASCII 一字节一字符：主体上限 120 字节 = 120 字符
    // R1-22：旧版这里断言「100 个汉字截成 80 个码点」，等于把 240 字节的超长文件名固化成了期望（加前缀 / 扩展名就 >255 字节 → ENAMETOOLONG）。
    // 现在按 UTF-8 字节截：汉字 3 字节，120 字节 = 40 个
    const zh = sanitizeFileName("中".repeat(100));
    expect(Array.from(zh)).toHaveLength(40);
    expect(Buffer.byteLength(zh, "utf8")).toBe(120);
    expect(sanitizeFileName("Résumé 简历")).toBe("Résumé 简历");
    expect(sanitizeFileName("CON.txt")).toBe("CON.txt"); // 保留名由「时间戳前缀」兜底，见 buildSavePath
  });

  describe("R1-22：按 UTF-8 字节截断，最终完整文件名 ≤255 字节", () => {
    const stamp = "20261107-210000";
    /** 拼出 save 最终会用到的完整文件名（含时间前缀、去重后缀、扩展名），逐字节量 */
    const fullNameBytes = (base: string, ext = "html", index = 99) =>
      Buffer.byteLength(path.basename(buildSavePath({ downloadsDir: "/dl", stamp, base, ext, index }).file), "utf8");

    it("truncateUtf8：不超限原样返回；超限在字素簇边界截，字节数 ≤ 上限", () => {
      expect(truncateUtf8("abc", 3)).toBe("abc");
      expect(truncateUtf8("abcd", 3)).toBe("abc");
      expect(truncateUtf8("中文", 6)).toBe("中文");
      expect(truncateUtf8("中文", 5)).toBe("中"); // 第二个汉字放不下，整个丢掉，不留半个字节序列
      expect(truncateUtf8("中文", 2)).toBe("");
      expect(truncateUtf8(undefined, 5)).toBe("");
      for (const max of [0, 1, 2, 3, 4, 5, 7, 11]) {
        const out = truncateUtf8("a中😀é𠀀b", max);
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(max);
        expect("a中😀é𠀀b".startsWith(out)).toBe(true);
        expect(out).not.toMatch(/\uFFFD/); // 没劈出替换字符
      }
    });

    it("truncateUtf8 不劈开代理对：4 字节字符（CJK 扩展 B / emoji）要么整个保留、要么整个丢弃", () => {
      const s = "𠀀".repeat(10); // 每个 4 字节
      for (let max = 0; max <= 41; max++) {
        const out = truncateUtf8(s, max);
        expect(Array.from(out).every((ch) => ch === "𠀀")).toBe(true); // 没有落单的高 / 低代理
        expect(Buffer.byteLength(out, "utf8")).toBe(Math.min(Math.floor(max / 4), 10) * 4);
      }
    });

    it("truncateUtf8 不劈开组合字符与 emoji ZWJ 序列", () => {
      const combining = "e\u0301"; // é = e + 组合锐音符：3 字节（1 + 2）
      expect(truncateUtf8(`${combining}${combining}`, 5)).toBe(combining); // 放得下 1 个整簇；不能留下孤立的 e 或孤立的组合符
      expect(truncateUtf8(`${combining}${combining}`, 2)).toBe(""); // 连 1 个整簇都放不下：宁可全丢，不留半个
      const family = "👨\u200D👩\u200D👧"; // ZWJ 序列：4+3+4+3+4 = 18 字节，是一个字素簇
      expect(truncateUtf8(`${family}x`, 17)).toBe(""); // 放不下整簇 → 丢掉整簇
      expect(truncateUtf8(`${family}x`, 19)).toBe(`${family}x`);
      expect(truncateUtf8(`${family}x`, 18)).toBe(family);
    });

    it("汉字 / 超长标题：主体 ≤120 字节，完整文件名（时间前缀 + 去重后缀 + 扩展名）远小于 255 字节", () => {
      for (const raw of ["中".repeat(100), "中".repeat(1000), "𠀀".repeat(300), "Résumé 简历 ".repeat(50), "a".repeat(5000), "中a".repeat(200)]) {
        const base = sanitizeFileName(raw);
        expect(Buffer.byteLength(base, "utf8"), raw.slice(0, 6)).toBeLessThanOrEqual(120);
        for (const ext of ["pdf", "png", "html"]) expect(fullNameBytes(base, ext)).toBeLessThanOrEqual(255);
        // 实际预算：16 + 120 + 3 + 5 = 144
        expect(fullNameBytes(base, "html")).toBeLessThanOrEqual(144);
      }
    });

    it("旧版的问题输入：80 个汉字（240 字节）+ 前缀 + 扩展名 > 255 字节——现在被截到安全范围", () => {
      const oldBehaviour = "中".repeat(80); // 旧版 sanitizeFileName 原样保留 80 个汉字
      expect(Buffer.byteLength(`${stamp}-${oldBehaviour}.html`, "utf8")).toBeGreaterThan(255); // 复现：这种 base 直接拼会超
      expect(() => buildSavePath({ downloadsDir: "/dl", stamp, base: oldBehaviour, ext: "html", index: 0 })).toThrow(/文件名过长/); // 兜底也拦得住
      expect(fullNameBytes(sanitizeFileName(oldBehaviour), "html", 0)).toBeLessThanOrEqual(255);
    });

    it("pickBaseName：nameHint（≤200 字符 = 最多 600 字节）/ 标题 / 主机名都走同一个字节上限", () => {
      for (const p of [{ nameHint: "报".repeat(200) }, { title: "题".repeat(500) }, { title: " ", url: `https://${"a".repeat(60)}.${"b".repeat(60)}.example.com/` }]) {
        const base = pickBaseName(p);
        expect(Buffer.byteLength(base, "utf8")).toBeLessThanOrEqual(120);
        expect(fullNameBytes(base)).toBeLessThanOrEqual(255);
      }
    });

    it("截断后首尾的点 / 空格 / 下划线被清掉，不会留下以 . 开头或以分隔符结尾的名字", () => {
      const base = sanitizeFileName(`${"中".repeat(39)}. _-${"尾".repeat(10)}`); // 第 40 个字符位置正好落在标点上
      expect(base).toBe("中".repeat(39));
      expect(sanitizeFileName(`.${"中".repeat(100)}`).startsWith(".")).toBe(false);
    });
  });

  it("formatStamp：YYYYMMDD-HHmmss（本地时间）", () => {
    expect(formatStamp(new Date(2026, 10, 7, 9, 5, 3))).toBe("20261107-090503");
    expect(formatStamp(new Date(2026, 0, 1, 23, 59, 59))).toBe("20260101-235959");
  });

  it("pickBaseName：nameHint > 标题 > 主机名 > page", () => {
    expect(pickBaseName({ nameHint: "报告", title: "标题", url: "https://a.test/" })).toBe("报告");
    expect(pickBaseName({ title: "页面 标题", url: "https://a.test/" })).toBe("页面 标题");
    expect(pickBaseName({ title: "  ", url: "https://a.test/x" })).toBe("a.test");
    expect(pickBaseName({ url: "about:blank" })).toBe("page"); // about:blank 的 hostname 为空
    expect(pickBaseName({})).toBe("page");
  });

  it("buildSavePath：落在 <downloads>/Flowship-browser 下，文件名 = 时间戳-名.扩展名，带序号时加 -N", () => {
    const { dir, file } = buildSavePath({ downloadsDir: "/dl", stamp: "20261107-210000", base: "报告", ext: "pdf" });
    expect(dir).toBe(path.join("/dl", SAVE_SUBDIR));
    expect(file).toBe(path.join("/dl", SAVE_SUBDIR, "20261107-210000-报告.pdf"));
    expect(buildSavePath({ downloadsDir: "/dl", stamp: "s", base: "b", ext: "png", index: 2 }).file).toBe(path.join("/dl", SAVE_SUBDIR, "s-b-2.png"));
    // 即便 base 没经过清洗（防御：清洗逻辑被改坏），也不许写出目录
    expect(() => buildSavePath({ downloadsDir: "/dl", stamp: "s", base: "../x", ext: "pdf" })).toThrow(/路径/);
  });

  describe("writeFileUnique（真文件系统，临时目录）", () => {
    const tmps: string[] = [];
    afterEach(() => {
      for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const mk = () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "v2-ops-"));
      tmps.push(d);
      return d;
    };

    it("自动建子目录；同名不覆盖，加序号；内容与长度正确", () => {
      const downloadsDir = mk();
      const args = { downloadsDir, stamp: "20261107-210000", base: "same", ext: "html" };
      const a = writeFileUnique({ ...args, data: Buffer.from("第一份") });
      const b = writeFileUnique({ ...args, data: Buffer.from("第二份") });
      expect(path.basename(a)).toBe("20261107-210000-same.html");
      expect(path.basename(b)).toBe("20261107-210000-same-1.html");
      expect(fs.readFileSync(a, "utf8")).toBe("第一份");
      expect(fs.readFileSync(b, "utf8")).toBe("第二份");
      expect(path.dirname(a)).toBe(path.join(downloadsDir, SAVE_SUBDIR));
    });

    it.skipIf(process.platform === "win32")("落盘文件权限 0600（仅属主可读写；冒烟套件发现原先是默认 0644）", () => {
      const downloadsDir = mk();
      const f = writeFileUnique({ downloadsDir, stamp: "20261109-080000", base: "perm", ext: "pdf", data: Buffer.from("x") });
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    });

    it("非 EEXIST 的写入错误立即停止（不重试）；序号用完后报错", () => {
      const calls: string[] = [];
      const boom = { mkdirSync: () => {}, writeFileSync: (f: string) => { calls.push(f); throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
      expect(() => writeFileUnique({ fs: boom as any, downloadsDir: "/dl", stamp: "s", base: "b", ext: "pdf", data: Buffer.from("x") })).toThrow(/没有写入权限/);
      expect(calls).toHaveLength(1);
      const always = { mkdirSync: () => {}, writeFileSync: () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); } };
      expect(() => writeFileUnique({ fs: always as any, downloadsDir: "/dl", stamp: "s", base: "b", ext: "pdf", data: Buffer.from("x") })).toThrow(/同名文件过多/);
    });

    // R1-22：旧版 `throw err` 把 Node 的原始错误（message 里是完整路径，如「ENAMETOOLONG: name too long, open '/Users/me/Downloads/…'」）
    // 经 toErrorPayload 一路带给了 AI。
    it("R1-22：写入 / 建目录失败抛 BrowserError(INTERNAL)，文案只有原因 + errno 码，不含完整路径与用户名", () => {
      const secretDir = "/Users/secret-name/Downloads";
      const nodeStyle = (code: string, syscall: string, p: string) =>
        Object.assign(new Error(`${code}: boom, ${syscall} '${p}'`), { code, syscall, path: p });
      const cases: Array<[string, string, RegExp]> = [
        ["ENAMETOOLONG", "文件名过长", /ENAMETOOLONG/],
        ["EACCES", "没有写入权限", /EACCES/],
        ["ENOSPC", "磁盘空间不足", /ENOSPC/],
        ["EROFS", "只读", /EROFS/],
        ["EWEIRD", "写入出错", /EWEIRD/],
      ];
      for (const [code, human, codeRe] of cases) {
        const fsx = { mkdirSync: () => {}, writeFileSync: (f: string) => { throw nodeStyle(code, "open", f); } };
        let err: any;
        try {
          writeFileUnique({ fs: fsx as any, downloadsDir: secretDir, stamp: "s", base: "b", ext: "pdf", data: Buffer.from("x") });
        } catch (e) {
          err = e;
        }
        expect(err, code).toMatchObject({ name: "BrowserError", code: "INTERNAL" });
        expect(err.message).toContain(human);
        expect(err.message).toMatch(codeRe);
        expect(err.message).not.toMatch(/secret-name|Downloads|Flowship-browser|\/Users|open '/);
      }
      // mkdir 失败同样不带路径
      const noDir = { mkdirSync: () => { throw nodeStyle("EACCES", "mkdir", `${secretDir}/Flowship-browser`); }, writeFileSync: () => {} };
      let err2: any;
      try {
        writeFileUnique({ fs: noDir as any, downloadsDir: secretDir, stamp: "s", base: "b", ext: "pdf", data: Buffer.from("x") });
      } catch (e) {
        err2 = e;
      }
      expect(err2).toMatchObject({ code: "INTERNAL" });
      expect(err2.message).not.toMatch(/secret-name|Downloads|\/Users/);
      // 没有 code 的异常（不是 fs 错误）：不泄露 message，只说「写入出错」
      const odd = { mkdirSync: () => {}, writeFileSync: () => { throw new Error("内部细节 /Users/secret-name/x"); } };
      expect(() => writeFileUnique({ fs: odd as any, downloadsDir: "/dl", stamp: "s", base: "b", ext: "pdf", data: Buffer.from("x") })).toThrow(/写入出错/);
      expect(() => writeFileUnique({ fs: odd as any, downloadsDir: "/dl", stamp: "s", base: "b", ext: "pdf", data: Buffer.from("x") })).not.toThrow(/secret-name/);
    });

    it("R1-22：真文件系统里写入超长字节名的真实表现——sanitize 后的汉字标题能落盘，文件名 ≤255 字节", () => {
      const downloadsDir = mk();
      const base = pickBaseName({ nameHint: "报".repeat(200), url: "https://a.test/" });
      const file = writeFileUnique({ downloadsDir, stamp: "20261107-210000", base, ext: "html", data: Buffer.from("x") });
      expect(fs.existsSync(file)).toBe(true);
      expect(Buffer.byteLength(path.basename(file), "utf8")).toBeLessThanOrEqual(255);
    });
  });
});

describe("ops/read：sanitizeInspectResult（主进程再保险）", () => {
  it("password / one-time-code 的 value 去掉；on* 属性去掉；单值 ≤300；html ≤4000；不改入参", () => {
    const input = {
      tag: "input",
      attrs: { type: "password", value: "hunter2", onclick: "x()", name: "pw", "data-big": "z".repeat(500) },
      styles: { "font-family": "a".repeat(400) },
      html: "h".repeat(5000),
    };
    const out = sanitizeInspectResult(input) as any;
    expect(out.attrs).toEqual({ type: "password", name: "pw", "data-big": `${"z".repeat(299)}…` });
    expect(out.styles["font-family"]).toHaveLength(300);
    expect(out.html).toHaveLength(4000);
    expect(input.attrs.value).toBe("hunter2");

    const otp = sanitizeInspectResult({ tag: "input", attrs: { type: "text", autocomplete: "one-time-code", value: "123456" } }) as any;
    expect(otp.attrs.value).toBeUndefined();
    const text = sanitizeInspectResult({ tag: "input", attrs: { type: "text", value: "alice" } }) as any;
    expect(text.attrs.value).toBe("alice");
    // 不是 input 的 value 属性（如 <li value=3>）照常给
    expect((sanitizeInspectResult({ tag: "li", attrs: { value: "3" } }) as any).attrs.value).toBe("3");
  });
});

// ───────────────────────── handler 编排（假 tab） ─────────────────────────

const makeEnv = (over: { send?: (m: string, p: any, sid?: any) => any; screenshot?: any; printToPDF?: any; evaluateEnabled?: boolean; networkBodyRead?: boolean } = {}) => {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-handlers-"));
  const sent: Array<{ method: string; params: any; sessionId: any }> = [];
  const tab: any = {
    id: "t1",
    url: "https://a.test/p?token=zzz",
    title: "我的/页面",
    mainFrameId: "F1",
    ensureCdp: async () => {},
    resolveRef: vi.fn(() => ({ backendNodeId: 9, sessionId: null, role: "button", name: "提交" })),
    send: vi.fn(async (method: string, params: any, sessionId: any = null) => {
      sent.push({ method, params, sessionId });
      if (over.send) {
        const r = await over.send(method, params, sessionId);
        if (r !== undefined) return r;
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 5 };
      if (method === "DOM.resolveNode") return { object: { objectId: "obj1" } };
      return {};
    }),
    screenshot: over.screenshot ?? vi.fn(async () => ({ dataBase64: Buffer.from("PNGDATA").toString("base64") })),
    wc: { printToPDF: over.printToPDF ?? vi.fn(async () => Buffer.from("%PDF-fallback")) },
    getNetworkEntry: vi.fn(),
  };
  const activity: any[] = [];
  const session: any = { getTab: () => tab, activityLog: { addAI: (e: any) => activity.push(e) } };
  const scheduleState = vi.fn();
  const callOnNode = vi.fn(async () => ({ text: "来自主世界", truncated: false, root: "element", totalLength: 5 }));
  const handlers = createHandlers({
    requireSession: () => session,
    getConfig: () => ({ evaluateEnabled: over.evaluateEnabled === true, networkBodyRead: over.networkBodyRead !== false }),
    abortable: (p: Promise<unknown>) => p,
    scheduleState,
    app: { getPath: () => downloadsDir },
    now: () => new Date(2026, 10, 7, 21, 0, 5),
    actions: { callOnNode },
    log: () => {},
  });
  return { handlers, tab, sent, activity, scheduleState, callOnNode, downloadsDir, cleanup: () => fs.rmSync(downloadsDir, { recursive: true, force: true }) };
};

describe("ops/read：handlers", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });
  const env = (o: Parameters<typeof makeEnv>[0] = {}) => {
    const e = makeEnv(o);
    cleanups.push(e.cleanup);
    return e;
  };

  it("read（无 ref）：在隔离世界里 evaluate（contextId=隔离世界），表达式是 (fn).call(null)；返回契约字段 + root / totalLength", async () => {
    const e = env({
      send: (m) => (m === "Runtime.evaluate" ? { result: { value: { text: "你好\n\n世界", truncated: false, root: "main", totalLength: 6 } } } : undefined),
    });
    const r = await e.handlers.read("task", { format: "markdown", maxChars: 30_000, mainContent: true }, undefined);
    expect(r).toEqual({ tabId: "t1", url: "https://a.test/p?token=zzz", title: "我的/页面", format: "markdown", text: "你好\n\n世界", length: 6, truncated: false, root: "main", totalLength: 6 });
    const iso = e.sent.find((s) => s.method === "Page.createIsolatedWorld")!;
    expect(iso.params).toMatchObject({ frameId: "F1", worldName: "flowship-read" });
    const ev = e.sent.find((s) => s.method === "Runtime.evaluate")!;
    expect(ev.params.contextId).toBe(5);
    expect(ev.params.returnByValue).toBe(true);
    expect(ev.params.expression.startsWith("(function () {")).toBe(true);
    expect(ev.params.expression.endsWith(".call(null)")).toBe(true);
    expect(ev.params.expression).toContain('"format":"markdown"');
  });

  it("read（ref，主会话元素）：DOM.resolveNode 带隔离世界 contextId → callFunctionOn，用完释放 objectId", async () => {
    const e = env({
      send: (m) => (m === "Runtime.callFunctionOn" ? { result: { value: { text: "按钮", truncated: false, root: "element", totalLength: 2 } } } : undefined),
    });
    const r = await e.handlers.read("task", { ref: "e5", format: "text", maxChars: 1000, mainContent: true }, undefined);
    expect(r.text).toBe("按钮");
    expect(r.root).toBe("element");
    const resolve = e.sent.find((s) => s.method === "DOM.resolveNode")!;
    expect(resolve.params).toEqual({ backendNodeId: 9, executionContextId: 5 });
    expect(e.sent.some((s) => s.method === "Runtime.releaseObject" && s.params.objectId === "obj1")).toBe(true);
    expect(e.callOnNode).not.toHaveBeenCalled();
  });

  it("read（ref 在 OOPIF 子会话 / 隔离世界解析失败）：退回主世界 callOnNode", async () => {
    const oopif = env();
    oopif.tab.resolveRef = vi.fn(() => ({ backendNodeId: 9, sessionId: "child-1" }));
    const r1 = await oopif.handlers.read("task", { ref: "e5", format: "markdown", maxChars: 1000, mainContent: true }, undefined);
    expect(r1.text).toBe("来自主世界");
    expect(oopif.callOnNode).toHaveBeenCalledTimes(1);
    expect(oopif.sent.some((s) => s.method === "DOM.resolveNode")).toBe(false);

    const failing = env({
      send: (m) => {
        if (m === "DOM.resolveNode") throw new Error("Node with given id does not belong to the document");
        return undefined;
      },
    });
    const r2 = await failing.handlers.read("task", { ref: "e5", format: "markdown", maxChars: 1000, mainContent: true }, undefined);
    expect(r2.text).toBe("来自主世界");
  });

  it("read：页内脚本返回 { error } → INTERNAL；ref 失效的错误原样抛出", async () => {
    const e = env({ send: (m) => (m === "Runtime.evaluate" ? { result: { value: { error: "炸了" } } } : undefined) });
    await expect(e.handlers.read("task", { format: "markdown", maxChars: 1000, mainContent: true }, undefined)).rejects.toMatchObject({ code: "INTERNAL" });
    const stale = env();
    stale.tab.resolveRef = vi.fn(() => {
      throw Object.assign(new Error("ref 已失效"), { code: "REF_STALE" });
    });
    await expect(stale.handlers.read("task", { ref: "e1", format: "markdown", maxChars: 1000, mainContent: true }, undefined)).rejects.toMatchObject({ code: "REF_STALE" });
  });

  it("inspect：补上 ref 表里的 role / name；结果经再保险（password 的 value 即便页内漏了也被去掉）", async () => {
    const e = env({
      send: (m) =>
        m === "Runtime.callFunctionOn"
          ? { result: { value: { tag: "input", box: { x: 1, y: 2, width: 3, height: 4, inViewport: true, visible: true }, attrs: { type: "password", value: "leak", onclick: "x" } } } }
          : undefined,
    });
    const r = await e.handlers.inspect("task", { ref: "e5", include: ["box", "attrs"] }, undefined);
    expect(r).toMatchObject({ tabId: "t1", ref: "e5", tag: "input", role: "button", name: "提交" });
    expect((r as any).attrs).toEqual({ type: "password" });
    expect(r).not.toHaveProperty("styles");
    expect(r).not.toHaveProperty("html");
  });

  it("network_detail：includeBody 看 networkBodyRead（关着 → ACCESS_DISABLED，与 evaluate 总闸无关）；不带 body 不需要；id 不存在 → BAD_ARGS", async () => {
    // E2·A7 拆分：原先借用 evaluateEnabled（DISABLED），现在是独立开关 networkBodyRead（默认开、只认显式 false 才关）
    const e = env({ networkBodyRead: false, evaluateEnabled: true });
    await expect(e.handlers.network_detail("task", { id: 1, includeBody: true }, undefined)).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
    expect(e.tab.getNetworkEntry).not.toHaveBeenCalled();
    e.tab.getNetworkEntry = vi.fn(() => null);
    await expect(e.handlers.network_detail("task", { id: 7, includeBody: false }, undefined)).rejects.toMatchObject({ code: "BAD_ARGS" });

    const ok = env({ networkBodyRead: true }); // evaluateEnabled 关着也能读 body
    ok.tab.getNetworkEntry = vi.fn(() => ({
      entry: { id: 7, ts: 1, method: "GET", url: "https://a.test/x", status: 200, type: "Fetch" },
      detail: { requestHeaders: { Cookie: "a=1" }, responseHeaders: {}, mimeType: "application/json", postData: undefined },
    }));
    ok.tab.fetchNetworkResponseBody = vi.fn(async () => ({ ok: true, body: '{"a":1}', base64Encoded: false }));
    ok.tab.fetchNetworkPostData = vi.fn(async () => undefined);
    const r = (await ok.handlers.network_detail("task", { id: 7, includeBody: true }, undefined)) as any;
    expect(r.responseBody).toBe('{"a":1}');
    expect(r.requestHeaders.Cookie).toBe("[已隐藏]");
    const noBody = (await ok.handlers.network_detail("task", { id: 7, includeBody: false }, undefined)) as any;
    expect(noBody).not.toHaveProperty("responseBody");
    expect(ok.tab.fetchNetworkResponseBody).toHaveBeenCalledTimes(1);
  });

  it("save html：写到 <downloads>/Flowship-browser/<时间戳>-<清洗后的标题>.html，返回 { tabId, kind, path, bytes }，记活动日志并刷新状态", async () => {
    const html = "<!DOCTYPE html>\n<html><body>你好</body></html>";
    const e = env({ send: (m) => (m === "Runtime.evaluate" ? { result: { value: html } } : undefined) });
    const r = (await e.handlers.save("task", { kind: "html", fullPage: true }, undefined)) as any;
    expect(r.tabId).toBe("t1");
    expect(r.kind).toBe("html");
    expect(r.path).toBe(path.join(e.downloadsDir, SAVE_SUBDIR, "20261107-210005-我的_页面.html"));
    expect(r.bytes).toBe(Buffer.byteLength(html));
    expect(fs.readFileSync(r.path, "utf8")).toBe(html);
    expect(e.activity).toEqual([{ kind: "download", tabId: "t1", url: "https://a.test/p?token=zzz", summary: "保存了页面（html）" }]);
    expect(e.scheduleState).toHaveBeenCalledWith("task");
    // nameHint 优先于标题
    const r2 = (await e.handlers.save("task", { kind: "html", nameHint: "我的报告" }, undefined)) as any;
    expect(path.basename(r2.path)).toBe("20261107-210005-我的报告.html");
  });

  it("save screenshot：png 原图（maxWidth 给超大值、format=png、fullPage 透传）", async () => {
    const e = env();
    const r = (await e.handlers.save("task", { kind: "screenshot", fullPage: false }, undefined)) as any;
    expect(e.tab.screenshot).toHaveBeenCalledWith({ fullPage: false, format: "png", maxWidth: 100_000 });
    expect(path.extname(r.path)).toBe(".png");
    expect(fs.readFileSync(r.path, "utf8")).toBe("PNGDATA");
  });

  it("save pdf：优先 Page.printToPDF（printBackground 开）；CDP 不可用时退回 webContents.printToPDF；空文件拒绝保存", async () => {
    const cdp = env({ send: (m) => (m === "Page.printToPDF" ? { data: Buffer.from("%PDF-cdp").toString("base64") } : undefined) });
    const r1 = (await cdp.handlers.save("task", { kind: "pdf" }, undefined)) as any;
    expect(fs.readFileSync(r1.path, "utf8")).toBe("%PDF-cdp");
    expect(cdp.sent.find((s) => s.method === "Page.printToPDF")!.params.printBackground).toBe(true);
    expect(cdp.tab.wc.printToPDF).not.toHaveBeenCalled();

    const fallback = env({
      send: (m) => {
        if (m === "Page.printToPDF") throw new Error("not supported");
        return undefined;
      },
    });
    const r2 = (await fallback.handlers.save("task", { kind: "pdf" }, undefined)) as any;
    expect(fs.readFileSync(r2.path, "utf8")).toBe("%PDF-fallback");
    expect(fallback.tab.wc.printToPDF).toHaveBeenCalledWith({ printBackground: true, preferCSSPageSize: true });

    const empty = env({ screenshot: vi.fn(async () => ({ dataBase64: "" })) });
    await expect(empty.handlers.save("task", { kind: "screenshot" }, undefined)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(fs.existsSync(path.join(empty.downloadsDir, SAVE_SUBDIR))).toBe(false);
  });

  it("save pdf 超过 30MB（R1-29）：CDP 路径 → BAD_ARGS 带替代做法，不落盘，且不会被 catch 吞掉后退回 wc.printToPDF 再生成一份", async () => {
    const bigB64 = "A".repeat(Math.ceil((PDF_MAX_BYTES * 4) / 3) + 8);
    const e = env({ send: (m) => (m === "Page.printToPDF" ? { data: bigB64 } : undefined) });
    await expect(e.handlers.save("task", { kind: "pdf" }, undefined)).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/PDF体积.*30MB 上限.*html/s) });
    expect(e.tab.wc.printToPDF).not.toHaveBeenCalled(); // 上限检查在 try 之外
    expect(fs.existsSync(path.join(e.downloadsDir, SAVE_SUBDIR))).toBe(false);
  });

  it("save pdf 回退路径（wc.printToPDF 返回 Buffer）超过 30MB 同样拒绝；恰为上限放行", async () => {
    const noCdp = (m: string) => {
      if (m === "Page.printToPDF") throw new Error("not supported");
      return undefined;
    };
    const over = env({ send: noCdp, printToPDF: vi.fn(async () => Buffer.alloc(PDF_MAX_BYTES + 1, 1)) });
    await expect(over.handlers.save("task", { kind: "pdf" }, undefined)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fs.existsSync(path.join(over.downloadsDir, SAVE_SUBDIR))).toBe(false);
    const exact = env({ send: noCdp, printToPDF: vi.fn(async () => Buffer.alloc(PDF_MAX_BYTES, 1)) });
    const r = (await exact.handlers.save("task", { kind: "pdf" }, undefined)) as any;
    expect(fs.statSync(r.path).size).toBe(PDF_MAX_BYTES);
  });

  it("save html 超过 20MB → BAD_ARGS，不落盘", async () => {
    const big = "x".repeat(20 * 1024 * 1024 + 1);
    const e = env({ send: (m) => (m === "Runtime.evaluate" ? { result: { value: big } } : undefined) });
    await expect(e.handlers.save("task", { kind: "html" }, undefined)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fs.existsSync(path.join(e.downloadsDir, SAVE_SUBDIR))).toBe(false);
  });
});
