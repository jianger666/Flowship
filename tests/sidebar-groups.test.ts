/**
 * 侧栏分组 / 置顶重排 单测
 */
import { describe, expect, it } from "vitest";

import {
  applyPinnedOrder,
  buildRepoGroups,
  HOME_GROUP_LABEL,
  movePinnedId,
  normalizeRepoPath,
  pickVisibleGroupItems,
  reconcileChatListOrder,
  repoPathsForGroupCreate,
  resolveRepoGroupLabel,
  scrollDeltaToReveal,
} from "@/lib/sidebar-groups";
import type { TaskSummary } from "@/lib/types";

const task = (
  partial: Partial<TaskSummary> & Pick<TaskSummary, "id" | "title">,
): TaskSummary =>
  ({
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    mrs: [],
    repoPaths: [],
    createdAt: 1,
    updatedAt: 1,
    actionCount: 0,
    mode: "chat",
    pinned: false,
    ...partial,
  }) as TaskSummary;

describe("resolveRepoGroupLabel / normalizeRepoPath", () => {
  it("优先用 settings 仓 name，否则 basename", () => {
    expect(
      resolveRepoGroupLabel("/Users/me/crm-web", [
        { path: "/Users/me/crm-web", name: "CRM 前台" },
      ]),
    ).toBe("CRM 前台");
    expect(resolveRepoGroupLabel("/Users/me/fe-ai-flow", [])).toBe("fe-ai-flow");
  });

  it("尾斜杠不影响 path 匹配", () => {
    expect(normalizeRepoPath("/a/b/")).toBe("/a/b");
    expect(
      resolveRepoGroupLabel("/a/b/", [{ path: "/a/b", name: "B" }]),
    ).toBe("B");
  });
});

describe("buildRepoGroups", () => {
  it("置顶 → 仓组（按组内最新 updatedAt）→ Home", () => {
    const groups = buildRepoGroups(
      [
        task({
          id: "p1",
          title: "钉住",
          pinned: true,
          updatedAt: 10,
          repoPaths: ["/old"],
        }),
        task({
          id: "a1",
          title: "A 旧",
          updatedAt: 100,
          repoPaths: ["/repos/a"],
        }),
        task({
          id: "a2",
          title: "A 新",
          updatedAt: 300,
          repoPaths: ["/repos/a"],
        }),
        task({
          id: "b1",
          title: "B",
          updatedAt: 200,
          repoPaths: ["/repos/b"],
        }),
        task({
          id: "u1",
          title: "未绑",
          updatedAt: 999,
          repoPaths: [],
        }),
      ],
      [
        { path: "/repos/a", name: "仓 A" },
        { path: "/repos/b", name: "仓 B" },
      ],
    );

    expect(groups.map((g) => g.key)).toEqual([
      "pinned",
      "repo:/repos/a",
      "repo:/repos/b",
      "unbound",
    ]);
    expect(groups[0]!.label).toBe("置顶");
    expect(groups[1]!.label).toBe("仓 A");
    expect(groups[1]!.items.map((t) => t.id)).toEqual(["a2", "a1"]);
    expect(groups[2]!.label).toBe("仓 B");
    expect(groups[3]!.label).toBe(HOME_GROUP_LABEL);
    expect(groups[3]!.label).toBe("Home");
    // Home 即使 updatedAt 最大也恒最后
    expect(groups[3]!.items[0]!.id).toBe("u1");
  });

  it("粘性序时组间不跟 updatedAt 对跳，组内也不换位", () => {
    const groups = buildRepoGroups(
      [
        task({
          id: "a1",
          title: "A 新活动",
          updatedAt: 900,
          repoPaths: ["/repos/a"],
        }),
        task({
          id: "a2",
          title: "A 旧",
          updatedAt: 100,
          repoPaths: ["/repos/a"],
        }),
        task({
          id: "b1",
          title: "B",
          updatedAt: 800,
          repoPaths: ["/repos/b"],
        }),
      ],
      [
        { path: "/repos/a", name: "仓 A" },
        { path: "/repos/b", name: "仓 B" },
      ],
      [],
      ["b1", "a2", "a1"],
    );
    expect(groups.map((g) => g.key)).toEqual([
      "repo:/repos/b",
      "repo:/repos/a",
    ]);
    expect(groups[1]!.items.map((t) => t.id)).toEqual(["a2", "a1"]);
  });

  it("置顶序按 pinnedOrder，幽灵 id 忽略", () => {
    const groups = buildRepoGroups(
      [
        task({ id: "p1", title: "1", pinned: true, updatedAt: 1 }),
        task({ id: "p2", title: "2", pinned: true, updatedAt: 2 }),
        task({ id: "p3", title: "3", pinned: true, updatedAt: 3 }),
      ],
      [],
      ["p2", "gone", "p1"],
    );
    expect(groups[0]!.items.map((t) => t.id)).toEqual(["p2", "p1", "p3"]);
  });
});

