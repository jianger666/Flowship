import { createRoot } from "react-dom/client";
import type { CSSProperties } from "react";

import { ChatBrowserSplit } from "@/components/browser/chat-browser-split";
import { useChatBrowserPane } from "@/components/browser/use-chat-browser-pane";
import {
  readChatBrowserPercent,
  writeChatBrowserOpen,
  writeChatBrowserPercent,
} from "@/components/browser/browser-layout-memory";

/**
 * chat 分栏的 e2e harness：渲染**真的** useChatBrowserPane + ChatBrowserSplit（BrowserPanel 换成桩，见 stub-browser-panel.tsx），
 * 由 r9-chat-split-cover.cjs 打包后放进真 Electron 窗口，用真库、真鼠标验证。
 *
 * URL 参数：w / h（容器像素尺寸）、pct（先写入「记住的浏览器宽度」）、preopen=1（挂载时就是开着：模拟切任务 / 重进聊天页）。
 * 每次加载都先清 localStorage，免得同一个 userData 下上一个窗口写的宽度串进来。
 */
const q = new URLSearchParams(location.search);
const W = Number(q.get("w") ?? 1400);
const H = Number(q.get("h") ?? 600);
const w = window as unknown as Record<string, unknown>;

localStorage.clear();
w.__lib = { readChatBrowserPercent, writeChatBrowserPercent };
if (q.get("pct")) writeChatBrowserPercent(Number(q.get("pct")));
if (q.get("preopen")) writeChatBrowserOpen("t1", true);

const box: CSSProperties = { width: W, height: H, display: "flex", flexDirection: "column" };

const ChatApp = () => {
  const pane = useChatBrowserPane("t1", false);
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

createRoot(document.getElementById("root")!).render(<ChatApp />);
