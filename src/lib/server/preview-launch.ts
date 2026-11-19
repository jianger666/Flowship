/**
 * 任务预览（dev server）的「起 / 看 / 停」入口——UI 的 `/api/preview` 与 agent 的 `preview` 工具共用。
 *
 * 为什么单独成文件：
 * - `preview-manager` 是底座（进程组 / pidfile / 日志环形缓冲），为了避开与 task-fs 的循环依赖，它不读任务；
 * - 「按任务算工作目录、从设置页取命令、拦终态任务」这套准入原先内联在路由里，agent 工具要走同一套，
 *   各写一份迟早漂移（比如一边拦了终态任务、一边忘了）。这里收成 {@link launchTaskPreview}，路由和工具都调它。
 *
 * agent 工具（{@link dispatchPreviewTool}）与 UI 的区别只有两点，都是为了不让 AI 误伤别人：
 * 1. **不顶掉别的任务**：同一个仓全局只有一个预览位，UI 上用户点了是明确的接管（会顶掉旧的、并提示被顶的任务名）；
 *    agent 自己起时若该仓被别的任务占着，直接拒绝、让它告诉用户由用户决定；
 * 2. **只管自己任务的预览**：status 只列本任务的、stop 只停本任务的。
 * 命令仍只来自设置页（服务端权威 config.json），agent 不能传命令。
 */
import { promises as fs } from "node:fs";

import type { PreviewSlotStatus } from "@/lib/types";

import { getChatLifecycle } from "./chat-gate";
import {
  getPreviewStatus,
  previewOccupiedReason,
  startPreview,
  stopPreviewIfOwner,
  stopPreviewsForTask,
} from "./preview-manager";
import { getRepoPreviewCommand } from "./settings-fs";
import { getTaskMeta } from "./task-fs";
import { getTaskWorkRepoPaths } from "./task-worktrees";

// ----------------- 共用的启动准入 -----------------

export type PreviewLaunchResult =
  | { ok: true; slot: PreviewSlotStatus; replacedTaskTitle: string | null }
  | { ok: false; status: number; error: string };

const launchFail = (status: number, error: string): PreviewLaunchResult => ({ ok: false, status, error });

/**
 * 起预览：校验任务 / 仓 / 命令 / 工作区，通过后交给 preview-manager。
 *
 * @param takeOver true = 同仓被别的任务占着就顶掉它（UI 点「预览」的语义）；false = 被占就拒绝（agent 工具的语义）
 * @returns 失败时 `status` 是路由该回的 HTTP 码；文案原样给用户 / agent 看
 */
export const launchTaskPreview = async (input: {
  taskId: string;
  repoPath: string;
  takeOver: boolean;
}): Promise<PreviewLaunchResult> => {
  const { taskId, repoPath, takeOver } = input;

  // 只用 repoPaths / repoStatus / title 等 meta 字段，不必整文件 parse 事件日志
  const task = await getTaskMeta(taskId);
  if (!task) return launchFail(404, "task 不存在");
  // finalize 清理窗内 / 终态任务拒起预览——finalize 会 stopPreviews 后
  // removeTaskWorktrees，此窗口起的新 dev server 会变成 cwd 已删的孤儿进程
  if (getChatLifecycle(taskId) !== null) {
    return launchFail(409, "任务正在停止/终结、暂不能起预览");
  }
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
    return launchFail(409, "任务已终结、不能起预览");
  }
  const idx = task.repoPaths.indexOf(repoPath);
  if (idx < 0) return launchFail(400, `repoPath 不属于该任务：${repoPath}`);

  // 命令唯一来源 = 设置页 per-repo 配置（服务端权威 config.json）、不接受请求注入
  const command = await getRepoPreviewCommand(repoPath);
  if (!command) {
    return launchFail(409, "该仓库未配置预览启动命令（设置页 → 仓库列表）");
  }

  // 工作目录：隔离 task = 该仓 worktree、非隔离 = 原仓库（getTaskWorkRepoPaths 统一处理）
  const workDir = getTaskWorkRepoPaths(task)[idx];
  try {
    await fs.access(workDir);
  } catch {
    return launchFail(409, "任务工作区还没创建（先推进一次任务、系统会自动建隔离工作区）");
  }

  // 「被占就拒绝」的话术给 agent 看：别想办法绕、交给用户定
  const occupiedAdvice = (reason: string): string => `${reason}：不要顶掉它，告诉用户、由用户决定`;
  // 前置快速检查：被占着就不必进队列、也不必让 manager 走一遍。但这一步不是原子的（查完到真正 spawn 之间有 await），
  // 两个任务同时 start 同一个仓时都能查到「没人占」——所以 takeOver:false 还要交给 manager 在串行队列里再判一次（下面）
  if (!takeOver) {
    const occupied = getPreviewStatus().find((s) => s.repoPath === repoPath && !s.exited && s.taskId !== taskId);
    if (occupied) return launchFail(409, occupiedAdvice(previewOccupiedReason(occupied.taskTitle)));
  }

  const started = await startPreview({
    taskId,
    taskTitle: task.title,
    repoPath,
    workDir,
    command,
    takeOver,
  });
  // 队列内让位（最终准入拒绝 finalize/DELETE 已完成 / 不顶人时被别的任务抢先占了）→ 409，无新 pid
  if (started.yielded) {
    const reason = started.yieldReason ?? "任务已终结或正在停止、不能起预览";
    // 被别的任务抢先占了：和前置检查同一套话术；其余让位原因（终结 / 停止）与它无关、原样
    return launchFail(409, started.occupied ? occupiedAdvice(reason) : reason);
  }
  return { ok: true, slot: started.status, replacedTaskTitle: started.replacedTaskTitle };
};

