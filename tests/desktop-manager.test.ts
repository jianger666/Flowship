/**
 * 电脑操作管理器（electron-app/desktop/manager.mjs）——假 driver / 假解锁器 / 假截图 / 假权限 / 虚拟时钟。
 *
 * manager 是 AI 工具调用和真实电脑之间的最后一道闸，这里钉死的每一条都对应一个「用户吃亏」的后果：
 * - 开关没开 / 没权限 / 组件没装上：一个键鼠动作都不能发生；权限预检在开会话（可能触发自动解锁）之前
 * - 坐标只认「该任务最近一张截图」：没截过 / 屏幕变了 / 会话结束过 → 拒绝，绝不拿旧画面的坐标去点新画面，
 *   更不能为了一个注定失败的点击去解锁用户的电脑
 * - 所有请求串行；被取消的排队请求不再执行
 * - 输入的文字绝不出现在审计 / 日志 / 返回值里；长文本粘贴后一定恢复用户的剪贴板
 * - 设置页的状态里没有任何凭据；「测试锁屏可用」不往 server / 飞书推事件
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isComputerUseStatus } from "@/components/settings/computer-use-card";
import { auditKeyLabel, createDesktopManager, MANAGER_LIMITS, SETTINGS_TEST_TASK } from "../electron-app/desktop/manager.mjs";
import { DESKTOP_OPS } from "../electron-app/desktop/types.mjs";
import { createDarwinUnlocker } from "../electron-app/desktop/unlockers/darwin.mjs";

type Perm = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
type Rect = { x: number; y: number; width: number; height: number };
type Combo = { mods: string[]; key: string };
type UnlockCtx = { signal?: AbortSignal; onStep?: (s: { name: string; ok: boolean; ms: number; detail?: string }) => void };
type UnlockResult = { ok: boolean; code?: string; error?: string; attempted?: boolean };
type Res = {
  ok: boolean;
  image?: { data: string; mimeType: string; width: number; height: number };
  unlockedByUs?: boolean;
  screenshotError?: string;
  [k: string]: unknown;
};

const RECT: Rect = { x: 0, y: 0, width: 2000, height: 1000 };
const SECRET = "S3cret-Pass!";
const TYPED_MARK = "TOPSECRET-TYPED-TEXT";
const DETAIL_MARK = "STEP-DETAIL-SENSITIVE";

interface World {
  clock: number;
  locked: boolean | null;
  lastUserInput: number;
  display: Rect;
  accessibility: Perm;
  screen: Perm;
  credential: boolean;
  captureError: Error | null;
  /** 屏幕上是不是 UAC 之类的系统安全桌面（只有 Opts.secure 给了值，驱动才有 isSecureDesktopActive） */
  secure: boolean;
  /** isSecureDesktopActive 抛异常 */
  secureThrows: boolean;
}

type Opts = {
  platform?: "darwin" | "win32";
  enabled?: boolean;
  lockedAccess?: boolean;
  locked?: boolean;
  /** 驱动带 isSecureDesktopActive（Windows 驱动有、macOS 驱动没有）：缺省 = 不带；给了值 = 带，值是一开始屏幕上是不是安全桌面 */
  secure?: boolean;
  display?: Rect;
  initOk?: boolean;
  initThrows?: boolean;
  accessibility?: Perm;
  screen?: Perm;
  credential?: boolean;
  unlockerSupported?: boolean;
  noUnlocker?: boolean;
  hasCredentialThrows?: boolean;
  /**
   * 解锁器带 hasStoredCredential（Windows 的「存着没」，不看解锁组件版本）：缺省 = 不带（macOS 钥匙串的样子，credentialSet 取 hasCredential）；
   * 给了值 = 带，值就是它的回答；"throws" = 它抛异常
   */
  storedCredential?: boolean | "throws";
  setCredentialResult?: { ok: boolean; saved?: boolean; error?: string };
  noClipboard?: boolean;
  clipboardFormats?: string[];
  clipboardText?: string;
  noSink?: boolean;
  sinkThrows?: boolean;
  apps?: unknown[];
  unlock?: (world: World, ctx: UnlockCtx) => Promise<UnlockResult>;
  lockScreenThrows?: boolean;
  lockScreenNoEffect?: boolean;
  clickGate?: Promise<void>;
  /** desktop_type 的驱动在这个 promise 兑现之前一直「正在打字」，兑现后看 shouldStop 决定要不要收手 */
  typeGate?: Promise<void>;
  /** desktop_type 的驱动打完字之后（submit 的回车之前）世界发生了什么：模拟「打字期间被锁屏 / 弹出 UAC / 锁屏状态读不到」 */
  afterType?: (world: World) => void;
  /** 保存的开机密码「读不出 / 打不出」的预检结果（设置页测试在锁屏之前会问）；缺省 = 解锁器没有这个能力 */
  checkCredential?: () => Promise<{ ok: boolean; error?: string }>;
  localNotifyThrows?: boolean;
  /** sleep 除了推进虚拟时钟，还让出一个宏任务（模拟「真的在等」） */
  yieldOnSleep?: boolean;
  keyComboThrows?: (c: Combo) => boolean;
  openSettingsThrows?: boolean;
  onSleep?: (ms: number, world: World) => void;
  limits?: Record<string, number>;
  writeFileThrows?: boolean;
  /** 截图器的「遮罩自检」（设置页测试在解锁成功、遮罩盖着时调一次）；缺省 = 这个截图器没有该能力（假截图器 / 旧实现） */
  selfCheck?: () => Promise<unknown>;
  /** 截图器当前的截图模式（诊断文件里记一笔）；缺省 = 没有该能力 */
  captureMode?: string;
  /**
   * 注入锁屏后台档（Windows）：true = 默认假实现；对象 = 定制。缺省 = 不注入（macOS 的样子）
   * initOk:false / initThrows：后台组件没初始化成功；windows：后台截图报告的窗口；keyNote：keyCombo 返回的提示；
   * keyNeedForeground：这些组合键后台做不到（抛 NEED_FOREGROUND）；probe：「测试后台操作」的假探针
   */
  background?:
    | boolean
    | {
        initOk?: boolean;
        initThrows?: boolean;
        windows?: Array<Record<string, unknown>>;
        keyNote?: string;
        keyNeedForeground?: (c: Combo) => boolean;
        captureError?: Error;
        typeGate?: Promise<void>;
        probe?: ((ctx: { shouldAbort: () => boolean; onStep?: (s: { name: string; ok: boolean; ms: number; detail?: string }) => void }) => Promise<unknown>) | false;
      };
  /** 解锁器带 Windows 解锁组件的安装 / 卸载 / 状态能力 */
  helper?: {
    installed?: boolean;
    canInstall?: boolean;
    installResult?: { ok: boolean; error?: string };
    uninstallResult?: { ok: boolean; error?: string };
    statusThrows?: boolean;
  };
  /** 解锁器声明 overlayBeforeUnlock（Windows 系统级解锁组件） */
  overlayBeforeUnlock?: boolean;
  /**
   * 用真的 macOS 解锁器（createDarwinUnlocker）顶替假解锁器：假钥匙串里存的就是 SECRET；驱动的键码输入 / 预检、钥匙串保存
   * 可以抛「把入参回显进错误」的毒化异常。用来验证开机密码从「在手上」那一层出来之后，到 AI 的错误 / 事件 / 审计 / 日志 /
   * 本机通知 / 设置页返回值之间没有泄漏（假解锁器返回固定文案，断言「不含密码」恒真，测不出泄漏）。
   */
  realDarwin?: {
    typeError?: (text: string) => unknown;
    canTypeError?: (secret: string) => unknown;
    keychainSetError?: (password: string) => unknown;
  };
};

const instances: Array<{ destroy: () => void }> = [];
afterEach(() => {
  for (const m of instances.splice(0)) m.destroy();
});

const make = (opts: Opts = {}) => {
  const platform = opts.platform ?? "darwin";
  const world: World = {
    clock: 1_000_000,
    locked: opts.locked ?? false,
    lastUserInput: -1e9,
    display: { ...(opts.display ?? RECT) },
    accessibility: opts.accessibility ?? "granted",
    screen: opts.screen ?? "granted",
    credential: opts.credential ?? true,
    captureError: null,
    secure: opts.secure ?? false,
    secureThrows: false,
  };
  const startClock = world.clock;
  const calls: string[] = [];
  const typed: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const events: Array<{ name: string; taskId: string; data: Record<string, unknown> }> = [];
  let shotCount = 0;
  const clip = {
    text: opts.clipboardText ?? "旧剪贴板",
    formats: opts.clipboardFormats ?? ["text/plain"],
    writes: [] as string[],
  };

  const driver = {
    platform,
    init: vi.fn(async () => {
      if (opts.initThrows) throw new Error("dlopen 失败");
      return opts.initOk === false ? { ok: false as const, error: "原生组件加载失败：缺少 koffi" } : { ok: true as const };
    }),
    diagnostics: vi.fn(() => ({ koffi: "3.3.8", platform })),
    isScreenLocked: vi.fn(() => world.locked),
    ...(opts.secure === undefined
      ? {}
      : {
          isSecureDesktopActive: vi.fn(() => {
            if (world.secureThrows) throw new Error("读安全桌面状态出错");
            return world.secure;
          }),
        }),
    idleSeconds: vi.fn(() => (world.clock - world.lastUserInput) / 1000),
    getPrimaryDisplay: vi.fn(() => ({ ...world.display })),
    mouseMove: vi.fn(async (x: number, y: number) => {
      calls.push(`move ${x},${y}`);
    }),
    click: vi.fn(async (x: number, y: number, o?: { button?: string; count?: number }) => {
      calls.push(`click ${x},${y} ${o?.button}x${o?.count}`);
      await opts.clickGate;
    }),
    drag: vi.fn(async (a: { x: number; y: number }, b: { x: number; y: number }, o?: { button?: string }) => {
      calls.push(`drag ${a.x},${a.y}->${b.x},${b.y} ${o?.button}`);
    }),
    scroll: vi.fn(async (x: number, y: number, dx: number, dy: number) => {
      calls.push(`scroll ${x},${y} ${dx},${dy}`);
    }),
    keyCombo: vi.fn(async (c: Combo) => {
      calls.push(`key ${[...c.mods, c.key].join("+")}`);
      if (opts.keyComboThrows?.(c)) throw new Error("按键注入失败");
    }),
    typeText: vi.fn(async (t: string, o?: { shouldStop?: () => boolean }) => {
      calls.push(`type ${t.length}`);
      typed.push(t);
      if (opts.realDarwin?.typeError) throw opts.realDarwin.typeError(t);
      await opts.typeGate;
      opts.afterType?.(world);
      // 真驱动在批次之间看 shouldStop：会话已在收尾就收手，剩下的字不再打
      if (o?.shouldStop?.()) calls.push("type-stopped");
    }),
    listApps: vi.fn(async () => opts.apps ?? []),
    openApp: vi.fn(async (n: string) => {
      calls.push(`open ${n}`);
    }),
    lockScreen: vi.fn(async () => {
      calls.push("lockScreen");
      if (opts.lockScreenThrows) throw new Error("锁屏接口不可用");
      if (!opts.lockScreenNoEffect) world.locked = true;
    }),
  };

  const unlocker = {
    supported: opts.unlockerSupported ?? true,
    hasCredential: vi.fn(async () => {
      if (opts.hasCredentialThrows) throw new Error("钥匙串读取失败");
      return world.credential;
    }),
    setCredential: vi.fn(async (_s: { password: string }) => {
      void _s;
      const r = opts.setCredentialResult ?? { ok: true };
      // saved:true = 密码其实已经存上了（只是冷却记录没清掉），世界里的凭据照样是有的
      if (r.ok || r.saved === true) world.credential = true;
      return r;
    }),
    clearCredential: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => {
      world.credential = false;
      return { ok: true };
    }),
    ...(opts.checkCredential ? { checkCredential: vi.fn(opts.checkCredential) } : {}),
    unlock: vi.fn(async (ctx: UnlockCtx) => {
      calls.push("unlock");
      // detail 可能带敏感信息：manager 只留 name / ok / ms
      ctx.onStep?.({ name: "check", ok: true, ms: 5, detail: DETAIL_MARK });
      ctx.onStep?.({ name: "type", ok: true, ms: 80 });
      if (opts.unlock) return opts.unlock(world, ctx);
      world.locked = false;
      return { ok: true } as UnlockResult;
    }),
    lock: vi.fn(async () => {
      calls.push("lock");
      world.locked = true;
      return { ok: true };
    }),
  };

  const overlay = {
    show: vi.fn(() => {
      calls.push("overlay.show");
    }),
    hide: vi.fn(() => {
      calls.push("overlay.hide");
    }),
    isShown: () => false,
  };

  /** 自检被调用时会话处在什么状态（应该是 active：遮罩盖着、会话还没收尾） */
  const seen = { selfCheckState: null as string | null };
  const screenshotter = {
    capture: vi.fn(async () => {
      calls.push("capture");
      if (world.captureError) throw world.captureError;
      shotCount += 1;
      return {
        jpeg: Buffer.from(`JPEG${shotCount}`),
        frame: { imageWidth: 1000, imageHeight: 500, rect: { ...world.display } },
      };
    }),
    screenPermission: () => world.screen,
    ...(opts.selfCheck
      ? {
          selfCheck: vi.fn(async () => {
            calls.push("selfCheck");
            seen.selfCheckState = manager._session.status().state;
            return opts.selfCheck!();
          }),
        }
      : {}),
    ...(opts.captureMode !== undefined ? { getMode: vi.fn(() => opts.captureMode as string) } : {}),
  };

  const perms = {
    accessibility: vi.fn(() => world.accessibility),
    screen: vi.fn(() => world.screen),
    requestAccessibility: vi.fn(),
    requestScreen: vi.fn(async () => {}),
    openSettings: vi.fn(async (_kind: string) => {
      void _kind;
      if (opts.openSettingsThrows) throw new Error("打不开系统设置");
    }),
  };

  const clipboard = {
    readText: vi.fn(() => clip.text),
    writeText: vi.fn((t: string) => {
      clip.text = t;
      clip.writes.push(t);
    }),
    availableFormats: vi.fn(() => clip.formats),
  };

  const audit = {
    write: vi.fn((e: Record<string, unknown>) => {
      audits.push(e);
    }),
  };
  const fsImpl = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => {
      if (opts.writeFileThrows) throw new Error("磁盘已满");
    }),
  };

  const bgOpts = opts.background === undefined || opts.background === false ? null : opts.background === true ? {} : opts.background;
  let bgShotCount = 0;
  const bgDriver = {
    init: vi.fn(async () => {
      if (bgOpts?.initThrows) throw new Error("后台组件加载炸了");
      return bgOpts?.initOk === false
        ? { ok: false as const, error: "缺少后台档必需的 Win32 函数：PrintWindow" }
        : { ok: true as const };
    }),
    supported: vi.fn(() => bgOpts?.initOk !== false),
    diagnostics: vi.fn(() => ({ ready: bgOpts?.initOk !== false, bindFailures: [] as string[] })),
    reset: vi.fn(() => {
      calls.push("bg.reset");
    }),
    mouseMove: vi.fn(async (x: number, y: number) => {
      calls.push(`bg.move ${x},${y}`);
    }),
    click: vi.fn(async (x: number, y: number, o?: { button?: string; count?: number }) => {
      calls.push(`bg.click ${x},${y} ${o?.button}x${o?.count}`);
    }),
    drag: vi.fn(async (a: { x: number; y: number }, b: { x: number; y: number }, o?: { button?: string }) => {
      calls.push(`bg.drag ${a.x},${a.y}->${b.x},${b.y} ${o?.button}`);
    }),
    scroll: vi.fn(async (x: number, y: number, dx: number, dy: number) => {
      calls.push(`bg.scroll ${x},${y} ${dx},${dy}`);
    }),
    keyCombo: vi.fn(async (c: Combo) => {
      calls.push(`bg.key ${[...c.mods, c.key].join("+")}`);
      if (bgOpts?.keyNeedForeground?.(c)) throw Object.assign(new Error("Win 键组合在锁屏后台模式下按不了"), { code: "NEED_FOREGROUND" });
      return bgOpts?.keyNote ? { note: bgOpts.keyNote } : {};
    }),
    typeText: vi.fn(async (t: string, o?: { shouldStop?: () => boolean }) => {
      calls.push(`bg.type ${t.length}`);
      typed.push(t);
      await bgOpts?.typeGate;
      if (o?.shouldStop?.()) calls.push("bg.type-stopped");
    }),
    openApp: vi.fn(async (n: string) => {
      calls.push(`bg.open ${n}`);
    }),
  };
  const bgShotter = {
    capture: vi.fn(async () => {
      calls.push("bg.capture");
      if (bgOpts?.captureError) throw bgOpts.captureError;
      bgShotCount += 1;
      return {
        jpeg: Buffer.from(`BGJPEG${bgShotCount}`),
        frame: { imageWidth: 1000, imageHeight: 500, rect: { ...world.display } },
        windows: bgOpts?.windows ?? [{ className: "Notepad", processName: "notepad.exe", x: 10, y: 10, width: 300, height: 200, status: "ok" }],
      };
    }),
  };
  const bgProbe =
    bgOpts && bgOpts.probe !== false
      ? {
          run: vi.fn(
            bgOpts.probe ??
              (async (ctx: { onStep?: (s: { name: string; ok: boolean; ms: number; detail?: string }) => void }) => {
                ctx.onStep?.({ name: "lock", ok: true, ms: 12 });
                return { ok: true, steps: [{ name: "lock", ok: true, ms: 12 }] };
              }),
          ),
        }
      : undefined;

  const helperOpts = opts.helper;
  const helperState = { installed: helperOpts?.installed ?? false };
  const helperMethods = helperOpts
    ? {
        helperStatus: vi.fn(async () => {
          if (helperOpts.statusThrows) throw new Error("命名管道连不上");
          return { installed: helperState.installed, canInstall: helperOpts.canInstall ?? true };
        }),
        installHelper: vi.fn(async () => {
          const r = helperOpts.installResult ?? { ok: true };
          if (r.ok) helperState.installed = true;
          return r;
        }),
        uninstallHelper: vi.fn(async () => {
          const r = helperOpts.uninstallResult ?? { ok: true };
          if (r.ok) helperState.installed = false;
          return r;
        }),
      }
    : {};
  const storedMethods =
    opts.storedCredential === undefined
      ? {}
      : {
          hasStoredCredential: vi.fn(async () => {
            if (opts.storedCredential === "throws") throw new Error("组件读取失败");
            return opts.storedCredential === true;
          }),
        };
  Object.assign(unlocker, helperMethods, storedMethods, opts.overlayBeforeUnlock ? { overlayBeforeUnlock: true } : {});

  const realDarwin = opts.realDarwin;
  const realUnlocker = realDarwin
    ? createDarwinUnlocker({
        driver: {
          ...driver,
          wakeDisplay: vi.fn(async () => {
            calls.push("wake");
          }),
          canTypeKeys: (s: string) => {
            if (realDarwin.canTypeError) throw realDarwin.canTypeError(s);
            return true;
          },
        } as never,
        keychain: {
          available: () => true,
          unavailableReason: () => null,
          has: () => true,
          get: () => SECRET,
          set: (password: string) => {
            if (realDarwin.keychainSetError) throw realDarwin.keychainSetError(password);
            return { ok: true };
          },
          remove: () => true,
        },
        now: () => world.clock,
        sleep: async (ms: number) => {
          world.clock += ms;
          opts.onSleep?.(ms, world);
        },
      })
    : null;

  const localAlerts: Array<{ title: string; body: string }> = [];
  const manager = createDesktopManager({
    platform,
    ...(bgOpts ? { background: { driver: bgDriver as never, shotter: bgShotter as never, ...(bgProbe ? { probe: bgProbe as never } : {}) } } : {}),
    notifyLocal: (title: string, body: string) => {
      if (opts.localNotifyThrows) throw new Error("系统通知不可用");
      localAlerts.push({ title, body });
    },
    driver: driver as never,
    unlocker: (opts.noUnlocker ? null : (realUnlocker ?? unlocker)) as never,
    overlay,
    screenshotter: screenshotter as never,
    permissions: perms as never,
    clipboard: opts.noClipboard ? null : clipboard,
    audit,
    userDataDir: "/tmp/flowship-test",
    now: () => world.clock,
    sleep: async (ms: number) => {
      world.clock += ms;
      opts.onSleep?.(ms, world);
      // 虚拟时钟下 sleep 瞬间返回；需要「真的等一拍」的用例（会话收尾在等在飞动作停手）打开它
      if (opts.yieldOnSleep) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    log: (m: string) => logs.push(m),
    fsImpl: fsImpl as never,
    // 看门狗间隔拉到天边：测试里时间由 sleep 推进，不让真实定时器插进来
    sessionLimits: { takeoverPollMs: 3_600_000 },
    limits: opts.limits,
    appInfo: { name: "Flowship", version: "9.9.9", electron: "42.0.0" },
  });
  instances.push(manager);

  const sink = vi.fn((name: string, taskId: string, data: Record<string, unknown>) => {
    if (opts.sinkThrows) throw new Error("ipc 已断开");
    events.push({ name, taskId, data });
  });
  if (!opts.noSink) manager.setEventSink(sink);
  manager.onConfig({ desktopEnabled: opts.enabled ?? true, desktopLockedAccess: opts.lockedAccess ?? true });

  const op = (name: string, args: Record<string, unknown> = {}, ctx: { taskId?: string; signal?: AbortSignal } = {}) =>
    manager.handleOp(name, args, { taskId: "t1", ...ctx }) as Promise<Res>;

  const actionAudits = () => audits.filter((a) => a.type === "action");
  const kinds = () => events.map((e) => e.data.kind);

  return {
    manager,
    world,
    startClock,
    calls,
    typed,
    localAlerts,
    audits,
    actionAudits,
    logs,
    events,
    kinds,
    sink,
    seen,
    driver,
    // 解锁组件三件套只在 helper 选项打开时才有（Windows）
    unlocker: unlocker as typeof unlocker & {
      helperStatus?: ReturnType<typeof vi.fn>;
      installHelper?: ReturnType<typeof vi.fn>;
      uninstallHelper?: ReturnType<typeof vi.fn>;
      hasStoredCredential?: ReturnType<typeof vi.fn>;
    },
    overlay,
    screenshotter,
    bgDriver,
    bgShotter,
    bgProbe,
    perms,
    clipboard,
    clip,
    fsImpl,
    op,
  };
};

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

const messageOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return String((err as Error).message);
  }
  return "";
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** 先截一张图（点击类动作的前置） */
const shot = async (fx: ReturnType<typeof make>, taskId = "t1") => fx.op("desktop_screenshot", {}, { taskId });

describe("基础", () => {
  it("能力名与 op 识别", () => {
    const fx = make();
    expect(fx.manager.capabilities()).toEqual(["desktop.v1"]);
    for (const name of DESKTOP_OPS) expect(fx.manager.isDesktopOp(name)).toBe(true);
    expect(fx.manager.isDesktopOp("browser_click")).toBe(false);
    expect(fx.manager.isDesktopOp(undefined as never)).toBe(false);
  });

  it("未知 op / 缺 taskId：BAD_ARGS，什么都不碰", async () => {
    const fx = make();
    expect(await codeOf(fx.op("desktop_explode"))).toBe("BAD_ARGS");
    expect(await codeOf(fx.manager.handleOp("desktop_screenshot", {}, { taskId: "" }))).toBe("BAD_ARGS");
    expect(await codeOf(fx.manager.handleOp("desktop_screenshot", {}, undefined as never))).toBe("BAD_ARGS");
    expect(fx.driver.init).not.toHaveBeenCalled();
    expect(fx.screenshotter.capture).not.toHaveBeenCalled();
  });

  it("已被取消的请求：CANCELLED，不开会话、不解锁", async () => {
    const fx = make({ locked: true });
    const ac = new AbortController();
    ac.abort();
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }, { signal: ac.signal }))).toBe("CANCELLED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.screenshotter.capture).not.toHaveBeenCalled();
  });

  it("原生组件只初始化一次", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_status");
    await fx.manager.getStatus();
    expect(fx.driver.init).toHaveBeenCalledTimes(1);
  });
});

describe("总开关 / 组件 / 权限", () => {
  it("desktop_status：总开关关着也照常返回（只读），不开会话、不碰键鼠和截图", async () => {
    const fx = make({ enabled: false, lockedAccess: false });
    const r = await fx.op("desktop_status");
    expect(r).toMatchObject({
      ok: true,
      enabled: false,
      platform: "darwin",
      driverReady: true,
      permissions: { accessibility: "granted", screen: "granted" },
      locked: false,
      lockedAccessSupported: true,
      lockedAccessEnabled: false,
      session: { active: false, unlockedByUs: false },
    });
    expect(fx.calls).toEqual([]);
    expect(fx.screenshotter.capture).not.toHaveBeenCalled();
    expect(fx.manager._session.status().state).toBe("idle");
  });

  it("总开关关着：截图 / apps / 所有输入类请求都 ACCESS_DISABLED，驱动一个动作都不做", async () => {
    const fx = make({ enabled: false, locked: true });
    const argsByOp: Record<string, Record<string, unknown>> = {
      desktop_screenshot: {},
      desktop_apps: {},
      desktop_click: { x: 1, y: 1 },
      desktop_move: { x: 1, y: 1 },
      desktop_drag: { x: 1, y: 1, toX: 2, toY: 2 },
      desktop_scroll: { dy: 1 },
      desktop_type: { text: "a" },
      desktop_key: { keys: "enter" },
      desktop_open_app: { name: "微信" },
    };
    for (const [name, args] of Object.entries(argsByOp)) {
      expect(await codeOf(fx.op(name, { ...args, allowUnlock: true })), name).toBe("ACCESS_DISABLED");
    }
    expect(fx.calls).toEqual([]);
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("原生组件没加载成功：UNSUPPORTED 带原因；status 里 driverReady:false + driverError，不碰驱动", async () => {
    const fx = make({ initOk: false });
    const msg = await messageOf(fx.op("desktop_screenshot"));
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("UNSUPPORTED");
    expect(msg).toContain("缺少 koffi");
    const st = await fx.op("desktop_status");
    expect(st).toMatchObject({ ok: true, driverReady: false, driverError: expect.stringContaining("koffi"), locked: null });
    expect(fx.driver.isScreenLocked).not.toHaveBeenCalled();
  });

  it("原生组件初始化抛异常：同样 UNSUPPORTED，不是未处理异常", async () => {
    const fx = make({ initThrows: true });
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("UNSUPPORTED");
    expect(await messageOf(fx.op("desktop_screenshot"))).toContain("dlopen 失败");
  });

  it("macOS 缺屏幕录制：截图 / 点击 / apps 都 NEED_PERMISSION", async () => {
    const fx = make({ screen: "denied" });
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("NEED_PERMISSION");
    expect(await codeOf(fx.op("desktop_apps"))).toBe("NEED_PERMISSION");
    expect(await codeOf(fx.op("desktop_type", { text: "a" }))).toBe("NEED_PERMISSION");
    expect(await messageOf(fx.op("desktop_screenshot"))).toContain("屏幕录制");
    expect(fx.screenshotter.capture).not.toHaveBeenCalled();
    expect(fx.calls).toEqual([]);
  });

  it("macOS 缺辅助功能：输入类被拒（NEED_PERMISSION），截图照常", async () => {
    const fx = make({ accessibility: "denied" });
    expect((await shot(fx)).ok).toBe(true);
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10 }))).toBe("NEED_PERMISSION");
    expect(await codeOf(fx.op("desktop_key", { keys: "enter" }))).toBe("NEED_PERMISSION");
    expect(await messageOf(fx.op("desktop_key", { keys: "enter" }))).toContain("辅助功能");
    expect(fx.calls.filter((c) => !c.startsWith("capture"))).toEqual([]);
  });

  it("权限预检在开会话之前：锁屏 + 缺权限 → 不解锁", async () => {
    const fx = make({ locked: true, accessibility: "denied" });
    expect(await codeOf(fx.op("desktop_type", { text: "a", allowUnlock: true }))).toBe("NEED_PERMISSION");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.manager._session.status().state).toBe("idle");
  });

  it("Windows 不检查这两项权限", async () => {
    const fx = make({ platform: "win32", accessibility: "denied", screen: "denied", unlockerSupported: false });
    expect((await shot(fx)).ok).toBe(true);
    expect((await fx.op("desktop_click", { x: 10, y: 10, screenshot: false })).ok).toBe(true);
    expect(fx.perms.accessibility).not.toHaveBeenCalled();
    expect(fx.perms.screen).not.toHaveBeenCalled();
  });
});

describe("截图", () => {
  it("返回 base64 JPEG + 尺寸；没解锁过 unlockedByUs:false；记入审计", async () => {
    const fx = make();
    const r = await shot(fx);
    expect(r).toEqual({
      ok: true,
      image: { data: b64("JPEG1"), mimeType: "image/jpeg", width: 1000, height: 500 },
      unlockedByUs: false,
    });
    expect(fx.actionAudits()).toEqual([expect.objectContaining({ op: "desktop_screenshot", taskId: "t1", ok: true })]);
  });

  it("请求串行执行：后一个等前一个结束才开始；排队中被取消的不再执行", async () => {
    const gate = deferred();
    const fx = make({ clickGate: gate.promise });
    await shot(fx);
    const p1 = fx.op("desktop_click", { x: 10, y: 10, screenshot: false });
    const ac = new AbortController();
    const p2 = fx.op("desktop_click", { x: 20, y: 20, screenshot: false }, { signal: ac.signal });
    const p3 = fx.op("desktop_click", { x: 30, y: 30, screenshot: false });
    const acShot = new AbortController();
    const p4 = fx.op("desktop_screenshot", {}, { signal: acShot.signal });
    await flush();
    expect(fx.driver.click).toHaveBeenCalledTimes(1); // p1 卡在闸门上，其余还在排队
    ac.abort();
    acShot.abort();
    gate.resolve();
    expect((await p1).ok).toBe(true);
    expect(await codeOf(p2)).toBe("CANCELLED");
    expect((await p3).ok).toBe(true);
    expect(await codeOf(p4)).toBe("CANCELLED");
    expect(fx.calls.filter((c) => c.startsWith("click"))).toEqual(["click 20,20 leftx1", "click 60,60 leftx1"]);
    expect(fx.screenshotter.capture).toHaveBeenCalledTimes(1); // 被取消的截图没有执行（只有开头那一张）
  });

  it("锁屏时并发的两个请求只解锁一次", async () => {
    const fx = make({ locked: true });
    const [a, b] = await Promise.all([
      fx.op("desktop_screenshot", { allowUnlock: true }),
      fx.op("desktop_apps", { allowUnlock: true }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
  });
});

describe("坐标换算", () => {
  it("点击：截图像素 → 输入坐标（线性映射，不取决于缩放系数）", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_click", { x: 100, y: 50, screenshot: false });
    expect(fx.calls.at(-1)).toBe("click 200,100 leftx1");
  });

  it("显示器有偏移时一并换算", async () => {
    const fx = make({ display: { x: 100, y: 50, width: 1000, height: 500 } });
    await shot(fx);
    await fx.op("desktop_click", { x: 10, y: 20, screenshot: false });
    expect(fx.calls.at(-1)).toBe("click 110,70 leftx1");
  });

  it("数字写成字符串也认；写成别的 → BAD_ARGS，不碰驱动", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_click", { x: "100", y: "50", screenshot: false });
    expect(fx.calls.at(-1)).toBe("click 200,100 leftx1");
    const before = fx.driver.click.mock.calls.length;
    expect(await codeOf(fx.op("desktop_click", { x: "abc", y: 5 }))).toBe("BAD_ARGS");
    expect(await codeOf(fx.op("desktop_click", { y: 5 }))).toBe("BAD_ARGS");
    expect(await codeOf(fx.op("desktop_click", { x: Number.NaN, y: 5 }))).toBe("BAD_ARGS");
    expect(fx.driver.click.mock.calls.length).toBe(before);
  });

  it("越界坐标：BAD_ARGS（不静默夹到边缘），不碰驱动", async () => {
    const fx = make();
    await shot(fx);
    expect(await codeOf(fx.op("desktop_click", { x: 5000, y: 10 }))).toBe("BAD_ARGS");
    expect(await codeOf(fx.op("desktop_click", { x: -1, y: 10 }))).toBe("BAD_ARGS");
    expect(fx.driver.click).not.toHaveBeenCalled();
  });

  it("没截过图就点：BAD_ARGS；缺 frame 时不开会话（锁屏时也就不会去解锁）", async () => {
    const fx = make({ locked: true });
    expect(await codeOf(fx.op("desktop_click", { x: 1, y: 1, allowUnlock: true }))).toBe("BAD_ARGS");
    expect(await messageOf(fx.op("desktop_move", { x: 1, y: 1, allowUnlock: true }))).toContain("desktop_screenshot");
    for (const [name, args] of [
      ["desktop_drag", { x: 1, y: 1, toX: 2, toY: 2 }],
      ["desktop_scroll", { dy: 1 }],
    ] as const) {
      expect(await codeOf(fx.op(name, { ...args, allowUnlock: true })), name).toBe("BAD_ARGS");
    }
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.calls).toEqual([]);
  });

  it("参数本身不合法（空文本 / 超长 / 被拦的组合键 / 空应用名）：锁屏时也不开会话——不解锁、不盖遮罩、不输密码（评审 d）", async () => {
    // 这三个动作不需要截图坐标，没有「缺 frame 就不开会话」那道闸：以前是先 begin（锁屏 = 自动解锁 + 盖遮罩）再 parse 报错，
    // 即「为一个注定失败的调用输了一次开机密码」。现在 parse 在 begin 之前先验一遍。
    const fx = make({ locked: true });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["desktop_type", { text: "" }, "BAD_ARGS"],
      ["desktop_type", { text: 123 }, "BAD_ARGS"],
      ["desktop_type", { text: "x".repeat(5001) }, "BAD_ARGS"],
      ["desktop_key", { keys: "cmd+shift+q" }, "BLOCKED"],
      ["desktop_key", { keys: "hyper+z" }, "BAD_ARGS"],
      ["desktop_open_app", { name: "   " }, "BAD_ARGS"],
      ["desktop_open_app", {}, "BAD_ARGS"],
    ];
    for (const [name, args, code] of cases) {
      expect(await codeOf(fx.op(name, { ...args, allowUnlock: true })), `${name} ${JSON.stringify(args).slice(0, 40)}`).toBe(code);
    }
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.world.locked).toBe(true); // 电脑还是锁着的
    expect(fx.calls).toEqual([]); // 没有 unlock / overlay.show / 任何键鼠动作
    expect(fx.manager._session.status().state).toBe("idle"); // 会话根本没开
  });

  it("参数合法才会开会话：同一个锁屏夹具里，合法的 desktop_open_app 照常解锁并执行", async () => {
    // 对照：上一条不是「锁屏时一律不让动」，而是「参数不合法才不动」
    const fx = make({ locked: true });
    await fx.op("desktop_open_app", { name: "微信", allowUnlock: true, screenshot: false });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(fx.calls).toContain("open 微信");
  });

  it("屏幕尺寸变了：旧截图作废（BAD_ARGS），frame 被清掉；重新截图后按新尺寸换算", async () => {
    const fx = make();
    await shot(fx);
    fx.world.display = { x: 0, y: 0, width: 1600, height: 1000 };
    expect(await messageOf(fx.op("desktop_click", { x: 10, y: 10 }))).toContain("屏幕尺寸");
    expect(await messageOf(fx.op("desktop_click", { x: 10, y: 10 }))).toContain("还没有截图");
    expect(fx.driver.click).not.toHaveBeenCalled();
    await shot(fx);
    await fx.op("desktop_click", { x: 100, y: 50, screenshot: false });
    expect(fx.calls.at(-1)).toBe("click 160,100 leftx1");
  });

  it("每个任务各用各的截图：别的任务的 frame 不能借用", async () => {
    const fx = make();
    await shot(fx, "t1");
    await fx.op("desktop_end_session", {}, { taskId: "t1" });
    expect(await codeOf(fx.op("desktop_click", { x: 1, y: 1 }, { taskId: "t2" }))).toBe("BAD_ARGS");
  });

  it("会话结束（end_session / 任务取消 / 用户接管）后 frame 作废：不能拿旧画面的坐标点新画面", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    await fx.op("desktop_end_session"); // 解锁过的 → 锁回去
    expect(fx.world.locked).toBe(true);
    const unlocks = fx.unlocker.unlock.mock.calls.length;
    expect(await codeOf(fx.op("desktop_click", { x: 1, y: 1, allowUnlock: true }))).toBe("BAD_ARGS");
    expect(fx.unlocker.unlock.mock.calls.length).toBe(unlocks); // 没有为一个注定失败的点击再解一次锁

    const fx2 = make();
    await shot(fx2);
    fx2.manager.onCancel("t1");
    await flush();
    expect(await codeOf(fx2.op("desktop_click", { x: 1, y: 1 }))).toBe("BAD_ARGS");
  });

  it("截图进行中会话结束了：这张图作废（SESSION_EXPIRED），坐标映射不会被「复活」；之后点击要求重新截图", async () => {
    const holder: { fx?: ReturnType<typeof make> } = {};
    const fx = make();
    holder.fx = fx;
    await shot(fx); // 先有一个正常的会话 + 一张图
    // 下一次截图的「抓取」期间，会话被结束了（用户接管 / 超时 / 任务被停：这里用 end_session 的底层 end 模拟）
    fx.screenshotter.capture.mockImplementationOnce(async () => {
      await holder.fx!.manager._session.end("explicit");
      return { jpeg: Buffer.from("JPEG-STALE"), frame: { imageWidth: 1000, imageHeight: 500, rect: { ...RECT } } };
    });
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("SESSION_EXPIRED");
    expect(await messageOf(fx.op("desktop_click", { x: 10, y: 10 }))).toContain("还没有截图"); // 没有留下死会话的画面坐标
    expect(fx.driver.click).not.toHaveBeenCalled();
    // 重新截图开始新会话后一切恢复
    expect((await shot(fx)).ok).toBe(true);
    await fx.op("desktop_click", { x: 100, y: 50, screenshot: false });
    expect(fx.calls.at(-1)).toBe("click 200,100 leftx1");
  });

  it("动作后补截图期间会话结束了：同样以 SESSION_EXPIRED 报告，不存新坐标", async () => {
    const holder: { fx?: ReturnType<typeof make> } = {};
    const fx = make();
    holder.fx = fx;
    await shot(fx);
    fx.screenshotter.capture.mockImplementationOnce(async () => {
      await holder.fx!.manager._session.end("explicit");
      return { jpeg: Buffer.from("JPEG-STALE"), frame: { imageWidth: 1000, imageHeight: 500, rect: { ...RECT } } };
    });
    expect(await codeOf(fx.op("desktop_click", { x: 100, y: 50 }))).toBe("SESSION_EXPIRED");
    expect(fx.calls.filter((c) => c.startsWith("click"))).toHaveLength(1); // 点击本身已经发生过
    expect(await messageOf(fx.op("desktop_click", { x: 10, y: 10 }))).toContain("还没有截图");
  });
});

