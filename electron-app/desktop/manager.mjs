/**
 * 电脑操作管理器（主进程）：把平台驱动、解锁器、遮罩、截图、权限、审计和会话状态机粘成对外的两个入口：
 *   1. handleOp：server 经 Node ipc 发来的 desktop_* 请求（AI 的工具调用）
 *   2. getStatus / requestPermission / setCredential / testLockedAccess …：设置页经 preload 暴露的 IPC
 *
 * 纯逻辑、不 import electron：electron 的东西（clipboard / systemPreferences / shell …）都由 main.js 组装好注入，单测用假对象。
 *
 * 几条不变量（tests/desktop-manager.test.ts 钉死）：
 * - 总开关没开 → 一切输入类 / 截图类请求都被拒（ACCESS_DISABLED）；desktop_status 例外，它只读、让 AI 知道为什么用不了。
 * - 权限预检在开始会话（可能触发自动解锁）之前：没权限就别去解锁一次。
 * - 所有请求串行执行：键鼠注入不能交错；排队中的请求在被取消后不再执行。
 * - 坐标 = 「该任务最近一张截图」里的像素位置；没截过图 / 屏幕变了 / 会话结束过 → 要求重新截图，绝不拿旧画面的坐标去点新画面。
 * - 动作完成后默认自动带一张新截图（AI 不用再多调一次）；截图失败不影响动作结果。
 * - 输入的文字只记长度进审计；绝不进日志。
 * - 设置页的凭据接口只写不读；状态里只有「有没有」。
 * - 锁屏后台档（Windows，注入了 background）：锁屏时默认不解锁，截图 / 输入走 background 驱动（逐窗口合成 + 窗口消息），
 *   会话 mode = background；输入类动作不能偷偷升级（只有 desktop_screenshot / desktop_apps 的 foreground:true 才会解锁）。
 *   设置页的「测试锁屏可用」强制走解锁（foreground），「测试后台操作」走探针，两者期间都不接 AI 的桌面请求。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { imageToInput } from "./coords.mjs";
import { blockedComboReason, parseCombo } from "./keys.mjs";
import { redactSecret } from "./redact-secret.mjs";
import { createDesktopSession } from "./session.mjs";
import { DESKTOP_CAPABILITY, DESKTOP_OPS, DesktopError } from "./types.mjs";

/** 设置页「测试锁屏可用」用的会话任务 id：事件不外发给 server / 飞书 */
export const SETTINGS_TEST_TASK = "__settings_test__";

export const MANAGER_LIMITS = Object.freeze({
  settleClickMs: 300,
  settleKeyMs: 250,
  settleTypeMs: 200,
  settleScrollMs: 250,
  openAppWaitMs: 1500,
  /** 动作之后、截图之前再等一小会儿，让界面画完 */
  postActionShotDelayMs: 150,
  /** 超过这个长度、且剪贴板里只有文字（或为空）时，用「粘贴」输入（比逐字快、也不受输入法影响） */
  pasteThreshold: 120,
  maxTypeChars: 5000,
  maxKeyRepeat: 20,
  maxScrollNotches: 50,
  maxApps: 40,
  maxWindowsPerApp: 6,
  maxTitleChars: 120,
  /** 后台截图结果里最多列多少个窗口给 AI（Z 序从上到下） */
  maxBackgroundWindows: 16,
  /** 测试锁屏可用：给用户把手从键鼠上拿开的时间 / 等锁屏生效 / 等锁屏界面稳定（要让键鼠空闲超过「用户在场」阈值） */
  testCountdownMs: 5000,
  testLockWaitMs: 5000,
  testLockSettleMs: 3500,
});

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const bad = (message) => new DesktopError("BAD_ARGS", message);

/** 宽松取数字（模型常把数字写成字符串） */
const num = (v, name) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw bad(`${name} 必须是数字`);
  return n;
};

const optNum = (v, name, fallback) => (v === undefined || v === null || v === "" ? fallback : num(v, name));

/**
 * desktop_key 写进审计的按键标签。
 * 会打出字符的键（字母 / 数字 / 标点 / 空格，且只带 shift / alt / AltGr 这类「打字修饰键」）只记 `[char]`；
 * 带 cmd / 单独 ctrl 的是快捷键，不是在打字，照实记规范名（审计要看的正是 AI 按了什么快捷键）；enter / tab / 方向键 / F 键同理。
 */
export const auditKeyLabel = (combo) => {
  const typesChar = combo.key.length === 1 || combo.key === "space" || combo.key === "plus" || combo.key === "minus";
  const shortcutMod = combo.mods.includes("meta") || (combo.mods.includes("ctrl") && !combo.mods.includes("alt"));
  if (typesChar && !shortcutMod) return "[char]";
  return [...combo.mods, combo.key].join("+");
};

const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.trunc(n)));

const pickEnum = (v, allowed, fallback, name) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "string" && allowed.includes(v)) return v;
  throw bad(`${name} 只能是 ${allowed.join(" / ")}`);
};

/**
 * @param {{
 *   platform?: string,
 *   driver: import("./types.mjs").DesktopDriver,
 *   unlocker?: import("./types.mjs").ScreenUnlocker | null,
 *   overlay: import("./types.mjs").DesktopOverlay,
 *   screenshotter: {
 *     capture: () => Promise<{ jpeg: Buffer, frame: import("./coords.mjs").ScreenshotFrame }>,
 *     screenPermission: () => string,
 *     selfCheck?: () => Promise<{ ok: boolean, skipped?: boolean, detail?: string }>,
 *     getMode?: () => string,
 *   },
 *   permissions: ReturnType<typeof import("./permissions.mjs").createPermissionAdapter>,
 *   background?: {
 *     driver: import("./types.mjs").BackgroundDriver,
 *     shotter: { capture: () => Promise<{ jpeg: Buffer, frame: import("./coords.mjs").ScreenshotFrame, windows?: import("./types.mjs").BackgroundWindowInfo[] }> },
 *     probe?: { run: (ctx: { shouldAbort: () => boolean, onStep?: (s: import("./types.mjs").UnlockStep) => void }) => Promise<{ ok: boolean, steps: import("./types.mjs").UnlockStep[], error?: string }> },
 *   } | null,
 *   clipboard?: { readText: () => string, writeText: (t: string) => void, availableFormats: () => string[] } | null,
 *   audit?: { write: (entry: Record<string, unknown>) => unknown, flush?: () => unknown },
 *   userDataDir?: string,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (msg: string) => void,
 *   limits?: Partial<typeof MANAGER_LIMITS>,
 *   sessionLimits?: Record<string, number>,
 *   fsImpl?: Pick<typeof fs.promises, "writeFile" | "mkdir">,
 *   appInfo?: { name?: string, version?: string, electron?: string },
 *   notifyLocal?: ((title: string, body: string) => void) | null,
 *   cooldownStore?: { load: () => number, save: (until: number) => void } | null,
 *   keepAwake?: { acquire: () => (() => void) | void } | null,
 * }} deps  notifyLocal：本机原生通知（main.js 用 Electron Notification 实现；单测用假函数）
 *   cooldownStore：自动解锁冷却截止时刻的落盘（cooldown-store.mjs，原样交给 session；不传 = 只放内存）
 *   keepAwake：前台会话期间防显示器睡眠（index.mjs 的 makeKeepDisplayAwake，原样交给 session；不传 = 不防）
 *   background：锁屏后台档（Windows）。不传 = 本平台没有（macOS）：锁屏一律走解锁
 */
