/**
 * 电脑操作（desktop.v1）的组装入口：按平台挑驱动 / 解锁器，把 electron 的东西接进 manager，并注册设置页用的 IPC。
 *
 * main.js 只做三件事：`createDesktop({...})` 拿到实例 → 把 `desktop.manager` 交给内置浏览器管理器（共用 server 通道）→
 * `desktop.registerIpc()` / 退出时 `desktop.destroy()`。其余全在这里，方便用假 electron 对象单测。
 *
 * 平台：macOS / Windows 有驱动；其它平台 manager 为 null——设置页的 IPC 照常注册，status 回一份 supported:false 的静态快照，
 * 卡片据此显示「当前系统暂不支持」，不会因为 `window.__computerUse` 的调用 reject 而报错。
 * 有驱动的平台上装配失败（创建零件时抛错）同理：manager 为 null、IPC 照常注册，status 回带原因的 supported:false 快照（initFailedStatus），
 * 卡片显示原因；其它通道 reject 并带同一句原因（唯一的例外是「清除开机密码」：它只用钥匙串 / 解锁组件、不需要驱动，装配失败时照样能清，见 clearCredentialDegraded）。
 * **不抛出**——抛出去 main.js 只会写一行日志、拿到 null 就不注册 IPC，卡片永远读不到状态。
 *
 * Windows 额外有「锁屏后台档」（driver.background + background-shot + background-probe）：锁屏时不解锁，直接对已打开的应用窗口操作。
 * 另外有可选的「系统级解锁组件」（win-helper/：安装器 + 命名管道客户端 + unlockers/win32.mjs，默认不装、用户在设置页点安装并授权一次管理员才有）：
 * 锁屏时由它代为输入开机密码解锁。资源（源码 + 安装脚本）开发时在 win-helper/assets/，打包后在 resources/win-helper/（main.js 传 helperAssetsDir）。
 */
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAuditLog } from "./audit.mjs";
import { createBackgroundProbe } from "./background-probe.mjs";
import { createBackgroundShotter } from "./background-shot.mjs";
import { createCaptureGuard } from "./capture-guard.mjs";
import { createCooldownStore } from "./cooldown-store.mjs";
import { createDarwinKeychain } from "./credentials/darwin-keychain.mjs";
import { createDarwinDriver } from "./drivers/darwin.mjs";
import { createWin32Driver } from "./drivers/win32.mjs";
import { createDesktopManager } from "./manager.mjs";
import { createOverlay } from "./overlay.mjs";
import { createPermissionAdapter } from "./permissions.mjs";
import { createScreenshotter } from "./screenshot.mjs";
import { COMPUTER_USE_CHANNELS } from "./types.mjs";
import { createDarwinUnlocker } from "./unlockers/darwin.mjs";
import { createWin32Unlocker } from "./unlockers/win32.mjs";
import { createHelperClient } from "./win-helper/client.mjs";
import { createHelperInstaller } from "./win-helper/installer.mjs";

/** 解锁组件资源（源码 + 安装脚本）的开发期位置；打包后在 asar 里 PowerShell 读不到，main.js 会改传 resources/win-helper */
const DEFAULT_HELPER_ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "win-helper", "assets");

/** 钥匙串里开机密码条目的名字（测试实例单独一份，互不覆盖） */
export const keychainNames = (isTest) => ({
  service: isTest ? "com.flowship.computer-use.unlock.test" : "com.flowship.computer-use.unlock",
  account: "login-password",
});

/**
 * 保存开机密码用的专用钥匙串文件（macOS）：放在 userData 下自己的文件夹里——userData 本来就按正式 / test 实例分开，
 * 不放 logs/（那个文件夹会被整个发给开发者排查问题）。为什么是专用文件而不是登录钥匙串，见 credentials/darwin-keychain.mjs。
 */
export const keychainFilePath = (userDataDir) => path.join(userDataDir, "desktop-keychain", "unlock.keychain-db");

/**
 * 自动解锁冷却截止时刻的落盘文件：只有一个时间戳，不含密码 / 用户内容。同样放 userData 下自己的目录（按正式 / test 实例分开），
 * 不放 logs/（会被整个发给开发者）。见 cooldown-store.mjs。
 */
export const cooldownFilePath = (userDataDir) => path.join(userDataDir, "desktop-state", "unlock-cooldown.json");

/**
 * 本机原生通知：server 通道断了 / 飞书没开时，「电脑没能锁回去」这类安全提醒只能靠它让电脑旁的人看到。
 * 没有 Notification 类、系统不支持、弹出时出错都静默降级（不能因为通知失败影响会话收尾）。
 * @param {any} NotificationClass  electron.Notification（缺省 / 不是函数 → 返回 null）
 * @param {(msg: string) => void} [log]
 * @returns {((title: string, body: string) => void) | null}
 */
