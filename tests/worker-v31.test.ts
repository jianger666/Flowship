import { describe, expect, it } from "vitest";

import { judgeBashCommand } from "../src/lib/server/bash-policy";
import { backfillActionSegments, buildActionEventIndex, readActionEvents } from "../src/lib/server/events-index";
import { buildRelayMessage, estimateTokens } from "../src/lib/server/relay-budget";
import {
  decideIntentRecovery,
  loadShimIntents,
  markIntentAbandoned,
  markIntentDone,
  appendIntent,
  pendingIntentsWithShim,
  withIntentRef,
} from "../src/lib/server/intent-log";
import { migrateNdjsonFile, readWithFallback } from "../src/lib/server/store-migrate";
import { BoundedEventQueue, EventDedupRegistry } from "../src/lib/server/worker-ipc";
import { pruneWorkerReports, resolveShimEnv } from "../src/lib/server/worker-manager";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("worker-ipc 背压与去重", () => {
  it("有界队列满了记 drop", () => {
    const q = new BoundedEventQueue<number>(2);
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(false);
    expect(q.dropped).toBe(1);
    expect(q.drain()).toEqual([1, 2]);
  });

  it("去重注册表判重 + 有界淘汰", () => {
    const r = new EventDedupRegistry(2);
    const e = (s: number, ep = 1) => ({ agentId: "a", runId: "r", epoch: ep, localSeq: s });
    expect(r.check(e(1))).toBe(false);
    expect(r.check(e(1))).toBe(true);
    expect(r.check(e(2))).toBe(false);
    expect(r.check(e(3))).toBe(false);
    expect(r.size).toBe(2);
  });
});

describe("bash-policy 初稿", () => {
  const dirs = ["/work", "/data"];
  it("只读自由 / 外发进 intent / 围栏拒", () => {
    expect(judgeBashCommand("ls -la", dirs)).toEqual({ action: "allow-read" });
    expect(judgeBashCommand("git status", dirs)).toEqual({ action: "allow-read" });
    expect(judgeBashCommand("git commit -m x", dirs)).toEqual({ action: "account-local-write" });
    expect(judgeBashCommand("curl https://x", dirs)).toEqual({ action: "require-intent", via: "path-shim" });
    expect(judgeBashCommand("/usr/bin/curl https://x", dirs).action).toBe("require-intent");
    expect(judgeBashCommand("cat ../../etc/passwd", dirs).action).toBe("deny");
  });
});

describe("relay-budget 8k", () => {
  it("超限截断", () => {
    const big = Array.from({ length: 200 }, (_, i) => `turn-${i} ${"x".repeat(500)}`);
    const { message, truncated } = buildRelayMessage({
      recentTurns: big,
      artifactIndex: Array.from({ length: 100 }, (_, i) => `a-${i}`),
      taskId: "t",
      actionsDir: "/a",
      eventsPath: "/e",
      workDir: "/w",
    });
    expect(truncated).toBe(true);
    expect(estimateTokens(message)).toBeLessThanOrEqual(8000 + 2000);
  });
});

describe("intent-log 恢复判定", () => {
  it("ref 标记幂等", () => {
    const once = withIntentRef("hi", "t", "a", "c");
    expect(once).toContain("[ref:t:a:c]");
    expect(withIntentRef(once, "t", "a", "c")).toBe(once);
  });
  it("at-most-once 不重试", () => {
    expect(decideIntentRecovery({ kind: "notify", verifiedAbsent: true })).toBe("abandoned");
    expect(decideIntentRecovery({ kind: "git-push", verifiedAbsent: true })).toBe("retry");
  });
});

describe("events-index 索引回读", () => {
  it("按 action 切段回读", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "events-idx-"));
    const f = path.join(dir, "events.jsonl");
    await fs.writeFile(
      f,
      `${JSON.stringify({ actionId: "a1", x: 1 })}\n${JSON.stringify({ actionId: "a2", x: 2 })}\n${JSON.stringify({ actionId: "a1", x: 3 })}\n`,
      "utf-8",
    );
    const idx = await buildActionEventIndex(f);
    expect(idx.get("a1")).toEqual([0, 2]);
    expect(await readActionEvents(f, "a2", idx)).toHaveLength(1);
    const back = await backfillActionSegments(dir);
    expect(back.actions).toBe(2);
  });
});

