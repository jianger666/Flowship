/**
 * Cursor `subagent` 工具 ↔ 子代理过程记录（`subagent-transcript`）的接线：
 *   - 子 run 起来之后才开始记；流里每条消息都喂给记录器；收尾按 done / failed / cancelled 记
 *   - toolCallId（SDK 给工具回调的）原样交给记录器，事件流卡片靠它（或任务书兜底）找到记录
 *   - 转后台 / 超时 / 后台条的 runKey
 *   - **记录器出任何问题都不能影响子代理本身**（start 抛、句柄方法抛，照样返回结果）
 *
 * 不碰真实 SDK：子 agent 是注入的假依赖。DATA_DIR 须在动态 import 前钉死。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-cursor-subagent-transcript-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  __resetSubagentResumablesForTests,
  createCursorSubagentLink,
} = await import("../src/lib/server/cursor-subagent");
const transcript = await import("../src/lib/server/subagent-transcript");
const { noteSubagentToolCall } = transcript;

import type {
  CursorSubagentDeps,
  SubagentChildRun,
  SubagentTranscriptSink,
} from "../src/lib/server/cursor-subagent";
import type { SubagentRunHandle } from "../src/lib/server/subagent-transcript";

interface ScriptedRun extends SubagentChildRun {
  finish: (result?: string) => void;
  fail: (message: string) => void;
  cancelled: () => boolean;
}

/** 流先吐 messages、然后挂着直到 finish / fail / cancel；wait 在同一时刻返回 */
const scriptedRun = (messages: unknown[] = []): ScriptedRun => {
  type Res = { status: string; result?: string; error?: { message?: string } | null };
  let resolveWait!: (v: Res) => void;
  const waitP = new Promise<Res>((r) => {
    resolveWait = r;
  });
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    cancel: vi.fn(async () => {
      cancelled = true;
      resolveWait({ status: "cancelled" });
    }),
    stream: () =>
      (async function* () {
        for (const m of messages) yield m;
        await waitP;
      })(),
    wait: () => waitP,
    finish: (result = "子代理的结果") => resolveWait({ status: "finished", result }),
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
  return { sink: { start } as SubagentTranscriptSink, handle, start };
};

const setup = (opts: {
  transcripts?: SubagentTranscriptSink;
  messages?: unknown[];
  withIds?: boolean;
  background?: Partial<NonNullable<CursorSubagentDeps["background"]>>;
  parentModel?: CursorSubagentDeps["parentModel"];
  createError?: string;
  /** 模型目录（缺省拿不到 = null） */
  catalog?: Awaited<ReturnType<CursorSubagentDeps["loadCatalog"]>>;
}) => {
  const runs: ScriptedRun[] = [];
  let seq = 0;
  const createChild = vi.fn(async () => {
    if (opts.createError) throw new Error(opts.createError);
    seq += 1;
    const run = scriptedRun(opts.messages);
    runs.push(run);
    return {
      ...(opts.withIds ? { agentId: `child-${seq}` } : {}),
      send: vi.fn(async () => run),
      close: vi.fn(),
    };
  });
  const deps: CursorSubagentDeps = {
    parentModel: opts.parentModel ?? { id: "composer-2.5" },
    loadCatalog: async () => opts.catalog ?? null,
    createChild,
    ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
    ...(opts.background
      ? { background: { onSettled: () => {}, ...opts.background } }
      : {}),
  };
  const link = createCursorSubagentLink(deps);
  return { link, runs, createChild };
};

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const call = async (
  link: ReturnType<typeof createCursorSubagentLink>,
  args: Record<string, unknown>,
  ctx: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const r = (await link.tool.execute(args as never, ctx as never)) as ToolResult;
  return {
    text: r.content.map((c) => c.text).join("\n"),
    isError: r.isError === true,
  };
};

