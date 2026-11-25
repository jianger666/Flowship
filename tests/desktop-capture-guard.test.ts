/**
 * 截图守卫（electron-app/desktop/capture-guard.mjs）——假遮罩 / 假截图器 / 可编排的「屏幕物理」。
 *
 * 背景：遮罩靠「防截屏」把自己排除在截图之外，但系统不保证——macOS 上有的捕获方（ScreenCaptureKit）会无视它，
 * macOS 27.2 + Electron 42 上实测更糟：整个屏幕被截成一片纯黑（遮罩色占比是 0%，只看遮罩色会把它当成「正常画面」放行），
 * AI 解锁后看到的每张截图都是黑的（真实任务里就因此没能给微信联系人发出消息）。
 * 守卫在运行时对照「带遮罩 / 撤了遮罩」两张图（颜色指纹），遮罩影响了截图就撤遮罩再截。
 * 这里钉死的每一条都对应一个「用户吃亏」的后果：
 * - 遮罩影响了截图（被截成一片黑 / 一页深蓝 / 过渡态杂色）却没撤 → AI 看不见屏幕、什么都干不了
 * - 带遮罩截到的那张直接交给 AI（它可能是过渡态杂色，量颜色比例发现不了）
 * - 遮罩刚出现的一秒内对照出「没影响」就当真（真机实测：第一张截图常常抢在遮罩合成之前，拍到的是真实桌面）→ 后面每张都先拿一片黑
 * - 撤了遮罩却没恢复（截图抛错 / 等待抛错 / 嵌套）→ 用户的桌面一直裸着，旁人看得见 AI 在干什么
 * - 屏幕本来就是深蓝色 → 不能误判成「遮罩被截进来」而每次都撤遮罩
 * - 量不出像素 → 不下结论，不能把「不知道」当成「没问题」写进模式里
 * - 遮罩没盖着 / 遮罩没有撤的办法 → 守卫退化成直通，不能去撤一个不存在的遮罩
 */
import { describe, expect, it, vi } from "vitest";

import { CAPTURE_GUARD_DEFAULTS, createCaptureGuard } from "../electron-app/desktop/capture-guard.mjs";

/** 一张截图量出来的东西：遮罩色占比 / 纯黑占比 / 颜色指纹（和 screenshot.mjs 的返回字段一一对应） */
type ShotStats = { overlay?: number | null; black?: number | null; sig?: readonly number[] | null };
/** 旧写法：直接返回遮罩色占比（没有纯黑占比、没有指纹——守卫退化成只看颜色比例） */
type Physics = (s: { hidden: boolean; settledMs: number; call: number }) => number | null | ShotStats;

/** 遮罩会被截进画面；撤掉之后要等够 needMs 才真正透出桌面（合成器有延迟）才干净 */
const exposedWorld =
  (needMs = 0): Physics =>
  ({ hidden, settledMs }) =>
    hidden && settledMs >= needMs ? 0.02 : 1;
/** 遮罩不会被截进画面（防截屏生效）：屏幕永远是正常桌面 */
const clearWorld: Physics = () => 0.02;
/** 用户的桌面本来就是遮罩底色（深蓝壁纸 / 全屏深蓝应用）：撤不撤遮罩都是这个颜色 */
const darkDesktopWorld: Physics = () => 0.97;
/** 截图里读不出像素 */
const unreadableWorld: Physics = () => null;

type Opts = {
  shown?: boolean;
  canHide?: boolean;
  /** 只有 suspend、没有 resume（残缺的遮罩实现） */
  onlySuspend?: boolean;
  threshold?: number;
  steps?: number[];
  selfCheckWait?: number;
  /** 遮罩实现里有 generation()（每次 show() 成功 +1）；f.newSession() 模拟「新一轮遮罩」 */
  generation?: boolean;
  /** 遮罩实现里有 shownAt()：遮罩是 shownAgoMs 毫秒之前出现的（假时钟：sleep 会推进时间，f.advance 手动推进） */
  shownAgoMs?: number;
  steadyAfterShowMs?: number;
  /** 截图时抛错（在给定的调用号 / 是否撤着遮罩上） */
  captureError?: (i: { hidden: boolean; call: number }) => Error | null;
  /** 每次 sleep 里的副作用（比如「等的时候用户动了鼠标、遮罩撤了」） */
  onSleep?: (ms: number, world: { shown: boolean }) => void;
  sleepThrows?: boolean;
};

