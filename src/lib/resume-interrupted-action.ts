/**
 * 「继续上次 Action」纯函数（仅 task 模式；纯函数、无 React / 无副作用，client / server 都能 import）
 *
 * 背景：服务重启（自更新 / 崩溃重启）会把在跑的 agent 打断，boot-recovery 把任务标 error 并追加一条
 * `meta.subkind="boot-recovery"` 的 error 事件（见 task-fs.markZombieTaskError）。这不是 AI / 模型的错，
 * 用户却得自己回忆「刚才跑的是哪个 action、写了什么指令」再重新推进。这里把两件事做成纯函数：
 *   1) 判定：这个任务此刻该不该显示「继续上次 Action」（{@link findInterruptedAction}）；
 *   2) 还原：从被打断的 ActionRecord 构造 advance 入参（{@link buildResumeAdvanceInput}），
 *      交给页面既有的 handleAdvance 提交链路（apiKey / model / gitToken / 分支快照都在那条链路里取，不复制）。
 *
 * 语义边界（改动前先读）：
 *  - 「继续」= **用原参数新开一个 action**（action 序号 +1），不是唤醒原 action——唤醒原 action 是底部输入条说话的语义
 *    （见 stop-copy 的 TASK_RESUME_HINT）。新 action 在工作区现状上重新跑，被打断那条保留为 error 历史。
 *  - 不做自动续跑：这里只给「能不能显示 / 点了传什么」，起 agent 永远要用户点击（自动起 agent 是对外副作用）。
 *  - ActionRecord 里**没有**存的东西无法还原：附图 / 附件 / `/skill` 引用（只有指令原文，`/skill`、`@文件` 以原文内联其中）、
 *    reuseAgent（重启后内存会话已丢、续用必然落到 fresh，所以固定传 false）、ship 的「合并后删源分支」（task 级字段、本就持久）。
 */

import { findPendingAskEvent } from "@/lib/ask-pending";
import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import { BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY, BOOT_RECOVERY_SUBKIND } from "@/lib/stop-copy";
import { actionDisplayLabel } from "@/lib/task-display";
import { actionProviderMatches } from "@/lib/task-model";
import type {
  ActionRecord,
  ActionType,
  DevPushMode,
  ModelSelection,
  ReplanMode,
  Task,
  TaskEvent,
} from "@/lib/types";

/** 判定所需的 task 字段（只读切片，调用方传整个 Task 即可） */
export type ResumeTaskView = Pick<
  Task,
  "mode" | "repoStatus" | "runStatus" | "archived" | "actions" | "events" | "provider"
>;

/** 交给页面 handleAdvance 的入参（字段名 / 类型与 handleAdvance 的 input 对齐，缺省字段 = 不传） */
export interface ResumeAdvanceInput {
  actionType: ActionType;
  userInstruction: string;
  /** 固定 false：重启后内存会话已丢，续用无会话可续、必然落到 fresh；显式写出让语义与实际一致 */
  reuseAgent: boolean;
  /** 沿用被打断 action 的模型；该 action 记的提供方与当前提供方不一致（切过家）时不传，交给 prepareRunArgs 用当前家默认 */
  model?: ModelSelection;
  /** 仅 build：原样沿用上次勾选的批次 effectiveId（空 / 无 = 自由改动，不传） */
  requestedBatchIds?: string[];
  /** 仅 dev：原样沿用（老数据没存则不传，服务端缺省 direct） */
  devPushMode?: DevPushMode;
  /** 仅 plan：原样沿用 */
  replanMode?: ReplanMode;
  /** 仅 custom：定义 id（缺失的 custom 不会走到这里，见 findInterruptedAction） */
  customActionId?: string;
}

/** 这条事件是不是 boot-recovery 的 error（只认机器标记，不匹配文案） */
export const isBootRecoveryError = (ev: TaskEvent): boolean =>
  ev.kind === "error" && ev.meta?.subkind === BOOT_RECOVERY_SUBKIND;

