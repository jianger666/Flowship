/**
 * shell 输出流式桥接（Phase 1）
 *
 * SDK InteractionUpdate 的 `shell-output-delta` 在 run-perf 里被忽略；
 * stream 的 tool_call 消息只有 running/completed、无中间 stdout——必须走 onDelta。
 *
 * 注意：SDK 公开类型里 shell-output-delta **不带 callId**（只有 event.case/value），
 * 用最近一次 tool-call-started 的 shell callId 归因（同进程串行 shell 可靠；
 * 并行 shell 可能错配——记入交付说明）。
 *
 * 节流：≥500ms 或累计 ≥2KB 才 publish 一次；**只 SSE、不落 events.jsonl**。
 * 没到阈值的尾巴由 trailing flush 定时器（armTrailing）补发：之后即使一直没有新输出（编译卡在某一步），
 * 最迟 500ms 也会发出去，不会一直停在缓冲里。
 *
 * 另：已发出的输出按 callId 在内存里留一份尾部窗口（对外 ≤20 行 / ≤8KB，见下面「进行中 shell 输出的实时快照」），
 * watch-task 新订阅者 bootstrap 时据此补一帧 `tool_output_snapshot`——切走再切回 / SSE 重连后工具块的实时输出不再是空的。
 */

import type { InteractionUpdate } from "@cursor/sdk";

import {
  compactionEventMeta,
  compactionEventText,
} from "@/lib/compaction-display";
import {
  LIVE_OUTPUT_MAX_CHARS,
  sliceLiveOutputTail,
  trimLiveOutput,
} from "@/lib/live-output-cap";

import { redactSecretsInText } from "./event-secret-redact";
import {
  publish,
  subscribeAllTaskStreams,
  writeOwnedEventAndPublish,
} from "./task-stream";

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BYTES = 2 * 1024;

// ephemeral 帧 id 的进程内单调计数。
// 只靠 `Date.now()` 不够唯一：同一 callId 在同一毫秒内 flush 两次（≥2KB 的大块连着来 /
// 刚 flush 完紧接着 tool-call-completed 的收尾 flush）会得到同一个 id，
// 而 watch-task 路由按 event id 去重（sentEventIds），后一块会被当「已发过」整块丢掉——
// 实时输出缺一截，且帧只走 SSE、不落盘、事后补不回来（V8-02）。
// 计数不重置、跨发布器共享：不同任务 / 不同 run 撞上同 callId 同毫秒也不会重复。
let ephemeralFrameSeq = 0;

// ----------------- 进行中 shell 输出的实时快照（tool_output_snapshot） -----------------
// 为什么要有它：`tool_output_delta` 是纯内存 ephemeral 帧、从不回放，前端的直播缓冲又只活在 ChatView 的本地 state 里。
// agent 正在跑长 shell（编译 / 测试）时用户切到别的窗口再切回（ChatView 卸载重挂、挂载时清空直播缓冲）、
// 或 SSE 断流重连，新订阅者只能从「订阅之后的第一帧」开始——工具块实时输出是空的，之后也只有「切回那一刻起的增量」。
// 与 assistant_snapshot / thinking_snapshot 同套路：服务端按 task 记住「已发出的尾部」，新订阅者 bootstrap 时补一帧快照，
// 前端按**替换**语义铺上（不能复用追加型 delta，否则会和重连后的增量重复）。
//
// 记账口径：只记 publish 成功**之后**同步记进来的（publishChunk 里紧跟 publish、中间无 await）——
// 快照 = 订阅者「本该已经收到」的全部；还在 500ms / 2KB 合帧缓冲里没发的字不算，它发出时作为增量排在快照后面。
// 对外窗口口径与前端直播缓冲同一套（lib/live-output-cap：≤20 行且 ≤8192 字符，`\r` 也算换行）；
// 但内存里存的是**比窗口更长的原文**（见 LIVE_SHELL_RAW_MAX_CHARS），读快照时「先脱敏、再按窗口截断」——
// 先截断再脱敏的话，被窗口边界切成两半的凭据，留下的那一半谁也认不出来、会原样漏给新订阅者（R1-4）。
// 清理（任一即清）：
//   - 对应 callId 的 tool-call-completed（收尾 flush 之后）；
//   - 对应 callId 的 tool_result 落地（sdk-message-handler.emitToolResult；SDK 出错时可能只有 tool_call 终态消息、没有 completed 更新）；
//   - 整任务：任务流上的 `done`（属主主链一轮 run 收尾，含出错 / 中断）与 `task_deleted`（见 ensureTaskEndTap）——
//     run 收尾点分散在 task-runner / chat-runner 的十几处、任务删除在 task-fs，这里挂一个全局 tap 统一接，不必逐处接线；
//   - lease 失主（run 被取消 / 被取代；读取、记账、新建发布器时顺手扫）；
//   - 容量封顶。
// 路由读快照时还会剔掉「tool_result 已落盘在 tail 里」的 callId（见 watch-task 路由）——最终输出在那条事件的 meta 里。
//
// 状态挂 globalThis：Next 的 route 与 runner 可能是不同的模块实例（同 assistant / thinking 快照的做法）。

