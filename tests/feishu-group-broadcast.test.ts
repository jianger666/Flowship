/**
 * 需求群自动播报（第三批）：三档判定 / 跳过分支 / 防重 / 失败降级不阻塞
 *
 * 全部 mock 外部调用——**禁止真调飞书**（share 一律是 vi.fn）。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, Task } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-group-broadcast-${Date.now()}`,
  "data",
);

const {
  __setGroupBroadcastDepsForTest,
  broadcastActionCompletion,
  buildActionMrLinks,
  buildAllActionMrLinks,
  shouldBroadcastAction,
} = await import("@/lib/server/feishu-bridge/group-broadcast");

const {
  __resetGroupArtifactCardDedupForTest,
  __resetGroupReplyStateForTest,
  claimGroupArtifactCard,
  rememberGroupReply,
} = await import("@/lib/server/feishu-bridge/group-shared");

const { getGroupAutoBroadcastMode } = await import(
  "@/lib/server/feishu-bridge/bridge-config"
);

const ARTIFACT = "# Ship #3\n\nMR 已提交、待测试";

const shipAction = (over: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    id: "act-9",
    n: 3,
    type: "ship",
    status: "awaiting_ack",
    userInstruction: "",
    artifactPath: "actions/3-ship.md",
    startedAt: Date.now(),
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
    ...over,
  }) as unknown as Task;

/** 无参声明的 vi.fn 其 mock.calls 被推成 []——取实参统一走这个 helper */
const callArgs = (fn: unknown, i = 0): unknown[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][])[i] ?? [];

const baseDeps = (over: Record<string, unknown> = {}) => ({
  getMode: async () => "all",
  isBridgeEnabled: async () => true,
  isAdvanceResultToGroupEnabled: async () => true,
  getBoundGroupChatId: async () => "oc_x",
  shareToGroup: vi.fn(async () => ({ chatId: "oc_x", messageId: "om_x" })),
  readArtifact: async () => ARTIFACT,
  warn: () => {},
  ...over,
});

beforeEach(() => {
  __resetGroupArtifactCardDedupForTest();
  __resetGroupReplyStateForTest();
});

afterEach(() => {
  __setGroupBroadcastDepsForTest(null);
  __resetGroupArtifactCardDedupForTest();
  __resetGroupReplyStateForTest();
});

// 设置页「产出自动发需求群」已砍（2026-07-28）：档位固定 off。
// 这里不 mock getMode、直接接生产读取点，锁死「action 跑完不会自动刷群」。
describe("固定策略：产出不自动发需求群", () => {
  it("接真实档位读取点 → 连 ship 跑完都不播报", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({ shareToGroup, getMode: getGroupAutoBroadcastMode }) as never,
    );
    const action = shipAction();
    await expect(
      broadcastActionCompletion(taskOf(action), action),
    ).resolves.toBe("skipped_mode");
    expect(shareToGroup).not.toHaveBeenCalled();
  });
});

describe("档位判定（纯函数）", () => {
  it("off 一律不播", () => {
    expect(shouldBroadcastAction("off", "ship")).toBe(false);
    expect(shouldBroadcastAction("off", "plan")).toBe(false);
  });

  it("ship 只认提测", () => {
    expect(shouldBroadcastAction("ship", "ship")).toBe(true);
    expect(shouldBroadcastAction("ship", "plan")).toBe(false);
    expect(shouldBroadcastAction("ship", "build")).toBe(false);
    expect(shouldBroadcastAction("ship", "custom")).toBe(false);
  });

  it("all 全都播（含自定义 action）", () => {
    expect(shouldBroadcastAction("all", "plan")).toBe(true);
    expect(shouldBroadcastAction("all", "custom")).toBe(true);
  });
});

