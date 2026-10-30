/**
 * watch-task 路由：存储降级（R14 B2-2 / Q9-01 = Q15-02）的 SSE 帧 `storage_degraded`。
 *
 * 背景：事件写盘失败（磁盘满 / 只读 / IO 错误）时，服务端不再静默丢事件——没落盘的事件仍推给在线界面，
 * 任务进入「存储降级」状态（task-stream 里的纯内存状态机），界面顶部据 SSE 的 `storage_degraded` 帧画红条，
 * 存储恢复后红条自动消失。本文件只测**路由这一层**（状态机本身的转移规则由 task-stream 的降级用例钉）：
 * 真实路由 + 真实 writeOwnedEventAndPublish / publish / 订阅 + 临时数据目录；
 * 写盘失败靠对 node:fs 的 promises.appendFile 打 spy——只对目标任务的 events.jsonl 抛 errno，其余调用原样转发真实实现。
 *
 * 钉死：
 *   1. bootstrap **无条件**补一帧当前值（与 background_subagents 同段、紧跟其后、早于两个 snapshot 帧）：
 *      没降级 / 已恢复 = {degraded:false}（不带 code 字段）；降级中 = {degraded:true, code}，code 取自当前降级记录；
 *      不依赖任务有没有事件；
 *   2. 恢复带粘滞（距最近一次失败 <10s 的成功写不算恢复）——bootstrap 反映的就是服务端当前值；
 *   3. 实时转发：连上之后触发降级 → 没落盘的事件（无 seq）→ {degraded:true, code} → toast；
 *      恢复 → 带 seq 的事件 → {degraded:false}；内存帧缺 code / code 为空串时 SSE 帧不带 code 字段；
 *   4. 断线重连：新连接没见过那几帧实时帧，bootstrap 照样对齐（降级中补 true、断线期间已恢复补 false）；
 *      没落盘的事件重连后不在 tail 里（刷新读不回来——红条是唯一提示）；
 *   5. 路由的真实字节流喂给真实客户端解析（watchTaskStream）：onStorageDegraded / onError 回调序列端到端对得上。
 *
 * 时间：恢复靠 `vi.useFakeTimers({ toFake: ["Date"] })`（只 fake Date，不碰 setTimeout / fs）+ `vi.setSystemTime` 推进；
 * 必须在 createTask 之后才开。等待流上的帧一律用真实 setTimeout 轮询 + performance.now 计时（都不受 fake Date 影响）。
 */
import { mkdtempSync, promises as fsp, rmSync } from "node:fs";
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
  type MockInstance,
} from "vitest";

import {
  describeStorageDegraded,
  type StorageDegradedState,
} from "@/lib/storage-degraded";
import type { TaskStreamEvent } from "@/lib/server/task-stream";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-watch-storage-degraded-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const core = await import("@/lib/server/task-fs-core");
const { createTask, listTasks } = await import("@/lib/server/task-fs");
const taskStream = await import("@/lib/server/task-stream");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");

if (!core.taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `watch-task-storage-degraded DATA_DIR 未隔离到 TMP：${core.taskDir("probe")}`,
  );
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};
await listTasks();
skipBootRecovery();

