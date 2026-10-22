/**
 * 任务列表里「后台子代理还在跑」的指示（2026-10-19 用户要求全面排查「明明还在跑却显示完成 / 空闲」）。
 *
 * 与事件流里「子代理卡片打勾但其实还在跑」同一类问题的列表版：主 AI 说完一轮后 runStatus 回
 * awaiting_user / idle，派到后台的子代理还在干活——侧栏 / 会话管理页只认 runStatus 就把它画成空闲。
 *
 *   A. 纯函数（task-background）：判定口径、upsert 时保留读数
 *   B. 服务端：getBackgroundSubagentCount 与 provider 同源；GET /api/tasks 只给「有后台」的行补读数
 *   C. 接线与 UI 契约（源码契约）：侧栏 / 会话页转圈、轮询在有读数期间保持开着、详情页回灌不闪回空闲
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUSY_TAIL_REFRESH_MS,
  hasBackgroundSubagents,
  isTaskBusy,
  keepBackgroundSubagentCount,
  shouldTailRefreshAfterBusy,
} from "@/lib/task-background";
import type { TaskSummary } from "@/lib/types";

// ---------- 假数据 ----------

const summary = (over: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: "t_1",
    title: "测试对话",
    mode: "chat",
    runStatus: "awaiting_user",
    updatedAt: 1000,
    actionCount: 0,
    ...over,
  }) as TaskSummary;

// ---------- 路由依赖（只留 subagent-background 是真的） ----------

const listTasksMock = vi.fn<() => Promise<TaskSummary[]>>();

vi.mock("@/lib/server/task-fs", () => ({
  listTasks: () => listTasksMock(),
  // GET /api/tasks 改调 listTasksWithCorrupt（同时带「损坏的任务」）；这里只关心 tasks、corrupt 恒空
  listTasksWithCorrupt: async () => ({ tasks: await listTasksMock(), corrupt: [] }),
  // 与真实实现同形：把 wrap 的结果包成 Response（这里只关心 body）
  commitReadableTaskListResponse: <T extends { id: string }>(
    items: T[],
    wrap: (filtered: T[]) => unknown,
  ) => Response.json(wrap(items)),
  createTask: vi.fn(),
}));
vi.mock("@/lib/server/feishu-bridge/bootstrap", () => ({
  ensureFeishuBridgeBootstrapped: () => {},
}));
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: async () => {},
}));
vi.mock("@/lib/server/task-runner", () => ({
  prewarmTaskWorkspace: () => {},
}));

const sub = await import("@/lib/server/subagent-background");
const { GET } = await import("@/app/api/tasks/route");

const job = (id: string) => ({
  id,
  description: "渲染",
  startedAt: 1,
  detached: false,
});

// ---------- A. 纯函数 ----------

describe("A. task-background 纯函数", () => {
  it("hasBackgroundSubagents：只有正数才算；缺省 / 0 / 负数 / NaN / 非数字都不算", () => {
    expect(hasBackgroundSubagents(summary())).toBe(false);
    expect(hasBackgroundSubagents(summary({ backgroundSubagentCount: 0 }))).toBe(
      false,
    );
    expect(hasBackgroundSubagents(summary({ backgroundSubagentCount: 2 }))).toBe(
      true,
    );
    for (const bad of [-1, Number.NaN, Infinity, "3", null]) {
      expect(
        hasBackgroundSubagents({
          backgroundSubagentCount: bad as unknown as number,
        }),
      ).toBe(false);
    }
  });

  it("isTaskBusy：主 AI 在跑 或 后台子代理在跑；两者都没有才是空闲", () => {
    expect(isTaskBusy(summary({ runStatus: "running" }))).toBe(true);
    expect(
      isTaskBusy(summary({ runStatus: "awaiting_user", backgroundSubagentCount: 1 })),
    ).toBe(true);
    expect(isTaskBusy(summary({ runStatus: "idle", backgroundSubagentCount: 1 }))).toBe(
      true,
    );
    expect(isTaskBusy(summary({ runStatus: "awaiting_user" }))).toBe(false);
    expect(isTaskBusy(summary({ runStatus: "idle", backgroundSubagentCount: 0 }))).toBe(
      false,
    );
  });

  it("keepBackgroundSubagentCount：新摘要没带字段（详情页回灌）→ 留旧行的读数，不闪回空闲", () => {
    const prev = summary({ backgroundSubagentCount: 2 });
    const next = summary({ updatedAt: 2000 });
    expect("backgroundSubagentCount" in next).toBe(false);
    const merged = keepBackgroundSubagentCount(prev, next);
    expect(merged.backgroundSubagentCount).toBe(2);
    // 其余字段仍取新的
    expect(merged.updatedAt).toBe(2000);
    // 不改入参
    expect("backgroundSubagentCount" in next).toBe(false);
  });

  it("keepBackgroundSubagentCount：新摘要自己带了字段（含 0）就是真值，原样采用", () => {
    const prev = summary({ backgroundSubagentCount: 2 });
    const zero = summary({ backgroundSubagentCount: 0 });
    expect(keepBackgroundSubagentCount(prev, zero)).toBe(zero);
    const one = summary({ backgroundSubagentCount: 1 });
    expect(keepBackgroundSubagentCount(prev, one)).toBe(one);
  });

  it("keepBackgroundSubagentCount：旧行没有读数 / 没有旧行 → 原样返回新摘要（同一引用）", () => {
    const next = summary();
    expect(keepBackgroundSubagentCount(undefined, next)).toBe(next);
    expect(keepBackgroundSubagentCount(summary(), next)).toBe(next);
    expect(
      keepBackgroundSubagentCount(summary({ backgroundSubagentCount: 0 }), next),
    ).toBe(next);
  });
});

describe("A2. 「忙 → 不忙」边沿补刷（读数漏读兜底）", () => {
  it("只在 忙 → 不忙 时补刷；一直忙 / 一直闲 / 闲 → 忙 都不补", () => {
    expect(shouldTailRefreshAfterBusy(true, false)).toBe(true);
    expect(shouldTailRefreshAfterBusy(true, true)).toBe(false);
    expect(shouldTailRefreshAfterBusy(false, false)).toBe(false);
    expect(shouldTailRefreshAfterBusy(false, true)).toBe(false);
  });

  it("延迟比 2s 轮询周期短、又不是 0（留一瞬给服务端登记）", () => {
    expect(BUSY_TAIL_REFRESH_MS).toBeGreaterThan(0);
    expect(BUSY_TAIL_REFRESH_MS).toBeLessThan(2000);
  });

  it("侧栏 hook 接线：边沿检测 → setTimeout 补刷 → 清理定时器（不重复触发 / 不泄漏）", () => {
    const src = read("src/hooks/use-task-list.tsx");
    const start = src.indexOf("const wasBusyRef = useRef(false)");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("const bridgeOn"));
    expect(block).toContain("wasBusyRef.current = hasRunning");
    expect(block).toContain("shouldTailRefreshAfterBusy(wasBusy, hasRunning)");
    expect(block).toContain("setTimeout(() => void refresh(), BUSY_TAIL_REFRESH_MS)");
    expect(block).toContain("clearTimeout(timer)");
  });
});

// ---------- B. 服务端 ----------

describe("B. 服务端读数", () => {
  beforeEach(() => {
    listTasksMock.mockReset();
  });
  afterEach(() => {
    sub.setBackgroundSubagentSnapshotProvider(null);
  });

  it("getBackgroundSubagentCount：没登记 provider = 0（本进程还没有任何 chat 会话）", () => {
    sub.setBackgroundSubagentSnapshotProvider(null);
    expect(sub.getBackgroundSubagentCount("t_1")).toBe(0);
  });

  it("getBackgroundSubagentCount：与 provider 同源、按任务取个数", () => {
    sub.setBackgroundSubagentSnapshotProvider((id) =>
      id === "t_1" ? [job("bg_a"), job("bg_b")] : [],
    );
    expect(sub.getBackgroundSubagentCount("t_1")).toBe(2);
    expect(sub.getBackgroundSubagentCount("t_2")).toBe(0);
    // 与脱敏快照口径一致（个数相同）
    expect(sub.getBackgroundSubagentSnapshot("t_1").length).toBe(2);
  });

  it("getBackgroundSubagentCount：provider 抛错 = 0、不抛出（列表接口不能被它拖垮）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sub.setBackgroundSubagentSnapshotProvider(() => {
      throw new Error("boom");
    });
    expect(sub.getBackgroundSubagentCount("t_1")).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("GET /api/tasks：只有在跑后台子代理的行带 backgroundSubagentCount，其余行 payload 不变", async () => {
    listTasksMock.mockResolvedValue([
      summary({ id: "t_bg" }),
      summary({ id: "t_idle" }),
      summary({ id: "t_running", runStatus: "running" }),
    ]);
    sub.setBackgroundSubagentSnapshotProvider((id) =>
      id === "t_bg" ? [job("bg_a"), job("bg_b"), job("bg_c")] : [],
    );

    const res = await GET();
    const body = (await res.json()) as { tasks: TaskSummary[] };
    const byId = new Map(body.tasks.map((t) => [t.id, t]));

    expect(byId.get("t_bg")?.backgroundSubagentCount).toBe(3);
    // 没有后台的行：字段根本不出现（不是 0），老客户端 / 老快照形状不变
    expect("backgroundSubagentCount" in byId.get("t_idle")!).toBe(false);
    expect("backgroundSubagentCount" in byId.get("t_running")!).toBe(false);
    // 读数不改 runStatus（停止键 / 归档确认等主 run 语义不受影响）
    expect(byId.get("t_bg")?.runStatus).toBe("awaiting_user");
    expect(body.tasks.map((t) => t.id)).toEqual(["t_bg", "t_idle", "t_running"]);
  });

  it("GET /api/tasks：没有 provider 时原样返回（不带读数、不报错）", async () => {
    sub.setBackgroundSubagentSnapshotProvider(null);
    listTasksMock.mockResolvedValue([summary({ id: "t_1" })]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskSummary[] };
    expect(body.tasks).toHaveLength(1);
    expect("backgroundSubagentCount" in body.tasks[0]!).toBe(false);
  });
});

// ---------- C. 接线与 UI 契约 ----------

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("C. 接线与 UI 契约", () => {
  it("侧栏行首指示：主 AI 不在跑但有后台子代理 → 转圈（别画成空闲 / 对话气泡）", () => {
    const src = read("src/components/tasks/task-list-item.tsx");
    const fnStart = src.indexOf("const LeadingIndicator");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, src.indexOf("interface TaskListItemProps"));
    // 在「真有事等你」的琥珀点与兜底图标之前判定
    const bg = fn.indexOf("hasBackgroundSubagents(task)");
    const attention = fn.indexOf("needsAttention");
    const idleIcon = fn.indexOf("MessageCircle");
    expect(bg).toBeGreaterThan(-1);
    expect(bg).toBeLessThan(attention);
    expect(bg).toBeLessThan(idleIcon);
    expect(fn).toContain('aria-label="子代理后台运行中"');
    expect(fn.slice(bg, attention)).toContain("animate-spin");
    // 主 run 的转圈仍在最前、口径不变
    expect(fn.indexOf('task.runStatus === "running"')).toBeLessThan(bg);
  });

  it("会话管理页：running 的「跑着」之外，后台子代理在跑给「后台运行中」徽标", () => {
    const src = read("src/app/sessions/page.tsx");
    expect(src).toContain("hasBackgroundSubagents(t)");
    expect(src).toContain("后台运行中");
    // 归档确认等主 run 语义不被读数改写：仍只认 runStatus
    expect(src).toContain('task.runStatus === "running"');
    expect(src).not.toContain("hasBackgroundSubagents(task)");
  });

  it("列表轮询：有后台读数期间保持轮询（否则转圈出现不了、也收不掉）", () => {
    const src = read("src/hooks/use-task-list.tsx");
    expect(src).toContain("tasks.some(isTaskBusy)");
    expect(src).not.toContain('tasks.some((t) => t.runStatus === "running")');
  });

  it("详情页回灌（upsertTask）不抹掉读数：覆盖旧行时走 keepBackgroundSubagentCount", () => {
    const src = read("src/hooks/use-task-list.tsx");
    expect(src).toContain("keepBackgroundSubagentCount(prev[idx], summary)");
  });

  it("读数只在列表接口里补，且走与 watch-task 同源的 provider（不另起一份真值）", () => {
    const route = read("src/app/api/tasks/route.ts");
    // 路由改调 listTasksWithCorrupt（tasks + 损坏任务）：读数仍只补在 listed.tasks 上
    expect(route).toContain("withBackgroundSubagentCounts(listed.tasks)");
    expect(route).toContain("getBackgroundSubagentCount(t.id)");
    const leaf = read("src/lib/server/subagent-background.ts");
    const fn = leaf.slice(leaf.indexOf("export const getBackgroundSubagentCount"));
    expect(fn).toContain("__flowshipSubagentSnapshotProvider");
  });

  it("读数不落盘：不进 TaskMeta / 不写 meta.json", () => {
    const core = read("src/lib/server/task-fs-core.ts");
    expect(core).not.toContain("backgroundSubagentCount");
  });
});
