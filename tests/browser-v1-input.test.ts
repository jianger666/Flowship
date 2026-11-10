/* eslint-disable @typescript-eslint/no-explicit-any -- 假 session / tab / actions 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * V1 输入类（主进程侧）纯逻辑 + 用假 session 驱动的 handler 单测：
 * mouse / fill_form 参数校验、坐标检查、click.modifiers、snapshot.query 过滤、wait_for 新条件、networkIdle 判定器。
 * 真实 CDP 行为见 scripts/browser-e2e/v1-smoke.cjs。
 */
import { describe, expect, it } from "vitest";

import { describeModifiers, modifierBits } from "../electron-app/browser/actions.mjs";
import { filterSnapshotText } from "../electron-app/browser/ax-snapshot.mjs";
import { ALL_OPS, createIdleTracker, normalizeOpArgs } from "../electron-app/browser/index.mjs";
import {
  PASSWORD_REJECT_MESSAGE,
  checkMousePoint,
  createHandlers,
  describeFillForm,
  describeMouseAction,
  isFatalFillError,
  isSecretField,
  normalizeModifiers,
} from "../electron-app/browser/ops/input.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe("mouse 参数校验（normalizeOpArgs）", () => {
  it("mouse / fill_form 已登记进 ALL_OPS", () => {
    expect(ALL_OPS).toEqual(expect.arrayContaining(["mouse", "fill_form"]));
  });

  it("合法 click：默认 left、delta 0、不带 modifiers 字段", () => {
    expect(normalizeOpArgs("mouse", { action: "click", x: 10, y: 20 })).toEqual({
      action: "click",
      x: 10,
      y: 20,
      button: "left",
      deltaX: 0,
      deltaY: 0,
    });
  });

  it("带 tabId / modifiers / 小数坐标：规整后保留（modifiers 去重）", () => {
    const a = normalizeOpArgs("mouse", { action: "double_click", x: 10.5, y: 3, button: "right", modifiers: ["Shift", "Shift", "Alt"], tabId: "t2" });
    expect(a).toMatchObject({ x: 10.5, y: 3, button: "right", modifiers: ["Shift", "Alt"], tabId: "t2" });
  });

  it("缺 action / x / y、非法 action、非数字、负数 → BAD_ARGS", () => {
    expect(codeOf(() => normalizeOpArgs("mouse", { x: 1, y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "teleport", x: 1, y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: "10", y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: Number.NaN, y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: -1, y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: 1, y: -0.5 }))).toBe("BAD_ARGS");
  });

  it("wheel 必须至少一个 delta 非 0；delta 被夹到 ±100000", () => {
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "wheel", x: 1, y: 1 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 0 }))).toBe("BAD_ARGS");
    expect(normalizeOpArgs("mouse", { action: "wheel", x: 1, y: 1, deltaY: -240 })).toMatchObject({ deltaY: -240 });
    expect(normalizeOpArgs("mouse", { action: "wheel", x: 1, y: 1, deltaY: 9e9 })).toMatchObject({ deltaY: 100_000 });
  });

  it("modifiers 非法（未知名 / 非数组）→ BAD_ARGS；空数组视为没给", () => {
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: 1, y: 1, modifiers: ["Hyper"] }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("mouse", { action: "click", x: 1, y: 1, modifiers: "Shift" }))).toBe("BAD_ARGS");
    expect(normalizeOpArgs("mouse", { action: "click", x: 1, y: 1, modifiers: [] })).not.toHaveProperty("modifiers");
  });
});

describe("checkMousePoint：坐标必须在视口内", () => {
  const vp = { width: 1280, height: 800 };
  it("边界：(0,0) 与 (W-1,H-1) 合法；x==W 或 y==H 越界", () => {
    expect(() => checkMousePoint(0, 0, vp)).not.toThrow();
    expect(() => checkMousePoint(1279, 799, vp)).not.toThrow();
    expect(codeOf(() => checkMousePoint(1280, 10, vp))).toBe("BAD_ARGS");
    expect(codeOf(() => checkMousePoint(10, 800, vp))).toBe("BAD_ARGS");
    expect(codeOf(() => checkMousePoint(-1, 10, vp))).toBe("BAD_ARGS");
  });
  it("文案带视口尺寸，能让模型自修复", () => {
    try {
      checkMousePoint(2000, 5, vp);
      throw new Error("应当抛出");
    } catch (e) {
      expect((e as Error).message).toContain("1280×800");
      expect((e as Error).message).toContain("0–1279");
    }
  });
  it("视口尺寸为 0 / 缺失（尚未布局）时不做上界检查，但仍拒绝负数 / NaN", () => {
    expect(() => checkMousePoint(5000, 5000, { width: 0, height: 0 })).not.toThrow();
    expect(() => checkMousePoint(5000, 5000, undefined)).not.toThrow();
    expect(codeOf(() => checkMousePoint(Number.NaN, 1, undefined))).toBe("BAD_ARGS");
  });
});

