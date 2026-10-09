/**
 * 每个 run 一行的结构化汇总记录（run-perf.jsonl）：累积器 + 记录构建，纯逻辑、无 IO。
 *
 * 为什么要有：现有 [perf-*] 日志是「一个事件一行」，要回答「这一轮为什么慢」得跨多行拼；
 * 而持续优化要的是分布（按空闲时长 / 模型 / 会话规模切）。这里把一个 run 的
 * 受理 / 首 token / 首工具 / 各工具聚合 / token 用量 / 受理前各阶段 / MCP 探活 / 进程健康
 * 压成一行，scripts/perf-report.mjs 直接读。
 *
 * 隐私：只含数字、id、枚举名与工具名（工具名与现有 [perf-tool] 日志同口径），
 * 绝不含 prompt / 命令 / 工具参数 / 输出 / 路径。tests/run-perf-record.test.ts 里有字段白名单测试，
 * 新增字段会让它失败——到时候先评估隐私影响再更新白名单。
 */
import type { McpProbeStats } from "./mcp-probe";
import type { PrepNotes } from "./run-prep-notes";

export type RunOutcome =
  | "ok"
  | "finished"
  | "error"
  | "cancelled"
  /** run 超过看门狗上限仍没有终态（SDK 进程崩溃等） */
  | "timeout"
  /** send 之后始终没有 attachRun：send 在受理前就失败 / 抛错了 */
  | "never-attached";

export interface ToolAgg {
  n: number;
  errors: number;
  wallSum: number;
  wallMax: number;
  /** 仅 shell：SDK 自报的命令执行耗时累计（wall − sdkExec ≈ 平台 / 事件管线开销） */
  sdkExecSum?: number;
}

export interface TokenAgg {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface ProcSnapshot {
  rssMB: number;
  heapMB: number;
  load1: number;
  uptimeS: number;
  /** 汇总时刻在飞的 run 数 */
  activeRuns: number;
  /** 以下来自事件循环采样（loop-lag）；采样器没起 / 窗口里没采样点则整组省略 */
  eldP99Max?: number;
  eldMax?: number;
  eluAvg?: number;
  slowSeconds?: number;
  gcMax?: number;
  gcCount?: number;
}

export interface StoreSnapshot {
  mode: string;
  blobs?: number;
  mb?: number;
  agentBlobs?: number;
  agentMB?: number;
}

export interface RunPerfRecord {
  /** schema 版本：字段含义变了才升 */
  v: 1;
  ts: string;
  taskId: string;
  kind: string;
  agentId: string;
  runId?: string;
  requestId?: string;
  model?: string;
  modelParams?: string;
  outcome: RunOutcome;
  /** 距该 task 上一个 run 结束（本进程内）；未知则省略 */
  idleBeforeMs?: number;
  /** 距该 task 最近一次预热；没预热过则省略 */
  warmedAgoMs?: number;

  // ── 时序（相对 send 发起，ms）──
  /** send 发起 → send 返回（Run 受理） */
  acceptMs?: number;
  /** send 发起 → 首个 token（text / thinking / token-delta） */
  firstDeltaMs?: number;
  firstDeltaType?: string;
  /** 受理 → 首 token（= 模型侧 TTFT；首 token 早于受理返回则为 0） */
  ttftMs?: number;
  /** send 发起 → 首个工具开始 */
  firstToolMs?: number;
  totalMs: number;

  thinkingMs?: number;
  thinkingSegments?: number;
  steps: number;
  stepMsSum: number;
  stepMsMax: number;
  toolCount: number;
  toolErrors: number;
  tools: Record<string, ToolAgg>;
  tokens?: TokenAgg;
  promptBytes?: number;
  promptBudgetDropped?: string[];

  /** 受理前各阶段耗时（resume / mcp / create / prompt / checkpoint#send …） */
  prep?: Record<string, number>;
  tags?: Record<string, string | number | boolean>;
  mcp?: McpProbeStats;
  store?: StoreSnapshot;
  proc?: ProcSnapshot;

