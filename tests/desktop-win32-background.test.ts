/**
 * Windows 锁屏后台档驱动（electron-app/desktop/drivers/win32-background.mjs + win32-bg-defs.mjs）
 *
 * ⚠️ 前提：项目里没有 Windows 机器。这里能验证的只有「调用序列 / 参数 / 结构体布局 / 资源释放」，不是锁屏时 Windows 的真实行为：
 *  - 锁屏时 PrintWindow(PW_RENDERFULLCONTENT) 画不画得出内容、PostMessage 被不被应用认、WM_ACTIVATE 补丁灵不灵——都要真机；
 *  - 本文件的假 Win32 只模拟「接口约定」：GDI 对象的生命周期（位图不能同时选在 DC 里才能 GetDIBits）、_Inout_ 结构体写回、
 *    ChildWindowFromPointEx 只找直接子窗口、PostMessage 返回 0 = 失败。
 *
 * 分三层：
 *  1. 真 koffi（只解析 / 只做布局，不加载任何 Windows 库）：POINT=8 / BITMAPINFOHEADER=40 / GUITHREADINFO=72 与成员偏移，
 *     全部原型字符串能被解析；入参对象的编码放在子进程里跑（类型不符时 koffi 会 abort 整个进程）；
 *  2. 假 koffi + 假 ctx：init（缺函数 / 结构体大小对不上 / 库加载失败）、capture（枚举过滤 / 合成 / 空白 / 失败 / 超时 / 资源释放）；
 *  3. 假 koffi + 假 ctx：输入（命中测试 / 子控件下钻 / 激活补丁 / 点击 / 拖拽 / 滚轮 / 组合键 / 打字 / 失败补救 / 不泄漏文本）。
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BI_RGB,
  CWP,
  DWMWA_EXTENDED_FRAME_BOUNDS,
  EM_SETSEL,
  GWL_EXSTYLE,
  MK,
  PW_RENDERFULLCONTENT,
  REQUIRED_BG_FUNCTIONS,
  WA_ACTIVE,
  WIN32_BG_FUNCTIONS,
  WM,
  WS_EX,
  bitmapInfoHeader,
  defineBackgroundTypes,
  expectedBackgroundSizes,
  guiThreadInfo,
} from "../electron-app/desktop/drivers/win32-bg-defs.mjs";
import { createWin32Background } from "../electron-app/desktop/drivers/win32-background.mjs";
import { keyLParam, makeLParam, makeWheelWParam } from "../electron-app/desktop/drivers/win32-bg-pure.mjs";

const realKoffi = createRequire(import.meta.url)("koffi");
const DEFS_URL = pathToFileURL(path.resolve(__dirname, "../electron-app/desktop/drivers/win32-bg-defs.mjs")).href;

// ═══════════════════════════ 第一层：真 koffi ═══════════════════════════

describe("后台档结构体（真 koffi：只做布局，不加载任何库）", () => {
  const types = defineBackgroundTypes(realKoffi);

  it("大小：POINT 8 / BITMAPINFOHEADER 40 / GUITHREADINFO 72（Win64）", () => {
    expect(realKoffi.sizeof(types.POINT)).toBe(8);
    expect(realKoffi.sizeof(types.BITMAPINFOHEADER)).toBe(40);
    expect(realKoffi.sizeof(types.GUITHREADINFO)).toBe(72);
    expect(expectedBackgroundSizes(8)).toEqual({ POINT: 8, BITMAPINFOHEADER: 40, GUITHREADINFO: 72 });
    expect(expectedBackgroundSizes(4)).toEqual({ POINT: 8, BITMAPINFOHEADER: 40, GUITHREADINFO: 48 });
    expect(expectedBackgroundSizes(0)).toBeNull();
  });

  it("成员偏移与 wingdi.h / winuser.h 一致", () => {
    const off = (type: unknown, member: string): number => realKoffi.offsetof(type, member);
    expect(["x", "y"].map((m) => off(types.POINT, m))).toEqual([0, 4]);
    expect(
      ["biSize", "biWidth", "biHeight", "biPlanes", "biBitCount", "biCompression", "biSizeImage", "biXPelsPerMeter", "biYPelsPerMeter", "biClrUsed", "biClrImportant"].map((m) =>
        off(types.BITMAPINFOHEADER, m),
      ),
    ).toEqual([0, 4, 8, 12, 14, 16, 20, 24, 28, 32, 36]);
    expect(["cbSize", "flags", "hwndActive", "hwndFocus", "hwndCapture", "hwndMenuOwner", "hwndMoveSize", "hwndCaret", "rcCaret"].map((m) => off(types.GUITHREADINFO, m))).toEqual([
      0, 4, 8, 16, 24, 32, 40, 48, 56,
    ]);
  });

  it("同一个 koffi 实例重复定义返回同一份（不会 Duplicate type name）", () => {
    expect(defineBackgroundTypes(realKoffi)).toBe(types);
  });

  it("全部后台档原型字符串都能被真 koffi 解析（只解析：不加载任何库、不调用任何函数）", () => {
    for (const spec of WIN32_BG_FUNCTIONS) {
      const parsed = realKoffi.proto(spec.proto);
      expect(parsed.name, spec.name).toBe(spec.name);
    }
  });

  it("必需函数清单：用 key 登记的（DwmFrameBounds）只是可选；必需项不含它", () => {
    expect(REQUIRED_BG_FUNCTIONS).toEqual(expect.arrayContaining(["PostMessageW", "PrintWindow", "GetDC", "ReleaseDC", "CreateCompatibleDC", "CreateCompatibleBitmap", "SelectObject", "DeleteObject", "DeleteDC", "GetDIBits", "ScreenToClient"]));
    expect(REQUIRED_BG_FUNCTIONS).not.toContain("DwmFrameBounds");
    expect(REQUIRED_BG_FUNCTIONS).not.toContain("GetClassNameW");
    expect(WIN32_BG_FUNCTIONS.find((s) => s.key === "DwmFrameBounds")?.name).toBe("DwmGetWindowAttribute");
  });

  it("入参对象能被真 koffi 编码（在子进程里跑：成员类型不符时 koffi 直接 abort 进程）", () => {
    const script = `
      import { createRequire } from "node:module";
      const [defsUrl] = process.argv.slice(1);
      const koffi = createRequire(defsUrl)("koffi");
      const defs = await import(defsUrl);
      const types = defs.defineBackgroundTypes(koffi);
      const bih = Buffer.alloc(40);
      koffi.encode(bih, types.BITMAPINFOHEADER, defs.bitmapInfoHeader({ size: 40, width: 7, height: 5 }));
      const gti = Buffer.alloc(72);
      koffi.encode(gti, types.GUITHREADINFO, defs.guiThreadInfo({ size: 72 }));
      const point = Buffer.alloc(8);
      koffi.encode(point, types.POINT, { x: -3, y: 9 });
      console.log(JSON.stringify({
        bih: [bih.readUInt32LE(0), bih.readInt32LE(4), bih.readInt32LE(8), bih.readUInt16LE(12), bih.readUInt16LE(14), bih.readUInt32LE(16)],
        gtiSize: gti.readUInt32LE(0),
        point: [point.readInt32LE(0), point.readInt32LE(4)],
      }));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, DEFS_URL], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ bih: [40, 7, -5, 1, 32, BI_RGB], gtiSize: 72, point: [-3, 9] });
  });

  it("bitmapInfoHeader / guiThreadInfo：成员写满、biHeight 为负（自上而下）、句柄成员为 null", () => {
    expect(bitmapInfoHeader({ size: 40, width: 640, height: 480 })).toEqual({
      biSize: 40,
      biWidth: 640,
      biHeight: -480,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    });
    const gti = guiThreadInfo({ size: 72 });
    expect(gti.cbSize).toBe(72);
    expect(gti.hwndFocus).toBeNull();
    expect(gti.rcCaret).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});

// ═══════════════════════════ 假 Win32 ═══════════════════════════

type Call = { fn: string; args: unknown[] };
type Impl = (...args: never[]) => unknown;
type RectTuple = [number, number, number, number];
/** clientOffset：子控件自己的非客户区厚度（比如 Edit 的 2 像素凹陷边框）；缺省 [0, 0] */
type FakeChild = { hwnd: bigint; className: string; rect: RectTuple; clientOffset?: [number, number] };
type FakeWindow = {
  hwnd: bigint;
  pid: number;
  tid?: number;
  className: string;
  title?: string;
  /** GetWindowRect（屏幕坐标：left, top, right, bottom） */
  rect: RectTuple;
  /** DWM 真实可见边界；缺省 = 取不到（DwmGetWindowAttribute 返回失败） */
  frame?: RectTuple;
  /** 客户区原点相对窗口矩形左上角的偏移（标题栏 / 菜单栏 / 左边框的厚度）；缺省 [0, 0] = 整个窗口都是客户区（自绘标题栏的应用） */
  clientOffset?: [number, number];
  visible?: boolean;
  iconic?: boolean;
  cloaked?: boolean;
  exStyle?: number;
  /** 窗口画出来的颜色 [B, G, R] */
  color?: [number, number, number];
  /** PrintWindow 的返回值，缺省 1 */
  printResult?: number;
  /** PrintWindow 不返回（模拟无响应窗口；只有走 .async 才能模拟）：默认永远不返回，夹具的 settleHung() 可以让它晚点返回 */
  hang?: boolean;
  children?: FakeChild[];
};
type FakeOptions = {
  windows?: FakeWindow[];
  missing?: string[];
  failLoad?: string[];
  sizes?: Record<string, number>;
  /** 没有 .async（走同步调用） */
  noAsync?: boolean;
  /** 每个线程的焦点控件 */
  focus?: Record<number, bigint | null>;
  /** PostMessageW 对这些消息号返回 0（失败） */
  failPost?: number[];
  /** PostMessageW 只对「某个消息号的第 nth 次（从 1 数）」返回 0 */
  failPostNth?: { msg: number; nth: number };
  /** GetDIBits 返回的行数覆盖 */
  dibLines?: number;
  /** CreateCompatibleBitmap 返回 null */
  noBitmap?: boolean;
  /** CreateCompatibleBitmap 同步抛错（koffi 参数转换 / GDI 内部错误；和「返回 null」是两种失败） */
  bitmapThrows?: boolean;
  /** DeleteDC 抛错（模拟释放时的 GDI 内部错误） */
  deleteDCThrows?: boolean;
  /** GetDC(NULL) 返回 null */
  noScreenDC?: boolean;
  /** DeleteObject 抛错（模拟 GDI 内部错误） */
  deleteObjectThrows?: boolean;
  /** SelectObject 只在「第 nth 次调用（从 1 数）」抛错：一个窗口的正常路径里第 1 次 = 把位图选进 DC，第 2 次 = 把旧位图选回去 */
  selectThrowsNth?: number;
  /** PrintWindow.async 同步抛错（参数转换 / 绑定出了问题，调用根本没发出去） */
  printAsyncThrows?: boolean;
  /** 一帧里所有窗口位图合起来的内存上限（字节）；缺省 = 驱动默认值 */
  maxFrameBytes?: number;
};

const H = (n: number) => BigInt(n);
const OWN_PID = 999;
const DISPLAY = { x: 0, y: 0, width: 200, height: 100 };

