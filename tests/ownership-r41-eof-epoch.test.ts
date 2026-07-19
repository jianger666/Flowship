/**
 * R41：R40-2 —— clean EOF 只有 established 后才清 epoch
 *
 * 镜像 useTaskWatch 控制流：watchTaskStream 返回 { established }，
 * 经 resolveWatchCleanEof 决定清零或记 retryable failure。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiRequestError,
  watchTaskStream,
} from "@/lib/task-store";
import {
  classifyWatchHttpStatus,
  resolveWatchCleanEof,
  resolveWatchReconnectPolicy,
  WATCH_MAX_TRANSIENT_FAILURES,
} from "@/lib/task-terminal";
import type { Task } from "@/lib/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stubTask = (id: string): Task =>
  ({
    id,
    title: id,
    mode: "chat",
    runStatus: "idle",
    repoStatus: "idle",
    events: [],
    repoPaths: [],
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Task;

const sseFrame = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

const illegalFrameThenEof = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {not-json\n\n"));
      controller.enqueue(
        new TextEncoder().encode(
          sseFrame({ type: "queue_state", itemIds: [] }),
        ),
      );
      controller.close();
    },
  });

const streamBootstrapThenError = (task: Task, errMsg = "stream dropped") => {
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) {
        step = 1;
        controller.enqueue(
          new TextEncoder().encode(sseFrame({ type: "task", task })),
        );
        return;
      }
      controller.error(new Error(errMsg));
    },
  });
};

const streamBootstrapCleanEof = (task: Task) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(sseFrame({ type: "task", task })),
      );
      controller.close();
    },
  });

/**
 * 镜像 useTaskWatch loop 的一次迭代结果（与 hook 同源：resolveWatchCleanEof）
 */
const runHookLikeOnce = async (
  taskId: string,
  counters: {
    unavailableAttempts: number;
    transientFailures: number;
    unavailableNotified: boolean;
  },
): Promise<{
  counters: typeof counters;
  established: boolean;
  exhausted: boolean;
  terminalDeleted: boolean;
}> => {
  let { unavailableAttempts, transientFailures, unavailableNotified } =
    counters;
  try {
    const { established } = await watchTaskStream(taskId, {
      onConnectionEstablished: () => {
        // reader-error 场景：当场清零（与 hook 一致）
        unavailableAttempts = 0;
        transientFailures = 0;
        unavailableNotified = false;
      },
    });
    const eof = resolveWatchCleanEof({
      established,
      unavailableAttempts,
      transientFailures,
      unavailableNotified,
    });
    if (eof.kind === "epoch_reset") {
      return {
        counters: {
          unavailableAttempts: eof.nextUnavailableAttempts,
          transientFailures: eof.nextTransientFailures,
          unavailableNotified: eof.nextUnavailableNotified,
        },
        established,
        exhausted: false,
        terminalDeleted: false,
      };
    }
    const decision = eof.decision;
    if (decision.action === "terminate_exhausted") {
      return {
        counters: {
          unavailableAttempts,
          transientFailures,
          unavailableNotified,
        },
        established,
        exhausted: true,
        terminalDeleted: false,
      };
    }
    if (decision.action === "retry") {
      return {
        counters: {
          unavailableAttempts: decision.nextUnavailableAttempts,
          transientFailures: decision.nextTransientFailures,
          unavailableNotified: decision.nextUnavailableNotified,
        },
        established,
        exhausted: false,
        terminalDeleted: false,
      };
    }
    return {
      counters: { unavailableAttempts, transientFailures, unavailableNotified },
      established,
      exhausted: false,
      terminalDeleted: false,
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return {
        counters: { unavailableAttempts, transientFailures, unavailableNotified },
        established: false,
        exhausted: false,
        terminalDeleted: false,
      };
    }
    const status =
      err instanceof ApiRequestError
        ? err.status
        : (err as { status?: number }).status;
    const kind =
      typeof status === "number"
        ? classifyWatchHttpStatus(status, { hydratedWatcher: true })
        : "retryable";
    const decision = resolveWatchReconnectPolicy({
      kind,
      unavailableAttempts,
      transientFailures,
      unavailableNotified,
    });
    if (decision.action === "terminate_deleted") {
      return {
        counters: { unavailableAttempts, transientFailures, unavailableNotified },
        established: false,
        exhausted: false,
        terminalDeleted: true,
      };
    }
    if (decision.action === "terminate_exhausted") {
      return {
        counters: { unavailableAttempts, transientFailures, unavailableNotified },
        established: false,
        exhausted: true,
        terminalDeleted: false,
      };
    }
    return {
      counters: {
        unavailableAttempts: decision.nextUnavailableAttempts,
        transientFailures: decision.nextTransientFailures,
        unavailableNotified: decision.nextUnavailableNotified,
      },
      established: false,
      exhausted: false,
      terminalDeleted: false,
    };
  }
};

