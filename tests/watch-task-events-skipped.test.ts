/**
 * Task.eventsSkipped 的服务端派生与传递（Q9-08）：hydrate → meta 不落盘 → watch-task bootstrap 帧 → 真实客户端解析
 *
 * 读 events.jsonl 遇到坏行（崩溃半行 / 全 0 填充）：读取层只负责统计（见 events-bad-lines.test.ts），
 * 这里钉的是「统计怎么变成界面看得到的东西」：
 *   A. getTask（全量读）/ getTaskWithTailEvents（尾部读）都把条数放进 task.eventsSkipped；干净任务**没有**这个字段
 *   B. 各个 setter（这里用 setTaskPinned）的返回值也带——mutation 响应不会把提示冲掉；
 *      而 meta.json / meta.json.bak 里**没有**它（运行时派生、不落盘）
 *   C. watch-task 路由 bootstrap 的 `task` 帧带 eventsSkipped（干净任务不带）；
 *      路由的真实字节流喂给真实客户端解析（watchTaskStream）：onTaskUpdate 拿到的 task 带它
 *   D. 路由整个过程不往 console.error 吐东西（bootstrap 失败 / listener 抛错会走它）
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 夹具沿用 watch-task-storage-degraded.test.ts（同一套路由 / 客户端接法）。
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

import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-watch-events-skipped-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const core = await import("@/lib/server/task-fs-core");
const {
  createTask,
  getTask,
  getTaskWithTailEvents,
  listTasks,
  setTaskPinned,
} = await import("@/lib/server/task-fs");
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { watchTaskStream } = await import("@/lib/task-store");

if (!core.taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`watch-task-events-skipped DATA_DIR 未隔离到 TMP：${core.taskDir("probe")}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};
await listTasks();
skipBootRecovery();

afterAll(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

type Frame = { type: string; [k: string]: unknown };
const WAIT_MS = 3000;

let errorSpy: MockInstance<typeof console.error>;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  skipBootRecovery();
  core.__resetSkippedEventLinesWarnedForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  const serverErrors = errorSpy.mock.calls.map((args) => args.map(String).join(" "));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(serverErrors).toEqual([]);
});

const eventsFile = (taskId: string): string =>
  path.join(core.taskDir(taskId), core.EVENTS_FILE);
const metaFile = (taskId: string): string => path.join(core.taskDir(taskId), core.META_FILE);

const evLine = (ev: TaskEvent): string => JSON.stringify(ev) + "\n";
const mkEv = (kind: TaskEvent["kind"], text: string): TaskEvent => ({
  id: core.newEventId(),
  ts: Date.now(),
  kind,
  text,
});

/** 建一个 chat 任务（全新 taskId），events.jsonl 里放 e1、一条坏行、e2 */
const mkTaskWithBadLine = async (): Promise<string> => {
  const t = await createTask({ title: "坏行任务", mode: "chat" } as never);
  await fsp.writeFile(
    eventsFile(t.id),
    evLine(mkEv("info", "e1")) + "{bad half line\n" + evLine(mkEv("info", "e2")),
  );
  return t.id;
};

/** 干净任务：只有两条正常事件 */
const mkCleanTask = async (): Promise<string> => {
  const t = await createTask({ title: "干净任务", mode: "chat" } as never);
  await fsp.writeFile(
    eventsFile(t.id),
    evLine(mkEv("info", "e1")) + evLine(mkEv("info", "e2")),
  );
  return t.id;
};

describe("A. hydrate：task.eventsSkipped", () => {
  it("getTask（全量读）：有坏行 → 条数；事件列表不含坏行", async () => {
    const id = await mkTaskWithBadLine();
    const task = await getTask(id);
    expect(task?.eventsSkipped).toBe(1);
    expect(task?.events.map((e) => e.text)).toEqual(["e1", "e2"]);
  });

  it("getTaskWithTailEvents（尾部读）：有坏行 → 条数", async () => {
    const id = await mkTaskWithBadLine();
    const task = await getTaskWithTailEvents(id, 50);
    expect(task?.eventsSkipped).toBe(1);
    expect(task?.events.map((e) => e.text)).toEqual(["e1", "e2"]);
  });

  it("干净任务：两条读路径都没有 eventsSkipped 字段", async () => {
    const id = await mkCleanTask();
    const full = await getTask(id);
    const tail = await getTaskWithTailEvents(id, 50);
    expect(full).not.toBeNull();
    expect(tail).not.toBeNull();
    expect("eventsSkipped" in full!).toBe(false);
    expect("eventsSkipped" in tail!).toBe(false);
  });
});

