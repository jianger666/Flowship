/**
 * run-perf-record（src/lib/server/run-perf-record.ts）单测：累积器 + 记录构建（纯逻辑）
 *
 * 钉死的语义：
 * - 时序全部相对 send 发起；ttft = 首 token − 受理（首 token 早于受理返回则为 0、firstDeltaMs 保留原值）
 * - 只认「第一次」：受理 / 首 token / 首工具
 * - 来自 SDK 的数值不可信（NaN / 负数 / 非数字）：忽略，不污染汇总
 * - 记录里没有 undefined 键、体积有界；字段白名单——新增字段必须先评估隐私影响
 */
import { describe, expect, it } from "vitest";

import {
  buildRunRecord,
  createRunAccumulator,
  type BuildRecordInput,
} from "@/lib/server/run-perf-record";

const START = 1_000_000;

describe("累积器：时序", () => {
  it("各时刻都相对 send 发起；ttft = 首 token − 受理", () => {
    const acc = createRunAccumulator(START);
    acc.accepted(START + 40);
    acc.token("thinking-delta", START + 2_540);
    acc.toolStart(START + 3_000);
    const s = acc.snapshot(START + 9_000);
    expect(s.acceptMs).toBe(40);
    expect(s.firstDeltaMs).toBe(2_540);
    expect(s.firstDeltaType).toBe("thinking-delta");
    expect(s.ttftMs).toBe(2_500);
    expect(s.firstToolMs).toBe(3_000);
    expect(s.totalMs).toBe(9_000);
  });

  it("首 token 早于受理返回（delta 抢在 send resolve 之前）→ ttft=0，firstDeltaMs 保留", () => {
    const acc = createRunAccumulator(START);
    acc.token("text-delta", START + 30);
    acc.accepted(START + 50);
    const s = acc.snapshot(START + 100);
    expect(s.ttftMs).toBe(0);
    expect(s.firstDeltaMs).toBe(30);
    expect(s.acceptMs).toBe(50);
  });

  it("没有 token / 没受理 → 对应字段缺省（不是 0 冒充）", () => {
    const s = createRunAccumulator(START).snapshot(START + 10);
    expect(s.acceptMs).toBeUndefined();
    expect(s.firstDeltaMs).toBeUndefined();
    expect(s.ttftMs).toBeUndefined();
    expect(s.firstToolMs).toBeUndefined();
    expect(s.thinkingMs).toBeUndefined();
    expect(s.tokens).toBeUndefined();
    expect(s.totalMs).toBe(10);
  });

  it("只受理没 token → 有 acceptMs、无 ttft", () => {
    const acc = createRunAccumulator(START);
    acc.accepted(START + 7);
    const s = acc.snapshot(START + 10);
    expect(s.acceptMs).toBe(7);
    expect(s.ttftMs).toBeUndefined();
  });

  it("只认第一次：受理 / 首 token / 首工具", () => {
    const acc = createRunAccumulator(START);
    acc.accepted(START + 10);
    acc.accepted(START + 999);
    acc.token("text-delta", START + 20);
    acc.token("thinking-delta", START + 500);
    acc.toolStart(START + 30);
    acc.toolStart(START + 600);
    const s = acc.snapshot(START + 1000);
    expect(s.acceptMs).toBe(10);
    expect(s.firstDeltaMs).toBe(20);
    expect(s.firstDeltaType).toBe("text-delta");
    expect(s.firstToolMs).toBe(30);
  });

  it("结束时刻早于发起（时钟回拨）→ totalMs 夹到 0", () => {
    expect(createRunAccumulator(START).snapshot(START - 5).totalMs).toBe(0);
  });
});