describe("MR 按钮只取本 action 的副作用", () => {
  it("按仓末段命名、多仓各一条", () => {
    const links = buildActionMrLinks(
      shipAction({
        sideEffects: {
          mrs: [
            {
              repoPath: "/Users/me/code/crm-web",
              mrUrl: "https://gitlab/mr/1",
              mrVersion: 1,
              branch: "feature/a",
              commitHash: "abc",
            },
            {
              repoPath: "/Users/me/code/crm-api",
              mrUrl: "https://gitlab/mr/2",
              mrVersion: 1,
              branch: "feature/a",
              commitHash: "def",
            },
          ],
        },
      }),
    );
    expect(links).toEqual([
      { label: "MR · crm-web", url: "https://gitlab/mr/1" },
      { label: "MR · crm-api", url: "https://gitlab/mr/2" },
    ]);
  });

  it("没有副作用 → 空数组（卡片只留正文和署名）", () => {
    expect(buildActionMrLinks(shipAction())).toEqual([]);
  });

  it("空 url 跳过、最多 10 个", () => {
    const mrs = Array.from({ length: 12 }, (_, i) => ({
      repoPath: `/repo/r${i}`,
      mrUrl: `https://gitlab/mr/${i}`,
      mrVersion: 1,
      branch: "b",
      commitHash: "c",
    }));
    mrs[0].mrUrl = "  ";
    const links = buildActionMrLinks(shipAction({ sideEffects: { mrs } }));
    expect(links).toHaveLength(10);
    expect(links[0]).toEqual({ label: "MR · r1", url: "https://gitlab/mr/1" });
  });

  it("all 版不封顶、封顶版取前 10（超的溢到正文）", () => {
    const mrs = Array.from({ length: 12 }, (_, i) => ({
      repoPath: `/repo/r${i}`,
      mrUrl: `https://gitlab/mr/${i}`,
      mrVersion: 1,
      branch: "b",
      commitHash: "c",
    }));
    const action = shipAction({ sideEffects: { mrs } });
    expect(buildAllActionMrLinks(action)).toHaveLength(12);
    const capped = buildActionMrLinks(action);
    expect(capped).toHaveLength(10);
    expect(capped[9]).toEqual({ label: "MR · r9", url: "https://gitlab/mr/9" });
  });
});

