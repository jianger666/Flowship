/**
 * R7-04：服务端 `truncate` 在 500 / 4000 字符处可能切开代理对（emoji）→ 前端从截断 args 里抠出的命令 / 路径尾部
 * 带一个孤立高位代理，渲染成「�」。抠值时丢掉末尾半个代理对。
 *
 * R7-05：shell 的预览是「头 + 尾」（报错 / 汇总在尾部），但只有点了「加载完整输出」后输出框才滚到底；
 * 截断的预览本身停在最顶，用户得先滚过一大段噪声头。预览被截断时（`result.truncated`）也滚到底。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  shouldScrollOutputToEnd,
  toolBlockArgsTruncatedHint,
  toolBlockDetailLine,
  toolBlockSummary,
  type ToolBlock,
} from "../src/lib/tool-display";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const shellBlock = (args: string, extra: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: "__tool_block__",
  id: "b1",
  callId: "c1",
  name: "shell",
  status: "running",
  text: "调用 shell",
  args,
  ts: 1,
  ...extra,
});

describe("R7-04：截断 args 的命令尾部不留孤立代理", () => {
  // 构造：命令里有 emoji，截断点正好落在它的两个码元之间
  const buildTruncated = (): { args: string; cutAt: number } => {
    const prefix = JSON.stringify({ command: "echo " + "a".repeat(40) + "😀😀😀" }).slice(0, -2);
    // prefix 形如 {"command":"echo aaa…😀😀😀（去掉了收尾的 "} ）；在第一个 emoji 的中间切
    const emojiStart = prefix.indexOf("😀");
    const cutAt = emojiStart + 1; // 只留高位代理
    return { args: `${prefix.slice(0, cutAt)}…(truncated 99 chars)`, cutAt };
  };

  it("前提：构造的 args 末尾确实是孤立高位代理", () => {
    const { args } = buildTruncated();
    const body = args.replace(/…\(truncated \d+ chars\)$/, "");
    expect(LONE_SURROGATE.test(body)).toBe(true);
  });

  it("摘要行 / 展开命令行都不含孤立代理，且命令主体仍在", () => {
    const { args } = buildTruncated();
    const b = shellBlock(args);
    const summary = toolBlockSummary(b);
    const detail = toolBlockDetailLine(b) ?? "";
    expect(summary).toContain("echo aaaa");
    expect(LONE_SURROGATE.test(summary), JSON.stringify(summary)).toBe(false);
    expect(LONE_SURROGATE.test(detail), JSON.stringify(detail)).toBe(false);
    // 仍然提示「命令过长已截断」
    expect(toolBlockArgsTruncatedHint(b)).toBe("命令过长已截断");
  });

  it("切在完整代理对之后 / 普通 ASCII 处：不动", () => {
    const full = JSON.stringify({ command: "echo 😀 done " + "z".repeat(50) });
    const args = `${full.slice(0, 30)}…(truncated 5 chars)`;
    const s = toolBlockSummary(shellBlock(args));
    expect(LONE_SURROGATE.test(s)).toBe(false);
    expect(s).toContain("😀");
  });

  it("随机截断点 fuzz（含 emoji 的命令，逐字符截断）：摘要从不出现孤立代理", () => {
    const full = JSON.stringify({ command: "run 😀x👍y🎉 " + "k".repeat(20) + " end", cwd: "/tmp" });
    for (let cut = 12; cut < full.length; cut++) {
      const args = `${full.slice(0, cut)}…(truncated ${full.length - cut} chars)`;
      const b = shellBlock(args);
      const s = toolBlockSummary(b);
      const d = toolBlockDetailLine(b) ?? "";
      expect(LONE_SURROGATE.test(s), `cut=${cut} summary=${JSON.stringify(s)}`).toBe(false);
      expect(LONE_SURROGATE.test(d), `cut=${cut} detail=${JSON.stringify(d)}`).toBe(false);
    }
  });
});

describe("R7-05：shell 的截断预览本身也滚到底（尾部才有报错 / 汇总）", () => {
  const resultOf = (truncated: boolean): ToolBlock["result"] => ({
    callId: "c1",
    name: "shell",
    status: "error",
    output: "head…tail",
    truncated,
  });

  it("shell + 预览被截断 → 滚到底；没截断且没加载全量 → 不滚（短输出本来就没滚动条）", () => {
    expect(shouldScrollOutputToEnd(shellBlock("{}", { status: "error", result: resultOf(true) }), false)).toBe(true);
    expect(shouldScrollOutputToEnd(shellBlock("{}", { status: "success", result: resultOf(false) }), false)).toBe(false);
  });

  it("shell + 已加载全量 → 滚到底（原有行为不回归）", () => {
    expect(shouldScrollOutputToEnd(shellBlock("{}", { status: "success", result: resultOf(false) }), true)).toBe(true);
  });

  it("非 shell（read / grep / edit …）：预览是头部，截断了也不滚", () => {
    for (const name of ["read", "grep", "glob", "edit", "write", "mcp:a:b"]) {
      const b = shellBlock("{}", { name, status: "success", result: { ...resultOf(true), name } as ToolBlock["result"] });
      expect(shouldScrollOutputToEnd(b, false), name).toBe(false);
      expect(shouldScrollOutputToEnd(b, true), name).toBe(false);
    }
  });

  it("运行中（还没有 result、直播输出）→ 不滚（直播框自己的行为不动）", () => {
    expect(shouldScrollOutputToEnd(shellBlock("{}"), false)).toBe(false);
  });

  it("接线：<pre> 的 ref 回调用 shouldScrollOutputToEnd 的结果；预览截断 / 全量到手任一变化都会重新触发滚动", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/components/tasks/event-stream/tool-block.tsx"),
      "utf8",
    );
    expect(src).toMatch(/const scrollOutputToEnd = shouldScrollOutputToEnd\(block, hasFullText\);/);
    expect(src).toMatch(
      /const fullOutputRef = useCallback\(\s*\(el: HTMLPreElement \| null\) => \{\s*if \(el && scrollOutputToEnd\) el\.scrollTop = el\.scrollHeight;\s*\},\s*\[hasFullText, scrollOutputToEnd\],\s*\);/,
    );
  });
});
