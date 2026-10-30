/**
 * 飞书 / meegle 登录子进程的总时限与取消（R14 B6-6 · Q6-01）。
 *
 * 改前：`startLogin` 起的子进程只有 exit / error 两个事件会把 `running` 复位——用户关了授权页、
 * CLI 卡在等回调时 `running` 永远为 true：设置页按钮永远转圈、再点登录恒 409、卸载也不拦「登录中」。
 *
 * 真行为测试：真 `startLogin` / `cancelLogin` / `uninstallFeishuTools`，只把 `spawn`（可控的假子进程，
 * 能配置「收到哪个信号才退出」）、`execFile`（meegle 的 config set）、meegle 队列换成假的；
 * 时间用假时钟（只假 setTimeout / clearTimeout），所以「10 分钟超时」「3 秒后补 SIGKILL」都是瞬间跑完。
 *
 * ⚠ 必须隔离 HOME：hermetic-env 只隔离数据目录、不隔离 HOME，而 `uninstallFeishuTools` 会
 * `rm -rf ~/.lark-cli ~/.meegle`——这里把 `os.homedir()` 指到临时目录，并在隔离失败时直接中止。
 */
import fs from "node:fs";
import type { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  /** 收到过的信号（按顺序） */
  signals: string[];
  /** 每次收到信号时先回调（用来在「被杀的那一刻」观察外部状态） */
  onKill?: (sig: string) => void;
  unref: () => void;
  kill: (sig?: string) => boolean;
};

const h = vi.hoisted(() => ({
  spawned: [] as { command: string; args: string[]; child: FakeChild }[],
  /** 收到这个信号时假子进程「真的退出」（exit(null)）；默认 SIGTERM 就退，可改成只认 SIGKILL / 谁都不认 */
  dieOn: ((sig: string) => sig === "SIGTERM") as (sig: string) => boolean,
  /** 非 null 时 meegle 队列卡在这里，用来制造「config set 排队中、还没有子进程」的窗口 */
  meegleGate: null as Promise<void> | null,
  /** true 时假 execFile 一律失败（meegle 的 config set / config init 都会失败） */
  execFail: false as boolean,
  /** 只让前 N 次假 execFile 失败（之后成功）：造「第一次 config set 失败、config init + 第二次 config set 成功」 */
  execFailFirst: 0 as number,
  /** 假 execFile 收到的 argv（不含可执行文件本身），按调用顺序 */
  execCalls: [] as string[][],
  /** 每次假 execFile 被调用时回调（参数是第几次调用，从 1 起）：用来在「第一次失败之后、重试入队之前」换一个新的队列卡点 */
  onExec: null as null | ((n: number) => void),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[]) => {
      const child = Object.assign(new Emitter(), {
        stdout: new Emitter(),
        stderr: new Emitter(),
        signals: [] as string[],
        onKill: undefined as undefined | ((sig: string) => void),
        unref: () => {},
        kill: (sig: string = "SIGTERM") => {
          child.signals.push(sig);
          child.onKill?.(sig);
          // 真实进程收到信号后是异步退出的
          if (h.dieOn(sig)) queueMicrotask(() => child.emit("exit", null, sig));
          return true;
        },
      }) as FakeChild;
      h.spawned.push({ command, args: [...args], child });
      return child;
    }),
    // meegle 的 `config set host` 走 promisify(execFile)：假的立即成功
    execFile: vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: Error | null,
        out?: { stdout: string; stderr: string },
      ) => void;
      const n = h.execCalls.push(Array.isArray(args[1]) ? (args[1] as string[]).slice() : []);
      h.onExec?.(n);
      if (h.execFail || h.execFailFirst > 0) {
        h.execFailFirst = Math.max(0, h.execFailFirst - 1);
        cb(new Error("config set 失败（假）"));
      } else cb(null, { stdout: "", stderr: "" });
      return {};
    }),
  };
});

vi.mock("@/lib/server/meegle-queue", () => ({
  enqueueMeegle: async <T>(run: () => Promise<T>): Promise<T> => {
    if (h.meegleGate) await h.meegleGate;
    return run();
  },
}));