/** Z 序从上到下 */
const DEFAULT_WINDOWS: FakeWindow[] = [
  {
    hwnd: H(0x10),
    pid: 100,
    tid: 11,
    className: "Notepad",
    title: "无标题 - 记事本",
    rect: [20, 10, 120, 60],
    color: [0, 0, 255], // 红
    children: [{ hwnd: H(0x11), className: "Edit", rect: [30, 25, 110, 55] }],
  },
  { hwnd: H(0x20), pid: 200, tid: 21, className: "Qt5QWindowIcon", title: "微信", rect: [80, 30, 190, 90], color: [0, 255, 0] }, // 绿
  { hwnd: H(0x30), pid: OWN_PID, tid: 31, className: "Chrome_WidgetWin_1", title: "Flowship 遮罩", rect: [0, 0, 200, 100], color: [1, 1, 1] },
  { hwnd: H(0x40), pid: 300, className: "Progman", title: "Program Manager", rect: [0, 0, 200, 100], color: [9, 9, 9] },
  { hwnd: H(0x50), pid: 400, className: "X", title: "最小化", rect: [10, 10, 60, 40], iconic: true },
  { hwnd: H(0x60), pid: 400, className: "X", title: "不可见", rect: [10, 10, 60, 40], visible: false },
  { hwnd: H(0x70), pid: 400, className: "X", title: "别的虚拟桌面", rect: [10, 10, 60, 40], cloaked: true },
  { hwnd: H(0x80), pid: 500, className: "X", title: "点击穿透的覆盖层", rect: [0, 0, 200, 100], exStyle: WS_EX.TRANSPARENT | WS_EX.LAYERED },
  { hwnd: H(0x90), pid: 400, className: "X", title: "没有面积", rect: [10, 10, 10, 40] },
  { hwnd: H(0xa0), pid: 400, className: "X", title: "在屏幕外", rect: [500, 10, 600, 40] },
];
const PROCESS_NAMES: Record<number, string> = { 100: "notepad", 200: "WeChat" };