describe("文案 / 修饰键换算", () => {
  it("describeMouseAction：只含坐标与数值", () => {
    expect(describeMouseAction({ action: "click", x: 120.4, y: 119.6, button: "left" }).summary).toBe("鼠标点击 (120, 120)");
    expect(describeMouseAction({ action: "click", x: 1, y: 2, button: "right", modifiers: ["Control", "Shift"] }).summary).toBe("Ctrl+Shift+鼠标右键点击 (1, 2)");
    expect(describeMouseAction({ action: "double_click", x: 1, y: 2, button: "left" }).summary).toBe("鼠标双击 (1, 2)");
    expect(describeMouseAction({ action: "wheel", x: 5, y: 6, deltaY: 120, deltaX: 0 })).toMatchObject({ kind: "scroll", summary: "鼠标滚轮 (5, 6) 纵向 +120px" });
    expect(describeMouseAction({ action: "move", x: 5, y: 6 }).summary).toBe("鼠标移动到 (5, 6)");
  });
  it("modifierBits / describeModifiers", () => {
    expect(modifierBits(["Alt", "Control", "Meta", "Shift"])).toBe(1 | 2 | 4 | 8);
    expect(modifierBits(["Shift"])).toBe(8);
    expect(modifierBits(undefined)).toBe(0);
    expect(modifierBits(["Nope"])).toBe(0);
    expect(describeModifiers(["Meta", "Control"])).toBe("Ctrl+Cmd+");
    expect(describeModifiers([])).toBe("");
  });
  it("normalizeModifiers 去重 / 空数组 → undefined", () => {
    const bad = (m: string) => new BrowserError("BAD_ARGS", m);
    expect(normalizeModifiers(["Alt", "Alt"], bad)).toEqual(["Alt"]);
    expect(normalizeModifiers([], bad)).toBeUndefined();
    expect(normalizeModifiers(undefined, bad)).toBeUndefined();
  });
});

