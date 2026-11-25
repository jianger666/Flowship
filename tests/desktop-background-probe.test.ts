/**
 * 「测试后台操作」探针（electron-app/desktop/background-probe.mjs）：假驱动 + 假后台驱动 + 假 spawn + 虚拟时钟。
 *
 * 这条探针会在用户的真机上真的锁屏、往一个窗口里发键盘消息，所以钉死：
 * - 安全：打字之前必须确认靶子窗口在点击位置的最上层——被别的窗口盖住（或那个位置没有窗口）就一个字都不打、一次点击都不发；
 *   打的字只有固定的探针标记，没有任何用户内容；全过程不碰真实键鼠 / 密码
 * - 顺序：倒计时 → 开靶子 → 锁屏 → 截图 → 输入 → 清理（失败 / 中止 / 抛异常，清理一律执行：关窗口、杀进程、清后台状态）
 * - 诚实：每一步结果如实上报；截图失败不妨碍继续测输入（两件事分开说），锁屏没生效 / 又被解锁就不去测（那样测不出锁屏结果）
 * - 清理自己出错不影响结果
 */
import { describe, expect, it, vi } from "vitest";

import {
  PROBE_LIMITS,
  createBackgroundProbe,
  describeProblemWindows,
  describeStatusCounts,
} from "../electron-app/desktop/background-probe.mjs";

const MARKER = "flowship-probe-abcd1234";
const HWND = 0x1234n;
const TARGET = { hwnd: HWND, x: 100, y: 100, width: 600, height: 400 };

type Win = { className: string; processName: string; x: number; y: number; width: number; height: number; status: string };

type Opts = {
  /** 靶子窗口出现的时刻（相对开始，ms）；Infinity = 永远不出现 */
  appearAfterMs?: number;
  className?: string;
  spawnThrows?: boolean;
  spawnErrorEvent?: boolean;
  lockThrows?: boolean;
  lockNoEffect?: boolean;
  /** 倒计时结束时电脑已经是锁屏状态 */
  lockedAtStart?: boolean;
  /** 锁屏稳定期间用户回来解锁了 */
  unlockDuringSettle?: boolean;
  captureStatus?: string;
  captureThrows?: boolean;
  captureOmitTarget?: boolean;
  otherWindows?: Win[];
  /** 点击位置上最上层是别的窗口 / 没有窗口 */
  covered?: "other" | "none";
  clickThrows?: boolean;
  inputWorks?: boolean;
  abortAfterCountdown?: boolean;
  abortAfterSettle?: boolean;
  enumerateThrows?: boolean;
  isScreenLockedThrows?: boolean;
  closeThrows?: boolean;
  killThrows?: boolean;
  resetThrows?: boolean;
  onStepThrows?: boolean;
};