const make = (physics: Physics, o: Opts = {}) => {
  const events: string[] = [];
  const logs: string[] = [];
  const world = { shown: o.shown ?? true, depth: 0, maxDepth: 0, settledMs: 0, captures: 0, suspends: 0, resumes: 0, generation: 1, now: 1_000_000, shownAt: 0 };

  const overlay: Record<string, unknown> = { show: vi.fn(), hide: vi.fn(), isShown: () => world.shown };
  const suspend = vi.fn(() => {
    events.push("suspend");
    world.suspends += 1;
    world.depth += 1;
    world.maxDepth = Math.max(world.maxDepth, world.depth);
    world.settledMs = 0;
  });
  const resume = vi.fn(() => {
    events.push("resume");
    world.resumes += 1;
    world.depth -= 1;
  });
  if (o.canHide !== false) {
    overlay.suspend = suspend;
    if (!o.onlySuspend) overlay.resume = resume;
  }
  if (o.generation) overlay.generation = () => world.generation;
  if (o.shownAgoMs !== undefined) {
    world.shownAt = world.now - o.shownAgoMs;
    overlay.shownAt = () => world.shownAt;
  }

  const screenshotter = {
    capture: vi.fn(async () => {
      world.captures += 1;
      const hidden = world.depth > 0;
      events.push(hidden ? "capture:hidden" : "capture:overlay");
      const err = o.captureError?.({ hidden, call: world.captures });
      if (err) throw err;
      const out = physics({ hidden, settledMs: world.settledMs, call: world.captures });
      const stats =
        out !== null && typeof out === "object"
          ? { overlayRatio: out.overlay ?? null, blackRatio: out.black ?? null, sig: out.sig ? Uint8Array.from(out.sig) : null }
          : { overlayRatio: out };
      return {
        jpeg: Buffer.from(`J${world.captures}`),
        frame: { imageWidth: 1000, imageHeight: 500, rect: { x: 0, y: 0, width: 2000, height: 1000 } },
        ...stats,
      };
    }),
    screenPermission: vi.fn(() => "granted"),
  };

  const sleep = vi.fn(async (ms: number) => {
    events.push(`sleep:${ms}`);
    world.now += ms;
    if (world.depth > 0) world.settledMs += ms;
    o.onSleep?.(ms, world);
    if (o.sleepThrows) throw new Error("等待被打断");
  });

  const guard = createCaptureGuard({
    overlay: overlay as never,
    screenshotter: screenshotter as never,
    sleep,
    log: (m: string) => logs.push(m),
    threshold: o.threshold,
    hideSettleStepsMs: o.steps,
    selfCheckOverlayWaitMs: o.selfCheckWait,
    steadyAfterShowMs: o.steadyAfterShowMs,
    now: () => world.now,
  });
  /** 新一轮遮罩（新会话 show() 成功）：generation +1，遮罩出现时间重置成「现在」 */
  const newSession = () => {
    world.generation += 1;
    world.shownAt = world.now;
  };
  /** 假时钟往前走 ms 毫秒（不是 sleep：不记事件） */
  const advance = (ms: number) => {
    world.now += ms;
  };
  return { guard, overlay, suspend, resume, screenshotter, sleep, events, logs, world, newSession, advance };
};

// ---- 带颜色指纹的屏幕（macOS 27 实测的几种画面）----
const SIG_LEN = 48 * 27 * 3;
/** 真实桌面：每个采样点颜色都不一样（确定性的伪随机，别用常数——常数和「全黑」差不多就比不出区别了） */
const REAL_SIG: readonly number[] = Array.from({ length: SIG_LEN }, (_, i) => 40 + ((i * 37 + Math.floor(i / 7) * 11) % 180));
/** 被遮罩截成一片黑：几乎全 0，只剩左边 Dock 的几个图标 */
const BLACK_SIG: readonly number[] = Array.from({ length: SIG_LEN }, (_, i) => (i % 144 < 6 ? 90 : 0));
/** 遮罩原样被截进来：整页深蓝 */
const NAVY_SIG: readonly number[] = Array.from({ length: SIG_LEN }, (_, i) => [11, 16, 32][i % 3]);
/** 刚显示遮罩的过渡帧：一整片发亮的杂色（实测出现过，颜色比例上既不黑也不是遮罩色） */
const GARBAGE_SIG: readonly number[] = Array.from({ length: SIG_LEN }, (_, i) => 150 + ((i * 13) % 40));
/** 同一个屏幕的两次截图：只差一点点（时钟走了一分钟 / 光标闪了一下） */
const jitter = (sig: readonly number[], amount = 2): readonly number[] => sig.map((v, i) => Math.max(0, Math.min(255, v + (i % 97 === 0 ? amount * 10 : 0))));

/** macOS 27 实测：带遮罩 = 一片黑；撤了遮罩（等够 needMs）= 真实屏幕；没等够时遮罩还没透明，仍是黑 */
const blackWorld =
  (needMs = 0): Physics =>
  ({ hidden, settledMs }) =>
    hidden && settledMs >= needMs ? { overlay: 0.1, black: 0.01, sig: REAL_SIG } : { overlay: 0, black: 0.997, sig: BLACK_SIG };
/** 带遮罩时是过渡态杂色（不黑、也不是遮罩色，但和真实屏幕完全不同）；撤了遮罩 = 真实屏幕 */
const garbageWorld: Physics = ({ hidden }) =>
  hidden ? { overlay: 0.1, black: 0.01, sig: REAL_SIG } : { overlay: 0, black: 0.02, sig: GARBAGE_SIG };
/** 防截屏生效：带不带遮罩截出来都是真实屏幕（差一点点） */
const protectedWorld: Physics = ({ hidden }) => ({ overlay: 0.1, black: 0.01, sig: hidden ? REAL_SIG : jitter(REAL_SIG) });
/** 屏幕本来就是纯黑（全屏黑色应用 / 黑色壁纸）：撤不撤遮罩都是黑 */
const blackScreenWorld: Physics = () => ({ overlay: 0, black: 0.99, sig: BLACK_SIG });

const jpegOf = (shot: { jpeg: Buffer }) => shot.jpeg.toString();