describe("会话收尾时在飞的输入动作", () => {
  it("desktop_type 正在打字时任务被停：先等它收手（shouldStop）再锁屏；submit 的回车不再按", async () => {
    const gate = deferred();
    const fx = make({ locked: true, typeGate: gate.promise, yieldOnSleep: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const typing = fx.op("desktop_type", { text: "hello", submit: true, screenshot: false });
    await flush();
    expect(fx.calls).toContain("type 5");

    fx.manager.onCancel("t1"); // 用户点了停止
    await flush();
    // 打字还没收手：不能锁屏（锁屏界面一出来，剩下的字 / 回车就会打进密码框）
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.overlay.hide).not.toHaveBeenCalled();

    gate.resolve();
    // 动作收手之后：回车被跳过、会话 SESSION_EXPIRED、电脑锁回去
    expect(await codeOf(typing)).toBe("SESSION_EXPIRED");
    await flush();
    expect(fx.calls).toContain("type-stopped"); // 驱动看到了 shouldStop
    expect(fx.calls).not.toContain("key enter");
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
    expect(fx.world.locked).toBe(true);
    // 顺序：打完 → 锁屏 → 撤遮罩
    const tail = fx.calls.slice(fx.calls.indexOf("type-stopped"));
    expect(tail).toEqual(["type-stopped", "lock", "overlay.hide"]);
  });

  it("动作刚被放行、第一个字还没打时会话就被结束了：一个字都不打（typeText 入口的 shouldStop 门）", async () => {
    const holder: { fx?: ReturnType<typeof make> } = {};
    const fx = make();
    holder.fx = fx;
    await shot(fx);
    // guard 放行前最后被问到的是 idleSeconds：就在这一刻（同步地）结束会话，模拟「刚放行、紧接着会话就没了」。
    // 之后才轮到 typeText——这时锁屏界面可能已经出来，打一个字都是往密码框里打
    fx.driver.idleSeconds.mockImplementationOnce(() => {
      void holder.fx!.manager._session.end("cancelled");
      return 999;
    });
    expect(await codeOf(fx.op("desktop_type", { text: "abc", submit: true, screenshot: false }))).toBe("SESSION_EXPIRED");
    expect(fx.driver.typeText).not.toHaveBeenCalled();
    expect(fx.calls.some((c) => c.startsWith("type"))).toBe(false);
    expect(fx.calls).not.toContain("key enter");
  });

  it("会话结束之后再来一次打字：开新会话照常打字（旧会话的收尾状态不会拦住新会话）", async () => {
    const fx = make();
    await shot(fx);
    await fx.manager._session.end("explicit");
    expect(fx.manager._session.shouldStop()).toBe(true);
    const typed0 = fx.typed.length;
    expect((await fx.op("desktop_type", { text: "abc", screenshot: false })).ok).toBe(true);
    expect(fx.typed.length).toBe(typed0 + 1); // 新会话 active：照常打
  });

  it("动作进行中会话被结束：不再等界面稳定（收尾在等这个动作停手，别拖慢）；正常完成的动作照常等", async () => {
    const SETTLE = 777; // 独一无二的 settle 时长：和其它 sleep（排队 / 轮询步长）区分开
    // 对照：正常完成的 desktop_type 会等一次 settleTypeMs（证明下面「没有 777」不是因为插桩没生效）
    const sleepsOk: number[] = [];
    const ok = make({ limits: { settleTypeMs: SETTLE }, onSleep: (ms) => sleepsOk.push(ms) });
    await shot(ok);
    expect((await ok.op("desktop_type", { text: "abc", screenshot: false })).ok).toBe(true);
    expect(sleepsOk).toContain(SETTLE);

    const gate = deferred();
    const sleeps: number[] = [];
    const fx = make({ limits: { settleTypeMs: SETTLE }, onSleep: (ms) => sleeps.push(ms), typeGate: gate.promise, yieldOnSleep: true });
    await shot(fx);
    const typing = fx.op("desktop_type", { text: "hello", screenshot: false });
    await flush();
    expect(fx.calls).toContain("type 5");
    fx.manager.onCancel("t1"); // 打字还没收手时用户点了停止
    await flush();
    gate.resolve();
    expect(await codeOf(typing)).toBe("SESSION_EXPIRED");
    expect(sleeps).not.toContain(SETTLE);
  });

  it("desktop_key repeat 打到一半会话结束：不再继续按", async () => {
    const holder: { fx?: ReturnType<typeof make> } = {};
    let presses = 0;
    const fx = make({
      keyComboThrows: () => {
        presses += 1;
        if (presses === 2) void holder.fx?.manager._session.end("cancelled"); // 第二下按完时会话被结束
        return false;
      },
    });
    holder.fx = fx;
    await shot(fx);
    // 动作被打断：不能当成功报告（screenshot:false 时没有补截图那一关，这里要靠动作后的会话检查）
    expect(await codeOf(fx.op("desktop_key", { keys: "down", repeat: 10, screenshot: false }))).toBe("SESSION_EXPIRED");
    expect(fx.calls.filter((c) => c === "key down").length).toBeLessThan(10);
    expect(fx.calls.filter((c) => c === "key down").length).toBeGreaterThanOrEqual(2);
  });

  // 第四轮评审 A3-a：desktop_key 的 repeat 每按一下之前也要过会话闸门——连按回车 = 一次次往锁屏界面的密码框提交，
  // 而看门狗每 0.3 秒才看一次锁屏、shouldStop 只认会话状态（和 desktop_type submit 的回车同一类风险，那边第三轮已经修了）。
  // 这组用例里测试没有推进计时器，看门狗不可能介入：停手只能是 repeat 循环里的 guard 做的
  describe("desktop_key repeat：第 2 下起每按一下之前再过一遍会话闸门", () => {
    const pressesOf = (fx: ReturnType<typeof make>) => fx.calls.filter((c) => c === "key enter").length;
    const press = (fx: ReturnType<typeof make>) => fx.op("desktop_key", { keys: "enter", repeat: 10, screenshot: false });
    /** 第 at 下按完时翻转世界（keyComboThrows 在每次按键注入时被调用，借它当「按完第 N 下」的钩子；返回 false = 不抛） */
    const flipAfterPress = (at: number, flip: (fx: ReturnType<typeof make>) => void, extra: Parameters<typeof make>[0] = {}) => {
      const holder: { fx?: ReturnType<typeof make> } = {};
      let presses = 0;
      const fx = make({
        ...extra,
        keyComboThrows: () => {
          presses += 1;
          if (presses === at && holder.fx) flip(holder.fx);
          return false;
        },
      });
      holder.fx = fx;
      return fx;
    };

    // at = 1 是区分点：第 1 下之前的闸门由 session.runAction 负责，repeat 循环里的 guard 必须赶在「第 2 下按下去之前」，
    // 而不是「按完之后」才看（那样就多按了一下）；at = 3 证明中途任意位置都一样
    it.each([1, 3])("第 %i 下按完时电脑被锁屏：后面不再按（不等看门狗）；动作报 SESSION_EXPIRED，会话结束、不重复锁屏", async (at) => {
      const fx = flipAfterPress(at, (f) => {
        f.world.locked = true;
      });
      await shot(fx);
      expect(await codeOf(press(fx))).toBe("SESSION_EXPIRED");
      await flush();
      expect(pressesOf(fx), "锁屏之后一下都不能再按").toBe(at);
      expect(fx.unlocker.lock, "已经是锁屏状态，不该再发锁屏命令").not.toHaveBeenCalled();
      expect(fx.manager._session.status().state).toBe("idle");
    });

    it("第 1 下按完时锁屏状态读不到（null）：第 2 下不按；报 INTERNAL（让模型照实告诉用户），会话不被结束", async () => {
      const fx = flipAfterPress(1, (f) => {
        f.world.locked = null;
      });
      await shot(fx);
      expect(await codeOf(press(fx))).toBe("INTERNAL");
      expect(pressesOf(fx)).toBe(1);
      // 与动作开始时的 guard 同口径：这一下不放行，会话还在（下一次读到「没锁」就照常继续）
      expect(fx.manager._session.status().state).toBe("active");
    });

    it("第 1 下按完时弹出系统安全桌面（UAC）：第 2 下不按（回车 = 替用户点了「是」）；报 SECURE_DESKTOP", async () => {
      const fx = flipAfterPress(
        1,
        (f) => {
          f.world.secure = true;
        },
        { secure: false },
      );
      await shot(fx);
      expect(await codeOf(press(fx))).toBe("SECURE_DESKTOP");
      await flush();
      expect(pressesOf(fx)).toBe(1);
    });

    it("对照：中途什么都没变 → 10 下全部按完", async () => {
      const fx = flipAfterPress(99, () => undefined);
      await shot(fx);
      expect((await press(fx)).ok).toBe(true);
      expect(pressesOf(fx)).toBe(10);
    });
  });

  // 第三轮评审 P1-3：guard 只在动作开始时看一眼；desktop_type 要打一阵子 + 80ms，才轮到 submit 的回车。
  // 回车是最危险的一击（锁屏界面上它 = 提交密码）：按之前要再过一遍会话闸门
  describe("desktop_type submit：回车前再过一遍会话闸门", () => {
    const typeSubmit = (fx: ReturnType<typeof make>) => fx.op("desktop_type", { text: "hello", submit: true, screenshot: false });

    it("对照：打字期间什么都没变 → 回车照常按", async () => {
      const fx = make();
      await shot(fx);
      expect((await typeSubmit(fx)).ok).toBe(true);
      expect(fx.calls).toContain("key enter");
    });

    it("打字期间电脑被锁屏：回车不按（否则 = 往锁屏密码框提交）；动作报 SESSION_EXPIRED，会话结束、不重复锁屏", async () => {
      const fx = make({
        afterType: (w) => {
          w.locked = true;
        },
      });
      await shot(fx);
      expect(await codeOf(typeSubmit(fx))).toBe("SESSION_EXPIRED");
      await flush();
      expect(fx.calls).toContain("type 5");
      expect(fx.calls, "锁屏之后回车不能再按").not.toContain("key enter");
      expect(fx.unlocker.lock, "已经是锁屏状态，不该再发锁屏命令").not.toHaveBeenCalled();
      expect(fx.manager._session.status().state).toBe("idle");
    });

    it("打字期间锁屏状态读不到（null）：回车不按；报 INTERNAL（让模型照实告诉用户），会话不被结束", async () => {
      const fx = make({
        afterType: (w) => {
          w.locked = null;
        },
      });
      await shot(fx);
      expect(await codeOf(typeSubmit(fx))).toBe("INTERNAL");
      expect(fx.calls).not.toContain("key enter");
      // 与动作开始时的 guard 同口径：这一下不放行，会话还在（下一次读到「没锁」就照常继续）
      expect(fx.manager._session.status().state).toBe("active");
    });

    it("打字期间弹出系统安全桌面（UAC）：回车不按（回车 = 替用户点了「是」）；报 SECURE_DESKTOP", async () => {
      const fx = make({
        secure: false,
        afterType: (w) => {
          w.secure = true;
        },
      });
      await shot(fx);
      expect(await codeOf(typeSubmit(fx))).toBe("SECURE_DESKTOP");
      await flush();
      expect(fx.calls).not.toContain("key enter");
    });

    it("锁屏后台档（Windows）：打字期间用户回来解锁了 → 回车不按（后台会话的前提「电脑锁着」已不成立）", async () => {
      const fx = make({ platform: "win32", locked: true, background: true });
      await fx.op("desktop_screenshot", { allowUnlock: true });
      expect(fx.manager._session.status().mode).toBe("background");
      // 后台档的打字走 bgDriver（不经 driver.typeText，所以不是 afterType 选项）：在后台驱动打完字之后翻转世界
      fx.bgDriver.typeText.mockImplementationOnce(async (t: string) => {
        fx.calls.push(`bg.type ${t.length}`);
        fx.world.locked = false;
      });
      expect(await codeOf(typeSubmit(fx))).toBe("SESSION_EXPIRED");
      expect(fx.calls.some((c) => c.startsWith("bg.key"))).toBe(false);
    });
  });

  // 第三轮评审（僵尸动作）：收尾等在飞动作停手有上限，超时的动作稍后才返回——此时新会话可能已经 active，
  // 会话级的 shouldStop 说「没事」，它就会把剩下的字打进新会话里
  it("drain 超时被丢下的 desktop_type：新会话 active 之后驱动拿到的 shouldStop 仍为 true（僵尸动作不会在新会话里接着打字）", async () => {
    const gate = deferred();
    const fx = make({ typeGate: gate.promise, yieldOnSleep: true });
    await shot(fx);
    const typing = fx.op("desktop_type", { text: "hello", screenshot: false });
    await flush();
    expect(fx.calls).toContain("type 5");

    // 会话被结束：动作卡在驱动里（gate 没放行），收尾等满 actionDrainMs 后照常收尾
    await fx.manager._session.end("explicit");
    expect(fx.manager._session.status().state).toBe("idle");

    // 同一任务马上又开始了新会话（begin 在串行队列之前，所以不会被卡住的动作挡住）
    const second = fx.op("desktop_screenshot");
    await flush();
    expect(fx.manager._session.status().state).toBe("active");
    expect(fx.manager._session.shouldStop(), "会话级判断：新会话是活的").toBe(false);

    gate.resolve();
    expect(await codeOf(typing)).toBe("SESSION_EXPIRED");
    expect(fx.calls, "僵尸动作拿到的 shouldStop 应为 true（会话级的判断在新会话里是 false）").toContain("type-stopped");
    expect((await second).ok).toBe(true);
  });

  it("动作正常完成（会话没被结束）：结果照常成功，不会被误判成 SESSION_EXPIRED", async () => {
    const fx = make();
    await shot(fx);
    expect(await fx.op("desktop_key", { keys: "enter", screenshot: false })).toEqual({ ok: true });
    expect(await fx.op("desktop_type", { text: "abc", submit: true, screenshot: false })).toEqual({ ok: true });
  });
});

describe("动作与自动截图", () => {
  it("点击：默认动作后带一张新截图；screenshot:false 不带；结果里没有内部审计字段", async () => {
    const fx = make();
    await shot(fx);
    const r = await fx.op("desktop_click", { x: 100, y: 50 });
    expect(r).toEqual({ ok: true, image: { data: b64("JPEG2"), mimeType: "image/jpeg", width: 1000, height: 500 }, unlockedByUs: false });
    expect(JSON.stringify(r)).not.toContain("_audit");
    const shots = fx.screenshotter.capture.mock.calls.length;
    expect(await fx.op("desktop_click", { x: 100, y: 50, screenshot: false })).toEqual({ ok: true });
    expect(fx.screenshotter.capture.mock.calls.length).toBe(shots);
  });

  it("动作带回的新截图会更新坐标映射：动作过程中屏幕尺寸变了，下一步直接按新截图换算", async () => {
    const fx = make({
      onSleep: (ms, w) => {
        if (ms === MANAGER_LIMITS.postActionShotDelayMs) w.display = { x: 0, y: 0, width: 1600, height: 1000 };
      },
    });
    await shot(fx);
    await fx.op("desktop_click", { x: 100, y: 50 }); // 动作后的自动截图拿到的是新尺寸
    await fx.op("desktop_click", { x: 100, y: 50, screenshot: false });
    expect(fx.calls.filter((c) => c.startsWith("click"))).toEqual(["click 200,100 leftx1", "click 160,100 leftx1"]);
  });

  it("动作之后的截图失败：动作结果仍是 ok，带 screenshotError", async () => {
    const fx = make();
    await shot(fx);
    fx.world.captureError = new Error("截图失败（显示器在休眠）");
    const r = await fx.op("desktop_click", { x: 10, y: 10 });
    expect(r).toMatchObject({ ok: true, screenshotError: expect.stringContaining("显示器在休眠") });
    expect(r.image).toBeUndefined();
    expect(fx.calls).toContain("click 20,20 leftx1");
  });

  it("click 参数：count 夹在 1–3、button 只认 left/right/middle", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_click", { x: 100, y: 50, count: 9, button: "right", screenshot: false });
    await fx.op("desktop_click", { x: 100, y: 50, count: 0, screenshot: false });
    await fx.op("desktop_click", { x: 100, y: 50, count: 2.9, button: "middle", screenshot: false });
    expect(fx.calls.filter((c) => c.startsWith("click"))).toEqual(["click 200,100 rightx3", "click 200,100 leftx1", "click 200,100 middlex2"]);
    expect(await codeOf(fx.op("desktop_click", { x: 1, y: 1, button: "extra" }))).toBe("BAD_ARGS");
  });

  it("move / drag：坐标逐点换算", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_move", { x: 100, y: 50, screenshot: false });
    await fx.op("desktop_drag", { x: 100, y: 50, toX: 300, toY: 150, screenshot: false });
    expect(fx.calls.filter((c) => c.startsWith("move") || c.startsWith("drag"))).toEqual(["move 200,100", "drag 200,100->600,300 left"]);
    expect(await codeOf(fx.op("desktop_drag", { x: 100, y: 50 }))).toBe("BAD_ARGS");
  });

  it("scroll：缺 x / y 取屏幕中心；格数夹在 ±50；dx、dy 全 0 → BAD_ARGS", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_scroll", { dy: 3, screenshot: false });
    await fx.op("desktop_scroll", { x: 100, y: 50, dx: -200, dy: 200, screenshot: false });
    expect(fx.calls.filter((c) => c.startsWith("scroll"))).toEqual(["scroll 1000,500 0,3", "scroll 200,100 -50,50"]);
    expect(await codeOf(fx.op("desktop_scroll", {}))).toBe("BAD_ARGS");
    expect(await codeOf(fx.op("desktop_scroll", { dx: 0, dy: 0 }))).toBe("BAD_ARGS");
  });

  it("动作之间用户碰了键鼠：USER_TOOK_OVER，这一步不执行；会话结束、不锁屏、frame 作废；用户停手 30 秒后才能重新开始", async () => {
    const fx = make();
    await shot(fx);
    fx.world.clock += 2000;
    fx.world.lastUserInput = fx.world.clock;
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10 }))).toBe("USER_TOOK_OVER");
    expect(fx.driver.click).not.toHaveBeenCalled();
    expect(fx.kinds()).toEqual(expect.arrayContaining(["user_took_over", "session_ended"]));
    expect(fx.manager._session.status().state).toBe("idle");
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10 }))).toBe("BAD_ARGS"); // frame 已作废
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("USER_TOOK_OVER"); // 用户还在动，不抢
    fx.world.clock += 31_000;
    expect((await shot(fx)).ok).toBe(true);
  });

  it("动作做完、截图之前用户碰了键鼠：USER_TOOK_OVER 原样抛出（AI 要知道这一步已经执行了）", async () => {
    const fx = make({
      limits: { postActionShotDelayMs: 1000 },
      onSleep: (ms, w) => {
        if (ms === 1000) w.lastUserInput = w.clock;
      },
    });
    await shot(fx);
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10 }))).toBe("USER_TOOK_OVER");
    expect(fx.calls).toContain("click 20,20 leftx1");
  });
});

