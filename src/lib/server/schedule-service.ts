/**
 * 定时任务服务层：把调度核心（schedule-runner）接到真实的投递通道上，并负责启动。
 *
 * # 投递
 * 到点的消息走和「用户自己发了一条」同一条路径——chat 走 `handleChatReplyInject`、task 走
 * `handleTaskQuestionInject`——因此会话被 12 分钟空闲回收后会先恢复再送、忙则入队等既有语义全部白拿。
 * 与普通消息的区别只有 `scheduledTrigger: true`（不顶掉待答提问 / 不 snapshot 产物 / 不唤醒阶段，
 * 见两个 inject 文件里该选项的注释）和 `meta.source = "schedule"`（UI 据此渲染「定时触发」）。
 * 模型 / 凭据：跟这个会话自己的 provider + 最近用的模型走（`bootArgsForTask`，和输入条同口径），
 * 不是设置页的全局默认。
 *
 * # 启动锚点
 * 不能挂 instrumentation（webpack 对它不吃 serverExternalPackages，引入含 @cursor/sdk 的模块会炸全部路由），
 * 与飞书桥接同款：route 模块加载时调 `ensureScheduleRunnerStarted()`，Electron 壳启动后会 ping
 * `/api/feishu-bridge/status`，headless 也能起来。vitest 下不起定时器。
 *
 * # 单进程假设（已知限制）
 * 任务锁（`withTaskLock`）和 inflight 集合都只在**进程内**有效。打包的 Electron 壳有单实例锁
 * （`app.requestSingleInstanceLock()`），正常只有一个服务进程；但如果同时开着 `pnpm dev:web`
 * 和打包 app 并让它们共用同一个数据目录，两边各有一个调度器，到点的定时会**双发**。
 * 要这样用请给其中一个换 `FLOWSHIP_DATA_DIR`；没有做跨进程文件锁（代价 / 收益不成比例）。
 */
import {
  DANGLING_TASK_PROVIDER_MESSAGE,
  bootArgsForTask,
  isTaskProviderDangling,
  migrateProviderSettings,
} from "@/lib/agent-provider";
import {
  buildScheduleInfoMeta,
  SCHEDULE_TICK_MS,
  type ScheduleListItem,
} from "@/lib/schedule";
import type { FeAiFlowSettings } from "@/lib/types";

import { getPendingAsk } from "./chat-pending";
import { handleChatReplyInject } from "./chat-inject";
import { mapLimit } from "./map-limit";
import { readSettingsFile } from "./settings-fs";
import { startScheduleQueueLossWatcher } from "./schedule-queue-loss";
import {
  classifyInjectResponse,
  createScheduleRunner,
  defaultStoreDeps,
  type DeliverOutcome,
  type DeliverRequest,
  type ScheduleRunner,
} from "./schedule-runner";
import {
  listTaskIdsWithScheduleFile,
  readSchedules,
  rebuildScheduleIndex,
} from "./schedule-store";
import { getTaskMeta } from "./task-fs";
import { handleTaskQuestionInject } from "./task-question-inject";
import { writeEventAndPublish } from "./task-stream";

const warn = (msg: string, err?: unknown): void => {
  console.warn(`[schedule] ${msg}`, err instanceof Error ? err.message : (err ?? ""));
};

/**
 * 读设置 → 与该会话输入条同口径的 bootArgs；读不到凭据 / 模型返回 null。
 * 会话绑定的自定义提供方已被删除 → 返回 `{ danglingProvider }`（调用方据此拒投、写明原因），
 * 不能照常 bootArgsForTask：它会落回 Cursor 凭据、定时消息（含会话上下文）悄悄走云端（第四轮 Q2-02）。
 */
const loadBootArgs = async (
  task: NonNullable<Awaited<ReturnType<typeof getTaskMeta>>>,
): Promise<
  | { apiKey: string; model: { id: string; params?: Array<{ id: string; value: string }> } }
  | { danglingProvider: string }
  | null
