/** 启动超时链路契约：一次性 30s 曾导致 Windows 首次启动必现"启动超时"。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mainJsPath = path.resolve(import.meta.dirname, "..", "electron-app/main.js");
const main = readFileSync(mainJsPath, "utf8");

describe("启动超时不再一刀切（首次冷启动给足时间）", () => {
  it("electron-app/main.js 是纯 JS ESM，不能夹带 TS 语法（node --check 必须通过）", () => {
    expect(() => {
      execFileSync(process.execPath, ["--check", mainJsPath], { encoding: "utf8" });
    }).not.toThrow();
  });

  it("默认超时 60s、首次 150s，不再是 30s 一次性", () => {
    expect(main).toContain("timeoutMs = 60_000");
    expect(main).toContain("150_000 : 60_000");
    expect(main).toContain("first-boot-done");
    expect(main).toContain("markFirstBootDone()");
  });

  it("超时后 server 还活着 → 给继续等待（2 分钟一段），而不是直接退出", () => {
    expect(main).toContain("继续等待");
    expect(main).toContain("waitForReady(120_000)");
    expect(main).toContain("serverProc.exitCode === null");
  });

  it("旧的 30 秒判死刑文案已下线", () => {
    expect(main).not.toContain("30 秒内没有就绪");
  });

  it("诊断日志：机器快照 + 每轮耗时 + 失败总结（两次启动对比用）", () => {
    expect(main).toContain("[main] machine platform=");
    expect(main).toContain("首轮等待");
    expect(main).toContain("续等一轮");
    expect(main).toContain("server 未就绪、放弃启动");
  });
});
