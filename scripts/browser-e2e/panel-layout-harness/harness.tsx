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
 *   bm=<N> bmcur=1           收藏夹桩：`/api/browser/bookmarks` 由内存里的 N 条收藏应答（GET 列表 / POST 加 / DELETE 删；默认 0 条）；
 *                            bmcur=1 再加一条「当前页」的收藏（地址栏星标应呈已收藏态）
 *   hist=<N>                 地址栏记忆桩：`/api/browser/history` 由内存里的 N 条历史应答（GET 列表 / POST 记 / DELETE 按 id 删或 ?all=1 清空；默认 0 条）。
 *                            这是个**桩**：只验证面板与真 store / 真 fetch 的接线与真实排版，不验证服务端存储（那有 tests/browser-history-server.test.ts）
 *
 * 页面上挂了几个只读探针供 e2e 断言：`__navCalls`（面板调 bridge.navigate 的入参）、`__coverCalls`（setCovered 的入参）、`__historyIds()`（桩里现存的历史 id）
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

// 收藏夹接口桩：面板里的星标 / 菜单 / 对话框走真实的 store 与真实的 fetch 调用，只是服务端换成内存列表（harness 是静态页，没有 Next 服务）
type StubBookmark = { id: string; url: string; title: string; createdAt: number };
let stubBookmarks: StubBookmark[] = Array.from({ length: Number(q.get("bm") ?? 0) }, (_, i) => ({
  id: `b${i}`,
  url: `https://site${i}.example.com/p/${i}`,
  title: `收藏标题 ${i}`,
  createdAt: 2_000_000 - i,
}));
if (q.get("bmcur") === "1") stubBookmarks = [{ id: "cur", url, title: "Example", createdAt: 3_000_000 }, ...stubBookmarks];
const stubJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// 地址栏记忆接口桩：编号小的更常去 / 更近（联想排序按「访问次数 × 新近度」，桩里让 0 号最靠前，断言时顺序可预期）
type StubHistory = { id: string; url: string; title: string; visitCount: number; lastVisitAt: number };
const histCount = Number(q.get("hist") ?? 0);
const NOW = Date.now();
let stubHistory: StubHistory[] = Array.from({ length: histCount }, (_, i) => ({
  id: `h${i}`,
  url: `https://site${i}.example.com/page/${i}`,
  title: `历史标题 ${i}`,
  visitCount: histCount - i + 1,
  lastVisitAt: NOW - i * 3_600_000,
}));
const historyStub = async (u: URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") return stubJson({ history: stubHistory });
  if (method === "DELETE") {
    if (u.searchParams.get("all") === "1") {
      const removed = stubHistory.length;
      stubHistory = [];
      return stubJson({ ok: true, removed });
    }
    const before = stubHistory.length;
    stubHistory = stubHistory.filter((h) => h.id !== u.searchParams.get("id"));
    return before === stubHistory.length ? stubJson({ error: "记录不存在", code: "not_found" }, 404) : stubJson({ ok: true, removed: 1 });
  }
  if (method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { url: string; title?: string };
    const entry: StubHistory = { id: `n${stubHistory.length}`, url: body.url, title: body.title || body.url, visitCount: 1, lastVisitAt: Date.now() };
    stubHistory = [entry, ...stubHistory.filter((h) => h.url !== entry.url)];
    return stubJson({ entry, created: true }, 201);
  }
  return new Response("", { status: 405 });
};

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw, "http://stub.local");
  if (u.pathname === "/api/browser/history") return historyStub(u, init);
  if (u.pathname !== "/api/browser/bookmarks") return new Response("", { status: 404 });
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") return stubJson({ bookmarks: stubBookmarks });
  if (method === "DELETE") {
    const before = stubBookmarks.length;
    stubBookmarks = stubBookmarks.filter((b) => b.id !== u.searchParams.get("id"));
    return before === stubBookmarks.length ? stubJson({ error: "收藏不存在", code: "not_found" }, 404) : stubJson({ ok: true });
  }
  if (method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { url: string; title?: string; createdAt?: number };
    const bookmark = { id: `n${stubBookmarks.length}-${body.createdAt ?? 0}`, url: body.url, title: body.title || body.url, createdAt: body.createdAt ?? Date.now() };
    stubBookmarks = [bookmark, ...stubBookmarks.filter((b) => b.url !== bookmark.url)];
    return stubJson({ bookmark, created: true }, 201);
  }
  return new Response("", { status: 405 });
}) as typeof fetch;

// 探针：面板调桥的入参（只读，供 e2e 断言）
const navCalls: string[] = [];
const coverCalls: boolean[] = [];
Object.assign(window, { __navCalls: navCalls, __coverCalls: coverCalls, __historyIds: () => stubHistory.map((h) => h.id) });

(window as unknown as { __browser: unknown }).__browser = new Proxy(
  {
    attach: async () => state,
    getState: async () => state,
    onState: () => noop,
    onPicked: () => noop,
    setBounds: noop,
    detach: noop,
    // 与真主进程的回复同形：{ ok, url: 实际去的地址, kind }（没带协议的补 https://）
    navigate: async (_taskId: string, input: string) => {
      navCalls.push(input);
      const text = input.trim();
      return { ok: true, url: /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`, kind: "url" };
    },
    setCovered: async (_taskId: string, covered: boolean) => {
      coverCalls.push(!!covered);
      return null;
    },
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
