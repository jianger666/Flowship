/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-30：`browser_mouse` 按住鼠标键之后，不能让 `mouseReleased`（会结束按住的拖放，文字可能被拖进去）落在密码 / 验证码框或无法检查的 iframe 上。
 *
 * 一轮复审：按住状态下再发 click、`releaseHeld`（ask_user_to_act / 用户接管 / 任务取消 / 动作出错）、空闲 120s / 导航提交后的 stale 补发，
 *   三条路径曾在「最后位置」派发 release 而不探 → 持键时 click 也过落点探针；补发 release 前复核最后位置，不安全改在按下起点释放。
 * 二轮复审：用「鼠标自己的轨迹」判断要不要探（粘性 `dragged`）——补了 wheel / 回起点 / 第二键等路径；click 之后清按下态；探针放到 `withAiInput` 之外、整体限时 3s。
 * 三轮复审（本文件现在的口径，**不再靠鼠标轨迹猜落点**）：
 *   A. `up`（任何键）与补发 release 一律先探落点，去掉所有「原地 / ≤ 4px / 回到起点」豁免——`browser_scroll` / `press_key` / 页面脚本都能在没有任何 mouse 动作的
 *      情况下让起点下面换成密码框（`dragged` 之类的轨迹标记本质上不完整，已删除）；
 *   B. 所有会派发鼠标点击的路径（`mouseClickAt`：click / type 的点击兜底 / fill_form …；`drag`；upload 点按钮）在 tab 还有没放的键时先拒（BAD_ARGS），
 *      `browser_mouse` 自己的 click 传 `keepHeld` 跳过；
 *   C. 补发 release 的计划为 null（最后位置与起点都不安全 / 确认不了）时不再「什么都不发、只清状态」，而是**保留按下态**（`pending`）并让 B 继续拦住后续点击，
 *      直到 `browser_mouse` 在探过的安全位置 `up`；
 *   D. 并发的两次 `releaseHeldButtons` 只发一套 release（先清态再探）。
 *
 * 真 ops/input.mjs 的 mouse handler + 真 actions.assertPointNotSecret / mouseClickAt + 脚本化假 CDP（vm 真跑页内探针）。
 * 每条用例都断言「真的没有 mouseReleased / click 发到敏感落点的坐标」，而不只是看抛错。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import { HELD_BUTTON_TTL_MS, createHandlers, mouseNeedsDropProbe, peekHeldButtons } from "../electron-app/browser/ops/input.mjs";
import { HELD_BUTTON_CLICK_MESSAGE, SECRET_DROP_MESSAGE, UNKNOWN_DROP_MESSAGE, heldButtonBitsOf } from "../electron-app/browser/secret-field.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { PLAIN, PW, closedRoot, docOf, hostWith, makeCdpTab, readableFrame } from "./helpers/browser-r6b-fake-dom";

afterEach(() => vi.useRealTimers());

/** 补发 release 前复核落点的整体时限（与 ops/input.mjs 的 RELEASE_PROBE_TIMEOUT_MS 同值） */
const RELEASE_DEADLINE_MS = 3000;

type El = Record<string, any>;

// 版面：(500,500) password；(700,700) 同站 iframe（落点探针一律 unknown）；(800,100) closed root 里的 password；其余普通输入框
const ORIGIN = { x: 100, y: 100 };
const PWPT = { x: 500, y: 500 };
const FRAMEPT = { x: 700, y: 700 };
const CLOSEDPT = { x: 800, y: 100 };
const SAFEPT = { x: 300, y: 300 };
const hit = (x: number, y: number): El => {
  if (x === PWPT.x && y === PWPT.y) return PW();
  if (x === FRAMEPT.x && y === FRAMEPT.y) return readableFrame(PLAIN());
  if (x === CLOSEDPT.x && y === CLOSEDPT.y) return hostWith(closedRoot({ at: PW() }));
  return PLAIN();
};

