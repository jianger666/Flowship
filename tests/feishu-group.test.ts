/**
 * feishu-group：幂等查群 / 建群 bind（含按注册表拉人拉 bot）/ 并发双建收敛 /
 * bot 不在群引导。全部 mock 外部调用——禁止真调飞书建群 / 发消息。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LarkAuthStatus } from "@/lib/server/feishu-bridge/lark-api";
import { LarkApiError } from "@/lib/server/feishu-bridge/types";
import type { Task } from "@/lib/types";
import {
  __setFeishuGroupDepsForTest,
  buildShareCardJson,
  buildShareDocFilename,
  ensureRequirementGroup,
  FeishuGroupError,
  type FeishuGroupDeps,
  isBotNotInGroupSendError,
  resolveBotDisplayLabel,
  shareToRequirementGroup,
  composePostShareMarkdown,
  truncateShareContent,
} from "@/lib/server/feishu-group";
import {
  buildSelectionShareInput,
  prepareShareContent,
} from "@/lib/share-to-group";
import {
  emptyGroupMemberRegistry,
  GROUP_MEMBERS_VERSION,
  type GroupMemberRegistry,
} from "@/lib/server/feishu-group-registry";

afterEach(() => {
  __setFeishuGroupDepsForTest(null);
});

/**
 * 建群路径的注册表相关依赖默认桩：无角色成员 + 空注册表 = 老行为（只拉发起人）。
 * 不桩的话默认实现会真去打 meegle。
 */
const noRegistryDeps = {
  fetchRoleMemberEmails: async () => [],
  readMemberRegistry: async () => emptyGroupMemberRegistry(),
  scheduleSelfRegister: () => {},
};

const registryOf = (
  members: GroupMemberRegistry["members"],
): GroupMemberRegistry => ({ version: GROUP_MEMBERS_VERSION, members });

/**
 * kind=artifact 会在卡片之后再发一条 md 文件消息——不桩的话默认实现会真去落临时盘 +
 * 起 lark-cli。凡是分享整份产物的用例都要带上这个桩。
 */
const stubDoc = () =>
  vi.fn().mockResolvedValue({ chat_id: "oc_x", message_id: "om_doc" });

type CardElement = Record<string, unknown> & { tag?: string };

/** 取卡片 body.elements（断言 element_id / 按钮结构用） */
const collectElements = (card: Record<string, unknown>): CardElement[] =>
  ((card.body as { elements?: CardElement[] })?.elements ?? []);

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

