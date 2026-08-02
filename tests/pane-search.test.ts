/**
 * 「搜索此栏」作用域路由单测
 */
import { describe, expect, it, beforeEach } from "vitest";

import { isModCombo, type KeyComboEvent } from "@/lib/keyboard-shortcuts";
import {
  getActivePaneSearchScope,
  resetActivePaneSearchScope,
  resolvePaneSearchScope,
  setActivePaneSearchScope,
} from "@/lib/pane-search";

const key = (partial: Partial<KeyComboEvent> & { key: string }): KeyComboEvent => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...partial,
});

describe("resolvePaneSearchScope", () => {
  beforeEach(() => resetActivePaneSearchScope());

  it("有明确作用域时优先", () => {
    setActivePaneSearchScope("artifact");
    expect(resolvePaneSearchScope(getActivePaneSearchScope(), "/tasks/abc")).toBe(
      "artifact",
    );
    setActivePaneSearchScope("event-stream");
    expect(resolvePaneSearchScope(getActivePaneSearchScope(), "/tasks/abc")).toBe(
      "event-stream",
    );
  });

  it("离开任务详情后无栏内搜索", () => {
    expect(resolvePaneSearchScope("event-stream", "/settings")).toBe(null);
    expect(resolvePaneSearchScope("artifact", "/")).toBe(null);
  });

  it("无焦点：任务详情默认产物栏", () => {
    expect(resolvePaneSearchScope(null, "/tasks/abc")).toBe("artifact");
    expect(resolvePaneSearchScope(null, "/chats")).toBe(null);
    expect(resolvePaneSearchScope(null, "/")).toBe(null);
    expect(resolvePaneSearchScope(null, "/settings")).toBe(null);
  });
});

describe("Mod+F 判定", () => {
  it("Cmd/Ctrl+F 命中", () => {
    expect(isModCombo(key({ key: "f", metaKey: true }), "f")).toBe(true);
    expect(isModCombo(key({ key: "F", ctrlKey: true }), "f")).toBe(true);
  });

  it("Shift+Mod+F 不命中", () => {
    expect(
      isModCombo(key({ key: "f", metaKey: true, shiftKey: true }), "f"),
    ).toBe(false);
  });
});
