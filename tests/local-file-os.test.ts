import { describe, expect, it } from "vitest";

import {
  buildOpenPathSpec,
  buildRevealInFolderSpec,
  toWindowsExplorerPath,
} from "@/lib/local-file-os";

describe("toWindowsExplorerPath", () => {
  it("把正斜杠换成反斜杠（避免 explorer 把 / 当 switch）", () => {
    expect(
      toWindowsExplorerPath(
        "D:/repositories/git/wukong/cp-notification/wk-doc/repo-design.md",
      ),
    ).toBe(
      "D:\\repositories\\git\\wukong\\cp-notification\\wk-doc\\repo-design.md",
    );
  });

  it("已是反斜杠则保持不变", () => {
    expect(toWindowsExplorerPath("C:\\foo\\bar.txt")).toBe("C:\\foo\\bar.txt");
  });
});

describe("buildRevealInFolderSpec", () => {
  it("macOS 用 open -R", () => {
    expect(buildRevealInFolderSpec("/tmp/a.txt", "darwin")).toEqual({
      command: "open",
      args: ["-R", "/tmp/a.txt"],
    });
  });

  it("Windows 用 explorer /select，并规范化正斜杠路径", () => {
    expect(
      buildRevealInFolderSpec("D:/repositories/git/foo/bar.txt", "win32"),
    ).toEqual({
      command: "explorer.exe",
      args: ['/select,"D:\\repositories\\git\\foo\\bar.txt"'],
      ignoreNonZeroExit: true,
    });
  });

  it("Windows 反斜杠路径同样加引号", () => {
    expect(buildRevealInFolderSpec("C:\\foo\\bar.txt", "win32")).toEqual({
      command: "explorer.exe",
      args: ['/select,"C:\\foo\\bar.txt"'],
      ignoreNonZeroExit: true,
    });
  });
});

describe("buildOpenPathSpec", () => {
  it("macOS 用 open", () => {
    expect(buildOpenPathSpec("/tmp/a.txt", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/a.txt"],
    });
  });

  it("Windows 用 cmd start，并规范化正斜杠", () => {
    expect(buildOpenPathSpec("D:/foo/bar.txt", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "D:\\foo\\bar.txt"],
    });
  });
});
