/**
 * Windows「锁屏后台档」驱动：电脑锁屏期间，不解锁、不碰真实键鼠，直接对用户桌面上已经打开的应用窗口操作。
 *
 * 为什么能做：锁屏只是把「输入桌面」切到了 Winlogon（SYSTEM 独占的安全桌面）。用户桌面（Default）上的进程照常运行、
 * 窗口句柄照常有效，同一用户的进程可以 PostMessage 给它们、也可以对单个窗口 PrintWindow。
 * 为什么不是万能的：SendInput / BitBlt 全屏截图 / SetForegroundWindow 在锁屏时都不管用；依赖 GPU / DirectComposition 的应用
 * （Chromium、Electron 系：浏览器、飞书、VS Code…）锁屏时窗口被当成「被遮挡」，会停止渲染，可能操作不动或截出来是旧画面。
 * 所以它是「锁屏后台档」：能用就省去解锁；用不了，上层会让 AI 升级到「前台档」（系统级解锁，需要用户另行授权）。
 *
 * 做法：
 * - 截图 = 枚举主屏上的可见顶层窗口（Z 序从上到下）→ 逐个 CreateCompatibleBitmap + PrintWindow(PW_RENDERFULLCONTENT) + GetDIBits
 *   → 按 Z 序从下到上叠到一张主屏大小的画布上（空白 / 失败的窗口会在结果里标出来）；
 * - 点击 / 拖拽 / 滚轮 = 先在 Z 序里找屏幕点命中的最上层窗口，再逐级 ChildWindowFromPointEx 找到最深的子控件，
 *   把屏幕坐标换成它的客户区坐标，PostMessage 鼠标消息；
 * - 键盘 = PostMessage 到目标窗口所在线程的焦点控件（取不到就用最近点过的控件 / 最上层窗口）；
 * - 第一次对一个窗口操作前，先补一条 WM_ACTIVATE + WM_SETFOCUS 让应用以为自己被激活了（Qt / Chromium 不认「非激活窗口」的键盘消息）。
 *
 * ⚠️ 全部是「尽力而为」，且项目里没有 Windows 机器：这里只在 Mac 上验证了「调用序列 / 参数 / 布局」。
 * 真机需要确认的假设（逐条对照）：
 *  1. 锁屏时 PrintWindow(PW_RENDERFULLCONTENT) 对经典 Win32 / WinUI / Qt 窗口能画出内容；对 Chromium 系大概率画旧帧或空白；
 *  2. 锁屏时 GetDC(NULL) / CreateCompatibleBitmap 照常可用；
 *  3. 锁屏时 PostMessage 到别的进程的窗口照常投递（同用户、同完整性级别；管理员权限的窗口会被 UIPI 拦下，PostMessageW 返回 0）；
 *  4. WM_ACTIVATE + WM_SETFOCUS 能让 Qt / Chromium 把后续键盘消息当真；
 *  5. conhost / Edit 控件对 WM_CHAR 的反应（自检用 conhost 的窗口标题自动验证这一条）；
 *  6. koffi 的 .async 对 PrintWindow 可用（没有 .async 时退回同步调用，窗口无响应时会卡住主线程）。
 *
 * 隐私：typeText 的文本可能是密码。文本只进消息参数，不进任何日志 / 错误信息（错误里连长度都不带）。
 *
 * 依赖注入：所有系统调用都经 ctx（驱动传入）；本文件不 import koffi / electron，Mac 上可以用假 ctx 整条单测。
 *
 * @typedef {Object} BackgroundContext
 * @property {() => any} getKoffi                             驱动 init 之后的 koffi
 * @property {() => void} ensureLoaded                        驱动没 init 成功就抛 UNSUPPORTED
 * @property {(name: string, ...args: any[]) => any} callCore 驱动里已绑定的 Win32 函数（EnumWindows / GetWindowRect…）
 * @property {(name: string) => boolean} hasCore
 * @property {() => number | null} lastErrorCode
 * @property {(pid: number) => string} queryProcessName
 * @property {(hwnd: any) => boolean} isCloaked
 * @property {() => { x: number, y: number, width: number, height: number }} getPrimaryDisplay
 * @property {(vk: number) => number} scanOf
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {(message: string) => void} say
 * @property {number} ownPid                                  本进程 pid：Flowship 自己的窗口（遮罩等）不进截图 / 命中测试
 * @property {number} [maxFrameBytes]                         一帧里所有窗口位图合起来的内存上限（字节），缺省 256MB；测试用
 * @property {(target: string, opts: { background: boolean }) => Promise<void>} openApp
 */
import { DesktopError } from "../types.mjs";
import {
  CWP,
  DIB_RGB_COLORS,
  DWMWA_EXTENDED_FRAME_BOUNDS,
  GWL_EXSTYLE,
  PW_RENDERFULLCONTENT,
  REQUIRED_BG_FUNCTIONS,
  SHELL_CLASS_NAMES,
  WA_ACTIVE,
  WIN32_BG_FUNCTIONS,
  WIN32_BG_LIBRARIES,
  WM,
  WS_EX,
  bitmapInfoHeader,
  defineBackgroundTypes,
  expectedBackgroundSizes,
  guiThreadInfo,
} from "./win32-bg-defs.mjs";
import {
  BG_DRAG_STEPS,
  BG_TYPE_BATCH_GAP_MS,
  BG_TYPE_MAX_UNITS,
  batchBackgroundTyping,
  bgButton,
  bitmapBlankness,
  composeFrame,
  isClickThrough,
  isEditClass,
  makeLParam,
  pickWindowAt,
  planBackgroundKey,
  planBackgroundTyping,
  planBlit,
  planClickMessages,
  planDragPoints,
  planWheelMessages,
  renderKeySteps,
  renderTypingItem,
} from "./win32-bg-pure.mjs";