const makeHarness = (opts: { noProbe?: boolean; hit?: (x: number, y: number) => El; realClick?: boolean } = {}) => {
  const tab: any = makeCdpTab(docOf(null, opts.hit ?? hit));
  const events: any[] = [];
  /** 真 `actions.mouseClickAt`（opts.realClick）经 `tab.send` 发出去的 Input.dispatchMouseEvent 参数 */
  const cdpMouse: any[] = [];
  const rawSend = tab.send;
  tab.send = (m: string, p: any, ...rest: any[]) => {
    if (m === "Input.dispatchMouseEvent") cdpMouse.push(p);
    return rawSend(m, p, ...rest);
  };
  const hooks: { check?: () => void } = {};
  // 记录「withAiInput 窗口里」派发了哪些输入事件、以及探针是不是在窗口里发的（R6-30 二轮复审③）
  let insideAiInput = false;
  const inputLog: Array<{ type: string; inside: boolean }> = [];
  Object.assign(tab, {
    ensureCdp: async () => {},
    layoutMetrics: async () => ({ viewportW: 1000, viewportH: 800 }),
    setAI: async () => {},
    withAiInput: async (fn: () => Promise<unknown>) => {
      insideAiInput = true;
      try {
        return await fn();
      } finally {
        insideAiInput = false;
      }
    },
    navCommitted: 0,
  });
  const I: any = {
    // noProbe：模拟依赖没接上（v1Internals 里没有 assertPointNotSecret）——复核函数必须 fail-closed，不能因为「没有探针」就当安全
    assertPointNotSecret: opts.noProbe ? undefined : actions.assertPointNotSecret,
    aiScope: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
    beforeState: () => ({}),
    actionResult: () => ({ tabId: "t1", url: "https://a.test/", title: "A", navigated: false }),
    showAction: async () => {},
    mouse: async (_t: unknown, p: any) => {
      events.push(p);
      inputLog.push({ type: p.type, inside: insideAiInput });
    },
    // 默认假点击（记成一个 click 事件，带上传进来的选项）；realClick：走真 actions.mouseClickAt（含 B 的守卫），事件落在 cdpMouse
    mouseClickAt: opts.realClick ? actions.v1Internals.mouseClickAt : async (_t: unknown, pt: any, o: any) => void events.push({ type: "click", ...pt, ...o }),
    settle: async () => {},
  };
  const session = { runAction: async (_o: unknown, fn: (ctx: any) => Promise<unknown>) => fn({ tab, signal: undefined, check: () => hooks.check?.(), describe: () => {} }) };
  const handlers = createHandlers({ actions: { v1Internals: I, modifierBits: actions.modifierBits }, requireSession: () => session } as any);
  const call = (a: Record<string, unknown>) => handlers.mouse("t", { button: "left", ...a } as any);
  /** 在 (x, y) 处派发的「落东西」类事件（release / press / click）——敏感落点上这个列表必须为空 */
  const landedAt = (pt: { x: number; y: number }) => events.filter((e) => ["mouseReleased", "mousePressed", "click"].includes(e.type) && e.x === pt.x && e.y === pt.y);
  const releases = () => events.filter((e) => e.type === "mouseReleased");
  const evaluates = () => tab.calls.filter((m: string) => m === "Runtime.evaluate").length;
  /** 左键在起点按下，再 move 到 pt（拖离起点） */
  const dragTo = async (pt: { x: number; y: number }) => {
    await call({ action: "down", ...ORIGIN });
    await call({ action: "move", ...pt });
  };
  /** 其它工具（click / type / fill_form 的点击兜底）用的真点击入口 */
  const toolClick = (pt: { x: number; y: number }) => actions.v1Internals.mouseClickAt(tab, pt);
  return { tab, events, hooks, call, landedAt, releases, evaluates, dragTo, inputLog, cdpMouse, toolClick, inside: () => insideAiInput };
};

type Harness = ReturnType<typeof makeHarness>;
const releasedAt = (h: Harness, pt: { x: number; y: number }) => h.events.filter((e) => e.type === "mouseReleased" && e.x === pt.x && e.y === pt.y);
/** 页面里按下过的键位掩码（直接读按下态，不看过期） */
const heldBits = (h: Harness) => h.tab.heldButtonBits();

/** 版面同上，但「布局变化」之后 ORIGIN 下面变成密码框（滚动 / 异步内容 / 页面脚本重排）；shift() 之前一切照旧——shift 不经过任何 mouse 动作 */
const shiftable = () => {
  let shifted = false;
  return {
    hit: (x: number, y: number): El => (shifted && x === ORIGIN.x && y === ORIGIN.y ? PW() : hit(x, y)),
    shift: () => {
      shifted = true;
    },
  };
};

// ───────────────────────── 纯函数 ─────────────────────────