const make = (opts: Opts = {}) => {
  let clock = 0;
  const log: string[] = [];
  const typed: string[] = [];
  const world = {
    locked: opts.lockedAtStart === true,
    title: MARKER,
    pendingTitle: null as string | null,
  };
  const abortFlags = { countdownDone: false, settleDone: false };

  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
    if (ms === PROBE_LIMITS.countdownMs) abortFlags.countdownDone = true;
    if (ms === PROBE_LIMITS.lockSettleMs) {
      abortFlags.settleDone = true;
      if (opts.unlockDuringSettle) world.locked = false;
    }
  });

  const appearAt = opts.appearAfterMs ?? 0;
  const targetVisible = () => clock >= appearAt;
  const className = opts.className ?? "ConsoleWindowClass";

  const driver = {
    lockScreen: vi.fn(async () => {
      log.push("lockScreen");
      if (opts.lockThrows) throw new Error("LockWorkStation 被策略禁用");
      if (!opts.lockNoEffect) world.locked = true;
    }),
    isScreenLocked: vi.fn(() => {
      // 发出锁屏命令之后才炸：此时靶子窗口已经开了，能验证「意外异常时清理照做」
      if (opts.isScreenLockedThrows && log.includes("lockScreen")) throw new Error("读锁屏状态炸了");
      return world.locked;
    }),
  };

  const child = {
    once: vi.fn((ev: string, fn: (err: Error) => void) => {
      if (ev === "error" && opts.spawnErrorEvent) fn(new Error("spawn conhost.exe ENOENT"));
    }),
    kill: vi.fn(() => {
      log.push("kill");
      if (opts.killThrows) throw new Error("进程已经退出");
    }),
  };
  // 不声明参数：vi.fn 照样记录调用实参（mock.calls），测试里按需断言
  const spawn = vi.fn(() => {
    log.push("spawn");
    if (opts.spawnThrows) throw new Error("spawn EPERM");
    return child;
  });

  const windows = (): Win[] => {
    const others: Win[] = opts.otherWindows ?? [
      { className: "Notepad", processName: "notepad.exe", x: 0, y: 0, width: 300, height: 200, status: "ok" },
      { className: "Chrome_WidgetWin_1", processName: "chrome.exe", x: 50, y: 50, width: 800, height: 600, status: "blank" },
    ];
    const mine: Win = { className, processName: "conhost.exe", x: TARGET.x, y: TARGET.y, width: TARGET.width, height: TARGET.height, status: opts.captureStatus ?? "ok" };
    return opts.captureOmitTarget ? others : [mine, ...others];
  };

  const background = {
    findWindowsByTitle: vi.fn((text: string) => {
      if (opts.enumerateThrows) throw new Error("EnumWindows 失败");
      return targetVisible() && world.title.includes(text) ? [{ ...TARGET }] : [];
    }),
    classOf: vi.fn(() => className),
    capture: vi.fn(async () => {
      log.push("capture");
      if (opts.captureThrows) throw new Error("PrintWindow 全部失败");
      return { windows: windows() };
    }),
    windowAt: vi.fn(() => {
      if (opts.covered === "none") return null;
      if (opts.covered === "other") return { hwnd: 0x9999n };
      return { hwnd: HWND };
    }),
    click: vi.fn(async (x: number, y: number) => {
      log.push(`click ${x},${y}`);
      if (opts.clickThrows) throw new Error("窗口没有接收消息");
    }),
    typeText: vi.fn(async (text: string) => {
      log.push("type");
      typed.push(text);
      if (opts.inputWorks !== false && text.startsWith("title ")) world.pendingTitle = text.slice("title ".length);
    }),
    keyCombo: vi.fn(async (combo: { mods: string[]; key: string }) => {
      log.push(`key ${[...combo.mods, combo.key].join("+")}`);
      if (combo.key === "enter" && world.pendingTitle !== null) {
        world.title = world.pendingTitle;
        world.pendingTitle = null;
      }
      return {};
    }),
    readTitle: vi.fn(() => world.title),
    closeWindow: vi.fn(() => {
      log.push("close");
      if (opts.closeThrows) throw new Error("窗口已经关闭");
    }),
    reset: vi.fn(() => {
      log.push("reset");
      if (opts.resetThrows) throw new Error("reset 失败");
    }),
  };

  const probe = createBackgroundProbe({
    driver: driver as never,
    background: background as never,
    spawn: spawn as never,
    sleep,
    now: () => clock,
    randomId: () => "abcd1234",
    log: (m: string) => log.push(`LOG ${m}`),
  });

  const steps: Array<{ name: string; ok: boolean; ms: number; detail?: string }> = [];
  const run = () =>
    probe.run({
      shouldAbort: () => (opts.abortAfterCountdown && abortFlags.countdownDone && !abortFlags.settleDone) === true || (opts.abortAfterSettle === true && abortFlags.settleDone),
      onStep: (s) => {
        if (opts.onStepThrows) throw new Error("UI 回调炸了");
        steps.push(s);
      },
    });
  return { run, driver, background, spawn, child, sleep, log, typed, steps, world, clockNow: () => clock };
};