describe("B. 运行时派生、不落盘", () => {
  it("setter（setTaskPinned）的返回值带 eventsSkipped；meta.json / meta.json.bak 里没有它", async () => {
    const id = await mkTaskWithBadLine();
    const pinned = await setTaskPinned(id, true);
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.eventsSkipped).toBe(1); // mutation 响应也带：提示不会被它冲掉

    // 再来一次：第二次 setter 会让 meta 滚出 .bak
    await setTaskPinned(id, false);

    const metaText = await fsp.readFile(metaFile(id), "utf-8");
    expect(metaText).not.toContain("eventsSkipped");
    const bak = await fsp.readFile(path.join(core.taskDir(id), core.META_BACKUP_FILE), "utf-8").catch(
      () => "",
    );
    expect(bak).not.toContain("eventsSkipped");
  });
});

// ---------------------------------------------------------------------------
// C. watch-task 路由
// ---------------------------------------------------------------------------

const callRoute = (taskId: string): Promise<Response> =>
  GET(new Request(`http://local/api/tasks/${taskId}/watch-task?tail=50`), {
    params: Promise.resolve({ id: taskId }),
  });

/** 连上 watch-task，读到 bootstrap 的最后一帧（thinking_snapshot）为止，返回收到的全部帧 */
const readBootstrap = async (taskId: string): Promise<Frame[]> => {
  const res = await callRoute(taskId);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  closers.push(async () => {
    await reader.cancel().catch(() => {});
  });
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  const deadline = performance.now() + WAIT_MS;
  while (!frames.some((f) => f.type === "thinking_snapshot")) {
    if (performance.now() > deadline) {
      throw new Error(`等 bootstrap 超时；已收到：[${frames.map((f) => f.type).join(", ")}]`);
    }
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
  return frames;
};

describe("C. watch-task bootstrap 帧", () => {
  it("有坏行：bootstrap 的 task 帧带 eventsSkipped（events 走 event 帧、坏行不在其中）", async () => {
    const id = await mkTaskWithBadLine();
    const frames = await readBootstrap(id);
    const taskFrame = frames.find((f) => f.type === "task");
    expect(taskFrame).toBeDefined();
    expect((taskFrame!.task as Task).eventsSkipped).toBe(1);
    const evTexts = frames
      .filter((f) => f.type === "event")
      .map((f) => (f.event as TaskEvent).text);
    expect(evTexts).toEqual(["e1", "e2"]);
  });

  it("干净任务：task 帧里没有 eventsSkipped", async () => {
    const id = await mkCleanTask();
    const frames = await readBootstrap(id);
    const taskFrame = frames.find((f) => f.type === "task");
    expect(taskFrame).toBeDefined();
    expect("eventsSkipped" in (taskFrame!.task as object)).toBe(false);
  });

  it("路由的真实字节流喂给真实客户端解析（watchTaskStream）：onTaskUpdate 拿到的 task 带 eventsSkipped", async () => {
    const id = await mkTaskWithBadLine();
    const res = await callRoute(id);
    const routeReader = res.body!.getReader();
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
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
      }),
    );

    const tasks: Task[] = [];
    const done = watchTaskStream(id, { onTaskUpdate: (t) => tasks.push(t) }, ctrl.signal);
    closers.push(async () => {
      ctrl.abort();
      await done.catch(() => {});
    });

    const deadline = performance.now() + WAIT_MS;
    while (tasks.length === 0) {
      if (performance.now() > deadline) throw new Error("等 onTaskUpdate 超时");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(tasks[0]!.eventsSkipped).toBe(1);
  });
});