// ═══════════════════════════ 参数 ═══════════════════════════

/** 一帧最多合成多少个窗口（Z 序从上到下取；再多的窗口多半被盖住） */
const MAX_CAPTURE_WINDOWS = 24;
/** 单个窗口位图的像素上限（4096×4096，约 64MB），超过就跳过，免得一个巨型窗口把内存吃光 */
const MAX_BITMAP_PIXELS = 4096 * 4096;
/**
 * 一帧里所有窗口位图合起来的内存上限（字节）：合成之前每个窗口的整张位图（宽 × 高 × 4）都要留着，
 * 24 个窗口 × 单个最大约 64MB 可以到 1.5GB，会把主进程吃垮（第三轮评审）。窗口是从上到下取的：
 * 预算用完后更下面（多半已经被盖住）的窗口记 skipped、不再 PrintWindow。ctx.maxFrameBytes 可覆盖（测试用）。
 * 超时搁置着的位图（PrintWindow 还没返回，位图还活着）也算在里面，那次调用返回了才归还（第四轮评审 C3）：
 * 副作用是永远不返回的大窗口会一直占着预算，占满之后后面的窗口都只能记 skipped——位图确实还占着内存，再建新的只会更糟。
 */
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
/**
 * PrintWindow 的等待上限；超时的窗口 HUNG_SKIP_MS 内不再尝试，那次调用还没返回就一直不再对它发新的
 * （它的 DC / 位图要等那次调用返回了才能释放，见 releaseWhenSettled）
 */
const PRINT_TIMEOUT_MS = 3000;
const HUNG_SKIP_MS = 60_000;
/** 窗口类名最多读多少字符 */
const CLASS_CHARS = 256;
/** ChildWindowFromPointEx 逐级下钻的最大层数 */
const MAX_CHILD_DEPTH = 12;
/** 对同一个顶层窗口，多久之内不重复发 WM_ACTIVATE / WM_SETFOCUS */
const ACTIVATE_TTL_MS = 60_000;
/** 「最近点过的控件」多久之内还算数（超过就退回最上层窗口，免得把字打进很久以前点过的窗口） */
const LAST_TARGET_TTL_MS = 5 * 60_000;
/** 拖拽默认时长（同前台驱动） */
const DRAG_DEFAULT_MS = 300;
const DRAG_MAX_MS = 10_000;

// ═══════════════════════════ 小工具 ═══════════════════════════

const badArgs = (message) => new DesktopError("BAD_ARGS", message);

const internalError = (message, cause) => {
  const err = new DesktopError("INTERNAL", message);
  if (cause !== undefined) err.cause = cause;
  return err;
};

const describe = (e) => String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 200);
const isNullHandle = (h) => h === null || h === undefined || h === 0 || h === 0n;

const toCoord = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw badArgs(`${name} 必须是有限数字（屏幕坐标）`);
  const n = Math.round(value);
  if (n < -2147483648 || n > 2147483647) throw badArgs(`${name} 超出屏幕坐标的取值范围`);
  return n;
};

const dragDuration = (value) => {
  if (value === undefined || value === null) return DRAG_DEFAULT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw badArgs("durationMs 必须是不小于 0 的数字（毫秒）");
  return Math.min(value, DRAG_MAX_MS);
};

/** 读 UTF-16LE 缓冲区：到第一个 NUL 或 maxChars 为止 */
const decodeWide = (buf, maxChars = buf.length / 2) => {
  const limit = Math.min(Math.floor(buf.length / 2), maxChars);
  let end = 0;
  while (end < limit && buf.readUInt16LE(end * 2) !== 0) end += 1;
  return buf.toString("utf16le", 0, end * 2);
};

const TIMED_OUT = Symbol("timed-out");

// ═══════════════════════════ 驱动 ═══════════════════════════

/**
 * @param {BackgroundContext} ctx
 */
