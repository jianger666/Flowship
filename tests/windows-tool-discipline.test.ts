/**
 * Windows 工具纪律：平台 / 壳条件注入
 */
import { describe, expect, it } from "vitest";

import { buildWindowsToolDisciplineDirective } from "@/lib/server/windows-tool-discipline";

describe("buildWindowsToolDisciplineDirective", () => {
  it("非 win32 返空串", () => {
    expect(buildWindowsToolDisciplineDirective("PowerShell", "darwin")).toBe("");
    expect(buildWindowsToolDisciplineDirective("Git Bash", "linux")).toBe("");
  });

  it("win32 + PowerShell：两条纪律都在、无 safe_read", () => {
    const text = buildWindowsToolDisciplineDirective("PowerShell", "win32");
    expect(text).toContain("## Windows 工具纪律");
    expect(text).toContain("最小失败纪律");
    expect(text).not.toContain("safe_read");
    expect(text).toContain("PowerShell 语法");
    expect(text).toContain("禁用 `&&`");
    expect(text).toContain("内置 `edit` / `write`");
  });

  it("win32 + Git Bash：只有最小失败纪律、无 PowerShell 条、无 safe_read", () => {
    const text = buildWindowsToolDisciplineDirective("Git Bash", "win32");
    expect(text).toContain("最小失败纪律");
    expect(text).not.toContain("safe_read");
    expect(text).not.toContain("PowerShell 语法");
    expect(text).not.toContain("禁用 `&&`");
  });
});
