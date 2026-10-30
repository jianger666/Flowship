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
import { createStreamCadence, type CadenceSnapshot } from "./stream-cadence";

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
  /**
   * X3（server 堆增长观测）：热 chat 会话总数（含 run 在跑的）。chat-runner 还没加载（探针没登记）则省略；
   * 0 是有效值（会话都已回收——回收生效的直接证据），不能被当缺省丢掉。
   */
  chatHot?: number;
  /**
   * X3：热会话明细（最多 CHAT_HOT_DETAIL_MAX 条：SDK store 里数据量大的在前，取不到的按空闲从短到长）。
   * 隐私：t = taskId（与记录顶层 taskId 同类，是 id 不是路径）；其余都是数字 / 布尔。
   */
  chatHotDetail?: ChatHotDetail[];
  /** X3：自进程启动累计的会话回收次数（idle = 空闲 TTL / scheduledEnd = 定时 run 收尾 / watermark = 堆水位门） */
  chatReclaim?: { idle: number; scheduledEnd: number; watermark: number };
  /** X3：V8 堆明细（MB）。heapMB 只是 used；崩前要看的是 physical / external / malloced 与 detachedCtx（泄漏的分离上下文数） */
  v8?: {
    totalHeapMB: number;
    physicalMB: number;
    externalMB: number;
    mallocedMB: number;
    detachedCtx: number;
  };
}

/** X3：一个热 chat 会话的遥测行 */
export interface ChatHotDetail {
  /** taskId */
  t: string;
  /** 距最近活跃（run 结束 / send）的秒数 */
  idleS: number;
  /** run 在跑 */
  run?: true;
  /** 在跑的后台子代理数（0 省略） */
  bg?: number;
  /** SDK store 里该会话的数据量（MB）；取不到省略 */
  agentMB?: number;
}

/** run-perf 里热会话明细的条数上限：一行记录 < 4KB 的预算（见 tests/run-perf-record.test.ts）里留给它的份额 */
export const CHAT_HOT_DETAIL_MAX = 4;

/**
 * X3：把「热会话 + 回收计数」整理成 proc 里的几个字段（纯逻辑，便于契约测试直接锁形状）。
 * `hot === undefined`（探针没登记）→ 省略 chatHot / chatHotDetail；chatReclaim 是全局计数，始终给。
 */
export const buildChatProcTelemetry = (
  hot:
    | ReadonlyArray<{
        taskId: string;
        agentId: string;
        idleMs: number;
        runActive: boolean;
        backgroundRunning: number;
      }>
    | undefined,
  counts: { idle: number; scheduledEnd: number; watermark: number },
  agentBytesOf?: (agentId: string) => number | undefined,
): Pick<ProcSnapshot, "chatHot" | "chatHotDetail" | "chatReclaim"> => {
  const chatReclaim = {
    idle: counts.idle,
    scheduledEnd: counts.scheduledEnd,
    watermark: counts.watermark,
  };
  if (!hot) return { chatReclaim };
  const rows = hot.map((h) => {
    const bytes = agentBytesOf?.(h.agentId);
    const row: ChatHotDetail = {
      t: h.taskId,
      idleS: Math.max(0, Math.round(h.idleMs / 1000)),
    };
    if (h.runActive) row.run = true;
    if (h.backgroundRunning > 0) row.bg = h.backgroundRunning;
    if (typeof bytes === "number" && Number.isFinite(bytes)) {
      row.agentMB = Math.round((bytes / 1048576) * 10) / 10;
    }
    return row;
  });
  rows.sort(
    (a, b) =>
      (b.agentMB ?? -1) - (a.agentMB ?? -1) ||
      a.idleS - b.idleS ||
      (a.t < b.t ? -1 : a.t > b.t ? 1 : 0),
  );
  return {
    chatHot: rows.length,
    ...(rows.length > 0
      ? { chatHotDetail: rows.slice(0, CHAT_HOT_DETAIL_MAX) }
      : {}),
    chatReclaim,
  };
};

/** X3：v8.getHeapStatistics() 的相关字段 → proc.v8（MB 取整；字段缺失按 0） */
export const buildV8Telemetry = (s: {
  total_heap_size?: number;
  total_physical_size?: number;
  external_memory?: number;
  malloced_memory?: number;
  number_of_detached_contexts?: number;
}): NonNullable<ProcSnapshot["v8"]> => {
  const mb = (n: number | undefined): number =>
    Math.round((Number.isFinite(n) ? (n as number) : 0) / 1048576);
  return {
    totalHeapMB: mb(s.total_heap_size),
    physicalMB: mb(s.total_physical_size),
    externalMB: mb(s.external_memory),
    mallocedMB: mb(s.malloced_memory),
    detachedCtx: Number.isFinite(s.number_of_detached_contexts)
      ? (s.number_of_detached_contexts as number)
      : 0,
  };
};

export interface StoreSnapshot {
  mode: string;
  blobs?: number;
  mb?: number;
  agentBlobs?: number;
  agentMB?: number;
  /**
   * run_events 实现：memory = 进程内存（默认；流式消息的进程内传输通道，不落盘）；
   * file = SDK 自带落盘（回退开关）——每条事件整文件读写，文件大了吐字会被钉在个位数条/秒
   */
  runEvents?: string;
  /** run_events 体积（MB）：memory = 当前保留的 payload 体积；file = 文件大小 */
  evMB?: number;
  /** memory 实现当前保留的事件条数（全部 run 合计；已读且闲置 5 分钟的会被回收） */
  evCount?: number;
  /** memory 实现自进程启动累计回收的事件条数 */
  evTrimmed?: number;
  /**
   * runs.ndjson 体积（MB）：SDK 每次读 run 状态都整文件解析（现网 195KB ≈ 1.2ms/次），
   * 涨到数 MB 会成为下一个「每条事件 O(文件大小)」瓶颈——先放进观测，涨起来就能提前看到
   */
  runsMB?: number;
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
  /**
   * 吐字节奏：相邻两条同类 delta 的到达间隔分布（ms；text = 正文、thinking = 思考；
   * 跨工具调用 / 思考切换的空窗不计）。判读见 stream-cadence.ts 头注释
   */
  cadence?: CadenceSnapshot;
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
  const cadence = createStreamCadence();

  return {
    /** send 返回（Run 受理）时调；只认第一次 */
    accepted(at: number): void {
      if (acceptedAt === undefined) acceptedAt = at;
    },
    /** 一条 text-delta 到达（热路径：只做数值运算、零日志） */
    textDelta(at: number): void {
      cadence.text(at);
    },
    /** 一条 thinking-delta 到达（热路径：只做数值运算、零日志） */
    thinkingDelta(at: number): void {
      cadence.thinking(at);
    },
    /** 非高频事件（工具调用 / 步骤 / 轮次…）：断开吐字节奏的连续段 */
    breakStream(): void {
      cadence.breakSegment();
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
        cadence: cadence.snapshot(),
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
    cadence: snap.cadence,
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