import {
  LOGIN_FORCE_SETTLE_MS,
  LOGIN_KILL_GRACE_MS,
  LOGIN_TIMEOUT_MS,
  cancelAllLogins,
  cancelLogin,
  getInstallState,
  getLoginState,
  getToolsBinDir,
  startLogin,
  uninstallFeishuTools,
} from "@/lib/server/feishu-cli";

const G = globalThis as unknown as {
  __feishuCliLogins?: Map<string, unknown>;
  __feishuCliLoginChildren?: Map<string, unknown>;
  __feishuCliInstall?: unknown;
};

const AUTH_URL = "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-1234";

/** meegle 登录前的两条短命 CLI 调用（假 execFile 记下的 argv；host 取默认值） */
const MEEGLE_SET_HOST = ["config", "set", "host", "project.feishu.cn"];
const MEEGLE_INIT = ["config", "init"];

/** 登录进程本身的 spawn（排除自动开浏览器的 opener：open / xdg-open / rundll32.exe） */
const loginSpawns = () =>
  h.spawned.filter((s) => /[\\/](lark-cli|meegle)(\.exe)?$/.test(s.command));
const lastLogin = (): FakeChild => {
  const all = loginSpawns();
  return all[all.length - 1]!.child;
};
/** 让已排队的微任务跑完（假时钟下 `await` 不会自己推进定时器，但微任务照常） */
const settle = () => vi.advanceTimersByTimeAsync(0);