describe("R6-30 mouseNeedsDropProbe（纯函数）", () => {
  const A = (action: string, button = "left", x = 500, y = 500) => ({ action, button, x, y });

  it("up：任何键、任何位置、有没有对应的按下态都探（三轮复审 A：没有「原地 / ≤4px / 回到起点」豁免）", () => {
    for (const held of [null, { bits: 0 }, { bits: 1 }, { bits: 2 }, { bits: 7 }]) {
      for (const button of ["left", "right", "middle"]) {
        for (const [x, y] of [
          [100, 100],
          [101, 100],
          [104, 100],
          [105, 100],
          [900, 700],
        ]) {
          expect(mouseNeedsDropProbe(A("up", button, x, y), held), `${button} ${x},${y} ${JSON.stringify(held)}`).toBe(true);
        }
      }
    }
  });

  it("键按着时的 click / double_click（任意键）→ 探；没按着 / bits=0 → 不探（点密码框本身仍允许）", () => {
    for (const act of ["click", "double_click"]) {
      expect(mouseNeedsDropProbe(A(act), { bits: 1 }), act).toBe(true);
      expect(mouseNeedsDropProbe(A(act, "right"), { bits: 1 }), `${act} right`).toBe(true);
      expect(mouseNeedsDropProbe(A(act), null), `${act} 无按下态`).toBe(false);
      expect(mouseNeedsDropProbe(A(act), { bits: 0 }), `${act} bits=0`).toBe(false);
    }
  });

  it("move / wheel / 左右键 down 不探（持键时也不探）；中键的 down / click / double_click 永远探", () => {
    for (const act of ["move", "wheel"]) {
      expect(mouseNeedsDropProbe(A(act), { bits: 1 }), act).toBe(false);
      expect(mouseNeedsDropProbe(A(act, "middle"), null), `${act} middle`).toBe(false);
    }
    for (const button of ["left", "right"]) {
      expect(mouseNeedsDropProbe(A("down", button), { bits: 1 }), `down ${button}`).toBe(false);
      expect(mouseNeedsDropProbe(A("down", button), null), `down ${button} 无按下态`).toBe(false);
    }
    for (const act of ["down", "click", "double_click"]) expect(mouseNeedsDropProbe(A(act, "middle"), null), `${act} middle`).toBe(true);
  });
});

describe("R6-30 三轮复审 B：heldButtonBitsOf / HELD_BUTTON_CLICK_MESSAGE（纯函数）", () => {
  it("没挂 heldButtonBits（从没按过）→ 0；挂了就读它；读取抛错 / 返回非数字 → 1（fail-closed）", () => {
    expect(heldButtonBitsOf({})).toBe(0);
    expect(heldButtonBitsOf(null)).toBe(0);
    expect(heldButtonBitsOf({ heldButtonBits: () => 0 })).toBe(0);
    expect(heldButtonBitsOf({ heldButtonBits: () => 5 })).toBe(5);
    expect(heldButtonBitsOf({ heldButtonBits: () => Number.NaN })).toBe(1);
    expect(heldButtonBitsOf({ heldButtonBits: () => "1" })).toBe(1);
    expect(
      heldButtonBitsOf({
        heldButtonBits: () => {
          throw new Error("boom");
        },
      }),
    ).toBe(1);
  });

  it("文案可自修复：说明为什么拒、让 AI 先用 browser_mouse 在安全位置 action=up", () => {
    expect(HELD_BUTTON_CLICK_MESSAGE).toContain("按下状态");
    expect(HELD_BUTTON_CLICK_MESSAGE).toContain("结束按住的拖放");
    expect(HELD_BUTTON_CLICK_MESSAGE).toContain("browser_mouse");
    expect(HELD_BUTTON_CLICK_MESSAGE).toContain("action=up");
  });
});

// ───────────────────────── 按住期间的 click ─────────────────────────

