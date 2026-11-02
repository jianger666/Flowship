/**
 * R8-4（P2）：Windows 优雅退出路径上的「连进程树强杀」——server 在退出清理**同步做完之后**对自己 `taskkill /PID <自己> /T /F`。
 * **整条链路未在 Windows 实机验证**：所有 Windows 行为都靠传入 platform / 假 exec 驱动，**绝不真调 taskkill**
 * （默认实现在测试环境里还会自己拒绝执行，见第三组用例）。
 *
 * 钉死的语义：
 * - killOwnProcessTreeSync：只在 win32、pid 合法时发 `taskkill /PID <pid> /T /F`（windowsHide + 超时 + 不继承 stdio）；
 *   非 win32 / 非法 pid 什么都不发；taskkill 抛错（超时 / 起不来）被吞掉、返回 "failed"、不抛。
 * - runExitSequence：**先清理（等它完成）→ 再自杀整树 → 最后 exit**；killTreeOnWin=false（SIGTERM / SIGINT / 终端 Ctrl+C）绝不自杀；
 *   自杀抛错也照样 exit；退出码 SIGINT=130 / 其它=0。
 * - 接线（源码契约）：只有「壳设了 FLOWSHIP_EXIT_ON_STDIN_EOF 的 stdin-EOF 分支」传 killTreeOnWin=true，信号分支不传。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: childProcessMock.execFileSync, default: { ...actual, execFileSync: childProcessMock.execFileSync } };
});

import { runExitSequence } from "@/lib/server/feishu-bridge/inbound";
import { WIN_SELF_TREEKILL_TIMEOUT_MS, killOwnProcessTreeSync } from "@/lib/server/win-self-tree-kill";

const ARGS = ["/PID", "4242", "/T", "/F"];
const OPTS = { windowsHide: true, timeout: WIN_SELF_TREEKILL_TIMEOUT_MS, stdio: "ignore" };

afterEach(() => {
  childProcessMock.execFileSync.mockReset();
  vi.unstubAllEnvs();
});

describe("killOwnProcessTreeSync（注入 exec，不碰真 taskkill）", () => {
  it("win32：对自己发 `taskkill /PID <pid> /T /F`（windowsHide + 同步超时 + stdio ignore），返回 attempted", () => {
    const exec = vi.fn();
    expect(killOwnProcessTreeSync({ platform: "win32", pid: 4242, execFileSync: exec })).toBe("attempted");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("taskkill", ARGS, OPTS);
  });

  it("win32 不带 pid 注入：默认取 process.pid", () => {
    const exec = vi.fn();
    killOwnProcessTreeSync({ platform: "win32", execFileSync: exec });
    expect(exec.mock.calls[0]![1]).toEqual(["/PID", String(process.pid), "/T", "/F"]);
  });

  it("非 win32（darwin / linux / freebsd）：什么都不发，返回 skipped", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      const exec = vi.fn();
      expect(killOwnProcessTreeSync({ platform, pid: 4242, execFileSync: exec }), platform).toBe("skipped");
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it("pid 非法（0 / 4 / 负数 / NaN / 小数）：绝不对 System / Idle 之类发 /T /F", () => {
    for (const pid of [0, 1, 4, -5, Number.NaN, 12.5]) {
      const exec = vi.fn();
      expect(killOwnProcessTreeSync({ platform: "win32", pid, execFileSync: exec }), String(pid)).toBe("skipped");
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it("taskkill 抛错（超时 / ENOENT / 无权限）：吞掉、返回 failed、不抛——调用方随后照常 exit", () => {
    const exec = vi.fn(() => {
      throw new Error("spawnSync taskkill ETIMEDOUT");
    });
    expect(() => killOwnProcessTreeSync({ platform: "win32", pid: 4242, execFileSync: exec })).not.toThrow();
    expect(killOwnProcessTreeSync({ platform: "win32", pid: 4242, execFileSync: exec })).toBe("failed");
  });

  it("超时常量：2s（退出清理上限 1.5s + 它 < 壳侧优雅预算 4s 的账见 tests/electron-win-graceful-stop.test.ts）", () => {
    expect(WIN_SELF_TREEKILL_TIMEOUT_MS).toBe(2000);
  });
});

describe("默认 exec 的测试环境保护（即便 platform 被伪造成 win32 且忘了注入，也绝不真调）", () => {
  it("VITEST 环境下不注入 exec：不调 node:child_process 的 execFileSync，返回 skipped", () => {
    expect(process.env.VITEST).toBeDefined(); // 确认确实在 vitest 里跑
    expect(killOwnProcessTreeSync({ platform: "win32", pid: 4242 })).toBe("skipped");
    expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
  });

  it("非测试环境（摘掉 VITEST / NODE_ENV=production）下缺省实现才走 node:child_process 的 execFileSync（这里被替身接住，仍不真调）", () => {
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(killOwnProcessTreeSync({ platform: "win32", pid: 4242 })).toBe("attempted");
      expect(childProcessMock.execFileSync).toHaveBeenCalledWith("taskkill", ARGS, OPTS);
    } finally {
      process.env.VITEST = savedVitest;
    }
  });
});

describe("runExitSequence：先清理、再自杀整树、最后 exit（顺序钉死）", () => {
  const makeDeps = (opts: { killTreeThrows?: boolean; cleanupMs?: number } = {}) => {
    const events: string[] = [];
    const deps = {
      cleanup: vi.fn(async () => {
        events.push("cleanup:start");
        // 清理是异步的、要等一会儿：自杀必须等它**真的完成**，不能只是「调用了」
        await new Promise((r) => setTimeout(r, opts.cleanupMs ?? 25));
        events.push("cleanup:end");
      }),
      killTree: vi.fn(() => {
        events.push("killTree");
        if (opts.killTreeThrows) throw new Error("taskkill boom");
      }),
      exit: vi.fn((code: number) => {
        events.push(`exit:${code}`);
      }),
    };
    return { deps, events };
  };

  it("stdin-EOF 分支（killTreeOnWin=true）：cleanup 完成 → killTree → exit(0)，三步严格按序", async () => {
    const { deps, events } = makeDeps();
    await runExitSequence("SIGTERM", true, deps);
    expect(events).toEqual(["cleanup:start", "cleanup:end", "killTree", "exit:0"]);
  });

  it("信号分支（killTreeOnWin=false：SIGTERM / SIGINT / 终端 Ctrl+C）：绝不自杀；SIGINT 退出码 130、SIGTERM 退出码 0", async () => {
    const a = makeDeps();
    await runExitSequence("SIGTERM", false, a.deps);
    expect(a.events).toEqual(["cleanup:start", "cleanup:end", "exit:0"]);
    expect(a.deps.killTree).not.toHaveBeenCalled();

    const b = makeDeps();
    await runExitSequence("SIGINT", false, b.deps);
    expect(b.events).toEqual(["cleanup:start", "cleanup:end", "exit:130"]);
    expect(b.deps.killTree).not.toHaveBeenCalled();
  });

  it("killTree 抛错：照样 exit（最坏退回「只有 server 自己退出」）", async () => {
    const { deps, events } = makeDeps({ killTreeThrows: true });
    await runExitSequence("SIGTERM", true, deps);
    expect(events).toEqual(["cleanup:start", "cleanup:end", "killTree", "exit:0"]);
  });

  it("清理本身耗时再长，也不会被 killTree 截断：killTree 在 cleanup 的 Promise 落定之前一次都不会被调用", async () => {
    const { deps, events } = makeDeps({ cleanupMs: 120 });
    const p = runExitSequence("SIGTERM", true, deps);
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toEqual(["cleanup:start"]); // 清理还在跑：没杀、没退
    expect(deps.killTree).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    await p;
    expect(events).toEqual(["cleanup:start", "cleanup:end", "killTree", "exit:0"]);
  });
});

describe("接线契约（源码）：只有 stdin-EOF 分支传 killTreeOnWin=true", () => {
  const src = readFileSync(path.join(__dirname, "../src/lib/server/feishu-bridge/inbound.ts"), "utf8");
  const start = src.indexOf("const ensureExitHook = (): void => {");
  const body = src.slice(start, src.indexOf("\n};\n", start));

  it("SIGTERM / SIGINT 的监听不传第二个参数（不自杀）", () => {
    expect(body).toContain('process.once("SIGTERM", () => onSignal("SIGTERM"));');
    expect(body).toContain('process.once("SIGINT", () => onSignal("SIGINT"));');
  });

  it("stdin-EOF 的监听在 `FLOWSHIP_EXIT_ON_STDIN_EOF === \"1\"` 的分支里、且传 true；读到就摘掉环境变量", () => {
    const m = /if \(process\.env\[STDIN_EOF_EXIT_ENV\] === "1"\) \{([\s\S]*?)\n  \}/.exec(body);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("delete process.env[STDIN_EOF_EXIT_ENV];");
    expect(m![1]).toContain('watchStdinEofExit(process.stdin, () => onSignal("SIGTERM", true));');
    // 别处不得出现 onSignal(..., true)
    expect(body.match(/onSignal\("[A-Z]+", true\)/g)).toHaveLength(1);
  });

  it("onSignal 只经 runExitSequence 退出（清理 → 自杀 → exit 的顺序不在闭包里重写）", () => {
    expect(body).toContain("void runExitSequence(signal, killTreeOnWin);");
    expect(body).not.toContain("killOwnProcessTreeSync(");
    expect(body).not.toContain("process.exit(");
  });

  it("runExitSequence 里 await 清理在前、killTree 在后、exit 在最后；killTree 只在 killTreeOnWin 为真时调", () => {
    const s = src.indexOf("export const runExitSequence = async (");
    const seq = src.slice(s, src.indexOf("\n};\n", s));
    const iClean = seq.indexOf("await (deps.cleanup ?? runExitCleanup)();");
    const iKill = seq.indexOf("(deps.killTree ?? killOwnProcessTreeSync)();");
    const iExit = seq.indexOf("(deps.exit ??");
    expect(iClean).toBeGreaterThan(0);
    expect(iKill).toBeGreaterThan(iClean);
    expect(iExit).toBeGreaterThan(iKill);
    expect(seq).toMatch(/if \(killTreeOnWin\) \{\s*try \{/);
  });

  it("win-self-tree-kill.ts：只在 win32、默认实现在测试环境拒绝执行", () => {
    const k = readFileSync(path.join(__dirname, "../src/lib/server/win-self-tree-kill.ts"), "utf8");
    expect(k).toContain('if (platform !== "win32") return "skipped";');
    expect(k).toContain("isTestEnv() ? null : execFileSync");
  });
});