/** 每个 task 最多保留几个 callId 的尾部（并行 shell 很少见；超了淘汰最久没更新的） */
export const LIVE_SHELL_MAX_CALLS_PER_TASK = 8;
/** 全进程合计上限（大量任务各挂着 shell 又异常没收尾时，内存也有硬顶：64 × 16KB ≈ 1MB） */
export const LIVE_SHELL_MAX_CALLS_TOTAL = 64;
/**
 * 每个 callId 内存里保留的**原文**字符上限（= 对外窗口的 2 倍）：给脱敏留足上下文——
 * 凭据只要整段落在这段原文里就能被认出来，而对外窗口是脱敏**之后**才截的。硬上限：每条 ≤16KB，总量见上。
 */
export const LIVE_SHELL_RAW_MAX_CHARS = LIVE_OUTPUT_MAX_CHARS * 2;
/** 原文窗口起点切在半截词上时，往后找空白的最大步数（凭据里不含空白，跳过这段就不会留下半截凭据） */
const RAW_HEAD_SKIP_SCAN = 256;

interface LiveShellEntry {
  taskId: string;
  callId: string;
  /** 已发出输出的原文尾部窗口（≤ LIVE_SHELL_RAW_MAX_CHARS、未脱敏、未按行截——读快照时先脱敏再截成对外窗口） */
  text: string;
  /** 记账时的 lease 闭包——读取 / 记账时重估，失主 = 这个 shell 所在的 run 已经死了 */
  lease: (() => boolean) | undefined;
}

/**
 * 原文封顶：只留尾部 LIVE_SHELL_RAW_MAX_CHARS 个字符；起点若是被切开的（有截断发生），
 * 就往后跳到第一个空白之后——起点那一截可能是半截凭据，留着它、而后面的脱敏又把凭据缩成短占位符时，
 * 这半截会重新进到对外窗口里。凭据里没有空白，所以跳到空白处必定把半截丢干净；
 * 前 256 个字符里都没有空白（无换行的压缩文件 / 进度条）就不跳，那种情形下起点离对外窗口很远。
 */
const capLiveShellRaw = (text: string): string => {
  const tail = sliceLiveOutputTail(text, LIVE_SHELL_RAW_MAX_CHARS);
  if (tail === text) return text;
  const gap = tail.slice(0, RAW_HEAD_SKIP_SCAN).search(/\s/);
  return gap >= 0 ? tail.slice(gap + 1) : tail;
};

/** 快照里的一条（线上字段与前端直播缓冲同口径：callId + 尾部文本） */
export interface LiveShellOutputSnapshotItem {
  callId: string;
  text: string;
}

const LIVE_SHELL_MAP_KEY = "__flowshipLiveShellOutputs__";
/** key = taskId + callId；Map 迭代序 = 插入序，更新时「先删再放」，所以队首永远是最久没更新的（LRU 淘汰） */
const getLiveShellMap = (): Map<string, LiveShellEntry> => {
  const g = globalThis as unknown as Record<
    typeof LIVE_SHELL_MAP_KEY,
    Map<string, LiveShellEntry> | undefined
  >;
  if (!g[LIVE_SHELL_MAP_KEY]) g[LIVE_SHELL_MAP_KEY] = new Map();
  return g[LIVE_SHELL_MAP_KEY];
};

const liveShellKey = (taskId: string, callId: string): string =>
  `${taskId}\u0000${callId}`;

