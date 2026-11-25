/**
 * Windows 驱动的静态定义：Win32 常量、结构体、函数原型、虚拟键码表。
 *
 * 为什么单拆一个文件：
 * - 常量 / 原型占了驱动一半篇幅，拆出来后 win32.mjs 只剩「调用序列」，对照需求一眼能看完；
 * - 结构体定义（defineWin32Types）必须是「驱动」和「布局单测」共用的同一份：单测在 Mac 上用真 koffi 断言
 *   大小 / 偏移 / 编码字节，这是没有 Windows 机器时我们能拿到的唯一 Win32 布局证据。
 *
 * 本模块是纯声明：import 时不加载 koffi、不碰系统；koffi 一律由调用方传进来。
 * 唯一的「逻辑」是文末的 rejectOpenTarget（open_app 的目标校验）：它是不依赖任何模块的纯函数，放在这里方便单测穷举。
 * 数值全部来自 Windows SDK 头文件（winuser.h 等），注释里标了头文件里的名字，方便逐条对照。
 *
 * Win32 类型一律写成「显式宽度」的 C 类型：LONG→int32_t、DWORD / UINT→uint32_t、WORD→uint16_t、
 * BOOL→int、ULONG_PTR→uintptr_t、HANDLE / HWND / HDESK→void *。不用 long / unsigned long：
 * 它们在 macOS（LP64）是 8 字节、在 Windows 是 4 字节，显式宽度才能让 Mac 上的布局断言与 Win64 一致。
 * BOOL 也不用 koffi 的 bool（1 字节）：Win32 的 BOOL 是 4 字节 int，按 1 字节读低位可能把非零值误判成 FALSE。
 */

// ═══════════════════════════ 常量 ═══════════════════════════

/** INPUT.type（winuser.h：INPUT_MOUSE / INPUT_KEYBOARD） */
export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

/**
 * MOUSEINPUT.dwFlags（winuser.h：MOUSEEVENTF_*）。
 * 注意我们从不使用 ABSOLUTE（0x8000）：光标定位一律走 SetCursorPos，避开 0..65535 归一化坐标的取整误差。
 */
export const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
});

/** KEYBDINPUT.dwFlags（winuser.h：KEYEVENTF_*） */
export const KEYEVENTF = Object.freeze({
  EXTENDEDKEY: 0x0001,
  KEYUP: 0x0002,
  UNICODE: 0x0004,
  SCANCODE: 0x0008,
});

/** 滚轮一「格」的增量（winuser.h：WHEEL_DELTA）。mouseData 正值 = 向上 / 向右 */
export const WHEEL_DELTA = 120;

/** GetSystemMetrics 的 nIndex（winuser.h：SM_*） */
export const SM = Object.freeze({
  CXSCREEN: 0,
  CYSCREEN: 1,
  XVIRTUALSCREEN: 76,
  YVIRTUALSCREEN: 77,
  CXVIRTUALSCREEN: 78,
  CYVIRTUALSCREEN: 79,
});

/** GetUserObjectInformationW 的 nIndex：桌面 / 窗口站名字（winuser.h：UOI_NAME） */
export const UOI_NAME = 2;
/** OpenInputDesktop 的访问掩码（winuser.h：DESKTOP_SWITCHDESKTOP） */
export const DESKTOP_SWITCHDESKTOP = 0x0100;
/** OpenInputDesktop 的访问掩码（winuser.h：DESKTOP_READOBJECTS）：C# 解锁组件读桌面名用的就是它 */
export const DESKTOP_READOBJECTS = 0x0001;
/**
 * 探测输入桌面时实际申请的访问掩码：READOBJECTS | SWITCHDESKTOP。
 * 只申请 SWITCHDESKTOP 的话，GetUserObjectInformationW(UOI_NAME) 能不能用这个句柄读出桌面名没有在真机上验证过
 * （读不出来 ⇒ 桌面状态永远是 unknown ⇒ 整个功能不可用）；多申请一个 READOBJECTS 没有代价：
 * 普通用户进程对 Default 桌面本来就有这个权限，对 Winlogon 桌面（锁屏 / UAC）则无论申请什么都是拒绝。
 */
export const INPUT_DESKTOP_ACCESS = DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP;
/** OpenProcess 的访问掩码：只查询镜像路径等有限信息（winnt.h：PROCESS_QUERY_LIMITED_INFORMATION） */
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** DwmGetWindowAttribute 的属性号：窗口是否被系统隐藏（dwmapi.h：DWMWA_CLOAKED），值非 0 = 被 cloak */
export const DWMWA_CLOAKED = 14;
/**
 * WTSQuerySessionInformationW（wtsapi32.h）：查「本会话是否处于锁定状态」，用来把锁屏和 UAC / Ctrl+Alt+Del 的安全桌面分开
 * （两者对用户进程来说长得一样：输入桌面都是 Winlogon、OpenInputDesktop 都被拒）。
 * - WTS_CURRENT_SESSION：(DWORD)-1，当前进程所在的会话；WTS_CURRENT_SERVER_HANDLE = NULL：本机。
 * - WTSSessionInfoEx：WTS_INFO_CLASS 的第 25 项，返回 WTSINFOEXW。
 * - WTSINFOEXW 的内存布局（x86 / x64 一致，LARGE_INTEGER 要求 8 字节对齐）：
 *     +0  Level（DWORD，应为 1）   +4  对齐空洞   +8  SessionId   +12 SessionState   +16 SessionFlags
 * - SessionFlags：WTS_SESSIONSTATE_LOCK = 0（已锁定）/ WTS_SESSIONSTATE_UNLOCK = 1（没锁）/ WTS_SESSIONSTATE_UNKNOWN = 0xFFFFFFFF。
 *   （微软文档注：Windows 7 / Server 2008 R2 上这两个值是反的；本功能只支持 Windows 10+，不处理。）
 */
