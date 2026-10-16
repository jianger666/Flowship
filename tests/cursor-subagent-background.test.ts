/**
 * Cursor `subagent` 的后台运行：
 *   - `run_in_background=true`：立刻返回、子代理后台干、收尾经 onSettled 通知；
 *   - 用户插话时前台等待中的调用自动转后台（control.detachForeground）；
 *   - 并发上限（同一步并发发起也要拦住）、最长运行时间、取消联动、resume 占位贯穿后台期。
 *
 * 不碰真实 SDK：子 agent 是注入的假依赖，子 run 的结束由测试手动控制。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSubagentResumablesForTests,
  createCursorSubagentLink,
  CURSOR_SUBAGENT_DESCRIPTION,
  CURSOR_SUBAGENT_INPUT_JSON_SCHEMA,
  type CursorSubagentDeps,
  type SubagentChildRun,
} from "@/lib/server/cursor-subagent";
import {
  BACKGROUND_RESULT_MAX_CHARS,
  formatBackgroundSubagentMessage,
  getSubagentSessionControl,
  type BackgroundSubagentEvent,
} from "@/lib/server/subagent-background";

interface ManualRun extends SubagentChildRun {
  finish: (result?: string) => void;
  fail: (message: string) => void;
  cancelled: () => boolean;
}

/** 手动结束的子 run：finish / fail 由测试触发，cancel 会让 wait 返回 cancelled */
const manualRun = (): ManualRun => {
  let resolveWait!: (v: {
    status: string;
    result?: string;
    error?: { message?: string } | null;
  }) => void;
  const waitP = new Promise<{
    status: string;
    result?: string;
    error?: { message?: string } | null;
  }>((r) => {
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
    finish: (result = "子代理的结果") =>
      resolveWait({ status: "finished", result }),
    fail: (message) =>
      resolveWait({ status: "error", error: { message } }),
  };
};

const setup = (opts?: {
  background?: Partial<NonNullable<CursorSubagentDeps["background"]>> | false;
  withIds?: boolean;
  createError?: string;
  /** 前 N 次起子 agent 抛错（createError 文案），之后正常 */
  failFirst?: number;
}) => {
  const runs: ManualRun[] = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const events: BackgroundSubagentEvent[] = [];
  let seq = 0;
  let createCalls = 0;
  const createChild = vi.fn(async () => {
    createCalls += 1;
    if (
      opts?.createError &&
      (opts.failFirst === undefined || createCalls <= opts.failFirst)
    ) {
      throw new Error(opts.createError);
    }
    seq += 1;
    const run = manualRun();
    runs.push(run);
    const close = vi.fn();
    closes.push(close);
    return {
      ...(opts?.withIds ? { agentId: `child-${seq}` } : {}),
      send: vi.fn(async () => run),
      close,
    };
  });
  const resumeChild = vi.fn(async ({ agentId }: { agentId: string }) => {
    const run = manualRun();
    runs.push(run);
    const close = vi.fn();
    closes.push(close);
    return { agentId, send: vi.fn(async () => run), close };
  });
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5" },
    loadCatalog: async () => null,
    createChild,
    ...(opts?.withIds ? { resumeChild } : {}),
    ...(opts?.background === false
      ? {}
      : {
          background: {
            onSettled: (e) => events.push(e),
            ...(opts?.background ?? {}),
          },
        }),
  };
  const link = createCursorSubagentLink(deps);
  return { link, runs, closes, events, createChild, resumeChild };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const call = async (
  link: ReturnType<typeof createCursorSubagentLink>,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const r = (await link.tool.execute(args as never, {} as never)) as ToolResult;
  return {
    text: r.content.map((c) => c.text).join("\n"),
    isError: r.isError === true,
  };
};

/** 等微任务 / 定时器把收尾跑完 */
const settleTail = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => {
  __resetSubagentResumablesForTests();
});

