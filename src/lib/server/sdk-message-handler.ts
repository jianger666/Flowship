/**
 * SDKMessage → task 事件流翻译器（V0.9.x 从 task-runner.ts 拆出；
 * Phase 1 起 chat-runner 也复用本模块，消灭私有 handleSdkMessage 重复债）
 *
 * 职责：把 SDK run.stream() 吐的每条消息翻译成 events.jsonl 事件 + SSE publish：
 *   - thinking / tool_call / tool_result / assistant（流式缓冲）/ status
 *   - compaction_start/end（自定义 pi 合成消息 → info 过程行；不 flush 正文）
 *   - artifact 写入检测（write/edit 命中 actions/ 路径 → 「在写 artifact」+ 落盘后刷 artifactUpdatedAt）
 *   - submit_work 特判（状态由 awaitingNotifier 管、这里只记 error）
 *
 * 依赖方向（保证无环）：只依赖 task-stream + task-fs + tool-result-persist、不 import task-runner / chat-runner。
 */

import type { SDKMessage } from "@cursor/sdk";

import {
  compactionEventMeta,
  compactionEventText,
} from "@/lib/compaction-display";

import { appendEvent, getTask, patchActionIfOwner } from "./task-fs";
import { newEventId } from "./task-fs-core";
import { failpoint } from "./failpoints";
import {
  publish,
  publishIfCurrent,
  stringifyMeta,
  truncate,
  writeOwnedEventAndPublish,
} from "./task-stream";
import { buildToolResultMeta } from "./tool-result-persist";

/**
 * 交卷成功后的固定收尾文案（AI 播报形态、内容平台统一固定）。
 * 不出现「交卷 / submit_work」等内部术语——用户只需要知道「产出已更新、等审阅」。
 * 结论须在交卷前说完；交卷后正文照常上屏（Cursor 宿主空完成会塞续跑），
 * 回合自然结束时由平台在答案之后补发这一句横幅。
 */
export const SUBMIT_COMPLETED_TEXT = "已完成，产出已更新，请审阅。";

