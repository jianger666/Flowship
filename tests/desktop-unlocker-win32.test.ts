/**
 * Windows 锁屏解锁器（electron-app/desktop/unlockers/win32.mjs）——假 driver + 假安装器 + 假管道客户端 + 虚拟时钟。
 *
 * 钉死的是「这一次解锁怎么做对、怎么停在原地」，每条都对应一个会让用户吃亏的后果：
 * - 只试一次、绝不重试：输错开机密码会触发账户锁定，比「没解开」严重得多（请求发出之后无论什么结果都不再发第二次）
 * - 组件没装 / 没保存密码 / 在冷却 / 不是锁屏 / 读不到状态：一个请求都不发（密码不会被输进别的窗口）
 * - attempted 如实传递：它决定上层要不要进冷却；连接都没建立的失败不算「试过」，超时 / 回应中断按「试过」算
 * - 取消：请求发出之前每一步都检查；请求发出之后不能取消（不传 signal），已解开的以 CANCELLED_AFTER_UNLOCK 告知上层去锁回来
 * - 组件说「已解锁」之后：驱动明确说「还锁着」才判失败；读不到（null）按成功算（返回失败会让已解开的电脑没人收尾）
 * - 开机密码只出现在 setCredential 发给组件的那一个请求里：不进返回值、不进步骤事件、不进任何错误文案
 */
import { describe, expect, it, vi } from "vitest";

import { createWin32Unlocker, UNLOCK_TIMING } from "../electron-app/desktop/unlockers/win32.mjs";
import { HelperClientError, UNLOCK_TIMEOUT_MS } from "../electron-app/desktop/win-helper/client.mjs";
import { RESPONSE_CODES } from "../electron-app/desktop/win-helper/protocol.mjs";

const SECRET = "S3cret-Pass!";

type Reply = { ok: boolean; code: string; fields: Record<string, string> };
const reply = (ok: boolean, code: string, fields: Record<string, string> = {}): Reply => ({ ok, code, fields });

type Probe = Record<string, unknown>;
const READY: Probe = { installed: true, canInstall: true, running: true, exeExists: true, version: 1, hasCredential: true, cooldownSeconds: 0 };

type World = { locked: boolean | null };
type Ctx = { abort: () => void };
type Req = { verb: string; fields: Record<string, string> | undefined; opts: Record<string, unknown> | undefined };
type Handler = (req: Req, world: World, ctx: Ctx) => Reply | Promise<Reply>;
type Step = { name: string; ok: boolean; ms: number };

const makeFixture = (
  opts: {
    probe?: Probe;
    probeThrows?: Error;
    probeFn?: (ctx: Ctx) => Probe | Promise<Probe>;
    locked?: boolean | null;
    lockedFn?: (world: World, ctx: Ctx) => boolean | null;
    handlers?: Partial<Record<"set" | "check" | "clear" | "unlock", Handler>>;
    lockThrows?: string;
    onSleep?: (ms: number, world: World, ctx: Ctx, count: number) => void;
  } = {},
) => {
  const world: World = { locked: opts.locked === undefined ? true : opts.locked };
  const ac = new AbortController();
  const ctx: Ctx = { abort: () => ac.abort() };
  let clock = 0;
  let sleeps = 0;
  const requests: Req[] = [];

  const driver = {
    isScreenLocked: vi.fn(() => (opts.lockedFn ? opts.lockedFn(world, ctx) : world.locked)),
    lockScreen: vi.fn(async () => {
      if (opts.lockThrows) throw new Error(opts.lockThrows);
      world.locked = true;
    }),
  };
  const installer = {
    probe: vi.fn(async () => {
      if (opts.probeThrows) throw opts.probeThrows;
      return opts.probeFn ? await opts.probeFn(ctx) : (opts.probe ?? READY);
    }),
    status: vi.fn(async () => ({ installed: true, canInstall: true, detail: "状态" })),
    install: vi.fn(async () => ({ ok: true, installed: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
  };
  const defaults: Record<string, Handler> = {
    unlock: (_r, w) => {
      w.locked = false;
      return reply(true, "UNLOCKED");
    },
    set: () => reply(true, "OK"),
    check: () => reply(true, "OK"),
    clear: () => reply(true, "OK"),
  };
  const client = {
    request: vi.fn(async (verb: string, fields?: Record<string, string>, o?: Record<string, unknown>) => {
      const req: Req = { verb, fields, opts: o };
      requests.push(req);
      const handler = (opts.handlers as Record<string, Handler> | undefined)?.[verb] ?? defaults[verb];
      if (!handler) throw new Error(`测试里没有为 ${verb} 准备处理函数`);
      return handler(req, world, ctx);
    }),
  };
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
    sleeps += 1;
    opts.onSleep?.(ms, world, ctx, sleeps);
  });
  // Windows 解锁器实现了契约里所有可选方法（helperStatus / installHelper / uninstallHelper / checkCredential），按「都有」来用
  const unlocker = createWin32Unlocker({ driver: driver as never, installer: installer as never, client: client as never, now: () => clock, sleep }) as Required<ReturnType<typeof createWin32Unlocker>>;
  const steps: Step[] = [];
  const run = (signal: AbortSignal | undefined = ac.signal) => unlocker.unlock({ signal, onStep: (s: Step) => steps.push(s) });
  const unlockRequests = () => requests.filter((r) => r.verb === "unlock");
  /** 让假时钟往前走 ms（模拟组件那头花了多久） */
  const advance = (ms: number) => {
    clock += ms;
  };
  return { world, driver, installer, client, sleep, unlocker, steps, requests, unlockRequests, run, ac, advance, getClock: () => clock };
};

describe("契约：类型与委托", () => {
  it("supported 恒为 true、解锁前要先放遮罩", () => {
    const fx = makeFixture();
    expect(fx.unlocker.supported).toBe(true);
    expect(fx.unlocker.overlayBeforeUnlock).toBe(true);
  });

  it("helperStatus / installHelper / uninstallHelper 直接交给安装器", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.helperStatus()).resolves.toEqual({ installed: true, canInstall: true, detail: "状态" });
    await expect(fx.unlocker.installHelper()).resolves.toEqual({ ok: true, installed: true });
    await expect(fx.unlocker.uninstallHelper()).resolves.toEqual({ ok: true });
    expect(fx.installer.status).toHaveBeenCalledTimes(1);
    expect(fx.installer.install).toHaveBeenCalledTimes(1);
    expect(fx.installer.uninstall).toHaveBeenCalledTimes(1);
  });
});

