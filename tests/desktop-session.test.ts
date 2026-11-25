/**
 * 电脑操作会话状态机（electron-app/desktop/session.mjs）。
 *
 * 这是「AI 在用户不在场时自动解锁电脑并干活」的安全核心。每条不变量一个用例，改 session.mjs 之前先看这里——
 * 任何一条变红都意味着：要么 AI 可能在不该动的时候动了用户的电脑，要么用户回来发现电脑被留在了不该有的状态。
 *
 * 默认拒绝（任何一条不满足都不碰锁屏界面）
 * - 总开关没开 / 「锁屏可用」没开 / 请求来源不被允许 / 解锁器不支持 / 没存凭据 / 用户正在动键鼠
 * 一次错误即停
 * - 自动解锁失败（含抛异常）→ 停手、进入冷却；冷却内不再尝试（输错密码会触发账户锁定）；
 *   没有任何绕过入口（设置页「测试」也一样），只有用户亲自重新保存开机密码才会重置冷却（resetUnlockCooldown）
 * 用户优先
 * - 注入之后又出现的键鼠输入 = 用户在动：立刻结束、不锁屏、不抢回，直到用户停手
 * - 我们自己的注入（动作进行中）不能被误判成用户
 * 看门狗
 * - 空闲 / 硬上限 / 总开关被关：到点必结束；我们解锁的要锁回去；遮罩一定撤，锁屏失败也撤
 * - 结束先等在飞的注入动作停手再锁屏（否则剩下的字会打进锁屏密码框）；锁屏要确认真的锁上，默认方式不行就换快捷键再试一次
 * - 解锁之后遮罩盖不上：不能把电脑留在「已解锁、没遮罩、人不在」——锁回去并中止
 * 并发
 * - 同一时刻一个任务持有会话；同任务并发开始只解锁一次；解锁中被取消要等它停手，刚解开的要锁回去，不能「复活」
 * 数据
 * - 事件 / 审计里没有解锁步骤的 detail（可能含敏感信息）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDesktopSession, SESSION_LIMITS } from "../electron-app/desktop/session.mjs";

type UnlockCtx = {
  signal?: AbortSignal;
  onStep?: (s: { name: string; ok: boolean; ms: number; detail?: string }) => void;
};
type UnlockResult = { ok: boolean; error?: string; code?: string; attempted?: boolean };
type World = {
  locked: boolean | null;
  idle: number;
  policy: { enabled: boolean; lockedAccess: boolean };
  credential: boolean;
  /** 屏幕上是不是 UAC 之类的系统安全桌面（只有声明了 secure 的夹具，驱动才有 isSecureDesktopActive） */
  secure: boolean;
  /** isSecureDesktopActive 抛异常 */
  secureThrows: boolean;
  /** 遮罩盖全了没有（overlay.isComplete 的返回值）；会话中途接入显示器 / 改分辨率后窗口建不出来 = false */
  overlayComplete: boolean;
  /** overlay.isComplete 抛异常 */
  overlayProbeThrows: boolean;
};

const makeFixture = (
  init: {
    locked?: boolean;
    idle?: number;
    policy?: Partial<World["policy"]>;
    credential?: boolean;
    supported?: boolean;
    limits?: Record<string, number>;
    unlock?: (ctx: UnlockCtx, world: World) => Promise<UnlockResult>;
    lock?: (world: World, opts: { method?: string }) => Promise<UnlockResult>;
    overlayShowThrows?: boolean;
    /** 注入锁屏后台档：true / false = 注入且可用 / 不可用；缺省 = 不注入（macOS 的样子） */
    background?: boolean;
    /** 解锁器声明「先盖遮罩再解锁」（Windows 系统级解锁组件） */
    overlayBeforeUnlock?: boolean;
    /** 注入日志函数（缺省 = 静默）；让它抛错可以构造「收尾过程中意外出错」 */
    log?: (msg: string) => void;
    /** 冷却截止时刻的落盘（缺省 = 只放内存）；真实实现见 cooldown-store.mjs，重启不清零的端到端用例在 desktop-cooldown-store.test.ts */
    cooldownStore?: { load: () => number; save: (until: number) => void };
    /** 前台会话期间防显示器睡眠（缺省 = 不注入）：acquire() 返回释放函数 */
    keepAwake?: { acquire: () => (() => void) | void };
    /** 注入 sleep（缺省 = 真 setTimeout，配合假时钟）；让它抛错可以构造「收尾过程中意外出错」 */
    sleep?: (ms: number) => Promise<void>;
    /** 注入事件通知回调（缺省 = 记进 events）；让它抛错可以构造「通知链出错」 */
    notify?: (e: Record<string, unknown>) => void;
    /**
     * 驱动带不带 isSecureDesktopActive（Windows 驱动有、macOS 驱动没有）：缺省 = 不带；
     * 给了就是带，值是「屏幕上一开始是不是 UAC 之类的安全桌面」，之后改 world.secure
     */
    secure?: boolean;
  } = {},
) => {
  const world: World = {
    locked: init.locked ?? false,
    idle: init.idle ?? 100,
    policy: { enabled: true, lockedAccess: true, ...init.policy },
    credential: init.credential ?? true,
    secure: init.secure ?? false,
    secureThrows: false,
    overlayComplete: true,
    overlayProbeThrows: false,
  };
  const events: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const calls: string[] = [];

  const driver = {
    platform: "darwin",
    isScreenLocked: vi.fn(() => world.locked),
    idleSeconds: vi.fn(() => world.idle),
    lockScreen: vi.fn(() => {
      calls.push("driver.lockScreen");
      world.locked = true;
    }),
    ...(init.secure === undefined
      ? {}
      : {
          isSecureDesktopActive: vi.fn(() => {
            if (world.secureThrows) throw new Error("读安全桌面状态出错");
            return world.secure;
          }),
        }),
  };
  const overlay = {
    show: vi.fn(() => {
      calls.push("overlay.show");
      if (init.overlayShowThrows) throw new Error("遮罩窗口创建失败");
    }),
    hide: vi.fn(() => {
      calls.push("overlay.hide");
    }),
    isShown: () => false,
    isComplete: vi.fn((): boolean => {
      if (world.overlayProbeThrows) throw new Error("遮罩盖全了没有：探测出错");
      return world.overlayComplete;
    }),
  };
  const bg = {
    available: init.background === true,
    throws: false,
  };
  /** 后台档的假实现（总是创建，方便断言；只有 init.background 给了值才会注入 session） */
  const background = {
    available: vi.fn(() => {
      if (bg.throws) throw new Error("后台档探测出错");
      return bg.available;
    }),
    reset: vi.fn(() => {
      calls.push("background.reset");
    }),
  };
  const unlocker = {
    supported: init.supported ?? true,
    ...(init.overlayBeforeUnlock ? { overlayBeforeUnlock: true } : {}),
    hasCredential: vi.fn(async () => world.credential),
    unlock: vi.fn(async (ctx: UnlockCtx) => {
      calls.push("unlock");
      if (init.unlock) return init.unlock(ctx, world);
      world.locked = false;
      return { ok: true };
    }),
    lock: vi.fn(async (opts: { method?: string } = {}) => {
      calls.push("lock");
      if (init.lock) return init.lock(world, opts);
      world.locked = true;
      return { ok: true };
    }),
  };
  const session = createDesktopSession({
    // 只实现状态机用到的那几个方法；其余方法的缺失本身就是「状态机没碰它们」的断言
    driver: driver as never,
    unlocker: unlocker as never,
    overlay,
    getPolicy: () => world.policy,
    background: init.background === undefined ? null : background,
    notify: init.notify ?? ((e: Record<string, unknown>) => events.push(e)),
    audit: (e: Record<string, unknown>) => audits.push(e),
    log: init.log,
    limits: init.limits,
    cooldownStore: init.cooldownStore,
    keepAwake: init.keepAwake,
    sleep: init.sleep,
  });
  const kinds = () => events.map((e) => e.kind);
  return { world, events, audits, calls, driver, overlay, unlocker, session, kinds, background, bg };
};

const flush = () => vi.advanceTimersByTimeAsync(0);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

const rejectCode = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("开始：默认拒绝", () => {
  it("没锁屏：直接开始，不解锁、不盖遮罩", async () => {
    const fx = makeFixture();
    const r = await fx.session.begin("t1");
    expect(r).toMatchObject({ unlockedByUs: false, locked: false });
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "active", taskId: "t1", unlockedByUs: false });
  });

  it("总开关没开：ACCESS_DISABLED，什么都不碰", async () => {
    const fx = makeFixture({ locked: true, policy: { enabled: false } });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("ACCESS_DISABLED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.session.status().state).toBe("idle");
  });

  it("锁屏 + 「锁屏可用」没开：SCREEN_LOCKED，不解锁", async () => {
    const fx = makeFixture({ locked: true, policy: { lockedAccess: false } });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("锁屏 + 请求来源不被允许（allowUnlock 缺省 = 拒绝）：SCREEN_LOCKED，不解锁", async () => {
    const fx = makeFixture({ locked: true });
    expect(await rejectCode(fx.session.begin("t1"))).toBe("SCREEN_LOCKED");
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: false }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("锁屏 + 解锁器不支持（Windows 阶段 1）：UNSUPPORTED", async () => {
    const fx = makeFixture({ locked: true, supported: false });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNSUPPORTED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("锁屏 + 没有解锁器：UNSUPPORTED", async () => {
    const fx = makeFixture({ locked: true });
    const session = createDesktopSession({
      driver: fx.driver as never,
      unlocker: null,
      overlay: fx.overlay,
      getPolicy: () => fx.world.policy,
    });
    expect(await rejectCode(session.begin("t1", { allowUnlock: true }))).toBe("UNSUPPORTED");
  });

  it("锁屏 + 没存凭据：SCREEN_LOCKED", async () => {
    const fx = makeFixture({ locked: true, credential: false });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("锁屏 + 用户刚动过键鼠（可能正自己解锁）：USER_TOOK_OVER，AI 不凑上去", async () => {
    const fx = makeFixture({ locked: true, idle: 1 });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("USER_TOOK_OVER");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("被拒之后回到干净的 idle：别的任务可以开始", async () => {
    const fx = makeFixture({ locked: true, credential: false });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
    fx.world.locked = false;
    await expect(fx.session.begin("t2")).resolves.toMatchObject({ locked: false });
  });
});

describe("解锁成功", () => {
  it("顺序：unlocking → unlock → 盖遮罩 → unlocked；返回 unlockedByUs", async () => {
    const fx = makeFixture({ locked: true });
    const r = await fx.session.begin("t1", { allowUnlock: true });
    expect(r).toMatchObject({ unlockedByUs: true, locked: true });
    expect(fx.calls).toEqual(["unlock", "overlay.show"]);
    expect(fx.kinds()).toEqual(["unlocking", "unlocked"]);
    expect(fx.session.status()).toMatchObject({ state: "active", unlockedByUs: true });
  });

  it("遮罩盖不上：不能把电脑留在「已解锁、没遮罩、人不在」——锁回去、中止这次开始、告诉用户", async () => {
    const fx = makeFixture({ locked: true, overlayShowThrows: true });
    let err: unknown;
    try {
      await fx.session.begin("t1", { allowUnlock: true });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe("INTERNAL");
    expect((err as Error).message).toMatch(/遮罩/);
    expect((err as Error).message).toMatch(/锁回去了/);
    // 电脑被锁回去了；没有任何会话残留
    expect(fx.world.locked).toBe(true);
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, unlockedByUs: false });
    expect(fx.events.find((e) => e.kind === "relocked")).toMatchObject({ kind: "relocked", taskId: "t1", reason: "overlay_failed" });
    expect(fx.events.some((e) => e.kind === "unlocked")).toBe(false); // 没有「已解锁并开始干活」的通知
    expect(fx.events.some((e) => e.kind === "relock_failed")).toBe(false);
  });

  it("遮罩盖不上，先锁屏再撤遮罩（兜底撤除半成品也在锁屏之后）", async () => {
    const fx = makeFixture({ locked: true, overlayShowThrows: true });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(fx.calls).toEqual(["unlock", "overlay.show", "lock", "overlay.hide"]);
  });

  it("遮罩盖不上、而且锁不回去：发 relock_failed，错误信息老实说电脑可能还是解锁的", async () => {
    const fx = makeFixture({ locked: true, overlayShowThrows: true, lock: async () => ({ ok: false, error: "系统拒绝了锁屏" }) });
    await expect(fx.session.begin("t1", { allowUnlock: true })).rejects.toThrow(/电脑可能还是解锁状态/);
    const failed = fx.events.find((e) => e.kind === "relock_failed");
    expect(failed).toMatchObject({ taskId: "t1", reason: "overlay_failed", error: "系统拒绝了锁屏" });
    expect(fx.events.some((e) => e.kind === "relocked")).toBe(false);
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, unlockedByUs: false });
  });

  it("遮罩盖不上之后不进冷却（密码是对的）：下一次可以直接再试", async () => {
    const fx = makeFixture({ locked: true, overlayShowThrows: true });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
    fx.overlay.show.mockImplementation(() => {});
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
  });

  it("同任务再次 begin：续用，不重复解锁", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    const again = await fx.session.begin("t1", { allowUnlock: true });
    expect(again).toMatchObject({ resumed: true, unlockedByUs: true });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("解锁步骤只把 name / ok / ms 写进审计，detail 不进", async () => {
    const fx = makeFixture({
      locked: true,
      unlock: async (ctx, world) => {
        ctx.onStep?.({ name: "type", ok: true, ms: 12, detail: "这里可能含敏感信息" });
        world.locked = false;
        return { ok: true };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    const step = fx.audits.find((a) => a.type === "unlock_step");
    expect(step).toEqual({ type: "unlock_step", name: "type", ok: true, ms: 12 });
    expect(JSON.stringify(fx.audits)).not.toContain("敏感");
  });
});

describe("一次错误即停 + 冷却", () => {
  it("解锁失败：UNLOCK_FAILED、不显示遮罩、发 unlock_failed、回到 idle", async () => {
    const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, error: "提交密码后仍是锁屏" }) });
    const p = fx.session.begin("t1", { allowUnlock: true });
    expect(await rejectCode(p)).toBe("UNLOCK_FAILED");
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.kinds()).toEqual(["unlocking", "unlock_failed"]);
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
  });

  it("失败信息写明「已停手、不会重试」，让模型照实告诉用户", async () => {
    const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, error: "x" }) });
    await expect(fx.session.begin("t1", { allowUnlock: true })).rejects.toThrow(/不会重试/);
  });

  it("冷却内不再尝试，且没有任何绕过入口（传 ignoreCooldown 也没用）；status 暴露冷却截止时刻", async () => {
    let n = 0;
    const fx = makeFixture({
      locked: true,
      unlock: async (_ctx, world) => {
        n += 1;
        if (n === 1) return { ok: false, error: "密码不对" };
        world.locked = false;
        return { ok: true };
      },
    });
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(fx.session.status().unlockCooldownUntil).toBe(Date.now() + SESSION_LIMITS.unlockCooldownMs);

    // 冷却内：直接拒绝，unlock 不再被调用
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    // 旧版有个「用户亲自点测试可绕过」的口子：现在即便传了也不认（多一次输错 = 离账户锁定更近一步）
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true, ignoreCooldown: true } as never))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  // 第六轮评审 P3：冷却中的拒绝文案不能一口咬定「刚刚输错过 / 去检查密码」——这段冷却也可能是
  // 「输密码途中程序退出、重启后读回预写的冷却」留下的，那时根本没输错过。tools.ts 的 UNLOCK_FAILED 说明靠详情开头「自动解锁正在冷却中」认出它
  it("冷却中的拒绝：详情写「自动解锁正在冷却中」、让用户亲自解锁，不一口咬定密码有问题（冷却也可能是程序中途退出留下的）", async () => {
    const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, error: "密码不对" }) });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED"); // 先输错一次，进冷却
    let message = "";
    try {
      await fx.session.begin("t1", { allowUnlock: true });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message, "冷却里不会再输密码，要抛错").not.toBe("");
    expect(message).toMatch(/^自动解锁正在冷却中/);
    expect(message).toContain("亲自解锁");
    expect(message).toContain("程序中途退出时留下的冷却记录也会让它生效");
    expect(message).toContain("密码未必有问题");
    expect(message, "只有用户确认之前确实失败过才建议检查密码").toContain("只有他确认之前确实自动解锁失败过");
    expect(message, "旧文案直接叫用户去检查密码").not.toContain("请告诉用户检查设置里保存的开机密码");
    // 对来源只说「多半」、紧跟「但……」的限定：刚输错过只是最常见的来源，不是唯一的。
    // （这句话本身还在新文案里，所以不能再用 not.toContain 去查旧的断言式开头——开头已由上面的 /^自动解锁正在冷却中/ 钉住）
    expect(message, "不一口咬定「刚刚输错过」：写成「多半……但……」").toContain("冷却多半是刚刚自动解锁失败过，但");
  });

  it("用户亲自重新保存开机密码：resetUnlockCooldown 解除冷却，下一次可以再试", async () => {
    let n = 0;
    const fx = makeFixture({
      locked: true,
      unlock: async (_ctx, world) => {
        n += 1;
        if (n === 1) return { ok: false, error: "密码不对" };
        world.locked = false;
        return { ok: true };
      },
    });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED"); // 冷却中
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);

    fx.session.resetUnlockCooldown();
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(2);
  });

  it("冷却过了之后 status 里的截止时刻自动归零", async () => {
    const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, error: "x" }) });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(fx.session.status().unlockCooldownUntil).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.unlockCooldownMs + 1);
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
  });

  it("冷却时间一过就可以再试", async () => {
    let n = 0;
    const fx = makeFixture({
      locked: true,
      unlock: async (_ctx, world) => {
        n += 1;
        if (n === 1) return { ok: false, error: "x" };
        world.locked = false;
        return { ok: true };
      },
    });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.unlockCooldownMs + 1);
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
  });

  it("密码根本没输过的失败（没权限 / 用户自己解开了）：不算输错、不进冷却，错误码贴切", async () => {
    let n = 0;
    const fx = makeFixture({
      locked: true,
      unlock: async (_ctx, world) => {
        n += 1;
        if (n === 1) return { ok: false, code: "NEED_PERMISSION", error: "没有辅助功能权限", attempted: false };
        if (n === 2) return { ok: false, code: "USER_PRESENT", error: "用户自己解开了", attempted: false };
        world.locked = false;
        return { ok: true };
      },
    });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("NEED_PERMISSION");
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("USER_TOOK_OVER");
    // 前两次都没有冷却：第三次直接成功
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(n).toBe(3);
  });

  it("unlock_failed 事件带 cooldown 标记：输过密码的失败 = true，没输过的 = false（server 据此说对「要不要等 10 分钟」）", async () => {
    let n = 0;
    const fx = makeFixture({
      locked: true,
      unlock: async () => {
        n += 1;
        return n === 1
          ? { ok: false, code: "NEED_PERMISSION", error: "没权限", attempted: false }
          : { ok: false, error: "提交后仍是锁屏", attempted: true };
      },
    });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    const failed = fx.events.filter((e) => e.kind === "unlock_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ cooldown: false, error: "没权限" });
    expect(failed[1]).toMatchObject({ cooldown: true, error: "提交后仍是锁屏" });
    // 解锁器没说 attempted（旧实现 / 异常）：按「输过了」处理，进冷却
    const legacy = makeFixture({ locked: true, unlock: async () => ({ ok: false, error: "x" }) });
    await rejectCode(legacy.session.begin("t1", { allowUnlock: true }));
    expect(legacy.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ cooldown: true });
  });

  it("解锁器抛异常：按失败处理（同样进入冷却）", async () => {
    const fx = makeFixture({
      locked: true,
      unlock: async () => {
        throw new Error("koffi 崩了");
      },
    });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });
});

