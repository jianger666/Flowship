/**
 * 「子代理在后台工作」条：整条信号链
 *
 * 背景（2026-10-17 用户反馈）：主 AI 把活派给后台子代理后，主 AI 这一轮会正常说完，聊天框就呈现「已结束」，
 * 可子代理其实还在干活，用户完全不知道。修法是服务端把「此刻还在后台跑的子代理」整份快照推给界面，
 * 界面在输入框上方画一条常驻提示。各段各自钉在下面（chat-runner 的真实会话链在 chat-background-subagents.test.ts）：
 *   A. 纯函数：帧解析（不可信输入）/ 快照比较 / 文案 / 计时
 *   B. link：control.backgroundJobs() 清单 + onJobsChanged 通知时机
 *   C. 叶子模块：清单变化 hub、bootstrap 读取用的 provider
 *   D. 客户端 SSE 分发：background_subagents → onBackgroundSubagents
 *   E. 接线与 UI 契约（源码契约，UI 组件在 node 环境跑不起来，手法同 restricted-run-signal.test.ts）
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_SUBAGENT_FALLBACK_DESCRIPTION,
  BACKGROUND_SUBAGENT_VIEW_MAX,
  backgroundSubagentJobsEqual,
  formatBackgroundElapsed,
  oldestBackgroundStartedAt,
  parseBackgroundSubagentJobs,
  summarizeBackgroundSubagents,
  type BackgroundSubagentJobView,
} from "@/lib/background-subagents";
import {
  __resetSubagentResumablesForTests,
  createCursorSubagentLink,
  type CursorSubagentDeps,
  type SubagentChildRun,
} from "@/lib/server/cursor-subagent";
import {
  __clearBackgroundSubagentListenersForTests,
  emitBackgroundSubagentJobsChanged,
  getBackgroundSubagentSnapshot,
  onBackgroundSubagentJobsChanged,
  setBackgroundSubagentSnapshotProvider,
  type BackgroundSubagentEvent,
} from "@/lib/server/subagent-background";
import { watchTaskStream } from "@/lib/task-store";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

const job = (
  over: Partial<BackgroundSubagentJobView> & { id: string },
): BackgroundSubagentJobView => ({
  description: "查资料",
  startedAt: 1_000,
  detached: false,
  ...over,
});

// ============================================================ A. 纯函数

describe("parseBackgroundSubagentJobs：SSE 帧按不可信输入校验", () => {
  it("不是数组 → undefined（无效帧：调用方丢弃，别拿脏数据把条抹掉）", () => {
    expect(parseBackgroundSubagentJobs(undefined)).toBeUndefined();
    expect(parseBackgroundSubagentJobs(null)).toBeUndefined();
    expect(parseBackgroundSubagentJobs("jobs")).toBeUndefined();
    expect(parseBackgroundSubagentJobs({ id: "bg_1" })).toBeUndefined();
  });

  it("空数组是合法的「没有」", () => {
    expect(parseBackgroundSubagentJobs([])).toEqual([]);
  });

  it("id 缺失 / 空串、startedAt 非有限数的条目丢掉，其余保留", () => {
    const parsed = parseBackgroundSubagentJobs([
      { id: "bg_ok", description: "A", startedAt: 5 },
      { description: "没 id", startedAt: 1 },
      { id: "", description: "空 id", startedAt: 1 },
      { id: "bg_nan", description: "NaN", startedAt: Number.NaN },
      { id: "bg_inf", description: "Inf", startedAt: Number.POSITIVE_INFINITY },
      { id: "bg_str", description: "字符串时间", startedAt: "123" },
      { id: 7, description: "数字 id", startedAt: 1 },
      null,
      "garbage",
      42,
    ]);
    expect(parsed?.map((j) => j.id)).toEqual(["bg_ok"]);
  });

  it("摘要去首尾空白；缺失 / 全空白 / 非字符串 → 兜底「子任务」", () => {
    const parsed = parseBackgroundSubagentJobs([
      { id: "a", description: "  查资料  ", startedAt: 1 },
      { id: "b", startedAt: 2 },
      { id: "c", description: "   ", startedAt: 3 },
      { id: "d", description: 9, startedAt: 4 },
    ]);
    expect(parsed?.map((j) => j.description)).toEqual([
      "查资料",
      BACKGROUND_SUBAGENT_FALLBACK_DESCRIPTION,
      BACKGROUND_SUBAGENT_FALLBACK_DESCRIPTION,
      BACKGROUND_SUBAGENT_FALLBACK_DESCRIPTION,
    ]);
  });

  it("detached 只认严格的 true（字符串 \"true\" / 1 都当 false）", () => {
    const parsed = parseBackgroundSubagentJobs([
      { id: "a", startedAt: 1, detached: true },
      { id: "b", startedAt: 2, detached: "true" },
      { id: "c", startedAt: 3, detached: 1 },
      { id: "d", startedAt: 4 },
    ]);
    expect(parsed?.map((j) => j.detached)).toEqual([true, false, false, false]);
  });

  it("runKey（子代理详情的过程记录 key）：只认非空字符串，其余当没有", () => {
    const parsed = parseBackgroundSubagentJobs([
      { id: "a", startedAt: 1, runKey: "sa_abc123" },
      { id: "b", startedAt: 2, runKey: "" },
      { id: "c", startedAt: 3, runKey: 42 },
      { id: "d", startedAt: 4 },
    ]);
    expect(parsed?.map((j) => j.runKey)).toEqual(["sa_abc123", undefined, undefined, undefined]);
    // 没有就是真没有这个键（不是 runKey: undefined）：条据此判断「点不开」
    expect("runKey" in parsed![1]!).toBe(false);
  });

  it("同 id 去重（后者覆盖前者）；按开始时间升序、同刻按 id——顺序稳定列表不跳", () => {
    const parsed = parseBackgroundSubagentJobs([
      { id: "z", description: "晚", startedAt: 30 },
      { id: "b", description: "同刻 b", startedAt: 10 },
      { id: "a", description: "同刻 a", startedAt: 10 },
      { id: "z", description: "晚（更新）", startedAt: 30 },
    ]);
    expect(parsed?.map((j) => j.id)).toEqual(["a", "b", "z"]);
    expect(parsed?.find((j) => j.id === "z")?.description).toBe("晚（更新）");
  });

  it("条数封顶：一帧脏数据撑不爆界面", () => {
    const many = Array.from({ length: BACKGROUND_SUBAGENT_VIEW_MAX + 30 }, (_, i) => ({
      id: `bg_${String(i).padStart(3, "0")}`,
      startedAt: i,
    }));
    expect(parseBackgroundSubagentJobs(many)).toHaveLength(
      BACKGROUND_SUBAGENT_VIEW_MAX,
    );
  });
});

describe("backgroundSubagentJobsEqual：相同就别重渲染整个聊天视图", () => {
  it("同引用 / 同内容 → 相等；空对空相等", () => {
    const a = [job({ id: "x" })];
    expect(backgroundSubagentJobsEqual(a, a)).toBe(true);
    expect(backgroundSubagentJobsEqual(a, [job({ id: "x" })])).toBe(true);
    expect(backgroundSubagentJobsEqual([], [])).toBe(true);
  });

  it("任一字段（id / 摘要 / 开始时间 / 来源）或长度不同 → 不等", () => {
    const base = [job({ id: "x" })];
    expect(backgroundSubagentJobsEqual(base, [job({ id: "y" })])).toBe(false);
    expect(
      backgroundSubagentJobsEqual(base, [job({ id: "x", description: "别的" })]),
    ).toBe(false);
    expect(
      backgroundSubagentJobsEqual(base, [job({ id: "x", startedAt: 2_000 })]),
    ).toBe(false);
    expect(
      backgroundSubagentJobsEqual(base, [job({ id: "x", detached: true })]),
    ).toBe(false);
    // runKey 变了（记录建好 / 换了一份）也要重画：条据此决定可不可点、点开哪一份
    expect(
      backgroundSubagentJobsEqual(base, [job({ id: "x", runKey: "sa_1" })]),
    ).toBe(false);
    expect(backgroundSubagentJobsEqual(base, [])).toBe(false);
    expect(
      backgroundSubagentJobsEqual(base, [job({ id: "x" }), job({ id: "y" })]),
    ).toBe(false);
  });
});

describe("summarizeBackgroundSubagents：条上的文案", () => {
  it("空 → null（调用方不画条）", () => {
    expect(summarizeBackgroundSubagents([])).toBeNull();
  });

  it("一个：标题里直接带摘要，不再另列", () => {
    expect(
      summarizeBackgroundSubagents([job({ id: "a", description: "查资料" })]),
    ).toEqual({ title: "子代理「查资料」在后台工作", names: null });
  });

  it("多个：标题说个数，摘要用顿号串在后面", () => {
    expect(
      summarizeBackgroundSubagents([
        job({ id: "a", description: "查资料" }),
        job({ id: "b", description: "跑测试" }),
        job({ id: "c", description: "改文档" }),
      ]),
    ).toEqual({
      title: "3 个子代理在后台工作",
      names: "查资料、跑测试、改文档",
    });
  });
});

describe("计时", () => {
  it("formatBackgroundElapsed：不到 1 秒不显示、秒级、分秒；时钟回拨钳成 0", () => {
    expect(formatBackgroundElapsed(1_000, 1_400)).toBeNull();
    expect(formatBackgroundElapsed(1_000, 13_000)).toBe("12s");
    expect(formatBackgroundElapsed(0, 134_000)).toBe("2m14s");
    expect(formatBackgroundElapsed(50_000, 10_000)).toBeNull();
  });

  it("oldestBackgroundStartedAt：取最早的那个；空 → null", () => {
    expect(oldestBackgroundStartedAt([])).toBeNull();
    expect(
      oldestBackgroundStartedAt([
        job({ id: "a", startedAt: 300 }),
        job({ id: "b", startedAt: 100 }),
        job({ id: "c", startedAt: 200 }),
      ]),
    ).toBe(100);
  });
});

// ============================================================ B. link

interface ManualRun extends SubagentChildRun {
  finish: (result?: string) => void;
  cancelled: () => boolean;
}

const manualRun = (): ManualRun => {
  let resolveWait!: (v: { status: string; result?: string }) => void;
  const waitP = new Promise<{ status: string; result?: string }>((r) => {
    resolveWait = r;
  });
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    cancel: vi.fn(async () => {
      cancelled = true;
      resolveWait({ status: "cancelled" });
    }),
    stream: () => (async function* () {})(),
    wait: () => waitP,
    finish: (result = "子代理的结果") => resolveWait({ status: "finished", result }),
  };
};

const setupLink = (opts?: { onJobsChanged?: () => void }) => {
  const runs: ManualRun[] = [];
  const order: string[] = [];
  const events: BackgroundSubagentEvent[] = [];
  const onJobsChanged = vi.fn(() => {
    order.push("jobs-changed");
    opts?.onJobsChanged?.();
  });
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5" },
    loadCatalog: async () => null,
    createChild: vi.fn(async () => {
      const run = manualRun();
      runs.push(run);
      return { send: vi.fn(async () => run), close: vi.fn() };
    }),
    background: {
      onSettled: (e) => {
        order.push("settled");
        events.push(e);
      },
      onJobsChanged,
    },
  };
  const link = createCursorSubagentLink(deps);
  return { link, runs, order, events, onJobsChanged };
};

const callTool = async (
  link: ReturnType<typeof createCursorSubagentLink>,
  args: Record<string, unknown>,
): Promise<string> => {
  const r = (await link.tool.execute(args as never, {} as never)) as {
    content: Array<{ text: string }>;
  };
  return r.content.map((c) => c.text).join("\n");
};

const settleTail = () => new Promise((r) => setTimeout(r, 15));

describe("link：control.backgroundJobs() 与 onJobsChanged", () => {
  beforeEach(() => {
    __resetSubagentResumablesForTests();
  });

  it("run_in_background：立刻出现在清单里（带 id / 摘要 / 开始时间 / 来源），并通知一次", async () => {
    const { link, onJobsChanged } = setupLink();
    const before = Date.now();
    const text = await callTool(link, {
      prompt: "去查查",
      description: "查资料",
      run_in_background: true,
    });
    const jobId = /后台任务 (bg_[0-9a-f]+)/.exec(text)?.[1];
    expect(jobId).toBeTruthy();

    const jobs = link.control.backgroundJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: jobId,
      description: "查资料",
      detached: false,
    });
    expect(jobs[0]!.startedAt).toBeGreaterThanOrEqual(before);
    expect(jobs[0]!.startedAt).toBeLessThanOrEqual(Date.now());
    expect(onJobsChanged).toHaveBeenCalledTimes(1);
    // 清单与 backgroundRunning 同口径
    expect(link.control.backgroundRunning()).toBe(1);
  });

  it("收尾：先通知「清单变了」、再 onSettled（界面的条先收，再唤醒主 AI）", async () => {
    const { link, runs, order, events } = setupLink();
    await callTool(link, { prompt: "a", description: "任务A", run_in_background: true });
    expect(order).toEqual(["jobs-changed"]);

    runs[0]!.finish("A 的结果");
    await settleTail();

    expect(link.control.backgroundJobs()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(order).toEqual(["jobs-changed", "jobs-changed", "settled"]);
  });

  it("被取消的后台子代理同样从清单里消失并通知（停止 / 关会话不能让条挂着）", async () => {
    const { link, runs, onJobsChanged } = setupLink();
    await callTool(link, { prompt: "a", description: "任务A", run_in_background: true });
    expect(onJobsChanged).toHaveBeenCalledTimes(1);

    await link.cancelAll();
    await settleTail();

    expect(runs[0]!.cancelled()).toBe(true);
    expect(link.control.backgroundJobs()).toEqual([]);
    expect(onJobsChanged).toHaveBeenCalledTimes(2);
  });

  it("前台子代理不算「后台在跑」：不进清单、不通知；用户插话转后台的那一刻才出现，来源标 detached", async () => {
    const { link, runs, onJobsChanged } = setupLink();
    const fg = callTool(link, { prompt: "前台活", description: "前台任务" });
    // 子 run 起来 + 前台 job 登记（detachForeground 要看得到它）都要几个微任务
    await settleTail();
    expect(runs).toHaveLength(1);

    expect(link.control.backgroundJobs()).toEqual([]);
    expect(onJobsChanged).not.toHaveBeenCalled();

    expect(link.control.detachForeground()).toBe(1);
    await fg; // 阻塞的工具调用立刻返回

    const jobs = link.control.backgroundJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ description: "前台任务", detached: true });
    expect(onJobsChanged).toHaveBeenCalledTimes(1);

    runs[0]!.finish("做完了");
    await settleTail();
    expect(link.control.backgroundJobs()).toEqual([]);
    expect(onJobsChanged).toHaveBeenCalledTimes(2);
  });

  it("前台子代理正常做完（从没转后台）：全程不通知", async () => {
    const { link, runs, onJobsChanged } = setupLink();
    const fg = callTool(link, { prompt: "前台活", description: "前台任务" });
    await settleTail();
    expect(runs).toHaveLength(1);
    runs[0]!.finish("结果");
    await fg;
    expect(onJobsChanged).not.toHaveBeenCalled();
    expect(link.control.backgroundJobs()).toEqual([]);
  });

  it("多个后台子代理：清单按开始时间升序，各自收尾各自消失", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { link, runs } = setupLink();
      vi.setSystemTime(10_000);
      await callTool(link, { prompt: "a", description: "先派的", run_in_background: true });
      vi.setSystemTime(20_000);
      await callTool(link, { prompt: "b", description: "后派的", run_in_background: true });

      expect(link.control.backgroundJobs().map((j) => j.description)).toEqual([
        "先派的",
        "后派的",
      ]);

      runs[0]!.finish("A");
      await vi.waitFor(
        () =>
          expect(link.control.backgroundJobs().map((j) => j.description)).toEqual([
            "后派的",
          ]),
        { timeout: 3000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("通知回调抛错：只告警，不挡子代理自己的收尾（onSettled 照常送达）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let armed = false;
      const { link, runs, events } = setupLink({
        onJobsChanged: () => {
          if (armed) throw new Error("订阅方炸了");
        },
      });
      await callTool(link, { prompt: "a", description: "任务A", run_in_background: true });
      armed = true;

      runs[0]!.finish("A 的结果");
      await settleTail();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "done", description: "任务A" });
      expect(link.control.backgroundJobs()).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ============================================================ C. 叶子模块

describe("subagent-background：清单变化 hub 与 bootstrap 用的 provider", () => {
  afterEach(() => {
    __clearBackgroundSubagentListenersForTests();
    setBackgroundSubagentSnapshotProvider(null);
  });

  it("emit 把 taskId 送给所有订阅方；注销后不再收到", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onBackgroundSubagentJobsChanged(a);
    onBackgroundSubagentJobsChanged(b);

    emitBackgroundSubagentJobsChanged("t1");
    expect(a).toHaveBeenCalledWith("t1");
    expect(b).toHaveBeenCalledWith("t1");

    offA();
    emitBackgroundSubagentJobsChanged("t2");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("一个订阅方抛错：只告警，别的订阅方照常收到", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    onBackgroundSubagentJobsChanged(() => {
      throw new Error("boom");
    });
    onBackgroundSubagentJobsChanged(ok);

    emitBackgroundSubagentJobsChanged("t1");
    expect(ok).toHaveBeenCalledWith("t1");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("没登记 provider（本进程没加载过 chat-runner）→ 空清单", () => {
    setBackgroundSubagentSnapshotProvider(null);
    expect(getBackgroundSubagentSnapshot("t1")).toEqual([]);
  });

  it("登记后按 taskId 读；provider 抛错按空处理（bootstrap 不能因为它挂掉）", () => {
    const jobs = [job({ id: "bg_1", description: "A" })];
    setBackgroundSubagentSnapshotProvider((taskId) =>
      taskId === "t1" ? jobs : [],
    );
    expect(getBackgroundSubagentSnapshot("t1")).toBe(jobs);
    expect(getBackgroundSubagentSnapshot("other")).toEqual([]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setBackgroundSubagentSnapshotProvider(() => {
      throw new Error("provider boom");
    });
    expect(getBackgroundSubagentSnapshot("t1")).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ============================================================ D. 客户端 SSE 分发

describe("客户端分发：SSE background_subagents → onBackgroundSubagents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sseResponse = (payloads: unknown[]): Response => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of payloads) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  it("bootstrap 补发的整份与随后的清空都转发；字段经校验、按开始时间排好", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "task", task: { id: "t1", events: [] } },
          {
            type: "background_subagents",
            jobs: [
              { id: "bg_b", description: "后派的", startedAt: 200, detached: true },
              { id: "bg_a", description: "先派的", startedAt: 100, detached: false },
              { id: "", description: "脏数据", startedAt: 1 },
            ],
          },
          { type: "background_subagents", jobs: [] },
        ]),
      ),
    );

    const seen: BackgroundSubagentJobView[][] = [];
    await watchTaskStream("t1", { onBackgroundSubagents: (j) => seen.push(j) });

    expect(seen).toEqual([
      [
        { id: "bg_a", description: "先派的", startedAt: 100, detached: false },
        { id: "bg_b", description: "后派的", startedAt: 200, detached: true },
      ],
      [],
    ]);
  });

  it("无效帧（jobs 缺失 / 不是数组）不回调——别把脏数据当成「没有」把条抹掉", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "background_subagents" },
          { type: "background_subagents", jobs: "oops" },
          { type: "background_subagents", jobs: { id: "bg_1" } },
        ]),
      ),
    );

    const onBackgroundSubagents = vi.fn();
    await watchTaskStream("t1", { onBackgroundSubagents });
    expect(onBackgroundSubagents).not.toHaveBeenCalled();
  });
});

// ============================================================ E. 接线与 UI 契约

/** 取以 start 开头、到下一个 end 之前的源码片段（找不到 start 直接让测试失败，别悄悄测空串） */
const sliceFrom = (source: string, start: string, end: string): string => {
  const at = source.indexOf(start);
  expect(at, `找不到 ${start}`).toBeGreaterThanOrEqual(0);
  const stop = source.indexOf(end, at + start.length);
  return source.slice(at, stop < 0 ? undefined : stop);
};