describe("遮罩没盖着 / 撤不了：直通", () => {
  it("遮罩没盖着：直接截一张就返回，不管画面像不像遮罩；不撤、不等、模式不变", async () => {
    const f = make(darkDesktopWorld, { shown: false });
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J1");
    expect(f.events).toEqual(["capture:overlay"]);
    expect(f.guard.getMode()).toBe("unknown");
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it("遮罩实现里没有 suspend / resume：直通，即使盖着、画面全是遮罩色也不去撤", async () => {
    const f = make(exposedWorld(), { canHide: false });
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J1");
    expect(shot.overlayRatio).toBe(1);
    expect(f.events).toEqual(["capture:overlay"]);
    expect(f.guard.getMode()).toBe("unknown");
  });

  it("只有 suspend 没有 resume 的残缺遮罩：同样直通——绝不能撤了遮罩却没有恢复的办法", async () => {
    const f = make(exposedWorld(), { onlySuspend: true });
    await f.guard.capture();
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.events).toEqual(["capture:overlay"]);
  });
});

describe("判断遮罩有没有被截进画面（unknown → clear / exposed）", () => {
  it("正常屏幕（防截屏生效）：一次截图就返回，模式记为 clear，没撤过遮罩", async () => {
    const f = make(clearWorld);
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J1");
    expect(f.events).toEqual(["capture:overlay"]);
    expect(f.guard.getMode()).toBe("clear");
    expect(f.logs).toEqual([]);
  });

  it("遮罩被截进来：撤遮罩 → 等 120ms → 截对照 → 恢复；返回对照图；模式记为 exposed 并留日志", async () => {
    const f = make(exposedWorld());
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(shot)).toBe("J2"); // 返回的是撤掉遮罩后的那张，不是带遮罩的
    expect(shot.overlayRatio).toBe(0.02);
    expect(f.guard.getMode()).toBe("exposed");
    expect(f.logs.join("\n")).toContain("遮罩会影响截图");
    expect(f.logs.join("\n")).toContain("100%");
    expect(f.world.depth).toBe(0);
  });

  it("模式 exposed 之后：每次截图直接撤遮罩，不再先截带遮罩的那张；每次都配平", async () => {
    const f = make(exposedWorld());
    await f.guard.capture();
    f.events.length = 0;
    const second = await f.guard.capture();
    const third = await f.guard.capture();
    expect(f.events).toEqual(["suspend", "sleep:120", "capture:hidden", "resume", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(second)).toBe("J3");
    expect(jpegOf(third)).toBe("J4");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
  });

  it("合成器慢（撤了遮罩要等 300ms 才透出桌面）：120ms 那档还是遮罩色就换更长的等待，每档单独撤一次、恢复一次", async () => {
    const f = make(exposedWorld(300));
    const shot = await f.guard.capture();
    expect(f.events).toEqual([
      "capture:overlay",
      "suspend",
      "sleep:120",
      "capture:hidden",
      "resume",
      "suspend",
      "sleep:300",
      "capture:hidden",
      "resume",
    ]);
    expect(jpegOf(shot)).toBe("J3");
    expect(f.guard.getMode()).toBe("exposed");
  });

  it("要等到最长一档（700ms）才干净：照样认定遮罩会被截进画面", async () => {
    const f = make(exposedWorld(700));
    const shot = await f.guard.capture();
    expect(f.events.filter((e) => e.startsWith("sleep"))).toEqual(["sleep:120", "sleep:300", "sleep:700"]);
    expect(jpegOf(shot)).toBe("J4");
    expect(f.guard.getMode()).toBe("exposed");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
  });

  it("撤了遮罩也还是遮罩色（桌面本来就是深蓝）：不误判成遮罩被截进来——返回最后一张、模式 clear、日志里没有「会被截进画面」", async () => {
    const f = make(darkDesktopWorld);
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J4"); // 带遮罩 1 张 + 三档对照
    expect(f.guard.getMode()).toBe("clear");
    expect(f.logs.join("\n")).not.toContain("遮罩会影响截图");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
    expect(f.world.depth).toBe(0);
  });

  it("clear 不是终身判决：桌面颜色变了、遮罩确实被截进来时，下一张重新判断成 exposed", async () => {
    let current: Physics = darkDesktopWorld;
    const f = make((s) => current(s));
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
    current = exposedWorld();
    const shot = await f.guard.capture();
    expect(f.guard.getMode()).toBe("exposed");
    expect(shot.overlayRatio).toBe(0.02);
  });

  it("exposed 模式下撤了遮罩仍然几乎全是遮罩色：返回最后一张、留日志警告、不抛，遮罩已恢复", async () => {
    let current: Physics = exposedWorld();
    const f = make((s) => current(s));
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("exposed");
    current = darkDesktopWorld;
    f.logs.length = 0;
    f.events.length = 0;
    const shot = await f.guard.capture();
    expect(shot.overlayRatio).toBe(0.97);
    expect(f.events.filter((e) => e.startsWith("sleep"))).toEqual(["sleep:120", "sleep:300", "sleep:700"]);
    expect(f.logs.join("\n")).toContain("撤掉遮罩之后截图仍几乎全是黑色 / 遮罩色");
    expect(f.world.depth).toBe(0);
    expect(f.guard.getMode()).toBe("exposed"); // 不因为一次异常就降级
  });

  it("量不出像素（null）：不下结论——模式仍是 unknown，也不去撤遮罩", async () => {
    const f = make(unreadableWorld);
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J1");
    expect(shot.overlayRatio).toBeNull();
    expect(f.guard.getMode()).toBe("unknown");
    expect(f.events).toEqual(["capture:overlay"]);
  });

  it("exposed 模式下对照图量不出像素：当成功处理（返回它，不再换档重试）", async () => {
    let current: Physics = exposedWorld();
    const f = make((s) => current(s));
    await f.guard.capture();
    current = unreadableWorld;
    f.events.length = 0;
    const shot = await f.guard.capture();
    expect(shot.overlayRatio).toBeNull();
    expect(f.events).toEqual(["suspend", "sleep:120", "capture:hidden", "resume"]);
  });

  it("阈值：遮罩色占比恰好 0.85 算「几乎全是遮罩」（触发对照），0.849 不算", async () => {
    const hit = make(({ hidden }) => (hidden ? 0.02 : 0.85));
    await hit.guard.capture();
    expect(hit.guard.getMode()).toBe("exposed");
    expect(hit.world.suspends).toBe(1);

    const miss = make(({ hidden }) => (hidden ? 0.02 : 0.849));
    await miss.guard.capture();
    expect(miss.guard.getMode()).toBe("clear");
    expect(miss.world.suspends).toBe(0);
  });

  it("阈值 / 等待档位可配置", async () => {
    const f = make(({ hidden }) => (hidden ? 0.02 : 0.5), { threshold: 0.5, steps: [50, 80] });
    await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:50", "capture:hidden", "resume"]);
    expect(f.guard.getMode()).toBe("exposed");

    const slow = make(exposedWorld(80), { steps: [50, 80] });
    await slow.guard.capture();
    expect(slow.events.filter((e) => e.startsWith("sleep"))).toEqual(["sleep:50", "sleep:80"]);
  });

  it("默认参数：阈值 0.85、等待档位 120 / 300 / 700ms、自检等遮罩 600ms、遮罩出现满 1000ms 才算稳定；常量冻结", () => {
    expect(CAPTURE_GUARD_DEFAULTS).toEqual({
      threshold: 0.85,
      hideSettleStepsMs: [120, 300, 700],
      selfCheckOverlayWaitMs: 600,
      steadyAfterShowMs: 1000,
    });
    expect(Object.isFrozen(CAPTURE_GUARD_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(CAPTURE_GUARD_DEFAULTS.hideSettleStepsMs)).toBe(true);
  });
});

describe("遮罩被截成一片黑 / 过渡态杂色：对照颜色指纹（macOS 27 实测的真实情形）", () => {
  it("带遮罩截到一片黑（遮罩色 0%、黑 99.7%）：认定遮罩影响了截图——撤遮罩重截，返回真实屏幕，模式 exposed", async () => {
    const f = make(blackWorld());
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(shot)).toBe("J2"); // 交给 AI 的是撤了遮罩截的，不是那张黑的
    expect(shot.blackRatio).toBe(0.01);
    expect(f.guard.getMode()).toBe("exposed");
    expect(f.logs.join("\n")).toContain("遮罩会影响截图");
    expect(f.logs.join("\n")).toContain("黑色占 100%");
    expect(f.world.depth).toBe(0);
  });

  it("只有纯黑占比、读不到指纹（旧的截图器）：纯黑也算「被盖住」，照样撤遮罩重截", async () => {
    const f = make(({ hidden }) => ({ overlay: 0, black: hidden ? 0.01 : 0.997 }));
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(shot)).toBe("J2");
    expect(f.guard.getMode()).toBe("exposed");
  });

  it("带遮罩的画面是过渡态杂色（不黑、也不是遮罩色，只是和真实屏幕完全不同）：照样认定遮罩影响了截图，绝不把杂色交给 AI", async () => {
    const f = make(garbageWorld);
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(shot)).toBe("J2");
    expect(f.guard.getMode()).toBe("exposed");
    expect(f.logs.join("\n")).toContain("遮罩会影响截图");
  });

  it("防截屏生效（带遮罩和撤了遮罩截到的是同一个屏幕，只差一点点）：第一次对照后记为 clear，之后直接截、不再撤遮罩", async () => {
    const f = make(protectedWorld);
    const first = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(first)).toBe("J2"); // 第一次返回的也是撤了遮罩的那张（带遮罩那张只用来对照）
    expect(f.guard.getMode()).toBe("clear");
    expect(f.logs).toEqual([]);

    f.events.length = 0;
    const second = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay"]);
    expect(jpegOf(second)).toBe("J3");
    expect(f.world.suspends).toBe(1);
  });

  it("屏幕本来就是纯黑（全屏黑色应用）：撤不撤遮罩都是同一个黑——不误判成遮罩影响了截图，返回最后一张、模式 clear", async () => {
    const f = make(blackScreenWorld);
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J4"); // 带遮罩 1 张 + 三档对照
    expect(f.guard.getMode()).toBe("clear");
    expect(f.logs.join("\n")).not.toContain("遮罩会影响截图");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
    expect(f.world.depth).toBe(0);
  });

  it("撤了遮罩仍几乎全黑、而且和带遮罩那张不是同一个画面（遮罩没有真的变透明）：不下结论、模式不变，日志说明，遮罩已恢复", async () => {
    const f = make(({ hidden }) => (hidden ? { overlay: 0.97, black: 0, sig: NAVY_SIG } : { overlay: 0, black: 0.997, sig: BLACK_SIG }));
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J4");
    expect(f.guard.getMode()).toBe("unknown");
    expect(f.logs.join("\n")).toContain("撤遮罩可能没有生效");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
    expect(f.world.depth).toBe(0);
  });

  it("合成器慢（撤了遮罩要 300ms 才透出桌面，之前还是黑的）：120ms 那档还是黑就换更长的等待，最后仍认定遮罩影响了截图", async () => {
    const f = make(blackWorld(300));
    const shot = await f.guard.capture();
    expect(f.events.filter((e) => e.startsWith("sleep"))).toEqual(["sleep:120", "sleep:300"]);
    expect(jpegOf(shot)).toBe("J3");
    expect(f.guard.getMode()).toBe("exposed");
    expect(f.world.suspends).toBe(2);
    expect(f.world.resumes).toBe(2);
  });

  it("exposed 之后：每次截图直接撤遮罩（不再先截带遮罩的那张），每次都配平", async () => {
    const f = make(blackWorld());
    await f.guard.capture();
    f.events.length = 0;
    const second = await f.guard.capture();
    const third = await f.guard.capture();
    expect(f.events).toEqual(["suspend", "sleep:120", "capture:hidden", "resume", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(second)).toBe("J3");
    expect(jpegOf(third)).toBe("J4");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
  });

  it("clear 不是终身判决：防截屏曾经生效，后来带遮罩截到一片黑——下一张重新判断成 exposed", async () => {
    let current: Physics = protectedWorld;
    const f = make((s) => current(s));
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
    current = blackWorld();
    const shot = await f.guard.capture();
    expect(f.guard.getMode()).toBe("exposed");
    expect(shot.blackRatio).toBe(0.01);
  });

  it("纯黑占比的阈值同样是 0.85：恰好 0.85 触发对照，0.849 不算（读不到指纹时）", async () => {
    const hit = make(({ hidden }) => ({ overlay: 0, black: hidden ? 0.02 : 0.85 }));
    await hit.guard.capture();
    expect(hit.guard.getMode()).toBe("exposed");
    expect(hit.world.suspends).toBe(1);

    const miss = make(({ hidden }) => ({ overlay: 0, black: hidden ? 0.02 : 0.849 }));
    await miss.guard.capture();
    expect(miss.guard.getMode()).toBe("clear");
    expect(miss.world.suspends).toBe(0);
  });

  it("黑色和遮罩色不相加：各占一半（都不到阈值）不算被盖住——只有某一种颜色铺满整张图才算", async () => {
    const f = make(() => ({ overlay: 0.5, black: 0.5 }));
    await f.guard.capture();
    expect(f.world.suspends).toBe(0);
    expect(f.guard.getMode()).toBe("clear");
  });

  it("只有带遮罩那张有指纹（对照图读不到）：退回颜色比例——带遮罩那张几乎全黑 = exposed；看着正常 = clear", async () => {
    const black = make(({ hidden }) => (hidden ? { overlay: 0.1, black: 0.01 } : { overlay: 0, black: 0.997, sig: BLACK_SIG }));
    await black.guard.capture();
    expect(black.guard.getMode()).toBe("exposed");

    const normal = make(({ hidden }) => (hidden ? { overlay: 0.1, black: 0.01 } : { overlay: 0.1, black: 0.01, sig: REAL_SIG }));
    await normal.guard.capture();
    expect(normal.guard.getMode()).toBe("clear");
  });

  it("读不出任何像素（颜色比例和指纹都是 null）：不下结论——模式仍是 unknown，也不去撤遮罩", async () => {
    const f = make(() => ({ overlay: null, black: null, sig: null }));
    const shot = await f.guard.capture();
    expect(jpegOf(shot)).toBe("J1");
    expect(f.guard.getMode()).toBe("unknown");
    expect(f.events).toEqual(["capture:overlay"]);
  });
});