// 冷却落盘（第二轮评审 P1-1）：输错之后重启 / 崩溃重启 / 自动更新 relaunch 不能把冷却清零，否则下一次请求会把同一个错密码再输一遍。
// 这里用假 store 覆盖各种边界；真实文件（0600 / 原子写 / 两个 session 共用一个文件模拟重启）见 desktop-cooldown-store.test.ts。
describe("冷却落盘：重启不清零", () => {
  const makeStore = (loaded: number | Error = 0) => {
    const saved: number[] = [];
    return {
      saved,
      load: vi.fn(() => {
        if (loaded instanceof Error) throw loaded;
        return loaded;
      }),
      save: vi.fn((until: number) => {
        saved.push(until);
      }),
    };
  };
  const unlockOk = async (_ctx: UnlockCtx, world: World) => {
    world.locked = false;
    return { ok: true };
  };

  it("启动时记录里的截止时刻还没到：直接按冷却处理——UNLOCK_FAILED，解锁器一个键都没碰；status 暴露截止时刻", async () => {
    const until = Date.now() + 5 * 60_000;
    const fx = makeFixture({ locked: true, cooldownStore: makeStore(until), unlock: unlockOk });
    expect(fx.session.status().unlockCooldownUntil).toBe(until);
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.unlocker.hasCredential).not.toHaveBeenCalled();
  });

  it("记录里的截止时刻已经过去 / 0 / 没记录：不在冷却，可以正常解锁", async () => {
    for (const loaded of [0, Date.now() - 1, Date.now()]) {
      const fx = makeFixture({ locked: true, cooldownStore: makeStore(loaded), unlock: unlockOk });
      expect(fx.session.status().unlockCooldownUntil).toBe(0);
      await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    }
  });

  it("记录的截止时刻远在未来（时钟被拨回过 / 文件被改过）：最多只认「现在起一整段冷却」，不会让功能永久不可用", async () => {
    const fx = makeFixture({ locked: true, cooldownStore: makeStore(Date.now() + 365 * 24 * 3600_000), unlock: unlockOk });
    expect(fx.session.status().unlockCooldownUntil).toBe(Date.now() + SESSION_LIMITS.unlockCooldownMs);
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.unlockCooldownMs + 1);
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
  });

  it("记录读不了 / 读不懂（load 抛错）：fail-closed，按一整段冷却算并记日志，而不是当成「没失败过」", async () => {
    const logs: string[] = [];
    const fx = makeFixture({
      locked: true,
      cooldownStore: makeStore(new Error("冷却记录内容读不懂")),
      unlock: unlockOk,
      log: (m) => logs.push(m),
    });
    expect(fx.session.status().unlockCooldownUntil).toBe(Date.now() + SESSION_LIMITS.unlockCooldownMs);
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("冷却记录读不了");
    // 一整段过去之后恢复
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.unlockCooldownMs + 1);
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
  });

  it("load 回了垃圾（不是有效时间戳：NaN / 字符串 / null / undefined / 负数）：同样当作坏记录、按一整段冷却算（NaN 比较永远为假，不能因此放行）", async () => {
    for (const bad of [Number.NaN, "x", null, undefined, -1, Number.POSITIVE_INFINITY]) {
      const store = makeStore();
      store.load.mockReturnValue(bad as never); // makeStore(undefined) 会落到默认值 0，所以这里直接改 mock 的返回
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk });
      expect(fx.session.status().unlockCooldownUntil).toBe(Date.now() + SESSION_LIMITS.unlockCooldownMs);
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    }
  });

  // 第三轮评审 P1-2：冷却在**输密码之前**预写（unlock 返回之前进程死掉、重启后也不会把同一个密码再输一遍），
  // 结果出来后结算——输错保持（刷新起点）、解开了 / 根本没输过撤销（写 0）。所以盘上的写入序列是「预写 → 结算」两次。
  const COOLDOWN = () => Date.now() + SESSION_LIMITS.unlockCooldownMs;

  it("输错（输过密码、没解开）：预写一整段冷却，结算时保持（刷新起点）——最后落盘的 = 现在 + 一整段冷却", async () => {
    const store = makeStore();
    const fx = makeFixture({ locked: true, cooldownStore: store, unlock: async () => ({ ok: false, error: "提交后仍是锁屏" }) });
    expect(store.save).not.toHaveBeenCalled();
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(store.saved).toEqual([COOLDOWN(), COOLDOWN()]);
    expect(fx.session.status().unlockCooldownUntil).toBe(COOLDOWN());
  });

  it("解锁器抛异常：同样保持（当成输过且没解开）", async () => {
    const store = makeStore();
    const fx = makeFixture({
      locked: true,
      cooldownStore: store,
      unlock: async () => {
        throw new Error("koffi 崩了");
      },
    });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(store.saved).toEqual([COOLDOWN(), COOLDOWN()]);
    expect(fx.session.status().unlockCooldownUntil).toBe(COOLDOWN());
  });

  it("解锁器没返回结果（undefined / 非对象）：当成输过且没解开——不抛 TypeError、冷却不丢", async () => {
    for (const bad of [undefined, null, "ok"]) {
      const store = makeStore();
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: (async () => bad) as never });
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      expect(store.saved.at(-1)).toBe(COOLDOWN());
      expect(fx.session.status().state).toBe("idle");
    }
  });

  it("解锁过程中被取消、密码已输进去却没解开：保持冷却（取消不是免死金牌）", async () => {
    const store = makeStore();
    const fx = makeFixture({
      locked: true,
      cooldownStore: store,
      unlock: (ctx) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve({ ok: false, error: "被取消", attempted: true }));
        }),
    });
    const p = fx.session.begin("t1", { allowUnlock: true });
    const settled = rejectCode(p);
    await flush();
    void fx.session.end("cancelled");
    expect(await settled).toBe("CANCELLED");
    expect(store.saved).toEqual([COOLDOWN(), COOLDOWN()]);
    expect(fx.session.status().unlockCooldownUntil).toBe(COOLDOWN());
  });

  it("解锁过程中被取消、但其实已经解开了：密码是对的——撤销预写的冷却（写 0），并把电脑锁回去", async () => {
    const store = makeStore();
    const fx = makeFixture({
      locked: true,
      cooldownStore: store,
      unlock: (ctx, world) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener("abort", () => {
            world.locked = false;
            resolve({ ok: true, code: "CANCELLED_AFTER_UNLOCK", attempted: true });
          });
        }),
    });
    const settled = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    void fx.session.end("cancelled");
    expect(await settled).toBe("CANCELLED");
    expect(store.saved).toEqual([COOLDOWN(), 0]);
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
    expect(fx.calls).toContain("lock"); // 刚解开的锁回去（原有语义不变）
  });

  it("密码根本没输过的失败（attempted:false）：不进冷却——预写的记录被撤回（写 0）", async () => {
    const store = makeStore();
    const fx = makeFixture({
      locked: true,
      cooldownStore: store,
      unlock: async () => ({ ok: false, code: "NEED_PERMISSION", error: "没权限", attempted: false }),
    });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(store.saved).toEqual([COOLDOWN(), 0]);
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
  });

  it("解锁成功：预写的冷却被撤回（写 0），不会让下一次启动误判成「刚失败过」", async () => {
    const store = makeStore();
    const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk });
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(store.saved).toEqual([COOLDOWN(), 0]);
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
  });

  it("预写发生在 unlock() 返回**之前**：输密码途中进程死掉（unlock 永不返回），盘上已经是一整段冷却；此时对外不报冷却（还不算输错）", async () => {
    const store = makeStore();
    const fx = makeFixture({ locked: true, cooldownStore: store, unlock: () => new Promise<never>(() => {}) });
    void fx.session.begin("t1", { allowUnlock: true }).catch(() => {});
    await flush();
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(store.saved, "输密码之前冷却就该已落盘").toEqual([COOLDOWN()]);
    // 状态页 / 设置页不该在 AI 正常解锁的这十来秒里闪一下「解锁失败、冷却中」
    expect(fx.session.status()).toMatchObject({ state: "unlocking", unlockCooldownUntil: 0 });
  });

  it("预写发生在 unlocker.unlock 被调用之前（顺序：save → unlock）", async () => {
    const order: string[] = [];
    const store = makeStore();
    store.save.mockImplementation((until: number) => {
      order.push(`save:${until === 0 ? "0" : "until"}`);
    });
    const fx = makeFixture({
      locked: true,
      cooldownStore: store,
      unlock: async (_ctx, world) => {
        order.push("unlock");
        world.locked = false;
        return { ok: true };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(order).toEqual(["save:until", "unlock", "save:0"]);
  });

  it("没走到输密码的失败（没存凭据 / 用户在场）：一次都不写记录", async () => {
    const store = makeStore();
    const noCred = makeFixture({ locked: true, cooldownStore: store, credential: false });
    expect(await rejectCode(noCred.session.begin("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
    const present = makeFixture({ locked: true, cooldownStore: store, idle: 0 });
    expect(await rejectCode(present.session.begin("t1", { allowUnlock: true }))).toBe("USER_TOOK_OVER");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("用户重新保存开机密码（resetUnlockCooldown）：把 0 落盘，旧冷却不会在下次启动复活", async () => {
    const store = makeStore();
    const fx = makeFixture({ locked: true, cooldownStore: store, unlock: async () => ({ ok: false, error: "x" }) });
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    fx.session.resetUnlockCooldown();
    expect(store.saved).toEqual([COOLDOWN(), COOLDOWN(), 0]);
  });

  // 只有「输密码之前的预写」写不进去才拒绝解锁（见下面「预写冷却写盘失败」）；结算阶段（密码已经输过、结果已出）写不进去只记日志：
  // 那时冷却是真的要进的，内存里的照样生效；盘上留着输密码之前预写的那一段，进程在这之后死掉的话重启后冷却仍在、只是会早结束一点
  //（第七轮评审 P3：这里原来也写「重启后会丢」，和第六轮改准的默认日志、COMPUTER-USE.md 不一致；第四轮评审之前这条用例钉的是「预写失败也照样输密码」，已被取代）
  it("结算阶段写不进去（预写成功、密码已经输过）：只记日志，内存里的冷却照样生效（不能因为写盘失败就放行第二次输入）", async () => {
    const logs: string[] = [];
    const store = makeStore();
    store.save.mockImplementation((until: number) => {
      if (store.saved.length >= 1) throw new Error("磁盘只读"); // 第 1 次（输密码之前的预写）成功，之后（结算）全部失败
      store.saved.push(until);
    });
    const fx = makeFixture({
      locked: true,
      cooldownStore: store,
      unlock: async () => ({ ok: false, error: "x" }),
      log: (m) => logs.push(m),
    });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock, "预写成功，这次确实输过一次密码").toHaveBeenCalledTimes(1);
    const failures = logs.filter((l) => l.includes("冷却记录写不进去"));
    expect(failures.length, "结算写失败要记一条日志").toBeGreaterThan(0);
    expect(failures[0], "结算阶段冷却是真的在内存里生效").toContain("内存里仍然生效");
    // 第六轮评审 P3：预写已落盘，盘上留着的是预写的那一段（起点只是比这次失败早十几秒）——重启后冷却仍在、只会早结束一点，不是「会丢」
    expect(failures[0], "盘上还留着输密码之前预写的那一段").toContain("输密码之前预写的那一段");
    expect(failures[0], "重启后冷却仍在").toContain("重启后冷却仍在");
    expect(failures[0], "旧文案说「重启后会丢」是错的：预写已经落盘").not.toContain("会丢");
    expect(fx.session.status().unlockCooldownUntil, "内存里的冷却照样生效（对外报）").toBe(COOLDOWN());
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  // 第五轮评审：撤销（解开了 / 根本没输过）与重置写 0 失败时，内存里的冷却已经是 0、盘上还留着旧的那一段——
  // 方向是 fail-closed（重启后多出一次冷却），但默认文案「内存里仍然生效……」（它描述的是结算时「保持」那一种：冷却在内存里照样生效、
  // 盘上留着预写的那一段，重启后冷却仍在）和这两种场合恰好方向相反，误导排障。
  // （第八轮评审 P3-6：这里原来把默认文案引成「……重启后会丢」；那句早在第六轮 P3 改掉了——预写已经落盘，重启后冷却仍在，不是「会丢」。）
  // cooldown-store 没有删除接口（刻意不删文件），所以没有兜底删除：只改文案，写失败不抛、不重试、不拖慢解锁流程。
  describe("写 0 失败（撤销 / 重置）：日志说准「盘上还留着旧冷却」，不抛、不重试", () => {
    /** 第 allowedWrites 次之后的写全部失败；之前的正常记进 saved */
    const makeStoreFailingAfter = (allowedWrites: number) => {
      const store = makeStore();
      store.save.mockImplementation((until: number) => {
        if (store.saved.length >= allowedWrites) throw new Error("磁盘只读");
        store.saved.push(until);
      });
      return store;
    };
    const failureLogs = (logs: string[]) => logs.filter((l) => l.includes("冷却记录写不进去"));

    it("解锁成功后撤销预写的冷却（写 0）失败：日志写「盘上还留着预写的那一段」、不含「内存里仍然生效」；内存冷却确实是 0、不抛、解锁照常成功", async () => {
      const logs: string[] = [];
      const store = makeStoreFailingAfter(1); // 预写成功，撤销失败
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk, log: (m) => logs.push(m) });
      await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
      expect(fx.session.status().unlockCooldownUntil, "内存里的冷却已撤销").toBe(0);
      const failures = failureLogs(logs);
      expect(failures, "只记一次").toHaveLength(1);
      expect(failures[0]).toContain("盘上还留着预写的那一段");
      expect(failures[0]).toContain("重启后会多出一次冷却");
      expect(failures[0]).not.toContain("内存里仍然生效");
      expect(store.save, "预写 1 次 + 撤销 1 次：写失败后没有再重试").toHaveBeenCalledTimes(2);
    });

    it("根本没输过密码的失败（attempted:false）撤销写 0 失败：同样说准、状态里没有冷却、不抛", async () => {
      const logs: string[] = [];
      const store = makeStoreFailingAfter(1);
      const fx = makeFixture({
        locked: true,
        cooldownStore: store,
        unlock: async () => ({ ok: false, code: "NEED_PERMISSION", error: "没权限", attempted: false }),
        log: (m) => logs.push(m),
      });
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("NEED_PERMISSION");
      expect(fx.session.status().unlockCooldownUntil).toBe(0);
      const failures = failureLogs(logs);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("盘上还留着预写的那一段");
      expect(failures[0]).not.toContain("内存里仍然生效");
      expect(store.save).toHaveBeenCalledTimes(2);
    });

    it("对照：输错后保持冷却（写的是一段真冷却）失败，仍是原来的「内存里仍然生效」文案——只改了写 0 的那两处", async () => {
      const logs: string[] = [];
      const store = makeStoreFailingAfter(1); // 预写成功，结算（保持冷却）失败
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: async () => ({ ok: false, error: "x" }), log: (m) => logs.push(m) });
      await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
      const failures = failureLogs(logs);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("内存里仍然生效");
      // 默认文案（保持冷却写失败）说的是「盘上留着输密码之前预写的那一段、重启后冷却仍在」（第六轮评审 P3）；
      // 写 0 路径说的是「盘上还留着预写的那一段、重启后会多出一次冷却」——两句方向相反，不能混
      expect(failures[0]).toContain("输密码之前预写的那一段");
      expect(failures[0]).not.toContain("盘上还留着预写的那一段");
      expect(failures[0]).not.toContain("重启后会多出一次冷却");
    });

    it("重置冷却 resetUnlockCooldown 写 0 失败：日志说准、内存冷却已解除、不抛", async () => {
      const logs: string[] = [];
      const store = makeStore();
      store.save.mockImplementation((until: number) => {
        if (store.saved.length >= 2) throw new Error("磁盘只读");
        store.saved.push(until);
      });
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: async () => ({ ok: false, error: "x" }), log: (m) => logs.push(m) });
      await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
      expect(fx.session.status().unlockCooldownUntil).toBe(COOLDOWN());
      fx.session.resetUnlockCooldown();
      expect(fx.session.status().unlockCooldownUntil).toBe(0);
      const failures = failureLogs(logs);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("盘上还留着之前的那一段");
      expect(failures[0]).toContain("重启后冷却会重新出现");
      expect(failures[0]).not.toContain("内存里仍然生效");
    });
  });

  it("没传 cooldownStore（单测默认 / 旧调用方）：行为和以前一样，只放内存", async () => {
    const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, error: "x" }) });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  // 第四轮评审 P2：预写就是为了防「输密码途中崩溃、重启后冷却是空的、同一个（可能错的）密码再输一遍」。
  // 预写没落盘（磁盘只读 / 写满）时这层保护就没了——以前照样继续输密码。读到坏记录是 fail-closed，写失败也必须 fail-closed：
  // 不输密码、不解锁；这次一个键都没输过，所以不算「输错」：不进冷却、不发 unlock_failed（那会让 server 说「10 分钟内不再试」）。
  describe("预写冷却写盘失败：不输密码、不解锁，也不算输错", () => {
    /** state.failing 为 true 时 save 抛错（磁盘只读 / 写满），置回 false 就是磁盘恢复了 */
    const makeFailingStore = (thrown: unknown = new Error("磁盘只读")) => {
      const state = { failing: true };
      const store = makeStore();
      store.save.mockImplementation((until: number) => {
        if (state.failing) throw thrown;
        store.saved.push(until);
      });
      return { store, state };
    };
    const begin = (fx: ReturnType<typeof makeFixture>) => fx.session.begin("t1", { allowUnlock: true });

    it.each([
      ["Error", new Error("磁盘只读")],
      ["非 Error（字符串）", "磁盘已满"],
    ])("解锁器一个键都没碰：unlock 没被调用、电脑仍锁着；SCREEN_LOCKED，文案写明原因 / 没输过密码 / 请用户检查磁盘或亲自解锁（save 抛 %s）", async (_name, thrown) => {
      const logs: string[] = [];
      const { store } = makeFailingStore(thrown);
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk, log: (m) => logs.push(m) });
      const err = (await begin(fx).catch((e: unknown) => e)) as { code?: string; message?: string };
      expect(err.code).toBe("SCREEN_LOCKED");
      // 文案：AI 要能如实转告用户——冷却记录没写进去 / 为什么因此不能解锁 / 没输过密码 / 用户该怎么办
      for (const must of ["冷却记录", "磁盘", "崩溃", "没有自动解锁", "没有输入过开机密码", "检查磁盘空间", "亲自解锁"]) {
        expect(err.message, must).toContain(must);
      }
      expect(err.message?.length, "server 对详情最多留 300 个字符，要点不能被截掉").toBeLessThanOrEqual(300);
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
      expect(fx.world.locked).toBe(true);
      expect(fx.unlocker.lock, "没解过锁，不用锁回去").not.toHaveBeenCalled();
      const logText = logs.join("\n");
      expect(logText).toContain("冷却记录写不进去");
      expect(logText, "日志交代的是「这次不输密码」").toContain("不输密码");
      expect(logText, "冷却已回滚，日志不能再说「内存里仍然生效」误导排障").not.toContain("内存里仍然生效");
      expect(store.save, "只试了预写这一次：失败后没有再去「结算」或「进冷却」").toHaveBeenCalledTimes(1);
    });

    it("不算输错：status 不报冷却、会话回到 idle、没有 unlock_failed / unlocked 事件（尤其不能发 cooldown:true）", async () => {
      const { store } = makeFailingStore();
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk });
      await rejectCode(begin(fx));
      expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, unlockCooldownUntil: 0 });
      expect(fx.kinds()).not.toContain("unlock_failed");
      expect(fx.kinds()).not.toContain("unlocked");
      expect(fx.events.some((e) => e.cooldown === true)).toBe(false);
    });

    it("没有残留冷却：磁盘还没恢复时再请求一次，仍是「预写失败」（SCREEN_LOCKED），不会被一段不存在的冷却挡成 UNLOCK_FAILED", async () => {
      const { store } = makeFailingStore();
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk });
      expect(await rejectCode(begin(fx))).toBe("SCREEN_LOCKED");
      expect(await rejectCode(begin(fx))).toBe("SCREEN_LOCKED");
      expect(store.save, "第二次请求又去预写了一次（没有被「冷却中」挡在前面）").toHaveBeenCalledTimes(2);
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    });

    it("磁盘恢复之后：下一次请求能正常解锁；盘上只有这一次的「预写 → 解锁成功后撤销」（失败那次没留下冷却）", async () => {
      const { store, state } = makeFailingStore();
      const fx = makeFixture({ locked: true, cooldownStore: store, unlock: unlockOk });
      expect(await rejectCode(begin(fx))).toBe("SCREEN_LOCKED");
      state.failing = false;
      await expect(begin(fx)).resolves.toMatchObject({ unlockedByUs: true });
      expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
      expect(store.saved).toEqual([COOLDOWN(), 0]);
      expect(fx.session.status()).toMatchObject({ state: "active", unlockedByUs: true, unlockCooldownUntil: 0 });
    });

    it("先盖遮罩再解锁的解锁器（Windows 解锁组件）：已经盖上的遮罩要撤掉；没有这个声明的（macOS）连遮罩都没碰", async () => {
      const win = makeFailingStore();
      const first = makeFixture({ locked: true, overlayBeforeUnlock: true, cooldownStore: win.store, unlock: unlockOk });
      expect(await rejectCode(begin(first))).toBe("SCREEN_LOCKED");
      expect(first.calls, "先 show、后 hide，且没碰解锁器").toEqual(["overlay.show", "overlay.hide"]);

      const mac = makeFailingStore();
      const plain = makeFixture({ locked: true, cooldownStore: mac.store, unlock: unlockOk });
      expect(await rejectCode(begin(plain))).toBe("SCREEN_LOCKED");
      expect(plain.calls).toEqual([]);
    });

    it("后台档升级前台档（upgradeToForeground）走的是同一条路：预写失败 → SCREEN_LOCKED，仍是后台会话、没输密码、遮罩撤掉", async () => {
      const { store } = makeFailingStore();
      const fx = makeFixture({ locked: true, background: true, overlayBeforeUnlock: true, cooldownStore: store, unlock: unlockOk });
      await begin(fx); // 后台档开始：不解锁、不碰冷却记录
      expect(fx.session.status()).toMatchObject({ state: "active", mode: "background" });
      expect(store.save).not.toHaveBeenCalled();
      fx.calls.length = 0;
      expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
      expect(fx.calls).toEqual(["overlay.show", "overlay.hide"]);
      expect(fx.session.status()).toMatchObject({ state: "active", mode: "background", unlockCooldownUntil: 0 });
    });
  });
});

