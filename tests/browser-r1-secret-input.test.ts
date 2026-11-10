/* eslint-disable @typescript-eslint/no-explicit-any -- 假 session / tab / 页面环境与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R1 评审 sc 组（输入保密 + 拖拽 / 鼠标收尾）的主进程侧单测：
 * - R1-02：browser_type（typeBody）拒绝密码 / 验证码 / 银行卡 / text-security 字段，文案与 fill_form 同源；
 * - R1-25：browser_press_key 焦点是敏感字段（或确认不了）时拒绝会输入字符的键；isSecretField 与 secret-field 同一规则；
 * - R1-28：drag / mouse 在取消 / 出错 / 过期时补发 mouseReleased 并清状态。
 * 页内探针源码用 vm 在假元素上真跑（不是 mock 返回值），所以嵌入的统一判定函数也被一起验证。真浏览器行为见 scripts/browser-e2e/*.cjs。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import { PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE, PASTE_NOT_AI_CLIPBOARD_MESSAGE, createAiWriteLedger } from "../electron-app/browser/clipboard-policy.mjs";
import {
  HELD_BUTTON_TTL_MS,
  PASSWORD_REJECT_MESSAGE,
  createHandlers,
  isSecretField,
  peekHeldButtons,
} from "../electron-app/browser/ops/input.mjs";
import {
  ACTIVE_SECRET_PROBE_SOURCE,
  DROP_TARGET_SECRET_PROBE_SOURCE,
  HELD_BUTTON_CLICK_MESSAGE,
  PASSWORD_REJECT_MESSAGE as SHARED_MESSAGE,
  isSecretInfo,
  readSecretInfo,
  SECRET_DROP_MESSAGE,
  SECRET_PRESS_KEY_MESSAGE,
  UNKNOWN_DROP_MESSAGE,
  UNKNOWN_FIELD_TYPE_MESSAGE,
  UNKNOWN_FOCUS_PRESS_KEY_MESSAGE,
  UNKNOWN_FOCUS_TYPE_MESSAGE,
} from "../electron-app/browser/secret-field.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { keyTypesCharacter } from "@/lib/server/browser/redact-args";

// ───────────────────────── 假页面元素 + 在 vm 里执行页内函数 ─────────────────────────

type FakeEl = Record<string, any>;
const mkEl = (tag: string, attrs: Record<string, string> = {}, extra: FakeEl = {}): FakeEl => {
  const win = { getComputedStyle: (e: FakeEl) => ({ webkitTextSecurity: e.__textSecurity ?? "", getPropertyValue: () => e.__textSecurity ?? "" }) };
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    type: attrs.type ?? "",
    readOnly: false,
    disabled: false,
    isContentEditable: false,
    value: "",
    focus: () => {},
    dispatchEvent: () => true,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    // 落点探针默认命中一个普通元素（R2-03 复审②之后：探不到元素按「不确定」拒，不再当安全放行）
    ownerDocument: {
      defaultView: win,
      elementFromPoint: () => ({ nodeType: 1, tagName: "DIV", type: "", getAttribute: () => null, ownerDocument: { defaultView: win } }),
    },
    ...extra,
  };
};

/** 在 vm 里以 this=el（或 null + 全局 document）执行页内函数源码，返回结果 */
const runInPage = (src: string, self: FakeEl | null, doc?: FakeEl, args: unknown[] = []) => {
  const win = { getComputedStyle: (e: FakeEl) => ({ webkitTextSecurity: e?.__textSecurity ?? "", getPropertyValue: () => e?.__textSecurity ?? "" }) };
  const ctx = vm.createContext({
    window: win,
    document: doc ?? { activeElement: null },
    getComputedStyle: win.getComputedStyle,
    // CLEAR_FN 用到的内建：原生 value setter 与事件构造
    HTMLInputElement: { prototype: {} },
    HTMLTextAreaElement: { prototype: {} },
    Event: class {},
  });
  return vm.runInContext(`(${src}).call(__self, ...__args)`, Object.assign(ctx, { __self: self, __args: args }));
};

// ───────────────────────── 假 tab / session ─────────────────────────

const makeFake = (opts: { elements?: Record<string, FakeEl>; doc?: FakeEl; navCommitted?: number } = {}) => {
  const sent: Array<{ method: string; params: any }> = [];
  const described: any[] = [];
  const els = opts.elements ?? {};
  const backendToRef = new Map<number, string>();
  let nextBackend = 10;
  const refs = new Map<string, any>();
  for (const ref of Object.keys(els)) {
    const backendNodeId = nextBackend++;
    backendToRef.set(backendNodeId, ref);
    refs.set(ref, { ref, role: "textbox", name: "字段", backendNodeId, sessionId: null, chain: [] });
  }
  const objToEl = new Map<string, FakeEl>();
  const cdpListeners: Array<(m: string, p: any) => void> = [];
  const tab: any = {
    id: "t1",
    url: "https://a.test/",
    title: "A",
    navCommitted: opts.navCommitted ?? 0,
    navStarted: 0,
    ensureCdp: async () => {},
    resolveRef: (ref: string) => {
      const e = refs.get(ref);
      if (!e) throw new BrowserError("REF_NOT_FOUND", `没有 ref ${ref}`);
      return e;
    },
    mapNodeError: (err: unknown) => err,
    frameOffset: async () => ({ x: 0, y: 0 }),
    layoutMetrics: async () => ({ viewportW: 1000, viewportH: 800, x: 0, y: 0, docW: 1000, docH: 800 }),
    setAI: async () => {},
    withAiInput: async (fn: () => Promise<unknown>) => fn(),
    overlayShowAction: async () => {},
    isLoading: () => false,
    waitForLoad: async () => {},
    onCdpEvent: (fn: (m: string, p: any) => void) => {
      cdpListeners.push(fn);
      return () => void cdpListeners.splice(cdpListeners.indexOf(fn), 1);
    },
    send: async (method: string, params: any = {}) => {
      sent.push({ method, params });
      switch (method) {
        case "DOM.getContentQuads": {
          const b = (params.backendNodeId - 10) * 200;
          return { quads: [[b, 0, b + 100, 0, b + 100, 20, b, 20]] };
        }
        case "DOM.resolveNode": {
          const id = `obj-${params.backendNodeId}`;
          objToEl.set(id, els[backendToRef.get(params.backendNodeId) as string]);
          return { object: { objectId: id } };
        }
        case "Runtime.callFunctionOn": {
          const fn = String(params.functionDeclaration);
          const args = Array.isArray(params.arguments) ? params.arguments.map((a: { value: unknown }) => a.value) : [];
          // E2·P10（C7）：closed-shadow.mjs 的 CDP 复核探针（returnByValue:false，返回的是元素引用）——假页里没有 closed root，
          // 它们只会沿 open 链 / 同一落点走到底，所以按「引用」登记返回即可
          if (params.returnByValue === false) {
            const r = runInPage(fn, objToEl.get(params.objectId) ?? null, opts.doc, args);
            if (!r) return { result: { subtype: "null", value: null } };
            const id = `obj-ref-${objToEl.size}`;
            objToEl.set(id, r);
            return { result: { subtype: "node", objectId: id } };
          }
          // OCCLUSION_FN（遮挡探针）恒回 self；DROP_TARGET_SECRET_PROBE（拖放落点探针，R2-03）也含 elementFromPoint，要真跑
          if (fn.includes("elementFromPoint") && !fn.includes("DROP_TARGET_SECRET_PROBE")) return { result: { value: { hit: "self" } } };
          return { result: { value: runInPage(fn, objToEl.get(params.objectId) ?? null, opts.doc, args) } };
        }
        case "Runtime.evaluate": {
          if (params.returnByValue === false) {
            // closed-shadow.mjs：无 ref 时取 document.activeElement 的引用
            const r = opts.doc?.activeElement ?? null;
            if (!r) return { result: { subtype: "null", value: null } };
            const id = `obj-ref-${objToEl.size}`;
            objToEl.set(id, r);
            return { result: { subtype: "node", objectId: id } };
          }
          return { result: { value: runInPage(String(params.expression).replace(/^\(|\)\.call\(null\)$/g, ""), null, opts.doc) } };
        }
        case "DOM.describeNode":
          return { node: {} }; // 假页没有 closed shadow root
        case "Runtime.releaseObjectGroup":
          return {};
        default:
          return {};
      }
    },
  };
  const session: any = {
    tabSeq: 0,
    tabs: [],
    runAction: async (o: any, fn: (ctx: any) => Promise<unknown>) =>
      fn({
        tab,
        signal: o.signal,
        tabSeqAtStart: 0,
        check: () => {
          if (o.signal?.aborted) throw new BrowserError("CANCELLED", "已取消");
          (tab.__check as undefined | (() => void))?.();
        },
        describe: (d: any) => described.push(d),
      }),
  };
  return { tab, session, sent, described, emitCdp: (m: string, p: any) => cdpListeners.forEach((l) => l(m, p)) };
};

