/**
 * U3a-06 尾巴：点「加载完整输出」后，shell 的输出框要滚到底。
 *
 * 上一波已经把 shell 的预览改成「头 + 尾」（服务端 previewModeFor）：报错 / 汇总在尾巴里。
 * 但点「加载完整输出」把全文换进 <pre> 后，滚动位置停在最顶，用户得自己拖到底才看到尾巴。
 *
 * 只有 shell 滚：read / grep 等是「头部」预览，要看的是文件 / 结果开头，滚到底反而丢上下文。
 * ⚠️ 滚动本身（ref 回调里写 scrollTop）没有在浏览器里看过，这里只验：判定函数 + 接线结构。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shouldScrollFullOutputToEnd } from "../src/lib/tool-display";

describe("shouldScrollFullOutputToEnd", () => {
  it("shell（不分大小写）滚到底", () => {
    expect(shouldScrollFullOutputToEnd({ name: "shell" })).toBe(true);
    expect(shouldScrollFullOutputToEnd({ name: "Shell" })).toBe(true);
  });

  it("read / grep / glob / edit / mcp 工具不滚（头部预览，看的是开头）", () => {
    for (const name of ["read", "grep", "glob", "edit", "write", "task", "mcp:foo:bar"]) {
      expect(shouldScrollFullOutputToEnd({ name }), name).toBe(false);
    }
  });
});

describe("tool-block.tsx 接线（源码契约）", () => {
  const SRC = readFileSync(
    path.join(__dirname, "../src/components/tasks/event-stream/tool-block.tsx"),
    "utf8",
  );

  it("输出框 <pre> 挂 ref 回调，回调里只在「该滚（shell + 截断预览 / 已加载全量）」时才写 scrollTop", () => {
    expect(SRC).toMatch(/<pre\s+ref=\{fullOutputRef\}/);
    // R7-05：判定改走 shouldScrollOutputToEnd(block, hasFullText)（截断的预览也滚到底）；细节见 tests/tool-args-truncation.test.ts
    expect(SRC).toMatch(
      /const fullOutputRef = useCallback\(\s*\(el: HTMLPreElement \| null\) => \{\s*if \(el && scrollOutputToEnd\) el\.scrollTop = el\.scrollHeight;\s*\},\s*\[hasFullText, scrollOutputToEnd\],\s*\);/,
    );
    expect(SRC).toMatch(/const scrollOutputToEnd = shouldScrollOutputToEnd\(block, hasFullText\);/);
  });

  it("回调身份只依赖「有没有全量 / 要不要滚」：不依赖 fullText 本身或 displayOutput，流式 / 重渲染不会反复把用户拖到底", () => {
    const m = SRC.match(
      /const fullOutputRef = useCallback\([\s\S]*?\},\s*\[([^\]]*)\],\s*\);/,
    );
    expect(m, "找不到 fullOutputRef 的 useCallback").not.toBeNull();
    const deps = m![1]!.split(",").map((s) => s.trim());
    expect(deps).toEqual(["hasFullText", "scrollOutputToEnd"]);
  });
});
