/**
 * watch-task 路由：新订阅者 bootstrap 时补发「进行中 shell 输出」的快照（tool_output_snapshot）。
 *
 * 背景：agent 正在跑长 shell（编译 / 测试）时，用户切到别的窗口再切回来，工具块里的实时输出是空的
 * （ChatView 挂载时清空直播缓冲），之后也只显示「切回那一刻起的增量」。`tool_output_delta` 是纯内存 ephemeral 帧、
 * 从不回放。与 assistant_snapshot / thinking_snapshot 同套路：服务端记住「已发出的尾部」，bootstrap 补一帧，
 * 前端按**替换**语义整份铺上（不能复用追加型 delta，否则会和重连后的增量重复）。
 *
 * 真实路由 + 真实 shell 输出发布器（真实 publish / subscribe）+ 临时数据目录，钉死：
 *   1. 快照帧**无条件**发（没有在跑的 shell = outputs:[]），夹在 assistant_snapshot 与 thinking_snapshot 之间；
 *   2. 快照 = 订阅那一刻之前已发出的尾部窗口，其后的增量帧排在它后面——不重不漏
 *      （订阅与读快照同步配对：bootstrap 的磁盘读取挂起期间发的帧，不能既进快照又进 buffer）；
 *   3. tail 里已有对应 tool_result 的 callId 不带；tool-call-completed / run 失主后不带；
 *   4. bootstrap 每一帧各自 try/catch：前置 builder 抛错，后面的快照帧照发（评审 P3）；
 *   5. 路由真实字节流 → 真实客户端解析（watchTaskStream）→ 替换 + 追加的 reducer：重连后文本不重复、不缺；
 *   6. 清理接线（真实 handleSdkMessage / 真实 publish）：emitToolResult 落地（含落地失败）立刻丢该 callId 的快照；
 *      任务流上属主主链的 done / task_deleted 整任务丢弃（旁路 done 带 origin 不清）；
 *   7. bootstrap 帧序与交错：task → tail 回放（replay:true）→ 各补位帧 → 三个快照 → 订阅后才到的 buffer 帧（非 replay）；
 *      快照与 tail / buffer 重叠时（tool_result 在 tail 里 / 在挂起期间落地 / 同一事件两处都有）不重不漏。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { InteractionUpdate } from "@cursor/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-watch-tool-output-snap-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const hoisted = vi.hoisted(() => ({
  /** 让 talk_queue 这个「前置 builder」抛错（评审 P3：同一个 try 会让后面的快照帧整体丢失） */
  talkQueueBoom: false,
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/task-talk-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-talk-queue")>();
  return {
    ...actual,
    buildTalkQueueSnapshot: (taskId: string) => {
      if (hoisted.talkQueueBoom) throw new Error("talk_queue builder 炸了");
      return actual.buildTalkQueueSnapshot(taskId);
    },
  };
});

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { appendEvent, listTasks } = await import("@/lib/server/task-fs");
const { setFailpoint, clearFailpoints } = await import("@/lib/server/failpoints");
const { createShellOutputDeltaPublisher, discardAllLiveShellOutputOfTask, getLiveShellOutputSnapshot } =
  await import("@/lib/server/shell-output-bridge");
const { handleSdkMessage } = await import("@/lib/server/sdk-message-handler");
const { publish, writeEventAndPublish } = await import("@/lib/server/task-stream");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");
const { reduceLiveToolOutputs, replaceLiveToolOutputs, EMPTY_LIVE_TOOL_OUTPUTS } = await import(
  "@/lib/live-tool-outputs"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`watch-task-tool-output-snapshot DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
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

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `watch-tool-output ${id}`,
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

const ids: string[] = [];
const alloc = async (): Promise<string> => {
  const id = `t_wto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta(makeMeta(id));
  return id;
};

beforeEach(() => {
  clearFailpoints();
  hoisted.talkQueueBoom = false;
  skipBootRecovery();
});

