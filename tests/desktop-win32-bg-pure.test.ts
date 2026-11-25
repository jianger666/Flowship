/**
 * Windows 锁屏后台档的纯函数（electron-app/desktop/drivers/win32-bg-pure.mjs）。
 *
 * ⚠️ 前提：没有 Windows 机器——这里钉的是「编码 / 计划 / 合成」的确定性逻辑（消息参数怎么拼、哪些组合键发不了、
 * 画布怎么叠、哪些位图算空白），不是锁屏时 Windows 对这些消息的真实反应（要真机验证）。
 */
import { describe, expect, it } from "vitest";

import { EM_SETSEL, MK, WM, WS_EX } from "../electron-app/desktop/drivers/win32-bg-defs.mjs";
import {
  BG_BUTTONS,
  BG_DRAG_STEPS,
  BG_TYPE_BATCH_UNITS,
  batchBackgroundTyping,
  bitmapBlankness,
  charOfKey,
  composeFrame,
  isClickThrough,
  isEditClass,
  keyLParam,
  keyOfChar,
  makeLParam,
  makeWheelWParam,
  pickWindowAt,
  planBackgroundKey,
  planBackgroundTyping,
  planBlit,
  planClickMessages,
  planDragPoints,
  planWheelMessages,
  renderKeySteps,
  renderTypingItem,
} from "../electron-app/desktop/drivers/win32-bg-pure.mjs";
import { CANONICAL_KEYS } from "../electron-app/desktop/keys.mjs";

const scanOf = (vk: number) => vk + 1; // 任意确定的映射

describe("消息参数编码", () => {
  it("makeLParam：低 16 位 x、高 16 位 y；负坐标取 16 位补码；结果是无符号 32 位", () => {
    expect(makeLParam(10, 20)).toBe((20 << 16) | 10);
    expect(makeLParam(0, 0)).toBe(0);
    expect(makeLParam(-1, -1)).toBe(0xffffffff);
    expect(makeLParam(-5, 7)).toBe(((7 << 16) | 0xfffb) >>> 0);
    expect(makeLParam(65535, 65535)).toBe(0xffffffff);
    // 超出 16 位的只取低 16 位（和 MAKELPARAM 一致）
    expect(makeLParam(0x10001, 0x20002)).toBe(((2 << 16) | 1) >>> 0);
  });

  it("makeWheelWParam：高 16 位是有符号滚动量，低 16 位是按键状态", () => {
    expect(makeWheelWParam(0, 120)).toBe(120 << 16);
    expect(makeWheelWParam(0, -120)).toBe(((0xffff & -120) << 16) >>> 0);
    expect(makeWheelWParam(MK.CONTROL, 240)).toBe(((240 << 16) | MK.CONTROL) >>> 0);
    // 读回来：高 16 位按有符号解释 = 原滚动量
    expect(((makeWheelWParam(0, -600) >>> 16) << 16) >> 16).toBe(-600);
  });

  it("keyLParam：重复次数 1 / 扫描码 16-23 位 / 扩展键 24 位 / Alt 29 位 / 抬起 30、31 位", () => {
    expect(keyLParam({})).toBe(1);
    expect(keyLParam({ scan: 0x1e })).toBe((0x1e << 16) | 1);
    expect(keyLParam({ scan: 0x1e, extended: true })).toBe(((1 << 24) | (0x1e << 16) | 1) >>> 0);
    expect(keyLParam({ alt: true })).toBe(((1 << 29) | 1) >>> 0);
    expect(keyLParam({ scan: 0x1e, up: true })).toBe(((1 << 31) | (1 << 30) | (0x1e << 16) | 1) >>> 0);
    expect(keyLParam({ scan: 0x1ff })).toBe((0xff << 16) | 1); // 扫描码只取低 8 位
  });
});