export const WTS_CURRENT_SESSION = 0xffffffff;
export const WTS_SESSION_INFO_EX = 25;
export const WTSINFOEX_OFFSETS = Object.freeze({ level: 0, sessionId: 8, sessionState: 12, sessionFlags: 16 });
/** 只读到 SessionFlags 为止（20 字节）就够了 */
export const WTSINFOEX_READ_BYTES = 20;
export const WTS_SESSIONSTATE_LOCK = 0;
export const WTS_SESSIONSTATE_UNLOCK = 1;
/** ShowWindow 的 nCmdShow（winuser.h：SW_SHOWNORMAL / SW_RESTORE） */
export const SW_SHOWNORMAL = 1;
export const SW_RESTORE = 9;
/** MapVirtualKeyW 的 uMapType：虚拟键码 → 扫描码（winuser.h：MAPVK_VK_TO_VSC） */
export const MAPVK_VK_TO_VSC = 0;
/** ShellExecuteW 的返回值 > 32 才算成功，≤ 32 是错误码（shellapi.h 文档）；ShellExecuteExW 的 hInstApp 同理 */
export const SHELLEXECUTE_SUCCESS_ABOVE = 32;
/**
 * ShellExecuteExW 的 fMask（shellapi.h：SEE_MASK_*）。
 * - FLAG_NO_UI：出错时不弹任何错误对话框。人不在电脑前时，模态框没人点，调用线程（Electron 主线程）会一直卡在里面；
 * - NOASYNC：同步完成，不留到后台线程，失败原因才能在返回前拿到。
 * 故意不带 NOCLOSEPROCESS（0x40：我们不要进程句柄，带了反而要自己 CloseHandle）和 DOENVSUBST（0x200：不展开 %VAR%）。
 */
export const SEE_MASK = Object.freeze({
  NOASYNC: 0x00000100,
  FLAG_NO_UI: 0x00000400,
});

/** GetAwarenessFromDpiAwarenessContext 的返回值（windef.h：DPI_AWARENESS_*）→ 可读名 */
export const DPI_AWARENESS_NAMES = Object.freeze({
  0: "unaware",
  1: "system",
  2: "per-monitor",
});

// ═══════════════════════════ 虚拟键码 ═══════════════════════════

/** 虚拟键码（winuser.h：VK_*）。标点键对应「美式键盘布局」上的字符（见 KEY_TABLE 的说明） */
export const VK = Object.freeze({
  BACK: 0x08,
  TAB: 0x09,
  RETURN: 0x0d,
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12, // Alt
  ESCAPE: 0x1b,
  SPACE: 0x20,
  PRIOR: 0x21, // PageUp
  NEXT: 0x22, // PageDown
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  DELETE: 0x2e,
  LWIN: 0x5b,
  F1: 0x70, // F1–F20 依次递增到 0x83
  OEM_1: 0xba, // ;:
  OEM_PLUS: 0xbb, // =+
  OEM_COMMA: 0xbc, // ,<
  OEM_MINUS: 0xbd, // -_
  OEM_PERIOD: 0xbe, // .>
  OEM_2: 0xbf, // /?
  OEM_3: 0xc0, // `~
  OEM_4: 0xdb, // [{
  OEM_5: 0xdc, // \|
  OEM_6: 0xdd, // ]}
  OEM_7: 0xde, // '"
});

/** 修饰键的固定按下顺序（抬起时倒序）。与 keys.mjs 的 MOD_ORDER 一致，但驱动不假设输入已排好序 */
export const MODIFIER_ORDER = Object.freeze(["ctrl", "alt", "shift", "meta"]);
/** 修饰键 → 虚拟键码。用不区分左右的通用码（VK_CONTROL / VK_MENU / VK_SHIFT），meta = 左 Win 键 */
export const MODIFIER_VK = Object.freeze({
  ctrl: VK.CONTROL,
  alt: VK.MENU,
  shift: VK.SHIFT,
  meta: VK.LWIN,
});
/** 修饰键是否要带 EXTENDEDKEY：Win 键的扫描码带 E0 前缀（扩展键），Ctrl / Alt / Shift 的通用码不需要 */
export const MODIFIER_EXTENDED = Object.freeze({
  ctrl: false,
  alt: false,
  shift: false,
  meta: true,
});

/**
 * @typedef {Object} KeyEntry
 * @property {number} vk         虚拟键码
 * @property {boolean} extended  是否扩展键（要带 KEYEVENTF_EXTENDEDKEY）。方向键 / Home / End / PageUp / PageDown / Delete
 *                               与小键盘的同码键共用扫描码，靠 E0 前缀区分；不带这个标志，系统会当成小键盘键
 * @property {boolean} shift     是否需要自动补 shift（只有 plus：美式布局上 + 是 Shift+=）
 */