describe("ensureRequirementGroup", () => {
  it("幂等查群：已有 bind group_id → 直接返回 created=false", async () => {
    const fetchGroupType = vi.fn().mockResolvedValue({
      value: "bind",
      groupId: "oc_exist",
    });
    const createChat = vi.fn();
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType,
      createChat,
      bindGroup,
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r).toEqual({ chatId: "oc_exist", created: false });
    expect(createChat).not.toHaveBeenCalled();
    expect(bindGroup).not.toHaveBeenCalled();
  });

  it("注册表没人命中：建群只拉发起人本人、不带 bot_id_list", async () => {
    const warnings: string[] = [];
    const fetchGroupType = vi
      .fn()
      .mockResolvedValueOnce({ value: "disabled" })
      .mockResolvedValueOnce({ value: "disabled" })
      // 第三次 = bind 后回读（meegle 写失败不报错，只能靠回读发现）
      .mockResolvedValueOnce({ value: "bind", groupId: "oc_mine" });
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_mine" });
    const bindGroup = vi.fn().mockResolvedValue(undefined);
    const fetchWorkitemName = vi.fn().mockResolvedValue("登录优化");

    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType,
      createChat,
      bindGroup,
      fetchWorkitemName,
      warn: (m) => warnings.push(m),
      getBotInfo: async () => ({
        appId: "cli_self",
        ownerOpenId: "ou_me",
        appName: "我的Bot",
      }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r).toEqual({
      chatId: "oc_mine",
      created: true,
      // 新建群的名字是本机拼的 → 回执直接带上，不用再查一次
      chatName: "登录优化需求群",
    });
    // 没人命中注册表 → 不塞空的 bot_id_list（载荷保持干净）
    expect(createChat).toHaveBeenCalledWith({
      name: "登录优化需求群",
      userIdList: ["ou_me"],
    });
    expect(bindGroup).toHaveBeenCalledWith("10001", "space", "oc_mine");
    // 回读对上了就不该有告警
    expect(warnings).toEqual([]);
  });

  // 免审 scope 下 open_id 换不出来 → 只能靠「每人自动注册 email→open_id/app_id」这张
  // 共享表；建群是唯一能带人 / 带 bot 的时机，命中的必须一次带齐
  it("注册表命中：同应用成员的 open_id 进名单、跨应用成员只加 bot 并留痕", async () => {
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_team" });
    const warnings: string[] = [];
    const fetchRoleMemberEmails = vi
      .fn()
      .mockResolvedValue(["dev@x.com", "QA@x.com", "pm@x.com"]);

    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchRoleMemberEmails,
      readMemberRegistry: async () =>
        registryOf({
          "dev@x.com": { openId: "ou_dev", botAppId: "cli_dev", updatedAt: 1 },
          // qa 与发起人同应用（cli_self）→ open_id 可进 user_id_list
          "qa@x.com": { openId: "ou_qa", botAppId: "cli_self", updatedAt: 1 },
          // pm 没配 bot、无法确认 open_id 所属应用 → 跳过本人
          "pm@x.com": { openId: "ou_pm", botAppId: "", updatedAt: 1 },
        }),
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "bind", groupId: "oc_team" }),
      createChat,
      bindGroup: async () => undefined,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      warn: (m) => warnings.push(m),
    });

    await ensureRequirementGroup(baseTask());
    expect(fetchRoleMemberEmails).toHaveBeenCalledWith("10001", "space");
    expect(createChat).toHaveBeenCalledWith({
      name: "登录优化需求群",
      // 发起人首位 + 同应用 qa；dev / pm 跨应用 / 无法确认 → 只加 bot 或不加
      userIdList: ["ou_me", "ou_qa"],
      // 本机 bot 建群自动入群、不占 ≤5 额度
      botIdList: ["cli_dev"],
    });
    expect(warnings.some((w) => w.includes("跨应用"))).toBe(true);
  });

  it("注册表部分未命中：未注册的跳过留痕；跨应用的只加 bot 不拉本人（不报错）", async () => {
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_part" });
    const warnings: string[] = [];

    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchRoleMemberEmails: async () => ["dev@x.com", "stranger@x.com"],
      readMemberRegistry: async () =>
        registryOf({
          "dev@x.com": { openId: "ou_dev", botAppId: "cli_dev", updatedAt: 1 },
        }),
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "bind", groupId: "oc_part" }),
      createChat,
      bindGroup: async () => undefined,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      warn: (m) => warnings.push(m),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r.created).toBe(true);
    expect(createChat).toHaveBeenCalledWith({
      name: "登录优化需求群",
      // dev 的 open_id 属于 cli_dev（≠ cli_self）→ 跨应用跳过本人
      userIdList: ["ou_me"],
      botIdList: ["cli_dev"],
    });
    expect(warnings.some((w) => w.includes("stranger@x.com"))).toBe(true);
    expect(warnings.some((w) => w.includes("跨应用"))).toBe(true);
  });

  it("角色查询挂 / 注册表读不出 → 降级只拉发起人，绝不挡住建群", async () => {
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_degraded" });
    const warnings: string[] = [];

    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchRoleMemberEmails: async () => {
        throw new Error("meegle CLI 未安装");
      },
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "bind", groupId: "oc_degraded" }),
      createChat,
      bindGroup: async () => undefined,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      warn: (m) => warnings.push(m),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r).toEqual({
      chatId: "oc_degraded",
      created: true,
      chatName: "登录优化需求群",
    });
    expect(createChat).toHaveBeenCalledWith({
      name: "登录优化需求群",
      userIdList: ["ou_me"],
    });
    expect(warnings.some((w) => w.includes("只拉发起人"))).toBe(true);
  });

  it("用到群协作就后台自动注册本机身份（fire-and-forget、不阻塞）", async () => {
    const scheduleSelfRegister = vi.fn();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      scheduleSelfRegister,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    });

    await ensureRequirementGroup(baseTask());
    expect(scheduleSelfRegister).toHaveBeenCalled();
  });

  // meegle workitem update 对写失败一声不吭（2026-07-27 实测：畸形 group_id 也返回
  // `{"mcp_result":""}`）→ 不回读的话每次分享都会再建一个进不去的孤儿群
  it("bind 静默没写进去：回读发现后告警、但不挡本次分享", async () => {
    const warnings: string[] = [];
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" }),
      createChat: async () => ({ chat_id: "oc_mine" }),
      bindGroup: async () => undefined,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      warn: (m) => warnings.push(m),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r).toEqual({
      chatId: "oc_mine",
      created: true,
      chatName: "登录优化需求群",
    });
    expect(warnings.some((w) => w.includes("bind 回读未生效"))).toBe(true);
  });

  // bind 抛错时若把异常冒上去：用户看到「分享失败」→ 重试 → 又建一个群 → 攒孤儿群
  it("bind 抛错：群已建好就照常返回（吞错 + 告警，绝不丢已建的群）", async () => {
    const warnings: string[] = [];
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_mine" });
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" }),
      createChat,
      bindGroup: async () => {
        throw new Error("meegle 超时");
      },
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      warn: (m) => warnings.push(m),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r).toEqual({
      chatId: "oc_mine",
      created: true,
      chatName: "登录优化需求群",
    });
    // 后果讲清楚：下次分享读不到绑定会再建一个
    expect(
      warnings.some((w) => w.includes("bind 失败") && w.includes("再建一个群")),
    ).toBe(true);
  });

  // 自动播报的准入闸第二半：预筛之后、真建群之前群可能已被解绑（TOCTOU）
  it("allowCreate=false + 没群 → 抛 no_group、绝不 createChat", async () => {
    const createChat = vi.fn();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: async () => ({ value: "disabled" }),
      createChat,
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    });

    await expect(
      ensureRequirementGroup(baseTask(), { allowCreate: false }),
    ).rejects.toMatchObject({ code: "no_group" });
    expect(createChat).not.toHaveBeenCalled();
  });

  it("allowCreate=false + 已有群 → 照常返回（只是不建新的）", async () => {
    const createChat = vi.fn();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
      createChat,
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    });

    expect(
      await ensureRequirementGroup(baseTask(), { allowCreate: false }),
    ).toEqual({ chatId: "oc_exist", created: false });
    expect(createChat).not.toHaveBeenCalled();
  });

  it("并发双建收敛：bind 前发现别人已 bind → 用别人的群", async () => {
    const warnings: string[] = [];
    const fetchGroupType = vi
      .fn()
      .mockResolvedValueOnce({ value: "disabled" })
      .mockResolvedValueOnce({
        value: "bind",
        groupId: "oc_theirs",
      });
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_orphan" });
    const bindGroup = vi.fn();

    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType,
      createChat,
      bindGroup,
      fetchWorkitemName: async () => "需求A",
      getBotInfo: async () => ({
        appId: "cli_self",
        ownerOpenId: "ou_me",
      }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
      warn: (m) => warnings.push(m),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r).toEqual({ chatId: "oc_theirs", created: false });
    expect(bindGroup).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes("oc_orphan"))).toBe(true);
  });

  it("拿不到发起人 open_id → 人也不带、照样建群（不因此挡住分享）", async () => {
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_solo" });
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" }),
      createChat,
      bindGroup: vi.fn().mockResolvedValue(undefined),
      fetchWorkitemName: async () => "Solo",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "" }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
    });

    const r = await ensureRequirementGroup(baseTask());
    expect(r.created).toBe(true);
    expect(createChat).toHaveBeenCalledWith({
      name: "Solo需求群",
      userIdList: [],
    });
  });

  it("工作项名取不到 → 群名回落 task.title", async () => {
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_t" });
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" }),
      createChat,
      bindGroup: vi.fn().mockResolvedValue(undefined),
      fetchWorkitemName: async () => undefined,
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
    });

    await ensureRequirementGroup(baseTask());
    expect(createChat).toHaveBeenCalledWith({
      name: "登录优化需求群",
      userIdList: ["ou_me"],
    });
  });
});

