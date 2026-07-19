/**
 * R29 交叉审查修复·事件与 ask 管道
 *
 * ① route 层用户回答事件与并发 writeEventAndPublish → SSE 序 = 磁盘序
 * ② notify mismatch / 无 notifier → pendingAsk 反登记、工具返错误（非 ASK_SUBMITTED）
 * ③ lease 拒绝路径不烧 seq（连续两个成功事件 seq 连续）
 * ④ onCommitted 抛错不断链（后续事件正常落盘 publish）
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r29-pipeline-"),
);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const {
  appendEventLine,
  clearEventSeqCounter,
  readEvents,
  taskDir,
  writeMeta,
} = await import("@/lib/server/task-fs-core");
const { listTasks } = await import("@/lib/server/task-fs");
const {
  agentSessions,
  allocTaskRunInstanceId,
  subscribeTaskStream,
  writeEventAndPublish,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getPendingAsk,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { dispatchAskUserForTest } = await import("@/lib/server/chat-mcp");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r29-pipeline DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r29 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const raceExpectSettled = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
  const result = await Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`Promise 未在 ${ms}ms 内 settle`);
    }),
  ]);
  return result as T;
};

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
  return { waitHit: () => hit, release: () => release() };
};

describe("ownership-r29-pipeline（事件 publish / ask 反登记 / seq）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r29_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  afterEach(() => {
    clearFailpoints();
    for (const id of ids) {
      agentSessions.delete(id);
      cleanupChatTaskState(id);
      clearEventSeqCounter(id);
    }
    ids.length = 0;
  });

  // ─────────────────────────────────────────────────────────────
  // ① R29-1：route 层用户回答事件与并发 write → SSE = 磁盘序
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-1：模拟 ask-reply 用户回答事件与并发 writeEventAndPublish → SSE 序 = 磁盘序",
    async () => {
      // 旧 bug：route 先 appendEvent 再 publishTaskStreamEvent——await meta touch
      // 期间 B 可先 publish → 磁盘 A→B、SSE B→A。现统一 writeEventAndPublish。
      const id = alloc();
      await writeMeta(makeMeta(id));

      const sseTexts: string[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "event") sseTexts.push(String(ev.event.text));
      });

      // A：模拟 ask-reply 落盘的用户回答（与 route 同入口）
      const hang = installHangingFailpoint("metaCommit.beforeRename");
      const pA = writeEventAndPublish(id, {
        kind: "ask_user_reply",
        text: "r29-1-ask-reply-A",
        meta: { askId: "ask_r29_1", answers: [] },
      });
      await hang.waitHit();
      const evA = await raceExpectSettled(pA, 5000);
      expect(evA).not.toBeNull();
      expect(sseTexts).toEqual(["r29-1-ask-reply-A"]);

      // B：并发系统/agent 事件——不得反序
      const evB = await raceExpectSettled(
        writeEventAndPublish(id, { kind: "info", text: "r29-1-concurrent-B" }),
        5000,
      );
      expect(evB).not.toBeNull();
      expect(sseTexts).toEqual(["r29-1-ask-reply-A", "r29-1-concurrent-B"]);

      hang.release();
      await sleep(40);
      unsub();

      const disk = await readEvents(id);
      const marked = disk
        .filter(
          (e) =>
            e.text === "r29-1-ask-reply-A" || e.text === "r29-1-concurrent-B",
        )
        .map((e) => e.text);
      expect(marked).toEqual(["r29-1-ask-reply-A", "r29-1-concurrent-B"]);
      expect(sseTexts).toEqual(marked);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② R29-2：notify 未送达 → 反登记 + 错误文案
  // ─────────────────────────────────────────────────────────────
  it("R29-2：无 notifier 时 ask_user 反登记 pending、返错误非 ASK_SUBMITTED", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const token = String(allocTaskRunInstanceId());
    // 只挂 handler 保 token、不挂 notifier → safeNotify 早退 false
    setChatTaskActionHandler(
      id,
      async () => ({ ok: true as const }),
      token,
    );

    const result = await dispatchAskUserForTest({
      taskId: id,
      callerToken: token,
      actionId: "act_r29",
      questions: [{ id: "q1", question: "R29-2 无 notifier？", allowText: true }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("任务已被接管/通知失败、请重试");
      expect(result.error).not.toContain("ASK_SUBMITTED");
    }
    expect(getPendingAsk(id)).toBeNull();
  });

  it("R29-2：错 token 入口拒（无 pending）；清 notifier 后反登记", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const tokenA = String(allocTaskRunInstanceId());
    const tokenB = String(allocTaskRunInstanceId());
    setChatTaskActionHandler(
      id,
      async () => ({ ok: true as const }),
      tokenA,
    );
    setChatAwaitingNotifier(id, async () => "accepted" as const, tokenA);

    // 入口 mismatch：不登记 pending（R24-6 既有）
    const rejected = await dispatchAskUserForTest({
      taskId: id,
      callerToken: tokenB,
      questions: [{ id: "q1", question: "错 token？", allowText: true }],
    });
    expect(rejected).toEqual({ ok: false, error: CALLER_MISMATCH_ERROR });
    expect(getPendingAsk(id)).toBeNull();

    // 合法 token、但 notifier 已清 → register 后 notify 早退 → 反登记
    setChatAwaitingNotifier(id, null);
    const noNotifier = await dispatchAskUserForTest({
      taskId: id,
      callerToken: tokenA,
      questions: [{ id: "q1", question: "notifier 被清？", allowText: true }],
    });
    expect(noNotifier).toEqual({
      ok: false,
      error: "任务已被接管/通知失败、请重试",
    });
    expect(getPendingAsk(id)).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────
  // ③ R29-3：lease 拒绝不烧 seq
  // ─────────────────────────────────────────────────────────────
  it("R29-3：lease 拒绝路径不烧 seq、后续两事件 seq 连续", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    const rejected = await writeEventAndPublish(
      id,
      { kind: "info", text: "r29-3-rejected" },
      () => false,
    );
    expect(rejected).toBeNull();

    const e1 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r29-3-ok-1",
    });
    const e2 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r29-3-ok-2",
    });
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    expect(e2!.seq! - e1!.seq!).toBe(1);

    const disk = await readEvents(id);
    expect(disk.some((e) => e.text === "r29-3-rejected")).toBe(false);
    const marked = disk.filter(
      (e) => e.text === "r29-3-ok-1" || e.text === "r29-3-ok-2",
    );
    expect(marked.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("R29-6：cleanupChatTaskState 后 seq 严格递增（不再重号）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const e1 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r29-6-before-cleanup",
    });
    expect(e1?.seq).toBe(1);
    cleanupChatTaskState(id);
    // R29-6：stop/cleanup 不清 counter——下一条必须严格大于 durable 尾
    const e2 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r29-6-after-cleanup",
    });
    expect(e2?.seq).toBeGreaterThan(e1!.seq!);
  });

  // ─────────────────────────────────────────────────────────────
  // ④ R29：onCommitted 抛错不断链
  // ─────────────────────────────────────────────────────────────
  it(
    "R29：onCommitted 抛错不断 append 链、后续事件正常落盘 publish",
    async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));

      const sseTexts: string[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "event") sseTexts.push(String(ev.event.text));
      });

      const boomEv: TaskEvent = {
        id: "e_r29_boom",
        ts: Date.now(),
        kind: "info",
        text: "r29-onCommitted-boom",
      };
      // 直接走 appendEventLine：onCommitted 抛错不得 reject 整链
      const okBoom = await appendEventLine(id, boomEv, undefined, () => {
        throw new Error("R29 onCommitted 故意抛错");
      });
      expect(okBoom).toBe(true);
      expect(boomEv.seq).toBe(1);

      // 后续 writeEventAndPublish 仍应落盘 + publish
      const e2 = await raceExpectSettled(
        writeEventAndPublish(id, {
          kind: "info",
          text: "r29-onCommitted-after",
        }),
        5000,
      );
      expect(e2).not.toBeNull();
      expect(e2?.seq).toBe(2);
      expect(sseTexts).toContain("r29-onCommitted-after");

      unsub();
      const disk = await readEvents(id);
      const texts = disk
        .filter(
          (e) =>
            e.text === "r29-onCommitted-boom" ||
            e.text === "r29-onCommitted-after",
        )
        .map((e) => e.text);
      expect(texts).toEqual([
        "r29-onCommitted-boom",
        "r29-onCommitted-after",
      ]);
    },
    15_000,
  );
});
