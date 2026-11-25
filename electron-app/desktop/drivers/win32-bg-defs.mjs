/**
 * Windows「锁屏后台档」用到的 Win32 定义：常量 / 结构体 / 函数原型。
 *
 * 为什么单独一个文件、不并进 win32-defs.mjs：
 * - 后台档是「电脑锁屏时」才用的另一条路（PostMessage 投递输入 + PrintWindow 逐窗口截图），和前台的 SendInput 路径互不依赖；
 * - 这些函数在驱动 init 时不绑定，第一次用后台档才由 win32-background.mjs 懒加载（gdi32 也是那时才 load），
 *   所以前台路径的行为、诊断、绑定清单完全不受影响。
 *
 * ⚠️ 前提同 win32.mjs：项目里没有 Windows 机器，这里只有「原型字符串能被 koffi 解析 / 结构体布局对得上」的 Mac 侧证据，
 * Win32 的真实行为（锁屏时 PrintWindow / PostMessage 到底管不管用）要等 Windows 真机验证。
 */
import { defineWin32Types } from "./win32-defs.mjs";

// ═══════════════════════════ 常量 ═══════════════════════════

/** 窗口消息（winuser.h：WM_*） */
export const WM = Object.freeze({
  CLOSE: 0x0010,
  ACTIVATE: 0x0006,
  SETFOCUS: 0x0007,
  KEYDOWN: 0x0100,
  KEYUP: 0x0101,
  CHAR: 0x0102,
  SYSKEYDOWN: 0x0104,
  SYSKEYUP: 0x0105,
  SYSCHAR: 0x0106,
  CUT: 0x0300,
  COPY: 0x0301,
  PASTE: 0x0302,
  UNDO: 0x0304,
  MOUSEMOVE: 0x0200,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  LBUTTONDBLCLK: 0x0203,
  RBUTTONDOWN: 0x0204,
  RBUTTONUP: 0x0205,
  RBUTTONDBLCLK: 0x0206,
  MBUTTONDOWN: 0x0207,
  MBUTTONUP: 0x0208,
  MBUTTONDBLCLK: 0x0209,
  MOUSEWHEEL: 0x020a,
  MOUSEHWHEEL: 0x020e,
});

/** EM_SETSEL：Edit / RichEdit 控件的「选中范围」消息（wParam = 起点，lParam = 终点；0 与 -1 = 全选） */
export const EM_SETSEL = 0x00b1;

/** WM_ACTIVATE 的 wParam：WA_ACTIVE（被激活，不是点击激活） */
export const WA_ACTIVE = 1;

/** 鼠标消息 wParam 里的按键状态位（MK_*） */
export const MK = Object.freeze({ LBUTTON: 0x0001, RBUTTON: 0x0002, SHIFT: 0x0004, CONTROL: 0x0008, MBUTTON: 0x0010 });

/** PrintWindow 的标志：PW_RENDERFULLCONTENT（Win8.1+）——让 DWM 合成的内容（Chromium / UWP 等）也能画出来 */
export const PW_RENDERFULLCONTENT = 2;

/** GetWindowLongW 的索引：扩展样式 */
export const GWL_EXSTYLE = -20;

/** 扩展窗口样式（WS_EX_*）：只用到「点击穿透的分层窗口」判断 */
export const WS_EX = Object.freeze({ TRANSPARENT: 0x00000020, LAYERED: 0x00080000 });

/** DwmGetWindowAttribute 的属性：DWMWA_EXTENDED_FRAME_BOUNDS（不含 Win10+ 不可见阴影边框的真实窗口矩形） */
export const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

/** ChildWindowFromPointEx 的标志（CWP_*）：跳过不可见 / 禁用 / 透明的子窗口 */
export const CWP = Object.freeze({ SKIPINVISIBLE: 0x0001, SKIPDISABLED: 0x0002, SKIPTRANSPARENT: 0x0004 });

/** GetDIBits：biCompression = BI_RGB（不压缩），usage = DIB_RGB_COLORS */
export const BI_RGB = 0;
export const DIB_RGB_COLORS = 0;

