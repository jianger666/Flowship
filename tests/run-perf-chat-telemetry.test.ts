/**
 * X3(c)：run-perf 每个 run 汇总记录的 `proc` 里新增的「server 堆增长」遥测——字段形状契约
 *
 * 为什么要有这些字段：server 堆耗尽崩溃时进程已经没了，只能靠崩前最后几行记录还原现场；
 * 以前 proc 只有 heapMB(used)，看不出是「热会话在涨」「堆外在涨」还是「分离上下文泄漏」。
 * 新增：chatHot（热 chat 会话数）/ chatHotDetail（明细，≤4 条）/ chatReclaim（回收次数按原因分）/ v8（堆明细）。
 *
 * 钉死的语义：
 *  - 形状与类型（字段在、是有限数、没有 undefined 键）；0 与「探针没登记」要能区分；
 *  - 隐私：明细里只有 taskId（id）与数字 / 布尔，没有路径 / 正文；
 *  - 体积：满填后整行记录仍在 4KB 预算内（既有「体积有界」用例只覆盖手填 proc，覆盖不到新字段）；
 *  - 端到端：走**默认**环境快照（不替换 provider），热会话探针 + 回收计数真的进了落盘记录。
 *
 * 分类：端到端用例 = 回归（改前 proc 里没有这些字段，会红）；纯函数用例 = 新增函数的单测。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetChatReclaimForTests,
  recordChatReclaim,
  registerChatHotProbe,
} from "@/lib/server/chat-reclaim";
import {
  CHAT_HOT_DETAIL_MAX,
  buildChatProcTelemetry,
  buildRunRecord,
  buildV8Telemetry,
  createRunAccumulator,
  type BuildRecordInput,
  type RunPerfRecord,
} from "@/lib/server/run-perf-record";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-run-perf-chat-telemetry-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

// 端到端用例里的 SDK store 句柄由用例控制：默认 undefined（= 没开 store，与不 mock 时的行为一致）；
// run-perf 只会 peek（不会打开）store，这里替换的就是那个 peek
const sdkStore = vi.hoisted(() => ({ handle: undefined as unknown }));
vi.mock("@/lib/server/sdk-agent-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-agent-store")>()),
  peekSdkStoreHandle: async () => sdkStore.handle,
}));

const { createRunPerfTracker, __setRunPerfEnvProviderForTests } = await import(
  "@/lib/server/run-perf"
);

const START = 1_000_000;

const hot = (
  taskId: string,
  over: Partial<{
    agentId: string;
    idleMs: number;
    runActive: boolean;
    backgroundRunning: number;
  }> = {},
) => ({
  taskId,
  agentId: over.agentId ?? `agent_${taskId}`,
  idleMs: over.idleMs ?? 0,
  runActive: over.runActive ?? false,
  backgroundRunning: over.backgroundRunning ?? 0,
});

const ZERO = { idle: 0, scheduledEnd: 0, watermark: 0 };

const baseInput = (over: Partial<BuildRecordInput> = {}): BuildRecordInput => ({
  now: START + 5_000,
  ctx: { taskId: "t1", agentId: "a1", runKind: "chat-followup" },
  outcome: "ok",
  snap: createRunAccumulator(START).snapshot(START + 5_000),
  prep: null,
  idleBeforeMs: null,
  warmedAgoMs: null,
  env: {},
  runtime: { platform: "darwin" },
  ...over,
});

beforeEach(() => {
  __resetChatReclaimForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __setRunPerfEnvProviderForTests();
  __resetChatReclaimForTests();
  sdkStore.handle = undefined;
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("buildChatProcTelemetry：热会话 + 回收计数 → proc 字段", () => {
  it("chatHot 是热会话总数；明细每行只有 t / idleS（秒取整）", () => {
    const out = buildChatProcTelemetry(
      [hot("t_a", { idleMs: 61_499 }), hot("t_b", { idleMs: 2_000 })],
      ZERO,
    );
    expect(out.chatHot).toBe(2);
    expect(out.chatHotDetail).toEqual([
      { t: "t_b", idleS: 2 },
      { t: "t_a", idleS: 61 },
    ]);
  });

  it("idleS 不为负：idleMs 为负（时钟回拨 / lastActiveAt 在未来）→ 按 0，不把负数写进落盘记录", () => {
    const out = buildChatProcTelemetry([hot("t_neg", { idleMs: -3_000 })], ZERO);
    expect(out.chatHotDetail).toEqual([{ t: "t_neg", idleS: 0 }]);
  });

  it("run 在跑 → run:true；后台子代理数 > 0 才有 bg；为 0 / false 时键不出现（没有 undefined 键）", () => {
    const out = buildChatProcTelemetry(
      [
        hot("t_run", { runActive: true, idleMs: 1000 }),
        hot("t_bg", { backgroundRunning: 3, idleMs: 2000 }),
        hot("t_plain", { idleMs: 3000 }),
      ],
      ZERO,
    );
    const byTask = Object.fromEntries((out.chatHotDetail ?? []).map((d) => [d.t, d]));
    expect(byTask.t_run).toEqual({ t: "t_run", idleS: 1, run: true });
    expect(byTask.t_bg).toEqual({ t: "t_bg", idleS: 2, bg: 3 });
    expect(byTask.t_plain).toEqual({ t: "t_plain", idleS: 3 });
    for (const d of out.chatHotDetail ?? []) {
      for (const v of Object.values(d)) expect(v).not.toBeUndefined();
    }
  });

  it("agentMB：来自 store 的字节数换算成 MB（保留 1 位）；取不到的行省略该键", () => {
    const bytes: Record<string, number | undefined> = {
      agent_t_big: 5 * 1048576 + 52429, // ≈ 5.05 MB → 5.1? 四舍五入到 1 位
      agent_t_small: 1048576, // 1 MB
      agent_t_none: undefined,
    };
    const out = buildChatProcTelemetry(
      [hot("t_small"), hot("t_big"), hot("t_none")],
      ZERO,
      (id) => bytes[id],
    );
    const byTask = Object.fromEntries((out.chatHotDetail ?? []).map((d) => [d.t, d]));
    expect(byTask.t_big?.agentMB).toBe(5.1);
    expect(byTask.t_small?.agentMB).toBe(1);
    expect("agentMB" in (byTask.t_none ?? {})).toBe(false);
  });

  it("排序：SDK 数据量大的在前（最该看的），取不到的排最后、按空闲从短到长", () => {
    const bytes: Record<string, number> = {
      agent_t_mid: 2 * 1048576,
      agent_t_big: 9 * 1048576,
    };
    const out = buildChatProcTelemetry(
      [
        hot("t_none_old", { idleMs: 90_000 }),
        hot("t_mid"),
        hot("t_none_new", { idleMs: 5_000 }),
        hot("t_big"),
      ],
      ZERO,
      (id) => bytes[id],
    );
    expect(out.chatHotDetail?.map((d) => d.t)).toEqual([
      "t_big",
      "t_mid",
      "t_none_new",
      "t_none_old",
    ]);
  });

  it(`明细最多 ${CHAT_HOT_DETAIL_MAX} 条（防记录膨胀），但 chatHot 仍是真实总数`, () => {
    const many = Array.from({ length: 9 }, (_, i) => hot(`t_${i}`, { idleMs: i * 1000 }));
    const out = buildChatProcTelemetry(many, ZERO);
    expect(out.chatHot).toBe(9);
    expect(out.chatHotDetail).toHaveLength(CHAT_HOT_DETAIL_MAX);
    expect(CHAT_HOT_DETAIL_MAX).toBe(4);
  });

  it("热会话数为 0（探针登记了、会话都已回收）→ chatHot:0 且没有明细键；这是回收生效的证据，不能丢", () => {
    const out = buildChatProcTelemetry([], ZERO);
    expect(out.chatHot).toBe(0);
    expect("chatHotDetail" in out).toBe(false);
  });

  it("探针没登记（hot 为 undefined）→ 省略 chatHot / chatHotDetail；chatReclaim 是全局计数、始终给", () => {
    const out = buildChatProcTelemetry(undefined, { idle: 1, scheduledEnd: 2, watermark: 3 });
    expect("chatHot" in out).toBe(false);
    expect("chatHotDetail" in out).toBe(false);
    expect(out.chatReclaim).toEqual({ idle: 1, scheduledEnd: 2, watermark: 3 });
  });

  it("chatReclaim 只取三个计数键（不把调用方多塞的字段带进落盘记录）", () => {
    const out = buildChatProcTelemetry([], {
      idle: 1,
      scheduledEnd: 2,
      watermark: 3,
      leaked: 99,
    } as unknown as typeof ZERO);
    expect(Object.keys(out.chatReclaim ?? {}).sort()).toEqual(["idle", "scheduledEnd", "watermark"]);
  });

  it("隐私：明细键白名单——只有 id 与数字 / 布尔，没有路径 / 正文", () => {
    const out = buildChatProcTelemetry(
      [hot("t_x", { runActive: true, backgroundRunning: 1, idleMs: 1000 })],
      ZERO,
      () => 1048576,
    );
    expect(Object.keys(out.chatHotDetail?.[0] ?? {}).sort()).toEqual([
      "agentMB",
      "bg",
      "idleS",
      "run",
      "t",
    ]);
  });
});

describe("buildV8Telemetry：v8.getHeapStatistics() → proc.v8", () => {
  it("五个字段，MB 取整；detachedCtx 是个数不换算", () => {
    expect(
      buildV8Telemetry({
        total_heap_size: 1500 * 1048576,
        total_physical_size: 1400 * 1048576 + 400_000,
        external_memory: 12 * 1048576,
        malloced_memory: 3 * 1048576,
        number_of_detached_contexts: 2,
      }),
    ).toEqual({
      totalHeapMB: 1500,
      physicalMB: 1400,
      externalMB: 12,
      mallocedMB: 3,
      detachedCtx: 2,
    });
  });

  it("字段缺失 / 非有限数 → 按 0（不产生 NaN / undefined 进落盘记录）", () => {
    expect(buildV8Telemetry({})).toEqual({
      totalHeapMB: 0,
      physicalMB: 0,
      externalMB: 0,
      mallocedMB: 0,
      detachedCtx: 0,
    });
    expect(
      buildV8Telemetry({ total_heap_size: Number.NaN, number_of_detached_contexts: Number.POSITIVE_INFINITY }),
    ).toEqual({ totalHeapMB: 0, physicalMB: 0, externalMB: 0, mallocedMB: 0, detachedCtx: 0 });
  });
});

describe("体积：满填的新字段不能把一行记录撑出 4KB 预算", () => {
  it("24 种工具 + 满填 prep / proc（含 4 条热会话明细 + chatReclaim + v8）→ 整行 < 4KB，新增部分 < 700 字节", () => {
    const acc = createRunAccumulator(START);
    for (let i = 0; i < 40; i++) {
      acc.toolDone(`mcp:server.tool_${i}`, 123, i % 5 === 0 ? "error" : "success", 100);
    }
    const bytes = (id: string): number => (id.length % 7) * 1048576 + 1_234_567;
    const chat = buildChatProcTelemetry(
      Array.from({ length: 6 }, (_, i) =>
        hot(`t_1792719260929_qdmuhh${i}`, {
          idleMs: (i + 1) * 61_000,
          runActive: i === 0,
          backgroundRunning: i % 2,
        }),
      ),
      { idle: 12, scheduledEnd: 345, watermark: 6 },
      bytes,
    );
    const v8 = buildV8Telemetry({
      total_heap_size: 3900 * 1048576,
      total_physical_size: 3800 * 1048576,
      external_memory: 123 * 1048576,
      malloced_memory: 45 * 1048576,
      number_of_detached_contexts: 7,
    });
    const procBase = {
      rssMB: 4321,
      heapMB: 3456,
      load1: 12.34,
      uptimeS: 86_400,
      activeRuns: 3,
      eldP99Max: 1234,
      eldMax: 2345,
      eluAvg: 0.97,
      slowSeconds: 12,
      gcMax: 456,
      gcCount: 78,
    };
    const common = {
      snap: acc.snapshot(START + 60_000),
      prep: {
        stages: { resume: 1, mcp: 2, create: 3, prompt: 4, "checkpoint#send": 5 },
        tags: { path: "resume", via: "inject" },
      },
    } as Partial<BuildRecordInput>;
    const without = buildRunRecord(baseInput({ ...common, env: { proc: procBase } }));
    const withNew = buildRunRecord(
      baseInput({ ...common, env: { proc: { ...procBase, ...chat, v8 } } }),
    );
    const sizeWithout = JSON.stringify(without).length;
    const sizeWith = JSON.stringify(withNew).length;
    expect(sizeWith, "整行记录必须仍在 4KB 预算内").toBeLessThan(4096);
    expect(sizeWith - sizeWithout, "新增遥测占用的字节数").toBeLessThan(700);
  });
});

describe("端到端：默认环境快照把热会话 / 回收计数 / V8 堆明细并进落盘的 proc（回归：改前这些字段不存在）", () => {
  type FinishedStatus = "running" | "finished" | "error" | "cancelled";
  const mkRun = () => {
    const listeners = new Set<(s: FinishedStatus) => void>();
    const run = {
      id: "run-1",
      requestId: "req-1",
      status: "running" as FinishedStatus,
      onDidChangeStatus: (l: (s: FinishedStatus) => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      fire: (s: FinishedStatus) => {
        run.status = s;
        for (const l of [...listeners]) l(s);
      },
    };
    return run;
  };

  const collect = async (): Promise<RunPerfRecord> => {
    const records: RunPerfRecord[] = [];
    const t = createRunPerfTracker({
      taskId: "t_e2e",
      agentId: "a_e2e",
      runKind: "chat-followup",
      sink: (r) => records.push(r),
    });
    const run = mkRun();
    t.attachRun(run);
    run.fire("finished");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    return records[0]!;
  };

  it("探针登记 + 有回收计数 → proc 里有 chatHot / chatHotDetail / chatReclaim / v8，类型都对", async () => {
    __setRunPerfEnvProviderForTests(); // 还原默认 provider：本用例就是要走它
    registerChatHotProbe(() => [
      hot("t_hot_a", { idleMs: 61_000 }),
      hot("t_hot_b", { idleMs: 1_000, runActive: true, backgroundRunning: 2 }),
    ]);
    recordChatReclaim("idle");
    recordChatReclaim("scheduled-end");
    recordChatReclaim("scheduled-end");
    recordChatReclaim("watermark");

    const rec = await collect();
    const proc = rec.proc;
    expect(proc, "默认环境快照必须产出 proc").toBeDefined();
    expect(proc?.chatHot).toBe(2);
    // 测试里没开 SDK store → 取不到 agentMB：按空闲从短到长排
    expect(proc?.chatHotDetail).toEqual([
      { t: "t_hot_b", idleS: 1, run: true, bg: 2 },
      { t: "t_hot_a", idleS: 61 },
    ]);
    expect(proc?.chatReclaim).toEqual({ idle: 1, scheduledEnd: 2, watermark: 1 });
    const v8 = proc?.v8;
    expect(v8).toBeDefined();
    for (const key of ["totalHeapMB", "physicalMB", "externalMB", "mallocedMB", "detachedCtx"] as const) {
      expect(typeof v8?.[key], `proc.v8.${key} 应是数字`).toBe("number");
      expect(Number.isFinite(v8?.[key] as number), `proc.v8.${key} 应是有限数`).toBe(true);
    }
    // 原有字段不受影响
    expect(typeof proc?.rssMB).toBe("number");
    expect(typeof proc?.heapMB).toBe("number");
  });

  it("热会话数为 0（会话都已回收）→ 记录里是 chatHot:0（compact 不能把 0 当缺省丢掉）", async () => {
    __setRunPerfEnvProviderForTests();
    registerChatHotProbe(() => []);
    const rec = await collect();
    expect(rec.proc?.chatHot).toBe(0);
    expect(rec.proc && "chatHotDetail" in rec.proc).toBe(false);
  });

  it("探针没登记（chat-runner 还没加载）→ 没有 chatHot / chatHotDetail；chatReclaim 与 v8 仍在", async () => {
    __setRunPerfEnvProviderForTests();
    const rec = await collect();
    expect(rec.proc && "chatHot" in rec.proc).toBe(false);
    expect(rec.proc && "chatHotDetail" in rec.proc).toBe(false);
    expect(rec.proc?.chatReclaim).toEqual(ZERO);
    expect(rec.proc?.v8).toBeDefined();
  });

  it("探针抛错 → 退化成「没登记」，这行记录照常落（观测故障绝不影响主流程）", async () => {
    __setRunPerfEnvProviderForTests();
    registerChatHotProbe(() => {
      throw new Error("probe boom");
    });
    const rec = await collect();
    expect(rec.proc && "chatHot" in rec.proc).toBe(false);
    expect(rec.proc?.rssMB).toBeTypeOf("number");
  });

  it("热会话行畸形（探针没抛、读行里的字段才抛）→ run-perf 外层把遥测整体吞掉，这行记录照常落、原有字段在", async () => {
    // 与上一条的区别：上一条的抛错被 getChatHotSessions 自己的 try/catch 兜住了，走不到 run-perf 外层的 catch；
    // 这里探针正常返回、畸形发生在后面 buildChatProcTelemetry 读字段时，只有外层 catch 能兜住
    __setRunPerfEnvProviderForTests();
    registerChatHotProbe(() => [
      {
        taskId: "t_bad",
        agentId: "a_bad",
        get idleMs(): number {
          throw new Error("bad row");
        },
        runActive: false,
        backgroundRunning: 0,
      },
    ]);
    const rec = await collect();
    expect(rec.proc?.rssMB, "遥测故障不能连累整行记录").toBeTypeOf("number");
    expect(rec.proc && "chatHot" in rec.proc).toBe(false);
  });

  it("热会话明细里有 agentMB：store 句柄在 → run-perf 把「按 agentId 取字节数」交给热会话遥测", async () => {
    __setRunPerfEnvProviderForTests();
    sdkStore.handle = {
      mode: "memory",
      runEvents: "memory",
      dir: TMP_ROOT,
      fast: {
        getStats: () => ({ blobs: 3, bytes: 8 * 1048576 }),
        agentStats: (id: string) => ({
          blobs: 1,
          bytes: id === "agent_t_hot_a" ? 3 * 1048576 : 1048576,
        }),
      },
    };
    registerChatHotProbe(() => [hot("t_hot_a", { idleMs: 5_000 })]);
    const rec = await collect();
    expect(rec.proc?.chatHotDetail, "agentMB 来自 store 句柄").toEqual([
      { t: "t_hot_a", idleS: 5, agentMB: 3 },
    ]);
  });
});