describe("播报闭环", () => {
  it("all 档：发 artifact 卡（title=action 标题、正文截断、带 MR 按钮）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction({
      sideEffects: {
        mrs: [
          {
            repoPath: "/repo/crm-web",
            mrUrl: "https://gitlab/mr/1",
            mrVersion: 1,
            branch: "b",
            commitHash: "c",
          },
        ],
      },
    });

    const out = await broadcastActionCompletion(taskOf(action), action);

    expect(out).toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    const input = callArgs(shareToGroup)[1] as Record<string, unknown>;
    expect(input.kind).toBe("artifact");
    expect(input.title).toBe("提测");
    expect(input.content).toContain("MR 已提交");
    expect(input.links).toEqual([
      { label: "MR · crm-web", url: "https://gitlab/mr/1" },
    ]);
  });

  it("12 条 MR：按钮 10 个，超的 2 条拼进正文（播报不静默丢）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction({
      sideEffects: {
        mrs: Array.from({ length: 12 }, (_, i) => ({
          repoPath: `/repo/r${i}`,
          mrUrl: `https://gitlab/mr/${i}`,
          mrVersion: 1,
          branch: "b",
          commitHash: "c",
        })),
      },
    });

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe("sent");
    const input = callArgs(shareToGroup)[1] as {
      content: string;
      links: Array<{ label: string; url: string }>;
    };
    expect(input.links).toHaveLength(10);
    // 溢出进 md 文件正文：打开文件即见
    expect(input.content).toContain("剩下的 MR");
    expect(input.content).toContain("https://gitlab/mr/10");
    expect(input.content).toContain("https://gitlab/mr/11");
  });

  it("ship 档：非提测 action 不播", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({ shareToGroup, getMode: async () => "ship" }) as never,
    );
    const action = shipAction({ type: "plan", artifactPath: "actions/1-plan.md" });

    const out = await broadcastActionCompletion(taskOf(action), action);

    expect(out).toBe("skipped_mode");
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("off 档：什么都不发", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({ shareToGroup, getMode: async () => "off" }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_mode",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("轻量任务（无飞书链接）跳过——同步预筛，连设置都不读", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    const getMode = vi.fn(async () => "all");
    __setGroupBroadcastDepsForTest(
      baseDeps({ shareToGroup, getMode }) as never,
    );
    const action = shipAction();

    const out = await broadcastActionCompletion(
      taskOf(action, { feishuStoryUrl: "" }),
      action,
    );

    expect(out).toBe("skipped_lightweight");
    expect(getMode).not.toHaveBeenCalled();
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("桥接总开关关 → 不播", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({ shareToGroup, isBridgeEnabled: async () => false }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_bridge_off",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("没有 artifact → 不发空卡", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction({ artifactPath: null });

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_no_content",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("artifact 读挂 / 空文件 → 不发空卡，也不算失败", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup,
        readArtifact: async () => {
          throw new Error("ENOENT");
        },
      }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_no_content",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("还没有需求群 → 跳过、绝不为了播报建群拉人", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    const getBoundGroupChatId = vi.fn(async () => null);
    __setGroupBroadcastDepsForTest(
      baseDeps({ shareToGroup, getBoundGroupChatId }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_no_group",
    );
    expect(getBoundGroupChatId).toHaveBeenCalledTimes(1);
    // shareToRequirementGroup 内部会 ensure（建群 + 拉人 + bind）——播报绝不能走到那
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  // 准入闸第二半：预筛读到群、几个 await 后真发时群已被解绑（TOCTOU）
  it("share 恒带 allowCreate:false；真发时报 no_group → 静默跳过、不写降级 info", async () => {
    const shareToGroup = vi.fn(async () => {
      throw Object.assign(new Error("这个需求还没有需求群、本次不建群"), {
        code: "no_group",
      });
    });
    const emitInfo = vi.fn(async () => {});
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();

    const out = await broadcastActionCompletion(taskOf(action), action, {
      emitInfo,
    });

    expect(out).toBe("skipped_no_group");
    expect(callArgs(shareToGroup)[2]).toEqual({ allowCreate: false });
    // 没群不是失败、别往事件流写「群播报失败」
    expect(emitInfo).not.toHaveBeenCalled();
  });

  it("查群失败（meegle 挂）→ 当作没群跳过、不抛", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup,
        getBoundGroupChatId: async () => {
          throw new Error("meegle 超时");
        },
      }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_no_group",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("读设置抛错 → 当作不播（保守降级、不炸主流程）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup,
        getMode: async () => {
          throw new Error("config.json 坏了");
        },
      }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_mode",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });
});

describe("让位给群内推进回流（不发两张卡）", () => {
  it("有 advance 登记 + 开关开 → 交给 group-outbound", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    rememberGroupReply("task-1", {
      chatId: "oc_x",
      requesterOpenId: "ou_z",
      requesterName: "张三",
      kind: "advance",
      actionId: action.id,
      channel: "owner",
    });

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_group_reply",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("有 advance 登记但「结果回群」关 → outbound 不发、本模块补位", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup,
        isAdvanceResultToGroupEnabled: async () => false,
      }) as never,
    );
    const action = shipAction();
    rememberGroupReply("task-1", {
      chatId: "oc_x",
      requesterOpenId: "ou_z",
      requesterName: "张三",
      kind: "advance",
      actionId: action.id,
      channel: "owner",
    });

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(1);
  });

  it("question 类登记不影响播报（那条走文本回答、不是产物卡）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    rememberGroupReply("task-1", {
      chatId: "oc_x",
      requesterOpenId: "ou_z",
      requesterName: "张三",
      kind: "question",
      channel: "owner",
    });

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe("sent");
  });

  it("登记的是别的 action → 不让位", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    rememberGroupReply("task-1", {
      chatId: "oc_x",
      requesterOpenId: "ou_z",
      requesterName: "张三",
      kind: "advance",
      actionId: "act-other",
      channel: "owner",
    });

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe("sent");
  });
});