/** lease 失主 = 死条目；lease 自己抛错也按死处理（宁可少给一份快照，别留幽灵输出） */
const isLiveShellEntryDead = (e: LiveShellEntry): boolean => {
  if (!e.lease) return false;
  try {
    return !e.lease();
  } catch {
    return true;
  }
};

/** 清掉某 task 里已失主的残留（run 结束没走到 tool-call-completed 的异常路径）。同步、幂等 */
const sweepDeadLiveShellOutputs = (taskId: string): void => {
  const map = getLiveShellMap();
  for (const [key, e] of map) {
    if (e.taskId === taskId && isLiveShellEntryDead(e)) map.delete(key);
  }
};

/** 封顶：同 task 超限淘汰该 task 最久没更新的；全进程合计超限淘汰全局最久没更新的 */
const enforceLiveShellCaps = (
  map: Map<string, LiveShellEntry>,
  taskId: string,
): void => {
  let own = 0;
  for (const e of map.values()) if (e.taskId === taskId) own += 1;
  if (own > LIVE_SHELL_MAX_CALLS_PER_TASK) {
    for (const [key, e] of map) {
      if (e.taskId !== taskId) continue;
      map.delete(key);
      own -= 1;
      if (own <= LIVE_SHELL_MAX_CALLS_PER_TASK) break;
    }
  }
  while (map.size > LIVE_SHELL_MAX_CALLS_TOTAL) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
};

/** 一个 chunk 发出去之后记账（同步；lease 随最近一次记账更新） */
const recordLiveShellOutput = (
  taskId: string,
  callId: string,
  chunk: string,
  lease: (() => boolean) | undefined,
): void => {
  if (chunk.length === 0) return;
  const map = getLiveShellMap();
  const key = liveShellKey(taskId, callId);
  const prev = map.get(key);
  // 先删再放：把它挪到队尾（最近更新）
  map.delete(key);
  map.set(key, {
    taskId,
    callId,
    // 只按字符封顶、不按行截：行窗口留到读快照脱敏之后再切（见 LIVE_SHELL_RAW_MAX_CHARS）
    text: capLiveShellRaw(`${prev?.text ?? ""}${chunk}`),
    lease,
  });
  sweepDeadLiveShellOutputs(taskId);
  enforceLiveShellCaps(map, taskId);
};

// ----------------- trailing flush 的登记表 -----------------
// 缓冲里没发出去的尾巴由 trailing 定时器补发（见发布器里的 armTrailing）。登记表让「丢弃」能同时取消它们：
// 否则整任务丢弃 / tool_result 落地之后，迟到的 trailing flush 会把已经丢掉的输出又记回快照（幽灵）。
// 只登记「有定时器在等」的缓冲：最多存活 FLUSH_INTERVAL_MS，条目数天然有界。同样挂 globalThis（理由同上）。
interface PendingTrailingFlush {
  taskId: string;
  /** 清掉定时器与缓冲里没发的字，并把自己从登记表摘掉。幂等 */
  cancel: () => void;
}
const LIVE_SHELL_PENDING_KEY = "__flowshipLiveShellPendingFlush__";
const getPendingTrailingFlushes = (): Map<string, PendingTrailingFlush> => {
  const g = globalThis as unknown as Record<
    typeof LIVE_SHELL_PENDING_KEY,
    Map<string, PendingTrailingFlush> | undefined
  >;
  if (!g[LIVE_SHELL_PENDING_KEY]) g[LIVE_SHELL_PENDING_KEY] = new Map();
  return g[LIVE_SHELL_PENDING_KEY];
};

/**
 * 某个 shell 结束了（tool-call-completed / tool_result 已落地）：清该 callId 的快照、并取消它还在等 trailing flush 的未发输出。
 * 同步、幂等。**callId 必填**：以前「不传 callId = 清该 task 全部」，一个 `undefined` 变量（如 SDK 消息缺 call_id）
 * 就会静默清掉任务里别的并行 shell 的快照——整任务清理请显式调 {@link discardAllLiveShellOutputOfTask}。
 * 空串 / 非字符串 callId 视为无效、什么都不清（宁可漏清让 lease / `done` tap 兜底，也不误清别人的）。
 */