// 读不到「电脑现在是不是锁屏」（驱动返回 null）= 不知道，不能当「没锁」放行（第二轮评审 P1-2）：
// 解锁器对 null 一直是「为安全起见不介入」，而会话的前台输入以前对 null 放行——macOS 上键鼠注入会直接落进锁屏界面的密码框。
// 后台档（Windows 锁屏后台）的口径不变：它的前提就是锁着，读不到状态不动它（见上面「读不到锁屏状态（null）：不乱结束后台会话」）。
describe("读不到锁屏状态（null / undefined）：前台档不放行，口径与解锁器一致", () => {
  it.each([[null], [undefined]])("开始：%s → INTERNAL，不解锁、不盖遮罩、不碰凭据，状态回到 idle", async (unknown) => {
    const fx = makeFixture();
    fx.world.locked = unknown as never;
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("INTERNAL");
    expect(fx.unlocker.hasCredential).not.toHaveBeenCalled();
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
  });

  it("开始：错误信息写明原因，让模型照实告诉用户（别重试成灾）", async () => {
    const fx = makeFixture();
    fx.world.locked = null;
    await expect(fx.session.begin("t1", { allowUnlock: true })).rejects.toThrow(/读不到电脑当前是不是锁屏状态/);
  });

  it("开始：有锁屏后台档（Windows）时同样不开始——不知道是不是锁着，就不去对它注入", async () => {
    const fx = makeFixture({ background: true });
    fx.world.locked = null;
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("INTERNAL");
    expect(fx.session.status().state).toBe("idle");
    expect(fx.background.reset).not.toHaveBeenCalled();
  });

  it("开始：读不到不进冷却、不留下任何残局；读得到了马上就能开始", async () => {
    const fx = makeFixture();
    fx.world.locked = null;
    await rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
    fx.world.locked = false;
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: false, locked: false });
  });

  it("动作前检查（前台会话）：读不到 → 这一下不放行（INTERNAL、动作没执行），会话不结束；读到「没锁」就照常继续", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    const act = vi.fn(async () => "done");
    fx.world.locked = null;
    expect(await rejectCode(fx.session.runAction("t1", act))).toBe("INTERNAL");
    expect(await rejectCode(fx.session.runRead("t1", act))).toBe("INTERNAL");
    expect(act).not.toHaveBeenCalled();
    expect(fx.session.status().state).toBe("active");
    expect(fx.events.find((e) => e.kind === "session_ended")).toBeUndefined();

    fx.world.locked = false;
    await expect(fx.session.runAction("t1", act)).resolves.toBe("done");
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("动作前检查（前台会话）：读不到不算「有动作」，一直读不到会被空闲看门狗收掉", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    // 用户一直没碰键鼠：「空闲秒数」随时钟一起涨（固定值会在快进时被看成用户在动）
    const t0 = Date.now();
    fx.driver.idleSeconds.mockImplementation(() => 100 + (Date.now() - t0) / 1000);
    fx.world.locked = null;
    expect(await rejectCode(fx.session.runAction("t1", async () => "x"))).toBe("INTERNAL");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.idleEndMs + 1000);
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "idle" });
  });

  it("读不到时仍是「别人读得到就按读得到的来」：没锁屏的前台会话照常工作，明确锁屏照常结束（口径没被放宽也没被收紧）", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await expect(fx.session.runAction("t1", async () => "ok")).resolves.toBe("ok");
    fx.world.locked = true;
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
  });

  it("后台档升级前台：读不到 → INTERNAL，不去解锁（不依赖解锁器自己拒绝），仍是后台会话；读得到锁着就能升级", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.calls.length = 0;
    fx.world.locked = null;
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("INTERNAL");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "background" });
    expect(fx.session.status().unlockCooldownUntil).toBe(0);

    fx.world.locked = true;
    await expect(fx.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toMatchObject({ upgraded: true, mode: "foreground" });
  });
});