describe("防重：同一 action 只播一次", () => {
  it("重复调用第二次被挡", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    const task = taskOf(action);

    expect(await broadcastActionCompletion(task, action)).toBe("sent");
    expect(await broadcastActionCompletion(task, action)).toBe(
      "skipped_duplicate",
    );
    expect(shareToGroup).toHaveBeenCalledTimes(1);
  });

  it("并发两次也只发一张（先占坑再发、中间零 await）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    const task = taskOf(action);

    const outs = await Promise.all([
      broadcastActionCompletion(task, action),
      broadcastActionCompletion(task, action),
    ]);

    expect(outs.filter((o) => o === "sent")).toHaveLength(1);
    expect(outs.filter((o) => o === "skipped_duplicate")).toHaveLength(1);
    expect(shareToGroup).toHaveBeenCalledTimes(1);
  });

  it("发失败会退坑——下轮重新交卷还能再试", async () => {
    const shareToGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("飞书超时"))
      .mockResolvedValueOnce({});
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    const task = taskOf(action);

    expect(await broadcastActionCompletion(task, action)).toBe("failed");
    expect(await broadcastActionCompletion(task, action)).toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(2);
  });

  it("出向 done flush 已占坑 → 播报预筛扑空也不再发第二张卡", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const action = shipAction();
    // 模拟 group-outbound.flushGroupReply：takeGroupReply 摘走登记（预筛扑空）后先占坑再发卡
    expect(claimGroupArtifactCard("task-1", action.id)).toBe(true);

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "skipped_duplicate",
    );
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("不同 action 各播各的", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupBroadcastDepsForTest(baseDeps({ shareToGroup }) as never);
    const a1 = shipAction();
    const a2 = shipAction({ id: "act-10", n: 4 });

    expect(await broadcastActionCompletion(taskOf(a1), a1)).toBe("sent");
    expect(await broadcastActionCompletion(taskOf(a2), a2)).toBe("sent");
    expect(shareToGroup).toHaveBeenCalledTimes(2);
  });
});

describe("失败降级：绝不影响 action 完成主流程", () => {
  it("bot 不在群 → 事件流一条 info、不抛", async () => {
    const emitInfo = vi.fn(async () => {});
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup: vi.fn(async () => {
          throw new Error("请在群设置里添加你的机器人 小明助手（仅首次）");
        }),
      }) as never,
    );
    const action = shipAction();

    const out = await broadcastActionCompletion(taskOf(action), action, {
      emitInfo,
    });

    expect(out).toBe("failed");
    expect(emitInfo).toHaveBeenCalledTimes(1);
    expect(callArgs(emitInfo)[0]).toBe(
      "群播报失败：请在群设置里添加你的机器人 小明助手（仅首次）",
    );
  });

  it("share 抛非 Error 也能降级", async () => {
    const emitInfo = vi.fn(async () => {});
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup: vi.fn(async () => {
          throw "lark 挂了";
        }),
      }) as never,
    );
    const action = shipAction();

    expect(
      await broadcastActionCompletion(taskOf(action), action, { emitInfo }),
    ).toBe("failed");
    expect(callArgs(emitInfo)[0]).toBe("群播报失败：lark 挂了");
  });

  it("连降级事件都写不进去（租约没了）也不抛", async () => {
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup: vi.fn(async () => {
          throw new Error("飞书挂了");
        }),
      }) as never,
    );
    const action = shipAction();

    const out = await broadcastActionCompletion(taskOf(action), action, {
      emitInfo: async () => {
        throw new Error("租约已失效");
      },
    });

    expect(out).toBe("failed");
  });

  it("没传 emitInfo 时失败也安静收场", async () => {
    __setGroupBroadcastDepsForTest(
      baseDeps({
        shareToGroup: vi.fn(async () => {
          throw new Error("飞书挂了");
        }),
      }) as never,
    );
    const action = shipAction();

    expect(await broadcastActionCompletion(taskOf(action), action)).toBe(
      "failed",
    );
  });
});
