/**
 * 播放器快捷键（media-shortcuts）：按键 → 命令；倍速档位步进
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RATES } from "@/lib/media/media-memory";
import {
  ESC_AFTER_FULLSCREEN_GRACE_MS,
  ESC_CLOSE_WINDOW_MS,
  decideEscapeClose,
  resolveMediaShortcut,
  stepRate,
  type EscapeCloseContext,
  type MediaCommand,
  type ShortcutContext,
  type ShortcutEventLike,
} from "@/lib/media/media-shortcuts";

const VIDEO: ShortcutContext = { groupSize: 1, kind: "video" };
const AUDIO: ShortcutContext = { groupSize: 1, kind: "audio" };

const press = (key: string, ctx: ShortcutContext = VIDEO, mods: Partial<ShortcutEventLike> = {}): MediaCommand | null =>
  resolveMediaShortcut({ key, ...mods }, ctx);

describe("resolveMediaShortcut：每个键的映射", () => {
  it("播放 / 暂停：空格、K", () => {
    expect(press(" ")).toEqual({ type: "toggle" });
    expect(press("k")).toEqual({ type: "toggle" });
    expect(press("K")).toEqual({ type: "toggle" });
  });

  it("← → 5 秒，Shift 30 秒", () => {
    expect(press("ArrowLeft")).toEqual({ type: "seekBy", seconds: -5 });
    expect(press("ArrowRight")).toEqual({ type: "seekBy", seconds: 5 });
    expect(press("ArrowLeft", VIDEO, { shiftKey: true })).toEqual({ type: "seekBy", seconds: -30 });
    expect(press("ArrowRight", VIDEO, { shiftKey: true })).toEqual({ type: "seekBy", seconds: 30 });
  });

  it("J / L：10 秒（大小写都行，Caps Lock 下也一样）", () => {
    expect(press("j")).toEqual({ type: "seekBy", seconds: -10 });
    expect(press("l")).toEqual({ type: "seekBy", seconds: 10 });
    expect(press("J")).toEqual({ type: "seekBy", seconds: -10 });
    expect(press("L", VIDEO, { shiftKey: true })).toEqual({ type: "seekBy", seconds: 10 });
  });

  it("`,` `.`：视频逐帧；音频退化成 ±1 秒", () => {
    expect(press(",", VIDEO)).toEqual({ type: "frame", dir: -1 });
    expect(press(".", VIDEO)).toEqual({ type: "frame", dir: 1 });
    expect(press(",", AUDIO)).toEqual({ type: "seekBy", seconds: -1 });
    expect(press(".", AUDIO)).toEqual({ type: "seekBy", seconds: 1 });
  });

  it("倍速：[ ] 步进，\\ 复位", () => {
    expect(press("[")).toEqual({ type: "rateStep", dir: -1 });
    expect(press("]")).toEqual({ type: "rateStep", dir: 1 });
    expect(press("\\")).toEqual({ type: "rateReset" });
  });

  it("音量：↑ ↓ 每次 5%", () => {
    expect(press("ArrowUp")).toEqual({ type: "volumeBy", delta: 0.05 });
    expect(press("ArrowDown")).toEqual({ type: "volumeBy", delta: -0.05 });
  });

  it("静音 / 循环", () => {
    expect(press("m")).toEqual({ type: "mute" });
    expect(press("r")).toEqual({ type: "loop" });
  });

  it("帮助", () => {
    expect(press("?", VIDEO, { shiftKey: true })).toEqual({ type: "help" });
  });

  it("已经去掉的功能（A-B 区间 / 大窗）不再占键：i o x t 返回 null，不吞按键", () => {
    for (const key of ["i", "o", "x", "t", "I", "O", "X", "T"]) {
      expect(press(key), key).toBeNull();
    }
  });

  it("Home / End 跳到开头 / 结尾", () => {
    expect(press("Home")).toEqual({ type: "seekStart" });
    expect(press("End")).toEqual({ type: "seekEnd" });
  });

  it("视频独有键 f / p / c", () => {
    expect(press("f", VIDEO)).toEqual({ type: "fullscreen" });
    expect(press("p", VIDEO)).toEqual({ type: "pip" });
    expect(press("c", VIDEO)).toEqual({ type: "captions" });
    expect(press("F", VIDEO)).toEqual({ type: "fullscreen" });
  });

  it("视频独有键在音频下返回 null（不吞按键，让它冒泡）", () => {
    for (const key of ["f", "p", "c", "F", "P", "C"]) {
      expect(press(key, AUDIO), key).toBeNull();
    }
  });

  it("音频同样能用的键不受 kind 影响", () => {
    for (const key of [" ", "k", "j", "l", "m", "r", "[", "]", "ArrowLeft", "Home"]) {
      expect(press(key, AUDIO), key).not.toBeNull();
      expect(press(key, AUDIO)).toEqual(press(key, VIDEO));
    }
  });

  it("无关按键 → null：字母 / 功能键 / 回车 / 单独的修饰键", () => {
    for (const key of ["a", "z", "g", "e", "d", "b", "q", "s", "Enter", "Escape", "Tab", "F1", "Shift", "Control", "Meta", "Alt", "Backspace", "", "Dead"]) {
      expect(press(key), JSON.stringify(key)).toBeNull();
    }
  });
});

describe("resolveMediaShortcut：修饰键与输入法", () => {
  const KEYS = [" ", "k", "j", "l", "m", "f", "ArrowLeft", "ArrowUp", "Home", ",", ".", "1", "5", "?"];

  it("带 ctrl / meta / alt 一律 null（留给应用全局快捷键）", () => {
    for (const key of KEYS) {
      expect(press(key, VIDEO, { ctrlKey: true }), `ctrl+${key}`).toBeNull();
      expect(press(key, VIDEO, { metaKey: true }), `meta+${key}`).toBeNull();
      expect(press(key, VIDEO, { altKey: true }), `alt+${key}`).toBeNull();
    }
  });

  it("修饰键组合也一样（⌘⇧K / ⌃⌥J）", () => {
    expect(press("k", VIDEO, { metaKey: true, shiftKey: true })).toBeNull();
    expect(press("j", VIDEO, { ctrlKey: true, altKey: true })).toBeNull();
  });

  it("Shift 单独不拦（大写字母 / ? 都靠 shift 打出来）", () => {
    expect(press("K", VIDEO, { shiftKey: true })).toEqual({ type: "toggle" });
    expect(press("?", VIDEO, { shiftKey: true })).toEqual({ type: "help" });
  });

  it("输入法组合输入中（isComposing）一律 null", () => {
    for (const key of KEYS) {
      expect(press(key, VIDEO, { isComposing: true }), `composing ${key}`).toBeNull();
    }
  });

  it("修饰键 flag 显式为 false 时与缺省等价", () => {
    expect(press("k", VIDEO, { ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toEqual({
      type: "toggle",
    });
  });
});

describe("resolveMediaShortcut：数字键", () => {
  it("没有对比组（groupSize <= 1）：跳到 n×10%，0 = 开头", () => {
    for (let n = 0; n <= 9; n++) {
      expect(press(String(n), { groupSize: 1, kind: "video" })).toEqual({ type: "seekPercent", percent: n * 10 });
    }
    expect(press("5", { groupSize: 0, kind: "audio" })).toEqual({ type: "seekPercent", percent: 50 });
  });

  it("有对比组：切换第 n 个文件（1 起，转成 0 起 index）", () => {
    const ctx: ShortcutContext = { groupSize: 3, kind: "video" };
    expect(press("1", ctx)).toEqual({ type: "item", index: 0 });
    expect(press("2", ctx)).toEqual({ type: "item", index: 1 });
    expect(press("3", ctx)).toEqual({ type: "item", index: 2 });
  });

  it("有对比组：数字超过组大小 → null（不回退成百分比）", () => {
    const ctx: ShortcutContext = { groupSize: 3, kind: "video" };
    expect(press("4", ctx)).toBeNull();
    expect(press("9", ctx)).toBeNull();
  });

  it("有对比组：0 仍是跳到开头", () => {
    expect(press("0", { groupSize: 4, kind: "audio" })).toEqual({ type: "seekPercent", percent: 0 });
  });

  it("恰好 2 个文件是对比组的最小规模", () => {
    const ctx: ShortcutContext = { groupSize: 2, kind: "video" };
    expect(press("2", ctx)).toEqual({ type: "item", index: 1 });
    expect(press("3", ctx)).toBeNull();
  });

  it("数字键不被 kind 影响", () => {
    expect(press("2", { groupSize: 3, kind: "audio" })).toEqual({ type: "item", index: 1 });
  });
});

describe("resolveMediaShortcut：上一个 / 下一个", () => {
  it("PageUp / PageDown：只有对比组才有意义", () => {
    expect(press("PageUp", { groupSize: 3, kind: "video" })).toEqual({ type: "prev" });
    expect(press("PageDown", { groupSize: 3, kind: "video" })).toEqual({ type: "next" });
    expect(press("PageUp", { groupSize: 1, kind: "video" })).toBeNull();
    expect(press("PageDown", { groupSize: 1, kind: "video" })).toBeNull();
    expect(press("PageDown", { groupSize: 0, kind: "video" })).toBeNull();
  });
});

describe("stepRate", () => {
  it("档位表本身升序、包含 1×", () => {
    const sorted = [...RATES].sort((a, b) => a - b);
    expect([...RATES]).toEqual(sorted);
    expect(RATES).toContain(1);
  });

  it("上一档 / 下一档", () => {
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
    expect(stepRate(2, 1)).toBe(2.5);
    expect(stepRate(2, -1)).toBe(1.75);
    expect(stepRate(0.5, 1)).toBe(0.75);
    expect(stepRate(0.5, -1)).toBe(0.25);
  });

  it("到头不动", () => {
    expect(stepRate(4, 1)).toBe(4);
    expect(stepRate(0.25, -1)).toBe(0.25);
  });

  it("逐档往上走遍整张表，再逐档走回来", () => {
    let r: number = RATES[0];
    const up = [r];
    for (let i = 0; i < RATES.length + 3; i++) {
      r = stepRate(r, 1);
      if (up[up.length - 1] !== r) up.push(r);
    }
    expect(up).toEqual([...RATES]);
    const down = [r];
    for (let i = 0; i < RATES.length + 3; i++) {
      r = stepRate(r, -1);
      if (down[down.length - 1] !== r) down.push(r);
    }
    expect(down).toEqual([...RATES].reverse());
  });

  it("当前值不在档位上：往上取比它大的最近一档，往下取比它小的最近一档", () => {
    expect(stepRate(1.1, 1)).toBe(1.25);
    expect(stepRate(1.1, -1)).toBe(1);
    expect(stepRate(1.9, 1)).toBe(2);
    expect(stepRate(1.9, -1)).toBe(1.75);
    expect(stepRate(2.2, 1)).toBe(2.5);
    expect(stepRate(2.2, -1)).toBe(2);
  });

  it("超出档位范围：往外不动，往内走到端点", () => {
    expect(stepRate(5, 1)).toBe(4);
    expect(stepRate(5, -1)).toBe(4);
    expect(stepRate(0.1, 1)).toBe(0.25);
    expect(stepRate(0.1, -1)).toBe(0.25);
  });

  it("浮点误差（1.0000001 / 0.9999999）不当成「已经离开档位」：照样走到相邻一档", () => {
    // 比档位略小时往上：不能因为「1 比 0.9999999 大」就停在原档
    expect(stepRate(1 - 1e-7, 1)).toBe(1.25);
    // 比档位略大时往下：不能因为「1 比 1.0000001 小」就停在原档
    expect(stepRate(1 + 1e-7, -1)).toBe(0.75);
    expect(stepRate(0.75 - 1e-9, 1)).toBe(1);
    expect(stepRate(0.75 + 1e-9, -1)).toBe(0.5);
    // 同方向本来就会走到相邻一档
    expect(stepRate(1 + 1e-7, 1)).toBe(1.25);
    expect(stepRate(1 - 1e-7, -1)).toBe(0.75);
  });
});

describe("decideEscapeClose：连按两次 Esc 关闭播放器", () => {
  const T0 = 100_000;
  const idle: EscapeCloseContext = {
    now: T0,
    armedAt: null,
    fullscreen: false,
    fullscreenExitedAt: null,
    menuOpen: false,
    modalOpen: false,
  };
  const esc = (ctx: Partial<EscapeCloseContext> = {}, ev: Partial<ShortcutEventLike & { repeat: boolean }> = {}) =>
    decideEscapeClose({ key: "Escape", ...ev }, { ...idle, ...ctx });

  it("第一下只上膛（arm），不关", () => {
    expect(esc()).toBe("arm");
  });

  it("窗口内的第二下才关（close）；边界 = 窗口时长含端点，超过一毫秒就当重新第一下", () => {
    expect(esc({ armedAt: T0 - 300 })).toBe("close");
    expect(esc({ armedAt: T0 - ESC_CLOSE_WINDOW_MS })).toBe("close");
    expect(esc({ armedAt: T0 - ESC_CLOSE_WINDOW_MS - 1 })).toBe("arm");
  });

  it("时钟倒退（armedAt 在未来）不算连按：重新上膛", () => {
    expect(esc({ armedAt: T0 + 5 })).toBe("arm");
  });

  it("全屏中：Esc 归浏览器（退出全屏），清掉上膛、不关——即便刚刚上过膛", () => {
    expect(esc({ fullscreen: true })).toBe("reset");
    expect(esc({ fullscreen: true, armedAt: T0 - 100 })).toBe("reset");
  });

  it("退出全屏后的缓冲期：「Esc 退出全屏 → 习惯性再按一下」不会上膛，更不会关", () => {
    expect(esc({ fullscreenExitedAt: T0 - 100 })).toBe("reset");
    expect(esc({ fullscreenExitedAt: T0 - 100, armedAt: T0 - 50 })).toBe("reset");
    // 缓冲过后恢复正常
    expect(esc({ fullscreenExitedAt: T0 - ESC_AFTER_FULLSCREEN_GRACE_MS })).toBe("arm");
    expect(esc({ fullscreenExitedAt: T0 - ESC_AFTER_FULLSCREEN_GRACE_MS - 1, armedAt: T0 - 100 })).toBe("close");
  });

  it("倍速 / 更多菜单开着：Esc 归菜单，不关播放器、清掉上膛", () => {
    expect(esc({ menuOpen: true })).toBe("reset");
    expect(esc({ menuOpen: true, armedAt: T0 - 100 })).toBe("reset");
  });

  it("有模态弹窗开着：Esc 归弹窗，不关播放器、清掉上膛", () => {
    expect(esc({ modalOpen: true })).toBe("reset");
    expect(esc({ modalOpen: true, armedAt: T0 - 100 })).toBe("reset");
  });

  it("长按（repeat 帧）什么都不做：既不能自己上膛，也不能把已上膛的清掉或关掉", () => {
    expect(esc({}, { repeat: true })).toBe("pass");
    expect(esc({ armedAt: T0 - 100 }, { repeat: true })).toBe("pass");
  });

  it("输入法组字中 / 带修饰键的 Esc 不算", () => {
    expect(esc({}, { isComposing: true })).toBe("pass");
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      expect(esc({ armedAt: T0 - 100 }, { [mod]: true }), mod).toBe("pass");
    }
  });

  it("不是 Esc 的键一律 pass（取消上膛由组件在「其它键」分支做）", () => {
    for (const key of ["Enter", "q", " ", "Escape ", "esc"]) {
      expect(decideEscapeClose({ key }, { ...idle, armedAt: T0 - 100 }), key).toBe("pass");
    }
  });

  it("参数口径：窗口 1.5 秒、全屏退出缓冲 0.8 秒（改动要连同帮助文案一起改）", () => {
    expect(ESC_CLOSE_WINDOW_MS).toBe(1500);
    expect(ESC_AFTER_FULLSCREEN_GRACE_MS).toBe(800);
  });

  it("Esc 不再是普通快捷键：resolveMediaShortcut 仍对它返回 null（关闭走有状态的 decideEscapeClose）", () => {
    expect(press("Escape")).toBeNull();
  });
});

describe("连按 Esc 关闭：播放窗接线（源码契约；hook / 全屏行为要真机看）", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const dock = readFileSync(path.join(ROOT, "src/components/media/media-player-dock.tsx"), "utf-8");
  const parts = readFileSync(path.join(ROOT, "src/components/media/media-dock-parts.tsx"), "utf-8");

  it("键盘处理里 Esc 走 decideEscapeClose，喂的是全屏 / 退出全屏时间 / 菜单 / 模态弹窗 / 上膛时间", () => {
    const at = dock.indexOf("decideEscapeClose(e, {");
    expect(at).toBeGreaterThan(-1);
    const call = dock.slice(at, dock.indexOf("});", at));
    for (const field of [
      "now: performance.now()",
      "armedAt: escArmedAtRef.current",
      "fullscreen: isFullscreen",
      "fullscreenExitedAt: fullscreenExitedAtRef.current",
      "menuOpen,",
      "modalOpen: hasOpenModalDialog()",
    ]) {
      expect(call, field).toContain(field);
    }
  });

  it("四种结果各自的动作：reset 清状态、close 清状态后 closeMedia、arm 上膛并起提示计时", () => {
    expect(dock).toContain('if (decision === "reset") disarmEsc();');
    expect(dock).toMatch(/decision === "close"\) \{\s*disarmEsc\(\);\s*closeMedia\(\);/);
    expect(dock).toMatch(/decision === "arm"\) \{\s*escArmedAtRef\.current = performance\.now\(\);\s*setEscArmed\(true\);/);
    expect(dock).toContain("window.setTimeout(disarmEsc, ESC_CLOSE_WINDOW_MS)");
  });

  it("Esc 分支里不吞事件（不 stopPropagation / preventDefault 的只有「关帮助」那一处）：侧栏 / 菜单照样能收到 Esc", () => {
    const start = dock.indexOf("const decision = decideEscapeClose");
    const end = dock.indexOf("disarmEsc();\n      const cmd = resolveMediaShortcut");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(dock.slice(start, end)).not.toMatch(/stopPropagation|preventDefault/);
  });

  it("按了别的键就取消上膛（在 resolveMediaShortcut 之前）；帮助开着时 Esc 先关帮助并清状态", () => {
    expect(dock).toMatch(/disarmEsc\(\);\s*const cmd = resolveMediaShortcut\(e,/);
    expect(dock).toMatch(/if \(showHelp\) \{\s*setShowHelp\(false\);\s*disarmEsc\(\);/);
  });

  it("全屏监听记录退出时间；menuOpen 声明在键盘 effect 之前（deps 数组里用到，不能晚于它声明）", () => {
    expect(dock).toContain("if (!fs) fullscreenExitedAtRef.current = performance.now();");
    expect(dock.indexOf("const [menuOpen, setMenuOpen]")).toBeLessThan(
      dock.indexOf("}, [exec, groupSize, kind, showHelp, isFullscreen, menuOpen, disarmEsc]);"),
    );
    expect(dock).toContain("onMenuOpenChange={setMenuOpen}");
  });

  it("模态弹窗判定：只认开着的 dialog / alert-dialog（关闭动画中的不算）", () => {
    expect(dock).toContain('[data-slot="dialog-content"]');
    expect(dock).toContain('[data-slot="alert-dialog-content"]');
    expect(dock).toContain(":not([data-closed]):not([data-ending-style])");
  });

  it("提示与可发现性：上膛时第二行换成提示、关闭按钮提示写明连按两次、帮助表有这一行", () => {
    expect(dock).toContain("再按一次 Esc 关闭播放器");
    expect(dock).toContain('<Tooltip content="关闭（连按两次 Esc）">');
    expect(parts).toContain('["Esc  Esc"');
  });
});
