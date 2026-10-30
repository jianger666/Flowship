/**
 * 提测通知没送达时给属主留 info（B4-4 / Q12b-04）。
 *
 * 原来：`notify_group_testers` 除 sent 外（bot 不在群 / 测试人员都没邮箱 / 发送失败 / 超时）只把 outcome 回给 agent，
 * 写不写进 artifact 全看模型，事件流里没有任何痕迹，属主以为测试已被 @；`skipped_no_open_ids` 连没 @ 到的人名都不报。
 * 现在：这几种情形各留一条可操作的 info（提测通知是 ship 的最后一拍，之后没有人会再提醒测试，属主得知道要自己去 @）。
 *
 * 刻意仍然静默的：没群（不是每个任务都用群）、skipped_not_ship / lightweight / no_testers / conflicts / no_mrs / duplicate。
 *
 * 全部 mock 外部调用——禁止真调飞书。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, Task } from "@/lib/types";
import { FeishuGroupError } from "@/lib/server/feishu-group";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-tester-notify-issues-${Date.now()}`,
  "data",
);

const {
  __resetTesterNotifyDedupForTest,
  __setGroupTesterNotifyDepsForTest,
  TESTER_NOTIFY_TIMEOUT_MS,
  notifyShipTestersInGroup,
  testerNotifyIssueText,
} = await import("@/lib/server/feishu-bridge/group-tester-notify");

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

const baseDeps = (over: Record<string, unknown> = {}) => ({
  getBoundGroupChatId: async () => "oc_req",
  decodeStory: async () => ({ workItemId: "10001", simpleName: "space" }),
  fetchRoleMembers: async () => [
    { userKey: "uk_zhang", email: "zhang@example.com", name: "张三" },
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

beforeEach(() => {
  __resetTesterNotifyDedupForTest();
});

afterEach(() => {
  vi.useRealTimers();
  __resetTesterNotifyDedupForTest();
  __setGroupTesterNotifyDepsForTest(null);
});

describe("testerNotifyIssueText：每句 = 没发出去 + 为什么 + 现在该手动做什么", () => {
  it("bot 不在群：带 bot 名（有就带），请加回群并手动 @", () => {
    expect(testerNotifyIssueText({ kind: "bot_not_in_group", botLabel: "Flowship·甲" })).toBe(
      "提测通知没发出去：机器人「Flowship·甲」不在需求群里（可能被移出了群）。请把它加回群，并手动 @ 测试人员",
    );
    expect(testerNotifyIssueText({ kind: "bot_not_in_group" })).toBe(
      "提测通知没发出去：机器人不在需求群里（可能被移出了群）。请把它加回群，并手动 @ 测试人员",
    );
  });

  it("换不出邮箱：点名（顿号分隔）；没名字就泛称「测试人员」", () => {
    expect(testerNotifyIssueText({ kind: "no_identity", names: ["张三", "李四"] })).toBe(
      "提测通知没发出去：没能换出 张三、李四 的飞书邮箱（工作项角色里没有、user search 也没查到），无法 @。请手动 @ 他们",
    );
    expect(testerNotifyIssueText({ kind: "no_identity", names: [] })).toContain("没能换出 测试人员 的飞书邮箱");
  });

  it("群已解散 / 你已不在群里 / 发送失败 / 超时 / 准备失败", () => {
    expect(testerNotifyIssueText({ kind: "group_unreachable" })).toBe(
      "提测通知没发出去：需求群已解散或失效。请在「需求群」弹窗换绑 / 重建一个群，并手动 @ 测试人员",
    );
    expect(testerNotifyIssueText({ kind: "owner_not_in_group" })).toBe(
      "提测通知没发出去：你已不在需求群里。请先回到群里（或在「需求群」弹窗换绑），并手动 @ 测试人员",
    );
    expect(testerNotifyIssueText({ kind: "send_failed", reason: "net down" })).toBe(
      "提测通知发送失败（net down）。请手动 @ 测试人员，或稍后重新提测",
    );
    expect(testerNotifyIssueText({ kind: "timeout" })).toBe(
      "提测通知超时，没能确认是否发出（可能已经发出，请到需求群看一眼）。没有的话请手动 @ 测试人员",
    );
    expect(testerNotifyIssueText({ kind: "prepare_failed", reason: "meegle down" })).toBe(
      "提测通知没能发出去（meegle down）。请手动 @ 测试人员",
    );
  });

  it("原因：折叠空白、超长截断到 200 字（带省略号）", () => {
    const text = testerNotifyIssueText({ kind: "send_failed", reason: "a\n\n  b\t c" });
    expect(text).toContain("（a b c）");
    const long = testerNotifyIssueText({ kind: "send_failed", reason: "x".repeat(500) });
    expect(long).toContain(`（${"x".repeat(199)}…）`);
    expect(long).not.toContain("x".repeat(200));
  });
});

describe("notifyShipTestersInGroup：失败类 outcome 给属主留 info", () => {
  it("测试人员都换不出邮箱：skipped_no_open_ids + 点名（展示名或 key），不发卡", async () => {
    const shareToGroup = vi.fn();
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        fetchRoleMembers: async () => [{ userKey: "uk_a", name: "甲" }],
        readRegistry: async () => ({}),
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action, { feishuTesterUserKeys: ["uk_a", "uk_b", "uk_a"] }), action, {
        emitInfo,
      }),
    ).resolves.toBe("skipped_no_open_ids");
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(emitInfo).toHaveBeenCalledTimes(1);
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "no_identity", names: ["甲", "uk_b"] }));
  });

  it("没邮箱的两个人同名（key 不同）：info 里只点一次名，不写成「甲、甲」", async () => {
    const shareToGroup = vi.fn();
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup,
        fetchRoleMembers: async () => [
          { userKey: "uk_a", name: "甲" },
          { userKey: "uk_c", name: "甲" },
        ],
        readRegistry: async () => ({}),
      }),
    );
    const action = shipAction();
    await expect(
      notifyShipTestersInGroup(taskOf(action, { feishuTesterUserKeys: ["uk_a", "uk_c"] }), action, { emitInfo }),
    ).resolves.toBe("skipped_no_open_ids");
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(emitInfo).toHaveBeenCalledTimes(1);
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "no_identity", names: ["甲"] }));
    expect(emitInfo).not.toHaveBeenCalledWith(testerNotifyIssueText({ kind: "no_identity", names: ["甲", "甲"] }));
  });

  it("没邮箱换不出身份的一次提测不占防重名额：之后换出来了可以正常发（原有行为不变）", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps({ fetchRoleMembers: async () => [], readRegistry: async () => ({}) }));
    const action = shipAction();
    const task = taskOf(action);
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("skipped_no_open_ids");
    __setGroupTesterNotifyDepsForTest(baseDeps());
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("sent");
    expect(emitInfo).toHaveBeenCalledTimes(2);
    expect(emitInfo).toHaveBeenLastCalledWith(expect.stringContaining("已在需求群 @ 张三"));
  });

  it("bot 不在群但 FeishuGroupError 没带 botLabel：info 里不编造 bot 名", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup: async () => {
          throw new FeishuGroupError("bot_not_in_group", "群里还没有你的机器人", { chatId: "oc_req" });
        },
      }),
    );
    const action = shipAction();
    await expect(notifyShipTestersInGroup(taskOf(action), action, { emitInfo })).resolves.toBe(
      "skipped_bot_not_in_group",
    );
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "bot_not_in_group" }));
  });

  it("群已解散（group_unreachable）→ failed + 可操作的 info；你已不在群（owner_not_in_group）同理", async () => {
    for (const [code, kind] of [
      ["group_unreachable", "group_unreachable"],
      ["owner_not_in_group", "owner_not_in_group"],
    ] as const) {
      __resetTesterNotifyDedupForTest();
      const emitInfo = vi.fn();
      __setGroupTesterNotifyDepsForTest(
        baseDeps({
          shareToGroup: async () => {
            throw new FeishuGroupError(code, "不重要的原文", { chatId: "oc_req" });
          },
        }),
      );
      const action = shipAction();
      await expect(notifyShipTestersInGroup(taskOf(action), action, { emitInfo })).resolves.toBe("failed");
      expect(emitInfo).toHaveBeenCalledTimes(1);
      expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind }));
    }
  });

  it("其它发送失败 → failed + 带原因的 info；退坑照旧（可再调一次）", async () => {
    const emitInfo = vi.fn();
    const shareToGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("net down"))
      .mockResolvedValue({ messageId: "om_n" });
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction();
    const task = taskOf(action);
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("failed");
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "send_failed", reason: "net down" }));
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(2);
    expect(emitInfo).toHaveBeenCalledTimes(2);
  });

  it("准备阶段失败（读注册表炸了）→ failed + prepare_failed 的 info", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        readRegistry: async () => {
          throw new Error("registry unreadable");
        },
      }),
    );
    const action = shipAction();
    await expect(notifyShipTestersInGroup(taskOf(action), action, { emitInfo })).resolves.toBe("failed");
    expect(emitInfo).toHaveBeenCalledTimes(1);
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "prepare_failed", reason: "registry unreadable" }));
  });

  it("runNotify 里 try 之外抛出（未捕获）→ failed + prepare_failed，不抛", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps());
    const action = shipAction();
    const task = taskOf(action);
    Object.defineProperty(task, "feishuTesterUserKeys", {
      get() {
        throw new Error("getter exploded");
      },
    });
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("failed");
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "prepare_failed", reason: "getter exploded" }));
  });

  it("超时：failed + 「没能确认」的 info；后台那次随后真发出去时再写「已在需求群 @」（先说没能确认、再补一句已发出，不矛盾）", async () => {
    vi.useFakeTimers();
    const emitInfo = vi.fn();
    let release: (v: unknown) => void = () => {};
    const shareToGroup = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    __setGroupTesterNotifyDepsForTest(baseDeps({ shareToGroup }));
    const action = shipAction();
    const pending = notifyShipTestersInGroup(taskOf(action), action, { emitInfo });
    await vi.advanceTimersByTimeAsync(TESTER_NOTIFY_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe("failed");
    expect(emitInfo).toHaveBeenCalledTimes(1);
    expect(emitInfo).toHaveBeenCalledWith(testerNotifyIssueText({ kind: "timeout" }));
    // 在途请求后来落卡了
    release({ messageId: "om_late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitInfo).toHaveBeenCalledTimes(2);
    expect(emitInfo).toHaveBeenLastCalledWith(expect.stringContaining("已在需求群 @ 张三"));
  });

  it("emitInfo 抛 / 返回 rejected promise：不影响 outcome（info 写失败只吞掉）", async () => {
    const throwing = vi.fn(() => {
      throw new Error("event log full");
    });
    const rejecting = vi.fn(async () => {
      throw new Error("event log full");
    });
    for (const emitInfo of [throwing, rejecting]) {
      __resetTesterNotifyDedupForTest();
      __setGroupTesterNotifyDepsForTest(
        baseDeps({
          shareToGroup: async () => {
            throw new FeishuGroupError("bot_not_in_group", "x", { botLabel: "B" });
          },
        }),
      );
      const action = shipAction();
      await expect(notifyShipTestersInGroup(taskOf(action), action, { emitInfo })).resolves.toBe(
        "skipped_bot_not_in_group",
      );
      expect(emitInfo).toHaveBeenCalledTimes(1);
    }
  });

  it("不传 emitInfo：各分支都不抛", async () => {
    __setGroupTesterNotifyDepsForTest(
      baseDeps({
        shareToGroup: async () => {
          throw new Error("net down");
        },
      }),
    );
    const action = shipAction();
    await expect(notifyShipTestersInGroup(taskOf(action), action)).resolves.toBe("failed");
  });
});

describe("仍然静默的 outcome（不是失败，或本来就没打算发）", () => {
  const run = async (
    deps: Record<string, unknown>,
    over: { action?: Record<string, unknown>; task?: Partial<Task> } = {},
  ) => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps(deps));
    const action = shipAction(over.action as Partial<ActionRecord> | undefined);
    const outcome = await notifyShipTestersInGroup(taskOf(action, over.task), action, { emitInfo });
    return { outcome, emitInfo };
  };

  it("没绑群：skipped_no_group，不留 info（不是每个任务都用群）", async () => {
    const { outcome, emitInfo } = await run({ getBoundGroupChatId: async () => null });
    expect(outcome).toBe("skipped_no_group");
    expect(emitInfo).not.toHaveBeenCalled();
  });

  it("发送时才发现没群 / 没关联工作项（no_group / no_story）：同样静默", async () => {
    for (const code of ["no_group", "no_story"] as const) {
      __resetTesterNotifyDedupForTest();
      const { outcome, emitInfo } = await run({
        shareToGroup: async () => {
          throw new FeishuGroupError(code, "x");
        },
      });
      expect(outcome).toBe("skipped_no_group");
      expect(emitInfo).not.toHaveBeenCalled();
    }
  });

  it("非 ship / 轻量任务 / 没配测试人员 / MR 有冲突 / 没有 MR：都静默", async () => {
    expect((await run({}, { action: { type: "review" } })).emitInfo).not.toHaveBeenCalled();
    expect((await run({}, { task: { feishuTesterUserKeys: [] } })).emitInfo).not.toHaveBeenCalled();
    expect(
      (
        await run(
          {},
          {
            action: {
              sideEffects: {
                mrs: [
                  {
                    repoPath: "/tmp/crm-web",
                    mrUrl: "https://gitlab.example/crm-web/-/merge_requests/1",
                    mrVersion: 1,
                    branch: "f",
                    commitHash: "a",
                    hasConflicts: true,
                  },
                ],
              },
            },
          },
        )
      ).emitInfo,
    ).not.toHaveBeenCalled();
    expect((await run({}, { action: { sideEffects: { mrs: [] } } })).emitInfo).not.toHaveBeenCalled();
  });

  it("重复调用（已发过）：skipped_duplicate，不再留 info", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps());
    const action = shipAction();
    const task = taskOf(action);
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("sent");
    emitInfo.mockClear();
    await expect(notifyShipTestersInGroup(task, action, { emitInfo })).resolves.toBe("skipped_duplicate");
    expect(emitInfo).not.toHaveBeenCalled();
  });

  it("sent 路径文案不变：已在需求群 @ 张三（卡片 @）", async () => {
    const emitInfo = vi.fn();
    __setGroupTesterNotifyDepsForTest(baseDeps());
    const action = shipAction();
    await expect(notifyShipTestersInGroup(taskOf(action), action, { emitInfo })).resolves.toBe("sent");
    expect(emitInfo).toHaveBeenCalledTimes(1);
    expect(emitInfo).toHaveBeenCalledWith("已在需求群 @ 张三（卡片 @）");
  });
});
