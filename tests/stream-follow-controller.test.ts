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

import {
  UP_INTENT_TTL_MS,
  createStreamFollowController,
} from "@/hooks/use-stream-follow";
import {
  DOWN_INTENT_TTL_MS,
  DRIFT_THRESHOLD_PX,
  MOUNT_SETTLE_MS,
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

  describe("外层不会滚的上滚滚轮不登记意图（评审 N1：残留意图被流式贴底写的 scroll 事件误当上滚、跟随被关）", () => {
    /** 贴底跟随中、流式长了一截 → 控制器贴底写 → 浏览器异步派发的 scroll 事件 */
    const streamAndPin = (ctx: ReturnType<typeof setupWithScroller>) => {
      ctx.sc.grow(28);
      ctx.ctrl.requestScrollToBottom();
      flushFrame();
      ctx.sc.dispatch("scroll");
    };
    const inner = (scrollTop: number, parent: unknown = null) => ({
      scrollTop,
      scrollHeight: 600,
      clientHeight: 200,
      parentElement: parent,
    });

    it("横向为主的滚轮（触控板左右滑，deltaY 带小负数）不关跟随", () => {
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("wheel", { deltaX: 40, deltaY: -3 });
      streamAndPin(ctx);
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });

    it("在内层可滚区（scrollTop>0）里上滚 → 被内层吃掉、外层跟随不受影响", () => {
      const ctx = setupWithScroller({ top: 1200 });
      // 目标 → 中间层（不可滚）→ 外层容器
      const mid = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, parentElement: ctx.sc.el };
      ctx.sc.dispatch("wheel", { deltaY: -40, target: inner(80, mid) });
      streamAndPin(ctx);
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });

    it("内层已在顶（scrollTop=0）→ 上滚会冒泡到外层，照常停跟随", () => {
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("wheel", { deltaY: -40, target: inner(0, ctx.sc.el) });
      ctx.sc.userScrollTo(1160);
      expect(ctx.ctrl.isFollowing()).toBe(false);
    });

    it("目标就是外层容器自己 → 照常停跟随", () => {
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("wheel", { deltaY: -40, target: ctx.sc.el });
      ctx.sc.userScrollTo(1160);
      expect(ctx.ctrl.isFollowing()).toBe(false);
    });

    it("被忽略的上滚不会顺手作废「往下翻」输入（它不是用户在外层的手势）", () => {
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("wheel", { deltaY: -100 });
      ctx.sc.userScrollTo(1000); // 先正常离开底部
      expect(ctx.ctrl.isFollowing()).toBe(false);
      ctx.sc.dispatch("wheel", { deltaY: 100 }); // 往下翻输入
      ctx.sc.dispatch("wheel", { deltaX: 50, deltaY: -2 }); // 横向小抖动：忽略
      ctx.sc.userScrollTo(1170); // 朝底部、进贴底带
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });

    it("用户在外层真上滚、同一帧 Virtuoso 补偿 +28 合并成净正 delta → 仍停跟随（不按 delta 方向丢意图）", () => {
      // 评审建议的「onScroll 里 delta>0 就丢意图」会在这里把真上滚吞掉、人被贴底拽回；所以只在源头排除
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("wheel", { deltaY: -7.5 });
      ctx.sc.userScrollTo(1200); // 用户 -7、补偿 +7 以上 → 同一帧的 scroll 事件净 delta ≥ 0
      expect(ctx.ctrl.isFollowing()).toBe(false);
    });
  });

  describe("触摸 / 键盘路径与滚轮同口径过滤（评审 R3：此前只有滚轮路径过滤、触摸 / 键盘仍会登记残留意图）", () => {
    const streamAndPin = (ctx: ReturnType<typeof setupWithScroller>) => {
      ctx.sc.grow(28);
      ctx.ctrl.requestScrollToBottom();
      flushFrame();
      ctx.sc.dispatch("scroll");
    };
    const innerScrollable = (scrollTop: number, parent: unknown) => ({
      scrollTop,
      scrollHeight: 600,
      clientHeight: 200,
      parentElement: parent,
      tagName: "DIV",
      isContentEditable: false,
    });

    it("触摸：手指落在内层可滚区（scrollTop>0）里下拖 → 被内层吃掉、跟随不受影响", () => {
      const ctx = setupWithScroller({ top: 1200 });
      const target = innerScrollable(80, ctx.sc.el);
      ctx.sc.dispatch("touchstart", { touches: [{ clientX: 50, clientY: 100 }], target });
      ctx.sc.dispatch("touchmove", { touches: [{ clientX: 50, clientY: 160 }], target });
      streamAndPin(ctx);
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });

    it("触摸：横向为主的滑动（左右滑代码块 / 表格）不关跟随", () => {
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("touchstart", { touches: [{ clientX: 50, clientY: 100 }] });
      ctx.sc.dispatch("touchmove", { touches: [{ clientX: 150, clientY: 106 }] });
      streamAndPin(ctx);
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });

    it("触摸：内层已在顶（scrollTop=0）→ 手势冒泡到外层，照常停跟随", () => {
      const ctx = setupWithScroller({ top: 1200 });
      const target = innerScrollable(0, ctx.sc.el);
      ctx.sc.dispatch("touchstart", { touches: [{ clientX: 50, clientY: 100 }], target });
      ctx.sc.dispatch("touchmove", { touches: [{ clientX: 50, clientY: 160 }], target });
      ctx.sc.userScrollTo(1150);
      expect(ctx.ctrl.isFollowing()).toBe(false);
    });

    it("触摸：被忽略的下拖不会作废「往下翻」输入", () => {
      const ctx = setupWithScroller({ top: 1200 });
      ctx.sc.dispatch("wheel", { deltaY: -100 });
      ctx.sc.userScrollTo(1000);
      expect(ctx.ctrl.isFollowing()).toBe(false);
      ctx.sc.dispatch("wheel", { deltaY: 100 }); // 往下翻输入
      const target = innerScrollable(80, ctx.sc.el);
      ctx.sc.dispatch("touchstart", { touches: [{ clientX: 50, clientY: 100 }], target });
      ctx.sc.dispatch("touchmove", { touches: [{ clientX: 50, clientY: 160 }], target }); // 内层吃掉：忽略
      ctx.sc.userScrollTo(1170);
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });

    it("键盘：焦点在内层可滚区（scrollTop>0）里按 ↑ / PageUp / Home → 内层消化、跟随不受影响", () => {
      for (const k of ["ArrowUp", "PageUp", "Home"]) {
        const ctx = setupWithScroller({ top: 1200 });
        ctx.sc.dispatch("keydown", { key: k, target: innerScrollable(80, ctx.sc.el) });
        streamAndPin(ctx);
        expect(ctx.ctrl.isFollowing(), k).toBe(true);
      }
    });

    it("键盘：内层已在顶 / 焦点在外层自身 → 照常停跟随", () => {
      for (const mk of [
        (el: unknown) => innerScrollable(0, el),
        (el: unknown) => el, // 目标就是外层容器
      ]) {
        const ctx = setupWithScroller({ top: 1200 });
        const target = mk(ctx.sc.el);
        ctx.sc.dispatch("keydown", { key: "ArrowUp", target });
        ctx.sc.userScrollTo(1160);
        expect(ctx.ctrl.isFollowing()).toBe(false);
      }
    });

    it("键盘：↓ / PageDown 不受影响（只过滤上滚方向）", () => {
      const ctx = setupWithScroller({ top: 1000 });
      ctx.ctrl.setFollowing(false);
      ctx.sc.dispatch("keydown", { key: "End", target: innerScrollable(80, ctx.sc.el) });
      ctx.sc.userScrollTo(1170); // 朝底部、进贴底带
      expect(ctx.ctrl.isFollowing()).toBe(true);
    });
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

  // V2-03（2026-10-20 第二轮 review）：`markUpIntent` 没清 `downIntentAt`，1s TTL 内「先下后上」
  // 之后，Virtuoso 向上补偿的 scrollBy(+28) 会借着残留的往下翻输入把跟随误恢复
  it("1s 内先往下翻再往上翻：上滚必须作废之前的往下翻输入，之后 Virtuoso 补偿 +28 不恢复跟随", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    // 1) 先上滚一点点离开底部（离底 20、上滚意图优先于几何）
    sc.dispatch("wheel", { deltaY: -50 });
    sc.userScrollTo(1180);
    expect(ctrl.isFollowing()).toBe(false);
    // 2) 往下翻一下（记下往下翻输入、t=0）
    sc.dispatch("wheel", { deltaY: 50 });
    // 3) 300ms 后又往上翻（仍在 1s TTL 内）：scroll 回调消费上滚意图
    clock = 300;
    sc.dispatch("wheel", { deltaY: -50 });
    sc.userScrollTo(1160);
    expect(ctrl.isFollowing()).toBe(false);
    // 4) Virtuoso 向上补偿 scrollBy(+28)：朝底部、进贴底带、但没有「新的」往下翻输入
    sc.userScrollTo(1188);
    expect(ctrl.isFollowing()).toBe(false);
    // 之后真正的往下翻输入照常能恢复（不能把恢复路径一起堵死）
    sc.dispatch("wheel", { deltaY: 50 });
    sc.userScrollTo(1200);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("同一批手势里先上滚、再往下翻：往下翻输入是后发生的，照常有效", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("wheel", { deltaY: -50 });
    sc.userScrollTo(1180);
    expect(ctrl.isFollowing()).toBe(false);
    clock = 100;
    sc.dispatch("wheel", { deltaY: 50 });
    sc.userScrollTo(1195);
    expect(ctrl.isFollowing()).toBe(true);
  });
});