// 前台会话期间不让显示器睡眠（第二轮评审）：睡了会锁屏（会话被 relocked_externally 打断）、之后的截图是黑的。
// 只在前台档 active 期间持有；收尾 / 用户接管 / 应用退出 / 出错的每条路都要释放，且释放幂等（不能泄漏成「显示器永远不睡」）
describe("防显示器睡眠（keepAwake）", () => {
  const makeAwake = () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    return { keepAwake: { acquire }, acquire, release };
  };

  it("前台会话开始时持有一次、结束时释放一次（没锁屏 / 我们解锁的都一样）", async () => {
    for (const locked of [false, true]) {
      const a = makeAwake();
      const fx = makeFixture({ locked, keepAwake: a.keepAwake });
      expect(a.acquire).not.toHaveBeenCalled();
      await fx.session.begin("t1", { allowUnlock: true });
      expect(a.acquire).toHaveBeenCalledTimes(1);
      expect(a.release).not.toHaveBeenCalled();
      await fx.session.begin("t1", { allowUnlock: true }); // 续用：不重复持有
      expect(a.acquire).toHaveBeenCalledTimes(1);
      await fx.session.end("task_done");
      expect(a.release).toHaveBeenCalledTimes(1);
    }
  });

  it("没拿到会话（开始被拒 / 解锁失败 / 读不到锁屏状态）：根本不持有", async () => {
    const denied = makeAwake();
    const d = makeFixture({ locked: true, policy: { lockedAccess: false }, keepAwake: denied.keepAwake });
    await rejectCode(d.session.begin("t1", { allowUnlock: true }));
    const failed = makeAwake();
    const f = makeFixture({ locked: true, keepAwake: failed.keepAwake, unlock: async () => ({ ok: false, error: "x" }) });
    await rejectCode(f.session.begin("t1", { allowUnlock: true }));
    const unknown = makeAwake();
    const u = makeFixture({ keepAwake: unknown.keepAwake });
    u.world.locked = null;
    await rejectCode(u.session.begin("t1", { allowUnlock: true }));
    for (const a of [denied, failed, unknown]) {
      expect(a.acquire).not.toHaveBeenCalled();
      expect(a.release).not.toHaveBeenCalled();
    }
  });

  it("锁屏后台档（Windows）不持有（电脑本来就锁着）；升级成前台档的那一刻才持有，结束时释放", async () => {
    const a = makeAwake();
    const fx = makeFixture({ locked: true, background: true, keepAwake: a.keepAwake });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(fx.session.status().mode).toBe("background");
    expect(a.acquire).not.toHaveBeenCalled();
    await fx.session.upgradeToForeground("t1", { allowUnlock: true });
    expect(a.acquire).toHaveBeenCalledTimes(1);
    await fx.session.end("task_done");
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("后台档升级失败（解锁没成）：不持有；后台会话结束时也没有东西要释放", async () => {
    const a = makeAwake();
    const fx = makeFixture({ locked: true, background: true, keepAwake: a.keepAwake, unlock: async () => ({ ok: false, error: "x" }) });
    await fx.session.begin("t1", { allowUnlock: true });
    await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }));
    await fx.session.end("task_done");
    expect(a.acquire).not.toHaveBeenCalled();
    expect(a.release).not.toHaveBeenCalled();
  });

  it.each([
    ["用户接管", async (fx: ReturnType<typeof makeFixture>) => {
      fx.world.idle = 0.05;
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    }],
    ["空闲超时", async (fx: ReturnType<typeof makeFixture>) => {
      const t0 = Date.now();
      fx.driver.idleSeconds.mockImplementation(() => 100 + (Date.now() - t0) / 1000);
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.idleEndMs + 1000);
    }],
    ["总开关被关", async (fx: ReturnType<typeof makeFixture>) => {
      fx.world.policy.enabled = false;
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    }],
    ["显式 end", async (fx: ReturnType<typeof makeFixture>) => {
      await fx.session.end("explicit");
    }],
  ])("%s：会话结束就释放，恰好一次", async (_name, trigger) => {
    const a = makeAwake();
    const fx = makeFixture({ keepAwake: a.keepAwake });
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    await trigger(fx);
    expect(fx.session.status().state).toBe("idle");
    expect(a.acquire).toHaveBeenCalledTimes(1);
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("应用退出（destroy）：同步释放，之后再 end 也不会重复释放", async () => {
    const a = makeAwake();
    const fx = makeFixture({ keepAwake: a.keepAwake });
    await fx.session.begin("t1");
    fx.session.destroy();
    expect(a.release).toHaveBeenCalledTimes(1);
    await fx.session.end("app_quit");
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("收尾中出意外（锁屏确认时 isScreenLocked 一直抛）：照样释放，不会泄漏成「显示器永远不睡」", async () => {
    const a = makeAwake();
    const fx = makeFixture({ locked: true, keepAwake: a.keepAwake });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.driver.isScreenLocked.mockImplementation(() => {
      throw new Error("读锁屏状态炸了");
    });
    const ended = fx.session.end("task_done");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.relockWaitMs * 2 + 500);
    await ended;
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it("下一个会话重新持有：每个会话各持有 / 释放一次", async () => {
    const a = makeAwake();
    const fx = makeFixture({ keepAwake: a.keepAwake });
    await fx.session.begin("t1");
    await fx.session.end("task_done");
    await fx.session.begin("t2");
    await fx.session.end("task_done");
    expect(a.acquire).toHaveBeenCalledTimes(2);
    expect(a.release).toHaveBeenCalledTimes(2);
  });

  it("acquire 抛错：只记日志，会话照常；release 抛错：只记日志，收尾照常", async () => {
    const logs: string[] = [];
    const bad = makeFixture({
      keepAwake: {
        acquire: () => {
          throw new Error("系统不让");
        },
      },
      log: (m) => logs.push(m),
    });
    await expect(bad.session.begin("t1")).resolves.toMatchObject({ locked: false });
    expect(logs.join("\n")).toContain("防显示器睡眠没能开启");
    await expect(bad.session.end("task_done")).resolves.toBeTruthy();

    const badRelease = makeFixture({
      keepAwake: {
        acquire: () => () => {
          throw new Error("放不掉");
        },
      },
      log: (m) => logs.push(m),
    });
    await badRelease.session.begin("t1");
    await expect(badRelease.session.end("task_done")).resolves.toBeTruthy();
    expect(logs.join("\n")).toContain("防显示器睡眠没能解除");
    expect(badRelease.session.status().state).toBe("idle");
  });

  it("acquire 没返回释放函数 / 没注入 keepAwake：什么都不发生", async () => {
    const none = makeFixture();
    await none.session.begin("t1");
    await expect(none.session.end("task_done")).resolves.toBeTruthy();
    const noFn = makeFixture({ keepAwake: { acquire: () => undefined } });
    await noFn.session.begin("t1");
    await expect(noFn.session.end("task_done")).resolves.toBeTruthy();
  });
});

// 读的过程中会话结束了：读到的内容不再交给 AI（第二轮评审「收尾期间截图仍返回」）。
// manager 的 storeFrame 只在 session_ended / user_took_over 事件发出后才作废截图，收尾中（ending，最长 drain + 两次锁屏等待）飞着的读取没人拦
describe("只读动作的结果：会话已经结束就作废", () => {
  it("正常：会话还在，读到什么就返回什么", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await expect(fx.session.runRead("t1", async () => "shot")).resolves.toBe("shot");
  });

  it("读的过程中开始收尾（state=ending，事件还没发出）：结果作废，SESSION_EXPIRED", async () => {
    // 锁回去的那一步卡住，让会话停在 ending：这段窗口里飞着的截图以前照样返回
    let releaseLock!: () => void;
    const fx = makeFixture({
      locked: true,
      lock: (world) =>
        new Promise((resolve) => {
          releaseLock = () => {
            world.locked = true;
            resolve({ ok: true });
          };
        }),
    });
    await fx.session.begin("t1", { allowUnlock: true });
    let finishRead!: (v: string) => void;
    const read = fx.session.runRead("t1", () => new Promise<string>((resolve) => (finishRead = resolve)));
    const ended = fx.session.end("task_done");
    await flush();
    expect(fx.session.status().state).toBe("ending");

    finishRead("screenshot-of-user-desktop");
    expect(await rejectCode(read)).toBe("SESSION_EXPIRED");

    releaseLock();
    await ended;
  });

  it("读的过程中会话结束、又开了新会话（世代变了）：旧会话里飞着的读取结果同样作废，不会混进新会话", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    let finishRead!: (v: string) => void;
    const read = fx.session.runRead("t1", () => new Promise<string>((resolve) => (finishRead = resolve)));
    await fx.session.end("task_done");
    await fx.session.begin("t2");
    expect(fx.session.status()).toMatchObject({ state: "active", taskId: "t2" });
    finishRead("stale-shot");
    expect(await rejectCode(read)).toBe("SESSION_EXPIRED");
  });

  it("读到一半后台档升级前台档（state=unlocking 是中间态，不是结束）：不误伤，结果照常返回", async () => {
    let finishUnlock!: () => void;
    const fx = makeFixture({
      locked: true,
      background: true,
      unlock: (_ctx, world) =>
        new Promise((resolve) => {
          finishUnlock = () => {
            world.locked = false;
            resolve({ ok: true });
          };
        }),
    });
    await fx.session.begin("t1", { allowUnlock: true });
    let finishRead!: (v: string) => void;
    const read = fx.session.runRead("t1", () => new Promise<string>((resolve) => (finishRead = resolve)));
    const upgrade = fx.session.upgradeToForeground("t1", { allowUnlock: true });
    await flush();
    expect(fx.session.status().state).toBe("unlocking");
    finishRead("bg-shot");
    await expect(read).resolves.toBe("bg-shot");
    finishUnlock();
    await upgrade;
  });

  it("读取自己抛错：原样抛出（不被改写成 SESSION_EXPIRED），会话不受影响", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await expect(fx.session.runRead("t1", async () => {
      throw new Error("截图失败");
    })).rejects.toThrow("截图失败");
    expect(fx.session.status().state).toBe("active");
  });
});

describe("并发", () => {
  it("同任务并发开始：只解锁一次，两边都成功", async () => {
    const fx = makeFixture({ locked: true });
    const [a, b] = await Promise.all([
      fx.session.begin("t1", { allowUnlock: true }),
      fx.session.begin("t1", { allowUnlock: true }),
    ]);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(a.unlockedByUs).toBe(true);
    expect(b.unlockedByUs).toBe(true);
  });

  it("会话被另一个任务占着：DENIED", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    expect(await rejectCode(fx.session.begin("t2"))).toBe("DENIED");
    expect(fx.session.status().taskId).toBe("t1");
  });

  it("t1 正在解锁时 t2 来开始：DENIED，且不会多解锁一次", async () => {
    const fx = makeFixture({ locked: true });
    const p1 = fx.session.begin("t1", { allowUnlock: true });
    const code = await rejectCode(fx.session.begin("t2", { allowUnlock: true }));
    await p1;
    expect(code).toBe("DENIED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("解锁过程中被取消：通知解锁器停手，等它收尾；刚解开的锁回去；不会复活成 active", async () => {
    let release!: (r: UnlockResult) => void;
    let aborted = false;
    const fx = makeFixture({
      locked: true,
      unlock: (ctx) =>
        new Promise<UnlockResult>((resolve) => {
          ctx.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          release = resolve;
        }),
    });
    const begun = fx.session.begin("t1", { allowUnlock: true });
    const begunCode = rejectCode(begun);
    await flush();
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);

    const ended = fx.session.end("cancelled");
    await flush();
    expect(aborted).toBe(true);
    // 解锁器还没返回：end 不能先跑完（否则新会话可能和还在输密码的旧解锁撞车）
    expect(fx.session.status().state).toBe("ending");

    // 解锁器报告「其实已经解开了」：必须锁回去
    fx.world.locked = false;
    release({ ok: true });
    expect(await begunCode).toBe("CANCELLED");
    await ended;

    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
    // 锁回去了就要如实告诉用户（旧版这条路径什么事件都不发）
    expect(fx.events.find((e) => e.kind === "relocked")).toMatchObject({ taskId: "t1", reason: "cancelled" });
    // 解开了的取消不是「输错」：不进冷却、不报解锁失败
    expect(fx.events.some((e) => e.kind === "unlock_failed")).toBe(false);
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
  });

  it("解锁过程中被取消，刚解开的却锁不回去：发 relock_failed，用户才知道电脑还开着", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = makeFixture({
      locked: true,
      unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)),
      lock: async () => ({ ok: false, error: "系统拒绝了锁屏" }),
    });
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    await flush();
    fx.world.locked = false;
    release({ ok: true });
    expect(await begunCode).toBe("CANCELLED");
    await ended;
    expect(fx.events.find((e) => e.kind === "relock_failed")).toMatchObject({ taskId: "t1", reason: "cancelled", error: "系统拒绝了锁屏" });
    expect(fx.events.some((e) => e.kind === "relocked")).toBe(false);
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
  });

  it("解锁过程中被取消，但解锁器报告失败（没解开）：不锁、不发 relock 事件", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = makeFixture({ locked: true, unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    await flush();
    release({ ok: false, error: "没解开", attempted: false });
    expect(await begunCode).toBe("CANCELLED");
    await ended;
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.events.some((e) => e.kind === "relocked" || e.kind === "relock_failed")).toBe(false);
    // 密码根本没输过（attempted: false）：不算输错，不进冷却、不报解锁失败——用户自己取消的，不该被说成「解锁失败」
    expect(fx.events.some((e) => e.kind === "unlock_failed")).toBe(false);
    expect(fx.session.status().unlockCooldownUntil).toBe(0);
  });

  it("解锁过程中被取消，密码已经输进去过却没解开（attempted: true）：和输错一样进冷却、发 unlock_failed，下一次不会立刻再输（评审 #5）", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = makeFixture({ locked: true, unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    await flush();
    release({ ok: false, error: "提交后验证被打断", attempted: true });
    expect(await begunCode).toBe("CANCELLED");
    await ended;

    expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({
      taskId: "t1",
      cooldown: true,
      error: "提交后验证被打断",
    });
    expect(fx.session.status().unlockCooldownUntil).toBeGreaterThan(0);
    // 没解开：不锁屏、不发 relock 事件
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.events.some((e) => e.kind === "relocked" || e.kind === "relock_failed")).toBe(false);
    // 下一次请求：冷却内直接拒绝，不会再去输一遍密码
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("取消时解锁器没说 attempted（旧实现 / 异常）：按「输过了」处理，同样进冷却；没带 error 时给一句默认说明", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = makeFixture({ locked: true, unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    await flush();
    release({ ok: false } as UnlockResult);
    expect(await begunCode).toBe("CANCELLED");
    await ended;

    const failed = fx.events.find((e) => e.kind === "unlock_failed");
    expect(failed).toMatchObject({ taskId: "t1", cooldown: true });
    expect(String((failed as { error?: unknown }).error)).toContain("被中途取消");
    expect(fx.session.status().unlockCooldownUntil).toBeGreaterThan(0);
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("取消时解锁器抛异常：同样当作输过密码，进冷却", async () => {
    let fail!: (e: Error) => void;
    const fx = makeFixture({
      locked: true,
      unlock: () => new Promise<UnlockResult>((_resolve, reject) => (fail = reject)),
    });
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    await flush();
    fail(new Error("boom"));
    expect(await begunCode).toBe("CANCELLED");
    await ended;

    expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ cooldown: true });
    expect(fx.session.status().unlockCooldownUntil).toBeGreaterThan(0);
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("取消发生在查凭据的时候（还没开始输密码）：直接 CANCELLED，不解锁", async () => {
    let releaseCred!: (v: boolean) => void;
    const fx = makeFixture({ locked: true });
    fx.unlocker.hasCredential.mockImplementation(() => new Promise<boolean>((resolve) => (releaseCred = resolve)));
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    releaseCred(true);
    expect(await begunCode).toBe("CANCELLED");
    await ended;
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.session.status().state).toBe("idle");
  });
});

describe("动作守卫 guard", () => {
  it("没有会话：SESSION_EXPIRED；不是持有者：DENIED", async () => {
    const fx = makeFixture();
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
    await fx.session.begin("t1");
    expect(codeOf(() => fx.session.guard("t2"))).toBe("DENIED");
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
  });

  it("会话中电脑被锁屏（屏保 / 手动锁）：结束会话、不重复锁；再次开始会重新解锁", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.world.locked = true;
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
    await fx.session.end("noop");
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.session.status().state).toBe("idle");

    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(2);
  });
});

