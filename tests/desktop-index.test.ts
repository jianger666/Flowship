/**
 * 电脑操作的组装入口（electron-app/desktop/index.mjs）与 Windows 解锁组件的接线。
 *
 * 钉死：设置页的全部 IPC 通道都过「只认本应用页面」的发送方校验（被拒时 manager 一个方法都不会被调用）、
 * 注册幂等、退出时摘干净；没有桌面驱动的平台回静态 supported:false（卡片据此显示「暂不支持」而不是报错）；
 * Windows 上默认解锁器接的是真的解锁组件（管道客户端 + 提权安装器）：资源目录按「打包后 / 开发期」选对、
 * 安装器与解锁器共用同一个客户端、设置页的保存密码 / 安装 / 卸载一路走到组件；审计 / 诊断文件各放在该放的目录。
 * 截图守卫的接线：默认的截图器 = 真遮罩 + 真守卫 + 真截图器（假 Electron 对象），遮罩会被系统截进画面时 AI 拿到的仍是真实屏幕。
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCooldownStore } from "../electron-app/desktop/cooldown-store.mjs";
import {
  cooldownFilePath,
  createDesktop,
  initFailedStatus,
  keychainFilePath,
  keychainNames,
  makeKeepDisplayAwake,
  makeLocalNotifier,
  unsupportedStatus,
} from "../electron-app/desktop/index.mjs";
import { COMPUTER_USE_CHANNELS } from "../electron-app/desktop/types.mjs";
import { ASSET_FILES } from "../electron-app/desktop/win-helper/protocol.mjs";
import { contractBridgeMethods, preloadBridgeMethods } from "./helpers/computer-use-contract";
import { readSource } from "./helpers/source-text";

// 默认零件里的真钥匙串会加载系统库：这里只看「按什么参数创建」，换成记录参数的假实现
const keychainFactory = vi.hoisted(() =>
  vi.fn((_deps: unknown) => {
    void _deps;
    return { available: () => true, unavailableReason: () => null, has: () => false, set: () => ({ ok: true }), get: () => null, remove: () => true };
  }),
);
vi.mock("../electron-app/desktop/credentials/darwin-keychain.mjs", () => ({ createDarwinKeychain: keychainFactory }));

// Windows 默认零件里的安装器：只包一层记录「按什么参数创建」，行为仍是真实现（创建它不碰系统：用到时才读文件 / 连管道 / 起 PowerShell）
const installerFactory = vi.hoisted(() => vi.fn());
vi.mock("../electron-app/desktop/win-helper/installer.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../electron-app/desktop/win-helper/installer.mjs")>();
  installerFactory.mockImplementation(actual.createHelperInstaller as never);
  return { ...actual, createHelperInstaller: installerFactory };
});

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const makeElectron = () => {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const electron = {
    BrowserWindow: class {},
    screen: {},
    desktopCapturer: {},
    systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true },
    shell: { openExternal: vi.fn(async () => {}) },
    clipboard: { readText: () => "", writeText: () => {}, availableFormats: () => [] as string[] },
    ipcMain,
  };
  return { electron, handlers, ipcMain };
};

const fakeDriver = (platform: "darwin" | "win32" = "darwin") => ({
  platform,
  init: async () => ({ ok: true as const }),
  diagnostics: () => ({ fake: true }),
  inputPermitted: () => true,
  isScreenLocked: () => false,
  idleSeconds: () => 100,
  getPrimaryDisplay: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  lockScreen: vi.fn(async () => {}),
  listApps: vi.fn(async () => [] as unknown[]),
});

const fakeUnlocker = () => ({
  supported: true,
  hasCredential: vi.fn(async () => true),
  setCredential: vi.fn(async (_s: { password: string }) => {
    void _s;
    return { ok: true };
  }),
  clearCredential: vi.fn(async () => ({ ok: true })),
  unlock: vi.fn(async () => ({ ok: true })),
  lock: vi.fn(async (_opts?: { method?: string }) => {
    void _opts;
    return { ok: true };
  }),
});

const fakeParts = (platform: "darwin" | "win32" = "darwin", withUnlocker = true) => ({
  driver: fakeDriver(platform),
  ...(withUnlocker ? { unlocker: fakeUnlocker() } : {}),
  overlay: { show: vi.fn(), hide: vi.fn(), isShown: () => false },
  screenshotter: { capture: vi.fn(), screenPermission: () => "granted" },
  audit: { write: vi.fn(), prune: vi.fn(async () => {}), flush: vi.fn(), dir: "/fake/audit" },
  // 冷却落盘的假实现：不注入的话默认零件会往 `${userDataDir}/desktop-state` 写文件（这里的 userDataDir 很多是 "/fake"）
  cooldownStore: { load: vi.fn(() => 0), save: vi.fn() },
});

/** Windows 解锁组件的假零件：安装器 probe 的结果由测试决定，管道客户端的请求被记录下来 */
const fakeHelperClient = () => ({
  request: vi.fn(async (...args: unknown[]) => {
    void args;
    return { ok: true, code: "OK", fields: {} as Record<string, string> };
  }),
  status: vi.fn(async () => ({ ok: true, code: "OK", fields: {} as Record<string, string> })),
});
const NOT_INSTALLED_HELPER = { installed: false, canInstall: true, running: false, exeExists: false };
const READY_HELPER = { installed: true, canInstall: true, running: true, exeExists: true, version: 1, hasCredential: true, cooldownSeconds: 0 };
const fakeHelperInstaller = (probe: Record<string, unknown> = NOT_INSTALLED_HELPER) => ({
  probe: vi.fn(async () => probe),
  status: vi.fn(async () => ({ installed: probe.installed === true, canInstall: probe.canInstall === true })),
  install: vi.fn(async () => ({ ok: true })),
  uninstall: vi.fn(async () => ({ ok: true })),
});

const tmpDirs: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-desktop-index-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ALL_CHANNELS = Object.values(COMPUTER_USE_CHANNELS);
/** 通道常量的键和桥方法名只有一个例外：getStatus ↔ status（其余同名） */
const channelOf = (method: string): string => {
  const channel = (COMPUTER_USE_CHANNELS as Record<string, string>)[method === "getStatus" ? "status" : method];
  if (!channel) throw new Error(`COMPUTER_USE_CHANNELS 里没有 ${method} 的通道`);
  return channel;
};
const TRUSTED = { senderFrame: { url: "http://127.0.0.1:8776/settings" } };
const ROGUE = { senderFrame: { url: "https://evil.example/" } };

const make = (over: Record<string, unknown> = {}) => {
  const { electron, handlers, ipcMain } = makeElectron();
  const trusted = vi.fn((event: { senderFrame?: { url?: string } }, _channel: string) => {
    void _channel;
    return event?.senderFrame?.url?.startsWith("http://127.0.0.1:8776/") === true;
  });
  const parts = fakeParts();
  const desktop = createDesktop({
    platform: "darwin",
    electron,
    userDataDir: "/fake/userData",
    isTrustedIpcSender: trusted as never,
    parts,
    ...over,
  } as never);
  return { desktop, handlers, ipcMain, trusted, parts, electron };
};