// 真实 P0（2026-07-28 用户实测）：用户退了那个需求群，工作项上的 bind 还指着它、
// bot 也还在里面 → 卡片发得出去 → 前端提示「分享成功」→ 用户什么都看不到。
// 事后判定在这里失效（发送成功恰恰是症状），所以复用绑定前必须先问一句「我还在不在」。
describe("死绑定检测（本人已不在需求群）", () => {
  /** 已绑定 oc_dead 的工作项 + 一套够跑完分享的桩 */
  const boundDeps = (over: Partial<FeishuGroupDeps> = {}) => {
    const sendCard = vi.fn().mockResolvedValue({
      chat_id: "oc_dead",
      message_id: "om_1",
      card_id: "c1",
    });
    const createChat = vi.fn();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      sendDoc: stubDoc(),
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_dead" }),
      fetchWorkitemName: async () => "登录优化",
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      resolveSenderName: async () => "测试用户",
      createChat,
      sendCard,
      ...over,
    });
    return { sendCard, createChat };
  };

  const shareOnce = () =>
    shareToRequirementGroup(
      baseTask(),
      { kind: "message", content: "正文" },
      { verifyOwnerMembership: true },
    );

  it("本人已退群 → owner_not_in_group（带群名和 chatId），且一张卡都不发", async () => {
    const { sendCard } = boundDeps({
      fetchChatInfo: async () => ({ chatId: "oc_dead", name: "测试需求需求群" }),
      probeSelfInChat: async () => false,
    });

    await expect(shareOnce()).rejects.toMatchObject({
      name: "FeishuGroupError",
      code: "owner_not_in_group",
      chatId: "oc_dead",
      chatName: "测试需求需求群",
    });
    // 关键：绝不能「照发 + 报成功」——那正是用户撞到的 P0
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("本人还在群 → 照常发，回执带真实群名", async () => {
    const { sendCard } = boundDeps({
      fetchChatInfo: async () => ({ chatId: "oc_dead", name: "登录优化需求群" }),
      probeSelfInChat: async () => true,
    });

    await expect(shareOnce()).resolves.toMatchObject({
      chatId: "oc_dead",
      chatName: "登录优化需求群",
      created: false,
    });
    expect(sendCard).toHaveBeenCalled();
  });

  // 免审 scope 下这两个接口能不能用还没有实测结论 → 查不出来时**不猜**：
  // 照常发（绝不因为查不了就把正常分享挡掉），只把不确定性透到回执 + 日志
  it("查不出本人在不在群 → 照常发 + membershipUnknown + 留痕", async () => {
    const warnings: string[] = [];
    const { sendCard } = boundDeps({
      fetchChatInfo: async () => ({ chatId: "oc_dead", name: "登录优化需求群" }),
      probeSelfInChat: async () => {
        throw new LarkApiError("Access denied", { code: 99991672 });
      },
      warn: (m) => warnings.push(m),
    });

    await expect(shareOnce()).resolves.toMatchObject({
      chatId: "oc_dead",
      membershipUnknown: true,
    });
    expect(sendCard).toHaveBeenCalled();
    expect(warnings.some((w) => w.includes("没查出本人"))).toBe(true);
  });

  // 群内推进回执 / 自动播报的读者是**群里的人**，属主在不在不影响该不该发；
  // 而且它们跑在热路径 / 后台，不该白付两次 CLI 往返
  it("不开 verifyOwnerMembership（播报 / 群内推进）→ 探针一次都不调", async () => {
    const fetchChatInfo = vi.fn();
    const probeSelfInChat = vi.fn();
    boundDeps({ fetchChatInfo, probeSelfInChat });

    await expect(
      shareToRequirementGroup(baseTask(), { kind: "message", content: "正文" }),
    ).resolves.toMatchObject({ chatId: "oc_dead" });
    expect(fetchChatInfo).not.toHaveBeenCalled();
    expect(probeSelfInChat).not.toHaveBeenCalled();
  });

  it("群已解散（飞书明说这个群不存在）→ group_unreachable", async () => {
    boundDeps({
      fetchChatInfo: async () => {
        throw new LarkApiError("chat not found");
      },
      probeSelfInChat: async () => true,
    });

    await expect(shareOnce()).rejects.toMatchObject({
      code: "group_unreachable",
      chatId: "oc_dead",
    });
  });

  // 读群名失败的原因还有缺 scope / 网络抖——误判成「群没了」就是诱导用户白建一个群
  it.each([
    [
      "缺 scope",
      new LarkApiError("Access denied", {
        code: 99991672,
        permissionViolations: ["im:chat:readonly"],
      }),
    ],
    ["网络抖", new LarkApiError("Command failed", { raw: { stderr: "EOF" } })],
  ])("读群名失败（%s）→ 不判死，照常发、只是回执少个群名", async (_label, err) => {
    const { sendCard } = boundDeps({
      fetchChatInfo: async () => {
        throw err;
      },
      probeSelfInChat: async () => true,
    });

    const r = await shareOnce();
    expect(r.chatName).toBeUndefined();
    expect(sendCard).toHaveBeenCalled();
  });
});

