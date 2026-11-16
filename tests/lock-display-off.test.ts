/**
 * 锁屏必黑屏（electron-app/lock-display-off.mjs + main.js 接线契约）
 *
 * 钉死的语义：
 * - 影响范围只限 Flowship：必须「Flowship 持有亮屏锁、且没有任何其他程序持有」才介入；
 *   Flowship 没持有 / 别的程序也在阻止熄屏 / 探测失败（看不清谁在阻止）——一律不介入，交给系统
 * - 用的是熄屏命令，**不碰页面**（AI 黑屏后仍要能操作内置浏览器）
 * - 锁屏 → 稍等一下 → 熄屏；解锁 / 探测期间解锁 → 不动
 * - 用户点亮屏幕后走开：空闲满阈值再熄一次（再评估一次「现在是不是只有 Flowship 在阻止」）；没有输入就不重复熄
 * - 「没介入」不是一锤子买卖（Flowship 的亮屏锁断断续续，锁屏那一刻可能落在空档；别人也可能随后放手）：
 *   用户空闲满阈值后按 5→10→20→40→60 秒退避重新评估；用户一碰键鼠退避回到起步；用户一直在操作就不评估
 * - 命令出错 / 探测失败不抛、不刷屏日志
 * - 环境变量 FLOWSHIP_LOCK_DISPLAY_OFF=0 / 非 macOS 整体关闭
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COARSE_SLACK_MS,
  analyzeDisplayLocks,
  LOCK_DISPLAY_OFF_ENV,
  LOCK_GRACE_MS,
  LOCK_IDLE_THRESHOLD_SEC,
  LOCK_POLL_MS,
  LOCK_RETRY_MAX_MS,
  LOCK_RETRY_MIN_MS,
  PRECISE_SLACK_MS,
  createLockDisplayOff,
  isLockDisplayOffEnabled,
  parseHidIdleMs,
  parseHoldsDisplayLock,
  readIdle,
  runPmset,
} from "../electron-app/lock-display-off.mjs";

const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
/** 去掉块注释与整行 // 注释（模块头注释会提到「为什么不用 pause / 静音」，不该算引用） */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

/** 2026-11-16 真机 `pmset -g assertions` 的原样输出（节选）：Flowship 主进程 pid 681 持有 Video Wake Lock */
const REAL_HOLDING = `2026-11-16 13:46:59 +0800 
Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleDisplaySleep    1
   PreventSystemSleep             1
   InternalPreventDisplaySleep    1
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 905(caffeinate): [0x0000007700078114] 05:00:42 PreventSystemSleep named: "caffeinate command-line tool"  
	Details: caffeinate asserting on behalf of Process ID 846
   pid 447(WindowServer): [0x0000006f0009802d] 00:00:00 UserIsActive named: "com.apple.iohideventsystem.queue.tickle serviceID:100002c2f"  
   pid 681(Flowship): [0x0000445e0001900c] 00:10:59 NoIdleSleepAssertion named: "Playing audio"  
   pid 681(Flowship): [0x000046f1000591ee] 00:00:00 NoDisplaySleepAssertion named: "Video Wake Lock"  
   pid 390(powerd): [0x0000087a0010862a] 00:00:00 InternalPreventDisplaySleep named: "com.apple.powermanagement.delayDisplayOff"  
	Timeout will fire in 300 secs Action=TimeoutActionTurnOff
`;

/** Flowship 只有「系统空闲睡眠」类的锁（播音频），没有亮屏锁；系统汇总里的 PreventUserIdleDisplaySleep 来自别人 */
const REAL_NOT_HOLDING = `Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 681(Flowship): [0x0000445e0001900c] 00:10:59 NoIdleSleepAssertion named: "Playing audio"  
   pid 390(powerd): [0x0000087a0010862a] 00:00:00 InternalPreventDisplaySleep named: "com.apple.powermanagement.delayDisplayOff"  
   pid 1234(Google Chrome): [0x0000000100000001] 00:00:03 PreventUserIdleDisplaySleep named: "Video Wake Lock"  
`;

/** 别人的亮屏锁：Chrome 播视频、`caffeinate -d`（Flowship 同时也持有） */
const OTHER_HOLDERS = `   pid 1234(Google Chrome): [0x0000000100000001] 00:00:03 PreventUserIdleDisplaySleep named: "Video Wake Lock"  
   pid 905(caffeinate): [0x0000007700078115] 06:33:12 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"  
`;
const REAL_HOLDING_PLUS_OTHERS = REAL_HOLDING + OTHER_HOLDERS;

