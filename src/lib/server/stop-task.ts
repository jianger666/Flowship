/**
 * 停止 task 的共享收尾（单一源）：
 *   1) cancelTaskRun / cancelChatRun：abort SDK Run + 关跨 run 会话
 *   2) cleanupChatTaskState / abortRunningCheck / reapTaskOrphans：清进程级状态与孤儿
 *   3) 非终态（running / awaiting_ack）action 标 cancelled、作废未答 ask
 *   4) runStatus 回 idle + 落停止事件 + publish
 *
 * 调用方：
 *   - /api/tasks/[id]/stop 路由（用户点「停止」按钮）
 *   - /api/tasks/[id]/action-exclude（awaiting_user 态划除时自动收尾——该态顶栏
 *     没有「停止」按钮、409 让用户先停止是死胡同、划除即隐含「这个 action 不要了」）
 *
 * R24-5c 调用方分析（未加 allowWithinLifecycle）：
 *   - DELETE / finalizeTask **不**调 stopTaskAgent——各自 begin deleting/finalizing + 自管收尾
 *   - 故 begin("stopping") 在 deleting/finalizing 下返 false → 直接 join 返回即可，
 *     无需 opts.allowWithinLifecycle 给 owner 显式委托
 */

import { ACTION_LABEL, type Task } from "@/lib/types";
import { finalizeStaleAndIdleLocked, getTask } from "./task-fs";
import {
  abortRunningCheck,
  cancelTaskRun,
  supersedePendingAsks,
} from "./task-runner";
import {
  hasResourceJobs,
  isTaskStarting,
  pendingStopRequests,
  publishTaskStreamEvent,
  revokeTaskOps,
  writeEventAndPublish,
} from "./task-stream";
import { cancelChatRun } from "./chat-runner";
import { clearChatQueue } from "./chat-queue";
import {
  beginChatLifecycle,
  cancelChatStart,
  endChatLifecycle,
  getChatLifecycle,
} from "./chat-gate";
import { failpoint } from "./failpoints";
import { reapTaskOrphans } from "./kill-orphans";
import {
  cleanupChatTaskState,
  invalidateCallerToken,
} from "./chat-pending";
import { clearActionSideEffects } from "./action-side-effects";
import { getTaskWorkRepoPaths } from "./task-worktrees";

type StopResult = { hadAgent: boolean; task: Task };

/**
 * 停止指定 task 的 agent（幂等：无活 agent 也完成状态收尾）。
 * 同 task 并发 stop 合并为单次 in-flight（后到者 await 同一 Promise）。
 */
export const stopTaskAgent = (
  task: Task,
  opts: { trigger?: "stop" | "exclude" } = {},
): Promise<StopResult> => {
  const id = task.id;
  const inflightMap = (() => {
    const g = globalThis as unknown as {
      __feAiFlowStopInflightV1__?: Map<string, Promise<StopResult>>;
    };
    if (!g.__feAiFlowStopInflightV1__) {
      g.__feAiFlowStopInflightV1__ = new Map();
    }
    return g.__feAiFlowStopInflightV1__;
  })();
  const existing = inflightMap.get(id);
  if (existing) return existing;

  // finally 回调异步执行、const 绑定届时已完成赋值（无 TDZ 风险）
  const promise: Promise<StopResult> = runStopTaskAgent(task, opts).finally(() => {
    if (inflightMap.get(id) === promise) inflightMap.delete(id);
  });
  inflightMap.set(id, promise);
  return promise;
};

