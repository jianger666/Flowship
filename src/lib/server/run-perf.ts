/**
 * SDK agent.send 性能埋点（P0 可观测性）
 *
 * 背景：Windows 用户反馈「执行慢」，但现有日志分不清卡在 thinking / 工具 / step 哪一段。
 * SDK 1.0.23 的 SendOptions 已暴露 onDelta / onStep，本模块消费细粒度 InteractionUpdate，
 * 只打元数据日志（绝不记录命令内容 / 工具参数 / 输出 / prompt 正文）。
 *
 * 用法：send 前 createRunPerfTracker → 把 onDelta/onStep 塞进 SendOptions → send 返回后 attachRun。
 *
 * 副作用（日志之外）：
 * 1. `turn-ended` 的 token 用量会落进 meta.json（见 persistTurnUsage）。
 *    落在这里而不是各调用点，是因为 9 个 agent.send 全都已经接了本 tracker——
 *    chat / task / 交卷追问 / ask 回复 / 问一问 / 重连各链路零改动自动覆盖。
 * 2. v1.9.28：每个 run 结束时往 run-perf.jsonl 写一行结构化汇总（见 run-perf-record.ts），
 *    同样靠「9 个 send 都接了本 tracker」零改动覆盖全链路。收口以 SDK 的终态回调
 *    （finished / error / cancelled）为准——以 turn-ended 为准会把失败的 run 误记成 ok；
 *    turn-ended 只在没有终态回调 / 回调迟迟不来时兜底。
 *
 * 契约：高频流式 delta 零 [perf-] 日志、零额外分配（run-perf.test.ts 锁定）；
 * 汇总的构建 / 写盘全程火忘、永不抛、永不阻塞 onDelta（它是同步签名）。
 */
import os from "node:os";

import type { ConversationStep, InteractionUpdate, Run } from "@cursor/sdk";

import { loopLagWindow } from "./loop-lag";
import { normalizeToolName } from "./normalize-tool-name";
import { appendPerfRecord, perfJournalEnabled } from "./perf-journal";
import {
  buildRunRecord,
  createRunAccumulator,
  type ProcSnapshot,
  type RunOutcome,
  type RunPerfRecord,
  type StoreSnapshot,
} from "./run-perf-record";
import {
  idleSinceLastRun,
  noteRunEnded,
  takePrep,
  warmedAgo,
} from "./run-prep-notes";
import { recordTurnUsage } from "./task-fs";
import { publish } from "./task-stream";
import { appendTimingLog } from "./timing-log";
import { normalizeTurnUsage } from "@/lib/token-usage";

export type RunPerfCtx = {
  taskId: string;
  agentId: string;
  /** 调用点语义：task-first / task-followup / question / chat-first 等 */
  runKind: string;
  promptBytes?: number;
  /** B2：预算裁掉的段名（可回放：段名+省字节见 warn/单测，日志只记名） */
  promptBudgetDropped?: string[];
  /** B2：用了压缩版的段名 */
  promptBudgetCompressed?: string[];
  /** 模型选择（汇总记录按模型切分布用）；调用点已知就传，未知省略 */
  model?: {
    id: string;
    params?: ReadonlyArray<{ id: string; value: string }>;
  };
  /** 仅测试：接管汇总记录的出口（默认写 run-perf.jsonl，单测环境下不落盘） */
  sink?: (record: RunPerfRecord) => void;
};

/** attachRun 需要的 Run 的最小面；终态回调 / status 可选（测试里的假 run 可以不带） */
export type RunLike = Pick<Run, "id" | "requestId"> &
  Partial<Pick<Run, "status" | "onDidChangeStatus">>;

export type RunPerfTracker = {
  onDelta: (args: { update: InteractionUpdate }) => void;
  onStep: (args: { step: ConversationStep }) => void;
  /** send 返回后补记 run id / requestId，打 [perf-run] 行，并开始盯这个 run 的终态 */
  attachRun: (run: RunLike) => void;
};

/** 高频流式 delta——只占带宽、对「卡在哪」无信息量，一律忽略 */
const IGNORED_DELTA_TYPES = new Set([
  "text-delta",
  "thinking-delta",
  "shell-output-delta",
  "token-delta",
  "partial-tool-call",
]);