describe("用户接管（差值法）", () => {
  it("注入之后用户又动了键鼠：guard 抛 USER_TOOK_OVER，结束会话，不锁屏、撤遮罩", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05; // 50ms 前有键鼠输入，而我们最后一次注入是 1 秒前
    expect(codeOf(() => fx.session.guard("t1"))).toBe("USER_TOOK_OVER");
    await fx.session.end("noop");

    expect(fx.unlocker.lock).not.toHaveBeenCalled(); // 用户就在电脑前，不锁
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.kinds()).toContain("user_took_over");
    expect(fx.session.status().state).toBe("idle");
  });

  it("接管事件带 unlockedByUs：电脑是我们解锁的 → true（server 据此提醒「电脑没重新锁」）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    expect(codeOf(() => fx.session.guard("t1"))).toBe("USER_TOOK_OVER");
    await fx.session.end("noop");
    expect(fx.events.find((e) => e.kind === "user_took_over")).toMatchObject({ taskId: "t1", unlockedByUs: true });
    // 接管时不锁屏（用户就在电脑前）：这正是要提醒的缺口
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.world.locked).toBe(false);
  });

  it("接管事件：本来就没锁屏（没解锁过）→ unlockedByUs 是 false", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.events.find((e) => e.kind === "user_took_over")).toMatchObject({ unlockedByUs: false });
  });

  it("看门狗自己也能发现（不用等下一次动作）", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.session.status().state).toBe("idle");
    expect(fx.kinds()).toContain("user_took_over");
  });

  it("用户在会话开始之前的输入不算接管", async () => {
    const fx = makeFixture({ idle: 5 }); // 5 秒前动过，会话刚开始
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 6; // 时间在走，最后一次输入仍是会话开始前
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
    expect(fx.session.status().state).toBe("active");
  });

  it("动作进行中不判接管（那时的 idle 全是我们自己造成的），结束后留出宽限", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    await fx.session.runAction("t1", async () => {
      fx.world.idle = 0.01;
      await vi.advanceTimersByTimeAsync(2000); // 期间看门狗跑了好几轮
      expect(fx.session.status().state).toBe("active");
    });
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
    expect(fx.session.status().state).toBe("active");
  });

  it("只读动作（截图）期间用户动了：看门狗让位（会话结束）；读到的内容作废（SESSION_EXPIRED），不再交给 AI", async () => {
    // 以前这里钉的是「只读动作本身照常返回」——用户接管了、会话都结束了，AI 仍拿到这张屏幕画面。
    // manager 层的 storeFrame 虽会在 user_took_over 之后作废截图，但 desktop_apps 这类读取、以及「收尾中（ending）但事件还没发出」的窗口里没有人拦（第二轮评审）
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    const read = fx.session.runRead("t1", async () => {
      fx.world.idle = 0.05;
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
      return "screenshot";
    });
    expect(await rejectCode(read)).toBe("SESSION_EXPIRED");
    expect(fx.session.status().state).toBe("idle");
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
  });

  it("用户接管后：用户还在动就不让 AI 重新开始，停手满 30 秒才恢复", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.session.status().state).toBe("idle");

    fx.world.idle = 5; // 用户 5 秒前还在动
    expect(await rejectCode(fx.session.begin("t1"))).toBe("USER_TOOK_OVER");
    fx.world.idle = SESSION_LIMITS.takeoverQuietMs / 1000 + 1;
    await expect(fx.session.begin("t1")).resolves.toMatchObject({ locked: false });
  });
});

describe("看门狗：超时 / 关闭 / 结束", () => {
  it("空闲超时：没解锁过 → 结束但不锁屏", async () => {
    const fx = makeFixture({ limits: { idleEndMs: 5000 } });
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(5000 + SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.session.status().state).toBe("idle");
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "idle", unlockedByUs: false });
  });

  it("空闲超时：我们解锁的 → 锁回去，先锁屏再撤遮罩", async () => {
    const fx = makeFixture({ locked: true, limits: { idleEndMs: 5000 } });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(5000 + SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.session.status().state).toBe("idle");
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.calls).toEqual(["unlock", "overlay.show", "lock", "overlay.hide"]);
    expect(fx.kinds()).toEqual(["unlocking", "unlocked", "relocked", "session_ended"]);
  });

  it("动作会给会话续期，不会在忙的时候被判空闲", async () => {
    const fx = makeFixture({ limits: { idleEndMs: 5000 } });
    await fx.session.begin("t1");
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(3000);
      fx.world.idle = 100;
      fx.session.guard("t1");
    }
    expect(fx.session.status().state).toBe("active");
  });

  it("硬上限：一直在忙也必须到点结束", async () => {
    const fx = makeFixture({ limits: { maxSessionMs: 10_000, idleEndMs: 60_000 } });
    await fx.session.begin("t1");
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(3000);
      fx.world.idle = 100;
      if (fx.session.status().active) fx.session.guard("t1");
    }
    expect(fx.session.status().state).toBe("idle");
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "max_duration" });
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
  });

  it("总开关被关掉：看门狗发现后结束，并把我们解锁的电脑锁回去", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.world.policy.enabled = false;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.session.status().state).toBe("idle");
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "disabled", relocked: true });
  });

  it("end 幂等；并发 end 共用一次收尾，只锁一次", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    const [a, b] = await Promise.all([fx.session.end("task_done"), fx.session.end("explicit")]);
    expect(a).toEqual(b);
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: false });
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
  });

  it("锁屏命令失败：发 relock_failed，遮罩照撤，状态回 idle", async () => {
    const fx = makeFixture({ locked: true, lock: async () => ({ ok: false, error: "系统拒绝了锁屏" }) });
    await fx.session.begin("t1", { allowUnlock: true });
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: false });
    expect(fx.events.find((e) => e.kind === "relock_failed")).toMatchObject({ error: "系统拒绝了锁屏" });
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.session.status().state).toBe("idle");
  });

  it("命令发出了但电脑没进入锁屏（两种方式都试过）：同样算失败（用户回来要被告知）", async () => {
    const methods: Array<string | undefined> = [];
    const fx = makeFixture({
      locked: true,
      lock: async (_world, opts) => {
        methods.push(opts.method);
        return { ok: true }; // 不改 world.locked
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    const ended = fx.session.end("task_done");
    // 每次尝试各等 relockWaitMs：默认方式一次、快捷键兜底一次
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.relockWaitMs * 2 + 500);
    await expect(ended).resolves.toEqual({ relocked: false });
    expect(methods).toEqual(["auto", "shortcut"]);
    expect(fx.events.find((e) => e.kind === "relock_failed")).toMatchObject({ reason: "task_done", error: "已发出锁屏命令，但电脑没有进入锁屏状态" });
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.session.status().state).toBe("idle");
  });

  it("第一次没锁上：换快捷键兜底再试一次，成功就算锁上了（relocked，不是 relock_failed）", async () => {
    const methods: Array<string | undefined> = [];
    const fx = makeFixture({
      locked: true,
      lock: async (world, opts) => {
        methods.push(opts.method);
        if (opts.method === "shortcut") world.locked = true; // 默认方式「发出了但没生效」，快捷键生效
        return { ok: true };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    const ended = fx.session.end("task_done");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.relockWaitMs + 500);
    await expect(ended).resolves.toEqual({ relocked: true });
    expect(methods).toEqual(["auto", "shortcut"]);
    expect(fx.kinds()).toEqual(["unlocking", "unlocked", "relocked", "session_ended"]);
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ relocked: true });
    // 遮罩在锁屏确认之后才撤
    expect(fx.calls).toEqual(["unlock", "overlay.show", "lock", "lock", "overlay.hide"]);
  });

  it("默认方式的命令本身就失败了：不用干等 3 秒，立刻换快捷键", async () => {
    const methods: Array<string | undefined> = [];
    const fx = makeFixture({
      locked: true,
      lock: async (world, opts) => {
        methods.push(opts.method);
        if (opts.method === "auto") return { ok: false, error: "SACLockScreenImmediate 不可用" };
        world.locked = true;
        return { ok: true };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    // 不推进任何定时器：命令失败是同步可知的，不该白等
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: true });
    expect(methods).toEqual(["auto", "shortcut"]);
  });

  it("默认方式抛异常：按失败处理、继续试快捷键；两次都失败则报最后一次的原因", async () => {
    const fx = makeFixture({
      locked: true,
      lock: async (_world, opts) => {
        if (opts.method === "auto") throw new Error("koffi 崩了");
        return { ok: false, error: "快捷键也被拒绝" };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: false });
    expect(fx.events.find((e) => e.kind === "relock_failed")).toMatchObject({ error: "快捷键也被拒绝" });
  });

  it("命令返回了错误、但电脑其实已经锁上了：不再多按一次快捷键（别把已锁的屏再折腾一遍）", async () => {
    const methods: Array<string | undefined> = [];
    const fx = makeFixture({
      locked: true,
      lock: async (world, opts) => {
        methods.push(opts.method);
        world.locked = true;
        return { ok: false, error: "返回了错误码，但屏确实锁上了" };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: true });
    expect(methods).toEqual(["auto"]);
  });

  it("用户接管（relock:false）和没解锁过：不锁，也不多试", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await fx.session.end("user_took_over", { relock: false });
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    const plain = makeFixture();
    await plain.session.begin("t1");
    await plain.session.end("task_done");
    expect(plain.unlocker.lock).not.toHaveBeenCalled();
  });

  it("endForTask 只对持有者生效", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await fx.session.endForTask("t2", "cancelled");
    expect(fx.session.status().state).toBe("active");
    await fx.session.endForTask("t1", "cancelled");
    expect(fx.session.status().state).toBe("idle");
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
  });

  it("destroy（应用退出）：同步撤遮罩 + 同步锁屏（只在我们解锁过时）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.session.destroy();
    expect(fx.overlay.hide).toHaveBeenCalledTimes(1);
    expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);
    expect(fx.session.status().state).toBe("idle");

    const plain = makeFixture();
    await plain.session.begin("t1");
    plain.session.destroy();
    expect(plain.driver.lockScreen).not.toHaveBeenCalled();
  });

  // 第三轮评审：解锁进行中退出——unlock() 没人等了，电脑可能马上（甚至已经）被解开，可此刻 unlockedByUs 还是 false
  describe("destroy 发生在「正在解锁」时", () => {
    const startHungUnlock = async (init: { log?: (m: string) => void } = {}) => {
      const fx = makeFixture({ locked: true, unlock: () => new Promise<never>(() => {}), log: init.log });
      void fx.session.begin("t1", { allowUnlock: true }).catch(() => {});
      await flush();
      expect(fx.session.status().state).toBe("unlocking");
      return fx;
    };

    it("退出时电脑已经被解开了：同步发锁屏命令（不能把电脑留在「已解锁、没遮罩、人不在」）", async () => {
      const fx = await startHungUnlock();
      fx.world.locked = false;
      fx.session.destroy();
      expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);
      expect(fx.overlay.hide).toHaveBeenCalled();
      expect(fx.session.status().state).toBe("idle");
    });

    it("退出时读不到锁屏状态（null）：宁可多锁一次", async () => {
      const fx = await startHungUnlock();
      fx.world.locked = null;
      fx.session.destroy();
      expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);
    });

    it("退出时电脑仍然锁着：不用动（没解开就不发锁屏命令）", async () => {
      const fx = await startHungUnlock();
      expect(fx.world.locked).toBe(true);
      fx.session.destroy();
      expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    });

    it("没在解锁（空闲 / 只是 active 的没锁屏会话）时 destroy：不凭空发锁屏命令", async () => {
      const idle = makeFixture();
      idle.session.destroy();
      expect(idle.driver.lockScreen).not.toHaveBeenCalled();
      const active = makeFixture();
      await active.session.begin("t1");
      active.world.locked = false;
      active.session.destroy();
      expect(active.driver.lockScreen).not.toHaveBeenCalled();
    });

    it("锁屏命令异步失败：留一行日志，不再静默吞掉、也不抛未处理的 rejection", async () => {
      const logs: string[] = [];
      const fx = await startHungUnlock({ log: (m) => logs.push(m) });
      fx.world.locked = false;
      fx.driver.lockScreen.mockImplementation(() => Promise.reject(new Error("锁屏接口挂了（测试注入）")));
      fx.session.destroy();
      await flush();
      expect(logs.join("\n")).toContain("退出时锁屏失败：锁屏接口挂了（测试注入）");
    });
  });
});

// 第三轮评审 P1-3：打字过程中电脑被锁屏。guard 只在动作开始时看一眼，desktop_type 要打约 2 秒——
// 锁屏发生在中途，剩下的字（和 submit 的回车）会落进锁屏界面的密码框 = 一次错误登录，还不进冷却。看门狗必须自己发现锁屏。
describe("看门狗发现会话进行中被锁屏", () => {
  it("前台会话中电脑被锁屏（屏保 / 手动锁）：不等下一次动作，看门狗自己结束会话——不重复锁屏、撤遮罩、shouldStop 变真", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fx.session.shouldStop()).toBe(false);

    fx.world.locked = true; // 屏保 / 手动锁
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);

    expect(fx.session.status().state).toBe("idle");
    expect(fx.session.shouldStop()).toBe(true);
    expect(fx.unlocker.lock, "已经是锁屏状态，不该再发锁屏命令").not.toHaveBeenCalled();
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "relocked_externally", relocked: false });
  });

  it("动作进行中（acting > 0）照样检查：打字打到一半被锁屏，输入循环的 shouldStop 在下一个批次就变真", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    const stops: boolean[] = [];
    await fx.session.runAction("t1", async ({ shouldStop }) => {
      stops.push(shouldStop());
      fx.world.locked = true; // 打字期间锁屏
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50); // 看门狗跑了一轮
      stops.push(shouldStop());
    });
    expect(stops).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(200); // 收尾等在飞动作停手的轮询
    expect(fx.session.status().state).toBe("idle");
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "relocked_externally" });
  });

  it("读不到锁屏状态（null / 驱动抛错）：看门狗不结束会话（与 guard 的口径一致——那边只是这一下不放行）", async () => {
    for (const mode of ["null", "throw"] as const) {
      const fx = makeFixture();
      await fx.session.begin("t1");
      await vi.advanceTimersByTimeAsync(1000);
      if (mode === "null") fx.world.locked = null;
      else fx.driver.isScreenLocked.mockImplementation(() => {
        throw new Error("读锁屏状态出错");
      });
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 3);
      expect(fx.session.status().state, mode).toBe("active");
    }
  });

  it("没锁屏（false）：照常，不误结束", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 5);
    expect(fx.session.status().state).toBe("active");
  });

  it("锁屏后台档：电脑本来就锁着，看门狗不看锁屏（会话照常活着）", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(fx.session.status().mode).toBe("background");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 5);
    expect(fx.session.status().state).toBe("active");
  });

  it("用户接管优先于锁屏判断：用户按快捷键锁屏时（有输入）按「用户接管」处理，30 秒静默期照常生效", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05; // 用户刚按了键
    fx.world.locked = true;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "user_took_over" });
    // 静默期：用户还在动，AI 不抢
    fx.world.idle = 5;
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("USER_TOOK_OVER");
  });
});

// 第三轮评审（overlay 补建失败）：会话中途接入显示器 / 改分辨率之后，那块屏幕的遮罩窗口建不出来——以前只记一行日志，
// 那块屏幕裸着，旁人看得见 AI 在干什么，而用户不在场、上层毫不知情。和「解锁后遮罩盖不上就锁回去」同口径：看门狗发现就结束并锁回去。
describe("看门狗发现遮罩盖不全（会话中途新增显示器 / 重建失败）", () => {
  it("我们解锁的前台会话：遮罩盖不全 → 一个轮询周期内结束并锁回去、撤遮罩、事件说明原因", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fx.session.status().state).toBe("active");

    fx.world.overlayComplete = false; // 副屏接入、遮罩窗口建不出来
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.relockWaitMs); // relock 确认

    expect(fx.session.status().state).toBe("idle");
    expect(fx.session.shouldStop()).toBe(true);
    expect(fx.unlocker.lock, "没有遮罩的屏幕 + 人不在：必须锁回去").toHaveBeenCalled();
    expect(fx.world.locked).toBe(true);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({
      reason: "overlay_incomplete",
      unlockedByUs: true,
      relocked: true,
    });
    expect(fx.events.find((e) => e.kind === "relocked")).toMatchObject({ reason: "overlay_incomplete" });
  });

  it("遮罩盖全了：会话照常活着（不误结束）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 5);
    expect(fx.overlay.isComplete).toHaveBeenCalled(); // 确实在查
    expect(fx.session.status().state).toBe("active");
  });

  it("用户在场的会话（电脑本来没锁、不是我们解的锁、没有遮罩）：不看遮罩，不因为它结束", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    expect(fx.session.status().unlockedByUs).toBe(false);
    fx.world.overlayComplete = false;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 5);
    expect(fx.session.status().state).toBe("active");
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
  });

  it("锁屏后台档：没有遮罩，不看", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(fx.session.status().mode).toBe("background");
    fx.world.overlayComplete = false;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 5);
    expect(fx.session.status().state).toBe("active");
  });

  it("探测本身出问题（抛错 / 遮罩实现没有 isComplete）：当没问题，不为一次读不到结束会话", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.world.overlayProbeThrows = true;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 3);
    expect(fx.session.status().state).toBe("active");

    fx.world.overlayProbeThrows = false;
    delete (fx.overlay as { isComplete?: unknown }).isComplete; // 旧实现 / 假遮罩
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 3);
    expect(fx.session.status().state).toBe("active");
  });

  it("用户接管优先：同一刻有键鼠输入 → 按「用户接管」处理（不锁回去）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.overlayComplete = false;
    fx.world.idle = 0.05; // 用户刚动了鼠标
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs + 50);
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "user_took_over", relocked: false });
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
  });
});