describe("接线契约：服务端", () => {
  it("watch-task 路由既转发 background_subagents 帧、也在 bootstrap 无条件补当前整份", () => {
    const source = readSrc("app", "api", "tasks", "[id]", "watch-task", "route.ts");
    expect(source).toContain('case "background_subagents"');
    // 路由经叶子模块读清单，不为这点事 import 近 4000 行的 chat-runner
    expect(source).toContain('from "@/lib/server/subagent-background"');
    expect(source).not.toContain("@/lib/server/chat-runner");
    // 不能写成「有才补」：断线期间全部做完的话，客户端会一直挂着旧的非空清单
    expect(source).toContain("jobs: getBackgroundSubagentSnapshot(id),");
  });

  it("chat-runner：订阅「清单变了」现读当前会话推整份；会话登记 provider；关会话补推一帧", () => {
    const source = readSrc("lib", "server", "chat-runner.ts");
    expect(source).toContain("onBackgroundSubagentJobsChanged(");
    expect(source).toContain("setBackgroundSubagentSnapshotProvider(getBackgroundSubagentJobs)");
    // 清单按「当前会话」现读（会话表里没有 = 空），不信事件里带的数据——旧实例的迟到通知会抹掉新实例的子代理
    expect(source).toContain(
      "getSubagentSessionControl(runningChats.get(taskId)?.agent)?.backgroundJobs()",
    );
    // 关会话：agent.close 之后补推一帧（保证条一定收掉）
    const close = sliceFrom(
      source,
      "const hadBackgroundJobs",
      "if (!opts.keepPersisted && agentIdToClear)",
    );
    expect(close.indexOf("rec.agent.close()")).toBeGreaterThan(0);
    expect(close.indexOf("publishBackgroundSubagents(taskId)")).toBeGreaterThan(
      close.indexOf("rec.agent.close()"),
    );
  });

  it("真实 link 工厂把 onJobsChanged 接到 hub（按 backgroundTaskId）", () => {
    const source = readSrc("lib", "server", "cursor-subagent.ts");
    expect(source).toContain(
      "onJobsChanged: () =>\n              emitBackgroundSubagentJobsChanged(backgroundTaskId),",
    );
  });
});

