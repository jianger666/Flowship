/**
 * watch-task 路由：新订阅者 bootstrap 时补发「进行中正文」的快照（assistant_snapshot）。
 *
 * 背景（2026-10-22 用户反馈「对话在生成中、我切到别的窗口再切回来，看到的是它返回的中间部分，
 * 要等它生成完才能看到全部」）：一段不带工具调用的长回复要等 ctx.flush 才落成 assistant_message，
 * 整段在磁盘上根本没有；assistant_delta 又是纯内存帧、从不回放。切走再切回（组件重挂）、SSE 重连后，
 * 新订阅者只能从「订阅之后的第一帧」开始拼——只剩后半截。与 thinking_snapshot 同套路补一帧快照。
 *
 * 真实路由 + 真实 handleSdkMessage / flushAssistantSegment（真实 publish / subscribe / 落盘）+ 临时数据目录，钉死：
 *   1. 快照帧**无条件**发（没在吐字 = live:null），且排在 thinking_snapshot 之前；
 *   2. 快照 = 订阅那一刻之前已「发出」的整段（还在 70ms 合帧窗口里的不算），其后的增量排在后面——不重不漏；
 *   3. 这段正文的预定 eventId 贯穿：delta 帧 / 快照 / 最终落盘的 assistant_message 是同一个 id；
 *   4. 段结束（flushAssistantSegment）同步清快照；落盘事件已在 tail 里 → live:null，且订阅后才到的同段 delta 被丢弃；
 *   5. 失主的 run / 旁路答疑（origin）不进快照；
 *   6. 路由真实字节流喂给真实客户端解析（watchTaskStream）：回调序列对得上；无效帧丢弃。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-watch-assistant-snap-"));
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
const { appendEvent, listTasks, getTaskWithTailEvents } = await import("@/lib/server/task-fs");
const { setFailpoint, clearFailpoints } = await import("@/lib/server/failpoints");
const {
  handleSdkMessage,
  flushAssistantSegment,
  flushPendingAssistantDeltas,
  discardLiveAssistant,
  discardPendingThinkingDeltas,
  getLiveAssistantSnapshot,
} = await import("@/lib/server/sdk-message-handler");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`watch-task-assistant-snapshot DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
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
    title: `watch-assistant ${id}`,
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
const assistantMsg = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as never;

/** 吐一段字并立刻把合帧窗口里的冲出去（= 订阅者「本该已经收到」） */
const say = async (
  id: string,
  text: string,
  ctx: AssistantBufferCtx,
  lease: () => boolean = leaseOk,
): Promise<void> => {
  await handleSdkMessage(id, assistantMsg(text), ctx, lease);
  flushPendingAssistantDeltas(id);
};

