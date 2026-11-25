/**
 * macOS 锁屏解锁器（electron-app/desktop/unlockers/darwin.mjs）——假 driver + 假钥匙串 + 虚拟时钟。
 *
 * 钉死的是「这一次解锁怎么做对、怎么停在原地」，每条都对应一个会让用户吃亏的后果：
 * - 只试一次、绝不重试：输错密码会触发账户锁定
 * - 不是锁屏 / 读不到 / 没辅助功能权限 / 用户自己刚解开：一个键都不按（权限缺失时事件会被静默丢弃，等于白输一次密码）
 * - 密码只用真实键码输入（锁屏界面不一定认 Unicode 事件），输入失败不按回车，且不会进步骤事件 / 返回值 / 错误信息
 * - 取消：每一步之前都检查；回车之后被取消，以「电脑实际是否解开」为准，免得上层漏掉「要锁回去」
 * - attempted：没真输过密码的失败不该触发冷却
 */
import { describe, expect, it, vi } from "vitest";

import { createDarwinUnlocker, UNLOCK_TIMING } from "../electron-app/desktop/unlockers/darwin.mjs";

const SECRET = "S3cret-Pass!";

type Step = { name: string; ok: boolean; ms: number };
type World = { locked: boolean | null };

const makeFixture = (
  opts: {
    locked?: boolean | null;
    unlockAfterEnter?: boolean;
    permitted?: boolean | undefined;
    secret?: string | null;
    keychainGetThrows?: string;
    keychainAvailable?: boolean;
    /** 键码输入抛错：true = 固定文案（不含密码）；函数 = 按入参造异常（造「把入参回显进错误」的毒化异常用） */
    typeThrows?: boolean | ((text: string) => unknown);
    /** 键码输入每个字符花多少毫秒（虚拟时钟）：真驱动的输入循环耗时随密码长度线性增长 */
    typeMsPerChar?: number;
    /** 预检（driver.canTypeKeys）抛错：按拿到的密码造异常 */
    canTypeThrows?: (secret: string) => unknown;
    /** keychain.set 抛错 / 返回失败：按入参造 */
    setThrows?: (password: string) => unknown;
    setResult?: (password: string) => { ok: boolean; error?: string };
    onSleep?: (ms: number, world: World, ctx: { abort: () => void }) => void;
    onMove?: (world: World) => void;
    onGet?: (ctx: { abort: () => void }) => void;
    onEnter?: (world: World, ctx: { abort: () => void }) => void;
    noInputPermittedApi?: boolean;
    /** 键码模式「打得出来」的判定（缺省全部打得出）；noCanTypeKeysApi 时驱动根本没有这个预检能力 */
    typeable?: (s: string) => boolean;
    noCanTypeKeysApi?: boolean;
    removeResult?: boolean;
  } = {},
) => {
  const world: World = { locked: opts.locked === undefined ? true : opts.locked };
  const ac = new AbortController();
  const ctx = { abort: () => ac.abort() };
  let clock = 0;
  const calls: string[] = [];

  const driver = {
    isScreenLocked: vi.fn(() => world.locked),
    inputPermitted: opts.noInputPermittedApi ? undefined : vi.fn(() => (opts.permitted === undefined ? true : opts.permitted)),
    canTypeKeys: opts.noCanTypeKeysApi
      ? undefined
      : vi.fn((s: string) => {
          if (opts.canTypeThrows) throw opts.canTypeThrows(s);
          return opts.typeable ? opts.typeable(s) : true;
        }),
    wakeDisplay: vi.fn(async () => {
      calls.push("wake");
    }),
    getPrimaryDisplay: vi.fn(() => ({ x: 0, y: 0, width: 1000, height: 600 })),
    mouseMove: vi.fn(async (x: number, y: number) => {
      calls.push(`move:${x},${y}`);
      opts.onMove?.(world);
    }),
    typeText: vi.fn(async (text: string, o?: { mode?: string }) => {
      calls.push(`type:${text.length}:${o?.mode}`);
      clock += text.length * (opts.typeMsPerChar ?? 0);
      if (typeof opts.typeThrows === "function") throw opts.typeThrows(text);
      if (opts.typeThrows) throw new Error("键码输入模式只支持英文字母、数字和常见符号");
    }),
    keyCombo: vi.fn(async (c: { key: string }) => {
      calls.push(`key:${c.key}`);
      if (c.key === "enter") {
        if (opts.unlockAfterEnter !== false) world.locked = false;
        opts.onEnter?.(world, ctx);
      }
    }),
    lockScreen: vi.fn(async (o?: { method?: string }) => {
      calls.push(o?.method ? `lockScreen:${o.method}` : "lockScreen");
      world.locked = true;
    }),
  };
  const keychain = {
    available: vi.fn(() => opts.keychainAvailable !== false),
    unavailableReason: vi.fn(() => "钥匙串组件加载失败"),
    has: vi.fn(() => (opts.secret === undefined ? true : opts.secret !== null)),
    set: vi.fn((password: string): { ok: boolean; error?: string } => {
      if (opts.setThrows) throw opts.setThrows(password);
      return opts.setResult ? opts.setResult(password) : { ok: true };
    }),
    get: vi.fn(() => {
      opts.onGet?.(ctx);
      if (opts.keychainGetThrows) throw new Error(opts.keychainGetThrows);
      return opts.secret === undefined ? SECRET : opts.secret;
    }),
    remove: vi.fn(() => opts.removeResult !== false),
  };
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
    opts.onSleep?.(ms, world, ctx);
  });
  const unlocker = createDarwinUnlocker({ driver: driver as never, keychain, now: () => clock, sleep });
  const steps: Step[] = [];
  const run = (signal: AbortSignal | undefined = ac.signal) => unlocker.unlock({ signal, onStep: (s: Step) => steps.push(s) });
  return { world, driver, keychain, sleep, unlocker, steps, calls, run, ac, getClock: () => clock };
};

