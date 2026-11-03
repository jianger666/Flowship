/**
 * 播放器快捷键（media-shortcuts）：按键 → 命令；倍速档位步进
 */
import { describe, expect, it } from "vitest";

import { RATES } from "@/lib/media/media-memory";
import {
  resolveMediaShortcut,
  stepRate,
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

  it("静音 / A-B 点 / 循环", () => {
    expect(press("m")).toEqual({ type: "mute" });
    expect(press("i")).toEqual({ type: "abIn" });
    expect(press("o")).toEqual({ type: "abOut" });
    expect(press("x")).toEqual({ type: "abClear" });
    expect(press("r")).toEqual({ type: "loop" });
  });

  it("大窗 / 帮助", () => {
    expect(press("t")).toEqual({ type: "theater" });
    expect(press("?", VIDEO, { shiftKey: true })).toEqual({ type: "help" });
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
    for (const key of [" ", "k", "j", "l", "m", "i", "o", "x", "r", "t", "[", "]", "ArrowLeft", "Home"]) {
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