describe("click.modifiers / snapshot.query / wait_for 新条件的 normalize", () => {
  it("click：modifiers 可选，没给时参数形状与老版本完全一致", () => {
    expect(normalizeOpArgs("click", { ref: "e1" })).toEqual({ ref: "e1", button: "left", doubleClick: false });
    expect(normalizeOpArgs("click", { ref: "e1", modifiers: ["Meta"] })).toMatchObject({ modifiers: ["Meta"] });
    expect(codeOf(() => normalizeOpArgs("click", { ref: "e1", modifiers: ["Cmd"] }))).toBe("BAD_ARGS");
  });

  it("snapshot：query 去首尾空白；空串 / 纯空白视为没给", () => {
    expect(normalizeOpArgs("snapshot", { query: "  登录 " })).toMatchObject({ query: "登录" });
    expect(normalizeOpArgs("snapshot", { query: "   " })).not.toHaveProperty("query");
    expect(normalizeOpArgs("snapshot", {})).not.toHaveProperty("query");
    expect(codeOf(() => normalizeOpArgs("snapshot", { query: 123 }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("snapshot", { query: "x".repeat(201) }))).toBe("BAD_ARGS");
  });

  it("wait_for：六个条件必须且只能给一个；networkIdle:false 等于没给", () => {
    expect(normalizeOpArgs("wait_for", { urlContains: "/done" })).toMatchObject({ urlContains: "/done", timeoutMs: 15_000 });
    expect(normalizeOpArgs("wait_for", { networkIdle: true })).toMatchObject({ networkIdle: true });
    expect(normalizeOpArgs("wait_for", { refVisible: "e7", timeoutMs: 3000 })).toMatchObject({ refVisible: "e7", timeoutMs: 3000 });
    expect(normalizeOpArgs("wait_for", { text: "hi" })).toMatchObject({ text: "hi" });
    expect(normalizeOpArgs("wait_for", { text: "hi", networkIdle: false })).toMatchObject({ text: "hi" });
    expect(codeOf(() => normalizeOpArgs("wait_for", {}))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("wait_for", { networkIdle: false }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("wait_for", { text: "a", urlContains: "b" }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("wait_for", { networkIdle: true, refVisible: "e1" }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("wait_for", { networkIdle: "yes" }))).toBe("BAD_ARGS");
  });
});

describe("createIdleTracker：在途数为 0 且持续 ≥500ms", () => {
  it("有请求就重新计时；空闲不足 500ms 不算", () => {
    const idle = createIdleTracker(500);
    expect(idle(0, 1000)).toBe(false); // 刚空闲，开始计时
    expect(idle(0, 1400)).toBe(false);
    expect(idle(0, 1500)).toBe(true);
    expect(idle(2, 1600)).toBe(false); // 又来了请求
    expect(idle(0, 1700)).toBe(false); // 重新计时
    expect(idle(0, 2150)).toBe(false);
    expect(idle(0, 2200)).toBe(true);
  });
  it("一直有在途请求永不空闲", () => {
    const idle = createIdleTracker(500);
    for (let t = 0; t < 10_000; t += 100) expect(idle(1, t)).toBe(false);
  });
});

describe("filterSnapshotText：snapshot.query 过滤", () => {
  const snap = [
    '- navigation "主导航":',
    '  - link "首页" [ref=e1]',
    '  - link "价格" [ref=e2]',
    '- main:',
    '  - heading "登录"',
    '  - form "登录表单":',
    '    - textbox "邮箱" [ref=e3]',
    '    - textbox "密码" [ref=e4]',
    '    - button "登录" [ref=e5]',
    '  - text: 其它说明',
    '  - text: 更多说明',
    '  - text: 页脚',
    '- contentinfo:',
    '  - link "隐私" [ref=e6]',
  ].join("\n");

  it("命中行 + 祖先链 + 前后各 2 行；ref 原样保留；头部写命中数与总数", () => {
    const r = filterSnapshotText(snap, "邮箱", { total: 6 });
    expect(r.hits).toBe(1);
    const lines = r.text.split("\n");
    expect(lines[0]).toContain("命中 1 行 / 共 6 个可交互元素");
    // 命中行本身与它的 ref
    expect(r.text).toContain('    - textbox "邮箱" [ref=e3]');
    // 祖先链：form → main
    expect(r.text).toContain('  - form "登录表单":');
    expect(r.text).toContain("- main:");
    // 前后各 2 行上下文
    expect(r.text).toContain('  - heading "登录"');
    expect(r.text).toContain('    - textbox "密码" [ref=e4]');
    expect(r.text).toContain('    - button "登录" [ref=e5]');
    // 远处的行不在
    expect(r.text).not.toContain("隐私");
    expect(r.text).not.toContain("首页");
    // 被省略的区间有标记（首 / 中 / 尾）
    expect(r.text).toContain("…（上方省略 3 行）");
    expect(r.text).toContain("…（下方省略 5 行）");
    const mid = filterSnapshotText(snap, "首页", { total: 6 }).text.concat(filterSnapshotText(snap, "隐私", { total: 6 }).text);
    expect(mid).toContain("…（上方省略");
    // 两处命中相隔很远时，中间出现「省略 N 行」
    const two = filterSnapshotText(snap, "i", { total: 6 }); // 命中很多行：只验证不会崩且 ref 保留
    expect(two.hits).toBeGreaterThan(1);
    const far = filterSnapshotText(["- a hit1", "- x", "- x", "- x", "- x", "- x", "- x", "- a hit2"].join("\n"), "hit", { total: 0 });
    expect(far.text).toContain("…（省略 2 行）");
  });

  it("大小写不敏感；多处命中计数；匹配范围含角色名", () => {
    expect(filterSnapshotText('- button "Submit Order" [ref=e1]\n- link "cancel" [ref=e2]', "submit", { total: 2 }).hits).toBe(1);
    expect(filterSnapshotText(snap, "登录", { total: 6 }).hits).toBe(3); // heading / form / button
    expect(filterSnapshotText(snap, "LINK", { total: 6 }).hits).toBe(3);
  });

  it("行尾的 [ref=eN] 不参与普通匹配；query 本身是 eN 时精确匹配该 ref", () => {
    expect(filterSnapshotText(snap, "ref", { total: 6 }).hits).toBe(0);
    const byRef = filterSnapshotText(snap, "e3", { total: 6 });
    expect(byRef.hits).toBe(1);
    expect(byRef.text).toContain('textbox "邮箱" [ref=e3]');
    // e1 不会误命中 e10 / e11 之类
    expect(filterSnapshotText('- link "a" [ref=e10]\n- link "b" [ref=e1]', "e1", { total: 2 }).hits).toBe(1);
  });

  it("无命中：明确说没有匹配 + 总元素数 + 下一步建议，而不是空串", () => {
    const r = filterSnapshotText(snap, "不存在的东西", { total: 6 });
    expect(r.hits).toBe(0);
    expect(r.text).toContain("没有匹配「不存在的东西」");
    expect(r.text).toContain("共 6 个可交互元素");
    expect(r.text.length).toBeGreaterThan(20);
  });

  it("结果超过 maxChars 时截断并说明；原快照被截断时如实提示命中可能不全", () => {
    const many = Array.from({ length: 200 }, (_, i) => `- button "确认 ${i}" [ref=e${i + 1}]`).join("\n");
    const r = filterSnapshotText(many, "确认", { total: 200, maxChars: 600 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(700);
    expect(r.text).toContain("已截断");
    const src = filterSnapshotText(`${snap}\n- …（内容已截断：可调小范围）`, "邮箱", { total: 6, sourceTruncated: true });
    expect(src.text).toContain("原始快照已被截断");
    expect(src.truncated).toBe(true);
    // 原快照末尾的截断提示行本身不参与匹配
    expect(filterSnapshotText("- …（内容已截断：x）", "截断", { total: 0 }).hits).toBe(0);
  });
});

describe("fill_form 参数校验", () => {
  it("合法：保留每项形状，submitRef 可选", () => {
    const a = normalizeOpArgs("fill_form", {
      fields: [{ ref: "e1", value: "x" }, { ref: "e2", checked: false }, { ref: "e3", values: ["上海"] }, { ref: " e4 ", value: "" }],
      submitRef: "e9",
    }) as any;
    expect(a.fields).toEqual([
      { ref: "e1", value: "x" },
      { ref: "e2", checked: false },
      { ref: "e3", values: ["上海"] },
      { ref: "e4", value: "" },
    ]);
    expect(a.submitRef).toBe("e9");
    expect(normalizeOpArgs("fill_form", { fields: [{ ref: "e1", value: "x" }] })).not.toHaveProperty("submitRef");
  });

  it("fields 为空 / 超过 30 项 / 不是数组 → BAD_ARGS", () => {
    expect(codeOf(() => normalizeOpArgs("fill_form", {}))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("fill_form", { fields: [] }))).toBe("BAD_ARGS");
    expect(codeOf(() => normalizeOpArgs("fill_form", { fields: "x" }))).toBe("BAD_ARGS");
    const thirty = Array.from({ length: 30 }, (_, i) => ({ ref: `e${i + 1}`, value: "v" }));
    expect(() => normalizeOpArgs("fill_form", { fields: thirty })).not.toThrow();
    expect(codeOf(() => normalizeOpArgs("fill_form", { fields: [...thirty, { ref: "e31", value: "v" }] }))).toBe("BAD_ARGS");
  });

  it("每项必须有 ref，且 value / checked / values 恰好一个、类型正确", () => {
    const bad = (f: unknown) => codeOf(() => normalizeOpArgs("fill_form", { fields: [f] }));
    expect(bad({ value: "x" })).toBe("BAD_ARGS");
    expect(bad({ ref: "", value: "x" })).toBe("BAD_ARGS");
    expect(bad({ ref: "e1" })).toBe("BAD_ARGS");
    expect(bad({ ref: "e1", value: "x", checked: true })).toBe("BAD_ARGS");
    expect(bad({ ref: "e1", value: 5 })).toBe("BAD_ARGS");
    expect(bad({ ref: "e1", checked: "yes" })).toBe("BAD_ARGS");
    expect(bad({ ref: "e1", values: [] })).toBe("BAD_ARGS");
    expect(bad({ ref: "e1", values: [1] })).toBe("BAD_ARGS");
    expect(bad("e1")).toBe("BAD_ARGS");
  });

  it("错误信息带字段序号，便于模型定位", () => {
    try {
      normalizeOpArgs("fill_form", { fields: [{ ref: "e1", value: "x" }, { ref: "e2" }] });
      throw new Error("应当抛出");
    } catch (e) {
      expect((e as Error).message).toContain("fields[1]");
    }
  });
});

describe("敏感字段判定 / 摘要 / 致命错误", () => {
  it("isSecretField：type=password 或 autocomplete 含 password / one-time-code", () => {
    expect(isSecretField({ type: "password" })).toBe(true);
    expect(isSecretField({ type: "PASSWORD" })).toBe(true);
    expect(isSecretField({ type: "text", autocomplete: "one-time-code" })).toBe(true);
    expect(isSecretField({ type: "text", autocomplete: "current-password" })).toBe(true);
    expect(isSecretField({ type: "text", autocomplete: "section-a new-password" })).toBe(true);
    expect(isSecretField({ type: "text", autocomplete: "email" })).toBe(false);
    expect(isSecretField({ type: "text", autocomplete: "" })).toBe(false);
    expect(isSecretField(null)).toBe(false);
  });
  it("拒绝文案指向 browser_ask_user_to_act", () => {
    expect(PASSWORD_REJECT_MESSAGE).toContain("browser_ask_user_to_act");
  });
  it("describeFillForm 只写数量", () => {
    expect(describeFillForm(3, 3, undefined)).toBe("填写了表单 3/3 项");
    expect(describeFillForm(3, 2, "skipped")).toBe("填写了表单 2/3 项，失败 1 项，因有失败项已跳过提交");
    expect(describeFillForm(2, 2, "ok")).toBe("填写了表单 2/2 项，并点击了提交");
  });
  it("isFatalFillError：接管 / 取消 / 会话没了不吞；普通失败吞", () => {
    expect(isFatalFillError(new BrowserError("USER_TOOK_OVER", "x"), undefined)).toBe(true);
    expect(isFatalFillError(new BrowserError("CANCELLED", "x"), undefined)).toBe(true);
    expect(isFatalFillError(new BrowserError("NO_SESSION", "x"), undefined)).toBe(true);
    expect(isFatalFillError(new BrowserError("REF_STALE", "x"), undefined)).toBe(false);
    expect(isFatalFillError(new BrowserError("NOT_INTERACTABLE", "x"), undefined)).toBe(false);
    expect(isFatalFillError(new Error("boom"), { aborted: true } as AbortSignal)).toBe(true);
  });
});

// ───────────────────────── 用假 session / tab 驱动 handler ─────────────────────────

/** 假 v1Internals：记录调用，callOnNode 按页内函数源码分流返回预设 */
const makeHarness = (opts: {
  fieldInfo?: Record<string, { type?: string; autocomplete?: string }>;
  checked?: Record<string, { kind: string; checked: boolean; disabled?: boolean }>;
  failRefs?: Set<string>;
  viewport?: { viewportW: number; viewportH: number };
}) => {
  const calls: Array<{ fn: string; args: any }> = [];
  const mouseEvents: any[] = [];
  const checkedState = { ...(opts.checked ?? {}) };
  const tab = {
    ensureCdp: async () => {},
    layoutMetrics: async () => opts.viewport ?? { viewportW: 100, viewportH: 80 },
    setAI: async () => {},
    withAiInput: async (fn: () => Promise<unknown>) => fn(),
    resolveRef: (ref: string) => {
      if (opts.failRefs?.has(ref)) throw new BrowserError("REF_STALE", `ref ${ref} 已失效`);
      return { ref };
    },
  };
  const CHECKED_STATE_FN = "CHECKED_STATE_FN";
  const I: any = {
    assertPointNotSecret: async () => {}, // R6-30：落点探针在 tests/browser-r6-s2-shadow-frame.test.ts 里真跑，这里只关心派发顺序
    aiScope: async (_tab: unknown, fn: () => Promise<unknown>) => fn(),
    beforeState: () => ({}),
    actionResult: () => ({ tabId: "t1", url: "https://a.test/", title: "A", navigated: false }),
    showAction: async () => {},
    mouse: async (_t: unknown, p: any) => void mouseEvents.push(p),
    mouseClickAt: async (_t: unknown, pt: any, o: any) => void mouseEvents.push({ type: "click", ...pt, ...o }),
    settle: async () => {},
    CHECKED_STATE_FN,
    callOnNode: async (_t: unknown, entry: any, _ref: string, fn: string) => {
      if (fn === CHECKED_STATE_FN) return checkedState[entry.ref] ?? { kind: "other" };
      return opts.fieldInfo?.[entry.ref] ?? { tag: "input", type: "text", autocomplete: "" };
    },
    typeBody: async (_s: unknown, _c: unknown, a: any) => void calls.push({ fn: "type", args: a }),
    selectBody: async (_s: unknown, _c: unknown, a: any) => {
      if (opts.failRefs?.has(a.ref)) throw new BrowserError("BAD_ARGS", "找不到选项");
      calls.push({ fn: "select", args: a });
    },
    clickBody: async (_s: unknown, _c: unknown, a: any) => {
      calls.push({ fn: "click", args: a });
      if (checkedState[a.ref]) checkedState[a.ref] = { ...checkedState[a.ref], checked: !checkedState[a.ref].checked };
    },
  };
  const described: any[] = [];
  const session = {
    runAction: async (_o: unknown, fn: (ctx: any) => Promise<unknown>) =>
      fn({ tab, signal: undefined, check: () => {}, describe: (d: any) => described.push(d) }),
  };
  const handlers = createHandlers({ actions: { v1Internals: I, modifierBits }, requireSession: () => session });
  return { handlers, calls, mouseEvents, described, checkedState };
};

describe("fill_form handler（假 session）", () => {
  it("密码字段被拒绝（ok:false，指向 browser_ask_user_to_act）且不会调用 type；其它项照常", async () => {
    const h = makeHarness({ fieldInfo: { e2: { type: "password" } } });
    const r: any = await h.handlers.fill_form("t", {
      fields: [{ ref: "e1", value: "u" }, { ref: "e2", value: "secret" }, { ref: "e3", value: "z" }],
    });
    expect(r.results.map((x: any) => x.ok)).toEqual([true, false, true]);
    expect(r.results[1].error).toBe(PASSWORD_REJECT_MESSAGE);
    expect(h.calls.filter((c) => c.fn === "type").map((c) => c.args.ref)).toEqual(["e1", "e3"]);
    // 密码值绝不进入任何日志文案
    expect(JSON.stringify(h.described)).not.toContain("secret");
  });

  it("autocomplete=one-time-code 的文本框同样拒绝", async () => {
    const h = makeHarness({ fieldInfo: { e1: { type: "text", autocomplete: "one-time-code" } } });
    const r: any = await h.handlers.fill_form("t", { fields: [{ ref: "e1", value: "123456" }] });
    expect(r.results[0].ok).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  it("单字段失败不中断后续字段；results 逐项给成败", async () => {
    const h = makeHarness({ failRefs: new Set(["e1", "e2"]) });
    const r: any = await h.handlers.fill_form("t", {
      fields: [{ ref: "e1", value: "a" }, { ref: "e2", values: ["x"] }, { ref: "e3", value: "c" }],
    });
    expect(r.results.map((x: any) => [x.ref, x.ok])).toEqual([["e1", false], ["e2", false], ["e3", true]]);
    expect(r.results[0].error).toContain("e1");
  });

  it("checked：状态不同才点；相同不点；单选不能取消；非勾选控件报错；禁用报错", async () => {
    const h = makeHarness({
      checked: {
        e1: { kind: "checkbox", checked: true },
        e2: { kind: "checkbox", checked: false },
        e3: { kind: "radio", checked: true },
        e4: { kind: "other", checked: false },
        e5: { kind: "checkbox", checked: false, disabled: true },
        e6: { kind: "radio", checked: false },
      },
    });
    const r: any = await h.handlers.fill_form("t", {
      fields: [
        { ref: "e1", checked: true }, // 已勾：不点
        { ref: "e2", checked: true }, // 未勾：点
        { ref: "e3", checked: false }, // 单选取消：拒绝
        { ref: "e4", checked: true }, // 不是复选框
        { ref: "e5", checked: true }, // 禁用
        { ref: "e6", checked: true }, // 单选选中：点
      ],
    });
    expect(r.results.map((x: any) => x.ok)).toEqual([true, true, false, false, false, true]);
    expect(h.calls.filter((c) => c.fn === "click").map((c) => c.args.ref)).toEqual(["e2", "e6"]);
    expect(r.results[2].error).toContain("单选框");
  });

  it("全部成功 + submitRef：最后点击 submitRef；有失败项则跳过提交并给出原因", async () => {
    const ok = makeHarness({});
    const r1: any = await ok.handlers.fill_form("t", { fields: [{ ref: "e1", value: "a" }], submitRef: "e9" });
    expect(r1.submit).toEqual({ ref: "e9", ok: true });
    expect(ok.calls.map((c) => c.fn)).toEqual(["type", "click"]);
    expect(ok.calls[1].args.ref).toBe("e9");
    expect(ok.described.at(-1).kind).toBe("submit");

    const part = makeHarness({ fieldInfo: { e1: { type: "password" } } });
    const r2: any = await part.handlers.fill_form("t", { fields: [{ ref: "e1", value: "p" }], submitRef: "e9" });
    expect(r2.submit.ok).toBe(false);
    expect(r2.submit.error).toContain("已跳过提交");
    expect(part.calls.some((c) => c.fn === "click")).toBe(false);
  });

  it("致命错误（USER_TOOK_OVER）整体抛出，不当作单项失败", async () => {
    // 让 type 抛接管错误
    const h2 = createHandlers({
      actions: {
        modifierBits,
        v1Internals: {
          aiScope: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
          beforeState: () => ({}),
          actionResult: () => ({}),
          CHECKED_STATE_FN: "x",
          callOnNode: async () => ({ type: "text" }),
          typeBody: async () => {
            throw new BrowserError("USER_TOOK_OVER", "用户接管了");
          },
        },
      },
      requireSession: () => ({
        runAction: async (_o: unknown, fn: (ctx: any) => Promise<unknown>) =>
          fn({ tab: { ensureCdp: async () => {}, resolveRef: (r: string) => ({ ref: r }), setAI: async () => {} }, check: () => {}, describe: () => {} }),
      }),
    } as any);
    await expect(h2.fill_form("t", { fields: [{ ref: "e1", value: "a" }] })).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
  });
});

describe("mouse handler（假 session）", () => {
  it("越界坐标在派发任何鼠标事件之前就抛 BAD_ARGS", async () => {
    const h = makeHarness({ viewport: { viewportW: 100, viewportH: 80 } });
    await expect(h.handlers.mouse("t", { action: "click", x: 150, y: 10, button: "left" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(h.handlers.mouse("t", { action: "click", x: 10, y: 80, button: "left" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(h.mouseEvents.length).toBe(0);
  });

  it("click：带 modifiers 位掩码与 button；double_click 的 clickCount=2", async () => {
    const h = makeHarness({});
    await h.handlers.mouse("t", { action: "click", x: 10, y: 20, button: "right", modifiers: ["Control", "Shift"] });
    expect(h.mouseEvents[0]).toMatchObject({ type: "click", x: 10, y: 20, button: "right", clickCount: 1, modifiers: 2 | 8 });
    await h.handlers.mouse("t", { action: "double_click", x: 10, y: 20, button: "left" });
    expect(h.mouseEvents[1]).toMatchObject({ clickCount: 2, modifiers: 0 });
  });

  it("wheel：先 mouseMoved 到位再发 mouseWheel（带 delta）", async () => {
    const h = makeHarness({});
    await h.handlers.mouse("t", { action: "wheel", x: 30, y: 40, button: "left", deltaX: 0, deltaY: 120 });
    expect(h.mouseEvents.map((e) => e.type)).toEqual(["mouseMoved", "mouseWheel"]);
    expect(h.mouseEvents[1]).toMatchObject({ x: 30, y: 40, deltaX: 0, deltaY: 120 });
  });

  it("down → move → up：move 带着已按下的 buttons（页面拖拽逻辑才认），up 后清零", async () => {
    const h = makeHarness({});
    // 同一个 tab 对象（makeHarness 内共享）：连续三次调用
    await h.handlers.mouse("t", { action: "down", x: 5, y: 5, button: "left" });
    await h.handlers.mouse("t", { action: "move", x: 50, y: 50, button: "left" });
    await h.handlers.mouse("t", { action: "up", x: 50, y: 50, button: "left" });
    const types = h.mouseEvents.map((e) => e.type);
    expect(types).toEqual(["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"]);
    expect(h.mouseEvents[1]).toMatchObject({ buttons: 1, button: "left" });
    expect(h.mouseEvents[2]).toMatchObject({ x: 50, y: 50, buttons: 1, button: "left" });
    expect(h.mouseEvents[3]).toMatchObject({ buttons: 0 });
  });

  it("活动日志文案只含坐标", async () => {
    const h = makeHarness({});
    await h.handlers.mouse("t", { action: "click", x: 10, y: 20, button: "left" });
    expect(h.described[0].summary).toBe("鼠标点击 (10, 20)");
  });
});