// ---------- V2-02：上滚意图残留（2026-10-20 第二轮 review） ----------

describe("V2-02：上滚意图不能无限期残留（内容不足一屏时上滚一下 → 之后长出一屏不能被当成用户上滚）", () => {
  /** 内容不足一屏：总高 = 视口 = 800，不可滚 */
  const NOT_SCROLLABLE: Partial<ScrollerInit> = { top: 0, height: 800, client: 800 };

  /** 内容长出一屏后控制器第一次贴底：写 scrollTop → 浏览器异步派发一个没有任何用户输入的 scroll 事件 */
  const growThenPin = (sc: FakeScroller, ctrl: ReturnType<typeof setup>["ctrl"]) => {
    sc.grow(1200); // 总高 2000、最大可滚 1200
    ctrl.requestScrollToBottom();
    flushFrame();
    sc.dispatch("scroll");
  };

  it("不可滚时滚轮上滚：不登记意图 → 长出一屏后第一次贴底的 scroll 不会被当成用户上滚、跟随不关", () => {
    const { ctrl, sc } = setupWithScroller(NOT_SCROLLABLE);
    sc.dispatch("wheel", { deltaY: -100 }); // 没有可滚的内容 → 浏览器不会派发 scroll
    expect(ctrl.isFollowing()).toBe(true);
    growThenPin(sc, ctrl);
    expect(sc.writes).toEqual([2000]); // 控制器确实贴了底
    expect(sc.top()).toBe(1200);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("不可滚时键盘 ↑ / PageUp / Home、触摸下拖同样不登记意图", () => {
    const acts: Array<(sc: FakeScroller) => void> = [
      (sc) => sc.dispatch("keydown", key("ArrowUp")),
      (sc) => sc.dispatch("keydown", key("PageUp")),
      (sc) => sc.dispatch("keydown", key("Home")),
      (sc) => {
        sc.dispatch("touchstart", { touches: [{ clientY: 100 }] });
        sc.dispatch("touchmove", { touches: [{ clientY: 300 }] });
      },
    ];
    for (const act of acts) {
      queued = new Map();
      const { ctrl, sc } = setupWithScroller(NOT_SCROLLABLE);
      act(sc);
      growThenPin(sc, ctrl);
      expect(ctrl.isFollowing()).toBe(true);
    }
  });

  it("可滚但没有 scroll 事件的上滚（已经在最顶上再上滚）：意图过了 TTL 就作废，之后程序化滚动不关跟随", () => {
    // top=0 往上滚：浏览器不会派发 scroll；意图残留，直到控制器自己贴底写 scrollTop
    const { ctrl, sc } = setupWithScroller({ top: 0, height: 2000, client: 800 });
    sc.dispatch("wheel", { deltaY: -100 });
    clock = UP_INTENT_TTL_MS + 1;
    ctrl.requestScrollToBottom();
    flushFrame();
    sc.dispatch("scroll");
    expect(sc.writes).toEqual([2000]);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("TTL 之内的真实上滚仍然立刻停跟随（恰好 TTL 边界算有效）", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: -100 });
    clock = UP_INTENT_TTL_MS;
    sc.userScrollTo(1100);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("手势到 scroll 之间隔了超过 TTL → 不当成用户上滚（浏览器的 scroll 不会晚这么久，晚到的是别的来源）", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("wheel", { deltaY: -100 });
    clock = UP_INTENT_TTL_MS + 1;
    sc.userScrollTo(1100);
    // 离底 100 > 贴底带、也没有往下翻输入：状态机维持原值（跟随中）
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("不可滚时的上滚不会堵死后续真实上滚：长出一屏后用户真上滚照常停跟随", () => {
    const { ctrl, sc } = setupWithScroller(NOT_SCROLLABLE);
    sc.dispatch("wheel", { deltaY: -100 });
    growThenPin(sc, ctrl);
    expect(ctrl.isFollowing()).toBe(true);
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1100);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("拖原生滚动条不受上滚 TTL 影响：拖多久都按用户意图算", () => {
    const { ctrl, sc } = setupWithScroller();
    sc.dispatch("pointerdown", { target: sc.el, offsetX: 905 });
    clock = UP_INTENT_TTL_MS * 10;
    sc.userScrollTo(900);
    expect(ctrl.isFollowing()).toBe(false);
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

// ---------- 评审 K1：切回生成中的对话，落点停在半路、跟随态仍为 true、没有任何出口 ----------

describe("K1：进入对话后的定位稳定期（beginSettle）——贴底链按时间收口 + 漂移兜底", () => {
  /** 列表还没测量：scrollHeight == clientHeight（评审里 K1 的触发前提） */
  const UNMEASURED: Partial<ScrollerInit> = { top: 0, height: 800, client: 800 };

  it("没开稳定期时行为不变：连续 N 帧贴着就收工（回归保护）", () => {
    const { ctrl } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES; i++) flushFrame();
    expect(pendingFrames()).toBe(0);
  });

  it("稳定期内：「连续几帧贴着」不收工（列表没测量时 scrollHeight≈clientHeight 会假性稳定）", () => {
    const { ctrl } = setupWithScroller(UNMEASURED);
    ctrl.beginSettle();
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES + PIN_SETTLE_MAX_FRAMES; i++) {
      flushFrame();
      expect(pendingFrames()).toBe(1); // 链还活着：既不按稳定帧数收工、也不耗帧数预算
    }
  });

  it("稳定期内 Virtuoso 晚到的测量 / 落点：链还在盯、一量出高度就贴到真底部（K1 的核心场景）", () => {
    const { ctrl, sc } = setupWithScroller(UNMEASURED);
    ctrl.beginSettle();
    ctrl.requestScrollToBottom();
    for (let i = 0; i < 10; i++) flushFrame(); // 空转了好几帧（旧实现这里 3 帧就收工了）
    sc.grow(1200); // 终于测量完：总高 2000、最大可滚 1200
    flushFrame();
    expect(sc.writes).toEqual([2000]);
    expect(sc.top()).toBe(1200);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("稳定期一过：链按常规规则收工（不会永远空转）", () => {
    const { ctrl } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(pendingFrames()).toBe(1);
    clock = MOUNT_SETTLE_MS; // 恰好到点：now < settleUntil 不再成立
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES; i++) flushFrame();
    expect(pendingFrames()).toBe(0);
  });

  it("稳定期内用户上滚：跟随关、链当场停（稳定期不是「不让用户走」的借口）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    ctrl.requestScrollToBottom();
    flushFrame();
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1000);
    expect(ctrl.isFollowing()).toBe(false);
    expect(pendingFrames()).toBe(0);
    flushFrame();
    expect(sc.writes).toEqual([]); // 绝不再写 scrollTop
  });

  it("漂移兜底：稳定期内、跟随中、无上滚意图、没有链在跑、离底很远 → 重新请求贴底", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    // Virtuoso 的初始定位 / 重试落在半路（没有任何用户输入）
    sc.userScrollTo(1200 - DRIFT_THRESHOLD_PX - 400);
    expect(ctrl.isFollowing()).toBe(true);
    expect(pendingFrames()).toBe(1); // 已排了一条贴底链
    flushFrame();
    expect(sc.writes).toEqual([2000]);
    expect(sc.top()).toBe(1200);
  });

  it("漂移不超过阈值不兜底（亚像素 / 一两行正文的正常抖动）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    sc.userScrollTo(1200 - DRIFT_THRESHOLD_PX);
    expect(pendingFrames()).toBe(0);
    expect(ctrl.getAwaySnapshot()).toBe(false);
  });

  it("稳定期之外不做漂移兜底（选区拖拽 / 中键自动滚动这类没被识别成意图的滚动不该被空闲时拽回）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    clock = MOUNT_SETTLE_MS + 1;
    sc.userScrollTo(300);
    expect(ctrl.isFollowing()).toBe(true);
    expect(pendingFrames()).toBe(0);
    flushFrame();
    expect(sc.writes).toEqual([]);
  });

  it("从没开过稳定期（beginSettle 没调）：同样不兜底", () => {
    const { sc } = setupWithScroller({ top: 1200 });
    sc.userScrollTo(300);
    expect(pendingFrames()).toBe(0);
  });

  it("有上滚意图的 scroll 不兜底：稳定期内用户真上滚，跟随关、不被拽回", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(300);
    expect(ctrl.isFollowing()).toBe(false);
    expect(pendingFrames()).toBe(0);
  });

  it("已经有贴底链在跑时不重复排（漂移兜底只在「没有链在跑」时才请求）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    ctrl.requestScrollToBottom();
    expect(rafCalls).toBe(1);
    sc.userScrollTo(300); // 链正在跑：由它自己把人带回去
    expect(rafCalls).toBe(1);
  });

  it("滑行（回到最新）期间不触发漂移兜底（别和滑行抢方向盘）——靠的是不变量「滑行只在 following=false 时才起」", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.beginSettle();
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(700); // 用户上滚离开、跟随关
    expect(ctrl.isFollowing()).toBe(false);
    ctrl.scrollToBottomSmooth(); // 开始滑行
    expect(ctrl.isFollowing()).toBe(false); // 滑行期间跟随态保持 false：漂移兜底（要求 following=true）天然不成立
    const framesBefore = rafCalls;
    sc.userScrollTo(800); // 滑行自己写 scrollTop 引出的 scroll 事件
    expect(rafCalls).toBe(framesBefore);
    expect(ctrl.isFollowing()).toBe(false);
    // 反过来：following=true 时「回到最新」不起滑行、直接开闸 + 贴底（所以「跟随中且在滑行」这个状态不存在）
    ctrl.setFollowing(true);
    const before = rafCalls;
    ctrl.scrollToBottomSmooth();
    expect(rafCalls).toBe(before + 1); // 只排了一条贴底链、没有滑行帧
  });
});