describe("R6-30 复审①：按住期间 click 到敏感落点被拒，且没有任何事件落在该坐标", () => {
  it("down(普通处) → move(密码框) → click(密码框)：BAD_ARGS（SECRET_DROP_MESSAGE），密码框坐标上没有 click / mouseReleased；按下态保留", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    await expect(h.call({ action: "click", ...PWPT })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.releases()).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("double_click、右键 click 同样被拒；iframe 落点 → UNKNOWN_DROP_MESSAGE；closed root 里的 password → SECRET", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    await expect(h.call({ action: "double_click", ...PWPT })).rejects.toMatchObject({ message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    await expect(h.call({ action: "click", ...PWPT, button: "right" })).rejects.toMatchObject({ message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    await expect(h.call({ action: "click", ...FRAMEPT })).rejects.toMatchObject({ message: expect.stringContaining(UNKNOWN_DROP_MESSAGE) });
    await expect(h.call({ action: "click", ...CLOSEDPT })).rejects.toMatchObject({ message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    for (const pt of [PWPT, FRAMEPT, CLOSEDPT]) expect(h.landedAt(pt), JSON.stringify(pt)).toEqual([]);
    expect(h.releases()).toEqual([]);
  });

  it("拒绝文案说明「此时点击会在落点结束按住的拖放」并给出自修复路径（先在安全位置 up）", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    const err: any = await h.call({ action: "click", ...PWPT }).then(() => null, (e: unknown) => e);
    expect(String(err.message)).toContain("结束按住的拖放");
    expect(String(err.message)).toContain("action=up");
  });

  it("自修复：被拒后换到普通落点 up，成功并清掉按下态；之后再 click 密码框本身（不再按着）放行", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    await expect(h.call({ action: "click", ...PWPT })).rejects.toBeInstanceOf(BrowserError);
    await h.call({ action: "up", ...SAFEPT });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    await h.call({ action: "click", ...PWPT });
    expect(h.landedAt(PWPT).filter((e) => e.type === "click")).toHaveLength(1);
  });

  it("对照（不误伤）：按住期间 click 普通框放行；没按住时 click / double_click 密码框本身放行", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    await h.call({ action: "click", ...SAFEPT });
    expect(h.landedAt(SAFEPT).filter((e) => e.type === "click")).toHaveLength(1);

    const h2 = makeHarness();
    await h2.call({ action: "click", ...PWPT });
    await h2.call({ action: "double_click", ...PWPT });
    expect(h2.landedAt(PWPT).filter((e) => e.type === "click")).toHaveLength(2);
  });
});

// ───────────────────────── releaseHeldButtons（接管 / 取消 / ask_user_to_act） ─────────────────────────

describe("R6-30 复审②：releaseHeldButtons（ask_user_to_act / 接管 / 取消）不在敏感落点释放", () => {
  const origin = (e: any) => e.x === ORIGIN.x && e.y === ORIGIN.y;

  it.each([
    ["password 框", PWPT],
    ["同站 iframe（探针 unknown）", FRAMEPT],
    ["closed root 里的 password", CLOSEDPT],
  ] as const)("按住后 move 到%s，再 releaseHeldButtons：密码框坐标上没有 mouseReleased；改在按下起点释放（先把指针挪回起点），状态清空", async (_n, pt) => {
    const h = makeHarness();
    await h.dragTo(pt);
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.landedAt(pt)).toEqual([]);
    expect(h.events.some((e) => e.type === "mouseMoved" && e.x === pt.x && e.y === pt.y)).toBe(false); // 收尾阶段也没有再往敏感点挪
    const rel = h.releases();
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ x: ORIGIN.x, y: ORIGIN.y, button: "left", buttons: 0 });
    const moveIdx = h.events.findIndex((e) => e.type === "mouseMoved" && origin(e));
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(moveIdx).toBeLessThan(h.events.indexOf(rel[0])); // 先挪回起点，再释放
    expect(h.events[moveIdx]).toMatchObject({ button: "left", buttons: 1 });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("探针本身失败（CDP 断了）：最后位置当 unknown、起点也确认不了 → 一个 release 都不发，**按下态保留（pending）**而不是清掉", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.tab.send = async () => {
      throw new Error("cdp down");
    };
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.events).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("探针依赖缺失（v1Internals 没有 assertPointNotSecret）：fail-closed——最后位置、起点都当「确认不了」，不发 release、保留按下态，而不是因为「没有探针」就放行", async () => {
    const h = makeHarness({ noProbe: true });
    await h.dragTo(SAFEPT); // 最后位置其实是普通框，但没有探针就无从确认
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.landedAt(SAFEPT)).toEqual([]);
    expect(h.events).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("探针用短超时（别让卡死的页面拖住取消 / 接管收尾）", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    const seen: Array<number | undefined> = [];
    const origSend = h.tab.send;
    h.tab.send = (method: string, params: any, sid: any, timeoutMs?: number) => {
      if (method === "Runtime.evaluate") seen.push(timeoutMs);
      return origSend(method, params, sid, timeoutMs);
    };
    await h.tab.releaseHeldButtons();
    expect(seen.length).toBeGreaterThan(0);
    for (const t of seen) expect(t).toBeLessThanOrEqual(5000);
  });

  it("对照（不误伤）：最后位置安全 → 照旧在最后位置释放，不挪回起点，状态清空", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[SAFEPT.x, SAFEPT.y]]);
    expect(h.events.filter((e) => e.type === "mouseMoved")).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("原地按住（没离开起点、也没滚动）也要探——不再有「原地不探」的豁免（三轮复审 A）", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    const before = h.evaluates();
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.evaluates()).toBeGreaterThan(before); // 真的探了
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[ORIGIN.x, ORIGIN.y]]);
  });

  it("多键按下：两个键都在起点逐键释放（buttons 逐步减少），一个都不落在敏感点", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "move", ...PWPT });
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.releases().map((e) => [e.button, e.buttons, e.x, e.y])).toEqual([
      ["left", 2, ORIGIN.x, ORIGIN.y],
      ["right", 0, ORIGIN.x, ORIGIN.y],
    ]);
  });
});

describe("R6-30 三轮复审：多键按住时，一个键 up 之后「最后位置」更新为那次 up 的落点", () => {
  it("左右键都按在起点，右键在 SAFEPT up（探过、安全）→ 之后 releaseHeldButtons 把左键释放在 SAFEPT，而不是起点", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "up", ...SAFEPT, button: "right" });
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.releases().map((e) => [e.button, e.x, e.y])).toEqual([["left", SAFEPT.x, SAFEPT.y]]);
  });
});

