/**
 * 300 条窗口一致性（第三轮 review D8-01 / D8-02 / D8-03，报告第 1 节第 4 条）：
 * 「往前找一个更早事件」的派生态（错误卡恢复入口 / 状态行 / ↑ 输入历史）靠窗口里有触发这一轮的
 * user_reply / action_start。窗口 = 最近 300 条时，一轮长 run（>150 对工具调用）之后重开页面
 * 触发源就在窗口外、派生态静默失效。
 *
 * 修法之一：服务端 tail 读取时补到「含最近一条 user_reply / action_start」（设上限防巨型任务）。
 * 本测试钉 readEventsTail 的 anchor 选项（真实文件 IO）+ 路由用的真实判定 isTailAnchorEvent。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，先钉 env 再动态 import（同 events-tail-io.test.ts）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-tail-anchor-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { EVENTS_FILE, MAX_EVENTS_TAIL, readEventsTail, taskDir } = await import(
  "@/lib/server/task-fs-core"
);
const { isTailAnchorEvent } = await import("@/lib/tail-anchor");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`events-tail-anchor DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_events_tail_anchor_1";

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

let seq = 0;
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => {
  seq += 1;
  return { id: `e${seq}`, ts: 1_000 + seq, text: "", ...p };
};

const writeEvents = async (events: TaskEvent[]): Promise<void> => {
  const dir = taskDir(TASK_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, EVENTS_FILE),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
};

/** n 对 read 工具调用（2n 条事件） */
const toolPairs = (n: number): TaskEvent[] => {
  const out: TaskEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(ev({ kind: "tool_call", meta: { callId: `k${seq}`, name: "read" } }));
    out.push(ev({ kind: "tool_result", meta: { callId: `k${seq - 1}`, name: "read" } }));
  }
  return out;
};

