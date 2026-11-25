/**
 * Windows 桌面驱动（electron-app/desktop/drivers/win32.mjs + win32-defs.mjs）
 *
 * ⚠️ 前提：项目里没有 Windows 机器。这里能验证的只有「调用序列 / 参数 / 结构体布局」，不是 Win32 的真实行为；
 * Win32 的真机行为要等 Windows 用户上线后实测。所以测试分两层：
 *   1. 真 koffi（只在下面三组里用，从不 load 任何 Windows 库、不调用任何 Win32 函数）：
 *      a) 结构体布局（INPUT=40 / MOUSEINPUT=32 / KEYBDINPUT=24 / LASTINPUTINFO=8 / SHELLEXECUTEINFOW=112）与事件编码后的字节
 *         （SHELLEXECUTEINFOW 的编码放在子进程里跑：入参类型不符时 koffi 会 abort 整个进程，不能拿 vitest 自己冒险）；
 *      b) 全部函数原型字符串能被 koffi 解析（只解析）；
 *      c) 借 libc 里无副作用的函数（memcpy / time / timegm 等；Windows 上不跑，没有 libc 时跳过）验证驱动依赖的 koffi 行为：
 *         出参规则、JS 事件数组 → INPUT * 的编码、const char16_t * 的字符串 / null、返回值类型。
 *      布局用的是驱动自己的 defineWin32Types：显式宽度类型让 macOS 上的布局与 Win64 一致，
 *      这是没有 Windows 机器时我们能拿到的唯一 Win32 布局证据。
 *   2. 假 koffi（其余全部）：模拟 user32 / kernel32 / shell32 / dwmapi / wtsapi32，记录每次 FFI 调用及参数，
 *      并和 sleep 记在同一条时间线上，所以「SetCursorPos → DOWN → … → UP」这种顺序能整条断言。
 *
 * 钉死的语义：
 * - import 模块没有副作用（不加载 koffi）；非 win32 平台 init() = { ok:false, error:"仅 Windows 可用" }，且碰都不碰 koffi。
 * - 鼠标移动 = SetCursorPos（不用 SendInput 绝对坐标）；click / drag / 滚轮的按键事件走 SendInput，且不带 MOVE 标志。
 *   click 一次 SendInput 送 [DOWN, UP]，多击之间 sleep 40ms。
 *   drag = SetCursorPos(from) → DOWN → 9 个线性插值中间点 → SetCursorPos(to) → UP，时长内均匀停顿；任何一步失败都补发 UP。
 * - 滚轮：WHEEL.mouseData = -dy×120、HWHEEL.mouseData = dx×120，是 DWORD（负数按无符号位模式，>>> 0）。
 * - keyCombo：一次 SendInput；修饰键 ctrl→alt→shift→meta 按下、倒序抬起（不管传入顺序）；扩展键带 EXTENDEDKEY；
 *   plus 自动补 shift（已有则不重复）；wScan = MapVirtualKeyW(vk, 0)；CANONICAL_KEYS 全部有映射；失败时尽力补发「全部抬起」。
 * - typeText：每个 UTF-16 code unit 一对 UNICODE 按下 / 抬起（wVk=0，wScan=code unit），surrogate pair 不拆开；
 *   \n、\r\n（算一个）、孤立 \r → VK_RETURN，\t → VK_TAB；每批 ≤ 40 个 code unit，批间 sleep 5ms；
 *   文本绝不出现在任何日志 / 错误信息 / cause / diagnostics 里（错误里连长度都不带）。
 * - isScreenLocked：桌面名 Default（不分大小写）→ false；Screen-saver / Disconnect 等其它桌面 → true（老行为）；读不到桌面名 → null；
 *   打开的句柄一律 CloseDesktop。Winlogon 桌面（OpenInputDesktop 失败也算）上锁屏和 UAC 长得一样，改看会话锁定标志
 *   （WTSQuerySessionInformationW / WTSSessionInfoEx）：已锁定或读不到 → true（老行为）；明确「没锁」→ false，且 isSecureDesktopActive() → true
 *   （UAC / Ctrl+Alt+Del 之类的安全桌面：上层绝不能把它当锁屏去「解锁」）。读出来的结构必须过两道对账（Level=1、SessionId=本进程会话号），
 *   对不上一律当「读不到」；WTS 返回的内存用完必释放且只释放一次；全程不抛。
 * - idleSeconds = (GetTickCount − GetLastInputInfo.dwTime) 按无符号 32 位算，49.7 天回绕后依然正确。
 * - openApp 只打开「应用」（和 macOS 驱动同一语义）：
 *   ① 目标先过 rejectOpenTarget，不合格 → BAD_ARGS，且一个系统函数都不调、一个目录都不读：拒绝带协议头的网址（盘符 C:\ 放过）、UNC、
 *      含分隔符却不是「盘符绝对路径 + .exe / .lnk」的、裸名带黑名单后缀的、含 " < > | * ? 或控制字符的；
 *   ② 交给 ShellExecuteExW（fMask = NO_UI | NOASYNC，cbSize = 实测 sizeof，lpParameters / lpDirectory 为 null，没有 shell 拼接，
 *      源码里也没有任何子进程 API）；成败看返回值，失败原因先看 hInstApp（SE_ERR_*）再看 GetLastError，映射成人话；
 *   ③ 失败 → 在已运行的窗口里找（进程名完全相同 > 进程名包含 > 标题包含）并切到前台；
 *   ④ 仍未命中且目标是裸名 → 搜开始菜单快捷方式（纯 Node fs：ProgramData / APPDATA，深度 ≤ 3、累计 ≤ 3000 个条目，只看 .lnk，
 *      完全相等 > 开头 > 包含，排除 uninstall / 卸载，同级取名字最短、再按路径字典序），命中就 ShellExecuteEx 那个 .lnk；
 *   ⑤ 每一步成功就不走后面的步骤；全失败抛带各步原因的中文错误（不含目录路径 / 环境变量 / fs 原始报错）。
 *   ShellExecuteExW 绑不上（缺失 / SHELLEXECUTEINFOW 定义失败或大小对不上）→ 退回 ShellExecuteW，init 照常成功，原因进 diagnostics。
 * - init：核心函数缺失 → ok:false 且点名；非核心函数 / dwmapi 缺失只进 diagnostics().bindFailures，其余功能照常。
 *
 * 【Mac 上无法验证的假设 / 风险】（Windows 真机验证时逐条对照）
 *  1. UIPI：SendInput 注入到「以管理员身份运行」的前台窗口会被系统静默丢弃，返回值仍等于事件数——驱动检测不到。
 *  2. SetForegroundWindow 受 Windows 前台锁限制：Flowship 不是前台进程时可能只闪任务栏；openApp 回退路径会如实报错，没有做绕过。
 *  3. 【已缓解，仍需真机确认】openApp 改用 ShellExecuteExW + SEE_MASK_FLAG_NO_UI，并先校验目标（只放行应用名 / 盘符绝对路径的 .exe·.lnk）。
 *     需要确认：(a) NO_UI 在「找不到文件」「没有关联程序」等失败上确实不弹框、立即返回；
 *     (b) NO_UI 管不到 UAC：目标需要管理员权限时可能仍弹 UAC 并一直等——人不在电脑前会卡住主线程；
 *     (c) 调用线程的 COM 状态：文档建议先 CoInitializeEx(STA)，Electron 主线程通常已初始化，但 Mac 上没法确认；
 *     (d) ShellExecuteExW 不可用时退回 ShellExecuteW（diagnostics().shellExecute 会显示），那条路径仍可能弹模态框。
 *  4. 标点键的 VK_OEM_* 对应美式键盘布局；别的布局上同一个码是别的字符。Ctrl+Alt+Del 无法注入（SAS）；Win+L 等系统保留键能否注入未验证。
 *  5. 读 GetLastError 依赖 koffi 在 Windows 上保存 / 恢复每次调用的 last error（源码 interp.cc 的 TEB 处理，文档没有承诺）；
 *     读不到只是错误信息里少一个错误码。
 *  6. EnumWindows 的临时回调写法依据 koffi 文档「Transient callbacks」+ koffi.proto；同一机制在 macOS 用 qsort 验证过，
 *     EnumWindows 本身从没跑过；回调的 hwnd 到 JS 是 BigInt、__stdcall 在 x64 / arm64 被忽略也只是文档说法。
 *  7. 「输入坐标 = 物理像素」要求 Electron 主线程是 per-monitor DPI aware；diagnostics() 的 dpiAwareness / screen / virtualScreen 用来真机核对。
 *  8. 输入桌面用 DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP（0x101）打开（C# 解锁组件读桌面名用的就是 READOBJECTS）；
 *     只申请 SWITCHDESKTOP 时读不读得出名字没人验证过，多申请 READOBJECTS 没有代价。该句柄能否 GetUserObjectInformationW(UOI_NAME) 读出名字
 *     仍要真机确认（读不到时返回 null，整个功能会因为桌面状态永远未知而不可用）；
 *     「OpenInputDesktop 返回 NULL ⇒ 锁屏 / UAC 的 Winlogon 桌面」是推断。
 *     锁屏与 UAC 的区分靠 WTSSessionInfoEx：WTSINFOEXW 的偏移（Level@0 / SessionId@8 / SessionFlags@16）、flags 取值（0=锁定、1=没锁）、
 *     UAC 弹出期间标志确实是「没锁」、koffi.decode(void*, "uint8_t", n) 读 WTS 返回的内存，全是按 SDK 头文件 / 文档推的，没在真机上跑过
 *     （见 docs/windows-unlock-live-test.md 的 UAC 一节）；对账两道（Level / SessionId）只能防「偏移猜错」，防不了「标志语义猜错」。
 *  9. 32 位结构体大小（INPUT=28 / MOUSEINPUT=24 / KEYBDINPUT=16 / SHELLEXECUTEINFOW=60）按字段宽度手算，并用下面一个独立的 C 对齐算术
 *     交叉核对过；但没在真 32 位 Windows 上实测（Mac 上的真 koffi 只有 64 位证据）。
 * 10. KEYEVENTF_UNICODE 在开着 IME 的应用里的表现、每批 40 字符 + 5ms 的节奏会不会丢字，只有真机知道；Win 键（LWIN）带 EXTENDEDKEY 是惯例。
 * 11. GetWindowRect 含 Win10+ 不可见边框（约 7px）；最小化窗口的矩形约在 (-32000, -32000)；UWP 应用的进程名可能是 ApplicationFrameHost。
 * 12. wakeDisplay 的 ±1 相对移动受指针加速度影响，可能残留 1px 偏差；锁屏（输入桌面 ≠ Default）时 SendInput 本身就会失败。
 * 13. koffi 的 .node 与 @koromix/koffi-win32-* 平台包必须随安装包分发并 asarUnpack（跨层问题，驱动只能在 init 里报「加载 koffi 失败」）。
 * 14. 系统 DLL 按文件名加载（默认搜索顺序），没有指定 System32 全路径。
 * 15. 开始菜单搜索：只在 ShellExecuteEx 与窗口匹配都失败后才跑。%ProgramData% / %APPDATA% 的目录结构、.lnk 文件名能否对上用户说的应用名
 *     （中文名 vs 英文快捷方式名）、NTFS 上 readdir 的返回顺序 / 大小写，都只能真机看；APPDATA 被重定向到 UNC（企业域环境）时按设计跳过，
 *     那种机器上搜不到用户目录里的快捷方式。
 * 16. NO_UI 下的失败原因：hInstApp（SE_ERR_*）与 GetLastError（740 / 1155 / 1223 等）的映射依据文档，没在真机逐个触发过；
 *     「ShellExecuteExW 失败后紧跟 GetLastError 能读到它的错误码」同第 5 条，是源码推断。
 * 17. lpFile 是「整个字符串当文件名」：驱动不加引号、lpParameters 恒为 null，设计上不会把 "notepad.exe -x" 拆成程序 + 参数；
 *     但 ShellExecuteEx 对「未加引号、含空格、像命令行」的 lpFile 有没有自己的拆分启发式，只能真机确认
 *     （裸名里的空格无法拒绝：「Google Chrome」「App 2.0」这类显示名都有空格）。
 *
 * 已在 Mac 上用真 koffi 3.3.8 验证过的前提（拿 libc 的 timegm / localtime_r / time / memset 做的同构实验）：
 *  - _Inout_ 结构体指针传 JS 对象，结果原地写回同一个对象（idleSeconds 读 info.dwTime 依赖它）；_Out_ 结构体传 {} 会被填满（GetWindowRect 依赖）；
 *  - 对象 / 数组参数不写 _Out_ / _Inout_ 就是副本：被调函数写了 JS 也看不到，而且静默不报错；Buffer 当 void * 传则带不带都可写。
 *  假 koffi 照这套规则模拟（见 createFake），所以「出参漏标」类 bug 测得出来——例如 GetLastInputInfo 少写 _Inout_，
 *  idleSeconds 就会永远读到 dwTime=0，返回「开机以来的秒数」。
 *  - SHELLEXECUTEINFOW（同一批实验）：64 位大小 112、15 个字段偏移与手算一致；_Inout_ 写回后 hInstApp 读回 BigInt（0 读成 null），
 *    不标 _Inout_ 就读不回；字符串 / null 指针成员经写回原样不变。
 *  - ⚠️ 整数成员传 null / 字符串时，koffi 不抛 JS 异常，而是直接 SIGABRT 整个进程。所以 createFake 对 ShellExecuteExW 的入参做类型守卫，
 *    真 koffi 的编码检查放在子进程里跑，且有一条专门钉住这个现象（koffi 升级后若行为变了，这条会变红，提醒重新核对守卫的前提）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createWin32Driver } from "../electron-app/desktop/drivers/win32.mjs";
import {
  BLOCKED_TARGET_EXTENSIONS,
  CORE_FUNCTIONS,
  CORE_STRUCT_NAMES,
  DESKTOP_READOBJECTS,
  DESKTOP_SWITCHDESKTOP,
  DWMWA_CLOAKED,
  INPUT_DESKTOP_ACCESS,
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF,
  KEY_TABLE,
  MAPVK_VK_TO_VSC,
  MODIFIER_EXTENDED,
  MODIFIER_VK,
  MOUSEEVENTF,
  PROCESS_QUERY_LIMITED_INFORMATION,
  SEE_MASK,
  SM,
  SW_RESTORE,
  SW_SHOWNORMAL,
  UOI_NAME,
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
} from "../electron-app/desktop/drivers/win32-defs.mjs";
import { CANONICAL_KEYS } from "../electron-app/desktop/keys.mjs";

// 只给「不注入 fs」那一条用例用：把 node:fs/promises 的 readdir 包一层 spy（调用一律失败），其余成员保持原样。
// 其余用例都显式注入了 fs，不会走到这里。vi.mock 会被提升到文件最前，所以 win32.mjs 拿到的就是这个 spy
const realFsSpy = vi.hoisted(() => ({ readdirCalls: [] as unknown[][] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (...args: unknown[]) => {
      realFsSpy.readdirCalls.push(args);
      return Promise.reject(new Error("ENOENT: 夹具里的假错误"));
    },
  };
});

// ═══════════════════════════ 夹具：假 koffi ═══════════════════════════

type KoffiArg = NonNullable<NonNullable<Parameters<typeof createWin32Driver>[0]>["koffi"]>;
type Driver = ReturnType<typeof createWin32Driver>;
type Mods = Array<"meta" | "ctrl" | "alt" | "shift">;

type KeyInfo = { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number };
type MouseInfo = { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: number };
type InputEvent = { type: number; u: { ki?: KeyInfo; mi?: MouseInfo } };
/** 一次 FFI 调用（或一次 sleep）。SendInput 的 args[1] 是调用时刻的事件数组快照 */
type Call = { fn: string; args: unknown[] };
/** 假 Win32 函数实现：参数类型由各实现自己标注 */
type Impl = (...args: never[]) => unknown;

type FakeWindow = {
  hwnd: bigint;
  pid: number;
  title: string;
  visible?: boolean;
  cloaked?: boolean;
  iconic?: boolean;
  /** [left, top, right, bottom]，缺省 [0, 0, 100, 100] */
  rect?: [number, number, number, number];
};

type FakeOptions = {
  platform?: string;
  windows?: FakeWindow[];
  /** pid → exe 完整路径；null = OpenProcess 失败（权限不够） */
  processes?: Record<number, string | null>;
  /** 前台窗口句柄；null = 没有前台窗口 */
  foreground?: bigint | null;
  /** OpenInputDesktop 打开的桌面名；null = 打不开（返回 NULL） */
  desktopName?: string | null;
  /**
   * 会话锁定标志（WTSSessionInfoEx 的 SessionFlags）：0 = 已锁定，1 = 未锁定，0xFFFFFFFF = 未知，其它 = 奇怪的值；
   * null = WTSQuerySessionInformationW 失败（返回 0）；缺省 1（未锁定）
   */
  sessionFlags?: number | null;
  /** 本进程的会话号（ProcessIdToSessionId 写出的值）；null = ProcessIdToSessionId 失败；缺省 2 */
  ownSession?: number | null;
  /** WTSINFOEX 结构里写的 SessionId；缺省等于本进程的会话号（设成别的值 = 偏移猜错 / 读到别的会话） */
  infoSession?: number;
  /** WTSINFOEX 的 Level；缺省 1 */
  infoLevel?: number;
  /** pBytesReturned 回报的字节数；缺省 256（够大）。设小 = 结构过短 */
  infoBytes?: number;
  /** koffi 没有 decode（旧版本）：驱动读不了 WTS 返回的内存 */
  noDecode?: boolean;
  tick?: number;
  lastInput?: number;
  /** ShellExecuteW（ShellExecuteExW 不可用时的降级路径）的返回值，缺省 42（> 32 即成功） */
  shellResult?: number;
  /** ShellExecuteExW 的结果：缺省成功；函数形式按 lpFile 区分（同一次 openApp 里先后打开不同目标） */
  shellEx?: ShellExOutcome | ((file: string) => ShellExOutcome);
  /** 环境变量（开始菜单搜索读 ProgramData / APPDATA），缺省 DEFAULT_ENV */
  env?: Record<string, string | undefined>;
  /** 开始菜单：两个 Programs 目录下的目录树（路径由 env 推出）；缺省两个目录都不存在 */
  startMenu?: { programData?: Tree; appData?: Tree };
  /** readdir 时抛 EACCES 的目录（完整路径） */
  unreadable?: string[];
  /** readdir 倒序返回（验证驱动不依赖文件系统的返回顺序） */
  reverseEntries?: boolean;
  /** koffi.struct 对这些类型名抛错（模拟结构体定义失败） */
  structFails?: string[];
  /** 覆盖 koffi.sizeof 对结构体的回答 */
  sizes?: Record<string, number>;
  /** koffi.sizeof("void *") 的回答，缺省 8（64 位） */
  pointerSize?: number;
  /** lib.func 时「找不到」的函数名 */
  missing?: string[];
  /** koffi.load 失败的库文件名 */
  failLoad?: string[];
  /** 覆盖 / 追加的 Win32 实现（按函数名） */
  impls?: Record<string, Impl>;
};

const H = (n: number) => BigInt(n);

/** Z 序从上到下。覆盖：同进程多窗口 / 最小化 / 空标题 / 纯空白标题 / 不可见 / cloaked / OpenProcess 失败 */
const DEFAULT_WINDOWS: FakeWindow[] = [
  { hwnd: H(0x10), pid: 100, title: "无标题 - 记事本", rect: [100, 100, 900, 700] },
  { hwnd: H(0x20), pid: 100, title: "查找", rect: [200, 200, 500, 400] },
  { hwnd: H(0x30), pid: 200, title: "微信", rect: [-32000, -32000, -31840, -31972], iconic: true },
  { hwnd: H(0x40), pid: 300, title: "" },
  { hwnd: H(0x50), pid: 300, title: "不可见的窗口", visible: false },
  { hwnd: H(0x60), pid: 400, title: "另一个虚拟桌面上的窗口", cloaked: true },
  { hwnd: H(0x70), pid: 500, title: "系统保护进程的窗口", rect: [10, 20, 110, 220] },
  { hwnd: H(0x80), pid: 600, title: "   " },
];
const DEFAULT_PROCESSES: Record<number, string | null> = {
  100: "C:\\Windows\\System32\\notepad.exe",
  200: "C:\\Program Files\\Tencent\\WeChat\\WeChat.EXE",
  300: "C:\\Windows\\explorer.exe",
  400: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
  500: null,
  600: "C:\\apps\\ghost.exe",
};
const SIZES_64 = { INPUT: 40, MOUSEINPUT: 32, KEYBDINPUT: 24, LASTINPUTINFO: 8, SHELLEXECUTEINFOW: 112 };
/** init 之后 diagnostics().structSizes 里应有的内容（SIZES_64 里的 5 项都是 init 实测并记录的） */
const SIZES_32 = { INPUT: 28, MOUSEINPUT: 24, KEYBDINPUT: 16, LASTINPUTINFO: 8, SHELLEXECUTEINFOW: 60 };

// ── ShellExecuteExW / 开始菜单的夹具件 ──

/** ShellExecuteExW 的一次结果（缺省 = 成功） */
type ShellExOutcome = {
  /** false = 失败（返回 0） */
  ok?: boolean;
  /** 覆盖返回值（成功缺省 1，失败缺省 0） */
  ret?: number;
  /** 写进 hInstApp 的值；成功缺省 42（> 32），失败缺省 0（读回 null） */
  hInstApp?: number;
  /** 失败后 GetLastError 读到的值；缺省 0 */
  lastError?: number;
};
/** 开始菜单目录树：子树 = 目录，null = 普通文件，"symlink" = 符号链接（Dirent 对它既不是文件也不是目录） */
type Tree = { [name: string]: Tree | null | "symlink" };
type FakeDirent = { name: string; isDirectory: () => boolean; isFile: () => boolean };

const PROGRAM_DATA = "C:\\ProgramData";
const APP_DATA = "C:\\Users\\alice\\AppData\\Roaming";
const DEFAULT_ENV = { ProgramData: PROGRAM_DATA, APPDATA: APP_DATA };
/** Programs 目录接在 %ProgramData% / %APPDATA% 之后的相对路径（用字面量写一遍，不引用驱动的常量） */
const MENU_PARTS = ["Microsoft", "Windows", "Start Menu", "Programs"];
const menuDir = (base: string) => path.win32.join(base, ...MENU_PARTS);
const DEFAULT_LAST_ERROR = 5;

const isSubtree = (sub: Tree[string]): sub is Tree => typeof sub === "object" && sub !== null;
/** 目录树 → 「目录完整路径 → 条目」的平表（假 fs 按完整路径查） */
const addTree = (dirs: Map<string, FakeDirent[]>, dir: string, tree: Tree) => {
  dirs.set(
    dir,
    Object.entries(tree).map(([name, sub]) => ({ name, isDirectory: () => isSubtree(sub), isFile: () => sub === null })),
  );
  for (const [name, sub] of Object.entries(tree)) if (isSubtree(sub)) addTree(dirs, path.win32.join(dir, name), sub);
};

/**
 * SHELLEXECUTEINFOW 15 个成员的 koffi 类型种类。
 * ⚠️ 真 koffi：整数成员（uint32_t / int）收到 null 或字符串时不抛 JS 异常，而是直接 SIGABRT 整个进程（见头注释）；
 * 所以假 ShellExecuteExW 先做这个检查，驱动构造入参时犯这类错就变成一条可读的测试失败，而不是 vitest 进程被杀。
 * 指针成员这里要求 null / BigInt（真 koffi 也接受 Number 0，但驱动约定传 null）。
 */
const SHELL_INFO_KINDS: Record<string, "int" | "ptr" | "str"> = {
  cbSize: "int",
  fMask: "int",
  nShow: "int",
  dwHotKey: "int",
  hwnd: "ptr",
  hInstApp: "ptr",
  lpIDList: "ptr",
  hkeyClass: "ptr",
  hIconOrMonitor: "ptr",
  hProcess: "ptr",
  lpVerb: "str",
  lpFile: "str",
  lpParameters: "str",
  lpDirectory: "str",
  lpClass: "str",
};
const SHELL_INFO_CHECKS = {
  int: (v: unknown) => Number.isInteger(v),
  ptr: (v: unknown) => v === null || typeof v === "bigint",
  str: (v: unknown) => v === null || typeof v === "string",
};
const assertShellInfoTypes = (info: Record<string, unknown>) => {
  for (const [member, value] of Object.entries(info)) {
    const kind = SHELL_INFO_KINDS[member];
    if (!kind) throw new Error(`SHELLEXECUTEINFOW 没有成员 ${member}（真 koffi 会静默忽略它）`);
    if (!SHELL_INFO_CHECKS[kind](value)) {
      throw new Error(`SHELLEXECUTEINFOW.${member} 应为 ${kind}，收到 ${value === null ? "null" : typeof value}（真 koffi 会因此 abort 整个进程）`);
    }
  }
};

