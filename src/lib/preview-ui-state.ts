/**
 * 预览控件（任务页仓卡片里的 ▶ 预览）的纯逻辑：状态推导 / 端口标签 / 轮询节奏 / 文案。
 *
 * 不依赖 React / DOM，单测直接跑（tests/preview-ui-state.test.ts）。
 * 组件见 components/tasks/preview-control.tsx；server 侧管理见 server/preview-manager.ts。
 */

import type { PreviewSlotStatus } from "@/lib/types";

/** 起进程后这么久还没从输出里探到本地地址，就不再说「启动中」，改说「运行中（未探测到地址）」 */
export const PREVIEW_URL_PROBE_GRACE_MS = 30_000;
/** 有预览正在启动 / 日志弹窗开着时的轮询间隔（地址一探到就尽快亮出来） */
export const PREVIEW_POLL_FAST_MS = 1500;
/** 平时的轮询间隔（本地接口，很轻） */
export const PREVIEW_POLL_IDLE_MS = 4000;
/** 状态接口只带日志的最后这么多行（server 截尾、弹窗标题也据此写明，别让人以为是全部日志） */
export const PREVIEW_LOG_TAIL_LINES = 50;

/**
 * - idle：本任务在该仓没有预览位（可启动）
 * - starting：进程在跑、还没探到地址、且在宽限期内
 * - ready：进程在跑、已探到地址（可打开）
 * - running：进程在跑、超过宽限期仍没探到地址（命令可能不是 web 服务 / 输出格式探不到）
 * - exited：进程已退出（启动失败 / 被外部杀 / 正常结束）
 */
export type PreviewPhase = "idle" | "starting" | "ready" | "running" | "exited";

export const derivePreviewPhase = (
  slot: PreviewSlotStatus | undefined,
  now: number,
): PreviewPhase => {
  if (!slot) return "idle";
  if (slot.exited) return "exited";
  if (slot.url) return "ready";
  return now - slot.startedAt < PREVIEW_URL_PROBE_GRACE_MS ? "starting" : "running";
};

/** 进程是否还活着（starting / ready / running） */
export const isPreviewAlive = (phase: PreviewPhase): boolean =>
  phase === "starting" || phase === "ready" || phase === "running";

/** 地址里的端口标签（`http://localhost:8000/x` → `:8000`）；解析不出就退回 host，没地址返回 null */
export const previewPortLabel = (url: string | null): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.port ? `:${u.port}` : u.host;
  } catch {
    return null;
  }
};

/**
 * 轮询间隔：任一预览位还在「启动中」、或有日志弹窗开着 → 快；否则慢。
 * 启动中的快轮询自带上限（宽限期 30s 后 phase 变 running 就回到慢档），不会无限高频。
 */
export const previewPollInterval = (opts: { anyStarting: boolean; logOpen?: boolean }): number =>
  opts.anyStarting || opts.logOpen ? PREVIEW_POLL_FAST_MS : PREVIEW_POLL_IDLE_MS;

/**
 * 把一次轮询拿到的全表快照并进本地 slots。
 *
 * 为什么不能整表覆盖：重启 / 停止时服务端是「先删旧槽、杀进程（最长约 2 秒）、再放新槽」，
 * 这段空窗里一次轮询会看到「这个仓没有预览」——整表覆盖会让胶囊闪回「▶ 预览」、日志弹窗被当成预览位没了而强制关掉；
 * 停止请求发出前就已在途的轮询，响应回来还会把刚被摘掉的槽位写回去。
 * 所以「本地有请求在途」的仓（pendingRepoPaths）以本地为准：保留本地已有的槽位、忽略快照里关于它的说法，
 * 请求结束后再采信快照；其余仓照常以快照为准。
 */
export const mergePreviewSnapshot = (
  prev: readonly PreviewSlotStatus[],
  snapshot: readonly PreviewSlotStatus[],
  pendingRepoPaths: ReadonlySet<string>,
): PreviewSlotStatus[] => {
  if (pendingRepoPaths.size === 0) return [...snapshot];
  return [
    ...snapshot.filter((s) => !pendingRepoPaths.has(s.repoPath)),
    ...prev.filter((s) => pendingRepoPaths.has(s.repoPath)),
  ];
};

/** 已运行时长：刚启动 / N 秒 / N 分钟 / N 小时 N 分 */
export const formatPreviewUptime = (startedAt: number, now: number): string => {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 5) return "刚刚启动";
  if (sec < 60) return `已运行 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `已运行 ${min} 分钟`;
  const hour = Math.floor(min / 60);
  const rest = min % 60;
  return rest > 0 ? `已运行 ${hour} 小时 ${rest} 分钟` : `已运行 ${hour} 小时`;
};

/** 退出原因：有退出码就带码；null = 被信号终止（用户停止 / 外部 kill） */
export const describePreviewExit = (slot: Pick<PreviewSlotStatus, "exitCode">): string =>
  slot.exitCode === null ? "已退出（被终止）" : slot.exitCode === 0 ? "已正常退出" : `已退出（退出码 ${slot.exitCode}）`;

/** 状态一句话（tooltip / 日志弹窗副标题共用） */
export const previewStatusText = (
  phase: PreviewPhase,
  slot: PreviewSlotStatus | undefined,
  now: number,
): string => {
  if (!slot || phase === "idle") return "未启动";
  switch (phase) {
    case "starting":
      return `启动中（${formatPreviewUptime(slot.startedAt, now)}），探测到地址后可直接打开`;
    case "ready":
      return `运行中 · ${slot.url}（${formatPreviewUptime(slot.startedAt, now)}）`;
    case "running":
      return `运行中（${formatPreviewUptime(slot.startedAt, now)}），但没从输出里探测到访问地址`;
    case "exited":
      return describePreviewExit(slot);
  }
};

/** 同仓被别的任务占着时、启动钮 tooltip 里的提醒（无占用返回 null） */
export const previewOccupiedHint = (
  occupiedBy: Pick<PreviewSlotStatus, "taskTitle" | "exited"> | undefined,
): string | null =>
  occupiedBy && !occupiedBy.exited
    ? `该仓预览正被「${occupiedBy.taskTitle}」占用，启动会替换它`
    : null;
