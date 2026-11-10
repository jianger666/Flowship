/* eslint-disable @typescript-eslint/no-explicit-any -- 假页面环境 / 假元素与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * 页内录制器（electron-app/browser/page-scripts.mjs）在 vm 里的行为单测：把 buildPageScript() 产出的源码放进一个手写的
 * 假页面环境（window / document / 事件监听表 / 假 binding / 可控时钟）真跑一遍，再往监听表里「派发」假事件。
 * 覆盖：R1-04（isTrusted 过滤、令牌桶限流）、R1-03（页内按键白名单、敏感目标不发）、R1-05（文本框名字不回落到正文）、
 * R1-25（页内判定与主进程同一份规则）。真浏览器里的行为（CDP 的真实输入是 trusted、合成事件被忽略、全局在主世界不可见）
 * 由 scripts/browser-e2e/page-scripts.cjs 覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { PAGE_WORLD_NAME, RECORDER_BINDING, buildPageScript } from "../electron-app/browser/page-scripts.mjs";
import { isSecretInfo, readSecretInfo } from "../electron-app/browser/secret-field.mjs";

type Listener = (e: any) => void;

const makeEnv = (opts: { recordValues?: boolean } = {}) => {
  const listeners: Record<string, Listener[]> = {};
  const sent: any[] = [];
  let clock = 1_000_000;
  const win: any = {
    scrollX: 0,
    scrollY: 0,
    innerHeight: 600,
    getComputedStyle: (el: any) => ({
      webkitTextSecurity: el.__textSecurity ?? "",
      getPropertyValue: (p: string) => (p === "-webkit-text-security" ? (el.__textSecurity ?? "") : ""),
    }),
  };
  win.top = win;
  const sandbox: any = {
    window: win,
    location: { href: "https://page.test/path?x=1" },
    document: { documentElement: { scrollHeight: 2000 }, body: {}, getElementById: () => null },
    EventTarget: {
      prototype: {
        addEventListener(this: unknown, type: string, fn: Listener) {
          (listeners[type] ??= []).push(fn);
        },
      },
    },
    Date: { now: () => clock },
    [RECORDER_BINDING]: (payload: string) => void sent.push(JSON.parse(payload)),
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(buildPageScript({ recordValues: opts.recordValues === true }), ctx);

  const dispatch = (type: string, e: Record<string, unknown>) => {
    for (const fn of listeners[type] ?? []) fn({ isTrusted: true, ...e, type });
  };
  /**
   * 派发假事件。click / dblclick / contextmenu / input 现在要求「此前 1 秒内有过 trusted 的按下类输入」才会被录（R3-01 / R3-04），
   * 所以对 trusted 的这四类事件默认先补一次真实的 pointerdown（模拟真人点击 / 打字）；要测「没有按下类输入」的情形传 `noDown: true`，
   * isTrusted 为 false / undefined 的事件不补（它们本来就该被忽略）。
   */
  const fire = (type: string, e: Record<string, unknown>) => {
    const { noDown, ...evt } = e as Record<string, unknown> & { noDown?: boolean };
    const trustedEvt = !("isTrusted" in evt) || evt.isTrusted === true;
    if (!noDown && trustedEvt && (type === "click" || type === "dblclick" || type === "contextmenu" || type === "input")) {
      dispatch("pointerdown", { target: evt.target, composedPath: evt.composedPath });
    }
    dispatch(type, evt);
  };
  const el = (tag: string, attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
    const node: any = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      type: attrs.type ?? "",
      isContentEditable: false,
      textContent: "",
      innerText: "",
      value: "",
      labels: [],
      parentElement: null,
      ownerDocument: { defaultView: win },
      getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
      closest: () => null,
      // 最小 DOM 查询面：默认「里面没有可编辑区」；需要时由 extra 覆盖
      matches: () => false,
      querySelectorAll: () => [],
      ...extra,
    };
    return node;
  };
  return {
    sandbox,
    win,
    listeners,
    sent,
    fire,
    el,
    advance: (ms: number) => void (clock += ms),
    target: (node: any) => ({ target: node, composedPath: () => [node] }),
  };
};

// focusin 不再监听（R2-05，见下方专门的用例）；change / submit 还要求最近有过真实输入（同上），所以这里的对照组先发一次 trusted 的 pointerdown
const EVENT_TYPES = ["click", "dblclick", "contextmenu", "input", "change", "submit", "keydown", "scroll"] as const;

