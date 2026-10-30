/**
 * R7-02：shell 直播缓冲「只按行数封顶」→ 无换行长流内存无界且每帧 O(n²)。
 *
 * 第三轮实测：10MB 无换行流（5000 帧 × 2KB）→ 缓冲 10,240,000 字符、reducer 累计 4.5s（主线程，整页 setState 同步重渲）；
 * `curl -#` / docker pull 的 `\r` 进度条整串被当「一行」，折叠行尾行 `truncate` 只显示**最早**的百分比。
 * 现在：行数（20）与字符数（8192）双封顶，`\r` 也是行分隔；服务端 shell-output-bridge 对单帧用同一口径封顶。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LIVE_OUTPUT_MAX_CHARS,
  LIVE_OUTPUT_MAX_LINES,
  liveOutputTailLine,
  sliceLiveOutputTail,
  trimLiveOutput,
} from "../src/lib/live-output-cap";
import { deriveActiveStatus } from "../src/lib/chat-turns";
import { reduceLiveToolOutputs } from "../src/lib/live-tool-outputs";
import { trimLiveOutputLines } from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const delta = (callId: string, chunk: string, n = 1): TaskEvent => ({
  id: `ephemeral_tod_${callId}_${n}`,
  ts: n,
  kind: "tool_output_delta",
  text: "",
  meta: { callId, chunk },
});

describe("trimLiveOutput：行数 + 字符数双封顶", () => {
  it("口径常量：20 行 / 8192 字符", () => {
    expect(LIVE_OUTPUT_MAX_LINES).toBe(20);
    expect(LIVE_OUTPUT_MAX_CHARS).toBe(8192);
  });

  it("只留尾部 20 行（与旧 trimLiveOutputLines 同语义，含末尾换行算一个空元素）", () => {
    const many = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
    const out = trimLiveOutput(many);
    expect(out.split("\n")).toHaveLength(20);
    expect(out.startsWith("row 30\n")).toBe(true);
    expect(out.endsWith("row 49")).toBe(true);
    // 恰好 20 行原样返回（同一个字符串）
    const twenty = Array.from({ length: 20 }, (_, i) => `r${i}`).join("\n");
    expect(trimLiveOutput(twenty)).toBe(twenty);
    // 末尾带换行：21 个元素 → 丢掉第一行
    expect(trimLiveOutput(`${twenty}\n`)).toBe(`${twenty.slice(twenty.indexOf("\n") + 1)}\n`);
  });

  it("CRLF 算一个换行、孤立 \\r（进度条）也算换行", () => {
    const crlf = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\r\n");
    const a = trimLiveOutput(crlf);
    expect(a.startsWith("row 30\r\n")).toBe(true);
    expect(a.split(/\r\n|\r|\n/)).toHaveLength(20);

    const progress = Array.from({ length: 100 }, (_, i) => `progress ${i}%`).join("\r");
    const b = trimLiveOutput(progress);
    expect(b.split(/\r\n|\r|\n/)).toHaveLength(20);
    expect(b.startsWith("progress 80%\r")).toBe(true);
    expect(b.endsWith("progress 99%")).toBe(true);
  });

  it("字符数封顶：无换行长文本只留尾部 8192 字符", () => {
    const long = "x".repeat(100_000) + "TAIL";
    const out = trimLiveOutput(long);
    expect(out.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  it("字符数封顶不切开代理对（开头不是孤立的低位代理）", () => {
    // 每个 emoji 2 个码元；末尾多一个 ASCII → 从尾部数 8192 个码元恰好落在一个 emoji 中间（切在低位代理上）
    const s = "😀".repeat(10_000) + "z";
    expect(s.slice(-LIVE_OUTPUT_MAX_CHARS).charCodeAt(0) >= 0xdc00).toBe(true); // 前提：朴素切法确实会切开
    const out = trimLiveOutput(s);
    expect(out.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    const first = out.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(out.endsWith("😀z")).toBe(true);
    // 孤立代理 = 展示成 �；整段不应含孤立代理
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("短文本原样返回（同引用，不白造字符串）", () => {
    const s = "hello\nworld";
    expect(trimLiveOutput(s)).toBe(s);
    expect(trimLiveOutput("")).toBe("");
  });

  it("tool-display 的 trimLiveOutputLines 沿用同一实现（调用方不用改）", () => {
    const long = "y".repeat(50_000);
    expect(trimLiveOutputLines(long).length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    expect(trimLiveOutputLines("a\nb\nc", 2)).toBe("b\nc");
  });
});

describe("reduceLiveToolOutputs：无换行长流缓冲有界（修复前缓冲无界、累计耗时 O(n²)）", () => {
  it("10MB 无换行流（5000 帧 × 2KB）：每一帧之后缓冲都 ≤ 8192 字符、尾部是最新的内容", () => {
    // 不断言累计耗时（R14 Q18-02）：5000 次 expect 本身就占了大头，隔离跑 242ms、CPU 压力下 1.22s 会误红。
    // 「耗时不 O(n²)」由逐帧的长度断言守着：修复前缓冲无界增长（每帧拷贝整段历史才累计 4.5s），第 5 帧就越过 8192、断言当场红。
    let s = {} as Record<string, string>;
    for (let i = 0; i < 5000; i++) {
      const tag = String(i).padStart(5, "0");
      s = reduceLiveToolOutputs(s, delta("a", tag + "x".repeat(2043), i));
      expect(s.a!.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS + 1);
    }
    expect(s.a!.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    expect(s.a!).toContain("04999"); // 最后一帧的标记在窗口内
    expect(s.a!).not.toContain("00000");
  });

  it("单帧超大（10MB 一次性）：缓冲仍有界、不抛", () => {
    const s = reduceLiveToolOutputs({}, delta("a", "z".repeat(10_000_000) + "END"));
    expect(s.a!.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    expect(s.a!.endsWith("END")).toBe(true);
  });

  it("2 万帧 `progress N%\\r`：缓冲有界、行数 ≤ 20、尾行是最新的百分比（不是最早的）", () => {
    let s = {} as Record<string, string>;
    for (let i = 0; i < 20_000; i++) {
      s = reduceLiveToolOutputs(s, delta("a", `progress ${i}%\r`, i));
    }
    const buf = s.a!;
    expect(buf.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    // 末尾带 \r：split 多一个空元素，所以 ≤ 20 个元素
    expect(buf.split(/\r\n|\r|\n/).length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_LINES);
    expect(liveOutputTailLine(buf)).toBe("progress 19999%");
  });

  it("原有语义不回归：按 callId 累积、互不串", () => {
    let s = reduceLiveToolOutputs({}, delta("a", "line1\n"));
    s = reduceLiveToolOutputs(s, delta("b", "other\n"));
    s = reduceLiveToolOutputs(s, delta("a", "line2\n"));
    expect(s).toEqual({ a: "line1\nline2\n", b: "other\n" });
  });
});

describe("liveOutputTailLine：折叠行 / 状态行取的「最新一行」", () => {
  it("取最后一个非空行；\\r 刷新取最后一次刷新的内容", () => {
    expect(liveOutputTailLine("a\nb\n\n")).toBe("b");
    expect(liveOutputTailLine("10%\r20%\r30%")).toBe("30%");
    expect(liveOutputTailLine("x\r\n")).toBe("x");
    expect(liveOutputTailLine("  indented  \n\n  \n")).toBe("indented");
    expect(liveOutputTailLine("")).toBeUndefined();
    expect(liveOutputTailLine(" \n \r ")).toBeUndefined();
  });
});

describe("`\\r` 进度条：状态行 / 折叠行取最新一次刷新，不是最早的", () => {
  it("deriveActiveStatus 的 detail（状态行）取最后一次 \\r 刷新", () => {
    const events: TaskEvent[] = [
      { id: "u", ts: 1, kind: "user_reply", text: "跑一下" },
      {
        id: "call_p",
        ts: 2,
        kind: "tool_call",
        text: "调用 shell",
        meta: { callId: "p", name: "shell", args: JSON.stringify({ command: "curl -# x" }) },
      },
    ];
    const live = { p: "  10%\r  45%\r  99%" };
    const st = deriveActiveStatus(events, live);
    expect(st?.label).toContain("shell");
    expect(st?.detail).toBe("99%");
  });

  it("接线：tool-block 两处折叠 / 子代理条尾行都走 liveOutputTailLine，不再手写 split(\"\\n\")", () => {
    const tb = readFileSync(
      resolve(__dirname, "../src/components/tasks/event-stream/tool-block.tsx"),
      "utf8",
    );
    expect((tb.match(/liveOutputTailLine\(liveOutput\)/g) ?? []).length).toBe(2);
    expect(tb).not.toMatch(/liveOutput\.trim\(\)\.split\("\\n"\)/);
  });
});

describe("sliceLiveOutputTail：服务端 / 客户端共用的字符封顶", () => {
  it("未超限原样返回；超限留尾部；不切开代理对", () => {
    expect(sliceLiveOutputTail("abc", 10)).toBe("abc");
    expect(sliceLiveOutputTail("abcdef", 3)).toBe("def");
    // "😀😀"=4 码元，留 3 → 会落在第一个 emoji 中间 → 丢掉那半个
    expect(sliceLiveOutputTail("😀😀", 3)).toBe("😀");
  });
});

describe("服务端 shell-output-bridge 用同一口径给单帧封顶", () => {
  it("接线：publishChunk 用 sliceLiveOutputTail(LIVE_OUTPUT_MAX_CHARS) 截帧（客户端只留这么多，多发是纯浪费）", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/lib/server/shell-output-bridge.ts"),
      "utf8",
    );
    expect(src).toMatch(/from "@\/lib\/live-output-cap"/);
    expect(src).toMatch(/sliceLiveOutputTail\(chunk, LIVE_OUTPUT_MAX_CHARS\)/);
  });

  it("行为：一次吐 1MB 的 shell 输出，发出去的帧不超过上限，且是尾部", async () => {
    const published: Array<{ chunk: string }> = [];
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../src/lib/server/task-stream", () => ({
      publish: (_taskId: string, frame: { event?: { meta?: { chunk?: string } } }) => {
        if (frame.event?.meta?.chunk != null) published.push({ chunk: frame.event.meta.chunk });
      },
      writeOwnedEventAndPublish: async () => {},
    }));
    const { createShellOutputDeltaPublisher } = await import(
      "../src/lib/server/shell-output-bridge"
    );
    const onDelta = createShellOutputDeltaPublisher("t_live_cap");
    onDelta({
      update: { type: "tool-call-started", callId: "c1", toolCall: { type: "shell" } },
    } as never);
    onDelta({
      update: {
        type: "shell-output-delta",
        event: { case: "stdout", value: { data: "q".repeat(1_000_000) + "THE_END" } },
      },
    } as never);
    onDelta({ update: { type: "tool-call-completed", callId: "c1" } } as never);
    vi.doUnmock("../src/lib/server/task-stream");
    vi.resetModules();
    expect(published.length).toBeGreaterThan(0);
    for (const f of published) expect(f.chunk.length).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
    expect(published.map((f) => f.chunk).join("").endsWith("THE_END")).toBe(true);
  });
});
