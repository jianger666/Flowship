/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 页面元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-03：closed shadow root 内的 iframe 焦点复核（`probeFocusSecretCdp`，读取侧：录屏每帧用它决定丢不丢帧）必须 fail-closed。
 * 另外钉住产品决策后的写入侧行为：browser_mouse 不再探落点——中键点击 / 拖放释放落在密码框、iframe、closed root 里的密码框上都照常派发，
 * 且不发任何 CDP 探针调用。
 *
 * 用 vm 在假元素上真跑页内函数（IS_FRAME_FN / NEXT_FOCUS_OPEN_FN / SECRET_ELEMENT_PROBE_SOURCE …），假 CDP 复现
 * `DOM.describeNode` → `DOM.resolveNode` → `Runtime.callFunctionOn / evaluate` 的穿透链路（与 browser-e2-c7-closed-shadow 同构）。
 */
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import { MAX_FRAME_DEPTH, probeFocusSecretCdp } from "../electron-app/browser/closed-shadow.mjs";
import { createHandlers, peekHeldButtons } from "../electron-app/browser/ops/input.mjs";

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
});

/**
 * 驱动真实 ops/input.mjs 的 mouse handler。tab 是脚本化假 CDP：`tab.calls` 记下所有 `send` 的方法名，
 * 用来断言 browser_mouse 不再发任何探针调用（落点探针已删，handler 本身不经 tab.send，鼠标事件走被 mock 的 I.mouse / I.mouseClickAt）。
 */
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

describe("browser_mouse 不再探落点（写入侧不限制往密码框 / iframe / closed root 里操作）", () => {
  const PWBOX = PW();
  const PLAINBOX = PLAIN();
  // (500,500) 是 password；(100,100) / (300,300) 是普通输入框；(700,700) 是 iframe；(800,100) 是 closed root 里的 password
  const hit = (x: number, y: number): El | null => {
    if (x === 500 && y === 500) return PWBOX;
    if (x === 700 && y === 700) return readableFrame(PLAIN());
    if (x === 800 && y === 100) return hostWith(closedRoot({ at: PW() }));
    return PLAINBOX;
  };
  const SENSITIVE_SPOTS: Array<[number, number]> = [
    [500, 500],
    [700, 700],
    [800, 100],
  ];

  it("中键 click / double_click / down / up 落在 password 框、iframe、closed root 里的 password 上：照常派发，且没有任何 CDP 探针调用", async () => {
    const h = makeMouseHarness(hit);
    for (const [x, y] of SENSITIVE_SPOTS) {
      await h.call({ action: "click", x, y, button: "middle" });
      await h.call({ action: "double_click", x, y, button: "middle" });
      await h.call({ action: "down", x, y, button: "middle" });
      await h.call({ action: "up", x, y, button: "middle" });
    }
    expect(h.events.filter((e) => e.type === "click").length).toBe(SENSITIVE_SPOTS.length * 2);
    expect(h.events.filter((e) => e.type === "mousePressed").length).toBe(SENSITIVE_SPOTS.length);
    expect(h.events.filter((e) => e.type === "mouseReleased").length).toBe(SENSITIVE_SPOTS.length);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    expect(h.tab.calls).toEqual([]);
  });

  it("拖放：down 在普通框，up 落在 password 框 / iframe / closed root 里的 password 上：mouseReleased 照常发出并清掉按下态", async () => {
    const h = makeMouseHarness(hit);
    for (const [x, y] of SENSITIVE_SPOTS) {
      await h.call({ action: "down", x: 100, y: 100 });
      await h.call({ action: "move", x, y });
      expect(peekHeldButtons(h.tab).bits).toBe(1);
      await h.call({ action: "up", x, y });
      expect(peekHeldButtons(h.tab).bits).toBe(0);
    }
    const released = h.events.filter((e) => e.type === "mouseReleased");
    expect(released.map((e) => [e.x, e.y])).toEqual(SENSITIVE_SPOTS);
    expect(h.tab.calls).toEqual([]);
  });

  it("原地 down→up 点 password 框、没有对应 down 的孤立 up、左键 click 点 password 框：都不再被拒", async () => {
    const h = makeMouseHarness(hit);
    await h.call({ action: "down", x: 500, y: 500 });
    await h.call({ action: "up", x: 500, y: 500 });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    await h.call({ action: "up", x: 500, y: 500 }); // 孤立 up
    await h.call({ action: "click", x: 500, y: 500 });
    expect(h.events.filter((e) => e.type === "mouseReleased").length).toBe(2);
    expect(h.events.filter((e) => e.type === "click").length).toBe(1);
    expect(h.tab.calls).toEqual([]);
  });

  it("即使 CDP 的 send 全部抛错也不影响派发（不再依赖落点探针）", async () => {
    const h = makeMouseHarness(hit);
    h.tab.send = async () => {
      throw new Error("cdp down");
    };
    await h.call({ action: "click", x: 500, y: 500, button: "middle" });
    await h.call({ action: "down", x: 800, y: 100 });
    await h.call({ action: "up", x: 700, y: 700 });
    expect(h.events.filter((e) => e.type === "click").length).toBe(1);
    expect(h.events.filter((e) => e.type === "mouseReleased").length).toBe(1);
  });
});