describe("R6-30 复审②：动作被取消 / 接管打断时的收尾释放（runMouse catch）", () => {
  it("按住并 move 到密码框后，下一个 mouse 动作被取消（CANCELLED）：收尾 release 不落在密码框，落在起点", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.events.length = 0;
    h.hooks.check = () => {
      throw new BrowserError("CANCELLED", "任务已被取消");
    };
    await expect(h.call({ action: "move", ...SAFEPT })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[ORIGIN.x, ORIGIN.y]]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("USER_TOOK_OVER 同理", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.events.length = 0;
    h.hooks.check = () => {
      throw new BrowserError("USER_TOOK_OVER", "用户接管");
    };
    await expect(h.call({ action: "wheel", ...SAFEPT, deltaY: 40 })).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[ORIGIN.x, ORIGIN.y]]);
  });

  it("起点也被换成密码框：取消时一个 release 都不发，按下态保留（pending）", async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.dragTo(PWPT);
    s.shift();
    h.events.length = 0;
    h.hooks.check = () => {
      throw new BrowserError("CANCELLED", "任务已被取消");
    };
    await expect(h.call({ action: "move", ...SAFEPT })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.releases()).toEqual([]);
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });
});

describe("R6-30 复审③：空闲 120s / 导航提交后的 stale 补发同样不落在敏感点", () => {
  it("按住后 move 到密码框，空闲超过 TTL，下一次 mouse 动作先补发 release：密码框坐标上没有 mouseReleased，落在起点", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const h = makeHarness();
    await h.dragTo(PWPT);
    vi.setSystemTime(1_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    expect(peekHeldButtons(h.tab).bits).toBe(0); // 已过期
    h.events.length = 0;
    await h.call({ action: "move", ...SAFEPT });
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[ORIGIN.x, ORIGIN.y]]);
    // 这次 move 自己是「没按着」的 move（不带 buttons）
    expect(h.events.at(-1)).toMatchObject({ type: "mouseMoved", buttons: 0, button: "none" });
  });

  it("导航提交后（navCommitted 变化）按下态过期：stale 补发同样不在密码框坐标释放", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.tab.navCommitted = 1;
    h.events.length = 0;
    await h.call({ action: "move", ...SAFEPT });
    expect(h.landedAt(PWPT)).toEqual([]);
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[ORIGIN.x, ORIGIN.y]]);
  });

  it("对照：stale 时最后位置安全 → 照旧在最后位置补发（旧行为不变）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    vi.setSystemTime(2_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    h.events.length = 0;
    await h.call({ action: "move", x: 200, y: 200 });
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[SAFEPT.x, SAFEPT.y]]);
  });
});

// ───────────────────────── 三轮复审 A：up / 补发 release 一律探落点 ─────────────────────────