export const createWin32Background = (ctx) => {
  const state = {
    initialized: false,
    ready: false,
    error: null,
    /** 已绑定的后台档函数：登记名 → koffi 函数 */
    fns: {},
    /** @type {string[]} */
    bindFailures: [],
    /** @type {Record<string, string>} */
    bindErrors: {},
    /** @type {Record<string, string>} */
    typeProblems: {},
    /** @type {Record<string, number>} */
    sizes: {},
    /** 顶层窗口 → 上次发 WM_ACTIVATE 的时间 */
    activated: new Map(),
    /** 无响应的窗口 → 在这个时间之前不再尝试截图 */
    hung: new Map(),
    /** PrintWindow 超时后还没返回的窗口 → 那次调用占着的 GDI 对象 + bytes（位图字节数）（返回之前不能释放；有记录的窗口不再发新的 PrintWindow；bytes 计入整帧内存预算） */
    stuckPrints: new Map(),
    /** 最近点过的 { top, target, at } */
    lastTarget: null,
  };

  // ─────────── FFI ───────────

  const ensureReady = () => {
    ctx.ensureLoaded();
    if (!state.initialized) throw new DesktopError("UNSUPPORTED", "锁屏后台档尚未初始化（需要先成功调用 background.init()）");
    if (!state.ready) throw new DesktopError("UNSUPPORTED", state.error ?? "锁屏后台档不可用");
  };

  const has = (name) => Boolean(state.fns[name]) || ctx.hasCore(name);

  /** 调用一个函数：后台档自己的优先，其次是驱动里已绑定的 */
  const call = (name, ...args) => {
    const own = state.fns[name];
    if (!own) return ctx.callCore(name, ...args);
    try {
      return own(...args);
    } catch (cause) {
      throw internalError(`调用 Win32 ${name} 出错：${describe(cause)}`, cause);
    }
  };

  /** 可能卡住的调用（PrintWindow 会向窗口所在线程发消息）：有 koffi 的 .async 就走它；没有就同步调用 */
  const callAsync = (name, ...args) => {
    const f = state.fns[name];
    if (!f) return Promise.reject(new DesktopError("UNSUPPORTED", `当前系统缺少 Win32 函数 ${name}`));
    if (typeof f.async !== "function") {
      try {
        return Promise.resolve(f(...args));
      } catch (cause) {
        return Promise.reject(internalError(`调用 Win32 ${name} 出错：${describe(cause)}`, cause));
      }
    }
    return new Promise((resolve, reject) => {
      try {
        f.async(...args, (err, result) => {
          if (err) reject(internalError(`调用 Win32 ${name} 出错：${describe(err)}`, err));
          else resolve(result);
        });
      } catch (cause) {
        reject(internalError(`调用 Win32 ${name} 出错：${describe(cause)}`, cause));
      }
    });
  };

  /** 等 promise，最多 ms；超时返回 { timeout: true }；原 promise 的拒绝一律吞进结果里（不留未处理的拒绝） */
  const settleWithin = async (promise, ms) => {
    const result = await Promise.race([
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      ctx.sleep(ms).then(() => TIMED_OUT),
    ]);
    return result === TIMED_OUT ? { timeout: true } : result;
  };

  // ─────────── init ───────────

  /** 懒加载：第一次用后台档才绑定（gdi32 也是这时才 load）。可重复调用，结果缓存 */
  const init = async () => {
    if (state.initialized) return state.ready ? { ok: true } : { ok: false, error: state.error ?? "锁屏后台档不可用" };
    state.initialized = true;
    const fail = (error) => {
      state.error = error;
      ctx.say(`锁屏后台档不可用：${error}`);
      return { ok: false, error };
    };
    try {
      ctx.ensureLoaded();
    } catch (e) {
      return fail(describe(e));
    }
    const koffi = ctx.getKoffi();

    // 1) 结构体：定义 + 和期望大小对账（对不上就不绑定依赖它的函数）
    let types = null;
    try {
      types = defineBackgroundTypes(koffi);
    } catch (e) {
      const reason = `定义 Win32 结构体失败：${describe(e)}`;
      for (const name of ["POINT", "BITMAPINFOHEADER", "GUITHREADINFO"]) state.typeProblems[name] = reason;
    }
    if (types) {
      let pointerSize = 0;
      try {
        pointerSize = koffi.sizeof("void *");
      } catch {
        pointerSize = 0;
      }
      const expected = expectedBackgroundSizes(pointerSize);
      for (const name of Object.keys(types)) {
        try {
          const size = koffi.sizeof(types[name]);
          state.sizes[name] = size;
          if (expected && size !== expected[name]) state.typeProblems[name] = `${name} 的实测大小是 ${size}，应为 ${expected[name]}`;
        } catch (e) {
          state.typeProblems[name] = `读取 ${name} 的大小失败：${describe(e)}`;
        }
      }
    }

    // 2) 库
    const libs = {};
    const libErrors = {};
    for (const [id, file] of Object.entries(WIN32_BG_LIBRARIES)) {
      try {
        libs[id] = koffi.load(file);
      } catch (e) {
        libErrors[id] = describe(e);
      }
    }

    // 3) 函数
    for (const spec of WIN32_BG_FUNCTIONS) {
      const key = spec.key ?? spec.name;
      try {
        if (spec.needs && state.typeProblems[spec.needs]) throw new Error(state.typeProblems[spec.needs]);
        const lib = libs[spec.lib];
        if (!lib) throw new Error(`${WIN32_BG_LIBRARIES[spec.lib]} 加载失败：${libErrors[spec.lib]}`);
        state.fns[key] = lib.func(spec.proto);
      } catch (e) {
        state.bindFailures.push(key);
        state.bindErrors[key] = describe(e);
      }
    }

    // 4) 驱动里要先有这几个：枚举窗口 / 取矩形 / 取线程
    const coreNeeded = ["EnumWindows", "IsWindowVisible", "IsIconic", "GetWindowRect", "GetWindowThreadProcessId", "GetWindowTextW"];
    const coreMissing = coreNeeded.filter((name) => !ctx.hasCore(name));
    const missing = [...REQUIRED_BG_FUNCTIONS.filter((name) => !state.fns[name]), ...coreMissing];
    if (missing.length > 0) {
      const reasons = [...new Set(missing.map((name) => state.bindErrors[name]).filter(Boolean))].join("；");
      return fail(`缺少后台档必需的 Win32 函数：${missing.join("、")}${reasons ? `（${reasons}）` : ""}`);
    }
    state.ready = true;
    ctx.say(
      `锁屏后台档就绪` + (state.bindFailures.length > 0 ? `，${state.bindFailures.length} 个可选函数未绑定：${state.bindFailures.join("、")}` : ""),
    );
    return { ok: true };
  };

  // ─────────── 窗口枚举 ───────────

  const readClassName = (hwnd) => {
    if (!has("GetClassNameW")) return "";
    try {
      const buf = Buffer.alloc(CLASS_CHARS * 2);
      const n = Number(call("GetClassNameW", hwnd, buf, CLASS_CHARS));
      return n > 0 ? decodeWide(buf, n) : "";
    } catch {
      return "";
    }
  };

  const readRect = (hwnd) => {
    const rect = {};
    if (Number(call("GetWindowRect", hwnd, rect)) === 0) return null;
    return { left: Number(rect.left), top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom) };
  };

  /** DWM 的真实可见边界（不含 Win10+ 的透明阴影边框）；不可用 / 读不到返回 null */
  const readFrame = (hwnd) => {
    const f = state.fns.DwmFrameBounds;
    if (!f) return null;
    try {
      const rect = {};
      if (Number(f(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16)) !== 0) return null;
      const frame = { left: Number(rect.left), top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom) };
      return frame.right > frame.left && frame.bottom > frame.top ? frame : null;
    } catch {
      return null;
    }
  };

  const readExStyle = (hwnd) => {
    if (!has("GetWindowLongW")) return 0;
    try {
      return Number(call("GetWindowLongW", hwnd, GWL_EXSTYLE)) | 0;
    } catch {
      return 0;
    }
  };

  /**
   * 主屏上「可操作 / 可截」的顶层窗口，Z 序从上到下。
   * 排除：不可见、最小化、被系统隐藏（cloaked）、本进程的窗口、桌面壁纸 / 任务栏、点击穿透的覆盖层、没有面积的、不在主屏上的。
   * 最小化的窗口没有可用的内容（PrintWindow 画不出来），所以锁屏后台档只管「没最小化」的窗口。
   */
  const enumerate = () => {
    const handles = [];
    const ok = ctx.callCore(
      "EnumWindows",
      (hwnd) => {
        handles.push(hwnd);
        return 1;
      },
      0,
    );
    if (Number(ok) === 0) throw internalError(`枚举窗口失败（EnumWindows）${ctx.lastErrorCode() == null ? "" : `，Win32 错误码 ${ctx.lastErrorCode()}`}`);
    const display = ctx.getPrimaryDisplay();
    const out = [];
    for (const hwnd of handles) {
      if (Number(ctx.callCore("IsWindowVisible", hwnd)) === 0) continue;
      if (Number(ctx.callCore("IsIconic", hwnd)) !== 0) continue;
      if (ctx.isCloaked(hwnd)) continue;
      const pidOut = [0];
      const tid = Number(ctx.callCore("GetWindowThreadProcessId", hwnd, pidOut));
      const pid = Number(pidOut[0]);
      if (!pid || pid === ctx.ownPid) continue;
      const rect = readRect(hwnd);
      if (!rect) continue;
      const className = readClassName(hwnd);
      if (SHELL_CLASS_NAMES.includes(className)) continue;
      if (isClickThrough(readExStyle(hwnd), WS_EX)) continue;
      const frame = readFrame(hwnd) ?? rect;
      const width = frame.right - frame.left;
      const height = frame.bottom - frame.top;
      if (width <= 0 || height <= 0) continue;
      if (frame.right <= display.x || frame.left >= display.x + display.width) continue;
      if (frame.bottom <= display.y || frame.top >= display.y + display.height) continue;
      out.push({ hwnd, pid, tid, className, rect, frame, x: frame.left, y: frame.top, width, height });
    }
    return out;
  };

  // ─────────── 截图 ───────────

  const isHung = (hwnd) => {
    const until = state.hung.get(hwnd);
    if (until === undefined) return false;
    if (until > ctx.now()) return true;
    state.hung.delete(hwnd);
    return false;
  };

  /**
   * 释放一组 GDI 对象：先把旧位图选回 DC（还被选在 DC 里的位图删不掉），再删位图、删 DC。
   * 每一步各自兜住：一步出错不能让后面的步骤（尤其是删 DC）也被跳过——这些对象再不释放就永远泄漏了。
   * bitmap 可以是 NULL（位图没建成 / 建位图时抛了）：没有东西可删就跳过，只剩内存 DC 要删（第四轮评审 C2）。
   */
  const releaseGdi = ({ memDC, bitmap, previous }) => {
    const step = (what, fn) => {
      try {
        fn();
      } catch (cause) {
        ctx.say(`锁屏后台档释放 GDI 对象时${what}出错（已忽略）：${describe(cause)}`);
      }
    };
    if (!isNullHandle(previous)) step("还原旧位图", () => call("SelectObject", memDC, previous));
    if (!isNullHandle(bitmap)) step("删除位图", () => call("DeleteObject", bitmap));
    step("删除内存 DC", () => call("DeleteDC", memDC));
  };

  /**
   * PrintWindow 超时了、但那次调用还没返回：它的 DC / 位图现在不能释放——它可能还在往里画；而且 GDI 句柄值释放后会被系统
   * 重新分配给别的对象，晚到的绘制会写进不相干的东西里。所以搁置在 stuckPrints 里，等那次调用真的返回了（成功、失败都算）再释放。
   * 在它返回之前，这个窗口不再发新的 PrintWindow：窗口多半还卡着，再发只会多泄漏一组 DC + 位图（位图最大 64MB）、多占一个 koffi 工作线程。
   * bytes = 这个位图占的内存（宽 × 高 × 4，和 capture 里 retainedBytes 同口径）：位图在那次调用返回之前一直活着，
   * 所以一直算在整帧内存预算里，调用返回、记录删除那一刻才归还（第四轮评审 C3，见 stuckBytes）。
   */
  const releaseWhenSettled = (hwnd, gdiObjects, printCall, bytes) => {
    const record = { ...gdiObjects, bytes };
    state.stuckPrints.set(hwnd, record);
    const done = () => {
      if (state.stuckPrints.get(hwnd) === record) state.stuckPrints.delete(hwnd);
      releaseGdi(gdiObjects);
    };
    // 释放是尽力而为：这条回调里出的任何错都不能变成未处理的拒绝（主进程里会弹「JavaScript 错误」对话框）
    printCall.then(done, done).catch(() => {});
  };

  /**
   * 搁置着的位图一共占多少字节：超时的 PrintWindow 还没返回，位图还活着，哪怕这一帧没有把它合成进去，内存也还占着。
   * 不算进整帧预算的话，连续几个窗口超时就能让「已合成的 + 搁置的」悄悄超过上限（第四轮评审 C3）。
   */
  const stuckBytes = () => {
    let total = 0;
    for (const record of state.stuckPrints.values()) total += record.bytes;
    return total;
  };

  /**
   * 给一个窗口截图（整个窗口矩形，含不可见边框）。
   * @returns {Promise<{ status: "ok" | "blank" | "failed" | "timeout" | "skipped", data: Buffer | null, width: number, height: number }>}
   */
  const printWindow = async (hdcScreen, w) => {
    const width = w.rect.right - w.rect.left;
    const height = w.rect.bottom - w.rect.top;
    const result = (status, data = null) => ({ status, data, width, height });
    if (width <= 0 || height <= 0 || width * height > MAX_BITMAP_PIXELS) return result("skipped");
    if (isHung(w.hwnd)) return result("timeout");
    // 上一次对这个窗口的 PrintWindow 还没返回（哪怕已经过了 HUNG_SKIP_MS）：它还占着那一组 GDI 对象，窗口多半还卡着——不叠加新的
    if (state.stuckPrints.has(w.hwnd)) return result("timeout");
    const memDC = call("CreateCompatibleDC", hdcScreen);
    if (isNullHandle(memDC)) return result("failed");
    // 建位图、把它选进 DC 这两步任何一步抛错（koffi 同步抛）：前面已建好的内存 DC（和位图）此刻没有任何人持有，
    // 抛出去之前先释放，否则每抛一次就永久泄漏一个 DC（第四轮评审 C2）。位图没建成（返回 NULL）同理：只剩 DC 要删，且走同一套每步兜住的释放。
    // 极端情况：SelectObject 是「调用已发出、之后才抛」的话位图可能还选在 DC 里，删不掉（只泄漏位图）；koffi 的同步抛错几乎都发生在参数转换阶段，调用根本没发出
    let bitmap = null;
    let previous = null;
    try {
      bitmap = call("CreateCompatibleBitmap", hdcScreen, width, height);
      if (!isNullHandle(bitmap)) previous = call("SelectObject", memDC, bitmap);
    } catch (cause) {
      releaseGdi({ memDC, bitmap, previous: null });
      throw cause;
    }
    if (isNullHandle(bitmap)) {
      releaseGdi({ memDC, bitmap: null, previous: null });
      return result("failed");
    }
    let printed = false;
    let failed = false;
    // callAsync 永不同步抛（koffi 的同步抛错也被它包成了拒绝的 promise），所以从这里到下面的 try 之间没有会漏掉 GDI 对象的出口
    const printCall = callAsync("PrintWindow", w.hwnd, memDC, PW_RENDERFULLCONTENT);
    const settled = await settleWithin(printCall, PRINT_TIMEOUT_MS);
    if (settled.timeout) {
      // 这时不能释放 memDC / bitmap（PrintWindow 可能还在往里画）：搁置，等那次调用返回了再释放
      state.hung.set(w.hwnd, ctx.now() + HUNG_SKIP_MS);
      releaseWhenSettled(w.hwnd, { memDC, bitmap, previous }, printCall, width * height * 4);
      return result("timeout");
    }
    if (settled.error) failed = true;
    else printed = Number(settled.value) !== 0;

    let data = null;
    let restored = false;
    try {
      // 位图不能同时被选在某个 DC 里才能 GetDIBits：先把旧位图选回去
      if (!isNullHandle(previous)) call("SelectObject", memDC, previous);
      restored = true;
      if (printed) {
        const buf = Buffer.alloc(width * height * 4);
        const info = bitmapInfoHeader({ size: state.sizes.BITMAPINFOHEADER ?? 40, width, height });
        const lines = Number(call("GetDIBits", memDC, bitmap, 0, height, buf, info, DIB_RGB_COLORS));
        if (lines === height) data = buf;
        else failed = true;
      }
    } finally {
      // 逐步释放、每一步各自兜住（第三轮评审「GDI 句柄」）：以前这里两个裸 call——DeleteObject 一抛，DeleteDC 就被跳过，内存 DC 永远泄漏；
      // 「把旧位图选回去」抛了的话位图还选在 DC 里、删不掉。统一走 releaseGdi（超时路径用的那一个）：没选回去的这里补选一次，
      // 出错只记日志、不盖掉 try 里已有的错误（也不让「截图成功」因为释放时的小毛病变成失败）
      releaseGdi({ memDC, bitmap, previous: restored ? null : previous });
    }
    if (failed || !printed || !data) return result("failed");
    return result(bitmapBlankness(data, width * height).blank ? "blank" : "ok", data);
  };

  /**
   * 合成一张「主屏」的截图（BGRA）。
   * @returns {Promise<{
   *   width: number, height: number, bgra: Buffer, elapsedMs: number,
   *   windows: Array<{ className: string, processName: string, x: number, y: number, width: number, height: number, status: string }>
   * }>}
   */
  const capture = async () => {
    ensureReady();
    const started = ctx.now();
    const display = ctx.getPrimaryDisplay();
    const wins = enumerate().slice(0, MAX_CAPTURE_WINDOWS);
    const hdcScreen = call("GetDC", null);
    if (isNullHandle(hdcScreen)) throw internalError("取屏幕设备上下文失败（GetDC），没法截图");
    const layers = [];
    const reports = [];
    const budget = ctx.maxFrameBytes ?? MAX_FRAME_BYTES;
    let retainedBytes = 0;
    try {
      for (const w of wins) {
        const width = w.rect.right - w.rect.left;
        const height = w.rect.bottom - w.rect.top;
        // 这个窗口的位图放进来会超预算：不截了（上面的窗口已经截到了），记 skipped 让 AI 知道下面还有窗口没画
        // 预算里要算上搁置着的位图（超时的 PrintWindow 还没返回、位图还活着）：每个窗口都重新算——本帧里刚超时的那个，从这一刻起就占着预算（第四轮评审 C3）。
        // 窗口自己正搁置着的话不会再建位图（printWindow 直接报 timeout），它那一份已经在 stuckBytes 里了，不再算第二遍——
        // 否则预算紧张时，一个无响应的窗口会被错报成 skipped
        const ownBytes = state.stuckPrints.has(w.hwnd) ? 0 : Math.max(0, width) * Math.max(0, height) * 4;
        const overBudget = retainedBytes + stuckBytes() + ownBytes > budget;
        const shot = overBudget ? { status: "skipped", data: null, width, height } : await printWindow(hdcScreen, w);
        reports.push({
          className: w.className,
          processName: ctx.queryProcessName(w.pid),
          x: w.x,
          y: w.y,
          width: w.width,
          height: w.height,
          status: shot.status,
        });
        if (!shot.data) continue;
        const blit = planBlit(display, w.rect, w.frame);
        if (!blit) continue;
        layers.push({ data: shot.data, bitmapWidth: shot.width, ...blit });
        retainedBytes += shot.data.length;
      }
    } finally {
      call("ReleaseDC", null, hdcScreen);
    }
    // wins 是「从上到下」，合成要「从下到上」
    layers.reverse();
    const bgra = composeFrame({ width: display.width, height: display.height }, layers);
    return { width: display.width, height: display.height, bgra, elapsedMs: ctx.now() - started, windows: reports };
  };

  /** 只截一个窗口（自检用：比较打字前后窗口画面有没有变化） */
  const captureWindow = async (hwnd) => {
    ensureReady();
    const rect = readRect(hwnd);
    if (!rect) throw internalError("读取窗口矩形失败，窗口可能已经关闭");
    const hdcScreen = call("GetDC", null);
    if (isNullHandle(hdcScreen)) throw internalError("取屏幕设备上下文失败（GetDC），没法截图");
    try {
      return await printWindow(hdcScreen, { hwnd, rect });
    } finally {
      call("ReleaseDC", null, hdcScreen);
    }
  };

  // ─────────── 命中测试 / 目标窗口 ───────────

  const clientPoint = (hwnd, x, y) => {
    const point = { x, y };
    if (Number(call("ScreenToClient", hwnd, point)) === 0) {
      throw internalError("把屏幕坐标换成窗口坐标失败（ScreenToClient），窗口可能已经关闭");
    }
    return { x: Number(point.x), y: Number(point.y) };
  };

  /** 屏幕点 → { 顶层窗口记录, 最深的子控件, 子控件客户区坐标 } */
  const resolveTarget = (x, y) => {
    const top = pickWindowAt(enumerate(), x, y);
    if (!top) {
      throw badArgs(`屏幕位置 (${x}, ${y}) 上没有可以操作的窗口（锁屏后台模式只能操作已经打开、没有最小化的应用窗口，请先截图确认位置）`);
    }
    let target = top.hwnd;
    let descended = false;
    if (has("ChildWindowFromPointEx")) {
      for (let depth = 0; depth < MAX_CHILD_DEPTH; depth += 1) {
        const point = clientPoint(target, x, y);
        const child = call("ChildWindowFromPointEx", target, point, CWP.SKIPINVISIBLE | CWP.SKIPDISABLED | CWP.SKIPTRANSPARENT);
        if (isNullHandle(child) || child === target) break;
        target = child;
        descended = true;
      }
    }
    const point = clientPoint(target, x, y);
    // 没下钻到任何子控件、点又落在顶层窗口客户区原点的上方 / 左边：点的是标题栏 / 菜单栏 / 边框（非客户区）。
    // 鼠标消息是按客户区坐标发的，非客户区不处理它——操作会「成功返回、什么也没发生」。（自绘标题栏的应用——Chromium / Qt / WinUI
    // 无边框——标题栏本来就在客户区里，坐标 ≥ 0，不在此列。右 / 下边框读不到客户区大小，没有检查。）
    const nonClient = !descended && (point.x < 0 || point.y < 0);
    return { top, target, cx: point.x, cy: point.y, nonClient };
  };

  /**
   * 点击 / 拖拽的起点在窗口的标题栏、菜单栏或边框上：后台档做不到（要发 WM_NC* 消息才行，没有真机验证），明说、别假装成功。
   * 走 NEED_FOREGROUND：上层会告诉 AI 这个动作要先解锁（前台档，真实鼠标）才能做；解锁不可用就如实告诉用户。
   */
  const refuseNonClient = (hit) => {
    if (!hit.nonClient) return;
    throw new DesktopError(
      "NEED_FOREGROUND",
      "这个位置是窗口的标题栏 / 菜单栏 / 边框，不是窗口内容区：锁屏后台模式点不到（最大化 / 最小化 / 关闭 / 拖动窗口 / 经典菜单栏都在这里）。要操作它们得先解锁走前台；只想操作窗口里的内容，请点内容区里的控件",
    );
  };

  const post = (hwnd, msg, wParam, lParam) => {
    if (Number(call("PostMessageW", hwnd, msg, wParam, lParam)) === 0) {
      const code = ctx.lastErrorCode();
      throw internalError(
        `窗口没有接收消息${code == null ? "" : `（Win32 错误码 ${code}）`}：窗口可能已经关闭，或它是以管理员身份运行的程序（权限比 Flowship 高，系统会拦下消息）`,
      );
    }
  };

  /** 对一个顶层窗口第一次操作前：补 WM_ACTIVATE + WM_SETFOCUS（见头注释第 4 条）；ACTIVATE_TTL_MS 内不重复 */
  const wake = (top, target) => {
    const last = state.activated.get(top.hwnd);
    if (last !== undefined && ctx.now() - last < ACTIVATE_TTL_MS) return;
    post(top.hwnd, WM.ACTIVATE, WA_ACTIVE, 0);
    post(target, WM.SETFOCUS, 0, 0);
    state.activated.set(top.hwnd, ctx.now());
  };

  /** 键盘消息的目标：最近点过的窗口（还在、没过期）优先，否则最上层窗口；该线程有真焦点控件就用它 */
  const keyboardTarget = () => {
    const wins = enumerate();
    let top = null;
    let target = null;
    const last = state.lastTarget;
    if (last && ctx.now() - last.at < LAST_TARGET_TTL_MS) {
      top = wins.find((w) => w.hwnd === last.top.hwnd) ?? null;
      if (top) target = last.target;
    }
    if (!top) {
      top = wins[0] ?? null;
      target = top ? top.hwnd : null;
    }
    if (!top) throw badArgs("现在没有可以操作的窗口（锁屏后台模式只能操作已经打开、没有最小化的应用窗口）");
    if (has("GetGUIThreadInfo") && top.tid) {
      try {
        const info = guiThreadInfo({ size: state.sizes.GUITHREADINFO ?? 72 });
        if (Number(call("GetGUIThreadInfo", top.tid, info)) !== 0 && !isNullHandle(info.hwndFocus)) target = info.hwndFocus;
      } catch {
        /* 取不到焦点控件就用上面选好的 */
      }
    }
    return { top, target };
  };

  // ─────────── 鼠标 ───────────

  const mouseMove = async (x, y) => {
    ensureReady();
    const px = toCoord(x, "x");
    const py = toCoord(y, "y");
    const { top, target, cx, cy } = resolveTarget(px, py);
    wake(top, target);
    post(target, WM.MOUSEMOVE, 0, makeLParam(cx, cy));
  };

  const click = async (x, y, opts = {}) => {
    ensureReady();
    const px = toCoord(x, "x");
    const py = toCoord(y, "y");
    const button = opts?.button ?? "left";
    bgButton(button);
    const count = opts?.count ?? 1;
    const hit = resolveTarget(px, py);
    refuseNonClient(hit);
    const { top, target, cx, cy } = hit;
    const messages = planClickMessages({ button, count, lParam: makeLParam(cx, cy) });
    wake(top, target);
    const b = bgButton(button);
    let pressed = false;
    try {
      for (const m of messages) {
        post(target, m.msg, m.wParam, m.lParam);
        if (m.msg === b.down || m.msg === b.dbl) pressed = true;
        if (m.msg === b.up) pressed = false;
        if (m.gapMs > 0) await ctx.sleep(m.gapMs);
      }
    } catch (err) {
      // 按下了没抬起：补一个抬起，别让应用以为按钮一直按着
      if (pressed) {
        try {
          post(target, b.up, 0, makeLParam(cx, cy));
        } catch {
          /* 补救失败不覆盖原始错误 */
        }
      }
      throw err;
    }
    state.lastTarget = { top, target, at: ctx.now() };
  };

  const drag = async (from, to, opts = {}) => {
    ensureReady();
    const x0 = toCoord(from?.x, "from.x");
    const y0 = toCoord(from?.y, "from.y");
    const x1 = toCoord(to?.x, "to.x");
    const y1 = toCoord(to?.y, "to.y");
    const button = opts?.button ?? "left";
    const b = bgButton(button);
    const durationMs = dragDuration(opts?.durationMs);
    const stepMs = Math.round(durationMs / (BG_DRAG_STEPS + 1));
    const pause = async () => {
      if (stepMs > 0) await ctx.sleep(stepMs);
    };
    const hit = resolveTarget(x0, y0);
    refuseNonClient(hit); // 从标题栏拖（移动窗口）在后台档做不到，明说
    const { top, target, cx, cy } = hit;
    // 其余点按「起点的客户区坐标 + 屏幕位移」算：整个拖拽都发给起点处的控件（和真实鼠标的「捕获」语义一致）
    const clientOf = (x, y) => makeLParam(cx + (x - x0), cy + (y - y0));
    wake(top, target);
    let pressed = false;
    let releaseError = null;
    try {
      post(target, WM.MOUSEMOVE, 0, clientOf(x0, y0));
      post(target, b.down, b.mk, clientOf(x0, y0));
      pressed = true;
      for (const p of planDragPoints({ x: x0, y: y0 }, { x: x1, y: y1 })) {
        await pause();
        post(target, WM.MOUSEMOVE, b.mk, clientOf(p.x, p.y));
      }
      await pause();
      post(target, WM.MOUSEMOVE, b.mk, clientOf(x1, y1));
      await pause();
    } finally {
      if (pressed) {
        try {
          post(target, b.up, 0, clientOf(x1, y1));
        } catch (err) {
          releaseError = err;
        }
      }
    }
    if (releaseError) throw releaseError;
    state.lastTarget = { top, target, at: ctx.now() };
  };

  const scroll = async (x, y, dx, dy) => {
    ensureReady();
    const px = toCoord(x, "x");
    const py = toCoord(y, "y");
    const messages = planWheelMessages({ dx, dy, screenX: px, screenY: py });
    const { top, target } = resolveTarget(px, py);
    wake(top, target);
    for (const m of messages) post(target, m.msg, m.wParam, m.lParam);
  };

  // ─────────── 键盘 ───────────

  /**
   * @returns {Promise<{ note?: string }>} note：带「尽力而为」性质的按键会附一句提示，上层原样给 AI
   */
  const keyCombo = async (combo) => {
    ensureReady();
    const plan = planBackgroundKey(combo);
    if (plan.unsupported) throw new DesktopError("NEED_FOREGROUND", plan.unsupported);
    const { top, target } = keyboardTarget();
    wake(top, target);
    if (plan.special && isEditClass(readClassName(target))) {
      post(target, plan.special.msg, plan.special.wParam, plan.special.lParam);
      return {};
    }
    for (const m of renderKeySteps(plan.steps, ctx.scanOf)) post(target, m.msg, m.wParam, m.lParam);
    return plan.approximate
      ? { note: "锁屏后台模式下，带 Ctrl / Alt / Shift 的组合键只是尽力模拟（窗口消息改不了「修饰键是否按下」的系统状态），请看下一张截图确认是否生效" }
      : {};
  };

  /**
   * @param {string} text
   * @param {{ shouldStop?: () => boolean }} [opts] shouldStop：每个批次开头问一次，true 就立刻收手（不抛错）
   */
  const typeText = async (text, opts = {}) => {
    ensureReady();
    if (typeof text !== "string") throw badArgs("text 必须是字符串");
    if (text.length > BG_TYPE_MAX_UNITS) throw badArgs(`一次最多输入 ${BG_TYPE_MAX_UNITS} 个字符，请分多次输入`);
    const shouldStop = typeof opts?.shouldStop === "function" ? opts.shouldStop : null;
    const batches = batchBackgroundTyping(planBackgroundTyping(text));
    if (batches.length === 0) return;
    const { top, target } = keyboardTarget();
    wake(top, target);
    for (let i = 0; i < batches.length; i += 1) {
      if (i > 0) await ctx.sleep(BG_TYPE_BATCH_GAP_MS);
      if (shouldStop?.()) return;
      for (const item of batches[i]) {
        for (const m of renderTypingItem(item, ctx.scanOf)) {
          try {
            post(target, m.msg, m.wParam, m.lParam);
          } catch {
            // quiet：错误里不带任何底层细节（文本可能是密码）
            throw internalError("文字没能送进窗口：窗口可能已经关闭，或它的消息队列已满、或它是以管理员身份运行的程序");
          }
        }
      }
    }
  };

  // ─────────── 应用 ───────────

  const openApp = (target) => ctx.openApp(target, { background: true });

  // ─────────── 自检 / 诊断辅助（不含用户内容） ───────────

  /** 标题包含 text 的可见顶层窗口（自检找自己开的窗口用）。返回内部记录（hwnd 是 BigInt，不可 JSON 化） */
  const findWindowsByTitle = (text) => {
    ensureReady();
    const needle = String(text);
    const out = [];
    const buf = Buffer.alloc(512 * 2);
    for (const w of enumerate()) {
      const n = Number(ctx.callCore("GetWindowTextW", w.hwnd, buf, 512));
      if (n > 0 && decodeWide(buf, n).includes(needle)) out.push(w);
    }
    return out;
  };

  /**
   * 屏幕点上最上层的可操作窗口（点击 / 拖拽会命中的那个）；没有返回 null。
   * 自检用：往自己开的窗口里打字之前，先确认它没被别的窗口盖住（否则那些字会打进用户的应用）。
   */
  const windowAt = (x, y) => {
    ensureReady();
    return pickWindowAt(enumerate(), toCoord(x, "x"), toCoord(y, "y")) ?? null;
  };

  const readTitle = (hwnd) => {
    ensureReady();
    const buf = Buffer.alloc(512 * 2);
    const n = Number(ctx.callCore("GetWindowTextW", hwnd, buf, 512));
    return n > 0 ? decodeWide(buf, n) : "";
  };

  const closeWindow = (hwnd) => {
    ensureReady();
    post(hwnd, WM.CLOSE, 0, 0);
  };

  const classOf = (hwnd) => readClassName(hwnd);

  /** 会话开始 / 结束时清掉「最近点过的窗口」和激活记录，免得下一个会话把字打进上一个会话的窗口 */
  const reset = () => {
    state.lastTarget = null;
    state.activated.clear();
  };

  const diagnostics = () => ({
    initialized: state.initialized,
    ready: state.ready,
    error: state.error,
    bindFailures: [...state.bindFailures],
    bindErrors: { ...state.bindErrors },
    typeProblems: { ...state.typeProblems },
    sizes: { ...state.sizes },
  });

  return {
    init,
    supported: () => state.ready,
    diagnostics,
    reset,
    mouseMove,
    click,
    drag,
    scroll,
    keyCombo,
    typeText,
    openApp,
    capture,
    captureWindow,
    findWindowsByTitle,
    windowAt,
    readTitle,
    classOf,
    closeWindow,
  };
};
