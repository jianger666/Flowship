/**
 * Windows 桌面驱动（DesktopDriver 的 win32 实现，契约见 ../types.mjs）。
 *
 * 只管「把一个低层动作交给系统」：没有权限判断 / 会话 / 安全规则 / 审计，那些都在上层。
 * 通过 koffi（纯 N-API 的 FFI）直接调用 user32 / kernel32 / shell32 / dwmapi，不 spawn 任何 shell。
 *
 * 坐标系：输入坐标 = 虚拟桌面的物理像素（Electron 主进程默认 per-monitor DPI aware，副屏在主屏左 / 上方时坐标可为负）。
 * - 光标定位一律 SetCursorPos(x, y)；不用 SendInput 的绝对坐标（0..65535 归一化有取整误差）；
 * - 点击 / 拖拽 / 滚轮的「按键事件」用 SendInput，且不带 MOVE 标志（位置已经由 SetCursorPos 定好）。
 *
 * 保守原则（这份代码写的时候没有 Windows 机器可测，只能在 Mac 上用单测验证「调用序列 / 参数 / 结构体布局」）：
 * - 每个 Win32 签名都在 win32-defs.mjs 里连同官方 C 原型一起写出，真机验证时逐条对照；
 * - 所有 FFI 失败都抛带中文上下文的 DesktopError，写成能照着自修复的话，不吞错；
 * - 按下去的东西一定要抬起来：click / drag / keyCombo 任何一步失败都会尽力补发抬起事件，避免鼠标键 / Ctrl 卡住；
 * - 无法验证的假设集中写在测试文件头注释与交付说明里，不藏在代码里。
 *
 * 隐私：typeText 的文本可能是密码。文本只进 SendInput 的事件数组，不进任何日志 / 错误信息 / diagnostics
 * （错误里连长度都不带）。输入类动作本身也不打日志，日志只用于 init 结果这类与用户内容无关的诊断。
 *
 * openApp 的边界：只打开「应用」（和 macOS 驱动同一语义）。目标先过 rejectOpenTarget（拒绝网址 / UNC / 脚本 / 文档……，
 * 先于任何系统调用），再按「ShellExecuteEx → 已运行的窗口 → 开始菜单快捷方式」的顺序找。
 * ShellExecuteEx 带 NO_UI：出错时不弹模态框——人不在电脑前时，模态框会把 Electron 主线程永远卡住。
 *
 * 依赖注入（便于单测）：koffi / log / platform / sleep / env / fs 都可传（env / fs 只给 openApp 的开始菜单搜索用）。
 * import 本模块不加载 koffi、没有任何副作用；koffi 在 init() 里才会 createRequire 加载（未注入时）。
 * 非 win32 平台 init() 直接返回 ok:false，且不会调用 koffi.load。
 *
 * @typedef {import("../types.mjs").DesktopDriver} DesktopDriver
 * @typedef {import("../types.mjs").DesktopAppInfo} DesktopAppInfo
 * @typedef {import("../types.mjs").DesktopRect} DesktopRect
 * @typedef {import("../types.mjs").MouseButton} MouseButton
 */
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { DesktopError } from "../types.mjs";
import {
  BUTTON_FLAGS,
  CORE_FUNCTIONS,
  CORE_STRUCT_NAMES,
  DPI_AWARENESS_NAMES,
  DWMWA_CLOAKED,
  INPUT_DESKTOP_ACCESS,
  KEYEVENTF,
  MAPVK_VK_TO_VSC,
  MODIFIER_EXTENDED,
  MODIFIER_ORDER,
  MODIFIER_VK,
  MOUSEEVENTF,
  PROCESS_QUERY_LIMITED_INFORMATION,
  SHELLEXECUTE_SUCCESS_ABOVE,
  SM,
  SW_RESTORE,
  SW_SHOWNORMAL,
  UOI_NAME,
  VK,
  WHEEL_DELTA,
  WIN32_FUNCTIONS,
  WIN32_LIBRARIES,
  WTSINFOEX_OFFSETS,
  WTSINFOEX_READ_BYTES,
  WTS_CURRENT_SESSION,
  WTS_SESSIONSTATE_LOCK,
  WTS_SESSIONSTATE_UNLOCK,
  WTS_SESSION_INFO_EX,
  defineShellExecuteInfo,
  defineWin32Types,
  expectedStructSizes,
  keyboardInput,
  lookupKey,
  mouseInput,
  rejectOpenTarget,
  shellExecuteInfo,
} from "./win32-defs.mjs";
import { createWin32Background } from "./win32-background.mjs";

/**
 * 驱动实际用到的 koffi 最小面（真 koffi 满足；单测注入假的）。
 * @typedef {Object} KoffiLike
 * @property {string} [version]
 * @property {(file: string) => { func: (prototype: string) => (...args: any[]) => any }} load
 * @property {(name: string, members: object) => unknown} struct
 * @property {(members: object) => unknown} union
 * @property {(prototype: string) => unknown} proto
 * @property {(type: unknown) => number} sizeof
 * @property {(pointer: unknown, type: string, length: number) => ArrayLike<number>} [decode]  读库返回的指针指向的内存（只有分清锁屏 / UAC 时用）
 */

/**
 * @typedef {Object} Win32DriverDeps
 * @property {KoffiLike} [koffi]  注入的 koffi；不传则 init() 里 createRequire 加载
 * @property {(message: string) => void} [log]  诊断日志；不会收到任何用户输入的内容
 * @property {string} [platform]  默认 process.platform
 * @property {(ms: number) => Promise<void>} [sleep]  默认 setTimeout；单测注入后可断言每次停顿的毫秒数
 * @property {Record<string, string | undefined>} [env]  环境变量，默认 process.env；开始菜单搜索从 ProgramData / APPDATA 找目录
 * @property {{ readdir: (dir: string, options: { withFileTypes: true }) => Promise<Array<{ name: string, isDirectory: () => boolean, isFile: () => boolean }>> }} [fs]
 *   目录读取，默认 node:fs/promises 的 readdir；单测注入内存目录树
 */

// ═══════════════════════════ 节奏参数 ═══════════════════════════

/** typeText 每批最多多少个 UTF-16 code unit（每个 code unit 两个事件：down + up，即一批最多 80 个事件） */
const TYPE_BATCH_UNITS = 40;
/** typeText 批间停顿：给目标应用一点消化时间，防止丢字 */
const TYPE_BATCH_GAP_MS = 5;
/** 一次 typeText 的 code unit 上限（资源保护：每 40 个停 5ms，2 万个约 2.5 秒；更长的请分多次） */
const TYPE_MAX_UNITS = 20000;
/** 多击之间的间隔：远小于系统双击判定时间（默认 500ms），又够应用把两次点击当成两次 */
const CLICK_GAP_MS = 40;
/** drag：默认时长、时长上限、线性插值的步数 */
const DRAG_DEFAULT_MS = 300;
const DRAG_MAX_MS = 10000;
const DRAG_STEPS = 10;
/** wakeDisplay 两次相对位移之间的间隔 */
const WAKE_GAP_MS = 30;
/** 一次滚动的格数上限：防止 mouseData（DWORD）越界 */
const MAX_WHEEL_NOTCHES = 1000;

// ═══════════════════════════ 缓冲区大小 ═══════════════════════════

/** 窗口标题缓冲区（字符数，含结尾 NUL）。更长的标题被截断，不影响使用 */
const TITLE_CHARS = 512;
/** 进程镜像路径缓冲区（字符数）。路径更长时 API 失败，进程名退回「未知进程」 */
const IMAGE_PATH_CHARS = 2048;
/** 桌面名缓冲区（字节数）。Default / Winlogon / Screen-saver 远小于它 */
const DESKTOP_NAME_BYTES = 512;

// ═══════════════════════════ openApp ═══════════════════════════

/** 目标最长多少个字符（再长一定不是应用名 / 路径） */
const MAX_TARGET_CHARS = 1024;
/** 错误信息里最多回显目标的前多少个字符 */
const SHOWN_TARGET_CHARS = 60;

/** 开始菜单快捷方式的目录（接在 %ProgramData% / %APPDATA% 之后） */
const START_MENU_RELATIVE = Object.freeze(["Microsoft", "Windows", "Start Menu", "Programs"]);
/** 递归深度上限：Programs 根目录算第 0 层，最多进到第 3 层的子目录（Programs\厂商\产品\子文件夹） */
const START_MENU_MAX_DEPTH = 3;
/** 累计最多看多少个目录条目（文件 + 子目录都算）：防止异常庞大的目录把主线程拖住 */
const START_MENU_MAX_ENTRIES = 3000;

