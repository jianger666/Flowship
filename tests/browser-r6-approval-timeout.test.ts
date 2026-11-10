/**
 * R6-33：会在主进程弹 evaluate 审批卡的工具，server 本地超时必须比审批等待（120s）长。
 *
 * 之前的洞：`browser_evaluate` 早就给了 `timeoutMs = 120s + slack`，但同样走 `ensureEvaluateApproval` 的三个工具没给——
 *   · `browser_perf heap_snapshot`、`browser_network_rules mock`（html / js 等需审批类型）、`browser_debug set_breakpoint{condition}` / `scope`
 * 用的是 bridge 默认的 60 秒。用户 60–120 秒之间点了「允许」也没用：server 在 60 秒时已发 `cancel` 把审批卡撤了，AI 收到的是「超时」而不是用户的决定。
 * 口径（src/lib/server/browser/approval-timeout.ts）：总闸开着 → 一定免审批 → 默认超时；总闸关着 → 可能弹审批的 action 加长（审批 120s + 动作预算 + slack 15s），
 * 不弹审批的 action 保持默认。server 不知道「本任务是否已批准过」（那是主进程会话态），所以总闸关时对这些 action 一律加长——代价只是主进程真卡死时多等一会儿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BROWSER_DEFAULT_REQUEST_TIMEOUT_MS } from "@/lib/server/browser/bridge";
import {
  APPROVAL_ACTION_BUDGET_MS,
  approvalAwareTimeoutMs,
  approvalBridgeTimeoutMs,
  DEBUG_SCOPE_ACTION_BUDGET_MS,
  EVALUATE_APPROVAL_WAIT_MS,
  HEAP_SNAPSHOT_ACTION_BUDGET_MS,
  WAITING_SLACK_MS,
} from "@/lib/server/browser/approval-timeout";
import { __resetBrowserSettingsForTest } from "@/lib/server/browser/settings";
import { getBrowserTools } from "@/lib/server/browser/tools";
import { PERF_TOOL_ACTIONS } from "@/lib/server/browser/tools-perf";
import type { FlowshipToolDef } from "@/lib/server/flowship-tools";

import { EVALUATE_PROMPT_TIMEOUT_MS } from "../electron-app/browser/evaluate-approval.mjs";
import { installFakeBrowser, NEVER, type FakeBrowser } from "./helpers/browser-bridge-fake";

const TASK = "task-r6-33";
let fake: FakeBrowser | null = null;

const tool = (name: string): FlowshipToolDef => {
  const t = getBrowserTools({ taskId: TASK }).find((x) => x.name === name);
  if (!t) throw new Error(`工具 ${name} 未注册`);
  return t;
};
const call = (name: string, args: Record<string, unknown>) => tool(name).handler(args, "caller-token", { taskId: TASK });

beforeEach(() => {
  __resetBrowserSettingsForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 假主进程：所有 op 都有个能返回的应答；request 被 spy，逐次记录 { op, timeoutMs } */
const withBrowser = (handlers: Record<string, (a: Record<string, unknown>) => unknown> = {}) => {
  fake = installFakeBrowser({
    status: () => ({ exists: true, pendingCount: 0 }),
    perf: () => ({ action: "heap_snapshot", tabId: "t1", file: "heap-x.heapsnapshot", bytes: 10, summary: null }),
    net_rules: (a) => ({ tabId: "t1", action: a.action, rule: { id: "r1", action: a.action, pattern: a.pattern }, count: 1, limit: 20, rules: [], removed: 0 }),
    debug: (a) => ({ action: a.action, paused: false }),
    evaluate: () => ({ type: "number", value: 1 }),
    ...handlers,
  } as Parameters<typeof installFakeBrowser>[0]);
  const spy = vi.spyOn(fake.bridge, "request");
  /** 某个 op 的所有请求的 timeoutMs（undefined = 走 bridge 默认 60s） */
  const timeouts = (op: string): Array<number | undefined> => spy.mock.calls.filter((c) => c[1] === op).map((c) => (c[3] as { timeoutMs?: number } | undefined)?.timeoutMs);
  return { spy, timeouts };
};
const gate = (on: boolean) => __resetBrowserSettingsForTest({ evaluateEnabled: on });