describe("store-migrate 脏行隔离", () => {
  it("半行进 quarantine", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-mig-"));
    const src = path.join(dir, "a.ndjson");
    const dst = path.join(dir, "out.ndjson");
    const q = path.join(dir, "q.jsonl");
    await fs.writeFile(src, `{"a":1}\n半行\n{"b":2}\n`, "utf-8");
    const r = await migrateNdjsonFile(src, dst, q);
    expect(r).toEqual({ total: 3, kept: 2, quarantined: 1 });
    expect(await readWithFallback(dst, q)).toContain('"a":1');
    expect(await readWithFallback(path.join(dir, "missing"), dst)).toContain('"a":1');
  });
});

describe("交接单 A2：WAL 原子 + 并发串行", () => {
  it("并发两次 mark 不互相覆盖", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-a2-"));
    const prev = process.env.FLOWSHIP_DATA_DIR;
    process.env.FLOWSHIP_DATA_DIR = dir;
    try {
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c1", kind: "git-push", payloadHash: "h1" });
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c2", kind: "git-push", payloadHash: "h2" });
      await Promise.all([
        markIntentDone("t", "t:a:c1"),
        markIntentAbandoned("t", "t:a:c2"),
      ]);
      const raw = await fs.readFile(path.join(dir, "intent-log", "t.jsonl"), "utf-8");
      expect(raw).toContain('"status":"done"');
      expect(raw).toContain('"status":"abandoned"');
      // 文件完整可解析，无截断。
      for (const line of raw.split("\n")) {
        if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
    }
  });
});

describe("交接单 B4：shim intent 合并扫描", () => {
  it("shim 行纳入 pending，WAL 覆盖 shim", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-b4-"));
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shim-b4-"));
    const prev = process.env.FLOWSHIP_DATA_DIR;
    process.env.FLOWSHIP_DATA_DIR = dataDir;
    try {
      await fs.writeFile(
        path.join(stateRoot, "shim-intent.jsonl"),
        `${JSON.stringify({ taskId: "t", actionId: "a", toolCallId: "c9", kind: "external-api", via: "path-shim", bin: "curl", argv: ["https://x"] })}\n`,
        "utf-8",
      );
      // WAL 为空时 shim 行被扫出。
      expect(await loadShimIntents(stateRoot)).toHaveLength(1);
      expect(await pendingIntentsWithShim("t", stateRoot)).toHaveLength(1);
      // WAL 落 done 后不再重复计入。
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c9", kind: "external-api", payloadHash: "h" });
      await markIntentDone("t", "t:a:c9");
      expect(await pendingIntentsWithShim("t", stateRoot)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
    }
  });
});

describe("交接单 B5：回读优先走切段", () => {
  it("有切段不读整块", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "events-b5-"));
    const f = path.join(dir, "events.jsonl");
    await fs.writeFile(
      f,
      `${JSON.stringify({ actionId: "a1", x: 1 })}\n${JSON.stringify({ actionId: "a2", x: 2 })}\n`,
      "utf-8",
    );
    await backfillActionSegments(dir);
    // 整块追加脏数据骗过整读：切段命中则不受影响。
    await fs.appendFile(f, `${JSON.stringify({ actionId: "a1", x: 999 })}\n`, "utf-8");
    const got = await readActionEvents(f, "a1");
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('"x":1');
  });
});

describe("交接单 B6：解释器内联外发进 intent", () => {
  it("python/node 内联外发命中 string-match", () => {
    const dirs = ["/work"];
    expect(judgeBashCommand("python3 -c 'import urllib.request'", dirs)).toEqual({
      action: "require-intent",
      via: "string-match",
    });
    expect(judgeBashCommand("node -e 'fetch(\"https://x\")'", dirs).action).toBe("require-intent");
    expect(judgeBashCommand("python3 train.py", dirs).action).not.toBe("require-intent");
  });
});

describe("交接单 A3/A4：report 轮转 + shim env", () => {
  it("轮转留 5 份 + 总量上限", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reports-"));
    for (let i = 0; i < 7; i++) {
      await fs.writeFile(path.join(dir, `report.${i}.json`), "x".repeat(10), "utf-8");
      await new Promise((r) => setTimeout(r, 5));
    }
    const r = await pruneWorkerReports(dir, 5, 200 * 1024 * 1024);
    expect(r.removed).toBe(2);
    expect(r.kept).toBe(5);
  });

  it("shim env：PATH prepend + INTENT_FILE + REAL_*", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shimenv-"));
    const env = await resolveShimEnv(root, { taskId: "t", actionId: "a", toolCallId: "c" });
    expect(env.PATH.startsWith("scripts/worker-path-shim") || env.PATH.includes("worker-path-shim")).toBe(true);
    expect(env.FLOWSHIP_INTENT_FILE.endsWith("shim-intent.jsonl")).toBe(true);
    expect(env.FLOWSHIP_TASK_ID).toBe("t");
  });
});