const methods = (f: ReturnType<typeof makeFake>, m: string) => f.sent.filter((s) => s.method === m).map((s) => s.params);

// ───────────────────────── R1-02：type 拒绝敏感字段 ─────────────────────────

describe("R1-02 browser_type（typeBody）拒绝密码 / 验证码 / 银行卡 / 遮罩字段", () => {
  it("拒绝文案与 fill_form 同源（secret-field 与 ops/input 导出的是同一个字符串）并指向 browser_ask_user_to_act", () => {
    expect(PASSWORD_REJECT_MESSAGE).toBe(SHARED_MESSAGE);
    expect(SHARED_MESSAGE).toContain("browser_ask_user_to_act");
  });

  it.each([
    ["type=password", mkEl("input", { type: "password" })],
    ["autocomplete=one-time-code", mkEl("input", { type: "text", autocomplete: "one-time-code" })],
    ["autocomplete=cc-number", mkEl("input", { type: "text", autocomplete: "cc-number" })],
    ["autocomplete=cc-csc", mkEl("input", { type: "text", autocomplete: "cc-csc" })],
    ["autocomplete=cc-exp", mkEl("input", { type: "text", autocomplete: "cc-exp" })],
    ["autocomplete=new-password", mkEl("input", { type: "text", autocomplete: "new-password" })],
    ["-webkit-text-security: disc 的 text 框", mkEl("input", { type: "text" }, { __textSecurity: "disc" })],
    ["-webkit-text-security 的 contenteditable", mkEl("div", {}, { isContentEditable: true, __textSecurity: "square" })],
    ["-webkit-text-security 的 textarea", mkEl("textarea", {}, { __textSecurity: "circle" })],
  ])("%s：BAD_ARGS + 固定文案；不输入、不聚焦、不写活动日志", async (_label, el) => {
    const f = makeFake({ elements: { e1: el } });
    await expect(actions.type(f.session, { ref: "e1", text: "hunter2" })).rejects.toMatchObject({ code: "BAD_ARGS", message: PASSWORD_REJECT_MESSAGE });
    expect(methods(f, "Input.insertText")).toEqual([]);
    expect(methods(f, "DOM.focus")).toEqual([]);
    expect(f.described).toEqual([]);
  });

  // E2·D1：日期 / 时间类 input 是分段控件，Input.insertText 不生效（冒烟发现 fill_form 返回 ok 但值为空）→ 原生 setter + 回读校验
  describe("日期 / 时间类 input（date / datetime-local / month / time / week）", () => {
    const withSetter = (f: any, accept: boolean) => {
      const send = f.tab.send;
      const wrote: unknown[] = [];
      f.tab.send = async (method: string, params: any = {}) => {
        if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("dispatchEvent(new Event('change'")) {
          const v = params.arguments?.[0]?.value;
          wrote.push(v);
          return { result: { value: { value: accept ? v : "" } } };
        }
        return send(method, params);
      };
      return wrote;
    };

    it.each([
      ["date", "2026-11-09"],
      ["datetime-local", "2026-11-09T08:30"],
      ["month", "2026-11"],
      ["time", "08:30"],
      ["week", "2026-W45"],
    ])("%s：合法 ISO 文本走原生 setter，不再 insertText", async (type, text) => {
      const f = makeFake({ elements: { e1: mkEl("input", { type }) } });
      const wrote = withSetter(f, true);
      await actions.type(f.session, { ref: "e1", text });
      expect(wrote).toEqual([text]);
      expect(methods(f, "Input.insertText")).toEqual([]);
    });

    it.each([
      ["date", "11/09/2026"],
      ["date", "2026-1-9"],
      ["datetime-local", "2026-11-09 08:30"],
      ["time", "8:30"],
      ["month", "November"],
      ["week", "2026-45"],
    ])("%s：格式不对（%s）就地 BAD_ARGS 并给示例，不碰页面", async (type, text) => {
      const f = makeFake({ elements: { e1: mkEl("input", { type }) } });
      const wrote = withSetter(f, true);
      await expect(actions.type(f.session, { ref: "e1", text })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(new RegExp(`${type} 类型.*格式`)) });
      expect(wrote).toEqual([]);
      expect(methods(f, "Input.insertText")).toEqual([]);
      expect(f.described).toEqual([]);
    });

    it("格式对但浏览器回读为空（如 2026-13-45）：报错而不是假装成功", async () => {
      const f = makeFake({ elements: { e1: mkEl("input", { type: "date" }) } });
      withSetter(f, false);
      await expect(actions.type(f.session, { ref: "e1", text: "2026-13-45" })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringContaining("拒绝了这个值") });
    });

    it("空串只清空：不调 setter、不 insertText", async () => {
      const f = makeFake({ elements: { e1: mkEl("input", { type: "date" }) } });
      const wrote = withSetter(f, true);
      await actions.type(f.session, { ref: "e1", text: "" });
      expect(wrote).toEqual([]);
      expect(methods(f, "Input.insertText")).toEqual([]);
    });

    it("普通 text / email 框不受影响（仍 insertText）", async () => {
      const f = makeFake({ elements: { e1: mkEl("input", { type: "email" }) } });
      const wrote = withSetter(f, true);
      await actions.type(f.session, { ref: "e1", text: "a@b.co" });
      expect(wrote).toEqual([]);
      expect(methods(f, "Input.insertText")).toEqual([{ text: "a@b.co" }]);
    });

    it("TEMPORAL_INPUT_FORMATS：覆盖的类型与 INPUT_KIND_FN 的 textTypes 里的日期类一致", () => {
      expect(Object.keys(actions.TEMPORAL_INPUT_FORMATS).sort()).toEqual(["date", "datetime-local", "month", "time", "week"]);
      const src = actions.v1Internals.INPUT_KIND_FN as string;
      for (const t of Object.keys(actions.TEMPORAL_INPUT_FORMATS)) expect(src).toContain(`'${t}'`);
    });
  });

  it("普通文本框照常输入；摘要只写字符数，不含内容", async () => {
    const f = makeFake({ elements: { e1: mkEl("input", { type: "text", autocomplete: "email" }) } });
    await actions.type(f.session, { ref: "e1", text: "plain-value" });
    expect(methods(f, "Input.insertText")).toEqual([{ text: "plain-value" }]);
    expect(f.described[0].summary).toBe("在文本框「字段」输入了 11 个字符");
    expect(JSON.stringify(f.described)).not.toContain("plain-value");
  });

  it("isSecretField（fill_form 用）与 type 用同一规则：cc-* 与 text-security 也算", () => {
    expect(isSecretField({ type: "text", autocomplete: "cc-exp-year" })).toBe(true);
    expect(isSecretField({ type: "text", textSecurity: "disc" })).toBe(true);
    expect(isSecretField({ type: "text", autocomplete: "email" })).toBe(false);
  });
});

// ───────────────────────── R1-25：press_key ─────────────────────────

