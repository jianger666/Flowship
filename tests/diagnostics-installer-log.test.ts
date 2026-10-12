/** 诊断包带上 Windows 安装器日志：「更新后 App 没了 / 装到一半」这类黑盒问题靠它定位。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportDiagnostics, readInstallerLogTail } from "../src/lib/server/diagnostics";

const ENV_KEYS = ["FLOWSHIP_DATA_DIR", "HOME", "USERPROFILE"] as const;

let root: string;
let logsDir: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-diag-"));
  logsDir = path.join(root, "logs");
  mkdirSync(path.join(root, "data"), { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // dataRoot() = <userData>/data，壳日志在 <userData>/logs（与生产布局一致）
  process.env.FLOWSHIP_DATA_DIR = path.join(root, "data");
  // 家目录也指到临时目录：exportDiagnostics 首选写 ~/Downloads，绝不能在测试里写进真实下载目录
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("readInstallerLogTail", () => {
  it("没有 installer.log（mac / 没走过新安装器）→ null，诊断包不制造「读取失败」噪声", async () => {
    expect(await readInstallerLogTail()).toBeNull();
    mkdirSync(logsDir, { recursive: true });
    expect(await readInstallerLogTail()).toBeNull();
  });

  it("有则原样返回", async () => {
    mkdirSync(logsDir, { recursive: true });
    const text = "[ts=1760000000] init v1.9.30 updated=1 tempFreeMB=312\r\n";
    writeFileSync(path.join(logsDir, "installer.log"), text);
    expect(await readInstallerLogTail()).toBe(text);
  });

  it("超过 64KB 只取尾部（最新的几次安装记录最有价值）", async () => {
    mkdirSync(logsDir, { recursive: true });
    const old = "OLD-LINE\r\n".repeat(20_000); // 200KB 旧记录
    const latest = "[ts=1760000999] done v1.9.30 updated=1 marker=ok elapsedSec=412\r\n";
    writeFileSync(path.join(logsDir, "installer.log"), old + latest);
    const tail = await readInstallerLogTail();
    expect(tail).not.toBeNull();
    expect(Buffer.byteLength(tail ?? "")).toBe(64 * 1024);
    expect(tail?.endsWith(latest)).toBe(true);
  });
});

describe("exportDiagnostics 把 installer.log 带进诊断包", () => {
  it("有 installer.log → 单独一节、排在 main.log 之前", { timeout: 30_000 }, async () => {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, "installer.log"),
      "[ts=1760000000] ABORT v1.9.30 tempFreeMB=212 < 800 old install untouched\r\n",
    );
    writeFileSync(path.join(logsDir, "main.log"), "[main] hello\n");

    const target = await exportDiagnostics("1.9.30");
    const content = readFileSync(target, "utf8");

    const installerAt = content.indexOf("===== installer.log");
    const mainAt = content.indexOf("===== main.log 尾部");
    expect(installerAt).toBeGreaterThanOrEqual(0);
    expect(mainAt).toBeGreaterThan(installerAt);
    expect(content).toContain("ABORT v1.9.30 tempFreeMB=212 < 800 old install untouched");
    // 没落进真实家目录（HOME 已指向临时目录、其下没有 Downloads → 回退写数据目录）
    expect(target.startsWith(root)).toBe(true);
  });

  it("没有 installer.log → 诊断包里没有这一节", { timeout: 30_000 }, async () => {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(path.join(logsDir, "main.log"), "[main] hello\n");
    const content = readFileSync(await exportDiagnostics("1.9.30"), "utf8");
    expect(content).not.toContain("===== installer.log");
    expect(content).toContain("===== main.log 尾部");
  });
});
