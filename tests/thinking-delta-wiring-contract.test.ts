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
 *   tests/chat-turns-live-thinking.test.ts      合成事件并入流程、与落盘后同构；事件行折叠态
 *   tests/thinking-live.test.ts                 前端纯函数（累积 / 累计坐标 / 吐字切片）+ 状态行推导
 *   tests/smooth-reveal.test.ts                 匀速吐字算法（含 250ms 批量到达的模拟）
 *   tests/thinking-smooth-ui-contract.test.ts   平滑 hook / 实时文本区组件的接线契约
 *
 * 2026-10-13 起多一条「快照」支链（重连 / 重挂不从头吐）：
 *   sdk-message-handler（已发出的原文窗口 → getLiveThinkingSnapshot）→ watch-task 路由（订阅后同步读快照、
 *   bootstrap 末尾 thinking_snapshot 帧、tail 事件 replay 标记）→ task-store 解析 → use-task-watch 透传
 *   → chat-view（applyThinkingSnapshot 合并、回放事件不清实时态）→ use-smooth-thinking（从下限起步 / 回前台跳到最新）。
 * 同样是漏一环就静默失效（切回对话照旧从第一个字重新长），行为测试：
 *   tests/thinking-live-snapshot.test.ts        服务端快照存储（只含已发出的 / 截尾 / 段结束 / 失主 / 旁路不碰主链）
 *   tests/watch-task-thinking-snapshot.test.ts  真实路由：帧序 / replay / 订阅与快照不重不漏（挂起 bootstrap 的 race）/ 端到端
 *   tests/thinking-snapshot-dispatch.test.ts    客户端分发（无效帧丢弃 / replay 只认严格 true）
 *   tests/thinking-snapshot.test.ts             前端纯函数（合并规则 / 下限 / 回前台跳到最新）+ 重挂 / 重连 / 回前台模拟
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