/** 构建「规范键名 → 键码」表。规范键名全集见 keys.mjs 的 CANONICAL_KEYS（单测遍历它保证无遗漏） */
const buildKeyTable = () => {
  /** @type {Record<string, KeyEntry>} */
  const table = {};
  const add = (key, vk, { extended = false, shift = false } = {}) => {
    table[key] = Object.freeze({ vk, extended, shift });
  };

  for (let i = 0; i < 26; i += 1) add(String.fromCharCode(97 + i), 0x41 + i); // a–z → 'A'–'Z' 的码
  for (let i = 0; i < 10; i += 1) add(String(i), 0x30 + i); // 0–9 → '0'–'9' 的码（主键盘数字行）
  for (let i = 1; i <= 20; i += 1) add(`f${i}`, VK.F1 + i - 1);

  add("enter", VK.RETURN);
  add("escape", VK.ESCAPE);
  add("tab", VK.TAB);
  add("space", VK.SPACE);
  add("backspace", VK.BACK);
  add("delete", VK.DELETE, { extended: true });
  add("left", VK.LEFT, { extended: true });
  add("up", VK.UP, { extended: true });
  add("right", VK.RIGHT, { extended: true });
  add("down", VK.DOWN, { extended: true });
  add("home", VK.HOME, { extended: true });
  add("end", VK.END, { extended: true });
  add("pageup", VK.PRIOR, { extended: true });
  add("pagedown", VK.NEXT, { extended: true });

  // 标点：按美式键盘布局的 VK_OEM_* 码。别的布局（德语 / 法语…）上同一个码对应别的字符，这是已知限制
  add("=", VK.OEM_PLUS);
  add("minus", VK.OEM_MINUS);
  add("-", VK.OEM_MINUS); // 规范键里只有 minus，保留 "-" 方便直接按字符查
  add("plus", VK.OEM_PLUS, { shift: true }); // + 是 Shift+=，自动补 shift
  add("[", VK.OEM_4);
  add("]", VK.OEM_6);
  add("\\", VK.OEM_5);
  add(";", VK.OEM_1);
  add("'", VK.OEM_7);
  add(",", VK.OEM_COMMA);
  add(".", VK.OEM_PERIOD);
  add("/", VK.OEM_2);
  add("`", VK.OEM_3);

  return Object.freeze(table);
};

/** 规范键名 → 键码。只读 */
export const KEY_TABLE = buildKeyTable();

/**
 * 按规范键名查键码；不认识返回 null（用 hasOwn 防止 "constructor" 之类原型链上的名字被误当成键）。
 * @param {unknown} name
 * @returns {KeyEntry | null}
 */
export const lookupKey = (name) => (typeof name === "string" && Object.hasOwn(KEY_TABLE, name) ? KEY_TABLE[name] : null);

/** 鼠标按钮 → 按下 / 抬起标志 */
export const BUTTON_FLAGS = Object.freeze({
  left: Object.freeze({ down: MOUSEEVENTF.LEFTDOWN, up: MOUSEEVENTF.LEFTUP }),
  right: Object.freeze({ down: MOUSEEVENTF.RIGHTDOWN, up: MOUSEEVENTF.RIGHTUP }),
  middle: Object.freeze({ down: MOUSEEVENTF.MIDDLEDOWN, up: MOUSEEVENTF.MIDDLEUP }),
});

// ═══════════════════════════ INPUT 事件构造 ═══════════════════════════
// 返回的对象形状就是 koffi 接受的「INPUT 值」：type + 联合体 u（对象字面量里恰好写一个成员，koffi 文档 composites.md 的写法）。
// 所有字段都显式写满（koffi 对缺失成员虽然补 0，但没必要依赖）。

/**
 * 键盘事件。
 * @param {{ vk?: number, scan?: number, flags?: number }} p
 */
export const keyboardInput = ({ vk = 0, scan = 0, flags = 0 }) => ({
  type: INPUT_KEYBOARD,
  u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
});

/**
 * 鼠标事件（相对位移 dx / dy 只有 MOVE 标志时有意义；mouseData 是 DWORD，负数调用方先 >>> 0）。
 * @param {{ flags: number, dx?: number, dy?: number, data?: number }} p
 */
export const mouseInput = ({ flags, dx = 0, dy = 0, data = 0 }) => ({
  type: INPUT_MOUSE,
  u: { mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
});

// ═══════════════════════════ 结构体 ═══════════════════════════

/**
 * @typedef {Object} Win32Types
 * @property {unknown} MOUSEINPUT
 * @property {unknown} KEYBDINPUT
 * @property {unknown} HARDWAREINPUT
 * @property {unknown} INPUT
 * @property {unknown} LASTINPUTINFO
 * @property {unknown} RECT
 * @property {unknown} WNDENUMPROC
 */

/**
 * 同一个 koffi 实例只能定义一次同名类型（再定义会抛 "Duplicate type name"，2026-11 在 koffi 3.3.8 实测），
 * 所以按 koffi 实例缓存：驱动 init 多次 / 单测多处调用都拿到同一份。WeakMap：不拦着 koffi 被回收。
 * @type {WeakMap<object, Win32Types>}
 */
const typeCache = new WeakMap();

/**
 * 在 koffi 里定义驱动用到的全部 Win32 类型，并返回类型对象。驱动与布局单测共用这一份。
 * 官方定义（winuser.h / windef.h）与 Win64 下的期望大小见 expectedStructSizes。
 * @param {{ struct: Function, union: Function, proto: Function }} koffi
 * @returns {Win32Types}
 */
export const defineWin32Types = (koffi) => {
  const cached = typeCache.get(koffi);
  if (cached) return cached;

  // typedef struct tagMOUSEINPUT { LONG dx; LONG dy; DWORD mouseData; DWORD dwFlags; DWORD time; ULONG_PTR dwExtraInfo; }
  const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
    dx: "int32_t", // LONG
    dy: "int32_t", // LONG
    mouseData: "uint32_t", // DWORD：WHEEL / HWHEEL 时是滚动量（有符号数的位模式，所以调用方要 >>> 0 转无符号）
    dwFlags: "uint32_t", // DWORD：MOUSEEVENTF_*
    time: "uint32_t", // DWORD：0 = 让系统自己打时间戳
    dwExtraInfo: "uintptr_t", // ULONG_PTR：Win64 是 8 字节，这就是 MOUSEINPUT 对齐到 8、总长 32 的原因
  });

  // typedef struct tagKEYBDINPUT { WORD wVk; WORD wScan; DWORD dwFlags; DWORD time; ULONG_PTR dwExtraInfo; }
  const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
    wVk: "uint16_t", // WORD
    wScan: "uint16_t", // WORD：UNICODE 事件里是 UTF-16 code unit
    dwFlags: "uint32_t", // DWORD：KEYEVENTF_*
    time: "uint32_t",
    dwExtraInfo: "uintptr_t",
  });

  // typedef struct tagHARDWAREINPUT { DWORD uMsg; WORD wParamL; WORD wParamH; }——用不到，但联合体要有它才和系统定义一致
  const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", {
    uMsg: "uint32_t",
    wParamL: "uint16_t",
    wParamH: "uint16_t",
  });

  // typedef struct tagINPUT { DWORD type; union { MOUSEINPUT mi; KEYBDINPUT ki; HARDWAREINPUT hi; } DUMMYUNIONNAME; }
  // Win64：type(4) + 填充(4) + 联合体(32，对齐 8) = 40
  const INPUT = koffi.struct("INPUT", {
    type: "uint32_t",
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  });

  // typedef struct tagLASTINPUTINFO { UINT cbSize; DWORD dwTime; }——cbSize 必须先填成 sizeof(LASTINPUTINFO)，所以调用时按 _Inout_ 传
  const LASTINPUTINFO = koffi.struct("LASTINPUTINFO", {
    cbSize: "uint32_t",
    dwTime: "uint32_t",
  });

  // typedef struct tagRECT { LONG left; LONG top; LONG right; LONG bottom; }
  const RECT = koffi.struct("RECT", {
    left: "int32_t",
    top: "int32_t",
    right: "int32_t",
    bottom: "int32_t",
  });

  // BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam)——LPARAM 是 LONG_PTR（指针宽度的有符号整数），所以用 intptr_t。
  // 回调的 hwnd 参数到 JS 是 BigInt（koffi 3 把指针都表示成 BigInt，callbacks.md「Decoding pointer arguments」）
  const WNDENUMPROC = koffi.proto("int __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)");

  const types = Object.freeze({ MOUSEINPUT, KEYBDINPUT, HARDWAREINPUT, INPUT, LASTINPUTINFO, RECT, WNDENUMPROC });
  typeCache.set(koffi, types);
  return types;
};