export const discardLiveShellOutput = (taskId: string, callId: string): void => {
  if (typeof callId !== "string" || callId === "") return;
  const key = liveShellKey(taskId, callId);
  getLiveShellMap().delete(key);
  getPendingTrailingFlushes().get(key)?.cancel();
};

/** 整个 task 不再有进行中的 shell（`done` / `task_deleted`）：清该 task 全部快照，并取消所有等待中的 trailing flush。同步、幂等。 */
export const discardAllLiveShellOutputOfTask = (taskId: string): void => {
  const map = getLiveShellMap();
  const pending = getPendingTrailingFlushes();
  for (const [key, e] of map) {
    if (e.taskId === taskId) map.delete(key);
  }
  // cancel 会改 pending（遍历中删除 Map 条目是安全的，但这里先拷一份更直白）
  for (const p of [...pending.values()]) {
    if (p.taskId === taskId) p.cancel();
  }
};

const TASK_END_TAP_KEY = "__flowshipLiveShellTaskEndTap__";

/**
 * 进程内只挂一份任务流全局 tap：属主主链的 `done`（一轮 run 收尾——含出错 / 中断）与 `task_deleted` → 整任务丢弃。
 * 为什么需要：正常收尾有 tool-call-completed / tool_result 逐个 callId 清；但 SDK 出错 / run 被打断时这两个都可能缺席，
 * 而 lease 对「旁路 / 单次 observer」类 run（snapshotTaskOp）在 run 结束后仍判存活——那条快照会一直挂到下次 claim。
 * 前端本来就在 `done` 时清直播缓冲（chat-view / task 页的 onDone），服务端的快照与它同口径。
 * - 旁路群答疑 run 的 done 带 origin：它不是属主主链的收尾，不清（它的 shell 快照与主链共用 task 维度，一刀切会误伤主链在跑的 shell）；
 * - `done` 时还在等 trailing flush 的未发输出一并取消（见登记表），不会在 `done` 之后又被迟到的 flush 记回快照。
 * 在第一个发布器创建时才挂（此时任务流模块一定已初始化完），idempotent；订阅失败不能拖垮 shell 流式（吞掉、只记一次）。
 * 挂 globalThis：Next dev 多 chunk / HMR 下模块级变量不共享，重复挂会叠出多份。
 */
const ensureTaskEndTap = (): void => {
  const g = globalThis as unknown as Record<string, (() => void) | undefined>;
  if (g[TASK_END_TAP_KEY]) return;
  g[TASK_END_TAP_KEY] = () => {};
  try {
    g[TASK_END_TAP_KEY] = subscribeAllTaskStreams((taskId, ev) => {
      if (ev.kind === "task_deleted" || (ev.kind === "done" && !ev.origin)) {
        discardAllLiveShellOutputOfTask(taskId);
      }
    });
  } catch (err) {
    console.warn("[shell-output-bridge] 挂任务结束 tap 失败（快照只靠 callId / lease 清理）", err);
  }
};

/**
 * 此刻进行中的 shell 输出快照（callId + 已发出的尾部窗口，按最近更新从旧到新）；没有 → 空数组。
 *
 * 同步、零副作用（失主时顺手清状态除外）——路由要「订阅」与「读快照」之间没有任何 await：
 * 快照 = 订阅那一刻之前已发出的全部，之后的帧都进 buffer，不重不漏（理由同 getLiveAssistantSnapshot）。
 * 读取时重估 lease：run 被取消 / 换了新实例 / 已结束而状态没被清（异常路径）时，
 * 不能把一个已经死掉的 shell 当作进行中告诉新订阅者（幽灵「实时输出」）。
 * 快照不经 publish、由 watch-task 直接 send——文本这里再脱敏一道（也补上凭据被切在相邻两帧的情形）。
 * **先脱敏、再按对外窗口（≤20 行 / ≤8KB）截断**：内存里存的是更长的原文，凭据整段在原文里就能被认出来换成占位符，
 * 之后窗口边界再怎么切，切到的也只是占位符、不会留下半截凭据（R1-4）。
 */
export const getLiveShellOutputSnapshot = (
  taskId: string,
): LiveShellOutputSnapshotItem[] => {
  const map = getLiveShellMap();
  const out: LiveShellOutputSnapshotItem[] = [];
  for (const [key, e] of map) {
    if (e.taskId !== taskId) continue;
    if (isLiveShellEntryDead(e)) {
      map.delete(key);
      continue;
    }
    const text = trimLiveOutput(redactSecretsInText(e.text));
    if (text.length === 0) continue;
    out.push({ callId: e.callId, text });
  }
  return out;
};

