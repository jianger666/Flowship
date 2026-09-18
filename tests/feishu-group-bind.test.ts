/**
 * 任务本地群关联（bindExistingRequirementGroup / clearTaskGroupAssociation /
 * describeBoundRequirementGroup / extractBindChatId）。
 *
 * 全部 mock 外部调用——禁止真调飞书 / meegle / 写盘。
 * 核心语义：工作项只读不写，关联只记本任务本地（persist 回调即落盘口）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LarkApiError } from "@/lib/server/feishu-bridge/types";
import { hydrateTaskSummary } from "@/lib/server/task-fs-core";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";
import {
  __setFeishuGroupDepsForTest,
  bindExistingRequirementGroup,
  clearTaskGroupAssociation,
  describeBoundRequirementGroup,
  extractBindChatId,
  FeishuGroupError,
  getBoundGroupChatId,
  getTaskLocalGroup,
} from "@/lib/server/feishu-group";

afterEach(() => {
  __setFeishuGroupDepsForTest(null);
});

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    title: "登录优化",
    repoStatus: "in_progress",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: ["/tmp/repo"],
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }) as Task;

const baseDeps = {
  scheduleSelfRegister: () => {},
  decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
};

const noopPersist = async () => undefined;

describe("extractBindChatId", () => {
  it("纯 oc_xxx 直接过", () => {
    expect(extractBindChatId("oc_abc123")).toBe("oc_abc123");
  });
  it("带前后空格 / 整段文本自动提取（恰好一段时）", () => {
    expect(extractBindChatId("  群ID：oc_xyz789，请绑定  ")).toBe("oc_xyz789");
  });
  it("一段文本里有两个 oc_ → 不猜第一个，直接 invalid_input", () => {
    try {
      extractBindChatId("从 oc_old111 换到 oc_new222");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FeishuGroupError);
      expect((err as FeishuGroupError).code).toBe("invalid_input");
    }
  });
  it("找不到 oc_ 开头抛 invalid_input", () => {
    try {
      extractBindChatId("hello world");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FeishuGroupError);
      expect((err as FeishuGroupError).code).toBe("invalid_input");
    }
  });
});

describe("getTaskLocalGroup", () => {
  it("无本地字段 → null", () => {
    expect(getTaskLocalGroup(baseTask())).toBeNull();
  });
  it("空串/空白 → null（当无关联处理）", () => {
    expect(getTaskLocalGroup(baseTask({ feishuGroupChatId: "   " }))).toBeNull();
  });
  it("有值 → 带群名快照一起返回", () => {
    expect(
      getTaskLocalGroup(baseTask({ feishuGroupChatId: "oc_x", feishuGroupChatName: "X群" })),
    ).toEqual({ chatId: "oc_x", chatName: "X群" });
  });
});

describe("bindExistingRequirementGroup（只写本任务本地）", () => {
  it("无旧关联：校验通过后经 persist 落盘，overwritten=false", async () => {
    const fetchGroupType = vi.fn();
    const fetchChatInfo = vi.fn().mockResolvedValue({ chatId: "oc_new", name: "新需求群" });
    const probeSelfInChat = vi.fn().mockResolvedValue(true);
    const persist = vi.fn().mockResolvedValue(undefined);
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType,
      fetchChatInfo,
      probeSelfInChat,
    } as never);
    const r = await bindExistingRequirementGroup(baseTask(), "oc_new", persist);
    expect(r).toMatchObject({
      chatId: "oc_new",
      chatName: "新需求群",
      overwritten: false,
      source: "task",
    });
    expect(r.previousChatId).toBeUndefined();
    expect(persist).toHaveBeenCalledWith("oc_new", "新需求群");
    // 工作项连读都不读（只看本任务本地）
    expect(fetchGroupType).not.toHaveBeenCalled();
  });

  it("同群重复绑：零飞书调用、不写任何东西、overwritten=false", async () => {
    const fetchChatInfo = vi.fn();
    const probeSelfInChat = vi.fn();
    const persist = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo,
      probeSelfInChat,
    } as never);
    const r = await bindExistingRequirementGroup(
      baseTask({ feishuGroupChatId: "oc_same" }),
      "  oc_same  ",
      persist,
    );
    expect(r).toMatchObject({ chatId: "oc_same", overwritten: false });
    expect(fetchChatInfo).not.toHaveBeenCalled();
    expect(probeSelfInChat).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("覆盖旧的本地关联：返回 overwritten + previousChatId（旧的本地 id）", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => true,
    } as never);
    const r = await bindExistingRequirementGroup(
      baseTask({ feishuGroupChatId: "oc_old" }),
      "oc_new",
      persist,
    );
    expect(r.overwritten).toBe(true);
    expect(r.previousChatId).toBe("oc_old");
    expect(persist).toHaveBeenCalledWith("oc_new", "新群");
  });

  it("目标群不存在 → invalid_input，不落盘", async () => {
    const persist = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => {
        throw new LarkApiError("chat not found", { api: "api GET /open-apis/im/v1/chats/oc_gone" });
      },
      probeSelfInChat: async () => true,
    } as never);
    await expect(
      bindExistingRequirementGroup(baseTask(), "oc_gone", persist),
    ).rejects.toMatchObject({
      name: "FeishuGroupError",
      code: "invalid_input",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("读群信息报 bot 不在群（230002）→ bot_not_in_group（带 bot 名）", async () => {
    const persist = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => {
        throw new LarkApiError("The bot can not be outside the group", {
          api: "api GET /open-apis/im/v1/chats/oc_new",
          code: "230002",
        });
      },
      probeSelfInChat: async () => true,
      getBotName: async () => "Flowship测试机器人",
    } as never);
    const err = await bindExistingRequirementGroup(baseTask(), "oc_new", persist).catch((e) => e);
    expect(err).toBeInstanceOf(FeishuGroupError);
    expect(err.code).toBe("bot_not_in_group");
    expect(err.botLabel).toBe("Flowship测试机器人");
    expect(persist).not.toHaveBeenCalled();
  });

  it("本人在不在群查不出（网络抖）→ membershipUnknown 照常绑", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("Access denied", {});
      },
    } as never);
    const r = await bindExistingRequirementGroup(baseTask(), "oc_new", persist);
    expect(r.membershipUnknown).toBe(true);
    expect(persist).toHaveBeenCalled();
  });

  it("本人不在目标群 → owner_not_in_group 直接拦，不落盘", async () => {
    const persist = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => false,
    } as never);
    await expect(
      bindExistingRequirementGroup(baseTask(), "oc_new", persist),
    ).rejects.toMatchObject({ code: "owner_not_in_group" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("probe 报缺 scope（permissionViolations）→ 直接抛 lark_permission，不吞成照常绑", async () => {
    const persist = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("field validation failed", {
          api: "api GET /open-apis/im/v1/chats/oc_new/members/is_in_chat",
          permissionViolations: ["im:chat:members:read"],
        });
      },
    } as never);
    const err = await bindExistingRequirementGroup(baseTask(), "oc_new", persist).catch((e) => e);
    expect(err).toBeInstanceOf(FeishuGroupError);
    expect(err.code).toBe("lark_permission");
    expect(persist).not.toHaveBeenCalled();
  });

  it("probe 报 user 未登录（identity missing）→ 直接抛 lark_not_authed", async () => {
    const persist = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("identity missing: run `lark-cli auth login` first", {});
      },
    } as never);
    const err = await bindExistingRequirementGroup(baseTask(), "oc_new", persist).catch((e) => e);
    expect(err).toBeInstanceOf(FeishuGroupError);
    expect(err.code).toBe("lark_not_authed");
    expect(persist).not.toHaveBeenCalled();
  });

  it("persist 失败直接抛（没存住就是没关联上）", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => true,
    } as never);
    await expect(
      bindExistingRequirementGroup(baseTask(), "oc_new", async () => {
        throw new Error("meta 写盘失败");
      }),
    ).rejects.toThrow("meta 写盘失败");
  });

  it("未关联工作项 → no_story（需求群只给需求任务用）", async () => {
    __setFeishuGroupDepsForTest({ ...baseDeps } as never);
    await expect(
      bindExistingRequirementGroup(
        baseTask({ feishuStoryUrl: undefined }),
        "oc_new",
        noopPersist,
      ),
    ).rejects.toMatchObject({ code: "no_story" });
  });
});

describe("getBoundGroupChatId（回流/播报反查口）", () => {
  it("有本地关联、无工作项链接 → 直接返回本地，不抛 no_story", async () => {
    __setFeishuGroupDepsForTest({ ...baseDeps } as never);
    await expect(
      getBoundGroupChatId({ feishuGroupChatId: "oc_local" }),
    ).resolves.toBe("oc_local");
  });
});

describe("hydrateTaskSummary（群回流按摘要扫任务）", () => {
  const metaOf = (over: Partial<TaskMetaV06> = {}): TaskMetaV06 =>
    ({
      id: "t1",
      title: "登录优化",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: ["/tmp/repo"],
      createdAt: 1,
      updatedAt: 2,
      ...over,
    }) as TaskMetaV06;

  it("本地群关联进摘要（缺了回流扫不到）", () => {
    const s = hydrateTaskSummary(
      metaOf({ feishuGroupChatId: "oc_x", feishuGroupChatName: "X群" }),
    );
    expect(s.feishuGroupChatId).toBe("oc_x");
    expect(s.feishuGroupChatName).toBe("X群");
  });

  it("没关联 → 摘要里就是空的", () => {
    const s = hydrateTaskSummary(metaOf());
    expect(s.feishuGroupChatId).toBeUndefined();
  });
});

describe("clearTaskGroupAssociation", () => {
  it("有本地关联 → 清掉并返回旧 id", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const r = await clearTaskGroupAssociation(
      baseTask({ feishuGroupChatId: "oc_old" }),
      clear,
    );
    expect(r).toEqual({ cleared: true, chatId: "oc_old" });
    expect(clear).toHaveBeenCalled();
  });

  it("本来就没有 → cleared=false，什么都不做", async () => {
    const clear = vi.fn();
    const r = await clearTaskGroupAssociation(baseTask(), clear);
    expect(r).toEqual({ cleared: false });
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("describeBoundRequirementGroup", () => {
  it("本任务自带关联优先：工作项连读都不读，source=task", async () => {
    const fetchGroupType = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType,
      fetchChatInfo: async () => ({ chatId: "oc_local", name: "本地群" }),
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(
      baseTask({ feishuGroupChatId: "oc_local" }),
    );
    expect(r).toMatchObject({ chatId: "oc_local", chatName: "本地群", source: "task", ownerStillIn: true });
    expect(fetchGroupType).not.toHaveBeenCalled();
  });

  it("无本地关联 → 回落读项目群，source=project", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_cur" }),
      fetchChatInfo: async () => ({ chatId: "oc_cur", name: "当前群" }),
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(baseTask());
    expect(r).toMatchObject({ chatId: "oc_cur", chatName: "当前群", source: "project", ownerStillIn: true });
  });

  it("两边都没有 → null", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => ({ chatId: "oc_x" }),
      probeSelfInChat: async () => true,
    } as never);
    await expect(describeBoundRequirementGroup(baseTask())).resolves.toBeNull();
  });

  it.each(["", "   "])("本地 id 为空/空白（%j）→ 当无关联走项目群", async (groupId) => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_proj" }),
      fetchChatInfo: async () => ({ chatId: "oc_proj" }),
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(baseTask({ feishuGroupChatId: groupId }));
    expect(r).toMatchObject({ chatId: "oc_proj", source: "project" });
  });

  it("probe 抛错（网络抖）→ membershipUnknown 照常返回", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_cur" }),
      fetchChatInfo: async () => ({ chatId: "oc_cur", name: "当前群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("Command failed", {});
      },
    } as never);
    const r = await describeBoundRequirementGroup(baseTask());
    expect(r).toMatchObject({ chatId: "oc_cur", membershipUnknown: true });
  });

  it("有本地关联但没配工作项链接 → 不抛 no_story，照常返回本地（可看可取消）", async () => {
    const fetchGroupType = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType,
      fetchChatInfo: async () => ({ chatId: "oc_local", name: "本地群" }),
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(
      baseTask({ feishuStoryUrl: undefined, feishuGroupChatId: "oc_local" }),
    );
    expect(r).toMatchObject({ chatId: "oc_local", source: "task" });
    expect(fetchGroupType).not.toHaveBeenCalled();
  });

  it("群已解散返回 unreachable（带 source）", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_dead" }),
      fetchChatInfo: async () => {
        throw new LarkApiError("chat not found", {});
      },
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(baseTask());
    expect(r).toMatchObject({ chatId: "oc_dead", source: "project", unreachable: true });
  });
});