/** 把攒着的 thinking token 落成一条事件。tool / 正文 / run 结束前都要先冲掉。 */
export const flushThinkingBuffer = async (
  taskId: string,
  ctx: AssistantBufferCtx,
  lease: () => boolean,
  origin?: string,
): Promise<void> => {
  // 这段思考结束：没发出去的实时帧尾巴直接丢（紧跟着落盘的 thinking 事件带完整文本）。
  // 放在最前、不受下面 `!text` 早退影响——run 结束路径也经过这里，保证不留残余定时器
  discardPendingThinkingDeltas(taskId);
  const text = ctx.thinkingBuffer ?? "";
  const durationMs = ctx.thinkingDurationMs;
  // 预定的事件 id 跟 buffer 一起取走并清零：本段到此为止，下一段重新预定。
  // 放在 `!text` 早退和 lease 检查之前——空段 / 失主都不能把 id 漏给下一段
  const eventId = ctx.thinkingEventId;
  ctx.thinkingBuffer = "";
  ctx.thinkingDurationMs = undefined;
  ctx.thinkingEventId = undefined;
  if (!text) return;
  // 确有 thinking 要落盘才冲已缓冲的正文 delta——保住 SSE 帧时序；
  // （不能无条件冲：case "assistant" 开头也调本函数、逐 chunk 冲会废掉合帧）
  flushPendingAssistantDeltas(taskId);
  if (!lease()) return;
  const meta = {
    ...(durationMs ? { durationMs } : {}),
    ...(ctx.askSeen ? { muted: true } : {}),
  };
  const ev = {
    kind: "thinking" as const,
    text,
    // 复用实时帧里已经告诉前端的 id：前端「进行中的思考行」与这条落盘事件是同一个 React 节点。
    // 没发过实时帧的（旁路答疑 / 已提问消音）没有预定 id，由 appendEvent 现生成
    ...(eventId ? { id: eventId } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
  if (ctx.askSeen) {
    await appendEvent(taskId, ev, lease);
    return;
  }
  await writeOwnedEventAndPublish(taskId, lease, ev, origin);
};

// assistant 文本的流式缓冲：delta 先 publish 给 UI 打字机、攒到下个非 assistant 消息时 flush 落盘
export interface AssistantBufferCtx {
  buffer: string;
  flush: () => Promise<void>;
  /** 思考 delta 攒在这儿，一段思考只落一条 thinking 事件（pi 的 thinking_delta 是 token 级） */
  thinkingBuffer?: string;
  /** 本段思考累加的 durationMs（最后一条 SDK thinking 常带） */
  thinkingDurationMs?: number;
  /**
   * 本段思考落盘后那条 thinking 事件的 id，第一个实时帧发出时预先定好、落盘时复用
   * （见 flushThinkingBuffer）。放在 ctx 而不是按 taskId 的节流状态里：ctx 是每路 run 自己的，
   * 旁路答疑的 flush 取不到主链的 id，不会出现两条事件同 id。
   */
  thinkingEventId?: string;
  sdkErrorMessage?: string;
  /** 本回合已交卷成功：之后模型输出（答案）照常广播、固定收尾延到 run 结束 */
  submitSeen?: boolean;
  /** 固定收尾是否已补发（防重复） */
  fixedSent?: boolean;
  /** 本回合已提问成功（ask_user 返回 [ASK_SUBMITTED]）：等 curl 吐出答案前，调查类输出和那条 wait curl 都消音 */
  askSeen?: boolean;
  /** 本轮是否写/改过 artifact（actions/*.md）——交卷时判定「产出是否真的更新」（事实信号、无语义判断） */
  artifactWritten?: boolean;

  /**
   * 回合结束后的重放保护（只有 chat 开；task 有「交卷后宿主塞续跑」语义，保持原行为）。
   *
   * 背景（实测）：一次 agent.send = 一个 turn，SDK 只在回合末发**一条** usage（= turn-ended）。
   * 回合结束后同一条流上又来 thinking / assistant，是 SDK 的无进展检测（stall）
   * 取消了「迟迟不收尾」的 attempt、从 checkpoint 重放同一请求——内容和第一遍重复，
   * 用户看到的就是「回复完了、转圈很久、又回复一遍」。
   *
   * 开启后：usage 到达即把回复落盘（不再等下一个事件 / run 结束才落），其后的 thinking / assistant 丢弃。
   *
   * ⚠️ 只丢事件、绝不因此 run.cancel()：turn-ended 到达时本轮**还没写进 checkpoint**
   * （要等 SDK 把 checkpoint 存完发 FINISHED，正常 ~0.3s），此时 cancel 会让这一轮从 AI 记忆里消失
   * （2026-10 探针实测：cancel 后同实例 / resume 后追问都「没看到你让我记住的内容」）。
   */
  dropAfterTurnEnded?: boolean;
  /** 本 run 收到的 usage（turn-ended）条数；>1 说明 SDK 重放过 */
  turnEndedCount?: number;
  /** 首条 usage 到达时刻（ms epoch），用来量「回合结束 → SDK 真正收尾」的延迟 */
  turnEndedAt?: number;
  /** 回合结束之后被丢弃 / 计数的重放消息（观测用，不落事件流） */
  replayDropped?: {
    thinking: number;
    assistant: number;
    assistantChars: number;
    /** 重放里出现工具调用：不丢（用户得看到真有动作），只计数 + 告警 */
    toolCalls: number;
  };
  /** 首条 usage 落盘完回复之后回调——chat consume 在这里起「回复已完成、收尾中」提示的定时器 */
  onTurnEnded?: () => void;
}

/** 本 run 是否已过回合结束、且开了重放保护 */
const isAfterTurnEnd = (ctx: AssistantBufferCtx): boolean =>
  ctx.dropAfterTurnEnded === true && (ctx.turnEndedCount ?? 0) >= 1;

/** 记一次回合结束后的重放消息；本 run 第一次出现时告警一行（后续只计数，免得刷屏） */
const noteReplayDropped = (
  taskId: string,
  ctx: AssistantBufferCtx,
  kind: "thinking" | "assistant" | "toolCalls",
  chars = 0,
): void => {
  const d = (ctx.replayDropped ??= {
    thinking: 0,
    assistant: 0,
    assistantChars: 0,
    toolCalls: 0,
  });
  const first = d.thinking + d.assistant + d.toolCalls === 0;
  d[kind] += 1;
  if (kind === "assistant") d.assistantChars += chars;
  if (!first) return;
  console.warn(
    kind === "toolCalls"
      ? `[sdk-message-handler] task=${taskId} turn-ended 之后同一条流又出现工具调用（SDK 重放中带动作），不丢弃、仅计数`
      : `[sdk-message-handler] task=${taskId} turn-ended 之后同一条流又来了 ${kind}（疑似 SDK 无进展重放），已丢弃、不落盘不上屏`,
  );
};

/** curl stdout 里出现答案 → 同一轮继续，不再消音、不 cancel */
export const maybeClearAskSeenAfterWaitReply = (
  ctx: AssistantBufferCtx,
  msg: { status?: string; result?: unknown },
): void => {
  if (!ctx.askSeen || msg.status !== "completed") return;
  const resStr =
    typeof msg.result === "string"
      ? msg.result
      : stringifyMeta(msg.result ?? {});
  if (!resStr.includes("[ASK_USER_REPLY]")) return;
  ctx.askSeen = false;
};

/**
 * 补发固定收尾（交卷成功才补、一次）。
 * 只在 run 自然结束时调用（task-runner / chat-runner 的兜底）——交卷后的答案
 * 已照常广播完、横幅跟在答案之后、once 守卫保证只发一次。
 * 两条都走 info（轻量提示、不占 AI 气泡）：「已完成，产出已更新，请审阅。」（写了产出）
 * 或「已回复」（纯答疑、没动产出）。
 */
export const maybeEmitSubmitFixedText = async (
  ctx: AssistantBufferCtx,
  write: (ev: { kind: "assistant_message" | "info"; text: string }) => Promise<unknown>,
): Promise<boolean> => {
  if (!ctx.submitSeen || ctx.fixedSent) return false;
  ctx.fixedSent = true;
  if (ctx.artifactWritten) {
    await write({ kind: "info", text: SUBMIT_COMPLETED_TEXT });
  } else {
    await write({ kind: "info", text: "已回复" });
  }
  return true;
};

// ----------------- tool_call running 去重（同 callId 只落一条） -----------------
// SDK 对长 args 工具（task / edit）会流式补全 args、对同一 call_id 发多次 status=running；
// 若不挡、events.jsonl 双写 → UI 渲染成对工具块（线上「子代理成对出现」根因）。
const TOOL_CALL_RUNNING_SEEN_KEY = "__flowshipToolCallRunningSeenV1__";
/** 长跑进程防无界；超限 FIFO 淘汰最旧 callId */
const TOOL_CALL_RUNNING_SEEN_MAX = 2000;

type ToolCallRunningSeen = {
  set: Set<string>;
  /** FIFO 插入序，与 set 同步 */
  order: string[];
};

const getToolCallRunningSeen = (): ToolCallRunningSeen => {
  const g = globalThis as unknown as Record<
    string,
    ToolCallRunningSeen | undefined
  >;
  if (!g[TOOL_CALL_RUNNING_SEEN_KEY]) {
    g[TOOL_CALL_RUNNING_SEEN_KEY] = { set: new Set(), order: [] };
  }
  return g[TOOL_CALL_RUNNING_SEEN_KEY]!;
};

/**
 * 标记 callId 已写过 running；返回 false = 本条应跳过写盘。
 * completed / error 不走此门。
 */
const tryMarkToolCallRunningSeen = (callId: string): boolean => {
  if (!callId) return true;
  const state = getToolCallRunningSeen();
  if (state.set.has(callId)) return false;
  state.set.add(callId);
  state.order.push(callId);
  while (state.order.length > TOOL_CALL_RUNNING_SEEN_MAX) {
    const oldest = state.order.shift();
    if (oldest) state.set.delete(oldest);
  }
  return true;
};

/** 单测清空去重表（避免用例互相污染） */
export const __resetToolCallRunningSeenForTest = (): void => {
  const g = globalThis as unknown as Record<
    string,
    ToolCallRunningSeen | undefined
  >;
  g[TOOL_CALL_RUNNING_SEEN_KEY] = { set: new Set(), order: [] };
};

/** task 工具 args 默认上限放宽——短字段前置后仍要给 prompt 留展示空间 */
const TASK_TOOL_ARGS_TRUNCATE_MAX = 2000;

/**
 * updateTodos 主体是 todos 数组，没法短字段前置；默认 500 会截断条目 →
 * 前端 parseTodoToolArgs 解析不全。放宽到 4000 够常见清单。
 */
const TODO_TOOL_ARGS_TRUNCATE_MAX = 4000;

/** updateTodos / update_todos（大小写不敏感） */
const isUpdateTodosToolName = (name: string): boolean => {
  const n = name.toLowerCase();
  return n === "updatetodos" || n === "update_todos";
};

/**
 * task 工具：短字段（description / model / subagentType）前置再 stringify。
 * 原始键序常是 description→prompt→subagentType→model，prompt 动辄 500+，
 * 默认 truncate(500) 会把尾部 model 永久截掉 → 前端徽标永远拿不到。
 *
 * updateTodos：放大截断上限（见 TODO_TOOL_ARGS_TRUNCATE_MAX）。
 */
const stringifyToolCallArgs = (
  name: string,
  args: unknown,
): { argsStr: string; truncateMax: number } => {
  if (
    name === "task" &&
    args != null &&
    typeof args === "object" &&
    !Array.isArray(args)
  ) {
    const raw = args as Record<string, unknown>;
    const { description, model, subagentType, prompt, ...rest } = raw;
    // JSON.stringify 按插入序；undefined 值的键自动跳过
    const reordered = { description, model, subagentType, prompt, ...rest };
    return {
      argsStr: stringifyMeta(reordered),
      truncateMax: TASK_TOOL_ARGS_TRUNCATE_MAX,
    };
  }
  // 待办清单：数组是主体，只能放大截断上限
  if (isUpdateTodosToolName(name)) {
    return {
      argsStr: stringifyMeta(args),
      truncateMax: TODO_TOOL_ARGS_TRUNCATE_MAX,
    };
  }
  return { argsStr: stringifyMeta(args), truncateMax: 500 };
};

// 「写文件」类工具名白名单——只有这些工具命中 actions/ 路径才算「在写 artifact」。
// SDK 的 read（读）和 edit（写）都用 path 参数、无法靠 args 区分读写、只能靠工具名。
// 宁可漏标（某写工具不在表里 → 降级成「调用 X」、无害）、不可错标（read 标成「在写」= 误导）。
const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "create",
  "create_file",
  "search_replace",
  "str_replace",
  "multi_edit",
  "MultiEdit",
  "apply_patch",
]);