describe("R41-EOF-① 空 EOF 不得清旧 transient", () => {
  it("1×fetch reject → 200 空 EOF：旧 transient 保留并 +1", async () => {
    const taskId = "r41_eof_reject_empty";
    let counters = {
      unavailableAttempts: 0,
      transientFailures: 0,
      unavailableNotified: false,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    let r = await runHookLikeOnce(taskId, counters);
    expect(r.counters.transientFailures).toBe(1);
    expect(r.established).toBe(false);
    counters = r.counters;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(emptyStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    r = await runHookLikeOnce(taskId, counters);
    expect(r.established).toBe(false);
    // 不得清零旧 #1；空 EOF 再记一次 → #2
    expect(r.counters.transientFailures).toBe(2);
    expect(r.exhausted).toBe(false);
  });
});

describe("R41-EOF-② 连续空流 / 非法帧达 exhausted", () => {
  it("连续 6 次 200 空流 → terminate_exhausted", async () => {
    const taskId = "r41_six_empty";
    let counters = {
      unavailableAttempts: 0,
      transientFailures: 0,
      unavailableNotified: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(emptyStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    let exhausted = false;
    for (let i = 0; i < WATCH_MAX_TRANSIENT_FAILURES; i++) {
      const r = await runHookLikeOnce(taskId, counters);
      counters = r.counters;
      if (r.exhausted) {
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
  });

  it("连续 6 次仅非法帧 EOF → terminate_exhausted", async () => {
    const taskId = "r41_six_illegal";
    let counters = {
      unavailableAttempts: 0,
      transientFailures: 0,
      unavailableNotified: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(illegalFrameThenEof(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    let exhausted = false;
    for (let i = 0; i < WATCH_MAX_TRANSIENT_FAILURES; i++) {
      const r = await runHookLikeOnce(taskId, counters);
      counters = r.counters;
      if (r.exhausted) {
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
  });
});

describe("R41-EOF-③ established 后 clean EOF 才清 epoch", () => {
  it("task bootstrap → clean EOF：清零", async () => {
    const taskId = "r41_boot_clean";
    const task = stubTask(taskId);
    // 先造一次 transient
    const counters = {
      unavailableAttempts: 0,
      transientFailures: 1,
      unavailableNotified: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(streamBootstrapCleanEof(task), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const r = await runHookLikeOnce(taskId, counters);
    expect(r.established).toBe(true);
    expect(r.counters.transientFailures).toBe(0);
    expect(r.counters.unavailableAttempts).toBe(0);
  });

  it("task bootstrap → reader error：从新 transient #1 起算", async () => {
    const taskId = "r41_boot_drop";
    const task = stubTask(taskId);
    const counters = {
      unavailableAttempts: 0,
      transientFailures: 3,
      unavailableNotified: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(streamBootstrapThenError(task), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const r = await runHookLikeOnce(taskId, counters);
    // onConnectionEstablished 清零后 reader error → #1
    expect(r.counters.transientFailures).toBe(1);
    expect(r.exhausted).toBe(false);
  });
});

describe("R41-EOF-④ 7×503 → empty EOF → valid bootstrap 分账", () => {
  it("unavailable/transient 分账、单 loop、最终恢复", async () => {
    const taskId = "r41_combo";
    const task = stubTask(taskId);
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let loopRuns = 0;
    let phase:
      | "unavailable"
      | "empty_eof"
      | "bootstrap_ok" = "unavailable";
    let unavailableLeft = 7;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (phase === "unavailable") {
          return new Response(JSON.stringify({ error: "busy" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (phase === "empty_eof") {
          return new Response(emptyStream(), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response(streamBootstrapCleanEof(task), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    loopRuns += 1;
    let done = false;
    while (!done) {
      const r = await runHookLikeOnce(taskId, {
        unavailableAttempts,
        transientFailures,
        unavailableNotified,
      });
      if (r.terminalDeleted || r.exhausted) break;
      unavailableAttempts = r.counters.unavailableAttempts;
      transientFailures = r.counters.transientFailures;
      unavailableNotified = r.counters.unavailableNotified;

      if (r.established && r.counters.transientFailures === 0) {
        done = true;
        break;
      }

      if (phase === "unavailable") {
        unavailableLeft -= 1;
        if (unavailableLeft <= 0) phase = "empty_eof";
      } else if (phase === "empty_eof") {
        phase = "bootstrap_ok";
      }
    }

    expect(loopRuns).toBe(1);
    expect(done).toBe(true);
    expect(phase).toBe("bootstrap_ok");
    expect(unavailableAttempts).toBe(0);
    expect(transientFailures).toBe(0);
    // 7×503 不应把 transient 耗尽
    expect(unavailableNotified).toBe(false);
  });
});

describe("R41-EOF-⑤ resolveWatchCleanEof 纯函数契约", () => {
  it("established=true → epoch_reset；false → retryable_failure", () => {
    expect(
      resolveWatchCleanEof({
        established: true,
        unavailableAttempts: 3,
        transientFailures: 2,
        unavailableNotified: true,
      }),
    ).toEqual({
      kind: "epoch_reset",
      nextUnavailableAttempts: 0,
      nextTransientFailures: 0,
      nextUnavailableNotified: false,
    });

    const fail = resolveWatchCleanEof({
      established: false,
      unavailableAttempts: 0,
      transientFailures: WATCH_MAX_TRANSIENT_FAILURES - 1,
      unavailableNotified: false,
    });
    expect(fail.kind).toBe("retryable_failure");
    if (fail.kind === "retryable_failure") {
      expect(fail.decision.action).toBe("terminate_exhausted");
    }
  });
});