describe("组装", () => {
  it("macOS：创建 manager，能力 desktop.v1；审计目录在 userData/desktop-audit（不进 logs/）；启动时清理旧审计", () => {
    const userData = mkTmp();
    const { electron } = makeElectron();
    const parts = { ...fakeParts(), audit: undefined };
    const desktop = createDesktop({
      platform: "darwin",
      electron,
      userDataDir: userData,
      isTrustedIpcSender: () => true,
      parts,
    } as never);
    expect(desktop.manager?.capabilities()).toEqual(["desktop.v1"]);
    expect(desktop.audit?.dir).toBe(path.join(userData, "desktop-audit"));
  });

  it("注入的审计零件在创建时被清理一次", () => {
    const { parts } = make();
    expect(parts.audit.prune).toHaveBeenCalledTimes(1);
  });

  it("Windows：没注入解锁器时接的是真的解锁组件——支持这条路线，但组件没装就还没就绪，状态里带着安装入口要的信息", async () => {
    const helperInstaller = fakeHelperInstaller();
    const parts = { ...fakeParts("win32", false), helperClient: fakeHelperClient(), helperInstaller };
    const { electron } = makeElectron();
    const desktop = createDesktop({ platform: "win32", electron, userDataDir: "/fake", isTrustedIpcSender: () => true, parts } as never);
    const st = await desktop.manager!.getStatus();
    expect(st).toMatchObject({
      platform: "win32",
      supported: true,
      unlockSupported: true,
      unlockReady: false,
      unlockHelper: { installed: false, canInstall: true },
      lockedAccessSupported: true,
      lockedAccessReady: false,
      credentialSet: false,
    });
    expect(st.permissions).toEqual({ accessibility: "granted", screen: "granted" });
    expect(helperInstaller.probe).toHaveBeenCalled();
    // 用户还没打开「锁屏时也能用」：不打扰，没有提示
    expect(st.lockedAccessNote).toBeUndefined();
  });

  it("Windows：打开「锁屏时也能用」但组件没装：状态里明说还没装（设置页据此引导去安装）", async () => {
    const parts = { ...fakeParts("win32", false), helperClient: fakeHelperClient(), helperInstaller: fakeHelperInstaller() };
    const { electron } = makeElectron();
    const desktop = createDesktop({ platform: "win32", electron, userDataDir: "/fake", isTrustedIpcSender: () => true, parts } as never);
    desktop.manager!.onConfig({ desktopEnabled: true, desktopLockedAccess: true });
    const st = await desktop.manager!.getStatus();
    expect(st).toMatchObject({ lockedAccessEnabled: true, lockedAccessReady: false, lockedAccessNote: "还没有安装解锁组件", unlockReady: false });
  });

  it("Windows：组件装好且保存过开机密码 → 解锁路线就绪，没有任何提示", async () => {
    const parts = { ...fakeParts("win32", false), helperClient: fakeHelperClient(), helperInstaller: fakeHelperInstaller(READY_HELPER) };
    const { electron } = makeElectron();
    const desktop = createDesktop({ platform: "win32", electron, userDataDir: "/fake", isTrustedIpcSender: () => true, parts } as never);
    desktop.manager!.onConfig({ desktopEnabled: true, desktopLockedAccess: true });
    const st = await desktop.manager!.getStatus();
    expect(st).toMatchObject({ unlockReady: true, credentialSet: true, unlockHelper: { installed: true }, lockedAccessReady: true });
    expect(st.unlockNote).toBeUndefined();
  });

  it("没有桌面驱动的平台：manager 为 null，不去构造任何真实零件", () => {
    const { electron } = makeElectron();
    const desktop = createDesktop({ platform: "linux", electron, userDataDir: "/fake", isTrustedIpcSender: () => true } as never);
    expect(desktop.manager).toBeNull();
    expect(desktop.audit).toBeNull();
  });

  describe("自动解锁冷却落盘（第二轮评审 P1-1）：重启不清零", () => {
    const makeDesktop = (userData: string, parts: Record<string, unknown>) => {
      const { electron } = makeElectron();
      const desktop = createDesktop({ platform: "darwin", electron, userDataDir: userData, isTrustedIpcSender: () => true, parts } as never);
      desktop.manager!.onConfig({ desktopEnabled: true, desktopLockedAccess: true });
      return desktop;
    };

    it("冷却文件在 userData/desktop-state 下，不进 logs/", () => {
      expect(cooldownFilePath("/u/data")).toBe(path.join("/u/data", "desktop-state", "unlock-cooldown.json"));
      expect(cooldownFilePath("/u/data")).not.toContain(`${path.sep}logs${path.sep}`);
    });

    it("默认零件接真文件：上次输错的冷却还没到期，新启动的实例设置页状态里就是「暂停自动解锁」；重新保存开机密码把记录清成 0", async () => {
      const userData = mkTmp();
      createCooldownStore({ file: cooldownFilePath(userData) }).save(Date.now() + 5 * 60_000);
      const { cooldownStore: _unused, ...rest } = fakeParts();
      void _unused;
      const desktop = makeDesktop(userData, rest);

      // macOS 没有后台档：冷却直接体现在「锁屏时也能用」的就绪说明里
      const st = await desktop.manager!.getStatus();
      expect(st.lockedAccessNote).toMatch(/刚刚自动解锁失败过/);
      expect(st.lockedAccessReady).toBe(false);

      expect((await desktop.manager!.setCredential({ password: "pw" })).ok).toBe(true);
      expect(createCooldownStore({ file: cooldownFilePath(userData) }).load()).toBe(0);
      const after = await desktop.manager!.getStatus();
      expect(after.lockedAccessNote).toBeUndefined();
      expect(after.lockedAccessReady).toBe(true);
    });

    it("默认零件：没有冷却文件（第一次启动）= 没有冷却", async () => {
      const userData = mkTmp();
      const { cooldownStore: _unused, ...rest } = fakeParts();
      void _unused;
      const desktop = makeDesktop(userData, rest);
      const st = await desktop.manager!.getStatus();
      expect(st.lockedAccessNote).toBeUndefined();
      expect(st.lockedAccessReady).toBe(true);
      expect(fs.existsSync(cooldownFilePath(userData))).toBe(false); // 读取不会顺手建文件
    });

    it("注入的 cooldownStore 零件原样交给会话：启动时读一次", () => {
      const parts = fakeParts();
      makeDesktop("/fake", parts as never);
      expect(parts.cooldownStore.load).toHaveBeenCalledTimes(1);
    });
  });

  describe("前台会话期间防显示器睡眠（powerSaveBlocker 接线）", () => {
    const fakeBlocker = () => ({ start: vi.fn(() => 42), stop: vi.fn(() => {}), isStarted: vi.fn(() => true) });
    const makeWithBlocker = (blocker: ReturnType<typeof fakeBlocker> | undefined, parts: Record<string, unknown> = fakeParts()) => {
      const { electron } = makeElectron();
      const desktop = createDesktop({
        platform: "darwin",
        electron: { ...electron, ...(blocker ? { powerSaveBlocker: blocker } : {}) },
        userDataDir: "/fake",
        isTrustedIpcSender: () => true,
        parts,
      } as never);
      desktop.manager!.onConfig({ desktopEnabled: true });
      return desktop;
    };

    it("会话开始时 start('prevent-display-sleep')，desktop_end_session 时 stop 同一个 id", async () => {
      const blocker = fakeBlocker();
      const desktop = makeWithBlocker(blocker);
      expect(blocker.start).not.toHaveBeenCalled(); // 创建实例不防睡眠，只有真的开了会话才防
      await desktop.manager!.handleOp("desktop_apps", {}, { taskId: "t1" });
      expect(blocker.start).toHaveBeenCalledTimes(1);
      expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
      expect(blocker.stop).not.toHaveBeenCalled();
      await desktop.manager!.handleOp("desktop_end_session", {}, { taskId: "t1" });
      expect(blocker.stop).toHaveBeenCalledTimes(1);
      expect(blocker.stop).toHaveBeenCalledWith(42);
    });

    it("应用退出（destroy）时释放；之后不会重复释放", async () => {
      const blocker = fakeBlocker();
      const desktop = makeWithBlocker(blocker);
      await desktop.manager!.handleOp("desktop_apps", {}, { taskId: "t1" });
      desktop.destroy();
      expect(blocker.stop).toHaveBeenCalledTimes(1);
      expect(blocker.stop).toHaveBeenCalledWith(42);
    });

    it("总开关被关（会话被结束）时释放", async () => {
      const blocker = fakeBlocker();
      const desktop = makeWithBlocker(blocker);
      await desktop.manager!.handleOp("desktop_apps", {}, { taskId: "t1" });
      desktop.manager!.onConfig({ desktopEnabled: false });
      await vi.waitFor(() => expect(blocker.stop).toHaveBeenCalledWith(42));
      expect(blocker.stop).toHaveBeenCalledTimes(1);
    });

    it("没有 powerSaveBlocker（旧 Electron / 单测）：会话照常，不报错", async () => {
      const desktop = makeWithBlocker(undefined);
      await expect(desktop.manager!.handleOp("desktop_apps", {}, { taskId: "t1" })).resolves.toMatchObject({ ok: true });
    });

    it("注入的 keepAwake 零件优先于 powerSaveBlocker", async () => {
      const blocker = fakeBlocker();
      const release = vi.fn();
      const keepAwake = { acquire: vi.fn(() => release) };
      const desktop = makeWithBlocker(blocker, { ...fakeParts(), keepAwake });
      await desktop.manager!.handleOp("desktop_apps", {}, { taskId: "t1" });
      expect(keepAwake.acquire).toHaveBeenCalledTimes(1);
      expect(blocker.start).not.toHaveBeenCalled();
      await desktop.manager!.handleOp("desktop_end_session", {}, { taskId: "t1" });
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("main.js 把 powerSaveBlocker 交给 createDesktop（接线没丢）", () => {
      const main = readSource("electron-app/main.js"); // 剥注释：注释里照抄的 createDesktop({ … powerSaveBlocker }) 不算接线
      const call = main.slice(main.indexOf("desktop = createDesktop({"));
      expect(call.slice(0, 900)).toMatch(/electron:\s*\{[^}]*\bpowerSaveBlocker\b[^}]*\}/);
    });
  });

  describe("makeKeepDisplayAwake", () => {
    it("没有 powerSaveBlocker / 缺 start 或 stop：返回 null（会话就不防睡眠）", () => {
      expect(makeKeepDisplayAwake(undefined)).toBeNull();
      expect(makeKeepDisplayAwake(null)).toBeNull();
      expect(makeKeepDisplayAwake({ start: () => 1 } as never)).toBeNull();
      expect(makeKeepDisplayAwake({ stop: () => {} } as never)).toBeNull();
    });

    it("每次 acquire 各开一个 blocker；释放函数幂等（重复调用只 stop 一次）", () => {
      let next = 10;
      const blocker = { start: vi.fn(() => next++), stop: vi.fn() };
      const awake = makeKeepDisplayAwake(blocker)!;
      const r1 = awake.acquire();
      const r2 = awake.acquire();
      expect(blocker.start).toHaveBeenNthCalledWith(1, "prevent-display-sleep");
      r1();
      r1();
      expect(blocker.stop).toHaveBeenCalledTimes(1);
      expect(blocker.stop).toHaveBeenCalledWith(10);
      r2();
      expect(blocker.stop).toHaveBeenCalledWith(11);
    });

    it("start 抛错：记日志、返回空释放函数（不抛、不 stop）；stop 抛错：记日志、不抛", () => {
      const logs: string[] = [];
      const badStart = { start: vi.fn(() => { throw new Error("系统不让"); }), stop: vi.fn() };
      const release = makeKeepDisplayAwake(badStart, (m) => logs.push(m))!.acquire();
      expect(() => release()).not.toThrow();
      expect(badStart.stop).not.toHaveBeenCalled();
      expect(logs.join("\n")).toContain("防显示器睡眠开启失败");

      const badStop = { start: vi.fn(() => 1), stop: vi.fn(() => { throw new Error("放不掉"); }) };
      const release2 = makeKeepDisplayAwake(badStop, (m) => logs.push(m))!.acquire();
      expect(() => release2()).not.toThrow();
      expect(logs.join("\n")).toContain("防显示器睡眠解除失败");
    });
  });

  it("钥匙串条目名：ASCII；测试实例与正式实例分开，互不覆盖", () => {
    const prod = keychainNames(false);
    const test = keychainNames(true);
    expect(prod.service).toMatch(/^[\x20-\x7e]+$/);
    expect(prod.account).toMatch(/^[\x20-\x7e]+$/);
    expect(test.service).not.toBe(prod.service);
    expect(test.account).toBe(prod.account);
  });

  it("专用钥匙串文件：在 userData 下自己的 desktop-keychain 文件夹里（不进 logs/——那里会整个发给开发者）", () => {
    expect(keychainFilePath("/u/data")).toBe(path.join("/u/data", "desktop-keychain", "unlock.keychain-db"));
    expect(keychainFilePath("/u/data")).not.toContain(`${path.sep}logs${path.sep}`);
  });

  it("macOS 默认零件：钥匙串按「条目名 + userData 下的专用文件」创建；test 实例与正式实例各用各的", () => {
    for (const isTest of [false, true]) {
      keychainFactory.mockClear();
      const userData = mkTmp();
      const { electron } = makeElectron();
      const { unlocker: _unlocker, ...parts } = fakeParts();
      void _unlocker;
      createDesktop({ platform: "darwin", electron, userDataDir: userData, isTest, isTrustedIpcSender: () => true, parts } as never);
      expect(keychainFactory).toHaveBeenCalledTimes(1);
      expect(keychainFactory.mock.calls[0][0]).toMatchObject({ ...keychainNames(isTest), path: path.join(userData, "desktop-keychain", "unlock.keychain-db") });
    }
  });

  it("注入了钥匙串 / 解锁器零件时不再创建真钥匙串；Windows 不创建（没有钥匙串）", () => {
    keychainFactory.mockClear();
    const { electron } = makeElectron();
    const { unlocker: _unlocker, ...rest } = fakeParts();
    void _unlocker;
    const injectedKeychain = { available: () => true, unavailableReason: () => null, has: () => false, set: () => ({ ok: true }), get: () => null, remove: () => true };
    createDesktop({ platform: "darwin", electron, userDataDir: "/fake", isTrustedIpcSender: () => true, parts: { ...rest, keychain: injectedKeychain } } as never);
    createDesktop({ platform: "darwin", electron, userDataDir: "/fake", isTrustedIpcSender: () => true, parts: fakeParts() } as never);
    createDesktop({ platform: "win32", electron, userDataDir: "/fake", isTrustedIpcSender: () => true, parts: fakeParts("win32", false) } as never);
    expect(keychainFactory).not.toHaveBeenCalled();
  });
});