// 交卷工具（展示名「Submit Work」是 MCP title 映射，模型应调 submit_work）
const SUBMIT_TOOL_NAMES = new Set(["submit_work", "Submit Work"]);

/** 落一条 tool_result（completed / error 共用）；失败只打日志、不挡主流程 */
const emitToolResult = async (
  taskId: string,
  msg: Extract<SDKMessage, { type: "tool_call" }>,
  /** await 后写前复查 */
  stillCurrent: () => boolean,
  /** 旁路 run 身份（属主主链 undefined）——见 handleSdkMessage 的 origin 参数 */
  origin?: string,
  /** 消音审计：事件照常落盘但带 muted 标记、UI 不渲染 */
  muted?: boolean,
): Promise<void> => {
  try {
    const meta = await buildToolResultMeta({
      taskId,
      callId: msg.call_id,
      rawName: msg.name,
      args: msg.args,
      result: msg.result,
      msgStatus: msg.status,
    });
    // 代表性插桩——tool_result 构建 await 之后、写事件复查之前
    await failpoint("sdkmsg.beforeEventWrite");
    if (!stillCurrent()) return;
    const summary =
      meta.status === "error"
        ? `工具失败 ${meta.name}`
        : `工具完成 ${meta.name}`;
    const event = {
      kind: "tool_result" as const,
      text: summary,
      meta: muted ? { ...meta, muted: true } : meta,
    };
    if (muted) {
      // 消音审计：只落盘、不 SSE 广播——广播会让前端每来一条 muted chunk 重渲染整条
      // 事件流、贴底跟随反复触发（和用户上滚打架 = 高频抖动，实测回归）
      await appendEvent(taskId, event, stillCurrent);
    } else {
      await writeOwnedEventAndPublish(taskId, stillCurrent, event, origin);
    }
  } catch (err) {
    console.warn(
      `[sdk-message-handler] emitToolResult 失败 task=${taskId} call=${msg.call_id}`,
      err,
    );
  }
};