describe("成功路径", () => {
  it("确认组件 → 确认锁屏 → 请求解锁 → 确认桌面稳定；步骤顺序固定，只发一个 unlock 请求", async () => {
    const fx = makeFixture();
    const r = await fx.run();
    expect(r).toEqual({ ok: true, attempted: true });
    expect(fx.steps.map((s) => s.name)).toEqual(["helper", "check", "unlock", "settle"]);
    expect(fx.steps.every((s) => s.ok)).toBe(true);
    expect(fx.requests.map((q) => q.verb)).toEqual(["unlock"]);
  });

  it("unlock 请求不带任何字段（不带密码）、不传 signal、超时用解锁专用的长超时", async () => {
    const fx = makeFixture();
    await fx.run();
    const [req] = fx.unlockRequests();
    expect(req.fields).toEqual({});
    expect(req.opts).toEqual({ timeoutMs: UNLOCK_TIMEOUT_MS });
    expect(req.opts).not.toHaveProperty("signal");
  });

  it("解开之后等桌面渲染完再确认一次（settle 步骤至少耗时 settleMs）", async () => {
    const fx = makeFixture();
    await fx.run();
    const settle = fx.steps.find((s) => s.name === "settle");
    expect(settle?.ms).toBeGreaterThanOrEqual(UNLOCK_TIMING.settleMs);
    expect(fx.sleep).toHaveBeenLastCalledWith(UNLOCK_TIMING.settleMs);
  });

  it("unlock 这一步不报耗时：组件在锁屏上逐字输密码，用时随密码长度增长，步骤事件会写进审计日志（其余步骤照常报耗时）", async () => {
    // 第三轮评审：和 macOS 解锁器的 type 步骤同一类旁路——不同长度的密码，审计里的步骤事件必须一样
    const run = async (unlockMs: number) => {
      const fx = makeFixture({
        handlers: {
          unlock: (_r, w) => {
            w.locked = false;
            fx.advance(unlockMs);
            return reply(true, "UNLOCKED");
          },
        },
      });
      await fx.run();
      return fx.steps;
    };
    const fast = await run(1_000);
    const slow = await run(9_000);
    expect(fast.find((s) => s.name === "unlock")).toEqual({ name: "unlock", ok: true, ms: 0 });
    expect(slow.find((s) => s.name === "unlock")).toEqual({ name: "unlock", ok: true, ms: 0 });
    expect(fast.map((s) => [s.name, s.ok])).toEqual(slow.map((s) => [s.name, s.ok]));
    // 失败时同样不报
    const failing = makeFixture({
      handlers: {
        unlock: () => {
          failing.advance(5_000);
          return reply(false, "STILL_LOCKED", { attempted: "1" });
        },
      },
    });
    await failing.run();
    expect(failing.steps.find((s) => s.name === "unlock")).toEqual({ name: "unlock", ok: false, ms: 0 });
    // 其它步骤照常有耗时（settle 至少 settleMs）
    expect(fast.find((s) => s.name === "settle")?.ms).toBeGreaterThanOrEqual(UNLOCK_TIMING.settleMs);
  });

  it("步骤事件只有 name / ok / ms 三个字段，返回值里没有密码", async () => {
    const fx = makeFixture();
    const r = await fx.run();
    for (const s of fx.steps) expect(Object.keys(s).sort()).toEqual(["name", "ok", "ms"].sort());
    expect(JSON.stringify([fx.steps, r])).not.toContain(SECRET);
  });

  it("步骤回调自己抛错不影响解锁；不传回调也行", async () => {
    const fx = makeFixture();
    const r = await fx.unlocker.unlock({
      signal: fx.ac.signal,
      onStep: () => {
        throw new Error("回调炸了");
      },
    });
    expect(r.ok).toBe(true);
    const fx2 = makeFixture();
    // 完全不传参数（契约允许省略 options，实现里有默认值）
    const bare = fx2.unlocker as unknown as { unlock: () => Promise<unknown> };
    await expect(bare.unlock()).resolves.toEqual({ ok: true, attempted: true });
  });
});