// 第三轮评审（僵尸动作）：收尾等在飞动作停手有上限，超时的动作稍后才返回——此时新会话可能已经 active，
// 会话级的 shouldStop 说「没事」，僵尸动作就会把剩下的字打进新会话里。动作自己的 shouldStop 绑了会话世代。
describe("动作自己的 shouldStop（绑会话世代，僵尸动作不会在新会话里接着干）", () => {
  it("正常：动作期间会话活着 → false；会话被结束 → true", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    const seen: boolean[] = [];
    let finish!: () => void;
    const action = fx.session.runAction("t1", ({ shouldStop }) => {
      seen.push(shouldStop());
      return new Promise<void>((resolve) => {
        finish = () => {
          seen.push(shouldStop());
          resolve();
        };
      });
    });
    const ended = fx.session.end("cancelled");
    finish();
    await action;
    await vi.advanceTimersByTimeAsync(100);
    await ended;
    expect(seen).toEqual([false, true]);
  });

  it("drain 超时被丢下的动作：新会话 active 之后，它的 shouldStop 仍为 true（会话级的 shouldStop 此时是 false）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    let zombieStop!: () => boolean;
    void fx.session.runAction("t1", ({ shouldStop }) => {
      zombieStop = shouldStop;
      return new Promise<void>(() => {});
    });
    const ended = fx.session.end("max_duration");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.actionDrainMs + 400);
    await ended;

    fx.world.locked = false;
    fx.world.idle = 100;
    await fx.session.begin("t2");
    expect(fx.session.status().state).toBe("active");
    expect(fx.session.shouldStop(), "会话级判断：新会话是活的").toBe(false);
    expect(zombieStop(), "僵尸动作自己的判断：它属于上一个会话，必须收手").toBe(true);

    // 对照：新会话里的新动作，shouldStop 是 false
    let freshStop = true;
    await fx.session.runAction("t2", async ({ shouldStop }) => {
      freshStop = shouldStop();
    });
    expect(freshStop).toBe(false);
  });
});

describe("结束时等在飞的注入动作停手", () => {
  it("动作还在跑：先等它停手，再锁屏、再撤遮罩；shouldStop 提前通知输入循环收手", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(fx.session.shouldStop()).toBe(false);
    let finish!: () => void;
    const action = fx.session.runAction("t1", () => new Promise<void>((resolve) => (finish = resolve)));
    const ended = fx.session.end("cancelled");
    await vi.advanceTimersByTimeAsync(1000);
    // 动作还在跑：不锁、不撤遮罩（锁屏界面一出来，剩下的按键就会打进密码框 = 一次错误登录）
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.overlay.hide).not.toHaveBeenCalled();
    expect(fx.session.status().state).toBe("ending");
    expect(fx.session.shouldStop()).toBe(true);

    finish();
    await action;
    await vi.advanceTimersByTimeAsync(100);
    await expect(ended).resolves.toEqual({ relocked: true });
    expect(fx.calls).toEqual(["unlock", "overlay.show", "lock", "overlay.hide"]);
  });

  it("动作卡住不返回：等满 actionDrainMs 就照常锁屏撤遮罩（不能让电脑一直解着），并写一条审计", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    void fx.session.runAction("t1", () => new Promise<void>(() => {}));
    const ended = fx.session.end("max_duration");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.actionDrainMs - 200);
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    await expect(ended).resolves.toEqual({ relocked: true });
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.audits.find((a) => a.kind === "drain_timeout")).toMatchObject({ type: "session", taskId: "t1", reason: "max_duration" });
    expect(fx.session.status().state).toBe("idle");
  });

  it("drain 超时后卡住的动作不再占着计数：下一个会话里用户碰键鼠照样判接管（评审 e）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    void fx.session.runAction("t1", () => new Promise<void>(() => {})); // 永远不返回的动作
    const ended = fx.session.end("max_duration");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.actionDrainMs + 400);
    await expect(ended).resolves.toEqual({ relocked: true });
    expect(fx.audits.some((a) => a.kind === "drain_timeout")).toBe(true);

    // 下一个任务在没锁屏时开始；用户随后动了键鼠。以前 acting 永远停在 1 → userInputDetected 恒为 false，用户的输入被无视
    fx.world.locked = false;
    fx.world.idle = 100;
    await fx.session.begin("t2");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    expect(codeOf(() => fx.session.guard("t2"))).toBe("USER_TOOK_OVER");
  });

  it("卡住的旧动作事后才返回：不会去减新会话的计数，新会话自己的注入也不会被误判成用户（评审 e）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    let finishStale!: () => void;
    const stale = fx.session.runAction("t1", () => new Promise<void>((resolve) => (finishStale = resolve)));
    const ended = fx.session.end("max_duration");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.actionDrainMs + 400);
    await ended;

    fx.world.locked = false;
    fx.world.idle = 100;
    await fx.session.begin("t2");
    await vi.advanceTimersByTimeAsync(1000);

    finishStale(); // 旧会话里卡住的动作到这时才返回
    await stale;

    // 新会话里一个正常进行中的注入动作：期间系统空闲时间变小是我们自己造成的，不能判成用户接管。
    // 若旧动作的 finally 去减了新会话的计数（acting 变 -1 → 这里 +1 回到 0），这一步就会被误判
    let finishMine!: () => void;
    const mine = fx.session.runAction("t2", () => new Promise<void>((resolve) => (finishMine = resolve)));
    fx.world.idle = 0.01;
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.takeoverPollMs * 3);
    expect(fx.session.status().state).toBe("active");
    expect(fx.kinds()).not.toContain("user_took_over");
    finishMine();
    await mine;
  });

  it("收尾等动作停手的那一刻日志后端挂了：不影响收尾（审计照写、卡住的动作的计数照清，评审 e）", async () => {
    // 以前 doEnd 在 drain 超时处直接调 log：它一抛，整个收尾带着异常出去（要锁回去的债 / 撤遮罩都丢了）。现在收尾路径上的日志都走 safeLog
    const logCalls = vi.fn(() => {
      throw new Error("日志后端挂了");
    });
    const fx = makeFixture({ log: logCalls });
    await fx.session.begin("t1");
    void fx.session.runAction("t1", () => new Promise<void>(() => {}));
    const ended = fx.session.end("max_duration");
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.actionDrainMs + 400);
    await expect(ended).resolves.toEqual({ relocked: false });
    expect(logCalls).toHaveBeenCalled(); // 确实走到了「记日志并抛」，而不是被绕开
    expect(fx.audits.find((a) => a.kind === "drain_timeout")).toMatchObject({ type: "session", taskId: "t1", reason: "max_duration" });
    expect(fx.session.status().state).toBe("idle");
    expect(fx.kinds()).toContain("session_ended");

    fx.world.idle = 100;
    await fx.session.begin("t2");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    expect(codeOf(() => fx.session.guard("t2"))).toBe("USER_TOOK_OVER");
  });

  // 第二轮评审 P1-3：doEnd 没有 try/finally。下面几条钉死「阶段三（撤遮罩 / 复位 / 发事件）一定会跑，我们解锁的照样锁回去」
  describe("收尾的兜底：任何一步出意外，遮罩照撤、状态照复位、事件照发、该锁的照锁", () => {
    it("等动作停手时 sleep 抛了（收尾前半段意外）：仍然锁回去、撤遮罩、发 relocked + session_ended", async () => {
      const fx = makeFixture({
        locked: true,
        sleep: async () => {
          throw new Error("sleep 坏了");
        },
      });
      await fx.session.begin("t1", { allowUnlock: true });
      void fx.session.runAction("t1", () => new Promise<void>(() => {})); // 卡住的动作 → drain 循环要 sleep
      fx.calls.length = 0;
      fx.events.length = 0;
      await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: true });
      expect(fx.calls).toEqual(["lock", "overlay.hide"]); // 先锁屏、再撤遮罩
      expect(fx.kinds()).toEqual(["relocked", "session_ended"]);
      expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, unlockedByUs: false });
    });

    it("锁屏确认时 isScreenLocked 一直抛（以前直接带着异常出去）：走 relock_failed 的正常路径——遮罩撤了、事件发了、状态复位", async () => {
      const fx = makeFixture({ locked: true });
      await fx.session.begin("t1", { allowUnlock: true });
      fx.events.length = 0;
      fx.overlay.hide.mockClear();
      fx.driver.isScreenLocked.mockImplementation(() => {
        throw new Error("读锁屏状态炸了");
      });
      const ended = fx.session.end("task_done");
      await vi.advanceTimersByTimeAsync(SESSION_LIMITS.relockWaitMs * 2 + 500);
      await expect(ended).resolves.toEqual({ relocked: false });
      expect(fx.overlay.hide).toHaveBeenCalledTimes(1);
      expect(fx.kinds()).toEqual(["relock_failed", "session_ended"]);
      expect(fx.events.find((e) => e.kind === "relock_failed")).toMatchObject({ reason: "task_done", error: expect.stringContaining("没有进入锁屏状态") });
      expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ unlockedByUs: true, relocked: false });
      expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, unlockedByUs: false });
    });

    it("锁屏确认的等待本身抛了（relockNow 内部意外）：同样是 relock_failed，带上原因，不丢收尾", async () => {
      const fx = makeFixture({
        locked: true,
        // lock 命令「成功」但电脑没进入锁屏 → 确认循环要 sleep → sleep 抛（begin 不调 sleep，所以一开始就让它坏也不影响开始）
        lock: async () => ({ ok: true }),
        sleep: async () => {
          throw new Error("sleep 坏了");
        },
      });
      await fx.session.begin("t1", { allowUnlock: true });
      fx.events.length = 0;
      fx.overlay.hide.mockClear();
      await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: false });
      expect(fx.kinds()).toEqual(["relock_failed", "session_ended"]);
      expect(fx.events.find((e) => e.kind === "relock_failed")).toMatchObject({ error: expect.stringContaining("sleep 坏了") });
      expect(fx.overlay.hide).toHaveBeenCalledTimes(1);
      expect(fx.session.status().state).toBe("idle");
    });

    it("事件通知回调和日志后端同时坏：收尾照样走完、结果仍是 relocked:true（emit 里的日志走 safeLog，不会冒出去把收尾带跑）", async () => {
      const fx = makeFixture({
        locked: true,
        notify: () => {
          throw new Error("通知回调炸了");
        },
        log: () => {
          throw new Error("日志后端挂了");
        },
      });
      await fx.session.begin("t1", { allowUnlock: true });
      await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: true });
      expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, unlockedByUs: false });
      expect(fx.audits.some((a) => a.kind === "session_ended")).toBe(true); // 审计不受通知回调影响
    });
  });

  it("destroy（应用退出）时还有没返回的动作：计数一并清掉，之后再开会话接管检测照常（评审 e）", async () => {
    const fx = makeFixture();
    await fx.session.begin("t1");
    void fx.session.runAction("t1", () => new Promise<void>(() => {}));
    fx.session.destroy();
    expect(fx.session.status().state).toBe("idle");

    fx.world.idle = 100;
    await fx.session.begin("t2");
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05;
    expect(codeOf(() => fx.session.guard("t2"))).toBe("USER_TOOK_OVER");
  });

  it("没有在飞的动作：结束不多等一拍（不推进任何定时器就能收尾）", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await fx.session.runAction("t1", async () => {});
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: true });
    expect(fx.audits.some((a) => a.kind === "drain_timeout")).toBe(false);
  });

  it("结束过程中再来的动作被 guard 拒绝（SESSION_EXPIRED），不会再注入任何东西", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    let finish!: () => void;
    const action = fx.session.runAction("t1", () => new Promise<void>((resolve) => (finish = resolve)));
    const ended = fx.session.end("explicit");
    await vi.advanceTimersByTimeAsync(200);
    let injected = false;
    expect(
      await rejectCode(
        fx.session.runAction("t1", async () => {
          injected = true;
        }),
      ),
    ).toBe("SESSION_EXPIRED");
    expect(injected).toBe(false);
    finish();
    await action;
    await vi.advanceTimersByTimeAsync(100);
    await ended;
  });

  it("shouldStop：只有 active 才是 false（没会话 / 结束中 / 已结束都是 true）", async () => {
    const fx = makeFixture();
    expect(fx.session.shouldStop()).toBe(true);
    await fx.session.begin("t1");
    expect(fx.session.shouldStop()).toBe(false);
    await fx.session.end("explicit");
    expect(fx.session.shouldStop()).toBe(true);
  });
});

describe("事件载荷", () => {
  it("只含固定的几个字段，没有解锁步骤的内容", async () => {
    const fx = makeFixture({
      locked: true,
      unlock: async (ctx, world) => {
        ctx.onStep?.({ name: "type", ok: true, ms: 1, detail: "secret-detail" });
        world.locked = false;
        return { ok: true };
      },
    });
    await fx.session.begin("t1", { allowUnlock: true });
    await fx.session.end("task_done");
    const allowed = new Set(["kind", "taskId", "at", "reason", "error", "unlockedByUs", "relocked", "mode"]);
    for (const e of fx.events) {
      for (const key of Object.keys(e)) expect(allowed.has(key)).toBe(true);
    }
    expect(JSON.stringify(fx.events)).not.toContain("secret-detail");
  });
});