describe("常量与开关", () => {
  it("阈值：宽限 1s、巡检 5s、空闲 15s（贴近系统自己 11~30 秒的再熄屏）；容差 毫秒级 400ms / 整秒 1500ms", () => {
    expect(LOCK_GRACE_MS).toBe(1000);
    expect(LOCK_POLL_MS).toBe(5000);
    expect(LOCK_IDLE_THRESHOLD_SEC).toBe(15);
    expect(PRECISE_SLACK_MS).toBe(400);
    expect(COARSE_SLACK_MS).toBe(1500);
    expect(LOCK_RETRY_MIN_MS).toBe(5000);
    expect(LOCK_RETRY_MAX_MS).toBe(60000);
  });

  it("只在 macOS 启用；=0 关闭；拼写错误当作没设", () => {
    expect(isLockDisplayOffEnabled({}, "darwin")).toBe(true);
    expect(isLockDisplayOffEnabled(undefined, "darwin")).toBe(true);
    expect(isLockDisplayOffEnabled({ [LOCK_DISPLAY_OFF_ENV]: "0" }, "darwin")).toBe(false);
    expect(isLockDisplayOffEnabled({ [LOCK_DISPLAY_OFF_ENV]: " 0 " }, "darwin")).toBe(false);
    expect(isLockDisplayOffEnabled({ [LOCK_DISPLAY_OFF_ENV]: "false" }, "darwin")).toBe(true);
    expect(isLockDisplayOffEnabled({}, "win32")).toBe(false);
    expect(isLockDisplayOffEnabled({}, "linux")).toBe(false);
  });
});

describe("parseHoldsDisplayLock", () => {
  it("真机输出：pid 681 持有 Video Wake Lock → true", () => {
    expect(parseHoldsDisplayLock(REAL_HOLDING, 681)).toBe(true);
  });

  it("只有播音频的系统空闲睡眠锁 → false（别人持有亮屏锁、系统汇总行都不算）", () => {
    expect(parseHoldsDisplayLock(REAL_NOT_HOLDING, 681)).toBe(false);
  });

  it("换成别的 pid：只认属主，不被别的进程的亮屏锁迷惑", () => {
    expect(parseHoldsDisplayLock(REAL_HOLDING, 905)).toBe(false);
    expect(parseHoldsDisplayLock(REAL_HOLDING, 6810)).toBe(false); // 前缀相同不算
    expect(parseHoldsDisplayLock(REAL_NOT_HOLDING, 1234)).toBe(true);
  });

  it("三种类型名都认；powerd 自己的 InternalPreventDisplaySleep 不算 Flowship", () => {
    for (const type of ["NoDisplaySleepAssertion", "PreventUserIdleDisplaySleep", "PreventDisplaySleep"]) {
      expect(parseHoldsDisplayLock(`   pid 7(Flowship): [0x1] 00:00:01 ${type} named: "x"`, 7)).toBe(true);
    }
    expect(
      parseHoldsDisplayLock(`   pid 7(powerd): [0x1] 00:00:01 InternalPreventDisplaySleep named: "x"`, 7),
    ).toBe(false);
  });

  it("进程名里带括号（Helper (Renderer)）也能识别；空 / 非字符串不抛", () => {
    expect(
      parseHoldsDisplayLock(`   pid 9(Flowship Helper (Renderer)): [0x1] 00:00:01 NoDisplaySleepAssertion named: "x"`, 9),
    ).toBe(true);
    expect(parseHoldsDisplayLock("", 1)).toBe(false);
    expect(parseHoldsDisplayLock(undefined, 1)).toBe(false);
    expect(parseHoldsDisplayLock(null, 1)).toBe(false);
  });
});