// 用户现在完全卡死：死绑定会让每次分享都静默发进他看不见的群，必须有重建出口
describe("重建需求群（recreateFrom）", () => {
  it("确认重建 → 跳过复用、建新群、bind 覆盖；二次读到的老绑定不把它收敛回去", async () => {
    const warnings: string[] = [];
    // 三次读 group_type：入口 / bind 前防并发 / bind 后回读——全都还是那条死绑定
    const fetchGroupType = vi
      .fn()
      .mockResolvedValueOnce({ value: "bind", groupId: "oc_dead" })
      .mockResolvedValueOnce({ value: "bind", groupId: "oc_dead" })
      .mockResolvedValueOnce({ value: "bind", groupId: "oc_fresh" });
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_fresh" });
    const bindGroup = vi.fn().mockResolvedValue(undefined);
    const probeSelfInChat = vi.fn();

    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType,
      createChat,
      bindGroup,
      probeSelfInChat,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      warn: (m) => warnings.push(m),
    });

    const r = await ensureRequirementGroup(baseTask(), {
      verifyOwnerMembership: true,
      recreateFrom: "oc_dead",
    });

    expect(r).toEqual({
      chatId: "oc_fresh",
      created: true,
      chatName: "登录优化需求群",
    });
    expect(bindGroup).toHaveBeenCalledWith("10001", "space", "oc_fresh");
    // 用户已经确认过了，别再问一遍「你在不在那个群」
    expect(probeSelfInChat).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes("按用户确认重建"))).toBe(true);
  });

  // 别人在这期间换了群 → 那是一条**新**绑定，该正常校验复用，不该白建一个
  it("绑定已被换成别的群（recreateFrom 对不上）→ 不重建、走正常校验", async () => {
    const createChat = vi.fn();
    const probeSelfInChat = vi.fn().mockResolvedValue(true);
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_other" }),
      createChat,
      probeSelfInChat,
      fetchChatInfo: async () => ({ chatId: "oc_other", name: "新需求群" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    });

    const r = await ensureRequirementGroup(baseTask(), {
      verifyOwnerMembership: true,
      recreateFrom: "oc_dead",
    });

    expect(r).toEqual({
      chatId: "oc_other",
      created: false,
      chatName: "新需求群",
    });
    expect(createChat).not.toHaveBeenCalled();
    expect(probeSelfInChat).toHaveBeenCalledWith("oc_other");
  });

  // 重建过程中真有别人抢先建好并 bind 了另一个群 → 那条并发收敛照旧生效
  it("重建期间别人抢先 bind 了另一个群 → 仍收敛到别人的群", async () => {
    const fetchGroupType = vi
      .fn()
      .mockResolvedValueOnce({ value: "bind", groupId: "oc_dead" })
      .mockResolvedValueOnce({ value: "bind", groupId: "oc_theirs" });
    const bindGroup = vi.fn();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType,
      createChat: async () => ({ chat_id: "oc_orphan" }),
      bindGroup,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    });

    const r = await ensureRequirementGroup(baseTask(), {
      verifyOwnerMembership: true,
      recreateFrom: "oc_dead",
    });
    expect(r).toEqual({ chatId: "oc_theirs", created: false });
    expect(bindGroup).not.toHaveBeenCalled();
  });
});

