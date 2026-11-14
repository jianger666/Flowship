/**
 * 自动推进的执行侧：订阅全局 task 流，在「登记链的那一轮 run 正常结束」时代替用户点一次「推进」。
 * 状态与校验规则见 advance-chain.ts（纯函数、可单测）；本文件只做 IO 与时序。
 *
 * # 时序
 *
 * 1. agent 调 `advance_next` → flowship-tools 校验 + {@link registerAdvanceChain}（只登记、不起任何东西）
 * 2. agent 正常交卷（聊天里登记的没有这一步）、说完收尾、run 结束 → 流上出现主链的 `done`（不带 origin）
 * 3. 本模块取走链（一次性）→ 等 run 真正落定 → 核对（见 evaluateChainFire）→ 调 `advanceTask`
 *    （`expectedCurrentActionId` = 登记时的 action，抢跑 / 重复 / 被人手推进过一律 CAS 拒绝）
 *
 * 登记之后用户又在输入条说了话 → 链作废（用户的新话优先于上一轮的授权）。
 * run 非正常结束（停止 / 报错）→ 链作废、不提示（停止是用户自己点的，报错有它自己的 error 事件）。
 *
 * 推进只是 advanceTask 的一次普通调用（`viaAutoChain: true` 只用来不清零自动推进计数），
 * 不碰 ownership / 并发那套：并发由 `runAdvanceExclusive` + CAS 兜。
 */

import type { ModelSelection } from "@cursor/sdk";

import { resolveSessionModel } from "@/lib/task-model";
import { ACTION_LABEL, type ActionRecord, type Task, type TaskEvent } from "@/lib/types";
import {
  ADVANCE_CHAIN_MAX_AUTO_STEPS,
  buildAutoAdvanceInstruction,
  bumpAutoAdvanceSteps,
  describeAdvanceBasis,
  evaluateChainFire,
  getAutoAdvanceSteps,
  isUserOwnWordsEvent,
  peekAdvanceChain,
  takeAdvanceChain,
  type AdvanceChain,
} from "./advance-chain";
import { ADVANCE_STALE_MESSAGE } from "./advance-expectation";
import type { AdvanceTaskInput } from "./task-runner";
import {
  getTaskOpGeneration,
  runningTasks,
  subscribeAllTaskStreams,
  writeEventAndPublish,
  type TaskStreamEvent,
} from "./task-stream";

/** run 的 `done` 帧到 runner 把 runningTasks / runStatus 收干净之间有个很短的窗口，最多等这么久 */
const RUN_SETTLE_WAIT_MS = 3_000;
const RUN_SETTLE_POLL_MS = 100;

/** 与 task-runner 的让位文案同源（字面量，避免本模块静态依赖 task-runner 造成循环引用） */
const TASK_OP_STALE_MESSAGE = "正在停止/任务已变更、请重发";