afterEach(async () => {
  clearFailpoints();
  hoisted.talkQueueBoom = false;
  vi.unstubAllGlobals();
  for (const id of ids.splice(0)) {
    discardAllLiveShellOutputOfTask(id);
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

type Delta = { update: InteractionUpdate };
const started = (callId: string): Delta => ({
  update: { type: "tool-call-started", callId, toolCall: { type: "shell" } } as InteractionUpdate,
});
const stdout = (data: string): Delta => ({
  update: {
    type: "shell-output-delta",
    event: { case: "stdout", value: { data } },
  } as InteractionUpdate,
});
const completed = (callId: string): Delta => ({
  update: { type: "tool-call-completed", callId } as InteractionUpdate,
});

/** 恒 ≥2KB（FLUSH_BYTES）→ 一进来就立刻 flush 发出；rows 行、每行 `${tag} step ${i}` 补点到统一宽度 */
const burst = (tag: string, rows = 30): string => {
  const width = Math.max(90, Math.ceil(2100 / rows) + 1);
  return `${Array.from({ length: rows }, (_, i) => `${tag} step ${i}`.padEnd(width, ".")).join("\n")}\n`;
};

const snapshotOf = (frames: Frame[]): Frame => frames.find((f) => f.type === "tool_output_snapshot")!;
const outputsOf = (f: Frame): Array<{ callId: string; text: string }> =>
  f.outputs as Array<{ callId: string; text: string }>;
const deltaFrames = (frames: Frame[]): Frame[] =>
  frames.filter(
    (f) => f.type === "event" && (f.event as { kind: string }).kind === "tool_output_delta",
  );
const chunkOf = (f: Frame): string => (f.event as { meta: { chunk: string } }).meta.chunk;

describe("bootstrap：tool_output_snapshot 帧", () => {
  it("没有在跑的 shell：快照帧照发、outputs 为空数组，且夹在 assistant_snapshot 与 thinking_snapshot 之间", async () => {
    const id = await alloc();
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({ type: "tool_output_snapshot", outputs: [] });
    const types = frames.map((f) => f.type);
    expect(types.indexOf("tool_output_snapshot")).toBe(types.indexOf("assistant_snapshot") + 1);
    expect(types.indexOf("thinking_snapshot")).toBe(types.indexOf("tool_output_snapshot") + 1);
  });

  it("有在跑的 shell：快照带各 callId 已发出的尾部窗口（≤20 行）；订阅之后的增量作为 delta 帧排在快照之后", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("build"))); // 30 行 → 快照只留最后 20 行
    onDelta(started("call_b"));
    onDelta(stdout(burst("test", 3)));

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
    const snap = outputsOf(snapshotOf(seen));
    expect(snap.map((o) => o.callId)).toEqual(["call_a", "call_b"]);
    const a = snap[0]!.text.split("\n");
    expect(a).toHaveLength(20); // 19 行 + 末尾换行的空元素
    expect(a[a.length - 2]).toMatch(/^build step 29/);
    expect(snap[0]!.text).not.toContain("build step 5.");
    expect(snap[0]!.text).not.toContain("build step 10.");
    expect(snap[1]!.text).toBe(burst("test", 3));

    // 订阅之后的增量：走 ephemeral delta 帧、排在快照后面（前端「替换后追加」）
    onDelta(stdout(burst("more", 2)));
    await pump((fs) => deltaFrames(fs).length > 0);
    await reader.cancel().catch(() => {});
    const delta = deltaFrames(seen)[0]!;
    expect(chunkOf(delta)).toBe(burst("more", 2));
    expect(seen.indexOf(delta)).toBeGreaterThan(seen.indexOf(snapshotOf(seen)));
  });

  it("订阅与读快照同步配对：bootstrap 的磁盘读取挂起期间又发的帧，只作为增量出现在快照之后（不会既进快照又进 buffer）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "跑一下" });
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    const first = burst("first", 2);
    onDelta(stdout(first));

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit(); // 订阅已挂上、快照已读走，bootstrap 卡在读磁盘之后
    const second = burst("second", 2);
    onDelta(stdout(second)); // 订阅之后发的：必须走 buffer
    hang.release();

    const frames = await collect(await p, (fs) => deltaFrames(fs).length > 0);
    const snap = snapshotOf(frames);
    expect(outputsOf(snap)).toEqual([{ callId: "call_a", text: first }]);
    const deltas = deltaFrames(frames);
    expect(deltas.map(chunkOf)).toEqual([second]);
    expect(frames.indexOf(snap)).toBeLessThan(frames.indexOf(deltas[0]!));
  });

  it("tail 里已有对应 tool_result 的 callId 不带（它其实已经结束，别复活幽灵直播）；其它 callId 照带", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_done"));
    onDelta(stdout(burst("done", 2)));
    onDelta(started("call_live"));
    onDelta(stdout(burst("live", 2)));
    // call_done 的 tool_result 已落盘（tool-call-completed 的清理还没来得及，与读 tail 交错）
    await appendEvent(id, {
      kind: "tool_result",
      text: "工具完成 shell",
      meta: { callId: "call_done", name: "shell", status: "success", output: "ok" },
    });
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(outputsOf(snapshotOf(frames)).map((o) => o.callId)).toEqual(["call_live"]);
  });

  it("tool-call-completed 之后 / run 失主之后的新订阅者拿到空快照", async () => {
    const id = await alloc();
    let alive = true;
    const onDelta = createShellOutputDeltaPublisher(id, () => alive);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    onDelta(started("call_b"));
    onDelta(stdout(burst("b", 2)));
    onDelta(completed("call_a"));
    let frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(outputsOf(snapshotOf(frames)).map((o) => o.callId)).toEqual(["call_b"]);

    alive = false; // run 结束 / 被取代，而 call_b 没走到 tool-call-completed
    frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({ type: "tool_output_snapshot", outputs: [] });
  });

  it("快照文本脱敏（不经 publish）：凭据被切在相邻两帧时也不会原样漏给新订阅者", async () => {
    const id = await alloc();
    const fake = "glpat-fakefakefake1234567890";
    const prev = process.env.FLOWSHIP_GITLAB_TOKEN;
    process.env.FLOWSHIP_GITLAB_TOKEN = fake;
    try {
      const onDelta = createShellOutputDeltaPublisher(id, () => true);
      onDelta(started("call_a"));
      onDelta(stdout(`${"x".repeat(2100)} token=${fake.slice(0, 12)}`));
      onDelta(stdout(`${fake.slice(12)} 完\n${"y".repeat(2100)}`));
      const frames = await collect(await watch(id), hasThinkingSnapshot);
      const text = outputsOf(snapshotOf(frames))[0]!.text;
      expect(text).not.toContain(fake);
      expect(text).toContain("完");
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_GITLAB_TOKEN;
      else process.env.FLOWSHIP_GITLAB_TOKEN = prev;
    }
  });
});

