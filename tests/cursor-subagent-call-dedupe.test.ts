/**
 * R14 S3 · `subagent` 工具对「同一次工具调用被重复派发」幂等。
 *
 * 背景（用户反馈 + 本机日志核过）：SDK 会在**同一个运行里**把还没全部返回的工具调用整批重新派发，
 * 回调被同一个 toolCallId 再执行一遍。旧行为是每次都起一个完整的子代理：并行的几个子代理在同一时刻被各重跑一遍、
 * 甚至在它已经返回之后才重派（间隔从几十秒到近一小时）；本机日志里同一 toolCallId 的子代理重复起跑不是个例。
 * 每次重复都是白烧的 token，可写的子代理还会把活干两遍；过程记录的 `by-call-<id>` 索引也被第二份覆盖。
 *
 * 新：同一个 link（= 一个父会话）里，「会话 id + toolCallId + 入参摘要」相同的调用——
 *   - 在飞的并入同一次；已成功的原样回放（含「已在后台启动」「已转后台」这类立即返回的回执）；
 *   - 失败 / 取消不缓存（重试要能真的再跑一次）；
 *   - 没有 toolCallId（含空串）不去重；入参序列化不了（循环引用）不去重也不抛；
 *     同 id 但参数不同（call id 是 SDK 的约定、不保证唯一）当新调用；不同会话 / 不同 link 互不影响；
 *   - 有容量上限，淘汰只动已结束的，在飞的不被挤掉。
 *
 * 不碰真实 SDK：子 agent 是注入的假依赖，子 run 的结束由测试手动控制。
 * 改前（基线源码）：合并 / 回放 / 容量类用例红；「失败 / 取消 / 无 id / 参数不同 / 不同会话 / 不同 link」是对照，本来就该过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSubagentResumablesForTests,
  CALL_DEDUPE_MAX_ENTRIES,
  createCursorSubagentLink,
  type CursorSubagentDeps,
  type SubagentChildRun,
  type SubagentTranscriptSink,
} from "@/lib/server/cursor-subagent";
import type { SubagentRunHandle } from "@/lib/server/subagent-transcript";

interface ManualRun extends SubagentChildRun {
  finish: (result?: string) => void;
  fail: (message: string) => void;
}

/** 手动结束的子 run：finish / fail 由测试触发；cancel 让 wait 返回 cancelled */
const manualRun = (): ManualRun => {
  type Res = {
    status: string;
    result?: string;
    error?: { message?: string } | null;
  };
  let resolveWait!: (v: Res) => void;
  const waitP = new Promise<Res>((r) => {
    resolveWait = r;
  });
  return {
    cancel: vi.fn(async () => {
      resolveWait({ status: "cancelled" });
    }),
    stream: () => (async function* () {})(),
    wait: () => waitP,
    finish: (result = "子代理的结果") =>
      resolveWait({ status: "finished", result }),
    fail: (message) => resolveWait({ status: "error", error: { message } }),
  };
};

const fakeSink = () => {
  const handle = {
    key: "sa_fake000001",
    onMessage: vi.fn(),
    setBackground: vi.fn(),
    setAgentId: vi.fn(),
    finish: vi.fn(),
  } satisfies SubagentRunHandle;
  const start = vi.fn((init: unknown) => {
    void init;
    return handle as SubagentRunHandle;
  });
  return { sink: { start } as SubagentTranscriptSink, start };
};

const setup = (
  opts: {
    /** 这些 prompt 的子 run 一直挂着（在飞）；其余的一起来就自动成功结束 */
    hold?: (prompt: string) => boolean;
    /** 所有子 run 都不自动结束（测试手动 finish / fail） */
    manual?: boolean;
    createError?: string;
    transcripts?: SubagentTranscriptSink;
    background?: boolean;
  } = {},
) => {
  const runs: ManualRun[] = [];
  const createChild = vi.fn(async () => {
    if (opts.createError) throw new Error(opts.createError);
    return {
      send: vi.fn(async (prompt: string) => {
        const run = manualRun();
        runs.push(run);
        if (!opts.manual && !opts.hold?.(prompt)) {
          run.finish(`自动结果·${prompt}`);
        }
        return run;
      }),
      close: vi.fn(),
    };
  });
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5" },
    loadCatalog: async () => null,
    createChild,
    ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
    ...(opts.background ? { background: { onSettled: () => {} } } : {}),
  };
  const link = createCursorSubagentLink(deps);
  return { link, runs, createChild };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/** `ctx` 传 null = 真的不给 context（旧版 SDK / 裸调用）；缺省是空对象 */