const ids: string[] = [];
const alloc = async (): Promise<string> => {
  const id = `t_was_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    flushPendingAssistantDeltas(id);
    discardLiveAssistant(id);
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

const hasThinkingSnapshot = (frames: Frame[]): boolean =>
  frames.some((f) => f.type === "thinking_snapshot");

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

const snapshotOf = (frames: Frame[]): Frame => frames.find((f) => f.type === "assistant_snapshot")!;

describe("bootstrap：assistant_snapshot 帧", () => {
  it("没有进行中的正文：快照帧照发、live 为 null，且紧挨在 thinking_snapshot 之前", async () => {
    const id = await alloc();
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({ type: "assistant_snapshot", live: null });
    const types = frames.map((f) => f.type);
    expect(types.indexOf("assistant_snapshot")).toBe(types.indexOf("thinking_snapshot") - 1);
  });

  it("有进行中的正文：快照带预定 eventId / 已发出的整段 / 字数；delta 帧带同一个 eventId", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await say(id, "你好，", ctx);
    await say(id, "世界", ctx);
    expect(ctx.assistantEventId).toMatch(/\S/);

    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({
      type: "assistant_snapshot",
      live: { eventId: ctx.assistantEventId, text: "你好，世界", total: 5 },
    });

    // 订阅之后的增量带同一个 eventId（前端 / 路由据此配对落盘事件）
    const res = await watch(id);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seen: Frame[] = [];
    const pump = async (until: (fs: Frame[]) => boolean) => {
      while (!until(seen)) {
        const r = await reader.read();
        buf += dec.decode(r.value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
          buf = buf.slice(i + 2);
          if (line) seen.push(JSON.parse(line.slice(5).trimStart()) as Frame);
        }
      }
    };
    await pump(hasThinkingSnapshot);
    await say(id, "！", ctx);
    await pump((fs) => fs.some((f) => f.type === "assistant_delta"));
    await reader.cancel().catch(() => {});
    const delta = seen.find((f) => f.type === "assistant_delta")!;
    expect(delta.text).toBe("！");
    expect(delta.eventId).toBe(ctx.assistantEventId);
  });

  it("还在 70ms 合帧窗口里、没发出去的字不进快照：它发出时作为增量排在快照之后（不重复）", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    await handleSdkMessage(id, assistantMsg("还没发出的"), ctx, leaseOk); // 不冲
    expect(getLiveAssistantSnapshot(id)).toBeNull();

    const p = watch(id);
    const res = await p;
    const framesP = collect(res, (fs) => fs.some((f) => f.type === "assistant_delta"));
    await sleep(30);
    flushPendingAssistantDeltas(id);
    const frames = await framesP;
    expect(snapshotOf(frames)).toEqual({ type: "assistant_snapshot", live: null });
    const delta = frames.find((f) => f.type === "assistant_delta")!;
    expect(delta.text).toBe("还没发出的");
    expect(frames.indexOf(delta)).toBeGreaterThan(frames.indexOf(snapshotOf(frames)));
  });
});

describe("快照与实时帧「不重不漏」：订阅与读快照同步配对", () => {
  it("bootstrap 的磁盘读取挂起期间又发了一帧：它只在快照之后以增量到达，不会既进快照又进 buffer", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await say(id, "A", ctx);
    await say(id, "B", ctx);

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit(); // 订阅已挂上、快照已读走，bootstrap 卡在读磁盘之后
    await say(id, "C", ctx); // 订阅之后发的：必须走 buffer
    hang.release();

    const frames = await collect(await p, (fs) => fs.some((f) => f.type === "assistant_delta"));
    const snap = snapshotOf(frames);
    const deltas = frames.filter((f) => f.type === "assistant_delta");
    const text = (snap.live as { text: string }).text;
    expect(text).toBe("AB");
    expect(deltas.map((f) => f.text)).toEqual(["C"]);
    expect(frames.indexOf(snap)).toBeLessThan(frames.indexOf(deltas[0]!));
    expect(`${text}${deltas.map((f) => f.text).join("")}`).toBe("ABC");
  });

  it("bootstrap 期间这段正文结束并落盘了：先到快照（铺上整段）、再到同 id 的落盘事件（不带 replay，前端据此清流）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await say(id, "说了一会", ctx);
    const eventId = ctx.assistantEventId!;

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit();
    await flushAssistantSegment(id, ctx, leaseOk); // 段结束：清快照 + 落盘 assistant_message（复用预定 id）
    hang.release();

    const frames = await collect(
      await p,
      (fs) => fs.some((f) => f.type === "event" && (f.event as { id: string }).id === eventId),
    );
    const snapAt = frames.findIndex((f) => f.type === "assistant_snapshot");
    const persistedAt = frames.findIndex(
      (f) => f.type === "event" && (f.event as { id: string }).id === eventId,
    );
    expect(snapAt).toBeGreaterThanOrEqual(0);
    expect((frames[snapAt]!.live as { eventId: string; text: string }).text).toBe("说了一会");
    expect(persistedAt).toBeGreaterThan(snapAt);
    expect("replay" in frames[persistedAt]!).toBe(false);
  });
});

describe("段结算：flushAssistantSegment", () => {
  it("同步清快照、落盘事件复用预定 id，之后的新订阅者拿到 live:null 且 tail 里有这条消息", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    await say(id, "整段正文", ctx);
    const eventId = ctx.assistantEventId!;
    expect(getLiveAssistantSnapshot(id)?.eventId).toBe(eventId);

    await flushAssistantSegment(id, ctx, leaseOk);
    expect(getLiveAssistantSnapshot(id)).toBeNull();
    expect(ctx.buffer).toBe("");
    expect(ctx.assistantEventId).toBeUndefined();

    const tailEvents = (await getTaskWithTailEvents(id, 50))!.events;
    const persisted = tailEvents.find((e) => e.kind === "assistant_message");
    expect(persisted?.id).toBe(eventId);
    expect(persisted?.text).toBe("整段正文");

    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({ type: "assistant_snapshot", live: null });
  });

  it("清快照发生在落盘的 await 之前：落盘挂起期间订阅，拿到的已是 live:null（不会「整段 + 之后又收到落盘事件」）", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    await say(id, "整段正文", ctx);

    const flushing = flushAssistantSegment(id, ctx, leaseOk);
    // flushAssistantSegment 在第一个 await 之前已同步清完
    expect(getLiveAssistantSnapshot(id)).toBeNull();
    await flushing;
  });

  it("下一段换新的预定 id（不沿用上一段）", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    await say(id, "第一段", ctx);
    const first = ctx.assistantEventId!;
    await flushAssistantSegment(id, ctx, leaseOk);
    await say(id, "第二段", ctx);
    expect(ctx.assistantEventId).not.toBe(first);
    expect(getLiveAssistantSnapshot(id)).toMatchObject({ eventId: ctx.assistantEventId, text: "第二段" });
  });

  it("空白 buffer 不落盘（与旧 flush 行为一致），但快照照清", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    await say(id, "   ", ctx);
    await flushAssistantSegment(id, ctx, leaseOk);
    expect(getLiveAssistantSnapshot(id)).toBeNull();
    const tailEvents = (await getTaskWithTailEvents(id, 50))!.events;
    expect(tailEvents.some((e) => e.kind === "assistant_message")).toBe(false);
  });
});

describe("防幽灵：落盘事件已在 tail / 失主 / 旁路", () => {
  it("落盘事件已经在 tail 里（实时快照还没来得及清）：live 为 null，订阅后才到的同段 delta 也被丢弃", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await say(id, "写完了", ctx);
    // 落盘了（复用预定 id），但实时快照还没清（flush 与读 tail 交错）
    await appendEvent(id, { kind: "assistant_message", text: "写完了", id: ctx.assistantEventId });

    const res = await watch(id);
    const framesP = collect(res, () => false, 500);
    await sleep(100);
    await say(id, "尾巴", ctx); // 订阅之后才到的同段 delta
    const frames = await framesP;

    expect(snapshotOf(frames)).toEqual({ type: "assistant_snapshot", live: null });
    expect(
      frames.some((f) => f.type === "event" && (f.event as { id: string }).id === ctx.assistantEventId),
    ).toBe(true);
    expect(frames.some((f) => f.type === "assistant_delta")).toBe(false);
  });

  it("run 已经失主（实时状态残留）：不当作进行中的正文告诉新订阅者，并顺手清掉", async () => {
    const id = await alloc();
    let alive = true;
    await say(id, "死掉的正文", mkCtx(), () => alive);
    expect(getLiveAssistantSnapshot(id)).not.toBeNull();
    alive = false;
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({ type: "assistant_snapshot", live: null });
    expect(getLiveAssistantSnapshot(id)).toBeNull();
  });

  it("旁路答疑（带 origin）的字不进属主的快照，它的收尾也不清属主正在吐的字", async () => {
    const id = await alloc();
    const owner = mkCtx();
    await say(id, "主链在写", owner);

    const side = mkCtx();
    await handleSdkMessage(id, assistantMsg("旁路回答"), side, leaseOk, "grp-1");
    flushPendingAssistantDeltas(id);
    expect(side.assistantEventId).toBeUndefined();
    await flushAssistantSegment(id, side, leaseOk, "grp-1");

    expect(getLiveAssistantSnapshot(id)).toMatchObject({
      eventId: owner.assistantEventId,
      text: "主链在写",
    });
  });

  it("快照对文本再脱敏（凭据被切在相邻两帧时也不会原样漏给新订阅者）", async () => {
    const id = await alloc();
    const ctx = mkCtx();
    // 假凭据：env 里的 PAT 当前值会被算进脱敏集合（event-secret-redact）
    const fake = "glpat-fakefakefake1234567890";
    const prev = process.env.FLOWSHIP_GITLAB_TOKEN;
    process.env.FLOWSHIP_GITLAB_TOKEN = fake;
    try {
      // 单帧里分别看不出完整凭据（被切在两帧中间），拼起来才是
      await say(id, `token 是 ${fake.slice(0, 12)}`, ctx);
      await say(id, `${fake.slice(12)} 就这样`, ctx);
      const snap = getLiveAssistantSnapshot(id);
      expect(snap).not.toBeNull();
      expect(snap!.text).not.toContain(fake);
      expect(snap!.text).toContain("就这样");
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_GITLAB_TOKEN;
      else process.env.FLOWSHIP_GITLAB_TOKEN = prev;
    }
  });
});

describe("路由的字节流 → 客户端解析（watchTaskStream）端到端", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("重连场景：回调序列 = task → 历史事件（replay）→ 正文快照（整段）→ 之后的实时增量", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const ctx = mkCtx();
    await say(id, "先写到这", ctx);

    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    const calls: string[] = [];
    let snapshot: unknown = "unset";
    const done = watchTaskStream(
      id,
      {
        onTaskUpdate: () => calls.push("task"),
        onEvent: (ev, meta) => calls.push(`event:${ev.kind}:${meta?.replay ? "replay" : "live"}`),
        onAssistantSnapshot: (s) => {
          calls.push("snapshot");
          snapshot = s;
        },
        onAssistantDelta: (text) => calls.push(`delta:${text}`),
      },
      ctrl.signal,
    );
    for (let i = 0; i < 100 && snapshot === "unset"; i++) await sleep(20);
    await say(id, "里", ctx);
    for (let i = 0; i < 100 && !calls.includes("delta:里"); i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});

    expect(calls).toEqual(["task", "event:user_reply:replay", "snapshot", "delta:里"]);
    expect(snapshot).toEqual({ id: ctx.assistantEventId, text: "先写到这", total: 4 });
  });

  it("没有进行中的正文：客户端收到 onAssistantSnapshot(null)（据此清掉本地残留的流式文字）", async () => {
    const id = await alloc();
    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    let got: unknown = "unset";
    const done = watchTaskStream(id, { onAssistantSnapshot: (s) => (got = s) }, ctrl.signal);
    for (let i = 0; i < 100 && got === "unset"; i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});
    expect(got).toBeNull();
  });

  it("无效帧（缺字段 / 类型不对 / 缺 live）直接丢弃、不回调——宁可不动本地状态，也别拿脏数据覆盖", async () => {
    const frames: unknown[] = [
      { type: "assistant_snapshot" },
      { type: "assistant_snapshot", live: { eventId: "", text: "x", total: 1 } },
      { type: "assistant_snapshot", live: { eventId: "e1", text: 5, total: 1 } },
      { type: "assistant_snapshot", live: { eventId: "e1", text: "x", total: -1 } },
      { type: "assistant_snapshot", live: { eventId: "e1", text: "x", total: "1" } },
      { type: "assistant_snapshot", live: "oops" },
      { type: "assistant_snapshot", live: { eventId: "e2", text: "好", total: 1 } }, // 唯一有效
      { type: "assistant_snapshot", live: null }, // 合法的「没在吐字」
    ];
    const enc = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }),
    );
    const ctrl = new AbortController();
    const got: unknown[] = [];
    const done = watchTaskStream("t_any", { onAssistantSnapshot: (s) => got.push(s) }, ctrl.signal);
    for (let i = 0; i < 100 && got.length < 2; i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});
    expect(got).toEqual([{ id: "e2", text: "好", total: 1 }, null]);
  });
});
