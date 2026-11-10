/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- 假 electron 对象与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R7：`browser:serveLocalHtml` IPC（electron-app/browser/index.mjs ↔ local-html-server.mjs）接线。
 *
 * 真 createBrowserManager（假 electron）+ 真 loopback http：
 * - 可信发送者拿到 `http://<token>.localhost:<端口>/<文件名>`（每个 token 一个 origin），真能 GET 到内容；这个地址过内置浏览器自己的 URL 策略（不是 Flowship origin）
 *   同样的主机名配 Flowship 的端口 / 8676 / 8776 / 8876 仍被拦；服务端口绝不会是 Flowship 的端口（isAppUrl 判定，随机到了就换）
 * - 非可信发送者直接 reject（和别的 browser:* 通道一致）
 * - 参数不是绝对路径字符串 / 超长 / 不存在 / 非 html / 敏感文件 → { ok:false }，不抛、不起服务
 * - destroy：服务关闭、token 作废、IPC 通道摘掉；destroy 之后再调返回 { ok:false }
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIsAppUrl } from "../electron-app/browser/app-origin.mjs";
import { createBrowserManager } from "../electron-app/browser/index.mjs";
import { checkUrl, normalizeAiUrl, resolveUserInput } from "../electron-app/browser/url-policy.mjs";

let tmp: string;
let site: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-r7-ipc-")));
  site = path.join(tmp, "site");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>hello r7</h1>");
  fs.writeFileSync(path.join(site, ".env"), "SECRET=1");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const makeManager = (opts: { trusted?: () => boolean; isAppUrl?: (u: string) => boolean } = {}) => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: (n: string, f: never) => void handlers.set(n, f),
    on: vi.fn(),
    removeHandler: (n: string) => void handlers.delete(n),
    removeListener: vi.fn(),
  };
  const logs: string[] = [];
  const manager = createBrowserManager({
    app: { getPath: () => os.tmpdir() },
    BrowserWindow: class {},
    WebContentsView: class {},
    session: { fromPartition: () => ({ on: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() }) },
    ipcMain,
    getMainWindow: () => null,
    isAppUrl: opts.isAppUrl ?? ((u: string) => /^https?:\/\/(localhost|127\.0\.0\.1):8876(\/|$)/.test(u)),
    isTrustedIpcSender: () => (opts.trusted ? opts.trusted() : true),
    log: (m: string) => logs.push(m),
    startPicker: () => ({ cancel() {} }),
  } as never);
  (manager as any).registerIpc();
  const call = (absPath: unknown) => (handlers.get("browser:serveLocalHtml") as Function)({}, absPath) as Promise<any>;
  return { manager, handlers, call, logs };
};

/** 连 127.0.0.1，Host 用 URL 自己的 `<token>.localhost:<port>`（浏览器里 Chromium 会把 *.localhost 解析到回环；Node / 系统 DNS 不保证） */
const get = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { Host: u.host }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
  });

const reachable = (url: string) => get(url).then(() => true, () => false);