const protoName = (prototype: string) => /(\w+)\s*\(/.exec(prototype)?.[1] ?? "";

const createFake = (options: FakeOptions = {}) => {
  const windows = options.windows ?? DEFAULT_WINDOWS;
  const calls: Call[] = [];
  const posts: Array<{ hwnd: bigint; msg: number; wParam: number; lParam: number }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const opens: Array<[string, unknown]> = [];
  const bound: string[] = [];
  const loads: string[] = [];
  const state = { clock: 1_000_000, lastError: 5 };

  // GDI：句柄表 + 「位图选在哪个 DC 里」
  const gdi = {
    nextHandle: 0xd000,
    dcs: new Set<bigint>(),
    bitmaps: new Map<bigint, { w: number; h: number; pixels: Buffer | null }>(),
    selected: new Map<bigint, bigint>(), // DC → 当前选中的位图
    deletedBitmaps: [] as bigint[],
    deletedDCs: [] as bigint[],
    released: [] as unknown[],
    /** 对「已经释放 / 从没有过」的 DC 或位图的任何使用（真 GDI 里是悬空句柄：轻则调用失败，重则写进被重新分配的别的对象） */
    invalidUses: [] as string[],
  };
  /** 挂着没返回的 PrintWindow 调用（windows[].hang）：settleHung 可以让它晚点返回 */
  const hungCalls: Array<{ hwnd: bigint; args: unknown[]; callback: (err: Error | null, result?: unknown) => void }> = [];
  const STOCK_BITMAP = H(0xb0);
  const newHandle = () => H(gdi.nextHandle++);

  const windowOf = (hwnd: unknown) => windows.find((w) => w.hwnd === hwnd);
  const childOf = (hwnd: unknown) => {
    for (const w of windows) {
      const c = w.children?.find((x) => x.hwnd === hwnd);
      if (c) return { child: c, parent: w };
    }
    return null;
  };
  /** 窗口（顶层或子控件）的客户区原点（屏幕坐标）；顶层窗口的 clientOffset = 标题栏 / 菜单栏 / 左边框的厚度（非客户区） */
  const originOf = (hwnd: unknown): [number, number] | null => {
    const w = windowOf(hwnd);
    if (w) return [w.rect[0] + (w.clientOffset?.[0] ?? 0), w.rect[1] + (w.clientOffset?.[1] ?? 0)];
    const c = childOf(hwnd);
    return c ? [c.child.rect[0] + (c.child.clientOffset?.[0] ?? 0), c.child.rect[1] + (c.child.clientOffset?.[1] ?? 0)] : null;
  };

  const core: Record<string, Impl> = {
    EnumWindows: ((cb: (hwnd: bigint, lParam: number) => number) => {
      for (const w of windows) if (cb(w.hwnd, 0) === 0) break;
      return 1;
    }) as Impl,
    IsWindowVisible: ((hwnd: bigint) => (windowOf(hwnd)?.visible === false ? 0 : 1)) as Impl,
    IsIconic: ((hwnd: bigint) => (windowOf(hwnd)?.iconic ? 1 : 0)) as Impl,
    GetWindowRect: ((hwnd: bigint, rect: Record<string, number>) => {
      const w = windowOf(hwnd);
      if (!w) return 0;
      Object.assign(rect, { left: w.rect[0], top: w.rect[1], right: w.rect[2], bottom: w.rect[3] });
      return 1;
    }) as Impl,
    GetWindowThreadProcessId: ((hwnd: bigint, out: number[]) => {
      const w = windowOf(hwnd);
      out[0] = w?.pid ?? 0;
      return w?.tid ?? 1;
    }) as Impl,
    GetWindowTextW: ((hwnd: bigint, buf: Buffer, max: number) => {
      const title = (windowOf(hwnd)?.title ?? "").slice(0, max - 1);
      Buffer.from(`${title}\0`, "utf16le").copy(buf);
      return title.length;
    }) as Impl,
  };

  let selectCalls = 0;
  const postCounts = new Map<number, number>();
  const postMessage = ((hwnd: bigint, msg: number, wParam: number, lParam: number) => {
    posts.push({ hwnd, msg, wParam, lParam });
    const nth = (postCounts.get(msg) ?? 0) + 1;
    postCounts.set(msg, nth);
    if (options.failPostNth && options.failPostNth.msg === msg && options.failPostNth.nth === nth) return 0;
    return options.failPost?.includes(msg) ? 0 : 1;
  }) as Impl;

  const bgImpls: Record<string, Impl> = {
    PostMessageW: postMessage,
    ScreenToClient: ((hwnd: bigint, point: { x: number; y: number }) => {
      const origin = originOf(hwnd);
      if (!origin) return 0;
      point.x -= origin[0];
      point.y -= origin[1];
      return 1;
    }) as Impl,
    // 只找「直接子窗口」；点在父窗口内但没有子窗口命中 → 返回父窗口本身
    ChildWindowFromPointEx: ((parent: bigint, pt: { x: number; y: number }, flags: number) => {
      void flags;
      const w = windowOf(parent);
      if (!w) return parent; // 子控件没有自己的子窗口：返回它自己
      const origin = originOf(parent)!;
      for (const c of w.children ?? []) {
        const [l, t, r, b] = [c.rect[0] - origin[0], c.rect[1] - origin[1], c.rect[2] - origin[0], c.rect[3] - origin[1]];
        if (pt.x >= l && pt.x < r && pt.y >= t && pt.y < b) return c.hwnd;
      }
      return parent;
    }) as Impl,
    GetGUIThreadInfo: ((tid: number, info: Record<string, unknown>) => {
      info.hwndFocus = options.focus?.[tid] ?? null;
      return 1;
    }) as Impl,
    GetClassNameW: ((hwnd: bigint, buf: Buffer, max: number) => {
      const name = (windowOf(hwnd)?.className ?? childOf(hwnd)?.child.className ?? "").slice(0, max - 1);
      Buffer.from(`${name}\0`, "utf16le").copy(buf);
      return name.length;
    }) as Impl,
    GetWindowLongW: ((hwnd: bigint, index: number) => (index === GWL_EXSTYLE ? (windowOf(hwnd)?.exStyle ?? 0) : 0)) as Impl,
    IsWindow: (() => 1) as Impl,
    GetDC: (() => (options.noScreenDC ? null : H(0xd00))) as Impl,
    ReleaseDC: ((_hwnd: unknown, hdc: unknown) => {
      gdi.released.push(hdc);
      return 1;
    }) as Impl,
    CreateCompatibleDC: (() => {
      const dc = newHandle();
      gdi.dcs.add(dc);
      gdi.selected.set(dc, STOCK_BITMAP);
      return dc;
    }) as Impl,
    CreateCompatibleBitmap: ((_hdc: unknown, w: number, h: number) => {
      if (options.bitmapThrows) throw new Error("GDI 内部错误（CreateCompatibleBitmap）");
      if (options.noBitmap) return null;
      const bmp = newHandle();
      gdi.bitmaps.set(bmp, { w, h, pixels: null });
      return bmp;
    }) as Impl,
    SelectObject: ((dc: bigint, obj: bigint) => {
      selectCalls += 1;
      if (options.selectThrowsNth === selectCalls) throw new Error("GDI 内部错误（SelectObject）");
      if (!gdi.dcs.has(dc)) gdi.invalidUses.push(`SelectObject 用了已释放的 DC ${dc}`);
      const previous = gdi.selected.get(dc) ?? null;
      gdi.selected.set(dc, obj);
      return previous;
    }) as Impl,
    // 真 GDI：被选在某个 DC 里的位图删不掉（返回 0）
    DeleteObject: ((bmp: bigint) => {
      if (options.deleteObjectThrows) throw new Error("GDI 内部错误");
      if (!gdi.bitmaps.has(bmp)) {
        gdi.invalidUses.push(`DeleteObject 删了不存在 / 已释放的位图 ${bmp}`);
        return 0;
      }
      if ([...gdi.selected.values()].includes(bmp)) return 0;
      gdi.bitmaps.delete(bmp);
      gdi.deletedBitmaps.push(bmp);
      return 1;
    }) as Impl,
    DeleteDC: ((dc: bigint) => {
      if (options.deleteDCThrows) throw new Error("GDI 内部错误（DeleteDC）");
      if (!gdi.dcs.has(dc)) {
        gdi.invalidUses.push(`DeleteDC 删了不存在 / 已释放的 DC ${dc}`);
        return 0;
      }
      gdi.dcs.delete(dc);
      gdi.selected.delete(dc);
      gdi.deletedDCs.push(dc);
      return 1;
    }) as Impl,
    PrintWindow: ((hwnd: bigint, dc: bigint, flags: number) => {
      void flags;
      if (!gdi.dcs.has(dc)) gdi.invalidUses.push(`PrintWindow 往已释放的 DC ${dc} 里画`);
      const w = windowOf(hwnd);
      const bmp = gdi.selected.get(dc);
      const entry = bmp ? gdi.bitmaps.get(bmp) : undefined;
      if (!w || !entry || (w.printResult ?? 1) === 0) return 0;
      const [b, g, r] = w.color ?? [128, 128, 128];
      const pixels = Buffer.alloc(entry.w * entry.h * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = b;
        pixels[i + 1] = g;
        pixels[i + 2] = r;
      }
      entry.pixels = pixels;
      return 1;
    }) as Impl,
    // 真 GDI：位图还选在 DC 里时 GetDIBits 失败（返回 0）
    GetDIBits: ((dc: bigint, bmp: bigint, start: number, lines: number, buf: Buffer, info: Record<string, number>, usage: number) => {
      void dc;
      void start;
      void usage;
      if ([...gdi.selected.values()].includes(bmp)) return 0;
      const entry = gdi.bitmaps.get(bmp);
      if (!entry?.pixels) return 0;
      if (info.biBitCount !== 32 || info.biHeight !== -entry.h || info.biWidth !== entry.w || lines !== entry.h) return 0;
      entry.pixels.copy(buf);
      return options.dibLines ?? lines;
    }) as Impl,
    DwmFrameBounds: ((hwnd: bigint, attribute: number, rect: Record<string, number>, size: number) => {
      void attribute;
      void size;
      const f = windowOf(hwnd)?.frame;
      if (!f) return 1; // 失败的 HRESULT
      Object.assign(rect, { left: f[0], top: f[1], right: f[2], bottom: f[3] });
      return 0;
    }) as Impl,
  };

  const sizes: Record<string, number> = { POINT: 8, BITMAPINFOHEADER: 40, GUITHREADINFO: 72, ...options.sizes };
  const koffi = {
    version: "3.3.8-fake",
    struct: (name: string, members: object) => ({ kind: "struct", name, members }),
    union: (members: object) => ({ kind: "union", members }),
    proto: (prototype: string) => ({ kind: "proto", name: protoName(prototype), prototype }),
    sizeof: (type: unknown) => (type === "void *" ? 8 : (sizes[(type as { name?: string }).name ?? ""] ?? 0)),
    load: (file: string) => {
      loads.push(file);
      if (options.failLoad?.includes(file)) throw new Error(`Failed to load shared library: ${file}`);
      return {
        func: (prototype: string) => {
          const symbol = protoName(prototype);
          // 同一个导出可以用不同原型绑多次：用 spec.key 登记的 DwmFrameBounds 在假实现里叫这个名字
          const name = symbol === "DwmGetWindowAttribute" ? "DwmFrameBounds" : symbol;
          if (options.missing?.includes(name)) throw new Error(`Cannot find function '${name}' in shared library '${file}'`);
          const impl = bgImpls[name];
          if (!impl) throw new Error(`测试夹具没有实现 ${name}`);
          bound.push(name);
          const fn = ((...args: unknown[]) => {
            calls.push({ fn: name, args });
            return (impl as (...a: unknown[]) => unknown)(...args);
          }) as ((...args: unknown[]) => unknown) & { async?: (...args: unknown[]) => void };
          if (name === "PrintWindow" && !options.noAsync) {
            fn.async = (...args: unknown[]) => {
              if (options.printAsyncThrows) throw new Error("PrintWindow 参数转换失败");
              const callback = args.pop() as (err: Error | null, result?: unknown) => void;
              calls.push({ fn: "PrintWindow.async", args });
              const w = windowOf(args[0]);
              if (w?.hang) {
                hungCalls.push({ hwnd: args[0] as bigint, args, callback }); // 不回调；settleHung 可以让它晚点返回
                return;
              }
              queueMicrotask(() => callback(null, (impl as (...a: unknown[]) => unknown)(...args)));
            };
          }
          return fn;
        },
      };
    },
  };

  const ctx = {
    getKoffi: () => koffi,
    ensureLoaded: () => {},
    callCore: (name: string, ...args: unknown[]) => {
      const impl = core[name];
      if (!impl) throw new Error(`夹具没有核心函数 ${name}`);
      calls.push({ fn: name, args });
      return (impl as (...a: unknown[]) => unknown)(...args);
    },
    hasCore: (name: string) => name in core,
    lastErrorCode: () => state.lastError,
    queryProcessName: (pid: number) => PROCESS_NAMES[pid] ?? `未知进程#${pid}`,
    isCloaked: (hwnd: bigint) => windowOf(hwnd)?.cloaked === true,
    getPrimaryDisplay: () => ({ ...DISPLAY }),
    scanOf: (vk: number) => vk + 1,
    // 节奏类停顿（几十毫秒）立刻返回；PrintWindow 的超时（3000ms）用一个很短的真计时器代替——
    // 否则「立刻返回的停顿」会在异步调用的微任务之前赢下 Promise.race，把正常窗口误判成超时
    sleep: (ms: number) => {
      sleeps.push(ms);
      return ms >= 1000 ? new Promise<void>((resolve) => setTimeout(resolve, 30)) : Promise.resolve();
    },
    now: () => state.clock,
    say: (message: string) => {
      logs.push(message);
    },
    ownPid: OWN_PID,
    maxFrameBytes: options.maxFrameBytes,
    openApp: async (target: string, opts: { background: boolean }) => {
      opens.push([target, opts]);
    },
  };

  /** 让某个窗口挂着的那次 PrintWindow 晚点返回：error = 调用失败；否则 = PrintWindow 真的跑完（往它当初拿到的 DC 里画）并返回 */
  const settleHung = (hwnd: bigint, outcome: { error?: Error } = {}) => {
    const index = hungCalls.findIndex((c) => c.hwnd === hwnd);
    if (index < 0) throw new Error(`夹具里没有挂起的 PrintWindow（窗口 ${hwnd}）`);
    const [pending] = hungCalls.splice(index, 1);
    if (outcome.error) pending.callback(outcome.error);
    else pending.callback(null, (bgImpls.PrintWindow as (...a: unknown[]) => unknown)(...pending.args));
  };

  const background = createWin32Background(ctx);
  return { background, ctx, calls, posts, sleeps, logs, opens, bound, loads, state, gdi, settleHung, hungCalls };
};

const ready = async (options: FakeOptions = {}) => {
  const fake = createFake(options);
  const result = await fake.background.init();
  if (!result.ok) throw new Error(`夹具 init 失败：${(result as { error?: string }).error}`);
  fake.calls.length = 0;
  fake.posts.length = 0;
  fake.logs.length = 0;
  fake.sleeps.length = 0;
  return fake;
};

const pixel = (frame: Buffer, width: number, x: number, y: number) => {
  const o = (y * width + x) * 4;
  return [frame[o], frame[o + 1], frame[o + 2], frame[o + 3]];
};
const RED = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
const GRAY = [0x20, 0x20, 0x20, 255];

// ═══════════════════════════ init ═══════════════════════════

describe("init（懒绑定、缓存）", () => {
  it("成功：绑定全部函数、登记结构体大小；supported() 为 true；诊断里没有绑定失败", async () => {
    const fake = createFake();
    expect(fake.background.supported()).toBe(false);
    expect(await fake.background.init()).toEqual({ ok: true });
    expect(fake.background.supported()).toBe(true);
    expect(fake.loads.sort()).toEqual(["dwmapi.dll", "gdi32.dll", "user32.dll"]);
    expect(fake.background.diagnostics()).toMatchObject({
      initialized: true,
      ready: true,
      error: null,
      bindFailures: [],
      typeProblems: {},
      sizes: { POINT: 8, BITMAPINFOHEADER: 40, GUITHREADINFO: 72 },
    });
    expect(fake.logs.join("\n")).toContain("锁屏后台档就绪");
  });

  it("init 结果缓存：再调一次不会重复绑定 / 加载", async () => {
    const fake = createFake();
    await fake.background.init();
    const boundBefore = fake.bound.length;
    const loadsBefore = fake.loads.length;
    expect(await fake.background.init()).toEqual({ ok: true });
    expect(fake.bound.length).toBe(boundBefore);
    expect(fake.loads.length).toBe(loadsBefore);
  });

  it("缺必需函数（PrintWindow）→ ok:false 且点名；之后所有操作都报 UNSUPPORTED；失败结果也缓存", async () => {
    const fake = createFake({ missing: ["PrintWindow"] });
    const result = await fake.background.init();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("PrintWindow");
    expect(fake.background.supported()).toBe(false);
    await expect(fake.background.capture()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(fake.background.click(10, 10)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const boundBefore = fake.bound.length;
    expect(await fake.background.init()).toMatchObject({ ok: false });
    expect(fake.bound.length).toBe(boundBefore);
  });

  it("缺可选函数（GetClassNameW / DwmFrameBounds / GetGUIThreadInfo）→ 照常可用，只进诊断", async () => {
    const fake = createFake({ missing: ["GetClassNameW", "DwmFrameBounds", "GetGUIThreadInfo"] });
    expect(await fake.background.init()).toEqual({ ok: true });
    expect(fake.background.diagnostics().bindFailures.sort()).toEqual(["DwmFrameBounds", "GetClassNameW", "GetGUIThreadInfo"]);
  });

  it("gdi32 加载失败 → 依赖它的必需函数全部绑定失败 → ok:false，原因里带库名", async () => {
    const fake = createFake({ failLoad: ["gdi32.dll"] });
    const result = await fake.background.init();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/GetDIBits|CreateCompatibleDC/);
    expect((result as { error: string }).error).toContain("gdi32.dll");
  });

  it("POINT 大小对不上 → 依赖它的必需函数（ScreenToClient）不绑定 → ok:false；诊断里有原因", async () => {
    const fake = createFake({ sizes: { POINT: 12 } });
    const result = await fake.background.init();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("ScreenToClient");
    expect(fake.background.diagnostics().typeProblems.POINT).toContain("POINT 的实测大小是 12");
  });

  it("GUITHREADINFO 大小对不上 → 只放弃 GetGUIThreadInfo（可选），其余照常", async () => {
    const fake = createFake({ sizes: { GUITHREADINFO: 80 } });
    expect(await fake.background.init()).toEqual({ ok: true });
    expect(fake.background.diagnostics().bindFailures).toEqual(["GetGUIThreadInfo"]);
  });

  it("驱动没 init（ensureLoaded 抛 UNSUPPORTED）→ 后台档 init 同样失败，不加载任何库", async () => {
    const fake = createFake();
    const failing = createWin32Background({
      ...fake.ctx,
      ensureLoaded: () => {
        throw Object.assign(new Error("Windows 桌面驱动尚未初始化"), { code: "UNSUPPORTED" });
      },
    });
    expect(await failing.init()).toMatchObject({ ok: false, error: expect.stringContaining("尚未初始化") });
    expect(fake.loads).toEqual([]);
  });

  it("init 之前直接用 → UNSUPPORTED「尚未初始化」", async () => {
    const fake = createFake();
    await expect(fake.background.capture()).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("尚未初始化") });
  });
});

// ═══════════════════════════ 截图 ═══════════════════════════