describe("输入文字", () => {
  it("短文本：逐字输入（Unicode 路径），不碰剪贴板；返回值 / 审计 / 日志里没有文本", async () => {
    const fx = make();
    await shot(fx);
    const r = await fx.op("desktop_type", { text: `${TYPED_MARK} 你好`, screenshot: false });
    expect(r).toEqual({ ok: true });
    expect(fx.typed).toEqual([`${TYPED_MARK} 你好`]);
    // 不带 mode：Unicode 事件；带 shouldStop：会话结束时驱动在批次之间提前收手
    expect(fx.driver.typeText.mock.calls[0]?.[1]).toEqual({ shouldStop: expect.any(Function) });
    expect(fx.clipboard.writeText).not.toHaveBeenCalled();
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_type", ok: true, chars: `${TYPED_MARK} 你好`.length });
    for (const sink of [JSON.stringify(fx.audits), fx.logs.join("\n"), JSON.stringify(r), JSON.stringify(fx.events)]) {
      expect(sink).not.toContain(TYPED_MARK);
    }
  });

  it("恰好 120 字符仍逐字输入；121 字符且剪贴板只有文字 → 粘贴，用完恢复原剪贴板", async () => {
    const at = make();
    await shot(at);
    await at.op("desktop_type", { text: "a".repeat(120), screenshot: false });
    expect(at.typed).toHaveLength(1);
    expect(at.clip.writes).toEqual([]);

    const fx = make({ clipboardText: "用户原来复制的东西" });
    await shot(fx);
    const long = `${TYPED_MARK}${"x".repeat(200)}`;
    await fx.op("desktop_type", { text: long, screenshot: false });
    expect(fx.driver.typeText).not.toHaveBeenCalled();
    expect(fx.calls).toContain("key meta+v");
    expect(fx.clip.writes).toEqual([long, "用户原来复制的东西"]);
    expect(fx.clip.text).toBe("用户原来复制的东西");
    for (const sink of [JSON.stringify(fx.audits), fx.logs.join("\n")]) expect(sink).not.toContain(TYPED_MARK);
  });

  it("Windows 的粘贴是 ctrl+v", async () => {
    const fx = make({ platform: "win32", unlockerSupported: false });
    await shot(fx);
    await fx.op("desktop_type", { text: "y".repeat(200), screenshot: false });
    expect(fx.calls).toContain("key ctrl+v");
  });

  it("长文本但剪贴板里有图片 / 文件 / 富文本（html、rtf）：不动剪贴板（恢复时会丢格式），逐字输入", async () => {
    for (const formats of [["text/plain", "image/png"], ["text/plain", "text/html"], ["text/rtf"], ["text/uri-list"]]) {
      const fx = make({ clipboardFormats: formats });
      await shot(fx);
      await fx.op("desktop_type", { text: "z".repeat(300), screenshot: false });
      expect(fx.typed, formats.join()).toHaveLength(1);
      expect(fx.clip.writes, formats.join()).toEqual([]);
    }
  });

  it("没有剪贴板可用 / 剪贴板空：分别逐字输入 / 粘贴", async () => {
    const none = make({ noClipboard: true });
    await shot(none);
    await none.op("desktop_type", { text: "z".repeat(300), screenshot: false });
    expect(none.typed).toHaveLength(1);

    const empty = make({ clipboardFormats: [], clipboardText: "" });
    await shot(empty);
    await empty.op("desktop_type", { text: "z".repeat(300), screenshot: false });
    expect(empty.typed).toHaveLength(0);
    expect(empty.clip.text).toBe("");
  });

  it("粘贴过程中出错：剪贴板依然恢复，错误照常抛出", async () => {
    const fx = make({ keyComboThrows: (c) => c.key === "v", clipboardText: "别丢了" });
    await shot(fx);
    await expect(fx.op("desktop_type", { text: "q".repeat(200), screenshot: false })).rejects.toThrow("按键注入失败");
    expect(fx.clip.text).toBe("别丢了");
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_type", ok: false });
  });

  it("submit:true：输完再按一下回车", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_type", { text: "你好", submit: true, screenshot: false });
    expect(fx.calls.filter((c) => c.startsWith("type") || c.startsWith("key"))).toEqual(["type 2", "key enter"]);
    await fx.op("desktop_type", { text: "不提交", submit: "true", screenshot: false });
    expect(fx.calls.at(-1)).toBe("type 3"); // 只认严格的 true
  });

  it("非法 text：空 / 非字符串 / 超过 5000 字符 → BAD_ARGS，不输入", async () => {
    const fx = make();
    await shot(fx);
    for (const text of ["", 123, null, undefined, "a".repeat(MANAGER_LIMITS.maxTypeChars + 1)]) {
      expect(await codeOf(fx.op("desktop_type", { text })), String(text).slice(0, 10)).toBe("BAD_ARGS");
    }
    expect(fx.driver.typeText).not.toHaveBeenCalled();
    await fx.op("desktop_type", { text: "a".repeat(MANAGER_LIMITS.maxTypeChars), screenshot: false });
    expect(fx.driver.typeText.mock.calls.length + fx.clip.writes.length).toBeGreaterThan(0);
  });
});

describe("按键", () => {
  it("组合键解析后交给驱动；审计记规范化后的组合（快捷键照实记）和次数", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_key", { keys: "Cmd+Shift+V", screenshot: false });
    expect(fx.calls.at(-1)).toBe("key shift+meta+v");
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_key", ok: true, key: "shift+meta+v", count: 1 });
  });

  it("审计里会打出字符的键只记 [char]：模型一个键一个键打密码，逐条审计就是明文", async () => {
    const fx = make();
    await shot(fx);
    for (const ch of "P4ss") await fx.op("desktop_key", { keys: ch, screenshot: false });
    const keys = fx.actionAudits().filter((a) => a.op === "desktop_key").map((a) => a.key);
    expect(keys).toEqual(["[char]", "[char]", "[char]", "[char]"]);
    const dump = JSON.stringify(fx.audits);
    for (const secretPiece of ['"P"', '"4"', '"s"']) expect(dump).not.toContain(`"key":${secretPiece}`);
    // shift / alt 加字符、space / plus / minus 这些「命名的字符键」同理；驱动照常收到真实按键
    await fx.op("desktop_key", { keys: "shift+a", screenshot: false });
    await fx.op("desktop_key", { keys: "space", screenshot: false });
    await fx.op("desktop_key", { keys: "alt+2", screenshot: false });
    await fx.op("desktop_key", { keys: "spacebar", screenshot: false });
    expect(fx.actionAudits().filter((a) => a.op === "desktop_key").slice(-4).map((a) => a.key)).toEqual(["[char]", "[char]", "[char]", "[char]"]);
    expect(fx.calls.slice(-4)).toEqual(["key shift+a", "key space", "key alt+2", "key space"]);
  });

  it.each([
    // 会打出字符：只记 [char]
    [[], "a", "[char]"],
    [["shift"], "a", "[char]"],
    [[], "7", "[char]"],
    [["alt"], "2", "[char]"], // Option+2 = ™，仍是在打字
    [["ctrl", "alt"], "e", "[char]"], // AltGr（Windows 欧洲布局打 €、@ 用）
    [[], "space", "[char]"],
    [[], "plus", "[char]"],
    [[], "minus", "[char]"],
    [["shift"], "plus", "[char]"],
    // 快捷键 / 命名键：照实记
    [["meta"], "a", "meta+a"],
    [["ctrl"], "c", "ctrl+c"],
    [["meta", "shift"], "4", "meta+shift+4"],
    [["meta"], "space", "meta+space"], // Spotlight
    [["ctrl"], "space", "ctrl+space"],
    [[], "enter", "enter"],
    [[], "tab", "tab"],
    [[], "escape", "escape"],
    [[], "down", "down"],
    [["shift"], "left", "shift+left"],
    [[], "f5", "f5"],
    [["alt"], "f4", "alt+f4"],
  ])("auditKeyLabel：mods=%j key=%s → %s", (mods, key, expected) => {
    expect(auditKeyLabel({ mods, key })).toBe(expected);
  });

  it("审计里快捷键 / 命名键保留名字（审计要看的正是 AI 按了什么）：cmd+字母、ctrl+字母、enter、方向键、F 键", async () => {
    const fx = make();
    await shot(fx);
    for (const keys of ["cmd+w", "ctrl+c", "enter", "down", "f5", "cmd+plus", "tab"]) await fx.op("desktop_key", { keys, screenshot: false });
    expect(fx.actionAudits().filter((a) => a.op === "desktop_key").map((a) => a.key)).toEqual([
      "meta+w",
      "ctrl+c",
      "enter",
      "down",
      "f5",
      "meta+plus",
      "tab",
    ]);
  });

  it("按键参数写错时，报错里不回显传入的内容（审计 / 返回值 / 日志里都没有）", async () => {
    const fx = make();
    await shot(fx);
    const secret = "Hunter2Secret";
    const msg = await messageOf(fx.op("desktop_key", { keys: secret }));
    expect(msg).toMatch(/不认识的按键/);
    for (const sink of [msg, JSON.stringify(fx.audits), fx.logs.join("\n")]) expect(sink.toLowerCase()).not.toContain("hunter");
  });

  it("mod 跟平台走：mac = ⌘，Windows = Ctrl", async () => {
    const mac = make();
    await shot(mac);
    await mac.op("desktop_key", { keys: "mod+c", screenshot: false });
    expect(mac.calls.at(-1)).toBe("key meta+c");
    const win = make({ platform: "win32", unlockerSupported: false });
    await shot(win);
    await win.op("desktop_key", { keys: "mod+c", screenshot: false });
    expect(win.calls.at(-1)).toBe("key ctrl+c");
  });

  it("macOS 的 ⌘⇧Q（注销）被拦：BLOCKED，不按；Windows 没有这条规则", async () => {
    const mac = make();
    await shot(mac);
    expect(await codeOf(mac.op("desktop_key", { keys: "cmd+shift+q" }))).toBe("BLOCKED");
    expect(mac.driver.keyCombo).not.toHaveBeenCalled();
    expect(mac.actionAudits().at(-1)).toMatchObject({ op: "desktop_key", ok: false, code: "BLOCKED" });
    await mac.op("desktop_key", { keys: "cmd+q", screenshot: false }); // 退出应用照常允许
    expect(mac.calls.at(-1)).toBe("key meta+q");

    const win = make({ platform: "win32", unlockerSupported: false });
    await shot(win);
    await win.op("desktop_key", { keys: "cmd+shift+q", screenshot: false });
    expect(win.calls.at(-1)).toBe("key shift+meta+q");
  });

  it("repeat 夹在 1–20；不认识的键 / 缺 keys → BAD_ARGS", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_key", { keys: "backspace", repeat: 3, screenshot: false });
    expect(fx.calls.filter((c) => c === "key backspace")).toHaveLength(3);
    await fx.op("desktop_key", { keys: "down", repeat: 100, screenshot: false });
    expect(fx.calls.filter((c) => c === "key down")).toHaveLength(MANAGER_LIMITS.maxKeyRepeat);
    await fx.op("desktop_key", { keys: "tab", repeat: 0, screenshot: false });
    expect(fx.calls.filter((c) => c === "key tab")).toHaveLength(1);
    expect(await codeOf(fx.op("desktop_key", { keys: "hyper+z" }))).toBe("BAD_ARGS");
    expect(await codeOf(fx.op("desktop_key", {}))).toBe("BAD_ARGS");
  });
});

describe("apps / open_app", () => {
  it("apps：应用数、每个应用的窗口数、标题长度都有上限", async () => {
    const apps = Array.from({ length: 60 }, (_, i) => ({
      name: `App${i}`,
      pid: i,
      bundleId: `com.test.app${i}`,
      frontmost: i === 0,
      windows: Array.from({ length: 10 }, (_w, j) => ({ title: "T".repeat(300), x: j, y: j, width: 100, height: 100, secret: "不该透出去" })),
    }));
    const fx = make({ apps });
    const r = await fx.op("desktop_apps");
    const list = r.apps as Array<{ name: string; frontmost: boolean; windows: Array<{ title: string }> }>;
    expect(list).toHaveLength(MANAGER_LIMITS.maxApps);
    expect(list[0]).toMatchObject({ name: "App0", frontmost: true });
    expect(list[0]!.windows).toHaveLength(MANAGER_LIMITS.maxWindowsPerApp);
    expect(list[0]!.windows[0]!.title).toHaveLength(MANAGER_LIMITS.maxTitleChars);
    expect(JSON.stringify(r)).not.toContain("不该透出去");
  });

  it("apps：驱动返回怪东西也不炸", async () => {
    const fx = make({ apps: undefined });
    expect(await fx.op("desktop_apps")).toEqual({ ok: true, apps: [] });
  });

  it("open_app：交给驱动、等应用起来、带截图；空名字 → BAD_ARGS", async () => {
    const fx = make();
    const t0 = fx.world.clock;
    const r = await fx.op("desktop_open_app", { name: " 微信 " });
    expect(fx.calls).toContain("open 微信");
    expect(fx.world.clock - t0).toBeGreaterThanOrEqual(MANAGER_LIMITS.openAppWaitMs);
    expect(r.image).toBeDefined();
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_open_app", ok: true, app: "微信" });
    expect(await codeOf(fx.op("desktop_open_app", { name: "   " }))).toBe("BAD_ARGS");
    expect(await codeOf(fx.op("desktop_open_app", {}))).toBe("BAD_ARGS");
  });
});

describe("会话与自动解锁", () => {
  it("没锁屏：直接开始，不解锁、不盖遮罩", async () => {
    const fx = make();
    await shot(fx);
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.manager._session.status()).toMatchObject({ state: "active", taskId: "t1", unlockedByUs: false });
  });

  it("锁屏 + allowUnlock:true：解锁并盖遮罩，结果带 unlockedByUs:true；事件推给 server", async () => {
    const fx = make({ locked: true });
    const r = await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(r.unlockedByUs).toBe(true);
    expect(fx.overlay.show).toHaveBeenCalledTimes(1);
    expect(fx.world.locked).toBe(false);
    expect(fx.kinds()).toEqual(["unlocking", "unlocked"]);
    expect(fx.events.every((e) => e.name === "desktop_session" && e.taskId === "t1")).toBe(true);
  });

  it("锁屏 + allowUnlock 缺省 / 不是严格的 true：SCREEN_LOCKED，不解锁", async () => {
    const fx = make({ locked: true });
    for (const allowUnlock of [undefined, false, "yes", 1, "true"]) {
      expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock })), String(allowUnlock)).toBe("SCREEN_LOCKED");
    }
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.world.locked).toBe(true);
  });

  it("锁屏 + 「锁屏可用」没开：SCREEN_LOCKED", async () => {
    const fx = make({ locked: true, lockedAccess: false });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("Windows（解锁器不支持）+ 锁屏：UNSUPPORTED", async () => {
    const fx = make({ platform: "win32", locked: true, unlockerSupported: false });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNSUPPORTED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("end_session：解锁过的锁回去并撤遮罩；没有会话 → ended:false", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: true, unlockedByUs: true, relocked: true });
    expect(fx.world.locked).toBe(true);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.kinds()).toEqual(expect.arrayContaining(["relocked", "session_ended"]));
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: false });
  });

  it("没解锁过的会话 end_session：不锁屏（用户本来就在用）", async () => {
    const fx = make();
    await shot(fx);
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: true, unlockedByUs: false, relocked: false });
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
  });

  it("end_session：解锁过但没能锁回去（两种方式都失败）→ unlockedByUs:true + relocked:false（server 据此如实告诉用户），发 relock_failed，遮罩照撤；本机弹原生通知", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.unlocker.lock.mockImplementation(async () => ({ ok: false, error: "锁屏接口不可用" }));
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: true, unlockedByUs: true, relocked: false });
    expect(fx.kinds()).toContain("relock_failed");
    expect(fx.kinds()).not.toContain("relocked");
    expect(fx.overlay.hide).toHaveBeenCalled();
    // 默认方式 + 快捷键兜底各试了一次，参数一路传到了解锁器
    expect(fx.unlocker.lock.mock.calls.map((c) => (c as unknown[])[0])).toEqual([{ method: "auto" }, { method: "shortcut" }]);
    // server 通道断了也推不出去的场景：本机原生通知是电脑旁的人唯一能看到的提醒（只用固定文案，不带任何内容）
    expect(fx.localAlerts).toHaveLength(1);
    expect(fx.localAlerts[0]?.title).toContain("没能自动锁回去");
    expect(fx.localAlerts[0]?.body).toContain("⌃⌘Q");
    // 整条原样钉死：通知会出现在锁屏界面 / 通知中心，旁人看得见——不能带错误详情（"锁屏接口不可用" 是解锁器报的原因）或任何屏幕内容
    expect(fx.localAlerts[0]).toEqual({
      title: "Flowship：电脑没能自动锁回去",
      body: "AI 操作结束后没能把电脑锁屏，请尽快手动锁屏（⌃⌘Q）。",
    });
    expect(JSON.stringify(fx.localAlerts)).not.toContain("锁屏接口不可用");
  });

  it("锁回去成功 / 没解锁过：不弹本机通知", async () => {
    const ok = make({ locked: true });
    await ok.op("desktop_screenshot", { allowUnlock: true });
    await ok.op("desktop_end_session");
    expect(ok.localAlerts).toEqual([]);

    const plain = make();
    await shot(plain);
    await plain.op("desktop_end_session");
    expect(plain.localAlerts).toEqual([]);
  });

  it("Windows 的本机通知文案提示 Win + L（按平台给快捷键）", async () => {
    const win = make({ platform: "win32", locked: true }); // 假解锁器声明支持：只为验证文案按平台走
    await win.op("desktop_screenshot", { allowUnlock: true });
    win.unlocker.lock.mockImplementation(async () => ({ ok: false, error: "x" }));
    await win.op("desktop_end_session");
    expect(win.localAlerts[0]?.body).toContain("Win + L");
    expect(win.localAlerts[0]?.body).not.toContain("⌃⌘Q");
    expect(win.localAlerts[0]).toEqual({
      title: "Flowship：电脑没能自动锁回去",
      body: "AI 操作结束后没能把电脑锁屏，请尽快手动锁屏（Win + L）。",
    });
  });

  it("本机通知抛错：不影响会话收尾（只记日志）", async () => {
    const fx = make({ locked: true, localNotifyThrows: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.unlocker.lock.mockImplementation(async () => ({ ok: false, error: "x" }));
    expect(await fx.op("desktop_end_session")).toMatchObject({ ended: true, relocked: false });
    expect(fx.logs.join("\n")).toContain("本机通知失败");
    expect(fx.manager._session.status().state).toBe("idle");
  });

  it("另一个任务占着会话：DENIED；占用者 end_session 之后才轮到别人；别人 end_session 动不了它", async () => {
    const fx = make();
    await shot(fx, "t1");
    expect(await codeOf(fx.op("desktop_screenshot", {}, { taskId: "t2" }))).toBe("DENIED");
    expect(await fx.op("desktop_end_session", {}, { taskId: "t2" })).toEqual({ ok: true, ended: false });
    expect(fx.manager._session.status()).toMatchObject({ state: "active", taskId: "t1" });
    await fx.op("desktop_end_session", {}, { taskId: "t1" });
    expect((await shot(fx, "t2")).ok).toBe(true);
  });

  it("任务被停止（onCancel）：会话结束、解锁过的锁回去", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.manager.onCancel("t1");
    await flush();
    expect(fx.world.locked).toBe(true);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.manager._session.status().state).toBe("idle");
    fx.manager.onCancel("别的任务"); // 不是持有者：什么都不发生
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
  });

  it("任务被删 / 归档（onTaskClosed）：该任务名下的会话结束、解锁过的锁回去；别的任务不受影响；没有会话时什么都不发生", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.manager.onTaskClosed("别的任务"); // 不是持有者：什么都不发生
    await flush();
    expect(fx.manager._session.status()).toMatchObject({ state: "active", taskId: "t1" });
    expect(fx.unlocker.lock).not.toHaveBeenCalled();

    fx.manager.onTaskClosed("t1");
    await flush();
    expect(fx.manager._session.status().state).toBe("idle");
    expect(fx.world.locked).toBe(true);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.kinds()).toEqual(expect.arrayContaining(["relocked", "session_ended"]));

    expect(() => fx.manager.onTaskClosed("t1")).not.toThrow(); // 已经没有会话：幂等
    expect(fx.unlocker.lock).toHaveBeenCalledTimes(1);
  });

  it("onTaskClosed 只认持有者：就算传来设置页测试用的专用任务 id，也不会动别的任务的会话", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.manager.onTaskClosed(SETTINGS_TEST_TASK);
    await flush();
    expect(fx.manager._session.status()).toMatchObject({ state: "active", taskId: "t1" });
  });

  it("总开关被关（onConfig）：会话结束并锁回去，之后的请求 ACCESS_DISABLED；只推 enabled 之外的字段不影响", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.manager.onConfig({ desktopLockedAccess: false }); // 不带 enabled：不动总开关
    expect(fx.manager._session.status().state).toBe("active");
    fx.manager.onConfig({ desktopEnabled: false });
    await flush();
    expect(fx.manager._session.status().state).toBe("idle");
    expect(fx.world.locked).toBe(true);
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("ACCESS_DISABLED");
  });

  it("server 断开（onServerGone）：fail-closed——会话结束，开关清零，之后一切请求被拒", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.manager.onServerGone();
    await flush();
    expect(fx.world.locked).toBe(true);
    expect((await fx.manager.getStatus()).enabled).toBe(false);
    expect((await fx.manager.getStatus()).lockedAccessEnabled).toBe(false);
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("ACCESS_DISABLED");
  });

  it("会话事件：推给 server 时带任务 id；推送抛错不影响操作；没接 sink 也不炸", async () => {
    const boom = make({ locked: true, sinkThrows: true });
    expect((await boom.op("desktop_screenshot", { allowUnlock: true })).ok).toBe(true);
    expect(boom.logs.join("\n")).toContain("推送会话事件失败");

    const silent = make({ locked: true, noSink: true });
    expect((await silent.op("desktop_screenshot", { allowUnlock: true })).ok).toBe(true);
  });

  it("应用退出（destroy）：我们解锁的电脑发出锁屏命令、撤遮罩；之后不再推事件", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const eventsBefore = fx.events.length;
    fx.manager.destroy();
    expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.events.length).toBe(eventsBefore);
  });
});

