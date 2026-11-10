/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 页面元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-03 / R6-30：closed shadow root 内的 iframe 焦点 / 落点复核必须 fail-closed；browser_mouse 的释放落点与中键点击要过落点探针。
 *
 * 用 vm 在假元素上真跑页内函数（IS_FRAME_FN / NEXT_FOCUS_OPEN_FN / DROP_TARGET_SECRET_PROBE …），假 CDP 复现
 * `DOM.describeNode` → `DOM.resolveNode` → `Runtime.callFunctionOn / evaluate` 的穿透链路（与 browser-e2-c7-closed-shadow 同构）。
 */
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import { MAX_FRAME_DEPTH, probeDropSecretCdp, probeFocusSecretCdp } from "../electron-app/browser/closed-shadow.mjs";
import { createHandlers, mouseNeedsDropProbe, peekHeldButtons } from "../electron-app/browser/ops/input.mjs";
import {
  SECRET_DROP_MESSAGE,
  UNKNOWN_DROP_MESSAGE,
  UNKNOWN_FOCUS_PRESS_KEY_MESSAGE,
  UNKNOWN_FOCUS_TYPE_MESSAGE,
} from "../electron-app/browser/secret-field.mjs";

type El = Record<string, any>;

const win = { getComputedStyle: (e: El) => ({ webkitTextSecurity: e?.__ts ?? "", getPropertyValue: () => e?.__ts ?? "" }) };
let backendSeq = 500;

const el = (tag: string, attrs: Record<string, string> = {}, extra: El = {}): El => {
  const base: El = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    type: attrs.type ?? "",
    shadowRoot: null,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    ownerDocument: { defaultView: win },
  };
  // 用属性描述符拷贝：extra 里的 getter（模拟「读 contentDocument / tagName 就抛」的页面）不能在构造时被求值
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(extra));
};
const PW = () => el("input", { type: "password" });
const PLAIN = () => el("input", { type: "text" });
const closedRoot = (opts: { active?: El | null; at?: El | null }) => ({ __id: backendSeq++, activeElement: opts.active ?? null, elementFromPoint: () => opts.at ?? null });
const hostWith = (root: El) => el("x-host", {}, { __closed: root });
/** 同站、contentDocument 读得进的 iframe */
const readableFrame = (inner: El | null, tag = "iframe") => el(tag, {}, { contentDocument: { activeElement: inner, elementFromPoint: () => inner } });
/** 跨域 / 沙箱 iframe：contentDocument 读取抛错（与真浏览器 SecurityError 同形） */
const crossOriginFrame = (tag = "iframe") =>
  el(tag, {}, {
    get contentDocument() {
      throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame.");
    },
  });
/** contentDocument 为 null 的 iframe（沙箱无 allow-same-origin / closed root 内读不进） */
const nullDocFrame = () => el("iframe", {}, { contentDocument: null });

/** 脚本化假 CDP：对象图在 JS 里，页内函数 / 表达式源码用 vm 真跑 */
const makeTab = (doc: El) => {
  const objs = new Map<string, any>();
  const rootsByBackend = new Map<number, El>();
  const calls: string[] = [];
  let n = 0;
  const reg = (v: any) => {
    const id = `o${n++}`;
    objs.set(id, v);
    return id;
  };
  const ctx = vm.createContext({ window: win, document: doc, getComputedStyle: win.getComputedStyle });
  const run = (fn: string, self: any, args: unknown[] = []) => vm.runInContext(`(${fn}).call(__self, ...__args)`, Object.assign(ctx, { __self: self, __args: args }));
  const asRemote = (v: any) => (v ? { subtype: "node", objectId: reg(v) } : { subtype: "null", value: null });
  const tab: any = {
    calls,
    send: async (method: string, params: any = {}) => {
      calls.push(method);
      switch (method) {
        case "Runtime.evaluate": {
          const r = vm.runInContext(String(params.expression), ctx);
          return params.returnByValue ? { result: { value: r } } : { result: asRemote(r) };
        }
        case "DOM.resolveNode": {
          if (typeof params.backendNodeId === "number" && rootsByBackend.has(params.backendNodeId)) {
            return { object: { objectId: reg(rootsByBackend.get(params.backendNodeId)) } };
          }
          return { object: { objectId: reg(el("div", {}, { ownerDocument: doc })) } };
        }
        case "DOM.describeNode": {
          const e = objs.get(params.objectId);
          const roots: any[] = [];
          if (e?.__closed) {
            rootsByBackend.set(e.__closed.__id, e.__closed);
            roots.push({ shadowRootType: "closed", backendNodeId: e.__closed.__id });
          }
          return { node: { shadowRoots: roots } };
        }
        case "Runtime.callFunctionOn": {
          const self = objs.get(params.objectId);
          const args = (params.arguments ?? []).map((a: any) => a.value);
          const r = run(String(params.functionDeclaration), self, args);
          return params.returnByValue === false ? { result: asRemote(r) } : { result: { value: r } };
        }
        default:
          return {};
      }
    },
  };
  return tab;
};