describe("R1-04 页内录制器：isTrusted 过滤", () => {
  it("每个 listener 都忽略 isTrusted=false 的事件（页面脚本 dispatchEvent / el.click() 造的），真实事件照常录", () => {
    const env = makeEnv();
    const btn = env.el("button", {}, { innerText: "提交订单", textContent: "提交订单" });
    const input = env.el("input", { type: "text", "aria-label": "备注" }, { value: "abc" });
    const check = env.el("input", { type: "checkbox", "aria-label": "同意" });
    const form = env.el("form", { name: "搜索" });
    const targetFor: Record<string, any> = { click: btn, dblclick: btn, contextmenu: btn, input, change: check, submit: form, keydown: btn, scroll: btn };

    for (const type of EVENT_TYPES) {
      env.fire(type, { isTrusted: false, key: "Enter", ...env.target(targetFor[type]) });
      env.fire(type, { isTrusted: undefined, key: "Enter", ...env.target(targetFor[type]) });
    }
    expect(env.sent).toEqual([]);

    // 对照：同样的事件 isTrusted=true 都能录到（否则上面的「空」可能只是环境没搭对）
    for (const type of EVENT_TYPES) {
      env.advance(1000);
      if (type === "change" || type === "submit") env.fire("pointerdown", env.target(btn)); // 真人切换 / 提交前一刻必有的输入（R2-05）
      env.fire(type, { isTrusted: true, key: "Enter", ...env.target(targetFor[type]) });
    }
    expect(env.sent.map((e) => e.type).sort()).toEqual(["click", "contextmenu", "dblclick", "input", "key", "scroll", "select", "submit"].sort());
  });
});

describe("R1-04 页内录制器：令牌桶限流", () => {
  it("同一时刻连发 100 条真实事件只放过 20 条；过一秒补满 20；半秒补约 10", () => {
    const env = makeEnv();
    const btn = env.el("button", {}, { innerText: "按钮", textContent: "按钮" });
    const burst = (n: number) => {
      for (let i = 0; i < n; i++) env.fire("click", env.target(btn));
    };
    burst(100);
    expect(env.sent).toHaveLength(20);
    env.advance(1000);
    burst(100);
    expect(env.sent).toHaveLength(40);
    env.advance(500);
    burst(100);
    expect(env.sent.length).toBeGreaterThanOrEqual(49);
    expect(env.sent.length).toBeLessThanOrEqual(51);
  });

  it("时钟回拨不会让桶溢出 / 卡死：回拨后仍按剩余令牌放行", () => {
    const env = makeEnv();
    const btn = env.el("button", {}, { innerText: "按钮", textContent: "按钮" });
    for (let i = 0; i < 30; i++) env.fire("click", env.target(btn));
    expect(env.sent).toHaveLength(20);
    env.advance(-5000);
    for (let i = 0; i < 30; i++) env.fire("click", env.target(btn));
    expect(env.sent.length).toBeLessThanOrEqual(21);
    env.advance(5000 + 1000);
    for (let i = 0; i < 30; i++) env.fire("click", env.target(btn));
    expect(env.sent.length).toBeGreaterThanOrEqual(40);
  });
});

describe("R1-03 页内按键：只外发白名单，敏感目标整条不发", () => {
  const key = (env: ReturnType<typeof makeEnv>, node: any, k: string, extra: Record<string, unknown> = {}) =>
    env.fire("keydown", { key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra, ...env.target(node) });

  it("普通字符 / Alt+字符（Option）/ AltGr（getModifierState）/ Ctrl+Alt+字符 / Shift+字符 一个字都不越过 binding", () => {
    const env = makeEnv();
    const input = env.el("input", { type: "text", "aria-label": "备注" });
    key(env, input, "a");
    key(env, input, "@", { altKey: true });
    key(env, input, "@", { getModifierState: (m: string) => m === "AltGraph" });
    key(env, input, "€", { ctrlKey: true, altKey: true });
    key(env, input, "A", { shiftKey: true });
    key(env, input, "ArrowDown");
    key(env, input, "Control", { ctrlKey: true });
    expect(env.sent).toEqual([]);
  });

  it("Enter / Escape / Tab 与 Ctrl|Meta+字母照常外发（带修饰键名）；Ctrl+符号不发", () => {
    const env = makeEnv();
    const input = env.el("input", { type: "text", "aria-label": "备注" });
    key(env, input, "Enter");
    key(env, input, "Tab", { shiftKey: true });
    key(env, input, "a", { ctrlKey: true });
    key(env, input, "c", { metaKey: true });
    key(env, input, "@", { ctrlKey: true });
    expect(env.sent.map((e) => [e.key, e.modifiers])).toEqual([
      ["Enter", undefined],
      ["Tab", ["Shift"]],
      ["a", ["Control"]],
      ["c", ["Meta"]],
    ]);
  });

  it.each([
    ["type=password", { type: "password" }, undefined],
    ["autocomplete=one-time-code", { type: "text", autocomplete: "one-time-code" }, undefined],
    ["autocomplete=cc-exp", { type: "text", autocomplete: "cc-exp" }, undefined],
    ["-webkit-text-security: disc", { type: "text" }, "disc"],
  ])("敏感目标（%s）上连 Enter / Ctrl+a 都不发", (_label, attrs, textSecurity) => {
    const env = makeEnv();
    const node = env.el("input", { ...(attrs as Record<string, string>), "aria-label": "字段" }, textSecurity ? { __textSecurity: textSecurity } : {});
    key(env, node, "Enter");
    key(env, node, "a", { ctrlKey: true });
    key(env, node, "@", { altKey: true });
    expect(env.sent).toEqual([]);
  });
});