describe("累积器：工具 / step / thinking / token", () => {
  it("工具按名聚合：次数 / 错误 / 墙钟累计与最大 / sdkExec 累计", () => {
    const acc = createRunAccumulator(START);
    acc.toolDone("shell", 800, "success", 700);
    acc.toolDone("shell", 1_200, "error", 1_100);
    acc.toolDone("read", 300, "success");
    const s = acc.snapshot(START + 1);
    expect(s.toolCount).toBe(3);
    expect(s.toolErrors).toBe(1);
    expect(s.tools.shell).toEqual({ n: 2, errors: 1, wallSum: 2_000, wallMax: 1_200, sdkExecSum: 1_800 });
    expect(s.tools.read).toEqual({ n: 1, errors: 0, wallSum: 300, wallMax: 300 });
    expect("sdkExecSum" in s.tools.read).toBe(false);
  });

  it("工具名种类超 24：新名字归并到 other，已有的继续各自累计", () => {
    const acc = createRunAccumulator(START);
    for (let i = 0; i < 24; i++) acc.toolDone(`t${i}`, 10, "success");
    acc.toolDone("t24", 10, "success");
    acc.toolDone("t25", 10, "error");
    acc.toolDone("t0", 10, "success");
    const s = acc.snapshot(START + 1);
    expect(Object.keys(s.tools)).toHaveLength(25); // 24 + other
    expect(s.tools.other).toMatchObject({ n: 2, errors: 1 });
    expect(s.tools.t0.n).toBe(2);
    expect(s.toolCount).toBe(27);
  });

  it("step：次数 / 累计 / 最大", () => {
    const acc = createRunAccumulator(START);
    acc.step(1_000);
    acc.step(4_000);
    acc.step(2_000);
    const s = acc.snapshot(START + 1);
    expect(s.steps).toBe(3);
    expect(s.stepMsSum).toBe(7_000);
    expect(s.stepMsMax).toBe(4_000);
  });

  it("thinking：多段累加，并记段数", () => {
    const acc = createRunAccumulator(START);
    acc.thinking(3_000);
    acc.thinking(1_500);
    const s = acc.snapshot(START + 1);
    expect(s.thinkingMs).toBe(4_500);
    expect(s.thinkingSegments).toBe(2);
  });

  it("token 用量原样记录、缺项缺省", () => {
    const acc = createRunAccumulator(START);
    acc.usage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 30_000, cacheWriteTokens: 0 });
    expect(acc.snapshot(START + 1).tokens).toEqual({ input: 100, output: 50, cacheRead: 30_000, cacheWrite: 0 });
    const acc2 = createRunAccumulator(START);
    acc2.usage({ inputTokens: 5, reasoningTokens: 9 });
    expect(acc2.snapshot(START + 1).tokens).toEqual({ input: 5, reasoning: 9 });
  });

  it("SDK 给的脏数据（NaN / 负数 / 字符串 / undefined）一律忽略，不污染汇总", () => {
    const acc = createRunAccumulator(START);
    acc.step(Number.NaN);
    acc.step(-5);
    acc.step("7" as unknown as number);
    acc.step(undefined);
    acc.thinking(Number.POSITIVE_INFINITY);
    acc.toolDone("shell", Number.NaN, "success", -1);
    acc.usage({ inputTokens: "9", outputTokens: -1, cacheReadTokens: Number.NaN });
    const s = acc.snapshot(START + 1);
    expect(s.steps).toBe(4); // 步数照记（事实发生过）
    expect(s.stepMsSum).toBe(0);
    expect(s.stepMsMax).toBe(0);
    expect(s.thinkingMs).toBe(0);
    expect(s.tools.shell).toEqual({ n: 1, errors: 0, wallSum: 0, wallMax: 0 });
    expect(s.tokens).toEqual({});
  });
});

const baseInput = (over: Partial<BuildRecordInput> = {}): BuildRecordInput => ({
  now: Date.UTC(2026, 9, 9, 6, 0, 0),
  ctx: { taskId: "t1", agentId: "a1", runKind: "chat-followup" },
  outcome: "finished",
  snap: createRunAccumulator(START).snapshot(START + 5),
  prep: null,
  idleBeforeMs: null,
  warmedAgoMs: null,
  env: {},
  runtime: { platform: "darwin" },
  ...over,
});