describe("审计", () => {
  it("成功：记输入坐标、按钮、次数、耗时；失败：记错误码", async () => {
    const fx = make();
    await shot(fx);
    await fx.op("desktop_click", { x: 100, y: 50, count: 2, screenshot: false });
    expect(await codeOf(fx.op("desktop_click", { x: 9999, y: 1 }))).toBe("BAD_ARGS");
    const [, ok, fail] = fx.actionAudits();
    expect(ok).toMatchObject({ type: "action", op: "desktop_click", taskId: "t1", ok: true, x: 200, y: 100, button: "left", count: 2 });
    expect(typeof ok!.ms).toBe("number");
    expect(fail).toMatchObject({ op: "desktop_click", ok: false, code: "BAD_ARGS" });
    expect(Object.keys(ok!)).not.toContain("_audit");
  });

  it("非 DesktopError 的异常记成 INTERNAL 并照常抛出", async () => {
    const fx = make({ keyComboThrows: () => true });
    await shot(fx);
    await expect(fx.op("desktop_key", { keys: "enter" })).rejects.toThrow("按键注入失败");
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_key", ok: false, code: "INTERNAL" });
  });
});

describe("设置页状态", () => {
  it("形状：权限 / 锁屏 / 凭据 / 会话；会话里有我们解锁的标记", async () => {
    const fx = make({ locked: true });
    expect(await fx.manager.getStatus()).toEqual({
      platform: "darwin",
      enabled: true,
      lockedAccessEnabled: true,
      supported: true,
      lockedAccessSupported: true,
      // 两条锁屏路线分开说：macOS 没有后台档，只有解锁
      backgroundSupported: false,
      backgroundReady: false,
      unlockSupported: true,
      unlockReady: true,
      driverReady: true,
      permissions: { accessibility: "granted", screen: "granted" },
      locked: true,
      credentialSet: true,
      lockedAccessReady: true,
      session: { active: false, unlockedByUs: false },
    });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const st = await fx.manager.getStatus();
    expect(st.session).toMatchObject({ active: true, unlockedByUs: true, mode: "foreground" });
    expect(typeof st.session.startedAt).toBe("number");
    expect(st.locked).toBe(false);
  });

  it("「锁屏可用」就绪判定：开关 / 凭据 / 权限 / 组件 / 平台，一次只报最靠前的原因", async () => {
    const off = await make({ lockedAccess: false }).manager.getStatus();
    expect(off).toMatchObject({ lockedAccessReady: false });
    expect(off.lockedAccessNote).toBeUndefined();

    const noCred = await make({ credential: false }).manager.getStatus();
    expect(noCred).toMatchObject({ lockedAccessReady: false, credentialSet: false, lockedAccessNote: "还没有保存开机密码" });

    const noPerm = await make({ screen: "denied" }).manager.getStatus();
    expect(noPerm).toMatchObject({ lockedAccessReady: false });
    expect(noPerm.lockedAccessNote).toContain("系统权限");

    const noDriver = await make({ initOk: false }).manager.getStatus();
    expect(noDriver).toMatchObject({ lockedAccessReady: false, driverReady: false });
    expect(noDriver.lockedAccessNote).toContain("koffi");
    expect(noDriver.driverError).toContain("koffi");

    const noUnlocker = await make({ noUnlocker: true }).manager.getStatus();
    expect(noUnlocker).toMatchObject({ lockedAccessSupported: false, lockedAccessReady: false });

    const win = await make({ platform: "win32", unlockerSupported: false }).manager.getStatus();
    expect(win).toMatchObject({ platform: "win32", supported: true, lockedAccessSupported: false, lockedAccessReady: false });
    expect(win.lockedAccessNote).toContain("Windows");
    expect(win.permissions).toEqual({ accessibility: "granted", screen: "granted" });
  });

  it("读凭据状态抛错：当作没存，不影响整份状态", async () => {
    const st = await make({ hasCredentialThrows: true }).manager.getStatus();
    expect(st.credentialSet).toBe(false);
    expect(st.driverReady).toBe(true);
  });

  // 第六轮评审 P2-1：Windows 装着旧版解锁组件（设置页提示「点安装升级」）时，hasCredential（要求组件版本够新）恒为 false，
  // 设置页因此看不到「已保存」、也清不掉开机密码。credentialSet 改成回答「存着没」（解锁器给了 hasStoredCredential 就以它为准），不看组件版本
  it("credentialSet 回答「存着没」而不是「能不能用来解锁」：解锁器给了 hasStoredCredential 就以它为准，不看解锁组件版本", async () => {
    // 装着旧版组件：能用来解锁的（hasCredential）为 false，但组件里确实存着一份——设置页必须看得到
    const stale = make({ platform: "win32", helper: { installed: false, canInstall: true }, credential: false, storedCredential: true });
    const st = await stale.manager.getStatus();
    expect(st).toMatchObject({ credentialSet: true, unlockReady: false, lockedAccessReady: false, lockedAccessNote: "还没有安装解锁组件" });
    expect(stale.unlocker.hasStoredCredential).toHaveBeenCalled();
    // 以它为准，反方向也一样：hasCredential 说有、hasStoredCredential 说没有 → 没有
    const gone = await make({ platform: "win32", helper: { installed: true, canInstall: true }, credential: true, storedCredential: false }).manager.getStatus();
    expect(gone.credentialSet).toBe(false);
    // 它抛错：当作没存，不影响整份状态
    const boom = await make({ platform: "win32", helper: { installed: true, canInstall: true }, storedCredential: "throws" }).manager.getStatus();
    expect(boom).toMatchObject({ credentialSet: false, driverReady: true });
    // 解锁器没有 hasStoredCredential（macOS 钥匙串）：照旧取 hasCredential
    expect((await make({ credential: true }).manager.getStatus()).credentialSet).toBe(true);
    expect((await make({ credential: false }).manager.getStatus()).credentialSet).toBe(false);
  });

  // 第三轮评审：界面（computer-use-card）对状态快照做运行时校验、格式不对的一律丢弃——所以主进程产出的每一种快照都必须过得了这一关，
  // 否则界面会把真实快照当成「格式不对」丢掉、永远读不到状态。用真的 manager 在各种条件组合下产出快照来对账（校验函数在界面那边、不在这里复制一份）
  it("manager 产出的快照在各种条件组合下都满足界面的运行时校验 isComputerUseStatus", async () => {
    const variants: Array<[string, Opts]> = [
      ["macOS 基线", {}],
      ["macOS 锁屏中", { locked: true }],
      ["macOS 总开关关", { enabled: false }],
      ["macOS 锁屏开关关", { lockedAccess: false }],
      ["macOS 没存密码", { credential: false }],
      ["macOS 没授权", { screen: "denied", accessibility: "not-determined" }],
      ["macOS 驱动没起来", { initOk: false }],
      ["macOS 驱动 init 抛错", { initThrows: true }],
      ["macOS 没有解锁器", { noUnlocker: true }],
      ["macOS 读凭据抛错", { hasCredentialThrows: true }],
      ["Windows 基线", { platform: "win32" }],
      ["Windows 解锁不支持", { platform: "win32", unlockerSupported: false }],
      ["Windows 安全桌面", { platform: "win32", secure: true }],
      ["Windows 后台档就绪", { platform: "win32", background: true }],
      ["Windows 后台档没初始化成功", { platform: "win32", background: { initOk: false } }],
      ["Windows 解锁组件已装", { platform: "win32", helper: { installed: true, canInstall: true } }],
      ["Windows 解锁组件状态读不出", { platform: "win32", helper: { statusThrows: true } }],
    ];
    for (const [name, opts] of variants) {
      const st = await make(opts).manager.getStatus();
      expect(isComputerUseStatus(st), name).toBe(true);
    }
    // 会话进行中（我们解锁的那种）
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(isComputerUseStatus(await fx.manager.getStatus()), "会话进行中").toBe(true);
  });

  it("secureDesktop：只有屏幕上真的是 UAC 之类的安全桌面时才带 true；平时 / 驱动没这个方法 / 读不到 / 抛错 / 驱动没就绪，状态里都没有这个字段", async () => {
    const on = make({ platform: "win32", secure: true });
    expect(await on.manager.getStatus()).toMatchObject({ secureDesktop: true });
    on.world.secure = false;
    expect(await on.manager.getStatus()).not.toHaveProperty("secureDesktop");

    expect(await make({ platform: "win32", secure: false }).manager.getStatus()).not.toHaveProperty("secureDesktop");
    expect(await make().manager.getStatus()).not.toHaveProperty("secureDesktop"); // 没有这个方法（macOS 的样子）

    const throwing = make({ platform: "win32", secure: true });
    throwing.world.secureThrows = true;
    const st = await throwing.manager.getStatus(); // 抛错不能拖垮整份状态
    expect(st).not.toHaveProperty("secureDesktop");
    expect(st).toMatchObject({ driverReady: true, platform: "win32" });

    // 驱动没就绪：根本不去问
    const broken = make({ platform: "win32", secure: true, initOk: false });
    expect(await broken.manager.getStatus()).not.toHaveProperty("secureDesktop");
    expect(broken.driver.isSecureDesktopActive).not.toHaveBeenCalled();

    // 只认严格的 true
    const sloppy = make({ platform: "win32", secure: false });
    sloppy.driver.isSecureDesktopActive!.mockReturnValue("yes" as never);
    expect(await sloppy.manager.getStatus()).not.toHaveProperty("secureDesktop");
  });

  it("requestPermission：先触发系统提示，再打开对应设置页，返回最新状态；打不开设置页也不抛；不认识的类型 → BAD_ARGS", async () => {
    const fx = make({ accessibility: "denied" });
    const a = await fx.manager.requestPermission("accessibility");
    expect(fx.perms.requestAccessibility).toHaveBeenCalledTimes(1);
    expect(fx.perms.openSettings).toHaveBeenLastCalledWith("accessibility");
    expect(a.permissions.accessibility).toBe("denied");

    await fx.manager.requestPermission("screen");
    expect(fx.perms.requestScreen).toHaveBeenCalledTimes(1);
    expect(fx.perms.openSettings).toHaveBeenLastCalledWith("screen");

    const broken = make({ openSettingsThrows: true });
    await expect(broken.manager.requestPermission("screen")).resolves.toMatchObject({ platform: "darwin" });
    expect(broken.logs.join("\n")).toContain("打开系统设置失败");

    await expect(fx.manager.requestPermission("camera" as never)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fx.perms.requestAccessibility).toHaveBeenCalledTimes(1);
  });

  it("openSettings：只认 accessibility / screen", async () => {
    const fx = make();
    await fx.manager.openSettings("screen");
    expect(fx.perms.openSettings).toHaveBeenCalledWith("screen");
    await expect(fx.manager.openSettings("x" as never)).rejects.toMatchObject({ code: "BAD_ARGS" });
  });
});

// UAC 权限确认 / Ctrl+Alt+Del 和锁屏一样在 Winlogon 安全桌面上，驱动用会话锁定标志把两者分开（只有 Windows 驱动有 isSecureDesktopActive）。
// 把它当锁屏的后果：解锁器往里输开机密码再回车，而 UAC 里回车默认落在「是」。所以这里钉死：开始 / 动作一律拒、不解锁、不锁屏、不进冷却。
describe("系统安全桌面（UAC 等）", () => {
  it("desktop_status（AI 看的）：屏幕上是安全桌面时带 secureDesktop:true；平时没有这个字段", async () => {
    const fx = make({ platform: "win32", secure: true });
    expect(await fx.op("desktop_status")).toMatchObject({ ok: true, secureDesktop: true, locked: false });
    fx.world.secure = false;
    expect(await fx.op("desktop_status")).not.toHaveProperty("secureDesktop");
    expect(await make().op("desktop_status")).not.toHaveProperty("secureDesktop");
  });

  it("屏幕上是安全桌面：截图 / 列应用 / 按键这类 op 一律 SECURE_DESKTOP——不解锁、不盖遮罩、不输入；错误文字讲清楚是 UAC、别重试", async () => {
    const fx = make({ platform: "win32", secure: true, locked: true });
    const message = await messageOf(fx.op("desktop_screenshot", { allowUnlock: true }));
    expect(message).toMatch(/UAC/);
    expect(message).toMatch(/不要重试/);
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
    expect(await codeOf(fx.op("desktop_apps", { allowUnlock: true }))).toBe("SECURE_DESKTOP");
    expect(await codeOf(fx.op("desktop_key", { keys: "enter", allowUnlock: true }))).toBe("SECURE_DESKTOP");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.calls.filter((c) => /^(click|type|key|move|drag|scroll|unlock|lock)/.test(c))).toEqual([]);
    expect(fx.manager._session.status().state).toBe("idle");
  });

  it("点击之后的自动截图撞上 UAC（点「安装」弹出了权限确认）：不能被吞成 screenshotError，必须 SECURE_DESKTOP；会话结束、不锁屏、事件推给 server", async () => {
    const fx = make({ platform: "win32", secure: false });
    await shot(fx);
    fx.driver.click.mockImplementationOnce(async () => {
      fx.calls.push("click 20,20 leftx1");
      fx.world.secure = true; // 这一下点击弹出了 UAC
    });
    fx.events.length = 0;
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10 }))).toBe("SECURE_DESKTOP");
    expect(fx.calls).toContain("click 20,20 leftx1"); // 点击确实执行了：AI 要知道这一步已经做了
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(fx.manager._session.status().state).toBe("idle");
    expect(fx.events.find((e) => e.data.kind === "session_ended")?.data).toMatchObject({ reason: "secure_desktop", relocked: false });
  });

  it("弹窗处理掉之后：重新截一张图就能继续（SECURE_DESKTOP 不进冷却）", async () => {
    const fx = make({ platform: "win32", secure: true });
    expect(await codeOf(fx.op("desktop_screenshot"))).toBe("SECURE_DESKTOP");
    fx.world.secure = false;
    expect((await shot(fx)).ok).toBe(true);
    expect((await fx.op("desktop_click", { x: 10, y: 10, screenshot: false })).ok).toBe(true);
  });
});

describe("开机密码", () => {
  it("保存：交给解锁器；审计只记「保存了」，状态 / 日志 / 事件里没有密码", async () => {
    const fx = make({ credential: false });
    expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: true });
    expect(fx.unlocker.setCredential).toHaveBeenCalledWith({ password: SECRET });
    expect((await fx.manager.getStatus()).credentialSet).toBe(true);
    expect(fx.audits).toEqual([{ type: "session", kind: "credential_set" }]);
    for (const sink of [JSON.stringify(fx.audits), fx.logs.join("\n"), JSON.stringify(await fx.manager.getStatus()), JSON.stringify(fx.events)]) {
      expect(sink).not.toContain(SECRET);
    }
  });

  it("保存失败：原样返回原因，不回显密码", async () => {
    const fx = make({ credential: false, setCredentialResult: { ok: false, error: "钥匙串写入失败" } });
    const r = await fx.manager.setCredential({ password: SECRET });
    expect(r).toEqual({ ok: false, error: "钥匙串写入失败" });
    expect(r).not.toHaveProperty("saved"); // 没存上就是没存上：不带 saved
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(fx.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
  });

  // 第四轮评审 A2：Windows 解锁组件「密码已存好、冷却记录没清掉」——设置页要能分清它和「根本没存上」，审计也不能把它记成保存失败
  describe("密码已存好但冷却没清掉（解锁器回 saved:true）", () => {
    const COOLDOWN_NOTE = "开机密码已经保存好了，但上一次自动解锁失败留下的冷却记录没能清掉：冷却结束之前仍不会自动解锁";

    /** 先让一次自动解锁输错（进冷却），之后的解锁都成功：用来观察「保存」有没有解除会话层的冷却 */
    const makeCooling = () => {
      let n = 0;
      return make({
        locked: true,
        unlock: async (w) => {
          n += 1;
          if (n === 1) return { ok: false, error: "密码不对" };
          w.locked = false;
          return { ok: true };
        },
      });
    };

    it("返回值透传 { ok:false, saved:true, error }；审计记 credential_set_cooldown_kept（不是 credential_set_failed），只有 type / kind", async () => {
      const fx = make({ platform: "win32", credential: false, setCredentialResult: { ok: false, saved: true, error: COOLDOWN_NOTE } });
      const r = await fx.manager.setCredential({ password: SECRET });
      expect(r).toEqual({ ok: false, saved: true, error: COOLDOWN_NOTE });
      expect(fx.audits).toEqual([{ type: "session", kind: "credential_set_cooldown_kept" }]);
      expect(fx.audits.some((a) => a.kind === "credential_set_failed" || a.kind === "credential_set")).toBe(false);
      for (const sink of [JSON.stringify(r), JSON.stringify(fx.audits), fx.logs.join("\n"), JSON.stringify(fx.events)]) {
        expect(sink).not.toContain(SECRET);
      }
    });

    it("error 仍先抹掉回显的密码再透传；解锁器抛异常的失败（没存上）不带 saved", async () => {
      const echoed = make({ credential: false, setCredentialResult: { ok: false, saved: true, error: `冷却没清掉：${SECRET}` } });
      const r = await echoed.manager.setCredential({ password: SECRET });
      // 不直接读 r.error：setCredential 的返回类型是联合（有的分支没有 error），tsc 会报 TS2339
      expect(r).toMatchObject({ ok: false, saved: true, error: expect.stringContaining("冷却没清掉") });
      expect(JSON.stringify(r)).not.toContain(SECRET);

      const thrown = make({ credential: false });
      thrown.unlocker.setCredential.mockImplementationOnce(async () => {
        throw new Error(`写入失败：${SECRET}`);
      });
      const t = await thrown.manager.setCredential({ password: SECRET });
      expect(t.ok).toBe(false);
      expect(t).not.toHaveProperty("saved");
      expect(thrown.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
    });

    it("不放行会话层的冷却：saved 只说明「密码存上了」，冷却还在——下一次请求照样被冷却挡着，不会多输一次密码；真正保存成功（ok:true）才解除", async () => {
      const fx = makeCooling();
      expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);

      fx.unlocker.setCredential.mockImplementationOnce(async () => ({ ok: false, saved: true, error: COOLDOWN_NOTE }));
      expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: false, saved: true, error: COOLDOWN_NOTE });
      const still = await fx.manager.getStatus();
      expect(still.lockedAccessReady).toBe(false);
      expect(still.lockedAccessNote).toContain("暂停自动解锁");
      expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      expect(fx.unlocker.unlock, "冷却没解除：没有第二次输密码").toHaveBeenCalledTimes(1);

      expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: true });
      expect((await fx.op("desktop_screenshot", { allowUnlock: true })).ok).toBe(true);
      expect(fx.unlocker.unlock).toHaveBeenCalledTimes(2);
    });

    it("ok 优先于 saved：解锁器回 { ok:true, saved:true }（不规范）按成功处理——返回 { ok:true }（不带 saved）、记 credential_set、冷却照常解除", async () => {
      const fx = makeCooling();
      expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
      fx.unlocker.setCredential.mockImplementationOnce(async () => ({ ok: true, saved: true }));
      expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: true });
      expect(fx.audits.filter((a) => String(a.kind).startsWith("credential_set"))).toEqual([{ type: "session", kind: "credential_set" }]);
      expect((await fx.op("desktop_screenshot", { allowUnlock: true })).ok).toBe(true);
    });

    it.each([
      ['字符串 "1"', "1"],
      ["数字 1", 1],
      ['字符串 "true"', "true"],
    ])("saved 只认布尔 true（%s 不算）：按普通失败处理，返回值不带 saved", async (_name, saved) => {
      const fx = make({ credential: false, setCredentialResult: { ok: false, saved: saved as never, error: "写入失败" } });
      const r = await fx.manager.setCredential({ password: SECRET });
      expect(r).toEqual({ ok: false, error: "写入失败" });
      expect(r).not.toHaveProperty("saved");
      expect(fx.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
    });
  });

  it("空密码 / 非字符串 / 解锁器不支持：不调用解锁器", async () => {
    const fx = make();
    for (const input of [{ password: "" }, { password: 123 }, {}, null, "pwd"]) {
      expect(await fx.manager.setCredential(input as never), JSON.stringify(input)).toMatchObject({ ok: false });
    }
    const win = make({ platform: "win32", unlockerSupported: false });
    expect(await win.manager.setCredential({ password: SECRET })).toMatchObject({ ok: false, error: expect.stringContaining("暂不支持") });
    const none = make({ noUnlocker: true });
    expect(await none.manager.setCredential({ password: SECRET })).toMatchObject({ ok: false });
    expect(fx.unlocker.setCredential).not.toHaveBeenCalled();
    expect(win.unlocker.setCredential).not.toHaveBeenCalled();
  });

  it("清除：交给解锁器并记审计（真删掉了才记 credential_cleared）；没有解锁器也不炸", async () => {
    const fx = make();
    await expect(fx.manager.clearCredential()).resolves.toEqual({ ok: true });
    expect(fx.unlocker.clearCredential).toHaveBeenCalledTimes(1);
    expect((await fx.manager.getStatus()).credentialSet).toBe(false);
    expect(fx.audits).toEqual([{ type: "session", kind: "credential_cleared" }]);
    await expect(make({ noUnlocker: true }).manager.clearCredential()).resolves.toEqual({ ok: true });
  });

  it("清除失败：如实返回 ok:false 和原因，审计记 credential_clear_failed，绝不假装已经清掉", async () => {
    const fx = make();
    fx.unlocker.clearCredential.mockImplementationOnce(async () => ({ ok: false, error: "没能从钥匙串删除开机密码" }));
    await expect(fx.manager.clearCredential()).resolves.toEqual({ ok: false, error: "没能从钥匙串删除开机密码" });
    expect(fx.audits).toEqual([{ type: "session", kind: "credential_clear_failed" }]);
    expect(fx.audits.some((a) => a.kind === "credential_cleared")).toBe(false);
    expect((await fx.manager.getStatus()).credentialSet).toBe(true); // 密码确实还在
  });

  it("清除时解锁器抛异常：同样折成 ok:false（不抛给设置页）", async () => {
    const fx = make();
    fx.unlocker.clearCredential.mockImplementationOnce(async () => {
      throw new Error("钥匙串炸了");
    });
    const r = await fx.manager.clearCredential();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("钥匙串炸了");
    expect(fx.audits).toEqual([{ type: "session", kind: "credential_clear_failed" }]);
  });

  it("旧版解锁器返回 undefined（没有 ok 字段）：不能当成功——宁可多提示一次，也不假装清掉了", async () => {
    const fx = make();
    fx.unlocker.clearCredential.mockImplementationOnce((async () => undefined) as never);
    const r = await fx.manager.clearCredential();
    expect(r.ok).toBe(false);
    expect(fx.audits.some((a) => a.kind === "credential_cleared")).toBe(false);
  });

  it("重新保存开机密码会解除自动解锁的冷却；保存失败不解除", async () => {
    let n = 0;
    const fx = make({
      locked: true,
      unlock: async (w) => {
        n += 1;
        if (n === 1) return { ok: false, error: "密码不对" };
        w.locked = false;
        return { ok: true };
      },
    });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED"); // 冷却中
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    // 状态里能看到冷却，AI 的 desktop_status 也不会再说「锁屏可用已就绪」
    const cooling = await fx.manager.getStatus();
    expect(cooling.lockedAccessReady).toBe(false);
    expect(cooling.lockedAccessNote).toContain("暂停自动解锁");

    fx.unlocker.setCredential.mockImplementationOnce(async () => ({ ok: false, error: "钥匙串写入失败" }));
    expect(await fx.manager.setCredential({ password: SECRET })).toMatchObject({ ok: false });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED"); // 保存失败：冷却还在

    expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: true });
    expect((await fx.manager.getStatus()).lockedAccessReady).toBe(true);
    expect((await fx.op("desktop_screenshot", { allowUnlock: true })).ok).toBe(true);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(2);
  });
});