describe("接线契约：客户端", () => {
  it("use-task-watch 转发回调（带 cancelled 门）", () => {
    const source = readSrc("hooks", "use-task-watch.ts");
    const block = sliceFrom(source, "onBackgroundSubagents: (jobs) =>", "onTaskDeleted");
    expect(block).toContain("if (cancelled) return;");
    expect(block).toContain("callbacksRef.current.onBackgroundSubagents?.(jobs)");
  });

  it("ChatView：订阅整份快照、同值不 setState、切任务清空，并传给 EventStream", () => {
    const source = readSrc("components", "tasks", "chat-view.tsx");
    expect(source).toContain("onBackgroundSubagents: (jobs) =>");
    expect(source).toContain("backgroundSubagentJobsEqual(prev, jobs) ? prev : jobs");
    // 切任务：上个任务的后台子代理不能串到新任务
    const reset = sliceFrom(source, "// 切 task：清 streaming 等 UI 态", "return subscribeChatOp");
    expect(reset).toContain("setBackgroundSubagents(NO_BACKGROUND_SUBAGENTS)");
    const tagStart = source.indexOf("<EventStream");
    const tag = source.slice(tagStart, source.indexOf("/>", tagStart));
    expect(tag).toContain("backgroundSubagents={backgroundSubagents}");
    // 与 run 状态无关：条不能被 runActive 门住（主 AI 说完一轮后它才是重点）
    const onDone = sliceFrom(source, "onDone: (t) => {", "// 正文开始流");
    expect(onDone).not.toContain("setBackgroundSubagents");
  });

  it("EventStream：条画在状态行槽位之后、输入岛之前", () => {
    const source = readSrc("components", "tasks", "event-stream.tsx");
    expect(source).toContain("backgroundSubagents?: readonly BackgroundSubagentJobView[]");
    const area = sliceFrom(source, "<ActiveStatusLine", "<ConversationComposer");
    expect(area).toContain("<BackgroundSubagentsBar jobs={backgroundSubagents} />");
    // 状态行槽位（高度过渡）先于条：槽位收起时条自然贴到输入岛上沿
    expect(area.indexOf("ActiveStatusLine")).toBeLessThan(
      area.indexOf("BackgroundSubagentsBar"),
    );
  });
});

