/**
 * Worker 子进程入口（v3.1 §2 + §3.2：可丢弃的盒子 + 自监控 heap/RSS）。
 *
 * - 只做自监控与状态上报，不直接执行业务：SDK Agent 生命周期迁移在实验 B
 *   定出四档路线后接入，此处预留 `FLOWSHIP_WORKER_*` 环境变量与上报通道；
 * - heap/RSS 双 guard 任一命中即向主进程上报（process.send），主进程按重启阶梯决策；
 * - report 目录轮转由 spawn 方 `--report-*` 负责（见 worker-manager execArgv）。
 */

import v8 from "node:v8";

import {
  classifyWorkerMemory,
  WORKER_HEAP_RATIO_HARD,
  WORKER_HEAP_RATIO_SOFT,
  WORKER_OLD_SPACE_HARD_BYTES,
  WORKER_OLD_SPACE_SOFT_BYTES,
  WORKER_RSS_HARD_BYTES,
  WORKER_RSS_SOFT_BYTES,
} from "./mem-governance";

const workspace = process.env.FLOWSHIP_WORKER_WORKSPACE ?? "unknown";
const epoch = Number(process.env.FLOWSHIP_WORKER_EPOCH ?? "0");
const stateRoot = process.env.FLOWSHIP_WORKER_STATE_ROOT ?? "";

export interface WorkerSelfReport {
  workspace: string;
  epoch: number;
  oldSpaceBytes: number;
  heapRatio: number;
  rssBytes: number;
  level: "normal" | "soft" | "hard";
  thresholds: {
    oldSpaceSoft: number;
    oldSpaceHard: number;
    heapRatioSoft: number;
    heapRatioHard: number;
    rssSoft: number;
    rssHard: number;
  };
}

export const sampleSelf = (): WorkerSelfReport => {
  const stats = v8.getHeapStatistics();
  // heap_size_limit 随 spawn 上限走；used 近似为 old-space 占用（自监控用，不做精确归因）。
  const limit = stats.heap_size_limit || 1;
  const used = stats.used_heap_size || 0;
  const rss = process.memoryUsage().rss || 0;
  const level = classifyWorkerMemory({
    oldSpaceBytes: used,
    heapRatio: limit > 0 ? used / limit : 0,
    rssBytes: rss,
  });
  return {
    workspace,
    epoch,
    oldSpaceBytes: used,
    heapRatio: limit > 0 ? used / limit : 0,
    rssBytes: rss,
    level,
    thresholds: {
      oldSpaceSoft: WORKER_OLD_SPACE_SOFT_BYTES,
      oldSpaceHard: WORKER_OLD_SPACE_HARD_BYTES,
      heapRatioSoft: WORKER_HEAP_RATIO_SOFT,
      heapRatioHard: WORKER_HEAP_RATIO_HARD,
      rssSoft: WORKER_RSS_SOFT_BYTES,
      rssHard: WORKER_RSS_HARD_BYTES,
    },
  };
};

const report = (): void => {
  const s = sampleSelf();
  if (typeof process.send === "function") {
    process.send({ type: "worker:self-report", ...s });
  }
  if (s.level === "hard") {
    // 硬线命中：只上报不自杀，重启决策权在主进程（重启阶梯 §4）。
    console.warn(
      `[worker-entry] 硬线命中 workspace=${s.workspace} epoch=${s.epoch} ` +
        `heap=${Math.round(s.oldSpaceBytes / 1048576)}MB rss=${Math.round(s.rssBytes / 1048576)}MB`,
    );
  }
};

console.log(`[worker-entry] up workspace=${workspace} epoch=${epoch} stateRoot=${stateRoot}`);
const timer = setInterval(report, 10_000);
timer.unref?.();
report();