/** 同 typeCache，只缓存 SHELLEXECUTEINFOW（它单独定义，见 defineShellExecuteInfo） */
const shellInfoCache = new WeakMap();

/**
 * 定义 SHELLEXECUTEINFOW（shellapi.h）并返回类型对象。
 *
 * 为什么不和核心类型一起放进 defineWin32Types：它只服务 ShellExecuteExW（非核心）。定义失败 / 大小对不上的后果
 * 只应该是「openApp 退回 ShellExecuteW」，不能拖累 init 对核心结构体的判定，所以单独定义、单独 try、单独缓存。
 *
 * 官方定义：
 *   typedef struct _SHELLEXECUTEINFOW {
 *     DWORD cbSize; ULONG fMask; HWND hwnd; LPCWSTR lpVerb; LPCWSTR lpFile; LPCWSTR lpParameters; LPCWSTR lpDirectory;
 *     int nShow; HINSTANCE hInstApp; void *lpIDList; LPCWSTR lpClass; HKEY hkeyClass; DWORD dwHotKey;
 *     union { HANDLE hIcon; HANDLE hMonitor; } DUMMYUNIONNAME; HANDLE hProcess;
 *   } SHELLEXECUTEINFOW;
 * Win64 偏移：cbSize 0 / fMask 4 / hwnd 8 / lpVerb 16 / lpFile 24 / lpParameters 32 / lpDirectory 40 / nShow 48（后补 4 字节填充）/
 *   hInstApp 56 / lpIDList 64 / lpClass 72 / hkeyClass 80 / dwHotKey 88（后补 4 字节填充）/ hIcon·hMonitor 96 / hProcess 104，总 112。
 * Win32：15 个字段全是 4 字节，没有填充，总 60。
 *
 * ⚠️ 给 koffi 传这个结构体时，成员类型必须和下面的声明严格一致：整数成员只能给数字，指针成员给 null 或 BigInt，
 * 字符串成员给 string 或 null。类型不符时 koffi 不抛 JS 异常，而是直接 abort 整个进程（2026-11 在 koffi 3.3.8 上实测：
 * 给 uint32_t 成员传 null / 字符串都是 SIGABRT）。所以入参一律由 shellExecuteInfo() 构造，不要手写。
 * @param {{ struct: Function }} koffi
 * @returns {unknown}
 */
export const defineShellExecuteInfo = (koffi) => {
  const cached = shellInfoCache.get(koffi);
  if (cached) return cached;
  const SHELLEXECUTEINFOW = koffi.struct("SHELLEXECUTEINFOW", {
    cbSize: "uint32_t", // DWORD：必须先填成 sizeof(SHELLEXECUTEINFOW)
    fMask: "uint32_t", // ULONG（Windows 上 unsigned long 是 4 字节）：SEE_MASK_*
    hwnd: "void *", // HWND：null = 没有属主窗口
    lpVerb: "const char16_t *", // LPCWSTR："open"
    lpFile: "const char16_t *", // LPCWSTR：要打开的应用 / .lnk
    lpParameters: "const char16_t *", // LPCWSTR：始终 null，不带任何参数
    lpDirectory: "const char16_t *", // LPCWSTR：始终 null
    nShow: "int", // int：SW_SHOWNORMAL
    hInstApp: "void *", // HINSTANCE（输出）：成功时 > 32；失败时是 SE_ERR_*（≤ 32）。读回来是 BigInt，0 读成 null
    lpIDList: "void *", // 没用到（要配合 SEE_MASK_IDLIST）
    lpClass: "const char16_t *", // 没用到（要配合 SEE_MASK_CLASSNAME）
    hkeyClass: "void *", // 没用到（要配合 SEE_MASK_CLASSKEY）
    dwHotKey: "uint32_t", // 没用到（要配合 SEE_MASK_HOTKEY）
    hIconOrMonitor: "void *", // union { HANDLE hIcon; HANDLE hMonitor; }：两者同位同宽，用一个指针字段表示
    hProcess: "void *", // 输出：只有带 SEE_MASK_NOCLOSEPROCESS 才会给，我们不要，始终 null
  });
  shellInfoCache.set(koffi, SHELLEXECUTEINFOW);
  return SHELLEXECUTEINFOW;
};

