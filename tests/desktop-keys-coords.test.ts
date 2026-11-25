/**
 * 桌面操作的两个纯函数模块（electron-app/desktop/keys.mjs + coords.mjs）：
 *
 * keys：模型写的组合键 → 平台无关的 { mods, key }。钉死——
 * - 修饰键别名与顺序规范化（`shift+cmd+v` ≡ `cmd+shift+v`），`mod` 跟平台走
 * - 不认识的键 / 两个主键 / 只有修饰键 / 空段 一律 BAD_ARGS（宁可报错，不静默按错键）
 * - 只拦注销组合键（⌘⇧Q），其它照常放行
 * - 异常继承协议层的 BrowserError：server-channel 才会把 code 原样带回给 AI，而不是折成 INTERNAL
 *
 * coords：截图像素 → 输入坐标，纯线性映射（不依赖 Retina / DPI 系数）。钉死——
 * - 截图被缩小、屏幕原点为负（副屏在左）、往返换算都不跑偏
 * - 越界报错而不是夹到边缘
 */
import { describe, expect, it } from "vitest";

import { toErrorPayload } from "../electron-app/browser/server-channel.mjs";
import { fitToWidth, imageToInput } from "../electron-app/desktop/coords.mjs";
import { blockedComboReason, CANONICAL_KEYS, parseCombo } from "../electron-app/desktop/keys.mjs";
import { DESKTOP_ERROR_CODES, DESKTOP_OPS, DesktopError } from "../electron-app/desktop/types.mjs";

