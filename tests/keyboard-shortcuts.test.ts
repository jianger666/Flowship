/**
 * 全局快捷键 / composer 键位纯判定单测（C / B / E2 批次）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DOUBLE_ESC_WINDOW_MS,
  SHEET_CONTENT_SELECTOR,
  isDoubleEsc,
  isInsideSheet,
  isModCombo,
  oppositeSubmitShortcut,
  resolveRunningSubmitAction,
  type KeyComboEvent,
} from "@/lib/keyboard-shortcuts";

const key = (partial: Partial<KeyComboEvent> & { key: string }): KeyComboEvent => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...partial,
});

describe("isModCombo（Cmd/Ctrl+字母）", () => {
  it("meta / ctrl 任一 + 目标键命中", () => {
    expect(isModCombo(key({ key: "k", metaKey: true }), "k")).toBe(true);
    expect(isModCombo(key({ key: "K", ctrlKey: true }), "k")).toBe(true);
  });

  it("裸键 / 带 alt / 带 shift 不命中（不劫持 Cmd+Shift+K 等系统位）", () => {
    expect(isModCombo(key({ key: "k" }), "k")).toBe(false);
    expect(isModCombo(key({ key: "k", metaKey: true, altKey: true }), "k")).toBe(false);
    expect(isModCombo(key({ key: "k", metaKey: true, shiftKey: true }), "k")).toBe(false);
  });

  it("键不同不命中", () => {
    expect(isModCombo(key({ key: "n", metaKey: true }), "k")).toBe(false);
  });
});

describe("isInsideSheet（焦点 / 按键目标是否在右侧抽屉里）", () => {
  /** 最小假节点：closest 只认抽屉选择器 */
  const node = (inside: boolean) => ({
    closest: (sel: string) => (sel === SHEET_CONTENT_SELECTOR && inside ? {} : null),
  });

  it("抽屉里的节点 → true；主界面节点 → false", () => {
    expect(isInsideSheet(node(true))).toBe(true);
    expect(isInsideSheet(node(false))).toBe(false);
  });

  it("用的是 SheetContent 的 data-slot 选择器（与 sheet.tsx 同一个口径）", () => {
    expect(SHEET_CONTENT_SELECTOR).toBe('[data-slot="sheet-content"]');
    const sheetSrc = readFileSync(
      path.resolve(import.meta.dirname, "..", "src", "components", "ui", "sheet.tsx"),
      "utf-8",
    );
    expect(sheetSrc).toContain('data-slot="sheet-content"');
  });

  it("没焦点 / 没有 closest（window、document 等非元素目标）→ false，不抛", () => {
    expect(isInsideSheet(null)).toBe(false);
    expect(isInsideSheet(undefined)).toBe(false);
    expect(isInsideSheet({} as EventTarget)).toBe(false);
  });
});

describe("oppositeSubmitShortcut", () => {
  it("enter ↔ mod-enter 互为对位", () => {
    expect(oppositeSubmitShortcut("enter")).toBe("mod-enter");
    expect(oppositeSubmitShortcut("mod-enter")).toBe("enter");
  });
});

describe("resolveRunningSubmitAction（运行中排队 / 立即发送双通道）", () => {
  it("偏好 enter：裸 Enter=排队、Cmd+Enter=立即发送", () => {
    expect(resolveRunningSubmitAction(key({ key: "Enter" }), "enter")).toBe(
      "queue",
    );
    expect(
      resolveRunningSubmitAction(key({ key: "Enter", metaKey: true }), "enter"),
    ).toBe("sendNow");
  });

  it("偏好 mod-enter：Cmd+Enter=排队、裸 Enter=立即发送（对调）", () => {
    expect(
      resolveRunningSubmitAction(
        key({ key: "Enter", ctrlKey: true }),
        "mod-enter",
      ),
    ).toBe("queue");
    expect(
      resolveRunningSubmitAction(key({ key: "Enter" }), "mod-enter"),
    ).toBe("sendNow");
  });

  it("Shift+Enter（换行）两种偏好都不触发", () => {
    expect(
      resolveRunningSubmitAction(key({ key: "Enter", shiftKey: true }), "enter"),
    ).toBeNull();
    expect(
      resolveRunningSubmitAction(
        key({ key: "Enter", shiftKey: true }),
        "mod-enter",
      ),
    ).toBeNull();
  });

  it("IME 组合输入中的 Enter 让行", () => {
    expect(
      resolveRunningSubmitAction(
        key({ key: "Enter", isComposing: true }),
        "enter",
      ),
    ).toBeNull();
  });

  it("非 Enter 键不触发", () => {
    expect(resolveRunningSubmitAction(key({ key: "a" }), "enter")).toBeNull();
  });
});

describe("isDoubleEsc（双击 Esc 清草稿窗口）", () => {
  it("窗口内第二次 Esc 命中", () => {
    expect(isDoubleEsc(1000, 1000 + DOUBLE_ESC_WINDOW_MS)).toBe(true);
    expect(isDoubleEsc(1000, 1100)).toBe(true);
  });

  it("超窗 / 无前次不命中", () => {
    expect(isDoubleEsc(1000, 1000 + DOUBLE_ESC_WINDOW_MS + 1)).toBe(false);
    expect(isDoubleEsc(null, 1000)).toBe(false);
  });
});
