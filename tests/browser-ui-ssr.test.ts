/**
 * SSR 冒烟：服务端渲染（没有 window / window.__browser）下，浏览器相关组件不抛错、
 * 且退化成「仅桌面端可用」/ 什么都不画——网页版用户（pnpm dev:web）与改动前一致。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowserPanel } from "@/components/browser/browser-panel";
import { BrowserToggleButton } from "@/components/browser/browser-toggle-button";
import { BrowserUnavailable } from "@/components/browser/browser-unavailable";
import { LeftPaneSwitch } from "@/components/browser/left-pane-switch";

describe("浏览器 UI SSR 冒烟", () => {
  it("BrowserUnavailable：「仅桌面端可用」，不带错误语气", () => {
    const html = renderToStaticMarkup(createElement(BrowserUnavailable));
    expect(html).toContain("内置浏览器仅桌面端可用");
    expect(html).not.toMatch(/失败|错误|error/i);
  });

  it("BrowserPanel 无 bridge 分支：渲染「仅桌面端可用」，不渲染工具栏 / 地址栏", () => {
    const html = renderToStaticMarkup(createElement(BrowserPanel, { taskId: "t1" }));
    expect(html).toContain("内置浏览器仅桌面端可用");
    expect(html).not.toContain("地址栏");
    expect(html).not.toContain("data-browser-viewport");
  });

  it("头部入口按钮 / 左栏分段切换在没有 bridge 时什么都不画（对网页版用户零影响）", () => {
    expect(
      renderToStaticMarkup(createElement(BrowserToggleButton, { taskId: "t1", open: false, onToggle: () => {} })),
    ).toBe("");
    expect(
      renderToStaticMarkup(createElement(LeftPaneSwitch, { value: "artifact", onChange: () => {} })),
    ).toBe("");
  });
});
