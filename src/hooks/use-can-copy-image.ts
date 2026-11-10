"use client";

import { useSyncExternalStore } from "react";

import { canCopyImage } from "@/lib/copy-image";

const noopSubscribe = () => () => {};

/**
 * 当前环境能不能往剪贴板写图片（`ClipboardItem` + `navigator.clipboard.write`）。
 *
 * 服务端渲染 / 水合首帧恒为 false（与服务端一致），水合后才读真实环境——不要在 render 里直接调
 * `canCopyImage()`：服务端没有 `navigator`、客户端有，首帧会对不上（水合不一致）。写法同 `useBrowserAvailable`。
 */
export const useCanCopyImage = (): boolean => useSyncExternalStore(noopSubscribe, canCopyImage, () => false);
