/**
 * 手动换绑（bindExistingRequirementGroup / describeBoundRequirementGroup / extractBindChatId）。
 * 全部 mock 外部调用——禁止真调飞书 / meegle。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LarkApiError } from "@/lib/server/feishu-bridge/types";
import type { Task } from "@/lib/types";
import {
  __setFeishuGroupDepsForTest,
  bindExistingRequirementGroup,
  describeBoundRequirementGroup,
  extractBindChatId,
  FeishuGroupError,
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

describe("extractBindChatId", () => {
  it("纯 oc_xxx 直接过", () => {
    expect(extractBindChatId("oc_abc123")).toBe("oc_abc123");
  });
  it("带前后空格 / 整段文本自动提取", () => {
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

describe("bindExistingRequirementGroup", () => {
  it("无旧绑定：校验通过后 bind 并返回 overwritten=false", async () => {
    const fetchGroupType = vi.fn().mockResolvedValue({ value: "disabled" });
    const fetchChatInfo = vi.fn().mockResolvedValue({ chatId: "oc_new", name: "新需求群" });
    const probeSelfInChat = vi.fn().mockResolvedValue(true);
    const bindGroup = vi.fn().mockResolvedValue(undefined);
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType,
      fetchChatInfo,
      probeSelfInChat,
      bindGroup,
    } as never);
    const r = await bindExistingRequirementGroup(baseTask(), "oc_new");
    expect(r.chatId).toBe("oc_new");
    expect(r.chatName).toBe("新需求群");
    expect(r.overwritten).toBe(false);
    expect(r.previousChatId).toBeUndefined();
    expect(bindGroup).toHaveBeenCalledWith("10001", "space", "oc_new");
  });

  it("同群重复绑：零飞书调用、不写 meegle、overwritten=false", async () => {
    const fetchGroupType = vi.fn().mockResolvedValue({ value: "bind", groupId: "oc_same" });
    // 短路放最前：连读群信息/查本人在群都不该跑（机器人不在群也不该误报）
    const fetchChatInfo = vi.fn();
    const probeSelfInChat = vi.fn();
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType,
      fetchChatInfo,
      probeSelfInChat,
      bindGroup,
    } as never);
    const r = await bindExistingRequirementGroup(baseTask(), "  oc_same  ");
    expect(r).toMatchObject({ chatId: "oc_same", overwritten: false });
    expect(fetchChatInfo).not.toHaveBeenCalled();
    expect(probeSelfInChat).not.toHaveBeenCalled();
    expect(bindGroup).not.toHaveBeenCalled();
  });

  it("读群信息报 bot 不在群（230002）→ bot_not_in_group（带 bot 名）", async () => {
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => {
        throw new LarkApiError("The bot can not be outside the group", {
          api: "api GET /open-apis/im/v1/chats/oc_new",
          code: "230002",
        });
      },
      probeSelfInChat: async () => true,
      bindGroup,
      getBotName: async () => "Flowship测试机器人",
    } as never);
    const err = await bindExistingRequirementGroup(baseTask(), "oc_new").catch((e) => e);
    expect(err).toBeInstanceOf(FeishuGroupError);
    expect(err.code).toBe("bot_not_in_group");
    expect(err.botLabel).toBe("Flowship测试机器人");
    expect(bindGroup).not.toHaveBeenCalled();
  });

  it("probe 报缺 scope（permissionViolations）→ 直接抛 lark_permission，不吞成照常绑", async () => {
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("field validation failed", {
          api: "api GET /open-apis/im/v1/chats/oc_new/members/is_in_chat",
          permissionViolations: ["im:chat:members:read"],
        });
      },
      bindGroup,
    } as never);
    const err = await bindExistingRequirementGroup(baseTask(), "oc_new").catch((e) => e);
    expect(err).toBeInstanceOf(FeishuGroupError);
    expect(err.code).toBe("lark_permission");
    expect(bindGroup).not.toHaveBeenCalled();
  });

  it("probe 报 user 未登录（identity missing）→ 直接抛 lark_not_authed", async () => {
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("identity missing: run `lark-cli auth login` first", {});
      },
      bindGroup,
    } as never);
    const err = await bindExistingRequirementGroup(baseTask(), "oc_new").catch((e) => e);
    expect(err).toBeInstanceOf(FeishuGroupError);
    expect(err.code).toBe("lark_not_authed");
    expect(bindGroup).not.toHaveBeenCalled();
  });

  it("覆盖旧绑定：返回 overwritten + previousChatId", async () => {
    const fetchGroupType = vi.fn().mockResolvedValue({ value: "bind", groupId: "oc_old" });
    const fetchChatInfo = vi.fn().mockResolvedValue({ chatId: "oc_new", name: "新群" });
    const probeSelfInChat = vi.fn().mockResolvedValue(true);
    const bindGroup = vi.fn().mockResolvedValue(undefined);
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType,
      fetchChatInfo,
      probeSelfInChat,
      bindGroup,
    } as never);
    const r = await bindExistingRequirementGroup(baseTask(), "oc_new");
    expect(r.overwritten).toBe(true);
    expect(r.previousChatId).toBe("oc_old");
  });

  it("目标群不存在 → invalid_input", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => {
        throw new LarkApiError("chat not found", { api: "api GET /open-apis/im/v1/chats/oc_gone" });
      },
      probeSelfInChat: async () => true,
      bindGroup: vi.fn(),
    } as never);
    await expect(bindExistingRequirementGroup(baseTask(), "oc_gone")).rejects.toMatchObject({
      name: "FeishuGroupError",
      code: "invalid_input",
    });
  });

  it("本人在不在群查不出 → membershipUnknown 照常绑", async () => {
    const bindGroup = vi.fn().mockResolvedValue(undefined);
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("Access denied", {});
      },
      bindGroup,
    } as never);
    const r = await bindExistingRequirementGroup(baseTask(), "oc_new");
    expect(r.membershipUnknown).toBe(true);
    expect(bindGroup).toHaveBeenCalled();
  });

  it("本人不在目标群 → owner_not_in_group 直接拦，不写 bind", async () => {
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
      probeSelfInChat: async () => false,
      bindGroup,
    } as never);
    await expect(bindExistingRequirementGroup(baseTask(), "oc_new")).rejects.toMatchObject({
      code: "owner_not_in_group",
    });
    expect(bindGroup).not.toHaveBeenCalled();
  });
});

describe("describeBoundRequirementGroup", () => {
  it("无绑定返回 null", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      fetchChatInfo: async () => ({ chatId: "oc_x" }),
      probeSelfInChat: async () => true,
    } as never);
    await expect(describeBoundRequirementGroup(baseTask())).resolves.toBeNull();
  });

  it("有绑定：返回群名 + 本人在群", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_cur" }),
      fetchChatInfo: async () => ({ chatId: "oc_cur", name: "当前群" }),
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(baseTask());
    expect(r).toMatchObject({ chatId: "oc_cur", chatName: "当前群", ownerStillIn: true });
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

  it("群已解散返回 unreachable", async () => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_dead" }),
      fetchChatInfo: async () => {
        throw new LarkApiError("chat not found", {});
      },
      probeSelfInChat: async () => true,
    } as never);
    const r = await describeBoundRequirementGroup(baseTask());
    expect(r).toMatchObject({ chatId: "oc_dead", unreachable: true });
  });

  it.each(["", "   "])("groupId 为空/空白（%j）→ 当无绑定返 null", async (groupId) => {
    __setFeishuGroupDepsForTest({
      ...baseDeps,
      fetchGroupType: async () => ({ value: "bind", groupId }),
      fetchChatInfo: async () => ({ chatId: "oc_x" }),
      probeSelfInChat: async () => true,
    } as never);
    await expect(describeBoundRequirementGroup(baseTask())).resolves.toBeNull();
  });
});

describe("空 groupId 边界", () => {
  it("bind 把空/空白 groupId 当无旧绑定：overwritten=false", async () => {
    for (const groupId of ["", "   "]) {
      const bindGroup = vi.fn().mockResolvedValue(undefined);
      __setFeishuGroupDepsForTest({
        ...baseDeps,
        fetchGroupType: async () => ({ value: "bind", groupId }),
        fetchChatInfo: async () => ({ chatId: "oc_new", name: "新群" }),
        probeSelfInChat: async () => true,
        bindGroup,
      } as never);
      const r = await bindExistingRequirementGroup(baseTask(), "oc_new");
      expect(r.overwritten).toBe(false);
      expect(r.previousChatId).toBeUndefined();
      expect(bindGroup).toHaveBeenCalled();
    }
  });
});
