/**
 * Worker 寄宿 facade（选项 A compute-plane 翻转：主进程侧）。
 *
 * - 与 @cursor/sdk Agent 同调用面：create/resume/send/stream/wait/cancel/close，
 *   事件带 (agentId, runId, epoch, localSeq) 去重；
 * - 身份语义保持 in-process：句柄对象存进现有 agentSessions/agentBox 映射，
 *   `===` 比较、instanceId 精确关闭、callerToken 桥接全部沿用现逻辑——
 *   线上只传字符串 + 命令，不存在跨进程对象同一性问题；
 * - 失败 fail-safe：握手/NACK/超时/进程退出一律抛错，调用方 catch 降级老路径；
 * - customTools 的 execute 在 worker 侧被 manifest 重建 + RPC 回主进程，
 *   真执行点唯一（worker-tools-rpc.dispatchWorkerToolCall，intent 同处落）。
 */

import { EventDedupRegistry } from "./worker-ipc";
import type {
  WorkerCreateParams,
  WorkerHostCommand,
  WorkerHostEvent,
  WorkerToolManifest,
} from "./worker-ipc";
import { dispatchWorkerToolCall } from "./worker-tools-rpc";

export interface WorkerRunHandle {
  id: string;
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<unknown>;
  cancel: () => Promise<void>;
}

export interface WorkerAgentHandle {
  agentId: string;
  send: (message: unknown, opts?: unknown) => Promise<WorkerRunHandle>;
  close: () => Promise<void>;
}

type ProcLike = {
  send(msg: unknown): boolean;
  on(event: string, fn: (msg: unknown) => void): unknown;
  removeListener(event: string, fn: (msg: unknown) => void): unknown;
};

let reqSeq = 0;
const nextReqId = (): string => `fq-${process.pid}-${(reqSeq += 1)}-${Date.now().toString(36)}`;