// ---------- compute-plane：SDK 生命周期寄宿（选项 A 翻转） ----------
//
// worker 收到 `worker:create/resume` 即用主进程转交的参数在 worker 内建 agent
// （transcript/checkpoint 堆从此长在 worker）；customTools 按 manifest 重建，
// execute 一律 RPC 回主进程（唯一执行点，见 worker-tools-rpc）；run 事件逐条
// 回传（带 epoch+localSeq，主进程 worker-ipc 去重）；`send/cancel/close` 转发。
// 运行要 Cursor 凭证（fork 继承同 env），无凭证/失败 NACK，主进程 fallback 老路径。
// 真机验收见 LIVE_CHECKLIST §3。

import type {
  WorkerHostCommand,
  WorkerToolManifest,
} from "./worker-ipc";

interface RpcToolResult {
  content?: unknown;
}
interface HostedTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<RpcToolResult>;
}
interface HostedAgent {
  agentId: string;
  send: (message: unknown, opts?: unknown) => Promise<HostedRun>;
  close: () => Promise<void> | void;
}
interface HostedRun {
  stream?: () => AsyncIterable<unknown>;
  wait: () => Promise<unknown>;
  cancel: () => Promise<void> | void;
}
const hostedAgents = new Map<string, HostedAgent>();
const hostedRuns = new Map<string, HostedRun>();
let workerLocalSeq = 0;
let toolCallSeq = 0;
const post = (msg: unknown): void => {
  if (typeof process.send === "function") {
    try { process.send(msg); } catch { /* 主进程已死 */ }
  }
};
const fail = (reqId: string, error: string): void =>
  post({ type: "worker:nack", reqId, workspace, epoch, error });

/** 按 manifest 重建 customTools：execute 经 RPC 回主进程执行并等结果（超时 120s）。 */
const rebuildTools = (
  manifest: WorkerToolManifest[],
  ctx: { agentId: string; callerToken?: string; taskId?: string },
): Record<string, HostedTool> => {
  const tools: Record<string, HostedTool> = {};
  for (const m of manifest) {
    const toolName = m.name;
    tools[toolName] = {
      description: m.description,
      inputSchema: m.inputSchema,
      execute: async (args) => {
        const toolCallReqId = `tc-${epoch}-${(toolCallSeq += 1)}`;
        const toolCallId = `${toolCallReqId}`;
        const res = await new Promise<RpcToolResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingToolResults.delete(toolCallReqId);
            reject(new Error(`[worker-entry] tool-call RPC 超时 ${toolName}`));
          }, 120000);
          pendingToolResults.set(toolCallReqId, {
            resolve: (r) => { clearTimeout(timer); resolve(r); },
            reject: (e) => { clearTimeout(timer); reject(e); },
          });
          post({
            type: "worker:tool-call",
            toolCallReqId,
            workspace,
            epoch,
            agentId: ctx.agentId,
            callerToken: ctx.callerToken,
            taskId: ctx.taskId,
            toolCallId,
            toolName,
            args,
          });
        });
        return res;
      },
    };
  }
  return tools;
};
const pendingToolResults = new Map<
  string,
  { resolve: (r: RpcToolResult) => void; reject: (e: Error) => void }
>();

