/**
 * Worker 翻转接线（v3.1 接线层 B1：flag-gated，默认关闭零行为变化）。
 *
 * - 5 kind 真 handler 注册：反查 API 按 §5.1 表——merge-request 走 GitLab
 *   findOpenMR（已验证的幂等底座）、git-push 走 fetch+rev-parse 对账、
 *   feishu/notify 无查询 API 走 at-most-once（永不自动重发）、external-api
 *   按对方幂等键能力分流；
 * - handler 需要结构化参数（分支/项目/文案）时经 payloadProvider 取——intent
 *   记录本身只带 payloadHash，真参数由 task-runner 接线时从 tool-call 日志供给；
 * - recoverWithWorker：boot recovery  Plan B 入口（flag 开才调），WAL + 全量
 *   shim 合并扫描（B4），不需要 workspace 映射——shim 行自带 taskId；
 * - 本地写不进本循环（只记账、走 checkpoint，修订三1）。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "./data-root";
import {
  appendIntent,
  loadIntents,
  loadShimIntents,
  markIntentDone,
  type IntentKind,
  type IntentRecord,
} from "./intent-log";
import {
  executeIntentRecords,
  type ExecuteSummary,
  type IntentHandler,
  type IntentHandlerRegistry,
  type IntentVerdict,
} from "./intent-executor";
import { recordToolCallArgs } from "./tool-call-args";
import { buildSideEffectIdempotencyKey } from "./mem-governance";
import { isWorkerIsolationEnabled } from "./worker-mode";

export interface FlipPayload {
  projectPath?: string;
  sourceBranch?: string;
  targetBranch?: string;
  localCommit?: string;
  idempotencyKeySupported?: boolean;
  remoteHasKey?: boolean;
  /** ④修复：force-push 意图 → handler 直接 abandoned 人工（重推可能 destructive）。 */
  forcePush?: boolean;
}

export type PayloadProvider = (
  rec: IntentRecord,
) => Promise<FlipPayload | null>;

export interface FlipDeps {
  payloadProvider: PayloadProvider;
  /** merge-request 反查：按 sourceBranch 找 open MR（默认实现调 gitlab findOpenMR，由接线层注入）。 */
  findOpenMergeRequest?: (p: {
    projectPath: string;
    sourceBranch: string;
    targetBranch: string;
  }) => Promise<{ found: boolean }>;
  /** git-push 对账：origin/<branch> 是否已含 localCommit（默认实现调 git，由接线层注入）。
   * ④修复：返回 null = 无法安全判定 → abandoned 人工（如下游检测到 force-push 意图）。 */
  isCommitPushed?: (p: {
    workDir: string;
    branch: string;
    commit: string;
  }) => Promise<boolean | null>;
  workDirOf?: (taskId: string) => string;
}

/**
 * 5 kind 真 handler：查得到 → done（已生效，不重做）；查不到 → not-present
 * （执行器按 decideIntentRecovery 分流：at-most-once 的 abandoned，可重试的当场重调）；
 * 参数缺失 → abandoned（人工兜底，不猜参数）。
 */
