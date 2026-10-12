/** 启动超时链路契约：一次性 30s 曾导致 Windows 首次启动必现"启动超时"。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mainJsPath = path.resolve(import.meta.dirname, "..", "electron-app/main.js");
const main = readFileSync(mainJsPath, "utf8");
const firstBoot = readFileSync(
  path.resolve(import.meta.dirname, "..", "electron-app/first-boot.mjs"),
  "utf8",
);

describe("启动超时不再一刀切（首次冷启动给足时间）", () => {
  it("electron-app/main.js 是纯 JS ESM，不能夹带 TS 语法（node --check 必须通过）", () => {
    expect(() => {
      execFileSync(process.execPath, ["--check", mainJsPath], { encoding: "utf8" });
    }).not.toThrow();
  });

  it("默认超时 60s、首次 150s，不再是 30s 一次性（取值在 first-boot.mjs、壳里只调用）", () => {
    expect(main).toContain("timeoutMs = 60_000");
    expect(main).toContain("pickBootTimeoutMs(firstBoot)");
    expect(firstBoot).toContain("FIRST_BOOT_TIMEOUT_MS = 150_000");
    expect(firstBoot).toContain("REGULAR_BOOT_TIMEOUT_MS = 60_000");
    expect(main).toContain("first-boot-done");
    expect(main).toContain("markFirstBootDone()");
  });

  it("首启标记按版本记：判定走 shouldTreatAsFirstBoot、写入带当前版本（更新后首次启动也给宽限）", () => {
    expect(main).toContain('from "./first-boot.mjs"');
    expect(main).toContain("shouldTreatAsFirstBoot(raw, app.getVersion())");
    expect(main).toContain("buildFirstBootMarker(app.getVersion())");
    // 不能退回「文件在不在」的全局一次性判定
    expect(main).not.toContain("return !existsSync(firstBootDoneFile())");
  });

  it("启动偏慢（>30s）时就绪后后台记杀软清单；超时弹框写明日志目录", () => {
    expect(main).toContain("SLOW_BOOT_PROBE_MS = 30_000");
    expect(main).toContain("if (bootElapsedMs > SLOW_BOOT_PROBE_MS) void logSecurityProducts()");
    // 取证放在「就绪之后」：不跟启动抢 CPU / 磁盘
    const ready = main.indexOf("server 就绪、轮询耗时");
    const probe = main.indexOf("void logSecurityProducts()");
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(ready);
    // 只读 SecurityCenter2、10s 超时自杀
    expect(main).toContain("root/SecurityCenter2");
    expect(main).toContain("timeout: 10_000");
    expect(main).toContain('path.join(app.getPath("userData"), "logs")');
  });

  it("超时后 server 还活着 → 给继续等待（2 分钟一段），而不是直接退出", () => {
    expect(main).toContain("继续等待");
    expect(main).toContain("waitForReady(120_000)");
    expect(main).toContain("serverProc.exitCode === null");
  });

  it("旧的 30 秒判死刑文案已下线", () => {
    expect(main).not.toContain("30 秒内没有就绪");
  });

  it("诊断日志：机器快照 + 磁盘剩余 + 启动参数 + 每轮耗时 + 失败总结（两次启动对比用）", () => {
    expect(main).toContain("[main] machine platform=");
    expect(main).toContain("[main] disk install=");
    expect(main).toContain("statfsSync(dir)");
    expect(main).toContain("argv=");
    expect(main).toContain("首轮等待");
    expect(main).toContain("续等一轮");
    expect(main).toContain("server 未就绪、放弃启动");
  });
});