process.on("message", (raw: unknown) => {
  void (async () => {
    try {
      const m = raw as WorkerHostCommand & { reqId: string };
      if (!m || typeof (m as { type?: unknown }).type !== "string") return;
      // tool-call 回包（与命令同通道）。
      if ((m as { type: string }).type === "worker:tool-result") {
        const r = m as unknown as { reqId: string; result?: unknown; error?: string };
        const p = pendingToolResults.get(r.reqId);
        if (p) {
          pendingToolResults.delete(r.reqId);
          if (r.error) p.reject(new Error(r.error));
          else p.resolve((r.result ?? {}) as RpcToolResult);
        }
        return;
      }
      if (!("reqId" in m) || !m.reqId) return;
      if (m.type === "worker:create" || m.type === "worker:resume") {
        const sdk = (await import("@cursor/sdk")) as unknown as {
          Agent: {
            create: (params: unknown) => Promise<HostedAgent>;
            resume: (agentId: string, params: unknown) => Promise<HostedAgent>;
          };
        };
        const { sdkInput, manifest, callerToken, taskId } = m.params;
        // toolCtx 可变单例：create 前挂工具，agentId 回来后填入（闭包共享对象，自动生效）。
        const toolCtx: { agentId: string; callerToken?: string; taskId?: string } = {
          agentId: "",
          callerToken,
          taskId,
        };
        const withTools = {
          ...(sdkInput as Record<string, unknown>),
          local: {
            ...((sdkInput as Record<string, unknown>).local as Record<string, unknown> | undefined),
            customTools: rebuildTools(manifest, toolCtx),
          },
        };
        const agent =
          m.type === "worker:create"
            ? await sdk.Agent.create(withTools)
            : await sdk.Agent.resume(m.agentId, withTools);
        toolCtx.agentId = agent.agentId;
        hostedAgents.set(agent.agentId, agent);
        post({ type: "worker:created", reqId: m.reqId, workspace, epoch, agentId: agent.agentId });
        return;
      }
      if (m.type === "worker:send") {
        const agent = hostedAgents.get(m.agentId);
        if (!agent) { fail(m.reqId, `unknown agent ${m.agentId}`); return; }
        // 必修①：函数回调过不了 IPC——主进程已剥离本地持有，这里包转发器
        // 把 SDK 回调形状原样回传（opaque，不翻译），主进程按 runId 派发。
        const fwdOpts = {
          ...((m.opts as Record<string, unknown> | undefined) ?? {}),
          onDelta: (args: { update: unknown }) => {
            workerLocalSeq += 1;
            post({ type: "worker:run-delta", workspace, epoch, runId: m.runId, agentId: agent.agentId, localSeq: workerLocalSeq, update: args?.update });
          },
          onStep: (args: { step: unknown }) => {
            workerLocalSeq += 1;
            post({ type: "worker:run-step", workspace, epoch, runId: m.runId, agentId: agent.agentId, localSeq: workerLocalSeq, step: args?.step });
          },
        };
        const run = await agent.send(m.message, fwdOpts);
        // runId 以主进程为准（主进程按此建队列收事件；worker 不自造，避免两边对不上）。
        const runId = m.runId || `wr-${epoch}-${(workerLocalSeq += 1)}`;
        hostedRuns.set(runId, run);
        post({ type: "worker:run-started", reqId: m.reqId, workspace, epoch, runId, agentId: agent.agentId });
        // 流事件逐条回传（localSeq 单调，主进程去重），终态经 settled。
        try {
          if (typeof run.stream === "function") {
            for await (const event of run.stream()) {
              workerLocalSeq += 1;
              post({ type: "worker:run-event", workspace, epoch, runId, agentId: agent.agentId, localSeq: workerLocalSeq, event });
            }
          }
          const result = await run.wait();
          workerLocalSeq += 1;
          post({ type: "worker:run-settled", reqId: m.reqId, workspace, epoch, runId, agentId: agent.agentId, localSeq: workerLocalSeq, result });
        } catch (error) {
          workerLocalSeq += 1;
          post({ type: "worker:run-settled", reqId: m.reqId, workspace, epoch, runId, agentId: agent.agentId, localSeq: workerLocalSeq, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (m.type === "worker:cancel") {
        const run = hostedRuns.get(m.runId);
        if (run) await run.cancel();
        post({ type: "worker:cancelled", reqId: m.reqId, workspace, epoch, runId: m.runId });
        return;
      }
      if (m.type === "worker:close") {
        const agent = hostedAgents.get(m.agentId);
        if (agent) {
          await agent.close();
          hostedAgents.delete(m.agentId);
        }
        post({ type: "worker:closed", reqId: m.reqId, workspace, epoch, agentId: m.agentId });
        return;
      }
    } catch (err) {
      const m = raw as { reqId?: string };
      if (m?.reqId) fail(m.reqId, err instanceof Error ? err.message : String(err));
    }
  })();
});