describe("工具定义：开了后台才有 run_in_background", () => {
  it("开了：schema 多一个 boolean 的 run_in_background，描述写明护栏与自动转后台", () => {
    const { link } = setup();
    const props = (
      link.tool.inputSchema as { properties: Record<string, { type?: string }> }
    ).properties;
    expect(props.run_in_background?.type).toBe("boolean");
    expect(link.tool.description).toContain(CURSOR_SUBAGENT_DESCRIPTION);
    expect(link.tool.description).toContain("run_in_background");
    expect(link.tool.description).toContain("最多 4 个");
    expect(link.tool.description).toContain("30 分钟");
    expect(link.tool.description).toContain("自动转到后台");
  });

  it("没开（task 模式 / 一次性调用）：schema 与描述保持原样，不出现 run_in_background", () => {
    const { link } = setup({ background: false });
    expect(Object.keys(link.tool.inputSchema!.properties as object)).not.toContain(
      "run_in_background",
    );
    expect(link.tool.description).toBe(CURSOR_SUBAGENT_DESCRIPTION);
    expect(Object.keys(CURSOR_SUBAGENT_INPUT_JSON_SCHEMA.properties)).not.toContain(
      "run_in_background",
    );
  });

  it("护栏数字按 link 实际配置写进描述", () => {
    const { link } = setup({
      background: { maxConcurrent: 2, maxRuntimeMs: 5 * 60 * 1000 },
    });
    expect(link.tool.description).toContain("最多 2 个");
    expect(link.tool.description).toContain("5 分钟");
  });
});

describe("run_in_background=true", () => {
  it("立刻返回（子 run 还在跑），文本给出后台任务 id；收尾时 onSettled 带结果", async () => {
    const { link, runs, events, closes } = setup({ withIds: true });
    const out = await call(link, {
      prompt: "去查查",
      description: "查资料",
      run_in_background: true,
    });

    expect(out.isError).toBe(false);
    const jobId = /后台任务 (bg_[0-9a-f]+)/.exec(out.text)?.[1];
    expect(jobId).toBeTruthy();
    expect(out.text).toContain("查资料");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cancelled()).toBe(false);
    expect(link.control.backgroundRunning()).toBe(1);
    expect(events).toHaveLength(0);

    runs[0]!.finish("查到了：X");
    await settleTail();

    expect(link.control.backgroundRunning()).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      jobId,
      description: "查资料",
      status: "done",
      detached: false,
    });
    expect(events[0]!.text).toContain("查到了：X");
    // 带上子代理 id 尾巴，之后还能 resume 追问
    expect(events[0]!.text).toContain('resume="child-1"');
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(closes[0]).toHaveBeenCalled();
  });

  it("也接受 runInBackground / 字符串 \"true\" 的写法", async () => {
    const { link, runs } = setup();
    await call(link, { prompt: "a", runInBackground: true });
    await call(link, { prompt: "b", run_in_background: "true" });
    expect(runs).toHaveLength(2);
    expect(link.control.backgroundRunning()).toBe(2);
  });

  it("run_in_background=false 就是普通前台：等结果、不发后台事件", async () => {
    const { link, runs, events } = setup();
    const p = call(link, { prompt: "前台", run_in_background: false });
    await settleTail();
    runs[0]!.finish("前台结果");
    const out = await p;
    expect(out).toEqual({ text: "前台结果", isError: false });
    await settleTail();
    expect(events).toHaveLength(0);
    expect(link.control.backgroundRunning()).toBe(0);
  });

  it("子代理失败 → failed 事件带原因；不登记成可 resume", async () => {
    const { link, runs, events } = setup({ withIds: true });
    await call(link, { prompt: "x", run_in_background: true });
    runs[0]!.fail("boom");
    await settleTail();

    expect(events[0]).toMatchObject({ status: "failed" });
    expect(events[0]!.text).toContain("boom");
    expect(link.control.backgroundRunning()).toBe(0);
  });

  it("没开后台的会话传了 run_in_background → 明确报错、不起子代理（别让模型以为已放后台）", async () => {
    const { link, createChild } = setup({ background: false });
    const out = await call(link, { prompt: "x", run_in_background: true });

    expect(out.isError).toBe(true);
    expect(out.text).toContain("不支持 run_in_background");
    expect(createChild).not.toHaveBeenCalled();
  });

  it("起子 agent 就失败：同步报给模型，且并发占位归还（失败多少次都不占名额）", async () => {
    const { link, runs } = setup({
      createError: "no quota",
      failFirst: 5,
      background: { maxConcurrent: 2 },
    });
    for (let i = 0; i < 5; i += 1) {
      const out = await call(link, { prompt: `f${i}`, run_in_background: true });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("no quota");
    }
    // 5 次失败之后：名额一个没少，正好能放满 2 个，第 3 个才因上限被拒
    expect((await call(link, { prompt: "ok1", run_in_background: true })).isError).toBe(
      false,
    );
    expect((await call(link, { prompt: "ok2", run_in_background: true })).isError).toBe(
      false,
    );
    const third = await call(link, { prompt: "ok3", run_in_background: true });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("上限 2");
    expect(runs).toHaveLength(2);
  });
});