/** ShellExecuteW 的返回值 / ShellExecuteExW 的 hInstApp（shellapi.h 里 ≤ 32 的 SE_ERR_*）的人话 */
const SHELLEXECUTE_REASONS = Object.freeze({
  0: "系统资源不足",
  2: "找不到该文件或程序",
  3: "找不到该路径",
  5: "拒绝访问",
  8: "内存不足",
  31: "没有与该文件类型关联的程序",
});

/**
 * GetLastError 的常见错误码（ShellExecuteExW 失败、hInstApp 又没给原因时才看它）。
 * 和上面是两套码：2 / 3 / 5 / 8 两边同义（SE_ERR_* 本来就沿用了这几个 Win32 码），
 * 但 31 在 Win32 里是 ERROR_GEN_FAILURE，和 SE_ERR_NOASSOC 毫无关系，所以不能合成一张表。
 */
const WIN32_ERROR_REASONS = Object.freeze({
  2: SHELLEXECUTE_REASONS[2],
  3: SHELLEXECUTE_REASONS[3],
  5: SHELLEXECUTE_REASONS[5],
  8: SHELLEXECUTE_REASONS[8],
  740: "需要管理员权限",
  1155: "没有与该文件类型关联的程序",
  1223: "操作被取消",
});

/** 错误码 → 「码，人话」；表里没有的只给数字 */
const withMeaning = (code, table) => (table[code] ? `${code}，${table[code]}` : String(code));

// ═══════════════════════════ 小工具 ═══════════════════════════

const badArgs = (message) => new DesktopError("BAD_ARGS", message);

/**
 * 系统调用失败。cause 只在「不敏感」的路径上挂（typeText 的错误不挂，避免底层错误信息带出文本片段）。
 * @param {string} message
 * @param {unknown} [cause]
 */
const internalError = (message, cause) => {
  const err = new DesktopError("INTERNAL", message);
  if (cause !== undefined) err.cause = cause;
  return err;
};

/**
 * typeText 打到一半发现输入桌面已经不是 Default（第四轮评审 C1）。两条都不带已输入的字数 / 文本：和 typeText 的其它错误一样，连长度都不能漏。
 * 错误码沿用会话 guard 对同类情形的口径（不新增错误码——码表是 types.mjs ↔ server 镜像 ↔ preload 三处对账的契约）：
 * 锁屏 / 切桌面 = SESSION_EXPIRED（guard 对「会话期间被锁屏」抛的就是它），UAC 之类的系统安全桌面 = SECURE_DESKTOP。
 */
const TYPE_INTERRUPTED_LOCKED_MESSAGE =
  "输入文字的过程中电脑被锁屏了（或切到了别的桌面），已经停止输入：剩下的字没有再输入，已输入的部分可能还留在原来的窗口里。请重新调用一次桌面工具以重新开始（锁屏时如已允许会自动解锁），并先截图确认现状再继续";
const TYPE_INTERRUPTED_SECURE_MESSAGE =
  "输入文字的过程中屏幕上弹出了 Windows 的系统安全提示（比如 UAC 权限确认），已经停止输入：剩下的字没有再输入，已输入的部分可能还留在原来的窗口里。这类提示只能由用户本人处理，请告诉用户处理完再让你继续；不要重试，也不要想办法绕过";

/** 把任意抛出物压成一行短文本（给错误信息 / 诊断用） */
const describe = (e) => String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 200);

/** koffi 3 里空指针是 null；兼容 0 / 0n，防止版本差异 */
const isNullHandle = (h) => h === null || h === undefined || h === 0 || h === 0n;

/** 诊断是尽力而为：读不到就用兜底值，不影响主流程 */
const attempt = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** 补救动作（释放按键等）：只用在「已经在报错」的路径上，补救失败不能盖掉真正的错误，所以吞掉 */
const bestEffort = (fn) => {
  try {
    fn();
  } catch {
    /* 补救失败不覆盖原始错误 */
  }
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 屏幕坐标：必须是有限数，四舍五入成整数（SetCursorPos 的参数是 int），并限制在 int32 内 */
const toCoord = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw badArgs(`${name} 必须是有限数字（屏幕坐标）`);
  const n = Math.round(value);
  if (n < -2147483648 || n > 2147483647) throw badArgs(`${name} 超出屏幕坐标的取值范围`);
  return n;
};

/** 鼠标按钮名 → 按下 / 抬起标志 */
const buttonFlags = (button = "left") => {
  if (typeof button !== "string" || !Object.hasOwn(BUTTON_FLAGS, button)) throw badArgs("button 只能是 left / right / middle");
  return BUTTON_FLAGS[button];
};

/** 滚动格数 → 滚轮增量（有符号整数，1 格 = WHEEL_DELTA） */
const wheelUnits = (notches, name) => {
  if (typeof notches !== "number" || !Number.isFinite(notches)) throw badArgs(`${name} 必须是数字（滚动的格数）`);
  if (Math.abs(notches) > MAX_WHEEL_NOTCHES) throw badArgs(`${name} 超出范围：一次最多滚动 ${MAX_WHEEL_NOTCHES} 格`);
  return Math.round(notches * WHEEL_DELTA);
};

/** drag 的时长：缺省 300ms；非法值报错而不是悄悄改；超过上限夹到上限（防止 AI 传个超大值把主进程卡住） */
const dragDuration = (value) => {
  if (value === undefined || value === null) return DRAG_DEFAULT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw badArgs("durationMs 必须是不小于 0 的数字（毫秒）");
  return Math.min(value, DRAG_MAX_MS);
};

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/**
 * 读 UTF-16LE 缓冲区：到第一个 NUL 或 maxChars 为止。
 * 不用 koffi.decode：Node 的 Buffer 本身就能解码，少依赖一份 koffi 行为。
 * @param {Buffer} buf
 * @param {number} [maxChars]
 */
const decodeWide = (buf, maxChars = buf.length / 2) => {
  const limit = Math.min(Math.floor(buf.length / 2), maxChars);
  let end = 0;
  while (end < limit && buf.readUInt16LE(end * 2) !== 0) end += 1;
  return buf.toString("utf16le", 0, end * 2);
};

const isHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * 组合键 → 要按下的修饰键（固定 ctrl→alt→shift→meta 顺序）与主键。
 * plus 在美式布局上是 Shift+=，没有 shift 时自动补一个（已经有则不重复）。
 * 错误信息不带键名：这些值来自 keys.mjs 的规范化，走到这里说明调用方绕过了它，不必回显。
 * @param {{ mods?: string[], key: string }} combo
 */
const planKeyCombo = (combo) => {
  const entry = lookupKey(combo?.key);
  if (!entry) throw badArgs("不认识的按键，无法映射到 Windows 虚拟键码（key 必须是 keys.mjs 的规范键名）");
  const list = combo?.mods ?? [];
  if (!Array.isArray(list)) throw badArgs("mods 必须是数组");
  const wanted = new Set();
  for (const mod of list) {
    if (!MODIFIER_ORDER.includes(mod)) throw badArgs("不认识的修饰键（只支持 ctrl / alt / shift / meta）");
    wanted.add(mod);
  }
  if (entry.shift) wanted.add("shift");
  const mods = MODIFIER_ORDER.filter((m) => wanted.has(m)).map((m) => ({ vk: MODIFIER_VK[m], extended: MODIFIER_EXTENDED[m] }));
  return { mods, key: { vk: entry.vk, extended: entry.extended } };
};

/**
 * 把文本拆成「输入单元」：换行（\n、\r\n、孤立的 \r 都算一个）→ Enter，\t → Tab，其余按 UTF-16 code unit，
 * surrogate pair 合成一个单元（保证批边界不会把它拆开）。
 * 其它控制字符没有可靠的输入方式，直接报错（错误里只写位置，不写字符）。
 * @param {string} text
 * @returns {Array<{ units: number[] } | { vk: number }>}
 */
