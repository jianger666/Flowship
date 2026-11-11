/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-30：`browser_mouse` 按住鼠标键之后的按下态与补发 release（ops/input.mjs）。
 *
 * 产品决策：不再限制 AI 往密码 / 验证码 / 银行卡类输入框里落点。原先围着「按住 → 落点探针」搭起来的整套机制已删除，本文件相应的用例也已删除：
 *   落点探针（SECRET_DROP / UNKNOWN_DROP）、补发前复核并改在按下起点释放、`pending` 保留按下态、持键时拒绝其它工具的点击
 *   （HELD_BUTTON_CLICK_MESSAGE / `heldButtonBits` / `keepHeld`）、`mouseNeedsDropProbe`、release 探针的 3s 限时。
 *
 * 现行口径（本文件钉住的）：
 *   A. 按下态 `pressedState` 只存 { bits, x, y, at, nav }；按住期间的 move / wheel / 其它键的 click 续期并更新「最后位置」；tab 上不再挂 `heldButtonBits`；
 *   B. 补发 release——`tab.releaseHeldButtons`（用户接管 / ask_user_to_act / 任务取消）、动作被取消 / 派发后出错、空闲 120s / 导航提交后的 stale——
 *      一律在**最后位置**按 left → right → middle 的顺序逐键 `mouseReleased`，`buttons` 为剩余位掩码；先清态再发（并发只发一套），
 *      不探落点、不改起点、不保留按下态；最后位置恰好是密码框 / iframe / closed root 也照常释放；
 *   C. 按着键时，browser_click / type 的点击兜底 / fill_form 等其它点击路径照常执行；
 *   D. release 在 `withAiInput` 窗口里派发（归因给 AI）；派发失败一律吞掉。
 *
 * 真 ops/input.mjs 的 mouse handler + 脚本化假 CDP。假 DOM 里放着密码框 / iframe / closed root，只用来证明「落在这些点上也照常发、且没有任何探针调用」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import { HELD_BUTTON_TTL_MS, createHandlers, peekHeldButtons } from "../electron-app/browser/ops/input.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { PLAIN, PW, closedRoot, docOf, hostWith, makeCdpTab, readableFrame } from "./helpers/browser-r6b-fake-dom";

afterEach(() => vi.useRealTimers());

type El = Record<string, any>;

// 版面：(500,500) password；(700,700) 同站 iframe；(800,100) closed root 里的 password；其余普通输入框
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
/** 落点参数表：普通输入框作基线，其余是以前会被探针拦下的位置——现在都要照常放行 */
const TARGETS = [
  ["普通输入框", SAFEPT],
  ["密码框", PWPT],
  ["同站 iframe", FRAMEPT],
  ["closed root 里的密码框", CLOSEDPT],
] as const;