describe("capture：枚举、逐窗口 PrintWindow、合成", () => {
  it("只截主屏上「可见、没最小化、没被隐藏、不是本进程、不是壁纸 / 任务栏、不是点击穿透、有面积、在屏幕内」的顶层窗口，Z 序从上到下", async () => {
    const fake = await ready();
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => `${w.className}:${w.status}`)).toEqual(["Notepad:ok", "Qt5QWindowIcon:ok"]);
    expect(shot.windows.map((w) => w.processName)).toEqual(["notepad", "WeChat"]);
    const printed = fake.calls.filter((c) => c.fn === "PrintWindow.async").map((c) => c.args[0]);
    expect(printed).toEqual([H(0x10), H(0x20)]);
  });

  it("每个窗口的 GDI 调用顺序：建 DC → 建位图 → 选入 → PrintWindow(PW_RENDERFULLCONTENT) → 把旧位图选回 → GetDIBits(自上而下 32 位) → 删位图 → 删 DC；全部释放", async () => {
    const fake = await ready({ windows: [DEFAULT_WINDOWS[0]] });
    await fake.background.capture();
    const names = fake.calls.map((c) => c.fn).filter((n) => n !== "GetWindowThreadProcessId");
    const gdiSequence = names.filter((n) => ["GetDC", "CreateCompatibleDC", "CreateCompatibleBitmap", "SelectObject", "PrintWindow.async", "GetDIBits", "DeleteObject", "DeleteDC", "ReleaseDC"].includes(n));
    expect(gdiSequence).toEqual(["GetDC", "CreateCompatibleDC", "CreateCompatibleBitmap", "SelectObject", "PrintWindow.async", "SelectObject", "GetDIBits", "DeleteObject", "DeleteDC", "ReleaseDC"]);
    const print = fake.calls.find((c) => c.fn === "PrintWindow.async")!;
    expect(print.args[2]).toBe(PW_RENDERFULLCONTENT);
    const dib = fake.calls.find((c) => c.fn === "GetDIBits")!;
    expect(dib.args[3]).toBe(50); // cLines = 窗口高
    expect(dib.args[5]).toMatchObject({ biSize: 40, biWidth: 100, biHeight: -50, biPlanes: 1, biBitCount: 32, biCompression: 0 });
    expect(dib.args[6]).toBe(0); // DIB_RGB_COLORS
    // 位图被选回旧位图（STOCK）之后才取像素：第二次 SelectObject 的第二个参数是第一次返回的旧位图
    const selects = fake.calls.filter((c) => c.fn === "SelectObject");
    expect(selects[1].args[1]).toBe(H(0xb0));
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.released).toEqual([H(0xd00)]);
  });

  it("合成：上层窗口盖住下层；窗口之外是底色；画布 = 主屏大小；Alpha 全 255", async () => {
    const fake = await ready();
    const shot = await fake.background.capture();
    expect([shot.width, shot.height]).toEqual([200, 100]);
    expect(shot.bgra.length).toBe(200 * 100 * 4);
    expect(pixel(shot.bgra, 200, 25, 15)).toEqual(RED); // 记事本区域
    expect(pixel(shot.bgra, 200, 100, 40)).toEqual(RED); // 记事本盖住了微信的左上角（x 80..119, y 30..59 重叠）
    expect(pixel(shot.bgra, 200, 150, 80)).toEqual(GREEN); // 只有微信的区域
    expect(pixel(shot.bgra, 200, 5, 5)).toEqual(GRAY); // 底色
    expect(pixel(shot.bgra, 200, 199, 99)).toEqual(GRAY);
  });

  it("用 DWM 的真实可见边界裁掉透明边框：边框那几列不画，保持底色", async () => {
    const windows: FakeWindow[] = [{ ...DEFAULT_WINDOWS[1], frame: [85, 30, 185, 85] }];
    const fake = await ready({ windows });
    const shot = await fake.background.capture();
    expect(pixel(shot.bgra, 200, 82, 50)).toEqual(GRAY); // 在窗口矩形里、DWM 边界外
    expect(pixel(shot.bgra, 200, 90, 50)).toEqual(GREEN);
    expect(pixel(shot.bgra, 200, 188, 50)).toEqual(GRAY); // 右边框
    expect(pixel(shot.bgra, 200, 90, 87)).toEqual(GRAY); // 下边框
    expect(fake.calls.some((c) => c.fn === "DwmFrameBounds" && c.args[1] === DWMWA_EXTENDED_FRAME_BOUNDS)).toBe(true);
  });

  it("空白窗口（纯黑 / 纯白）标 blank、照样画出来保持几何；PrintWindow 失败的标 failed、不画；GetDIBits 行数不对也算 failed", async () => {
    const windows: FakeWindow[] = [
      { ...DEFAULT_WINDOWS[0], color: [0, 0, 0] },
      { ...DEFAULT_WINDOWS[1], printResult: 0 },
    ];
    const fake = await ready({ windows });
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => w.status)).toEqual(["blank", "failed"]);
    expect(pixel(shot.bgra, 200, 25, 15)).toEqual([0, 0, 0, 255]);
    expect(pixel(shot.bgra, 200, 150, 80)).toEqual(GRAY);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.bitmaps.size).toBe(0); // 失败的窗口资源也释放了

    const bad = await ready({ windows: [DEFAULT_WINDOWS[0]], dibLines: 3 });
    expect((await bad.background.capture()).windows[0].status).toBe("failed");
    expect(bad.gdi.bitmaps.size).toBe(0);
  });

  it("创建位图失败：标 failed、释放已建的 DC；取不到屏幕 DC：整体报错", async () => {
    const fake = await ready({ windows: [DEFAULT_WINDOWS[0]], noBitmap: true });
    expect((await fake.background.capture()).windows[0].status).toBe("failed");
    expect(fake.gdi.dcs.size).toBe(0);

    const noDC = await ready({ noScreenDC: true });
    await expect(noDC.background.capture()).rejects.toThrow(/GetDC/);
  });

  it("PrintWindow 无响应：超时标 timeout，它的 GDI 对象先搁置（可能还在写）；60 秒内不再尝试；那次调用一直没返回，过了 60 秒也不再叠加新的调用", async () => {
    const windows: FakeWindow[] = [{ ...DEFAULT_WINDOWS[0], hang: true }, DEFAULT_WINDOWS[1]];
    const fake = await ready({ windows });
    const first = await fake.background.capture();
    expect(first.windows.map((w) => w.status)).toEqual(["timeout", "ok"]);
    expect(pixel(first.bgra, 200, 150, 80)).toEqual(GREEN); // 别的窗口不受影响
    expect(fake.gdi.deletedBitmaps).toHaveLength(1); // 只有正常那个被删
    expect(fake.gdi.bitmaps.size).toBe(1); // 超时那个先留着（它还没返回）
    expect(fake.sleeps).toContain(3000);

    fake.calls.length = 0;
    const second = await fake.background.capture();
    expect(second.windows.map((w) => w.status)).toEqual(["timeout", "ok"]);
    expect(fake.calls.filter((c) => c.fn === "PrintWindow.async").map((c) => c.args[0])).toEqual([H(0x20)]); // 没再碰无响应的窗口

    fake.state.clock += 61_000;
    fake.calls.length = 0;
    const third = await fake.background.capture();
    expect(third.windows.map((w) => w.status)).toEqual(["timeout", "ok"]); // 上一次还没返回：仍报 timeout
    expect(fake.calls.filter((c) => c.fn === "PrintWindow.async").map((c) => c.args[0])).toEqual([H(0x20)]); // 跳过期过了也不叠加
  });

  it("没有 koffi 的 .async 时退回同步调用，结果一样", async () => {
    const fake = await ready({ noAsync: true });
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => w.status)).toEqual(["ok", "ok"]);
    expect(fake.calls.some((c) => c.fn === "PrintWindow")).toBe(true);
    expect(fake.calls.some((c) => c.fn === "PrintWindow.async")).toBe(false);
  });

  it("最多合成 24 个窗口", async () => {
    const many: FakeWindow[] = Array.from({ length: 30 }, (_, i) => ({
      hwnd: H(0x1000 + i),
      pid: 100 + i,
      className: "X",
      rect: [i, i, i + 40, i + 30] as RectTuple,
      color: [10, 20, 30] as [number, number, number],
    }));
    const fake = await ready({ windows: many });
    const shot = await fake.background.capture();
    expect(shot.windows).toHaveLength(24);
  });

  // 第三轮评审：每个窗口的整张位图合成前都要留着，24 个窗口 × 单个最大 64MB 能到 1.5GB；现在整帧有总预算
  describe("整帧内存预算：所有窗口位图合起来超过上限，更下面的窗口记 skipped、不再 PrintWindow", () => {
    const BYTES = 100 * 50 * 4; // 每个窗口的位图
    const stack = (n: number): FakeWindow[] =>
      Array.from({ length: n }, (_, i) => ({
        hwnd: H(0x2000 + i),
        pid: 100 + i,
        className: `W${i}`,
        rect: [0, 0, 100, 50] as RectTuple,
        color: [10 + i, 20, 30] as [number, number, number],
      }));

    it("预算刚好放下 3 个：Z 序最上面的 3 个截到，其余 2 个 skipped 且没发过 PrintWindow；画面里是上面的窗口", async () => {
      const fake = await ready({ windows: stack(5), maxFrameBytes: BYTES * 3 });
      const shot = await fake.background.capture();
      expect(shot.windows.map((w) => w.status)).toEqual(["ok", "ok", "ok", "skipped", "skipped"]);
      expect(shot.windows.map((w) => w.className)).toEqual(["W0", "W1", "W2", "W3", "W4"]);
      const printed = fake.calls.filter((c) => c.fn === "PrintWindow.async").map((c) => c.args[0]);
      expect(printed).toEqual([H(0x2000), H(0x2001), H(0x2002)]);
      expect(pixel(shot.bgra, 200, 10, 10)).toEqual([10, 20, 30, 255]); // 最上面的窗口盖在最前
      expect(fake.gdi.dcs.size).toBe(0); // 没截的窗口也没有建过 GDI 对象；截了的都释放了
      expect(fake.gdi.bitmaps.size).toBe(0);
    });

    it("差一个字节也放不下下一个；预算为 0 → 全部 skipped（不建 GDI 对象、不发 PrintWindow），整帧仍能合成（底色）", async () => {
      const tight = await ready({ windows: stack(3), maxFrameBytes: BYTES * 2 - 1 });
      expect((await tight.background.capture()).windows.map((w) => w.status)).toEqual(["ok", "skipped", "skipped"]);

      const none = await ready({ windows: stack(3), maxFrameBytes: 0 });
      const shot = await none.background.capture();
      expect(shot.windows.map((w) => w.status)).toEqual(["skipped", "skipped", "skipped"]);
      expect(none.calls.some((c) => c.fn === "PrintWindow.async" || c.fn === "CreateCompatibleBitmap")).toBe(false);
      expect(pixel(shot.bgra, 200, 10, 10)).toEqual(GRAY);
    });

    it("只有真正留在内存里的位图才占预算：PrintWindow 失败的窗口（位图已释放）不占；默认预算（256MB）下普通窗口都能截到（超时搁置的位图还活着，要占：见下面 C3 的用例）", async () => {
      const windows = stack(4);
      windows[0] = { ...windows[0]!, printResult: 0 }; // 失败：没有位图留下
      const fake = await ready({ windows, maxFrameBytes: BYTES * 2 });
      const shot = await fake.background.capture();
      expect(shot.windows.map((w) => w.status)).toEqual(["failed", "ok", "ok", "skipped"]);

      const normal = await ready({ windows: stack(24) });
      expect((await normal.background.capture()).windows.every((w) => w.status === "ok")).toBe(true);
    });

    // 第四轮评审 C3：PrintWindow 超时的窗口，那次调用还没返回、位图（和 DC）还活着；以前它不算进预算，
    // 「已合成的 + 搁置的」可以悄悄超过上限，连续几个窗口超时更是越攒越多。现在搁置的位图一直占着预算，直到那次调用返回。
    describe("超时搁置的位图继续占着预算，直到那次 PrintWindow 返回（第四轮评审 C3）", () => {
      const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
      const printed = (fake: Awaited<ReturnType<typeof ready>>) => fake.calls.filter((c) => c.fn === "PrintWindow.async").map((c) => c.args[0]);
      /** n 个窗口叠在一起，下标在 indexes 里的无响应 */
      const hung = (n: number, ...indexes: number[]): FakeWindow[] => stack(n).map((w, i) => (indexes.includes(i) ? { ...w, hang: true } : w));

      it("预算放得下 3 份：最上面的窗口超时，它的位图占一份，后面只剩 2 份——同一帧里就生效", async () => {
        const fake = await ready({ windows: hung(5, 0), maxFrameBytes: BYTES * 3 });
        const shot = await fake.background.capture();
        expect(shot.windows.map((w) => w.status)).toEqual(["timeout", "ok", "ok", "skipped", "skipped"]); // 以前：第 4 个也截了
        expect(printed(fake)).toEqual([H(0x2000), H(0x2001), H(0x2002)]); // 第 4、5 个没发过 PrintWindow
      });

      it("连续几个窗口先后超时：每一个都占一份，不只是最近一个", async () => {
        const fake = await ready({ windows: hung(5, 0, 1), maxFrameBytes: BYTES * 3 });
        const shot = await fake.background.capture();
        expect(shot.windows.map((w) => w.status)).toEqual(["timeout", "timeout", "ok", "skipped", "skipped"]);
        expect(printed(fake)).toEqual([H(0x2000), H(0x2001), H(0x2002)]);
      });

      it("跨帧也一直占着：那次调用没返回，下一帧预算里仍然扣着它；也不重发 PrintWindow", async () => {
        const fake = await ready({ windows: hung(5, 0), maxFrameBytes: BYTES * 3 });
        await fake.background.capture();
        fake.calls.length = 0;
        const second = await fake.background.capture();
        expect(second.windows.map((w) => w.status)).toEqual(["timeout", "ok", "ok", "skipped", "skipped"]);
        expect(printed(fake)).toEqual([H(0x2001), H(0x2002)]); // 无响应的第 1 个没再碰
      });

      it("那次调用返回（成功）后记录删除，预算立刻归还：下一帧多放得下一个", async () => {
        const fake = await ready({ windows: hung(5, 0), maxFrameBytes: BYTES * 3 });
        await fake.background.capture();
        fake.settleHung(H(0x2000));
        await flush();
        fake.calls.length = 0;
        const next = await fake.background.capture();
        // 第 1 个还在 60 秒的跳过期里（时钟没动）：仍报 timeout、不重发；但它的位图已经释放，预算整个归还
        expect(next.windows.map((w) => w.status)).toEqual(["timeout", "ok", "ok", "ok", "skipped"]);
        expect(printed(fake)).toEqual([H(0x2001), H(0x2002), H(0x2003)]);
      });

      it("那次调用以失败返回同样归还（成功、失败都算返回）", async () => {
        const fake = await ready({ windows: hung(5, 0), maxFrameBytes: BYTES * 3 });
        await fake.background.capture();
        fake.settleHung(H(0x2000), { error: new Error("线程已退出") });
        await flush();
        const next = await fake.background.capture();
        expect(next.windows.map((w) => w.status)).toEqual(["timeout", "ok", "ok", "ok", "skipped"]);
      });

      it("按搁置位图自己的大小扣（宽 × 高 × 4），不是按个数", async () => {
        const windows = stack(3);
        windows[0] = { ...windows[0]!, rect: [0, 0, 200, 100] as RectTuple, hang: true }; // 一个窗口占 4 份
        const fake = await ready({ windows, maxFrameBytes: BYTES * 5 });
        const shot = await fake.background.capture();
        expect(shot.windows.map((w) => w.status)).toEqual(["timeout", "ok", "skipped"]); // 4 + 1 = 5 份用完，第 3 个放不下
      });

      it("自己正搁置着的窗口不被算两遍：预算紧张时仍然报 timeout（不会被错报成 skipped）", async () => {
        const fake = await ready({ windows: hung(3, 0), maxFrameBytes: BYTES * 2 - 1 });
        const first = await fake.background.capture();
        expect(first.windows.map((w) => w.status)).toEqual(["timeout", "skipped", "skipped"]); // 搁置的占一份，剩下放不下第二个整份
        const second = await fake.background.capture();
        // 第 1 个仍报 timeout：它不会再建位图，它那一份已经在搁置的字节数里，不再把自己的大小再算一遍
        expect(second.windows.map((w) => w.status)).toEqual(["timeout", "skipped", "skipped"]);
      });
    });
  });

  it("captureWindow：单个窗口截图（自检用）；窗口没了 → 报错", async () => {
    const fake = await ready();
    const shot = await fake.background.captureWindow(H(0x20));
    expect(shot).toMatchObject({ status: "ok", width: 110, height: 60 });
    expect(shot.data?.length).toBe(110 * 60 * 4);
    await expect(fake.background.captureWindow(H(0xdead))).rejects.toThrow(/读取窗口矩形失败/);
  });
});