/**
 * ShellExecuteExW 的入参：字段全部显式写满，类型与 defineShellExecuteInfo 的声明严格一致（理由见那里的 ⚠️）。
 * 不带 NOCLOSEPROCESS（不要进程句柄）、不带 DOENVSUBST（lpFile 里的 %VAR% 不展开）；lpParameters / lpDirectory 为 null。
 * @param {{ size: number, file: string }} p  size = koffi 实测的 sizeof(SHELLEXECUTEINFOW)；file = 要打开的应用名 / 路径
 */
export const shellExecuteInfo = ({ size, file }) => ({
  cbSize: size,
  fMask: SEE_MASK.NOASYNC | SEE_MASK.FLAG_NO_UI,
  hwnd: null,
  lpVerb: "open",
  lpFile: file,
  lpParameters: null,
  lpDirectory: null,
  nShow: SW_SHOWNORMAL,
  hInstApp: null,
  lpIDList: null,
  lpClass: null,
  hkeyClass: null,
  dwHotKey: 0,
  hIconOrMonitor: null,
  hProcess: null,
});

/**
 * 核心结构体：对账不一致就拒绝启用驱动（SendInput 的 cbSize 不对，输入注入整条链路都不可信）。
 * 不在这里的结构体（目前只有 SHELLEXECUTEINFOW）是「可选」的：对不上只会让依赖它的函数不绑定，init 照常成功。
 */
export const CORE_STRUCT_NAMES = Object.freeze(["INPUT", "MOUSEINPUT", "KEYBDINPUT", "LASTINPUTINFO"]);

/**
 * Win32 / Win64 下这几个结构体的期望大小（SendInput 的 cbSize 必须等于 sizeof(INPUT)，否则 API 直接失败）。
 * 驱动 init 时拿 koffi.sizeof 的结果跟它对账：核心结构体（CORE_STRUCT_NAMES）不一致就拒绝启用输入注入，
 * 而不是让 SendInput 神秘失败；SHELLEXECUTEINFOW 不一致则只放弃 ShellExecuteExW，退回 ShellExecuteW。
 * 64 位的数值在 Mac 上由布局单测验证；32 位的数值是按各字段宽度手算的，单测里另用一个独立的 C 对齐算术核对
 * （都不是真 32 位 Windows 上的实测）。
 * @param {number} pointerSize 指针宽度（字节），koffi.sizeof("void *")
 * @returns {{ INPUT: number, MOUSEINPUT: number, KEYBDINPUT: number, LASTINPUTINFO: number, SHELLEXECUTEINFOW: number } | null} 无法判断时 null
 */
export const expectedStructSizes = (pointerSize) => {
  if (pointerSize === 8) return { INPUT: 40, MOUSEINPUT: 32, KEYBDINPUT: 24, LASTINPUTINFO: 8, SHELLEXECUTEINFOW: 112 };
  if (pointerSize === 4) return { INPUT: 28, MOUSEINPUT: 24, KEYBDINPUT: 16, LASTINPUTINFO: 8, SHELLEXECUTEINFOW: 60 };
  return null;
};

// ═══════════════════════════ 动态库与函数原型 ═══════════════════════════

/**
 * 用到的系统库。dwmapi 只用来识别「被系统隐藏（cloaked）的窗口」；wtsapi32 只用来分清「锁屏」和「UAC 等安全桌面」——
 * 两者加载 / 绑定失败都不致命（后者读不到时按老办法把非 Default 桌面当锁屏，真正输入密码前 typist 自己会再验一遍）
 */
export const WIN32_LIBRARIES = Object.freeze({
  user32: "user32.dll",
  kernel32: "kernel32.dll",
  shell32: "shell32.dll",
  dwmapi: "dwmapi.dll",
  wtsapi32: "wtsapi32.dll",
});

/**
 * @typedef {Object} Win32FunctionSpec
 * @property {'user32'|'kernel32'|'shell32'|'dwmapi'|'wtsapi32'} lib
 * @property {string} name   导出函数名（也是 koffi 绑定后在驱动内部的名字）
 * @property {boolean} core  核心函数：缺任何一个，init 就返回 ok:false
 * @property {string} [needs]  依赖的可选结构体名（目前只有 SHELLEXECUTEINFOW）：该结构体定义失败 / 大小对不上时，这个函数不绑定
 * @property {string} proto  koffi 的 C 原型字符串
 */

/**
 * 逐个绑定的函数清单。每条上面的注释是 Windows SDK 里的官方签名，下面的 proto 是它的 koffi 写法，方便逐条对照。
 *
 * 写法约定：
 * - 全部带 __stdcall：Win32 API 的调用约定。x64 / arm64 上被 koffi 忽略；x86 上必须写对，否则会崩（load.md「Calling conventions」）。
 * - BOOL / int 返回值一律声明为 int（4 字节），调用方用 `!== 0` 判断，不依赖 koffi 的 bool。
 * - HWND / HANDLE / HDESK 一律 void *：koffi 3 里指针是 BigInt，NULL 是 null。
 * - 宽字符串输入用 const char16_t *（koffi 转 UTF-16 + NUL 结尾）；宽字符串输出用 _Out_ void * + Node Buffer，再用 utf16le 解码。
 * - 单个整数的输出参数（LPDWORD 等）用 _Out_ / _Inout_ uint32_t *，调用时传单元素数组 [0]，返回后读 [0]（output.md）。
 *
 * @type {ReadonlyArray<Win32FunctionSpec>}
 */