const makeHarness = (opts: { realClick?: boolean } = {}) => {
  const tab: any = makeCdpTab(docOf(null, hit));
  const events: any[] = [];
  /** 真 `actions.mouseClickAt`（其它工具的点击路径 / realClick）经 `tab.send` 发出去的 Input.dispatchMouseEvent 参数 */
  const cdpMouse: any[] = [];
  const rawSend = tab.send;
  tab.send = (m: string, p: any, ...rest: any[]) => {
    if (m === "Input.dispatchMouseEvent") cdpMouse.push(p);
    return rawSend(m, p, ...rest);
  };
  /** check：模拟取消 / 接管 / 出错；releaseGate：把 mouseReleased 卡住（模拟「release 还在飞」）；failRelease：release 派发抛错 */
  const hooks: { check?: () => void; releaseGate?: Promise<void>; failRelease?: boolean } = {};
  // 记录「withAiInput 窗口里」派发了哪些输入事件（用计数而不是布尔：并发时窗口会重叠）
  let aiDepth = 0;
  const inputLog: Array<{ type: string; inside: boolean }> = [];
  Object.assign(tab, {
    ensureCdp: async () => {},
    layoutMetrics: async () => ({ viewportW: 1000, viewportH: 800 }),
    setAI: async () => {},
    withAiInput: async (fn: () => Promise<unknown>) => {
      aiDepth++;
      try {
        return await fn();
      } finally {
        aiDepth--;
      }
    },
    navCommitted: 0,
  });
  const I: any = {
    aiScope: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
    beforeState: () => ({}),
    actionResult: () => ({ tabId: "t1", url: "https://a.test/", title: "A", navigated: false }),
    showAction: async () => {},
    mouse: async (_t: unknown, p: any) => {
      if (p.type === "mouseReleased") await hooks.releaseGate;
      events.push(p);
      inputLog.push({ type: p.type, inside: aiDepth > 0 });
      if (p.type === "mouseReleased" && hooks.failRelease) throw new Error("cdp down");
    },
    // 默认假点击（记成一个 click 事件，带上传进来的选项）；realClick：走真 actions.mouseClickAt，事件落在 cdpMouse
    mouseClickAt: opts.realClick ? actions.v1Internals.mouseClickAt : async (_t: unknown, pt: any, o: any) => void events.push({ type: "click", ...pt, ...o }),
    settle: async () => {},
  };
  const session = { runAction: async (_o: unknown, fn: (ctx: any) => Promise<unknown>) => fn({ tab, signal: undefined, check: () => hooks.check?.(), describe: () => {} }) };
  const handlers = createHandlers({ actions: { v1Internals: I, modifierBits: actions.modifierBits }, requireSession: () => session } as any);
  const call = (a: Record<string, unknown>) => handlers.mouse("t", { button: "left", ...a } as any);
  /** 在 (x, y) 处派发的「落东西」类事件（release / press / click） */
  const landedAt = (pt: { x: number; y: number }) => events.filter((e) => ["mouseReleased", "mousePressed", "click"].includes(e.type) && e.x === pt.x && e.y === pt.y);
  const releases = () => events.filter((e) => e.type === "mouseReleased");
  /** 除了输入事件本身，tab 上发出过的 CDP 调用（Runtime.evaluate / DOM.* 之类的落点探针）——现在必须一直是空的 */
  const probeCalls = () => tab.calls.filter((m: string) => m !== "Input.dispatchMouseEvent");
  /** 左键在起点按下，再 move 到 pt（拖离起点） */
  const dragTo = async (pt: { x: number; y: number }) => {
    await call({ action: "down", ...ORIGIN });
    await call({ action: "move", ...pt });
  };
  /** 其它工具（click / type / fill_form 的点击兜底）用的真点击入口 */
  const toolClick = (pt: { x: number; y: number }) => actions.v1Internals.mouseClickAt(tab, pt);
  return { tab, events, hooks, call, landedAt, releases, probeCalls, dragTo, inputLog, cdpMouse, toolClick };
};

type Harness = ReturnType<typeof makeHarness>;

/** 把之后的 mouseReleased 卡在闸门上（保证「第一套 release 还在飞」这个时序是确定的，而不是靠微任务排队碰运气），返回放行函数 */
const holdReleases = (h: Harness) => {
  let open!: () => void;
  h.hooks.releaseGate = new Promise<void>((r) => (open = r));
  return open;
};

// ───────────────────────── 按下态：down / move / wheel / up ─────────────────────────

