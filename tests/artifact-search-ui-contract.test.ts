/**
 * 产物栏 / 事件流「搜索此栏」UI 与快捷键接线契约
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSrc = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

const sidebar = readSrc("src/components/app-sidebar.tsx");
const shell = readSrc("src/components/app-shell.tsx");
const artifactPanel = readSrc("src/components/tasks/artifact-panel.tsx");
const eventStream = readSrc("src/components/tasks/event-stream.tsx");
const searchBar = readSrc("src/components/tasks/event-stream-search-bar.tsx");
const providers = readSrc("src/components/providers.tsx");
const shortcutsDialog = readSrc("src/components/keyboard-shortcuts-dialog.tsx");
const markdownText = readSrc("src/components/markdown-text.tsx");
const domTextSearch = readSrc("src/lib/dom-text-search.ts");
const workGroup = readSrc("src/components/tasks/event-stream/work-group.tsx");

describe("侧栏不再挂载列表搜索", () => {
  it("无侧栏搜索按钮 / 过滤 / data-pane-search", () => {
    expect(sidebar).not.toContain("SearchDialog");
    expect(sidebar).not.toContain("filterTasksForSidebarSearch");
    expect(sidebar).not.toContain("data-pane-search");
    expect(sidebar).not.toContain("getSearchThisPaneLabel");
  });
});

describe("产物栏内联搜索 UI", () => {
  it("工具区搜索入口 + 平台动态文案 + 作用域标记", () => {
    expect(artifactPanel).toContain("EventStreamSearchBar");
    expect(artifactPanel).toContain('data-pane-search="artifact"');
    expect(artifactPanel).toContain("ARTIFACT_SEARCH_FOCUS_EVENT");
    expect(artifactPanel).toContain("findRootDomSearchMatches");
    expect(artifactPanel).toContain("applyDomSearchHighlights");
    expect(artifactPanel).toContain("scrollDomSearchMatchIntoView");
    expect(artifactPanel).not.toContain("rehypeSearchHighlight");
    expect(artifactPanel).not.toContain("document\n        .querySelector");
  });

  it("搜索栏组件支持跨平台 aria / tooltip", () => {
    expect(searchBar).toContain("getSearchThisPaneLabel");
  });
});

describe("事件流内联搜索 UI", () => {
  it("按渲染 occurrence 搜索 + DOM 高亮 + 虚拟列表滚动", () => {
    expect(eventStream).toContain("searchEventStreamRenderOccurrences");
    expect(eventStream).toContain("PaneSearchHighlightProvider");
    expect(eventStream).toContain("findOwnerDomSearchMatches");
    expect(eventStream).toContain("applyDomSearchHighlights");
    expect(eventStream).toContain("scrollDomSearchMatchIntoView");
    expect(eventStream).toContain("index: idx");
    expect(eventStream).toContain("findRenderIndexForEventId");
    expect(eventStream).toContain("scrollToIndex");
    expect(eventStream).toContain('placeholder="搜索 AI 回复…"');
    expect(eventStream).toContain('data-pane-search="event-stream"');
    expect(eventStream).not.toContain("document\n        .querySelector");
  });

  it("不再仅用卡片边框高亮", () => {
    expect(eventStream).not.toContain("resolveSearchHighlightForItem");
    expect(eventStream).not.toContain("ring-brand/50 bg-brand/10");
  });

  it("Markdown 渲染接入栏内搜索高亮", () => {
    expect(markdownText).toContain('data-search-content="true"');
    expect(markdownText).toContain("searchOwnerId");
    expect(domTextSearch).toContain("CSS.highlights");
  });

  it("搜索命中可强制展开工作过程、等待虚拟行挂载后重试定位", () => {
    expect(workGroup).toContain("hasSearchHitInGroup ||");
    expect(workGroup).toContain("data-search-owner-id");
    expect(eventStream).toContain("attempts < 25");
  });

  it("已挂载命中只精确滚动一次，未挂载时才唤醒虚拟行", () => {
    const mountedCheck = eventStream.indexOf("if (revealMountedTarget()) return;");
    const virtualWake = eventStream.indexOf("scrollToSearchHit(currentSearchOwnerId)");
    expect(mountedCheck).toBeGreaterThan(-1);
    expect(virtualWake).toBeGreaterThan(mountedCheck);
  });

  it("Esc 一次关闭并清空", () => {
    expect(searchBar).toContain('e.key !== "Escape"');
    expect(searchBar).toContain("onClose()");
    expect(searchBar).not.toContain('onQueryChange("")');
    expect(searchBar).toContain('aria-label="关闭搜索"');
    expect(searchBar).toContain("autoFocus");
  });

  it("搜索栏显示计数与 prev/next", () => {
    expect(searchBar).toContain("hitIndex + 1");
    expect(searchBar).toContain("Shift+Enter");
  });

  it("搜索时暂停自动跟随", () => {
    expect(eventStream).toContain("follow.setFollowing(false)");
  });
});

describe("全局快捷键与命令面板", () => {
  it("AppShell 按作用域 dispatch 产物栏/事件流搜索", () => {
    expect(shell).toContain("resolvePaneSearchScope");
    expect(shell).toContain("dispatchArtifactSearchFocus");
    expect(shell).toContain("dispatchEventStreamSearchFocus");
    expect(shell).toContain('isModCombo(e, "f")');
  });

  it("SearchDialog 仍全局挂载、Cmd/Ctrl+K 保留", () => {
    expect(providers).toContain("<SearchDialog showTrigger={false} />");
    expect(readSrc("src/components/search-dialog.tsx")).toContain(
      'isModCombo(e, "k")',
    );
  });

  it("快捷键表可发现搜索此栏", () => {
    expect(shortcutsDialog).toContain("搜索此栏");
    expect(shortcutsDialog).toContain("getModFShortcutLabel(platform)");
  });
});