describe("UI 契约：BackgroundSubagentsBar 守事件流 v2 / ui-conventions", () => {
  const source = readSrc("components", "tasks", "background-subagents-bar.tsx");
  // 去掉注释再查，免得文件头的说明文字触发 not.toContain
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("出没走 Collapse 高度过渡（不许 display 硬切）", () => {
    expect(code).toContain("<Collapse open={jobs.length > 0}>");
    // 裸的 `hidden` 类（aria-hidden / overflow-hidden 不算）
    expect(code).not.toMatch(/["'`\s]hidden["'`\s]/);
  });

  it("静止、不加新动效：同屏主动效只留状态行 shimmer（也就不必登记 reduced-motion）", () => {
    expect(code).not.toMatch(/animate-(ping|pulse|spin|bounce)/);
    expect(code).not.toContain("status-shimmer");
    expect(code).not.toContain("@keyframes");
  });

  it("颜色只走语义 token、无裸色号；文字不叠透明度；不用原生 title、不用 10px", () => {
    expect(code).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:red|orange|amber|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}/,
    );
    expect(code).toContain("bg-info");
    expect(code).toContain("text-subagent");
    expect(code).not.toMatch(/text-[a-z-]+\/\d+/);
    expect(code).not.toMatch(/\btitle=/);
    expect(code).not.toContain("text-[10px]");
  });

  it("白卡 + 边；多个时点开是 Popover 列表（不画「停止」按钮误导——目前没有单独停后台子代理的入口）", () => {
    expect(code).toContain("bg-card");
    expect(code).toContain("border-border");
    expect(code).toContain("<Popover open={listOpen} onOpenChange={setListOpen}>");
    expect(code).not.toContain("onStop");
    expect(code).not.toMatch(/停止/);
  });

  it("计时只在条挂着时存在：每秒一个 interval、卸载清掉", () => {
    expect(code).toContain("window.setInterval(");
    expect(code).toContain("window.clearInterval(id)");
  });
});
