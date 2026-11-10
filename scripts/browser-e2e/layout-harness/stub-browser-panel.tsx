import type { ReactNode } from "react";

/**
 * BrowserPanel 的桩：e2e harness 只验证「分栏的折叠 / 还原 / 关闭」这套布局行为（真 hook + 真 ChatBrowserSplit + 真 react-resizable-panels），
 * 真 BrowserPanel 要 window.__browser 与原生视图，这里不需要。vite.config.mjs 把 chat-browser-split 里的 `./browser-panel` 换成它。
 */
export const BrowserPanel = (p: {
  onClose?: () => void;
  maximized?: boolean;
  onToggleMaximize?: () => void;
}): ReactNode => (
  <div id="bp" data-max={String(!!p.maximized)}>
    <button id="bp-x" onClick={p.onClose}>
      x
    </button>
    <button id="bp-max" onClick={p.onToggleMaximize}>
      max
    </button>
  </div>
);
