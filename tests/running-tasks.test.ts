/**
 * 自更新前「有任务在运行」提示（src/lib/running-tasks.ts + update-badge 接线）。
 *
 * 覆盖：运行中判定口径（awaiting_user 不算）/ 汇总最多 3 个标题 / 文案按 mode 给出真实存在的继续入口 /
 * 无运行任务时文案与改动前一致 / 现拉最新列表失败·超时退回缓存（只提示、不阻止）/ 取消不更新的接线。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RUNNING_TASKS_PREVIEW_LIMIT,
  UPDATE_CHECK_FETCH_TIMEOUT_MS,
  buildUpdateConfirmCopy,
  isRunningForUpdate,
  resolveTasksForUpdateCheck,
  summarizeRunningTasks,
  type RunningTaskView,
} from "@/lib/running-tasks";

const t = (over: Partial<RunningTaskView> = {}): RunningTaskView => ({
  id: "t1",
  title: "登录页改版",
  mode: "task",
  runStatus: "running",
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isRunningForUpdate：只认 runStatus=running", () => {
  it("running → true（task / chat 一视同仁）", () => {
    expect(isRunningForUpdate(t())).toBe(true);
    expect(isRunningForUpdate(t({ mode: "chat" }))).toBe(true);
  });

  it("awaiting_user / idle / error → false（没有 agent 在干活，重启不丢进度）", () => {
    for (const runStatus of ["awaiting_user", "idle", "error"] as const) {
      expect(isRunningForUpdate(t({ runStatus }))).toBe(false);
    }
  });
});

describe("summarizeRunningTasks", () => {
  it("null / undefined / 空列表 → 0 个", () => {
    for (const input of [null, undefined, []]) {
      expect(summarizeRunningTasks(input)).toEqual({
        count: 0,
        titles: [],
        hiddenCount: 0,
        hasTask: false,
        hasChat: false,
      });
    }
  });

  it("只数 running 的，awaiting_user 不算", () => {
    const s = summarizeRunningTasks([
      t({ id: "a", title: "A" }),
      t({ id: "b", title: "B", runStatus: "awaiting_user" }),
      t({ id: "c", title: "C", runStatus: "idle" }),
    ]);
    expect(s.count).toBe(1);
    expect(s.titles).toEqual(["A"]);
  });

  it("最多列 3 个标题，其余算 hiddenCount", () => {
    expect(RUNNING_TASKS_PREVIEW_LIMIT).toBe(3);
    const s = summarizeRunningTasks(
      ["1", "2", "3", "4", "5"].map((n) => t({ id: n, title: `任务${n}` })),
    );
    expect(s.count).toBe(5);
    expect(s.titles).toEqual(["任务1", "任务2", "任务3"]);
    expect(s.hiddenCount).toBe(2);
  });

  it("空标题兜底、超长标题按码点截断加省略号", () => {
    const s = summarizeRunningTasks([
      t({ id: "a", title: "   " }),
      t({ id: "b", title: "长".repeat(50) }),
    ]);
    expect(s.titles[0]).toBe("未命名任务");
    expect(s.titles[1]).toBe(`${"长".repeat(30)}…`);
  });

  it("统计 task / chat 构成；mode 缺省（老数据）按 task", () => {
    const old = { id: "o", title: "老", runStatus: "running" } as RunningTaskView;
    expect(summarizeRunningTasks([old])).toMatchObject({ hasTask: true, hasChat: false });
    expect(summarizeRunningTasks([t({ mode: "chat" })])).toMatchObject({ hasTask: false, hasChat: true });
    expect(summarizeRunningTasks([t(), t({ id: "c", mode: "chat" })])).toMatchObject({
      hasTask: true,
      hasChat: true,
    });
  });
});

describe("buildUpdateConfirmCopy", () => {
  const none = summarizeRunningTasks([]);

  it("没有运行中任务：文案与改动前完全一致、不加红", () => {
    expect(buildUpdateConfirmCopy({ phase: "ready", version: "1.2.3", running: none })).toEqual({
      title: "更新到 v1.2.3？",
      description: "新版本已下载完成、点击后将自动重启完成更新、数据不丢。",
      confirmLabel: "重启更新",
      destructive: false,
    });
    expect(buildUpdateConfirmCopy({ phase: "available", version: "1.2.3", running: none })).toEqual({
      title: "更新到 v1.2.3？",
      description: "将下载并安装更新、完成后自动重启、数据不丢。",
      confirmLabel: "立即更新",
      destructive: false,
    });
  });

  it("有运行中 task：写明数量、会中断、任务页「继续上次 Action」，列标题，以「仍要更新吗？」收尾，确认键加红", () => {
    const c = buildUpdateConfirmCopy({
      phase: "ready",
      version: "1.2.3",
      running: summarizeRunningTasks([t({ title: "登录页改版" }), t({ id: "b", title: "支付重构" })]),
    });
    expect(c.description).toContain("新版本已下载完成");
    expect(c.description).toContain(
      "当前有 2 个任务正在运行，更新重启会中断它们（中断后任务页可以点「继续上次 Action」）。",
    );
    expect(c.description).toContain("· 登录页改版");
    expect(c.description).toContain("· 支付重构");
    expect(c.description.endsWith("仍要更新吗？")).toBe(true);
    expect(c.destructive).toBe(true);
  });

  it("超过 3 个：只列 3 个 + 「另有 K 个」，总数仍写真实值", () => {
    const c = buildUpdateConfirmCopy({
      phase: "available",
      version: "2.0.0",
      running: summarizeRunningTasks(
        ["1", "2", "3", "4", "5"].map((n) => t({ id: n, title: `任务${n}` })),
      ),
    });
    expect(c.description).toContain("当前有 5 个任务正在运行");
    expect(c.description).toContain("· 任务3");
    expect(c.description).not.toContain("· 任务4");
    expect(c.description).toContain("· …另有 2 个");
  });

  it("只有 chat 在跑：不承诺「继续上次 Action」（chat 没有这个入口），改说继续发消息", () => {
    const c = buildUpdateConfirmCopy({
      phase: "ready",
      version: "1.0.0",
      running: summarizeRunningTasks([t({ mode: "chat", title: "随便聊聊" })]),
    });
    expect(c.description).not.toContain("继续上次 Action");
    expect(c.description).toContain("中断后可在对话里继续发消息");
  });

  it("task + chat 混合：两种入口分别写清", () => {
    const c = buildUpdateConfirmCopy({
      phase: "ready",
      version: "1.0.0",
      running: summarizeRunningTasks([t(), t({ id: "c", mode: "chat" })]),
    });
    expect(c.description).toContain("任务中断后可在任务页点「继续上次 Action」");
    expect(c.description).toContain("对话可继续发消息");
  });
});

describe("resolveTasksForUpdateCheck：只提示、不阻止——任何失败都退回缓存", () => {
  const cached = [t({ id: "cached", title: "缓存里的" })];
  const latest = [t({ id: "latest", title: "最新的" })];

  it("现拉成功 → 用最新列表", async () => {
    const r = await resolveTasksForUpdateCheck({
      fetchLatest: async () => latest,
      fallback: cached,
    });
    expect(r).toBe(latest);
  });

  it("现拉抛错 → 退回缓存（含同步抛错）", async () => {
    expect(
      await resolveTasksForUpdateCheck({
        fetchLatest: async () => {
          throw new Error("HTTP 500");
        },
        fallback: cached,
      }),
    ).toBe(cached);
    expect(
      await resolveTasksForUpdateCheck({
        fetchLatest: () => {
          throw new Error("sync boom");
        },
        fallback: cached,
      }),
    ).toBe(cached);
  });

  it("现拉超时（请求挂起）→ 到点退回缓存，不会卡住更新", async () => {
    vi.useFakeTimers();
    const p = resolveTasksForUpdateCheck({
      fetchLatest: () => new Promise<never>(() => {}),
      fallback: cached,
    });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_FETCH_TIMEOUT_MS + 1);
    expect(await p).toBe(cached);
  });

  it("成功后不留悬挂定时器", async () => {
    vi.useFakeTimers();
    await resolveTasksForUpdateCheck({ fetchLatest: async () => latest, fallback: cached });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("update-badge 接线", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "components", "update-badge.tsx"),
    "utf-8",
  );
  const install = src.match(/const install = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";

  it("install：先现拉列表 → 带运行中任务的 confirm → 只有确认才真正 install（取消 = 不更新）", () => {
    expect(install).not.toBe("");
    expect(install).toContain("resolveTasksForUpdateCheck(");
    expect(install).toContain("buildUpdateConfirmCopy(");
    expect(install).toMatch(/defaultFocus:\s*"cancel"/);
    // install 调用只有一处、且受 `if (ok)` 守着、在 confirm 之后
    expect(install.match(/__appUpdater\?\.install\(\)/g)?.length).toBe(1);
    expect(install).toMatch(/if \(ok\) window\.__appUpdater\?\.install\(\)/);
    expect(install.indexOf("confirm(")).toBeLessThan(install.indexOf("__appUpdater?.install()"));
  });

  it("防重入 ref 与新增 hook 都在提前 return 之前（hook 个数不随状态变）", () => {
    const earlyReturn = src.indexOf("if (!state || state.phase");
    expect(src.indexOf("useTaskList()")).toBeLessThan(earlyReturn);
    expect(src.indexOf("confirmingRef = useRef")).toBeLessThan(earlyReturn);
  });

  it("不用原生弹窗", () => {
    expect(src).not.toMatch(/window\.(alert|confirm|prompt)/);
  });
});