const NO_INPUT = (calls: string[]) => calls.filter((c) => c.startsWith("type:") || c.startsWith("key:"));

describe("成功路径", () => {
  it("唤醒 → 微移鼠标 → 真实键码输密码 → 回车 → 确认解开；步骤顺序固定", async () => {
    const fx = makeFixture();
    const r = await fx.run();
    expect(r).toEqual({ ok: true, attempted: true });
    expect(fx.steps.map((s) => s.name)).toEqual(["check", "wake", "reveal", "credential", "type", "submit", "verify", "settle"]);
    expect(fx.steps.every((s) => s.ok)).toBe(true);
    expect(fx.calls).toEqual(["wake", "move:500,300", `type:${SECRET.length}:keys`, "key:enter"]);
    // 输进去的就是保存的密码，且用的是键码模式
    expect(fx.driver.typeText).toHaveBeenCalledTimes(1);
    expect(fx.driver.typeText).toHaveBeenCalledWith(SECRET, { mode: "keys" });
  });

  it("密码不进步骤事件 / 返回值", async () => {
    const fx = makeFixture();
    const r = await fx.run();
    expect(JSON.stringify([fx.steps, r])).not.toContain(SECRET);
    // 步骤事件只有 name / ok / ms 三个字段
    for (const s of fx.steps) expect(Object.keys(s).sort()).toEqual(["name", "ok", "ms"].sort());
  });

  // 第三轮评审：输入循环的耗时随密码长度线性增长，而步骤耗时会原样进审计文件 / 设置页测试结果 / 导出的诊断包——
  // type 那一步报真实耗时 = 把开机密码的长度送了出去
  it("输密码那一步不报耗时：不同长度的密码、同样的步骤事件（其余步骤照常报耗时）", async () => {
    const short = makeFixture({ secret: "abcd", typeMsPerChar: 50 });
    const long = makeFixture({ secret: "a".repeat(64), typeMsPerChar: 50 });
    await short.run();
    await long.run();
    // 虚拟时钟确实被输入循环推进了（长密码花的时间更长）——否则下面的断言是空转
    expect(long.getClock() - short.getClock()).toBeGreaterThanOrEqual(60 * 50);
    expect(short.steps.find((s) => s.name === "type")).toEqual({ name: "type", ok: true, ms: 0 });
    expect(long.steps.find((s) => s.name === "type")).toEqual({ name: "type", ok: true, ms: 0 });
    // 整份步骤事件（含每一步的耗时）与密码长度无关
    expect(long.steps).toEqual(short.steps);
    // 与密码无关的步骤仍然报真实耗时（排障要用）
    expect(short.steps.some((s) => s.name !== "type" && s.ms > 0)).toBe(true);
  });

  it("没有 inputPermitted 接口（Windows 风格的驱动）：不检查权限，照常", async () => {
    const fx = makeFixture({ noInputPermittedApi: true });
    await expect(fx.run()).resolves.toMatchObject({ ok: true });
  });

  it("步骤回调自己抛错不影响解锁", async () => {
    const fx = makeFixture();
    const r = await fx.unlocker.unlock({
      signal: fx.ac.signal,
      onStep: () => {
        throw new Error("回调炸了");
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe("输入之前的拒绝：一个键都不按", () => {
  it("当前不是锁屏：NOT_LOCKED，attempted=false", async () => {
    const fx = makeFixture({ locked: false });
    expect(await fx.run()).toMatchObject({ ok: false, code: "NOT_LOCKED", attempted: false });
    expect(fx.calls).toEqual([]);
  });

  it("读不到锁屏状态：为安全起见不介入", async () => {
    const fx = makeFixture({ locked: null });
    expect(await fx.run()).toMatchObject({ ok: false, attempted: false });
    expect(fx.calls).toEqual([]);
  });

  it("没有辅助功能权限：NEED_PERMISSION，连唤醒都不做", async () => {
    const fx = makeFixture({ permitted: false });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "NEED_PERMISSION", attempted: false });
    expect(r.error).toContain("辅助功能");
    expect(fx.calls).toEqual([]);
  });

  it("钥匙串组件不可用：失败并说明原因", async () => {
    const fx = makeFixture({ keychainAvailable: false });
    expect(await fx.run()).toMatchObject({ ok: false, error: expect.stringContaining("钥匙串"), attempted: false });
    expect(fx.calls).toEqual([]);
  });

  it("钥匙串里没有密码：NO_CREDENTIAL，不输入", async () => {
    const fx = makeFixture({ secret: null });
    expect(await fx.run()).toMatchObject({ ok: false, code: "NO_CREDENTIAL", attempted: false });
    expect(NO_INPUT(fx.calls)).toEqual([]);
  });

  it("读钥匙串抛错（ACL 失效等）：错误原样带回，不输入", async () => {
    const fx = makeFixture({ keychainGetThrows: "钥匙串需要你本人授权才能读取" });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, attempted: false });
    expect(r.error).toContain("钥匙串需要你本人授权");
    expect(NO_INPUT(fx.calls)).toEqual([]);
  });

  it("微移鼠标之后发现电脑已被解锁（用户自己解开了）：USER_PRESENT，不输密码、不按回车", async () => {
    const fx = makeFixture({
      onMove: (w) => {
        w.locked = false;
      },
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "USER_PRESENT", attempted: false });
    expect(NO_INPUT(fx.calls)).toEqual([]);
    expect(fx.keychain.get).not.toHaveBeenCalled(); // 连密码都没取
  });
});

describe("只试一次，绝不重试", () => {
  it("键码输入抛错：失败、attempted=true、没有按回车（错误文字不含密码的断言见下面「毒化错误」一组，这里用固定文案只看流程）", async () => {
    const fx = makeFixture({ typeThrows: true });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    // 固定文案原样带回（不含密码的错误不该被改动）
    expect(r.error).toContain("键码输入模式只支持英文字母、数字和常见符号");
    expect(fx.calls).not.toContain("key:enter");
    expect(fx.driver.typeText).toHaveBeenCalledTimes(1);
  });

  it("提交后仍是锁屏：失败；密码只输一次、回车只按一次；等满超时才放弃", async () => {
    const fx = makeFixture({ unlockAfterEnter: false });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain("仍然是锁屏");
    expect(fx.driver.typeText).toHaveBeenCalledTimes(1);
    expect(fx.driver.keyCombo).toHaveBeenCalledTimes(1);
    expect(fx.getClock()).toBeGreaterThanOrEqual(UNLOCK_TIMING.verifyTimeoutMs);
    expect(fx.steps.find((s) => s.name === "verify")).toMatchObject({ ok: false });
  });

  it("刚解开又弹回锁屏（settle 复核失败）：算失败", async () => {
    const fx = makeFixture({
      onSleep: (ms, w) => {
        if (ms === UNLOCK_TIMING.settleMs) w.locked = true;
      },
    });
    expect(await fx.run()).toMatchObject({ ok: false, code: "UNLOCK_FAILED", error: expect.stringContaining("又回到了锁屏") });
  });
});

describe("取消", () => {
  it("开始前就已取消：什么都不做", async () => {
    const fx = makeFixture();
    fx.ac.abort();
    expect(await fx.run()).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(fx.calls).toEqual([]);
    // 连只读的状态检查都不做（钉住「取消检查在第一步之前」）
    expect(fx.driver.isScreenLocked).not.toHaveBeenCalled();
  });

  it("唤醒之后取消：不输入", async () => {
    const fx = makeFixture({
      onSleep: (_ms, _w, c) => c.abort(),
    });
    expect(await fx.run()).toMatchObject({ ok: false, code: "CANCELLED", attempted: false });
    expect(NO_INPUT(fx.calls)).toEqual([]);
  });

  it("取到密码之后、输入之前取消：不输入，attempted=false", async () => {
    const fx = makeFixture({ onGet: (c) => c.abort() });
    expect(await fx.run()).toMatchObject({ ok: false, code: "CANCELLED", attempted: false });
    expect(NO_INPUT(fx.calls)).toEqual([]);
  });

  it("回车之后取消，但电脑已经解开了：以实际状态为准，返回 ok（上层据此锁回去）", async () => {
    const fx = makeFixture({ onEnter: (_w, c) => c.abort() });
    expect(await fx.run()).toMatchObject({ ok: true });
  });

  it("回车之后取消，等满验证时间仍没解开：CANCELLED（不是 ok）；等的是「回车后 verifyTimeoutMs」，不是只给取消时刻起的 2 秒", async () => {
    const fx = makeFixture({ unlockAfterEnter: false, onEnter: (_w, c) => c.abort() });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "CANCELLED", attempted: true });
    expect(fx.getClock()).toBeGreaterThanOrEqual(UNLOCK_TIMING.verifyTimeoutMs);
  });

  it("回车之后取消，宽限期内刚好解开：返回 ok（CANCELLED_AFTER_UNLOCK）", async () => {
    const fx: ReturnType<typeof makeFixture> = makeFixture({
      unlockAfterEnter: false,
      onEnter: (_w, c) => c.abort(),
      // 回车之后的第一次等待（取消宽限期里的轮询）期间，电脑解开了
      onSleep: (_ms, w) => {
        if (fx.calls.includes("key:enter")) w.locked = false;
      },
    });
    expect(await fx.run()).toMatchObject({ ok: true, code: "CANCELLED_AFTER_UNLOCK" });
  });

  // 第二轮评审 P1-4：以前取消后只再看 cancelGraceMs（2 秒）。慢机器 / FileVault 下解锁要 3~8 秒，取消落在这段里时
  // 2 秒后判「还锁着」→ 上层当它没解开、不锁回去 → 几秒后电脑自己解开，用户不在场、没遮罩、没人管
  it("回车之后取消，电脑慢了几秒（超过 2 秒宽限、未超验证时间）才解开：仍判已解开 ok，上层才知道要锁回去", async () => {
    const SLOW_UNLOCK_AT = 5000; // 回车后 5 秒才解开
    let enterAt = -1;
    const fx: ReturnType<typeof makeFixture> = makeFixture({
      unlockAfterEnter: false,
      onEnter: (_w, c) => {
        enterAt = fx.getClock();
        c.abort();
      },
      onSleep: (_ms, w) => {
        if (enterAt >= 0 && fx.getClock() - enterAt >= SLOW_UNLOCK_AT) w.locked = false;
      },
    });
    expect(SLOW_UNLOCK_AT).toBeGreaterThan(UNLOCK_TIMING.cancelGraceMs);
    expect(SLOW_UNLOCK_AT).toBeLessThan(UNLOCK_TIMING.verifyTimeoutMs);
    expect(await fx.run()).toMatchObject({ ok: true, code: "CANCELLED_AFTER_UNLOCK", attempted: true });
  });

  it("取消发生在验证进行到一半（回车后 3 秒）、电脑 6.5 秒时才解开：取消时刻起的 2 秒（5 秒）不够，要等满回车后的验证窗口（8 秒）", async () => {
    let enterAt = -1;
    const fx: ReturnType<typeof makeFixture> = makeFixture({
      unlockAfterEnter: false,
      onEnter: () => {
        enterAt = fx.getClock();
      },
      onSleep: (_ms, w, c) => {
        if (enterAt < 0) return;
        const since = fx.getClock() - enterAt;
        if (since >= 3000) c.abort();
        if (since >= 6500) w.locked = false;
      },
    });
    expect(await fx.run()).toMatchObject({ ok: true, code: "CANCELLED_AFTER_UNLOCK", attempted: true });
  });

  it("取消得很晚（回车后 7.5 秒）时，取消时刻起的 2 秒宽限比验证窗口更晚到期：以更晚的为准（9 秒解开也认）", async () => {
    let enterAt = -1;
    const fx: ReturnType<typeof makeFixture> = makeFixture({
      unlockAfterEnter: false,
      onEnter: () => {
        enterAt = fx.getClock();
      },
      onSleep: (_ms, w, c) => {
        if (enterAt < 0) return;
        const since = fx.getClock() - enterAt;
        if (since >= 7500) c.abort();
        if (since >= 9000) w.locked = false; // 取消后又过了 1.5 秒才解开：仍在「取消时刻起 2 秒」之内
      },
    });
    expect(await fx.run()).toMatchObject({ ok: true, code: "CANCELLED_AFTER_UNLOCK" });
  });
});

describe("锁屏与凭据透传", () => {
  it("lock：调用驱动锁屏；失败时返回中文原因", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.lock()).resolves.toEqual({ ok: true });
    expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);

    fx.driver.lockScreen.mockRejectedValueOnce(new Error("系统拒绝"));
    await expect(fx.unlocker.lock()).resolves.toEqual({ ok: false, error: "锁屏失败：系统拒绝" });
  });

  it("hasCredential / setCredential / clearCredential 直接走钥匙串", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.hasCredential()).resolves.toBe(true);
    await expect(fx.unlocker.setCredential({ password: "abc" })).resolves.toEqual({ ok: true });
    expect(fx.keychain.set).toHaveBeenCalledWith("abc");
    await expect(fx.unlocker.clearCredential()).resolves.toEqual({ ok: true });
    expect(fx.keychain.remove).toHaveBeenCalledTimes(1);
    expect(fx.unlocker.supported).toBe(true);
  });

  it("lock 默认走系统接口（不带参数）；method:'shortcut' 才让驱动改按锁屏快捷键", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.lock()).resolves.toEqual({ ok: true });
    await expect(fx.unlocker.lock({ method: "auto" })).resolves.toEqual({ ok: true });
    expect(fx.driver.lockScreen).toHaveBeenNthCalledWith(1);
    expect(fx.driver.lockScreen).toHaveBeenNthCalledWith(2);
    await expect(fx.unlocker.lock({ method: "shortcut" })).resolves.toEqual({ ok: true });
    expect(fx.driver.lockScreen).toHaveBeenNthCalledWith(3, { method: "shortcut" });
    expect(fx.calls).toEqual(["lockScreen", "lockScreen", "lockScreen:shortcut"]);

    fx.driver.lockScreen.mockRejectedValueOnce(new Error("快捷键没响应"));
    await expect(fx.unlocker.lock({ method: "shortcut" })).resolves.toEqual({ ok: false, error: "锁屏失败：快捷键没响应" });
  });
});

