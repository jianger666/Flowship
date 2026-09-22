/**
 * 内存治理契约（mem-governance v2 开工清单配套）。
 *
 * 本文件只放**纯函数 + 常量**（无 SDK 依赖、无副作用），供 ①③ 直接用、② 落契约：
 * - ① 即用即还判定：shouldDisposeAfterAction（task-runner 正常结束路径调用）
 * - ② 意图日志幂等键 / 事件去重键：落成可直接写成代码接口的粒度
 * - ② 恢复侧跨表校验：isCheckpointUsable（sqlite 只保单事务原子，跨表需校验+回退）
 * - ② 内置工具拦截点：BUILTIN_TOOL_INTERCEPT（实验 B 检查项，包不住则意图日志不可写）
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