describe("设置页 IPC", () => {
  it("注册全部通道；重复调用 registerIpc 不重复注册", () => {
    const { desktop, handlers, ipcMain } = make();
    desktop.registerIpc();
    desktop.registerIpc();
    expect([...handlers.keys()].sort()).toEqual([...ALL_CHANNELS].sort());
    expect(ipcMain.handle).toHaveBeenCalledTimes(ALL_CHANNELS.length);
  });

  it("发送方不是本应用页面：每个通道都拒绝，且 manager 的任何方法都不会被调用", async () => {
    const { desktop, handlers, trusted } = make();
    const m = desktop.manager!;
    const spies = [
      vi.spyOn(m, "getStatus"),
      vi.spyOn(m, "requestPermission"),
      vi.spyOn(m, "openSettings"),
      vi.spyOn(m, "setCredential"),
      vi.spyOn(m, "clearCredential"),
      vi.spyOn(m, "testLockedAccess"),
      vi.spyOn(m, "testBackground"),
      vi.spyOn(m, "installUnlockHelper"),
      vi.spyOn(m, "uninstallUnlockHelper"),
      vi.spyOn(m, "exportDiagnostics"),
    ];
    desktop.registerIpc();
    for (const ch of ALL_CHANNELS) {
      await expect(Promise.resolve(handlers.get(ch)!(ROGUE, "screen"))).rejects.toThrow("untrusted ipc sender");
      expect(trusted).toHaveBeenLastCalledWith(ROGUE, ch);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("可信发送方：参数原样交给 manager（密码只经 setCredential 单向交出）", async () => {
    const { desktop, handlers } = make();
    const m = desktop.manager!;
    const set = vi.spyOn(m, "setCredential").mockResolvedValue({ ok: true });
    const req = vi.spyOn(m, "requestPermission").mockResolvedValue({} as never);
    const open = vi.spyOn(m, "openSettings").mockResolvedValue(undefined);
    const clear = vi.spyOn(m, "clearCredential").mockResolvedValue({ ok: true });
    desktop.registerIpc();
    await handlers.get(COMPUTER_USE_CHANNELS.setCredential)!(TRUSTED, { password: "pw" });
    await handlers.get(COMPUTER_USE_CHANNELS.requestPermission)!(TRUSTED, "accessibility");
    await handlers.get(COMPUTER_USE_CHANNELS.openSettings)!(TRUSTED, "screen");
    await handlers.get(COMPUTER_USE_CHANNELS.clearCredential)!(TRUSTED);
    expect(set).toHaveBeenCalledWith({ password: "pw" });
    expect(req).toHaveBeenCalledWith("accessibility");
    expect(open).toHaveBeenCalledWith("screen");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("可信发送方：测试后台操作 / 安装 / 卸载解锁组件原样转给 manager", async () => {
    const { desktop, handlers } = make();
    const m = desktop.manager!;
    const bg = vi.spyOn(m, "testBackground").mockResolvedValue({ ok: true, steps: [] });
    const install = vi.spyOn(m, "installUnlockHelper").mockResolvedValue({ ok: true });
    const uninstall = vi.spyOn(m, "uninstallUnlockHelper").mockResolvedValue({ ok: true });
    desktop.registerIpc();
    expect(await handlers.get(COMPUTER_USE_CHANNELS.testBackground)!(TRUSTED)).toEqual({ ok: true, steps: [] });
    expect(await handlers.get(COMPUTER_USE_CHANNELS.installUnlockHelper)!(TRUSTED)).toEqual({ ok: true });
    expect(await handlers.get(COMPUTER_USE_CHANNELS.uninstallUnlockHelper)!(TRUSTED)).toEqual({ ok: true });
    expect(bg).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it("契约里的每个方法逐个对账：它的通道恰好调到 manager 里同名的方法（参数原样转交、返回值原样带回），别的方法一个都不碰；没有参数的方法收不到多余的参数", async () => {
    // 方法清单从契约（types.mjs）里读，不在这里再抄一份——上面两条各自只管几个方法，
    // 安装 / 卸载、测试锁屏 / 测试后台这类「长得像」的方法，通道串了它们照样绿（每个都恰好被调一次、返回值又一样）
    const contract = contractBridgeMethods();
    expect(contract.length).toBeGreaterThanOrEqual(10);
    for (const method of contract) {
      const { desktop, handlers } = make();
      const manager = desktop.manager as unknown as Record<string, (...args: unknown[]) => unknown>;
      // 每个方法返回一个独一无二的值：通道串了，返回值就对不上
      const spies = new Map(
        contract.map(({ name }) => [name, vi.spyOn(manager, name).mockResolvedValue({ from: name } as never)] as const),
      );
      desktop.registerIpc();
      const args = method.params.map((param) => `${method.name}:${param}`);
      // 没有参数的方法再塞一个多余的参数：渲染端多传的东西不能被转给 manager
      const sent = args.length > 0 ? args : ["stray"];
      expect(await handlers.get(channelOf(method.name))!(TRUSTED, ...sent), `${method.name} 的返回值`).toEqual({ from: method.name });
      expect(spies.get(method.name), method.name).toHaveBeenCalledExactlyOnceWith(...args);
      for (const [other, spy] of spies) {
        if (other !== method.name) expect(spy, `${method.name} 的通道不该碰 ${other}`).not.toHaveBeenCalled();
      }
    }
  });

  it("status 返回 manager 的真实状态", async () => {
    const { desktop, handlers } = make();
    desktop.registerIpc();
    const st = (await handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)) as Record<string, unknown>;
    expect(st).toMatchObject({ platform: "darwin", supported: true, driverReady: true, enabled: false });
  });

  it("没有桌面驱动的平台：status 回静态 supported:false；其它通道明确 reject", async () => {
    const { electron, handlers } = makeElectron();
    const desktop = createDesktop({ platform: "linux", electron, userDataDir: "/fake", isTrustedIpcSender: () => true } as never);
    desktop.registerIpc();
    expect(await handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)).toEqual(unsupportedStatus());
    expect(unsupportedStatus()).toMatchObject({ supported: false, lockedAccessSupported: false, enabled: false });
    for (const ch of ALL_CHANNELS.filter((c) => c !== COMPUTER_USE_CHANNELS.status)) {
      await expect(Promise.resolve(handlers.get(ch)!(TRUSTED, "screen"))).rejects.toThrow("暂不支持");
    }
  });

  it("destroy：manager 收尾、全部 IPC 处理器摘掉，可重复调用；之后可重新注册", () => {
    const { desktop, handlers, ipcMain } = make();
    const destroy = vi.spyOn(desktop.manager!, "destroy");
    desktop.registerIpc();
    desktop.destroy();
    desktop.destroy();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(ALL_CHANNELS.length);
    desktop.registerIpc();
    expect(handlers.size).toBe(ALL_CHANNELS.length);
  });

  it("manager.destroy 抛错也不影响摘 IPC", () => {
    const { desktop, handlers } = make();
    vi.spyOn(desktop.manager!, "destroy").mockImplementation(() => {
      throw new Error("boom");
    });
    desktop.registerIpc();
    expect(() => desktop.destroy()).not.toThrow();
    expect(handlers.size).toBe(0);
  });
});

describe("装配失败：有驱动的平台上零件创建时抛错（别让设置页永远拿不到状态）", () => {
  // 审计零件创建时抛错（比如 userData 目录建不出来）：prune 在装配里同步调用，抛出去就是装配失败
  const BOOM = "磁盘只读：/Users/someone/Library/desktop-audit";
  const failing = (platform: "darwin" | "win32" = "darwin") => ({
    ...fakeParts(platform, platform === "darwin"),
    audit: {
      write: vi.fn(),
      // 堆栈在 Error.stack 里（含本文件的栈帧），message 只有原因——和真实的抛错一样
      prune: vi.fn(() => {
        throw new Error(BOOM);
      }),
      flush: vi.fn(),
      dir: "/fake/audit",
    },
  });

  it("createDesktop 不抛：manager / audit 为 null，原因（含堆栈）只写日志", () => {
    const log = vi.fn();
    expect(() => make({ parts: failing(), log })).not.toThrow();
    const { desktop } = make({ parts: failing(), log });
    expect(desktop.manager).toBeNull();
    expect(desktop.audit).toBeNull();
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("装配失败");
    expect(logged).toContain(BOOM);
    expect(logged).toContain("desktop-index.test.ts"); // 栈帧只进日志
  });

  it("设置页 IPC 照常注册；status 回带原因的「整张卡不可用」快照，不是「当前系统暂不支持」，也不是 reject", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const { desktop, handlers } = make({ platform, parts: failing(platform) });
      desktop.registerIpc();
      expect([...handlers.keys()].sort()).toEqual([...ALL_CHANNELS].sort());
      const st = (await handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)) as Record<string, unknown>;
      expect(st).toMatchObject({
        platform,
        supported: false,
        driverReady: false,
        lockedAccessSupported: false,
        enabled: false,
        session: { active: false, unlockedByUs: false },
      });
      expect(st).toEqual(initFailedStatus(platform, String(st.driverError)));
      // 原因：说明是装配失败 + 具体原因 + 指路；没有堆栈；锁屏区块的说明与它一致
      const reason = String(st.driverError);
      expect(reason).toContain("没能初始化");
      expect(reason).toContain(BOOM);
      expect(reason).toContain("重启");
      expect(reason).not.toContain("desktop-index.test.ts"); // 堆栈不给用户看
      expect(reason).not.toContain("\n");
      expect(reason).not.toContain("暂不支持");
      expect(st.lockedAccessNote).toBe(reason);
    }
  });

  it("其它通道明确 reject，并带同一句原因（不是「暂不支持」）；发送方校验照常。唯一的例外是「清除开机密码」（下面单独钉）", async () => {
    const { desktop, handlers } = make({ parts: failing() });
    desktop.registerIpc();
    const reason = String(((await handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)) as { driverError: string }).driverError);
    for (const ch of ALL_CHANNELS.filter((c) => c !== COMPUTER_USE_CHANNELS.status && c !== COMPUTER_USE_CHANNELS.clearCredential)) {
      const rejected = await Promise.resolve(handlers.get(ch)!(TRUSTED, "screen")).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(rejected, ch).toBe(reason);
    }
    for (const ch of ALL_CHANNELS) {
      await expect(Promise.resolve(handlers.get(ch)!(ROGUE, "screen")), ch).rejects.toThrow("untrusted ipc sender");
    }
  });

  // 第三轮评审：装配失败时 clearCredential 直接 reject，装配失败的机器上只能等功能恢复才清得掉那份能自动解锁电脑的密码。
  // 清除只用钥匙串 / 解锁组件客户端、不碰驱动，驱动装配失败不该挡住它
  describe("装配失败时仍能清除已保存的开机密码（只用钥匙串 / 解锁组件，不碰驱动）", () => {
    const registered = (over: Record<string, unknown>) => {
      const log = vi.fn();
      const made = make({ log, ...over });
      made.desktop.registerIpc();
      expect(made.desktop.manager).toBeNull(); // 对照：这确实是装配失败的状态
      return { ...made, log, clear: () => Promise.resolve(made.handlers.get(COMPUTER_USE_CHANNELS.clearCredential)!(TRUSTED)) };
    };

    /** macOS 装配失败（审计零件创建抛错，和既有用例同形）、没注入解锁器：真的钥匙串解锁器接一个假钥匙串 */
    const darwinFailing = (remove: () => boolean) => ({
      ...fakeParts("darwin", false),
      keychain: { available: () => true, unavailableReason: () => null, has: () => true, set: () => ({ ok: true }), get: () => null, remove },
      audit: { write: vi.fn(), prune: vi.fn(() => { throw new Error("磁盘只读"); }), flush: vi.fn(), dir: "/fake/audit" },
    });

    it("macOS：装配失败 → 清除走真的钥匙串解锁器（keychain.remove 被调用，驱动一个方法都没碰），返回 { ok: true }，不 reject", async () => {
      const remove = vi.fn(() => true);
      const parts = darwinFailing(remove);
      const { clear, log } = registered({ parts });
      expect(await clear()).toEqual({ ok: true });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("已清除保存的开机密码");
      // 降级路径传给解锁器的是空壳驱动：装配失败的常常就是驱动，清除绝不能依赖它
      expect(parts.driver.lockScreen).not.toHaveBeenCalled();
      expect(parts.driver.listApps).not.toHaveBeenCalled();
    });

    it("macOS：钥匙串删不掉 → 如实返回 { ok: false, error }（不抛、不假装清掉了），错误是解锁器给的那句", async () => {
      const { clear, log } = registered({ parts: darwinFailing(() => false) });
      const r = (await clear()) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error).toContain("没能删掉保存开机密码的钥匙串文件");
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("清除开机密码没成功");
    });

    it("钥匙串删除时抛错：折成 { ok: false, error: 带原因 }（不 reject、折成一行、限长），不假装清掉了", async () => {
      const throwing = darwinFailing(() => {
        throw new Error("钥匙串\n被锁定了");
      });
      const r = (await registered({ parts: throwing }).clear()) as { ok: boolean; error?: string };
      expect(r).toEqual({ ok: false, error: "没能清除保存的开机密码（钥匙串 被锁定了）" });
    });

    it("注入的解锁器（测试 / 将来的平台）也走它自己的 clearCredential；它抛错 → 折成 { ok: false, error: 带原因 }，不 reject", async () => {
      const failingParts = failing();
      const ok = registered({ parts: failingParts });
      expect(await ok.clear()).toEqual({ ok: true });
      expect((failingParts as unknown as { unlocker: { clearCredential: ReturnType<typeof vi.fn> } }).unlocker.clearCredential).toHaveBeenCalledTimes(1);

      const boomParts = failing();
      (boomParts as unknown as { unlocker: { clearCredential: ReturnType<typeof vi.fn> } }).unlocker.clearCredential.mockRejectedValueOnce(new Error("钥匙串\n炸了"));
      const boom = registered({ parts: boomParts });
      expect(await boom.clear()).toEqual({ ok: false, error: "没能清除保存的开机密码（钥匙串 炸了）" });
    });

    it("Windows：驱动装配失败 → 清除走解锁组件（装了组件才有东西可清）；组件没装 = 本来就没存过，算成功，不发请求", async () => {
      const helperClient = fakeHelperClient();
      const { clear } = registered({
        platform: "win32",
        parts: { ...failing("win32"), helperClient, helperInstaller: fakeHelperInstaller(NOT_INSTALLED_HELPER) },
      });
      expect(await clear()).toEqual({ ok: true });
      expect(helperClient.request).not.toHaveBeenCalled();

      const client2 = fakeHelperClient();
      const ready = registered({
        platform: "win32",
        parts: { ...failing("win32"), helperClient: client2, helperInstaller: fakeHelperInstaller(READY_HELPER) },
      });
      expect(await ready.clear()).toEqual({ ok: true });
      expect(client2.request).toHaveBeenCalledExactlyOnceWith("clear");
    });

    it("没有桌面驱动的平台（Linux 等）仍是「当前系统暂不支持」的 reject：没有什么可清的，不走降级路径", async () => {
      const { electron, handlers } = makeElectron();
      const desktop = createDesktop({ platform: "linux", electron, userDataDir: "/fake", isTrustedIpcSender: () => true } as never);
      desktop.registerIpc();
      await expect(Promise.resolve(handlers.get(COMPUTER_USE_CHANNELS.clearCredential)!(TRUSTED))).rejects.toThrow("当前系统暂不支持电脑操作");
    });

    it("发送方校验照常：不是本应用页面调的，降级清除也不会执行", async () => {
      const remove = vi.fn(() => true);
      const { handlers } = registered({ parts: darwinFailing(remove) });
      await expect(Promise.resolve(handlers.get(COMPUTER_USE_CHANNELS.clearCredential)!(ROGUE))).rejects.toThrow("untrusted ipc sender");
      expect(remove).not.toHaveBeenCalled();
    });

    it("装配没出问题的平台不走降级路径：清除交给 manager（有审计）", async () => {
      const { desktop, handlers, parts } = make();
      desktop.registerIpc();
      expect(await handlers.get(COMPUTER_USE_CHANNELS.clearCredential)!(TRUSTED)).toEqual({ ok: true });
      expect(parts.unlocker!.clearCredential).toHaveBeenCalledTimes(1);
      expect(parts.audit.write).toHaveBeenCalledWith({ type: "session", kind: "credential_cleared" });
    });
  });

  it("原因整理：多行折成一行、限 120 字；没有 message 也有兜底", async () => {
    const cases: Array<[unknown, (r: string) => void]> = [
      // 空白折叠（换行 / 连续空格 / 制表符 → 一个空格）要落在前 120 字之内才测得到
      [new Error("第一行\n\n  第二行   带空白\t尾"), (r) => expect(r).toContain("（第一行 第二行 带空白 尾）")],
      // 限长：恰好 120 字（5 字 × 24），多一份就不该出现
      [
        new Error("很长的原因".repeat(60)),
        (r) => {
          expect(r).toContain(`（${"很长的原因".repeat(24)}）`);
          expect(r).not.toContain("很长的原因".repeat(25));
        },
      ],
      ["字符串也是原因", (r) => expect(r).toContain("（字符串也是原因）")],
      [new Error(""), (r) => expect(r).toContain("（未知原因）")],
      [undefined, (r) => expect(r).toContain("（未知原因）")],
    ];
    for (const [thrown, check] of cases) {
      const parts = failing();
      parts.audit.prune = vi.fn(() => {
        throw thrown;
      });
      const { desktop, handlers } = make({ parts });
      desktop.registerIpc();
      check(String(((await handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)) as { driverError: string }).driverError));
    }
  });

  it("destroy 不抛、IPC 全部摘掉；没出问题的平台不受影响（initError 为空时 status 仍是 manager 的真实状态）", async () => {
    const { desktop, handlers } = make({ parts: failing() });
    desktop.registerIpc();
    expect(() => desktop.destroy()).not.toThrow();
    expect(handlers.size).toBe(0);

    const ok = make();
    ok.desktop.registerIpc();
    const st = (await ok.handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)) as Record<string, unknown>;
    expect(st).toMatchObject({ supported: true, driverReady: true });
    expect(st.driverError).toBeUndefined();
  });

  it("没有驱动的平台仍是老样子：静态 supported:false，没有 driverError（卡片兜底「当前系统暂不支持」）", async () => {
    const { electron, handlers } = makeElectron();
    const desktop = createDesktop({ platform: "linux", electron, userDataDir: "/fake", isTrustedIpcSender: () => true } as never);
    desktop.registerIpc();
    const st = (await handlers.get(COMPUTER_USE_CHANNELS.status)!(TRUSTED)) as Record<string, unknown>;
    expect(st).toEqual(unsupportedStatus());
    expect(st.driverError).toBeUndefined();
  });
});

