/**
 * 改动面板工具条（ScopeToolbar）与整块面板（ChangesSheet）的 SSR 冒烟。
 *
 * 工具条：范围分段的选中态、手动基线选择器「只在整条分支 + 单仓」才出现、各开关的选中态与文案切换。
 * 整块面板：Sheet 的内容走 Portal、服务端渲染不出来——这里只守「open / closed 两种状态下渲染期不抛错」
 *（比如误在渲染期读了 window / localStorage，SSR 阶段就会炸）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChangesSheet } from "@/components/tasks/changes/changes-sheet";
import { ScopeToolbar, type ScopeToolbarProps } from "@/components/tasks/changes/scope-toolbar";
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from "@/lib/changes/prefs";
import type { ChangesQuery } from "@/lib/changes/scope";
import type { TaskChanges, TaskRepoChanges } from "@/lib/types";

import { makeFile, makeRepo } from "./helpers/changes-fixtures";

const BRANCH_QUERY: ChangesQuery = { scope: { kind: "branch" }, baseRef: null, ignoreWs: false };

const renderToolbar = (over: Partial<ScopeToolbarProps> = {}): string =>
  renderToStaticMarkup(
    createElement(ScopeToolbar, {
      taskId: "t_1",
      chat: false,
      repos: [makeRepo()],
      query: BRANCH_QUERY,
      onScopeChange: () => {},
      onBaseRefChange: () => {},
      prefs: DEFAULT_DIFF_PREFS,
      onPrefsChange: () => {},
      loading: false,
      onRefresh: () => {},
      helpOpen: false,
      onHelpOpenChange: () => {},
      ...over,
    }),
  );

const withPrefs = (patch: Partial<DiffPrefs>): DiffPrefs => ({ ...DEFAULT_DIFF_PREFS, ...patch });

/** 某个文字的按钮是否处于 aria-pressed="true" */
const pressed = (html: string, text: string): boolean =>
  new RegExp(`<button[^>]*aria-pressed="true"[^>]*>${text}</button>`).test(html);

describe("ScopeToolbar：范围分段", () => {
  it("默认整条分支被选中，其它两个不是", () => {
    const html = renderToolbar();
    expect(pressed(html, "整条分支")).toBe(true);
    expect(pressed(html, "仅未提交")).toBe(false);
    expect(html).toContain("单个提交");
  });

  it("选了「仅未提交」：选中态跟着走", () => {
    const html = renderToolbar({
      query: { ...BRANCH_QUERY, scope: { kind: "uncommitted" } },
    });
    expect(pressed(html, "仅未提交")).toBe(true);
    expect(pressed(html, "整条分支")).toBe(false);
  });
});

describe("ScopeToolbar：手动基线选择器", () => {
  it("整条分支 + 单仓：出现，默认显示自动探测到的线上分支名", () => {
    const html = renderToolbar();
    expect(html).toContain(">对比<");
    expect(html).toContain("origin/main");
  });

  it("手动选了基线：显示手动选的分支", () => {
    const html = renderToolbar({ query: { ...BRANCH_QUERY, baseRef: "release/1.0" } });
    expect(html).toContain("release/1.0");
  });

  it("没探测到线上分支（降级 HEAD）：显示「自动」", () => {
    const html = renderToolbar({
      repos: [makeRepo({ base: { kind: "head", label: "HEAD", shortSha: "abc1234" } })],
    });
    expect(html).toContain(">自动<");
  });

  it("手动基线没生效：触发按钮上带警示图标", () => {
    const html = renderToolbar({
      query: { ...BRANCH_QUERY, baseRef: "gone" },
      repos: [makeRepo({ baseOverride: { requested: "gone", applied: false } })],
    });
    expect(html).toContain("lucide-triangle-alert");
  });

  it("多仓：不出现（各仓线上分支名不一定相同，没法用一个基线名套所有仓）", () => {
    const html = renderToolbar({
      repos: [makeRepo({ repoPath: "/w/a" }), makeRepo({ repoPath: "/w/b" })],
    });
    expect(html).not.toContain(">对比<");
  });

  it("仅未提交 / 单个提交范围：不出现（那两个范围的基线是固定的）", () => {
    expect(renderToolbar({ query: { ...BRANCH_QUERY, scope: { kind: "uncommitted" } } })).not.toContain(">对比<");
    expect(
      renderToolbar({ query: { ...BRANCH_QUERY, scope: { kind: "commit", sha: "a".repeat(40) } } }),
    ).not.toContain(">对比<");
  });
});