describe("parseCombo", () => {
  it("单键与带修饰键的基本形态", () => {
    expect(parseCombo("enter")).toEqual({ mods: [], key: "enter" });
    expect(parseCombo("Cmd+Shift+V", "darwin")).toEqual({ mods: ["shift", "meta"], key: "v" });
    expect(parseCombo("ctrl+alt+delete", "win32")).toEqual({ mods: ["ctrl", "alt"], key: "delete" });
  });

  it("修饰键顺序规范化：不管怎么写顺序，结果一致", () => {
    const a = parseCombo("shift+cmd+ctrl+alt+a");
    const b = parseCombo("alt+ctrl+cmd+shift+a");
    expect(a).toEqual(b);
    expect(a.mods).toEqual(["ctrl", "alt", "shift", "meta"]);
  });

  it("别名：return / esc / option / pgdn / win / control", () => {
    expect(parseCombo("return").key).toBe("enter");
    expect(parseCombo("esc").key).toBe("escape");
    expect(parseCombo("option+tab").mods).toEqual(["alt"]);
    expect(parseCombo("pgdn").key).toBe("pagedown");
    expect(parseCombo("win+r").mods).toEqual(["meta"]);
    expect(parseCombo("control+a").mods).toEqual(["ctrl"]);
  });

  it("mod 跟平台走：mac = meta、其余 = ctrl", () => {
    expect(parseCombo("mod+c", "darwin").mods).toEqual(["meta"]);
    expect(parseCombo("mod+c", "win32").mods).toEqual(["ctrl"]);
  });

  // 别名表是普通对象、继承 Object.prototype；part 已经转成小写，所以 `constructor` / `__proto__` 会命中原型上的同名属性——
  // 修复前 `constructor+a` 被当成「修饰键」静默吞掉、只按下 a（宁可报错，不静默按错键）
  it("别名表只认自己的键：Object.prototype 上的同名属性（constructor / __proto__，含大小写写法）不能被当成修饰键或别名吞掉", () => {
    for (const platform of ["darwin", "win32"]) {
      for (const input of [
        "constructor+a",
        "a+constructor",
        "cmd+constructor+c",
        "__proto__+a",
        "a+__proto__",
        "Constructor+A",
        "__PROTO__+a",
        "constructor",
        "__proto__",
        // 大小写混合的原型属性名转小写后本来就不会命中；一并钉住，防止以后有人去掉 toLowerCase
        "valueOf+a",
        "toString",
        "hasOwnProperty+a",
        "isPrototypeOf",
        "propertyIsEnumerable+b",
        "toLocaleString",
      ]) {
        expect(() => parseCombo(input, platform), `${platform}: ${input}`).toThrow(/不认识的按键/);
      }
    }
  });

  it("别名表自己的键照常认（own-property 查表没有误伤）：每个修饰键别名、每个主键别名都能解析", () => {
    for (const [alias, mod] of [["cmd", "meta"], ["command", "meta"], ["meta", "meta"], ["win", "meta"], ["windows", "meta"], ["super", "meta"], ["ctrl", "ctrl"], ["control", "ctrl"], ["alt", "alt"], ["option", "alt"], ["opt", "alt"], ["shift", "shift"]] as const) {
      expect(parseCombo(`${alias}+a`, "darwin"), alias).toEqual({ mods: [mod], key: "a" });
    }
    for (const [alias, key] of [["return", "enter"], ["esc", "escape"], ["del", "delete"], ["forwarddelete", "delete"], ["bksp", "backspace"], ["spacebar", "space"], ["arrowup", "up"], ["arrowdown", "down"], ["arrowleft", "left"], ["arrowright", "right"], ["pgup", "pageup"], ["pgdn", "pagedown"]] as const) {
      expect(parseCombo(alias, "darwin"), alias).toEqual({ mods: [], key: key });
    }
  });

  it("加号 / 减号 / 空格 / 标点按名字或字符本身", () => {
    expect(parseCombo("cmd+plus").key).toBe("plus");
    expect(parseCombo("cmd+minus").key).toBe("minus");
    expect(parseCombo("shift+space").key).toBe("space");
    expect(parseCombo("cmd+/").key).toBe("/");
    expect(parseCombo("cmd+[").key).toBe("[");
  });

  it("所有规范键自己都能被解析回自己", () => {
    for (const k of CANONICAL_KEYS) {
      // 「+」「-」的规范名是 plus / minus（本身已在清单里），标点直接写字符
      expect(parseCombo(k).key).toBe(k);
    }
  });

  it.each([
    ["", "空串"],
    ["   ", "纯空白"],
    ["cmd", "只有修饰键"],
    ["cmd+shift", "只有修饰键（多个）"],
    ["a+b", "两个主键"],
    ["cmd++", "空段（想按 + 却没写 plus）"],
    ["+", "只有一个 +"],
    ["cmd+nonexistentkey", "不认识的键"],
    ["f21", "超出 F20"],
    ["x".repeat(61), "太长"],
  ])("非法输入抛 BAD_ARGS：%s（%s）", (input) => {
    expect(() => parseCombo(input)).toThrow(DesktopError);
    try {
      parseCombo(input);
    } catch (err) {
      expect((err as DesktopError).code).toBe("BAD_ARGS");
    }
  });

  it("非字符串入参抛 BAD_ARGS", () => {
    for (const v of [undefined, null, 1, {}, ["enter"]]) {
      expect(() => parseCombo(v)).toThrow(/keys/);
    }
  });

  it("报错不回显传入的内容：模型常把密码 / 验证码拆成一个个键，回显会把它们带进工具结果", () => {
    const messageOf = (input: string): string => {
      try {
        parseCombo(input);
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    };
    // 不认识的键：既不复述整串，也不复述其中任何一段
    const unknown = messageOf("cmd+Hunter2Secret");
    expect(unknown).toMatch(/不认识的按键/);
    expect(unknown).not.toMatch(/hunter|secret/i);
    expect(unknown).not.toContain("「");
    // 两个主键：不复述是哪两个键（可能就是密码里的两个字符）
    const two = messageOf("q+z");
    expect(two).toMatch(/两个主键/);
    expect(two).not.toContain("「");
    expect(two).not.toMatch(/[「」]q|z[「」]/);
  });

  it("异常继承 BrowserError：协议层 toErrorPayload 保留 code 与中文原文", () => {
    try {
      parseCombo("cmd");
    } catch (err) {
      const payload = toErrorPayload(err);
      expect(payload.code).toBe("BAD_ARGS");
      expect(payload.message).toContain("主键");
    }
  });
});

describe("blockedComboReason", () => {
  it("macOS 注销组合键被拦（含带 option 的立即注销）", () => {
    expect(blockedComboReason(parseCombo("cmd+shift+q", "darwin"), "darwin")).toContain("注销");
    expect(blockedComboReason(parseCombo("alt+cmd+shift+q", "darwin"), "darwin")).toContain("注销");
  });

  it("退出应用 / 关窗 / 锁屏 / 普通快捷键放行", () => {
    for (const k of ["cmd+q", "cmd+w", "ctrl+cmd+q", "cmd+c", "enter", "alt+f4"]) {
      expect(blockedComboReason(parseCombo(k, "darwin"), "darwin")).toBeNull();
    }
  });

  it("Windows 上同样的字母组合不拦（Win+Shift+Q 不是注销）", () => {
    expect(blockedComboReason(parseCombo("win+shift+q", "win32"), "win32")).toBeNull();
  });
});

describe("fitToWidth", () => {
  it("只缩小不放大，等比", () => {
    expect(fitToWidth(3024, 1964, 1280)).toEqual({ width: 1280, height: 831 });
    expect(fitToWidth(1000, 500, 1280)).toEqual({ width: 1000, height: 500 });
  });

  it("尺寸无效抛错；maxWidth 非法按不缩放处理", () => {
    expect(() => fitToWidth(0, 100, 1280)).toThrow(DesktopError);
    expect(() => fitToWidth(100, Number.NaN, 1280)).toThrow(DesktopError);
    expect(fitToWidth(800, 600, 0)).toEqual({ width: 800, height: 600 });
  });

  it("极端长条图高度至少 1", () => {
    expect(fitToWidth(10000, 1, 1000).height).toBe(1);
  });
});

describe("imageToInput", () => {
  // mac 主屏 1512×982 点；截图被缩到 1280×831
  const mac = { imageWidth: 1280, imageHeight: 831, rect: { x: 0, y: 0, width: 1512, height: 982 } };

  it("截图中心映射到屏幕中心，角点映射到角点（右 / 下边缘夹在主屏最后一个单位内）", () => {
    expect(imageToInput({ x: 640, y: 415.5 }, mac)).toEqual({ x: 756, y: 491 });
    expect(imageToInput({ x: 0, y: 0 }, mac)).toEqual({ x: 0, y: 0 });
    // 截图的右下角 (1280, 831) 按公式是 (1512, 982)，已经在 1512×982 的主屏之外：夹到最后一个点 (1511, 981)
    expect(imageToInput({ x: 1280, y: 831 }, mac)).toEqual({ x: 1511, y: 981 });
  });

  it("边缘点击不会越出主屏：副屏在右 / 下时，那一个单位属于相邻显示器", () => {
    // 主屏 1920×1080，右边紧挨着另一块屏（它的输入坐标从 x=1920 开始）：点截图最右边不能点到副屏上
    const primary = { imageWidth: 1280, imageHeight: 720, rect: { x: 0, y: 0, width: 1920, height: 1080 } };
    expect(imageToInput({ x: 1280, y: 360 }, primary).x).toBe(1919);
    expect(imageToInput({ x: 640, y: 720 }, primary).y).toBe(1079);
    // 四舍五入后也越界的点（1279.9 → 1919.85 → 1920）同样夹住
    expect(imageToInput({ x: 1279.9, y: 719.9 }, primary)).toEqual({ x: 1919, y: 1079 });
    // 原点为负的主屏：上界是 rect.x + width - 1，不是 width - 1
    const left = { imageWidth: 960, imageHeight: 540, rect: { x: -1920, y: 0, width: 1920, height: 1080 } };
    expect(imageToInput({ x: 960, y: 540 }, left)).toEqual({ x: -1, y: 1079 });
    // 夹的只是边缘；真正越界（比边缘还多）依然报错
    expect(() => imageToInput({ x: 1281, y: 360 }, primary)).toThrow(DesktopError);
  });

  it("矩形原点为负（Windows 副屏在左侧）也正确平移", () => {
    const win = { imageWidth: 960, imageHeight: 540, rect: { x: -1920, y: 0, width: 1920, height: 1080 } };
    expect(imageToInput({ x: 0, y: 0 }, win)).toEqual({ x: -1920, y: 0 });
    expect(imageToInput({ x: 480, y: 270 }, win)).toEqual({ x: -960, y: 540 });
  });

  it("越界 / 非数字抛 BAD_ARGS，并把有效范围写进提示", () => {
    expect(() => imageToInput({ x: -1, y: 10 }, mac)).toThrow(/超出了截图范围 1280×831/);
    expect(() => imageToInput({ x: 10, y: 832 }, mac)).toThrow(DesktopError);
    expect(() => imageToInput({ x: Number.NaN, y: 1 }, mac)).toThrow(/必须是数字/);
    expect(() => imageToInput({ x: 1, y: undefined as unknown as number }, mac)).toThrow(DesktopError);
  });

});

describe("契约常量", () => {
  it("op 清单扁平、唯一、全部 desktop_ 前缀", () => {
    expect(new Set(DESKTOP_OPS).size).toBe(DESKTOP_OPS.length);
    for (const op of DESKTOP_OPS) expect(op).toMatch(/^desktop_[a-z_]+$/);
  });

  it("错误码唯一，且包含协议层已有的通用码", () => {
    expect(new Set(DESKTOP_ERROR_CODES).size).toBe(DESKTOP_ERROR_CODES.length);
    for (const c of ["ACCESS_DISABLED", "UNSUPPORTED", "CANCELLED", "BAD_ARGS", "TIMEOUT", "INTERNAL", "USER_TOOK_OVER"]) {
      expect(DESKTOP_ERROR_CODES).toContain(c);
    }
  });
});