/** send 之后这么久还没 attachRun → 判定 send 在受理前就失败了（正常受理 <1min，冷启动也远低于此） */
const ATTACH_WATCHDOG_MS = 5 * 60_000;
/** run 兜底：超出任何合理任务时长仍无终态（SDK 进程崩溃等）才记 timeout，别把长任务误判 */
const RUN_WATCHDOG_MS = 6 * 3_600_000;
/** turn-ended 之后等终态回调的宽限；等不到按 ok 兜底 */
const TURN_END_GRACE_MS = 2_000;

type ToolCallLike = {
  type: string;
  args?: {
    providerIdentifier?: string;
    toolName?: string;
  };
  result?: {
    status?: string;
    value?: {
      executionTime?: number;
      isError?: boolean;
    };
  };
};

const toolStatus = (toolCall: ToolCallLike): "success" | "error" | "unknown" => {
  const status = toolCall.result?.status;
  if (status === "error") return "error";
  if (status === "success") {
    // MCP 协议层 success 但业务 isError=true，按 error 记（仍不碰 content）
    if (toolCall.type === "mcp" && toolCall.result?.value?.isError === true) {
      return "error";
    }
    return "success";
  }
  return "unknown";
};

const shellSdkExecMs = (toolCall: ToolCallLike): number | undefined => {
  if (toolCall.type !== "shell") return undefined;
  const t = toolCall.result?.value?.executionTime;
  return typeof t === "number" && Number.isFinite(t) ? t : undefined;
};

/**
 * turn 用量落盘 + 推一帧 task 给前端（火忘：onDelta 是同步签名、绝不能 await）。
 *
 * 频次：实测一次 agent.send 只发一条 turn-ended（哪怕中间跑了 40 多步、几十个工具），
 * 所以「一轮写一次 meta」的量级跟现有 patchAction 比可以忽略——绝不按 delta 写盘。
 */
const persistTurnUsage = (taskId: string, rawUsage: unknown): void => {
  const usage = normalizeTurnUsage(rawUsage);
  if (!usage) return;
  void (async () => {
    try {
      const task = await recordTurnUsage(taskId, usage);
      if (task) publish(taskId, { kind: "task", task });
    } catch (err) {
      console.warn(`[perf] turn 用量落盘失败 task=${taskId}`, err);
    }
  })();
};

// ───────── run 汇总：进程级在飞计数 + 环境快照 ─────────

const G = globalThis as unknown as { __fePerfActiveRuns?: number };