const call = async (
  link: ReturnType<typeof createCursorSubagentLink>,
  args: Record<string, unknown>,
  ctx: Record<string, unknown> | null = {},
): Promise<{ text: string; isError: boolean }> => {
  const r = (await link.tool.execute(
    args as never,
    (ctx ?? undefined) as never,
  )) as ToolResult;
  return {
    text: r.content.map((c) => c.text).join("\n"),
    isError: r.isError === true,
  };
};

const tick = () => new Promise((r) => setTimeout(r, 15));

/** console.warn 的记录（运维线索：重复派发发生过、被拦了） */
const warn = vi.fn();
beforeEach(() => {
  __resetSubagentResumablesForTests();
  warn.mockClear();
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warn(...a);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ARGS = { prompt: "评审前半段", description: "评审" };

/** 容量上限：行为用例用字面量、不依赖导出常量（改前没有这个导出，靠它红就是「符号缺失」而不是行为）；导出的常量另有一例钉住 */
const CAP = 64;

describe("在飞的重复派发并入同一次", () => {
  it("第一次还在跑时同一次调用又来：不再起子代理、过程记录只起一份，两边拿到同一份结果", async () => {
    const { sink, start } = fakeSink();
    const { link, runs, createChild } = setup({ manual: true, transcripts: sink });
    const first = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(1);

    const replay = call(link, { ...ARGS }, { toolCallId: "toolu_a" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    // 去重包装不能吞掉 context：过程记录仍按 toolCallId 精确绑到事件流里那张卡片
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "toolu_a" }),
    );

    runs[0]!.finish("评审结论");
    const [a, b] = await Promise.all([first, replay]);
    expect(a.text).toContain("评审结论");
    expect(b).toEqual(a);
    expect(createChild).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    // 留一行运维线索：重复派发发生过、被拦了；在飞的那次写明「并入」
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("重复派发"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("并入仍在进行"));
  });

  it("同一个同步段里背靠背派发两次（中间一个 await 都没有）：第二次也并入第一次——登记与第一次派发同步完成，没有「查了还没登」的窗口", async () => {
    const { link, runs, createChild } = setup({ manual: true });
    // 不 await、不 tick：两次 execute 在同一个同步段里连续调用（call 是 async 函数，但 execute 在调用时同步执行）。
    // 其余用例的重复都隔了一个 tick，钉不住「登记必须同步」——登记若推迟到微任务，这里就会起两个子代理
    const first = call(link, ARGS, { toolCallId: "toolu_sync" });
    const second = call(link, { ...ARGS }, { toolCallId: "toolu_sync" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(1);

    runs[0]!.finish("评审结论");
    const [a, b] = await Promise.all([first, second]);
    expect(a.text).toContain("评审结论");
    expect(b).toEqual(a);
    expect(runs).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("并入仍在进行"));
  });

  it("并行的两个不同调用各跑各的，各自的重复各自并入", async () => {
    const { link, runs, createChild } = setup({ manual: true });
    const reviewA = call(link, { prompt: "评审 A" }, { toolCallId: "toolu_review_a" });
    const reviewB = call(link, { prompt: "评审 B" }, { toolCallId: "toolu_review_b" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(2);

    const reviewAAgain = call(
      link,
      { prompt: "评审 A" },
      { toolCallId: "toolu_review_a" },
    );
    const reviewBAgain = call(
      link,
      { prompt: "评审 B" },
      { toolCallId: "toolu_review_b" },
    );
    await tick();
    expect(createChild).toHaveBeenCalledTimes(2);

    runs[0]!.finish("A 的结论");
    runs[1]!.finish("B 的结论");
    const [a1, b1, a2, b2] = await Promise.all([
      reviewA,
      reviewB,
      reviewAAgain,
      reviewBAgain,
    ]);
    expect(a1.text).toContain("A 的结论");
    expect(b1.text).toContain("B 的结论");
    expect(a2).toEqual(a1);
    expect(b2).toEqual(b1);
  });
});

describe("已成功的调用原样回放", () => {
  it("第一次已经返回很久之后（实测重派间隔可到近一小时）同一次调用又来：直接回放，不再起子代理", async () => {
    const { sink, start } = fakeSink();
    const { link, runs, createChild } = setup({ manual: true, transcripts: sink });
    const first = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    runs[0]!.finish("评审结论");
    const a = await first;
    expect(a.text).toContain("评审结论");

    // 先不 await：改前重复派发会再起一个永不结束的子 run，await 会一直挂到超时——先断言起了几个，红得清楚
    const replay = call(link, { ...ARGS }, { toolCallId: "toolu_a" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(await replay).toEqual(a);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("重复派发"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("回放已完成"));
  });

  it("回放的是回执本身：同一份文本，反复重复也一样", async () => {
    const { link, createChild } = setup();
    const a = await call(link, ARGS, { toolCallId: "toolu_a" });
    const b = await call(link, ARGS, { toolCallId: "toolu_a" });
    const c = await call(link, ARGS, { toolCallId: "toolu_a" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(createChild).toHaveBeenCalledTimes(1);
  });

  it("后台启动的回执同样回放：不会再起第二个后台子代理", async () => {
    const { link, runs, createChild } = setup({ manual: true, background: true });
    const bgArgs = { prompt: "后台慢慢干", run_in_background: true };
    const a = await call(link, bgArgs, { toolCallId: "toolu_bg" });
    expect(a.text).toContain("已在后台启动");
    expect(link.control.backgroundRunning()).toBe(1);

    const b = await call(link, { ...bgArgs }, { toolCallId: "toolu_bg" });
    expect(b).toEqual(a);
    expect(createChild).toHaveBeenCalledTimes(1);
    expect(link.control.backgroundRunning()).toBe(1);
    expect(runs).toHaveLength(1);
    await link.cancelAll(); // 收尾：别让后台子 run 的最长运行计时器悬着
  });
});

describe("不该合并的情形", () => {
  it("toolCallId 不同 → 各跑一次", async () => {
    const { link, createChild } = setup();
    await call(link, ARGS, { toolCallId: "toolu_a" });
    await call(link, ARGS, { toolCallId: "toolu_b" });
    expect(createChild).toHaveBeenCalledTimes(2);
  });

  it("同一个 toolCallId 但入参不同（call id 不保证唯一）→ 当新调用，不回放张冠李戴的结果", async () => {
    const { link, createChild } = setup();
    const a = await call(link, { prompt: "评审前半段" }, { toolCallId: "call_0" });
    const b = await call(link, { prompt: "评审后半段" }, { toolCallId: "call_0" });
    expect(createChild).toHaveBeenCalledTimes(2);
    expect(a.text).toContain("评审前半段");
    expect(b.text).toContain("评审后半段");
    expect(b.text).not.toContain("评审前半段");
  });

  it("sessionId 不同（SDK 原生 Task 子会话里碰巧同名的 call id）→ 各跑一次；同一个 sessionId → 合并", async () => {
    const { link, createChild } = setup();
    await call(link, ARGS, { toolCallId: "call_0", sessionId: "sess-1" });
    await call(link, ARGS, { toolCallId: "call_0", sessionId: "sess-2" });
    expect(createChild).toHaveBeenCalledTimes(2);
    await call(link, ARGS, { toolCallId: "call_0", sessionId: "sess-1" });
    expect(createChild).toHaveBeenCalledTimes(2);
  });

  it("没有 toolCallId（旧版 SDK / 裸调用）→ 不去重，行为与以前一致", async () => {
    const { link, createChild } = setup();
    await call(link, ARGS, {});
    await call(link, ARGS, {});
    await call(link, ARGS, null); // 连 context 都没有
    await call(link, ARGS, { toolCallId: "" });
    await call(link, ARGS, { toolCallId: "" }); // 空串也不算 id：连来两次也各跑一次
    expect(createChild).toHaveBeenCalledTimes(5);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("重复派发"));
  });

  it("入参序列化不了（循环引用）→ 不去重、也不抛：照旧各跑一次", async () => {
    const { link, createChild } = setup();
    const circular: Record<string, unknown> = { prompt: "评审前半段" };
    circular.self = circular;
    await call(link, circular, { toolCallId: "toolu_a" });
    await call(link, circular, { toolCallId: "toolu_a" });
    expect(createChild).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("重复派发"));
  });

  it("两个 link（两个父会话）互不影响：缓存是 link 级的", async () => {
    const one = setup();
    const two = setup();
    await call(one.link, ARGS, { toolCallId: "toolu_a" });
    await call(two.link, ARGS, { toolCallId: "toolu_a" });
    expect(one.createChild).toHaveBeenCalledTimes(1);
    expect(two.createChild).toHaveBeenCalledTimes(1);
  });
});

describe("失败 / 取消不缓存：重试要能真的再跑一次", () => {
  it("子 run 失败 → 同一个调用再来会重新起一个；这次成功后才开始回放", async () => {
    const { link, runs, createChild } = setup({ manual: true });
    const first = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    runs[0]!.fail("上游 500");
    const a = await first;
    expect(a.isError).toBe(true);

    const second = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(2);
    runs[1]!.finish("这次好了");
    const b = await second;
    expect(b.isError).toBe(false);
    expect(b.text).toContain("这次好了");

    // 成功之后才开始回放；同样先断言起了几个、再等结果（改前会再起一个永不结束的 run）
    const replay = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(2);
    expect(await replay).toEqual(b);
  });

  it("建子代理就失败（createChild 抛错）→ 同一个调用再来会再试一次", async () => {
    const { link, createChild } = setup({ createError: "起不来" });
    const a = await call(link, ARGS, { toolCallId: "toolu_a" });
    expect(a.isError).toBe(true);
    const b = await call(link, ARGS, { toolCallId: "toolu_a" });
    expect(b.isError).toBe(true);
    expect(createChild).toHaveBeenCalledTimes(2);
  });

  it("被取消（停止键 / 会话关闭）→ 返回取消文本、不缓存，同一个调用再来会重新跑", async () => {
    const { link, runs, createChild } = setup({ manual: true });
    const first = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    await link.cancelAll();
    const a = await first;
    expect(a.text).toBe("子任务已取消");
    expect(a.isError).toBe(false);

    const second = call(link, ARGS, { toolCallId: "toolu_a" });
    await tick();
    expect(createChild).toHaveBeenCalledTimes(2);
    runs[1]!.finish("重跑的结果");
    expect((await second).text).toContain("重跑的结果");
  });

  it("用法错误（prompt 空）→ 照旧返回错误、不起子代理；随后同 id 的正常调用照常跑（对照）", async () => {
    const { link, createChild } = setup();
    const a = await call(link, { prompt: "" }, { toolCallId: "toolu_a" });
    expect(a.isError).toBe(true);
    expect(createChild).not.toHaveBeenCalled();
    const b = await call(link, ARGS, { toolCallId: "toolu_a" });
    expect(b.isError).toBe(false);
    expect(createChild).toHaveBeenCalledTimes(1);
  });
});

describe("容量上限", () => {
  it("导出的上限就是 64（文档 / 运维按这个数理解）", () => {
    expect(CALL_DEDUPE_MAX_ENTRIES).toBe(CAP);
  });

  it("超过上限：最老的已结束条目被淘汰（再来就当新调用），最新的仍能回放", async () => {
    const { link, createChild } = setup();
    const total = CAP + 1;
    for (let i = 0; i < total; i += 1) {
      await call(link, { prompt: `任务${i}` }, { toolCallId: `toolu_${i}` });
    }
    expect(createChild).toHaveBeenCalledTimes(total);

    await call(
      link,
      { prompt: `任务${total - 1}` },
      { toolCallId: `toolu_${total - 1}` },
    );
    expect(createChild).toHaveBeenCalledTimes(total); // 最新的：回放

    await call(link, { prompt: "任务1" }, { toolCallId: "toolu_1" });
    expect(createChild).toHaveBeenCalledTimes(total); // 第二老的：只淘汰超出的那一条，它还在

    await call(link, { prompt: "任务0" }, { toolCallId: "toolu_0" });
    expect(createChild).toHaveBeenCalledTimes(total + 1); // 最老的：已淘汰、重新跑
  });

  it("恰好等于上限：一个都不淘汰（边界）", async () => {
    const { link, createChild } = setup();
    for (let i = 0; i < CAP; i += 1) {
      await call(link, { prompt: `任务${i}` }, { toolCallId: `toolu_${i}` });
    }
    await call(link, { prompt: "任务0" }, { toolCallId: "toolu_0" });
    expect(createChild).toHaveBeenCalledTimes(CAP);
  });

  it("在飞的条目不会被淘汰：别的调用灌满上限之后，它的重复派发仍并入原来那一次", async () => {
    const { link, runs, createChild } = setup({ hold: (p) => p === "慢" });
    const slow = call(link, { prompt: "慢" }, { toolCallId: "toolu_slow" });
    await tick();
    for (let i = 0; i < CAP + 5; i += 1) {
      await call(link, { prompt: `快${i}` }, { toolCallId: `toolu_fast_${i}` });
    }
    const before = createChild.mock.calls.length;
    expect(before).toBe(CAP + 6);

    const replay = call(link, { prompt: "慢" }, { toolCallId: "toolu_slow" });
    await tick();
    expect(createChild.mock.calls.length).toBe(before);

    runs[0]!.finish("慢活干完");
    const [a, b] = await Promise.all([slow, replay]);
    expect(a.text).toContain("慢活干完");
    expect(b).toEqual(a);
  });
});