describe("并发上限", () => {
  it("达到上限后再放后台 → 报错并说明可改前台；有一个收尾就又能放", async () => {
    const { link, runs } = setup({ background: { maxConcurrent: 2 } });
    expect((await call(link, { prompt: "1", run_in_background: true })).isError).toBe(
      false,
    );
    expect((await call(link, { prompt: "2", run_in_background: true })).isError).toBe(
      false,
    );
    const third = await call(link, { prompt: "3", run_in_background: true });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("上限 2");
    expect(third.text).toContain("前台");

    runs[0]!.finish();
    await settleTail();
    expect((await call(link, { prompt: "4", run_in_background: true })).isError).toBe(
      false,
    );
  });

  it("同一步并发发起一串（建子 agent 要 await）也拦得住：占位与检查同步", async () => {
    const { link, runs } = setup({ background: { maxConcurrent: 3 } });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call(link, { prompt: `p${i}`, run_in_background: true }),
      ),
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(3);
    expect(results.filter((r) => r.isError && r.text.includes("上限 3"))).toHaveLength(5);
    expect(runs).toHaveLength(3);
  });

  it("前台调用不占后台名额", async () => {
    const { link } = setup({ background: { maxConcurrent: 1 } });
    void call(link, { prompt: "前台等着" });
    await settleTail();
    const bgOut = await call(link, { prompt: "后台", run_in_background: true });
    expect(bgOut.isError).toBe(false);
  });
});

describe("最长运行时间", () => {
  it("超时 → 取消子 run、按失败收尾并说明超时", async () => {
    const { link, runs, events } = setup({ background: { maxRuntimeMs: 30 } });
    await call(link, { prompt: "跑不完", run_in_background: true });

    await new Promise((r) => setTimeout(r, 80));

    expect(runs[0]!.cancel).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed" });
    expect(events[0]!.text).toContain("仍未完成");
    expect(link.control.backgroundRunning()).toBe(0);
  });

  it("按时完成 → 计时器被清掉、不会误取消", async () => {
    const { link, runs, events } = setup({ background: { maxRuntimeMs: 40 } });
    await call(link, { prompt: "很快", run_in_background: true });
    runs[0]!.finish("好了");
    await new Promise((r) => setTimeout(r, 90));

    expect(runs[0]!.cancel).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "done" });
  });
});