describe("每一轮遮罩重新对照（generation）", () => {
  it("同一轮遮罩里只对照一次：防截屏生效的系统上，后面的截图都不再撤遮罩", async () => {
    const f = make(protectedWorld, { generation: true });
    for (let i = 0; i < 4; i += 1) await f.guard.capture();
    expect(f.world.suspends).toBe(1);
    expect(f.guard.getMode()).toBe("clear");
  });

  it("exposed 不是跨会话的终身结论：新一轮遮罩出现，第一张截图重新对照（这回防截屏生效了 → clear）", async () => {
    let current: Physics = blackWorld();
    const f = make((s) => current(s), { generation: true });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("exposed");

    f.newSession();
    current = protectedWorld;
    f.events.length = 0;
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]); // 先截带遮罩的、再对照，没有直接撤
    expect(jpegOf(shot)).toBe("J4"); // 第一轮用掉了 J1 / J2，这一轮带遮罩的是 J3、撤了遮罩的是 J4
    expect(f.guard.getMode()).toBe("clear");
  });

  it("clear 也不是跨会话的终身结论：新一轮遮罩一出现，哪怕带遮罩那张既不黑也不是遮罩色（过渡态杂色），第一张也先对照、绝不把杂色交出去", async () => {
    let current: Physics = protectedWorld;
    const f = make((s) => current(s), { generation: true });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");

    f.newSession();
    current = garbageWorld;
    f.events.length = 0;
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(shot)).not.toBe("J3"); // J3 是这一轮带遮罩截到的杂色，绝不能交出去
    expect(jpegOf(shot)).toBe("J4");
    expect(f.guard.getMode()).toBe("exposed");
  });

  it("没有 generation() 的遮罩（旧的 / 假的）：只判断一次，不会每次重判", async () => {
    const f = make(protectedWorld); // 不带 generation
    await f.guard.capture();
    f.newSession(); // 对它没有任何意义
    f.events.length = 0;
    await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay"]);
  });

  it("自检也算这一轮的对照：自检判成 exposed 之后，同一轮的截图直接撤遮罩、不重判；换了一轮才重判", async () => {
    const f = make(blackWorld(), { generation: true });
    const r = await f.guard.selfCheck();
    expect(r.mode).toBe("exposed");
    f.events.length = 0;
    await f.guard.capture();
    expect(f.events).toEqual(["suspend", "sleep:120", "capture:hidden", "resume"]);

    f.newSession();
    f.events.length = 0;
    await f.guard.capture();
    expect(f.events[0]).toBe("capture:overlay");
  });
});

