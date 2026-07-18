/**
 * R26 sink 层基建单测（第二十六轮·基建波）
 *
 * 五组：commitIfLease 拒写 / appendEventIf 队内拒写 / cancelPendingIf 不误删 B /
 * installSessionIfCurrent 失效不装 / shell delta gate。
 * 不做业务接线矩阵（ownership-r26-matrix 由另一代理写）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { InteractionUpdate } from "@cursor/sdk";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r26-sinks-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const taskFsCore = await import("@/lib/server/task-fs-core");
const { appendEventLine, prepareMetaWrite, readEvents, readMetaV06, writeMeta } =
  taskFsCore;
const {
  appendEvent,
  setTaskRunStatusIfRunOwner,
} = await import("@/lib/server/task-fs");
const {
  agentSessions,
  allocTaskRunInstanceId,
  publishIfCurrent,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  cancelPendingIf,
  cleanupChatTaskState,
  getExpectedCallerToken,
  getPendingAsk,
  registerPendingAsk,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { installSessionIfCurrent } = await import("@/lib/server/task-runner");
const { createShellOutputDeltaPublisher } = await import(
  "@/lib/server/shell-output-bridge"
);

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r26-sinks ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_a",
    actions: [
      {
        id: "act_a",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: "actions/1-plan.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 挂起 failpoint：命中后等 release */
