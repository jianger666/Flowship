/**
 * `@` 菜单对「索引被截断」的提示（R14 B6-5 / Q21-01）
 *
 * 服务端建索引有 2 万条的上限；超限时它丢最深的、带 `truncated`。这个标记要一路透传到用户眼前：
 *   路由响应 → fetchAtFiles → atResultsFromOutcome → atMenuView → useAtMention（真 hook）→ 菜单的空态 / footer。
 * 这份测试守这条链上的每一环，以及两条语义：
 *  - **只在结果新鲜时才说「不全」**：用户继续打字、新结果还在路上时，上一轮结果带的「不全」不能贴到新 query 上；
 *  - **没截断时形状与改前逐字相同**（不带 truncated 键），既有 `toEqual` 断言、旧响应格式都不受影响。
 * 为什么要提示：截断后「无匹配」不等于「仓里没有」，用户得知道这一点，否则会以为文件不存在。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AtMentionMenu, useAtMention, type AtMentionApi } from "@/components/at-mention";
import { fetchAtFiles } from "@/lib/at-mention-fetch";
import {
  AT_EMPTY_HINT,
  AT_EMPTY_TRUNCATED_HINT,
  AT_FAILED_HINT,
  AT_FOOTER_HINT,
  AT_TRUNCATED_NOTE,
  atEmptyHint,
  atFooterHint,
  atMenuView,
  atResultsFromOutcome,
} from "@/lib/at-mention-pick";
import { REPO_FILES_MAX_ENTRIES } from "@/lib/repo-files-shared";

import { createHookHarness } from "./helpers/react-hook-stub";

const { getTaskMeta, searchTaskRepoFiles } = vi.hoisted(() => ({
  getTaskMeta: vi.fn(),
  searchTaskRepoFiles: vi.fn(),
}));
vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta }));
vi.mock("@/lib/server/repo-files", () => ({
  normalizeRepoRoot: (p: string) => p,
  REPO_FILES_Q_MAX_LEN: 200,
  searchTaskRepoFiles,
}));
const repoFilesRoute = await import("@/app/api/repo-files/route");

const HIT = { path: "src/App.tsx", isDir: false };

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as unknown as Response;

// ---------------------------------------------------------------------- 路由

describe("路由 GET /api/repo-files：把 truncated 透传给前端", () => {
  const meta = (repoPaths: string[]) => ({
    id: "t1",
    title: "t",
    mode: "task",
    repoPaths,
    readonlyRepoPaths: [],
    events: [],
  });
  const get = () => repoFilesRoute.GET(new Request("http://localhost/api/repo-files?taskId=t1&q=App"));

  beforeEach(() => {
    vi.clearAllMocks();
    getTaskMeta.mockResolvedValue(meta(["/tmp/repo-a"]));
  });

  it("索引被截断：响应带 truncated: true", async () => {
    searchTaskRepoFiles.mockResolvedValue({ files: [HIT], truncated: true });

    const resp = await get();

    expect(resp.status).toBe(200);
    expect(await resp.json()).toStrictEqual({ files: [HIT], truncated: true });
  });

  it("没被截断：响应就是 { files }，不带 truncated 键（与改前逐字相同）", async () => {
    searchTaskRepoFiles.mockResolvedValue({ files: [HIT], truncated: false });

    expect(await (await get()).json()).toStrictEqual({ files: [HIT] });
  });

  it("任务没绑仓：{ files: [] }，不去搜", async () => {
    getTaskMeta.mockResolvedValue(meta([]));

    expect(await (await get()).json()).toStrictEqual({ files: [] });
    expect(searchTaskRepoFiles).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- fetchAtFiles

describe("fetchAtFiles：只认字面量 true", () => {
  const call = (body: unknown) =>
    fetchAtFiles({
      taskId: "t",
      q: "a",
      signal: new AbortController().signal,
      fetchImpl: (async () => jsonResponse(body)) as unknown as typeof fetch,
    });

  it("truncated: true → 结果带 truncated: true", async () => {
    expect(await call({ files: [HIT], truncated: true })).toStrictEqual({
      kind: "ok",
      files: [HIT],
      truncated: true,
    });
  });

  it("files 缺失但 truncated: true：候选是空的、仍带截断标记", async () => {
    expect(await call({ truncated: true })).toStrictEqual({ kind: "ok", files: [], truncated: true });
  });

  it.each([
    ["缺省", { files: [HIT] }],
    ["false", { files: [HIT], truncated: false }],
    ["字符串 'true'", { files: [HIT], truncated: "true" }],
    ["数字 1", { files: [HIT], truncated: 1 }],
    ["null", { files: [HIT], truncated: null }],
  ])("truncated %s → 结果不带 truncated 键（旧形状原样）", async (_name, body) => {
    expect(await call(body)).toStrictEqual({ kind: "ok", files: [HIT] });
  });

  it("失败仍是 { kind: 'failed' }：失败结果不带截断标记", async () => {
    const out = await fetchAtFiles({
      taskId: "t",
      q: "a",
      signal: new AbortController().signal,
      fetchImpl: (async () => jsonResponse({ truncated: true }, false)) as unknown as typeof fetch,
    });

    expect(out).toStrictEqual({ kind: "failed" });
  });
});

// ---------------------------------------------------------------------- 纯函数：结果 / 状态机 / 文案

describe("atResultsFromOutcome / atMenuView：截断标记的归属", () => {
  it("ok + truncated → 结果带 truncated；缺省 → 不带键（严格相等，连 undefined 键都不留）", () => {
    expect(atResultsFromOutcome("q", { kind: "ok", files: [HIT], truncated: true })).toStrictEqual({
      query: "q",
      files: [HIT],
      failed: false,
      truncated: true,
    });
    expect(atResultsFromOutcome("q", { kind: "ok", files: [HIT] })).toStrictEqual({
      query: "q",
      files: [HIT],
      failed: false,
    });
  });

  it("failed → 空结果 + failed 标记；aborted → null", () => {
    expect(atResultsFromOutcome("q", { kind: "failed" })).toStrictEqual({ query: "q", files: [], failed: true });
    expect(atResultsFromOutcome("q", { kind: "aborted" })).toBeNull();
  });

  it("结果新鲜 + 截断：视图带 truncated（有候选是 list、没候选是 empty，都带）", () => {
    expect(atMenuView("App", { query: "App", files: [HIT], truncated: true })).toStrictEqual({
      mode: "list",
      stale: false,
      canPick: true,
      items: [HIT],
      truncated: true,
    });
    expect(atMenuView("zzz", { query: "zzz", files: [], truncated: true })).toStrictEqual({
      mode: "empty",
      stale: false,
      canPick: false,
      items: [],
      truncated: true,
    });
  });

  it("结果不是当前 query 的（还在路上）：旧结果的「不全」不能贴到新 query 上，视图不带 truncated", () => {
    const view = atMenuView("Appx", { query: "App", files: [HIT], truncated: true });

    expect(view).toStrictEqual({ mode: "list", stale: true, canPick: false, items: [HIT] });
    expect("truncated" in view).toBe(false);
  });

  it("没截断的视图形状与改前逐字相同；closed / loading 分支也不带", () => {
    expect(atMenuView("App", { query: "App", files: [HIT] })).toStrictEqual({
      mode: "list",
      stale: false,
      canPick: true,
      items: [HIT],
    });
    expect(atMenuView(null, null)).toStrictEqual({ mode: "closed", stale: false, canPick: false, items: [] });
    expect(atMenuView("a", null)).toStrictEqual({ mode: "loading", stale: true, canPick: false, items: [] });
  });
});

describe("文案", () => {
  it("上限 2 万时的提示（字面量，不镜像实现）", () => {
    expect(REPO_FILES_MAX_ENTRIES).toBe(20_000);
    expect(AT_TRUNCATED_NOTE).toBe("仅索引前 2 万项");
    expect(AT_EMPTY_TRUNCATED_HINT).toBe("无匹配文件（仓库较大，仅索引前 2 万项）");
    expect(atFooterHint(true)).toBe("↑↓ 选择 · Enter 确认 · Esc 关闭 · 仅索引前 2 万项");
  });

  it("空态文案：没截断 / 截断 / 失败；失败优先于截断；旧的单参数调用不变", () => {
    expect(atEmptyHint(false)).toBe(AT_EMPTY_HINT);
    expect(atEmptyHint(false, false)).toBe(AT_EMPTY_HINT);
    expect(atEmptyHint(false, true)).toBe(AT_EMPTY_TRUNCATED_HINT);
    expect(atEmptyHint(true)).toBe(AT_FAILED_HINT);
    expect(atEmptyHint(true, true)).toBe(AT_FAILED_HINT);
  });

  it("footer：没截断时就是原来的操作提示；截断时在它后面追加一句", () => {
    expect(atFooterHint()).toBe(AT_FOOTER_HINT);
    expect(atFooterHint(false)).toBe(AT_FOOTER_HINT);
    expect(AT_FOOTER_HINT).toBe("↑↓ 选择 · Enter 确认 · Esc 关闭");
    expect(atFooterHint(true)).toBe(`${AT_FOOTER_HINT} · ${AT_TRUNCATED_NOTE}`);
  });

  describe("提示里的数字取自前后端共用的 REPO_FILES_MAX_ENTRIES（改了常量，菜单跟着变）", () => {
    afterEach(() => {
      vi.doUnmock("@/lib/repo-files-shared");
      vi.resetModules();
    });

    it.each([
      [20_000, "仅索引前 2 万项"],
      [30_000, "仅索引前 3 万项"],
      [12_345, "仅索引前 12,345 项"],
      [15_000, "仅索引前 15,000 项"], // 整五千但不是整万：不能写成「1.5 万项」
      [500, "仅索引前 500 项"],
    ])("上限 %i → %s", async (n, expected) => {
      vi.resetModules();
      vi.doMock("@/lib/repo-files-shared", () => ({ REPO_FILES_MAX_ENTRIES: n, REPO_FILES_Q_MAX_LEN: 200 }));

      const pick = await import("@/lib/at-mention-pick");

      expect(pick.AT_TRUNCATED_NOTE).toBe(expected);
      expect(pick.atFooterHint(true)).toBe(`↑↓ 选择 · Enter 确认 · Esc 关闭 · ${expected}`);
    });
  });
});

// ---------------------------------------------------------------------- 菜单组件（SSR）

const makeApi = (over: Partial<AtMentionApi> = {}): AtMentionApi => ({
  menuOpen: true,
  filtered: [],
  activeIndex: 0,
  loading: false,
  stale: false,
  failed: false,
  truncated: false,
  listId: "at-list",
  onDraftChange: () => {},
  onKeyDown: () => false,
  pickAt: () => false,
  registerPickHandler: () => () => {},
  reset: () => {},
  ...over,
});
const renderMenu = (over: Partial<AtMentionApi> = {}): string =>
  renderToStaticMarkup(createElement(AtMentionMenu, { at: makeApi(over) }));

describe("AtMentionMenu：用户眼前的提示", () => {
  it("没有匹配 + 索引被截断：空态写「仓库较大，仅索引前 2 万项」，footer 也带这句", () => {
    const html = renderMenu({ truncated: true });

    expect(html).toContain("无匹配文件（仓库较大，仅索引前 2 万项）");
    expect(html).toContain("↑↓ 选择 · Enter 确认 · Esc 关闭 · 仅索引前 2 万项");
  });

  it("没有匹配 + 没截断：只写「无匹配文件」，哪里都没有「仅索引」", () => {
    const html = renderMenu();

    expect(html).toContain("无匹配文件");
    expect(html).not.toContain("仓库较大");
    expect(html).not.toContain("仅索引前");
    expect(html).toContain("↑↓ 选择 · Enter 确认 · Esc 关闭");
  });

  it("有候选 + 索引被截断：列表照常画，footer 提醒候选可能不全，没有空态文案", () => {
    const html = renderMenu({ filtered: [HIT], truncated: true });

    expect(html).toContain("src/App.tsx");
    expect(html).toContain("↑↓ 选择 · Enter 确认 · Esc 关闭 · 仅索引前 2 万项");
    expect(html).not.toContain("无匹配文件");
  });

  it("有候选 + 没截断：footer 就是原来的操作提示", () => {
    const html = renderMenu({ filtered: [HIT] });

    expect(html).toContain("src/App.tsx");
    expect(html).not.toContain("仅索引前");
  });

  it("请求失败：写失败文案，不写「仓库较大」", () => {
    const html = renderMenu({ failed: true });

    expect(html).toContain(AT_FAILED_HINT);
    expect(html).not.toContain("仓库较大");
  });

  it("加载中（还没有任何结果）：不写任何空态文案，也不说「仅索引」", () => {
    const html = renderMenu({ loading: true, stale: true });

    expect(html).not.toContain("无匹配文件");
    expect(html).not.toContain("仅索引前");
  });

  it("菜单没开：什么都不画", () => {
    expect(renderMenu({ menuOpen: false, truncated: true })).toBe("");
  });
});

// ---------------------------------------------------------------------- 真 hook

describe("useAtMention（真 hook）：truncated 只在结果新鲜时才算数", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 按调用顺序依次返回这些响应体（Error = 网络失败） */
  const stubFetch = (...responses: Array<unknown>) => {
    const queue = [...responses];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return jsonResponse(next);
      }),
    );
    return { urls };
  };

  const mountHook = () => {
    const h = createHookHarness();
    const useIt = (): AtMentionApi =>
      useAtMention({ taskId: "t1", repoPaths: ["/tmp/repo"], applyDraft: () => {} });
    let api = h.render(useIt);
    h.flushEffects();
    const refresh = (): AtMentionApi => (api = h.render(useIt));
    return {
      get api(): AtMentionApi {
        return api;
      },
      /** 用户在输入框里敲成了 draft（光标在末尾） */
      type(draft: string): void {
        api.onDraftChange(draft, draft.length);
        refresh();
        h.flushEffects();
        refresh();
      },
      /** 走完 debounce + 请求 + 读 body，再取最新快照 */
      async settle(): Promise<void> {
        await vi.advanceTimersByTimeAsync(200);
        await vi.advanceTimersByTimeAsync(0);
        refresh();
      },
      unmount: () => h.unmount(),
    };
  };

  it("服务端说被截断：hook 输出 truncated=true，候选照常；刚敲出来、结果还没到时是 false", async () => {
    const { urls } = stubFetch({ files: [HIT], truncated: true });
    const m = mountHook();

    m.type("@App");
    expect(m.api.menuOpen).toBe(true);
    expect(m.api.loading).toBe(true);
    expect(m.api.truncated).toBe(false);

    await m.settle();
    expect(urls).toEqual(["/api/repo-files?taskId=t1&q=App"]);
    expect(m.api.filtered).toEqual([HIT]);
    expect(m.api.stale).toBe(false);
    expect(m.api.truncated).toBe(true);
    m.unmount();
  });

  it("继续打字、新结果还在路上：旧结果还画着（stale），但「不全」不贴到新 query 上；新结果到了再按它自己的说", async () => {
    stubFetch({ files: [HIT], truncated: true }, { files: [] }, { files: [], truncated: true });
    const m = mountHook();

    m.type("@App");
    await m.settle();
    expect(m.api.truncated).toBe(true);

    m.type("@Appx");
    expect(m.api.stale).toBe(true);
    expect(m.api.filtered).toEqual([HIT]);
    expect(m.api.truncated).toBe(false);

    await m.settle();
    expect(m.api.stale).toBe(false);
    expect(m.api.filtered).toEqual([]);
    expect(m.api.failed).toBe(false);
    expect(m.api.truncated).toBe(false);

    m.type("@Appxy");
    await m.settle();
    expect(m.api.filtered).toEqual([]);
    expect(m.api.truncated).toBe(true);
    m.unmount();
  });

  it("没有匹配 + 索引被截断：hook 的输出直接喂给菜单，空态写出「仓库较大，仅索引前 2 万项」", async () => {
    stubFetch({ files: [], truncated: true });
    const m = mountHook();

    m.type("@zzz");
    await m.settle();

    expect(m.api.failed).toBe(false);
    expect(m.api.truncated).toBe(true);
    expect(renderToStaticMarkup(createElement(AtMentionMenu, { at: m.api }))).toContain(
      "无匹配文件（仓库较大，仅索引前 2 万项）",
    );
    m.unmount();
  });

  it("请求失败：落失败文案，不带截断标记", async () => {
    stubFetch(new Error("boom"));
    const m = mountHook();

    m.type("@App");
    await m.settle();

    expect(m.api.failed).toBe(true);
    expect(m.api.truncated).toBe(false);
    const html = renderToStaticMarkup(createElement(AtMentionMenu, { at: m.api }));
    expect(html).toContain(AT_FAILED_HINT);
    expect(html).not.toContain("仓库较大");
    m.unmount();
  });
});