describe("R6-30 三轮复审 A①：不经过任何 mouse 动作就让落点下的元素变了（browser_scroll / press_key / 页面脚本）", () => {
  it("down(O) → 布局变化使 O 下面变成密码框 → up(O)：被拒（SECRET），O 没有 mouseReleased，按下态保留", async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.call({ action: "down", ...ORIGIN });
    s.shift(); // 没有 move / wheel——等价 browser_scroll / PageDown / evaluate scrollTo / 异步内容
    await expect(h.call({ action: "up", ...ORIGIN })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(releasedAt(h, ORIGIN)).toEqual([]);
    expect(h.releases()).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("同样的布局变化 + 用户接管 / 取消（releaseHeldButtons）：最后位置与起点都是密码框 → 一个 release 都不发，按下态保留（pending）", async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.call({ action: "down", ...ORIGIN });
    s.shift();
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.events).toEqual([]);
    expect(releasedAt(h, ORIGIN)).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("阈值：down(497,500) → move(501,500)（位移恰为 4px）→ up(501,500)，密码框在 x≥500：被拒（不再有 4px 豁免）", async () => {
    const h = makeHarness({ hit: (x, y) => (x >= 500 && y === 500 ? PW() : PLAIN()) });
    await h.call({ action: "down", x: 497, y: 500 });
    await h.call({ action: "move", x: 501, y: 500 });
    await expect(h.call({ action: "up", x: 501, y: 500 })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(releasedAt(h, { x: 501, y: 500 })).toEqual([]);
  });

  it("down(O) → move 远离 → wheel（密码框被滚到 O 下）→ move 回 O → up(O)：被拒", async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "move", ...SAFEPT });
    await h.call({ action: "wheel", ...SAFEPT, deltaY: 300 });
    s.shift();
    await h.call({ action: "move", ...ORIGIN });
    await expect(h.call({ action: "up", ...ORIGIN })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(h.releases()).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("两个键按住：右键在远处 up（探过、安全）之后，起点下面换成密码框，左键回起点 up：仍被拒", async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "up", ...SAFEPT, button: "right" });
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    s.shift();
    await expect(h.call({ action: "up", ...ORIGIN })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(releasedAt(h, ORIGIN)).toEqual([]);
  });
});

describe("R6-30 三轮复审 A②：原地 down→up 也要探（代价：点密码框请用 browser_click）", () => {
  it("原地 down→up 点普通框：放行，而且真的探了（evaluate 次数增加）", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...SAFEPT });
    const before = h.evaluates();
    await h.call({ action: "up", ...SAFEPT });
    expect(h.evaluates()).toBeGreaterThan(before);
    expect(releasedAt(h, SAFEPT)).toHaveLength(1);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("原地 down→up 点密码框：被拒，按下态保留；换到安全位置 up 收尾；之后 browser_mouse click 密码框本身（没按住）仍放行", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...PWPT });
    await expect(h.call({ action: "up", ...PWPT })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(releasedAt(h, PWPT)).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    await h.call({ action: "up", ...SAFEPT });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    await h.call({ action: "click", ...PWPT });
    expect(h.landedAt(PWPT).filter((e) => e.type === "click")).toHaveLength(1);
  });

  it("没有对应 down 的孤立 up 落在密码框：拒；拖拽排序（拖到普通框 up）放行；move / wheel 仍不探", async () => {
    const h = makeHarness();
    await expect(h.call({ action: "up", ...PWPT })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(h.events).toEqual([]);

    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "move", ...SAFEPT });
    await h.call({ action: "up", ...SAFEPT });
    expect(h.releases()).toHaveLength(1);
    expect(peekHeldButtons(h.tab).bits).toBe(0);

    const before = h.evaluates();
    await h.call({ action: "move", ...PWPT });
    await h.call({ action: "wheel", ...PWPT, deltaY: 10 });
    expect(h.evaluates()).toBe(before);
  });
});

// ───────────────────────── 三轮复审 B：其它点击路径在按着键时先拒 ─────────────────────────

describe("R6-30 三轮复审 B：browser_click / type 点击兜底 / fill_form 等经 mouseClickAt 的点击，在 tab 还有没放的键时先拒", () => {
  it("browser_mouse down → move → 其它工具点击密码框：BAD_ARGS（HELD_BUTTON_CLICK_MESSAGE），一个 Input.dispatchMouseEvent 都不发", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.cdpMouse.length = 0;
    await expect(h.toolClick(PWPT)).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(h.cdpMouse).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1); // 守卫只拒，不动按下态
  });

  it("点击落点是普通处也一样拒（不是落点问题，是「按着键时点击会结束按住的拖放」）", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    await expect(h.toolClick(SAFEPT)).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(h.cdpMouse).toEqual([]);
  });

  it("按下后什么都没 move（原地按着）也拒", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await expect(h.toolClick(ORIGIN)).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(h.cdpMouse).toEqual([]);
  });

  it("空闲超过 120s（陈旧按下态、还没被补发 release）也算按着：仍然拒", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(4_000_000);
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    vi.setSystemTime(4_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    expect(peekHeldButtons(h.tab).bits).toBe(0); // peek 视为过期
    await expect(h.toolClick(PWPT)).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(h.cdpMouse).toEqual([]);
  });

  it("自修复：browser_mouse 在安全位置 up 之后，同一个点击放行，并真的发出 press / release", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    await expect(h.toolClick(PWPT)).rejects.toBeInstanceOf(BrowserError);
    await h.call({ action: "up", ...SAFEPT });
    await h.toolClick(PWPT);
    expect(h.cdpMouse.map((e) => e.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(h.cdpMouse.every((e) => e.x === PWPT.x && e.y === PWPT.y)).toBe(true);
  });

  it("对照（不误伤）：从没按过 / 按过又放开 / 补发释放后，点击都放行", async () => {
    const h0 = makeHarness();
    await h0.toolClick(PWPT); // 没挂过 heldButtonBits
    expect(h0.cdpMouse.map((e) => e.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);

    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "up", ...ORIGIN });
    await h.toolClick(PWPT);
    expect(h.cdpMouse.filter((e) => e.type === "mousePressed")).toHaveLength(1);

    const h2 = makeHarness();
    await h2.dragTo(SAFEPT);
    await h2.tab.releaseHeldButtons(); // 最后位置安全 → 正常释放并清态
    h2.cdpMouse.length = 0;
    await h2.toolClick(PWPT);
    expect(h2.cdpMouse.filter((e) => e.type === "mousePressed")).toHaveLength(1);
  });

  it("browser_mouse 自己的 click 不受守卫影响（keepHeld）：按着左键再右键 click 放行；按下态只清右键", async () => {
    const h = makeHarness({ realClick: true });
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "move", ...SAFEPT });
    h.cdpMouse.length = 0;
    await h.call({ action: "click", ...SAFEPT, button: "right" }); // 真 mouseClickAt：没传 keepHeld 会被守卫拒
    expect(h.cdpMouse.map((e) => [e.type, e.button])).toEqual([
      ["mouseMoved", "none"],
      ["mousePressed", "right"],
      ["mouseReleased", "right"],
    ]);
    expect(peekHeldButtons(h.tab).bits).toBe(1); // 左键仍按着
  });

  it("假点击入口收到的选项里 keepHeld 为 true（browser_mouse click 显式豁免）", async () => {
    const h = makeHarness();
    await h.call({ action: "click", ...SAFEPT });
    expect(h.events.find((e) => e.type === "click")).toMatchObject({ keepHeld: true });
  });
});

