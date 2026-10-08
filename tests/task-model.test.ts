/**
 * 当前推进实际在用的模型：最近 action.agentModel → task.model（对齐 runner resume）
 */
import { describe, expect, it } from "vitest";

import {
  actionProviderMatches,
  latestActionAgentModel,
  modelSelectionKey,
  planResumeModel,
  resolveSessionModel,
  talkForceModel,
} from "@/lib/task-model";
import type { ActionRecord, ModelSelection, Task } from "@/lib/types";

const model = (id: string): ModelSelection => ({ id });

const act = (
  n: number,
  agentModel?: ModelSelection,
  agentProvider?: string,
): ActionRecord =>
  ({
    id: `a${n}`,
    n,
    type: "build",
    status: "completed",
    userInstruction: "",
    artifactPath: null,
    startedAt: n,
    endedAt: n,
    agentModel,
    agentProvider,
  }) as ActionRecord;

const task = (
  partial: Partial<Pick<Task, "model" | "actions" | "provider">>,
): Pick<Task, "model" | "actions" | "provider"> => ({
  model: partial.model,
  actions: partial.actions ?? [],
  provider: partial.provider,
});

describe("latestActionAgentModel", () => {
  it("按 n 取最近，不依赖数组顺序", () => {
    expect(
      latestActionAgentModel([
        act(5, model("composer-2.5")),
        act(2, model("claude-fable-5")),
        act(4),
      ])?.id,
    ).toBe("composer-2.5");
  });

  it("全无 agentModel → undefined", () => {
    expect(latestActionAgentModel([act(1), act(2)])).toBeUndefined();
    expect(latestActionAgentModel([])).toBeUndefined();
  });
});

describe("resolveSessionModel", () => {
  it("优先最近 action.agentModel，忽略陈旧 task.model", () => {
    expect(
      resolveSessionModel(
        task({
          model: model("claude-fable-5"),
          actions: [
            act(1, model("claude-fable-5")),
            act(11, model("composer-2.5")),
          ],
        }),
      )?.id,
    ).toBe("composer-2.5");
  });

  it("无 action 模型时回退 task.model", () => {
    expect(
      resolveSessionModel(
        task({ model: model("grok-4.5"), actions: [act(1)] }),
      )?.id,
    ).toBe("grok-4.5");
  });

  it("都没有 → undefined", () => {
    expect(resolveSessionModel(task({ actions: [] }))).toBeUndefined();
  });

  it("没推进过：说话条跟建任务时的 task.model", () => {
    expect(
      resolveSessionModel(
        task({ model: model("composer-2.5"), actions: [] }),
      )?.id,
    ).toBe("composer-2.5");
  });

  it("推进换模型后：展示新 action.agentModel，不回退建任务模型", () => {
    expect(
      resolveSessionModel(
        task({
          model: model("composer-2.5"),
          actions: [act(1, model("grok-4.6"))],
        }),
      )?.id,
    ).toBe("grok-4.6");
  });
});

describe("talkForceModel", () => {
  it("跟当前推进相同 → 不传（续活会话）", () => {
    expect(
      talkForceModel(model("composer-2.5"), model("composer-2.5")),
    ).toBeUndefined();
  });

  it("params 顺序不同仍算相同", () => {
    const a: ModelSelection = {
      id: "composer-2.5",
      params: [
        { id: "thinking", value: "high" },
        { id: "fast", value: "true" },
      ],
    };
    const b: ModelSelection = {
      id: "composer-2.5",
      params: [
        { id: "fast", value: "true" },
        { id: "thinking", value: "high" },
      ],
    };
    expect(modelSelectionKey(a)).toBe(modelSelectionKey(b));
    expect(talkForceModel(a, b)).toBeUndefined();
  });

  it("真换了才带 forceModel", () => {
    expect(talkForceModel(model("grok-4.6"), model("composer-2.5"))).toEqual(
      model("grok-4.6"),
    );
  });
});