describe("请求之前的拒绝：一个请求都不发", () => {
  it("没装组件（没有 detail）：提示去装，attempted=false", async () => {
    const fx = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: false } });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("安装");
    expect(fx.requests).toEqual([]);
    expect(fx.driver.isScreenLocked).not.toHaveBeenCalled();
  });

  it("组件装了但不可用（版本不一致 / 没在运行）：把原因带出来，attempted=false", async () => {
    const fx = makeFixture({ probe: { installed: false, canInstall: true, running: true, exeExists: true, detail: "解锁组件回了看不懂的状态" } });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("解锁组件回了看不懂的状态");
    expect(fx.requests).toEqual([]);
  });

  it("还没保存开机密码：NO_CREDENTIAL", async () => {
    const fx = makeFixture({ probe: { ...READY, hasCredential: false } });
    const r = await fx.run();
    expect(r).toEqual({ ok: false, code: "NO_CREDENTIAL", error: RESPONSE_CODES.NO_CREDENTIAL, attempted: false });
    expect(fx.requests).toEqual([]);
    expect(fx.driver.isScreenLocked).not.toHaveBeenCalled();
  });

  it.each([
    [1, 1],
    [60, 1],
    [61, 2],
    [130, 3],
    [599, 10],
  ])("组件在冷却（还剩 %i 秒）：说「约 %i 分钟」，不请求、不算试过", async (cooldownSeconds, minutes) => {
    const fx = makeFixture({ probe: { ...READY, cooldownSeconds } });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain(`约 ${minutes} 分钟`);
    expect(fx.requests).toEqual([]);
  });

  it("冷却秒数是 0：不拦", async () => {
    const fx = makeFixture({ probe: { ...READY, cooldownSeconds: 0 } });
    expect((await fx.run()).ok).toBe(true);
  });

  // UAC 之类的安全桌面上驱动也报「没锁屏」（isScreenLocked 是 false）：session 的 SECURE_DESKTOP 判断之外，这里是第二道闸——
  // 就算上层漏了，也不会向组件请求，更不会有人往 UAC 里输密码
  it("电脑已经被解开（用户自己解的；UAC 之类的安全桌面上驱动也是这么报的）：USER_PRESENT，不请求组件", async () => {
    const fx = makeFixture({ locked: false });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "USER_PRESENT", attempted: false });
    expect(fx.requests).toEqual([]);
  });

  it("读不到是不是锁屏：为安全起见不介入", async () => {
    const fx = makeFixture({ locked: null });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("读不到");
    expect(fx.requests).toEqual([]);
  });

  it("探测组件时出了意外：按失败返回，没发请求就是没试过", async () => {
    const fx = makeFixture({ probeThrows: new Error("探测炸了") });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: false });
    expect(r.error).toContain("自动解锁出错");
    expect(fx.requests).toEqual([]);
    expect(fx.steps.map((s) => [s.name, s.ok])).toEqual([["helper", false]]);
  });
});

describe("组件的回应 → 结果与 attempted", () => {
  const cases: Array<{
    name: string;
    resp: Reply;
    expected: { ok: false; code: string; attempted: boolean };
    errorHas?: string;
  }> = [
    { name: "NOT_LOCKED：用户自己解开了", resp: reply(false, "NOT_LOCKED", { attempted: "0" }), expected: { ok: false, code: "USER_PRESENT", attempted: false } },
    { name: "COOLDOWN：组件拒绝，没输过密码", resp: reply(false, "COOLDOWN", { attempted: "0", wait: "420" }), expected: { ok: false, code: "UNLOCK_FAILED", attempted: false }, errorHas: "约 7 分钟" },
    { name: "NO_CREDENTIAL：组件那边没有密码", resp: reply(false, "NO_CREDENTIAL", { attempted: "0" }), expected: { ok: false, code: "UNLOCK_FAILED", attempted: false } },
    { name: "DESKTOP_ERROR：读不到桌面状态，没输任何东西", resp: reply(false, "DESKTOP_ERROR", { attempted: "0" }), expected: { ok: false, code: "UNLOCK_FAILED", attempted: false } },
    {
      // 解锁之前驱动还看到锁屏、组件起来之后看到的却是 UAC（中间弹出来了）：组件一个键都没输。码原样传上去，上层据此交还用户而不是进冷却
      name: "SECURE_DESKTOP：屏幕上是 UAC 之类的安全桌面，没输任何东西 → 码原样传给上层（不是笼统的 UNLOCK_FAILED）",
      resp: reply(false, "SECURE_DESKTOP", { attempted: "0" }),
      expected: { ok: false, code: "SECURE_DESKTOP", attempted: false },
      errorHas: "UAC",
    },
    { name: "STILL_LOCKED：输了但没解开（没带 attempted 字段 = 按试过算）", resp: reply(false, "STILL_LOCKED"), expected: { ok: false, code: "UNLOCK_FAILED", attempted: true }, errorHas: "PIN" },
    { name: "TIMEOUT：不知道输没输进去，按试过算", resp: reply(false, "TIMEOUT"), expected: { ok: false, code: "UNLOCK_FAILED", attempted: true } },
    { name: "INPUT_FAILED：输入中途失败", resp: reply(false, "INPUT_FAILED"), expected: { ok: false, code: "UNLOCK_FAILED", attempted: true } },
    { name: "LAUNCH_FAILED：带上详情", resp: reply(false, "LAUNCH_FAILED", { attempted: "0", detail: "错误码 5" }), expected: { ok: false, code: "UNLOCK_FAILED", attempted: false }, errorHas: "错误码 5" },
    { name: "成功码不认识：不当成成功", resp: reply(true, "OK"), expected: { ok: false, code: "UNLOCK_FAILED", attempted: true }, errorHas: "意料之外" },
    { name: "结果码不认识：照实说", resp: reply(false, "WHAT_IS_THIS"), expected: { ok: false, code: "UNLOCK_FAILED", attempted: true }, errorHas: "不认识" },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const fx = makeFixture({ handlers: { unlock: () => c.resp } });
      const r = await fx.run();
      expect(r).toMatchObject(c.expected);
      if (c.errorHas) expect(r.error).toContain(c.errorHas);
      // 失败了也只发过一个请求，没有重试
      expect(fx.unlockRequests()).toHaveLength(1);
      // 请求失败的话不会进入 settle
      expect(fx.steps.map((s) => s.name)).toEqual(["helper", "check", "unlock"]);
      expect(fx.steps[2].ok).toBe(false);
      expect(fx.sleep).not.toHaveBeenCalled();
    });
  }
});

