/**
 * 「清理隔离工作区」的结果回报（删任务 / 归档 / 存储页清残留 共用；client-safe、零 IO）。
 *
 * 动机（第三轮 review F1-03 / D2b-06）：服务端的 WIP 快照守卫在「脏且存不下」时会**保留**目录、不删，
 * 但调用方（deleteTask、归档 toast）此前要么把结果整个丢掉，要么由客户端按任务形状「预测」成已清理——
 * 文案与行为不同源。现在服务端把实际结果放进响应，客户端文案只认这份。
 */

/** 一个因快照失败被保留的 worktree */
export interface WorktreeKeptDto {
  /** 原仓库路径 */
  repoPath: string;
  /** 被保留的 worktree 目录 */
  workDir: string;
  reason: string;
}

/** 删前落了 WIP 快照的仓 */
export interface WorktreeSnapshotDto {
  repoPath: string;
  /** `refs/flowship/wip/<task>-<repo>` */
  ref: string;
}

/** `deleteTask(id, report)` 的出参（out-param：持锁函数里一路收集，不改 boolean 返回值） */
export interface DeleteWorktreeReport {
  kept: WorktreeKeptDto[];
  snapshots: WorktreeSnapshotDto[];
}

export const newDeleteWorktreeReport = (): DeleteWorktreeReport => ({ kept: [], snapshots: [] });

/** removeTaskWorktrees 返回值里与回报相关的子集（旧调用方 / mock 可不带详细字段，回退到仓路径列表） */
interface RemovedLike {
  snapshotFailedRepos: string[];
  snapshots?: Array<{ repoPath: string; ref: string }>;
  snapshotFailures?: Array<{ repoPath: string; workDir: string; reason: string }>;
}

/** 把 removeTaskWorktrees 的结果收进 report */
export const collectWorktreeRemoval = (
  report: DeleteWorktreeReport | undefined,
  removed: RemovedLike | null | undefined,
): void => {
  if (!report || !removed) return;
  if (removed.snapshotFailures && removed.snapshotFailures.length > 0) {
    for (const f of removed.snapshotFailures) {
      report.kept.push({ repoPath: f.repoPath, workDir: f.workDir, reason: f.reason });
    }
  } else {
    for (const repoPath of removed.snapshotFailedRepos) {
      report.kept.push({ repoPath, workDir: "", reason: "未提交改动无法自动保存" });
    }
  }
  for (const s of removed.snapshots ?? []) {
    report.snapshots.push({ repoPath: s.repoPath, ref: s.ref });
  }
};

/** 响应里只在有内容时才带这两个字段（保持常见情况的响应精简） */
export const worktreeReportBody = (
  report: DeleteWorktreeReport,
): { worktreeKept?: WorktreeKeptDto[]; worktreeSnapshots?: WorktreeSnapshotDto[] } => ({
  ...(report.kept.length > 0 ? { worktreeKept: report.kept } : {}),
  ...(report.snapshots.length > 0 ? { worktreeSnapshots: report.snapshots } : {}),
});

const repoName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 归档响应里的工作区清理结果（服务端实际做了什么） */
export interface ArchiveWorktreeReport {
  /** 本次真的删掉了至少一个隔离工作区目录 */
  removed: boolean;
  /** 快照失败而保留的目录 */
  kept: WorktreeKeptDto[];
  /** 落了 WIP 快照的仓数 */
  snapshotCount: number;
}

/** 归档 / 取消归档的服务端回报 */
export interface ArchiveReport {
  /** undefined = 该任务没有隔离工作区流程（chat / 非 worktree 任务） */
  worktree?: ArchiveWorktreeReport;
  /** 本次归档取消的定时条数 */
  cancelledSchedules: number;
  /** 取消归档时恢复的定时条数 */
  restoredSchedules: number;
  /** 取消归档时发现一次性定时在归档期间已过点、被如实改写成「已错过」的条数（Q9-06；旧服务端不带 = 0） */
  missedSchedules?: number;
  /** 取消归档时发现周期定时已用满次数、被改写成「已结束」的条数（Q9-06；旧服务端不带 = 0） */
  endedSchedules?: number;
}