describe("K1：stranded —— 跟随中却离底很远时「回到最新」要有出口（getAwaySnapshot）", () => {
  /** 稳定期之外、无意图的程序化滚动带偏 */
  const strand = (sc: FakeScroller) => sc.userScrollTo(300);

  it("默认不在 away 态；上滚离开（following=false）就是 away", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    expect(ctrl.getAwaySnapshot()).toBe(false);
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1000);
    expect(ctrl.getSnapshot()).toBe(false);
    expect(ctrl.getAwaySnapshot()).toBe(true);
  });

  it("跟随中、无意图、没有链在跑、离底超过阈值 → stranded：following 仍为 true，但 away=true、订阅者收到一次通知", async () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    const onChange = vi.fn();
    ctrl.subscribe(onChange);
    strand(sc);
    expect(ctrl.getSnapshot()).toBe(true); // 跟随态不动
    expect(ctrl.getAwaySnapshot()).toBe(true); // 但按钮要出来
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    // 同一状态下再来一个 scroll 不重复通知
    sc.userScrollTo(250);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("离底不超过阈值不算 stranded", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.userScrollTo(1200 - DRIFT_THRESHOLD_PX);
    expect(ctrl.getAwaySnapshot()).toBe(false);
  });

  it("贴底链在跑时不算 stranded（流式贴底的两帧间隙不闪按钮）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    ctrl.requestScrollToBottom();
    strand(sc);
    expect(ctrl.getAwaySnapshot()).toBe(false);
  });

  it("流式内容增高（没有 scroll 事件）不会把跟随中的用户判成 stranded", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.grow(900); // 距底 900，但没有 scroll 事件——贴底链会在下一帧把它带回去
    expect(ctrl.getAwaySnapshot()).toBe(false);
  });

  it("滚回底部 → stranded 自动解除", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    strand(sc);
    expect(ctrl.getAwaySnapshot()).toBe(true);
    sc.userScrollTo(1200);
    expect(ctrl.getAwaySnapshot()).toBe(false);
  });

  it("点「回到最新」（requestScrollToBottom 起链）立刻解除 stranded，不等 scroll 事件", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    strand(sc);
    expect(ctrl.getAwaySnapshot()).toBe(true);
    ctrl.scrollToBottomSmooth(); // following=true 时直接开闸 + 贴底
    expect(ctrl.getAwaySnapshot()).toBe(false);
    flushFrame();
    expect(sc.top()).toBe(1200);
  });

  it("换 / 摘滚动容器时 stranded 作废", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    strand(sc);
    expect(ctrl.getAwaySnapshot()).toBe(true);
    ctrl.attachScroller(null);
    expect(ctrl.getAwaySnapshot()).toBe(false);
  });
});

