/**
 * R7-09-4：浏览器类链接 tooltip 首行（BrowserOpenHint）的文案必须跟「此刻」的设置走，且只有「设置 = 内置 + 有内置浏览器桥」才说内置。
 *
 * 为什么单独测：tooltip 的 Popup 要真实 hover 才挂载，SSR 渲染 LocalFileLink 看不到它；
 * 它被抽成独立组件、只在 Popup 挂载时渲染，所以每次渲染都重读设置——这里用可变的 mock 设置模拟「设置页切换后再 hover」。
 * 同时钉住「LocalFileLink 自己不读设置」（读了就会在设置页切换后一直是旧文案）：见 tests/browser-r7-open-bridge.test.ts 的源码契约。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "builtin" as "builtin" | "system", reads: 0 }));

vi.mock("@/components/browser/open-in-builtin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/browser/open-in-builtin")>();
  return {
    ...actual,
    readLinkOpenMode: () => {
      state.reads += 1;
      return state.mode;
    },
  };
});

import { BrowserOpenHint } from "@/components/ui/local-file-link";

const render = (builtinBridge: boolean): string => renderToStaticMarkup(createElement(BrowserOpenHint, { builtinBridge }));

describe("BrowserOpenHint（tooltip 首行文案）", () => {
  it("设置 = 内置 且有内置浏览器桥 → 「点击在内置浏览器打开」", () => {
    state.mode = "builtin";
    expect(render(true)).toBe("点击在内置浏览器打开");
  });

  it("设置 = 内置 但没有桥（浏览器 / 非 Electron） → 仍是系统浏览器（文案不能说谎）", () => {
    state.mode = "builtin";
    expect(render(false)).toBe("点击在系统浏览器打开");
  });

  it("设置 = 系统 → 不管有没有桥都是系统浏览器", () => {
    state.mode = "system";
    expect(render(true)).toBe("点击在系统浏览器打开");
    expect(render(false)).toBe("点击在系统浏览器打开");
  });

  it("每次渲染都重读设置：同一个组件、设置在两次渲染之间切换 → 文案跟着变（响应式的前提）", () => {
    state.mode = "system";
    const before = state.reads;
    expect(render(true)).toBe("点击在系统浏览器打开");
    state.mode = "builtin";
    expect(render(true)).toBe("点击在内置浏览器打开");
    state.mode = "system";
    expect(render(true)).toBe("点击在系统浏览器打开");
    expect(state.reads - before).toBe(3);
  });
});