// ----------------- assistant_delta 合帧（perf：SSE 帧率收敛） -----------------
// SDK 的 text chunk 粒度极细（每秒几十条），逐条 publish 会把 SSE 帧 / 前端
// setState / Streamdown 重解析全部拉满、长对话时体感「吐字卡」。这里按
// 「70ms 或 240B」合帧后再广播——打字机观感不变、帧数降一个量级。
// 顺序安全：handleSdkMessage 对所有非 assistant 消息入口先冲缓冲（单线程、无竞态），
// 保证 tool / thinking / assistant_message 等其余事件永远晚于已缓冲 delta 到达 UI；
// 各 ctx.flush()（assistant_message 落盘前）也先冲，防「尾巴 delta 晚到成幽灵字」。
const DELTA_FLUSH_INTERVAL_MS = 70;
const DELTA_FLUSH_BYTES = 240;

interface PendingDeltaEntry {
  text: string;
  timer: NodeJS.Timeout | null;
  /** 入队时的 lease 闭包——flush 时重估，失主丢弃（闭包本身按当前实例动态判定） */
  lease: () => boolean;
  origin?: string;
}

const DELTA_BUFFER_MAP_KEY = "__flowshipAssistantDeltaBuffers__";
const getDeltaBufferMap = (): Map<string, PendingDeltaEntry> => {
  const g = globalThis as unknown as Record<
    typeof DELTA_BUFFER_MAP_KEY,
    Map<string, PendingDeltaEntry> | undefined
  >;
  if (!g[DELTA_BUFFER_MAP_KEY]) g[DELTA_BUFFER_MAP_KEY] = new Map();
  return g[DELTA_BUFFER_MAP_KEY];
};

/** 冲指定 key：有内容且 lease 仍 current 才广播（失主静默丢弃） */
const flushDeltaKey = (map: Map<string, PendingDeltaEntry>, key: string): void => {
  const buf = map.get(key);
  if (!buf) return;
  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }
  const text = buf.text;
  buf.text = "";
  map.delete(key);
  if (text.length === 0) return;
  if (!buf.lease()) return;
  publishIfCurrent(key.split("::")[0]!, buf.lease, {
    kind: "assistant_delta",
    text,
    ...(buf.origin ? { origin: buf.origin } : {}),
  });
};

/** 冲掉某任务全部待发 delta（同步、幂等）；空 entry 顺手清掉 */
export const flushPendingAssistantDeltas = (taskId: string): void => {
  const map = getDeltaBufferMap();
  const prefix = `${taskId}::`;
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) flushDeltaKey(map, key);
  }
};

/** assistant_delta 入队合帧：攒够字节/时间再广播；lease 失主在 flush 时自然丢弃 */
const enqueueAssistantDelta = (
  taskId: string,
  stillCurrent: () => boolean,
  origin: string | undefined,
  text: string,
): void => {
  const map = getDeltaBufferMap();
  const key = `${taskId}::${origin ?? ""}`;
  let buf = map.get(key);
  if (!buf) {
    buf = { text: "", timer: null, lease: stillCurrent, origin };
    map.set(key, buf);
  }
  const needFlush = buf.text.length === 0 && buf.timer === null;
  buf.text += text;
  if (buf.text.length >= DELTA_FLUSH_BYTES) {
    flushDeltaKey(map, key);
    return;
  }
  // 首 chunk 起一个定时兜底：慢速滴流也能按时上屏
  if (needFlush) {
    buf.timer = setTimeout(() => flushDeltaKey(map, key), DELTA_FLUSH_INTERVAL_MS);
  }
};

