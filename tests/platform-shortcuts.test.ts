/**
 * 平台快捷键展示文案单测
 */
import { describe, expect, it } from "vitest";

import {
  getModFShortcutLabel,
  getSearchThisPaneLabel,
  isMacPlatform,
  normalizeShellPlatform,
} from "@/lib/platform-shortcuts";

describe("normalizeShellPlatform", () => {
  it("识别 darwin / win32 / linux", () => {
    expect(normalizeShellPlatform("darwin")).toBe("darwin");
    expect(normalizeShellPlatform("win32")).toBe("win32");
    expect(normalizeShellPlatform("linux")).toBe("linux");
  });

  it("未知平台归空串", () => {
    expect(normalizeShellPlatform("freebsd")).toBe("");
    expect(normalizeShellPlatform(undefined)).toBe("");
  });
});

describe("搜索此栏文案", () => {
  it("macOS 用 ⌘F", () => {
    expect(isMacPlatform("darwin")).toBe(true);
    expect(getModFShortcutLabel("darwin")).toBe("⌘F");
    expect(getSearchThisPaneLabel("darwin")).toBe("搜索此栏（⌘F）");
  });

  it("Windows / Linux 用 Ctrl+F", () => {
    expect(getModFShortcutLabel("win32")).toBe("Ctrl+F");
    expect(getModFShortcutLabel("linux")).toBe("Ctrl+F");
    expect(getSearchThisPaneLabel("win32")).toBe("搜索此栏（Ctrl+F）");
    expect(getSearchThisPaneLabel("linux")).toBe("搜索此栏（Ctrl+F）");
  });
});