// ───────────────────────── 三轮复审 C：计划为 null 时保留按下态 ─────────────────────────

describe("R6-30 三轮复审 C：补发 release 的计划为 null（最后位置与起点都不安全 / 确认不了）→ 不发事件、保留按下态，后续点击仍被拦", () => {
  const stuck = async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.dragTo(PWPT);
    s.shift(); // 起点也变成密码框
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    return { s, h };
  };

  it("takeover / ask_user_to_act 之后：没有任何事件、按下态还在；其它工具的点击被拒（不会把推迟的释放补在敏感点）", async () => {
    const { h } = await stuck();
    expect(h.events).toEqual([]);
    expect(heldBits(h)).toBe(1);
    await expect(h.toolClick(ORIGIN)).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    await expect(h.toolClick(PWPT)).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(h.cdpMouse).toEqual([]);
  });

  it("出路 1：browser_mouse 在探过的安全位置 up，收尾并清态；之后点击放行", async () => {
    const { h } = await stuck();
    await h.call({ action: "up", ...SAFEPT });
    expect(releasedAt(h, SAFEPT)).toHaveLength(1);
    expect(heldBits(h)).toBe(0);
    await h.toolClick(SAFEPT);
    expect(h.cdpMouse.filter((e) => e.type === "mousePressed")).toHaveLength(1);
  });

  it("出路 1b：up 落在不安全的地方仍被拒，按下态继续保留", async () => {
    const { h } = await stuck();
    await expect(h.call({ action: "up", ...ORIGIN })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(h.releases()).toEqual([]);
    expect(heldBits(h)).toBe(1);
  });

  it("出路 2：再来一次 takeover / 取消，页面已恢复（落点不再是密码框）→ 这次能在最后位置正常释放并清态", async () => {
    let recovered = false;
    const h = makeHarness({ hit: (x, y) => (!recovered && x === ORIGIN.x && y === ORIGIN.y ? PW() : hit(x, y)) });
    await h.dragTo(PWPT);
    await h.tab.releaseHeldButtons(); // 最后位置 PWPT 不安全，起点 ORIGIN 也不安全 → 保留
    expect(heldBits(h)).toBe(1);
    recovered = true;
    h.events.length = 0;
    await h.tab.releaseHeldButtons(); // 起点恢复安全 → 回起点释放
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[ORIGIN.x, ORIGIN.y]]);
    expect(heldBits(h)).toBe(0);
  });

  it("保留下来的状态不会因为 stale 而反复触发补发：过期后的下一次 mouse 动作先试一次，仍不安全就刷新 at / nav 保留，不再算过期", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(5_000_000);
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.dragTo(PWPT);
    s.shift();
    vi.setSystemTime(5_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    h.events.length = 0;
    await h.call({ action: "move", ...SAFEPT }); // 先 stale 补发 → 不安全 → 保留；这次 move 随后带着保留的按下态
    expect(h.releases()).toEqual([]);
    expect(peekHeldButtons(h.tab)).toMatchObject({ bits: 1, stale: null }); // 已刷新，不是 stale
    // 最后位置现在是 SAFEPT：下一次 takeover 就能在那里正常释放
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.releases().map((e) => [e.x, e.y])).toEqual([[SAFEPT.x, SAFEPT.y]]);
    expect(heldBits(h)).toBe(0);
  });

  it("并发的新 down 不会被收尾的「保留」覆盖", async () => {
    const s = shiftable();
    const h = makeHarness({ hit: s.hit });
    await h.dragTo(PWPT);
    s.shift();
    // 用闸门把收尾的探针卡住，保证「新 down 先于收尾结束」这个时序是确定的，而不是靠微任务排队碰运气
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const orig = h.tab.send;
    h.tab.send = async (m: string, p: any, s2: any, t?: number) => {
      if (m === "Runtime.evaluate") await gate;
      return orig(m, p, s2, t);
    };
    const p = h.tab.releaseHeldButtons(); // 探针期间状态已被清掉
    await h.call({ action: "down", ...SAFEPT, button: "right" }); // 新的按下态（右键）
    expect(peekHeldButtons(h.tab).bits).toBe(2);
    open();
    await p; // 收尾发现两处都不安全 → 本来要保留旧的左键状态，但已有新的按下态，不能覆盖它
    expect(peekHeldButtons(h.tab).bits).toBe(2); // 只有新的右键，没有被旧状态（左键）覆盖
  });
});