> => {
  const result = await readSettingsFile();
  if (result.status !== "ok") return null;
  const raw = result.settings as Record<string, unknown>;
  const migrated = migrateProviderSettings(raw);
  const settings = {
    ...(raw as object),
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    defaultModel: (raw.defaultModel as { id: string } | undefined) ?? { id: "" },
    provider: migrated.provider,
    customProviders: migrated.customProviders,
  } as unknown as FeAiFlowSettings;
  if (isTaskProviderDangling(task, settings)) {
    return { danglingProvider: DANGLING_TASK_PROVIDER_MESSAGE };
  }
  const { apiKey, model } = bootArgsForTask(task, settings);
  if (!model?.id?.trim()) return null;
  return { apiKey, model: model as { id: string; params?: Array<{ id: string; value: string }> } };
};

const readJsonSafe = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

/** 真实投递：把一次到点触发送进它所属的会话 */
export const deliverScheduleFire = async (req: DeliverRequest): Promise<DeliverOutcome> => {
  const task = await getTaskMeta(req.taskId);
  // 下面三种都是「再等多久也送不进去」：标 permanent，周期定时据此直接取消、不再每个周期失败一次
  if (!task) return { kind: "failed", reason: "会话已不存在", permanent: true };
  if (task.archived) return { kind: "failed", reason: "会话已归档", permanent: true };
  // 任务已合入 / 已放弃：task 路径对终态任务只会写一条「任务已合入」的 error 事件就退出，
  // 不会把消息送给 AI——不能让它被记成「已送达」
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
    return {
      kind: "failed",
      reason: `任务已${task.repoStatus === "merged" ? "合入" : "放弃"}`,
      permanent: true,
    };
  }
  // 用户还没答的提问：定时消息不去打断（也不顶掉它），等用户答完再送。
  // 内存里的登记表是权威（meta.pendingAskId 是异步落盘的，刚提问 / 刚答完的窗口里会滞后），两边任一有就算有
  if (getPendingAsk(req.taskId) || task.pendingAskId) {
    return { kind: "retry", reason: "有未答的提问，等你答完再送" };
  }

  const boot = await loadBootArgs(task);
  if (!boot) return { kind: "failed", reason: "缺少 API Key 或模型，请先在设置页配置" };
  // 悬空提供方：拒投并把原因落成「定时失败」提示（runner 会写进该会话的事件流）。
  // 不标 permanent——用户在输入框底部重选提供方后，周期定时下一轮即可恢复
  if ("danglingProvider" in boot) {
    return { kind: "failed", reason: boot.danglingProvider };
  }

  const body = {
    text: req.text,
    bootArgs: boot,
    clientItemId: req.clientItemId,
  };
  const res =
    task.mode === "chat"
      ? await handleChatReplyInject(req.taskId, body, {
          userReplyMetaExtra: req.meta,
          scheduledTrigger: true,
        })
      : await handleTaskQuestionInject(req.taskId, body, {
          userReplyMetaExtra: req.meta,
          scheduledTrigger: true,
        });
  return classifyInjectResponse(res.status, await readJsonSafe(res));
};

const notifyInfo = async (
  taskId: string,
  text: string,
  meta: Record<string, unknown>,
): Promise<void> => {
  await writeEventAndPublish(taskId, { kind: "info", text, meta });
};

const RUNNER_KEY = "__flowshipScheduleRunnerV1__";
const getRunner = (): ScheduleRunner => {
  const g = globalThis as unknown as Record<string, ScheduleRunner | undefined>;
  if (!g[RUNNER_KEY]) {
    g[RUNNER_KEY] = createScheduleRunner({
      now: () => Date.now(),
      ...defaultStoreDeps(),
      deliver: deliverScheduleFire,
      notify: notifyInfo,
    });
  }
  return g[RUNNER_KEY]!;
};

/** 管理页逐个会话读定时的并发上限 */
const LIST_CONCURRENCY = 16;