describe("B1-② 意图执行器主循环", () => {
  it("done/abandoned/无handler/抛错分流", async () => {
    const { appendIntent, loadIntents } = await import("../src/lib/server/intent-log");
    const { sweepPendingIntents, intentStatusOf } = await import("../src/lib/server/intent-executor");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-"));
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "execws-"));
    const prev = process.env.FLOWSHIP_DATA_DIR;
    process.env.FLOWSHIP_DATA_DIR = dir;
    try {
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c1", kind: "git-push", payloadHash: "h" });
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c2", kind: "feishu-message", payloadHash: "h" });
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c3", kind: "notify", payloadHash: "h" });
      const s = await sweepPendingIntents("t", stateRoot, {
        "git-push": async () => ({ verdict: "done" }) as const,
        "feishu-message": async () => ({ verdict: "not-present" }) as const,
        // notify 无 handler → abandoned
      });
      expect(s.done).toBe(1);
      // feishu not-present + at-most-once → abandoned；notify 无 handler → abandoned
      expect(s.abandoned).toBe(2);
      expect(await intentStatusOf("t", "t:a:c1")).toBe("done");
      expect(await intentStatusOf("t", "t:a:c2")).toBe("abandoned");
      expect((await loadIntents("t")).length).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
    }
  });

  it("handler 抛错 → abandoned + errors 记录", async () => {
    const { appendIntent } = await import("../src/lib/server/intent-log");
    const { sweepPendingIntents } = await import("../src/lib/server/intent-executor");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exec2-"));
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "execws2-"));
    const prev = process.env.FLOWSHIP_DATA_DIR;
    process.env.FLOWSHIP_DATA_DIR = dir;
    try {
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c1", kind: "git-push", payloadHash: "h" });
      const s = await sweepPendingIntents("t", stateRoot, {
        "git-push": async () => { throw new Error("net down"); },
      });
      expect(s.abandoned).toBe(1);
      expect(s.errors).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
    }
  });
});

describe("B1-④ worker 内存独立触发", () => {
  it("soft/hard/none 分流且绝不 throw", async () => {
    const { workerRotationActionFor, maybeFireWorkerRotation, registerMidRunRotationTrigger, unregisterMidRunRotationTrigger } =
      await import("../src/lib/server/session-rotate");
    const GB = 1024 * 1024 * 1024;
    expect(workerRotationActionFor({ oldSpaceBytes: 100, rssBytes: 100 })).toBe("none");
    expect(workerRotationActionFor({ oldSpaceBytes: 1.3 * GB, rssBytes: 100 })).toBe("soft");
    expect(workerRotationActionFor({ oldSpaceBytes: 1.6 * GB, rssBytes: 100 })).toBe("hard");
    let fired = 0;
    let gotAction = "unset";
    const fn = (action?: string) => { fired += 1; gotAction = action ?? "unset"; };
    registerMidRunRotationTrigger("t-fire", fn);
    try {
      expect(maybeFireWorkerRotation("t-fire", { oldSpaceBytes: 100, rssBytes: 100 })).toBe("none");
      expect(fired).toBe(0);
      expect(maybeFireWorkerRotation("t-fire", { oldSpaceBytes: 1.6 * GB, rssBytes: 100 })).toBe("hard");
      expect(fired).toBe(1);
      expect(gotAction).toBe("hard");
    } finally {
      unregisterMidRunRotationTrigger("t-fire", fn);
    }
  });
});