describe("bot 不在群判定 / shareToRequirementGroup", () => {
  it("isBotNotInGroupSendError：230002 一族错误码命中、报文关键词兜底、无关错误不命中", () => {
    // 码优先：number / string 形态都认
    expect(
      isBotNotInGroupSendError(new LarkApiError("x", { code: 230002 })),
    ).toBe(true);
    expect(
      isBotNotInGroupSendError(new LarkApiError("x", { code: "230035" })),
    ).toBe(true);
    // CLI 偶尔丢 code → 按官方报文关键词兜底
    expect(
      isBotNotInGroupSendError(
        new LarkApiError("The bot can not be outside the group"),
      ),
    ).toBe(true);
    // 无关错误码（如消息体超长 230025）不误判
    expect(
      isBotNotInGroupSendError(
        new LarkApiError("message too long", { code: 230025 }),
      ),
    ).toBe(false);
    // 非 LarkApiError 一律 false
    expect(isBotNotInGroupSendError(new Error("boom"))).toBe(false);
  });

  it("后来者 bot 不在群：发卡报 230002 → bot_not_in_group 带 bot/v3/info 的准确名字", async () => {
    __setFeishuGroupDepsForTest({
      fetchGroupType: async () => ({
        value: "bind",
        groupId: "oc_exist",
      }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
      fetchWorkitemName: async () => "登录优化",
      resolveSenderName: async () => "测试用户",
      // 有真名时就不该退 app_id
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      getBotName: async () => "Flowship·甲",
      sendCard: vi.fn().mockRejectedValue(
        new LarkApiError("The bot can not be outside the group", {
          code: 230002,
        }),
      ),
    });

    await expect(
      shareToRequirementGroup(baseTask(), {
        kind: "message",
        content: "hello",
      }),
    ).rejects.toMatchObject({
      code: "bot_not_in_group",
      message: expect.stringContaining("Flowship·甲"),
      botLabel: "Flowship·甲",
      chatId: "oc_exist",
    });
  });

  // 2026-07-27：分享挂在「field validation failed」上、服务端不留痕、toast 也只有这一句，
  // 完全没法定位是哪次调用哪个字段——错误必须把 code / 命令 / log_id 一起带出来
  it("飞书报错把 code / 命令 / log_id 一起透给前端", async () => {
    __setFeishuGroupDepsForTest({
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      fetchWorkitemName: async () => "登录优化",
      resolveSenderName: async () => "测试用户",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      sendCard: vi.fn().mockRejectedValue(
        new LarkApiError("field validation failed", {
          code: 99992402,
          api: "api GET /open-apis/im/v1/chats/oc_exist/members",
          fieldViolations: [{ field: "member_id_type" }],
          logId: "20260727150651E0B86CE612204C29D019",
        }),
      ),
    });

    await expect(
      shareToRequirementGroup(baseTask(), { kind: "message", content: "x" }),
    ).rejects.toMatchObject({
      code: "lark_error",
      message: expect.stringContaining("99992402"),
    });
  });

  it("发卡挂在无关错误上 → 照旧 lark_error、不误导用户去加 bot", async () => {
    __setFeishuGroupDepsForTest({
      fetchGroupType: async () => ({
        value: "bind",
        groupId: "oc_exist",
      }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
      fetchWorkitemName: async () => "登录优化",
      resolveSenderName: async () => "测试用户",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      sendCard: vi
        .fn()
        .mockRejectedValue(
          new LarkApiError("消息体长度超出限制", { code: 230025 }),
        ),
    });

    await expect(
      shareToRequirementGroup(baseTask(), {
        kind: "message",
        content: "hello",
      }),
    ).rejects.toMatchObject({
      code: "lark_error",
      message: expect.stringContaining("消息体长度超出限制"),
    });
  });

  // 真名的降级链本身在 lark-api.getBotDisplayName（另有单测）；
  // 这里只验名字彻底拿不到时的最后两级
  it("bot 名降级：拿不到真名 → 退 app_id → 再退泛称", async () => {
    // 名字这一级抛错也不能把引导弹窗拖挂：退 app_id
    __setFeishuGroupDepsForTest({
      getBotName: async () => {
        throw new Error("bot/v3/info 500");
      },
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
    });
    await expect(resolveBotDisplayLabel()).resolves.toBe("cli_self");

    // 名字为空同理 → app_id（搜不到人、但能在开放平台对上号）
    __setFeishuGroupDepsForTest({
      getBotName: async () => null,
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
    });
    await expect(resolveBotDisplayLabel()).resolves.toBe("cli_self");

    // 全挂：只能给泛称
    __setFeishuGroupDepsForTest({
      getBotName: async () => null,
      getBotInfo: async () => {
        throw new Error("lark-cli 未登录");
      },
    });
    await expect(resolveBotDisplayLabel()).resolves.toBe("你的机器人");
  });

  it("建群人分享直接发卡（无任何事前 bot 检测）", async () => {
    const sendCard = vi.fn().mockResolvedValue({
      chat_id: "oc_new",
      message_id: "om_1",
      card_id: "c1",
    });
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      sendDoc: stubDoc(),
      fetchGroupType: vi
        .fn()
        .mockResolvedValueOnce({ value: "disabled" })
        .mockResolvedValueOnce({ value: "disabled" }),
      createChat: async () => ({ chat_id: "oc_new" }),
      bindGroup: async () => undefined,
      fetchWorkitemName: async () => "需求B",
      getBotInfo: async () => ({
        appId: "cli_self",
        ownerOpenId: "ou_me",
        appName: "Bot",
      }),
      decodeUrl: async () => ({
        workItemId: "10001",
        simpleName: "space",
      }),
      sendCard,
      resolveSenderName: async () => "测试用户",
    });

    const r = await shareToRequirementGroup(baseTask(), {
      kind: "artifact",
      title: "方案",
      content: "正文内容",
      links: [{ label: "MR", url: "https://example.com/mr/1" }],
    });
    expect(r).toEqual({
      chatId: "oc_new",
      messageId: "om_1",
      created: true,
      // 回执带群名：前端 toast 说清「发到哪个群了」
      chatName: "需求B需求群",
      // artifact 分享同时发了正文 md 文件
      docMessageId: "om_doc",
    });
    expect(sendCard).toHaveBeenCalled();
    const cardArg = sendCard.mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(cardArg)).toContain("测试用户");
    expect(JSON.stringify(cardArg)).toContain("查看工作项");
  });

  it("缺飞书链接 → no_story", async () => {
    await expect(
      shareToRequirementGroup(baseTask({ feishuStoryUrl: undefined }), {
        kind: "message",
        content: "x",
      }),
    ).rejects.toBeInstanceOf(FeishuGroupError);
  });
});