describe("锁屏后台档（Windows）：不解锁、不盖遮罩、不碰密码", () => {
  it("锁屏 + 后台档可用：直接以 background 开始，不查凭据、不解锁、不盖遮罩", async () => {
    const fx = makeFixture({ locked: true, background: true, credential: false });
    const r = await fx.session.begin("t1", { allowUnlock: true });
    expect(r).toEqual({ unlockedByUs: false, locked: true, mode: "background" });
    expect(fx.unlocker.hasCredential).not.toHaveBeenCalled(); // 后台档根本用不着开机密码
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.calls).toEqual(["background.reset"]); // 开始时清掉上一次的后台状态
    expect(fx.kinds()).toEqual(["background_started"]);
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "background", unlockedByUs: false, taskId: "t1" });
  });

  it("后台档同样受两道闸门约束：「锁屏时也能用」没开 / 请求来源不被允许 → SCREEN_LOCKED，不会开始", async () => {
    const off = makeFixture({ locked: true, background: true, policy: { lockedAccess: false } });
    expect(await rejectCode(off.session.begin("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
    const src = makeFixture({ locked: true, background: true });
    expect(await rejectCode(src.session.begin("t1"))).toBe("SCREEN_LOCKED");
    expect(await rejectCode(src.session.begin("t1", { allowUnlock: false }))).toBe("SCREEN_LOCKED");
    for (const fx of [off, src]) {
      expect(fx.session.status().state).toBe("idle");
      expect(fx.background.reset).not.toHaveBeenCalled();
      expect(fx.events).toEqual([]);
    }
  });

  it("总开关没开：ACCESS_DISABLED（后台档也不例外）", async () => {
    const fx = makeFixture({ locked: true, background: true, policy: { enabled: false } });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("ACCESS_DISABLED");
    expect(fx.session.status().state).toBe("idle");
  });

  it("AI 明确要前台（foreground: true）：不走后台档，照常解锁 + 盖遮罩", async () => {
    const fx = makeFixture({ locked: true, background: true });
    const r = await fx.session.begin("t1", { allowUnlock: true, foreground: true });
    expect(r).toMatchObject({ unlockedByUs: true, mode: "foreground" });
    expect(fx.calls).toEqual(["unlock", "overlay.show"]);
    expect(fx.background.reset).not.toHaveBeenCalled();
    expect(fx.kinds()).toEqual(["unlocking", "unlocked"]);
  });

  it("后台档不可用（驱动没就绪 / 探测抛异常）：回到原来的解锁流程", async () => {
    const off = makeFixture({ locked: true, background: false });
    await expect(off.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true, mode: "foreground" });
    expect(off.background.reset).not.toHaveBeenCalled();

    const boom = makeFixture({ locked: true, background: true });
    boom.bg.throws = true;
    await expect(boom.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true, mode: "foreground" });
    expect(boom.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("没锁屏：后台档可用也用不上，照常前台开始（真实键鼠）", async () => {
    const fx = makeFixture({ background: true });
    const r = await fx.session.begin("t1");
    expect(r).toMatchObject({ unlockedByUs: false, locked: false, mode: "foreground" });
    expect(fx.background.reset).not.toHaveBeenCalled();
    expect(fx.kinds()).toEqual([]);
    expect(fx.session.status().mode).toBe("foreground");
  });

  it("macOS 的样子（没注入后台档）：锁屏永远走解锁，mode 是 foreground", async () => {
    const fx = makeFixture({ locked: true });
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true, mode: "foreground" });
  });

  it("续用后台会话：返回 resumed + mode，不重复清理后台状态", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    const again = await fx.session.begin("t1", { allowUnlock: true });
    expect(again).toMatchObject({ resumed: true, mode: "background", unlockedByUs: false, locked: true });
    expect(fx.background.reset).toHaveBeenCalledTimes(1);
    expect(fx.kinds().filter((k) => k === "background_started")).toHaveLength(1);
  });

  it("后台会话期间电脑仍锁着：动作照常放行（不会被当成「被外部锁屏」）", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
    await expect(fx.session.runAction("t1", async () => "done")).resolves.toBe("done");
    await expect(fx.session.runRead("t1", async () => "shot")).resolves.toBe("shot");
    expect(fx.session.status().state).toBe("active");
  });

  it("后台会话期间电脑被解锁了（用户回来了）：SESSION_EXPIRED，以 unlocked_externally 结束，不锁屏", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.locked = false;
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
    await flush();
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, mode: "foreground" });
    expect(fx.unlocker.lock).not.toHaveBeenCalled(); // 不是我们解的锁：用户就在电脑前，更不能再锁
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({
      reason: "unlocked_externally",
      unlockedByUs: false,
      relocked: false,
      mode: "background",
    });
    // 下一次调用按「没锁屏」正常开始
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ locked: false, mode: "foreground" });
  });

  it("读不到锁屏状态（null）：不乱结束后台会话", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.world.locked = null;
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
    expect(fx.session.status().state).toBe("active");
  });

  it("前台会话不受影响：会话期间被锁屏仍是 relocked_externally", async () => {
    const fx = makeFixture({ background: true });
    await fx.session.begin("t1");
    fx.world.locked = true;
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
    await flush();
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "relocked_externally", mode: "foreground" });
  });

  it("正常结束：我们没解过锁 → 不锁屏；遮罩照常撤（幂等）；后台状态再清一次", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await fx.session.end("task_done");
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.calls).toEqual(["background.reset", "overlay.hide", "background.reset"]);
    expect(fx.kinds()).toEqual(["background_started", "session_ended"]);
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({
      reason: "task_done",
      unlockedByUs: false,
      relocked: false,
      mode: "background",
    });
    expect(fx.session.status()).toMatchObject({ state: "idle", mode: "foreground" });
  });

  it("后台清理抛异常不影响结束", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.background.reset.mockImplementation(() => {
      throw new Error("清理失败");
    });
    await expect(fx.session.end("task_done")).resolves.toEqual({ relocked: false });
    expect(fx.session.status().state).toBe("idle");
  });

  it("空闲超时 / 硬上限对后台会话同样生效", async () => {
    const idle = makeFixture({ locked: true, background: true, limits: { idleEndMs: 5000 } });
    await idle.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(5000 + SESSION_LIMITS.takeoverPollMs + 50);
    expect(idle.session.status().state).toBe("idle");
    expect(idle.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "idle", mode: "background" });

    const max = makeFixture({ locked: true, background: true, limits: { maxSessionMs: 10_000, idleEndMs: 60_000 } });
    await max.session.begin("t1", { allowUnlock: true });
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(3000);
      if (max.session.status().state === "active") await max.session.runAction("t1", async () => {}).catch(() => {});
    }
    expect(max.session.status().state).toBe("idle");
    expect(max.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "max_duration", mode: "background" });
    expect(max.unlocker.lock).not.toHaveBeenCalled();
  });

  it("用户接管（锁屏界面有人动键鼠，比如回来输密码）：让位、不锁屏；用户停手前不让 AI 重新开始", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await vi.advanceTimersByTimeAsync(1000);
    fx.world.idle = 0.05; // 后台档的注入不会改变系统空闲时间，所以任何输入都是真人
    expect(codeOf(() => fx.session.guard("t1"))).toBe("USER_TOOK_OVER");
    await flush();
    expect(fx.events.find((e) => e.kind === "user_took_over")).toMatchObject({ taskId: "t1", unlockedByUs: false });
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.session.status().state).toBe("idle");

    fx.world.idle = 5;
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("USER_TOOK_OVER");
    fx.world.idle = SESSION_LIMITS.takeoverQuietMs / 1000 + 1;
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ mode: "background" });
  });

  it("开始时用户刚动过键鼠也照常开始后台会话（电脑是锁着的，不存在「抢在用户前面输密码」）", async () => {
    const fx = makeFixture({ locked: true, background: true, idle: 1 });
    await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ mode: "background" });
  });

  it("另一个任务占着后台会话：DENIED", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(await rejectCode(fx.session.begin("t2", { allowUnlock: true }))).toBe("DENIED");
    expect(codeOf(() => fx.session.guard("t2"))).toBe("DENIED");
  });

  it("审计里记录 mode，但不含任何密码 / 窗口内容", async () => {
    const fx = makeFixture({ locked: true, background: true });
    await fx.session.begin("t1", { allowUnlock: true });
    await fx.session.end("task_done");
    expect(fx.audits.find((a) => a.kind === "begin")).toMatchObject({ type: "session", taskId: "t1", locked: true, mode: "background", unlockedByUs: false });
  });
});

describe("后台档升级到前台档（upgradeToForeground）", () => {
  const startBackground = async (init: Parameters<typeof makeFixture>[0] = {}) => {
    const fx = makeFixture({ locked: true, background: true, ...init });
    await fx.session.begin("t1", { allowUnlock: true });
    fx.calls.length = 0;
    fx.events.length = 0;
    return fx;
  };

  it("成功：走完整的解锁 + 遮罩流程，mode 变 foreground；结束时锁回去", async () => {
    const fx = await startBackground();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(fx.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toEqual({ upgraded: true, mode: "foreground" });
    expect(fx.calls).toEqual(["unlock", "overlay.show"]);
    expect(fx.kinds()).toEqual(["unlocking", "unlocked", "foreground_started"]);
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "foreground", unlockedByUs: true });
    // 刚输完密码：之后的动作不会被当成用户接管
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();

    await fx.session.end("task_done");
    expect(fx.calls).toEqual(["unlock", "overlay.show", "lock", "overlay.hide", "background.reset"]);
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "task_done", unlockedByUs: true, relocked: true, mode: "foreground" });
  });

  it("两道闸门在升级时重新检查：来源不被允许 → SCREEN_LOCKED，仍是后台会话、没碰密码", async () => {
    const fx = await startBackground();
    expect(await rejectCode(fx.session.upgradeToForeground("t1"))).toBe("SCREEN_LOCKED");
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: false }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "background" });
  });

  it("升级前「锁屏时也能用」被关掉了：SCREEN_LOCKED，仍是后台会话", async () => {
    const fx = await startBackground();
    fx.world.policy.lockedAccess = false;
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.session.status().mode).toBe("background");
  });

  it("解锁器不支持 / 没存密码 / 用户在场：各自报错，会话仍是后台档，可以继续后台操作", async () => {
    const unsupported = await startBackground({ supported: false });
    expect(await rejectCode(unsupported.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("UNSUPPORTED");

    const noCred = await startBackground({ credential: false });
    expect(await rejectCode(noCred.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("SCREEN_LOCKED");

    const present = await startBackground();
    present.world.idle = 1;
    expect(await rejectCode(present.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("USER_TOOK_OVER");

    for (const fx of [unsupported, noCred, present]) {
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
      expect(fx.overlay.show).not.toHaveBeenCalled();
      expect(fx.session.status()).toMatchObject({ state: "active", mode: "background" });
    }
    // 后台操作不受影响
    unsupported.world.idle = 100;
    await expect(unsupported.session.runAction("t1", async () => "still-ok")).resolves.toBe("still-ok");
  });

  it("解锁失败（输过密码）：一次即停、进入冷却；会话仍是后台档；冷却内再升级不会再输密码", async () => {
    const fx = await startBackground({ unlock: async () => ({ ok: false, error: "密码不对" }) });
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "background", unlockedByUs: false });
    expect(fx.kinds()).toEqual(["unlocking", "unlock_failed"]);
    expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ cooldown: true });

    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1); // 冷却内没有第二次
    await expect(fx.session.runRead("t1", async () => "bg-shot")).resolves.toBe("bg-shot");
  });

  it("解锁抛异常：同样一次即停 + 冷却，仍是后台会话", async () => {
    const fx = await startBackground({
      unlock: async () => {
        throw new Error("helper 崩了");
      },
    });
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "background" });
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("没输过密码的失败（attempted: false）不进冷却，可以马上再试", async () => {
    let n = 0;
    const fx = await startBackground({
      unlock: async (_ctx, world) => {
        n += 1;
        if (n === 1) return { ok: false, error: "组件没装", attempted: false };
        world.locked = false;
        return { ok: true };
      },
    });
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ cooldown: false });
    await expect(fx.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toMatchObject({ upgraded: true });
  });

  it("升级时电脑其实已经被用户解开了：什么都不做（下一次动作会结束后台会话）", async () => {
    const fx = await startBackground();
    fx.world.locked = false;
    await expect(fx.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toEqual({ upgraded: false, mode: "background" });
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
  });

  it("不是后台会话（没会话 / 已经是前台）：返回 upgraded: false，不动任何东西", async () => {
    const none = makeFixture({ locked: true, background: true });
    await expect(none.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toEqual({ upgraded: false, mode: "foreground" });
    expect(none.unlocker.unlock).not.toHaveBeenCalled();

    const fg = makeFixture({ locked: true, background: true });
    await fg.session.begin("t1", { allowUnlock: true, foreground: true });
    fg.unlocker.unlock.mockClear();
    await expect(fg.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toEqual({ upgraded: false, mode: "foreground" });
    expect(fg.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("别的任务不能替后台会话升级：DENIED", async () => {
    const fx = await startBackground();
    expect(await rejectCode(fx.session.upgradeToForeground("t2", { allowUnlock: true }))).toBe("DENIED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("同任务并发升级：只解锁一次，两边都成功", async () => {
    const fx = await startBackground();
    const [a, b] = await Promise.all([
      fx.session.upgradeToForeground("t1", { allowUnlock: true }),
      fx.session.upgradeToForeground("t1", { allowUnlock: true }),
    ]);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ upgraded: true, mode: "foreground" });
    expect(b).toMatchObject({ upgraded: true, mode: "foreground" });
  });

  it("升级过程中被取消：通知解锁器停手；刚解开的锁回去；会话结束，不会复活", async () => {
    let release!: (r: UnlockResult) => void;
    let aborted = false;
    const fx = await startBackground({
      unlock: (ctx) =>
        new Promise<UnlockResult>((resolve) => {
          ctx.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          release = resolve;
        }),
    });
    const up = rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }));
    await flush();
    expect(fx.session.status().state).toBe("unlocking");

    const ended = fx.session.end("cancelled");
    await flush();
    expect(aborted).toBe(true);
    expect(fx.session.status().state).toBe("ending");

    fx.world.locked = false;
    release({ ok: true });
    expect(await up).toBe("CANCELLED");
    await ended;
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, mode: "foreground" });
    expect(fx.events.find((e) => e.kind === "relocked")).toMatchObject({ taskId: "t1", reason: "cancelled" });
  });

  it("升级过程中被取消，密码已经输进去过却没解开（attempted: true）：进冷却 + unlock_failed，之后不会再输（评审 #5，升级与开始共用同一段解锁逻辑）", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = await startBackground({ unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const up = rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }));
    await flush();
    const ended = fx.session.end("cancelled");
    await flush();
    release({ ok: false, error: "提交后验证被打断", attempted: true });
    expect(await up).toBe("CANCELLED");
    await ended;

    expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ taskId: "t1", cooldown: true });
    expect(fx.session.status().unlockCooldownUntil).toBeGreaterThan(0);
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("升级过程中动作被拒绝（会话正在解锁，不是 active）", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = await startBackground({ unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const up = fx.session.upgradeToForeground("t1", { allowUnlock: true });
    await flush();
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
    fx.world.locked = false;
    release({ ok: true });
    await up;
    expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
  });

  it("升级成功后遮罩盖不上：锁回去并中止，不能留下「已解锁、没遮罩」；会话回到后台档", async () => {
    const fx = await startBackground({ overlayShowThrows: true });
    expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("INTERNAL");
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.events.find((e) => e.kind === "relocked")).toMatchObject({ reason: "overlay_failed" });
    expect(fx.world.locked).toBe(true);
    expect(fx.session.status()).toMatchObject({ state: "active", mode: "background", unlockedByUs: false });
  });

  it("升级进行中同一任务又来 begin（并行工具调用）：等升级有结果再续用，不会再起一次解锁", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = await startBackground({ unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const up = fx.session.upgradeToForeground("t1", { allowUnlock: true });
    await flush();
    const again = fx.session.begin("t1", { allowUnlock: true });
    await flush();
    fx.world.locked = false;
    release({ ok: true });
    await up;
    await expect(again).resolves.toMatchObject({ resumed: true, mode: "foreground", unlockedByUs: true });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("升级失败时并行的 begin：续用仍是后台档的会话", async () => {
    const fx = await startBackground({ unlock: async () => ({ ok: false, error: "密码不对" }) });
    const up = rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }));
    const again = fx.session.begin("t1", { allowUnlock: true });
    expect(await up).toBe("UNLOCK_FAILED");
    await expect(again).resolves.toMatchObject({ resumed: true, mode: "background", unlockedByUs: false });
  });

  it("升级进行中别的任务来 begin / 升级：DENIED", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = await startBackground({ unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)) });
    const up = fx.session.upgradeToForeground("t1", { allowUnlock: true });
    await flush();
    expect(await rejectCode(fx.session.begin("t2", { allowUnlock: true }))).toBe("DENIED");
    expect(await rejectCode(fx.session.upgradeToForeground("t2", { allowUnlock: true }))).toBe("DENIED");
    fx.world.locked = false;
    release({ ok: true });
    await up;
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });

  it("应用退出（destroy）：撤遮罩、清后台状态、通知升级中的解锁停手；没解过锁就不发锁屏命令", async () => {
    let aborted = false;
    const fx = await startBackground({
      unlock: (ctx) =>
        new Promise<UnlockResult>(() => {
          ctx.signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    void fx.session.upgradeToForeground("t1", { allowUnlock: true }).catch(() => {});
    await flush();
    fx.session.destroy();
    expect(aborted).toBe(true);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.background.reset).toHaveBeenCalled();
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null, mode: "foreground" });
  });

  it("前台化之后被锁屏：按前台会话处理（relocked_externally），不再当后台会话", async () => {
    const fx = await startBackground();
    await fx.session.upgradeToForeground("t1", { allowUnlock: true });
    fx.world.locked = true;
    expect(codeOf(() => fx.session.guard("t1"))).toBe("SESSION_EXPIRED");
    await flush();
    expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "relocked_externally", mode: "foreground" });
  });
});