// 第二轮评审：「不含密码」的断言在假解锁器（固定文案）上恒真，测不出泄漏。这一组用真的 macOS 解锁器 + 把入参回显进异常的
// 毒化驱动 / 钥匙串，从头到尾走完 manager → session → 事件 / 审计 / 日志 / 本机通知 / 返回值，断言整串密码哪儿都没有；
// 每条都先断言「密码确实进了驱动 / 钥匙串」（毒化真的发生过），再断言它没出来。
describe("开机密码不外泄：驱动 / 钥匙串的异常回显了密码（真的 macOS 解锁器）", () => {
  const echo = (what: string) => (s: string) => new Error(`${what}：${s}（共 ${s.length} 个字符）`);

  /**
   * 所有可能带密码出门的地方：事件、审计、日志、本机通知、设置页状态、**导出的诊断文件**，加上调用方额外要查的返回值 / 错误。
   * 诊断文件是用户会发给别人排查问题的东西，却曾经不在这张清单里（第三轮评审）：这里真导出一份，把写出去的路径和内容一并查。
   */
  const everywhere = async (fx: ReturnType<typeof make>, ...extra: unknown[]) => {
    await fx.manager.exportDiagnostics().catch(() => undefined);
    return JSON.stringify([
      fx.events,
      fx.audits,
      fx.logs,
      fx.localAlerts,
      await fx.manager.getStatus(),
      fx.fsImpl.writeFile.mock.calls,
      ...extra,
    ]);
  };

  it("出口清单自检：诊断文件也是出口——往驱动诊断里塞一次密码，everywhere 能抓出来（清单失灵的话，下面所有「没有密码」的断言都是空的）", async () => {
    const fx = make();
    expect(await everywhere(fx)).not.toContain(SECRET);
    fx.driver.diagnostics.mockReturnValue({ planted: SECRET } as never);
    expect(await everywhere(fx)).toContain(SECRET);
    // 状态里塞一次同理（原有出口没被我改丢）
    const fx2 = make();
    fx2.logs.push(`log ${SECRET}`);
    expect(await everywhere(fx2)).toContain(SECRET);
  });

  it("AI 请求截图触发自动解锁，键码输入抛了回显密码的异常：抛给 AI 的错误 / 解锁失败事件 / 审计 / 日志 / 本机通知里都没有密码", async () => {
    const fx = make({ locked: true, realDarwin: { typeError: echo("无法输入") } });
    let err: unknown;
    try {
      await fx.op("desktop_screenshot", { allowUnlock: true });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "UNLOCK_FAILED" });
    expect(fx.typed).toEqual([SECRET]); // 对照组：密码确实进了驱动（毒化的来源），驱动抛的异常里确实有它
    const message = (err as Error).message;
    expect(message).toContain(`无法输入：•••（共 ${SECRET.length} 个字符）`); // 原因其余部分保留，密码抹成 •••
    expect(message).not.toContain(SECRET);
    const failed = fx.events.find((e) => e.data.kind === "unlock_failed");
    expect(failed?.data.error).toContain("无法输入：•••");
    expect(await everywhere(fx, message)).not.toContain(SECRET);
    expect(fx.calls).not.toContain("key enter"); // 输入失败不按回车
  });

  it("设置页「测试锁屏可用」：解锁时键码输入抛了回显密码的异常 → 返回的 error / 逐步结果 / 事件 / 审计 / 日志里没有密码", async () => {
    const fx = make({ realDarwin: { typeError: echo("无法输入") } });
    const r = await fx.manager.testLockedAccess();
    expect(r.ok).toBe(false);
    expect(fx.typed).toEqual([SECRET]);
    expect(r.error).toContain("无法输入：•••");
    expect(r.steps.at(-1)).toMatchObject({ name: "unlock", ok: false });
    expect(await everywhere(fx, r)).not.toContain(SECRET);
  });

  it("设置页「测试锁屏可用」的预检（保存的密码打得出吗）抛了回显密码的异常：返回的 error 里没有密码，没有锁屏", async () => {
    const fx = make({ realDarwin: { canTypeError: echo("预检失败") } });
    const r = await fx.manager.testLockedAccess();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("预检失败：•••");
    expect(r.error).toContain("这次没有锁屏");
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(await everywhere(fx, r)).not.toContain(SECRET);
  });

  it("设置页保存开机密码：预检 / 钥匙串抛了回显密码的异常 → 返回 ok:false（不抛），文字里没有密码；审计只记 credential_set_failed", async () => {
    const pre = make({ credential: false, realDarwin: { canTypeError: echo("预检失败") } });
    const r1 = await pre.manager.setCredential({ password: SECRET });
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining("预检失败：•••") });
    expect(pre.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
    expect(await everywhere(pre, r1)).not.toContain(SECRET);

    const store = make({ credential: false, realDarwin: { keychainSetError: echo("钥匙串写入失败") } });
    const r2 = await store.manager.setCredential({ password: SECRET });
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining("钥匙串写入失败：•••") });
    expect(store.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
    expect(await everywhere(store, r2)).not.toContain(SECRET);
  });

  it("manager 自己也兜底（不管换成哪个平台的解锁器）：解锁器 setCredential 抛了回显密码的异常 / 返回的错误文字带密码 → 抹掉，异常不抛给设置页", async () => {
    const thrown = make({ credential: false });
    thrown.unlocker.setCredential.mockImplementationOnce(async (s: { password: string }) => {
      throw new Error(`原生层报错：${s.password}`);
    });
    const r1 = await thrown.manager.setCredential({ password: SECRET });
    expect(r1).toEqual({ ok: false, error: "保存开机密码时出错：原生层报错：•••" });
    expect(thrown.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
    expect(await everywhere(thrown, r1)).not.toContain(SECRET);

    const returned = make({ credential: false, setCredentialResult: { ok: false, error: `写入被拒：${SECRET}` } });
    const r2 = await returned.manager.setCredential({ password: SECRET });
    expect(r2).toEqual({ ok: false, error: "写入被拒：•••" });
    expect(await everywhere(returned, r2)).not.toContain(SECRET);
  });

  it("解锁器返回不规范的结果（旧版返回 undefined）：保存不当成功——返回 ok:false，审计记 credential_set_failed（不是抛 TypeError）", async () => {
    const fx = make({ credential: false });
    fx.unlocker.setCredential.mockImplementationOnce((async () => undefined) as never);
    expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: false, error: "保存失败" });
    expect(fx.audits).toEqual([{ type: "session", kind: "credential_set_failed" }]);
  });
});

describe("测试锁屏可用", () => {
  const stepNames = (r: { steps: Array<{ name: string }> }) => r.steps.map((s) => s.name);

  it("成功：倒计时 → 锁屏 → 走完整解锁流程 → 停在桌面（不再锁回去）；事件不推给 server", async () => {
    const fx = make();
    const r = await fx.manager.testLockedAccess();
    expect(r.ok).toBe(true);
    expect(stepNames(r)).toEqual(["countdown", "lock", "unlock.check", "unlock.type", "unlock"]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(r.steps[0]).toMatchObject({ name: "countdown", ms: MANAGER_LIMITS.testCountdownMs });
    // 倒计时 + 等锁屏界面稳定（键鼠空闲要超过「用户在场」阈值）都真的等过
    expect(fx.world.clock - fx.startClock).toBeGreaterThanOrEqual(MANAGER_LIMITS.testCountdownMs + MANAGER_LIMITS.testLockSettleMs);
    // 解锁步骤只留 name / ok / ms，驱动给的 detail 不透出
    expect(JSON.stringify(r)).not.toContain(DETAIL_MARK);
    expect(fx.world.locked).toBe(false); // 停在桌面
    expect(fx.unlocker.lock).not.toHaveBeenCalled(); // 没有锁回去
    expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1); // 只有测试自己的那一次锁屏
    expect(fx.overlay.show).toHaveBeenCalledTimes(1);
    expect(fx.overlay.hide).toHaveBeenCalled();
    expect(fx.manager._session.status().state).toBe("idle");
    expect(fx.sink).not.toHaveBeenCalled(); // __settings_test__ 的事件不外发
    expect(fx.audits.some((a) => a.taskId === SETTINGS_TEST_TASK)).toBe(true); // 但本地审计照常
  });

  it("解锁失败：逐步结果里带失败步骤和原因；电脑留在锁屏（不重试）", async () => {
    const fx = make({
      unlock: async () => ({ ok: false, error: "校验超时：仍在锁屏界面" }),
    });
    const r = await fx.manager.testLockedAccess();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("校验超时");
    expect(stepNames(r)).toEqual(["countdown", "lock", "unlock.check", "unlock.type", "unlock"]);
    expect(r.steps.at(-1)).toMatchObject({ name: "unlock", ok: false, detail: expect.stringContaining("校验超时") });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(fx.world.locked).toBe(true);
    expect(fx.sink).not.toHaveBeenCalled();
  });

  it("上一次解锁失败进入冷却后，测试也不绕过冷却：在锁屏之前就拒绝（别把用户电脑锁上又解不开）；重新保存密码后可以测", async () => {
    let first = true;
    const fx = make({
      locked: true,
      unlock: async (w) => {
        if (first) {
          first = false;
          return { ok: false, error: "第一次失败" };
        }
        w.locked = false;
        return { ok: true };
      },
    });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNLOCK_FAILED"); // 冷却中：不再试
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    fx.world.locked = false; // 用户自己解开了
    const lockCallsBefore = fx.driver.lockScreen.mock.calls.length;
    const clockBefore = fx.world.clock;
    const refused = await fx.manager.testLockedAccess();
    expect(refused).toMatchObject({ ok: false, steps: [], error: expect.stringContaining("暂时不能测试") });
    expect(refused.error).toContain("这次没有锁屏");
    expect(fx.driver.lockScreen.mock.calls.length).toBe(lockCallsBefore); // 没有锁屏
    expect(fx.world.clock).toBe(clockBefore); // 也没有倒计时
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1); // 没有多输一次密码

    // 用户重新保存密码 → 冷却解除 → 测试可以进行
    expect(await fx.manager.setCredential({ password: SECRET })).toEqual({ ok: true });
    const r = await fx.manager.testLockedAccess();
    expect(r.ok).toBe(true);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(2);
  });

  it("保存的密码读不出 / 打不出：在锁屏之前就拒绝，不倒计时、不锁屏", async () => {
    const fx = make({ checkCredential: async () => ({ ok: false, error: "保存的开机密码里有输入不了的字符：只支持英文字母" }) });
    const r = await fx.manager.testLockedAccess();
    expect(r).toMatchObject({ ok: false, steps: [], error: expect.stringContaining("输入不了的字符") });
    expect(r.error).toContain("这次没有锁屏");
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(fx.world.clock).toBe(fx.startClock);

    // 预检本身抛异常：同样当失败处理，不锁屏
    const boom = make({
      checkCredential: async () => {
        throw new Error("钥匙串需要授权");
      },
    });
    const b = await boom.manager.testLockedAccess();
    expect(b).toMatchObject({ ok: false, steps: [], error: expect.stringContaining("钥匙串需要授权") });
    expect(boom.driver.lockScreen).not.toHaveBeenCalled();

    // 预检通过：照常测试
    const good = make({ checkCredential: async () => ({ ok: true }) });
    expect((await good.manager.testLockedAccess()).ok).toBe(true);
  });

  it("测试进行中：AI 的桌面请求被挡（DENIED，不和测试抢着解锁）；desktop_status 照常；测试结束恢复", async () => {
    const gate = deferred();
    const fx = make({
      unlock: async (w) => {
        await gate.promise; // 测试停在「解锁」这一步
        w.locked = false;
        return { ok: true };
      },
    });
    const running = fx.manager.testLockedAccess();
    await flush();
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("DENIED");
    expect(await codeOf(fx.op("desktop_click", { x: 1, y: 1 }))).toBe("DENIED");
    expect(await messageOf(fx.op("desktop_screenshot"))).toContain("测试");
    expect((await fx.op("desktop_status")).ok).toBe(true);
    gate.resolve();
    expect((await running).ok).toBe(true);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1); // 只有测试自己解了一次锁
    expect((await shot(fx)).ok).toBe(true); // 测试结束：AI 可以用了
  });

  it("倒计时的 5 秒里 AI 开了会话 / 电脑被锁了：取消测试、不再锁屏", async () => {
    // 极窄的竞态：AI 的请求在测试开始前已过了入口、倒计时期间才开会话。这里在倒计时的 sleep 里直接把会话开起来模拟
    let fired = false;
    const holder: { fx?: ReturnType<typeof make> } = {};
    const fx = make({
      onSleep: (ms) => {
        if (ms === MANAGER_LIMITS.testCountdownMs && !fired) {
          fired = true;
          void holder.fx?.manager._session.begin("t-race");
        }
      },
    });
    holder.fx = fx;
    const r = await fx.manager.testLockedAccess();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("倒计时期间 AI 开始使用电脑了") });
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();

    let fired2 = false;
    const locked = make({
      onSleep: (ms, world) => {
        if (ms === MANAGER_LIMITS.testCountdownMs && !fired2) {
          fired2 = true;
          world.locked = true; // 用户自己锁了
        }
      },
    });
    const r2 = await locked.manager.testLockedAccess();
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining("已经被锁屏了") });
    expect(locked.driver.lockScreen).not.toHaveBeenCalled();
  });

  it("前置条件不满足：直接失败，不倒计时、不锁屏", async () => {
    const cases: Array<[string, Opts, string]> = [
      ["组件没装上", { initOk: false }, "koffi"],
      ["总开关没开", { enabled: false }, "电脑操作"],
      ["锁屏开关没开", { lockedAccess: false }, "锁屏时也能用"],
      ["解锁器不支持", { platform: "win32", unlockerSupported: false }, "暂不支持"],
      ["没有解锁器", { noUnlocker: true }, "暂不支持"],
      ["没存密码", { credential: false }, "开机密码"],
      ["缺辅助功能", { accessibility: "denied" }, "系统权限"],
      ["缺屏幕录制", { screen: "not-determined" }, "系统权限"],
      ["已经锁屏", { locked: true }, "锁屏状态"],
    ];
    for (const [name, opts, expected] of cases) {
      const fx = make(opts);
      const r = await fx.manager.testLockedAccess();
      expect(r.ok, name).toBe(false);
      expect(r.error, name).toContain(expected);
      expect(r.steps, name).toEqual([]);
      expect(fx.driver.lockScreen, name).not.toHaveBeenCalled();
      expect(fx.world.clock, name).toBe(fx.startClock); // 没有倒计时
    }
  });

  it("同一时刻只允许一次测试：连点两下只锁一遍屏；结束后可以再测", async () => {
    const fx = make();
    const [a, b] = await Promise.all([fx.manager.testLockedAccess(), fx.manager.testLockedAccess()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const rejected = a.ok ? b : a;
    expect(rejected).toMatchObject({ steps: [], error: expect.stringContaining("正在进行") });
    expect(fx.driver.lockScreen).toHaveBeenCalledTimes(1);
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    fx.world.locked = false;
    expect((await fx.manager.testLockedAccess()).ok).toBe(true);
  });

  it("测试途中抛出意外异常：测试标记也要复位，之后还能再测", async () => {
    const fx = make({
      unlock: async () => {
        throw new Error("解锁器意外炸了");
      },
    });
    const r = await fx.manager.testLockedAccess();
    expect(r.ok).toBe(false); // session 把解锁器的异常折成 UNLOCK_FAILED 的失败结果
    fx.world.locked = false;
    const again = await fx.manager.testLockedAccess();
    expect(again.error ?? "").not.toContain("正在进行");
  });

  it("AI 正在用电脑时不能测", async () => {
    const fx = make();
    await shot(fx);
    const r = await fx.manager.testLockedAccess();
    expect(r).toMatchObject({ ok: false, steps: [], error: expect.stringContaining("正在使用电脑") });
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
  });

  it("锁屏命令失败 / 发了命令但没锁上：明确报错，不去解锁", async () => {
    const throws = make({ lockScreenThrows: true });
    const a = await throws.manager.testLockedAccess();
    expect(a.ok).toBe(false);
    expect(a.error).toContain("锁屏命令失败");
    expect(a.steps.at(-1)).toMatchObject({ name: "lock", ok: false, detail: expect.stringContaining("锁屏接口不可用") });
    expect(throws.unlocker.unlock).not.toHaveBeenCalled();

    const noEffect = make({ lockScreenNoEffect: true });
    const b = await noEffect.manager.testLockedAccess();
    expect(b.ok).toBe(false);
    expect(b.error).toContain("没有进入锁屏状态");
    expect(b.steps.at(-1)).toMatchObject({ name: "lock", ok: false });
    expect(noEffect.unlocker.unlock).not.toHaveBeenCalled();
  });

  describe("遮罩自检（overlay.capture）", () => {
    it("在解锁之后、遮罩盖着、会话收尾之前做；通过则多一项 overlay.capture，说明文字原样带出；其余照旧（停在桌面、不锁回去）", async () => {
      const fx = make({ selfCheck: async () => ({ ok: true, detail: "系统会把遮罩截进画面：已改成每次截图前短暂撤掉遮罩" }) });
      const r = await fx.manager.testLockedAccess();
      expect(r.ok).toBe(true);
      expect(stepNames(r)).toEqual(["countdown", "lock", "unlock.check", "unlock.type", "unlock", "overlay.capture"]);
      expect(r.steps.at(-1)).toMatchObject({ name: "overlay.capture", ok: true, detail: "系统会把遮罩截进画面：已改成每次截图前短暂撤掉遮罩" });
      expect(fx.screenshotter.selfCheck).toHaveBeenCalledTimes(1);
      const at = (s: string) => fx.calls.indexOf(s);
      expect(at("unlock")).toBeGreaterThan(-1);
      expect(at("unlock")).toBeLessThan(at("overlay.show"));
      expect(at("overlay.show")).toBeLessThan(at("selfCheck"));
      expect(at("selfCheck")).toBeLessThan(fx.calls.lastIndexOf("overlay.hide")); // 自检时遮罩还盖着
      expect(fx.seen.selfCheckState).toBe("active"); // 会话还没收尾
      expect(fx.world.locked).toBe(false);
      expect(fx.unlocker.lock).not.toHaveBeenCalled();
      expect(fx.manager._session.status().state).toBe("idle");
      expect(fx.sink).not.toHaveBeenCalled();
    });

    it("自检说「跳过」（遮罩已撤 / 读不到像素）：不算失败，整体照样通过，说明文字带出", async () => {
      const fx = make({ selfCheck: async () => ({ ok: true, skipped: true, detail: "遮罩已经撤了，这次没做遮罩自检" }) });
      const r = await fx.manager.testLockedAccess();
      expect(r.ok).toBe(true);
      expect(r.steps.at(-1)).toMatchObject({ name: "overlay.capture", ok: true, detail: expect.stringContaining("没做遮罩自检") });
    });

    it("自检不通过（遮罩盖着时 AI 截不到真实屏幕）：整体判失败并写明原因，但解锁那一步仍是通过的；会话照常收尾（遮罩撤掉、停在桌面、不锁回去）", async () => {
      const fx = make({ selfCheck: async () => ({ ok: false, detail: "带遮罩和撤掉遮罩截出来都几乎全是遮罩底色（97% / 97%）" }) });
      const r = await fx.manager.testLockedAccess();
      expect(r.ok).toBe(false);
      expect(r.error).toContain("overlay.capture");
      expect(r.error).toContain("自动解锁没有问题");
      expect(r.steps.find((s) => s.name === "unlock")).toMatchObject({ ok: true });
      expect(r.steps.at(-1)).toMatchObject({ name: "overlay.capture", ok: false, detail: expect.stringContaining("97%") });
      expect(fx.overlay.hide).toHaveBeenCalled();
      expect(fx.manager._session.status().state).toBe("idle");
      expect(fx.world.locked).toBe(false);
      expect(fx.unlocker.lock).not.toHaveBeenCalled();
      // 之后还能再测（测试标记已复位）
      fx.world.locked = false;
      const again = await fx.manager.testLockedAccess();
      expect(again.error ?? "").not.toContain("正在进行");
    });

    it("自检抛异常：记成这一项失败（说明里带原因），同样走完收尾；抛出的原因不被吞", async () => {
      const fx = make({
        selfCheck: async () => {
          throw new Error("截图权限被撤了");
        },
      });
      const r = await fx.manager.testLockedAccess();
      expect(r.ok).toBe(false);
      expect(r.steps.at(-1)).toMatchObject({ name: "overlay.capture", ok: false, detail: expect.stringContaining("遮罩自检出错：截图权限被撤了") });
      expect(fx.overlay.hide).toHaveBeenCalled();
      expect(fx.manager._session.status().state).toBe("idle");
    });

    it("自检没有给出明确结果（返回空 / 不认识的东西）：不能当成通过", async () => {
      for (const bad of [undefined, null, {}, { ok: "yes" }, "ok"]) {
        const fx = make({ selfCheck: async () => bad });
        const r = await fx.manager.testLockedAccess();
        expect(r.ok, JSON.stringify(bad)).toBe(false);
        expect(r.steps.at(-1), JSON.stringify(bad)).toMatchObject({ name: "overlay.capture", ok: false, detail: "遮罩自检没有给出结果" });
        expect(fx.manager._session.status().state).toBe("idle");
      }
    });

    it("说明文字过长：截到 300 字；不带说明的通过结果也不会多出 detail 字段", async () => {
      const long = make({ selfCheck: async () => ({ ok: true, detail: "长".repeat(1000) }) });
      const r = await long.manager.testLockedAccess();
      expect(r.steps.at(-1)?.detail).toBe("长".repeat(300));

      const bare = make({ selfCheck: async () => ({ ok: true }) });
      const b = await bare.manager.testLockedAccess();
      expect(b.ok).toBe(true);
      expect("detail" in (b.steps.at(-1) as object)).toBe(false);
    });

    it("解锁失败时不做自检（遮罩根本没盖上）", async () => {
      const fx = make({
        selfCheck: async () => ({ ok: true }),
        unlock: async () => ({ ok: false, error: "校验超时：仍在锁屏界面" }),
      });
      const r = await fx.manager.testLockedAccess();
      expect(r.ok).toBe(false);
      expect(fx.screenshotter.selfCheck).not.toHaveBeenCalled();
      expect(stepNames(r)).not.toContain("overlay.capture");
    });

    it("截图器没有自检能力：不多出 overlay.capture 这一步（旧实现 / 假截图器照常工作）", async () => {
      const fx = make();
      const r = await fx.manager.testLockedAccess();
      expect(r.ok).toBe(true);
      expect(stepNames(r)).not.toContain("overlay.capture");
    });
  });
});