// 2026-07-27 用户拍板的内容形态：整份产物 = 瘦卡片（身份信息）+ 一条 md 文件（全文）
describe("整份产物：卡片 + md 文件两条消息", () => {
  /** 已有群的分享路径公共桩；调用方只补 sendCard / sendDoc */
  const sharedGroupDeps = (): Partial<FeishuGroupDeps> => ({
    fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
    decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    fetchWorkitemName: async () => "登录优化",
    resolveSenderName: async () => "测试用户",
    getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
    scheduleSelfRegister: () => {},
  });

  it("先卡片后文件：文件名 = 需求名-标题.md、正文全文不截断", async () => {
    // 调用顺序要能断言——卡片先到位（群里先有上下文），文件紧随其后
    const order: string[] = [];
    const sendCard = vi.fn().mockImplementation(async () => {
      order.push("card");
      return { chat_id: "oc_exist", message_id: "om_card", card_id: "c1" };
    });
    const sendDoc = vi.fn().mockImplementation(async () => {
      order.push("doc");
      return { chat_id: "oc_exist", message_id: "om_doc" };
    });
    // 远超卡片 2000 字上限：文件里必须是原样全文
    const content = `# 方案\n\n${"细节".repeat(3000)}`;

    __setFeishuGroupDepsForTest({ ...sharedGroupDeps(), sendCard, sendDoc });

    const r = await shareToRequirementGroup(baseTask(), {
      kind: "artifact",
      title: "方案 (Plan)",
      content,
    });

    expect(order).toEqual(["card", "doc"]);
    expect(r).toEqual({
      chatId: "oc_exist",
      messageId: "om_card",
      created: false,
      docMessageId: "om_doc",
    });
    expect(sendDoc).toHaveBeenCalledWith(
      "oc_exist",
      "登录优化-方案 (Plan).md",
      content,
    );
  });

  it("卡片不放正文：只剩需求名 / 标题 / 链接按钮 / 署名", async () => {
    const sendCard = vi
      .fn()
      .mockResolvedValue({ chat_id: "oc_exist", message_id: "om_1", card_id: "c1" });
    __setFeishuGroupDepsForTest({
      ...sharedGroupDeps(),
      sendCard,
      sendDoc: stubDoc(),
    });

    await shareToRequirementGroup(baseTask(), {
      kind: "artifact",
      title: "方案",
      content: "只应出现在 md 文件里的正文",
    });

    const card = sendCard.mock.calls[0]![1] as Record<string, unknown>;
    const s = JSON.stringify(card);
    expect(s).not.toContain("只应出现在 md 文件里的正文");
    expect(s).toContain("登录优化 · 方案");
    expect(s).toContain("来自 测试用户 · Flowship");
    expect(s).toContain("查看工作项");
  });

  // 卡片已经在群里了，再抛错会让用户以为没发出去、重复点分享攒重复卡
  it("md 文件发失败：只降级 warn，卡片仍算发出去（整体成功、无 docMessageId）", async () => {
    const warnings: string[] = [];
    __setFeishuGroupDepsForTest({
      ...sharedGroupDeps(),
      sendCard: async () => ({
        chat_id: "oc_exist",
        message_id: "om_card",
        card_id: "c1",
      }),
      sendDoc: vi.fn().mockRejectedValue(new LarkApiError("文件上传失败")),
      warn: (m) => warnings.push(m),
    });

    const r = await shareToRequirementGroup(baseTask(), {
      kind: "artifact",
      title: "方案",
      content: "正文",
    });

    expect(r).toEqual({
      chatId: "oc_exist",
      messageId: "om_card",
      created: false,
    });
    expect(r.docMessageId).toBeUndefined();
    expect(warnings.some((w) => w.includes("完整产物发送失败"))).toBe(true);
  });

  it("选中段分享（kind=message）只发卡片、不发文件", async () => {
    const sendDoc = stubDoc();
    const sendCard = vi
      .fn()
      .mockResolvedValue({ chat_id: "oc_exist", message_id: "om_1", card_id: "c1" });
    __setFeishuGroupDepsForTest({ ...sharedGroupDeps(), sendCard, sendDoc });

    const r = await shareToRequirementGroup(baseTask(), {
      kind: "message",
      title: "方案 (Plan)",
      content: "用户选中的那一段",
    });

    expect(sendDoc).not.toHaveBeenCalled();
    expect(r.docMessageId).toBeUndefined();
    // 短内容照旧进卡片正文
    expect(JSON.stringify(sendCard.mock.calls[0]![1])).toContain(
      "用户选中的那一段",
    );
  });
});

/**
 * 2026-07-27 线上：应用信息接口间歇性 `EOF`、取 tenant_access_token 的报文也带 token
 * 字样——老的关键词正则（含一个裸 `token`）把这些一律判成「飞书机器人未登录」，
 * 用户照着提示反复重新授权也修不好（auth status 里 bot 明明 ready）。
 */