describe("R1-25 页内敏感判定：isPassword 标记与 value 外发", () => {
  it.each([
    ["password", { type: "password" }, undefined, true],
    ["one-time-code", { type: "text", autocomplete: "one-time-code" }, undefined, true],
    ["cc-number", { type: "text", autocomplete: "cc-number" }, undefined, true],
    ["cc-exp-month（cc-* 全家）", { type: "text", autocomplete: "cc-exp-month" }, undefined, true],
    ["text-security: circle", { type: "text" }, "circle", true],
    ["普通 text", { type: "text", autocomplete: "email" }, undefined, false],
  ])("%s → isPassword=%s，且 recordValues 开启时敏感字段仍不带 value", (_label, attrs, textSecurity, secret) => {
    const env = makeEnv({ recordValues: true });
    const node = env.el("input", { ...(attrs as Record<string, string>), "aria-label": "字段" }, { value: "THE-VALUE", ...(textSecurity ? { __textSecurity: textSecurity } : {}) });
    env.fire("input", env.target(node));
    expect(env.sent).toHaveLength(1);
    const evt = env.sent[0];
    expect(evt.target.isPassword === true).toBe(secret);
    expect(evt.valueLength).toBe(9);
    if (secret) expect(JSON.stringify(evt)).not.toContain("THE-VALUE");
    else expect(evt.value).toBe("THE-VALUE");
  });

  it("页内嵌入的判定函数与主进程 isSecretInfo 是同一份源码、同一张真值表", () => {
    const src = buildPageScript();
    expect(src).toContain(isSecretInfo.toString());
    expect(src).toContain(readSecretInfo.toString());
    const embedded = vm.runInNewContext(`(${isSecretInfo.toString()})`) as typeof isSecretInfo;
    const table: Array<[Record<string, string> | null | undefined, boolean]> = [
      [{ type: "password" }, true],
      [{ type: "PASSWORD" }, true],
      [{ type: "text", autocomplete: "one-time-code" }, true],
      [{ type: "text", autocomplete: "section-a current-password" }, true],
      [{ type: "text", autocomplete: "new-password" }, true],
      [{ type: "text", autocomplete: "cc-number" }, true],
      [{ type: "text", autocomplete: "cc-csc" }, true],
      [{ type: "text", autocomplete: "cc-exp" }, true],
      [{ type: "text", autocomplete: "billing cc-name" }, true],
      [{ type: "text", textSecurity: "disc" }, true],
      [{ type: "text", textSecurity: "circle" }, true],
      [{ type: "text", textSecurity: "square" }, true],
      [{ type: "text", textSecurity: "none" }, false],
      [{ type: "text", autocomplete: "email" }, false],
      [{ type: "text", autocomplete: "accc-foo" }, false],
      [{ type: "" }, false],
      [null, false],
      [undefined, false],
    ];
    for (const [info, want] of table) {
      expect(isSecretInfo(info as never), JSON.stringify(info)).toBe(want);
      expect(embedded(info as never), `嵌入版 ${JSON.stringify(info)}`).toBe(want);
    }
  });
});

describe("R1-05 页内 accessibleName：文本框不回落到正文", () => {
  const clickName = (node: any) => {
    const env = makeEnv();
    env.fire("click", env.target(node));
    return env.sent[0]?.target;
  };
  const mk = (tag: string, attrs: Record<string, string>, extra: Record<string, unknown>) => makeEnv().el(tag, attrs, extra);
  const PRIVATE = "我的私密草稿：银行卡号 6222 0000 0000";

  it("contenteditable 没有 aria-label 时：target.name 不含正文（也不含 role=textbox 的 div 正文）", () => {
    const editor = mk("div", {}, { isContentEditable: true, innerText: PRIVATE, textContent: PRIVATE });
    const t1 = clickName(editor);
    expect(t1.role).toBe("textbox");
    expect(t1.name).toBeUndefined();
    expect(JSON.stringify(t1)).not.toContain("私密");

    const roleBox = mk("div", { role: "textbox" }, { innerText: PRIVATE, textContent: PRIVATE });
    const t2 = clickName(roleBox);
    expect(t2.name).toBeUndefined();
    expect(JSON.stringify(t2)).not.toContain("私密");
  });

  it("contenteditable 被 <label> 包裹 / aria-labelledby 指回自己时，label / 自身正文也不进名字", () => {
    const label = mk("label", {}, { textContent: `备注 ${PRIVATE}` });
    const wrapped = mk("div", {}, { isContentEditable: true, innerText: PRIVATE, textContent: PRIVATE, closest: (sel: string) => (sel === "label" ? label : null) });
    expect(JSON.stringify(clickName(wrapped))).not.toContain("私密");

    const env = makeEnv();
    const self = env.el("div", { "aria-labelledby": "me" }, { isContentEditable: true, innerText: PRIVATE, textContent: PRIVATE, contains: (n: any) => n === self });
    env.fire("click", env.target(self));
    expect(JSON.stringify(env.sent[0].target)).not.toContain("私密");
  });

  it("文本框仍可用 aria-label / placeholder / name 命名；普通按钮仍取按钮文字（不受影响）", () => {
    expect(clickName(mk("div", { "aria-label": "正文编辑器" }, { isContentEditable: true, textContent: PRIVATE })).name).toBe("正文编辑器");
    expect(clickName(mk("div", { placeholder: "写点什么" }, { isContentEditable: true, textContent: PRIVATE })).name).toBe("写点什么");
    expect(clickName(mk("div", { name: "body" }, { isContentEditable: true, textContent: PRIVATE })).name).toBe("body");
    expect(clickName(mk("button", {}, { innerText: "提交订单", textContent: "提交订单" })).name).toBe("提交订单");
  });
});