describe("R6-33·常量对账（防漂移）", () => {
  it("server 的审批等待 = 主进程 evaluate 审批卡的等待上限（120s），且比 bridge 默认超时长——这正是本条要修的缺口", () => {
    expect(EVALUATE_APPROVAL_WAIT_MS).toBe(EVALUATE_PROMPT_TIMEOUT_MS);
    expect(BROWSER_DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThan(EVALUATE_APPROVAL_WAIT_MS);
  });

  it("approvalBridgeTimeoutMs = 审批等待 + 动作预算 + slack；heap_snapshot 的口径 ≥ 300s", () => {
    expect(approvalBridgeTimeoutMs()).toBe(EVALUATE_APPROVAL_WAIT_MS + APPROVAL_ACTION_BUDGET_MS + WAITING_SLACK_MS);
    expect(approvalBridgeTimeoutMs(HEAP_SNAPSHOT_ACTION_BUDGET_MS)).toBeGreaterThanOrEqual(300_000);
    expect(approvalBridgeTimeoutMs(DEBUG_SCOPE_ACTION_BUDGET_MS)).toBeGreaterThan(approvalBridgeTimeoutMs(APPROVAL_ACTION_BUDGET_MS));
    // 任何动作预算下，本地超时都严格长于审批等待（否则又会在用户还在决定时先撤卡）
    for (const b of [0, 1, APPROVAL_ACTION_BUDGET_MS, DEBUG_SCOPE_ACTION_BUDGET_MS, HEAP_SNAPSHOT_ACTION_BUDGET_MS]) {
      expect(approvalBridgeTimeoutMs(b)).toBeGreaterThan(EVALUATE_APPROVAL_WAIT_MS + WAITING_SLACK_MS - 1);
    }
  });

  it("approvalAwareTimeoutMs：总闸开 → undefined（默认）；总闸关 → 加长", () => {
    expect(approvalAwareTimeoutMs({ evaluateEnabled: true })).toBeUndefined();
    expect(approvalAwareTimeoutMs({ evaluateEnabled: true, actionBudgetMs: HEAP_SNAPSHOT_ACTION_BUDGET_MS })).toBeUndefined();
    expect(approvalAwareTimeoutMs({ evaluateEnabled: false })).toBe(approvalBridgeTimeoutMs());
    expect(approvalAwareTimeoutMs({ evaluateEnabled: false, actionBudgetMs: HEAP_SNAPSHOT_ACTION_BUDGET_MS })).toBe(approvalBridgeTimeoutMs(HEAP_SNAPSHOT_ACTION_BUDGET_MS));
  });
});

describe("R6-33·browser_evaluate（既有口径，作对照）", () => {
  it("总闸关：120s 审批 + slack = 135s", async () => {
    const { timeouts } = withBrowser();
    gate(false);
    await call("browser_evaluate", { expression: "1" });
    expect(timeouts("evaluate")).toEqual([EVALUATE_APPROVAL_WAIT_MS + WAITING_SLACK_MS]);
    expect(EVALUATE_APPROVAL_WAIT_MS + WAITING_SLACK_MS).toBe(135_000);
  });
});

describe("R6-33·browser_perf", () => {
  it("heap_snapshot：总闸关 → ≥300s（审批 120s + 取快照 180s + slack）；总闸开 → 默认超时", async () => {
    const { timeouts } = withBrowser();
    gate(false);
    await call("browser_perf", { action: "heap_snapshot" });
    gate(true);
    await call("browser_perf", { action: "heap_snapshot" });
    const [off, on] = timeouts("perf");
    expect(off).toBeGreaterThanOrEqual(300_000);
    expect(off).toBe(approvalBridgeTimeoutMs(HEAP_SNAPSHOT_ACTION_BUDGET_MS));
    expect(on).toBeUndefined();
  });

  it("其它 action 永远不弹审批：不管总闸开关都保持默认超时（只有 heap_snapshot 加长，不是整个工具加长）", async () => {
    const { timeouts } = withBrowser({ perf: (a) => ({ action: a.action }) });
    for (const on of [false, true]) {
      gate(on);
      for (const action of PERF_TOOL_ACTIONS.filter((x) => x !== "heap_snapshot")) await call("browser_perf", { action });
    }
    const seen = timeouts("perf");
    expect(seen.length).toBeGreaterThanOrEqual(6); // 真的发出过请求（不是参数校验全挡掉导致的空转）
    for (const t of seen) expect(t).toBeUndefined();
  });

  it("行为：总闸关时 heap_snapshot 挂着等用户批准，60s 时 server 不会撤卡（cancel）；对照：总闸开的同一个 op 在 60s 超时并发 cancel", async () => {
    vi.useFakeTimers();
    withBrowser({ perf: () => NEVER as never });
    gate(false);
    const pending = call("browser_perf", { action: "heap_snapshot" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fake!.other.filter((m) => m.kind === "cancel")).toHaveLength(0); // 审批还在等，不能撤
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake!.other.filter((m) => m.kind === "cancel")).toHaveLength(1); // 终究有上限
    await pending;

    gate(true);
    const before = fake!.other.filter((m) => m.kind === "cancel").length;
    const p2 = call("browser_perf", { action: "heap_snapshot" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fake!.other.filter((m) => m.kind === "cancel").length).toBe(before + 1);
    await p2;
  });
});

describe("R6-33·browser_network_rules", () => {
  const base = { pattern: "https://a.test/*" };

  it("mock：总闸关 → 审批 120s + 创建 15s + slack 15s = 150s；总闸开 → 默认", async () => {
    const { timeouts } = withBrowser();
    gate(false);
    await call("browser_network_rules", { action: "mock", ...base, body: "<b>x</b>", content_type: "text/html" });
    gate(true);
    await call("browser_network_rules", { action: "mock", ...base, body: "<b>x</b>", content_type: "text/html" });
    const [off, on] = timeouts("net_rules");
    expect(off).toBe(150_000);
    expect(off).toBeGreaterThan(EVALUATE_APPROVAL_WAIT_MS);
    expect(on).toBeUndefined();
  });

  it("mock 一律按「可能弹审批」处理（server 不复刻主进程的类型判定）：即使是 json 这种免审批类型，总闸关时也用长超时（已知取舍：免审批类型的 mock 在主进程卡死时多等 90s）", async () => {
    const { timeouts } = withBrowser();
    gate(false);
    await call("browser_network_rules", { action: "mock", ...base, body: "{}", content_type: "application/json" });
    expect(timeouts("net_rules")).toEqual([150_000]);
  });

  it("block / set_headers / fail / delay / list / clear 不弹审批：保持默认超时（总闸开关都一样）", async () => {
    const { timeouts } = withBrowser();
    for (const on of [false, true]) {
      gate(on);
      await call("browser_network_rules", { action: "block", ...base });
      await call("browser_network_rules", { action: "set_headers", ...base, headers: [{ name: "X-A", value: "1" }] });
      await call("browser_network_rules", { action: "fail", ...base });
      await call("browser_network_rules", { action: "delay", ...base, delay_ms: 100 });
      await call("browser_network_rules", { action: "list" });
      await call("browser_network_rules", { action: "clear" });
    }
    const seen = timeouts("net_rules");
    expect(seen).toHaveLength(12);
    for (const t of seen) expect(t).toBeUndefined();
  });
});

describe("R6-33·browser_debug", () => {
  const bp = { action: "set_breakpoint", url: "https://a.test/x.js", line: 3 };

  it("set_breakpoint{condition}：总闸关 → 审批 120s + 设断点 15s + slack = 150s；总闸开 → 默认；没写 condition（或空串）→ 不弹审批 → 默认", async () => {
    const { timeouts } = withBrowser();
    gate(false);
    await call("browser_debug", { ...bp, condition: "x > 1" });
    await call("browser_debug", { ...bp });
    await call("browser_debug", { ...bp, condition: "" });
    gate(true);
    await call("browser_debug", { ...bp, condition: "x > 1" });
    expect(timeouts("debug")).toEqual([150_000, undefined, undefined, undefined]);
  });

  it("scope：总闸关 → 审批 120s + 读变量 30s + slack = 165s；总闸开 → 默认", async () => {
    const { timeouts } = withBrowser();
    gate(false);
    await call("browser_debug", { action: "scope" });
    await call("browser_debug", { action: "scope", frame: 1, depth: 2 });
    gate(true);
    await call("browser_debug", { action: "scope" });
    expect(timeouts("debug")).toEqual([165_000, 165_000, undefined]);
    expect(165_000).toBe(approvalBridgeTimeoutMs(DEBUG_SCOPE_ACTION_BUDGET_MS));
  });

  it("其它 action（remove / list / pause_on_exception / status / step / resume）不弹审批：默认超时，总闸开关都一样", async () => {
    const { timeouts } = withBrowser();
    for (const on of [false, true]) {
      gate(on);
      await call("browser_debug", { action: "remove_breakpoint", id: "bp1" });
      await call("browser_debug", { action: "list_breakpoints" });
      await call("browser_debug", { action: "pause_on_exception", state: "all" });
      await call("browser_debug", { action: "status" });
      await call("browser_debug", { action: "step_over" });
      await call("browser_debug", { action: "step_into" });
      await call("browser_debug", { action: "step_out" });
      await call("browser_debug", { action: "resume" });
    }
    const seen = timeouts("debug");
    expect(seen).toHaveLength(16);
    for (const t of seen) expect(t).toBeUndefined();
  });
});