describe("导出诊断", () => {
  it("写到用户数据目录（仅本人可读）；内容是状态 / 驱动诊断 / 解锁步骤名，不含凭据和用户内容", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    await fx.op("desktop_type", { text: TYPED_MARK, screenshot: false });
    await fx.manager.setCredential({ password: SECRET });
    const { path: file } = await fx.manager.exportDiagnostics();
    expect(file).toMatch(/^\/tmp\/flowship-test\/desktop-diagnostics-.+\.json$/);
    expect(fx.fsImpl.mkdir).toHaveBeenCalledWith("/tmp/flowship-test", { recursive: true });
    const [writtenPath, body, writeOpts] = fx.fsImpl.writeFile.mock.calls[0] as unknown as [string, string, { mode: number; encoding: string }];
    expect(writtenPath).toBe(file);
    expect(writeOpts).toMatchObject({ mode: 0o600, encoding: "utf8" });
    const parsed = JSON.parse(body);
    expect(parsed.app).toEqual({ name: "Flowship", version: "9.9.9", electron: "42.0.0" });
    expect(parsed.driver).toEqual({ koffi: "3.3.8", platform: "darwin" });
    expect(parsed.status).toMatchObject({ platform: "darwin", driverReady: true, credentialSet: true });
    expect(parsed.recentUnlockSteps).toEqual([
      { name: "check", ok: true, ms: 5 },
      { name: "type", ok: true, ms: 80 },
    ]);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(TYPED_MARK);
    expect(body).not.toContain(DETAIL_MARK);
  });

  it("记录截图模式（遮罩会不会被系统截进画面）；截图器没有这个能力时是 null", async () => {
    const withMode = make({ captureMode: "exposed" });
    await withMode.manager.exportDiagnostics();
    const a = JSON.parse((withMode.fsImpl.writeFile.mock.calls[0] as unknown as [string, string])[1]);
    expect(a.captureMode).toBe("exposed");

    const without = make();
    await without.manager.exportDiagnostics();
    const b = JSON.parse((without.fsImpl.writeFile.mock.calls[0] as unknown as [string, string])[1]);
    expect(b.captureMode).toBeNull();
  });

  it("组件没装上也能导出（里面写明原因）；写文件失败照常抛出", async () => {
    const broken = make({ initOk: false });
    await broken.manager.exportDiagnostics();
    const body = JSON.parse((broken.fsImpl.writeFile.mock.calls[0] as unknown as [string, string])[1]);
    expect(body.driver).toMatchObject({ ready: false, error: expect.stringContaining("koffi") });
    await expect(make({ writeFileThrows: true }).manager.exportDiagnostics()).rejects.toThrow("磁盘已满");
  });
});

// ═══════════════════ 锁屏后台档（Windows）：不解锁，逐窗口截图 + 窗口消息 ═══════════════════

describe("锁屏后台档：路由", () => {
  it("锁屏 + 后台可用：截图走后台合成，不解锁、不盖遮罩、不碰真实屏幕；结果带 mode 与窗口摘要", async () => {
    const fx = make({ platform: "win32", locked: true, background: true, credential: false });
    const r = await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(fx.calls).toEqual(["bg.reset", "bg.capture"]);
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.overlay.show).not.toHaveBeenCalled();
    expect(fx.screenshotter.capture).not.toHaveBeenCalled();
    expect(fx.world.locked).toBe(true);
    expect(r).toMatchObject({
      ok: true,
      mode: "background",
      unlockedByUs: false,
      image: { data: b64("BGJPEG1"), mimeType: "image/jpeg", width: 1000, height: 500 },
      windows: [{ app: "notepad.exe", x: 10, y: 10, width: 300, height: 200, status: "ok" }],
    });
    expect(fx.manager._session.status()).toMatchObject({ state: "active", mode: "background" });
    expect(fx.kinds()).toEqual(["background_started"]);
  });

  it("后台窗口摘要：只有进程名 / 位置 / 状态，没有标题等其它字段；条数有上限；状态异常的原样给 AI", async () => {
    const many = Array.from({ length: MANAGER_LIMITS.maxBackgroundWindows + 5 }, (_, i) => ({
      className: `Cls${i}`,
      processName: i === 0 ? "" : `app${i}.exe`,
      title: "SECRET-WINDOW-TITLE",
      x: i,
      y: 0,
      width: 10,
      height: 10,
      status: i === 1 ? "blank" : "ok",
    }));
    const fx = make({ platform: "win32", locked: true, background: { windows: many } });
    const r = await fx.op("desktop_screenshot", { allowUnlock: true });
    const windows = r.windows as Array<Record<string, unknown>>;
    expect(windows).toHaveLength(MANAGER_LIMITS.maxBackgroundWindows);
    expect(windows[0]).toEqual({ app: "Cls0", x: 0, y: 0, width: 10, height: 10, status: "ok" }); // 没有进程名就退回类名
    expect(windows[1]).toMatchObject({ app: "app1.exe", status: "blank" });
    expect(JSON.stringify(r)).not.toContain("SECRET-WINDOW-TITLE");
  });

  it("后台会话里的输入走后台通道（坐标照常按截图换算），不碰真实键鼠；动作后自动带后台截图", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.calls.length = 0;

    const click = await fx.op("desktop_click", { x: 100, y: 50, allowUnlock: true });
    expect(fx.calls).toEqual(["bg.click 200,100 leftx1", "bg.capture"]);
    expect(click).toMatchObject({ ok: true, mode: "background", image: { data: b64("BGJPEG2") } });
    expect(fx.driver.click).not.toHaveBeenCalled();

    fx.calls.length = 0;
    await fx.op("desktop_move", { x: 10, y: 10, screenshot: false });
    await fx.op("desktop_drag", { x: 10, y: 10, toX: 20, toY: 30, screenshot: false });
    await fx.op("desktop_scroll", { x: 100, y: 100, dy: 3, screenshot: false });
    await fx.op("desktop_open_app", { name: "记事本", screenshot: false });
    expect(fx.calls).toEqual(["bg.move 20,20", "bg.drag 20,20->40,60 left", "bg.scroll 200,200 0,3", "bg.open 记事本"]);
    expect(fx.driver.mouseMove).not.toHaveBeenCalled();
    expect(fx.driver.drag).not.toHaveBeenCalled();
    expect(fx.driver.scroll).not.toHaveBeenCalled();
    expect(fx.driver.openApp).not.toHaveBeenCalled();
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
  });

  it("后台打字：逐字消息，长文本也不借剪贴板（锁屏时 Ctrl+V 不可靠）；submit 用后台通道按回车", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const long = "你好".repeat(MANAGER_LIMITS.pasteThreshold);
    await fx.op("desktop_type", { text: long, submit: true, screenshot: false });
    expect(fx.typed).toEqual([long]);
    expect(fx.clipboard.writeText).not.toHaveBeenCalled();
    expect(fx.driver.typeText).not.toHaveBeenCalled();
    expect(fx.driver.keyCombo).not.toHaveBeenCalled();
    expect(fx.calls.filter((c) => c.startsWith("bg.")).slice(-2)).toEqual([`bg.type ${long.length}`, "bg.key enter"]);
  });

  it("后台按键：驱动返回的「尽力而为」提示原样带给 AI（重复按键只提示一次）", async () => {
    const fx = make({ platform: "win32", locked: true, background: { keyNote: "带修饰键的组合只是尽力模拟" } });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const r = await fx.op("desktop_key", { keys: "ctrl+a", repeat: 3, screenshot: false });
    expect(r.note).toBe("带修饰键的组合只是尽力模拟");
    expect(fx.calls.filter((c) => c === "bg.key ctrl+a")).toHaveLength(3);
    // 没有提示的按键不带 note 字段
    const plain = make({ platform: "win32", locked: true, background: true });
    await plain.op("desktop_screenshot", { allowUnlock: true });
    expect(await plain.op("desktop_key", { keys: "enter", screenshot: false })).not.toHaveProperty("note");
  });

  it("后台做不到的按键（Win 键 / Alt+Tab）：NEED_FOREGROUND 原样抛出，会话不受影响，没有悄悄去解锁", async () => {
    const fx = make({
      platform: "win32",
      locked: true,
      background: { keyNeedForeground: (c) => c.mods.includes("meta") },
    });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(await codeOf(fx.op("desktop_key", { keys: "win+d", allowUnlock: true }))).toBe("NEED_FOREGROUND");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.manager._session.status()).toMatchObject({ state: "active", mode: "background" });
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_key", ok: false, code: "NEED_FOREGROUND" });
    // 之后后台操作照常
    await expect(fx.op("desktop_key", { keys: "enter", screenshot: false })).resolves.toMatchObject({ ok: true });
  });

  it("desktop_apps 在后台会话里照常列应用（读窗口列表本来就不需要输入桌面）", async () => {
    const fx = make({ platform: "win32", locked: true, background: true, apps: [{ name: "记事本", pid: 1, frontmost: true, windows: [] }] });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const r = await fx.op("desktop_apps", { allowUnlock: true });
    expect(r).toMatchObject({ ok: true, apps: [{ name: "记事本" }] });
    expect(fx.driver.listApps).toHaveBeenCalledTimes(1);
  });

  it("没截过图就点击：照旧 BAD_ARGS（后台档也不拿旧画面的坐标）", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    expect(await codeOf(fx.op("desktop_click", { x: 1, y: 1, allowUnlock: true }))).toBe("BAD_ARGS");
    expect(fx.calls).toEqual([]);
    expect(fx.manager._session.status().state).toBe("idle");
  });

  it("没锁屏：后台档可用也用不上，走真实屏幕和真实键鼠，结果里没有 mode", async () => {
    const fx = make({ platform: "win32", background: true });
    const r = await fx.op("desktop_screenshot");
    expect(r).not.toHaveProperty("mode");
    expect(r).not.toHaveProperty("windows");
    await fx.op("desktop_click", { x: 100, y: 50, screenshot: false });
    expect(fx.calls).toEqual(["capture", "click 200,100 leftx1"]);
    expect(fx.bgShotter.capture).not.toHaveBeenCalled();
    expect(fx.bgDriver.click).not.toHaveBeenCalled();
  });

  it("后台截图失败：截图工具直接报错；动作后的补截图失败只带 screenshotError，动作结果照旧 ok", async () => {
    const fx = make({ platform: "win32", locked: true, background: { captureError: new Error("PrintWindow 全部失败") } });
    await expect(fx.op("desktop_screenshot", { allowUnlock: true })).rejects.toThrow("PrintWindow 全部失败");

    // 先成功截一张，再让补截图失败
    const ok = make({ platform: "win32", locked: true, background: true });
    await ok.op("desktop_screenshot", { allowUnlock: true });
    ok.bgShotter.capture.mockRejectedValueOnce(new Error("后台截图抖了一下"));
    const r = await ok.op("desktop_click", { x: 10, y: 10 });
    expect(r).toMatchObject({ ok: true, screenshotError: expect.stringContaining("后台截图抖了一下") });
    expect(r.image).toBeUndefined();
  });
});

describe("锁屏后台档：升级到前台（foreground:true）", () => {
  it("锁屏 + 一上来就要 foreground：不走后台档，照常解锁 + 遮罩 + 真实截图", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    const r = await fx.op("desktop_screenshot", { allowUnlock: true, foreground: true });
    expect(fx.calls).toEqual(["unlock", "overlay.show", "capture"]);
    expect(r).not.toHaveProperty("mode");
    expect(r.unlockedByUs).toBe(true);
    expect(fx.bgDriver.reset).not.toHaveBeenCalled();
    expect(fx.manager._session.status()).toMatchObject({ mode: "foreground", unlockedByUs: true });
  });

  it("后台会话 → foreground 截图：升级（解锁 + 遮罩），之后的输入走真实键鼠", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.calls.length = 0;

    const r = await fx.op("desktop_screenshot", { allowUnlock: true, foreground: true });
    expect(fx.calls).toEqual(["unlock", "overlay.show", "capture"]);
    expect(r).not.toHaveProperty("mode");
    expect(r.unlockedByUs).toBe(true);
    expect(fx.kinds()).toEqual(["background_started", "unlocking", "unlocked", "foreground_started"]);

    fx.calls.length = 0;
    await fx.op("desktop_click", { x: 100, y: 50, screenshot: false });
    expect(fx.calls).toEqual(["click 200,100 leftx1"]);
    expect(fx.bgDriver.click).not.toHaveBeenCalled();

    // 结束：我们解的锁，锁回去
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: true, unlockedByUs: true, relocked: true });
  });

  it("升级的闸门：allowUnlock 缺省 → SCREEN_LOCKED、不解锁、仍是后台会话，后台操作继续可用", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(await codeOf(fx.op("desktop_screenshot", { foreground: true }))).toBe("SCREEN_LOCKED");
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.manager._session.status()).toMatchObject({ state: "active", mode: "background" });
    await expect(fx.op("desktop_screenshot", { allowUnlock: true })).resolves.toMatchObject({ ok: true, mode: "background" });
  });

  it("升级时没有密码 / 组件：报错并说清楚，仍是后台会话", async () => {
    const fx = make({ platform: "win32", locked: true, background: true, credential: false });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    const msg = await messageOf(fx.op("desktop_screenshot", { allowUnlock: true, foreground: true }));
    expect(msg).toContain("解锁组件");
    expect(msg).toContain("锁屏后台模式");
    expect(fx.manager._session.status().mode).toBe("background");
  });

  it("输入类动作带 foreground:true 也不会偷偷升级（只有截图 / 列应用开放这个参数）", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    await fx.op("desktop_click", { x: 100, y: 50, allowUnlock: true, foreground: true, screenshot: false });
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.bgDriver.click).toHaveBeenCalledTimes(1);
    expect(fx.manager._session.status().mode).toBe("background");
  });

  it("desktop_apps 也可以要求 foreground", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_apps", { allowUnlock: true, foreground: true });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(fx.manager._session.status().mode).toBe("foreground");
  });

  it("没锁屏时 foreground:true 无事发生（本来就是前台）", async () => {
    const fx = make({ platform: "win32", background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true, foreground: true });
    expect(fx.unlocker.unlock).not.toHaveBeenCalled();
    expect(fx.manager._session.status().mode).toBe("foreground");
  });
});