let tmpHome = "";
let homedirSpy: { mockRestore: () => void };
let warnSpy: MockInstance<typeof console.warn>;
const warned = () => warnSpy.mock.calls.flat().join("\n");

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-login-home-"));
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  // 防呆：隔离没生效就别往下跑（卸载用例会 rm ~/.lark-cli / ~/.meegle）
  if (os.homedir() !== tmpHome) {
    throw new Error("os.homedir 隔离失败，中止以免删到真实 HOME");
  }
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  h.spawned.length = 0;
  h.dieOn = (sig) => sig === "SIGTERM";
  h.meegleGate = null;
  h.execFail = false;
  h.execFailFirst = 0;
  h.execCalls.length = 0;
  h.onExec = null;
  // 登录 / 安装状态都是 globalThis 上的单例：上一用例的 running=true 会让下一用例直接被拒
  G.__feishuCliLogins = new Map();
  G.__feishuCliLoginChildren = new Map();
  G.__feishuCliInstall = undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  warnSpy.mockRestore();
  homedirSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("登录总时限：超时自动终止，不再永远转圈", () => {
  it("常量：总时限 10 分钟；SIGTERM 后 3 秒补 SIGKILL；再 2 秒放弃等待", () => {
    expect(LOGIN_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(LOGIN_KILL_GRACE_MS).toBe(3000);
    expect(LOGIN_FORCE_SETTLE_MS).toBe(2000);
  });

  it("没到点不动；到点发 SIGTERM；进程退出后 running 复位、文案是「登录超时」而不是 code=null", async () => {
    expect((await startLogin("lark-cli")).ok).toBe(true);
    const child = lastLogin();

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS - 1);
    expect(child.signals).toEqual([]);
    expect(getLoginState("lark-cli")?.running).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    await settle();

    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.timedOut).toBe(true);
    expect(st.error).toBe("登录超时（10 分钟内未完成授权），已取消，可重新发起");
    expect(st.error).not.toContain("code=");
    expect(warned()).toContain("登录超过 10 分钟未完成、终止子进程"); // 到点留一条日志，排查「为什么被杀」用
  });

  it("超时后可以重新发起登录（改前 running 永真、重试恒 409「已在进行中」）", async () => {
    await startLogin("lark-cli");
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    await settle();
    expect(getLoginState("lark-cli")?.running).toBe(false);

    const again = await startLogin("lark-cli");
    expect(again.ok).toBe(true);
    expect(loginSpawns()).toHaveLength(2);
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(true);
    expect(st.timedOut).toBeUndefined();
    expect(st.error).toBeUndefined();
  });

  it("正常退出会清掉计时器：之后再过多久也不会杀、不会改状态", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    child.emit("exit", 0, null);
    await settle();
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.exitCode).toBe(0);
    expect(st.error).toBeUndefined();

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS * 2);
    expect(child.signals).toEqual([]);
    expect(st.timedOut).toBeUndefined();
    expect(st.error).toBeUndefined();
  });

  it("CLI 自己失败退出（code≠0）：仍是「登录进程退出 code=…」+ 输出尾部，不套超时 / 取消文案", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    child.stdout.emit("data", Buffer.from("第一行\n配置损坏 oops\n"));
    child.emit("exit", 3, null);
    await settle();
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.exitCode).toBe(3);
    expect(st.error).toBe("登录进程退出 code=3：第一行 | 配置损坏 oops");
    // 完整输出尾部落日志（诊断包取这里）：同事实测「code=3」猜不出原因，真实报错只在这
    expect(warned()).toContain("lark-cli 登录失败 code=3");
    expect(warned()).toContain("配置损坏 oops");
    expect(st.timedOut).toBeUndefined();
    expect(st.cancelRequested).toBeUndefined();
  });

  it("spawn 失败（error 事件）：running 复位、文案是原始错误，计时器也清掉、引用也释放", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    // 起跑后只有总时限这一只假计时器、登记表里有它的子进程：先证明它们确实在，下面的「清掉 / 释放」才有意义
    // （计时器回调自带 running 守卫，光看「到点后不动」分不出清没清，只有数计时器才看得出）
    expect(vi.getTimerCount()).toBe(1);
    expect(G.__feishuCliLoginChildren?.has("lark-cli")).toBe(true);
    child.emit("error", new Error("spawn ENOENT"));
    await settle();
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.error).toBe("spawn ENOENT");
    expect(vi.getTimerCount()).toBe(0);
    expect(G.__feishuCliLoginChildren?.has("lark-cli")).toBe(false);

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS * 2);
    expect(child.signals).toEqual([]);
    expect(st.timedOut).toBeUndefined();
  });

  it("授权恰好在超时发 SIGTERM 之后、进程退出前成功（exit 0）：按成功收口、不显示超时", async () => {
    h.dieOn = () => false; // 不响应信号，由测试手动让它以 0 退出
    await startLogin("lark-cli");
    const child = lastLogin();
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    expect(child.signals).toEqual(["SIGTERM"]);
    child.emit("exit", 0, null);
    await settle();
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.exitCode).toBe(0);
    expect(st.error).toBeUndefined();
  });
});

