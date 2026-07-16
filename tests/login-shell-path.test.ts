/**
 * mac GUI 启动 PATH 补全的纯函数回归（2026-07-16 预览 `yarn: command not found` 根因修复）：
 * marker 夹取要扛 rc 杂音、合并要去重保序。
 */

import { describe, expect, it } from "vitest";

import {
  extractPathFromShellOutput,
  mergePathStrings,
} from "@/lib/server/login-shell-path";

const M = "__FE_AI_FLOW_PATH_MARKER__";

describe("extractPathFromShellOutput", () => {
  it("干净输出直接夹取", () => {
    expect(extractPathFromShellOutput(`${M}/opt/homebrew/bin:/usr/bin${M}`, M)).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  it("rc 往 stdout 打杂音时仍取最后一对 marker 之间", () => {
    const noisy = `welcome banner\nnvm loaded\n${M}/a/bin:/b/bin${M}\n`;
    expect(extractPathFromShellOutput(noisy, M)).toBe("/a/bin:/b/bin");
  });

  it("没有成对 marker / 内容为空 → null", () => {
    expect(extractPathFromShellOutput("no marker at all", M)).toBeNull();
    expect(extractPathFromShellOutput(`${M}${M}`, M)).toBeNull();
    expect(extractPathFromShellOutput(`${M}   ${M}`, M)).toBeNull();
  });
});

describe("mergePathStrings", () => {
  it("登录 shell 的在前、当前的追加、重复去掉", () => {
    expect(
      mergePathStrings("/opt/homebrew/bin:/usr/bin:/bin", "/usr/bin:/bin:/x/tools/bin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin:/x/tools/bin");
  });

  it("空段丢弃", () => {
    expect(mergePathStrings("/a::/b", ":/c:")).toBe("/a:/b:/c");
  });
});