/** 窗口类名：桌面壁纸 / 任务栏这类「系统外壳」窗口不进后台截图和命中测试 */
export const SHELL_CLASS_NAMES = Object.freeze(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

/**
 * Edit / RichEdit 类控件（用 EM_SETSEL / WM_COPY / WM_PASTE 这类「直接对控件说话」的消息就能全选 / 复制 / 粘贴，
 * 不依赖「Ctrl 键当前是否按下」——PostMessage 发出去的按键消息不会改变线程的按键状态表，GetKeyState(VK_CONTROL) 读到的永远是「没按」）。
 * 类名前缀匹配（RichEdit20W / RICHEDIT50W / RichEditD2DPT 等），不区分大小写。
 */
export const EDIT_CLASS_PREFIXES = Object.freeze(["edit", "richedit"]);

// ═══════════════════════════ 结构体 ═══════════════════════════

/**
 * @typedef {Object} BackgroundTypes
 * @property {unknown} POINT              两个 int32，8 字节
 * @property {unknown} BITMAPINFOHEADER   40 字节（GetDIBits 取 32 位像素用，没有颜色表）
 * @property {unknown} GUITHREADINFO      Win64 72 字节（GetGUIThreadInfo：取某个线程的焦点窗口）
 */

/** 同一个 koffi 实例只能定义一次同名类型（再定义会抛 Duplicate type name），所以按实例缓存 */
const typeCache = new WeakMap();

/**
 * 定义后台档用到的结构体。依赖 defineWin32Types 里的 RECT（GUITHREADINFO.rcCaret）。
 * 布局（Win64）：POINT 8；BITMAPINFOHEADER 40（11 个成员，两个 uint16 紧挨着）；
 * GUITHREADINFO：cbSize 0 / flags 4 / 6 个句柄 8..55 / rcCaret 56..71，总 72；Win32 下句柄 4 字节，总 48。
 * @param {{ struct: Function, union: Function, proto: Function }} koffi
 * @returns {BackgroundTypes}
 */
export const defineBackgroundTypes = (koffi) => {
  const cached = typeCache.get(koffi);
  if (cached) return cached;
  const base = defineWin32Types(koffi);
  const POINT = koffi.struct("POINT", { x: "int32_t", y: "int32_t" });
  const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
    biSize: "uint32_t",
    biWidth: "int32_t",
    biHeight: "int32_t", // 负数 = 自上而下（第一行在缓冲区开头），我们用 -height
    biPlanes: "uint16_t",
    biBitCount: "uint16_t",
    biCompression: "uint32_t",
    biSizeImage: "uint32_t",
    biXPelsPerMeter: "int32_t",
    biYPelsPerMeter: "int32_t",
    biClrUsed: "uint32_t",
    biClrImportant: "uint32_t",
  });
  const GUITHREADINFO = koffi.struct("GUITHREADINFO", {
    cbSize: "uint32_t",
    flags: "uint32_t",
    hwndActive: "void *",
    hwndFocus: "void *",
    hwndCapture: "void *",
    hwndMenuOwner: "void *",
    hwndMoveSize: "void *",
    hwndCaret: "void *",
    rcCaret: base.RECT,
  });
  const types = { POINT, BITMAPINFOHEADER, GUITHREADINFO };
  typeCache.set(koffi, types);
  return types;
};

/** Win64 / Win32 下后台档结构体的期望大小（驱动按这个对账；对不上就不启用依赖它的功能） */
export const expectedBackgroundSizes = (pointerSize) => {
  if (pointerSize === 8) return { POINT: 8, BITMAPINFOHEADER: 40, GUITHREADINFO: 72 };
  if (pointerSize === 4) return { POINT: 8, BITMAPINFOHEADER: 40, GUITHREADINFO: 48 };
  return null;
};