export const emptyArchiveReport = (): ArchiveReport => ({
  cancelledSchedules: 0,
  restoredSchedules: 0,
});

export interface UserToast {
  kind: "success" | "warning";
  message: string;
}

/** 保留的目录 → 一句人话（只点仓名，不暴露 ref / git 命令） */
const keptSentence = (kept: WorktreeKeptDto[]): string => {
  const names = Array.from(new Set(kept.map((k) => repoName(k.repoPath))));
  const shown = names.slice(0, 3).join("、") + (names.length > 3 ? ` 等 ${names.length} 个仓` : "");
  return `${shown} 的工作区里有未提交的改动没能自动保存，目录已保留、没有清理`;
};

/**
 * 归档 toast：只认服务端实际返回，不再按任务形状预测。
 * - 工作区：removed → 「已清理隔离工作区」；kept 非空 → warning（目录仍在）；undefined → 不提
 * - 定时：取消了 N 条就说出来（取消归档时能恢复）
 */
export const buildArchiveToast = (input: {
  title: string;
  /** 归档时任务还在跑（用户确认过）：影响「已停止」「仍在后台跑」措辞 */
  wasRunning: boolean;
  report: ArchiveReport | undefined;
  /** 没有任何别的信息可说时，朴素文案后面追加的提示（侧栏用来指路「可在会话管理找回」） */
  plainSuffix?: string;
}): UserToast => {
  const { title, wasRunning } = input;
  const report = input.report ?? emptyArchiveReport();
  const wt = report.worktree;
  const parts: string[] = [];
  if (wt) {
    // 有 worktree 回报 = 服务端走了「停 agent + 清工作区」分支（chat / 非隔离任务没有这段）
    const rest = wt.kept.length > 0 ? "其余" : "";
    if (wt.removed) parts.push(wasRunning ? `已停止并清理${rest}隔离工作区` : `已清理${rest}隔离工作区`);
    else if (wasRunning) parts.push("已停止");
  } else if (wasRunning) {
    parts.push("任务仍在后台跑");
  }
  if (wt && wt.removed && wt.snapshotCount > 0) {
    parts.push("未提交的改动已存成快照");
  }
  if (report.cancelledSchedules > 0) {
    parts.push(`${report.cancelledSchedules} 个定时已取消（取消归档可恢复）`);
  }
  const head = `已归档「${title}」`;
  const body = parts.filter(Boolean).join("、");
  const base = body ? `${head}、${body}` : `${head}${input.plainSuffix ?? ""}`;
  if (wt && wt.kept.length > 0) {
    return { kind: "warning", message: `${base}。${keptSentence(wt.kept)}` };
  }
  return { kind: "success", message: base };
};

/**
 * 取消归档后有没有定时相关的话要说（恢复了 / 已过点记为已错过 / 已用满次数记为已结束）。
 * 归档 toast 承诺过「N 个定时已取消（取消归档可恢复）」——结果与承诺对不上的两类（Q9-06）也要说，不能静默。
 */
export const restoreToastNeeded = (report: ArchiveReport | undefined): boolean =>
  (report?.restoredSchedules ?? 0) + (report?.missedSchedules ?? 0) + (report?.endedSchedules ?? 0) > 0;

/** 取消归档的定时结果拆成人话分句（toast 与服务端 info 事件共用口径） */
export const restoreScheduleParts = (report: ArchiveReport | undefined): string[] => {
  const parts: string[] = [];
  const restored = report?.restoredSchedules ?? 0;
  const missed = report?.missedSchedules ?? 0;
  const ended = report?.endedSchedules ?? 0;
  if (restored > 0) parts.push(`${restored} 个定时已恢复`);
  if (missed > 0) parts.push(`${missed} 个定时在归档期间已过点、记为「已错过」`);
  if (ended > 0) parts.push(`${ended} 个定时已用满次数、记为「已结束」`);
  return parts;
};

/** 取消归档 toast：定时恢复了 / 没能恢复都说一声 */
export const buildRestoreToast = (title: string, report: ArchiveReport | undefined): string => {
  const parts = restoreScheduleParts(report);
  return parts.length > 0 ? `已恢复「${title}」、${parts.join("、")}` : `已恢复「${title}」`;
};

