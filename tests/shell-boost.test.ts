/**
 * shell-boost 纯逻辑：守卫探测 / 顶插文本 / 目标清单（不碰真实 fs）
 */
import { describe, expect, it } from "vitest";

import {
  SHELL_BOOST_MARKER,
  buildShellBoostBlock,
  formatBackupDate,
  hasShellBoost,
  injectShellBoostContent,
  listShellBoostTargets,
} from "@/lib/server/shell-boost";

describe("hasShellBoost / injectShellBoostContent", () => {
  it("空内容 / 普通 rc → 未含守卫", () => {
    expect(hasShellBoost("")).toBe(false);
    expect(hasShellBoost("export PATH=/usr/local/bin:$PATH\n")).toBe(false);
  });

  it("含 COMPOSER_NO_INTERACTION → 已含守卫", () => {
    expect(hasShellBoost(buildShellBoostBlock())).toBe(true);
    expect(
      hasShellBoost('[[ "$COMPOSER_NO_INTERACTION" == "1" ]] && return\n'),
    ).toBe(true);
  });

  it("顶插：守卫块在最前，且幂等", () => {
    const original = "# my rc\nexport FOO=1\n";
    const once = injectShellBoostContent(original);
    expect(once.startsWith(buildShellBoostBlock())).toBe(true);
    expect(once).toContain(SHELL_BOOST_MARKER);
    expect(once.endsWith(original)).toBe(true);
    // 再注入一次内容不变
    expect(injectShellBoostContent(once)).toBe(once);
  });
});

describe("listShellBoostTargets", () => {
  it("darwin/linux 列 .zshrc + .bashrc；win32 只列 .bashrc", () => {
    const home = "/Users/demo";
    expect(listShellBoostTargets("darwin", home).map((t) => t.path)).toEqual([
      "~/.zshrc",
      "~/.bashrc",
    ]);
    expect(listShellBoostTargets("linux", home).map((t) => t.path)).toEqual([
      "~/.zshrc",
      "~/.bashrc",
    ]);
    expect(listShellBoostTargets("win32", "C:\\Users\\demo").map((t) => t.path)).toEqual([
      "~/.bashrc",
    ]);
  });
});

describe("formatBackupDate", () => {
  it("格式化为 YYYYMMDD（用本地 Date 构造，避免 UTC 串跨日）", () => {
    // month 0-indexed：6 = July
    expect(formatBackupDate(new Date(2026, 6, 15))).toBe("20260715");
  });
});