describe("analyzeDisplayLocks（谁在阻止熄屏）", () => {
  it("真机输出：只有 Flowship 持有——caffeinate(PreventSystemSleep)、WindowServer(UserIsActive)、powerd(Internal…) 都不算别人", () => {
    expect(analyzeDisplayLocks(REAL_HOLDING, 681)).toEqual({ mine: true, others: [] });
  });

  it("Flowship 没持有、Chrome 持有：mine=false，others 里是 Chrome", () => {
    expect(analyzeDisplayLocks(REAL_NOT_HOLDING, 681)).toEqual({
      mine: false,
      others: [{ pid: 1234, name: "Google Chrome", type: "PreventUserIdleDisplaySleep" }],
    });
  });

  it("Flowship 和别人同时持有：mine=true 且 others 非空（一个进程多把锁会出现多次）", () => {
    const r = analyzeDisplayLocks(
      REAL_HOLDING_PLUS_OTHERS + `   pid 1234(Google Chrome): [0x2] 00:00:01 NoDisplaySleepAssertion named: "x"\n`,
      681,
    );
    expect(r.mine).toBe(true);
    expect(r.others.map((o) => `${o.pid}:${o.name}:${o.type}`)).toEqual([
      "1234:Google Chrome:PreventUserIdleDisplaySleep",
      "905:caffeinate:PreventUserIdleDisplaySleep",
      "1234:Google Chrome:NoDisplaySleepAssertion",
    ]);
  });

  it("别人只有「系统空闲睡眠」类的锁（播音频、caffeinate 默认）不算阻止熄屏", () => {
    const out = [
      `   pid 7(Music): [0x1] 00:00:01 NoIdleSleepAssertion named: "Playing audio"`,
      `   pid 8(caffeinate): [0x2] 00:00:01 PreventSystemSleep named: "caffeinate command-line tool"`,
      `   pid 9(powerd): [0x3] 00:00:01 InternalPreventDisplaySleep named: "com.apple.powermanagement.delayDisplayOff"`,
      `   pid 10(powerd): [0x4] 00:00:01 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"`,
      `   pid 11(bluetoothd): [0x5] 00:00:01 UserIsActive named: "Bluetooth LE HID Activity"`,
    ].join("\n");
    expect(analyzeDisplayLocks(out, 681)).toEqual({ mine: false, others: [] });
  });

  it("进程名里带括号、持续时间带天数（1+02:03:04）也能解析；乱输入不抛", () => {
    const out = [
      `   pid 9(Zoom Helper (Renderer)): [0x00000000000000ab] 1+02:03:04 PreventDisplaySleep named: "x"`,
      `Assertion status system-wide:`,
      `   PreventUserIdleDisplaySleep    1`,
      `\tDetails: caffeinate asserting on behalf of Process ID 846`,
    ].join("\n");
    expect(analyzeDisplayLocks(out, 681)).toEqual({
      mine: false,
      others: [{ pid: 9, name: "Zoom Helper (Renderer)", type: "PreventDisplaySleep" }],
    });
    for (const bad of ["", undefined, null, 42] as const) {
      expect(analyzeDisplayLocks(bad as never, 681)).toEqual({ mine: false, others: [] });
    }
  });
});

