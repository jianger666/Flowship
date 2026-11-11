/* eslint-disable @typescript-eslint/no-explicit-any -- 假 session / tab / 页面环境与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R1 评审 sc 组（输入保密 + 拖拽 / 鼠标收尾）的主进程侧单测。
 * 产品决策：不再限制 AI 往密码 / 验证码 / 银行卡类输入框里输入——secret-field 的判定只用于「读」这一侧：
 * - 写入侧（正向）：browser_type / fill_form 的 value / browser_press_key 对这类字段照常输入 / 派发，不探字段类型、不探焦点、不抛 BAD_ARGS；
 *   「写入被拒」那批用例（拒绝文案、焦点 / 落点探针、鼠标键按住时拒绝其它点击的守卫）已随实现一起删除；
 * - 读取侧（保留）：readSecretInfo / isSecretInfo 的 fail-closed 真值表与 SECRET_ELEMENT_PROBE_SOURCE、tool_call 参数里会打出字符的按键打码（keyTypesCharacter）；
 * - R6-07：粘贴键的剪贴板闸门（AI 只能粘贴自己 browser_clipboard write 写入的内容），与焦点是不是密码框无关；
 * - R1-28 / R2-08：drag / mouse 在取消 / 出错 / 过期时补发 mouseReleased 并清状态（releaseHeld 在最后位置逐键 release）。
 * 页内函数源码（INPUT_KIND_FN / CLEAR_FN / SECRET_ELEMENT_PROBE_SOURCE …）用 vm 在假元素上真跑（不是 mock 返回值）。真浏览器行为见 scripts/browser-e2e/*.cjs。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as actions from "../electron-app/browser/actions.mjs";
import { PASTE_CLIPBOARD_UNAVAILABLE_MESSAGE, PASTE_NOT_AI_CLIPBOARD_MESSAGE, createAiWriteLedger } from "../electron-app/browser/clipboard-policy.mjs";
import { HELD_BUTTON_TTL_MS, createHandlers, peekHeldButtons } from "../electron-app/browser/ops/input.mjs";
import { SECRET_ELEMENT_PROBE_SOURCE, isSecretInfo, readSecretInfo } from "../electron-app/browser/secret-field.mjs";
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
    ownerDocument: { defaultView: win },
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

/**
 * `doc` 是假页面的 document（activeElement 等）。press_key 已不再探「焦点在哪」，但正向用例仍据此把「焦点真的在密码框」建模进假页，
 * 日后若重新引入焦点探针，这些用例会立刻转红。
 */
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
          // OCCLUSION_FN（遮挡探针）恒回 self；其余页内函数（INPUT_KIND_FN / CLEAR_FN / SET_TEMPORAL_FN …）在 vm 里真跑
          if (fn.includes("elementFromPoint")) return { result: { value: { hit: "self" } } };
          return { result: { value: runInPage(fn, objToEl.get(params.objectId) ?? null, opts.doc, args) } };
        }
        case "Runtime.evaluate":
          return { result: { value: runInPage(String(params.expression).replace(/^\(|\)\.call\(null\)$/g, ""), null, opts.doc) } };
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

// ───────────────────────── type：不再按敏感字段拒绝 ─────────────────────────