describe("bootstrap 每一帧各自 try/catch（评审 P3）", () => {
  it("前置 builder（talk_queue）抛错：只丢它那一帧，后面的 assistant / tool_output / thinking 快照与前面的帧照发", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));

    hoisted.talkQueueBoom = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const frames = await collect(await watch(id), hasThinkingSnapshot);
      const types = frames.map((f) => f.type);
      expect(types).not.toContain("talk_queue");
      // 前面的帧不受影响
      expect(types).toContain("task");
      expect(types).toContain("event");
      expect(types).toContain("queue_state");
      expect(types).toContain("restricted_run");
      // 它之后的帧全在（旧写法是同一个 try：抛错后这些快照帧整体丢失）
      for (const t of [
        "background_subagents",
        "storage_degraded",
        "assistant_snapshot",
        "tool_output_snapshot",
        "thinking_snapshot",
      ]) {
        expect(types, `缺 ${t}`).toContain(t);
      }
      expect(outputsOf(snapshotOf(frames))).toEqual([{ callId: "call_a", text: burst("a", 2) }]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("bootstrap talk_queue"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("路由的字节流 → 客户端解析（watchTaskStream）→ 替换 + 追加：重连后不重复、不缺", () => {
  it("切走再切回（本地什么都没有）：快照整份铺上，之后的增量接着追加，最终 = 完整尾部", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "跑" });
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    const early = burst("early", 4);
    onDelta(stdout(early));

    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    let live = EMPTY_LIVE_TOOL_OUTPUTS;
    const calls: string[] = [];
    const done = watchTaskStream(
      id,
      {
        onEvent: (ev, meta) => {
          calls.push(`event:${ev.kind}:${meta?.replay ? "replay" : "live"}`);
          live = reduceLiveToolOutputs(live, ev);
        },
        onToolOutputSnapshot: (outputs) => {
          calls.push("tool_output_snapshot");
          live = replaceLiveToolOutputs(live, outputs);
        },
      },
      ctrl.signal,
    );
    for (let i = 0; i < 100 && !calls.includes("tool_output_snapshot"); i++) await sleep(20);
    expect(live).toEqual({ call_a: early });

    const late = burst("late", 2);
    onDelta(stdout(late));
    for (let i = 0; i < 100 && !calls.includes("event:tool_output_delta:live"); i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});

    // 回调序列：历史事件（replay）→ 快照 → 之后的实时增量
    expect(calls).toEqual([
      "event:user_reply:replay",
      "tool_output_snapshot",
      "event:tool_output_delta:live",
    ]);
    // 快照之前的字只出现一次、之后的增量接在后面（若快照走追加语义，early 会和重连后的增量对不齐）
    expect(live).toEqual({ call_a: `${early}${late}` });
  });

  it("同页重连（本地已有一截、断线期间又长了一截）：快照替换成服务端的权威尾部，不会把已有的再拼一遍", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    const c1 = burst("c1", 3);
    const c2 = burst("c2", 3);
    const c3 = burst("c3", 3);
    onDelta(stdout(c1));
    onDelta(stdout(c2));
    // 本地只收到了 c1+c2；断线期间服务端又发了 c3
    let live = reduceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, {
      id: "ephemeral_tod_call_a_1_1",
      ts: 1,
      kind: "tool_output_delta",
      text: "",
      meta: { callId: "call_a", chunk: `${c1}${c2}` },
    });
    onDelta(stdout(c3));

    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    let got = false;
    const done = watchTaskStream(
      id,
      {
        onToolOutputSnapshot: (outputs) => {
          live = replaceLiveToolOutputs(live, outputs);
          got = true;
        },
      },
      ctrl.signal,
    );
    for (let i = 0; i < 100 && !got; i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});
    expect(live.call_a).toBe(`${c1}${c2}${c3}`);
    // 对照：若用追加语义，本地已有的 c1+c2 会被重复一遍
    expect(live.call_a.split("c1 step 0").length - 1).toBe(1);
  });

  it("没有在跑的 shell：客户端收到空数组（据此清掉本地残留的直播缓冲）", async () => {
    const id = await alloc();
    vi.stubGlobal("fetch", routeAsFetch(await watch(id)));
    const ctrl = new AbortController();
    let got: unknown = "unset";
    const done = watchTaskStream(id, { onToolOutputSnapshot: (o) => (got = o) }, ctrl.signal);
    for (let i = 0; i < 100 && got === "unset"; i++) await sleep(20);
    ctrl.abort();
    await done.catch(() => {});
    expect(got).toEqual([]);
    expect(replaceLiveToolOutputs({ stale: "残留" }, got as [])).toBe(EMPTY_LIVE_TOOL_OUTPUTS);
  });
});