describe("createLockDisplayOff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T14:00:00+08:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Opts = {
    /** true（默认）= 只有 Flowship 持有；false = Flowship 没持有（Chrome 持有）；others = Flowship 和别的程序都持有 */
    holding?: boolean | "probe-fails" | "probe-throws" | "others";
    sleepOk?: boolean;
    enabled?: boolean;
    /** 读空闲时间：默认正常（毫秒级）；fails = 读不到（返回 null）；throws = 抛异常 */
    idle?: "fails" | "throws";
    /** false = 只有整秒精度（ioreg 读不到、退回 Electron 的 getSystemIdleTime） */
    precise?: boolean;
    /** 锁屏当下距上次键鼠输入多久（默认 2 秒；手还在鼠标上用 50） */
    lastInputAgoMs?: number;
    probeDelayMs?: number;
  };

  const setup = (opts: Opts = {}) => {
    const calls: string[][] = [];
    const logs: string[] = [];
    // 空闲时间随（假）时钟走：touch() = 用户刚碰过键鼠
    let lastInputAt = Date.now() - (opts.lastInputAgoMs ?? 2000);
    let holding = opts.holding;
    const execPmset = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "-g") {
        if (opts.probeDelayMs) await new Promise((r) => setTimeout(r, opts.probeDelayMs));
        if (holding === "probe-throws") throw new Error("spawn boom");
        if (holding === "probe-fails") return { ok: false, stdout: "" };
        if (holding === "others") return { ok: true, stdout: REAL_HOLDING_PLUS_OTHERS };
        return { ok: true, stdout: holding === false ? REAL_NOT_HOLDING : REAL_HOLDING };
      }
      return { ok: opts.sleepOk !== false, stdout: "" };
    });
    const ctl = createLockDisplayOff({
      enabled: opts.enabled,
      pid: 681,
      execPmset,
      readIdle: async () => {
        if (opts.idle === "throws") throw new Error("no idle");
        if (opts.idle === "fails") return null;
        const raw = Date.now() - lastInputAt;
        return opts.precise === false ? { idleMs: Math.floor(raw / 1000) * 1000, precise: false } : { idleMs: raw, precise: true };
      },
      log: (m: string) => logs.push(m),
    });
    return {
      ctl,
      calls,
      logs,
      execPmset,
      touch: () => {
        lastInputAt = Date.now();
      },
      /** 中途改变「现在谁在持锁」 */
      setHolding: (h: Opts["holding"]) => {
        holding = h;
      },
      sleepCount: () => calls.filter((c) => c[0] === "displaysleepnow").length,
      probeCount: () => calls.filter((c) => c[0] === "-g").length,
    };
  };

  it("锁屏：宽限期内不动，期满后探测 → 持有亮屏锁 → 熄屏一次", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS - 1);
    expect(s.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toEqual([["-g", "assertions"], ["displaysleepnow"]]);
    expect(s.logs.join("\n")).toMatch(/锁屏：Flowship 持有亮屏锁.*已让显示器熄灭/);
  });

  it("Flowship 没持有亮屏锁：只探测、不熄屏（交给系统），日志只记一条", async () => {
    const s = setup({ holding: false });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(0);
    expect(s.logs.filter((l) => /没有持有亮屏锁/.test(l))).toHaveLength(1);
  });

  it("别的程序也在阻止熄屏（Chrome 视频 / caffeinate -d）：不介入，日志只记一条并点名", async () => {
    const s = setup({ holding: "others" });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.probeCount()).toBe(1);
    expect(s.sleepCount()).toBe(0);
    const hit = s.logs.filter((l) => /除 Flowship 外还有/.test(l));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatch(/Google Chrome、caffeinate/);
    // 用户一直不动：会按退避间隔重新评估，但一直不熄、日志也不会反复写
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 20);
    expect(s.probeCount()).toBeGreaterThan(1);
    expect(s.sleepCount()).toBe(0);
    expect(s.logs).toHaveLength(1);
  });

  it("探测命令失败 / 抛异常（看不清谁在阻止）：不介入，日志只记一条", async () => {
    for (const holding of ["probe-fails", "probe-throws"] as const) {
      const s = setup({ holding });
      s.ctl.onLock();
      await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
      expect(s.sleepCount()).toBe(0);
      expect(s.logs.filter((l) => /没能确认当前是谁在阻止熄屏/.test(l))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 20);
      expect(s.sleepCount()).toBe(0);
      expect(s.logs).toHaveLength(1);
    }
  });

  it("别人先持锁、后来放手：用户空闲时重新评估，只剩 Flowship 在阻止了才熄屏，之后不再重复", async () => {
    const s = setup({ holding: "others" });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(19_000); // 锁屏后 20s，别人还在持锁
    expect(s.sleepCount()).toBe(0);
    s.setHolding(undefined); // 别人放手了，只剩 Flowship
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.sleepCount()).toBe(1);
    expect(s.logs.at(-1)).toMatch(/再次检查：Flowship 持有亮屏锁，且没有其他程序在阻止熄屏，已让显示器熄灭/);

    // 熄了之后用户没碰过：不会再探测 / 再熄
    const probes = s.probeCount();
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 40);
    expect(s.sleepCount()).toBe(1);
    expect(s.probeCount()).toBe(probes);
  });

  it("锁屏那一刻 Flowship 刚好没持锁（亮屏锁的空档），随后又持上了：用户空闲满 15 秒的那次巡检补上熄屏", async () => {
    // 锁屏当下用户刚碰过键鼠（空闲从 0 起算）：第一次满足「空闲 ≥ 15 秒」的巡检在锁屏后恰好 15 秒
    const s = setup({ holding: false, lastInputAgoMs: 0 });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(0);
    s.setHolding(undefined); // 锁屏后几秒，Flowship 又拿到了亮屏锁
    await vi.advanceTimersByTimeAsync(14_000 - 1); // 锁屏后 15s - 1ms：中间 5s / 10s 两次巡检用户空闲不足，不动
    expect(s.sleepCount()).toBe(0);
    expect(s.probeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.sleepCount()).toBe(1);
  });

  it("探测一开始失败、后来恢复：重新评估时熄屏", async () => {
    const s = setup({ holding: "probe-fails" });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(0);
    s.setHolding(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sleepCount()).toBe(1);
  });

  it("已熄屏之后用户点亮又走开，这时别人在持锁：不熄；别人放手后即使用户没再碰也会补上", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);

    s.setHolding("others");
    s.touch();
    await vi.advanceTimersByTimeAsync(LOCK_IDLE_THRESHOLD_SEC * 1000 + LOCK_POLL_MS * 2);
    expect(s.sleepCount()).toBe(1); // 没多熄

    s.setHolding(undefined);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(s.sleepCount()).toBe(2);
  });

  it("没介入的状态下用户一直在操作：不重新评估（不打扰正在用锁屏界面的人）", async () => {
    const s = setup({ holding: "others" });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    for (let i = 0; i < 24; i++) {
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS);
      s.touch(); // 每 5 秒动一下，空闲永远到不了 15 秒
    }
    expect(s.probeCount()).toBe(1);
    expect(s.sleepCount()).toBe(0);
  });

  it("只有 Flowship 持有时，熄屏的日志写明「没有其他程序在阻止」", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.logs.join("\n")).toMatch(/Flowship 持有亮屏锁，且没有其他程序在阻止熄屏，已让显示器熄灭/);
  });

  it("宽限期内就解锁：什么都不做", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(500);
    s.ctl.onUnlock();
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 3);
    expect(s.calls).toEqual([]);
    expect(s.ctl.isLocked()).toBe(false);
  });

  it("探测进行中解锁：不再发熄屏命令", async () => {
    const s = setup({ probeDelayMs: 500 });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS + 100); // 探测已发出、还没回来
    s.ctl.onUnlock();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.probeCount()).toBe(1);
    expect(s.sleepCount()).toBe(0);
  });

  it("重复的锁屏事件不会叠加定时器 / 重复熄屏", async () => {
    const s = setup();
    s.ctl.onLock();
    s.ctl.onLock();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);
  });

  it("熄屏后没有任何输入：巡检不会重复熄屏（屏幕本来就是黑的）", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 20); // 5 分钟，空闲早已超过阈值
    expect(s.sleepCount()).toBe(1);
  });

  it("用户点亮屏幕后走开：空闲满阈值再熄一次，且只熄一次", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);

    // 过一会儿用户碰了键鼠（空闲归零），然后又走开
    await vi.advanceTimersByTimeAsync(30_000);
    s.touch();
    // 空闲不足阈值：不动
    await vi.advanceTimersByTimeAsync((LOCK_IDLE_THRESHOLD_SEC - 5) * 1000);
    expect(s.sleepCount()).toBe(1);
    // 空闲达到阈值后的下一次巡检：再熄一次
    await vi.advanceTimersByTimeAsync(5000 + LOCK_POLL_MS);
    expect(s.sleepCount()).toBe(2);
    expect(s.logs.join("\n")).toMatch(/点亮后无人操作/);

    // 之后依旧没动：不重复
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 10);
    expect(s.sleepCount()).toBe(2);

    // 再碰一次再走开：又能再熄一次
    s.touch();
    await vi.advanceTimersByTimeAsync(LOCK_IDLE_THRESHOLD_SEC * 1000 + LOCK_POLL_MS);
    expect(s.sleepCount()).toBe(3);
  });

  it("手还在鼠标上：熄屏后几百毫秒就被碰了一下再走开（毫秒级读数）——也要再熄，不能一直亮到解锁", async () => {
    // 锁屏当下距上次输入只有 50ms（快捷键 / 热角锁屏，手没离开）
    const s = setup({ lastInputAgoMs: 50 });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100); // 熄屏命令发出后 100ms 就被碰了
    s.touch();
    await vi.advanceTimersByTimeAsync(LOCK_IDLE_THRESHOLD_SEC * 1000 + LOCK_POLL_MS * 2);
    expect(s.sleepCount()).toBe(2);
  });

  it("只有整秒精度时（ioreg 读不到）：熄屏后 2 秒再被碰也能识别", async () => {
    const s = setup({ precise: false, lastInputAgoMs: 50 });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    s.touch();
    await vi.advanceTimersByTimeAsync(LOCK_IDLE_THRESHOLD_SEC * 1000 + LOCK_POLL_MS * 2);
    expect(s.sleepCount()).toBe(2);
  });

  it("整秒精度下没有任何输入：不会因为取整误差反复熄屏", async () => {
    const s = setup({ precise: false, lastInputAgoMs: 50 });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 60);
    expect(s.sleepCount()).toBe(1);
  });

  it("用户还在操作（空闲不足阈值）：不熄；一直在操作就一直不熄", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS);
      s.touch(); // 每 5 秒动一下
    }
    expect(s.sleepCount()).toBe(1);
  });

  it("解锁：宽限定时器和巡检定时器都被清掉，之后不再有任何回调", async () => {
    const s = setup();
    s.ctl.onLock();
    expect(vi.getTimerCount()).toBe(2); // 宽限 + 巡检
    s.ctl.onUnlock();
    expect(vi.getTimerCount()).toBe(0);

    // 宽限期过后（巡检已在跑）再解锁，同样清干净
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    s.ctl.onUnlock();
    expect(vi.getTimerCount()).toBe(0);
    const calls = s.calls.length;
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 10);
    expect(s.calls.length).toBe(calls);
  });

  it("没介入的状态：用户空闲满 15 秒才开始重新评估，间隔 5→10→20→40→60 秒退避，不会每 5 秒都跑一次 pmset", async () => {
    const s = setup({ holding: false }); // 一直没持锁，用户一直不动（锁屏当下已空闲 2 秒）
    s.ctl.onLock();
    let t = 0;
    const probesAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms - t);
      t = ms;
      return s.probeCount();
    };
    // 巡检落在锁屏后 5s 的整数倍；第一次空闲 ≥ 15 秒的巡检在 15s。之后 +5、+10、+20、+40、+60（封顶）
    expect(await probesAt(14_999)).toBe(1); // 只有锁屏那一次
    expect(await probesAt(15_000)).toBe(2);
    expect(await probesAt(19_999)).toBe(2);
    expect(await probesAt(20_000)).toBe(3);
    expect(await probesAt(29_999)).toBe(3);
    expect(await probesAt(30_000)).toBe(4);
    expect(await probesAt(49_999)).toBe(4);
    expect(await probesAt(50_000)).toBe(5);
    expect(await probesAt(89_999)).toBe(5);
    expect(await probesAt(90_000)).toBe(6);
    expect(await probesAt(149_999)).toBe(6);
    expect(await probesAt(150_000)).toBe(7);
    expect(await probesAt(209_999)).toBe(7); // 封顶 60s：不会越拉越长
    expect(await probesAt(210_000)).toBe(8);
    expect(s.sleepCount()).toBe(0);
  });

  it("用户一碰键鼠，退避回到起步：他再走开满 15 秒就重新评估，不用等满封顶的 60 秒", async () => {
    const s = setup({ holding: "others" });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(150_000); // 退避已拉长到 60s，下一次本该在 210s
    expect(s.probeCount()).toBe(7);
    await vi.advanceTimersByTimeAsync(2_000);
    s.touch(); // 锁屏后 152s 碰了一下，然后走开
    await vi.advanceTimersByTimeAsync(17_999); // 170s - 1ms：他空闲刚好还差 1ms 满 15 秒
    expect(s.probeCount()).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.probeCount()).toBe(8);
  });

  it("解锁后再次锁屏：退避从起步重新开始，不继承上一次锁屏拉长的间隔", async () => {
    const s = setup({ holding: "others" });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(150_000); // 退避拉长到 60s
    s.ctl.onUnlock();
    const before = s.probeCount();
    s.ctl.onLock(); // 用户一直没碰过键鼠（比如空闲自动锁屏）：空闲早已超过阈值
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.probeCount()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(9_000); // 锁屏后 10s：起步间隔 5s 已过 → 再评估一次
    expect(s.probeCount()).toBe(before + 2);
  });

  it("熄屏命令失败：不抛、失败日志只记一条；之后空闲时会重试", async () => {
    const s = setup({ sleepOk: false });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(1);
    expect(s.logs.filter((l) => /让显示器熄灭失败/.test(l))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 20);
    expect(s.sleepCount()).toBeGreaterThan(1);
    expect(s.logs.filter((l) => /让显示器熄灭失败/.test(l))).toHaveLength(1);
  });

  it("读空闲时间抛异常 / 读不到：不抛、锁屏当下照样熄屏，之后巡检不乱熄", async () => {
    for (const idle of ["throws", "fails"] as const) {
      const s = setup({ idle });
      s.ctl.onLock();
      await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS + LOCK_POLL_MS * 30);
      expect(s.sleepCount()).toBe(1);
    }
  });

  it("处理当时没读到空闲时间：用之后第一次读到的当基线，此后的新输入照样能识别", async () => {
    let lastInputAt = Date.now() - 50;
    let n = 0;
    const calls: string[][] = [];
    const ctl = createLockDisplayOff({
      pid: 681,
      execPmset: async (args: string[]) => {
        calls.push(args);
        return { ok: true, stdout: REAL_HOLDING };
      },
      readIdle: async () => {
        n += 1;
        return n === 1 ? null : { idleMs: Date.now() - lastInputAt, precise: true };
      },
    });
    const sleeps = () => calls.filter((c) => c[0] === "displaysleepnow").length;
    ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS + LOCK_POLL_MS * 2); // 熄屏 + 第一次巡检补基线
    expect(sleeps()).toBe(1);
    lastInputAt = Date.now(); // 用户碰了一下再走
    await vi.advanceTimersByTimeAsync(LOCK_IDLE_THRESHOLD_SEC * 1000 + LOCK_POLL_MS * 2);
    expect(sleeps()).toBe(2);
  });

  it("日志函数抛异常也不影响熄屏（系统事件回调里不能抛）", async () => {
    const calls: string[][] = [];
    const ctl = createLockDisplayOff({
      pid: 681,
      execPmset: async (args: string[]) => {
        calls.push(args);
        return { ok: true, stdout: REAL_HOLDING };
      },
      readIdle: async () => ({ idleMs: 0, precise: true }),
      log: () => {
        throw new Error("log boom");
      },
    });
    ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(calls.map((c) => c[0])).toEqual(["-g", "displaysleepnow"]);
  });

  it("解锁后再次锁屏：重新计一轮", async () => {
    const s = setup();
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    s.ctl.onUnlock();
    await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 2);
    expect(s.sleepCount()).toBe(1);
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS);
    expect(s.sleepCount()).toBe(2);
  });

  it("关闭（enabled=false，如 FLOWSHIP_LOCK_DISPLAY_OFF=0 / 非 macOS）：一个命令都不跑", async () => {
    const s = setup({ enabled: false });
    s.ctl.onLock();
    await vi.advanceTimersByTimeAsync(LOCK_GRACE_MS + LOCK_POLL_MS * 3);
    expect(s.calls).toEqual([]);
    expect(s.ctl.isLocked()).toBe(false);
    s.ctl.onUnlock();
  });
});

