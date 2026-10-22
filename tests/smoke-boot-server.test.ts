/**
 * 发版冒烟脚本 scripts/smoke-boot-server.mjs 的行为契约（review #17）。
 * 用「假 server.js」端到端跑脚本：健康 → 0；起不来 / 首页非 200 / 静态资源缺失 → 非 0。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../scripts/smoke-boot-server.mjs");
const roots: string[] = [];

/** 写一个最小 server.js：按 mode 决定各端点行为 */
const makeServer = (
  mode: "ok" | "home500" | "no-assets" | "asset404" | "crash",
): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "smoke-fake-"));
  roots.push(dir);
  mkdirSync(dir, { recursive: true });
  const src = `
const http = require("node:http");
const mode = ${JSON.stringify(mode)};
if (mode === "crash") { console.error("boom: Cannot find module 'x'"); process.exit(3); }
const html = (assets) =>
  "<!doctype html><html><head>" +
  (assets ? '<script src="/_next/static/chunks/main.js"></script>' : "") +
  "</head><body>hi</body></html>";
http.createServer((req, res) => {
  if (req.url === "/api/readyz") { res.setHeader("content-type", "application/json"); return res.end('{"ok":true}'); }
  if (req.url === "/") {
    if (mode === "home500") { res.statusCode = 500; return res.end("err"); }
    res.setHeader("content-type", "text/html");
    return res.end(html(mode !== "no-assets"));
  }
  if (req.url.startsWith("/_next/static/")) {
    if (mode === "asset404") { res.statusCode = 404; return res.end("nf"); }
    return res.end("console.log(1)");
  }
  res.statusCode = 404; res.end("nf");
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
  writeFileSync(path.join(dir, "server.js"), src);
  return dir;
};

const run = (dir: string, extra: string[] = []) =>
  spawnSync(
    process.execPath,
    [SCRIPT, "--server-dir", dir, "--timeout-ms", "8000", ...extra],
    { encoding: "utf8", timeout: 30_000 },
  );

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("smoke-boot-server.mjs", () => {
  it("健康 server：exit 0", () => {
    const r = run(makeServer("ok"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  it("启动即崩：exit 1，带 server 输出尾部", () => {
    const r = run(makeServer("crash"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("提前退出");
    expect(r.stderr).toContain("Cannot find module");
  });

  it("首页 500：exit 1", () => {
    const r = run(makeServer("home500"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GET / 返回 500");
  });

  it("首页没有静态资源引用：exit 1", () => {
    const r = run(makeServer("no-assets"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("/_next/static");
  });

  it("静态资源 404（standalone 漏拷 .next/static）：exit 1", () => {
    const r = run(makeServer("asset404"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("返回 404");
  });

  it("没有 server.js：exit 1", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "smoke-empty-"));
    roots.push(dir);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("server.js");
  });
});
