/**
 * V7-03（通知侧）：watcher 的静音判定。
 *
 * 旧：`document.hasFocus()` 为真就整体静音。后果两条：
 *  1) 窗口聚焦但用户在看别的会话时，后台会话（含定时唤醒的）跑完没有任何提示；
 *  2) 回到 app 时 focus→refresh() 才拿到「空闲 → 等你回复」的转变，此刻 hasFocus 已真，转变沿被吞。
 * 新：只有「窗口聚焦 且 正看着的就是这个任务」才静音。
 *
 * 纯函数放 src/lib/task-notify-plan.ts；watcher 是 .tsx，只能做源码契约断言。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_TASK_NOTIFICATIONS_PER_PASS,
  TASK_NOTIFY_COOLDOWN_MS,
  TASK_NOTIFY_WINDOW_MAX,
  TASK_NOTIFY_WINDOW_MS,
  activeTaskIdFromPathname,
  applyNotifyThrottle,
  createNotifyThrottle,
  planTaskNotifications,
  shouldMuteTaskNotification,
} from "@/lib/task-notify-plan";
import type { RunStatus } from "@/lib/types";

describe("activeTaskIdFromPathname", () => {
  it("/tasks/<id>（含尾斜杠、子路径）→ id", () => {
    expect(activeTaskIdFromPathname("/tasks/t_123_abc")).toBe("t_123_abc");
    expect(activeTaskIdFromPathname("/tasks/t_123_abc/")).toBe("t_123_abc");
    expect(activeTaskIdFromPathname("/tasks/t_123_abc/whatever")).toBe("t_123_abc");
  });

  it("别的页面 / 空值 → null（/workitems/<id> 的 id 不是任务 id，不能误当）", () => {
    expect(activeTaskIdFromPathname("/chats")).toBeNull();
    expect(activeTaskIdFromPathname("/workitems/abc")).toBeNull();
    expect(activeTaskIdFromPathname("/tasks")).toBeNull();
    expect(activeTaskIdFromPathname("/tasks/")).toBeNull();
    expect(activeTaskIdFromPathname("")).toBeNull();
    expect(activeTaskIdFromPathname(null)).toBeNull();
    expect(activeTaskIdFromPathname(undefined)).toBeNull();
  });

  it("URL 编码的 id 会解码；坏编码不抛、原样返回", () => {
    expect(activeTaskIdFromPathname("/tasks/a%20b")).toBe("a b");
    expect(activeTaskIdFromPathname("/tasks/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("shouldMuteTaskNotification：聚焦 且 正看着这个任务才静音", () => {
  it("聚焦 + 正看着它 → 静音", () => {
    expect(shouldMuteTaskNotification({ hasFocus: true, activeTaskId: "a", taskId: "a" })).toBe(true);
  });

  it("聚焦 + 在看别的任务 / 别的页面 → 不静音（后台会话跑完要叫人）", () => {
    expect(shouldMuteTaskNotification({ hasFocus: true, activeTaskId: "b", taskId: "a" })).toBe(false);
    expect(shouldMuteTaskNotification({ hasFocus: true, activeTaskId: null, taskId: "a" })).toBe(false);
  });

  it("没聚焦 → 一律不静音（含正开着它但窗口在后台）", () => {
    expect(shouldMuteTaskNotification({ hasFocus: false, activeTaskId: "a", taskId: "a" })).toBe(false);
    expect(shouldMuteTaskNotification({ hasFocus: false, activeTaskId: null, taskId: "a" })).toBe(false);
  });
});

describe("planTaskNotifications", () => {
  interface Row {
    id: string;
    title: string;
    runStatus: RunStatus;
  }
  const row = (id: string, runStatus: RunStatus): Row => ({ id, title: `标题-${id}`, runStatus });
  const snap = (rows: Row[]): Map<string, RunStatus> =>
    new Map(rows.map((r) => [r.id, r.runStatus]));
  const describeBody = (t: Row): string => `body-${t.id}`;
  const plan = (
    prev: Map<string, RunStatus> | null,
    tasks: Row[],
    over: { hasFocus?: boolean; activeTaskId?: string | null } = {},
  ) =>
    planTaskNotifications({
      prev,
      tasks,
      hasFocus: over.hasFocus ?? false,
      activeTaskId: over.activeTaskId ?? null,
      describeBody,
    });

  it("还没有基线（首轮）→ 不通知", () => {
    expect(plan(null, [row("a", "awaiting_user")])).toEqual([]);
  });

  it("转入 awaiting_user → 带标题 / 正文 / taskId 通知；转入 error → 异常文案", () => {
    const out = plan(snap([row("a", "running"), row("b", "running")]), [
      row("a", "awaiting_user"),
      row("b", "error"),
    ]);
    expect(out).toEqual([
      { title: "标题-a", body: "body-a", taskId: "a", kind: "reply" },
      { title: "标题-b", body: "任务异常中断、点击查看", taskId: "b", kind: "error" },
    ]);
  });

  it("状态没变 / 新任务首见 → 不通知（保持原语义）", () => {
    expect(plan(snap([row("a", "awaiting_user")]), [row("a", "awaiting_user")])).toEqual([]);
    expect(plan(snap([]), [row("new", "awaiting_user")])).toEqual([]);
  });

  it("聚焦 + 正看着该任务 → 静音；聚焦但在看别的任务 → 照常通知（回到 app 时转变沿不再被吞）", () => {
    const prev = snap([row("a", "running"), row("b", "running")]);
    const tasks = [row("a", "awaiting_user"), row("b", "awaiting_user")];
    const out = plan(prev, tasks, { hasFocus: true, activeTaskId: "a" });
    expect(out.map((n) => n.taskId)).toEqual(["b"]);
  });

  it("没聚焦 → 正开着的那个任务也通知（窗口在后台）", () => {
    const out = plan(snap([row("a", "running")]), [row("a", "awaiting_user")], {
      hasFocus: false,
      activeTaskId: "a",
    });
    expect(out.map((n) => n.taskId)).toEqual(["a"]);
  });

  it(`一次转变过多（久不在 app / 聚焦时批量回刷）→ 最多 ${MAX_TASK_NOTIFICATIONS_PER_PASS} 条单独通知 + 1 条汇总，不刷屏`, () => {
    const ids = ["a", "b", "c", "d", "e"];
    const out = plan(
      snap(ids.map((id) => row(id, "running"))),
      ids.map((id) => row(id, "awaiting_user")),
    );
    expect(out).toHaveLength(MAX_TASK_NOTIFICATIONS_PER_PASS + 1);
    expect(out.slice(0, MAX_TASK_NOTIFICATIONS_PER_PASS).map((n) => n.taskId)).toEqual(
      ids.slice(0, MAX_TASK_NOTIFICATIONS_PER_PASS),
    );
    const summary = out[out.length - 1];
    expect(summary.taskId).toBeUndefined();
    expect(summary.body).toBe(`另有 ${ids.length - MAX_TASK_NOTIFICATIONS_PER_PASS} 个任务有更新`);
  });

  it("恰好等于上限 → 不出汇总", () => {
    const ids = Array.from({ length: MAX_TASK_NOTIFICATIONS_PER_PASS }, (_, i) => `t${i}`);
    const out = plan(
      snap(ids.map((id) => row(id, "running"))),
      ids.map((id) => row(id, "awaiting_user")),
    );
    expect(out).toHaveLength(MAX_TASK_NOTIFICATIONS_PER_PASS);
    expect(out.every((n) => n.taskId !== undefined)).toBe(true);
  });
});

describe("watcher 接线契约", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/components/task-attention-watcher.tsx"),
    "utf8",
  );

  it("用 usePathname + activeTaskIdFromPathname 取「正看着的任务」", () => {
    expect(src).toMatch(/usePathname/);
    expect(src).toMatch(/activeTaskIdFromPathname\(/);
  });

  it("通知决策走 planTaskNotifications，不再有「hasFocus 就整体 return」的硬静音", () => {
    expect(src).toMatch(/planTaskNotifications\(/);
    expect(src).not.toMatch(/if \(document\.hasFocus\(\)\) return;/);
  });

  it("基线仍在 effect 里更新（prevStatusRef）", () => {
    expect(src).toMatch(/prevStatusRef\.current = new Map\(/);
  });
});

describe("D6-01：AI 提问等人（runStatus 仍是 running）也要通知", () => {
  interface AskRow {
    id: string;
    title: string;
    runStatus: RunStatus;
    hasPendingAsk?: boolean;
  }
  const r = (id: string, runStatus: RunStatus, hasPendingAsk = false): AskRow => ({
    id,
    title: `标题-${id}`,
    runStatus,
    hasPendingAsk,
  });
  const snapStatus = (rows: AskRow[]) => new Map(rows.map((x) => [x.id, x.runStatus]));
  const snapAsk = (rows: AskRow[]) => new Map(rows.map((x) => [x.id, x.hasPendingAsk === true]));
  const run = (before: AskRow[], after: AskRow[], over: { hasFocus?: boolean; activeTaskId?: string | null } = {}) =>
    planTaskNotifications({
      prev: snapStatus(before),
      prevAsk: snapAsk(before),
      tasks: after,
      hasFocus: over.hasFocus ?? false,
      activeTaskId: over.activeTaskId ?? null,
      describeBody: () => "兜底正文",
    });

  it("running → running + hasPendingAsk：发「AI 在等你回答」", () => {
    expect(run([r("a", "running")], [r("a", "running", true)])).toEqual([
      { title: "标题-a", body: "AI 在等你回答", taskId: "a", kind: "ask" },
    ]);
  });

  it("已经在等答案（上一轮就有 ask）→ 不重复发；答完又问新的（false→true）再发", () => {
    expect(run([r("a", "running", true)], [r("a", "running", true)])).toEqual([]);
    const second = run([r("a", "running", false)], [r("a", "running", true)]);
    expect(second).toHaveLength(1);
  });

  it("同一轮既转 awaiting_user 又有 ask → 只发一条，以「在等你回答」为准", () => {
    const out = run([r("a", "running")], [r("a", "awaiting_user", true)]);
    expect(out).toEqual([{ title: "标题-a", body: "AI 在等你回答", taskId: "a", kind: "ask" }]);
  });

  it("聚焦且正看着该任务 → 静音；在看别的 → 照发", () => {
    const before = [r("a", "running")];
    const after = [r("a", "running", true)];
    expect(run(before, after, { hasFocus: true, activeTaskId: "a" })).toEqual([]);
    expect(run(before, after, { hasFocus: true, activeTaskId: "b" })).toHaveLength(1);
  });

  it("不传 prevAsk（旧调用方）→ 不检测 ask 转变沿，行为与之前一致", () => {
    const out = planTaskNotifications({
      prev: snapStatus([r("a", "running")]),
      tasks: [r("a", "running", true)],
      hasFocus: false,
      activeTaskId: null,
      describeBody: () => "x",
    });
    expect(out).toEqual([]);
  });

  it("首见的任务（上一轮没有）即使带 ask 也不补发（陈旧状态）", () => {
    expect(run([], [r("new", "running", true)])).toEqual([]);
  });
});

describe(`R11-06：恰好多 1 条不折成「另有 1 个」`, () => {
  it(`${MAX_TASK_NOTIFICATIONS_PER_PASS + 1} 个转变 → ${MAX_TASK_NOTIFICATIONS_PER_PASS + 1} 条单独通知（不是 3 + 另有 1 个）`, () => {
    const ids = Array.from({ length: MAX_TASK_NOTIFICATIONS_PER_PASS + 1 }, (_, i) => `t${i}`);
    const out = planTaskNotifications({
      prev: new Map(ids.map((id) => [id, "running" as RunStatus])),
      tasks: ids.map((id) => ({ id, title: id, runStatus: "awaiting_user" as RunStatus })),
      hasFocus: false,
      activeTaskId: null,
      describeBody: () => "b",
    });
    expect(out.map((n) => n.taskId)).toEqual(ids);
  });
});

describe("R11-01：跨轮次节流 applyNotifyThrottle", () => {
  const item = (taskId: string) => ({ title: `标题-${taskId}`, body: "AI 已回复", taskId });

  it("同一任务 cooldown 内重复通知被丢掉，过了 cooldown 再发", () => {
    const st = createNotifyThrottle();
    const t0 = 1_000_000;
    expect(applyNotifyThrottle([item("a")], st, t0)).toHaveLength(1);
    expect(applyNotifyThrottle([item("a")], st, t0 + 2_000)).toEqual([]);
    expect(applyNotifyThrottle([item("a")], st, t0 + TASK_NOTIFY_COOLDOWN_MS - 1)).toEqual([]);
    expect(applyNotifyThrottle([item("a")], st, t0 + TASK_NOTIFY_COOLDOWN_MS)).toHaveLength(1);
  });

  it("不同任务互不影响 cooldown", () => {
    const st = createNotifyThrottle();
    expect(applyNotifyThrottle([item("a"), item("b")], st, 5_000)).toHaveLength(2);
  });

  it(`全局窗口内最多 ${TASK_NOTIFY_WINDOW_MAX} 条，超出并成一条汇总（每个窗口最多一条汇总）`, () => {
    const st = createNotifyThrottle();
    const ids = Array.from({ length: TASK_NOTIFY_WINDOW_MAX + 3 }, (_, i) => `t${i}`);
    const t0 = 2_000_000;
    const first = applyNotifyThrottle(ids.map(item), st, t0);
    expect(first).toHaveLength(TASK_NOTIFY_WINDOW_MAX + 1);
    expect(first[first.length - 1]).toEqual({ title: "Flowship", body: "另有 3 个任务有更新" });
    // 同一窗口里又来一批新任务：名额用完、汇总已发过 → 本窗口不再弹（Q8-03②：不再静默丢，结转到下一窗口）
    const later = applyNotifyThrottle([item("x1"), item("x2")], st, t0 + 5_000);
    expect(later).toEqual([]);
    // 窗口过去后恢复；上个窗口结转的 2 个并入这次的汇总（旧行为：这 2 个永远没人知道）
    const after = applyNotifyThrottle([item("y1")], st, t0 + TASK_NOTIFY_WINDOW_MS + 1);
    expect(after).toEqual([item("y1"), { title: "Flowship", body: "另有 2 个任务有更新" }]);
    // 结转只发一次
    const again = applyNotifyThrottle([item("y2")], st, t0 + TASK_NOTIFY_WINDOW_MS + 2);
    expect(again).toEqual([item("y2")]);
  });

  it("汇总条（无 taskId）不进 cooldown；Map 不会无界增长", () => {
    const st = createNotifyThrottle();
    let now = 3_000_000;
    for (let i = 0; i < 200; i++) {
      applyNotifyThrottle([item(`t${i}`)], st, now);
      now += TASK_NOTIFY_COOLDOWN_MS + 1; // 每轮都过 cooldown
    }
    expect(st.lastByTask.size).toBeLessThanOrEqual(2);
  });

  it("模拟飞书桥接：一个后台会话 10 分钟里每 2s 一轮完成 → 不超过每 30s 一条", () => {
    const st = createNotifyThrottle();
    let sent = 0;
    for (let t = 0; t < 600_000; t += 2_000) {
      sent += applyNotifyThrottle([item("bridge")], st, 10_000_000 + t).length;
    }
    expect(sent).toBeLessThanOrEqual(Math.ceil(600_000 / TASK_NOTIFY_COOLDOWN_MS));
  });
});

describe("watcher 接线（D6-01 / R11-01）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/components/task-attention-watcher.tsx"),
    "utf8",
  );
  it("每轮更新 prevAsk 基线、把它传给 plan，并经 applyNotifyThrottle 再发", () => {
    expect(src).toMatch(/prevAskRef\.current = new Map\(/);
    expect(src).toMatch(/prevAsk,/);
    expect(src).toMatch(/applyNotifyThrottle\(due, throttleRef\.current, Date\.now\(\)\)/);
  });
});


describe("Q8-03：节流口径——cooldown 分类型 / 异常不受限 / 汇总计数真实", () => {
  const mk = (taskId: string, kind: "ask" | "reply" | "error", body = kind) => ({
    title: `标题-${taskId}`,
    body,
    taskId,
    kind,
  });

  it("① 回复通知后 20s 内该任务转 error：异常通知仍发（旧：被 cooldown 吞掉）", () => {
    const st = createNotifyThrottle();
    const t0 = 1_000_000;
    expect(applyNotifyThrottle([mk("a", "reply")], st, t0)).toHaveLength(1);
    const out = applyNotifyThrottle([mk("a", "error")], st, t0 + 20_000);
    expect(out.map((n) => n.kind)).toEqual(["error"]);
  });

  it("① ask 通知后 25s 内跑完（reply）：完成通知照发——类型不同各算各的 cooldown", () => {
    const st = createNotifyThrottle();
    const t0 = 2_000_000;
    applyNotifyThrottle([mk("a", "ask")], st, t0);
    expect(applyNotifyThrottle([mk("a", "reply")], st, t0 + 25_000)).toHaveLength(1);
  });

  it("反例（旧行为仍成立）：同任务同类型 cooldown 内重复仍被吞；异常类不被窗口限额挡", () => {
    const st = createNotifyThrottle();
    const t0 = 3_000_000;
    expect(applyNotifyThrottle([mk("a", "reply")], st, t0)).toHaveLength(1);
    expect(applyNotifyThrottle([mk("a", "reply")], st, t0 + 1_000)).toEqual([]);
    expect(applyNotifyThrottle([ mk("a", "ask")], st, t0 + 1_000)).toHaveLength(1);
    // 窗口名额用满后，异常类仍能发（不占名额）
    const st2 = createNotifyThrottle();
    const fill = Array.from({ length: TASK_NOTIFY_WINDOW_MAX }, (_, i) => mk(`f${i}`, "reply"));
    expect(applyNotifyThrottle(fill, st2, t0)).toHaveLength(TASK_NOTIFY_WINDOW_MAX);
    const err1 = applyNotifyThrottle([mk("e1", "error")], st2, t0 + 1_000);
    expect(err1).toHaveLength(1);
    // 不同任务的 error 同样不占名额、不被名额挡
    expect(applyNotifyThrottle([mk("e2", "error")], st2, t0 + 2_000)).toHaveLength(1);
  });

  it("第五轮：同任务 error 抖动（error→running→error）按 cooldown 节流；cooldown 过后照发；不同任务 / 不同类型不受影响", () => {
    const st = createNotifyThrottle();
    const t0 = 5_000_000;
    expect(applyNotifyThrottle([mk("e1", "error")], st, t0)).toHaveLength(1);
    // 自动重连抖动：2s、10s 后又一次 error——被吞（旧：每次都发）
    expect(applyNotifyThrottle([mk("e1", "error")], st, t0 + 2_000)).toEqual([]);
    expect(applyNotifyThrottle([mk("e1", "error")], st, t0 + 10_000)).toEqual([]);
    // 别的任务的 error、同任务别的类型都不受这条 cooldown 影响
    expect(applyNotifyThrottle([mk("e2", "error")], st, t0 + 11_000)).toHaveLength(1);
    expect(applyNotifyThrottle([mk("e1", "ask")], st, t0 + 12_000)).toHaveLength(1);
    // cooldown 过后（30s）又 error：照发（真的需要人处理）
    expect(applyNotifyThrottle([mk("e1", "error")], st, t0 + 31_000)).toHaveLength(1);
  });

  it("③ 汇总数不低估：已占 3 个名额，一轮 6 个任务同时转变 → 汇总说「另有 5 个」（旧：3）", () => {
    const st = createNotifyThrottle();
    const t0 = 4_000_000;
    // 先占 3 个名额
    applyNotifyThrottle([mk("p1", "reply"), mk("p2", "reply"), mk("p3", "reply")], st, t0);
    // 一轮 6 个任务同时转变：plan 先折成 3 条 + 1 条「另有 3 个」（count=3）
    const ids = ["a", "b", "c", "d", "e", "f"];
    const planned = planTaskNotifications({
      prev: new Map(ids.map((id) => [id, "running" as RunStatus])),
      tasks: ids.map((id) => ({ id, title: `标题-${id}`, runStatus: "awaiting_user" as RunStatus })),
      hasFocus: false,
      activeTaskId: null,
      describeBody: () => "x",
    });
    expect(planned).toHaveLength(MAX_TASK_NOTIFICATIONS_PER_PASS + 1);
    const out = applyNotifyThrottle(planned, st, t0 + 1_000);
    // 只剩 1 个名额：a 发出；b、c + plan 汇总（代表 3 个）被挡 → 实际 5 个任务没送达
    expect(out.filter((n) => n.taskId).map((n) => n.taskId)).toEqual(["a"]);
    expect(out[out.length - 1]).toEqual({ title: "Flowship", body: "另有 5 个任务有更新" });
  });

  it("② 被 cooldown 吞掉的任务计入下一次汇总，但 cooldown 本身不触发汇总（桥接重复完成不刷汇总）", () => {
    const st = createNotifyThrottle();
    const t0 = 5_000_000;
    applyNotifyThrottle([mk("a", "reply")], st, t0);
    // 5s 后 a 又完成（cooldown 吞掉）——单独不弹汇总
    expect(applyNotifyThrottle([mk("a", "reply")], st, t0 + 5_000)).toEqual([]);
    // 同一窗口后来溢出：名额再来 4 个新任务（窗口里已发 1 个，允许 3 个，第 4 个溢出）
    const more = ["n1", "n2", "n3", "n4"].map((id) => mk(id, "reply"));
    const out = applyNotifyThrottle(more, st, t0 + 6_000);
    expect(out.filter((n) => n.taskId)).toHaveLength(TASK_NOTIFY_WINDOW_MAX - 1);
    // 汇总 = 1 个溢出 + 1 个被 cooldown 吞掉的 a
    expect(out[out.length - 1]).toEqual({ title: "Flowship", body: "另有 2 个任务有更新" });
  });

  it("桥接回归：一个任务 10 分钟里每 2s 完成一次 → 通知总数（含汇总）仍不超过每 30s 一条", () => {
    const st = createNotifyThrottle();
    let sent = 0;
    for (let t = 0; t < 600_000; t += 2_000) {
      sent += applyNotifyThrottle([mk("bridge", "reply")], st, 20_000_000 + t).length;
    }
    expect(sent).toBeLessThanOrEqual(Math.ceil(600_000 / TASK_NOTIFY_COOLDOWN_MS));
  });

  it("没有本轮通知时不会凭空弹结转的汇总（items 为空只更新状态）", () => {
    const st = createNotifyThrottle();
    const t0 = 6_000_000;
    const ids = Array.from({ length: TASK_NOTIFY_WINDOW_MAX + 1 }, (_, i) => mk(`t${i}`, "reply"));
    applyNotifyThrottle(ids, st, t0); // 4 条 + 汇总
    applyNotifyThrottle([mk("x", "reply")], st, t0 + 1_000); // 结转 1
    expect(applyNotifyThrottle([], st, t0 + TASK_NOTIFY_WINDOW_MS + 5)).toEqual([]);
  });
});