describe("管道通信出错 → attempted", () => {
  const cases: Array<{ code: "NOT_RUNNING" | "DENIED" | "TIMEOUT" | "BAD_RESPONSE" | "IO" | "ABORTED"; attempted: boolean }> = [
    { code: "NOT_RUNNING", attempted: false }, // 连接都没建立 = 一个键都没按
    { code: "DENIED", attempted: false },
    { code: "TIMEOUT", attempted: true },
    { code: "BAD_RESPONSE", attempted: true },
    { code: "IO", attempted: true },
    { code: "ABORTED", attempted: true },
  ];
  for (const c of cases) {
    it(`${c.code}：attempted=${c.attempted}，只请求过一次`, async () => {
      const fx = makeFixture({
        handlers: {
          unlock: () => {
            throw new HelperClientError(c.code, `客户端说：${c.code}`);
          },
        },
      });
      const r = await fx.run();
      expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: c.attempted });
      expect(r.error).toBe(c.code === "DENIED" ? RESPONSE_CODES.DENIED : `客户端说：${c.code}`);
      expect(fx.unlockRequests()).toHaveLength(1);
    });
  }

  it("不是 HelperClientError 的异常：按试过算，不回显异常原文（原文里可能有敏感内容），只留错误类型", async () => {
    const fx = makeFixture({
      handlers: {
        unlock: () => {
          throw Object.assign(new Error(`pw=${SECRET}`), { code: "ECONNRESET" });
        },
      },
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain("ECONNRESET");
    expect(JSON.stringify([r, fx.steps])).not.toContain(SECRET);
  });

  it("没有错误码也没有名字的异常：也不崩", async () => {
    const fx = makeFixture({
      handlers: {
        unlock: () => {
          throw { toString: () => SECRET };
        },
      },
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, attempted: true });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("等桌面稳定（settle）", () => {
  it("组件说解开了、驱动一直说还锁着：等满 verifyTimeoutMs 后判失败，且仍是 attempted=true、没有第二次请求", async () => {
    const fx = makeFixture({
      handlers: { unlock: () => reply(true, "UNLOCKED") }, // 不改世界：驱动一直读到 true
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain("仍然显示为锁屏");
    expect(fx.getClock()).toBe(UNLOCK_TIMING.verifyTimeoutMs);
    expect(fx.sleep).toHaveBeenCalledTimes(UNLOCK_TIMING.verifyTimeoutMs / UNLOCK_TIMING.verifyStepMs);
    expect(fx.unlockRequests()).toHaveLength(1);
    expect(fx.steps.map((s) => [s.name, s.ok])).toEqual([
      ["helper", true],
      ["check", true],
      ["unlock", true],
      ["settle", false],
    ]);
  });

  it("驱动过一会儿才读到「已解锁」：照样成功（先等、再等桌面渲染）", async () => {
    const fx = makeFixture({
      handlers: { unlock: () => reply(true, "UNLOCKED") },
      onSleep: (_ms, world, _ctx, count) => {
        if (count === 2) world.locked = false;
      },
    });
    const r = await fx.run();
    expect(r).toEqual({ ok: true, attempted: true });
    expect(fx.sleep).toHaveBeenCalledTimes(3);
    expect(fx.sleep).toHaveBeenNthCalledWith(1, UNLOCK_TIMING.verifyStepMs);
    expect(fx.sleep).toHaveBeenNthCalledWith(3, UNLOCK_TIMING.settleMs);
  });

  it("组件说解开了、驱动读不到状态（null）：按成功算（返回失败会让已解开的电脑没人收尾）", async () => {
    const fx = makeFixture({
      handlers: {
        unlock: (_r, world) => {
          world.locked = null;
          return reply(true, "UNLOCKED");
        },
      },
    });
    const r = await fx.run();
    expect(r).toEqual({ ok: true, attempted: true });
    expect(fx.sleep).toHaveBeenCalledTimes(1); // 只有 settleMs 那一次
  });

  it("解开之后又弹回了锁屏：判失败（attempted=true）", async () => {
    const fx = makeFixture({
      onSleep: (ms, world) => {
        if (ms === UNLOCK_TIMING.settleMs) world.locked = true;
      },
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain("又回到了锁屏");
    expect(fx.unlockRequests()).toHaveLength(1);
  });

  it("settle 阶段读状态时抛异常：按失败返回，attempted 仍是 true", async () => {
    let calls = 0;
    const fx = makeFixture({
      lockedFn: (world) => {
        calls += 1;
        // 第 1 次是 check 步骤；之后（settle）开始抛
        if (calls >= 2) throw new Error("读状态炸了");
        return world.locked;
      },
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain("自动解锁出错");
    expect(fx.unlockRequests()).toHaveLength(1);
  });
});

describe("取消", () => {
  it("开始前就已取消：什么都不做", async () => {
    const fx = makeFixture();
    fx.ac.abort();
    const r = await fx.run();
    expect(r).toEqual({ ok: false, code: "CANCELLED", error: "已取消", attempted: false });
    expect(fx.installer.probe).not.toHaveBeenCalled();
    expect(fx.requests).toEqual([]);
    expect(fx.steps).toEqual([]);
  });

  it("不传 signal：当作不会取消", async () => {
    const fx = makeFixture();
    await expect(fx.run(undefined)).resolves.toEqual({ ok: true, attempted: true });
  });

  it("探测组件期间被取消：不再确认锁屏，更不会请求", async () => {
    const fx = makeFixture({
      probeFn: (ctx) => {
        ctx.abort();
        return READY;
      },
    });
    const r = await fx.run();
    expect(r).toEqual({ ok: false, code: "CANCELLED", error: "已取消", attempted: false });
    expect(fx.driver.isScreenLocked).not.toHaveBeenCalled();
    expect(fx.requests).toEqual([]);
  });

  it("确认锁屏期间被取消：不请求", async () => {
    const fx = makeFixture({
      lockedFn: (world, ctx) => {
        ctx.abort();
        return world.locked;
      },
    });
    const r = await fx.run();
    expect(r).toEqual({ ok: false, code: "CANCELLED", error: "已取消", attempted: false });
    expect(fx.requests).toEqual([]);
  });

  it("请求期间被取消、组件说解开了：以 CANCELLED_AFTER_UNLOCK 告诉上层「其实已解开」，不再进入 settle", async () => {
    const fx = makeFixture({
      handlers: {
        unlock: (_r, world, ctx) => {
          ctx.abort();
          world.locked = false;
          return reply(true, "UNLOCKED");
        },
      },
    });
    const r = await fx.run();
    expect(r).toEqual({ ok: true, code: "CANCELLED_AFTER_UNLOCK", attempted: true });
    expect(fx.steps.map((s) => s.name)).toEqual(["helper", "check", "unlock"]);
    expect(fx.sleep).not.toHaveBeenCalled();
  });

  it("请求期间被取消、但组件说没解开：照实返回失败（请求已经发出，不能装作没试过）", async () => {
    const fx = makeFixture({
      handlers: {
        unlock: (_r, _w, ctx) => {
          ctx.abort();
          return reply(false, "STILL_LOCKED");
        },
      },
    });
    const r = await fx.run();
    expect(r).toMatchObject({ ok: false, code: "UNLOCK_FAILED", attempted: true });
    expect(r.error).toContain("仍然是锁屏");
    expect(fx.unlockRequests()).toHaveLength(1);
  });
});

describe("绝不重试", () => {
  it("无论组件怎么回应、客户端怎么出错，unlock 请求都至多一个", async () => {
    const outcomes: Array<Handler> = [
      () => reply(false, "STILL_LOCKED"),
      () => reply(false, "TIMEOUT"),
      () => reply(false, "INPUT_FAILED"),
      () => reply(false, "COOLDOWN", { attempted: "0", wait: "60" }),
      () => reply(false, "SECURE_DESKTOP", { attempted: "0" }),
      () => reply(true, "OK"),
      () => {
        throw new HelperClientError("TIMEOUT", "超时");
      },
      () => {
        throw new HelperClientError("IO", "断了");
      },
      () => {
        throw new HelperClientError("NOT_RUNNING", "没在运行");
      },
      () => {
        throw new Error("意外");
      },
    ];
    for (const handler of outcomes) {
      const fx = makeFixture({ handlers: { unlock: handler } });
      const r = await fx.run();
      expect(r.ok).toBe(false);
      expect(fx.unlockRequests()).toHaveLength(1);
      expect(fx.requests).toHaveLength(1);
    }
  });

  it("成功之后 settle 失败：同样不会再请求一次", async () => {
    const fx = makeFixture({ handlers: { unlock: () => reply(true, "UNLOCKED") } });
    await fx.run();
    expect(fx.unlockRequests()).toHaveLength(1);
  });
});

describe("保存开机密码 setCredential", () => {
  it("成功：把密码发给组件（整个流程里唯一出现密码的请求），返回值里没有密码", async () => {
    const fx = makeFixture();
    const r = await fx.unlocker.setCredential({ password: SECRET });
    expect(r).toEqual({ ok: true });
    expect(fx.requests).toEqual([{ verb: "set", fields: { pw: SECRET }, opts: undefined }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it.each([
    ["空密码", "", "不能为空"],
    ["不是字符串", undefined, "不能为空"],
    ["太长", "a".repeat(128), "太长"],
    ["含中文", "密码password", "锁屏界面只认真实键码"],
    ["含 emoji", "pass\u{1F600}", "锁屏界面只认真实键码"],
  ])("预检不过（%s）：直接拒绝，连组件都不去探测、不发请求", async (_name, password, hint) => {
    const fx = makeFixture();
    const r = await fx.unlocker.setCredential({ password: password as string });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(hint);
    expect(fx.installer.probe).not.toHaveBeenCalled();
    expect(fx.requests).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("可输入的符号都放行（英文字母、数字、常见符号）", async () => {
    const fx = makeFixture();
    const r = await fx.unlocker.setCredential({ password: "Abc 123;=,-./`[\\]'!@#$%^&*()_+:<>?~{|}\"" });
    expect(r).toEqual({ ok: true });
  });

  it("没装组件：提示去装（有 detail 就一起带上），不发请求", async () => {
    const plain = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: false } });
    const r1 = await plain.unlocker.setCredential({ password: SECRET });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("安装");
    expect(plain.requests).toEqual([]);

    const withDetail = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: true, detail: "没在运行" } });
    const r2 = await withDetail.unlocker.setCredential({ password: SECRET });
    expect(r2.error).toContain("（没在运行）");
    expect(withDetail.requests).toEqual([]);
  });

  it("组件拒绝：用对应的中文说明；不认识的码用默认说明；都不含密码", async () => {
    const known = makeFixture({ handlers: { set: () => reply(false, "STORE_FAILED") } });
    expect(await known.unlocker.setCredential({ password: SECRET })).toEqual({ ok: false, error: RESPONSE_CODES.STORE_FAILED });
    const unknown = makeFixture({ handlers: { set: () => reply(false, "WHAT") } });
    const r = await unknown.unlocker.setCredential({ password: SECRET });
    expect(r).toEqual({ ok: false, error: "解锁组件没能保存开机密码" });
  });

  it("码是对象原型上的名字（constructor / toString …）：用默认说明，不会把原型链上的函数当文案", async () => {
    for (const code of ["constructor", "toString", "hasOwnProperty"]) {
      const fx = makeFixture({ handlers: { set: () => reply(false, code) } });
      const r = await fx.unlocker.setCredential({ password: SECRET });
      expect(r, code).toEqual({ ok: false, error: "解锁组件没能保存开机密码" });
    }
    const check = makeFixture({ handlers: { check: () => reply(false, "constructor") } });
    expect(await check.unlocker.checkCredential()).toEqual({ ok: false, error: "保存的开机密码读不出来，请重新保存" });
    const clear = makeFixture({ handlers: { clear: () => reply(false, "constructor") } });
    expect(await clear.unlocker.clearCredential()).toEqual({ ok: false, error: "解锁组件没能删除已保存的开机密码" });
  });

  it("COOLDOWN_NOT_CLEARED（密码已存好、上一次失败的冷却记录没清掉）：不能报成功——用户会以为自动解锁已恢复；文案写清「已经保存好」和还剩多久", async () => {
    // 第三轮评审 P1-5：C# 以前清不掉状态文件也照样回 OK，用户重新保存密码后仍被冷却挡着却毫不知情
    const fx = makeFixture({ handlers: { set: () => reply(false, "COOLDOWN_NOT_CLEARED", { saved: "1", wait: "301" }) } });
    const r = await fx.unlocker.setCredential({ password: SECRET });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("已经保存好");
    expect(r.error).toContain("约 6 分钟");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // 第四轮评审 A2：返回值带 saved:true——设置页据此分得清「密码已存上、冷却没清掉」和「根本没存上」；ok 仍是 false，字段集只有这三个
    expect(r.saved).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["error", "ok", "saved"]);
    // 请求照常发出了（密码就是这一个请求交给组件的），也没有重试
    expect(fx.requests).toEqual([{ verb: "set", fields: { pw: SECRET }, opts: undefined }]);
  });

  // 第四轮评审 A2：saved 的口径只有一条——组件明确回了 COOLDOWN_NOT_CLEARED 且 saved=1，才是「密码已经存上、只是冷却没清掉」。
  // 其它任何失败都是「没存上」，不能带 saved（带了设置页会说密码已存好，用户就不会去重新保存）
  it("saved 只在 COOLDOWN_NOT_CLEARED 且组件回了 saved=1 时才带：缺 saved / saved 不是 \"1\" / 别的失败码，都不带", async () => {
    const notSaved: Array<[string, Reply]> = [
      ["COOLDOWN_NOT_CLEARED 但没回 saved", reply(false, "COOLDOWN_NOT_CLEARED", { wait: "301" })],
      ["COOLDOWN_NOT_CLEARED 但 saved=0", reply(false, "COOLDOWN_NOT_CLEARED", { saved: "0", wait: "301" })],
      ["COOLDOWN_NOT_CLEARED 但 saved=true（不是 \"1\"）", reply(false, "COOLDOWN_NOT_CLEARED", { saved: "true" })],
      ["别的失败码即使带着 saved=1（组件不会这么回，也不信）", reply(false, "STORE_FAILED", { saved: "1" })],
      ["STORE_FAILED", reply(false, "STORE_FAILED")],
      ["NOT_TYPEABLE", reply(false, "NOT_TYPEABLE")],
      ["不认识的码", reply(false, "WHAT")],
    ];
    for (const [name, resp] of notSaved) {
      const fx = makeFixture({ handlers: { set: () => resp } });
      const r = await fx.unlocker.setCredential({ password: SECRET });
      expect(r.ok, name).toBe(false);
      expect(r, name).not.toHaveProperty("saved");
      expect(JSON.stringify(r), name).not.toContain(SECRET);
    }
  });

  it("没存上的其它失败（预检不过 / 没装组件 / 管道出错 / 异常）也不带 saved；成功更不带", async () => {
    const results: Array<[string, Record<string, unknown>]> = [];
    const pre = makeFixture();
    results.push(["空密码", await pre.unlocker.setCredential({ password: "" })]);
    results.push(["含中文", await pre.unlocker.setCredential({ password: "密码password" })]);
    const noInstall = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: false } });
    results.push(["没装组件", await noInstall.unlocker.setCredential({ password: SECRET })]);
    const denied = makeFixture({
      handlers: {
        set: () => {
          throw new HelperClientError("DENIED", "x");
        },
      },
    });
    results.push(["管道 DENIED", await denied.unlocker.setCredential({ password: SECRET })]);
    const broken = makeFixture({
      handlers: {
        set: () => {
          throw Object.assign(new Error("boom"), { code: "EPIPE" });
        },
      },
    });
    results.push(["普通异常", await broken.unlocker.setCredential({ password: SECRET })]);
    for (const [name, r] of results) {
      expect(r.ok, name).toBe(false);
      expect(r, name).not.toHaveProperty("saved");
    }
    const ok = await makeFixture().unlocker.setCredential({ password: SECRET });
    expect(ok).toEqual({ ok: true });
    expect(ok).not.toHaveProperty("saved");
  });

  it("管道出错：说原因；非 HelperClientError 不回显原文（异常原文里可能带着请求内容）", async () => {
    const denied = makeFixture({
      handlers: {
        set: () => {
          throw new HelperClientError("DENIED", "x");
        },
      },
    });
    expect(await denied.unlocker.setCredential({ password: SECRET })).toEqual({ ok: false, error: RESPONSE_CODES.DENIED });

    const leaky = makeFixture({
      handlers: {
        set: (req) => {
          throw Object.assign(new Error(`写入失败：${JSON.stringify(req.fields)}`), { code: "EPIPE" });
        },
      },
    });
    const r = await leaky.unlocker.setCredential({ password: SECRET });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("EPIPE");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("检查已保存的密码 checkCredential", () => {
  it("没装组件：提示去装", async () => {
    const fx = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: false } });
    const r = await fx.unlocker.checkCredential();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("安装");
    expect(fx.requests).toEqual([]);
  });

  it("没装组件且有 detail：一起带上", async () => {
    const fx = makeFixture({ probe: { installed: false, canInstall: true, running: true, exeExists: true, detail: "版本不一致" } });
    const r = await fx.unlocker.checkCredential();
    expect(r.error).toContain("（版本不一致）");
  });

  it("读得出、打得出：ok", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.checkCredential()).resolves.toEqual({ ok: true });
    expect(fx.requests).toEqual([{ verb: "check", fields: undefined, opts: undefined }]);
  });

  it("组件说不行：给对应说明；不认识的码给默认说明", async () => {
    const a = makeFixture({ handlers: { check: () => reply(false, "CRED_UNREADABLE") } });
    expect(await a.unlocker.checkCredential()).toEqual({ ok: false, error: RESPONSE_CODES.CRED_UNREADABLE });
    const b = makeFixture({ handlers: { check: () => reply(false, "NO_CREDENTIAL") } });
    expect(await b.unlocker.checkCredential()).toEqual({ ok: false, error: RESPONSE_CODES.NO_CREDENTIAL });
    const c = makeFixture({ handlers: { check: () => reply(false, "WHAT") } });
    expect(await c.unlocker.checkCredential()).toEqual({ ok: false, error: "保存的开机密码读不出来，请重新保存" });
  });

  it("管道出错：说原因", async () => {
    const fx = makeFixture({
      handlers: {
        check: () => {
          throw new HelperClientError("TIMEOUT", "等太久了");
        },
      },
    });
    expect(await fx.unlocker.checkCredential()).toEqual({ ok: false, error: "等太久了" });
  });
});

describe("删除已保存的密码 clearCredential", () => {
  it("组件根本没装：本来就没保存过，算成功，不发请求", async () => {
    const fx = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: false } });
    await expect(fx.unlocker.clearCredential()).resolves.toEqual({ ok: true });
    expect(fx.requests).toEqual([]);
  });

  it("装了但没在运行：如实说删不了，并指出卸载会一并清掉；不发请求", async () => {
    const fx = makeFixture({ probe: { installed: false, canInstall: true, running: false, exeExists: true, detail: "连不上" } });
    const r = await fx.unlocker.clearCredential();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有在运行");
    expect(r.error).toContain("卸载");
    expect(fx.requests).toEqual([]);
  });

  it("在运行：请求组件删除", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.clearCredential()).resolves.toEqual({ ok: true });
    expect(fx.requests).toEqual([{ verb: "clear", fields: undefined, opts: undefined }]);
  });

  it("组件说删不了：给对应说明；不认识的码给默认说明；管道出错说原因", async () => {
    const a = makeFixture({ handlers: { clear: () => reply(false, "STORE_FAILED") } });
    expect(await a.unlocker.clearCredential()).toEqual({ ok: false, error: RESPONSE_CODES.STORE_FAILED });
    const b = makeFixture({ handlers: { clear: () => reply(false, "WHAT") } });
    expect(await b.unlocker.clearCredential()).toEqual({ ok: false, error: "解锁组件没能删除已保存的开机密码" });
    const c = makeFixture({
      handlers: {
        clear: () => {
          throw new HelperClientError("IO", "管道断了");
        },
      },
    });
    expect(await c.unlocker.clearCredential()).toEqual({ ok: false, error: "管道断了" });
  });
});