/** 从 C 原型里取函数名：第一个「标识符 + 左括号」就是它（__stdcall 后面才是函数名） */
const protoName = (prototype: string) => /(\w+)\s*\(/.exec(prototype)?.[1] ?? "";

/** 原型里每个参数是否带 _Out_ / _Inout_（原型表里没有嵌套括号，按逗号切就够） */
const outFlags = (prototype: string): boolean[] => {
  const inner = prototype.slice(prototype.indexOf("(") + 1, prototype.lastIndexOf(")")).trim();
  return inner === "" ? [] : inner.split(",").map((param) => /^\s*_(Out|Inout)_\s/.test(param));
};

/**
 * 缓冲区出参的容量声明不得超过 Buffer 的实际字节数。真 Win32 会按声明的容量往里写，
 * 声明大了就是越界写 Node 的堆内存（主进程崩溃 / 内存破坏）；Node 的 Buffer.copy 会悄悄截断，所以假实现必须主动检查。
 */
const assertFits = (buf: Buffer, bytes: number, what: string) => {
  if (bytes > buf.length) throw new Error(`缓冲区溢出：${what} 声明了 ${bytes} 字节，但 Buffer 只有 ${buf.length} 字节`);
};

/** 对象 / 数组参数（会被 koffi 当成「指向 JS 值的指针」）；Buffer 是直接指针，不在此列 */
const isPointerToJsValue = (value: unknown) => typeof value === "object" && value !== null && !Buffer.isBuffer(value);

const createFake = (options: FakeOptions = {}) => {
  const calls: Call[] = [];
  const loads: string[] = [];
  const bound: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const stats = { enumCallbackFfiCalls: -1 };
  const typeNames = new Set<string>();
  /** 模拟线程的 last error：任何别的 FFI 调用都会把它冲回默认值（真 Win32 里它只属于「上一次调用」） */
  let lastError = DEFAULT_LAST_ERROR;

  const windows = options.windows ?? DEFAULT_WINDOWS;
  const processes = options.processes ?? DEFAULT_PROCESSES;
  const foreground = options.foreground === undefined ? H(0x10) : options.foreground;
  // 桌面名 / 会话标志都在「调用的那一刻」才读 options：测试可以在 ready() 之后改 options，模拟 UAC 弹出又消失、锁屏被解开
  const currentDesktop = () => (options.desktopName === undefined ? "Default" : options.desktopName);
  // ── 会话锁定标志（WTSQuerySessionInformationW + WTSSessionInfoEx）：假内存按「谁分配、谁释放」严格记账 ──
  const ownSession = options.ownSession === undefined ? 2 : options.ownSession;
  const wtsBuffers = new Map<bigint, Buffer>();
  const wtsFreed: bigint[] = [];
  let wtsNext = 0xa000;
  const metrics: Record<number, number> = { 0: 1920, 1: 1080, 76: -1920, 77: 0, 78: 3840, 79: 1080 };
  const windowOf = (hwnd: unknown) => windows.find((w) => w.hwnd === hwnd);
  const HANDLE_BASE = 0x9000;

  const impls: Record<string, Impl> = {
    SendInput: (count: number) => count,
    SetCursorPos: () => 1,
    GetSystemMetrics: (index: number) => metrics[index] ?? 0,
    GetLastInputInfo: (info: { dwTime: number }) => {
      info.dwTime = options.lastInput ?? 0;
      return 1;
    },
    GetTickCount: () => options.tick ?? 0,
    OpenInputDesktop: () => (currentDesktop() === null ? null : H(0x7000)),
    GetUserObjectInformationW: (_hDesk: bigint, _index: number, buf: Buffer, length: number, needed: number[]) => {
      assertFits(buf, length, "GetUserObjectInformationW 的 nLength（字节）");
      const name = currentDesktop() ?? "";
      Buffer.from(`${name}\0`, "utf16le").copy(buf);
      needed[0] = (name.length + 1) * 2;
      return 1;
    },
    CloseDesktop: () => 1,
    ProcessIdToSessionId: (_pid: number, out: number[]) => {
      if (ownSession === null) return 0;
      out[0] = ownSession;
      return 1;
    },
    // WTS_CURRENT_SERVER_HANDLE = NULL，WTS_CURRENT_SESSION = 0xFFFFFFFF，WTSSessionInfoEx = 25；
    // 结构布局：Level@0 / SessionId@8 / SessionState@12 / SessionFlags@16（Windows SDK wtsapi32.h 的 WTSINFOEXW）
    WTSQuerySessionInformationW: (server: unknown, sessionId: number, infoClass: number, out: unknown[], bytes: number[]) => {
      if (server !== null) throw new Error(`hServer 应为 WTS_CURRENT_SERVER_HANDLE（null），收到 ${String(server)}`);
      if (sessionId !== 0xffffffff) throw new Error(`SessionId 应为 WTS_CURRENT_SESSION（0xFFFFFFFF），收到 ${sessionId}`);
      if (infoClass !== 25) throw new Error(`WTSInfoClass 应为 WTSSessionInfoEx（25），收到 ${infoClass}`);
      if (options.sessionFlags === null) return 0;
      const info = Buffer.alloc(256);
      info.writeUInt32LE(options.infoLevel ?? 1, 0);
      info.writeUInt32LE(options.infoSession ?? (ownSession ?? 0), 8);
      info.writeUInt32LE(0, 12); // SessionState（驱动不读它）
      info.writeUInt32LE(options.sessionFlags ?? 1, 16);
      const pointer = BigInt(wtsNext++);
      wtsBuffers.set(pointer, info);
      out[0] = pointer;
      bytes[0] = options.infoBytes ?? info.length;
      return 1;
    },
    WTSFreeMemory: (pointer: bigint) => {
      if (!wtsBuffers.has(pointer)) throw new Error(`WTSFreeMemory 收到不是 WTSQuerySessionInformationW 给出的指针：${String(pointer)}`);
      if (wtsFreed.includes(pointer)) throw new Error(`WTSFreeMemory 重复释放了 ${String(pointer)}`);
      wtsFreed.push(pointer);
    },
    MapVirtualKeyW: (vk: number) => vk + 0x100,
    LockWorkStation: () => 1,
    GetForegroundWindow: () => foreground,
    EnumWindows: (callback: (hwnd: bigint, lParam: number) => number) => {
      const before = calls.length;
      for (const w of windows) if (callback(w.hwnd, 0) === 0) break;
      stats.enumCallbackFfiCalls = calls.length - before;
      return 1;
    },
    IsWindowVisible: (hwnd: bigint) => (windowOf(hwnd)?.visible === false ? 0 : 1),
    IsIconic: (hwnd: bigint) => (windowOf(hwnd)?.iconic ? 1 : 0),
    GetWindowTextW: (hwnd: bigint, buf: Buffer, max: number) => {
      assertFits(buf, max * 2, "GetWindowTextW 的 nMaxCount（字符，每个 2 字节）");
      const title = (windowOf(hwnd)?.title ?? "").slice(0, max - 1);
      Buffer.from(`${title}\0`, "utf16le").copy(buf);
      return title.length;
    },
    GetWindowRect: (hwnd: bigint, rect: Record<string, number>) => {
      const w = windowOf(hwnd);
      if (!w) return 0;
      const [left, top, right, bottom] = w.rect ?? [0, 0, 100, 100];
      Object.assign(rect, { left, top, right, bottom });
      return 1;
    },
    GetWindowThreadProcessId: (hwnd: bigint, out: number[]) => {
      out[0] = windowOf(hwnd)?.pid ?? 0;
      return out[0] === 0 ? 0 : 4242;
    },
    DwmGetWindowAttribute: (hwnd: bigint, _attribute: number, out: number[]) => {
      out[0] = windowOf(hwnd)?.cloaked ? 1 : 0;
      return 0;
    },
    ShowWindow: () => 1,
    SetForegroundWindow: () => 1,
    GetThreadDpiAwarenessContext: () => H(-4),
    GetAwarenessFromDpiAwarenessContext: () => 2,
    OpenProcess: (_access: number, _inherit: number, pid: number) => (typeof processes[pid] === "string" ? H(HANDLE_BASE + pid) : null),
    CloseHandle: () => 1,
    QueryFullProcessImageNameW: (handle: bigint, _flags: number, buf: Buffer, size: number[]) => {
      assertFits(buf, size[0] * 2, "QueryFullProcessImageNameW 的 lpdwSize（字符，每个 2 字节）");
      const exe = processes[Number(handle) - HANDLE_BASE] ?? "";
      Buffer.from(`${exe}\0`, "utf16le").copy(buf);
      size[0] = exe.length;
      return 1;
    },
    GetLastError: () => lastError,
    ShellExecuteW: () => options.shellResult ?? 42,
    // _Inout_ SHELLEXECUTEINFOW *：成功时写 hInstApp > 32；失败时写 SE_ERR_*（或 0 = 没给原因，读回 null）并设置 last error
    ShellExecuteExW: (info: Record<string, unknown>) => {
      assertShellInfoTypes(info);
      const outcome = typeof options.shellEx === "function" ? options.shellEx(String(info.lpFile)) : (options.shellEx ?? {});
      const failed = outcome.ok === false;
      const written = outcome.hInstApp ?? (failed ? 0 : 42);
      info.hInstApp = written === 0 ? null : BigInt(written);
      if (failed) lastError = outcome.lastError ?? 0;
      return outcome.ret ?? (failed ? 0 : 1);
    },
    ...options.impls,
  };

  const defineType = (name: string) => {
    // 真 koffi 对同名类型会抛 Duplicate type name，假的也要一样，才能测出「重复定义」类的 bug
    if (typeNames.has(name)) throw new Error(`Duplicate type name '${name}'`);
    typeNames.add(name);
  };

  const koffi: KoffiArg = {
    version: "3.3.8-fake",
    struct: (name: string, members: object) => {
      if (options.structFails?.includes(name)) throw new Error(`boom: ${name}`);
      defineType(name);
      return { kind: "struct", name, members };
    },
    union: (members: object) => ({ kind: "union", members }),
    // 只模拟驱动用到的那一种：把 WTS 返回的内存按原始字节（uint8_t 数组）读出来。越界读 / 读已释放的内存都当场报错
    decode: (pointer: unknown, type: unknown, length: number) => {
      calls.push({ fn: "koffi.decode", args: [type, length] });
      if (type !== "uint8_t") throw new Error(`decode 只应按 uint8_t 读原始字节，收到 ${String(type)}`);
      const buf = wtsBuffers.get(pointer as bigint);
      if (!buf) throw new Error("decode 收到不认识的指针（不是 WTS 分配的）");
      if (wtsFreed.includes(pointer as bigint)) throw new Error("decode 读了已经释放的内存（use-after-free）");
      if (length > buf.length) throw new Error(`decode 越界：要读 ${length} 字节，内存只有 ${buf.length} 字节`);
      return Array.from(buf.subarray(0, length));
    },
    proto: (prototype: string) => {
      defineType(protoName(prototype));
      return { kind: "proto", name: protoName(prototype), prototype };
    },
    sizeof: (type: unknown) => {
      if (type === "void *") return options.pointerSize ?? 8;
      const name = (type as { name?: string }).name ?? "";
      return options.sizes?.[name] ?? SIZES_64[name as keyof typeof SIZES_64] ?? 0;
    },
    load: (file: string) => {
      loads.push(file);
      if (options.failLoad?.includes(file)) throw new Error(`Failed to load shared library: ${file} 不存在`);
      return {
        func: (prototype: string) => {
          const name = protoName(prototype);
          if (options.missing?.includes(name)) throw new Error(`Cannot find function '${name}' in shared library '${file}'`);
          const impl = impls[name];
          if (!impl) throw new Error(`测试夹具没有实现 ${name}`);
          bound.push(name);
          const writable = outFlags(prototype);
          return (...args: unknown[]) => {
            // SendInput 的事件数组、ShellExecuteExW 的信息结构记调用时刻的快照
            // （驱动传进来的是它自己构造的对象；ShellExecuteExW 还会被写回 hInstApp，快照要反映「调用时」的样子）
            const recorded =
              name === "SendInput"
                ? [args[0], JSON.parse(JSON.stringify(args[1])), args[2]]
                : name === "ShellExecuteExW"
                  ? [JSON.parse(JSON.stringify(args[0], (_key, v) => (typeof v === "bigint" ? `${v}n` : v)))]
                  : args;
            calls.push({ fn: name, args: recorded });
            if (name !== "GetLastError") lastError = DEFAULT_LAST_ERROR;
            // 真 koffi 的出参规则（2026-11 在 koffi 3.3.8 上实测）：对象 / 数组参数只有原型里标了 _Out_ / _Inout_，
            // 被调函数写进去的结果才会回到 JS；没标就是副本，写了也看不见（连 {} 都是静默不填，不报错）。
            // 夹具照此模拟，所以「出参漏标」这类 bug 在这里会表现成「读到的值不对」，而不是被假实现悄悄兜住。
            const passed = args.map((arg, i) => (isPointerToJsValue(arg) && !writable[i] ? JSON.parse(JSON.stringify(arg)) : arg));
            return (impl as (...a: unknown[]) => unknown)(...passed);
          };
        },
      };
    },
  };

  if (options.noDecode) delete (koffi as { decode?: unknown }).decode;

  const sleep = (ms: number) => {
    sleeps.push(ms);
    calls.push({ fn: "sleep", args: [ms] });
    return Promise.resolve();
  };
  // 内存里的开始菜单：目录路径由 env 推出（env 故意可以是 UNC / 相对路径 / 缺失，看驱动会不会去碰）
  const env = options.env ?? DEFAULT_ENV;
  const dirs = new Map<string, FakeDirent[]>();
  const mount = (base: string | undefined, tree: Tree | undefined) => {
    if (base !== undefined && tree !== undefined) addTree(dirs, menuDir(base), tree);
  };
  mount(env.ProgramData, options.startMenu?.programData);
  mount(env.APPDATA, options.startMenu?.appData);
  const fs = {
    readdir: async (dir: string) => {
      calls.push({ fn: "fs.readdir", args: [dir] });
      if (options.unreadable?.includes(dir)) throw new Error(`EACCES: permission denied, scandir '${dir}'`);
      const entries = dirs.get(dir);
      if (!entries) throw new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
      return options.reverseEntries ? [...entries].reverse() : [...entries];
    },
  };

  const driver = createWin32Driver({
    koffi,
    platform: options.platform ?? "win32",
    log: (message) => {
      logs.push(message);
    },
    sleep,
    env,
    fs,
  });
  return { driver, koffi, calls, loads, bound, logs, sleeps, stats, wts: { allocated: wtsBuffers, freed: wtsFreed } };
};

/** 创建并 init；init 本身的 FFI 调用 / 日志不算「业务调用」，清掉 */
const ready = async (options: FakeOptions = {}) => {
  const fake = createFake(options);
  const result = await fake.driver.init();
  if (!result.ok) throw new Error(`夹具 init 失败：${result.error}`);
  fake.calls.length = 0;
  fake.logs.length = 0;
  return fake;
};

// ═══════════════════════════ 小工具 ═══════════════════════════

const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
/** 去掉块注释与整行 // 注释（模块头注释会提到 spawn / shell，不该算引用） */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

const names = (calls: Call[]) => calls.map((c) => c.fn);
const ffi = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn);
const batches = (calls: Call[]): InputEvent[][] => ffi(calls, "SendInput").map((c) => c.args[1] as InputEvent[]);
const events = (calls: Call[]): InputEvent[] => batches(calls).flat();
const ki = (e: InputEvent) => e.u.ki as KeyInfo;
const mi = (e: InputEvent) => e.u.mi as MouseInfo;
const cursorMoves = (calls: Call[]) => ffi(calls, "SetCursorPos").map((c) => c.args);

/**
 * isSecureDesktopActive 在驱动契约里是可选方法（macOS 驱动没有这回事），win32 驱动必须实现。
 * 取不到就是装配错了——直接抛，别用可选链把「方法没了」悄悄吞成 undefined（单独一行调用的那几处尤其会静默通过）。
 */
const secureActive = (driver: { isSecureDesktopActive?: () => boolean }): boolean => {
  if (typeof driver.isSecureDesktopActive !== "function") throw new Error("win32 驱动没有实现 isSecureDesktopActive");
  return driver.isSecureDesktopActive();
};

/** ShellExecuteExW 的每次调用的 lpFile（按顺序） */
const exFiles = (calls: Call[]) => ffi(calls, "ShellExecuteExW").map((c) => (c.args[0] as { lpFile: string }).lpFile);
/** 驱动读过的目录（按顺序） */
const dirReads = (calls: Call[]) => ffi(calls, "fs.readdir").map((c) => c.args[0] as string);

/** openApp 一步一步做了什么（只留关心的几类调用；连续重复的合并成一步） */
const stepOf = (c: Call): string | null => {
  if (c.fn === "ShellExecuteExW") return `ex:${(c.args[0] as { lpFile: string }).lpFile}`;
  if (c.fn === "ShellExecuteW") return `legacy:${c.args[2] as string}`;
  if (c.fn === "EnumWindows") return "enum";
  if (c.fn === "SetForegroundWindow") return "focus";
  if (c.fn === "fs.readdir") return "menu";
  return null;
};
/** 轨迹词汇：ex:<目标> = ShellExecuteExW，legacy:<目标> = ShellExecuteW，enum = 枚举窗口，focus = 切前台，menu = 读开始菜单目录 */
const steps = (calls: Call[]): string[] => {
  const out: string[] = [];
  for (const c of calls) {
    const step = stepOf(c);
    if (step !== null && out[out.length - 1] !== step) out.push(step);
  }
  return out;
};

/** 键盘事件 → 可读轨迹：↓11 = VK 0x11 按下，↑5b* = Win 键（扩展键）抬起，↓U+4E2D = Unicode 字符按下 */
const traceKeys = (evs: InputEvent[]) =>
  evs.map((e) => {
    const k = ki(e);
    const arrow = k.dwFlags & 0x2 ? "↑" : "↓";
    if (k.dwFlags & 0x4) return `${arrow}U+${k.wScan.toString(16).toUpperCase()}`;
    return `${arrow}${k.wVk.toString(16)}${k.dwFlags & 0x1 ? "*" : ""}`;
  });

const catchError = async (fn: () => unknown): Promise<Error> => {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("期望抛错，但没有抛");
};

// ═══════════════════════════ 常量 / 键码表（字面量对照） ═══════════════════════════

describe("常量与 Windows SDK 一致（用字面量对照，不引用被测常量）", () => {
  it("MOUSEEVENTF / KEYEVENTF / INPUT 类型 / WHEEL_DELTA", () => {
    expect({ ...MOUSEEVENTF }).toEqual({
      MOVE: 0x1,
      LEFTDOWN: 0x2,
      LEFTUP: 0x4,
      RIGHTDOWN: 0x8,
      RIGHTUP: 0x10,
      MIDDLEDOWN: 0x20,
      MIDDLEUP: 0x40,
      WHEEL: 0x800,
      HWHEEL: 0x1000,
    });
    expect({ ...KEYEVENTF }).toEqual({ EXTENDEDKEY: 0x1, KEYUP: 0x2, UNICODE: 0x4, SCANCODE: 0x8 });
    expect([INPUT_MOUSE, INPUT_KEYBOARD, WHEEL_DELTA]).toEqual([0, 1, 120]);
  });

  it("GetSystemMetrics / 桌面 / 进程 / DWM / ShowWindow 等常量", () => {
    expect({ ...SM }).toEqual({ CXSCREEN: 0, CYSCREEN: 1, XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79 });
    expect(UOI_NAME).toBe(2);
    expect(DESKTOP_SWITCHDESKTOP).toBe(0x100);
    expect(DESKTOP_READOBJECTS).toBe(0x1);
    // 探测输入桌面申请的掩码 = READOBJECTS | SWITCHDESKTOP：C# 解锁组件读桌面名用的就是 READOBJECTS，两边不能出现「一边读得出、一边读不出」
    expect(INPUT_DESKTOP_ACCESS).toBe(0x101);
    expect(PROCESS_QUERY_LIMITED_INFORMATION).toBe(0x1000);
    expect(DWMWA_CLOAKED).toBe(14);
    expect([SW_SHOWNORMAL, SW_RESTORE, MAPVK_VK_TO_VSC]).toEqual([1, 9, 0]);
  });

  it("会话锁定标志（WTSSessionInfoEx）：当前会话 (DWORD)-1 / 信息类 25 / 锁定 0 · 没锁 1 / WTSINFOEXW 偏移", () => {
    // wtsapi32.h：WTS_CURRENT_SESSION = (DWORD)-1；WTS_INFO_CLASS 里 WTSSessionInfoEx = 25；
    // WTSINFOEXW { DWORD Level; WTSINFOEX_LEVEL_W Data; }，Data 是个含 LARGE_INTEGER 的联合 → 8 字节对齐，Level 后面有 4 字节空洞；
    // Data.WTSInfoExLevel1 = { ULONG SessionId; WTS_CONNECTSTATE_CLASS SessionState; LONG SessionFlags; … }
    // → Level@0、SessionId@8、SessionState@12、SessionFlags@16。WTS_SESSIONSTATE_LOCK = 0，WTS_SESSIONSTATE_UNLOCK = 1
    expect(WTS_CURRENT_SESSION).toBe(4294967295);
    expect(WTS_SESSION_INFO_EX).toBe(25);
    expect([WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK]).toEqual([0, 1]);
    expect({ ...WTSINFOEX_OFFSETS }).toEqual({ level: 0, sessionId: 8, sessionState: 12, sessionFlags: 16 });
    expect(WTSINFOEX_READ_BYTES).toBe(20); // 读到 SessionFlags（@16，4 字节）为止
    expect(Object.isFrozen(WTSINFOEX_OFFSETS)).toBe(true);
  });

  it("修饰键：Ctrl 0x11 / Alt 0x12 / Shift 0x10 / 左 Win 0x5B（只有 Win 键是扩展键）", () => {
    expect({ ...MODIFIER_VK }).toEqual({ ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b });
    expect({ ...MODIFIER_EXTENDED }).toEqual({ ctrl: false, alt: false, shift: false, meta: true });
  });

  it("ShellExecuteExW 的 fMask 位：SEE_MASK_NOASYNC 0x100 / SEE_MASK_FLAG_NO_UI 0x400（不含 NOCLOSEPROCESS 0x40 / DOENVSUBST 0x200）", () => {
    expect({ ...SEE_MASK }).toEqual({ NOASYNC: 0x100, FLAG_NO_UI: 0x400 });
    expect(Object.isFrozen(SEE_MASK)).toBe(true);
  });

  it("核心结构体恰好 4 个；SHELLEXECUTEINFOW 不在其中（它只服务非核心的 ShellExecuteExW）", () => {
    expect([...CORE_STRUCT_NAMES]).toEqual(["INPUT", "MOUSEINPUT", "KEYBDINPUT", "LASTINPUTINFO"]);
    expect(CORE_STRUCT_NAMES).not.toContain("SHELLEXECUTEINFOW");
  });
});

describe("虚拟键码表", () => {
  const NAMED: Record<string, number> = {
    enter: 0x0d,
    escape: 0x1b,
    tab: 0x09,
    space: 0x20,
    backspace: 0x08,
    delete: 0x2e,
    left: 0x25,
    up: 0x26,
    right: 0x27,
    down: 0x28,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pagedown: 0x22,
    "=": 0xbb,
    minus: 0xbd,
    plus: 0xbb,
    "[": 0xdb,
    "]": 0xdd,
    "\\": 0xdc,
    ";": 0xba,
    "'": 0xde,
    ",": 0xbc,
    ".": 0xbe,
    "/": 0xbf,
    "`": 0xc0,
  };

  it("命名键 / 标点键码与 winuser.h 一致", () => {
    for (const [name, vk] of Object.entries(NAMED)) expect(lookupKey(name)?.vk, name).toBe(vk);
  });

  it("字母 0x41+、数字 0x30+、F1–F20 从 0x70 递增", () => {
    "abcdefghijklmnopqrstuvwxyz".split("").forEach((c, i) => expect(lookupKey(c)?.vk, c).toBe(0x41 + i));
    "0123456789".split("").forEach((c, i) => expect(lookupKey(c)?.vk, c).toBe(0x30 + i));
    for (let n = 1; n <= 20; n += 1) expect(lookupKey(`f${n}`)?.vk, `f${n}`).toBe(0x70 + n - 1);
  });

  it("扩展键恰好是：delete / 四个方向键 / home / end / pageup / pagedown", () => {
    const extended = Object.keys(KEY_TABLE).filter((k) => KEY_TABLE[k].extended);
    expect(extended.sort()).toEqual(["delete", "down", "end", "home", "left", "pagedown", "pageup", "right", "up"]);
  });

  it("只有 plus 自动补 shift", () => {
    expect(Object.keys(KEY_TABLE).filter((k) => KEY_TABLE[k].shift)).toEqual(["plus"]);
  });

  it("CANONICAL_KEYS 里每一个键都有映射", () => {
    expect(CANONICAL_KEYS.length).toBeGreaterThan(80);
    for (const key of CANONICAL_KEYS) expect(lookupKey(key), `keys.mjs 的规范键 ${key} 没有 Windows 键码`).not.toBeNull();
  });

  it("lookupKey 不会被原型链上的名字或非字符串骗到", () => {
    for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "Enter", "ctrl"]) expect(lookupKey(bad), bad).toBeNull();
    expect(lookupKey(1)).toBeNull();
    expect(lookupKey(undefined)).toBeNull();
  });
});

// ═══════════════════════════ 真 koffi：布局 / 编码 / 原型解析 ═══════════════════════════

/** 真 koffi（只在「结构体布局 / 原型解析 / libc 行为证据」这几组里用；驱动的行为测试一律用假 koffi） */
const realKoffi = createRequire(import.meta.url)("koffi");

const DEFS_PATH = pathToFileURL(path.resolve(import.meta.dirname, "../electron-app/desktop/drivers/win32-defs.mjs")).href;

type ChildEncoding = {
  size: number;
  decoded: Record<string, unknown>;
  bytes: { cbSize: number; fMask: number; nShow: number; dwHotKey: number; nullSlots: string[]; stringSlotsSet: boolean[] };
};
/**
 * 在子进程里用真 koffi 把一个 SHELLEXECUTEINFOW 编码成字节，再 decode 回来。
 * 为什么要子进程：整数成员收到 null / 字符串时 koffi 会 abort 整个进程（见头注释），入参一旦有这类错，
 * 在 vitest 进程里做就是把测试进程自己杀掉；放子进程里，最坏是 execFileSync 抛「非零退出 / 信号」的错。
 */