const tick = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => {
  __resetSubagentResumablesForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("记录器接线", () => {
  it("子 run 起来后 start：带完整任务书 / 描述 / 模型 / explore / toolCallId；流里每条消息都喂进去；done 记最终文本", async () => {
    const { sink, handle, start } = fakeSink();
    const msgs = [
      { type: "thinking", text: "想" },
      { type: "assistant", message: { content: [{ type: "text", text: "做" }] } },
    ];
    const { link, runs } = setup({ transcripts: sink, messages: msgs });
    const longPrompt = "任务书".repeat(1500); // 远超卡片上 2000 字的截断
    const p = call(
      link,
      { prompt: longPrompt, description: "查资料", subagentType: "explore" },
      { toolCallId: "call-xyz" },
    );
    await tick();
    runs[0]!.finish("最终文本");
    await p;

    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({
      description: "查资料",
      prompt: longPrompt,
      model: "composer-2.5",
      explore: true,
      resumed: false,
      toolCallId: "call-xyz",
      background: false,
    });
    expect(handle.onMessage.mock.calls.map((c) => c[0])).toEqual(msgs);
    expect(handle.finish).toHaveBeenCalledTimes(1);
    expect(handle.finish).toHaveBeenCalledWith({ status: "done", result: "最终文本" });
  });

  it("记的 result 不含给模型看的 id / 模型尾注（面板里的产出就是子代理的话）", async () => {
    const { sink, handle } = fakeSink();
    const { link, runs } = setup({ transcripts: sink, withIds: true });
    const p = call(link, { prompt: "做点事" });
    await tick();
    runs[0]!.finish("干净的产出");
    const out = await p;
    expect(out.text.length).toBeGreaterThan("干净的产出".length); // 给模型的带尾注
    expect(handle.finish).toHaveBeenCalledWith({ status: "done", result: "干净的产出" });
    expect(handle.setAgentId).toHaveBeenCalledWith("child-1");
  });

  it("子代理失败 → failed + 原因", async () => {
    const { sink, handle } = fakeSink();
    const { link, runs } = setup({ transcripts: sink });
    const p = call(link, { prompt: "做点事" });
    await tick();
    runs[0]!.fail("模型 503");
    const out = await p;
    expect(out.isError).toBe(true);
    expect(handle.finish).toHaveBeenCalledTimes(1);
    const arg = handle.finish.mock.calls[0]![0] as { status: string; error?: string };
    expect(arg.status).toBe("failed");
    expect(arg.error).toContain("模型 503");
  });

  it("取消（父 run 被停）→ cancelled", async () => {
    const { sink, handle } = fakeSink();
    const { link } = setup({ transcripts: sink });
    const p = call(link, { prompt: "做点事" });
    await tick();
    link.cancelAll();
    await p.catch(() => {});
    expect(handle.finish).toHaveBeenCalledWith({ status: "cancelled" });
  });

  it("建子 agent 失败（用法错误 / 起不来）→ 根本没有 start，不留空记录", async () => {
    const { sink, start } = fakeSink();
    const { link } = setup({ transcripts: sink, createError: "boom" });
    const out = await call(link, { prompt: "做点事" });
    expect(out.isError).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("没配记录器（单测 / 一次性调用）：行为不变", async () => {
    const { link, runs } = setup({});
    const p = call(link, { prompt: "做点事" });
    await tick();
    runs[0]!.finish("ok");
    expect(await p).toEqual({ text: "ok", isError: false });
  });

  it("记录器 start 抛错：只告警、子代理照常跑完", async () => {
    const start = vi.fn(() => {
      throw new Error("磁盘满了");
    });
    const { link, runs } = setup({ transcripts: { start } });
    const p = call(link, { prompt: "做点事" });
    await tick();
    runs[0]!.finish("照样有结果");
    expect(await p).toEqual({ text: "照样有结果", isError: false });
  });

  it("句柄的 onMessage / finish 抛错：同样不影响子代理", async () => {
    const { sink, handle } = fakeSink();
    handle.onMessage.mockImplementation(() => {
      throw new Error("记录器坏了");
    });
    handle.finish.mockImplementation(() => {
      throw new Error("记录器又坏了");
    });
    const { link, runs } = setup({
      transcripts: sink,
      messages: [{ type: "thinking", text: "x" }],
    });
    const p = call(link, { prompt: "做点事" });
    await tick();
    runs[0]!.finish("照样有结果");
    expect(await p).toEqual({ text: "照样有结果", isError: false });
  });
});

describe("后台运行", () => {
  it("run_in_background：start 带 background=true；条上的清单带 runKey；收尾记 done", async () => {
    const { sink, handle, start } = fakeSink();
    const { link, runs } = setup({ transcripts: sink, background: {} });
    await call(link, { prompt: "去查查", description: "查资料", run_in_background: true });
    await tick();
    expect(start.mock.calls[0]![0]).toMatchObject({ background: true });
    const jobs = link.control.backgroundJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ description: "查资料", runKey: "sa_fake000001" });

    runs[0]!.finish("查到了");
    await tick();
    expect(handle.finish).toHaveBeenCalledWith({ status: "done", result: "查到了" });
  });

  it("前台转后台（用户插话）：记录标成 background + detached", async () => {
    const { sink, handle } = fakeSink();
    const { link, runs } = setup({ transcripts: sink, background: {} });
    const p = call(link, { prompt: "前台干", description: "前台活" });
    await tick();
    expect(link.control.detachForeground()).toBe(1);
    await p;
    expect(handle.setBackground).toHaveBeenCalledWith(true);
    runs[0]!.finish("后来做完了");
    await tick();
    expect(handle.finish).toHaveBeenCalledWith({ status: "done", result: "后来做完了" });
  });

  it("超时被杀：记录按失败收尾并写明原因（不是「已取消」）——接真实记录器、只认第一次收尾", async () => {
    const taskId = "t_link_timeout";
    const sink: SubagentTranscriptSink = {
      start: (init) => transcript.startSubagentRun({ ...init, taskId, provider: "cursor" }),
    };
    const { link, runs } = setup({ transcripts: sink, background: { maxRuntimeMs: 30 } });
    await call(link, { prompt: "跑很久", description: "慢活", run_in_background: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(runs[0]!.cancelled()).toBe(true);
    const key = transcript.__runKeysForTests(taskId)[0]!;
    const snap = await transcript.getSubagentRunSnapshot(taskId, { key });
    // 子 run 被取消后 settle 看到的是 cancelled，但 job.timedOut 为真 → 记成「失败·超时」而不是「已取消」
    expect(snap?.meta.status).toBe("failed");
    expect(snap?.meta.error).toMatch(/仍未完成/);
  });

  it("超时取消来得太晚、子 run 其实成功返回：记录跟主 AI 看到的一致记 done，不是「失败·超时」", async () => {
    const { sink, handle } = fakeSink();
    const onSettled = vi.fn();
    const { link, runs } = setup({
      transcripts: sink,
      background: { maxRuntimeMs: 30, onSettled },
    });
    await call(link, { prompt: "磨蹭但做完了", description: "慢活", run_in_background: true });
    // cancel 没拦住它：到点后 run 以成功结局返回
    runs[0]!.cancel = vi.fn(async () => {
      runs[0]!.finish("其实做完了");
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(runs[0]!.cancel).toHaveBeenCalled();
    expect(handle.finish).toHaveBeenCalledTimes(1);
    expect(handle.finish).toHaveBeenCalledWith({ status: "done", result: "其实做完了" });
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("setAgentId 抛错不能跳过收尾：记录仍然 finish(done)，子代理结果照常返回", async () => {
    const { sink, handle } = fakeSink();
    handle.setAgentId.mockImplementation(() => {
      throw new Error("setAgentId 炸了");
    });
    const { link, runs } = setup({ transcripts: sink, withIds: true });
    const p = call(link, { prompt: "去做", description: "做事" });
    await tick();
    runs[0]!.finish("做完了");
    const out = await p;
    expect(out.isError).toBe(false);
    expect(out.text).toContain("做完了");
    expect(handle.setAgentId).toHaveBeenCalled();
    expect(handle.finish).toHaveBeenCalledWith({ status: "done", result: "做完了" });
  });

  it("同一毫秒里连派两个后台子代理：开始时间严格递增，清单里先派的在前（不随随机 id 翻转）", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    try {
      const { link } = setup({ background: {} });
      await call(link, { prompt: "a", description: "任务A", run_in_background: true });
      await call(link, { prompt: "b", description: "任务B", run_in_background: true });
      const jobs = link.control.backgroundJobs();
      expect(jobs.map((j) => j.description)).toEqual(["任务A", "任务B"]);
      expect(jobs[0]!.startedAt).toBe(5_000_000);
      expect(jobs[1]!.startedAt).toBe(5_000_001);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("没配记录器时清单里没有 runKey（条只展示、点不开）", async () => {
    const { link } = setup({ background: {} });
    await call(link, { prompt: "去查查", run_in_background: true });
    const jobs = link.control.backgroundJobs();
    expect(jobs).toHaveLength(1);
    expect("runKey" in jobs[0]!).toBe(false);
  });
});

describe("接真实记录器：从工具回调一路到可被详情接口取走的快照", () => {
  it("过程事件、完整任务书、callId 绑定（精确 + 任务书兜底）都对得上", async () => {
    const taskId = "t_link_real";
    const sink: SubagentTranscriptSink = {
      start: (init) => transcript.startSubagentRun({ ...init, taskId, provider: "cursor" }),
    };
    const msgs = [
      { type: "thinking", text: "先看看" },
      { type: "tool_call", call_id: "tc1", name: "read", args: { path: "a.ts" }, status: "running" },
      { type: "tool_call", call_id: "tc1", name: "read", args: { path: "a.ts" }, status: "completed", result: "内容" },
      { type: "assistant", message: { content: [{ type: "text", text: "读完了" }] } },
    ];
    const { link, runs } = setup({ transcripts: sink, messages: msgs, withIds: true });
    const prompt = "详细任务书：" + "x".repeat(3000);
    const p = call(link, { prompt, description: "读文件" }, { toolCallId: "card-call-1" });
    await tick();
    // 主流消息里那条 subagent 调用（SDK 的 call_id 与回调的 toolCallId 不一致时靠任务书兜底）
    noteSubagentToolCall(taskId, { callId: "stream-call-9", prompt });
    runs[0]!.finish("读完了");
    await p;

    for (const callId of ["card-call-1", "stream-call-9"]) {
      const snap = await transcript.getSubagentRunSnapshot(taskId, { callId });
      expect(snap, callId).not.toBeNull();
      expect(snap!.meta.prompt).toBe(prompt);
      expect(snap!.meta.description).toBe("读文件");
      expect(snap!.meta.status).toBe("done");
      expect(snap!.meta.result).toBe("读完了");
      expect(snap!.events.map((e) => e.kind)).toEqual([
        "thinking",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
    }
  });
});

describe("过程记录的 effort：写子代理实际生效的档位（含该模型的默认档）", () => {
  beforeEach(() => __resetSubagentResumablesForTests());

  const CATALOG = [
    {
      id: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      effortParamId: "reasoning_effort",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    },
    { id: "composer-2.5", displayName: "Composer 2.5", efforts: [] },
  ];

  const startedWith = async (
    args: Record<string, unknown>,
    over: { parentModel?: CursorSubagentDeps["parentModel"] } = {},
  ) => {
    const { sink, start } = fakeSink();
    const { link, runs } = setup({ transcripts: sink, catalog: CATALOG, ...over });
    const p = call(link, args);
    await tick();
    runs[0]!.finish("done");
    await p;
    expect(start).toHaveBeenCalledTimes(1);
    return start.mock.calls[0]![0] as { model?: string; effort?: string };
  };

  it("显式别的模型、没写 effort：记该模型目录里的默认档", async () => {
    expect(await startedWith({ prompt: "x", model: "claude-sonnet-5-5" })).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("显式写了 effort：记写的那个，不被默认档盖掉", async () => {
    expect(
      await startedWith({ prompt: "x", model: "claude-sonnet-5-5", effort: "max" }),
    ).toMatchObject({ effort: "max" });
  });

  it("沿用父会话且父会话有档位参数：记父会话的档位（不退到默认档）", async () => {
    expect(
      await startedWith(
        { prompt: "x" },
        {
          parentModel: {
            id: "claude-sonnet-5-5",
            params: [{ id: "reasoning_effort", value: "low" }],
          },
        },
      ),
    ).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  });

  it("该模型没有档位 / 目录里没标默认档：不记 effort（不硬造）", async () => {
    const init = await startedWith({ prompt: "x", model: "composer-2.5" });
    expect(init.model).toBe("composer-2.5");
    expect(init.effort).toBeUndefined();
  });
});
