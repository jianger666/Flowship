/**
 * 同一个群上绑了多个任务时的共用判断（B4-4 / Q12b-02）：src/lib/server/feishu-bridge/group-task-binding.ts
 *
 * 纯函数、无 IO：
 *  - 候选口径 isGroupRouteCandidate（原来内联在 resolveTaskIdByGroupChat 里，现在与绑定查重共用）；
 *  - 「活着」判定 isTaskLiveForGroup 与同群多任务时的挑选 pickRouteTask；
 *  - 绑定查重 findLocalCoBoundTasks（只认本地关联、不含自己、同一套候选口径）。
 * 路由与绑定两处怎么用它，分别在 group-route-multi-bound.test.ts / requirement-group-bind-also-bound.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
  findLocalCoBoundTasks,
  hasLocalGroupBinding,
  isGroupRouteCandidate,
  isTaskLiveForGroup,
  pickRouteTask,
  toCoBoundTask,
  type GroupBindingTaskLike,
} from "@/lib/server/feishu-bridge/group-task-binding";

const STORY = "https://project.feishu.cn/space/story/detail/10001";

const task = (over: Partial<GroupBindingTaskLike> & { id: string }): GroupBindingTaskLike => ({
  title: `任务 ${over.id}`,
  feishuStoryUrl: STORY,
  repoStatus: "developing",
  updatedAt: 1000,
  runStatus: "idle",
  ...over,
});

describe("isGroupRouteCandidate：群消息能回流到哪些任务", () => {
  it("有工作项链接 → 是候选", () => {
    expect(isGroupRouteCandidate(task({ id: "a" }))).toBe(true);
  });

  it("没链接但本地关联了群 → 也是候选（本地关联不需要工作项）", () => {
    expect(
      isGroupRouteCandidate(task({ id: "a", feishuStoryUrl: undefined, feishuGroupChatId: "oc_x" })),
    ).toBe(true);
  });

  it("链接与本地关联都没有（或只有空白）→ 不是候选", () => {
    expect(isGroupRouteCandidate(task({ id: "a", feishuStoryUrl: undefined }))).toBe(false);
    expect(
      isGroupRouteCandidate(task({ id: "a", feishuStoryUrl: "  ", feishuGroupChatId: "   " })),
    ).toBe(false);
  });

  it.each([
    ["已合并", { repoStatus: "merged" }],
    ["已放弃", { repoStatus: "abandoned" }],
    ["已归档", { archived: true }],
  ] as const)("%s的任务退出群回流", (_label, over) => {
    expect(isGroupRouteCandidate(task({ id: "a", ...over }))).toBe(false);
  });

  it("没有 repoStatus / archived 字段的老任务照常是候选", () => {
    expect(isGroupRouteCandidate({ id: "old", feishuStoryUrl: STORY })).toBe(true);
  });
});

describe("hasLocalGroupBinding", () => {
  it("只认非空白的本地关联", () => {
    expect(hasLocalGroupBinding(task({ id: "a", feishuGroupChatId: "oc_x" }))).toBe(true);
    expect(hasLocalGroupBinding(task({ id: "a", feishuGroupChatId: "  " }))).toBe(false);
    expect(hasLocalGroupBinding(task({ id: "a" }))).toBe(false);
  });
});

describe("isTaskLiveForGroup：正在跑 / 等用户回答才算「活着」", () => {
  it.each([
    ["running", { runStatus: "running" }, true],
    ["awaiting_user", { runStatus: "awaiting_user" }, true],
    ["有待回答的提问（即便 runStatus 是 idle）", { runStatus: "idle", hasPendingAsk: true }, true],
    ["idle", { runStatus: "idle" }, false],
    ["error", { runStatus: "error" }, false],
    ["没有 runStatus 字段", { runStatus: undefined }, false],
    ["hasPendingAsk=false", { hasPendingAsk: false }, false],
  ] as const)("%s → %s", (_label, over, expected) => {
    expect(isTaskLiveForGroup(task({ id: "a", ...over }))).toBe(expected);
  });
});

describe("pickRouteTask：同一个群上有多个任务时挑谁受理", () => {
  const newest = task({ id: "newest", updatedAt: 3000 });
  const mid = task({ id: "mid", updatedAt: 2000 });
  const oldest = task({ id: "oldest", updatedAt: 1000 });

  it("都不活着 → 保持原来的口径：传入顺序里的第一个（= 最近更新的）", () => {
    expect(pickRouteTask(newest, [mid, oldest]).id).toBe("newest");
  });

  it("后面有个活着的 → 它胜过更新的空闲任务", () => {
    expect(pickRouteTask(newest, [mid, { ...oldest, runStatus: "running" }]).id).toBe("oldest");
  });

  it("有待回答的提问也算活着", () => {
    expect(pickRouteTask(newest, [{ ...mid, hasPendingAsk: true }, oldest]).id).toBe("mid");
  });

  it("多个都活着 → 其中最靠前的（最近更新的）", () => {
    expect(
      pickRouteTask(newest, [{ ...mid, runStatus: "running" }, { ...oldest, runStatus: "awaiting_user" }]).id,
    ).toBe("mid");
  });

  it("first 自己活着 → 仍是它（即便后面也有活着的）", () => {
    expect(
      pickRouteTask({ ...newest, runStatus: "running" }, [{ ...mid, runStatus: "running" }]).id,
    ).toBe("newest");
  });

  it("没有同伴 → 就是 first", () => {
    expect(pickRouteTask(oldest, []).id).toBe("oldest");
  });
});

describe("toCoBoundTask", () => {
  it("取 id 与去掉首尾空白的标题；没标题给空串（展示层再回退到 id）", () => {
    expect(toCoBoundTask(task({ id: "a", title: "  登录优化  " }))).toEqual({ id: "a", title: "登录优化" });
    expect(toCoBoundTask({ id: "b" })).toEqual({ id: "b", title: "" });
  });
});

describe("findLocalCoBoundTasks：绑定时查「这个群上还有别的任务吗」", () => {
  const CHAT = "oc_shared";
  const self = task({ id: "self", feishuGroupChatId: CHAT });
  const peerNewer = task({ id: "peer1", feishuGroupChatId: CHAT, updatedAt: 5000 });
  const peerOlder = task({ id: "peer2", feishuGroupChatId: ` ${CHAT} `, updatedAt: 100 });
  const otherChat = task({ id: "other", feishuGroupChatId: "oc_other" });
  const projectDefaultOnly = task({ id: "pd" }); // 只有工作项链接、没有本地关联：读它要打 meegle，不参与
  const archived = task({ id: "arch", feishuGroupChatId: CHAT, archived: true });
  const merged = task({ id: "mrg", feishuGroupChatId: CHAT, repoStatus: "merged" });
  const abandoned = task({ id: "abd", feishuGroupChatId: CHAT, repoStatus: "abandoned" });

  const all = [self, otherChat, peerNewer, projectDefaultOnly, archived, merged, abandoned, peerOlder];

  it("本地关联了同一个群、且还在回流候选里的别的任务，按传入顺序给出，不含自己", () => {
    const found = findLocalCoBoundTasks(all, { chatId: CHAT, excludeTaskId: "self" });
    expect(found.map((t) => t.id)).toEqual(["peer1", "peer2"]);
  });

  it("本地关联的群 id 前后有空白也认（与存盘口径无关）", () => {
    expect(findLocalCoBoundTasks([peerOlder], { chatId: CHAT }).map((t) => t.id)).toEqual(["peer2"]);
  });

  it("不传 excludeTaskId 时自己也算（调用方想看全部同群任务）", () => {
    expect(findLocalCoBoundTasks(all, { chatId: CHAT }).map((t) => t.id)).toEqual(["self", "peer1", "peer2"]);
  });

  it("别的群、只靠项目群默认的、归档 / 已合并 / 已放弃的都不算", () => {
    const ids = findLocalCoBoundTasks(all, { chatId: CHAT, excludeTaskId: "self" }).map((t) => t.id);
    for (const excluded of ["other", "pd", "arch", "mrg", "abd"]) expect(ids).not.toContain(excluded);
  });

  it("没有同群任务 → 空数组", () => {
    expect(findLocalCoBoundTasks([self, otherChat], { chatId: CHAT, excludeTaskId: "self" })).toEqual([]);
    expect(findLocalCoBoundTasks([], { chatId: CHAT })).toEqual([]);
  });
});