describe("锁屏后台档：不可用时回退 / 会话收尾", () => {
  it("后台组件初始化失败：锁屏时回到解锁流程，status 里说明原因", async () => {
    const fx = make({ platform: "win32", locked: true, background: { initOk: false } });
    const r = await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(r).not.toHaveProperty("mode");
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    expect(fx.bgShotter.capture).not.toHaveBeenCalled();
    const st = await fx.manager.getStatus();
    expect(st).toMatchObject({ backgroundSupported: true, backgroundReady: false, backgroundError: expect.stringContaining("PrintWindow") });
  });

  it("后台组件初始化抛异常：同样回退，不影响别的功能；只初始化一次", async () => {
    const fx = make({ platform: "win32", locked: true, background: { initThrows: true } });
    await expect(fx.op("desktop_screenshot", { allowUnlock: true })).resolves.toMatchObject({ ok: true });
    expect(fx.unlocker.unlock).toHaveBeenCalledTimes(1);
    await fx.op("desktop_screenshot", { allowUnlock: true });
    await fx.manager.getStatus();
    expect(fx.bgDriver.init).toHaveBeenCalledTimes(1);
    expect(fx.logs.join("\n")).toContain("后台组件初始化出错");
  });

  it("核心驱动没加载成功：后台档不初始化（依赖它），报 UNSUPPORTED", async () => {
    const fx = make({ platform: "win32", locked: true, background: true, initOk: false });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("UNSUPPORTED");
    expect(fx.bgDriver.init).not.toHaveBeenCalled();
  });

  it("总开关没开：ACCESS_DISABLED 在初始化后台组件之前就拒绝", async () => {
    const fx = make({ platform: "win32", locked: true, enabled: false, background: true });
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("ACCESS_DISABLED");
    expect(fx.bgDriver.init).not.toHaveBeenCalled();
  });

  it("结束后台会话：不锁屏；返回 mode:background，server 据此说「电脑仍是锁屏状态」", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: true, unlockedByUs: false, relocked: false, mode: "background" });
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.world.locked).toBe(true);
    expect(fx.calls.filter((c) => c === "bg.reset")).toHaveLength(2); // 开始 + 结束各清一次
  });

  it("前台会话结束：返回里没有 mode 字段（macOS / 老 server 的形状不变）", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(await fx.op("desktop_end_session")).toEqual({ ok: true, ended: true, unlockedByUs: true, relocked: true });
  });

  it("后台会话里用户碰了键鼠：USER_TOOK_OVER，让位、不锁屏；坐标作废", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.world.clock += 5000;
    fx.world.lastUserInput = fx.world.clock - 50;
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10, allowUnlock: true }))).toBe("USER_TOOK_OVER");
    await flush();
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.manager._session.status().state).toBe("idle");
    // 会话没了，旧画面的坐标作废
    fx.world.lastUserInput = -1e9;
    fx.world.clock += 60_000;
    expect(await codeOf(fx.op("desktop_click", { x: 10, y: 10, allowUnlock: true }))).toBe("BAD_ARGS");
  });

  it("后台会话期间电脑被解锁（用户回来了）：SESSION_EXPIRED，会话结束，不再去锁", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.world.locked = false;
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("SESSION_EXPIRED");
    await flush();
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
    expect(fx.events.find((e) => e.data.kind === "session_ended")?.data).toMatchObject({ reason: "unlocked_externally", mode: "background" });
    // 再来一次：没锁屏，按正常方式开始
    await expect(fx.op("desktop_screenshot", { allowUnlock: true })).resolves.toMatchObject({ ok: true });
    expect(fx.manager._session.status().mode).toBe("foreground");
  });

  it("后台会话被任务取消 / 总开关关掉：结束，不锁屏（我们没解锁过）", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.manager.onConfig({ desktopEnabled: false });
    await flush();
    expect(fx.manager._session.status().state).toBe("idle");
    expect(fx.unlocker.lock).not.toHaveBeenCalled();
  });

  it("审计里后台动作和前台一样记录（只有长度 / 坐标，没有文字内容）", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    await fx.op("desktop_type", { text: TYPED_MARK, screenshot: false });
    expect(fx.actionAudits().at(-1)).toMatchObject({ op: "desktop_type", ok: true, chars: TYPED_MARK.length });
    expect(JSON.stringify(fx.audits)).not.toContain(TYPED_MARK);
    expect(fx.logs.join("\n")).not.toContain(TYPED_MARK);
  });
});

describe("锁屏后台档：状态 / 就绪判定", () => {
  it("Windows + 后台可用 + 开关开：就绪（不需要开机密码）；解锁路线单独报「没装组件 / 没存密码」", async () => {
    const fx = make({ platform: "win32", locked: true, background: true, credential: false, helper: { installed: false } });
    const st = await fx.manager.getStatus();
    expect(st).toMatchObject({
      platform: "win32",
      lockedAccessSupported: true,
      lockedAccessEnabled: true,
      lockedAccessReady: true,
      backgroundSupported: true,
      backgroundReady: true,
      unlockSupported: true,
      unlockReady: false,
      unlockNote: "还没有安装解锁组件",
      unlockHelper: { installed: false, canInstall: true },
      credentialSet: false,
    });
    expect(st.lockedAccessNote).toBeUndefined();
    expect(st.backgroundError).toBeUndefined();
  });

  it("装了组件但没存密码：unlockNote 换成「没有保存开机密码」；都有了 unlockReady", async () => {
    const noCred = await make({ platform: "win32", background: true, credential: false, helper: { installed: true } }).manager.getStatus();
    expect(noCred).toMatchObject({ unlockReady: false, unlockNote: "还没有保存开机密码", lockedAccessReady: true });
    const full = await make({ platform: "win32", background: true, credential: true, helper: { installed: true } }).manager.getStatus();
    expect(full).toMatchObject({ unlockReady: true, lockedAccessReady: true, unlockHelper: { installed: true } });
    expect(full.unlockNote).toBeUndefined();
  });

  it("开关没开：lockedAccessReady 为 false 且不带说明；解锁路线的就绪状态照常报", async () => {
    const st = await make({ platform: "win32", background: true, lockedAccess: false, credential: true, helper: { installed: true } }).manager.getStatus();
    expect(st).toMatchObject({ lockedAccessReady: false, unlockReady: true });
    expect(st.lockedAccessNote).toBeUndefined();
  });

  it("后台组件没就绪、解锁组件也没装：不就绪，说明里写后台组件的原因", async () => {
    const st = await make({
      platform: "win32",
      background: { initOk: false },
      helper: { installed: false },
      unlockerSupported: false,
    }).manager.getStatus();
    expect(st).toMatchObject({ lockedAccessSupported: false, lockedAccessReady: false, backgroundReady: false });
    expect(st.lockedAccessNote).toContain("后台组件没有就绪");
    expect(st.lockedAccessNote).toContain("PrintWindow");
  });

  it("后台组件没就绪、但解锁路线可用：就绪判定回到解锁的条件", async () => {
    const ready = await make({ platform: "win32", background: { initOk: false }, credential: true, helper: { installed: true } }).manager.getStatus();
    expect(ready).toMatchObject({ lockedAccessReady: true, unlockReady: true, backgroundReady: false });
    const noCred = await make({ platform: "win32", background: { initOk: false }, credential: false, helper: { installed: true } }).manager.getStatus();
    expect(noCred).toMatchObject({ lockedAccessReady: false, lockedAccessNote: "还没有保存开机密码" });
  });

  it("读解锁组件状态抛错：当作没装，不影响整份状态", async () => {
    const st = await make({ platform: "win32", background: true, helper: { installed: true, statusThrows: true } }).manager.getStatus();
    expect(st.unlockHelper).toMatchObject({ installed: false, canInstall: false, detail: expect.stringContaining("读取解锁组件状态出错") });
    expect(st.driverReady).toBe(true);
  });

  it("会话期间 status.session.mode 是 background / foreground；没会话时没有 mode", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    expect((await fx.manager.getStatus()).session).toEqual({ active: false, unlockedByUs: false });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect((await fx.manager.getStatus()).session).toMatchObject({ active: true, mode: "background", unlockedByUs: false });
    await fx.op("desktop_screenshot", { allowUnlock: true, foreground: true });
    expect((await fx.manager.getStatus()).session).toMatchObject({ active: true, mode: "foreground", unlockedByUs: true });
  });

  it("AI 的 desktop_status：Windows 带两条路线的就绪状态（macOS 不带这两个字段）", async () => {
    const win = await make({ platform: "win32", background: true, credential: false, helper: { installed: true } }).op("desktop_status");
    expect(win).toMatchObject({ lockedAccessReady: true, backgroundReady: true, unlockReady: false });
    const mac = await make().op("desktop_status");
    expect(mac).not.toHaveProperty("backgroundReady");
    expect(mac).not.toHaveProperty("unlockReady");
  });
});

describe("设置页「测试锁屏可用」在有后台档的平台：测的是解锁，不是后台", () => {
  it("Windows：强制走解锁（foreground），不会走后台档", async () => {
    const fx = make({ platform: "win32", background: true, helper: { installed: true } });
    const r = await fx.manager.testLockedAccess();
    expect(r).toMatchObject({ ok: true });
    expect(fx.calls).toContain("unlock");
    // 会话收尾时会清一次后台状态（bg.reset，无害）；除此之外后台通道一次都不该碰
    expect(fx.calls.filter((c) => c.startsWith("bg.") && c !== "bg.reset")).toEqual([]);
    expect(fx.bgShotter.capture).not.toHaveBeenCalled();
  });

  it("解锁组件没装：在锁屏之前就拒绝，说清楚先装组件", async () => {
    const fx = make({ platform: "win32", background: true, helper: { installed: false } });
    const r = await fx.manager.testLockedAccess();
    expect(r).toMatchObject({ ok: false, steps: [], error: expect.stringContaining("安装") });
    expect(r.error).toContain("解锁组件");
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
    expect(fx.world.clock).toBe(fx.startClock);
  });

  it("解锁组件状态读不出来：当没装，同样拒绝", async () => {
    const fx = make({ platform: "win32", background: true, helper: { installed: true, statusThrows: true } });
    const r = await fx.manager.testLockedAccess();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("解锁组件") });
    expect(fx.driver.lockScreen).not.toHaveBeenCalled();
  });
});

describe("设置页「测试后台操作」", () => {
  it("前置条件不满足：直接失败，不跑探针、不锁屏", async () => {
    const cases: Array<[string, Parameters<typeof make>[0], string]> = [
      ["没有后台档（macOS）", {}, "没有锁屏后台模式"],
      ["没有探针", { platform: "win32", background: { probe: false } }, "没有锁屏后台模式"],
      ["核心组件没装上", { platform: "win32", background: true, initOk: false }, "koffi"],
      ["后台组件没就绪", { platform: "win32", background: { initOk: false } }, "后台组件没有就绪"],
      ["总开关没开", { platform: "win32", background: true, enabled: false }, "电脑操作"],
      ["锁屏开关没开", { platform: "win32", background: true, lockedAccess: false }, "锁屏时也能用"],
      ["已经锁屏", { platform: "win32", background: true, locked: true }, "锁屏状态"],
    ];
    for (const [name, opts, expected] of cases) {
      const fx = make(opts);
      const r = await fx.manager.testBackground();
      expect(r.ok, name).toBe(false);
      expect(r.error, name).toContain(expected);
      expect(r.steps, name).toEqual([]);
      if (fx.bgProbe) expect(fx.bgProbe.run, name).not.toHaveBeenCalled();
      expect(fx.driver.lockScreen, name).not.toHaveBeenCalled();
    }
  });

  it("AI 正在用电脑：拒绝，不动探针", async () => {
    const fx = make({ platform: "win32", locked: true, background: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    fx.world.locked = false; // 用户回来了但会话还没收（极窄情形）：仍以会话状态为准
    const r = await fx.manager.testBackground();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("AI 正在使用电脑") });
    expect(fx.bgProbe?.run).not.toHaveBeenCalled();
  });

  it("成功：逐步结果原样返回，审计只记成败，诊断文件里有最近一次结果", async () => {
    const fx = make({
      platform: "win32",
      background: {
        probe: async (ctx) => {
          ctx.onStep?.({ name: "lock", ok: true, ms: 12 });
          ctx.onStep?.({ name: "capture", ok: true, ms: 80, detail: "7 个窗口" });
          ctx.onStep?.({ name: "input", ok: true, ms: 300 });
          return { ok: true, steps: [{ name: "lock", ok: true, ms: 12 }, { name: "capture", ok: true, ms: 80, detail: "7 个窗口" }, { name: "input", ok: true, ms: 300 }] };
        },
      },
    });
    const r = await fx.manager.testBackground();
    expect(r).toEqual({
      ok: true,
      steps: [
        { name: "lock", ok: true, ms: 12 },
        { name: "capture", ok: true, ms: 80, detail: "7 个窗口" },
        { name: "input", ok: true, ms: 300 },
      ],
    });
    expect(fx.audits.some((a) => a.type === "session" && a.kind === "background_probe_ok")).toBe(true);
    await fx.manager.exportDiagnostics();
    const body = JSON.parse((fx.fsImpl.writeFile.mock.calls[0] as unknown as [string, string])[1]);
    expect(body.background).toMatchObject({ ready: true, driver: { ready: true }, lastProbe: { ok: true, steps: expect.any(Array) } });
  });

  it("探针报告失败：ok:false + 错误原文；探针抛异常：兜成一条错误，不炸 IPC", async () => {
    const failed = make({
      platform: "win32",
      background: { probe: async () => ({ ok: false, steps: [{ name: "input", ok: false, ms: 5, detail: "标题没变" }], error: "窗口收到了消息但没有反应" }) },
    });
    expect(await failed.manager.testBackground()).toMatchObject({ ok: false, error: "窗口收到了消息但没有反应", steps: [{ name: "input", ok: false }] });
    expect(failed.audits.some((a) => a.kind === "background_probe_failed")).toBe(true);

    const boom = make({
      platform: "win32",
      background: {
        probe: async (ctx) => {
          ctx.onStep?.({ name: "lock", ok: true, ms: 1 });
          throw new Error("conhost 起不来");
        },
      },
    });
    expect(await boom.manager.testBackground()).toMatchObject({
      ok: false,
      error: expect.stringContaining("conhost 起不来"),
      steps: [{ name: "lock", ok: true }],
    });
  });

  it("测试期间不接 AI 的桌面请求（说清楚是后台测试），desktop_status 照常；结束后恢复；同时只能一个", async () => {
    const gate = deferred();
    const fx = make({
      platform: "win32",
      background: {
        probe: async () => {
          await gate.promise;
          return { ok: true, steps: [] };
        },
      },
    });
    const running = fx.manager.testBackground();
    await flush();
    const err = await messageOf(fx.op("desktop_screenshot", { allowUnlock: true }));
    expect(err).toContain("后台操作");
    expect(await codeOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toBe("DENIED");
    await expect(fx.op("desktop_status")).resolves.toMatchObject({ ok: true });
    expect(await fx.manager.testBackground()).toMatchObject({ ok: false, error: expect.stringContaining("正在进行中") });
    expect(await fx.manager.testLockedAccess()).toMatchObject({ ok: false, error: expect.stringContaining("正在进行中") });
    gate.resolve();
    await running;
    await expect(fx.op("desktop_screenshot", { allowUnlock: true })).resolves.toMatchObject({ ok: true });
  });

  it("测「锁屏可用」期间的拒绝文案仍是解锁测试那条（两种测试各说各的）", async () => {
    const gate = deferred();
    const fx = make({
      platform: "win32",
      background: true,
      helper: { installed: true },
      onSleep: () => undefined,
    });
    fx.unlocker.checkCredential = vi.fn(async () => {
      await gate.promise;
      return { ok: true };
    }) as never;
    const running = fx.manager.testLockedAccess();
    await flush();
    expect(await messageOf(fx.op("desktop_screenshot", { allowUnlock: true }))).toContain("锁屏时也能用");
    gate.resolve();
    await running;
  });
});

describe("解锁组件（Windows）：安装 / 卸载 / 先盖遮罩", () => {
  it("安装成功：审计只记成败；状态里变成已安装", async () => {
    const fx = make({ platform: "win32", background: true, helper: { installed: false } });
    expect(await fx.manager.installUnlockHelper()).toEqual({ ok: true });
    expect(fx.unlocker.installHelper).toHaveBeenCalledTimes(1);
    expect(fx.audits.some((a) => a.type === "session" && a.kind === "unlock_helper_installed")).toBe(true);
    expect((await fx.manager.getStatus()).unlockHelper).toMatchObject({ installed: true });
  });

  it("安装失败 / 抛异常：返回真实原因，审计记失败", async () => {
    const failed = make({ platform: "win32", helper: { installResult: { ok: false, error: "用户取消了管理员授权" } } });
    expect(await failed.manager.installUnlockHelper()).toEqual({ ok: false, error: "用户取消了管理员授权" });
    expect(failed.audits.some((a) => a.kind === "unlock_helper_install_failed")).toBe(true);

    const boom = make({ platform: "win32", helper: {} });
    (boom.unlocker.installHelper as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("powershell 不存在"));
    expect(await boom.manager.installUnlockHelper()).toMatchObject({ ok: false, error: expect.stringContaining("powershell 不存在") });
  });

  it("本平台不需要组件（macOS / 没有解锁器）：安装 / 卸载都明说不需要", async () => {
    expect(await make().manager.installUnlockHelper()).toMatchObject({ ok: false, error: expect.stringContaining("不需要") });
    expect(await make({ noUnlocker: true }).manager.uninstallUnlockHelper()).toMatchObject({ ok: false });
  });

  it("AI 正在用电脑：不安装也不卸载（会重启 / 删掉解锁服务）", async () => {
    const fx = make({ platform: "win32", locked: true, background: true, helper: { installed: true } });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(await fx.manager.installUnlockHelper()).toMatchObject({ ok: false, error: expect.stringContaining("AI 正在使用电脑") });
    expect(await fx.manager.uninstallUnlockHelper()).toMatchObject({ ok: false, error: expect.stringContaining("AI 正在使用电脑") });
    expect(fx.unlocker.installHelper).not.toHaveBeenCalled();
    expect(fx.unlocker.uninstallHelper).not.toHaveBeenCalled();
  });

  it("卸载成功：解除解锁失败冷却（密码都没了，冷却不再有意义）", async () => {
    const fx = make({
      platform: "win32",
      locked: true,
      helper: { installed: true },
      unlock: async () => ({ ok: false, error: "密码不对" }),
    });
    await expect(fx.op("desktop_screenshot", { allowUnlock: true })).rejects.toMatchObject({ code: "UNLOCK_FAILED" });
    expect((await fx.manager.getStatus()).lockedAccessNote).toContain("暂停自动解锁");
    expect(await fx.manager.uninstallUnlockHelper()).toEqual({ ok: true });
    expect(fx.manager._session.status().unlockCooldownUntil).toBe(0);
  });

  it("解锁器声明 overlayBeforeUnlock：manager 透传给会话——先盖遮罩再解锁", async () => {
    const fx = make({ platform: "win32", locked: true, overlayBeforeUnlock: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(fx.calls.slice(0, 3)).toEqual(["overlay.show", "unlock", "capture"]);
  });

  it("默认（macOS）：先解锁再盖遮罩，顺序不变", async () => {
    const fx = make({ locked: true });
    await fx.op("desktop_screenshot", { allowUnlock: true });
    expect(fx.calls.slice(0, 3)).toEqual(["unlock", "overlay.show", "capture"]);
  });
});
