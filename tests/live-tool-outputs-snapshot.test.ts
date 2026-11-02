/**
 * 客户端：SSE tool_output_snapshot 帧 → onToolOutputSnapshot → 直播缓冲「替换」语义。
 *
 * 背景：agent 在跑长 shell 时用户切到别的窗口再切回（ChatView 重挂、挂载时清空直播缓冲）/ SSE 重连，
 * 服务端 bootstrap 补一帧各在跑 shell 已发出的尾部窗口（服务端部分见 tests/live-shell-output-snapshot.test.ts、
 * tests/watch-task-tool-output-snapshot.test.ts）。前端必须用**替换**语义：快照之后的实时 delta 由服务端排在它后面回放，
 * 整份换掉再接着追加才不重不漏；若复用追加型 delta，重连后本地已有的尾巴会被再拼一遍。
 *
 * 本文件钉：
 *   1. replaceLiveToolOutputs（纯函数）：替换而非追加 / 本地多出的 callId 被清 / 与现值相同返回原引用 / 空快照清空 /
 *      入口再封顶 / 脏条目丢弃 / 不改入参；
 *   2. watchTaskStream 解析：合法数组转发、空数组也转发（= 清残留）、条目逐项校验、outputs 不是数组的无效帧丢弃；
 *   3. 接线契约（vitest 是 node 环境、跑不了 UI）：task-store → useTaskWatch（带 cancelled 门）→ ChatView / 任务页（page.tsx）→
 *      useLiveToolOutputs。两个入口都得接：chat 模式走 ChatView 自己的 useTaskWatch、task 模式走 page.tsx 的 useTaskWatch，
 *      漏接任何一个，那个模式下的切走再切回 / 重连就还是空的。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LIVE_OUTPUT_MAX_CHARS, LIVE_OUTPUT_MAX_LINES } from "../src/lib/live-output-cap";
import {
  EMPTY_LIVE_TOOL_OUTPUTS,
  reduceLiveToolOutputs,
  replaceLiveToolOutputs,
  type LiveToolOutputSnapshotEntry,
} from "../src/lib/live-tool-outputs";
import { watchTaskStream } from "../src/lib/task-store";
import type { TaskEvent } from "../src/lib/types";

const delta = (callId: string, chunk: string): TaskEvent => ({
  id: `ephemeral_tod_${callId}_1`,
  ts: 1,
  kind: "tool_output_delta",
  text: "",
  meta: { callId, chunk },
});

describe("replaceLiveToolOutputs：替换，不是追加", () => {
  it("本地没有任何缓冲（切走再切回）：整份铺上，之后的实时 delta 接着追加", () => {
    const live = replaceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, [
      { callId: "a", text: "step 1\nstep 2\n" },
    ]);
    expect(live).toEqual({ a: "step 1\nstep 2\n" });
    expect(reduceLiveToolOutputs(live, delta("a", "step 3\n"))).toEqual({
      a: "step 1\nstep 2\nstep 3\n",
    });
  });

  it("本地已有一截（同页重连）：换成服务端的权威尾部，不会把已有的再拼一遍", () => {
    const prev = { a: "step 1\nstep 2\n" };
    const next = replaceLiveToolOutputs(prev, [{ callId: "a", text: "step 1\nstep 2\nstep 3\n" }]);
    expect(next).toEqual({ a: "step 1\nstep 2\nstep 3\n" });
    // 对照：若走追加型 delta，本地已有的尾巴被重复一遍——这正是不能复用 reduceLiveToolOutputs 的原因
    expect(reduceLiveToolOutputs(prev, delta("a", "step 1\nstep 2\nstep 3\n")).a).toBe(
      "step 1\nstep 2\nstep 1\nstep 2\nstep 3\n",
    );
  });

  it("本地有、快照没有的 callId 一并清掉（断线期间这个 shell 已结束 / 服务端不再追踪）——快照是权威", () => {
    const next = replaceLiveToolOutputs({ a: "旧 a", gone: "旧 gone" }, [
      { callId: "a", text: "新 a" },
      { callId: "b", text: "新 b" },
    ]);
    expect(next).toEqual({ a: "新 a", b: "新 b" });
    expect("gone" in next).toBe(false);
  });

  it("与现值逐项相同 → 原引用返回（同页重连快照与本地一致是常态，React 直接 bail out、不重渲染）", () => {
    const prev = { a: "x\n", b: "y\n" };
    expect(
      replaceLiveToolOutputs(prev, [
        { callId: "b", text: "y\n" }, // 顺序不同不影响
        { callId: "a", text: "x\n" },
      ]),
    ).toBe(prev);
    // 内容不同 / key 集合不同 → 新对象
    expect(replaceLiveToolOutputs(prev, [{ callId: "a", text: "x\n" }])).not.toBe(prev);
    expect(
      replaceLiveToolOutputs(prev, [
        { callId: "a", text: "x\n" },
        { callId: "b", text: "变了\n" },
      ]),
    ).not.toBe(prev);
  });

  it("空快照 = 没有在跑的 shell：清空并复用稳定的 EMPTY 引用；本来就空则原引用", () => {
    expect(replaceLiveToolOutputs({ stale: "残留" }, [])).toBe(EMPTY_LIVE_TOOL_OUTPUTS);
    expect(replaceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, [])).toBe(EMPTY_LIVE_TOOL_OUTPUTS);
    const emptyObj = {};
    expect(replaceLiveToolOutputs(emptyObj, [])).toBe(emptyObj);
  });

  it(`入口再封顶（帧是外部输入）：只留最后 ${LIVE_OUTPUT_MAX_LINES} 行、不超过 ${LIVE_OUTPUT_MAX_CHARS} 字符`, () => {
    const rows = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
    const byLines = replaceLiveToolOutputs({}, [{ callId: "a", text: rows }]);
    const lines = byLines.a!.split("\n");
    expect(lines).toHaveLength(LIVE_OUTPUT_MAX_LINES);
    expect(lines[0]).toBe("row 30");
    expect(lines.at(-1)).toBe("row 49");

    const byChars = replaceLiveToolOutputs({}, [{ callId: "b", text: "z".repeat(50_000) }]);
    expect(byChars.b!.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
  });

  it("脏条目（空 callId / 空文本）丢掉；不改入参（React state 不可变）", () => {
    const snapshot: LiveToolOutputSnapshotEntry[] = Object.freeze([
      { callId: "", text: "无 id" },
      { callId: "a", text: "" },
      { callId: "ok", text: "好" },
    ]) as unknown as LiveToolOutputSnapshotEntry[];
    const prev = Object.freeze({ keep: "旧" });
    const next = replaceLiveToolOutputs(prev, snapshot);
    expect(next).toEqual({ ok: "好" });
    expect(prev).toEqual({ keep: "旧" });
  });

  it("tool_result 到达仍按 callId 清缓冲（快照与 reduce 的 tool_result 清理协同）", () => {
    const live = replaceLiveToolOutputs({}, [{ callId: "a", text: "x\n" }]);
    const after = reduceLiveToolOutputs(live, {
      id: "r1",
      ts: 2,
      kind: "tool_result",
      text: "工具完成 shell",
      meta: { callId: "a", name: "shell", status: "success", output: "done" },
    });
    expect(after).toEqual({});
  });
});

// ---------------------------------------------------------------- 客户端解析

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
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

const snapshotsOf = async (payloads: unknown[]): Promise<LiveToolOutputSnapshotEntry[][]> => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse([{ type: "task", task: { id: "t1", events: [] } }, ...payloads])),
  );
  const got: LiveToolOutputSnapshotEntry[][] = [];
  await watchTaskStream("t1", { onToolOutputSnapshot: (o) => got.push(o) });
  return got;
};

describe("SSE tool_output_snapshot → onToolOutputSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("合法数组：原样转发 { callId, text }", async () => {
    expect(
      await snapshotsOf([
        {
          type: "tool_output_snapshot",
          outputs: [
            { callId: "a", text: "build\n" },
            { callId: "b", text: "test\n" },
          ],
        },
      ]),
    ).toEqual([
      [
        { callId: "a", text: "build\n" },
        { callId: "b", text: "test\n" },
      ],
    ]);
  });

  it("空数组也转发（= 没有在跑的 shell，上层据此清残留）", async () => {
    expect(await snapshotsOf([{ type: "tool_output_snapshot", outputs: [] }])).toEqual([[]]);
  });

  it("条目逐项校验：缺 callId / 空串 / text 非字符串 / 空文本 / 非对象的条目单独丢掉，合法的保留", async () => {
    expect(
      await snapshotsOf([
        {
          type: "tool_output_snapshot",
          outputs: [
            { text: "无 callId" },
            { callId: "", text: "空 callId" },
            { callId: "a", text: 5 },
            { callId: "b", text: "" },
            null,
            "oops",
            { callId: "ok", text: "好" },
          ],
        },
      ]),
    ).toEqual([[{ callId: "ok", text: "好" }]]);
  });

  it("无效帧（outputs 缺失 / 不是数组）整帧丢弃、不回调——宁可不动本地直播缓冲，也别拿脏数据覆盖它", async () => {
    expect(
      await snapshotsOf([
        { type: "tool_output_snapshot" },
        { type: "tool_output_snapshot", outputs: null },
        { type: "tool_output_snapshot", outputs: "oops" },
        { type: "tool_output_snapshot", outputs: { a: "x" } },
        { type: "tool_output_snapshot", outputs: [{ callId: "last", text: "唯一有效" }] },
      ]),
    ).toEqual([[{ callId: "last", text: "唯一有效" }]]);
  });

  it("没挂 onToolOutputSnapshot 的订阅者（只关心别的帧的调用方）收到该帧时被静默忽略，不抛、不影响后面的帧", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "task", task: { id: "t1", events: [] } },
          { type: "tool_output_snapshot", outputs: [{ callId: "a", text: "x" }] },
          { type: "assistant_snapshot", live: null },
        ]),
      ),
    );
    const snaps: unknown[] = [];
    await expect(
      watchTaskStream("t1", { onAssistantSnapshot: (s) => snaps.push(s) }),
    ).resolves.toBeTruthy();
    expect(snaps).toEqual([null]);
  });
});

// ---------------------------------------------------------------- 接线契约

describe("接线契约：task-store → useTaskWatch → ChatView / 任务页 → useLiveToolOutputs", () => {
  const srcDir = path.resolve(import.meta.dirname, "..", "src");
  const read = (...segments: string[]): string => readFileSync(path.join(srcDir, ...segments), "utf-8");
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("task-store：帧类型声明、回调声明、解析后才回调（undefined = 无效帧丢弃）", () => {
    const src = read("lib", "task-store.ts");
    expect(src).toContain('| "tool_output_snapshot"');
    expect(src).toContain("onToolOutputSnapshot?: (outputs: LiveToolOutputSnapshotEntry[]) => void;");
    expect(src).toContain('env.type === "tool_output_snapshot"');
    expect(src).toContain("if (outputs !== undefined) callbacks.onToolOutputSnapshot?.(outputs);");
  });

  it("useTaskWatch：onToolOutputSnapshot 经 callbacksRef 透传，带 cancelled 守卫（卸载后迟到帧不回调）", () => {
    const src = read("hooks", "use-task-watch.ts");
    expect(src).toMatch(
      /onToolOutputSnapshot: \(outputs\) => \{\s*if \(cancelled\) return;\s*callbacksRef\.current\.onToolOutputSnapshot\?\.\(outputs\);\s*\}/,
    );
    expect(src).toContain("onToolOutputSnapshot?: (outputs: LiveToolOutputSnapshotEntry[]) => void;");
  });

  it("useLiveToolOutputs：applyToolOutputSnapshot 稳定回调（useCallback 空依赖）、走 replaceLiveToolOutputs（替换，不是 reduce 追加）", () => {
    const hook = stripComments(read("hooks", "use-live-tool-outputs.ts"));
    expect(hook).toContain("replaceLiveToolOutputs");
    expect(hook).toMatch(
      /const applyToolOutputSnapshot = useCallback\(\s*\(snapshot: readonly LiveToolOutputSnapshotEntry\[\]\) => \{\s*setLiveToolOutputs\(\(prev\) => replaceLiveToolOutputs\(prev, snapshot\)\);\s*\},\s*\[\],\s*\)/,
    );
    expect(hook).toMatch(/return \{[^}]*applyToolOutputSnapshot[^}]*\}/);
  });

  it("ChatView：从 hook 取 applyToolOutputSnapshot 并接给 useTaskWatch 的 onToolOutputSnapshot", () => {
    const chatView = stripComments(read("components", "tasks", "chat-view.tsx"));
    expect(chatView).toMatch(/const \{[^}]*applyToolOutputSnapshot[^}]*\} = useLiveToolOutputs\(\)/);
    expect(chatView).toContain("onToolOutputSnapshot: applyToolOutputSnapshot");
    // 挂载 / 切任务时仍清空直播缓冲（上个任务的不能串到新任务）——快照是在它之后、由新连接的 bootstrap 铺上的
    expect(chatView).toMatch(/clearLiveToolOutputs\(\);\s*setRunActive\(false\)/);
  });

  it("任务页（page.tsx，task 模式）：从 hook 取 applyToolOutputSnapshot，并接在 useTaskWatch 的回调对象里（与 assistant 快照同一个对象）", () => {
    const page = stripComments(read("app", "tasks", "[id]", "page.tsx"));
    // 从 useLiveToolOutputs() 解构出 applyToolOutputSnapshot
    expect(page).toMatch(/const \{[^}]*applyToolOutputSnapshot[^}]*\} = useLiveToolOutputs\(\)/);
    // 只有一处 useTaskWatch 调用；onToolOutputSnapshot 在它的回调对象里（紧跟 onAssistantSnapshot）、而不是挂在别处
    expect(page.match(/\buseTaskWatch\(/g)?.length).toBe(1);
    const callAt = page.indexOf("useTaskWatch(");
    expect(callAt).toBeGreaterThan(0);
    expect(page.slice(callAt)).toMatch(
      /onAssistantSnapshot: applyAssistantSnapshot,\s*onToolOutputSnapshot: applyToolOutputSnapshot,/,
    );
    // 切任务仍清直播缓冲（上个任务的不能串到新任务）；快照由新连接 bootstrap 铺上
    expect(page).toMatch(/useEffect\(\(\) => \{\s*clearLiveToolOutputs\(\);\s*\}, \[task\?\.id, clearLiveToolOutputs\]\)/);
    // run 收尾（done 且释放 run latch）清没等到 tool_result 的直播缓冲——服务端 done 时同样丢快照，两边口径一致
    expect(page).toMatch(/if \(plan\.releaseRunLatch\) \{[^}]*clearLiveToolOutputs\(\);/);
  });

  it("两个入口接线对称：ChatView 与任务页都从 useLiveToolOutputs 取 applyToolOutputSnapshot 且各接一次（不会一边漏接）", () => {
    for (const file of [
      ["components", "tasks", "chat-view.tsx"],
      ["app", "tasks", "[id]", "page.tsx"],
    ] as const) {
      const src = stripComments(read(...file));
      expect(src.match(/onToolOutputSnapshot: applyToolOutputSnapshot/g)?.length, file.join("/")).toBe(1);
      expect(src.match(/\bapplyToolOutputSnapshot,/g)?.length ?? 0, file.join("/")).toBeGreaterThanOrEqual(1);
    }
  });

  it("路由：快照紧跟订阅、同步读（在第一个 await 之前）；bootstrap 每一帧走 bootstrapStep 各自 try/catch；快照帧夹在 assistant 与 thinking 之间", () => {
    const route = read("app", "api", "tasks", "[id]", "watch-task", "route.ts");
    const stripped = stripComments(route);
    const subAt = stripped.indexOf("subscribeTaskStream(id,");
    const snapAt = stripped.indexOf("const shellOutputSnap = getLiveShellOutputSnapshot(id);");
    const awaitAt = stripped.indexOf("await getTaskWithTailEvents(");
    expect(subAt).toBeGreaterThanOrEqual(0);
    expect(snapAt).toBeGreaterThan(subAt);
    expect(awaitAt).toBeGreaterThan(snapAt);
    // 订阅与读快照之间不能有 await（隔了 await = 期间的帧既进快照又进 buffer，前端文本被重复一遍）
    expect(stripped.slice(subAt, snapAt)).not.toContain("await");

    const assistantAt = stripped.indexOf('bootstrapStep("assistant_snapshot"');
    const toolAt = stripped.indexOf('bootstrapStep("tool_output_snapshot"');
    const thinkingAt = stripped.indexOf('bootstrapStep("thinking_snapshot"');
    expect(assistantAt).toBeGreaterThan(0);
    expect(toolAt).toBeGreaterThan(assistantAt);
    expect(thinkingAt).toBeGreaterThan(toolAt);
    // 快照帧无条件发、且滤掉 tail 里已有 tool_result 的 callId
    const toolStep = stripped.slice(toolAt, thinkingAt);
    expect(toolStep).toContain('e.kind === "tool_result"');
    expect(toolStep).toContain("shellOutputSnap.filter((o) => !finishedCallIds.has(o.callId))");
    expect(toolStep).not.toMatch(/if \(shellOutputSnap/);

    // bootstrap 区段里不再有「整段同一个 try」：try / catch 只在 bootstrapStep 里出现一次
    const bootstrapAt = stripped.indexOf("const bootstrapStep =");
    const bootstrapEnd = stripped.indexOf("bootstrapping = false;");
    const region = stripped.slice(bootstrapAt, bootstrapEnd);
    expect(region.match(/\btry \{/g)?.length ?? 0).toBe(1);
    expect(region.match(/\bcatch \(/g)?.length ?? 0).toBe(1);
  });
});
