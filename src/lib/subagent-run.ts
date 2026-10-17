/**
 * 子代理「过程记录」的共享类型与解析（纯函数，客户端 / 服务端共用）
 *
 * # 为什么需要它
 * 子代理（Cursor 的 `subagent` 自定义工具 / pi 的 `task`）是主 AI 在工具调用里起的一个**嵌套子 agent**，
 * 它自己的 thinking / 工具调用 / 回复**不进主事件流**（主流里只有一张「子代理」卡：任务书 + 最终产出）。
 * 用户想看「它到底给子代理下了什么指令、子代理又干了些什么」就无处可看（2026-10-17 用户要求：
 * 事件流里的子代理卡片和聊天框上方的「后台工作」条都能点开看详情——提示词 + 子代理干活的事件流）。
 *
 * # 形态
 * 服务端按一次子代理调用记一份 {@link SubagentRunSnapshot}：元信息 + **和主事件流同形的 TaskEvent 列表**
 * （thinking / assistant_message / tool_call / tool_result）。详情面板拿它直接走主流同一条渲染管线
 * （工作过程组 / 工具块 / 回复行），所以子代理的过程看起来和主 AI 的一模一样，不另造一套展示。
 *
 * # 存哪、怎么找
 * 内存里一份（运行中实时更新）+ 落盘到 `tasks/<id>/subagent-runs/<key>.json`（重开应用 / 翻历史还能看）。
 * 事件流卡片按工具调用的 callId 找（服务端把 callId 绑到记录上），聊天框上方的条按记录 key 找。
 */

import type { TaskEvent } from "@/lib/types";

/** 子代理一次调用的状态 */
export type SubagentRunStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  /** 记录显示还在跑、但应用已重启 / 进程里已没有它（只可能从磁盘读出来时出现） */
  | "interrupted";

const STATUSES: readonly SubagentRunStatus[] = [
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
];

export type SubagentRunProvider = "cursor" | "pi";

/** 一次子代理调用的元信息 */
export interface SubagentRunMeta {
  /** 记录 key（`sa_xxxxxxxxxx`），整个生命周期不变；落盘文件名 / 条上点开用它 */
  key: string;
  provider: SubagentRunProvider;
  /** 3-5 个词的摘要（模型给的；没给取 prompt 开头） */
  description: string;
  /** **完整**任务书（事件流卡片上的 args 会被截到 2000 字，这里是全文） */
  prompt: string;
  /** 实际生效的模型 id；undefined = 沿用 SDK 默认 */
  model?: string;
  /** 实际生效的思考档；undefined = 模型默认 / 没覆盖 */
  effort?: string;
  /** true = 只读探索（read / grep / glob / ls）；false = 默认内置工具 */
  explore: boolean;
  /** true = 这次是 resume 接着之前某个子代理做的（它记得之前的上下文，这份记录只含本次新增的过程） */
  resumed: boolean;
  /** SDK 分配的子 agent id（Cursor；pi 没有） */
  agentId?: string;
  /** 后台运行（主 AI 没在等它） */
  background: boolean;
  /** true = 一开始是前台、用户插话时转到后台的 */
  detached: boolean;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  /** 完成时的最终文本（不含给模型看的 id / 模型尾注） */
  result?: string;
  /** 失败原因（failed 时） */
  error?: string;
  /** 能解析到这条记录的工具调用 callId（事件流卡片按它找） */
  callIds: string[];
}

/** 一份过程记录快照（接口返回 / 落盘的形态） */
export interface SubagentRunSnapshot {
  meta: SubagentRunMeta;
  /** 与主事件流同形：thinking / assistant_message / tool_call / tool_result，按发生顺序 */
  events: TaskEvent[];
  /** 每次变化 +1；轮询时带上它，没变化服务端只回 `unchanged` */
  rev: number;
  /** 因超过条数上限没记下来的新条目数（> 0 时界面提示「后面的过程没有记录」） */
  droppedEvents: number;
}

/** 记录的上限（防一次疯狂的子代理把内存 / 磁盘撑爆） */
export const SUBAGENT_RUN_LIMITS = {
  /** 一次调用最多记多少个条目（thinking / 回复 / 工具调用各算一条；工具结果跟着它的调用走） */
  maxEvents: 600,
  /** 单段回复文本上限（字符） */
  assistantTextMax: 32_000,
  /** 单段思考文本上限（字符） */
  thinkingTextMax: 16_000,
  /** 工具调用参数上限（字符） */
  toolArgsMax: 2_000,
  /** 最终文本上限（字符） */
  resultMax: 32_000,
  /** 一个任务最多留多少份落盘记录（超出删最旧的） */
  maxRunsPerTask: 60,
} as const;

/** 详情面板轮询间隔（ms）：运行中才轮询，到终态就停 */
export const SUBAGENT_RUN_POLL_MS = 1000;

export const isSubagentRunTerminal = (status: SubagentRunStatus): boolean =>
  status !== "running";