describe("parseHidIdleMs / readIdle", () => {
  it("真机输出：HIDIdleTime 纳秒 → 毫秒", () => {
    expect(parseHidIdleMs(`+-o IOHIDSystem  <class IOHIDSystem>\n  {\n      "HIDIdleTime" = 236595291\n  }`)).toBeCloseTo(236.595291, 6);
    expect(parseHidIdleMs(`"HIDIdleTime" = 0`)).toBe(0);
    expect(parseHidIdleMs(`"HIDIdleTime"=1320419541`)).toBeCloseTo(1320.419541, 6);
  });

  it("解析不出来 / 空 / 非字符串：null", () => {
    expect(parseHidIdleMs("")).toBeNull();
    expect(parseHidIdleMs(undefined)).toBeNull();
    expect(parseHidIdleMs(`"HIDIdleTime" = abc`)).toBeNull();
    expect(parseHidIdleMs(`no such key`)).toBeNull();
  });

  type Cb = (e: unknown, out: string) => void;
  const fakeExec = (impl: (cb: Cb) => void) => vi.fn((_c: string, _a: string[], _o: unknown, cb: Cb) => impl(cb));

  it("ioreg 读到：毫秒级（precise），固定调 /usr/sbin/ioreg，带超时", async () => {
    const exec = fakeExec((cb) => cb(null, `"HIDIdleTime" = 2500000000`));
    const r = await readIdle(exec, () => 99);
    expect(r).toEqual({ idleMs: 2500, precise: true });
    expect(exec).toHaveBeenCalledWith("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1"], { timeout: 3000 }, expect.any(Function));
  });

  it("ioreg 出错 / 解析不出来 / 同步抛：退回 Electron 的整秒值（向下取整，非精确）", async () => {
    const failing = fakeExec((cb) => cb(new Error("exit 1"), ""));
    expect(await readIdle(failing, () => 7.9)).toEqual({ idleMs: 7000, precise: false });
    const garbage = fakeExec((cb) => cb(null, "nothing here"));
    expect(await readIdle(garbage, () => 3)).toEqual({ idleMs: 3000, precise: false });
    const throwing = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(await readIdle(throwing, () => 1)).toEqual({ idleMs: 1000, precise: false });
  });

  it("两条路都读不到（负数 / NaN / 抛异常 / 没提供）：null，不抛", async () => {
    const failing = fakeExec((cb) => cb(new Error("x"), ""));
    expect(await readIdle(failing, () => -1)).toBeNull();
    expect(await readIdle(failing, () => Number.NaN)).toBeNull();
    expect(
      await readIdle(failing, () => {
        throw new Error("boom");
      }),
    ).toBeNull();
    expect(await readIdle(failing, undefined)).toBeNull();
  });
});

