/**
 * 后台子代理的卡片图标：子代理其实还在干活，卡片却是绿勾（2026-10-19 用户截图）。
 *
 * 根因：主 AI 用 `run_in_background` 派子代理，`subagent` 工具调用**立刻返回**「已在后台启动…（后台任务 bg_xxx）」，
 * 事件流上那张 task 卡 status=success、亮绿勾；子代理要过好几分钟才跑完（聊天框上方的条一直写着「在后台工作」）。
 * 用户插话把前台子代理转后台时同理。
 *
 * 修法：服务端本来就实时下发「后台在跑清单」（SSE `background_subagents`），清单项的 id 就写在那段返回文本里——
 * 渲染层按「卡片结果里的后台任务 id ∈ 清单」给卡打 backgroundRunning、图标转圈；清单里没了（跑完 / 取消 / 超时 / 重启）卡片回到完成态。
 *
 *   A. 纯函数：从文本取 id、清单 → 集合
 *   B. markBackgroundSubagentTools 的口径（只认 task + success + 命中；引用稳定；幂等）
 *   C. 真链路：真实 `subagent` link（假子 agent）的返回文本 / 清单 / 转后台 → 渲染管线
 *   D. 接线与 UI 契约（源码契约）
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  backgroundJobIdSet,
  backgroundJobIdsInText,
  NO_BACKGROUND_JOB_IDS,
} from "@/lib/background-subagents";
import { toSubagentDisplayCall } from "@/lib/cursor-subagent-display";
import {
  __resetSubagentResumablesForTests,
  createCursorSubagentLink,
  type CursorSubagentDeps,
  type SubagentChildRun,
} from "@/lib/server/cursor-subagent";
import { subagentTargetFromToolBlock } from "@/lib/subagent-run-display";
import {
  isToolBlock,
  markBackgroundSubagentTools,
  mergeToolDisplayEvents,
  type StreamRenderItem,
  type ToolBlock,
} from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

// ---------- 事件构造 ----------

let seq = 0;
const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "kind" | "text">,
): TaskEvent => ({ id: `e${++seq}`, ts: 1000 + seq, ...partial });

const taskCall = (callId: string, name = "task"): TaskEvent =>
  ev({
    kind: "tool_call",
    text: `调用 ${name}`,
    meta: { callId, name, args: '{"description":"渲染","prompt":"去渲染"}' },
  });

const taskResult = (callId: string, output: string, name = "task"): TaskEvent =>
  ev({
    kind: "tool_result",
    text: `工具完成 ${name}`,
    meta: { callId, name, status: "success", output },
  });

const blockOf = (items: StreamRenderItem[], callId: string): ToolBlock => {
  const b = items.find((it) => isToolBlock(it) && it.callId === callId);
  if (!b || !isToolBlock(b)) throw new Error(`no block ${callId}`);
  return b;
};

const LAUNCH_TEXT =
  "已在后台启动子代理「渲染」（后台任务 bg_0a1b2c3d）。它做完后系统会把它的输出作为一条消息发给你——不用轮询、也不要等它，现在可以继续做别的事、或回应用户。";

// ============================================================ A

describe("backgroundJobIdsInText / backgroundJobIdSet", () => {
  it("取文本里的后台任务 id：启动文案 / 转后台文案都能取到", () => {
    expect(backgroundJobIdsInText(LAUNCH_TEXT)).toEqual(["bg_0a1b2c3d"]);
    expect(
      backgroundJobIdsInText(
        "[这个子代理已转到后台继续运行] 用户有新的话要先跟你说。子代理「x」（后台任务 bg_deadbeef）还在干活",
      ),
    ).toEqual(["bg_deadbeef"]);
  });

  it("多个 id 去重、保序；没有 / 非字符串 / 空串 → 空数组", () => {
    expect(backgroundJobIdsInText("bg_11111111 然后 bg_22222222 又 bg_11111111")).toEqual([
      "bg_11111111",
      "bg_22222222",
    ]);
    expect(backgroundJobIdsInText("没有 id")).toEqual([]);
    expect(backgroundJobIdsInText("")).toEqual([]);
    expect(backgroundJobIdsInText(undefined)).toEqual([]);
    expect(backgroundJobIdsInText(42)).toEqual([]);
  });

  it("只认「bg_ + 8 位小写十六进制」的整词：更长 / 更短 / 大写 / 前面粘着别的字母都不算", () => {
    expect(backgroundJobIdsInText("bg_0a1b2c3")).toEqual([]);
    expect(backgroundJobIdsInText("bg_0a1b2c3d4")).toEqual([]);
    expect(backgroundJobIdsInText("bg_0A1B2C3D")).toEqual([]);
    expect(backgroundJobIdsInText("xbg_0a1b2c3d")).toEqual([]);
    expect(backgroundJobIdsInText("（bg_0a1b2c3d）")).toEqual(["bg_0a1b2c3d"]);
  });

  it("清单 → id 集合；空 / 缺失返回同一个共享空集合（引用稳定）", () => {
    expect([...backgroundJobIdSet([{ id: "a" }, { id: "b" }])]).toEqual(["a", "b"]);
    expect(backgroundJobIdSet([])).toBe(NO_BACKGROUND_JOB_IDS);
    expect(backgroundJobIdSet(undefined)).toBe(NO_BACKGROUND_JOB_IDS);
    expect(NO_BACKGROUND_JOB_IDS.size).toBe(0);
  });
});

// ============================================================ B

describe("markBackgroundSubagentTools：给后台在跑的子代理卡打 backgroundRunning", () => {
  const build = (events: TaskEvent[]): StreamRenderItem[] => mergeToolDisplayEvents(events);

  it("真实形态：task 卡已 success（绿勾的来源）+ 结果里的 id 在清单里 → backgroundRunning，status 仍是 success", () => {
    const items = build([taskCall("c1"), taskResult("c1", LAUNCH_TEXT)]);
    // 前提自检：卡片已完成、还没打标
    expect(blockOf(items, "c1").status).toBe("success");
    expect(blockOf(items, "c1").backgroundRunning).toBeUndefined();

    const marked = markBackgroundSubagentTools(items, new Set(["bg_0a1b2c3d"]));
    expect(blockOf(marked, "c1").backgroundRunning).toBe(true);
    expect(blockOf(marked, "c1").status).toBe("success");
  });

  it("清单里没有这个 id（跑完 / 取消 / 超时 / 重启后）→ 不打标，回到完成态", () => {
    const items = build([taskCall("c1"), taskResult("c1", LAUNCH_TEXT)]);
    expect(markBackgroundSubagentTools(items, new Set(["bg_ffffffff"]))).toBe(items);
    expect(markBackgroundSubagentTools(items, new Set())).toBe(items);
  });

  it("多张后台卡各按各的 id：跑完一个只有它回到完成态", () => {
    const items = build([
      taskCall("c1"),
      taskResult("c1", "已在后台启动子代理「A」（后台任务 bg_11111111）。"),
      taskCall("c2"),
      taskResult("c2", "已在后台启动子代理「B」（后台任务 bg_22222222）。"),
    ]);
    const both = markBackgroundSubagentTools(items, new Set(["bg_11111111", "bg_22222222"]));
    expect(blockOf(both, "c1").backgroundRunning).toBe(true);
    expect(blockOf(both, "c2").backgroundRunning).toBe(true);

    const onlyB = markBackgroundSubagentTools(items, new Set(["bg_22222222"]));
    expect(blockOf(onlyB, "c1")).toBe(blockOf(items, "c1"));
    expect(blockOf(onlyB, "c1").backgroundRunning).toBeUndefined();
    expect(blockOf(onlyB, "c2").backgroundRunning).toBe(true);
  });

  it("只认 task 块：别的工具输出里碰巧带着同一个 id 也不转圈", () => {
    const items = build([
      taskCall("c1", "shell"),
      taskResult("c1", "echo bg_0a1b2c3d", "shell"),
    ]);
    expect(markBackgroundSubagentTools(items, new Set(["bg_0a1b2c3d"]))).toBe(items);
  });

  it("只处理 success：仍在 running 的卡不重复处理；error / interrupted 的标不被盖掉", () => {
    const running = build([taskCall("c1")]);
    expect(blockOf(running, "c1").status).toBe("running");
    expect(markBackgroundSubagentTools(running, new Set(["bg_0a1b2c3d"]))).toBe(running);

    const failed = build([
      taskCall("c2"),
      ev({
        kind: "tool_result",
        text: "工具失败 task",
        meta: { callId: "c2", name: "task", status: "error", output: LAUNCH_TEXT },
      }),
    ]);
    expect(blockOf(failed, "c2").status).toBe("error");
    expect(markBackgroundSubagentTools(failed, new Set(["bg_0a1b2c3d"]))).toBe(failed);
  });

  it("没有命中：返回原数组；命中的换新对象、没命中的保持原对象（下游 memo 不被击穿）", () => {
    const items = build([
      taskCall("c1"),
      taskResult("c1", "已在后台启动子代理「A」（后台任务 bg_11111111）。"),
      taskCall("c2"),
      taskResult("c2", "前台跑完的产出，没有 id"),
    ]);
    const marked = markBackgroundSubagentTools(items, new Set(["bg_11111111"]));
    expect(marked).not.toBe(items);
    expect(blockOf(marked, "c1")).not.toBe(blockOf(items, "c1"));
    expect(blockOf(marked, "c2")).toBe(blockOf(items, "c2"));
  });

  it("幂等：已打过标再打一次不产生新对象", () => {
    const items = build([taskCall("c1"), taskResult("c1", LAUNCH_TEXT)]);
    const once = markBackgroundSubagentTools(items, new Set(["bg_0a1b2c3d"]));
    expect(markBackgroundSubagentTools(once, new Set(["bg_0a1b2c3d"]))).toBe(once);
  });

  it("subagentTargetFromToolBlock：后台还在跑的卡，面板兜底按「还在跑」处理（记录刚建好查不到时多等几秒）", () => {
    const items = build([taskCall("c1"), taskResult("c1", LAUNCH_TEXT)]);
    const plain = blockOf(items, "c1");
    expect(subagentTargetFromToolBlock(plain).fallback?.running).toBe(false);
    const bg = blockOf(
      markBackgroundSubagentTools(items, new Set(["bg_0a1b2c3d"])),
      "c1",
    );
    expect(subagentTargetFromToolBlock(bg).fallback?.running).toBe(true);
  });
});

// ============================================================ C

interface ManualRun extends SubagentChildRun {
  finish: (result?: string) => void;
}

const manualRun = (): ManualRun => {
  let resolveWait!: (v: { status: string; result?: string }) => void;
  const waitP = new Promise<{ status: string; result?: string }>((r) => {
    resolveWait = r;
  });
  return {
    cancel: vi.fn(async () => resolveWait({ status: "cancelled" })),
    stream: () => (async function* () {})(),
    wait: () => waitP,
    finish: (result = "子代理的结果") => resolveWait({ status: "finished", result }),
  };
};

const setupLink = () => {
  const runs: ManualRun[] = [];
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5" },
    loadCatalog: async () => null,
    createChild: vi.fn(async () => {
      const run = manualRun();
      runs.push(run);
      return { send: vi.fn(async () => run), close: vi.fn() };
    }),
    background: { onSettled: () => {} },
  };
  return { link: createCursorSubagentLink(deps), runs };
};

const settleTail = () => new Promise((r) => setTimeout(r, 15));

/**
 * 把真实 `subagent` 工具的返回文本按事件流里的真实形态走一遍：
 * MCP 信封 → toSubagentDisplayCall 改写成 task → tool_result.output → 渲染配对。
 */
