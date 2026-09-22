import { describe, expect, it } from "vitest";

import {
  buildEventDedupKey,
  buildSideEffectIdempotencyKey,
  BUILTIN_TOOL_FALLBACK_IF_NO_HOOK,
  isCheckpointUsable,
  isSideEffectInterceptCovered,
  shouldDisposeAfterAction,
  summarizeDisposeProbe,
} from "../src/lib/server/mem-governance";

describe("mem-governance① 即用即还判定", () => {
  it("action 终态 + 无 pending → dispose", () => {
    expect(
      shouldDisposeAfterAction({
        lastActionStatus: "completed",
        askPending: false,
        checkInFlight: false,
        questionRun: false,
      }),
    ).toBe(true);
    expect(
      shouldDisposeAfterAction({
        lastActionStatus: "cancelled",
        askPending: false,
        checkInFlight: false,
        questionRun: false,
      }),
    ).toBe(true);
  });

  it("有 pending 则保留热会话", () => {
    expect(
      shouldDisposeAfterAction({
        lastActionStatus: "completed",
        askPending: true,
        checkInFlight: false,
        questionRun: false,
      }),
    ).toBe(false);
    expect(
      shouldDisposeAfterAction({
        lastActionStatus: "completed",
        askPending: false,
        checkInFlight: true,
        questionRun: false,
      }),
    ).toBe(false);
  });

  it("awaiting_* / running / error 不在此 dispose", () => {
    for (const s of ["running", "awaiting_ack", "awaiting_user", "error"] as const) {
      expect(
        shouldDisposeAfterAction({
          lastActionStatus: s,
          askPending: false,
          checkInFlight: false,
          questionRun: false,
        }),
      ).toBe(false);
    }
  });

  it("questionRun 永不 dispose", () => {
    expect(
      shouldDisposeAfterAction({
        lastActionStatus: "completed",
        askPending: false,
        checkInFlight: false,
        questionRun: true,
      }),
    ).toBe(false);
  });
});

describe("mem-governance② 意图日志 / 去重键", () => {
  it("幂等键 = task:action:toolCall", () => {
    expect(
      buildSideEffectIdempotencyKey({
        taskId: "t1",
        actionId: "a1",
        toolCallId: "c1",
      }),
    ).toBe("t1:a1:c1");
  });

  it("事件去重键 = agent:run:seq", () => {
    expect(buildEventDedupKey("ag", "run-1", 7)).toBe("ag:run-1:7");
  });
});

describe("mem-governance② checkpoint 跨表校验", () => {
  it("四表齐全才可用", () => {
    expect(
      isCheckpointUsable({
        agentId: "ag",
        checkpointId: "cp",
        tablesPresent: { agents: true, checkpoints: true, blobs: true, runs: true },
      }),
    ).toBe(true);
    expect(
      isCheckpointUsable({
        agentId: "ag",
        checkpointId: "cp",
        tablesPresent: { agents: true, checkpoints: true, blobs: false, runs: true },
      }),
    ).toBe(false);
  });
});

describe("mem-governance 实验 A 归档", () => {
  it("三级全释放才算过", () => {
    expect(
      summarizeDisposeProbe([
        { level: "agent", released: true },
        { level: "executor", released: true },
        { level: "store", released: true },
      ]).allReleased,
    ).toBe(true);
    const r = summarizeDisposeProbe([
      { level: "agent", released: true },
      { level: "executor", released: true },
      { level: "store", released: false, dominator: "SQLiteDriver" },
    ]);
    expect(r.allReleased).toBe(false);
    expect(r.leakedLevels).toEqual(["store"]);
  });
});

describe("mem-governance② 内置工具拦截点（P2-1，实验 B 检查项；P3-3 分级修正）", () => {
  it("只看 bash：bash 可拦截即覆盖，read/write/edit 不设门槛", () => {
    expect(
      isSideEffectInterceptCovered([
        { tool: "bash", interceptable: true },
        { tool: "read", interceptable: true },
        { tool: "write", interceptable: true },
        { tool: "edit", interceptable: true },
      ]),
    ).toBe(true);
    // read 不可拦是无害情形（本地文件走 checkpoint 恢复），不触发兜底
    expect(
      isSideEffectInterceptCovered([
        { tool: "bash", interceptable: true },
        { tool: "read", interceptable: false },
        { tool: "write", interceptable: true },
        { tool: "edit", interceptable: true },
      ]),
    ).toBe(true);
    // bash 不可拦截 → 未覆盖，必须走兜底、不许静默跳过
    expect(
      isSideEffectInterceptCovered([
        { tool: "bash", interceptable: false },
        { tool: "read", interceptable: true },
        { tool: "write", interceptable: true },
        { tool: "edit", interceptable: true },
      ]),
    ).toBe(false);
  });

  it("bash 已禁用/收编即算覆盖（兜底本身就是设计保证）", () => {
    expect(
      isSideEffectInterceptCovered(
        [{ tool: "bash", interceptable: false }],
        { bashDisabledOrAdopted: true },
      ),
    ).toBe(true);
  });

  it("无 hook 兜底方向已定：禁用 bash / 收编自研工具", () => {
    expect(BUILTIN_TOOL_FALLBACK_IF_NO_HOOK).toBe(
      "disable-bash-and-adopt-self-developed-tools",
    );
  });
});
