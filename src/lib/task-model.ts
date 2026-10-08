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
 * 这条 action 记的提供方戳，跟当前提供方对得上吗？
 * - 当前提供方没定（task.provider 为空）→ 无从比较，认
 * - action 无戳（v1.9.16 前的老数据）→ 按旧口径认
 * resolveSessionModel 的同家过滤与唤醒选模型（planResumeModel）共用这一处——
 * 展示口径和服务端口径只许有一份判定，别再各写各的（v1.9.26 线上就分叉过一次）。
 */
export const actionProviderMatches = (
  action: Pick<ActionRecord, "agentProvider">,
  provider: string | null | undefined,
): boolean => {
  const current = provider?.trim();
  return !current || !action.agentProvider || action.agentProvider === current;
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
      task.actions.filter((a) => actionProviderMatches(a, provider)),
    );
    if (m?.id?.trim()) return m;
  } else {
    const fromAction = latestActionAgentModel(task.actions);
    if (fromAction?.id?.trim()) return fromAction;
  }
  if (task.model?.id?.trim()) return task.model;
  return undefined;
};

const usableModel = (
  m: ModelSelection | undefined,
): ModelSelection | undefined => (m?.id?.trim() ? m : undefined);

export interface ResumeModelPlan {
  /** 唤醒的新 agent 实际用的模型 */
  model: ModelSelection;
  /**
   * 非 null = 要 patch 到被唤醒的 action 上（模型 + 提供方戳一起写，不许只写一半）。
   * agentProvider 仅在当前提供方已定时才带键——带 undefined 会被 patch 展开成抹掉已有戳。
   */
  writeBack: Pick<ActionRecord, "agentModel" | "agentProvider"> | null;
}

/**
 * 唤醒当前 action 时：用哪个模型、要不要把它连同提供方戳写回 action。
 *
 * 选模型：forceModel（用户显式选的，必是当前家）→ 同家的 action.agentModel →
 * task.model（切家时落盘的新家默认）→ 调用方兜底。异家戳的 action.agentModel 跳过：
 * 旧家模型 id 在当前家无效，拿去起 agent 会 400（跟 resolveSessionModel 同一道跨家守卫）。
 *
 * 写回（action.agentModel 是说话条展示的单一来源）：模型变了要写；戳跟当前家对不上也要写——
 * 这是 v1.9.26 线上的坑：切过家的老任务里 action 带旧家戳，用户在说话条换成新家模型唤醒，
 * 只写 agentModel 不改戳，resolveSessionModel 就把刚写回的新家模型当旧家的跳过，
 * 说话条回退显示 task.model（实际在跑的仍是用户选的）。
 * 已被污染的老任务（新家模型 + 旧家戳）从数据上分不出它是不是真旧家模型：没手选时按
 * 「跟说话条显示一致」回退 task.model 并把戳订正过来；用户重选一次模型即可换回想要的。
 * 老数据（无戳）/ 当前家未定：不凭空补戳，行为同旧口径。
 */
export const planResumeModel = (input: {
  forceModel?: ModelSelection;
  action: Pick<ActionRecord, "agentModel" | "agentProvider">;
  task: Pick<Task, "model" | "provider">;
  fallbackModel: ModelSelection;
}): ResumeModelPlan => {
  const { forceModel, action, task, fallbackModel } = input;
  const provider = task.provider?.trim() || undefined;
  const model =
    usableModel(forceModel) ??
    (actionProviderMatches(action, provider)
      ? usableModel(action.agentModel)
      : undefined) ??
    usableModel(task.model) ??
    fallbackModel;
  const modelChanged =
    modelSelectionKey(model) !== modelSelectionKey(action.agentModel);
  const stampStale =
    !!provider && !!action.agentProvider && action.agentProvider !== provider;
  if (!modelChanged && !stampStale) return { model, writeBack: null };
  return {
    model,
    writeBack: {
      agentModel: model,
      ...(provider ? { agentProvider: provider } : {}),
    },
  };
};
