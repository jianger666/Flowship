/**
 * 事件流「贴底跟随」判定纯逻辑（2026-07-28 流式滚动手感重构）
 *
 * 守的是这次修复的核心语义：**跟随与否只看用户意图，不看内容长高了多少**。
 * 老实现把两件事挤在 Virtuoso 的 atBottomThreshold=120 上，直接后果是
 * 用户往上滚 50px 仍被判贴底、下一个 chunk 又把他拽回底部（用户实测「一滚就抖」）。
 */
import { describe, expect, it } from "vitest";

import {
  FOLLOW_PIN_THRESHOLD,
  countNewItems,
  distanceFromBottom,
  isEditableTarget,
  isScrollbarPointer,
  isUpIntentKey,
  isUpIntentTouch,
  isUpIntentWheel,
  nextFollowing,
  nextNewItemsBaseline,
  shouldPinWorkGroupOpen,
} from "@/lib/scroll-follow";

describe("distanceFromBottom", () => {
  it("按 scrollHeight - scrollTop - clientHeight 算距底", () => {
    expect(
      distanceFromBottom({
        scrollTop: 300,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(300);
  });

  it("负数夹到 0（橡皮筋回弹 / 亚像素误差会算出负值）", () => {
    expect(
      distanceFromBottom({
        scrollTop: 620,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(0);
  });
});

describe("nextFollowing", () => {
  it("流式内容增高（无用户意图）不该掉出跟随——哪怕已经离底很远", () => {
    // 这就是老实现塞 atBottomThreshold=120 想解决的问题；
    // 现在靠「没有用户意图就不动跟随态」解决，不需要靠阈值兜。
    expect(
      nextFollowing(true, { distanceFromBottom: 800, userIntentUp: false }),
    ).toBe(true);
  });

  it("【核心回归】用户上滚 50px 就该停跟随——老实现 120px 阈值下会被无视、下个 chunk 把人拽回底", () => {
    expect(nextFollowing(true, { distanceFromBottom: 50, userIntentUp: true })).toBe(
      false,
    );
  });

  it("上滚幅度还在贴底阈值内（误触）→ 维持跟随、不惩罚手滑", () => {
    expect(
      nextFollowing(true, {
        distanceFromBottom: FOLLOW_PIN_THRESHOLD - 1,
        userIntentUp: true,
      }),
    ).toBe(true);
  });

  it("非跟随态滚回底部 → 自动恢复跟随", () => {
    expect(
      nextFollowing(false, { distanceFromBottom: 0, userIntentUp: false }),
    ).toBe(true);
  });

  it("非跟随态下内容继续增高 → 保持不跟随（用户在翻历史、别打扰）", () => {
    expect(
      nextFollowing(false, { distanceFromBottom: 5000, userIntentUp: false }),
    ).toBe(false);
  });

  it("往下滚但还没到底（无上滚意图）→ 维持原状、不擅自恢复跟随", () => {
    expect(
      nextFollowing(false, {
        distanceFromBottom: FOLLOW_PIN_THRESHOLD + 1,
        userIntentUp: false,
      }),
    ).toBe(false);
  });

  it("贴底阈值可覆盖（调用方 / 单测用）", () => {
    expect(
      nextFollowing(false, {
        distanceFromBottom: 100,
        userIntentUp: false,
        pinThreshold: 200,
      }),
    ).toBe(true);
  });

  it("阈值取值合理：大于 Virtuoso 默认 4px、又远小于老实现的 120px", () => {
    expect(FOLLOW_PIN_THRESHOLD).toBeGreaterThan(4);
    expect(FOLLOW_PIN_THRESHOLD).toBeLessThan(120);
  });
});

describe("用户上滚意图识别", () => {
  it("滚轮 deltaY < 0 = 往上翻", () => {
    expect(isUpIntentWheel(-3)).toBe(true);
    expect(isUpIntentWheel(0)).toBe(false);
    expect(isUpIntentWheel(12)).toBe(false);
  });

  it("触摸：手指往下拖（clientY 变大）= 往上翻；2px 死区过滤点击抖动", () => {
    expect(isUpIntentTouch(30)).toBe(true);
    expect(isUpIntentTouch(2)).toBe(false);
    expect(isUpIntentTouch(-30)).toBe(false);
  });

  it("键盘上翻键", () => {
    expect(isUpIntentKey("ArrowUp")).toBe(true);
    expect(isUpIntentKey("PageUp")).toBe(true);
    expect(isUpIntentKey("Home")).toBe(true);
    expect(isUpIntentKey("ArrowDown")).toBe(false);
    expect(isUpIntentKey("a")).toBe(false);
  });

  it("可编辑元素里的按键不算滚动意图（事件流里内联着编辑框 / 答题卡）", () => {
    expect(isEditableTarget("TEXTAREA", false)).toBe(true);
    expect(isEditableTarget("INPUT", false)).toBe(true);
    expect(isEditableTarget("DIV", true)).toBe(true);
    expect(isEditableTarget("DIV", false)).toBe(false);
    expect(isEditableTarget("BUTTON", false)).toBe(false);
  });

  it("pointerdown 落在滚动条槽（offsetX 超出 clientWidth）才算拖滚动条", () => {
    expect(isScrollbarPointer(804, 800)).toBe(true);
    expect(isScrollbarPointer(400, 800)).toBe(false);
  });
});

describe("「N 条新内容」计数（回到最新按钮）", () => {
  /** 按「跟随 → 离开 → 追加 / prepend」的真实顺序推一遍基线，返回最终计数 */
  const run = (
    steps: Array<{
      count: number;
      following: boolean;
      prependDelta?: number;
    }>,
  ): number => {
    let baseline = steps[0]!.count;
    let last = baseline;
    for (const s of steps) {
      baseline = nextNewItemsBaseline(
        baseline,
        s.count,
        s.following,
        s.prependDelta ?? 0,
      );
      last = s.count;
    }
    return countNewItems(baseline, last);
  };

  it("跟随中基线一直跟平当前条数 → 计数恒 0", () => {
    expect(
      run([
        { count: 100, following: true },
        { count: 140, following: true },
      ]),
    ).toBe(0);
  });

  it("离开底部后基线冻住、之后追加多少就报多少", () => {
    expect(
      run([
        { count: 100, following: true },
        { count: 100, following: false },
        { count: 112, following: false },
      ]),
    ).toBe(12);
  });

  it("刚离开底部那一刻是 0 条新内容（没错过任何东西）", () => {
    expect(
      run([
        { count: 100, following: true },
        { count: 100, following: false },
      ]),
    ).toBe(0);
  });

  it("点回到最新（恢复跟随）后计数清零、不留旧账", () => {
    expect(
      run([
        { count: 100, following: true },
        { count: 130, following: false },
        { count: 130, following: true },
        { count: 130, following: false },
      ]),
    ).toBe(0);
  });

  it("离开期间条数反而变少（事件被裁）→ 基线跟着降，之后的新内容照样能报出来", () => {
    // 不夹的话基线会一直「欠着」高位、后面真来了新内容也一直显示 0
    expect(
      run([
        { count: 100, following: true },
        { count: 30, following: false },
        { count: 35, following: false },
      ]),
    ).toBe(5);
  });

  it("推进函数幂等——渲染期直接写 ref、StrictMode 双渲不会算歪", () => {
    const once = nextNewItemsBaseline(100, 130, false);
    expect(nextNewItemsBaseline(once, 130, false)).toBe(once);
    const pinned = nextNewItemsBaseline(100, 130, true);
    expect(nextNewItemsBaseline(pinned, 130, true)).toBe(pinned);
  });

  it("离开底部后 prepend 更早历史 → 计数保持 0（头部增量不是「新内容」）", () => {
    expect(
      run([
        { count: 100, following: true },
        { count: 100, following: false },
        { count: 120, following: false, prependDelta: 20 },
      ]),
    ).toBe(0);
  });

  it("prepend 后再来尾部追加 → 只计尾部增量", () => {
    expect(
      run([
        { count: 100, following: true },
        { count: 100, following: false },
        { count: 120, following: false, prependDelta: 20 },
        { count: 125, following: false },
      ]),
    ).toBe(5);
  });

  it("跟随态 prepend 不走基线抬高（基线已跟平 itemCount）", () => {
    expect(nextNewItemsBaseline(100, 120, true, 20)).toBe(120);
  });
});

describe("shouldPinWorkGroupOpen（工作过程组自动收起防打扰）", () => {
  it("用户在翻历史时、自动收起的下降沿要被钉住展开", () => {
    expect(shouldPinWorkGroupOpen(true, false, false)).toBe(true);
  });

  it("用户贴底跟随时照常自动收起（视线在最新一行、收起只是尾部整理）", () => {
    expect(shouldPinWorkGroupOpen(true, false, true)).toBe(false);
  });

  it("不是「展开 → 收起」的下降沿一律不钉", () => {
    expect(shouldPinWorkGroupOpen(false, false, false)).toBe(false);
    expect(shouldPinWorkGroupOpen(false, true, false)).toBe(false);
    expect(shouldPinWorkGroupOpen(true, true, false)).toBe(false);
  });
});
