/**
 * 任务会话「当前实际在用的模型」解析——跟 task-runner resume/send 口径对齐。
 *
 * 推进时模型写在 action.agentModel，不一定回写 task.model；说话条 / 推进默认若只读
 * task.model 会显示建任务时的旧模型（如 Fable 5），实际续聊却是最近 action 的
 * Composer / Grok。单一来源避免再漂。
 */

import type { ActionRecord, ModelSelection, Task } from "@/lib/types";

type SessionModelTask = Pick<Task, "model" | "actions" | "provider">;

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
 * 旧家未知的哨兵：老任务 provider 字段为空、会话锚点又是自定义形态（pi-sessions）时，
 * 历史到底跑在哪家已不可考——此时不能猜 "cursor"（猜错会在切回 cursor 时反向 400），
 * 也不能留空（空=无戳=旧口径全认，切完第一单就 400）。
 * 哨兵永不等于任何真实提供方 id（自建 id 形如 cp_xxx / cp_legacy），于是这些 action
 * 在任何新家下都被规则跳过、回退 task.model（切家时落盘的新家默认）——永远 fail-closed。
 */
export const LEGACY_UNKNOWN_PROVIDER = "__unknown-legacy-provider__";

/**
 * 切家时给无戳历史补旧家戳（setTaskProvider 内调，withTaskLock 持有 meta 时原地改、随 meta 落盘）。
 *
 * 只补“有模型且没戳”的 action，已有戳的不覆盖；prev 必须由调用方定好
 * （prev 规则只有一处：task-fs.ts setTaskProvider 内三分支，改规则改那边、别在这里各写一版）。返回补了几个。
 */
export const stampActionsProviderForSwitch = (
  actions: ActionRecord[] | undefined,
  prev: string,
): number => {
  if (!actions || !prev.trim()) return 0;
  let stamped = 0;
  for (const action of actions) {
    if (!action.agentModel?.id?.trim()) continue;
    if (action.agentProvider) continue;
    action.agentProvider = prev;
    stamped++;
  }
  return stamped;
};

/**
 * 当前推进实际在用的模型：最近 action.agentModel → task.model。
 * 都不存在时返 undefined（说话条空态「选择模型」、服务端再兜 settings）。
 *
 * 跨家守卫（v1.9.16）：action 模型只在同提供方下有效。有戳（agentProvider）且
 * 跟当前 task.provider 对不上的 action 直接跳过、回退 task.model（切家时落盘的
 * 新家默认）——否则切完显示/跑的还是旧家的模型 id，在新家直接 400。
 * 无戳（老数据）或 task 没定过提供方：按旧口径直接认（行为不变）。
 */
export const resolveSessionModel = (
  task: SessionModelTask,
): ModelSelection | undefined => {
  const provider = task.provider?.trim() || null;
  if (provider && task.actions?.length) {
    // 同家过滤后复用 latestActionAgentModel，别手写第二遍“取最大 n”（改排序规则只改一处）
    const m = latestActionAgentModel(
      task.actions.filter((a) => !a.agentProvider || a.agentProvider === provider),
    );
    if (m?.id?.trim()) return m;
  } else {
    const fromAction = latestActionAgentModel(task.actions);
    if (fromAction?.id?.trim()) return fromAction;
  }
  if (task.model?.id?.trim()) return task.model;
  return undefined;
};
