/**
 * 300 条窗口一致性 · 回退标记被挤出窗口（第三轮 review D9-04）
 *
 * 事实：chat 回退（rewind）会删掉服务端事件日志的后半段，客户端靠回退 info 事件上的标记截掉本地对应部分。
 * 但标记事件只是日志里普通的一条——回退之后又产生了 300+ 条事件（一轮长 run 很常见），B 窗口恰好在这期间
 * 断线、重连时拿到的 bootstrap 尾部窗口里就没有标记了：本地「只追加」的合并没有任何信号，
 * 被回退删掉的 `u2` / `a2-deleted` 继续留在界面上，排在新事件前面，刷新页面才对。
 *
 * 修法：回退路由把「最近一次回退」落进 meta（`lastRewind`），随 task 快照（含 SSE bootstrap 的 task 帧）下发；
 * 客户端发现「本地没见过的、更新的 lastRewind」且本地没有它的标记事件 → 本地窗口不可信 → 完整重新拉取并整体替换。
 *
 * 钉死：
 *   1. lastRewindNeedsResync 的判定（幂等、不死循环——之后每一帧 task 都带着 lastRewind）；
 *   2. D9-04 原样复现：真实 watch-task 路由 + 真实 bootstrap 帧 + 真实合并 / 替换函数，B 最终与服务端一致；
 *   3. lastRewind 随 meta 落盘并经 task 快照带出（setTaskLastRewind + getTaskWithTailEvents）；
 *   4. 回退者自己（applyRewoundResult）不会被自己的 lastRewind 触发多余的重拉。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import {
  appendTaskEvent,
  applyRewoundResult,
  lastRewindNeedsResync,
  mergeTaskEvents,
  replaceTaskEventsWithSnapshot,
} from "@/lib/task-store";
import { buildRewindMeta } from "@/lib/rewind-marker";
import type { LastRewind, Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-last-rewind-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { EVENTS_FILE, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { getTask, getTaskWithTailEvents, listTasks, setTaskLastRewind } = await import(
  "@/lib/server/task-fs"
);
const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
const { isTailAnchorEvent } = await import("@/lib/tail-anchor");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`last-rewind DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void> | undefined>)[RECOVERY_FLAG] =
  Promise.resolve();
await listTasks();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// ---------- 夹具 ----------

const makeTask = (events: TaskEvent[], extra?: Partial<Task>): Task =>
  ({
    id: "t_1",
    title: "t",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [],
    actions: [],
    mrs: [],
    createdAt: 0,
    updatedAt: 0,
    events,
    ...extra,
  }) as unknown as Task;

const ev = (
  id: string,
  ts: number,
  kind: TaskEvent["kind"] = "assistant_message",
  meta?: TaskEvent["meta"],
): TaskEvent => ({ id, ts, kind, text: id, ...(meta ? { meta } : {}) });

const LR: LastRewind = { fromEventId: "u2", keptCount: 2, markerEventId: "mk", ts: 1000 };

// ---------- 1. 判定 ----------

describe("lastRewindNeedsResync", () => {
  const prev = () =>
    makeTask([ev("u1", 1, "user_reply"), ev("a1", 2), ev("u2", 3, "user_reply"), ev("a2", 4)]);

  it("下一帧没有 lastRewind（没回退过 / 老服务端）→ 不动", () => {
    expect(lastRewindNeedsResync(prev(), makeTask([]))).toBe(false);
  });

  it("本地没见过这次回退、也没有它的标记事件 → 本地窗口不可信，要重拉", () => {
    expect(lastRewindNeedsResync(prev(), makeTask([], { lastRewind: LR }))).toBe(true);
  });

  it("本地已有标记事件（SSE 先到、已按标记截过）→ 不重拉", () => {
    const withMarker = makeTask(
      [ev("u1", 1, "user_reply"), ev("a1", 2), ev("mk", 1000, "info", buildRewindMeta({ fromEventId: "u2", keptCount: 2 }))],
    );
    expect(lastRewindNeedsResync(withMarker, makeTask([], { lastRewind: LR }))).toBe(false);
  });

  it("本地已知这次（或更新的）回退 → 不重拉：此后每一帧 task 都带着它，必须幂等不死循环", () => {
    expect(lastRewindNeedsResync(makeTask([ev("a", 1)], { lastRewind: LR }), makeTask([], { lastRewind: LR }))).toBe(false);
    // 迟到的旧快照带着更早的回退 → 也不动（本地已更新）
    expect(
      lastRewindNeedsResync(
        makeTask([ev("a", 1)], { lastRewind: { ...LR, ts: 2000 } }),
        makeTask([], { lastRewind: LR }),
      ),
    ).toBe(false);
  });

  it("标记写失败（markerEventId=null）的回退：同样靠 lastRewind 触发一次，对齐后不再触发", () => {
    const lr: LastRewind = { fromEventId: "u2", keptCount: 2, markerEventId: null, ts: 1000 };
    expect(lastRewindNeedsResync(prev(), makeTask([], { lastRewind: lr }))).toBe(true);
    const aligned = mergeTaskEvents(prev(), makeTask([], { lastRewind: lr }));
    expect(aligned.lastRewind).toEqual(lr);
    expect(lastRewindNeedsResync(aligned, makeTask([], { lastRewind: lr }))).toBe(false);
  });

  it("本地没有任何事件：没有什么会错，不重拉", () => {
    expect(lastRewindNeedsResync(makeTask([]), makeTask([], { lastRewind: LR }))).toBe(false);
  });

  it("合并 / 替换后 lastRewind 跟着 next 走（取更新的那条），后续帧不再触发", () => {
    const frame = makeTask([], { lastRewind: LR, updatedAt: 5 });
    const merged = mergeTaskEvents(prev(), frame);
    expect(merged.lastRewind).toEqual(LR);
    const replaced = replaceTaskEventsWithSnapshot(prev(), makeTask([ev("x", 2000)], { lastRewind: LR, updatedAt: 3000 }));
    expect(replaced.lastRewind).toEqual(LR);
    // next 比本地旧（updatedAt 更小）时走「过期快照不盖运行态」分支，lastRewind 也取更新的
    const staleBranch = replaceTaskEventsWithSnapshot(
      makeTask([ev("a", 1)], { updatedAt: 9000 }),
      makeTask([ev("x", 2000)], { lastRewind: LR, updatedAt: 3000 }),
    );
    expect(staleBranch.lastRewind).toEqual(LR);
  });
});

// ---------- 2. 回退者自己 ----------

describe("applyRewoundResult：回退者自己不被自己的 lastRewind 触发多余重拉", () => {
  it("据响应对齐本地后，本地带上同一条 lastRewind；随后到达的 task 帧（同一条）不重拉", () => {
    const local = makeTask([ev("u1", 1, "user_reply"), ev("a1", 2), ev("u2", 3, "user_reply"), ev("a2", 4)]);
    const { task, resync } = applyRewoundResult(local, {
      fromEventId: "u2",
      keptCount: 2,
      markerEventId: "mk",
      ts: 1000,
    });
    expect(resync).toBe(false);
    expect(task.events.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(task.lastRewind).toEqual({ fromEventId: "u2", keptCount: 2, markerEventId: "mk", ts: 1000 });
    expect(lastRewindNeedsResync(task, makeTask([], { lastRewind: LR }))).toBe(false);
  });

  it("响应没带 ts（旧服务端）：照旧对齐，不写 lastRewind（没有可比较的时间）", () => {
    const local = makeTask([ev("u1", 1, "user_reply"), ev("u2", 3, "user_reply")]);
    const { task } = applyRewoundResult(local, { fromEventId: "u2", keptCount: 1, markerEventId: null });
    expect(task.events.map((e) => e.id)).toEqual(["u1"]);
    expect(task.lastRewind).toBeUndefined();
  });
});

// ---------- 3. 服务端：落盘 + 经 task 快照带出 ----------

const ids: string[] = [];
const alloc = async (extra?: Partial<TaskMetaV06>): Promise<string> => {
  const id = `t_lr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta({
    id,
    title: "last-rewind",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as unknown as TaskMetaV06);
  return id;
};

const writeEvents = async (id: string, events: TaskEvent[]): Promise<void> => {
  await fs.mkdir(taskDir(id), { recursive: true });
  await fs.writeFile(
    path.join(taskDir(id), EVENTS_FILE),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
};

afterEach(async () => {
  for (const id of ids.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

describe("lastRewind 落 meta、随 task 快照带出", () => {
  it("setTaskLastRewind 落盘；getTask / getTaskWithTailEvents 都带 lastRewind；没回退过的任务没有这个字段", async () => {
    const id = await alloc();
    expect((await getTask(id))?.lastRewind).toBeUndefined();
    await setTaskLastRewind(id, { ...LR, markerEventId: "mk1" });
    expect((await getTask(id))?.lastRewind).toEqual({ ...LR, markerEventId: "mk1" });
    expect((await getTaskWithTailEvents(id, 10))?.lastRewind).toEqual({ ...LR, markerEventId: "mk1" });
  });

  it("后一次回退覆盖前一次；任务不存在时不抛", async () => {
    const id = await alloc();
    await setTaskLastRewind(id, LR);
    await setTaskLastRewind(id, { ...LR, ts: 5000, fromEventId: "u9" });
    expect((await getTask(id))?.lastRewind).toMatchObject({ ts: 5000, fromEventId: "u9" });
    await expect(setTaskLastRewind("t_not_exist", LR)).resolves.toBeUndefined();
  });
});

// ---------- 4. D9-04 原样复现 ----------

type Frame = { type: string; [k: string]: unknown };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const collect = async (res: Response, stop: (f: Frame[]) => boolean, ms = 4000): Promise<Frame[]> => {
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

describe("D9-04：回退标记被挤出 bootstrap 窗口，B 断线重连", () => {
  it("真实路由 bootstrap + 真实合并：B 本地的被删事件被清掉，最终与服务端窗口一致；之后的帧不再重拉", async () => {
    // 服务端日志：回退后保留 u1 a1，标记 mk，其后用户发了 u2b、AI 又跑了 303 条（标记被挤出窗口）。
    // 注意窗口是「补到最近一条 user_reply」的（A1）：最近一条是 u2b（在标记之后），所以窗口 = u2b 起的 304 条、
    // 不含标记——这正是 D9-04 的前提；若回退后没有新的 user_reply，锚点会落在标记之前、窗口反而含标记
    const marker = ev("mk", 1000, "info", buildRewindMeta({ fromEventId: "u2", keptCount: 2 }));
    const after: TaskEvent[] = [
      ev("u2b", 1001, "user_reply"),
      ...Array.from({ length: 303 }, (_, i) => ev(`n${i}`, 1002 + i)),
    ];
    const serverEvents = [ev("u1", 1, "user_reply"), ev("a1", 2), marker, ...after];
    const id = await alloc({ updatedAt: 1400, lastRewind: { ...LR, markerEventId: "mk" } } as Partial<TaskMetaV06>);
    await writeEvents(id, serverEvents);

    // B 在回退前加载的本地状态：含稍后被删的 u2 / a2-deleted
    const B0 = makeTask(
      [ev("u1", 1, "user_reply"), ev("a1", 2), ev("u2", 3, "user_reply"), ev("a2-deleted", 4)],
      { id, updatedAt: 4 },
    );

    // 重连：真实 watch-task 路由的 bootstrap 帧
    const res = await GET(new Request(`http://local/api/tasks/${id}/watch-task?tail=300`), {
      params: Promise.resolve({ id }),
    });
    const frames = await collect(res, (f) => f.some((x) => x.type === "thinking_snapshot"));
    const taskFrame = frames.find((f) => f.type === "task")!.task as Task;
    const replay = frames.filter((f) => f.type === "event").map((f) => f.event as TaskEvent);
    expect(taskFrame.lastRewind).toMatchObject({ fromEventId: "u2", markerEventId: "mk" });
    expect(replay).toHaveLength(304);
    expect(replay[0]!.id).toBe("u2b");
    expect(replay.some((e) => e.id === "mk")).toBe(false); // 复现前提：标记不在窗口里

    // —— 页面的处理顺序：absorbTask(task 帧) → 逐条 append → 若判定要重拉则整体替换 ——
    const needsResync = lastRewindNeedsResync(B0, taskFrame);
    expect(needsResync).toBe(true);
    let B = mergeTaskEvents(B0, taskFrame);
    for (const e of replay) B = appendTaskEvent(B, e);
    // 重拉之前：被删事件确实还在（这就是 D9-04 的现象，也是为什么必须重拉）
    expect(B.events.some((e) => e.id === "u2")).toBe(true);

    const fetched = await getTaskWithTailEvents(id, 300, { anchor: isTailAnchorEvent });
    expect(fetched).toBeTruthy();
    B = replaceTaskEventsWithSnapshot(B, fetched!);

    const ids2 = B.events.map((e) => e.id);
    expect(ids2).not.toContain("u2");
    expect(ids2).not.toContain("a2-deleted");
    expect(ids2).toEqual(fetched!.events.map((e) => e.id)); // 与服务端窗口完全一致、无重复
    expect(new Set(ids2).size).toBe(ids2.length);

    // 之后每一帧 task（中途帧 / done / mutation 响应）都带着同一条 lastRewind：不再触发，不死循环
    const later = makeTask([], { id, lastRewind: taskFrame.lastRewind, updatedAt: 1500 });
    expect(lastRewindNeedsResync(B, later)).toBe(false);
    expect(lastRewindNeedsResync(mergeTaskEvents(B, later), later)).toBe(false);
  });

  it("回退之后日志里没有新事件（保留的末条 ts 早于回退时刻）：重拉对齐一次后也不会反复重拉", async () => {
    const id = await alloc({
      updatedAt: 1000,
      lastRewind: { fromEventId: "u2", keptCount: 2, markerEventId: null, ts: 1000 },
    } as Partial<TaskMetaV06>);
    await writeEvents(id, [ev("u1", 1, "user_reply"), ev("a1", 2)]);
    const B0 = makeTask(
      [ev("u1", 1, "user_reply"), ev("a1", 2), ev("u2", 3, "user_reply"), ev("a2", 4)],
      { id, updatedAt: 4 },
    );
    const fetched = (await getTaskWithTailEvents(id, 300, { anchor: isTailAnchorEvent }))!;
    expect(lastRewindNeedsResync(B0, fetched)).toBe(true);
    const B = replaceTaskEventsWithSnapshot(B0, fetched);
    expect(B.events.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(lastRewindNeedsResync(B, fetched)).toBe(false);
  });
});