describe("是否保存过密码 hasCredential", () => {
  it("装好了且保存过：true", async () => {
    const fx = makeFixture();
    await expect(fx.unlocker.hasCredential()).resolves.toBe(true);
  });

  it.each([
    ["装好了但没保存", { ...READY, hasCredential: false }],
    ["没装", { installed: false, canInstall: true, running: false, exeExists: false }],
    ["装了但不可用（即使字段里写着 true）", { installed: false, canInstall: true, running: true, exeExists: true, hasCredential: true }],
  ])("%s：false", async (_name, probe) => {
    const fx = makeFixture({ probe });
    await expect(fx.unlocker.hasCredential()).resolves.toBe(false);
  });

  it("探测时抛异常：当作没有，不往外抛", async () => {
    const fx = makeFixture({ probeThrows: new Error("炸了") });
    await expect(fx.unlocker.hasCredential()).resolves.toBe(false);
  });
});

// 第六轮评审 P2-1：Windows 装着旧版解锁组件（设置页提示「点安装升级」）时，hasCredential（要求组件版本够新）恒为 false，
// 设置页因此看不到「已保存」、也清不掉开机密码。设置页状态改问「存着没」（hasStoredCredential），不看组件版本；解锁预检仍用 hasCredential
describe("存着一份开机密码吗 hasStoredCredential（不看组件版本）", () => {
  const STALE: Probe = { installed: false, canInstall: true, running: true, exeExists: true, version: 1, hasCredential: true };

  it("装好了且存着：true", async () => {
    await expect(makeFixture().unlocker.hasStoredCredential()).resolves.toBe(true);
  });

  it("版本对不上、组件还在运行、里面存着密码：true——而「能用来解锁的」hasCredential 对同一份探测仍是 false（两个问题）", async () => {
    const fx = makeFixture({ probe: STALE });
    await expect(fx.unlocker.hasStoredCredential()).resolves.toBe(true);
    await expect(fx.unlocker.hasCredential()).resolves.toBe(false);
  });

  it.each([
    ["版本对不上、里面没存", { ...STALE, hasCredential: false }],
    ["装好了但没存", { ...READY, hasCredential: false }],
    ["没装", { installed: false, canInstall: true, running: false, exeExists: false }],
    ["装了但没在运行（即使字段里写着 true 也不信）", { ...STALE, running: false }],
    ["没有 hasCredential 字段", { installed: false, canInstall: true, running: true, exeExists: true }],
    ["hasCredential 不是严格的 true（\"1\"）", { ...STALE, hasCredential: "1" }],
  ])("%s：false", async (_name, probe) => {
    await expect(makeFixture({ probe: probe as Probe }).unlocker.hasStoredCredential()).resolves.toBe(false);
  });

  it("探测时抛异常：当作没有，不往外抛", async () => {
    await expect(makeFixture({ probeThrows: new Error("炸了") }).unlocker.hasStoredCredential()).resolves.toBe(false);
  });

  it("只看探测结果：不向组件发任何管道请求（设置页状态每次刷新都会问）", async () => {
    const fx = makeFixture({ probe: STALE });
    await fx.unlocker.hasStoredCredential();
    expect(fx.client.request).not.toHaveBeenCalled();
  });

  it("版本对不上时「清除」照样发给组件（clearCredential 有意不设版本闸）：设置页现在够得到它", async () => {
    const fx = makeFixture({ probe: STALE });
    await expect(fx.unlocker.clearCredential()).resolves.toEqual({ ok: true });
    expect(fx.requests.map((r) => r.verb)).toEqual(["clear"]);
  });
});

describe("锁屏 lock", () => {
  it("成功：调驱动的 lockScreen（不带参数，Windows 没有备用路线）", async () => {
    const fx = makeFixture({ locked: false });
    await expect(fx.unlocker.lock({ method: "shortcut" } as never)).resolves.toEqual({ ok: true });
    expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);
    expect(fx.driver.lockScreen).toHaveBeenCalledWith();
    expect(fx.world.locked).toBe(true);
  });

  it("失败：如实说原因", async () => {
    const fx = makeFixture({ lockThrows: "LockWorkStation 失败" });
    const r = await fx.unlocker.lock();
    expect(r).toEqual({ ok: false, error: "锁屏失败：LockWorkStation 失败" });
  });
});