describe("遮罩刚出现的一秒内：对照出「没影响」不算数（真机实测：第一张截图常常抢在遮罩合成之前）", () => {
  it("遮罩刚出现 20ms 就截图、带遮罩那张拍到的还是真实桌面（和撤了遮罩的一样）：返回撤了遮罩的那张，但不记成 clear——模式仍是 unknown", async () => {
    const f = make(protectedWorld, { generation: true, shownAgoMs: 20 });
    const shot = await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(jpegOf(shot)).toBe("J2");
    expect(f.guard.getMode()).toBe("unknown");
    expect(f.logs).toEqual([]);
  });

  it("等遮罩稳定之后再截图：这回对照出「一样」才算数——记成 clear，之后直接截、不再撤遮罩", async () => {
    const f = make(protectedWorld, { generation: true, shownAgoMs: 20 });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("unknown");

    f.advance(2000);
    f.events.length = 0;
    await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]); // 又对照了一次
    expect(f.guard.getMode()).toBe("clear");

    f.events.length = 0;
    await f.guard.capture();
    expect(f.events).toEqual(["capture:overlay"]);
  });

  it("真机上的实际顺序：第一张抢在遮罩合成之前（拍到真实桌面，没下结论），第二张拍到一片黑 → exposed，交给 AI 的两张都是真实屏幕", async () => {
    let current: Physics = protectedWorld; // 第一张：遮罩还没合成，带不带遮罩都是真实桌面
    const f = make((s) => current(s), { generation: true, shownAgoMs: 20 });
    const first = await f.guard.capture();
    expect(f.guard.getMode()).toBe("unknown");

    f.advance(1500);
    current = blackWorld(); // 之后遮罩合成上去了：带遮罩 = 一片黑
    const second = await f.guard.capture();
    expect(f.guard.getMode()).toBe("exposed");
    expect(first.sig).toEqual(second.sig); // 两张都是撤了遮罩截的真实屏幕
    expect(second.blackRatio).toBe(0.01);
  });

  it("对照出「不一样」是偏安全的方向：哪怕遮罩才出现 20ms，也立刻记成 exposed", async () => {
    const f = make(blackWorld(), { generation: true, shownAgoMs: 20 });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("exposed");
  });

  it("边界：遮罩出现恰好满 1000ms 就算稳定（对照出一样 → clear）；差 1ms 还不算（→ unknown）", async () => {
    const steady = make(protectedWorld, { generation: true, shownAgoMs: 1000 });
    await steady.guard.capture();
    expect(steady.guard.getMode()).toBe("clear");

    const early = make(protectedWorld, { generation: true, shownAgoMs: 999 });
    await early.guard.capture();
    expect(early.guard.getMode()).toBe("unknown");
  });

  it("稳定时间可配置", async () => {
    const f = make(protectedWorld, { generation: true, shownAgoMs: 300, steadyAfterShowMs: 250 });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
  });

  it("新一轮遮罩出现：模式回到 unknown，并且这一轮也要等稳定了才下 clear", async () => {
    const f = make(protectedWorld, { generation: true, shownAgoMs: 5000 });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
    f.newSession(); // 遮罩刚重新出现
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("unknown");
    f.advance(1500);
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
  });

  it("读不到指纹、只看颜色比例（旧截图器）：不受这条影响——看着正常照旧直接记 clear", async () => {
    const f = make(clearWorld, { shownAgoMs: 20 });
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
  });

  it("遮罩实现里没有 shownAt()：当成早就稳定了（旧的 / 假的遮罩），对照出一样直接记 clear", async () => {
    const f = make(protectedWorld);
    await f.guard.capture();
    expect(f.guard.getMode()).toBe("clear");
  });
});