/** 去掉注释后的源码：断言「某两处之间没有 await」时不被解释它为什么不能有的注释干扰 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

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

  it("chat-view：订阅帧；事件流吃的是「平滑后」的值（直接传 thinkingLive = 回到 250ms 一批的整块跳变）", () => {
    expect(chatView).toContain("onThinkingDelta: pushThinkingDelta");
    expect(chatView).toContain(
      "const smoothThinking = useSmoothThinking(thinkingLive);",
    );
    expect(chatView).toContain("liveThinking={smoothThinking}");
    expect(chatView).not.toContain("liveThinking={thinkingLive}");
  });
});

describe("服务端发送口径：只给属主主链、思考段结束必须丢尾巴、落盘复用预定的 id", () => {
  it("思考分支：旁路答疑（origin）/ 已提问消音（askSeen）不发实时帧、也不预定 id；预定在入队之前", () => {
    const thinkingBranch = sliceBalanced(handler, 'case "thinking": {', "{");
    expect(thinkingBranch).toMatch(
      /if \(!origin && !assistantCtx\.askSeen\) \{[\s\S]*?assistantCtx\.thinkingEventId \?\?= newEventId\(\);[\s\S]*?enqueueThinkingDelta\(\s*taskId,\s*stillCurrent,\s*chunk,\s*assistantCtx\.thinkingEventId,?\s*\);/,
    );
  });

  it("入口：属主主链上任何非 thinking 消息到来都丢掉没发的尾巴（否则实时帧可能晚于落盘事件到达、复活「思考中」）；旁路答疑（origin）的消息不算——节流状态 / 快照按 taskId 共享、属于主链，旁路一说话就清会误伤主链正在进行的思考", () => {
    expect(handler).toContain(
      'if (msg.type !== "thinking" && !origin) discardPendingThinkingDeltas(taskId);',
    );
    // 旧写法（旁路也清）不能回来
    expect(handler).not.toContain(
      'if (msg.type !== "thinking") discardPendingThinkingDeltas(taskId);',
    );
  });

  it("flushThinkingBuffer：开头就丢尾巴，且在 `!text` 早退之前（run 结束路径也要清定时器）；旁路（origin）收尾不丢——它从不发实时帧，清了只会误伤主链", () => {
    const bodyStart = handler.indexOf("export const flushThinkingBuffer = async (");
    expect(bodyStart, "找不到 flushThinkingBuffer").toBeGreaterThanOrEqual(0);
    // 函数很短，截一段足够覆盖到早退那一行
    const body = handler.slice(bodyStart, bodyStart + 1800);
    const discardAt = body.indexOf("if (!origin) discardPendingThinkingDeltas(taskId);");
    const earlyReturnAt = body.indexOf("if (!text) return;");
    expect(discardAt).toBeGreaterThanOrEqual(0);
    expect(earlyReturnAt).toBeGreaterThan(discardAt);
    // 不带 origin 门的无条件 discard 不能回来
    expect(body).not.toMatch(/(^|\n)\s*discardPendingThinkingDeltas\(taskId\);/);
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
    const onEvent = sliceBalanced(chatView, "onEvent: (ev, meta) => {", "{");
    // V4-04 起 ephemeral 帧的吸收收进 useLiveToolOutputs（chat / task 页共用）：
    // absorbLiveToolOutputEvent 对 ephemeral 帧返回 true = 早退，语义同旧的 isEphemeralToolOutputDelta 早退
    const ephemeralAt = onEvent.indexOf("if (absorbLiveToolOutputEvent(ev)) return;");
    const clearAt = onEvent.indexOf("clearThinkingLive();");
    expect(ephemeralAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(ephemeralAt);
  });

  it("onEvent：只有「刚发生」的落盘事件才清实时态——bootstrap 回放的历史尾部（meta.replay）不清（每次重连都会把尾部历史重读一遍，当成「这段思考结束了」就把同页重连时本地正在长的思考清零、从第一个字重新吐）", () => {
    const onEvent = sliceBalanced(chatView, "onEvent: (ev, meta) => {", "{");
    expect(onEvent).toContain("if (!meta?.replay) clearThinkingLive();");
    // 回调里只此一处清思考：再多一处无条件的 = 回放事件也清了
    expect(onEvent.match(/clearThinkingLive\(\);/g)).toHaveLength(1);
  });

  it("onEvent：清实时态与追加落盘事件在同一个同步回调里、且清在前（同批渲染 → 合成行直接换成同 id 的落盘行，没有空档）", () => {
    const onEvent = sliceBalanced(chatView, "onEvent: (ev, meta) => {", "{");
    const clearAt = onEvent.indexOf("clearThinkingLive();");
    const appendAt = onEvent.indexOf("onEventAppendRef.current(ev, meta);");
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
    // 依赖数组随别的清理项 / 回调（clearLiveToolOutputs、onLedgerLive…）增减，不钉整串，只认「含 task.id + applyLedgerToUi + clearThinkingLive」那个
    const depsMatch = /\[\s*task\.id,\s*applyLedgerToUi,[^\]]*\bclearThinkingLive\b[^\]]*\]/.exec(chatView);
    expect(depsMatch).not.toBeNull();
    const depsAt = depsMatch!.index;
    expect(depsAt).toBeGreaterThanOrEqual(0);
    const effectStart = chatView.lastIndexOf("useEffect(", depsAt);
    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(chatView.slice(effectStart, depsAt)).toContain("clearThinkingLive();");
  });
});

describe("chat-view 状态：段 id + 累积原文 + 累计字数 + 起点时刻", () => {
  it("state 是 LiveThinking；累积走 advanceLiveThinking（同段拼接 / 换段重置 / 累计字数 / 起点——规则在纯函数里逐条单测）", () => {
    expect(chatView).toContain("useState<LiveThinking | null>(null)");
    expect(chatView).toContain(
      "const pushThinkingDelta = useCallback((text: string, id: string) => {",
    );
    expect(chatView).toContain(
      "advanceLiveThinking(thinkingRef.current, id, text, Date.now())",
    );
    // 旧的就地累积不能回来：它只拼 text、不记累计字数 total，吐字平滑用的坐标就乱了
    expect(chatView).not.toContain("appendThinkingText(");
    expect(chatView).not.toContain("sameSegment");
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

  it("工作过程组折叠时：组头不摘思考原文（原文在展开区、状态行已说「思考中」），但仍显式占住进行中思考的分支、优先于「最近在跑的工具名」", () => {
    const body = sliceBalanced(workGroup, "if (!expanded) {", "{");
    expect(body).toContain("isLiveThinkingEvent(tailMember)");
    const liveBranch = body.slice(
      body.indexOf("isLiveThinkingEvent(tailMember)"),
      body.indexOf("group.hasRunning"),
    );
    // 显式置空：别落到下面「最近 running 工具名」上去说一个早已结束的工具
    expect(liveBranch).toContain("runningTail = null;");
    // 不再摘原文：旧实现在这里用 thinkingTextToLine 取最近一行、拼成「思考中 · …」
    expect(workGroup).not.toContain("thinkingTextToLine");
    expect(workGroup).not.toContain("THINKING_LIVE_LABEL");
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

  it("已有的思考行：进行中展开成实时文本区（LiveThinkingTail），落盘后才是全文——不再是折叠行里逐字左滑的摘要", () => {
    const procStart = rows.indexOf("const ProcessEventRow = ({");
    const procEnd = rows.indexOf("// V0.13.x「重连中」过程行");
    expect(procStart, "找不到 ProcessEventRow").toBeGreaterThanOrEqual(0);
    expect(procEnd).toBeGreaterThan(procStart);
    const proc = rows.slice(procStart, procEnd);
    const liveAt = proc.indexOf(") : isLive ? (");
    const tailAt = proc.indexOf("<LiveThinkingTail text={ev.text} />");
    const fullAt = proc.indexOf("<SearchHighlightText");
    expect(liveAt).toBeGreaterThanOrEqual(0);
    expect(tailAt).toBeGreaterThan(liveAt);
    // 全文渲染在实时区分支之后：进行中的行不走全文（全文随吐字变高，会把后面的行一路顶下去）
    expect(fullAt).toBeGreaterThan(tailAt);
    expect(rows).toContain(
      'import { LiveThinkingTail } from "./live-thinking-tail";',
    );
  });

  it("已有的思考行：进行中的思考没有折叠摘要（旧实现取「最新一行」，每个新字让整行左滑一格）；也没有「仅显示最近」提示（实时区本来就只展示尾部）", () => {
    expect(rows).toMatch(/const summary = isLiveRow\s*\?\s*""\s*:/);
    expect(rows).not.toContain("thinkingTextToLine");
    expect(rows).not.toContain("liveTruncated");
    expect(rows).not.toContain("THINKING_TEXT_MAX");
  });

  it("折叠态走纯函数（手动优先 / 首次渲染锁定默认值）：进行中自动展开、落盘回默认折叠、用户手动选择不被刷掉", () => {
    expect(rows).toContain(
      "const [initialCollapsed] = useState(defaultCollapsed);",
    );
    // V2-05：手动选择改走 useRowViewState（模块级存档），行被虚拟列表卸载再滚回来不回到默认折叠；
    // 语义仍是「null = 没手动动过 → 跟自动态」，所以下面的 collapsed / toggle / 搜索命中断言不变
    expect(rows).toMatch(
      /const \[manualCollapsed, setManualCollapsed\] = useRowViewState<boolean \| null>\(\s*eventRowViewKey\(taskId, ev\.id, ROW_VIEW_FIELD\.eventManualCollapsed\),\s*null,\s*\);/,
    );
    expect(rows).toContain(
      "const autoCollapsed = autoEventCollapsed(isLiveRow, initialCollapsed);",
    );
    expect(rows).toContain("const collapsed = manualCollapsed ?? autoCollapsed;");
    expect(rows).toContain(
      "setManualCollapsed((m) => toggleEventCollapsed(m, autoCollapsed))",
    );
    // 搜索命中要强制展开：写进手动态（之后用户再点才收起）
    expect(rows).toContain("if (hasSearchHit) setManualCollapsed(false);");
    // 旧写法：collapsed 是个被首次渲染锁死的 state，进行中的思考永远是折叠的
    expect(rows).not.toContain(
      "const [collapsed, setCollapsed] = useState(defaultCollapsed);",
    );
    expect(rows).not.toContain("setCollapsed(");
  });

  it("默认折叠：思考不在 DEFAULT_EXPANDED_KINDS 里——落盘后的思考行默认收起、点开才看全文（进行中的由 autoEventCollapsed 自动展开）", () => {
    const m = eventUtils.match(
      /DEFAULT_EXPANDED_KINDS: ReadonlySet<EventKind> = new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m, "找不到 DEFAULT_EXPANDED_KINDS").not.toBeNull();
    expect(m![1]).not.toContain('"thinking"');
  });

  it("状态行：deriveActiveStatus 只吃计时起点、不吃原文（原文在组内思考行里，上下各摆一遍就是重复），起点在 memo 依赖里", () => {
    // 取原始值（number）而不是整个 liveThinking 对象：起点整段思考内不变，状态行不跟着每帧重算
    expect(eventStream).toContain(
      "const thinkingSince = liveThinking ? liveThinking.since : null;",
    );
    const activeStatus = sliceBalanced(
      eventStream,
      "const activeStatus = useMemo",
      "(",
    );
    expect(activeStatus).toMatch(
      /streaming: isStreamingText,[\s\S]*?\bthinkingSince,\s*\}\);/,
    );
    // 漏了依赖：换了一段新的思考，状态行的计时不重置
    expect(activeStatus).toMatch(
      /isStreamingText,\s*thinkingSince,\s*tailHasProgressRow,\s*\]/,
    );
    // 旧实现：从原文派生「最近一行」传进状态行
    expect(eventStream).not.toContain("thinkingTextToLine");
    expect(activeStatus).not.toContain("thinkingLine");
    // 不挂整个对象（逐帧变）、不挂 streamingText 本身（逐帧变）：状态行不该逐帧换新对象
    expect(activeStatus).not.toMatch(/\bliveThinking\b/);
    expect(activeStatus).not.toMatch(/\bstreamingText\b/);
    // 既有契约不能破：状态行仍吃本轮切片、不挂全量 task.events
    expect(activeStatus).toContain("statusEvents");
    expect(activeStatus).not.toContain("task.events");
  });

  it("「正在启动…」让位：流尾已有进度行时状态行不并存；判定只取 items 尾项的布尔（items 逐帧变，状态行不跟着重算）", () => {
    const tail = sliceBalanced(
      eventStream,
      "const tailHasProgressRow = useMemo",
      "(",
    );
    expect(tail).toContain("isLoadingItem(last) || isBootStageItem(last)");
    expect(tail).toMatch(/\[items\]/);
    const activeStatus = sliceBalanced(
      eventStream,
      "const activeStatus = useMemo",
      "(",
    );
    expect(activeStatus).toContain(
      "if (status?.yieldToTail && tailHasProgressRow) return null;",
    );
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

    // 只带起算时间（切走再切回后接着数），不带思考
    expect(eventStream).toContain("<PendingRow since={item.since} />");
    expect(eventStream).not.toContain("<PendingRow thinking");
    expect(eventStream).not.toContain("thinkingLine={");
    expect(workGroup).not.toContain("thinkingLine");
    expect(workGroup).toContain("const ProcessingPlaceholderRow = () => (");
  });
});

describe("进行中思考的快照（2026-10-13「切窗口再切回来思考又从第一个字开始吐」）：每一环都在", () => {
  it("服务端：快照只含「已发出」的——publish 成功才累积、且累积在 publish 之后（发帧那一刻才失主的字，订阅者没收到过）", () => {
    const send = sliceBalanced(
      handler,
      "const sendThinkingDelta = (taskId: string, st: ThinkingThrottle): void => {",
      "{",
    );
    const publishAt = send.indexOf("const published = publishIfCurrent(");
    const guardAt = send.indexOf("if (!published) return;");
    const sinceAt = send.indexOf("if (st.sentTotal === 0) st.since = st.lastSentAt;");
    const textAt = send.indexOf("st.sent = appendThinkingText(st.sent, text);");
    const totalAt = send.indexOf("st.sentTotal += text.length;");
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(publishAt);
    // 首帧时刻要在累计数自增之前记（用 sentTotal === 0 判断「第一帧」）
    expect(sinceAt).toBeGreaterThan(guardAt);
    expect(textAt).toBeGreaterThan(sinceAt);
    expect(totalAt).toBeGreaterThan(textAt);
  });

  it("服务端：getLiveThinkingSnapshot——没发过任何一帧 → null；读取时重估 lease，失主就清掉（别把已死的思考当进行中告诉新订阅者）", () => {
    const start = handler.indexOf("export const getLiveThinkingSnapshot = (");
    expect(start, "找不到 getLiveThinkingSnapshot").toBeGreaterThanOrEqual(0);
    const body = handler.slice(start, start + 900);
    expect(body).toContain("if (!st || st.sentTotal === 0) return null;");
    const leaseAt = body.indexOf("if (!st.lease()) {");
    const discardAt = body.indexOf("discardPendingThinkingDeltas(taskId);");
    expect(leaseAt).toBeGreaterThanOrEqual(0);
    expect(discardAt).toBeGreaterThan(leaseAt);
    // 快照字段口径：eventId / 已发出文本窗口 / 累计数 / 首帧时刻
    // 快照不经 publish、直接由 watch-task send，所以文本这里必须再脱敏一道
    // （行为见 tests/event-secret-redact.test.ts「凭据被切在相邻两帧」；这里只钉「没有裸 st.sent 出去」）
    expect(body).toContain("eventId: st.eventId,");
    expect(body).toContain("text: redactSecretsInText(st.sent),");
    expect(body).not.toContain("text: st.sent,");
    expect(body).toContain("total: st.sentTotal,");
    expect(body).toContain("since: st.since,");
  });

  it("路由：订阅与读快照同步配对——getLiveThinkingSnapshot 紧跟 subscribeTaskStream、在第一个 await 之前（隔了 await = 期间的帧既进快照又进 buffer，前端文本被重复一遍）", () => {
    const subAt = watchRoute.indexOf("subscribeTaskStream(id,");
    const snapAt = watchRoute.indexOf("const thinkingSnap = getLiveThinkingSnapshot(id);");
    const awaitAt = watchRoute.indexOf("await getTaskWithTailEvents(");
    expect(subAt).toBeGreaterThanOrEqual(0);
    expect(snapAt).toBeGreaterThan(subAt);
    expect(awaitAt).toBeGreaterThan(snapAt);
    // 订阅与读快照之间不能有 await（去掉注释再判：注释里解释「为什么不能有」会含 await 字样）
    expect(stripComments(watchRoute.slice(subAt, snapAt))).not.toContain("await");
  });

  it("路由：bootstrap 回放的 tail 事件带 replay:true；实时分发的 event 帧不带（前端据此区分「重读旧账」与「刚发生」）", () => {
    expect(watchRoute).toContain('send({ type: "event", event: ev, replay: true });');
    expect(watchRoute).toContain('send({ type: "event", event: ev.event });');
  });

  it("路由：快照帧无条件发（对象或 null）——在 restricted_run 之后、buffer 回放之前；tail 里已有这段思考的落盘事件则发 null（别复活幽灵「思考中」）", () => {
    const restrictedAt = watchRoute.indexOf("active: hasRestrictedQuestionInFlight(id),");
    const sendAt = watchRoute.indexOf('send({ type: "thinking_snapshot", live: liveSnap });');
    const replayAt = watchRoute.indexOf("bootstrapping = false;");
    expect(restrictedAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThan(restrictedAt);
    expect(replayAt).toBeGreaterThan(sendAt);
    expect(watchRoute).toContain("!tailEvents.some((e) => e.id === thinkingSnap.eventId)");
    // 快照帧不能被条件包住：没在思考也要发 live:null，前端才知道清残留
    expect(watchRoute.slice(watchRoute.lastIndexOf("const liveSnap"), sendAt)).not.toMatch(
      /if \(thinkingSnap\)/,
    );
  });

  it("客户端解析：task-store 认 thinking_snapshot、无效帧丢弃不回调；event 帧只有 replay 严格为 true 才带 meta", () => {
    expect(taskStore).toContain('| "thinking_snapshot"');
    expect(taskStore).toContain('env.type === "thinking_snapshot"');
    expect(taskStore).toContain("if (snap !== undefined) callbacks.onThinkingSnapshot?.(snap);");
    expect(taskStore).toContain("if (env.replay === true) {");
    expect(taskStore).toContain("callbacks.onEvent?.(env.event, { replay: true });");
    expect(taskStore).toContain(
      "onThinkingSnapshot?: (snapshot: ThinkingSnapshot | null) => void;",
    );
    expect(taskStore).toContain("onEvent?: (ev: TaskEvent, meta?: TaskEventMeta) => void;");
  });

  it("hook 透传：onThinkingSnapshot 与 onEvent 的 meta 都接到 callbacksRef（漏了 = 回调静默收不到）", () => {
    expect(useTaskWatch).toContain("callbacksRef.current.onThinkingSnapshot?.(snapshot)");
    expect(useTaskWatch).toContain("callbacksRef.current.onEvent?.(ev, meta)");
    expect(useTaskWatch).toContain(
      "onThinkingSnapshot?: (snapshot: ThinkingSnapshot | null) => void;",
    );
    expect(useTaskWatch).toContain("onEvent?: (ev: TaskEvent, meta?: TaskEventMeta) => void;");
  });

  it("chat-view：订阅快照；合并走 applyThinkingSnapshot、没变化（同一引用）不 setState", () => {
    expect(chatView).toContain("onThinkingSnapshot: applySnapshot");
    const apply = sliceBalanced(
      chatView,
      "const applySnapshot = useCallback((snap: ThinkingSnapshot | null) => {",
      "{",
    );
    expect(apply).toContain("applyThinkingSnapshot(thinkingRef.current, snap, Date.now())");
    const sameAt = apply.indexOf("if (next === thinkingRef.current) return;");
    const setAt = apply.indexOf("setThinkingLive(next);");
    expect(sameAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeGreaterThan(sameAt);
    // ref 与 state 同步更新（ref 让后面的 clear / push 读到最新）
    expect(apply).toContain("thinkingRef.current = next;");
  });
});