// ----------------- thinking_delta 节流（让「思考中」实时可见） -----------------
// 落盘仍是「一段思考一条 thinking 事件」（见 flushThinkingBuffer）；这里只管把「正在思考」
// 实时推给 UI。为什么要有它（2026-10-10 实测）：一段 65s 的思考，服务端第 6s 就收到了首个
// 增量，但整段攒到结束才落事件——用户对着「等待模型响应… 已等待 62s」干等了 70s，
// 而服务端口径的 firstDeltaMs 只有 6s、指标一切正常。
//
// leading + trailing 节流：
//   - 一段思考的首个 chunk 立刻发（零延迟——痛点就是「开始响应」看不见）；
//   - 之后每 250ms 最多一帧，带这期间攒下的增量（UI 只取最近一行，用不着高帧率；
//     实测一段 65s 思考有 1111 条 token 级 chunk，逐条发会把 SSE / setState 拉满）；
//   - 段结束（任何非 thinking 消息到达 / 落盘 / run 结束）→ 直接丢掉没发的尾巴：
//     紧跟着落盘的 thinking 事件带完整文本，前端收到它就清实时态，再补一帧只是白发，
//     还可能晚于落盘事件到达、造成幽灵「思考中」。
export const THINKING_DELTA_INTERVAL_MS = 250;

interface ThinkingThrottle {
  /** 还没发出去的增量 */
  pending: string;
  /** trailing 定时器（有值 = 已经排好到点要发的那一帧） */
  timer: NodeJS.Timeout | null;
  /** 上一帧发出的时刻（ms epoch；0 = 本段还没发过） */
  lastSentAt: number;
  /** 最近一次入队时的 lease 闭包——发之前重估，失主丢弃 */
  lease: () => boolean;
  /** 本段思考预定的落盘事件 id（随每一帧带给前端） */
  eventId: string;
}

const THINKING_THROTTLE_MAP_KEY = "__flowshipThinkingDeltaThrottle__";
const getThinkingThrottleMap = (): Map<string, ThinkingThrottle> => {
  const g = globalThis as unknown as Record<
    typeof THINKING_THROTTLE_MAP_KEY,
    Map<string, ThinkingThrottle> | undefined
  >;
  if (!g[THINKING_THROTTLE_MAP_KEY]) g[THINKING_THROTTLE_MAP_KEY] = new Map();
  return g[THINKING_THROTTLE_MAP_KEY];
};

/** 把攒着的增量发成一帧；lease 失主则整条丢弃并清掉本任务的节流状态 */
const sendThinkingDelta = (taskId: string, st: ThinkingThrottle): void => {
  st.timer = null;
  const text = st.pending;
  st.pending = "";
  if (!text) return;
  if (!st.lease()) {
    getThinkingThrottleMap().delete(taskId);
    return;
  }
  st.lastSentAt = Date.now();
  publishIfCurrent(taskId, st.lease, {
    kind: "thinking_delta",
    text,
    eventId: st.eventId,
  });
};

/** 一段思考结束：清定时器、丢掉没发的尾巴、重置节流（下一段首个 chunk 重新「立即发」）。同步、幂等 */
export const discardPendingThinkingDeltas = (taskId: string): void => {
  const map = getThinkingThrottleMap();
  const st = map.get(taskId);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  map.delete(taskId);
};

const enqueueThinkingDelta = (
  taskId: string,
  lease: () => boolean,
  text: string,
  eventId: string,
): void => {
  const map = getThinkingThrottleMap();
  const st: ThinkingThrottle = map.get(taskId) ?? {
    pending: "",
    timer: null,
    lastSentAt: 0,
    lease,
    eventId,
  };
  map.set(taskId, st);
  st.lease = lease;
  st.eventId = eventId;
  st.pending += text;
  // 已经排好一帧：到点把攒的一起发
  if (st.timer) return;
  const wait = st.lastSentAt + THINKING_DELTA_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    sendThinkingDelta(taskId, st);
    return;
  }
  st.timer = setTimeout(() => sendThinkingDelta(taskId, st), wait);
};

/**
 * lease 改必传——task consume 传 opHandle 闭包（`() => isTaskOpCurrent(h)`）、
 * chat consume 传 instanceId 闭包（本 run 仍是 runningChats 当前实例才写）。
 * 旧签名「chat 缺省 opHandle = 永远 current」的 fail-open 语义删除。
 */
