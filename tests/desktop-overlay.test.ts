/**
 * 遮罩（electron-app/desktop/overlay.mjs）——假 BrowserWindow / screen。
 *
 * 遮罩出问题的后果都很具体：
 * - 抢了焦点 → AI 的键盘事件全落到遮罩上，什么都输不进去
 * - 没开鼠标穿透 → AI 的点击点不到下面的应用
 * - 没开内容保护 → 旁人的录屏 / 截图能直接看到 AI 在干什么（开了之后 macOS 27 上 AI 自己的截图会被截成一片黑，
 *   由 capture-guard 在截图的一瞬间撤遮罩来绕开；generation() 让它知道「新一轮遮罩开始了，要重新对照」）
 * - 没盖住所有显示器 / 热插拔没处理 → 旁人能看到屏幕
 * - hide 不干净 → 用户回来发现屏幕被一层东西盖着
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildOverlayHtml, createOverlay, MAX_SUSPEND_MS, OVERLAY_BACKGROUND, OVERLAY_RGB } from "../electron-app/desktop/overlay.mjs";

class FakeWindow {
  static instances: FakeWindow[] = [];
  static failOn: string | null = null;
  /** setOpacity 抛错的窗口（模拟平台不支持 / 窗口状态异常） */
  static failOpacityFor: ((w: FakeWindow) => boolean) | null = null;
  /** 只让满足条件的窗口创建失败（模拟「多块显示器里只有一块没盖上」） */
  static failFor: ((opts: Record<string, unknown>) => boolean) | null = null;
  /** setBounds 抛错的窗口（模拟窗口状态异常 / 平台调不动尺寸） */
  static failSetBoundsFor: ((w: FakeWindow) => boolean) | null = null;
  opts: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  calls: string[] = [];
  url = "";
  destroyed = false;
  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    FakeWindow.instances.push(this);
  }
  setAlwaysOnTop(flag: boolean, level: string) {
    this.calls.push(`setAlwaysOnTop:${flag}:${level}`);
  }
  setVisibleOnAllWorkspaces(flag: boolean, o: Record<string, unknown>) {
    this.calls.push(`setVisibleOnAllWorkspaces:${flag}:${JSON.stringify(o)}`);
  }
  setIgnoreMouseEvents(flag: boolean) {
    this.calls.push(`setIgnoreMouseEvents:${flag}`);
  }
  setContentProtection(flag: boolean) {
    if (FakeWindow.failOn === "setContentProtection" || FakeWindow.failFor?.(this.opts)) throw new Error("不支持内容保护");
    this.calls.push(`setContentProtection:${flag}`);
  }
  setOpacity(value: number) {
    if (FakeWindow.failOpacityFor?.(this)) throw new Error("不支持透明度");
    this.calls.push(`setOpacity:${value}`);
  }
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    if (FakeWindow.failSetBoundsFor?.(this)) throw new Error("调不动尺寸");
    this.calls.push(`setBounds:${b.x},${b.y},${b.width},${b.height}`);
  }
  loadURL(url: string) {
    this.url = url;
    return Promise.resolve();
  }
  showInactive() {
    this.calls.push("showInactive");
  }
  show() {
    this.calls.push("show");
  }
  focus() {
    this.calls.push("focus");
  }
  destroy() {
    this.destroyed = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

class FakeScreen extends EventEmitter {
  displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number } }>;
  constructor(displays: FakeScreen["displays"]) {
    super();
    this.displays = displays;
  }
  getAllDisplays() {
    return this.displays;
  }
}

const D1 = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } };
const D2 = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };

const make = (displays = [D1], platform = "darwin", maxSuspendMs?: number, now?: () => number) => {
  const screen = new FakeScreen(displays);
  const logs: string[] = [];
  // suspend / resume / isSuspended / generation / shownAt 在 DesktopOverlay 类型里是可选的（旧实现 / 假遮罩没有），真实遮罩一定有
  const overlay = createOverlay({ BrowserWindow: FakeWindow, screen, platform, log: (m: string) => logs.push(m), maxSuspendMs, now }) as Required<
    ReturnType<typeof createOverlay>
  >;
  return { overlay, screen, logs };
};

