import { describe, expect, it } from "vitest";

import { shouldDisposeAfterAction } from "../src/lib/server/mem-governance";

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

  it("无 action（lastActionStatus 缺省）不 dispose", () => {
    expect(
      shouldDisposeAfterAction({
        askPending: false,
        checkInFlight: false,
        questionRun: false,
      }),
    ).toBe(false);
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