/** GetDIBits 的入参：32 位、自上而下、不压缩。所有成员显式写满、类型与上面的声明严格一致（koffi 对类型不符直接 abort 进程） */
export const bitmapInfoHeader = ({ size, width, height }) => ({
  biSize: size,
  biWidth: width,
  biHeight: -height,
  biPlanes: 1,
  biBitCount: 32,
  biCompression: BI_RGB,
  biSizeImage: 0,
  biXPelsPerMeter: 0,
  biYPelsPerMeter: 0,
  biClrUsed: 0,
  biClrImportant: 0,
});

/** GetGUIThreadInfo 的入参：句柄成员给 null，rcCaret 给全 0 的矩形 */
export const guiThreadInfo = ({ size }) => ({
  cbSize: size,
  flags: 0,
  hwndActive: null,
  hwndFocus: null,
  hwndCapture: null,
  hwndMenuOwner: null,
  hwndMoveSize: null,
  hwndCaret: null,
  rcCaret: { left: 0, top: 0, right: 0, bottom: 0 },
});

// ═══════════════════════════ 函数原型 ═══════════════════════════

/** 用到的系统库（gdi32 只有后台档用到，所以不在前台驱动的 WIN32_LIBRARIES 里） */
export const WIN32_BG_LIBRARIES = Object.freeze({
  user32: "user32.dll",
  gdi32: "gdi32.dll",
  dwmapi: "dwmapi.dll",
});

/**
 * @typedef {Object} Win32BgFunctionSpec
 * @property {'user32'|'gdi32'|'dwmapi'} lib
 * @property {string} name      导出函数名（原型字符串里写的就是它）
 * @property {string} [key]     驱动内部登记用的名字（缺省 = name）；同一个导出用不同原型再绑一次时用（DwmGetWindowAttribute 取矩形）
 * @property {boolean} required 必需：缺任何一个，后台档整体不可用
 * @property {string} [needs]   依赖的结构体名（BackgroundTypes 的成员）：该结构体定义失败 / 大小对不上时这个函数不绑定
 * @property {string} proto     koffi 的 C 原型字符串（写法约定同 win32-defs.mjs 的 WIN32_FUNCTIONS）
 */

/**
 * 每条上面的注释是 Windows SDK 里的官方签名。
 * 约定：HWND / HDC / HBITMAP / HGDIOBJ 一律 void *；WPARAM / LPARAM 用 uintptr_t / intptr_t（Number 传入即可）；
 * 结构体指针出参用 _Inout_（对象写回，LASTINPUTINFO 同款，Mac 上用真 koffi 验证过）；
 * 像素缓冲区用 Node Buffer 当 void *（带不带 _Out_ 都可写）。
 * @type {ReadonlyArray<Win32BgFunctionSpec>}
 */