describe("R2-05 ① ② UA 替页面派发的 trusted 事件：focusin 不录不耗令牌；change / submit 要求最近有真实输入", () => {
  const press = (env: ReturnType<typeof makeEnv>, node: any, type = "pointerdown", extra: Record<string, unknown> = {}) => env.fire(type, { ...extra, ...env.target(node) });
  const checkbox = (env: ReturnType<typeof makeEnv>) => env.el("input", { type: "checkbox", "aria-label": "同意条款" });
  const btn = (env: ReturnType<typeof makeEnv>) => env.el("button", {}, { innerText: "提交", textContent: "提交" });

  it("② focusin（含 trusted 的、页面循环 el.focus() 产生的）不外发，也不消耗令牌：之后连发 30 次真实点击仍放过满额 20 条", () => {
    const env = makeEnv();
    const b = btn(env);
    for (let i = 0; i < 500; i++) env.fire("focusin", env.target(b));
    expect(env.sent).toEqual([]);
    for (let i = 0; i < 30; i++) env.fire("click", env.target(b));
    expect(env.sent).toHaveLength(20);
    expect(env.sent.every((e) => e.type === "click")).toBe(true);
  });

  it("① 复选框 / 单选框 change：没有真实输入（页面 checkbox.click() 让 UA 派发的 trusted change）→ 丢弃；真实 pointerdown 之后 1 秒内 → 录；超过 1 秒 → 丢", () => {
    const env = makeEnv();
    const cb = checkbox(env);
    const radio = env.el("input", { type: "radio", "aria-label": "男" });

    env.fire("change", env.target(cb)); // 页面伪造：前面没有任何真实输入
    expect(env.sent).toEqual([]);

    press(env, btn(env)); // 真实按下
    env.advance(500);
    env.fire("change", env.target(cb));
    env.fire("change", env.target(radio));
    expect(env.sent.map((e) => [e.type, e.target.inputType, e.target.name])).toEqual([
      ["select", "checkbox", "同意条款"],
      ["select", "radio", "男"],
    ]);

    env.advance(1001); // 窗口外：同一次真实输入不能为之后任意时刻的 change 背书
    env.fire("change", env.target(cb));
    expect(env.sent).toHaveLength(2);
  });

  it("① 只有按下类真实输入能单独开窗口（pointerdown / mousedown / keydown / touchstart）；抬起类 / click 单独出现不开（R3-01）；isTrusted=false 的输入不开", () => {
    for (const type of ["pointerdown", "mousedown", "keydown", "touchstart"]) {
      const env = makeEnv();
      const cb = checkbox(env);
      press(env, btn(env), type, { key: "x" }); // keydown 的 x 不会被录（白名单），只用来开窗口
      env.sent.length = 0;
      env.fire("change", env.target(cb));
      expect(env.sent.map((e) => e.type), type).toEqual(["select"]);
    }
    // 抬起类 / click 单独出现（此前没有按下）：UA 转发 / 派发的，不算手势
    for (const type of ["pointerup", "mouseup", "keyup", "touchend", "click"]) {
      const env = makeEnv();
      const cb = checkbox(env);
      press(env, btn(env), type, { key: "x", noDown: true });
      env.sent.length = 0;
      env.fire("change", env.target(cb));
      expect(env.sent, type).toEqual([]);
    }
    // 按下之后的抬起类照常（长按再松开）
    for (const type of ["pointerup", "mouseup", "keyup", "touchend"]) {
      const env = makeEnv();
      const cb = checkbox(env);
      press(env, btn(env), type === "keyup" ? "keydown" : "pointerdown", { key: "x" });
      env.advance(3000); // 按住很久
      press(env, btn(env), type, { key: "x" });
      env.sent.length = 0;
      env.fire("change", env.target(cb));
      expect(env.sent.map((e) => e.type), type).toEqual(["select"]);
    }
    for (const type of ["pointerdown", "mousedown", "click", "keydown"]) {
      const env = makeEnv();
      press(env, btn(env), type, { isTrusted: false, key: "Enter" }); // 页面 dispatchEvent / el.click() 造的
      env.fire("change", env.target(checkbox(env)));
      env.fire("submit", env.target(env.el("form", { name: "f" })));
      expect(env.sent, type).toEqual([]);
    }
  });

  it("① submit：没有真实输入（form.requestSubmit() / 提交按钮 .click()）→ 丢弃；点提交按钮 / 在输入框里回车之后 → 录；1 秒外 → 丢", () => {
    const env = makeEnv();
    const form = env.el("form", { name: "登录" });
    env.fire("submit", env.target(form));
    expect(env.sent).toEqual([]);

    press(env, btn(env), "click");
    env.sent.length = 0;
    env.fire("submit", env.target(form));
    expect(env.sent.map((e) => [e.type, e.target.fieldName])).toEqual([["submit", "登录"]]);

    env.advance(1500);
    env.fire("keydown", { key: "Enter", ...env.target(env.el("input", { type: "text", "aria-label": "用户名" })) });
    env.sent.length = 0;
    env.fire("submit", env.target(form)); // 回车触发的隐式提交：keydown 紧跟 submit
    expect(env.sent.map((e) => e.type)).toEqual(["submit"]);

    env.advance(1500);
    env.fire("submit", env.target(form));
    expect(env.sent).toHaveLength(1);
  });

  it("① 被丢弃的 change / submit 不占令牌：各 100 次伪造之后，仍能放过满额 20 条真实点击", () => {
    const env = makeEnv();
    const form = env.el("form", { name: "f" });
    for (let i = 0; i < 100; i++) {
      env.fire("change", env.target(checkbox(env)));
      env.fire("submit", env.target(form));
    }
    expect(env.sent).toEqual([]);
    const b = btn(env);
    for (let i = 0; i < 30; i++) env.fire("click", env.target(b));
    expect(env.sent).toHaveLength(20);
  });

  it("① 时钟回拨（距上次输入为负）不会让窗口永远开着", () => {
    const env = makeEnv();
    press(env, btn(env));
    env.advance(-5000);
    env.fire("change", env.target(checkbox(env)));
    env.fire("submit", env.target(env.el("form", {})));
    expect(env.sent).toEqual([]);
  });

  it("① 原生 select：用户在这个 select 上按下之后（弹层停留很久）它的 change 仍认；别的 select / 过期 / 无输入不认；1 秒内别处的真实输入也认", () => {
    const env = makeEnv();
    const city = env.el("select", { "aria-label": "城市" });
    const other = env.el("select", { "aria-label": "省份" });

    env.fire("change", env.target(city)); // 没有任何输入
    expect(env.sent).toEqual([]);

    press(env, city); // 用户点开下拉
    env.sent.length = 0;
    env.advance(30_000); // 读选项、滚动
    env.fire("change", env.target(city));
    expect(env.sent.map((e) => [e.type, e.target.name])).toEqual([["select", "城市"]]);

    env.fire("change", env.target(other)); // 别的 select：既没按过它、也不在 1 秒窗口内
    expect(env.sent).toHaveLength(1);

    env.advance(31_000); // 距离按下已超过 60 秒
    env.fire("change", env.target(city));
    expect(env.sent).toHaveLength(1);

    press(env, btn(env), "pointerdown"); // 1 秒内别处的真实输入（键盘选 / 自动补全后紧跟的操作）
    env.fire("change", env.target(other));
    expect(env.sent).toHaveLength(2);
  });

  it("① file 的 change 不设门槛（只能由用户在系统文件对话框 / 拖放里产生，页面造不出 trusted 的）", () => {
    const env = makeEnv();
    env.fire("change", env.target(env.el("input", { type: "file", "aria-label": "附件" })));
    expect(env.sent.map((e) => [e.type, e.target.inputType])).toEqual([["select", "file"]]);
  });

  it("记录输入窗口本身不产生任何外发（pointerdown / mousedown / keyup / touchstart 都只是标记）", () => {
    const env = makeEnv();
    const b = btn(env);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "keyup", "touchstart", "touchend"]) env.fire(type, { key: "a", ...env.target(b) });
    expect(env.sent).toEqual([]);
  });
});

