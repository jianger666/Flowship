/**
 * R7：聊天链接 / 本地 HTML「在当前任务的内置浏览器新标签打开」的渲染侧桥与接线。
 *
 * - browser-panel-bridge：当前显示着的任务（注册顺序、注销后回退到上一个）、requestOpenInActiveBrowser、newTab 意图随 pending 一起存取、
 *   与旧的 requestOpenInBrowser / takePendingNavigation 兼容
 * - decidePanelOpen：newTab 意图落地规则（没有会话 → 导航启动会话；当前标签空白 → 复用；否则新标签）
 * - 接线契约（读源码）：MarkdownLink / LocalFileLink / browser-panel / 设置页确实走了这条路
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrowserState, TabInfo } from "@/lib/browser-bridge-types";
import {
  PENDING_NAVIGATION_TTL_MS,
  getActiveBrowserTaskId,
  registerBrowserPanelOpener,
  requestOpenInActiveBrowser,
  requestOpenInBrowser,
  takePendingNavigation,
  takePendingNavigationRequest,
} from "@/components/browser/browser-panel-bridge";
import { decidePanelOpen } from "@/components/browser/browser-status";
import { MarkdownLink } from "@/components/markdown-link";
import { ImagePreviewProvider } from "@/components/ui/image-preview";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  id: "t1",
  url: "https://example.com/",
  title: "Example",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true,
  ...over,
});
const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  taskId: "task-a",
  exists: true,
  controller: "idle",
  askRequest: null,
  aiLabel: null,
  aiLabelAt: null,
  activeTabId: "t1",
  tabs: [tab()],
  attached: true,
  covered: false,
  picking: false,
  pendingUserActivity: 0,
  recent: [],
  ...over,
});

describe("browser-panel-bridge：当前显示着的任务", () => {
  it("没有任何注册 → null；requestOpenInActiveBrowser 返回 false 且不留待导航", () => {
    expect(getActiveBrowserTaskId()).toBeNull();
    expect(requestOpenInActiveBrowser("https://example.com/")).toBe(false);
  });

  it("最后注册的就是当前任务；注销后回到前一个；全部注销回到 null", () => {
    const offA = registerBrowserPanelOpener("task-a", vi.fn());
    expect(getActiveBrowserTaskId()).toBe("task-a");
    const offB = registerBrowserPanelOpener("task-b", vi.fn());
    expect(getActiveBrowserTaskId()).toBe("task-b");
    offB();
    expect(getActiveBrowserTaskId()).toBe("task-a");
    offA();
    expect(getActiveBrowserTaskId()).toBeNull();
  });

  it("同一个任务重复注册（effect 重跑）：移到最新；旧注销函数不误伤新的注册", () => {
    const opener1 = vi.fn();
    const off1 = registerBrowserPanelOpener("task-a", opener1);
    const offB = registerBrowserPanelOpener("task-b", vi.fn());
    const opener2 = vi.fn();
    const off2 = registerBrowserPanelOpener("task-a", opener2);
    expect(getActiveBrowserTaskId()).toBe("task-a");
    off1(); // 旧的注销：opener 已被替换，不能把 task-a 注销掉
    expect(getActiveBrowserTaskId()).toBe("task-a");
    off2();
    expect(getActiveBrowserTaskId()).toBe("task-b");
    offB();
    expect(getActiveBrowserTaskId()).toBeNull();
  });

  it("requestOpenInActiveBrowser：调当前任务的 opener，登记 newTab 意图", () => {
    const openerA = vi.fn();
    const openerB = vi.fn();
    const offA = registerBrowserPanelOpener("task-a", openerA);
    const offB = registerBrowserPanelOpener("task-b", openerB);
    expect(requestOpenInActiveBrowser("https://example.com/x", { newTab: true }, 1000)).toBe(true);
    expect(openerB).toHaveBeenCalledTimes(1);
    expect(openerA).not.toHaveBeenCalled();
    expect(takePendingNavigationRequest("task-a", 1000)).toBeNull(); // 没有串到别的任务
    expect(takePendingNavigationRequest("task-b", 1000)).toEqual({ url: "https://example.com/x", newTab: true });
    expect(takePendingNavigationRequest("task-b", 1000)).toBeNull(); // 取走即清
    offB();
    offA();
  });
});

describe("pending 导航：newTab 意图随地址一起存取，旧接口兼容", () => {
  it("默认 newTab=false（预览入口 / 旧调用方行为不变）", () => {
    const off = registerBrowserPanelOpener("task-c", vi.fn());
    expect(requestOpenInBrowser("task-c", "http://localhost:3000", 1000)).toBe(true);
    expect(takePendingNavigationRequest("task-c", 1000)).toEqual({ url: "http://localhost:3000", newTab: false });
    off();
  });

  it("显式 newTab:true；takePendingNavigation（旧）只取地址、同样清掉", () => {
    const off = registerBrowserPanelOpener("task-c", vi.fn());
    requestOpenInBrowser("task-c", "https://example.com/", 1000, { newTab: true });
    expect(takePendingNavigation("task-c", 1000)).toBe("https://example.com/");
    expect(takePendingNavigationRequest("task-c", 1000)).toBeNull();
    off();
  });

  it("newTab 只认严格 true（脏值当 false）", () => {
    const off = registerBrowserPanelOpener("task-c", vi.fn());
    requestOpenInBrowser("task-c", "https://example.com/", 1000, { newTab: "yes" as unknown as boolean });
    expect(takePendingNavigationRequest("task-c", 1000)?.newTab).toBe(false);
    off();
  });

  it("过期（> 30s）作废；刚好 30s 还有效", () => {
    const off = registerBrowserPanelOpener("task-c", vi.fn());
    requestOpenInBrowser("task-c", "https://example.com/", 1000, { newTab: true });
    expect(takePendingNavigationRequest("task-c", 1000 + PENDING_NAVIGATION_TTL_MS + 1)).toBeNull();
    requestOpenInBrowser("task-c", "https://example.com/", 1000, { newTab: true });
    expect(takePendingNavigationRequest("task-c", 1000 + PENDING_NAVIGATION_TTL_MS)).not.toBeNull();
    off();
  });
});

describe("decidePanelOpen：newTab 意图怎么落地", () => {
  it("没要求新标签 → 导航当前标签（旧行为）", () => {
    expect(decidePanelOpen(state(), { newTab: false })).toBe("navigate");
  });
  it("没有会话（state 为空 / exists=false）→ navigate：启动会话，首个标签就是目标页", () => {
    expect(decidePanelOpen(null, { newTab: true })).toBe("navigate");
    expect(decidePanelOpen(undefined, { newTab: true })).toBe("navigate");
    expect(decidePanelOpen(state({ exists: false, tabs: [] }), { newTab: true })).toBe("navigate");
    // 会话已关但 state 里还残留着旧标签：也不能往一个不存在的会话里 new-tab（走导航 = 重新启动会话）
    expect(decidePanelOpen(state({ exists: false }), { newTab: true })).toBe("navigate");
  });
  it("当前标签有内容 → new-tab（不覆盖用户 / AI 正在看的页面）", () => {
    expect(decidePanelOpen(state(), { newTab: true })).toBe("new-tab");
    expect(decidePanelOpen(state({ tabs: [tab({ loading: true })] }), { newTab: true })).toBe("new-tab");
  });
  it("当前标签空白（about:blank / 空地址）或没有标签 → 复用（navigate），别白留一个空白页", () => {
    expect(decidePanelOpen(state({ tabs: [tab({ url: "about:blank" })] }), { newTab: true })).toBe("navigate");
    expect(decidePanelOpen(state({ tabs: [tab({ url: "" })] }), { newTab: true })).toBe("navigate");
    expect(decidePanelOpen(state({ tabs: [], activeTabId: null }), { newTab: true })).toBe("navigate");
  });
  it("多标签时看的是激活的那个（不是第一个）", () => {
    const tabs = [tab({ id: "t1", url: "about:blank", isActive: false }), tab({ id: "t2", url: "https://example.com/", isActive: true })];
    expect(decidePanelOpen(state({ tabs, activeTabId: "t2" }), { newTab: true })).toBe("new-tab");
    const tabs2 = [tab({ id: "t1", url: "https://example.com/", isActive: false }), tab({ id: "t2", url: "about:blank", isActive: true })];
    expect(decidePanelOpen(state({ tabs: tabs2, activeTabId: "t2" }), { newTab: true })).toBe("navigate");
  });
});

describe("接线契约（读源码）", () => {
  it("browser-panel：消费 pending 时按 decidePanelOpen 分流，新标签走 bridge.newTab，失败有提示", () => {
    const src = code("src/components/browser/browser-panel.tsx");
    expect(src).toContain("takePendingNavigationRequest(taskId)");
    expect(src).toMatch(/decidePanelOpen\(stateRef\.current, nav\) === "new-tab"/);
    expect(src).toMatch(/bridge\.newTab\(taskId, url\)/);
    expect(src).toContain("内置浏览器打不开这个地址");
    // 旧的单一 takePendingNavigation 不应再被面板直接使用（会丢 newTab 意图）
    expect(src).not.toMatch(/\btakePendingNavigation\(/);
  });

  it("MarkdownLink：http(s) 点击先问 openHttpInBuiltin，内置成功才 preventDefault；修饰键不拦；右键菜单三项", () => {
    const src = code("src/components/markdown-link.tsx");
    expect(src).toMatch(/openHttpInBuiltin\(href\) === "builtin"\) e\.preventDefault\(\)/);
    expect(src).toMatch(/e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/);
    expect(src).toContain("在内置浏览器打开");
    expect(src).toContain("在系统浏览器打开");
    expect(src).toContain("复制链接");
    // 非 http(s)（相对路径 / file:// 幻觉链接）仍是纯文本、不可点：判断在 CLICKABLE 之前，没有被改动
    expect(src).toContain("!CLICKABLE.test(href)");
  });

  it("LocalFileLink：HTML 左键走 openLocalHtmlInBuiltin（按设置），右键 = 内置（强制）+ 系统（原行为）；有行号仍进 IDE", () => {
    const src = code("src/components/ui/local-file-link.tsx");
    expect(src).toMatch(/openLocalHtmlInBuiltin\(target\.absolute\)\.catch\(reportOpenFailure\)/);
    expect(src).toMatch(/openLocalHtmlInBuiltin\(target\.absolute, \{ forceBuiltin: true \}\)/);
    expect(src).toMatch(/launchInSystem = \(\) => \{\s*void requestOpenLocalPath\(target\.absolute\)/);
    expect(src).toContain("onBrowserOpen: launchInSystem");
    // 左键只在 openTarget === "browser" 时进 launchInBrowser；有行号时 resolveLocalFileOpenTarget 给的是 ide（local-file-kind 有单测）
    expect(src).toMatch(/if \(openTarget === "browser"\) \{\s*launchInBrowser\(\);/);
  });

  it("LocalFileLink tooltip 首行（R7-09-4）：「链接默认打开方式」只在 BrowserOpenHint（tooltip 打开时才渲染）里读，不在 LocalFileLink 的渲染体里读", () => {
    const src = code("src/components/ui/local-file-link.tsx");
    const reads = [...src.matchAll(/readLinkOpenMode\(\)/g)];
    expect(reads).toHaveLength(1);
    const hint = /const BrowserOpenHint = [\s\S]*?\n\);/.exec(src);
    expect(hint).not.toBeNull();
    expect(hint![0]).toContain("readLinkOpenMode()");
    expect(src).toMatch(/<BrowserOpenHint builtinBridge=\{builtinBridge\} \/>/);
    // 浏览器类的 defaultActionLabel 是组件，不是在渲染里算好的字符串
    expect(src).not.toMatch(/readLinkOpenMode\(\) === "builtin" && builtinBridge\s*\?\s*"点击在内置浏览器打开"[\s\S]{0,40}"点击在系统浏览器打开"\s*:\s*openTarget/);
  });

  it("open-in-builtin：右键强制内置 = mode 强制 builtin + explicit（不被授权链接启发式悄悄回退）；左键两者都不强制", () => {
    const src = code("src/components/browser/open-in-builtin.ts");
    expect(src).toMatch(/mode: force \? "builtin" : readLinkOpenMode\(\)/);
    expect(src).toMatch(/explicit: force/);
    expect(src).toMatch(/openHttpLink\(url, realDeps\(opts\.forceBuiltin === true\)\)/);
    expect(src).toMatch(/openLocalHtml\(absPath, realDeps\(opts\.forceBuiltin === true\)\)/);
  });

  it("设置页：偏好卡里有「链接默认打开方式」，值经 saveFieldValue('linkOpenMode') 落盘", () => {
    expect(read("src/app/settings/page.tsx")).toContain('saveFieldValue("linkOpenMode", v)');
    const card = read("src/components/settings/preference-card.tsx");
    expect(card).toContain("链接默认打开方式");
    expect(card).toContain("LINK_OPEN_MODES.map");
    expect(read("src/lib/server/settings-fs.ts")).toContain('"linkOpenMode"');
    expect(read("src/hooks/use-settings.ts")).toMatch(/linkOpenMode: "stringEmpty"/);
    expect(read("src/hooks/use-settings.ts")).toMatch(/linkOpenMode: !isFieldEqual\("linkOpenMode"/);
  });

  it("MCP OAuth 仍然是自己的系统浏览器通道，没有被改成走内置浏览器", () => {
    const src = code("src/hooks/use-mcp-oauth.ts");
    expect(src).toContain('window.open(res.authorizationUrl, "_blank")');
    expect(src).not.toMatch(/open-in-builtin|openHttpInBuiltin|requestOpenInActiveBrowser/);
  });
});

describe("MarkdownLink SSR：改成可拦截点击后，没有 JS / 水合前的默认行为不变", () => {
  const render = (href: string | undefined, text = "链接") =>
    renderToStaticMarkup(createElement(ImagePreviewProvider, null, createElement(MarkdownLink, { href }, text)));

  it("http(s) 仍是 <a href target=_blank rel=noopener noreferrer>（点击被拦不住 / 回退时就走它 → 壳转系统浏览器）", () => {
    const html = render("https://example.com/docs?a=1");
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com\/docs\?a=1"/);
    expect(html).toMatch(/<a [^>]*target="_blank"/);
    expect(html).toMatch(/<a [^>]*rel="noopener noreferrer"/);
    expect(html).toContain("链接");
  });

  it("相对路径 / file:// / 无 href 仍是不可点的纯文本（没有 <a>）", () => {
    for (const href of ["./a.html", "docs/readme.md", "file:///tmp/a.html", undefined]) {
      const html = render(href);
      expect(html, String(href)).not.toContain("<a ");
    }
  });
});
