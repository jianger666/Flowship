/**
 * 贴底跟随控制器：合批 + 闸门 + 自己贴底自己复查 + 手势接线（2026-07-28 起，2026-10-12 重写）
 *
 * 第一版只测不碰 DOM 的那一半（跟随态托管 + rAF 合批）。2026-10-12 用户实测
 * 「在底部往回滚一点点，它会自己弹回底部去」之后，控制器多了三件必须在 node 里钉住的事：
 *
 * 1. **贴底自己写 scrollTop、自己复查**，不再调 Virtuoso 的 scrollToIndex——后者有条
 *    「内容一直在长就永不结束、又没法取消」的重试链，用户上滚后还会每 ~100ms 把人拉回底部。
 *    所以「用户上滚之后，控制器绝不再写 scrollTop」是这里最核心的不变量。
 * 2. **恢复跟随只认用户往下翻的输入**（+ 朝底部走 + 进贴底带）；程序化滚动骗不了它。
 * 3. **视口高度变化时补一次贴底**（Virtuoso 自己那条路径被关了），且受跟随态约束。
 *
 * 用一个能派发事件、会夹 scrollTop 的假滚动容器驱动真实的控制器；判定规则本身的真值表
 * 在 tests/scroll-follow.test.ts，这里验证的是「事件 → 状态」的接线没接歪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStreamFollowController } from "@/hooks/use-stream-follow";
import {
  DOWN_INTENT_TTL_MS,
  PIN_SETTLE_MAX_FRAMES,
  PIN_SETTLE_STABLE_FRAMES,
} from "@/lib/scroll-follow";

// ---------- 环境桩 ----------

/** 手动驱动的 rAF 桩：排队的回调攒着，flush() 时一次性跑完（模拟「下一帧」）；cancel 真的会摘掉 */
let queued = new Map<number, () => void>();
let nextFrameId = 1;
let rafCalls = 0;
let cancelCalls = 0;

/** 假时钟：控制器用它判「往下翻」输入是否还在有效期内 */
let clock = 0;

type Listener = (event: unknown) => void;

const addTo = (map: Map<string, Set<Listener>>, type: string, fn: Listener) => {
  const set = map.get(type) ?? new Set<Listener>();
  set.add(fn);
  map.set(type, set);
};
const removeFrom = (
  map: Map<string, Set<Listener>>,
  type: string,
  fn: Listener,
) => {
  map.get(type)?.delete(fn);
};
const countIn = (map: Map<string, Set<Listener>>, type: string) =>
  map.get(type)?.size ?? 0;

let windowListeners = new Map<string, Set<Listener>>();
const windowStub = {
  addEventListener: (type: string, fn: Listener) =>
    addTo(windowListeners, type, fn),
  removeEventListener: (type: string, fn: Listener) =>
    removeFrom(windowListeners, type, fn),
};

/** 可观察的 ResizeObserver 桩：cb 由测试手动触发 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  observed: unknown = null;
  constructor(private readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: unknown) {
    this.observed = el;
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.cb();
  }
}

beforeEach(() => {
  queued = new Map();
  nextFrameId = 1;
  rafCalls = 0;
  cancelCalls = 0;
  clock = 0;
  windowListeners = new Map();
  FakeResizeObserver.instances = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    rafCalls += 1;
    const id = nextFrameId++;
    queued.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelCalls += 1;
    queued.delete(id);
  });
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flushFrame = () => {
  const pending = [...queued.values()];
  queued = new Map();
  for (const cb of pending) cb();
};
const pendingFrames = () => queued.size;

// ---------- 假滚动容器 ----------

interface ScrollerInit {
  top: number;
  height: number;
  client: number;
}

/**
 * 会夹 scrollTop 的假滚动容器（对齐浏览器：写超过最大可滚位置会被夹住）。
 * - `writes`：控制器对 scrollTop 的写入（= 程序化滚动）
 * - `userScrollTo`：模拟「浏览器因用户输入 / Virtuoso 补偿滚到了 top」——不计入 writes、派发 scroll 事件
 */