export const createDesktopManager = (deps) => {
  const {
    platform = process.platform,
    driver,
    unlocker = null,
    overlay,
    screenshotter,
    permissions: perms,
    background = null,
    clipboard = null,
    audit = { write: () => {} },
    userDataDir = os.tmpdir(),
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
    fsImpl = fs.promises,
    appInfo = {},
    notifyLocal = null,
  } = deps;
  const limits = { ...MANAGER_LIMITS, ...(deps.limits ?? {}) };

  /** server 推送的设置；断连时 fail-closed */
  let cfg = { enabled: false, lockedAccess: false };
  let eventSink = null;
  let initPromise = null;
  let initResult = null;
  /** taskId → 最近一张截图的坐标映射 */
  const frames = new Map();
  /**
   * 会话「世代」：每次会话结束 / 被用户接管就 +1。截图是异步的——截图期间会话结束了，
   * 这张图的坐标不能再存（否则下一次点击会拿着死会话里的旧画面坐标去点新画面）。
   */
  let sessionEpoch = 0;
  /** 最近一次解锁的步骤（name / ok / ms），给设置页的测试和诊断用 */
  let lastUnlockSteps = [];
  /** 设置页「测试锁屏可用 / 测试后台操作」进行中：期间不接 AI 的桌面请求（测试会真的锁屏，不能和 AI 的会话抢） */
  let testing = false;
  /** 正在进行的是哪种测试（unlock | background）：只用来给 AI 说清楚「为什么暂时不能用」 */
  let testingKind = "unlock";
  /** 锁屏后台档的初始化结果（null = 还没初始化过）。session 的 available() 只看它——所以每次开会话前都要先 await ensureBackground() */
  let backgroundResult = null;
  let backgroundPromise = null;
  /** 最近一次「测试后台操作」的结果（进诊断文件，方便真机排查） */
  let lastBackgroundProbe = null;

  // ── 解锁器：包一层收集步骤 ──
  const trackedUnlocker = unlocker
    ? {
        get supported() {
          return unlocker.supported;
        },
        // 解锁在系统登录界面里完成的平台（Windows 解锁组件）：session 要先盖遮罩再解锁
        get overlayBeforeUnlock() {
          return unlocker.overlayBeforeUnlock === true;
        },
        hasCredential: () => unlocker.hasCredential(),
        setCredential: (s) => unlocker.setCredential(s),
        clearCredential: () => unlocker.clearCredential(),
        // 可选：保存的密码读得出、打得出吗（设置页「测试」在真的锁屏之前先问一句）。没有这个能力的解锁器 = 不预检
        checkCredential: typeof unlocker.checkCredential === "function" ? () => unlocker.checkCredential() : undefined,
        lock: (opts) => unlocker.lock(opts),
        unlock: (ctx) => {
          lastUnlockSteps = [];
          return unlocker.unlock({
            ...ctx,
            onStep: (s) => {
              lastUnlockSteps.push({ name: s.name, ok: s.ok, ms: s.ms });
              ctx?.onStep?.(s);
            },
          });
        },
      }
    : null;

  const getPolicy = () => ({ enabled: cfg.enabled === true, lockedAccess: cfg.lockedAccess === true });

  /** 本机原生通知（server 不在 / 飞书没开时，这是唯一能让「电脑旁的人」看到的提醒）。永不抛 */
  const alertLocal = (title, body) => {
    try {
      notifyLocal?.(title, body);
    } catch (err) {
      log(`[desktop-manager] 本机通知失败：${err?.message || err}`);
    }
  };

  const notify = (evt) => {
    // 会话没了：世代 +1、旧画面的坐标作废。user_took_over 之后现在紧跟着就是 session_ended（同一轮同步发出），
    // 这里两个都认是有意的双保险——哪怕以后「接管」和「收尾」之间隔了异步，接管的那一刻坐标就已经失效
    if (evt.kind === "session_ended" || evt.kind === "user_took_over") {
      sessionEpoch += 1;
      if (evt.taskId) frames.delete(evt.taskId);
    }
    // 没能把电脑锁回去：最危险的收尾失败。server 通道断了（事件推不出去）也要有人知道——本机弹一条原生通知，
    // 内容只用固定文案（不带任何屏幕内容 / 凭据）
    if (evt.kind === "relock_failed") {
      alertLocal("Flowship：电脑没能自动锁回去", `AI 操作结束后没能把电脑锁屏，请尽快手动锁屏（${platform === "win32" ? "Win + L" : "⌃⌘Q"}）。`);
    }
    // 设置页的测试流程自己展示进度，不往 server / 飞书推
    if (evt.taskId === SETTINGS_TEST_TASK) return;
    try {
      eventSink?.("desktop_session", evt.taskId || "_", { ...evt });
    } catch (err) {
      log(`[desktop-manager] 推送会话事件失败：${err?.message || err}`);
    }
  };

  const session = createDesktopSession({
    driver,
    unlocker: trackedUnlocker,
    overlay,
    getPolicy,
    background: background ? { available: () => backgroundResult?.ok === true, reset: () => background.driver.reset() } : null,
    notify,
    audit: (entry) => audit.write(entry),
    cooldownStore: deps.cooldownStore ?? null,
    keepAwake: deps.keepAwake ?? null,
    now,
    sleep,
    log,
    limits: deps.sessionLimits,
  });

  const ensureReady = () => {
    initPromise ??= (async () => {
      try {
        initResult = await driver.init();
      } catch (err) {
        initResult = { ok: false, error: `桌面操作组件初始化出错：${err?.message || err}` };
      }
      return initResult;
    })();
    return initPromise;
  };

  /**
   * 锁屏后台档（Windows）初始化：依赖核心驱动先就绪；失败不抛，原因留给设置页 / 诊断。永不抛。
   * 结果缓存——开会话前 await 它一次，之后 session 同步问 available() 就是准的。
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  const ensureBackground = () => {
    if (!background) return Promise.resolve({ ok: false, error: "本平台没有锁屏后台模式" });
    backgroundPromise ??= (async () => {
      const core = await ensureReady();
      if (!core.ok) return { ok: false, error: core.error };
      try {
        const r = await background.driver.init();
        return r?.ok === true ? { ok: true } : { ok: false, error: String(r?.error ?? "后台组件没有初始化成功") };
      } catch (err) {
        return { ok: false, error: `后台组件初始化出错：${String(err?.message || err).slice(0, 160)}` };
      }
    })().then((r) => {
      backgroundResult = r;
      if (!r.ok) log(`[desktop-manager] 锁屏后台模式不可用：${r.error}`);
      return r;
    });
    return backgroundPromise;
  };

  // ── 串行队列 ──

  let queue = Promise.resolve();
  const serial = (signal, fn) => {
    const run = async () => {
      if (signal?.aborted) throw new DesktopError("CANCELLED", "操作已取消（任务被停止）");
      return fn();
    };
    const p = queue.then(run, run);
    queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };

  const checkAborted = (signal) => {
    if (signal?.aborted) throw new DesktopError("CANCELLED", "操作已取消（任务被停止）");
  };

  // ── 前置检查 ──

  const assertPermissions = ({ input }) => {
    if (platform !== "darwin") return;
    if (perms.screen() !== "granted") {
      throw new DesktopError(
        "NEED_PERMISSION",
        "Flowship 还没有「屏幕录制」权限。请告诉用户到 Flowship 设置的「电脑操作」里点「授权屏幕录制」（授权后可能需要重启 Flowship）",
      );
    }
    if (input && perms.accessibility() !== "granted") {
      throw new DesktopError(
        "NEED_PERMISSION",
        "Flowship 还没有「辅助功能」权限，没法操作键盘鼠标。请告诉用户到 Flowship 设置的「电脑操作」里点「授权辅助功能」",
      );
    }
  };

  /** 不碰电脑的前置检查：组件 → 总开关 → 权限 */
  const preflight = async ({ input }) => {
    const r = await ensureReady();
    if (!r.ok) throw new DesktopError("UNSUPPORTED", r.error);
    if (!getPolicy().enabled) {
      throw new DesktopError("ACCESS_DISABLED", "「电脑操作」没有开启：请告诉用户在 Flowship 设置里打开「电脑操作」");
    }
    assertPermissions({ input });
    // 后台档要在开会话之前初始化好（session 同步问 available()）。失败不报错：会话自己回退到解锁流程
    await ensureBackground();
  };

  /**
   * 开始 / 续用会话（锁屏时：Windows 默认走不解锁的后台档，macOS 自动解锁；allowUnlock 只认严格的 true）。
   * allowForeground 且 args.foreground === true：要求前台档——锁屏时直接解锁；已经是后台会话就升级（有解锁就走完整的解锁流程）。
   * 只有 desktop_screenshot / desktop_apps 开放这个参数，输入类动作不能一边点一边偷偷升级。
   */
  const startSession = async (taskId, args, { allowForeground = false } = {}) => {
    const allowUnlock = args.allowUnlock === true;
    const foreground = allowForeground && args.foreground === true;
    await session.begin(taskId, { allowUnlock, foreground });
    if (foreground) await session.upgradeToForeground(taskId, { allowUnlock });
  };

  const prepare = async (taskId, args, opts) => {
    await preflight(opts);
    await startSession(taskId, args, { allowForeground: true });
  };

  // ── 截图 / 坐标 ──

  const NO_FRAME_MSG = "还没有截图，坐标无从换算：请先调用 desktop_screenshot，再按截图里的像素位置操作";

  /** 后台截图里每个窗口给 AI 看的摘要：只有应用进程名 + 位置（截图像素坐标）+ 画面状态，不含窗口标题 / 内容 */
  const summarizeWindows = (windows) =>
    (Array.isArray(windows) ? windows : []).slice(0, limits.maxBackgroundWindows).map((w) => ({
      app: String(w.processName || w.className || "").slice(0, 60),
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      status: String(w.status ?? "ok").slice(0, 12),
    }));

  const shotPayload = (shot) => ({
    image: { data: shot.jpeg.toString("base64"), mimeType: "image/jpeg", width: shot.frame.imageWidth, height: shot.frame.imageHeight },
    unlockedByUs: session.status().unlockedByUs,
    // 锁屏后台档的截图：告诉 AI 这是「逐窗口合成」的画面（不是真实屏幕），以及哪些窗口画不出来
    ...(shot.background === true ? { mode: "background", windows: summarizeWindows(shot.windows) } : {}),
  });

  /** 按当前会话方式截图：后台会话 = 逐窗口合成（锁屏时全屏截图什么都截不到），其余 = 真实屏幕 */
  const captureNow = () => {
    if (session.status().mode === "background" && background) {
      return background.shotter.capture().then((shot) => ({ ...shot, background: true }));
    }
    return screenshotter.capture();
  };

  const frameFor = (taskId) => {
    const f = frames.get(taskId);
    if (!f) throw bad(NO_FRAME_MSG);
    const rect = driver.getPrimaryDisplay();
    if (rect.width !== f.rect.width || rect.height !== f.rect.height || rect.x !== f.rect.x || rect.y !== f.rect.y) {
      frames.delete(taskId);
      throw bad("屏幕尺寸或位置变了，之前的截图作废：请重新调用 desktop_screenshot");
    }
    return f;
  };

  const point = (args, xKey, yKey, taskId) => {
    const frame = frameFor(taskId);
    return { frame, ...imageToInput({ x: num(args[xKey], xKey), y: num(args[yKey], yKey) }, frame) };
  };

  /**
   * 存截图的坐标映射。截图期间会话结束了（用户接管 / 超时 / 任务被停）→ 这张图作废并报错，
   * 绝不把死会话里的画面坐标留下来给下一次点击用。
   */
  const storeFrame = (taskId, epoch, frame) => {
    if (epoch !== sessionEpoch) {
      throw new DesktopError(
        "SESSION_EXPIRED",
        "电脑操作会话在截图过程中结束了（用户接管、超时或任务被停止）：这张截图已作废。需要继续的话，请重新调用 desktop_screenshot 开始新的会话",
      );
    }
    frames.set(taskId, frame);
  };

  /** 动作完成后补一张截图。截图失败不影响动作结果；会话类错误（用户接管 / 会话结束 / 弹出了系统安全提示）要原样抛，让 AI 知道 */
  const withShot = async (taskId, args, signal, base) => {
    if (args.screenshot === false) return { ok: true, ...base };
    try {
      await sleep(limits.postActionShotDelayMs);
      checkAborted(signal);
      const epoch = sessionEpoch;
      const shot = await session.runRead(taskId, () => captureNow());
      storeFrame(taskId, epoch, shot.frame);
      return { ok: true, ...base, ...shotPayload(shot) };
    } catch (err) {
      if (err instanceof DesktopError && ["USER_TOOK_OVER", "SESSION_EXPIRED", "CANCELLED", "DENIED", "SECURE_DESKTOP"].includes(err.code)) throw err;
      return { ok: true, ...base, screenshotError: String(err?.message || err).slice(0, 200) };
    }
  };

  // ── 输入类 op（先验参数 → 再开会话 → 串行区里按最新 frame 解析并执行；参数有误既不会解锁也不会碰电脑） ──

  /**
   * 前台输入通道：真实键鼠（电脑没锁屏，或我们解锁了）。
   * shouldStop：这个动作自己的「该收手了」判断（session.runAction 传进来，绑了动作所属的会话世代）；缺省退回会话级判断。
   */
  const typeText = async (text, shouldStop = session.shouldStop) => {
    // 会话已经在收尾（被停 / 超时 / 用户接管）：一个字都别再打——锁屏界面一出来，这些字就会进密码框
    if (shouldStop()) return;
    // 只有剪贴板里「纯文字（或空）」才敢借来粘贴：有图片 / 文件 / 富文本（html、rtf）时，用 writeText 恢复会丢掉这些格式
    const canPaste =
      clipboard &&
      text.length > limits.pasteThreshold &&
      (() => {
        try {
          return clipboard.availableFormats().every((f) => f === "text/plain");
        } catch {
          return false;
        }
      })();
    if (!canPaste) {
      // 驱动在每个批次之间看 shouldStop：会话结束时提前收手，而不是把剩下的字全打完
      await driver.typeText(text, { shouldStop });
      return;
    }
    // 粘贴：剪贴板里原来只有文字（或空），用完恢复
    const previous = clipboard.readText();
    clipboard.writeText(text);
    try {
      await driver.keyCombo(parseCombo("mod+v", platform));
      await sleep(300);
    } finally {
      clipboard.writeText(previous);
    }
  };

  const foregroundIo = {
    mouseMove: (x, y) => driver.mouseMove(x, y),
    click: (x, y, o) => driver.click(x, y, o),
    drag: (from, to, o) => driver.drag(from, to, o),
    scroll: (x, y, dx, dy) => driver.scroll(x, y, dx, dy),
    typeText,
    keyCombo: (combo) => driver.keyCombo(combo),
    openApp: (name) => driver.openApp(name),
  };

  /**
   * 后台输入通道（锁屏后台档）：窗口消息，不碰真实键鼠。文字一律走逐字消息（不借剪贴板：锁屏时 Ctrl+V 的模拟不可靠）。
   * keyCombo 可能返回 { note }（带「尽力而为」性质的组合键），由调用方转给 AI。
   */
  const backgroundIo = background
    ? {
        mouseMove: (x, y) => background.driver.mouseMove(x, y),
        click: (x, y, o) => background.driver.click(x, y, o),
        drag: (from, to, o) => background.driver.drag(from, to, o),
        scroll: (x, y, dx, dy) => background.driver.scroll(x, y, dx, dy),
        typeText: (text, shouldStop = session.shouldStop) => background.driver.typeText(text, { shouldStop }),
        keyCombo: (combo) => background.driver.keyCombo(combo),
        openApp: (name) => background.driver.openApp(name),
      }
    : null;

  /** 此刻该用哪条输入通道（在 session.runAction 里调用：会话 guard 已通过，mode 是准的） */
  const currentIo = () => (backgroundIo && session.status().mode === "background" ? backgroundIo : foregroundIo);

  /** op → { settleMs, parse(args, taskId) → { audit, exec(io, ctx) }；ctx.note(s) 把「给 AI 的提示」附到结果里 } */
  const INPUT_OPS = {
    desktop_click: {
      needsFrame: true,
      settleMs: limits.settleClickMs,
      parse: (args, taskId) => {
        const p = point(args, "x", "y", taskId);
        const button = pickEnum(args.button, ["left", "right", "middle"], "left", "button");
        const count = clampInt(optNum(args.count, "count", 1), 1, 3);
        return {
          audit: { x: p.x, y: p.y, button, count },
          exec: (io) => io.click(p.x, p.y, { button, count }),
        };
      },
    },
    desktop_move: {
      needsFrame: true,
      settleMs: limits.settleClickMs,
      parse: (args, taskId) => {
        const p = point(args, "x", "y", taskId);
        return { audit: { x: p.x, y: p.y }, exec: (io) => io.mouseMove(p.x, p.y) };
      },
    },
    desktop_drag: {
      needsFrame: true,
      settleMs: limits.settleClickMs,
      parse: (args, taskId) => {
        const from = point(args, "x", "y", taskId);
        const to = point(args, "toX", "toY", taskId);
        const button = pickEnum(args.button, ["left", "right", "middle"], "left", "button");
        return {
          audit: { x: from.x, y: from.y, x2: to.x, y2: to.y, button },
          exec: (io) => io.drag({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { button }),
        };
      },
    },
    desktop_scroll: {
      needsFrame: true,
      settleMs: limits.settleScrollMs,
      parse: (args, taskId) => {
        const frame = frameFor(taskId);
        const hasPos = args.x !== undefined && args.y !== undefined;
        const p = hasPos
          ? imageToInput({ x: num(args.x, "x"), y: num(args.y, "y") }, frame)
          : imageToInput({ x: frame.imageWidth / 2, y: frame.imageHeight / 2 }, frame);
        const dx = clampInt(optNum(args.dx, "dx", 0), -limits.maxScrollNotches, limits.maxScrollNotches);
        const dy = clampInt(optNum(args.dy, "dy", 0), -limits.maxScrollNotches, limits.maxScrollNotches);
        if (dx === 0 && dy === 0) throw bad("dx、dy 至少有一个不为 0（dy>0 向下、dx>0 向右，单位是「格」）");
        return { audit: { x: p.x, y: p.y, dx, dy }, exec: (io) => io.scroll(p.x, p.y, dx, dy) };
      },
    },
    desktop_type: {
      settleMs: limits.settleTypeMs,
      parse: (args) => {
        const text = args.text;
        if (typeof text !== "string" || text === "") throw bad("text 必须是非空字符串");
        if (text.length > limits.maxTypeChars) throw bad(`一次最多输入 ${limits.maxTypeChars} 个字符，长文本请分几次`);
        const submit = args.submit === true;
        return {
          // 只记长度，不记内容
          audit: { chars: text.length },
          exec: async (io, ctx) => {
            await io.typeText(text, ctx.shouldStop);
            if (submit) {
              await sleep(80);
              // 回车是最危险的一击（锁屏界面上它 = 提交密码）：会话已经在收尾就不按；
              // 没在收尾也要在按之前**再过一遍会话闸门**（第三轮评审 P1-3）：动作开始时的 guard 离这一下已经过去了「打字 + 80ms」，
              // 这期间电脑被锁屏 / 弹出了 UAC / 锁屏状态读不到——任何一条成立，回车都不能按（抛错、动作作废，字可能已经打了一部分）
              if (!ctx.shouldStop()) {
                ctx.guard();
                ctx.note((await io.keyCombo({ mods: [], key: "enter" }))?.note);
              }
            }
          },
        };
      },
    },
    desktop_key: {
      settleMs: limits.settleKeyMs,
      parse: (args) => {
        const combo = parseCombo(args.keys, platform);
        const blocked = blockedComboReason(combo, platform);
        if (blocked) throw new DesktopError("BLOCKED", blocked);
        const repeat = clampInt(optNum(args.repeat, "repeat", 1), 1, limits.maxKeyRepeat);
        return {
          // 审计里按规范化后的组合记，且会打出字符的键只记 [char]：模型一个键一个键地打密码，逐条审计就是明文密码
          audit: { key: auditKeyLabel(combo), count: repeat },
          exec: async (io, ctx) => {
            for (let i = 0; i < repeat; i += 1) {
              if (ctx.shouldStop()) break;
              // 第 2 下起，每按一下之前再过一遍会话闸门（第四轮评审 A3-a）：连按回车 = 一次次往锁屏界面的密码框提交，
              // 而看门狗每 0.3 秒才看一次锁屏、shouldStop 只认会话状态，这个空档里 repeat 最多还能再按好几下（下与下间隔 40ms，上限 20 下）。
              // guard 是同步读，开销可以忽略；抛错 = 这一下不放行（被锁屏 / 弹出 UAC / 锁屏状态读不到 / 用户接管），动作作废（已按的撤不回）。
              // 第 1 下不用：动作开始时 session.runAction 已经 guard 过了
              if (i > 0) ctx.guard();
              ctx.note((await io.keyCombo(combo))?.note);
              if (i < repeat - 1) await sleep(40);
            }
          },
        };
      },
    },
    desktop_open_app: {
      settleMs: limits.openAppWaitMs,
      parse: (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (name === "") throw bad("name 必须是非空字符串（应用名，如「微信」「Safari」；可先用 desktop_apps 看运行中的应用）");
        return { audit: { app: name.slice(0, 80) }, exec: (io) => io.openApp(name) };
      },
    },
  };

  const runInputOp = async (op, args, { taskId, signal }) => {
    const spec = INPUT_OPS[op];
    await preflight({ input: true });
    // 需要坐标的动作没有截图时直接拒绝：锁屏时开会话 = 自动解锁，不能为了一个注定失败的点击去解锁电脑
    if (spec.needsFrame && !frames.has(taskId)) throw bad(NO_FRAME_MSG);
    // 参数先验一遍、再开会话：开会话在锁屏时 = 自动解锁 + 盖遮罩，不能为了一个参数本来就不合法的调用
    // （空文本 / 被拦截的组合键 / 空应用名 / 越界坐标……）去输一次开机密码，再报错。
    // 这一遍只用来「验」、结果丢掉：真正执行用的解析还在下面的串行区里重做一遍——排队期间截图可能换了，坐标要按最新的 frame 算。
    // parse 是纯校验（唯一的副作用是 frameFor 发现屏幕变了就作废旧 frame，幂等），重复调用没有代价。
    spec.parse(args, taskId);
    await startSession(taskId, args);
    return serial(signal, async () => {
      // 解析放在会话动作之外：坐标越界 / 参数错误不会碰电脑，也不会刷新「最后注入时刻」
      const parsed = spec.parse(args, taskId);
      checkAborted(signal);
      /** 动作过程中驱动给 AI 的提示（后台档里「尽力而为」的组合键等） */
      const notes = [];
      const note = (s) => {
        if (typeof s === "string" && s !== "" && !notes.includes(s)) notes.push(s);
      };
      // 这个动作自己的「该收手了」判断：绑动作所属的会话世代（见 session.runAction）。用会话级的 shouldStop 的话，
      // 收尾时被 drain 超时丢下的「僵尸动作」在新会话 active 之后会误以为没事、接着打完剩下的字（第三轮评审）
      let actionShouldStop = session.shouldStop;
      await session.runAction(taskId, async ({ shouldStop }) => {
        actionShouldStop = shouldStop;
        checkAborted(signal);
        // guard：动作进行中再过一遍会话闸门（回车前用）；同一任务、同一把闸，抛错 = 这一下不放行
        await parsed.exec(currentIo(), { note, shouldStop, guard: () => session.guard(taskId) });
        // 会话在动作进行中被结束：别再等界面稳定（收尾在等这个动作停手）
        if (!shouldStop()) await sleep(spec.settleMs);
      });
      // 动作进行中会话被结束了（任务被停 / 超时 / 总开关被关）：这个动作可能只做了一半（比如字只打了前半段、回车被跳过），
      // 不能当成功报告——screenshot:false 时后面的补截图那一关不会替我们挡
      if (actionShouldStop()) {
        throw new DesktopError(
          "SESSION_EXPIRED",
          "电脑操作会话在这个动作进行过程中被结束了（任务被停止、超时或开关被关），动作可能只做了一部分。需要继续的话，请先重新截图确认当前状态再操作",
        );
      }
      return withShot(taskId, args, signal, { _audit: parsed.audit, ...(notes.length > 0 ? { note: notes.join("；") } : {}) });
    });
  };

  // ── 只读 / 会话类 op ──

  const trimApps = (apps) =>
    apps.slice(0, limits.maxApps).map((a) => ({
      name: String(a.name ?? "").slice(0, 80),
      ...(a.bundleId ? { bundleId: String(a.bundleId).slice(0, 120) } : {}),
      frontmost: a.frontmost === true,
      windows: (Array.isArray(a.windows) ? a.windows : []).slice(0, limits.maxWindowsPerApp).map((w) => ({
        title: String(w.title ?? "").slice(0, limits.maxTitleChars),
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
      })),
    }));

  const READ_OPS = {
    desktop_screenshot: async (args, { taskId, signal }) => {
      await prepare(taskId, args, { input: false });
      return serial(signal, async () => {
        const epoch = sessionEpoch;
        const shot = await session.runRead(taskId, () => captureNow());
        storeFrame(taskId, epoch, shot.frame);
        return { ok: true, ...shotPayload(shot) };
      });
    },
    desktop_apps: async (args, { taskId, signal }) => {
      await prepare(taskId, args, { input: false });
      return serial(signal, async () => {
        const apps = await session.runRead(taskId, async () => driver.listApps());
        return { ok: true, apps: trimApps(Array.isArray(apps) ? apps : []) };
      });
    },
    desktop_end_session: async (_args, { taskId, signal }) => {
      return serial(signal, async () => {
        const before = session.status();
        if (before.taskId !== taskId) return { ok: true, ended: false };
        // unlockedByUs 要在结束之前取（结束后会清零）：server 据此区分「本来就没锁屏所以没重新锁」与「应该锁回去但没锁上」
        const unlockedByUs = before.unlockedByUs === true;
        const wasBackground = before.mode === "background";
        const r = await session.endForTask(taskId, "explicit");
        // 后台会话：电脑从头到尾是锁着的、我们没解过锁——server 据此说「仍是锁屏状态」，而不是「本来就没锁屏」
        return { ok: true, ended: true, unlockedByUs, relocked: r.relocked === true, ...(wasBackground ? { mode: "background" } : {}) };
      });
    },
  };

  // ── 状态 ──

  const permissionSnapshot = () => ({ accessibility: perms.accessibility(), screen: perms.screen() });

  /**
   * 解锁路线（macOS 钥匙串 / Windows 系统级解锁组件）本平台有没有实现。
   * Windows 上「组件装没装」不在这里表达（那是 helperStatus / hasCredential 的事）：supported 一旦为 false，设置页整块隐藏，用户就没有安装入口了。
   */
  const unlockRouteSupported = () => Boolean(unlocker) && unlocker.supported !== false;
  /** 锁屏后台档（Windows）初始化成功、可用 */
  const backgroundRouteReady = () => backgroundResult?.ok === true;

  /**
   * 「锁屏时也能用」就绪与否 = 两条路线任一条可走：
   *   后台档（Windows，不解锁、不需要开机密码）；解锁（macOS / Windows 装了解锁组件：要密码、没在冷却、权限齐）。
   * unlockReady 单独给：AI 要不要在后台模式不够用时升级成解锁（desktop_screenshot foreground:true）看的就是它。
   */
  const lockedAccessReadiness = ({ driverReady, driverError, credentialSet, permissionsOk, cooldownUntil = 0, unlockHelper = null }) => {
    const bgOk = backgroundRouteReady();
    const unlockSupported = unlockRouteSupported();
    if (!unlockSupported && !bgOk) {
      const bgReason = background && backgroundResult && !backgroundResult.ok ? backgroundResult.error : null;
      return {
        ready: false,
        unlockReady: false,
        note:
          platform === "win32"
            ? bgReason
              ? `锁屏时用不了：后台组件没有就绪（${bgReason}），也没有安装解锁组件。目前只能在电脑已解锁的状态下使用电脑操作`
              : "Windows 暂不支持锁屏时自动解锁：目前只能在电脑已解锁的状态下使用电脑操作"
            : "当前系统暂不支持锁屏时自动解锁",
      };
    }
    if (!driverReady) return { ready: false, unlockReady: false, note: driverError ?? "原生组件没有加载成功" };
    // 解锁路线自己的条件（不看总开关：「锁屏时也能用」没开只影响 ready，不影响「如果开了能不能解锁」）
    let unlockNote = null;
    if (!unlockSupported) unlockNote = "当前系统暂不支持锁屏自动解锁";
    else if (unlockHelper && unlockHelper.installed !== true) unlockNote = "还没有安装解锁组件";
    else if (!credentialSet) unlockNote = "还没有保存开机密码";
    else if (!permissionsOk) unlockNote = "还缺系统权限（辅助功能 / 屏幕录制）";
    else if (cooldownUntil > 0) {
      const mins = Math.max(1, Math.ceil((cooldownUntil - now()) / 60_000));
      unlockNote = `刚刚自动解锁失败过，为避免连续输错密码，暂停自动解锁约 ${mins} 分钟；重新保存开机密码可立即恢复`;
    }
    const unlockReady = unlockNote === null;
    if (!cfg.lockedAccess) return { ready: false, unlockReady };
    if (bgOk) return { ready: true, unlockReady, ...(unlockNote ? { unlockNote } : {}) };
    return unlockReady ? { ready: true, unlockReady } : { ready: false, unlockReady, note: unlockNote };
  };

  /**
   * 屏幕上是不是 UAC 之类的系统安全桌面（只有 Windows 驱动有这个能力）。读不出来 / 抛错 / 没这个方法 = 不是——和会话里的判断同一个口径；
   * 设置页每隔几秒就轮询状态，这一项出问题不能把整份状态拖垮
   */
  const readSecureDesktop = () => {
    try {
      return driver.isSecureDesktopActive?.() === true;
    } catch {
      return false;
    }
  };

  /** 设置页看到的状态快照：只有布尔 / 枚举 / 时间，绝不含凭据 */
  const getStatus = async () => {
    const init = await ensureReady();
    await ensureBackground();
    const permissionsNow = permissionSnapshot();
    // 「存着一份开机密码」：有 hasStoredCredential 的解锁器（Windows）用它——不看解锁组件版本够不够新：装着旧版组件、
    // 设置页正提示升级时，用户也要看得到、清得掉自己保存的密码（第六轮评审 P2-1）；没有的（macOS 钥匙串）就是 hasCredential。
    // 解锁预检仍走 hasCredential（session 里那一份）：「能不能用来解锁」和「存没存着」是两个问题
    let credentialSet = false;
    try {
      credentialSet = unlocker
        ? await (typeof unlocker.hasStoredCredential === "function" ? unlocker.hasStoredCredential() : unlocker.hasCredential())
        : false;
    } catch {
      credentialSet = false;
    }
    // 需要额外装组件的平台（Windows 解锁组件）：安装状态给设置页画「安装 / 卸载」；读不出来就当没装
    let unlockHelper = null;
    if (unlocker && typeof unlocker.helperStatus === "function") {
      try {
        unlockHelper = await unlocker.helperStatus();
      } catch (err) {
        unlockHelper = { installed: false, canInstall: false, detail: `读取解锁组件状态出错：${String(err?.message || err).slice(0, 120)}` };
      }
    }
    const permissionsOk = permissionsNow.accessibility === "granted" && permissionsNow.screen === "granted";
    const s = session.status();
    const readiness = lockedAccessReadiness({
      driverReady: init.ok,
      driverError: init.ok ? undefined : init.error,
      credentialSet,
      permissionsOk,
      cooldownUntil: s.unlockCooldownUntil,
      unlockHelper,
    });
    return {
      platform: platform === "darwin" || platform === "win32" ? platform : "other",
      enabled: cfg.enabled === true,
      lockedAccessEnabled: cfg.lockedAccess === true,
      // manager 只在有桌面驱动的平台（macOS / Windows）上创建；其它平台由 main.js 直接回一份 supported:false 的静态状态
      supported: true,
      // 锁屏时 AI 能不能工作：解锁路线可用（macOS 钥匙串 / Windows 解锁组件）或有后台档（Windows）
      lockedAccessSupported: unlockRouteSupported() || backgroundRouteReady(),
      // 两条路线分开说，设置页据此分别展示（后台档不要密码；解锁要密码 / 组件）
      backgroundSupported: Boolean(background),
      backgroundReady: backgroundRouteReady(),
      ...(background && backgroundResult && !backgroundResult.ok ? { backgroundError: backgroundResult.error } : {}),
      unlockSupported: unlockRouteSupported(),
      unlockReady: readiness.unlockReady === true,
      ...(readiness.unlockNote ? { unlockNote: readiness.unlockNote } : {}),
      ...(unlockHelper ? { unlockHelper } : {}),
      driverReady: init.ok,
      ...(init.ok ? {} : { driverError: init.error }),
      permissions: permissionsNow,
      locked: init.ok ? driver.isScreenLocked() : null,
      // Windows：屏幕上是 UAC 权限确认等系统安全桌面（不是锁屏；此时开始操作会被拒绝）。只在真的遇到时才带这个字段
      ...(init.ok && readSecureDesktop() ? { secureDesktop: true } : {}),
      credentialSet,
      lockedAccessReady: readiness.ready,
      ...(readiness.note ? { lockedAccessNote: readiness.note } : {}),
      session: {
        active: s.active,
        unlockedByUs: s.unlockedByUs,
        ...(s.active ? { mode: s.mode } : {}),
        ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      },
    };
  };

  /** AI 的 desktop_status：只读，不开会话；没开启时也照常返回，让 AI 知道为什么用不了 */
  const statusOp = async () => {
    const st = await getStatus();
    return {
      ok: true,
      enabled: st.enabled,
      platform: st.platform,
      driverReady: st.driverReady,
      ...(st.driverError ? { driverError: st.driverError } : {}),
      permissions: st.permissions,
      locked: st.locked,
      ...(st.secureDesktop === true ? { secureDesktop: true } : {}),
      lockedAccessSupported: st.lockedAccessSupported,
      lockedAccessEnabled: st.lockedAccessEnabled,
      lockedAccessReady: st.lockedAccessReady,
      ...(st.lockedAccessNote ? { lockedAccessNote: st.lockedAccessNote } : {}),
      // 锁屏时的两条路线（Windows）：后台模式（不解锁）/ 解锁。AI 据此决定后台不够用时能不能升级到 foreground:true
      ...(st.backgroundSupported ? { backgroundReady: st.backgroundReady, unlockReady: st.unlockReady } : {}),
      session: st.session,
    };
  };

  // ── 对外：server 请求 ──

  const AUDIT_OP_FIELDS = (op, args) => (op === "desktop_open_app" ? { app: String(args?.name ?? "").slice(0, 80) } : {});

  /**
   * @param {string} op DESKTOP_OPS 之一
   * @param {Record<string, unknown>} args
   * @param {{ taskId: string, signal?: AbortSignal }} ctx
   */
  const handleOp = async (op, args, ctx) => {
    if (!DESKTOP_OPS.includes(op)) throw bad(`未知的桌面操作：${String(op).slice(0, 40)}`);
    if (typeof ctx?.taskId !== "string" || ctx.taskId === "") throw bad("缺少 taskId");
    // 已经被取消的请求不要去开会话（开会话可能触发自动解锁）
    checkAborted(ctx.signal);
    // 设置页正在「测试锁屏可用」（会真的锁屏再解锁）：这段时间不接 AI 的桌面请求。
    // 否则 AI 在锁屏瞬间开会话 = 和测试流程抢着解锁，两边的键盘注入还会交错到同一个密码框里
    if (testing && op !== "desktop_status") {
      throw new DesktopError(
        "DENIED",
        testingKind === "background"
          ? "用户正在设置页测试「锁屏后台操作」（约 20 秒，期间电脑会锁屏），请稍等片刻再重试"
          : "用户正在设置页测试「锁屏时也能用」（约 15 秒，期间电脑会短暂锁屏再解锁），请稍等片刻再重试",
      );
    }
    const a = isRecord(args) ? args : {};
    const t0 = now();
    try {
      let result;
      if (op === "desktop_status") result = await statusOp();
      else if (INPUT_OPS[op]) result = await runInputOp(op, a, ctx);
      else result = await READ_OPS[op](a, ctx);
      // _audit 是给审计用的内部字段，不回传给 server
      const { _audit: auditExtra, ...publicResult } = result ?? {};
      audit.write({ type: "action", op, taskId: ctx.taskId, ok: true, ms: now() - t0, ...AUDIT_OP_FIELDS(op, a), ...(auditExtra ?? {}) });
      return publicResult;
    } catch (err) {
      audit.write({ type: "action", op, taskId: ctx.taskId, ok: false, code: err?.code ?? "INTERNAL", ms: now() - t0, ...AUDIT_OP_FIELDS(op, a) });
      throw err;
    }
  };

  // ── 对外：生命周期联动 ──

  const onConfig = (c) => {
    const wasEnabled = cfg.enabled;
    if (typeof c?.desktopEnabled === "boolean") cfg.enabled = c.desktopEnabled;
    if (typeof c?.desktopLockedAccess === "boolean") cfg.lockedAccess = c.desktopLockedAccess;
    if (wasEnabled && !cfg.enabled) void session.end("disabled");
  };

  const onCancel = (taskId) => {
    void session.endForTask(taskId, "cancelled");
  };

  /**
   * 任务被删 / 归档（server 的 close_session）：该任务名下的会话一并结束，我们解锁的电脑锁回去。
   * 不能只靠空闲超时（最长 3 分钟）：任务都没了，没人会再来「结束」它。
   */
  const onTaskClosed = (taskId) => {
    void session.endForTask(taskId, "task_done");
  };

  /** server 子进程退出 / 通道断开：fail-closed，会话收尾（我们解锁的锁回去） */
  const onServerGone = () => {
    cfg = { enabled: false, lockedAccess: false };
    void session.end("server_gone");
  };

  const setEventSink = (fn) => {
    eventSink = typeof fn === "function" ? fn : null;
  };

  // ── 对外：设置页 IPC ──

  const requestPermission = async (kind) => {
    if (kind === "accessibility") perms.requestAccessibility();
    else if (kind === "screen") await perms.requestScreen();
    else throw bad("不认识的权限类型");
    // 授权提示框弹出后用户还要去系统设置里勾选：顺手把对应页面打开
    await perms.openSettings(kind).catch((err) => log(`[desktop-manager] 打开系统设置失败：${err?.message || err}`));
    return getStatus();
  };

  const openSettings = async (kind) => {
    if (kind !== "accessibility" && kind !== "screen") throw bad("不认识的权限类型");
    await perms.openSettings(kind);
  };

  const setCredential = async (input) => {
    const password = isRecord(input) ? input.password : undefined;
    if (typeof password !== "string" || password === "") return { ok: false, error: "密码不能为空" };
    if (!unlocker || unlocker.supported === false) return { ok: false, error: "当前系统暂不支持锁屏自动解锁" };
    let r;
    try {
      r = await unlocker.setCredential({ password });
    } catch (err) {
      // 这里是开机密码从设置页进主进程的入口，密码就在手上：解锁器（尤其是原生层）抛的异常文字可能回显了入参，
      // 抹掉整串密码后折成失败结果，不让异常带着密码一路抛到 IPC / 设置页（解锁器自己也会抹，这里是兜底）
      r = { ok: false, error: `保存开机密码时出错：${redactSecret(String(err?.message || err), password).slice(0, 160)}` };
    }
    const ok = r?.ok === true;
    // 密码已存好、冷却没清掉（Windows 解锁组件回 saved=1，解锁器给 saved:true）：既不是成功（自动解锁还没恢复），也不是「没存上」。
    // 审计单独记一种 kind，排查时一眼分得清「密码有问题」和「冷却清不掉」；只认严格的 true，别的值不当成存上了。审计只有 type / kind，没有密码也没有长度
    const savedButCooldownKept = !ok && r?.saved === true;
    audit.write({
      type: "session",
      kind: ok ? "credential_set" : savedButCooldownKept ? "credential_set_cooldown_kept" : "credential_set_failed",
    });
    // 用户亲自重新保存了开机密码：之前的自动解锁失败多半是旧密码不对，冷却不再作数，立刻解除。
    // （这是冷却唯一的「人工」出口——没有任何绕过它的开关，免得多输一次密码离账户锁定更近）
    // 只在真的成功时解除：「已保存但冷却没清掉」说明组件那边的冷却还在，会话层不能自说自话放行（放行后组件照样拒，用户更糊涂）
    if (ok) session.resetUnlockCooldown();
    if (ok) return { ok: true };
    return { ok: false, ...(savedButCooldownKept ? { saved: true } : {}), error: redactSecret(r?.error ?? "保存失败", password) };
  };

  /** 删除已保存的开机密码。返回真实结果：钥匙串里没删掉就如实说（审计也只在真删掉时记 credential_cleared） */
  const clearCredential = async () => {
    if (!unlocker) return { ok: true };
    let r;
    try {
      r = await unlocker.clearCredential();
    } catch (err) {
      r = { ok: false, error: `删除开机密码时出错：${String(err?.message || err).slice(0, 120)}` };
    }
    const ok = r?.ok === true;
    audit.write({ type: "session", kind: ok ? "credential_cleared" : "credential_clear_failed" });
    return ok ? { ok: true } : { ok: false, error: r?.error ?? "没能删除已保存的开机密码" };
  };

  /**
   * 安装 / 卸载解锁组件（Windows：会弹系统管理员授权框，只由用户在设置页亲自触发）。
   * AI 正在用电脑时不动它（安装 / 卸载会重启 / 删掉解锁服务）。返回真实结果，审计只记成败不记细节。
   */
  const runHelperAdmin = async (method, auditOk, auditFail, doing) => {
    if (!unlocker || typeof unlocker[method] !== "function") return { ok: false, error: "当前系统不需要安装解锁组件" };
    if (session.status().state !== "idle") return { ok: false, error: `AI 正在使用电脑，等它结束后再${doing}` };
    let r;
    try {
      r = await unlocker[method]();
    } catch (err) {
      r = { ok: false, error: `${doing}时出错：${String(err?.message || err).slice(0, 160)}` };
    }
    const ok = r?.ok === true;
    audit.write({ type: "session", kind: ok ? auditOk : auditFail });
    return ok ? { ok: true } : { ok: false, error: String(r?.error ?? `${doing}失败`).slice(0, 300) };
  };
  const installUnlockHelper = () => runHelperAdmin("installHelper", "unlock_helper_installed", "unlock_helper_install_failed", "安装解锁组件");
  const uninstallUnlockHelper = async () => {
    const r = await runHelperAdmin("uninstallHelper", "unlock_helper_uninstalled", "unlock_helper_uninstall_failed", "卸载解锁组件");
    // 卸载后保存的密码也没了：之前的解锁失败冷却不再有意义
    if (r.ok) session.resetUnlockCooldown();
    return r;
  };

  /** @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>} */
  const runLockedAccessTest = async () => {
    /** @type {Array<{ name: string, ok: boolean, ms: number, detail?: string }>} */
    const steps = [];
    const add = (name, ok, ms, detail) => steps.push({ name, ok, ms, ...(detail ? { detail } : {}) });
    const fail = (error) => ({ ok: false, steps, error });

    const init = await ensureReady();
    if (!init.ok) return fail(init.error);
    if (!cfg.enabled) return fail("请先打开「电脑操作」开关并保存设置");
    if (!cfg.lockedAccess) return fail("请先打开「锁屏时也能用」开关并保存设置");
    if (!unlocker || unlocker.supported === false) return fail("当前系统暂不支持锁屏自动解锁");
    // Windows：密码存在解锁组件里，没装组件就没有「保存开机密码」这回事
    if (typeof unlocker.helperStatus === "function") {
      let h;
      try {
        h = await unlocker.helperStatus();
      } catch {
        h = { installed: false };
      }
      if (h?.installed !== true) return fail("还没有安装解锁组件：请先在设置里安装「解锁组件」（需要管理员授权一次），再保存开机密码");
    }
    if (!(await unlocker.hasCredential())) return fail("还没有保存开机密码");
    const p = permissionSnapshot();
    if (platform === "darwin" && (p.accessibility !== "granted" || p.screen !== "granted")) return fail("还缺系统权限：辅助功能 / 屏幕录制都要授权");
    if (session.status().state !== "idle") return fail("AI 正在使用电脑，等它结束后再测试");
    if (driver.isScreenLocked() === true) return fail("电脑现在已经是锁屏状态，请先解锁再测试");
    // 以下几项都要在「真的锁屏」之前确认：测试会把用户的电脑锁上，要是明知解不开（冷却中 / 密码读不出 / 密码打不出），
    // 用户只会得到一台被锁住、要手动输密码的电脑。冷却没有任何绕过入口——多输一次错误密码离账户锁定更近
    const cooldownUntil = session.status().unlockCooldownUntil;
    if (cooldownUntil > 0) {
      const mins = Math.max(1, Math.ceil((cooldownUntil - now()) / 60_000));
      return fail(`刚刚自动解锁失败过，为避免连续输错密码导致账户被锁定，暂时不能测试（约 ${mins} 分钟后恢复；重新保存开机密码会立刻解除）。这次没有锁屏`);
    }
    if (typeof unlocker.checkCredential === "function") {
      let c;
      try {
        c = await unlocker.checkCredential();
      } catch (err) {
        c = { ok: false, error: String(err?.message || err).slice(0, 160) };
      }
      if (c?.ok !== true) return fail(`${c?.error ?? "保存的开机密码读不出来，请重新保存"}。这次没有锁屏`);
    }

    // 给用户把手拿开的时间（解锁前要求键鼠已空闲几秒）
    let t = now();
    await sleep(limits.testCountdownMs);
    add("countdown", true, now() - t);
    // 倒计时的 5 秒里情况可能变了（极窄的竞态：AI 刚好开了会话 / 用户自己把电脑锁了）：这时再锁屏，
    // 要么把 AI 的操作锁断，要么和它抢着解锁。重新确认一次，不满足就取消、不锁
    if (session.status().state !== "idle") return fail("倒计时期间 AI 开始使用电脑了，测试已取消（没有锁屏）");
    if (driver.isScreenLocked() === true) return fail("倒计时期间电脑已经被锁屏了，测试已取消");

    t = now();
    try {
      await driver.lockScreen();
    } catch (err) {
      add("lock", false, now() - t, String(err?.message || err).slice(0, 120));
      return fail("锁屏命令失败");
    }
    const lockDeadline = now() + limits.testLockWaitMs;
    let locked = false;
    while (now() < lockDeadline) {
      if (driver.isScreenLocked() === true) {
        locked = true;
        break;
      }
      await sleep(200);
    }
    add("lock", locked, now() - t);
    if (!locked) return fail("发出了锁屏命令，但电脑没有进入锁屏状态");

    // 让锁屏界面稳定，也让键鼠空闲时间超过「用户在场」阈值
    await sleep(limits.testLockSettleMs);

    t = now();
    try {
      // foreground：测的就是「解锁」这条路线（Windows 上不加它会走不解锁的后台档，测了个寂寞）
      await session.begin(SETTINGS_TEST_TASK, { allowUnlock: true, foreground: true });
    } catch (err) {
      for (const s of lastUnlockSteps) add(`unlock.${s.name}`, s.ok, s.ms);
      add("unlock", false, now() - t, String(err?.message || err).slice(0, 200));
      return fail(String(err?.message || err));
    }
    for (const s of lastUnlockSteps) add(`unlock.${s.name}`, s.ok, s.ms);
    add("unlock", true, now() - t);
    // 遮罩自检：此刻遮罩盖着、会话还开着——主动对照一次「AI 能不能截到遮罩下面的真实屏幕」。
    // （macOS 上有的系统版本会把遮罩截进画面，AI 就只能看到一页遮罩；守卫发现后会改成截图时短暂撤遮罩，这里把结果摆给用户看）
    // 自检本身出错 / 不通过只影响这一项和总结果，解锁已经成功这件事不变；无论如何都要走到下面的收尾
    let overlayOk = true;
    if (typeof screenshotter.selfCheck === "function") {
      t = now();
      let r;
      try {
        r = await screenshotter.selfCheck();
      } catch (err) {
        r = { ok: false, detail: `遮罩自检出错：${String(err?.message || err).slice(0, 160)}` };
      }
      // 只认明确的 ok:true——自检没给出结果（返回了空 / 不认识的东西）不能当成「通过」
      overlayOk = r?.ok === true;
      const note = typeof r?.detail === "string" && r.detail ? r.detail : overlayOk ? undefined : "遮罩自检没有给出结果";
      add("overlay.capture", overlayOk, now() - t, note?.slice(0, 300));
    }
    // 测试完成：停在桌面，不再锁回去（用户就在电脑前）
    await session.end("explicit", { relock: false });
    if (!overlayOk) {
      return { ok: false, steps, error: "自动解锁没有问题，但遮罩盖着的时候截图不正常（AI 可能看不到真实屏幕），详见上面的 overlay.capture" };
    }
    return { ok: true, steps };
  };

  /**
   * 设置页「测试锁屏可用」：5 秒倒计时 → 锁屏 → 走完整的自动解锁流程 → 停在桌面（不再锁回去）。
   * 会真的锁屏并解锁这台电脑，所以只由用户在设置页亲自触发；同一时刻只允许一次（连点两下不能锁两遍屏）。
   * @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>}
   */
  const testLockedAccess = async () => {
    if (testing) return { ok: false, steps: [], error: "测试正在进行中，请等它结束" };
    testing = true;
    testingKind = "unlock";
    try {
      return await runLockedAccessTest();
    } finally {
      testing = false;
    }
  };

  /** @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>} */
  const runBackgroundTest = async () => {
    /** @type {Array<{ name: string, ok: boolean, ms: number, detail?: string }>} */
    const steps = [];
    const fail = (error) => ({ ok: false, steps, error });
    if (!background?.probe) return fail("当前系统没有锁屏后台模式");
    const init = await ensureReady();
    if (!init.ok) return fail(init.error);
    const bg = await ensureBackground();
    if (!bg.ok) return fail(`后台组件没有就绪：${bg.error}`);
    if (!cfg.enabled) return fail("请先打开「电脑操作」开关并保存设置");
    if (!cfg.lockedAccess) return fail("请先打开「锁屏时也能用」开关并保存设置");
    if (session.status().state !== "idle") return fail("AI 正在使用电脑，等它结束后再测试");
    if (driver.isScreenLocked() === true) return fail("电脑现在已经是锁屏状态，请先解锁再测试");
    let r;
    try {
      r = await background.probe.run({
        // 探针自己会倒计时 / 锁屏；这里只兜「AI 在期间开了会话」这种极窄的竞态（handleOp 在测试期间本来就不接请求）
        shouldAbort: () => session.status().state !== "idle",
        onStep: (s) => steps.push({ name: s.name, ok: s.ok, ms: s.ms, ...(s.detail ? { detail: String(s.detail).slice(0, 400) } : {}) }),
      });
    } catch (err) {
      r = { ok: false, steps, error: `后台操作测试出错：${String(err?.message || err).slice(0, 200)}` };
    }
    const result = { ok: r?.ok === true, steps: Array.isArray(r?.steps) && r.steps.length > 0 ? r.steps : steps, ...(r?.error ? { error: String(r.error).slice(0, 400) } : {}) };
    lastBackgroundProbe = { at: new Date(now()).toISOString(), ok: result.ok, steps: result.steps, ...(result.error ? { error: result.error } : {}) };
    audit.write({ type: "session", kind: result.ok ? "background_probe_ok" : "background_probe_failed" });
    return result;
  };

  /**
   * 设置页「测试后台操作」（Windows）：倒计时 → 开一个经典控制台窗口 → 锁屏 → 在锁屏状态下对它截图、往里打字、读标题验证。
   * 会真的锁屏，而且测完不会（也无法）解锁——用户自己解锁。同一时刻只允许一次；期间不接 AI 的桌面请求。
   * @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, ms: number, detail?: string }>, error?: string }>}
   */
  const testBackground = async () => {
    if (testing) return { ok: false, steps: [], error: "测试正在进行中，请等它结束" };
    testing = true;
    testingKind = "background";
    try {
      return await runBackgroundTest();
    } finally {
      testing = false;
    }
  };

  /** 诊断快照抛异常不能让整个诊断导出失败 */
  const safeDiagnostics = (fn) => {
    try {
      return fn();
    } catch (err) {
      return { error: `读取诊断信息出错：${String(err?.message || err).slice(0, 120)}` };
    }
  };

  const exportDiagnostics = async () => {
    const init = await ensureReady();
    const st = await getStatus();
    const body = {
      generatedAt: new Date(now()).toISOString(),
      app: { name: appInfo.name ?? null, version: appInfo.version ?? null, electron: appInfo.electron ?? process.versions.electron ?? null },
      os: { platform, release: os.release(), arch: process.arch },
      driver: init.ok ? driver.diagnostics() : { ready: false, error: init.error },
      // 锁屏后台档：绑定了哪些函数、哪些没绑上（真机排查用）+ 最近一次「测试后台操作」的逐步结果。没有任何用户内容
      ...(background
        ? {
            background: {
              ready: backgroundRouteReady(),
              ...(backgroundResult && !backgroundResult.ok ? { error: backgroundResult.error } : {}),
              driver: safeDiagnostics(() => background.driver.diagnostics()),
              lastProbe: lastBackgroundProbe,
            },
          }
        : {}),
      status: st,
      recentUnlockSteps: lastUnlockSteps,
      // 遮罩会不会被系统截进画面（unknown = 还没遇到过需要判断的画面；exposed = 会，截图前要短暂撤遮罩）
      captureMode: typeof screenshotter.getMode === "function" ? screenshotter.getMode() : null,
    };
    await fsImpl.mkdir(userDataDir, { recursive: true });
    const file = path.join(userDataDir, `desktop-diagnostics-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.json`);
    await fsImpl.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { path: file };
  };

  const destroy = () => {
    session.destroy();
    frames.clear();
    eventSink = null;
  };

  return {
    capabilities: () => [DESKTOP_CAPABILITY],
    isDesktopOp: (op) => typeof op === "string" && DESKTOP_OPS.includes(op),
    handleOp,
    onConfig,
    onCancel,
    onTaskClosed,
    onServerGone,
    setEventSink,
    getStatus,
    requestPermission,
    openSettings,
    setCredential,
    clearCredential,
    installUnlockHelper,
    uninstallUnlockHelper,
    testLockedAccess,
    testBackground,
    exportDiagnostics,
    destroy,
    /** 测试用 */
    _session: session,
  };
};
