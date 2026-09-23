/**
 * 内存治理契约（mem-governance v2 开工清单配套 + v3.1 Worker 进程隔离终版）。
 *
 * 本文件只放**纯函数 + 常量**（无 SDK 依赖、无副作用），供 ①③ 直接用、② 落契约：
 * - ① 即用即还判定：shouldDisposeAfterAction（task-runner 正常结束路径调用）
 * - ② 意图日志幂等键 / 事件去重键：落成可直接写成代码接口的粒度
 * - ② 恢复侧跨表校验：isCheckpointUsable（sqlite 只保单事务原子，跨表需校验+回退）
 * - ② 内置工具拦截点：BUILTIN_TOOL_INTERCEPT（实验 B 检查项，包不住则意图日志不可写）
 * - v3.1（Worker 进程隔离终版 + 封版纪要）：§3 双 guard / §3.4 整机顶公式 /
 *   §4 双限额 / §5.1 intent 标记与 at-most-once / §6 接力预算 / §7 epoch 去重与 fencing
 *   全部为纯契约；涉及文件 IO 的 epoch 派发实现见 `worker-epoch.ts`（按 stateRoot 独立）。
 *
 * 档位标注（终审口径）：每条结论标 [源码证据 / 设计决策 / 待实验] 之一。
 */

/** [设计决策] 同 workspace 单 worker、run 级排队/低并发；跨 workspace 各自 worker 各自 stateRoot。 */
export const SINGLE_WORKER_PER_WORKSPACE = true as const;

/** [设计决策] ②强制 sqlite store（openDefaultLocalAgentStore）；存量 JSONL 走迁移/容错（容忍半行）。 */
export const FORCE_SQLITE_STORE = true as const;

/** [设计决策] 空闲 TTL 统一 12min（task/chat 同口径），超期 Agent.resume 接回。 */
export const SESSION_IDLE_TTL_MINUTES = 12 as const;

export type ActionTerminalStatus =
  | "completed"
  | "cancelled"
  | "error"
  | "running"
  | "awaiting_ack"
  | "awaiting_user";

export interface DisposeAfterActionInput {
  /** 当前 run 绑定的 action 终态（无 action 传 undefined = 不 dispose） */
  lastActionStatus?: ActionTerminalStatus;
  /** pendingAsk 在等用户答 */
  askPending: boolean;
  /** 后置 check 在飞（交卷审阅中） */
  checkInFlight: boolean;
  /** 问一问 run（短问答，不动会话） */
  questionRun: boolean;
}

/**
 * [设计决策] action 已终态（completed / cancelled）且无 pending 追问/ask/check 在飞
 * → 堆上会话即用即还（keepPersisted=true）。
 * error 不在此 dispose（error 收尾分支已关会话，避免重复关）；
 * awaiting_*（等审阅/等用户）必须保留热会话。
 */
export const shouldDisposeAfterAction = (
  input: DisposeAfterActionInput,
): boolean => {
  if (input.questionRun) return false;
  if (input.askPending) return false;
  if (input.checkInFlight) return false;
  return (
    input.lastActionStatus === "completed" ||
    input.lastActionStatus === "cancelled"
  );
};

// ---------------- ② 意图日志执行器契约 ----------------

export interface SideEffectIntent {
  taskId: string;
  actionId: string;
  toolCallId: string;
  /** 副作用种类：仅外部不可逆走意图执行器（本地文件操作留 worker 内、靠 checkpoint 恢复） */
  kind: "feishu-message" | "git-push" | "external-api" | "merge-request" | "notify";
  payloadHash: string;
  status: "intent" | "done" | "abandoned";
}

/**
 * [设计决策] 副作用幂等键 = (taskId, actionId, toolCallId)。执行器先查后做。
 */
export const buildSideEffectIdempotencyKey = (intent: Pick<SideEffectIntent, "taskId" | "actionId" | "toolCallId">): string =>
  `${intent.taskId}:${intent.actionId}:${intent.toolCallId}`;