describe("runPmset", () => {
  it("成功：返回 ok + stdout，固定调 /usr/bin/pmset，带超时", async () => {
    const execFile = vi.fn((cmd: string, args: string[], opts: { timeout?: number }, cb: (e: unknown, out: string) => void) => {
      cb(null, "OUT");
    });
    const r = await runPmset(execFile, ["-g", "assertions"]);
    expect(r).toEqual({ ok: true, stdout: "OUT" });
    expect(execFile).toHaveBeenCalledWith("/usr/bin/pmset", ["-g", "assertions"], { timeout: 5000 }, expect.any(Function));
  });

  it("命令出错 / execFile 同步抛：都返回 ok:false，不抛", async () => {
    const failing = vi.fn((_c: string, _a: string[], _o: unknown, cb: (e: unknown, out: string) => void) => {
      cb(new Error("exit 1"), "");
    });
    expect(await runPmset(failing, ["displaysleepnow"])).toEqual({ ok: false, stdout: "" });
    const throwing = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(await runPmset(throwing, ["displaysleepnow"])).toEqual({ ok: false, stdout: "" });
  });
});

describe("接线契约（源码）", () => {
  const main = read("electron-app/main.js");
  const mod = read("electron-app/lock-display-off.mjs");

  it("main.js：引入模块；锁屏 / 解锁事件都接到它；传入本进程 pid、系统空闲时间、日志", () => {
    expect(main).toMatch(/from "\.\/lock-display-off\.mjs"/);
    expect(main).toMatch(/createLockDisplayOff\(\{[\s\S]*?pid: process\.pid[\s\S]*?\}\)/);
    expect(main).toMatch(/isLockDisplayOffEnabled\(process\.env, process\.platform\)/);
    expect(main).toMatch(/readIdle: \(\) => readIdle\(execFile, \(\) => powerMonitor\.getSystemIdleTime\(\)\)/);
    expect(main).toMatch(/powerMonitor\.on\("lock-screen", \(\) => lockDisplayOff\.onLock\(\)\)/);
    expect(main).toMatch(/powerMonitor\.on\("unlock-screen", \(\) => lockDisplayOff\.onUnlock\(\)\)/);
  });

  it("main.js：注册放在 try/catch 里（注册失败只记日志、不影响启动）", () => {
    const i = main.indexOf("createLockDisplayOff({");
    const catchAt = main.indexOf("锁屏熄屏监听注册失败", i);
    expect(i).toBeGreaterThan(0);
    expect(catchAt).toBeGreaterThan(i);
  });

  it("不碰页面：模块与 main.js 都不引用内置浏览器的暂停 / 静音 / 后台节流手段", () => {
    const wiring = main.slice(main.indexOf("createLockDisplayOff({") - 200, main.indexOf("锁屏熄屏监听注册失败") + 100);
    for (const src of [stripComments(mod), stripComments(wiring)]) {
      expect(src).not.toMatch(/\.pause\(|setAudioMuted|setBackgroundThrottling|executeJavaScript|setVisible\(/);
    }
    expect(main).not.toMatch(/background-media|isBackgroundMediaAllowed|notifyPresenceChanged/);
  });

  it("只用熄屏命令；没有「阻止显示器休眠」的调用", () => {
    expect(mod).toMatch(/displaysleepnow/);
    expect(mod).not.toMatch(/prevent-display-sleep/);
    expect(mod).toMatch(/\/usr\/bin\/pmset/); // 绝对路径，不走 PATH
  });
});
