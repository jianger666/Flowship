/**
 * watch-task 路由：新订阅者 bootstrap 时补发「进行中思考」的快照（thinking_snapshot）。
 *
 * 背景（2026-10-13 用户反馈「首轮思考很长，我切窗口再切回来，思考好像又是从第一个字开始吐」）：
 * 浏览器实测复现——切到别的对话再切回（组件重挂）、SSE 断流重连，文本区都只剩重连之后新到的字、
 * 从头重新长。根因是实时思考只存在于前端本地 state，服务端的 thinking_delta 又从不回放。
 *
 * 真实路由 + 真实 handleSdkMessage（真实 publish / subscribe / 落盘）+ 临时数据目录，钉死：
 *   1. bootstrap 帧序：task → tail 事件（带 replay 标记）→ queue_state → restricted_run → thinking_snapshot；
 *      快照帧**无条件**发（没在思考 = live:null），前端据此对齐（有则重建、无则清）；
 *   2. 快照 = 订阅那一刻之前已发出的全部，其后的实时帧排在它后面——不重不漏
 *      （订阅与读快照必须同步配对：bootstrap 的磁盘读取挂起期间发的帧，不能既进快照又进 buffer）；
 *   3. 这段思考的落盘事件已经在 tail 里 → 不发快照（否则复活幽灵「思考中」）；
 *   4. 只有 bootstrap 回放的历史事件带 replay（前端据此不把它们当成「这段思考结束了」），实时事件不带；
 *   5. 路由的真实字节流喂给真实的客户端解析（watchTaskStream）：回调序列端到端对得上。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-watch-thinking-snap-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/tool-result-persist", () => ({
  buildToolResultMeta: vi.fn(async () => ({
    callId: "c1",
    name: "shell",
    status: "ok",
    output: "ok",
  })),
}));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { appendEvent, listTasks } = await import("@/lib/server/task-fs");
const { setFailpoint, clearFailpoints } = await import("@/lib/server/failpoints");
const {
  handleSdkMessage,
  flushThinkingBuffer,
  discardPendingThinkingDeltas,
  THINKING_DELTA_INTERVAL_MS,
} = await import("@/lib/server/sdk-message-handler");
const { writeOwnedEventAndPublish } = await import("@/lib/server/task-stream");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`watch-task-thinking-snapshot DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};
await listTasks();
skipBootRecovery();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const leaseOk = () => true;

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `watch-thinking ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const mkCtx = (): AssistantBufferCtx => ({ buffer: "", flush: async () => {} });
const thinkingMsg = (text: string) => ({ type: "thinking", text }) as never;

const ids: string[] = [];
const alloc = async (): Promise<string> => {
  const id = `t_wts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta(makeMeta(id));
  return id;
};

beforeEach(() => {
  clearFailpoints();
  skipBootRecovery();
});

afterEach(async () => {
  clearFailpoints();
  for (const id of ids.splice(0)) {
    discardPendingThinkingDeltas(id);
    try {
      await fs.rm(taskDir(id), { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

type Frame = { type: string; [k: string]: unknown };

/** 读 SSE 响应，直到 stop(frames) 为真或超时；读完退订（cancel 触发路由的 cleanup） */
const collect = async (
  res: Response,
  stop: (frames: Frame[]) => boolean,
  ms = 4000,
): Promise<Frame[]> => {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !stop(frames)) {
      const r = await Promise.race([
        reader.read(),
        sleep(Math.max(1, deadline - Date.now())).then(() => null),
      ]);
      if (!r || r.done) break;
      buf += dec.decode(r.value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (line) frames.push(JSON.parse(line.slice(5).trimStart()) as Frame);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
};

const watch = (id: string): Promise<Response> =>
  GET(new Request(`http://local/api/tasks/${id}/watch-task?tail=50`), {
    params: Promise.resolve({ id }),
  });

const hasSnapshot = (frames: Frame[]): boolean =>
  frames.some((f) => f.type === "thinking_snapshot");

/**
 * 把路由的真实 Response 当作 fetch 的返回交给 watchTaskStream：
 * 套一层转发流，abort 时主动取消路由那端的 reader——否则被 stub 的 fetch 不理会 signal、
 * watchTaskStream 的 read() 永远挂着
 */
const routeAsFetch = (res: Response) => {
  const routeReader = res.body!.getReader();
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    init?.signal?.addEventListener("abort", () => void routeReader.cancel().catch(() => {}), {
      once: true,
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const r = await routeReader.read();
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel: () => routeReader.cancel().catch(() => {}),
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
};

const installHang = (name: string) => {
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

describe("bootstrap 帧序与 replay 标记", () => {
  it("没有进行中的思考：快照帧照发、live 为 null；顺序在 queue_state / restricted_run 之后；tail 事件全带 replay", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "第一条" });
    await appendEvent(id, { kind: "info", text: "第二条" });

    const frames = await collect(await watch(id), hasSnapshot);

    expect(frames.map((f) => f.type)).toEqual([
      "task",
      "event",
      "event",
      "queue_state",
      "restricted_run",
      "thinking_snapshot",
    ]);
    const events = frames.filter((f) => f.type === "event");
    expect(events.every((f) => f.replay === true)).toBe(true);
    expect(frames.at(-1)).toEqual({ type: "thinking_snapshot", live: null });
  });

  it("有进行中的思考：快照带 eventId / 已发出的文本 / 累计数 / 首帧时刻（字段口径与 thinking_delta 帧一致）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    const t0 = Date.now();
    await handleSdkMessage(id, thinkingMsg("先看"), ctx, leaseOk);
    await sleep(THINKING_DELTA_INTERVAL_MS + 10);
    await handleSdkMessage(id, thinkingMsg("数据"), ctx, leaseOk);

    const frames = await collect(await watch(id), hasSnapshot);
    const snap = frames.at(-1)!;
    expect(snap.type).toBe("thinking_snapshot");
    const live = snap.live as { eventId: string; text: string; total: number; since: number };
    expect(live.eventId).toBe(ctx.thinkingEventId);
    expect(live.text).toBe("先看数据");
    expect(live.total).toBe(4);
    expect(live.since).toBeGreaterThanOrEqual(t0);
    expect(live.since).toBeLessThanOrEqual(Date.now());
  });

  it("实时事件（bootstrap 之后才产生的）不带 replay——前端据此把它当作「这段思考结束了」", async () => {
    const id = await alloc();
    const res = await watch(id);
    const reader = res.body!.getReader();
    // 先把 bootstrap 读完（见到快照帧）
    const dec = new TextDecoder();
    let buf = "";
    const seen: Frame[] = [];
    while (!hasSnapshot(seen)) {
      const r = await reader.read();
      buf += dec.decode(r.value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (line) seen.push(JSON.parse(line.slice(5).trimStart()) as Frame);
      }
    }
    await writeOwnedEventAndPublish(id, leaseOk, { kind: "info", text: "实时的一条" });
    const live = await (async () => {
      for (;;) {
        const r = await reader.read();
        buf += dec.decode(r.value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
          buf = buf.slice(i + 2);
          if (line) {
            const f = JSON.parse(line.slice(5).trimStart()) as Frame;
            if (f.type === "event") return f;
          }
        }
      }
    })();
    await reader.cancel().catch(() => {});
    expect((live.event as { text: string }).text).toBe("实时的一条");
    expect("replay" in live).toBe(false);
  });
});

