/**
 * 会话管理页：搜索覆盖所有仓、批量选中只作用于可见行、分批渲染接线（S13-13 + 选中范围）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHAT_STALE_MS,
  matchesSessionQuery,
  pickArchivedSessions,
  pickFinishedSessions,
  pickStaleChatSessions,
  prunePicked,
  SESSIONS_PAGE_SIZE,
} from "@/lib/sessions-filter";

const row = (over: Partial<Parameters<typeof pickFinishedSessions>[0][number]>) => ({
  id: "t",
  title: "标题",
  updatedAt: 0,
  ...over,
});

describe("matchesSessionQuery", () => {
  it("空关键词命中全部", () => {
    expect(matchesSessionQuery({ title: "a", repoPaths: [] }, "  ")).toBe(true);
  });

  it("多仓任务能搜到第二个仓（原来只看 repoPaths[0]）", () => {
    const t = {
      title: "多仓任务",
      repoPaths: ["/work/repo-a", "/work/repo-b"],
    };
    expect(matchesSessionQuery(t, "repo-b")).toBe(true);
    expect(matchesSessionQuery(t, "REPO-A")).toBe(true);
    expect(matchesSessionQuery(t, "repo-c")).toBe(false);
  });

  it("按标题命中；无仓任务按 Home 命中", () => {
    expect(matchesSessionQuery({ title: "修登录", repoPaths: [] }, "登录")).toBe(true);
    expect(matchesSessionQuery({ title: "x", repoPaths: [] }, "home")).toBe(true);
  });
});

describe("批量选中只作用于传入（可见）行", () => {
  it("已终结：只含非对话的 merged / abandoned", () => {
    const rows = [
      row({ id: "1", repoStatus: "merged" }),
      row({ id: "2", repoStatus: "abandoned" }),
      row({ id: "3", repoStatus: "developing" }),
      row({ id: "4", mode: "chat", repoStatus: "merged" }),
    ];
    expect(pickFinishedSessions(rows).map((r) => r.id)).toEqual(["1", "2"]);
    // 传入的是筛选后的子集：不在子集里的不会被选中
    expect(pickFinishedSessions(rows.slice(2)).map((r) => r.id)).toEqual([]);
  });

  it("30 天未活跃：now 由调用方给、边界严格大于", () => {
    const now = 100 * 24 * 3600 * 1000;
    const rows = [
      row({ id: "old", mode: "chat", updatedAt: now - CHAT_STALE_MS - 1 }),
      row({ id: "edge", mode: "chat", updatedAt: now - CHAT_STALE_MS }),
      row({ id: "task", updatedAt: 0 }),
    ];
    expect(pickStaleChatSessions(rows, now).map((r) => r.id)).toEqual(["old"]);
  });

  it("已归档", () => {
    const rows = [row({ id: "a", archived: true }), row({ id: "b" })];
    expect(pickArchivedSessions(rows).map((r) => r.id)).toEqual(["a"]);
    expect(pickArchivedSessions([rows[1]])).toEqual([]);
  });
});

describe("prunePicked：勾选集合随可见范围求交（R8-05）", () => {
  it("剔掉不在可见集合里的 key，保留可见的", () => {
    const picked = new Set(["a", "b", "stale:x"]);
    const out = prunePicked(picked, ["b", "stale:x", "c"]);
    expect([...out].sort()).toEqual(["b", "stale:x"]);
    // 不修改入参
    expect([...picked].sort()).toEqual(["a", "b", "stale:x"]);
  });

  it("没有被剔除时返回原引用（避免无谓重渲染）", () => {
    const picked = new Set(["a", "b"]);
    expect(prunePicked(picked, ["a", "b", "c"])).toBe(picked);
  });

  it("可见集合为空 → 全部失效；picked 为空 → 原样", () => {
    expect(prunePicked(new Set(["a"]), []).size).toBe(0);
    const empty = new Set<string>();
    expect(prunePicked(empty, ["a"])).toBe(empty);
  });

  it("端到端口径：筛选切换后旧勾选失效，批量删除的集合只含当前可见行", () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      row({ id: `m${i}`, repoStatus: "merged", updatedAt: i }),
    ).concat([row({ id: "chat1", mode: "chat", updatedAt: 1 })]);

    // 只渲染了第一批：「选中已终结」只选已渲染的行
    const rendered = rows.slice(0, SESSIONS_PAGE_SIZE);
    const picked = new Set(pickFinishedSessions(rendered).map((r) => r.id));
    expect(picked.size).toBe(SESSIONS_PAGE_SIZE);
    expect(picked.has("m149")).toBe(false);

    // 切到「只看对话」：已渲染的行变成 chat1 一行 → 之前勾的全部失效
    const afterFilter = rows.filter((r) => r.mode === "chat");
    expect(prunePicked(picked, afterFilter.map((r) => r.id)).size).toBe(0);

    // 搜索收窄到 3 行：只剩这 3 行里本来就勾着的
    const narrowed = rows.slice(0, 3).map((r) => r.id);
    expect([...prunePicked(picked, narrowed)].sort()).toEqual(["m0", "m1", "m2"]);
  });
});

describe("页面接线契约", () => {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "../src/app/sessions/page.tsx"),
    "utf-8",
  );
  it("三个快捷选中都吃 renderedRows（筛选后且已渲染的行），不吃 visible / 全量 tasks", () => {
    expect(src).toContain("pickFinishedSessions(renderedRows)");
    expect(src).toContain("pickStaleChatSessions(renderedRows, Date.now())");
    expect(src).toContain("pickArchivedSessions(renderedRows)");
  });
  it("勾选集合派生自 prunePicked，批量删除执行点再求交一次", () => {
    expect(src).toContain("prunePicked(picked, pickableKeys)");
    expect(src).toMatch(/const toDelete = prunePicked\(picked, pickableKeys\)/);
  });
  it("列表分批渲染 + 显示更多", () => {
    expect(SESSIONS_PAGE_SIZE).toBeGreaterThan(0);
    expect(src).toContain("visible.slice(0, shownCount)");
    expect(src).toContain("显示更多");
    expect(src).toContain("renderedRows.map");
  });
});