describe("取消登录", () => {
  it("终止在跑的登录进程：返回时 running 已复位，用户取消不算错误（没有红字）", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();

    const r = await cancelLogin("lark-cli");
    expect(r).toEqual({ cancelled: true });
    expect(child.signals).toEqual(["SIGTERM"]);

    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.cancelRequested).toBe(true);
    expect(st.error).toBeUndefined();
    expect(st.timedOut).toBeUndefined();
    // 总时限计时器、等退出用的计时器都清掉了：不留 10 分钟后才触发的残余定时器
    expect(vi.getTimerCount()).toBe(0);
    expect(G.__feishuCliLoginChildren?.size).toBe(0);
  });

  it("幂等：重复取消 / 没登录过 / 已自己结束 → { cancelled: false }，不再发信号", async () => {
    expect(await cancelLogin("lark-cli")).toEqual({ cancelled: false });
    expect(await cancelLogin("not-a-tool")).toEqual({ cancelled: false });

    await startLogin("lark-cli");
    const child = lastLogin();
    expect(await cancelLogin("lark-cli")).toEqual({ cancelled: true });
    expect(await cancelLogin("lark-cli")).toEqual({ cancelled: false });
    expect(child.signals).toEqual(["SIGTERM"]);

    await startLogin("lark-cli");
    lastLogin().emit("exit", 0, null);
    await settle();
    expect(await cancelLogin("lark-cli")).toEqual({ cancelled: false });
  });

  it("取消后可以立刻重新登录（改前恒 409），新状态是干净的", async () => {
    await startLogin("lark-cli");
    await cancelLogin("lark-cli");

    expect((await startLogin("lark-cli")).ok).toBe(true);
    expect(loginSpawns()).toHaveLength(2);
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(true);
    expect(st.cancelRequested).toBeUndefined();
    expect(st.error).toBeUndefined();
  });

  it("登录进行中再点登录仍被拒（既有行为），文案不变", async () => {
    await startLogin("lark-cli");
    expect(await startLogin("lark-cli")).toEqual({ ok: false, error: "登录流程已在进行中" });
    expect(loginSpawns()).toHaveLength(1);
  });

  it("只取消指定的工具：取消 lark-cli 不碰 meegle", async () => {
    await startLogin("lark-cli");
    await startLogin("meegle");
    expect(loginSpawns()).toHaveLength(2);
    const [larkChild, meegleChild] = loginSpawns().map((s) => s.child);

    await cancelLogin("lark-cli");
    expect(larkChild!.signals).toEqual(["SIGTERM"]);
    expect(meegleChild!.signals).toEqual([]);
    expect(getLoginState("lark-cli")?.running).toBe(false);
    expect(getLoginState("meegle")?.running).toBe(true);
  });

  it("SIGTERM 不管用：3 秒后补 SIGKILL，退出后同样按「用户取消」收口", async () => {
    h.dieOn = (sig) => sig === "SIGKILL";
    await startLogin("lark-cli");
    const child = lastLogin();

    const p = cancelLogin("lark-cli");
    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS - 1);
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await p).toEqual({ cancelled: true });

    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.error).toBeUndefined();
    // SIGKILL 生效、进程真的退了：不该再打「放弃等待」的告警（那是留给「连 SIGKILL 都没用」的）
    expect(warned()).not.toContain("放弃等待");
  });

  it("连 SIGKILL 也没退出：再等 2 秒就放弃等待、强制复位，用户能重新发起", async () => {
    h.dieOn = () => false;
    await startLogin("lark-cli");
    const child = lastLogin();

    const p = cancelLogin("lark-cli");
    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(LOGIN_FORCE_SETTLE_MS - 1);
    expect(getLoginState("lark-cli")?.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ cancelled: true });

    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.error).toBe("登录进程没有响应终止信号，已放弃等待，可重新发起");
    expect(warned()).toContain("放弃等待"); // 异常路径留一条日志，排查「为什么没杀掉」用
    expect(G.__feishuCliLoginChildren?.size).toBe(0); // 放弃等待就释放引用，不留着一个杀不掉的进程

    // 放弃等待不会清总时限计时器；它 10 分钟后到点再触发一次，也不许改这个早已收口的状态、更不许再发信号
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    expect(st.timedOut).toBeUndefined();
    expect(st.error).toBe("登录进程没有响应终止信号，已放弃等待，可重新发起");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    expect((await startLogin("lark-cli")).ok).toBe(true);
  });

  it("超时又赶上进程不响应：文案同时说清「登录超时」和「没有响应终止信号」；迟到的 exit 不改它", async () => {
    h.dieOn = () => false;
    await startLogin("lark-cli");
    const child = lastLogin();
    const st = getLoginState("lark-cli")!;

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS + LOGIN_FORCE_SETTLE_MS);
    expect(st.running).toBe(false);
    const expected =
      "登录超时（10 分钟内未完成授权），已取消，可重新发起（登录进程没有响应终止信号，已放弃等待，可重新发起）";
    expect(st.error).toBe(expected);

    child.emit("exit", 1, null); // 进程终于退了：状态已收口，不许再被改写
    await settle();
    expect(st.error).toBe(expected);
    expect(st.exitCode).toBeUndefined();
    expect(warned()).not.toContain("登录失败"); // 也不该再当成一次「登录失败」往日志里记
  });

  it("kill 抛错（进程已经没了）：取消不抛错，等到放弃等待后照样复位", async () => {
    h.dieOn = () => false;
    await startLogin("lark-cli");
    const child = lastLogin();
    child.onKill = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };

    const p = cancelLogin("lark-cli");
    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS + LOGIN_FORCE_SETTLE_MS);
    await expect(p).resolves.toEqual({ cancelled: true });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); // 抛错也照样走完两轮
    expect(getLoginState("lark-cli")?.running).toBe(false);
  });

  it("超时与取消撞车：共用同一轮 SIGTERM → SIGKILL，不重复发信号", async () => {
    h.dieOn = (sig) => sig === "SIGKILL";
    await startLogin("lark-cli");
    const child = lastLogin();

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    expect(child.signals).toEqual(["SIGTERM"]);

    const p = cancelLogin("lark-cli"); // 超时那一轮还在等进程退出
    await settle();
    expect(child.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await p;
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.timedOut).toBe(true); // 先超时、再取消：以超时文案为准
    expect(st.error).toContain("登录超时");
  });

  it("取消与授权成功撞车：SIGTERM 发出后、进程退出前 CLI 恰好以 0 退出 → 按成功收口，返回 { cancelled: false }", async () => {
    h.dieOn = () => false; // 进程不响应信号，由测试决定它「恰好以 0 退出」
    await startLogin("lark-cli");
    const child = lastLogin();

    const p = cancelLogin("lark-cli");
    await settle();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.emit("exit", 0, null);

    // 登录其实成功了、不算被取消：设置页据此不弹「已取消登录」，刷新后看到的是「已登录」
    expect(await p).toEqual({ cancelled: false });
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.exitCode).toBe(0);
    expect(st.error).toBeUndefined();
  });

  it("超时、取消、授权成功三者撞车：SIGTERM 之后又点取消、进程随后以 0 退出 → 仍按成功收口（没有「登录超时」红字），返回 { cancelled: false }", async () => {
    h.dieOn = () => false; // 进程不响应信号，由测试决定它「恰好以 0 退出」
    await startLogin("lark-cli");
    const child = lastLogin();

    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS); // 超时：发出 SIGTERM
    const p = cancelLogin("lark-cli"); // 超时那一轮还在等进程退出时，用户又点了取消（共用同一轮终止）
    await settle();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.emit("exit", 0, null);

    expect(await p).toEqual({ cancelled: false });
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.timedOut).toBe(true);
    expect(st.exitCode).toBe(0);
    expect(st.error).toBeUndefined(); // exit 0 优先：不显示超时 / 失败文案
  });

  it("放弃等待后立刻重登：旧进程迟到的 exit 既不改新状态，也不删掉新进程的引用", async () => {
    h.dieOn = () => false;
    await startLogin("lark-cli");
    const oldChild = lastLogin();
    const p = cancelLogin("lark-cli");
    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS + LOGIN_FORCE_SETTLE_MS);
    await p;
    expect(getLoginState("lark-cli")?.running).toBe(false);

    expect((await startLogin("lark-cli")).ok).toBe(true);
    const newChild = lastLogin();
    expect(newChild).not.toBe(oldChild);
    const newState = getLoginState("lark-cli")!;
    expect(newState.running).toBe(true);

    oldChild.emit("exit", null, "SIGKILL"); // 旧进程终于退了
    await settle();
    expect(newState.running).toBe(true);
    expect(newState.error).toBeUndefined();

    // 登记表里仍是新进程：再取消能杀到它，且不会再给旧进程发信号
    h.dieOn = (sig) => sig === "SIGTERM";
    expect(await cancelLogin("lark-cli")).toEqual({ cancelled: true });
    expect(newChild.signals).toEqual(["SIGTERM"]);
    expect(oldChild.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("meegle：取消发生在 config set 排队期间（还没有子进程）→ 之后不再 spawn，也不报错", async () => {
    let release!: () => void;
    h.meegleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startLogin("meegle");
    await settle();
    expect(getLoginState("meegle")?.running).toBe(true);
    expect(loginSpawns()).toHaveLength(0);

    // 没有子进程可杀：立即返回，只留下取消标记
    expect(await cancelLogin("meegle")).toEqual({ cancelled: true });
    expect(getLoginState("meegle")?.cancelRequested).toBe(true);
    expect(getLoginState("meegle")?.running).toBe(true);

    release();
    expect(await started).toEqual({ ok: false, error: "登录已取消" });
    expect(loginSpawns()).toHaveLength(0);
    const st = getLoginState("meegle")!;
    expect(st.running).toBe(false);
    expect(st.error).toBeUndefined();
  });

  it("meegle：取消发生在第一次 config set 期间、它又失败 → 不再起 config init + config set 那一轮重试，按「用户取消」收口，不显示「host 配置失败」红字", async () => {
    let release!: () => void;
    h.meegleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.execFail = true;
    const started = startLogin("meegle");
    await settle();
    expect(await cancelLogin("meegle")).toEqual({ cancelled: true });

    release();
    expect(await started).toEqual({ ok: false, error: "登录已取消" });
    // 只有取消时已经在队列里的第一次 config set；取消之后没有再起 config init / 第二次 config set
    expect(h.execCalls).toEqual([MEEGLE_SET_HOST]);
    const st = getLoginState("meegle")!;
    expect(st.running).toBe(false);
    expect(st.error).toBeUndefined();
    expect(loginSpawns()).toHaveLength(0);
  });

  it("meegle：取消发生在重试（config init + config set）期间、重试又失败 → 同样按「用户取消」收口", async () => {
    let release!: () => void;
    // 第一次 config set 一被调用（它会失败）就换一个新的队列卡点：重试的入队卡在这里，取消就落在重试期间
    h.onExec = (n) => {
      if (n === 1) {
        h.meegleGate = new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    h.execFail = true;
    const started = startLogin("meegle");
    await settle();
    // 这时没人取消，所以第一次失败后确实进了重试，并卡在队列里（重试的 config init 还没起）
    expect(h.execCalls).toEqual([MEEGLE_SET_HOST]);
    expect(getLoginState("meegle")?.running).toBe(true);
    expect(await cancelLogin("meegle")).toEqual({ cancelled: true });

    release();
    expect(await started).toEqual({ ok: false, error: "登录已取消" });
    // 重试在取消之前就已经决定要跑、也已入队：config init 照跑（失败），第二次 config set 没有机会了
    expect(h.execCalls).toEqual([MEEGLE_SET_HOST, MEEGLE_INIT]);
    const st = getLoginState("meegle")!;
    expect(st.running).toBe(false);
    expect(st.error).toBeUndefined();
    expect(loginSpawns()).toHaveLength(0);
  });

  it("对照：没人取消时 config set 失败，仍显示「meegle host 配置失败」", async () => {
    h.execFail = true;
    const r = await startLogin("meegle");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("meegle host 配置失败：");
    const st = getLoginState("meegle")!;
    expect(st.running).toBe(false);
    expect(st.error).toBe(r.error);
    expect(loginSpawns()).toHaveLength(0);
  });

  it("对照：没人取消时第一次 config set 失败，仍先 config init、再 config set 重试一轮（既有行为）", async () => {
    h.execFail = true;
    await startLogin("meegle");
    expect(h.execCalls).toEqual([MEEGLE_SET_HOST, MEEGLE_INIT]);
  });

  it("对照：没人取消时第一次 config set 失败、config init + 第二次 config set 成功 → 照常起登录进程", async () => {
    h.execFailFirst = 1;
    expect(await startLogin("meegle")).toEqual({ ok: true });
    expect(h.execCalls).toEqual([MEEGLE_SET_HOST, MEEGLE_INIT, MEEGLE_SET_HOST]);
    const spawns = loginSpawns();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args).toEqual(["auth", "login", "--device-code", "--host", "project.feishu.cn"]);
    expect(getLoginState("meegle")?.running).toBe(true);
  });

  it("收口之后到达的残余输出不再触发自动开浏览器（取消后不该再弹授权页）", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    await cancelLogin("lark-cli");

    const before = h.spawned.length;
    child.stdout.emit("data", Buffer.from(`请在浏览器打开：${AUTH_URL}\n`));
    expect(h.spawned.length).toBe(before);
    expect(getLoginState("lark-cli")?.authUrl).toBeUndefined();
  });

  it("对照：登录进行中同样的输出会记下 authUrl 并 spawn 一次 opener", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    const before = h.spawned.length;
    child.stdout.emit("data", Buffer.from(`请在浏览器打开：${AUTH_URL}\n`));
    expect(h.spawned.length).toBe(before + 1);
    expect(getLoginState("lark-cli")?.authUrl).toBe(AUTH_URL);
  });
});