describe("鼠标消息计划", () => {
  const lp = makeLParam(30, 40);

  it("单击：MOUSEMOVE → DOWN(MK_LBUTTON) → UP；末尾不再停顿", () => {
    const plan = planClickMessages({ button: "left", count: 1, lParam: lp });
    expect(plan.map((m) => [m.msg, m.wParam])).toEqual([
      [WM.MOUSEMOVE, 0],
      [WM.LBUTTONDOWN, MK.LBUTTON],
      [WM.LBUTTONUP, 0],
    ]);
    expect(plan.every((m) => m.lParam === lp)).toBe(true);
    expect(plan.at(-1)?.gapMs).toBe(0);
    expect(plan[0].gapMs).toBeGreaterThan(0);
  });

  it("双击：第二下用 DBLCLK（Windows 自己就是 DOWN/UP + DBLCLK/UP）；三击第三下又是 DOWN/UP", () => {
    expect(planClickMessages({ count: 2, lParam: lp }).map((m) => m.msg)).toEqual([
      WM.MOUSEMOVE,
      WM.LBUTTONDOWN,
      WM.LBUTTONUP,
      WM.LBUTTONDBLCLK,
      WM.LBUTTONUP,
    ]);
    expect(planClickMessages({ count: 3, lParam: lp }).map((m) => m.msg)).toEqual([
      WM.MOUSEMOVE,
      WM.LBUTTONDOWN,
      WM.LBUTTONUP,
      WM.LBUTTONDBLCLK,
      WM.LBUTTONUP,
      WM.LBUTTONDOWN,
      WM.LBUTTONUP,
    ]);
  });

  it("右键 / 中键用各自的消息与按键位", () => {
    expect(planClickMessages({ button: "right", lParam: lp }).map((m) => [m.msg, m.wParam])).toEqual([
      [WM.MOUSEMOVE, 0],
      [WM.RBUTTONDOWN, MK.RBUTTON],
      [WM.RBUTTONUP, 0],
    ]);
    expect(planClickMessages({ button: "middle", lParam: lp }).map((m) => m.msg)).toEqual([WM.MOUSEMOVE, WM.MBUTTONDOWN, WM.MBUTTONUP]);
    expect(BG_BUTTONS.left.dbl).toBe(WM.LBUTTONDBLCLK);
  });

  it("非法按钮 / 次数 → BAD_ARGS", () => {
    expect(() => planClickMessages({ button: "back" as never, lParam: lp })).toThrow(/button 只能是/);
    expect(() => planClickMessages({ count: 0, lParam: lp })).toThrow(/count 必须是 1–3/);
    expect(() => planClickMessages({ count: 4, lParam: lp })).toThrow(/count 必须是 1–3/);
    expect(() => planClickMessages({ count: 1.5, lParam: lp })).toThrow(/count 必须是 1–3/);
  });

  it("拖拽路径：BG_DRAG_STEPS - 1 个中间点，线性插值，不含起点终点", () => {
    const points = planDragPoints({ x: 0, y: 100 }, { x: 100, y: 0 });
    expect(points).toHaveLength(BG_DRAG_STEPS - 1);
    expect(points[0]).toEqual({ x: 10, y: 90 });
    expect(points.at(-1)).toEqual({ x: 90, y: 10 });
  });
});

describe("滚轮消息计划", () => {
  it("dy > 0 = 向下 = 负滚动量；坐标是屏幕坐标（lParam）", () => {
    const [m] = planWheelMessages({ dx: 0, dy: 3, screenX: 500, screenY: 400 });
    expect(m.msg).toBe(WM.MOUSEWHEEL);
    expect(m.wParam).toBe(makeWheelWParam(0, -360));
    expect(m.lParam).toBe(makeLParam(500, 400));
  });

  it("dy < 0 = 向上 = 正滚动量；dx > 0 = 向右 = 正的 HWHEEL", () => {
    expect(planWheelMessages({ dx: 0, dy: -2, screenX: 1, screenY: 1 })[0].wParam).toBe(makeWheelWParam(0, 240));
    const horizontal = planWheelMessages({ dx: 2, dy: 0, screenX: 1, screenY: 1 });
    expect(horizontal.map((m) => m.msg)).toEqual([WM.MOUSEHWHEEL]);
    expect(horizontal[0].wParam).toBe(makeWheelWParam(0, 240));
  });

  it("一条消息最多带 5 格：12 格 → 5 + 5 + 2", () => {
    const plan = planWheelMessages({ dx: 0, dy: 12, screenX: 0, screenY: 0 });
    expect(plan.map((m) => m.wParam)).toEqual([makeWheelWParam(0, -600), makeWheelWParam(0, -600), makeWheelWParam(0, -240)]);
  });

  it("纵横同时滚：先纵后横", () => {
    expect(planWheelMessages({ dx: 1, dy: 1, screenX: 0, screenY: 0 }).map((m) => m.msg)).toEqual([WM.MOUSEWHEEL, WM.MOUSEHWHEEL]);
  });

  it("非法值：全 0、非数字、超过 1000 格 → BAD_ARGS", () => {
    expect(() => planWheelMessages({ dx: 0, dy: 0, screenX: 0, screenY: 0 })).toThrow(/不能同时为 0/);
    expect(() => planWheelMessages({ dx: 0, dy: Number.NaN, screenX: 0, screenY: 0 })).toThrow(/dy 必须是数字/);
    expect(() => planWheelMessages({ dx: 1001, dy: 0, screenX: 0, screenY: 0 })).toThrow(/一次最多滚动 1000 格/);
  });
});