describe("buildRunRecord", () => {
  it("最小输入：必要字段齐全、没有 undefined 键、JSON 往返不丢", () => {
    const rec = buildRunRecord(baseInput());
    expect(rec.v).toBe(1);
    expect(rec.ts).toBe("2026-10-09T06:00:00.000Z");
    expect(rec).toMatchObject({ taskId: "t1", kind: "chat-followup", agentId: "a1", outcome: "finished", platform: "darwin", tools: {} });
    for (const [k, v] of Object.entries(rec)) expect(v, `键 ${k}`).not.toBeUndefined();
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  });

  it("idle / 预热为 null 时省略；有值时取整", () => {
    expect("idleBeforeMs" in buildRunRecord(baseInput())).toBe(false);
    expect("warmedAgoMs" in buildRunRecord(baseInput())).toBe(false);
    const rec = buildRunRecord(baseInput({ idleBeforeMs: 1234.7, warmedAgoMs: 0 }));
    expect(rec.idleBeforeMs).toBe(1235);
    expect(rec.warmedAgoMs).toBe(0); // 0 是有效值（刚预热），不能被当成缺省
  });

  it("prep：stages 取整并滤掉非法值；空 stages / tags 省略", () => {
    const rec = buildRunRecord(
      baseInput({
        prep: { stages: { resume: 1234.6, bad: Number.NaN, neg: -3, mcp: 0 }, tags: { path: "resume" } },
      }),
    );
    expect(rec.prep).toEqual({ resume: 1235, mcp: 0 });
    expect(rec.tags).toEqual({ path: "resume" });
    const empty = buildRunRecord(baseInput({ prep: { stages: {}, tags: {} } }));
    expect("prep" in empty).toBe(false);
    expect("tags" in empty).toBe(false);
  });

  it("模型：id 与参数拼成可读串；无参数不写 modelParams", () => {
    const withParams = buildRunRecord(
      baseInput({ ctx: { taskId: "t", agentId: "a", runKind: "k", model: { id: "claude-x", params: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }] } } }),
    );
    expect(withParams.model).toBe("claude-x");
    expect(withParams.modelParams).toBe("thinking=true,effort=high");
    const bare = buildRunRecord(baseInput({ ctx: { taskId: "t", agentId: "a", runKind: "k", model: { id: "m" } } }));
    expect("modelParams" in bare).toBe(false);
  });

  it("requestId 为空串省略；runId 原样", () => {
    const rec = buildRunRecord(baseInput({ run: { id: "r1", requestId: "" } }));
    expect(rec.runId).toBe("r1");
    expect("requestId" in rec).toBe(false);
  });

  it("proc / store 里的非有限数被剔除（缺失的采样不写 NaN）", () => {
    const rec = buildRunRecord(
      baseInput({
        env: {
          proc: { rssMB: 300, heapMB: 100, load1: Number.NaN, uptimeS: 60, activeRuns: 1 },
          store: { mode: "fast", blobs: 10, mb: Number.NaN },
        },
      }),
    );
    expect(rec.proc).toEqual({ rssMB: 300, heapMB: 100, uptimeS: 60, activeRuns: 1 });
    expect(rec.store).toEqual({ mode: "fast", blobs: 10 });
  });

  it("appNap=false 是有效值（实验关着），不能被当缺省丢掉", () => {
    const rec = buildRunRecord(baseInput({ runtime: { platform: "darwin", version: "1.9.28", appNap: false } }));
    expect(rec.appNap).toBe(false);
    expect(rec.version).toBe("1.9.28");
  });

  it("字段白名单（满填）：新增字段必须先评估隐私影响再更新这里", () => {
    const acc = createRunAccumulator(START);
    acc.accepted(START + 10);
    acc.token("text-delta", START + 20);
    acc.toolStart(START + 30);
    acc.toolDone("shell", 100, "success", 90);
    acc.thinking(500);
    acc.step(900);
    acc.usage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 });
    const rec = buildRunRecord({
      now: START + 2_000,
      ctx: {
        taskId: "t1",
        agentId: "a1",
        runKind: "chat-followup",
        promptBytes: 1234,
        promptBudgetDropped: ["skills"],
        model: { id: "m", params: [{ id: "thinking", value: "true" }] },
      },
      run: { id: "r1", requestId: "q1" },
      outcome: "ok",
      snap: acc.snapshot(START + 2_000),
      prep: {
        stages: { resume: 10 },
        tags: { path: "resume" },
        mcp: { total: 1, cacheHits: 1, fresh: 1, stale: 0, probedSync: 0, staleRefreshedInGrace: 0, waitMs: 0 },
      },
      idleBeforeMs: 5,
      warmedAgoMs: 6,
      env: {
        store: { mode: "fast", blobs: 1, mb: 1, agentBlobs: 1, agentMB: 1 },
        proc: { rssMB: 1, heapMB: 1, load1: 1, uptimeS: 1, activeRuns: 1, eldP99Max: 1, eldMax: 1, eluAvg: 1, slowSeconds: 1, gcMax: 1, gcCount: 1 },
      },
      runtime: { platform: "darwin", version: "1.9.28", appNap: true },
    });
    expect(Object.keys(rec).sort()).toEqual(
      [
        "acceptMs", "agentId", "appNap", "firstDeltaMs", "firstDeltaType", "firstToolMs",
        "idleBeforeMs", "kind", "mcp", "model", "modelParams", "outcome", "platform", "prep",
        "promptBudgetDropped", "promptBytes", "proc", "requestId", "runId", "stepMsMax",
        "stepMsSum", "steps", "store", "tags", "taskId", "thinkingMs", "thinkingSegments",
        "tokens", "toolCount", "toolErrors", "tools", "totalMs", "ts", "ttftMs", "v",
        "version", "warmedAgoMs",
      ].sort(),
    );
  });

  it("体积有界：典型的重度 run（24 种工具 + 满填 prep / proc）序列化后 < 4KB", () => {
    const acc = createRunAccumulator(START);
    for (let i = 0; i < 40; i++) acc.toolDone(`mcp:server.tool_${i}`, 123, i % 5 === 0 ? "error" : "success", 100);
    const rec = buildRunRecord(
      baseInput({
        snap: acc.snapshot(START + 60_000),
        prep: { stages: { resume: 1, mcp: 2, create: 3, prompt: 4, "checkpoint#send": 5 }, tags: { path: "resume", via: "inject" } },
        env: { proc: { rssMB: 1, heapMB: 1, load1: 1, uptimeS: 1, activeRuns: 1, eldP99Max: 1, eldMax: 1, eluAvg: 1, slowSeconds: 1, gcMax: 1, gcCount: 1 } },
      }),
    );
    expect(JSON.stringify(rec).length).toBeLessThan(4096);
  });
});