describe("收口之后迟到的 error / exit 事件不改状态", () => {
  it("取消收口后，迟到的 error 事件不会给状态写上红字", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    await cancelLogin("lark-cli");
    const st = getLoginState("lark-cli")!;
    expect(st.running).toBe(false);
    expect(st.error).toBeUndefined();

    child.emit("error", new Error("kill EPERM"));
    await settle();
    expect(st.running).toBe(false);
    expect(st.error).toBeUndefined();
  });

  it("超时收口后，迟到的 error 事件不会覆盖「登录超时」文案", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    await settle();
    const st = getLoginState("lark-cli")!;
    const expected = "登录超时（10 分钟内未完成授权），已取消，可重新发起";
    expect(st.error).toBe(expected);

    child.emit("error", new Error("kill EPERM"));
    await settle();
    expect(st.error).toBe(expected);
  });

  it("error 先收口、随后才到的 exit：不改 error / exitCode，也不再记一次「登录失败」", async () => {
    await startLogin("lark-cli");
    const child = lastLogin();
    child.emit("error", new Error("spawn EPERM"));
    await settle();
    const st = getLoginState("lark-cli")!;
    expect(st.error).toBe("spawn EPERM");

    child.emit("exit", 1, null);
    await settle();
    expect(st.error).toBe("spawn EPERM");
    expect(st.exitCode).toBeUndefined();
    expect(warned()).not.toContain("登录失败");
  });
});