describe("repoPathsForGroupCreate", () => {
  it("仓组预绑路径；Home 空数组；置顶 null", () => {
    expect(
      repoPathsForGroupCreate({
        key: "repo:/repos/a",
        items: [task({ id: "a", title: "a", repoPaths: ["/repos/a"] })],
      }),
    ).toEqual(["/repos/a"]);
    expect(
      repoPathsForGroupCreate({
        key: "unbound",
        items: [task({ id: "u", title: "u", repoPaths: [] })],
      }),
    ).toEqual([]);
    expect(
      repoPathsForGroupCreate({
        key: "pinned",
        items: [task({ id: "p", title: "p", pinned: true, repoPaths: ["/x"] })],
      }),
    ).toBeNull();
  });
});

describe("applyPinnedOrder / movePinnedId", () => {
  it("applyPinnedOrder 按序排列并追加未收录", () => {
    const pinned = [
      task({ id: "a", title: "a", pinned: true, updatedAt: 1 }),
      task({ id: "b", title: "b", pinned: true, updatedAt: 3 }),
      task({ id: "c", title: "c", pinned: true, updatedAt: 2 }),
    ];
    expect(applyPinnedOrder(pinned, ["c", "a"]).map((t) => t.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("上/下移交换相邻项，越界不变", () => {
    const ids = ["a", "b", "c"];
    expect(movePinnedId(ids, ids, "b", "up")).toEqual(["b", "a", "c"]);
    expect(movePinnedId(ids, ids, "b", "down")).toEqual(["a", "c", "b"]);
    expect(movePinnedId(ids, ids, "a", "up")).toEqual(["a", "b", "c"]);
    expect(movePinnedId(ids, ids, "c", "down")).toEqual(["a", "b", "c"]);
  });
});

describe("reconcileChatListOrder", () => {
  it("已有相对序不动，新 id 插顶，已删丢掉", () => {
    expect(reconcileChatListOrder(["a", "b", "c"], ["c", "x", "a"])).toEqual([
      "x",
      "a",
      "c",
    ]);
  });

  it("空序时用当前 liveIds（第一次按 recency 冻住）", () => {
    expect(reconcileChatListOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("组头「+」新建后整组顶到最前（侧栏滚动位置不变时新行会落在视口之上）", () => {
  it("下方仓组里新建 → 该组变第一组、新对话是组内第一条", () => {
    const repoA = ["/Users/me/a"];
    const repoB = ["/Users/me/b"];
    const repoC = ["/Users/me/c"];
    const base = [
      task({ id: "a1", title: "a1", repoPaths: repoA, updatedAt: 30 }),
      task({ id: "b1", title: "b1", repoPaths: repoB, updatedAt: 20 }),
      task({ id: "c1", title: "c1", repoPaths: repoC, updatedAt: 10 }),
    ];
    const before = buildRepoGroups(base, [], [], ["a1", "b1", "c1"]);
    expect(before.map((g) => g.items[0]!.id)).toEqual(["a1", "b1", "c1"]);

    // 点第三组（c）的「+」：promoteSidebarChat 把新 id 顶到序首
    const created = task({ id: "n1", title: "新", repoPaths: repoC, updatedAt: 99 });
    const order = ["n1", "a1", "b1", "c1"];
    const after = buildRepoGroups([...base, created], [], [], order);
    expect(after[0]!.key).toBe("repo:/users/me/c");
    expect(after[0]!.items.map((t) => t.id)).toEqual(["n1", "c1"]);
    // 其余组整体被挤下去——点「+」那一刻在视口里的位置，新行已不在原处
    expect(after.slice(1).map((g) => g.items[0]!.id)).toEqual(["a1", "b1"]);
  });
});

describe("pickVisibleGroupItems（当前对话始终露出）", () => {
  const items = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it("没超限 / 已展开 → 全展、无隐藏", () => {
    const few = items.slice(0, 4);
    expect(pickVisibleGroupItems(few, { limit: 4, expanded: false })).toEqual({
      visible: few,
      hiddenCount: 0,
    });
    const r = pickVisibleGroupItems(items, { limit: 4, expanded: true });
    expect(ids(r.visible)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(r.hiddenCount).toBe(0);
  });

  it("超限且当前对话在前 N 条里 → 只展前 N 条", () => {
    const r = pickVisibleGroupItems(items, {
      limit: 4,
      expanded: false,
      activeId: "b",
    });
    expect(ids(r.visible)).toEqual(["a", "b", "c", "d"]);
    expect(r.hiddenCount).toBe(2);
  });

  it("超限且当前对话在被收起的尾部 → 追加露出，隐藏数扣掉它", () => {
    const r = pickVisibleGroupItems(items, {
      limit: 4,
      expanded: false,
      activeId: "f",
    });
    expect(ids(r.visible)).toEqual(["a", "b", "c", "d", "f"]);
    expect(r.hiddenCount).toBe(1);
  });

  it("刚好超限 1 条且当前对话就是那条 → 全露、隐藏数为 0", () => {
    const five = items.slice(0, 5);
    const r = pickVisibleGroupItems(five, {
      limit: 4,
      expanded: false,
      activeId: "e",
    });
    expect(ids(r.visible)).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.hiddenCount).toBe(0);
  });

  it("当前对话不在本组 / 没有当前对话 → 行为不变；limit=Infinity（置顶组）不限", () => {
    expect(
      ids(
        pickVisibleGroupItems(items, {
          limit: 4,
          expanded: false,
          activeId: "zzz",
        }).visible,
      ),
    ).toEqual(["a", "b", "c", "d"]);
    const pinned = pickVisibleGroupItems(items, {
      limit: Number.POSITIVE_INFINITY,
      expanded: false,
    });
    expect(pinned.visible).toHaveLength(6);
    expect(pinned.hiddenCount).toBe(0);
  });
});

describe("scrollDeltaToReveal（把行滚进侧栏可视区）", () => {
  const view = { top: 100, bottom: 500 };

  it("已完整在视口内 → 不滚", () => {
    expect(scrollDeltaToReveal(view, { top: 200, bottom: 232 })).toBe(0);
    expect(scrollDeltaToReveal(view, { top: 100, bottom: 132 })).toBe(0);
  });

  it("在视口下方（Home 组在最底）→ 向下滚到刚好露出 + 边距", () => {
    // 行底 700、视口底 500 → 200 + 8
    expect(scrollDeltaToReveal(view, { top: 668, bottom: 700 })).toBe(208);
  });

  it("在视口上方 → 向上滚（负增量）", () => {
    expect(scrollDeltaToReveal(view, { top: 40, bottom: 72 })).toBe(-68);
  });

  it("行比视口还高 → 不把行顶滚出视口", () => {
    // 行 150~900（高 750 > 视口 400）：向下最多滚到行顶贴视口顶（150-100-8=42）
    expect(scrollDeltaToReveal(view, { top: 150, bottom: 900 })).toBe(42);
    // 行顶本就紧贴视口顶：不动
    expect(scrollDeltaToReveal(view, { top: 104, bottom: 900 })).toBe(0);
  });
});
