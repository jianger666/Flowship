/**
 * run cancel / 终结后未闭合 tool_call 被 finalize 为 interrupted
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import {
  buildShellBackgroundEvent,
  collectRunningBackgroundShells,
} from "@/lib/shell-background";
import type { TaskEvent } from "@/lib/types";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-finalize-open-tools-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { clearEventSeqCounter, readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { listTasks } = await import("@/lib/server/task-fs");
const { writeOwnedEventAndPublish } = await import("@/lib/server/task-stream");
const {
  collectOpenToolCalls,
  finalizeOpenToolCalls,
  finalizeSideRunBackgroundShells,
} = await import("@/lib/server/finalize-open-tools");
const { activeBackgroundShellTrackerCount, trackBackgroundShell } = await import(
  "@/lib/server/shell-background-tracker"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `finalize-open-tools DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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
    title: `finalize-open-tools ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({
  ts: 1,
  ...partial,
});

describe("collectOpenToolCalls", () => {
  it("有 tool_result 配对的不算 open", () => {
    const events = [
      ev({
        id: "a",
        kind: "tool_call",
        text: "调用 shell",
        meta: { callId: "c1", name: "shell" },
      }),
      ev({
        id: "b",
        kind: "tool_result",
        text: "工具完成 shell",
        meta: {
          callId: "c1",
          name: "shell",
          status: "success",
          output: "ok",
        },
      }),
    ];
    expect(collectOpenToolCalls(events)).toEqual([]);
  });

  it("未配对 tool_call → open；同 callId 双写只计一次", () => {
    const events = [
      ev({
        id: "a",
        kind: "tool_call",
        text: "调用 shell",
        meta: { callId: "c1", name: "shell", args: "ls" },
        actionId: "act_1",
      }),
      ev({
        id: "a2",
        kind: "tool_call",
        text: "调用 shell",
        meta: { callId: "c1", name: "shell", args: "ls -la" },
      }),
      ev({
        id: "c",
        kind: "tool_call",
        text: "调用 read",
        meta: { callId: "c2", name: "read" },
      }),
      ev({
        id: "d",
        kind: "tool_result",
        text: "工具完成 read",
        meta: {
          callId: "c2",
          name: "read",
          status: "success",
          output: "hi",
        },
      }),
    ];
    expect(collectOpenToolCalls(events)).toEqual([
      { callId: "c1", name: "shell", actionId: "act_1" },
    ]);
  });
});

describe("finalizeOpenToolCalls（run cancel 后闭合）", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
    }
  });

  it("cancel 语义：未闭合工具补写 interrupted tool_result", async () => {
    const id = `t_fot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));

    const lease = () => true;
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_call",
      text: "调用 shell",
      meta: { callId: "call_open_1", name: "shell", args: "sleep 999" },
    });
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_call",
      text: "调用 read",
      meta: { callId: "call_done_1", name: "read" },
    });
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_result",
      text: "工具完成 read",
      meta: {
        callId: "call_done_1",
        name: "read",
        status: "success",
        output: "done",
      },
    });

    const n = await finalizeOpenToolCalls(id, lease);
    expect(n).toBe(1);

    const events = await readEvents(id);
    const results = events.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(2);
    const interrupted = results.find(
      (e) => e.meta?.callId === "call_open_1",
    );
    expect(interrupted?.meta).toMatchObject({
      callId: "call_open_1",
      name: "shell",
      status: "interrupted",
      output: "",
    });
    // 已完成的 call 不再被二次 finalize
    expect(
      results.filter((e) => e.meta?.callId === "call_done_1"),
    ).toHaveLength(1);

    // 幂等：再 finalize 无新写入
    expect(await finalizeOpenToolCalls(id, lease)).toBe(0);
  });

  // 全量扫历史的后果：几个月前留下的未闭合 tool_call 会在本次 run 收尾时补上
  // 「已中断」——那几条新事件落在流的最末尾，用户看到「刚跑完就冒出一堆孤儿中断块」
  it("只闭合尾部窗口内的工具：远古未配对 tool_call 不再被翻出来补中断", async () => {
    const id = `t_fot_tail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));

    // 直接拼 JSONL 灌数据（走 writeOwnedEventAndPublish 要 1000+ 次加锁写盘、太慢）
    const lines: string[] = [
      JSON.stringify(
        ev({
          id: "ancient",
          kind: "tool_call",
          text: "调用 shell",
          meta: { callId: "call_ancient", name: "shell" },
        }),
      ),
    ];
    for (let i = 0; i < 1200; i++) {
      lines.push(
        JSON.stringify(
          ev({ id: `filler_${i}`, kind: "info", text: `第 ${i} 条` }),
        ),
      );
    }
    await appendFile(
      path.join(taskDir(id), "events.jsonl"),
      `${lines.join("\n")}\n`,
      "utf-8",
    );

    // 本次 run 的未闭合工具（在尾部窗口内）
    const lease = () => true;
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_call",
      text: "调用 shell",
      meta: { callId: "call_recent", name: "shell" },
    });

    expect(await finalizeOpenToolCalls(id, lease)).toBe(1);

    const results = (await readEvents(id)).filter(
      (e) => e.kind === "tool_result",
    );
    expect(results.map((e) => e.meta?.callId)).toEqual(["call_recent"]);
  });

  it("lease 失主 → 不写盘", async () => {
    const id = `t_fot_lease_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    await writeOwnedEventAndPublish(id, () => true, {
      kind: "tool_call",
      text: "调用 shell",
      meta: { callId: "call_lost", name: "shell" },
    });

    const before = (await readEvents(id)).length;
    const n = await finalizeOpenToolCalls(id, () => false);
    expect(n).toBe(0);
    expect((await readEvents(id)).length).toBe(before);
  });
});

// G2-02：群答疑旁路 run 的事件整条链都带 meta.groupRun（UI 据此把它折进「群问答」tab、不进属主主流）。
// 属主 run 收尾时扫到旁路遗留的未闭合 tool_call，补写的 tool_result 若不带同一个标，
// 就成了「call 被藏、result 露在主流里」的孤儿中断块。
describe("群答疑旁路遗留的 tool_call（G2-02）", () => {
  const RUN_TAG = "grp_run_3f9a";
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
    }
  });

  it("collectOpenToolCalls：未闭合的旁路 tool_call 带出它的 groupRun；属主自己的没有", () => {
    const events = [
      ev({
        id: "o1",
        kind: "tool_call",
        text: "调用 shell",
        meta: { callId: "owner_c1", name: "shell" },
      }),
      ev({
        id: "g1",
        kind: "tool_call",
        text: "调用 read",
        meta: { groupRun: RUN_TAG, callId: "side_c1", name: "read" },
      }),
    ];
    expect(collectOpenToolCalls(events)).toEqual([
      { callId: "owner_c1", name: "shell", actionId: undefined },
      { callId: "side_c1", name: "read", actionId: undefined, groupRun: RUN_TAG },
    ]);
  });

  it("真实形态：旁路 run 经 owned sink 落盘（meta.groupRun = origin）后断流，属主收尾补的中断结果仍归旁路、主流看不见", async () => {
    const id = `t_fot_grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    const lease = () => true;

    // 属主主链：一个已完成的工具 + 一个收尾时才发现没闭合的工具（不传 origin）
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_call",
      text: "调用 read",
      meta: { callId: "owner_done", name: "read" },
    });
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_result",
      text: "工具完成 read",
      meta: { callId: "owner_done", name: "read", status: "success", output: "ok" },
    });
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_call",
      text: "调用 shell",
      meta: { callId: "owner_open", name: "shell", args: "sleep 999" },
    });
    // 旁路 run：与 sdk-message-handler 同一条写盘路径——origin = runTag，sink 自动打 groupRun
    await writeOwnedEventAndPublish(
      id,
      lease,
      {
        kind: "tool_call",
        text: "调用 grep",
        meta: { callId: "side_open", name: "grep", args: "foo" },
      },
      RUN_TAG,
    );
    await writeOwnedEventAndPublish(
      id,
      lease,
      {
        kind: "tool_call",
        text: "调用 read",
        meta: { callId: "side_done", name: "read" },
      },
      RUN_TAG,
    );
    await writeOwnedEventAndPublish(
      id,
      lease,
      {
        kind: "tool_result",
        text: "工具完成 read",
        meta: { callId: "side_done", name: "read", status: "success", output: "x" },
      },
      RUN_TAG,
    );

    // 前提自检：旁路的 call 落盘时确实带了标，且被主流藏起来了
    const before = await readEvents(id);
    const sideCall = before.find((e) => e.meta?.callId === "side_open");
    expect(sideCall?.meta?.groupRun).toBe(RUN_TAG);
    expect(isHiddenFromEventStream(sideCall as TaskEvent)).toBe(true);

    expect(await finalizeOpenToolCalls(id, lease)).toBe(2);

    const results = (await readEvents(id)).filter(
      (e) => e.kind === "tool_result" && e.meta?.status === "interrupted",
    );
    const side = results.find((e) => e.meta?.callId === "side_open");
    const owner = results.find((e) => e.meta?.callId === "owner_open");
    expect(side?.meta).toMatchObject({
      groupRun: RUN_TAG,
      callId: "side_open",
      name: "grep",
      status: "interrupted",
    });
    // 旁路的中断结果和它的 call 一样被主流藏起来；属主自己的照旧可见、不带标
    expect(isHiddenFromEventStream(side as TaskEvent)).toBe(true);
    expect(owner?.meta?.groupRun).toBeUndefined();
    expect(isHiddenFromEventStream(owner as TaskEvent)).toBe(false);

    // 幂等
    expect(await finalizeOpenToolCalls(id, lease)).toBe(0);
  });
});

// shell 转后台后 tool_call 早已完成，不归「未配对 tool_call」管；但它的 running 标记会让渲染层继续转圈。
// run 收尾不补 ended 的话，下一轮会话一 running，这块旧 shell 又转起来。
describe("后台 shell 标记的收尾（running → ended/run-ended）", () => {
  const ids: string[] = [];
  const RUN_TAG = "grp_run_bg";

  afterEach(() => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
    }
  });

  const newTask = async (tag: string): Promise<string> => {
    const id = `t_fotbg_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    return id;
  };

  const writeMarker = async (
    id: string,
    callId: string,
    phase: "running" | "ended",
    origin?: string,
  ) =>
    writeOwnedEventAndPublish(
      id,
      () => true,
      buildShellBackgroundEvent({
        callId,
        phase,
        ...(phase === "ended" ? { reason: "exited" as const } : {}),
      }),
      origin,
    );

  it("仍标着运行中的后台 shell → 补写 ended(run-ended)；不计入返回值；幂等", async () => {
    const id = await newTask("basic");
    await writeMarker(id, "call_bg", "running");
    expect(collectRunningBackgroundShells(await readEvents(id))).toHaveLength(1);

    const lease = () => true;
    // 返回值只数被中断的工具——这里没有未闭合工具，所以是 0
    expect(await finalizeOpenToolCalls(id, lease)).toBe(0);

    const events = await readEvents(id);
    expect(collectRunningBackgroundShells(events)).toEqual([]);
    const last = events[events.length - 1];
    expect(last.kind).toBe("info");
    expect(last.meta).toMatchObject({
      shellBackground: { callId: "call_bg", phase: "ended", reason: "run-ended" },
    });
    // 标记是内部状态、不渲染
    expect(isHiddenFromEventStream(last)).toBe(true);

    // 幂等：再收尾不再写
    const before = events.length;
    await finalizeOpenToolCalls(id, lease);
    expect((await readEvents(id)).length).toBe(before);
  });

  it("已经 ended（进程自己退出了）的不重复收", async () => {
    const id = await newTask("already");
    await writeMarker(id, "call_done", "running");
    await writeMarker(id, "call_done", "ended");
    const before = (await readEvents(id)).length;
    await finalizeOpenToolCalls(id, () => true);
    expect((await readEvents(id)).length).toBe(before);
  });

  it("与未闭合 tool_call 同时存在：工具照旧补 interrupted（返回 1），后台 shell 标记也收掉", async () => {
    const id = await newTask("mixed");
    const lease = () => true;
    await writeOwnedEventAndPublish(id, lease, {
      kind: "tool_call",
      text: "调用 read",
      meta: { callId: "call_open", name: "read" },
    });
    await writeMarker(id, "call_bg", "running");

    expect(await finalizeOpenToolCalls(id, lease)).toBe(1);
    const events = await readEvents(id);
    expect(
      events.some(
        (e) => e.kind === "tool_result" && e.meta?.callId === "call_open",
      ),
    ).toBe(true);
    expect(collectRunningBackgroundShells(events)).toEqual([]);
  });

  it("lease 失主 → 不写（旧 run 无权替新 run 收标记）", async () => {
    const id = await newTask("lease");
    await writeMarker(id, "call_bg", "running");
    const before = (await readEvents(id)).length;
    await finalizeOpenToolCalls(id, () => false);
    const after = await readEvents(id);
    expect(after.length).toBe(before);
    expect(collectRunningBackgroundShells(after)).toHaveLength(1);
  });

  it("旁路 run 的标记：补写的 ended 带回同一个 groupRun，仍被属主主流藏起来", async () => {
    const id = await newTask("grp");
    await writeMarker(id, "side_bg", "running", RUN_TAG);
    await writeMarker(id, "own_bg", "running");

    await finalizeOpenToolCalls(id, () => true);
    const events = await readEvents(id);
    expect(collectRunningBackgroundShells(events)).toEqual([]);
    const sideEnd = events.find(
      (e) =>
        (e.meta?.shellBackground as { callId?: string; phase?: string } | undefined)
          ?.callId === "side_bg" &&
        (e.meta?.shellBackground as { phase?: string }).phase === "ended",
    );
    const ownEnd = events.find(
      (e) =>
        (e.meta?.shellBackground as { callId?: string; phase?: string } | undefined)
          ?.callId === "own_bg" &&
        (e.meta?.shellBackground as { phase?: string }).phase === "ended",
    );
    expect(sideEnd?.meta?.groupRun).toBe(RUN_TAG);
    expect(ownEnd?.meta?.groupRun).toBeUndefined();
  });

  it("收尾同时停掉该任务还在轮询终端文件的追踪（之后不会再写 ended(exited)）", async () => {
    const id = await newTask("stop");
    const cursorDir = path.join(TMP_ROOT, "cursor-data");
    const prevEnv = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = cursorDir;
    try {
      const t = Date.now();
      const dir = path.join(cursorDir, "projects", "ws", "terminals");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "1.txt"),
        `---\npid: 5\ncwd: "/w"\ncommand: "sleep 99"\nstatus: running  \nstarted_at: ${new Date(t).toISOString()}\nrunning_for_ms: 0        \n---\n`,
        "utf8",
      );
      const writes: string[] = [];
      const done = trackBackgroundShell({
        taskId: id,
        callId: "call_poll",
        command: "sleep 99",
        startedAtMs: t,
        lease: () => true,
        probeDelayMs: 5,
        pollIntervalMs: 60_000,
        isPidAlive: () => true,
        write: async (m) => {
          writes.push(m.phase);
        },
      });
      const start = Date.now();
      while (writes.length < 1 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(writes).toEqual(["running"]);
      expect(activeBackgroundShellTrackerCount()).toBe(1);

      await finalizeOpenToolCalls(id, () => true);
      await done;
      expect(activeBackgroundShellTrackerCount()).toBe(0);
      expect(writes).toEqual(["running"]);
    } finally {
      if (prevEnv === undefined) delete process.env.CURSOR_DATA_DIR;
      else process.env.CURSOR_DATA_DIR = prevEnv;
    }
  });
  it("收尾先停追踪、等在途写盘落定、再读事件尾巴：正在落盘的 running 标记也会被补 ended（不留孤儿）", async () => {
    const id = await newTask("race");
    const cursorDir = path.join(TMP_ROOT, "cursor-data-race");
    const prevEnv = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = cursorDir;
    try {
      const t = Date.now();
      const dir = path.join(cursorDir, "projects", "ws", "terminals");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "1.txt"),
        `---\npid: 5\ncwd: "/w"\ncommand: "sleep 77"\nstatus: running  \nstarted_at: ${new Date(t).toISOString()}\nrunning_for_ms: 0        \n---\n`,
        "utf8",
      );
      let writeStarted = false;
      const done = trackBackgroundShell({
        taskId: id,
        callId: "call_race",
        command: "sleep 77",
        startedAtMs: t,
        lease: () => true,
        probeDelayMs: 5,
        pollIntervalMs: 60_000,
        isPidAlive: () => true,
        // 慢写盘：标记是在 finalize 已经开始之后才真正落盘的
        write: async (m) => {
          writeStarted = true;
          await new Promise((r) => setTimeout(r, 120));
          await writeMarker(id, m.callId, m.phase === "running" ? "running" : "ended");
        },
      });
      const start = Date.now();
      while (!writeStarted && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(writeStarted).toBe(true);
      // 此刻 running 标记还没落盘
      expect(collectRunningBackgroundShells(await readEvents(id))).toEqual([]);

      await finalizeOpenToolCalls(id, () => true);
      await done;

      const events = await readEvents(id);
      // 在途的 running 落盘后被同一轮收尾读到并补了 ended——没有孤儿 running
      expect(collectRunningBackgroundShells(events)).toEqual([]);
      const phases = events
        .map((e) => (e.meta?.shellBackground as { phase?: string } | undefined)?.phase)
        .filter(Boolean);
      expect(phases).toEqual(["running", "ended"]);
      expect(activeBackgroundShellTrackerCount()).toBe(0);
    } finally {
      if (prevEnv === undefined) delete process.env.CURSOR_DATA_DIR;
      else process.env.CURSOR_DATA_DIR = prevEnv;
    }
  });

  it("finalizeSideRunBackgroundShells：只收这个旁路 run 自己的 running；属主 / 别的旁路 run 的不碰，带回同一个 groupRun", async () => {
    const id = await newTask("side");
    await writeMarker(id, "mine_bg", "running", "grp_mine");
    await writeMarker(id, "other_side_bg", "running", "grp_other");
    await writeMarker(id, "owner_bg", "running");

    await finalizeSideRunBackgroundShells(id, "grp_mine", () => true);

    const events = await readEvents(id);
    expect(
      collectRunningBackgroundShells(events)
        .map((s) => s.callId)
        .sort(),
    ).toEqual(["other_side_bg", "owner_bg"]);
    const ended = events.find(
      (e) =>
        (e.meta?.shellBackground as { callId?: string; phase?: string } | undefined)
          ?.callId === "mine_bg" &&
        (e.meta?.shellBackground as { phase?: string }).phase === "ended",
    );
    expect(ended?.meta?.groupRun).toBe("grp_mine");
    expect(
      (ended?.meta?.shellBackground as { reason?: string } | undefined)?.reason,
    ).toBe("run-ended");
    expect(isHiddenFromEventStream(ended as TaskEvent)).toBe(true);
  });

  it("finalizeSideRunBackgroundShells：失主不写；读尾巴失败也不抛（不能拖垮旁路 run 的收口）", async () => {
    const id = await newTask("side-lease");
    await writeMarker(id, "mine_bg", "running", "grp_mine");
    const before = (await readEvents(id)).length;
    await finalizeSideRunBackgroundShells(id, "grp_mine", () => false);
    expect((await readEvents(id)).length).toBe(before);

    // 任务不存在 → 读不到事件，照样 resolve
    await expect(
      finalizeSideRunBackgroundShells("t_not_exists_xyz", "grp_mine", () => true),
    ).resolves.toBeUndefined();
  });

  it("finalizeSideRunBackgroundShells：只停该旁路 run 自己的追踪，属主 / 别的旁路 run 的追踪继续", async () => {
    const id = await newTask("side-stop");
    const cursorDir = path.join(TMP_ROOT, "cursor-data-side");
    const prevEnv = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = cursorDir;
    try {
      const t = Date.now();
      const dir = path.join(cursorDir, "projects", "ws", "terminals");
      mkdirSync(dir, { recursive: true });
      const put = (n: number, command: string) =>
        writeFileSync(
          path.join(dir, `${n}.txt`),
          `---\npid: 5\ncwd: "/w"\ncommand: "${command}"\nstatus: running  \nstarted_at: ${new Date(t).toISOString()}\nrunning_for_ms: 0        \n---\n`,
          "utf8",
        );
      put(1, "job-side");
      put(2, "job-owner");
      const writes: string[] = [];
      const mk = (command: string, origin?: string) =>
        trackBackgroundShell({
          taskId: id,
          callId: `call_${command}`,
          command,
          startedAtMs: t,
          lease: () => true,
          probeDelayMs: 5,
          pollIntervalMs: 60_000,
          isPidAlive: () => true,
          ...(origin ? { origin } : {}),
          write: async (m) => {
            writes.push(`${m.callId}:${m.phase}`);
          },
        });
      const doneSide = mk("job-side", "grp_side");
      const doneOwner = mk("job-owner");
      const start = Date.now();
      while (writes.length < 2 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(writes.sort()).toEqual([
        "call_job-owner:running",
        "call_job-side:running",
      ]);
      expect(activeBackgroundShellTrackerCount()).toBe(2);

      await finalizeSideRunBackgroundShells(id, "grp_side", () => true);
      await doneSide;
      expect(activeBackgroundShellTrackerCount()).toBe(1);

      // 属主的追踪还活着；属主 finalize 才会把它停掉
      await finalizeOpenToolCalls(id, () => true);
      await doneOwner;
      expect(activeBackgroundShellTrackerCount()).toBe(0);
    } finally {
      if (prevEnv === undefined) delete process.env.CURSOR_DATA_DIR;
      else process.env.CURSOR_DATA_DIR = prevEnv;
    }
  });
});