describe("本机原生通知（锁不回去时的最后一道提醒）", () => {
  it("makeLocalNotifier：没有 Notification 类 → null；系统不支持 → 不弹；弹出抛错 → 吞掉只记日志", () => {
    expect(makeLocalNotifier(undefined)).toBeNull();
    expect(makeLocalNotifier({} as never)).toBeNull();

    const shown: Array<{ title: string; body: string }> = [];
    class Supported {
      static isSupported() {
        return true;
      }
      constructor(private o: { title: string; body: string }) {}
      show() {
        shown.push(this.o);
      }
    }
    makeLocalNotifier(Supported)!("标题", "正文");
    expect(shown).toEqual([{ title: "标题", body: "正文" }]);

    class Unsupported {
      static isSupported() {
        return false;
      }
      show() {
        shown.push({ title: "不该出现", body: "" });
      }
    }
    makeLocalNotifier(Unsupported)!("标题", "正文");
    expect(shown).toHaveLength(1);

    const logs: string[] = [];
    class Boom {
      show() {
        throw new Error("通知中心不可用");
      }
    }
    expect(() => makeLocalNotifier(Boom, (m: string) => logs.push(m))!("标题", "正文")).not.toThrow();
    expect(logs.join("\n")).toContain("通知中心不可用");
  });

  it("createDesktop 把 electron.Notification 接给 manager：锁不回去时真的弹一条（固定文案，不带任何内容）", async () => {
    const shown: Array<{ title: string; body: string }> = [];
    class FakeNotification {
      static isSupported() {
        return true;
      }
      constructor(private o: { title: string; body: string }) {}
      show() {
        shown.push(this.o);
      }
    }
    const { electron } = makeElectron();
    const parts = fakeParts();
    let locked = true;
    parts.driver.isScreenLocked = () => locked;
    parts.unlocker!.unlock = vi.fn(async () => {
      locked = false;
      return { ok: true };
    });
    parts.unlocker!.lock = vi.fn(async () => ({ ok: false, error: "系统拒绝了锁屏" }));
    parts.screenshotter.capture = vi.fn(async () => ({
      jpeg: Buffer.from("x"),
      frame: { imageWidth: 100, imageHeight: 100, rect: { x: 0, y: 0, width: 100, height: 100 } },
    })) as never;
    const desktop = createDesktop({
      platform: "darwin",
      electron: { ...electron, Notification: FakeNotification },
      userDataDir: "/fake",
      isTrustedIpcSender: () => true,
      parts,
    } as never);
    try {
      const m = desktop.manager!;
      m.onConfig({ desktopEnabled: true, desktopLockedAccess: true });
      await m.handleOp("desktop_screenshot", { allowUnlock: true }, { taskId: "t1" });
      await m.handleOp("desktop_end_session", {}, { taskId: "t1" });
      expect(shown).toHaveLength(1);
      expect(shown[0]?.title).toContain("没能自动锁回去");
      expect(shown[0]?.body).toContain("手动锁屏");
      // 通知里没有原因文案之外的任何内容（不含任务 id / 屏幕内容 / 凭据）
      expect(JSON.stringify(shown)).not.toContain("t1");
    } finally {
      desktop.destroy();
    }
  });

  it("没传 Notification（旧调用方 / 测试）：照常工作，只是不弹", async () => {
    const { desktop } = make();
    expect(desktop.manager).not.toBeNull();
    desktop.destroy();
  });
});