/**
 * [设计决策] 事件去重键 = (agentId, runId, seq)。
 * [待实验] resume 是续 run 还是开新 run、seq 是否重置：若重置则跨恢复去重失效，需改设计。
 */
export const buildEventDedupKey = (agentId: string, runId: string, seq: number): string =>
  `${agentId}:${runId}:${seq}`;

// ---------------- ② 恢复侧跨表校验契约 ----------------

export interface CheckpointRef {
  agentId: string;
  checkpointId: string;
  /** 同一 checkpoint 横跨的多表/多文件是否齐全（agents / checkpoints / blobs / runs） */
  tablesPresent: {
    agents: boolean;
    checkpoints: boolean;
    blobs: boolean;
    runs: boolean;
  };
}

/**
 * [源码证据] sqlite 只保单事务单库原子。
 * [设计决策] checkpoint 可用 = 四表齐全；缺任一表 → 回退上一个 checkpoint，绝不带伤启动。
 */
export const isCheckpointUsable = (ref: CheckpointRef): boolean =>
  ref.tablesPresent.agents &&
  ref.tablesPresent.checkpoints &&
  ref.tablesPresent.blobs &&
  ref.tablesPresent.runs;

/**
 * [待实验] dispose 三级（agent / executor / store：sqlite driver、blob cache）各自是否真释放，
 * 由实验 A（force GC + 多次 heap 快照 + 点名支配路径）判定。本函数仅把快照结论归档成档位。
 */
export type DisposeLevel = "agent" | "executor" | "store";
export interface DisposeProbeResult {
  level: DisposeLevel;
  released: boolean;
  /** 支配路径（heap snapshot dominator），有残留时必填 */
  dominator?: string;
}

export const summarizeDisposeProbe = (
  results: DisposeProbeResult[],
): { allReleased: boolean; leakedLevels: DisposeLevel[] } => {
  const leakedLevels = results.filter((r) => !r.released).map((r) => r.level);
  return { allReleased: leakedLevels.length === 0, leakedLevels };
};

// ---------------- ② 内置工具拦截点契约（P2-1，实验 B 检查项） ----------------

/**
 * [待实验] SDK 内置工具（bash / read / write / edit）执行前有无 hook 可供意图日志先写后做。
 * 若无 hook → 意图日志对该工具不可写（记“不可包”），不静默跳过；
 * 可行兜底：bash 禁用或收编为自研工具，把“拦截待验证”变为设计保证。
 * 结论填进实验 B：逐工具给出 interceptable = true / false。
 */
export type BuiltinToolKind = "bash" | "read" | "write" | "edit";

export interface BuiltinToolInterceptResult {
  tool: BuiltinToolKind;
  /** 该工具执行前能否插钩先写意图日志 */
  interceptable: boolean;
}

/** [待实验] 内置工具无 hook 时的兜底方向（实验 B 确认后转 [设计决策]）。 */
export const BUILTIN_TOOL_FALLBACK_IF_NO_HOOK =
  "disable-bash-and-adopt-self-developed-tools" as const;

/**
 * [设计决策] 意图日志覆盖度只看 bash（P3-3 分级修正）。
 * 分级设计：只有能造成外部不可逆副作用的工具（bash + 自研工具）才走意图日志；
 * read/write/edit 是本地文件操作、留 worker 内靠 checkpoint 恢复，本来就不进意图日志、不设门槛。
 * 自研工具默认可包（调用方负责包）。bash 不可拦截时必须走兜底（禁用 bash / 收编自研工具），
 * 不允许静默跳过意图日志。
 */
export const isSideEffectInterceptCovered = (
  results: BuiltinToolInterceptResult[],
  opts: { bashDisabledOrAdopted?: boolean } = {},
): boolean => {
  // bash 已禁用/收编 = 无需拦截即覆盖（兜底本身就是设计保证）
  if (opts.bashDisabledOrAdopted === true) return true;
  const byTool = new Map(results.map((r) => [r.tool, r.interceptable]));
  return byTool.get("bash") === true;
};

