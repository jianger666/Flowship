import "./app.css";
import { createRoot } from "react-dom/client";

import { BrowserPanel } from "@/components/browser/browser-panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DialogProvider } from "@/hooks/use-dialog";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import type { BrowserState, TabInfo } from "@/lib/browser-bridge-types";

/**
 * 面板排版 e2e harness：渲染**真的** BrowserPanel + 真 ResizablePanelGroup / ResizableHandle + 真 SidebarResizeHandle，
 * 样式走真 Tailwind（vite.config.mjs 里 @tailwindcss/postcss 吃仓库的 globals.css），`window.__browser` 换成桩（状态里带
 * 设备模拟 / 缩放 / 下载）。由 r13-panel-layout.cjs 打包后放进无头 Electron 窗口量真实布局像素。
 * 之前（R9-05 / R9-06 之前）没有任何自动化钉着「真实排版」：单测只能测纯函数，r9-chat-split-cover 的 harness 把 BrowserPanel 换成了桩。
 *
 * URL 参数：
 *   mode=toolbar|chat|task   toolbar = 只放一个 w×h 的面板；chat = 左对话右浏览器；task = 左浏览器（产物栏）右事件流，都带侧栏
 *   w / h                    容器像素尺寸（mode=toolbar 时 w 就是面板宽）
 *   emu=<摘要> fit=<0..1>     设备模拟摘要 / 缩放比例（有 fit 才有「适应 xx%」）
 *   zoom=<百分比> dl=<个数>   页面缩放（≠100 才显示标签）/ 下载记录条数（>0 才显示下载按钮）
 *   sidebar=<px> sbopen=0    侧栏宽度 / 收起
 *   art=<%>（task）bp=<%>（chat）  浏览器所在栏的默认占比
 *   url=<地址>
 */
const q = new URLSearchParams(location.search);
const mode = q.get("mode") ?? "toolbar";
const W = Number(q.get("w") ?? 420);
const H = Number(q.get("h") ?? 600);
const emu = q.get("emu");
const fit = q.get("fit") ? Number(q.get("fit")) : undefined;
const zoom = q.get("zoom") ? Number(q.get("zoom")) : undefined;
const dl = Number(q.get("dl") ?? 0);
const sidebar = Number(q.get("sidebar") ?? 256);
const sbOpen = q.get("sbopen") !== "0";
const art = Number(q.get("art") ?? 55);
const bp = Number(q.get("bp") ?? 42);
const url = q.get("url") ?? "https://example.com/some/long/path/index.html?x=1";

const tab: TabInfo = {
  id: "a",
  url,
  title: "Example",
  favicon: null,
  loading: false,
  canGoBack: true,
  canGoForward: false,
  isActive: true,
  ...(emu ? { emulation: emu } : {}),
  ...(fit ? { fitScale: fit } : {}),
  ...(zoom ? { zoom } : {}),
};
const state: BrowserState = {
  taskId: "t1",
  exists: true,
  controller: "idle",
  askRequest: null,
  aiLabel: null,
  aiLabelAt: null,
  activeTabId: "a",
  tabs: [tab],
  attached: true,
  covered: false,
  picking: false,
  pendingUserActivity: 0,
  recent: [],
  prompts: [],
  downloads: Array.from({ length: dl }, (_, i) => ({
    id: i + 1,
    fileName: `f${i}.zip`,
    path: "/tmp/x",
    url: "https://e.com/f",
    state: "completed" as const,
    receivedBytes: 10,
    totalBytes: 10,
    startedAt: 1,
    endedAt: 2,
  })),
};
const noop = () => {};
(window as unknown as { __browser: unknown }).__browser = new Proxy(
  {
    attach: async () => state,
    getState: async () => state,
    onState: () => noop,
    onPicked: () => noop,
    setBounds: noop,
    detach: noop,
    setCovered: async () => null,
    onFound: () => noop,
    onFindRequested: () => noop,
    openDevTools: noop,
    resetEmulation: noop,
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : noop) },
);

const Panel = () => <BrowserPanel taskId="t1" onClose={noop} maximized={false} onToggleMaximize={noop} coverTarget="事件流" />;

const Toolbar = () => (
  <div id="box" style={{ width: W, height: H }} className="flex flex-col">
    <Panel />
  </div>
);

const Sidebar = () => (
  <>
    <aside
      className="h-full shrink-0 overflow-hidden border-r border-border/60 bg-muted/30"
      style={{ width: sbOpen ? sidebar : 0 }}
    />
    <SidebarResizeHandle open={sbOpen} width={sidebar} maxWidth={480} onChange={noop} onResizingChange={noop} onReset={noop} />
  </>
);

// 任务页几何：侧栏 + 主区（左 = 浏览器的产物栏，右 = 事件流），栏宽下限与真页面一致（300 / 320）
const TaskGeo = () => (
  <div id="box" style={{ width: W, height: H }} className="flex">
    <Sidebar />
    <main className="min-w-0 flex-1" id="main">
      <div className="flex h-full min-h-0">
        <ResizablePanelGroup id="g" orientation="horizontal">
          <ResizablePanel id="artifact" defaultSize={`${art}%`} minSize="300px" collapsible collapsedSize={0}>
            <div className="h-full min-h-0">
              <Panel />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="event-stream" defaultSize={`${100 - art}%`} minSize="320px" collapsible collapsedSize={0}>
            <div className="h-full bg-card">event stream</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </main>
  </div>
);

// 聊天页几何：侧栏 + 主区（左 = 对话，右 = 浏览器）
const ChatGeo = () => (
  <div id="box" style={{ width: W, height: H }} className="flex">
    <Sidebar />
    <main className="min-w-0 flex-1">
      <ResizablePanelGroup id="g" orientation="horizontal">
        <ResizablePanel id="chat-main" defaultSize={`${100 - bp}%`} minSize="320px" collapsible collapsedSize={0}>
          <div className="h-full bg-card">chat</div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="chat-browser" defaultSize={`${bp}%`} minSize="300px" maxSize="100%" collapsible collapsedSize={0}>
          <div className="h-full">
            <Panel />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  </div>
);

createRoot(document.getElementById("root")!).render(
  <DialogProvider>{mode === "task" ? <TaskGeo /> : mode === "chat" ? <ChatGeo /> : <Toolbar />}</DialogProvider>,
);