describe("诊断文件", () => {
  it("导出到 userData/logs（会被发给开发者排查，内容不含用户内容 / 凭据）", async () => {
    const userData = mkTmp();
    const { electron } = makeElectron();
    const desktop = createDesktop({
      platform: "darwin",
      electron,
      userDataDir: userData,
      isTrustedIpcSender: () => true,
      appInfo: { name: "FlowshipTest", version: "1.2.3", electron: "42.0.0" },
      parts: fakeParts(),
    } as never);
    const { path: file } = await desktop.manager!.exportDiagnostics();
    expect(path.dirname(file)).toBe(path.join(userData, "logs"));
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(body.app).toEqual({ name: "FlowshipTest", version: "1.2.3", electron: "42.0.0" });
    expect(body.driver).toEqual({ fake: true });
    expect(body.captureMode).toBeNull(); // 注入的假截图器没有截图模式
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

/**
 * 默认截图器的接线：index.mjs 把真遮罩、真截图器交给截图守卫，守卫再交给 manager。
 * 「系统怎么对待遮罩的防截屏设置」由 style 控制（遮罩窗口只要不透明才会影响截图）：
 *   "omitted"：防截屏生效，截图里没有遮罩；
 *   "navy"：   捕获方无视防截屏，遮罩原样出现在截图里（整页深蓝）；
 *   "black"：  macOS 27.2 + Electron 42 实测的样子——整个屏幕被截成一片纯黑（遮罩色占比 0%，只认遮罩色的判断会把它放行，
 *              AI 拿到的全是黑图，真实任务里就因此没能给微信联系人发出消息）。
 */
describe("截图守卫接线", () => {
  // 守卫要看「遮罩出现多久了」（刚出现的一秒内画面不稳定）：只换掉 Date，别的计时器照常；settle() 把时钟往前拨过这一秒
  afterEach(() => {
    vi.useRealTimers();
  });

  type PictureStyle = "omitted" | "navy" | "black";
  const makeCaptureWorld = (style: PictureStyle) => {
    const wins: Array<{ opacity: number; destroyed: boolean }> = [];
    const opacityCalls: string[] = [];
    class Win {
      opacity = 1;
      destroyed = false;
      constructor(_opts: unknown) {
        void _opts;
        wins.push(this);
      }
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      setIgnoreMouseEvents() {}
      setContentProtection() {}
      setOpacity(v: number) {
        this.opacity = v;
        opacityCalls.push(`opacity:${v}`);
      }
      loadURL() {
        return Promise.resolve();
      }
      showInactive() {}
      destroy() {
        this.destroyed = true;
      }
      isDestroyed() {
        return this.destroyed;
      }
    }
    const screen = Object.assign(new EventEmitter(), {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }],
      getPrimaryDisplay: () => ({ id: 1 }),
    });
    const thumbnail = (label: "OVERLAY" | "BLACK" | "DESKTOP") => {
      const bmp = Buffer.alloc(100 * 100 * 4);
      // 遮罩底色 #0b1020 / 纯黑 / 浅灰桌面
      const bgra = label === "OVERLAY" ? [32, 16, 11, 255] : label === "BLACK" ? [0, 0, 0, 255] : [200, 200, 200, 255];
      for (let i = 0; i < bmp.length; i += 4) bgra.forEach((v, k) => (bmp[i + k] = v));
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 100, height: 100 }),
        toBitmap: () => bmp,
        toJPEG: () => Buffer.from(label),
        resize: () => thumbnail(label),
      };
    };
    const desktopCapturer = {
      getSources: vi.fn(async () => {
        const overlayInPicture = style !== "omitted" && wins.some((w) => !w.destroyed && w.opacity > 0);
        return [{ display_id: "1", thumbnail: thumbnail(overlayInPicture ? (style === "black" ? "BLACK" : "OVERLAY") : "DESKTOP") }];
      }),
    };
    return { Win, wins, opacityCalls, screen, desktopCapturer };
  };

  /** 屏幕一开始是锁着的：第一次截图要先自动解锁（解锁成功才会盖遮罩）；会话结束时锁回去，下一次截图又是一轮新的解锁 + 遮罩 */
  const start = (style: PictureStyle, locked: boolean) => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    /** 让遮罩「出现已经超过一秒」：之后的对照结果才算数 */
    const settle = () => {
      vi.advanceTimersByTime(1500);
    };
    const w = makeCaptureWorld(style);
    const { electron } = makeElectron();
    const base = fakeParts();
    let isLocked = locked;
    base.driver.isScreenLocked = () => isLocked;
    base.unlocker!.unlock = vi.fn(async () => {
      isLocked = false;
      return { ok: true };
    });
    base.unlocker!.lock = vi.fn(async () => {
      isLocked = true;
      return { ok: true };
    });
    const userData = mkTmp();
    const desktop = createDesktop({
      platform: "darwin",
      electron: { ...electron, BrowserWindow: w.Win, screen: w.screen, desktopCapturer: w.desktopCapturer },
      userDataDir: userData,
      isTrustedIpcSender: () => true,
      // 不注入 overlay / screenshotter：用 index.mjs 默认组装出来的那套
      parts: { driver: base.driver, unlocker: base.unlocker, audit: base.audit },
    } as never);
    desktop.manager!.onConfig({ desktopEnabled: true, desktopLockedAccess: true });
    const shot = async () => {
      const r = (await desktop.manager!.handleOp("desktop_screenshot", { allowUnlock: true }, { taskId: "t1" })) as { image: { data: string } };
      return Buffer.from(r.image.data, "base64").toString();
    };
    const captureMode = async () => {
      const { path: file } = await desktop.manager!.exportDiagnostics();
      return JSON.parse(fs.readFileSync(file, "utf8")).captureMode as string;
    };
    const endSession = () => desktop.manager!.handleOp("desktop_end_session", {}, { taskId: "t1" });
    return { desktop, w, shot, captureMode, endSession, settle };
  };

  it("遮罩会被系统截进画面：AI 拿到的是撤掉遮罩后的真实屏幕，截完遮罩立刻恢复；之后每次截图都先撤再截；诊断里记着 exposed", async () => {
    const { desktop, w, shot, captureMode } = start("navy", true);
    try {
      expect(await shot()).toBe("DESKTOP"); // 不接守卫的话这里拿到的是 OVERLAY
      expect(w.wins).toHaveLength(1);
      expect(w.wins[0]!.destroyed).toBe(false); // 遮罩还盖着
      expect(w.wins[0]!.opacity).toBe(1); // 而且是不透明的
      expect(w.opacityCalls).toEqual(["opacity:0", "opacity:1"]);

      expect(await shot()).toBe("DESKTOP");
      expect(w.wins[0]!.opacity).toBe(1);
      expect(w.opacityCalls).toEqual(["opacity:0", "opacity:1", "opacity:0", "opacity:1"]);
      expect(await captureMode()).toBe("exposed");
    } finally {
      desktop.destroy();
    }
  });

  it("遮罩被系统截成一片黑（macOS 27 实测）：AI 拿到的是撤掉遮罩后的真实屏幕，不是黑图；截完遮罩立刻恢复；之后每次截图都先撤再截；诊断里记着 exposed", async () => {
    const { desktop, w, shot, captureMode } = start("black", true);
    try {
      expect(await shot()).toBe("DESKTOP"); // 只认遮罩色的守卫在这里拿到的是 BLACK（遮罩色占比 0%，被当成「正常画面」放行）
      expect(w.wins).toHaveLength(1);
      expect(w.wins[0]!.destroyed).toBe(false); // 遮罩还盖着
      expect(w.wins[0]!.opacity).toBe(1); // 而且是不透明的
      expect(w.opacityCalls).toEqual(["opacity:0", "opacity:1"]);

      expect(await shot()).toBe("DESKTOP");
      expect(w.wins[0]!.opacity).toBe(1);
      expect(w.opacityCalls).toEqual(["opacity:0", "opacity:1", "opacity:0", "opacity:1"]);
      expect(await captureMode()).toBe("exposed");
    } finally {
      desktop.destroy();
    }
  });

  it("防截屏生效（遮罩不会被截进画面）：遮罩刚出现时对照出的「一样」不算数；稳定之后再对照一次才记 clear，之后从不撤遮罩", async () => {
    const { desktop, w, shot, captureMode, settle } = start("omitted", true);
    try {
      expect(await shot()).toBe("DESKTOP");
      expect(w.opacityCalls).toEqual(["opacity:0", "opacity:1"]); // 对照了一次，但遮罩才刚出现
      expect(await captureMode()).toBe("unknown");

      settle();
      expect(await shot()).toBe("DESKTOP");
      expect(w.opacityCalls).toHaveLength(4); // 稳定了，再对照一次，这回算数
      expect(await captureMode()).toBe("clear");

      expect(await shot()).toBe("DESKTOP");
      expect(await shot()).toBe("DESKTOP");
      expect(w.wins).toHaveLength(1);
      expect(w.opacityCalls).toHaveLength(4); // 之后没有再撤
    } finally {
      desktop.destroy();
    }
  });

  it("每一轮遮罩（每次自动解锁后的新会话）都重新对照：上一轮的结论不沿用，这一轮第一张截图照样先对照一次", async () => {
    for (const style of ["omitted", "black"] as const) {
      const { desktop, w, shot, endSession, captureMode, settle } = start(style, true);
      try {
        await shot();
        settle();
        await shot();
        expect(w.opacityCalls.length, style).toBe(4);
        expect(await captureMode(), style).toBe(style === "black" ? "exposed" : "clear");
        await endSession(); // 会话结束：遮罩撤掉、屏幕锁回去
        expect(w.wins.every((x) => x.destroyed), style).toBe(true);

        expect(await shot(), style).toBe("DESKTOP"); // 新一轮：再次自动解锁 + 新遮罩，第一张截图照样先对照
        expect(w.wins, style).toHaveLength(2);
        expect(w.opacityCalls.length, style).toBe(6);
        // 防截屏生效的系统上，上一轮的 clear 没有沿用（回到 unknown，等这一轮遮罩稳定了再对照）；一片黑的系统上立刻又是 exposed
        expect(await captureMode(), style).toBe(style === "black" ? "exposed" : "unknown");
        settle();
        expect(await shot(), style).toBe("DESKTOP");
        expect(w.opacityCalls.length, style).toBe(8);
        expect(await captureMode(), style).toBe(style === "black" ? "exposed" : "clear");
      } finally {
        desktop.destroy();
      }
    }
  });

  it("屏幕没锁（用户在电脑前）：没有遮罩，截图直通，也不去撤任何东西；模式还是 unknown", async () => {
    const { desktop, w, shot, captureMode } = start("navy", false);
    try {
      expect(await shot()).toBe("DESKTOP");
      expect(w.wins).toHaveLength(0);
      expect(w.opacityCalls).toEqual([]);
      expect(await captureMode()).toBe("unknown");
    } finally {
      desktop.destroy();
    }
  });
});