/** 连接：reqId 应答路由 + run 事件队列 + tool-call RPC 服务。 */
export class WorkerConnection {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private runQueues = new Map<string, { events: unknown[]; waiters: ((v: IteratorResult<unknown>) => void)[]; done: boolean; result?: unknown; error?: string }>();
  /** 必修①：函数回调本地持有（runId→回调），opts 过 IPC 只剩数据。 */
  private runCallbacks = new Map<string, { onDelta?: (args: { update: unknown }) => void | Promise<void>; onStep?: (args: { step: unknown }) => void | Promise<void> }>();
  readonly dedup = new EventDedupRegistry(5000);
  private toolHandler: (req: {
    toolCallReqId: string;
    agentId: string;
    callerToken?: string;
    taskId?: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<unknown>;
  private msgListener: ((msg: unknown) => void) | null = null;

  constructor(
    readonly proc: ProcLike,
    readonly workspace: string,
    readonly epoch: number,
    toolHandler?: (req: {
      toolCallReqId: string;
      agentId: string;
      callerToken?: string;
      taskId?: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }) => Promise<unknown>,
  ) {
    this.toolHandler = toolHandler ?? (async (req) => dispatchWorkerToolCall(req));
    this.msgListener = (msg: unknown) => this.route(msg);
    this.proc.on("message", this.msgListener);
  }

  destroy(): void {
    if (this.msgListener) {
      try {
        this.proc.removeListener("message", this.msgListener);
      } catch { /* ignore */ }
      this.msgListener = null;
    }
    this.runCallbacks.clear();
    for (const [, p] of this.pending) p.reject(new Error("[worker-facade] 连接已销毁"));
    this.pending.clear();
  }

  private route(raw: unknown): void {
    try {
      const m = raw as WorkerHostEvent & { reqId?: string; toolCallReqId?: string };
      if (!m || typeof m.type !== "string") return;
      if (m.type === "worker:run-started") {
        const p = m.reqId ? this.pending.get(m.reqId) : undefined;
        if (p) {
          this.pending.delete(m.reqId!);
          p.resolve({ runId: (m as { runId: string }).runId } as never);
        }
        return;
      }
      if (m.type === "worker:run-event") {
        if (this.dedup.check({ agentId: m.agentId, runId: m.runId, epoch: m.epoch, localSeq: m.localSeq })) return;
        this.pushRunEvent(m.runId, m.event);
        return;
      }
      if (m.type === "worker:run-delta") {
        if (this.dedup.check({ agentId: m.agentId, runId: m.runId, epoch: m.epoch, localSeq: m.localSeq })) return;
        const cb = this.runCallbacks.get(m.runId)?.onDelta;
        if (cb) {
          void Promise.resolve()
            .then(() => cb({ update: m.update }))
            .catch(() => { /* 回调异常不传染连接 */ });
        }
        return;
      }
      if (m.type === "worker:run-step") {
        if (this.dedup.check({ agentId: m.agentId, runId: m.runId, epoch: m.epoch, localSeq: m.localSeq })) return;
        const cb = this.runCallbacks.get(m.runId)?.onStep;
        if (cb) {
          void Promise.resolve()
            .then(() => cb({ step: m.step }))
            .catch(() => { /* 回调异常不传染连接 */ });
        }
        return;
      }
      if (m.type === "worker:run-settled") {
        // 终态也进队列（stream 消费者看到事件流结束），等待者同样唤醒；结果留给 wait()。
        this.pushRunEvent(m.runId, { __settled: true });
        this.finishRun(m.runId, m.error, m.result);
        const p = m.reqId ? this.pending.get(m.reqId) : undefined;
        if (p) {
          this.pending.delete(m.reqId!);
          if (m.error) p.reject(new Error(m.error));
          else p.resolve(m.result as never);
        }
        return;
      }
      if (m.type === "worker:tool-call" && m.toolCallReqId) {
        void (async () => {
          try {
            const result = await this.toolHandler({
              toolCallReqId: m.toolCallReqId!,
              agentId: m.agentId,
              callerToken: m.callerToken,
              taskId: m.taskId,
              toolCallId: m.toolCallId,
              toolName: m.toolName,
              args: m.args,
            });
            this.sendCmd({ type: "worker:tool-result", reqId: m.toolCallReqId!, result });
          } catch (err) {
            this.sendCmd({
              type: "worker:tool-result",
              reqId: m.toolCallReqId!,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return;
      }
      if (m.reqId) {
        const p = this.pending.get(m.reqId);
        if (!p) return;
        this.pending.delete(m.reqId);
        if (m.type === "worker:nack") p.reject(new Error((m as { error: string }).error));
        else p.resolve(m as never);
      }
    } catch {
      /* 路由绝不抛 */
    }
  }

  sendCmd<T = unknown>(cmd: WorkerHostCommand, timeoutMs = 60000): Promise<T> {
    const reqId = (cmd as { reqId: string }).reqId;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`[worker-facade] 命令超时 ${cmd.type}`));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: ((v: unknown) => { clearTimeout(timer); resolve(v as T); }) as (v: unknown) => void,
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      try {
        (this.proc.send as (msg: unknown) => boolean)(cmd);
      } catch (err) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // 必修②：内部挂 no-op catch 吞无主 rejection（destroy 拒掉的 in-flight 没人 await 时
    // 不再污染全局）；调用方拿到的仍是原 promise，rejection 照常可接。
    void promise.catch(() => {});
    return promise;
  }

  private pushRunEvent(runId: string, event: unknown): void {
    let q = this.runQueues.get(runId);
    if (!q) {
      q = { events: [], waiters: [], done: false };
      this.runQueues.set(runId, q);
    }
    if (q.waiters.length > 0) {
      const w = q.waiters.shift()!;
      w({ value: event, done: false });
    } else {
      q.events.push(event);
    }
  }

  private finishRun(runId: string, error?: string, result?: unknown): void {
    const q = this.runQueues.get(runId);
    if (!q) {
      this.runQueues.set(runId, { events: [], waiters: [], done: true, result, error });
      return;
    }
    q.done = true;
    q.result = result;
    q.error = error;
    for (const w of q.waiters.splice(0)) w({ value: undefined, done: true });
  }

  private settledResult(runId: string): unknown {
    return this.runQueues.get(runId)?.result;
  }

  runStream(runId: string): AsyncIterable<unknown> {
    const queues = this.runQueues;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            const q = queues.get(runId);
            if (q && q.events.length > 0) {
              const v = q.events.shift()!;
              if ((v as { __settled?: boolean }).__settled) {
                return Promise.resolve({ value: undefined, done: true });
              }
              return Promise.resolve({ value: v, done: false });
            }
            if (q?.done) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<unknown>>((resolve) => {
              let qq = queues.get(runId);
              if (!qq) {
                qq = { events: [], waiters: [], done: false };
                queues.set(runId, qq);
              }
              qq.waiters.push((r) => {
                if (r.done) resolve({ value: undefined, done: true });
                else if ((r.value as { __settled?: boolean })?.__settled) {
                  resolve({ value: undefined, done: true });
                } else resolve({ value: r.value, done: false });
              });
            });
          },
        };
      },
    };
  }

  async createAgent(params: WorkerCreateParams, timeoutMs = 120000): Promise<WorkerAgentHandle> {
    const reqId = nextReqId();
    const ack = (await this.sendCmd({ type: "worker:create", reqId, params }, timeoutMs)) as unknown as {
      agentId: string;
    };
    return this.handleFor(ack.agentId);
  }

  async resumeAgent(agentId: string, params: WorkerCreateParams, timeoutMs = 120000): Promise<WorkerAgentHandle> {
    const reqId = nextReqId();
    const ack = (await this.sendCmd({ type: "worker:resume", reqId, agentId, params }, timeoutMs)) as unknown as {
      agentId: string;
    };
    return this.handleFor(ack.agentId);
  }

  private handleFor(agentId: string): WorkerAgentHandle {
    return {
      agentId,
      send: async (message: unknown, opts?: unknown): Promise<WorkerRunHandle> => {
        const reqId = nextReqId();
        const runId = `mr-${reqSeq}`;
        // 必修①：函数键本地持有（runId→回调），只把数据发过 IPC。
        const { callbacks, rest } = splitCallables(opts);
        if (callbacks.onDelta || callbacks.onStep) {
          this.runCallbacks.set(runId, callbacks);
        }
        try {
          await this.sendCmd({ type: "worker:send", reqId, agentId, runId, message, opts: rest });
        } catch (err) {
          this.runCallbacks.delete(runId);
          throw err;
        }
        return {
          id: runId,
          stream: () => this.runStream(runId),
          wait: async () => {
            try {
              for await (const _ of this.runStream(runId)) { /* 消费至终态 */ void _; }
              return this.settledResult(runId);
            } finally {
              this.runCallbacks.delete(runId);
            }
          },
          cancel: async () => {
            try {
              await this.sendCmd({ type: "worker:cancel", reqId: nextReqId(), runId });
            } finally {
              this.runCallbacks.delete(runId);
            }
          },
        };
      },
      close: async (): Promise<void> => {
        await this.sendCmd({ type: "worker:close", reqId: nextReqId(), agentId });
      },
    };
  }
}

/** opts 拆函数键与数据（通用：未来新增函数键自动跟随）。 */
export const splitCallables = (opts: unknown): {
  callbacks: { onDelta?: (args: { update: unknown }) => void | Promise<void>; onStep?: (args: { step: unknown }) => void | Promise<void> };
  rest: unknown;
} => {
  const callbacks: { onDelta?: (args: { update: unknown }) => void | Promise<void>; onStep?: (args: { step: unknown }) => void | Promise<void> } = {};
  if (!opts || typeof opts !== "object") return { callbacks, rest: opts };
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts as Record<string, unknown>)) {
    if (typeof v === "function" && (k === "onDelta" || k === "onStep")) {
      callbacks[k as "onDelta" | "onStep"] = v as never;
    } else if (typeof v !== "function") {
      rest[k] = v;
    }
    // 未知函数键：丢弃（防静默丢失扩大化——已知只有 onDelta/onStep，见 SendOptions）。
  }
  return { callbacks, rest };
};

