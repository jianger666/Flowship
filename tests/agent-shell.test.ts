/**
 * agent-shell：从 git.exe 推导 bash.exe + 非 win32 平台 gate
 */
import { describe, expect, it } from "vitest";

import {
  __resetDetectCacheForTests,
  deriveBashFromGitExe,
  detectGitBashPath,
} from "@/lib/server/agent-shell";

describe("deriveBashFromGitExe", () => {
  it("cmd\\git.exe → 同根 bin\\bash.exe", () => {
    expect(deriveBashFromGitExe("C:\\Program Files\\Git\\cmd\\git.exe")).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
  });

  it("bin\\git.exe → 同目录 bash.exe", () => {
    expect(deriveBashFromGitExe("D:\\Tools\\Git\\bin\\git.exe")).toBe(
      "D:\\Tools\\Git\\bin\\bash.exe",
    );
  });

  it("mingw64\\bin\\git.exe → 安装根 bin\\bash.exe", () => {
    expect(
      deriveBashFromGitExe("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),
    ).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("mingw32\\bin\\git.exe 同样推导到根 bin", () => {
    expect(deriveBashFromGitExe("E:\\Git\\mingw32\\bin\\git.exe")).toBe(
      "E:\\Git\\bin\\bash.exe",
    );
  });

  it("正斜杠路径也能认", () => {
    expect(deriveBashFromGitExe("C:/Program Files/Git/cmd/git.exe")).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
  });

  it("不认识的布局 / 非 git → null", () => {
    // 直接躺在根目录、或不在 cmd/bin 下 → 无法推导
    expect(deriveBashFromGitExe("C:\\Somewhere\\git.exe")).toBeNull();
    expect(deriveBashFromGitExe("C:\\Program Files\\Git\\usr\\local\\git.exe")).toBeNull();
    expect(deriveBashFromGitExe("")).toBeNull();
    expect(deriveBashFromGitExe("C:\\foo\\bar.exe")).toBeNull();
  });
});

describe("detectGitBashPath 平台 gate", () => {
  it("非 win32 直接 null（不扫盘、不调子进程）", async () => {
    __resetDetectCacheForTests();
    if (process.platform === "win32") {
      // Windows CI 上跳过「平台 gate」断言——这里只保证非 win 行为
      return;
    }
    expect(await detectGitBashPath()).toBeNull();
  });
});