export const buildWorkerIntentHandlers = (
  deps: FlipDeps,
): IntentHandlerRegistry => {
  const need = async (
    rec: IntentRecord,
  ): Promise<{ payload: FlipPayload } | { abandoned: string }> => {
    const payload = await deps.payloadProvider(rec);
    if (!payload) return { abandoned: "无 tool-call 参数（payload 缺失），人工兜底" };
    return { payload };
  };

  const mergeRequest: IntentHandler = async (rec) => {
    const got = await need(rec);
    if ("abandoned" in got) return { verdict: "abandoned", reason: got.abandoned };
    const { projectPath, sourceBranch, targetBranch } = got.payload;
    if (!projectPath || !sourceBranch || !targetBranch) {
      return { verdict: "abandoned", reason: "MR 反查缺分支参数" };
    }
    if (!deps.findOpenMergeRequest) {
      return { verdict: "abandoned", reason: "未注入 findOpenMergeRequest（待 task-runner 接线）" };
    }
    const hit = await deps.findOpenMergeRequest({ projectPath, sourceBranch, targetBranch });
    return hit.found ? { verdict: "done" } : { verdict: "not-present" };
  };

  const gitPush: IntentHandler = async (rec) => {
    const got = await need(rec);
    if ("abandoned" in got) return { verdict: "abandoned", reason: got.abandoned };
    // ④修复：force-push 不重放（注释不再是空头支票）。
    if (got.payload.forcePush) {
      return { verdict: "abandoned", reason: "force-push 意图不自动重放，人工确认" };
    }
    const { sourceBranch, localCommit } = got.payload;
    if (!sourceBranch || !localCommit) {
      return { verdict: "abandoned", reason: "push 对账缺分支/commit 参数" };
    }
    if (!deps.isCommitPushed || !deps.workDirOf) {
      return { verdict: "abandoned", reason: "未注入 git 对账实现（待 task-runner 接线）" };
    }
    const pushed = await deps.isCommitPushed({
      workDir: deps.workDirOf(rec.taskId),
      branch: sourceBranch,
      commit: localCommit,
    });
    // null = 无法安全判定 → abandoned；true = 已推 done；false = 缺席 not-present。
    if (pushed === null) {
      return { verdict: "abandoned", reason: "push 对账无法安全判定，人工确认" };
    }
    return pushed ? { verdict: "done" } : { verdict: "not-present" };
  };

  // feishu-message / notify：无查询 API，at-most-once——永不自动重发，直接 abandoned。
  const atMostOnce = (kind: IntentKind): IntentHandler => async () => ({
    verdict: "abandoned" as const,
    reason: `${kind} 无查询 API（at-most-once，宁漏勿重；正文 [ref:] 标记供人工比对）`,
  });

  const externalApi: IntentHandler = async (rec): Promise<IntentVerdict> => {
    const got = await need(rec);
    if ("abandoned" in got) return { verdict: "abandoned", reason: got.abandoned };
    // 对方不支持幂等键透传 → abandoned 不自动重试（§5.1）。
    if (!got.payload.idempotencyKeySupported) {
      return { verdict: "abandoned", reason: "对方不支持幂等键，不自动重试" };
    }
    return got.payload.remoteHasKey ? { verdict: "done" } : { verdict: "not-present" };
  };

  return {
    "merge-request": mergeRequest,
    "git-push": gitPush,
    "feishu-message": atMostOnce("feishu-message"),
    notify: atMostOnce("notify"),
    "external-api": externalApi,
  };
};

/** 扫描 <dataRoot>/workers 下全部 shim 文件（行自带 taskId，不过 workspace 映射）。 */
export const pendingIntentsAll = async (taskId: string): Promise<IntentRecord[]> => {
  const { pendingIntents } = await import("./intent-log");
  const wal = await pendingIntents(taskId);
  const walKeys = new Set((await loadIntents(taskId)).map((r) => r.idempotencyKey));
  const out = [...wal];
  const workersDir = path.join(dataRoot(), "workers");
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(workersDir);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const rows = await loadShimIntents(path.join(workersDir, d)).catch(() => []);
    for (const s of rows) {
      if (s.taskId !== taskId || walKeys.has(s.idempotencyKey)) continue;
      if (out.some((r) => r.idempotencyKey === s.idempotencyKey)) continue;
      out.push(s);
    }
  }
  return out;
};

/**
 * boot recovery Plan B 入口：flag 关直接返回空（零行为变化）。
 * 开：逐 task sweep（handler 无/缺失即 abandoned，见 sweepPendingIntents）。
 */
export const recoverWithWorker = async (
  taskIds: string[],
  deps: FlipDeps,
): Promise<Record<string, ExecuteSummary>> => {
  const out: Record<string, ExecuteSummary> = {};
  if (!isWorkerIsolationEnabled()) return out;
  const handlers = buildWorkerIntentHandlers(deps);
  for (const taskId of taskIds) {
    const pending = await pendingIntentsAll(taskId);
    if (pending.length === 0) continue;
    out[taskId] = await executeIntentRecords(taskId, pending, handlers);
  }
  return out;
};

// ---------- 接线注册表（task-runner 热路径接线时注册真 deps） ----------

let registeredDeps: FlipDeps | null = null;

export const registerFlipDeps = (deps: FlipDeps): void => {
  registeredDeps = deps;
};

export const resetFlipDeps = (): void => {
  registeredDeps = null;
};

/** placeAndConnect 守卫：已有实配不被空配覆盖（task-runner 全配优先）。 */
export const hasFlipDeps = (): boolean => registeredDeps !== null;

export interface RegisteredRecoverySummary {
  executed: boolean;
  scanned: Record<string, number>;
  result: Record<string, ExecuteSummary>;
}