const docOf = (active: El | null, at: (x: number, y: number) => El | null = () => null): El => {
  const d: El = { activeElement: active, elementFromPoint: at, defaultView: win };
  d.documentElement = el("html", {}, { ownerDocument: d });
  return d;
};

describe("R6-03 焦点探针：closed root 内的 iframe / frame 不得判 safe", () => {
  it("closed root → 跨域 iframe（contentDocument 读取抛错）：unknown（修之前是 safe）", async () => {
    const doc = docOf(hostWith(closedRoot({ active: crossOriginFrame() })));
    expect(await probeFocusSecretCdp(makeTab(doc), null)).toBe("unknown");
  });

  it("closed root → <frame>（旧式框架）/ contentDocument 为 null 的沙箱 iframe：同样 unknown", async () => {
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: crossOriginFrame("frame") })))), null)).toBe("unknown");
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: nullDocFrame() })))), null)).toBe("unknown");
  });

  it("closed root → 同站可读 iframe，里面焦点是 password：secret；是普通框：safe（读得进就照常判，不误伤）", async () => {
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: readableFrame(PW()) })))), null)).toBe("secret");
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: readableFrame(PLAIN()) })))), null)).toBe("safe");
  });

  it("可读 iframe 的 contentDocument 没有 activeElement（读不到焦点）：unknown，不拿 iframe 元素自己充数", async () => {
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: readableFrame(null) })))), null)).toBe("unknown");
  });

  it(`iframe 嵌套：${MAX_FRAME_DEPTH} 层可读 → 照常判（safe / secret）；第 ${MAX_FRAME_DEPTH + 1} 层 → unknown`, async () => {
    const chain = (depth: number, leaf: El) => {
      let cur = leaf;
      for (let i = 0; i < depth; i++) cur = readableFrame(cur);
      return cur;
    };
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: chain(MAX_FRAME_DEPTH, PLAIN()) })))), null)).toBe("safe");
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: chain(MAX_FRAME_DEPTH, PW()) })))), null)).toBe("secret");
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: chain(MAX_FRAME_DEPTH + 1, PLAIN()) })))), null)).toBe("unknown");
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: chain(MAX_FRAME_DEPTH + 1, PW()) })))), null)).toBe("unknown");
  });

  it("tagName 读取抛错（页面做手脚）：按「是框架」处理 → unknown，而不是放行", async () => {
    const evil = el("div", {}, {
      get tagName() {
        throw new Error("hostile");
      },
    });
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: evil })))), null)).toBe("unknown");
  });

  it("对照：焦点是普通输入框 / 没有焦点元素，不受影响", async () => {
    expect(await probeFocusSecretCdp(makeTab(docOf(hostWith(closedRoot({ active: PLAIN() })))), null)).toBe("safe");
    expect(await probeFocusSecretCdp(makeTab(docOf(null)), null)).toBe("safe");
  });

  it("文案可自修复：告知焦点在无法检查的内嵌框架里，请让用户操作或点击页面其它位置", () => {
    for (const m of [UNKNOWN_FOCUS_PRESS_KEY_MESSAGE, UNKNOWN_FOCUS_TYPE_MESSAGE]) {
      expect(m).toContain("无法检查的内嵌框架");
      expect(m).toContain("browser_ask_user_to_act");
      expect(m).toContain("点击页面里 iframe 之外的位置");
    }
  });
});

describe("R6-30 落点探针：命中 IFRAME / FRAME 一律 unknown（不做偏移递归）", () => {
  it("entry=null（主页面视口坐标）：落点是 password → secret；普通框 → safe；iframe / frame → unknown", async () => {
    const at = (e: El) => makeTab(docOf(null, () => e));
    expect(await probeDropSecretCdp(at(PW()), null, 10, 10)).toBe("secret");
    expect(await probeDropSecretCdp(at(PLAIN()), null, 10, 10)).toBe("safe");
    expect(await probeDropSecretCdp(at(readableFrame(PLAIN())), null, 10, 10)).toBe("unknown");
    expect(await probeDropSecretCdp(at(crossOriginFrame("frame")), null, 10, 10)).toBe("unknown");
    expect(await probeDropSecretCdp(at(PLAIN()), null, Number.NaN, 10)).toBe("unknown");
  });

  it("entry 有 ref：closed root 里的落点是 iframe → unknown；落点是 password → secret", async () => {
    const entry = { backendNodeId: 1 };
    const withRoot = (inner: El) => makeTab(docOf(null, () => hostWith(closedRoot({ at: inner }))));
    expect(await probeDropSecretCdp(withRoot(readableFrame(PW())), entry, 5, 5)).toBe("unknown");
    expect(await probeDropSecretCdp(withRoot(crossOriginFrame()), entry, 5, 5)).toBe("unknown");
    expect(await probeDropSecretCdp(withRoot(PW()), entry, 5, 5)).toBe("secret");
    expect(await probeDropSecretCdp(withRoot(PLAIN()), entry, 5, 5)).toBe("safe");
  });

  it("落点直接是 iframe 元素（不在 closed root 里）：unknown（以前 CDP 复核对它判 safe）", async () => {
    const entry = { backendNodeId: 1 };
    expect(await probeDropSecretCdp(makeTab(docOf(null, () => readableFrame(PLAIN()))), entry, 5, 5)).toBe("unknown");
  });
});