/**
 * 这条 boot-recovery 事件有没有「打断」一个在跑的 action：只有明确写了 `actionWasRunning === false` 才算没有
 * （已交卷的 action 在一次性问答期间碰上重启，被开机恢复一并翻成 error，但它本来就跑完了；R21-03）。
 * 没有这个字段（旧标记）按「打断了」处理。
 */
const bootRecoveryInterruptedAction = (ev: TaskEvent): boolean =>
  ev.meta?.[BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY] !== false;

/**
 * 事件流里最近一条「action 级」error：对主流不可见的 error 不算——回合内工具失败（旧数据 kind=error + meta.callId）、
 * 需求群旁路答疑 run 的失败都在 isHiddenFromEventStream 里被藏掉，与错误卡「当轮失败」（chat-turns.isLatestErrorEvent）
 * 同口径，免得旁路 / 工具噪音盖住真正的 run 失败。
 */
const findLastActionError = (events: readonly TaskEvent[]): TaskEvent | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "error" || isHiddenFromEventStream(ev)) continue;
    return ev;
  }
  return null;
};

/** 序号 n 最大的 action（不依赖数组顺序，同 task-model.latestActionAgentModel 的取法） */
const latestActionOf = (actions: readonly ActionRecord[]): ActionRecord | null => {
  let best: ActionRecord | null = null;
  for (const a of actions) if (!best || a.n > best.n) best = a;
  return best;
};

/**
 * 该任务此刻是否该显示「继续上次 Action」；该显示返回被打断的 action，否则 null。
 *
 * 全部满足才显示：
 *  1. task 模式（chat 没有 action 体系，boot-recovery 后靠发消息继续）；
 *  2. 没归档、不是终态（merged / abandoned）；
 *  3. 没有 action 在跑、任务也不是 running（已有新一轮在跑就不该再起一条）；
 *  4. 没在等提问答案（与顶部「推进」按钮同口径：推进会绕开未答的 ask）；
 *  5. **最近一个** action（n 最大）status=error 且未被划除（更早的失败 action 不给入口，免得回头重跑几天前的指令）；
 *  6. 事件流里最近一条 action 级 error 是 boot-recovery 标记，且不早于该 action 的 startedAt
 *     （boot-recovery 事件不带 actionId，用时间兜住「标记属于更早的 action」）；
 *  7. 这条 boot-recovery 事件没有标 `actionWasRunning: false`——false = 开机恢复翻 error 时该 action 并没在跑
 *     （已交卷的 action 在一次性问答期间碰上重启，被一并翻成 error，但它早就跑完了，点「继续」会整个重跑）；
 *  8. custom action 必须还留着定义 id（缺了无法还原，推进接口也会 400）。
 * 旧数据（没有 subkind 标记的 boot-recovery）不认——只对新写的标记生效，开发期不写兼容。
 */
export const findInterruptedAction = (task: ResumeTaskView): ActionRecord | null => {
  if (task.mode === "chat") return null;
  if (task.archived) return null;
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") return null;
  if (task.runStatus === "running") return null;
  if (task.actions.some((a) => a.status === "running")) return null;
  const latest = latestActionOf(task.actions);
  if (!latest || latest.status !== "error" || latest.excluded) return null;
  if (findPendingAskEvent(task.events)) return null;
  const lastError = findLastActionError(task.events);
  if (!lastError || !isBootRecoveryError(lastError) || lastError.ts < latest.startedAt) return null;
  // 这次开机恢复没有打断在跑的 action（已交卷的 action 被一并翻 error）→ 它已经跑完了，不给「继续」（R21-03）
  if (!bootRecoveryInterruptedAction(lastError)) return null;
  if (latest.type === "custom" && !latest.customActionId?.trim()) return null;
  return latest;
};

