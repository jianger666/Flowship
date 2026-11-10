/**
 * 本地 HTML 静态服务（electron-app/browser/local-html-server.mjs）：真实临时目录 + 真实回环 http。
 * 每一条守卫都有「拒绝」用例 + 「正常放行」对照，避免守卫写成一刀切后测试还绿。
 *
 * R7 复审后的口径：token 在主机名里（`http://<token>.localhost:<port>/<文件>`，每个 token 一个 origin），Host 必须恰为
 * `<有效 token>.localhost:<port>`；连接用 127.0.0.1，Host 头由测试自己设置（浏览器里 Chromium 会把 *.localhost 解析到回环）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contentTypeOf,
  createLocalHtmlServer,
  isBroadRoot,
  isHtmlName,
  isInsideRoot,
  isSensitiveSegments,
  LOCAL_HTML_CONNECTIONS_CHECK_INTERVAL_MS,
  LOCAL_HTML_HEADERS_TIMEOUT_MS,
  LOCAL_HTML_IDLE_TTL_MS,
  LOCAL_HTML_KEEP_ALIVE_TIMEOUT_MS,
  LOCAL_HTML_MAX_AGE_MS,
  LOCAL_HTML_MAX_CONNECTIONS,
  LOCAL_HTML_MAX_FILE_BYTES,
  LOCAL_HTML_REQUEST_TIMEOUT_MS,
  parseHostToken,
  parseRange,
  parseRequestPath,
} from "../electron-app/browser/local-html-server.mjs";

type Resp = { status: number; headers: http.IncomingHttpHeaders; body: string };
type Opened = { url: string; port: number; token: string; name: string; host: string; scope: "dir" | "file" };

const request = (
  port: number,
  rawPath: string,
  opts: { host?: string; method?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
) =>
  new Promise<Resp>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: rawPath, method: opts.method ?? "GET", headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`request timeout ${opts.timeoutMs}ms`)));
    req.end();
  });

/** 对已打开的页面发请求：连 127.0.0.1，Host 用它自己的 `<token>.localhost:<port>` */
const get = (o: Pick<Opened, "port" | "host">, rawPath: string, opts: { host?: string; method?: string; headers?: Record<string, string>; timeoutMs?: number } = {}) =>
  request(o.port, rawPath, { host: o.host, ...opts });

/** 原始 socket：写一段字节，读到「静默 settleMs」为止（用来看服务端到底写了多少字节 / 有没有应答） */
const raw = (port: number, text: string, settleMs = 200) =>
  new Promise<string>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      s.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    };
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(done, settleMs);
    };
    s.on("data", (c) => {
      chunks.push(c);
      bump();
    });
    s.on("error", done);
    s.on("close", done);
    s.once("connect", () => {
      s.write(text);
      bump();
    });
  });

/** socket 在 ms 内被对端关掉了吗 */
const closedWithin = (s: net.Socket, ms: number) =>
  new Promise<boolean>((resolve) => {
    if (s.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    s.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const waitFor = async (cond: () => boolean, ms = 1500, step = 10) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
};

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

/** 这台机器有没有 IPv6 回环（没有就跳过 IPv6 的真连接用例） */
const ipv6Available = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.listen({ host: "::1", port: 0 }, () => s.close(() => resolve(true)));
});

/** 打开成功后拆出 port / token / 入口文件名 / Host */
const parseOpened = (url: string, scope: "dir" | "file" = "dir"): Opened => {
  const u = new URL(url);
  return { url, port: Number(u.port), token: u.hostname.replace(/\.localhost$/, ""), name: u.pathname.slice(1), host: u.host, scope };
};

let tmp: string;
let site: string; // 站点目录（realpath 之后）
let outside: string; // 站点之外的目录，放「不该被读到」的文件
let srv: ReturnType<typeof createLocalHtmlServer>;
const symlinkOk = process.platform !== "win32";
const posixOnly = process.platform !== "win32";

const write = (rel: string, content: string | Buffer, root = site) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

type Deps = NonNullable<Parameters<typeof createLocalHtmlServer>[0]>;
const make = (deps: Deps = {}) => createLocalHtmlServer(deps);

const fifos: string[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-local-html-")));
  site = path.join(tmp, "site");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(site);
  fs.mkdirSync(outside);
  write("secret.txt", "OUTSIDE-SECRET", outside);
  write("index.html", '<!doctype html><html><head><link rel="stylesheet" href="css/a.css"></head><body>hello 你好</body></html>');
  write("css/a.css", "body{color:red}");
  write("js/app.js", "window.__ok=1");
  write("img/p.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  srv = make();
});