describe("R6-30 按下态：down / move / wheel / up", () => {
  it("down：先 mouseMoved 再 mousePressed（buttons 含该键）并登记按下态；按住期间的 move / wheel 带着 buttons；tab 上不再挂 heldButtonBits", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    expect(h.events.map((e) => e.type)).toEqual(["mouseMoved", "mousePressed"]);
    expect(h.events[0]).toMatchObject({ ...ORIGIN, button: "none", buttons: 0 });
    expect(h.events[1]).toMatchObject({ ...ORIGIN, button: "left", buttons: 1 });
    expect(peekHeldButtons(h.tab)).toMatchObject({ bits: 1, stale: null });
    expect(h.tab.heldButtonBits).toBeUndefined();
    expect(typeof h.tab.releaseHeldButtons).toBe("function"); // 接管 / 取消的释放入口还在

    h.events.length = 0;
    await h.call({ action: "move", ...SAFEPT });
    expect(h.events).toEqual([expect.objectContaining({ type: "mouseMoved", ...SAFEPT, button: "left", buttons: 1 })]);
    h.events.length = 0;
    await h.call({ action: "wheel", ...SAFEPT, deltaY: 40 });
    expect(h.events.map((e) => e.type)).toEqual(["mouseMoved", "mouseWheel"]);
    expect(h.events[0]).toMatchObject({ buttons: 1 });
  });

  it.each(TARGETS)("拖拽：down(起点) → move → up(%s)：release 就落在 up 的坐标，buttons 0，按下态清空，没有任何探针", async (_n, pt) => {
    const h = makeHarness();
    await h.dragTo(pt);
    await h.call({ action: "up", ...pt });
    expect(h.releases()).toEqual([expect.objectContaining({ ...pt, button: "left", buttons: 0 })]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    expect(h.probeCalls()).toEqual([]);
  });

  it("原地 down → up 点密码框：mousePressed / mouseReleased 各一次，照常放行，按下态清空", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...PWPT });
    await h.call({ action: "up", ...PWPT });
    expect(h.landedAt(PWPT).map((e) => e.type)).toEqual(["mousePressed", "mouseReleased"]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    expect(h.probeCalls()).toEqual([]);
  });

  it("没有对应 down 的孤立 up（即便落在密码框）：照常派发一个 mouseReleased（buttons 0），不报错、不留按下态", async () => {
    const h = makeHarness();
    await h.call({ action: "up", ...PWPT });
    expect(h.events).toEqual([expect.objectContaining({ type: "mouseReleased", ...PWPT, button: "left", buttons: 0 })]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("多键按住：一个键 up 之后 buttons 掩码只剩另一个键，「最后位置」更新为那次 up 的落点——之后 releaseHeldButtons 把剩下的键释放在那里，而不是起点", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "up", ...SAFEPT, button: "right" });
    expect(h.releases()).toEqual([expect.objectContaining({ ...SAFEPT, button: "right", buttons: 1 })]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.releases().map((e) => [e.button, e.buttons, e.x, e.y])).toEqual([["left", 0, SAFEPT.x, SAFEPT.y]]);
  });
});

// ───────────────────────── 按住期间的 browser_mouse click ─────────────────────────