const asTaskCardEvents = (callId: string, text: string): TaskEvent[] => {
  const mcp = {
    type: "tool_call",
    call_id: callId,
    status: "completed",
    name: "mcp",
    args: {
      providerIdentifier: "custom-user-tools",
      toolName: "subagent",
      args: { description: "渲染", prompt: "去渲染", run_in_background: true },
    },
    result: { value: { content: [{ text: { text } }], isError: false } },
  };
  const shown = toSubagentDisplayCall(mcp as never) as unknown as {
    name: string;
    args: unknown;
    result: string;
  };
  expect(shown.name).toBe("task");
  return [
    ev({
      kind: "tool_call",
      text: "调用 task",
      meta: { callId, name: "task", args: JSON.stringify(shown.args) },
    }),
    ev({
      kind: "tool_result",
      text: "工具完成 task",
      meta: { callId, name: "task", status: "success", output: shown.result },
    }),
  ];
};

describe("真链路：真实 subagent link 的返回文本 / 清单 → 卡片转圈", () => {
  beforeEach(() => {
    __resetSubagentResumablesForTests();
  });

  it("run_in_background：返回文本里的 id 就是清单里的 id → 卡转圈；子代理跑完清单清空 → 卡回到完成态", async () => {
    const { link, runs } = setupLink();
    const r = (await link.tool.execute(
      { prompt: "去渲染", description: "渲染", run_in_background: true } as never,
      {} as never,
    )) as { content: Array<{ text: string }> };
    const text = r.content.map((c) => c.text).join("\n");

    // 服务端文案与客户端取 id 的约定：文本里的 id 恰好是清单里的 id
    const jobs = link.control.backgroundJobs();
    expect(jobs).toHaveLength(1);
    expect(backgroundJobIdsInText(text)).toEqual([jobs[0]!.id]);

    const items = mergeToolDisplayEvents(asTaskCardEvents("call_bg", text));
    expect(blockOf(items, "call_bg").status).toBe("success"); // 绿勾的来源

    const during = markBackgroundSubagentTools(
      items,
      backgroundJobIdSet(link.control.backgroundJobs()),
    );
    expect(blockOf(during, "call_bg").backgroundRunning).toBe(true);

    runs[0]!.finish("渲染好了");
    await settleTail();
    expect(link.control.backgroundJobs()).toHaveLength(0);
    const after = markBackgroundSubagentTools(
      items,
      backgroundJobIdSet(link.control.backgroundJobs()),
    );
    expect(blockOf(after, "call_bg").backgroundRunning).toBeUndefined();
  });

  it("用户插话把前台子代理转后台：转后台那次的返回文本同样带 id → 卡转圈", async () => {
    const { link, runs } = setupLink();
    const pending = link.tool.execute(
      { prompt: "去渲染", description: "渲染" } as never,
      {} as never,
    ) as Promise<{ content: Array<{ text: string }> }>;
    await settleTail(); // 子 run 已发出、前台等待中
    expect(link.control.detachForeground()).toBe(1);
    const text = (await pending).content.map((c) => c.text).join("\n");
    expect(text).toContain("已转到后台继续运行");

    const jobs = link.control.backgroundJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.detached).toBe(true);
    const items = mergeToolDisplayEvents(asTaskCardEvents("call_detached", text));
    const marked = markBackgroundSubagentTools(items, backgroundJobIdSet(jobs));
    expect(blockOf(marked, "call_detached").backgroundRunning).toBe(true);

    runs[0]!.finish();
    await settleTail();
  });

  it("前台子代理跑完的产出（没有后台任务 id）：永远不转圈，哪怕清单里有别的后台任务", async () => {
    const { link, runs } = setupLink();
    const pending = link.tool.execute(
      { prompt: "去渲染", description: "渲染" } as never,
      {} as never,
    ) as Promise<{ content: Array<{ text: string }> }>;
    await settleTail();
    runs[0]!.finish("前台的产出");
    const text = (await pending).content.map((c) => c.text).join("\n");
    expect(backgroundJobIdsInText(text)).toEqual([]);

    const items = mergeToolDisplayEvents(asTaskCardEvents("call_fg", text));
    expect(markBackgroundSubagentTools(items, new Set(["bg_0a1b2c3d"]))).toBe(items);
  });
});

