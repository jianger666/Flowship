/**
 * 「搜索此栏」作用域路由单测
 */
import { describe, expect, it, beforeEach } from "vitest";

import { isModCombo, type KeyComboEvent } from "@/lib/keyboard-shortcuts";
import {
  getActivePaneSearchScope,
  isArtifactPaneCollapsed,
  resetActivePaneSearchScope,
  resolvePaneSearchScope,
  setActivePaneSearchScope,
  setArtifactPaneCollapsed,
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

describe("R9a-01：产物栏折叠后 Cmd/Ctrl+F 不再路由到产物栏", () => {
  beforeEach(() => resetActivePaneSearchScope());

  it("折叠 + 无焦点记忆 / 最后点的是产物栏 → 事件流；没折叠仍是产物栏", () => {
    expect(resolvePaneSearchScope(null, "/tasks/abc", true)).toBe("event-stream");
    expect(resolvePaneSearchScope("artifact", "/tasks/abc", true)).toBe("event-stream");
    expect(resolvePaneSearchScope("event-stream", "/tasks/abc", true)).toBe("event-stream");
    expect(resolvePaneSearchScope(null, "/tasks/abc", false)).toBe("artifact");
    expect(resolvePaneSearchScope("artifact", "/tasks/abc")).toBe("artifact");
    // 非任务页不受影响
    expect(resolvePaneSearchScope(null, "/settings", true)).toBe(null);
  });

  it("折叠标记是模块级状态：页面写入、reset 复位", () => {
    expect(isArtifactPaneCollapsed()).toBe(false);
    setArtifactPaneCollapsed(true);
    expect(isArtifactPaneCollapsed()).toBe(true);
    resetActivePaneSearchScope();
    expect(isArtifactPaneCollapsed()).toBe(false);
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