describe("R6-30：按住期间的 browser_mouse click 不再按落点拒", () => {
  it.each(TARGETS)("down(起点) → move → click(%s)：放行，click 落在该点，没有探针；click 结束同一个键的按下态", async (_n, pt) => {
    const h = makeHarness();
    await h.dragTo(pt);
    await h.call({ action: "click", ...pt });
    expect(h.landedAt(pt).filter((e) => e.type === "click")).toHaveLength(1);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    expect(h.probeCalls()).toEqual([]);
  });

  it("double_click、右键 click 同样放行（clickCount / button 原样交给点击入口）", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    await h.call({ action: "double_click", ...PWPT });
    await h.call({ action: "click", ...PWPT, button: "right" });
    expect(h.landedAt(PWPT).filter((e) => e.type === "click").map((e) => [e.button, e.clickCount])).toEqual([
      ["left", 2],
      ["right", 1],
    ]);
  });

  it("对照：按住期间 click 普通框放行；没按住时 click / double_click 密码框本身也放行", async () => {
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

describe("R6-30：releaseHeldButtons（ask_user_to_act / 接管 / 取消）在最后位置逐键释放", () => {
  it.each(TARGETS)("按住后 move 到%s，再 releaseHeldButtons：只在该点释放一次（buttons 0），不挪回起点、不发探针，状态清空", async (_n, pt) => {
    const h = makeHarness();
    await h.dragTo(pt);
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    // 整个收尾只有这一个事件：没有 mouseMoved（不挪回起点，也不往别处挪），release 就在最后位置
    expect(h.events).toEqual([expect.objectContaining({ type: "mouseReleased", ...pt, button: "left", buttons: 0 })]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    expect(h.probeCalls()).toEqual([]);
  });

  it("原地按住（没 move）：释放在按下的位置", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.events).toEqual([expect.objectContaining({ type: "mouseReleased", ...ORIGIN, button: "left", buttons: 0 })]);
  });

  it("多键按下：释放顺序固定为 left → right → middle（与按下顺序无关），buttons 是剩余位掩码，全部落在最后位置", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN, button: "middle" });
    await h.call({ action: "down", ...ORIGIN, button: "left" });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    await h.call({ action: "move", ...PWPT });
    expect(peekHeldButtons(h.tab).bits).toBe(7);
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.events.map((e) => [e.type, e.button, e.buttons, e.x, e.y])).toEqual([
      ["mouseReleased", "left", 6, PWPT.x, PWPT.y],
      ["mouseReleased", "right", 4, PWPT.x, PWPT.y],
      ["mouseReleased", "middle", 0, PWPT.x, PWPT.y],
    ]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("幂等：释放之后、或 down → up 之后再调用，什么都不发", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    await h.tab.releaseHeldButtons();
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.events).toEqual([]);

    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "up", ...ORIGIN });
    h.events.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.events).toEqual([]);
  });

  it("release 派发失败一律吞掉：不抛，每个键各自尝试（一个失败不影响下一个），状态照样清空", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "down", ...ORIGIN, button: "right" });
    h.hooks.failRelease = true;
    h.events.length = 0;
    await expect(h.tab.releaseHeldButtons()).resolves.toBeUndefined();
    expect(h.releases().map((e) => e.button)).toEqual(["left", "right"]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });
});

describe("R6-30：并发的 releaseHeldButtons 只发一套 release；收尾期间的新 down 不被覆盖", () => {
  it("两次并发调用（第一套 release 还在飞）：只有一套 mouseReleased，不会重复释放；先清态再发", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    h.events.length = 0;
    const open = holdReleases(h);
    const p1 = h.tab.releaseHeldButtons();
    const p2 = h.tab.releaseHeldButtons();
    expect(peekHeldButtons(h.tab).bits).toBe(0); // release 还没发出去，状态已经清了
    open();
    await Promise.all([p1, p2]);
    expect(h.releases()).toHaveLength(1);
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

  it("收尾 release 还在飞时来了新的 down：新按下态不会被收尾覆盖或清掉；旧的左键只释放一次", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT); // 左键按着，最后位置 SAFEPT
    h.events.length = 0;
    const open = holdReleases(h);
    const p = h.tab.releaseHeldButtons(); // 状态已清，release 卡在闸门上
    await h.call({ action: "down", ...ORIGIN, button: "right" }); // 新的按下态（右键）
    expect(peekHeldButtons(h.tab).bits).toBe(2);
    expect(h.events.map((e) => [e.type, e.button, e.buttons])).toEqual([
      ["mouseMoved", "none", 0], // 新 down 不带着旧的左键
      ["mousePressed", "right", 2],
    ]);
    open();
    await p;
    expect(peekHeldButtons(h.tab).bits).toBe(2); // 旧收尾结束后新的右键仍在
    expect(h.releases().map((e) => [e.button, e.buttons, e.x, e.y])).toEqual([["left", 0, SAFEPT.x, SAFEPT.y]]);

    h.events.length = 0;
    await h.tab.releaseHeldButtons(); // 新的按下态仍能被正常释放
    expect(h.releases().map((e) => [e.button, e.buttons, e.x, e.y])).toEqual([["right", 0, ORIGIN.x, ORIGIN.y]]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });
});

// ───────────────────────── 动作被取消 / 接管 / 出错时的收尾释放（runMouse catch） ─────────────────────────