afterEach(() => {
  srv.revokeAll();
  // 释放可能还卡在 open(FIFO) 上的线程池线程（被测代码正确时不会有）
  for (const f of fifos.splice(0)) {
    try {
      fs.closeSync(fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    } catch {
      /* 没有读端在等 */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const openSite = async (name = "index.html", server: ReturnType<typeof createLocalHtmlServer> = srv, root = site): Promise<Opened> => {
  const r = await server.open(path.join(root, name));
  if (!r.ok) throw new Error(`open 失败：${r.error}`);
  return parseOpened(r.url, r.scope);
};

describe("open：入口校验", () => {
  it("正常：返回 `<48 位小写 hex token>.localhost:<端口>/<文件名>`；服务此前没有监听", async () => {
    expect(srv.stats()).toEqual({ tokens: 0, port: 0 });
    const r = await srv.open(path.join(site, "index.html"));
    expect(r).toMatchObject({ ok: true, scope: "dir" });
    if (!r.ok) return;
    expect(r.url).toMatch(/^http:\/\/[0-9a-f]{48}\.localhost:\d+\/index\.html$/);
    expect(srv.stats().tokens).toBe(1);
    expect(srv.stats().port).toBeGreaterThan(0);
    expect(new URL(r.url).hostname.split(".")[0]).toHaveLength(48); // 单个 DNS label ≤ 63
  });

  it("文件名里的中文 / 空格 / 井号被编码，浏览器按编码后的地址能取到", async () => {
    write("我的 页面#1.html", "<p>x</p>");
    const o = await openSite("我的 页面#1.html");
    expect(o.name).toBe(encodeURIComponent("我的 页面#1.html"));
    expect((await get(o, `/${o.name}`)).status).toBe(200);
  });

  it.each([
    ["相对路径", "index.html"],
    ["不是 html", path.join("/", "tmp", "x.txt")],
    ["空串", ""],
    ["含 NUL", "/tmp/a\0.html"],
    ["UNC / 网络路径（//）", "//server/share/a.html"],
    ["UNC / 网络路径（\\\\）", "\\\\server\\share\\a.html"],
  ])("拒绝：%s", async (_n, p) => {
    const r = await srv.open(p);
    expect(r.ok).toBe(false);
    expect(srv.stats().tokens).toBe(0);
  });

  it.each([null, undefined, 42, {}, []])("拒绝：非字符串入参 %j", async (v) => {
    expect((await srv.open(v as never)).ok).toBe(false);
  });

  it("拒绝：文件不存在、目录叫 x.html、点开头的入口", async () => {
    expect((await srv.open(path.join(site, "nope.html"))).ok).toBe(false);
    fs.mkdirSync(path.join(site, "dir.html"));
    expect((await srv.open(path.join(site, "dir.html"))).ok).toBe(false);
    write(".hidden.html", "x");
    expect((await srv.open(path.join(site, ".hidden.html"))).ok).toBe(false);
    expect(srv.stats().tokens).toBe(0);
  });

  it("拒绝：入口过大（打开时就查）", async () => {
    const small = make({ limits: { maxFileBytes: 10 } });
    write("big.html", "x".repeat(11));
    const r = await small.open(path.join(site, "big.html"));
    expect(r.ok).toBe(false);
    small.revokeAll();
  });

  it.runIf(symlinkOk)("拒绝：名字是 .html、真实文件却是敏感文件 / 非 HTML 的符号链接（x.html -> id_rsa）", async () => {
    write("id_rsa", "PRIVATE", outside);
    fs.symlinkSync(path.join(outside, "id_rsa"), path.join(site, "evil.html"));
    expect((await srv.open(path.join(site, "evil.html"))).ok).toBe(false);
    write("data.txt", "x", outside);
    fs.symlinkSync(path.join(outside, "data.txt"), path.join(site, "evil2.html"));
    expect((await srv.open(path.join(site, "evil2.html"))).ok).toBe(false);
    expect(srv.stats().tokens).toBe(0);
  });

  it.runIf(symlinkOk)("拒绝：给的路径不是 .html（note.txt -> page.html）——按给定的路径判扩展名，不只看链接指向的真实文件", async () => {
    write("real/page.html", "<p>real</p>", outside);
    fs.symlinkSync(path.join(outside, "real", "page.html"), path.join(site, "note.txt"));
    expect((await srv.open(path.join(site, "note.txt"))).ok).toBe(false);
    expect(srv.stats().tokens).toBe(0);
  });

  it.runIf(symlinkOk)("对照：指向另一个 HTML 的符号链接允许，根目录取链接的真实所在目录", async () => {
    write("real/page.html", "<p>real</p>", outside);
    write("real/style.css", "p{}", outside);
    fs.symlinkSync(path.join(outside, "real", "page.html"), path.join(site, "link.html"));
    const o = await openSite("link.html");
    expect(o.name).toBe("page.html");
    expect((await get(o, `/style.css`)).status).toBe(200);
    expect((await get(o, `/index.html`)).status).toBe(404); // 链接所在目录（site）不在服务范围
  });

  it.runIf(posixOnly)("入口是 FIFO（叫 x.html）：open 立刻拒绝，不阻塞（stat 判断，不 open）", async () => {
    const f = path.join(site, "pipe.html");
    execFileSync("mkfifo", [f]);
    fifos.push(f);
    const t0 = Date.now();
    const r = await srv.open(f);
    expect(r).toEqual({ ok: false, error: "不是普通文件" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("UNC 拒绝发生在碰任何文件系统之前（win32 注入：fs 零调用）", async () => {
    const calls: string[] = [];
    const spy = new Proxy({}, { get: (_t, k) => () => { calls.push(String(k)); throw new Error("不该访问 fs"); } });
    const fakeFs = { promises: spy, constants: fs.constants } as never;
    const s = make({ fs: fakeFs, path: path.win32, platform: "win32" });
    for (const p of ["\\\\attacker.example\\share\\a.html", "//attacker.example/share/a.html"]) {
      expect(await s.open(p)).toEqual({ ok: false, error: "不支持网络路径" });
    }
    expect(calls).toEqual([]);
  });

  it("realpath 之后变成 UNC（映射盘符）也拒绝，且不再 stat / 起服务", async () => {
    const calls: string[] = [];
    const fakeFs = {
      promises: {
        realpath: async () => "\\\\srv\\share\\a.html",
        stat: async () => {
          calls.push("stat");
          return { isFile: () => true, size: 1 };
        },
      },
      constants: fs.constants,
    } as never;
    const s = make({ fs: fakeFs, path: path.win32, platform: "win32" });
    expect(await s.open("Z:\\a.html")).toEqual({ ok: false, error: "不支持网络路径" });
    expect(calls).toEqual([]);
    expect(s.stats().port).toBe(0);
  });
});

describe("守卫 1：只服务入口所在目录", () => {
  it("相对资源（样式 / 脚本 / 图片 / 中文子目录）正常加载，Content-Type 正确", async () => {
    write("子目录/页面.css", "x{}");
    const o = await openSite();
    const html = await get(o, `/${o.name}`);
    expect(html.status).toBe(200);
    expect(html.body).toContain("hello 你好");
    expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect((await get(o, `/css/a.css`)).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await get(o, `/js/app.js`)).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const png = await get(o, `/img/p.png`);
    expect(png.headers["content-type"]).toBe("image/png");
    expect((await get(o, `/${encodeURIComponent("子目录")}/${encodeURIComponent("页面.css")}`)).status).toBe(200);
  });

  it("根绝对路径资源（`/assets/app.js`，vite build 的默认写法）能加载：路径就是相对根目录的路径", async () => {
    write("assets/app.js", "window.__root=1");
    const o = await openSite();
    const r = await get(o, "/assets/app.js");
    expect(r.status).toBe(200);
    expect(r.body).toBe("window.__root=1");
  });

  it("不在根目录里的路径 404：根的兄弟目录、根目录自身（不列目录）", async () => {
    const o = await openSite();
    expect((await get(o, `/secret.txt`)).status).toBe(404);
    expect((await get(o, `/`)).status).toBe(404);
    expect((await get(o, `/../outside/secret.txt`)).status).toBe(404);
  });

  it("不列目录：目录请求（带 / 或不带）一律 404", async () => {
    const o = await openSite();
    expect((await get(o, `/css`)).status).toBe(404);
    expect((await get(o, `/css/`)).status).toBe(404);
  });

  it.runIf(symlinkOk)("符号链接逃逸：指向根外文件 / 根外目录 → 404；指向根内的普通文件 → 放行", async () => {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(site, "link.txt"));
    fs.symlinkSync(outside, path.join(site, "linkdir"));
    fs.symlinkSync(path.join(site, "css", "a.css"), path.join(site, "inner.css"));
    const o = await openSite();
    for (const p of ["link.txt", "linkdir/secret.txt"]) {
      const r = await get(o, `/${p}`);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain("OUTSIDE-SECRET");
    }
    const inner = await get(o, `/inner.css`);
    expect(inner.status).toBe(200);
    expect(inner.body).toBe("body{color:red}");
  });

  it.runIf(symlinkOk)("realpath 之后到 open 之间末级被换成指向根外的链接：O_NOFOLLOW 让 open 失败 → 404（不泄漏）", async () => {
    const target = path.join(site, "swap.txt");
    write("swap.txt", "INSIDE");
    let swapped = 0;
    const fakeFs = {
      ...fs,
      promises: {
        ...fs.promises,
        realpath: async (p: string) => {
          const real = await fs.promises.realpath(p);
          if (real === target && swapped === 0) {
            swapped += 1;
            fs.unlinkSync(target);
            fs.symlinkSync(path.join(outside, "secret.txt"), target);
          }
          return real;
        },
      },
    } as never;
    const s = make({ fs: fakeFs });
    const o = await openSite("index.html", s);
    const r = await get(o, "/swap.txt");
    expect(swapped).toBe(1);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("OUTSIDE-SECRET");
    s.revokeAll();
  });

  it("前缀陷阱：兄弟目录名以根目录名为前缀（site 与 site-evil）不算在根里", () => {
    expect(isInsideRoot("/a/site", "/a/site-evil/x")).toBe(false);
    expect(isInsideRoot("/a/site", "/a/site/x")).toBe(true);
    expect(isInsideRoot("/a/site", "/a/site")).toBe(true);
    expect(isInsideRoot("/a/site", "/a/other")).toBe(false);
    expect(isInsideRoot("/a/site", "/a")).toBe(false);
  });

  it("win32：realpath 落到别的盘符 → 404，且根本不去 open（posix 下被点开头规则兜底，这里 win32 的 relative 返回绝对路径，只有范围守卫能拦）", async () => {
    const opened: string[] = [];
    const fakeFs = {
      promises: {
        realpath: async (p: string) => (p.endsWith("x.css") ? "D:\\other\\x.css" : p),
        stat: async () => ({ isFile: () => true, size: 10 }),
        open: async (p: string) => {
          opened.push(p);
          throw new Error("不该走到 open");
        },
      },
      constants: fs.constants,
    } as never;
    const fakeOs = { ...os, homedir: () => "C:\\Users\\Me", tmpdir: () => "C:\\Users\\Me\\AppData\\Local\\Temp" } as typeof os;
    const s = make({ fs: fakeFs, path: path.win32, platform: "win32", os: fakeOs });
    const r = await s.open("C:\\work\\site\\index.html");
    expect(r).toMatchObject({ ok: true, scope: "dir" });
    if (!r.ok) return;
    const o = parseOpened(r.url);
    const res = await get(o, "/x.css");
    expect(res.status).toBe(404);
    expect(opened).toEqual([]);
    s.revokeAll();
  });
});

describe("守卫 1b：入口所在目录过宽 → 单文件模式", () => {
  const fakeOs = (home: string) => ({ ...os, homedir: () => home, tmpdir: () => path.join(tmp, "faketmp") }) as typeof os;

  it("HTML 直接放在家目录 / 桌面 / 临时目录：scope=file，只服务入口自己，旁边的文件 404", async () => {
    const home = path.join(tmp, "home");
    for (const dir of [home, path.join(home, "Desktop"), path.join(home, "Downloads"), path.join(tmp, "faketmp")]) {
      fs.mkdirSync(dir, { recursive: true });
      write("index.html", "<p>solo</p>", dir);
      write("style.css", "p{}", dir);
      write("notes.txt", "private notes", dir);
      const s = make({ os: fakeOs(home) });
      const o = await openSite("index.html", s, dir);
      expect(o.scope, dir).toBe("file");
      expect((await get(o, `/index.html`)).status).toBe(200);
      for (const other of ["style.css", "notes.txt"]) expect((await get(o, `/${other}`)).status, `${dir}/${other}`).toBe(404);
      s.revokeAll();
    }
  });

  it("对照：家目录下更深一层的项目目录仍是 scope=dir", async () => {
    const home = path.join(tmp, "home");
    const proj = path.join(home, "Documents", "site");
    fs.mkdirSync(proj, { recursive: true });
    write("index.html", "<p>x</p>", proj);
    write("a.css", "p{}", proj);
    const s = make({ os: fakeOs(home) });
    const o = await openSite("index.html", s, proj);
    expect(o.scope).toBe("dir");
    expect((await get(o, `/a.css`)).status).toBe(200);
    s.revokeAll();
  });

  it("家目录下点开头的祖先（~/.ssh、~/.aws/sso/cache）里的 HTML：scope=file，凭据文件取不到", async () => {
    const home = path.join(tmp, "home");
    for (const rel of [".ssh", ".aws/sso/cache"]) {
      const dir = path.join(home, rel);
      fs.mkdirSync(dir, { recursive: true });
      write("page.html", "<p>x</p>", dir);
      write("id_rsa_work", "PRIVATE-KEY", dir);
      write("token.json", '{"accessToken":"SECRET"}', dir);
      const s = make({ os: fakeOs(home) });
      const o = await openSite("page.html", s, dir);
      expect(o.scope, rel).toBe("file");
      for (const f of ["id_rsa_work", "token.json"]) {
        const r = await get(o, `/${f}`);
        expect(r.status, `${rel}/${f}`).toBe(404);
        expect(r.body).not.toMatch(/PRIVATE-KEY|SECRET/);
      }
      s.revokeAll();
    }
  });

  it("isBroadRoot 真值表（posix，有 home）", () => {
    const deps = { path: path.posix, home: "/Users/me", tmp: "/private/var/folders/ab/cd/T", platform: "linux" };
    const broad = [
      "/", "/tmp", "/Users", "/home", "/opt", "/Users/me", "/Users/me/Desktop", "/Users/me/Documents", "/Users/me/Downloads", "/Users/me/Pictures",
      "/Users/other", "/home/bob", "/var/tmp", "/private/var/folders/ab/cd/T",
      // ~/Library 整棵子树（Flowship 自己的数据目录在这里面）
      "/Users/me/Library", "/Users/me/Library/Application Support/fe-ai-flow/data/tasks/t1", "/Users/me/Library/CloudStorage/Dropbox-X/site", "/Users/me/Library/Mobile Documents/com~apple~CloudDocs",
      // 点开头的祖先
      "/Users/me/.ssh", "/Users/me/.aws/sso/cache", "/Users/me/.config/gcloud", "/Users/me/.cursor/projects/x/agent-transcripts", "/Users/me/.docker", "/Users/me/.kube",
      // 同步盘根（前缀、恰好这一层）
      "/Users/me/iCloudDrive", "/Users/me/Dropbox", "/Users/me/Dropbox (Personal)", "/Users/me/OneDrive - Corp", "/Users/me/OneDrive", "/Users/me/Google Drive",
      // 挂载点根
      "/Volumes/Data", "/mnt/disk", "/media/bob/USB", "/run/media/bob/USB",
    ];
    for (const d of broad) expect(isBroadRoot(d, deps), d).toBe(true);
    const normal = [
      "/Users/me/Documents/site", "/Users/me/proj", "/Users/me/work/site", "/opt/app/data", "/Users/other/proj", "/tmp/sub/site",
      "/Users/me/Dropbox/site", "/Users/me/iCloudDrive/web", "/Users/me/OneDrive - Corp/proj",
      "/Volumes/Data/site", "/mnt/disk/site", "/media/bob/USB/site", "/run/media/bob/USB/site",
    ];
    for (const d of normal) expect(isBroadRoot(d, deps), d).toBe(false);
  });

  it("isBroadRoot：取不到家目录（home 为空串）时，其它用户的家目录 / 挂载点根 / 根的一级子目录仍判过宽", () => {
    const deps = { path: path.posix, home: "", tmp: "", platform: "linux" };
    for (const d of ["/Users/me", "/home/bob", "/Volumes/Data", "/mnt/disk", "/media/bob/USB", "/opt"]) expect(isBroadRoot(d, deps), d).toBe(true);
    for (const d of ["/Users/me/proj", "/srv/app/site"]) expect(isBroadRoot(d, deps), d).toBe(false);
  });

  it("isBroadRoot 真值表（win32，大小写不敏感）", () => {
    const deps = { path: path.win32, home: "C:\\Users\\Me", tmp: "C:\\Users\\Me\\AppData\\Local\\Temp", platform: "win32" };
    const broad = [
      "C:\\", "C:\\Users", "D:\\site", "C:\\Users\\Me", "c:\\users\\me\\desktop", "C:\\Users\\Me\\Downloads", "C:\\Users\\Other", "C:\\Users\\Me\\AppData\\Local\\Temp",
      "C:\\Users\\Me\\AppData\\Roaming\\x", "C:\\Users\\Me\\appdata\\local\\x", "C:\\Users\\Me\\OneDrive - Corp", "C:\\Users\\Me\\.ssh",
    ];
    for (const d of broad) expect(isBroadRoot(d, deps), d).toBe(true);
    for (const d of ["C:\\Users\\Me\\proj", "C:\\work\\site", "D:\\data\\site", "C:\\Users\\Me\\OneDrive - Corp\\site"]) expect(isBroadRoot(d, deps), d).toBe(false);
  });
});

describe("守卫 3：路径逐段校验（遍历 / 编码 / 分隔符）", () => {
  it.each([
    ["../ 逃逸", "/../secret.txt"],
    ["先下探再上跳（即使仍在根内也拒）", "/css/../index.html"],
    ["编码的 ..", "/%2e%2e/secret.txt"],
    ["编码的 ../", "/..%2fsecret.txt"],
    ["大写编码", "/%2E%2E%2Fsecret.txt"],
    ["单点段", "/./index.html"],
    ["反斜杠", "/css%5Ca.css"],
    ["字面反斜杠（编码前）", "/css\\a.css"],
    ["NUL", "/index.html%00.png"],
    ["编码斜杠", "/css%2Fa.css"],
    ["空段", "//index.html"],
    ["残缺的百分号编码", "/%E0%A4%A.html"],
  ])("%s → 404 且读不到根外内容", async (_n, tail) => {
    const o = await openSite();
    let r: Resp;
    try {
      r = await get(o, tail);
    } catch {
      return; // Node 客户端自己就拒绝发这种路径：同样没有读到内容
    }
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("OUTSIDE-SECRET");
  });

  it("对照：合法的编码（空格 / 中文）可以正常取到", async () => {
    write("a b/中文.txt", "ok");
    const o = await openSite();
    const r = await get(o, `/a%20b/${encodeURIComponent("中文.txt")}`);
    expect(r.status).toBe(200);
    expect(r.body).toBe("ok");
  });

  it("查询串 / 片段不影响取文件", async () => {
    const o = await openSite();
    expect((await get(o, `/css/a.css?v=123`)).status).toBe(200);
    expect((await get(o, `/css/a.css?x=../../secret.txt`)).status).toBe(200);
  });

  it("parseRequestPath 纯函数：解码 / 空段 / Windows 保留字符 / 长度边界（4096 字符以内放行，超过拒绝）", () => {
    expect(parseRequestPath(`/a/b.css?x=1`)).toEqual(["a", "b.css"]);
    expect(parseRequestPath(`/${encodeURIComponent("中 文.css")}`)).toEqual(["中 文.css"]);
    for (const bad of [`/`, `/a/`, `/a//b`, `no-slash`, "", `/../a`, `/a/../b`, `/%2e%2e/a`, `//`, `/?x=1`]) {
      expect(parseRequestPath(bad), bad).toBeNull();
    }
    for (const bad of [`/a%00.png`, `/a%5Cb`, `/a%2Fb`, `/%2E%2E`, `/%2e`, `/a/%2e%2e/b`, `/%E0%A4%A`]) expect(parseRequestPath(bad), bad).toBeNull();
    expect(parseRequestPath(`/a:b.txt`, { platform: "win32" })).toBeNull();
    expect(parseRequestPath(`/a:b.txt`, { platform: "linux" })).toEqual(["a:b.txt"]);
    expect(parseRequestPath(`/trail.`, { platform: "win32" })).toBeNull();
    expect(parseRequestPath(42 as never)).toBeNull();
    // 长度：恰为 4096（"/" + 4095 个字符）放行，4097 拒绝——拒绝的原因必须是长度，不是别的形状问题
    expect(parseRequestPath(`/${"a".repeat(4095)}`)).toEqual(["a".repeat(4095)]);
    expect(parseRequestPath(`/${"a".repeat(4096)}`)).toBeNull();
    expect(parseRequestPath(`/${"a".repeat(5000)}`)).toBeNull();
  });
});

describe("守卫 4：敏感文件", () => {
  const BLOCKED = [
    ".env",
    ".env.local",
    ".git/config",
    ".ssh/id_rsa",
    "sub/.hidden/a.txt",
    "sub/.DS_Store",
    "server.pem",
    "sub/private.key",
    "cert.p12",
    "cert.PFX",
    "id_rsa",
    "id_ed25519.pub",
    "id_rsa_work",
    "id_ed25519_sk",
    "known_hosts",
    "authorized_keys",
    "_netrc",
    "credentials.json",
    "credentials",
    "secrets.yml",
    "secret.json",
    "service-account-prod.json",
    "serviceaccount.json",
    // R7-05：补全
    "foo.env",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "prod.tfvars",
    "prod.auto.tfvars.json",
    "work.ovpn",
    "svc.keytab",
    "kubeconfig",
    "kubeconfig.yaml",
    "dev.kubeconfig",
    "firebase-adminsdk-abc12.json",
    "client_secret_123.apps.googleusercontent.com.json",
    "client-secret.json",
    "aws-credentials.json",
    "gcp_credentials.yml",
    // 大小写不敏感（大小写敏感的文件系统上这些就是不同的真文件）
    "ID_RSA",
    "Credentials.JSON",
    "SECRETS.YML",
    "Server.PEM",
    // 每条正则各一个大写样本（去掉任何一条的 /i 标志都要红）
    "TERRAFORM.TFSTATE",
    "Terraform.TfState.Backup",
    "PROD.TFVARS",
    "Prod.Auto.TfVars.JSON",
    "Known_Hosts",
    "AUTHORIZED_KEYS",
    "_NETRC",
    "KUBECONFIG",
    "KubeConfig.YAML",
    "Dev.KubeConfig",
    "AWS-Credentials.JSON",
    "Client_Secret_1.JSON",
    "FIREBASE-ADMINSDK-ABC12.JSON",
    "Service-Account-Prod.json",
    "ServiceAccount.JSON",
    "WORK.OVPN",
    "SVC.KEYTAB",
    "FOO.ENV",
  ];
  it.each(BLOCKED)("%s → 404（文件确实存在）", async (rel) => {
    write(rel, "TOP-SECRET-CONTENT");
    const o = await openSite();
    const r = await get(o, `/${rel.split("/").map(encodeURIComponent).join("/")}`);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("TOP-SECRET-CONTENT");
  });

  it.each(["p8", "jks", "keystore", "kdbx", "ppk", "gpg", "pgp", "ovpn", "keytab", "env", "pem", "key", "p12", "pfx"])("扩展名 .%s → 404（逐个扩展名钉住）", async (ext) => {
    write(`secret-data.${ext}`, "TOP-SECRET-CONTENT");
    const o = await openSite();
    const r = await get(o, `/secret-data.${ext}`);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("TOP-SECRET-CONTENT");
  });

  it.runIf(symlinkOk)("根内的符号链接指向根内的敏感文件（a.txt -> .env）：查 realpath 之后的路径，404", async () => {
    write(".env", "TOP-SECRET-CONTENT");
    fs.symlinkSync(path.join(site, ".env"), path.join(site, "innocent.txt"));
    const o = await openSite();
    const r = await get(o, `/innocent.txt`);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("TOP-SECRET-CONTENT");
  });

  it.runIf(symlinkOk)("点开头的符号链接指向普通文件（.hidden-link -> a.css）：请求路径上就带点，直接 404（不靠 realpath 之后的检查）", async () => {
    fs.symlinkSync(path.join(site, "css", "a.css"), path.join(site, ".hidden-link"));
    const o = await openSite();
    expect((await get(o, `/.hidden-link`)).status).toBe(404);
    expect((await get(o, `/css/a.css`)).status).toBe(200); // 对照：链接指向的普通文件本身可取
  });

  it("放行样本（不误伤前端常见文件）：令牌 / 环境 / 钥匙 / 键盘 / 圣诞 / id_ 开头 / 表单样式 …", async () => {
    const OK = [
      "tokens.json", "env.js", "environment.js", "key.png", "keyboard.css", "secret-santa.html", "id_map.js", "identity.css",
      "credentials-form.css", "credentials.html", "secrets-manager.html", "monkey.txt", "notes.pem.txt", "terraform.html", "primary-key.svg",
      "kubeconfig-guide.html", "my_id_rsa.txt", "private-key-guide.md", "firebase.json", "client.json", "account.json", "service.json",
    ];
    for (const f of OK) write(f, "ok");
    write("secret.html", "<p>ok</p>");
    const o = await openSite("secret.html");
    for (const f of [...OK, "secret.html"]) expect((await get(o, `/${f}`)).status, f).toBe(200);
  });

  it("isSensitiveSegments / isHtmlName 纯函数", () => {
    expect(isSensitiveSegments([".env"])).toBe(true);
    expect(isSensitiveSegments(["a", ".git", "x"])).toBe(true);
    expect(isSensitiveSegments(["a", "b.pem"])).toBe(true);
    expect(isSensitiveSegments(["a", "b.txt"])).toBe(false);
    expect(isSensitiveSegments(["id_rsa"])).toBe(true);
    expect(isSensitiveSegments(["ID_RSA"])).toBe(true);
    expect(isSensitiveSegments(["Credentials.JSON"])).toBe(true);
    expect(isSensitiveSegments(["my_id_rsa.txt"])).toBe(false);
    expect(isSensitiveSegments([])).toBe(false);
    expect(isHtmlName("a.HTML")).toBe(true);
    expect(isHtmlName("a.htm")).toBe(true);
    expect(isHtmlName("a.html.txt")).toBe(false);
    expect(isHtmlName(1 as never)).toBe(false);
  });
});

describe("守卫 5：只读（方法）", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s → 405，不返回内容、不带 CORS 头", async (method) => {
    const o = await openSite();
    const r = await get(o, `/${o.name}`, { method });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET, HEAD");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.body).not.toContain("hello");
  });

  it("HEAD：200、有 Content-Length、没有 body（原始字节上也没有）", async () => {
    const o = await openSite();
    const r = await get(o, `/css/a.css`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe(String("body{color:red}".length));
    expect(r.body).toBe("");
    // Node 客户端对 HEAD 会丢掉任何 body；直接看 socket 上到底收到了什么
    const bytes = await raw(o.port, `HEAD /css/a.css HTTP/1.1\r\nHost: ${o.host}\r\nConnection: close\r\n\r\n`);
    expect(bytes.startsWith("HTTP/1.1 200")).toBe(true);
    expect(bytes.endsWith("\r\n\r\n")).toBe(true);
    expect(bytes).not.toContain("body{color:red}");
  });
});

describe("守卫 6：Host 校验（防 DNS 重绑定 / 把请求归属到 token）与跨站", () => {
  it("对照：Host 恰为 <有效 token>.localhost:<port> → 200", async () => {
    const o = await openSite();
    expect((await get(o, `/${o.name}`)).status).toBe(200);
  });

  it("所有其它写法一律 403（不能放宽成后缀匹配 / 大小写不敏感 / 省略端口 / 带点）", async () => {
    const o = await openSite();
    const other = "b".repeat(48);
    const variants = [
      `127.0.0.1:${o.port}`,
      `localhost:${o.port}`,
      `[::1]:${o.port}`,
      `${o.token}.localhost`, // 缺端口
      `${o.token}.localhost:${o.port + 1}`, // 端口不对
      `${o.token}.localhost:0${o.port}`, // 前导零
      `${o.token}.localhost.:${o.port}`, // 末尾点
      `${o.token.toUpperCase()}.localhost:${o.port}`, // 大写 token
      `${o.token}.LOCALHOST:${o.port}`, // 大写后缀
      `a.${o.token}.localhost:${o.port}`, // 多一级子域
      `x${o.token}.localhost:${o.port}`, // 多一个字符
      `${o.token.slice(1)}.localhost:${o.port}`, // 少一个字符
      `${o.token}.localhost:${o.port}.evil.com`,
      `${o.token}.evil.com:${o.port}`,
      `${o.token}.localhost:${o.port}, evil.com`,
      `${other}.localhost:${o.port}`, // 形状对但不是有效 token
      `evil.example.com:${o.port}`,
      "",
    ];
    for (const host of variants) {
      const r = await get(o, `/${o.name}`, { host });
      expect(r.status, `Host: ${host}`).toBe(403);
      expect(r.body, `Host: ${host}`).not.toContain("hello");
    }
  });

  it("没有 Host 头（HTTP/1.0）→ 403", async () => {
    const o = await openSite();
    const bytes = await raw(o.port, `GET /${o.name} HTTP/1.0\r\n\r\n`);
    expect(bytes.startsWith("HTTP/1.1 403")).toBe(true);
    expect(bytes).not.toContain("hello");
  });

  it("token 从 query / header / cookie 里带不算数（只认 Host）", async () => {
    const o = await openSite();
    const r = await get(o, `/${o.name}?token=${o.token}`, { host: `127.0.0.1:${o.port}`, headers: { "X-Token": o.token, Cookie: `t=${o.token}` } });
    expect(r.status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site → 403；same-origin / none / 没带 → 200", async () => {
    const o = await openSite();
    expect((await get(o, `/${o.name}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    for (const v of ["same-origin", "none"]) expect((await get(o, `/${o.name}`, { headers: { "Sec-Fetch-Site": v } })).status, v).toBe(200);
  });

  it("parseHostToken 纯函数", () => {
    const t = "0123456789abcdef".repeat(3);
    expect(parseHostToken(`${t}.localhost:1234`, 1234)).toBe(t);
    expect(parseHostToken(`${t}.localhost:1234`, 1235)).toBeNull();
    expect(parseHostToken(`${t}.localhost`, 1234)).toBeNull();
    expect(parseHostToken(`${t.toUpperCase()}.localhost:1234`, 1234)).toBeNull();
    expect(parseHostToken(undefined, 1234)).toBeNull();
    expect(parseHostToken(42 as never, 1234)).toBeNull();
  });
});

describe("守卫 7：响应头", () => {
  it("成功与失败的响应都带安全头，且没有任何 CORS 放行头", async () => {
    const o = await openSite();
    for (const p of [`/${o.name}`, `/nope.txt`]) {
      const r = await get(o, p, { headers: { Origin: "http://evil.example" } });
      expect(r.headers["x-content-type-options"], p).toBe("nosniff");
      expect(r.headers["cross-origin-resource-policy"], p).toBe("same-origin");
      expect(r.headers["cache-control"], p).toBe("no-store");
      expect(r.headers["referrer-policy"], p).toBe("no-referrer");
      expect(r.headers["access-control-allow-origin"], p).toBeUndefined();
      expect(r.headers["access-control-allow-credentials"], p).toBeUndefined();
    }
  });

  it("没有 CSP sandbox（和 CORP: same-origin 冲突，页面会坏）", async () => {
    const o = await openSite();
    expect((await get(o, `/${o.name}`)).headers["content-security-policy"]).toBeUndefined();
  });

  it("所有拒绝（缺文件 / 敏感 / 逃逸）返回同一个 404 响应体", async () => {
    write(".env", "x");
    const o = await openSite();
    const bodies = new Set<string>();
    for (const p of [`/nope`, `/.env`, `/%2e%2e/x`, `/css`]) {
      const r = await get(o, p);
      expect(r.status, p).toBe(404);
      bodies.add(r.body);
    }
    expect([...bodies]).toEqual(["Not Found"]);
  });

  it("charset：没声明 → utf-8（中文不乱码）；声明了非 utf-8（gbk）→ 不在响应头里强加 utf-8", async () => {
    write("plain.html", "<p>x</p>");
    write("gbk.html", '<meta charset="gbk"><p>x</p>');
    write("u8.html", '<meta charset="UTF-8"><p>x</p>');
    const o = await openSite("plain.html");
    expect((await get(o, `/plain.html`)).headers["content-type"]).toBe("text/html; charset=utf-8");
    expect((await get(o, `/gbk.html`)).headers["content-type"]).toBe("text/html");
    expect((await get(o, `/u8.html`)).headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("未知扩展名 → octet-stream（配合 nosniff 不让浏览器猜）；contentTypeOf 真值", () => {
    expect(contentTypeOf("a.unknownext")).toBe("application/octet-stream");
    expect(contentTypeOf("noext")).toBe("application/octet-stream");
    expect(contentTypeOf("A.PNG")).toBe("image/png");
    expect(contentTypeOf("a.woff2")).toBe("font/woff2");
  });
});

describe("守卫 8：大小上限", () => {
  it("子资源超过上限 → 413；没超 → 200；空文件 → 200 空 body", async () => {
    const s = make({ limits: { maxFileBytes: 1000 } });
    write("small.bin", "x".repeat(1000));
    write("big.bin", "x".repeat(1001));
    write("empty.txt", "");
    const o = await openSite("index.html", s);
    expect((await get(o, `/small.bin`)).status).toBe(200);
    expect((await get(o, `/big.bin`)).status).toBe(413);
    const e = await get(o, `/empty.txt`);
    expect(e.status).toBe(200);
    expect(e.body).toBe("");
    s.revokeAll();
  });

  it("读的过程中文件被追加：发出去的字节数仍等于 Content-Length（end 钉在 fstat 的大小上）", async () => {
    const size = 4 * 1024 * 1024;
    const file = write("grow.bin", Buffer.alloc(size, 0x61));
    const o = await openSite();
    const outcome = await new Promise<{ received: number; declared: number; error?: string }>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: o.port, path: "/grow.bin", headers: { Host: o.host } }, (res) => {
        const declared = Number(res.headers["content-length"]);
        let received = 0;
        let appended = false;
        res.on("data", (c: Buffer) => {
          received += c.length;
          if (!appended) {
            appended = true;
            res.pause();
            fs.appendFileSync(file, Buffer.alloc(size, 0x62));
            setTimeout(() => res.resume(), 50);
          }
        });
        res.on("end", () => resolve({ received, declared }));
        res.on("error", (e) => resolve({ received, declared, error: String(e) }));
      });
      req.on("error", (e) => resolve({ received: -1, declared: -1, error: String(e) }));
      req.end();
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.declared).toBe(size);
    expect(outcome.received).toBe(size);
  }, 15000);
});

describe("Range（<audio> / <video> 拖进度条）", () => {
  const body = "0123456789".repeat(10); // 100 字节

  it("200 / 206 都声明 Accept-Ranges: bytes；404 / 403 不声明", async () => {
    write("m.bin", body);
    const o = await openSite();
    expect((await get(o, `/m.bin`)).headers["accept-ranges"]).toBe("bytes");
    expect((await get(o, `/m.bin`, { headers: { Range: "bytes=0-9" } })).headers["accept-ranges"]).toBe("bytes");
    expect((await get(o, `/nope.bin`)).headers["accept-ranges"]).toBeUndefined();
    expect((await get(o, `/m.bin`, { host: `127.0.0.1:${o.port}` })).headers["accept-ranges"]).toBeUndefined();
  });

  it.each([
    ["bytes=0-9", 0, 9],
    ["bytes=10-19", 10, 19],
    ["bytes=95-", 95, 99],
    ["bytes=-5", 95, 99],
    ["bytes=90-1000", 90, 99], // 终点超出：截到文件末尾
    ["bytes=-1000", 0, 99], // 后缀超出：整个文件
    ["bytes=99-99", 99, 99],
  ])("Range: %s → 206 + 正确的 Content-Range / Content-Length / 内容", async (range, start, end) => {
    write("m.bin", body);
    const o = await openSite();
    const r = await get(o, `/m.bin`, { headers: { Range: range } });
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes ${start}-${end}/100`);
    expect(r.headers["content-length"]).toBe(String(end - start + 1));
    expect(r.body).toBe(body.slice(start, end + 1));
  });

  it.each(["bytes=100-", "bytes=500-600", "bytes=-0"])("Range: %s（取不到）→ 416 + Content-Range: bytes */100", async (range) => {
    write("m.bin", body);
    const o = await openSite();
    const r = await get(o, `/m.bin`, { headers: { Range: range } });
    expect(r.status).toBe(416);
    expect(r.headers["content-range"]).toBe("bytes */100");
    expect(r.body).toBe("");
  });

  it.each(["bytes=0-1,5-6", "items=0-5", "bytes=abc", "bytes=5-2", "bytes=-", "garbage", "bytes=0-9x"])(
    "语法不对 / 多段 / 别的单位（%s）→ 忽略 Range，200 整个文件",
    async (range) => {
      write("m.bin", body);
      const o = await openSite();
      const r = await get(o, `/m.bin`, { headers: { Range: range } });
      expect(r.status, range).toBe(200);
      expect(r.body).toBe(body);
    },
  );

  it("If-Range（我们没有校验器可比）→ 忽略 Range，200 整个文件；HEAD 带 Range 也是 200 整个文件的头", async () => {
    write("m.bin", body);
    const o = await openSite();
    const r = await get(o, `/m.bin`, { headers: { Range: "bytes=0-9", "If-Range": '"abc"' } });
    expect(r.status).toBe(200);
    expect(r.body).toBe(body);
    const h = await get(o, `/m.bin`, { method: "HEAD", headers: { Range: "bytes=0-9" } });
    expect(h.status).toBe(200);
    expect(h.headers["content-length"]).toBe("100");
  });

  it("Range 不绕过任何守卫：敏感文件 / 根外 / 超大文件照样 404 / 413", async () => {
    write(".env", body);
    write("big.bin", "x".repeat(2000));
    const s = make({ limits: { maxFileBytes: 1000 } });
    const o = await openSite("index.html", s);
    expect((await get(o, `/.env`, { headers: { Range: "bytes=0-9" } })).status).toBe(404);
    expect((await get(o, `/%2e%2e/outside/secret.txt`, { headers: { Range: "bytes=0-9" } })).status).toBe(404);
    expect((await get(o, `/big.bin`, { headers: { Range: "bytes=0-9" } })).status).toBe(413);
    s.revokeAll();
  });

  it("空文件：任何 Range 都是 416；不带 Range 是 200 空 body", async () => {
    write("empty.bin", "");
    const o = await openSite();
    expect((await get(o, `/empty.bin`, { headers: { Range: "bytes=0-" } })).status).toBe(416);
    expect((await get(o, `/empty.bin`, { headers: { Range: "bytes=-5" } })).status).toBe(416);
    expect((await get(o, `/empty.bin`)).status).toBe(200);
  });

  it("parseRange 纯函数边界", () => {
    expect(parseRange("bytes=0-0", 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=1-", 1)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-1", 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange("BYTES=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange(5 as never, 10)).toBeNull();
    expect(parseRange("bytes=99999999999999999999-", 10)).toBeNull(); // 超出安全整数：当语法无效忽略
  });
});

describe("守卫 2：token 与服务生命周期", () => {
  it("每次 open 的 token 都不同、共用一个服务；错 token 的 Host → 403", async () => {
    const a = await openSite();
    const b = await openSite();
    expect(a.token).not.toBe(b.token);
    expect(a.port).toBe(b.port);
    expect((await get(a, `/index.html`, { host: `${"b".repeat(48)}.localhost:${a.port}` })).status).toBe(403);
    expect((await get(a, `/index.html`, { host: `${a.token.slice(0, 47)}.localhost:${a.port}` })).status).toBe(403);
  });

  it("只绑回环：127.0.0.1 随机端口；同端口再试 [::1]；不绑 localhost / 0.0.0.0 / ::", async () => {
    const seen: Array<{ host: string; port: number }> = [];
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        const listen = s.listen.bind(s);
        (s as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          seen.push(a[0] as { host: string; port: number });
          return listen(...(a as Parameters<typeof listen>));
        };
        return s;
      },
    } as typeof http;
    const s = make({ http: spyHttp });
    const o = await openSite("index.html", s);
    expect(seen[0]).toEqual({ host: "127.0.0.1", port: 0 });
    expect(seen[1]).toEqual({ host: "::1", port: o.port });
    expect(seen).toHaveLength(2);
    s.revokeAll();
  });

  it("滑动空闲过期：恰好 30 分钟仍有效；多 1ms → 404 且服务关闭；中途访问会续期", async () => {
    let t = 1_000_000;
    const s = make({ now: () => t });
    const o = await openSite("index.html", s);
    t += LOCAL_HTML_IDLE_TTL_MS - 1000;
    expect((await get(o, `/css/a.css`)).status).toBe(200); // 续期
    t += LOCAL_HTML_IDLE_TTL_MS - 1000;
    expect((await get(o, `/css/a.css`)).status).toBe(200); // 又续期
    t += LOCAL_HTML_IDLE_TTL_MS; // 恰好等于 TTL：还没过期
    expect((await get(o, `/css/a.css`)).status).toBe(200);
    t += LOCAL_HTML_IDLE_TTL_MS + 1;
    expect((await get(o, `/css/a.css`)).status).toBe(404);
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
    expect(await portOpen(o.port)).toBe(false);
    s.revokeAll();
  });

  it("绝对上限：一直在用，恰好 4 小时仍有效，多 1ms 过期", async () => {
    const t0 = 1_000_000;
    let t = t0;
    const s = make({ now: () => t });
    const o = await openSite("index.html", s);
    while (t - t0 + (LOCAL_HTML_IDLE_TTL_MS - 60_000) < LOCAL_HTML_MAX_AGE_MS) {
      t += LOCAL_HTML_IDLE_TTL_MS - 60_000; // 每次都在空闲期内
      expect((await get(o, `/css/a.css`)).status).toBe(200);
    }
    t = t0 + LOCAL_HTML_MAX_AGE_MS; // 恰好 4 小时
    expect((await get(o, `/css/a.css`)).status).toBe(200);
    t = t0 + LOCAL_HTML_MAX_AGE_MS + 1;
    expect((await get(o, `/css/a.css`)).status).toBe(404);
    s.revokeAll();
  });

  it("sweep：过期的清掉，一个有效的都不剩就关服务；之后再 open 能重新起来", async () => {
    let t = 1_000_000;
    const s = make({ now: () => t });
    const o = await openSite("index.html", s);
    expect(await portOpen(o.port)).toBe(true);
    t += LOCAL_HTML_IDLE_TTL_MS + 1;
    s.sweep();
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
    expect(await portOpen(o.port)).toBe(false);
    const again = await openSite("index.html", s);
    expect((await get(again, `/${again.name}`)).status).toBe(200);
    s.revokeAll();
  });

  it("revokeAll：全部撤销并关服务", async () => {
    const o = await openSite();
    srv.revokeAll();
    expect(srv.stats()).toEqual({ tokens: 0, port: 0 });
    expect(await portOpen(o.port)).toBe(false);
  });

  it("revokeAll 强断在途连接（不只是关监听 / 空闲连接）：正在下载的大文件连接被断开", async () => {
    write("huge.bin", Buffer.alloc(32 * 1024 * 1024, 1));
    const o = await openSite();
    const sock = net.connect({ host: "127.0.0.1", port: o.port });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.pause(); // 不读：服务端的响应卡在背压上，连接一直是「在途」
    sock.write(`GET /huge.bin HTTP/1.1\r\nHost: ${o.host}\r\n\r\n`);
    await sleep(150);
    srv.revokeAll();
    // 恢复读取，把已经在内核缓冲里的字节读完：强断 = 连接很快关闭，而且没把 32MB 发完；优雅关闭则会一直发完并保持连接
    let received = 0;
    sock.on("data", (c: Buffer) => {
      received += c.length;
    });
    sock.resume();
    expect(await closedWithin(sock, 1500)).toBe(true);
    expect(received).toBeLessThan(32 * 1024 * 1024);
    sock.destroy();
  }, 15000);

  it("token 数上限：满了挤掉最久没用的，最近用过的保留", async () => {
    let t = 1_000_000;
    const s = make({ now: () => t, limits: { maxTokens: 2 } });
    const a = await openSite("index.html", s);
    t += 10;
    const b = await openSite("index.html", s);
    t += 10;
    expect((await get(a, `/css/a.css`)).status).toBe(200); // a 刚用过 → b 最久没用
    t += 10;
    const c = await openSite("index.html", s);
    expect(s.stats().tokens).toBe(2);
    expect((await get(b, `/css/a.css`)).status).toBe(403); // b 被挤掉：Host 里的 token 已无效
    expect((await get(a, `/css/a.css`)).status).toBe(200);
    expect((await get(c, `/css/a.css`)).status).toBe(200);
    s.revokeAll();
  });

  it("不同 token 之间互相隔离：token A 看不到 token B 目录里的文件，反之亦然", async () => {
    const other = path.join(tmp, "other-site");
    fs.mkdirSync(other);
    write("index.html", "<p>other</p>", other);
    write("only-in-other.txt", "OTHER", other);
    const a = await openSite();
    const b = await openSite("index.html", srv, other);
    expect(a.host).not.toBe(b.host); // 不同 origin
    expect((await get(b, `/only-in-other.txt`)).status).toBe(200);
    expect((await get(a, `/only-in-other.txt`)).status).toBe(404);
    expect((await get(b, `/css/a.css`)).status).toBe(404);
  });
});

describe("端口：保留端口不用；[::1] 同端口；没有 IPv6 就只听 IPv4（R7-07）", () => {
  type FakeMode = "unavailable" | "inuse-once" | "inuse-always";
  const withV6Behaviour = (mode: FakeMode) => {
    const state = { v6Calls: 0, v4Ports: [] as number[] };
    const fake = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        const orig = s.listen.bind(s);
        (s as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          const opts = a[0] as { host: string };
          if (opts.host === "::1") {
            state.v6Calls += 1;
            const code = mode === "unavailable" ? "EADDRNOTAVAIL" : mode === "inuse-always" || state.v6Calls === 1 ? "EADDRINUSE" : null;
            if (code) {
              setImmediate(() => s.emit("error", Object.assign(new Error(`listen ${code}`), { code })));
              return s;
            }
          } else {
            s.once("listening", () => state.v4Ports.push((s.address() as net.AddressInfo).port));
          }
          return orig(...(a as Parameters<typeof orig>));
        };
        return s;
      },
    } as typeof http;
    return { fake, state };
  };

  it("没有 IPv6 回环（EADDRNOTAVAIL）：只听 IPv4，记日志，照常服务", async () => {
    const logs: string[] = [];
    const { fake, state } = withV6Behaviour("unavailable");
    const s = make({ http: fake, log: (m) => logs.push(m) });
    const o = await openSite("index.html", s);
    expect(state.v6Calls).toBe(1);
    expect(s.listening()).toEqual({ v4: true, v6: false });
    expect(logs.some((l) => l.includes("IPv6") && l.includes("只监听 IPv4"))).toBe(true);
    expect((await get(o, `/${o.name}`)).status).toBe(200);
    s.revokeAll();
  });

  it("[::1] 被别的进程占了（EADDRINUSE）：整体换端口重试，第一次的 IPv4 监听被关掉", async () => {
    const { fake, state } = withV6Behaviour("inuse-once");
    const s = make({ http: fake });
    const o = await openSite("index.html", s);
    expect(state.v6Calls).toBe(2);
    expect(state.v4Ports).toHaveLength(2);
    expect(o.port).toBe(state.v4Ports[1]);
    expect(await portOpen(state.v4Ports[0])).toBe(false);
    expect(s.listening()).toEqual({ v4: true, v6: true });
    expect((await get(o, `/${o.name}`)).status).toBe(200);
    s.revokeAll();
  });

  it("[::1] 一直被占：最多重试 8 次后放弃，open 返回失败，且不留监听", async () => {
    const { fake, state } = withV6Behaviour("inuse-always");
    const s = make({ http: fake });
    const r = await s.open(path.join(site, "index.html"));
    expect(r).toEqual({ ok: false, error: "本地服务启动失败" });
    expect(state.v6Calls).toBe(8);
    for (const p of state.v4Ports) expect(await portOpen(p), String(p)).toBe(false);
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
  });

  it.runIf(ipv6Available)("真 [::1] 监听：同端口、Host 校验与 IPv4 完全一致", async () => {
    const o = await openSite();
    expect(srv.listening()).toEqual({ v4: true, v6: true });
    const viaV6 = await new Promise<Resp>((resolve, reject) => {
      const req = http.request({ host: "::1", port: o.port, path: `/${o.name}`, headers: { Host: o.host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(viaV6.status).toBe(200);
    expect(viaV6.body).toContain("hello");
    const bad = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "::1", port: o.port, path: `/${o.name}`, headers: { Host: `[::1]:${o.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(bad).toBe(403);
  });

  it("保留端口（8676 / 8776 / 8876）一律不用：随机到了就关掉重来", async () => {
    for (const reserved of [8676, 8776, 8876]) {
      const attempts: number[] = [];
      const fake = {
        ...http,
        createServer: (...args: Parameters<typeof http.createServer>) => {
          const s = http.createServer(...args);
          if (attempts.length === 0) {
            // 第一个 IPv4 监听「声称」自己拿到了保留端口
            (s as unknown as { address: () => unknown }).address = () => ({ port: reserved, address: "127.0.0.1", family: "IPv4" });
            attempts.push(reserved);
          } else {
            attempts.push(-1);
          }
          return s;
        },
      } as typeof http;
      const s = make({ http: fake });
      const o = await openSite("index.html", s);
      expect(o.port, String(reserved)).not.toBe(reserved);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect((await get(o, `/${o.name}`)).status).toBe(200);
      s.revokeAll();
    }
  });

  it("壳注入的 isReservedPort（Flowship 自己的端口）同样不用", async () => {
    const tried: number[] = [];
    const s = make({
      isReservedPort: (p) => {
        tried.push(p);
        return tried.length <= 2; // 前两次随机到的端口当作 Flowship 的端口
      },
    });
    const o = await openSite("index.html", s);
    expect(tried).toHaveLength(3);
    expect(tried[2]).toBe(o.port);
    expect(tried.slice(0, 2)).not.toContain(o.port);
    for (const p of tried.slice(0, 2)) expect(await portOpen(p), String(p)).toBe(false);
    s.revokeAll();
  });
});

describe("R7-03：目录里的 FIFO / 特殊文件不能阻塞主进程线程池", () => {
  it.runIf(posixOnly)("真 mkfifo 的 f.css 并发 8 次 GET：全部 404，之后 fs.stat 仍在 100ms 内返回", async () => {
    const f = path.join(site, "f.css");
    execFileSync("mkfifo", [f]);
    fifos.push(f);
    const o = await openSite();
    const rs = await Promise.all(Array.from({ length: 8 }, () => get(o, `/f.css`, { timeoutMs: 3000 })));
    for (const r of rs) expect(r.status).toBe(404);
    const t0 = Date.now();
    await fs.promises.stat(site);
    expect(Date.now() - t0).toBeLessThan(100);
    // 对照：普通文件不受影响
    expect((await get(o, `/css/a.css`)).status).toBe(200);
  }, 15000);

  it.runIf(posixOnly)("FIFO 被符号链接引用（x.css -> pipe）同样 404、不阻塞", async () => {
    const f = path.join(site, "pipe");
    execFileSync("mkfifo", [f]);
    fifos.push(f);
    fs.symlinkSync(f, path.join(site, "x.css"));
    const o = await openSite();
    const rs = await Promise.all(Array.from({ length: 6 }, () => get(o, `/x.css`, { timeoutMs: 3000 })));
    for (const r of rs) expect(r.status).toBe(404);
  }, 15000);
});

describe("R7-04：早断连不泄漏 FileHandle；revokeAll 与在途 open 交错不能复活服务", () => {
  type Handle = fs.promises.FileHandle;
  const trackFs = (gate?: { promise: Promise<void> }) => {
    const handles: Handle[] = [];
    let opening = 0;
    const fakeFs = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (...a: Parameters<typeof fs.promises.open>) => {
          const fh = await fs.promises.open(...a);
          handles.push(fh);
          opening += 1;
          if (gate) await gate.promise;
          return fh;
        },
      },
    } as never;
    return { fakeFs, handles, opened: () => opening };
  };
  const closed = (h: Handle) => h.fd === -1;

  it("客户端在 open 返回之前就断开：处理完后 FileHandle 一定被关掉", async () => {
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => (release = r)) };
    const { fakeFs, handles, opened } = trackFs(gate);
    const s = make({ fs: fakeFs });
    const o = await openSite("index.html", s);
    const sock = net.connect({ host: "127.0.0.1", port: o.port });
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write(`GET /css/a.css HTTP/1.1\r\nHost: ${o.host}\r\n\r\n`);
    expect(await waitFor(() => opened() === 1)).toBe(true);
    sock.destroy(); // 服务端还卡在 open 的 await 里
    await sleep(80); // 让服务端观察到 close
    release();
    expect(await waitFor(() => handles.length === 1 && closed(handles[0]))).toBe(true);
    s.revokeAll();
  });

  it("下载到一半客户端断开：stream 被销毁、FileHandle 被关掉", async () => {
    write("big.bin", Buffer.alloc(16 * 1024 * 1024, 7));
    const { fakeFs, handles } = trackFs();
    const s = make({ fs: fakeFs });
    const o = await openSite("index.html", s);
    const sock = net.connect({ host: "127.0.0.1", port: o.port });
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write(`GET /big.bin HTTP/1.1\r\nHost: ${o.host}\r\n\r\n`);
    await new Promise<void>((r) => sock.once("data", () => r()));
    sock.destroy();
    expect(await waitFor(() => handles.length === 1 && closed(handles[0]), 3000)).toBe(true);
    s.revokeAll();
  }, 15000);

  it("读文件的 stream 中途出错：连接被断开（客户端拿到错误，不是一直挂着），FileHandle 被关掉", async () => {
    const handles: Handle[] = [];
    const fakeFs = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (...a: Parameters<typeof fs.promises.open>) => {
          const fh = await fs.promises.open(...a);
          handles.push(fh);
          const proxy = new Proxy(fh, {
            get(target, prop, recv) {
              if (prop === "createReadStream") {
                return () =>
                  new Readable({
                    read() {
                      this.push(Buffer.from("partial"));
                      this.destroy(new Error("boom"));
                    },
                    destroy(err, cb) {
                      target.close().then(() => cb(err), () => cb(err));
                    },
                  });
              }
              const v = Reflect.get(target, prop, recv);
              return typeof v === "function" ? v.bind(target) : v;
            },
          });
          return proxy;
        },
      },
    } as never;
    const s = make({ fs: fakeFs });
    const o = await openSite("index.html", s);
    const outcome = await get(o, `/css/a.css`, { timeoutMs: 3000 }).then(
      (r) => ({ ok: true as const, status: r.status, body: r.body }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    );
    // 声明了 Content-Length 却没发完：客户端必须看到「连接被中断」，而不是 200 + 完整内容，也不是超时
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).not.toMatch(/timeout/);
    expect(await waitFor(() => handles.length === 1 && closed(handles[0]))).toBe(true);
    s.revokeAll();
  });

  it("open 在途（stat 的 await 里）时 revokeAll：返回 ok:false，不起服务、不留监听", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let statStarted = false;
    const fakeFs = {
      ...fs,
      promises: {
        ...fs.promises,
        stat: async (...a: Parameters<typeof fs.promises.stat>) => {
          statStarted = true;
          await gate;
          return fs.promises.stat(...a);
        },
      },
    } as never;
    const listens: number[] = [];
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        s.once("listening", () => listens.push((s.address() as net.AddressInfo).port));
        return s;
      },
    } as typeof http;
    const s = make({ fs: fakeFs, http: spyHttp });
    const pending = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => statStarted)).toBe(true);
    s.revokeAll();
    release();
    expect(await pending).toEqual({ ok: false, error: "内置浏览器已关闭" });
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
    for (const p of listens) expect(await portOpen(p), String(p)).toBe(false);
  });

  it("服务启动中（listen 回调还没回）revokeAll：监听被关掉，open 返回 ok:false，不复活", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ports: number[] = [];
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        const orig = s.listen.bind(s);
        (s as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          const cb = a[1] as () => void;
          return orig(a[0] as never, (() => {
            ports.push((s.address() as net.AddressInfo).port);
            void gate.then(cb);
          }) as never);
        };
        return s;
      },
    } as typeof http;
    const s = make({ http: spyHttp });
    const pending = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => ports.length === 1)).toBe(true);
    s.revokeAll();
    release();
    expect(await pending).toEqual({ ok: false, error: "内置浏览器已关闭" });
    expect(await waitFor(() => true)).toBe(true);
    expect(await portOpen(ports[0])).toBe(false);
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
    expect(s.listening()).toEqual({ v4: false, v6: false });
  });

  it("启动中 revokeAll 之后又来一次 open：旧的启动流程不能留下孤儿监听，新的服务照常工作", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ports: number[] = [];
    let first = true;
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        const orig = s.listen.bind(s);
        const gated = first; // 只有第一次启动被卡住
        (s as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          const cb = a[1] as () => void;
          return orig(a[0] as never, (() => {
            if ((a[0] as { host: string }).host === "127.0.0.1") ports.push((s.address() as net.AddressInfo).port);
            if (gated) void gate.then(cb);
            else cb();
          }) as never);
        };
        return s;
      },
    } as typeof http;
    const s = make({ http: spyHttp });
    const p1 = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => ports.length === 1)).toBe(true);
    first = false;
    s.revokeAll();
    const second = await openSite("index.html", s); // 新一代的服务
    release();
    expect(await p1).toEqual({ ok: false, error: "内置浏览器已关闭" });
    expect(await waitFor(() => true)).toBe(true);
    expect(ports).toHaveLength(2);
    expect(await portOpen(ports[0])).toBe(false); // 旧的被关掉
    expect(second.port).toBe(ports[1]);
    expect((await get(second, `/${second.name}`)).status).toBe(200);
    expect(s.stats().tokens).toBe(1);
    s.revokeAll();
  });

  it("并发 open 共用同一次启动（只有一个 IPv4 监听）", async () => {
    const v4Listens: number[] = [];
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        s.once("listening", () => {
          if ((s.address() as net.AddressInfo).address === "127.0.0.1") v4Listens.push(1);
        });
        return s;
      },
    } as typeof http;
    const s = make({ http: spyHttp });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => s.open(path.join(site, "index.html"))));
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(v4Listens).toHaveLength(1);
    expect(s.stats().tokens).toBe(3);
    s.revokeAll();
  });
});

describe("R7-06：连接数 / 超时上限（本机任意进程不需要 token 就能连上端口）", () => {
  it("默认参数：10 秒头超时 + 2 秒检查间隔（Node 默认检查间隔 30 秒会让 10 秒变成 30 秒）+ 64 连接 + 5 秒 keep-alive", async () => {
    expect(LOCAL_HTML_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(LOCAL_HTML_CONNECTIONS_CHECK_INTERVAL_MS).toBeLessThanOrEqual(2_000);
    expect(LOCAL_HTML_MAX_CONNECTIONS).toBe(64);
    expect(LOCAL_HTML_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(LOCAL_HTML_KEEP_ALIVE_TIMEOUT_MS).toBe(5_000);
    const captured: Array<{ opts: Record<string, unknown>; server: http.Server }> = [];
    const spyHttp = {
      ...http,
      createServer: (...args: unknown[]) => {
        const server = (http.createServer as (...a: unknown[]) => http.Server)(...args);
        captured.push({ opts: args[0] as Record<string, unknown>, server });
        return server;
      },
    } as typeof http;
    const s = make({ http: spyHttp });
    await openSite("index.html", s);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    for (const { opts, server } of captured) {
      expect(opts).toMatchObject({
        connectionsCheckingInterval: LOCAL_HTML_CONNECTIONS_CHECK_INTERVAL_MS,
        headersTimeout: LOCAL_HTML_HEADERS_TIMEOUT_MS,
        requestTimeout: LOCAL_HTML_REQUEST_TIMEOUT_MS,
        keepAliveTimeout: LOCAL_HTML_KEEP_ALIVE_TIMEOUT_MS,
      });
      expect(server.maxConnections).toBe(LOCAL_HTML_MAX_CONNECTIONS);
    }
    s.revokeAll();
  });

  const small = { headersTimeoutMs: 400, requestTimeoutMs: 1200, connectionsCheckIntervalMs: 100, keepAliveTimeoutMs: 300 };

  it("只连不发 / 半截请求头 / 逐字节发头：都在 ≈ headersTimeout 内被服务端关掉", async () => {
    const s = make({ limits: small });
    const o = await openSite("index.html", s);
    const connect = () =>
      new Promise<net.Socket>((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port: o.port });
        sock.on("error", () => {});
        sock.once("connect", () => resolve(sock));
      });
    const idle = await connect();
    const half = await connect();
    half.write(`GET /index.html HTTP/1.1\r\nHost: ${o.host}\r\nX-Slow: `);
    const drip = await connect();
    const t0 = Date.now();
    const timer = setInterval(() => drip.write("a"), 60);
    drip.write(`GET /index.html HTTP/1.1\r\nHost: ${o.host}\r\nX-Drip: `);
    const results = await Promise.all([closedWithin(idle, 2500), closedWithin(half, 2500), closedWithin(drip, 2500)]);
    clearInterval(timer);
    expect(results).toEqual([true, true, true]);
    expect(Date.now() - t0).toBeLessThan(2500);
    s.revokeAll();
  }, 15000);

  it("连接数上限：满了之后新连接被直接断开，已有的不受影响；腾出位置后又能连", async () => {
    const s = make({ limits: { maxConnections: 3 } });
    const o = await openSite("index.html", s);
    const open1 = () =>
      new Promise<net.Socket>((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port: o.port });
        sock.on("error", () => {});
        sock.once("connect", () => resolve(sock));
      });
    const held = [await open1(), await open1(), await open1()];
    await sleep(50);
    const extra = await open1();
    expect(await closedWithin(extra, 1000)).toBe(true);
    for (const h of held) expect(h.destroyed).toBe(false);
    held[0].destroy();
    await sleep(100);
    expect((await get(o, `/${o.name}`)).status).toBe(200);
    for (const h of held) h.destroy();
    s.revokeAll();
  }, 15000);

  it("keep-alive 空闲连接在 keepAliveTimeout 后被服务端关掉", async () => {
    const s = make({ limits: small });
    const o = await openSite("index.html", s);
    const sock = net.connect({ host: "127.0.0.1", port: o.port });
    sock.on("error", () => {});
    sock.on("data", () => {});
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write(`GET /css/a.css HTTP/1.1\r\nHost: ${o.host}\r\nConnection: keep-alive\r\n\r\n`);
    expect(await closedWithin(sock, 2000)).toBe(true);
    s.revokeAll();
  }, 15000);

  it("畸形请求（clientError）：连接被直接销毁，不回 400 之类的内容", async () => {
    const o = await openSite();
    const bytes = await raw(o.port, "\x00\x01\x02 GARBAGE \x03\r\n\r\n", 300);
    expect(bytes).toBe("");
  });

  it("绝对形式请求行 / GET * / 超长 URL：全部拒绝或断开，读不到内容", async () => {
    const o = await openSite();
    for (const line of [`GET http://${o.host}/index.html HTTP/1.1`, "GET * HTTP/1.1", `GET /${"a".repeat(20000)} HTTP/1.1`]) {
      const bytes = await raw(o.port, `${line}\r\nHost: ${o.host}\r\n\r\n`, 200);
      expect(bytes, line.slice(0, 40)).not.toContain("hello");
    }
  });
});

// ---------------------------------------------------------------------------
// R7-08 补充：变异存活项（第一轮变异里「行为确实不同却没人发现」的缺口）
// ---------------------------------------------------------------------------

describe("R7-08 补充：入参校验的错误口径与「碰 fs 之前」", () => {
  const spyFs = () => {
    const calls: string[] = [];
    const spy = new Proxy({}, { get: (_t, k) => () => { calls.push(String(k)); throw new Error("不该访问 fs"); } });
    return { calls, fakeFs: { promises: spy, constants: fs.constants } as never };
  };

  it("相对路径 / 超长（> 4096）/ 含 NUL：各自返回对应的错误，且一次 fs 都没碰（边界 4096 放行到 realpath、4097 拒）", async () => {
    const { calls, fakeFs } = spyFs();
    const s = make({ fs: fakeFs });
    expect(await s.open("index.html")).toEqual({ ok: false, error: "需要绝对路径" });
    expect(await s.open("./sub/index.html")).toEqual({ ok: false, error: "需要绝对路径" });
    expect(await s.open("/tmp/a\0.html")).toEqual({ ok: false, error: "无效的文件路径" });
    const tooLong = `/${"a".repeat(4097 - ".html".length - 1)}.html`;
    expect(tooLong).toHaveLength(4097);
    expect(await s.open(tooLong)).toEqual({ ok: false, error: "无效的文件路径" });
    expect(calls).toEqual([]);
    // 对照：正好 4096 字符通过入参校验、走到 realpath（spy 抛错 → 文件不存在）
    const exact = `/${"a".repeat(4096 - ".html".length - 1)}.html`;
    expect(exact).toHaveLength(4096);
    expect(await s.open(exact)).toEqual({ ok: false, error: "文件不存在或无法访问" });
    expect(calls).toEqual(["realpath"]);
  });

  it.runIf(posixOnly)("相对路径即使相对 cwd 真的存在这个文件也拒绝（不能靠 cwd 解析出一个真文件）", async () => {
    const rel = path.relative(process.cwd(), path.join(site, "index.html"));
    expect(path.isAbsolute(rel)).toBe(false);
    expect(fs.existsSync(rel)).toBe(true);
    expect(await srv.open(rel)).toEqual({ ok: false, error: "需要绝对路径" });
    expect(srv.stats()).toEqual({ tokens: 0, port: 0 });
  });
});

describe("R7-08 补充：parseHostToken 的端口写法", () => {
  const tok = "ab".repeat(24);
  it("前导零 / 加号 / 空白 / 超长数字的端口一律不认（只认规范十进制写法且等于服务端口）", () => {
    expect(parseHostToken(`${tok}.localhost:8080`, 8080)).toBe(tok);
    expect(parseHostToken(`${tok}.localhost:08080`, 8080)).toBeNull();
    expect(parseHostToken(`${tok}.localhost:0808`, 808)).toBeNull();
    expect(parseHostToken(`${tok}.localhost:+8080`, 8080)).toBeNull();
    expect(parseHostToken(`${tok}.localhost: 8080`, 8080)).toBeNull();
    expect(parseHostToken(`${tok}.localhost:8080 `, 8080)).toBeNull();
    expect(parseHostToken(`${tok}.localhost:80800`, 8080)).toBeNull();
    expect(parseHostToken(`${tok}.localhost:8081`, 8080)).toBeNull();
  });
});

describe("R7-08 补充：HEAD 不读文件", () => {
  it("HEAD：FileHandle 直接关掉、不创建读流；GET 对照创建一次（Node 会吞掉 HEAD 的 body，所以要看读流而不是字节）", async () => {
    const streams: number[] = [];
    const handles: fs.promises.FileHandle[] = [];
    const fakeFs = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (...a: Parameters<typeof fs.promises.open>) => {
          const fh = await fs.promises.open(...a);
          handles.push(fh);
          const orig = fh.createReadStream.bind(fh);
          (fh as unknown as { createReadStream: unknown }).createReadStream = (...x: Parameters<typeof orig>) => {
            streams.push(1);
            return orig(...x);
          };
          return fh;
        },
      },
    } as never;
    const s = make({ fs: fakeFs });
    const o = await openSite("index.html", s);
    const h = await get(o, `/css/a.css`, { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.body).toBe("");
    expect(h.headers["content-length"]).toBe(String("body{color:red}".length));
    expect(streams).toHaveLength(0);
    expect(await waitFor(() => handles.length === 1 && handles[0].fd === -1)).toBe(true); // 句柄关了
    const g = await get(o, `/css/a.css`);
    expect(g.body).toBe("body{color:red}");
    expect(streams).toHaveLength(1);
    s.revokeAll();
  });
});

describe("R7-08 补充：token 容量判断前先清掉过期的", () => {
  it("绝对过期（但最近还在用）的 token 在新 open 时被清掉，不会去挤一个仍有效的 token", async () => {
    const t0 = 1_000_000;
    let t = t0;
    const s = make({ now: () => t, limits: { maxTokens: 2 } });
    const a = await openSite("index.html", s);
    t += 10;
    const b = await openSite("index.html", s);
    const step = LOCAL_HTML_IDLE_TTL_MS - 60_000;
    while (t + step < t0 + LOCAL_HTML_MAX_AGE_MS - 5_000) {
      t += step;
      expect((await get(b, `/css/a.css`)).status).toBe(200);
      expect((await get(a, `/css/a.css`)).status).toBe(200);
    }
    t = t0 + LOCAL_HTML_MAX_AGE_MS - 5_000;
    expect((await get(b, `/css/a.css`)).status).toBe(200); // b 在前
    t += 1_000;
    expect((await get(a, `/css/a.css`)).status).toBe(200); // a 在后：a 的 lastUsedAt 比 b 新
    t = t0 + LOCAL_HTML_MAX_AGE_MS + 1; // a 的绝对年龄超限（已过期，但 lastUsedAt 最新）；b 仍有效（年龄差 10ms、空闲 5s）
    const c = await openSite("index.html", s);
    expect(s.stats().tokens).toBe(2); // b + c
    expect((await get(b, `/css/a.css`)).status).toBe(200); // b 没被误挤
    expect((await get(c, `/css/a.css`)).status).toBe(200);
    expect((await get(a, `/css/a.css`)).status).toBe(403); // a 已被清掉
    s.revokeAll();
  });
});

describe("R7-08 补充：启动流程的并发与代际（B8 / B11）", () => {
  type Listen = { host: string; port: number };
  /** 记录每次 listen；`gate(host, createIndex)` 返回 promise 时把 listen 回调卡住直到它 resolve */
  const spyHttpWith = (gate: (host: string, index: number) => Promise<void> | null) => {
    const listens: Listen[] = [];
    let created = 0;
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const server = http.createServer(...args);
        const index = created++;
        const orig = server.listen.bind(server);
        (server as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          const cb = a[1] as () => void;
          const host = (a[0] as { host: string }).host;
          return orig(a[0] as never, (() => {
            listens.push({ host, port: (server.address() as net.AddressInfo).port });
            const g = gate(host, index);
            if (g) void g.then(cb);
            else cb();
          }) as never);
        };
        return server;
      },
    } as typeof http;
    return { spyHttp, listens };
  };
  const portOpen6 = (port: number) =>
    new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "::1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });

  it("并发 open 共用同一次启动：启动期间（listen 回调被卡住）来的三个 open 只起一个 IPv4 监听", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { spyHttp, listens } = spyHttpWith((host) => (host === "127.0.0.1" ? gate : null));
    const s = make({ http: spyHttp });
    const pending = [1, 2, 3].map(() => s.open(path.join(site, "index.html")));
    expect(await waitFor(() => listens.length >= 1)).toBe(true);
    await sleep(300); // 让另外两个 open 也走到 ensureStarted（它们前面各有几次 fs await）
    release();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(listens.filter((l) => l.host === "127.0.0.1")).toHaveLength(1);
    expect(s.stats().tokens).toBe(3);
    s.revokeAll();
  });

  it.runIf(ipv6Available)("[::1] 的 listen 回调还卡着时 revokeAll，新一代的 open 先完成：旧启动醒来后既不能覆盖新服务的端口，也不能留监听", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { spyHttp, listens } = spyHttpWith((host, index) => (host === "::1" && index === 1 ? gate : null)); // 第一次启动的 s6（第 2 个 createServer）
    const s = make({ http: spyHttp });
    const first = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => listens.some((l) => l.host === "::1"))).toBe(true);
    s.revokeAll();
    const second = await openSite("index.html", s); // 新一代：完整起一套服务
    release();
    expect(await first).toEqual({ ok: false, error: "内置浏览器已关闭" });
    await sleep(100);
    const oldV4 = listens[0].port;
    expect(second.port).not.toBe(oldV4);
    expect(await portOpen(oldV4)).toBe(false); // 旧的 v4 / v6 都被关掉
    expect(await portOpen6(oldV4)).toBe(false);
    expect(s.stats()).toEqual({ tokens: 1, port: second.port }); // 没被旧启动覆盖
    expect((await get(second, `/${second.name}`)).status).toBe(200);
    s.revokeAll();
  });
});

describe("R7-08 补充：isBroadRoot 的 win32 / posix 分支互不串", () => {
  it("win32 上 C:\\Volumes\\x / C:\\mnt\\x / C:\\media\\u\\x / C:\\run\\media\\u\\x 只是普通目录（posix 挂载点规则不对 win32 生效）", () => {
    const opts = { path: path.win32, platform: "win32", home: "C:\\Users\\me", tmp: "C:\\Temp" };
    for (const d of ["C:\\Volumes\\site", "C:\\mnt\\site", "C:\\media\\u\\site", "C:\\run\\media\\u\\site"]) {
      expect(isBroadRoot(d, opts), d).toBe(false);
    }
    // 对照：同样的写法在 posix 上是挂载点根 → 过宽
    const posix = { path: path.posix, platform: "linux", home: "/home/me", tmp: "/tmp" };
    for (const d of ["/Volumes/site", "/mnt/site", "/media/u/site", "/run/media/u/site"]) expect(isBroadRoot(d, posix), d).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 第二轮复审（R7-12-A / R7-13 / R7-14）补的钉子：每条断言对应一个「行为变了、旧测试却不红」的变异
// （reviewer 的存活清单见 docs/REVIEW-browser-automation.md R7-12；我自己再做了一遍变异确认转红，结果记在处理栏）
// ---------------------------------------------------------------------------

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("R7-12-A1：每条处理分支都把 FileHandle 关掉（非普通文件 / 413 / 416 / HEAD / 空文件 / 异常 / 正常下载）", () => {
  type FH = fs.promises.FileHandle;
  const isClosed = (h: FH) => h.fd === -1;
  /** 包一层 `fs.promises.open`：记下每个真句柄；`override(fh, index)` 返回的成员盖在句柄代理上（注入「fstat 说不是文件」「stat 抛错」…） */
  const trackFh = (override?: (fh: FH, index: number) => Record<string, unknown> | undefined) => {
    const handles: FH[] = [];
    const fakeFs = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (...a: Parameters<typeof fs.promises.open>) => {
          const fh = await fs.promises.open(...a);
          const index = handles.push(fh) - 1;
          const patch = override?.(fh, index);
          if (!patch) return fh;
          return new Proxy(fh, {
            get(target, prop) {
              if (typeof prop === "string" && prop in patch) return patch[prop];
              const v = Reflect.get(target, prop);
              return typeof v === "function" ? v.bind(target) : v;
            },
          });
        },
      },
    } as never;
    return { fakeFs, handles };
  };
  const allClosed = (handles: FH[]) => waitFor(() => handles.length > 0 && handles.every(isClosed), 2000);

  const made: Array<ReturnType<typeof createLocalHtmlServer>> = [];
  afterEach(() => {
    for (const s of made.splice(0)) s.revokeAll();
  });
  const serve = async (opts: { limits?: Deps["limits"]; override?: Parameters<typeof trackFh>[0] } = {}) => {
    const { fakeFs, handles } = trackFh(opts.override);
    const s = make({ fs: fakeFs, limits: opts.limits });
    made.push(s);
    const o = await openSite("index.html", s);
    return { s, o, handles };
  };
  const body100 = "0123456789".repeat(10);

  it("对照（正常下载）：200 / 206 收完之后句柄都已关闭", async () => {
    write("m.bin", body100);
    const { o, handles } = await serve();
    expect((await get(o, "/m.bin")).status).toBe(200);
    expect(await allClosed(handles)).toBe(true);
    const n = handles.length;
    expect((await get(o, "/m.bin", { headers: { Range: "bytes=0-9" } })).status).toBe(206);
    expect(await waitFor(() => handles.length === n + 1 && handles.every(isClosed), 2000)).toBe(true);
  });

  it("fstat 说不是普通文件 → 404、句柄关闭（F05）", async () => {
    const { o, handles } = await serve({ override: () => ({ stat: async () => ({ isFile: () => false, size: 0 }) }) });
    expect((await get(o, "/css/a.css")).status).toBe(404);
    expect(handles.length).toBeGreaterThan(0);
    expect(await allClosed(handles)).toBe(true);
  });

  it.runIf(posixOnly)("真 FIFO（mkfifo）→ 404、句柄关闭（F05，真实文件系统）", async () => {
    const f = path.join(site, "p.css");
    execFileSync("mkfifo", [f]);
    fifos.push(f);
    const { o, handles } = await serve();
    expect((await get(o, "/p.css", { timeoutMs: 3000 })).status).toBe(404);
    expect(await allClosed(handles)).toBe(true);
  }, 15000);

  it.each([
    ["不带 Range", undefined],
    ["带 Range", "bytes=0-9"],
  ])("超过大小上限 → 413、句柄关闭（F06；%s）", async (_n, range) => {
    write("huge.bin", "x".repeat(151));
    expect(fs.statSync(path.join(site, "index.html")).size).toBeLessThanOrEqual(150); // 入口本身不能被这个上限挡掉
    const { o, handles } = await serve({ limits: { maxFileBytes: 150 } });
    const r = await get(o, "/huge.bin", { headers: range ? { Range: range } : {} });
    expect(r.status).toBe(413);
    expect(await allClosed(handles)).toBe(true);
  });

  it.each([
    ["起点越界", "m.bin", "bytes=999-", 100],
    ["起点恰好等于大小", "m.bin", "bytes=100-", 100],
    ["后缀 0 字节", "m.bin", "bytes=-0", 100],
    ["空文件", "empty.bin", "bytes=0-", 0],
  ])("Range 取不到（%s）→ 416 + Content-Range + Accept-Ranges、句柄关闭（R30 / R29）", async (_n, name, range, size) => {
    write("m.bin", body100);
    write("empty.bin", "");
    const { o, handles } = await serve();
    const r = await get(o, `/${name}`, { headers: { Range: range } });
    expect(r.status).toBe(416);
    expect(r.headers["content-range"]).toBe(`bytes */${size}`);
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(r.body).toBe("");
    expect(await allClosed(handles)).toBe(true);
  });

  it("HEAD（含带 Range 的 HEAD）与空文件的 GET：200、不读内容、句柄关闭（F07）", async () => {
    write("m.bin", body100);
    write("empty.bin", "");
    const { o, handles } = await serve();
    const h = await get(o, "/m.bin", { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.headers["content-length"]).toBe("100");
    expect(h.body).toBe("");
    expect(await allClosed(handles)).toBe(true);
    const hr = await get(o, "/m.bin", { method: "HEAD", headers: { Range: "bytes=0-9" } });
    expect(hr.status).toBe(200);
    expect(await waitFor(() => handles.length === 2 && handles.every(isClosed), 2000)).toBe(true);
    const e = await get(o, "/empty.bin");
    expect(e.status).toBe(200);
    expect(e.body).toBe("");
    expect(await waitFor(() => handles.length === 3 && handles.every(isClosed), 2000)).toBe(true);
  });

  it("处理中途抛错（fstat 失败）→ 404、句柄关闭；之后的正常请求不受影响（F08）", async () => {
    const { o, handles } = await serve({
      override: (_fh, index) =>
        index === 0
          ? {
              stat: async () => {
                throw new Error("EIO");
              },
            }
          : undefined,
    });
    expect((await get(o, "/css/a.css")).status).toBe(404);
    expect(await allClosed(handles)).toBe(true);
    const ok = await get(o, "/css/a.css");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("body{color:red}");
    expect(await waitFor(() => handles.length === 2 && handles.every(isClosed), 2000)).toBe(true);
  });

  it("响应头已经写出之后才抛错（建读流失败）→ 连接被断开（不是挂着等超时）、句柄关闭", async () => {
    const { o, handles } = await serve({
      override: () => ({
        createReadStream: () => {
          throw new Error("cannot create stream");
        },
      }),
    });
    const outcome = await get(o, "/css/a.css", { timeoutMs: 3000 }).then(
      (r) => ({ ok: true as const, status: r.status }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).not.toMatch(/timeout/);
    expect(await allClosed(handles)).toBe(true);
  });
});

describe("R7-12-A2：生命周期交错（revokeAll 与在途的 open / 启动）", () => {
  /** 记录每个 createServer 与它的 host；`gate(v4Index)` 返回 promise 时把第 v4Index 个 IPv4 监听的 listen 回调卡住 */
  const gatedHttp = (gate: (v4Index: number) => Promise<void> | null) => {
    const created: Array<{ s: http.Server; host: string | null }> = [];
    let v4 = 0;
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const s = http.createServer(...args);
        const rec = { s, host: null as string | null };
        created.push(rec);
        const orig = s.listen.bind(s);
        (s as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          const opts = a[0] as { host: string };
          const cb = a[1] as () => void;
          rec.host = opts.host;
          const g = opts.host === "127.0.0.1" ? gate(v4++) : null;
          return orig(opts as never, (g ? () => void g.then(cb) : cb) as never);
        };
        return s;
      },
    } as typeof http;
    return {
      spyHttp,
      created,
      v4Count: () => created.filter((c) => c.host === "127.0.0.1").length,
      stillListening: () => created.filter((c) => c.s.listening).length,
    };
  };
  const REVOKED = { ok: false, error: "内置浏览器已关闭" };
  let site2: string;
  beforeEach(() => {
    site2 = path.join(tmp, "site2");
    write("index.html", "<p>site2</p>", site2);
  });

  it("L07：open 卡在 stat 时 revokeAll、新一代已经起好服务 → 旧 open 醒来返回已关闭，且不能把新一代的服务关掉", async () => {
    const gate = deferred();
    let n = 0;
    const gfs = {
      ...fs,
      promises: {
        ...fs.promises,
        stat: async (...a: Parameters<typeof fs.promises.stat>) => {
          if (++n === 2) await gate.promise; // 第 2 次 open 的 stat
          return fs.promises.stat(...a);
        },
      },
    } as never;
    const s = make({ fs: gfs });
    expect((await s.open(path.join(site2, "index.html"))).ok).toBe(true); // stat#1：先让服务跑起来
    const pendingA = s.open(path.join(site, "index.html")); // stat#2：卡住
    expect(await waitFor(() => n === 2)).toBe(true);
    s.revokeAll();
    const rb = await s.open(path.join(site2, "index.html")); // 新一代
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    const portB = s.stats().port;
    expect(portB).toBeGreaterThan(0);
    gate.resolve();
    expect(await pendingA).toEqual(REVOKED);
    await sleep(80);
    expect(s.stats()).toEqual({ tokens: 1, port: portB }); // 新一代的 token 与端口都还在
    const ob = parseOpened(rb.url);
    expect((await get(ob, `/${ob.name}`)).status).toBe(200);
    s.revokeAll();
  });

  it("对照：旧 open 醒来时新一代什么都没登记（tokens 为空）→ 照常收拾掉服务，不留孤儿监听", async () => {
    const gate = deferred();
    let n = 0;
    const gfs = {
      ...fs,
      promises: {
        ...fs.promises,
        stat: async (...a: Parameters<typeof fs.promises.stat>) => {
          if (++n === 1) await gate.promise;
          return fs.promises.stat(...a);
        },
      },
    } as never;
    const { spyHttp, created, stillListening } = gatedHttp(() => null);
    const s = make({ fs: gfs, http: spyHttp });
    const pending = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => n === 1)).toBe(true);
    s.revokeAll();
    gate.resolve();
    expect(await pending).toEqual(REVOKED);
    await sleep(50);
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
    expect(stillListening()).toBe(0);
    expect(created.every((c) => !c.s.listening)).toBe(true);
  });

  it("L09：旧一代的启动收尾时不能清掉新一代的 starting——期间来的第三个 open 共用新一代那次启动，不再多起一轮", async () => {
    const gA = deferred();
    const gB = deferred();
    const { spyHttp, created, v4Count, stillListening } = gatedHttp((i) => (i === 0 ? gA.promise : i === 1 ? gB.promise : null));
    const s = make({ http: spyHttp });
    const pa = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => v4Count() === 1)).toBe(true);
    s.revokeAll();
    const pb = s.open(path.join(site2, "index.html"));
    expect(await waitFor(() => v4Count() === 2)).toBe(true);
    gA.resolve(); // 旧一代的启动醒来：被判作废、收拾自己、finally
    expect(await pa).toEqual(REVOKED);
    await sleep(30);
    const pc = s.open(path.join(site2, "index.html"));
    await sleep(120); // 让 c 走到 ensureStarted
    expect(v4Count()).toBe(2); // c 共用了 b 的启动，没有第三个 IPv4 监听
    gB.resolve();
    const [rb, rc] = await Promise.all([pb, pc]);
    expect(rb.ok && rc.ok).toBe(true);
    expect(v4Count()).toBe(2);
    expect(s.stats().tokens).toBe(2);
    s.revokeAll();
    await sleep(50);
    expect(stillListening()).toBe(0);
    expect(created.every((c) => !c.s.listening)).toBe(true);
  });

  it("L03：IPv4 监听的回调卡住时 revokeAll，放行之后立刻放弃——不再往下建 [::1] 监听 / 换端口重试（只建过 1 个 server）", async () => {
    const g = deferred();
    const { spyHttp, created, stillListening } = gatedHttp((i) => (i === 0 ? g.promise : null));
    const s = make({ http: spyHttp });
    const pending = s.open(path.join(site, "index.html"));
    expect(await waitFor(() => created.some((c) => c.s.listening))).toBe(true);
    s.revokeAll();
    g.resolve();
    expect(await pending).toEqual(REVOKED);
    expect(created).toHaveLength(1);
    expect(stillListening()).toBe(0);
  });
});

describe("R7-12-A3：50MB 上限的精确边界 / Host 与 Sec-Fetch-Site / Range 解析表 / 限额注入 / 定时器 / 启动失败", () => {
  const LIMIT = 50 * 1024 * 1024;

  it("E13：上限就是 50MB——整 50MB 放行（Range 只读 1 字节）、多 1 字节 413；入口 HTML 同口径（稀疏文件，毫秒级）", async () => {
    expect(LOCAL_HTML_MAX_FILE_BYTES).toBe(52_428_800);
    fs.truncateSync(write("edge.bin", ""), LIMIT);
    fs.truncateSync(write("over.bin", ""), LIMIT + 1);
    fs.truncateSync(write("edge.html", ""), LIMIT);
    fs.truncateSync(write("over.html", ""), LIMIT + 1);
    const o = await openSite();
    const ok = await get(o, "/edge.bin", { headers: { Range: "bytes=0-0" } });
    expect(ok.status).toBe(206);
    expect(ok.headers["content-range"]).toBe(`bytes 0-0/${LIMIT}`);
    const over = await get(o, "/over.bin", { headers: { Range: "bytes=0-0" } });
    expect(over.status).toBe(413);
    expect((await srv.open(path.join(site, "edge.html"))).ok).toBe(true);
    const tooBig = await srv.open(path.join(site, "over.html"));
    expect(tooBig).toEqual({ ok: false, error: "文件太大（超过 50MB）" });
  });

  it("H08：Host 里 `.localhost` 的点是字面点（`xlocalhost` / `-localhost` / `_localhost` 不放行）", async () => {
    const o = await openSite();
    for (const sep of ["x", "-", "_", "a", "0"]) {
      const host = `${o.token}${sep}localhost:${o.port}`;
      const r = await get(o, `/${o.name}`, { host });
      expect(r.status, host).toBe(403);
    }
    expect((await get(o, `/${o.name}`)).status).toBe(200); // 对照
    const t = "0123456789abcdef".repeat(3);
    expect(parseHostToken(`${t}xlocalhost:1234`, 1234)).toBeNull();
    expect(parseHostToken(`${t}.localhost:1234`, 1234)).toBe(t);
  });

  it("H19：Sec-Fetch-Site 只拦 cross-site；same-origin / same-site / none / 没带 都放行", async () => {
    const o = await openSite();
    expect((await get(o, `/${o.name}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    for (const v of ["same-origin", "same-site", "none"]) expect((await get(o, `/${o.name}`, { headers: { "Sec-Fetch-Site": v } })).status, v).toBe(200);
    expect((await get(o, `/${o.name}`)).status).toBe(200);
  });

  // 期望值来自 reviewer 在真服务上跑出的全表（/tmp/rv10-S/p4range.log，size = 100）
  const R = (start: number, end: number) => ({ start, end });
  it.each<[string, unknown]>([
    // 合法写法
    ["bytes=0-0", R(0, 0)],
    ["bytes=0-", R(0, 99)],
    ["bytes=-1", R(99, 99)],
    ["bytes=50-60", R(50, 60)],
    ["bytes=0-99", R(0, 99)],
    ["bytes=0-100", R(0, 99)],
    ["bytes=99-200", R(99, 99)],
    ["bytes=-50", R(50, 99)],
    ["bytes=-100", R(0, 99)],
    ["bytes=-101", R(0, 99)],
    ["bytes=-999999999999", R(0, 99)],
    ["bytes=00-01", R(0, 1)],
    ["Bytes=0-1", R(0, 1)],
    ["BYTES=0-1", R(0, 1)],
    // 首尾空白被 trim（RFC 允许头值两端有可选空白）
    [" bytes=0-1", R(0, 1)],
    ["bytes=0-1 ", R(0, 1)],
    ["bytes=0-1\t", R(0, 1)],
    // 取不到 → 416
    ["bytes=-0", "unsatisfiable"],
    ["bytes=100-", "unsatisfiable"],
    ["bytes=101-", "unsatisfiable"],
    ["bytes=100-100", "unsatisfiable"],
    // 2^53-1 是安全整数；2^53 起一律当语法无效忽略
    ["bytes=9007199254740991-", "unsatisfiable"],
    ["bytes=0-9007199254740991", R(0, 99)],
    ["bytes=-9007199254740991", R(0, 99)],
    ["bytes=9007199254740992-", null],
    ["bytes=0-9007199254740992", null],
    ["bytes=-9007199254740992", null],
    ["bytes=999999999999999999999-", null],
    ["bytes=0-999999999999999999999", null],
    ["bytes=-999999999999999999999", null],
    // 语法无效 / 多段 / 别的单位 / 夹带字符 → 忽略（null）
    ["xbytes=0-1", null],
    ["bytes = 0-1", null],
    ["bytes= 0-1", null],
    ["bytes=0 -1", null],
    ["bytes=0- 1", null],
    ["bytes=+0-1", null],
    ["bytes=-0-1", null],
    ["bytes=0x0-0x1", null],
    ["bytes=1e2-", null],
    ["bytes=٠-١", null],
    ["bytes=5-1", null],
    ["bytes=0-1,5-6", null],
    ["bytes=0-1,", null],
    ["bytes=,0-1", null],
    ["bytes=0-1-2", null],
    ["bytes=0-1;q=1", null],
    ["bytes=0-1, bytes=5-6", null],
    ["items=0-1", null],
    ["bytes=", null],
    ["bytes=-", null],
    ["", null],
  ])("parseRange(%j, 100) → %j", (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });

  it("parseRange：空文件任何 Range 都是 416；非字符串入参 → null", () => {
    for (const h of ["bytes=0-", "bytes=0-0", "bytes=-1", "bytes=-0", "bytes=1-"]) expect(parseRange(h, 0), h).toBe("unsatisfiable");
    for (const v of [undefined, null, 5, [], {}]) expect(parseRange(v as never, 100)).toBeNull();
  });

  it.each(["xbytes=0-1", "bytes = 0-1", "bytes=0-99999999999999999999", "bytes=-99999999999999999999"])("HTTP 层：Range: %s → 忽略，200 整个文件", async (range) => {
    write("m.bin", "0123456789".repeat(10));
    const o = await openSite();
    const r = await get(o, "/m.bin", { headers: { Range: range } });
    expect(r.status).toBe(200);
    expect(r.body).toBe("0123456789".repeat(10));
  });

  it("C14 / C16（以及同类）：limits 里的每一项都真的传给了 http.createServer / maxConnections", async () => {
    const captured: Array<{ opts: Record<string, unknown>; server: http.Server }> = [];
    const spyHttp = {
      ...http,
      createServer: (...args: unknown[]) => {
        const server = (http.createServer as (...a: unknown[]) => http.Server)(...args);
        captured.push({ opts: args[0] as Record<string, unknown>, server });
        return server;
      },
    } as typeof http;
    const s = make({ http: spyHttp, limits: { headersTimeoutMs: 1111, requestTimeoutMs: 2222, keepAliveTimeoutMs: 3333, connectionsCheckIntervalMs: 444, maxConnections: 5 } });
    await openSite("index.html", s);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    for (const { opts, server } of captured) {
      expect(opts).toEqual({ headersTimeout: 1111, requestTimeout: 2222, keepAliveTimeout: 3333, connectionsCheckingInterval: 444 });
      expect(server.maxConnections).toBe(5);
    }
    s.revokeAll();
  });

  it("L25 / L26：过期清扫定时器 unref（不拖住进程退出），revokeAll 时 clearInterval", async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const created: Array<ReturnType<typeof setInterval>> = [];
    const cleared: unknown[] = [];
    const setSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...a: Parameters<typeof setInterval>) => {
      const t = realSet(...a);
      created.push(t);
      return t;
    }) as never);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((t: Parameters<typeof clearInterval>[0]) => {
      cleared.push(t);
      return realClear(t);
    }) as never);
    try {
      const s = make();
      await openSite("index.html", s);
      expect(created).toHaveLength(1);
      expect(created[0].hasRef()).toBe(false);
      expect(cleared).not.toContain(created[0]);
      s.revokeAll();
      expect(cleared).toContain(created[0]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      for (const t of created) realClear(t);
    }
  });

  it("P19：IPv4 回环 listen 失败（EACCES 之类）→ 直接报启动失败，不重试，日志带原始错误", async () => {
    const logs: string[] = [];
    let created = 0;
    const failHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        created += 1;
        const server = http.createServer(...args);
        (server as unknown as { listen: (...a: unknown[]) => unknown }).listen = () => {
          process.nextTick(() => server.emit("error", Object.assign(new Error("boom"), { code: "EACCES" })));
          return server;
        };
        return server;
      },
    } as typeof http;
    const s = make({ http: failHttp, log: (m) => logs.push(m) });
    expect(await s.open(path.join(site, "index.html"))).toEqual({ ok: false, error: "本地服务启动失败" });
    expect(created).toBe(1);
    expect(logs.some((l) => l.includes("本地 HTML 服务启动失败") && l.includes("boom"))).toBe(true);
    expect(s.stats()).toEqual({ tokens: 0, port: 0 });
  });

  it("P21：监听中的服务出 error → 写日志、不抛", async () => {
    const logs: string[] = [];
    const servers: http.Server[] = [];
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const server = http.createServer(...args);
        servers.push(server);
        return server;
      },
    } as typeof http;
    const s = make({ http: spyHttp, log: (m) => logs.push(m) });
    await openSite("index.html", s);
    expect(() => servers[0].emit("error", new Error("late-boom"))).not.toThrow();
    expect(logs.some((l) => l.includes("本地 HTML 服务出错：late-boom"))).toBe(true);
    s.revokeAll();
  });

  it("P20：启动中途（IPv4 已在听、[::1] 还在启动）IPv4 server 出 error，不能变成未捕获异常", async () => {
    const servers: http.Server[] = [];
    let thrown: unknown;
    const spyHttp = {
      ...http,
      createServer: (...args: Parameters<typeof http.createServer>) => {
        const server = http.createServer(...args);
        servers.push(server);
        const orig = server.listen.bind(server);
        (server as unknown as { listen: (...a: unknown[]) => unknown }).listen = (...a: unknown[]) => {
          if ((a[0] as { host: string }).host === "::1") {
            try {
              servers[0].emit("error", new Error("mid-start"));
            } catch (e) {
              thrown = e;
            }
          }
          return orig(a[0] as never, a[1] as never);
        };
        return server;
      },
    } as typeof http;
    const s = make({ http: spyHttp });
    expect((await s.open(path.join(site, "index.html"))).ok).toBe(true);
    if (ipv6Available) expect(servers.length).toBeGreaterThanOrEqual(2); // 确认确实走到了 [::1] 那一步
    expect(thrown).toBeUndefined();
    s.revokeAll();
  });

  it("P11：isReservedPort 只有返回 true 才算保留（1 / 'yes' / {} 不算）；返回 true 的端口被换掉", async () => {
    for (const v of [1, "yes", {}, 0, null]) {
      const s = make({ isReservedPort: () => v as never });
      expect((await s.open(path.join(site, "index.html"))).ok, String(v)).toBe(true);
      s.revokeAll();
    }
    const asked: number[] = [];
    const s = make({
      isReservedPort: (p) => {
        asked.push(p);
        return asked.length === 1;
      },
    });
    const r = await s.open(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(s.stats().port).toBe(asked[1]);
    expect(s.stats().port).not.toBe(asked[0]);
    s.revokeAll();
  });
});

describe("R7-12-A4：敏感名样本补全（每条正则的每个分支一个样本）", () => {
  const MORE_BLOCKED = [
    // id_ 规则：四种密钥类型 / `_sk` 硬件密钥 / 分隔符 `.` `_` `-`
    "id_ecdsa", "id_ecdsa.pub", "id_dsa", "id_ed25519", "id_rsa-work", "id_rsa_work.bak", "id_ed25519_sk.pub", "id_ecdsa_sk",
    // kubeconfig / credentials / secrets 的每种后缀
    "kubeconfig.json", "kubeconfig.yaml", "kubeconfig.yml", "kubeconfig.conf",
    "credentials.json", "credentials.yaml", "credentials.yml", "credentials.txt", "credentials.csv", "credentials.xml", "credentials.ini", "credentials.toml",
    "x.credentials.json", "x-credentials.json", "x_credentials.json", "prod.credentials.xml", "prod.credentials.toml",
    "secret.json", "secrets.json", "secret.yaml", "secrets.yml", "secrets.txt", "secrets.env", "secret.env", "secrets.ini", "secrets.toml",
    // service-account：分隔符 `-` / `_` / 没有分隔符三种写法（变异 N37：只认 `-` → `service_account.json` 漏拦）
    "service-account.json", "service_account.json", "serviceaccount.json", "service_account_prod.json", "service-account-prod.json",
  ];
  it.each(MORE_BLOCKED)("%s → 404（文件确实存在）", async (rel) => {
    write(rel, "TOP-SECRET-CONTENT");
    const o = await openSite();
    const r = await get(o, `/${encodeURIComponent(rel)}`);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("TOP-SECRET-CONTENT");
  });
});

describe("R7-13：isBroadRoot 漏项——同步盘 / 网盘 / OneDrive 已知文件夹 / 中文 XDG 目录 / 系统凭据子树（每个名单条目至少一个样本）", () => {
  const posix = { path: path.posix, home: "/Users/me", tmp: "/private/var/folders/ab/cd/T", platform: "linux" };
  const win = { path: path.win32, home: "C:\\Users\\Me", tmp: "C:\\Users\\Me\\AppData\\Local\\Temp", platform: "win32" };

  const KNOWN_FOLDERS = [
    "Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Public", "Applications", "Videos", "Templates", "Sites", "node_modules",
    "下载", "桌面", "文档", "图片", "音乐", "视频", "公共", "模板",
  ];
  it.each(KNOWN_FOLDERS)("~/%s 本身过宽（posix + win32），它下面的项目目录不算", (name) => {
    expect(isBroadRoot(`/Users/me/${name}`, posix)).toBe(true);
    expect(isBroadRoot(`/Users/me/${name}/site`, posix)).toBe(false);
    expect(isBroadRoot(`C:\\Users\\Me\\${name}`, win)).toBe(true);
    expect(isBroadRoot(`C:\\Users\\Me\\${name}\\site`, win)).toBe(false);
  });

  // 前缀匹配的同步盘：每个前缀一个样本（含带账号 / 公司后缀的写法）
  const SYNC_PREFIX_SAMPLES = [
    "iCloudDrive", "iCloud Drive", "Dropbox", "Dropbox (Personal)", "OneDrive", "OneDrive - Corp", "Google Drive", "GoogleDrive", "Nextcloud", "ownCloud",
    "pCloud Drive", "MEGAsync", "Seafile", "Syncthing", "SynologyDrive", "Synology Drive", "Yandex.Disk", "Creative Cloud Files", "Tresorit", "Box Sync",
    "Nutstore Files", "坚果云", "百度网盘", "BaiduNetdiskWorkspace", "WPSDrive",
    // 前缀大小写不敏感
    "DROPBOX", "onedrive - corp", "NEXTCLOUD",
  ];
  // 太短、只认整名（大小写不敏感）的
  const SYNC_EXACT_SAMPLES = ["Box", "MEGA", "Sync", "box", "BOX", "mega", "sync"];

  it.each([...SYNC_PREFIX_SAMPLES, ...SYNC_EXACT_SAMPLES])("同步盘根 ~/%s：恰好这一层过宽；更深一层的项目目录不算", (name) => {
    expect(isBroadRoot(`/Users/me/${name}`, posix)).toBe(true);
    expect(isBroadRoot(`/Users/me/${name}/site`, posix)).toBe(false);
    expect(isBroadRoot(`C:\\Users\\Me\\${name}`, win)).toBe(true);
    expect(isBroadRoot(`C:\\Users\\Me\\${name}\\site`, win)).toBe(false);
  });

  it.each([...SYNC_PREFIX_SAMPLES, ...SYNC_EXACT_SAMPLES])("同步盘根 ~/%s 下的已知文件夹（Desktop / Documents …）也过宽；其它名字的子目录不算", (name) => {
    for (const k of ["Desktop", "Documents", "Pictures", "Downloads", "Music", "Videos", "桌面"]) {
      expect(isBroadRoot(`/Users/me/${name}/${k}`, posix), `${name}/${k}`).toBe(true);
    }
    expect(isBroadRoot(`/Users/me/${name}/work`, posix)).toBe(false);
    expect(isBroadRoot(`/Users/me/${name}/work/Documents`, posix)).toBe(false);
  });

  it("R7-13-1（Windows OneDrive 已知文件夹重定向）：OneDrive\\Desktop / Documents / Pictures …、OneDrive - Corp\\Desktop | Documents；大小写不敏感", () => {
    const broad = [
      "C:\\Users\\Me\\OneDrive\\Desktop", "C:\\Users\\Me\\OneDrive\\Documents", "C:\\Users\\Me\\OneDrive\\Pictures", "C:\\Users\\Me\\OneDrive\\Downloads",
      "C:\\Users\\Me\\OneDrive\\Music", "C:\\Users\\Me\\OneDrive\\Videos", "C:\\Users\\Me\\OneDrive - Corp\\Desktop", "C:\\Users\\Me\\OneDrive - Corp\\Documents",
      "C:\\Users\\Me\\OneDrive - Personal\\Pictures", "c:\\users\\me\\onedrive\\desktop", "C:\\USERS\\ME\\ONEDRIVE\\DOCUMENTS",
    ];
    for (const d of broad) expect(isBroadRoot(d, win), d).toBe(true);
    const normal = [
      "C:\\Users\\Me\\OneDrive\\Desktop\\site", "C:\\Users\\Me\\OneDrive\\work", "C:\\Users\\Me\\OneDrive - Corp\\proj", "C:\\Users\\Me\\OneDrive\\work\\Documents",
      "C:\\Users\\Me\\Projects\\Desktop", "C:\\Users\\Me\\Projects\\Documents",
      // 另一个盘符：相对家目录的路径是绝对路径（跨盘符），家目录下的规则（点目录祖先 / 已知文件夹…）不能套到它身上
      "D:\\data\\.cache\\site", "D:\\data\\OneDrive\\Desktop",
    ];
    for (const d of normal) expect(isBroadRoot(d, win), d).toBe(false);
  });

  it("短名只认整名：Boxes / box-tool / sync-tool / megaman / mega-site / Syncfoo / boxsync / synology-notes 是普通项目目录", () => {
    for (const n of ["Boxes", "box-tool", "sync-tool", "megaman", "mega-site", "Syncfoo", "boxsync", "synology-notes", "MyDropbox"]) {
      expect(isBroadRoot(`/Users/me/${n}`, posix), n).toBe(false);
      expect(isBroadRoot(`C:\\Users\\Me\\${n}`, win), n).toBe(false);
    }
  });

  it("R7-13-4（系统凭据 / 数据库子树，posix）：整棵子树过宽，边界按路径段（`/Systemfoo`、`/private/var/dbx` 不算）", () => {
    const broad = [
      "/System", "/System/Library", "/System/Library/Foo/Bar", "/System/..weird", "/Library/Keychains", "/Library/Keychains/x", "/Library/Keychains/..x/y",
      "/private/var/db", "/private/var/db/dslocal/nodes", "/private/var/root", "/private/var/root/Documents/site",
    ];
    for (const d of broad) expect(isBroadRoot(d, posix), d).toBe(true);
    const normal = ["/Systemfoo/x", "/Library/KeychainsX/y", "/Library/WebServer/Documents", "/private/var/dbx/y", "/private/var/rooted/x", "/private/var/dbroot/x"];
    for (const d of normal) expect(isBroadRoot(d, posix), d).toBe(false);
  });

  it("系统共享目录 / 挂载点 / 家目录等原有名单逐项一个样本（B05 / B07 / B09 / B33）", () => {
    for (const d of ["/var/tmp", "/private/tmp", "/private/var", "/private/var/tmp", "/usr/share", "/usr/local", "/mnt", "/Users/me/Music", "/Users/me/Movies", "/Users/me/Public", "/Users/me/Applications"]) {
      expect(isBroadRoot(d, posix), d).toBe(true);
    }
    expect(isBroadRoot("/", posix)).toBe(true);
    expect(isBroadRoot("C:\\", win)).toBe(true);
    for (const d of ["/usr/local/proj", "/private/var/tmp/x/y", "/private/tmp/x/y", "/usr/share/doc/site"]) expect(isBroadRoot(d, posix), d).toBe(false);
  });
});

describe("R7-14-3：未带有效 token 的拒绝（方法 / Host / 跨站）回完就断开，占不住连接槽；持有 token 的请求保持 keep-alive", () => {
  /** 发一段原始请求，收到的字节 + 对端是否在 closeWithinMs 内关了连接 */
  const exchange = async (port: number, text: string, closeWithinMs: number) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write(text);
    const closed = await closedWithin(sock, closeWithinMs);
    const bytes = Buffer.concat(chunks).toString("latin1");
    sock.destroy();
    return { bytes, closed };
  };

  it.each([
    ["Host 不合格（127.0.0.1:port）", (o: Opened) => `GET /${o.name} HTTP/1.1\r\nHost: 127.0.0.1:${o.port}\r\n\r\n`, "HTTP/1.1 403"],
    ["有效形状但不是有效 token 的 Host", (o: Opened) => `GET /${o.name} HTTP/1.1\r\nHost: ${"b".repeat(48)}.localhost:${o.port}\r\n\r\n`, "HTTP/1.1 403"],
    ["方法不对（POST）", (o: Opened) => `POST /${o.name} HTTP/1.1\r\nHost: ${o.host}\r\nContent-Length: 0\r\n\r\n`, "HTTP/1.1 405"],
    ["跨站（Sec-Fetch-Site: cross-site）", (o: Opened) => `GET /${o.name} HTTP/1.1\r\nHost: ${o.host}\r\nSec-Fetch-Site: cross-site\r\n\r\n`, "HTTP/1.1 403"],
  ])("%s → 拒绝并带 Connection: close，服务端随后关掉连接", async (_n, build, statusLine) => {
    const o = await openSite();
    const { bytes, closed } = await exchange(o.port, build(o), 1500);
    expect(bytes.startsWith(statusLine)).toBe(true);
    expect(bytes).toMatch(/\r\nconnection: close\r\n/i);
    expect(closed).toBe(true);
  });

  it("405 仍带 Allow: GET, HEAD", async () => {
    const o = await openSite();
    const { bytes } = await exchange(o.port, `DELETE /${o.name} HTTP/1.1\r\nHost: ${o.host}\r\n\r\n`, 500);
    expect(bytes).toMatch(/\r\nallow: GET, HEAD\r\n/i);
  });

  it("对照：持有有效 token 的请求（200 / 404）保持 keep-alive，不会被误断开", async () => {
    const o = await openSite();
    for (const p of [`/${o.name}`, "/nope.txt"]) {
      const { bytes, closed } = await exchange(o.port, `GET ${p} HTTP/1.1\r\nHost: ${o.host}\r\n\r\n`, 600);
      expect(bytes.startsWith(p === "/nope.txt" ? "HTTP/1.1 404" : "HTTP/1.1 200"), p).toBe(true);
      expect(bytes, p).toMatch(/\r\nconnection: keep-alive\r\n/i);
      expect(bytes, p).not.toMatch(/\r\nconnection: close\r\n/i);
      expect(closed, p).toBe(false);
    }
  });

  it("占槽攻击失效：maxConnections=4，连续三轮每轮 4 个连接都发无效 Host 请求，之后带正确 Host 的真请求立刻 200", async () => {
    const s = make({ limits: { maxConnections: 4 } });
    const o = await openSite("index.html", s);
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => exchange(o.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${o.port}\r\n\r\n`, 1500)),
      );
      for (const r of results) {
        expect(r.bytes.startsWith("HTTP/1.1 403")).toBe(true);
        expect(r.closed).toBe(true);
      }
    }
    expect((await get(o, `/${o.name}`, { timeoutMs: 3000 })).status).toBe(200);
    s.revokeAll();
  }, 20000);
});

// ---------------------------------------------------------------------------
// 第三轮变异（修复 runner 判定后重跑 343 个：305 杀 / 19 存活）里「行为确实不同」的 5 个：N37 / B22 / B48 / B49 / X-sys-subtrees-guard
// （其余存活项是等价变异，清单与论证见 docs/REVIEW-browser-automation.md R7-12 处理栏）
// ---------------------------------------------------------------------------

describe("R7-12 补充：isBroadRoot 的点目录祖先 / home·tmp 的 realpath / win32 不套 posix 系统子树", () => {
  const fakeOsHT = (home: string, tmpdir: string) => ({ ...os, homedir: () => home, tmpdir: () => tmpdir }) as typeof os;

  it("B22：点开头的祖先**不在第一段**也算（~/code/.cache/site、~/Documents/proj/.next/server、点开头的目录本身）——表驱动，posix + win32", () => {
    const posix = { path: path.posix, home: "/Users/me", tmp: "/private/var/folders/ab/cd/T", platform: "linux" };
    for (const d of ["/Users/me/code/.cache/site", "/Users/me/Documents/proj/.next/server/pages", "/Users/me/a/b/.venv", "/Users/me/projects/site/.hidden"]) {
      expect(isBroadRoot(d, posix), d).toBe(true);
    }
    // 对照：同样深度、没有点开头的祖先 → 不算过宽
    for (const d of ["/Users/me/code/cache/site", "/Users/me/Documents/proj/next/server/pages", "/Users/me/a/b/venv"]) expect(isBroadRoot(d, posix), d).toBe(false);
    // 点只出现在**名字中间 / 结尾**不算（`a.b`、`v1.2`、`site.`）
    for (const d of ["/Users/me/code/v1.2/site", "/Users/me/code/a.b", "/Users/me/code/x./site"]) expect(isBroadRoot(d, posix), d).toBe(false);
    const win = { path: path.win32, home: "C:\\Users\\Me", tmp: "C:\\Users\\Me\\AppData\\Local\\Temp", platform: "win32" };
    expect(isBroadRoot("C:\\Users\\Me\\code\\.cache\\site", win)).toBe(true);
    expect(isBroadRoot("C:\\Users\\Me\\code\\cache\\site", win)).toBe(false);
  });

  it("B22（真文件系统）：~/code/.cache/site 里的 HTML → scope=file，旁边的凭据取不到", async () => {
    const home = path.join(tmp, "home-b22");
    const dir = path.join(home, "code", ".cache", "site");
    fs.mkdirSync(dir, { recursive: true });
    write("index.html", "<p>x</p>", dir);
    write("token.json", '{"accessToken":"SECRET"}', dir);
    write("notes.txt", "private", dir);
    const s = make({ os: fakeOsHT(home, path.join(tmp, "faketmp-b22")) });
    const o = await openSite("index.html", s, dir);
    expect(o.scope).toBe("file");
    expect((await get(o, `/notes.txt`)).status).toBe(404);
    s.revokeAll();
  });

  it.runIf(symlinkOk)("B48：家目录本身是符号链接（~ → /real/home）：HTML 放在真实路径的 Desktop 里仍是 scope=file（home 要先 realpath 再比较）", async () => {
    const realHome = path.join(tmp, "real-home");
    const desktop = path.join(realHome, "Desktop");
    fs.mkdirSync(desktop, { recursive: true });
    const linkHome = path.join(tmp, "link-home");
    fs.symlinkSync(realHome, linkHome);
    write("index.html", "<p>x</p>", desktop);
    write("notes.txt", "private", desktop);
    const s = make({ os: fakeOsHT(linkHome, path.join(tmp, "faketmp-b48")) });
    const o = await openSite("index.html", s, desktop);
    expect(o.scope).toBe("file");
    expect((await get(o, `/notes.txt`)).status).toBe(404);
    s.revokeAll();
  });

  it.runIf(symlinkOk)("B49：临时目录是符号链接（macOS 的 /var → /private/var 就是这样）：HTML 放在真实路径的临时目录里仍是 scope=file（tmp 要先 realpath 再比较）", async () => {
    const realTmp = path.join(tmp, "real-tmpdir", "T");
    fs.mkdirSync(realTmp, { recursive: true });
    const linkTmp = path.join(tmp, "link-tmpdir");
    fs.symlinkSync(path.join(tmp, "real-tmpdir"), linkTmp);
    write("index.html", "<p>x</p>", realTmp);
    write("notes.txt", "private", realTmp);
    // tmpdir() 返回「经符号链接的写法」`link-tmpdir/T`；入口在真实路径 `real-tmpdir/T`
    const s = make({ os: fakeOsHT(path.join(tmp, "home-b49"), path.join(linkTmp, "T")) });
    const o = await openSite("index.html", s, realTmp);
    expect(o.scope).toBe("file");
    expect((await get(o, `/notes.txt`)).status).toBe(404);
    s.revokeAll();
  });

  it("X-isWithin-dotdot：home 的**上级目录**（path.relative 得到 `..`）不会被当成家目录子树——home=/data/users/me 时 /data/users 与它的兄弟目录都不算过宽", () => {
    const posix = { path: path.posix, home: "/data/users/me", tmp: "", platform: "linux" };
    expect(isBroadRoot("/data/users", posix)).toBe(false);
    expect(isBroadRoot("/data/users/other/site", posix)).toBe(false);
    expect(isBroadRoot("/data", posix)).toBe(true); // 对照：根的一级子目录靠另一条规则判过宽，不是靠家目录规则
    expect(isBroadRoot("/data/users/me", posix)).toBe(true); // home 本身
    const win = { path: path.win32, home: "D:\\data\\users\\me", tmp: "", platform: "win32" };
    expect(isBroadRoot("D:\\data\\users", win)).toBe(false);
    expect(isBroadRoot("D:\\data", win)).toBe(true);
    expect(isBroadRoot("D:\\data\\users\\me", win)).toBe(true);
  });

  it("X-sys-subtrees-guard：win32 平台不套 posix 的系统凭据子树（/private/var/db 在 win32 上只是普通路径）；posix 上同一写法过宽", () => {
    // 用 path.posix 只是为了让 `/private/var/db/...` 在测试机上能参与 `path.relative`：真正的 path.win32.relative 对「不同盘符」返回绝对路径，
    // 守卫去掉与否在 posix 测试机上就看不出来了
    const sub = "/private/var/db/foo/bar";
    expect(isBroadRoot(sub, { path: path.posix, platform: "win32", home: "", tmp: "" })).toBe(false);
    expect(isBroadRoot(sub, { path: path.posix, platform: "linux", home: "", tmp: "" })).toBe(true);
    // 四个子树整棵（任意深度）都算，包含它们本身
    for (const d of ["/System", "/System/Library/Foo", "/Library/Keychains/x", "/private/var/db", "/private/var/root/y/z"]) {
      expect(isBroadRoot(d, { path: path.posix, platform: "linux", home: "", tmp: "" }), d).toBe(true);
    }
  });
});
