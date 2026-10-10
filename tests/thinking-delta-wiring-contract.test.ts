/**
 * thinking_delta 实时帧的链路契约（2026-10-10）
 *
 * 这条链路很长：
 *   sdk-message-handler（预定 eventId、节流发帧）→ task-stream 帧类型 → watch-task SSE 路由
 *   → task-store 解析 → use-task-watch 透传 → chat-view 状态
 *   → event-stream 第三层把它合成一条 thinking 事件并进流尾工作过程组
 *   → 由**已有的思考行**（rows.tsx 的 ProcessEventRow）渲染。
 * **漏任何一环都是静默失效**——最典型：watch-task 路由的 `switch (ev.kind)` 没有 default，
 * 漏写一个 case，帧就被无声丢掉，界面照样「等待模型响应… 已等待 62s」，而所有行为单测都是绿的。
 * UI 行为在 node 环境跑不起来（见 vitest.config.ts），所以跟 event-stream-scroll-contract.test.ts
 * 一样，靠源码契约守住。
 *
 * 行为本身的测试：
 *   tests/thinking-delta-publish.test.ts        服务端节流 / 丢尾巴 / 消音 / eventId 预定与复用
 *   tests/thinking-delta-stream-integration.test.ts  真实发布通路（65s / 1111 条 chunk）
 *   tests/append-event-preset-id.test.ts        真实 appendEvent 尊重预设 id
 *   tests/thinking-delta-dispatch.test.ts       客户端 SSE 分发（缺 id 的帧丢弃）
 *   tests/chat-turns-live-thinking.test.ts      合成事件并入流程、与落盘后同构
 *   tests/thinking-live.test.ts                 前端纯函数 + 状态行推导
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const taskStream = read("lib", "server", "task-stream.ts");
const taskFs = read("lib", "server", "task-fs.ts");
const watchRoute = read("app", "api", "tasks", "[id]", "watch-task", "route.ts");
const taskStore = read("lib", "task-store.ts");
const useTaskWatch = read("hooks", "use-task-watch.ts");
const chatView = read("components", "tasks", "chat-view.tsx");
const eventStream = read("components", "tasks", "event-stream.tsx");
const workGroup = read("components", "tasks", "event-stream", "work-group.tsx");
const rows = read("components", "tasks", "event-stream", "rows.tsx");
const eventUtils = read("components", "tasks", "event-stream", "utils.tsx");
const handler = read("lib", "server", "sdk-message-handler.ts");

/** 从 `marker` 处起按配对符号截出完整片段（只检查某个回调 / useMemo 的内部，而不是整份文件） */
const sliceBalanced = (
  source: string,
  marker: string,
  open: "(" | "{",
): string => {
  const close = open === "(" ? ")" : "}";
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = source.indexOf(open, start + marker.length - 1);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`${marker}\` 的 ${open}${close} 没配平`);
};

describe("thinking_delta 链路：每一环都在（漏一环 = 静默失效）", () => {
  it("帧类型：task-stream 的 TaskStreamEvent 里有 thinking_delta，带 eventId、不带 origin（旁路不发）", () => {
    expect(taskStream).toContain(
      '{ kind: "thinking_delta"; text: string; eventId: string }',
    );
  });

  it("SSE 路由：watch-task 的 switch 转发 thinking_delta 且带 eventId（这个 switch 没有 default，漏了就无声丢帧）", () => {
    expect(watchRoute).toMatch(
      /case "thinking_delta":\s*send\(\{\s*type: "thinking_delta",\s*text: ev\.text,\s*eventId: ev\.eventId,?\s*\}\);/,
    );
  });

  it("客户端解析：task-store 认 thinking_delta 并把 text + eventId 回调给 onThinkingDelta", () => {
    expect(taskStore).toContain('| "thinking_delta"');
    expect(taskStore).toContain('env.type === "thinking_delta"');
    expect(taskStore).toContain("callbacks.onThinkingDelta?.(env.text, env.eventId)");
    // 回调签名带 eventId：漏了的话上层拿不到 id、合成行没法和落盘行对上
    expect(taskStore).toContain("onThinkingDelta?: (text: string, eventId: string) => void;");
  });

  it("hook 透传：use-task-watch 把 text + eventId 一起接到 callbacksRef", () => {
    expect(useTaskWatch).toContain(
      "callbacksRef.current.onThinkingDelta?.(text, eventId)",
    );
    expect(useTaskWatch).toContain(
      "onThinkingDelta?: (text: string, eventId: string) => void;",
    );
  });

  it("chat-view：订阅帧、把状态传给 EventStream", () => {
    expect(chatView).toContain("onThinkingDelta: pushThinkingDelta");
    expect(chatView).toContain("liveThinking={thinkingLive}");
  });
});