const encodeInChild = (info: unknown): ChildEncoding => {
  const script = [
    'import { createRequire } from "node:module";',
    "const [testUrl, defsUrl, json] = process.argv.slice(1);",
    'const koffi = createRequire(testUrl)("koffi");',
    "const { defineShellExecuteInfo } = await import(defsUrl);",
    "const type = defineShellExecuteInfo(koffi);",
    "const buf = Buffer.alloc(koffi.sizeof(type));",
    "koffi.encode(buf, type, JSON.parse(json));",
    "const slot = (offset) => buf.readBigUInt64LE(offset).toString();",
    "const show = (_key, value) => (typeof value === 'bigint' ? `${value}n` : value);",
    "console.log(JSON.stringify({",
    "  size: buf.length,",
    "  decoded: koffi.decode(buf, type),",
    "  bytes: {",
    "    cbSize: buf.readUInt32LE(0), fMask: buf.readUInt32LE(4), nShow: buf.readInt32LE(48), dwHotKey: buf.readUInt32LE(88),",
    "    nullSlots: [8, 32, 40, 56, 64, 72, 80, 96, 104].map(slot),",
    "    stringSlotsSet: [16, 24].map((offset) => slot(offset) !== '0'),",
    "  },",
    "}, show));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, import.meta.url, DEFS_PATH, JSON.stringify(info)], { encoding: "utf8" });
  return JSON.parse(out);
};

describe("结构体布局（真 koffi，Win64 期望值）", () => {
  const types = defineWin32Types(realKoffi);
  const shellInfoType = defineShellExecuteInfo(realKoffi);

  it("大小：INPUT=40 / MOUSEINPUT=32 / KEYBDINPUT=24 / LASTINPUTINFO=8", () => {
    expect(realKoffi.sizeof(types.INPUT)).toBe(40);
    expect(realKoffi.sizeof(types.MOUSEINPUT)).toBe(32);
    expect(realKoffi.sizeof(types.KEYBDINPUT)).toBe(24);
    expect(realKoffi.sizeof(types.LASTINPUTINFO)).toBe(8);
    expect(realKoffi.sizeof(types.RECT)).toBe(16);
  });

  it("字段偏移与 winuser.h 的 Win64 布局一致", () => {
    const off = (type: unknown, member: string): number => realKoffi.offsetof(type, member);
    expect(["type", "u"].map((m) => off(types.INPUT, m))).toEqual([0, 8]);
    expect(["dx", "dy", "mouseData", "dwFlags", "time", "dwExtraInfo"].map((m) => off(types.MOUSEINPUT, m))).toEqual([0, 4, 8, 12, 16, 24]);
    expect(["wVk", "wScan", "dwFlags", "time", "dwExtraInfo"].map((m) => off(types.KEYBDINPUT, m))).toEqual([0, 2, 4, 8, 16]);
    expect(["cbSize", "dwTime"].map((m) => off(types.LASTINPUTINFO, m))).toEqual([0, 4]);
    expect(["left", "top", "right", "bottom"].map((m) => off(types.RECT, m))).toEqual([0, 4, 8, 12]);
  });

  it("SHELLEXECUTEINFOW：大小 112，15 个成员的偏移与 shellapi.h 的 Win64 布局一致", () => {
    expect(realKoffi.sizeof(shellInfoType)).toBe(112);
    const members = ["cbSize", "fMask", "hwnd", "lpVerb", "lpFile", "lpParameters", "lpDirectory", "nShow", "hInstApp", "lpIDList", "lpClass", "hkeyClass", "dwHotKey", "hIconOrMonitor", "hProcess"];
    expect(members.map((m) => realKoffi.offsetof(shellInfoType, m))).toEqual([0, 4, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104]);
  });

  it("驱动实际发出的 ShellExecuteExW 入参：真 koffi（子进程）编码后的字节落点 = Win64 布局，decode 回来与入参逐字段一致", async () => {
    const { driver, calls } = await ready();
    await driver.openApp("记事本");
    const sent = ffi(calls, "ShellExecuteExW")[0].args[0];
    const out = encodeInChild(sent); // 入参类型有错时，这里是子进程被 abort → 抛错，而不是 vitest 被杀
    expect(out.size).toBe(112);
    expect(out.bytes).toEqual({ cbSize: 112, fMask: 0x500, nShow: 1, dwHotKey: 0, nullSlots: Array(9).fill("0"), stringSlotsSet: [true, true] });
    expect(out.decoded).toEqual(sent);
    expect(out.decoded).toMatchObject({ lpVerb: "open", lpFile: "记事本" }); // 字符串内容经真 koffi 编码后能原样读回
  });

  it("驱动构造的事件经 koffi 编码后的字节 = Win32 内存布局（键盘）", () => {
    const buf = Buffer.alloc(40);
    // 'a' 的 Unicode 按下：type=1(KEYBOARD)，wVk=0，wScan=0x4E2D，dwFlags=UNICODE
    realKoffi.encode(buf, types.INPUT, keyboardInput({ vk: 0, scan: 0x4e2d, flags: 0x4 }));
    expect(buf.readUInt32LE(0)).toBe(1);
    expect(buf.readUInt16LE(8)).toBe(0);
    expect(buf.readUInt16LE(10)).toBe(0x4e2d);
    expect(buf.readUInt32LE(12)).toBe(0x4);
    expect(buf.readUInt32LE(16)).toBe(0);
    expect(buf.readBigUInt64LE(24)).toBe(0n);

    // Ctrl 的抬起：wVk=0x11，wScan=0x1d，dwFlags=KEYUP
    realKoffi.encode(buf, types.INPUT, keyboardInput({ vk: 0x11, scan: 0x1d, flags: 0x2 }));
    expect(buf.readUInt16LE(8)).toBe(0x11);
    expect(buf.readUInt16LE(10)).toBe(0x1d);
    expect(buf.readUInt32LE(12)).toBe(0x2);
  });

  it("驱动构造的事件经 koffi 编码后的字节 = Win32 内存布局（鼠标，含滚轮的无符号 mouseData）", () => {
    const buf = Buffer.alloc(40);
    realKoffi.encode(buf, types.INPUT, mouseInput({ flags: 0x800, data: 4294966936 })); // 向下 3 格
    expect(buf.readUInt32LE(0)).toBe(0);
    expect(buf.readInt32LE(8)).toBe(0); // dx
    expect(buf.readInt32LE(12)).toBe(0); // dy
    expect(buf.readUInt32LE(16)).toBe(4294966936); // mouseData
    expect(buf.readInt32LE(16)).toBe(-360); // 同一份字节按有符号读 = -360，即 -3 × 120
    expect(buf.readUInt32LE(20)).toBe(0x800); // dwFlags
    expect(buf.readUInt32LE(24)).toBe(0); // time
    expect(buf.readBigUInt64LE(32)).toBe(0n); // dwExtraInfo

    realKoffi.encode(buf, types.INPUT, mouseInput({ flags: 0x1, dx: -1 })); // wakeDisplay 的相对位移
    expect(buf.readInt32LE(8)).toBe(-1);
    expect(buf.readUInt32LE(20)).toBe(0x1);
  });

  it("同一个 koffi 实例重复调用 defineWin32Types 返回同一份（不会 Duplicate type name）", () => {
    expect(defineWin32Types(realKoffi)).toBe(types);
  });

  it("expectedStructSizes：64 位 / 32 位期望值；指针宽度异常时返回 null（驱动不据此拒绝）", () => {
    expect(expectedStructSizes(8)).toEqual(SIZES_64);
    expect(expectedStructSizes(4)).toEqual(SIZES_32);
    expect(expectedStructSizes(0)).toBeNull();
    expect(expectedStructSizes(16)).toBeNull();
  });

  it("全部 Win32 原型字符串都能被真 koffi 解析（只解析：不加载任何库、不调用任何函数）", () => {
    for (const spec of WIN32_FUNCTIONS) {
      const parsed = realKoffi.proto(spec.proto);
      expect(parsed.name, spec.name).toBe(spec.name);
    }
  });
});

// ═══════════════════════════ 结构体大小的独立算术核对（不依赖 koffi） ═══════════════════════════

/**
 * 32 位 Windows 上的结构体大小没法用真 koffi 实测（Mac 上只有 64 位），驱动里的 32 位期望值是手算的。
 * 这里再写一个只依赖 C 对齐规则的小计算器（成员按自然对齐；结构体对齐 = 最大成员对齐、末尾补齐；union 取最大成员），
 * 按 winuser.h / shellapi.h 的字段类型把结构体各声明一遍，和 expectedStructSizes 交叉核对。
 * 64 位的算术结果同时要等于真 koffi 的实测——这样才能说明计算器本身没写错，32 位的结果才有参考价值。
 * 仍然不是真 32 位 Windows 上的实测（见头注释第 9 条）。
 */
type CType = "u16" | "u32" | "ptr" | { struct: CType[] } | { union: CType[] };
const layoutOf = (type: CType, pointerBytes: number): { size: number; align: number } => {
  if (type === "u16") return { size: 2, align: 2 };
  if (type === "u32") return { size: 4, align: 4 };
  if (type === "ptr") return { size: pointerBytes, align: pointerBytes };
  const members = ("struct" in type ? type.struct : type.union).map((m) => layoutOf(m, pointerBytes));
  const align = Math.max(...members.map((m) => m.align));
  const raw =
    "struct" in type ? members.reduce((offset, m) => Math.ceil(offset / m.align) * m.align + m.size, 0) : Math.max(...members.map((m) => m.size));
  return { size: Math.ceil(raw / align) * align, align };
};

// dx dy mouseData dwFlags time dwExtraInfo(ULONG_PTR)
const MOUSEINPUT_C: CType = { struct: ["u32", "u32", "u32", "u32", "u32", "ptr"] };
// wVk wScan dwFlags time dwExtraInfo
const KEYBDINPUT_C: CType = { struct: ["u16", "u16", "u32", "u32", "ptr"] };
// uMsg wParamL wParamH
const HARDWAREINPUT_C: CType = { struct: ["u32", "u16", "u16"] };
const C_STRUCTS: Record<string, CType> = {
  INPUT: { struct: ["u32", { union: [MOUSEINPUT_C, KEYBDINPUT_C, HARDWAREINPUT_C] }] },
  MOUSEINPUT: MOUSEINPUT_C,
  KEYBDINPUT: KEYBDINPUT_C,
  LASTINPUTINFO: { struct: ["u32", "u32"] },
  // cbSize fMask hwnd lpVerb lpFile lpParameters lpDirectory nShow hInstApp lpIDList lpClass hkeyClass dwHotKey (hIcon | hMonitor) hProcess
  SHELLEXECUTEINFOW: { struct: ["u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr", "ptr", "ptr", "ptr", "u32", "ptr", "ptr"] },
};
const sizesByArithmetic = (pointerBytes: number) =>
  Object.fromEntries(Object.entries(C_STRUCTS).map(([name, type]) => [name, layoutOf(type, pointerBytes).size]));

describe("结构体大小的独立算术核对（不依赖 koffi）", () => {
  it("64 位：算术结果 = 真 koffi 实测 = expectedStructSizes(8)（证明计算器本身没写错）", () => {
    const types = defineWin32Types(realKoffi);
    const measured = {
      INPUT: realKoffi.sizeof(types.INPUT),
      MOUSEINPUT: realKoffi.sizeof(types.MOUSEINPUT),
      KEYBDINPUT: realKoffi.sizeof(types.KEYBDINPUT),
      LASTINPUTINFO: realKoffi.sizeof(types.LASTINPUTINFO),
      SHELLEXECUTEINFOW: realKoffi.sizeof(defineShellExecuteInfo(realKoffi)),
    };
    expect(sizesByArithmetic(8)).toEqual(measured);
    expect(sizesByArithmetic(8)).toEqual(expectedStructSizes(8));
  });

  it("32 位：算术结果 = expectedStructSizes(4)（INPUT=28 / MOUSEINPUT=24 / KEYBDINPUT=16 / LASTINPUTINFO=8 / SHELLEXECUTEINFOW=60）", () => {
    expect(sizesByArithmetic(4)).toEqual({ INPUT: 28, MOUSEINPUT: 24, KEYBDINPUT: 16, LASTINPUTINFO: 8, SHELLEXECUTEINFOW: 60 });
    expect(sizesByArithmetic(4)).toEqual(expectedStructSizes(4));
  });
});

// ═══════════════════════════ 真 koffi + libc：驱动依赖的 FFI 行为证据 ═══════════════════════════

/**
 * 目的：把「驱动在 Windows 上依赖 koffi 的哪些行为」变成仓库里可复核的证据，而不是只留在某次会话里。
 * 做法：用 libc 里无副作用的函数（memcpy / memset / time / timegm / localtime_r / free）做同构实验，
 * 不调用任何 Win32 函数。Windows 上不跑（没有这些符号）；找不到 libc 时自动跳过。
 * 假 koffi（createFake）的「出参规则」就是照这里验证的行为写的——koffi 升级后这里变红，说明夹具的前提要重新核对。
 */
const loadLibc = () => {
  const candidates: Record<string, string[]> = { darwin: ["libSystem.dylib"], linux: ["libc.so.6"] };
  for (const file of candidates[process.platform] ?? []) {
    try {
      return realKoffi.load(file);
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
};
const libc = loadLibc();

/** 驱动构造的事件（JS 对象）→ 拍平成「Windows 内存里能读出来的字段」 */
type Wire = { type: number; wVk?: number; wScan?: number; dx?: number; dy?: number; mouseData?: number; dwFlags: number; time: number; extra: bigint };
const wireOf = (e: InputEvent): Wire =>
  e.u.ki
    ? { type: e.type, wVk: e.u.ki.wVk, wScan: e.u.ki.wScan, dwFlags: e.u.ki.dwFlags, time: e.u.ki.time, extra: BigInt(e.u.ki.dwExtraInfo) }
    : { type: e.type, dx: mi(e).dx, dy: mi(e).dy, mouseData: mi(e).mouseData, dwFlags: mi(e).dwFlags, time: mi(e).time, extra: BigInt(mi(e).dwExtraInfo) };
/** 按 winuser.h 的 Win64 布局（INPUT 40 字节）从连续内存里读回 count 个事件 */
const decodeWire = (buf: Buffer, count: number): Wire[] =>
  Array.from({ length: count }, (_, i) => {
    const o = i * 40;
    const type = buf.readUInt32LE(o);
    return type === 1
      ? { type, wVk: buf.readUInt16LE(o + 8), wScan: buf.readUInt16LE(o + 10), dwFlags: buf.readUInt32LE(o + 12), time: buf.readUInt32LE(o + 16), extra: buf.readBigUInt64LE(o + 24) }
      : { type, dx: buf.readInt32LE(o + 8), dy: buf.readInt32LE(o + 12), mouseData: buf.readUInt32LE(o + 16), dwFlags: buf.readUInt32LE(o + 20), time: buf.readUInt32LE(o + 24), extra: buf.readBigUInt64LE(o + 32) };
  });

describe.skipIf(!libc)("真 koffi + libc：驱动依赖的 FFI 行为（Windows 上不跑；没有 libc 时跳过）", () => {
  const types = defineWin32Types(realKoffi);
  // 只为注册类型名：下面的 libc 原型字符串按名字引用它（macOS / glibc 的 struct tm 布局相同）
  realKoffi.struct("ProbeTm", {
    tm_sec: "int",
    tm_min: "int",
    tm_hour: "int",
    tm_mday: "int",
    tm_mon: "int",
    tm_year: "int",
    tm_wday: "int",
    tm_yday: "int",
    tm_isdst: "int",
    tm_gmtoff: "long",
    tm_zone: "void *",
  });

  it("【出参·结构体】_Inout_：传 JS 对象，结果原地写回同一个对象；不写 _Inout_ 就不写回（GetLastInputInfo 的前提）", () => {
    const fresh = () => ({ tm_sec: 0, tm_min: 0, tm_hour: 0, tm_mday: 32, tm_mon: 0, tm_year: 100, tm_wday: 0, tm_yday: 0, tm_isdst: 0, tm_gmtoff: 0, tm_zone: null });
    const marked = fresh();
    const unmarked = fresh();
    libc.func("int64_t timegm(_Inout_ ProbeTm *t)")(marked); // timegm 会把「1 月 32 日」规范化成「2 月 1 日」并写回
    libc.func("int64_t timegm(ProbeTm *t)")(unmarked);
    expect([marked.tm_mday, marked.tm_mon]).toEqual([1, 1]);
    expect([unmarked.tm_mday, unmarked.tm_mon]).toEqual([32, 0]);
  });

  it("【出参·结构体】_Out_：传 {} 会被填满；不写 _Out_ 则静默不填、也不报错（GetWindowRect 的前提）", () => {
    const filled = {};
    const untouched = {};
    libc.func("void *localtime_r(const int64_t *t, _Out_ ProbeTm *out)")([86400 * 365], filled);
    libc.func("void *localtime_r(const int64_t *t, ProbeTm *out)")([86400 * 365], untouched);
    expect(Object.keys(filled)).toHaveLength(11);
    expect(Object.keys(untouched)).toHaveLength(0);
  });

  it("【出参·单元素数组】只有标了 _Out_ 才写回（GetWindowThreadProcessId / DwmGetWindowAttribute 等 LPDWORD 类出参的写法）", () => {
    const marked = [0];
    const unmarked = [0];
    libc.func("int64_t time(_Out_ int64_t *t)")(marked);
    libc.func("int64_t time(int64_t *t)")(unmarked);
    expect(marked[0]).toBeGreaterThan(1_700_000_000);
    expect(unmarked[0]).toBe(0);
  });

  it("【出参·Buffer】作为 void * 是直接指针，带不带 _Out_ 都可写（GetWindowTextW 等缓冲区出参）", () => {
    const plain = Buffer.alloc(4);
    const marked = Buffer.alloc(4);
    libc.func("void *memset(void *s, int c, size_t n)")(plain, 0x41, 4);
    libc.func("void *memset(_Out_ void *s, int c, size_t n)")(marked, 0x42, 4);
    expect(plain.toString("latin1")).toBe("AAAA");
    expect(marked.toString("latin1")).toBe("BBBB");
  });

  it("【SendInput 参数形态】JS 事件数组作为 INPUT * 传入：按 sizeof(INPUT)=40 字节步长连续编码，union 选对 mi / ki", () => {
    const memcpy = libc.func("void *memcpy(_Out_ void *dst, const INPUT *src, size_t n)");
    const sent = [
      keyboardInput({ vk: 0x11, scan: 0x1d, flags: 0 }),
      mouseInput({ flags: 0x800, data: 4294966936 }),
      keyboardInput({ vk: 0, scan: 0x4e2d, flags: 0x4 }),
      mouseInput({ flags: 0x1, dx: -1 }),
    ];
    expect(realKoffi.sizeof(types.INPUT)).toBe(40);
    const buf = Buffer.alloc(40 * sent.length);
    memcpy(buf, sent, buf.length);
    expect(decodeWire(buf, sent.length)).toEqual([
      { type: 1, wVk: 0x11, wScan: 0x1d, dwFlags: 0, time: 0, extra: 0n },
      { type: 0, dx: 0, dy: 0, mouseData: 4294966936, dwFlags: 0x800, time: 0, extra: 0n },
      { type: 1, wVk: 0, wScan: 0x4e2d, dwFlags: 0x4, time: 0, extra: 0n },
      { type: 0, dx: -1, dy: 0, mouseData: 0, dwFlags: 0x1, time: 0, extra: 0n },
    ]);
  });

  it("【SendInput 参数形态】驱动真实发出的每一批事件（点击 / 组合键 / 中文 + emoji + 换行 / 滚轮 / 拖拽 / 唤醒），经真 koffi 编码再按 Win32 布局读回，与驱动的意图逐字段一致", async () => {
    const memcpy = libc.func("void *memcpy(_Out_ void *dst, const INPUT *src, size_t n)");
    const { driver, calls } = await ready();
    await driver.click(10, 20, { button: "right", count: 2 });
    driver.keyCombo({ mods: ["ctrl", "shift"], key: "t" });
    driver.keyCombo({ mods: ["alt", "meta"], key: "plus" });
    driver.keyCombo({ mods: [], key: "delete" });
    await driver.typeText("中😀\na\tb");
    driver.scroll(0, 0, -2, 3);
    await driver.wakeDisplay();
    await driver.drag({ x: 0, y: 0 }, { x: 5, y: 5 }, { durationMs: 0 });

    const sentBatches = batches(calls);
    // 防止「什么都没比较」，同时钉住这组动作的体量：
    // 点击 2×2 + ctrl+shift+t 6 + alt+meta+plus 8 + delete 2 + 文本 7 个 UTF-16 单元×2 + 滚轮 2 + 唤醒 2×1 + 拖拽 2×1 = 40 个事件、11 批
    expect(sentBatches).toHaveLength(11);
    expect(sentBatches.flat()).toHaveLength(40);
    expect(new Set(sentBatches.flat().map((e) => e.type))).toEqual(new Set([0, 1])); // 键盘和鼠标事件都覆盖到
    for (const batch of sentBatches) {
      const buf = Buffer.alloc(40 * batch.length);
      memcpy(buf, batch, buf.length);
      expect(decodeWire(buf, batch.length)).toEqual(batch.map(wireOf));
    }
  });

  it("【ShellExecuteW 参数形态】const char16_t *：JS 字符串 → UTF-16LE + NUL 结尾；null → NULL 指针", () => {
    const memcpyWide = libc.func("void *memcpy(_Out_ void *dst, const char16_t *src, size_t n)");
    const out = Buffer.alloc(8);
    memcpyWide(out, "微信", 6); // 2 个字符 + NUL = 6 字节
    expect(out.toString("hex")).toBe("ae5fe14f00000000");
    const freeWide = libc.func("void free(const char16_t *p)");
    expect(() => freeWide(null)).not.toThrow(); // free(NULL) 是 no-op：能走到这里说明 null 被当成了 NULL 指针
  });

  it("【ShellExecuteExW 出参】SHELLEXECUTEINFOW 经 _Inout_ 传入：被调函数写的 hInstApp 读回 BigInt（0 读成 null）；没标 _Inout_ 就读不回；字符串 / null 成员原样往返", () => {
    defineShellExecuteInfo(realKoffi); // 注册类型名：下面的原型字符串按名字引用它
    const memcpyIo = libc.func("void *memcpy(_Inout_ SHELLEXECUTEINFOW *dst, const void *src, size_t n)");
    const memcpyPlain = libc.func("void *memcpy(SHELLEXECUTEINFOW *dst, const void *src, size_t n)");
    const readBack = (memcpy: typeof memcpyIo, hInstApp: bigint) => {
      const written = Buffer.alloc(112); // 假装是被调函数写下的 112 字节：hInstApp 在偏移 56
      written.writeBigUInt64LE(hInstApp, 56);
      const info = shellExecuteInfo({ size: 112, file: "x" });
      memcpy(info, written, 112);
      return info.hInstApp;
    };
    expect(readBack(memcpyIo, 2n)).toBe(2n);
    expect(readBack(memcpyIo, 33n)).toBe(33n);
    expect(readBack(memcpyIo, 0n)).toBeNull();
    expect(readBack(memcpyPlain, 2n)).toBeNull(); // 没标 _Inout_：写了也读不回，而且不报错

    // 被调函数什么都不改（memset n=0）：字符串 / null 指针 / 整数成员经「编码 → 调用 → 写回」原样不变
    const noop = libc.func("void *memset(_Inout_ SHELLEXECUTEINFOW *s, int c, size_t n)");
    const info = shellExecuteInfo({ size: 112, file: "C:\\Apps\\微信.exe" });
    noop(info, 0, 0);
    expect(info).toEqual(shellExecuteInfo({ size: 112, file: "C:\\Apps\\微信.exe" }));
  });

  // 这条会让子进程真的 SIGABRT：macOS 的 ReportCrash 每次都会在 ~/Library/Logs/DiagnosticReports 里留一份真实的崩溃报告（还可能弹
  // 「node 意外退出」窗口），开发机上每跑一遍测试就多一份——第三轮评审。它只是给 createFake 的类型守卫提供依据（koffi 的行为不变，守卫就仍然需要），
  // 不需要每次都在开发机上证明一遍：macOS 上默认跳过，要复核时 FLOWSHIP_TEST_KOFFI_ABORT=1 显式打开；Linux CI 照常跑（不产生崩溃报告弹窗）。
  const skipAbortProbe = process.platform === "darwin" && process.env.FLOWSHIP_TEST_KOFFI_ABORT !== "1";
  it.skipIf(skipAbortProbe)("【类型守卫的依据】整数成员收到 null：koffi 不抛 JS 异常，而是 abort 整个进程（SIGABRT）；合法值正常（子进程里跑；macOS 上默认跳过——会留真实崩溃报告，FLOWSHIP_TEST_KOFFI_ABORT=1 才跑）", () => {
    const run = (value: string) => {
      const script = [
        'import { createRequire } from "node:module";',
        'const koffi = createRequire(process.argv[1])("koffi");',
        'const Probe = koffi.struct("ProbeAbort", { a: "uint32_t", b: "uint32_t" });',
        `koffi.encode(Buffer.alloc(8), Probe, { a: 1, b: ${value} });`,
        'console.log("survived");',
      ].join("\n");
      return spawnSync(process.execPath, ["--input-type=module", "-e", script, import.meta.url], { encoding: "utf8" });
    };
    expect(run("2").stdout.trim()).toBe("survived");
    const aborted = run("null");
    expect(aborted.signal).toBe("SIGABRT");
    expect(aborted.stdout).not.toContain("survived");
  });

  it("【返回值类型】指针返回 BigInt、intptr_t 返回 Number（isNullHandle / ShellExecuteW 返回值判断的前提）", () => {
    const ptr = libc.func("void *malloc(size_t n)")(16);
    expect(typeof ptr).toBe("bigint");
    libc.func("void free(void *p)")(ptr);
    expect(typeof libc.func("intptr_t labs(intptr_t x)")(-42)).toBe("number");
  });
});

describe("函数原型表自身的一致性", () => {
  it("函数名唯一，且与原型里的函数名一致；库名都在 WIN32_LIBRARIES 里", () => {
    const seen = new Set<string>();
    for (const spec of WIN32_FUNCTIONS) {
      expect(seen.has(spec.name), `重复：${spec.name}`).toBe(false);
      seen.add(spec.name);
      expect(protoName(spec.proto), spec.name).toBe(spec.name);
      expect(Object.keys(WIN32_LIBRARIES)).toContain(spec.lib);
    }
  });

  it("全部 __stdcall；BOOL 一律按 4 字节 int 声明，不用 koffi 的 bool", () => {
    for (const spec of WIN32_FUNCTIONS) {
      expect(spec.proto, spec.name).toMatch(/__stdcall/);
      expect(spec.proto, spec.name).not.toMatch(/\bbool\b/);
    }
  });

  it("SendInput 的签名：(UINT, INPUT *, int cbSize)，返回 UINT", () => {
    const spec = WIN32_FUNCTIONS.find((f) => f.name === "SendInput");
    expect(spec?.proto).toBe("uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)");
  });

  it("核心函数恰好是约定的 6 个", () => {
    expect([...CORE_FUNCTIONS].sort()).toEqual(["CloseDesktop", "GetLastInputInfo", "GetSystemMetrics", "OpenInputDesktop", "SendInput", "SetCursorPos"]);
  });

  /**
   * Windows SDK 官方签名（winuser.h / processthreadsapi.h / shellapi.h / dwmapi.h 等）的「类型骨架」：只写返回类型和参数类型，
   * 不写参数名，也不写 _Out_ / _Inout_（出参方向由夹具的出参规则保护）。写法对应关系：
   *   BOOL / INT / enum → int；UINT / DWORD / ACCESS_MASK → uint32_t；HRESULT → int32_t；
   *   HWND / HANDLE / HDESK / DPI_AWARENESS_CONTEXT / PVOID（不透明缓冲）→ void *；LPARAM、ShellExecute 的 HINSTANCE 返回值 → intptr_t；
   *   LPCWSTR → const char16_t *；LPDWORD / PDWORD → uint32_t *；LPRECT → RECT *；LPINPUT → INPUT *；LPSHELLEXECUTEINFOW → SHELLEXECUTEINFOW *。
   * 两处细化：DwmGetWindowAttribute 的 PVOID pvAttribute 我们只读 4 字节整数，所以写成 int32_t *；
   * WTSQuerySessionInformationW 的 LPWSTR *ppBuffer 在 WTSSessionInfoEx 下装的是不透明结构（WTSINFOEXW），所以写成 void **（驱动用 koffi.decode 读原始字节），
   * 对应的 WTSFreeMemory(PVOID) 是 void(void *)。
   */
  const SDK_SIGNATURES: Record<string, string> = {
    SendInput: "uint32_t(uint32_t, INPUT *, int)",
    SetCursorPos: "int(int, int)",
    GetSystemMetrics: "int(int)",
    GetLastInputInfo: "int(LASTINPUTINFO *)",
    OpenInputDesktop: "void *(uint32_t, int, uint32_t)",
    CloseDesktop: "int(void *)",
    GetUserObjectInformationW: "int(void *, int, void *, uint32_t, uint32_t *)",
    MapVirtualKeyW: "uint32_t(uint32_t, uint32_t)",
    LockWorkStation: "int()",
    GetForegroundWindow: "void *()",
    EnumWindows: "int(WNDENUMPROC *, intptr_t)",
    IsWindowVisible: "int(void *)",
    IsIconic: "int(void *)",
    GetWindowTextW: "int(void *, void *, int)",
    GetWindowRect: "int(void *, RECT *)",
    GetWindowThreadProcessId: "uint32_t(void *, uint32_t *)",
    ShowWindow: "int(void *, int)",
    SetForegroundWindow: "int(void *)",
    GetThreadDpiAwarenessContext: "void *()",
    GetAwarenessFromDpiAwarenessContext: "int(void *)",
    GetTickCount: "uint32_t()",
    OpenProcess: "void *(uint32_t, int, uint32_t)",
    CloseHandle: "int(void *)",
    QueryFullProcessImageNameW: "int(void *, uint32_t, void *, uint32_t *)",
    GetLastError: "uint32_t()",
    ShellExecuteExW: "int(SHELLEXECUTEINFOW *)",
    ShellExecuteW: "intptr_t(void *, const char16_t *, const char16_t *, const char16_t *, const char16_t *, int)",
    DwmGetWindowAttribute: "int32_t(void *, uint32_t, int32_t *, uint32_t)",
    ProcessIdToSessionId: "int(uint32_t, uint32_t *)",
    WTSQuerySessionInformationW: "int(void *, uint32_t, int, void **, uint32_t *)",
    WTSFreeMemory: "void(void *)",
  };

  /** "int __stdcall Foo(_Out_ RECT *r, const char16_t *s)" → "int(RECT *, const char16_t *)"：只留类型 */
  const skeleton = (prototype: string) => {
    const name = protoName(prototype);
    const ret = prototype.slice(0, prototype.indexOf(name)).replace(/__stdcall/g, "").trim();
    const params = prototype.slice(prototype.indexOf("(") + 1, prototype.lastIndexOf(")")).trim();
    const types = params === "" ? [] : params.split(",").map((p) => p.trim().replace(/^_(Out|Inout)_\s+/, "").replace(/\s*\b\w+$/, "").replace(/\s+\*/g, " *").trim());
    return `${ret}(${types.join(", ")})`;
  };

  it("每个函数的返回类型、参数个数与类型宽度，和 Windows SDK 官方签名一致（句柄一律 void *，W 函数一律 char16_t，BOOL 一律 int）", () => {
    for (const spec of WIN32_FUNCTIONS) expect(skeleton(spec.proto), spec.name).toBe(SDK_SIGNATURES[spec.name]);
  });

  it("官方签名表与原型表的函数集合完全相同（新增 / 删除函数时两边要一起改）", () => {
    expect(WIN32_FUNCTIONS.map((f) => f.name).sort()).toEqual(Object.keys(SDK_SIGNATURES).sort());
  });

  it("骨架提取器自检：参数名、_Out_ / _Inout_、__stdcall 都被正确剥掉", () => {
    expect(skeleton("void *__stdcall Foo()")).toBe("void *()");
    expect(skeleton("int __stdcall Foo(_Out_ RECT *lpRect, const char16_t *s, int X)")).toBe("int(RECT *, const char16_t *, int)");
    expect(skeleton("uint32_t __stdcall Foo(_Inout_ uint32_t *lpdwSize)")).toBe("uint32_t(uint32_t *)");
    expect(skeleton("int __stdcall Foo(_Inout_ SHELLEXECUTEINFOW *pExecInfo)")).toBe("int(SHELLEXECUTEINFOW *)");
  });

  it("ShellExecuteExW：shell32、非核心、依赖 SHELLEXECUTEINFOW、参数标了 _Inout_（hInstApp 读回的前提）；ShellExecuteW 保留为非核心的降级路径", () => {
    const ex = WIN32_FUNCTIONS.find((f) => f.name === "ShellExecuteExW");
    expect(ex).toMatchObject({ lib: "shell32", core: false, needs: "SHELLEXECUTEINFOW" });
    expect(ex?.proto).toBe("int __stdcall ShellExecuteExW(_Inout_ SHELLEXECUTEINFOW *pExecInfo)");
    expect(outFlags(ex?.proto ?? "")).toEqual([true]);
    expect(WIN32_FUNCTIONS.find((f) => f.name === "ShellExecuteW")).toMatchObject({ lib: "shell32", core: false });
    expect(CORE_FUNCTIONS).not.toContain("ShellExecuteExW");
    expect(CORE_FUNCTIONS).not.toContain("ShellExecuteW");
  });

  it("needs 与原型一致：引用了 SHELLEXECUTEINFOW 的函数一定声明了 needs，反之亦然（只有 ShellExecuteExW）", () => {
    for (const spec of WIN32_FUNCTIONS) expect(spec.proto.includes("SHELLEXECUTEINFOW"), spec.name).toBe(spec.needs === "SHELLEXECUTEINFOW");
    expect(WIN32_FUNCTIONS.filter((f) => f.needs).map((f) => f.name)).toEqual(["ShellExecuteExW"]);
  });
});

describe("夹具自检：假 koffi 遵守真 koffi 的出参规则", () => {
  const lib = createFake({ lastInput: 777 }).koffi.load("user32.dll");

  it("结构体：标了 _Inout_ 写回，没标就是副本", () => {
    const marked = { cbSize: 8, dwTime: 0 };
    const unmarked = { cbSize: 8, dwTime: 0 };
    lib.func("int __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)")(marked);
    lib.func("int __stdcall GetLastInputInfo(LASTINPUTINFO *plii)")(unmarked);
    expect(marked.dwTime).toBe(777);
    expect(unmarked.dwTime).toBe(0);
  });

  it("单元素数组：标了 _Out_ 写回，没标就是副本", () => {
    const marked = [0];
    const unmarked = [0];
    lib.func("uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)")(H(0x10), marked);
    lib.func("uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, uint32_t *lpdwProcessId)")(H(0x10), unmarked);
    expect(marked).toEqual([100]);
    expect(unmarked).toEqual([0]);
  });

  it("Buffer 是直接指针：带不带 _Out_ 都可写", () => {
    const withOut = Buffer.alloc(64);
    const withoutOut = Buffer.alloc(64);
    lib.func("int __stdcall GetWindowTextW(void *hWnd, _Out_ void *lpString, int nMaxCount)")(H(0x10), withOut, 32);
    lib.func("int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)")(H(0x10), withoutOut, 32);
    expect(withOut.readUInt16LE(0)).toBe("无".charCodeAt(0));
    expect(withoutOut.equals(withOut)).toBe(true);
  });
});

// ═══════════════════════════ init / 无副作用 ═══════════════════════════

describe("init", () => {
  it.each(["darwin", "linux"])("platform=%s：返回 ok:false「仅 Windows 可用」，koffi 的任何成员都不碰", async (platform) => {
    const touched: string[] = [];
    const guarded = new Proxy({}, {
      get: (_target, prop) => {
        touched.push(String(prop));
        return undefined;
      },
    }) as unknown as KoffiArg;
    const driver = createWin32Driver({ koffi: guarded, platform });
    expect(await driver.init()).toEqual({ ok: false, error: "仅 Windows 可用" });
    expect(driver.diagnostics()).toMatchObject({ platform, loaded: false });
    expect(touched).toEqual([]);
  });

  it("非 win32：koffi.load 不会被调用（用完整假 koffi 再确认一遍）", async () => {
    const fake = createFake({ platform: "darwin" });
    expect(await fake.driver.init()).toEqual({ ok: false, error: "仅 Windows 可用" });
    expect(fake.loads).toEqual([]);
    expect(fake.bound).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("platform 缺省取 process.platform：本机不是 Windows，init 直接 ok:false", async () => {
    const driver = createWin32Driver({});
    expect(await driver.init()).toEqual({ ok: false, error: "仅 Windows 可用" });
    expect(driver.platform).toBe("win32"); // 驱动自己的标识不随宿主平台变
  });

  it("创建驱动本身不碰 koffi（只有 init 才会）", () => {
    const touched: string[] = [];
    const guarded = new Proxy({}, { get: (_t, prop) => (touched.push(String(prop)), undefined) }) as unknown as KoffiArg;
    createWin32Driver({ koffi: guarded, platform: "win32" });
    expect(touched).toEqual([]);
  });

  it("win32：依次加载 user32 / kernel32 / shell32 / dwmapi / wtsapi32，原型表里的函数全部绑定，返回 ok:true", async () => {
    const fake = createFake();
    expect(await fake.driver.init()).toEqual({ ok: true });
    expect(fake.loads).toEqual(["user32.dll", "kernel32.dll", "shell32.dll", "dwmapi.dll", "wtsapi32.dll"]);
    expect([...fake.bound].sort()).toEqual(WIN32_FUNCTIONS.map((f) => f.name).sort());
    expect(fake.calls).toEqual([]); // init 只绑定，不调用任何 Win32 函数
  });

  it("重复 init 幂等：不会再次加载库", async () => {
    const fake = createFake();
    await fake.driver.init();
    await fake.driver.init();
    expect(fake.loads).toHaveLength(5);
  });

  it("两个驱动实例共用同一个 koffi：结构体只定义一次，不会 Duplicate type name", async () => {
    const first = createFake();
    const second = createWin32Driver({ koffi: first.koffi, platform: "win32" });
    expect(await first.driver.init()).toEqual({ ok: true });
    expect(await second.init()).toEqual({ ok: true });
  });

  it("init 日志只写诊断信息，且带固定前缀；log 自己抛错也不影响驱动", async () => {
    const fake = createFake();
    await fake.driver.init();
    expect(fake.logs).toHaveLength(1);
    expect(fake.logs[0]).toMatch(/^\[desktop\/win32\] 初始化完成/);

    const noisy = createFake();
    const driver = createWin32Driver({
      koffi: noisy.koffi,
      platform: "win32",
      log: () => {
        throw new Error("日志出错");
      },
    });
    expect(await driver.init()).toEqual({ ok: true });
  });

  it("dwmapi 加载失败：init 仍成功，只是少了 cloaked 过滤；原因进 diagnostics", async () => {
    const fake = createFake({ failLoad: ["dwmapi.dll"] });
    expect(await fake.driver.init()).toEqual({ ok: true });
    const diag = fake.driver.diagnostics() as { bindFailures: string[]; bindErrors: Record<string, string> };
    expect(diag.bindFailures).toEqual(["DwmGetWindowAttribute"]);
    expect(diag.bindErrors.DwmGetWindowAttribute).toMatch(/dwmapi\.dll/);
  });

  it("非核心函数缺失：init 成功；只有用到它的功能报「缺少 Win32 函数 X」，其它照常", async () => {
    const { driver, calls } = await ready({ missing: ["EnumWindows"] });
    const err = await catchError(() => driver.listApps());
    expect(err).toMatchObject({ name: "DesktopError", code: "UNSUPPORTED" });
    expect(err.message).toMatch(/缺少 Win32 函数 EnumWindows/);
    await driver.click(1, 2); // 其它功能不受影响
    expect(names(calls)).toContain("SendInput");
    expect((driver.diagnostics() as { bindFailures: string[] }).bindFailures).toEqual(["EnumWindows"]);
  });

  it("核心函数缺失：init 返回 ok:false，error 点名缺了谁；之后所有操作都报同一个原因", async () => {
    const fake = createFake({ missing: ["SendInput", "OpenInputDesktop"] });
    const result = await fake.driver.init();
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toMatch(/SendInput/);
    expect(error).toMatch(/OpenInputDesktop/);
    expect(error).not.toMatch(/SetCursorPos/);

    const err = await catchError(() => fake.driver.click(1, 2));
    expect(err).toMatchObject({ code: "UNSUPPORTED", message: error });
    expect(fake.driver.diagnostics()).toMatchObject({ loaded: false, initError: error });
  });

  it("user32.dll 整个加载失败：6 个核心函数全部点名，并带上库加载失败的原因", async () => {
    const result = await createFake({ failLoad: ["user32.dll"] }).driver.init();
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    for (const name of CORE_FUNCTIONS) expect(error).toContain(name);
    expect(error).toMatch(/user32\.dll/);
  });

  it("结构体大小与 Windows 要求不一致：拒绝启用（宁可不可用，也不让 SendInput 神秘失败），且一个系统库都不加载", async () => {
    const fake = createFake({ sizes: { INPUT: 41 } });
    const result = await fake.driver.init();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/INPUT=41，应为 40/);
    expect(fake.loads).toEqual([]);
  });

  it("32 位（指针 4 字节）按 28/24/16/8 对账；SendInput 的 cbSize 取实测的 sizeof(INPUT)，不是写死的 40", async () => {
    const { driver, calls } = await ready({ pointerSize: 4, sizes: SIZES_32 });
    await driver.click(1, 2);
    expect(ffi(calls, "SendInput")[0].args[2]).toBe(28);
    expect((driver.diagnostics() as { structSizes: unknown }).structSizes).toEqual(SIZES_32);

    const wrong = await createFake({ pointerSize: 4 }).driver.init(); // 64 位的大小却声称 32 位指针
    expect(wrong.ok).toBe(false);
  });

  it("koffi.struct 抛错：init 返回 ok:false，说明是结构体定义失败", async () => {
    const fake = createFake();
    fake.koffi.struct = () => {
      throw new Error("boom");
    };
    const result = await fake.driver.init();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/定义 Win32 结构体失败：boom/);
  });

  describe("SHELLEXECUTEINFOW / ShellExecuteExW 是非核心依赖：出问题只退回 ShellExecuteW，不影响 init 对核心的判定", () => {
    type InitDiag = {
      loaded: boolean;
      initError: string | null;
      bindFailures: string[];
      bindErrors: Record<string, string>;
      structSizes: Record<string, number> | null;
      shellExecute: string;
    };
    const diagOf = (driver: Driver) => driver.diagnostics() as unknown as InitDiag;
    const CORE_SIZES = { INPUT: 40, MOUSEINPUT: 32, KEYBDINPUT: 24, LASTINPUTINFO: 8 };

    it("SHELLEXECUTEINFOW 实测大小不对：init 仍 ok、核心功能照常；ShellExecuteExW 不绑定，原因（含实测值）进 diagnostics", async () => {
      const fake = createFake({ sizes: { SHELLEXECUTEINFOW: 100 } });
      expect(await fake.driver.init()).toEqual({ ok: true });
      expect(fake.bound).not.toContain("ShellExecuteExW");
      expect(fake.bound).toContain("ShellExecuteW");
      const diag = diagOf(fake.driver);
      expect(diag).toMatchObject({ loaded: true, initError: null, bindFailures: ["ShellExecuteExW"], shellExecute: "ShellExecuteW" });
      expect(diag.bindErrors).toEqual({ ShellExecuteExW: "SHELLEXECUTEINFOW 的实测大小是 100，应为 112" });
      expect(diag.structSizes).toEqual({ ...SIZES_64, SHELLEXECUTEINFOW: 100 }); // 实测值照实记录
      await fake.driver.click(1, 2); // 核心功能照常
      expect(names(fake.calls)).toContain("SendInput");
    });

    it("SHELLEXECUTEINFOW 定义失败（koffi.struct 抛错）：同样只是退回 ShellExecuteW；核心结构体不受影响，结构体大小里没有它", async () => {
      const fake = createFake({ structFails: ["SHELLEXECUTEINFOW"] });
      expect(await fake.driver.init()).toEqual({ ok: true });
      const diag = diagOf(fake.driver);
      expect(diag).toMatchObject({ loaded: true, bindFailures: ["ShellExecuteExW"], shellExecute: "ShellExecuteW" });
      expect(diag.bindErrors).toEqual({ ShellExecuteExW: "定义 SHELLEXECUTEINFOW 失败：boom: SHELLEXECUTEINFOW" });
      expect(diag.structSizes).toEqual(CORE_SIZES);
      expect(fake.bound).not.toContain("ShellExecuteExW");
    });

    it("ShellExecuteExW 在 shell32 里绑不上：init 仍 ok，diagnostics 可见，退回 ShellExecuteW", async () => {
      const fake = createFake({ missing: ["ShellExecuteExW"] });
      expect(await fake.driver.init()).toEqual({ ok: true });
      const diag = diagOf(fake.driver);
      expect(diag).toMatchObject({ loaded: true, bindFailures: ["ShellExecuteExW"], shellExecute: "ShellExecuteW" });
      expect(diag.bindErrors.ShellExecuteExW).toMatch(/Cannot find function 'ShellExecuteExW'/);
      expect(diag.structSizes).toEqual(SIZES_64); // 结构体本身没问题
    });

    it("shell32.dll 整个加载失败：ShellExecuteExW / ShellExecuteW 都进 bindFailures，shellExecute = unavailable，init 仍 ok", async () => {
      const fake = createFake({ failLoad: ["shell32.dll"] });
      expect(await fake.driver.init()).toEqual({ ok: true });
      const diag = diagOf(fake.driver);
      expect(diag.bindFailures).toEqual(["ShellExecuteExW", "ShellExecuteW"]);
      expect(diag.shellExecute).toBe("unavailable");
      expect(diag.bindErrors.ShellExecuteExW).toMatch(/shell32\.dll/);
    });

    it("核心结构体大小不对：init 失败，错误只点名核心结构体——SHELLEXECUTEINFOW 的事不进核心判定", async () => {
      const result = await createFake({ sizes: { INPUT: 41, SHELLEXECUTEINFOW: 100 } }).driver.init();
      expect(result.ok).toBe(false);
      const error = (result as { error: string }).error;
      expect(error).toMatch(/INPUT=41，应为 40/);
      expect(error).not.toMatch(/SHELLEXECUTEINFOW/);
    });

    it("核心全对、SHELLEXECUTEINFOW 的大小是别的值：init 的返回值与「它完全正常」时一模一样", async () => {
      const normal = await createFake().driver.init();
      const odd = await createFake({ sizes: { SHELLEXECUTEINFOW: 1 } }).driver.init();
      expect(odd).toEqual(normal);
      expect(odd).toEqual({ ok: true });
    });

    it("指针宽度不在已知范围（期望表为 null）：不对账 SHELLEXECUTEINFOW，照常绑定，cbSize 取实测值", async () => {
      const { driver, calls } = await ready({ pointerSize: 16, sizes: { SHELLEXECUTEINFOW: 77 } });
      expect(diagOf(driver)).toMatchObject({ bindFailures: [], shellExecute: "ShellExecuteExW" });
      await driver.openApp("notepad");
      expect(ffi(calls, "ShellExecuteExW")[0].args[0]).toMatchObject({ cbSize: 77 });
    });

    it("init 日志：降级时写明「退回 ShellExecuteW」，正常时没有这句", async () => {
      const normal = createFake();
      await normal.driver.init();
      expect(normal.logs[0]).not.toMatch(/ShellExecuteW|未绑定/);

      const degraded = createFake({ sizes: { SHELLEXECUTEINFOW: 100 } });
      await degraded.driver.init();
      expect(degraded.logs).toHaveLength(1);
      expect(degraded.logs[0]).toMatch(/1 个非核心函数未绑定：ShellExecuteExW；openApp 退回 ShellExecuteW（目标找不到时可能弹模态框）/);
    });
  });

  it("init 之前调用任何方法：UNSUPPORTED「尚未初始化」", async () => {
    const { driver } = createFake();
    const attempts: Array<[string, () => unknown]> = [
      ["mouseMove", () => driver.mouseMove(1, 1)],
      ["click", () => driver.click(1, 1)],
      ["drag", () => driver.drag({ x: 0, y: 0 }, { x: 1, y: 1 })],
      ["scroll", () => driver.scroll(0, 0, 0, 1)],
      ["keyCombo", () => driver.keyCombo({ mods: [], key: "a" })],
      ["typeText", () => driver.typeText("a")],
      ["isScreenLocked", () => driver.isScreenLocked()],
      ["isSecureDesktopActive", () => secureActive(driver)],
      ["idleSeconds", () => driver.idleSeconds()],
      ["getPrimaryDisplay", () => driver.getPrimaryDisplay()],
      ["frontmostApp", () => driver.frontmostApp()],
      ["listApps", () => driver.listApps()],
      ["openApp", () => driver.openApp("notepad")],
      ["wakeDisplay", () => driver.wakeDisplay()],
      ["lockScreen", () => driver.lockScreen()],
    ];
    for (const [name, run] of attempts) {
      const err = await catchError(run);
      expect(err, name).toMatchObject({ code: "UNSUPPORTED" });
      expect(err.message, name).toMatch(/尚未初始化/);
    }
  });
});

describe("import 模块没有副作用", () => {
  const driverUrl = path.resolve(import.meta.dirname, "../electron-app/desktop/drivers/win32.mjs");

  it("子进程里 import 驱动模块：只导出 createWin32Driver，require.cache 里没有 koffi", () => {
    const script = [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      "const mod = await import(process.argv[1]);",
      'console.log(JSON.stringify({ exports: Object.keys(mod), koffi: Object.keys(require.cache).filter((k) => k.includes("koffi")) }));',
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, driverUrl], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ exports: ["createWin32Driver"], koffi: [] });
  });

  it("源码里只有 init() 一处 createRequire 加载 koffi；defs 完全不引用 koffi 模块", () => {
    const driverSrc = stripComments(read("electron-app/desktop/drivers/win32.mjs"));
    expect(driverSrc).not.toMatch(/^import[^;]*koffi/m);
    expect(driverSrc.match(/["']koffi["']/g)).toHaveLength(1);
    expect(driverSrc).toMatch(/createRequire\(import\.meta\.url\)\("koffi"\)/);
    expect(stripComments(read("electron-app/desktop/drivers/win32-defs.mjs"))).not.toMatch(/["']koffi["']|\brequire\(|^import /m);
  });

  it("源码里没有任何子进程 / shell API（openApp 只走 ShellExecuteExW / ShellExecuteW），也不直接 console 输出", () => {
    for (const file of ["win32.mjs", "win32-defs.mjs"]) {
      const src = stripComments(read(`electron-app/desktop/drivers/${file}`));
      expect(src, file).not.toMatch(/child_process|\bspawn|execFile|execSync|\bexec\(|cmd(\.exe)?\s*\/c|powershell|\bstart\s+""/i);
      expect(src, file).not.toMatch(/console\./);
    }
  });

  it("开始菜单搜索只读目录名：fs 只引入 readdir（不读 / 不写 / 不改任何文件，也不看文件内容）", () => {
    const driverSrc = stripComments(read("electron-app/desktop/drivers/win32.mjs"));
    expect(driverSrc.match(/from "node:fs[^"]*"/g)).toEqual(['from "node:fs/promises"']);
    expect(driverSrc).toMatch(/^import \{ readdir \} from "node:fs\/promises";$/m);
    expect(driverSrc).not.toMatch(/readFile|writeFile|appendFile|unlink|rmdir|rename|copyFile|createReadStream|createWriteStream|mkdir|chmod|symlink|readlink|\blstat|\bstat\(|\brm\(/);
    expect(stripComments(read("electron-app/desktop/drivers/win32-defs.mjs"))).not.toMatch(/node:fs|readdir/);
  });
});

// ═══════════════════════════ 鼠标 ═══════════════════════════

describe("mouseMove", () => {
  it("只调 SetCursorPos，不发任何 SendInput", async () => {
    const { driver, calls } = await ready();
    driver.mouseMove(300, 400);
    expect(calls).toEqual([{ fn: "SetCursorPos", args: [300, 400] }]);
  });

  it("坐标四舍五入成整数；副屏在左 / 上方时允许负坐标", async () => {
    const { driver, calls } = await ready();
    driver.mouseMove(10.6, 20.4);
    driver.mouseMove(-1200, -30);
    expect(cursorMoves(calls)).toEqual([
      [11, 20],
      [-1200, -30],
    ]);
  });

  it.each([NaN, Infinity, -Infinity, "5", null, undefined, 2 ** 40])("非法坐标 %s → BAD_ARGS，且没有调用 Win32", async (bad) => {
    const { driver, calls } = await ready();
    expect(() => driver.mouseMove(bad as number, 1)).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(() => driver.mouseMove(1, bad as number)).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(calls).toEqual([]);
  });

  it("SetCursorPos 失败：中文错误里带坐标和 Win32 错误码，且错误码是紧跟着失败调用读的", async () => {
    const { driver, calls } = await ready({ impls: { SetCursorPos: () => 0 } });
    const err = await catchError(() => driver.mouseMove(5, 6));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toMatch(/移动鼠标到 \(5, 6\) 失败，Win32 错误码 5/);
    expect(names(calls)).toEqual(["SetCursorPos", "GetLastError"]);
  });
});

describe("click", () => {
  it("左键单击：SetCursorPos → 一次 SendInput [LEFTDOWN, LEFTUP]；事件不带 MOVE，cbSize=40", async () => {
    const { driver, calls } = await ready();
    await driver.click(100, 200);
    expect(names(calls)).toEqual(["SetCursorPos", "SendInput"]);
    expect(calls[0].args).toEqual([100, 200]);
    expect(calls[1].args[0]).toBe(2);
    expect(calls[1].args[2]).toBe(40);
    expect(events(calls).map((e) => [e.type, mi(e).dwFlags, mi(e).dx, mi(e).dy, mi(e).mouseData, mi(e).time, mi(e).dwExtraInfo])).toEqual([
      [0, 0x2, 0, 0, 0, 0, 0],
      [0, 0x4, 0, 0, 0, 0, 0],
    ]);
  });

  it.each([
    ["left", [0x2, 0x4]],
    ["right", [0x8, 0x10]],
    ["middle", [0x20, 0x40]],
  ] as const)("%s 键：按下 / 抬起标志", async (button, flags) => {
    const { driver, calls } = await ready();
    await driver.click(1, 2, { button });
    expect(events(calls).map((e) => mi(e).dwFlags)).toEqual(flags);
  });

  it("双击：光标只定位一次；两次 SendInput 之间 sleep 40ms。三击同理", async () => {
    const double = await ready();
    await double.driver.click(10, 20, { count: 2 });
    expect(names(double.calls)).toEqual(["SetCursorPos", "SendInput", "sleep", "SendInput"]);
    expect(double.sleeps).toEqual([40]);

    const triple = await ready();
    await triple.driver.click(10, 20, { count: 3 });
    expect(names(triple.calls)).toEqual(["SetCursorPos", "SendInput", "sleep", "SendInput", "sleep", "SendInput"]);
    expect(triple.sleeps).toEqual([40, 40]);
  });

  it("坐标取整、负坐标照常", async () => {
    const { driver, calls } = await ready();
    await driver.click(-1200.4, 300.6);
    expect(cursorMoves(calls)).toEqual([[-1200, 301]]);
  });

  it.each([
    ["count=0", { count: 0 }],
    ["count=4", { count: 4 }],
    ["count=1.5", { count: 1.5 }],
    ["count 是字符串", { count: "2" as unknown as number }],
    ["button 不认识", { button: "side" as unknown as "left" }],
    ["button 是原型链上的名字", { button: "constructor" as unknown as "left" }],
  ])("参数非法（%s）→ BAD_ARGS，且没有调用 Win32", async (_name, opts) => {
    const { driver, calls } = await ready();
    await expect(driver.click(1, 2, opts)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(calls).toEqual([]);
  });

  it("SendInput 只注入了「按下」：补发一个 LEFTUP，抛出的是原始错误", async () => {
    const { driver, calls } = await ready({ impls: { SendInput: () => 1 } }); // 永远只成功 1 个
    const err = await catchError(() => driver.click(1, 2));
    expect(err.message).toMatch(/Windows 拒绝了输入注入（要送出 2 个事件，只成功 1 个，Win32 错误码 5）/);
    expect(err.message).toMatch(/管理员身份/);
    expect(batches(calls).map((b) => b.map((e) => mi(e).dwFlags))).toEqual([[0x2, 0x4], [0x4]]);
  });

  it("多击中途失败：补发抬起后立刻停手，不再继续点", async () => {
    let n = 0;
    const { driver, calls } = await ready({ impls: { SendInput: (count: number) => (++n === 2 ? 1 : count) } });
    await expect(driver.click(1, 2, { count: 3 })).rejects.toThrow(/拒绝了输入注入/);
    expect(batches(calls)).toHaveLength(3); // 第 1 次成功、第 2 次失败、补发的 UP；没有第 3 次点击
  });

  it("SetCursorPos 失败：不发任何按键事件", async () => {
    const { driver, calls } = await ready({ impls: { SetCursorPos: () => 0 } });
    await expect(driver.click(1, 2)).rejects.toThrow(/移动鼠标到/);
    expect(ffi(calls, "SendInput")).toEqual([]);
  });

  it("koffi 自己抛的错也变成带中文上下文的 DesktopError，并保留 cause", async () => {
    const { driver } = await ready({
      impls: {
        SendInput: () => {
          throw new Error("Expected number, got string");
        },
      },
    });
    const err = await catchError(() => driver.click(1, 2));
    expect(err).toMatchObject({ name: "DesktopError", code: "INTERNAL" });
    expect(err.message).toMatch(/调用 Win32 SendInput 出错：Expected number, got string/);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
});

describe("drag", () => {
  const FROM = { x: 0, y: 0 };
  const TO = { x: 100, y: 50 };
  const midpoints = Array.from({ length: 9 }, (_, i) => [(i + 1) * 10, (i + 1) * 5]);

  it("序列：SetCursorPos(from) → DOWN → 9 个插值点 → SetCursorPos(to) → UP；每步前停顿，放手前再停一次", async () => {
    const { driver, calls, sleeps } = await ready();
    await driver.drag(FROM, TO);
    expect(names(calls)).toEqual([
      "SetCursorPos",
      "SendInput",
      ...Array.from({ length: 9 }, () => ["sleep", "SetCursorPos"]).flat(),
      "sleep",
      "SetCursorPos",
      "sleep",
      "SendInput",
    ]);
    expect(cursorMoves(calls)).toEqual([[0, 0], ...midpoints, [100, 50]]);
    expect(batches(calls).map((b) => b.map((e) => mi(e).dwFlags))).toEqual([[0x2], [0x4]]);
    expect(sleeps).toEqual(Array(11).fill(27)); // 默认 300ms 均分成 11 段
  });

  it("durationMs 决定停顿；0 = 不停；超大值夹到 10 秒", async () => {
    const slow = await ready();
    await slow.driver.drag(FROM, TO, { durationMs: 1100 });
    expect(slow.sleeps).toEqual(Array(11).fill(100));

    const instant = await ready();
    await instant.driver.drag(FROM, TO, { durationMs: 0 });
    expect(instant.sleeps).toEqual([]);
    expect(cursorMoves(instant.calls)).toHaveLength(11);

    const huge = await ready();
    await huge.driver.drag(FROM, TO, { durationMs: 1e9 });
    expect(huge.sleeps).toEqual(Array(11).fill(909));
  });

  it("右键拖拽用 RIGHTDOWN / RIGHTUP；事件都不带 MOVE", async () => {
    const { driver, calls } = await ready();
    await driver.drag(FROM, TO, { button: "right" });
    expect(events(calls).map((e) => mi(e).dwFlags)).toEqual([0x8, 0x10]);
  });

  it("起点 / 终点可以是负坐标（副屏在左侧）", async () => {
    const { driver, calls } = await ready();
    await driver.drag({ x: -1000, y: 500 }, { x: -200, y: 100 }, { durationMs: 0 });
    const moves = cursorMoves(calls);
    expect(moves[0]).toEqual([-1000, 500]);
    expect(moves.at(-1)).toEqual([-200, 100]);
  });

  it("中途某次 SetCursorPos 抛错：仍补发 UP（鼠标键不能卡住），抛出的是原始错误", async () => {
    let n = 0;
    const { driver, calls } = await ready({
      impls: {
        SetCursorPos: () => {
          if (++n === 5) throw new Error("boom");
          return 1;
        },
      },
    });
    const err = await catchError(() => driver.drag(FROM, TO));
    expect(err.message).toMatch(/调用 Win32 SetCursorPos 出错：boom/);
    expect(batches(calls).map((b) => b.map((e) => mi(e).dwFlags))).toEqual([[0x2], [0x4]]);
    expect(calls.at(-1)?.fn).toBe("SendInput"); // UP 是最后一个动作
  });

  it("到达终点那一步失败（SetCursorPos 返回 0）：同样补发 UP", async () => {
    let n = 0;
    const { driver, calls } = await ready({ impls: { SetCursorPos: () => (++n === 11 ? 0 : 1) } });
    await expect(driver.drag(FROM, TO)).rejects.toThrow(/移动鼠标到 \(100, 50\) 失败/);
    expect(batches(calls).map((b) => b.map((e) => mi(e).dwFlags))).toEqual([[0x2], [0x4]]);
  });

  it("DOWN 没注入成功：不再移动，但仍尝试 UP", async () => {
    let n = 0;
    const { driver, calls } = await ready({ impls: { SendInput: (count: number) => (++n === 1 ? 0 : count) } });
    await expect(driver.drag(FROM, TO)).rejects.toThrow(/拒绝了输入注入/);
    expect(names(calls)).toEqual(["SetCursorPos", "SendInput", "GetLastError", "SendInput"]);
  });

  it("UP 失败（前面都成功）：抛出 UP 的错误，不吞", async () => {
    let n = 0;
    const { driver } = await ready({ impls: { SendInput: (count: number) => (++n === 2 ? 0 : count) } });
    await expect(driver.drag(FROM, TO)).rejects.toThrow(/拒绝了输入注入/);
  });

  it("起点定位失败：没按下过，就不发 UP", async () => {
    const { driver, calls } = await ready({ impls: { SetCursorPos: () => 0 } });
    await expect(driver.drag(FROM, TO)).rejects.toThrow(/移动鼠标到/);
    expect(ffi(calls, "SendInput")).toEqual([]);
  });

  it.each([
    ["durationMs 负数", { durationMs: -1 }],
    ["durationMs NaN", { durationMs: NaN }],
    ["durationMs 字符串", { durationMs: "300" as unknown as number }],
    ["button 不认识", { button: "x" as unknown as "left" }],
  ])("参数非法（%s）→ BAD_ARGS，且没有调用 Win32", async (_name, opts) => {
    const { driver, calls } = await ready();
    await expect(driver.drag(FROM, TO, opts)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(calls).toEqual([]);
  });

  it("起点 / 终点缺失或不是数字 → BAD_ARGS", async () => {
    const { driver, calls } = await ready();
    await expect(driver.drag({ x: NaN, y: 0 }, TO)).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(driver.drag(FROM, undefined as unknown as typeof TO)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(calls).toEqual([]);
  });
});

describe("scroll", () => {
  // 2^32 − 120×N：负的滚动量按 DWORD 无符号位模式
  it.each([
    ["向下 3 格", 0, 3, [[0x800, 4294966936]]],
    ["向上 3 格", 0, -3, [[0x800, 360]]],
    ["向右 2 格", 2, 0, [[0x1000, 240]]],
    ["向左 2 格", -2, 0, [[0x1000, 4294967056]]],
    ["斜向：下 1 格 + 左 1 格（先竖后横，同一次 SendInput）", -1, 1, [[0x800, 4294967176], [0x1000, 4294967176]]],
    ["半格（四舍五入成 60）", 0, 0.5, [[0x800, 4294967236]]],
    ["上限 1000 格向下", 0, 1000, [[0x800, 4294847296]]],
  ])("%s", async (_name, dx, dy, expected) => {
    const { driver, calls } = await ready();
    driver.scroll(500, 400, dx, dy);
    expect(names(calls)).toEqual(["SetCursorPos", "SendInput"]); // 先定位光标，再一次 SendInput
    expect(calls[0].args).toEqual([500, 400]);
    expect(batches(calls)).toHaveLength(1);
    expect(events(calls).map((e) => [mi(e).dwFlags, mi(e).mouseData])).toEqual(expected);
    for (const e of events(calls)) {
      expect([e.type, mi(e).dx, mi(e).dy]).toEqual([0, 0, 0]);
      expect(mi(e).dwFlags & 0x1).toBe(0); // 不带 MOVE
      expect(Number.isInteger(mi(e).mouseData) && mi(e).mouseData >= 0 && mi(e).mouseData <= 0xffffffff).toBe(true);
    }
  });

  it.each([
    ["dx、dy 都是 0", 0, 0],
    ["滚动量四舍五入后为 0", 0, 0.001],
    ["超过 1000 格", 0, 1001],
    ["dy 是 NaN", 0, NaN],
    ["dx 是 Infinity", Infinity, 1],
  ])("%s → BAD_ARGS，且没有调用 Win32", async (_name, dx, dy) => {
    const { driver, calls } = await ready();
    expect(() => driver.scroll(1, 2, dx, dy)).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(calls).toEqual([]);
  });

  it("光标定位失败：不发滚轮事件", async () => {
    const { driver, calls } = await ready({ impls: { SetCursorPos: () => 0 } });
    expect(() => driver.scroll(1, 2, 0, 1)).toThrow(/移动鼠标到/);
    expect(ffi(calls, "SendInput")).toEqual([]);
  });
});

// ═══════════════════════════ 键盘 ═══════════════════════════

describe("keyCombo", () => {
  const press = async (mods: Mods, key: string) => {
    const fake = await ready();
    fake.driver.keyCombo({ mods, key });
    return fake;
  };

  it("ctrl+shift+t：一次 SendInput，修饰键按下 → 主键按下抬起 → 修饰键倒序抬起", async () => {
    const { calls } = await press(["ctrl", "shift"], "t");
    expect(names(calls)).toEqual(["MapVirtualKeyW", "MapVirtualKeyW", "MapVirtualKeyW", "SendInput"]);
    expect(batches(calls)).toHaveLength(1);
    expect(traceKeys(events(calls))).toEqual(["↓11", "↓10", "↓54", "↑54", "↑10", "↑11"]);
    expect(ffi(calls, "SendInput")[0].args[0]).toBe(6);
    expect(ffi(calls, "SendInput")[0].args[2]).toBe(40);
  });

  it("无论传入顺序，修饰键都按 ctrl→alt→shift→meta 按下、倒序抬起；Win 键是扩展键", async () => {
    const { calls } = await press(["meta", "shift", "alt", "ctrl"], "a");
    expect(traceKeys(events(calls))).toEqual(["↓11", "↓12", "↓10", "↓5b*", "↓41", "↑41", "↑5b*", "↑10", "↑12", "↑11"]);
  });

  it("重复的修饰键只按一次；没有修饰键时就是主键的按下 / 抬起", async () => {
    expect(traceKeys(events((await press(["ctrl", "ctrl"], "c")).calls))).toEqual(["↓11", "↓43", "↑43", "↑11"]);
    expect(traceKeys(events((await press([], "enter")).calls))).toEqual(["↓d", "↑d"]);
  });

  it("所有事件：type=KEYBOARD、time=0、dwExtraInfo=0，且不带 SCANCODE / UNICODE 标志", async () => {
    const { calls } = await press(["ctrl", "alt"], "delete");
    for (const e of events(calls)) {
      expect(e.type).toBe(1);
      expect([ki(e).time, ki(e).dwExtraInfo]).toEqual([0, 0]);
      expect(ki(e).dwFlags & (0x8 | 0x4)).toBe(0);
    }
  });

  it("扩展键（delete / 方向键 / home / end / pageup / pagedown）带 EXTENDEDKEY：按下 =1，抬起 =3", async () => {
    for (const key of ["delete", "left", "up", "right", "down", "home", "end", "pageup", "pagedown"]) {
      const evs = events((await press([], key)).calls);
      expect(evs.map((e) => ki(e).dwFlags), key).toEqual([0x1, 0x3]);
    }
    // 对照：普通键不带
    expect(events((await press([], "a")).calls).map((e) => ki(e).dwFlags)).toEqual([0, 0x2]);
  });

  it("alt+delete：Alt 不是扩展键，Delete 是", async () => {
    const { calls } = await press(["alt"], "delete");
    expect(traceKeys(events(calls))).toEqual(["↓12", "↓2e*", "↑2e*", "↑12"]);
  });

  it("plus 自动补 shift；已经有 shift 就不重复；= 不补", async () => {
    expect(traceKeys(events((await press(["ctrl"], "plus")).calls))).toEqual(["↓11", "↓10", "↓bb", "↑bb", "↑10", "↑11"]);
    expect(traceKeys(events((await press(["shift"], "plus")).calls))).toEqual(["↓10", "↓bb", "↑bb", "↑10"]);
    expect(traceKeys(events((await press([], "plus")).calls))).toEqual(["↓10", "↓bb", "↑bb", "↑10"]);
    expect(traceKeys(events((await press(["alt", "meta"], "plus")).calls))).toEqual(["↓12", "↓10", "↓5b*", "↓bb", "↑bb", "↑5b*", "↑10", "↑12"]);
    expect(traceKeys(events((await press([], "=")).calls))).toEqual(["↓bb", "↑bb"]);
    expect(traceKeys(events((await press(["ctrl"], "minus")).calls))).toEqual(["↓11", "↓bd", "↑bd", "↑11"]);
  });

  it("每个事件的 wScan = MapVirtualKeyW(vk, 0)（夹具里它返回 vk+0x100）", async () => {
    const { calls } = await press(["ctrl", "shift"], "t");
    for (const e of events(calls)) expect(ki(e).wScan).toBe(ki(e).wVk + 0x100);
    for (const c of ffi(calls, "MapVirtualKeyW")) expect(c.args[1]).toBe(0);
  });

  it("MapVirtualKeyW 绑不上或抛错：wScan 退回 0，按键照发", async () => {
    const missing = await ready({ missing: ["MapVirtualKeyW"] });
    missing.driver.keyCombo({ mods: ["ctrl"], key: "c" });
    expect(events(missing.calls).map((e) => ki(e).wScan)).toEqual([0, 0, 0, 0]);

    const throwing = await ready({
      impls: {
        MapVirtualKeyW: () => {
          throw new Error("boom");
        },
      },
    });
    throwing.driver.keyCombo({ mods: [], key: "a" });
    expect(traceKeys(events(throwing.calls))).toEqual(["↓41", "↑41"]);
  });

  it("CANONICAL_KEYS 里的每个键都能发出去：主键按下 + 抬起，键码与映射表一致", async () => {
    const { driver, calls } = await ready();
    for (const key of CANONICAL_KEYS) {
      calls.length = 0;
      driver.keyCombo({ mods: [], key });
      const entry = lookupKey(key);
      const evs = events(calls);
      const main = evs.filter((e) => ki(e).wVk === entry?.vk);
      expect(main.map((e) => ki(e).dwFlags & 0x2), key).toEqual([0, 0x2]);
      // 只有 plus 会多出 shift 的一对事件
      expect(evs.length, key).toBe(key === "plus" ? 4 : 2);
    }
  });

  it("SendInput 只注入了一部分：抛错，并补发一次「全部抬起」（主键 + 修饰键倒序）", async () => {
    let n = 0;
    const { driver, calls } = await ready({ impls: { SendInput: (count: number) => (++n === 1 ? 2 : count) } });
    expect(() => driver.keyCombo({ mods: ["ctrl", "shift"], key: "t" })).toThrow(/要送出 6 个事件，只成功 2 个/);
    expect(traceKeys(batches(calls)[1])).toEqual(["↑54", "↑10", "↑11"]);
  });

  it("补发抬起也失败：不覆盖原始错误", async () => {
    let n = 0;
    const { driver } = await ready({ impls: { SendInput: () => (++n === 1 ? 2 : 0) } }); // 第一次只成功 2 个，补发的那次一个都不成功
    expect(() => driver.keyCombo({ mods: ["ctrl"], key: "c" })).toThrow(/要送出 4 个事件，只成功 2 个/);
  });

  it.each([
    ["不认识的键", { mods: [], key: "nonexistent" }],
    ["原型链上的名字", { mods: [], key: "constructor" }],
    ["不认识的修饰键", { mods: ["hyper" as unknown as "ctrl"], key: "a" }],
    ["mods 不是数组", { mods: "ctrl" as unknown as Mods, key: "a" }],
    ["缺 key", { mods: ["ctrl"] } as unknown as { mods: Mods; key: string }],
  ])("%s → BAD_ARGS，且没有调用 SendInput", async (_name, combo) => {
    const { driver, calls } = await ready();
    expect(() => driver.keyCombo(combo)).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(ffi(calls, "SendInput")).toEqual([]);
  });
});

describe("typeText", () => {
  const type = async (text: string, options: FakeOptions = {}) => {
    const fake = await ready(options);
    await fake.driver.typeText(text);
    return fake;
  };

  it("ASCII：每个字符一对 UNICODE 按下 / 抬起（wVk=0，wScan=字符码，flags 4 / 6）", async () => {
    const { calls } = await type("ab");
    expect(batches(calls)).toHaveLength(1);
    expect(events(calls).map((e) => [e.type, ki(e).wVk, ki(e).wScan, ki(e).dwFlags, ki(e).time, ki(e).dwExtraInfo])).toEqual([
      [1, 0, 0x61, 0x4, 0, 0],
      [1, 0, 0x61, 0x6, 0, 0],
      [1, 0, 0x62, 0x4, 0, 0],
      [1, 0, 0x62, 0x6, 0, 0],
    ]);
    expect(ffi(calls, "SendInput")[0].args[2]).toBe(40);
  });

  it("中文按 UTF-16 code unit 发；不碰 MapVirtualKeyW（Unicode 事件的 wScan 就是字符本身）", async () => {
    const { calls } = await type("中文");
    expect(traceKeys(events(calls))).toEqual(["↓U+4E2D", "↑U+4E2D", "↓U+6587", "↑U+6587"]);
    expect(ffi(calls, "MapVirtualKeyW")).toEqual([]);
  });

  it("surrogate pair（emoji）= 两个连续 code unit，各自按下 + 抬起，不拆批", async () => {
    const { calls } = await type("😀");
    expect(traceKeys(events(calls))).toEqual(["↓U+D83D", "↑U+D83D", "↓U+DE00", "↑U+DE00"]);
    expect(batches(calls)).toHaveLength(1);
  });

  it("孤立的 surrogate 也原样输入，不报错", async () => {
    const { calls } = await type("\uD83D");
    expect(traceKeys(events(calls))).toEqual(["↓U+D83D", "↑U+D83D"]);
  });

  it("换行 → VK_RETURN 普通键事件（不是 UNICODE）：\\n、\\r\\n（算一个）、孤立 \\r", async () => {
    const lf = await type("a\nb");
    expect(traceKeys(events(lf.calls))).toEqual(["↓U+61", "↑U+61", "↓d", "↑d", "↓U+62", "↑U+62"]);
    expect(events(lf.calls).slice(2, 4).map((e) => [ki(e).wVk, ki(e).wScan, ki(e).dwFlags])).toEqual([
      [0x0d, 0x10d, 0],
      [0x0d, 0x10d, 0x2],
    ]);

    expect(traceKeys(events((await type("a\r\nb")).calls))).toEqual(traceKeys(events(lf.calls)));
    expect(traceKeys(events((await type("a\rb")).calls))).toEqual(traceKeys(events(lf.calls)));
    expect(traceKeys(events((await type("\n\r")).calls))).toEqual(["↓d", "↑d", "↓d", "↑d"]);
    expect(traceKeys(events((await type("\r\n\r\n")).calls))).toEqual(["↓d", "↑d", "↓d", "↑d"]);
  });

  it("\\t → VK_TAB 普通键事件", async () => {
    const { calls } = await type("a\tb");
    expect(traceKeys(events(calls))).toEqual(["↓U+61", "↑U+61", "↓9", "↑9", "↓U+62", "↑U+62"]);
  });

  it.each([
    ["40 个字符 = 1 批（80 个事件），不停顿", 40, [80], 0],
    ["41 个字符 = 2 批，批间停 5ms", 41, [80, 2], 1],
    ["80 个字符 = 2 批", 80, [80, 80], 1],
    ["81 个字符 = 3 批，停 2 次", 81, [80, 80, 2], 2],
  ])("分批：%s", async (_name, count, sizes, gaps) => {
    const { calls, sleeps } = await type("a".repeat(count));
    expect(batches(calls).map((b) => b.length)).toEqual(sizes);
    expect(sleeps).toEqual(Array(gaps).fill(5));
    // 停顿只在批与批之间：最后一批之后没有 sleep
    expect(names(calls).at(-1)).toBe("SendInput");
  });

  it("分批边界不拆 surrogate pair：39 个字符 + emoji → 78 个事件 + 4 个事件；38 个 + emoji 恰好 40 单位同一批", async () => {
    const split = await type(`${"a".repeat(39)}😀`);
    expect(batches(split.calls).map((b) => b.length)).toEqual([78, 4]);
    expect(traceKeys(batches(split.calls)[1])).toEqual(["↓U+D83D", "↑U+D83D", "↓U+DE00", "↑U+DE00"]);

    const fit = await type(`${"a".repeat(38)}😀`);
    expect(batches(fit.calls).map((b) => b.length)).toEqual([80]);
  });

  it("换行也算一个输入单位：41 个换行 = 2 批", async () => {
    const { calls } = await type("\n".repeat(41));
    expect(batches(calls).map((b) => b.length)).toEqual([80, 2]);
  });

  it("空字符串：什么都不发、不停顿", async () => {
    const { calls } = await type("");
    expect(calls).toEqual([]);
  });

  it("单次上限 20000 个字符：正好 20000 可以（500 批），20001 → BAD_ARGS 且一个事件都没发", async () => {
    const ok = await type("a".repeat(20000));
    expect(batches(ok.calls)).toHaveLength(500);
    expect(ok.sleeps).toHaveLength(499);

    const { driver, calls } = await ready();
    await expect(driver.typeText("a".repeat(20001))).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(calls).toEqual([]);
  });

  it.each(["\u0000", "\u0008", "\u001b", "\u007f"])("无法输入的控制字符 %j → BAD_ARGS；先整体检查，所以前面的字符也不会发出去", async (ch) => {
    const { driver, calls } = await ready();
    await expect(driver.typeText(`abc${ch}def`)).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/第 4 个字符/) });
    expect(calls).toEqual([]);
  });

  it("text 不是字符串 → BAD_ARGS", async () => {
    const { driver } = await ready();
    await expect(driver.typeText(123 as unknown as string)).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(driver.typeText(undefined as unknown as string)).rejects.toMatchObject({ code: "BAD_ARGS" });
  });

  it("中途某一批被拒绝：立刻停止，不继续发后面的批；只补发那一批的「抬起」（第三轮评审：SendInput 可能只注入了前一部分，键会卡在按下）", async () => {
    let n = 0;
    const { driver, calls } = await ready({ impls: { SendInput: (count: number) => (++n === 2 ? 0 : count) } });
    await expect(driver.typeText("a".repeat(100))).rejects.toThrow(/拒绝了输入注入/);
    // 第 1 批送出、第 2 批被拒、第 3 次调用 = 补发的抬起；第三批（100 个字符 = 3 批）没有再发
    expect(batches(calls).map((b) => b.length)).toEqual([80, 80, 40]);
    const compensation = batches(calls)[2];
    expect(traceKeys(compensation)).toEqual(Array(40).fill("↑U+61"));
    expect(compensation.every((e) => (ki(e).dwFlags & 0x2) === 0x2)).toBe(true); // 全是 KEYUP，没有任何「按下」
  });

  it("补发的抬起也覆盖普通键（换行 → Enter、制表符 → Tab）：它们才是卡住会连发的那种", async () => {
    let n = 0;
    const { driver, calls } = await ready({ impls: { SendInput: (count: number) => (++n === 1 ? 0 : count) } });
    await expect(driver.typeText("a\nb\tc")).rejects.toThrow(/拒绝了输入注入/);
    expect(traceKeys(batches(calls)[1])).toEqual(["↑U+61", "↑d", "↑U+62", "↑9", "↑U+63"]);
  });

  it("补发也被拒（UIPI 之类连抬起都不让送）：照样抛出原来的错误，不被补发的错误盖住，也不再重试", async () => {
    const { driver, calls } = await ready({ impls: { SendInput: () => 0 } });
    const err = await catchError(() => driver.typeText("hello"));
    expect(err.message).toMatch(/拒绝了输入注入/);
    expect(ffi(calls, "SendInput")).toHaveLength(2); // 原来的一次 + 补发的一次
  });

  it("补发的抬起走 quiet：错误和 diagnostics 里没有文本，也没有事件数", async () => {
    let n = 0;
    const { driver } = await ready({ impls: { SendInput: (count: number) => (++n === 1 ? 0 : count) } });
    const err = await catchError(() => driver.typeText("密码P@ss"));
    expect(err.message).not.toMatch(/密码|P@ss/);
    expect(err.message).not.toMatch(/\d+ 个事件/);
  });

  it("shouldStop：每批开头问一次；一旦 true 就收手（不抛错），后面的批不再发", async () => {
    let asked = 0;
    const { driver, calls } = await ready();
    // 100 个字符 = 3 批（40 + 40 + 20 个字符）：第 1、2 批放行，第 3 批开头喊停
    await expect(
      driver.typeText("a".repeat(100), {
        shouldStop: () => {
          asked += 1;
          return asked >= 3;
        },
      }),
    ).resolves.toBeUndefined();
    expect(asked).toBe(3);
    expect(batches(calls).map((b) => b.length)).toEqual([80, 80]);
  });

  it("shouldStop 一开始就是 true：一个事件都不发", async () => {
    const { driver, calls } = await ready();
    await driver.typeText("hello", { shouldStop: () => true });
    expect(calls).toEqual([]);
  });

  it("shouldStop 在「批间停顿」之后才问：停顿期间会话结束了，下一批不再发（先问再停顿会多打一批）", async () => {
    const { driver, calls } = await ready();
    // 「停顿期间会话被结束」：停顿一发生，shouldStop 就变成 true
    await driver.typeText("a".repeat(100), { shouldStop: () => calls.some((c) => c.fn === "sleep") });
    expect(batches(calls).map((b) => b.length)).toEqual([80]); // 只有第 1 批；第 2 批开头（停顿之后）被拦下
  });

  it("没传 shouldStop / 传的不是函数：行为不变（兼容旧调用方）", async () => {
    const plain = await type("a".repeat(41));
    expect(batches(plain.calls).map((b) => b.length)).toEqual([80, 2]);
    const { driver, calls } = await ready();
    await driver.typeText("a".repeat(41), { shouldStop: "yes" as unknown as () => boolean });
    expect(batches(calls).map((b) => b.length)).toEqual([80, 2]);
  });

  // 第四轮评审 C1：会话层只在「动作开始前」「回车前」各看一眼（guard），中间靠 0.3 秒一轮的看门狗，而且看门狗只看锁屏、不看 UAC 安全桌面；
  // 一次 desktop_type 最多 5000 个字、不到一秒就发完。所以驱动自己在每一批发出之前复查输入桌面：不是 Default 就停手、抛错。
  // ⚠️ 这里只能验证「复查发生在哪、查到了怎么办」；锁屏 / UAC 期间真实的 SendInput 会不会被系统拒绝、桌面切换的实际延迟，都要真机（未验证）。
  describe("每批发出之前复查输入桌面（第四轮评审 C1）", () => {
    /** 第 n 次 SendInput（从 1 数）成功之后，桌面立刻变成 change 描述的样子；之前的批照常成功 */
    const switchAfterSend = (n: number, change: Partial<FakeOptions>): FakeOptions => {
      let sent = 0;
      const options: FakeOptions = {
        impls: {
          SendInput: (count: number) => {
            sent += 1;
            if (sent === n) Object.assign(options, change);
            return count;
          },
        },
      };
      return options;
    };
    /** Win+L：Winlogon 桌面 + 会话已锁定 */
    const LOCKED: Partial<FakeOptions> = { desktopName: "Winlogon", sessionFlags: 0 };
    /** UAC 权限确认：输入桌面打不开（Winlogon 安全桌面）+ 会话没锁 */
    const UAC: Partial<FakeOptions> = { desktopName: null, sessionFlags: 1 };
    /** 100 个字符 = 3 批（40 + 40 + 20） */
    const HUNDRED = "a".repeat(100);

    it("中途锁屏（Win+L）：下一批一个事件都不发，抛 SESSION_EXPIRED；已送出的批不补抬起（批间没有悬空的键）", async () => {
      const { driver, calls } = await ready(switchAfterSend(1, LOCKED));
      await expect(driver.typeText(HUNDRED)).rejects.toMatchObject({ name: "DesktopError", code: "SESSION_EXPIRED", message: expect.stringMatching(/被锁屏/) });
      // 只有第 1 批（80 个事件）：第 2 批被拦在发送之前；也没有第二次 SendInput 去「补抬起」
      expect(batches(calls).map((b) => b.length)).toEqual([80]);
    });

    it("中途弹出 UAC（会话没锁的安全桌面）：同样停手，抛 SECURE_DESKTOP——看门狗不看安全桌面，输入阶段只有这一道拦截", async () => {
      const { driver, calls } = await ready(switchAfterSend(1, UAC));
      await expect(driver.typeText(HUNDRED)).rejects.toMatchObject({ name: "DesktopError", code: "SECURE_DESKTOP", message: expect.stringMatching(/安全提示/) });
      expect(batches(calls).map((b) => b.length)).toEqual([80]);
    });

    it("切换发生在第 2 批之后：前面已发的两批保留，第 3 批不发", async () => {
      const { driver, calls } = await ready(switchAfterSend(2, LOCKED));
      await expect(driver.typeText(HUNDRED)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
      expect(batches(calls).map((b) => b.length)).toEqual([80, 80]);
    });

    it("第一批发出之前就已经不是 Default：一个事件都不发（驱动被单独调用、或上层 guard 之后又切了桌面，一样拦得住）", async () => {
      for (const [change, code] of [
        [LOCKED, "SESSION_EXPIRED"],
        [UAC, "SECURE_DESKTOP"],
      ] as const) {
        const { driver, calls } = await ready(change);
        await expect(driver.typeText("hello")).rejects.toMatchObject({ code });
        expect(ffi(calls, "SendInput"), code).toEqual([]);
      }
    });

    it("每批各复查一次、紧贴发送（批间停顿 → 复查 → SendInput）；Default 桌面上复查只有 OpenInputDesktop / 读名字 / CloseDesktop，不碰会话相关的函数", async () => {
      const { driver, calls } = await ready();
      await driver.typeText("a".repeat(81)); // 3 批
      const trace = names(calls);
      expect(trace.filter((n) => n === "OpenInputDesktop")).toHaveLength(3);
      expect(trace.filter((n) => n === "CloseDesktop")).toHaveLength(3); // 每次打开的桌面句柄都关
      expect(trace.filter((n) => ["ProcessIdToSessionId", "WTSQuerySessionInformationW", "koffi.decode", "WTSFreeMemory"].includes(n))).toEqual([]);
      expect(trace.filter((n) => ["sleep", "OpenInputDesktop", "SendInput"].includes(n))).toEqual([
        "OpenInputDesktop",
        "SendInput",
        "sleep",
        "OpenInputDesktop",
        "SendInput",
        "sleep",
        "OpenInputDesktop",
        "SendInput",
      ]);
    });

    it("读不到输入桌面（读桌面名失败）：不当成失败，照常打完——只认「读到了别的桌面」，和看门狗同口径", async () => {
      const { driver, calls } = await ready({ impls: { GetUserObjectInformationW: () => 0 } });
      await driver.typeText(HUNDRED);
      expect(batches(calls).map((b) => b.length)).toEqual([80, 80, 40]);
    });

    it("会话已在收尾（shouldStop 为 true）时优先静默收手：哪怕桌面已经是锁屏，也不抛错、不碰任何系统函数（收尾是会话自己的事）", async () => {
      const { driver, calls } = await ready(LOCKED);
      await expect(driver.typeText("hello", { shouldStop: () => true })).resolves.toBeUndefined();
      expect(calls).toEqual([]);
    });

    it("中断的错误里没有文本，也没有字数 / 事件数；没有 cause；没有日志（那段文字可能就是密码）", async () => {
      const SECRET = "密码P@ss-7391🔑";
      for (const change of [LOCKED, UAC]) {
        const { driver, logs } = await ready(switchAfterSend(1, change));
        const err = await catchError(() => driver.typeText(SECRET.repeat(10))); // 130 个 code unit = 4 批
        expect(err).toMatchObject({ name: "DesktopError" });
        const surface = [err.message, String((err as { cause?: unknown }).cause ?? ""), err.stack ?? "", JSON.stringify(err, Object.getOwnPropertyNames(err))].join("\n");
        for (const piece of ["密码", "P@ss", "7391", "🔑"]) expect(surface, `泄露了「${piece}」`).not.toContain(piece);
        expect(err.message).not.toMatch(/\d+ 个(字符|字|事件)/);
        expect((err as { cause?: unknown }).cause).toBeUndefined();
        expect(logs).toEqual([]);
      }
    });
  });
});

// ═══════════════════════════ 隐私：typeText 的文本不外泄 ═══════════════════════════

describe("typeText 的文本绝不出现在日志 / 错误 / diagnostics 里", () => {
  const SECRET = "密码P@ss-7391🔑";
  const FRAGMENTS = ["密码", "P@ss", "7391", "🔑"];
  const expectNoLeak = (haystack: string, where: string) => {
    for (const piece of FRAGMENTS) expect(haystack, `${where} 泄露了「${piece}」`).not.toContain(piece);
  };
  /** 错误的全部可见面：message + cause + stack + 所有自有属性 */
  const surface = (err: Error) => [err.message, String((err as { cause?: unknown }).cause ?? ""), err.stack ?? "", JSON.stringify(err, Object.getOwnPropertyNames(err))].join("\n");

  it("成功路径：没有任何日志，diagnostics 里也没有", async () => {
    const { driver, logs } = await ready();
    await driver.typeText(SECRET);
    expect(logs).toEqual([]);
    expectNoLeak(JSON.stringify(driver.diagnostics()), "diagnostics");
  });

  it("SendInput 被拒绝：错误里没有文本，连事件数（≈长度）都没有；没有 cause；没有日志", async () => {
    const { driver, logs } = await ready({ impls: { SendInput: () => 0 } });
    const err = await catchError(() => driver.typeText(SECRET.repeat(5)));
    expect(err.message).toMatch(/Windows 拒绝了输入注入（Win32 错误码 5）/);
    expect(err.message).not.toMatch(/\d+ 个事件/);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expectNoLeak(surface(err), "错误");
    expect(logs).toEqual([]);
  });

  it("koffi 抛的底层错误带着文本片段：typeText 的错误把它丢掉，不挂 cause", async () => {
    const { driver, logs } = await ready({
      impls: {
        SendInput: () => {
          throw new Error(`Unexpected value ${SECRET}`);
        },
      },
    });
    const err = await catchError(() => driver.typeText(SECRET));
    expect(err).toMatchObject({ name: "DesktopError", code: "INTERNAL" });
    expect(err.message).toBe("调用 Win32 SendInput 出错");
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expectNoLeak(surface(err), "错误");
    expect(logs).toEqual([]);
  });

  it("参数校验类错误（超长 / 控制字符）同样不回显文本", async () => {
    const { driver } = await ready();
    expectNoLeak(surface(await catchError(() => driver.typeText(`${SECRET}\u0000`))), "控制字符错误");
    expectNoLeak(surface(await catchError(() => driver.typeText("密".repeat(20001)))), "超长错误");
    expect((await catchError(() => driver.typeText("密".repeat(20001)))).message).not.toContain("密");
  });

  it("对照：非敏感的 click 错误会带上 koffi 的原始信息（quiet 只是 typeText 专属）", async () => {
    const { driver } = await ready({
      impls: {
        SendInput: () => {
          throw new Error("diagnostic-detail-xyz");
        },
      },
    });
    expect((await catchError(() => driver.click(1, 2))).message).toContain("diagnostic-detail-xyz");
  });
});

// ═══════════════════════════ 屏幕 / 输入桌面 / 空闲 ═══════════════════════════

describe("isScreenLocked", () => {
  it("OpenInputDesktop 打不开（返回 NULL）且会话已锁定 → true；没有句柄，就没有 CloseDesktop；查完会话锁定标志一定释放", async () => {
    const { driver, calls } = await ready({ desktopName: null, sessionFlags: 0 });
    expect(driver.isScreenLocked()).toBe(true);
    // 访问掩码 0x101 = DESKTOP_READOBJECTS(0x1) | DESKTOP_SWITCHDESKTOP(0x100)：只申请 0x100 的话，读桌面名要不要 READOBJECTS 没在真机上验证过
    expect(calls[0]).toEqual({ fn: "OpenInputDesktop", args: [0, 0, 0x101] });
    expect(names(calls)).toEqual(["OpenInputDesktop", "ProcessIdToSessionId", "WTSQuerySessionInformationW", "koffi.decode", "WTSFreeMemory"]);
  });

  it.each(["Default", "default", "DEFAULT"])("桌面名 %s → false（不分大小写），参数按 Win32 约定传，句柄关闭", async (name) => {
    const { driver, calls } = await ready({ desktopName: name });
    expect(driver.isScreenLocked()).toBe(false);
    expect(names(calls)).toEqual(["OpenInputDesktop", "GetUserObjectInformationW", "CloseDesktop"]);
    const [, read, close] = calls;
    expect(read.args[0]).toBe(H(0x7000));
    expect(read.args[1]).toBe(2); // UOI_NAME
    expect(Buffer.isBuffer(read.args[2])).toBe(true);
    expect(read.args[3]).toBe((read.args[2] as Buffer).length);
    expect(read.args[4]).toEqual([expect.any(Number)]);
    expect(close.args).toEqual([H(0x7000)]);
  });

  it("桌面名 Winlogon 且会话已锁定 → true（锁屏），句柄关闭", async () => {
    const { driver, calls } = await ready({ desktopName: "Winlogon", sessionFlags: 0 });
    expect(driver.isScreenLocked()).toBe(true);
    expect(names(calls)).toContain("CloseDesktop");
    expect(names(calls).indexOf("CloseDesktop")).toBeLessThan(names(calls).indexOf("WTSQuerySessionInformationW")); // 先关桌面句柄，再查会话标志
  });

  it.each(["Screen-saver", "Disconnect"])("桌面名 %s → true（屏保 / 断开：保持老行为，一律当锁屏），句柄关闭；不去查会话标志", async (name) => {
    const { driver, calls } = await ready({ desktopName: name });
    expect(driver.isScreenLocked()).toBe(true);
    expect(names(calls)).toEqual(["OpenInputDesktop", "GetUserObjectInformationW", "CloseDesktop"]);
  });

  it("读不到桌面名（GetUserObjectInformationW 返回 0）→ null，仍然 CloseDesktop", async () => {
    const { driver, calls } = await ready({ impls: { GetUserObjectInformationW: () => 0 } });
    expect(driver.isScreenLocked()).toBeNull();
    expect(names(calls)).toEqual(["OpenInputDesktop", "GetUserObjectInformationW", "CloseDesktop"]);
  });

  it("读桌面名时抛异常 → null，仍然 CloseDesktop", async () => {
    const { driver, calls } = await ready({
      impls: {
        GetUserObjectInformationW: () => {
          throw new Error("boom");
        },
      },
    });
    expect(driver.isScreenLocked()).toBeNull();
    expect(names(calls).at(-1)).toBe("CloseDesktop");
  });

  it("GetUserObjectInformationW 绑不上：null，仍然 CloseDesktop", async () => {
    const { driver, calls } = await ready({ missing: ["GetUserObjectInformationW"] });
    expect(driver.isScreenLocked()).toBeNull();
    expect(names(calls)).toEqual(["OpenInputDesktop", "CloseDesktop"]);
  });

  it("CloseDesktop 自己抛错：不影响结果", async () => {
    const { driver } = await ready({
      impls: {
        CloseDesktop: () => {
          throw new Error("boom");
        },
      },
    });
    expect(driver.isScreenLocked()).toBe(false);
  });

  it("OpenInputDesktop 抛异常 → null（不抛）", async () => {
    const { driver } = await ready({
      impls: {
        OpenInputDesktop: () => {
          throw new Error("boom");
        },
      },
    });
    expect(driver.isScreenLocked()).toBeNull();
  });
});

// ═══════════════════════════ 锁屏 vs UAC 安全桌面 ═══════════════════════════
// 锁屏和 UAC 权限确认都在 Winlogon 安全桌面上：OpenInputDesktop 都被拒、桌面名都是 Winlogon。
// 把 UAC 当锁屏的后果很严重——解锁流程（尤其 Windows 的系统级解锁）会往里输开机密码再回车，而 UAC 上回车默认就是「是」。
// 所以驱动用会话锁定标志把两者分开：明确「没锁」才算安全桌面；读不到 / 对不上一律当锁屏（老行为，保守）。

describe("锁屏 vs UAC 安全桌面（会话锁定标志）", () => {
  const WTS_CALLS = ["ProcessIdToSessionId", "WTSQuerySessionInformationW", "koffi.decode", "WTSFreeMemory"];
  const wtsCalls = (calls: Call[]) => names(calls).filter((n) => WTS_CALLS.includes(n));

  /** 三种「Winlogon 安全桌面」的表现：OpenInputDesktop 被拒 / 读到名字 Winlogon / 大小写不同的 winlogon */
  const WINLOGON: Array<[string, FakeOptions]> = [
    ["OpenInputDesktop 被拒", { desktopName: null }],
    ["桌面名 Winlogon", { desktopName: "Winlogon" }],
    ["桌面名 winlogon（不分大小写）", { desktopName: "winlogon" }],
  ];

  it.each(WINLOGON)("%s + 会话没锁 → 是安全桌面（UAC 之类）：isSecureDesktopActive=true，isScreenLocked=false", async (_label, base) => {
    const { driver } = await ready({ ...base, sessionFlags: 1 });
    expect(secureActive(driver)).toBe(true);
    expect(driver.isScreenLocked()).toBe(false);
  });

  it.each(WINLOGON)("%s + 会话已锁定 → 是锁屏：isScreenLocked=true，isSecureDesktopActive=false", async (_label, base) => {
    const { driver } = await ready({ ...base, sessionFlags: 0 });
    expect(driver.isScreenLocked()).toBe(true);
    expect(secureActive(driver)).toBe(false);
  });

  it.each(WINLOGON)("%s + 标志读不到 / 未知 / 没见过的值 → 保守当锁屏（老行为）：绝不判成安全桌面", async (_label, base) => {
    for (const flags of [null, 0xffffffff, 2, 7, 0x80000000]) {
      const { driver } = await ready({ ...base, sessionFlags: flags });
      expect(secureActive(driver), `flags=${String(flags)}`).toBe(false);
      expect(driver.isScreenLocked(), `flags=${String(flags)}`).toBe(true);
    }
  });

  it("普通桌面（Default）：既不是锁屏也不是安全桌面；一个会话相关的函数都不碰（平时不付额外代价）", async () => {
    for (const flags of [0, 1, null]) {
      const { driver, calls } = await ready({ desktopName: "Default", sessionFlags: flags });
      expect(secureActive(driver), `flags=${String(flags)}`).toBe(false);
      expect(driver.isScreenLocked(), `flags=${String(flags)}`).toBe(false);
      expect(wtsCalls(calls), `flags=${String(flags)}`).toEqual([]);
    }
  });

  it.each(["Screen-saver", "Disconnect", "SomethingElse"])("其它非 Default 桌面（%s）：当锁屏（老行为），不是安全桌面；不查会话标志", async (name) => {
    const { driver, calls } = await ready({ desktopName: name, sessionFlags: 1 });
    expect(secureActive(driver)).toBe(false);
    expect(driver.isScreenLocked()).toBe(true);
    expect(wtsCalls(calls)).toEqual([]);
  });

  it("读不到桌面名：isScreenLocked=null，isSecureDesktopActive=false；不查会话标志", async () => {
    const { driver, calls } = await ready({ impls: { GetUserObjectInformationW: () => 0 }, sessionFlags: 1 });
    expect(driver.isScreenLocked()).toBeNull();
    expect(secureActive(driver)).toBe(false);
    expect(wtsCalls(calls)).toEqual([]);
  });

  it("调用的是对的 API：当前服务器（NULL）/ 当前会话（-1）/ WTSSessionInfoEx（25）；只读到 SessionFlags 为止（20 字节）", async () => {
    const { driver, calls } = await ready({ desktopName: "Winlogon", sessionFlags: 0 });
    driver.isScreenLocked();
    const query = ffi(calls, "WTSQuerySessionInformationW");
    expect(query).toHaveLength(1);
    expect(query[0].args.slice(0, 3)).toEqual([null, 0xffffffff, 25]);
    expect(ffi(calls, "ProcessIdToSessionId")[0].args[0]).toBe(process.pid);
    expect(ffi(calls, "koffi.decode")[0].args).toEqual(["uint8_t", 20]);
  });

  describe("读出来的结构必须对得上，否则当「读不到」——宁可保守，也不拿一个乱数当证据", () => {
    const base: FakeOptions = { desktopName: "Winlogon", sessionFlags: 1 };

    const BAD_STRUCTS: Array<[string, FakeOptions]> = [
      ["Level 不是 1", { infoLevel: 2 }],
      ["Level 是 0", { infoLevel: 0 }],
      ["结构里的 SessionId 不是本进程的会话（偏移猜错 / 读到别人的会话）", { infoSession: 7 }],
      ["返回的字节数不够读到 SessionFlags（差 1 字节）", { infoBytes: 19 }],
      ["返回 0 字节", { infoBytes: 0 }],
    ];

    it.each(BAD_STRUCTS)("%s：哪怕标志是「没锁」也不判成安全桌面，按锁屏处理；系统分配的内存照样释放", async (_label, extra) => {
      const { driver, wts, calls } = await ready({ ...base, ...extra });
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
      expect(wts.allocated.size).toBe(2); // 两次判定各查了一次
      expect(wts.freed).toHaveLength(2);
      expect(ffi(calls, "WTSFreeMemory")).toHaveLength(2);
    });

    it("本进程的会话号变了也跟着变：对账用的是「本进程真实的会话号」，不是写死的数", async () => {
      for (const own of [0, 1, 2, 9, 0xffff]) {
        const { driver } = await ready({ ...base, ownSession: own });
        expect(secureActive(driver), `session=${own}`).toBe(true);
      }
    });

    it("ProcessIdToSessionId 失败 → 没有对账基准，干脆不查（也就没有要释放的内存）", async () => {
      const { driver, calls } = await ready({ ...base, ownSession: null });
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
      expect(names(calls)).not.toContain("WTSQuerySessionInformationW");
    });

    it("本进程会话号只在读成功后缓存；读失败不缓存（下次还会重试）", async () => {
      let attempt = 0;
      const { driver, calls } = await ready({
        ...base,
        impls: {
          ProcessIdToSessionId: (_pid: number, out: number[]) => {
            attempt += 1;
            if (attempt === 1) return 0; // 第一次失败
            out[0] = 2;
            return 1;
          },
        },
      });
      expect(secureActive(driver)).toBe(false); // 第一次：没有基准，不敢下结论
      expect(secureActive(driver)).toBe(true); // 第二次：重试成功
      expect(secureActive(driver)).toBe(true); // 第三次：用缓存，不再调
      expect(ffi(calls, "ProcessIdToSessionId")).toHaveLength(2);
    });

    it("WTSQuerySessionInformationW 失败（返回 0）→ 读不到；没有指针，也就不调 WTSFreeMemory", async () => {
      const { driver, calls } = await ready({ ...base, sessionFlags: null });
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
      expect(names(calls)).not.toContain("WTSFreeMemory");
      expect(names(calls)).not.toContain("koffi.decode");
    });

    it("koffi 没有 decode → 读不到；不去查（不留下没人释放的系统内存）", async () => {
      const { driver, calls, wts } = await ready({ ...base, noDecode: true });
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
      expect(names(calls)).not.toContain("WTSQuerySessionInformationW");
      expect(wts.allocated.size).toBe(0);
    });

    it.each(["ProcessIdToSessionId", "WTSQuerySessionInformationW", "WTSFreeMemory"])("可选函数 %s 没绑上 → 读不到，按锁屏处理（init 照常成功）", async (missing) => {
      const { driver, calls } = await ready({ ...base, missing: [missing] });
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
      // WTSFreeMemory 缺了就不能去查（查了没法释放）
      if (missing === "WTSFreeMemory") expect(names(calls)).not.toContain("WTSQuerySessionInformationW");
    });

    it("wtsapi32.dll 整个加载失败：init 仍成功；锁屏照老办法判，永远不会判成安全桌面；原因进 diagnostics", async () => {
      const fake = createFake({ ...base, failLoad: ["wtsapi32.dll"] });
      expect(await fake.driver.init()).toEqual({ ok: true });
      expect(secureActive(fake.driver)).toBe(false);
      expect(fake.driver.isScreenLocked()).toBe(true);
      const diag = fake.driver.diagnostics() as { bindFailures: string[]; bindErrors: Record<string, string>; sessionLock: string };
      expect(diag.bindFailures).toEqual(["WTSQuerySessionInformationW", "WTSFreeMemory"]);
      expect(diag.bindErrors.WTSQuerySessionInformationW).toMatch(/wtsapi32\.dll/);
      expect(diag.sessionLock).toBe("unknown");
    });

    it("读内存时抛异常 → 读不到，不抛出来；系统分配的内存照样释放", async () => {
      const { driver, koffi, wts } = await ready(base);
      (koffi as { decode: unknown }).decode = () => {
        throw new Error("boom");
      };
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
      expect(wts.allocated.size).toBe(2);
      expect(wts.freed).toHaveLength(2);
    });

    it("WTSQuerySessionInformationW 抛异常 → 读不到，不抛出来", async () => {
      const { driver } = await ready({
        ...base,
        impls: {
          WTSQuerySessionInformationW: () => {
            throw new Error("boom");
          },
        },
      });
      expect(secureActive(driver)).toBe(false);
      expect(driver.isScreenLocked()).toBe(true);
    });

    it("WTSFreeMemory 抛异常：不影响判定结果，也不抛出来", async () => {
      const { driver } = await ready({
        ...base,
        impls: {
          WTSFreeMemory: () => {
            throw new Error("boom");
          },
        },
      });
      expect(secureActive(driver)).toBe(true);
      expect(driver.isScreenLocked()).toBe(false);
    });

    it("拿到的指针是空（NULL / undefined）：读不到；没有东西可释放", async () => {
      for (const pointer of [null, undefined]) {
        const { driver, calls } = await ready({
          ...base,
          impls: {
            WTSQuerySessionInformationW: (_s: unknown, _id: number, _c: number, out: unknown[], bytes: number[]) => {
              out[0] = pointer;
              bytes[0] = 256;
              return 1;
            },
          },
        });
        expect(secureActive(driver), String(pointer)).toBe(false);
        expect(driver.isScreenLocked(), String(pointer)).toBe(true);
        expect(names(calls), String(pointer)).not.toContain("WTSFreeMemory");
      }
    });
  });

  it("多次判定：每次分配的内存都各释放一次——不泄漏、不重复释放、不释放陌生指针", async () => {
    const { driver, wts, calls } = await ready({ desktopName: "Winlogon", sessionFlags: 0 });
    for (let i = 0; i < 5; i += 1) {
      driver.isScreenLocked();
      secureActive(driver);
    }
    expect(wts.allocated.size).toBe(10);
    expect(wts.freed).toHaveLength(10);
    expect(new Set(wts.freed).size).toBe(10);
    expect([...wts.freed].sort()).toEqual([...wts.allocated.keys()].sort());
    expect(ffi(calls, "ProcessIdToSessionId")).toHaveLength(1); // 本进程的会话号只读一次
  });

  it("先释放桌面句柄、再查会话标志（两样东西各自独立收尾）", async () => {
    const { driver, calls } = await ready({ desktopName: "Winlogon", sessionFlags: 1 });
    secureActive(driver);
    expect(names(calls)).toEqual([
      "OpenInputDesktop",
      "GetUserObjectInformationW",
      "CloseDesktop",
      "ProcessIdToSessionId",
      "WTSQuerySessionInformationW",
      "koffi.decode",
      "WTSFreeMemory",
    ]);
  });

  it("每次都实时判断、不缓存结果：UAC 弹出又消失、锁屏被解开，下一次判定立刻跟着变", async () => {
    const options: FakeOptions = { desktopName: "Default", sessionFlags: 1 };
    const { driver } = await ready(options);
    const now = () => ({ secure: secureActive(driver), locked: driver.isScreenLocked() });
    expect(now()).toEqual({ secure: false, locked: false }); // 正常桌面
    options.desktopName = "Winlogon"; // UAC 弹出（会话没锁）
    expect(now()).toEqual({ secure: true, locked: false });
    options.sessionFlags = 0; // 用户按 Win+L 锁屏（桌面名仍是 Winlogon）
    expect(now()).toEqual({ secure: false, locked: true });
    options.desktopName = null; // 锁屏界面上 OpenInputDesktop 被拒
    expect(now()).toEqual({ secure: false, locked: true });
    options.desktopName = "Default"; // 解锁，回到正常桌面
    options.sessionFlags = 1;
    expect(now()).toEqual({ secure: false, locked: false });
  });
});

describe("idleSeconds", () => {
  it("(GetTickCount − 最近输入时刻) / 1000；先读 GetLastInputInfo 再读 GetTickCount，cbSize=8", async () => {
    const { driver, calls } = await ready({ tick: 10_000, lastInput: 7_500 });
    expect(driver.idleSeconds()).toBe(2.5);
    expect(names(calls)).toEqual(["GetLastInputInfo", "GetTickCount"]);
    expect(calls[0].args[0]).toMatchObject({ cbSize: 8 });
  });

  it("没有空闲：0", async () => {
    expect((await ready({ tick: 5000, lastInput: 5000 })).driver.idleSeconds()).toBe(0);
  });

  it("32 位毫秒计数回绕（约 49.7 天）：按无符号差值算，不会变成负数", async () => {
    // tick 刚回绕到 5，最近输入在回绕前 16ms（0xFFFFFFF0）：差 21ms
    expect((await ready({ tick: 5, lastInput: 0xfffffff0 })).driver.idleSeconds()).toBeCloseTo(0.021, 6);
    // 极端：tick=0xFFFFFFFF，输入在 0：差 0xFFFFFFFF ms
    expect((await ready({ tick: 0xffffffff, lastInput: 0 })).driver.idleSeconds()).toBeCloseTo(4294967.295, 3);
  });

  it("GetLastInputInfo 失败 → INTERNAL，且不会拿一个没填好的值去算", async () => {
    const { driver, calls } = await ready({ impls: { GetLastInputInfo: () => 0 } });
    const err = await catchError(() => driver.idleSeconds());
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toMatch(/GetLastInputInfo.*Win32 错误码 5/);
    expect(names(calls)).toEqual(["GetLastInputInfo", "GetLastError"]);
  });
});

describe("getPrimaryDisplay", () => {
  it("SM_CXSCREEN / SM_CYSCREEN → { x:0, y:0, width, height }", async () => {
    const { driver, calls } = await ready();
    expect(driver.getPrimaryDisplay()).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(calls.map((c) => c.args)).toEqual([[0], [1]]);
  });

  it("读到 0（没有显示器 / 会话断开）→ INTERNAL，不返回一个 0×0 的矩形", async () => {
    const { driver } = await ready({ impls: { GetSystemMetrics: () => 0 } });
    expect(() => driver.getPrimaryDisplay()).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
  });
});

describe("diagnostics", () => {
  type Diag = {
    platform: string;
    osRelease: string | null;
    arch: string;
    electron: string | null;
    node: string;
    koffi: string | null;
    loaded: boolean;
    initError: string | null;
    bindFailures: string[];
    structSizes: Record<string, number> | null;
    screen: { width: number; height: number } | null;
    virtualScreen: { x: number; y: number; width: number; height: number } | null;
    dpiAwareness: string;
    inputDesktop: string;
    sessionLock: string;
    shellExecute: string;
  };

  it("init 之前也能调：loaded=false，其余是「未知」", () => {
    const diag = createFake().driver.diagnostics() as Diag;
    expect(diag).toMatchObject({
      platform: "win32",
      koffi: null,
      loaded: false,
      initError: null,
      structSizes: null,
      screen: null,
      dpiAwareness: "unknown",
      inputDesktop: "unknown",
      sessionLock: "unknown",
      shellExecute: "unknown",
    });
  });

  it("init 之后：字段齐全，JSON 可序列化", async () => {
    const { driver } = await ready();
    const diag = driver.diagnostics() as Diag;
    expect(diag).toMatchObject({
      platform: "win32",
      koffi: "3.3.8-fake",
      loaded: true,
      initError: null,
      bindFailures: [],
      structSizes: SIZES_64,
      screen: { width: 1920, height: 1080 },
      virtualScreen: { x: -1920, y: 0, width: 3840, height: 1080 },
      dpiAwareness: "per-monitor",
      inputDesktop: "Default",
      sessionLock: "unlocked",
      shellExecute: "ShellExecuteExW",
    });
    expect(diag.node).toBe(process.versions.node);
    expect(diag.arch).toBe(process.arch);
    expect(diag.electron).toBe(process.versions.electron ?? null);
    expect(typeof diag.osRelease).toBe("string");
    expect(JSON.parse(JSON.stringify(diag))).toEqual(diag);
  });

  it("inputDesktop 三态：Default / Winlogon（含「打不开」的推断）/ unknown", async () => {
    const at = async (options: FakeOptions) => ((await ready(options)).driver.diagnostics() as Diag).inputDesktop;
    expect(await at({ desktopName: "Default" })).toBe("Default");
    expect(await at({ desktopName: "Winlogon" })).toBe("Winlogon");
    expect(await at({ desktopName: null })).toBe("Winlogon");
    expect(await at({ desktopName: "Screen-saver" })).toBe("unknown");
    expect(await at({ impls: { GetUserObjectInformationW: () => 0 } })).toBe("unknown");
  });

  it("sessionLock 三态：locked / unlocked / unknown（读不到 / 对不上）；与输入桌面无关，真机核对 UAC / 锁屏区分时看它", async () => {
    const at = async (options: FakeOptions) => ((await ready(options)).driver.diagnostics() as Diag).sessionLock;
    expect(await at({ sessionFlags: 0 })).toBe("locked");
    expect(await at({ sessionFlags: 1 })).toBe("unlocked");
    expect(await at({ sessionFlags: 0, desktopName: "Winlogon" })).toBe("locked");
    expect(await at({ sessionFlags: 1, desktopName: "Winlogon" })).toBe("unlocked");
    expect(await at({ sessionFlags: null })).toBe("unknown");
    expect(await at({ sessionFlags: 0xffffffff })).toBe("unknown");
    expect(await at({ sessionFlags: 1, infoLevel: 2 })).toBe("unknown");
    expect(await at({ sessionFlags: 1, infoSession: 9 })).toBe("unknown");
    expect(await at({ sessionFlags: 1, ownSession: null })).toBe("unknown");
    expect(await at({ sessionFlags: 1, noDecode: true })).toBe("unknown");
  });

  it("sessionLock 查询也不泄漏内存：每次诊断分配的都释放", async () => {
    const { driver, wts } = await ready({ sessionFlags: 0 });
    driver.diagnostics();
    driver.diagnostics();
    expect(wts.allocated.size).toBe(2);
    expect(wts.freed).toHaveLength(2);
  });

  it("DPI 相关函数缺失：dpiAwareness=unknown，其它字段不受影响", async () => {
    const { driver } = await ready({ missing: ["GetThreadDpiAwarenessContext"] });
    expect(driver.diagnostics()).toMatchObject({ dpiAwareness: "unknown", loaded: true, screen: { width: 1920, height: 1080 } });
  });

  it("init 失败之后也能调：带上失败原因与缺失函数", async () => {
    const fake = createFake({ missing: ["SetCursorPos"] });
    await fake.driver.init();
    const diag = fake.driver.diagnostics() as Diag;
    expect(diag.loaded).toBe(false);
    expect(diag.initError).toMatch(/SetCursorPos/);
    expect(diag.bindFailures).toEqual(["SetCursorPos"]);
    expect(diag.screen).toBeNull();
    expect(diag.shellExecute).toBe("unknown"); // init 没成功，不报 openApp 走哪条路
  });

  it("不含用户内容：枚举过窗口、前台有应用，诊断里也没有窗口标题 / 进程名", async () => {
    const { driver } = await ready();
    await driver.listApps();
    const text = JSON.stringify(driver.diagnostics());
    for (const secret of ["记事本", "微信", "notepad", "WeChat", "查找"]) expect(text).not.toContain(secret);
  });

  it("不含用户内容：openApp 搜过开始菜单、打开成功 / 失败过，诊断里也没有目标名 / 快捷方式名 / 目录 / 用户名 / 环境变量", async () => {
    const { driver } = await ready({
      shellEx: (file) => (file.endsWith(".lnk") ? {} : { ok: false, hInstApp: 2 }),
      startMenu: { appData: { 秘密项目: null, "秘密项目.lnk": null } },
    });
    await driver.openApp("秘密项目"); // 开始菜单命中，成功
    await catchError(() => driver.openApp("根本没有这个应用")); // 失败
    const text = JSON.stringify(driver.diagnostics());
    for (const secret of ["秘密项目", "根本没有这个应用", "alice", "AppData", "ProgramData", "Start Menu", "Roaming", ".lnk"]) expect(text).not.toContain(secret);
  });
});

// ═══════════════════════════ 窗口 / 应用 ═══════════════════════════

describe("listApps / frontmostApp", () => {
  it("按进程聚合：过滤空标题 / 纯空白标题 / 不可见 / cloaked 窗口；最小化窗口保留并带标记；进程名去掉 .exe", async () => {
    const { driver } = await ready();
    expect(await driver.listApps()).toEqual([
      {
        name: "notepad",
        pid: 100,
        frontmost: true,
        windows: [
          { title: "无标题 - 记事本", x: 100, y: 100, width: 800, height: 600, minimized: false },
          { title: "查找", x: 200, y: 200, width: 300, height: 200, minimized: false },
        ],
      },
      {
        name: "WeChat",
        pid: 200,
        frontmost: false,
        windows: [{ title: "微信", x: -32000, y: -32000, width: 160, height: 28, minimized: true }],
      },
      {
        name: "未知进程#500",
        pid: 500,
        frontmost: false,
        windows: [{ title: "系统保护进程的窗口", x: 10, y: 20, width: 100, height: 200, minimized: false }],
      },
    ]);
  });

  it("结果可 JSON 化（不暴露 BigInt 窗口句柄）", async () => {
    const { driver } = await ready();
    const apps = await driver.listApps();
    expect(JSON.parse(JSON.stringify(apps))).toEqual(apps);
  });

  it("EnumWindows 的回调里不做任何别的 FFI 调用（只收集句柄）", async () => {
    const { driver, stats } = await ready();
    await driver.listApps();
    expect(stats.enumCallbackFfiCalls).toBe(0);
  });

  it("OpenProcess 参数 = (PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)；同一 pid 只查一次；打开的句柄都关闭", async () => {
    const { driver, calls } = await ready();
    await driver.listApps();
    expect(ffi(calls, "OpenProcess").map((c) => c.args)).toEqual([
      [0x1000, 0, 100],
      [0x1000, 0, 200],
      [0x1000, 0, 500],
    ]);
    expect(ffi(calls, "CloseHandle").map((c) => c.args)).toEqual([[H(0x9000 + 100)], [H(0x9000 + 200)]]); // pid 500 没打开，不用关
  });

  it("dwmapi 不可用：不做 cloaked 过滤（多列出别的虚拟桌面上的窗口），其它不变", async () => {
    const { driver } = await ready({ failLoad: ["dwmapi.dll"] });
    const apps = await driver.listApps();
    expect(apps.map((a) => a.pid)).toEqual([100, 200, 400, 500]);
  });

  it("DwmGetWindowAttribute 的参数：DWMWA_CLOAKED=14，缓冲 4 字节", async () => {
    const { driver, calls } = await ready();
    await driver.listApps();
    const first = ffi(calls, "DwmGetWindowAttribute")[0];
    expect([first.args[1], first.args[3]]).toEqual([14, 4]);
  });

  it("EnumWindows 失败 → INTERNAL 带错误码", async () => {
    const { driver } = await ready({ impls: { EnumWindows: () => 0 } });
    const err = await catchError(() => driver.listApps());
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toMatch(/枚举窗口失败.*Win32 错误码 5/);
  });

  it("frontmostApp：前台窗口所属进程（含它的全部窗口）", async () => {
    const { driver } = await ready();
    expect(driver.frontmostApp()).toMatchObject({ name: "notepad", pid: 100, frontmost: true });
    expect(driver.frontmostApp()?.windows).toHaveLength(2);
  });

  it("前台窗口没有可列出的窗口（如桌面 / 任务栏）：仍返回它是谁，windows 为空", async () => {
    const { driver } = await ready({ foreground: H(0x40) });
    expect(driver.frontmostApp()).toEqual({ name: "explorer", pid: 300, frontmost: true, windows: [] });
  });

  it("没有前台窗口：null", async () => {
    expect((await ready({ foreground: null })).driver.frontmostApp()).toBeNull();
  });
});

describe("openApp", () => {
  /** 系统「找不到」：ShellExecuteExW 返回 0，hInstApp = SE_ERR_FNF(2) */
  const FAIL: ShellExOutcome = { ok: false, hInstApp: 2 };
  /** 只有 target 本身打不开；别的（开始菜单里找到的 .lnk 等）照常成功 */
  const onlyFails =
    (target: string) =>
    (file: string): ShellExOutcome =>
      file === target ? FAIL : {};
  const lnks = (...names: string[]): Tree => Object.fromEntries(names.map((name) => [`${name}.lnk`, null]));
  /** Programs 目录下某个文件的完整路径 */
  const inMenu = (base: string, ...parts: string[]) => path.win32.join(menuDir(base), ...parts);

  // ───────────────────────── 目标校验 ─────────────────────────

  describe("目标校验：不合格 → BAD_ARGS，且一个系统函数都没调、一个目录都没读", () => {
    const REJECTED: Array<[string, string, RegExp]> = [
      // 带协议头
      ["http 网址", "http://example.com", /不能打开网址/],
      ["https 网址（带路径和参数）", "https://example.com/a?b=1", /不能打开网址/],
      ["大写协议头", "HTTP://EXAMPLE.COM", /不能打开网址/],
      ["mailto:", "mailto:someone@example.com", /不能打开网址/],
      ["ms-settings:", "ms-settings:display", /不能打开网址/],
      ["shell: 协议", "shell:startup", /不能打开网址/],
      ["file:///", "file:///C:/Windows/notepad.exe", /不能打开网址/],
      ["协议头里有 + . -", "web+app.v1-x:thing", /不能打开网址/],
      ["盘符后没有分隔符（C:foo.exe 不是盘符绝对路径，按协议头拒绝）", "C:foo.exe", /不能打开网址/],
      ["只有盘符 C:", "C:", /不能打开网址/],
      ["裸名带备用数据流写法（notepad.exe:evil）", "notepad.exe:evil", /不能打开网址/],
      // UNC
      ["UNC：反斜杠", "\\\\server\\share\\app.exe", /网络共享/],
      ["UNC：正斜杠", "//server/share/app.exe", /网络共享/],
      ["UNC：混写 \\/", "\\/server/share/app.exe", /网络共享/],
      ["UNC：混写 /\\", "/\\server\\share\\app.exe", /网络共享/],
      ["设备路径 \\\\?\\", "\\\\?\\C:\\Windows\\notepad.exe", /网络共享/],
      // 非法字符 / 控制字符
      ["含 |", "a|b", /不可能出现的字符/],
      ['含 "', 'a"b', /不可能出现的字符/],
      ["含 <", "a<b", /不可能出现的字符/],
      ["含 >", "a>b", /不可能出现的字符/],
      ["含 *", "a*b", /不可能出现的字符/],
      ["含 ?", "a?b", /不可能出现的字符/],
      ["含 NUL", "note\0pad", /不可能出现的字符/],
      ["含制表符（在中间）", "note\tpad", /不可能出现的字符/],
      ["含换行（在中间）", "note\npad", /不可能出现的字符/],
      ["含 U+0001", "note\u0001pad", /不可能出现的字符/],
      ["含 U+001F（最后一个控制字符）", "note\u001fpad", /不可能出现的字符/],
      ["含 DEL（U+007F）", "note\u007fpad", /不可能出现的字符/],
      ["含 ESC 序列", "note\u001b[31mpad", /不可能出现的字符/],
      // 含路径分隔符，但不是盘符绝对路径
      ["相对路径 .\\", ".\\app.exe", /绝对路径/],
      ["相对路径 ..\\", "..\\app.exe", /绝对路径/],
      ["相对路径：子目录（反斜杠）", "sub\\app.exe", /绝对路径/],
      ["相对路径：子目录（正斜杠）", "sub/app.exe", /绝对路径/],
      ["当前盘根（单个反斜杠开头）", "\\Windows\\notepad.exe", /绝对路径/],
      ["POSIX 绝对路径", "/usr/bin/app", /绝对路径/],
      ["数字开头的「盘符」", "1:\\a.exe", /绝对路径/],
      // NTFS 备用数据流
      ["备用数据流：文件名后带流名", "C:\\a\\b.exe:evil.exe", /备用数据流/],
      ["备用数据流：目录名里多一个冒号", "C:\\a:b\\c.exe", /备用数据流/],
      // 盘符绝对路径，但不是 .exe / .lnk
      ["绝对路径是文档（.ini）", "C:\\Windows\\win.ini", /只能打开 \.exe/],
      ["绝对路径 .bat", "C:\\a\\b.bat", /只能打开 \.exe/],
      ["绝对路径 .ps1", "C:\\a\\run.ps1", /只能打开 \.exe/],
      ["绝对路径 .msi", "C:\\a\\setup.msi", /只能打开 \.exe/],
      ["绝对路径没有扩展名", "C:\\a\\b", /只能打开 \.exe/],
      ["绝对路径以分隔符结尾（目录）", "C:\\Windows\\", /只能打开 \.exe/],
      ["绝对路径的隐藏文件名 .exe", "C:\\a\\.exe", /只能打开 \.exe/],
      ["绝对路径（正斜杠）的隐藏文件名 .exe", "C:/a/.exe", /只能打开 \.exe/],
      ["绝对路径双扩展名 .exe.txt", "C:\\a\\b.exe.txt", /只能打开 \.exe/],
      ["绝对路径 .exe 后面多一个点", "C:\\a\\b.exe.", /只能打开 \.exe/],
      ["绝对路径后面跟命令行参数（路径的最后一段不是 .exe / .lnk）", "C:\\Program Files\\app.exe -arg /flag", /只能打开 \.exe/],
      // 裸名带黑名单后缀
      ["裸名 .bat", "setup.bat", /\.bat 这类文件/],
      ["裸名 .PS1（大写）", "RUN.PS1", /\.ps1 这类文件/],
      ["裸名 .url", "link.url", /\.url 这类文件/],
      ["裸名 .bat 后面多一个点（Windows 解析路径时会丢掉末尾的点）", "setup.bat.", /\.bat 这类文件/],
      ["裸名 .cmd 后面是点和空格的组合", "setup.cmd. .", /\.cmd 这类文件/],
    ];

    it.each(REJECTED)("%s → BAD_ARGS，系统函数与目录读取都是零次", async (_label, target, expected) => {
      const { driver, calls } = await ready();
      const err = await catchError(() => driver.openApp(target));
      expect(err).toMatchObject({ name: "DesktopError", code: "BAD_ARGS" });
      expect(err.message).toMatch(expected);
      expect(calls).toEqual([]); // 一个 FFI 都没调；读目录（fs.readdir）也记在同一条时间线上，同样是零
    });

    it("拒绝文案不回显目标（目标来自 AI，回显没有信息量，还可能带控制字符）", async () => {
      const probes = [
        "https://secret-token-xyz.example.com/",
        "\\\\secret-token-xyz\\share\\a.exe",
        "a|secret-token-xyz",
        ".\\secret-token-xyz.exe",
        "C:\\secret-token-xyz\\a.bat",
        "C:\\secret-token-xyz\\a.exe:s",
        "secret-token-xyz.bat",
      ];
      for (const target of probes) {
        const { driver } = await ready();
        const err = await catchError(() => driver.openApp(target));
        expect(err.message, target).not.toContain("secret-token-xyz");
      }
    });

    it("网址的拒绝文案：点明「只能打开应用，不能打开网址」，并告诉 AI 去浏览器里操作（自修复）", async () => {
      const { driver } = await ready();
      const err = await catchError(() => driver.openApp("https://example.com"));
      expect(err.message).toContain("open_app 只能打开应用，不能打开网址");
      expect(err.message).toContain("要上网请在浏览器里操作");
    });

    const ACCEPTED: Array<[string, string]> = [
      ["应用名", "notepad"],
      ["应用名带 .exe", "notepad.exe"],
      ["大写 .EXE", "WeChat.EXE"],
      ["带 .lnk 的快捷方式名", "微信.lnk"],
      ["中文显示名", "微信"],
      ["显示名里的版本号（.0 不是黑名单后缀）", "App 2.0"],
      ["显示名里的多段版本号", "App 2.0.1"],
      ["六位的「后缀」不算后缀", "foo.abcdef"],
      ["更长的近似后缀（.json / .batx）", "config.json"],
      ["末尾是点的显示名", "Foo Inc."],
      ["看起来像后缀、但含非字母数字", "foo.c++"],
      ["特殊字符都只是普通字符（& ' ( ) , ; # @ %）", "Tom & Jerry's (App), v2; #1 @home 100%"],
      ["盘符绝对路径 .exe（反斜杠）", "C:\\Windows\\System32\\notepad.exe"],
      ["盘符绝对路径 .exe（正斜杠、小写盘符）", "c:/windows/system32/notepad.exe"],
      ["盘符绝对路径 .lnk（中文）", "D:\\Apps\\微信\\微信.lnk"],
      ["路径里有空格 / 括号 / & / 分号 / 单引号 / 百分号", "C:\\Program Files (x86)\\Tom & Jerry's; v1 100%\\app.exe"],
      ["目录名带黑名单后缀（扩展名只看最后一段）", "C:\\a.bat\\b.exe"],
      ["恰好 1024 个字符（长度上限）", "a".repeat(1024)],
    ];

    it.each(ACCEPTED)("放行：%s → ShellExecuteExW 收到的 lpFile 与目标逐字一致", async (_label, target) => {
      const { driver, calls } = await ready();
      await driver.openApp(target);
      expect(exFiles(calls)).toEqual([target]);
    });

    it("校验针对 trim 之后的目标：首尾空白先去掉再判断，也去掉再传给系统", async () => {
      const bad = await ready();
      await expect(bad.driver.openApp("  https://example.com \n")).rejects.toMatchObject({ code: "BAD_ARGS" });
      expect(bad.calls).toEqual([]);

      const { driver, calls } = await ready();
      await driver.openApp("\t notepad  \r\n");
      expect(exFiles(calls)).toEqual(["notepad"]);
    });

    it.each([
      ["空字符串", "", /不能为空/],
      ["纯空白", "   \t\n", /不能为空/],
      ["过长（1025 个字符）", "x".repeat(1025), /过长（最多 1024 个字符）/],
      ["不是字符串（数字）", 42 as unknown as string, /不能为空/],
      ["不是字符串（null）", null as unknown as string, /不能为空/],
      ["不是字符串（对象）", {} as unknown as string, /不能为空/],
    ])("%s → BAD_ARGS，没有调用任何系统函数", async (_label, target, expected) => {
      const { driver, calls } = await ready();
      const err = await catchError(() => driver.openApp(target));
      expect(err).toMatchObject({ name: "DesktopError", code: "BAD_ARGS" });
      expect(err.message).toMatch(expected);
      expect(calls).toEqual([]);
    });
  });

  describe("rejectOpenTarget（纯函数，驱动里的校验就是它）：规则逐条", () => {
    const BLOCKED = ["bat", "cmd", "com", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "scr", "cpl", "hta", "reg", "dll", "jar", "inf", "pif", "url", "chm"];
    const alternating = (text: string) => [...text].map((c, i) => (i % 2 === 0 ? c : c.toUpperCase())).join("");

    it("黑名单与需求逐项一致：23 项，不多不少", () => {
      expect(BLOCKED).toHaveLength(23);
      expect([...BLOCKED_TARGET_EXTENSIONS].sort()).toEqual([...BLOCKED].sort());
      expect(Object.isFrozen(BLOCKED_TARGET_EXTENSIONS)).toBe(true);
    });

    it("黑名单里每个后缀：小写 / 大写 / 交替大小写，加上前面多个点、末尾多点，裸名全部拒绝（文案点名后缀，统一小写）", () => {
      for (const ext of BLOCKED) {
        for (const spelling of [ext, ext.toUpperCase(), alternating(ext)]) {
          for (const name of [`setup.${spelling}`, `a.b.c.${spelling}`, `setup.${spelling}.`, `setup.${spelling}..`]) {
            expect(rejectOpenTarget(name), name).toContain(`.${ext} 这类文件`);
          }
        }
        expect(rejectOpenTarget(`.${ext}`), `.${ext}`).toContain(`.${ext} 这类文件`); // 点开头的也算后缀
      }
    });

    it("后缀判断的边界：最后一个点之后必须是 1~5 位字母数字；.exe / .lnk 与不在黑名单里的后缀都放行", () => {
      const passes = [
        "setup.exe", "SETUP.EXE", "setup.lnk", "setup.Lnk", "setup", "setup.batx", "setup.bat1", "setup.abcdef", "setup.bat-x",
        "setup.b at", "bat", "script", "js", "config.json", "app.jsx", "run.ps1x", "setup.bat.exe", "foo.", "Foo Inc.", "App 2.0",
        "App 2.0.1", "foo.c++", "a.tar.gz",
      ];
      for (const name of passes) expect(rejectOpenTarget(name), name).toBeNull();
    });

    it("盘符不会被当成协议头：C:\\ 与 C:/（任意盘符、大小写）放行 .exe / .lnk；C:foo / C: 按协议头拒绝", () => {
      for (const ok of ["C:\\a\\b.exe", "c:/a/b.exe", "Z:\\x.lnk", "z:/X.LNK", "D:\\Program Files (x86)\\App\\app.exe"]) expect(rejectOpenTarget(ok), ok).toBeNull();
      for (const bad of ["C:foo.exe", "C:", "c:foo", "1:\\a.exe"]) expect(rejectOpenTarget(bad), bad).not.toBeNull();
    });

    it("检查顺序：协议头 > UNC > 非法字符 > 路径规则（带 ? 的网址得到的是「不能打开网址」）", () => {
      const reason = (target: string) => rejectOpenTarget(target) ?? "";
      expect(reason("https://example.com/?a=1")).toMatch(/不能打开网址/);
      expect(reason("\\\\server\\share\\a?.exe")).toMatch(/网络共享/);
      expect(reason("a|b.bat")).toMatch(/不可能出现的字符/); // 非法字符先于黑名单
      expect(reason("sub\\a*.exe")).toMatch(/不可能出现的字符/); // 非法字符先于「相对路径」
      expect(reason("C:\\a\\b.bat:x")).toMatch(/备用数据流/); // 路径规则内：备用数据流先于扩展名
    });

    it("合格返回 null；不合格返回非空的中文原因（调用方按真值判断）", () => {
      expect(rejectOpenTarget("notepad")).toBeNull();
      for (const bad of ["http://x", "\\\\s\\x", "a|b", "..\\a.exe", "C:\\a:b.exe", "C:\\a.txt", "x.bat"]) {
        const reason = rejectOpenTarget(bad);
        expect(typeof reason, bad).toBe("string");
        expect(reason as string, bad).toMatch(/[\u4e00-\u9fa5]{6,}/);
      }
    });

    it("每条拒绝文案都告诉 AI 该怎么改（自修复）", () => {
      const advice: Array<[string, RegExp]> = [
        ["https://example.com", /要上网请在浏览器里操作/],
        ["\\\\server\\share\\a.exe", /请改传本机应用的名称/],
        ["a|b", /请去掉后重试/],
        ["sub\\a.exe", /直接传应用名称就行/],
        ["C:\\a:b\\c.exe", /不能再有冒号/],
        ["C:\\a\\b.txt", /请改传应用名称/],
        ["setup.bat", /请传应用名称/],
      ];
      for (const [target, hint] of advice) expect(rejectOpenTarget(target), target).toMatch(hint);
    });
  });

  // ───────────────────────── ShellExecuteExW 的调用形态 ─────────────────────────

  describe("ShellExecuteExW：一次调用，NO_UI | NOASYNC，没有 shell 拼接", () => {
    it("入参 15 个成员齐全：cbSize=实测大小、fMask=0x500、lpVerb=open、lpFile=目标、nShow=SW_SHOWNORMAL，其余为空；成功就结束（不枚举窗口、不读目录、不 CloseHandle）", async () => {
      const { driver, calls } = await ready();
      await driver.openApp("notepad");
      expect(calls).toEqual([
        {
          fn: "ShellExecuteExW",
          args: [
            {
              cbSize: 112,
              fMask: 0x500,
              hwnd: null,
              lpVerb: "open",
              lpFile: "notepad",
              lpParameters: null,
              lpDirectory: null,
              nShow: 1,
              hInstApp: null,
              lpIDList: null,
              lpClass: null,
              hkeyClass: null,
              dwHotKey: 0,
              hIconOrMonitor: null,
              hProcess: null,
            },
          ],
        },
      ]);
    });

    it("fMask 恰好是 NO_UI(0x400) | NOASYNC(0x100)：不带 NOCLOSEPROCESS(0x40)（没有进程句柄要关），也不带 DOENVSUBST(0x200)（不展开 %VAR%）", async () => {
      const { driver, calls } = await ready();
      await driver.openApp("notepad");
      const { fMask } = ffi(calls, "ShellExecuteExW")[0].args[0] as { fMask: number };
      expect(fMask).toBe(0x400 | 0x100);
      expect(fMask & 0x400).toBe(0x400);
      expect(fMask & 0x100).toBe(0x100);
      expect(fMask & 0x40).toBe(0);
      expect(fMask & 0x200).toBe(0);
    });

    it("cbSize 取 koffi 实测的 sizeof(SHELLEXECUTEINFOW)，不是写死的 112：32 位下是 60", async () => {
      const { driver, calls } = await ready({ pointerSize: 4, sizes: SIZES_32 });
      await driver.openApp("notepad");
      expect(ffi(calls, "ShellExecuteExW")[0].args[0]).toMatchObject({ cbSize: 60 });
    });

    it("lpParameters / lpDirectory 永远是 null（没有参数、没有工作目录）：目标里的空格 / & 只是文件名的一部分，不会被当成命令行", async () => {
      const { driver, calls } = await ready();
      await driver.openApp("C:\\Program Files\\App & Co\\app.exe");
      expect(ffi(calls, "ShellExecuteExW")[0].args[0]).toMatchObject({
        lpFile: "C:\\Program Files\\App & Co\\app.exe",
        lpParameters: null,
        lpDirectory: null,
      });
    });

    it.each([[1], [7], [-1]])("返回 %s（非 0）= 成功：只看返回值，不看 hInstApp", async (ret) => {
      const { driver, calls } = await ready({ shellEx: { ret, hInstApp: 2 } }); // hInstApp = 2 本来是「找不到」，但成功不看它
      await expect(driver.openApp("notepad")).resolves.toBeUndefined();
      expect(names(calls)).toEqual(["ShellExecuteExW"]); // 成功后既没有读 last error，也没有回退
    });

    it("返回 0 = 失败：哪怕 hInstApp 看起来像成功（> 32）", async () => {
      const { driver } = await ready({ shellEx: { ok: false, ret: 0, hInstApp: 42 }, windows: [], processes: {} });
      await expect(driver.openApp("abc")).rejects.toThrow(/打开「abc」失败/);
    });

    it("ShellExecuteExW 自己抛错（koffi 层）：带中文上下文，并且不再往后回退（别让后面的步骤盖住程序错误）", async () => {
      const { driver, calls } = await ready({
        impls: {
          ShellExecuteExW: () => {
            throw new Error("bad arg");
          },
        },
      });
      await expect(driver.openApp("abc")).rejects.toThrow(/调用 Win32 ShellExecuteExW 出错：bad arg/);
      expect(steps(calls)).toEqual(["ex:abc"]);
    });
  });

  // ───────────────────────── 已运行窗口的匹配 ─────────────────────────

  it("系统打不开 → 按窗口标题找已运行的窗口：最小化的先 SW_RESTORE，再 SetForegroundWindow", async () => {
    const { driver, calls } = await ready({ shellEx: FAIL });
    await driver.openApp("微信");
    const tail = calls.filter((c) => c.fn === "ShowWindow" || c.fn === "SetForegroundWindow");
    expect(tail).toEqual([
      { fn: "ShowWindow", args: [H(0x30), 9] },
      { fn: "SetForegroundWindow", args: [H(0x30)] },
    ]);
  });

  it("没最小化的窗口：只 SetForegroundWindow，不 ShowWindow", async () => {
    const { driver, calls } = await ready({ shellEx: FAIL });
    await driver.openApp("记事本");
    expect(ffi(calls, "ShowWindow")).toEqual([]);
    expect(ffi(calls, "SetForegroundWindow").map((c) => c.args)).toEqual([[H(0x10)]]);
  });

  it.each(["wechat", "WECHAT", "WeChat.exe", "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe", "微信.lnk", "C:\\Users\\alice\\Desktop\\微信.lnk"])(
    "窗口匹配（不分大小写，目录与 .exe / .lnk 后缀都先去掉再比）：%s",
    async (target) => {
      const { driver, calls } = await ready({ shellEx: FAIL });
      await driver.openApp(target);
      expect(ffi(calls, "SetForegroundWindow").map((c) => c.args)).toEqual([[H(0x30)]]);
    },
  );

  describe("匹配优先级：进程名完全相同 > 进程名包含 > 标题包含", () => {
    // 标题匹配的窗口故意排在最前：如果实现只按枚举顺序，会选错
    const windows: FakeWindow[] = [
      { hwnd: H(1), pid: 1, title: "Note taking tips - Browser" },
      { hwnd: H(2), pid: 2, title: "readme.txt" },
      { hwnd: H(3), pid: 3, title: "other" },
    ];
    const processes = { 1: "C:\\apps\\browser.exe", 2: "C:\\Windows\\notepad.exe", 3: "C:\\apps\\note.exe" };
    const focused = async (target: string, procs: Record<number, string | null> = processes) => {
      const { driver, calls } = await ready({ shellEx: FAIL, windows, processes: procs });
      await driver.openApp(target);
      return ffi(calls, "SetForegroundWindow")[0].args[0];
    };

    it("进程名完全相同胜出", async () => {
      expect(await focused("note")).toBe(H(3));
      expect(await focused("notepad")).toBe(H(2));
    });

    it("没有完全相同时，进程名包含胜过标题包含", async () => {
      expect(await focused("note", { 1: "C:\\apps\\browser.exe", 2: "C:\\Windows\\notepad.exe", 3: "C:\\apps\\other.exe" })).toBe(H(2));
    });

    it("只有标题匹配时用标题", async () => {
      expect(await focused("taking tips")).toBe(H(1));
    });

    it("包含匹配至少要 2 个字符：单字符不会命中一大片", async () => {
      const { driver } = await ready({ shellEx: FAIL, windows, processes });
      await expect(driver.openApp("e")).rejects.toThrow(/打开「e」失败/);
    });
  });

  // ───────────────────────── 失败原因：hInstApp / GetLastError → 人话 ─────────────────────────

  describe("失败原因：先看 hInstApp（SE_ERR_*，1..32），它没给再看 GetLastError，都映射成人话", () => {
    const failure = async (outcome: ShellExOutcome, extra: FakeOptions = {}) => {
      const { driver, calls } = await ready({ shellEx: outcome, windows: [], processes: {}, ...extra });
      const err = await catchError(() => driver.openApp("abc"));
      return { err, calls };
    };

    it.each([
      [2, "返回 2，找不到该文件或程序"],
      [3, "返回 3，找不到该路径"],
      [5, "返回 5，拒绝访问"],
      [8, "返回 8，内存不足"],
      [31, "返回 31，没有与该文件类型关联的程序"],
      [1, "返回 1）"],
      [28, "返回 28）"],
      [32, "返回 32）"],
    ])("hInstApp = %s → ShellExecuteEx %s", async (code, text) => {
      const { err } = await failure({ ok: false, hInstApp: code });
      expect(err).toMatchObject({ name: "DesktopError", code: "INTERNAL" });
      expect(err.message).toContain(`ShellExecuteEx ${text}`);
    });

    it.each([
      [2, "Win32 错误码 2，找不到该文件或程序"],
      [3, "Win32 错误码 3，找不到该路径"],
      [5, "Win32 错误码 5，拒绝访问"],
      [8, "Win32 错误码 8，内存不足"],
      [740, "Win32 错误码 740，需要管理员权限"],
      [1155, "Win32 错误码 1155，没有与该文件类型关联的程序"],
      [1223, "Win32 错误码 1223，操作被取消"],
      [1260, "Win32 错误码 1260）"],
    ])("hInstApp 没给原因、GetLastError = %s → ShellExecuteEx 失败，%s", async (lastError, text) => {
      const { err } = await failure({ ok: false, lastError });
      expect(err.message).toContain(`ShellExecuteEx 失败，${text}`);
    });

    it("GetLastError 的 31 是 ERROR_GEN_FAILURE，不是 SE_ERR_NOASSOC：只给数字，不套用「没有关联程序」", async () => {
      const { err } = await failure({ ok: false, lastError: 31 });
      expect(err.message).toContain("ShellExecuteEx 失败，Win32 错误码 31）");
      expect(err.message).not.toMatch(/关联/);
    });

    it("hInstApp 有值（1..32）时只用它，不再提 GetLastError", async () => {
      const { err } = await failure({ ok: false, hInstApp: 2, lastError: 1155 });
      expect(err.message).toContain("ShellExecuteEx 返回 2，找不到该文件或程序");
      expect(err.message).not.toMatch(/1155|Win32 错误码|关联/);
    });

    it("hInstApp > 32（不是错误码）时忽略它，改用 GetLastError", async () => {
      const { err } = await failure({ ok: false, hInstApp: 33, lastError: 1155 });
      expect(err.message).toContain("ShellExecuteEx 失败，Win32 错误码 1155，没有与该文件类型关联的程序");
      expect(err.message).not.toContain("返回 33");
    });

    it("两个都没给原因：「系统没有给出具体原因」（hInstApp = 0 读回 null，GetLastError = 0）", async () => {
      const { err } = await failure({ ok: false });
      expect(err.message).toContain("ShellExecuteEx 失败，系统没有给出具体原因");
    });

    it("GetLastError 抛错 / 没绑上：同样退到「没有给出具体原因」，不影响后面的回退", async () => {
      const extras: FakeOptions[] = [
        {
          impls: {
            GetLastError: () => {
              throw new Error("x");
            },
          },
        },
        { missing: ["GetLastError"] },
      ];
      for (const extra of extras) {
        const { err } = await failure({ ok: false }, extra);
        expect(err.message).toContain("系统没有给出具体原因");
        expect(err.message).toContain("也没找到进程名或窗口标题包含它的窗口"); // 回退照常往下走
      }
    });

    it("GetLastError 紧跟在失败的 ShellExecuteExW 之后读（中间不插别的 FFI 调用，否则 last error 会被冲掉）", async () => {
      const { calls } = await failure({ ok: false, lastError: 1155 });
      expect(names(calls).slice(0, 2)).toEqual(["ShellExecuteExW", "GetLastError"]);
    });

    it("hInstApp 以 BigInt 写回（真 koffi 的形态）也能读：2n → 2", async () => {
      const { err } = await failure({ ok: false, hInstApp: 5 }); // 夹具写回的就是 BigInt(5)
      expect(err.message).toContain("ShellExecuteEx 返回 5，拒绝访问");
    });
  });

  // ───────────────────────── 回退顺序 ─────────────────────────

  describe("回退顺序：ShellExecuteEx → 已运行的窗口 → 开始菜单快捷方式；哪一步成功就不走后面的步骤", () => {
    const WECHAT_LNK = inMenu(PROGRAM_DATA, "微信.lnk");

    it("① 系统直接打开成功：只有一次 ShellExecuteExW，不枚举窗口、不读开始菜单", async () => {
      const { driver, calls } = await ready({ startMenu: { programData: lnks("notepad") } });
      await driver.openApp("notepad");
      expect(steps(calls)).toEqual(["ex:notepad"]);
      expect(dirReads(calls)).toEqual([]);
    });

    it("② 系统打不开、窗口命中：切到前台就结束——不读开始菜单，也没有第二次 ShellExecuteExW（开始菜单里明明有同名快捷方式）", async () => {
      const { driver, calls } = await ready({ shellEx: FAIL, startMenu: { programData: lnks("微信") } });
      await driver.openApp("微信");
      expect(steps(calls)).toEqual(["ex:微信", "enum", "focus"]);
      expect(dirReads(calls)).toEqual([]);
    });

    it("③ 窗口里也没有：读开始菜单，命中就 ShellExecuteExW 那个 .lnk 的绝对路径，成功就结束", async () => {
      const { driver, calls } = await ready({
        shellEx: onlyFails("微信"),
        windows: [],
        processes: {},
        startMenu: { programData: lnks("微信") },
      });
      await expect(driver.openApp("微信")).resolves.toBeUndefined();
      expect(steps(calls)).toEqual(["ex:微信", "enum", "menu", `ex:${WECHAT_LNK}`]);
    });

    it("④ 命中的快捷方式也打不开：失败；错误里有各步的原因，没有第三次尝试", async () => {
      const { driver, calls } = await ready({ shellEx: FAIL, windows: [], processes: {}, startMenu: { programData: lnks("微信") } });
      const err = await catchError(() => driver.openApp("微信"));
      expect(steps(calls)).toEqual(["ex:微信", "enum", "menu", `ex:${WECHAT_LNK}`]);
      expect(err).toMatchObject({ name: "DesktopError", code: "INTERNAL" });
      expect(err.message).toContain("系统无法直接打开它（ShellExecuteEx 返回 2，找不到该文件或程序）");
      expect(err.message).toContain("开始菜单里找到快捷方式「微信」，但打开它也失败了（ShellExecuteEx 返回 2，找不到该文件或程序）");
    });

    it("⑤ 开始菜单里没有匹配：失败，不再有第二次 ShellExecuteExW", async () => {
      const { driver, calls } = await ready({ shellEx: FAIL, windows: [], processes: {}, startMenu: { programData: lnks("别的应用") } });
      const err = await catchError(() => driver.openApp("微信"));
      expect(steps(calls)).toEqual(["ex:微信", "enum", "menu"]);
      expect(err.message).toContain("开始菜单里也没有名字匹配的快捷方式");
    });

    it("⑥ 枚举窗口出错不拦住后面的步骤：照样去开始菜单找，命中就成功", async () => {
      const { driver, calls } = await ready({
        shellEx: onlyFails("abc"),
        impls: { EnumWindows: () => 0 },
        startMenu: { appData: lnks("abc") },
      });
      await expect(driver.openApp("abc")).resolves.toBeUndefined();
      expect(steps(calls)).toEqual(["ex:abc", "enum", "menu", `ex:${path.win32.join(menuDir(APP_DATA), "abc.lnk")}`]);
    });

    it("⑦ 窗口命中但 SetForegroundWindow 被前台保护拒绝：报错，不再往后走（不读开始菜单、不再 ShellExecuteExW）", async () => {
      const { driver, calls } = await ready({
        shellEx: FAIL,
        impls: { SetForegroundWindow: () => 0 },
        startMenu: { programData: lnks("微信") },
      });
      await expect(driver.openApp("微信")).rejects.toThrow(/没能切到前台/);
      expect(steps(calls)).toEqual(["ex:微信", "enum", "focus"]);
    });

    it("⑧ 目标带路径：打不开 → 窗口命中则切前台", async () => {
      const target = "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe";
      const { driver, calls } = await ready({ shellEx: FAIL, startMenu: { programData: lnks("WeChat") } });
      await driver.openApp(target);
      expect(steps(calls)).toEqual([`ex:${target}`, "enum", "focus"]);
    });

    it.each([
      ["C:\\Apps\\nonexist.exe", "nonexist"],
      ["C:\\Users\\alice\\Desktop\\nonexist.lnk", "nonexist"],
      ["c:/apps/nonexist.exe", "nonexist"],
    ])("⑨ 目标带路径 %s：窗口也没有就报错，不搜开始菜单（宁可报找不到，也不换成名字相近的别的程序）", async (target, shortcut) => {
      const { driver, calls } = await ready({ shellEx: FAIL, windows: [], processes: {}, startMenu: { programData: lnks(shortcut) } });
      const err = await catchError(() => driver.openApp(target));
      expect(steps(calls)).toEqual([`ex:${target}`, "enum"]);
      expect(dirReads(calls)).toEqual([]);
      expect(err.message).not.toMatch(/开始菜单/);
    });

    it("⑩ 读开始菜单期间没有任何 FFI 调用（纯 Node fs，不走 FFI）", async () => {
      const { driver, calls } = await ready({
        shellEx: onlyFails("abc"),
        windows: [],
        processes: {},
        startMenu: { programData: { 厂商: lnks("abc 工具") }, appData: lnks("abc") },
      });
      await driver.openApp("abc");
      const timeline = names(calls);
      const first = timeline.indexOf("fs.readdir");
      const last = timeline.lastIndexOf("fs.readdir");
      expect(last).toBeGreaterThan(first); // 至少读了两个目录
      expect(timeline.slice(first, last + 1).every((name) => name === "fs.readdir")).toBe(true);
    });
  });

  // ───────────────────────── 开始菜单快捷方式搜索 ─────────────────────────

  describe("开始菜单快捷方式搜索（Programs 目录下的 .lnk）", () => {
    type Menu = NonNullable<FakeOptions["startMenu"]>;
    /** target 本身打不开、窗口里也没有 → 走开始菜单。opened = 最终交给 ShellExecuteExW 的 .lnk（没命中是 null） */
    const search = async (target: string, startMenu: Menu, extra: FakeOptions = {}) => {
      const { driver, calls } = await ready({ shellEx: onlyFails(target), windows: [], processes: {}, startMenu, ...extra });
      const err = await driver.openApp(target).then(
        () => null,
        (e: Error) => e,
      );
      return { opened: exFiles(calls).slice(1)[0] ?? null, err, calls };
    };
    const inAppData = (...parts: string[]) => path.win32.join(menuDir(APP_DATA), ...parts);

    it("优先级：完全相等 > 以目标开头 > 包含（优先级先于名字长短）", async () => {
      expect((await search("wechat", { programData: lnks("My WeChat", "WeChat Work", "WeChat") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat.lnk"));
      // 以目标开头的 "WeChat Work"（11）比包含的 "My WeChat"（9）长，仍然是它赢
      expect((await search("wechat", { programData: lnks("My WeChat", "WeChat Work") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat Work.lnk"));
      expect((await search("wechat", { programData: lnks("My WeChat", "Tool") })).opened).toBe(inMenu(PROGRAM_DATA, "My WeChat.lnk"));
    });

    it("不区分大小写：目标、快捷方式名、.lnk 后缀都是", async () => {
      expect((await search("WECHAT", { programData: { "wechat.LNK": null } })).opened).toBe(inMenu(PROGRAM_DATA, "wechat.LNK"));
      expect((await search("WeChat", { programData: { "WECHAT.lnk": null } })).opened).toBe(inMenu(PROGRAM_DATA, "WECHAT.lnk"));
    });

    it("目标里的 .exe / .lnk 后缀先去掉再比名字", async () => {
      expect((await search("wechat.exe", { programData: lnks("WeChat") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat.lnk"));
      expect((await search("WECHAT.EXE", { programData: lnks("WeChat") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat.lnk"));
      expect((await search("微信.lnk", { programData: lnks("微信") })).opened).toBe(inMenu(PROGRAM_DATA, "微信.lnk"));
    });

    it("目标只有 1 个字符时只认完全相等；以目标开头 / 包含都要求目标至少 2 个字符", async () => {
      expect((await search("a", { programData: lnks("a", "ab") })).opened).toBe(inMenu(PROGRAM_DATA, "a.lnk"));
      const miss = await search("a", { programData: lnks("ab", "bar", "A Tool") });
      expect(miss.opened).toBeNull();
      expect(miss.err?.message).toContain("开始菜单里也没有名字匹配的快捷方式");
      expect((await search("we", { programData: lnks("WeChat") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat.lnk")); // 2 个字符：开头匹配
      expect((await search("at", { programData: lnks("WeChat") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat.lnk")); // 2 个字符：包含匹配
    });

    it("名字里有 uninstall / 卸载（不分大小写）的一律排除，哪怕它是完全相等的唯一候选", async () => {
      const uninstallers = lnks("Uninstall WeChat", "WECHAT UNINSTALL", "WeChat Uninstaller", "卸载微信", "微信卸载程序");
      for (const target of ["wechat", "uninstall wechat", "微信", "卸载微信"]) {
        const result = await search(target, { programData: uninstallers });
        expect(result.opened, target).toBeNull();
        expect(result.err?.message, target).toContain("开始菜单里也没有名字匹配的快捷方式");
      }
    });

    it("排除只针对卸载程序本身：同时有正常的快捷方式就选正常的；名字里没有 uninstall 字样的不被误伤", async () => {
      expect((await search("wechat", { programData: lnks("Uninstall WeChat", "WeChat Helper") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat Helper.lnk"));
      expect((await search("微信", { programData: lnks("卸载微信", "微信") })).opened).toBe(inMenu(PROGRAM_DATA, "微信.lnk"));
      expect((await search("un-install tool", { programData: lnks("Un-Install Tool") })).opened).toBe(inMenu(PROGRAM_DATA, "Un-Install Tool.lnk"));
    });

    it("同一优先级里取名字最短的", async () => {
      const result = await search("wechat", { programData: lnks("WeChat Pro Max", "WeChat Lite", "WeChat Pro") });
      expect(result.opened).toBe(inMenu(PROGRAM_DATA, "WeChat Pro.lnk"));
    });

    it("名字一样长再按完整路径的字典序：同目录 A 在 B 前；子目录 Tencent\\ 在 WeChat.lnk 前；后扫描的根路径更小时它赢", async () => {
      expect((await search("wechat", { programData: lnks("WeChat B", "WeChat A") })).opened).toBe(inMenu(PROGRAM_DATA, "WeChat A.lnk"));
      // 同名同长：Programs\Tencent\WeChat.lnk vs Programs\WeChat.lnk——比的是完整路径，"T" 排在 "W" 之前
      expect((await search("wechat", { programData: { Tencent: lnks("WeChat"), "WeChat.lnk": null } })).opened).toBe(inMenu(PROGRAM_DATA, "Tencent", "WeChat.lnk"));
      // ProgramData 先扫，但 APPDATA 的路径（C:\Aaa\…）字典序更小：靠字典序而不是扫描顺序
      const aaa = "C:\\Aaa\\Roaming";
      const result = await search("wechat", { programData: lnks("WeChat"), appData: lnks("WeChat") }, { env: { ProgramData: PROGRAM_DATA, APPDATA: aaa } });
      expect(result.opened).toBe(path.win32.join(menuDir(aaa), "WeChat.lnk"));
    });

    it("结果不依赖文件系统返回条目的顺序（顺序 / 倒序一致）", async () => {
      const cases: Array<[string, Menu, string]> = [
        ["wechat", { programData: lnks("WeChat B", "WeChat A") }, inMenu(PROGRAM_DATA, "WeChat A.lnk")],
        ["wechat", { programData: lnks("WeChat Pro Max", "WeChat Lite", "WeChat Pro") }, inMenu(PROGRAM_DATA, "WeChat Pro.lnk")],
        ["wechat", { programData: { Tencent: lnks("WeChat"), "WeChat.lnk": null } }, inMenu(PROGRAM_DATA, "Tencent", "WeChat.lnk")],
      ];
      for (const [target, startMenu, expected] of cases) {
        for (const reverseEntries of [false, true]) {
          expect((await search(target, startMenu, { reverseEntries })).opened, `${expected} reverse=${reverseEntries}`).toBe(expected);
        }
      }
    });

    it("命中后交给 ShellExecuteExW 的是 .lnk 的完整路径（不是名字）；快捷方式名里的空格 / & / 括号原样传", async () => {
      const result = await search("tom", { programData: { "Tom & Jerry (2.0).lnk": null } });
      expect(result.opened).toBe(inMenu(PROGRAM_DATA, "Tom & Jerry (2.0).lnk"));
    });

    it("只看 .lnk 文件：.exe / .txt / .url / 无后缀 / .lnk.txt 都不算；叫 x.lnk 的目录不是快捷方式；符号链接既不当文件也不进入", async () => {
      const tree: Tree = {
        "微信.exe": null,
        "微信.txt": null,
        "微信.url": null,
        微信: null,
        "微信.lnk.txt": null,
        微信xlnk: null, // 名字以 lnk 结尾，但前面没有点
        "微信 目录.lnk": { "说明.txt": null },
        "微信 链接.lnk": "symlink",
        链接目录: "symlink",
      };
      const miss = await search("微信", { programData: tree });
      expect(miss.opened).toBeNull();
      expect(dirReads(miss.calls)).toContain(inMenu(PROGRAM_DATA, "微信 目录.lnk")); // 目录会进去看（里面没有 .lnk）
      expect(dirReads(miss.calls)).not.toContain(inMenu(PROGRAM_DATA, "链接目录")); // 符号链接不跟随
      expect((await search("微信", { programData: { ...tree, "微信.lnk": null } })).opened).toBe(inMenu(PROGRAM_DATA, "微信.lnk"));
    });

    it("目标只有后缀（.exe）时，名字退回整个目标，不会拿空名字去匹配名字为空的快捷方式（.lnk）", async () => {
      const result = await search(".exe", { programData: { ".lnk": null, "别的.lnk": null } });
      expect(result.opened).toBeNull();
    });

    it("深度上限 3：Programs 根算第 0 层，最多进到第 3 层的子目录；更深的目录不读、里面的快捷方式不匹配", async () => {
      const nested = (depth: number, leaf: Tree): Tree => (depth === 0 ? leaf : { d: nested(depth - 1, leaf) });
      for (const depth of [0, 1, 2, 3]) {
        const hit = await search("微信", { programData: nested(depth, lnks("微信")) });
        expect(hit.opened, `深度 ${depth}`).toBe(inMenu(PROGRAM_DATA, ...Array<string>(depth).fill("d"), "微信.lnk"));
      }
      const tooDeep = await search("微信", { programData: nested(4, lnks("微信")) });
      expect(tooDeep.opened).toBeNull();
      expect(dirReads(tooDeep.calls)).toEqual([
        menuDir(PROGRAM_DATA),
        inMenu(PROGRAM_DATA, "d"),
        inMenu(PROGRAM_DATA, "d", "d"),
        inMenu(PROGRAM_DATA, "d", "d", "d"), // 第 3 层：读了；它下面的第 4 层没读
        menuDir(APP_DATA), // 不存在的 APPDATA 目录：读了一次，失败，跳过
      ]);
    });

    describe("条目上限 3000（文件 + 子目录都算，累计，按名字排序后截断）", () => {
      /** f0000.txt … 都排在 "zz.lnk" / "zdir" 之前 */
      const fillers = (count: number): Tree => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${String(i).padStart(4, "0")}.txt`, null]));

      it("单个目录：第 3000 个条目还看，第 3001 个不看", async () => {
        const hit = await search("zz", { programData: { ...fillers(2999), "zz.lnk": null } }); // zz.lnk 是第 3000 个
        expect(hit.opened).toBe(inMenu(PROGRAM_DATA, "zz.lnk"));
        const miss = await search("zz", { programData: { ...fillers(3000), "zz.lnk": null } }); // 第 3001 个
        expect(miss.opened).toBeNull();
        expect(miss.err?.message).toContain("开始菜单里也没有名字匹配的快捷方式");
      });

      it("截断点由名字排序决定，不依赖文件系统返回顺序（倒序返回，结果相同）", async () => {
        const miss = await search("zz", { programData: { ...fillers(3000), "zz.lnk": null } }, { reverseEntries: true });
        expect(miss.opened).toBeNull();
        const hit = await search("zz", { programData: { ...fillers(2999), "zz.lnk": null } }, { reverseEntries: true });
        expect(hit.opened).toBe(inMenu(PROGRAM_DATA, "zz.lnk"));
      });

      it("累计：跨两个根合计 3000", async () => {
        const hit = await search("zz", { programData: fillers(2000), appData: { ...fillers(999), "zz.lnk": null } }); // 累计第 3000 个
        expect(hit.opened).toBe(inAppData("zz.lnk"));
        const miss = await search("zz", { programData: fillers(2000), appData: { ...fillers(1000), "zz.lnk": null } }); // 累计第 3001 个
        expect(miss.opened).toBeNull();
      });

      it("预算用完就不再读目录：根目录刚好用掉 3000 → 不读第二个根；子目录恰是第 3000 个条目 → 不进去", async () => {
        const full = await search("zz", { programData: fillers(3000), appData: lnks("zz") });
        expect(full.opened).toBeNull();
        expect(dirReads(full.calls)).toEqual([menuDir(PROGRAM_DATA)]);

        const last = await search("zz", { programData: { ...fillers(2999), zdir: lnks("zz") }, appData: lnks("zz") });
        expect(last.opened).toBeNull();
        expect(dirReads(last.calls)).toEqual([menuDir(PROGRAM_DATA)]); // zdir 是第 3000 个条目（看到了），预算已满：不进去，也不去 APPDATA
      });

      it("进了子目录就用剩下的预算：剩 1 个就只看 1 个条目", async () => {
        const menu = (inner: Tree): Menu => ({ programData: { ...fillers(2998), zdir: inner } }); // 根下共 2999 个条目，zdir 是第 2999 个
        expect((await search("a", menu({ "a.lnk": null }))).opened).toBe(inMenu(PROGRAM_DATA, "zdir", "a.lnk")); // 子目录第 1 个 = 总第 3000 个：看
        expect((await search("zz", menu({ "a.txt": null, "zz.lnk": null }))).opened).toBeNull(); // 子目录第 2 个 = 总第 3001 个：不看
      });
    });

    describe("目录缺失 / 读不了", () => {
      it("两个 Programs 目录都不存在：不抛 fs 错；先读 ProgramData 再读 APPDATA；提示「没能读取开始菜单目录」", async () => {
        const result = await search("微信", {});
        expect(result.opened).toBeNull();
        expect(dirReads(result.calls)).toEqual([menuDir(PROGRAM_DATA), menuDir(APP_DATA)]);
        expect(result.err?.message).toContain("也没能读取开始菜单目录（没法按快捷方式查找）");
      });

      it("只有一个目录存在：另一个缺失照样搜到", async () => {
        expect((await search("微信", { programData: lnks("微信") })).opened).toBe(inMenu(PROGRAM_DATA, "微信.lnk"));
        expect((await search("微信", { appData: lnks("微信") })).opened).toBe(inAppData("微信.lnk"));
      });

      it("根目录读取失败（没权限）：跳过它，另一个照常；两个都失败 = 没能读取", async () => {
        const one = await search("微信", { programData: lnks("微信"), appData: lnks("微信") }, { unreadable: [menuDir(PROGRAM_DATA)] });
        expect(one.opened).toBe(inAppData("微信.lnk"));
        const both = await search("微信", { programData: lnks("微信"), appData: lnks("微信") }, { unreadable: [menuDir(PROGRAM_DATA), menuDir(APP_DATA)] });
        expect(both.opened).toBeNull();
        expect(both.err?.message).toContain("也没能读取开始菜单目录");
      });

      it("子目录读取失败：只跳过那个子目录，兄弟目录里的快捷方式照常能找到", async () => {
        const menu: Menu = { programData: { 厂商A: lnks("目标应用"), 厂商B: lnks("目标应用 Pro") } };
        const result = await search("目标应用", menu, { unreadable: [inMenu(PROGRAM_DATA, "厂商A")] });
        expect(result.opened).toBe(inMenu(PROGRAM_DATA, "厂商B", "目标应用 Pro.lnk"));
      });

      it("目录读到了但里面没有匹配：「没有名字匹配的快捷方式」，和「没能读取」是两种说法", async () => {
        const result = await search("微信", { programData: {} });
        expect(result.err?.message).toContain("开始菜单里也没有名字匹配的快捷方式");
        expect(result.err?.message).not.toContain("没能读取");
      });
    });

    describe("目录来源：只接受盘符开头的绝对路径（UNC / 相对 / 缺失一律不碰，不为找快捷方式去访问网络位置）", () => {
      it.each([
        ["缺失", {}],
        ["空字符串", { ProgramData: "", APPDATA: "" }],
        ["相对路径", { ProgramData: "ProgramData", APPDATA: "AppData\\Roaming" }],
        ["UNC", { ProgramData: "\\\\server\\share", APPDATA: "//server/profiles/alice/AppData/Roaming" }],
        ["盘符后没有分隔符", { ProgramData: "C:ProgramData", APPDATA: "D:Users" }],
      ] as Array<[string, Record<string, string>]>)("环境变量%s：不读任何目录（哪怕那个位置上真有数据）", async (_label, env) => {
        const result = await search("微信", { programData: lnks("微信"), appData: lnks("微信") }, { env });
        expect(result.opened).toBeNull();
        expect(dirReads(result.calls)).toEqual([]);
        expect(result.err?.message).toContain("也没能读取开始菜单目录");
      });

      it("只有一个变量合法：只读那一个；正斜杠的盘符路径也接受（规范成反斜杠）", async () => {
        const unc = await search("微信", { programData: lnks("微信") }, { env: { ProgramData: PROGRAM_DATA, APPDATA: "\\\\server\\profiles\\alice" } });
        expect(dirReads(unc.calls)).toEqual([menuDir(PROGRAM_DATA)]);
        expect(unc.opened).toBe(inMenu(PROGRAM_DATA, "微信.lnk"));

        const slashes = "C:/Users/alice/AppData/Roaming";
        const slash = await search("微信", { appData: lnks("微信") }, { env: { APPDATA: slashes } });
        expect(dirReads(slash.calls)).toEqual([menuDir(slashes)]);
        expect(slash.opened).toBe(path.win32.join(menuDir(slashes), "微信.lnk"));
      });

      it("不注入 env / fs 时：env 取 process.env，fs 用 node:fs/promises 的 readdir（withFileTypes: true）；读失败只是「没能读取」，不抛 fs 的原始错误", async () => {
        const saved = { ProgramData: process.env.ProgramData, APPDATA: process.env.APPDATA };
        process.env.ProgramData = PROGRAM_DATA;
        process.env.APPDATA = APP_DATA;
        realFsSpy.readdirCalls.length = 0;
        try {
          const fake = createFake({ shellEx: FAIL, windows: [], processes: {} });
          const driver = createWin32Driver({ koffi: fake.koffi, platform: "win32" }); // 不传 env / fs
          await driver.init();
          const err = await catchError(() => driver.openApp("不存在的应用-xyz-12345"));
          expect(realFsSpy.readdirCalls).toEqual([
            [menuDir(PROGRAM_DATA), { withFileTypes: true }],
            [menuDir(APP_DATA), { withFileTypes: true }],
          ]);
          expect(err).toMatchObject({ name: "DesktopError", code: "INTERNAL" });
          expect(err.message).toContain("也没能读取开始菜单目录");
          expect(err.message).not.toMatch(/ENOENT|假错误|scandir/);
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) Reflect.deleteProperty(process.env, key);
            else process.env[key] = value;
          }
        }
      });
    });
  });

  // ───────────────────────── ShellExecuteExW 不可用 → 退回 ShellExecuteW ─────────────────────────

  describe("ShellExecuteExW 不可用时退回 ShellExecuteW（init 照常成功，原因在 diagnostics 里）", () => {
    const legacy = (options: FakeOptions = {}) => ready({ missing: ["ShellExecuteExW"], ...options });
    const ARGS_AFTER_NAME = [null, "open"]; // ShellExecuteW 的 (hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd) 的前两项

    it("交给 ShellExecuteW：(NULL, \"open\", target, NULL, NULL, SW_SHOWNORMAL)，成功就不再枚举窗口", async () => {
      const { driver, calls } = await legacy({ shellResult: 42 });
      await driver.openApp("notepad");
      expect(calls).toEqual([{ fn: "ShellExecuteW", args: [...ARGS_AFTER_NAME, "notepad", null, null, 1] }]);
    });

    it("返回值 > 32 才算成功：33 成功，32 失败", async () => {
      await expect((await legacy({ shellResult: 33 })).driver.openApp("x1")).resolves.toBeUndefined();
      await expect((await legacy({ shellResult: 32, windows: [] })).driver.openApp("x1")).rejects.toThrow(/打开「x1」失败/);
    });

    it("SHELLEXECUTEINFOW 大小对不上 / 定义失败导致的降级，走的是同一条 ShellExecuteW 路径", async () => {
      for (const options of [{ sizes: { SHELLEXECUTEINFOW: 100 } }, { structFails: ["SHELLEXECUTEINFOW"] }]) {
        const { driver, calls } = await ready(options);
        await driver.openApp("notepad");
        expect(names(calls)).toEqual(["ShellExecuteW"]);
      }
    });

    it("降级路径同样先校验目标：不合格的一个系统函数都不调", async () => {
      const { driver, calls } = await legacy();
      for (const bad of ["https://example.com", "\\\\server\\share\\a.exe", "setup.bat", "a|b"]) {
        await expect(driver.openApp(bad)).rejects.toMatchObject({ code: "BAD_ARGS" });
      }
      expect(calls).toEqual([]);
    });

    it("降级路径同样走「窗口 → 开始菜单」，开始菜单命中的 .lnk 也用 ShellExecuteW 打开", async () => {
      const impls = { ShellExecuteW: (_hwnd: null, _verb: string, file: string) => (file === "微信" ? 2 : 42) };
      const { driver, calls } = await legacy({ windows: [], processes: {}, startMenu: { programData: lnks("微信") }, impls });
      await driver.openApp("微信");
      expect(steps(calls)).toEqual(["legacy:微信", "enum", "menu", `legacy:${inMenu(PROGRAM_DATA, "微信.lnk")}`]);
    });

    it("失败原因只有 ShellExecuteW 的返回码（没有 hInstApp / GetLastError 那一套），也不读 GetLastError", async () => {
      const failed = async (shellResult: number) => {
        const { driver, calls } = await legacy({ shellResult, windows: [], processes: {} });
        const err = await catchError(() => driver.openApp("abc"));
        expect(ffi(calls, "GetLastError")).toEqual([]);
        expect(err.message).not.toMatch(/Win32 错误码|ShellExecuteEx /);
        return err.message;
      };
      expect(await failed(0)).toContain("ShellExecute 返回 0，系统资源不足");
      expect(await failed(2)).toContain("ShellExecute 返回 2，找不到该文件或程序");
      expect(await failed(31)).toContain("ShellExecute 返回 31，没有与该文件类型关联的程序");
      expect(await failed(28)).toContain("ShellExecute 返回 28）");
    });

    it("ShellExecuteW 自己抛错（koffi 层）：带中文上下文", async () => {
      const { driver } = await legacy({
        impls: {
          ShellExecuteW: () => {
            throw new Error("bad arg");
          },
        },
      });
      await expect(driver.openApp("abc")).rejects.toThrow(/调用 Win32 ShellExecuteW 出错：bad arg/);
    });

    it("两个 ShellExecute 都绑不上：UNSUPPORTED「缺少 Win32 函数 ShellExecuteW」，且没去枚举窗口", async () => {
      const { driver, calls } = await ready({ missing: ["ShellExecuteExW", "ShellExecuteW"] });
      const err = await catchError(() => driver.openApp("abc"));
      expect(err).toMatchObject({ name: "DesktopError", code: "UNSUPPORTED" });
      expect(err.message).toMatch(/缺少 Win32 函数 ShellExecuteW/);
      expect(calls).toEqual([]);
    });

    it("ShellExecuteExW 可用时，ShellExecuteW 一次都不会被调用（包括各步回退里）", async () => {
      const { driver, calls } = await ready({ shellEx: onlyFails("微信"), windows: [], processes: {}, startMenu: { programData: lnks("微信") } });
      await driver.openApp("微信");
      expect(ffi(calls, "ShellExecuteW")).toEqual([]);
    });
  });

  // ───────────────────────── 失败信息 ─────────────────────────

  describe("失败信息", () => {
    it("都找不到：中文错误里有目标名、各步原因的人话、自修复提示（整句钉死）", async () => {
      const { driver } = await ready({ shellEx: FAIL, windows: [], processes: {}, startMenu: { programData: {} } });
      const err = await catchError(() => driver.openApp("不存在的应用"));
      expect(err).toMatchObject({ name: "DesktopError", code: "INTERNAL" });
      expect(err.message).toBe(
        "打开「不存在的应用」失败：系统无法直接打开它（ShellExecuteEx 返回 2，找不到该文件或程序），也没找到进程名或窗口标题包含它的窗口，开始菜单里也没有名字匹配的快捷方式。请先列出正在运行的应用确认名称，或改传完整的 exe 路径",
      );
    });

    it("目标带路径时没有开始菜单那一段（根本没搜）", async () => {
      const { driver } = await ready({ shellEx: FAIL, windows: [], processes: {} });
      const err = await catchError(() => driver.openApp("C:\\Apps\\nonexist.exe"));
      expect(err.message).toBe(
        "打开「C:\\Apps\\nonexist.exe」失败：系统无法直接打开它（ShellExecuteEx 返回 2，找不到该文件或程序），也没找到进程名或窗口标题包含它的窗口。请先列出正在运行的应用确认名称，或改传完整的 exe 路径",
      );
    });

    it("找到了窗口但 SetForegroundWindow 被前台锁拒绝：说清楚原因和办法，不假装成功", async () => {
      const { driver } = await ready({ shellEx: FAIL, impls: { SetForegroundWindow: () => 0 } });
      const err = await catchError(() => driver.openApp("微信"));
      expect(err.message).toMatch(/找到了「WeChat」的窗口，但没能切到前台/);
      expect(err.message).toMatch(/前台保护/);
    });

    it("回退时枚举窗口也出错：错误里同时有 ShellExecuteEx 的失败和枚举的失败，并且仍然去开始菜单找过", async () => {
      const { driver } = await ready({
        shellEx: { ok: false, hInstApp: 5 },
        impls: { EnumWindows: () => 0 },
        startMenu: { programData: {} },
      });
      const err = await catchError(() => driver.openApp("abc"));
      expect(err.message).toMatch(/ShellExecuteEx 返回 5，拒绝访问/);
      expect(err.message).toMatch(/查找窗口时又出错：枚举窗口失败/);
      expect(err.message).toContain("开始菜单里也没有名字匹配的快捷方式");
    });

    it("目标回显最多 60 个字符，超出的用「…」收尾", async () => {
      const { driver } = await ready({ shellEx: FAIL, windows: [], processes: {} });
      const err = await catchError(() => driver.openApp("a".repeat(200)));
      expect(err.message).toContain(`打开「${"a".repeat(60)}…」失败`);
      expect(err.message).not.toContain("a".repeat(61));
    });

    it("不泄露多余内容：没有目录路径 / 环境变量 / 用户名 / fs 原始报错，也没有 cause（各种失败场景）", async () => {
      const scenarios: FakeOptions[] = [
        {}, // 两个目录都不存在（ENOENT）
        { startMenu: { programData: lnks("别的应用") }, unreadable: [menuDir(APP_DATA)] }, // 一个目录没权限（EACCES）
        { startMenu: { programData: { 厂商: lnks("x") } }, unreadable: [inMenu(PROGRAM_DATA, "厂商")] }, // 子目录没权限
        { startMenu: { appData: lnks("abc") } }, // 命中了快捷方式但它也打不开
      ];
      const leaks = ["ProgramData", "AppData", "Roaming", "alice", "Users", "Start Menu", "Programs", "Microsoft", "C:\\", ".lnk", "ENOENT", "EACCES", "scandir", "permission denied", "no such file"];
      for (const extra of scenarios) {
        const { driver } = await ready({ shellEx: FAIL, windows: [], processes: {}, ...extra });
        const err = await catchError(() => driver.openApp("abc"));
        for (const leak of leaks) expect(err.message, `${leak} ← ${JSON.stringify(extra)}`).not.toContain(leak);
        expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
      }
    });

    it("命中的快捷方式打不开时，错误里只有它的显示名，没有它的路径", async () => {
      const { driver } = await ready({ shellEx: FAIL, windows: [], processes: {}, startMenu: { programData: { 厂商: lnks("秘密工具") } } });
      const err = await catchError(() => driver.openApp("秘密工具"));
      expect(err.message).toContain("开始菜单里找到快捷方式「秘密工具」，但打开它也失败了");
      expect(err.message).not.toMatch(/厂商|ProgramData|\.lnk/);
    });
  });
});

// ═══════════════════════════ 电源 / 锁屏 ═══════════════════════════

describe("wakeDisplay / lockScreen", () => {
  it("wakeDisplay：两次相对 MOVE（dx=+1 再 −1），中间停 30ms；不带按钮标志，不用绝对坐标", async () => {
    const { driver, calls, sleeps } = await ready();
    await driver.wakeDisplay();
    expect(names(calls)).toEqual(["SendInput", "sleep", "SendInput"]);
    expect(sleeps).toEqual([30]);
    expect(events(calls).map((e) => [e.type, mi(e).dwFlags, mi(e).dx, mi(e).dy, mi(e).mouseData])).toEqual([
      [0, 0x1, 1, 0, 0],
      [0, 0x1, -1, 0, 0],
    ]);
  });

  it("wakeDisplay 注入失败：抛错（不吞）", async () => {
    const { driver } = await ready({ impls: { SendInput: () => 0 } });
    await expect(driver.wakeDisplay()).rejects.toThrow(/拒绝了输入注入/);
  });

  it("lockScreen：调用 LockWorkStation 一次；返回 0 → 带错误码的中文错误", async () => {
    const ok = await ready();
    await ok.driver.lockScreen();
    expect(ok.calls).toEqual([{ fn: "LockWorkStation", args: [] }]);

    const { driver } = await ready({ impls: { LockWorkStation: () => 0 } });
    const err = await catchError(() => driver.lockScreen());
    expect(err.message).toMatch(/锁定电脑失败.*Win32 错误码 5.*组策略/);
  });
});

describe("DesktopDriver 契约", () => {
  it("实现了 types.mjs 里要求的全部方法，platform 为 win32", async () => {
    const { driver } = await ready();
    const required = [
      "init",
      "diagnostics",
      "isScreenLocked",
      "idleSeconds",
      "getPrimaryDisplay",
      "mouseMove",
      "click",
      "drag",
      "scroll",
      "keyCombo",
      "typeText",
      "frontmostApp",
      "listApps",
      "openApp",
      "wakeDisplay",
      "lockScreen",
    ] as const;
    for (const name of required) expect(typeof (driver as Driver)[name], name).toBe("function");
    expect(driver.platform).toBe("win32");
  });

  it("drag / click / openApp / wakeDisplay / lockScreen / typeText 返回 Promise；其余同步", async () => {
    const { driver } = await ready();
    expect(driver.drag({ x: 0, y: 0 }, { x: 1, y: 1 }, { durationMs: 0 })).toBeInstanceOf(Promise);
    expect(driver.click(1, 1)).toBeInstanceOf(Promise);
    expect(driver.typeText("a")).toBeInstanceOf(Promise);
    expect(driver.wakeDisplay()).toBeInstanceOf(Promise);
    expect(driver.lockScreen()).toBeInstanceOf(Promise);
    expect(driver.openApp("notepad")).toBeInstanceOf(Promise);
    expect(driver.mouseMove(1, 1)).toBeUndefined();
    expect(driver.scroll(1, 1, 0, 1)).toBeUndefined();
    expect(driver.keyCombo({ mods: [], key: "a" })).toBeUndefined();
  });
});
