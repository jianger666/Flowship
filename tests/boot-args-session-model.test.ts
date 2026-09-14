/**
 * 回归：输入条显示 Composer、发出去却跑 grok（task.model 陈旧）。
 * bootArgsForTask 必须跟说话条同口径：最近 action.agentModel → task.model → 设置页默认。
 */
import { describe, expect, it } from "vitest";

import { bootArgsForTask } from "@/lib/agent-provider";

const settings = {
  apiKey: "k",
  defaultModel: { id: "composer-2.5" },
  customProviders: [],
  provider: "cursor",
} as never;

const grok = {
  id: "grok-4.5",
  params: [
    { id: "effort", value: "high" },
    { id: "fast", value: "true" },
  ],
} as never;
const composer = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "true" }],
} as never;

const act = (n: number, agentModel?: never) =>
  ({ id: `a${n}`, n, agentModel }) as never;

describe("bootArgsForTask 会话模型口径", () => {
  it("最近 action 有模型时优先用它，不读陈旧 task.model", () => {
    const { model } = bootArgsForTask(
      { model: grok, actions: [act(8, composer)] } as never,
      settings,
    );
    expect(model).toEqual(composer);
  });

  it("无 action 模型时回退 task.model", () => {
    const { model } = bootArgsForTask(
      { model: grok, actions: [act(1)] } as never,
      settings,
    );
    expect(model).toEqual(grok);
  });

  it("都没有时回退设置页默认", () => {
    const { model } = bootArgsForTask(
      { actions: [] } as never,
      settings,
    );
    expect(model).toEqual({ id: "composer-2.5" });
  });

  it("老任务启发式判 custom：旧 actions 和 task.model 全是 cursor 时代 id，都不认，回设置页新家默认", () => {
    const customSettings = {
      apiKey: "k",
      defaultModel: { id: "composer-2.5" },
      customProviders: [
        {
          id: "cp_test",
          name: "t",
          baseUrl: "https://api.test/v1",
          apiKey: "ck",
          format: "openai",
          defaultModel: { id: "new-default" },
        },
      ],
      provider: "cursor",
    } as never;
    const { model, providerId } = bootArgsForTask(
      {
        // 无 provider 字段 + pi 锚点 = 跑过自定义的老任务：resolved 走自定义
        sessionAgentId: "agent_pi-sessions_abc",
        model: { id: "composer-old" },
        actions: [
          { id: "a1", n: 1, agentModel: { id: "old-action" } },
        ],
      } as never,
      customSettings,
    );
    expect(providerId).toBe("cp_test");
    expect(model).toEqual({ id: "new-default" });
  });

  it("provider 穿透：切家后旧家 action 模型不再优先，回退新家 task.model（删掉穿透行就红）", () => {
    const { model } = bootArgsForTask(
      {
        provider: "cursor",
        model: { id: "new-default" },
        actions: [
          { id: "a1", n: 1, agentModel: { id: "old" }, agentProvider: "opencode" },
        ],
      } as never,
      settings,
    );
    expect(model).toEqual({ id: "new-default" });
  });
});

describe("resolveSessionModel 跨家守卫（v1.9.16）", () => {
  // 直接测 resolveSessionModel：action 戳只在同家有效，切家后回退 task.model（新家默认）
  it("同家 action 模型优先（有戳且一致）", async () => {
    const { resolveSessionModel } = await import("@/lib/task-model");
    expect(
      resolveSessionModel({
        provider: "opencode",
        model: { id: "new-default" },
        actions: [
          { id: "a1", n: 1, agentModel: { id: "opencode-model" }, agentProvider: "opencode" },
        ],
      } as never),
    ).toEqual({ id: "opencode-model" });
  });

  it("切家后旧 action 模型失效，回退 task.model", async () => {
    const { resolveSessionModel } = await import("@/lib/task-model");
    expect(
      resolveSessionModel({
        provider: "cursor",
        model: { id: "composer-2.5" },
        actions: [
          { id: "a1", n: 1, agentModel: { id: "deepseek-v4" }, agentProvider: "opencode" },
        ],
      } as never),
    ).toEqual({ id: "composer-2.5" });
  });

  it("无戳老数据按旧口径（直接认），行为不变", async () => {
    const { resolveSessionModel } = await import("@/lib/task-model");
    expect(
      resolveSessionModel({
        provider: "cursor",
        model: { id: "composer-2.5" },
        actions: [{ id: "a1", n: 1, agentModel: { id: "old-model" } }],
      } as never),
    ).toEqual({ id: "old-model" });
  });

  it("旧家 action 之间按 n 取最大（乱序数组也稳）", async () => {
    const { resolveSessionModel } = await import("@/lib/task-model");
    expect(
      resolveSessionModel({
        provider: "opencode",
        model: { id: "new-default" },
        actions: [
          { id: "a2", n: 2, agentModel: { id: "new-one" }, agentProvider: "opencode" },
          { id: "a1", n: 1, agentModel: { id: "old-one" }, agentProvider: "cursor" },
        ],
      } as never),
    ).toEqual({ id: "new-one" });
  });
});

describe("stampActionsProviderForSwitch（切家补戳）", () => {
  it("给所有无戳有模型的 action 补旧家，已有戳的不覆盖", async () => {
    const { stampActionsProviderForSwitch } = await import("@/lib/task-model");
    const actions = [
      { id: "a1", n: 1, agentModel: { id: "m1" } },
      { id: "a2", n: 2, agentModel: { id: "m2" }, agentProvider: "cursor" },
      { id: "a3", n: 3 },
    ] as never[];
    expect(stampActionsProviderForSwitch(actions, "opencode")).toBe(1);
    expect(actions[0]).toMatchObject({ agentProvider: "opencode" });
    expect(actions[1]).toMatchObject({ agentProvider: "cursor" });
    expect(actions[2]).not.toHaveProperty("agentProvider");
  });

  it("空数组/空 prev 直接返回 0", async () => {
    const { stampActionsProviderForSwitch } = await import("@/lib/task-model");
    expect(stampActionsProviderForSwitch([], "opencode")).toBe(0);
    expect(stampActionsProviderForSwitch(undefined, "opencode")).toBe(0);
    expect(
      stampActionsProviderForSwitch([{ id: "a1", n: 1, agentModel: { id: "m" } }] as never[], ""),
    ).toBe(0);
  });

  it("哨兵戳在任何新家下都被跳过、回退 task.model", async () => {
    const { resolveSessionModel, LEGACY_UNKNOWN_PROVIDER } =
      await import("@/lib/task-model");
    expect(LEGACY_UNKNOWN_PROVIDER).toMatch(/^__/);
    for (const provider of ["cursor", "opencode", "cp_x1"]) {
      expect(
        resolveSessionModel({
          provider,
          model: { id: "fresh-default" },
          actions: [
            { id: "a1", n: 1, agentModel: { id: "stale-id" }, agentProvider: LEGACY_UNKNOWN_PROVIDER },
          ],
        } as never),
      ).toEqual({ id: "fresh-default" });
    }
  });
});