describe("K4：已经在最顶上再上滚不登记意图（滚不动、没有 scroll 事件来消费）", () => {
  it("scrollTop=0 时滚轮 / 键盘上滚不登记；之后控制器自己贴底引出的 scroll 不会被当成用户上滚", () => {
    const { ctrl, sc } = setupWithScroller({ top: 0, height: 2000, client: 800 });
    sc.dispatch("wheel", { deltaY: -100 });
    sc.dispatch("keydown", key("ArrowUp"));
    ctrl.requestScrollToBottom();
    flushFrame();
    sc.dispatch("scroll"); // 控制器自己写 scrollTop 引出的 scroll（立刻发生，远小于 TTL）
    expect(sc.writes).toEqual([2000]);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("不在最顶上时上滚照常登记（不影响真实上滚）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1100);
    expect(ctrl.isFollowing()).toBe(false);
  });
});

describe("K6：窗口从后台切回前台补一次贴底（visibilitychange）", () => {
  type DocListener = () => void;
  let docListeners: Map<string, Set<DocListener>>;
  let visibility: "visible" | "hidden";

  beforeEach(() => {
    docListeners = new Map();
    visibility = "visible";
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type: string, fn: DocListener) =>
        addTo(docListeners as unknown as Map<string, Set<Listener>>, type, fn),
      removeEventListener: (type: string, fn: DocListener) =>
        removeFrom(
          docListeners as unknown as Map<string, Set<Listener>>,
          type,
          fn,
        ),
    });
  });

  const fireVisibility = () => {
    for (const fn of [...(docListeners.get("visibilitychange") ?? [])]) fn();
  };

  it("挂上容器时注册、摘掉 / dispose 时注销", () => {
    const { ctrl } = setupWithScroller();
    expect(docListeners.get("visibilitychange")?.size).toBe(1);
    ctrl.attachScroller(null);
    expect(docListeners.get("visibilitychange")?.size ?? 0).toBe(0);
    const again = setupWithScroller();
    expect(docListeners.get("visibilitychange")?.size).toBe(1);
    again.ctrl.dispose();
    expect(docListeners.get("visibilitychange")?.size ?? 0).toBe(0);
  });

  it("可见 + 跟随中 → 排一次贴底", () => {
    const { sc } = setupWithScroller({ top: 600 });
    fireVisibility();
    expect(pendingFrames()).toBe(1);
    flushFrame();
    expect(sc.writes).toEqual([2000]);
  });

  it("切到后台（hidden）不动", () => {
    setupWithScroller({ top: 600 });
    visibility = "hidden";
    fireVisibility();
    expect(pendingFrames()).toBe(0);
  });

  it("用户在翻历史（following=false）切回前台：不动他", () => {
    const { ctrl } = setupWithScroller({ top: 600 });
    ctrl.setFollowing(false);
    fireVisibility();
    expect(pendingFrames()).toBe(0);
  });
});