describe("撤了遮罩一定恢复", () => {
  it("发现阶段：对照截图抛错 → 错误原样抛出，遮罩恰好恢复一次", async () => {
    const f = make(exposedWorld(), { captureError: ({ hidden }) => (hidden ? new Error("截图失败") : null) });
    await expect(f.guard.capture()).rejects.toThrow("截图失败");
    expect(f.world.suspends).toBe(1);
    expect(f.world.resumes).toBe(1);
    expect(f.world.depth).toBe(0);
    expect(f.guard.getMode()).toBe("unknown"); // 没有结论就别记模式
  });

  it("exposed 模式：截图抛错同样恢复", async () => {
    let fail = false;
    const f = make(exposedWorld(), { captureError: ({ hidden }) => (fail && hidden ? new Error("截图失败") : null) });
    await f.guard.capture();
    fail = true;
    await expect(f.guard.capture()).rejects.toThrow("截图失败");
    expect(f.world.suspends).toBe(f.world.resumes);
    expect(f.world.depth).toBe(0);
  });

  it("等待（sleep）抛错：遮罩也恢复，而且没去截图", async () => {
    const f = make(exposedWorld(), { sleepThrows: true });
    await expect(f.guard.capture()).rejects.toThrow("等待被打断");
    expect(f.world.suspends).toBe(1);
    expect(f.world.resumes).toBe(1);
    expect(f.world.captures).toBe(1); // 只有带遮罩的那张，对照图没截
  });

  it("带遮罩的第一张就截失败：错误原样抛出，根本没撤遮罩", async () => {
    const f = make(exposedWorld(), { captureError: () => new Error("没有屏幕录制权限") });
    await expect(f.guard.capture()).rejects.toThrow("没有屏幕录制权限");
    expect(f.world.suspends).toBe(0);
  });

  it("各种屏幕 × 各种模式：不管走哪条路，遮罩恰好配平、从不嵌套（同一时刻最多撤一层）、结束时是盖着的", async () => {
    const worlds: Array<[string, Physics]> = [
      ["遮罩被截进画面", exposedWorld()],
      ["合成器慢", exposedWorld(300)],
      ["永远撤不干净", exposedWorld(60_000)],
      ["正常", clearWorld],
      ["深蓝桌面", darkDesktopWorld],
      ["读不出像素", unreadableWorld],
      ["带遮罩截成一片黑", blackWorld()],
      ["一片黑、合成器慢", blackWorld(300)],
      ["一片黑、永远撤不干净", blackWorld(60_000)],
      ["过渡态杂色", garbageWorld],
      ["防截屏生效", protectedWorld],
      ["屏幕本来就是纯黑", blackScreenWorld],
    ];
    for (const [name, physics] of worlds) {
      for (const generation of [false, true]) {
        const f = make(physics, { generation });
        for (let i = 0; i < 4; i += 1) {
          await f.guard.capture();
          f.newSession(); // 有 generation() 的遮罩：每次都当成新一轮，走「重新对照」那条路
        }
        await f.guard.selfCheck().catch(() => undefined);
        expect(f.world.depth, name).toBe(0);
        expect(f.world.suspends, name).toBe(f.world.resumes);
        expect(f.world.maxDepth, name).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("遮罩自检（设置页「测试」用）", () => {
  it("遮罩已经不在了：跳过，不算失败；不等、不截图、模式不变", async () => {
    const f = make(exposedWorld(), { shown: false });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, skipped: true, mode: "unknown" });
    expect(r.detail).toContain("遮罩已经撤了");
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.screenshotter.capture).not.toHaveBeenCalled();
  });

  it("等遮罩稳定的 600ms 里遮罩被撤了（用户动了鼠标）：跳过，不截图", async () => {
    const f = make(exposedWorld(), {
      onSleep: (_ms, w) => {
        w.shown = false;
      },
    });
    const r = await f.guard.selfCheck();
    expect(f.events).toEqual(["sleep:600"]);
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(r.detail).toContain("等待期间");
    expect(f.screenshotter.capture).not.toHaveBeenCalled();
  });

  it("先等遮罩稳定 600ms（可配置）再截；遮罩没被截进画面：通过，模式 clear，只截一张、没撤遮罩", async () => {
    const f = make(clearWorld);
    const r = await f.guard.selfCheck();
    expect(f.events).toEqual(["sleep:600", "capture:overlay"]);
    expect(r).toEqual({
      ok: true,
      mode: "clear",
      withOverlayRatio: 0.02,
      detail: expect.stringContaining("遮罩没有影响截图"),
    });
    expect(r.detail).toContain("2%");
    expect(f.guard.getMode()).toBe("clear");

    const custom = make(clearWorld, { selfCheckWait: 250 });
    await custom.guard.selfCheck();
    expect(custom.events[0]).toBe("sleep:250");
  });

  it("遮罩被截进画面、撤掉之后正常：通过，模式 exposed，之后的截图直接撤遮罩", async () => {
    const f = make(exposedWorld());
    const r = await f.guard.selfCheck();
    expect(f.events).toEqual(["sleep:600", "capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(r).toMatchObject({ ok: true, mode: "exposed", withOverlayRatio: 1, cleanRatio: 0.02 });
    expect(r.detail).toContain("每次截图前短暂撤掉遮罩");
    expect(r.detail).toContain("100%");
    expect(r.detail).toContain("2%");
    expect(f.guard.getMode()).toBe("exposed");

    f.events.length = 0;
    await f.guard.capture();
    expect(f.events).toEqual(["suspend", "sleep:120", "capture:hidden", "resume"]);
  });

  it("撤遮罩后要等更久才干净：自检同样按档位重试", async () => {
    const f = make(exposedWorld(300));
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, mode: "exposed" });
    expect(f.events.filter((e) => e.startsWith("sleep"))).toEqual(["sleep:600", "sleep:120", "sleep:300"]);
    expect(f.world.suspends).toBe(2);
    expect(f.world.resumes).toBe(2);
  });

  it("对照图量不出像素：算干净、通过，但结果里没有 cleanRatio（不编一个数）", async () => {
    const f = make(({ hidden }) => (hidden ? null : 1));
    const r = await f.guard.selfCheck();
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("exposed");
    expect("cleanRatio" in r).toBe(false);
    expect(r.withOverlayRatio).toBe(1);
  });

  it("带遮罩和撤掉遮罩都是遮罩色：失败，说明可能是深蓝桌面也可能是撤遮罩没生效；两个占比都带出来；模式不下结论", async () => {
    const f = make(darkDesktopWorld);
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: false, mode: "unknown", withOverlayRatio: 0.97, cleanRatio: 0.97 });
    expect(r.detail).toContain("本来就很暗");
    expect(r.detail).toContain("撤遮罩没有生效");
    expect(r.detail).toContain("97%");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
  });

  it("遮罩被截进画面、而且这套遮罩没有撤的办法：失败，如实说明", async () => {
    const f = make(exposedWorld(), { canHide: false });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: false, withOverlayRatio: 1 });
    expect(r.detail).toContain("没有临时撤掉的办法");
    expect(f.events).toEqual(["sleep:600", "capture:overlay"]);
  });

  it("没有撤的办法、但遮罩也没被截进画面：照样通过（不需要撤）", async () => {
    const f = make(clearWorld, { canHide: false });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, mode: "clear" });
  });

  it("读不出截图像素：跳过、不算失败，模式不变", async () => {
    const f = make(unreadableWorld);
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, skipped: true, mode: "unknown" });
    expect(r.detail).toContain("读不到截图的像素");
    expect(f.world.suspends).toBe(0);
  });

  it("阈值边界同 capture：恰好 0.85 触发对照、0.849 不触发", async () => {
    const hit = make(({ hidden }) => (hidden ? 0.02 : 0.85));
    expect((await hit.guard.selfCheck()).mode).toBe("exposed");
    const miss = make(({ hidden }) => (hidden ? 0.02 : 0.849));
    const r = await miss.guard.selfCheck();
    expect(r.mode).toBe("clear");
    expect(miss.world.suspends).toBe(0);
  });

  it("自检里的截图抛错：原样抛给调用方（manager 会把它记成「遮罩自检出错」），遮罩已恢复", async () => {
    const f = make(exposedWorld(), { captureError: ({ hidden }) => (hidden ? new Error("截图失败") : null) });
    await expect(f.guard.selfCheck()).rejects.toThrow("截图失败");
    expect(f.world.suspends).toBe(1);
    expect(f.world.resumes).toBe(1);
    expect(f.world.depth).toBe(0);
  });
});

