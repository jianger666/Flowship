/**
 * 「哪些任务绑在同一个群上」的共用判断（第四轮 B4-4 / Q12b-02）
 *
 * 一个群可以同时被多个任务绑：同一个工作项先后开了任务 A、B（项目群默认 / 手动绑同一个 oc_）。
 * 群消息只会进其中一个——原来取决于扫描那一刻谁的 updatedAt 最新 + 10 分钟缓存：用户在 A 里干活（A 的 updatedAt 被碰）
 * 之后群消息就串到 A，两个任务的界面都显示「已绑定」，没有任何提示；群问答进错任务、属主在群里 @ 推进起在错任务上（烧额度）。
 *
 * 这里放两处共用的纯判断（无 IO、无副作用，可单测）：
 *  - 路由（group-route 的 resolveGroupRoute）：哪些任务算候选、同群多任务时挑哪个受理；
 *  - 绑定（bind 路由的 findOtherBoundTasks）：绑完看一眼这个群上是不是还有别的任务（有就在响应里带 alsoBoundBy）。
 *
 * 同伴只认「本地关联」（task.feishuGroupChatId）：项目群默认要读飞书项目的工作项（打 meegle 网络），
 * 而回流链每条群消息都会走路由——不为凑同伴多打网络。所以只靠项目群默认共用同一个群的任务发现不了
 * （已知缺口：它们之间仍按「谁先被扫到」决定，见 HANDOFF B4-4）。
 */

/** 本模块只读的任务字段（TaskSummary 天然满足，单测可以直接塞字面量） */
export interface GroupBindingTaskLike {
  id: string;
  title?: string;
  feishuStoryUrl?: string;
  feishuGroupChatId?: string;
  repoStatus?: string;
  archived?: boolean;
  updatedAt?: number;
  runStatus?: string;
  hasPendingAsk?: boolean;
}

/** 提示里用的任务简况 */
export interface CoBoundTask {
  id: string;
  title: string;
}

/**
 * 群消息 → 任务的候选口径（原来内联在 resolveTaskIdByGroupChat 里，原样搬过来供绑定查重共用）：
 * 有工作项链接或有本任务群关联即可（本地关联不需要工作项）；已合并 / 已放弃 / 已归档的任务退出群回流。
 */
export const isGroupRouteCandidate = (t: GroupBindingTaskLike): boolean =>
  ((t.feishuStoryUrl ?? "").trim().length > 0 ||
    (t.feishuGroupChatId ?? "").trim().length > 0) &&
  t.repoStatus !== "merged" &&
  t.repoStatus !== "abandoned" &&
  !t.archived;

/** 任务自带群关联（读它不用打网络） */
export const hasLocalGroupBinding = (t: GroupBindingTaskLike): boolean =>
  (t.feishuGroupChatId ?? "").trim().length > 0;

/** 任务此刻「活着」：正在运行 / 等用户回答——群里的问话更可能指它 */
export const isTaskLiveForGroup = (t: GroupBindingTaskLike): boolean =>
  t.runStatus === "running" ||
  t.runStatus === "awaiting_user" ||
  t.hasPendingAsk === true;

/**
 * 同一个群上有多个任务时，挑受理群消息的那个：活着的优先；同档保持传入顺序
 * （调用方按 updatedAt 倒序传，所以同档 = 最近更新的）。`first` 是扫描时先命中的那个（候选里 updatedAt 最新）。
 */
export const pickRouteTask = <T extends GroupBindingTaskLike>(
  first: T,
  others: readonly T[],
): T => [first, ...others].find(isTaskLiveForGroup) ?? first;

export const toCoBoundTask = (t: GroupBindingTaskLike): CoBoundTask => ({
  id: t.id,
  title: (t.title ?? "").trim(),
});

/**
 * 在一批任务里找「本地关联了这个群」的（绑定查重用）：同一套候选口径，不含 `excludeTaskId`（本任务自己）。
 * 保持传入顺序。
 */
export const findLocalCoBoundTasks = <T extends GroupBindingTaskLike>(
  tasks: readonly T[],
  opts: { chatId: string; excludeTaskId?: string },
): T[] =>
  tasks.filter(
    (t) =>
      t.id !== opts.excludeTaskId &&
      isGroupRouteCandidate(t) &&
      (t.feishuGroupChatId ?? "").trim() === opts.chatId,
  );
