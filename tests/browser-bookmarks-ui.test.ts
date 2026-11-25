/**
 * 收藏夹 UI：
 * - SSR 渲染（星标、收藏列表、对话框正文各状态、空白页快捷列表）——对话框本体在 Portal 里服务端是空的，所以正文拆成了纯展示组件；
 * - 源码契约：星标画在地址栏 <form> 里并在窄面板让位、菜单入口、对话框 / 空白页接线；
 *   收藏刻意**不是 AI 工具**（AI 侧 / 主进程侧 / prompts / skills 里不出现收藏）；UI 模块只会请求收藏接口、不碰桥、不渲染 HTML。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BOOKMARK_QUICK_LIMIT } from "@/components/browser/bookmark-flow";
import { BookmarkStar } from "@/components/browser/bookmark-star";
import {
  BookmarkList,
  BookmarkQuickList,
  BookmarkQuickListView,
  BookmarksBody,
  BookmarksDialog,
} from "@/components/browser/bookmarks-dialog";
import { displayBookmarkUrl, type Bookmark } from "@/lib/browser-bookmarks";

import { bm } from "./helpers/bookmarks-fake-fetch";

const noop = () => {};

describe("BookmarkStar", () => {
  const render = (props: Partial<Parameters<typeof BookmarkStar>[0]> = {}) =>
    renderToStaticMarkup(createElement(BookmarkStar, { starred: false, onToggle: noop, ...props }));

  it("没收藏：「收藏此页」、aria-pressed=false、不填色", () => {
    const html = render();
    expect(html).toContain('aria-label="收藏此页"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("fill-warning");
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("已收藏：「取消收藏」、aria-pressed=true、星形填色", () => {
    const html = render({ starred: true });
    expect(html).toContain('aria-label="取消收藏"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("fill-warning");
  });

  it("切换进行中（busy）置灰，防连点", () => {
    expect(render({ busy: true })).toMatch(/\sdisabled(=|\s|>)/);
  });

  it("必须是 type=button（它在地址栏的 <form> 里，不能触发提交导航）；绝对定位在输入框右端；className 可由调用方追加", () => {
    const html = render({ className: "@max-[360px]:hidden" });
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain("absolute");
    expect(html).toContain("right-1");
    expect(html).toContain("@max-[360px]:hidden");
  });
});

describe("BookmarkList / BookmarkRow", () => {
  const render = (bookmarks: Bookmark[]) => renderToStaticMarkup(createElement(BookmarkList, { bookmarks, onOpen: noop, onRemove: noop }));

  it("每行：标题、去协议的地址；右侧「新标签页打开 / 删除」带引用标题的 aria-label", () => {
    const html = render([bm(1, { title: "示例站点", url: "https://example.com/docs/" })]);
    expect(html).toContain('aria-label="收藏列表"');
    expect(html).toContain("示例站点");
    expect(html).toContain(">example.com/docs<"); // displayBookmarkUrl：去协议、去末尾斜杠
    expect(displayBookmarkUrl("https://example.com/docs/")).toBe("example.com/docs");
    expect(html).toContain('aria-label="在新标签页打开「示例站点」"');
    expect(html).toContain('aria-label="删除收藏「示例站点」"');
  });

  it("标题是页面可控的文字：按纯文本转义渲染，绝不出现可执行的标签 / 属性", () => {
    const evil = `<img src=x onerror=alert(1)>"><script>alert(2)</script>`;
    const html = render([bm(1, { title: evil })]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // aria-label 里引用标题同样被转义
    expect(html).toMatch(/aria-label="在新标签页打开「&lt;img/);
  });

  it("aria-label 里引用的标题被截断（完整标题在行内）", () => {
    const html = render([bm(1, { title: "长".repeat(100) })]);
    const m = html.match(/aria-label="删除收藏「([^」]*)」"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(`${"长".repeat(40)}…`);
  });

  it("悬停 / 键盘聚焦才露出右侧按钮（隐藏只是视觉上的，按钮始终在 Tab 序里）", () => {
    const html = render([bm(1)]);
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover/row:opacity-100");
    expect(html).toContain("group-focus-within/row:opacity-100");
    expect(html).not.toContain("hidden"); // 不能用 display:none / hidden 把按钮摘出 Tab 序
  });

  it("按给定顺序渲染（排序由 store 负责，视图不重排）", () => {
    const html = render([bm(3), bm(1), bm(2)]);
    const at = (t: string) => html.indexOf(t);
    expect(at("title 3")).toBeLessThan(at("title 1"));
    expect(at("title 1")).toBeLessThan(at("title 2"));
  });
});

describe("BookmarksBody：对话框正文的各状态", () => {
  const render = (over: Partial<Parameters<typeof BookmarksBody>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(BookmarksBody, {
        total: 0,
        visible: [],
        query: "",
        status: "ready",
        error: null,
        onReload: noop,
        onOpen: noop,
        onRemove: noop,
        ...over,
      }),
    );

  it("首次加载失败（还没有任何数据）：alert + 原因 + 重试按钮", () => {
    const html = render({ status: "error", error: "读取收藏夹失败：磁盘不可读" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("读取收藏夹失败：磁盘不可读");
    expect(html).toContain("重试");
    expect(html).not.toContain('aria-label="收藏列表"');
  });

  it("首次加载失败但没有原因文字 → 兜底「读取收藏夹失败」", () => {
    expect(render({ status: "error", error: null })).toContain("读取收藏夹失败");
  });

  it("已经有数据时（后台刷新出过错也一样）不显示错误态：照常显示列表", () => {
    const list = [bm(1), bm(2)];
    const html = render({ status: "error", error: "boom", total: 2, visible: list });
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('aria-label="收藏列表"');
  });

  it.each(["idle", "loading"] as const)("首次加载中（%s、还没有数据）：role=status +「加载中…」，不闪「还没有收藏」", (status) => {
    const html = render({ status });
    expect(html).toContain('role="status"');
    expect(html).toContain("加载中…");
    expect(html).not.toContain("还没有收藏");
  });

  it("加载成功且确实没有收藏：给出怎么收藏的提示", () => {
    const html = render();
    expect(html).toContain("还没有收藏");
    expect(html).toContain("星标");
    expect(html).not.toContain("加载中");
    expect(html).not.toContain('role="alert"');
  });

  it("过滤后没有匹配：提示里带过滤词（过长的词被截断）", () => {
    const html = render({ total: 3, visible: [], query: "不存在的词" });
    expect(html).toContain("没有匹配「不存在的词」的收藏");
    const long = render({ total: 3, visible: [], query: "词".repeat(80) });
    expect(long).toContain(`没有匹配「${"词".repeat(30)}…」的收藏`);
  });

  it("过滤词按纯文本转义", () => {
    const html = render({ total: 3, visible: [], query: "<b>x</b>" });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("有数据（哪怕刷新中）：列表", () => {
    const html = render({ status: "loading", total: 2, visible: [bm(1), bm(2)] });
    expect(html).toContain('aria-label="收藏列表"');
    expect(html).toContain("title 1");
    expect(html).not.toContain("加载中");
  });
});

describe("BookmarkQuickListView：空白页（没有会话）上的快捷列表", () => {
  const render = (bookmarks: Bookmark[]) =>
    renderToStaticMarkup(createElement(BookmarkQuickListView, { bookmarks, onOpen: noop, onManage: noop }));

  it("没有收藏：整块不渲染", () => {
    expect(render([])).toBe("");
  });

  it("不超过快捷上限：全部列出，按钮叫「管理」", () => {
    const html = render([bm(3), bm(2), bm(1)]);
    expect(html).toContain('aria-label="收藏"');
    for (const t of ["title 3", "title 2", "title 1"]) expect(html).toContain(t);
    expect(html).toContain("管理");
    expect(html).not.toContain("全部");
    expect(html).toContain("example.com/p3"); // 地址去协议
  });

  it("超过快捷上限：只露最近的几条，按钮叫「全部 N 个」", () => {
    const total = BOOKMARK_QUICK_LIMIT + 3;
    const list = Array.from({ length: total }, (_, i) => bm(total - i)); // 最新的在前
    const html = render(list);
    expect(html).toContain(`全部 ${total} 个`);
    for (let i = 0; i < BOOKMARK_QUICK_LIMIT; i++) expect(html, `第 ${i + 1} 条应显示`).toContain(`>${list[i]!.title}<`);
    for (let i = BOOKMARK_QUICK_LIMIT; i < total; i++) expect(html, `第 ${i + 1} 条不应显示`).not.toContain(`>${list[i]!.title}<`);
  });

  it("整行是一个 type=button 的按钮；标题按纯文本转义", () => {
    const html = render([bm(1, { title: "<script>alert(1)</script>" })]);
    expect(html).toContain('type="button"');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("BookmarkQuickList（取 store 数据的那层）与 BookmarksDialog 在服务端渲染都是空的：数据只在水合后才有，不造成水合不一致", () => {
    expect(renderToStaticMarkup(createElement(BookmarkQuickList, { onOpen: noop, onManage: noop }))).toBe("");
    expect(renderToStaticMarkup(createElement(BookmarksDialog, { open: true, onOpenChange: noop, onOpen: noop }))).toBe("");
  });
});

// ───────────── 源码契约 ─────────────
describe("接线（源码契约）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  // 剥注释（块注释 + 行注释，保留 URL 里的 ://）；.tsx 里的 JSX 文本含 // 的极少，本文件只断言代码结构
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const panel = () => strip(read("src/components/browser/browser-panel.tsx"));

  const addressForm = () => {
    const src = panel();
    const start = src.indexOf("<form onSubmit={onSubmitAddress}");
    expect(start, "地址栏 <form onSubmit={onSubmitAddress}> 应存在").toBeGreaterThan(0);
    const end = src.indexOf("</form>", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it("星标只有一个，画在地址栏 <form> 里面（不往工具栏里再加按钮），只在能收藏的页面上画，窄于 360px 让位", () => {
    const src = panel();
    expect(src.match(/<BookmarkStar\b/g)).toHaveLength(1);
    const form = addressForm();
    expect(form).toContain("<BookmarkStar");
    expect(form).toMatch(/\{bookmarkTarget && \(\s*<BookmarkStar/);
    expect(form).toMatch(/starred=\{starred\}/);
    expect(form).toMatch(/busy=\{bookmarkApi\.busy\}/);
    expect(form).toMatch(/onToggle=\{toggleBookmark\}/);
    expect(form).toMatch(/className="@max-\[360px\]:hidden"/);
  });

  it("地址栏 <form> 是星标的定位参照（relative）：星标是绝对定位，缺了它会飘到面板别的角落", () => {
    const opening = addressForm().match(/^<form\b[^>]*>/)?.[0] ?? "";
    expect(opening).toMatch(/className="[^"]*\brelative\b/);
  });

  it("地址输入框给星标留右内边距，星标让位时一并收回（窄面板的工具栏宽度不变）", () => {
    const form = addressForm();
    expect(form).toMatch(/bookmarkTarget && "pr-8 @max-\[360px\]:pr-2\.5"/);
  });

  it("能不能收藏只看活动标签：没有会话 → 没有目标", () => {
    expect(panel()).toMatch(/const bookmarkTarget = exists \? bookmarkTargetOf\(activeTab\) : null;/);
  });

  it("「更多」菜单里有同样的入口：收藏此页 / 取消收藏（没有目标或切换进行中置灰）+ 收藏夹…（带数量）", () => {
    const src = panel();
    expect(src).toMatch(/<DropdownMenuItem onClick=\{toggleBookmark\} disabled=\{!bookmarkTarget \|\| bookmarkApi\.busy\}>/);
    expect(src).toContain("bookmarkToggleLabel(starred)");
    expect(src).toMatch(/<DropdownMenuItem onClick=\{\(\) => setBookmarksOpen\(true\)\}>[\s\S]*?收藏夹…/);
    expect(src).toContain("bookmarkApi.bookmarks.length");
  });

  it("收藏夹对话框挂在面板上；空白页（没有会话）的快捷列表接同一套打开方式", () => {
    const src = panel();
    expect(src).toMatch(/<BookmarksDialog open=\{bookmarksOpen\} onOpenChange=\{setBookmarksOpen\} onOpen=\{openBookmark\} \/>/);
    expect(src).toMatch(/<EmptyState onOpenBookmark=\{openBookmark\} onManageBookmarks=\{\(\) => setBookmarksOpen\(true\)\} \/>/);
    expect(src).toMatch(/<BookmarkQuickList onOpen=\{onOpenBookmark\} onManage=\{onManageBookmarks\} \/>/);
  });

  it("打开方式：「新标签页打开」只在会话已存在时走 openInNewTab，否则 navigate（navigate 会启动会话）", () => {
    const src = panel();
    expect(src).toMatch(
      /resolveBookmarkOpen\(\{ newTab, sessionExists: stateRef\.current\?\.exists === true \}\) === "new-tab"\) void openInNewTab\(url\);\s*else navigate\(url\);/,
    );
  });

  it("收藏的 UI 模块只请求收藏接口：不碰 window.__browser 桥、不开窗口、不渲染 HTML", () => {
    const files = [
      "bookmark-flow.ts",
      "bookmark-star.tsx",
      "bookmarks-dialog.tsx",
      "bookmarks-store.ts",
      "use-bookmark-actions.ts",
      "use-bookmarks.ts",
    ].map((f) => [f, strip(read(`src/components/browser/${f}`))] as const);
    for (const [name, src] of files) {
      expect(src, `${name} 不应碰桥`).not.toMatch(/window\.__browser|__browser/);
      expect(src, `${name} 不应开窗口`).not.toMatch(/window\.open\b/);
      expect(src, `${name} 不应渲染 HTML`).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
      expect(src, `${name} 不应直接发起导航`).not.toMatch(/location\.(href|assign|replace)\s*=|\bwindow\.location\b/);
    }
    const store = files.find(([n]) => n === "bookmarks-store.ts")![1];
    expect(store.match(/doFetch\(/g)?.length, "store 里每个请求都应带着 BOOKMARKS_API").toBeGreaterThan(0);
    for (const m of store.matchAll(/doFetch\(([^,)]*)/g)) expect(m[1], m[0]).toMatch(/BOOKMARKS_API/);
  });

  it("flow 模块不依赖 React / window / sonner（纯逻辑，可在 node 里测）", () => {
    const flow = strip(read("src/components/browser/bookmark-flow.ts"));
    expect(flow).not.toMatch(/from "react"|from "sonner"|\bwindow\b|document\./);
  });

  it("收藏刻意不是 AI 工具：AI 侧 / 主进程 / prompts / skills 里不出现收藏（服务端只有它自己的存储模块与接口）", () => {
    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
      });
    const offenders: string[] = [];
    for (const dir of ["electron-app", "prompts", "skills", "src/lib/server/browser"]) {
      for (const rel of walk(dir)) {
        if (!/\.(mjs|cjs|js|ts|tsx|md)$/.test(rel)) continue;
        if (/bookmark|收藏/i.test(readFileSync(path.join(root, rel), "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
    // 服务端其余代码：只有存储模块自己
    const serverHits = walk("src/lib/server")
      .filter((rel) => /\.(ts|tsx)$/.test(rel))
      .filter((rel) => /bookmark|收藏/i.test(readFileSync(path.join(root, rel), "utf8")));
    expect(serverHits).toEqual(["src/lib/server/browser-bookmarks.ts"]);
  });
});