const planTyping = (text) => {
  const items = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) i += 1; // \r\n 视为一个换行
      items.push({ vk: VK.RETURN });
    } else if (unit === 0x0a) {
      items.push({ vk: VK.RETURN });
    } else if (unit === 0x09) {
      items.push({ vk: VK.TAB });
    } else if (unit < 0x20 || unit === 0x7f) {
      throw badArgs(`文本里第 ${i + 1} 个字符是无法输入的控制字符（只支持换行和制表符），请去掉后重试`);
    } else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      items.push({ units: [unit, text.charCodeAt(i + 1)] });
      i += 1;
    } else {
      items.push({ units: [unit] });
    }
  }
  return items;
};

/** 输入单元按「每批 ≤ TYPE_BATCH_UNITS 个 code unit」分批；单元不拆开 */
const batchTyping = (items) => {
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const n = "units" in item ? item.units.length : 1;
    if (size + n > TYPE_BATCH_UNITS && current.length > 0) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

/** 窗口记录 → 按 pid 聚合成 DesktopAppInfo（保持枚举顺序，即 Z 序从上到下） */
const aggregateApps = (records, frontPid) => {
  /** @type {Map<number, DesktopAppInfo>} */
  const byPid = new Map();
  for (const r of records) {
    let app = byPid.get(r.pid);
    if (!app) {
      app = { name: r.processName, pid: r.pid, frontmost: r.pid === frontPid, windows: [] };
      byPid.set(r.pid, app);
    }
    app.windows.push({ title: r.title, x: r.x, y: r.y, width: r.width, height: r.height, minimized: r.minimized });
  }
  return [...byPid.values()];
};

/**
 * 目标 → 用来搜窗口 / 快捷方式的名字：小写、去掉目录、去掉 .exe / .lnk 后缀（"C:\...\WeChat.exe" → "wechat"）。
 * 去完是空串（校验已经拦住了，不会发生）就退回整个小写目标。
 * @param {string} target
 */
const searchName = (target) => {
  const lower = target.toLowerCase();
  return path.win32.basename(lower).replace(/\.(exe|lnk)$/i, "") || lower;
};

/**
 * openApp 回退用：在已有窗口里找「像是它」的那个。
 * 优先级：进程名完全相同 > 进程名包含 > 标题包含（都不区分大小写）。包含匹配要求至少 2 个字符，防止 "a" 之类命中一大片。
 * @param {Array<{ processName: string, title: string }>} records
 * @param {string} target
 */
const matchWindow = (records, target) => {
  const needle = searchName(target);
  const canContain = needle.length >= 2;
  return (
    records.find((r) => r.processName.toLowerCase() === needle) ??
    (canContain ? records.find((r) => r.processName.toLowerCase().includes(needle)) : undefined) ??
    (canContain ? records.find((r) => r.title.toLowerCase().includes(needle)) : undefined) ??
    null
  );
};

// ─────────── 开始菜单快捷方式（纯 Node fs，不走任何 FFI）───────────

/**
 * 开始菜单的 Programs 目录：%ProgramData% 与 %APPDATA% 各一个。
 * 只接受盘符开头的绝对路径：缺失 / 空 / 相对路径 / UNC（企业环境里 APPDATA 可能被重定向到网络共享）一律跳过——
 * 搜索不能为了找个快捷方式去碰网络位置（和 rejectOpenTarget 拒绝 UNC 是同一个理由）。
 * @param {Record<string, string | undefined>} env
 */
const startMenuRoots = (env) =>
  [env.ProgramData, env.APPDATA]
    .filter((base) => typeof base === "string" && /^[a-z]:[\\/]/i.test(base))
    .map((base) => path.win32.join(base, ...START_MENU_RELATIVE));

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * 递归收集开始菜单里的 .lnk（只看文件名，不解析快捷方式内容）。
 * - 每个目录的条目先按名字排序再处理，所以「条目上限」截在哪里是确定的，不依赖文件系统的返回顺序；
 * - 先处理完本目录的条目、再进子目录，浅层的快捷方式永远比深层的先被看到；
 * - 读目录失败（不存在 / 没权限）就跳过那个目录；符号链接不跟随（Dirent 对它既不是文件也不是目录）。
 * @param {Record<string, string | undefined>} env
 * @param {NonNullable<Win32DriverDeps["fs"]>} fs
 * @returns {Promise<{ shortcuts: Array<{ name: string, file: string }>, readable: number }>} readable = 成功读到的目录数
 */
const scanStartMenu = async (env, fs) => {
  const shortcuts = [];
  let visited = 0;
  let readable = 0;

  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = [...(await fs.readdir(dir, { withFileTypes: true }))].sort(byName);
    } catch {
      return;
    }
    readable += 1;
    const subdirs = [];
    for (const entry of entries) {
      if (visited >= START_MENU_MAX_ENTRIES) return;
      visited += 1;
      if (entry.isDirectory()) {
        if (depth < START_MENU_MAX_DEPTH) subdirs.push(path.win32.join(dir, entry.name));
      } else if (entry.isFile() && /\.lnk$/i.test(entry.name)) {
        shortcuts.push({ name: entry.name.slice(0, -".lnk".length), file: path.win32.join(dir, entry.name) });
      }
    }
    for (const sub of subdirs) {
      if (visited >= START_MENU_MAX_ENTRIES) return;
      await walk(sub, depth + 1);
    }
  };

  for (const root of startMenuRoots(env)) {
    if (visited >= START_MENU_MAX_ENTRIES) break;
    await walk(root, 0);
  }
  return { shortcuts, readable };
};

/** 卸载程序的快捷方式一律不要（名字里有 uninstall 或 卸载，不区分大小写）：「打开微信」不能把微信卸载程序拉起来 */
const isUninstaller = (lowerName) => lowerName.includes("uninstall") || lowerName.includes("卸载");

/** 同优先级里挑一个：名字最短的；一样长再按完整路径的字典序，保证结果确定 */
const byLengthThenPath = (a, b) => a.name.length - b.name.length || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/**
 * 在快捷方式里找「像是它」的那个。名字取去掉 .lnk 的文件名，不区分大小写。
 * 优先级：完全相等 > 以目标开头 > 包含；开头 / 包含要求目标至少 2 个字符（和窗口匹配同一个理由）。
 * @param {Array<{ name: string, file: string }>} shortcuts
 * @param {string} target
 */
const matchShortcut = (shortcuts, target) => {
  const needle = searchName(target);
  const canContain = needle.length >= 2;
  const usable = shortcuts.map((s) => ({ ...s, lower: s.name.toLowerCase() })).filter((s) => !isUninstaller(s.lower));
  const best = (list) => list.sort(byLengthThenPath)[0] ?? null;
  return (
    best(usable.filter((s) => s.lower === needle)) ??
    (canContain ? best(usable.filter((s) => s.lower.startsWith(needle))) : null) ??
    (canContain ? best(usable.filter((s) => s.lower.includes(needle))) : null)
  );
};

// ═══════════════════════════ 驱动 ═══════════════════════════

const freshState = () => ({
  /** 当前使用的 koffi（注入的，或 init 里加载的） */
  koffi: null,
  /** 已绑定的 Win32 函数：名字 → koffi 函数 */
  fns: {},
  loaded: false,
  /** init 失败的原因（中文） */
  initError: null,
  /** SendInput 的 cbSize：koffi.sizeof(INPUT) */
  inputSize: 0,
  /** koffi 实测的结构体大小（核心结构体 + 可选的 SHELLEXECUTEINFOW），诊断用 */
  structSizes: null,
  /** 可选结构体的问题（结构体名 → 原因）：有问题的结构体，依赖它的函数（WIN32_FUNCTIONS 的 needs）不绑定 */
  typeProblems: {},
  bindFailures: [],
  bindErrors: {},
  /** 虚拟键码 → 扫描码缓存 */
  scanCache: new Map(),
});

/**
 * @param {Win32DriverDeps} [deps]
 * @returns {DesktopDriver}
 */
