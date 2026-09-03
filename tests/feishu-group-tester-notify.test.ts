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
  it("有邮箱即有卡片 @ 资格；三无（邮箱/open/union全无）才进 missed", () => {
    const { at, missedNames } = pickTesterAtTargets(
      ["uk_zhang", "uk_li", "uk ghost"],
      [
        { userKey: "uk_zhang", email: "zhang@example.com", name: "张三" },
        { userKey: "uk_li", email: "li@example.com", name: "李四" },
      ],
      {},
      { "zhang@example.com": { openId: "ou_zhang", name: "张三" } },
    );
    expect(at).toEqual([
      { name: "张三", email: "zhang@example.com", openId: "ou_zhang" },
      { name: "李四", email: "li@example.com" },
    ]);
    expect(missedNames).toEqual(["uk ghost"]);
  });

  it("注册表对不上 → union_id 降级（不需要对方注册）", () => {
    const { at, missedNames } = pickTesterAtTargets(
      ["uk_zhang", "uk_li"],
      [{ userKey: "uk_zhang", name: "张三" }],
      { uk_zhang: { email: "zhang@example.com", unionId: "on_zhang" } },
      {},
    );
    expect(at).toEqual([{ name: "张三", email: "zhang@example.com", unionId: "on_zhang" }]);
    expect(missedNames).toEqual(["uk_li"]);
  });

  it("open_id / union_id / email 全有 → 全收下（sink 各取所需）", () => {
    const { at } = pickTesterAtTargets(
      ["uk_zhang"],
      [{ userKey: "uk_zhang", email: "zhang@example.com", name: "张三" }],
      { uk_zhang: { email: "zhang@example.com", unionId: "on_zhang" } },
      { "zhang@example.com": { openId: "ou_zhang" } },
    );
    expect(at).toEqual([{ name: "张三", email: "zhang@example.com", openId: "ou_zhang", unionId: "on_zhang" }]);
  });

  it("角色没邮箱时用 user search 兜底", () => {
    const { at } = pickTesterAtTargets(
      ["uk_zhang"],
      [{ userKey: "uk_zhang", name: "张三" }],
      { uk_zhang: { email: "zhang@example.com" } },
      { "zhang@example.com": { openId: "ou_zhang" } },
    );
    expect(at).toEqual([{ name: "张三", email: "zhang@example.com", openId: "ou_zhang" }]);
  });

  it("同一人多 key 命中 → 按邮箱去重", () => {
    const { at } = pickTesterAtTargets(
      ["uk_a", "uk_b"],
      [
        { userKey: "uk_a", email: "same@x.com", name: "同" },
        { userKey: "uk_b", name: "同" },
      ],
      { uk_b: { email: "same@x.com", unionId: "on_same" } },
      {},
    );
    expect(at).toEqual([{ name: "同", email: "same@x.com", unionId: "on_same" }]);
  });

  it("同一 open_id（注册表别名邮箱）→ 只 @ 一次", () => {
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
  it("无 cardAts：只写验收语 + MR 列表，不含 @ 标签", () => {
    const md = buildTesterNotifyContent([
      { label: "MR · crm-web", url: "https://gitlab.example/mr/1" },
    ]);
    expect(md).toContain("已提测，请验收");
    expect(md).toContain("https://gitlab.example/mr/1");
    expect(md).not.toContain("<at ");
  });

  it("有 cardAts：@ + 验收语开头，MR 列表全列正文（方便复制粘贴）、按钮再挂一遍", () => {
    const md = buildTesterNotifyContent(
      [{ label: "MR · crm-web", url: "https://gitlab.example/mr/1" }],
      [{ email: "zhang@example.com", name: "张三" }],
    );
    expect(md).toBe(
      "<at email=zhang@example.com></at> 已提测，请验收：\n- MR · crm-web https://gitlab.example/mr/1",
    );
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
          { user_key: "uk_zhang", email: "zhang@example.com", name: "张三", out_id: "on_zhang" },
          { key: "uk_li", user_email: "li@example.com" },
          // 非 on_ 开头的数字 id 一律丢掉（lark_user_id 进 IM @ 必死）
          { user_key: "uk_num", email: "num@example.com", out_id: "7227111883734647000" },
        ],
      }),
    ).toEqual({
      uk_zhang: { email: "zhang@example.com", name: "张三", unionId: "on_zhang" },
      uk_li: { email: "li@example.com" },
      uk_num: { email: "num@example.com" },
    });
  });
});