const STATUS_LABEL: Record<SubagentRunStatus, string> = {
  running: "运行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export const subagentRunStatusLabel = (status: SubagentRunStatus): string =>
  STATUS_LABEL[status];

/** 已用时（ms）：终态用 endedAt，运行中用 now；时钟回拨钳成 0 */
export const subagentRunElapsedMs = (
  meta: Pick<SubagentRunMeta, "startedAt" | "endedAt" | "status">,
  now: number,
): number =>
  Math.max(
    0,
    (meta.status === "running" ? now : (meta.endedAt ?? now)) - meta.startedAt,
  );

// ---------- 解析（接口返回 / 落盘文件都按「不可信输入」校验） ----------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const optString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** 过程记录里只会出现这四类事件（其它一律丢掉，渲染管线不该见到别的） */
const RUN_EVENT_KINDS: ReadonlySet<string> = new Set([
  "thinking",
  "assistant_message",
  "tool_call",
  "tool_result",
]);

const parseRunMeta = (raw: unknown): SubagentRunMeta | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.key !== "string" || raw.key.length === 0) return null;
  if (typeof raw.prompt !== "string") return null;
  if (!STATUSES.includes(raw.status as SubagentRunStatus)) return null;
  if (!isFiniteNumber(raw.startedAt)) return null;
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : "子任务";
  return {
    key: raw.key,
    provider: raw.provider === "pi" ? "pi" : "cursor",
    description,
    prompt: raw.prompt,
    ...(optString(raw.model) ? { model: optString(raw.model) } : {}),
    ...(optString(raw.effort) ? { effort: optString(raw.effort) } : {}),
    explore: raw.explore === true,
    resumed: raw.resumed === true,
    ...(optString(raw.agentId) ? { agentId: optString(raw.agentId) } : {}),
    background: raw.background === true,
    detached: raw.detached === true,
    status: raw.status as SubagentRunStatus,
    startedAt: raw.startedAt,
    ...(isFiniteNumber(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
    ...(optString(raw.error) ? { error: optString(raw.error) } : {}),
    callIds: Array.isArray(raw.callIds)
      ? raw.callIds.filter((c): c is string => typeof c === "string")
      : [],
  };
};

const parseRunEvent = (raw: unknown): TaskEvent | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.kind !== "string" || !RUN_EVENT_KINDS.has(raw.kind)) return null;
  if (typeof raw.text !== "string") return null;
  return {
    id: raw.id,
    ts: isFiniteNumber(raw.ts) ? raw.ts : 0,
    kind: raw.kind as TaskEvent["kind"],
    text: raw.text,
    ...(isRecord(raw.meta) ? { meta: raw.meta } : {}),
  };
};

/**
 * 解析一份快照（接口返回 / 落盘文件）：meta 不合法 → null；events 逐条校验、坏条目丢掉、同 id 去重。
 * 不合法的整份丢弃，宁可显示「没有记录」也别拿脏数据去喂渲染管线。
 */
export const parseSubagentRunSnapshot = (
  raw: unknown,
): SubagentRunSnapshot | null => {
  if (!isRecord(raw)) return null;
  const meta = parseRunMeta(raw.meta);
  if (!meta) return null;
  const seen = new Set<string>();
  const events: TaskEvent[] = [];
  if (Array.isArray(raw.events)) {
    for (const item of raw.events) {
      const ev = parseRunEvent(item);
      if (!ev || seen.has(ev.id)) continue;
      seen.add(ev.id);
      events.push(ev);
    }
  }
  return {
    meta,
    events,
    rev: isFiniteNumber(raw.rev) ? raw.rev : 0,
    droppedEvents:
      isFiniteNumber(raw.droppedEvents) && raw.droppedEvents > 0
        ? Math.floor(raw.droppedEvents)
        : 0,
  };
};

/** 接口响应（`GET /api/tasks/[id]/subagent-runs`）解析后的三种结果 */
export type SubagentRunResponse =
  | { kind: "snapshot"; snapshot: SubagentRunSnapshot }
  /** 带的 rev 与服务端一致：没有变化，不用重画 */
  | { kind: "unchanged"; rev: number }
  /** 没有这份记录（404：早于该功能 / 被清理 / 另一台机器的会话） */
  | { kind: "missing" };

export const parseSubagentRunResponse = (
  status: number,
  body: unknown,
): SubagentRunResponse | null => {
  if (status === 404) return { kind: "missing" };
  if (!isRecord(body)) return null;
  if (body.unchanged === true && isFiniteNumber(body.rev)) {
    return { kind: "unchanged", rev: body.rev };
  }
  const snapshot = parseSubagentRunSnapshot(body.run);
  return snapshot ? { kind: "snapshot", snapshot } : null;
};

/** 详情面板要打开哪一个子代理 */
export type SubagentRunRef =
  /** 事件流卡片：按工具调用 callId 找 */
  | { by: "callId"; callId: string }
  /** 聊天框上方的条：按记录 key 找 */
  | { by: "key"; key: string };

/**
 * 找不到过程记录时详情面板退回展示的信息（事件流卡片自己手上就有这些；条上的没有）。
 * 让「早于该功能的历史卡片」点开也至少能看到任务书和产出，而不是一片空白。
 */
export interface SubagentRunFallback {
  description?: string;
  /** 卡片 args 里的任务书（可能被截到 2000 字） */
  prompt?: string;
  model?: string;
  effort?: string;
  /** 卡片上的产出文本 */
  output?: string;
  /** 卡片当前状态：运行中时「没有记录」可能只是还没建好，面板会多等几秒再下结论 */
  running?: boolean;
}

export interface SubagentDetailTarget {
  ref: SubagentRunRef;
  /** 标题兜底（记录还没加载出来时先显示它） */
  title?: string;
  fallback?: SubagentRunFallback;
}

/** 目标的稳定标识（面板据此判断「是不是又点开了同一个」、重置加载态） */
export const subagentDetailTargetId = (target: SubagentDetailTarget): string =>
  target.ref.by === "key"
    ? `key:${target.ref.key}`
    : `call:${target.ref.callId}`;