describe("用户插话：前台等待中的子代理转后台", () => {
  it("detachForeground：阻塞的工具调用立刻返回；子代理继续跑，收尾时作为后台事件发出（detached=true）", async () => {
    const { link, runs, events } = setup({ withIds: true });
    const fg = call(link, { prompt: "前台任务", description: "前台干活" });
    await settleTail();
    expect(runs).toHaveLength(1);
    expect(link.control.backgroundRunning()).toBe(0);

    expect(link.control.detachForeground()).toBe(1);
    const out = await fg; // 不用等子 run 结束就返回了
    expect(out.isError).toBe(false);
    expect(out.text).toContain("已转到后台");
    expect(out.text).toContain("前台干活");
    expect(out.text).toContain("先回应用户");
    expect(runs[0]!.cancelled()).toBe(false);
    expect(link.control.backgroundRunning()).toBe(1);

    runs[0]!.finish("跑完了");
    await settleTail();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "done",
      detached: true,
      description: "前台干活",
    });
    expect(events[0]!.text).toContain("跑完了");
  });

  it("多个前台调用一次全转；已经转过的不重复转", async () => {
    const { link, runs } = setup();
    const a = call(link, { prompt: "a" });
    const b = call(link, { prompt: "b" });
    const c = call(link, { prompt: "c" });
    await settleTail();

    expect(link.control.detachForeground()).toBe(3);
    await Promise.all([a, b, c]);
    expect(link.control.backgroundRunning()).toBe(3);
    expect(link.control.detachForeground()).toBe(0);
    expect(runs).toHaveLength(3);
  });

  it("没有前台在等 → 转 0 个", () => {
    const { link } = setup();
    expect(link.control.detachForeground()).toBe(0);
  });

  it("没被打断的前台调用照旧：等结果、返回结果、不发后台事件", async () => {
    const { link, runs, events } = setup();
    const fg = call(link, { prompt: "前台" });
    await settleTail();
    runs[0]!.finish("正常结果");
    expect(await fg).toEqual({ text: "正常结果", isError: false });
    await settleTail();
    expect(events).toHaveLength(0);
    expect(link.control.detachForeground()).toBe(0);
  });

  it("转后台后同样受最长运行时间约束", async () => {
    const { link, runs, events } = setup({ background: { maxRuntimeMs: 30 } });
    const fg = call(link, { prompt: "前台" });
    await settleTail();
    link.control.detachForeground();
    await fg;

    await new Promise((r) => setTimeout(r, 80));
    expect(runs[0]!.cancel).toHaveBeenCalled();
    expect(events[0]).toMatchObject({ status: "failed", detached: true });
  });

  it("没开后台的会话：前台调用没有 detach 句柄、转 0 个，仍阻塞到结束", async () => {
    const { link, runs } = setup({ background: false });
    let done = false;
    const fg = call(link, { prompt: "前台" }).then((r) => {
      done = true;
      return r;
    });
    await settleTail();

    expect(link.control.detachForeground()).toBe(0);
    await settleTail();
    expect(done).toBe(false);
    runs[0]!.finish("结果");
    expect((await fg).text).toBe("结果");
  });
});

describe("取消联动：停止 / 关会话连后台子代理一起取消", () => {
  it("cancelAll → 后台子 run 被取消，收尾事件是 cancelled（投递方据此丢弃）", async () => {
    const { link, runs, events } = setup();
    await call(link, { prompt: "后台", run_in_background: true });

    await link.cancelAll();
    await settleTail();

    expect(runs[0]!.cancel).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "cancelled", text: "" });
    expect(link.control.backgroundRunning()).toBe(0);
  });

  it("父这一轮自然结束不算取消：没人调 cancelAll，后台照旧在跑", async () => {
    const { link, runs, events } = setup();
    await call(link, { prompt: "后台", run_in_background: true });
    await settleTail();

    expect(runs[0]!.cancel).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(link.control.backgroundRunning()).toBe(1);
  });

  it("之后的新一轮还能照常派子代理（取消代数只对已发出的调用生效）", async () => {
    const { link, runs } = setup();
    await link.cancelAll();
    const out = await call(link, { prompt: "新一轮", run_in_background: true });
    expect(out.isError).toBe(false);
    expect(runs[0]!.cancelled()).toBe(false);
  });
});

