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
});