describe("R1-25 browser_press_key：焦点是敏感字段时拒绝会输入字符的键", () => {
  const PWD = mkEl("input", { type: "password" });
  const TEXT = mkEl("input", { type: "text" });
  const press = (f: ReturnType<typeof makeFake>, key: string, ref?: string) => actions.pressKey(f.session, { key, ...(ref ? { ref } : {}) });
  const keyEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchKeyEvent");

  it("pressKeyInsertsText：只有会写入字符的键为 true（Enter / Tab / 功能键 / Ctrl 组合键为 false）", () => {
    const ins = (k: string) => actions.pressKeyInsertsText(actions.parseKeyCombo(k));
    expect([ins("a"), ins("Shift+a"), ins("Space"), ins("5"), ins("@")]).toEqual([true, true, true, true, true]);
    expect([ins("Enter"), ins("Tab"), ins("Escape"), ins("ArrowDown"), ins("F5"), ins("Control+a"), ins("Meta+c"), ins("Shift")]).toEqual([
      false, false, false, false, false, false, false, false,
    ]);
  });

  it("无 ref：焦点（activeElement）是密码框 → 单字符 / 空格被拒，一个键盘事件都不发", async () => {
    const f = makeFake({ doc: { activeElement: PWD } });
    await expect(press(f, "a")).rejects.toMatchObject({ code: "BAD_ARGS", message: SECRET_PRESS_KEY_MESSAGE });
    await expect(press(f, "Space")).rejects.toMatchObject({ message: SECRET_PRESS_KEY_MESSAGE });
    expect(keyEvents(f)).toEqual([]);
  });

  it("焦点在敏感字段时 Enter / Tab / Control+a / 方向键不受限（用户填完后 AI 要能提交 / 切换）", async () => {
    const f = makeFake({ doc: { activeElement: PWD } });
    for (const k of ["Enter", "Tab", "Control+a", "ArrowDown", "Escape"]) await press(f, k);
    expect(keyEvents(f).length).toBeGreaterThanOrEqual(5);
  });

  it("焦点是普通输入框 / body：单字符照常发", async () => {
    const f1 = makeFake({ doc: { activeElement: TEXT } });
    await press(f1, "a");
    expect(keyEvents(f1).some((e) => e.key === "a")).toBe(true);
    const f2 = makeFake({ doc: { activeElement: mkEl("body") } });
    await press(f2, "j");
    expect(keyEvents(f2).some((e) => e.key === "j")).toBe(true);
  });

  it("焦点在 shadow root / 同源 iframe 里的密码框：穿透后同样拒绝", async () => {
    const host = mkEl("my-field", {}, { shadowRoot: { activeElement: mkEl("input", { type: "password" }) } });
    await expect(press(makeFake({ doc: { activeElement: host } }), "x")).rejects.toMatchObject({ message: SECRET_PRESS_KEY_MESSAGE });
    const frame = mkEl("iframe", {}, { contentDocument: { activeElement: mkEl("input", { type: "text", autocomplete: "cc-number" }) } });
    await expect(press(makeFake({ doc: { activeElement: frame } }), "x")).rejects.toMatchObject({ message: SECRET_PRESS_KEY_MESSAGE });
  });

  it("焦点在看不进去的跨域 iframe：确认不了就拒绝（单字符），提示传 ref；功能键仍可按", async () => {
    const cross = mkEl("iframe", {}, { contentDocument: null });
    const f = makeFake({ doc: { activeElement: cross } });
    await expect(press(f, "a")).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_FOCUS_PRESS_KEY_MESSAGE });
    await press(f, "Enter");
    expect(keyEvents(f).length).toBeGreaterThan(0);
  });

  it("有 ref：在该元素所在文档里查焦点；聚焦到密码框后单字符被拒", async () => {
    const f = makeFake({ elements: { e1: mkEl("input", { type: "password" }, { ownerDocument: { activeElement: PWD, defaultView: { getComputedStyle: () => ({}) } } }) } });
    await expect(press(f, "z", "e1")).rejects.toMatchObject({ message: SECRET_PRESS_KEY_MESSAGE });
    expect(keyEvents(f)).toEqual([]);
    expect(methods(f, "DOM.focus")).toHaveLength(1); // 先聚焦再查
  });
});

// ───────────────────────── R1-28：drag ─────────────────────────

describe("R1-28 drag：中途取消 / 出错必须补发 mouseReleased", () => {
  const two = () => ({ e1: mkEl("div"), e2: mkEl("div") });
  const mouseEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchMouseEvent");

  it("正常拖拽：恰好一次 mousePressed 与一次 mouseReleased（不会多补）", async () => {
    const f = makeFake({ elements: two() });
    await actions.drag(f.session, { fromRef: "e1", toRef: "e2" });
    const types = mouseEvents(f).map((e) => e.type);
    expect(types.filter((t) => t === "mousePressed")).toHaveLength(1);
    expect(types.filter((t) => t === "mouseReleased")).toHaveLength(1);
    expect(types.at(-1)).toBe("mouseReleased");
  });

  it("按下后被取消（ctx.check 抛 CANCELLED）：补发 mouseReleased（落在最后一个位置、buttons:0），错误照常抛出", async () => {
    const f = makeFake({ elements: two() });
    f.tab.__check = () => {
      if (mouseEvents(f).filter((e) => e.type === "mouseMoved" && e.buttons === 1).length >= 2) throw new BrowserError("CANCELLED", "用户停止了任务");
    };
    await expect(actions.drag(f.session, { fromRef: "e1", toRef: "e2" })).rejects.toMatchObject({ code: "CANCELLED" });
    const evs = mouseEvents(f);
    const pressed = evs.findIndex((e) => e.type === "mousePressed");
    const released = evs.findIndex((e) => e.type === "mouseReleased");
    expect(pressed).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThan(pressed);
    expect(evs[released]).toMatchObject({ button: "left", buttons: 0 });
    // 释放位置是取消时鼠标所在的位置（不是起点也不是终点）
    const lastMove = evs.filter((e) => e.type === "mouseMoved").at(-1);
    expect(evs[released].x).toBe(lastMove.x);
  });

  it("按下后 CDP 移动失败（抛错）同样补发 release；release 本身失败不盖掉原错误", async () => {
    const f = makeFake({ elements: two() });
    const origSend = f.tab.send;
    let moves = 0;
    f.tab.send = async (method: string, params: any) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1 && ++moves === 2) throw new Error("CDP 挂了");
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        f.sent.push({ method, params });
        throw new Error("release 也失败");
      }
      return origSend(method, params);
    };
    await expect(actions.drag(f.session, { fromRef: "e1", toRef: "e2" })).rejects.toThrow("CDP 挂了");
    expect(mouseEvents(f).filter((e) => e.type === "mouseReleased")).toHaveLength(1);
  });

  it("HTML5 拖放进行中被取消：先 dragCancel，再 mouseReleased", async () => {
    const f = makeFake({ elements: two() });
    const origSend = f.tab.send;
    f.tab.send = async (method: string, params: any) => {
      const r = await origSend(method, params);
      // 第一次带 buttons:1 的移动之后，页面发起 HTML5 拖放
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1) f.emitCdp("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
      return r;
    };
    f.tab.__check = () => {
      if (methods(f, "Input.dispatchDragEvent").length >= 2) throw new BrowserError("CANCELLED", "停止");
    };
    await expect(actions.drag(f.session, { fromRef: "e1", toRef: "e2" })).rejects.toMatchObject({ code: "CANCELLED" });
    const order = f.sent.filter((s) => s.method === "Input.dispatchDragEvent" || (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseReleased")).map((s) => s.params.type);
    expect(order.slice(-2)).toEqual(["dragCancel", "mouseReleased"]);
  });
});

// ───────────────────────── R1-28：mouse down 的按下态 ─────────────────────────