describe("preload 桥与通道常量对齐", () => {
  const preload = readSource("electron-app/preload.cjs"); // 剥注释：被注释掉的 invoke / 方法不算桥上有
  const bridge = preload.slice(preload.indexOf('exposeInMainWorld("__computerUse"'));

  it("__computerUse 的每个方法 invoke 的通道恰好是 COMPUTER_USE_CHANNELS 全集（改一边忘另一边会红）", () => {
    expect(bridge.length).toBeGreaterThan(100);
    const used = [...bridge.matchAll(/invoke\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(used).toEqual([...ALL_CHANNELS].sort());
  });

  // 方法清单从契约（types.mjs 的 ComputerUseBridge）里读，不在这里再抄一份：以前这里手抄了 7 个名字，
  // 后加的 testBackground / installUnlockHelper / uninstallUnlockHelper 就没人看着了。
  // 契约、渲染端 TS 类型、preload 三方的「方法名」「参数」「返回值形状」对账见 helpers/computer-use-contract.ts（TS 那份在 computer-use-card.test.ts）
  const contract = contractBridgeMethods();
  const bridgeMethods = preloadBridgeMethods();

  it("契约解析自检：方法数不低于已知的 10 个、名字不重复，后加的三个 Windows 方法在里面（解析悄悄少了方法，下面的对账就空了）", () => {
    const names = contract.map((m) => m.name);
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["testBackground", "installUnlockHelper", "uninstallUnlockHelper"]));
    expect(bridgeMethods.length).toBeGreaterThanOrEqual(10);
  });

  it("桥的方法名与契约完全一致（一个不少、一个不多）；没有任何读回凭据的方法", () => {
    expect(bridgeMethods.map((m) => m.name).sort()).toEqual(contract.map((m) => m.name).sort());
    expect(bridge).not.toMatch(/getCredential|readCredential|getPassword|revealPassword/i);
  });

  it("每个方法的参数名与契约一致，invoke 时把参数原样、按顺序转发给通道（没参数的方法什么都不转发）", () => {
    for (const method of contract) {
      const actual = bridgeMethods.find((m) => m.name === method.name);
      expect(actual, `preload 桥里缺 ${method.name}`).toBeDefined();
      expect(actual?.params, `${method.name} 的参数`).toEqual(method.params);
      expect(actual?.forwarded, `${method.name} 转发给通道的参数`).toEqual(method.params);
    }
  });

  it("每个方法 invoke 的是它自己的通道（COMPUTER_USE_CHANNELS 里同名的那条）：不串到别的方法、没有两个方法共用一条", () => {
    for (const method of bridgeMethods) {
      expect(method.channel, `${method.name} 的通道`).toBe(channelOf(method.name));
    }
    const channels = bridgeMethods.map((m) => m.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

describe("Windows 解锁组件的接线", () => {
  const SECRET = "S3cret-Pass!";

  /** 不注入 unlocker：走 index.mjs 里 win32 分支的默认装配；其余零件仍是假的（真零件会加载 koffi / 创建窗口） */
  const makeWinDesktop = (over: { helperAssetsDir?: string; platform?: "darwin" | "win32"; parts?: Record<string, unknown> } = {}) => {
    const { electron, handlers } = makeElectron();
    const platform = over.platform ?? "win32";
    const { unlocker: _unlocker, ...parts } = fakeParts(platform);
    void _unlocker;
    const desktop = createDesktop({
      platform,
      electron,
      userDataDir: "/fake",
      isTrustedIpcSender: () => true,
      ...(over.helperAssetsDir ? { helperAssetsDir: over.helperAssetsDir } : {}),
      parts: { ...parts, ...(over.parts ?? {}) },
    } as never);
    return { desktop, handlers };
  };
  type InstallerArgs = { assetsDir: string; client: { request: unknown; status: unknown }; spawn: unknown };
  const installerArgs = () => installerFactory.mock.calls.at(-1)?.[0] as InstallerArgs;

  it("main.js 传了资源目录（打包后的 resources/win-helper）：原样交给安装器", () => {
    installerFactory.mockClear();
    makeWinDesktop({ helperAssetsDir: "C:\\Program Files\\Flowship\\resources\\win-helper" });
    expect(installerFactory).toHaveBeenCalledTimes(1);
    expect(installerArgs().assetsDir).toBe("C:\\Program Files\\Flowship\\resources\\win-helper");
  });

  it("没传资源目录（开发期）：用源码树里的 win-helper/assets，里面真有三个资源文件", () => {
    installerFactory.mockClear();
    makeWinDesktop();
    const { assetsDir } = installerArgs();
    expect(assetsDir.split(path.sep).slice(-3)).toEqual(["desktop", "win-helper", "assets"]);
    for (const name of Object.values(ASSET_FILES)) expect(fs.existsSync(path.join(assetsDir, name)), name).toBe(true);
  });

  it("没注入管道客户端：创建真的客户端交给安装器", () => {
    installerFactory.mockClear();
    makeWinDesktop();
    const { client } = installerArgs();
    expect(typeof client.request).toBe("function");
    expect(typeof client.status).toBe("function");
  });

  it("注入了管道客户端：安装器用的就是注入的那一个（和解锁器共用同一个）", () => {
    const helperClient = fakeHelperClient();
    installerFactory.mockClear();
    makeWinDesktop({ parts: { helperClient } });
    expect(installerArgs().client).toBe(helperClient);
  });

  it("parts.spawn 转发给安装器（测试里不会真起 PowerShell）", () => {
    const spawn = vi.fn();
    installerFactory.mockClear();
    makeWinDesktop({ parts: { spawn } });
    expect(installerArgs().spawn).toBe(spawn);
  });

  it("注入了安装器就不再创建真的；macOS 根本不创建安装器", () => {
    installerFactory.mockClear();
    makeWinDesktop({ parts: { helperInstaller: fakeHelperInstaller(), helperClient: fakeHelperClient() } });
    makeWinDesktop({ platform: "darwin" });
    expect(installerFactory).not.toHaveBeenCalled();
  });

  it("设置页保存开机密码：一路走到解锁组件的管道，密码只出现在那一个请求里、不出现在返回值里", async () => {
    const helperClient = fakeHelperClient();
    const { desktop, handlers } = makeWinDesktop({ parts: { helperClient, helperInstaller: fakeHelperInstaller(READY_HELPER) } });
    desktop.registerIpc();
    const r = await handlers.get(COMPUTER_USE_CHANNELS.setCredential)!(TRUSTED, { password: SECRET });
    expect(r).toEqual({ ok: true });
    expect(helperClient.request).toHaveBeenCalledTimes(1);
    expect(helperClient.request).toHaveBeenCalledWith("set", { pw: SECRET });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("没装组件时保存开机密码：直接说要先安装，不去连管道", async () => {
    const helperClient = fakeHelperClient();
    const { desktop, handlers } = makeWinDesktop({ parts: { helperClient, helperInstaller: fakeHelperInstaller() } });
    desktop.registerIpc();
    const r = (await handlers.get(COMPUTER_USE_CHANNELS.setCredential)!(TRUSTED, { password: SECRET })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("安装");
    expect(helperClient.request).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("设置页点「安装」「卸载」：交给安装器", async () => {
    const helperInstaller = fakeHelperInstaller();
    const { desktop, handlers } = makeWinDesktop({ parts: { helperClient: fakeHelperClient(), helperInstaller } });
    desktop.registerIpc();
    expect(await handlers.get(COMPUTER_USE_CHANNELS.installUnlockHelper)!(TRUSTED)).toEqual({ ok: true });
    expect(await handlers.get(COMPUTER_USE_CHANNELS.uninstallUnlockHelper)!(TRUSTED)).toEqual({ ok: true });
    expect(helperInstaller.install).toHaveBeenCalledTimes(1);
    expect(helperInstaller.uninstall).toHaveBeenCalledTimes(1);
  });
});

describe("Windows 锁屏后台档的接线", () => {
  const fakeBackgroundDriver = () => ({
    init: vi.fn(async () => ({ ok: true as const })),
    supported: () => true,
    diagnostics: () => ({ ready: true }),
    reset: vi.fn(),
    mouseMove: vi.fn(),
    click: vi.fn(),
    drag: vi.fn(),
    scroll: vi.fn(),
    keyCombo: vi.fn(async () => ({})),
    typeText: vi.fn(),
    openApp: vi.fn(),
    capture: vi.fn(),
  });

  const makeWin = (opts: { nativeImage?: boolean; background?: unknown; platform?: "darwin" | "win32"; driverBackground?: boolean } = {}) => {
    const { electron, handlers } = makeElectron();
    const platform = opts.platform ?? "win32";
    const driver = { ...fakeDriver(platform), ...(opts.driverBackground === false ? {} : { background: fakeBackgroundDriver() }) };
    const parts = { ...fakeParts(platform), driver, ...(opts.background ? { background: opts.background } : {}) };
    const desktop = createDesktop({
      platform,
      electron: { ...electron, ...(opts.nativeImage === false ? {} : { nativeImage: { createFromBitmap: vi.fn() } }) },
      userDataDir: "/fake",
      isTrustedIpcSender: () => true,
      parts,
    } as never);
    return { desktop, handlers, driver };
  };

  it("Windows：驱动带 background 且有 nativeImage → 启用后台档（状态里 backgroundSupported / backgroundReady）", async () => {
    const { desktop, driver } = makeWin();
    const st = await desktop.manager!.getStatus();
    expect(st).toMatchObject({ platform: "win32", backgroundSupported: true, backgroundReady: true, lockedAccessSupported: true });
    expect(driver.background!.init).toHaveBeenCalledTimes(1);
  });

  it("没有 nativeImage（没法压缩截图）：不启用后台档，锁屏时回退到解锁", async () => {
    const { desktop, driver } = makeWin({ nativeImage: false });
    expect(await desktop.manager!.getStatus()).toMatchObject({ backgroundSupported: false, backgroundReady: false });
    expect(driver.background!.init).not.toHaveBeenCalled();
  });

  it("驱动没有 background（老驱动 / 假驱动）：不启用", async () => {
    const { desktop } = makeWin({ driverBackground: false });
    expect(await desktop.manager!.getStatus()).toMatchObject({ backgroundSupported: false });
  });

  it("macOS 永远没有后台档，哪怕驱动对象上带了 background", async () => {
    const { desktop, driver } = makeWin({ platform: "darwin" });
    expect(await desktop.manager!.getStatus()).toMatchObject({ platform: "darwin", backgroundSupported: false });
    expect(driver.background!.init).not.toHaveBeenCalled();
  });

  it("注入的 background 零件原样使用（测试用）", async () => {
    const injected = { driver: fakeBackgroundDriver(), shotter: { capture: vi.fn() } };
    const { desktop } = makeWin({ background: injected, nativeImage: false });
    expect(await desktop.manager!.getStatus()).toMatchObject({ backgroundSupported: true, backgroundReady: true });
    expect(injected.driver.init).toHaveBeenCalledTimes(1);
  });

  it("「测试后台操作」IPC：真探针 + 注入的 spawn（开不了测试窗口 → 如实失败，不锁屏）", async () => {
    const { electron, handlers } = makeElectron();
    const driver = {
      ...fakeDriver("win32"),
      lockScreen: vi.fn(async () => {}),
      background: {
        ...fakeBackgroundDriver(),
        findWindowsByTitle: vi.fn(() => []),
        reset: vi.fn(),
      },
    };
    const spawn = vi.fn(() => {
      throw new Error("conhost.exe 不存在");
    });
    const desktop = createDesktop({
      platform: "win32",
      electron: { ...electron, nativeImage: { createFromBitmap: vi.fn() } },
      userDataDir: "/fake",
      isTrustedIpcSender: () => true,
      parts: { ...fakeParts("win32"), driver, spawn },
    } as never);
    desktop.manager!.onConfig({ desktopEnabled: true, desktopLockedAccess: true });
    desktop.registerIpc();
    // 把倒计时 / 等窗口的时间压到最短：真探针的 sleep 是真实定时器
    vi.useFakeTimers();
    try {
      const pending = Promise.resolve(handlers.get(COMPUTER_USE_CHANNELS.testBackground)!({ senderFrame: { url: "x" } })) as Promise<{ ok: boolean; error?: string }>;
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await pending;
      expect(r.ok).toBe(false);
      expect(r.error).toContain("没能打开测试窗口");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(driver.lockScreen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
