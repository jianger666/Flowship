"use client";

/**
 * 浮层挂载点：默认所有 Tooltip / DropdownMenu 都 Portal 到 <body>。
 *
 * 但元素进入全屏（`element.requestFullscreen()`）后，浏览器只渲染「全屏元素及其后代」——
 * 挂在 <body> 上的浮层不管 z-index 多大都会被盖在全屏元素下面，看不见。
 * 播放器全屏时靠这个 Context 把挂载点换成全屏元素本身，菜单 / 提示才显示得出来。
 *
 * ⚠ 「没指定」必须是 `undefined`，**不能是 null**：Base UI 的 Portal 里 `container={null}` 表示
 * 「容器还没就绪，先等着」——弹层永远不渲染；只有 `undefined` 才走默认的 <body>。
 * 所以 Context 默认值是 undefined，hook 也会把任何 null 兜成 undefined，保证到 Portal 的值永远不是 null
 * （见 tests/popup-container.test.ts）。
 */

import { createContext, useContext } from "react";

const PopupContainerContext = createContext<HTMLElement | undefined>(undefined);

export const PopupContainerProvider = PopupContainerContext.Provider;

/** 当前浮层该挂到哪；undefined = 交给 Portal 的默认行为（<body>）。永远不返回 null */
export const usePopupContainer = (): HTMLElement | undefined => useContext(PopupContainerContext) ?? undefined;