describe("遮罩自检：对照颜色指纹（设置页「测试」）", () => {
  it("带遮罩截成一片黑：通过（因为已经改成每次撤遮罩截图），模式 exposed；说明系统把遮罩截成了一片黑，两个占比都带出来", async () => {
    const f = make(blackWorld());
    const r = await f.guard.selfCheck();
    expect(f.events).toEqual(["sleep:600", "capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(r).toMatchObject({ ok: true, mode: "exposed", withOverlayRatio: 0.997, cleanRatio: 0.1 });
    expect(r.detail).toContain("一片黑");
    expect(r.detail).toContain("每次截图前短暂撤掉遮罩");
    expect(f.guard.getMode()).toBe("exposed");
  });

  it("遮罩原样被截进画面（整页深蓝）：通过，说明是「把遮罩截进画面」", async () => {
    const f = make(({ hidden }) => (hidden ? { overlay: 0.05, black: 0.01, sig: REAL_SIG } : { overlay: 1, black: 0, sig: NAVY_SIG }));
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, mode: "exposed" });
    expect(r.detail).toContain("把遮罩截进画面");
    expect(r.detail).toContain("遮罩色占 100%");
  });

  it("带遮罩截到的是过渡态杂色（不黑也不是遮罩色，但和真实屏幕完全不同）：通过，如实说「明显不同」，模式 exposed", async () => {
    const f = make(garbageWorld);
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, mode: "exposed" });
    expect(r.detail).toContain("明显不同");
  });

  it("防截屏生效（两张图是同一个屏幕）：通过，模式 clear；对照要撤一次遮罩，所以会截两张", async () => {
    const f = make(protectedWorld);
    const r = await f.guard.selfCheck();
    expect(f.events).toEqual(["sleep:600", "capture:overlay", "suspend", "sleep:120", "capture:hidden", "resume"]);
    expect(r).toMatchObject({ ok: true, mode: "clear" });
    expect(r.detail).toContain("遮罩没有影响截图");
    expect(r.detail).toContain("画面一致");
    expect(f.guard.getMode()).toBe("clear");
  });

  it("撤了遮罩仍然几乎全黑、而且和带遮罩时是同一个画面（屏幕本来就是黑的 / 撤遮罩没生效，分不出来）：失败，两个都说清楚，模式不下结论", async () => {
    const f = make(blackScreenWorld);
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: false, mode: "unknown", withOverlayRatio: 0.99, cleanRatio: 0.99 });
    expect(r.detail).toContain("黑色占 99%");
    expect(r.detail).toContain("本来就很暗");
    expect(r.detail).toContain("撤遮罩没有生效");
    expect(f.world.suspends).toBe(3);
    expect(f.world.resumes).toBe(3);
  });

  it("撤了遮罩之后是整页深蓝、带遮罩时是一片黑（遮罩根本没变透明）：失败", async () => {
    const f = make(({ hidden }) => (hidden ? { overlay: 0.97, black: 0, sig: NAVY_SIG } : { overlay: 0, black: 0.997, sig: BLACK_SIG }));
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: false, mode: "unknown" });
    expect(r.detail).toContain("撤遮罩没有生效");
  });

  it("带遮罩截成一片黑、而且这套遮罩没有撤的办法：失败，如实说明", async () => {
    const f = make(blackWorld(), { canHide: false });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: false, withOverlayRatio: 0.997 });
    expect(r.detail).toContain("没有临时撤掉的办法");
    expect(r.detail).toContain("黑色占 100%");
    expect(f.events).toEqual(["sleep:600", "capture:overlay"]);
  });

  it("没有撤的办法、带遮罩的画面也正常：通过", async () => {
    const f = make(protectedWorld, { canHide: false });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, mode: "clear" });
    expect(f.world.suspends).toBe(0);
  });

  it("读不出任何像素（颜色比例和指纹都是 null）：跳过、不算失败，模式不变", async () => {
    const f = make(() => ({ overlay: null, black: null, sig: null }));
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, skipped: true, mode: "unknown" });
    expect(f.world.suspends).toBe(0);
  });
});

