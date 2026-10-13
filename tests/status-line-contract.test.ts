/**
 * 状态行「去重复 + 带工具名与已等待秒数」的源码契约闸（Bug 记录 #5「处理中…」）
 *
 * 纯函数部分（label / sinceTs 派生、3s 门槛格式化、组尾让位判定）在 tests/chat-turns.test.ts；
 * 这里只守 node 环境跑不起来的两处接线。它们改坏了既不会有类型错误、也不会让任何纯函数测试变红：
 *   1. event-stream.tsx 把「状态行这一帧画不画」传给了组尾判定
 *      （漏了 = 回到输入框上方一个「处理中…」、工作过程组尾又一个「处理中…」）
 *   2. active-status-line.tsx 的走字定时器：只在有 sinceTs 时起、随 sinceTs 重启、卸载必清
 *      （漏 clearInterval = 每切一次状态泄漏一个 1s 定时器；依赖数组写成空 = 状态从「无计时」
 *      切到「有计时」时定时器不重启、数字冻在第一帧）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const eventStream = read("components", "tasks", "event-stream.tsx");
const workGroup = read("components", "tasks", "event-stream", "work-group.tsx");
const statusLine = read(
  "components",
  "tasks",
  "event-stream",
  "active-status-line.tsx",
);

/** 取 `from` 与 `to` 两个标记之间的源码（含 from、不含 to） */
const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, `源码里找不到 \`${from}\``).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `\`${from}\` 之后找不到 \`${to}\``).toBeGreaterThan(start);
  return source.slice(start, end);
};

/** 从 marker（以 `{` 结尾）起按花括号配对截出完整对象字面量 */
const sliceObjectLiteral = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = start + marker.length - 1;
  expect(source[from]).toBe("{");
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的花括号没配平`);
};

describe("组尾「处理中…」让位给输入框上方的状态行", () => {
  it("statusLineVisible 与状态行的渲染条件同口径：没隐藏输入区 && 有 activeStatus", () => {
    expect(eventStream).toContain(
      "const statusLineVisible = !hideReplyComposer && !!activeStatus;",
    );
    // 渲染侧的条件：隐藏输入区（task 形态）整块不画；否则有 activeStatus 才画状态行
    const renderSide = between(
      eventStream,
      "{hideReplyComposer || !isChat ? null : (",
      "<SuspectStuckHint",
    );
    expect(renderSide).toContain(
      "{activeStatus && <ActiveStatusLine status={activeStatus} />}",
    );
  });

  it("组尾判定拿到了 statusLineVisible（漏传 = 判定函数永远当「没有状态行」、两处都画）", () => {
    const call = sliceObjectLiteral(
      eventStream,
      "shouldShowProcessingPlaceholder({",
    );
    expect(call).toMatch(/\bstatusLineVisible\b/);
  });

  it("task 形态没有状态行，组尾兜底这条路还在（work-group 仍按 showProcessingPlaceholder 渲染）", () => {
    expect(workGroup).toContain("showProcessingPlaceholder");
  });
});

describe("状态行槽位：运行期间始终预留，状态行出没不带着输入框上下跳", () => {
  it("预留条件：chat 形态下 运行中 / 刚按回车（占位还在飞）/ 提交中 都预留；非 chat 不预留", () => {
    expect(eventStream).toContain(
      "const reserveStatusSlot = isChat && (isRunning || hasInflight || !!submitting);",
    );
  });

  it("槽位是状态行的外层容器；预留高度与状态行自己的高度同为 h-7（不一致 = 状态行一出现输入框就跳）", () => {
    expect(eventStream).toContain(
      '<div className={reserveStatusSlot ? "h-7" : undefined}>',
    );
    // 状态行自己的根节点高度
    expect(statusLine).toMatch(/<div className="flex h-7 min-w-0 items-center/);
    // 槽位包着它（而不是兄弟节点）
    const slot = between(
      eventStream,
      '<div className={reserveStatusSlot ? "h-7" : undefined}>',
      "<SuspectStuckHint",
    );
    expect(slot).toContain("<ActiveStatusLine");
  });

  it("预留的是「状态行」这一行，不是疑似卡住提示（后者按需出现、不预留）", () => {
    const slot = between(
      eventStream,
      '<div className={reserveStatusSlot ? "h-7" : undefined}>',
      "<ConversationComposer",
    );
    // 槽位 div 先闭合、SuspectStuckHint 才开始
    expect(slot.indexOf("</div>")).toBeGreaterThan(-1);
    expect(slot.indexOf("</div>")).toBeLessThan(slot.indexOf("<SuspectStuckHint"));
  });
});

describe("状态行「已等待」走字定时器", () => {
  const hook = between(
    statusLine,
    "const useElapsedMs",
    "export const ActiveStatusLine",
  );

  it("没有 sinceTs 就不起定时器（启动 / 思考 / 回复 / 压缩阶段整个组件仍是纯展示）", () => {
    const guard = hook.indexOf("if (sinceTs === undefined) return;");
    const start = hook.indexOf("window.setInterval(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(guard);
    // 返回值也同口径：没有起点就返回 null（调用方据此不渲染秒数）
    expect(hook).toContain("sinceTs === undefined ? null");
  });

  it("卸载 / 换起点必清定时器（漏了 = 每切一次状态泄漏一个 1s 定时器）", () => {
    expect(hook).toMatch(/return \(\) => window\.clearInterval\(id\);/);
  });

  it("effect 依赖是 [sinceTs]：从「无计时」切到「有计时」、或换了一步，定时器要重启", () => {
    expect(hook).toMatch(/\},\s*\[sinceTs\],?\s*\);/);
  });

  it("组件吃 status.sinceTs、按 3s 门槛格式化（formatStatusElapsed 来自纯函数层，不在组件里另写口径）", () => {
    expect(statusLine).toContain("useElapsedMs(status.sinceTs)");
    expect(statusLine).toContain("formatStatusElapsed(elapsedMs)");
    expect(statusLine).toMatch(
      /import \{[^}]*\bformatStatusElapsed\b[^}]*\} from "@\/lib\/chat-turns";/,
    );
  });

  it("秒数是 label 的兄弟节点、不在 shimmer 渐变文字里；数字等宽（逐秒走字不抖 detail）", () => {
    // label span 先闭合、再是秒数 span
    expect(statusLine).toMatch(/\{status\.label\}\s*<\/span>\s*\{elapsed \?/);
    const elapsedSpan = between(statusLine, "{elapsed ? (", "{status.detail ?");
    expect(elapsedSpan).toContain("tabular-nums");
    expect(elapsedSpan).toContain("shrink-0");
  });
});