const makeScroller = (init: ScrollerInit) => {
  const listeners = new Map<string, Set<Listener>>();
  const writes: number[] = [];
  const geom = { height: init.height, client: init.client };
  let top = init.top;
  const el = {
    get scrollHeight() {
      return geom.height;
    },
    get clientHeight() {
      return geom.client;
    },
    clientWidth: 900,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      writes.push(v);
      top = Math.max(0, Math.min(v, geom.height - geom.client));
    },
    addEventListener: (type: string, fn: Listener) =>
      addTo(listeners, type, fn),
    removeEventListener: (type: string, fn: Listener) =>
      removeFrom(listeners, type, fn),
  };
  const dispatch = (type: string, event: object = {}) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };
  return {
    el,
    writes,
    dispatch,
    listenerCount: (type: string) => countIn(listeners, type),
    /** 内容在下方增高（流式吐字） */
    grow: (px: number) => {
      geom.height += px;
    },
    /** 视口高度变化（composer 变高 / 窗口缩放） */
    resize: (client: number) => {
      geom.client = client;
    },
    /** 浏览器按用户输入滚到 top（或 Virtuoso 自己的补偿滚动）：不计入 writes */
    userScrollTo: (v: number) => {
      top = v;
      dispatch("scroll");
    },
    top: () => top,
  };
};
type FakeScroller = ReturnType<typeof makeScroller>;

/** 默认几何：总高 2000、视口 800 → 最大可滚 1200 */
const GEOM: ScrollerInit = { top: 1200, height: 2000, client: 800 };

const setup = () => {
  const scrollToBottom = vi.fn();
  const ctrl = createStreamFollowController(
    { current: scrollToBottom },
    () => clock,
  );
  return { ctrl, scrollToBottom };
};

const setupWithScroller = (over: Partial<ScrollerInit> = {}) => {
  const { ctrl, scrollToBottom } = setup();
  const sc: FakeScroller = makeScroller({ ...GEOM, ...over });
  ctrl.attachScroller(sc.el as unknown as HTMLElement);
  return { ctrl, scrollToBottom, sc };
};

const key = (k: string, tagName = "DIV", isContentEditable = false) => ({
  key: k,
  target: { tagName, isContentEditable },
});

// ---------- 合批 + 闸门（没有滚动容器时的行为，第一版就有） ----------