describe("未登录判定以 auth status 实况为准", () => {
  /** 群已存在、发卡按用例给的错误挂掉——只为把错误送进 mapExternalError */
  const shareFailingWith = (
    sendError: unknown,
    over: Partial<FeishuGroupDeps>,
  ): void => {
    __setFeishuGroupDepsForTest({
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      fetchWorkitemName: async () => "登录优化",
      resolveSenderName: async () => "测试用户",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      sendCard: vi.fn().mockRejectedValue(sendError),
      ...over,
    });
  };

  const authStatus = (over: Partial<LarkAuthStatus> = {}) =>
    async (): Promise<LarkAuthStatus> => ({
      appId: "cli_self",
      userOpenId: "ou_me",
      botAvailable: true,
      ...over,
    });

  const share = () =>
    shareToRequirementGroup(baseTask(), { kind: "message", content: "x" });

  it("bot ready 时报文带 token 字样也不算未登录 → 报真实原因", async () => {
    shareFailingWith(
      new LarkApiError(
        'API call failed: Get "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal": EOF',
        { api: "api GET /open-apis/application/v6/applications/cli_self" },
      ),
      { probeAuthStatus: authStatus() },
    );
    await expect(share()).rejects.toMatchObject({
      code: "lark_error",
      message: expect.stringContaining("EOF"),
    });
  });

  it("auth status 说 bot 不可用 → 这才是 lark_not_authed", async () => {
    shareFailingWith(new LarkApiError("boom"), {
      probeAuthStatus: authStatus({ botAvailable: false, userOpenId: "" }),
    });
    await expect(share()).rejects.toMatchObject({ code: "lark_not_authed" });
  });

  it("auth status 读不到时退关键词：明说未登录才判", async () => {
    shareFailingWith(
      new LarkApiError("identity missing: run `lark-cli auth login` first"),
      { probeAuthStatus: async () => null },
    );
    await expect(share()).rejects.toMatchObject({ code: "lark_not_authed" });
  });

  it("auth status 读不到时退关键词：只是带 token 字样的不判", async () => {
    shareFailingWith(
      new LarkApiError("failed to refresh tenant_access_token: EOF"),
      { probeAuthStatus: async () => null },
    );
    await expect(share()).rejects.toMatchObject({ code: "lark_error" });
  });
});