/**
 * 从被打断的 action 还原 advance 入参。
 *
 * 还原规则（每类只带它自己有意义的字段，与 advance 路由 / appendAction 的按类过滤一致）：
 *  - 通用：actionType、userInstruction 原文、reuseAgent=false；
 *  - 模型：沿用 action.agentModel，但 action.agentProvider 与 `provider`（当前 task 提供方）对不上时丢弃——
 *    旧家模型 id 在新家无效（同 task-model.resolveSessionModel 的跨家守卫，复用 actionProviderMatches 单一判定）；
 *  - build：requestedBatchIds（非空才带）；dev：devPushMode；plan：replanMode；custom：customActionId。
 */
export const buildResumeAdvanceInput = (
  action: ActionRecord,
  provider?: string | null,
): ResumeAdvanceInput => {
  const model =
    action.agentModel?.id?.trim() && actionProviderMatches(action, provider)
      ? action.agentModel
      : undefined;
  return {
    actionType: action.type,
    userInstruction: action.userInstruction,
    reuseAgent: false,
    model,
    requestedBatchIds:
      action.type === "build" && action.requestedBatchIds?.length
        ? [...action.requestedBatchIds]
        : undefined,
    devPushMode: action.type === "dev" ? action.devPushMode : undefined,
    replanMode: action.type === "plan" ? action.replanMode : undefined,
    customActionId: action.type === "custom" ? action.customActionId : undefined,
  };
};

/** 二次确认弹窗文案 */
export interface ResumeConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * 继续前要不要二次确认：plan / build / review 返回 null 直接继续；ship / dev / custom 可能对外有副作用
 * （已 push / 已提 MR / 已发通知），要先确认。
 *
 * 文案只写代码实际保证的：
 *  - ship 的「同一仓同一分支已有未合并 MR 时复用、不重复创建」由 gitlab-client.createMR 保证（撞 409 / 422 后 findOpenMR 复用）；
 *  - ship 的 push / 飞书通知、dev 的直推 / MR、custom 的任意动作**没有**「不会重复」的代码保证
 *    （action-ship / action-dev 的 prompt 只让 agent 先读 task.mrs / 重新 fetch，属软约束），一律写「请留意事件流」。
 */
export const resumeConfirmCopy = (
  action: Pick<ActionRecord, "type" | "n" | "customLabel">,
): ResumeConfirmCopy | null => {
  const label = actionDisplayLabel(action);
  const title = `继续 #${action.n} ${label}？`;
  switch (action.type) {
    case "ship":
      return {
        title,
        description:
          "上次提测在服务重启时被打断，可能已经 push 或提了 MR。继续会重新跑一遍提测：同一仓同一分支已有未合并的 MR 时会复用它、不会重复创建；push、飞书通知等其他动作可能再执行一次，请留意事件流。确认继续？",
        confirmLabel: "继续提测",
      };
    case "dev":
      return {
        title,
        description:
          "上次联调在服务重启时被打断，可能已经把改动推到 dev 分支或提了 MR。继续会重新跑一遍联调，请留意事件流确认是否已有 push / MR。确认继续？",
        confirmLabel: "继续联调",
      };
    case "custom":
      return {
        title,
        description: `上次「${label}」在服务重启时被打断，可能已经执行过部分对外操作（如 push、提 MR、发通知）。继续会重新执行一遍，请留意事件流确认。确认继续？`,
        confirmLabel: "继续执行",
      };
    default:
      return null;
  }
};

/** 页面 / 组件消费的一站式结果：显示谁、点了传什么、要不要二次确认 */
export interface ResumePlan {
  /** 被打断的 action（条上显示它的序号 + 名称） */
  action: ActionRecord;
  /** 点击后交给 handleAdvance 的入参 */
  input: ResumeAdvanceInput;
  /** 二次确认文案；null = 无需确认 */
  confirm: ResumeConfirmCopy | null;
}

/** 判定 + 还原 + 确认文案合一；不该显示返回 null */
export const planResumeInterruptedAction = (task: ResumeTaskView): ResumePlan | null => {
  const action = findInterruptedAction(task);
  if (!action) return null;
  return {
    action,
    input: buildResumeAdvanceInput(action, task.provider),
    confirm: resumeConfirmCopy(action),
  };
};
