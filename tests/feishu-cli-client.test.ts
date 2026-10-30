/**
 * 设置页「飞书集成」的写请求封装（R14 B6-2 / Q6-05）。
 *
 * 台账原症状：点「安装」后，接口回 4xx / 5xx、断网时界面照样弹「已开始下载安装（后台进行）」，用户以为在装、其实没动；
 * 服务端「已有一轮在装」（started:false）也被当成「刚开始」。登录 / 卸载则直接 `res.json()`——
 * 网关回 HTML 错误页或断网时抛出没人接的 rejection、界面没有任何提示。
 *
 * 分层：requestFeishuCli 是纯请求封装（注入假 fetch）；组件里的三态分支没有 DOM 环境可测，只有源码契约。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FEISHU_CLI_ENDPOINT, requestFeishuCli } from "@/lib/feishu-cli-client";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const html = (status: number): Response =>
  new Response("<html><body>Bad Gateway</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("请求形状", () => {
  it("POST：发到 /api/system/feishu-cli，带 JSON 头和 JSON body", async () => {
    const fake = vi.fn(async () => json({ ok: true, started: true }));
    await requestFeishuCli("POST", { action: "install" }, asFetch(fake));
    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FEISHU_CLI_ENDPOINT);
    expect(FEISHU_CLI_ENDPOINT).toBe("/api/system/feishu-cli");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ action: "install" });
  });

  it("DELETE：不带 body、不带 JSON 头", async () => {
    const fake = vi.fn(async () => json({ ok: true }));
    await requestFeishuCli("DELETE", undefined, asFetch(fake));
    const [, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(init).not.toHaveProperty("body");
    expect(init).not.toHaveProperty("headers");
  });

  it("不传 fetchImpl 时用全局 fetch", async () => {
    const fake = vi.fn(async () => json({ ok: true, started: false }));
    vi.stubGlobal("fetch", fake);
    const r = await requestFeishuCli("POST", { action: "install" });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, data: { ok: true, started: false } });
  });
});

describe("成功", () => {
  it("安装：已开始 → data.started 为 true", async () => {
    const r = await requestFeishuCli("POST", { action: "install" }, asFetch(async () => json({ ok: true, started: true })));
    expect(r).toEqual({ ok: true, data: { ok: true, started: true } });
  });

  it("安装：已有一轮在跑 → data.started 为 false（调用方据此提示「已在进行中」）", async () => {
    const r = await requestFeishuCli("POST", { action: "install" }, asFetch(async () => json({ ok: true, started: false })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.started).toBe(false);
  });

  it("200 但响应体为空 / 不是 JSON：仍算成功，data 为空对象（成败只看 res.ok）", async () => {
    const r = await requestFeishuCli("DELETE", undefined, asFetch(async () => new Response("", { status: 200 })));
    expect(r).toEqual({ ok: true, data: {} });
  });

  it("200 但响应体是数组 / null：data 兜成空对象，不把非对象当数据", async () => {
    for (const body of [[1, 2], null]) {
      const r = await requestFeishuCli("POST", { action: "x" }, asFetch(async () => json(body)));
      expect(r).toEqual({ ok: true, data: {} });
    }
  });
});

describe("失败：message 一定非空、永不抛", () => {
  it("4xx 带 error：原样给出服务端的话", async () => {
    const r = await requestFeishuCli("POST", { action: "nope" }, asFetch(async () => json({ error: "未知 action" }, 400)));
    expect(r).toEqual({ ok: false, message: "未知 action" });
  });

  it("409 的 error 带首尾空白：trim 后给出", async () => {
    const r = await requestFeishuCli("POST", { action: "login" }, asFetch(async () => json({ error: "  已有登录流程在跑  " }, 409)));
    expect(r).toEqual({ ok: false, message: "已有登录流程在跑" });
  });

  it("网关回 HTML 错误页（res.json() 会抛）：不抛，给出带状态码的说明", async () => {
    const r = await requestFeishuCli("POST", { action: "install" }, asFetch(async () => html(502)));
    expect(r).toEqual({ ok: false, message: "请求失败（HTTP 502）" });
  });

  it("error 不是字符串 / 只有空白：回退到状态码说明", async () => {
    for (const error of [{ code: 1 }, "   ", 500, null]) {
      const r = await requestFeishuCli("POST", { action: "x" }, asFetch(async () => json({ error }, 500)));
      expect(r, JSON.stringify(error)).toEqual({ ok: false, message: "请求失败（HTTP 500）" });
    }
  });

  it("断网（fetch 抛 TypeError）：不抛，说明是网络错误", async () => {
    const r = await requestFeishuCli("POST", { action: "install" }, asFetch(async () => {
      throw new TypeError("Failed to fetch");
    }));
    expect(r).toEqual({ ok: false, message: "网络错误：Failed to fetch" });
  });

  it("fetch 抛的不是 Error（字符串）：也不抛", async () => {
    const r = await requestFeishuCli("DELETE", undefined, asFetch(async () => {
      throw "connection reset";
    }));
    expect(r).toEqual({ ok: false, message: "网络错误：connection reset" });
  });
});

describe("设置页接线（源码契约：没有 DOM 测试环境）", () => {
  const src = read("src/components/settings/feishu-cli-card.tsx");
  const slice = (from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    expect(a, `找不到 ${from}`).toBeGreaterThan(-1);
    expect(b, `找不到 ${to}`).toBeGreaterThan(a);
    return src.slice(a, b);
  };

  it("安装：失败 toast.error、已在进行中 toast.info、其余才是「已开始」（判 === false，兼容旧服务端不回 started）", () => {
    const install = slice("const handleInstall", "const handleLogin");
    expect(install).toContain('requestFeishuCli("POST", { action: "install" })');
    const failed = install.indexOf("!r.ok");
    const already = install.indexOf("r.data.started === false");
    const info = install.indexOf('toast.info("安装已在进行中")');
    const success = install.indexOf('toast.success("已开始下载安装');
    expect(failed, "缺 !r.ok 分支").toBeGreaterThan(-1);
    expect(already, "缺 started === false 分支（应在 !r.ok 之后）").toBeGreaterThan(failed);
    expect(info, "缺 toast.info（应在 started === false 之后）").toBeGreaterThan(already);
    expect(success, "「已开始」不应在 started === false 之前、更不能无条件弹").toBeGreaterThan(info);
    expect(install).toContain("toast.error(");
    expect(install).not.toMatch(/\bawait fetch\(/);
  });

  it("登录 / 卸载：同一个封装，不再直接 res.json()", () => {
    const rest = slice("const handleLogin", "const handlePickSpace");
    expect(rest).toContain('requestFeishuCli("POST", { action: "login", tool })');
    expect(rest).toContain('requestFeishuCli("DELETE")');
    expect(rest).not.toContain("res.json()");
    expect(rest).not.toMatch(/\bawait fetch\(/);
  });

  it("登录 / 卸载失败：各自弹 toast.error 并带上封装给的原因（不再静默）", () => {
    const login = slice("const handleLogin", "const handleUninstall");
    expect(login).toContain("toast.error(`登录发起失败：${r.message}`)");
    const uninstall = slice("const handleUninstall", "const handlePickSpace");
    expect(uninstall).toContain("toast.error(`卸载失败：${r.message}`)");
  });

  it("安装发起后（成功 / 已在进行中 / 失败）都刷新一次，让状态行与 2 秒轮询接管进度和错误显示", () => {
    const install = slice("const handleInstall", "const handleLogin");
    const success = install.indexOf('toast.success("已开始下载安装');
    const refresh = install.indexOf("void refresh();");
    expect(refresh, "安装发起后没有 void refresh()").toBeGreaterThan(success);
    expect(refresh, "refresh 应在 try 块里、finally 之前").toBeLessThan(install.indexOf("finally"));
  });

  it("整个文件：写请求都走封装，只剩状态轮询那一处 GET 用裸 fetch", () => {
    expect(src).not.toMatch(/fetch\("\/api\/system\/feishu-cli",\s*\{/);
    expect(src).toContain('fetch("/api/system/feishu-cli")');
  });
});
