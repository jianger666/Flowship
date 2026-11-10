/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- 假 electron 对象 / 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * actions.mjs 纯逻辑 + index.mjs（createBrowserManager）的分发 / 懒创建 / IPC 契约单测。
 * 真实 CDP 行为不在这里验证（见 scripts/browser-e2e/actions-smoke.cjs）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  computeScrollDelta,
  computeTarget,
  describeKey,
  intersectRect,
  keyEventSequence,
  labelOf,
  parseKeyCombo,
  pickBestQuad,
  quadArea,
  quadCenter,
  quadRect,
} from "../electron-app/browser/actions.mjs";
import {
  ALL_OPS,
  BASE_OPS,
  NEEDS_SESSION_OPS,
  NO_SESSION_MESSAGE,
  createBrowserManager,
  filterConsoleEntries,
  filterNetworkEntries,
  normalizeOpArgs,
  scaleBounds,
  uniqueDownloadPath,
} from "../electron-app/browser/index.mjs";

// ───────────────────────── 几何 ─────────────────────────

const rectQuad = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

describe("quad 几何", () => {
  it("中心 / 外接矩形 / 面积", () => {
    const q = rectQuad(10, 20, 100, 40);
    expect(quadCenter(q)).toEqual({ x: 60, y: 40 });
    expect(quadRect(q)).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(quadArea(q)).toBe(4000);
  });

  it("旋转 45° 的正方形：中心不变，面积用多边形公式而非外接框", () => {
    const q = [50, 0, 100, 50, 50, 100, 0, 50];
    expect(quadCenter(q)).toEqual({ x: 50, y: 50 });
    expect(quadArea(q)).toBe(5000);
    expect(quadRect(q).width).toBe(100);
  });

  it("pickBestQuad 取最大面积，忽略非法项", () => {
    const small = rectQuad(0, 0, 5, 5);
    const big = rectQuad(0, 0, 50, 50);
    expect(pickBestQuad([small, [1, 2, 3], big])).toBe(big);
    expect(pickBestQuad([])).toBeNull();
    expect(pickBestQuad(undefined as never)).toBeNull();
    expect(pickBestQuad([[NaN, 0, 0, 0, 0, 0, 0, 0]])).toBeNull();
  });

  it("intersectRect", () => {
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
  });
});

describe("computeTarget：quads + OOPIF 偏移 + 视口", () => {
  const vp = { width: 1000, height: 800 };

  it("主 frame：取中心点", () => {
    const r = computeTarget([rectQuad(100, 100, 200, 60)], { x: 0, y: 0 }, vp) as any;
    expect(r.point).toEqual({ x: 200, y: 130 });
    expect(r.local).toEqual({ x: 200, y: 130 });
  });

  it("OOPIF：局部坐标加 iframe 偏移得到主视口点，local 仍是局部坐标", () => {
    const r = computeTarget([rectQuad(10, 10, 80, 20)], { x: 300, y: 200 }, vp) as any;
    expect(r.point).toEqual({ x: 350, y: 220 });
    expect(r.rect).toEqual({ x: 310, y: 210, width: 80, height: 20 });
    expect(r.local).toEqual({ x: 50, y: 20 });
  });

  it("没有 quad / 尺寸为 0 / 完全在视口外 → 对应错误", () => {
    expect((computeTarget([], undefined, vp) as any).error).toBe("no-box");
    expect((computeTarget([rectQuad(10, 10, 0, 20)], undefined, vp) as any).error).toBe("zero-size");
    expect((computeTarget([rectQuad(10, 2000, 50, 50)], undefined, vp) as any).error).toBe("offscreen");
  });

  it("中心点在视口外但元素部分可见：改取可见部分中心", () => {
    // 元素 0..2000 高，中心 y=1000 在视口外；可见部分 0..800 → 中心 400
    const r = computeTarget([rectQuad(100, 0, 100, 2000)], undefined, vp) as any;
    expect(r.point.y).toBe(400);
    expect(r.point.x).toBe(150);
  });

  it("视口尺寸为 0 / 缺省：不做视口检查", () => {
    const r = computeTarget([rectQuad(5000, 5000, 10, 10)], undefined, { width: 0, height: 0 }) as any;
    expect(r.point).toEqual({ x: 5005, y: 5005 });
  });
});