describe("PrintWindow 超时之后的 GDI 对象：等那次调用返回了再释放（不泄漏），返回之前不叠加新的调用", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** 记事本（0x10）会卡住；微信（0x20）正常 */
  const hungNotepad = (): FakeWindow[] => [{ ...DEFAULT_WINDOWS[0], hang: true }, DEFAULT_WINDOWS[1]];
  const printsOf = (fake: Awaited<ReturnType<typeof ready>>, hwnd: bigint) =>
    fake.calls.filter((c) => c.fn === "PrintWindow.async" && c.args[0] === hwnd).length;

  it("超时那一刻只是搁置；那次 PrintWindow 晚点成功返回后才释放：先选回旧位图 → 删位图 → 删 DC；没有任何对已释放对象的使用", async () => {
    const fake = await ready({ windows: hungNotepad() });
    await fake.background.capture();
    expect(fake.gdi.bitmaps.size).toBe(1);
    expect(fake.gdi.dcs.size).toBe(1);
    expect(fake.hungCalls).toHaveLength(1);

    fake.calls.length = 0;
    fake.settleHung(H(0x10)); // 它晚点画完了：往当初拿到的 DC / 位图里画，这时它们必须还活着
    await flush();
    expect(fake.calls.map((c) => c.fn)).toEqual(["SelectObject", "DeleteObject", "DeleteDC"]);
    expect(fake.calls[0].args[1]).toBe(H(0xb0)); // 选回的是当初拿到的旧位图
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
  });

  it("晚到的是失败（调用报错）也释放；释放不产生未处理的拒绝", async () => {
    const fake = await ready({ windows: hungNotepad() });
    await fake.background.capture();
    expect(fake.gdi.bitmaps.size).toBe(1);
    fake.settleHung(H(0x10), { error: new Error("线程已退出") });
    await flush();
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
  });

  it("在途期间不叠加：过了多个 60 秒，只要上一次还没返回，就不再发新的 PrintWindow、不再新建 DC / 位图（泄漏不随时间增长）", async () => {
    const fake = await ready({ windows: hungNotepad() });
    await fake.background.capture();
    for (let i = 0; i < 5; i += 1) {
      fake.state.clock += 61_000;
      const shot = await fake.background.capture();
      expect(shot.windows.map((w) => `${w.className}:${w.status}`)).toEqual(["Notepad:timeout", "Qt5QWindowIcon:ok"]);
    }
    expect(printsOf(fake, H(0x10))).toBe(1);
    expect(fake.calls.filter((c) => c.fn === "CreateCompatibleBitmap")).toHaveLength(1 + 6); // 微信每帧一个 + 记事本只有第一帧的那个
    expect(fake.gdi.bitmaps.size).toBe(1); // 留着的只有记事本那一组
    expect(fake.gdi.dcs.size).toBe(1);
  });

  it("多个窗口各自搁置、各自释放：先返回的先释放，没返回的不动", async () => {
    const windows: FakeWindow[] = [
      { ...DEFAULT_WINDOWS[0], hang: true },
      { ...DEFAULT_WINDOWS[1], hang: true },
    ];
    const fake = await ready({ windows });
    await fake.background.capture();
    expect(fake.gdi.bitmaps.size).toBe(2);
    fake.settleHung(H(0x20));
    await flush();
    expect(fake.gdi.bitmaps.size).toBe(1);
    expect(fake.gdi.dcs.size).toBe(1);
    expect(fake.hungCalls.map((c) => c.hwnd)).toEqual([H(0x10)]);
    fake.settleHung(H(0x10));
    await flush();
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
  });

  it("那次调用返回后，窗口缓过来了就重新截；晚到的返回不提前解除 60 秒的跳过（免得一个时好时坏的窗口每一帧都白等 3 秒）", async () => {
    const windows = hungNotepad();
    const fake = await ready({ windows });
    await fake.background.capture();
    fake.settleHung(H(0x10));
    await flush();
    windows[0].hang = false; // 窗口缓过来了

    fake.calls.length = 0;
    expect((await fake.background.capture()).windows.map((w) => w.status)).toEqual(["timeout", "ok"]);
    expect(printsOf(fake, H(0x10))).toBe(0);

    fake.state.clock += 61_000;
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => w.status)).toEqual(["ok", "ok"]);
    expect(printsOf(fake, H(0x10))).toBe(1);
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
  });

  it("释放时某一步出错不挡后面的步骤（DC 照样删掉），记一条日志、不抛出去", async () => {
    const fake = await ready({ windows: [{ ...DEFAULT_WINDOWS[0], hang: true }], deleteObjectThrows: true });
    await fake.background.capture();
    fake.settleHung(H(0x10));
    await flush();
    expect(fake.gdi.dcs.size).toBe(0); // 删位图出错了，删 DC 仍然执行
    expect(fake.logs.some((m) => m.includes("释放 GDI 对象") && m.includes("删除位图"))).toBe(true);
  });

  it("正常窗口不受影响：不进搁置、当场释放（上面的全部是超时路径）", async () => {
    const fake = await ready();
    await fake.background.capture();
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.hungCalls).toHaveLength(0);
    expect(fake.gdi.invalidUses).toEqual([]);
  });
});

// 第三轮评审（GDI 句柄）：正常路径（PrintWindow 在时限内返回）的释放以前是两个裸 call——DeleteObject 一抛，DeleteDC 就被跳过；
// 「把旧位图选回去」抛了的话位图还选在 DC 里、删不掉；PrintWindow 同步抛时连 try 都没进。每一步都要各自兜住，句柄不能泄漏。
describe("正常路径的 GDI 释放：每一步各自兜住（不泄漏），已有的错误不被盖掉", () => {
  const oneWindow = [{ ...DEFAULT_WINDOWS[0] }];

  it("删位图抛错：删 DC 照样执行，这一帧照常截到（释放时的小毛病不变成截图失败），记日志", async () => {
    const fake = await ready({ windows: oneWindow, deleteObjectThrows: true });
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => w.status)).toEqual(["ok"]);
    expect(fake.gdi.dcs.size).toBe(0); // 以前：DeleteObject 抛出来，DeleteDC 被跳过 → 内存 DC 永远泄漏
    expect(fake.logs.some((m) => m.includes("释放 GDI 对象") && m.includes("删除位图"))).toBe(true);
    expect(fake.gdi.invalidUses).toEqual([]);
  });

  it("「把旧位图选回去」抛错：错误照常交给上层，但释放时补选一次，位图和 DC 都删掉（以前位图还选在 DC 里，删不掉）", async () => {
    const fake = await ready({ windows: oneWindow, selectThrowsNth: 2 });
    await expect(fake.background.capture()).rejects.toThrow(/SelectObject/);
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
    // 屏幕 DC 也释放了（capture 自己的 finally）
    expect(fake.gdi.released).toHaveLength(1);
  });

  it("PrintWindow 同步抛错（调用没发出去）：这个窗口标 failed、DC 和位图当场释放、整帧照常（callAsync 把同步抛错包成拒绝，不会从 printWindow 里漏出去）", async () => {
    const fake = await ready({ windows: oneWindow, printAsyncThrows: true });
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => w.status)).toEqual(["failed"]);
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.hungCalls).toHaveLength(0);
    expect(fake.gdi.released).toHaveLength(1);
  });

  it("多个窗口里只有一个释放出错：其余窗口的 GDI 对象照常释放，整帧不受影响", async () => {
    const fake = await ready({ deleteObjectThrows: true });
    const shot = await fake.background.capture();
    expect(shot.windows.filter((w) => w.status === "ok")).toHaveLength(2);
    expect(fake.gdi.dcs.size).toBe(0);
  });
});

