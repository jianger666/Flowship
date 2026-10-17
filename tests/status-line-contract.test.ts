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
const toolBlock = read("components", "tasks", "event-stream", "tool-block.tsx");
const skipWaitButton = read(
  "components",
  "tasks",
  "event-stream",
  "skip-wait-button.tsx",
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
      "<ConversationComposer",
    );
    // 状态行本身仍受 activeStatus 门控；2026-10 起多挂了「跳过等待」回调（wait 工具在跑时才出按钮）
    expect(renderSide).toMatch(
      /\{activeStatus && \(\s*<ActiveStatusLine\s+status=\{activeStatus\}\s+onSkipWait=\{handleSkipWait\}\s*\/>\s*\)\}/,
    );
  });

  it("「跳过等待」：回调走 skipWait（不是 stop）、失败 toast；按钮只在 skippable 且有回调时画", () => {
    // 回调：叫醒 wait，不是停止整个 run——run 的上下文和后续步骤都要还在
    const handler = between(
      eventStream,
      "const handleSkipWait = useCallback(",
      "const attachScrollerRef",
    );
    expect(handler).toContain("await skipWait(taskIdForSkip)");
    expect(handler).not.toMatch(/stopTask|\/stop/);
    expect(handler).toContain("toast.error");
    // 按钮：两个条件缺一不可（只有 skippable 没回调 = 没人响应；反过来 = 非 wait 步骤也出按钮）
    expect(statusLine).toMatch(/status\.skippable && onSkipWait \?/);
    expect(statusLine).toContain("跳过等待");
    // 点击后禁用、处理完恢复（别让人连点出一串请求）
    expect(statusLine).toMatch(/disabled=\{skipping\}/);
  });

  it("task 形态没有状态行：「跳过等待」也挂在 wait 的工具块上（两种形态都渲染工具块）", () => {
    // 前提：task 形态确实不画状态行——否则这个入口就是多余的
    expect(eventStream).toContain("{hideReplyComposer || !isChat ? null : (");
    const regular = between(toolBlock, "const RegularToolBlockRow = (", "const TodoToolBlock");
    // 条件走共用判定（与状态行的 skippable 同口径：wait 且在跑）
    expect(regular).toContain("isSkippableWaitBlock(block)");
    const buttonAt = regular.indexOf("<SkipWaitButton taskId={taskId} />");
    expect(buttonAt, "工具块里没挂 SkipWaitButton").toBeGreaterThan(0);
    // 不能挂进折叠体里：折叠时（wait 默认折叠）也得看得见——否则 task 里还是没有入口
    const bodyAt = regular.search(/<Collapse open=\{!collapsed\}>/);
    expect(bodyAt, "找不到工具块的折叠体").toBeGreaterThan(0);
    expect(buttonAt).toBeLessThan(bodyAt);
    // 不能塞进标题 <button> 里：按钮套按钮不合法，点击还会冒泡成折叠 / 展开
    const headerEnd = regular.indexOf("</button>");
    expect(headerEnd).toBeGreaterThan(0);
    expect(buttonAt).toBeGreaterThan(headerEnd);
  });

  it("工具块的按钮走 skipWait（不是 stop）、失败 toast、点了就禁用", () => {
    expect(skipWaitButton).toContain("await skipWait(taskId)");
    expect(skipWaitButton).not.toMatch(/stopTask|\/stop/);
    expect(skipWaitButton).toContain("toast.error");
    expect(skipWaitButton).toMatch(/disabled=\{skipping\}/);
    expect(skipWaitButton).toContain("跳过等待");
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
    // 槽位 className：运行期间 h-7、其余 h-0，且带高度过渡（2026-10-17：run 结束这 28px 一帧消失，
    // 跟吐字收尾 / 工作过程组收起撞在同一帧 = 「完成后抖一下」）
    const slotStart = eventStream.indexOf(
      'reserveStatusSlot ? "h-7" : "h-0"',
    );
    expect(slotStart).toBeGreaterThan(0);
    const slotHead = eventStream.slice(Math.max(0, slotStart - 700), slotStart);
    expect(slotHead).toContain("transition-[height]");
    expect(slotHead).toContain("overflow-hidden");
    expect(slotHead).toContain("motion-reduce:transition-none");
    // 状态行自己的根节点高度
    expect(statusLine).toMatch(/<div className="flex h-7 min-w-0 items-center/);
    // 槽位包着它（而不是兄弟节点）：槽位 div 的第一个 `</div>` 必须在状态行之后
    const slot = between(
      eventStream,
      'reserveStatusSlot ? "h-7" : "h-0"',
      "<ConversationComposer",
    );
    expect(slot).toContain("<ActiveStatusLine");
    expect(slot.indexOf("<ActiveStatusLine")).toBeLessThan(slot.indexOf("</div>"));
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

describe("静默兜底：SDK 里不可见的等待（Cursor 原生 await 的 sleep）不能让状态行静态 / 说错话", () => {
  const stalledHook = between(
    statusLine,
    "const useStalled",
    "const useElapsedMs",
  );

  it("event-stream 把「整个任务最后一条事件的 ts」作为原始数值传给 deriveActiveStatus，且在 memo 外算、在依赖里", () => {
    // 在 memo 外算：memo 里不许碰全量事件列表（见 event-stream-scroll-contract 的性能闸）
    expect(eventStream).toContain("const lastEventTs = latestEventTs(task.events);");
    const memo = between(
      eventStream,
      "const activeStatus = useMemo",
      "const statusLineVisible",
    );
    // 漏传 = 状态行永远不兜底、回到睡觉时静态说「思考中」
    expect(memo).toContain("lastActivityTs: lastEventTs,");
    // 漏了依赖：来了新事件锚点不更新、状态行拿旧锚点算「已等待」
    expect(memo).toMatch(/statusEvents,\s*lastEventTs,\s*awaitingAsk,\s*liveToolOutputs,/);
  });

  it("有未答提问时不兜底：把 awaitingAsk 传给 deriveActiveStatus（漏传 = 等人答题 20s 后状态行改口「仍在等待」、像卡住）", () => {
    const memo = between(
      eventStream,
      "const activeStatus = useMemo",
      "const statusLineVisible",
    );
    expect(memo).toContain("awaitingUser: awaitingAsk,");
  });

  it("只起一次 setTimeout（不是 interval）、卸载 / 换锚点必清；effect 依赖是 [stallSinceTs]", () => {
    expect(stalledHook).toContain("window.setTimeout(");
    expect(stalledHook).not.toContain("setInterval");
    expect(stalledHook).toMatch(/return \(\) => window\.clearTimeout\(id\);/);
    expect(stalledHook).toMatch(/\},\s*\[stallSinceTs\],?\s*\);/);
  });

  it("已经静默够久（remaining ≤ 0）要立刻改口，不能排一个负延迟的定时器", () => {
    expect(stalledHook).toMatch(
      /if \(remaining <= 0\) \{\s*setStalledFor\(stallSinceTs\);\s*return;\s*\}/,
    );
  });

  it("状态存的是「哪个锚点已经够久」、不是布尔：新事件换了锚点的那一帧旧的「仍在等待」立刻失效、不闪", () => {
    expect(stalledHook).toContain("useState<number | undefined>(undefined)");
    expect(stalledHook).toContain(
      "return stallSinceTs !== undefined && stalledFor === stallSinceTs;",
    );
  });

  it("组件：够久 → 换成 stallFallbackStatus；走字起点跟着换后的 status（仍由 useElapsedMs 一处计时）", () => {
    const component = between(
      statusLine,
      "export const ActiveStatusLine",
      "return (",
    );
    expect(component).toContain("useStalled(base.stallSinceTs)");
    expect(component).toContain("stallFallbackStatus(base.stallSinceTs)");
    // 计时只有一处：用换后的 status.sinceTs，不是 base 的
    expect(component).toContain("useElapsedMs(status.sinceTs)");
    expect(statusLine).toMatch(
      /import \{[^}]*\bmsUntilStall\b[^}]*\bstallFallbackStatus\b[^}]*\} from "@\/lib\/chat-turns";|import \{[^}]*\bstallFallbackStatus\b[^}]*\bmsUntilStall\b[^}]*\} from "@\/lib\/chat-turns";/,
    );
  });
});
