/**
 * 任务会话「当前实际在用的模型」解析——跟 task-runner resume/send 口径对齐。
 *
 * 推进时模型写在 action.agentModel，不一定回写 task.model；说话条 / 推进默认若只读
 * task.model 会显示建任务时的旧模型（如 Fable 5），实际续聊却是最近 action 的
 * Composer / Grok。单一来源避免再漂。
 */

import type { ActionRecord, ModelSelection, Task } from "@/lib/types";

type SessionModelTask = Pick<Task, "model" | "actions">;

/** 模型 + 参数指纹（params 按 id 排序，顺序差不当成换了模型） */
export const modelSelectionKey = (
  m: ModelSelection | undefined | null,
): string => {
  if (!m?.id?.trim()) return "";
  const params = [...(m.params ?? [])]
    .map((p) => `${p.id}=${p.value}`)
    .sort();
  return `${m.id}:${params.join(",")}`;
};

/**
 * 说话条要不要带 forceModel：展示当前推进模型 ≠ 「用户显式换了」。
 * 选的和会话相同就别传——服务端见 forceModel 会不续活会话、改走唤醒 / 一次性 agent。
 */
export const talkForceModel = (
  picked: ModelSelection,
  session: ModelSelection | undefined,
): ModelSelection | undefined => {
  if (!picked.id.trim()) return undefined;
  if (session && modelSelectionKey(picked) === modelSelectionKey(session)) {
    return undefined;
  }
  return picked;
};

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
 * 当前推进实际在用的模型：最近 action.agentModel → task.model。
 * 都不存在时返 undefined（说话条空态「选择模型」、服务端再兜 settings）。
 */
export const resolveSessionModel = (
  task: SessionModelTask,
): ModelSelection | undefined => {
  const fromAction = latestActionAgentModel(task.actions);
  if (fromAction?.id?.trim()) return fromAction;
  if (task.model?.id?.trim()) return task.model;
  return undefined;
};