export const handleSdkMessage = async (
  taskId: string,
  msg: SDKMessage,
  assistantCtx: AssistantBufferCtx,
  /**
   * 失主则整条消息丢弃（含 thinking /
   * assistant / tool / error / tool_result + publish）。
   */
  lease: () => boolean,
  /**
   * 这一路 run 的身份 token（属主主链不传）。本翻译器被属主 run 与旁路只读答疑 run
   * 共用——publish 出去的 envelope 带上它，群回流才分得清「这段回答是谁的」
   * （见 task-stream 的 TaskStreamEvent.origin）。只影响 envelope、不落盘。
   */
  origin?: string,
): Promise<void> => {
  // 入口一次不够——每个 await 之后、写事件之前复用同一闭包复查
  const stillCurrent = lease;
  if (!stillCurrent()) return;
  // 非 assistant 消息可能触发任何事件写入——先冲已缓冲的 delta 保住时序
  //（assistant 分支不冲：连续文本 chunk 要合并进同一帧）
  if (msg.type !== "assistant") flushPendingAssistantDeltas(taskId);
  // 思考实时帧同理：任何非 thinking 消息到来 = 这段思考结束了，没发的尾巴不再发
  //（thinking 自己的分支不能丢——连续 chunk 要在节流窗口里合帧）
  if (msg.type !== "thinking") discardPendingThinkingDeltas(taskId);

  /** 本轮统一 sink：lease + origin 一次绑好，下面各分支只管事件内容 */
  const writeEv = (
    ev: Parameters<typeof writeOwnedEventAndPublish>[2],
  ): Promise<unknown> =>
    writeOwnedEventAndPublish(taskId, stillCurrent, ev, origin);

  // 自定义 pi 压缩：合成 type，不在 SDKMessage 联合里。只冲 delta 帧（入口已做），
  // 不 flush assistant_message——压缩代表这轮还没结束，光标继续挂着。
  const rawType = (msg as { type?: string }).type;
  if (rawType === "compaction_start" || rawType === "compaction_end") {
    const start = rawType === "compaction_start";
    const compactionMsg = msg as unknown as {
      aborted?: boolean;
      reason?: unknown;
      willRetry?: boolean;
    };
    const aborted = Boolean(compactionMsg.aborted);
    const willRetry = Boolean(compactionMsg.willRetry);
    // 摘要还在重试：保持「正在压缩」那一行，不要连落两条「已压缩」
    if (!start && willRetry && !aborted) return;
    const reason =
      typeof compactionMsg.reason === "string" ? compactionMsg.reason : undefined;
    if (!stillCurrent()) return;
    await writeEv({
      kind: "info",
      text: compactionEventText({ start, aborted }),
      meta: compactionEventMeta({ start, aborted, reason }),
    });
    return;
  }

  switch (msg.type) {
    case "usage": {
      // turn-ended：回复已经完整。首条时把它落盘，让 UI 立刻从流式气泡转成正式消息，
      // 不必等 SDK 把 checkpoint 存完发 FINISHED（正常 ~0.3s；异常时可能几十秒~几分钟）
      assistantCtx.turnEndedCount = (assistantCtx.turnEndedCount ?? 0) + 1;
      if (assistantCtx.turnEndedCount === 1) {
        assistantCtx.turnEndedAt = Date.now();
        if (assistantCtx.dropAfterTurnEnded) {
          await flushThinkingBuffer(taskId, assistantCtx, stillCurrent, origin);
          await assistantCtx.flush();
          assistantCtx.onTurnEnded?.();
        }
      }
      break;
    }

    case "thinking": {
      if (isAfterTurnEnd(assistantCtx)) {
        noteReplayDropped(taskId, assistantCtx, "thinking");
        break;
      }
      await assistantCtx.flush();
      if (!stillCurrent()) return;
      const chunk = typeof msg.text === "string" ? msg.text : "";
      if (!chunk) break;
      assistantCtx.thinkingBuffer = (assistantCtx.thinkingBuffer ?? "") + chunk;
      if (msg.thinking_duration_ms) {
        assistantCtx.thinkingDurationMs =
          (assistantCtx.thinkingDurationMs ?? 0) + msg.thinking_duration_ms;
      }
      // 实时帧：思考进行中就让 UI 知道「在思考」（落盘仍要等整段结束）。
      // 旁路答疑（origin）不发——前端不区分帧属于哪一路 run，会串到主链的状态行；
      // 已提问消音（askSeen）也不发，与落盘的 muted thinking 同口径
      if (!origin && !assistantCtx.askSeen) {
        // 本段思考落盘后的事件 id：段内第一个 chunk 时定下，之后每帧都带同一个，落盘时复用
        // （flushThinkingBuffer）。前端靠它把「进行中的思考行」和落盘行对成同一个节点
        assistantCtx.thinkingEventId ??= newEventId();
        enqueueThinkingDelta(
          taskId,
          stillCurrent,
          chunk,
          assistantCtx.thinkingEventId,
        );
      }
      break;
    }

    case "tool_call": {
      // 重放里带工具调用：不丢（用户得看到真有动作在发生），只计数 + 告警
      if (isAfterTurnEnd(assistantCtx) && msg.status === "running") {
        noteReplayDropped(taskId, assistantCtx, "toolCalls");
      }
      await flushThinkingBuffer(taskId, assistantCtx, stillCurrent, origin);
      await assistantCtx.flush();
      if (!stillCurrent()) return;
      const argsAny = (msg.args ?? {}) as Record<string, unknown>;
      const innerToolName =
        typeof argsAny.toolName === "string" ? argsAny.toolName : "";
      // 已提问、还在等 curl 吐答案：调查类工具和那条 ask-wait curl 都只消音不广播，
      // 不 run.cancel()。curl 对用户是协议内部步骤，事件流只留答题卡。
      // 答案进 stdout 之后清 askSeen，同一轮可以再问 / 交卷。
      if (assistantCtx.askSeen) {
        if (msg.status === "running") {
          if (!tryMarkToolCallRunningSeen(msg.call_id)) break;
          const { argsStr, truncateMax } = stringifyToolCallArgs(
            msg.name,
            msg.args,
          );
          if (!stillCurrent()) return;
          await appendEvent(taskId, {
            kind: "tool_call",
            text: `调用 ${msg.name}${
              argsStr ? `:${truncate(argsStr, 120)}` : ""
            }`,
            meta: {
              callId: msg.call_id,
              name: msg.name,
              innerToolName: innerToolName || undefined,
              args: argsStr ? truncate(argsStr, truncateMax) : undefined,
              muted: true,
            },
          }, stillCurrent);
        } else if (msg.status === "error") {
          await emitToolResult(taskId, msg, stillCurrent, origin, true);
        } else if (msg.status === "completed") {
          await emitToolResult(taskId, msg, stillCurrent, origin, true);
          maybeClearAskSeenAfterWaitReply(assistantCtx, msg);
        }
        break;
      }
      // 必须连 MCP wrapper 一起认——漏认会把 submit_work 写成普通 tool_call、
      // 被兜底 A 误当「答后又干活」拦下（2026-06-16 线上事故根因）
      const isSubmitWork =
        SUBMIT_TOOL_NAMES.has(msg.name) || SUBMIT_TOOL_NAMES.has(innerToolName);

      // V0.6：write / edit 写 actions/N-<type>.md 时推一份「在写 artifact」事件给 UI
      // ⚠️ 必须先用 WRITE_TOOL_NAMES 卡是不是「写」工具——read 跟 edit 都用 path 参数
      const possibleTarget = WRITE_TOOL_NAMES.has(msg.name)
        ? ((argsAny.target_file as string | undefined) ??
          (argsAny.file_path as string | undefined) ??
          (argsAny.path as string | undefined))
        : undefined;
      // Windows agent 写路径常用反斜杠；匹配前先归一成 `/`
      const normalizedTarget = possibleTarget
        ? possibleTarget.replace(/\\/g, "/")
        : undefined;
      if (
        normalizedTarget &&
        (normalizedTarget.includes("/actions/") ||
          normalizedTarget.startsWith("actions/"))
      ) {
        // 事实信号：本轮写/改过 artifact——交卷时据此判「产出是否真的更新」（横幅/收尾语义）
        assistantCtx.artifactWritten = true;
        if (msg.status === "running") {
          // 同 callId 的二次 running（SDK 流式补 args）跳过，避免双工具块
          if (!tryMarkToolCallRunningSeen(msg.call_id)) break;
          const argsStr = stringifyMeta(msg.args);
          if (!stillCurrent()) return;
          await writeEv({
            kind: "tool_call",
            text: `agent 在写 artifact: ${possibleTarget}`,
            meta: {
              callId: msg.call_id,
              name: msg.name,
              args: argsStr ? truncate(argsStr) : undefined,
            },
          });
          break;
        }
        if (msg.status === "error") {
          await emitToolResult(taskId, msg, stillCurrent, origin);
          break;
        }
        // 写成功：先落 tool_result（给前端看 diff/摘要），再刷 artifact 面板
        await emitToolResult(taskId, msg, stillCurrent, origin);
        {
          const m = normalizedTarget.match(/actions\/(\d+)-[a-z]+\.md$/);
          if (m) {
            const n = Number(m[1]);
            const fresh = await getTask(taskId);
            if (!stillCurrent()) return;
            const target = fresh?.actions.find((a) => a.n === n);
            if (target) {
              // 旧 stream 的 artifact 元数据写必须绑 operation；失主拒写
              const patched = await patchActionIfOwner(
                taskId,
                target.id,
                { artifactUpdatedAt: Date.now() },
                () => stillCurrent(),
              );
              const a = patched?.actions.find((x) => x.id === target.id);
              if (a) publish(taskId, { kind: "action", action: a });
            }
          }
        }
        break;
      }

      if (isSubmitWork) {
        // status 维护：notifier 自己处理 awaiting；这里只记 error
        if (msg.status === "error") {
          const resStr = stringifyMeta(msg.result);
          if (!stillCurrent()) return;
          await writeEv({
            kind: "error",
            text: `submit_work 工具调用失败：${truncate(resStr, 200)}`,
          });
        } else if (msg.status === "completed") {
          // 交卷成功才进「已交卷」状态：之后模型输出（答案）照常广播、不消音——
          // 固定收尾「已完成」横幅延到 run 自然结束再补发（见 task-runner / chat-runner 兜底）、
          // 保证答案在横幅之前。
          // 失败文案（未受理 / stale / busy / 无桥 / mismatch）不消音——模型还要解释怎么处理。
          const resStr =
            typeof msg.result === "string"
              ? msg.result
              : stringifyMeta(msg.result ?? {});
          const rejected =
            resStr.length > 0 &&
            /交卷未受理|已被后续操作取代|没有活跃会话桥|CALLER_MISMATCH/.test(resStr);
          if (!rejected) {
            assistantCtx.submitSeen = true;
          }
        }
        break;
      }

      if (msg.status === "running") {
        // 同 callId 的二次 running（SDK 流式补 args）跳过，避免双工具块
        if (!tryMarkToolCallRunningSeen(msg.call_id)) break;
        const { argsStr, truncateMax } = stringifyToolCallArgs(
          msg.name,
          msg.args,
        );
        if (!stillCurrent()) return;
        await writeEv({
          kind: "tool_call",
          text: `调用 ${msg.name}${argsStr ? `:${truncate(argsStr, 120)}` : ""}`,
          // callId 供前端与 tool_result / tool_output_delta 配对；
          // innerToolName 给兜底 A 精确识别 MCP 工具（勿解析 truncate 后的 text）
          meta: {
            callId: msg.call_id,
            name: msg.name,
            innerToolName: innerToolName || undefined,
            args: argsStr ? truncate(argsStr, truncateMax) : undefined,
          },
        });
      } else if (msg.status === "error") {
        await emitToolResult(taskId, msg, stillCurrent, origin);
      } else if (msg.status === "completed") {
        // Phase 1：completed 结果落盘（此前完全忽略 → shell/read 输出用户看不见）
        await emitToolResult(taskId, msg, stillCurrent, origin);
        maybeClearAskSeenAfterWaitReply(assistantCtx, msg);
      }

      // ask_user 成功（[ASK_SUBMITTED]）：进入「已提问」状态——之后全部消音（答题卡即收尾）。
      // 放在 tool_result 落盘之后（同一条消息先走正常落盘、再置消音状态）；
      // 失败文案（未受理 / stale / busy / 无桥 / mismatch）不消音——模型还要解释怎么处理。
      const isAskUser =
        innerToolName === "ask_user" ||
        msg.name === "ask_user" ||
        msg.name === "Ask User";
      if (isAskUser && msg.status === "completed" && !assistantCtx.askSeen) {
        const resStr =
          typeof msg.result === "string"
            ? msg.result
            : stringifyMeta(msg.result ?? {});
        const rejected =
          resStr.length > 0 &&
          /未受理|已被后续操作取代|没有活跃会话桥|CALLER_MISMATCH/.test(resStr);
        if (!rejected && resStr.includes("[ASK_SUBMITTED]")) {
          assistantCtx.askSeen = true;
        }
      }
      break;
    }

    case "assistant": {
      // 回合结束后又来的正文 = SDK 重放，丢（不累 buffer、不推打字机帧、不落盘）
      if (isAfterTurnEnd(assistantCtx)) {
        let dropped = 0;
        const replayBlocks = msg.message?.content;
        if (Array.isArray(replayBlocks)) {
          for (const block of replayBlocks) {
            if (block.type === "text" && block.text) dropped += block.text.length;
          }
        }
        noteReplayDropped(taskId, assistantCtx, "assistant", dropped);
        break;
      }
      await flushThinkingBuffer(taskId, assistantCtx, stillCurrent, origin);
      if (!stillCurrent()) return;
      // 畸形 SDK 消息可能缺 message / content 非数组 → 直接跳过，避免 TypeError 打崩整轮 run
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) break;
      let text = "";
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
      if (text.length > 0) {
        if (!stillCurrent()) return;
        // 提问成功后的模型输出（askSeen）：答案以新消息 [ASK_USER_REPLY] 来 → 之后正文静音；
        // 交卷（submitSeen）后的正文照常广播——答案给用户看、不再静音。
        if (assistantCtx.askSeen) {
          // 消音审计：只落盘、不广播（见 emitToolResult muted 注释）
          // 落盘前先冲缓冲——muted 消息虽不走 SSE，也不让旧 delta 晚到串味
          flushPendingAssistantDeltas(taskId);
          await appendEvent(taskId, {
            kind: "assistant_message",
            text,
            meta: { muted: true },
          }, stillCurrent);
          break;
        }
        assistantCtx.buffer += text;
        // streaming delta 走合帧缓冲——攒够 70ms/240B 再广播（失主在 flush 时丢弃）
        enqueueAssistantDelta(taskId, stillCurrent, origin, text);
      }
      break;
    }

    case "status": {
      console.log(
        `[sdk-message-handler] SDK status message: status=${msg.status} message=${msg.message ?? "(none)"}`,
      );
      if (
        (msg.status === "ERROR" || msg.status === "EXPIRED") &&
        msg.message
      ) {
        if (!stillCurrent()) return;
        assistantCtx.sdkErrorMessage = msg.message;
        await writeEv({
          kind: "error",
          text: `SDK ${msg.status}：${msg.message}`,
          meta: {
            sdkStatus: msg.status,
            sdkMessage: msg.message,
          },
        });
      }
      break;
    }

    case "system":
    case "user":
    case "request":
    case "task":
    default:
      break;
  }
};
