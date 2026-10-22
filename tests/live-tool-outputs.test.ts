/**
 * V4-04：shell 直播输出（ephemeral tool_output_delta）的收集逻辑。
 *
 * 之前只有 chat-view 在收、task 页直接 `return` 丢掉，几分钟的 `pnpm build/test`
 * 在 task 页只有转圈 + 「等待输出…」。现在收集逻辑抽成纯函数（reduceLiveToolOutputs）
 * + 薄 hook（useLiveToolOutputs），chat / task 两处共用。
 *
 * UI 行为在 node 环境跑不起来（见 vitest.config.ts），所以：
 *   - 收集 / 清理语义：纯函数测试；
 *   - 「task 页真的接上了」：源码契约（同 event-stream-scroll-contract 的做法）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  affectsLiveToolOutputs,
  reduceLiveToolOutputs,
} from "../src/lib/live-tool-outputs";
import type { TaskEvent } from "../src/lib/types";

/** 与 shell-output-bridge 真实发出的 ephemeral 帧同形 */
const delta = (callId: string, chunk: string): TaskEvent => ({
  id: `ephemeral_tod_${callId}_1`,
  ts: 1,
  kind: "tool_output_delta",
  text: "",
  meta: { callId, chunk },
});

const toolResult = (callId: string): TaskEvent => ({
  id: `res_${callId}`,
  ts: 2,
  kind: "tool_result",
  text: "工具完成 shell",
  meta: { callId, name: "shell", status: "success", output: "done" },
});

describe("reduceLiveToolOutputs", () => {
  it("delta 按 callId 累积；不同 callId 互不串", () => {
    let s = reduceLiveToolOutputs({}, delta("a", "line1\n"));
    s = reduceLiveToolOutputs(s, delta("b", "other\n"));
    s = reduceLiveToolOutputs(s, delta("a", "line2\n"));
    expect(s).toEqual({ a: "line1\nline2\n", b: "other\n" });
  });

  it("只留尾部 20 行（长时间 build 不让内存 / DOM 无限涨）", () => {
    const many = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
    const s = reduceLiveToolOutputs({}, delta("a", many));
    const lines = s.a!.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("row 30");
    expect(lines[19]).toBe("row 49");
  });

  it("tool_result 到达 → 清掉该 callId 的直播缓冲，其它 callId 保留", () => {
    const s = reduceLiveToolOutputs(
      { a: "x", b: "y" },
      toolResult("a"),
    );
    expect(s).toEqual({ b: "y" });
  });

  it("没有对应缓冲的 tool_result / 无关事件 → 原引用返回（React 不重渲染）", () => {
    const prev = { a: "x" };
    expect(reduceLiveToolOutputs(prev, toolResult("zzz"))).toBe(prev);
    const assistant: TaskEvent = {
      id: "m1",
      ts: 3,
      kind: "assistant_message",
      text: "hi",
    };
    expect(reduceLiveToolOutputs(prev, assistant)).toBe(prev);
    // 没有 callId / chunk 的残缺 ephemeral 帧：不污染缓冲
    expect(
      reduceLiveToolOutputs(prev, {
        id: "ephemeral_tod_x_1",
        ts: 1,
        kind: "tool_output_delta",
        text: "",
        meta: {},
      }),
    ).toBe(prev);
  });

  it("不改入参（React state 不可变）", () => {
    const prev = Object.freeze({ a: "x" });
    expect(() => reduceLiveToolOutputs(prev, delta("a", "y"))).not.toThrow();
    expect(() => reduceLiveToolOutputs(prev, toolResult("a"))).not.toThrow();
    expect(prev).toEqual({ a: "x" });
  });
});

describe("affectsLiveToolOutputs", () => {
  it("只有 ephemeral delta 与 tool_result 会动直播缓冲，其它事件不必白调 setState", () => {
    expect(affectsLiveToolOutputs(delta("a", "x"))).toBe(true);
    expect(affectsLiveToolOutputs(toolResult("a"))).toBe(true);
    expect(
      affectsLiveToolOutputs({ id: "m", ts: 1, kind: "assistant_message", text: "" }),
    ).toBe(false);
    expect(
      affectsLiveToolOutputs({ id: "c", ts: 1, kind: "tool_call", text: "调用 shell" }),
    ).toBe(false);
  });
});

/** 源码契约：task 页真的把直播输出接给了 EventStream（修前是 `return` 丢掉） */
describe("task 页接入 useLiveToolOutputs（源码契约）", () => {
  const srcDir = path.resolve(import.meta.dirname, "..", "src");
  const read = (...segments: string[]): string =>
    readFileSync(path.join(srcDir, ...segments), "utf-8");
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const page = stripComments(read("app", "tasks", "[id]", "page.tsx"));
  const chatView = stripComments(read("components", "tasks", "chat-view.tsx"));

  it("task 页：用 hook 收集、把 liveToolOutputs 传给 EventStream、切任务 / 收尾要清", () => {
    expect(page).toContain("useLiveToolOutputs");
    // 页面现在渲染的是 SmoothEventStream（平滑吐字 state 下沉的薄包装、props 原样透传给 EventStream；V11-07）
    expect(page).toMatch(/<SmoothEventStream[\s\S]*?liveToolOutputs=\{liveToolOutputs\}/);
    // onEvent 里先交给 hook 吸收（吸收了 = ephemeral 帧，不进持久 events）
    expect(page).toMatch(/absorbLiveToolOutputEvent\(ev\)/);
    // 收尾（done）与切任务都要清，漏了上个任务的尾行会串到新任务
    expect(page).toMatch(/clearLiveToolOutputs\(\)/);
    expect(page).toMatch(/\[task\?\.id,\s*clearLiveToolOutputs\]/);
  });

  it("chat 页与 task 页共用同一个 hook（逻辑只有一份）", () => {
    expect(chatView).toContain("useLiveToolOutputs");
    // 旧的内联收集（自己 setState + 自己 trim）不能再有
    expect(chatView).not.toContain("setLiveToolOutputs");
    expect(chatView).not.toContain("trimLiveOutputLines");
  });

  it("hook 本身：稳定回调（切任务 effect 依赖它不能每帧重跑）、复用纯函数", () => {
    const hook = stripComments(read("hooks", "use-live-tool-outputs.ts"));
    expect(hook).toContain("reduceLiveToolOutputs");
    expect(hook).toContain("affectsLiveToolOutputs");
    expect(hook.match(/useCallback\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // 「liveToolOutputs 不进 activeStatus 的 memo / statusEvents 的依赖」（HANDOFF:1336）
  // 由 tests/event-stream-scroll-contract.test.ts 钉着；本次改动只从页面往 EventStream 多传一个 prop、
  // 不碰 event-stream.tsx，所以那条契约原样成立。
});