/** manifest 提取（纯数据 JSON 安全化；函数不可过 IPC）。 */
export const extractToolManifest = (
  customTools: Record<string, { description?: unknown; inputSchema?: unknown }> | undefined,
): WorkerToolManifest[] => {
  if (!customTools) return [];
  return Object.entries(customTools).map(([name, t]) => ({
    name,
    description: typeof t.description === "string" ? t.description : undefined,
    inputSchema: JSON.parse(JSON.stringify(t.inputSchema ?? {})) as Record<string, unknown>,
  }));
};

/** SDK 输入 JSON 安全化（剥函数，worker 侧重建）。 */
export const stripFunctionsForIpc = (input: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(input, (_k, v) => (typeof v === "function" ? undefined : v)),
  ) as Record<string, unknown>;

/**
 * 翻转装配（agent-backend facade 调用）：落位 + 连接 + 建 worker 寄宿 agent。
 * 任一步失败抛错——调用方 catch 后降级老路径（fail-safe）。
 */
export const placeAndConnectWorker = async (opts: {
  taskId?: string;
  workspace: string;
  stateRoot?: string;
  gitHost: string | null;
  gitToken: string | undefined;
  workDir: string;
}): Promise<{ conn: WorkerConnection; epoch: number }> => {
  const { placeWorkerForTask, sharedWorkerManager } = await import("./worker-route");
  const placement = await placeWorkerForTask({
    taskId: opts.taskId ?? "unknown-task",
    workspace: opts.workspace,
    stateRoot: opts.stateRoot,
    gitHost: opts.gitHost,
    gitToken: opts.gitToken,
    workDir: opts.workDir,
  });
  const proc = sharedWorkerManager().procOf(opts.workspace);
  if (!proc) throw new Error("[worker-facade] 落位成功但进程不可用，降级老路径");
  return { conn: new WorkerConnection(proc, opts.workspace, placement.epoch), epoch: placement.epoch };
};

