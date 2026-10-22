/**
 * chat 输入框「回车后立刻按运行态画 + 受理前点停止延后到提交落地」的接线契约（2026-10-12）
 *
 * 背景：v1.9.29 把「发送中…」并入准备阶段——气泡变成正式消息、列表末尾是「准备环境…」，
 * 但输入框仍绑在 HTTP 请求上：回车后到服务端受理前（热路径 1.3–2.7s、冷路径 4.5–6.7s，
 * 取自 chat-reply-timings.log）只有一个转圈的发送键、没有停止键，界面前后矛盾、用户也停不了。
 *
 * 修法有两半，**必须一起在**：
 *   1. 输入框在提交飞行期间也按运行态画（停止键）——event-stream.tsx 的 composerRunning
 *   2. 受理前点停止不能直接停——服务端热路径在「发送前快照」期间没有占位，此刻 stop 会关掉会话，
 *      随后 sendChatMessage 返回 no_session、落到「起新会话」并重新领 lease，AI 在「已停止」之后被
 *      重新拉起。所以只登记意图、等提交落地再停——chat-view.tsx 的 handleStop / handleUserReply
 * 只做 1 不做 2 = 把一个「停不住」的 bug 暴露给用户（比原来「晚点出现停止键」更糟）。
 *
 * UI 行为在 node 环境跑不起来（见 vitest.config.ts），跟 thinking-delta-wiring-contract.test.ts
 * 一样靠源码契约守住；决策本身的行为测试在 tests/chat-pending-display.test.ts。
 * 契约只能防「被删 / 被改回去」，证明不了渲染正确——要肉眼看。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");

const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const chatView = read("components", "tasks", "chat-view.tsx");
const eventStream = read("components", "tasks", "event-stream.tsx");
const composer = read("components", "conversation-composer.tsx");

/** 从 `marker` 处起按圆括号配对截出完整片段（marker 必须以 `(` 结尾） */
const sliceCall = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = start + marker.length - 1;
  expect(source[from], `marker 必须以 "(" 结尾：${marker}`).toBe("(");
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`括号没配平：${marker}`);
};

describe("EventStream：输入框运行态", () => {
  it("composerRunning 走 shouldShowComposerRunning，且把 submitting / awaitingAsk 都传进去", () => {
    const call = sliceCall(eventStream, "shouldShowComposerRunning(");
    expect(call).toMatch(/isRunning,/);
    expect(call).toMatch(/submitting: !!submitting,/);
    expect(call).toMatch(/awaitingAsk,/);
    expect(eventStream).toMatch(/const composerRunning = shouldShowComposerRunning\(/);
    // 后台子代理不再算运行态（R3-02）：它走单独的 stopOnly（tests/composer-submit-state.test.ts）
    expect(call).not.toMatch(/backgroundSubagentCount/);
  });

  it("不能退回老写法：只看 isRunning 会让提交飞行期间只剩转圈的发送键", () => {
    expect(eventStream).not.toMatch(/const composerRunning = isRunning && !awaitingAsk/);
  });

  it("composerRunning 仍然是传给输入框的 running（停止键 / 失活态降对比都由它决定）", () => {
    expect(eventStream).toMatch(/running=\{composerRunning\}/);
    // 失活态的写法从「整岛 opacity-70」改成只降边框 / 底色 / 阴影（V13-12：整岛压透明会把文字压到 AA 以下）；
    // 三个条件和 && 的结构不变，只是现在分行、并且尾巴是实色 token 而不是 opacity
    expect(eventStream).toMatch(
      /!isAwaitingUser\s*&&\s*!composerRunning\s*&&\s*!awaitingAsk\s*&&\s*"border-border\/60 bg-muted\/30 shadow-none"/,
    );
    expect(eventStream).not.toMatch(/!awaitingAsk\s*&&\s*"opacity-70"/);
  });

  it("判定函数从 lib/chat-pending-display 引入", () => {
    expect(eventStream).toMatch(
      /import \{[^}]*shouldShowComposerRunning[^}]*\} from "@\/lib\/chat-pending-display"/,
    );
  });
});

// 第三轮 review D7-03 / R3-02：右侧动作组的决策抽到 lib/composer-actions（行为见 tests/composer-submit-state.test.ts），
// 这里只钉组件接线。旧写法是 JSX 里 `submitting && label === "发送"` 才转圈、`running ? (...) : sendButton("发送")` 整组切换。
describe("ConversationComposer：右侧动作组走 deriveComposerActions（运行态里只留一个圈）", () => {
  const sendButtonSrc = (() => {
    const start = composer.indexOf("const sendButton");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = composer.indexOf("const stopButton", start);
    expect(end).toBeGreaterThan(start);
    return composer.slice(start, end);
  })();

  it("发送键转圈由 actions.send.spinning 决定（常态 / 排队发送共用；左侧「AI 在跑」的圈在提交飞行时让出）", () => {
    expect(sendButtonSrc).toMatch(/send\.spinning \?/);
    expect(composer).toMatch(/actions\.runSpinner &&/);
  });

  it("发送键在提交飞行期间仍然是禁用的（防连点不能丢）", () => {
    // Q6-03：判据抽成 composerSubmitBlock（穷举等价于旧的 disabled || submitting || !hasContent，见 tests/submit-latch.test.ts）
    expect(sendButtonSrc).toMatch(
      /disabled=\{composerSubmitBlock\(\{ disabled, submitting, hasContent \}\) !== null\}/,
    );
  });

  it("运行态仍是 spinner + 停止键 + 排队发送（allowQueueWhileRunning 传给决策函数）", () => {
    expect(composer).toMatch(/actions\.stopButton && stopButton/);
    expect(composer).toMatch(/actions\.send && sendButton\(actions\.send\)/);
    expect(composer).toMatch(/allowQueueWhileRunning: !!allowQueueWhileRunning/);
    // 停止键不受 disabled 管（受理前点停止走「登记意图」，不能被编辑器禁用挡住）
    expect(composer).toMatch(/disabled=\{stopping\}/);
  });

  it("附件按钮是否让位走 actions.showAttach（stopOnly 不让位）", () => {
    expect(composer).toMatch(/showAttachActions=\{actions\.showAttach\}/);
  });
});