const installHangingFailpoint = (name: string) => {
  let hitResolve!: () => void;
  const hit = new Promise<void>((r) => {
    hitResolve = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hitResolve();
    await gate;
  });
  return {
    waitHit: () => hit,
    release: () => release(),
  };
};

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("ownership-r26-sinks", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r26s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    clearFailpoints();
  });

  afterEach(() => {
    clearFailpoints();
    for (const id of ids.splice(0)) {
      cleanupChatTaskState(id);
      agentSessions.delete(id);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 1) commitIfLease：metaCommit.beforeRename 窗口失主 → 拒 rename
  // ─────────────────────────────────────────────────────────────
  it("R26-5 commitIfLease：failpoint 后 finalGuard false → 不 rename、盘上不变", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    expect((await readMetaV06(id))?.runStatus).toBe("running");

    let owner = true;
    const hang = installHangingFailpoint("metaCommit.beforeRename");
    const p = setTaskRunStatusIfRunOwner(
      id,
      "idle",
      () => owner,
      null,
      "running",
    );
    await hang.waitHit();
    // 权威窗口：failpoint 已过、rename 未发起——此时翻 lease
    owner = false;
    hang.release();
    const result = await p;
    expect(result).toBeNull();
    const disk = await readMetaV06(id);
    expect(disk?.runStatus).toBe("running");
    expect(disk?.currentActionId).toBe("act_a");
  });

  // ─────────────────────────────────────────────────────────────
  // 2) appendEventIf：队内 lease 拒写
  // ─────────────────────────────────────────────────────────────
  it("R26-5 appendEventIf：event.inQueue 窗口 lease 翻 false → 不落盘", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 先占住链：挂起第一条，第二条入队后才验 lease
    const hang = installHangingFailpoint("event.inQueue");
    let leaseOk = true;

    const pBlocker = appendEventLine(id, {
      id: "ev_blocker",
      ts: Date.now(),
      kind: "info",
      text: "blocker",
    });
    await hang.waitHit();

    // 第二条已入队；释放前翻 lease，队内检查应拒写
    const pTarget = appendEvent(
      id,
      { kind: "info", text: "should-not-land" },
      () => leaseOk,
    );
    await sleep(30);
    leaseOk = false;
    hang.release();
    await pBlocker;
    const wrote = await pTarget;
    expect(wrote).toBeNull();
    const events = await readEvents(id);
    expect(events.some((e) => e.text === "should-not-land")).toBe(false);
    expect(events.some((e) => e.text === "blocker")).toBe(true);
  });

  it("R26-5 publishIfCurrent：lease false 不 publish", () => {
    const id = alloc();
    const seen: string[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "error") seen.push(ev.message);
    });
    expect(
      publishIfCurrent(id, () => false, {
        kind: "error",
        message: "nope",
      }),
    ).toBe(false);
    expect(seen).toHaveLength(0);
    expect(
      publishIfCurrent(id, () => true, {
        kind: "error",
        message: "yes",
      }),
    ).toBe(true);
    expect(seen).toEqual(["yes"]);
    unsub();
  });

  // ─────────────────────────────────────────────────────────────
  // 3) cancelPendingIf：不误删 B
  // ─────────────────────────────────────────────────────────────
  it("R26-3 cancelPendingIf：askId 不匹配则不动 B 的 pending", () => {
    const id = alloc();
    const askA = registerPendingAsk(id, {
      askId: "ask_a",
      questions: [{ id: "q1", question: "A?", allowText: true }],
    });
    expect(askA.askId).toBe("ask_a");
    // B 顶掉 A
    const askB = registerPendingAsk(id, {
      askId: "ask_b",
      questions: [{ id: "q1", question: "B?", allowText: true }],
    });
    expect(getPendingAsk(id)?.askId).toBe("ask_b");
    // 旧 A 反登记不得删 B
    expect(cancelPendingIf(id, "ask_a")).toBe(false);
    expect(getPendingAsk(id)?.askId).toBe(askB.askId);
    // 匹配才删
    expect(cancelPendingIf(id, "ask_b")).toBe(true);
    expect(getPendingAsk(id)).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────
  // 4) installSessionIfCurrent：lease 失效不装
  // ─────────────────────────────────────────────────────────────
  it("R26-2 installSessionIfCurrent：lease false → session/bridge 都不装", () => {
    const id = alloc();
    const handler = vi.fn(async () => ({ ok: true as const }));
    const notifier = vi.fn(async () => {});
    const token = String(allocTaskRunInstanceId());
    const record = {
      instanceId: allocTaskRunInstanceId(),
      agent: {
        agentId: "agent_r26",
        send: async () => ({}),
        close: () => {},
      },
      agentId: "agent_r26",
      callerToken: token,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: id },
    };
    const ok = installSessionIfCurrent(
      () => false,
      id,
      record,
      { taskActionHandler: handler, awaitingNotifier: notifier },
      token,
    );
    expect(ok).toBe(false);
    expect(agentSessions.has(id)).toBe(false);
    expect(getExpectedCallerToken(id)).toBeNull();

    // lease true → 原子装上
    const ok2 = installSessionIfCurrent(
      () => true,
      id,
      record,
      { taskActionHandler: handler, awaitingNotifier: notifier },
      token,
    );
    expect(ok2).toBe(true);
    expect(agentSessions.get(id)?.agentId).toBe("agent_r26");
    expect(getExpectedCallerToken(id)).toBe(token);
    // 清理：卸 bridge（install 写的）
    setChatTaskActionHandler(id, null);
    setChatAwaitingNotifier(id, null);
  });

  // ─────────────────────────────────────────────────────────────
  // 5) shell delta gate
  // ─────────────────────────────────────────────────────────────
  it("R26-6 shell delta：lease 失效则 flush 不 publish", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    let leaseOk = true;
    const chunks: string[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "event" && ev.event.kind === "tool_output_delta") {
        const c = ev.event.meta?.chunk;
        if (typeof c === "string") chunks.push(c);
      }
    });
    const onDelta = createShellOutputDeltaPublisher(id, () => leaseOk);

    // 启动 shell + 灌大块触发 flush（≥2KB）
    onDelta({
      update: {
        type: "tool-call-started",
        callId: "call_shell_1",
        toolCall: { type: "shell" },
      } as InteractionUpdate,
    });
    const big = "x".repeat(2500);
    onDelta({
      update: {
        type: "shell-output-delta",
        event: { case: "stdout", value: { data: big } },
      } as InteractionUpdate,
    });
    expect(chunks.length).toBeGreaterThan(0);
    chunks.length = 0;

    // 失主后再灌——不得再 publish
    leaseOk = false;
    onDelta({
      update: {
        type: "shell-output-delta",
        event: { case: "stdout", value: { data: "late-after-takeover" } },
      } as InteractionUpdate,
    });
    // 强制完成态 flush
    onDelta({
      update: {
        type: "tool-call-completed",
        callId: "call_shell_1",
      } as InteractionUpdate,
    });
    await sleep(20);
    expect(chunks).toHaveLength(0);
    unsub();
  });

  it("prepareMetaWrite.commit 无 finalGuard 仍可 rename（writeMeta 管道）", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    meta.runStatus = "idle";
    const prepared = await prepareMetaWrite(meta);
    const ok = await prepared.commit();
    expect(ok).toBe(true);
    expect((await readMetaV06(id))?.runStatus).toBe("idle");
  });
});