export const createWorkerHostedAgent = async (opts: {
  sdkInput: Record<string, unknown>;
  manifest: WorkerToolManifest[];
  callerToken?: string;
  taskId?: string;
  workspace: string;
  stateRoot?: string;
  gitHost: string | null;
  gitToken: string | undefined;
  workDir: string;
}): Promise<WorkerAgentHandle> => {
  const { conn } = await placeAndConnectWorker(opts);
  try {
    return await conn.createAgent({
      sdkInput: opts.sdkInput,
      manifest: opts.manifest,
      callerToken: opts.callerToken,
      taskId: opts.taskId,
    });
  } catch (err) {
    conn.destroy();
    throw err;
  }
};

export const resumeWorkerHostedAgent = async (opts: {
  agentId: string;
  sdkInput: Record<string, unknown>;
  manifest: WorkerToolManifest[];
  callerToken?: string;
  taskId?: string;
  workspace: string;
  stateRoot?: string;
  gitHost: string | null;
  gitToken: string | undefined;
  workDir: string;
}): Promise<WorkerAgentHandle> => {
  const { conn } = await placeAndConnectWorker(opts);
  try {
    return await conn.resumeAgent(opts.agentId, {
      sdkInput: opts.sdkInput,
      manifest: opts.manifest,
      callerToken: opts.callerToken,
      taskId: opts.taskId,
    });
  } catch (err) {
    conn.destroy();
    throw err;
  }
};