describe("R2-05 ③ accessibleName：generic 容器不取 innerText；装着编辑区的容器一律不取", () => {
  const PRIVATE = "我的私密草稿：银行卡号 6222 0000 0000";
  const mkEnv = () => makeEnv();
  const nameOf = (env: ReturnType<typeof makeEnv>, node: any) => {
    env.fire("click", env.target(node));
    return env.sent[env.sent.length - 1]?.target;
  };
  // 没有 DOM 实现可用：这里手写一个只认页面脚本用到的几种选择器子句的匹配器，让「容器里有没有编辑区」真正由脚本里的选择器字符串决定，
  // 而不是假 querySelectorAll 无视入参永远返回同一个答案
  const matchesClause = (n: any, clause: string): boolean => {
    const c = clause.trim();
    if (c === "textarea" || c === "input") return String(n.tagName).toLowerCase() === c;
    const role = /^\[role="(\w+)"\]$/.exec(c);
    if (role) return n.getAttribute("role") === role[1];
    if (c === '[contenteditable]:not([contenteditable="false"])') {
      const v = n.getAttribute("contenteditable");
      return v !== null && v !== "false";
    }
    return false;
  };
  const matchesSelector = (n: any, selector: string) => selector.split(",").some((c) => matchesClause(n, c));
  const holding = (node: any, kids: any[]) => {
    node.querySelectorAll = (sel: string) => kids.filter((k) => matchesSelector(k, sel));
    node.matches = (sel: string) => matchesSelector(node, sel);
    return node;
  };
  const editorNode = (env: ReturnType<typeof makeEnv>) => env.el("div", { contenteditable: "" }, { isContentEditable: true, innerText: PRIVATE, textContent: PRIVATE });

  it("点击编辑器外层的 generic 容器 / 内边距：name 缺省，整条事件里没有正文（容器 innerText 含 contenteditable 正文）", () => {
    const env = mkEnv();
    const editor = editorNode(env);
    const container = holding(env.el("div", { class: "editor-wrap" }, { innerText: `正文：${PRIVATE}`, textContent: `正文：${PRIVATE}` }), [editor]);
    const t = nameOf(env, container);
    expect(t.name).toBeUndefined();
    expect(JSON.stringify(env.sent)).not.toContain("私密");
  });

  it("generic 容器即使里面没有编辑区也不回落到自己的 innerText（div / span / li / p 一律只借祖先按钮 / 链接的名字）", () => {
    const env = mkEnv();
    for (const tag of ["div", "span", "li", "p", "section"]) {
      const t = nameOf(env, env.el(tag, {}, { innerText: "产品 A 的一大段说明", textContent: "产品 A 的一大段说明" }));
      expect(t.name, tag).toBeUndefined();
      expect(t.tag).toBe(tag);
    }
  });

  it("「内容即名字」的元素仍取自己的文字：button / a（含无 href）/ summary / label / td / th / h1 / role=button|link|tab|menuitem", () => {
    const env = mkEnv();
    const cases: Array<[string, Record<string, string>]> = [
      ["button", {}],
      ["a", { href: "/x" }],
      ["a", {}],
      ["summary", {}],
      ["label", {}],
      ["td", {}],
      ["th", {}],
      ["h1", {}],
      ["div", { role: "button" }],
      ["span", { role: "link" }],
      ["div", { role: "tab" }],
      ["li", { role: "menuitem" }],
    ];
    for (const [tag, attrs] of cases) {
      const node = env.el(tag, attrs, { innerText: "确认", textContent: "确认", href: attrs.href });
      expect(nameOf(env, node).name, `${tag} ${JSON.stringify(attrs)}`).toBe("确认");
    }
  });

  it("按钮 / 链接 / role=button 的壳里装着编辑区（或输入框、textarea）→ 即使角色是内容即名字也不取 innerText", () => {
    const env = mkEnv();
    const editor = editorNode(env);
    const roleBox = env.el("div", { role: "textbox" }, { innerText: PRIVATE, textContent: PRIVATE });
    const searchBox = env.el("div", { role: "searchbox" }, { innerText: PRIVATE, textContent: PRIVATE });
    const area = env.el("textarea", {}, { textContent: "草稿" });
    const input = env.el("input", { type: "text" }, {});
    const shell = (tag: string, attrs: Record<string, string>, inner: any) =>
      holding(env.el(tag, attrs, { innerText: `标题 ${PRIVATE}`, textContent: `标题 ${PRIVATE}` }), [inner]);
    const shells = [
      shell("button", {}, editor),
      shell("button", {}, roleBox),
      shell("a", { href: "/x" }, searchBox),
      shell("a", { href: "/x" }, area),
      shell("div", { role: "button" }, editor),
      shell("button", {}, input), // 容器里有输入框也不当名字（R2-05：[contenteditable],[role=textbox],textarea,input）
    ];
    for (const node of shells) expect(nameOf(env, node).name).toBeUndefined();
    expect(JSON.stringify(env.sent)).not.toContain("私密");
    // 对照：里面是不相干的节点（普通 span / contenteditable=false）时仍取自己的文字，说明上面的「无名」确实是编辑区守卫起的作用
    const plainKid = env.el("span", {}, {});
    const lockedKid = env.el("div", { contenteditable: "false" }, {});
    expect(nameOf(env, holding(env.el("button", {}, { innerText: "确认", textContent: "确认" }), [plainKid, lockedKid])).name).toBe("确认");
  });

  it("查不了容器里有没有编辑区（没有 querySelectorAll / 查询抛错）时按「有」处理：宁可丢名字，也不冒险取 innerText", () => {
    const env = mkEnv();
    const noQuery = env.el("button", {}, { innerText: `标题 ${PRIVATE}`, textContent: `标题 ${PRIVATE}`, querySelectorAll: undefined });
    const throwing = env.el("a", { href: "/x" }, {
      innerText: `标题 ${PRIVATE}`,
      textContent: `标题 ${PRIVATE}`,
      querySelectorAll: () => {
        throw new Error("DOM 查询炸了");
      },
    });
    expect(nameOf(env, noQuery).name).toBeUndefined();
    expect(nameOf(env, throwing).name).toBeUndefined();
    expect(JSON.stringify(env.sent)).not.toContain("私密");
  });

  it("点按钮里的图标 / 文字 span（generic）：借最近的按钮祖先的名字；祖先是装着编辑区的壳时借不到", () => {
    const env = mkEnv();
    const button = env.el("button", {}, { innerText: "保存草稿", textContent: "保存草稿" });
    const icon = env.el("span", { class: "icon" }, { innerText: "", closest: (sel: string) => (sel === "label" ? null : button) });
    const t = nameOf(env, icon);
    expect(t.tag).toBe("span");
    expect(t.name).toBe("保存草稿");

    const editor = editorNode(env);
    const shellBtn = holding(env.el("div", { role: "button" }, { innerText: PRIVATE, textContent: PRIVATE }), [editor]);
    const innerSpan = env.el("span", {}, { innerText: PRIVATE, textContent: PRIVATE, closest: (sel: string) => (sel === "label" ? null : shellBtn) });
    expect(nameOf(env, innerSpan).name).toBeUndefined();
    expect(JSON.stringify(env.sent)).not.toContain("私密");
  });

  it("<label> 里另装着编辑区时：点 label 里的别的元素 / 控件，label 全文（含编辑区正文）不进名字；原生 input 被 label 包裹且 label 里没有别的编辑区时照常取 label", () => {
    const env = mkEnv();
    const editor = editorNode(env);
    const label = holding(env.el("label", {}, { textContent: `标题 ${PRIVATE}` }), [editor]);
    const span = env.el("span", {}, { innerText: "标题", textContent: "标题", closest: (sel: string) => (sel === "label" ? label : null) });
    expect(nameOf(env, span).name).toBeUndefined();
    const btnInLabel = env.el("button", {}, { labels: [label], innerText: "", textContent: "" });
    expect(nameOf(env, btnInLabel).name).toBeUndefined();
    expect(JSON.stringify(env.sent)).not.toContain("私密");

    const plainLabel = env.el("label", {}, { textContent: "用户名" });
    const input = env.el("input", { type: "text" }, { closest: (sel: string) => (sel === "label" ? plainLabel : null) });
    expect(nameOf(env, input).name).toBe("用户名");
  });

  it("aria-labelledby 指向装着编辑区的容器：不取它的 textContent；指向普通标签节点仍可用", () => {
    const env = mkEnv();
    const editor = editorNode(env);
    const holder = holding(env.el("div", {}, { textContent: `草稿 ${PRIVATE}` }), [editor]);
    const heading = env.el("h2", {}, { textContent: "订单信息" });
    env.sandbox.document.getElementById = (id: string) => (id === "holder" ? holder : id === "title" ? heading : null);
    const viaHolder = env.el("div", { role: "button", "aria-labelledby": "holder" }, { innerText: "", textContent: "" });
    expect(nameOf(env, viaHolder).name).toBeUndefined();
    const viaTitle = env.el("div", { role: "button", "aria-labelledby": "title" }, { innerText: "", textContent: "" });
    expect(nameOf(env, viaTitle).name).toBe("订单信息");
    expect(JSON.stringify(env.sent)).not.toContain("私密");
  });
});