describe("计时器不拖住进程退出（unref）", () => {
  it("总时限计时器与「等进程退出」的等待计时器都 unref 过：不会因为它们让事件循环退不了", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      h.dieOn = () => false;
      await startLogin("lark-cli");
      const timerOf = (ms: number) => {
        const i = spy.mock.calls.findIndex((c) => c[1] === ms);
        return i < 0 ? undefined : (spy.mock.results[i]!.value as { hasRef?: () => boolean });
      };
      const total = timerOf(LOGIN_TIMEOUT_MS);
      expect(total).toBeDefined();
      // 假时钟的 Timeout 对象支持 hasRef；如果哪天不支持了，要让这条用例明着红，别悄悄放过
      expect(typeof total!.hasRef).toBe("function");
      expect(total!.hasRef!()).toBe(false);

      const p = cancelLogin("lark-cli");
      await settle();
      const grace = timerOf(LOGIN_KILL_GRACE_MS);
      expect(grace).toBeDefined();
      expect(grace!.hasRef!()).toBe(false);
      await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS + LOGIN_FORCE_SETTLE_MS);
      await p;
    } finally {
      spy.mockRestore();
    }
  });
});

describe("卸载与登录的联动", () => {
  const setupInstalled = () => {
    const binDir = getToolsBinDir();
    fs.mkdirSync(binDir, { recursive: true });
    const marker = path.join(binDir, "marker.txt");
    fs.writeFileSync(marker, "x");
    fs.mkdirSync(path.join(tmpHome, ".lark-cli"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".lark-cli", "config.json"), "{}");
    fs.mkdirSync(path.join(tmpHome, ".meegle"), { recursive: true });
    return marker;
  };

  it("登录进行中卸载：先终止登录进程、等它真的退出，再删文件（不是反过来）", async () => {
    const marker = setupInstalled();
    h.dieOn = () => false; // 进程不会自己退，由测试决定什么时候退
    await startLogin("lark-cli");
    const child = lastLogin();

    const rmSpy = vi.spyOn(fs.promises, "rm");
    try {
      const p = uninstallFeishuTools();
      await settle();
      expect(child.signals).toEqual(["SIGTERM"]);
      // 进程还没退：一个 rm 都不该发出（Windows 上删不掉占用中的 exe）。直接看调用、不看「文件还在不在」——
      // 真实的 rm 是异步 IO，没等登录进程就删的话，文件「还在」可能只是还没删完，那样断言会假绿
      expect(rmSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(marker)).toBe(true);

      child.emit("exit", null, "SIGTERM");
      await p;
      expect(rmSpy).toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".lark-cli"))).toBe(false);
    expect(getLoginState("lark-cli")?.running).toBe(false);
  });

  it("两个工具都在登录：卸载把两个都终止", async () => {
    setupInstalled();
    await startLogin("lark-cli");
    await startLogin("meegle");
    const [larkChild, meegleChild] = loginSpawns().map((s) => s.child);

    await uninstallFeishuTools();
    expect(larkChild!.signals).toEqual(["SIGTERM"]);
    expect(meegleChild!.signals).toEqual(["SIGTERM"]);
    expect(getLoginState("lark-cli")?.running).toBe(false);
    expect(getLoginState("meegle")?.running).toBe(false);
  });

  it("安装进行中仍拒绝卸载，而且不会误杀正在登录的进程", async () => {
    setupInstalled();
    await startLogin("lark-cli");
    const child = lastLogin();
    getInstallState().running = true;

    await expect(uninstallFeishuTools()).rejects.toThrow("安装进行中");
    expect(child.signals).toEqual([]);
    expect(getLoginState("lark-cli")?.running).toBe(true);
  });

  it("没有登录在跑：卸载照常删光，不发任何信号", async () => {
    const marker = setupInstalled();
    await uninstallFeishuTools();
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".lark-cli"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".meegle"))).toBe(false);
    expect(h.spawned).toHaveLength(0);
  });

  it("cancelAllLogins 本身：没有登录时什么也不做；有登录时全部终止", async () => {
    await cancelAllLogins();
    expect(h.spawned).toHaveLength(0);

    await startLogin("lark-cli");
    await startLogin("meegle");
    await cancelAllLogins();
    expect(loginSpawns().every((s) => s.child.signals.join() === "SIGTERM")).toBe(true);
  });
});

