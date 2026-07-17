/**
 * agent-shell：从 git.exe 推导 bash.exe + PATH 注入/移除幂等 + 开关同步 SHELL
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __getInjectedBinDirForTests,
  __resetDetectCacheForTests,
  __resetInjectedBinDirForTests,
  __setDetectCacheForTests,
  __setVerifyGitBashForTests,
  deriveBashFromGitExe,
  detectGitBashPath,
  injectGitBashBinToPath,
  removeInjectedGitBashBinFromPath,
  syncAgentShellEnv,
} from "@/lib/server/agent-shell";

/** 与 agent-shell 一致：PATH 段用 win32 `;`，避免 mac 上 `:` 拆坏 `C:\...` */
const WIN_PATH_DELIM = path.win32.delimiter;

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

describe("detectGitBashPath 负缓存旁路", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    __resetDetectCacheForTests();
  });

  it("未过期负缓存命中；bypassCache 强制重探（不吃 sentinel）", async () => {
    // 假装 win32，才能走到缓存逻辑（非 win 在读缓存前就 return）
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    const sentinel = "C:\\sentinel\\bash.exe";
    __setDetectCacheForTests(sentinel);

    // 普通路径吃缓存
    expect(await detectGitBashPath()).toBe(sentinel);

    // 旁路后重探：结果是真实路径或 null，但绝不能再是 sentinel（证明没吃缓存）
    const bypassed = await detectGitBashPath({ bypassCache: true });
    expect(bypassed).not.toBe(sentinel);
  });
});

describe("injectGitBashBinToPath / removeInjectedGitBashBinFromPath", () => {
  const binDir = "C:\\Program Files\\Git\\bin";
  let savedPath: string | undefined;
  let savedShell: string | undefined;

  afterEach(() => {
    // 先卸注入再还原快照，避免污染其它用例
    removeInjectedGitBashBinFromPath();
    __resetInjectedBinDirForTests();
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    if (savedShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = savedShell;
    }
  });

  const snapshotEnv = () => {
    savedPath = process.env.PATH;
    savedShell = process.env.SHELL;
  };

  it("前置注入 bin 目录（幂等、不重复加）", () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32", "C:\\Windows"].join(
      WIN_PATH_DELIM,
    );

    injectGitBashBinToPath(binDir);
    const parts = (process.env.PATH ?? "").split(WIN_PATH_DELIM);
    expect(parts[0]).toBe(binDir);
    expect(__getInjectedBinDirForTests()).toBe(binDir);

    // 再调一次：仍只有一段、标记不变
    injectGitBashBinToPath(binDir);
    const parts2 = (process.env.PATH ?? "").split(WIN_PATH_DELIM);
    expect(parts2.filter((p) => p === binDir)).toHaveLength(1);
    expect(__getInjectedBinDirForTests()).toBe(binDir);
  });

  it("用户 PATH 里本来就有同目录时不标记注入（关开关不会误删）", () => {
    snapshotEnv();
    process.env.PATH = [binDir, "C:\\Windows"].join(WIN_PATH_DELIM);

    injectGitBashBinToPath(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
    expect(process.env.PATH).toBe([binDir, "C:\\Windows"].join(WIN_PATH_DELIM));

    // 无标记 → remove noop，用户原有段保留
    removeInjectedGitBashBinFromPath();
    expect(process.env.PATH).toBe([binDir, "C:\\Windows"].join(WIN_PATH_DELIM));
  });

  it("移除只清我们注入的那段，不动其它 PATH 段", () => {
    snapshotEnv();
    const other = "C:\\Other\\Tools";
    process.env.PATH = [other, "C:\\Windows"].join(WIN_PATH_DELIM);

    injectGitBashBinToPath(binDir);
    removeInjectedGitBashBinFromPath();

    expect(__getInjectedBinDirForTests()).toBeNull();
    expect(process.env.PATH).toBe([other, "C:\\Windows"].join(WIN_PATH_DELIM));
  });
});

describe("syncAgentShellEnv 开关开/关", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const binDir = "C:\\Program Files\\Git\\bin";
  let savedPath: string | undefined;
  let savedShell: string | undefined;

  afterEach(() => {
    removeInjectedGitBashBinFromPath();
    __resetInjectedBinDirForTests();
    __setVerifyGitBashForTests(null);
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    if (savedShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = savedShell;
    }
  });

  const snapshotEnv = () => {
    savedPath = process.env.PATH;
    savedShell = process.env.SHELL;
  };

  it("开关开 → PATH 前置 bin + SHELL 指向 bash", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    __setVerifyGitBashForTests(async () => true);

    await syncAgentShellEnv(true, gitBash);

    expect(process.env.SHELL).toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)[0]).toBe(binDir);
    expect(__getInjectedBinDirForTests()).toBe(binDir);
  });

  it("开关关 → 卸掉注入的 bin 段、SHELL 不再指向 bash", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    __setVerifyGitBashForTests(async () => true);

    await syncAgentShellEnv(true, gitBash);
    expect(process.env.SHELL).toBe(gitBash);

    await syncAgentShellEnv(false, null);

    // 恢复的是模块加载时 ORIGINAL_SHELL（未必 undefined），只要不再指向我们设的 bash
    expect(process.env.SHELL).not.toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("自检失败 → 回滚 SHELL+PATH（不留半残状态）", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    __setVerifyGitBashForTests(async () => false);

    await syncAgentShellEnv(true, gitBash);

    expect(process.env.SHELL).not.toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("反复开/关幂等", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    __setVerifyGitBashForTests(async () => true);

    await syncAgentShellEnv(true, gitBash);
    await syncAgentShellEnv(true, gitBash);
    expect(
      (process.env.PATH ?? "").split(WIN_PATH_DELIM).filter((p) => p === binDir),
    ).toHaveLength(1);

    await syncAgentShellEnv(false, null);
    await syncAgentShellEnv(false, null);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
  });
});