describe("createStreamFollowController：合批与闸门", () => {
  it("默认跟随最新（进来就在底部看最新）", () => {
    const { ctrl } = setup();
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("一帧内请求多少次都只贴底一次（SSE 一秒能推几十个 chunk）", () => {
    const { ctrl, scrollToBottom } = setup();
    for (let i = 0; i < 20; i++) ctrl.requestScrollToBottom();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(rafCalls).toBe(1);
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("合批不会饿死：上一帧跑完后下一帧还能再排（chunk 比帧还密时也得跟上）", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.requestScrollToBottom();
    flushFrame();
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("排队后用户上滚导致停跟随 → 这一帧的贴底作废（别把人拽回去）", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.requestScrollToBottom();
    ctrl.setFollowing(false);
    flushFrame();
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("停跟随时会把已排队的帧真的摘掉（不只是回调里再判一次）", () => {
    const { ctrl } = setup();
    ctrl.requestScrollToBottom();
    expect(pendingFrames()).toBe(1);
    ctrl.setFollowing(false);
    expect(pendingFrames()).toBe(0);
    expect(cancelCalls).toBe(1);
  });

  it("没有滚动容器（单测 / Window 滚动）→ 退回兜底动作、只做一次、不排复查", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(pendingFrames()).toBe(0);
  });

  it("挂的是 Window（useWindowScroll）一律当没挂", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.attachScroller(windowStub as unknown as Window);
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("订阅者只在跟随态真的翻转时收到通知", async () => {
    const { ctrl } = setup();
    const onChange = vi.fn();
    const unsubscribe = ctrl.subscribe(onChange);

    ctrl.setFollowing(true); // 同值、不通知
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();

    ctrl.setFollowing(false);
    // 通知走微任务（允许渲染期写跟随态而不触发 React 跨组件更新告警）
    expect(onChange).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ctrl.getSnapshot()).toBe(false);

    unsubscribe();
    ctrl.setFollowing(true);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再通知（组件卸载 / 切 task 重建）", async () => {
    const { ctrl } = setup();
    const onChange = vi.fn();
    ctrl.subscribe(onChange);
    ctrl.dispose();
    ctrl.setFollowing(false);
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------- 自己贴底、自己复查 ----------

describe("贴底：控制器自己写 scrollTop、自己复查（不经 Virtuoso 的重试链）", () => {
  it("离底时直接写 scrollTop（写 scrollHeight、由浏览器夹到最大可滚位置），不调兜底动作", () => {
    const { ctrl, scrollToBottom, sc } = setupWithScroller({ top: 0 });
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.writes).toEqual([2000]);
    expect(sc.top()).toBe(1200);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("已经贴着就不写（不白触发 scroll 事件）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.writes).toEqual([]);
  });

  it("差 1px 以内算贴着（亚像素），差 2px 要贴", () => {
    const near = setupWithScroller({ top: 1199 });
    near.ctrl.requestScrollToBottom();
    flushFrame();
    expect(near.sc.writes).toEqual([]);

    queued = new Map();
    const far = setupWithScroller({ top: 1198 });
    far.ctrl.requestScrollToBottom();
    flushFrame();
    expect(far.sc.writes).toEqual([2000]);
  });

  it(`贴完不立刻收工：连续 ${PIN_SETTLE_STABLE_FRAMES} 帧都贴着才算稳（Virtuoso 测完新项高度要滞后几帧）`, () => {
    const { ctrl } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES - 1; i++) {
      flushFrame();
      expect(pendingFrames()).toBe(1); // 还在盯
    }
    flushFrame();
    expect(pendingFrames()).toBe(0); // 够了、收工
  });

  it("盯的几帧里内容又被撑高 → 再贴一次，稳定计数从头来", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    flushFrame(); // 第 1 帧：贴着（stable=1）
    sc.grow(300); // Virtuoso 测完新项、总高变了 → 距底 300
    flushFrame();
    expect(sc.writes).toEqual([2300]);
    expect(sc.top()).toBe(1500);
    // 重新数：还得再连续 N 帧
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES - 1; i++) {
      flushFrame();
      expect(pendingFrames()).toBe(1);
    }
    flushFrame();
    expect(pendingFrames()).toBe(0);
  });

  it(`内容一直在长：最多盯 ${PIN_SETTLE_MAX_FRAMES} 帧就停，不无限续命`, () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    let frames = 0;
    while (pendingFrames() > 0 && frames < PIN_SETTLE_MAX_FRAMES + 5) {
      sc.grow(50);
      flushFrame();
      frames += 1;
    }
    expect(frames).toBe(PIN_SETTLE_MAX_FRAMES);
    expect(pendingFrames()).toBe(0);
    expect(sc.writes).toHaveLength(PIN_SETTLE_MAX_FRAMES);
  });

  it("盯到一半预算用完就停；之后新的贴底请求能重新开一条链（不饿死）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    while (pendingFrames() > 0) {
      sc.grow(50);
      flushFrame();
    }
    const written = sc.writes.length;
    sc.grow(50);
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.writes).toHaveLength(written + 1);
  });

  it("链还在进行时再来的贴底请求并进去、不多排帧", () => {
    const { ctrl } = setupWithScroller({ top: 0 });
    ctrl.requestScrollToBottom();
    flushFrame(); // 贴了一次、复查帧已排
    const before = rafCalls;
    for (let i = 0; i < 10; i++) ctrl.requestScrollToBottom();
    expect(rafCalls).toBe(before);
    expect(pendingFrames()).toBe(1);
  });

  it("复查期间用户上滚 → 当场取消、之后一次都不再写", () => {
    const { ctrl, sc } = setupWithScroller({ top: 0 });
    ctrl.requestScrollToBottom();
    flushFrame(); // 贴了一次（写 2000）、复查帧已排
    expect(sc.writes).toEqual([2000]);

    sc.dispatch("wheel", { deltaY: -7.5 });
    sc.userScrollTo(1185); // 用户往回滚了 15px
    expect(ctrl.isFollowing()).toBe(false);
    expect(pendingFrames()).toBe(0);

    sc.grow(28);
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.writes).toEqual([2000]); // 没有第二次
    expect(sc.top()).toBe(1185); // 人还在他滚到的地方
  });

  it("回放「往回滚后内容继续增长」：上滚之后无论内容怎么长、贴底请求发多少次，控制器都不再写 scrollTop", () => {
    // 这就是用户实测的 bug 场景：贴底跟随中、流式每 80ms 长 28px，用户往回滚了一点。
    // 老实现靠 Virtuoso 的 scrollToIndex 贴底、它的重试链在内容增长时永不结束，
    // 上滚后仍每 ~100ms 一次 scrollTo 把人拉回——控制器自己贴底就不存在这条链
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("wheel", { deltaY: -7.5 });
    sc.userScrollTo(1185);
    expect(ctrl.isFollowing()).toBe(false);

    for (let i = 0; i < 40; i++) {
      sc.grow(28);
      ctrl.requestScrollToBottom();
      flushFrame();
    }
    expect(sc.writes).toEqual([]);
    expect(sc.top()).toBe(1185);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("控制器自己的程序化滚动触发的 scroll 事件不改变跟随态（没有意图、没有往下翻输入）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 0 });
    ctrl.setFollowing(true);
    ctrl.requestScrollToBottom();
    flushFrame();
    sc.dispatch("scroll"); // 浏览器异步派发的 scroll 事件
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("dispose：还没跑的帧被摘掉、不再写", () => {
    const { ctrl, sc } = setupWithScroller({ top: 0 });
    ctrl.requestScrollToBottom();
    ctrl.dispose();
    expect(pendingFrames()).toBe(0);
    flushFrame();
    expect(sc.writes).toEqual([]);
  });
});

// ---------- 手势接线 ----------

describe("停跟随：只认用户上滚", () => {
  it("滚轮上滚：手势只置意图，紧随其后的 scroll 事件里才停跟随（手势触发时几何还是旧的）", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: -7.5 });
    expect(ctrl.isFollowing()).toBe(true);
    sc.userScrollTo(1185);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("滚轮往下不是上滚意图", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: 40 });
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("上滚意图只被紧随的那一个 scroll 事件消费，后面没有意图的 scroll 不会再把它当上滚", () => {
    const { ctrl, sc } = setupWithScroller({ top: 500 }); // 离底 700、本来就不在贴底带
    ctrl.setFollowing(true);
    sc.dispatch("wheel", { deltaY: -40 });
    sc.userScrollTo(460); // 消费意图 → false
    expect(ctrl.isFollowing()).toBe(false);
    ctrl.setFollowing(true); // 假设别处重新开了闸
    sc.userScrollTo(470); // 无意图、也没往下翻输入 → 保持
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("键盘 ↑ / PageUp / Home 都是上滚意图", () => {
    for (const k of ["ArrowUp", "PageUp", "Home"]) {
      const { ctrl, sc } = setupWithScroller();
      sc.dispatch("keydown", key(k));
      sc.userScrollTo(1160);
      expect(ctrl.isFollowing(), k).toBe(false);
    }
  });

  it("可编辑元素里按 ↑ 是移动光标、不是翻历史", () => {
    for (const [tag, editable] of [
      ["TEXTAREA", false],
      ["INPUT", false],
      ["SELECT", false],
      ["DIV", true],
    ] as const) {
      const { ctrl, sc } = setupWithScroller();
      sc.dispatch("keydown", key("ArrowUp", tag, editable));
      sc.userScrollTo(1195); // 别的原因造成的小幅滚动
      expect(ctrl.isFollowing(), `${tag}/${editable}`).toBe(true);
    }
  });

  it("触摸：手指相对起点往下拖 > 2px = 在看更早的内容", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("touchstart", { touches: [{ clientY: 100 }] });
    sc.dispatch("touchmove", { touches: [{ clientY: 140 }] });
    sc.userScrollTo(1150);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("触摸：2px 以内的抖动不算", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("touchstart", { touches: [{ clientY: 100 }] });
    sc.dispatch("touchmove", { touches: [{ clientY: 102 }] });
    sc.userScrollTo(1195);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("拖原生滚动条：拖动期间每个 scroll 都按上滚意图算；松手后不再", () => {
    const { ctrl, sc } = setupWithScroller();
    // 滚动条槽不是子元素：命中时 target 就是容器本身、offsetX > clientWidth
    sc.dispatch("pointerdown", { target: sc.el, offsetX: 905 });
    sc.userScrollTo(900);
    expect(ctrl.isFollowing()).toBe(false);
    sc.userScrollTo(800); // 拖动中的后续 scroll 仍按意图算
    expect(ctrl.isFollowing()).toBe(false);

    // 松手（pointerup 挂在 window 上：拖到容器外松手也要能收尾）
    for (const fn of windowListeners.get("pointerup") ?? []) fn({});
    expect(countIn(windowListeners, "pointerup")).toBe(1);
  });

  it("点在内容上（不是滚动条槽）不算拖滚动条", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("pointerdown", { target: sc.el, offsetX: 400 });
    sc.dispatch("pointerdown", { target: {}, offsetX: 905 });
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });
});

describe("恢复跟随：只认用户往下翻 + 朝底部走 + 进贴底带", () => {
  /** 离开底部：起点 top=1000（离底 200） */
  const leave = () => {
    const ctx = setupWithScroller({ top: 1200 });
    ctx.sc.dispatch("wheel", { deltaY: -100 });
    ctx.sc.userScrollTo(1000);
    expect(ctx.ctrl.isFollowing()).toBe(false);
    return ctx;
  };

  it("用户往下滚回底部 → 恢复", () => {
    const { ctrl, sc } = leave();
    sc.dispatch("wheel", { deltaY: 100 });
    sc.userScrollTo(1100); // 离底 100：还没进带
    expect(ctrl.isFollowing()).toBe(false);
    sc.userScrollTo(1160); // 离底 40：进带、朝底部
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("没有往下翻输入、只有程序化推下去（Virtuoso 补偿 scrollBy +28）→ 不恢复", () => {
    const { ctrl, sc } = leave();
    sc.userScrollTo(1028);
    sc.userScrollTo(1170); // 就算被推进了贴底带
    sc.userScrollTo(1200);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("往下翻输入的有效期：恰好 TTL 内恢复，超过一毫秒就不认", () => {
    const inside = leave();
    inside.sc.dispatch("wheel", { deltaY: 100 });
    clock = DOWN_INTENT_TTL_MS;
    inside.sc.userScrollTo(1170);
    expect(inside.ctrl.isFollowing()).toBe(true);

    clock = 0; // 重新计时：往下翻输入发生在 t=0、到 TTL+1 才来 scroll
    const outside = leave();
    outside.sc.dispatch("wheel", { deltaY: 100 });
    clock = DOWN_INTENT_TTL_MS + 1;
    outside.sc.userScrollTo(1170);
    expect(outside.ctrl.isFollowing()).toBe(false);
  });

  it("键盘 ↓ / PageDown / End 都是往下翻输入", () => {
    for (const k of ["ArrowDown", "PageDown", "End"]) {
      clock = 0;
      const { ctrl, sc } = leave();
      sc.dispatch("keydown", key(k));
      sc.userScrollTo(1170);
      expect(ctrl.isFollowing(), k).toBe(true);
    }
  });

  it("可编辑元素里按 ↓ 不算往下翻", () => {
    const { ctrl, sc } = leave();
    sc.dispatch("keydown", key("ArrowDown", "TEXTAREA"));
    sc.userScrollTo(1170);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("触摸：手指往上拖 > 2px = 往最新内容去", () => {
    const { ctrl, sc } = leave();
    sc.dispatch("touchstart", { touches: [{ clientY: 300 }] });
    sc.dispatch("touchmove", { touches: [{ clientY: 250 }] });
    sc.userScrollTo(1170);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("点滚动条轨道翻页也算往下翻：松手后的动画帧能把人带回贴底", () => {
    const { ctrl, sc } = leave();
    sc.dispatch("pointerdown", { target: sc.el, offsetX: 905 });
    for (const fn of windowListeners.get("pointerup") ?? []) fn({});
    sc.userScrollTo(1170); // 松手后的动画帧：朝底部、进带
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("朝底部走才行：往下翻输入有效期内、但这一帧 scrollTop 没变大（往回滚 / 不动）→ 不恢复", () => {
    const { ctrl, sc } = leave();
    // 先滚到带内附近但还没恢复：用户往下翻输入已记下
    sc.dispatch("wheel", { deltaY: 100 });
    sc.userScrollTo(1100);
    sc.userScrollTo(1100); // 没动
    expect(ctrl.isFollowing()).toBe(false);
    sc.userScrollTo(1090); // 往回
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("每个 scroll 事件都要更新「上一次 scrollTop」基准：往下是相对上一帧而言的", () => {
    // 挂上时 top=350（贴底）→ 上滚到 300（离底 50、在带外）→ 往下滚 10px 到 310（离底 40、进带）
    const { ctrl, sc } = setupWithScroller({ top: 350, height: 1000, client: 650 });
    sc.dispatch("wheel", { deltaY: -50 });
    sc.userScrollTo(300);
    expect(ctrl.isFollowing()).toBe(false);
    sc.dispatch("wheel", { deltaY: 10 });
    sc.userScrollTo(310);
    // 相对上一帧（300）是 +10；若基准还停在挂上时的 350 就成了 -40、恢复不了
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("挂上滚动容器时就要记下当前 scrollTop：第一个 scroll 事件的方向是相对它而言的", () => {
    // 挂上时 top=530（离底 20、本来就在带内）、已停跟随；往下翻输入有效期内收到 top=520（往回 10px）
    const { ctrl, sc } = setupWithScroller({ top: 530, height: 1000, client: 450 });
    ctrl.setFollowing(false);
    sc.dispatch("wheel", { deltaY: 40 });
    sc.userScrollTo(520);
    // 相对挂上时的 530 是 -10 → 不恢复；若基准是 0 就成了 +520、被误判恢复
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("往下翻输入不会让「已经在跟随」的状态变化", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: 100 });
    sc.userScrollTo(1200);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("上滚意图和往下翻输入同时存在（同一帧）：以上滚为准", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: 100 });
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1195);
    expect(ctrl.isFollowing()).toBe(false);
  });
});

describe("回放：键盘 ↑ 的平滑滚动动画 + Virtuoso 补偿（用户实测的弹回序列）", () => {
  it("意图只被第一帧消费；后续动画帧、被推下去的帧一律不恢复", () => {
    const { ctrl, sc } = setupWithScroller({ top: 3722, height: 4522, client: 800 });
    sc.dispatch("keydown", key("ArrowUp"));
    // 浏览器把一次 ↑ 拆成十来帧、中途 Virtuoso 又把 scrollTop 往下推了 28
    const frames = [3720, 3716, 3710, 3730, 3723, 3744, 3745, 3748, 3750, 3778];
    for (const top of frames) {
      sc.userScrollTo(top);
      expect(ctrl.isFollowing(), `top=${top}`).toBe(false);
    }
  });
});

// ---------- 视口高度变化 ----------

describe("视口高度变化：补一次贴底（Virtuoso 自己那条路径被关了），受跟随态约束", () => {
  it("正在跟随、视口变矮 → 排一次贴底，把底部带回视口", () => {
    const { ctrl, sc } = setupWithScroller();
    const ro = FakeResizeObserver.instances[0];
    expect(ro?.observed).toBe(sc.el);
    expect(ctrl.isFollowing()).toBe(true);

    sc.resize(600); // composer 变高：视口少了 200、底部掉出视口
    ro?.fire();
    expect(pendingFrames()).toBe(1);
    flushFrame();
    expect(sc.writes).toEqual([2000]);
    expect(sc.top()).toBe(1400);
  });

  it("视口变高同样补（贴底态下底部不能被留白顶出去）", () => {
    const { sc } = setupWithScroller({ top: 1200, height: 2000, client: 800 });
    const ro = FakeResizeObserver.instances[0];
    sc.resize(900);
    ro?.fire();
    expect(pendingFrames()).toBe(1);
  });

  it("高度没变（observe 的首次回调 / 只是宽度在变）→ 不动", () => {
    setupWithScroller();
    const ro = FakeResizeObserver.instances[0];
    ro?.fire();
    ro?.fire();
    expect(pendingFrames()).toBe(0);
  });

  it("用户在翻历史（没在跟随）时视口变化不动他", () => {
    const { ctrl, sc } = setupWithScroller();
    ctrl.setFollowing(false);
    const ro = FakeResizeObserver.instances[0];
    sc.resize(600);
    ro?.fire();
    expect(pendingFrames()).toBe(0);
    expect(sc.writes).toEqual([]);
  });

  it("换滚动容器 / 卸载时断开旧的观察者、摘掉旧容器上的监听", () => {
    const { ctrl, sc } = setupWithScroller();
    const first = FakeResizeObserver.instances[0];
    expect(sc.listenerCount("scroll")).toBe(1);
    expect(sc.listenerCount("wheel")).toBe(1);
    expect(countIn(windowListeners, "pointerup")).toBe(1);

    const next = makeScroller(GEOM);
    ctrl.attachScroller(next.el as unknown as HTMLElement);
    expect(first?.disconnected).toBe(true);
    expect(sc.listenerCount("scroll")).toBe(0);
    expect(sc.listenerCount("wheel")).toBe(0);
    expect(next.listenerCount("scroll")).toBe(1);
    expect(countIn(windowListeners, "pointerup")).toBe(1); // 旧的摘了、新的挂上

    ctrl.dispose();
    expect(FakeResizeObserver.instances[1]?.disconnected).toBe(true);
    expect(next.listenerCount("scroll")).toBe(0);
    expect(next.listenerCount("keydown")).toBe(0);
    expect(countIn(windowListeners, "pointerup")).toBe(0);
  });

  it("同一个容器重复 attach 是空操作（Virtuoso 的 scrollerRef 每次渲染都会回调）", () => {
    const { ctrl, sc } = setupWithScroller();
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(sc.listenerCount("scroll")).toBe(1);
  });

  it("容器卸载（null）后事件不再改状态", () => {
    const { ctrl, sc } = setupWithScroller();
    ctrl.attachScroller(null);
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1000);
    expect(ctrl.isFollowing()).toBe(true);
  });
});

// ---------- 「回到最新」平滑滚动（2026-10-17「全是大动作」） ----------

describe("scrollToBottomSmooth：回到最新是一小段缓动、不是瞬移", () => {
  /** 离底 400px（总高 2000、视口 800、最大可滚 1200 → 停在 800）、已翻离底部 */
  const awayFromBottom = (over: Partial<ScrollerInit> = {}) => {
    const h = setupWithScroller({ top: 800, ...over });
    h.ctrl.setFollowing(false);
    return h;
  };

  /** 推进假时钟、跑一帧，并按浏览器行为派发这次程序化写入引发的 scroll 事件 */
  const stepFrame = (sc: FakeScroller, ms: number) => {
    clock += ms;
    flushFrame();
    sc.dispatch("scroll");
  };

  it("滑行期间跟随态保持 false（流式的贴底请求不跟它抢）、落地才开闸并交给贴底链", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    expect(ctrl.isFollowing()).toBe(false);
    // 点击当下不直接写 scrollTop（先排一帧起跑）
    expect(sc.writes).toEqual([]);
    expect(pendingFrames()).toBe(1);

    stepFrame(sc, 0); // 起跑帧 elapsed=0：写入起点
    stepFrame(sc, 100); // 中途
    expect(ctrl.isFollowing()).toBe(false);
    const mid = sc.top();
    expect(mid).toBeGreaterThan(800);
    expect(mid).toBeLessThan(1200);

    stepFrame(sc, 400); // 超过时长 → 落地
    expect(sc.top()).toBe(1200);
    expect(ctrl.isFollowing()).toBe(true);
    // 落地后交给贴底链再盯几帧（Virtuoso 测量完总高可能又变）
    expect(pendingFrames()).toBe(1);
  });

  it("逐帧单调往下走、不越过终点（easeOut：起步快、收尾慢）", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    const tops: number[] = [];
    for (let i = 0; i < 6; i++) {
      stepFrame(sc, 40);
      tops.push(sc.top());
    }
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]!).toBeGreaterThanOrEqual(tops[i - 1]!);
      expect(tops[i]!).toBeLessThanOrEqual(1200);
    }
    // easeOut：前 40ms 走的距离 > 最后一小段
    expect(tops[0]! - 800).toBeGreaterThan(tops[5]! - tops[4]!);
  });

  it("滑行自己写 scrollTop 引发的 scroll 回调不会把滑行杀掉（内部写态不取消滑行）", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    for (let i = 0; i < 20 && !ctrl.isFollowing(); i++) stepFrame(sc, 30);
    expect(sc.top()).toBe(1200);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("终点每帧重读：滑行期间流式内容还在长，落地时落在新的底部", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    stepFrame(sc, 0);
    stepFrame(sc, 80);
    sc.grow(300); // 总高 2300 → 最大可滚 1500
    stepFrame(sc, 400);
    expect(sc.top()).toBe(1500);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("滑行中用户往上滚 → 当场取消：之后的帧不再写 scrollTop、跟随态仍是 false", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    stepFrame(sc, 0);
    stepFrame(sc, 60);
    const before = sc.writes.length;
    sc.dispatch("wheel", { deltaY: -120 });
    expect(pendingFrames()).toBe(0);
    stepFrame(sc, 400);
    expect(sc.writes.length).toBe(before);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("滑行中用户按 ↑ / 触摸上拖 / 点滚动条，同样取消", () => {
    for (const act of [
      (sc: FakeScroller) => sc.dispatch("keydown", key("ArrowUp")),
      (sc: FakeScroller) => {
        sc.dispatch("touchstart", { touches: [{ clientY: 100 }] });
        sc.dispatch("touchmove", { touches: [{ clientY: 300 }] });
      },
      (sc: FakeScroller) =>
        sc.dispatch("pointerdown", { target: sc.el, offsetX: 950 }),
    ]) {
      queued = new Map();
      const { ctrl, sc } = awayFromBottom();
      ctrl.scrollToBottomSmooth();
      stepFrame(sc, 0);
      act(sc);
      expect(pendingFrames()).toBe(0);
      expect(ctrl.isFollowing()).toBe(false);
    }
  });

  it("滑行中任何对外的 setFollowing（点横幅 / 跳到某一项）都会取消滑行——否则会把人又滑回底部", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    stepFrame(sc, 0);
    const before = sc.writes.length;
    ctrl.setFollowing(false);
    expect(pendingFrames()).toBe(0);
    stepFrame(sc, 400);
    expect(sc.writes.length).toBe(before);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("离得太远（超过 3 个视口）不做滑行：直接开闸 + 贴底", () => {
    const { ctrl, sc } = setupWithScroller({ top: 0, height: 6000, client: 800 });
    ctrl.setFollowing(false);
    ctrl.scrollToBottomSmooth();
    expect(ctrl.isFollowing()).toBe(true);
    flushFrame();
    expect(sc.top()).toBe(5200);
  });

  it("本来就在贴底带内 / 已经在跟随：直接开闸，不起滑行", () => {
    const near = setupWithScroller({ top: 1180 });
    near.ctrl.setFollowing(false);
    near.ctrl.scrollToBottomSmooth();
    expect(near.ctrl.isFollowing()).toBe(true);

    const following = setupWithScroller({ top: 1200 });
    following.ctrl.scrollToBottomSmooth();
    expect(following.ctrl.isFollowing()).toBe(true);
    expect(following.sc.writes).toEqual([]);
  });

  it("「减少动态效果」：不做滑行，直接开闸 + 贴底", () => {
    const scrollToBottom = vi.fn();
    const ctrl = createStreamFollowController(
      { current: scrollToBottom },
      () => clock,
      () => true,
    );
    const sc = makeScroller({ ...GEOM, top: 800 });
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    ctrl.setFollowing(false);
    ctrl.scrollToBottomSmooth();
    expect(ctrl.isFollowing()).toBe(true);
    flushFrame();
    expect(sc.top()).toBe(1200);
  });

  it("没有滚动容器（单测 / Window 滚动）：退化成开闸 + 兜底贴底", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.setFollowing(false);
    ctrl.scrollToBottomSmooth();
    expect(ctrl.isFollowing()).toBe(true);
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("重复点击不叠滑行：新的一次取消旧的", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    ctrl.scrollToBottomSmooth();
    expect(pendingFrames()).toBe(1);
    for (let i = 0; i < 20 && !ctrl.isFollowing(); i++) stepFrame(sc, 30);
    expect(sc.top()).toBe(1200);
  });

  it("卸载（dispose）/ 换容器时取消滑行", () => {
    const { ctrl, sc } = awayFromBottom();
    ctrl.scrollToBottomSmooth();
    ctrl.dispose();
    expect(pendingFrames()).toBe(0);
    expect(sc.writes).toEqual([]);
  });
});

// ---------- 换容器（detach）：手势残留不带到新容器、跟随态保留 ----------

describe("换 / 摘滚动容器：手势态随旧容器清掉，跟随态不动", () => {
  const swapTo = (ctrl: ReturnType<typeof setup>["ctrl"], over: Partial<ScrollerInit> = {}) => {
    const next: FakeScroller = makeScroller({ ...GEOM, ...over });
    ctrl.attachScroller(next.el as unknown as HTMLElement);
    return next;
  };

  it("拖着滚动条时容器被换掉（没收到 pointerup）：新容器上无用户输入的程序化滚动不会被当成上滚", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("pointerdown", { target: sc.el, offsetX: 905 }); // 开始拖滚动条
    const next = swapTo(ctrl); // Virtuoso 重挂：旧容器上的 pointerup 永远不会来
    expect(ctrl.isFollowing()).toBe(true);
    next.userScrollTo(1190); // 程序化的小幅滚动（Virtuoso 补偿之类），没有任何用户输入
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("没过期的「往下翻」输入不会被新容器借去恢复跟随", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1000); // 用户上滚离开底部
    expect(ctrl.isFollowing()).toBe(false);
    sc.dispatch("wheel", { deltaY: 100 }); // 刚往下翻了一下（输入还在有效期内）
    const next = swapTo(ctrl, { top: 1100 });
    next.userScrollTo(1160); // 新容器上程序化地「朝底部、进了贴底带」
    expect(ctrl.isFollowing()).toBe(false); // 没有属于新容器的往下翻输入，不能恢复
  });

  it("未消费的上滚意图 / 触摸起点也不带过去", () => {
    const { ctrl, sc } = setupWithScroller({ top: 500 });
    ctrl.setFollowing(true);
    sc.dispatch("wheel", { deltaY: -40 }); // 置了上滚意图、scroll 事件还没来
    const next = swapTo(ctrl, { top: 500 });
    next.userScrollTo(460); // 新容器上的第一个 scroll 不该吃掉旧容器遗留的意图
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("跟随态是事件流级别的、不跟容器走：换 / 摘容器都不复位（切 task 的初始定位恢复在渲染期先写了它）", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1000);
    expect(ctrl.isFollowing()).toBe(false);
    swapTo(ctrl);
    expect(ctrl.isFollowing()).toBe(false);
    ctrl.attachScroller(null);
    expect(ctrl.isFollowing()).toBe(false);
    // 反过来：跟随中换容器也保持跟随
    ctrl.setFollowing(true);
    swapTo(ctrl);
    expect(ctrl.isFollowing()).toBe(true);
  });
});