describe("computeScrollDelta", () => {
  it("缺省 down、0.8 个视口高", () => {
    expect(computeScrollDelta({ viewportW: 1000, viewportH: 800 })).toEqual({ mode: "by", dx: 0, dy: 640, direction: "down" });
  });
  it("左右按视口宽；up / left 为负", () => {
    expect(computeScrollDelta({ direction: "right", viewportW: 1000, viewportH: 800 }).dx).toBe(800);
    expect(computeScrollDelta({ direction: "up", amount: 100, viewportW: 1000, viewportH: 800 }).dy).toBe(-100);
    expect(computeScrollDelta({ direction: "left", amount: 50, viewportW: 1000, viewportH: 800 }).dx).toBe(-50);
  });
  it("top / bottom 直达；视口取不到时退回 600", () => {
    expect(computeScrollDelta({ direction: "bottom" }).mode).toBe("bottom");
    expect(computeScrollDelta({ direction: "down", viewportH: 0 }).dy).toBe(480);
  });
  it("非法 direction / amount → BAD_ARGS", () => {
    expect(() => computeScrollDelta({ direction: "sideways" })).toThrow(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(() => computeScrollDelta({ direction: "down", amount: -5 })).toThrow(expect.objectContaining({ code: "BAD_ARGS" }));
  });
});

// ───────────────────────── 按键 ─────────────────────────

describe("parseKeyCombo", () => {
  it("Enter：带 text \\r，vk 13", () => {
    const p = parseKeyCombo("Enter");
    expect(p).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
  });

  it("Escape / Tab 无 text", () => {
    expect(parseKeyCombo("Escape").text).toBeUndefined();
    expect(parseKeyCombo("Tab")).toMatchObject({ key: "Tab", windowsVirtualKeyCode: 9 });
  });

  it("Control+a：modifiers=2、不带 text、带 selectAll 命令", () => {
    const p = parseKeyCombo("Control+a");
    expect(p).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
    expect(p.text).toBeUndefined();
  });

  it("Meta+Enter / Cmd+c / ControlOrMeta（按平台）", () => {
    expect(parseKeyCombo("Meta+Enter")).toMatchObject({ modifiers: 4, key: "Enter" });
    expect(parseKeyCombo("Cmd+c").commands).toEqual(["copy"]);
    expect(parseKeyCombo("ControlOrMeta+a", { platform: "darwin" }).modifiers).toBe(4);
    expect(parseKeyCombo("ControlOrMeta+a", { platform: "win32" }).modifiers).toBe(2);
  });

  it("Shift+Tab：modifiers=8；Shift+a 大写 key 且仍带 text", () => {
    expect(parseKeyCombo("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
    expect(parseKeyCombo("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
  });

  it("Control+Shift+z → redo；多修饰键位或", () => {
    const p = parseKeyCombo("Control+Shift+z");
    expect(p.commands).toEqual(["redo"]);
    expect(p.modifiers).toBe(2 | 8);
  });

  it("符号键 / 数字 / 功能键 / 空格 / Control++", () => {
    expect(parseKeyCombo("/")).toMatchObject({ code: "Slash", windowsVirtualKeyCode: 191, text: "/" });
    expect(parseKeyCombo("5")).toMatchObject({ code: "Digit5", windowsVirtualKeyCode: 53 });
    expect(parseKeyCombo("F5")).toMatchObject({ key: "F5", windowsVirtualKeyCode: 116 });
    expect(parseKeyCombo("Space")).toMatchObject({ key: " ", code: "Space", text: " " });
    expect(parseKeyCombo("Control++")).toMatchObject({ key: "+", modifiers: 2 });
  });

  it("别名大小写不敏感：ctrl+A / ESC / pagedown", () => {
    expect(parseKeyCombo("ctrl+A").modifiers).toBe(2);
    expect(parseKeyCombo("esc").key).toBe("Escape");
    expect(parseKeyCombo("pagedown").windowsVirtualKeyCode).toBe(34);
  });

  it("单独的修饰键：Shift", () => {
    expect(parseKeyCombo("Shift")).toMatchObject({ key: "Shift", isModifierKey: true, modifiers: 8 });
  });

  it("非法输入 → BAD_ARGS 且 message 带可用键提示", () => {
    for (const bad of ["", "   ", "Foo", "Ctrl+", "Banana+a", "ab", "+a"]) {
      expect(() => parseKeyCombo(bad as string)).toThrow(expect.objectContaining({ code: "BAD_ARGS" }));
    }
    try {
      parseKeyCombo("Foo");
    } catch (e: any) {
      expect(e.message).toMatch(/Enter/);
    }
    expect(() => parseKeyCombo(undefined as never)).toThrow(expect.objectContaining({ code: "BAD_ARGS" }));
  });
});

describe("keyEventSequence", () => {
  it("Enter：keyDown(带 text) → keyUp", () => {
    const seq = keyEventSequence(parseKeyCombo("Enter"));
    expect(seq.map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
    expect(seq[0]).toMatchObject({ text: "\r", windowsVirtualKeyCode: 13 });
  });

  it("Control+a：Control 按下 → 主键 rawKeyDown(带 commands) → 主键抬起 → Control 抬起，modifiers 逐级累积 / 回落", () => {
    const seq = keyEventSequence(parseKeyCombo("Control+a"));
    expect(seq.map((e) => e.type)).toEqual(["rawKeyDown", "rawKeyDown", "keyUp", "keyUp"]);
    expect(seq[0]).toMatchObject({ key: "Control", modifiers: 2 });
    expect(seq[1]).toMatchObject({ key: "a", modifiers: 2, commands: ["selectAll"] });
    expect(seq[1].text).toBeUndefined();
    expect(seq[3]).toMatchObject({ key: "Control", modifiers: 0 });
  });

  it("Shift+Tab：Tab 无 text 走 rawKeyDown", () => {
    const seq = keyEventSequence(parseKeyCombo("Shift+Tab"));
    expect(seq[1]).toMatchObject({ type: "rawKeyDown", key: "Tab", modifiers: 8 });
  });
});

describe("文案：绝不泄漏输入内容", () => {
  it("describeKey：单个普通字符不写出来；命名键 / 组合键写出来", () => {
    expect(describeKey(parseKeyCombo("a"), "a")).toBe("一个字符键");
    expect(describeKey(parseKeyCombo("7"), "7")).toBe("一个字符键");
    expect(describeKey(parseKeyCombo("Enter"), "Enter")).toBe("Enter");
    expect(describeKey(parseKeyCombo("Control+a"), "Control+a")).toBe("Control+a");
  });

  it("labelOf：中文角色 + 截断的名字", () => {
    expect(labelOf({ role: "button", name: "登录" })).toBe("按钮「登录」");
    expect(labelOf({ role: "textbox", name: "" })).toBe("文本框");
    expect(labelOf({ role: "weirdrole", name: "x" })).toBe("weirdrole「x」");
    expect(labelOf({ role: "link", name: "a".repeat(50) })).toBe(`链接「${"a".repeat(30)}…」`);
    expect(labelOf(undefined)).toBe("元素");
  });
});

// ───────────────────────── 参数校验 ─────────────────────────

describe("normalizeOpArgs", () => {
  it("覆盖 §4.3 全部 op（每个 op 都有合法的最小参数）", () => {
    const minimal: Record<string, object> = {
      navigate: { url: "https://a.com" },
      nav_history: { direction: "back" },
      snapshot: {},
      screenshot: {},
      click: { ref: "e1" },
      hover: { ref: "e1" },
      type: { ref: "e1", text: "x" },
      press_key: { key: "Enter" },
      select: { ref: "e1", values: ["a"] },
      scroll: {},
      drag: { fromRef: "e1", toRef: "e2" },
      wait_for: { timeMs: 100 },
      tabs: { action: "list" },
      console: {},
      network: {},
      evaluate: { expression: "1+1" },
      user_activity: {},
      ask_user_to_act: { message: "请登录" },
      status: {},
      close_session: {},
    };
    // 这张表只管 §4.3 原有的 20 个；增强包 E1（契约 §14）新增的 op 由各自切片的测试覆盖
    expect(Object.keys(minimal).sort()).toEqual([...BASE_OPS].sort());
    for (const op of BASE_OPS) expect(() => normalizeOpArgs(op, minimal[op])).not.toThrow();
  });

  it("ALL_OPS = BASE_OPS + 增强包新增，且没有重名；每个新增 op 都有校验入口（不会被当成未知操作）", () => {
    expect(BASE_OPS).toHaveLength(20);
    expect(new Set(ALL_OPS).size).toBe(ALL_OPS.length);
    for (const op of BASE_OPS) expect(ALL_OPS).toContain(op);
    for (const op of ALL_OPS.filter((o) => !(BASE_OPS as readonly string[]).includes(o))) {
      // 校验入口存在：给空对象时要么通过、要么抛「缺少 / 必须」之类的 BAD_ARGS，但绝不能是「未知的浏览器操作」
      try {
        normalizeOpArgs(op, {});
      } catch (err) {
        expect((err as Error).message).not.toMatch(/未知的浏览器操作|未实现的浏览器操作/);
      }
    }
  });

  it("缺省值与夹取", () => {
    expect(normalizeOpArgs("navigate", { url: "a.com" })).toEqual({ url: "a.com", timeoutMs: 30_000 });
    expect(normalizeOpArgs("navigate", { url: "a.com", timeoutMs: 1 }).timeoutMs).toBe(1000);
    expect(normalizeOpArgs("snapshot", {})).toEqual({ maxChars: 30_000, maxElements: 1500, viewportOnly: false });
    expect(normalizeOpArgs("click", { ref: "e3" })).toEqual({ ref: "e3", button: "left", doubleClick: false });
    expect(normalizeOpArgs("type", { ref: "e3", text: "" })).toEqual({ ref: "e3", text: "", submit: false, clear: true });
    expect(normalizeOpArgs("user_activity", {})).toEqual({ markSeen: true, limit: 100 });
    expect(normalizeOpArgs("console", {})).toEqual({ level: "all", limit: 50, clear: false });
    expect(normalizeOpArgs("ask_user_to_act", { message: "m" }).timeoutMs).toBe(1_800_000);
    expect(normalizeOpArgs("wait_for", { text: "ok" }).timeoutMs).toBe(15_000);
    expect(normalizeOpArgs("wait_for", { timeMs: 999_999 }).timeMs).toBe(30_000);
  });

  it("tabId 透传；tabs 的 select/close 必须带 tabId", () => {
    expect(normalizeOpArgs("click", { ref: "e1", tabId: "t2" }).tabId).toBe("t2");
    expect(() => normalizeOpArgs("tabs", { action: "select" })).toThrow(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(normalizeOpArgs("tabs", { action: "close", tabId: "t2" })).toEqual({ action: "close", tabId: "t2" });
  });

  it("非法参数一律 BAD_ARGS", () => {
    const cases: Array<[string, unknown]> = [
      ["navigate", {}],
      ["navigate", { url: 5 }],
      ["nav_history", { direction: "sideways" }],
      ["click", {}],
      ["click", { ref: "e1", button: "left-ish" }],
      ["type", { ref: "e1" }],
      ["press_key", { key: "" }],
      ["select", { ref: "e1", values: [] }],
      ["select", { ref: "e1", values: [1] }],
      ["scroll", { direction: "diagonal" }],
      ["drag", { fromRef: "e1" }],
      ["wait_for", {}],
      ["wait_for", { text: "a", timeMs: 5 }],
      ["tabs", { action: "explode" }],
      ["evaluate", { expression: "" }],
      ["ask_user_to_act", {}],
      ["click", [] as unknown],
      ["no_such_op", {}],
    ];
    for (const [op, args] of cases) {
      expect(() => normalizeOpArgs(op, args), `${op} ${JSON.stringify(args)}`).toThrow(expect.objectContaining({ code: "BAD_ARGS" }));
    }
  });

  it("console / network 过滤：warning 含 error；xhr 含 Fetch", () => {
    const c = [
      { level: "log" },
      { level: "warning" },
      { level: "error" },
    ];
    expect(filterConsoleEntries(c, "all")).toHaveLength(3);
    expect(filterConsoleEntries(c, "error")).toHaveLength(1);
    expect(filterConsoleEntries(c, "warning")).toHaveLength(2);
    const n = [
      { type: "XHR", failed: false },
      { type: "Fetch", failed: true },
      { type: "Document", failed: true },
    ];
    expect(filterNetworkEntries(n, "xhr")).toHaveLength(2);
    expect(filterNetworkEntries(n, "failed")).toHaveLength(2);
    expect(filterNetworkEntries(n, "all")).toHaveLength(3);
  });
});

describe("scaleBounds / uniqueDownloadPath", () => {
  it("zoom=1 只取整；zoom≠1 先乘再取整", () => {
    expect(scaleBounds({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, 1)).toEqual({ x: 10, y: 21, width: 100, height: 50 });
    expect(scaleBounds({ x: 10.4, y: 20, width: 100, height: 50 }, 1.5)).toEqual({ x: 16, y: 30, width: 150, height: 75 });
    expect(scaleBounds({ x: 1, y: 1, width: 10, height: 10 }, 0)).toEqual({ x: 1, y: 1, width: 10, height: 10 });
    expect(() => scaleBounds({ x: NaN, y: 0, width: 1, height: 1 }, 2)).toThrow();
  });

  it("下载同名自动加序号；路径穿越被削掉", () => {
    const taken = new Set(["/dl/a.pdf", "/dl/a (1).pdf"]);
    expect(uniqueDownloadPath("/dl", "a.pdf", (p) => taken.has(p))).toBe("/dl/a (2).pdf");
    expect(uniqueDownloadPath("/dl", "b.txt", (p) => taken.has(p))).toBe("/dl/b.txt");
    expect(uniqueDownloadPath("/dl", "../../etc/passwd", () => false)).toBe("/dl/passwd");
    expect(uniqueDownloadPath("/dl", "noext", (p) => p === "/dl/noext")).toBe("/dl/noext (1)");
  });
});

// ───────────────────────── manager：假 electron ─────────────────────────

const makeFakes = (opts: { zoom?: number; trusted?: boolean } = {}) => {
  const views: any[] = [];
  class FakeView {
    webContents: any;
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor() {
      const listeners: Record<string, Function[]> = {};
      this.webContents = {
        on: (n: string, f: Function) => ((listeners[n] ??= []).push(f), undefined),
        setWindowOpenHandler: vi.fn(),
        setAudioMuted: vi.fn(),
        loadURL: vi.fn(async () => {}),
        getURL: () => "about:blank",
        getTitle: () => "",
        isLoading: () => false,
        stop: vi.fn(),
        reload: vi.fn(),
        close: vi.fn(),
        capturePage: vi.fn(async () => ({ isEmpty: () => true })),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
        debugger: { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), sendCommand: vi.fn(async () => ({})) },
      };
      views.push(this);
    }
  }
  const makeWin = () => ({
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    on: vi.fn(),
    once: vi.fn(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn(), isDestroyed: () => false, getZoomFactor: () => opts.zoom ?? 1 },
  });
  const wins: any[] = [];
  class FakeWindow {
    constructor() {
      const w = makeWin();
      wins.push(w);
      return w as any;
    }
  }
  const mainWin = makeWin();
  const handlers = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const ipcMain = {
    handle: (n: string, f: Function) => void handlers.set(n, f),
    on: (n: string, f: Function) => void listeners.set(n, f),
    removeHandler: (n: string) => void handlers.delete(n),
    removeListener: (n: string) => void listeners.delete(n),
  };
  const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() };
  const isTrusted = vi.fn(() => opts.trusted !== false);
  const manager = createBrowserManager({
    app: { getPath: () => "/tmp" },
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition: () => ses },
    ipcMain,
    getMainWindow: () => mainWin,
    isAppUrl: (u: string) => /^https?:\/\/127\.0\.0\.1:8876(\/|$)/.test(u),
    isTrustedIpcSender: isTrusted,
    log: () => {},
    startPicker: () => ({ cancel() {} }),
  } as any);
  return { manager, views, wins, mainWin, handlers, listeners, isTrusted, ses };
};

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe("manager.dispatch：会话规则", () => {
  it("没有会话时：需要会话的 op 一律 NO_SESSION，message 指向 browser_navigate", async () => {
    const { manager } = makeFakes();
    const valid: Record<string, object> = {
      nav_history: { direction: "reload" },
      snapshot: {},
      screenshot: {},
      click: { ref: "e1" },
      hover: { ref: "e1" },
      type: { ref: "e1", text: "x" },
      press_key: { key: "Enter" },
      select: { ref: "e1", values: ["a"] },
      scroll: {},
      drag: { fromRef: "e1", toRef: "e2" },
      wait_for: { timeMs: 10 },
      console: {},
      network: {},
      user_activity: {},
      tabs: { action: "list" },
    };
    for (const op of [...NEEDS_SESSION_OPS.filter((o) => o !== "evaluate"), "tabs"]) {
      await expect(manager.dispatch(op, valid[op], { taskId: "T1", signal: undefined })).rejects.toMatchObject({
        code: "NO_SESSION",
        message: NO_SESSION_MESSAGE,
      });
    }
    expect(manager.getSession("T1")).toBeUndefined();
  });

  it("status：永不建会话；close_session 无会话 → closed:false 且不发 evt", async () => {
    const { manager } = makeFakes();
    const sent: unknown[] = [];
    const proc: any = { connected: true, send: (m: unknown) => sent.push(m), on: vi.fn(), off: vi.fn() };
    manager.attachServerChannel(proc);
    expect(await manager.dispatch("status", {}, { taskId: "T1" })).toEqual({
      exists: false,
      controller: "idle",
      activeTabId: null,
      url: null,
      title: null,
      pendingCount: 0,
    });
    expect(manager.getSession("T1")).toBeUndefined();
    expect(await manager.dispatch("close_session", {}, { taskId: "T1" })).toEqual({ closed: false });
    expect(sent).toHaveLength(0);
  });

  it("evaluate（E2·A7）：不再因总闸关着直接 DISABLED——无会话时开着 / 关着一律 NO_SESSION，且不为它建会话（授权审批见 tests/browser-e2-p3-evaluate-approval.test.ts）", async () => {
    const { manager } = makeFakes();
    await expectCode(manager.dispatch("evaluate", { expression: "1" }, { taskId: "T1" }), "NO_SESSION");
    manager.onConfig({ evaluateEnabled: true });
    await expectCode(manager.dispatch("evaluate", { expression: "1" }, { taskId: "T1" }), "NO_SESSION");
    manager.onConfig({ evaluateEnabled: false });
    await expectCode(manager.dispatch("evaluate", { expression: "1" }, { taskId: "T1" }), "NO_SESSION");
    expect(manager.getSession("T1")).toBeUndefined();
  });

  it("参数非法在任何副作用之前就被拒；未知 op / 缺 taskId → BAD_ARGS", async () => {
    const { manager } = makeFakes();
    await expectCode(manager.dispatch("navigate", {}, { taskId: "T1" }), "BAD_ARGS");
    await expectCode(manager.dispatch("explode", {}, { taskId: "T1" }), "BAD_ARGS");
    await expectCode(manager.dispatch("status", {}, { taskId: "" }), "BAD_ARGS");
    expect(manager.getSession("T1")).toBeUndefined();
  });

  it("navigate 被 URL 策略拒绝：URL_BLOCKED，且不白建会话", async () => {
    const { manager, views } = makeFakes();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http://127.0.0.1:8876/api", "chrome://settings"]) {
      await expectCode(manager.dispatch("navigate", { url }, { taskId: "T1" }), "URL_BLOCKED");
    }
    expect(manager.getSession("T1")).toBeUndefined();
    expect(views).toHaveLength(0);
    manager.destroy();
  });

  it("navigate 懒创建会话 + 首个 tab；之后 status / tabs(list) 能看到；close_session 销毁并给 server 发 session_closed", async () => {
    const { manager, views } = makeFakes();
    const sent: any[] = [];
    const proc: any = { connected: true, send: (m: unknown) => sent.push(m), on: vi.fn(), off: vi.fn() };
    manager.attachServerChannel(proc);

    const r: any = await manager.dispatch("navigate", { url: "example.com" }, { taskId: "T1" });
    expect(r.tabId).toBe("t1");
    expect(views).toHaveLength(1);
    expect(views[0].webContents.loadURL).toHaveBeenCalledWith("https://example.com/");

    const st: any = await manager.dispatch("status", {}, { taskId: "T1" });
    expect(st.exists).toBe(true);
    expect(st.activeTabId).toBe("t1");
    const tabs: any = await manager.dispatch("tabs", { action: "list" }, { taskId: "T1" });
    expect(tabs.activeTabId).toBe("t1");
    expect(tabs.tabs).toHaveLength(1);

    expect(await manager.dispatch("close_session", {}, { taskId: "T1" })).toEqual({ closed: true });
    expect(manager.getSession("T1")).toBeUndefined();
    expect(sent.find((m) => m.kind === "evt" && m.name === "session_closed")).toMatchObject({ taskId: "T1", data: {} });
    expect((await manager.dispatch("status", {}, { taskId: "T1" }) as any).exists).toBe(false);
    manager.destroy();
  });

  it("tabs(new) 不额外多开空白 tab；ask_user_to_act 懒创建会话并挂起，answerAsk 后以 outcome 返回", async () => {
    const { manager, views } = makeFakes();
    const r: any = await manager.dispatch("tabs", { action: "new" }, { taskId: "T2" });
    expect(r.tabs).toHaveLength(1);
    expect(views).toHaveLength(1);

    const pending = manager.dispatch("ask_user_to_act", { message: "请登录" }, { taskId: "T3" });
    await new Promise((res) => setTimeout(res, 20));
    const s = manager.getSession("T3");
    expect(s?.controller).toBe("user");
    expect(s?.getState().askRequest?.message).toBe("请登录");
    s?.answerAsk("done", "好了");
    await expect(pending).resolves.toMatchObject({ outcome: "done", note: "好了", entries: expect.any(Array) });
    manager.destroy();
  });

  it("user_activity：只返回 user / system 条目，markSeen 推进游标，status.pendingCount 随之清零", async () => {
    const { manager } = makeFakes();
    await manager.dispatch("navigate", { url: "https://a.com" }, { taskId: "T1" });
    const s: any = manager.getSession("T1");
    s.activityLog.ingest({ type: "click", ts: 1, ai: false, url: "https://a.com/", frame: "main", tabId: "t1", target: { tag: "button", role: "button", name: "提交" }, point: { x: 1, y: 1 } });
    s.activityLog.addAI({ kind: "click", tabId: "t1", url: "https://a.com/", summary: "AI 点了" });
    expect(((await manager.dispatch("status", {}, { taskId: "T1" })) as any).pendingCount).toBeGreaterThan(0);
    const r: any = await manager.dispatch("user_activity", { markSeen: false }, { taskId: "T1" });
    expect(r.entries.every((e: any) => e.actor !== "ai")).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.controller).toBeDefined();
    await manager.dispatch("user_activity", {}, { taskId: "T1" });
    expect(((await manager.dispatch("status", {}, { taskId: "T1" })) as any).pendingCount).toBe(0);
    expect(((await manager.dispatch("user_activity", {}, { taskId: "T1" })) as any).entries).toEqual([]);
    manager.destroy();
  });

  it("console / network：按级别过滤、limit 取最近、clear 清空；wait_for(timeMs) 返回 matched:true", async () => {
    const { manager } = makeFakes();
    await manager.dispatch("navigate", { url: "https://a.com" }, { taskId: "T1" });
    const tab: any = manager.getSession("T1")!.activeTab;
    tab.consoleRing.push({ ts: 1, level: "log", text: "a" });
    tab.consoleRing.push({ ts: 2, level: "error", text: "b" });
    tab.consoleRing.push({ ts: 3, level: "error", text: "c" });
    const c: any = await manager.dispatch("console", { level: "error", limit: 1, clear: true }, { taskId: "T1" });
    expect(c.entries.map((e: any) => e.text)).toEqual(["c"]);
    expect(((await manager.dispatch("console", {}, { taskId: "T1" })) as any).entries).toEqual([]);
    tab.networkRing.push({ ts: 1, method: "GET", url: "u", status: 500, type: "XHR", failed: true });
    expect(((await manager.dispatch("network", { filter: "failed" }, { taskId: "T1" })) as any).entries).toHaveLength(1);
    const w: any = await manager.dispatch("wait_for", { timeMs: 30 }, { taskId: "T1" });
    expect(w.matched).toBe(true);
    expect(w.elapsedMs).toBeGreaterThanOrEqual(25);
    manager.destroy();
  });

  it("wait_for：signal 取消 → 抛 signal.reason", async () => {
    const { manager } = makeFakes();
    await manager.dispatch("navigate", { url: "https://a.com" }, { taskId: "T1" });
    const ac = new AbortController();
    const p = manager.dispatch("wait_for", { timeMs: 20_000 }, { taskId: "T1", signal: ac.signal });
    setTimeout(() => ac.abort(Object.assign(new Error("x"), { code: "CANCELLED" })), 20);
    await expectCode(p, "CANCELLED");
    manager.destroy();
  });

  it("config.recordInputValues 同步到会话的活动日志与 tab", async () => {
    const { manager } = makeFakes();
    await manager.dispatch("navigate", { url: "https://a.com" }, { taskId: "T1" });
    const s: any = manager.getSession("T1");
    const tab = s.activeTab;
    const spy = vi.spyOn(tab, "setRecordValues");
    manager.onConfig({ recordInputValues: true });
    expect(spy).toHaveBeenCalledWith(true);
    expect(manager.getConfig().recordInputValues).toBe(true);
    manager.destroy();
  });

  it("通道层端到端：经 server-channel 发 req 能拿到 res（含错误码）", async () => {
    const { manager } = makeFakes();
    const handlers: Record<string, Function> = {};
    const sent: any[] = [];
    const proc: any = {
      connected: true,
      send: (m: unknown) => sent.push(m),
      on: (n: string, f: Function) => void (handlers[n] = f),
      off: vi.fn(),
    };
    manager.attachServerChannel(proc);
    handlers.message({ v: 1, kind: "hello" });
    handlers.message({ v: 1, kind: "req", id: 1, taskId: "T9", op: "status", args: {} });
    handlers.message({ v: 1, kind: "req", id: 2, taskId: "T9", op: "click", args: { ref: "e1" } });
    handlers.message({ v: 1, kind: "req", id: 3, taskId: "T9", op: "evaluate", args: { expression: "1" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.find((m) => m.kind === "hello-ack")).toBeTruthy();
    expect(sent.find((m) => m.id === 1)).toMatchObject({ ok: true, result: { exists: false } });
    expect(sent.find((m) => m.id === 2)).toMatchObject({ ok: false, error: { code: "NO_SESSION" } });
    // E2·A7：evaluate 不再因总闸关着直接 DISABLED，无会话时先是 NO_SESSION
    expect(sent.find((m) => m.id === 3)).toMatchObject({ ok: false, error: { code: "NO_SESSION" } });
    // E2·A7：include_body 改看 networkBodyRead，关着 → ACCESS_DISABLED（开关先于会话判断）
    handlers.message({ v: 1, kind: "config", networkBodyRead: false });
    handlers.message({ v: 1, kind: "req", id: 4, taskId: "T9", op: "network_detail", args: { id: 1, includeBody: true } });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.find((m) => m.id === 4)).toMatchObject({ ok: false, error: { code: "ACCESS_DISABLED" } });
    handlers.message({ v: 1, kind: "config", evaluateEnabled: true });
    expect(manager.getConfig().evaluateEnabled).toBe(true);
    manager.destroy();
  });
});

describe("manager.registerIpc：契约 §8.2 通道与可信发送者", () => {
  const CHANNELS_HANDLE = [
    "browser:attach",
    "browser:detach",
    "browser:setCovered",
    "browser:navigate",
    "browser:back",
    "browser:forward",
    "browser:reload",
    "browser:stop",
    "browser:newTab",
    "browser:selectTab",
    "browser:closeTab",
    "browser:takeover",
    "browser:handback",
    "browser:answerAsk",
    "browser:startPick",
    "browser:cancelPick",
    "browser:getState",
    "browser:clearBrowsingData",
  ];

  it("§8.2 列出的 19 个通道全部注册；setBounds 只走 on、不在 handle 里", () => {
    const { manager, handlers, listeners } = makeFakes();
    manager.registerIpc();
    for (const ch of CHANNELS_HANDLE) expect(handlers.has(ch), ch).toBe(true);
    expect(listeners.has("browser:setBounds")).toBe(true);
    expect(handlers.has("browser:setBounds")).toBe(false);
    // 重复调用幂等
    manager.registerIpc();
    manager.destroy();
    expect(handlers.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("不可信发送者：handle 一律 throw，on 一律静默忽略，且什么都不会被建出来", async () => {
    const { manager, handlers, listeners, isTrusted, views } = makeFakes({ trusted: false });
    manager.registerIpc();
    const fakeEvent = { sender: {} };
    for (const ch of CHANNELS_HANDLE) {
      await expect(handlers.get(ch)!(fakeEvent, "T1", { x: 0, y: 0, width: 10, height: 10 }), ch).rejects.toThrow(/untrusted/);
    }
    listeners.get("browser:setBounds")!(fakeEvent, "T1", { x: 0, y: 0, width: 10, height: 10 });
    for (const ch of CHANNELS_HANDLE) {
      const l = listeners.get(ch);
      if (l) expect(() => l(fakeEvent, "T1")).not.toThrow();
    }
    expect(isTrusted).toHaveBeenCalled();
    expect(manager.getSession("T1")).toBeUndefined();
    expect(views).toHaveLength(0);
    manager.destroy();
  });

  it("每个 handler 都先过 isTrustedIpcSender（调用次数 ≥ 通道数）", async () => {
    const { manager, handlers, isTrusted } = makeFakes({ trusted: false });
    manager.registerIpc();
    for (const ch of CHANNELS_HANDLE) await handlers.get(ch)!({}, "T1").catch(() => {});
    expect(isTrusted).toHaveBeenCalledTimes(CHANNELS_HANDLE.length);
    manager.destroy();
  });

  it("可信发送者：attach 懒创建会话并搬到主窗；bounds 乘 zoom；setBounds 同样乘；covered 时 attach 不重新显示", async () => {
    const { manager, handlers, listeners, views, mainWin } = makeFakes({ zoom: 1.5 });
    manager.registerIpc();
    const ev = {};
    const state = await handlers.get("browser:attach")!(ev, "T1", { x: 10.4, y: 20, width: 100, height: 50 });
    expect(state).toMatchObject({ taskId: "T1", exists: true, attached: true });
    expect(mainWin.contentView.addChildView).toHaveBeenCalledWith(views[0]);
    expect(views[0].setBounds).toHaveBeenLastCalledWith({ x: 16, y: 30, width: 150, height: 75 });
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);

    listeners.get("browser:setBounds")!(ev, "T1", { x: 0, y: 0, width: 200, height: 100 });
    expect(views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 300, height: 150 });
    // 坏 bounds 不抛
    expect(() => listeners.get("browser:setBounds")!(ev, "T1", { x: NaN })).not.toThrow();

    // covered：截图失败（假 capturePage 返回空图）→ null，但视图被隐藏；此后 attach / setBounds 不得重新显示
    expect(await handlers.get("browser:setCovered")!(ev, "T1", true)).toBeNull();
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false);
    await handlers.get("browser:attach")!(ev, "T1", { x: 1, y: 1, width: 50, height: 50 });
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false);
    await handlers.get("browser:setCovered")!(ev, "T1", false);
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);

    // detach 搬回停车场
    await handlers.get("browser:detach")!(ev, "T1");
    expect(((await handlers.get("browser:getState")!(ev, "T1")) as any).attached).toBe(false);
    manager.destroy();
  });

  it("setCovered 未 attach → null 且不改状态；getState 无会话 → null", async () => {
    const { manager, handlers } = makeFakes();
    manager.registerIpc();
    expect(await handlers.get("browser:setCovered")!({}, "NOPE", true)).toBeNull();
    expect(await handlers.get("browser:getState")!({}, "NOPE")).toBeNull();
    manager.destroy();
  });

  it("用户导航走 resolveUserInput：被拦的返回 {ok:false,error} 且不建会话；裸词当搜索；合法地址 loadURL", async () => {
    const { manager, handlers, views } = makeFakes();
    manager.registerIpc();
    const nav = handlers.get("browser:navigate")!;
    for (const input of ["file:///etc/passwd", "http://127.0.0.1:8876/x", "javascript:alert(1)", ""]) {
      const r = await nav({}, "T1", input);
      expect(r.ok, input).toBe(false);
      expect(typeof r.error).toBe("string");
    }
    expect(manager.getSession("T1")).toBeUndefined();

    expect(await nav({}, "T1", "how to cook rice")).toEqual({ ok: true });
    expect(views).toHaveLength(1);
    expect(views[0].webContents.loadURL).toHaveBeenLastCalledWith("https://www.bing.com/search?q=how%20to%20cook%20rice");
    expect(await nav({}, "T1", "example.com/a")).toEqual({ ok: true });
    expect(views[0].webContents.loadURL).toHaveBeenLastCalledWith("https://example.com/a");
    manager.destroy();
  });

  it("newTab：返回新 tabId；被拦地址返回 null；takeover / handback 走状态机", async () => {
    const { manager, handlers } = makeFakes();
    manager.registerIpc();
    const ev = {};
    expect(await handlers.get("browser:newTab")!(ev, "T1")).toBe("t1");
    expect(await handlers.get("browser:newTab")!(ev, "T1", "https://example.com")).toBe("t2");
    expect(await handlers.get("browser:newTab")!(ev, "T1", "file:///x")).toBeNull();
    await handlers.get("browser:takeover")!(ev, "T1");
    expect(manager.getSession("T1")?.controller).toBe("user");
    // takeover 后 AI 的动作类 op → USER_CONTROL
    await expectCode(manager.dispatch("click", { ref: "e1" }, { taskId: "T1" }), "USER_CONTROL");
    await handlers.get("browser:handback")!(ev, "T1", "好了");
    expect(manager.getSession("T1")?.controller).toBe("idle");
    manager.destroy();
  });

  it("停车场窗口懒创建（首个会话时）、isParkingWindow、destroy 后销毁", async () => {
    const { manager, wins } = makeFakes();
    expect(wins).toHaveLength(0);
    await manager.dispatch("navigate", { url: "https://a.com" }, { taskId: "T1" });
    expect(wins).toHaveLength(1);
    expect(manager.isParkingWindow(wins[0])).toBe(true);
    expect(manager.isParkingWindow({})).toBe(false);
    expect(manager.isParkingWindow(null)).toBe(false);
    manager.destroy();
    expect(wins[0].destroyed).toBe(true);
  });

  it("partition 的权限 / 下载处理只设置一次", async () => {
    const { manager, ses } = makeFakes();
    await manager.dispatch("navigate", { url: "https://a.com" }, { taskId: "T1" });
    await manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(ses.on).toHaveBeenCalledTimes(1);
    const cb = vi.fn();
    ses.setPermissionRequestHandler.mock.calls[0][0]({}, "media", cb);
    expect(cb).toHaveBeenCalledWith(false);
    const cb2 = vi.fn();
    ses.setPermissionRequestHandler.mock.calls[0][0]({}, "geolocation", cb2);
    expect(cb2).toHaveBeenCalledWith(false);
    manager.destroy();
  });
});