  platform: string;
  /** App 版本（server 进程由 Electron 主进程经环境变量传入；dev 没有） */
  version?: string;
  /** 防后台节流实验开关是否开着 */
  appNap?: boolean;
}

// ───────── 累积器 ─────────

/** 工具名种类上限：MCP 工具名可能很多，超出的归并到 other，防记录膨胀 */
const MAX_TOOL_KEYS = 24;
const OTHER_TOOL = "other";

/** 合法的非负有限数；否则 undefined（埋点数据来自 SDK，不能信） */
const num = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;

export type RunAccumulator = ReturnType<typeof createRunAccumulator>;

export const createRunAccumulator = (startedAt: number) => {
  let acceptedAt: number | undefined;
  let firstTokenAt: number | undefined;
  let firstTokenType: string | undefined;
  let firstToolAt: number | undefined;
  let thinkingMs = 0;
  let thinkingSegments = 0;
  let steps = 0;
  let stepMsSum = 0;
  let stepMsMax = 0;
  let toolCount = 0;
  let toolErrors = 0;
  const tools = new Map<string, ToolAgg>();
  let tokens: TokenAgg | undefined;

  return {
    /** send 返回（Run 受理）时调；只认第一次 */
    accepted(at: number): void {
      if (acceptedAt === undefined) acceptedAt = at;
    },
    /** 任一流式 content 类 delta；只认第一个 */
    token(type: string, at: number): void {
      if (firstTokenAt === undefined) {
        firstTokenAt = at;
        firstTokenType = type;
      }
    },
    toolStart(at: number): void {
      if (firstToolAt === undefined) firstToolAt = at;
    },
    toolDone(
      name: string,
      wallMs: number,
      status: "success" | "error" | "unknown",
      sdkExecMs?: number,
    ): void {
      toolCount += 1;
      if (status === "error") toolErrors += 1;
      const key =
        tools.has(name) || tools.size < MAX_TOOL_KEYS ? name : OTHER_TOOL;
      const agg = tools.get(key) ?? { n: 0, errors: 0, wallSum: 0, wallMax: 0 };
      const wall = num(wallMs) ?? 0;
      agg.n += 1;
      if (status === "error") agg.errors += 1;
      agg.wallSum += wall;
      agg.wallMax = Math.max(agg.wallMax, wall);
      const exec = num(sdkExecMs);
      if (exec !== undefined) agg.sdkExecSum = (agg.sdkExecSum ?? 0) + exec;
      tools.set(key, agg);
    },
    thinking(durationMs: unknown): void {
      thinkingSegments += 1;
      thinkingMs += num(durationMs) ?? 0;
    },
    step(durationMs: unknown): void {
      const d = num(durationMs);
      steps += 1;
      if (d !== undefined) {
        stepMsSum += d;
        stepMsMax = Math.max(stepMsMax, d);
      }
    },
    usage(u: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cacheReadTokens?: unknown;
      cacheWriteTokens?: unknown;
      reasoningTokens?: unknown;
    }): void {
      const t: TokenAgg = {};
      const input = num(u.inputTokens);
      const output = num(u.outputTokens);
      const cacheRead = num(u.cacheReadTokens);
      const cacheWrite = num(u.cacheWriteTokens);
      const reasoning = num(u.reasoningTokens);
      if (input !== undefined) t.input = input;
      if (output !== undefined) t.output = output;
      if (cacheRead !== undefined) t.cacheRead = cacheRead;
      if (cacheWrite !== undefined) t.cacheWrite = cacheWrite;
      if (reasoning !== undefined) t.reasoning = reasoning;
      tokens = t;
    },
    snapshot(endedAt: number) {
      const rel = (at: number | undefined): number | undefined =>
        at === undefined ? undefined : Math.round(Math.max(0, at - startedAt));
      return {
        acceptMs: rel(acceptedAt),
        firstDeltaMs: rel(firstTokenAt),
        firstDeltaType: firstTokenType,
        ttftMs:
          firstTokenAt !== undefined && acceptedAt !== undefined
            ? Math.round(Math.max(0, firstTokenAt - acceptedAt))
            : undefined,
        firstToolMs: rel(firstToolAt),
        totalMs: Math.round(Math.max(0, endedAt - startedAt)),
        thinkingMs: thinkingSegments > 0 ? Math.round(thinkingMs) : undefined,
        thinkingSegments: thinkingSegments > 0 ? thinkingSegments : undefined,
        steps,
        stepMsSum: Math.round(stepMsSum),
        stepMsMax: Math.round(stepMsMax),
        toolCount,
        toolErrors,
        tools: Object.fromEntries(tools) as Record<string, ToolAgg>,
        tokens,
      };
    },
  };
};