describe("快照与实时帧「不重不漏」：订阅与读快照同步配对", () => {
  it("bootstrap 的磁盘读取挂起期间又发了一帧：它只在快照之后以实时帧到达，不会既进快照又进 buffer（否则前端文本重复一遍）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await handleSdkMessage(id, thinkingMsg("A"), ctx, leaseOk); // 立即发
    await sleep(THINKING_DELTA_INTERVAL_MS + 10);
    await handleSdkMessage(id, thinkingMsg("B"), ctx, leaseOk); // 立即发（窗口已过）

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit(); // 订阅已挂上、快照已读走，bootstrap 卡在读磁盘之后
    await sleep(THINKING_DELTA_INTERVAL_MS + 10);
    await handleSdkMessage(id, thinkingMsg("C"), ctx, leaseOk); // 订阅之后发的：必须走 buffer
    hang.release();

    const frames = await collect(await p, (fs) => fs.some((f) => f.type === "thinking_delta"));
    const snap = frames.find((f) => f.type === "thinking_snapshot")!;
    const deltas = frames.filter((f) => f.type === "thinking_delta");

    expect((snap.live as { text: string }).text).toBe("AB"); // 快照 = 订阅那一刻之前的
    expect(deltas.map((f) => f.text)).toEqual(["C"]); // 之后的一帧也只出现一次
    expect(frames.indexOf(snap)).toBeLessThan(frames.indexOf(deltas[0]!)); // 先快照、后增量
    // 拼起来 = 全文，前端按「快照 + 增量」重建不会重复也不会缺
    expect(`${(snap.live as { text: string }).text}${deltas.map((f) => f.text).join("")}`).toBe("ABC");
  });

  it("bootstrap 期间这段思考结束并落盘了：先到快照（建起实时态）、再到同 id 的落盘事件（不带 replay，前端据此清掉）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await handleSdkMessage(id, thinkingMsg("想了一会"), ctx, leaseOk);
    const eventId = ctx.thinkingEventId!;

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit();
    await flushThinkingBuffer(id, ctx, leaseOk); // 段结束：丢节流状态 + 落盘 thinking 事件（预定 id）
    hang.release();

    const frames = await collect(
      await p,
      (fs) => fs.some((f) => f.type === "event" && (f.event as { id: string }).id === eventId),
    );
    const snapAt = frames.findIndex((f) => f.type === "thinking_snapshot");
    const persistedAt = frames.findIndex(
      (f) => f.type === "event" && (f.event as { id: string }).id === eventId,
    );
    expect(snapAt).toBeGreaterThanOrEqual(0);
    expect((frames[snapAt]!.live as { eventId: string }).eventId).toBe(eventId);
    expect(persistedAt).toBeGreaterThan(snapAt);
    expect("replay" in frames[persistedAt]!).toBe(false);
  });

  it("这段思考的落盘事件已经在 tail 里（节流状态还没来得及清）：不发快照、live 为 null——否则复活一个幽灵「思考中」", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await handleSdkMessage(id, thinkingMsg("想完了"), ctx, leaseOk);
    // 落盘了（复用预定 id），但 discard 还没发生
    await appendEvent(id, { kind: "thinking", text: "想完了", id: ctx.thinkingEventId });

    const frames = await collect(await watch(id), hasSnapshot);
    expect(frames.at(-1)).toEqual({ type: "thinking_snapshot", live: null });
    // 对照：tail 里确实带着那条事件
    expect(
      frames.some((f) => f.type === "event" && (f.event as { id: string }).id === ctx.thinkingEventId),
    ).toBe(true);
  });

  it("run 已经失主（节流状态残留）：不当作进行中的思考告诉新订阅者", async () => {
    const id = await alloc();
    let alive = true;
    await handleSdkMessage(id, thinkingMsg("死掉的思考"), mkCtx(), () => alive);
    alive = false;
    const frames = await collect(await watch(id), hasSnapshot);
    expect(frames.at(-1)).toEqual({ type: "thinking_snapshot", live: null });
  });
});