type Buf = {
  chunks: string[];
  bytes: number;
  lastFlushAt: number;
  /** trailing flush 定时器：缓冲里有没发的字、又没到合帧阈值时挂着（见 armTrailing）；没有 = 没在等 */
  timer?: ReturnType<typeof setTimeout>;
};

const extractShellChunk = (update: InteractionUpdate): string | null => {
  if (update.type !== "shell-output-delta") return null;
  const event = update.event as {
    case?: string;
    value?: { data?: unknown };
  };
  if (event.case !== "stdout" && event.case !== "stderr") return null;
  const data = event.value?.data;
  return typeof data === "string" && data.length > 0 ? data : null;
};

/**
 * 返回可塞进 SendOptions.onDelta 的 handler。
 * 与 createRunPerfTracker().onDelta 用 composeOnDelta 串联。
 *
 * @param lease 可选；每次 flush/publish 前同步 gate，失效则丢弃（旧 run 迟到 delta 不混入新 run）
 */
export const createShellOutputDeltaPublisher = (
  taskId: string,
  lease?: () => boolean,
): ((args: { update: InteractionUpdate }) => void) => {
  // 新的一路 run 起来了：同 task 上一路 run 没收尾（异常退出）留下的快照残留顺手清掉（只清 lease 已失主的，
  // 旁路答疑与属主主链可能同时在飞、各有各的 lease，不能一刀切）
  sweepDeadLiveShellOutputs(taskId);
  // 任务结束 tap（done / task_deleted → 整任务丢弃）：进程内第一次建发布器时挂上，之后幂等
  ensureTaskEndTap();
  // SDK shell-output-delta 无 callId → 记最近启动的 shell
  let activeShellCallId: string | null = null;
  const buffers = new Map<string, Buf>();

  /** 摘掉 trailing 定时器（任何一次 flush / 缓冲被替换 / 丢弃都要先摘）。幂等 */
  const disarmTrailing = (callId: string, buf: Buf | undefined): void => {
    if (!buf || buf.timer === undefined) return;
    clearTimeout(buf.timer);
    buf.timer = undefined;
    getPendingTrailingFlushes().delete(liveShellKey(taskId, callId));
  };

  /**
   * 缓冲里有没发的字、又还没到合帧阈值：挂一个 trailing flush，最迟在「距上次 flush 满 FLUSH_INTERVAL_MS」时补发。
   * 没有它的话，这点输出会一直停在缓冲里，直到下一块输出进来——命令卡在某一步长时间静默（编译 / 等锁 / 网络慢）时，
   * 实时帧与快照都缺这一截，用户切回来看到的还是「空的」（R1-3）。
   * - 同一缓冲同时只挂一个：期间继续来的小块合进同一帧，节流节奏不变；
   * - 出口都会清它：flush（含 due / completed / 失主）、缓冲被替换、discardLiveShellOutput（登记表）；到点触发后自己摘登记；
   * - unref：进程退出不被一个 ≤500ms 的定时器拖住；
   * - 回调里 flush 照常过 lease 闸（失主 → 清缓冲 + 清快照、不 publish），且绝不抛出（定时器回调里抛错会变成未捕获异常）。
   */
  const armTrailing = (callId: string, buf: Buf): void => {
    if (buf.timer !== undefined) return;
    const key = liveShellKey(taskId, callId);
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - buf.lastFlushAt));
    const timer = setTimeout(() => {
      buf.timer = undefined;
      getPendingTrailingFlushes().delete(key);
      try {
        flush(callId);
      } catch (err) {
        console.warn(`[shell-output-bridge] trailing flush 失败 task=${taskId}`, err);
      }
    }, wait);
    (timer as { unref?: () => void }).unref?.();
    buf.timer = timer;
    getPendingTrailingFlushes().set(key, {
      taskId,
      cancel: () => {
        disarmTrailing(callId, buf);
        buf.chunks = [];
        buf.bytes = 0;
      },
    });
  };

  const publishChunk = (callId: string, chunk: string): void => {
    // publish 紧前同步 gate——无 await 夹缝；失主丢弃
    if (lease && !lease()) return;
    // ephemeral：伪造 TaskEvent 形态走既有 event SSE 帧，但不 appendEvent
    publish(taskId, {
      kind: "event",
      event: {
        // 前缀 `ephemeral_tod_` 不能变（tool-display 靠它识别 ephemeral 帧）；末尾计数保证同毫秒也唯一
        id: `ephemeral_tod_${callId}_${Date.now()}_${++ephemeralFrameSeq}`,
        ts: Date.now(),
        kind: "tool_output_delta",
        text: "",
        meta: { callId, chunk },
      },
    });
    // 紧跟 publish 同步记账（中间不能有 await）：快照 = 订阅者「本该已经收到」的全部，
    // 新订阅者 bootstrap 时据此补 tool_output_snapshot（见上面「进行中 shell 输出的实时快照」）
    recordLiveShellOutput(taskId, callId, chunk, lease);
  };

  const flush = (callId: string): void => {
    // 任何一次 flush 都先摘掉 trailing 定时器（缓冲马上被清空 / 丢弃，定时器不能留着空转或事后误发）
    const buf = buffers.get(callId);
    disarmTrailing(callId, buf);
    // flush 入口再 gate 一次——缓冲期间失主则清缓冲不 publish（快照条目一并清：失主的输出不再告诉新订阅者）
    if (lease && !lease()) {
      buffers.delete(callId);
      discardLiveShellOutput(taskId, callId);
      return;
    }
    if (!buf || buf.chunks.length === 0) return;
    let chunk = buf.chunks.join("");
    buf.chunks = [];
    buf.bytes = 0;
    buf.lastFlushAt = Date.now();
    if (chunk.length === 0) return;
    // 只有真要截断时才多做一步：先脱敏、再截——publish 的脱敏是对截断后的帧做的，
    // 凭据正好被下面这刀切成两半时，留下的那半截它认不出来（与快照同一个问题，见 LIVE_SHELL_RAW_MAX_CHARS）。
    // 没超窗口的常规帧不多这一步（publish 自己会脱敏一次）
    if (chunk.length > LIVE_OUTPUT_MAX_CHARS) {
      chunk = redactSecretsInText(capLiveShellRaw(chunk));
    }
    // 客户端直播窗口只留尾部 LIVE_OUTPUT_MAX_CHARS（同一口径，见 lib/live-output-cap）：
    // SDK 一次吐几 MB 时，整块发出去既占 SSE 带宽、前端又要整块 JSON.parse，纯浪费（R7-02）
    publishChunk(callId, sliceLiveOutputTail(chunk, LIVE_OUTPUT_MAX_CHARS));
  };

  return (args: { update: InteractionUpdate }): void => {
    try {
      const update = args.update;

      if (update.type === "tool-call-started") {
        const tc = update.toolCall as { type?: string };
        if (tc?.type === "shell") {
          activeShellCallId = update.callId;
          // 同 callId 重新启动：旧缓冲先发掉（连同它的 trailing 定时器），别让定时器指向一个被替换掉的缓冲
          if (buffers.has(update.callId)) flush(update.callId);
          buffers.set(update.callId, {
            chunks: [],
            bytes: 0,
            lastFlushAt: Date.now(),
          });
        }
        return;
      }

      if (update.type === "tool-call-completed") {
        if (buffers.has(update.callId)) {
          flush(update.callId);
          buffers.delete(update.callId);
        }
        // 收尾 flush 之后清快照：这个 shell 结束了（最终输出走 tool_result 事件），新订阅者不再需要直播尾部
        discardLiveShellOutput(taskId, update.callId);
        if (activeShellCallId === update.callId) activeShellCallId = null;
        return;
      }

      const chunk = extractShellChunk(update);
      if (!chunk) return;

      // 公开类型无 callId；若未来 SDK 补上则优先用
      const maybeId =
        typeof (update as { callId?: unknown }).callId === "string"
          ? (update as { callId: string }).callId
          : activeShellCallId;
      if (!maybeId) return;

      let buf = buffers.get(maybeId);
      if (!buf) {
        buf = { chunks: [], bytes: 0, lastFlushAt: Date.now() };
        buffers.set(maybeId, buf);
      }
      buf.chunks.push(chunk);
      buf.bytes += chunk.length;
      const due =
        buf.bytes >= FLUSH_BYTES ||
        Date.now() - buf.lastFlushAt >= FLUSH_INTERVAL_MS;
      // 到阈值就发；没到就挂 trailing flush 兜底（之后若一直没有新输出，最迟 500ms 也会发出去）
      if (due) flush(maybeId);
      else armTrailing(maybeId, buf);
    } catch (err) {
      // 流式桥接绝不能拖垮主流程
      console.warn(`[shell-output-bridge] onDelta 失败 task=${taskId}`, err);
    }
  };
};