describe("键盘：字符映射", () => {
  it("可打印 ASCII（0x20–0x7e）每个字符都能找到产生它的按键，且按键 + shift 状态能还原出这个字符", () => {
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const key = keyOfChar(code);
      expect(key, String.fromCharCode(code)).not.toBeNull();
      const name = Object.entries({ ...Object.fromEntries(CANONICAL_KEYS.map((k) => [k, k])), "-": "-" }).find(([n]) => charOfKey(n, key!.shift) === String.fromCharCode(code))?.[0];
      expect(name, `字符 ${JSON.stringify(String.fromCharCode(code))} 反查不到按键名`).toBeDefined();
    }
  });

  it("charOfKey：美式布局的 shift 字符", () => {
    expect(charOfKey("a")).toBe("a");
    expect(charOfKey("a", true)).toBe("A");
    expect(charOfKey("1", true)).toBe("!");
    expect(charOfKey("0", true)).toBe(")");
    expect(charOfKey("minus", true)).toBe("_");
    expect(charOfKey("plus")).toBe("+");
    expect(charOfKey("=")).toBe("=");
    expect(charOfKey("/", true)).toBe("?");
    expect(charOfKey("space")).toBe(" ");
    expect(charOfKey("enter")).toBeNull();
    expect(charOfKey("left")).toBeNull();
    expect(charOfKey("f5")).toBeNull();
    expect(charOfKey(undefined as never)).toBeNull();
  });

  it("keyOfChar：中文 / 控制字符没有对应按键", () => {
    expect(keyOfChar("中".charCodeAt(0))).toBeNull();
    expect(keyOfChar(0x0a)).toBeNull();
    expect(keyOfChar("A".charCodeAt(0))).toMatchObject({ vk: 0x41, shift: true });
    expect(keyOfChar("a".charCodeAt(0))).toMatchObject({ vk: 0x41, shift: false });
  });
});

