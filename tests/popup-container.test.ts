/**
 * 浮层挂载点（popup-container）：Tooltip / DropdownMenu 的 Portal 容器从这里取。
 *
 * 关键不变量：到 Portal 的值**永远不是 null**。Base UI 的 Portal 里 `container={null}` 的意思是
 * 「容器还没就绪，先等着」——弹层永远不渲染；只有 `undefined` 才是「用默认的 <body>」。
 * 第一版 Context 默认值是 null，结果没有 Provider 的地方（= 整个应用除播放窗全屏外）所有
 * Tooltip / 下拉菜单都弹不出来，而当时的测试只是把出问题的写法当字符串钉住，没抓到。
 *
 * 没有 jsdom：hook 的返回值用 SSR 渲染探针看；「弹层真的出现在 DOM 里」靠 Base UI 的语义 + 这条不变量，
 * 真实组件在 jsdom 里的复现探针见 HANDOFF（审查侧做过，仓库里不装 jsdom）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PopupContainerProvider, usePopupContainer } from "@/components/ui/popup-container";

const ROOT = path.resolve(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

/** 探针：把 hook 拿到的值渲染成字符串（元素对象用 tag 表示） */
const Probe = () => {
  const v = usePopupContainer();
  return createElement("span", null, v === undefined ? "undefined" : v === null ? "null" : `el:${(v as { tag?: string }).tag ?? "?"}`);
};

const render = (provider?: { value: unknown }): string =>
  renderToStaticMarkup(
    provider
      ? createElement(PopupContainerProvider, { value: provider.value as never }, createElement(Probe))
      : createElement(Probe),
  );

describe("usePopupContainer：到 Portal 的值永远不是 null", () => {
  it("没有 Provider（应用里绝大多数地方）→ undefined（Portal 走默认的 <body>）", () => {
    expect(render()).toContain(">undefined<");
  });

  it("Provider value=undefined（播放窗窗口模式）→ undefined", () => {
    expect(render({ value: undefined })).toContain(">undefined<");
  });

  it("Provider value=null（JS 调用方 / 类型绕过传了 null）→ 兜底成 undefined，不能把 null 漏给 Portal", () => {
    expect(render({ value: null })).toContain(">undefined<");
  });

  it("Provider value=元素（播放窗全屏）→ 原样透传", () => {
    expect(render({ value: { tag: "fs-root" } })).toContain(">el:fs-root<");
  });
});

describe("接线：播放窗只会给 Provider 传元素或 undefined，Tooltip / DropdownMenu 只读这个 hook", () => {
  it("dock 的 Provider 不再有 `: null` 的分支", () => {
    const dock = readSrc("src/components/media/media-player-dock.tsx");
    const provider = dock.match(/<PopupContainerProvider value=\{[^}]*\}>/)?.[0] ?? "";
    expect(provider).not.toBe("");
    expect(provider).not.toMatch(/\bnull\b/);
  });

  it("popup-container 的 Context 默认值不是 null", () => {
    const src = readSrc("src/components/ui/popup-container.tsx");
    expect(src).not.toMatch(/createContext<[^>]*null[^>]*>\(null\)/);
    expect(src).toContain("createContext<HTMLElement | undefined>(undefined)");
  });

  it("tooltip / dropdown-menu 的 Portal 容器来自 usePopupContainer()", () => {
    for (const f of ["src/components/ui/tooltip.tsx", "src/components/ui/dropdown-menu.tsx"]) {
      const src = readSrc(f);
      expect(src, f).toContain("usePopupContainer()");
      expect(src, f).toMatch(/Portal container=\{container\}/);
    }
  });
});