export interface AdvanceChainDeps {
  getTaskMeta: (taskId: string) => Promise<Task | null>;
  getOpGeneration: (taskId: string) => number;
  isTaskRunning: (task: Task) => boolean;
  loadBoot: (task: Task) => Promise<{ apiKey: string; model: ModelSelection } | null>;
  advance: (input: AdvanceTaskInput) => Promise<{ action: ActionRecord }>;
  writeEvent: (
    taskId: string,
    ev: Pick<TaskEvent, "kind" | "text" | "actionId" | "meta">,
  ) => Promise<unknown>;
  customActionLabel: (id: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** 真实依赖：全部懒加载（task-runner / feishu-bridge 很重，不在 import 本模块时拖进来、也避开循环引用） */
const realDeps: AdvanceChainDeps = {
  getTaskMeta: async (taskId) => (await import("./task-fs")).getTaskMeta(taskId),
  getOpGeneration: (taskId) => getTaskOpGeneration(taskId),
  isTaskRunning: (task) => runningTasks.has(task.id) || task.runStatus === "running",
  loadBoot: async (task) => {
    const { loadBridgeBootContext } = await import("./feishu-bridge/router");
    const boot = await loadBridgeBootContext(task);
    if (!boot) return null;
    return { apiKey: boot.apiKey, model: resolveSessionModel(task) ?? task.model ?? boot.model };
  },
  advance: async (input) => (await import("./task-runner")).advanceTask(input),
  writeEvent: (taskId, ev) => writeEventAndPublish(taskId, ev),
  customActionLabel: async (id) => {
    const def = await (await import("./custom-action-fs")).getCustomAction(id);
    return def?.label?.trim() || null;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

let testDeps: Partial<AdvanceChainDeps> | null = null;

/** 仅测试：覆盖部分依赖（多次调用会叠加）；传 null 全部还原 */
export const __setAdvanceChainDepsForTest = (
  d: Partial<AdvanceChainDeps> | null,
): void => {
  testDeps = d === null ? null : { ...(testDeps ?? {}), ...d };
};

const deps = (): AdvanceChainDeps => ({ ...realDeps, ...(testDeps ?? {}) });

const note = async (
  d: AdvanceChainDeps,
  taskId: string,
  actionId: string | null | undefined,
  text: string,
  meta?: Record<string, unknown>,
): Promise<void> => {
  try {
    await d.writeEvent(taskId, {
      kind: "info",
      text,
      ...(actionId ? { actionId } : {}),
      meta: { subkind: "auto_advance", ...(meta ?? {}) },
    });
  } catch (err) {
    console.warn(`[advance-chain] task=${taskId} 写提示事件失败：`, err);
  }
};

const labelOf = async (d: AdvanceChainDeps, chain: AdvanceChain): Promise<string> => {
  if (chain.actionType === "custom" && chain.customActionId) {
    return (await d.customActionLabel(chain.customActionId).catch(() => null)) ?? ACTION_LABEL.custom;
  }
  return ACTION_LABEL[chain.actionType];
};

/** 等 run 真正落定（done 帧先于 runningTasks 清理）；超时返回 false */
const waitRunSettled = async (d: AdvanceChainDeps, taskId: string): Promise<Task | null> => {
  const deadline = d.now() + RUN_SETTLE_WAIT_MS;
  for (;;) {
    const task = await d.getTaskMeta(taskId);
    if (!task) return null;
    if (!d.isTaskRunning(task)) return task;
    if (d.now() >= deadline) return task;
    await d.sleep(RUN_SETTLE_POLL_MS);
  }
};

/**
 * 触发一条（已被取走的）链。导出供测试；正常只由 {@link handleAdvanceChainFrame} 调。
 * 绝不抛：失败一律落提示 / error 事件。
 */
export const fireAdvanceChain = async (taskId: string, chain: AdvanceChain): Promise<void> => {
  const d = deps();
  try {
    const task = await waitRunSettled(d, taskId);
    if (task && d.isTaskRunning(task)) {
      await note(d, taskId, chain.fromActionId, "任务又开始跑了（可能有新消息排队），之前登记的自动推进取消");
      return;
    }
    const verdict = evaluateChainFire({
      chain,
      task,
      opGenNow: d.getOpGeneration(taskId),
      autoStepsSoFar: getAutoAdvanceSteps(taskId),
      now: d.now(),
    });
    if (!verdict.ok) {
      // 状态变了（stale）属于「别的操作已经接管」：用户自己造成的，不再落提示打扰
      if (verdict.kind !== "stale") {
        await note(d, taskId, chain.fromActionId, verdict.reason);
      } else {
        console.log(`[advance-chain] task=${taskId} 让位：${verdict.reason}`);
      }
      return;
    }
    const liveTask = task!;

    const boot = await d.loadBoot(liveTask);
    if (!boot) {
      await note(d, taskId, chain.fromActionId, "本机缺 API Key 或默认模型，自动推进取消");
      return;
    }

    const label = await labelOf(d, chain);
    const step = getAutoAdvanceSteps(taskId) + 1;
    await note(
      d,
      taskId,
      chain.fromActionId,
      `自动推进到「${label}」（${describeAdvanceBasis(chain.userWords)}；连续自动推进第 ${step}/${ADVANCE_CHAIN_MAX_AUTO_STEPS} 步）`,
      { actionType: chain.actionType, step },
    );

    try {
      await d.advance({
        task: liveTask,
        actionType: chain.actionType,
        ...(chain.customActionId ? { customActionId: chain.customActionId } : {}),
        ...(chain.devPushMode ? { devPushMode: chain.devPushMode } : {}),
        ...(chain.batchIds ? { requestedBatchIds: chain.batchIds } : {}),
        userInstruction: buildAutoAdvanceInstruction(chain),
        apiKey: boot.apiKey,
        model: boot.model,
        expectedCurrentActionId: chain.fromActionId,
        opGen: chain.opGen,
        viaAutoChain: true,
      });
      bumpAutoAdvanceSteps(taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === ADVANCE_STALE_MESSAGE || message === TASK_OP_STALE_MESSAGE) {
        await note(d, taskId, chain.fromActionId, "自动推进让位了：任务状态刚变化过，这次没有推进");
        return;
      }
      await d
        .writeEvent(taskId, {
          kind: "error",
          text: `自动推进到「${label}」没能启动：${message}`,
          ...(chain.fromActionId ? { actionId: chain.fromActionId } : {}),
          meta: { subkind: "advance_failed", actionType: chain.actionType, auto: true },
        })
        .catch((e) => console.warn(`[advance-chain] task=${taskId} 写失败事件出错：`, e));
    }
  } catch (err) {
    console.warn(`[advance-chain] task=${taskId} 触发异常：`, err);
  }
};

/**
 * 全局流帧处理（导出供测试）。热路径：每个任务的每一帧都会进来，没链时必须 O(1) 立刻返回。
 */
export const handleAdvanceChainFrame = (taskId: string, ev: TaskStreamEvent): void => {
  if (ev.kind === "event") {
    const chain = peekAdvanceChain(taskId);
    if (!chain) return;
    const e = ev.event;
    // 登记之前的事件（包括触发本轮 run 的那条用户消息）不算「又插话」
    if (e.ts <= chain.registeredAt || !isUserOwnWordsEvent(e)) return;
    takeAdvanceChain(taskId);
    void note(
      deps(),
      taskId,
      chain.fromActionId,
      "你又发了新消息，之前登记的自动推进已取消（需要的话再说一声）",
    );
    return;
  }
  if (ev.kind !== "done") return;
  // 只认属主主链的 done：带 origin 的是旁路 / 非属主那几条
  if (ev.origin !== undefined) return;
  const chain = takeAdvanceChain(taskId);
  if (!chain) return;
  if (!ev.ok) {
    console.log(`[advance-chain] task=${taskId} run 非正常结束，自动推进作废`);
    return;
  }
  void fireAdvanceChain(taskId, chain);
};

const CONSUMER_KEY = "__flowshipAdvanceChainConsumerV1__";

/** 装全局订阅（幂等：HMR / 重复登记链都只装一份） */
export const ensureAdvanceChainConsumer = (): void => {
  const g = globalThis as unknown as Record<string, (() => void) | undefined>;
  if (g[CONSUMER_KEY]) return;
  g[CONSUMER_KEY] = subscribeAllTaskStreams(handleAdvanceChainFrame);
};

/** 仅测试：卸载订阅并清标记 */
export const __uninstallAdvanceChainConsumerForTest = (): void => {
  const g = globalThis as unknown as Record<string, (() => void) | undefined>;
  g[CONSUMER_KEY]?.();
  delete g[CONSUMER_KEY];
};

export const __isAdvanceChainConsumerInstalledForTest = (): boolean =>
  !!(globalThis as unknown as Record<string, unknown>)[CONSUMER_KEY];