describe("开机密码里有键码模式输入不了的字符（中文 / emoji / 少见符号）", () => {
  const ASCII_ONLY = (s: string) => /^[\x20-\x7e]*$/.test(s);

  it("保存时预检：打不出来的密码不入钥匙串，并说清原因和出路（改密码，或只在没锁屏时用）", async () => {
    const fx = makeFixture({ typeable: ASCII_ONLY });
    const r = await fx.unlocker.setCredential({ password: "密码123" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("英文字母、数字和常见符号");
    expect(r.error).toContain("没有保存");
    expect(r.error).not.toContain("密码123"); // 错误信息不回显密码
    expect(fx.keychain.set).not.toHaveBeenCalled();
    // 打得出来的照常保存
    await expect(fx.unlocker.setCredential({ password: "abc123" })).resolves.toEqual({ ok: true });
    expect(fx.keychain.set).toHaveBeenCalledWith("abc123");
  });

  it("驱动没有预检能力（旧驱动 / Windows 风格）：不拦，照常交给钥匙串", async () => {
    const fx = makeFixture({ noCanTypeKeysApi: true });
    await expect(fx.unlocker.setCredential({ password: "密码" })).resolves.toEqual({ ok: true });
    expect(fx.keychain.set).toHaveBeenCalledWith("密码");
  });

  it("解锁时钥匙串里取出的是打不出来的密码（旧版本存进去的）：一个键都不按，attempted=false（不进冷却），密码不外泄", async () => {
    const fx = makeFixture({ secret: "密码123", typeable: ASCII_ONLY });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("英文字母、数字和常见符号");
    expect(JSON.stringify([r, fx.steps])).not.toContain("密码123");
    expect(fx.driver.typeText).not.toHaveBeenCalled();
    expect(NO_INPUT(fx.calls)).toEqual([]);
    expect(fx.steps.find((s) => s.name === "credential")).toMatchObject({ ok: false });
  });

  it("checkCredential：读得出、打得出才 ok；没读到 / 打不出 / 读钥匙串抛错都如实说，返回值里没有密码", async () => {
    const good = makeFixture({ typeable: ASCII_ONLY });
    await expect(good.unlocker.checkCredential!()).resolves.toEqual({ ok: true });

    const none = makeFixture({ secret: null });
    const r1 = await none.unlocker.checkCredential!();
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("没有读到");

    const bad = makeFixture({ secret: "密码123", typeable: ASCII_ONLY });
    const r2 = await bad.unlocker.checkCredential!();
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("输入不了的字符");
    expect(JSON.stringify(r2)).not.toContain("密码123");

    const boom = makeFixture({ keychainGetThrows: "钥匙串需要你本人授权" });
    await expect(boom.unlocker.checkCredential!()).resolves.toEqual({ ok: false, error: "钥匙串需要你本人授权" });
    // checkCredential 只读钥匙串，不会碰键盘 / 屏幕
    for (const fx of [good, none, bad, boom]) expect(fx.calls).toEqual([]);
  });

  it("clearCredential 如实报告：删掉了 ok；钥匙串文件删不掉就说失败，并说清楚手动删哪个文件夹", async () => {
    const ok = makeFixture();
    await expect(ok.unlocker.clearCredential()).resolves.toEqual({ ok: true });
    const fail = makeFixture({ removeResult: false });
    const r = await fail.unlocker.clearCredential();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("desktop-keychain");
  });
});

// 第二轮评审：原来「错误信息不含密码」的断言是恒真的——假驱动抛的是固定文案，本来就不含密码；而真实的原生层 / 驱动
// 完全可能把入参回显进异常（「无法输入 xxx」「bad argument: xxx」），错误会顺着返回值进事件 / 审计 / 日志 / 给 AI 的错误文案。
// 这一组用「把入参回显进错误」的毒化驱动 / 钥匙串，断言返回出去的东西里没有整串密码（解锁器是密码还在手上的那一层，由它抹）。
describe("密码在手上时驱动 / 钥匙串抛出的错误：出门之前抹掉整串密码", () => {
  const echo = (what: string) => (s: string) => new Error(`${what}：${s}（共 ${s.length} 个字符）`);
  const everything = (...parts: unknown[]) => JSON.stringify(parts);

  it("对照组：这套毒化假驱动 / 假钥匙串确实会把密码回显进错误（不然下面「不含密码」的断言又是恒真）", async () => {
    const fx = makeFixture({ typeThrows: echo("无法输入"), canTypeThrows: echo("预检失败"), setThrows: echo("保存失败") });
    await expect(fx.driver.typeText(SECRET)).rejects.toThrow(SECRET);
    expect(() => fx.driver.canTypeKeys!(SECRET)).toThrow(SECRET);
    expect(() => fx.keychain.set(SECRET)).toThrow(SECRET);
  });

  it("输入这一步：驱动异常回显了密码 → 返回的 error / 步骤事件里没有密码（抹成「•••」）；密码确实送进了驱动，attempted=true，没按回车", async () => {
    const fx = makeFixture({ typeThrows: echo("无法输入") });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain(`无法输入：•••（共 ${SECRET.length} 个字符）`);
    expect(everything(r, fx.steps)).not.toContain(SECRET);
    expect(fx.driver.typeText).toHaveBeenCalledWith(SECRET, { mode: "keys" }); // 毒化的来源：密码确实进了驱动
    expect(fx.calls).not.toContain("key:enter");
  });

  it("异常里密码出现了好几次：全部抹掉；驱动抛的不是 Error 而是字符串：同样抹掉", async () => {
    const twice = makeFixture({ typeThrows: (t) => new Error(`无法输入「${t}」，请检查 ${t}`) });
    const r1 = await twice.run();
    expect(r1.error).not.toContain(SECRET);
    expect((r1.error?.match(/•••/g) ?? []).length).toBe(2);

    const str = makeFixture({ typeThrows: (t) => `bad argument: ${t}` });
    const r2 = await str.run();
    expect(r2).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r2.error).toContain("bad argument: •••");
    expect(r2.error).not.toContain(SECRET);
  });

  it("取到密码后的预检（canTypeKeys）抛错并回显密码：抹掉；这时一个键都没按，attempted=false（不进冷却）", async () => {
    const fx = makeFixture({ canTypeThrows: echo("预检失败") });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("预检失败：•••");
    expect(everything(r, fx.steps)).not.toContain(SECRET);
    expect(fx.driver.canTypeKeys).toHaveBeenCalledWith(SECRET);
    expect(NO_INPUT(fx.calls)).toEqual([]);
    expect(fx.steps.find((s) => s.name === "credential")).toMatchObject({ ok: false });
  });

  it("不含密码的错误原样带回，不被误改（没有多余的「•••」）", async () => {
    const fx = makeFixture({ typeThrows: true });
    const r = await fx.run();
    expect(r.error).toBe("自动解锁出错：键码输入模式只支持英文字母、数字和常见符号");
  });

  it("checkCredential：预检抛错并回显密码 → 返回的 error 里没有密码；先抹后截断（密码正好跨过 160 字的截断点，也不会留下半截）", async () => {
    const fx = makeFixture({ canTypeThrows: echo("预检失败") });
    const r1 = await fx.unlocker.checkCredential!();
    expect(r1).toMatchObject({ ok: false });
    expect(r1.error).toContain("预检失败：•••");
    expect(JSON.stringify(r1)).not.toContain(SECRET);

    // 155 个字符之后才是密码：先截断再抹的话，会留下密码的前 5 个字符（「S3cre」），已经认不出整串了
    const edge = makeFixture({ canTypeThrows: (s) => new Error("x".repeat(155) + s) });
    const r2 = await edge.unlocker.checkCredential!();
    expect(r2.ok).toBe(false);
    expect(r2.error!.length).toBeLessThanOrEqual(160);
    expect(r2.error).not.toContain(SECRET.slice(0, 3));
    expect(r2.error).toContain("•••");
    // 只读钥匙串 + 预检，不碰键盘 / 屏幕
    expect(fx.calls).toEqual([]);
  });

  it("setCredential：预检抛错 / 钥匙串抛错 / 钥匙串返回的错误文字回显了密码 → 都折成 ok:false 返回（不往外抛），文字里没有密码", async () => {
    const a = makeFixture({ canTypeThrows: echo("预检失败") });
    const ra = await a.unlocker.setCredential({ password: SECRET });
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain("预检失败：•••");
    expect(JSON.stringify(ra)).not.toContain(SECRET);
    expect(a.keychain.set).not.toHaveBeenCalled(); // 预检就崩了，不往钥匙串写

    const b = makeFixture({ setThrows: echo("钥匙串写入失败") });
    const rb = await b.unlocker.setCredential({ password: SECRET });
    expect(rb.ok).toBe(false);
    expect(rb.error).toContain("钥匙串写入失败：•••");
    expect(JSON.stringify(rb)).not.toContain(SECRET);
    expect(b.keychain.set).toHaveBeenCalledWith(SECRET); // 毒化的来源：密码确实进了钥匙串层

    const c = makeFixture({ setResult: (pw) => ({ ok: false, error: `写入被拒：${pw}` }) });
    const rc = await c.unlocker.setCredential({ password: SECRET });
    expect(rc).toEqual({ ok: false, error: "写入被拒：•••" });
  });

  it("setCredential 成功 / 不含密码的失败：原样返回，不被误改", async () => {
    const ok = makeFixture();
    await expect(ok.unlocker.setCredential({ password: SECRET })).resolves.toEqual({ ok: true });
    const fail = makeFixture({ setResult: () => ({ ok: false, error: "保存到钥匙串时出错" }) });
    await expect(fail.unlocker.setCredential({ password: SECRET })).resolves.toEqual({ ok: false, error: "保存到钥匙串时出错" });
  });
});
