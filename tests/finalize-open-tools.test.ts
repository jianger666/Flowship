/**
 * run cancel / 终结后未闭合 tool_call 被 finalize 为 interrupted
 */
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
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
} = await import("@/lib/server/finalize-open-tools");

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