export const createWin32Driver = (deps = {}) => {
  const { koffi: injectedKoffi, log, platform = process.platform, sleep = defaultSleep, env = process.env, fs = { readdir } } = deps;
  const state = freshState();

  const say = (message) => {
    try {
      log?.(`[desktop/win32] ${message}`);
    } catch {
      /* 日志出错不能影响驱动 */
    }
  };

  // ─────────── FFI 调用 ───────────

  const ensureLoaded = () => {
    if (!state.loaded) {
      throw new DesktopError("UNSUPPORTED", state.initError ?? "Windows 桌面驱动尚未初始化（需要先成功调用 init()）");
    }
  };

  /** 取已绑定的 Win32 函数；没绑上就说清楚是哪个、为什么 */
  const need = (name) => {
    ensureLoaded();
    const f = state.fns[name];
    if (!f) {
      throw new DesktopError("UNSUPPORTED", `当前系统缺少 Win32 函数 ${name}（${state.bindErrors[name] ?? "绑定失败"}），这项功能不可用`);
    }
    return f;
  };

  /** 调用 Win32 函数；koffi 自己抛的错（参数类型不对等）补上中文上下文 */
  const call = (name, ...args) => {
    const f = need(name);
    try {
      return f(...args);
    } catch (cause) {
      throw internalError(`调用 Win32 ${name} 出错：${describe(cause)}`, cause);
    }
  };

  /**
   * 读上一次 FFI 调用的 Win32 错误码（拼进错误信息，方便对照）。必须在失败的调用之后立刻调，中间不能插别的 FFI 调用。
   * @returns {number | null}
   */
  const lastErrorCode = () => {
    const f = state.fns.GetLastError;
    if (!f) return null;
    try {
      return Number(f());
    } catch {
      return null;
    }
  };
  const codeText = (code) => (code == null ? "" : `，Win32 错误码 ${code}`);

  // ─────────── SendInput ───────────

  /**
   * 一次 SendInput 送出一批事件（系统保证同一次调用里的事件连续注入，不会被别的输入插进来）。
   * 返回的注入数 < 请求数就是失败：典型原因是被 UIPI / 安全软件拦截，或输入桌面不是当前桌面（锁屏 / UAC）。
   * @param {object[]} events INPUT 值数组（keyboardInput / mouseInput 构造）
   * @param {{ quiet?: boolean }} [opts] quiet：错误里不带 koffi 的原始信息 / cause（typeText 用）
   */
  const sendInputs = (events, { quiet = false } = {}) => {
    const SendInput = need("SendInput");
    let injected;
    try {
      injected = Number(SendInput(events.length, events, state.inputSize));
    } catch (cause) {
      throw quiet ? internalError("调用 Win32 SendInput 出错") : internalError(`调用 Win32 SendInput 出错：${describe(cause)}`, cause);
    }
    if (injected !== events.length) {
      const code = lastErrorCode(); // 紧跟在 SendInput 之后，中间没有别的 FFI 调用
      // quiet 时连事件数都不写：事件数 ≈ 文本长度的两倍，密码长度也不该漏出去
      const detail = [quiet ? "" : `要送出 ${events.length} 个事件，只成功 ${injected} 个`, code == null ? "" : `Win32 错误码 ${code}`]
        .filter(Boolean)
        .join("，");
      throw internalError(
        `Windows 拒绝了输入注入${detail ? `（${detail}）` : ""}：` +
          "可能被安全软件拦截，或当前前台窗口是以管理员身份运行的程序，也可能电脑正处于锁屏 / UAC 提示界面。" +
          "请关闭拦截、或以管理员身份运行 Flowship 后重试",
      );
    }
  };

  const setCursor = (x, y) => {
    const ok = call("SetCursorPos", x, y);
    if (Number(ok) === 0) {
      const code = lastErrorCode();
      throw internalError(`移动鼠标到 (${x}, ${y}) 失败${codeText(code)}：可能电脑正处于锁屏 / UAC 提示界面，或鼠标被其他程序限制在某个区域内`);
    }
  };

  /** 虚拟键码 → 扫描码（部分应用依赖 wScan）。取不到不影响输入，退回 0 */
  const scanOf = (vk) => {
    const cached = state.scanCache.get(vk);
    if (cached !== undefined) return cached;
    let scan = 0;
    const f = state.fns.MapVirtualKeyW;
    if (f) {
      try {
        scan = Number(f(vk, MAPVK_VK_TO_VSC)) & 0xffff;
      } catch {
        scan = 0;
      }
    }
    state.scanCache.set(vk, scan);
    return scan;
  };

  /** 普通键事件（带扫描码；扩展键带 EXTENDEDKEY） */
  const keyEvent = ({ vk, extended }, up) =>
    keyboardInput({ vk, scan: scanOf(vk), flags: (extended ? KEYEVENTF.EXTENDEDKEY : 0) | (up ? KEYEVENTF.KEYUP : 0) });

  /** Unicode 字符事件：wVk 必须是 0，wScan = UTF-16 code unit，不能同时带 SCANCODE */
  const unicodeEvent = (unit, up) =>
    keyboardInput({ vk: 0, scan: unit, flags: KEYEVENTF.UNICODE | (up ? KEYEVENTF.KEYUP : 0) });

  // ─────────── 鼠标 ───────────

  const mouseMove = (x, y) => {
    ensureLoaded();
    setCursor(toCoord(x, "x"), toCoord(y, "y"));
  };

  const click = async (x, y, opts = {}) => {
    ensureLoaded();
    const px = toCoord(x, "x");
    const py = toCoord(y, "y");
    const flags = buttonFlags(opts?.button);
    const count = opts?.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 3) throw badArgs("count 必须是 1–3 的整数（单击 / 双击 / 三击）");
    setCursor(px, py);
    for (let i = 0; i < count; i += 1) {
      if (i > 0) await sleep(CLICK_GAP_MS);
      try {
        // 按下 + 抬起放在同一次 SendInput 里：系统保证连续注入
        sendInputs([mouseInput({ flags: flags.down }), mouseInput({ flags: flags.up })]);
      } catch (err) {
        // 可能只注入了「按下」：补一个抬起，别让按钮卡住
        bestEffort(() => sendInputs([mouseInput({ flags: flags.up })]));
        throw err;
      }
    }
  };

  const drag = async (from, to, opts = {}) => {
    ensureLoaded();
    const x0 = toCoord(from?.x, "from.x");
    const y0 = toCoord(from?.y, "from.y");
    const x1 = toCoord(to?.x, "to.x");
    const y1 = toCoord(to?.y, "to.y");
    const flags = buttonFlags(opts?.button);
    const durationMs = dragDuration(opts?.durationMs);
    // 一共停 DRAG_STEPS + 1 次：每个中间点前一次、到达终点前一次、放手前一次（让目标应用先处理完最后一次移动再 drop）
    const stepMs = Math.round(durationMs / (DRAG_STEPS + 1));
    const pause = async () => {
      if (stepMs > 0) await sleep(stepMs);
    };

    setCursor(x0, y0);
    let releaseError = null;
    try {
      sendInputs([mouseInput({ flags: flags.down })]);
      for (let i = 1; i < DRAG_STEPS; i += 1) {
        await pause();
        setCursor(lerp(x0, x1, i / DRAG_STEPS), lerp(y0, y1, i / DRAG_STEPS));
      }
      await pause();
      setCursor(x1, y1);
      await pause();
    } finally {
      // 无论哪一步抛错都抬起：鼠标键不能卡在按下状态。try 里已有错误时，这里的失败不覆盖它
      try {
        sendInputs([mouseInput({ flags: flags.up })]);
      } catch (err) {
        releaseError = err;
      }
    }
    if (releaseError) throw releaseError;
  };

  const scroll = (x, y, dx, dy) => {
    ensureLoaded();
    const px = toCoord(x, "x");
    const py = toCoord(y, "y");
    const vertical = wheelUnits(dy, "dy"); // 契约：dy > 0 = 向下
    const horizontal = wheelUnits(dx, "dx"); // 契约：dx > 0 = 向右
    if (vertical === 0 && horizontal === 0) throw badArgs("dx 和 dy 不能同时为 0");
    setCursor(px, py);
    const events = [];
    // WHEEL 的 mouseData 正值 = 向上，所以「向下」要取负；mouseData 是 DWORD，负数用 >>> 0 转成无符号位模式
    if (vertical !== 0) events.push(mouseInput({ flags: MOUSEEVENTF.WHEEL, data: (-vertical) >>> 0 }));
    // HWHEEL 的 mouseData 正值 = 向右
    if (horizontal !== 0) events.push(mouseInput({ flags: MOUSEEVENTF.HWHEEL, data: horizontal >>> 0 }));
    sendInputs(events);
  };

  // ─────────── 键盘 ───────────

  const keyCombo = (combo) => {
    ensureLoaded();
    const { mods, key } = planKeyCombo(combo);
    const modsReversed = [...mods].reverse();
    // 整个序列一次 SendInput：修饰键依次按下 → 主键按下 / 抬起 → 修饰键倒序抬起
    const events = [
      ...mods.map((m) => keyEvent(m, false)),
      keyEvent(key, false),
      keyEvent(key, true),
      ...modsReversed.map((m) => keyEvent(m, true)),
    ];
    try {
      sendInputs(events);
    } catch (err) {
      // 可能已经按下了一部分：把相关的键全部抬起，免得 Ctrl / Shift / Win 卡住影响用户之后的使用
      bestEffort(() => sendInputs([keyEvent(key, true), ...modsReversed.map((m) => keyEvent(m, true))]));
      throw err;
    }
  };

  /**
   * typeText 每批发出之前复查「输入桌面还是不是 Default」（第四轮评审 C1）。
   * 为什么驱动自己要查：会话层只在动作开始前、回车前各看一眼（guard），中间靠看门狗每 0.3 秒读一次锁屏状态、命中后才把 shouldStop 变成 true；
   * 而一次 desktop_type 最多 5000 个字、约 0.6 秒就发完，看门狗最多只来得及看一两次——Win+L 发生在中途时，到它发现为止后面的批照发；
   * UAC 这类系统安全桌面（isScreenLocked 不算锁屏）看门狗根本不看，输入阶段原本没有任何拦截，只有回车前的 guard。
   * - 明确是锁屏（locked）：停手，抛 SESSION_EXPIRED；明确是系统安全桌面（secure）：停手，抛 SECURE_DESKTOP。
   *   抛错而不是像 shouldStop 那样静默返回：会话没结束时（UAC）静默返回会让调用方以为字都打完了，随后 submit 的回车还可能放行。
   * - 读不到（unknown）：不停手。只认「读到了别的桌面」，和看门狗同口径；入口 guard 已经要求前台档读得到「没锁」，
   *   这里把一次偶发的读不到也算失败，会无端打断整段输入。真有桌面切换，SendInput 自己多半也会被系统拒绝（真机行为未验证）。
   * 复查在批与批之间：上一批的按下 / 抬起是同一次 SendInput 送出的，批间没有悬空的按键，所以这里停手不需要补抬起。
   * 复查与紧接着的 SendInput 之间仍有极短的空窗（同步代码，微秒级），防不住「刚查完就切桌面」；上限是多发一批（40 个 code unit）。
   */
  const assertInputDesktopStillDefault = () => {
    const kind = classifyInputDesktop();
    if (kind === "secure") throw new DesktopError("SECURE_DESKTOP", TYPE_INTERRUPTED_SECURE_MESSAGE);
    if (kind === "locked") throw new DesktopError("SESSION_EXPIRED", TYPE_INTERRUPTED_LOCKED_MESSAGE);
  };

  /**
   * @param {string} text
   * @param {{ shouldStop?: () => boolean }} [opts] shouldStop：每个批次开头问一次，true 就立刻收手（不抛错）——
   *   会话已在收尾，剩下的字不能再打。另外每批发出之前还会复查输入桌面（assertInputDesktopStillDefault）：锁屏 / 安全桌面 → 抛错
   */
  const typeText = async (text, opts = {}) => {
    ensureLoaded();
    if (typeof text !== "string") throw badArgs("text 必须是字符串");
    if (text.length > TYPE_MAX_UNITS) throw badArgs(`一次最多输入 ${TYPE_MAX_UNITS} 个字符，请分多次输入`);
    const shouldStop = typeof opts?.shouldStop === "function" ? opts.shouldStop : null;
    const batches = batchTyping(planTyping(text));
    for (let i = 0; i < batches.length; i += 1) {
      if (i > 0) await sleep(TYPE_BATCH_GAP_MS);
      if (shouldStop?.()) return;
      // 紧贴 SendInput：停顿之后、发送之前复查（放在 shouldStop 之后——会话已在收尾时一个系统函数都不必碰）
      assertInputDesktopStillDefault();
      const events = batches[i].flatMap((item) =>
        "units" in item
          ? item.units.flatMap((unit) => [unicodeEvent(unit, false), unicodeEvent(unit, true)])
          : [keyEvent({ vk: item.vk, extended: false }, false), keyEvent({ vk: item.vk, extended: false }, true)],
      );
      try {
        // quiet：错误信息里不带任何底层细节；这条路径上不打日志
        sendInputs(events, { quiet: true });
      } catch (err) {
        // SendInput 可能只注入了这一批的前一部分——正好停在某个键「按下」之后的话，那个键会卡在按下状态（Enter / Tab 之类的普通键还会连发）：
        // 把这一批涉及的键都补一个抬起（抬起一个本来就没按下的键是无害的），和 click / keyCombo 的失败路径同一个处理。
        // 补发也被拒就算了：不覆盖原来的错误
        bestEffort(() =>
          sendInputs(
            batches[i].flatMap((item) => ("units" in item ? item.units.map((unit) => unicodeEvent(unit, true)) : [keyEvent({ vk: item.vk, extended: false }, true)])),
            { quiet: true },
          ),
        );
        throw err;
      }
    }
  };

  // ─────────── 屏幕 / 输入桌面 / 空闲 ───────────

  /**
   * 探测当前「输入桌面」。
   * - denied：OpenInputDesktop 返回 NULL（锁屏 / UAC 的安全桌面，普通用户进程无权打开）
   * - unreadable：打开了但读不到名字，或探测过程出任何异常
   * - ok：读到了桌面名（Default / Winlogon / Screen-saver…）
   * 无论哪条路径，打开的桌面句柄都会 CloseDesktop。
   * @returns {{ state: "denied" } | { state: "unreadable" } | { state: "ok", name: string }}
   */
  const probeInputDesktop = () => {
    ensureLoaded();
    let desk = null;
    try {
      desk = need("OpenInputDesktop")(0, 0, INPUT_DESKTOP_ACCESS);
      if (isNullHandle(desk)) return { state: "denied" };
      const buf = Buffer.alloc(DESKTOP_NAME_BYTES);
      const needed = [0];
      if (Number(need("GetUserObjectInformationW")(desk, UOI_NAME, buf, buf.length, needed)) === 0) return { state: "unreadable" };
      return { state: "ok", name: decodeWide(buf) };
    } catch {
      return { state: "unreadable" };
    } finally {
      if (!isNullHandle(desk)) bestEffort(() => need("CloseDesktop")(desk));
    }
  };

  /** 本进程所在的会话号（进程的会话不会变，读到一次就缓存）。读不到 = null */
  let cachedOwnSession = null;
  const ownSessionId = () => {
    if (cachedOwnSession !== null) return cachedOwnSession;
    const f = state.fns.ProcessIdToSessionId;
    if (!f) return null;
    try {
      const out = [0];
      if (Number(f(process.pid, out)) === 0) return null;
      cachedOwnSession = Number(out[0]);
      return cachedOwnSession;
    } catch {
      return null;
    }
  };

  /**
   * 本会话的锁定状态（WTSQuerySessionInformationW + WTSSessionInfoEx 的 SessionFlags）。永不抛。
   * - locked：已锁定（锁屏界面）；
   * - unlocked：没锁——此时输入桌面如果还不是 Default，那就是 UAC 权限确认 / Ctrl+Alt+Del 这类系统安全桌面；
   * - unknown：wtsapi32 没加载 / 调用失败 / 读出来的内容对不上预期。
   * 「对不上」的判据：Level 必须是 1，且结构里的 SessionId 必须等于本进程自己的会话号——偏移（见 WTSINFOEX_OFFSETS）要是猜错了，
   * 这里就会对不上，宁可当「不知道」，也不拿一个乱数当「锁屏 / 没锁」的证据。
   * @returns {"locked" | "unlocked" | "unknown"}
   */
  const sessionLockState = () => {
    const query = state.fns.WTSQuerySessionInformationW;
    const free = state.fns.WTSFreeMemory;
    const decode = state.koffi?.decode;
    if (!query || !free || typeof decode !== "function") return "unknown";
    const mine = ownSessionId();
    if (mine === null) return "unknown";
    let pointer = null;
    try {
      const out = [null];
      const bytes = [0];
      if (Number(query(null, WTS_CURRENT_SESSION, WTS_SESSION_INFO_EX, out, bytes)) === 0) return "unknown";
      pointer = out[0];
      if (pointer === null || pointer === undefined || !(Number(bytes[0]) >= WTSINFOEX_READ_BYTES)) return "unknown";
      const buf = Buffer.from(decode.call(state.koffi, pointer, "uint8_t", WTSINFOEX_READ_BYTES));
      if (buf.length < WTSINFOEX_READ_BYTES) return "unknown";
      if (buf.readUInt32LE(WTSINFOEX_OFFSETS.level) !== 1) return "unknown";
      if (buf.readUInt32LE(WTSINFOEX_OFFSETS.sessionId) !== mine) return "unknown";
      const flags = buf.readUInt32LE(WTSINFOEX_OFFSETS.sessionFlags);
      if (flags === WTS_SESSIONSTATE_LOCK) return "locked";
      if (flags === WTS_SESSIONSTATE_UNLOCK) return "unlocked";
      return "unknown";
    } catch {
      return "unknown";
    } finally {
      if (pointer !== null && pointer !== undefined) bestEffort(() => free(pointer));
    }
  };

  /**
   * 输入桌面的种类：
   * - default：普通桌面（没锁屏）；
   * - locked：锁屏（以及屏保等其它非 Default 桌面：保持老行为，一律当锁屏）；
   * - secure：UAC 权限确认 / Ctrl+Alt+Del 之类的系统安全桌面——会话并没有锁，但键鼠注入和截图都碰不到它，也绝不能当锁屏去「解锁」；
   * - unknown：桌面状态读不到。
   * Winlogon 桌面（OpenInputDesktop 被拒，或者名字就叫 Winlogon）上锁屏和 UAC 长得一样，只有会话的锁定标志分得开：
   * 明确「没锁」= secure；明确「已锁」或读不到 = locked（读不到时保守按老办法：不放行输入；真要输开机密码的 typist 自己还会再验一遍）。
   * @returns {"default" | "locked" | "secure" | "unknown"}
   */
  const classifyInputDesktop = () => {
    const probe = probeInputDesktop();
    if (probe.state === "unreadable") return "unknown";
    if (probe.state === "ok" && probe.name.toLowerCase() === "default") return "default";
    const onWinlogon = probe.state === "denied" || probe.name.toLowerCase() === "winlogon";
    if (!onWinlogon) return "locked";
    return sessionLockState() === "unlocked" ? "secure" : "locked";
  };

  const isScreenLocked = () => {
    const kind = classifyInputDesktop();
    if (kind === "unknown") return null;
    return kind === "locked";
  };

  /**
   * 现在显示的是不是系统安全桌面（UAC 权限确认等）：不是锁屏，也不是 AI 能碰的东西。
   * 上层（会话）遇到它要停手交还用户，绝不能把它当锁屏去解锁——往里输开机密码再回车，等于替用户点了「是」。
   */
  const isSecureDesktopActive = () => classifyInputDesktop() === "secure";

  const idleSeconds = () => {
    ensureLoaded();
    const info = { cbSize: state.structSizes.LASTINPUTINFO, dwTime: 0 };
    if (Number(call("GetLastInputInfo", info)) === 0) {
      throw internalError(`读取最近一次键鼠输入时间失败（GetLastInputInfo）${codeText(lastErrorCode())}`);
    }
    // 必须先读 last 再读 tick：反过来的话，两次读取之间若来了输入，差值会变成负数 → 回绕成 49 天
    const tick = Number(call("GetTickCount"));
    // GetTickCount 是 32 位毫秒计数，约 49.7 天回绕一次：差值按无符号 32 位算，回绕后依然正确
    const idleMs = (tick - Number(info.dwTime)) >>> 0;
    return idleMs / 1000;
  };

  const getPrimaryDisplay = () => {
    ensureLoaded();
    const width = Number(call("GetSystemMetrics", SM.CXSCREEN));
    const height = Number(call("GetSystemMetrics", SM.CYSCREEN));
    if (!(width > 0) || !(height > 0)) throw internalError(`读取主显示器尺寸失败（${width}×${height}），可能没有连接显示器或会话已断开`);
    return { x: 0, y: 0, width, height };
  };

  // ─────────── 窗口 / 应用 ───────────

  /** 窗口是否被系统「隐藏」（cloaked：别的虚拟桌面上的窗口、挂起的 UWP 窗口…）。dwmapi 不可用 / 调用失败就当没被隐藏 */
  const isCloaked = (hwnd) => {
    const f = state.fns.DwmGetWindowAttribute;
    if (!f) return false;
    const out = [0];
    try {
      return Number(f(hwnd, DWMWA_CLOAKED, out, 4)) === 0 && Number(out[0]) !== 0;
    } catch {
      return false; // 这只是个可选的过滤条件，失败了最多多列出几个幽灵窗口
    }
  };

  /** pid → 进程名（exe 文件名去 .exe）。打不开进程（权限不够 / 已退出）时用「未知进程#pid」 */
  const queryProcessName = (pid) => {
    const unknown = `未知进程#${pid}`;
    if (!state.fns.OpenProcess || !state.fns.CloseHandle || !state.fns.QueryFullProcessImageNameW) return unknown;
    const handle = call("OpenProcess", PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (isNullHandle(handle)) return unknown;
    try {
      const buf = Buffer.alloc(IMAGE_PATH_CHARS * 2);
      const size = [IMAGE_PATH_CHARS]; // 入：缓冲区字符数；出：写入的字符数
      if (Number(call("QueryFullProcessImageNameW", handle, 0, buf, size)) === 0) return unknown;
      const base = path.win32.basename(decodeWide(buf, Number(size[0]))).replace(/\.exe$/i, "");
      return base || unknown;
    } finally {
      bestEffort(() => call("CloseHandle", handle));
    }
  };

  /**
   * 枚举顶层窗口 → 内部记录（含 hwnd；hwnd 是 BigInt，不能对外暴露，对外的 DesktopAppInfo 必须可 JSON 化）。
   * 顺序 = EnumWindows 的顺序 = Z 序从上到下。
   * 回调里只收集句柄、不做任何别的 FFI 调用：回调由系统在 EnumWindows 内部同步调用，里面越简单越稳；
   * 逐个窗口的检查在 EnumWindows 返回之后做（窗口期间被销毁时各 API 返回失败，跳过即可）。
   */
  const collectWindows = () => {
    const handles = [];
    const ok = call(
      "EnumWindows",
      (hwnd) => {
        handles.push(hwnd);
        return 1; // TRUE：继续枚举
      },
      0,
    );
    if (Number(ok) === 0) throw internalError(`枚举窗口失败（EnumWindows）${codeText(lastErrorCode())}`);

    const titleBuf = Buffer.alloc(TITLE_CHARS * 2);
    const records = [];
    for (const hwnd of handles) {
      if (Number(call("IsWindowVisible", hwnd)) === 0) continue;
      const titleLen = Number(call("GetWindowTextW", hwnd, titleBuf, TITLE_CHARS));
      if (titleLen <= 0) continue; // 没有标题的多半是辅助 / 工具窗口
      const title = decodeWide(titleBuf, titleLen);
      if (title.trim() === "") continue;
      if (isCloaked(hwnd)) continue;
      const rect = {};
      if (Number(call("GetWindowRect", hwnd, rect)) === 0) continue;
      const pidOut = [0];
      call("GetWindowThreadProcessId", hwnd, pidOut);
      const pid = Number(pidOut[0]);
      if (!pid) continue;
      records.push({
        hwnd,
        pid,
        title,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        minimized: Number(call("IsIconic", hwnd)) !== 0, // 最小化只是标记，不过滤
        processName: "",
      });
    }

    const names = new Map();
    for (const r of records) {
      if (!names.has(r.pid)) names.set(r.pid, queryProcessName(r.pid));
      r.processName = names.get(r.pid);
    }
    return records;
  };

  /** 前台窗口所属进程的 pid；没有前台窗口 / 读不到返回 0 */
  const foregroundPid = () => {
    const hwnd = call("GetForegroundWindow");
    if (isNullHandle(hwnd)) return 0;
    const out = [0];
    call("GetWindowThreadProcessId", hwnd, out);
    return Number(out[0]) || 0;
  };

  const listApps = () => aggregateApps(collectWindows(), foregroundPid());

  const frontmostApp = () => {
    ensureLoaded();
    const pid = foregroundPid();
    if (!pid) return null;
    const hit = aggregateApps(collectWindows(), pid).find((a) => a.pid === pid);
    // 前台进程没有任何「可列出」的窗口（比如桌面 / 任务栏）：仍然返回它是谁，windows 为空
    return hit ?? { name: queryProcessName(pid), pid, frontmost: true, windows: [] };
  };

  /**
   * ShellExecuteExW 不可用时的回退（没绑上，或 SHELLEXECUTEINFOW 对不上，见 init）。
   * ⚠️ 这条路径可能弹模态框：ShellExecuteW 没有「不弹窗」开关，目标找不到时系统可能弹出「Windows 找不到文件……」，
   * 而我们在 Electron 主线程里同步调用它——人不在电脑前就会一直卡住。diagnostics().shellExecute 会显示当前走的是哪条路径。
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  const shellExecuteLegacy = (file) => {
    // 直接 FFI，没有 shell 解析：file 里的空格 / & 之类都只是普通字符，不会命令注入；lpParameters / lpDirectory 传 null
    const ret = Number(call("ShellExecuteW", null, "open", file, null, null, SW_SHOWNORMAL));
    if (ret > SHELLEXECUTE_SUCCESS_ABOVE) return { ok: true };
    return { ok: false, reason: `ShellExecute 返回 ${withMeaning(ret, SHELLEXECUTE_REASONS)}` };
  };

  /**
   * 首选路径：ShellExecuteExW + SEE_MASK_FLAG_NO_UI | NOASYNC，出错时系统不弹模态框。
   * 成败看返回值（非 0 = 成功）；失败原因先看 hInstApp（SE_ERR_*，1..32），它没给才看 GetLastError。
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  const shellExecuteEx = (file) => {
    const info = shellExecuteInfo({ size: state.structSizes.SHELLEXECUTEINFOW, file });
    if (Number(call("ShellExecuteExW", info)) !== 0) return { ok: true };
    const code = lastErrorCode(); // 紧跟在失败的 ShellExecuteExW 之后，中间不能插别的 FFI 调用
    const inst = Number(info.hInstApp ?? 0); // _Inout_ 写回的结果：BigInt（0 读成 null）
    if (Number.isInteger(inst) && inst >= 1 && inst <= SHELLEXECUTE_SUCCESS_ABOVE) {
      return { ok: false, reason: `ShellExecuteEx 返回 ${withMeaning(inst, SHELLEXECUTE_REASONS)}` };
    }
    if (code != null && code !== 0) return { ok: false, reason: `ShellExecuteEx 失败，Win32 错误码 ${withMeaning(code, WIN32_ERROR_REASONS)}` };
    return { ok: false, reason: "ShellExecuteEx 失败，系统没有给出具体原因" };
  };

  /**
   * 交给系统打开一个应用 / .lnk。reason 是写给 AI 的人话，不含路径。
   * koffi 层自己抛错（参数类型不对等）不算「打不开」，直接往外抛，别让后面的回退把程序错误盖住。
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  const shellOpen = (file) => (state.fns.ShellExecuteExW ? shellExecuteEx(file) : shellExecuteLegacy(file));

  /** openApp 当前走的是哪条 ShellExecute 路径（日志 / 诊断用）：ShellExecuteW 意味着「找不到目标时可能弹模态框」 */
  const shellExecuteMode = () => {
    if (state.fns.ShellExecuteExW) return "ShellExecuteExW";
    return state.fns.ShellExecuteW ? "ShellExecuteW" : "unavailable";
  };

  /**
   * @param {string} nameOrPath
   * @param {{ background?: boolean }} [opts] background：锁屏后台档用——应用已经在运行就只把最小化的窗口还原，不抢前台
   *   （锁屏时 SetForegroundWindow 本来就不管用，也不该因此报错）
   */
  const openApp = async (nameOrPath, opts = {}) => {
    ensureLoaded();
    const target = typeof nameOrPath === "string" ? nameOrPath.trim() : "";
    if (target === "") throw badArgs("要打开的应用名称或路径不能为空");
    if (target.length > MAX_TARGET_CHARS) throw badArgs(`应用名称或路径过长（最多 ${MAX_TARGET_CHARS} 个字符）`);
    // 目标校验先于任何系统调用：网址 / UNC / 脚本 / 文档这些，连 ShellExecute 的边都碰不到
    const rejected = rejectOpenTarget(target);
    if (rejected) throw badArgs(rejected);
    const shown = target.length > SHOWN_TARGET_CHARS ? `${target.slice(0, SHOWN_TARGET_CHARS)}…` : target;

    // 1) 交给系统：「notepad」「C:\...\app.exe」这类能直接打开
    const direct = shellOpen(target);
    if (direct.ok) return;

    // 2) 系统没能直接打开（多半是「微信」这种显示名，不是可执行文件名）：在已运行的窗口里找，切到前台
    let hit = null;
    let windowError = null;
    try {
      hit = matchWindow(collectWindows(), target);
    } catch (e) {
      windowError = e; // 枚举窗口也出错：记下来，继续往下找，最后和其它失败原因一起报
    }
    if (hit) {
      if (hit.minimized) call("ShowWindow", hit.hwnd, SW_RESTORE); // 返回值是「之前是否可见」，不是成败，不判断
      if (opts?.background === true) return; // 锁屏后台档：应用已在运行，不抢前台
      if (Number(call("SetForegroundWindow", hit.hwnd)) === 0) {
        throw internalError(
          `找到了「${hit.processName}」的窗口，但没能切到前台（Windows 的前台保护阻止了 Flowship 抢焦点）。可以先点击任务栏上它的图标，或点击它的窗口再继续`,
        );
      }
      return;
    }

    // 3) 还没找到：搜开始菜单里的快捷方式（纯 Node fs，不走 FFI），命中就打开那个 .lnk。
    //    只在前两步都失败后才扫，不在每次 openApp 都扫。
    //    含路径的目标是调用方明确指定的位置，不做模糊搜索：宁可报「找不到」，也不悄悄换成名字相近的别的程序
    let menuNote = "";
    if (!/[\\/]/.test(target)) {
      const { shortcuts, readable } = await scanStartMenu(env, fs);
      const shortcut = matchShortcut(shortcuts, target);
      if (shortcut) {
        const opened = shellOpen(shortcut.file);
        if (opened.ok) return;
        menuNote = `，开始菜单里找到快捷方式「${shortcut.name}」，但打开它也失败了（${opened.reason}）`;
      } else {
        menuNote = readable > 0 ? "，开始菜单里也没有名字匹配的快捷方式" : "，也没能读取开始菜单目录（没法按快捷方式查找）";
      }
    }

    // 错误里只放：目标（调用方自己传的）、各步失败的原因、快捷方式的显示名。不放目录路径 / 环境变量 / fs 的原始报错
    throw internalError(
      `打开「${shown}」失败：系统无法直接打开它（${direct.reason}），也没找到进程名或窗口标题包含它的窗口` +
        (windowError ? `（查找窗口时又出错：${describe(windowError)}）` : "") +
        menuNote +
        "。请先列出正在运行的应用确认名称，或改传完整的 exe 路径",
    );
  };

  // ─────────── 电源 / 锁屏 ───────────

  const wakeDisplay = async () => {
    ensureLoaded();
    // 两次相对位移（+1 再 −1）：只为产生一次「有鼠标活动」的输入把熄灭的显示器叫醒，指针基本回到原处
    sendInputs([mouseInput({ flags: MOUSEEVENTF.MOVE, dx: 1 })]);
    await sleep(WAKE_GAP_MS);
    sendInputs([mouseInput({ flags: MOUSEEVENTF.MOVE, dx: -1 })]);
  };

  const lockScreen = async () => {
    ensureLoaded();
    if (Number(call("LockWorkStation")) === 0) {
      throw internalError(`锁定电脑失败（LockWorkStation）${codeText(lastErrorCode())}：可能组策略禁用了锁屏`);
    }
  };

  // ─────────── init / 诊断 ───────────

  const init = async () => {
    if (platform !== "win32") return { ok: false, error: "仅 Windows 可用" };
    if (state.loaded) return { ok: true };
    Object.assign(state, freshState());

    const failure = (error) => {
      state.initError = error;
      say(`初始化失败：${error}`);
      return { ok: false, error };
    };

    // 1) 拿到 koffi（没注入就现在才加载；import 本模块时不碰它）
    let koffi;
    try {
      koffi = injectedKoffi ?? createRequire(import.meta.url)("koffi");
    } catch (e) {
      return failure(`加载原生组件 koffi 失败（安装包可能缺少 Windows 平台依赖）：${describe(e)}`);
    }
    state.koffi = koffi;

    // 2) 定义结构体，并和 Windows 的期望大小对账：SendInput 的 cbSize 不等于 sizeof(INPUT) 就会直接失败
    try {
      const types = defineWin32Types(koffi);
      const actual = {
        INPUT: koffi.sizeof(types.INPUT),
        MOUSEINPUT: koffi.sizeof(types.MOUSEINPUT),
        KEYBDINPUT: koffi.sizeof(types.KEYBDINPUT),
        LASTINPUTINFO: koffi.sizeof(types.LASTINPUTINFO),
      };
      state.structSizes = actual;
      state.inputSize = actual.INPUT;
    } catch (e) {
      return failure(`定义 Win32 结构体失败：${describe(e)}`);
    }
    const expected = expectedStructSizes(attempt(() => koffi.sizeof("void *"), 0));
    if (expected) {
      const wrong = CORE_STRUCT_NAMES.filter((k) => state.structSizes[k] !== expected[k]);
      if (wrong.length > 0) {
        return failure(
          `Win32 结构体大小与系统要求不一致（${wrong.map((k) => `${k}=${state.structSizes[k]}，应为 ${expected[k]}`).join("；")}），已停用输入注入以免 SendInput 失败 / 越界读写`,
        );
      }
    }

    // 2b) 可选结构体 SHELLEXECUTEINFOW（只服务 ShellExecuteExW）：定义失败 / 大小对不上都不是核心问题，
    //     只记下原因（→ ShellExecuteExW 不绑定、openApp 退回 ShellExecuteW，原因进 diagnostics），init 照常成功
    try {
      const size = koffi.sizeof(defineShellExecuteInfo(koffi));
      state.structSizes.SHELLEXECUTEINFOW = size;
      if (expected && size !== expected.SHELLEXECUTEINFOW) {
        state.typeProblems.SHELLEXECUTEINFOW = `SHELLEXECUTEINFOW 的实测大小是 ${size}，应为 ${expected.SHELLEXECUTEINFOW}`;
      }
    } catch (e) {
      state.typeProblems.SHELLEXECUTEINFOW = `定义 SHELLEXECUTEINFOW 失败：${describe(e)}`;
    }

    // 3) 加载系统库。加载失败的库，它名下的函数全部算「绑定失败」；dwmapi 没有核心函数，所以它失败不致命
    const libs = {};
    const libErrors = {};
    for (const [id, file] of Object.entries(WIN32_LIBRARIES)) {
      try {
        libs[id] = koffi.load(file);
      } catch (e) {
        libErrors[id] = describe(e);
      }
    }

    // 4) 逐个绑定函数，失败的名字收集起来（诊断可见），不影响其它函数
    for (const spec of WIN32_FUNCTIONS) {
      const lib = libs[spec.lib];
      try {
        // 依赖的可选结构体没准备好：不绑定（绑上了也没法正确传参）
        if (spec.needs && state.typeProblems[spec.needs]) throw new Error(state.typeProblems[spec.needs]);
        if (!lib) throw new Error(`${WIN32_LIBRARIES[spec.lib]} 加载失败：${libErrors[spec.lib]}`);
        state.fns[spec.name] = lib.func(spec.proto);
      } catch (e) {
        state.bindFailures.push(spec.name);
        state.bindErrors[spec.name] = describe(e);
      }
    }

    // 5) 核心函数一个都不能少
    const missing = CORE_FUNCTIONS.filter((name) => !state.fns[name]);
    if (missing.length > 0) {
      const reasons = [...new Set(missing.map((name) => state.bindErrors[name]))].join("；");
      return failure(`缺少核心 Win32 函数：${missing.join("、")}（${reasons}）`);
    }

    state.loaded = true;
    say(
      `初始化完成（koffi ${koffi.version ?? "?"}）` +
        (state.bindFailures.length > 0 ? `，${state.bindFailures.length} 个非核心函数未绑定：${state.bindFailures.join("、")}` : "") +
        (shellExecuteMode() === "ShellExecuteW" ? "；openApp 退回 ShellExecuteW（目标找不到时可能弹模态框）" : ""),
    );
    return { ok: true };
  };

  /** 当前输入桌面的三态描述（诊断用）。打不开 = 多半是锁屏 / UAC 的 Winlogon 安全桌面（推断） */
  const describeInputDesktop = () => {
    const probe = probeInputDesktop();
    if (probe.state === "denied") return "Winlogon";
    if (probe.state === "ok") {
      const name = probe.name.toLowerCase();
      if (name === "default") return "Default";
      if (name === "winlogon") return "Winlogon";
    }
    return "unknown";
  };

  const readVirtualScreen = () => ({
    x: Number(call("GetSystemMetrics", SM.XVIRTUALSCREEN)),
    y: Number(call("GetSystemMetrics", SM.YVIRTUALSCREEN)),
    width: Number(call("GetSystemMetrics", SM.CXVIRTUALSCREEN)),
    height: Number(call("GetSystemMetrics", SM.CYVIRTUALSCREEN)),
  });

  /** 主线程的 DPI 感知状态：核对「输入坐标 = 物理像素」这个假设用（per-monitor 才成立） */
  const readDpiAwareness = () => {
    if (!state.fns.GetThreadDpiAwarenessContext || !state.fns.GetAwarenessFromDpiAwarenessContext) return "unknown";
    const context = call("GetThreadDpiAwarenessContext");
    return DPI_AWARENESS_NAMES[Number(call("GetAwarenessFromDpiAwarenessContext", context))] ?? "unknown";
  };

  /** 诊断快照：JSON 可序列化，不含任何用户内容（没有窗口标题 / 输入文本 / 路径 / 环境变量）。init 之前、失败之后都能调 */
  const diagnostics = () => {
    const snapshot = {
      platform,
      osRelease: attempt(() => os.release(), null),
      arch: process.arch,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      koffi: state.koffi?.version ?? null,
      loaded: state.loaded,
      initError: state.initError,
      bindFailures: [...state.bindFailures],
      bindErrors: { ...state.bindErrors },
      structSizes: state.structSizes ? { ...state.structSizes } : null,
      screen: null,
      virtualScreen: null,
      dpiAwareness: "unknown",
      inputDesktop: "unknown",
      /** 会话锁定标志（WTSSessionInfoEx）：locked / unlocked / unknown。真机验证 UAC / 锁屏区分时看它 */
      sessionLock: "unknown",
      shellExecute: "unknown",
    };
    if (!state.loaded) return snapshot;
    // openApp 走哪条路径：ShellExecuteW = ShellExecuteExW 不可用（原因在 bindErrors.ShellExecuteExW），此时找不到目标可能弹模态框
    snapshot.shellExecute = shellExecuteMode();
    snapshot.screen = attempt(() => {
      const { width, height } = getPrimaryDisplay();
      return { width, height };
    }, null);
    snapshot.virtualScreen = attempt(readVirtualScreen, null);
    snapshot.dpiAwareness = attempt(readDpiAwareness, "unknown");
    snapshot.inputDesktop = attempt(describeInputDesktop, "unknown");
    snapshot.sessionLock = attempt(sessionLockState, "unknown");
    snapshot.background = background.diagnostics();
    return snapshot;
  };

  // ─────────── 锁屏后台档（PostMessage + PrintWindow；定义见 win32-background.mjs，函数懒绑定，init 不碰它） ───────────

  const background = createWin32Background({
    getKoffi: () => state.koffi,
    ensureLoaded,
    callCore: (name, ...args) => call(name, ...args),
    hasCore: (name) => Boolean(state.fns[name]),
    lastErrorCode,
    queryProcessName,
    isCloaked,
    getPrimaryDisplay,
    scanOf,
    sleep,
    now: () => Date.now(),
    say,
    ownPid: process.pid,
    openApp: (target, opts) => openApp(target, opts),
  });

  return {
    platform: "win32",
    init,
    diagnostics,
    background,
    isScreenLocked,
    isSecureDesktopActive,
    idleSeconds,
    getPrimaryDisplay,
    mouseMove,
    click,
    drag,
    scroll,
    keyCombo,
    typeText,
    frontmostApp,
    listApps,
    openApp,
    wakeDisplay,
    lockScreen,
  };
};
