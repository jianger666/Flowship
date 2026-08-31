import { describe, expect, it } from "vitest";

import {
  ASK_WAIT_SHELL_TIMEOUT_MS,
  formatShellFailureText,
  prepareEditPathArgs,
  prepareGlobArgs,
  prepareReadArgs,
  prepareShellArgs,
  prepareWriteArgs,
  resolveShellTimeoutMs,
  resolveShellTimeoutMsForCommand,
} from "../src/lib/server/pi-coding-tools";

describe("resolveShellTimeoutMs", () => {
  it("未传 / 非法值用默认 60 秒", () => {
    expect(resolveShellTimeoutMs(undefined)).toBe(60_000);
    expect(resolveShellTimeoutMs(null)).toBe(60_000);
    expect(resolveShellTimeoutMs(0)).toBe(60_000);
    expect(resolveShellTimeoutMs(-1)).toBe(60_000);
    expect(resolveShellTimeoutMs(Number.NaN)).toBe(60_000);
  });

  it("小于 1000 当秒（模型常传 15 / 30 / 60）", () => {
    expect(resolveShellTimeoutMs(15)).toBe(15_000);
    expect(resolveShellTimeoutMs(30)).toBe(30_000);
    expect(resolveShellTimeoutMs(60)).toBe(60_000);
  });

  it("大于等于 1000 当毫秒", () => {
    expect(resolveShellTimeoutMs(15_000)).toBe(15_000);
    expect(resolveShellTimeoutMs(60_000)).toBe(60_000);
  });

  it("夹到 1 秒 ~ 10 分钟，避免再出现 15ms 秒杀", () => {
    expect(resolveShellTimeoutMs(1)).toBe(1_000);
    expect(resolveShellTimeoutMs(2)).toBe(2_000);
    expect(resolveShellTimeoutMs(999)).toBe(10 * 60 * 1000);
    expect(resolveShellTimeoutMs(20 * 60 * 1000)).toBe(10 * 60 * 1000);
  });

  it("ask-wait curl 无视模型 120s，按 24h 挂", () => {
    const cmd =
      'curl -NsS --no-buffer "http://127.0.0.1:8676/api/tasks/t1/ask-wait?token=abc"';
    expect(resolveShellTimeoutMsForCommand(cmd, 120_000)).toBe(
      ASK_WAIT_SHELL_TIMEOUT_MS,
    );
    expect(resolveShellTimeoutMsForCommand("ls", 120_000)).toBe(120_000);
  });
});

describe("formatShellFailureText", () => {
  it("超时被杀时明确说可以出网，避免模型误判环境隔离", () => {
    expect(
      formatShellFailureText({ timeoutMs: 15_000, killed: true }),
    ).toContain("可以访问外网");
    expect(
      formatShellFailureText({
        timeoutMs: 15_000,
        killed: true,
        stdout: "partial",
      }),
    ).toMatch(/可以访问外网[\s\S]*partial/);
  });

  it("普通失败仍优先 stdout/stderr", () => {
    expect(
      formatShellFailureText({
        timeoutMs: 60_000,
        stdout: "oops",
        message: "Command failed",
      }),
    ).toBe("oops");
  });
});

describe("Cursor 参数别名 → pi 规范字段", () => {
  it("write：fileText → content，已有 content 不覆盖", () => {
    expect(prepareWriteArgs({ path: "/a.md", fileText: "hello" })).toEqual({
      path: "/a.md",
      content: "hello",
    });
    expect(
      prepareWriteArgs({ path: "/a.md", content: "keep", fileText: "ignore" }),
    ).toEqual({ path: "/a.md", content: "keep" });
  });

  it("write：target_file / file_path → path", () => {
    expect(prepareWriteArgs({ target_file: "/b.md", contents: "x" })).toEqual({
      path: "/b.md",
      content: "x",
    });
  });

  it("glob：globPattern / targetDirectory → pattern / path", () => {
    expect(
      prepareGlobArgs({ globPattern: "**/*.ts", targetDirectory: "src" }),
    ).toEqual({ pattern: "**/*.ts", path: "src" });
    expect(prepareGlobArgs({ pattern: "*.md" })).toEqual({ pattern: "*.md" });
  });

  it("shell：working_directory / cwd → workingDirectory", () => {
    expect(prepareShellArgs({ command: "ls", cwd: "/tmp" })).toEqual({
      command: "ls",
      workingDirectory: "/tmp",
    });
    expect(
      prepareShellArgs({ command: "ls", workingDirectory: "/keep", cwd: "/no" }),
    ).toEqual({ command: "ls", workingDirectory: "/keep" });
  });

  it("read / edit：只收路径别名，不动其余字段", () => {
    expect(prepareReadArgs({ file_path: "/x.ts", offset: 2 })).toEqual({
      path: "/x.ts",
      offset: 2,
    });
    expect(
      prepareEditPathArgs({
        target_file: "/y.ts",
        oldText: "a",
        newText: "b",
      }),
    ).toEqual({ path: "/y.ts", oldText: "a", newText: "b" });
  });
});