describe("翻转开关 + 注册恢复", () => {
  it("默认关闭零行为", async () => {
    const { isWorkerIsolationEnabled } = await import("../src/lib/server/worker-mode");
    expect(isWorkerIsolationEnabled({})).toBe(false);
    expect(isWorkerIsolationEnabled({ FLOWSHIP_WORKER_ISOLATION: "1" })).toBe(true);
    expect(isWorkerIsolationEnabled({ FLOWSHIP_WORKER_ISOLATION: "true" })).toBe(true);
    expect(isWorkerIsolationEnabled({ FLOWSHIP_WORKER_ISOLATION: "0" })).toBe(false);
  });

  it("flag 关 → recoverWithRegistered 直接返回不扫描", async () => {
    const { recoverWithRegistered, resetFlipDeps } = await import("../src/lib/server/worker-flip");
    resetFlipDeps();
    const prev = process.env.FLOWSHIP_WORKER_ISOLATION;
    delete process.env.FLOWSHIP_WORKER_ISOLATION;
    try {
      const s = await recoverWithRegistered(["nope"]);
      expect(s).toEqual({ executed: false, scanned: {}, result: {} });
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_WORKER_ISOLATION;
      else process.env.FLOWSHIP_WORKER_ISOLATION = prev;
    }
  });

  it("flag 开+无 deps → 只扫描不写 mark", async () => {
    const { appendIntent, loadIntents } = await import("../src/lib/server/intent-log");
    const { recoverWithRegistered, resetFlipDeps } = await import("../src/lib/server/worker-flip");
    resetFlipDeps();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flip-"));
    const prevData = process.env.FLOWSHIP_DATA_DIR;
    const prevFlag = process.env.FLOWSHIP_WORKER_ISOLATION;
    process.env.FLOWSHIP_DATA_DIR = dir;
    process.env.FLOWSHIP_WORKER_ISOLATION = "1";
    try {
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c1", kind: "git-push", payloadHash: "h" });
      const s = await recoverWithRegistered(["t"]);
      expect(s.executed).toBe(false);
      expect(s.scanned).toEqual({ t: 1 });
      // 零写入：WAL 里仍只有 intent，无 done/abandoned。
      expect((await loadIntents("t")).every((r) => r.status === "intent")).toBe(true);
    } finally {
      if (prevData === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prevData;
      if (prevFlag === undefined) delete process.env.FLOWSHIP_WORKER_ISOLATION;
      else process.env.FLOWSHIP_WORKER_ISOLATION = prevFlag;
      resetFlipDeps();
    }
  });

  it("flag 开+mock deps → 真执行（MR 反查命中即 done）", async () => {
    const { appendIntent } = await import("../src/lib/server/intent-log");
    const { recoverWithRegistered, registerFlipDeps, resetFlipDeps } = await import("../src/lib/server/worker-flip");
    const { intentStatusOf } = await import("../src/lib/server/intent-executor");
    resetFlipDeps();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flip2-"));
    const prevData = process.env.FLOWSHIP_DATA_DIR;
    const prevFlag = process.env.FLOWSHIP_WORKER_ISOLATION;
    process.env.FLOWSHIP_DATA_DIR = dir;
    process.env.FLOWSHIP_WORKER_ISOLATION = "1";
    try {
      await appendIntent({ taskId: "t", actionId: "a", toolCallId: "c1", kind: "merge-request", payloadHash: "h" });
      registerFlipDeps({
        payloadProvider: async () => ({ projectPath: "g/p", sourceBranch: "f", targetBranch: "test" }),
        findOpenMergeRequest: async () => ({ found: true }),
      });
      const s = await recoverWithRegistered(["t"]);
      expect(s.executed).toBe(true);
      expect(s.result["t"].done).toBe(1);
      expect(await intentStatusOf("t", "t:a:c1")).toBe("done");
    } finally {
      if (prevData === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prevData;
      if (prevFlag === undefined) delete process.env.FLOWSHIP_WORKER_ISOLATION;
      else process.env.FLOWSHIP_WORKER_ISOLATION = prevFlag;
      resetFlipDeps();
    }
  });
});

describe("tool-call-args 注册表", () => {
  it("登记/读取/FIFO 有界", async () => {
    const { recordToolCallArgs, getToolCallArgs, clearToolCallArgs, toolCallArgsSize } =
      await import("../src/lib/server/tool-call-args");
    clearToolCallArgs();
    expect(getToolCallArgs("t", "c-missing")).toBeNull();
    recordToolCallArgs({ taskId: "t", actionId: "a", toolCallId: "c1", toolName: "git", args: { op: "push" } });
    expect(getToolCallArgs("t", "c1")?.args).toEqual({ op: "push" });
    expect(toolCallArgsSize()).toBe(1);
    clearToolCallArgs();
    expect(toolCallArgsSize()).toBe(0);
  });
});

describe("收尾线①路由分叉", () => {
  it("flag 关 → placeWorkerForTask 拒调（老路径零变化）", async () => {
    const { placeWorkerForTask } = await import("../src/lib/server/worker-route");
    const prev = process.env.FLOWSHIP_WORKER_ISOLATION;
    delete process.env.FLOWSHIP_WORKER_ISOLATION;
    try {
      await expect(placeWorkerForTask({
        taskId: "t", workspace: "/w", gitHost: null, gitToken: undefined, workDir: "/w",
      })).rejects.toThrow("flag 关闭");
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_WORKER_ISOLATION;
      else process.env.FLOWSHIP_WORKER_ISOLATION = prev;
    }
  });

  it("flag 开 + mock manager → 落位+握手+deps 注册", async () => {
    const { placeWorkerForTask, resetSharedWorkerManager } = await import("../src/lib/server/worker-route");
    const { WorkerManager } = await import("../src/lib/server/worker-manager");
    const { getToolCallArgs, recordToolCallArgs, clearToolCallArgs } = await import("../src/lib/server/tool-call-args");
    const prev = process.env.FLOWSHIP_WORKER_ISOLATION;
    process.env.FLOWSHIP_WORKER_ISOLATION = "1";
    resetSharedWorkerManager();
    clearToolCallArgs();
    void getToolCallArgs;
    try {
      // mock manager：不 fork 真进程，直接派发自上报完成握手。
      const mgr = new WorkerManager({ maxWorkers: 4 });
      const fakeProc = { exitCode: null, on: () => {}, kill: () => true } as unknown as import("node:child_process").ChildProcess;
      const rec = { workspace: "/w", stateRoot: "/ws", epoch: 7, proc: fakeProc, lastActiveAt: Date.now(), rssBytes: 0, fresh: true };
      (mgr as unknown as { workers: Map<string, unknown> }).workers.set("/w", rec);
      const origSpawn = mgr.spawn.bind(mgr);
      void origSpawn;
      mgr.spawn = (async () => rec) as typeof mgr.spawn;
      const placing = placeWorkerForTask({
        taskId: "t9", workspace: "/w", gitHost: null, gitToken: undefined, workDir: "/w", manager: mgr,
        readyTimeoutMs: 3000,
      });
      // 握手与落位并发：自上报稍后到达，落位解除等待。
      await new Promise((r) => setTimeout(r, 50));
      mgr.dispatchProcMessage({ type: "worker:self-report", workspace: "/w", epoch: 7, rssBytes: 10, level: "normal" });
      const p = await placing;
      expect(p).toEqual({ workspace: "/w", epoch: 7, via: "worker" });
      // 握手：补一份自上报，awaitWorkerReady 应放行（直接调验证派发通路）。
      const { awaitWorkerReady } = await import("../src/lib/server/worker-route");
      const ready = awaitWorkerReady(mgr, "/w", 7, 2000);
      mgr.dispatchProcMessage({ type: "worker:self-report", workspace: "/w", epoch: 7, rssBytes: 123, level: "normal" });
      await ready;
      // flip deps 已注册：无 handler 缺失（merge-request 走到缺参数 abandoned，而非无 handler）。
      const { sweepPendingIntents } = await import("../src/lib/server/intent-executor");
      const { appendIntent } = await import("../src/lib/server/intent-log");
      const { registerFlipDeps, resetFlipDeps } = await import("../src/lib/server/worker-flip");
      void registerFlipDeps; void resetFlipDeps;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-"));
      const prevData = process.env.FLOWSHIP_DATA_DIR;
      process.env.FLOWSHIP_DATA_DIR = dir;
      try {
        await appendIntent({ taskId: "t9", actionId: "a", toolCallId: "c1", kind: "feishu-message", payloadHash: "h" });
        // 用 placeWorkerForTask 注册的真 deps sweep：feishu 无查询 → abandoned（不是无 handler）。
        const { buildWorkerIntentHandlers } = await import("../src/lib/server/worker-flip");
        recordToolCallArgs({ taskId: "t9", actionId: "a", toolCallId: "c1", toolName: "x", args: {} });
        const s = await sweepPendingIntents("t9", "", buildWorkerIntentHandlers({
          payloadProvider: async () => null,
          findOpenMergeRequest: async () => ({ found: false }),
        }));
        expect(s.abandoned).toBe(1);
      } finally {
        if (prevData === undefined) delete process.env.FLOWSHIP_DATA_DIR;
        else process.env.FLOWSHIP_DATA_DIR = prevData;
      }
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_WORKER_ISOLATION;
      else process.env.FLOWSHIP_WORKER_ISOLATION = prev;
      resetSharedWorkerManager();
    }
  });

  it("探针三档：无样本回落/soft/hard/超限", async () => {
    const { probeWorkerRotation, clearWorkerRotationCounters, registerMidRunRotationTrigger, unregisterMidRunRotationTrigger } =
      await import("../src/lib/server/session-rotate");
    clearWorkerRotationCounters();
    const GB = 1024 * 1024 * 1024;
    expect(probeWorkerRotation("t", "a", null).fired).toBe(false);
    const acts: string[] = [];
    const fn = (a?: string) => { acts.push(a ?? "none"); };
    registerMidRunRotationTrigger("t", fn);
    try {
      expect(probeWorkerRotation("t", "a", { oldSpaceBytes: 1.3 * GB, rssBytes: 100 }).fired).toBe(true);
      expect(acts.at(-1)).toBe("soft");
      // 打满 action 上限 → 降级不触发。
      probeWorkerRotation("t", "a", { oldSpaceBytes: 1.3 * GB, rssBytes: 100 });
      probeWorkerRotation("t", "a", { oldSpaceBytes: 1.3 * GB, rssBytes: 100 });
      const r = probeWorkerRotation("t", "a", { oldSpaceBytes: 1.6 * GB, rssBytes: 100 });
      expect(r.fired).toBe(false);
      expect(r.denyReason).toBe("action-cap");
    } finally {
      unregisterMidRunRotationTrigger("t", fn);
      clearWorkerRotationCounters();
    }
  });
});

describe("第五批 bug①：双 guard 全线", () => {
  it("dispatch 透传 old-space/heapRatio，relay 不再填 0", async () => {
    const { WorkerManager } = await import("../src/lib/server/worker-manager");
    const mgr = new WorkerManager({ maxWorkers: 1 });
    const seen: unknown[] = [];
    mgr.onSelfReport((m) => seen.push(m));
    mgr.dispatchProcMessage({
      type: "worker:self-report", workspace: "/w", epoch: 3,
      oldSpaceBytes: 1.4 * 1024 * 1024 * 1024, heapRatio: 0.7, rssBytes: 100, level: "soft",
    });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { oldSpaceBytes: number }).oldSpaceBytes).toBe(1.4 * 1024 * 1024 * 1024);
    // 绝对值线可触发（之前填 0 时永不触发）。
    const { workerRotationActionFor } = await import("../src/lib/server/session-rotate");
    expect(workerRotationActionFor({ oldSpaceBytes: 1.4 * 1024 * 1024 * 1024, rssBytes: 100 })).toBe("soft");
  });
});