describe("R1-28 mouse：按下态不跨调用残留", () => {
  const harness = () => {
    const mouseEvents: any[] = [];
    const tab: any = {
      navCommitted: 0,
      ensureCdp: async () => {},
      layoutMetrics: async () => ({ viewportW: 100, viewportH: 80 }),
      setAI: async () => {},
      withAiInput: async (fn: () => Promise<unknown>) => fn(),
    };
    const I: any = {
      // R6-30 三轮复审 A：up 与补发 release 一律先探落点——这里的落点都是普通处，探针恒放行（探针本身的行为在 browser-r6b-mouse-held-release 里测）
      assertPointNotSecret: async () => {},
      aiScope: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
      beforeState: () => ({}),
      actionResult: () => ({ tabId: "t1" }),
      showAction: async () => {},
      mouse: async (_t: unknown, p: any) => void mouseEvents.push(p),
      mouseClickAt: async () => {},
      settle: async () => {},
    };
    const hooks: { check?: () => void } = {};
    const session: any = {
      runAction: async (o: any, fn: (ctx: any) => Promise<unknown>) =>
        fn({ tab, signal: o.signal, check: () => hooks.check?.(), describe: () => {} }),
    };
    const handlers = createHandlers({ actions: { v1Internals: I, modifierBits: actions.modifierBits }, requireSession: () => session });
    return { handlers, tab, mouseEvents, hooks };
  };
  const down = { action: "down", x: 5, y: 6, button: "left" };

  it("down 之后动作被取消（abort）：补发 mouseReleased 并清状态，下一次 move 不再带 buttons", async () => {
    const h = harness();
    h.hooks.check = () => {
      if (h.mouseEvents.some((e) => e.type === "mousePressed")) throw new BrowserError("CANCELLED", "停止");
    };
    await expect(h.handlers.mouse("t", down)).rejects.toMatchObject({ code: "CANCELLED" });
    const rel = h.mouseEvents.filter((e) => e.type === "mouseReleased");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ x: 5, y: 6, button: "left", buttons: 0 });
    expect(peekHeldButtons(h.tab).bits).toBe(0);

    h.hooks.check = undefined;
    h.mouseEvents.length = 0;
    await h.handlers.mouse("t", { action: "move", x: 30, y: 30, button: "left" });
    expect(h.mouseEvents.at(-1)).toMatchObject({ type: "mouseMoved", buttons: 0, button: "none" });
  });

  it("down → 正常结束 → 另一次动作参数不合法（坐标越界，未派发任何事件）：不误放已有的按下态", async () => {
    const h = harness();
    await h.handlers.mouse("t", down);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    await expect(h.handlers.mouse("t", { action: "move", x: 500, y: 500, button: "left" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(h.mouseEvents.filter((e) => e.type === "mouseReleased")).toHaveLength(0);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    // 合法 up 正常收尾
    await h.handlers.mouse("t", { action: "up", x: 5, y: 6, button: "left" });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
  });

  it("导航提交后按下态视为过期：下一次动作先补发 release，move 不带 buttons", async () => {
    const h = harness();
    await h.handlers.mouse("t", down);
    h.tab.navCommitted = 1;
    h.mouseEvents.length = 0;
    await h.handlers.mouse("t", { action: "move", x: 30, y: 30, button: "left" });
    expect(h.mouseEvents[0]).toMatchObject({ type: "mouseReleased", x: 5, y: 6, button: "left", buttons: 0 });
    expect(h.mouseEvents.at(-1)).toMatchObject({ type: "mouseMoved", buttons: 0 });
  });

  it("超过 HELD_BUTTON_TTL_MS 视为 AI 忘了抬起：peekHeldButtons 返回 stale 并不再算按下", async () => {
    const h = harness();
    await h.handlers.mouse("t", down);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    const late = peekHeldButtons(h.tab, Date.now() + HELD_BUTTON_TTL_MS + 1000);
    expect(late.bits).toBe(0);
    expect(late.stale).toMatchObject({ bits: 1, x: 5, y: 6 });
  });

  it("多键按下：release 逐键补发，buttons 逐步减少", async () => {
    const h = harness();
    await h.handlers.mouse("t", down);
    await h.handlers.mouse("t", { action: "down", x: 5, y: 6, button: "right" });
    h.mouseEvents.length = 0;
    h.hooks.check = () => {
      throw new BrowserError("USER_TOOK_OVER", "用户接管");
    };
    await expect(h.handlers.mouse("t", { action: "move", x: 9, y: 9, button: "left" })).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
    expect(h.mouseEvents.filter((e) => e.type === "mouseReleased").map((e) => [e.button, e.buttons])).toEqual([
      ["left", 2],
      ["right", 0],
    ]);
  });
});

// ───────────────────────── R2-03：type / press_key / drag 的残余出口 ─────────────────────────

describe("R2-03 type：探针 fail-closed + 聚焦后核对「实际焦点」", () => {
  const PWD = mkEl("input", { type: "password" });
  const frameDoc = (activeElement: FakeEl | null) => ({ activeElement, defaultView: { getComputedStyle: () => ({}) }, elementFromPoint: () => null });
  const typeInto = (f: ReturnType<typeof makeFake>, extra: Record<string, unknown> = {}) => actions.type(f.session, { ref: "e1", text: "hunter2", ...extra });
  const keyEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchKeyEvent");

  it("INPUT_KIND_FN 源码：探针初值与 catch 都是 secret=true（fail-closed，与其它探针同向）", () => {
    const src = actions.v1Internals.INPUT_KIND_FN as string;
    expect(src).toContain("var secret = true;");
    expect(src).toContain("catch (e) { secret = true; }");
    expect(src).not.toContain("secret = false");
  });

  it("探针没给出结论（返回空）：拒绝输入，文案是「无法确认」而不是「这是密码框」；不聚焦、不输入、不写活动日志", async () => {
    const f = makeFake({ elements: { e1: mkEl("input", { type: "text" }) } });
    const send = f.tab.send;
    f.tab.send = async (method: string, params: any = {}) => {
      if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("textTypes")) return { result: { value: undefined } };
      return send(method, params);
    };
    await expect(typeInto(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_FIELD_TYPE_MESSAGE });
    expect(methods(f, "Input.insertText")).toEqual([]);
    expect(methods(f, "DOM.focus")).toEqual([]);
    expect(f.described).toEqual([]);
  });

  it("ref 是普通容器，但聚焦后焦点落进了里面的密码框：在清空（Delete）与输入之前拒绝", async () => {
    const wrapper = mkEl("div", {}, { isContentEditable: true, ownerDocument: frameDoc(PWD) });
    const f = makeFake({ elements: { e1: wrapper } });
    await expect(typeInto(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: PASSWORD_REJECT_MESSAGE });
    expect(methods(f, "Input.insertText")).toEqual([]);
    expect(keyEvents(f)).toEqual([]); // contenteditable 清空会发 Delete 键：也不能发
  });

  it("聚焦后焦点落在看不进去的跨域 iframe：确认不了就拒绝，文案指向 ref / ask_user_to_act", async () => {
    const cross = mkEl("iframe", {}, { contentDocument: null });
    const f = makeFake({ elements: { e1: mkEl("div", {}, { ownerDocument: frameDoc(cross) }) } });
    await expect(typeInto(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_FOCUS_TYPE_MESSAGE });
    expect(methods(f, "Input.insertText")).toEqual([]);
  });

  it("清空脚本（CLEAR_FN 的 el.focus()）把焦点移进密码框：insertText 之前的二次确认拒绝（一个字符都没输入）", async () => {
    const doc: FakeEl = frameDoc(null);
    // 第一次确认时焦点还是 null（safe）；clear 里 el.focus() 之后才落到密码框
    const wrapper = mkEl("div", {}, { ownerDocument: doc, focus: () => { doc.activeElement = PWD; } });
    const f = makeFake({ elements: { e1: wrapper } });
    await expect(typeInto(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: PASSWORD_REJECT_MESSAGE });
    expect(methods(f, "Input.insertText")).toEqual([]);
  });

  it("对照：焦点就是普通输入框自己 → 照常输入（含 submit 的 Enter）", async () => {
    const input = mkEl("input", { type: "text" });
    (input.ownerDocument as FakeEl).activeElement = input;
    const f = makeFake({ elements: { e1: input } });
    await typeInto(f, { submit: true });
    expect(methods(f, "Input.insertText")).toEqual([{ text: "hunter2" }]);
    expect(keyEvents(f).some((e) => e.key === "Enter")).toBe(true);
  });
});

describe("R2-03 press_key：粘贴 / 剪切 / 复制类按键在敏感焦点下也拒绝", () => {
  const PWD = mkEl("input", { type: "password" });
  const press = (f: ReturnType<typeof makeFake>, key: string) => actions.pressKey(f.session, { key });
  const keyEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchKeyEvent");

  it("pressKeyTouchesText：文本键 + 粘贴 / 剪切 / 复制 + 原生键位为 true；全选 / 撤销 / Enter / Tab / 方向键为 false", () => {
    const t = (k: string) => actions.pressKeyTouchesText(actions.parseKeyCombo(k));
    expect(["a", "Space", "Control+v", "Meta+v", "Control+Shift+v", "Control+c", "Meta+x", "Shift+Insert", "Control+Insert", "Shift+Delete", "Control+y"].map(t)).toEqual(
      Array(11).fill(true),
    );
    expect(["Enter", "Tab", "Shift+Tab", "Escape", "ArrowDown", "Delete", "Backspace", "Control+a", "Meta+a", "Control+z", "Meta+z", "F5", "Insert"].map(t)).toEqual(
      Array(13).fill(false),
    );
  });

  it.each(["Control+v", "Meta+v", "Control+Shift+v", "Shift+Insert", "Control+Insert", "Shift+Delete", "Control+c", "Meta+x", "Control+y"])(
    "焦点是密码框：%s 被拒，一个键盘事件都不发",
    async (key) => {
      const f = makeFake({ doc: { activeElement: PWD } });
      await expect(press(f, key)).rejects.toMatchObject({ code: "BAD_ARGS", message: SECRET_PRESS_KEY_MESSAGE });
      expect(keyEvents(f)).toEqual([]);
    },
  );

  it("焦点是密码框：Control+a / Control+z / Enter / Tab 仍可按（用户填完后 AI 要能提交 / 切换）", async () => {
    const f = makeFake({ doc: { activeElement: PWD } });
    for (const k of ["Control+a", "Control+z", "Enter", "Tab"]) await press(f, k);
    expect(keyEvents(f).length).toBeGreaterThanOrEqual(4);
  });

  it("焦点是普通输入框：Control+v 照常发（并带 paste 编辑命令）", async () => {
    const f = makeFake({ doc: { activeElement: mkEl("input", { type: "text" }) } });
    // R6-07：粘贴键现在要求系统剪贴板 == AI 本轮 browser_clipboard write 写入的内容；这里模拟「AI 写过且没被改」，被拒的情形见 browser-r6-s2-paste-clipboard.test.ts
    const ledger = createAiWriteLedger();
    ledger.record("AI 写的");
    (f.session as any).getExt = () => ledger;
    await actions.pressKey(f.session, { key: "Control+v" }, { clipboard: { readText: () => "AI 写的" } });
    expect(keyEvents(f).some((e) => Array.isArray(e.commands) && e.commands.includes("paste"))).toBe(true);
  });

  it("焦点在看不进去的跨域 iframe：粘贴同样拒绝（确认不了）", async () => {
    const f = makeFake({ doc: { activeElement: mkEl("iframe", {}, { contentDocument: null }) } });
    await expect(press(f, "Control+v")).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_FOCUS_PRESS_KEY_MESSAGE });
  });
});