describe("browser_type（typeBody）：往密码 / 验证码 / 银行卡类字段输入不再被拒；日期类 input 等其余行为不变", () => {
  it("type 到 type=password 的输入框：照常聚焦、清空并 Input.insertText 传入的文本；活动日志摘要只写字符数", async () => {
    const f = makeFake({ elements: { e1: mkEl("input", { type: "password" }) } });
    await actions.type(f.session, { ref: "e1", text: "hunter2" });
    expect(methods(f, "Input.insertText")).toEqual([{ text: "hunter2" }]);
    expect(methods(f, "DOM.focus")).toHaveLength(1);
    expect(f.described[0].summary).toBe("在文本框「字段」输入了 7 个字符");
    expect(JSON.stringify(f.described)).not.toContain("hunter2");
  });

  it("验证码 / 银行卡 / new-password / 被 -webkit-text-security 遮罩的字段同样照常输入（不再按字段类型拒绝）", async () => {
    const cases: Array<[string, FakeEl]> = [
      ["autocomplete=one-time-code", mkEl("input", { type: "text", autocomplete: "one-time-code" })],
      ["autocomplete=cc-number", mkEl("input", { type: "text", autocomplete: "cc-number" })],
      ["autocomplete=cc-csc", mkEl("input", { type: "text", autocomplete: "cc-csc" })],
      ["autocomplete=new-password", mkEl("input", { type: "text", autocomplete: "new-password" })],
      ["-webkit-text-security: disc 的 text 框", mkEl("input", { type: "text" }, { __textSecurity: "disc" })],
      ["-webkit-text-security 的 textarea", mkEl("textarea", {}, { __textSecurity: "circle" })],
    ];
    for (const [label, el] of cases) {
      const f = makeFake({ elements: { e1: el } });
      await actions.type(f.session, { ref: "e1", text: "123456" });
      expect(methods(f, "Input.insertText"), label).toEqual([{ text: "123456" }]);
    }
  });

  it("type 到密码框 + submit: true（登录表单的常见收尾）：insertText 之后再按 Enter", async () => {
    const f = makeFake({ elements: { e1: mkEl("input", { type: "password" }) } });
    await actions.type(f.session, { ref: "e1", text: "hunter2", submit: true });
    expect(methods(f, "Input.insertText")).toEqual([{ text: "hunter2" }]);
    expect(methods(f, "Input.dispatchKeyEvent").some((e) => e.key === "Enter")).toBe(true);
  });

  it("INPUT_KIND_FN 只报控件分类：对密码框也不再带 secret 字段", () => {
    const info = runInPage(actions.v1Internals.INPUT_KIND_FN as string, mkEl("input", { type: "password" }));
    expect(info).toMatchObject({ kind: "input", type: "password", readOnly: false });
    expect(info).not.toHaveProperty("secret");
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
});

// ───────────────────────── fill_form ─────────────────────────

describe("fill_form：value 字段填到密码 / 验证码框照常成功（不再探字段类型、不再拒绝）", () => {
  it("密码框 + 一次性验证码框：results 都是 ok:true，值走 Input.insertText，活动日志不含值", async () => {
    const f = makeFake({
      elements: {
        e1: mkEl("input", { type: "password" }),
        e2: mkEl("input", { type: "text", autocomplete: "one-time-code" }),
      },
    });
    const handlers = createHandlers({ actions, requireSession: () => f.session });
    const res = await handlers.fill_form("t", { fields: [{ ref: "e1", value: "hunter2" }, { ref: "e2", value: "123456" }] });
    expect(res.results[0].ok).toBe(true);
    expect(res.results).toEqual([
      { ref: "e1", ok: true },
      { ref: "e2", ok: true },
    ]);
    expect(methods(f, "Input.insertText")).toEqual([{ text: "hunter2" }, { text: "123456" }]);
    expect(JSON.stringify(f.described)).not.toContain("hunter2");
    expect(JSON.stringify(f.described)).not.toContain("123456");
  });
});

// ───────────────────────── press_key ─────────────────────────

describe("browser_press_key：焦点是密码框时照常派发按键（不再检查焦点是不是敏感字段）", () => {
  const PWD = mkEl("input", { type: "password" });
  const TEXT = mkEl("input", { type: "text" });
  const press = (f: ReturnType<typeof makeFake>, key: string, ref?: string) => actions.pressKey(f.session, { key, ...(ref ? { ref } : {}) });
  const keyEvents = (f: ReturnType<typeof makeFake>) => methods(f, "Input.dispatchKeyEvent");

  it("无 ref：焦点（activeElement）是密码框 → 字符键 / 空格 / 功能键都照常派发 Input.dispatchKeyEvent，不再抛 BAD_ARGS", async () => {
    const f = makeFake({ doc: { activeElement: PWD } });
    for (const k of ["a", "Space", "Shift+a", "Enter", "Tab", "Control+a"]) {
      const before = keyEvents(f).length;
      await press(f, k); // 抛错（旧行为：BAD_ARGS）会直接让用例失败
      expect(keyEvents(f).length, k).toBeGreaterThan(before);
    }
    expect(keyEvents(f).some((e) => e.key === "a" && e.text === "a")).toBe(true);
  });

  it("有 ref：先 DOM.focus 到密码框，随后单字符照常派发", async () => {
    const pwd = mkEl("input", { type: "password" });
    (pwd.ownerDocument as FakeEl).activeElement = pwd; // 聚焦后焦点确实落在这个密码框上
    const f = makeFake({ elements: { e1: pwd } });
    await press(f, "z", "e1");
    expect(methods(f, "DOM.focus")).toHaveLength(1);
    expect(keyEvents(f).some((e) => e.key === "z")).toBe(true);
  });

  it("焦点是普通输入框 / body：单字符照常发", async () => {
    const f1 = makeFake({ doc: { activeElement: TEXT } });
    await press(f1, "a");
    expect(keyEvents(f1).some((e) => e.key === "a")).toBe(true);
    const f2 = makeFake({ doc: { activeElement: mkEl("body") } });
    await press(f2, "j");
    expect(keyEvents(f2).some((e) => e.key === "j")).toBe(true);
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

// ───────────────────────── R2-03 复审：读取失败 ≠ 安全 / 按键判定与主进程同源 ─────────────────────────

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

  it("探针链路：SECRET_ELEMENT_PROBE_SOURCE（snapshot 值遮罩用）在读取抛错的元素上给出 true（不再当非敏感）；普通框 false、密码框 true", () => {
    const hostile = mkEl("input", {}, { getAttribute: () => { throw new Error("hostile"); } });
    expect(runInPage(SECRET_ELEMENT_PROBE_SOURCE, hostile)).toBe(true);
    expect(runInPage(SECRET_ELEMENT_PROBE_SOURCE, mkEl("input", { type: "text" }))).toBe(false);
    expect(runInPage(SECRET_ELEMENT_PROBE_SOURCE, mkEl("input", { type: "password" }))).toBe(true);
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

  it("放行时派发的按键带 paste 编辑命令（页面里才真的会粘贴）", async () => {
    const s = setup({ written: "AI 写的", clip: "AI 写的" });
    await s.press("Control+v");
    expect(keyEvents(s.f).some((e) => Array.isArray(e.commands) && e.commands.includes("paste"))).toBe(true);
  });

  it("焦点是密码框时闸门照样生效、不多不少（没有「密码框更严 / 豁免」的特例）：AI 没写过 → 按通用文案拒；写过且剪贴板一致 → 放行", async () => {
    const f = makeFake({ doc: { activeElement: mkEl("input", { type: "password" }) } });
    const ledger = createAiWriteLedger();
    (f.session as any).getExt = () => ledger;
    const clipboard = { readText: () => "AI 写的" };
    await expect(actions.pressKey(f.session, { key: "Control+v" }, { clipboard })).rejects.toMatchObject({ code: "BAD_ARGS", message: PASTE_NOT_AI_CLIPBOARD_MESSAGE });
    expect(keyEvents(f)).toEqual([]);
    ledger.record("AI 写的");
    await actions.pressKey(f.session, { key: "Control+v" }, { clipboard });
    expect(keyEvents(f).length).toBeGreaterThan(0);
  });
});