export const WIN32_BG_FUNCTIONS = Object.freeze([
  // ── 输入：消息投递 ──
  // BOOL PostMessageW(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam);   投递到目标线程的消息队列后立刻返回，不等处理
  { lib: "user32", name: "PostMessageW", required: true, proto: "int __stdcall PostMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)" },
  // BOOL ScreenToClient(HWND hWnd, LPPOINT lpPoint);
  { lib: "user32", name: "ScreenToClient", required: true, needs: "POINT", proto: "int __stdcall ScreenToClient(void *hWnd, _Inout_ POINT *lpPoint)" },
  // HWND ChildWindowFromPointEx(HWND hwndParent, POINT pt, UINT flags);   只找「直接子窗口」，POINT 按值传
  {
    lib: "user32",
    name: "ChildWindowFromPointEx",
    required: false,
    needs: "POINT",
    proto: "void *__stdcall ChildWindowFromPointEx(void *hwndParent, POINT pt, uint32_t flags)",
  },
  // BOOL GetGUIThreadInfo(DWORD idThread, PGUITHREADINFO pgui);   取线程的焦点 / 激活窗口（跨进程可用）
  {
    lib: "user32",
    name: "GetGUIThreadInfo",
    required: false,
    needs: "GUITHREADINFO",
    proto: "int __stdcall GetGUIThreadInfo(uint32_t idThread, _Inout_ GUITHREADINFO *pgui)",
  },
  // int GetClassNameW(HWND hWnd, LPWSTR lpClassName, int nMaxCount);
  { lib: "user32", name: "GetClassNameW", required: false, proto: "int __stdcall GetClassNameW(void *hWnd, _Out_ void *lpClassName, int nMaxCount)" },
  // LONG GetWindowLongW(HWND hWnd, int nIndex);
  { lib: "user32", name: "GetWindowLongW", required: false, proto: "int32_t __stdcall GetWindowLongW(void *hWnd, int nIndex)" },
  // BOOL IsWindow(HWND hWnd);
  { lib: "user32", name: "IsWindow", required: false, proto: "int __stdcall IsWindow(void *hWnd)" },

  // ── 截图：逐窗口 PrintWindow → GetDIBits ──
  // BOOL PrintWindow(HWND hwnd, HDC hdcBlt, UINT nFlags);   向窗口所在线程发 WM_PRINT：窗口无响应时会卡住，所以驱动走 koffi 的 .async
  { lib: "user32", name: "PrintWindow", required: true, proto: "int __stdcall PrintWindow(void *hwnd, void *hdcBlt, uint32_t nFlags)" },
  // HDC GetDC(HWND hWnd);   hWnd = NULL：整个屏幕的 DC
  { lib: "user32", name: "GetDC", required: true, proto: "void *__stdcall GetDC(void *hWnd)" },
  // int ReleaseDC(HWND hWnd, HDC hDC);
  { lib: "user32", name: "ReleaseDC", required: true, proto: "int __stdcall ReleaseDC(void *hWnd, void *hDC)" },
  // HDC CreateCompatibleDC(HDC hdc);
  { lib: "gdi32", name: "CreateCompatibleDC", required: true, proto: "void *__stdcall CreateCompatibleDC(void *hdc)" },
  // HBITMAP CreateCompatibleBitmap(HDC hdc, int cx, int cy);
  { lib: "gdi32", name: "CreateCompatibleBitmap", required: true, proto: "void *__stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)" },
  // HGDIOBJ SelectObject(HDC hdc, HGDIOBJ h);
  { lib: "gdi32", name: "SelectObject", required: true, proto: "void *__stdcall SelectObject(void *hdc, void *h)" },
  // BOOL DeleteObject(HGDIOBJ ho);
  { lib: "gdi32", name: "DeleteObject", required: true, proto: "int __stdcall DeleteObject(void *ho)" },
  // BOOL DeleteDC(HDC hdc);
  { lib: "gdi32", name: "DeleteDC", required: true, proto: "int __stdcall DeleteDC(void *hdc)" },
  // int GetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT cLines, LPVOID lpvBits, LPBITMAPINFO lpbmi, UINT usage);
  //   bmi 只用头部（32 位 BI_RGB 没有颜色表）。位图不能同时被选进某个 DC，取像素前要先把旧位图选回去
  {
    lib: "gdi32",
    name: "GetDIBits",
    required: true,
    needs: "BITMAPINFOHEADER",
    proto: "int __stdcall GetDIBits(void *hdc, void *hbm, uint32_t start, uint32_t cLines, _Out_ void *lpvBits, _Inout_ BITMAPINFOHEADER *lpbmi, uint32_t usage)",
  },
  // HRESULT DwmGetWindowAttribute(HWND hwnd, DWORD dwAttribute, PVOID pvAttribute, DWORD cbAttribute);
  //   与前台驱动里「取 cloaked」是同一个导出、不同的原型（这里取 RECT）：登记名叫 DwmFrameBounds，绑定失败只是退回 GetWindowRect
  {
    lib: "dwmapi",
    name: "DwmGetWindowAttribute",
    key: "DwmFrameBounds",
    required: false,
    proto: "int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)",
  },
]);

/** 必需函数的登记名 */
export const REQUIRED_BG_FUNCTIONS = Object.freeze(WIN32_BG_FUNCTIONS.filter((f) => f.required).map((f) => f.key ?? f.name));