describe("R1-7：拖选自动滚动 / 中键自动滚动 / Shift+空格也算用户上滚意图", () => {
  /** 正文里（不是滚动条槽）的 pointerdown */
  const bodyDown = (sc: FakeScroller, over: object = {}) =>
    sc.dispatch("pointerdown", {
      target: { tagName: "P" },
      button: 0,
      pointerType: "mouse",
      offsetX: 100,
      ...over,
    });
  const pointerUp = () => {
    for (const fn of windowListeners.get("pointerup") ?? []) fn({});
  };

  it("鼠标主键按在正文里拖选：浏览器自己朝上自动滚 → 当上滚、跟随关、不被贴底拽回", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    bodyDown(sc);
    sc.userScrollTo(1100); // 没有 wheel / key / touch，只有浏览器的拖选自动滚动
    expect(ctrl.isFollowing()).toBe(false);
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.writes).toEqual([]); // 绝不再写 scrollTop
  });

  it("拖选时朝下的 scroll 不算上滚（选中拖到底：不关跟随，也不会恢复，既定行为不变）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1000 });
    bodyDown(sc);
    sc.userScrollTo(1100);
    expect(ctrl.isFollowing()).toBe(true); // 本来就在跟随、朝下滚不关
  });

  it("松手（pointerup）后不再算：之后无输入的程序化上滚不关跟随", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    bodyDown(sc);
    pointerUp();
    sc.userScrollTo(1190); // Virtuoso 补偿之类
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("pointercancel / 窗口失焦同样收尾", () => {
    for (const evt of ["pointercancel", "blur"] as const) {
      windowListeners = new Map();
      const { ctrl, sc } = setupWithScroller({ top: 1200 });
      bodyDown(sc);
      for (const fn of windowListeners.get(evt) ?? []) fn({});
      sc.userScrollTo(1190);
      expect(ctrl.isFollowing()).toBe(true);
    }
  });

  it("触摸 / 笔的 pointerdown 不算（它们走 touch 事件那条路，意图位不该被 pointer 状态重复记）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    bodyDown(sc, { pointerType: "touch" });
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("中键按下 = 自动滚动会话开始：朝上的 scroll 当上滚；下一次任何按下结束会话", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    bodyDown(sc, { button: 1 });
    pointerUp(); // 中键松开不结束会话（Windows 点击式自动滚动：松手后仍在自动滚）
    sc.userScrollTo(1100);
    expect(ctrl.isFollowing()).toBe(false);

    // 回到底部恢复跟随（需要往下翻输入）后，再点一下 = 退出自动滚动
    sc.dispatch("wheel", { deltaY: 100 });
    sc.userScrollTo(1200);
    expect(ctrl.isFollowing()).toBe(true);
    bodyDown(sc, { button: 0 }); // 这次按下结束上一轮会话（同时开始一次拖选）
    pointerUp();
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("中键会话遇到窗口失焦也结束", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    bodyDown(sc, { button: 1 });
    for (const fn of windowListeners.get("blur") ?? []) fn({});
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("滚动条槽里的按下仍走原来的拖滚动条逻辑（不会同时记成拖选）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("pointerdown", {
      target: sc.el,
      offsetX: 905,
      button: 0,
      pointerType: "mouse",
    });
    pointerUp();
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true); // 松手后拖选标记也没残留
  });

  it("换 / 摘容器时 pointer 状态作废（旧容器上的 pointerup 永远不会来）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    bodyDown(sc);
    const next = makeScroller({ ...GEOM, top: 1200 });
    ctrl.attachScroller(next.el as unknown as HTMLElement);
    next.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("挂 / 摘 pointercancel、blur 监听：各一份、不泄漏", () => {
    const { ctrl } = setupWithScroller();
    expect(countIn(windowListeners, "pointercancel")).toBe(1);
    expect(countIn(windowListeners, "blur")).toBe(1);
    ctrl.attachScroller(null);
    expect(countIn(windowListeners, "pointercancel")).toBe(0);
    expect(countIn(windowListeners, "blur")).toBe(0);
  });

  it("Shift+空格 = 上翻意图（目标是普通元素）：跟随关", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("keydown", { ...key(" "), shiftKey: true });
    sc.userScrollTo(700);
    expect(ctrl.isFollowing()).toBe(false);
  });

  it("空格（无 Shift）= 往下翻输入：能让回到底部的 scroll 恢复跟随", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("wheel", { deltaY: -100 });
    sc.userScrollTo(1000);
    expect(ctrl.isFollowing()).toBe(false);
    sc.dispatch("keydown", { ...key(" "), shiftKey: false });
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("焦点在按钮上按 Shift+空格：那是激活、不滚动 → 不登记意图（否则之后流式贴底的 scroll 会被误当上滚）", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("keydown", {
      key: " ",
      shiftKey: true,
      target: { tagName: "BUTTON", isContentEditable: false },
    });
    sc.userScrollTo(1190); // 程序化小幅滚动，没有真实输入
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("role=button 的元素同理；输入框里的空格 / Shift+空格仍被可编辑元素过滤拦住", () => {
    const { ctrl, sc } = setupWithScroller({ top: 1200 });
    sc.dispatch("keydown", {
      key: " ",
      shiftKey: true,
      target: {
        tagName: "DIV",
        isContentEditable: false,
        getAttribute: (n: string) => (n === "role" ? "button" : null),
      },
    });
    sc.userScrollTo(1190);
    expect(ctrl.isFollowing()).toBe(true);
    sc.dispatch("keydown", { ...key(" ", "TEXTAREA"), shiftKey: true });
    sc.userScrollTo(1180);
    expect(ctrl.isFollowing()).toBe(true);
  });
});