const stepNames = (r: { steps: Array<{ name: string }> }) => r.steps.map((s) => s.name);
const stepOf = (r: { steps: Array<{ name: string; ok: boolean; ms: number; detail?: string }> }, name: string) => r.steps.find((s) => s.name === name);

describe("成功路径", () => {
  it("倒计时 → 开靶子 → 锁屏 → 截图 → 输入 → 清理，全部 ok", async () => {
    const fx = make();
    const r = await fx.run();
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("error");
    expect(stepNames(r)).toEqual(["countdown", "window", "lock", "capture", "input"]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    // 每一步都实时回调了 onStep，顺序一致
    expect(fx.steps.map((s) => s.name)).toEqual(stepNames(r));
  });

  it("操作顺序：先开靶子、再锁屏；锁屏之后才截图、点击、打字；最后清理", async () => {
    const fx = make();
    await fx.run();
    const order = fx.log.filter((l) => !l.startsWith("LOG"));
    expect(order).toEqual(["spawn", "lockScreen", "capture", "click 400,300", "type", "key enter", "close", "kill", "reset"]);
  });

  it("靶子是经典 conhost 窗口（不让「Windows 终端」接管），标题带随机标记", async () => {
    const fx = make();
    await fx.run();
    expect(fx.spawn).toHaveBeenCalledTimes(1);
    expect(fx.spawn.mock.calls[0]).toEqual(["conhost.exe", ["cmd.exe", "/k", "title", MARKER], { windowsHide: false, stdio: "ignore" }]);
  });

  it("点的是靶子正中间；打的字只有固定的探针标记 + 回车，没有任何别的内容", async () => {
    const fx = make();
    await fx.run();
    expect(fx.background.click).toHaveBeenCalledWith(400, 300);
    expect(fx.typed).toEqual([`title ${MARKER}-ok`]);
    expect(fx.background.keyCombo).toHaveBeenCalledTimes(1);
    expect(fx.background.keyCombo).toHaveBeenCalledWith({ mods: [], key: "enter" });
  });

  it("截图步骤的说明：窗口总数、各状态数、靶子状态、画不出来的应用（只有进程名，没有标题）", async () => {
    const fx = make();
    const r = await fx.run();
    const detail = stepOf(r, "capture")!.detail!;
    expect(detail).toContain("共 3 个窗口");
    expect(detail).toContain("ok 2");
    expect(detail).toContain("blank 1");
    expect(detail).toContain("测试窗口：ok");
    expect(detail).toContain("chrome.exe=blank");
  });

  it("窗口步骤的说明里记下类名，经典控制台窗口明说", async () => {
    const fx = make();
    const r = await fx.run();
    expect(stepOf(r, "window")!.detail).toContain("ConsoleWindowClass");
  });

  it("倒计时用了 countdownMs；ms 都是非负数", async () => {
    const fx = make();
    const r = await fx.run();
    expect(stepOf(r, "countdown")!.ms).toBe(PROBE_LIMITS.countdownMs);
    expect(r.steps.every((s) => s.ms >= 0)).toBe(true);
  });
});

describe("开靶子窗口", () => {
  it("窗口晚一点才出现（cmd 启动慢）：等到了就继续", async () => {
    const fx = make({ appearAfterMs: PROBE_LIMITS.countdownMs + 2000 });
    const r = await fx.run();
    expect(r.ok).toBe(true);
    expect(stepOf(r, "window")!.ms).toBeGreaterThanOrEqual(2000);
  });

  it("一直不出现：失败，说明可能的原因；没有锁屏；该关的关、该杀的杀", async () => {
    const fx = make({ appearAfterMs: Infinity });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没能打开测试窗口");
    expect(r.error).toContain("没有锁屏");
    expect(stepOf(r, "window")).toMatchObject({ ok: false, detail: expect.stringContaining("安全软件") });
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(fx.child.kill).toHaveBeenCalledTimes(1);
    expect(fx.background.click).not.toHaveBeenCalled();
    expect(fx.typed).toEqual([]);
  });

  it("spawn 同步抛错：窗口步骤失败并带原因；没有锁屏、没有 child 可杀", async () => {
    const fx = make({ spawnThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "window")).toMatchObject({ ok: false, detail: expect.stringContaining("spawn EPERM") });
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(fx.child.kill).not.toHaveBeenCalled();
  });

  it("spawn 异步 error 事件（找不到 conhost.exe）：同样失败，不干等 8 秒", async () => {
    const fx = make({ spawnErrorEvent: true, appearAfterMs: Infinity });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "window")!.detail).toContain("ENOENT");
    expect(stepOf(r, "window")!.ms).toBeLessThan(PROBE_LIMITS.windowWaitMs);
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
  });

  it("枚举窗口抛错：窗口步骤失败，提示后台组件有问题；不锁屏", async () => {
    const fx = make({ enumerateThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "window")!.detail).toContain("枚举窗口失败");
    expect(r.error).toContain("枚举窗口失败");
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
  });

  it("窗口类名不是 ConsoleWindowClass（被 Windows 终端接管了）：照常继续，但说明里提醒输入结果可能不适用", async () => {
    const fx = make({ className: "CASCADIA_HOSTING_WINDOW_CLASS" });
    const r = await fx.run();
    expect(stepOf(r, "window")).toMatchObject({ ok: true, detail: expect.stringContaining("不是经典控制台窗口") });
    expect(stepOf(r, "window")!.detail).toContain("CASCADIA_HOSTING_WINDOW_CLASS");
    expect(stepNames(r)).toContain("input");
  });
});

