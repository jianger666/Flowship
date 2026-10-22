/**
 * server 子进程的 Node 启动旗标（electron-app/node-options.mjs + main.js 接线契约）
 *
 * 第三轮 review N3-01（P1）：旗标走 argv，**不再写 NODE_OPTIONS**。
 *   - NODE_OPTIONS 会被 server 的所有子孙进程继承；用户 PATH 上 Node < 22.13 遇到 `--report-exclude-env`
 *     会 `exit 9`（not allowed in NODE_OPTIONS），agent shell 里的 pnpm / npm / tsc / vitest / hooks 全起不来。
 *   - argv 不被继承；含空格的 report 目录（macOS「Application Support」）也不再需要引号。
 *
 * 钉死的语义：
 * - buildServerNodeArgs 的默认 / 用户已设 / 版本门控三类输出
 * - 真 Node：argv 里含空格的 --report-directory 逐字符往返；孙进程的 NODE_OPTIONS / execArgv 干净
 * - main.js 接线：旗标进 spawn 的 argv 数组，spawn 的 env 里没有 NODE_OPTIONS 改写；本地 .mjs 都真实存在且会被打进包
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildServerNodeArgs,
  supportsReportExcludeEnv,
} from "../electron-app/node-options.mjs";

const root = path.resolve(import.meta.dirname, "..");
const main = readFileSync(path.join(root, "electron-app/main.js"), "utf8");

const REPORT_DIR =
  "/Users/x/Library/Application Support/fe-ai-flow/data/diagnostics/node-reports";

describe("buildServerNodeArgs（纯函数）", () => {
  it("默认：堆上限 + 取证旗标 + exclude-env（支持时）+ 原样（不加引号）的 report 目录", () => {
    expect(
      buildServerNodeArgs({ userNodeOptions: "", nodeVersion: "24.16.0", reportDir: REPORT_DIR }),
    ).toEqual([
      "--max-old-space-size=4096",
      "--report-on-fatalerror",
      "--report-uncaught-exception",
      "--report-exclude-env",
      `--report-directory=${REPORT_DIR}`,
    ]);
  });

  it("用户自己的 NODE_OPTIONS 已设同名项：不再追加（不覆盖手工值）", () => {
    const args = buildServerNodeArgs({
      userNodeOptions:
        "--max-old-space-size=8192 --report-on-fatalerror --report-uncaught-exception --report-exclude-env --report-directory=/tmp/x",
      nodeVersion: "24.16.0",
      reportDir: REPORT_DIR,
    });
    expect(args).toEqual([]);
  });

  it("版本门控：内嵌 Node 不认 --report-exclude-env 就不加（argv 里的未知旗标会让 server 起不来）", () => {
    const args = buildServerNodeArgs({
      userNodeOptions: undefined,
      nodeVersion: "22.12.0",
      reportDir: REPORT_DIR,
    });
    expect(args).not.toContain("--report-exclude-env");
    expect(args).toContain("--max-old-space-size=4096");
  });

  it("返回的是 argv 数组元素：含空格的目录是一个元素，不被切词、不带引号", () => {
    const args = buildServerNodeArgs({ userNodeOptions: "", nodeVersion: "24.16.0", reportDir: REPORT_DIR });
    const dirArg = args.find((a: string) => a.startsWith("--report-directory="));
    expect(dirArg).toBe(`--report-directory=${REPORT_DIR}`);
    expect(dirArg).not.toMatch(/"/);
  });
});

describe("真 Node：旗标走 argv", () => {
  const probe = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(
      process.execPath,
      [
        ...args,
        "-e",
        "process.stdout.write(JSON.stringify({dir:process.report.directory,excl:process.report.excludeEnv,opts:process.env.NODE_OPTIONS??null}))",
      ],
      { env: { ...process.env, NODE_OPTIONS: undefined, ...env } as NodeJS.ProcessEnv, encoding: "utf8" },
    );

  it.each([
    ["正式包真实形态（macOS Application Support）", REPORT_DIR],
    ["无空格", "/tmp/plain/dir"],
    ["引号字符 + 空格", '/tmp/qu"ote and space/dir'],
    ["中文 + 空格", "/tmp/中文 目录/报告"],
  ])("argv 里的 --report-directory 往返：%s", (_n, dir) => {
    const r = probe([`--report-directory=${dir}`]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { dir: string; opts: string | null };
    expect(out.dir).toBe(dir);
    expect(out.opts).toBeNull();
  });

  it("当前 Node 支持 --report-exclude-env ⇒ argv 形式真能起且生效", () => {
    if (!supportsReportExcludeEnv(process.versions.node)) return;
    const r = probe(["--report-exclude-env"]);
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { excl: boolean }).excl).toBe(true);
  });

  it("孙进程不继承 argv 旗标（这正是不写 NODE_OPTIONS 的意义）", () => {
    // server（带 argv 旗标）→ 孙进程：孙进程的 execArgv 里没有任何继承来的 --max-old-space-size / --report-*、NODE_OPTIONS 未设
    const grandchild =
      "process.stdout.write(JSON.stringify({exec:process.execArgv.filter((a)=>/^--(max-old|report)/.test(a)),opts:process.env.NODE_OPTIONS??null}))";
    const server = `const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(
      grandchild,
    )}],{encoding:'utf8',env:process.env});process.stdout.write(r.stdout)`;
    const r = spawnSync(
      process.execPath,
      ["--max-old-space-size=4096", "--report-on-fatalerror", "-e", server],
      { env: { ...process.env, NODE_OPTIONS: undefined } as NodeJS.ProcessEnv, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ exec: [], opts: null });
  });
});

describe("supportsReportExcludeEnv（版本门控）", () => {
  it("v23.3.0 引入、v22.13.0 回移，更老的版本不加", () => {
    expect(supportsReportExcludeEnv("24.16.0")).toBe(true);
    expect(supportsReportExcludeEnv("v24.0.0")).toBe(true);
    expect(supportsReportExcludeEnv("23.3.0")).toBe(true);
    expect(supportsReportExcludeEnv("23.2.9")).toBe(false);
    expect(supportsReportExcludeEnv("22.13.0")).toBe(true);
    expect(supportsReportExcludeEnv("22.12.9")).toBe(false);
    expect(supportsReportExcludeEnv("20.18.0")).toBe(false);
    expect(supportsReportExcludeEnv("")).toBe(false);
    expect(supportsReportExcludeEnv(undefined)).toBe(false);
    expect(supportsReportExcludeEnv("garbage")).toBe(false);
  });
});

describe("main.js 接线契约", () => {
  it("旗标进 spawn 的 argv 数组（入口脚本之前），spawn 的 env 里不改写 NODE_OPTIONS", () => {
    expect(main).toMatch(/import\s*\{[^}]*\bbuildServerNodeArgs\b[^}]*\}\s*from\s*"\.\/node-options\.mjs";/);
    expect(main).toMatch(/spawn\(serverNodeBin\(\),\s*\[\.\.\.serverNodeArgs,\s*serverJs\]/);
    // 从 spawn 到 stdio 这一段 env 里不能再有 NODE_OPTIONS（N3-01）
    const spawnAt = main.indexOf("spawn(serverNodeBin()");
    const stdioAt = main.indexOf("stdio:", spawnAt);
    expect(spawnAt).toBeGreaterThan(-1);
    expect(main.slice(spawnAt, stdioAt)).not.toMatch(/NODE_OPTIONS\s*:/);
  });

  it("main.js 不再有 serverNodeOptions / 把 --report-* 或 --max-old-space-size 拼进 NODE_OPTIONS 的写法", () => {
    expect(main).not.toMatch(/serverNodeOptions/);
    expect(main).not.toMatch(/NODE_OPTIONS\s*:\s*[^\n]*join/);
    expect(main).not.toMatch(/quoteNodeOptionValue/);
  });

  it("main.js 引入的本地模块都真实存在，且 electron-builder 不会把它们漏出包外", () => {
    const rels = [...main.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((m) => m[1]);
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      expect(existsSync(path.join(root, "electron-app", rel)), rel).toBe(true);
    }
    // 未配置 files 白名单 = 默认打包整个 app 目录，新增 .mjs 自动带上；
    // 一旦将来加了白名单，必须把这些模块都列进去，否则打出来的包启动即崩
    const pkg = JSON.parse(
      readFileSync(path.join(root, "electron-app/package.json"), "utf8"),
    ) as { build?: { files?: string[] } };
    const files = pkg.build?.files;
    if (files) {
      for (const rel of rels) {
        const name = rel.replace(/^\.\//, "");
        const covered = files.some(
          (p) => p === name || p === "*.mjs" || p === "**/*" || p === "**",
        );
        expect(covered, `${name} 未被 build.files 覆盖`).toBe(true);
      }
    }
  });

  it("main.js：主窗口有 960×600 的最小尺寸", () => {
    const win = main.slice(main.indexOf("mainWindow = new BrowserWindow({"));
    expect(win.slice(0, 600)).toMatch(/minWidth:\s*960/);
    expect(win.slice(0, 600)).toMatch(/minHeight:\s*600/);
  });
});