// ================ v3.1 Worker 进程隔离（终版 + 封版纪要） ================
// 约定：以下全部为纯契约（无 IO、无 SDK 依赖）。文件 IO 的 epoch 派发见 worker-epoch.ts。

/** [设计决策] 空闲 TTL 唯一常数：worker 空闲 reaping 与会话 TTL 对齐，消除错位窗（封版纪要修订三3）。 */
export const IDLE_TTL_MINUTES = SESSION_IDLE_TTL_MINUTES;

/** [设计决策] worker 空闲 reaping TTL（= IDLE_TTL，单点收敛，改一处即全改）。 */
export const WORKER_IDLE_REAP_MINUTES = IDLE_TTL_MINUTES;

// ---------- §3.2 触发判定：双 guard（绝对值 + 比例）+ RSS 线 ----------

/** [设计决策] worker old-space 绝对值水位（spawn 上限 1536 下良定义，实验 A 校准）。 */
export const WORKER_OLD_SPACE_SOFT_BYTES = 1.2 * 1024 * 1024 * 1024;
export const WORKER_OLD_SPACE_HARD_BYTES = 1.5 * 1024 * 1024 * 1024;

/** [设计决策] old-space 占 heap_size_limit 比例 guard（防他日改上限忘改阈值 + 主进程侧主力）。 */
export const WORKER_HEAP_RATIO_SOFT = 0.6 as const;
export const WORKER_HEAP_RATIO_HARD = 0.8 as const;

/**
 * [设计决策] 进程 RSS 水位（native / sqlite cache / Buffer 不在 old-space 内，必须单列）。
 * 初值 = old-space 阈值 ×1.3 / ×1.5，实验 A 校准。[待实验]
 */
export const WORKER_RSS_SOFT_BYTES = 2.0 * 1024 * 1024 * 1024;
export const WORKER_RSS_HARD_BYTES = 2.3 * 1024 * 1024 * 1024;

export type WorkerMemoryLevel = "normal" | "soft" | "hard";

export interface WorkerMemorySample {
  /** V8 old-space 已用（worker 自报） */
  oldSpaceBytes: number;
  /** old-space / heap_size_limit（worker 自报，缺省用绝对值判定） */
  heapRatio?: number;
  /** 进程 RSS（worker 自报 + 主进程仲裁） */
  rssBytes: number;
}

/**
 * [设计决策] 双 guard 任一命中即触发：三条线各算档位，取最高。
 * 纯函数，单测锁行为。
 */
export const classifyWorkerMemory = (s: WorkerMemorySample): WorkerMemoryLevel => {
  const levels: WorkerMemoryLevel[] = [];
  levels.push(
    s.oldSpaceBytes >= WORKER_OLD_SPACE_HARD_BYTES
      ? "hard"
      : s.oldSpaceBytes >= WORKER_OLD_SPACE_SOFT_BYTES
        ? "soft"
        : "normal",
  );
  if (typeof s.heapRatio === "number") {
    levels.push(
      s.heapRatio >= WORKER_HEAP_RATIO_HARD
        ? "hard"
        : s.heapRatio >= WORKER_HEAP_RATIO_SOFT
          ? "soft"
          : "normal",
    );
  }
  levels.push(
    s.rssBytes >= WORKER_RSS_HARD_BYTES
      ? "hard"
      : s.rssBytes >= WORKER_RSS_SOFT_BYTES
        ? "soft"
        : "normal",
  );
  if (levels.includes("hard")) return "hard";
  if (levels.includes("soft")) return "soft";
  return "normal";
};

// ---------- §3.4 整机内存顶（A1-全局） ----------

/** [设计决策] MAX_WORKERS 硬顶（再多也不 spawn，进队列排队）。 */
export const MAX_WORKERS_HARD_CAP = 4 as const;