describe("planBackgroundKey / renderKeySteps", () => {
  const messages = (combo: { mods?: string[]; key: string }) => renderKeySteps(planBackgroundKey(combo).steps, scanOf);

  it("Enter：KEYDOWN(VK_RETURN) → WM_CHAR(13) → KEYUP；扫描码进 lParam，抬起带 30/31 位", () => {
    expect(messages({ key: "enter" })).toEqual([
      { msg: WM.KEYDOWN, wParam: 0x0d, lParam: keyLParam({ scan: scanOf(0x0d) }) },
      { msg: WM.CHAR, wParam: 13, lParam: keyLParam({}) },
      { msg: WM.KEYUP, wParam: 0x0d, lParam: keyLParam({ scan: scanOf(0x0d), up: true }) },
    ]);
    const plan = planBackgroundKey({ key: "enter" });
    expect(plan.unsupported).toBeNull();
    expect(plan.special).toBeNull();
    expect(plan.approximate).toBe(false);
  });

  it("Tab / Esc / Backspace 各自产生控制字符；方向键 / Delete / F5 不产生字符，扩展键带 24 位", () => {
    const chars = (key: string) => messages({ key }).filter((m) => m.msg === WM.CHAR).map((m) => m.wParam);
    expect(chars("tab")).toEqual([9]);
    expect(chars("escape")).toEqual([27]);
    expect(chars("backspace")).toEqual([8]);
    expect(chars("left")).toEqual([]);
    expect(chars("f5")).toEqual([]);
    const left = messages({ key: "left" });
    expect(left[0].lParam & (1 << 24)).not.toBe(0);
    expect(messages({ key: "f5" })[0].lParam & (1 << 24)).toBe(0);
  });

  it("单个字符键：a → 'a'；shift+a → 'A'；plus 自动补 shift → '+'", () => {
    const charOf = (combo: { mods?: string[]; key: string }) => String.fromCharCode(messages(combo).find((m) => m.msg === WM.CHAR)!.wParam);
    expect(charOf({ key: "a" })).toBe("a");
    expect(charOf({ mods: ["shift"], key: "a" })).toBe("A");
    expect(charOf({ key: "plus" })).toBe("+");
    expect(charOf({ mods: ["shift"], key: "1" })).toBe("!");
    // shift+字母：shift 键消息夹在中间：SHIFT 按下 → 主键按下 → CHAR → 主键抬起 → SHIFT 抬起
    expect(messages({ mods: ["shift"], key: "a" }).map((m) => [m.msg, m.wParam])).toEqual([
      [WM.KEYDOWN, 0x10],
      [WM.KEYDOWN, 0x41],
      [WM.CHAR, 65],
      [WM.KEYUP, 0x41],
      [WM.KEYUP, 0x10],
    ]);
  });

  it("Ctrl+字母：带控制码 1–26（TranslateMessage 的做法），修饰键倒序抬起；标记为「尽力而为」", () => {
    const plan = planBackgroundKey({ mods: ["ctrl"], key: "a" });
    expect(renderKeySteps(plan.steps, scanOf).map((m) => [m.msg, m.wParam])).toEqual([
      [WM.KEYDOWN, 0x11],
      [WM.KEYDOWN, 0x41],
      [WM.CHAR, 1],
      [WM.KEYUP, 0x41],
      [WM.KEYUP, 0x11],
    ]);
    expect(plan.approximate).toBe(true);
    expect(planBackgroundKey({ mods: ["ctrl"], key: "z" }).steps.find((s) => s.kind === "char")).toMatchObject({ unit: 26 });
  });

  it("Ctrl+A / C / V / X / Z 有给 Edit 类控件的专用消息；加了别的修饰键就没有", () => {
    expect(planBackgroundKey({ mods: ["ctrl"], key: "a" }).special).toEqual({ msg: EM_SETSEL, wParam: 0, lParam: -1 });
    expect(planBackgroundKey({ mods: ["ctrl"], key: "c" }).special).toEqual({ msg: WM.COPY, wParam: 0, lParam: 0 });
    expect(planBackgroundKey({ mods: ["ctrl"], key: "v" }).special).toEqual({ msg: WM.PASTE, wParam: 0, lParam: 0 });
    expect(planBackgroundKey({ mods: ["ctrl"], key: "x" }).special).toEqual({ msg: WM.CUT, wParam: 0, lParam: 0 });
    expect(planBackgroundKey({ mods: ["ctrl"], key: "z" }).special).toEqual({ msg: WM.UNDO, wParam: 0, lParam: 0 });
    expect(planBackgroundKey({ mods: ["ctrl"], key: "s" }).special).toBeNull();
    expect(planBackgroundKey({ mods: ["ctrl", "shift"], key: "z" }).special).toBeNull();
    expect(planBackgroundKey({ mods: ["ctrl", "alt"], key: "a" }).special).toBeNull();
  });

  it("Alt+字母：全部走 SYS 消息，lParam 带 Alt 位；不带 WM_CHAR 控制码", () => {
    const plan = planBackgroundKey({ mods: ["alt"], key: "f" });
    const rendered = renderKeySteps(plan.steps, scanOf);
    expect(rendered.map((m) => m.msg)).toEqual([WM.SYSKEYDOWN, WM.SYSKEYDOWN, WM.SYSCHAR, WM.SYSKEYUP, WM.SYSKEYUP]);
    expect(rendered.every((m) => (m.lParam & (1 << 29)) !== 0)).toBe(true);
    expect(plan.approximate).toBe(true);
    // Ctrl+Alt+字母：没有 WM_CHAR（按下 Alt 时字母不会变成控制码）
    expect(planBackgroundKey({ mods: ["ctrl", "alt"], key: "a" }).steps.some((s) => s.kind === "char")).toBe(false);
  });

  it("Shift + 非字符键（Shift+Tab / Shift+方向键）：发出去但标记为尽力而为", () => {
    expect(planBackgroundKey({ mods: ["shift"], key: "tab" }).approximate).toBe(false); // 有 WM_CHAR(9)：对应用来说就是 Tab
    expect(planBackgroundKey({ mods: ["shift"], key: "left" }).approximate).toBe(true);
  });

  it("Win 键组合 / Alt+Tab / Alt+Esc：后台发不了，给出原因（上层报 NEED_FOREGROUND）", () => {
    for (const combo of [
      { mods: ["meta"], key: "d" },
      { mods: ["meta", "shift"], key: "s" },
      { mods: ["alt"], key: "tab" },
      { mods: ["alt"], key: "escape" },
    ]) {
      const plan = planBackgroundKey(combo);
      expect(plan.unsupported, JSON.stringify(combo)).toEqual(expect.stringMatching(/Win 键|Alt\+Tab/));
      expect(plan.steps).toEqual([]);
    }
    expect(planBackgroundKey({ mods: ["alt"], key: "f4" }).unsupported).toBeNull(); // Alt+F4 靠 DefWindowProc 翻译，能发
  });

  it("非法入参：不认识的键 / 修饰键 / mods 不是数组 → BAD_ARGS，错误信息不回显键名", () => {
    expect(() => planBackgroundKey({ key: "nonsense" })).toThrow(/不认识的按键/);
    expect(() => planBackgroundKey({ key: "constructor" })).toThrow(/不认识的按键/);
    expect(() => planBackgroundKey({ mods: ["hyper"], key: "a" })).toThrow(/不认识的修饰键/);
    expect(() => planBackgroundKey({ mods: "ctrl" as never, key: "a" })).toThrow(/mods 必须是数组/);
    try {
      planBackgroundKey({ key: "secretkey" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secretkey");
    }
  });
});

describe("文本输入计划", () => {
  it("换行（\\n / \\r\\n / 孤立 \\r）→ enter，\\t → tab，surrogate pair 合成一个单元", () => {
    expect(planBackgroundTyping("a\nb\r\nc\rd\te")).toEqual([
      { units: [97] },
      { key: "enter" },
      { units: [98] },
      { key: "enter" },
      { units: [99] },
      { key: "enter" },
      { units: [100] },
      { key: "tab" },
      { units: [101] },
    ]);
    expect(planBackgroundTyping("😀")).toEqual([{ units: [0xd83d, 0xde00] }]);
  });

  it("其它控制字符报错：只写位置，不写字符（文本可能是密码）", () => {
    expect(() => planBackgroundTyping("ab\u0007cd")).toThrow(/第 3 个字符/);
    try {
      planBackgroundTyping("p@ss\u0001word");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("p@ss");
    }
  });

  it("分批：每批 ≤ BG_TYPE_BATCH_UNITS 个 code unit；surrogate pair 不拆开", () => {
    const text = `${"x".repeat(BG_TYPE_BATCH_UNITS - 1)}😀${"y".repeat(5)}`;
    const batches = batchBackgroundTyping(planBackgroundTyping(text));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(BG_TYPE_BATCH_UNITS - 1);
    expect(batches[1][0]).toEqual({ units: [0xd83d, 0xde00] });
    expect(batchBackgroundTyping([])).toEqual([]);
  });

  it("ASCII：KEYDOWN → CHAR → KEYUP（不发 shift 键消息）；中文只发 WM_CHAR；emoji 两个 WM_CHAR；enter 走按键计划", () => {
    expect(renderTypingItem({ units: [65] }, scanOf).map((m) => [m.msg, m.wParam])).toEqual([
      [WM.KEYDOWN, 0x41],
      [WM.CHAR, 65],
      [WM.KEYUP, 0x41],
    ]);
    expect(renderTypingItem({ units: ["中".charCodeAt(0)] }, scanOf)).toEqual([{ msg: WM.CHAR, wParam: 0x4e2d, lParam: keyLParam({}) }]);
    expect(renderTypingItem({ units: [0xd83d, 0xde00] }, scanOf).map((m) => [m.msg, m.wParam])).toEqual([
      [WM.CHAR, 0xd83d],
      [WM.CHAR, 0xde00],
    ]);
    expect(renderTypingItem({ key: "enter" }, scanOf).map((m) => m.msg)).toEqual([WM.KEYDOWN, WM.CHAR, WM.KEYUP]);
  });
});

describe("命中测试 / 类名", () => {
  const wins = [
    { id: "top", x: 100, y: 100, width: 200, height: 100 },
    { id: "bottom", x: 0, y: 0, width: 1000, height: 800 },
  ];

  it("pickWindowAt：Z 序从上到下，第一个命中的；左 / 上闭、右 / 下开；都不命中 null", () => {
    expect(pickWindowAt(wins, 150, 150)?.id).toBe("top");
    expect(pickWindowAt(wins, 100, 100)?.id).toBe("top"); // 左上角算里面
    expect(pickWindowAt(wins, 300, 150)?.id).toBe("bottom"); // 右边界之外落到下一层
    expect(pickWindowAt(wins, 150, 200)?.id).toBe("bottom"); // 下边界之外
    expect(pickWindowAt(wins, 1500, 150)).toBeNull();
    expect(pickWindowAt([], 1, 1)).toBeNull();
  });

  it("isEditClass：Edit / RichEdit 类（不区分大小写，前缀匹配）；Chromium / Qt / 控制台不算", () => {
    for (const name of ["Edit", "EDIT", "RichEdit20W", "RICHEDIT50W", "RichEditD2DPT"]) expect(isEditClass(name), name).toBe(true);
    for (const name of ["Chrome_RenderWidgetHostHWND", "Qt5QWindowIcon", "ConsoleWindowClass", "Notepad", "", undefined, 5])
      expect(isEditClass(name as never), String(name)).toBe(false);
  });

  it("isClickThrough：只有「透明 + 分层」两个样式同时具备才算（各种覆盖层）", () => {
    expect(isClickThrough(WS_EX.TRANSPARENT | WS_EX.LAYERED, WS_EX)).toBe(true);
    expect(isClickThrough(WS_EX.LAYERED, WS_EX)).toBe(false);
    expect(isClickThrough(WS_EX.TRANSPARENT, WS_EX)).toBe(false);
    expect(isClickThrough(0, WS_EX)).toBe(false);
  });
});

describe("planBlit：可见区域怎么拷到画布", () => {
  const canvas = { width: 1920, height: 1080 };

  it("普通窗口：窗口矩形 = 可见矩形，整个拷", () => {
    expect(planBlit(canvas, { left: 100, top: 50, right: 500, bottom: 350 }, null)).toEqual({ srcX: 0, srcY: 0, dstX: 100, dstY: 50, w: 400, h: 300 });
  });

  it("DWM 边界比窗口矩形小（Win10+ 的透明边框）：从位图里偏移后拷，落在 DWM 边界的位置", () => {
    expect(
      planBlit(canvas, { left: 93, top: 50, right: 507, bottom: 357 }, { left: 100, top: 50, right: 500, bottom: 350 }),
    ).toEqual({ srcX: 7, srcY: 0, dstX: 100, dstY: 50, w: 400, h: 300 });
  });

  it("超出画布的部分裁掉（负坐标 / 超右下）", () => {
    expect(planBlit(canvas, { left: -50, top: -20, right: 350, bottom: 280 }, null)).toEqual({ srcX: 50, srcY: 20, dstX: 0, dstY: 0, w: 350, h: 280 });
    expect(planBlit(canvas, { left: 1800, top: 1000, right: 2200, bottom: 1300 }, null)).toEqual({ srcX: 0, srcY: 0, dstX: 1800, dstY: 1000, w: 120, h: 80 });
  });

  it("完全在画布外 / 没有面积 → null", () => {
    expect(planBlit(canvas, { left: 2000, top: 0, right: 2300, bottom: 100 }, null)).toBeNull();
    expect(planBlit(canvas, { left: -400, top: 0, right: -10, bottom: 100 }, null)).toBeNull();
    expect(planBlit(canvas, { left: 10, top: 10, right: 10, bottom: 200 }, null)).toBeNull();
  });

  it("可见边界超出位图的部分也裁掉（防止越界读）", () => {
    const blit = planBlit(canvas, { left: 100, top: 100, right: 200, bottom: 200 }, { left: 90, top: 90, right: 210, bottom: 210 });
    expect(blit).not.toBeNull();
    expect(blit!.srcX + blit!.w).toBeLessThanOrEqual(100);
    expect(blit!.srcY + blit!.h).toBeLessThanOrEqual(100);
    expect(blit!.srcX).toBeGreaterThanOrEqual(0);
    expect(blit!.srcY).toBeGreaterThanOrEqual(0);
  });
});

/** 纯色 BGRA 位图 */
const solid = (w: number, h: number, [b, g, r]: [number, number, number], alpha = 0) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = b;
    buf[i + 1] = g;
    buf[i + 2] = r;
    buf[i + 3] = alpha;
  }
  return buf;
};
const pixel = (frame: Buffer, width: number, x: number, y: number) => {
  const o = (y * width + x) * 4;
  return [frame[o], frame[o + 1], frame[o + 2], frame[o + 3]];
};