describe("R2-03 drag：拖放目标（落点）是敏感字段时拒绝", () => {
  const PWD = (): FakeEl => mkEl("input", { type: "password" });
  const mouseEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchMouseEvent");
  const dragTo = (f: ReturnType<typeof makeFake>) => actions.drag(f.session, { fromRef: "e1", toRef: "e2" });
  const withPointHit = (hit: FakeEl | null, extra: FakeEl = {}) => {
    const doc = { elementFromPoint: () => hit, defaultView: { getComputedStyle: () => ({}) } };
    return mkEl("div", {}, { ownerDocument: doc, ...extra });
  };

  it("目标元素本身就是密码框：拒绝，没有任何鼠标事件", async () => {
    const f = makeFake({ elements: { e1: mkEl("div"), e2: PWD() } });
    await expect(dragTo(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: SECRET_DROP_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
  });

  it("目标是容器、落点处（elementFromPoint）是密码框 / cc-* 字段：拒绝", async () => {
    const f1 = makeFake({ elements: { e1: mkEl("div"), e2: withPointHit(PWD()) } });
    await expect(dragTo(f1)).rejects.toMatchObject({ message: SECRET_DROP_MESSAGE });
    const f2 = makeFake({ elements: { e1: mkEl("div"), e2: withPointHit(mkEl("input", { type: "text", autocomplete: "cc-number" })) } });
    await expect(dragTo(f2)).rejects.toMatchObject({ message: SECRET_DROP_MESSAGE });
    expect(mouseEvents(f1)).toEqual([]);
  });

  it("落点在 open shadow root / 同源 iframe 里的密码框：穿透后同样拒绝", async () => {
    const host = mkEl("my-field", {}, { shadowRoot: { elementFromPoint: () => PWD() } });
    const f1 = makeFake({ elements: { e1: mkEl("div"), e2: withPointHit(host) } });
    await expect(dragTo(f1)).rejects.toMatchObject({ message: SECRET_DROP_MESSAGE });
    const frame = mkEl("iframe", {}, { getBoundingClientRect: () => ({ left: 0, top: 0 }), contentDocument: { elementFromPoint: () => PWD() } });
    const f2 = makeFake({ elements: { e1: mkEl("div"), e2: withPointHit(frame) } });
    await expect(dragTo(f2)).rejects.toMatchObject({ message: SECRET_DROP_MESSAGE });
  });

  it("落点在看不进去的跨域 iframe：确认不了就拒绝（另一句文案）", async () => {
    const cross = mkEl("iframe", {}, { contentDocument: null });
    const f = makeFake({ elements: { e1: mkEl("div"), e2: withPointHit(cross) } });
    await expect(dragTo(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_DROP_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
  });

  it("探针执行本身抛错：拒绝（fail-closed）", async () => {
    const f = makeFake({ elements: { e1: mkEl("div"), e2: mkEl("div", {}, { ownerDocument: { elementFromPoint: () => { throw new Error("x"); }, defaultView: {} } }) } });
    await expect(dragTo(f)).rejects.toMatchObject({ message: UNKNOWN_DROP_MESSAGE });
  });

  it("对照：落点是普通元素 → 照常拖拽（一次 mousePressed + 一次 mouseReleased）", async () => {
    const f = makeFake({ elements: { e1: mkEl("div"), e2: withPointHit(mkEl("input", { type: "text" })) } });
    await dragTo(f);
    const types = mouseEvents(f).map((e) => e.type);
    expect(types.filter((t) => t === "mousePressed")).toHaveLength(1);
    expect(types.filter((t) => t === "mouseReleased")).toHaveLength(1);
  });
});

// ───────────────────────── R2-08：R1-28 的残余 ─────────────────────────

describe("R2-08 showAction：被打断 / 已收尾的动作不再点亮页内覆盖层", () => {
  const target = { point: { x: 1, y: 2 }, rect: { x: 0, y: 0, width: 10, height: 10 } };
  const fakeTab = () => {
    const calls: unknown[] = [];
    return { tab: { overlayShowAction: async (p: unknown) => void calls.push(p) } as any, calls };
  };

  it("ctx.signal 已 abort：不调 overlayShowAction", async () => {
    const { tab, calls } = fakeTab();
    const ac = new AbortController();
    ac.abort(new BrowserError("USER_TOOK_OVER", "接管"));
    await actions.v1Internals.showAction(tab, target, "点击", "click", { signal: ac.signal });
    expect(calls).toEqual([]);
  });

  it("ctx.isActive() 为 false（本次 runAction 已收尾 / 被打断）：不调 overlayShowAction", async () => {
    const { tab, calls } = fakeTab();
    await actions.v1Internals.showAction(tab, target, "点击", "click", { signal: new AbortController().signal, isActive: () => false });
    expect(calls).toEqual([]);
  });

  it("对照：ctx 仍然活着 / 没传 ctx → 照常点亮", async () => {
    const a = fakeTab();
    await actions.v1Internals.showAction(a.tab, target, "点击", "click", { signal: new AbortController().signal, isActive: () => true });
    const b = fakeTab();
    await actions.v1Internals.showAction(b.tab, target, "点击", "click");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("actions.mjs 的四个调用点（click / hover / type / drag）与 ops/input.mjs 的 mouse 都把 ctx 传给 showAction", () => {
    const src = readFileSync(new URL("../electron-app/browser/actions.mjs", import.meta.url), "utf8");
    const calls = src.match(/await showAction\([^\n]*\);/g) ?? [];
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c).toMatch(/, ctx\);$/);
    const input = readFileSync(new URL("../electron-app/browser/ops/input.mjs", import.meta.url), "utf8");
    expect(input).toMatch(/I\.showAction\([^\n]*, ctx\);/);
  });
});

describe("R2-08 drag：held 前移、dragEnter 失败也 dragCancel", () => {
  const two = () => ({ e1: mkEl("div"), e2: mkEl("div") });
  const mouseEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchMouseEvent");

  it("mousePressed 本身超时抛错（页面其实已处理）：仍补发 mouseReleased，原错误照常抛出", async () => {
    const f = makeFake({ elements: two() });
    const origSend = f.tab.send;
    f.tab.send = async (method: string, params: any) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        f.sent.push({ method, params });
        throw new Error("mousePressed 超时");
      }
      return origSend(method, params);
    };
    await expect(actions.drag(f.session, { fromRef: "e1", toRef: "e2" })).rejects.toThrow("mousePressed 超时");
    expect(mouseEvents(f).filter((e) => e.type === "mouseReleased")).toHaveLength(1);
  });

  it("dragEnter 失败（HTML5 拖放已被页面接管）：补发 dragCancel，再 mouseReleased", async () => {
    const f = makeFake({ elements: two() });
    const origSend = f.tab.send;
    f.tab.send = async (method: string, params: any) => {
      if (method === "Input.dispatchDragEvent" && params.type === "dragEnter") {
        f.sent.push({ method, params });
        throw new Error("dragEnter 超时");
      }
      const r = await origSend(method, params);
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1) f.emitCdp("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
      return r;
    };
    await expect(actions.drag(f.session, { fromRef: "e1", toRef: "e2" })).rejects.toThrow("dragEnter 超时");
    const order = f.sent.filter((s) => s.method === "Input.dispatchDragEvent" || (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseReleased")).map((s) => s.params.type);
    expect(order.slice(-2)).toEqual(["dragCancel", "mouseReleased"]);
  });
});

describe("R2-08 mouse：空闲 TTL（move / wheel 续期）与对外的释放入口", () => {
  afterEach(() => vi.useRealTimers());

  const harness = () => {
    const mouseEvents: any[] = [];
    const tab: any = {
      navCommitted: 0,
      ensureCdp: async () => {},
      layoutMetrics: async () => ({ viewportW: 100, viewportH: 80 }),
      setAI: async () => {},
      withAiInput: async (fn: () => Promise<unknown>) => fn(),
    };
    const I: any = {
      // R6-30 复审：补发 release 时，已被拖离起点的「最后位置」要先过落点探针；这里的页面全是普通元素 → 探针恒通过（探针判不安全时的行为见 browser-r6b-mouse-held-release.test.ts）
      assertPointNotSecret: async () => {},
      aiScope: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
      beforeState: () => ({}),
      actionResult: () => ({ tabId: "t1" }),
      showAction: async () => {},
      mouse: async (_t: unknown, p: any) => void mouseEvents.push(p),
      mouseClickAt: async () => {},
      settle: async () => {},
    };
    const session: any = {
      runAction: async (o: any, fn: (ctx: any) => Promise<unknown>) => fn({ tab, signal: o.signal, check: () => {}, describe: () => {} }),
    };
    const handlers = createHandlers({ actions: { v1Internals: I, modifierBits: actions.modifierBits }, requireSession: () => session });
    return { handlers, tab, mouseEvents };
  };
  const down = { action: "down", x: 5, y: 6, button: "left" };

  it("按住期间的 move 续期：距离 down 超过 TTL，只要中间有 move，按下态仍有效；停止 move 满 TTL 才过期", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const h = harness();
    await h.handlers.mouse("t", down);
    vi.setSystemTime(1_000_000 + HELD_BUTTON_TTL_MS - 5_000);
    await h.handlers.mouse("t", { action: "move", x: 20, y: 20, button: "left" });
    vi.setSystemTime(1_000_000 + HELD_BUTTON_TTL_MS + 60_000); // 距 down 已 > TTL，但距最近一次 move 才 65s
    expect(peekHeldButtons(h.tab).bits).toBe(1);
    vi.setSystemTime(1_000_000 + HELD_BUTTON_TTL_MS - 5_000 + HELD_BUTTON_TTL_MS + 1); // 距最近一次 move 超过 TTL
    const late = peekHeldButtons(h.tab);
    expect(late.bits).toBe(0);
    // 将来补 release 的位置是最近一次 move 的位置，不是 down 的位置
    expect(late.stale).toMatchObject({ x: 20, y: 20 });
  });

  it("按住期间的 wheel 同样续期；没按下时 move 不会凭空造出按下态", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const h = harness();
    await h.handlers.mouse("t", { action: "move", x: 3, y: 3, button: "left" });
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    await h.handlers.mouse("t", down);
    vi.setSystemTime(2_000_000 + HELD_BUTTON_TTL_MS - 1_000);
    await h.handlers.mouse("t", { action: "wheel", x: 9, y: 9, button: "left", deltaY: 40 });
    vi.setSystemTime(2_000_000 + HELD_BUTTON_TTL_MS + 30_000);
    expect(peekHeldButtons(h.tab).bits).toBe(1);
  });

  it("down 之后 tab 上有 releaseHeldButtons 入口：调用后在最近位置补发 mouseReleased 并清状态；幂等", async () => {
    const h = harness();
    expect(h.tab.releaseHeldButtons).toBeUndefined();
    await h.handlers.mouse("t", down);
    expect(typeof h.tab.releaseHeldButtons).toBe("function");
    await h.handlers.mouse("t", { action: "move", x: 40, y: 30, button: "left" });
    h.mouseEvents.length = 0;
    await h.tab.releaseHeldButtons();
    expect(h.mouseEvents).toEqual([expect.objectContaining({ type: "mouseReleased", x: 40, y: 30, button: "left", buttons: 0 })]);
    expect(peekHeldButtons(h.tab).bits).toBe(0);
    h.mouseEvents.length = 0;
    await h.tab.releaseHeldButtons(); // 没有按下态：无操作
    expect(h.mouseEvents).toEqual([]);
  });

  it("入口在 withAiInput 里发（release 事件归因给 AI，不会被录成用户操作）；withAiInput 抛错也退化直发并不抛出", async () => {
    const h = harness();
    await h.handlers.mouse("t", down);
    const calls: string[] = [];
    h.tab.withAiInput = async (fn: () => Promise<unknown>) => {
      calls.push("wrapped");
      return fn();
    };
    await h.tab.releaseHeldButtons();
    expect(calls).toEqual(["wrapped"]);

    await h.handlers.mouse("t", down);
    h.tab.withAiInput = async () => {
      throw new Error("tab 已销毁");
    };
    h.mouseEvents.length = 0;
    await expect(h.tab.releaseHeldButtons()).resolves.toBeUndefined();
    expect(h.mouseEvents.filter((e) => e.type === "mouseReleased")).toHaveLength(1);
  });
});

// ───────────────────────── R2-03 复审：读取失败 ≠ 安全 / 落点探不到 ≠ 安全 / 按键判定与主进程同源 ─────────────────────────

describe("R2-03 复审① readSecretInfo：任何一项读取抛错都记 uncertain，isSecretInfo 对它返回 true（fail-closed）", () => {
  const win = { getComputedStyle: () => ({ webkitTextSecurity: "", getPropertyValue: () => "" }) };
  const base = (extra: FakeEl = {}): FakeEl => ({
    nodeType: 1,
    tagName: "INPUT",
    type: "text",
    getAttribute: () => null,
    ownerDocument: { defaultView: win },
    ...extra,
  });
  const verdict = (el: FakeEl) => isSecretInfo(readSecretInfo(el));

  it("对照：普通文本框 / 密码框 / 空值照常判定，uncertain 不会误出现", () => {
    expect(verdict(base())).toBe(false);
    expect(readSecretInfo(base())).not.toHaveProperty("uncertain");
    expect(verdict(base({ type: "password" }))).toBe(true);
    expect(verdict(null as never)).toBe(false);
    expect(isSecretInfo({ uncertain: true })).toBe(true);
  });

  it("`el.type` 的访问器抛错 / `getAttribute` 抛错 / `getComputedStyle` 抛错 / `nodeType` 访问器抛错：都按敏感", () => {
    const boom = () => {
      throw new Error("hostile");
    };
    // 访问器要在 base() 之后再装（对象展开会当场调用 getter）
    const throwing = (name: string): FakeEl => {
      const el = base();
      Object.defineProperty(el, name, { get: boom, configurable: true });
      return el;
    };
    expect(verdict(throwing("type"))).toBe(true);
    expect(verdict(base({ getAttribute: boom }))).toBe(true);
    expect(verdict(base({ ownerDocument: { defaultView: { getComputedStyle: boom } } }))).toBe(true);
    expect(verdict(throwing("nodeType"))).toBe(true);
  });

  it("只有某一个属性读取抛错也按敏感：getAttribute 仅对 type 抛 / 仅对 autocomplete 抛（逐项各自把关，不能靠别的项的 catch 顶）", () => {
    const onlyFor = (attr: string) => (name: string) => {
      if (name === attr) throw new Error("hostile");
      return null;
    };
    expect(verdict(base({ getAttribute: onlyFor("type") }))).toBe(true);
    expect(verdict(base({ getAttribute: onlyFor("autocomplete") }))).toBe(true);
    // 对照：对别的属性抛错不影响（只读 type / autocomplete）
    expect(verdict(base({ getAttribute: onlyFor("data-x") }))).toBe(false);
  });

  it("非元素节点（document / 文本节点）不可能是输入框：读样式抛错也不算不确定（否则 document 上的事件会被整条丢）", () => {
    const boom = () => {
      throw new Error("not an element");
    };
    expect(verdict({ nodeType: 9, ownerDocument: null, getAttribute: boom, defaultView: { getComputedStyle: boom } })).toBe(false);
    expect(verdict({ nodeType: 3 })).toBe(false);
  });

  it("探针链路：ACTIVE_SECRET_PROBE / DROP_TARGET_SECRET_PROBE 在读取抛错的焦点 / 落点元素上给出 secret（不再当 safe）", () => {
    const hostile = mkEl("input", {}, { getAttribute: () => { throw new Error("hostile"); } });
    expect(runInPage(ACTIVE_SECRET_PROBE_SOURCE, null, { activeElement: hostile })).toBe("secret");
    const doc = { elementFromPoint: () => hostile, defaultView: { getComputedStyle: () => ({ webkitTextSecurity: "", getPropertyValue: () => "" }) } };
    const target = mkEl("div", {}, { ownerDocument: doc });
    expect(runInPage(DROP_TARGET_SECRET_PROBE_SOURCE, target, undefined, [10, 10])).toBe("secret");
  });
});

describe("R2-03 复审② drag 落点探针：探不到元素按 unknown 拒（不是 safe）", () => {
  const mouseEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchMouseEvent");
  const dragTo = (f: ReturnType<typeof makeFake>) => actions.drag(f.session, { fromRef: "e1", toRef: "e2" });
  const docWith = (hit: FakeEl | null) => ({ elementFromPoint: () => hit, defaultView: { getComputedStyle: () => ({ webkitTextSecurity: "", getPropertyValue: () => "" }) } });

  it("落点 elementFromPoint 为 null（视口外 / 坐标系对不上）：拒绝，一个鼠标事件都不发", () => {
    const target = mkEl("div", {}, { ownerDocument: docWith(null) });
    expect(runInPage(DROP_TARGET_SECRET_PROBE_SOURCE, target, undefined, [5, 5])).toBe("unknown");
    const f = makeFake({ elements: { e1: mkEl("div"), e2: target } });
    return expect(dragTo(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_DROP_MESSAGE }).then(() => expect(mouseEvents(f)).toEqual([]));
  });

  it("同进程 iframe 里探不到元素（innerEl 为 null）：拒绝，不拿 iframe 元素自己充数；页内探针对 iframe 内普通元素仍判 safe，但 R6-30 起 CDP 复核对落进 iframe 一律 unknown（fail-closed）→ 整体拒", async () => {
    const frameWith = (inner: FakeEl | null) => mkEl("iframe", {}, { getBoundingClientRect: () => ({ left: 0, top: 0 }), contentDocument: { elementFromPoint: () => inner } });
    const target = mkEl("div", {}, { ownerDocument: docWith(frameWith(null)) });
    expect(runInPage(DROP_TARGET_SECRET_PROBE_SOURCE, target, undefined, [5, 5])).toBe("unknown");
    const ok = mkEl("div", {}, { ownerDocument: docWith(frameWith(mkEl("input", { type: "text" }))) });
    expect(runInPage(DROP_TARGET_SECRET_PROBE_SOURCE, ok, undefined, [5, 5])).toBe("safe");
    const f = makeFake({ elements: { e1: mkEl("div"), e2: ok } });
    // R6-30：iframe 内即使页内探针读得进，也可能藏着 closed root 里的密码框；CDP 复核不做 iframe 偏移，命中 iframe 就拒（不发任何鼠标事件）
    await expect(dragTo(f)).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_DROP_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
  });
});

describe("R2-03 复审③ keyTypesCharacter 与主进程 parseKeyCombo 同一套切分（带空白的写法不能漏藏）", () => {
  it("带前后空白 / 段内空白的写法：主进程按成字符 a 执行，这里也必须判成「打出字符」", () => {
    for (const spec of [" a", "a ", " a ", "Shift+ a", "shift + a", " Shift+a", "Shift +a", "Alt + @", "AltGr+ Z"]) {
      expect(keyTypesCharacter(spec), spec).toBe(true);
    }
  });

  it("不会打出字符的写法照旧不隐藏（含带空白的）", () => {
    for (const spec of ["Enter", " Enter ", "Control+a", "Control + a", "Meta + Enter", "Tab", " F5", "Shift + Tab", "", "   "]) {
      expect(keyTypesCharacter(spec), JSON.stringify(spec)).toBe(false);
    }
  });

  it("「Shift++」与带空白的字面量加号：最后一段是 +", () => {
    expect(keyTypesCharacter("Shift++")).toBe(true);
    expect(keyTypesCharacter(" Shift + + ")).toBe(false); // parseKeyCombo 对它（尾部 "+ +"）会按空段报格式错误，不会执行；不隐藏也不泄漏
    expect(keyTypesCharacter("Control++")).toBe(false);
  });

  it("交叉校验：凡是 parseKeyCombo 会给出非空白 text 的写法，keyTypesCharacter 必须为 true（宁多藏、不漏藏）", () => {
    const specs = [" a", "a ", "Shift+ a", "shift + a", "A", "Shift+a", "7", "@", " @ ", "龘", "Shift+;", " Shift + ; ", "z", "Shift++", "Shift+ +"];
    for (const spec of specs) {
      let parsed: ReturnType<typeof actions.parseKeyCombo> | null = null;
      try {
        parsed = actions.parseKeyCombo(spec);
      } catch {
        continue; // 主进程拒绝的写法不会执行，不涉及泄漏
      }
      const typed = typeof parsed.text === "string" && parsed.text.trim() !== "";
      if (typed) expect(keyTypesCharacter(spec), JSON.stringify(spec)).toBe(true);
    }
  });
});

describe("R4-02 探针 guard 耗尽：嵌套超过 20 层按 unknown 拒（不是把中间节点当 safe 放行）", () => {
  const SAFE = () => mkEl("input", { type: "text" });
  const PWD = () => mkEl("input", { type: "password" });
  const docOf = (hit: FakeEl | null) => ({
    elementFromPoint: () => hit,
    defaultView: { getComputedStyle: () => ({ webkitTextSecurity: "", getPropertyValue: () => "" }) },
  });

  /** depth 层 shadow 宿主，最深处是 leaf；返回最外层宿主 */
  const activeChain = (depth: number, leaf: FakeEl): FakeEl => {
    let el = leaf;
    for (let i = 0; i < depth; i += 1) {
      const inner = el;
      el = mkEl("my-field", {}, { shadowRoot: { activeElement: inner } });
    }
    return el;
  };
  const pointChain = (depth: number, leaf: FakeEl): FakeEl => {
    let el = leaf;
    for (let i = 0; i < depth; i += 1) {
      const inner = el;
      el = mkEl("my-field", {}, { shadowRoot: { elementFromPoint: () => inner } });
    }
    return el;
  };
  const activeVerdict = (depth: number, leaf: FakeEl) => runInPage(ACTIVE_SECRET_PROBE_SOURCE, null, { activeElement: activeChain(depth, leaf) });
  const dropVerdict = (depth: number, leaf: FakeEl) => {
    const target = mkEl("div", {}, { ownerDocument: docOf(pointChain(depth, leaf)) });
    return runInPage(DROP_TARGET_SECRET_PROBE_SOURCE, target, undefined, [5, 5]);
  };

  it("焦点探针：19 层以内照常探到最深处（secret / safe 都对）；20 层起一律 unknown，不管最深处是什么", () => {
    for (const depth of [0, 1, 5, 19]) {
      expect(activeVerdict(depth, PWD()), `depth=${depth}`).toBe("secret");
      expect(activeVerdict(depth, SAFE()), `depth=${depth}`).toBe("safe");
    }
    for (const depth of [20, 21, 25, 200]) {
      expect(activeVerdict(depth, PWD()), `depth=${depth}`).toBe("unknown");
      expect(activeVerdict(depth, SAFE()), `depth=${depth}`).toBe("unknown");
    }
  });

  it("落点探针：同口径——19 层以内探到最深处，20 层起 unknown", () => {
    for (const depth of [0, 1, 5, 19]) {
      expect(dropVerdict(depth, PWD()), `depth=${depth}`).toBe("secret");
      expect(dropVerdict(depth, SAFE()), `depth=${depth}`).toBe("safe");
    }
    for (const depth of [20, 21, 25, 200]) {
      expect(dropVerdict(depth, PWD()), `depth=${depth}`).toBe("unknown");
      expect(dropVerdict(depth, SAFE()), `depth=${depth}`).toBe("unknown");
    }
  });

  it("链路：press_key 在 21 层嵌套里的焦点上被拒（不是放行），drag 的落点同样被拒且一个鼠标事件都不发", async () => {
    const deepFocus = activeChain(21, PWD());
    const f = makeFake({ doc: { activeElement: deepFocus } });
    await expect(actions.pressKey(f.session, { key: "a" })).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_FOCUS_PRESS_KEY_MESSAGE });
    expect(methods(f, "Input.dispatchKeyEvent")).toEqual([]);

    const target = mkEl("div", {}, { ownerDocument: docOf(pointChain(21, PWD())) });
    const g = makeFake({ elements: { e1: mkEl("div"), e2: target } });
    await expect(actions.drag(g.session, { fromRef: "e1", toRef: "e2" })).rejects.toMatchObject({ code: "BAD_ARGS", message: UNKNOWN_DROP_MESSAGE });
    expect(methods(g, "Input.dispatchMouseEvent")).toEqual([]);
  });
});

