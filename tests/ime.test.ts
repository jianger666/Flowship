import { describe, expect, it } from "vitest";

import { isImeComposing } from "../src/lib/ime";

describe("isImeComposing（S14-01：输入法选词时 Enter 不能当提交）", () => {
  it("原生事件 isComposing=true → 组合中", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });

  it("keyCode 229（Safari：compositionend 后的 Enter，isComposing 已是 false）→ 组合中", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("React 合成事件：看 nativeEvent 的 isComposing / keyCode", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });

  it("普通 Enter（keyCode 13、非组合）→ 不是组合", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(
      isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }),
    ).toBe(false);
    expect(isImeComposing({})).toBe(false);
    expect(isImeComposing({ nativeEvent: null })).toBe(false);
  });
});
