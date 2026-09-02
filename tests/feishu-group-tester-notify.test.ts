/**
 * 提测完成后需求群 @ 测试：名单换 open_id / 跳过分支 / bot 不在群静默
 *
 * 全部 mock 外部调用——禁止真调飞书。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, Task } from "@/lib/types";
import { FeishuGroupError } from "@/lib/server/feishu-group";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-group-tester-notify-${Date.now()}`,
  "data",
);

const {
  __resetTesterNotifyDedupForTest,
  __setGroupTesterNotifyDepsForTest,
  actionHasShipConflicts,
  buildTesterNotifyContent,
  notifyShipTestersInGroup,
  pickTesterAtTargets,
} = await import("@/lib/server/feishu-bridge/group-tester-notify");

const { parseUserSearchEmailMap } = await import("@/lib/server/meegle-cli");

const shipAction = (over: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    id: "act-9",
    n: 3,
    type: "ship",
    status: "awaiting_ack",
    userInstruction: "",
    artifactPath: "actions/3-ship.md",
    startedAt: Date.now(),
    sideEffects: {
      mrs: [
        {
          repoPath: "/tmp/crm-web",
          mrUrl: "https://gitlab.example/crm-web/-/merge_requests/1",
          mrVersion: 1,
          branch: "feature/x",
          commitHash: "abc",
        },
      ],
    },
    ...over,
  }) as ActionRecord;

const taskOf = (action: ActionRecord, over: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: action.id,
    repoPaths: ["/tmp/crm-web"],
    mrs: [],
    actions: [action],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
    feishuTesterUserKeys: ["uk_zhang"],
    ...over,
  }) as unknown as Task;

const callArgs = (fn: unknown, i = 0): unknown[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][])[i] ?? [];

const baseDeps = (over: Record<string, unknown> = {}) => ({
  getBoundGroupChatId: async () => "oc_req",
  decodeStory: async () => ({ workItemId: "10001", simpleName: "space" }),
  fetchRoleMembers: async () => [
    {
      userKey: "uk_zhang",
      email: "zhang@example.com",
      name: "张三",
    },
  ],
  searchUsers: async () => [],
  parseSearchMap: () => ({}),
  readRegistry: async () => ({
    "zhang@example.com": { openId: "ou_zhang", name: "张三" },
  }),
  shareToGroup: vi.fn(async () => ({ messageId: "om_n" })),
  warn: () => {},
  ...over,
});

afterEach(() => {
  __resetTesterNotifyDedupForTest();
  __setGroupTesterNotifyDepsForTest(null);
});

describe("pickTesterAtTargets", () => {
  it("角色成员邮箱命中注册表 → open_id；对不上的进 missed", () => {
    const { at, missedNames } = pickTesterAtTargets(
      ["uk_zhang", "uk_li"],
      [
        { userKey: "uk_zhang", email: "zhang@example.com", name: "张三" },
        { userKey: "uk_li", email: "li@example.com", name: "李四" },
      ],
      {},
      { "zhang@example.com": { openId: "ou_zhang", name: "张三" } },
    );
    expect(at).toEqual([{ openId: "ou_zhang", name: "张三" }]);
    expect(missedNames).toEqual(["李四"]);
  });

  it("角色没邮箱时用 user search 兜底", () => {
    const { at } = pickTesterAtTargets(
      ["uk_zhang"],
      [{ userKey: "uk_zhang", name: "张三" }],
      { uk_zhang: { email: "zhang@example.com" } },
      { "zhang@example.com": { openId: "ou_zhang" } },
    );
    expect(at).toEqual([{ openId: "ou_zhang", name: "张三" }]);
  });

  it("同一 open_id 去重", () => {
    const { at } = pickTesterAtTargets(
      ["uk_a", "uk_b"],
      [
        { userKey: "uk_a", email: "a@x.com", name: "A" },
        { userKey: "uk_b", email: "b@x.com", name: "B" },
      ],
      {},
      {
        "a@x.com": { openId: "ou_same" },
        "b@x.com": { openId: "ou_same" },
      },
    );
    expect(at).toHaveLength(1);
  });
});

describe("buildTesterNotifyContent", () => {
  it("只写验收语 + MR 列表，不含 @ 标签", () => {
    const md = buildTesterNotifyContent([
      { label: "MR · crm-web", url: "https://gitlab.example/mr/1" },
    ]);
    expect(md).toContain("已提测，请验收");
    expect(md).toContain("https://gitlab.example/mr/1");
    expect(md).not.toContain("<at ");
  });
});

describe("actionHasShipConflicts", () => {
  it("任一条 MR 冲突则 true", () => {
    expect(
      actionHasShipConflicts(
        shipAction({
          sideEffects: {
            mrs: [
              {
                repoPath: "/a",
                mrUrl: "u",
                mrVersion: 1,
                branch: "b",
                commitHash: "c",
                hasConflicts: true,
              },
            ],
          },
        }),
      ),
    ).toBe(true);
    expect(actionHasShipConflicts(shipAction())).toBe(false);
  });
});

describe("parseUserSearchEmailMap", () => {
  it("按 user_key 收邮箱", () => {
    expect(
      parseUserSearchEmailMap({
        data: [
          { user_key: "uk_zhang", email: "zhang@example.com", name: "张三" },
          { key: "uk_li", user_email: "li@example.com" },
        ],
      }),
    ).toEqual({
      uk_zhang: { email: "zhang@example.com", name: "张三" },
      uk_li: { email: "li@example.com" },
    });
  });
});

describe("notifyShipTestersInGroup", () => {
  it("命中注册表 → shareToGroup format=post，不走错误事件", async () => {
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction();
    const task = taskOf(action);
    await expect(
      notifyShipTestersInGroup(task, action, { emitInfo }),
    ).resolves.toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    const [, input, opts] = callArgs(shareToGroup);
    expect(input).toMatchObject({
      format: "post",
      mentions: [{ openId: "ou_zhang", name: "张三" }],
    });
    expect((input as { content: string }).content).toContain("merge_requests/1");
    expect((input as { content: string }).content).not.toContain("<at ");
    expect(opts).toEqual({ allowCreate: false });
    expect(callArgs(shareToGroup)[0]).toBe(task);
    expect(emitInfo).toHaveBeenCalledWith(expect.stringContaining("已在需求群 @ 张三"));
  });

  it("没绑群 → skipped、不发", async () => {
    const shareToGroup = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({ getBoundGroupChatId: async () => null, shareToGroup }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("skipped_no_group");
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("没有测试人员 → 不发", async () => {
    const shareToGroup = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(
        taskOf(action, { feishuTesterUserKeys: [] }),
        action,
      ),
    ).resolves.toBe("skipped_no_testers");
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("MR 有冲突 → 不发（对齐飞书评论门禁）", async () => {
    const shareToGroup = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction({
      sideEffects: {
        mrs: [
          {
            repoPath: "/tmp/crm-web",
            mrUrl: "https://gitlab.example/mr/1",
            mrVersion: 1,
            branch: "f",
            commitHash: "a",
            hasConflicts: true,
          },
        ],
      },
    });
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("skipped_conflicts");
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("注册表对不上 open_id → 不发、不报错", async () => {
    const shareToGroup = vi.fn();
    const warn = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({ shareToGroup, readRegistry: async () => ({}), warn }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("skipped_no_open_ids");
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("bot 不在群 → skipped_bot_not_in_group，不抛、不 emitInfo", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup: async () => {
          throw new FeishuGroupError(
            "bot_not_in_group",
            "群里还没有你的机器人",
            { botLabel: "Flowship·甲", chatId: "oc_req" },
          );
        },
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action, { emitInfo }),
    ).resolves.toBe("skipped_bot_not_in_group");
    expect(emitInfo).not.toHaveBeenCalled();
  });

  it("同一 action 只发一次", async () => {
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction();
    const task = taskOf(action);
    await expect(notifyShipTestersInGroup(task, action)).resolves.toBe("sent");
    await expect(notifyShipTestersInGroup(task, action)).resolves.toBe(
      "skipped_duplicate",
    );
    expect(shareToGroup).toHaveBeenCalledTimes(1);
  });

  it("非 ship action 不发", async () => {
    const shareToGroup = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction({ type: "review" });
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("skipped_not_ship");
    expect(shareToGroup).not.toHaveBeenCalled();
  });
});