// ---------------------------------------------------------------- 清理接线

describe("清理接线：tool_result 落地 / run 收尾 / 任务删除（真实 handleSdkMessage、真实 publish）", () => {
  const leaseOk = () => true;
  const newCtx = (extra: Record<string, unknown> = {}) =>
    ({ buffer: "", flush: async () => {}, ...extra }) as Parameters<typeof handleSdkMessage>[2];
  /** shell 工具调用的终态消息（args 不带 command：不触发后台 shell 追踪的探测） */
  const shellResult = (callId: string, status: "completed" | "error" = "completed") =>
    ({
      type: "tool_call",
      call_id: callId,
      name: "shell",
      status,
      args: {},
      result: status === "completed" ? "ok" : { error: "boom" },
    }) as never;
  const callIds = (id: string): string[] => getLiveShellOutputSnapshot(id).map((o) => o.callId);

  it("emitToolResult：shell 的 tool_result 落地后，该 callId 的快照立即丢（别的 callId 保留；新订阅者也只看到保留的）", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    onDelta(started("call_b"));
    onDelta(stdout(burst("b", 2)));
    expect(callIds(id)).toEqual(["call_a", "call_b"]);

    await handleSdkMessage(id, shellResult("call_a"), newCtx(), leaseOk);
    // 直接看存储（不经路由里「tail 有 tool_result 就滤掉」那道）：emitToolResult 自己丢掉了
    expect(callIds(id)).toEqual(["call_b"]);
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(outputsOf(snapshotOf(frames)).map((o) => o.callId)).toEqual(["call_b"]);
  });

  it("工具报错的终态消息（status=error）同样丢——SDK 出错时可能没有 tool-call-completed 更新", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    await handleSdkMessage(id, shellResult("call_a", "error"), newCtx(), leaseOk);
    expect(callIds(id)).toEqual([]);
  });

  it("消音审计路径（提问后的工具调用，tool_result 只落盘不广播）也丢", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    await handleSdkMessage(id, shellResult("call_a"), newCtx({ askSeen: true }), leaseOk);
    expect(callIds(id)).toEqual([]);
  });

  it("tool_result 没写成（构建 / 写盘抛错被 emitToolResult 吞掉）：工具其实已经结束，快照照样丢（finally）", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    setFailpoint("sdkmsg.beforeEventWrite", async () => {
      throw new Error("写事件前炸了");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handleSdkMessage(id, shellResult("call_a"), newCtx(), leaseOk);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("emitToolResult 失败"))).toBe(true);
      expect(callIds(id)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("没有 tool_result 的 callId（还在跑）不受别的工具结果影响", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_live"));
    onDelta(stdout(burst("live", 2)));
    // 非 shell 的工具结果（read）落地：callId 不同、别的快照不动
    await handleSdkMessage(
      id,
      { type: "tool_call", call_id: "call_read", name: "read", status: "completed", args: {}, result: "ok" } as never,
      newCtx(),
      leaseOk,
    );
    expect(callIds(id)).toEqual(["call_live"]);
  });

  it("run 收尾（属主主链的 done）：没等到 tool-call-completed / tool_result 的快照整任务丢；新订阅者拿空快照（lease 仍存活的 observer 类 run 也一样）", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true); // lease 恒真：run 结束后 observer 仍判存活
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    expect(callIds(id)).toEqual(["call_a"]);

    publish(id, { kind: "done", task: makeMeta(id) as never, ok: false });
    expect(callIds(id)).toEqual([]);
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    expect(snapshotOf(frames)).toEqual({ type: "tool_output_snapshot", outputs: [] });
  });

  it("旁路群答疑 run 的 done（带 origin）不清属主主链正在跑的 shell", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    publish(id, { kind: "done", task: makeMeta(id) as never, ok: true, origin: "group-run-9" });
    expect(callIds(id)).toEqual(["call_a"]);
  });

  it("任务被删（task_deleted）：整任务丢，不留幽灵条目", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    publish(id, { kind: "task_deleted", taskId: id });
    expect(callIds(id)).toEqual([]);
  });

  it("别的任务的 done / task_deleted 不影响本任务", async () => {
    const id = await alloc();
    const other = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    publish(other, { kind: "done", task: makeMeta(other) as never, ok: true });
    publish(other, { kind: "task_deleted", taskId: other });
    expect(callIds(id)).toEqual(["call_a"]);
  });
});