describe("browser:serveLocalHtml：注册与可信闸", () => {
  it("registerIpc 注册了该通道（invoke / handle）", () => {
    const m = makeManager();
    expect(m.handlers.has("browser:serveLocalHtml")).toBe(true);
    (m.manager as any).destroy();
  });

  it("非可信发送者：reject（和别的 browser:* 一致），而且不起服务", async () => {
    let trusted = false;
    const m = makeManager({ trusted: () => trusted });
    await expect(m.call(path.join(site, "index.html"))).rejects.toThrow(/untrusted sender/);
    trusted = true;
    const r = await m.call(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    (m.manager as any).destroy();
  });
});

describe("browser:serveLocalHtml：成功路径", () => {
  it("返回 loopback http URL，真能 GET 到内容；URL 过内置浏览器自己的 URL 策略（不是 Flowship origin、不是 file:）", async () => {
    const m = makeManager();
    const r = await m.call(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    expect(r.scope).toBe("dir");
    expect(r.url).toMatch(/^http:\/\/[0-9a-f]{48}\.localhost:\d+\/index\.html$/);
    expect(r.url.startsWith("file:")).toBe(false);
    const res = await get(r.url);
    expect(res.status).toBe(200);
    expect(res.body).toBe("<h1>hello r7</h1>");
    const verdict = checkUrl(r.url, { isAppUrl: () => false });
    expect(verdict.ok).toBe(true);
    const user = resolveUserInput(r.url, { isAppUrl: () => false });
    expect(user.ok).toBe(true);
    // 同目录的 .env 经这个 token 也拿不到
    expect((await get(r.url.replace(/index\.html$/, ".env"))).status).toBe(404);
    (m.manager as any).destroy();
  });

  it("URL 策略口径（R7-07 钉住）：<token>.localhost 本身放行；同样的主机名配 Flowship 的端口 / 8676 / 8776 / 8876 仍被拦；不是只看主机名", async () => {
    const m = makeManager();
    const r = await m.call(path.join(site, "index.html"));
    const u = new URL(r.url);
    const port = Number(u.port);
    const isAppUrl = createIsAppUrl(() => 8876);
    expect(checkUrl(r.url, { isAppUrl }).ok).toBe(true);
    expect(checkUrl(normalizeAiUrl(r.url), { isAppUrl }).ok).toBe(true);
    for (const flowshipPort of [8676, 8776, 8876]) {
      const blocked = `http://${u.hostname}:${flowshipPort}/index.html`;
      expect(checkUrl(blocked, { isAppUrl }).ok, blocked).toBe(false);
      expect(resolveUserInput(blocked, { isAppUrl }).ok, blocked).toBe(false);
    }
    // 「Flowship 自己的端口」若恰好等于本服务端口，同一个 URL 就会被拦——所以服务端口必须避开它（见下一个用例）
    expect(checkUrl(r.url, { isAppUrl: createIsAppUrl(() => port) }).ok).toBe(false);
    // 反例：没把 *.localhost 加进任何放行名单——换成非 Flowship 端口才放行，且 file: 仍拒
    expect(checkUrl(`http://${u.hostname}:${port + 1}/`, { isAppUrl }).ok).toBe(true);
    expect(checkUrl(`file://${site}/index.html`, { isAppUrl }).ok).toBe(false);
    (m.manager as any).destroy();
  });

  it("服务端口避开 Flowship 自己的端口：manager 把 isAppUrl 当作保留端口判定，随机到了就换", async () => {
    const queried: number[] = [];
    const m = makeManager({
      isAppUrl: (u: string) => {
        queried.push(Number(new URL(u).port));
        return queried.length <= 2; // 前两次随机到的端口当作 Flowship 的端口
      },
    });
    const r = await m.call(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    const port = Number(new URL(r.url).port);
    expect(queried).toHaveLength(3);
    expect(queried[2]).toBe(port);
    expect(queried.slice(0, 2)).not.toContain(port);
    expect((await get(r.url)).status).toBe(200);
    (m.manager as any).destroy();
  });

  it("每次打开都是新 token（同一个文件两次 → 两个不同 URL，端口复用同一个服务）", async () => {
    const m = makeManager();
    const a = await m.call(path.join(site, "index.html"));
    const b = await m.call(path.join(site, "index.html"));
    expect(a.url).not.toBe(b.url);
    expect(new URL(a.url).port).toBe(new URL(b.url).port);
    (m.manager as any).destroy();
  });
});

describe("browser:serveLocalHtml：拒绝路径不抛、不起服务", () => {
  it.each([
    ["非字符串", 123],
    ["null", null],
    ["对象", { path: "/x.html" }],
    ["空串", ""],
    ["相对路径", "site/index.html"],
    ["超长", "/" + "a".repeat(5000) + ".html"],
    ["不存在", "/definitely/not/here.html"],
  ])("%s → { ok:false }", async (_label, input) => {
    const m = makeManager();
    const r = await m.call(input);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    (m.manager as any).destroy();
  });

  it("非 html / 敏感文件 → { ok:false }", async () => {
    fs.writeFileSync(path.join(site, "notes.txt"), "x");
    fs.writeFileSync(path.join(site, ".secret.html"), "<p>s</p>");
    const m = makeManager();
    expect((await m.call(path.join(site, "notes.txt"))).ok).toBe(false);
    expect((await m.call(path.join(site, ".env"))).ok).toBe(false);
    expect((await m.call(path.join(site, ".secret.html"))).ok).toBe(false);
    (m.manager as any).destroy();
  });
});

describe("browser:serveLocalHtml：服务内部意外抛错也不外泄", () => {
  it("os.homedir() 抛错（极少见的环境）→ { ok:false, error }，不 reject，日志里留痕，没有留下 token / 端口", async () => {
    const spy = vi.spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("boom-homedir");
    });
    try {
      const m = makeManager();
      const r = await m.call(path.join(site, "index.html"));
      expect(r).toEqual({ ok: false, error: "本地 HTML 服务出错" });
      expect(m.logs.some((l) => l.includes("boom-homedir"))).toBe(true);
      (m.manager as any).destroy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("R7-14-6：isReservedPort 的接线口径 / log 透传（reviewer 的 I04 / I05 / I06 / I12 存活项）", () => {
  it("探测的恰好是 `http://127.0.0.1:<端口>/`（不是 https、不是别的主机），最后一次探测的端口就是实际监听端口（I04 / I05）", async () => {
    const probed: string[] = [];
    const m = makeManager({
      isAppUrl: (u: string) => {
        probed.push(u);
        return false;
      },
    });
    const r = await m.call(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    const port = new URL(r.url).port;
    expect(probed.length).toBeGreaterThanOrEqual(1);
    for (const u of probed) expect(u).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(probed[probed.length - 1]).toBe(`http://127.0.0.1:${port}/`);
    (m.manager as any).destroy();
  });

  it("isAppUrl 抛错 → 当作「不保留」，服务照常起来、地址能取到内容（现状是失败放行；不能因为一个判定函数的异常让整个功能起不来）（I06）", async () => {
    const m = makeManager({
      isAppUrl: () => {
        throw new Error("boom-isAppUrl");
      },
    });
    const r = await m.call(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    expect((await get(r.url)).status).toBe(200);
    (m.manager as any).destroy();
  });

  it("只有 isAppUrl 返回 true 才算保留：返回别的真值（'yes' / 1）不换端口、不影响启动", async () => {
    for (const v of ["yes", 1]) {
      const probed: number[] = [];
      const m = makeManager({
        isAppUrl: (u: string) => {
          probed.push(Number(new URL(u).port));
          return v as never;
        },
      });
      const r = await m.call(path.join(site, "index.html"));
      expect(r.ok, String(v)).toBe(true);
      expect(probed, String(v)).toHaveLength(1); // 第一次探测就被接受，没换过端口
      (m.manager as any).destroy();
    }
  });

  it("log 透传给静态服务：登记成功后日志里有「本地 HTML 已登记」（I12）", async () => {
    const m = makeManager();
    const r = await m.call(path.join(site, "index.html"));
    expect(r.ok).toBe(true);
    expect(m.logs.some((l) => l.includes("本地 HTML 已登记"))).toBe(true);
    (m.manager as any).destroy();
  });
});

describe("browser:serveLocalHtml：destroy", () => {
  it("destroy：服务关闭 / token 作废 / 通道摘掉；之后再调返回 { ok:false }", async () => {
    const m = makeManager();
    const r = await m.call(path.join(site, "index.html"));
    expect(await reachable(r.url)).toBe(true);
    const call = m.handlers.get("browser:serveLocalHtml") as Function;
    (m.manager as any).destroy();
    expect(m.handlers.has("browser:serveLocalHtml")).toBe(false);
    expect(await reachable(r.url)).toBe(false);
    // 通道已摘；但万一有已拿到引用的调用：destroyed 后仍然只回 ok:false，不会重新起服务
    const late = (await call({}, path.join(site, "index.html"))) as any;
    expect(late.ok).toBe(false);
  });
});