// ---- 提供方戳 / 跨家守卫（v1.9.26 线上「选了 Sonnet 又显示回 Gemini」的回归） ----
// 场景：任务先在自建提供方（OLD_HOME）下推进、action 全带旧家戳；后来切到 NEW_HOME，
// task.model 是新家默认（Gemini）。用户在说话条换成新家的 Sonnet 唤醒当前 action。
const OLD_HOME = "cp_old_home";
const NEW_HOME = "cursor";
const sonnet = model("claude-sonnet-5-5");
const gemini = model("gemini-3.8-flash");
const muse = model("muse-spark-1.3-contributor");

describe("actionProviderMatches", () => {
  it("当前提供方没定 → 认（无从比较）", () => {
    expect(actionProviderMatches({ agentProvider: OLD_HOME }, undefined)).toBe(
      true,
    );
    expect(actionProviderMatches({ agentProvider: OLD_HOME }, "  ")).toBe(true);
  });

  it("action 无戳（老数据）→ 认", () => {
    expect(actionProviderMatches({}, NEW_HOME)).toBe(true);
  });

  it("戳相同认、不同不认", () => {
    expect(
      actionProviderMatches({ agentProvider: NEW_HOME }, NEW_HOME),
    ).toBe(true);
    expect(
      actionProviderMatches({ agentProvider: OLD_HOME }, NEW_HOME),
    ).toBe(false);
  });
});

describe("resolveSessionModel 跨家守卫", () => {
  it("异家戳的 action 模型跳过，回退 task.model（新家默认）", () => {
    expect(
      resolveSessionModel(
        task({
          provider: NEW_HOME,
          model: gemini,
          actions: [act(14, sonnet, OLD_HOME)],
        }),
      )?.id,
    ).toBe("gemini-3.8-flash");
  });

  it("同家戳的 action 模型照常优先于 task.model", () => {
    expect(
      resolveSessionModel(
        task({
          provider: NEW_HOME,
          model: gemini,
          actions: [act(14, sonnet, NEW_HOME)],
        }),
      )?.id,
    ).toBe("claude-sonnet-5-5");
  });

  it("无戳（老数据）按旧口径认", () => {
    expect(
      resolveSessionModel(
        task({
          provider: NEW_HOME,
          model: gemini,
          actions: [act(14, sonnet)],
        }),
      )?.id,
    ).toBe("claude-sonnet-5-5");
  });
});