// ----------------- agent 的 `preview` 工具 -----------------

export const PREVIEW_TOOL_ACTIONS = ["start", "status", "stop"] as const;
export type PreviewToolAction = (typeof PREVIEW_TOOL_ACTIONS)[number];

/** start 之后最多等多久，等「探到地址」或「进程退出」；到点还没好就如实返回 starting，让 agent 自己用 `wait` + status 接着看 */
export const PREVIEW_START_WAIT_MS = 20_000;
const START_POLL_MS = 500;
/** 回给 agent 的日志尾巴：行数与单行长度都封顶（日志只是用来判断起没起来，不是让它读全文） */
const LOG_TAIL_LINES = 30;
const LOG_LINE_MAX_CHARS = 300;
const PROBE_TIMEOUT_MS = 3000;

export interface PreviewProbeResult {
  reachable: boolean;
  /** 收到 HTTP 响应时的状态码（任何状态码都算「连得上」）；连不上为 null */
  httpStatus: number | null;
}
export type PreviewProbe = (url: string) => Promise<PreviewProbeResult | null>;

/**
 * 探一下地址连不连得上。只探本机回环地址（地址来自 dev server 的输出，输出里写什么都不能让 server 去请求外网），
 * 其它一律不探（返回 null = 不知道）。不读响应体、不跟随重定向。
 */
export const probePreviewUrl: PreviewProbe = async (url) => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host !== "localhost" && host !== "127.0.0.1") return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    return { reachable: true, httpStatus: res.status };
  } catch {
    return { reachable: false, httpStatus: null };
  }
};

export type PreviewToolState = "starting" | "running" | "exited";

const HINT: Record<PreviewToolState, string> = {
  starting:
    "还在启动（没探到地址，或地址还连不上）：用 `wait` 等几十秒后再 `preview` action=status；超过 2 分钟仍没好，看 log_tail 判断是编译慢还是报错 / 端口被占。",
  running: "已可访问：用浏览器工具（browser_navigate）打开 url 看页面；改了代码一般会热更新，不用重起。",
  exited:
    "进程已退出：看 exit_code 和 log_tail 找原因（依赖没装 / 端口被占 / 命令配错）；能自己修的修完后 action=start 重起，要改设置页里的预览命令就告诉用户。",
};

const describeSlot = async (
  slot: PreviewSlotStatus,
  probe: PreviewProbe,
): Promise<Record<string, unknown>> => {
  const reach = !slot.exited && slot.url ? await probe(slot.url) : null;
  const state: PreviewToolState = slot.exited
    ? "exited"
    : slot.url && reach?.reachable !== false
      ? "running"
      : "starting";
  return {
    repo_path: slot.repoPath,
    state,
    url: slot.url,
    // null = 没探 / 不知道（还没地址，或地址不是回环）；false = 地址有了但连不上（多半还在编译）
    reachable: reach ? reach.reachable : null,
    http_status: reach?.httpStatus ?? null,
    exit_code: slot.exited ? slot.exitCode : null,
    uptime_seconds: Math.max(0, Math.round((Date.now() - slot.startedAt) / 1000)),
    command: slot.command,
    work_dir: slot.workDir,
    log_tail: slot.logTail.slice(-LOG_TAIL_LINES).map((l) => (l.length > LOG_LINE_MAX_CHARS ? `${l.slice(0, LOG_LINE_MAX_CHARS)}…` : l)),
    hint: HINT[state],
  };
};

const toolFail = (error: string): Record<string, unknown> => ({ ok: false, error });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DispatchPreviewOpts {
  /** start 后最多等多久（测试里压小） */
  waitMs?: number;
  /** 探地址的实现（测试注入） */
  probe?: PreviewProbe;
}