/**
 * task-fs boot recovery 末尾调用（常驻钩子，默认零行为变化）：
 * - flag 关 → 直接返回 {executed:false}，连扫描都不做；
 * - flag 开但 deps 未注册 → 只扫描计数并日志，不写任何 mark（安全侧）；
 * - flag 开且 deps 已注册 → 全量执行。
 */
export const recoverWithRegistered = async (
  taskIds: string[],
): Promise<RegisteredRecoverySummary> => {
  const summary: RegisteredRecoverySummary = { executed: false, scanned: {}, result: {} };
  if (!isWorkerIsolationEnabled()) return summary;
  for (const taskId of taskIds) {
    summary.scanned[taskId] = (await pendingIntentsAll(taskId)).length;
  }
  if (!registeredDeps) {
    console.log(
      `[worker-flip] flag 开但真 deps 未注册：只扫描不执行 ${JSON.stringify(summary.scanned)}`,
    );
    return summary;
  }
  summary.executed = true;
  summary.result = await recoverWithWorker(taskIds, registeredDeps);
  return summary;
};

// ---------- ②修复：写 intent 与执行同处（merge-request 端到端） ----------

import {
  createMR,
  type CreateMRInput,
  type CreateMRResult,
} from "./gitlab-client";
import { getToolCallArgs } from "./tool-call-args";

/**
 * 注册表-backed payloadProvider（placeWorkerForTask 与恢复共用同一实现）。
 * 登记缺失 → null（调用方 abandoned，不猜参数）。
 */
export const registryPayloadProvider = async (
  rec: IntentRecord,
): Promise<FlipPayload | null> => {
  const hit = getToolCallArgs(rec.taskId, rec.toolCallId);
  if (!hit) return null;
  const a = hit.args;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    projectPath: str(a.projectPath) ?? str(a.repoPath),
    sourceBranch: str(a.sourceBranch) ?? str(a.branch),
    targetBranch: str(a.targetBranch),
    localCommit: str(a.commit) ?? str(a.localCommit),
    forcePush: a.forcePush === true,
    idempotencyKeySupported: a.idempotencyKeySupported === true,
    remoteHasKey: a.remoteHasKey === true,
  };
};

/**
 * ②修复：submit_mr 执行点——先记参数 + 落 intent，再调 createMR。
 * - toolCallId 稳定可复算（同 action 同分支重试同键，crash 恢复对得上）；
 * - 埋点失败不挡 MR（try/catch 自吞）；成功落 done，失败留 pending（恢复走反查）；
 * - flag 关也照写：WAL 只记不扫（sweep 只在恢复入口跑），老行为零变化。
 */
export const createMRWithIntent = async (
  args: {
    taskId: string;
    actionId: string;
    forcePush?: boolean;
  } & CreateMRInput,
  create: (input: CreateMRInput) => Promise<CreateMRResult> = createMR,
): Promise<CreateMRResult> => {
  const toolCallId = `submit-mr:${args.actionId}:${args.sourceBranch}:${args.targetBranch}`;
  try {
    recordToolCallArgs({
      taskId: args.taskId,
      actionId: args.actionId,
      toolCallId,
      toolName: "submit_mr",
      args: {
        projectPath: args.projectPath,
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        forcePush: args.forcePush === true,
      },
    });
    const payloadHash = createHash("sha256")
      .update(JSON.stringify([args.projectPath, args.sourceBranch, args.targetBranch, args.title]))
      .digest("hex")
      .slice(0, 16);
    await appendIntent({
      taskId: args.taskId,
      actionId: args.actionId,
      toolCallId,
      kind: "merge-request",
      payloadHash,
    });
  } catch {
    /* 埋点失败不挡 MR */
  }
  const result = await create({
    config: args.config,
    projectPath: args.projectPath,
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
    title: args.title,
    description: args.description,
    removeSourceBranch: args.removeSourceBranch,
  });
  if (result.ok) {
    try {
      await markIntentDone(
        args.taskId,
        buildSideEffectIdempotencyKey({ taskId: args.taskId, actionId: args.actionId, toolCallId }),
      );
    } catch {
      /* 收尾失败不翻转成功结论 */
    }
  }
  // !ok 留 pending：可能是真失败，也可能是建成了没收到响应——恢复走 findOpenMR 反查。
  return result;
};