describe("遮罩自检：等遮罩稳定了再对照（不能拿刚出现的画面给用户下结论）", () => {
  it("遮罩才出现 100ms：先等 600ms，再补等到出现满 1000ms（还差 300ms），然后才截图", async () => {
    const f = make(protectedWorld, { shownAgoMs: 100 });
    const r = await f.guard.selfCheck();
    expect(f.events.slice(0, 3)).toEqual(["sleep:600", "sleep:300", "capture:overlay"]);
    expect(r).toMatchObject({ ok: true, mode: "clear" });
  });

  it("遮罩早就稳定了：只等自己的 600ms，不多等", async () => {
    const f = make(protectedWorld, { shownAgoMs: 5000 });
    await f.guard.selfCheck();
    expect(f.events.slice(0, 2)).toEqual(["sleep:600", "capture:overlay"]);
  });

  it("补等的这段时间里遮罩被撤了（用户动了鼠标）：跳过，不截图", async () => {
    const f = make(protectedWorld, {
      shownAgoMs: 100,
      onSleep: (ms, w) => {
        if (ms === 300) w.shown = false;
      },
    });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(f.screenshotter.capture).not.toHaveBeenCalled();
  });

  it("自检的结论不受「刚出现」影响：遮罩才出现 100ms、自检时一片黑 → 照样 exposed", async () => {
    const f = make(blackWorld(), { shownAgoMs: 100 });
    const r = await f.guard.selfCheck();
    expect(r).toMatchObject({ ok: true, mode: "exposed" });
  });
});

describe("其它", () => {
  it("getMode 起始是 unknown", () => {
    expect(make(clearWorld).guard.getMode()).toBe("unknown");
  });

  it("screenPermission 透传底层截图器的结果；底层没有这个方法时给 unknown", () => {
    const f = make(clearWorld);
    expect(f.guard.screenPermission()).toBe("granted");
    expect(f.screenshotter.screenPermission).toHaveBeenCalledTimes(1);

    const bare = createCaptureGuard({
      overlay: { show: vi.fn(), hide: vi.fn(), isShown: () => false } as never,
      screenshotter: { capture: vi.fn() } as never,
    });
    expect(bare.screenPermission()).toBe("unknown");
  });
});