export type DeleteWorktreeReportBody = ReturnType<typeof worktreeReportBody>;

/** 删任务 toast：保留的目录要说；落了快照的告诉用户能找回 */
export const buildDeleteToast = (
  title: string,
  report: DeleteWorktreeReportBody | undefined,
): UserToast => {
  const kept = report?.worktreeKept ?? [];
  const snaps = report?.worktreeSnapshots ?? [];
  const base = `已彻底删除「${title}」`;
  if (kept.length > 0) {
    return { kind: "warning", message: `${base}。${keptSentence(kept)}，可到「会话管理」的残留工作区处理` };
  }
  if (snaps.length > 0) {
    return { kind: "success", message: `${base}、工作区里未提交的改动已存成快照` };
  }
  return { kind: "success", message: base };
};

/** 存储页「删除残留工作区」被守卫拦下（409）时给二次确认框的说明 */
export const buildStaleForceDescription = (
  kept: Array<{ dirName: string; reason: string; snapshotSaved?: boolean }>,
): string => {
  const line = (k: { dirName: string; reason: string; snapshotSaved?: boolean }) =>
    `· ${k.dirName}：${k.reason}${k.snapshotSaved ? "（改动已存成快照）" : ""}`;
  const lines = kept.slice(0, 5).map(line);
  const more = kept.length > 5 ? `\n…另有 ${kept.length - 5} 个` : "";
  // 快照其实已落 ref、只是目录没删掉（占用 / 权限）：不能说「找不回了」（第四轮 Q3-07）
  if (kept.length > 0 && kept.every((k) => k.snapshotSaved)) {
    return `这些目录里的未提交改动已存成快照，只是目录没能删掉（可能被占用或没有权限），重试不会丢代码：\n${lines.join("\n")}${more}`;
  }
  return `这些目录里可能有没存下来的未提交代码，继续删除就找不回了：\n${lines.join("\n")}${more}`;
};

/** 存储页删除残留工作区的结果：ok = 已处理；kept = 守卫拦下了（未提交改动存不下），目录还在 */
export type StaleDeleteOutcome =
  | { kind: "ok"; snapshots: Array<{ ref: string }> }
  | { kind: "kept"; kept: Array<{ dirName: string; reason: string; snapshotSaved?: boolean }> };

/**
 * 解释 `DELETE /api/system/storage?stale=` 的响应：
 * 200 → ok；409 且带 `kept` → 守卫拦下（调用方再问用户要不要强删）；其余（含「任务仍存在」的 409）→ 抛出服务端原话。
 */
export const interpretStaleDeleteResponse = (status: number, body: unknown): StaleDeleteOutcome => {
  const data = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    kept?: unknown;
    snapshots?: unknown;
  };
  if (status >= 200 && status < 300) {
    const snapshots = Array.isArray(data.snapshots) ? (data.snapshots as Array<{ ref: string }>) : [];
    return { kind: "ok", snapshots };
  }
  if (status === 409 && Array.isArray(data.kept) && data.kept.length > 0) {
    return {
      kind: "kept",
      kept: data.kept as Array<{ dirName: string; reason: string; snapshotSaved?: boolean }>,
    };
  }
  throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${status}`);
};

/** 存储页单个残留工作区删除成功后的 toast */
export const buildStaleDeletedToast = (
  snapshots: Array<{ ref: string }> | undefined,
): string =>
  snapshots && snapshots.length > 0
    ? `已删除残留工作区、其中 ${snapshots.length} 个目录里未提交的改动已存成快照`
    : "已删除残留工作区";

/**
 * 给错误文案加「删除失败：」前缀，但服务端原话已经带了就不再叠（第四轮 Q3-13②：UI 曾显示「删除失败：删除失败：…」——
 * `task-store.handleJson` 把服务端 `error`（形如「删除失败：xxx。任务没有被删除，可以稍后重试」）原样当 message）。
 */
export const withDeleteFailurePrefix = (message: string): string => {
  const m = message.trim();
  if (!m) return "删除失败";
  return /^删除.{0,6}失败/.test(m) ? m : `删除失败：${m}`;
};