// 第四轮评审 C2（GDI 句柄）：创建阶段（建内存 DC → 建位图 → 把位图选进 DC）任何一步失败，前面已建好的对象都要在失败的当场释放。
// 以前只有 PrintWindow 之后才有 try / finally：建位图 / 选入这两步一抛（koffi 同步抛），已建的内存 DC（和位图）没有任何人持有，每抛一次永久泄漏一组；
// 位图建不成（返回 NULL）那条分支是裸 call DeleteDC——它再抛就把整帧带崩，也不像别处那样每步兜住、记日志。
describe("创建阶段失败的 GDI 释放（第四轮评审 C2）：建位图 / 选入任何一步失败，已建好的 DC 和位图当场释放", () => {
  const oneWindow = [{ ...DEFAULT_WINDOWS[0] }];

  it("建位图时抛错（koffi 同步抛）：已建的内存 DC 先释放，错误照常交给上层；不拿 NULL 位图去调 DeleteObject；屏幕 DC 也释放", async () => {
    const fake = await ready({ windows: oneWindow, bitmapThrows: true });
    await expect(fake.background.capture()).rejects.toThrow(/CreateCompatibleBitmap/);
    expect(fake.gdi.dcs.size).toBe(0); // 以前：建位图抛 → 刚建好的内存 DC 没人管，永远泄漏
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.calls.some((c) => c.fn === "DeleteObject")).toBe(false); // 没有位图可删
    expect(fake.gdi.invalidUses).toEqual([]);
    expect(fake.gdi.released).toHaveLength(1); // 屏幕 DC（capture 自己的 finally）
  });

  it("把位图选进 DC 时抛错：位图和 DC 都释放（位图还没选进去，删得掉），错误照常交给上层；窗口没进入绘制阶段", async () => {
    const fake = await ready({ windows: oneWindow, selectThrowsNth: 1 });
    await expect(fake.background.capture()).rejects.toThrow(/SelectObject/);
    expect(fake.gdi.bitmaps.size).toBe(0); // 以前：位图和 DC 一起泄漏
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
    expect(fake.gdi.released).toHaveLength(1);
    expect(fake.calls.some((c) => c.fn === "PrintWindow.async")).toBe(false);
  });

  it("位图建不成（返回 NULL）：窗口标 failed、DC 释放；不拿 NULL 去调 DeleteObject；没有对已释放对象的使用", async () => {
    const fake = await ready({ windows: [DEFAULT_WINDOWS[0], DEFAULT_WINDOWS[1]], noBitmap: true });
    const shot = await fake.background.capture();
    expect(shot.windows.map((w) => w.status)).toEqual(["failed", "failed"]);
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.calls.some((c) => c.fn === "DeleteObject")).toBe(false);
    expect(fake.gdi.invalidUses).toEqual([]);
  });

  it("位图建不成、删 DC 又出错：不让整帧失败（和别处的释放一致：每步兜住、记一条日志）", async () => {
    const fake = await ready({ windows: [DEFAULT_WINDOWS[0], DEFAULT_WINDOWS[1]], noBitmap: true, deleteDCThrows: true });
    const shot = await fake.background.capture(); // 以前：裸 call("DeleteDC") 抛出来，整帧报错
    expect(shot.windows.map((w) => w.status)).toEqual(["failed", "failed"]);
    expect(fake.logs.some((m) => m.includes("释放 GDI 对象") && m.includes("删除内存 DC"))).toBe(true);
  });

  it("创建阶段失败不留痕迹：不进搁置表、不被当成无响应窗口——故障消失后同一个驱动上立刻照常出图（时钟没动，不用等 60 秒）", async () => {
    const options: FakeOptions = { windows: oneWindow, bitmapThrows: true };
    const fake = await ready(options);
    await expect(fake.background.capture()).rejects.toThrow(/CreateCompatibleBitmap/);
    expect(fake.hungCalls).toHaveLength(0);
    options.bitmapThrows = false; // 故障消失（夹具每次调用才读 options）
    expect((await fake.background.capture()).windows.map((w) => w.status)).toEqual(["ok"]); // 若被误标成 hung，这里会是 timeout
    expect(fake.gdi.dcs.size).toBe(0);
    expect(fake.gdi.bitmaps.size).toBe(0);
    expect(fake.gdi.invalidUses).toEqual([]);
  });
});

// ═══════════════════════════ 输入：命中测试 / 鼠标 ═══════════════════════════