describe("收尾回调的健壮性", () => {
  it("onSettled 抛错只告警，不影响后续（job 照常清掉）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { link, runs } = setup({
      background: {
        onSettled: () => {
          throw new Error("listener boom");
        },
      },
    });
    await call(link, { prompt: "x", run_in_background: true });
    runs[0]!.finish();
    await settleTail();

    expect(link.control.backgroundRunning()).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("resume 与后台", () => {
  it("后台期间子代理一直算「在运行」，不能被并发 resume；收尾后可以", async () => {
    const { link, runs } = setup({ withIds: true });
    // 先前台跑完一个，拿到可 resume 的 id
    const first = call(link, { prompt: "第一次" });
    await settleTail();
    runs[0]!.finish("第一次结果");
    const firstOut = await first;
    const childId = /resume="(child-\d+)"/.exec(firstOut.text)?.[1];
    expect(childId).toBeTruthy();

    // 后台 resume 它
    const bgOut = await call(link, {
      prompt: "接着做",
      resume: childId,
      run_in_background: true,
    });
    expect(bgOut.isError).toBe(false);

    const again = await call(link, { prompt: "再来", resume: childId });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("还在运行");

    runs[1]!.finish("第二次结果");
    await settleTail();
    const third = call(link, { prompt: "收尾后再 resume", resume: childId });
    await settleTail();
    runs[2]!.finish("第三次结果");
    expect((await third).isError).toBe(false);
  });
});

describe("resume 在后台占位之后抛错：占位必须归还（N4-01）", () => {
  const LIMIT = 3;

  /** 前台跑完一个带 id 的子代理，返回它的 id（之后能 resume） */
  const prepareResumable = async (s: ReturnType<typeof setup>): Promise<string> => {
    const p = call(s.link, { prompt: "先跑一个" });
    await settleTail();
    s.runs[0]!.finish("第一次结果");
    const id = /resume="(child-\d+)"/.exec((await p).text)?.[1];
    expect(id).toBeTruthy();
    return id!;
  };

  /**
   * claimResumable 的四条抛错分支（占位之后、进 try 之前执行，当年在 try 外面）。
   * occupy = 先让该子代理在后台跑着（才有「在忙」）；这一个真实后台任务会占掉 1 个名额。
   */
  const cases: Array<{
    name: string;
    occupy?: boolean;
    args: (id: string) => Record<string, unknown>;
    expectText: string;
  }> = [
    {
      name: "id 找不到（应用重启后旧子代理不在了）",
      args: () => ({ prompt: "接着做", resume: "ghost-id", run_in_background: true }),
      expectText: "找不到子代理",
    },
    {
      name: "模型对不上（resume 时又填了 model）",
      args: (id) => ({
        prompt: "接着做",
        resume: id,
        model: "claude-sonnet-5-5",
        run_in_background: true,
      }),
      expectText: "不能改",
    },
    {
      name: "effort 对不上（resume 时又填了 effort）",
      args: (id) => ({
        prompt: "接着做",
        resume: id,
        effort: "high",
        run_in_background: true,
      }),
      expectText: "不能改",
    },
    {
      name: "subagentType 对不上（原来可读写、这次填 explore）",
      args: (id) => ({
        prompt: "接着做",
        resume: id,
        subagentType: "explore",
        run_in_background: true,
      }),
      expectText: "subagentType 沿用原来的",
    },
    {
      name: "子代理在忙（上一次 resume 还在后台跑）",
      occupy: true,
      args: (id) => ({ prompt: "再来", resume: id, run_in_background: true }),
      expectText: "还在运行",
    },
  ];

  it.each(cases)(
    "$name：连续失败超过上限次数后，名额一个没少、仍能派满再被上限拦住",
    async (c) => {
      const s = setup({ withIds: true, background: { maxConcurrent: LIMIT } });
      const id = await prepareResumable(s);
      let capacity = LIMIT;
      if (c.occupy) {
        const occupied = await call(s.link, {
          prompt: "占着",
          resume: id,
          run_in_background: true,
        });
        expect(occupied.isError).toBe(false);
        capacity -= 1;
      }

      // 失败次数远超上限：泄漏的话 LIMIT 次就把名额占光了
      for (let i = 0; i < LIMIT + 3; i += 1) {
        const out = await call(s.link, c.args(id));
        expect(out.isError).toBe(true);
        expect(out.text).toContain(c.expectText);
      }

      for (let i = 0; i < capacity; i += 1) {
        const ok = await call(s.link, { prompt: `新任务${i}`, run_in_background: true });
        expect(ok.text).not.toContain("上限");
        expect(ok.isError).toBe(false);
      }
      expect(s.link.control.backgroundRunning()).toBe(LIMIT);
      const over = await call(s.link, { prompt: "超了", run_in_background: true });
      expect(over.isError).toBe(true);
      expect(over.text).toContain(`上限 ${LIMIT}`);
    },
  );

  it("五种抛错各来一遍、反复几轮（混在一起）之后仍能派满", async () => {
    const s = setup({ withIds: true, background: { maxConcurrent: LIMIT } });
    const id = await prepareResumable(s);
    const occupied = await call(s.link, {
      prompt: "占着",
      resume: id,
      run_in_background: true,
    });
    expect(occupied.isError).toBe(false);

    for (let round = 0; round < 3; round += 1) {
      for (const c of cases) {
        expect((await call(s.link, c.args(id))).isError).toBe(true);
      }
    }
    // 1 个真实后台任务在跑，剩 2 个名额
    expect((await call(s.link, { prompt: "a", run_in_background: true })).isError).toBe(false);
    expect((await call(s.link, { prompt: "b", run_in_background: true })).isError).toBe(false);
    expect((await call(s.link, { prompt: "c", run_in_background: true })).isError).toBe(true);
  });

  it("抛错的 resume 没把子代理标成在忙：改对参数后能正常接着做", async () => {
    const s = setup({ withIds: true });
    const id = await prepareResumable(s);
    for (let i = 0; i < 3; i += 1) {
      const bad = await call(s.link, {
        prompt: "接着",
        resume: id,
        model: "claude-sonnet-5-5",
        run_in_background: true,
      });
      expect(bad.isError).toBe(true);
    }
    const good = await call(s.link, { prompt: "接着", resume: id, run_in_background: true });
    expect(good.isError).toBe(false);
    expect(s.link.control.backgroundRunning()).toBe(1);
  });

  it("SDK 接不上（会话记录被清）也不泄漏：之后同一个 id 再 resume 就是「找不到」，同样不占名额", async () => {
    const s = setup({ withIds: true, background: { maxConcurrent: 2 } });
    const id = await prepareResumable(s);
    s.resumeChild.mockRejectedValueOnce(new Error("session gone"));
    for (let i = 0; i < 5; i += 1) {
      const out = await call(s.link, {
        prompt: "接着",
        resume: id,
        run_in_background: true,
      });
      expect(out.isError).toBe(true);
    }
    expect((await call(s.link, { prompt: "a", run_in_background: true })).isError).toBe(false);
    expect((await call(s.link, { prompt: "b", run_in_background: true })).isError).toBe(false);
  });
});

describe("后台结果超长：可 resume 的 agentId 随结果一起送回（N4-03，真实 link → 真实格式化）", () => {
  it.each([
    ["刚好在上限边界", BACKGROUND_RESULT_MAX_CHARS],
    ["略超上限", BACKGROUND_RESULT_MAX_CHARS + 50],
    ["远超上限", BACKGROUND_RESULT_MAX_CHARS * 4],
  ])("%s：送回主 AI 的消息仍带 agentId 与 resume 用法，输出段不超过上限", async (_n, len) => {
    const { link, runs, events } = setup({ withIds: true });
    await call(link, { prompt: "写长报告", run_in_background: true });
    runs[0]!.finish("长".repeat(len));
    await settleTail();

    expect(events).toHaveLength(1);
    const msg = formatBackgroundSubagentMessage(events[0]!);
    const output = msg.split("<subagent_output>\n")[1]!.split("\n</subagent_output>")[0]!;
    expect(output).toContain('resume="child-1"');
    expect(output.length).toBeLessThanOrEqual(BACKGROUND_RESULT_MAX_CHARS);
  });
});

describe("会话控制面登记在 attach 返回的 agent 上", () => {
  it("getSubagentSessionControl 取得到；转后台 / 计数与 link.control 同一个", () => {
    const { link } = setup();
    const agent = link.attach({ agentId: "parent-1", send: vi.fn() });
    expect(getSubagentSessionControl(agent)).toBe(link.control);
  });

  it("收尾事件带上父 agent 的 id（投递时核对是不是同一个会话）", async () => {
    const { link, runs, events } = setup();
    link.attach({ agentId: "parent-xyz", send: vi.fn() });
    await call(link, { prompt: "x", run_in_background: true });
    runs[0]!.finish();
    await settleTail();
    expect(events[0]!.parentAgentId).toBe("parent-xyz");
  });
});
