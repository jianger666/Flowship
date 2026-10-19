/**
 * 后台 shell 的「还在跑」标记（前后端共用的纯函数，不碰 fs / 不 import 服务端模块）
 *
 * 问题：Cursor SDK 的 shell 工具超过 block_until_ms（或模型要求后台跑）时会把进程转后台，
 * 同时把这次 tool_call 当成功结束（status=success、exit 0、输出为空 / 只有头几行）。
 * 对事件流来说这块工具已经「完成」——图标变成绿色终端，可进程其实还在跑，
 * AI 往往紧接着调 `wait` 等它。用户看到的是「已完成」，实际还没完。
 *
 * SDK 公开的 tool_call / shell-output-delta 都不带「已转后台」信号（pid / shellId /
 * isBackground 在 proto 里有、公开 JSON 里被剥掉了），所以由服务端去读 SDK 自己写的终端文件
 * 判断（见 server/shell-background-tracker.ts），把结论落成两种 info 标记事件：
 *   - phase=running：这条 callId 的 shell 已转后台、仍在运行
 *   - phase=ended：它跑完了（reason=exited），或本轮 run 收尾时不再关心它（reason=run-ended）
 *
 * 渲染层：只在会话还在 running 时，把「最新标记是 running」的 shell 块标上
 * `backgroundRunning`，图标走转圈。标记事件本身不渲染（见 event-stream-hidden）。
 */

import type { TaskEvent } from "@/lib/types";

export const SHELL_BACKGROUND_META_KEY = "shellBackground" as const;

export type ShellBackgroundPhase = "running" | "ended";

/**
 * exited：进程自己结束了（终端文件状态不再是 running）
 * run-ended：本轮 run 收尾（完成 / 取消 / 出错），进程可能还在跑，但这一轮不再展示转圈
 */
export type ShellBackgroundEndReason = "exited" | "run-ended";

export type ShellBackgroundMeta = {
  callId: string;
  phase: ShellBackgroundPhase;
  /** 进程 pid（来自终端文件头；只用于排查，不参与判定） */
  pid?: number;
  /** phase=ended 才有 */
  reason?: ShellBackgroundEndReason;
};

/** 标记事件的文案（事件流里不渲染，只给人翻 events.jsonl 时看） */
export const SHELL_BACKGROUND_RUNNING_TEXT = "后台 shell 运行中";
export const SHELL_BACKGROUND_ENDED_TEXT = "后台 shell 已结束";

/** 构造要落盘的标记事件（kind=info，meta.shellBackground = 标记体） */
export const buildShellBackgroundEvent = (
  meta: ShellBackgroundMeta,
): { kind: "info"; text: string; meta: Record<string, unknown> } => ({
  kind: "info",
  text:
    meta.phase === "running"
      ? SHELL_BACKGROUND_RUNNING_TEXT
      : SHELL_BACKGROUND_ENDED_TEXT,
  meta: { [SHELL_BACKGROUND_META_KEY]: meta },
});

/** 从事件里取标记体；不是标记 / 形态不对 → null */
export const shellBackgroundOf = (
  ev: Pick<TaskEvent, "kind" | "meta">,
): ShellBackgroundMeta | null => {
  if (ev.kind !== "info") return null;
  const raw = ev.meta?.[SHELL_BACKGROUND_META_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.callId !== "string" || r.callId === "") return null;
  if (r.phase !== "running" && r.phase !== "ended") return null;
  return {
    callId: r.callId,
    phase: r.phase,
    ...(typeof r.pid === "number" ? { pid: r.pid } : {}),
    ...(r.reason === "exited" || r.reason === "run-ended"
      ? { reason: r.reason }
      : {}),
  };
};

/** 这条事件是后台 shell 标记吗（事件流据此不渲染；只滤显示、不滤落盘） */
export const isShellBackgroundMarkerEvent = (
  ev: Pick<TaskEvent, "kind" | "meta">,
): boolean => shellBackgroundOf(ev) !== null;

export type RunningBackgroundShell = {
  callId: string;
  /** 旁路 run 的标（meta.groupRun）；属主自己的没有。收尾补写 ended 必须带回同一个标 */
  groupRun?: string;
};

/**
 * 扫事件流：每个 callId 取**最后一条**标记，最后一条是 running 的才算「还在后台跑」。
 * 顺序按数组顺序（落盘顺序）——同一 callId 的 ended 一定晚于它的 running。
 */
export const collectRunningBackgroundShells = (
  events: readonly TaskEvent[],
): RunningBackgroundShell[] => {
  const latest = new Map<string, { phase: ShellBackgroundPhase; groupRun?: string }>();
  for (const ev of events) {
    const m = shellBackgroundOf(ev);
    if (!m) continue;
    const rawTag = ev.meta?.groupRun;
    const groupRun = typeof rawTag === "string" ? rawTag.trim() : "";
    latest.set(m.callId, {
      phase: m.phase,
      ...(groupRun ? { groupRun } : {}),
    });
  }
  const out: RunningBackgroundShell[] = [];
  for (const [callId, v] of latest) {
    if (v.phase !== "running") continue;
    out.push({ callId, ...(v.groupRun ? { groupRun: v.groupRun } : {}) });
  }
  return out;
};

/** 渲染层只要 callId 集合 */
export const collectRunningBackgroundCallIds = (
  events: readonly TaskEvent[],
): Set<string> =>
  new Set(collectRunningBackgroundShells(events).map((s) => s.callId));