afterAll(async () => {
  // 没人 await 的落盘（meta touch / seq sidecar）常在最后一个用例之后才落完：先让出一小段再删目录
  await new Promise<void>((r) => setTimeout(r, 50));
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// ---------------------------------------------------------------------------
// 夹具：写盘失败开关 / 任务 / 假时间
// ---------------------------------------------------------------------------

type Frame = { type: string; [k: string]: unknown };

const WAIT_MS = 3000;

/** spyOn 之前先存真实实现：不该失败的调用（别的任务、别的文件）原样转发给它 */
const realAppend = fsp.appendFile.bind(fsp);

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: 测试注入的写盘失败`), { code });

/** 非 null = 该文件的 appendFile 抛 code；只在 writeFail 内部短暂打开 */
let failing: { file: string; code: string } | null = null;
let errorSpy: MockInstance<typeof console.error>;

const eventsFile = (taskId: string): string =>
  path.join(core.taskDir(taskId), "events.jsonl");

beforeEach(() => {
  skipBootRecovery();
  taskStream.__resetStorageDegradedForTests();
  failing = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(fsp, "appendFile").mockImplementation(((...args: unknown[]) => {
    if (failing !== null && args[0] === failing.file) {
      return Promise.reject(errno(failing.code));
    }
    return (realAppend as (...a: unknown[]) => Promise<void>)(...args);
  }) as never);
});

const openWatchers: Array<{ close: () => Promise<void> }> = [];
const openClients: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const w of openWatchers.splice(0)) await w.close();
  for (const stop of openClients.splice(0)) await stop();
  // 先取出服务端有没有吐过 console.error（bootstrap 失败 / listener 抛错都会走它），再还原 mock
  const serverErrors = errorSpy.mock.calls.map((args) =>
    args.map(String).join(" "),
  );
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  taskStream.__resetStorageDegradedForTests();
  core.__setAppendRetrySleepForTests();
  expect(serverErrors).toEqual([]);
});

/** 每个用例自己建任务（全新 taskId） */
const mk = async (title: string): Promise<string> => {
  const t = await createTask({ title, mode: "chat" } as never);
  return t.id;
};

/** 成功写一条 best-effort 事件（磁盘正常）；返回落盘后的事件 */
const writeOk = async (taskId: string, text: string): Promise<TaskEvent> => {
  const ev = await taskStream.writeOwnedEventAndPublish(taskId, () => true, {
    kind: "info",
    text,
  });
  if (!ev) throw new Error(`writeOk 返回了 null（任务 ${taskId}）`);
  return ev;
};

/**
 * 让该任务的 events.jsonl 写盘抛 code 并写一条 best-effort 事件（= 置存储降级标志）；写完立刻把磁盘「修好」。
 * 失败写必须返回 null——若竟然成功了，说明 spy 没生效，直接抛错、别让后面的断言空转。
 */
const writeFail = async (
  taskId: string,
  code = "ENOSPC",
  text = "没落盘的一条",
): Promise<void> => {
  failing = { file: eventsFile(taskId), code };
  try {
    const r = await taskStream.writeOwnedEventAndPublish(taskId, () => true, {
      kind: "info",
      text,
    });
    if (r !== null) throw new Error("writeFail：写盘失败没生效（spy 没拦住）");
  } finally {
    failing = null;
  }
};

/** 把假 Date 往后拨 ms（须先 vi.useFakeTimers({ toFake: ["Date"] })） */
const advance = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms);
};

// ---------------------------------------------------------------------------
// 夹具：SSE 连接
// ---------------------------------------------------------------------------

/** 一行描述一帧，断言序列方便、超时报错也好读 */
const brief = (f: Frame): string => {
  if (f.type === "event") {
    const e = f.event as { kind: string; seq?: number };
    return `event:${e.kind}${e.seq === undefined ? "(无seq)" : `#${e.seq}`}`;
  }
  if (f.type === "storage_degraded") {
    return `sd:${String(f.degraded)}${typeof f.code === "string" ? `/${f.code}` : ""}`;
  }
  return f.type;
};

/** 轮询等 cond 成立：真实 setTimeout + performance.now 计时，不受 fake Date 影响；超时抛错并附 dump() */
const until = async (
  what: string,
  cond: () => boolean,
  dump: () => string,
): Promise<void> => {
  const deadline = performance.now() + WAIT_MS;
  while (!cond()) {
    if (performance.now() > deadline) {
      throw new Error(`等「${what}」超时；${dump()}`);
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
};

const sdFrames = (frames: Frame[]): Frame[] =>
  frames.filter((f) => f.type === "storage_degraded");

const callRoute = (taskId: string): Promise<Response> =>
  GET(new Request(`http://local/api/tasks/${taskId}/watch-task?tail=50`), {
    params: Promise.resolve({ id: taskId }),
  });

interface Watcher {
  /** bootstrap 的全部帧（连上并读到最后一帧 thinking_snapshot 那一刻的快照） */
  boot: () => Frame[];
  /** bootstrap 之后收到的帧（实时帧） */
  live: () => Frame[];
  /** 等实时帧满足 pred */
  waitLive: (what: string, pred: (live: Frame[]) => boolean) => Promise<void>;
  /** 断开：reader.cancel() 触发路由的 cleanup（退订） */
  close: () => Promise<void>;
}