/**
 * Cursor SDK in-place summarization = 压缩上下文。
 * `summary-started` 立刻落「正在压缩上下文…」过程行（跟 pi compaction_start 同一套展示）；
 * `summary-completed` 再落完成行。start/end 串行写，避免火忘乱序。
 *
 * @param lease 绑 instanceId / opHandle——失主丢弃迟到 summary 事件
 * @param origin 旁路答疑 run 的身份 token（属主主链不传）：压缩 info 事件也要带上它，
 *   才会被打 `meta.groupRun` 一起折叠进「群答疑」那一行，不漏到主流里
 */
export const createSdkSummaryDeltaPublisher = (
  taskId: string,
  lease: () => boolean,
  origin?: string,
): ((args: { update: InteractionUpdate }) => void) => {
  // 暂存最近一次 summary 文本字数（summary update 通常先于 summary-completed）
  let lastSummaryChars: number | undefined;
  // 已经挂过「正在压缩」——summary 正文只补字数，不再落第二条 running
  let startedEmitted = false;
  // onDelta 是同步签名：写事件排队，保证 started 先于 completed
  let writeChain = Promise.resolve();

  const enqueueWrite = (event: {
    text: string;
    meta: Record<string, unknown>;
  }): void => {
    writeChain = writeChain
      .then(async () => {
        if (!lease()) return;
        await writeOwnedEventAndPublish(
          taskId,
          lease,
          {
            kind: "info",
            text: event.text,
            meta: event.meta,
          },
          origin,
        );
      })
      .catch((err) => {
        console.warn(`[sdk-summary] task=${taskId} 写事件失败:`, err);
      });
  };

  return (args: { update: InteractionUpdate }): void => {
    try {
      const { update } = args;
      const type = String(update.type);
      const looksLikeSummary =
        type === "summary-started" ||
        type === "summary" ||
        type === "summary-completed" ||
        (typeof type === "string" && /summar/i.test(type));

      if (looksLikeSummary && !lease()) {
        console.warn(`[sdk-summary] task=${taskId} type=${type} 已失主，丢弃`);
        return;
      }

      if (type === "summary-started" || type === "summarization-started") {
        lastSummaryChars = undefined;
        startedEmitted = true;
        enqueueWrite({
          text: compactionEventText({ start: true }),
          meta: compactionEventMeta({ start: true, reason: "sdk" }),
        });
        return;
      }

      if (type === "summary" || type === "summarization") {
        const text =
          typeof (update as { summary?: unknown }).summary === "string"
            ? (update as { summary: string }).summary
            : "";
        lastSummaryChars = text.length;
        // 有的 SDK 版本跳过 started，收到摘要正文才挂过程行
        if (!startedEmitted) {
          startedEmitted = true;
          enqueueWrite({
            text: compactionEventText({ start: true }),
            meta: compactionEventMeta({ start: true, reason: "sdk" }),
          });
        }
        return;
      }

      if (type !== "summary-completed" && type !== "summarization-completed") {
        return;
      }

      startedEmitted = false;

      const summaryChars = lastSummaryChars;
      lastSummaryChars = undefined;
      enqueueWrite({
        text: compactionEventText({ start: false }),
        meta: {
          ...compactionEventMeta({ start: false, reason: "sdk" }),
          ...(summaryChars != null ? { summaryChars } : {}),
        },
      });
    } catch (err) {
      console.warn(`[sdk-summary] onDelta 失败 task=${taskId}`, err);
    }
  };
};

/** 串联多个 onDelta（perf + shell 流式 + sdk summary 等） */
export const composeOnDelta = (
  ...handlers: Array<(args: { update: InteractionUpdate }) => void>
): ((args: { update: InteractionUpdate }) => void) => {
  return (args) => {
    for (const h of handlers) h(args);
  };
};