export const WIN32_FUNCTIONS = Object.freeze([
  // ── user32.dll：输入注入 / 光标 / 屏幕 / 桌面 ──
  // UINT SendInput(UINT cInputs, LPINPUT pInputs, int cbSize);   返回成功注入的事件数
  { lib: "user32", name: "SendInput", core: true, proto: "uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)" },
  // BOOL SetCursorPos(int X, int Y);
  { lib: "user32", name: "SetCursorPos", core: true, proto: "int __stdcall SetCursorPos(int X, int Y)" },
  // int GetSystemMetrics(int nIndex);
  { lib: "user32", name: "GetSystemMetrics", core: true, proto: "int __stdcall GetSystemMetrics(int nIndex)" },
  // BOOL GetLastInputInfo(PLASTINPUTINFO plii);   cbSize 要先填好，所以是 _Inout_
  { lib: "user32", name: "GetLastInputInfo", core: true, proto: "int __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)" },
  // HDESK OpenInputDesktop(DWORD dwFlags, BOOL fInherit, ACCESS_MASK dwDesiredAccess);   失败返回 NULL
  { lib: "user32", name: "OpenInputDesktop", core: true, proto: "void *__stdcall OpenInputDesktop(uint32_t dwFlags, int fInherit, uint32_t dwDesiredAccess)" },
  // BOOL CloseDesktop(HDESK hDesktop);
  { lib: "user32", name: "CloseDesktop", core: true, proto: "int __stdcall CloseDesktop(void *hDesktop)" },
  // BOOL GetUserObjectInformationW(HANDLE hObj, int nIndex, PVOID pvInfo, DWORD nLength, LPDWORD lpnLengthNeeded);
  {
    lib: "user32",
    name: "GetUserObjectInformationW",
    core: false,
    proto: "int __stdcall GetUserObjectInformationW(void *hObj, int nIndex, _Out_ void *pvInfo, uint32_t nLength, _Out_ uint32_t *lpnLengthNeeded)",
  },
  // UINT MapVirtualKeyW(UINT uCode, UINT uMapType);   键事件的 wScan 填它（部分应用依赖扫描码）
  { lib: "user32", name: "MapVirtualKeyW", core: false, proto: "uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)" },
  // BOOL LockWorkStation();   只是「请求」锁屏，真正锁定是异步的
  { lib: "user32", name: "LockWorkStation", core: false, proto: "int __stdcall LockWorkStation()" },

  // ── user32.dll：窗口 ──
  // HWND GetForegroundWindow();
  { lib: "user32", name: "GetForegroundWindow", core: false, proto: "void *__stdcall GetForegroundWindow()" },
  // BOOL EnumWindows(WNDENUMPROC lpEnumFunc, LPARAM lParam);   同步调用回调，所以用临时回调（callbacks.md「Transient callbacks」）
  { lib: "user32", name: "EnumWindows", core: false, proto: "int __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)" },
  // BOOL IsWindowVisible(HWND hWnd);
  { lib: "user32", name: "IsWindowVisible", core: false, proto: "int __stdcall IsWindowVisible(void *hWnd)" },
  // BOOL IsIconic(HWND hWnd);   最小化
  { lib: "user32", name: "IsIconic", core: false, proto: "int __stdcall IsIconic(void *hWnd)" },
  // int GetWindowTextW(HWND hWnd, LPWSTR lpString, int nMaxCount);   返回复制的字符数（不含结尾 NUL），0 = 空标题或失败
  { lib: "user32", name: "GetWindowTextW", core: false, proto: "int __stdcall GetWindowTextW(void *hWnd, _Out_ void *lpString, int nMaxCount)" },
  // BOOL GetWindowRect(HWND hWnd, LPRECT lpRect);
  { lib: "user32", name: "GetWindowRect", core: false, proto: "int __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)" },
  // DWORD GetWindowThreadProcessId(HWND hWnd, LPDWORD lpdwProcessId);   返回线程 ID，进程 ID 走输出参数
  { lib: "user32", name: "GetWindowThreadProcessId", core: false, proto: "uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)" },
  // BOOL ShowWindow(HWND hWnd, int nCmdShow);   返回值是「之前是否可见」，不是成功与否
  { lib: "user32", name: "ShowWindow", core: false, proto: "int __stdcall ShowWindow(void *hWnd, int nCmdShow)" },
  // BOOL SetForegroundWindow(HWND hWnd);
  { lib: "user32", name: "SetForegroundWindow", core: false, proto: "int __stdcall SetForegroundWindow(void *hWnd)" },
  // DPI_AWARENESS_CONTEXT GetThreadDpiAwarenessContext();   仅诊断用（Win10 1607+）：核对「输入坐标 = 物理像素」的假设
  { lib: "user32", name: "GetThreadDpiAwarenessContext", core: false, proto: "void *__stdcall GetThreadDpiAwarenessContext()" },
  // DPI_AWARENESS GetAwarenessFromDpiAwarenessContext(DPI_AWARENESS_CONTEXT value);   仅诊断用
  { lib: "user32", name: "GetAwarenessFromDpiAwarenessContext", core: false, proto: "int __stdcall GetAwarenessFromDpiAwarenessContext(void *value)" },

  // ── kernel32.dll ──
  // DWORD GetTickCount();   32 位毫秒计数，约 49.7 天回绕
  { lib: "kernel32", name: "GetTickCount", core: false, proto: "uint32_t __stdcall GetTickCount()" },
  // HANDLE OpenProcess(DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwProcessId);   失败返回 NULL
  { lib: "kernel32", name: "OpenProcess", core: false, proto: "void *__stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)" },
  // BOOL CloseHandle(HANDLE hObject);
  { lib: "kernel32", name: "CloseHandle", core: false, proto: "int __stdcall CloseHandle(void *hObject)" },
  // BOOL QueryFullProcessImageNameW(HANDLE hProcess, DWORD dwFlags, LPWSTR lpExeName, PDWORD lpdwSize);   lpdwSize 入：缓冲区字符数；出：写入的字符数
  {
    lib: "kernel32",
    name: "QueryFullProcessImageNameW",
    core: false,
    proto: "int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ void *lpExeName, _Inout_ uint32_t *lpdwSize)",
  },
  // BOOL ProcessIdToSessionId(DWORD dwProcessId, DWORD *pSessionId);   本进程所在的会话号：核对 WTSINFOEXW 读出来的偏移对不对
  { lib: "kernel32", name: "ProcessIdToSessionId", core: false, proto: "int __stdcall ProcessIdToSessionId(uint32_t dwProcessId, _Out_ uint32_t *pSessionId)" },
  // DWORD GetLastError();   失败时读错误码拼进错误信息。koffi 在 Windows 上会保存 / 恢复每次 FFI 调用的 last error，
  //                          所以「调用失败后立刻再调 GetLastError」能读到上一次调用的错误码（koffi 源码 interp.cc 的 TEB 处理）
  { lib: "kernel32", name: "GetLastError", core: false, proto: "uint32_t __stdcall GetLastError()" },

  // ── shell32.dll ──
  // BOOL ShellExecuteExW(SHELLEXECUTEINFOW *pExecInfo);
  // openApp 的首选入口：fMask 带 SEE_MASK_FLAG_NO_UI，出错时系统不弹模态对话框（ShellExecuteW 做不到这一点）。
  // 成败看返回值（非 0 = 成功）；失败原因在结构体的 hInstApp（SE_ERR_*）或 GetLastError，所以结构体按 _Inout_ 传。
  // 依赖 SHELLEXECUTEINFOW：它定义失败 / 大小对不上时本函数不绑定（进 bindFailures），openApp 退回下面的 ShellExecuteW。
  {
    lib: "shell32",
    name: "ShellExecuteExW",
    core: false,
    needs: "SHELLEXECUTEINFOW",
    proto: "int __stdcall ShellExecuteExW(_Inout_ SHELLEXECUTEINFOW *pExecInfo)",
  },
  // HINSTANCE ShellExecuteW(HWND hwnd, LPCWSTR lpOperation, LPCWSTR lpFile, LPCWSTR lpParameters, LPCWSTR lpDirectory, INT nShowCmd);
  // ⚠️ 只作 ShellExecuteExW 不可用时的回退：它没有「不弹窗」开关，目标找不到时系统可能弹出模态错误框（「Windows 找不到文件……」），
  // 而我们在 Electron 主线程里同步调用它——人不在电脑前就会一直卡住。diagnostics().shellExecute 会显示当前用的是哪一个。
  // 返回值 > 32 成功；声明成 intptr_t 方便按数字比较（它其实是个冒充 HINSTANCE 的整数）
  {
    lib: "shell32",
    name: "ShellExecuteW",
    core: false,
    proto: "intptr_t __stdcall ShellExecuteW(void *hwnd, const char16_t *lpOperation, const char16_t *lpFile, const char16_t *lpParameters, const char16_t *lpDirectory, int nShowCmd)",
  },

  // ── dwmapi.dll（整库可选）──
  // HRESULT DwmGetWindowAttribute(HWND hwnd, DWORD dwAttribute, PVOID pvAttribute, DWORD cbAttribute);   HRESULT 是 32 位有符号数，0 = S_OK
  {
    lib: "dwmapi",
    name: "DwmGetWindowAttribute",
    core: false,
    proto: "int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ int32_t *pvAttribute, uint32_t cbAttribute)",
  },

  // ── wtsapi32.dll（整库可选）──
  // BOOL WTSQuerySessionInformationW(HANDLE hServer, DWORD SessionId, WTS_INFO_CLASS WTSInfoClass, LPWSTR *ppBuffer, DWORD *pBytesReturned);
  // 缓冲区由系统分配、必须用 WTSFreeMemory 释放：ppBuffer 用 _Out_ void **（和 darwin-keychain 里的 SecKeychainFindGenericPassword 同一种写法），
  // 返回后 [0] 是指针，用 koffi.decode(ptr, "uint8_t", 20) 读出原始字节、再自己按 WTSINFOEX_OFFSETS 解析。WTS_INFO_CLASS 是 int 枚举 → int。
  {
    lib: "wtsapi32",
    name: "WTSQuerySessionInformationW",
    core: false,
    proto: "int __stdcall WTSQuerySessionInformationW(void *hServer, uint32_t SessionId, int WTSInfoClass, _Out_ void **ppBuffer, _Out_ uint32_t *pBytesReturned)",
  },
  // void WTSFreeMemory(PVOID pMemory);
  { lib: "wtsapi32", name: "WTSFreeMemory", core: false, proto: "void __stdcall WTSFreeMemory(void *pMemory)" },
]);