/** [设计决策] 系统余量初值 1.5G（实验 A 校准；RESERVE 含 Next server + Electron 预算 + 余量）。 */
export const SYSTEM_RESERVE_BYTES = 1.5 * 1024 * 1024 * 1024;

export interface MaxWorkersInput {
  totalMemBytes: number;
  reserveBytes: number;
  workerHardBytes?: number;
  hardCap?: number;
}

/**
 * [设计决策] 动态公式（封版纪要修订三2）：
 * MAX_WORKERS = max(1, min(4, floor((total - reserve) / workerHard)))。
 * 下限 1 保证小内存机器至少能跑一个 worker；上取整溢出/负数时同样保底 1。
 */
export const resolveMaxWorkers = (input: MaxWorkersInput): number => {
  const workerHard = input.workerHardBytes ?? WORKER_RSS_HARD_BYTES;
  const cap = input.hardCap ?? MAX_WORKERS_HARD_CAP;
  if (!(workerHard > 0)) return 1;
  const usable = input.totalMemBytes - input.reserveBytes;
  const byMem = Math.floor(usable / workerHard);
  if (!Number.isFinite(byMem)) return 1;
  return Math.max(1, Math.min(cap, byMem));
};

/** [设计决策] 整机公式：TOTAL_RSS_LIMIT = MAIN_PROC_RSS + MAX_WORKERS × WORKER_RSS_HARD。 */
export const buildTotalRssLimit = (args: {
  mainProcRssBytes: number;
  maxWorkers: number;
  workerHardBytes?: number;
}): number =>
  args.mainProcRssBytes +
  args.maxWorkers * (args.workerHardBytes ?? WORKER_RSS_HARD_BYTES);

// ---------- §4 重启阶梯：续接双限额 ----------

/** [设计决策] 每 action ≤3 次自动续接。 */
export const ROTATION_MAX_PER_ACTION = 3 as const;
/** [设计决策] 每 task 每小时 ≤6 次（初值，实验校准）。 */
export const ROTATION_MAX_PER_TASK_PER_HOUR = 6 as const;
/** [设计决策] 单 task 计数超 50 即整 task 降级（防单 task 挤爆全局 500 额度）。 */
export const ROTATION_TASK_TOTAL_CAP = 50 as const;

export interface RotationAllowanceInput {
  actionCount: number;
  taskHourCount: number;
  taskTotalCount: number;
}

export type RotationDenyReason = "action-cap" | "hour-cap" | "task-cap";

/**
 * [设计决策] 双限额任一超限即降级为「停止自动续接、提示用户手动唤醒」。
 * 自然完成回退计数由调用方负责（防白扣），本函数只判当前值。
 */
export const isRotationAllowed = (
  input: RotationAllowanceInput,
): { allowed: boolean; reason?: RotationDenyReason } => {
  if (input.actionCount >= ROTATION_MAX_PER_ACTION)
    return { allowed: false, reason: "action-cap" };
  if (input.taskHourCount >= ROTATION_MAX_PER_TASK_PER_HOUR)
    return { allowed: false, reason: "hour-cap" };
  if (input.taskTotalCount >= ROTATION_TASK_TOTAL_CAP)
    return { allowed: false, reason: "task-cap" };
  return { allowed: true };
};

// ---------- §5.1 意图日志：at-most-once + 幂等标记 ----------

/** [设计决策] 外发消息幂等标记格式（feishu-message / notify 共用，人工比对用）。 */
export const INTENT_REF_MARKER_PREFIX = "[ref:" as const;

export const buildIntentRefMarker = (intentId: string): string =>
  `${INTENT_REF_MARKER_PREFIX}${intentId}]`;

/** [设计决策] 无查询 API 的 kind 一律 at-most-once（宁漏勿重，产品决策——封版纪要修订二1）。 */
export const INTENT_AT_MOST_ONCE_KINDS = [
  "feishu-message",
  "notify",
] as const;