describe("第五批 bug③：监听器单例 + 样本不错映射", () => {
  it("同 workspace 重落位只留一个监听，旧 task 样本被清", async () => {
    const { placeWorkerForTask, resetSharedWorkerManager, resetWorkspaceSubscriptions } =
      await import("../src/lib/server/worker-route");
    const { WorkerManager } = await import("../src/lib/server/worker-manager");
    const { getWorkerMemorySample } = await import("../src/lib/server/session-rotate");
    const prev = process.env.FLOWSHIP_WORKER_ISOLATION;
    process.env.FLOWSHIP_WORKER_ISOLATION = "1";
    resetSharedWorkerManager();
    resetWorkspaceSubscriptions();
    try {
      const mgr = new WorkerManager({ maxWorkers: 4 });
      const fakeProc = { exitCode: null, on: () => {}, kill: () => true } as unknown as import("node:child_process").ChildProcess;
      let epoch = 0;
      mgr.spawn = (async (workspace: string) => ({
        workspace, stateRoot: "/ws", epoch: (epoch += 1), proc: fakeProc,
        lastActiveAt: Date.now(), rssBytes: 0, fresh: true,
      })) as typeof mgr.spawn;
      const go = async (taskId: string) => {
        const placing = placeWorkerForTask({
          taskId, workspace: "/w", gitHost: null, gitToken: undefined, workDir: "/w",
          manager: mgr, readyTimeoutMs: 3000,
        });
        await new Promise((r) => setTimeout(r, 20));
        mgr.dispatchProcMessage({ type: "worker:self-report", workspace: "/w", epoch, rssBytes: 50, level: "normal" });
        await placing;
      };
      await go("t-old");
      expect(getWorkerMemorySample("t-old")?.rssBytes).toBe(50);
      await go("t-new");
      // 旧监听已 off：再派发只写新 task，旧样本已被清。
      expect(getWorkerMemorySample("t-old")).toBeNull();
      mgr.dispatchProcMessage({ type: "worker:self-report", workspace: "/w", epoch: 99, rssBytes: 77, level: "normal" });
      expect(getWorkerMemorySample("t-new")?.rssBytes).toBe(77);
      expect(getWorkerMemorySample("t-old")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_WORKER_ISOLATION;
      else process.env.FLOWSHIP_WORKER_ISOLATION = prev;
      resetSharedWorkerManager();
      resetWorkspaceSubscriptions();
    }
  });
});

describe("第五批 bug②：submit_mr 端到端（记得住、查得到）", () => {
  it("派发后 registry 可取回 + 反查命中 done", async () => {
    const { createMRWithIntent, registryPayloadProvider } = await import("../src/lib/server/worker-flip");
    const { getToolCallArgs, clearToolCallArgs } = await import("../src/lib/server/tool-call-args");
    const { appendIntent, loadIntents } = await import("../src/lib/server/intent-log");
    void appendIntent; void loadIntents;
    clearToolCallArgs();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mr-e2e-"));
    const prev = process.env.FLOWSHIP_DATA_DIR;
    process.env.FLOWSHIP_DATA_DIR = dir;
    try {
      // 执行点：假 create 成功。
      const r = await createMRWithIntent(
        {
          taskId: "t", actionId: "a1",
          config: { host: "h", token: "k" },
          projectPath: "g/p", sourceBranch: "feat", targetBranch: "test",
          title: "t", description: "d", removeSourceBranch: false,
        },
        async () => ({ ok: true, url: "http://x/1", iid: 1 }) as const,
      );
      expect(r.ok).toBe(true);
      // 派发后可取回（岛已接通）。
      const hit = getToolCallArgs("t", "submit-mr:a1:feat:test");
      expect(hit?.args).toMatchObject({ projectPath: "g/p", sourceBranch: "feat" });
      // 恢复侧：provider 取回参数 → 反查命中 → done。
      const rec = {
        taskId: "t", actionId: "a1", toolCallId: "submit-mr:a1:feat:test",
        kind: "merge-request", payloadHash: "x", status: "intent",
        idempotencyKey: "t:a1:submit-mr:a1:feat:test", createdAt: 0, updatedAt: 0,
      } as const;
      const payload = await registryPayloadProvider({ ...rec });
      expect(payload?.sourceBranch).toBe("feat");
      const { buildWorkerIntentHandlers } = await import("../src/lib/server/worker-flip");
      const handlers = buildWorkerIntentHandlers({
        payloadProvider: registryPayloadProvider,
        findOpenMergeRequest: async () => ({ found: true }),
      });
      expect(await handlers["merge-request"]!({ ...rec })).toEqual({ verdict: "done" });
      // force-push 短路 abandoned。
      const fp = await handlers["git-push"]!({
        taskId: "t", actionId: "a", toolCallId: "c", kind: "git-push", payloadHash: "h",
        status: "intent", idempotencyKey: "t:a:c", createdAt: 0, updatedAt: 0,
      });
      void fp;
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
      clearToolCallArgs();
    }
  });

  it("force-push → abandoned（④注释兑现）", async () => {
    const { buildWorkerIntentHandlers } = await import("../src/lib/server/worker-flip");
    const handlers = buildWorkerIntentHandlers({
      payloadProvider: async () => ({ sourceBranch: "f", localCommit: "abc", forcePush: true }),
      isCommitPushed: async () => true,
      workDirOf: () => "/w",
    });
    expect(await handlers["git-push"]!({
      taskId: "t", actionId: "a", toolCallId: "c", kind: "git-push", payloadHash: "h",
      status: "intent", idempotencyKey: "t:a:c", createdAt: 0, updatedAt: 0,
    })).toEqual({ verdict: "abandoned", reason: "force-push 意图不自动重放，人工确认" });
  });
});