/**
 * `preview` 工具的业务体。调用方（flowship-tools）已验过 callerToken。
 * 返回值是要 JSON 化给 agent 的对象：失败 `{ ok:false, error }`（工具行据此标红，见 tool-result-persist）。
 */
export const dispatchPreviewTool = async (
  args: { taskId: string; action: string; repoPath?: string },
  opts: DispatchPreviewOpts = {},
): Promise<Record<string, unknown>> => {
  const probe = opts.probe ?? probePreviewUrl;
  const waitMs = opts.waitMs ?? PREVIEW_START_WAIT_MS;
  const { taskId } = args;
  const action = args.action as PreviewToolAction;
  if (!PREVIEW_TOOL_ACTIONS.includes(action)) {
    return toolFail(`action 只能是 ${PREVIEW_TOOL_ACTIONS.join(" / ")}`);
  }

  const task = await getTaskMeta(taskId);
  if (!task) return toolFail("任务不存在");
  const repoArg = args.repoPath?.trim() || undefined;
  if (repoArg && !task.repoPaths.includes(repoArg)) {
    return toolFail(`repo_path 不属于本任务：${repoArg}。本任务的仓：${task.repoPaths.join("、") || "（没有）"}`);
  }

  const own = () => getPreviewStatus().filter((s) => s.taskId === taskId);

  if (action === "status") {
    const slots = own().filter((s) => !repoArg || s.repoPath === repoArg);
    if (slots.length > 0) {
      return { ok: true, previews: await Promise.all(slots.map((s) => describeSlot(s, probe))) };
    }
    // 没有本任务的预览：顺手说明有没有被别的任务占着，免得 agent 起了才发现
    const occupied = getPreviewStatus()
      .filter((s) => !s.exited && s.taskId !== taskId && task.repoPaths.includes(s.repoPath))
      .filter((s) => !repoArg || s.repoPath === repoArg)
      .map((s) => ({ repo_path: s.repoPath, task_title: s.taskTitle }));
    return {
      ok: true,
      previews: [],
      ...(occupied.length > 0 ? { occupied_by_other_tasks: occupied } : {}),
      hint: "本任务当前没有在跑的预览：要看页面效果就 action=start。",
    };
  }

  if (action === "stop") {
    const slots = own().filter((s) => !repoArg || s.repoPath === repoArg);
    if (repoArg) {
      const other = getPreviewStatus().find((s) => s.repoPath === repoArg && s.taskId !== taskId);
      if (slots.length === 0 && other) return toolFail(`这个仓的预览是任务「${other.taskTitle}」起的，不是本任务的、不能停`);
      // 前面的归属检查在队列外、不是原子的：真正停的时候由 manager 在队列里再核一次归属（不是本任务的就不动），
      // 不能按仓直接停——否则会把「刚被用户在 UI 接管过去」的别人的预览误杀
      await stopPreviewIfOwner(repoArg, taskId).catch(() => {});
    } else {
      await stopPreviewsForTask(taskId).catch(() => {});
    }
    return { ok: true, stopped: slots.map((s) => s.repoPath), hint: slots.length ? "已停止" : "本任务没有在跑的预览" };
  }

  // ---- start ----
  let repoPath = repoArg;
  if (!repoPath) {
    if (task.repoPaths.length === 1) repoPath = task.repoPaths[0];
    else if (task.repoPaths.length === 0) return toolFail("本任务没有关联仓库、没有可预览的项目");
    else return toolFail(`本任务有多个仓、必须用 repo_path 指定要预览哪个：${task.repoPaths.join("、")}`);
  }
  const running = own().find((s) => s.repoPath === repoPath && !s.exited);
  if (running) {
    // 已经在跑：不重起（重起会白白丢掉编译缓存 / 日志）。要重起请先 stop 再 start
    return { ok: true, already_running: true, ...(await describeSlot(running, probe)) };
  }

  const launched = await launchTaskPreview({ taskId, repoPath, takeOver: false });
  if (!launched.ok) return toolFail(launched.error);

  // 等「探到地址」或「进程退出」；期间任务被停止 / 预览位被别的任务顶掉也立刻收手
  const deadline = Date.now() + waitMs;
  let cur: PreviewSlotStatus | undefined = launched.slot;
  while (Date.now() < deadline) {
    cur = getPreviewStatus().find((s) => s.repoPath === repoPath);
    if (!cur || cur.taskId !== taskId || cur.exited || cur.url) break;
    if (getChatLifecycle(taskId) !== null) break;
    await sleep(START_POLL_MS);
  }
  if (!cur || cur.taskId !== taskId) {
    return toolFail("刚起的预览已经被停掉或被别的任务顶掉了：用 action=status 看现状");
  }
  return { ok: true, started: true, ...(await describeSlot(cur, probe)) };
};