describe("R1：稳定期从容器挂上起重新计时 / 贴底链预算耗尽补算 stranded", () => {
  it("稳定期是渲染期开的、容器晚挂：挂上那一刻重新计时（不会被渲染到挂载的耗时吃掉）", () => {
    const { ctrl } = setup();
    ctrl.beginSettle(); // 渲染期 latch
    clock = MOUNT_SETTLE_MS - 100; // 大对话首次渲染 + 挂载慢，稳定期只剩 100ms
    const sc = makeScroller({ top: 0, height: 800, client: 800 });
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    clock = MOUNT_SETTLE_MS + 500; // 旧实现这里早已过期
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES + 2; i++) {
      flushFrame();
      expect(pendingFrames()).toBe(1); // 仍在稳定期内：不按稳定帧数收工
    }
  });

  it("没开过稳定期时挂容器不会凭空开启", () => {
    const { ctrl } = setup();
    clock = 10;
    const sc = makeScroller({ ...GEOM });
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES; i++) flushFrame();
    expect(pendingFrames()).toBe(0);
  });

  it("已过期的稳定期不会因为换容器复活", () => {
    const { ctrl } = setup();
    ctrl.beginSettle();
    clock = MOUNT_SETTLE_MS + 1;
    const sc = makeScroller({ ...GEOM });
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_STABLE_FRAMES; i++) flushFrame();
    expect(pendingFrames()).toBe(0);
  });

  it("贴底链预算耗尽收工、人仍离底很远（没有 scroll 事件来重算）→ 补算 stranded，按钮有出口", () => {
    // 列表一直没测量完：写 scrollTop 被夹在 0（最大可滚位置 0），距底远大于阈值，但没有任何 scroll 事件
    const { ctrl, sc } = setupWithScroller({ top: 0, height: 2000, client: 800 });
    // 把容器改成「写不动」：scrollTop 写入被夹回 0（模拟 Virtuoso 还没把总高撑起来）
    sc.resize(800);
    Object.defineProperty(sc.el, "scrollTop", {
      get: () => 0,
      set: () => undefined,
      configurable: true,
    });
    expect(ctrl.getAwaySnapshot()).toBe(false);
    ctrl.requestScrollToBottom();
    for (let i = 0; i < PIN_SETTLE_MAX_FRAMES + 1; i++) flushFrame();
    expect(pendingFrames()).toBe(0); // 预算耗尽、链收工
    expect(ctrl.getSnapshot()).toBe(true); // 仍是跟随态
    expect(ctrl.getAwaySnapshot()).toBe(true); // 但离底很远、按钮要出来
  });
});