describe("R1-04 录制器全局在页面主世界不可见（静态契约；真机验证见 scripts/browser-e2e/page-scripts.cjs）", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

  it("tab.mjs：binding 只绑到命名的隔离世界（executionContextName），脚本只注入同名世界（worldName），都用 PAGE_WORLD_NAME", () => {
    const tab = read("electron-app/browser/tab.mjs");
    expect(tab).toMatch(/Runtime\.addBinding",\s*\{\s*name:\s*RECORDER_BINDING,\s*executionContextName:\s*PAGE_WORLD_NAME\s*\}/);
    expect(tab).toMatch(/addScriptToEvaluateOnNewDocument",\s*\{\s*source,\s*worldName:\s*PAGE_WORLD_NAME\s*\}/);
    // 没有任何一处不带 executionContextName 的 addBinding（那会把 __flowshipRec 暴露给页面主世界）
    for (const m of tab.matchAll(/Runtime\.addBinding"[^)]*\)/g)) expect(m[0]).toContain("executionContextName");
    expect(PAGE_WORLD_NAME).toBe("flowship");
    expect(RECORDER_BINDING).toBe("__flowshipRec");
  });

  it("页内脚本只把对象挂在自己世界的 globalThis.__flowship；不往 window 上写任何全局（含 binding 名）", () => {
    const env = makeEnv();
    expect(typeof env.sandbox.__flowship).toBe("object");
    expect(env.sandbox.__flowship.__v).toBe(1);
    expect(Object.keys(env.win).filter((k) => /flowship/i.test(k))).toEqual([]);
    expect(Object.getOwnPropertyNames(env.win).filter((k) => /flowship/i.test(k))).toEqual([]);
  });
});

describe("R3-01 / R3-04 录制器：click / dblclick / contextmenu / input 要求此前 1 秒内有按下类输入（UA 转发 / 派发的 trusted 事件不是手势）", () => {
  const btn = (env: ReturnType<typeof makeEnv>) => env.el("button", {}, { innerText: "提交", textContent: "提交" });
  const textbox = (env: ReturnType<typeof makeEnv>, name = "备注") => env.el("input", { type: "text", "aria-label": name }, { value: "abc" });

  it("没有按下类输入的 trusted click / dblclick / contextmenu / input（label.click() 转发、execCommand('insertText') 派发）一律不外发", () => {
    const env = makeEnv();
    const b = btn(env);
    const t = textbox(env);
    for (const type of ["click", "dblclick", "contextmenu"]) env.fire(type, { noDown: true, ...env.target(b) });
    env.fire("input", { noDown: true, ...env.target(t) });
    expect(env.sent).toEqual([]);
  });

  it("按下类输入之后 1 秒内的 click / input 照常外发；1 秒外丢；click 自己不续期（不能靠连发 click 把窗口无限接力）", () => {
    const env = makeEnv();
    const b = btn(env);
    const t = textbox(env);
    env.fire("pointerdown", env.target(b));
    env.advance(500);
    env.fire("click", { noDown: true, ...env.target(b) });
    env.fire("input", { noDown: true, ...env.target(t) });
    expect(env.sent.map((e) => e.type)).toEqual(["click", "input"]);
    env.advance(600); // 距按下 1100ms；中间那次 click 不续期
    env.fire("click", { noDown: true, ...env.target(b) });
    env.fire("input", { noDown: true, ...env.target(t) });
    expect(env.sent).toHaveLength(2);
  });

  it("长按：按下 → 3 秒后松开 → click，仍算一次真实点击；没有按下的松开（UA 转发）不续期", () => {
    const env = makeEnv();
    const b = btn(env);
    env.fire("pointerdown", env.target(b));
    env.advance(3000);
    env.fire("pointerup", env.target(b));
    env.fire("click", { noDown: true, ...env.target(b) });
    expect(env.sent.map((e) => e.type)).toEqual(["click"]);
    env.advance(5000);
    env.fire("pointerup", env.target(b)); // 没有对应的按下
    env.fire("mouseup", env.target(b));
    env.fire("click", { noDown: true, ...env.target(b) });
    expect(env.sent).toHaveLength(1);
  });

  it("键盘：keydown（Enter / Space）之后 UA 派发的 click 照常外发（键盘激活按钮不丢）", () => {
    const env = makeEnv();
    const b = btn(env);
    env.fire("keydown", { key: " ", ...env.target(b) }); // 空格不在按键白名单里，只开窗口
    env.fire("click", { noDown: true, ...env.target(b) });
    expect(env.sent.map((e) => e.type)).toEqual(["click"]);
  });

  it("洪水：无按下的 trusted input 来回 60 次不占令牌；紧接着的真实点击、真实打字仍被录到", () => {
    const env = makeEnv();
    const a = textbox(env, "幽灵框");
    const c = textbox(env, "幽灵框二");
    for (let i = 0; i < 30; i++) {
      env.fire("input", { noDown: true, ...env.target(a) });
      env.fire("input", { noDown: true, ...env.target(c) });
    }
    expect(env.sent).toEqual([]);
    const b = btn(env);
    env.fire("click", env.target(b)); // 夹具会先补 pointerdown
    env.fire("keydown", { key: "k", ...env.target(a) });
    env.fire("input", { noDown: true, ...env.target(a) });
    expect(env.sent.map((e) => e.type)).toEqual(["click", "input"]);
  });

  it("页面脚本造的（isTrusted=false）按下 / 松开不开窗口、不接力", () => {
    const env = makeEnv();
    const b = btn(env);
    for (const type of ["pointerdown", "mousedown", "keydown", "touchstart", "pointerup"]) env.fire(type, { isTrusted: false, key: "x", ...env.target(b) });
    env.fire("click", { noDown: true, ...env.target(b) });
    env.fire("input", { noDown: true, ...env.target(textbox(env)) });
    expect(env.sent).toEqual([]);
  });
});
