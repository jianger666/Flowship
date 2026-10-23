/**
 * task 模式「停止」：先把在飞的半截思考 + 正文落盘、再 revoke（审查 BE1-02）。
 *
 * 旧行为：stop 第一步 revokeTaskOps → run 自己的 lease 立刻失主 → 流收尾 flush 整段跳过；
 * 用户停止前已经流给他看的半截回复 / 思考只存在于内存，刷新页面就没了（chat 模式有落盘，两边不一致）。
 *
 * 钉死：
 *   1. flushRunningTaskPartialOutput：同步调起 record 上的 flushPartialOutput（stop 要在 revoke 之前起跑）；
 *      没 run / 没钩子 = no-op；钩子抛错被吞（stop 不能被它拖垮）；
 *   2. 「同步取走 buffer + 固定放行的 lease」确实能让 revoke 之后半截输出仍然落盘，
 *      而旧写法（revoke 之后才用 run 的 lease）一个字都落不了；
 *   3. stop-task / task-runner 的接线顺序（源码契约）。
 */
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-stop-flush-partial-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { getTaskWithTailEvents, listTasks } = await import("@/lib/server/task-fs");
const {
  handleSdkMessage,
  flushAssistantSegment,
  flushThinkingBuffer,
  flushPendingAssistantDeltas,
  discardLiveAssistant,
  discardPendingThinkingDeltas,
} = await import("@/lib/server/sdk-message-handler");
const { flushRunningTaskPartialOutput, runningTasks } = await import("@/lib/server/task-stream");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`stop-flush-partial-output DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void>>)[RECOVERY_FLAG] = Promise.resolve();
await listTasks();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const ids: string[] = [];
const alloc = async (): Promise<string> => {
  const id = `t_sfp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta({
    id,
    title: `stop-flush ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
  return id;
};
afterEach(async () => {
  for (const id of ids.splice(0)) {
    runningTasks.delete(id);
    flushPendingAssistantDeltas(id);
    discardLiveAssistant(id);
    discardPendingThinkingDeltas(id);
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const mkCtx = (): AssistantBufferCtx => ({ buffer: "", flush: async () => {} });
const assistantMsg = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as never;
const thinkingMsg = (text: string) => ({ type: "thinking", text }) as never;
const events = async (id: string) => (await getTaskWithTailEvents(id, 50))!.events;

const fakeRecord = (flush?: () => Promise<void>) => ({
  instanceId: 1,
  agentId: "a",
  startedAt: Date.now(),
  startSnapshot: {} as never,
  cancel: () => {},
  ...(flush ? { flushPartialOutput: flush } : {}),
});

describe("flushRunningTaskPartialOutput", () => {
  it("同步调起 record 上的钩子（stop 要在 revoke 之前起跑，不能被 await 推迟）", () => {
    const id = "t_sync_probe";
    let started = false;
    runningTasks.set(
      id,
      fakeRecord(async () => {
        started = true;
      }),
    );
    try {
      const p = flushRunningTaskPartialOutput(id);
      expect(started).toBe(true); // 调用返回时（未 await）钩子已经跑过同步段
      return p;
    } finally {
      runningTasks.delete(id);
    }
  });

  it("没有 run / 没有钩子：no-op", async () => {
    await expect(flushRunningTaskPartialOutput("t_no_such_run")).resolves.toBeUndefined();
    runningTasks.set("t_no_hook", fakeRecord());
    try {
      await expect(flushRunningTaskPartialOutput("t_no_hook")).resolves.toBeUndefined();
    } finally {
      runningTasks.delete("t_no_hook");
    }
  });

  it("钩子抛错被吞：stop 不能被半截输出的落盘失败拖垮", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runningTasks.set(
      "t_throw",
      fakeRecord(async () => {
        throw new Error("disk full");
      }),
    );
    try {
      await expect(flushRunningTaskPartialOutput("t_throw")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      runningTasks.delete("t_throw");
      warn.mockRestore();
    }
  });
});

describe("revoke 前同步起跑 + 固定放行 lease：半截输出不再随失主丢掉", () => {
  /** 复刻 task-runner 里 flushForStop 的写法（见下面的源码契约） */
  const flushForStop = (id: string, ctx: AssistantBufferCtx) => async () => {
    const always = () => true;
    await Promise.all([
      flushThinkingBuffer(id, ctx, always),
      flushAssistantSegment(id, ctx, always),
    ]);
  };

  it("半截正文：先起跑再失主，仍落盘成 assistant_message（复用预定 id、文本是用户已经看到的）", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    let alive = true;
    await handleSdkMessage(id, assistantMsg("写到一半的回复"), ctx, () => alive);
    flushPendingAssistantDeltas(id);
    const eventId = ctx.assistantEventId!;

    const flushing = flushForStop(id, ctx)(); // stop：先起跑（同步取走 buffer）
    alive = false; // 再 revoke
    await flushing;

    const msg = (await events(id)).find((e) => e.kind === "assistant_message");
    expect(msg?.text).toBe("写到一半的回复");
    expect(msg?.id).toBe(eventId);
  });

  it("同步起跑（评审 R3）：flushForStop() 一返回 promise，正文 / 思考 buffer 就已经取走——不用等任何微任务", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    let alive = true;
    await handleSdkMessage(id, assistantMsg("同步取走的半截"), ctx, () => alive);
    flushPendingAssistantDeltas(id);
    expect(ctx.buffer).toBe("同步取走的半截");

    const flushing = flushForStop(id, ctx)(); // 不 await
    expect(ctx.buffer).toBe(""); // 取走发生在返回之前
    expect(ctx.assistantEventId).toBeUndefined(); // 预定 id 也已随快照清掉
    alive = false;
    await flushing;
    expect((await events(id)).find((e) => e.kind === "assistant_message")?.text).toBe(
      "同步取走的半截",
    );
  });

  it("半截思考：同样落盘成 thinking 事件", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    let alive = true;
    await handleSdkMessage(id, thinkingMsg("想到一半"), ctx, () => alive);

    const flushing = flushForStop(id, ctx)();
    alive = false;
    await flushing;

    const th = (await events(id)).find((e) => e.kind === "thinking");
    expect(th?.text).toBe("想到一半");
  });

  it("对照（旧行为）：先 revoke、之后才用 run 自己的 lease 去 flush → 一个字都落不了", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    let alive = true;
    await handleSdkMessage(id, assistantMsg("会丢的半截"), ctx, () => alive);
    flushPendingAssistantDeltas(id);
    alive = false; // revoke 先发生
    await flushAssistantSegment(id, ctx, () => alive); // 流收尾的 flush：lease 已失主
    expect((await events(id)).some((e) => e.kind === "assistant_message")).toBe(false);
  });
});

describe("接线顺序（源码契约）", () => {
  const read = (rel: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

  it("stop-task：先同步起跑落盘 → revokeTaskOps → invalidateCallerToken（首个 await 之前）→ 再 await 落盘，且在 joinResourceJobs 之前", () => {
    const src = read("src/lib/server/stop-task.ts");
    const start = src.indexOf("const flushingPartial = flushRunningTaskPartialOutput(id);");
    const revoke = src.indexOf("revokeTaskOps(id);", start);
    const invalidate = src.indexOf("invalidateCallerToken(id);", revoke);
    const awaitFlush = src.indexOf("await flushingPartial;", invalidate);
    const join = src.indexOf("await joinResourceJobs(id)", awaitFlush);
    expect(start).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(start);
    expect(invalidate).toBeGreaterThan(revoke);
    expect(awaitFlush).toBeGreaterThan(invalidate);
    expect(join).toBeGreaterThan(awaitFlush);
    // revoke 与 invalidate 之间不能插 await（首个 await 之前同步失效 bridge lease 的既有契约）
    const between = src
      .slice(revoke, invalidate)
      .replace(/\/\/.*$/gm, ""); // 去掉行注释（注释里会提到 await 这个词）
    expect(between).not.toMatch(/\bawait\b/);
  });

  it("task-runner：record 挂 flushPartialOutput；flushForStop 用固定放行 lease、先思考后正文，失主不管", () => {
    const src = read("src/lib/server/task-runner.ts");
    expect(src).toContain("flushPartialOutput: () => flushForStop?.() ?? Promise.resolve(),");
    const at = src.indexOf("flushForStop = async () => {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("if (lostStartOwner()) return;");
    expect(body.indexOf("flushThinkingBuffer(task.id, assistantCtx, always)")).toBeGreaterThan(-1);
    expect(body.indexOf("flushThinkingBuffer(")).toBeLessThan(body.indexOf("flushAssistantSegment("));
    expect(body).toContain("flushAssistantSegment(task.id, assistantCtx, always)");
    // 两个 flush 同时发起再 await（Promise.all）：正文 buffer 的取走不能排在任何 await 之后
    const code = body.replace(/\/\/.*$/gm, "");
    expect(code).toMatch(/await Promise\.all\(\[\s*flushThinkingBuffer\([^)]*\),\s*flushAssistantSegment\([^)]*\),?\s*\]\)/);
    expect(code).not.toMatch(/await flushThinkingBuffer\(/);
  });
});