describe("卡片纯函数", () => {
  it("truncateShareContent 截断 2000", () => {
    expect(truncateShareContent("短")).toBe("短");
    const long = "a".repeat(2005);
    const t = truncateShareContent(long);
    expect(t.length).toBe(2000);
    expect(t.endsWith("…")).toBe(true);
  });

  it("artifact 卡片不渲染正文（正文改由 md 文件承载）", () => {
    const card = buildShareCardJson({
      requirementName: "需求X",
      kind: "artifact",
      title: "提测",
      content: "这段正文不该出现在卡片里",
      storyUrl: "https://project.feishu.cn/x/story/detail/1",
      senderName: "小明",
    });
    const elements = collectElements(card);
    expect(elements.some((e) => e.element_id === "md_body")).toBe(false);
    // 徽标行也去掉：header subtitle 已经写着「产物」、再来一行纯属重复占版面
    expect(elements.some((e) => e.element_id === "md_kind")).toBe(false);
    expect(JSON.stringify(card)).not.toContain("这段正文不该出现在卡片里");
    // 身份信息照旧：标题行 + 链接按钮 + 署名
    expect((card.header as { title: { content: string } }).title.content).toBe(
      "需求X · 提测",
    );
    expect(JSON.stringify(card)).toContain("查看工作项");
    expect(JSON.stringify(card)).toContain("来自 小明 · Flowship");
  });

  it("message / question 卡片照旧带正文、且截断 2000", () => {
    const card = buildShareCardJson({
      requirementName: "需求X",
      kind: "message",
      content: "a".repeat(2500),
      senderName: "小明",
    });
    const body = collectElements(card).find((e) => e.element_id === "md_body");
    expect(body).toBeDefined();
    expect((body!.content as string).length).toBe(2000);
  });

  it("buildShareDocFilename：拼需求名 + 标题、洗掉非法字符、兜底不为空", () => {
    expect(
      buildShareDocFilename({ requirementName: "登录优化", title: "方案 (Plan)" }),
    ).toBe("登录优化-方案 (Plan).md");
    // 路径分隔符 / 换行 / 冒号会拼出非法文件名——一律洗掉
    expect(
      buildShareDocFilename({
        requirementName: "a/b\\c:d",
        title: "标题\n换行",
      }),
    ).toBe("a-b-c-d-标题 换行.md");
    // 无标题只留需求名；两段都空退兜底名
    expect(buildShareDocFilename({ requirementName: "需求X" })).toBe("需求X.md");
    expect(buildShareDocFilename({ requirementName: "  ", title: "" })).toBe(
      "产物.md",
    );
    // 超长截断（含 .md 后缀）
    const long = buildShareDocFilename({ requirementName: "长".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith(".md")).toBe(true);
  });

  it("buildShareCardJson 含 kind / footer / 工作项按钮", () => {
    const card = buildShareCardJson({
      requirementName: "需求X",
      kind: "question",
      content: "有个疑问",
      storyUrl: "https://project.feishu.cn/x/story/detail/1",
      senderName: "小明",
    });
    const s = JSON.stringify(card);
    expect(s).toContain("疑问");
    expect(s).toContain("来自 小明 · Flowship");
    expect(s).toContain("查看工作项");
    expect((card.header as { template: string }).template).toBe("orange");
  });

  it("open_url 只给 default_url：不塞空串平台字段", () => {
    const card = buildShareCardJson({
      requirementName: "需求X",
      kind: "artifact",
      content: "正文",
      storyUrl: "https://project.feishu.cn/x/story/detail/1",
      senderName: "小明",
    });
    const btn = collectElements(card).find((e) => e.tag === "button");
    expect(btn?.behaviors).toEqual([
      { type: "open_url", default_url: "https://project.feishu.cn/x/story/detail/1" },
    ]);
  });

  // 飞书硬约束（真机实测 300301）：字母开头、只允许字母数字下划线、≤20 字符、不许重复
  it("所有 element_id 合法且不重复（含多链接场景）", () => {
    const card = buildShareCardJson({
      requirementName: "需求X",
      kind: "artifact",
      title: "提测",
      content: "正文",
      links: Array.from({ length: 12 }, (_, i) => ({
        label: `MR ${i + 1}`,
        url: `https://git.example.com/g/r/-/merge_requests/${i + 1}`,
      })),
      storyUrl: "https://project.feishu.cn/x/story/detail/1",
      senderName: "小明",
    });
    const ids = collectElements(card).map((e) => e.element_id as string);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("链接按钮封顶、但「查看工作项」永远保留", () => {
    const card = buildShareCardJson({
      requirementName: "需求X",
      kind: "artifact",
      content: "正文",
      links: Array.from({ length: 12 }, (_, i) => ({
        label: `MR ${i + 1}`,
        url: `https://git.example.com/g/r/-/merge_requests/${i + 1}`,
      })),
      storyUrl: "https://project.feishu.cn/x/story/detail/1",
      senderName: "小明",
    });
    const buttons = collectElements(card).filter((e) => e.tag === "button");
    expect(buttons.length).toBe(7); // 6 条链接 + 固定的工作项出口
    expect(JSON.stringify(card)).toContain("查看工作项");
  });
});

// 客户端出站口径（lib/share-to-group）：整份产物不截断、选中段进卡片
describe("分享正文口径 / 选中段载荷", () => {
  it("prepareShareContent：artifact 原样、message 截 4000", () => {
    const long = "a".repeat(5000);
    expect(prepareShareContent("artifact", long)).toBe(long);
    const cut = prepareShareContent("message", long);
    expect(cut.length).toBe(4001); // 4000 + 省略号
    expect(cut.endsWith("…")).toBe(true);
  });

  it("buildSelectionShareInput：kind=message + action 标题、空选区返 null", () => {
    expect(
      buildSelectionShareInput("  选中的一段  ", "方案 (Plan)"),
    ).toEqual({
      kind: "message",
      title: "方案 (Plan)",
      content: "选中的一段",
    });
    // 没标题就不塞空 title；超长按 4000 截
    expect(buildSelectionShareInput("一段", "  ")).toEqual({
      kind: "message",
      content: "一段",
    });
    expect(buildSelectionShareInput("b".repeat(5000))!.content.length).toBe(4001);
    expect(buildSelectionShareInput("   \n  ")).toBeNull();
  });
});

describe("format: post / composePostShareMarkdown", () => {
  it("mentions 搁正文前、空 mentions 原样", () => {
    expect(composePostShareMarkdown("已提测", [{ openId: "ou_zhang", name: "张三" }])).toBe(
      '<at user_id="ou_zhang">张三</at>\n已提测',
    );
    expect(composePostShareMarkdown("  hello  ")).toBe("hello");
  });

  it("发 post 不走卡片、不跟 md 文件；mentions 由方法拼 <at>", async () => {
    const sendPost = vi.fn().mockResolvedValue({
      chat_id: "oc_exist",
      message_id: "om_post",
    });
    const sendCard = vi.fn();
    const sendDoc = stubDoc();
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      sendPost,
      sendCard,
      sendDoc,
    });

    const r = await shareToRequirementGroup(
      baseTask(),
      {
        format: "post",
        content: "已提测，请验收：\n- MR · crm-web https://example/mr/1",
        mentions: [{ openId: "ou_zhang", name: "张三" }],
      },
      { allowCreate: false },
    );
    expect(r).toMatchObject({
      chatId: "oc_exist",
      messageId: "om_post",
      created: false,
    });
    expect(r.docMessageId).toBeUndefined();
    expect(sendCard).not.toHaveBeenCalled();
    expect(sendDoc).not.toHaveBeenCalled();
    expect(sendPost).toHaveBeenCalledTimes(1);
    expect(sendPost.mock.calls[0]).toEqual([
      "oc_exist",
      '<at user_id="ou_zhang">张三</at>\n已提测，请验收：\n- MR · crm-web https://example/mr/1',
    ]);
  });

  it("post 发 230002 → bot_not_in_group，和卡片同一套码", async () => {
    __setFeishuGroupDepsForTest({
      ...noRegistryDeps,
      fetchGroupType: async () => ({ value: "bind", groupId: "oc_exist" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
      getBotName: async () => "Flowship·甲",
      sendPost: vi.fn().mockRejectedValue(
        new LarkApiError("The bot can not be outside the group", {
          code: 230002,
        }),
      ),
      sendCard: vi.fn(),
    });

    await expect(
      shareToRequirementGroup(
        baseTask(),
        { format: "post", content: "已提测" },
        { allowCreate: false },
      ),
    ).rejects.toMatchObject({
      code: "bot_not_in_group",
      botLabel: "Flowship·甲",
      chatId: "oc_exist",
    });
  });
});