const bumpActiveRuns = (delta: 1 | -1): void => {
  G.__fePerfActiveRuns = Math.max(0, (G.__fePerfActiveRuns ?? 0) + delta);
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

type EnvSnapshot = { store?: StoreSnapshot; proc?: ProcSnapshot };
type EnvProvider = (
  agentId: string,
  fromMs: number,
  toMs: number,
) => Promise<EnvSnapshot>;

/** run 结束时取一次：进程健康（含事件循环采样窗口）+ 会话 / store 规模。全部尽力而为、取不到就省略。 */
const defaultEnvProvider: EnvProvider = async (agentId, fromMs, toMs) => {
  const mem = process.memoryUsage();
  const lag = loopLagWindow(fromMs, toMs);
  const proc: ProcSnapshot = {
    rssMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    load1: round1(os.loadavg()[0] ?? 0),
    uptimeS: Math.round(process.uptime()),
    activeRuns: G.__fePerfActiveRuns ?? 0,
    ...(lag
      ? {
          eldP99Max: Math.round(lag.p99Max),
          eldMax: Math.round(lag.max),
          eluAvg: Math.round(lag.eluAvg * 100) / 100,
          slowSeconds: lag.slowSeconds,
          gcMax: Math.round(lag.gcMax),
          gcCount: lag.gcCount,
        }
      : {}),
  };
  let store: StoreSnapshot | undefined;
  try {
    // 动态 import + 只看不开：观测绝不能因为要写一行记录而触发 store 打开
    const { peekSdkStoreHandle } = await import("./sdk-agent-store");
    const handle = await peekSdkStoreHandle();
    if (handle) {
      const total = handle.fast?.getStats();
      const mine = handle.fast?.agentStats(agentId);
      store = {
        mode: handle.mode,
        ...(total
          ? { blobs: total.blobs, mb: round1(total.bytes / 1048576) }
          : {}),
        ...(mine
          ? { agentBlobs: mine.blobs, agentMB: round1(mine.bytes / 1048576) }
          : {}),
      };
    }
  } catch {
    // 拿不到 store 信息就省略这一组
  }
  return { proc, store };
};

let envProvider: EnvProvider = defaultEnvProvider;

/** 仅测试：替换环境快照来源（避免单测里真去动态加载 store / 读采样器） */
export const __setRunPerfEnvProviderForTests = (fn?: EnvProvider): void => {
  envProvider = fn ?? defaultEnvProvider;
};

const runtimeInfo = (): {
  platform: string;
  version?: string;
  appNap: boolean;
} => ({
  platform: process.platform,
  version: process.env.FLOWSHIP_APP_VERSION || undefined,
  appNap: process.env.FLOWSHIP_PREVENT_APP_NAP === "1",
});

/** 不让观测用的定时器拖住进程退出 */
const unrefTimer = (t: ReturnType<typeof setTimeout>): void => {
  (t as unknown as { unref?: () => void }).unref?.();
};

const terminalOf = (
  run: RunLike | undefined,
): "finished" | "error" | "cancelled" | null => {
  const s = run?.status;
  return s === "finished" || s === "error" || s === "cancelled" ? s : null;
};

export const createRunPerfTracker = (ctx: RunPerfCtx): RunPerfTracker => {
  // 上一被记录事件的时间——算 gap（事件间隔），定位「空窗」卡顿
  let lastEventAt = Date.now();
  // send 发起时刻——首 token 打点用。按本模块使用契约（send 前 create、塞进
  // SendOptions、send 返回后 attach），firstTokenMs = send 发起→首 token，
  // 不含 resume/排队；和 question-timing 的 agentSend 对账时可直接相减
  // （firstTokenMs - agentSend ≈ 受理后纯模型计算）。
  const sendStartedAt = Date.now();
  let firstTokenLogged = false;
  const toolStartedAt = new Map<string, { name: string; at: number }>();
  const base = `task=${ctx.taskId} kind=${ctx.runKind}`;

  // ── run 汇总状态 ──
  const acc = createRunAccumulator(sendStartedAt);
  // 受理前笔记 / 跨 run 状态在创建时刻取走：此刻起它们只属于这一个 run
  const prep = takePrep(ctx.taskId, sendStartedAt);
  const idleBeforeMs = idleSinceLastRun(ctx.taskId, sendStartedAt);
  const warmedAgoMs = warmedAgo(ctx.taskId, sendStartedAt);
  let finalized = false;
  let turnEnded = false;
  let attachedRun: RunLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let turnEndTimer: ReturnType<typeof setTimeout> | undefined;
  let runWatchdog: ReturnType<typeof setTimeout> | undefined;
  bumpActiveRuns(1);
  const attachWatchdog = setTimeout(
    () => finalize("never-attached"),
    ATTACH_WATCHDOG_MS,
  );
  unrefTimer(attachWatchdog);

  const emit = async (outcome: RunOutcome, endedAt: number): Promise<void> => {
    const sink = ctx.sink;
    // 反正不会写（单测环境）就别费劲构建——也让其余 44 个 mock 链路的测试零开销
    if (!sink && !perfJournalEnabled()) return;
    try {
      const env = await envProvider(ctx.agentId, sendStartedAt, endedAt);
      const record = buildRunRecord({
        now: endedAt,
        ctx,
        run: attachedRun,
        outcome,
        snap: acc.snapshot(endedAt),
        prep,
        idleBeforeMs,
        warmedAgoMs,
        env,
        runtime: runtimeInfo(),
      });
      if (sink) sink(record);
      else {
        appendPerfRecord(
          "run-perf.jsonl",
          record as unknown as Record<string, unknown>,
        );
      }
    } catch (err) {
      console.debug(`[perf] run 汇总记录失败 task=${ctx.taskId}`, err);
    }
  };

  /** 收口：幂等。结束时刻 = 此刻；之后的一切迟到事件都被忽略 */
  function finalize(outcome: RunOutcome): void {
    if (finalized) return;
    finalized = true;
    clearTimeout(attachWatchdog);
    if (runWatchdog) clearTimeout(runWatchdog);
    if (turnEndTimer) clearTimeout(turnEndTimer);
    try {
      unsubscribe?.();
    } catch {
      // 退订失败无碍：finalized 已挡住后续回调
    }
    bumpActiveRuns(-1);
    const endedAt = Date.now();
    noteRunEnded(ctx.taskId, endedAt);
    void emit(outcome, endedAt);
  }

  /**
   * turn-ended 之后怎么收口：优先等终态回调定 outcome（error / cancelled 不能被记成 ok）。
   * - run 已是终态 → 直接按它收口
   * - run 有终态回调 → 等回调、最多宽限 2s，等不到按 ok
   * - run 没有终态回调能力 → turn-ended 是唯一信号，直接 ok
   * - 还没 attachRun → 等 attachRun 时再决定
   */
  const settleAfterTurnEnd = (): void => {
    if (finalized || !turnEnded || !attachedRun) return;
    const st = terminalOf(attachedRun);
    if (st) {
      finalize(st);
      return;
    }
    if (typeof attachedRun.onDidChangeStatus === "function") {
      if (!turnEndTimer) {
        turnEndTimer = setTimeout(() => finalize("ok"), TURN_END_GRACE_MS);
        unrefTimer(turnEndTimer);
      }
      return;
    }
    finalize("ok");
  };

  const markEvent = (): { now: number; gap: number } => {
    const now = Date.now();
    const gap = now - lastEventAt;
    lastEventAt = now;
    return { now, gap };
  };

  const onDelta = (args: { update: InteractionUpdate }): void => {
    try {
      const update = args.update;
      // 首 token 打点（流式 content 类 delta 不计入常规埋点、但首个要记）：
      // firstTokenMs=send 发起→模型首个输出，减去 agentSend 受理耗时即纯模型计算。
      // 镜像进文件（first-delta.log），与 question-timings 行对账。
      if (
        !firstTokenLogged &&
        (update.type === "text-delta" ||
          update.type === "thinking-delta" ||
          update.type === "token-delta")
      ) {
        // 首 token 打点只进文件（first-delta.log），不打 console：
        // 高频流式 delta 零 [perf-] 日志是单测锁定的契约（run-perf.test.ts）。
        firstTokenLogged = true;
        const nowMs = Date.now();
        const ms = nowMs - sendStartedAt;
        acc.token(update.type, nowMs);
        appendTimingLog("first-delta.log", [
          `${new Date().toISOString()} [perf-first] ${base} firstTokenMs=${ms} type=${update.type}`,
        ]);
      }
      if (IGNORED_DELTA_TYPES.has(update.type)) return;

      if (update.type === "tool-call-started") {
        const { now, gap } = markEvent();
        const name = normalizeToolName(update.toolCall as ToolCallLike);
        toolStartedAt.set(update.callId, { name, at: now });
        acc.toolStart(now);
        console.log(
          `[perf-tool] ${base} call=${update.callId} tool=${name} phase=start gap=${gap}`,
        );
        return;
      }

      if (update.type === "tool-call-completed") {
        const { now, gap } = markEvent();
        const toolCall = update.toolCall as ToolCallLike;
        const started = toolStartedAt.get(update.callId);
        toolStartedAt.delete(update.callId);
        const name = started?.name ?? normalizeToolName(toolCall);
        const wall = started ? now - started.at : gap;
        const status = toolStatus(toolCall);
        const sdkExec = shellSdkExecMs(toolCall);
        acc.toolDone(name, wall, status, sdkExec);
        const sdkExecPart =
          sdkExec !== undefined ? ` sdkExec=${sdkExec}` : "";
        console.log(
          `[perf-tool] ${base} call=${update.callId} tool=${name} phase=done wall=${wall} status=${status}${sdkExecPart}`,
        );
        return;
      }

      if (update.type === "thinking-completed") {
        const { gap } = markEvent();
        acc.thinking(update.thinkingDurationMs);
        const duration =
          typeof update.thinkingDurationMs === "number"
            ? ` duration=${update.thinkingDurationMs}`
            : "";
        console.log(`[perf-step] ${base} type=thinking gap=${gap}${duration}`);
        return;
      }

      if (update.type === "step-completed") {
        markEvent();
        acc.step(update.stepDurationMs);
        console.log(
          `[perf-step] ${base} type=step duration=${update.stepDurationMs} stepId=${update.stepId}`,
        );
        return;
      }

      if (update.type === "turn-ended") {
        markEvent();
        const u = update.usage;
        turnEnded = true;
        if (!u) {
          console.log(`[perf-turn] ${base} usage=none`);
        } else {
          acc.usage(u);
          const reasoning =
            typeof u.reasoningTokens === "number"
              ? ` reasoningTokens=${u.reasoningTokens}`
              : "";
          console.log(
            `[perf-turn] ${base} inputTokens=${u.inputTokens} outputTokens=${u.outputTokens}` +
              ` cacheReadTokens=${u.cacheReadTokens} cacheWriteTokens=${u.cacheWriteTokens}${reasoning}`,
          );
          // 日志之外的副作用之一：落进 meta.json 供 UI 展示（内部已 try/catch + 火忘）
          persistTurnUsage(ctx.taskId, u);
        }
        settleAfterTurnEnd();
      }
    } catch (err) {
      // 埋点绝不能拖垮主流程
      console.warn(`[perf] onDelta 埋点失败 task=${ctx.taskId}`, err);
    }
  };

  // onStep 目前无额外可观测字段需求；占位接 SendOptions，防未来扩展时调用点再改一遍
  const onStep = (args: { step: ConversationStep }): void => {
    try {
      // ConversationStep 不含 wall-clock；细粒度耗时走 onDelta 的 step-completed
      void args.step;
    } catch (err) {
      console.warn(`[perf] onStep 埋点失败 task=${ctx.taskId}`, err);
    }
  };

  const attachRun = (run: RunLike): void => {
    // 汇总挂接与原有日志各自 try/catch：任何一边出问题都不拖累另一边、更不拖累主流程
    try {
      acc.accepted(Date.now());
      if (!finalized) {
        attachedRun = run;
        clearTimeout(attachWatchdog);
        runWatchdog = setTimeout(() => finalize("timeout"), RUN_WATCHDOG_MS);
        unrefTimer(runWatchdog);
        if (typeof run.onDidChangeStatus === "function") {
          try {
            unsubscribe = run.onDidChangeStatus((status) => {
              if (
                status === "finished" ||
                status === "error" ||
                status === "cancelled"
              ) {
                finalize(status);
              }
            });
          } catch {
            // 订阅失败：退回 turn-ended / 看门狗
          }
        }
        // 订阅之前 run 可能已是终态（极快的 run / turn-ended 先于受理返回）
        const st = terminalOf(run);
        if (st) finalize(st);
        else settleAfterTurnEnd();
      }
    } catch (err) {
      console.warn(`[perf] attachRun 汇总挂接失败 task=${ctx.taskId}`, err);
    }

    try {
      const req =
        typeof run.requestId === "string" && run.requestId.length > 0
          ? ` requestId=${run.requestId}`
          : "";
      const bytes =
        typeof ctx.promptBytes === "number"
          ? ` promptBytes=${ctx.promptBytes}`
          : "";
      const dropped =
        ctx.promptBudgetDropped && ctx.promptBudgetDropped.length > 0
          ? ` promptBudgetDropped=${ctx.promptBudgetDropped.join(",")}`
          : "";
      const compressed =
        ctx.promptBudgetCompressed && ctx.promptBudgetCompressed.length > 0
          ? ` promptBudgetCompressed=${ctx.promptBudgetCompressed.join(",")}`
          : "";
      console.log(
        `[perf-run] ${base} agent=${ctx.agentId} run=${run.id}${req}${bytes}${dropped}${compressed}`,
      );
    } catch (err) {
      console.warn(`[perf] attachRun 埋点失败 task=${ctx.taskId}`, err);
    }
  };

  return { onDelta, onStep, attachRun };
};