export type AtMostOnceKind = (typeof INTENT_AT_MOST_ONCE_KINDS)[number];

export const isAtMostOnceKind = (kind: SideEffectIntent["kind"]): boolean =>
  (INTENT_AT_MOST_ONCE_KINDS as readonly string[]).includes(kind);

/**
 * [设计决策] 恢复策略：at-most-once 的 kind 查不到/对不上 → 标 abandoned 人工，不自动重试；
 * external-api 对方不支持幂等键透传 → 同样 abandoned、不自动重试。
 */
export const shouldAutoRetryIntent = (args: {
  kind: SideEffectIntent["kind"];
  verifiedAbsent: boolean;
}): boolean => {
  // 只有「确认对方没收到」才允许重试；不确定时 at-most-once 的一律不重发。
  if (!args.verifiedAbsent) return false;
  if (isAtMostOnceKind(args.kind)) return false;
  return true;
};

// ---------- §6 切段续接：接力消息硬预算 ----------

/** [设计决策] 接力消息硬预算 ≤8k token，超限触发二级摘要。 */
export const RELAY_BUDGET_TOKENS = 8000 as const;

export const isRelayOverBudget = (tokens: number): boolean =>
  tokens > RELAY_BUDGET_TOKENS;

// ---------- §7 epoch + fencing（纯侧；IO 见 worker-epoch.ts） ----------

/** [设计决策] epoch 文件名（按 stateRoot 独立存放，跨 workspace 互不影响——封版纪要修订一）。 */
export const WORKER_EPOCH_FILENAME = "worker-epoch.json" as const;

export interface WorkerEpochDoc {
  epoch: number;
}

/** 纯函数：解析 epoch 文件内容；缺失/损坏 → 0（调用方据此从 1 开始派发）。 */
export const parseWorkerEpoch = (raw: string | null | undefined): number => {
  if (!raw) return 0;
  try {
    const doc = JSON.parse(raw) as Partial<WorkerEpochDoc>;
    const n = typeof doc.epoch === "number" ? Math.floor(doc.epoch) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

/** 纯函数：下一 epoch（当前 +1，下限 1）。 */
export const nextWorkerEpoch = (current: number): number =>
  (Number.isFinite(current) && current >= 0 ? Math.floor(current) : 0) + 1;

/**
 * [设计决策] fencing：同 stateRoot 内，写请求的 epoch 小于当前落盘 epoch → 拒绝
 * （旧 worker 假死复活后的一切写被挡掉，杜绝双跑双写）。跨 workspace 不比较。
 */
export const isWriteFenced = (args: {
  writeEpoch: number;
  currentEpoch: number;
}): boolean => args.writeEpoch < args.currentEpoch;

/** [设计决策] IPC 事件去重键（含 epoch，同 workspace 语义；不依赖 SDK seq 语义）。 */
export const buildEventDedupKeyWithEpoch = (
  agentId: string,
  runId: string,
  epoch: number,
  localSeq: number,
): string => `${agentId}:${runId}:${epoch}:${localSeq}`;

// ---------- §5.2 四档拦截点（实验 B 优先级最高的一问） ----------

export type InterceptTier = "a-hook" | "b-override" | "c-path-shim" | "d-residual";

export interface InterceptTierInput {
  hasHook: boolean;
  hasToolOverride: boolean;
  pathInjectionEffective: boolean;
}

/**
 * [待实验] 四档判定：(a) hook → 包 hook；(b) override → wrapper 路线成立；
 * (c) PATH 注入生效 → PATH shim 成立；(d) 都没有 → 残余风险升级，用户拍板。
 * 判定只影响路线选择，不影响「无覆盖不许静默跳过」的硬约束。
 */
export const decideInterceptTier = (input: InterceptTierInput): InterceptTier => {
  if (input.hasHook) return "a-hook";
  if (input.hasToolOverride) return "b-override";
  if (input.pathInjectionEffective) return "c-path-shim";
  return "d-residual";
};
