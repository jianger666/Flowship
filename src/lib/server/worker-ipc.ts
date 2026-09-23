/**
 * Worker IPC 协议（v3.1 §2：Node 原生 IPC + JSON + 有界队列背压）。
 *
 * - 命令下行：create / resume / send / cancel（主进程 → worker）；
 * - 事件上行：带 (agentId, runId, epoch, localSeq) 去重键（worker → 主进程）；
 * - 背压：worker 侧有界队列，满了 pause + 记 drop 计数，主进程重连后按 localSeq 补拉；
 * - 本文件只放协议类型 + 纯的队列/去重逻辑，不依赖 SDK，可单测。
 */

import { buildEventDedupKeyWithEpoch } from "./mem-governance";

export type WorkerCommand =
  | { type: "create"; agentId: string; taskId: string; workspace: string }
  | { type: "resume"; agentId: string; runId: string; epoch: number }
  | { type: "send"; agentId: string; runId: string; message: string }
  | { type: "cancel"; agentId: string; runId: string; reason: string };

// ---------- compute-plane 翻转（选项 A）：SDK 寄宿 + tool-call RPC ----------

/** customTools 清单（纯数据，可过 IPC；worker 侧按此重建 record，execute 一律 RPC 回主进程）。 */
export interface WorkerToolManifest {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 主→worker：SDK 输入（customTools 函数已剥离，清单单发）。 */
export interface WorkerCreateParams {
  sdkInput: Record<string, unknown>;
  manifest: WorkerToolManifest[];
  callerToken?: string;
  taskId?: string;
}

export type WorkerHostCommand =
  | { type: "worker:create"; reqId: string; params: WorkerCreateParams }
  | { type: "worker:resume"; reqId: string; agentId: string; params: WorkerCreateParams }
  | { type: "worker:send"; reqId: string; agentId: string; runId: string; message: unknown; opts?: unknown }
  | { type: "worker:cancel"; reqId: string; runId: string }
  | { type: "worker:tool-result"; reqId: string; result?: unknown; error?: string }
  | { type: "worker:close"; reqId: string; agentId: string };

export type WorkerHostEvent =
  | { type: "worker:created"; reqId: string; workspace: string; epoch: number; agentId: string }
  | { type: "worker:run-started"; reqId: string; workspace: string; epoch: number; runId: string; agentId: string }
  | { type: "worker:run-event"; workspace: string; epoch: number; runId: string; agentId: string; localSeq: number; event: unknown }
  | { type: "worker:run-delta"; workspace: string; epoch: number; runId: string; agentId: string; localSeq: number; update: unknown }
  | { type: "worker:run-step"; workspace: string; epoch: number; runId: string; agentId: string; localSeq: number; step: unknown }
  | { type: "worker:run-settled"; reqId: string; workspace: string; epoch: number; runId: string; agentId: string; localSeq: number; result?: unknown; error?: string }
  | { type: "worker:cancelled"; reqId: string; workspace: string; epoch: number; runId: string }
  | { type: "worker:closed"; reqId: string; workspace: string; epoch: number; agentId: string }
  | { type: "worker:tool-call"; toolCallReqId: string; workspace: string; epoch: number; agentId: string; callerToken?: string; taskId?: string; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "worker:nack"; reqId: string; workspace: string; epoch: number; error: string };

export interface WorkerEvent {
  agentId: string;
  runId: string;
  epoch: number;
  localSeq: number;
  kind: string;
  payload: unknown;
}

export const workerEventDedupKey = (e: Pick<WorkerEvent, "agentId" | "runId" | "epoch" | "localSeq">): string =>
  buildEventDedupKeyWithEpoch(e.agentId, e.runId, e.epoch, e.localSeq);

/** 有界队列：满了拒绝入队并计数（调用方据此 pause 事件流）。 */
export class BoundedEventQueue<T> {
  private buf: T[] = [];
  dropped = 0;
  readonly capacity: number;
  constructor(capacity = 1000) {
    this.capacity = capacity;
  }
  get size(): number {
    return this.buf.length;
  }
  push(item: T): boolean {
    if (this.buf.length >= this.capacity) {
      this.dropped += 1;
      return false;
    }
    this.buf.push(item);
    return true;
  }
  drain(): T[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }
}

/** 去重注册表：按去重键判重，有界（FIFO 淘汰，默认 5000）。 */
export class EventDedupRegistry {
  private seen = new Map<string, number>();
  readonly max: number;
  constructor(max = 5000) {
    this.max = max;
  }
  get size(): number {
    return this.seen.size;
  }
  /** 已见过返回 true（重复），否则记录并返回 false。 */
  check(e: Pick<WorkerEvent, "agentId" | "runId" | "epoch" | "localSeq">): boolean {
    const k = workerEventDedupKey(e);
    if (this.seen.has(k)) return true;
    this.seen.set(k, Date.now());
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return false;
  }
}