/** 核心函数名（缺任何一个驱动就不可用） */
export const CORE_FUNCTIONS = Object.freeze(WIN32_FUNCTIONS.filter((f) => f.core).map((f) => f.name));

// ═══════════════════════════ openApp 的目标校验 ═══════════════════════════
// open_app 的语义是「打开一个应用」（macOS 驱动也是这个语义）。但 ShellExecute 能打开任何东西：网址、网络共享、脚本、
// 安装包、文档——这些恰好是提示注入最想要的出口。所以在碰任何系统函数之前，先把它们挡在门外。

/**
 * 裸名（不含路径分隔符）里不允许的「后缀」：脚本 / 安装包 / 注册表项 / 网址快捷方式等，不区分大小写。
 * .exe 和 .lnk 是应用，不在其中；没有后缀、或后缀不在这里的（比如显示名 "App 2.0" 的 .0）一律放行。
 */
export const BLOCKED_TARGET_EXTENSIONS = Object.freeze([
  "bat", "cmd", "com", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi",
  "msp", "scr", "cpl", "hta", "reg", "dll", "jar", "inf", "pif", "url", "chm",
]);
const BLOCKED_EXTENSION_SET = new Set(BLOCKED_TARGET_EXTENSIONS);

/** 形如 xxx: 的协议头（http: / mailto: / ms-settings: / shell: / file: …） */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
/** 盘符开头的绝对路径：C:\ 或 C:/（一个字母 + 冒号 + 分隔符；C:foo 是「盘符相对路径」，不算） */
const DRIVE_ABSOLUTE = /^[a-z]:[\\/]/i;
/** UNC / 设备路径前缀：开头连着两个分隔符。\\ 和 // 之外，\/ 和 /\ 混写 Windows 也当 UNC，一并拒绝 */
const UNC_PREFIX = /^[\\/]{2}/;
const PATH_SEPARATOR = /[\\/]/;
/** 最后一个点之后若是 1~5 个字母数字，才当作「后缀」来判断 */
const NAME_SUFFIX = /\.([a-z0-9]{1,5})$/i;
/** Windows 文件名里不可能出现的字符（冒号不在其中：盘符要用，路径里多余的冒号另行检查） */
const ILLEGAL_NAME_CHARS = '"<>|*?';