/** 连上 watch-task、持续读 SSE，直到 bootstrap 读完（见到最后一帧 thinking_snapshot）才返回 */
const openWatch = async (taskId: string): Promise<Watcher> => {
  const res = await callRoute(taskId);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (line) frames.push(JSON.parse(line.slice(5).trimStart()) as Frame);
        }
      }
    } catch {
      /* reader.cancel() 之后的读错误：pump 结束即可 */
    }
  })();

  let liveFrom = 0;
  let closed = false;
  const dump = (): string => `已收到：[${frames.map(brief).join(", ")}]`;
  const watcher: Watcher = {
    boot: () => frames.slice(0, liveFrom),
    live: () => frames.slice(liveFrom),
    waitLive: (what, pred) =>
      until(what, () => pred(frames.slice(liveFrom)), dump),
    close: async () => {
      if (closed) return;
      closed = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
  openWatchers.push(watcher);
  await until(
    "bootstrap 的最后一帧 thinking_snapshot",
    () => frames.some((f) => f.type === "thinking_snapshot"),
    dump,
  );
  liveFrom = frames.length;
  return watcher;
};

/**
 * 把路由的真实 Response 当作 fetch 的返回交给 watchTaskStream：
 * 套一层转发流，abort 时主动取消路由那端的 reader——否则被 stub 的 fetch 不理会 signal、
 * watchTaskStream 的 read() 永远挂着（同时也是路由那端退订的触发点）
 */
const routeAsFetch = (res: Response) => {
  const routeReader = res.body!.getReader();
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    init?.signal?.addEventListener(
      "abort",
      () => void routeReader.cancel().catch(() => {}),
      { once: true },
    );
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

interface Client {
  /** onStorageDegraded 的回调序列 */
  states: Array<StorageDegradedState | null>;
  /** onError（error 帧 = toast）的回调序列 */
  toasts: string[];
  waitStates: (n: number) => Promise<void>;
}

/** 路由 → 真实客户端解析（watchTaskStream）；用例结束由 afterEach 统一 abort + 退订 */
const openClient = async (taskId: string): Promise<Client> => {
  vi.stubGlobal("fetch", routeAsFetch(await callRoute(taskId)));
  const ctrl = new AbortController();
  const states: Array<StorageDegradedState | null> = [];
  const toasts: string[] = [];
  const done = watchTaskStream(
    taskId,
    {
      onStorageDegraded: (s) => states.push(s),
      onError: (m) => toasts.push(m),
    },
    ctrl.signal,
  );
  openClients.push(async () => {
    ctrl.abort();
    await done.catch(() => {});
  });
  return {
    states,
    toasts,
    waitStates: (n) =>
      until(
        `onStorageDegraded 累计 ${n} 次`,
        () => states.length >= n,
        () => `states=${JSON.stringify(states)} toasts=${JSON.stringify(toasts)}`,
      ),
  };
};

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("bootstrap：无条件补发一帧 storage_degraded", () => {
  // 守 route.ts bootstrap 里「getStorageDegraded → send」那段：没降级也发（客户端据此清掉断线前残留的红条）
  it("没降级（空任务、没有任何事件）：照样补一帧 {degraded:false}，且不带 code 字段", async () => {
    const id = await mk("sd-clean-empty");
    const w = await openWatch(id);

    const sd = sdFrames(w.boot());
    expect(sd).toEqual([{ type: "storage_degraded", degraded: false }]);
    // toEqual 对 undefined 属性宽松：再按字段名钉一次，防「没降级时带一个空 code」
    expect(Object.keys(sd[0]!).sort()).toEqual(["degraded", "type"]);
  });

  // 守补帧的位置（route.ts 里紧跟 background_subagents 那段、早于两个 snapshot）与「不依赖任务有没有事件」
  it("没降级但任务有历史事件：每次连接恰好一帧；位置紧跟在 background_subagents 之后、早于 assistant_snapshot / thinking_snapshot，在 tail 事件之后", async () => {
    const id = await mk("sd-clean-with-events");
    await writeOk(id, "历史一");
    await writeOk(id, "历史二");

    const w = await openWatch(id);
    const types = w.boot().map((f) => f.type);

    expect(sdFrames(w.boot())).toEqual([
      { type: "storage_degraded", degraded: false },
    ]);
    const at = types.indexOf("storage_degraded");
    expect(at).toBe(types.indexOf("background_subagents") + 1);
    expect(at).toBeLessThan(types.indexOf("assistant_snapshot"));
    expect(at).toBeLessThan(types.indexOf("thinking_snapshot"));
    // tail 回放的历史事件都在它前面（对照：事件确实被回放了，不是空 tail 上的巧合）
    const replayedTexts = w
      .boot()
      .filter((f) => f.type === "event")
      .map((f) => (f.event as { text?: string }).text);
    expect(replayedTexts).toEqual(expect.arrayContaining(["历史一", "历史二"]));
    expect(types.lastIndexOf("event")).toBeLessThan(at);
  });

  // 守补帧的 code 取值（来自 getStorageDegraded(id).code）：三个码各跑一遍，写死任何一个常量都会红
  it.each(["ENOSPC", "EROFS", "EIO"])(
    "降级中（%s）：补 {degraded:true, code}，code 取自当前降级记录（不是写死的常量）",
    async (code) => {
      const id = await mk(`sd-degraded-${code}`);
      await writeFail(id, code);
      // 前置：标志确已置位（防夹具没造成立就去断言 bootstrap）
      expect(taskStream.getStorageDegraded(id)).toEqual({ code });

      const w = await openWatch(id);

      expect(sdFrames(w.boot())).toEqual([
        { type: "storage_degraded", degraded: true, code },
      ]);
    },
  );

  // 守补帧的 degraded 取值：恢复后 getStorageDegraded 为 null → 补 false（task-stream 的 clearStorageDegradedOnCommit，距最近失败 ≥10s）
  it("已恢复（失败后过了 ≥10s 再成功写一次）：补 {degraded:false}、不带 code——不是「有过失败记录就补 true」", async () => {
    const id = await mk("sd-recovered");
    vi.useFakeTimers({ toFake: ["Date"] }); // createTask 之后才开
    await writeFail(id);
    advance(10_000);
    await writeOk(id, "恢复后的一条");
    expect(taskStream.getStorageDegraded(id)).toBeNull(); // 前置：已恢复

    const w = await openWatch(id);

    const sd = sdFrames(w.boot());
    expect(sd).toEqual([{ type: "storage_degraded", degraded: false }]);
    expect(Object.keys(sd[0]!).sort()).toEqual(["degraded", "type"]);
  });

  // 守 bootstrap 反映的是服务端「粘滞之后」的当前值（STORAGE_RECOVER_STICKY_MS = 10s；粘滞内的成功写不算恢复、也不刷新最近失败时刻）
  it("粘滞窗口内（失败后不足 10s 的成功写不算恢复）：新连接仍补 {degraded:true, code}；再过窗口、成功写一次后才补 degraded:false", async () => {
    const id = await mk("sd-sticky");
    vi.useFakeTimers({ toFake: ["Date"] });
    await writeFail(id, "EROFS");
    advance(9_000);
    await writeOk(id, "粘滞窗口内的成功写");
    expect(taskStream.getStorageDegraded(id)).toEqual({ code: "EROFS" }); // 前置：红条还在

    const w1 = await openWatch(id);
    expect(sdFrames(w1.boot())).toEqual([
      { type: "storage_degraded", degraded: true, code: "EROFS" },
    ]);
    await w1.close();

    // 距最近一次失败累计 11s（粘滞内那次成功写不刷新「最近失败」时刻）
    advance(2_000);
    await writeOk(id, "窗口之后的成功写");
    const w2 = await openWatch(id);
    expect(sdFrames(w2.boot())).toEqual([
      { type: "storage_degraded", degraded: false },
    ]);
  });
});

describe("实时转发：storage_degraded 内存帧 → SSE 帧", () => {
  // 守 route.ts dispatchStreamEvent 里 `case "storage_degraded"` 那一支（bootstrap 之后走 liveDispatch 直通）
  it("连上之后触发降级：依次收到「没落盘的事件（无 seq、不带 replay）→ {degraded:true, code} → error toast」", async () => {
    const id = await mk("sd-live-degrade");
    const w = await openWatch(id);
    expect(sdFrames(w.boot())).toEqual([
      { type: "storage_degraded", degraded: false },
    ]);

    await writeFail(id, "ENOSPC", "没落盘的一条");
    await w.waitLive(
      "降级的三帧（事件 / storage_degraded / toast）",
      (live) => live.some((f) => f.type === "error"),
    );

    const live = w.live();
    expect(live.map(brief)).toEqual([
      "event:info(无seq)",
      "sd:true/ENOSPC",
      "error",
    ]);
    // 事件帧：没落盘的内容照样推给在线的人；是实时事件，不带 replay
    expect(live[0]).not.toHaveProperty("replay");
    expect((live[0]!.event as { text: string }).text).toBe("没落盘的一条");
    // 状态帧：只有 type / degraded / code
    expect(live[1]).toEqual({
      type: "storage_degraded",
      degraded: true,
      code: "ENOSPC",
    });
    // toast：与红条标题同一份文案
    expect(live[2]).toEqual({
      type: "error",
      message: describeStorageDegraded("ENOSPC").title,
    });
  });

  // 守恢复帧的转发：{degraded:false} 不带 code 字段，且排在那条成功落盘的（带 seq 的）事件帧之后
  it("降级后恢复（推进 ≥10s 再成功写）：先收到带 seq 的事件帧，再收到 {degraded:false}（不带 code 字段）", async () => {
    const id = await mk("sd-live-recover");
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = await openWatch(id);
    await writeFail(id);
    await w.waitLive("降级的三帧", (live) =>
      live.some((f) => f.type === "error"),
    );
    const mark = w.live().length;

    advance(10_000);
    const ok = await writeOk(id, "恢复后的一条");
    await w.waitLive("恢复帧 {degraded:false}", (live) =>
      live.some((f) => f.type === "storage_degraded" && f.degraded === false),
    );

    const after = w.live().slice(mark);
    expect(typeof ok.seq).toBe("number");
    expect(after.map(brief)).toEqual([`event:info#${ok.seq}`, "sd:false"]);
    expect(after[1]).toEqual({ type: "storage_degraded", degraded: false });
    expect(Object.keys(after[1]!).sort()).toEqual(["degraded", "type"]);
  });

  type SdMemoryFrame = Extract<TaskStreamEvent, { kind: "storage_degraded" }>;
  const FRAME_MAPPING: Array<[string, SdMemoryFrame, Frame]> = [
    [
      "降级帧带 code → SSE 帧带 code",
      { kind: "storage_degraded", degraded: true, code: "EROFS" },
      { type: "storage_degraded", degraded: true, code: "EROFS" },
    ],
    [
      "降级帧缺 code → SSE 帧不带 code 字段",
      { kind: "storage_degraded", degraded: true },
      { type: "storage_degraded", degraded: true },
    ],
    [
      "降级帧 code 为空串 → 同样不带 code 字段（空串不算 code）",
      { kind: "storage_degraded", degraded: true, code: "" },
      { type: "storage_degraded", degraded: true },
    ],
    [
      "恢复帧（无 code）→ degraded:false、不带 code 字段",
      { kind: "storage_degraded", degraded: false },
      { type: "storage_degraded", degraded: false },
    ],
  ];

  // 直接 publish 内存帧、不经写盘：只测路由的字段映射（code 缺省 / 空串不带字段）
  it.each(FRAME_MAPPING)(
    "内存帧 → SSE 帧的映射：%s",
    async (_name, memoryFrame, expected) => {
      const id = await mk("sd-mapping");
      const w = await openWatch(id);

      taskStream.publish(id, memoryFrame);
      await w.waitLive("转发出来的 storage_degraded 帧", (live) =>
        live.some((f) => f.type === "storage_degraded"),
      );

      const frame = w.live().find((f) => f.type === "storage_degraded");
      expect(frame).toEqual(expected);
      // 字段名也钉死（防「总带一个 code: ''」之类 toEqual 看不出来的多余字段）
      expect(Object.keys(frame ?? {}).sort()).toEqual(
        Object.keys(expected).sort(),
      );
    },
  );
});

describe("断线重连：新连接的 bootstrap 与当前状态对齐", () => {
  // 守 route.ts 注释里点名的两个场景：降级中不补 → 看不到红条；已恢复不补 → 断线前的红条一直挂着
  it("降级中断开再连：新连接没见过那几帧实时帧，bootstrap 仍补 {degraded:true, code}；没落盘的事件不在 tail 里（刷新后读不回来）", async () => {
    const id = await mk("sd-reconnect-degraded");
    const kept = await writeOk(id, "已落盘的历史");

    const a = await openWatch(id);
    await writeFail(id, "ENOSPC", "没落盘的一条");
    await a.waitLive("降级的三帧", (live) =>
      live.some((f) => f.type === "error"),
    );
    const lostFrame = a.live().find((f) => f.type === "event");
    expect(lostFrame).toBeDefined();
    const lostId = (lostFrame!.event as { id: string }).id;
    await a.close(); // 断线

    const b = await openWatch(id);
    expect(sdFrames(b.boot())).toEqual([
      { type: "storage_degraded", degraded: true, code: "ENOSPC" },
    ]);
    // 重连后的 tail 里有真正落盘的那条历史、没有没落盘的那条：它读不回来，红条是用户唯一的提示
    const replayedIds = b
      .boot()
      .filter((f) => f.type === "event")
      .map((f) => (f.event as { id: string }).id);
    expect(replayedIds).toContain(kept.id);
    expect(replayedIds).not.toContain(lostId);
  });

  it("断线期间已恢复：重连的 bootstrap 补 {degraded:false}（断线前的红条不会一直挂着）", async () => {
    const id = await mk("sd-reconnect-recovered");
    vi.useFakeTimers({ toFake: ["Date"] });

    const a = await openWatch(id);
    await writeFail(id);
    await a.waitLive("降级的三帧", (live) =>
      live.some((f) => f.type === "error"),
    );
    await a.close(); // 断线，客户端停在「红条」

    advance(10_000);
    await writeOk(id, "断线期间恢复了");
    expect(taskStream.getStorageDegraded(id)).toBeNull(); // 前置

    const b = await openWatch(id);
    expect(sdFrames(b.boot())).toEqual([
      { type: "storage_degraded", degraded: false },
    ]);
  });
});

describe("端到端：路由的字节流 → 真实客户端解析（watchTaskStream）", () => {
  // 守路由输出的帧形状与客户端解析契约（degraded 必须是布尔、字段名一致）：形状一变，客户端会整帧丢弃
  it("没降级：客户端收到 onStorageDegraded(null)（bootstrap 无条件补发，据此清掉本地残留的红条）", async () => {
    const id = await mk("sd-e2e-clean");
    const client = await openClient(id);

    await client.waitStates(1);

    expect(client.states).toEqual([null]);
    expect(client.toasts).toEqual([]);
  });

  it("降级中连接：onStorageDegraded({code})；之后恢复：onStorageDegraded(null)", async () => {
    const id = await mk("sd-e2e-degraded-then-recover");
    vi.useFakeTimers({ toFake: ["Date"] });
    await writeFail(id, "EROFS");

    const client = await openClient(id);
    await client.waitStates(1);
    expect(client.states).toEqual([{ code: "EROFS" }]);

    advance(10_000);
    await writeOk(id, "恢复后的一条");
    await client.waitStates(2);

    expect(client.states).toEqual([{ code: "EROFS" }, null]);
  });

  it("连接后才降级：onStorageDegraded 序列 null → {code}，toast 经 onError 到达且是红条标题的同一份文案", async () => {
    const id = await mk("sd-e2e-live-degrade");
    const client = await openClient(id);
    await client.waitStates(1);

    await writeFail(id, "ENOSPC");
    await client.waitStates(2);
    await until(
      "onError 收到 toast",
      () => client.toasts.length >= 1,
      () => `toasts=${JSON.stringify(client.toasts)}`,
    );

    expect(client.states).toEqual([null, { code: "ENOSPC" }]);
    expect(client.toasts).toEqual([describeStorageDegraded("ENOSPC").title]);
  });
});