describe("路由的字节流 → 客户端解析（watchTaskStream）端到端", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("重连场景：回调序列 = task → 历史事件（replay）→ 快照（带已发出的文本）→ 之后的实时增量", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await handleSdkMessage(id, thinkingMsg("先看"), ctx, leaseOk);
    await sleep(THINKING_DELTA_INTERVAL_MS + 10);
    await handleSdkMessage(id, thinkingMsg("数据"), ctx, leaseOk);

    // 把路由的真实 Response 交给真实的客户端解析
    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    const calls: string[] = [];
    let snapshot: unknown = "unset";
    const done = watchTaskStream(
      id,
      {
        onTaskUpdate: () => calls.push("task"),
        onEvent: (ev, meta) => calls.push(`event:${ev.kind}:${meta?.replay ? "replay" : "live"}`),
        onThinkingSnapshot: (s) => {
          calls.push("snapshot");
          snapshot = s;
        },
        onThinkingDelta: (text) => calls.push(`delta:${text}`),
      },
      ctrl.signal,
    );
    // 等快照到了，再发一帧实时增量，确认它排在快照后面
    for (let i = 0; i < 100 && snapshot === "unset"; i++) await sleep(20);
    await sleep(THINKING_DELTA_INTERVAL_MS + 10);
    await handleSdkMessage(id, thinkingMsg("！"), ctx, leaseOk);
    for (let i = 0; i < 100 && !calls.includes("delta:！"); i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});

    expect(calls).toEqual(["task", "event:user_reply:replay", "snapshot", "delta:！"]);
    expect(snapshot).toEqual({
      id: ctx.thinkingEventId,
      text: "先看数据",
      total: 4,
      since: expect.any(Number),
    });
  });

  it("没有进行中的思考：客户端收到 onThinkingSnapshot(null)（据此清掉本地残留的实时态）", async () => {
    const id = await alloc();
    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    let got: unknown = "unset";
    const done = watchTaskStream(
      id,
      { onThinkingSnapshot: (s) => (got = s) },
      ctrl.signal,
    );
    for (let i = 0; i < 100 && got === "unset"; i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});
    expect(got).toBeNull();
  });
});
