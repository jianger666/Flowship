/**
 * 事件流「贴底跟随」判定纯逻辑（2026-07-28 流式滚动手感重构）
 *
 * 守的是这次修复的核心语义：**跟随与否只看用户意图，不看内容长高了多少**。
 * 老实现把两件事挤在 Virtuoso 的 atBottomThreshold=120 上，直接后果是
 * 用户往上滚 50px 仍被判贴底、下一个 chunk 又把他拽回底部（用户实测「一滚就抖」）。
 */
import { describe, expect, it } from "vitest";

import {
  DOWN_INTENT_TTL_MS,
  FOLLOW_PIN_THRESHOLD,
  PIN_SETTLE_MAX_FRAMES,
  PIN_SETTLE_STABLE_FRAMES,
  VIRTUOSO_NEVER_AT_BOTTOM,
  countNewItems,
  distanceFromBottom,
  isDownIntentKey,
  isDownIntentTouch,
  isDownIntentWheel,
  isEditableTarget,
  isScrollbarPointer,
  isUpIntentKey,
  isUpIntentTouch,
  isUpIntentWheel,
  nextFollowing,
  nextNewItemsBaseline,
  shouldPinWorkGroupOpen,
  type FollowInput,
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

/** 构造一次状态机输入：默认没有任何用户输入、没动、贴着底 */
const input = (over: Partial<FollowInput> = {}): FollowInput => ({
  distanceFromBottom: 0,
  userIntentUp: false,
  userIntentDown: false,
  scrollDelta: 0,
  ...over,
});

describe("nextFollowing", () => {
  it("流式内容增高（无用户意图）不该掉出跟随——哪怕已经离底很远", () => {
    // 这就是老实现塞 atBottomThreshold=120 想解决的问题；
    // 现在靠「没有用户意图就不动跟随态」解决，不需要靠阈值兜。
    expect(nextFollowing(true, input({ distanceFromBottom: 800 }))).toBe(true);
  });

  it("【核心回归】用户上滚 50px 就该停跟随——老实现 120px 阈值下会被无视、下个 chunk 把人拽回底", () => {
    expect(
      nextFollowing(
        true,
        input({ distanceFromBottom: 50, userIntentUp: true, scrollDelta: -50 }),
      ),
    ).toBe(false);
  });

  it("上滚意图优先于几何贴底——即使距底还在 48px 内（底部附近往回滚），也该离开跟随，否则流式增长会把用户拽回底部造成上下抖动", () => {
    expect(
      nextFollowing(
        true,
        input({
          distanceFromBottom: FOLLOW_PIN_THRESHOLD - 1,
          userIntentUp: true,
          scrollDelta: -10,
        }),
      ),
    ).toBe(false);
  });

  it("用户往下滚回底部（往下翻的输入 + 这一帧朝底部走 + 进了贴底带）→ 自动恢复跟随", () => {
    expect(
      nextFollowing(
        false,
        input({ distanceFromBottom: 0, userIntentDown: true, scrollDelta: 30 }),
      ),
    ).toBe(true);
  });

  it("非跟随态下内容继续增高 → 保持不跟随（用户在翻历史、别打扰）", () => {
    expect(nextFollowing(false, input({ distanceFromBottom: 5000 }))).toBe(
      false,
    );
  });

  it("往下滚但还没进贴底带 → 维持原状、不擅自恢复跟随", () => {
    expect(
      nextFollowing(
        false,
        input({
          distanceFromBottom: FOLLOW_PIN_THRESHOLD + 1,
          userIntentDown: true,
          scrollDelta: 30,
        }),
      ),
    ).toBe(false);
  });

  it("上滚意图和往下翻输入同时出现（手势交错）→ 以上滚为准", () => {
    for (const prev of [true, false]) {
      expect(
        nextFollowing(
          prev,
          input({
            distanceFromBottom: 10,
            userIntentUp: true,
            userIntentDown: true,
            scrollDelta: 10,
          }),
        ),
      ).toBe(false);
    }
  });

  it("贴底阈值可覆盖（调用方 / 单测用）", () => {
    expect(
      nextFollowing(
        false,
        input({
          distanceFromBottom: 100,
          userIntentDown: true,
          scrollDelta: 30,
          pinThreshold: 200,
        }),
      ),
    ).toBe(true);
  });

  it("阈值取值合理：大于 Virtuoso 默认 4px、又远小于老实现的 120px", () => {
    expect(FOLLOW_PIN_THRESHOLD).toBeGreaterThan(4);
    expect(FOLLOW_PIN_THRESHOLD).toBeLessThan(120);
  });
});

describe("恢复跟随只认用户往下翻——程序化滚动骗不了它（2026-10-12「往回滚一点又弹回底部」）", () => {
  it("没有往下翻的输入：朝底部走、进了贴底带也不恢复（Virtuoso 的向上滚动补偿 / 重试贴底 / prepend 锚定都长这样）", () => {
    expect(
      nextFollowing(
        false,
        input({ distanceFromBottom: 6, userIntentDown: false, scrollDelta: 28 }),
      ),
    ).toBe(false);
  });

  it("有往下翻的输入、但这一帧没朝底部走（没动 / 朝顶部）→ 不恢复", () => {
    // 没动：亚像素下相邻帧可能同值；朝顶部：用户转向、或动画尾帧回退
    for (const scrollDelta of [0, -1, -40]) {
      expect(
        nextFollowing(
          false,
          input({ distanceFromBottom: 10, userIntentDown: true, scrollDelta }),
        ),
      ).toBe(false);
    }
  });

  it("边界：距底恰好等于贴底线就恢复，差 1px 不恢复", () => {
    const at = (distanceFromBottom: number) =>
      nextFollowing(
        false,
        input({ distanceFromBottom, userIntentDown: true, scrollDelta: 5 }),
      );
    expect(at(FOLLOW_PIN_THRESHOLD)).toBe(true);
    expect(at(FOLLOW_PIN_THRESHOLD + 1)).toBe(false);
  });

  it("已在跟随时：往下翻 / 程序化滚动都不会改变它，只有上滚意图能让它掉", () => {
    for (const scrollDelta of [-30, 0, 30]) {
      for (const userIntentDown of [true, false]) {
        expect(
          nextFollowing(
            true,
            input({ distanceFromBottom: 20, userIntentDown, scrollDelta }),
          ),
        ).toBe(true);
      }
    }
  });
});

/**
 * 回放：把真实浏览器里抓到的 scroll 事件序列按控制器的方式喂给状态机。
 * 每个元素 = 一个 scroll 事件（上滚意图只会出现在它后面的第一帧上）。
 */
interface Frame {
  top: number;
  /** 本帧距底 */
  dist: number;
  /** 本帧消费了上滚意图 */
  intentUp?: boolean;
  /** 往下翻的输入此刻仍在有效期内 */
  intentDown?: boolean;
}

const replay = (
  rule: (prev: boolean, i: FollowInput) => boolean,
  startFollowing: boolean,
  startTop: number,
  frames: Frame[],
): boolean[] => {
  let following = startFollowing;
  let lastTop = startTop;
  return frames.map((f) => {
    following = rule(following, {
      distanceFromBottom: f.dist,
      userIntentUp: f.intentUp ?? false,
      userIntentDown: f.intentDown ?? false,
      scrollDelta: f.top - lastTop,
    });
    lastTop = f.top;
    return following;
  });
};

/** 2026-10-12 之前的规则（冻结）：只看几何——距底 <= 48 就恢复。用来证明回放序列确实会触发 bug */
const legacyNextFollowing = (prev: boolean, i: FollowInput): boolean => {
  if (i.userIntentUp) return false;
  if (i.distanceFromBottom <= FOLLOW_PIN_THRESHOLD) return true;
  return prev;
};

describe("回放：真实浏览器抓到的滚动序列（旧规则会弹回底部、新规则不会）", () => {
  it("键盘 ↑ 的平滑动画 + Virtuoso 把内容增高「补偿」成向下推（实测序列）：全程停在原处", () => {
    // Chrome 把一次 ArrowUp 拆成十来帧；中间 Virtuoso 的「向上滚动补偿」scrollBy(+28)
    // 让 scrollTop 反而变大——它们离底都只有几 px、落在 48px 贴底带里
    const frames: Frame[] = [
      { top: 3720, dist: 2, intentUp: true },
      { top: 3716, dist: 6 },
      { top: 3710, dist: 40 },
      { top: 3730, dist: 20 },
      { top: 3723, dist: 27 },
      { top: 3744, dist: 6 },
      { top: 3745, dist: 5 },
      { top: 3748, dist: 2 },
      { top: 3750, dist: 28 },
      { top: 3778, dist: 0 },
    ];
    const now = replay(nextFollowing, true, 3722, frames);
    expect(now).toEqual(frames.map(() => false));
    // 对照：旧规则从第 2 帧起就恢复了跟随（= 下一个 chunk 把人拽回底部）
    const old = replay(legacyNextFollowing, true, 3722, frames);
    expect(old[0]).toBe(false);
    expect(old.slice(1).every(Boolean)).toBe(true);
  });

  it("滚轮一格 ≈100px 的平滑动画（ease-in-out，起步几帧离底只有几 px）：全程停在原处", () => {
    const dists = [3, 9, 22, 42, 66, 86, 97, 100];
    const frames: Frame[] = dists.map((dist, i) => ({
      top: 3700 - dist,
      dist,
      intentUp: i === 0,
    }));
    expect(replay(nextFollowing, true, 3700, frames)).toEqual(
      frames.map(() => false),
    );
    // 对照：旧规则在 9px 那一帧就恢复、之后一直 true——动画跑完人还是被拽回
    const old = replay(legacyNextFollowing, true, 3700, frames);
    expect(old.at(-1)).toBe(true);
  });

  it("没有任何用户输入、只有程序化向下推（Virtuoso 补偿 / 重试）：非跟随态不会被推回跟随", () => {
    const frames: Frame[] = [
      { top: 3600, dist: 40 },
      { top: 3620, dist: 20 },
      { top: 3634, dist: 6 },
      { top: 3640, dist: 0 },
    ];
    expect(replay(nextFollowing, false, 3590, frames)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(replay(legacyNextFollowing, false, 3590, frames)[1]).toBe(true);
  });

  it("用户往下滚回底部：进贴底带的那一帧恢复、之后保持", () => {
    const dists = [300, 200, 120, 70, 44, 20, 0];
    const frames: Frame[] = dists.map((dist) => ({
      top: 3000 + (300 - dist),
      dist,
      intentDown: true,
    }));
    expect(replay(nextFollowing, false, 3000, frames)).toEqual([
      false,
      false,
      false,
      false,
      true, // 44 <= 48
      true,
      true,
    ]);
  });

  it("滚回贴底带后又立刻反悔往上滚：上滚意图把它重新关掉", () => {
    const frames: Frame[] = [
      { top: 3256, dist: 44, intentDown: true },
      { top: 3240, dist: 60, intentUp: true },
      { top: 3236, dist: 64, intentDown: true }, // 往下翻的输入还没过期、但这帧朝顶部
    ];
    expect(replay(nextFollowing, false, 3200, frames)).toEqual([
      true,
      false,
      false,
    ]);
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

describe("用户往下翻输入识别（对称于上滚意图）", () => {
  it("滚轮 deltaY > 0 = 往下翻", () => {
    expect(isDownIntentWheel(3)).toBe(true);
    expect(isDownIntentWheel(0)).toBe(false);
    expect(isDownIntentWheel(-12)).toBe(false);
  });

  it("触摸：手指往上拖（clientY 变小）= 往下翻；2px 死区过滤点击抖动", () => {
    expect(isDownIntentTouch(-30)).toBe(true);
    expect(isDownIntentTouch(-2)).toBe(false);
    expect(isDownIntentTouch(30)).toBe(false);
  });

  it("键盘下翻键", () => {
    expect(isDownIntentKey("ArrowDown")).toBe(true);
    expect(isDownIntentKey("PageDown")).toBe(true);
    expect(isDownIntentKey("End")).toBe(true);
    expect(isDownIntentKey("ArrowUp")).toBe(false);
    expect(isDownIntentKey("a")).toBe(false);
  });

  it("同一个输入不会既是上滚意图又是往下翻——否则一次输入会把状态机同时往两头拽", () => {
    for (const dy of [-120, -1, 0, 1, 120]) {
      expect(isUpIntentWheel(dy) && isDownIntentWheel(dy)).toBe(false);
    }
    for (const dy of [-120, -3, -2, 0, 2, 3, 120]) {
      expect(isUpIntentTouch(dy) && isDownIntentTouch(dy)).toBe(false);
    }
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]) {
      expect(isUpIntentKey(key) && isDownIntentKey(key)).toBe(false);
    }
  });
});

describe("几个影响跟随行为的常量", () => {
  it("Virtuoso 的「底部带」必须是负无穷（= 永远不在底部）：它自带两条不问跟随态的自动贴底（内容增高 / 视口变矮）靠这个判定触发，用户上滚的那一帧只要碰上流式增高就会被它拽回、拽回后又触发下一轮", () => {
    expect(VIRTUOSO_NEVER_AT_BOTTOM).toBe(Number.NEGATIVE_INFINITY);
  });

  it("往下翻输入的有效期：长到盖住浏览器的平滑滚动动画、又短到不让后来的程序化滚动混进来", () => {
    expect(DOWN_INTENT_TTL_MS).toBeGreaterThanOrEqual(500);
    expect(DOWN_INTENT_TTL_MS).toBeLessThanOrEqual(2000);
  });

  it("贴底后复查几帧才算稳：至少 2 帧（Virtuoso 测完新项高度要滞后一两帧）、别多到每次都空盯", () => {
    expect(PIN_SETTLE_STABLE_FRAMES).toBeGreaterThanOrEqual(2);
    expect(PIN_SETTLE_STABLE_FRAMES).toBeLessThanOrEqual(6);
  });

  it("复查预算：内容一直在长时最多盯多久——够盖住一次测量滞后（15 帧 ≈ 0.25s），又别无限续命（60 帧 ≈ 1s）；控制器测试拿这个常量自己当期望，所以数值得在这里钉住", () => {
    expect(PIN_SETTLE_MAX_FRAMES).toBeGreaterThanOrEqual(15);
    expect(PIN_SETTLE_MAX_FRAMES).toBeLessThanOrEqual(60);
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