describe("服务端发送口径：只给属主主链、思考段结束必须丢尾巴、落盘复用预定的 id", () => {
  it("思考分支：旁路答疑（origin）/ 已提问消音（askSeen）不发实时帧、也不预定 id；预定在入队之前", () => {
    const thinkingBranch = sliceBalanced(handler, 'case "thinking": {', "{");
    expect(thinkingBranch).toMatch(
      /if \(!origin && !assistantCtx\.askSeen\) \{[\s\S]*?assistantCtx\.thinkingEventId \?\?= newEventId\(\);[\s\S]*?enqueueThinkingDelta\(\s*taskId,\s*stillCurrent,\s*chunk,\s*assistantCtx\.thinkingEventId,?\s*\);/,
    );
  });

  it("入口：任何非 thinking 消息到来都丢掉没发的尾巴（否则实时帧可能晚于落盘事件到达、复活「思考中」）", () => {
    expect(handler).toContain(
      'if (msg.type !== "thinking") discardPendingThinkingDeltas(taskId);',
    );
  });

  it("flushThinkingBuffer：开头就丢尾巴，且在 `!text` 早退之前（run 结束路径也要清定时器）", () => {
    const bodyStart = handler.indexOf("export const flushThinkingBuffer = async (");
    expect(bodyStart, "找不到 flushThinkingBuffer").toBeGreaterThanOrEqual(0);
    // 函数很短，截一段足够覆盖到早退那一行
    const body = handler.slice(bodyStart, bodyStart + 1800);
    const discardAt = body.indexOf("discardPendingThinkingDeltas(taskId)");
    const earlyReturnAt = body.indexOf("if (!text) return;");
    expect(discardAt).toBeGreaterThanOrEqual(0);
    expect(earlyReturnAt).toBeGreaterThan(discardAt);
  });

  it("flushThinkingBuffer：预定的 id 在早退 / lease 检查之前取走并清零（空段、失主都不能把 id 漏给下一段），落盘时复用", () => {
    const bodyStart = handler.indexOf("export const flushThinkingBuffer = async (");
    const body = handler.slice(bodyStart, bodyStart + 1800);
    const takeAt = body.indexOf("const eventId = ctx.thinkingEventId;");
    const clearAt = body.indexOf("ctx.thinkingEventId = undefined;");
    const earlyReturnAt = body.indexOf("if (!text) return;");
    const leaseAt = body.indexOf("if (!lease()) return;");
    expect(takeAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(takeAt).toBeLessThan(earlyReturnAt);
    expect(clearAt).toBeLessThan(earlyReturnAt);
    expect(clearAt).toBeLessThan(leaseAt);
    // 落盘事件带上预定 id（没发过帧的路径没有它，由 appendEvent 现生成）
    expect(body).toContain("...(eventId ? { id: eventId } : {})");
  });

  it("预定的 id 放在每路 run 自己的 ctx 里，不放按 taskId 共享的节流状态（旁路 flush 才取不走主链的 id）", () => {
    const ctxStart = handler.indexOf("export interface AssistantBufferCtx {");
    expect(ctxStart).toBeGreaterThanOrEqual(0);
    expect(handler.slice(ctxStart, ctxStart + 2500)).toContain("thinkingEventId?: string;");
  });

  it("appendEvent 尊重预设 id：先拆出再 spread（显式 undefined 不覆盖），缺省 / 空串才现生成", () => {
    expect(taskFs).toContain("const { id: presetId, ...rest } = ev;");
    expect(taskFs).toContain("id: presetId || newEventId(),");
  });
});

describe("chat-view 清理时机：落盘事件 / 正文 / 结束都要清「思考中」", () => {
  it("onEvent：在 ephemeral 早退之后清（落盘事件 = 这段思考有了正式内容或新一轮开始）", () => {
    const onEvent = sliceBalanced(chatView, "onEvent: (ev) => {", "{");
    const ephemeralAt = onEvent.indexOf("if (isEphemeralToolOutputDelta(ev)) return;");
    const clearAt = onEvent.indexOf("clearThinkingLive();");
    expect(ephemeralAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(ephemeralAt);
  });

  it("onEvent：清实时态与追加落盘事件在同一个同步回调里、且清在前（同批渲染 → 合成行直接换成同 id 的落盘行，没有空档）", () => {
    const onEvent = sliceBalanced(chatView, "onEvent: (ev) => {", "{");
    const clearAt = onEvent.indexOf("clearThinkingLive();");
    const appendAt = onEvent.indexOf("onEventAppendRef.current(ev);");
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(appendAt).toBeGreaterThan(clearAt);
    // 两者之间不能有 await——一旦隔着异步，React 就可能把它们拆成两次渲染、中间闪一帧空档
    expect(onEvent.slice(clearAt, appendAt)).not.toContain("await ");
  });

  it("onAssistantDelta：先清思考、再拼正文（正文开始流 = 思考结束）", () => {
    const onDelta = sliceBalanced(chatView, "onAssistantDelta: (text) => {", "{");
    const clearAt = onDelta.indexOf("clearThinkingLive();");
    const pushAt = onDelta.indexOf("pushDelta(text);");
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeGreaterThan(clearAt);
  });

  it("onDone / onTaskDeleted / 停止 / 切任务：都清（否则下一轮开头会闪出上一轮的「思考中」）", () => {
    expect(sliceBalanced(chatView, "onDone: (t) => {", "{")).toContain(
      "clearThinkingLive();",
    );
    expect(sliceBalanced(chatView, "onTaskDeleted: (deletedId) => {", "{")).toContain(
      "clearThinkingLive();",
    );
    expect(
      sliceBalanced(chatView, "const stopAgentCore = useCallback(", "("),
    ).toContain("clearThinkingLive();");
    // 切任务的 effect：依赖数组（task.id + clearThinkingLive）所属的那个 useEffect，体里必须真调用。
    // 只在依赖数组里列着、体里没调用 = 没清——否则 A 任务正在思考时切到正在跑的 B，
    // B 的流尾会挂着 A 的思考文本。（变异验证里这条最初只检查依赖数组，被漏过一次）
    const depsAt = chatView.indexOf(
      "[task.id, applyLedgerToUi, clearStreaming, clearThinkingLive]",
    );
    expect(depsAt).toBeGreaterThanOrEqual(0);
    const effectStart = chatView.lastIndexOf("useEffect(", depsAt);
    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(chatView.slice(effectStart, depsAt)).toContain("clearThinkingLive();");
  });
});

describe("chat-view 状态：段 id + 累积原文 + 起点时刻", () => {
  it("state 是 LiveThinking（id + text + since）；同一段（id 相同）才累积，id 变了 = 新的一段、不接在上一段后面", () => {
    expect(chatView).toContain("useState<LiveThinking | null>(null)");
    expect(chatView).toContain(
      "const pushThinkingDelta = useCallback((text: string, id: string) => {",
    );
    expect(chatView).toContain("const sameSegment = prev !== null && prev.id === id;");
    expect(chatView).toContain(
      'appendThinkingText(sameSegment ? prev.text : "", text)',
    );
    // 起点只在本段首帧取一次，同一段内不变（合成事件的 ts）
    expect(chatView).toContain("since: sameSegment ? prev.since : Date.now()");
  });
});

describe("展示：思考是流程里一条真正的 thinking 行，由已有的思考行渲染", () => {
  const itemsMemo = () =>
    sliceBalanced(eventStream, "const items: RenderItem[] = useMemo", "(");

  it("事件流第三层：合成并入流尾工作过程组；正文已在流时不当思考态；依赖里有 liveThinking", () => {
    const memo = itemsMemo();
    expect(memo).toContain(
      "const live = isChat && isRunning && !streamingText ? liveThinking : null;",
    );
    expect(memo).toContain("attachLiveThinking(orderedItems, live)");
    // 漏了依赖：流尾不会随实时帧刷新、思考原文冻在第一帧
    expect(memo).toMatch(/displayedBoot,\s*liveThinking,\s*\]/);
  });

  it("流程里已有「正在思考」这一行就不再叠启动阶段行 / 「等待模型响应…」（在 boot 与 loading 两个分支之前返回）", () => {
    const memo = itemsMemo();
    const liveReturnAt = memo.indexOf("if (live) return withPending;");
    const bootAt = memo.indexOf("if (isChat && displayedBoot)");
    const loadingAt = memo.indexOf("shouldShowSendLoading(");
    expect(liveReturnAt).toBeGreaterThanOrEqual(0);
    expect(bootAt).toBeGreaterThan(liveReturnAt);
    expect(loadingAt).toBeGreaterThan(liveReturnAt);
  });

  it("工作过程组折叠时：组头也说「思考中 · 最近一行」（别让用户把收起的组当成卡住），优先于「最近在跑的工具名」", () => {
    const body = sliceBalanced(workGroup, "if (!expanded) {", "{");
    expect(body).toContain("isLiveThinkingEvent(tailMember)");
    expect(body).toContain("thinkingTextToLine(tailMember.text)");
    // 文案模板本身：「思考中 · 最近一行」（光有 THINKING_LIVE_LABEL 出现在别处挡不住改成只显示最近一行）
    expect(body).toContain("`${THINKING_LIVE_LABEL} · ${line}`");
    expect(body.indexOf("isLiveThinkingEvent(tailMember)")).toBeLessThan(
      body.indexOf("group.hasRunning"),
    );
  });

  it("已有的思考行（ProcessEventRow）：进行中多一个转圈，且在耗时之前；进行中不显示耗时", () => {
    expect(rows).toContain("const isLive = isLiveThinkingMeta(ev);");
    // 耗时落盘后才有；并进已落盘思考行时 meta 里是上一段的耗时，显示会误导
    expect(rows).toContain(
      "isThinking && !isLive ? formatDurationPrecise(ev.meta?.durationMs) : null",
    );
    expect(rows).toMatch(
      /\{isLive && \(\s*<Loader2 className="size-3 shrink-0 animate-spin text-info" \/>\s*\)\}/,
    );
    expect(rows.indexOf("{isLive && (")).toBeLessThan(
      rows.indexOf("{thinkingDuration && ("),
    );
  });

  it("已有的思考行：进行中折叠摘要取最新一行（summarize 取开头，长思考整段不动、像卡死）", () => {
    expect(rows).toMatch(
      /const summary = isLiveThinkingMeta\(ev\)\s*\?\s*thinkingTextToLine\(ev\.text\)/,
    );
  });

  it("已有的思考行：进行中原文被截掉前面时，展开区顶部提示", () => {
    expect(rows).toContain("isLive && ev.meta?.liveTruncated === true");
  });

  it("默认折叠：思考不在 DEFAULT_EXPANDED_KINDS 里——进行中的思考和落盘后的思考行一样默认收起、点开才看全文", () => {
    const m = eventUtils.match(
      /DEFAULT_EXPANDED_KINDS: ReadonlySet<EventKind> = new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m, "找不到 DEFAULT_EXPANDED_KINDS").not.toBeNull();
    expect(m![1]).not.toContain('"thinking"');
  });

  it("状态行：deriveActiveStatus 吃从原文派生的最近一行，且它在 memo 依赖里（漏了就一直是旧文案）", () => {
    expect(eventStream).toContain("thinkingTextToLine(liveThinking.text)");
    const activeStatus = sliceBalanced(
      eventStream,
      "const activeStatus = useMemo",
      "(",
    );
    expect(activeStatus).toContain("thinking: thinkingLine");
    expect(activeStatus).toMatch(/streamingText,\s*thinkingLine,\s*\]/);
    // 既有契约不能破：状态行仍吃本轮切片、不挂全量 task.events
    expect(activeStatus).toContain("statusEvents");
    expect(activeStatus).not.toContain("task.events");
  });

  it("启动阶段行：思考一开始就让位（冷续聊的「正在发送…」不能挂满整段思考）；依赖用布尔、不用整个对象", () => {
    const activeBoot = sliceBalanced(eventStream, "const activeBoot = useMemo", "(");
    // 判定本身：有进行中的思考就是 true（写死 false 的话启动行永远不让位、照样挂满整段思考）
    expect(eventStream).toContain("const isThinkingLive = liveThinking != null;");
    expect(activeBoot).toContain("isChat && !isThinkingLive");
    expect(activeBoot).toContain("isThinkingLive");
    expect(activeBoot).not.toMatch(/\bliveThinking\b/);
  });

  it("不能两套并存：不再有单独的进行中组件，等待行 / 占位行也不自带思考分支（思考只在流程里展示一次）", () => {
    // 单独组件已删：进行中的思考就是已有的思考行
    expect(
      existsSync(path.join(srcDir, "components", "tasks", "event-stream", "live-thinking-row.tsx")),
    ).toBe(false);
    expect(eventStream).not.toContain("LiveThinkingStepRow");
    expect(workGroup).not.toContain("LiveThinkingStepRow");
    expect(workGroup).not.toContain("live-thinking-row");
    // 旧的壳字段已没有：进行中的思考是 members 里的一个成员，不是壳上的附加物
    expect(workGroup).not.toContain("group.liveThinking");

    expect(eventStream).toContain("<PendingRow />");
    expect(eventStream).not.toContain("<PendingRow thinking");
    expect(eventStream).not.toContain("thinkingLine={");
    expect(workGroup).not.toContain("thinkingLine");
    expect(workGroup).toContain("const ProcessingPlaceholderRow = () => (");
  });
});