describe("收口一律失效状态缓存（登录态可能变了，设置页下一次 GET 要拿真值）", () => {
  /** invalidateStatusCache 的可观察副作用：globalThis.__feishuStatusGen 递增 */
  const gen = () =>
    (globalThis as unknown as { __feishuStatusGen?: number }).__feishuStatusGen ?? 0;

  const endings: [string, (child: FakeChild) => Promise<void> | void][] = [
    ["正常退出（exit 0）", (c) => void c.emit("exit", 0, null)],
    ["CLI 失败退出（exit 3）", (c) => void c.emit("exit", 3, null)],
    ["spawn 失败（error 事件）", (c) => void c.emit("error", new Error("boom"))],
    ["用户取消", async () => void (await cancelLogin("lark-cli"))],
    ["到点超时", async () => void (await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS))],
  ];

  it.each(endings)("%s → 状态缓存被失效", async (_name, finish) => {
    await startLogin("lark-cli");
    const before = gen();
    await finish(lastLogin());
    await settle();
    expect(gen()).toBeGreaterThan(before);
  });

  it("放弃等待（SIGKILL 后仍未退出）也失效", async () => {
    h.dieOn = () => false;
    await startLogin("lark-cli");
    const before = gen();
    const p = cancelLogin("lark-cli");
    await vi.advanceTimersByTimeAsync(LOGIN_KILL_GRACE_MS + LOGIN_FORCE_SETTLE_MS);
    await p;
    expect(gen()).toBeGreaterThan(before);
  });
});