describe("R6-30 三轮复审 D：并发的 releaseHeldButtons 只发一套 release", () => {
  it("两次并发调用（探针是异步的）：只有一套 mouseReleased，不会重复释放", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    h.events.length = 0;
    await Promise.all([h.tab.releaseHeldButtons(), h.tab.releaseHeldButtons()]);
    expect(h.releases()).toHaveLength(1);
    expect(heldBits(h)).toBe(0);
  });

  it("多键按下时同理：每个键各释放一次", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "move", ...SAFEPT });
    h.events.length = 0;
    await Promise.all([h.tab.releaseHeldButtons(), h.tab.releaseHeldButtons(), h.tab.releaseHeldButtons()]);
    expect(h.releases().map((e) => e.button)).toEqual(["left", "right"]);
  });
});

// ───────────────────────── click 清按下态 ─────────────────────────

describe("R6-30 二轮复审②：按住后 click 会结束同一个键的按下态", () => {
  it("down(O) → move(安全) → click(安全)：按下态清空；之后的 move 不再带 buttons:1", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    await h.call({ action: "click", ...SAFEPT });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    h.events.length = 0;
    await h.call({ action: "move", ...SAFEPT });
    expect(h.events.at(-1)).toMatchObject({ type: "mouseMoved", buttons: 0, button: "none" });
  });

  it("别的键仍按着：左键 click 只清左键 bit，右键按下态保留", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "move", ...SAFEPT });
    await h.call({ action: "click", ...SAFEPT, button: "left" });
    expect(peekHeldButtons(h.tab).bits).toBe(2);
  });

  it("没有按住时 click：按下态本来就空，保持为空（不影响既有行为）", async () => {
    const h = makeHarness();
    await h.call({ action: "click", ...PWPT });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });
});

// ───────────────────────── withAiInput 之外 + 整体限时 ─────────────────────────

describe("R6-30 二轮复审③：释放探针在 withAiInput 之外、整体限时", () => {
  it("探针（Runtime.evaluate）在 withAiInput 窗口之外发出；release 事件在窗口之内派发", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    const seen: boolean[] = [];
    const orig = h.tab.send;
    h.tab.send = (m: string, p: any, s: any, t?: number) => {
      if (m === "Runtime.evaluate") seen.push(h.inside());
      return orig(m, p, s, t);
    };
    h.inputLog.length = 0;
    await h.tab.releaseHeldButtons();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((inside) => inside === false)).toBe(true);
    const out = h.inputLog.filter((e) => e.type === "mouseReleased" || e.type === "mouseMoved");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.inside)).toBe(true);
  });

  it("stale 补发（空闲超时后的下一次 mouse 动作）同样：探针不在窗口里", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(3_000_000);
    const h = makeHarness();
    await h.dragTo(PWPT);
    vi.setSystemTime(3_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    const seen: boolean[] = [];
    const orig = h.tab.send;
    h.tab.send = (m: string, p: any, s: any, t?: number) => {
      if (m === "Runtime.evaluate" && p?.expression?.includes("DROP_TARGET_SECRET_PROBE")) seen.push(h.inside());
      return orig(m, p, s, t);
    };
    await h.call({ action: "move", ...SAFEPT });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((inside) => inside === false)).toBe(true);
  });

  it("探针完全不返回（页面卡死）：3s 后放弃，一个 release 都不发，按下态保留（pending），收尾不挂", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.tab.send = () => new Promise(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.events.length = 0;
    const p = h.tab.releaseHeldButtons();
    await vi.advanceTimersByTimeAsync(RELEASE_DEADLINE_MS + 100);
    await p;
    expect(h.events).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("只有第一条 CDP 命令正常、后续命令挂起（timeoutMs 只限第一条）：整体限时仍在 3s 兜底，不发 release，按下态保留", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    const orig = h.tab.send;
    let first = true;
    h.tab.send = (m: string, p: any, s: any, t?: number) => {
      if (m === "Runtime.evaluate" && first) {
        first = false;
        return orig(m, p, s, t);
      }
      return new Promise(() => {});
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.events.length = 0;
    const p = h.tab.releaseHeldButtons();
    await vi.advanceTimersByTimeAsync(RELEASE_DEADLINE_MS + 100);
    await p;
    expect(h.events).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });
});
