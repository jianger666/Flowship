/**
 * 任务会话「当前实际在用的模型」解析——跟 task-runner resume/send 口径对齐。
 *
 * 推进时模型写在 action.agentModel，不一定回写 task.model；UI「跟随会话」若只读
 * task.model 会显示建任务时的旧模型（如 Fable 5），实际续聊却是最近 action 的
 * Composer / Grok。单一来源避免再漂。
 */

import type { ActionRecord, ModelSelection, Task } from "@/lib/types";

type SessionModelTask = Pick<Task, "model" | "actions">;

/** 最近一个带 agentModel 的 action（按 n 最大，不依赖数组顺序） */
export const latestActionAgentModel = (
  actions: readonly Pick<ActionRecord, "n" | "agentModel">[] | undefined,
): ModelSelection | undefined => {
  if (!actions?.length) return undefined;
  let best: Pick<ActionRecord, "n" | "agentModel"> | undefined;
  for (const action of actions) {
    if (!action.agentModel?.id?.trim()) continue;
    if (!best || action.n > best.n) best = action;
  }
  return best?.agentModel;
};

/**
 * 会话跟随模型：最近 action.agentModel → task.model。
 * 都不存在时返 undefined（UI 显示「模型 · 跟随会话」、服务端再兜 settings）。
 */
export const resolveSessionModel = (
  task: SessionModelTask,
): ModelSelection | undefined => {
  const fromAction = latestActionAgentModel(task.actions);
  if (fromAction?.id?.trim()) return fromAction;
  if (task.model?.id?.trim()) return task.model;
  return undefined;
};