export const makeLocalNotifier = (NotificationClass, log = () => {}) => {
  if (typeof NotificationClass !== "function") return null;
  return (title, body) => {
    try {
      if (typeof NotificationClass.isSupported === "function" && !NotificationClass.isSupported()) return;
      new NotificationClass({ title, body }).show();
    } catch (err) {
      log(`[desktop] 本机通知弹出失败：${err?.message || err}`);
    }
  };
};

/**
 * 前台会话期间不让显示器睡眠：睡了会锁屏（会话被 relocked_externally 打断）、之后的截图是黑的。
 * 用 Electron 的 powerSaveBlocker('prevent-display-sleep')；每次 acquire 返回一个幂等的释放函数。
 * 没有 powerSaveBlocker（单测 / 老 Electron）→ null（会话就不防睡眠，行为和以前一样）；start / stop 出错只记日志。
 * @param {{ start: (type: string) => number, stop: (id: number) => void } | null | undefined} powerSaveBlocker
 * @param {(msg: string) => void} [log]
 * @returns {{ acquire: () => () => void } | null}
 */
export const makeKeepDisplayAwake = (powerSaveBlocker, log = () => {}) => {
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== "function" || typeof powerSaveBlocker.stop !== "function") return null;
  return {
    acquire: () => {
      let id;
      try {
        id = powerSaveBlocker.start("prevent-display-sleep");
      } catch (err) {
        log(`[desktop] 防显示器睡眠开启失败：${err?.message || err}`);
        return () => {};
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          powerSaveBlocker.stop(id);
        } catch (err) {
          log(`[desktop] 防显示器睡眠解除失败：${err?.message || err}`);
        }
      };
    },
  };
};

/** 没有桌面驱动的平台给设置页的静态状态 */
export const unsupportedStatus = () => ({
  platform: "other",
  enabled: false,
  lockedAccessEnabled: false,
  supported: false,
  lockedAccessSupported: false,
  driverReady: false,
  permissions: { accessibility: "unknown", screen: "unknown" },
  locked: null,
  credentialSet: false,
  lockedAccessReady: false,
  lockedAccessNote: "当前系统暂不支持电脑操作",
  session: { active: false, unlockedByUs: false },
});

/** 装配失败时给设置页看的一句话（中文）：带上原因，指路重启 / 发日志；不带堆栈（堆栈只进日志） */
const initFailedMessage = (err) => {
  // Error 只取 message（空 message 就是没有信息，不要退回成 "Error" 这个类名）；抛出来的不是 Error（字符串之类）才用它本身
  const raw = typeof err?.message === "string" ? err.message : String(err ?? "");
  const reason = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  return `电脑操作没能初始化（${reason || "未知原因"}）。请重启 Flowship 再试；还不行就把应用日志发给开发者排查`;
};

/**
 * 本平台有电脑操作、但这次启动装配失败（零件创建时抛了错）时设置页拿到的快照：和「没有驱动的平台」一样整张卡不可用
 * （supported:false、总开关禁用），区别是原因写在 driverError 里——卡片优先显示它，而不是「当前系统暂不支持」（系统其实支持）。
 */
export const initFailedStatus = (platform, reason) => ({
  ...unsupportedStatus(),
  platform: platform === "darwin" || platform === "win32" ? platform : "other",
  driverError: reason,
  lockedAccessNote: reason,
});

/**
 * @param {{
 *   platform?: string,
 *   electron: { BrowserWindow: any, screen: any, desktopCapturer: any, systemPreferences: any, shell: any, clipboard: any, ipcMain: any, Notification?: any, nativeImage?: any, powerSaveBlocker?: any },
 *   userDataDir: string,
 *   isTrustedIpcSender: (event: any, channel: string) => boolean,
 *   isTest?: boolean,
 *   appInfo?: { name?: string, version?: string, electron?: string },
 *   log?: (msg: string) => void,
 *   helperAssetsDir?: string,
 *   parts?: Partial<{ driver: any, keychain: any, unlocker: any, overlay: any, screenshotter: any, audit: any, background: any, spawn: any, helperClient: any, helperInstaller: any, cooldownStore: any, keepAwake: any }>,
 * }} deps  helperAssetsDir：Windows 解锁组件资源目录（缺省 = 开发期的 win-helper/assets）；parts：测试用，替换真实零件（真实零件会加载 koffi / 创建窗口）
 */