describe("ScopeToolbar：开关的选中态与文案", () => {
  const ariaPressed = (html: string, label: string): string | null =>
    html.match(new RegExp(`aria-label="${label}"[^>]*aria-pressed="(true|false)"|aria-pressed="(true|false)"[^>]*aria-label="${label}"`))?.slice(1).find(Boolean) ??
    null;

  it("默认：统一视图 + 目录树选中、忽略空白关", () => {
    const html = renderToolbar();
    expect(ariaPressed(html, "统一视图")).toBe("true");
    expect(ariaPressed(html, "目录树")).toBe("true");
    expect(ariaPressed(html, "忽略空白差异")).toBe("false");
    expect(html).toContain('aria-label="平铺列表"');
  });

  it("偏好改了，选中态跟着变", () => {
    const html = renderToolbar({ prefs: withPrefs({ view: "split", treeMode: "flat", ignoreWs: true }) });
    expect(ariaPressed(html, "统一视图")).toBe("false");
    expect(ariaPressed(html, "分栏视图（窗口太窄会自动用统一视图）")).toBe("true");
    expect(ariaPressed(html, "目录树")).toBe("false");
    expect(ariaPressed(html, "平铺列表")).toBe("true");
    expect(ariaPressed(html, "忽略空白差异")).toBe("true");
  });

  it("隐藏 / 显示文件栏、加宽 / 还原面板：文案随状态切换", () => {
    expect(renderToolbar()).toContain('aria-label="隐藏文件栏"');
    expect(renderToolbar()).toContain('aria-label="加宽面板"');
    const toggled = renderToolbar({ prefs: withPrefs({ treeHidden: true, wide: true }) });
    expect(toggled).toContain('aria-label="显示文件栏"');
    expect(toggled).toContain('aria-label="还原面板宽度"');
    expect(toggled).not.toContain('aria-label="隐藏文件栏"');
    expect(toggled).not.toContain('aria-label="加宽面板"');
  });

  it("刷新中：按钮禁用并转圈；转圈尊重「减少动态效果」", () => {
    const busy = renderToolbar({ loading: true });
    expect(busy).toContain("animate-spin motion-reduce:animate-none");
    expect(busy).toMatch(/aria-label="刷新"[^>]*disabled=""|disabled=""[^>]*aria-label="刷新"/);
    expect(renderToolbar()).not.toContain("animate-spin");
  });

  it("有快捷键帮助入口", () => {
    expect(renderToolbar()).toContain('aria-label="快捷键"');
  });
});

describe("ChangesSheet：渲染期不抛错（Sheet 内容走 Portal，服务端渲染不出来）", () => {
  const repo: TaskRepoChanges = makeRepo({ files: [makeFile({ path: "src/a.ts" })] });
  const data: TaskChanges = { repos: [repo], totals: { files: 1, added: 3, removed: 1 } };

  const renderSheet = (open: boolean, chat = false): string =>
    renderToStaticMarkup(
      createElement(ChangesSheet, {
        taskId: "t_1",
        chat,
        open,
        onOpenChange: () => {},
        data,
        stale: false,
        error: null,
        loading: false,
        updatedAt: 0,
        running: false,
        query: BRANCH_QUERY,
        onScopeChange: () => {},
        onBaseRefChange: () => {},
        prefs: DEFAULT_DIFF_PREFS,
        onPrefsChange: () => {},
        onRefresh: () => {},
        refreshKey: 0,
      }),
    );

  it("task / chat、打开 / 关闭，四种组合都能渲染", () => {
    for (const open of [false, true]) {
      for (const chat of [false, true]) {
        expect(() => renderSheet(open, chat), `open=${open} chat=${chat}`).not.toThrow();
      }
    }
  });
});