describe("R6-07 press_key 粘贴键：只放行「AI 本轮 browser_clipboard write 写入」的系统剪贴板", () => {
  const keyEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchKeyEvent");
  const setup = (opts: { written?: string; clip?: string | undefined | "throw"; noLedger?: boolean }) => {
    const f = makeFake({ doc: { activeElement: mkEl("input", { type: "text" }) } });
    const ledger = createAiWriteLedger();
    if (opts.written !== undefined) ledger.record(opts.written);
    if (!opts.noLedger) (f.session as any).getExt = () => ledger;
    const clipboard = {
      readText: () => {
        if (opts.clip === "throw") throw new Error("clipboard busy");
        return opts.clip as string;
      },
    };
    return { f, clipboard, press: (key: string) => actions.pressKey(f.session, { key }, { clipboard }) };
  };
  const PASTE_KEYS = ["Control+v", "Control+V", "Meta+v", "Shift+Control+v", "Control+Shift+v", "Shift+Insert", "shift+insert"];

  it.each(PASTE_KEYS)("%s：剪贴板与 AI 写入一致 → 放行并派发按键", async (key) => {
    const s = setup({ written: "AI 写的内容", clip: "AI 写的内容" });
    await s.press(key);
    expect(keyEvents(s.f).length).toBeGreaterThan(0);
  });

  it.each(PASTE_KEYS)("%s：用户在 AI 写入之后又复制了别的内容 → 拒绝，一个键盘事件都不发，文案里不含用户剪贴板原文", async (key) => {
    const s = setup({ written: "AI 写的内容", clip: "用户的密码 pw-USER-123" });
    const err: any = await s.press(key).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BAD_ARGS", message: PASTE_NOT_AI_CLIPBOARD_MESSAGE });
    expect(String(err.message)).not.toContain("pw-USER-123");
    expect(keyEvents(s.f)).toEqual([]);
  });

  it("AI 从未写入过（账本空）→ 拒绝；没有账本（session 不支持 getExt）→ 拒绝", async () => {
    await expect(setup({ clip: "任意内容" }).press("Control+v")).rejects.toMatchObject({ message: PASTE_NOT_AI_CLIPBOARD_MESSAGE });
    await expect(setup({ clip: "任意内容", noLedger: true }).press("Meta+v")).rejects.toMatchObject({ message: PASTE_NOT_AI_CLIPBOARD_MESSAGE });
  });

  it("读不到系统剪贴板（readText 抛错 / 没注入 clipboard / 返回非字符串）→ 拒绝（fail-closed）", async () => {
    const thrown = setup({ written: "x", clip: "throw" });
    await expect(thrown.press("Control+v")).rejects.toMatchObject({ message: PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE });
    const none = setup({ written: "x", clip: undefined });
    await expect(none.press("Control+v")).rejects.toMatchObject({ message: PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE });
    const f = makeFake({ doc: { activeElement: mkEl("input", { type: "text" }) } });
    const ledger = createAiWriteLedger();
    ledger.record("x");
    (f.session as any).getExt = () => ledger;
    await expect(actions.pressKey(f.session, { key: "Control+v" })).rejects.toMatchObject({ message: PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE });
  });

  it("非粘贴键不受影响：Control+c / Control+a / Enter / 普通字符，无需账本与剪贴板", async () => {
    const s = setup({ clip: "用户的内容", noLedger: true });
    for (const k of ["Control+a", "Control+c", "Enter", "a", "Control+Insert"]) await s.press(k);
    expect(keyEvents(s.f).length).toBeGreaterThanOrEqual(5);
  });

  it("焦点是密码框时仍先报「敏感焦点」（更具体的拒绝优先于粘贴闸门）", async () => {
    const f = makeFake({ doc: { activeElement: mkEl("input", { type: "password" }) } });
    const ledger = createAiWriteLedger();
    (f.session as any).getExt = () => ledger;
    await expect(actions.pressKey(f.session, { key: "Control+v" }, { clipboard: { readText: () => "x" } })).rejects.toMatchObject({ message: SECRET_PRESS_KEY_MESSAGE });
  });
});