describe("composeFrame", () => {
  it("画布先填底色；后面的图层盖住前面的；Alpha 一律 255（GDI 取出来的 Alpha 常为 0）", () => {
    const layers = [
      { data: solid(4, 4, [1, 2, 3]), bitmapWidth: 4, srcX: 0, srcY: 0, dstX: 2, dstY: 2, w: 4, h: 4 },
      { data: solid(2, 2, [9, 8, 7]), bitmapWidth: 2, srcX: 0, srcY: 0, dstX: 4, dstY: 4, w: 2, h: 2 },
    ];
    const frame = composeFrame({ width: 10, height: 10, fill: [50, 60, 70] }, layers);
    expect(frame.length).toBe(10 * 10 * 4);
    expect(pixel(frame, 10, 0, 0)).toEqual([50, 60, 70, 255]);
    expect(pixel(frame, 10, 2, 2)).toEqual([1, 2, 3, 255]);
    expect(pixel(frame, 10, 4, 4)).toEqual([9, 8, 7, 255]); // 上层盖住下层
    expect(pixel(frame, 10, 5, 5)).toEqual([9, 8, 7, 255]);
    expect(pixel(frame, 10, 3, 3)).toEqual([1, 2, 3, 255]); // 上层之外仍是下层
    expect(pixel(frame, 10, 6, 6)).toEqual([50, 60, 70, 255]); // 下层之外是底色
  });

  it("从位图里裁一块（srcX / srcY）拷：取的是位图里对应的像素，行宽按 bitmapWidth 算", () => {
    const bitmap = Buffer.alloc(6 * 3 * 4);
    for (let y = 0; y < 3; y += 1) for (let x = 0; x < 6; x += 1) bitmap.writeUInt32LE((x << 8) | y, (y * 6 + x) * 4);
    const frame = composeFrame({ width: 4, height: 4 }, [{ data: bitmap, bitmapWidth: 6, srcX: 3, srcY: 1, dstX: 1, dstY: 1, w: 2, h: 2 }]);
    expect(pixel(frame, 4, 1, 1).slice(0, 2)).toEqual([1, 3]); // (x=3, y=1) → 低字节 y=1，次字节 x=3
    expect(pixel(frame, 4, 2, 2).slice(0, 2)).toEqual([2, 4]);
  });

  it("没有图层：整张是底色（默认深灰）", () => {
    const frame = composeFrame({ width: 2, height: 1 }, []);
    expect(pixel(frame, 2, 1, 0)).toEqual([0x20, 0x20, 0x20, 255]);
  });
});

describe("bitmapBlankness", () => {
  it("纯黑 / 纯白的位图算空白；纯色但不是黑白（比如蓝色启动页）不算", () => {
    expect(bitmapBlankness(solid(100, 100, [0, 0, 0]), 10000).blank).toBe(true);
    expect(bitmapBlankness(solid(100, 100, [255, 255, 255]), 10000).blank).toBe(true);
    expect(bitmapBlankness(solid(100, 100, [200, 80, 20]), 10000).blank).toBe(false);
  });

  it("有内容的位图不算空白：白底上有一块文字区域（> 0.5% 的点不同）", () => {
    const bitmap = solid(100, 100, [255, 255, 255]);
    for (let y = 40; y < 60; y += 1) for (let x = 10; x < 90; x += 1) bitmap.writeUInt32LE(0x00202020, (y * 100 + x) * 4);
    const result = bitmapBlankness(bitmap, 10000);
    expect(result.blank).toBe(false);
    expect(result.dominantRatio).toBeLessThan(0.995);
  });

  it("没有像素 → 视为空白", () => {
    expect(bitmapBlankness(Buffer.alloc(0), 0).blank).toBe(true);
  });
});