// ============================================================ D

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (...seg: string[]): string => readFileSync(path.join(srcDir, ...seg), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sliceFrom = (s: string, from: string, to?: string): string => {
  const a = s.indexOf(from);
  expect(a, `找不到 ${from}`).toBeGreaterThanOrEqual(0);
  const b = to ? s.indexOf(to, a + from.length) : -1;
  return b < 0 ? s.slice(a) : s.slice(a, b);
};

describe("契约：事件流接线", () => {
  const eventStream = stripComments(readSrc("components", "tasks", "event-stream.tsx"));
  const fn = sliceFrom(eventStream, "const buildStreamItems = (", "/** 与 contentCount 同一计量");

  it("buildStreamItems 多收一个必传的 backgroundJobIds（无默认值：漏传 = 后台子代理的卡悄悄亮绿勾）", () => {
    expect(fn).toMatch(/backgroundJobIds: ReadonlySet<string>,\n\): Array</);
    expect(fn).not.toMatch(/backgroundJobIds[^,\n]*=\s*(new Set|NO_BACKGROUND)/);
  });

  it("打标不看 runActive（后台子代理常在主 AI 说完之后才跑完，清单才是权威）；在 coerce 之后、分组之前", () => {
    const call = sliceFrom(fn, "markBackgroundSubagentTools(", ");");
    expect(call).toContain("backgroundJobIds");
    // 不能被 runActive 三元包住
    const before = fn.slice(0, fn.indexOf("markBackgroundSubagentTools("));
    expect(before).not.toMatch(/runActive\s*\?\s*$/);
    expect(fn.indexOf("coerceStaleRunningTools(merged)")).toBeLessThan(
      fn.indexOf("markBackgroundSubagentTools("),
    );
    expect(fn.indexOf("markBackgroundSubagentTools(")).toBeLessThan(
      fn.indexOf("groupChatRenderItems("),
    );
  });

  it("三处调用（items / loadEarlier 的 countItems / 前后条数差）都传同一个 backgroundJobIds", () => {
    const calls = eventStream.match(/buildStreamItems\(/g) ?? [];
    // 1 处定义（const buildStreamItems = (）不带「buildStreamItems(」紧邻形式之外的调用：items、countItems、before、after
    expect(calls.length).toBe(4);
    const withJobIds = eventStream.match(/buildStreamItems\([^)]*backgroundJobIds[^)]*\)/g) ?? [];
    expect(withJobIds.length).toBe(4);
  });

  it("集合从 backgroundSubagents 清单来、按清单引用 memo（chat-view 对清单做了相等判断）", () => {
    expect(eventStream).toContain("backgroundJobIdSet(backgroundSubagents)");
    expect(eventStream).toContain("[backgroundSubagents]");
    expect(eventStream).toContain("[task.events, isChat, isRunning, backgroundJobIds]");
  });
});

describe("契约：子代理卡图标", () => {
  const card = stripComments(
    sliceFrom(
      readSrc("components", "tasks", "event-stream", "tool-block.tsx"),
      "const TaskSubagentBlock = (",
      "const RegularToolBlockRow = (",
    ),
  );

  it("backgroundRunning 与 running 同走转圈，且在完成态的绿勾之前判", () => {
    const spin = card.indexOf('block.status === "running" || block.backgroundRunning === true');
    expect(spin).toBeGreaterThanOrEqual(0);
    const icon = sliceFrom(card, "const statusIcon = stillWorking ?", "const barClass");
    expect(icon.indexOf("<Loader2")).toBeGreaterThanOrEqual(0);
    expect(icon.indexOf("<Loader2")).toBeLessThan(icon.indexOf("<Check"));
  });

  it("后台运行中、没有直播输出可露时写明「后台运行中」（直播输出有就优先露输出）", () => {
    const tail = sliceFrom(card, "{liveTail ? (", ") : null}");
    expect(tail).toContain("block.backgroundRunning");
    expect(tail).toContain("后台运行中");
    expect(tail.indexOf("{liveTail}")).toBeLessThan(tail.indexOf("后台运行中"));
  });
});