describe("R6-30 mouseNeedsDropProbe（纯函数）", () => {
  const A = (action: string, button = "left", x = 100, y = 100) => ({ action, button, x, y });
  it("中键的 down / up / click / double_click 一律探；move / wheel 不探", () => {
    for (const act of ["down", "up", "click", "double_click"]) expect(mouseNeedsDropProbe(A(act, "middle"), null), act).toBe(true);
    for (const act of ["move", "wheel"]) expect(mouseNeedsDropProbe(A(act, "middle"), null), act).toBe(false);
  });
  it("左键 click / down / move / wheel 不探（AI 点击密码框本身是允许的）", () => {
    for (const act of ["click", "double_click", "down", "move", "wheel"]) expect(mouseNeedsDropProbe(A(act), null), act).toBe(false);
  });
  it("up：任何键、任何位置、有没有对应 down 都探（R6-30 三轮复审 A：不再按「原地 / ≤ 4px」这类鼠标轨迹豁免）", () => {
    const held = { bits: 1 };
    // 原地 up（与按下点同坐标）、几像素抖动、远处 up：全部探
    for (const [x, y] of [
      [100, 100],
      [102, 101],
      [104, 100],
      [105, 100],
      [900, 700],
    ]) {
      expect(mouseNeedsDropProbe(A("up", "left", x, y), held), `${x},${y}`).toBe(true);
    }
    for (const button of ["left", "right", "middle"]) {
      expect(mouseNeedsDropProbe(A("up", button), held), button).toBe(true);
      expect(mouseNeedsDropProbe(A("up", button), null), `${button} 无按下态`).toBe(true);
    }
    expect(mouseNeedsDropProbe(A("up", "left"), { bits: 2 })).toBe(true); // 按住的是右键，释放的是左键
  });
});

/** 驱动真实 ops/input.mjs 的 mouse handler，落点探针用 actions.assertPointNotSecret 跑在假 CDP 上 */
const makeMouseHarness = (hit: (x: number, y: number) => El | null) => {
  const tab: any = makeTab(docOf(null, hit));
  const events: any[] = [];
  Object.assign(tab, {
    ensureCdp: async () => {},
    layoutMetrics: async () => ({ viewportW: 1000, viewportH: 800 }),
    setAI: async () => {},
    withAiInput: async (fn: () => Promise<unknown>) => fn(),
    navCommitted: 0,
  });
  const I: any = {
    assertPointNotSecret: actions.assertPointNotSecret,
    aiScope: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
    beforeState: () => ({}),
    actionResult: () => ({ tabId: "t1", url: "https://a.test/", title: "A", navigated: false }),
    showAction: async () => {},
    mouse: async (_t: unknown, p: any) => void events.push(p),
    mouseClickAt: async (_t: unknown, pt: any, o: any) => void events.push({ type: "click", ...pt, ...o }),
    settle: async () => {},
  };
  const session = { runAction: async (_o: unknown, fn: (ctx: any) => Promise<unknown>) => fn({ tab, signal: undefined, check: () => {}, describe: () => {} }) };
  const handlers = createHandlers({ actions: { v1Internals: I, modifierBits: actions.modifierBits }, requireSession: () => session } as any);
  const call = (a: Record<string, unknown>) => handlers.mouse("t", { button: "left", ...a } as any);
  return { tab, events, call };
};