describe("R6-30：动作被取消 / 接管 / 出错时的收尾释放（runMouse catch）", () => {
  it("按住并 move 到密码框后，下一个 mouse 动作被取消（CANCELLED）：收尾 release 落在最后位置（密码框也照常释放），状态清空", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.events.length = 0;
    h.hooks.check = () => {
      throw new BrowserError("CANCELLED", "任务已被取消");
    };
    await expect(h.call({ action: "move", ...SAFEPT })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.events).toEqual([expect.objectContaining({ type: "mouseReleased", ...PWPT, button: "left", buttons: 0 })]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    expect(h.probeCalls()).toEqual([]);
  });

  it("USER_TOOK_OVER 同理", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.events.length = 0;
    h.hooks.check = () => {
      throw new BrowserError("USER_TOOK_OVER", "用户接管");
    };
    await expect(h.call({ action: "wheel", ...SAFEPT, deltaY: 40 })).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
    expect(h.releases().map((e) => [e.x, e.y, e.buttons])).toEqual([[PWPT.x, PWPT.y, 0]]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("已经开始派发输入后动作出错（非取消）：补发 release（落在这次 move 到的位置）并清状态，错误原样上抛", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    h.events.length = 0;
    let n = 0;
    h.hooks.check = () => {
      // 第 1 次在派发之前（放行），第 2 次在派发并等待之后
      if (++n === 2) throw new Error("boom");
    };
    await expect(h.call({ action: "move", ...PWPT })).rejects.toThrow("boom");
    expect(h.releases().map((e) => [e.x, e.y, e.buttons])).toEqual([[PWPT.x, PWPT.y, 0]]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("派发之前就出错（非取消，没发出任何事件）：不动上一次合法 down 留下的按下态", async () => {
    const h = makeHarness();
    await h.dragTo(SAFEPT);
    h.events.length = 0;
    h.hooks.check = () => {
      throw new Error("boom");
    };
    await expect(h.call({ action: "move", ...PWPT })).rejects.toThrow("boom");
    expect(h.events).toEqual([]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });
});

// ───────────────────────── 过期（空闲 120s / 导航提交）的补发 ─────────────────────────

describe("R6-30：空闲 120s / 导航提交后的 stale 补发", () => {
  it.each([
    ["普通输入框", SAFEPT],
    ["密码框", PWPT],
  ] as const)("按住后 move 到%s，空闲超过 TTL：下一次 mouse 动作先在最后位置补发 release，这次 move 随后是「没按着」的 move", async (_n, pt) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const h = makeHarness();
    await h.dragTo(pt);
    vi.setSystemTime(1_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    expect(peekHeldButtons(h.tab)).toMatchObject({ bits: 0, stale: { bits: 1, x: pt.x, y: pt.y } }); // 已过期
    h.events.length = 0;
    await h.call({ action: "move", x: 200, y: 200 });
    expect(h.releases().map((e) => [e.x, e.y, e.buttons])).toEqual([[pt.x, pt.y, 0]]);
    expect(h.events[0]).toMatchObject({ type: "mouseReleased" }); // 先补发，再做这次动作
    expect(h.events.at(-1)).toMatchObject({ type: "mouseMoved", x: 200, y: 200, buttons: 0, button: "none" });
    expect(peekHeldButtons(h.tab)).toEqual({ bits: 0, stale: null }); // 补发后状态清空，不会反复补发
    expect(h.probeCalls()).toEqual([]);
  });

  it("导航提交后（navCommitted 变化）按下态过期：stale 补发同样落在最后位置（密码框也照常释放）", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.tab.navCommitted = 1;
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    h.events.length = 0;
    await h.call({ action: "move", ...SAFEPT });
    expect(h.releases().map((e) => [e.x, e.y, e.buttons])).toEqual([[PWPT.x, PWPT.y, 0]]);
    expect(peekHeldButtons(h.tab)).toEqual({ bits: 0, stale: null });
  });
});

// ───────────────────────── 其它工具的点击不再被「按着键」拦住 ─────────────────────────

describe("R6-30：按着 browser_mouse 的键时，其它点击路径（browser_click / type 点击兜底 / fill_form 等经 mouseClickAt）照常执行", () => {
  const pressRelease = ["mouseMoved", "mousePressed", "mouseReleased"];

  it("browser_mouse down → move 到密码框 → 其它工具点击密码框：放行，真的发出 move / press / release；不动 browser_mouse 的按下态", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.cdpMouse.length = 0;
    await h.toolClick(PWPT);
    expect(h.cdpMouse.map((e) => e.type)).toEqual(pressRelease);
    expect(h.cdpMouse.every((e) => e.x === PWPT.x && e.y === PWPT.y)).toBe(true);
    expect(peekHeldButtons(h.tab).bits).toBe(1); // 左键仍按着，要由 browser_mouse up / 接管 / 取消去收尾
  });

  it("原地按着（没 move）、以及空闲超过 120s 的陈旧按下态下，其它工具的点击同样放行", async () => {
    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.toolClick(ORIGIN);
    expect(h.cdpMouse.map((e) => e.type)).toEqual(pressRelease);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(4_000_000);
    const h2 = makeHarness();
    await h2.dragTo(SAFEPT);
    vi.setSystemTime(4_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    expect(peekHeldButtons(h2.tab).bits).toBe(0); // peek 视为过期
    await h2.toolClick(PWPT);
    expect(h2.cdpMouse.map((e) => e.type)).toEqual(pressRelease);
  });

  it("对照：从没按过 / 按过又放开 / 补发释放后，点击都放行", async () => {
    const h0 = makeHarness();
    await h0.toolClick(PWPT); // 没按过
    expect(h0.cdpMouse.map((e) => e.type)).toEqual(pressRelease);

    const h = makeHarness();
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "up", ...ORIGIN });
    await h.toolClick(PWPT);
    expect(h.cdpMouse.filter((e) => e.type === "mousePressed")).toHaveLength(1);

    const h2 = makeHarness();
    await h2.dragTo(SAFEPT);
    await h2.tab.releaseHeldButtons(); // 在最后位置释放并清态
    h2.cdpMouse.length = 0;
    await h2.toolClick(PWPT);
    expect(h2.cdpMouse.filter((e) => e.type === "mousePressed")).toHaveLength(1);
  });

  it("browser_mouse 自己的 click（经真 mouseClickAt）：按着左键再右键 click 放行；按下态只清右键，左键仍按着", async () => {
    const h = makeHarness({ realClick: true });
    await h.call({ action: "down", ...ORIGIN });
    await h.call({ action: "move", ...SAFEPT });
    h.cdpMouse.length = 0;
    await h.call({ action: "click", ...SAFEPT, button: "right" });
    expect(h.cdpMouse.map((e) => [e.type, e.button])).toEqual([
      ["mouseMoved", "none"],
      ["mousePressed", "right"],
      ["mouseReleased", "right"],
    ]);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });
});

// ───────────────────────── click 清按下态 ─────────────────────────

describe("R6-30：按住后 click 会结束同一个键的按下态", () => {
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

// ───────────────────────── release 在 withAiInput 窗口里派发 ─────────────────────────

describe("R6-30：release 在 withAiInput 窗口里派发（归因给 AI，不会被录成用户操作）", () => {
  it("releaseHeldButtons：mouseReleased 在窗口之内派发，且没有任何探针调用", async () => {
    const h = makeHarness();
    await h.dragTo(PWPT);
    h.inputLog.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.inputLog).toEqual([{ type: "mouseReleased", inside: true }]);
    expect(h.probeCalls()).toEqual([]);
  });

  it("stale 补发（空闲超时后的下一次 mouse 动作）的 mouseReleased 同样在窗口之内", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(3_000_000);
    const h = makeHarness();
    await h.dragTo(PWPT);
    vi.setSystemTime(3_000_000 + HELD_BUTTON_TTL_MS + 1_000);
    h.inputLog.length = 0;
    await h.call({ action: "move", ...SAFEPT });
    expect(h.inputLog.filter((e) => e.type === "mouseReleased")).toEqual([{ type: "mouseReleased", inside: true }]);
  });
});
