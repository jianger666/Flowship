/**
 * V7-03：定时 / 服务端发起的 run 唤醒会话并跑完，客户端「无轮询、侧栏不转圈」。
 *
 * 根因：use-task-list 的列表轮询只在「有任务在跑 || 飞书桥接开」时开；会话空闲 + 窗口失焦时，
 * 到点的定时在服务端把 chat 唤醒并跑完，渲染进程没有任何触发点去知道。
 *
 * 修法（方案 A，最小改动）：服务端在 `GET /api/tasks` 给「还有会触发的定时」的会话打 `hasLiveSchedule`，
 * 客户端据此在**没有别的轮询理由时**以低频（30s，页面不可见 60s）兜底刷新；没有 live 定时就一次都不轮询。
 *
 * 这里测纯函数 + 源码接线契约（tsconfig jsx: preserve，测试不能 import .tsx）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  TASK_LIST_BUSY_POLL_MS,
  TASK_LIST_SCHEDULE_POLL_HIDDEN_MS,
  TASK_LIST_SCHEDULE_POLL_MS,
  TASK_LIST_FETCH_TIMEOUT_MS,
  TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS,
  canStartPoll,
  createTaskListUpsertTracker,
  keepNewerLocalRows,
  keepRowsUpsertedDuringFetch,
  pruneUpsertTimes,
  UPSERT_TRACK_TTL_MS,
  shouldClearPollInflight,
  hasLiveScheduleTask,
  markLiveScheduleTasks,
  pickTaskListPollPlan,
  sameTaskList,
} from "@/lib/task-list-poll";

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

const base = { busy: false, bridgeOn: false, scheduleLive: false, pageHidden: false };

describe("pickTaskListPollPlan", () => {
  it("没有任何轮询理由 → 不轮询（无 live 定时一次都不多刷）", () => {
    expect(pickTaskListPollPlan(base)).toBeNull();
    expect(pickTaskListPollPlan({ ...base, pageHidden: true })).toBeNull();
  });

  it("有任务在忙 → 沿用原 2s，且不是 quiet（原行为不变）", () => {
    expect(pickTaskListPollPlan({ ...base, busy: true })).toEqual({
      intervalMs: TASK_LIST_BUSY_POLL_MS,
      quiet: false,
    });
    expect(TASK_LIST_BUSY_POLL_MS).toBe(2000);
  });

  it("飞书桥接开 → 沿用原 2s", () => {
    expect(pickTaskListPollPlan({ ...base, bridgeOn: true })).toEqual({
      intervalMs: 2000,
      quiet: false,
    });
  });

  it("忙 / 桥接优先于定时兜底：即使页面不可见也不改原有 2s（原行为不变）", () => {
    expect(
      pickTaskListPollPlan({ busy: true, bridgeOn: false, scheduleLive: true, pageHidden: true }),
    ).toEqual({ intervalMs: 2000, quiet: false });
    expect(
      pickTaskListPollPlan({ busy: false, bridgeOn: true, scheduleLive: true, pageHidden: false }),
    ).toEqual({ intervalMs: 2000, quiet: false });
  });

  it("只有 live 定时 → 低频兜底（30s），页面不可见再降到 60s，且是 quiet", () => {
    expect(pickTaskListPollPlan({ ...base, scheduleLive: true })).toEqual({
      intervalMs: TASK_LIST_SCHEDULE_POLL_MS,
      quiet: true,
    });
    expect(
      pickTaskListPollPlan({ ...base, scheduleLive: true, pageHidden: true }),
    ).toEqual({ intervalMs: TASK_LIST_SCHEDULE_POLL_HIDDEN_MS, quiet: true });
    expect(TASK_LIST_SCHEDULE_POLL_MS).toBe(30_000);
    expect(TASK_LIST_SCHEDULE_POLL_HIDDEN_MS).toBe(60_000);
  });

  it("兜底频率必须远低于 2s 档、且不可见时不比可见时更频繁", () => {
    expect(TASK_LIST_SCHEDULE_POLL_MS).toBeGreaterThanOrEqual(TASK_LIST_BUSY_POLL_MS * 10);
    expect(TASK_LIST_SCHEDULE_POLL_HIDDEN_MS).toBeGreaterThanOrEqual(TASK_LIST_SCHEDULE_POLL_MS);
  });
});

describe("markLiveScheduleTasks / hasLiveScheduleTask", () => {
  const rows = [{ id: "a", x: 1 }, { id: "b", x: 2 }, { id: "c", x: 3 }];

  it("只给在 live 集合里的会话打 hasLiveSchedule: true，其余行原样（同一引用）", () => {
    const out = markLiveScheduleTasks(rows, ["b"]);
    expect(out[0]).toBe(rows[0]);
    expect(out[2]).toBe(rows[2]);
    expect(out[1]).toEqual({ id: "b", x: 2, hasLiveSchedule: true });
    // 不改入参
    expect(rows[1]).toEqual({ id: "b", x: 2 });
  });

  it("没有 live 会话 → 原数组原样返回（payload 不变、零分配）", () => {
    expect(markLiveScheduleTasks(rows, [])).toBe(rows);
    expect(markLiveScheduleTasks(rows, ["not-in-list"])[0]).toBe(rows[0]);
  });

  it("hasLiveScheduleTask：只认 true", () => {
    expect(hasLiveScheduleTask([])).toBe(false);
    expect(hasLiveScheduleTask([{ id: "a" }, { id: "b", hasLiveSchedule: false }])).toBe(false);
    expect(hasLiveScheduleTask([{ id: "a" }, { id: "b", hasLiveSchedule: true }])).toBe(true);
  });
});

describe("sameTaskList（内容未变就沿用旧引用）", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    title: "对话",
    runStatus: "awaiting_user",
    repoPaths: ["/a", "/b"],
    ...over,
  });

  it("同引用 / 深相等的新数组 → 相同", () => {
    const a = [row(), row({ id: "t2" })];
    expect(sameTaskList(a, a)).toBe(true);
    expect(sameTaskList(a, [row(), row({ id: "t2" })])).toBe(true);
    expect(sameTaskList([], [])).toBe(true);
  });

  it("长度 / 顺序 / 任一字段（含嵌套数组）不同 → 不同", () => {
    const a = [row(), row({ id: "t2" })];
    expect(sameTaskList(a, [row()])).toBe(false);
    expect(sameTaskList(a, [row({ id: "t2" }), row()])).toBe(false);
    expect(sameTaskList(a, [row({ runStatus: "running" }), row({ id: "t2" })])).toBe(false);
    expect(sameTaskList(a, [row({ repoPaths: ["/a", "/c"] }), row({ id: "t2" })])).toBe(false);
    expect(sameTaskList(a, [row({ hasLiveSchedule: true }), row({ id: "t2" })])).toBe(false);
  });
});

describe("接线契约", () => {
  const hook = read("src/hooks/use-task-list.tsx");

  it("use-task-list：轮询间隔来自 pickTaskListPollPlan，不再是 `!hasRunning && !bridgeOn` 硬门", () => {
    expect(hook).toMatch(/pickTaskListPollPlan\(/);
    expect(hook).not.toMatch(/if \(!hasRunning && !bridgeOn\) return;/);
    // 间隔用算出来的，不再写死 POLL_INTERVAL_MS 给 setInterval
    expect(hook).toMatch(/const pollMs = plan\?\.intervalMs \?\? null;/);
    expect(hook).toMatch(/setInterval\([\s\S]{0,500}pollMs/);
    // R11-07：上一次轮询没返回就不叠发
    // Q8-06：守卫带超时 + 世代（行为见下方 Q8-06 describe；这里只钉接线）
    expect(hook).toMatch(/canStartPoll\(pollInflightRef\.current, now\)\) return;/);
    expect(hook).toMatch(/shouldClearPollInflight\(pollInflightRef\.current, token\)/);
    // 响应落地的合并（含 keepNewerLocalRows：本地更新的行不回滚）收在 upsertTracker.merge，行为见下方 createTaskListUpsertTracker 用例
    expect(hook).toMatch(/upsertTracker\.merge\(\s*prev,\s*nextList,/);
    expect(hook).not.toMatch(/POLL_INTERVAL_MS/);
  });

  it("use-task-list：页面可见性变化会重算间隔（visibilitychange）", () => {
    expect(hook).toMatch(/visibilitychange/);
    expect(hook).toMatch(/document\.visibilityState === "hidden"/);
  });

  it("use-task-list：scheduleLive 在 refresh 里从列表响应取（不从会被 upsert 覆盖的行上取）", () => {
    expect(hook).toMatch(/hasLiveScheduleTask\(/);
    expect(hook).toMatch(/setScheduleLive\(/);
  });

  it("use-task-list：只有兜底轮询（quiet）走「内容没变就沿用旧引用」，2s 档行为不变", () => {
    expect(hook).toMatch(/reuseIfSame && sameTaskList\(prev, merged\) \? prev : merged/);
    expect(hook).toMatch(/const pollQuiet = plan\?\.quiet \?\? false;/);
    expect(hook).toMatch(/pollQuiet \? refreshQuiet\(\) : refresh\(\)/);
    // 对外 refresh / 聚焦 / 尾刷都走不复用的原行为
    expect(hook).toMatch(/const refresh = useCallback\(\(\) => runRefresh\(false\), \[runRefresh\]\);/);
    expect(hook).toMatch(/const refreshQuiet = useCallback\(\(\) => runRefresh\(true\), \[runRefresh\]\);/);
  });

  it("GET /api/tasks 给 live 定时的会话打标（读进程内索引，不读盘）", () => {
    const route = read("src/app/api/tasks/route.ts");
    expect(route).toMatch(/markLiveScheduleTasks\(/);
    expect(route).toMatch(/scheduleLiveTaskIds\(\)/);
    expect(route).toMatch(/from "@\/lib\/server\/schedule-store"/);
  });

  it("TaskSummary 声明 hasLiveSchedule（可选）", () => {
    expect(read("src/lib/types.ts")).toMatch(/hasLiveSchedule\?: boolean;/);
  });
});


describe("Q8-06：在途守卫超时 / 世代 + 慢轮询不回滚新状态", () => {
  it("不变量：守卫超时 < 请求超时（卡住的请求在被 abort 之前，守卫就先放行下一轮）", () => {
    expect(TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS).toBeLessThan(TASK_LIST_FETCH_TIMEOUT_MS);
    expect(TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS).toBeGreaterThan(TASK_LIST_BUSY_POLL_MS);
  });

  it("canStartPoll：没有在途 → 可发；在途未超时 → 不叠发（R11-07 行为保留）；在途超时 → 放行", () => {
    expect(canStartPoll(null, 1_000)).toBe(true);
    const inflight = { token: 1, startedAt: 1_000 };
    expect(canStartPoll(inflight, 1_000 + 2_000)).toBe(false);
    expect(canStartPoll(inflight, 1_000 + TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS - 1)).toBe(false);
    expect(canStartPoll(inflight, 1_000 + TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS)).toBe(true);
  });

  it("模拟：一个请求永不返回 → 2s 档轮询在超时后恢复，而不是永久停摆", () => {
    // 复刻 hook 里 setInterval 的处理：每 2s 一个 tick
    let inflight: { token: number; startedAt: number } | null = null;
    let token = 0;
    const started: number[] = [];
    for (let now = 0; now <= 40_000; now += TASK_LIST_BUSY_POLL_MS) {
      if (!canStartPoll(inflight, now)) continue;
      inflight = { token: (token += 1), startedAt: now };
      started.push(now);
      // 第 1 个请求永不返回；之后的请求当场返回
      if (token > 1 && shouldClearPollInflight(inflight, token)) inflight = null;
    }
    expect(started[0]).toBe(0);
    // 旧树（只有 boolean 守卫）这里 started 只有 [0]；新树在超时之后继续
    expect(started.length).toBeGreaterThan(2);
    expect(started[1]).toBe(TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS);
  });

  it("世代保护：被超时放行后，旧请求迟到结束不会清掉新一轮的在途记录", () => {
    const stale = { token: 1, startedAt: 0 };
    const fresh = { token: 2, startedAt: 13_000 };
    expect(shouldClearPollInflight(fresh, stale.token)).toBe(false); // 旧请求结束：不清
    expect(shouldClearPollInflight(fresh, fresh.token)).toBe(true); // 新请求结束：清
    expect(shouldClearPollInflight(null, 1)).toBe(false);
  });

  const row = (id: string, updatedAt: number, runStatus = "idle") => ({ id, updatedAt, runStatus });

  it("SSE 回灌已把某行推进后，更早发出的慢轮询响应不回滚它（本地 updatedAt 更新 → 保留本地行）", () => {
    const local = [row("a", 2_000, "awaiting_user"), row("b", 1_000)];
    const slowResponse = [row("a", 1_000, "running"), row("b", 1_000)];
    const merged = keepNewerLocalRows(local, slowResponse);
    expect(merged[0]).toBe(local[0]);
    expect(merged[0].runStatus).toBe("awaiting_user");
    expect(merged[1]).toBe(slowResponse[1]);
  });

  it("反例（旧树能用的情形仍能用）：响应更新或相等 → 取响应；本地没有的行 / 无本地行 → 原样", () => {
    const local = [row("a", 1_000), row("b", 1_000)];
    const resp = [row("a", 1_000, "running"), row("b", 3_000, "error"), row("c", 500)];
    const merged = keepNewerLocalRows(local, resp);
    // 无需保留任何本地行 → 同一引用（保持「2s 档每次换新引用」的原行为）
    expect(merged).toBe(resp);
    expect(keepNewerLocalRows([], resp)).toBe(resp);
  });
});

describe("第五轮 Q8-06 同族：慢轮询响应不抹掉「请求发出之后才本地新建」的行", () => {
  const row = (id: string, updatedAt = 1_000, runStatus = "idle") => ({ id, updatedAt, runStatus });

  it("请求发出之后本地才 upsert 的新任务：响应里没有它 → 补回（放最前，与 upsertTask 插入位置一致）", () => {
    const fetchStartedAt = 10_000;
    const local = [row("new", 10_500), row("a"), row("b")];
    const slowResponse = [row("a"), row("b")]; // 创建之前发出的慢请求
    const merged = keepRowsUpsertedDuringFetch(local, slowResponse, new Map([["new", 10_500]]), fetchStartedAt);
    expect(merged.map((t) => t.id)).toEqual(["new", "a", "b"]);
    expect(merged[0]).toBe(local[0]);
    // 与 keepNewerLocalRows 串起来用（hook 里的顺序：先 keepNewerLocalRows、再补回）：结果一致
    expect(
      keepRowsUpsertedDuringFetch(local, keepNewerLocalRows(local, slowResponse), new Map([["new", 10_500]]), fetchStartedAt).map((t) => t.id),
    ).toEqual(["new", "a", "b"]);
  });

  it("旧树能用的情形：请求发出之前就在本地、响应里没有 = 服务端确实没有了（别处删的）→ 照旧丢掉", () => {
    const local = [row("gone"), row("a")];
    const response = [row("a")];
    // gone 的 upsert 发生在请求之前
    const merged = keepRowsUpsertedDuringFetch(local, response, new Map([["gone", 5_000]]), 10_000);
    expect(merged).toBe(response);
    // 没有任何 upsert 记录 → 同一引用
    expect(keepRowsUpsertedDuringFetch(local, response, new Map(), 10_000)).toBe(response);
    expect(keepRowsUpsertedDuringFetch([], response, new Map([["x", 99_999]]), 10_000)).toBe(response);
  });

  it("响应里有这一行就不重复补（按 id 去重）", () => {
    const local = [row("a", 12_000)];
    const response = [row("a", 11_000)];
    const merged = keepRowsUpsertedDuringFetch(local, response, new Map([["a", 12_000]]), 10_000);
    expect(merged).toBe(response);
  });

  it("多条同时新建：保持它们在本地列表里的相对顺序", () => {
    const local = [row("n2"), row("n1"), row("a")];
    const merged = keepRowsUpsertedDuringFetch(
      local,
      [row("a")],
      new Map([["n1", 20_000], ["n2", 20_100]]),
      10_000,
    );
    expect(merged.map((t) => t.id)).toEqual(["n2", "n1", "a"]);
  });

  it("pruneUpsertTimes：只清过期记录（防无界增长），TTL 内的保留", () => {
    const m = new Map<string, number>([["old", 0], ["fresh", UPSERT_TRACK_TTL_MS]]);
    pruneUpsertTimes(m, UPSERT_TRACK_TTL_MS + 1);
    expect([...m.keys()]).toEqual(["fresh"]);
    expect(UPSERT_TRACK_TTL_MS).toBeGreaterThanOrEqual(TASK_LIST_FETCH_TIMEOUT_MS);
  });

  it("接线（补充）：use-task-list 发请求前记时间、upsertTask 里 mark、响应落地走 tracker.merge（不再自带 Map）", () => {
    const src = read("src/hooks/use-task-list.tsx");
    const flat = src.replace(/\s+/g, " ");
    // 请求发出时间必须在 await fetchTaskList 之前取（否则「请求之后才新建」的判定基准偏后，新建行被漏补回）
    expect(src.indexOf("const fetchStartedAt = Date.now()")).toBeGreaterThan(-1);
    expect(src.indexOf("const fetchStartedAt = Date.now()")).toBeLessThan(src.indexOf("await fetchTaskList()"));
    // 合并 / 记录都走 tracker，hook 自己不再维护时间表
    expect(flat).toContain("upsertTracker.merge( prev, nextList, fetchStartedAt,");
    expect(src).toContain("upsertTracker.mark(summary.id)");
    // tracker 必须由 useState 初始化器持有（跨渲染稳定）：useMemo 可能被 React 丢缓存，tracker 一重建 upsert 时间就清零（第七轮 R7-5）。
    // ⚠ 源码文本契约（无 jsdom / testing-library，hook 没法行为测）：认 useState 初始化器的两种等价写法，拒 useMemo / useRef / 每次渲染新建
    expect(flat).toMatch(
      /const \[upsertTracker\] = useState\(\s*(?:\(\) => )?createTaskListUpsertTracker(?:\(\))?\s*\);/,
    );
    expect(flat).not.toMatch(/useMemo\([\s\S]{0,60}createTaskListUpsertTracker/);
    expect(flat).not.toMatch(/useRef\([\s\S]{0,20}createTaskListUpsertTracker/);
    expect(src).not.toContain("upsertedAtRef");
    expect(src).not.toMatch(/keepRowsUpsertedDuringFetch\(|pruneUpsertTimes\(/);
    // 删除中 / 已删除 / 终态删除的 id 不得被补回（isGone 三项都在）
    const mergeCall = flat.slice(flat.indexOf("upsertTracker.merge("), flat.indexOf("upsertTracker.merge(") + 400);
    expect(mergeCall).toContain("pendingDeletesRef.current.has(id)");
    expect(mergeCall).toContain("successfulDeletedIdsRef.current.has(id)");
    expect(mergeCall).toContain("isTaskTerminalDeleted(id)");
  });
});

describe("第六轮 P3-3：createTaskListUpsertTracker——hook 的合并序列用真对象测（不依赖 hook 怎么传参）", () => {
  const row = (id: string, updatedAt = 1_000, runStatus = "idle") => ({ id, updatedAt, runStatus });

  it("序列：请求发出(10_000) → 本地新建(mark 10_500) → 慢响应(没有它)落地 → 新任务补回、放最前", () => {
    const t = createTaskListUpsertTracker();
    const fetchStartedAt = 10_000;
    t.mark("new", 10_500);
    const prev = [row("new", 10_500), row("a"), row("b")];
    const merged = t.merge(prev, [row("a"), row("b")], fetchStartedAt);
    expect(merged.map((x) => x.id)).toEqual(["new", "a", "b"]);
    expect(merged[0]).toBe(prev[0]);
  });

  it("没 mark（本地行不是 upsert 来的）/ mark 在请求之前 → 响应里没有 = 服务端没有了，丢掉；无需补时同一引用", () => {
    const t = createTaskListUpsertTracker();
    const response = [row("a")];
    expect(t.merge([row("x"), row("a")], response, 10_000)).toBe(response);
    t.mark("x", 5_000);
    expect(t.merge([row("x"), row("a")], response, 10_000)).toBe(response);
  });

  it("本地更新的行不被慢响应回滚（keepNewerLocalRows），同时新建行照样补回——两条规则同一次合并里都生效", () => {
    const t = createTaskListUpsertTracker();
    t.mark("new", 10_500);
    t.mark("a", 10_600);
    const prev = [row("new", 10_500), row("a", 9_000, "done"), row("b")];
    const merged = t.merge(prev, [row("a", 8_000, "running"), row("b")], 10_000);
    expect(merged.map((x) => `${x.id}:${x.runStatus}`)).toEqual(["new:idle", "a:done", "b:idle"]);
  });

  it("isGone：删除中 / 已删除 / 终态删除的 id 即使刚 mark 过也不补回（防复活）；其它新建行照常补回", () => {
    const t = createTaskListUpsertTracker();
    t.mark("deleted", 10_500);
    t.mark("fresh", 10_600);
    const prev = [row("fresh"), row("deleted"), row("a")];
    const merged = t.merge(prev, [row("a")], 10_000, (id) => id === "deleted");
    expect(merged.map((x) => x.id)).toEqual(["fresh", "a"]);
    // 不传 isGone：两条都补回（证明过滤来自 isGone 而不是别处）
    expect(t.merge(prev, [row("a")], 10_000).map((x) => x.id)).toEqual(["fresh", "deleted", "a"]);
  });

  it("mark 顺手清过期记录（防无界增长）：过期的 upsert 记录不再触发补回", () => {
    const t = createTaskListUpsertTracker();
    t.mark("old", 0);
    t.mark("recent", UPSERT_TRACK_TTL_MS + 1); // 触发清理：old 已过 TTL
    const merged = t.merge([row("old"), row("recent")], [], -1);
    expect(merged.map((x) => x.id)).toEqual(["recent"]);
  });

  it("每个 tracker 各自独立（不共享模块级状态）", () => {
    const t1 = createTaskListUpsertTracker();
    const t2 = createTaskListUpsertTracker();
    t1.mark("x", 10_500);
    const response = [row("a")];
    expect(t2.merge([row("x"), row("a")], response, 10_000)).toBe(response);
    expect(t1.merge([row("x"), row("a")], response, 10_000).map((r) => r.id)).toEqual(["x", "a"]);
  });
});