describe("解锁器声明 overlayBeforeUnlock（Windows 系统级解锁组件）：先盖遮罩再解锁", () => {
  it("顺序：先 overlay.show，再 unlock；成功后不重复盖", async () => {
    const fx = makeFixture({ locked: true, overlayBeforeUnlock: true });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(fx.calls).toEqual(["overlay.show", "unlock"]);
    expect(fx.overlay.show).toHaveBeenCalledTimes(1);
    expect(fx.kinds()).toEqual(["unlocking", "unlocked"]);
    expect(fx.session.status()).toMatchObject({ state: "active", unlockedByUs: true });
  });

  it("没声明（macOS）：保持原顺序，先解锁再盖遮罩", async () => {
    const fx = makeFixture({ locked: true });
    await fx.session.begin("t1", { allowUnlock: true });
    expect(fx.calls).toEqual(["unlock", "overlay.show"]);
  });

  it("先盖遮罩失败：不解锁（什么都没改变），报 INTERNAL，也不锁屏", async () => {
    const fx = makeFixture({ locked: true, overlayBeforeUnlock: true, overlayShowThrows: true });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("INTERNAL");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
  });

  it("解锁失败：遮罩要撤掉（电脑还是锁屏，遮罩不能留着）", async () => {
    const fx = makeFixture({ locked: true, overlayBeforeUnlock: true, unlock: async () => ({ ok: false, error: "密码不对" }) });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.calls).toEqual(["overlay.show", "unlock", "overlay.hide"]);
    expect(fx.session.status().state).toBe("idle");
  });

  it("没输过密码的失败（attempted: false）：遮罩同样撤掉，不进冷却", async () => {
    const fx = makeFixture({ locked: true, overlayBeforeUnlock: true, unlock: async () => ({ ok: false, error: "组件没装", attempted: false }) });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.calls).toEqual(["overlay.show", "unlock", "overlay.hide"]);
    fx.unlocker.unlock.mockClear();
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1); // 没进冷却：第二次又真的去试了
  });

  it("解锁抛异常：遮罩撤掉 + 一次即停", async () => {
    const fx = makeFixture({
      locked: true,
      overlayBeforeUnlock: true,
      unlock: async () => {
        throw new Error("helper 没响应");
      },
    });
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.calls).toEqual(["overlay.show", "unlock", "overlay.hide"]);
    fx.unlocker.unlock.mockClear();
    expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled(); // 冷却
  });

  it("解锁过程中被取消：遮罩撤掉；刚解开的锁回去", async () => {
    let release!: (r: UnlockResult) => void;
    const fx = makeFixture({
      locked: true,
      overlayBeforeUnlock: true,
      unlock: () => new Promise<UnlockResult>((resolve) => (release = resolve)),
    });
    const begunCode = rejectCode(fx.session.begin("t1", { allowUnlock: true }));
    await flush();
    expect(fx.overlay.show).toHaveBeenCalledTimes(1);
    const ended = fx.session.end("cancelled");
    await flush();
    fx.world.locked = false;
    release({ ok: true });
    expect(await begunCode).toBe("CANCELLED");
    await ended;
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.overlay.hide).toHaveBeenCalled();
    // 先锁屏、再撤遮罩
    expect(fx.calls.indexOf("lock")).toBeLessThan(fx.calls.lastIndexOf("overlay.hide"));
  });
});

// ═══════════════════════════ 系统安全桌面（UAC 等）不是锁屏 ═══════════════════════════
// Windows 上 UAC 权限确认 / Ctrl+Alt+Del 和锁屏一样在 Winlogon 桌面上。把它当锁屏的后果：解锁器往里输开机密码再回车，
// 而 UAC 里回车默认落在「是」——等于替用户点了同意。所以：开始 / 升级一律拒（SECURE_DESKTOP）、会话中遇到就结束且不锁屏、
// 不进冷却、不输任何东西；驱动没有这个能力（macOS）/ 读不到 / 抛错 = 当作不是安全桌面，维持原来的行为。

const rejectError = async (p: Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("期望被拒绝，但成功了");
};

describe("系统安全桌面（UAC 等）不是锁屏：不解锁、不输密码、不锁屏", () => {
  describe("开始（begin）", () => {
    it("屏幕上是安全桌面：SECURE_DESKTOP，什么都没动——不解锁、不盖遮罩、不查凭据、不产生事件，会话仍是 idle", async () => {
      const fx = makeFixture({ secure: true });
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
      expect(fx.unlocker.hasCredential).not.toHaveBeenCalled();
      expect(fx.overlay.show).not.toHaveBeenCalled();
      expect(fx.calls).toEqual([]);
      expect(fx.events).toEqual([]);
      expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
    });

    it("安全桌面的判断排在「锁没锁」之前：就算驱动同时说「锁着」（后台档可用、可解锁），也先拒，且根本没去问锁屏状态", async () => {
      for (const background of [undefined, true]) {
        const fx = makeFixture({ secure: true, locked: true, ...(background === undefined ? {} : { background }) });
        expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true })), `background=${String(background)}`).toBe("SECURE_DESKTOP");
        expect(fx.driver.isScreenLocked).not.toHaveBeenCalled();
        expect(fx.unlocker.unlock).not.toHaveBeenCalled();
        expect(fx.background.reset).not.toHaveBeenCalled();
        expect(fx.overlay.show).not.toHaveBeenCalled();
      }
    });

    it("错误说明讲清楚：是 UAC 之类的系统权限弹窗、只能用户本人处理、AI 没有也不会替他点、别重试", async () => {
      const fx = makeFixture({ secure: true });
      const err = await rejectError(fx.session.begin("t1", { allowUnlock: true }));
      expect(err.code).toBe("SECURE_DESKTOP");
      expect(err.message).toMatch(/UAC/);
      expect(err.message).toMatch(/用户本人/);
      expect(err.message).toMatch(/不会、也不能替用户点/);
      expect(err.message).toMatch(/不要重试/);
    });

    it("不进冷却：弹窗处理掉之后马上就能正常开始（锁屏就照常解锁一次）", async () => {
      const fx = makeFixture({ secure: true, locked: true });
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("SECURE_DESKTOP"); // 还在弹窗：照样拒，不是冷却
      fx.world.secure = false; // 用户处理掉了弹窗
      await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true, mode: "foreground" });
      expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    });

    it("读不到 / 抛异常 / 返回的不是严格的 true：当作「不是安全桌面」，照原来的流程走", async () => {
      const throwing = makeFixture({ secure: true, locked: true });
      throwing.world.secureThrows = true;
      await expect(throwing.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });

      for (const value of [undefined, null, 1, "true", {}]) {
        const fx = makeFixture({ secure: false, locked: true });
        fx.driver.isSecureDesktopActive!.mockReturnValue(value as never);
        await expect(fx.session.begin("t1", { allowUnlock: true }), String(value)).resolves.toMatchObject({ unlockedByUs: true });
      }
    });

    it("驱动没有这个方法（macOS 的样子）：行为和以前完全一样", async () => {
      const fx = makeFixture({ locked: true });
      expect("isSecureDesktopActive" in fx.driver).toBe(false);
      await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    });

    it("续用已有会话时 begin 不重复检查（动作前的 guard 会拦）：已经在进行的会话不会因为 begin 而被误结束", async () => {
      const fx = makeFixture({ secure: false });
      await fx.session.begin("t1");
      fx.world.secure = true;
      await expect(fx.session.begin("t1")).resolves.toMatchObject({ resumed: true });
      expect(fx.session.status().state).toBe("active");
      expect(codeOf(() => fx.session.guard("t1"))).toBe("SECURE_DESKTOP"); // 真正动手之前被拦
    });
  });

  describe("会话进行中弹出（guard / runAction / runRead）", () => {
    it("前台会话（我们解的锁）：guard 抛 SECURE_DESKTOP，以 secure_desktop 结束——不锁屏（用户就在旁边要处理弹窗）、撤遮罩、事件带 unlockedByUs", async () => {
      const fx = makeFixture({ secure: false, locked: true });
      await fx.session.begin("t1", { allowUnlock: true });
      fx.calls.length = 0;
      fx.events.length = 0;
      fx.world.secure = true;
      expect(codeOf(() => fx.session.guard("t1"))).toBe("SECURE_DESKTOP");
      await flush();
      expect(fx.unlocker.lock).not.toHaveBeenCalled();
      expect(fx.driver.lockScreen).not.toHaveBeenCalled();
      expect(fx.calls).toEqual(["overlay.hide"]);
      expect(fx.session.status()).toMatchObject({ state: "idle", taskId: null });
      expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({
        reason: "secure_desktop",
        unlockedByUs: true,
        relocked: false,
        mode: "foreground",
      });
    });

    it("后台会话（电脑锁着、没解锁）：同样结束，不锁屏；事件 unlockedByUs=false、mode=background", async () => {
      const fx = makeFixture({ secure: false, locked: true, background: true });
      await fx.session.begin("t1", { allowUnlock: true });
      fx.events.length = 0;
      fx.world.secure = true;
      expect(codeOf(() => fx.session.guard("t1"))).toBe("SECURE_DESKTOP");
      await flush();
      expect(fx.unlocker.lock).not.toHaveBeenCalled();
      expect(fx.session.status().state).toBe("idle");
      expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({
        reason: "secure_desktop",
        unlockedByUs: false,
        relocked: false,
        mode: "background",
      });
    });

    it("runAction / runRead 在安全桌面上一律不执行：回调一次都不调、会话结束；弹窗之后重新开始一个会话", async () => {
      const fx = makeFixture({ secure: false });
      await fx.session.begin("t1");
      fx.world.secure = true;
      const act = vi.fn(async () => "acted");
      const read = vi.fn(async () => "shot");
      expect(await rejectCode(fx.session.runAction("t1", act))).toBe("SECURE_DESKTOP");
      await flush();
      expect(fx.session.status().state).toBe("idle");
      // 会话已经结束了：再来一次只会是 SESSION_EXPIRED（不是执行）；读操作同理
      expect(await rejectCode(fx.session.runRead("t1", read))).toBe("SESSION_EXPIRED");
      expect(act).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      // 弹窗处理完了：重新 begin，正常工作
      fx.world.secure = false;
      await fx.session.begin("t1");
      await expect(fx.session.runAction("t1", act)).resolves.toBe("acted");
    });

    it("被别的任务拦在前面：不是持有者先得到 DENIED，不会因为别人的 guard 把持有者的会话结束掉", async () => {
      const fx = makeFixture({ secure: false });
      await fx.session.begin("t1");
      fx.world.secure = true;
      expect(codeOf(() => fx.session.guard("t2"))).toBe("DENIED");
      await flush();
      expect(fx.session.status()).toMatchObject({ state: "active", taskId: "t1" });
    });

    it("显式以 secure_desktop 结束：默认不锁屏（它不在「要锁回去」的原因表里）", async () => {
      const fx = makeFixture({ locked: true });
      await fx.session.begin("t1", { allowUnlock: true });
      fx.unlocker.lock.mockClear();
      await fx.session.end("secure_desktop");
      expect(fx.unlocker.lock).not.toHaveBeenCalled();
      expect(fx.events.find((e) => e.kind === "session_ended")).toMatchObject({ reason: "secure_desktop", relocked: false });
    });

    it("动作之后紧接着的同步检查读到异常：不影响正常的 guard（读不到 = 不是安全桌面）", async () => {
      const fx = makeFixture({ secure: false });
      await fx.session.begin("t1");
      fx.world.secureThrows = true;
      expect(codeOf(() => fx.session.guard("t1"))).toBeUndefined();
      expect(fx.session.status().state).toBe("active");
    });
  });

  describe("升级（upgradeToForeground）", () => {
    const startBackgroundSecure = async () => {
      const fx = makeFixture({ locked: true, background: true, secure: false });
      await fx.session.begin("t1", { allowUnlock: true });
      fx.calls.length = 0;
      fx.events.length = 0;
      return fx;
    };

    it("安全桌面上：SECURE_DESKTOP，不解锁、不盖遮罩；会话仍是后台档（不被结束），弹窗处理完再升级就能成功", async () => {
      const fx = await startBackgroundSecure();
      fx.world.secure = true;
      expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
      expect(fx.overlay.show).not.toHaveBeenCalled();
      expect(fx.calls).toEqual([]);
      expect(fx.events).toEqual([]);
      expect(fx.session.status()).toMatchObject({ state: "active", mode: "background", unlockedByUs: false });
      fx.world.secure = false;
      await expect(fx.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toMatchObject({ upgraded: true, mode: "foreground" });
    });

    it("就算驱动此刻说「没锁屏」（升级时通常会当作『用户已解锁、没什么可升级的』悄悄返回），安全桌面也要明确拒绝，不能悄悄放过", async () => {
      const fx = await startBackgroundSecure();
      fx.world.secure = true;
      fx.world.locked = false;
      expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
      // 对照：同样「没锁屏」但不是安全桌面——照旧返回 upgraded:false
      const calm = await startBackgroundSecure();
      calm.world.locked = false;
      await expect(calm.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toMatchObject({ upgraded: false });
    });

    it("安全桌面的判断排在闸门前面：不管「锁屏时也能用」开没开，用户看到的都是 SECURE_DESKTOP（真正的原因）", async () => {
      const fx = await startBackgroundSecure();
      fx.world.secure = true;
      fx.world.policy.lockedAccess = false;
      expect(await rejectCode(fx.session.upgradeToForeground("t1"))).toBe("SECURE_DESKTOP");
    });
  });

  describe("解锁器回 SECURE_DESKTOP / 奇怪的错误码", () => {
    it("解锁器说「屏幕上是安全桌面、一个键都没输」（attempted:false, code:SECURE_DESKTOP）：begin 报 SECURE_DESKTOP，不进冷却，可以马上再来", async () => {
      let n = 0;
      const fx = makeFixture({
        locked: true,
        unlock: async (_ctx, world) => {
          n += 1;
          if (n === 1) return { ok: false, code: "SECURE_DESKTOP", error: "屏幕上是 UAC 提示", attempted: false };
          world.locked = false;
          return { ok: true };
        },
      });
      const err = await rejectError(fx.session.begin("t1", { allowUnlock: true }));
      expect(err.code).toBe("SECURE_DESKTOP");
      expect(err.message).toContain("屏幕上是 UAC 提示");
      expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ cooldown: false });
      await expect(fx.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true }); // 没有冷却
      expect(n).toBe(2);
    });

    it("同一个码走升级路径也一样（共用 unlockAndCover）：报 SECURE_DESKTOP，仍是后台会话，不进冷却", async () => {
      let n = 0;
      const fx = makeFixture({
        locked: true,
        background: true,
        unlock: async (_ctx, world) => {
          n += 1;
          if (n === 1) return { ok: false, code: "SECURE_DESKTOP", error: "屏幕上是 UAC 提示", attempted: false };
          world.locked = false;
          return { ok: true };
        },
      });
      await fx.session.begin("t1", { allowUnlock: true });
      expect(await rejectCode(fx.session.upgradeToForeground("t1", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
      expect(fx.session.status()).toMatchObject({ state: "active", mode: "background" });
      await expect(fx.session.upgradeToForeground("t1", { allowUnlock: true })).resolves.toMatchObject({ upgraded: true });
    });

    it("矛盾的回报（code 是 SECURE_DESKTOP 却说输过密码 attempted:true）：按「输过」处理——UNLOCK_FAILED + 冷却，宁可多等不能少等", async () => {
      const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, code: "SECURE_DESKTOP", error: "x", attempted: true }) });
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      expect(fx.events.find((e) => e.kind === "unlock_failed")).toMatchObject({ cooldown: true });
      fx.unlocker.unlock.mockClear();
      expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    });

    it("code 是对象原型上的名字（constructor / __proto__ / toString / valueOf / hasOwnProperty）：当不认识的码，一律 UNLOCK_FAILED，不会变成别的错误码", async () => {
      for (const code of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
        const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, code, error: "x", attempted: false }) });
        expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true })), code).toBe("UNLOCK_FAILED");
      }
    });

    it("已知的几个「没输过密码」的码映射不变：NEED_PERMISSION / USER_PRESENT→USER_TOOK_OVER / SECURE_DESKTOP；别的码 → UNLOCK_FAILED", async () => {
      const table: Array<[string | undefined, string]> = [
        ["NEED_PERMISSION", "NEED_PERMISSION"],
        ["USER_PRESENT", "USER_TOOK_OVER"],
        ["SECURE_DESKTOP", "SECURE_DESKTOP"],
        ["SOMETHING_ELSE", "UNLOCK_FAILED"],
        [undefined, "UNLOCK_FAILED"],
      ];
      for (const [code, expected] of table) {
        const fx = makeFixture({ locked: true, unlock: async () => ({ ok: false, ...(code ? { code } : {}), error: "x", attempted: false }) });
        expect(await rejectCode(fx.session.begin("t1", { allowUnlock: true })), String(code)).toBe(expected);
      }
    });
  });
});
