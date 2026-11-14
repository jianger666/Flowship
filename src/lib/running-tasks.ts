/**
 * 「有任务在运行」判定 + 自更新前的确认文案（纯函数，client / server 都能 import）
 *
 * 背景：自更新（mac applyStagedUpdate 重启 / win quitAndInstall）会杀掉内嵌 server，在跑的 agent 全部被打断
 * （重启后由 boot-recovery 标 error，见 task-fs.markZombieTaskError）。用户点「更新并重启」那一刻
 * 要先知道「现在有任务在跑」——**只提示、不阻止**，由用户拍板。
 *
 * 判定口径（单一来源，侧栏转圈用的是更宽的 task-background.isTaskBusy，这里刻意更窄）：
 *  - 只认 `runStatus === "running"`，task / chat 一视同仁；
 *  - `awaiting_user`（等用户回复 / 答题）、`idle`、`error` 都不是「在跑」：没有 agent 在干活，重启不会丢进度；
 *  - 「排队中」没有对应字段：RunStatus 只有 idle / running / awaiting_user / error 四态，待送达队列（talkQueue）是服务端
 *    纯内存、不进任务列表，所以无法判定、不计入；
 *  - 后台子代理还在跑但主 run 已回 awaiting_user 的任务**不计入**（重启会取消它们，但「中断后可继续」的恢复入口只对
 *    主 run 被打断的任务成立，提示文案不能对它们做承诺；要纳入时把判定换成 isTaskBusy 即可、文案另议）。
 */

import type { TaskSummary } from "@/lib/types";

/** 确认弹窗里最多列几个任务标题 */
export const RUNNING_TASKS_PREVIEW_LIMIT = 3;

/** 单个标题最多显示多少字（按码点，超出以省略号收尾；长标题会把弹窗撑成一屏） */
const TITLE_MAX_CHARS = 30;

/** 标题为空时的兜底 */
const UNTITLED = "未命名任务";

/** 判定 / 展示所需的任务字段（TaskSummary 的只读切片） */
export type RunningTaskView = Pick<TaskSummary, "id" | "title" | "mode" | "runStatus">;

/** 这个任务此刻算不算「在运行」（更新重启会打断它） */
export const isRunningForUpdate = (task: Pick<TaskSummary, "runStatus">): boolean =>
  task.runStatus === "running";

export interface RunningTasksSummary {
  /** 在运行的任务总数（task + chat） */
  count: number;
  /** 最多 {@link RUNNING_TASKS_PREVIEW_LIMIT} 个标题（已截断过长的） */
  titles: string[];
  /** 没列出来的个数（count - titles.length） */
  hiddenCount: number;
  /** 在运行的里面有 task 模式 / chat 模式（决定「中断后怎么继续」写哪句） */
  hasTask: boolean;
  hasChat: boolean;
}

const clipTitle = (raw: string): string => {
  const title = raw.trim() || UNTITLED;
  const chars = Array.from(title);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join("")}…` : title;
};

/** 汇总在运行的任务；入参允许 null / undefined（列表还没加载 = 当没有） */
export const summarizeRunningTasks = (
  tasks: readonly RunningTaskView[] | null | undefined,
): RunningTasksSummary => {
  const running = (tasks ?? []).filter(isRunningForUpdate);
  const titles = running.slice(0, RUNNING_TASKS_PREVIEW_LIMIT).map((t) => clipTitle(t.title));
  return {
    count: running.length,
    titles,
    hiddenCount: running.length - titles.length,
    // mode 缺省 = task（老数据）
    hasTask: running.some((t) => t.mode !== "chat"),
    hasChat: running.some((t) => t.mode === "chat"),
  };
};

/**
 * 「中断后怎么继续」短句：只写对应入口真实存在的——「继续上次 Action」只在 task 任务页出现（InterruptedActionBar），
 * chat 没有 action、靠继续发消息。
 */
const resumeHintOf = (s: Pick<RunningTasksSummary, "hasTask" | "hasChat">): string => {
  if (s.hasTask && s.hasChat) return "任务中断后可在任务页点「继续上次 Action」，对话可继续发消息";
  if (s.hasChat) return "中断后可在对话里继续发消息";
  return "中断后任务页可以点「继续上次 Action」";
};

export interface UpdateConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  /** 有任务在跑时确认键走 destructive（红）：这一步会打断它们 */
  destructive: boolean;
}

/**
 * 「更新并重启」确认弹窗文案。
 *
 * 基础文案与改动前完全一致（ready = 已下载完、点了就重启；available = 还要先下载）；
 * 有任务在跑时在后面追加警告 + 最多 3 个标题 + 「仍要更新吗？」——同一个弹窗里一次问完，不连弹两层。
 */
export const buildUpdateConfirmCopy = (opts: {
  phase: "ready" | "available";
  version: string;
  running: RunningTasksSummary;
}): UpdateConfirmCopy => {
  const { phase, version, running } = opts;
  const base =
    phase === "ready"
      ? "新版本已下载完成、点击后将自动重启完成更新、数据不丢。"
      : "将下载并安装更新、完成后自动重启、数据不丢。";
  const head = {
    title: `更新到 v${version}？`,
    confirmLabel: phase === "ready" ? "重启更新" : "立即更新",
  };
  if (running.count === 0) {
    return { ...head, description: base, destructive: false };
  }
  const lines = running.titles.map((t) => `· ${t}`);
  if (running.hiddenCount > 0) lines.push(`· …另有 ${running.hiddenCount} 个`);
  return {
    ...head,
    description: [
      base,
      "",
      `当前有 ${running.count} 个任务正在运行，更新重启会中断它们（${resumeHintOf(running)}）。`,
      ...lines,
      "仍要更新吗？",
    ].join("\n"),
    destructive: true,
  };
};

/** 点击瞬间拉最新列表的上限：超过它就退回缓存（点了「更新」不能被一个慢请求卡住） */
export const UPDATE_CHECK_FETCH_TIMEOUT_MS = 1500;

/**
 * 取「用来判定的任务列表」：优先点击那一刻现拉（列表轮询只在有任务在跑 / 桥接开时才 2s 一次，
 * 否则可能是几十秒前的缓存，漏掉刚被定时 / 飞书唤醒起来的任务），拉不到 / 超时 / 抛错一律退回 fallback——
 * 只提示、不阻止：这里任何失败都不能让「更新」点不动。
 */
export const resolveTasksForUpdateCheck = async (opts: {
  fetchLatest: () => Promise<readonly RunningTaskView[]>;
  fallback: readonly RunningTaskView[];
  timeoutMs?: number;
}): Promise<readonly RunningTaskView[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      opts.fetchLatest(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          opts.timeoutMs ?? UPDATE_CHECK_FETCH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    return opts.fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