// ---------------------------------------------------------------- bootstrap 帧序与交错

describe("bootstrap 帧序与交错：快照 vs tail 回放 vs 订阅后才到的 buffer 帧", () => {
  const label = (f: Frame): string =>
    f.type === "event"
      ? `event:${(f.event as { kind: string }).kind}:${f.replay === true ? "replay" : "live"}`
      : f.type;

  it("完整帧序：task → tail 事件（replay:true）→ 各补位帧 → assistant / tool_output / thinking 三个快照 → 订阅后才到的帧（非 replay）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "跑一下" });
    await appendEvent(id, {
      kind: "tool_call",
      text: "调用 shell",
      meta: { callId: "call_a", name: "shell" },
    });
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    const first = burst("first", 2);
    onDelta(stdout(first));

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit(); // 订阅已挂上、快照与 tail 都已读走，bootstrap 卡在 hydrate 之后
    const second = burst("second", 2);
    onDelta(stdout(second)); // 订阅之后发的实时输出
    await writeEventAndPublish(id, { kind: "info", text: "挂起期间落盘的事件" }); // 订阅之后落盘的事件
    hang.release();

    const frames = await collect(
      await p,
      (fs) => fs.some((f) => label(f) === "event:info:live"),
    );
    expect(frames.map(label)).toEqual([
      "task",
      "event:user_reply:replay",
      "event:tool_call:replay",
      "queue_state",
      "restricted_run",
      "talk_queue",
      "background_subagents",
      "storage_degraded",
      "assistant_snapshot",
      "tool_output_snapshot",
      "thinking_snapshot",
      // buffer 里的帧：按它们发生的顺序、在三个快照之后回放，且不带 replay 标记
      "event:tool_output_delta:live",
      "event:info:live",
    ]);
    // 快照 = 订阅那一刻之前已发出的；其后的增量只出现在后面的 delta 帧里（不重复）
    expect(outputsOf(snapshotOf(frames))).toEqual([{ callId: "call_a", text: first }]);
    expect(chunkOf(deltaFrames(frames)[0]!)).toBe(second);
  });

  it("快照与 tail 重叠：tool_result 已在 tail 里 → 回放帧里有它、快照里没有该 callId（先回放、后快照，不复活）", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_done"));
    onDelta(stdout(burst("done", 2)));
    onDelta(started("call_live"));
    onDelta(stdout(burst("live", 2)));
    await appendEvent(id, {
      kind: "tool_result",
      text: "工具完成 shell",
      meta: { callId: "call_done", name: "shell", status: "success", output: "ok" },
    });
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    const labels = frames.map(label);
    expect(labels.indexOf("event:tool_result:replay")).toBeGreaterThan(-1);
    expect(labels.indexOf("event:tool_result:replay")).toBeLessThan(labels.indexOf("tool_output_snapshot"));
    expect(outputsOf(snapshotOf(frames)).map((o) => o.callId)).toEqual(["call_live"]);

    // 客户端按帧序重放（回放的 tool_result 清 call_done、快照整份替换）：最终只剩 call_live
    let live = EMPTY_LIVE_TOOL_OUTPUTS;
    for (const f of frames) {
      if (f.type === "event") live = reduceLiveToolOutputs(live, f.event as never);
      else if (f.type === "tool_output_snapshot") live = replaceLiveToolOutputs(live, outputsOf(f));
    }
    expect(Object.keys(live)).toEqual(["call_live"]);
  });

  it("tool_result 在 bootstrap 挂起期间才落地：快照里还有该 callId，但紧随其后的 buffer 回放里的 tool_result 会把它清掉——客户端最终一致", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit(); // 快照已读（含 call_a）、tail 已读（还没有 tool_result）
    await handleSdkMessage(
      id,
      { type: "tool_call", call_id: "call_a", name: "shell", status: "completed", args: {}, result: "ok" } as never,
      { buffer: "", flush: async () => {} },
      () => true,
    );
    hang.release();

    const frames = await collect(
      await p,
      (fs) => fs.some((f) => label(f) === "event:tool_result:live"),
    );
    const labels = frames.map(label);
    // 快照先于这条 tool_result；而它是 buffer 里的实时帧（不是 replay）
    expect(labels.indexOf("tool_output_snapshot")).toBeLessThan(labels.indexOf("event:tool_result:live"));
    expect(outputsOf(snapshotOf(frames)).map((o) => o.callId)).toEqual(["call_a"]);

    let live = EMPTY_LIVE_TOOL_OUTPUTS;
    for (const f of frames) {
      if (f.type === "event") live = reduceLiveToolOutputs(live, f.event as never);
      else if (f.type === "tool_output_snapshot") live = replaceLiveToolOutputs(live, outputsOf(f));
    }
    expect(live).toEqual(EMPTY_LIVE_TOOL_OUTPUTS);
    // 之后的新订阅者拿到的是空快照（emitToolResult 已经丢了）
    expect(getLiveShellOutputSnapshot(id)).toEqual([]);
  });

  it("同一条事件既在 tail 里又在 buffer 里（先落盘、订阅后才 publish）：只发一帧、且是 replay 那一帧（去重不丢不重）", async () => {
    const id = await alloc();
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    // 先落盘（tail 里有）、但 publish 要等订阅之后才发
    const persisted = await appendEvent(id, {
      kind: "tool_result",
      text: "工具完成 shell",
      meta: { callId: "call_a", name: "shell", status: "success", output: "ok" },
    });
    expect(persisted).not.toBeNull();

    const hang = installHang("getTaskWithTailEvents.afterHydrate");
    const p = watch(id);
    await hang.waitHit();
    publish(id, { kind: "event", event: persisted! });
    onDelta(stdout(burst("after", 1))); // 用一个后续增量当「流已经转直通」的哨兵
    hang.release();

    const frames = await collect(await p, (fs) => deltaFrames(fs).length > 0);
    const results = frames.filter(
      (f) => f.type === "event" && (f.event as { kind: string }).kind === "tool_result",
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.replay).toBe(true);
    // 快照里没有 call_a（tail 里已有它的 tool_result）
    expect(outputsOf(snapshotOf(frames))).toEqual([]);
  });

  it("快照帧永远排在 tail 回放之后、buffer 回放之前：即使 tail 很长（多条事件）也不会插进回放中间", async () => {
    const id = await alloc();
    for (let i = 0; i < 12; i += 1) await appendEvent(id, { kind: "user_reply", text: `第 ${i} 条` });
    const onDelta = createShellOutputDeltaPublisher(id, () => true);
    onDelta(started("call_a"));
    onDelta(stdout(burst("a", 2)));
    const frames = await collect(await watch(id), hasThinkingSnapshot);
    const labels = frames.map(label);
    const lastReplay = labels.lastIndexOf("event:user_reply:replay");
    expect(labels.filter((l) => l === "event:user_reply:replay")).toHaveLength(12);
    expect(labels.indexOf("tool_output_snapshot")).toBeGreaterThan(lastReplay);
    expect(labels.filter((l) => l === "tool_output_snapshot")).toHaveLength(1);
  });
});
