/**
 * 当前推进实际在用的模型：最近 action.agentModel → task.model（对齐 runner resume）
 */
import { describe, expect, it } from "vitest";

import {
  latestActionAgentModel,
  modelSelectionKey,
  resolveSessionModel,
  talkForceModel,
} from "@/lib/task-model";
import type { ActionRecord, ModelSelection, Task } from "@/lib/types";

const model = (id: string): ModelSelection => ({ id });

const act = (
  n: number,
  agentModel?: ModelSelection,
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
  }) as ActionRecord;

const task = (
  partial: Partial<Pick<Task, "model" | "actions">>,
): Pick<Task, "model" | "actions"> => ({
  model: partial.model,
  actions: partial.actions ?? [],
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