describe("ChatView：受理前点停止 → 登记意图，提交落地再兑现", () => {
  const handleStop = sliceCall(chatView, "const handleStop = useCallback(");
  const handleUserReply = sliceCall(chatView, "const handleUserReply = useCallback(");
  const submitUserReply = sliceCall(chatView, "const submitUserReply = useCallback(");

  it("handleStop 用 decideChatStop 判，读的是 ref（提交锁 + run latch），不是可能过期的 state", () => {
    expect(handleStop).toMatch(/decideChatStop\(\{/);
    expect(handleStop).toMatch(/submitting: submitTokenRef\.current !== null/);
    expect(handleStop).toMatch(/runActive: runActiveRef\.current/);
  });

  it("after_submit 分支只登记意图 + 停止键立刻转圈，并且在调 stopAgentCore 之前 return", () => {
    const branchStart = handleStop.indexOf('mode === "after_submit"');
    expect(branchStart).toBeGreaterThanOrEqual(0);
    const earlyReturn = handleStop.indexOf("return;", branchStart);
    expect(earlyReturn).toBeGreaterThan(branchStart);
    const branch = handleStop.slice(branchStart, earlyReturn);
    expect(branch).toMatch(/stopAfterSubmitRef\.current = true;/);
    expect(branch).toMatch(/setStopping\(true\);/);
    // 这一支里绝不能直接停——受理前直接停就是那个「AI 被重新拉起」的竞态
    expect(branch).not.toMatch(/stopAgentCore|stopTask/);
    // 真正的停止在 return 之后（now 分支）
    const nowStop = handleStop.indexOf("await stopAgentCore()", earlyReturn);
    expect(nowStop).toBeGreaterThan(earlyReturn);
  });

  it("对外的 handleUserReply 先 await 提交本体，再按 settleStopIntent 兑现", () => {
    const submitAt = handleUserReply.indexOf("await submitUserReply(");
    const settleAt = handleUserReply.indexOf("settleStopIntent({");
    expect(submitAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThan(submitAt);
    expect(handleUserReply).toMatch(/pending: stopAfterSubmitRef\.current,/);
    expect(handleUserReply).toMatch(/alive: canCommitTaskSnapshot\(task\.id\)/);
    expect(handleUserReply).toMatch(/return accepted;/);
  });

  it("兑现分支：stop 才真停；其余（release）只收掉「停止中」外观，且意图一次性消费", () => {
    expect(handleUserReply).toMatch(/stopAfterSubmitRef\.current = false;/);
    expect(handleUserReply).toMatch(/if \(settlement === "stop"\) await stopAgentCore\(\);/);
    expect(handleUserReply).toMatch(/else setStopping\(false\);/);
  });

  it("依赖数组：新包装要带上 stopAgentCore（否则兑现时拿到过期的 stop 闭包）", () => {
    expect(handleUserReply).toMatch(/\[submitUserReply, stopAgentCore, task\.id\]/);
  });

  it("提交本体里不能自己停：兑现只能在 handleUserReply 一处，避免双重 stop", () => {
    expect(submitUserReply).not.toMatch(/stopAgentCore|stopTask\(/);
    expect(submitUserReply).not.toMatch(/stopAfterSubmitRef/);
  });

  it("输入框 / 事件流行内重试都走包装后的 handleUserReply，不绕过兑现", () => {
    expect(chatView).toMatch(/onUserReply=\{handleUserReply\}/);
    expect(chatView).not.toMatch(/onUserReply=\{submitUserReply\}/);
    expect(chatView).toMatch(/onStop=\{handleStop\}/);
    const streamActions = sliceCall(chatView, "const streamActions = useMemo(");
    expect(streamActions).toMatch(/await handleUserReply\(/);
    expect(streamActions).not.toMatch(/submitUserReply/);
  });

  it("切任务时清掉登记的意图：否则新任务的第一条消息一落地就被停掉", () => {
    const from = chatView.indexOf("// 切 task：清 streaming 等 UI 态");
    // 订阅的是 onLedgerLive（第三轮 R6-01：实时 dispatch 里顺带判排队条的「从无到有」）
    const to = chatView.indexOf("return subscribeChatOp(task.id, onLedgerLive);");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const effect = chatView.slice(from, to);
    expect(effect).toMatch(/stopAfterSubmitRef\.current = false;/);
    // 与提交锁 / stopping 一起清（同一个 effect 里）
    expect(effect).toMatch(/submitTokenRef\.current = null;/);
    expect(effect).toMatch(/setStopping\(false\);/);
  });

  it("三个判定函数从 lib/chat-pending-display 引入", () => {
    expect(chatView).toMatch(
      /import \{[^}]*decideChatStop[^}]*\} from "@\/lib\/chat-pending-display"/,
    );
    expect(chatView).toMatch(
      /import \{[^}]*settleStopIntent[^}]*\} from "@\/lib\/chat-pending-display"/,
    );
  });
});