describe("点击：命中测试 → 子控件下钻 → 坐标换算 → PostMessage", () => {
  it("点在记事本的 Edit 子控件上：先 WM_ACTIVATE（顶层）+ WM_SETFOCUS（子控件），再 MOUSEMOVE → DOWN → UP，lParam = 子控件客户区坐标", async () => {
    const fake = await ready();
    await fake.background.click(50, 40);
    const lp = makeLParam(20, 15); // (50,40) − Edit 左上角 (30,25)
    expect(fake.posts).toEqual([
      { hwnd: H(0x10), msg: WM.ACTIVATE, wParam: WA_ACTIVE, lParam: 0 },
      { hwnd: H(0x11), msg: WM.SETFOCUS, wParam: 0, lParam: 0 },
      { hwnd: H(0x11), msg: WM.MOUSEMOVE, wParam: 0, lParam: lp },
      { hwnd: H(0x11), msg: WM.LBUTTONDOWN, wParam: MK.LBUTTON, lParam: lp },
      { hwnd: H(0x11), msg: WM.LBUTTONUP, wParam: 0, lParam: lp },
    ]);
    // 子窗口查找带「跳过不可见 / 禁用 / 透明」
    const child = fake.calls.find((c) => c.fn === "ChildWindowFromPointEx")!;
    expect(child.args[2]).toBe(CWP.SKIPINVISIBLE | CWP.SKIPDISABLED | CWP.SKIPTRANSPARENT);
    expect(child.args[1]).toEqual({ x: 30, y: 30 }); // 父窗口客户区坐标
    expect(fake.sleeps.length).toBeGreaterThan(0);
  });

  it("点在没有子控件的位置：消息发给顶层窗口本身，坐标 = 相对顶层窗口", async () => {
    const fake = await ready();
    await fake.background.click(25, 15); // 记事本里、Edit 之外
    const lp = makeLParam(5, 5);
    expect(fake.posts.slice(-3).map((p) => [p.hwnd, p.msg, p.lParam])).toEqual([
      [H(0x10), WM.MOUSEMOVE, lp],
      [H(0x10), WM.LBUTTONDOWN, lp],
      [H(0x10), WM.LBUTTONUP, lp],
    ]);
  });

  it("Z 序：重叠区域归最上层的窗口（记事本盖住微信）；只有微信的区域归微信", async () => {
    const fake = await ready();
    await fake.background.click(100, 40);
    // (100,40) 同时在记事本（含它的 Edit 子控件）和微信的矩形里：选中的是记事本——顶层激活发给 0x10，按下发给它的 Edit 子控件 0x11
    expect(fake.posts.find((p) => p.msg === WM.ACTIVATE)?.hwnd).toBe(H(0x10));
    expect(fake.posts.find((p) => p.msg === WM.LBUTTONDOWN)?.hwnd).toBe(H(0x11));
    fake.posts.length = 0;
    await fake.background.click(150, 80);
    expect(fake.posts.find((p) => p.msg === WM.LBUTTONDOWN)?.hwnd).toBe(H(0x20));
    expect(fake.posts.find((p) => p.msg === WM.ACTIVATE)?.hwnd).toBe(H(0x20));
  });

  it("被过滤掉的窗口不吃点击：本进程遮罩、点击穿透覆盖层、最小化的窗口；点在没有窗口的地方 → BAD_ARGS，什么消息都不发", async () => {
    const fake = await ready();
    await expect(fake.background.click(5, 5)).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining("没有可以操作的窗口") });
    expect(fake.posts).toEqual([]);
    // 屏幕上 (30,15) 落在最小化窗口 0x50 的矩形里，但它不参与命中，落到的是记事本
    await fake.background.click(30, 15);
    expect(fake.posts.find((p) => p.msg === WM.LBUTTONDOWN)?.hwnd).toBe(H(0x10));
  });

  it("右键 / 双击 / 三击用对应的消息；非法按钮 / 次数 → BAD_ARGS（没有任何消息发出）", async () => {
    const fake = await ready();
    await fake.background.click(50, 40, { button: "right" });
    expect(fake.posts.filter((p) => p.msg >= WM.RBUTTONDOWN && p.msg <= WM.RBUTTONDBLCLK).map((p) => p.msg)).toEqual([WM.RBUTTONDOWN, WM.RBUTTONUP]);
    fake.posts.length = 0;
    await fake.background.click(50, 40, { count: 2 });
    expect(fake.posts.filter((p) => p.msg !== WM.MOUSEMOVE && p.msg !== WM.ACTIVATE && p.msg !== WM.SETFOCUS).map((p) => p.msg)).toEqual([
      WM.LBUTTONDOWN,
      WM.LBUTTONUP,
      WM.LBUTTONDBLCLK,
      WM.LBUTTONUP,
    ]);
    fake.posts.length = 0;
    await expect(fake.background.click(50, 40, { button: "back" as never })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(fake.background.click(50, 40, { count: 9 })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(fake.background.click(Number.NaN, 4)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fake.posts).toEqual([]);
  });

  // 第三轮评审：点在标题栏上，以前会「成功返回、什么也没发生」（鼠标消息按客户区坐标发，非客户区不处理）
  describe("标题栏 / 菜单栏 / 边框（非客户区）：明说做不到（NEED_FOREGROUND），不假装成功", () => {
    // 窗口矩形 (20,10)-(120,60)：标题栏 + 菜单栏占顶部 30 像素、左边框 8 像素 → 客户区原点 (28, 40)
    const FRAMED: FakeWindow = { hwnd: H(0x300), pid: 100, tid: 11, className: "Notepad", rect: [20, 10, 120, 60], color: [0, 0, 255], clientOffset: [8, 30] };
    const frameOnly = (over: Partial<FakeWindow> = {}) => ready({ windows: [{ ...FRAMED, ...over }] });

    it("点标题栏 / 菜单栏（客户区原点上方）、左边框：NEED_FOREGROUND + 人话原因，什么消息都不发（连 WM_ACTIVATE 都没有）", async () => {
      const fake = await frameOnly();
      for (const [x, y] of [
        [60, 15], // 标题栏
        [60, 35], // 菜单栏（仍在客户区原点上方）
        [24, 50], // 左边框
        [20, 10], // 窗口左上角
      ] as const) {
        await expect(fake.background.click(x, y)).rejects.toMatchObject({ code: "NEED_FOREGROUND", message: expect.stringContaining("标题栏") });
      }
      expect(fake.posts).toEqual([]);
      // 右键 / 双击一样（按钮和次数不改变「点的是非客户区」）
      await expect(fake.background.click(60, 15, { button: "right" })).rejects.toMatchObject({ code: "NEED_FOREGROUND" });
      await expect(fake.background.click(60, 15, { count: 2 })).rejects.toMatchObject({ code: "NEED_FOREGROUND" });
      expect(fake.posts).toEqual([]);
    });

    it("客户区原点上（含边界）及以内照常点击，坐标 = 相对客户区原点；从拖拽起点落在非客户区也一样拒绝", async () => {
      const fake = await frameOnly();
      await fake.background.click(28, 40); // 刚好是客户区原点
      const lp = makeLParam(0, 0);
      expect(fake.posts.slice(-3).map((p) => [p.hwnd, p.msg, p.lParam])).toEqual([
        [H(0x300), WM.MOUSEMOVE, lp],
        [H(0x300), WM.LBUTTONDOWN, lp],
        [H(0x300), WM.LBUTTONUP, lp],
      ]);
      fake.posts.length = 0;
      await fake.background.click(60, 50);
      expect(fake.posts.some((p) => p.msg === WM.LBUTTONDOWN && p.lParam === makeLParam(32, 10))).toBe(true);
      // 差一个像素：y=39 在客户区原点上方 / x=27 在它左边
      fake.posts.length = 0;
      await expect(fake.background.click(60, 39)).rejects.toMatchObject({ code: "NEED_FOREGROUND" });
      await expect(fake.background.click(27, 50)).rejects.toMatchObject({ code: "NEED_FOREGROUND" });
      expect(fake.posts).toEqual([]);
    });

    it("拖拽：从标题栏起拖（移动窗口）→ NEED_FOREGROUND、什么都不发；从客户区起拖、落点在标题栏 → 照常（鼠标已被捕获）", async () => {
      const fake = await frameOnly();
      await expect(fake.background.drag({ x: 60, y: 15 }, { x: 100, y: 50 }, { durationMs: 0 })).rejects.toMatchObject({ code: "NEED_FOREGROUND" });
      expect(fake.posts).toEqual([]);
      await fake.background.drag({ x: 60, y: 50 }, { x: 60, y: 15 }, { durationMs: 0 });
      expect(fake.posts.some((p) => p.msg === WM.LBUTTONDOWN)).toBe(true);
      expect(fake.posts.at(-1)?.msg).toBe(WM.LBUTTONUP);
    });

    it("自绘标题栏的应用（整个窗口都是客户区，clientOffset 为 0）：顶部一排照常能点；点到子控件也不受影响", async () => {
      const fake = await frameOnly({ clientOffset: undefined });
      await fake.background.click(60, 11);
      expect(fake.posts.some((p) => p.msg === WM.LBUTTONDOWN && p.lParam === makeLParam(40, 1))).toBe(true);
      // 带子控件的窗口：点在子控件上（子控件本来就在客户区里）不受「非客户区」判断影响
      const withChild = await frameOnly({ children: [{ hwnd: H(0x301), className: "Edit", rect: [30, 45, 110, 58] }] });
      await withChild.background.click(50, 50);
      expect(withChild.posts.find((p) => p.msg === WM.LBUTTONDOWN)?.hwnd).toBe(H(0x301));
    });

    it("只看顶层窗口的非客户区：点在子控件自己的边框上（比如 Edit 的 2 像素凹陷边框，子控件客户区坐标为负）照常发给子控件，不当成标题栏拒绝", async () => {
      const fake = await frameOnly({ children: [{ hwnd: H(0x301), className: "Edit", rect: [30, 45, 110, 58], clientOffset: [2, 2] }] });
      await fake.background.click(31, 46); // 子控件窗口矩形内、它的客户区原点 (32, 47) 的左上方 → 子控件客户区坐标 (-1, -1)
      const down = fake.posts.find((p) => p.msg === WM.LBUTTONDOWN);
      expect(down?.hwnd).toBe(H(0x301));
      expect(down?.lParam).toBe(makeLParam(-1, -1));
    });

    it("悬停 / 滚轮不受限制（没有「假装成功」的问题，也不该因此多出一种失败）", async () => {
      const fake = await frameOnly();
      await expect(fake.background.mouseMove(60, 15)).resolves.toBeUndefined();
      await expect(fake.background.scroll(60, 15, 0, -1)).resolves.toBeUndefined();
    });
  });

  it("WM_ACTIVATE / WM_SETFOCUS 对同一个顶层窗口 60 秒内只补一次，过了再补", async () => {
    const fake = await ready();
    await fake.background.click(50, 40);
    fake.posts.length = 0;
    await fake.background.click(50, 40);
    expect(fake.posts.some((p) => p.msg === WM.ACTIVATE)).toBe(false);
    fake.state.clock += 61_000;
    fake.posts.length = 0;
    await fake.background.click(50, 40);
    expect(fake.posts.some((p) => p.msg === WM.ACTIVATE)).toBe(true);
  });

  it("按下后抬起失败：补发一次抬起（别让应用以为按钮一直按着），原始错误照样抛出", async () => {
    const fake = await ready({ failPost: [WM.LBUTTONUP] });
    await expect(fake.background.click(50, 40)).rejects.toMatchObject({ code: "INTERNAL", message: expect.stringContaining("窗口没有接收消息") });
    expect(fake.posts.filter((p) => p.msg === WM.LBUTTONUP)).toHaveLength(2); // 原本一次 + 补救一次
    // 还没按下就失败：没有东西要补
    const early = await ready({ failPost: [WM.MOUSEMOVE] });
    await expect(early.background.click(50, 40)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(early.posts.some((p) => p.msg === WM.LBUTTONUP)).toBe(false);
  });

  it("PostMessage 失败的错误里带 Win32 错误码和「管理员权限窗口会被拦」的提示", async () => {
    const fake = await ready({ failPost: [WM.MOUSEMOVE] });
    fake.state.lastError = 5;
    await expect(fake.background.click(50, 40)).rejects.toThrow(/Win32 错误码 5.*管理员/s);
  });

  it("mouseMove：只发一条 MOUSEMOVE（带激活补丁）", async () => {
    const fake = await ready();
    await fake.background.mouseMove(50, 40);
    expect(fake.posts.map((p) => p.msg)).toEqual([WM.ACTIVATE, WM.SETFOCUS, WM.MOUSEMOVE]);
  });
});

describe("拖拽 / 滚轮", () => {
  it("drag：整个拖拽发给起点处的控件；按下 → 逐点移动（带 MK_LBUTTON）→ 终点 → 抬起；坐标按起点客户区 + 位移", async () => {
    const fake = await ready();
    await fake.background.drag({ x: 40, y: 30 }, { x: 100, y: 50 }, { durationMs: 110 });
    const body = fake.posts.filter((p) => p.msg !== WM.ACTIVATE && p.msg !== WM.SETFOCUS);
    expect(body[0]).toEqual({ hwnd: H(0x11), msg: WM.MOUSEMOVE, wParam: 0, lParam: makeLParam(10, 5) });
    expect(body[1]).toEqual({ hwnd: H(0x11), msg: WM.LBUTTONDOWN, wParam: MK.LBUTTON, lParam: makeLParam(10, 5) });
    const moves = body.slice(2, -1);
    expect(moves.every((p) => p.msg === WM.MOUSEMOVE && p.wParam === MK.LBUTTON && p.hwnd === H(0x11))).toBe(true);
    expect(moves.length).toBe(10); // 9 个中间点 + 终点
    expect(moves.at(-1)?.lParam).toBe(makeLParam(70, 25)); // 终点 (100,50) − Edit 原点 (30,25)
    expect(body.at(-1)).toEqual({ hwnd: H(0x11), msg: WM.LBUTTONUP, wParam: 0, lParam: makeLParam(70, 25) });
    expect(fake.sleeps.filter((ms) => ms === 10).length).toBe(11); // 110ms / 11 次停顿
  });

  it("drag 中途失败：照样补发抬起（别让应用以为按钮一直按着），原始错误抛出", async () => {
    // 第 4 次 MOUSEMOVE（起点之后的第 3 个路径点）失败
    const fake = await ready({ failPostNth: { msg: WM.MOUSEMOVE, nth: 4 } });
    await expect(fake.background.drag({ x: 40, y: 30 }, { x: 100, y: 50 }, { durationMs: 0 })).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("窗口没有接收消息"),
    });
    const ups = fake.posts.filter((p) => p.msg === WM.LBUTTONUP);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({ hwnd: H(0x11), lParam: makeLParam(70, 25) });
    expect(fake.posts.filter((p) => p.msg === WM.LBUTTONDOWN)).toHaveLength(1);
  });

  it("drag：还没按下就失败（起点的 MOUSEMOVE 被拒）→ 没有东西要补，不发抬起；抬起本身失败 → 错误抛出（不被吞）", async () => {
    const early = await ready({ failPost: [WM.MOUSEMOVE] });
    await expect(early.background.drag({ x: 40, y: 30 }, { x: 100, y: 50 })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(early.posts.some((p) => p.msg === WM.LBUTTONUP || p.msg === WM.LBUTTONDOWN)).toBe(false);
    const upFails = await ready({ failPost: [WM.LBUTTONUP] });
    await expect(upFails.background.drag({ x: 40, y: 30 }, { x: 100, y: 50 }, { durationMs: 0 })).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("drag 非法参数 → BAD_ARGS，不发消息", async () => {
    const fake = await ready();
    await expect(fake.background.drag({ x: Number.NaN, y: 0 }, { x: 1, y: 1 })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(fake.background.drag({ x: 40, y: 30 }, { x: 1, y: 1 }, { durationMs: -1 })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(fake.background.drag({ x: 40, y: 30 }, { x: 1, y: 1 }, { button: "x" as never })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fake.posts).toEqual([]);
  });

  it("scroll：WM_MOUSEWHEEL 发给点下面最深的控件，lParam = 屏幕坐标，dy > 0 = 向下 = 负滚动量", async () => {
    const fake = await ready();
    await fake.background.scroll(50, 40, 0, 3);
    const wheel = fake.posts.find((p) => p.msg === WM.MOUSEWHEEL)!;
    expect(wheel).toEqual({ hwnd: H(0x11), msg: WM.MOUSEWHEEL, wParam: makeWheelWParam(0, -360), lParam: makeLParam(50, 40) });
    fake.posts.length = 0;
    await fake.background.scroll(50, 40, 2, 0);
    expect(fake.posts.find((p) => p.msg === WM.MOUSEHWHEEL)?.wParam).toBe(makeWheelWParam(0, 240));
    await expect(fake.background.scroll(50, 40, 0, 0)).rejects.toMatchObject({ code: "BAD_ARGS" });
  });
});

// ═══════════════════════════ 输入：键盘 ═══════════════════════════

describe("键盘目标", () => {
  it("没点过任何东西：发给最上层窗口；线程有真焦点控件就发给它", async () => {
    const plain = await ready();
    await plain.background.keyCombo({ key: "enter" });
    expect(new Set(plain.posts.filter((p) => p.msg === WM.KEYDOWN).map((p) => p.hwnd))).toEqual(new Set([H(0x10)]));

    const focused = await ready({ focus: { 11: H(0x11) } });
    await focused.background.keyCombo({ key: "enter" });
    expect(new Set(focused.posts.filter((p) => p.msg === WM.KEYDOWN).map((p) => p.hwnd))).toEqual(new Set([H(0x11)]));
  });

  it("点过某个控件之后：键盘发给它（5 分钟内）；reset() 或过期后退回最上层窗口", async () => {
    const fake = await ready();
    await fake.background.click(50, 40);
    fake.posts.length = 0;
    await fake.background.keyCombo({ key: "enter" });
    expect(fake.posts.find((p) => p.msg === WM.KEYDOWN)?.hwnd).toBe(H(0x11));

    fake.background.reset();
    fake.posts.length = 0;
    await fake.background.keyCombo({ key: "enter" });
    expect(fake.posts.find((p) => p.msg === WM.KEYDOWN)?.hwnd).toBe(H(0x10));

    await fake.background.click(50, 40);
    fake.state.clock += 5 * 60_000 + 1;
    fake.posts.length = 0;
    await fake.background.keyCombo({ key: "enter" });
    expect(fake.posts.find((p) => p.msg === WM.KEYDOWN)?.hwnd).toBe(H(0x10));
  });

  it("点过的窗口已经不在了 → 退回最上层窗口", async () => {
    const fake = await ready({ windows: DEFAULT_WINDOWS.map((w) => w) });
    await fake.background.click(150, 80); // 微信
    fake.posts.length = 0;
    // 再造一个只有记事本的场景比较麻烦：直接让微信 iconic（最小化）后它就不在枚举里
    DEFAULT_WINDOWS[1].iconic = true;
    try {
      await fake.background.keyCombo({ key: "enter" });
      expect(fake.posts.find((p) => p.msg === WM.KEYDOWN)?.hwnd).toBe(H(0x10));
    } finally {
      DEFAULT_WINDOWS[1].iconic = false;
    }
  });

  it("屏幕上没有任何可操作窗口 → BAD_ARGS", async () => {
    const fake = await ready({ windows: [] });
    await expect(fake.background.keyCombo({ key: "enter" })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining("没有可以操作的窗口") });
    await expect(fake.background.typeText("hi")).rejects.toMatchObject({ code: "BAD_ARGS" });
  });
});

describe("keyCombo", () => {
  it("Enter：KEYDOWN → CHAR(13) → KEYUP，扫描码来自 scanOf；没有修饰键不带提示", async () => {
    const fake = await ready();
    const result = await fake.background.keyCombo({ key: "enter" });
    expect(result).toEqual({});
    expect(fake.posts.filter((p) => p.msg !== WM.ACTIVATE && p.msg !== WM.SETFOCUS)).toEqual([
      { hwnd: H(0x10), msg: WM.KEYDOWN, wParam: 0x0d, lParam: keyLParam({ scan: 0x0e }) },
      { hwnd: H(0x10), msg: WM.CHAR, wParam: 13, lParam: keyLParam({}) },
      { hwnd: H(0x10), msg: WM.KEYUP, wParam: 0x0d, lParam: keyLParam({ scan: 0x0e, up: true }) },
    ]);
  });

  it("Ctrl+A 且目标是 Edit 类控件：只发 EM_SETSEL(0, -1)，不再发模拟按键（二选一，免得重复生效）", async () => {
    const fake = await ready({ focus: { 11: H(0x11) } });
    const result = await fake.background.keyCombo({ mods: ["ctrl"], key: "a" });
    expect(result).toEqual({});
    expect(fake.posts.filter((p) => p.msg !== WM.ACTIVATE && p.msg !== WM.SETFOCUS)).toEqual([{ hwnd: H(0x11), msg: EM_SETSEL, wParam: 0, lParam: -1 }]);
  });

  it("Ctrl+C / Ctrl+V 且目标是 Edit 类：WM_COPY / WM_PASTE", async () => {
    const fake = await ready({ focus: { 11: H(0x11) } });
    await fake.background.keyCombo({ mods: ["ctrl"], key: "c" });
    await fake.background.keyCombo({ mods: ["ctrl"], key: "v" });
    expect(fake.posts.filter((p) => p.msg === WM.COPY || p.msg === WM.PASTE).map((p) => p.msg)).toEqual([WM.COPY, WM.PASTE]);
  });

  it("Ctrl+A 但目标不是 Edit 类（微信 / Qt）：发模拟按键序列，并附「尽力而为」提示", async () => {
    const fake = await ready();
    await fake.background.click(150, 80); // 微信（Qt5QWindowIcon）
    fake.posts.length = 0;
    const result = await fake.background.keyCombo({ mods: ["ctrl"], key: "a" });
    expect(result.note).toContain("尽力模拟");
    expect(fake.posts.map((p) => [p.msg, p.wParam])).toEqual([
      [WM.KEYDOWN, 0x11],
      [WM.KEYDOWN, 0x41],
      [WM.CHAR, 1],
      [WM.KEYUP, 0x41],
      [WM.KEYUP, 0x11],
    ]);
  });

  it("系统级组合键（Win 键 / Alt+Tab）→ NEED_FOREGROUND，一条消息都不发", async () => {
    const fake = await ready();
    await expect(fake.background.keyCombo({ mods: ["meta"], key: "d" })).rejects.toMatchObject({ code: "NEED_FOREGROUND", message: expect.stringContaining("Win 键") });
    await expect(fake.background.keyCombo({ mods: ["alt"], key: "tab" })).rejects.toMatchObject({ code: "NEED_FOREGROUND" });
    expect(fake.posts).toEqual([]);
  });

  it("非法按键 → BAD_ARGS", async () => {
    const fake = await ready();
    await expect(fake.background.keyCombo({ key: "nonsense" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fake.posts).toEqual([]);
  });
});

describe("typeText", () => {
  it("ASCII：每个字符 KEYDOWN → CHAR → KEYUP；\\n → Enter；中文只发 WM_CHAR；先补一次激活", async () => {
    const fake = await ready();
    await fake.background.typeText("Hi\n中");
    expect(fake.posts.slice(0, 2).map((p) => p.msg)).toEqual([WM.ACTIVATE, WM.SETFOCUS]);
    expect(fake.posts.slice(2).map((p) => [p.msg, p.wParam])).toEqual([
      [WM.KEYDOWN, 0x48],
      [WM.CHAR, 72],
      [WM.KEYUP, 0x48],
      [WM.KEYDOWN, 0x49],
      [WM.CHAR, 105],
      [WM.KEYUP, 0x49],
      [WM.KEYDOWN, 0x0d],
      [WM.CHAR, 13],
      [WM.KEYUP, 0x0d],
      [WM.CHAR, 0x4e2d],
    ]);
  });

  it("分批：每批 30 个字符，批间停顿 10ms；shouldStop 在每批开头问，true 就收手（不抛错）", async () => {
    const fake = await ready();
    await fake.background.typeText("x".repeat(70));
    expect(fake.sleeps).toEqual([10, 10]); // 3 批 → 2 次批间停顿
    expect(fake.posts.filter((p) => p.msg === WM.CHAR)).toHaveLength(70);

    const stopped = await ready();
    let asked = 0;
    await stopped.background.typeText("y".repeat(100), {
      shouldStop: () => {
        asked += 1;
        return asked >= 2;
      },
    });
    expect(stopped.posts.filter((p) => p.msg === WM.CHAR)).toHaveLength(30); // 只打了第一批
  });

  it("空字符串什么都不发；非字符串 / 超长 / 控制字符 → BAD_ARGS（错误里不含文本）", async () => {
    const fake = await ready();
    await fake.background.typeText("");
    expect(fake.posts).toEqual([]);
    await expect(fake.background.typeText(123 as never)).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(fake.background.typeText("a".repeat(20001))).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(fake.background.typeText("p@ss\u0001word")).rejects.toThrow(/第 5 个字符/);
    expect(fake.posts).toEqual([]);
  });

  it("隐私：消息被拒时的错误、日志里没有任何文本（也没有长度）", async () => {
    const fake = await ready({ failPost: [WM.CHAR] });
    const secret = "S3cr3t-pa55!";
    let message = "";
    try {
      await fake.background.typeText(secret);
    } catch (e) {
      message = String((e as Error).message) + JSON.stringify((e as { cause?: unknown }).cause ?? "");
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("S3cr3t");
    expect(message).not.toMatch(/\b12\b/); // 长度
    expect(fake.logs.join("\n")).not.toContain("S3cr3t");
    expect(JSON.stringify(fake.background.diagnostics())).not.toContain("S3cr3t");
  });
});

// ═══════════════════════════ 应用 / 自检辅助 ═══════════════════════════

describe("openApp / 自检辅助 / reset", () => {
  it("openApp 交给驱动，带 { background: true }（应用已在运行就不抢前台）", async () => {
    const fake = await ready();
    await fake.background.openApp("微信");
    expect(fake.opens).toEqual([["微信", { background: true }]]);
  });

  it("findWindowsByTitle：标题包含文本的可见顶层窗口（不含被过滤的）；readTitle / classOf / closeWindow", async () => {
    const fake = await ready();
    expect(fake.background.findWindowsByTitle("记事本").map((w) => w.hwnd)).toEqual([H(0x10)]);
    expect(fake.background.findWindowsByTitle("Flowship 遮罩")).toEqual([]); // 本进程的窗口不在枚举里
    expect(fake.background.findWindowsByTitle("最小化")).toEqual([]);
    expect(fake.background.readTitle(H(0x20))).toBe("微信");
    expect(fake.background.classOf(H(0x20))).toBe("Qt5QWindowIcon");
    fake.background.closeWindow(H(0x20));
    expect(fake.posts).toEqual([{ hwnd: H(0x20), msg: WM.CLOSE, wParam: 0, lParam: 0 }]);
  });

  it("windowAt：屏幕点上最上层的可操作窗口（和点击命中同一套规则）；没有 / 被过滤的窗口 → null；只读，不发任何消息", async () => {
    const fake = await ready();
    expect(fake.background.windowAt(100, 40)?.hwnd).toBe(H(0x10)); // 记事本盖在微信上面
    expect(fake.background.windowAt(150, 80)?.hwnd).toBe(H(0x20)); // 只有微信的区域
    expect(fake.background.windowAt(30, 15)?.hwnd).toBe(H(0x10)); // 最小化的窗口不参与命中
    expect(fake.background.windowAt(5, 5)).toBeNull();
    expect(fake.posts).toEqual([]);
  });

  it("windowAt 和点击的命中结果一致（探针「靶子在最上层才打字」的前提）", async () => {
    for (const [x, y] of [
      [100, 40],
      [150, 80],
      [25, 15],
      [50, 40],
    ] as const) {
      // 每个点位用全新的环境：同一个顶层窗口 60 秒内只补一次 WM_ACTIVATE
      const fake = await ready();
      const top = fake.background.windowAt(x, y);
      await fake.background.click(x, y);
      // 顶层激活（WM_ACTIVATE）一定发给 windowAt 返回的那个窗口
      expect(fake.posts.find((p) => p.msg === WM.ACTIVATE)?.hwnd).toBe(top?.hwnd);
    }
  });

  it("windowAt：坐标非法 → BAD_ARGS；init 之前 → UNSUPPORTED「尚未初始化」", async () => {
    const fake = await ready();
    let bad: { code?: string } | undefined;
    try {
      fake.background.windowAt(Number.NaN, 4);
    } catch (e) {
      bad = e as { code?: string };
    }
    expect(bad?.code).toBe("BAD_ARGS");

    const cold = createFake();
    let early: { code?: string; message?: string } | undefined;
    try {
      cold.background.windowAt(1, 1);
    } catch (e) {
      early = e as { code?: string; message?: string };
    }
    expect(early?.code).toBe("UNSUPPORTED");
    expect(early?.message).toContain("尚未初始化");
  });

  it("没有 GetClassNameW 时类名为空：Ctrl+A 一律走模拟按键（不会误发 EM_SETSEL）", async () => {
    const fake = await ready({ missing: ["GetClassNameW"], focus: { 11: H(0x11) } });
    await fake.background.keyCombo({ mods: ["ctrl"], key: "a" });
    expect(fake.posts.some((p) => p.msg === EM_SETSEL)).toBe(false);
    expect(fake.posts.some((p) => p.msg === WM.KEYDOWN)).toBe(true);
  });
});