describe("R6-30 browser_mouse：释放落点 / 拖放 / 中键点击过落点探针", () => {
  const PWBOX = PW();
  const PLAINBOX = PLAIN();
  // (500,500) 是 password；(100,100) / (300,300) 是普通输入框；(700,700) 是 iframe；(800,100) 是 closed root 里的 password
  const hit = (x: number, y: number): El | null => {
    if (x === 500 && y === 500) return PWBOX;
    if (x === 700 && y === 700) return readableFrame(PLAIN());
    if (x === 800 && y === 100) return hostWith(closedRoot({ at: PW() }));
    return PLAINBOX;
  };

  it("中键点击 password 框：BAD_ARGS（SECRET_DROP_MESSAGE），一个鼠标事件都不发", async () => {
    const h = makeMouseHarness(hit);
    await expect(h.call({ action: "click", x: 500, y: 500, button: "middle" })).rejects.toMatchObject({ code: "BAD_ARGS", message: SECRET_DROP_MESSAGE });
    expect(h.events).toEqual([]);
  });

  it("中键点击 closed root 里的 password：同样被拒（页内探针看不到，CDP 复核补上）", async () => {
    const h = makeMouseHarness(hit);
    await expect(h.call({ action: "click", x: 800, y: 100, button: "middle" })).rejects.toMatchObject({ message: SECRET_DROP_MESSAGE });
    expect(h.events).toEqual([]);
  });

  it("中键点击 iframe：unknown 拒（UNKNOWN_DROP_MESSAGE）；中键 down / up 也一样", async () => {
    const h = makeMouseHarness(hit);
    for (const action of ["click", "double_click", "down", "up"]) {
      await expect(h.call({ action, x: 700, y: 700, button: "middle" }), action).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_DROP_MESSAGE });
    }
    expect(h.events).toEqual([]);
  });

  it("中键点击普通框 / 左键点击 password 框本身：放行（后者是允许的，被拒的是往里塞内容）", async () => {
    const h = makeMouseHarness(hit);
    await h.call({ action: "click", x: 300, y: 300, button: "middle" });
    await h.call({ action: "click", x: 500, y: 500, button: "left" });
    expect(h.events.filter((e) => e.type === "click").length).toBe(2);
  });

  it("拖放：down 在普通框，move 后在 password 框 up → 被拒；按下态保留（可换落点再 up），mouseReleased 没发", async () => {
    const h = makeMouseHarness(hit);
    await h.call({ action: "down", x: 100, y: 100 });
    await h.call({ action: "move", x: 500, y: 500 });
    await expect(h.call({ action: "up", x: 500, y: 500 })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(h.events.some((e) => e.type === "mouseReleased")).toBe(false);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    // 自修复：换到普通落点释放，成功并清掉按下态
    await h.call({ action: "up", x: 300, y: 300 });
    expect(h.events.some((e) => e.type === "mouseReleased")).toBe(true);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("拖放落在 iframe 上 up：unknown 拒；落在 closed root 里的 password：secret 拒", async () => {
    const h = makeMouseHarness(hit);
    await h.call({ action: "down", x: 100, y: 100 });
    await expect(h.call({ action: "up", x: 700, y: 700 })).rejects.toMatchObject({ message: expect.stringContaining(UNKNOWN_DROP_MESSAGE) });
    await expect(h.call({ action: "up", x: 800, y: 100 })).rejects.toMatchObject({ message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(h.events.some((e) => e.type === "mouseReleased")).toBe(false);
  });

  it("拖放到普通框放行；原地 down→up 点 password 框也被拒（R6-30 三轮复审 A：up 一律探，点它请用 browser_click）", async () => {
    const h = makeMouseHarness(hit);
    await h.call({ action: "down", x: 100, y: 100 });
    await h.call({ action: "up", x: 300, y: 300 });
    expect(h.events.filter((e) => e.type === "mouseReleased").length).toBe(1);

    await h.call({ action: "down", x: 500, y: 500 });
    await expect(h.call({ action: "up", x: 500, y: 500 })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining(SECRET_DROP_MESSAGE) });
    expect(h.events.filter((e) => e.type === "mouseReleased").length).toBe(1);
    expect(peekHeldButtons(h.tab).bits).toBe(1); // 按下态保留，换到安全位置 up 即可收尾
    await h.call({ action: "up", x: 300, y: 300 });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    // 不按住的 browser_mouse click 点 password 框本身仍放行
    await h.call({ action: "click", x: 500, y: 500 });
    expect(h.events.filter((e) => e.type === "click").length).toBe(1);
  });

  it("没有对应 down 的孤立 up 落在 password 框：拒（无从判断是不是拖放 → fail-closed）", async () => {
    const h = makeMouseHarness(hit);
    await expect(h.call({ action: "up", x: 500, y: 500 })).rejects.toMatchObject({ code: "BAD_ARGS", message: SECRET_DROP_MESSAGE });
    expect(h.events).toEqual([]);
  });

  it("探针本身抛错（CDP 断了）：按 unknown 拒，不放行", async () => {
    const h = makeMouseHarness(hit);
    h.tab.send = async () => {
      throw new Error("cdp down");
    };
    await expect(h.call({ action: "click", x: 300, y: 300, button: "middle" })).rejects.toMatchObject({ message: UNKNOWN_DROP_MESSAGE });
    expect(h.events).toEqual([]);
  });
});
