/**
 * R2-13 ③：页面 `prompt()` 对话框条——不抢用户正在打字的焦点 + message / defaultPrompt 展示前清洗。
 *
 * 没有 DOM 环境（vitest 是 node、没装 jsdom），所以三层覆盖：
 *  - 纯函数：可编辑元素判定 / 焦点处置 / 文本清洗（用最小对象字面量当「元素」）；
 *  - SSR：渲染出来的 HTML 里没有 `autofocus`、预填值与说明文字已剥格式字符；
 *  - 源码契约：组件里不再有 `autoFocus` 属性、聚焦只经 `decideDialogInputFocus(document.activeElement, …)`。
 * 真窗口里「用户在聊天输入框打字时页面弹 prompt，焦点不被抢」没有自动化覆盖——需要真机核对（见 /tmp/r2-s2-report.md）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowserDialogBar } from "@/components/browser/browser-dialog-bar";
import {
  DIALOG_DEFAULT_MAX_CHARS,
  DIALOG_EMPTY_MESSAGE,
  DIALOG_FOCUS_HELD_HINT,
  DIALOG_MESSAGE_MAX_CHARS,
  decideDialogInputFocus,
  dialogDefaultText,
  dialogMessageText,
  isEditableElement,
  shouldAutoFocusDialogInput,
  type FocusTargetLike,
} from "@/components/browser/browser-dialog-logic";

const ROOT = path.resolve(import.meta.dirname, "..");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const barSource = () => readFileSync(path.join(ROOT, "src/components/browser/browser-dialog-bar.tsx"), "utf8");

const el = (over: FocusTargetLike): FocusTargetLike => ({ getAttribute: () => null, ...over });

describe("isEditableElement / shouldAutoFocusDialogInput", () => {
  it("可编辑：文本类 input、textarea、contenteditable（含空串 / true / plaintext-only）", () => {
    for (const type of ["text", "password", "search", "email", "url", "tel", "number", "date", "datetime-local"]) {
      expect(isEditableElement(el({ tagName: "INPUT", type })), `input[type=${type}]`).toBe(true);
    }
    expect(isEditableElement(el({ tagName: "input" }))).toBe(true); // 小写 tagName、没有 type（默认 text）
    expect(isEditableElement(el({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableElement(el({ tagName: "DIV", isContentEditable: true }))).toBe(true);
    for (const v of ["", "true", "plaintext-only", "TRUE"]) {
      expect(isEditableElement(el({ tagName: "DIV", getAttribute: (n) => (n === "contenteditable" ? v : null) })), `contenteditable=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("不算可编辑：按钮 / 勾选 / 单选 / 滑块 / 取色 / 文件 / select / 普通元素 / contenteditable=false / disabled / readonly / null", () => {
    for (const type of ["button", "checkbox", "radio", "submit", "reset", "image", "file", "range", "color", "hidden"]) {
      expect(isEditableElement(el({ tagName: "INPUT", type })), `input[type=${type}]`).toBe(false);
    }
    expect(isEditableElement(el({ tagName: "BUTTON" }))).toBe(false);
    expect(isEditableElement(el({ tagName: "SELECT" }))).toBe(false);
    expect(isEditableElement(el({ tagName: "BODY" }))).toBe(false);
    expect(isEditableElement(el({ tagName: "DIV", getAttribute: (n) => (n === "contenteditable" ? "false" : null) }))).toBe(false);
    expect(isEditableElement(el({ tagName: "INPUT", type: "text", disabled: true }))).toBe(false);
    expect(isEditableElement(el({ tagName: "INPUT", type: "text", readOnly: true }))).toBe(false);
    expect(isEditableElement(el({ tagName: "TEXTAREA", readOnly: true }))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(undefined)).toBe(false);
  });

  it("用户正在输入框 / 编辑器里：不自动聚焦；焦点在 body / 按钮 / 没有焦点：才聚焦", () => {
    expect(shouldAutoFocusDialogInput(el({ tagName: "TEXTAREA" }))).toBe(false); // 聊天输入框
    expect(shouldAutoFocusDialogInput(el({ tagName: "DIV", isContentEditable: true }))).toBe(false); // 富文本编辑器
    expect(shouldAutoFocusDialogInput(el({ tagName: "INPUT", type: "text" }))).toBe(false);
    expect(shouldAutoFocusDialogInput(el({ tagName: "BODY" }))).toBe(true);
    expect(shouldAutoFocusDialogInput(el({ tagName: "BUTTON" }))).toBe(true);
    expect(shouldAutoFocusDialogInput(null)).toBe(true);
  });

  it("decideDialogInputFocus：别处在打字 → held（显示提示）；空闲 → focus；焦点已在条自己的输入框 → already（StrictMode 第二遍不误报）", () => {
    expect(decideDialogInputFocus(el({ tagName: "TEXTAREA" }), false)).toBe("held");
    expect(decideDialogInputFocus(el({ tagName: "BODY" }), false)).toBe("focus");
    expect(decideDialogInputFocus(null, false)).toBe("focus");
    // 焦点在条自己的输入框里（也是可编辑元素）：不能被当成「别处在打字」
    expect(decideDialogInputFocus(el({ tagName: "INPUT", type: "text" }), true)).toBe("already");
  });
});

describe("对话框文字清洗", () => {
  it("说明文字：剥方向控制 / 零宽 / tag 字符，压成单行；全是不可见字符 → 占位", () => {
    expect(dialogMessageText("确认\u202E删除\u202C吗\u200B？")).toBe("确认删除吗？");
    expect(dialogMessageText("a\nb\r\nc\td")).toBe("a b c d");
    expect(dialogMessageText("x\u{E0069}\u{E0067}y")).toBe("xy");
    expect(dialogMessageText("\u202E\u200B\u2066")).toBe(DIALOG_EMPTY_MESSAGE);
    expect(dialogMessageText("")).toBe(DIALOG_EMPTY_MESSAGE);
    expect(dialogMessageText(undefined)).toBe(DIALOG_EMPTY_MESSAGE);
  });

  it("说明文字限长（页面可给数 MB）", () => {
    const out = dialogMessageText("中".repeat(DIALOG_MESSAGE_MAX_CHARS * 5));
    expect(out.length).toBe(DIALOG_MESSAGE_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prompt 默认值：剥格式字符；换行 / 制表折成空格；限长", () => {
    expect(dialogDefaultText("abc\u202Edef")).toBe("abcdef");
    expect(dialogDefaultText("a\nb\tc")).toBe("a b c");
    expect(dialogDefaultText("\u200B")).toBe("");
    expect(dialogDefaultText(undefined)).toBe("");
    expect(dialogDefaultText("x".repeat(DIALOG_DEFAULT_MAX_CHARS + 10)).length).toBe(DIALOG_DEFAULT_MAX_CHARS);
  });
});

describe("对话框条 SSR（无 window / document）", () => {
  const render = (dialog: Parameters<typeof BrowserDialogBar>[0]["dialog"]) =>
    renderToStaticMarkup(createElement(BrowserDialogBar, { taskId: "t1", dialog }));

  it("prompt：渲染出的输入框没有 autofocus 属性（React 的 autoFocus 在 SSR 里会输出 autofocus）", () => {
    const html = render({ type: "prompt", message: "你叫什么？", defaultPrompt: "张三", url: "https://e.com", since: 1 });
    expect(html).toContain("<input");
    expect(html).not.toMatch(/autofocus/i);
    // 没挂载 effect 时不会出现「没抢焦点」提示
    expect(html).not.toContain(DIALOG_FOCUS_HELD_HINT);
  });

  it("prompt：defaultPrompt 与 message 里的方向控制 / 零宽字符不会原样进 DOM", () => {
    const html = render({
      type: "prompt",
      message: "请输入\u202E密码\u200B：",
      defaultPrompt: "a\u202Eb\u200Bc\u{E0069}",
      url: "https://e.com",
      since: 2,
    });
    expect(html).toContain('value="abc"');
    expect(html).toContain("请输入密码：");
    for (const ch of ["\u202E", "\u200B", "\u{E0069}"]) expect(html).not.toContain(ch);
  });

  it("confirm / alert：说明文字同样清洗，全是不可见字符时给占位", () => {
    const confirm = render({ type: "confirm", message: "删除\u202E？", url: "u", since: 3 });
    expect(confirm).toContain("删除？");
    expect(confirm).not.toContain("\u202E");
    const alert = render({ type: "alert", message: "\u202E\u200B", url: "u", since: 4 });
    expect(alert).toContain(DIALOG_EMPTY_MESSAGE);
  });
});

describe("对话框条源码契约", () => {
  const code = () => stripComments(barSource());

  it("不再有 autoFocus 属性；聚焦只经 decideDialogInputFocus(document.activeElement, …)，且在 effect 里（不是渲染期）", () => {
    const src = code();
    expect(src).not.toMatch(/\bautoFocus\b/);
    expect(src).toContain("decideDialogInputFocus(active,");
    expect(src).toContain("document.activeElement");
    // .focus() 只出现在 action === "focus" 分支里
    expect(src.match(/\.focus\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/action === "focus"\)\s*inputWrapRef\.current\?\.querySelector\("input"\)\?\.focus\(\)/);
    expect(src).toMatch(/action === "held"\)\s*setFocusHeld\(true\)/);
    // 用户自己点进输入框后提示消失
    expect(src).toContain("onFocus={() => setFocusHeld(false)}");
    // 提示用的文案常量被渲染
    expect(src).toContain("{DIALOG_FOCUS_HELD_HINT}");
  });

  it("message / defaultPrompt 展示前经 dialogMessageText / dialogDefaultText，不再直接渲染 model.message / defaultPrompt", () => {
    const src = code();
    expect(src).toContain("dialogMessageText(model.message)");
    expect(src).toContain("dialogDefaultText(model?.defaultPrompt)");
    expect(src).not.toMatch(/\{model\.message\}/);
    expect(src).not.toMatch(/useState\(model\?\.defaultPrompt/);
  });

  it("Enter 提交：仍避开输入法组字，且长按重复的 Enter（e.repeat）不算答复", () => {
    const src = code();
    expect(src).toContain('e.key === "Enter" && !e.repeat && !isImeComposing(e)');
  });
});
