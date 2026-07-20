/**
 * 侧栏分组 / 置顶重排 / 搜索合并 单测
 */
import { describe, expect, it } from "vitest";

import {
  applyPinnedOrder,
  buildRepoGroups,
  buildSearchSnippet,
  buildStatusGroups,
  mergeSidebarSearchSections,
  movePinnedId,
  normalizeRepoPath,
  resolveRepoGroupLabel,
  statusBucketFor,
  UNBOUND_GROUP_LABEL,
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
  it("置顶 → 仓组（按组内最新 updatedAt）→ 未绑定", () => {
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
    expect(groups[3]!.label).toBe(UNBOUND_GROUP_LABEL);
    // 未绑定即使 updatedAt 最大也恒最后
    expect(groups[3]!.items[0]!.id).toBe("u1");
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

describe("buildStatusGroups / statusBucketFor", () => {
  it("状态映射与节序：等你回复 → 运行中 → 空闲", () => {
    expect(statusBucketFor({ runStatus: "awaiting_user" })).toBe("awaiting");
    expect(statusBucketFor({ runStatus: "running" })).toBe("running");
    expect(statusBucketFor({ runStatus: "idle" })).toBe("idle");
    expect(statusBucketFor({ runStatus: "error" })).toBe("idle");

    const groups = buildStatusGroups([
      task({ id: "r", title: "跑", runStatus: "running", updatedAt: 2 }),
      task({
        id: "w",
        title: "等",
        runStatus: "awaiting_user",
        updatedAt: 3,
      }),
      task({ id: "i", title: "闲", runStatus: "idle", updatedAt: 1 }),
      task({
        id: "p",
        title: "顶",
        pinned: true,
        runStatus: "running",
        updatedAt: 9,
      }),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      "pinned",
      "status:awaiting",
      "status:running",
      "status:idle",
    ]);
    expect(groups[0]!.items[0]!.id).toBe("p");
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

describe("mergeSidebarSearchSections / buildSearchSnippet", () => {
  it("标题命中优先，内容节去重", () => {
    const t1 = task({ id: "1", title: "登录 bug" });
    const t2 = task({ id: "2", title: "别的" });
    const byId = new Map([
      ["1", t1],
      ["2", t2],
    ]);
    const sections = mergeSidebarSearchSections(
      [t1],
      [
        { taskId: "1", snippet: "…登录…" },
        { taskId: "2", snippet: "…正文命中…" },
      ],
      byId,
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]!.key).toBe("title");
    expect(sections[0]!.items.map((t) => t.id)).toEqual(["1"]);
    expect(sections[1]!.key).toBe("content");
    expect(sections[1]!.items.map((t) => t.id)).toEqual(["2"]);
    expect(sections[1]!.items[0]!.contentSnippet).toBe("…正文命中…");
  });

  it("摘要截取命中上下文", () => {
    const text = "前面一堆字" + "目标关键词" + "后面一堆字";
    const snip = buildSearchSnippet(text, "关键词", 4);
    expect(snip).toContain("关键词");
    expect(snip.startsWith("…") || snip.includes("目标")).toBe(true);
  });
});