/**
 * 管理页：全部会话的定时（含已结束的历史），带上所属会话的标题 / 模式 / 是否归档。
 * 只扫「有 schedules.json 的任务目录」，不碰其余会话；会话已不存在 / 被删的跳过。
 * 排序：还活着的在前（按下次触发升序），已结束的在后（按结束时间降序）。
 */
export const listScheduleItems = async (): Promise<ScheduleListItem[]> => {
  const ids = await listTaskIdsWithScheduleFile();
  const items: ScheduleListItem[] = [];
  // 有界并发：有定时文件的会话再多，也不一次性全发出去（管理页开着时每 15 秒来一遍）
  await mapLimit(ids, LIST_CONCURRENCY, async (id) => {
    try {
      const task = await getTaskMeta(id);
      if (!task) return;
      for (const r of await readSchedules(id)) {
        items.push({
          ...r,
          taskTitle: task.title,
          taskMode: task.mode === "chat" ? "chat" : "task",
          taskArchived: task.archived === true,
        });
      }
    } catch (err) {
      warn(`列出定时失败 task=${id}`, err);
    }
  });
  const live = (r: ScheduleListItem): boolean => r.status === "active" || r.status === "paused";
  // 第二 / 第三排序键（创建时间、id）：两个会话各设了「明早 9:00」时主键相同，输入顺序又取决于并发读完成的先后，
  // 不加的话 15 秒轮询之间这两行会互换位置
  const tie = (a: ScheduleListItem, b: ScheduleListItem): number =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return items.sort((a, b) => {
    if (live(a) !== live(b)) return live(a) ? -1 : 1;
    if (live(a)) {
      return (
        (a.nextFireAt ?? Number.MAX_SAFE_INTEGER) - (b.nextFireAt ?? Number.MAX_SAFE_INTEGER) ||
        tie(a, b)
      );
    }
    return (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt) || tie(a, b);
  });
};

/** 管理页 / 会话内「立即触发」 */
export const fireScheduleNow = (
  taskId: string,
  scheduleId: string,
): ReturnType<ScheduleRunner["fireNow"]> => getRunner().fireNow(taskId, scheduleId);

/** 扫一遍（调度器自己的定时器调；测试 / 调试也可手动调） */
export const tickSchedulesNow = (): Promise<void> => getRunner().tick();

/** 写一条「定时已建立」之类的会话内提示（工具 / API 创建后调；失败吞掉） */
export const noteScheduleEvent = async (
  taskId: string,
  scheduleId: string,
  phase: "created" | "cancelled" | "archived",
  text: string,
): Promise<void> => {
  try {
    await writeEventAndPublish(taskId, {
      kind: "info",
      text,
      meta: buildScheduleInfoMeta(scheduleId, phase),
    });
  } catch (err) {
    warn(`写提示事件失败 task=${taskId}`, err);
  }
};

const STARTED_KEY = "__flowshipScheduleTimerStartedV1__";

/** server 启动锚点：重复调用无副作用。vitest 下不起定时器 */
export const ensureScheduleRunnerStarted = (): void => {
  if (process.env.VITEST) return;
  // `next build` 收集页面数据时也会加载 route 模块：那不是真的在跑应用，绝不能在那里触发定时
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[STARTED_KEY]) return;
  g[STARTED_KEY] = true;
  // 排进队列的定时消息被停止 / 回退清掉时，给会话补一条提示（见 schedule-queue-loss）
  startScheduleQueueLossWatcher();
  const runner = getRunner();
  const run = (): void => {
    void runner.tick().catch((err) => warn("tick 出错", err));
  };
  // 先重建索引（只读）再立即 tick 一次：重启后已过点的当场判错过、不等 5 秒
  void rebuildScheduleIndex()
    .then(run)
    .catch((err) => warn("重建索引失败", err));
  const timer = setInterval(run, SCHEDULE_TICK_MS);
  timer.unref?.();
};
