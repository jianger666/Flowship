/**
 * worker-facade 协议测试：fake proc 全链路（握手/流/去重/ tool-call RPC/取消/NACK），
 * 不碰真 SDK、不 fork 真进程。真机凭证验收见 LIVE_CHECKLIST §3。
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  extractToolManifest,
  stripFunctionsForIpc,
  WorkerConnection,
} from "../src/lib/server/worker-facade";

class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  sent: unknown[] = [];
  autoAnswer: ((msg: unknown) => void) | null = null;
  send(msg: unknown): boolean {
    this.sent.push(msg);
    if (this.autoAnswer) this.autoAnswer(msg);
    return true;
  }
  kill(): boolean {
    this.exitCode = 0;
    return true;
  }
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("worker-facade 连接与句柄", () => {
  it("create 握手 + agentId 回传", async () => {
    const proc = new FakeProc();
    proc.autoAnswer = (msg: unknown) => {
      const m = msg as { type: string; reqId: string };
      if (m.type === "worker:create") {
        proc.emit("message", { type: "worker:created", reqId: m.reqId, workspace: "/w", epoch: 1, agentId: "ag-1" });
      }
    };
    const conn = new WorkerConnection(proc, "/w", 1);
    try {
      const h = await conn.createAgent({ sdkInput: {}, manifest: [] });
      expect(h.agentId).toBe("ag-1");
    } finally {
      conn.destroy();
    }
  });

  it("send/stream/wait：事件有序、去重、wait 回终态", async () => {
    const proc = new FakeProc();
    proc.autoAnswer = (msg: unknown) => {
      const m = msg as { type: string; reqId: string; runId: string; agentId: string };
      if (m.type === "worker:create") {
        proc.emit("message", { type: "worker:created", reqId: m.reqId, workspace: "/w", epoch: 1, agentId: "ag-1" });
      } else if (m.type === "worker:send") {
        // 协议：worker 必须用主进程的 runId 回事件（自造 runId 两边对不上）。
        const rid = m.runId;
        proc.emit("message", { type: "worker:run-started", reqId: m.reqId, workspace: "/w", epoch: 1, runId: rid, agentId: "ag-1" });
        void (async () => {
          await tick();
          proc.emit("message", { type: "worker:run-event", workspace: "/w", epoch: 1, runId: rid, agentId: "ag-1", localSeq: 1, event: { t: "a" } });
          proc.emit("message", { type: "worker:run-event", workspace: "/w", epoch: 1, runId: rid, agentId: "ag-1", localSeq: 1, event: { t: "a-dup" } });
          proc.emit("message", { type: "worker:run-event", workspace: "/w", epoch: 1, runId: rid, agentId: "ag-1", localSeq: 2, event: { t: "b" } });
          proc.emit("message", { type: "worker:run-settled", reqId: m.reqId, workspace: "/w", epoch: 1, runId: rid, agentId: "ag-1", localSeq: 3, result: "DONE-RESULT" });
        })();
      }
    };
    const conn = new WorkerConnection(proc, "/w", 1);
    try {
      const handle = await conn.createAgent({ sdkInput: {}, manifest: [] });
      const run = await handle.send("hi");
      const seen: unknown[] = [];
      for await (const ev of run.stream()) seen.push(ev);
      expect(seen).toEqual([{ t: "a" }, { t: "b" }]);
      expect(await run.wait()).toBe("DONE-RESULT");
    } finally {
      conn.destroy();
    }
  });

  it("NACK → 调用抛错（fallback 触发条件）", async () => {
    const proc = new FakeProc();
    proc.autoAnswer = (msg: unknown) => {
      const m = msg as { type: string; reqId: string };
      proc.emit("message", { type: "worker:nack", reqId: m.reqId, workspace: "/w", epoch: 1, error: "no creds" });
    };
    const conn = new WorkerConnection(proc, "/w", 1);
    try {
      await expect(conn.createAgent({ sdkInput: {}, manifest: [] })).rejects.toThrow("no creds");
    } finally {
      conn.destroy();
    }
  });

  it("tool-call RPC：主进程执行并回包", async () => {
    const proc = new FakeProc();
    const conn = new WorkerConnection(
      proc,
      "/w",
      1,
      async (req) => ({ content: `echo:${req.toolName}:${JSON.stringify(req.args)}` }),
    );
    try {
      proc.emit("message", {
        type: "worker:tool-call", toolCallReqId: "tc-1", workspace: "/w", epoch: 1,
        agentId: "ag-1", toolCallId: "c1", toolName: "read", args: { path: "/x" },
      });
      await tick(50);
      const reply = proc.sent.find(
        (s) => (s as { type: string }).type === "worker:tool-result",
      ) as unknown as { reqId: string; result: unknown };
      expect(reply.reqId).toBe("tc-1");
      expect(JSON.stringify(reply.result)).toContain("read");
    } finally {
      conn.destroy();
    }
  });
});

describe("worker-facade manifest 与剥离", () => {
  it("manifest 只留纯数据", () => {
    const m = extractToolManifest({
      a: { description: "d", inputSchema: { type: "object" }, execute: async () => ({}) },
    } as never);
    expect(m).toEqual([{ name: "a", description: "d", inputSchema: { type: "object" } }]);
    expect(extractToolManifest(undefined)).toEqual([]);
  });

  it("stripFunctionsForIpc 剥函数留数据", () => {
    const out = stripFunctionsForIpc({ a: 1, f: () => {}, local: { customTools: { x: 1 } } });
    expect(out.a).toBe(1);
    expect((out as { f?: unknown }).f).toBeUndefined();
  });
});

describe("worker-tools-rpc 派发器（fail-closed 面）", () => {
  it("缺 callerToken 拒执行", async () => {
    const { dispatchWorkerToolCall } = await import("../src/lib/server/worker-tools-rpc");
    const r = await dispatchWorkerToolCall({ toolCallId: "c", toolName: "read", args: {} });
    expect(r.ok).toBe(false);
  });

  it("content 报 ok:false → abandoned（不记 done）", async () => {
    const { contentReportsFailure } = await import("../src/lib/server/worker-tools-rpc");
    expect(contentReportsFailure({ content: [{ type: "text", text: '{"ok":false,"error":"x"}' }] })).toBe(true);
    expect(contentReportsFailure({ content: [{ type: "text", text: "任务已被新 agent 接管" }] })).toBe(false);
    expect(contentReportsFailure({ content: [{ type: "text", text: '{"ok":true}' }] })).toBe(false);
    expect(contentReportsFailure(null)).toBe(false);
  });

  it("未知工具错且 kind 映射表覆盖外部工具", async () => {
    const { dispatchWorkerToolCall, WORKER_TOOL_KIND_MAP } = await import("../src/lib/server/worker-tools-rpc");
    expect(WORKER_TOOL_KIND_MAP).toEqual({ share_to_group: "feishu-message", notify_group_testers: "notify" });
    const r = await dispatchWorkerToolCall({ callerToken: "tok", toolCallId: "c", toolName: "nope", args: {} });
    expect(r.ok).toBe(false);
  });

  it("映射 kind 在派发失败时留 intent（恢复可查）", async () => {
    const { promises: fs } = await import("node:fs");
    const { default: os } = await import("node:os");
    const { default: path } = await import("node:path");
    const { dispatchWorkerToolCall } = await import("../src/lib/server/worker-tools-rpc");
    const { pendingIntents } = await import("../src/lib/server/intent-log");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-"));
    const prev = process.env.FLOWSHIP_DATA_DIR;
    process.env.FLOWSHIP_DATA_DIR = dir;
    try {
      // share_to_group 真 handler 无会话返回良性 no-op（transport 成功）→ done；
      // intent/args 照记（恢复可查），pending 清空。
      const r = await dispatchWorkerToolCall({
        callerToken: "tok-unknown", taskId: "t-rpc", toolCallId: "c1", toolName: "share_to_group", args: { task_id: "t", content: "hi" },
      });
      expect(r.ok).toBe(true);
      expect(r.intentKey).toBe("t-rpc:unknown:c1");
      expect(await pendingIntents("t-rpc")).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
    }
  });
});

describe("必修① onDelta/onStep 跨 IPC 转发", () => {
  it("send 带回调 → worker 转发 → 主进程本地回调触发（形状原样）", async () => {
    const { WorkerConnection } = await import("../src/lib/server/worker-facade");
    const { EventEmitter } = await import("node:events");
    class P extends EventEmitter {
      exitCode: number | null = null;
      autoAnswer: ((msg: unknown) => void) | null = null;
      send(msg: unknown): boolean { this.autoAnswer?.(msg); return true; }
      kill(): boolean { return true; }
    }
    const proc = new P();
    proc.autoAnswer = (msg: unknown) => {
      const m = msg as { type: string; reqId: string; runId: string; agentId: string; opts?: unknown };
      if (m.type === "worker:create") {
        proc.emit("message", { type: "worker:created", reqId: m.reqId, workspace: "/w", epoch: 1, agentId: "ag-1" });
      } else if (m.type === "worker:send") {
        // 断言：函数键已被剥离（只剩数据过 IPC）。
        const opts = (m.opts ?? {}) as Record<string, unknown>;
        if (typeof (opts as { onDelta?: unknown }).onDelta === "function") {
          throw new Error("函数键泄漏过 IPC");
        }
        proc.emit("message", { type: "worker:run-started", reqId: m.reqId, workspace: "/w", epoch: 1, runId: m.runId, agentId: "ag-1" });
        void (async () => {
          await new Promise((r) => setTimeout(r, 10));
          proc.emit("message", { type: "worker:run-delta", workspace: "/w", epoch: 1, runId: m.runId, agentId: "ag-1", localSeq: 1, update: { kind: "thinking", ms: 12 } });
          proc.emit("message", { type: "worker:run-step", workspace: "/w", epoch: 1, runId: m.runId, agentId: "ag-1", localSeq: 2, step: { kind: "tool", name: "read" } });
          proc.emit("message", { type: "worker:run-settled", reqId: m.reqId, workspace: "/w", epoch: 1, runId: m.runId, agentId: "ag-1", localSeq: 3, result: "ok" });
        })();
      }
    };
    const conn = new WorkerConnection(proc as never, "/w", 1);
    try {
      const h = await conn.createAgent({ sdkInput: {}, manifest: [] });
      const deltas: unknown[] = [];
      const steps: unknown[] = [];
      const run = await h.send("hi", {
        model: "x",
        onDelta: ({ update }: { update: unknown }) => { deltas.push(update); },
        onStep: ({ step }: { step: unknown }) => { steps.push(step); },
      });
      expect(await run.wait()).toBe("ok");
      // 回调异步派发，等一拍。
      await new Promise((r) => setTimeout(r, 50));
      expect(deltas).toEqual([{ kind: "thinking", ms: 12 }]);
      expect(steps).toEqual([{ kind: "tool", name: "read" }]);
    } finally {
      conn.destroy();
    }
  });
});