// ───────────────────────── R6-30 三轮复审 B：按着键时其它点击路径先拒 ─────────────────────────

describe("R6-30 三轮复审 B：tab 上还有 AI 按着没放的鼠标键时，真 actions 的 click / type 点击兜底 / drag 先拒、不发任何鼠标事件", () => {
  const two = () => ({ e1: mkEl("div"), e2: mkEl("div") });
  const mouseEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchMouseEvent");

  it("actions.click（也是 fill_form 的 checked / 提交点击的主体 clickBody）：BAD_ARGS（HELD_BUTTON_CLICK_MESSAGE），0 个鼠标事件；放开之后恢复", async () => {
    const f = makeFake({ elements: two() });
    f.tab.heldButtonBits = () => 1;
    await expect(actions.click(f.session, { ref: "e1" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
    f.tab.heldButtonBits = () => 0; // browser_mouse up 之后
    await actions.click(f.session, { ref: "e1" });
    expect(mouseEvents(f).map((e) => e.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("actions.click 的右键 / 双击 / 带修饰键同样先拒", async () => {
    const f = makeFake({ elements: two() });
    f.tab.heldButtonBits = () => 2;
    for (const args of [{ ref: "e1", button: "right" }, { ref: "e1", doubleClick: true }, { ref: "e1", modifiers: ["Control"] }]) {
      await expect(actions.click(f.session, args as any), JSON.stringify(args)).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    }
    expect(mouseEvents(f)).toEqual([]);
  });

  it("actions.drag：先拒，既不 mousePressed 也不开拖放拦截（不会把按住的那次拖放结束在 drag 的落点上）", async () => {
    const f = makeFake({ elements: two() });
    f.tab.heldButtonBits = () => 1;
    await expect(actions.drag(f.session, { fromRef: "e1", toRef: "e2" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
    expect(methods(f, "Input.setInterceptDrags")).toEqual([]);
    f.tab.heldButtonBits = () => 0;
    await actions.drag(f.session, { fromRef: "e1", toRef: "e2" });
    expect(mouseEvents(f).filter((e) => e.type === "mouseReleased")).toHaveLength(1);
  });

  it("actions.type 的点击兜底（DOM.focus 失败 → 点中心）：先拒，0 个鼠标事件、没有 insertText", async () => {
    const f = makeFake({ elements: { e1: mkEl("input", { type: "text" }) } });
    const rawSend = f.tab.send;
    f.tab.send = async (method: string, params: any, ...rest: any[]) => {
      if (method === "DOM.focus") throw new Error("not focusable");
      return rawSend(method, params, ...rest);
    };
    f.tab.heldButtonBits = () => 1;
    await expect(actions.type(f.session, { ref: "e1", text: "hello" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
    expect(methods(f, "Input.insertText")).toEqual([]);
  });

  it("actions.hover（R6-30 四轮复审 P3①）：先拒，0 个鼠标事件（不会把指针挪到没探过的位置）；放开之后恢复", async () => {
    const f = makeFake({ elements: two() });
    f.tab.heldButtonBits = () => 1;
    await expect(actions.hover(f.session, { ref: "e1" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
    f.tab.heldButtonBits = () => 4; // 中键按着同样拒
    await expect(actions.hover(f.session, { ref: "e1" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
    f.tab.heldButtonBits = () => 0; // browser_mouse up 之后
    await actions.hover(f.session, { ref: "e1" });
    expect(mouseEvents(f).map((e) => e.type)).toEqual(["mouseMoved", "mouseMoved"]);
  });

  it("actions.hover：读取按下态出错（heldButtonBits 抛错）同样按「按着」拒（fail-closed）", async () => {
    const f = makeFake({ elements: two() });
    f.tab.heldButtonBits = () => {
      throw new Error("boom");
    };
    await expect(actions.hover(f.session, { ref: "e1" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
  });

  it("读取按下态本身出错（heldButtonBits 抛错）按「按着」处理（fail-closed）", async () => {
    const f = makeFake({ elements: two() });
    f.tab.heldButtonBits = () => {
      throw new Error("boom");
    };
    await expect(actions.click(f.session, { ref: "e1" })).rejects.toMatchObject({ code: "BAD_ARGS", message: HELD_BUTTON_CLICK_MESSAGE });
    expect(mouseEvents(f)).toEqual([]);
  });

  it("对照（不误伤）：从没挂过 heldButtonBits（从没 down 过）的 tab，click / drag / hover 照常", async () => {
    const f = makeFake({ elements: two() });
    expect(f.tab.heldButtonBits).toBeUndefined();
    await actions.click(f.session, { ref: "e1" });
    await actions.drag(f.session, { fromRef: "e1", toRef: "e2" });
    await actions.hover(f.session, { ref: "e1" });
    expect(mouseEvents(f).filter((e) => e.type === "mousePressed")).toHaveLength(2);
  });
});
