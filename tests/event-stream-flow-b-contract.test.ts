/**
 * 事件流「流 B」第二轮 review 的接线契约（2026-10-20）：V17-02 / V13-04 / V16-03
 *
 * UI 行为在 node 环境跑不起来（见 vitest.config.ts），靠源码契约防「被删 / 被改回去」；
 * 能抽成纯函数的部分（排序 / 状态文案 / 运行态判定）都另有行为测试：
 *   - V1-01 / V2-01：tests/stream-pending.test.ts
 *   - V16-01 / V16-02：tests/chat-turns.test.ts
 *   - V16-03 判定函数：tests/chat-pending-display.test.ts
 * 契约只能防回退，证明不了渲染正确——窄栏观感要肉眼看。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const eventStream = read("components", "tasks", "event-stream.tsx");
const composer = read("components", "conversation-composer.tsx");

/** 从 `marker` 起按圆括号配对截出完整片段（取 marker 之后第一个 `(` 起算） */
const sliceCall = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = source.indexOf("(", start);
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

describe("V17-02：群问答 tab 往返后事件流一律落在最后一条", () => {
  // 群问答 tab 把 Virtuoso 整个卸载（showQaPanel ? <GroupQaPanel/> : <Virtuoso/>），切回来是重新挂载：
  // initialTopMostItemIndex 只在 mount 时读一次，读的是 initialTopRef。旧写法 initialTopRef 只在 null 时写一次、
  // 只有切 task 才复位，切回来就用首次加载时的陈旧下标重挂（2026-10-17 用户拍板「进入一律落在最后一条」）
  const qaEffect = sliceCall(
    eventStream,
    "useEffect(() => {\n    lastRangeStartRef.current = null;",
  );

  it("[showQaPanel] effect 里进入群问答 tab 时把 initialTopRef 复位成 null（切回来由渲染期 latch 重新落在最后一条）", () => {
    expect(qaEffect).toMatch(/if \(showQaPanel\) initialTopRef\.current = null;/);
    expect(eventStream).toContain("}, [showQaPanel]);");
  });

  it("只在「进入」时复位：离开群问答（showQaPanel 回到 false）不复位，免得渲染期 latch 之后又被无谓重置", () => {
    // 无条件 `initialTopRef.current = null` 会在回到事件流后的那次 effect 里再清一次，
    // 下一次渲染的 latch 会把用户刚上滚的跟随态强行拉回「跟随」
    expect(qaEffect).not.toMatch(/^\s*initialTopRef\.current = null;/m);
  });

  it("渲染期 latch 还在：initialTopRef 为 null 且有条目时落在最后一条并恢复跟随（切回事件流那次渲染靠它）", () => {
    expect(eventStream).toMatch(
      /if \(initialTopRef\.current === null && items\.length > 0\) \{\s*follow\.setFollowing\(true\);\s*initialTopRef\.current = items\.length - 1;/,
    );
    expect(eventStream).toMatch(
      /initialTopMostItemIndex=\{initialTopRef\.current \?\? items\.length - 1\}/,
    );
  });
});

describe("V13-04：窄栏下 Cmd+F 搜索框不被 leading 挤成几个字宽", () => {
  // log 形态标题栏：leading（「事件流 / 群问答（N）」tab）是 flex-1，搜索激活后又有 flex-1 的 Input，
  // 两者平分剩余宽度——307px 的事件流栏里 Input 只剩约 71px（有群问答 tab 时约 25px）。
  // 搜索一激活就切回事件流（activateStreamSearch 里 setShowGroupQa(false)），tab 此刻没有用处 → 让位。
  const logBar = (() => {
    const start = eventStream.indexOf("{!isChat && (\n        <EventStreamSearchBar");
    expect(start).toBeGreaterThanOrEqual(0);
    return eventStream.slice(start, eventStream.indexOf("{!isChat && renderSearchScopeNotice", start));
  })();

  it("log 标题栏的 leading 在搜索激活态不渲染", () => {
    expect(logBar).toMatch(/leading=\{\s*searchActive\s*\?\s*null\s*:/);
  });

  it("搜索激活时仍保留 tab 的数据来源：不删群问答 tab 本身（非激活态照旧渲染）", () => {
    expect(logBar).toContain("事件流");
    // 计数 / 是否出 tab 走 deriveGroupQaScope（窗口被截断时带「+」、0 轮但绑了群也出 tab；D8-01，行为见 tests/group-qa-scope.test.ts）
    expect(logBar).toContain("groupQaScope.showTab");
    expect(logBar).toContain("群问答{groupQaScope.countText");
  });

  it("与产物面板共用的 EventStreamSearchBar 组件本身不动：让位逻辑只在 event-stream 的调用处", () => {
    const bar = read("components", "tasks", "event-stream-search-bar.tsx");
    expect(bar).toMatch(/\{leading\}/);
    expect(bar).not.toMatch(/searchActive/);
  });
});

describe("V16-03：主 AI 空闲但后台子代理还在跑时，输入框要有可达的停止键", () => {
  // 第三轮 R3-02：后台子代理不再并进 composerRunning（那会带出整套运行态：转圈 / 「排队发送」/ 附件消失），
  // 改走单独的 composerStopOnly → ConversationComposer 的 stopOnly（只多一个停止键）；决策的行为测试见
  // tests/chat-pending-display.test.ts（shouldShowComposerStopOnly）与 tests/composer-submit-state.test.ts
  it("composerStopOnly 把后台子代理数传给 shouldShowComposerStopOnly，composerRunning 不再带它", () => {
    const stopOnlyCall = sliceCall(eventStream, "const composerStopOnly = shouldShowComposerStopOnly(");
    expect(stopOnlyCall).toMatch(/backgroundSubagentCount: backgroundSubagents\?\.length \?\? 0,/);
    expect(stopOnlyCall).toMatch(/isRunning,/);
    expect(stopOnlyCall).toMatch(/submitting: !!submitting,/);
    expect(stopOnlyCall).toMatch(/awaitingAsk,/);
    const runningCall = sliceCall(eventStream, "const composerRunning = shouldShowComposerRunning(");
    expect(runningCall).not.toMatch(/backgroundSubagentCount/);
    // 原有三项不能丢
    expect(runningCall).toMatch(/isRunning,/);
    expect(runningCall).toMatch(/submitting: !!submitting,/);
    expect(runningCall).toMatch(/awaitingAsk,/);
  });

  it("停止键 tooltip 写「停止（含 N 个后台子代理）」：按钮如实说明会连带取消（停止 = 整会话 cancelAll）", () => {
    expect(eventStream).toMatch(/stopLabel=\{/);
    expect(eventStream).toContain("停止（含 ${backgroundSubagents.length} 个后台子代理）");
  });

  it("ConversationComposer 接受可选 stopLabel、默认仍是「停止生成（中断 agent）」", () => {
    expect(composer).toMatch(/stopLabel\?: string;/);
    expect(composer).toMatch(/<Tooltip content=\{stopLabel \?\? "停止生成（中断 agent）"\}>/);
  });
});
