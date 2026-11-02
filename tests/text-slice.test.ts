/**
 * 按 UTF-16 码元截断会劈开 emoji / 生僻字（代理对）：截出半个字符（渲染成 \uFFFD）、
 * 发往飞书的正文里还会带孤立代理项。这里钉死公共 helper 与各截断点的行为。
 */
import { describe, expect, it, vi } from "vitest";

import { oneLineAnswer } from "@/lib/group-qa";
import { truncateCommentSnippet } from "@/lib/mr-inbox";
import { SHARE_TO_GROUP_CONTENT_MAX, truncateShareContent } from "@/lib/share-to-group";
import { deriveChatTitleFromMessage } from "@/lib/task-display";
import { sliceHeadSafe, sliceTailSafe } from "@/lib/text-slice";

const EMOJI = "\u{1F600}"; // 😀：2 个码元
const hasLoneSurrogate = (s: string): boolean => !s.isWellFormed();

describe("sliceHeadSafe / sliceTailSafe", () => {
  it("终点不在代理对中间：与 slice 一致", () => {
    expect(sliceHeadSafe("abcdef", 3)).toBe("abc");
    expect(sliceHeadSafe("abcdef", 0)).toBe("");
    expect(sliceHeadSafe("abc", 10)).toBe("abc");
    expect(sliceHeadSafe("a" + EMOJI + "b", 3)).toBe("a" + EMOJI);
  });

  it("终点正好劈在代理对中间：回退一个码元、不留半个字符", () => {
    // "a😀b" 的下标 2 在 😀 的两个码元中间
    expect(sliceHeadSafe("a" + EMOJI + "b", 2)).toBe("a");
    expect(sliceHeadSafe(EMOJI.repeat(5), 5)).toBe(EMOJI.repeat(2));
  });

  it("尾部截取同理：起点劈在代理对中间时后移一个码元", () => {
    expect(sliceTailSafe("a" + EMOJI + "b", 2)).toBe("b");
    expect(sliceTailSafe("a" + EMOJI + "b", 3)).toBe(EMOJI + "b");
    expect(sliceTailSafe("abc", 10)).toBe("abc");
    expect(sliceTailSafe("abc", 0)).toBe("");
  });
});

describe("各截断点不劈 emoji", () => {
  it("deriveChatTitleFromMessage：24 码元处恰是 emoji 中间", () => {
    const text = "a".repeat(23) + EMOJI + "尾巴";
    const title = deriveChatTitleFromMessage(text);
    expect(title).not.toBeNull();
    expect(hasLoneSurrogate(title!)).toBe(false);
  });

  it("truncateCommentSnippet：maxLen-1 处恰是 emoji 中间", () => {
    const text = "a".repeat(118) + EMOJI + "尾巴尾巴";
    const out = truncateCommentSnippet(text, 120);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith("…")).toBe(true);
  });

  it("oneLineAnswer：120 码元处恰是 emoji 中间", () => {
    const out = oneLineAnswer("a".repeat(119) + EMOJI + "尾巴");
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("truncateShareContent：发往飞书的正文上限处恰是 emoji 中间", () => {
    const out = truncateShareContent("a".repeat(SHARE_TO_GROUP_CONTENT_MAX - 1) + EMOJI + "尾");
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("按字素簇（grapheme）退格：ZWJ / 国旗 / 组合符不被劈开", () => {
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // 👨‍👩‍👧：8 个码元、1 个字素簇
  const FLAG = "\u{1F1E8}\u{1F1F3}"; // 🇨🇳：4 个码元（两个区域指示符）
  const E_ACUTE = "e\u0301"; // é：组合符形式，2 个码元

  it("sliceHeadSafe：终点落在 ZWJ 序列中间 → 退到整个序列之前", () => {
    const text = `ab${FAMILY}c`;
    // 下标 2 = 序列起点；3..9 都在序列内部（含 ZWJ 之前 / 之后、代理对中间）
    for (let end = 3; end < 2 + FAMILY.length; end += 1) {
      expect(sliceHeadSafe(text, end), `end=${end}`).toBe("ab");
    }
    // 正好在序列末尾：整个序列保留
    expect(sliceHeadSafe(text, 2 + FAMILY.length)).toBe(`ab${FAMILY}`);
  });

  it("sliceHeadSafe：国旗（两个区域指示符）不被劈成半面旗", () => {
    const text = `x${FLAG}y`;
    expect(sliceHeadSafe(text, 3)).toBe("x"); // 劈在第一个指示符之后
    expect(sliceHeadSafe(text, 2)).toBe("x"); // 劈在第一个指示符的代理对中间
    expect(sliceHeadSafe(text, 5)).toBe(`x${FLAG}`);
  });

  it("sliceHeadSafe：组合符（e + 重音）不把重音留在下一段", () => {
    const text = `a${E_ACUTE}b`;
    expect(sliceHeadSafe(text, 2)).toBe("a"); // 终点在 e 与重音之间
    expect(sliceHeadSafe(text, 3)).toBe(`a${E_ACUTE}`);
  });

  it("sliceTailSafe：起点落在字素簇中间 → 后移到下一个字素边界", () => {
    const text = `a${FAMILY}b`;
    // 取后 n 个码元，起点落在序列内部 → 不留序列的后半截
    for (let n = 2; n < 1 + FAMILY.length; n += 1) {
      expect(sliceTailSafe(text, n), `n=${n}`).toBe("b");
    }
    // 起点正好是序列起点：整个序列保留
    expect(sliceTailSafe(text, FAMILY.length + 1)).toBe(`${FAMILY}b`);
    expect(sliceTailSafe(`x${FLAG}y`, 3)).toBe("y");
    expect(sliceTailSafe(`a${E_ACUTE}b`, 2)).toBe("b");
  });

  it("超长单个字素簇（如叠了几百个组合符）：回退到代理对安全的现状，不会把前缀退成空串", () => {
    const zalgo = "a" + "\u0301".repeat(500);
    const out = sliceHeadSafe(zalgo + "tail", 300);
    expect(out.length).toBeGreaterThan(0);
    expect(out.isWellFormed()).toBe(true);
  });

  it("超长文本只在截断点附近分段：百万码元文本截断仍是毫秒级", () => {
    const big = "你好a".repeat(400_000);
    const t0 = performance.now();
    const out = sliceHeadSafe(big, 700_001);
    sliceTailSafe(big, 300_001);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out.length).toBeLessThanOrEqual(700_001);
  });

  it("没有 Intl.Segmenter 时回退到仅防代理对的旧行为", async () => {
    const original = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true, writable: true });
    try {
      vi.resetModules();
      const mod = await import("@/lib/text-slice");
      // 代理对仍不被劈
      expect(mod.sliceHeadSafe(`a${EMOJI}b`, 2)).toBe("a");
      expect(mod.sliceTailSafe(`a${EMOJI}b`, 2)).toBe("b");
      // 退化：ZWJ 序列内部的切点只保证不留半个码点（字素簇保护需要 Segmenter）
      expect(mod.sliceHeadSafe(`ab${FAMILY}c`, 5)).toBe(`ab${FAMILY.slice(0, 3)}`);
      expect(mod.sliceHeadSafe(`ab${FAMILY}c`, 5).isWellFormed()).toBe(true);
    } finally {
      if (original) Object.defineProperty(Intl, "Segmenter", original);
      vi.resetModules();
    }
  });
});