describe("倒计时 / 锁屏", () => {
  it("倒计时结束时 AI 已经在用电脑：取消，不开靶子、不锁屏", async () => {
    const fx = make({ abortAfterCountdown: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("AI 开始使用电脑了");
    expect(fx.spawn).not.toHaveBeenCalled();
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
  });

  it("倒计时结束时电脑已经是锁屏状态：取消，不开靶子", async () => {
    const fx = make({ lockedAtStart: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("已经被锁屏了");
    expect(fx.spawn).not.toHaveBeenCalled();
  });

  it("锁屏命令抛错：失败，清理照做（靶子要关）", async () => {
    const fx = make({ lockThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("锁屏命令失败");
    expect(stepOf(r, "lock")).toMatchObject({ ok: false, detail: expect.stringContaining("LockWorkStation") });
    expect(fx.background.closeWindow).toHaveBeenCalledWith(HWND);
    expect(fx.child.kill).toHaveBeenCalledTimes(1);
    expect(fx.background.capture).not.toHaveBeenCalled();
  });

  it("发了锁屏命令但电脑没进入锁屏：失败；不截图、不输入", async () => {
    const fx = make({ lockNoEffect: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有进入锁屏状态");
    expect(stepOf(r, "lock")!.ok).toBe(false);
    expect(stepOf(r, "lock")!.ms).toBeGreaterThanOrEqual(PROBE_LIMITS.lockWaitMs);
    expect(fx.background.capture).not.toHaveBeenCalled();
    expect(fx.background.click).not.toHaveBeenCalled();
    expect(fx.child.kill).toHaveBeenCalledTimes(1);
  });

  it("锁屏稳定期间用户回来解锁了：中止——这样测不出锁屏状态下的结果；不截图、不打字", async () => {
    const fx = make({ unlockDuringSettle: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("又被解开了");
    expect(stepOf(r, "still_locked")).toMatchObject({ ok: false });
    expect(fx.background.capture).not.toHaveBeenCalled();
    expect(fx.background.click).not.toHaveBeenCalled();
    expect(fx.typed).toEqual([]);
    expect(fx.background.closeWindow).toHaveBeenCalled();
  });

  it("锁屏稳定期间 AI 开始用电脑了：中止，不截图、不打字", async () => {
    const fx = make({ abortAfterSettle: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("AI 开始使用电脑了");
    expect(fx.background.capture).not.toHaveBeenCalled();
    expect(fx.typed).toEqual([]);
  });
});

describe("锁屏状态下的截图", () => {
  it("靶子窗口画面是空白：截图步骤失败 + 错误里说明；输入照样测（两件事分开说）", async () => {
    const fx = make({ captureStatus: "blank" });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "capture")).toMatchObject({ ok: false, detail: expect.stringContaining("测试窗口：blank") });
    expect(stepOf(r, "input")!.ok).toBe(true);
    expect(r.error).toContain("截图没有成功（状态：blank）");
    expect(r.error).not.toContain("打字没有生效");
  });

  it("合成截图抛错：截图步骤失败并带原因；输入照样测", async () => {
    const fx = make({ captureThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "capture")).toMatchObject({ ok: false, detail: expect.stringContaining("PrintWindow 全部失败") });
    expect(stepOf(r, "input")!.ok).toBe(true);
  });

  it("截图结果里找不到靶子（状态 missing）：截图步骤失败", async () => {
    const fx = make({ captureOmitTarget: true });
    const r = await fx.run();
    expect(stepOf(r, "capture")).toMatchObject({ ok: false, detail: expect.stringContaining("测试窗口：missing") });
    expect(r.error).toContain("状态：missing");
  });

  it("没有任何窗口也不炸：说明里写「没有窗口」", async () => {
    const fx = make({ captureOmitTarget: true, otherWindows: [] });
    const r = await fx.run();
    expect(stepOf(r, "capture")!.detail).toContain("没有窗口");
  });
});

describe("锁屏状态下的输入：先确认靶子在最上层，否则一个字都不打", () => {
  it("点击位置最上层是别的窗口：不点击、不打字、不按键，输入步骤失败并说明原因", async () => {
    const fx = make({ covered: "other" });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "input")).toMatchObject({ ok: false, detail: expect.stringContaining("被别的窗口盖住") });
    expect(fx.background.click).not.toHaveBeenCalled();
    expect(fx.background.typeText).not.toHaveBeenCalled();
    expect(fx.background.keyCombo).not.toHaveBeenCalled();
    expect(fx.typed).toEqual([]);
  });

  it("点击位置上没有任何窗口：同样不输入", async () => {
    const fx = make({ covered: "none" });
    const r = await fx.run();
    expect(stepOf(r, "input")!.ok).toBe(false);
    expect(fx.background.click).not.toHaveBeenCalled();
    expect(fx.background.typeText).not.toHaveBeenCalled();
  });

  it("点击抛错：输入步骤失败并带原因；之后的打字 / 回车不再发", async () => {
    const fx = make({ clickThrows: true });
    const r = await fx.run();
    expect(stepOf(r, "input")).toMatchObject({ ok: false, detail: expect.stringContaining("输入失败") });
    expect(stepOf(r, "input")!.detail).toContain("窗口没有接收消息");
    expect(fx.background.typeText).not.toHaveBeenCalled();
    expect(fx.background.keyCombo).not.toHaveBeenCalled();
  });

  it("消息发出去了但窗口标题没变（窗口没反应）：输入步骤失败，等够 titleWaitMs 才下结论", async () => {
    const fx = make({ inputWorks: false });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(stepOf(r, "input")).toMatchObject({ ok: false, detail: expect.stringContaining("窗口没有反应") });
    expect(stepOf(r, "input")!.ms).toBeGreaterThanOrEqual(PROBE_LIMITS.titleWaitMs);
    expect(r.error).toContain("打字没有生效");
    expect(r.error).not.toContain("截图没有成功");
  });

  it("截图和输入都失败：错误里两件事都说", async () => {
    const fx = make({ captureStatus: "failed", inputWorks: false });
    const r = await fx.run();
    expect(r.error).toContain("截图没有成功（状态：failed）");
    expect(r.error).toContain("打字没有生效");
  });

  it("读标题时轮询：标题晚一点才变也算成功", async () => {
    const fx = make();
    let reads = 0;
    fx.background.readTitle.mockImplementation(() => {
      reads += 1;
      return reads >= 4 ? `${MARKER}-ok` : MARKER;
    });
    const r = await fx.run();
    expect(stepOf(r, "input")!.ok).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(4);
  });
});

describe("异常 / 清理", () => {
  it("意外异常（读锁屏状态炸了）：兜成一条错误，清理照做", async () => {
    const fx = make({ isScreenLockedThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("测试过程中出错");
    expect(r.error).toContain("读锁屏状态炸了");
    expect(stepOf(r, "error")).toMatchObject({ ok: false });
    expect(fx.background.closeWindow).toHaveBeenCalledWith(HWND);
    expect(fx.child.kill).toHaveBeenCalledTimes(1);
    expect(fx.background.reset).toHaveBeenCalledTimes(1);
  });

  it("清理自己出错（关窗口 / 杀进程 / 清状态都抛）：不影响测试结果", async () => {
    const fx = make({ closeThrows: true, killThrows: true, resetThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(true);
    expect(fx.background.closeWindow).toHaveBeenCalled();
    expect(fx.child.kill).toHaveBeenCalled();
    expect(fx.background.reset).toHaveBeenCalled();
  });

  it("进度回调抛错：不影响探针", async () => {
    const fx = make({ onStepThrows: true });
    const r = await fx.run();
    expect(r.ok).toBe(true);
    expect(stepNames(r)).toEqual(["countdown", "window", "lock", "capture", "input"]);
  });

  it("成功时清理：先关窗口，等一小会儿再强杀进程（给 conhost 自己退出的机会）", async () => {
    const fx = make();
    await fx.run();
    expect(fx.sleep.mock.calls.some(([ms]) => ms === PROBE_LIMITS.cleanupGraceMs)).toBe(true);
    const order = fx.log.filter((l) => l === "close" || l === "kill");
    expect(order).toEqual(["close", "kill"]);
  });

  it("探针全程不碰电脑上别的东西：只用 lockScreen / 后台驱动 / spawn（没有任何真实键鼠入口）", async () => {
    const fx = make();
    await fx.run();
    const calledMethods = Object.entries(fx.background)
      .filter(([, fn]) => (fn as { mock?: { calls: unknown[] } }).mock && (fn as { mock: { calls: unknown[] } }).mock.calls.length > 0)
      .map(([name]) => name)
      .sort();
    expect(calledMethods).toEqual(["capture", "classOf", "click", "closeWindow", "findWindowsByTitle", "keyCombo", "readTitle", "reset", "typeText", "windowAt"].sort());
  });
});

describe("说明文字的辅助函数", () => {
  it("describeStatusCounts：各状态计数；空 → 没有窗口", () => {
    expect(describeStatusCounts([{ status: "ok" }, { status: "ok" }, { status: "blank" }])).toBe("ok 2、blank 1");
    expect(describeStatusCounts([])).toBe("没有窗口");
  });

  it("describeProblemWindows：只列画不出来的（blank / failed / timeout），skipped 不算；退回类名；最多 8 个", () => {
    expect(
      describeProblemWindows([
        { status: "ok", processName: "a.exe" },
        { status: "blank", processName: "chrome.exe" },
        { status: "skipped", processName: "huge.exe" },
        { status: "failed", processName: "", className: "Qt5QWindowIcon" },
        { status: "timeout", processName: "", className: "" },
      ]),
    ).toBe("chrome.exe=blank、Qt5QWindowIcon=failed、?=timeout");
    const many = Array.from({ length: 12 }, (_, i) => ({ status: "blank", processName: `app${i}.exe` }));
    expect(describeProblemWindows(many).split("、")).toHaveLength(8);
  });

  it("PROBE_LIMITS 是冻结的常量", () => {
    expect(Object.isFrozen(PROBE_LIMITS)).toBe(true);
  });
});
