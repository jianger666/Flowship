/**
 * 本地 HTML 服务的 `file://` 引用翻译（electron-app/browser/local-html-server.mjs 头部第 11 条）。
 *
 * 背景：AI / 脚本生成的 HTML 常把图片 / 样式写成 `file:///<绝对路径>`；换成 `http://<token>.localhost:<端口>/…` 来源后
 * Chromium 一律拒绝加载 `file:` 子资源（裂图）。服务在回送 HTML / CSS / JS 文本时，把「解码后恰好落在服务根目录之内」的
 * `file://` URL 的根目录前缀换成服务自己的地址；根目录之外的不动。
 *
 * 这里钉两件事：
 *  1. 该翻译的都翻译（各种编码 / 大小写 / 别名写法），不该翻译的一个都不动（兄弟目录、上一级、别的盘……）；
 *  2. **翻译不放大页面能访问的文件集合**：翻译后的请求照走全部守卫（敏感文件 / `..` / 符号链接逃逸 / 单文件模式照拒），
 *     Range / HEAD / 大文件 / 非 UTF-8 / 没有 file:// 引用的响应与以前逐字节一致。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalHtmlServer, LOCAL_HTML_REWRITE_MAX_BYTES, rewriteLocalFileUrls } from "../electron-app/browser/local-html-server.mjs";

const O = "http://abc.localhost:1234";
const rw = (text: string, roots: string[], platform = "linux") => rewriteLocalFileUrls(text, { roots, origin: O, platform });

describe("rewriteLocalFileUrls：该翻译的（根目录的各种写法）", () => {
  const root = "/Users/me/proj";

  it("基本：`file:///<根>/a/b.png` → `<origin>/a/b.png`，只换根目录前缀", () => {
    const r = rw('<img src="file:///Users/me/proj/a/b.png">', [root]);
    expect(r).toEqual({ text: `<img src="${O}/a/b.png">`, count: 1 });
  });

  it("相对根目录的那一段（含它的编码、查询串、锚点）原样保留，由服务的请求守卫去解码 / 校验", () => {
    const r = rw("file:///Users/me/proj/%E5%8F%91/x%20y.png?v=1#h", [root]);
    expect(r.text).toBe(`${O}/%E5%8F%91/x%20y.png?v=1#h`);
  });

  it("根目录里有中文 / 空格：全编码、只编码一段（真实页面就是这样）、完全不编码、十六进制小写，都认", () => {
    const dir = "/Users/me/我的 项目/出版";
    const enc = (s: string) => encodeURIComponent(s);
    const cases = [
      `file:///Users/me/${enc("我的 项目")}/${enc("出版")}/x.png`, // 全编码（Python quote / encodeURIComponent）
      `file:///Users/me/我的 项目/${enc("出版")}/x.png`, // 只编码一段
      "file:///Users/me/我的 项目/出版/x.png", // 完全不编码（原样中文 + 空格）
      `file:///Users/me/${enc("我的 项目").toLowerCase()}/${enc("出版").toLowerCase()}/x.png`, // 小写十六进制
      "file:///Users/me/我的%20项目/出版/x.png", // 空格编码、中文不编码
    ];
    for (const c of cases) expect(rw(c, [dir]), c).toEqual({ text: `${O}/x.png`, count: 1 });
  });

  it("`file://localhost/` 与大写 scheme 也认", () => {
    expect(rw("file://localhost/Users/me/proj/x.png", [root]).text).toBe(`${O}/x.png`);
    expect(rw("FILE:///Users/me/proj/x.png", [root]).text).toBe(`${O}/x.png`);
  });

  it("多处引用（HTML 属性、CSS url()、JS 字符串、JSON 数据）各自翻译，前后文不动", () => {
    const text = [
      `<img src="file:///Users/me/proj/a.png">`,
      `body{background:url(file:///Users/me/proj/bg.jpg)}`,
      `const u = 'file:///Users/me/proj/dir/c.png';`,
      `{"uri": "file:///Users/me/proj/%E5%8F%91%E5%B8%83_180/p.jpg"}`,
    ].join("\n");
    const r = rw(text, [root]);
    expect(r.count).toBe(4);
    expect(r.text).toBe(
      [
        `<img src="${O}/a.png">`,
        `body{background:url(${O}/bg.jpg)}`,
        `const u = '${O}/dir/c.png';`,
        `{"uri": "${O}/%E5%8F%91%E5%B8%83_180/p.jpg"}`,
      ].join("\n"),
    );
  });

  it("同一个目录的两种写法（用户写的路径 + realpath）都认；第一个匹配的生效", () => {
    const roots = ["/Users/me/alias", "/private/real/proj"];
    expect(rw("file:///Users/me/alias/a.png file:///private/real/proj/b.png", roots)).toEqual({ text: `${O}/a.png ${O}/b.png`, count: 2 });
  });

  it("macOS 文件名 NFD、文本里是 NFC（或反过来）：规范化后比较", () => {
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    expect(rw(`file:///Users/me/${nfc}/x.png`, [`/Users/me/${nfd}`]).count).toBe(1);
    expect(rw(`file:///Users/me/${nfd}/x.png`, [`/Users/me/${nfc}`]).count).toBe(1);
    expect(rw(`file:///Users/me/${encodeURIComponent(nfd)}/x.png`, [`/Users/me/${nfc}`]).count).toBe(1);
  });

  it("Windows：盘符 / 目录名大小写不敏感，`C%3A` 与 `C:` 都认，反斜杠根目录能拆", () => {
    const winRoot = "C:\\Users\\Me\\proj";
    const win = (t: string) => rw(t, [winRoot], "win32");
    expect(win("file:///C:/Users/Me/proj/x.png")).toEqual({ text: `${O}/x.png`, count: 1 });
    expect(win("file:///c:/users/me/PROJ/x.png").count).toBe(1);
    expect(win("file:///C%3A/Users/Me/proj/x.png").count).toBe(1);
    // posix 上大小写敏感
    expect(rw("file:///Users/ME/proj/x.png", [root]).count).toBe(0);
  });

  it("翻译后再翻译一遍什么都不变（幂等）", () => {
    const once = rw('<img src="file:///Users/me/proj/a.png">', [root]);
    expect(rw(once.text, [root])).toEqual({ text: once.text, count: 0 });
  });
});

describe("rewriteLocalFileUrls：不该翻译的一个都不动", () => {
  const root = "/Users/me/proj";
  const same = (text: string, roots = [root]) => expect(rw(text, roots), text).toEqual({ text, count: 0 });

  it("根目录之外：兄弟目录（名字以根目录名开头）、上一级、别的目录、根目录的一部分", () => {
    same("file:///Users/me/proj2/x.png");
    same("file:///Users/me/project/x.png");
    same("file:///Users/me/x.png");
    same("file:///Users/other/proj/x.png");
    same("file:///Users/me/pro/j/x.png");
    same("file:///etc/passwd");
    same("file:///Users/me/proj"); // 没有尾斜杠 = 就是根目录本身，不是它里面的东西
    same('file:///Users/me/proj"'); // 属性值到此为止
  });

  it("没有 file:// 的文本不动：普通绝对路径（页面显示 / 复制用的）、相对路径、http 地址", () => {
    same('<code>/Users/me/proj/a.png</code> <img src="a.png"> <a href="http://x.test/Users/me/proj/a.png">');
  });

  it("UNC / 空主机以外的主机 / 盘符不匹配 都不动", () => {
    same("file:////server/share/Users/me/proj/x.png");
    same("file://example.com/Users/me/proj/x.png");
    expect(rw("file:///D:/Users/Me/proj/x.png", ["C:\\Users\\Me\\proj"], "win32").count).toBe(0);
  });

  it("根目录是文件系统根 / 空 / 非字符串 / 没给：什么都不翻译（不会把整个磁盘翻成页面可访问）", () => {
    same("file:///Users/me/proj/x.png", ["/"]);
    same("file:///Users/me/proj/x.png", [""]);
    same("file:///Users/me/proj/x.png", []);
    expect(rewriteLocalFileUrls("file:///Users/me/proj/x.png", { roots: undefined as unknown as string[], origin: O })).toEqual({ text: "file:///Users/me/proj/x.png", count: 0 });
    expect(rewriteLocalFileUrls("", { roots: [root], origin: O })).toEqual({ text: "", count: 0 });
  });

  it("畸形输入不抛：坏的百分号编码、超长路径段（不会扫到文末）", () => {
    same("file:///Users/me/pr%oj/x.png");
    same(`file:///${"a".repeat(5000)}/x.png`);
    same(`file:///Users/me/${"%E5".repeat(2000)}/x.png`);
    const t0 = Date.now();
    rw(`file:///`.repeat(2000) + "a".repeat(200_000), [root]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("`..` 留在相对部分里：翻译只换前缀，不替页面规范化路径（服务端会拒 `..`）", () => {
    expect(rw("file:///Users/me/proj/../secret.txt", [root])).toEqual({ text: `${O}/../secret.txt`, count: 1 });
  });
});

// ───────────────────────── 服务端集成（真实临时目录 + 真实回环 http） ─────────────────────────

type Opened = { port: number; host: string; token: string };
type Resp = { status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; text: string };

const request = (o: Pick<Opened, "port" | "host">, rawPath: string, opts: { method?: string; headers?: Record<string, string> } = {}) =>
  new Promise<Resp>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: o.port, path: rawPath, method: opts.method ?? "GET", headers: { Host: o.host, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, text: bytes.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });

const symlinkOk = process.platform !== "win32";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tmp: string;
let site: string;
let outside: string;
let srv: ReturnType<typeof createLocalHtmlServer>;

const write = (rel: string, content: string | Buffer, root = site) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const fileUrl = (p: string) => pathToFileURL(p).href; // file:///… 全编码写法

const openAt = async (file: string, server = srv): Promise<Opened & { url: string }> => {
  const r = await server.open(file);
  if (!r.ok) throw new Error(`open 失败：${r.error}`);
  const u = new URL(r.url);
  return { port: Number(u.port), host: u.host, token: u.hostname.split(".")[0], url: r.url };
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-local-html-fileurl-")));
  site = path.join(tmp, "site");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(site);
  fs.mkdirSync(outside);
  write("img/p.png", PNG);
  write("secret-out.txt", "OUTSIDE", outside);
  srv = createLocalHtmlServer();
});

afterEach(() => {
  srv.revokeAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("服务：翻译落在根目录里的 file:// 引用", () => {
  it("HTML：file:// 图片被翻译成服务自己的地址；Content-Length 与改写后的字节数一致、不宣称 Accept-Ranges；翻译后的地址真的取得到图", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>封面</title><img id="a" src="${fileUrl(path.join(site, "img/p.png"))}"><p>${site}/img/p.png</p>`;
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("file://");
    expect(r.text).toContain(`src="http://${o.host}/img/p.png"`);
    // 页面里给用户看 / 复制的普通绝对路径文本不是 file:// URL，原样
    expect(r.text).toContain(`<p>${site}/img/p.png</p>`);
    expect(Number(r.headers["content-length"])).toBe(r.bytes.length);
    expect(r.headers["accept-ranges"]).toBeUndefined();
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    // 把翻译后的地址取一遍：真的是那张图
    const img = await request(o, new URL(r.text.match(/src="([^"]+)"/)![1]).pathname);
    expect(img.status).toBe(200);
    expect(img.bytes.equals(PNG)).toBe(true);
  });

  it("根目录里有中文 / 空格，页面只编码了其中一段（和真实页面一样）：照样翻译、照样取得到", async () => {
    const dir = path.join(tmp, "我的 项目", "出版");
    const encodedMid = `file://${path.join(tmp, "我的 项目").split(path.sep).map(encodeURIComponent).join("/")}`;
    // tmp 本身是 ASCII，只有后两段是中文 / 空格：模拟「某一段被编码、其余明文」
    const uri = `${fileUrl(tmp)}/${encodeURIComponent("我的 项目")}/出版/封面 x.png`;
    write("封面 x.png", PNG, dir);
    write("index.html", `<img src="${uri}">`, dir);
    expect(encodedMid).toContain("%E6%88%91");
    const o = await openAt(path.join(dir, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.text).toBe(`<img src="http://${o.host}/封面 x.png">`);
    // 浏览器会把 src 里的空格 / 中文编码后再请求
    const img = await request(o, `/${encodeURIComponent("封面 x.png")}`);
    expect(img.status).toBe(200);
    expect(img.bytes.equals(PNG)).toBe(true);
  });

  it("CSS 的 url(file://…) 与 JS 里的 file:// 字符串也翻译；JSON / 图片等其它类型不碰", async () => {
    const u = fileUrl(path.join(site, "img/p.png"));
    write("a.css", `body{background:url(${u})}`);
    write("app.js", `const u = "${u}";`);
    write("data.json", `{"u":"${u}"}`);
    write("index.html", "<p>x</p>");
    const o = await openAt(path.join(site, "index.html"));
    expect((await request(o, "/a.css")).text).toBe(`body{background:url(http://${o.host}/img/p.png)}`);
    expect((await request(o, "/app.js")).text).toBe(`const u = "http://${o.host}/img/p.png";`);
    expect((await request(o, "/data.json")).text).toBe(`{"u":"${u}"}`);
  });

  it("每个 token 翻译成它自己的 host（同一个文件登记两次 → 两个 origin，各指各的）", async () => {
    write("index.html", `<img src="${fileUrl(path.join(site, "img/p.png"))}">`);
    const a = await openAt(path.join(site, "index.html"));
    const b = await openAt(path.join(site, "index.html"));
    expect(a.host).not.toBe(b.host);
    expect((await request(a, "/index.html")).text).toContain(`http://${a.host}/img/p.png`);
    expect((await request(b, "/index.html")).text).toContain(`http://${b.host}/img/p.png`);
    expect((await request(b, "/index.html")).text).not.toContain(a.host);
  });

  it("根目录之外的 file://（兄弟目录 / 上一级里的文件）一个字也不动", async () => {
    const out = fileUrl(path.join(outside, "secret-out.txt"));
    const up = fileUrl(path.join(tmp, "x.png"));
    const html = `<img src="${out}"><img src="${up}"><img src="file:///etc/passwd">`;
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.text).toBe(html);
    expect(r.headers["accept-ranges"]).toBe("bytes"); // 没改内容 → 原样流式路径
  });

  it("名字以根目录名开头的兄弟目录（site2）不会被当成根目录里的东西", async () => {
    const sibling = path.join(tmp, "site2");
    write("p.png", PNG, sibling);
    const html = `<img src="${fileUrl(path.join(sibling, "p.png"))}">`;
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    expect((await request(o, "/index.html")).text).toBe(html);
  });
});

describe("服务：翻译不放大页面能访问的文件集合（守卫照走）", () => {
  it("指向根目录里的敏感文件（.env / 私钥 / .git）：文本照翻译，但翻译后的请求仍 404", async () => {
    write(".env", "TOKEN=1");
    write("key.pem", "-----BEGIN PRIVATE KEY-----");
    write(".git/config", "[core]");
    const urls = [".env", "key.pem", ".git/config"].map((n) => fileUrl(path.join(site, n)));
    write("index.html", urls.map((u) => `<img src="${u}">`).join(""));
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.text).not.toContain("file://");
    for (const n of [".env", "key.pem", ".git/config"]) expect((await request(o, `/${n}`)).status, n).toBe(404);
  });

  it("`file://<根>/../x`：翻译后仍带 `..`，原始请求被拒；编码过的 `%2e%2e` 同样被拒", async () => {
    write("index.html", `<img src="${fileUrl(site)}/../outside/secret-out.txt">`);
    const o = await openAt(path.join(site, "index.html"));
    expect((await request(o, "/index.html")).text).toBe(`<img src="http://${o.host}/../outside/secret-out.txt">`);
    expect((await request(o, "/../outside/secret-out.txt")).status).toBe(404);
    expect((await request(o, "/%2e%2e/outside/secret-out.txt")).status).toBe(404);
  });

  it("翻译的范围就是根目录本身：根目录里一个图都不能翻译出根目录之外的内容", async () => {
    write("index.html", `<img src="${fileUrl(path.join(outside, "secret-out.txt"))}">`);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.text).toContain("file://"); // 没翻译
    expect((await request(o, "/secret-out.txt")).status).toBe(404);
  });

  it("单文件模式（入口目录过宽）：不翻译，同目录的兄弟文件本来就取不到", async () => {
    const home = path.join(tmp, "home");
    const dir = path.join(home, "code", ".cache", "site");
    fs.mkdirSync(dir, { recursive: true });
    const html = `<img src="${fileUrl(path.join(dir, "p.png"))}">`;
    write("index.html", html, dir);
    write("p.png", PNG, dir);
    const s = createLocalHtmlServer({ os: { ...os, homedir: () => home, tmpdir: () => path.join(tmp, "faketmp") } });
    try {
      const o = await openAt(path.join(dir, "index.html"), s);
      const r = await request(o, "/index.html");
      expect(r.text).toBe(html);
      expect((await request(o, "/p.png")).status).toBe(404);
    } finally {
      s.revokeAll();
    }
  });

  it.runIf(symlinkOk)("符号链接逃逸：翻译出的路径指向根目录里的链接、链接指向根外 → 仍 404", async () => {
    fs.symlinkSync(outside, path.join(site, "link-out"));
    write("index.html", `<img src="${fileUrl(path.join(site, "link-out", "secret-out.txt"))}">`);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.text).toContain(`http://${o.host}/link-out/secret-out.txt`);
    expect((await request(o, "/link-out/secret-out.txt")).status).toBe(404);
  });
});

describe("服务：不该改的响应与以前逐字节一致", () => {
  const htmlWithFileUrl = () => `<!doctype html><meta charset="utf-8"><img src="${fileUrl(path.join(site, "img/p.png"))}">`;

  it("没有 file:// 引用：字节完全一致，仍带 Accept-Ranges，Content-Length = 文件大小", async () => {
    const html = "<!doctype html><meta charset=\"utf-8\"><p>你好</p><img src=\"img/p.png\">";
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.bytes.equals(Buffer.from(html))).toBe(true);
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(html));
  });

  it("Range 请求：按原文件的字节给 206（不翻译）", async () => {
    const html = htmlWithFileUrl();
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html", { headers: { Range: "bytes=0-9" } });
    expect(r.status).toBe(206);
    expect(r.bytes.equals(Buffer.from(html).subarray(0, 10))).toBe(true);
    expect(r.headers["content-range"]).toBe(`bytes 0-9/${Buffer.byteLength(html)}`);
  });

  it("HEAD：Content-Length = 原文件大小、不带正文", async () => {
    const html = htmlWithFileUrl();
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(html));
    expect(r.bytes.length).toBe(0);
  });

  it("超过改写体积上限的文本：原样流式发送（不读进内存、不翻译）", async () => {
    expect(LOCAL_HTML_REWRITE_MAX_BYTES).toBe(2 * 1024 * 1024);
    const html = htmlWithFileUrl() + "x".repeat(200);
    write("index.html", html);
    const s = createLocalHtmlServer({ limits: { rewriteMaxBytes: 100 } });
    try {
      const o = await openAt(path.join(site, "index.html"), s);
      const r = await request(o, "/index.html");
      expect(r.bytes.equals(Buffer.from(html))).toBe(true);
      expect(r.headers["accept-ranges"]).toBe("bytes");
    } finally {
      s.revokeAll();
    }
  });

  it("页面声明了非 UTF-8 的 charset：不碰（不强加 utf-8、不翻译，免得把字节写坏）", async () => {
    const html = `<!doctype html><meta charset="gbk"><img src="${fileUrl(path.join(site, "img/p.png"))}">`;
    write("index.html", html);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.headers["content-type"]).toBe("text/html");
    expect(r.bytes.equals(Buffer.from(html))).toBe(true);
  });

  it("声明 UTF-8 但字节不是合法 UTF-8：不碰", async () => {
    const bad = Buffer.concat([Buffer.from(`<meta charset="utf-8"><img src="${fileUrl(path.join(site, "img/p.png"))}"><p>`), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("</p>")]);
    write("index.html", bad);
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.bytes.equals(bad)).toBe(true);
  });

  it("空文件：照常 200、长度 0", async () => {
    write("index.html", "");
    const o = await openAt(path.join(site, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBe(0);
  });
});

describe.runIf(symlinkOk)("服务：目录的别名写法", () => {
  it("用户用符号链接路径打开（alias → site）：页面里写 alias 路径或真实路径的 file:// 都翻译", async () => {
    const alias = path.join(tmp, "alias");
    fs.symlinkSync(site, alias);
    write("index.html", `<img src="${fileUrl(path.join(alias, "img/p.png"))}"><img src="${fileUrl(path.join(site, "img/p.png"))}">`);
    const o = await openAt(path.join(alias, "index.html"));
    const r = await request(o, "/index.html");
    expect(r.text).toBe(`<img src="http://${o.host}/img/p.png"><img src="http://${o.host}/img/p.png">`);
  });

  it("入口自己是指向别处的链接（links/index.html → site/index.html）：链接所在目录不算根目录，只翻译真实根目录里的", async () => {
    const links = path.join(tmp, "links");
    fs.mkdirSync(links);
    write("img/p.png", Buffer.from("other"), links); // links/img/p.png 是另一个文件
    write("index.html", `<img src="${fileUrl(path.join(links, "img/p.png"))}"><img src="${fileUrl(path.join(site, "img/p.png"))}">`);
    fs.symlinkSync(path.join(site, "index.html"), path.join(links, "index.html"));
    const o = await openAt(path.join(links, "index.html"));
    const r = await request(o, "/index.html");
    // links 下的不翻译（那是另一个文件，翻译成 site 里的同名文件会张冠李戴），site 下的翻译
    expect(r.text).toBe(`<img src="${fileUrl(path.join(links, "img/p.png"))}"><img src="http://${o.host}/img/p.png">`);
  });
});