describe("planResumeModel", () => {
  // 切过家的老任务里被唤醒的 action：旧家模型 + 旧家戳
  const staleAction = { agentModel: muse, agentProvider: OLD_HOME };
  const newHomeTask = { provider: NEW_HOME, model: gemini };

  it("回归：说话条换新家模型唤醒 → 连戳一起写回，写回后说话条仍显示它", () => {
    const plan = planResumeModel({
      forceModel: sonnet,
      action: staleAction,
      task: newHomeTask,
      fallbackModel: gemini,
    });
    expect(plan.model).toEqual(sonnet);
    expect(plan.writeBack).toEqual({
      agentModel: sonnet,
      agentProvider: NEW_HOME,
    });
    // 模拟 patchAction 的 {...action, ...patch} 展开，再走说话条的解析：
    // 只写 agentModel 不改戳的旧实现在这里会回退成 gemini
    const written = { ...act(14), ...staleAction, ...plan.writeBack };
    expect(
      resolveSessionModel(task({ ...newHomeTask, actions: [written] }))?.id,
    ).toBe("claude-sonnet-5-5");
  });

  it("没手选 + 异家戳：不拿旧家模型 id 起新家 agent，改用 task.model 并盖当前家戳", () => {
    const plan = planResumeModel({
      action: staleAction,
      task: newHomeTask,
      fallbackModel: sonnet, // 兜底排在 task.model 之后，不该被用到
    });
    expect(plan.model).toEqual(gemini);
    expect(plan.writeBack).toEqual({
      agentModel: gemini,
      agentProvider: NEW_HOME,
    });
  });

  it("已被污染的 action（新家模型 + 旧家戳）：用户重选同一模型 → 只订正戳", () => {
    const plan = planResumeModel({
      forceModel: sonnet,
      action: { agentModel: sonnet, agentProvider: OLD_HOME },
      task: newHomeTask,
      fallbackModel: gemini,
    });
    expect(plan.model).toEqual(sonnet);
    expect(plan.writeBack).toEqual({
      agentModel: sonnet,
      agentProvider: NEW_HOME,
    });
  });

  it("同家 + 没手选 + 模型一致 → 沿用 action 模型，不写盘", () => {
    const plan = planResumeModel({
      action: { agentModel: sonnet, agentProvider: NEW_HOME },
      task: newHomeTask,
      fallbackModel: gemini,
    });
    expect(plan.model).toEqual(sonnet);
    expect(plan.writeBack).toBeNull();
  });

  it("老数据（无戳）+ 提供方已定：沿用 action 模型，不凭空补戳", () => {
    const plan = planResumeModel({
      action: { agentModel: sonnet },
      task: newHomeTask,
      fallbackModel: gemini,
    });
    expect(plan.model).toEqual(sonnet);
    expect(plan.writeBack).toBeNull();
  });

  it("老数据（无戳）换了模型 → 写回并盖当前家戳", () => {
    const plan = planResumeModel({
      forceModel: gemini,
      action: { agentModel: sonnet },
      task: newHomeTask,
      fallbackModel: gemini,
    });
    expect(plan.writeBack).toEqual({
      agentModel: gemini,
      agentProvider: NEW_HOME,
    });
  });

  it("提供方没定：写回不带 agentProvider 键（带 undefined 会在展开时抹掉已有戳）", () => {
    const plan = planResumeModel({
      forceModel: gemini,
      action: staleAction,
      task: { provider: undefined, model: gemini },
      fallbackModel: gemini,
    });
    expect(plan.writeBack).toEqual({ agentModel: gemini });
    expect(plan.writeBack && "agentProvider" in plan.writeBack).toBe(false);
    // 展开后旧戳原样保留
    expect({ ...staleAction, ...plan.writeBack }.agentProvider).toBe(OLD_HOME);
  });

  it("优先级：forceModel > 同家 action > task.model > 兜底", () => {
    const sameHome = { agentModel: sonnet, agentProvider: NEW_HOME };
    expect(
      planResumeModel({
        forceModel: muse,
        action: sameHome,
        task: newHomeTask,
        fallbackModel: gemini,
      }).model,
    ).toEqual(muse);
    expect(
      planResumeModel({
        action: sameHome,
        task: newHomeTask,
        fallbackModel: muse,
      }).model,
    ).toEqual(sonnet);
    expect(
      planResumeModel({
        action: {},
        task: newHomeTask,
        fallbackModel: muse,
      }).model,
    ).toEqual(gemini);
    expect(
      planResumeModel({
        action: {},
        task: { provider: NEW_HOME, model: undefined },
        fallbackModel: muse,
      }).model,
    ).toEqual(muse);
  });

  it("params 顺序不同不算换了模型 → 不写盘", () => {
    const a: ModelSelection = {
      id: "composer-2.5",
      params: [
        { id: "thinking", value: "high" },
        { id: "fast", value: "true" },
      ],
    };
    const b: ModelSelection = {
      id: "composer-2.5",
      params: [
        { id: "fast", value: "true" },
        { id: "thinking", value: "high" },
      ],
    };
    const plan = planResumeModel({
      forceModel: a,
      action: { agentModel: b, agentProvider: NEW_HOME },
      task: newHomeTask,
      fallbackModel: gemini,
    });
    expect(plan.writeBack).toBeNull();
  });
});