/** 拒绝原因（写给 AI 看：说清楚哪里不行、该怎么改）。不回显 target 本身——它来自 AI，回显没有信息量，还可能带控制字符 */
const REJECT = Object.freeze({
  url:
    "open_app 只能打开应用，不能打开网址或协议链接（http:、mailto:、ms-settings: 之类，凡是「xxx:」开头的都不行）；" +
    "要上网请在浏览器里操作。如果是文件路径，请写成盘符开头的完整形式，如 C:\\Program Files\\某应用\\某应用.exe",
  unc:
    "open_app 不能打开网络共享路径（以 \\\\ 或 // 开头）：访问它会触发网络认证。" +
    "请改传本机应用的名称，或本机的绝对路径（盘符开头，如 C:\\Program Files\\某应用\\某应用.exe）",
  chars: "应用名称或路径里有 Windows 文件名不可能出现的字符（双引号、< > | * ? 或控制字符），请去掉后重试",
  relative:
    "路径必须是以盘符开头的绝对路径（如 C:\\Program Files\\某应用\\某应用.exe），不能是相对路径；" +
    "如果只是想打开已安装的应用，直接传应用名称就行，不要带路径",
  stream: "路径里除了盘符后面的冒号，不能再有冒号（那是 NTFS 备用数据流的写法，不是应用）",
  pathType:
    "open_app 只能打开 .exe 程序或 .lnk 快捷方式，不能打开文档、脚本、安装包等其他文件；" +
    "请改传应用名称，或 .exe / .lnk 的绝对路径",
});
const rejectBlocked = (suffix) =>
  `open_app 只能打开应用，不能打开 .${suffix} 这类文件（脚本、安装包、网址快捷方式等）；请传应用名称，或 .exe / .lnk 的绝对路径`;

/** 是否含 Windows 文件名不可能有的字符或控制字符（含 NUL、DEL） */
const hasIllegalChar = (text) => {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || ILLEGAL_NAME_CHARS.includes(ch)) return true;
  }
  return false;
};

/** 路径最后一段的扩展名（带点、小写）；没有扩展名、或点在开头（".exe" 这种隐藏文件名）返回 "" */
const extensionOf = (target) => {
  const base = target.slice(Math.max(target.lastIndexOf("\\"), target.lastIndexOf("/")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};

/**
 * 裸名的「后缀」（小写，不带点）：最后一个点之后恰好是 1~5 个字母数字才算；不是后缀返回 undefined。
 * 先去掉末尾的点和空格再判断：Windows 解析路径时会把它们丢掉，"setup.bat." 打开的就是 setup.bat，
 * 不能靠末尾多一个点绕过黑名单。（含路径分隔符的目标不走这里：它们的扩展名只能是 .exe / .lnk，末尾的点本身就会被拒。）
 */
const suffixOf = (name) => name.replace(/[. ]+$/, "").match(NAME_SUFFIX)?.[1].toLowerCase();

/**
 * openApp 的目标校验（纯函数，先于任何系统调用）。合格返回 null；不合格返回写给 AI 看的中文原因，由调用方包成 BAD_ARGS。
 * 规则（顺序即优先级：越靠前，给出的提示越有针对性——比如带 ? 的网址先提示「不能打开网址」，而不是「有非法字符」）：
 *  1. 带协议头（xxx:）的拒绝；盘符 C:\ / C:/ 放过；
 *  2. UNC（开头两个分隔符）拒绝；
 *  3. 含 " < > | * ? 或控制字符（含 NUL）的拒绝；
 *  4. 含路径分隔符的是「路径」：必须盘符开头的绝对路径，盘符之后不能再有冒号（NTFS 备用数据流），扩展名只能是 .exe / .lnk；
 *  5. 否则是「裸名」：允许无后缀、.exe、.lnk，以及任何不在黑名单里的后缀（末尾的点 / 空格不算数，见 suffixOf）。
 * 调用方负责先做非空与长度检查。
 * @param {string} target 已 trim 的目标
 * @returns {string | null}
 */
export const rejectOpenTarget = (target) => {
  if (SCHEME_PREFIX.test(target) && !DRIVE_ABSOLUTE.test(target)) return REJECT.url;
  if (UNC_PREFIX.test(target)) return REJECT.unc;
  if (hasIllegalChar(target)) return REJECT.chars;
  if (PATH_SEPARATOR.test(target)) {
    if (!DRIVE_ABSOLUTE.test(target)) return REJECT.relative;
    if (target.indexOf(":", 2) !== -1) return REJECT.stream;
    const ext = extensionOf(target);
    return ext === ".exe" || ext === ".lnk" ? null : REJECT.pathType;
  }
  const suffix = suffixOf(target);
  return suffix !== undefined && BLOCKED_EXTENSION_SET.has(suffix) ? rejectBlocked(suffix) : null;
};