export const createDesktop = (deps) => {
  const { platform = process.platform, electron, userDataDir, isTrustedIpcSender, isTest = false, appInfo, log = () => {}, parts = {} } = deps;
  const hasDriver = platform === "darwin" || platform === "win32";

  /**
   * 解锁器：测试注入的原样用；否则 macOS = 专用钥匙串 + 键码输入；Windows = 解锁组件（客户端 + 提权安装器）。
   * 创建它不碰系统（用到时才读文件 / 连管道 / 起 PowerShell），也不用到驱动——驱动只在解锁 / 预检那一刻才会被调用，
   * 所以装配失败时（驱动常常正是失败的那一个）可以传一个空壳驱动，只用它的「清除开机密码」（见 clearCredentialDegraded）。
   */
  const buildUnlocker = (driver) => {
    if (parts.unlocker) return parts.unlocker;
    if (platform === "darwin") {
      const keychain = parts.keychain ?? createDarwinKeychain({ ...keychainNames(isTest), path: keychainFilePath(userDataDir), log });
      return createDarwinUnlocker({ driver, keychain });
    }
    // 解锁组件：客户端（管道）+ 安装器（UAC 提权安装 / 卸载）+ 解锁器
    const helperClient = parts.helperClient ?? createHelperClient();
    const helperInstaller =
      parts.helperInstaller ??
      createHelperInstaller({
        assetsDir: deps.helperAssetsDir ?? DEFAULT_HELPER_ASSETS_DIR,
        client: helperClient,
        spawn: parts.spawn ?? nodeSpawn,
        log,
      });
    return createWin32Unlocker({ driver, installer: helperInstaller, client: helperClient });
  };

  /**
   * 创建 manager 与审计日志（创建零件不碰系统）。任何一步抛错都交给调用方接住：电脑操作整体不可用，
   * 但错误不能被带进应用启动，更不能让设置页永远拿不到状态（见下面的 initError）
   */
  const assemble = () => {
    const driver = parts.driver ?? (platform === "darwin" ? createDarwinDriver({ log }) : createWin32Driver({ log }));
    const unlocker = buildUnlocker(driver);
    // 审计日志放在 userData 下单独的目录，不进 logs/（那个文件夹会被整个发给开发者排查问题）
    const audit = parts.audit ?? createAuditLog({ dir: path.join(userDataDir, "desktop-audit"), log });
    void audit.prune?.();
    const overlay = parts.overlay ?? createOverlay({ BrowserWindow: electron.BrowserWindow, screen: electron.screen, platform, log });
    // 锁屏后台档（Windows）：驱动带 background 才有；截图压缩要 nativeImage，缺它就不启用（锁屏时回退到解锁）
    let background = parts.background ?? null;
    if (!background && platform === "win32" && driver.background && electron?.nativeImage) {
      background = {
        driver: driver.background,
        shotter: createBackgroundShotter({ background: driver.background, driver, nativeImage: electron.nativeImage, log }),
        probe: createBackgroundProbe({ driver, background: driver.background, spawn: parts.spawn ?? nodeSpawn, log }),
      };
    }
    const manager = createDesktopManager({
      platform,
      notifyLocal: makeLocalNotifier(electron?.Notification, log),
      driver,
      unlocker,
      overlay,
      // 自动解锁的冷却截止时刻落盘：输错之后重启 / 崩溃 / 自动更新 relaunch 不能把冷却清零（见 cooldown-store.mjs）
      cooldownStore: parts.cooldownStore ?? createCooldownStore({ file: cooldownFilePath(userDataDir) }),
      // 前台会话期间不让显示器睡眠（睡了会锁屏、会话被打断、截图是黑的）；没有 powerSaveBlocker 就不防
      keepAwake: parts.keepAwake !== undefined ? parts.keepAwake : makeKeepDisplayAwake(electron?.powerSaveBlocker, log),
      ...(background ? { background } : {}),
      // 截图过一层守卫：遮罩被系统截进画面时（macOS 上 ScreenCaptureKit 会无视防截屏设置）自动撤遮罩重截，见 capture-guard.mjs。
      // 测试注入的假 screenshotter 原样使用（不套守卫）
      screenshotter:
        parts.screenshotter ??
        createCaptureGuard({
          overlay,
          screenshotter: createScreenshotter({
            desktopCapturer: electron.desktopCapturer,
            screen: electron.screen,
            systemPreferences: electron.systemPreferences,
            driver,
            platform,
            log,
          }),
          log,
        }),
      permissions: createPermissionAdapter({
        platform,
        systemPreferences: electron.systemPreferences,
        shell: electron.shell,
        desktopCapturer: electron.desktopCapturer,
        driver,
        log,
      }),
      clipboard: electron.clipboard,
      audit,
      // 诊断文件要发给开发者排查，放 logs/（里面没有用户内容和凭据）
      userDataDir: path.join(userDataDir, "logs"),
      log,
      appInfo,
    });
    return { manager, audit };
  };

  let manager = null;
  let audit = null;
  /**
   * 本平台支持电脑操作、但这次启动装配失败时的原因（给用户看的中文）；null = 没出问题，或本平台根本没有驱动。
   * 装配失败不能只写日志：main.js 拿到 null 就不会注册设置页的 IPC，卡片永远读不到状态——开关能点、却什么都不工作，也没有任何说明。
   * 所以失败后实例照常返回、IPC 照常注册，status 回带原因的快照（见 initFailedStatus）。
   */
  let initError = null;
  if (hasDriver) {
    try {
      ({ manager, audit } = assemble());
    } catch (err) {
      manager = null;
      audit = null;
      initError = initFailedMessage(err);
      log(`[desktop] 电脑操作装配失败（该功能本次不可用，不影响其它功能）：${err?.stack || err?.message || err}`);
    }
  }

  // ── 设置页 IPC ──

  const offs = [];
  let registered = false;

  const requireManager = () => {
    if (!manager) throw new Error(initError ?? "当前系统暂不支持电脑操作");
    return manager;
  };

  /**
   * 装配失败（常见原因：原生模块加载不了）时的「清除已保存的开机密码」：只用钥匙串 / 解锁组件客户端，不碰驱动。
   * 功能整体不可用时，一份还留着的、能自动解锁电脑的密码没有任何用处，更不该因为功能坏了而删不掉
   * （第三轮评审：以前这里直接 reject，装配失败的机器上只能等功能恢复才清得掉）。
   * 不抛、返回和 manager.clearCredential 同形的 { ok, error? }；不记审计（审计日志本身也是装配的一部分、可能没建起来），只写应用日志。
   * 解锁器也创建不出来（钥匙串零件抛错）时如实说原因，不假装清掉了。
   */
  const clearCredentialDegraded = async () => {
    try {
      const r = await buildUnlocker({}).clearCredential();
      if (r?.ok === true) {
        log("[desktop] 装配失败状态下已清除保存的开机密码");
        return { ok: true };
      }
      const error = typeof r?.error === "string" && r.error.trim() ? r.error : "没能清除保存的开机密码";
      log(`[desktop] 装配失败状态下清除开机密码没成功：${error}`);
      return { ok: false, error };
    } catch (err) {
      const raw = typeof err?.message === "string" ? err.message : String(err ?? "");
      const reason = raw.replace(/\s+/g, " ").trim().slice(0, 120) || "未知原因";
      log(`[desktop] 装配失败状态下清除开机密码出错：${err?.stack || reason}`);
      return { ok: false, error: `没能清除保存的开机密码（${reason}）` };
    }
  };

  const registerIpc = () => {
    if (registered) return;
    registered = true;
    const C = COMPUTER_USE_CHANNELS;
    const handle = (channel, fn) => {
      electron.ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedIpcSender(event, channel)) throw new Error("untrusted ipc sender");
        return fn(...args);
      });
      offs.push(() => electron.ipcMain.removeHandler(channel));
    };
    handle(C.status, () => {
      if (manager) return manager.getStatus();
      return initError ? initFailedStatus(platform, initError) : unsupportedStatus();
    });
    handle(C.requestPermission, (kind) => requireManager().requestPermission(kind));
    handle(C.openSettings, (kind) => requireManager().openSettings(kind));
    handle(C.setCredential, (input) => requireManager().setCredential(input));
    // 装配失败时也要能清（见 clearCredentialDegraded）；没有桌面驱动的平台仍是 requireManager 的「暂不支持」
    handle(C.clearCredential, () => (!manager && initError ? clearCredentialDegraded() : requireManager().clearCredential()));
    handle(C.testLockedAccess, () => requireManager().testLockedAccess());
    handle(C.testBackground, () => requireManager().testBackground());
    handle(C.installUnlockHelper, () => requireManager().installUnlockHelper());
    handle(C.uninstallUnlockHelper, () => requireManager().uninstallUnlockHelper());
    handle(C.exportDiagnostics, () => requireManager().exportDiagnostics());
  };

  /** 应用退出：会话收尾（我们解锁的电脑发锁屏命令、撤遮罩）、摘掉 IPC 处理器。可重复调用 */
  const destroy = () => {
    try {
      manager?.destroy();
    } catch (err) {
      log(`[desktop] 销毁失败（已忽略）：${err?.message || err}`);
    }
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        /* 已移除 */
      }
    }
    registered = false;
  };

  return { manager, registerIpc, destroy, audit };
};