describe("K1 根治：首次落底由控制器接手（Virtuoso 不再传 initialTopMostItemIndex）", () => {
  // 背景：Virtuoso 的初始定位走 scrollToIndex 重试链，没有取消接口、会把用户上滚拽回底部（无头 Chrome 实测，
  // 栈里抓到 react-virtuoso 自己的 scrollTo）。现在「进入对话落到最后一条」= 渲染期 latch 开跟随 + beginSettle，
  // 容器一挂上控制器就在稳定期内起贴底链（直接写 scrollTop、可取消）。
  const FRESH: ScrollerInit = { top: 0, height: 2000, client: 800 };

  it("稳定期内挂上容器（跟随中）：当帧就排了贴底、下一帧写到底——不依赖 items 变化的 effect 先到", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.beginSettle(); // 渲染期 latch
    const sc = makeScroller(FRESH);
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    expect(pendingFrames()).toBe(1);
    flushFrame();
    expect(sc.writes).toEqual([2000]);
    expect(sc.top()).toBe(1200); // 被夹到最大可滚位置 = 真底
    // 不走 Virtuoso 的 scrollToIndex 兜底（那是没有容器时才用的）
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("首次落底的链在稳定期内按时间收口：列表之后增高（测量 / 流式快照项）会被继续贴住", () => {
    const { ctrl } = setup();
    ctrl.beginSettle();
    const sc = makeScroller(FRESH);
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    flushFrame(); // 落底
    // Virtuoso 测量完后总高变了 3 倍：稳定期内链仍活着、下一帧补贴
    sc.grow(4000);
    clock = 300;
    flushFrame();
    expect(sc.top()).toBe(sc.el.scrollHeight - sc.el.clientHeight);
    expect(pendingFrames()).toBe(1); // 稳定期内不按稳定帧数收工
  });

  it("没开过稳定期 / 稳定期已过期 / 已不在跟随：挂容器不会自己起贴底（不凭空落底、不拽翻历史的人）", () => {
    // 没开过
    const a = setup();
    const scA = makeScroller(FRESH);
    a.ctrl.attachScroller(scA.el as unknown as HTMLElement);
    expect(pendingFrames()).toBe(0);
    expect(scA.writes).toEqual([]);
    // 已过期
    const b = setup();
    b.ctrl.beginSettle();
    clock = MOUNT_SETTLE_MS + 1;
    const scB = makeScroller(FRESH);
    b.ctrl.attachScroller(scB.el as unknown as HTMLElement);
    expect(pendingFrames()).toBe(0);
    expect(scB.writes).toEqual([]);
    // 稳定期内但用户已经不跟随
    clock = 0;
    const c = setup();
    c.ctrl.beginSettle();
    c.ctrl.setFollowing(false);
    const scC = makeScroller(FRESH);
    c.ctrl.attachScroller(scC.el as unknown as HTMLElement);
    expect(pendingFrames()).toBe(0);
    expect(scC.writes).toEqual([]);
  });

  it("首次落底之后用户上滚：跟随当场关、链当场停、之后无论列表怎么长都不再写 scrollTop（不会被拉回）", () => {
    const { ctrl } = setup();
    ctrl.beginSettle();
    const sc = makeScroller(FRESH);
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    flushFrame(); // 落底：top 1200
    const writesAtLeave = sc.writes.length;
    // 切回后 150ms 内上滚 250px（Virtuoso 重试链曾在这一刻之后把位置拽回）
    clock = 150;
    sc.dispatch("wheel", { deltaY: -250 });
    sc.userScrollTo(950);
    expect(ctrl.isFollowing()).toBe(false);
    expect(pendingFrames()).toBe(0);
    // 稳定期还没过、列表继续增高（流式快照项 +6000）：控制器一次都不再写
    sc.grow(6000);
    for (let i = 0; i < 30; i++) {
      clock += 16;
      ctrl.requestScrollToBottom(); // 即便 items effect / totalListHeightChanged 一直在请求
      flushFrame();
    }
    expect(sc.writes.length).toBe(writesAtLeave);
    expect(sc.top()).toBe(950);
  });

  it("上滚后再滚回底部：恢复跟随，之后的增高继续被贴住（场景 ⑤）", () => {
    const { ctrl } = setup();
    ctrl.beginSettle();
    const sc = makeScroller(FRESH);
    ctrl.attachScroller(sc.el as unknown as HTMLElement);
    flushFrame();
    clock = 150;
    sc.dispatch("wheel", { deltaY: -250 });
    sc.userScrollTo(950);
    expect(ctrl.isFollowing()).toBe(false);
    clock = 2000; // 稳定期之外
    sc.dispatch("wheel", { deltaY: 400 });
    sc.userScrollTo(1190); // 离底 10：进带、朝底部
    expect(ctrl.isFollowing()).toBe(true);
    sc.grow(500);
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.top()).toBe(sc.el.scrollHeight - sc.el.clientHeight);
  });
});