describe("readEventsTail anchor：窗口补到最近一条锚点事件", () => {
  it("不传 anchor：行为不变（只取最后 n 条）", async () => {
    const trigger = ev({ kind: "action_start", id: "as1", text: "开始 build" });
    await writeEvents([ev({ kind: "info" }), trigger, ...toolPairs(200)]);
    const { events, hasMore } = await readEventsTail(TASK_ID, 300);
    expect(events).toHaveLength(300);
    expect(events.some((e) => e.id === "as1")).toBe(false);
    expect(hasMore).toBe(true);
  });

  it("D8-02：action_start 距末尾 >300 条 → 窗口向前补到它（含它），hasMore 仍为 true", async () => {
    const trigger = ev({ kind: "action_start", id: "as1", text: "开始 build" });
    const all = [ev({ kind: "info" }), trigger, ...toolPairs(200)];
    await writeEvents(all);
    const { events, hasMore } = await readEventsTail(TASK_ID, 300, {
      anchor: isTailAnchorEvent,
    });
    expect(events[0]!.id).toBe("as1");
    expect(events).toHaveLength(all.length - 1); // 去掉最前面那条 info
    expect(events.at(-1)!.id).toBe(all.at(-1)!.id);
    expect(hasMore).toBe(true); // 锚点之前还有更早的
  });

  it("锚点已在最近 n 条里：窗口与不传 anchor 完全一致（不多读）", async () => {
    const trigger = ev({ kind: "user_reply", id: "u1", text: "做个登录页" });
    await writeEvents([...toolPairs(300), trigger, ...toolPairs(20)]);
    const plain = await readEventsTail(TASK_ID, 300);
    const anchored = await readEventsTail(TASK_ID, 300, { anchor: isTailAnchorEvent });
    expect(anchored.events.map((e) => e.id)).toEqual(plain.events.map((e) => e.id));
    expect(anchored.hasMore).toBe(plain.hasMore);
  });

  it("上限：锚点恰好在 MAX_EVENTS_TAIL 条以内 → 补到它；多一条就放弃（防巨型任务首屏失控）", async () => {
    const trigger = ev({ kind: "action_start", id: "as-edge", text: "开始 build" });
    // 锚点 + 999 条工具事件 = 刚好 1000 条在窗口里
    await writeEvents([ev({ kind: "info" }), trigger, ...toolPairs(499), ev({ kind: "tool_call" })]);
    const fit = await readEventsTail(TASK_ID, 300, { anchor: isTailAnchorEvent });
    expect(fit.events).toHaveLength(MAX_EVENTS_TAIL);
    expect(fit.events[0]!.id).toBe("as-edge");
    expect(fit.hasMore).toBe(true);

    await writeEvents([ev({ kind: "info" }), trigger, ...toolPairs(500), ev({ kind: "tool_call" })]);
    const over = await readEventsTail(TASK_ID, 300, { anchor: isTailAnchorEvent });
    expect(over.events).toHaveLength(300); // 补不到就不放大首屏
    expect(over.events.some((e) => e.id === "as-edge")).toBe(false);
    expect(over.hasMore).toBe(true);
  });

  it("锚点远在上限之外 / 整份日志都没有锚点：与不传 anchor 完全一致，也不会把整份日志读进来", async () => {
    const trigger = ev({ kind: "action_start", id: "as-far", text: "开始 build" });
    await writeEvents([trigger, ...toolPairs(3000)]);
    const far = await readEventsTail(TASK_ID, 300, { anchor: isTailAnchorEvent });
    const farPlain = await readEventsTail(TASK_ID, 300);
    expect(far.events.map((e) => e.id)).toEqual(farPlain.events.map((e) => e.id));
    expect(far.hasMore).toBe(true);

    await writeEvents(toolPairs(3000));
    const none = await readEventsTail(TASK_ID, 300, { anchor: isTailAnchorEvent });
    const nonePlain = await readEventsTail(TASK_ID, 300);
    expect(none.events.map((e) => e.id)).toEqual(nonePlain.events.map((e) => e.id));
    expect(none.hasMore).toBe(true);
  });

  it("调用方传的 n 已经大于上限：不再额外放大", async () => {
    await writeEvents(toolPairs(MAX_EVENTS_TAIL));
    const { events } = await readEventsTail(TASK_ID, MAX_EVENTS_TAIL, {
      anchor: isTailAnchorEvent,
    });
    expect(events).toHaveLength(MAX_EVENTS_TAIL);
  });

  it("日志总量不到 n：hasMore=false、全部返回（anchor 不影响小任务）", async () => {
    await writeEvents([ev({ kind: "user_reply", text: "hi" }), ...toolPairs(5)]);
    const { events, hasMore } = await readEventsTail(TASK_ID, 300, {
      anchor: isTailAnchorEvent,
    });
    expect(events).toHaveLength(11);
    expect(hasMore).toBe(false);
  });

  it("锚点判定与主流同口径：群里陌生人的提问（对主流不可见）不是锚点，窗口继续往前找属主那条", async () => {
    const owner = ev({ kind: "user_reply", id: "owner", text: "我的指令" });
    const groupQ = ev({
      kind: "user_reply",
      id: "gq",
      text: "[群消息·来自 张三]\n问个事",
      meta: { source: "feishu_group", restrictedRunTag: "rt1", groupSender: "张三" },
    });
    await writeEvents([owner, ...toolPairs(100), groupQ, ...toolPairs(200)]);
    const { events } = await readEventsTail(TASK_ID, 300, { anchor: isTailAnchorEvent });
    expect(events[0]!.id).toBe("owner");
    expect(events.some((e) => e.id === "gq")).toBe(true);
  });
});

describe("isTailAnchorEvent", () => {
  it("只认属主可见的 user_reply / action_start", () => {
    expect(isTailAnchorEvent(ev({ kind: "user_reply", text: "a" }))).toBe(true);
    expect(isTailAnchorEvent(ev({ kind: "action_start", text: "a" }))).toBe(true);
    expect(isTailAnchorEvent(ev({ kind: "assistant_message", text: "a" }))).toBe(false);
    expect(isTailAnchorEvent(ev({ kind: "tool_call" }))).toBe(false);
    expect(
      isTailAnchorEvent(
        ev({
          kind: "user_reply",
          text: "q",
          meta: { source: "feishu_group", restrictedRunTag: "rt" },
        }),
      ),
    ).toBe(false);
  });
});