beforeEach(() => {
  FakeWindow.instances = [];
  FakeWindow.failOn = null;
  FakeWindow.failFor = null;
  FakeWindow.failOpacityFor = null;
  FakeWindow.failSetBoundsFor = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("窗口属性", () => {
  it("不抢焦点：focusable=false，只调 showInactive，绝不 show() / focus()", () => {
    const { overlay } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    expect(w.opts.focusable).toBe(false);
    expect(w.calls).toContain("showInactive");
    expect(w.calls).not.toContain("show");
    expect(w.calls).not.toContain("focus");
  });

  it("鼠标穿透 + 不进截图 + 最高层级 + 所有空间", () => {
    const { overlay } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    expect(w.calls).toContain("setIgnoreMouseEvents:true");
    expect(w.calls).toContain("setContentProtection:true");
    expect(w.calls).toContain("setAlwaysOnTop:true:screen-saver");
    // skipTransformProcessType：否则 macOS 上 Dock 图标会被隐藏
    expect(w.calls.find((c) => c.startsWith("setVisibleOnAllWorkspaces"))).toContain('"skipTransformProcessType":true');
  });

  it("无边框、不进任务栏、不可移动 / 缩放；页面没有 node 能力、沙箱开启", () => {
    const { overlay } = make();
    overlay.show();
    const o = FakeWindow.instances[0]!.opts;
    expect(o).toMatchObject({ frame: false, skipTaskbar: true, movable: false, resizable: false, alwaysOnTop: true, hasShadow: false });
    expect(o.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(o.webPreferences.preload).toBeUndefined();
  });

  it("macOS 用 panel 类型（不激活应用），Windows 不用", () => {
    make([D1], "darwin").overlay.show();
    expect(FakeWindow.instances[0]!.opts.type).toBe("panel");
    FakeWindow.instances = [];
    make([D1], "win32").overlay.show();
    expect(FakeWindow.instances[0]!.opts.type).toBeUndefined();
  });

  it("页面：静态内联、不加载任何外部资源", () => {
    const { overlay } = make();
    overlay.show({ message: "正在整理你的文件" });
    const url = FakeWindow.instances[0]!.url;
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    expect(html).toContain("正在整理你的文件");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
  });

  it("文案做 HTML 转义，里面的标签不会生效", () => {
    const html = buildOverlayHtml('<img src=x onerror="alert(1)"> & "q"');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
  });

  it("文案缺省 / 空白 / 过长：用默认文案或截断", () => {
    const { overlay } = make();
    overlay.show({ message: "   " });
    const html1 = decodeURIComponent(FakeWindow.instances[0]!.url.split(",").slice(1).join(","));
    expect(html1).toContain("Flowship 正在替你操作电脑");
    overlay.hide();
    FakeWindow.instances = [];
    overlay.show({ message: "字".repeat(200) });
    const html2 = decodeURIComponent(FakeWindow.instances[0]!.url.split(",").slice(1).join(","));
    expect(html2).toContain("字".repeat(80));
    expect(html2).not.toContain("字".repeat(81));
  });
});

describe("多显示器与热插拔", () => {
  it("每块显示器一个窗口，位置尺寸 = 显示器的 bounds（含负坐标的副屏）", () => {
    const { overlay } = make([D1, D2]);
    overlay.show();
    expect(FakeWindow.instances.map((w) => [w.opts.x, w.opts.y, w.opts.width, w.opts.height])).toEqual([
      [0, 0, 1512, 982],
      [-1920, 0, 1920, 1080],
    ]);
  });

  it("显示中接入新屏幕 → 补一个窗口；拔掉 → 销毁对应窗口", () => {
    const { overlay, screen } = make([D1]);
    overlay.show();
    expect(FakeWindow.instances).toHaveLength(1);
    screen.emit("display-added", {}, D2);
    expect(FakeWindow.instances).toHaveLength(2);
    screen.emit("display-added", {}, D2); // 重复事件不重复建
    expect(FakeWindow.instances).toHaveLength(2);
    screen.emit("display-removed", {}, D2);
    expect(FakeWindow.instances[1]!.destroyed).toBe(true);
    expect(FakeWindow.instances[0]!.destroyed).toBe(false);
  });

  it("没显示遮罩时收到热插拔事件：什么都不做（监听只在显示期间存在）", () => {
    const { overlay, screen } = make([D1]);
    screen.emit("display-added", {}, D2);
    screen.emit("display-metrics-changed", {}, D1, ["bounds"]);
    expect(FakeWindow.instances).toHaveLength(0);
    overlay.show();
    expect(screen.listenerCount("display-added")).toBe(1);
    expect(screen.listenerCount("display-removed")).toBe(1);
    expect(screen.listenerCount("display-metrics-changed")).toBe(1);
    overlay.hide();
    expect(screen.listenerCount("display-added")).toBe(0);
    expect(screen.listenerCount("display-removed")).toBe(0);
    expect(screen.listenerCount("display-metrics-changed")).toBe(0);
  });
});

/**
 * 会话中途改分辨率 / 缩放 / 旋转 / 重新排列屏幕：窗口是按 show() 那一刻的 bounds 建的，不跟着调，
 * 新旧 bounds 之间的那一块屏幕就是裸的——旁人能看到 AI 在干什么（遮罩存在的全部意义就是别让旁人看到）。
 */
describe("显示设置变了（display-metrics-changed）：遮罩跟着新的 bounds", () => {
  const NEW_D1 = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
  const opacity = (w: FakeWindow) => w.calls.filter((c) => c.startsWith("setOpacity"));
  const boundsCalls = (w: FakeWindow) => w.calls.filter((c) => c.startsWith("setBounds"));

  it("分辨率变了：这块显示器的窗口调到新的 bounds；别的显示器的窗口一个字不动；不新建、不销毁", () => {
    const { overlay, screen } = make([D1, D2]);
    overlay.show();
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    const [a, b] = FakeWindow.instances as [FakeWindow, FakeWindow];
    expect(boundsCalls(a)).toEqual(["setBounds:0,0,2560,1440"]);
    expect(boundsCalls(b)).toEqual([]);
    expect(FakeWindow.instances).toHaveLength(2);
    expect(a.destroyed || b.destroyed).toBe(false);
    expect(overlay.isShown()).toBe(true);
  });

  it("副屏换了摆放位置（负坐标 → 正坐标）：窗口跟着挪过去", () => {
    const { overlay, screen } = make([D1, D2]);
    overlay.show();
    screen.emit("display-metrics-changed", {}, { id: 2, bounds: { x: 1512, y: -100, width: 1920, height: 1080 } }, ["bounds"]);
    expect(boundsCalls(FakeWindow.instances[1]!)).toEqual(["setBounds:1512,-100,1920,1080"]);
  });

  it("不依赖 changedMetrics 的说法：只报 workArea / scaleFactor / rotation、甚至没带这个参数，也照样按显示器当前的 bounds 校一遍", () => {
    const { overlay, screen } = make([D1]);
    overlay.show();
    const w = FakeWindow.instances[0]!;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["workArea"]);
    screen.emit("display-metrics-changed", {}, NEW_D1, ["scaleFactor", "rotation"]);
    screen.emit("display-metrics-changed", {}, NEW_D1);
    expect(boundsCalls(w)).toEqual(Array(3).fill("setBounds:0,0,2560,1440"));
    expect(FakeWindow.instances).toHaveLength(1);
  });

  it("透明期间（截图撤遮罩）改分辨率：只调尺寸、不碰透明度——resume 照常配对恢复", () => {
    const { overlay, screen } = make([D1]);
    overlay.show();
    overlay.suspend();
    const w = FakeWindow.instances[0]!;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    expect(boundsCalls(w)).toEqual(["setBounds:0,0,2560,1440"]);
    expect(opacity(w)).toEqual(["setOpacity:0"]);
    overlay.resume();
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("窗口调不动尺寸（setBounds 抛错）：记日志，销毁旧窗口、按新 bounds 重建；之后 hide 能把重建出来的窗口一并清掉", () => {
    FakeWindow.failSetBoundsFor = (w) => w === FakeWindow.instances[0];
    const { overlay, screen, logs } = make([D1]);
    overlay.show();
    const old = FakeWindow.instances[0]!;
    expect(() => screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"])).not.toThrow();
    expect(old.destroyed).toBe(true);
    expect(FakeWindow.instances).toHaveLength(2);
    const fresh = FakeWindow.instances[1]!;
    expect([fresh.opts.x, fresh.opts.y, fresh.opts.width, fresh.opts.height]).toEqual([0, 0, 2560, 1440]);
    expect(fresh.destroyed).toBe(false);
    expect(fresh.calls).toContain("showInactive");
    expect(fresh.calls).not.toContain("show");
    expect(logs.join("\n")).toContain("遮罩调整尺寸失败");
    expect(overlay.isShown()).toBe(true);
    overlay.hide();
    expect(fresh.destroyed).toBe(true);
    expect(overlay.isShown()).toBe(false);
  });

  it("透明期间调不动尺寸、重建出来的窗口也保持透明（不然截图里多出一张遮罩），resume 时一并恢复", () => {
    FakeWindow.failSetBoundsFor = (w) => w === FakeWindow.instances[0];
    const { overlay, screen } = make([D1]);
    overlay.show();
    overlay.suspend();
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    const fresh = FakeWindow.instances[1]!;
    expect(opacity(fresh)).toEqual(["setOpacity:0"]);
    overlay.resume();
    expect(opacity(fresh)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("重建也失败：记日志、不抛、不留半成品；这块显示器这一刻没有遮罩，下一次事件再补", () => {
    FakeWindow.failSetBoundsFor = (w) => w === FakeWindow.instances[0];
    const { overlay, screen, logs } = make([D1, D2]);
    overlay.show();
    FakeWindow.failFor = (o) => o.width === 2560; // 新尺寸的窗口建不出来
    expect(() => screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"])).not.toThrow();
    expect(FakeWindow.instances.filter((w) => !w.destroyed)).toHaveLength(1); // 只剩副屏那块
    expect(logs.join("\n")).toContain("显示器 1 的遮罩创建失败");
    expect(overlay.isShown()).toBe(true);
    FakeWindow.failFor = null;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    const alive = FakeWindow.instances.filter((w) => !w.destroyed);
    expect(alive).toHaveLength(2);
    expect(alive.map((w) => w.opts.width).sort()).toEqual([1920, 2560]);
  });

  it("这块显示器的窗口已经被销毁了：重建，而不是对着一个死窗口 setBounds", () => {
    const { overlay, screen } = make([D1, D2]);
    overlay.show();
    FakeWindow.instances[0]!.destroyed = true;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    expect(boundsCalls(FakeWindow.instances[0]!)).toEqual([]);
    expect(FakeWindow.instances).toHaveLength(3);
    const fresh = FakeWindow.instances[2]!;
    expect([fresh.opts.x, fresh.opts.width, fresh.opts.height]).toEqual([0, 2560, 1440]);
    expect(fresh.destroyed).toBe(false);
  });

  it("这块显示器上本来就没有窗口（它接入时遮罩没建成）：趁机补建；已经拔掉的显示器的迟到事件不建（不然留下一个没人销毁的窗口）", () => {
    FakeWindow.failFor = (o) => o.x === -1920;
    const { overlay, screen } = make([D1]);
    overlay.show();
    screen.displays = [D1, D2];
    screen.emit("display-added", {}, D2); // 副屏接入，遮罩建不出来
    expect(FakeWindow.instances.filter((w) => !w.destroyed)).toHaveLength(1);

    FakeWindow.failFor = null;
    screen.emit("display-metrics-changed", {}, D2, ["bounds"]);
    const alive = FakeWindow.instances.filter((w) => !w.destroyed);
    expect(alive).toHaveLength(2);
    expect([alive[1]!.opts.x, alive[1]!.opts.width]).toEqual([-1920, 1920]);

    // 副屏拔掉：窗口销毁；拔掉之后才到的 metrics 事件不能把它再建出来
    screen.displays = [D1];
    screen.emit("display-removed", {}, D2);
    const count = FakeWindow.instances.length;
    screen.emit("display-metrics-changed", {}, D2, ["bounds"]);
    expect(FakeWindow.instances).toHaveLength(count);
    expect(FakeWindow.instances.filter((w) => !w.destroyed)).toHaveLength(1);
  });

  it("hide 之后（监听已撤）迟到的事件不会把遮罩再弄出来；show 失败也不留监听", () => {
    const { overlay, screen } = make([D1]);
    overlay.show();
    overlay.hide();
    const count = FakeWindow.instances.length;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    expect(FakeWindow.instances).toHaveLength(count);
    expect(overlay.isShown()).toBe(false);

    FakeWindow.failOn = "setContentProtection";
    const failing = make([D1]);
    expect(() => failing.overlay.show()).toThrow();
    expect(failing.screen.listenerCount("display-metrics-changed")).toBe(0);
  });
});

// 第三轮评审（overlay 补建失败）：会话中途的建窗口失败以前只记日志，上层不知道那块屏幕裸着。isComplete() 把「有明确缺口」交出去，
// 会话看门狗据此结束并锁回去（见 desktop-session.test.ts「看门狗发现遮罩盖不全」）。
describe("isComplete：遮罩有没有盖全（只认明确的缺口）", () => {
  const NEW_D1 = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };

  it("刚 show 成功：盖全；没显示时恒为 true（那是 isShown 的事）", () => {
    const { overlay } = make([D1, D2]);
    expect(overlay.isComplete()).toBe(true);
    overlay.show();
    expect(overlay.isComplete()).toBe(true);
    overlay.hide();
    expect(overlay.isComplete()).toBe(true);
  });

  it("会话中途接入的副屏建不出来：false；下一次事件补建成功 → 回到 true", () => {
    FakeWindow.failFor = (o) => o.x === -1920;
    const { overlay, screen } = make([D1]);
    overlay.show();
    screen.displays = [D1, D2];
    screen.emit("display-added", {}, D2); // 遮罩建不出来
    expect(overlay.isShown()).toBe(true);
    expect(overlay.isComplete()).toBe(false);

    FakeWindow.failFor = null;
    screen.emit("display-metrics-changed", {}, D2, ["bounds"]); // 趁机补建
    expect(overlay.isComplete()).toBe(true);
  });

  it("改分辨率后重建也失败：false（那块屏幕此刻没有遮罩）；补建成功才回 true", () => {
    FakeWindow.failSetBoundsFor = (w) => w === FakeWindow.instances[0];
    const { overlay, screen } = make([D1, D2]);
    overlay.show();
    FakeWindow.failFor = (o) => o.width === 2560;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    expect(overlay.isComplete()).toBe(false);

    FakeWindow.failFor = null;
    screen.emit("display-metrics-changed", {}, NEW_D1, ["bounds"]);
    expect(overlay.isComplete()).toBe(true);
  });

  it("没盖住的那块显示器被拔掉：缺口随之消失（没有显示器就没有「裸屏」）", () => {
    FakeWindow.failFor = (o) => o.x === -1920;
    const { overlay, screen } = make([D1]);
    overlay.show();
    screen.displays = [D1, D2];
    screen.emit("display-added", {}, D2);
    expect(overlay.isComplete()).toBe(false);

    screen.displays = [D1];
    screen.emit("display-removed", {}, D2); // 本来就没窗口的显示器被拔：也要清掉记录
    expect(overlay.isComplete()).toBe(true);
  });

  it("窗口被外部销毁了（渲染进程崩 / 系统收走）：不算盖着；重建后恢复", () => {
    const { overlay, screen } = make([D1, D2]);
    overlay.show();
    FakeWindow.instances[1]!.destroyed = true;
    expect(overlay.isComplete()).toBe(false);

    screen.emit("display-metrics-changed", {}, D2, ["bounds"]); // 对着死窗口：重建
    expect(overlay.isComplete()).toBe(true);
  });

  it("探测窗口状态时抛错：按没盖全算（宁可多保守），而且 isComplete 自己不抛", () => {
    const { overlay } = make([D1]);
    overlay.show();
    FakeWindow.instances[0]!.isDestroyed = () => {
      throw new Error("窗口句柄无效");
    };
    expect(() => overlay.isComplete()).not.toThrow();
    expect(overlay.isComplete()).toBe(false);
  });

  it("hide 清掉缺口记录：下一轮 show 从干净状态开始；show 盖不全直接抛错（不留半成品，也不留缺口记录）", () => {
    FakeWindow.failFor = (o) => o.x === -1920;
    const { overlay, screen } = make([D1]);
    overlay.show();
    screen.displays = [D1, D2];
    screen.emit("display-added", {}, D2);
    expect(overlay.isComplete()).toBe(false);
    overlay.hide();
    expect(overlay.isComplete()).toBe(true);

    // 这一轮 show 本身盖不全：抛错、全部撤掉；记录不残留
    const again = make([D1, D2]);
    expect(() => again.overlay.show()).toThrow(/只盖住了 1\/2/);
    expect(again.overlay.isShown()).toBe(false);
    expect(again.overlay.isComplete()).toBe(true);
    FakeWindow.failFor = null;
    again.overlay.show();
    expect(again.overlay.isComplete()).toBe(true);
  });
});

describe("显示 / 隐藏", () => {
  it("show 幂等：已显示时不重复创建", () => {
    const { overlay } = make();
    overlay.show();
    overlay.show();
    expect(FakeWindow.instances).toHaveLength(1);
    expect(overlay.isShown()).toBe(true);
  });

  it("hide 销毁全部窗口，可重复调用；之后可再次 show", () => {
    const { overlay } = make([D1, D2]);
    overlay.show();
    overlay.hide();
    expect(FakeWindow.instances.every((w) => w.destroyed)).toBe(true);
    expect(overlay.isShown()).toBe(false);
    expect(() => overlay.hide()).not.toThrow();
    overlay.show();
    expect(overlay.isShown()).toBe(true);
    expect(FakeWindow.instances).toHaveLength(4);
  });

  it("hide 里某个窗口销毁失败也不影响其它窗口", () => {
    const { overlay } = make([D1, D2]);
    overlay.show();
    FakeWindow.instances[0]!.destroy = () => {
      throw new Error("销毁失败");
    };
    expect(() => overlay.hide()).not.toThrow();
    expect(FakeWindow.instances[1]!.destroyed).toBe(true);
    expect(overlay.isShown()).toBe(false);
  });
});

describe("第几轮遮罩（generation）：capture-guard 靠它知道「新一轮遮罩开始了，要重新对照」", () => {
  it("没显示过是 0；每次 show() 成功 +1；已显示时再 show（幂等）不算新一轮", () => {
    const { overlay } = make();
    expect(overlay.generation()).toBe(0);
    overlay.show();
    expect(overlay.generation()).toBe(1);
    overlay.show();
    overlay.show();
    expect(overlay.generation()).toBe(1);
  });

  it("hide 不会让它回退；hide 之后再 show 是新一轮", () => {
    const { overlay } = make();
    overlay.show();
    overlay.hide();
    expect(overlay.generation()).toBe(1);
    overlay.show();
    expect(overlay.generation()).toBe(2);
    overlay.hide();
    overlay.hide();
    overlay.show();
    expect(overlay.generation()).toBe(3);
  });

  it("show 失败（一块都没建出来 / 只盖住一部分）不算新一轮；重试成功才 +1", () => {
    FakeWindow.failOn = "setContentProtection";
    const none = make();
    expect(() => none.overlay.show()).toThrow();
    expect(none.overlay.generation()).toBe(0);
    FakeWindow.failOn = null;
    none.overlay.show();
    expect(none.overlay.generation()).toBe(1);

    FakeWindow.failFor = (o) => o.x === -1920;
    const partial = make([D1, D2]);
    expect(() => partial.overlay.show()).toThrow(/只盖住了 1\/2/);
    expect(partial.overlay.generation()).toBe(0);
    FakeWindow.failFor = null;
    partial.overlay.show();
    expect(partial.overlay.generation()).toBe(1);
  });

  it("显示期间插上 / 拔掉显示器、suspend / resume 都不算新一轮", () => {
    const { overlay, screen } = make();
    overlay.show();
    screen.emit("display-added", {}, D2);
    screen.emit("display-removed", {}, D2);
    overlay.suspend();
    overlay.resume();
    expect(overlay.generation()).toBe(1);
  });
});

describe("遮罩出现的时间（shownAt）：capture-guard 靠它知道画面稳定了没有（刚出现的一秒内第一张截图会抢在遮罩合成之前）", () => {
  it("没显示过是 0；show() 成功时记下当时的时间；已显示时再 show（幂等）不更新；hide 不清零；再次 show 更新", () => {
    let clock = 5000;
    const { overlay } = make([D1], "darwin", undefined, () => clock);
    expect(overlay.shownAt()).toBe(0);
    overlay.show();
    expect(overlay.shownAt()).toBe(5000);
    clock = 9000;
    overlay.show();
    expect(overlay.shownAt()).toBe(5000);
    overlay.hide();
    expect(overlay.shownAt()).toBe(5000);
    clock = 12_000;
    overlay.show();
    expect(overlay.shownAt()).toBe(12_000);
  });

  it("show 失败不更新；重试成功才记", () => {
    let clock = 100;
    FakeWindow.failOn = "setContentProtection";
    const { overlay } = make([D1], "darwin", undefined, () => clock);
    expect(() => overlay.show()).toThrow();
    expect(overlay.shownAt()).toBe(0);
    FakeWindow.failOn = null;
    clock = 700;
    overlay.show();
    expect(overlay.shownAt()).toBe(700);
  });

  it("显示期间插上显示器、suspend / resume 都不更新它", () => {
    let clock = 1000;
    const { overlay, screen } = make([D1], "darwin", undefined, () => clock);
    overlay.show();
    clock = 2000;
    screen.emit("display-added", {}, D2);
    overlay.suspend();
    overlay.resume();
    expect(overlay.shownAt()).toBe(1000);
  });

  it("默认用 Date.now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const { overlay } = make();
    overlay.show();
    expect(overlay.shownAt()).toBe(123_456);
  });
});

describe("出错", () => {
  it("窗口属性设置失败：半成品窗口立刻销毁，单屏时 show 抛错（上层兜底）", () => {
    FakeWindow.failOn = "setContentProtection";
    const { overlay } = make();
    expect(() => overlay.show()).toThrow(/没能创建出任何遮罩窗口/);
    expect(FakeWindow.instances.every((w) => w.destroyed)).toBe(true);
    expect(overlay.isShown()).toBe(false);
  });

  it("没有任何显示器：抛错而不是装作显示了", () => {
    const { overlay } = make([]);
    expect(() => overlay.show()).toThrow();
    expect(overlay.isShown()).toBe(false);
  });

  it("多块显示器只盖住了一部分：算失败——已建的窗口全撤掉、不留热插拔监听；条件恢复后可以重试", () => {
    FakeWindow.failFor = (o) => o.x === -1920; // 副屏建不出来
    const { overlay, screen, logs } = make([D1, D2]);
    expect(() => overlay.show()).toThrow(/只盖住了 1\/2 块显示器/);
    expect(FakeWindow.instances).toHaveLength(2);
    expect(FakeWindow.instances.every((w) => w.destroyed)).toBe(true); // 主屏那块也撤了：不留一半盖一半露
    expect(overlay.isShown()).toBe(false);
    expect(screen.listenerCount("display-added")).toBe(0);
    expect(screen.listenerCount("display-removed")).toBe(0);
    expect(screen.listenerCount("display-metrics-changed")).toBe(0);
    expect(logs.join("\n")).toContain("遮罩创建失败");

    FakeWindow.failFor = null;
    overlay.show();
    expect(overlay.isShown()).toBe(true);
    expect(FakeWindow.instances.filter((w) => !w.destroyed)).toHaveLength(2);
  });

  it("全部显示器都建成了：照常显示，不会被误判成部分失败", () => {
    const { overlay } = make([D1, D2]);
    expect(() => overlay.show()).not.toThrow();
    expect(FakeWindow.instances.filter((w) => !w.destroyed)).toHaveLength(2);
  });
});

describe("底色常量", () => {
  it("OVERLAY_RGB 就是 OVERLAY_BACKGROUND 的 RGB；窗口底色和页面底色都用它（截图里「像不像遮罩」的判断依赖这一点）", () => {
    const hex = OVERLAY_BACKGROUND.replace("#", "");
    expect([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))).toEqual([...OVERLAY_RGB]);
    const { overlay } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    expect(w.opts.backgroundColor).toBe(OVERLAY_BACKGROUND);
    const html = decodeURIComponent(w.url.slice(w.url.indexOf(",") + 1));
    expect(html).toContain(`background:${OVERLAY_BACKGROUND}`);
  });
});

/**
 * macOS 上有的系统版本会把遮罩截进画面（ScreenCaptureKit 无视防截屏设置）：capture-guard 靠 suspend / resume
 * 在截图的一瞬间把遮罩变透明。这里钉死的是「透明」的边界——遮罩永远不能因为这个被留在透明状态，也不能因此被销毁 / 抢焦点。
 */
describe("截图时临时撤遮罩（suspend / resume）", () => {
  const opacity = (w: FakeWindow) => w.calls.filter((c) => c.startsWith("setOpacity"));

  it("suspend 让每块屏幕的遮罩变透明，resume 恢复；窗口不销毁、不抢焦点、仍算「显示中」", () => {
    const { overlay } = make([D1, D2]);
    overlay.show();
    expect(overlay.isSuspended()).toBe(false);
    overlay.suspend();
    expect(overlay.isSuspended()).toBe(true);
    expect(overlay.isShown()).toBe(true);
    for (const w of FakeWindow.instances) {
      expect(opacity(w)).toEqual(["setOpacity:0"]);
      expect(w.destroyed).toBe(false);
      expect(w.calls).not.toContain("show");
      expect(w.calls).not.toContain("focus");
    }
    overlay.resume();
    expect(overlay.isSuspended()).toBe(false);
    for (const w of FakeWindow.instances) expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("可嵌套：两次 suspend 只透明一次，要两次 resume 才恢复", () => {
    const { overlay } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    overlay.suspend();
    overlay.suspend();
    expect(opacity(w)).toEqual(["setOpacity:0"]);
    overlay.resume();
    expect(overlay.isSuspended()).toBe(true);
    expect(opacity(w)).toEqual(["setOpacity:0"]); // 还有一个截图在进行，不能提前恢复
    overlay.resume();
    expect(overlay.isSuspended()).toBe(false);
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("resume 比 suspend 多：什么都不做，也不会把深度算成负数（之后的 suspend / resume 照常配对）", () => {
    const { overlay } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    overlay.resume();
    expect(opacity(w)).toEqual([]);
    overlay.suspend();
    expect(overlay.isSuspended()).toBe(true);
    overlay.resume();
    expect(overlay.isSuspended()).toBe(false);
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("没有遮罩时 suspend 什么都不做；之后显示出来的遮罩是不透明的，suspend 也照常工作", () => {
    const { overlay } = make();
    overlay.suspend();
    expect(overlay.isSuspended()).toBe(false);
    overlay.show();
    const w = FakeWindow.instances[0]!;
    expect(opacity(w)).toEqual([]);
    overlay.suspend();
    overlay.resume();
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("兜底：透明太久（截图卡住）到点强制恢复；之后迟到的 resume 是空操作；默认上限 5 秒", () => {
    vi.useFakeTimers();
    expect(MAX_SUSPEND_MS).toBe(5000);
    const { overlay, logs } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    overlay.suspend();
    vi.advanceTimersByTime(MAX_SUSPEND_MS - 1);
    expect(opacity(w)).toEqual(["setOpacity:0"]);
    vi.advanceTimersByTime(1);
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
    expect(overlay.isSuspended()).toBe(false);
    expect(logs.join("\n")).toContain("强制恢复");
    overlay.resume(); // 截图终于结束了：不能再多恢复一次，也不能让深度变负
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
    overlay.suspend();
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1", "setOpacity:0"]);
  });

  it("兜底上限可配置", () => {
    vi.useFakeTimers();
    const { overlay } = make([D1], "darwin", 1000);
    overlay.show();
    const w = FakeWindow.instances[0]!;
    overlay.suspend();
    vi.advanceTimersByTime(999);
    expect(opacity(w)).toEqual(["setOpacity:0"]);
    vi.advanceTimersByTime(1);
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("正常 resume 之后兜底定时器被撤掉：不会在之后的某个时刻又来一次恢复", () => {
    vi.useFakeTimers();
    const { overlay } = make();
    overlay.show();
    const w = FakeWindow.instances[0]!;
    overlay.suspend();
    overlay.resume();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("透明期间 hide：窗口全部销毁、兜底定时器撤掉、状态清零；再次 show 出来的遮罩是不透明的、suspend 照常配对", () => {
    vi.useFakeTimers();
    const { overlay } = make([D1, D2]);
    overlay.show();
    overlay.suspend();
    overlay.suspend(); // 故意没配平
    overlay.hide();
    expect(FakeWindow.instances.every((w) => w.destroyed)).toBe(true);
    expect(overlay.isSuspended()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const before = FakeWindow.instances.map((w) => w.calls.length);
    vi.advanceTimersByTime(60_000);
    expect(FakeWindow.instances.map((w) => w.calls.length)).toEqual(before); // 没人再去碰已销毁的窗口

    overlay.show();
    const fresh = FakeWindow.instances.slice(2);
    expect(fresh).toHaveLength(2);
    for (const w of fresh) expect(opacity(w)).toEqual([]); // 不继承上一轮的透明
    overlay.suspend();
    expect(overlay.isSuspended()).toBe(true);
    overlay.resume();
    expect(overlay.isSuspended()).toBe(false);
    for (const w of fresh) expect(opacity(w)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("透明期间插上新显示器：新遮罩跟着透明，resume 时一并恢复；resume 之后插上的不受影响", () => {
    const { overlay, screen } = make([D1]);
    overlay.show();
    overlay.suspend();
    screen.emit("display-added", {}, D2);
    const [a, b] = FakeWindow.instances as [FakeWindow, FakeWindow];
    expect(opacity(b)).toEqual(["setOpacity:0"]);
    overlay.resume();
    expect(opacity(a)).toEqual(["setOpacity:0", "setOpacity:1"]);
    expect(opacity(b)).toEqual(["setOpacity:0", "setOpacity:1"]);
    const D3 = { id: 3, bounds: { x: 1512, y: 0, width: 1000, height: 800 } };
    screen.emit("display-added", {}, D3);
    expect(opacity(FakeWindow.instances[2]!)).toEqual([]);
  });

  it("某个窗口调不了透明度：其余窗口照常、记日志、不抛（遮罩恢复同理）", () => {
    const { overlay, logs } = make([D1, D2]);
    overlay.show();
    FakeWindow.failOpacityFor = (w) => w === FakeWindow.instances[0];
    expect(() => overlay.suspend()).not.toThrow();
    expect(opacity(FakeWindow.instances[0]!)).toEqual([]);
    expect(opacity(FakeWindow.instances[1]!)).toEqual(["setOpacity:0"]);
    expect(logs.join("\n")).toContain("调整遮罩透明度失败");
    FakeWindow.failOpacityFor = null;
    expect(() => overlay.resume()).not.toThrow();
    expect(opacity(FakeWindow.instances[1]!)).toEqual(["setOpacity:0", "setOpacity:1"]);
  });

  it("已经被销毁的窗口不去碰", () => {
    const { overlay } = make([D1, D2]);
    overlay.show();
    FakeWindow.instances[0]!.destroyed = true;
    overlay.suspend();
    expect(opacity(FakeWindow.instances[0]!)).toEqual([]);
    expect(opacity(FakeWindow.instances[1]!)).toEqual(["setOpacity:0"]);
  });
});
