/**
 * agent-shell：从 git.exe 推导 bash.exe + PATH 注入/移除幂等 + 开关同步 SHELL
 *
 * 同步语义（v1.1.19 复审）：全部异步预检在改环境之前 → 通过后同步一次性提交。
 * 跨 bundle：ORIGINAL_SHELL / injectedBinDir / applyChain 挂同一 globalThis。
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __AGENT_SHELL_STATE_KEY_FOR_TESTS,
  __getInjectedBinDirForTests,
  __resetAgentShellGlobalStateForTests,
  __resetApplyChainForTests,
  __resetDetectCacheForTests,
  __resetInjectedBinDirForTests,
  __setApplyWorkForTests,
  __setDetectCacheForTests,
  __setVerifyGitBashForTests,
  __setWhereBashForTests,
  applyAgentShellPreference,
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
    __resetAgentShellGlobalStateForTests();
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

  it("首段已是目标 bin 时 noop、不标记注入（关开关不会误删）", () => {
    snapshotEnv();
    process.env.PATH = [binDir, "C:\\Windows"].join(WIN_PATH_DELIM);

    injectGitBashBinToPath(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
    expect(process.env.PATH).toBe([binDir, "C:\\Windows"].join(WIN_PATH_DELIM));

    // 无标记 → remove noop，用户原有段保留
    removeInjectedGitBashBinFromPath();
    expect(process.env.PATH).toBe([binDir, "C:\\Windows"].join(WIN_PATH_DELIM));
  });

  it("首段大小写/尾斜杠变体也判定为已在首位 → noop", () => {
    // 复审 P2：c:\program files\git\bin\ == C:\Program Files\Git\bin
    snapshotEnv();
    const variant = "c:\\program files\\git\\bin\\";
    process.env.PATH = [variant, "C:\\Windows"].join(WIN_PATH_DELIM);

    injectGitBashBinToPath(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
    expect(process.env.PATH).toBe([variant, "C:\\Windows"].join(WIN_PATH_DELIM));
  });

  it("目标在 PATH 后部 → 首位再插一段，关闭只删新增段、用户原有段保留", () => {
    // 复审 P2：System32;Git\\bin → 开启后 Git\\bin;System32;Git\\bin
    snapshotEnv();
    const system32 = "C:\\Windows\\System32";
    const original = [system32, binDir].join(WIN_PATH_DELIM);
    process.env.PATH = original;

    injectGitBashBinToPath(binDir);
    const parts = (process.env.PATH ?? "").split(WIN_PATH_DELIM);
    expect(parts[0]).toBe(binDir);
    expect(parts[1]).toBe(system32);
    expect(parts[2]).toBe(binDir);
    expect(parts.filter((p) => p === binDir)).toHaveLength(2);
    expect(__getInjectedBinDirForTests()).toBe(binDir);

    removeInjectedGitBashBinFromPath();
    // 只删首位新增段，恢复为用户原顺序（含后部 Git bin）
    expect(process.env.PATH).toBe(original);
    expect(__getInjectedBinDirForTests()).toBeNull();
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
    __resetAgentShellGlobalStateForTests();
    __setVerifyGitBashForTests(null);
    __setWhereBashForTests(null);
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

  /** 成功路径：绝对路径自检 + where 链都过（mac 无 where，必须 mock） */
  const mockSuccessChecks = () => {
    __setVerifyGitBashForTests(async () => true);
    // 钩子签名带候选 PATH；成功路径可忽略该参数
    __setWhereBashForTests(async () => gitBash);
  };

  it("开关开 → PATH 前置 bin + SHELL 指向 bash", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    mockSuccessChecks();

    await syncAgentShellEnv(true, gitBash);

    expect(process.env.SHELL).toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)[0]).toBe(binDir);
    expect(__getInjectedBinDirForTests()).toBe(binDir);
  });

  it("开关关 → 卸掉注入的 bin 段、SHELL 不再指向 bash", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    mockSuccessChecks();

    await syncAgentShellEnv(true, gitBash);
    expect(process.env.SHELL).toBe(gitBash);

    await syncAgentShellEnv(false, null);

    // 恢复的是首次 sync 捕获的 ORIGINAL_SHELL（本用例启动时 delete 了 → undefined）
    expect(process.env.SHELL).toBeUndefined();
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("自检失败 → PATH/SHELL 从未被改过（先验后注，非改了再滚）", async () => {
    snapshotEnv();
    const originalPath = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    process.env.PATH = originalPath;
    delete process.env.SHELL;

    let pathSeenDuringVerify: string | undefined;
    let shellSeenDuringVerify: string | undefined;
    __setVerifyGitBashForTests(async () => {
      pathSeenDuringVerify = process.env.PATH;
      shellSeenDuringVerify = process.env.SHELL;
      return false;
    });
    // where 不应被调用；即便调了也不该注入
    __setWhereBashForTests(async () => {
      throw new Error("where 不应在自检失败后执行");
    });

    await syncAgentShellEnv(true, gitBash);

    // 自检回调执行时环境尚未动
    expect(pathSeenDuringVerify).toBe(originalPath);
    expect(shellSeenDuringVerify).toBeUndefined();
    // 结束后也不含注入
    expect(process.env.SHELL).not.toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("自检失败且已有旧注入 → 清残留（恢复分支）", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    mockSuccessChecks();

    await syncAgentShellEnv(true, gitBash);
    expect(__getInjectedBinDirForTests()).toBe(binDir);

    // 再次开启但绝对路径自检失败 → 应卸掉上次残留
    __setVerifyGitBashForTests(async () => false);
    await syncAgentShellEnv(true, gitBash);

    expect(process.env.SHELL).not.toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("where 链校验失败（首个命中非 Git Bash）→ PATH/SHELL 全程未被本次改过", async () => {
    // 复审 P1-2：预检失败零改动——不是改了又滚回
    snapshotEnv();
    const originalPath = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    process.env.PATH = originalPath;
    delete process.env.SHELL;
    __setVerifyGitBashForTests(async () => true);

    let pathSeenDuringWhere: string | undefined;
    let shellSeenDuringWhere: string | undefined;
    let candidatePathSeen: string | undefined;
    // 模拟 WSL bash 排在前面——SDK 同款 /git.*bash/i 不匹配
    __setWhereBashForTests(async (candidatePath) => {
      candidatePathSeen = candidatePath;
      pathSeenDuringWhere = process.env.PATH;
      shellSeenDuringWhere = process.env.SHELL;
      return "C:\\Windows\\System32\\bash.exe";
    });

    await syncAgentShellEnv(true, gitBash);

    // where 回调执行时 process.env 尚未动（候选 PATH 只作参数）
    expect(pathSeenDuringWhere).toBe(originalPath);
    expect(shellSeenDuringWhere).toBeUndefined();
    // 候选 PATH 应已前置 binDir（供 where 在隔离 env 里查）
    expect(candidatePathSeen?.split(WIN_PATH_DELIM)[0]).toBe(binDir);
    // 结束后也不含注入
    expect(process.env.SHELL).toBeUndefined();
    expect(process.env.PATH).toBe(originalPath);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("where 命令失败/空输出 → 全程零改动（非改了再滚）", async () => {
    snapshotEnv();
    const originalPath = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    process.env.PATH = originalPath;
    delete process.env.SHELL;
    __setVerifyGitBashForTests(async () => true);

    let pathSeenDuringWhere: string | undefined;
    __setWhereBashForTests(async () => {
      pathSeenDuringWhere = process.env.PATH;
      return null;
    });

    await syncAgentShellEnv(true, gitBash);

    expect(pathSeenDuringWhere).toBe(originalPath);
    expect(process.env.SHELL).toBeUndefined();
    expect(process.env.PATH).toBe(originalPath);
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("换 Git 安装路径：验证通过后先卸旧再注新", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    mockSuccessChecks();

    await syncAgentShellEnv(true, gitBash);
    expect(__getInjectedBinDirForTests()).toBe(binDir);

    const otherBash = "D:\\Tools\\Git\\bin\\bash.exe";
    const otherBin = "D:\\Tools\\Git\\bin";
    __setVerifyGitBashForTests(async () => true);
    __setWhereBashForTests(async () => otherBash);

    await syncAgentShellEnv(true, otherBash);

    const parts = (process.env.PATH ?? "").split(WIN_PATH_DELIM);
    expect(parts).not.toContain(binDir);
    expect(parts[0]).toBe(otherBin);
    expect(process.env.SHELL).toBe(otherBash);
    expect(__getInjectedBinDirForTests()).toBe(otherBin);
  });

  it("反复开/关幂等", async () => {
    snapshotEnv();
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;
    mockSuccessChecks();

    await syncAgentShellEnv(true, gitBash);
    await syncAgentShellEnv(true, gitBash);
    expect(
      (process.env.PATH ?? "").split(WIN_PATH_DELIM).filter((p) => p === binDir),
    ).toHaveLength(1);

    await syncAgentShellEnv(false, null);
    await syncAgentShellEnv(false, null);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
  });

  it("System32;Git\\bin 开启后目标前置、关闭恢复原顺序（含用户后部 Git bin）", async () => {
    // 复审 P2：后部已有同目录时仍前置；关开关只卸新增段
    snapshotEnv();
    const system32 = "C:\\Windows\\System32";
    const original = [system32, binDir].join(WIN_PATH_DELIM);
    process.env.PATH = original;
    delete process.env.SHELL;
    mockSuccessChecks();

    await syncAgentShellEnv(true, gitBash);

    const partsOn = (process.env.PATH ?? "").split(WIN_PATH_DELIM);
    expect(partsOn[0]).toBe(binDir);
    expect(partsOn[1]).toBe(system32);
    expect(partsOn[2]).toBe(binDir);
    expect(process.env.SHELL).toBe(gitBash);
    expect(__getInjectedBinDirForTests()).toBe(binDir);

    await syncAgentShellEnv(false, null);

    expect(process.env.PATH).toBe(original);
    expect(process.env.SHELL).toBeUndefined();
    expect(__getInjectedBinDirForTests()).toBeNull();
  });

  it("PATH 前部已有另一套 Git Bash → 仍前置目标段，where 首命中与 SHELL 一致", async () => {
    // 复审 P2：首段不是目标 → 再插；SDK where 第一命中变成目标版本
    snapshotEnv();
    const otherBin = "D:\\OtherGit\\bin";
    process.env.PATH = [otherBin, "C:\\Windows"].join(WIN_PATH_DELIM);
    delete process.env.SHELL;

    __setVerifyGitBashForTests(async () => true);
    let candidatePathSeen: string | undefined;
    __setWhereBashForTests(async (candidatePath) => {
      candidatePathSeen = candidatePath;
      // 模拟 where 在候选 PATH 上取首命中——前置后应是目标 bash
      const firstDir = candidatePath.split(WIN_PATH_DELIM)[0]!;
      return `${firstDir}\\bash.exe`;
    });

    await syncAgentShellEnv(true, gitBash);

    const parts = (process.env.PATH ?? "").split(WIN_PATH_DELIM);
    expect(parts[0]).toBe(binDir);
    expect(parts).toContain(otherBin); // 用户原有另一套仍在后部
    expect(process.env.SHELL).toBe(gitBash);
    // where 看的候选 PATH 首段已是目标（后部 OtherGit 仍在，但不影响首命中）
    expect(candidatePathSeen?.split(WIN_PATH_DELIM)[0]).toBe(binDir);
  });
});

describe("applyAgentShellPreference 串行化", () => {
  afterEach(() => {
    __setApplyWorkForTests(null);
    __resetApplyChainForTests();
    __resetAgentShellGlobalStateForTests();
  });

  it("并发两次 apply 不交错（延迟 mock 验证串行）", async () => {
    const order: string[] = [];
    let call = 0;
    __setApplyWorkForTests(async () => {
      const id = ++call;
      order.push(`start-${id}`);
      // 故意拖延，若并发会交错成 start-1,start-2,end-1,end-2
      await new Promise((r) => setTimeout(r, 40));
      order.push(`end-${id}`);
    });

    const p1 = applyAgentShellPreference();
    const p2 = applyAgentShellPreference();
    await Promise.all([p1, p2]);

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("前一次失败不阻断下一次", async () => {
    let call = 0;
    const outcomes: string[] = [];
    __setApplyWorkForTests(async () => {
      call += 1;
      if (call === 1) {
        outcomes.push("fail");
        throw new Error("boom");
      }
      outcomes.push("ok");
    });

    await expect(applyAgentShellPreference()).rejects.toThrow("boom");
    await expect(applyAgentShellPreference()).resolves.toBeUndefined();
    expect(outcomes).toEqual(["fail", "ok"]);
  });
});

/**
 * 复审 P1-1 回归：production build 里 instrumentation / settings 各有一份模块实例。
 * 用 vi.resetModules() + 两次动态 import 模拟——它们共享 globalThis，但各自有
 * module-local 变量。修复前：实例 B 把已注入的 Git Bash 当 ORIGINAL_SHELL、
 * injectedBinDir=null → 关开关完全不生效。修复后：共享状态让 B 能正确恢复。
 */
describe("跨 bundle 双模块实例共享状态", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const binDir = "C:\\Program Files\\Git\\bin";
  let savedPath: string | undefined;
  let savedShell: string | undefined;
  /** 本用例开始前的 SHELL——模拟「进程启动值」 */
  let bootShell: string | undefined;

  afterEach(() => {
    // 清 globalThis 状态 key + 还原 process.env（防止污染后续用例）
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[__AGENT_SHELL_STATE_KEY_FOR_TESTS];
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
    // resetModules 可能弄脏模块缓存，恢复静态 import 的钩子侧效果靠清 globalThis 即可
    vi.resetModules();
  });

  it("实例 A 注入后，实例 B 关闭 → SHELL 恢复进程启动值、PATH 注入段被移除", async () => {
    savedPath = process.env.PATH;
    savedShell = process.env.SHELL;

    // 固定「进程启动」环境：有明确 SHELL，PATH 不含 Git bin
    bootShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    process.env.SHELL = bootShell;
    process.env.PATH = ["C:\\Windows\\System32"].join(WIN_PATH_DELIM);

    // 确保干净共享态（模拟进程刚启动）
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[__AGENT_SHELL_STATE_KEY_FOR_TESTS];

    // —— 实例 A（模拟 instrumentation chunk）——
    const modA = await import("@/lib/server/agent-shell");
    modA.__setVerifyGitBashForTests(async () => true);
    modA.__setWhereBashForTests(async () => gitBash);
    await modA.syncAgentShellEnv(true, gitBash);

    expect(process.env.SHELL).toBe(gitBash);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)[0]).toBe(binDir);
    expect(modA.__getInjectedBinDirForTests()).toBe(binDir);

    // —— 实例 B（模拟 settings route 稍后加载的另一份模块）——
    // resetModules 清掉 module-local；globalThis 状态保留
    vi.resetModules();
    const modB = await import("@/lib/server/agent-shell");

    // 修复前 bug：B 的 ORIGINAL_SHELL 会在首次 sync 时把当前 Git Bash 当原始值，
    // injectedBinDir 仍 null → 关开关「恢复」成 Git Bash、PATH 清理 noop。
    // 修复后：B 读共享态，正确恢复到 bootShell。
    await modB.syncAgentShellEnv(false, null);

    expect(process.env.SHELL).toBe(bootShell);
    expect((process.env.PATH ?? "").split(WIN_PATH_DELIM)).not.toContain(binDir);
    expect(modB.__getInjectedBinDirForTests()).toBeNull();
  });
});