const runStopTaskAgent = async (
  task: Task,
  opts: { trigger?: "stop" | "exclude" },
): Promise<StopResult> => {
  const id = task.id;

  // T1：收尾有多段 await——先占 stopping，挡住窗口内覆盖 cancelled lease 起新 Agent。
  // R24-5c：lifecycle 排他——begin 失败且当前是 deleting/finalizing → join 让位，
  // 不 revoke、不写任何状态（terminal owner 负责收尾）。调用方分析见本文件顶注释。
  const beganStopping = beginChatLifecycle(id, "stopping");
  if (!beganStopping) {
    const life = getChatLifecycle(id);
    if (life === "deleting" || life === "finalizing") {
      // terminal owner 负责收尾——stop join 语义，返回入场快照；不调 invalidateCallerToken
      return { hadAgent: false, task };
    }
  }
  try {
    // V12：立刻 revoke——已入场但卡在 baseline/create 的 advance/one-shot 靠入场快照发现作废，
    // 即使本 stop 稍后释放 lifecycle、pending 也被清掉，旧请求仍不得继续 Agent.create/send。
    revokeTaskOps(id);

    // R26-4：begin("stopping") 成功后、首个 await 前同步失效 bridge lease——
    // 旧 agent 的 MCP 立即被分派层拒（不等到 cleanupChatTaskState）。
    // join 分支（上面对 deleting/finalizing 直接 return）不走这里。
    if (beganStopping) {
      invalidateCallerToken(id);
    }

    // R29-A：revoke 后 join resourceJobs（对照 finalizeTask）——等在飞 ensure/worktree
    // 归零再收尾；上限 30s、超时 warn 继续（lease/revoke 已挡后续副作用）。
    {
      const deadline = Date.now() + 30_000;
      while (hasResourceJobs(id) && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      if (hasResourceJobs(id)) {
        console.warn(
          `[stop-task] R29-A：task=${id} 等待 resourceJobs 归零超时（~30s）、继续收尾`,
        );
      }
    }

    // R23-6 / R25-1：stop.afterGate 保留在 revoke 后、锁内收尾事务前（矩阵依赖此窗口）。
    // 旧实现在此无锁 getTask 重读——可与 append 的 commit rename await 交错漏扫；
    // 现改为 finalizeStaleAndIdleLocked 同把 task lock，见该 helper 线性化注释。
    await failpoint("stop.afterGate");

    // 1) abort SDK Run + 关会话 + 清 ask 登记（先断 agent 再清状态）
    // chat task 的 run 在 chat-runner 的 runningChats、正经 task 在 task-runner 的 runningTasks、
    // 一个 task 只落其一、两个都试、命中即停（cancelTaskRun 命中即短路、不会误触发 cancelChatRun）
    const hadAgent = cancelTaskRun(id) || cancelChatRun(id);
    // P5.1：停止时清 chat 排队（积压消息不应在 stop 后再自动发）
    clearChatQueue(id);
    // S1：撤销启动 lease（标 cancelled），owner 在 checkpoint 窗口内复查失效后中止；
    // 不用 clearChatGate——不能清正在进行的 rewind 门闩（rewind 侧 finally 自己 endChatRewind）
    cancelChatStart(id);
    // U1：idle 点停止时 cancelTaskRun 会写入 pendingStopRequests（防下次 oneshot 误杀），
    // 无飞行消费者时才清。飞行中的启动链（Agent.create 窗口）需要这个标记自裁——
    // 清了它 agent 就会在 create 返回后照常注册（U1 可复现时序）。
    // V2：startingTasks 已改 refcount——isTaskStarting 在任一 owner 仍飞行时为 true。
    if (!isTaskStarting(id)) {
      pendingStopRequests.delete(id);
    }
    cleanupChatTaskState(id);
    // R29-C：清 action 屏障 Map——防 stop 后 submit_work 永久挂在 wait 上泄漏
    clearActionSideEffects(id);
    // V0.8.18：取消正在后台跑的后置 check（杀 lint/typecheck 子进程、丢弃结果、不让它在停止后冒「产出完成」）
    abortRunningCheck(id);

    // V0.6.8：run.cancel() 杀不到 agent 用 shell 拉起的孙子进程（如 `npm run lint`=`ng lint --fix`、
    // 会 orphan 后继续改写整个仓库）。传实际工作目录（隔离 worktree 任务 cwd 在 worktrees/ 下、
    // 不是原仓 repoPaths——审查发现 stop 漏杀孤儿）。
    // worktree 路径仍可从入场快照取（目录结构不依赖 action 列表）
    reapTaskOrphans(getTaskWorkRepoPaths(task));

    // 2+3) R25-1：非终态 action → cancelled + runStatus idle，同锁单次事务
    // （与 appendAction 的 prepare→commit 共享 withTaskLock，必见刚提交的 running action）
    const live =
      (await finalizeStaleAndIdleLocked(id, { toStatus: "cancelled" })) ?? task;

    // 作废旧 agent 没答完的孤儿 ask（停止后旧 agent 已断、不清掉前端会弹失效的旧问题弹窗、
    // 用户答了必报错）。停止 = 主动中断、不续传旧问题、只清孤儿。
    await supersedePendingAsks(id, "用户停止");

    // 事件文案用「当前 / 最近一个」非终态→已 cancelled 的 action（基于锁内事务返回快照）
    const cancelled = live.actions.filter((a) => a.status === "cancelled");
    const current =
      (live.currentActionId
        ? live.actions.find((a) => a.id === live.currentActionId)
        : null) ??
      cancelled[cancelled.length - 1] ??
      null;

    // 4) 落事件让用户在事件流看到这次停止
    // chat task 无 action、文案走「对话」语境（「再发消息」不是「推进」）；
    // 划除触发的自动收尾按实际操作措辞、别写成用户点了「停止」（review 提出）
    const actionLabel = current
      ? ` ${ACTION_LABEL[current.type] ?? current.type} action`
      : "";
    const stopText =
      live.mode === "chat"
        ? "用户停止了对话（agent 已中断、可继续发消息）"
        : opts.trigger === "exclude"
          ? `划除时自动停止了${actionLabel}（agent 已中断、可重新「推进」）`
          : `用户停止了${actionLabel}（agent 已中断、可重新「推进」）`;
    // R29-P2d：用户 stop 操作——无条件 writeEventAndPublish（不带 lease）
    // （stop-task 不在 R27-6 no-restricted-syntax 文件名单内，无需 eslint-disable）
    await writeEventAndPublish(id, {
      kind: "info",
      actionId: current?.id,
      text: stopText,
    });

    const fresh = (await getTask(id)) ?? live;
    // task 快照仍需单独 publish（writeEventAndPublish 只推 event envelope）
    publishTaskStreamEvent(id, { kind: "task", task: fresh });
    // R29：stop 作为 lifecycle owner 补发 task 级 done——旧 run 的 cancelled 收尾在
    // revoke 后被 publishIfCurrent 正确拒发、但前端 streamingText 靠 done 解挂；
    // 纯 stop（无后继 run）场景没人再发 done、这里由终态 owner 无条件补上。
    publishTaskStreamEvent(id, { kind: "done", task: fresh, ok: true });

    return { hadAgent, task: fresh };
  } finally {
    // 带 phase：若 DELETE 已把 stopping 升级成 deleting，勿误清 deleting
    if (beganStopping) endChatLifecycle(id, "stopping");
  }
};