describe("notifyShipTestersInGroup", () => {
  it("有邮箱 → 发一张卡片（邮箱 @），不走 post", async () => {
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
      kind: "message",
      title: "提测通知",
    });
    expect((input as { content: string }).content).toContain(
      "<at email=zhang@example.com></at> 已提测，请验收：",
    );
    // 正文按钮双通道：按钮点开看，MR 列表全列正文方便复制粘贴
    expect((input as { content: string }).content).toContain("merge_requests/1");
    expect((input as { links: unknown }).links).toHaveLength(1);
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

  it("角色有邮箱 → 直接发，不补调 user search（只走卡片）", async () => {
    const searchUsers = vi.fn(async () => [] as unknown[]);
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        searchUsers,
        fetchRoleMembers: async () => [
          { userKey: "uk_zhang", email: "zhang@example.com", name: "张三" },
        ],
        readRegistry: async () => ({}),
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("sent");
    expect(searchUsers).not.toHaveBeenCalled();
    const [, input] = callArgs(shareToGroup);
    expect((input as { content: string }).content).toContain(
      "<at email=zhang@example.com></at>",
    );
  });

  it("注册表直接命中 → 不调 user search", async () => {
    const searchUsers = vi.fn(async () => [] as unknown[]);
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    __setGroupTesterNotifyDepsForTest(baseDeps({ searchUsers, shareToGroup }));
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("sent");
    expect(searchUsers).not.toHaveBeenCalled();
  });

  it("邮箱和 id 全换不出 → 不发、不报错", async () => {
    const shareToGroup = vi.fn();
    const warn = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        fetchRoleMembers: async () => [{ userKey: "uk_zhang", name: "张三" }],
        searchUsers: async () => [],
        readRegistry: async () => ({}),
        warn,
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("skipped_no_open_ids");
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("今天线上场景：角色有邮箱、注册表没人 → 卡片邮箱 @ 发出", async () => {
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        fetchRoleMembers: async () => [{ userKey: "uk_zhang", name: "张三" }],
        searchUsers: async () => [
          { user_key: "uk_zhang", email: "zhang@example.com", out_id: "on_zhang" },
        ],
        parseSearchMap: (resp: unknown) => parseUserSearchEmailMap(resp),
        readRegistry: async () => ({}),
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action, { emitInfo }),
    ).resolves.toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    const [, input] = callArgs(shareToGroup);
    expect(input).toMatchObject({ kind: "message", title: "提测通知" });
    expect((input as { content: string }).content).toContain(
      "<at email=zhang@example.com></at> 已提测",
    );
    expect(emitInfo).toHaveBeenCalledWith(expect.stringContaining("卡片"));
  });

  it("无邮箱只有 union → 不发（post 降级已删，只认邮箱）", async () => {
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        fetchRoleMembers: async () => [
          { userKey: "uk_zhang", name: "张三", unionId: "on_zhang" },
        ],
        searchUsers: async () => [],
        readRegistry: async () => ({}),
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action), action, { emitInfo }),
    ).resolves.toBe("skipped_no_open_ids");
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(emitInfo).not.toHaveBeenCalled();
  });

  it("12 条 MR：按钮封顶 10，正文 12 条全列（超的溢到正文）", async () => {
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const mrs = Array.from({ length: 12 }, (_, i) => ({
      repoPath: `/tmp/r${i}`,
      mrUrl: `https://gitlab.example/r${i}/-/merge_requests/${i}`,
      mrVersion: 1,
      branch: "f",
      commitHash: "a",
    }));
    const action = shipAction({ sideEffects: { mrs } });
    await expect(
      notifyShipTestersInGroup(taskOf(action), action),
    ).resolves.toBe("sent");
    const [, input] = callArgs(shareToGroup);
    expect((input as { links: unknown[] }).links).toHaveLength(10);
    const content = (input as { content: string }).content;
    expect(content).toContain("merge_requests/10");
    expect(content).toContain("merge_requests/11");
  });

  it("混合：有邮箱的发出、纯 union 的进 missed 不静默吞", async () => {
    const shareToGroup = vi.fn(async () => ({ messageId: "om_n" }));
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        fetchRoleMembers: async () => [
          { userKey: "uk_a", email: "a@example.com", name: "A" },
          { userKey: "uk_b", name: "B", unionId: "on_b" },
        ],
        searchUsers: async () => [],
        readRegistry: async () => ({}),
      }),
    );
    const action = shipAction();
    const task = taskOf(action, { feishuTesterUserKeys: ["uk_a", "uk_b"] });
    await expect(
      notifyShipTestersInGroup(task, action, { emitInfo }),
    ).resolves.toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    const [, input] = callArgs(shareToGroup);
    expect((input as { content: string }).content).toContain(
      "<at email=a@example.com></at>",
    );
    expect((input as { content: string }).content).not.toContain("on_b");
    // B 没邮箱发不出去，但必须出现在 missed 里，不能两头都看不见
    expect(emitInfo).toHaveBeenCalledWith(expect.stringContaining("A"));
    expect(emitInfo).toHaveBeenCalledWith(expect.stringContaining("B"));
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

  it("发送失败退坑：failed 后可重调，再成功即 sent（超时仍占位）", async () => {
    const shareToGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("net down"))
      .mockResolvedValue({ messageId: "om_n" });
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction();
    const task = taskOf(action);
    await expect(notifyShipTestersInGroup(task, action)).resolves.toBe("failed");
    await expect(notifyShipTestersInGroup(task, action)).resolves.toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(2);
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
