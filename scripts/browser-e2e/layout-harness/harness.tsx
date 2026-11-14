import { createRoot, type Root } from "react-dom/client";
import type { CSSProperties } from "react";

import { ChatBrowserSplit } from "@/components/browser/chat-browser-split";
import { useChatBrowserPane } from "@/components/browser/use-chat-browser-pane";
import {
  readChatBrowserCovered,
  readChatBrowserOpen,
  readChatBrowserPercent,
  writeChatBrowserCovered,
  writeChatBrowserOpen,
  writeChatBrowserPercent,
} from "@/components/browser/browser-layout-memory";

/**
 * chat 分栏的 e2e harness：渲染**真的** useChatBrowserPane + ChatBrowserSplit（BrowserPanel 换成桩，见 stub-browser-panel.tsx），
 * 由 r9-chat-split-cover.cjs 打包后放进真 Electron 窗口，用真库、真鼠标验证。
 *
 * URL 参数：w / h（容器像素尺寸）、pct（先写入「记住的浏览器宽度」）、preopen=1（挂载时就是开着：模拟切任务 / 重进聊天页）、
 * precover=1（在 preopen 的基础上，再记下「用户上次离开时浏览器是放大着的」）、pendingask=1（挂载时有等待回答的提问）。
 * 每次加载都先清 localStorage，免得同一个 userData 下上一个窗口写的宽度串进来。
 *
 * window.unmountApp() / window.mountApp()：卸载 / 重新挂载整个聊天页（模块级的开合 / 放大记忆不动）——
 * 模拟「切到别的任务 / 页面再切回来」，这正是「放大着切走再切回，对话又被打开」那个问题的现场。
 */
const q = new URLSearchParams(location.search);
const W = Number(q.get("w") ?? 1400);
const H = Number(q.get("h") ?? 600);
const w = window as unknown as Record<string, unknown>;

localStorage.clear();
w.__lib = {
  readChatBrowserPercent,
  writeChatBrowserPercent,
  readChatBrowserOpen: () => readChatBrowserOpen("t1"),
  readChatBrowserCovered: () => readChatBrowserCovered("t1"),
};
if (q.get("pct")) writeChatBrowserPercent(Number(q.get("pct")));
if (q.get("preopen")) writeChatBrowserOpen("t1", true);
if (q.get("precover")) writeChatBrowserCovered("t1", true);
const hasPendingAsk = q.get("pendingask") === "1";

const box: CSSProperties = { width: W, height: H, display: "flex", flexDirection: "column" };

const ChatApp = () => {
  const pane = useChatBrowserPane("t1", false, { hasPendingAsk });
  w.pane = pane;
  return (
    <div id="box" style={box}>
      <ChatBrowserSplit taskId="t1" pane={pane}>
        <div id="chat" style={{ height: "100%" }}>
          chat
        </div>
      </ChatBrowserSplit>
    </div>
  );
};

let root: Root | null = null;
w.mountApp = () => {
  if (root) return;
  root = createRoot(document.getElementById("root")!);
  root.render(<ChatApp />);
};
w.unmountApp = () => {
  root?.unmount();
  root = null;
};
(w.mountApp as () => void)();
