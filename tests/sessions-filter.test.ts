/**
 * 会话管理页：搜索覆盖所有仓、批量选中只作用于可见行、分批渲染接线（S13-13 + 选中范围）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BATCH_DELETE_LIST_MAX,
  BATCH_DELETE_TITLE_MAX_CHARS,
  buildBatchDeleteSummary,
  CHAT_STALE_MS,
  countProtectedStaleChats,
  isBulkProtected,
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

describe("isBulkProtected：快捷选中不替用户决定删掉的会话（R14 B6-3 / Q5-03）", () => {
  it("置顶 / 主 AI 在跑 / 后台子代理在跑 / 带 live 定时：各自受保护", () => {
    expect(isBulkProtected({ pinned: true })).toBe(true);
    expect(isBulkProtected({ runStatus: "running" })).toBe(true);
    expect(isBulkProtected({ backgroundSubagentCount: 1 })).toBe(true);
    expect(isBulkProtected({ hasLiveSchedule: true })).toBe(true);
  });

  it("缺省 / false / 0 / 非 running 的运行态：都不保护", () => {
    expect(isBulkProtected({})).toBe(false);
    expect(
      isBulkProtected({
        pinned: false,
        backgroundSubagentCount: 0,
        hasLiveSchedule: false,
        runStatus: "idle",
      }),
    ).toBe(false);
    for (const runStatus of ["idle", "awaiting_user", "error", "stopped"]) {
      expect(isBulkProtected({ runStatus }), runStatus).toBe(false);
    }
  });

  it("后台子代理数量不是正的有限数（NaN / 负数 / 无穷 / 字符串）：不当作在跑——与列表行的「后台运行中」徽标同口径", () => {
    const bad: unknown[] = [Number.NaN, -1, 0, Number.POSITIVE_INFINITY, "3"];
    for (const n of bad) {
      expect(isBulkProtected({ backgroundSubagentCount: n as number }), String(n)).toBe(false);
    }
  });

  it("主 AI 空闲但后台子代理还在跑：受保护（只看 runStatus 会漏）", () => {
    expect(isBulkProtected({ runStatus: "idle", backgroundSubagentCount: 3 })).toBe(true);
  });
});

describe("30 天未活跃的快捷选中排除受保护会话（R14 B6-3 / Q5-03）", () => {
  const now = 100 * 24 * 3600 * 1000;
  const old = now - CHAT_STALE_MS - 1;
  const oldChat = (id: string, over: Parameters<typeof row>[0] = {}) =>
    row({ id, mode: "chat", updatedAt: old, ...over });

  it("置顶 / 在跑 / 后台子代理 / 带定时的旧对话不会被选中（改前全都会被选中）", () => {
    const rows = [
      oldChat("pinned", { pinned: true }),
      oldChat("running", { runStatus: "running" }),
      oldChat("bg", { backgroundSubagentCount: 2 }),
      oldChat("sched", { hasLiveSchedule: true }),
      oldChat("plain"),
    ];
    expect(pickStaleChatSessions(rows, now).map((r) => r.id)).toEqual(["plain"]);
  });

  it("对照：同样旧、但字段是 false / 0 / 空闲的，仍然被选中", () => {
    const rows = [
      oldChat("a", { pinned: false }),
      oldChat("b", { backgroundSubagentCount: 0 }),
      oldChat("c", { hasLiveSchedule: false }),
      oldChat("d", { runStatus: "idle" }),
    ];
    expect(pickStaleChatSessions(rows, now).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("原有口径不变：边界仍严格大于、非对话不选；受保护的没到期也不涉及", () => {
    const rows = [
      row({ id: "edge", mode: "chat", updatedAt: now - CHAT_STALE_MS }),
      row({ id: "task", updatedAt: 0 }),
      row({ id: "fresh-pinned", mode: "chat", updatedAt: now, pinned: true }),
    ];
    expect(pickStaleChatSessions(rows, now)).toEqual([]);
    expect(countProtectedStaleChats(rows, now)).toBe(0);
  });

  it("受保护只影响「30 天未活跃」这一个推断型选中：已终结 / 已归档的快捷选中不受影响（那是用户自己声明过的状态）", () => {
    const finished = row({ id: "f", repoStatus: "merged", pinned: true, hasLiveSchedule: true });
    const archived = row({ id: "a", archived: true, pinned: true, runStatus: "running" });
    expect(pickFinishedSessions([finished]).map((r) => r.id)).toEqual(["f"]);
    expect(pickArchivedSessions([archived]).map((r) => r.id)).toEqual(["a"]);
  });

  it("countProtectedStaleChats：只数「30 天未活跃且受保护」的，与 pickStaleChatSessions 互补", () => {
    const rows = [
      oldChat("pinned", { pinned: true }),
      oldChat("sched", { hasLiveSchedule: true }),
      oldChat("plain"),
      row({ id: "fresh-running", mode: "chat", updatedAt: now, runStatus: "running" }),
      row({ id: "task-pinned", updatedAt: 0, pinned: true }),
    ];
    expect(countProtectedStaleChats(rows, now)).toBe(2);
    expect(pickStaleChatSessions(rows, now).map((r) => r.id)).toEqual(["plain"]);
  });
});

describe("buildBatchDeleteSummary：批量删除确认框里的「到底删哪些」（R14 B6-3 / Q5-03）", () => {
  const titles = (n: number) => Array.from({ length: n }, (_, i) => row({ title: `会话${i + 1}` }));

  it("什么都没有（没有会话、没有残留工作区）：返回空串，调用方据此不拼", () => {
    expect(buildBatchDeleteSummary([], 0)).toBe("");
  });

  it("不超限：逐个列标题，一行一个，前面带「· 」", () => {
    expect(buildBatchDeleteSummary([row({ title: "甲" }), row({ title: "乙" })], 0)).toBe(
      "· 甲\n· 乙",
    );
  });

  it("恰好等于上限：全列、不出现「另有」；多一个：只列上限个，剩下折成一行「另有 N 个会话」", () => {
    expect(BATCH_DELETE_LIST_MAX).toBe(8);
    const exact = buildBatchDeleteSummary(titles(BATCH_DELETE_LIST_MAX), 0).split("\n");
    expect(exact).toHaveLength(BATCH_DELETE_LIST_MAX);
    expect(exact.join("\n")).not.toContain("另有");

    const over = buildBatchDeleteSummary(titles(BATCH_DELETE_LIST_MAX + 1), 0).split("\n");
    expect(over).toHaveLength(BATCH_DELETE_LIST_MAX + 1);
    expect(over[BATCH_DELETE_LIST_MAX - 1]).toBe(`· 会话${BATCH_DELETE_LIST_MAX}`);
    expect(over[BATCH_DELETE_LIST_MAX]).toBe("· …另有 1 个会话");

    const many = buildBatchDeleteSummary(titles(100), 0).split("\n");
    expect(many).toHaveLength(BATCH_DELETE_LIST_MAX + 1);
    expect(many[BATCH_DELETE_LIST_MAX]).toBe(`· …另有 ${100 - BATCH_DELETE_LIST_MAX} 个会话`);
  });

  it("长标题按字符数截断并补省略号；刚好等于上限不截", () => {
    expect(BATCH_DELETE_TITLE_MAX_CHARS).toBe(24);
    const exact = "字".repeat(BATCH_DELETE_TITLE_MAX_CHARS);
    expect(buildBatchDeleteSummary([row({ title: exact })], 0)).toBe(`· ${exact}`);
    const over = "字".repeat(BATCH_DELETE_TITLE_MAX_CHARS + 1);
    expect(buildBatchDeleteSummary([row({ title: over })], 0)).toBe(
      `· ${"字".repeat(BATCH_DELETE_TITLE_MAX_CHARS)}…`,
    );
  });

  it("按码点截断：emoji（代理对）不会被劈成乱码", () => {
    const out = buildBatchDeleteSummary([row({ title: "😀".repeat(30) })], 0);
    expect(out).toBe(`· ${"😀".repeat(BATCH_DELETE_TITLE_MAX_CHARS)}…`);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("标题里的换行 / 连续空白折成一个空格、首尾去掉——一个标题永远只占一行", () => {
    const out = buildBatchDeleteSummary([row({ title: "  第一行\n\n第二行\t\t尾巴  " })], 0);
    expect(out).toBe("· 第一行 第二行 尾巴");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("空标题（全空白）给占位，不留一行光秃秃的「· 」", () => {
    expect(buildBatchDeleteSummary([row({ title: " \n\t " })], 0)).toBe("· （无标题）");
  });

  it("残留工作区不逐个列，合成一行；只有残留工作区时只剩这一行；为 0 不出现", () => {
    expect(buildBatchDeleteSummary([], 3)).toBe("· 3 个残留工作区");
    const out = buildBatchDeleteSummary([row({ title: "甲" })], 5).split("\n");
    expect(out).toEqual(["· 甲", "· 5 个残留工作区"]);
    expect(buildBatchDeleteSummary([row({ title: "甲" })], 0)).not.toContain("残留");
  });

  it("有受保护项才多一行「其中含…」，只列数量 > 0 的类别，放在最后", () => {
    const rows = [
      row({ title: "甲", pinned: true }),
      row({ title: "乙", hasLiveSchedule: true }),
      row({ title: "丙", hasLiveSchedule: true, pinned: true }),
      row({ title: "丁", runStatus: "running" }),
      row({ title: "戊", backgroundSubagentCount: 3 }),
      row({ title: "己" }),
    ];
    const lines = buildBatchDeleteSummary(rows, 2).split("\n");
    expect(lines[lines.length - 1]).toBe("其中含置顶 2、带定时 2、在跑 2");
    expect(lines[lines.length - 2]).toBe("· 2 个残留工作区");
  });

  it("只有一类受保护：只写那一类", () => {
    const out = buildBatchDeleteSummary([row({ title: "甲", pinned: true }), row({ title: "乙" })], 0);
    expect(out.split("\n").pop()).toBe("其中含置顶 1");
    expect(out).not.toContain("带定时");
    expect(out).not.toContain("在跑");
  });

  it("没有任何受保护项：不出现「其中含」", () => {
    const out = buildBatchDeleteSummary(
      [row({ title: "甲", pinned: false, hasLiveSchedule: false, backgroundSubagentCount: 0, runStatus: "idle" })],
      1,
    );
    expect(out).not.toContain("其中含");
  });

  it("受保护计数不受「只列前 8 个标题」限制：第 9 个以后的置顶也要算进去", () => {
    const rows = [
      ...titles(BATCH_DELETE_LIST_MAX),
      row({ title: "第九个", pinned: true }),
      row({ title: "第十个", pinned: true }),
    ];
    const out = buildBatchDeleteSummary(rows, 0);
    expect(out).not.toContain("第九个");
    expect(out.split("\n").pop()).toBe("其中含置顶 2");
  });
});

describe("页面接线契约：批量删除的保护与确认清单（R14 B6-3 / Q5-03）", () => {
  const readSrc = (rel: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");
  const src = readSrc("src/app/sessions/page.tsx");

  it("确认清单在弹框之前算好（别插在 title 与 description 之间）：summary → summaryBlock → confirm", () => {
    const start = src.indexOf("const handleBatchDelete = async () => {");
    expect(start).toBeGreaterThan(-1);
    const summaryAt = src.indexOf("const summary = buildBatchDeleteSummary(", start);
    const blockAt = src.indexOf("const summaryBlock = summary ?", start);
    const confirmAt = src.indexOf("await confirm({", start);
    expect(summaryAt).toBeGreaterThan(start);
    expect(blockAt).toBeGreaterThan(summaryAt);
    expect(confirmAt).toBeGreaterThan(blockAt);
  });

  it("清单只含已与可见行求交后的勾选项（taskKeys → renderedRows 查行），残留工作区个数来自 staleIds", () => {
    const start = src.indexOf("const summary = buildBatchDeleteSummary(");
    const call = src.slice(start, src.indexOf("const summaryBlock", start));
    expect(call).toContain("rowById.get(id)");
    expect(call).toContain("taskKeys.flatMap");
    expect(call).toContain("staleIds.length");
    expect(src).toContain("new Map(renderedRows.map((t) => [t.id, t]))");
  });

  it("description 末尾拼清单：DELETE_UNCOMMITTED_NOTE 仍在原位，清单跟在它后面、与正文空一行分段", () => {
    expect(src).toContain("${DELETE_UNCOMMITTED_NOTE}${summaryBlock}");
    // 清单前是两个换行转义（不是真换行）；没清单时是空串、description 不留尾巴
    expect(src).toContain('const summaryBlock = summary ? `\\n\\n${summary}` : "";');
  });

  it("按钮计数仍是「将选中的数」（吃 getStaleChats），被跳过的个数另用灰字告诉用户", () => {
    expect(src).toContain("选中 30 天未活跃（{getStaleChats().length}）");
    expect(src).toContain("countProtectedStaleChats(renderedRows, Date.now())");
    expect(src).toContain("getStaleProtectedCount() > 0 &&");
    expect(src).toContain("要删请逐个勾选");
  });

  it("进页补拉一次列表（缩短详情页回灌冲掉 hasLiveSchedule 之后的陈旧窗口）", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*void refresh\(\);\s*\}, \[refresh\]\);/);
  });

  it("确认框的描述要能换行：AlertDialogDescription 带 whitespace-pre-line（全局影响所有 confirm 描述）", () => {
    const dialog = readSrc("src/hooks/use-dialog.tsx");
    // className 里还会带别的类（X5-b 加了 max-h / overflow-y-auto 让长清单自己滚）：只要求 whitespace-pre-line 在其中
    expect(dialog).toMatch(/<AlertDialogDescription className="[^"]*\bwhitespace-pre-line\b[^"]*">/);
  });
});