// ───────── 记录构建 ─────────

export interface BuildRecordInput {
  /** 结束时刻（ms epoch） */
  now: number;
  ctx: {
    taskId: string;
    agentId: string;
    runKind: string;
    promptBytes?: number;
    promptBudgetDropped?: string[];
    model?: {
      id: string;
      params?: ReadonlyArray<{ id: string; value: string }>;
    };
  };
  run?: { id?: string; requestId?: string };
  outcome: RunOutcome;
  snap: ReturnType<RunAccumulator["snapshot"]>;
  prep: PrepNotes | null;
  idleBeforeMs: number | null;
  warmedAgoMs: number | null;
  env: { store?: StoreSnapshot; proc?: ProcSnapshot };
  runtime: { platform: string; version?: string; appNap?: boolean };
}

/** 去掉 undefined / null / 非有限数；其余原样（浅层） */
const compact = <T extends object>(o: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out as T;
};

const nonEmpty = <T extends object>(o: T | undefined): T | undefined =>
  o && Object.keys(o).length > 0 ? o : undefined;

export const buildRunRecord = (i: BuildRecordInput): RunPerfRecord => {
  const { snap, ctx } = i;
  const params = ctx.model?.params
    ?.map((p) => `${p.id}=${p.value}`)
    .join(",");
  const stages = nonEmpty(
    i.prep?.stages
      ? (Object.fromEntries(
          Object.entries(i.prep.stages)
            .map(([k, v]) => [k, num(v)] as const)
            .filter((e): e is readonly [string, number] => e[1] !== undefined)
            .map(([k, v]) => [k, Math.round(v)] as const),
        ) as Record<string, number>)
      : undefined,
  );
  const record: RunPerfRecord = {
    v: 1,
    ts: new Date(i.now).toISOString(),
    taskId: ctx.taskId,
    kind: ctx.runKind,
    agentId: ctx.agentId,
    runId: i.run?.id,
    requestId:
      typeof i.run?.requestId === "string" && i.run.requestId.length > 0
        ? i.run.requestId
        : undefined,
    model: ctx.model?.id,
    modelParams: params && params.length > 0 ? params : undefined,
    outcome: i.outcome,
    idleBeforeMs: i.idleBeforeMs === null ? undefined : Math.round(i.idleBeforeMs),
    warmedAgoMs: i.warmedAgoMs === null ? undefined : Math.round(i.warmedAgoMs),
    acceptMs: snap.acceptMs,
    firstDeltaMs: snap.firstDeltaMs,
    firstDeltaType: snap.firstDeltaType,
    ttftMs: snap.ttftMs,
    firstToolMs: snap.firstToolMs,
    totalMs: snap.totalMs,
    thinkingMs: snap.thinkingMs,
    thinkingSegments: snap.thinkingSegments,
    steps: snap.steps,
    stepMsSum: snap.stepMsSum,
    stepMsMax: snap.stepMsMax,
    toolCount: snap.toolCount,
    toolErrors: snap.toolErrors,
    tools: snap.tools,
    tokens: nonEmpty(snap.tokens),
    promptBytes: num(ctx.promptBytes),
    promptBudgetDropped: nonEmpty(ctx.promptBudgetDropped),
    prep: stages,
    tags: nonEmpty(i.prep?.tags),
    mcp: i.prep?.mcp,
    store: i.env.store ? compact(i.env.store) : undefined,
    proc: i.env.proc ? compact(i.env.proc) : undefined,
    platform: i.runtime.platform,
    version: i.runtime.version,
    appNap: i.runtime.appNap,
  };
  return compact(record);
};
